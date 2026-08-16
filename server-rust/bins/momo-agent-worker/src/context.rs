//! Assemble the projected history window into an OpenAI-compatible chat array.
//!
//! Port of Swift `AgentWorker/ContextAssembler.swift` (MOMO-302). Pure and
//! deterministic, so role mapping, the budget trim, and the legacy
//! single-message fallback are unit-testable without a provider.
//!
//! Role mapping (L4 §6.1):
//!   * the trigger agent's own past turns → `assistant`
//!   * humans and *other* agents → `user`, prefixed `"[display] "` so the model
//!     can attribute each speaker inside one `user` stream.
//!
//! Deliberately **not** ported in B5.1: the `memory_refs` system block
//! (`memoryContextBlock`, Swift :115-136). The pgvector memory plane has no Rust
//! owner yet, so injecting a half-ported block would put unverifiable text in
//! front of every turn. The payload field is ignored, not silently dropped —
//! see the PR body's deviation list.

use uuid::Uuid;

use crate::payload::RecentMessage;
use crate::provider::ChatMessage;

// ---- the current date (goal B8 L7) -----------------------------------------
//
// A model's sense of "now" is its training cutoff, so an agent asked 오늘 며칠
// 이야 answered with a date in 2025 and, worse, reasoned about "최근" and
// "이번 주" from there without saying so. Nothing in the assembled context ever
// told it otherwise: the window carries message bodies, not timestamps.
//
// One system line fixes it, and it has to be a line the model cannot mistake
// for the user's words, which is why it is `system` and not a prefix on the
// trigger turn.
//
// The clock arrives as a parameter (epoch millis + a fixed offset), never read
// inside this module: the assembler is pure and its tests must not depend on
// the day they run. Civil date arithmetic is done here rather than through
// `chrono` because this crate's dependency list is deliberately short (see its
// Cargo.toml) and the conversion below is a closed-form 20 lines.

const WEEKDAYS_KO: [&str; 7] = ["일", "월", "화", "수", "목", "금", "토"];

/// (year, month, day) from days since 1970-01-01. Howard Hinnant's
/// `civil_from_days`, which is exact for the whole proleptic Gregorian range.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Floor division: `-1 / 86_400_000` must be the day BEFORE the epoch, not 0.
fn div_floor(a: i64, b: i64) -> i64 {
    let q = a / b;
    if a % b != 0 && ((a < 0) != (b < 0)) {
        q - 1
    } else {
        q
    }
}

