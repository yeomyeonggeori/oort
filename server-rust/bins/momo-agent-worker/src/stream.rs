//! The growing answer — one message per turn instead of one per flush
//! (#1130 전제①).
//!
//! ## What this is, and what it is not
//!
//! This is the **producer side** of the streaming edit contract: the exact
//! sequence a streaming provider performs, expressed once so every provider does
//! it the same way. [`MessageStream`] runs in-process against
//! `momo-messaging`; an out-of-process adapter (prime, hermes) performs the
//! identical two calls over REST — `POST …/messages` then
//! `PATCH …/messages/{id}` with a `stream` block — and inherits the same rules.
//!
//! It is **not** yet what `AgentWorker::run_turn` does with its own turns; that
//! flip is a separate ticket (ADR-0155 결정 5). What the flip was *waiting on*
//! is now decided: a run cancelled between enqueue and commit still posts
//! nothing when nothing was streamed, but a run that had already started
//! streaming has a message in the channel, and [`close_run_stream`] is what
//! happens to it. ADR-0155 chose **freeze and mark** over tombstone — the person
//! who pressed stop pressed it because of the text they had already read, and
//! deleting that text deletes their reason along with it.
//!
//! ## The three rules a producer must not get wrong
//!
//! 1. **The accumulator is the writer's.** `body` on the wire is absolute — the
//!    whole text so far, every time — so a retry re-states rather than
//!    re-appends. [`MessageStream`] owns that buffer; a caller only ever hands
//!    it deltas.
//! 2. **`rev` only ever goes up, and it survives a re-claim.** [`open`] resumes
//!    from the revision already stored on a deduped message rather than
//!    restarting at 1, because a worker that restarted its counter would find
//!    every one of its own slices refused as stale for the rest of the turn.
//! 3. **The opening write is idempotent on `client_msg_id`.** It is the run id,
//!    the same key `commit_turn` uses, so a crashed-and-re-claimed turn resumes
//!    the message it already opened instead of opening a second one.

use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_messaging::{
    open_stream_message_for_run_in_tx, send_message_in_tx, stream_message_body_in_tx,
    InteractionRefused, MessageType, NewMessage, StreamCloseOutcome, StreamEdit, StreamOutcome,
    STREAM_PROPS_KEY,
};
use serde_json::Value;
use uuid::Uuid;

/// Why a slice could not be written.
#[derive(Debug, thiserror::Error)]
pub enum StreamError {
    /// The domain refused the write (not the author, a tombstone, an empty body,
    /// a revision below 1). Each variant carries its own sentence.
    #[error("{0}")]
    Refused(InteractionRefused),
    #[error(transparent)]
    Db(#[from] DbError),
}

/// The revision already recorded on a message, `0` when it has never streamed.
///
/// Read from the projection the send handed back rather than with a second
/// query: on a deduped open that projection *is* the stored row.
fn stored_rev(props: &Value) -> i64 {
    props
        .get(STREAM_PROPS_KEY)
        .and_then(|stream| stream.get("rev"))
        .and_then(Value::as_i64)
        .unwrap_or(0)
}

/// One turn's growing message.
///
/// Hold it for the length of a provider stream: [`open`](Self::open) once with
/// the first slice that has any text in it, [`grow`](Self::grow) for each
/// window after that, and [`finish`](Self::finish) when the provider is done.
#[derive(Debug)]
pub struct MessageStream {
    pool: PgPool,
    workspace_id: Uuid,
    channel_id: Uuid,
    author_member_id: Uuid,
    /// Doubles as the opening write's `client_msg_id` — see rule 3.
    run_id: Uuid,
    reply_to_id: Option<Uuid>,
    message_id: Option<Uuid>,
    rev: i64,
    body: String,
}

impl MessageStream {
    pub fn new(
        pool: PgPool,
        workspace_id: Uuid,
        channel_id: Uuid,
        author_member_id: Uuid,
        run_id: Uuid,
        reply_to_id: Option<Uuid>,
    ) -> Self {
        MessageStream {
            pool,
            workspace_id,
            channel_id,
            author_member_id,
            run_id,
            reply_to_id,
            message_id: None,
            rev: 0,
            body: String::new(),
        }
    }

