//! The agent's memory-suggestion tool — 「기억해 둘게요」 (#3169, ADR-0196 D4/D9, plan §4.5 V3).
//!
//! An agent that hears a team **decision, commitment or fact worth keeping** may call
//! [`crate::tools::MEMORY_SUGGEST`]. It proposes; it never remembers. The call becomes a
//! `mem_proposal` row (migration 105) that is **pending** and invisible to search, serving and the
//! memory browser until a person accepts it through the API. Everything that decides what is
//! stored lives in the database (`mem_propose_item`); this module is the tool's contract with the
//! model — the argument gate, the model-facing words and the rule text — and the SQL call.
//!
//! ## What the agent cannot decide
//!
//! * **who proposes / where / for whom** — the run row: the agent is the run's agent, the channel
//!   is the run's channel, the requester is derived from the trigger message (`mem_serve_requester`).
//!   None of them is an argument.
//! * **which messages count as evidence** — the model cites the `#number` printed before each
//!   person's message in its window; the executor resolves numbers to messages **of the run's
//!   channel** and the database re-checks that every one is a live, unedited, human-written message
//!   near the trigger. A number that is not in this channel resolves to nothing.
//! * **the author of the memory** — the proposal records the run's agent; the accepted item is
//!   `origin='confirmed'`, made by the person who accepted.
//!
//! ## Two doors, one gate
//!
//! [`validate_suggestion`] is the whole argument gate for the worker door. There is no hosted
//! (Agent Port) twin yet — an outside agent has no `#number` window to cite from; see the PR body.

use momo_db::{DbError, PgConnection};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::memory::sqlstate;

/// The kinds a proposal may carry (the same five `mem_item.kind` allows).
pub const KINDS: [&str; 5] = ["decision", "fact", "commitment", "preference", "procedure"];
/// Body ceiling, in characters — `mem_item_body_ck`.
pub const TEXT_MAX_CHARS: usize = 600;
/// `mem_item_subject_ck`.
pub const SUBJECT_MAX_CHARS: usize = 80;
/// Evidence messages per proposal.
pub const EVIDENCE_MAX: usize = 8;
/// The keys the tool takes; anything else is refused, not ignored.
pub const ARGUMENT_KEYS: [&str; 4] = ["kind", "text", "evidence", "subject"];

/// The worker's system-prompt rule for the tool: when to reach for it, and what it is not.
///
/// A rule about behaviour, so it is its own system turn before the memory data block.
pub const MEMORY_SUGGEST_DIRECTIVE: &str = "\
기억 제안 규칙: 사람들이 팀이 계속 기억해야 할 결정·약속·사실을 분명하게 말했을 때만 memory_suggest 도구로 \
제안하세요. 각 사람 메시지 앞의 #번호가 근거 번호이고, 제안 내용을 뒷받침하는 메시지의 번호만 evidence 에 \
넣으세요(1~8개). 추측, 잡담, 농담, 비밀번호·키·토큰, 연결 도구가 원본인 상태(PR·이슈·배포·지표·일정)는 제안하지 \
마세요. 날짜가 걸린 내용은 text 에 YYYY-MM-DD 를 넣으세요. 도구는 제안만 만듭니다 — 사람이 수락해야 기억이 되므로 \
이미 기억했다고 말하지 말고 「기억해 둘까요?」처럼 물으세요. 한 번에 한 건씩만 제안하세요.";

/// [`MEMORY_SUGGEST_DIRECTIVE`] when `enabled` (the profile's resolved tool list) offers the tool,
/// otherwise `None` — the rule and the tool are offered together or not at all.
pub fn directive(enabled: &[crate::tools::ToolDefinition]) -> Option<&'static str> {
    is_offered(enabled).then_some(MEMORY_SUGGEST_DIRECTIVE)
}

/// Does the profile offer `memory_suggest`? Matching is `tools::normalize`, the executor's rule.
pub fn is_offered(enabled: &[crate::tools::ToolDefinition]) -> bool {
    let wanted = crate::tools::normalize(crate::tools::MEMORY_SUGGEST);
    enabled
        .iter()
        .any(|definition| crate::tools::normalize(definition.name) == wanted)
}

/// The published argument schema.
pub fn parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "kind": {
                "type": "string",
                "enum": KINDS,
                "description": "decision = the team settled something; commitment = someone promised to do something; fact = a durable fact the team relies on; preference / procedure = how the team likes things done."
            },
            "text": {
                "type": "string",
                "description": "The memory itself, one or two plain sentences (1-600 characters). Include the date (YYYY-MM-DD) when it is time-bound. No credentials, no guesses."
            },
            "evidence": {
                "type": "array",
                "items": {"type": "integer", "minimum": 1},
                "minItems": 1,
                "maxItems": EVIDENCE_MAX,
                "description": "The #numbers printed before the people's messages that support the text. Only people's messages count; yours never do."
            },
            "subject": {
                "type": "string",
                "description": "Optional short topic label (at most 80 characters), e.g. `릴리스 일정`."
            }
        },
        "required": ["kind", "text", "evidence"],
        "additionalProperties": false
    })
}

