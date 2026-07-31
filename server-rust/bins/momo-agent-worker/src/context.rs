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
    max_chars: usize,
) -> AssembledContext {
    let mut head: Vec<ChatMessage> = Vec::new();
    if let Some(prompt) = system_prompt.map(str::trim).filter(|p| !p.is_empty()) {
        head.push(ChatMessage::system(prompt));
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
        let out = assemble(&window, Uuid::from_u128(AGENT), None, "unused", None, 20);
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