    /// The message this stream is growing, once it has been opened.
    pub fn message_id(&self) -> Option<Uuid> {
        self.message_id
    }

    /// The revision the last accepted write carried.
    pub fn rev(&self) -> i64 {
        self.rev
    }

    /// Everything written so far.
    pub fn body(&self) -> &str {
        &self.body
    }

    /// Take one delta and publish the answer so far.
    ///
    /// The first call with non-blank text opens the message; every call after it
    /// grows the same row. An empty accumulation is a no-op rather than a
    /// refusal: a provider that emits a keep-alive before its first token has
    /// not said anything, and opening a blank message to hold its place would
    /// put an empty bubble in the channel.
    pub async fn push(&mut self, delta: &str, is_final: bool) -> Result<(), StreamError> {
        self.body.push_str(delta);
        if self.body.trim().is_empty() {
            return Ok(());
        }
        match self.message_id {
            None => self.open(is_final).await,
            Some(message_id) => self.grow(message_id, is_final).await,
        }
    }

    /// Mark the answer complete, publishing whatever is buffered as the last
    /// slice. Returns the message id, or `None` when the provider said nothing.
    ///
    /// A turn that produced no text opens no message: an empty bubble in the
    /// channel is worse than the silence it would be standing in for, and the
    /// run's own terminal frame already reports that the turn ended.
    pub async fn finish(&mut self) -> Result<Option<Uuid>, StreamError> {
        if self.body.trim().is_empty() {
            return Ok(None);
        }
        self.push("", true).await?;
        Ok(self.message_id)
    }

    /// The opening `send`, idempotent on the run id (rule 3).
    async fn open(&mut self, is_final: bool) -> Result<(), StreamError> {
        let workspace_id = self.workspace_id;
        let channel_id = self.channel_id;
        let author_member_id = self.author_member_id;
        let run_id = self.run_id;
        let reply_to_id = self.reply_to_id;
        let body = self.body.clone();

        let sent = with_tenant_tx(&self.pool, workspace_id, move |conn| {
            Box::pin(async move {
                send_message_in_tx(
                    conn,
                    workspace_id,
                    NewMessage {
                        channel_id,
                        author_member_id,
                        message_type: MessageType::Text,
                        body: Some(body),
                        props: serde_json::json!({}),
                        root_id: None,
                        // ADR-0148 규칙 6 — the answer quotes the utterance that
                        // raised it, exactly as `commit_turn` does. Streaming
                        // changes when the message appears, not what it points at.
                        reply_to_id,
                        client_msg_id: Some(run_id),
                        run_id: Some(run_id),
                        hlc_ts: None,
                        hlc_count: None,
                    },
                )
                .await
            })
        })
        .await?;

        self.message_id = Some(sent.message.id);
        // Rule 2: a re-claimed turn resumes the counter it left behind. Starting
        // over at 1 would have every remaining slice refused as stale, and the
        // answer would stop growing without a single error anywhere.
        self.rev = if sent.deduped {
            stored_rev(&sent.message.props)
        } else {
            0
        };
        if sent.deduped || is_final {
            // A deduped open wrote no body (the guard returned the existing row),
            // so the text this call carries still has to land — and a first slice
            // that is also the last has to be marked final.
            let message_id = sent.message.id;
            self.grow(message_id, is_final).await?;
        }
        Ok(())
    }