/// A proposal whose arguments passed the gate. `evidence` are channel message **numbers** (seq),
/// resolved to message ids by the executor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Suggestion {
    pub kind: &'static str,
    pub text: String,
    pub subject: Option<String>,
    pub evidence_seqs: Vec<i64>,
}

/// Why the arguments were refused. One cause: the model can fix it and retry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidArguments;

/// The whole argument gate: known keys only, an allowed kind, a 1..600 character text, a 1..8
/// distinct list of positive integers. Provider arguments arrive raw, so nothing here trusts a type.
pub fn validate_suggestion(arguments: &Value) -> Result<Suggestion, InvalidArguments> {
    let object: &Map<String, Value> = arguments.as_object().ok_or(InvalidArguments)?;
    if object
        .keys()
        .any(|key| !ARGUMENT_KEYS.contains(&key.as_str()))
    {
        return Err(InvalidArguments);
    }
    let kind = object
        .get("kind")
        .and_then(Value::as_str)
        .map(str::trim)
        .and_then(|kind| KINDS.iter().find(|known| **known == kind))
        .copied()
        .ok_or(InvalidArguments)?;
    let text = object
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty() && text.chars().count() <= TEXT_MAX_CHARS)
        .ok_or(InvalidArguments)?
        .to_string();
    let subject = match object.get("subject") {
        None | Some(Value::Null) => None,
        Some(Value::String(subject)) => {
            let subject = subject.trim();
            if subject.chars().count() > SUBJECT_MAX_CHARS {
                return Err(InvalidArguments);
            }
            (!subject.is_empty()).then(|| subject.to_string())
        }
        Some(_) => return Err(InvalidArguments),
    };
    let evidence = object
        .get("evidence")
        .and_then(Value::as_array)
        .ok_or(InvalidArguments)?;
    if evidence.is_empty() || evidence.len() > EVIDENCE_MAX {
        return Err(InvalidArguments);
    }
    let mut evidence_seqs: Vec<i64> = Vec::with_capacity(evidence.len());
    for entry in evidence {
        let seq = entry
            .as_i64()
            .filter(|seq| *seq >= 1)
            .ok_or(InvalidArguments)?;
        if evidence_seqs.contains(&seq) {
            return Err(InvalidArguments);
        }
        evidence_seqs.push(seq);
    }
    Ok(Suggestion {
        kind,
        text,
        subject,
        evidence_seqs,
    })
}

/// What `mem_propose_item` answered, in the model's terms.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// 23514 — the content was refused (kind, length, credential shape, an agent's own words).
    Content,
    /// 23503 — an evidence message is not a live message of this conversation.
    NotInConversation,
    /// 40001 — an evidence message was edited after the run began.
    Edited,
    /// 55000 — not here: memory is off, the channel is excluded, nobody asked, the run ended.
    NotHere,
    /// 54000 — too many proposals lately.
    RateLimited,
}

impl Refusal {
    pub fn classify(error: &DbError) -> Option<Refusal> {
        match sqlstate(error).as_deref() {
            Some("23514") => Some(Refusal::Content),
            Some("23503") => Some(Refusal::NotInConversation),
            Some("40001") => Some(Refusal::Edited),
            Some("55000") => Some(Refusal::NotHere),
            Some("54000") => Some(Refusal::RateLimited),
            _ => None,
        }
    }
}

/// `tool_result` for a stored proposal. It says the memory is **not** made yet.
pub const OUTPUT_PROPOSED: &str = "Proposed. Nothing is remembered yet: a person in this channel \
    must accept it first. Tell them you offered to remember it and ask; do not say you remembered it.";
/// `tool_result` when the same content is already remembered or already proposed.
pub const OUTPUT_DUPLICATE: &str =
    "Nothing new: the team already remembers this or a proposal for it \
    is waiting for a person. Do not propose it again.";
/// `tool_result` when the arguments were refused.
pub const OUTPUT_INVALID_ARGUMENTS: &str =
    "memory_suggest refused: send only kind (decision, fact, \
    commitment, preference or procedure), text (1-600 characters), evidence (1-8 distinct #numbers \
    from the people's messages) and optionally subject (at most 80 characters).";
/// `tool_result` when a cited number is not a message of this channel's window.
pub const OUTPUT_UNKNOWN_EVIDENCE: &str = "memory_suggest refused: one of the evidence numbers is \
    not a message of this conversation. Cite only the #numbers printed before people's messages.";

/// The `tool_result` for a database refusal. Names the reason so the model does not retry the same
/// call; it carries no argument echo and never says what another member can or cannot read.
pub fn refusal_output(refusal: Refusal) -> &'static str {
    match refusal {
        Refusal::Content => {
            "memory_suggest refused: the text cannot be remembered as written \
            (it must be a decision, fact or commitment of 1-600 characters, contain no credential, \
            and rest on people's messages, never on an agent's)."
        }
        Refusal::NotInConversation => OUTPUT_UNKNOWN_EVIDENCE,
        Refusal::Edited => {
            "memory_suggest refused: a cited message was edited after this turn \
            began. Do not propose from it now."
        }
        Refusal::NotHere => {
            "memory_suggest refused: memory is not available here (it is off or \
            paused for this channel, or nobody asked you in it). Answer in text instead."
        }
        Refusal::RateLimited => {
            "memory_suggest refused: too many proposals lately. Wait; do not \
            propose again in this turn."
        }
    }
}

