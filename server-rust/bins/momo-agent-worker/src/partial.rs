//! The turn pump — provider slices → **the growing message** (#1161) and the
//! coalesced `agent.partial` frames beside it (goal SRV-B3e).
//!
//! ## The shape, and why it is two halves
//!
//! [`ChannelDeltaSink`] runs *inside* the provider's SSE loop and does exactly
//! one thing: hand the slice to a channel. [`run_partial_pump`] owns everything
//! else — the window, the transactions, the failure policy. The split is not
//! tidiness; it is what keeps the socket read independent of the database. A
//! sink that wrote rows itself would make a slow `INSERT` into a stalled stream,
//! and a failed one into a question about whether to abandon an answer that is
//! arriving perfectly well.
//!
//! ## What one window now does, and why both writes stayed
//!
//! Since #1161 a window does two things: it grows the durable answer
//! ([`crate::stream::MessageStream`], ADR-0155 결정 5) and it publishes the
//! ephemeral rail hint. They are **not** substitutes, and the arithmetic is why:
//!
//! * the durable slice carries the **whole answer so far** (`body` is absolute),
//!   so its payload bytes over a turn are the sum of the prefixes — quadratic in
//!   the answer's length;
//! * the hint carries only **this window's delta**, capped at
//!   [`MAX_PARTIAL_BYTES`] — linear, and bounded.
//!
//! Retiring the hint would therefore save the cheaper of the two while blinding
//! every rail surface that reads it (macOS `AgentPartialView`, web/mobile
//! `AgentWorkingRail`, `workLog`) — including rails watching a channel the
//! reader is not currently looking at. Retiring the durable half is not on the
//! table: it is the answer. So both ride **one** window, at
//! [`PARTIAL_WINDOW`], and the frame count per turn is exactly what it was
//! before the flip.
//!
//! ## Why coalescing, and why a window rather than a count
//!
//! A frontier model emits a delta every few tokens; a 30-second answer is
//! hundreds of them. One outbox row per delta would put hundreds of rows and
//! hundreds of Centrifugo publishes on a single turn, for a reader who cannot
//! perceive more than a few updates a second anyway.
//!
//! The bound is a **time window** rather than "every N deltas" because it is the
//! only one of the two that is bounded by something the operator can reason
//! about: at [`PARTIAL_WINDOW`] the frame count is at most
//! `turn_duration / window` no matter how fast or slow the provider emits, while
//! a count-based rule makes a chatty model expensive and a terse one invisible.
//!
//! ## Ordering
//!
//! Every frame is emitted with `partition_key = channel_id`, the same key the
//! turn's messages use, so the whole turn — opening, thinking, each slice of the
//! answer, each partial, the closing slice, the terminal frame — is one FIFO.
//! The durable slice commits **before** the hint that accompanies it, for the
//! same reason the opening `streaming` phase rides its own partial's
//! transaction: the rail must never headline text the channel does not have yet.
//!
//! ## Failure policy: the two halves fail differently
//!
//! A hint flush that fails is logged and dropped, never retried and never
//! propagated — its truth expires in milliseconds. A durable slice that fails is
//! logged and **not** dropped: `body` is absolute and the accumulator belongs to
//! [`crate::stream::MessageStream`], so the next window re-states this text along
//! with whatever arrived since, and the closing slice in `commit_turn` re-states
//! it one last time. Neither failure fails the turn: trading an answer for a
//! progress bar was never the deal, and a slice is a preview of a body the
//! commit transaction writes anyway.

use std::time::Duration;

use momo_agent::AgentRunAddress;
use momo_db::{with_tenant_tx, PgPool};
use tokio::sync::mpsc;

use crate::provider::DeltaSink;
use crate::stream::MessageStream;

/// How long slices accumulate before one frame goes out.
///
/// 750ms sits between the two failure modes. Below ~400ms the frames stop being
/// perceptibly different to a reader and start being outbox volume; above ~1s
/// the answer visibly arrives in chunks and the feature reads as lag rather than
/// as streaming. It is also comfortably inside the clients' 90s idle cutoff, so
/// a turn that is streaming can never be swept as idle.
pub const PARTIAL_WINDOW: Duration = Duration::from_millis(750);

/// Hard ceiling on frames per turn, independent of the window.
///
/// The window already bounds the count for any sane turn; this bounds it for the
/// insane one (a provider that streams for an hour, a window misconfigured to
/// zero). Past it the pump stops publishing and the turn still completes — the
/// terminal frame is what the rail actually needs, and it does not come from
/// here.
pub const MAX_PARTIAL_FRAMES: u32 = 600;