/// The `system` line that tells the model what day it is.
///
/// `utc_offset_minutes` is the workspace's wall clock, not the server's: a
/// Korean team asking 오늘 means 오늘 in Seoul. The offset is printed beside the
/// time so the model can convert rather than assume, and the second sentence
/// names the failure mode explicitly, because a model that merely SEES a date
/// still tends to answer from its cutoff unless told which one is current.
pub fn now_context_block(now_ms: i64, utc_offset_minutes: i32) -> String {
    let local_ms = now_ms + i64::from(utc_offset_minutes) * 60_000;
    let days = div_floor(local_ms, 86_400_000);
    let ms_of_day = local_ms - days * 86_400_000;
    let (year, month, day) = civil_from_days(days);
    // 1970-01-01 was a Thursday, so the epoch day sits at index 4 of a
    // Sunday-first week.
    let weekday = WEEKDAYS_KO[((days % 7 + 7 + 4) % 7) as usize];
    let hour = ms_of_day / 3_600_000;
    let minute = (ms_of_day % 3_600_000) / 60_000;
    let sign = if utc_offset_minutes < 0 { '-' } else { '+' };
    let offset = utc_offset_minutes.abs();
    format!(
        "현재 시각: {year:04}-{month:02}-{day:02} ({weekday}) {hour:02}:{minute:02} \
         (UTC{sign}{oh:02}:{om:02})\n\
         오늘, 어제, 이번 주, 최근 같은 표현은 이 시각을 기준으로 해석하세요. \
         학습 데이터의 마지막 시점이 아니라 이 시각이 현재입니다.",
        oh = offset / 60,
        om = offset % 60,
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssembledContext {
    pub messages: Vec<ChatMessage>,
    /// Oldest turns dropped to fit `max_chars`. Counted, never logged as text
    /// (redaction, L4 §7).
    pub dropped_count: usize,
}

struct Turn {
    role: &'static str,
    content: String,
    is_trigger: bool,
}

/// The `system` blocks the **server** puts in front of a turn, beside the
/// operator's own prompt.
///
/// A struct rather than two more positional `Option<&str>` parameters, for
/// `momo_messaging::SendExtras`'s reason: both are optional, both are strings,
/// and they sit next to each other — a call site that has to write `None, None`
/// to mean "an ordinary turn" is a call site that will eventually pass them in
/// the wrong order, and nothing would catch it but a human reading a transcript.
///
/// Both blocks ride **outside the budget trim** (see [`assemble`]). Two or three
/// lines cannot be what pushes a window over, and a turn that silently dropped
/// either of them would lose a capability with nothing on screen to say why.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemBlocks<'a> {
    /// The current-date block (goal B8 L7). Passed in rather than read from the
    /// clock so [`assemble`] stays deterministic and its tests stay
    /// date-independent.
    pub now: Option<&'a str>,
    /// The completion-report protocol (#1454) — the only thing that tells a
    /// model this card exists.
    ///
    /// Kept apart from [`SystemBlocks::now`] rather than appended to it because
    /// the two say different kinds of thing: one is a fact about the world, the
    /// other a rule about behaviour. Folded into one block, an operator reading
    /// the transcript could not tell which was which.
    pub report_protocol: Option<&'a str>,
}

/// Build the chat array for one turn.
///
/// When `recent_messages` is empty (legacy/back-compat payloads) the amnesiac
/// path is preserved: an optional `system` prompt followed by one `user` turn
/// carrying `fallback_prompt`.
pub fn assemble(
    recent_messages: &[RecentMessage],
    agent_member_id: Uuid,
    trigger_message_id: Option<Uuid>,
    fallback_prompt: &str,
    system_prompt: Option<&str>,
    blocks: SystemBlocks<'_>,
    max_chars: usize,
) -> AssembledContext {
    let mut head: Vec<ChatMessage> = Vec::new();
    if let Some(prompt) = system_prompt.map(str::trim).filter(|p| !p.is_empty()) {
        head.push(ChatMessage::system(prompt));
    }
    // After the operator's instructions and before the conversation: they are
    // the server's own words, and they must not be the last thing an operator's
    // prompt can be overridden by. They are also outside the budget trim below,
    // deliberately: a turn that dropped the clock would silently go back to
    // answering from the training cutoff, and one that dropped the protocol
    // would stop writing reports in exactly the long conversations that need them.
    if let Some(now) = blocks.now.map(str::trim).filter(|n| !n.is_empty()) {
        head.push(ChatMessage::system(now));
    }
    if let Some(protocol) = blocks
        .report_protocol
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        head.push(ChatMessage::system(protocol));
    }

    let mut turns: Vec<Turn> = if recent_messages.is_empty() {
        vec![Turn {
            role: "user",
            content: fallback_prompt.to_string(),
            is_trigger: true,
        }]
    } else {
        recent_messages
            .iter()
            .map(|message| {
                let body = message.body.clone().unwrap_or_default();
                let is_trigger =
                    trigger_message_id.is_some() && message.message_id == trigger_message_id;
                if message.author_member_id == Some(agent_member_id) {
                    return Turn {
                        role: "assistant",
                        content: body,
                        is_trigger,
                    };
                }
                let display = message
                    .author_display
                    .as_deref()
                    .map(str::trim)
                    .filter(|d| !d.is_empty());
                let content = match display {
                    Some(display) => format!("[{display}] {body}"),
                    None => body,
                };
                Turn {
                    role: "user",
                    content,
                    is_trigger,
                }
            })
            .collect()
    };

    // Drop non-trigger turns whose content is empty/whitespace: some
    // OpenAI-compatible endpoints reject a `{role, content: ""}` message
    // outright, which would fail the whole turn over one deleted line.
    //
    // The predicate is on the **composed** content, not the raw body — Swift
    // :79 filters after the `[display] ` prefix is applied. That is a narrower
    // guard than it first looks (a named speaker's blank body survives as an
    // attribution-only line), and it is kept as measured rather than tightened:
    // widening it here would silently change what every model sees relative to
    // the Swift worker, which is the drift this port exists to avoid.
    turns.retain(|turn| turn.is_trigger || !turn.content.trim().is_empty());

    // If the server never tagged a trigger (defensive), the newest turn — the
    // window is ASC by seq, so the last one — becomes the always-keep, so budget
    // trimming can never erase the utterance being answered.
    if !turns.iter().any(|turn| turn.is_trigger) {
        if let Some(last) = turns.last_mut() {
            last.is_trigger = true;
        }
    }

    // Character-count approximation of the token budget. Oldest first, never the
    // trigger, never the last survivor.
    let mut total: usize = turns.iter().map(|turn| turn.content.chars().count()).sum();
    let mut dropped = 0usize;
    while total > max_chars && turns.len() > 1 && !turns[0].is_trigger {
        total -= turns[0].content.chars().count();
        turns.remove(0);
        dropped += 1;
    }

    let mut messages = head;
    messages.extend(turns.into_iter().map(|turn| ChatMessage {
        role: turn.role.to_string(),
        content: turn.content,
    }));
    AssembledContext {
        messages,
        dropped_count: dropped,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(id: u128, author: Option<u128>, display: Option<&str>, body: &str) -> RecentMessage {
        RecentMessage {
            message_id: Some(Uuid::from_u128(id)),
            seq: Some(id as i64),
            author_member_id: author.map(Uuid::from_u128),
            author_display: display.map(str::to_string),
            body: Some(body.to_string()),
        }
    }

    const AGENT: u128 = 99;

    // ---- the current date (goal B8 L7) -------------------------------------

    /// The reported bug, inverted into an assertion: an agent asked what day it
    /// is answered 2025 because nothing in its context said otherwise.
    #[test]
    fn the_now_block_states_the_local_date_time_and_offset() {
        // 2026-08-01T00:00:00Z, which is 09:00 on the same day in Seoul.
        let block = now_context_block(1_785_542_400_000, 540);
        assert!(
            block.starts_with("현재 시각: 2026-08-01 (토) 09:00 (UTC+09:00)"),
            "{block}"
        );
        assert!(block.contains("이 시각이 현재입니다"), "{block}");
    }

    /// The offset is the workspace's, not the server's, and it can roll the
    /// date across a day boundary in either direction. Getting the sign wrong
    /// would be worse than saying nothing: a confidently wrong date.
    #[test]
    fn the_offset_rolls_the_date_in_both_directions() {
        // 2026-08-01T00:00:00Z is still 2026-07-31 in UTC-05:00.
        let west = now_context_block(1_785_542_400_000, -300);
        assert!(
            west.starts_with("현재 시각: 2026-07-31 (금) 19:00 (UTC-05:00)"),
            "{west}"
        );
        // 2026-07-31T23:00:00Z is already 2026-08-01 in Seoul.
        let east = now_context_block(1_785_538_800_000, 540);
        assert!(
            east.starts_with("현재 시각: 2026-08-01 (토) 08:00 (UTC+09:00)"),
            "{east}"
        );
    }

    /// The epoch itself, and the day before it: the floor-division branch that a
    /// plain `/` gets wrong.
    #[test]
    fn dates_before_the_epoch_do_not_wrap_forward() {
        assert!(now_context_block(0, 0).starts_with("현재 시각: 1970-01-01 (목) 00:00 (UTC+00:00)"));
        assert!(
            now_context_block(-1, 0).starts_with("현재 시각: 1969-12-31 (수) 23:59 (UTC+00:00)")
        );
    }

    /// A leap day, because February is where a hand-written calendar breaks.
    #[test]
    fn a_leap_day_is_a_real_day() {
        // 2028-02-29T12:00:00Z
        let block = now_context_block(1_835_438_400_000, 0);
        assert!(
            block.starts_with("현재 시각: 2028-02-29 (화) 12:00"),
            "{block}"
        );
    }

    /// It is a `system` turn, it sits after the operator's prompt, and it is
    /// never confused with something the user said.
    #[test]
    fn the_now_block_rides_as_its_own_system_turn_after_the_prompt() {
        let window = vec![message(1, Some(5), Some("성재"), "오늘 며칠이야?")];
        let out = assemble(
            &window,
            Uuid::from_u128(AGENT),
            Some(Uuid::from_u128(1)),
            "unused",
            Some("you are hermes"),
            SystemBlocks {
                now: Some("현재 시각: 2026-08-01"),
                ..SystemBlocks::default()
            },
            10_000,
        );
        assert_eq!(
            out.messages,
            vec![
                ChatMessage::system("you are hermes"),
                ChatMessage::system("현재 시각: 2026-08-01"),
                ChatMessage::user("[성재] 오늘 며칠이야?"),
            ]
        );
    }

    /// The budget can trim history; it must never trim the clock. A turn that
    /// silently dropped this block would go back to answering from the cutoff,
    /// and nothing on screen would say why.
    #[test]
    fn the_budget_never_drops_the_now_block() {
        let window = vec![
            message(1, Some(5), None, &"가".repeat(200)),
            message(2, Some(5), None, "지금 몇 시야?"),
        ];
        let out = assemble(
            &window,
            Uuid::from_u128(AGENT),
            Some(Uuid::from_u128(2)),
            "unused",
            None,
            SystemBlocks {
                now: Some("현재 시각: 2026-08-01"),
                ..SystemBlocks::default()
            },
            20,
        );
        assert_eq!(
            out.messages[0],
            ChatMessage::system("현재 시각: 2026-08-01")
        );
        assert_eq!(out.dropped_count, 1);
    }

    /// #1454 — the report protocol rides its own `system` turn, after the
    /// operator's prompt and the clock, and the budget never trims it.
    ///
    /// Both halves matter. Fold it into the user's turn and a model can be talked
    /// out of it by the next sentence; let the trim reach it and the feature dies
    /// silently in exactly the channels busy enough to need it — a long setup
    /// conversation is the one that overflows the window.
    #[test]
    fn the_report_protocol_is_a_system_turn_the_budget_cannot_trim() {
        let window = vec![
            message(1, Some(5), None, &"가".repeat(200)),
            message(2, Some(5), Some("성재"), "@hermes 환경 만들어줘"),
        ];
        let out = assemble(
            &window,
            Uuid::from_u128(AGENT),
            Some(Uuid::from_u128(2)),
            "unused",
            Some("you are hermes"),
            SystemBlocks {
                now: Some("현재 시각: 2026-08-17"),
                report_protocol: Some(crate::completion_report::REPORT_PROTOCOL_BLOCK),
            },
            20,
        );
        assert_eq!(
            out.messages[..3],
            [
                ChatMessage::system("you are hermes"),
                ChatMessage::system("현재 시각: 2026-08-17"),
                ChatMessage::system(crate::completion_report::REPORT_PROTOCOL_BLOCK),
            ]
        );
        assert_eq!(
            out.dropped_count, 1,
            "history trimmed, the protocol was not"
        );
        assert!(
            out.messages[2]
                .content
                .contains(crate::completion_report::REPORT_FENCE_TAG),
            "the protocol must name the fence the producer actually reads"
        );
    }

    /// A worker built before the card existed passes `None`, and the context it
    /// assembles must be byte-identical to what it was — the protocol is an
    /// addition, not a rewrite of every agent's system prompt.
    #[test]
    fn no_protocol_means_the_context_is_exactly_what_it_was() {
        let window = vec![message(1, Some(5), Some("성재"), "안녕")];
        let out = assemble(
            &window,
            Uuid::from_u128(AGENT),
            Some(Uuid::from_u128(1)),
            "unused",
            Some("you are hermes"),
            SystemBlocks::default(),
            10_000,
        );
        assert_eq!(
            out.messages,
            vec![
                ChatMessage::system("you are hermes"),
                ChatMessage::user("[성재] 안녕"),
            ]
        );
    }

    /// The agent's own past turns must come back as `assistant`; everyone else
    /// is a `user` line tagged with its speaker. Reverse either and the model
    /// reads its own answers as the user's words.
    #[test]
    fn the_agents_own_turns_are_assistant_and_everyone_else_is_a_tagged_user() {
        let window = vec![
            message(1, Some(5), Some("성재"), "안녕"),
            message(2, Some(AGENT), Some("hermes"), "반가워요"),
            message(3, Some(5), Some("성재"), "@hermes 오늘 뭐해?"),
        ];
        let out = assemble(
            &window,
            Uuid::from_u128(AGENT),
            Some(Uuid::from_u128(3)),
            "unused",
            Some("you are hermes"),
            SystemBlocks::default(),
            10_000,
        );
        assert_eq!(
            out.messages,
            vec![
                ChatMessage::system("you are hermes"),
                ChatMessage::user("[성재] 안녕"),
                ChatMessage {
                    role: "assistant".into(),
                    content: "반가워요".into()
                },
                ChatMessage::user("[성재] @hermes 오늘 뭐해?"),
            ]
        );
        assert_eq!(out.dropped_count, 0);
    }

    /// Legacy payloads carry no window. Losing the fallback path would make
    /// every pre-MOMO-302 job send an empty conversation.
    #[test]
    fn an_empty_window_falls_back_to_the_single_prompt_turn() {
        let out = assemble(
            &[],
            Uuid::from_u128(AGENT),
            None,
            "직접 물어봄",
            None,
            SystemBlocks::default(),
            10_000,
        );
        assert_eq!(out.messages, vec![ChatMessage::user("직접 물어봄")]);
    }

    /// The budget drops history oldest-first and must never drop the utterance
    /// being answered — even when that utterance alone exceeds the budget.
    #[test]
    fn the_trigger_survives_a_budget_that_the_history_does_not() {
        let window = vec![
            message(1, Some(5), None, &"가".repeat(100)),
            message(2, Some(5), None, &"나".repeat(100)),
            message(3, Some(5), None, &"다".repeat(100)),
        ];
        let out = assemble(
            &window,
            Uuid::from_u128(AGENT),
            Some(Uuid::from_u128(3)),
            "unused",
            None,
            SystemBlocks::default(),
            120,
        );
        assert_eq!(out.dropped_count, 2);
        assert_eq!(out.messages.len(), 1);
        assert!(out.messages[0].content.starts_with('다'));

        // Trigger alone over budget: kept anyway.
        let only_trigger = vec![message(3, Some(5), None, &"다".repeat(500))];
        let out = assemble(
            &only_trigger,
            Uuid::from_u128(AGENT),
            Some(Uuid::from_u128(3)),
            "unused",
            None,
            SystemBlocks::default(),
            10,
        );
        assert_eq!(out.messages.len(), 1);
        assert_eq!(out.dropped_count, 0);
    }

    /// An untagged window must still answer the newest line rather than trimming
    /// it away as "just more history".
    #[test]
    fn an_untagged_window_treats_the_newest_turn_as_the_trigger() {
        let window = vec![
            message(1, Some(5), None, &"가".repeat(100)),
            message(2, Some(5), None, "최신"),
        ];
        let out = assemble(
            &window,
            Uuid::from_u128(AGENT),
            None,
            "unused",
            None,
            SystemBlocks::default(),
            20,
        );
        assert_eq!(out.messages.len(), 1);
        assert_eq!(out.messages[0].content, "최신");
    }

    /// A deleted/structured line projects as an empty body; emitting it would be
    /// a `content: ""` chat message that several gateways reject outright.
    ///
    /// This pins Swift's actual boundary (:79), which filters the **composed**
    /// content: an unattributed blank body disappears, an attributed one
    /// survives as `"[display] "`. If this test is ever "fixed" to drop the
    /// attributed line too, the Rust worker and the Swift worker start sending
    /// different context arrays for the same channel — which is exactly the
    /// drift this port exists to prevent.
    #[test]
    fn blank_history_lines_follow_swifts_composed_content_filter() {
        let window = vec![
            message(1, None, None, "   "),
            message(2, Some(5), Some("성재"), "   "),
            message(3, Some(5), Some("성재"), "실제 질문"),
        ];
        let out = assemble(
            &window,
            Uuid::from_u128(AGENT),
            Some(Uuid::from_u128(3)),
            "unused",
            None,
            SystemBlocks::default(),
            10_000,
        );
        assert_eq!(
            out.messages,
            vec![
                ChatMessage::user("[성재]    "),
                ChatMessage::user("[성재] 실제 질문"),
            ],
            "the unattributed blank line is gone; the attributed one is Swift's"
        );
    }
}