    /// One `PATCH`-shaped slice: the whole body so far at the next revision.
    async fn grow(&mut self, message_id: Uuid, is_final: bool) -> Result<(), StreamError> {
        let workspace_id = self.workspace_id;
        let author_member_id = self.author_member_id;
        let body = self.body.clone();
        let edit = StreamEdit {
            rev: self.rev + 1,
            is_final,
            // A slice that arrives is never a stopping — the only writer of an
            // outcome is `close_run_stream`, on a turn that has already ended.
            outcome: None,
        };

        let outcome = with_tenant_tx(&self.pool, workspace_id, move |conn| {
            Box::pin(async move {
                stream_message_body_in_tx(
                    conn,
                    workspace_id,
                    message_id,
                    author_member_id,
                    &body,
                    edit,
                )
                .await
            })
        })
        .await?
        .map_err(StreamError::Refused)?;

        // Advance only on an accepted write. A `Stale` outcome means something
        // else already spoke for this message at that revision; re-using the
        // number would keep this stream permanently one behind.
        self.rev = stored_rev(&outcome.message().message.props).max(match outcome {
            StreamOutcome::Applied(_) => edit.rev,
            StreamOutcome::Stale(_) => self.rev,
        });
        Ok(())
    }
}

/// Close the message a stopped run left open, marking **how** it stopped
/// (ADR-0155).
///
/// One `PATCH`-shaped write: the same body at the next revision, `final: true`,
/// and an `outcome`. The body is re-stated unchanged — that is the whole point.
/// Freezing the partial answer keeps the evidence the human acted on; the
/// `outcome` is what stops that frozen half-sentence from passing for a
/// finished one.
///
/// ## Why it takes a `run_id` and not a [`MessageStream`]
///
/// The process that must close a stream is often not the process that opened
/// it. prime and hermes stream over REST from outside this binary; a worker
/// that died mid-answer has its job re-claimed by a different worker; and the
/// cancel arrives on the run, which is the only name all of them share. Looking
/// the message up by run id also makes the close work for a producer this crate
/// has never heard of.
///
/// ## Best effort, deliberately
///
/// Returns `Ok(None)` when there is nothing open — no streamed message, or one
/// already closed — and that is the common case today, since `run_turn` still
/// posts its answer in one write. Callers log an `Err` and move on: ADR-0155
/// chose defensive rendering over a server sweeper precisely so that a failed
/// close is a cosmetic loss rather than a stuck message. The run's terminal
/// status is already durable, so a client seeing "run ended, stream still open"
/// draws the same tail from the other half of the rule.
pub async fn close_run_stream(
    pool: &PgPool,
    workspace_id: Uuid,
    run_id: Uuid,
    outcome: StreamCloseOutcome,
) -> Result<Option<Uuid>, StreamError> {
    let open = with_tenant_tx(pool, workspace_id, move |conn| {
        Box::pin(async move { open_stream_message_for_run_in_tx(conn, run_id).await })
    })
    .await?;
    let Some(open) = open else {
        return Ok(None);
    };

    let message_id = open.message_id;
    let author_member_id = open.author_member_id;
    let body = open.body;
    let edit = StreamEdit {
        rev: open.rev + 1,
        is_final: true,
        outcome: Some(outcome),
    };
    with_tenant_tx(pool, workspace_id, move |conn| {
        Box::pin(async move {
            stream_message_body_in_tx(
                conn,
                workspace_id,
                message_id,
                author_member_id,
                &body,
                edit,
            )
            .await
        })
    })
    .await?
    .map_err(StreamError::Refused)?;
    Ok(Some(message_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A message that never streamed reads as revision 0 — the floor the
    /// strictly-greater rule stands on, and the value a fresh open resumes from.
    #[test]
    fn a_message_with_no_marker_resumes_at_zero() {
        assert_eq!(stored_rev(&json!({})), 0);
        assert_eq!(stored_rev(&json!({ "kind": "resume_offer" })), 0);
        assert_eq!(stored_rev(&json!({ STREAM_PROPS_KEY: { "rev": 9 } })), 9);
    }

    /// **The re-claim rule.** A worker that crashed mid-answer and had its job
    /// re-claimed must continue the revision it left behind. Restart the counter
    /// and every remaining slice is refused as stale — the answer stops growing
    /// with no error raised anywhere, which is the worst shape a bug can take.
    #[test]
    fn a_resumed_turn_continues_the_revision_it_left_behind() {
        let props = json!({ STREAM_PROPS_KEY: { "rev": 11, "streaming": true } });
        assert_eq!(
            stored_rev(&props) + 1,
            12,
            "the next slice after a re-claim is 12, not 1"
        );
    }
}