/// Largest accumulated slice one frame will carry, in bytes.
///
/// A frame is a hint, not a transcript. If a window's worth of text is larger
/// than this the tail is dropped rather than published, because the client uses
/// it for a one-line headline (`headlineFrom`) and the whole answer is already
/// on its way as a durable message.
pub const MAX_PARTIAL_BYTES: usize = 4_096;

/// The sink the provider writes into. Cloneable, cheap, and never blocks.
#[derive(Clone)]
pub struct ChannelDeltaSink {
    tx: mpsc::UnboundedSender<String>,
}

impl DeltaSink for ChannelDeltaSink {
    fn text_delta(&self, delta: &str) {
        if delta.is_empty() {
            return;
        }
        // A closed channel means the pump is gone (its turn was abandoned).
        // Dropping the slice is right: there is nobody left to publish it, and
        // the provider read must not learn about it.
        let _ = self.tx.send(delta.to_string());
    }
}

/// Build a sink and the receiver its pump drains.
pub fn delta_channel() -> (ChannelDeltaSink, mpsc::UnboundedReceiver<String>) {
    let (tx, rx) = mpsc::unbounded_channel();
    (ChannelDeltaSink { tx }, rx)
}

/// What one turn's pump did, once the provider stopped talking.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PumpReport {
    /// `agent.partial` frames published — what the rail tests assert on.
    pub frames: u32,
    /// Durable slices accepted — what a streaming turn's message grew by.
    pub slices: u32,
}

/// Drain slices; per window, grow the durable answer and publish one coalesced
/// rail frame; flush what is left when the stream ends.
///
/// The stream is **not** closed here. A pump that marked the answer `final`
/// would be claiming the turn ended well before anyone knows: the same slices
/// precede a commit, a tool call, a provider death and a cancel, and only the
/// settle path can tell those apart. `commit_turn` writes the closing slice
/// inside the transaction that ends the run; the stop paths write theirs through
/// [`crate::stream::close_run_stream`] with an ADR-0155 `outcome`.
///
/// The stream is taken by value because the pump is `tokio::spawn`ed alongside
/// the provider read and must own everything it touches for the length of the
/// turn; nothing downstream needs the handle back, since `commit_turn` finds the
/// same message through the `client_msg_id` join rather than through a pointer.
pub async fn run_partial_pump(
    pool: PgPool,
    address: AgentRunAddress,
    mut deltas: mpsc::UnboundedReceiver<String>,
    window: Duration,
    mut stream: MessageStream,
) -> PumpReport {
    // Two buffers, because the two halves of a window carry different things.
    // `hint` is this window's delta under the byte cap; `pending` is every byte
    // since the last durable slice, uncapped — the answer must not lose a
    // sentence to a limit that exists to keep a headline short.
    let mut hint = String::new();
    let mut pending = String::new();
    let mut report = PumpReport::default();
    let mut ticker = tokio::time::interval(window);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // `interval` fires immediately on its first tick; consuming it here is what
    // makes the first frame land one window in rather than instantly with a
    // single token in it.
    ticker.tick().await;

    loop {
        tokio::select! {
            received = deltas.recv() => match received {
                Some(delta) => {
                    pending.push_str(&delta);
                    append(&mut hint, &delta);
                }
                // The sink was dropped: the provider is done, one way or
                // another. Fall out and flush the tail.
                None => break,
            },
            _ = ticker.tick() => {
                grow(&mut stream, &mut pending, &mut report).await;
                flush(&pool, address, &mut hint, &mut report.frames).await;
            }
        }
    }

    // The tail. Without this the last window of an answer — often its whole
    // final sentence — would never be reported, and on every path that does not
    // reach a commit (a tool call, a provider death, a cancel) it would never
    // reach the channel at all: those paths freeze whatever the message already
    // holds.
    grow(&mut stream, &mut pending, &mut report).await;
    flush(&pool, address, &mut hint, &mut report.frames).await;
    report
}

/// One durable slice: hand the window's text to the accumulator and publish the
/// answer so far.
///
/// A failure keeps the text — [`MessageStream::push`] appends before it writes,
/// and `body` is absolute — so the next window re-states it. That is why this
/// logs at `warn` and returns nothing to decide on: there is no lost byte to
/// recover, only a frame a reader did not see.
async fn grow(stream: &mut MessageStream, pending: &mut String, report: &mut PumpReport) {
    if pending.is_empty() {
        return;
    }
    let delta = std::mem::take(pending);
    match stream.push(&delta, false).await {
        // A window of nothing but whitespace opens no message and writes no row
        // — the same rule that keeps an empty bubble out of the channel — so it
        // is not a slice either.
        Ok(()) => report.slices += u32::from(stream.message_id().is_some()),
        Err(error) => tracing::warn!(
            error = %error,
            "streamed slice did not land; the next window re-states it"
        ),
    }
}