/// The message ids behind the cited `#numbers` **of this channel**, in the order cited; `None` when
/// any number is not a message here. A plain read (the worker's own session, tenant explicit in the
/// statement): it only turns a handle into an id — whether the message may be cited is the
/// database's call in [`propose`]. A number from another channel simply resolves to nothing.
pub async fn resolve_evidence(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    seqs: &[i64],
) -> Result<Option<Vec<Uuid>>, DbError> {
    let rows: Vec<(i64, Uuid)> = sqlx::query_as(
        "SELECT seq, id FROM message WHERE workspace_id = $1 AND channel_id = $2 AND seq = ANY($3)",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(seqs)
    .fetch_all(&mut *conn)
    .await?;
    let ids: Vec<Uuid> = seqs
        .iter()
        .filter_map(|seq| rows.iter().find(|(s, _)| s == seq).map(|(_, id)| *id))
        .collect();
    Ok((ids.len() == seqs.len()).then_some(ids))
}

/// Store the proposal. `Some(id)` = a new pending proposal; `None` = the same content is already
/// remembered or already proposed in this channel. Run inside a **memory tx**
/// ([`crate::memory::with_memory_tx`]); a refusal is a database error the caller classifies with
/// [`Refusal::classify`] (the tx is rolled back — nothing to release).
pub async fn propose(
    conn: &mut PgConnection,
    run_id: Uuid,
    suggestion: &Suggestion,
    evidence_message_ids: &[Uuid],
) -> Result<Option<Uuid>, DbError> {
    Ok(
        sqlx::query_scalar::<_, Option<Uuid>>("SELECT mem_propose_item($1, $2, $3, $4, $5)")
            .bind(run_id)
            .bind(suggestion.kind)
            .bind(&suggestion.text)
            .bind(suggestion.subject.as_deref())
            .bind(evidence_message_ids)
            .fetch_one(&mut *conn)
            .await?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(value: Value) -> Suggestion {
        validate_suggestion(&value).expect("valid")
    }

    #[test]
    fn a_plain_call_passes_and_is_trimmed() {
        let suggestion = ok(json!({
            "kind": "decision", "text": "  배포는 2026-10-02 로 정했어요  ", "evidence": [12, 14],
            "subject": " 릴리스 "
        }));
        assert_eq!(suggestion.kind, "decision");
        assert_eq!(suggestion.text, "배포는 2026-10-02 로 정했어요");
        assert_eq!(suggestion.subject.as_deref(), Some("릴리스"));
        assert_eq!(suggestion.evidence_seqs, vec![12, 14]);
    }

    #[test]
    fn everything_outside_the_declared_shape_is_refused() {
        let good = json!({"kind": "fact", "text": "x", "evidence": [1]});
        assert!(validate_suggestion(&good).is_ok());
        for bad in [
            json!("not an object"),
            json!({"kind": "fact", "text": "x"}),
            json!({"kind": "fact", "text": "x", "evidence": []}),
            json!({"kind": "fact", "text": "x", "evidence": [1, 1]}),
            json!({"kind": "fact", "text": "x", "evidence": [0]}),
            json!({"kind": "fact", "text": "x", "evidence": [-3]}),
            json!({"kind": "fact", "text": "x", "evidence": ["7"]}),
            json!({"kind": "fact", "text": "x", "evidence": [1.5]}),
            json!({"kind": "fact", "text": "x", "evidence": [1,2,3,4,5,6,7,8,9]}),
            json!({"kind": "note", "text": "x", "evidence": [1]}),
            json!({"kind": "fact", "text": "   ", "evidence": [1]}),
            json!({"kind": "fact", "text": "가".repeat(601), "evidence": [1]}),
            json!({"kind": "fact", "text": "x", "evidence": [1], "subject": 5}),
            json!({"kind": "fact", "text": "x", "evidence": [1], "subject": "가".repeat(81)}),
            // the fields the model must not be able to choose
            json!({"kind": "fact", "text": "x", "evidence": [1], "channelId": "c"}),
            json!({"kind": "fact", "text": "x", "evidence": [1], "origin": "confirmed"}),
            json!({"kind": "fact", "text": "x", "evidence": [1], "author": "someone"}),
            json!({"kind": "fact", "text": "x", "evidence": [1], "forMemberId": "m"}),
        ] {
            assert!(validate_suggestion(&bad).is_err(), "{bad} must be refused");
        }
        assert!(validate_suggestion(
            &json!({"kind": "fact", "text": "가".repeat(600), "evidence": [1]})
        )
        .is_ok());
    }

    #[test]
    fn refusals_map_from_their_sqlstates_only() {
        let db = |code: &'static str| {
            DbError::Sqlx(sqlx::Error::Protocol(format!(
                "not a database error {code}"
            )))
        };
        // Non-database errors never masquerade as a refusal.
        assert_eq!(Refusal::classify(&db("54000")), None);
    }
}