/// Append with the byte cap applied — the cap trims the *tail*, so a frame
/// always carries the oldest unreported text rather than a middle slice.
fn append(buffer: &mut String, delta: &str) {
    if buffer.len() >= MAX_PARTIAL_BYTES {
        return;
    }
    let room = MAX_PARTIAL_BYTES - buffer.len();
    if delta.len() <= room {
        buffer.push_str(delta);
        return;
    }
    // Never split a character: a frame carrying half a Korean syllable is
    // invalid UTF-8 on the wire, and momo's channels are mostly Korean.
    let mut cut = room;
    while cut > 0 && !delta.is_char_boundary(cut) {
        cut -= 1;
    }
    buffer.push_str(&delta[..cut]);
}

async fn flush(pool: &PgPool, address: AgentRunAddress, buffer: &mut String, published: &mut u32) {
    if buffer.is_empty() {
        return;
    }
    if *published >= MAX_PARTIAL_FRAMES {
        buffer.clear();
        return;
    }
    let text = std::mem::take(buffer);
    let sequence = *published;
    let now = crate::now_ms();
    let frame =
        momo_agent::agent_partial_payload(address, &text, now, &format!("stream{sequence}"));
    // The first slice is also the moment the phase becomes `streaming`. It rides
    // the SAME transaction as the partial it accompanies, so the rail can never
    // be told text is arriving without the text, or shown text while it still
    // believes the agent is thinking.
    let opening = (sequence == 0).then(|| {
        momo_agent::progress_agent_status_payload(
            address,
            momo_agent::AgentPhase::Streaming,
            now,
            "streaming",
        )
    });
    let workspace_id = address.workspace_id;
    let channel_id = address.channel_id;
    let outcome = with_tenant_tx(pool, workspace_id, move |conn| {
        Box::pin(async move {
            if let Some(opening) = opening {
                momo_outbox::emit_outbox(
                    &mut *conn,
                    workspace_id,
                    momo_outbox::OutboxKind::Broadcast,
                    "publish",
                    &opening,
                    Some(channel_id),
                )
                .await?;
            }
            momo_outbox::emit_outbox(
                &mut *conn,
                workspace_id,
                momo_outbox::OutboxKind::Broadcast,
                "publish",
                &frame,
                Some(channel_id),
            )
            .await?;
            Ok(())
        })
    })
    .await;
    match outcome {
        Ok(()) => *published += 1,
        // Logged and dropped — see the module header. The turn's durable record
        // does not come from here.
        Err(error) => tracing::debug!(
            run_id = %address.run_id,
            error = %error,
            "agent.partial flush failed; dropping the slice"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cap trims on a character boundary. momo's channels are mostly Korean,
    /// where every character is three bytes — a naive byte slice would put
    /// invalid UTF-8 on the wire roughly two times in three.
    #[test]
    fn the_byte_cap_never_splits_a_character() {
        let mut buffer = String::new();
        let filler = "가".repeat(MAX_PARTIAL_BYTES); // 3 bytes each
        append(&mut buffer, &filler);
        assert!(buffer.len() <= MAX_PARTIAL_BYTES);
        assert!(
            buffer.len() > MAX_PARTIAL_BYTES - 3,
            "the cap should fill, not bail early: {}",
            buffer.len()
        );
        // The proof it is still text: it round-trips.
        assert_eq!(
            buffer,
            String::from_utf8(buffer.clone().into_bytes()).expect("utf8")
        );
        assert!(buffer.chars().all(|c| c == '가'));

        // Once full, further slices are dropped rather than appended.
        let before = buffer.len();
        append(&mut buffer, "나중");
        assert_eq!(buffer.len(), before);
    }

    /// An empty slice is not a slice. The provider emits them on keep-alive
    /// boundaries, and publishing one would be a frame that says nothing while
    /// still refreshing the client's liveness clock.
    #[test]
    fn an_empty_delta_is_not_forwarded() {
        let (sink, mut rx) = delta_channel();
        sink.text_delta("");
        sink.text_delta("답");
        drop(sink);
        assert_eq!(rx.blocking_recv().as_deref(), Some("답"));
        assert_eq!(rx.blocking_recv(), None);
    }

    /// The sink must never fail a turn. A pump that is gone is a dropped slice,
    /// not an error the provider has to handle.
    #[test]
    fn a_dropped_pump_does_not_make_the_sink_fail() {
        let (sink, rx) = delta_channel();
        drop(rx);
        sink.text_delta("아무도 없다");
    }
}
