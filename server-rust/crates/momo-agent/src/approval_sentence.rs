//! The sentences an approval says outside the app — on a lock screen, in a notification, in the
//! fallback of a client that does not know the card (ADR-0204 증보 6 D6-3 · D6-4).
//!
//! Two kinds, both built here and nowhere else:
//!
//! * **The question** — the approval card's `body` (D6-3): one sentence a person answers,
//!   `질문 · 「값」`. The push, the desktop notification and the card-less fallback read the same
//!   `body`. A proposal from an agent that nobody asked for starts with 「먼저 제안 · 」.
//! * **The receipt line** — what the decision response says about what happened (D6-4):
//!   「✓ 소개를 바꿨어요」 on approval, 「소개 바꾸기를 거부했어요」 on rejection, 「이미 승인된 요청이에요 ·
//!   소개 바꾸기」 on a second tap. Additive: a client that does not know it keeps its own sentence.
//!
//! ## No particle after a value
//!
//! The default frame never puts a particle behind a value: the value is quoted after the
//! sentence (`소개를 바꿔도 될까요? · 「알림 시험」`), not inside it (`소개를 「…」으로 바꿔도`). A
//! particle is chosen by the value's last syllable, the core's `particleFor` / `directionParticle`
//! decide only a Hangul ending and **hedge** the rest (「을(를)」), and this crate's
//! [`crate::korean`] has no 으로/로 pair at all — so a frame that needs one for an English channel
//! name or a tool id would write a hedge into a durable `body`. The particles in this file follow
//! **static** Hangul phrases written here (`소개 바꾸기` + 를), never a value; a test walks every
//! phrase and fails on a hedge.
//!
//! ## What may be quoted
//!
//! Only a short value the server has already validated or owns (a channel name, a tool name, an
//! agent's display name) and only in one line: [`quotable_value`]. A person's free text — a
//! tagline, a message, a rationale — is never quoted, and neither is anything long: the card is
//! where it is read in full.

use serde_json::Value;

use crate::actions::{
    action_by_id, WorkspaceAction, ACTION_AGENT_PROFILE_UPDATE, ACTION_CHANNEL_CREATE,
    ACTION_TYPE_WORKSPACE_ACTION,
};
use crate::hosted_notice::inert_display_name;
use crate::korean::{particle_for, ParticlePair};
use crate::tools::ACTION_TYPE_TOOL_CALL;

/// Between the sentence and what follows it.
pub const SEPARATOR: &str = " · ";
/// In front of a proposal nobody asked for (ADR-0204 증보 6 D6-3).
pub const UNASKED_PREFIX: &str = "먼저 제안";
/// The longest value a sentence quotes, in characters. Longer is left out, not cut: a cut
/// value is a different value.
pub const VALUE_MAX_CHARS: usize = 30;

/// The question a tool approval asks. The tool's name is quoted after it.
pub const TOOL_QUESTION: &str = "도구를 실행해도 될까요?";
/// A work spawn (a host to pick) asks about starting the work; the tool is quoted after it.
pub const SPAWN_QUESTION: &str = "작업을 시작해도 될까요?";
/// The card of the in-place channel grant: a person called the agent in a channel it cannot
/// read yet. No value — the agent is the push's title and the channel is on the notification.
pub const IN_PLACE_GRANT_QUESTION: &str = "이 채널에서 읽고 쓰게 해도 될까요?";
/// A DM admission: who the agent is, is quoted after it.
pub const DM_ADMISSION_QUESTION: &str = "에이전트를 이 대화에 들여도 될까요?";
/// What an approval whose shape this build does not know asks.
pub const GENERIC_QUESTION: &str = "요청을 승인해도 될까요?";

/// The three phrases of one approval.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Phrases {
    /// 「소개를 바꿔도 될까요?」
    pub question: &'static str,
    /// 「소개를 바꿨어요」 (the receipt puts 「✓ 」 in front).
    pub done: &'static str,
    /// What the rejection and the second tap name: 「소개 바꾸기」.
    pub noun: &'static str,
}

/// A value this server may quote in a sentence: one short line, trimmed, with nothing in it that
/// could draw something else — no control or direction-changing character, no bracket of the
/// quote itself. `None` when it has to be left out.
///
/// What is quoted is also made **inert** ([`inert_display_name`], the way the hosted notice
/// lines and the in-place card's body already name an agent): a `body` is parsed as markdown by
/// the clients, so a name that spells `[label](https://…)` must not be able to become a link in
/// a sentence this server wrote. An ordinary name is unchanged.
pub fn quotable_value(raw: &str) -> Option<String> {
    let unsafe_char = |c: char| {
        c.is_control()
            || matches!(c, '「' | '」' | '『' | '』')
            || matches!(c as u32,
                0x200B..=0x200F // zero-width and direction marks
                | 0x2028..=0x202E // separators and embeddings/overrides
                | 0x2060..=0x2069 // word joiner, isolates
                | 0xFEFF)
    };
    // Judged on the raw text: a line break or a tab is not tidied into a space — a value that
    // had one is not the value a person would read, so it is left out.
    if raw.chars().any(unsafe_char) {
        return None;
    }
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() || collapsed.chars().count() > VALUE_MAX_CHARS {
        return None;
    }
    Some(inert_display_name(&collapsed))
}

/// `question`, or `question · 「value」`, behind 「먼저 제안 · 」 when nobody asked.
pub fn question_body(question: &str, value: Option<&str>, unasked: bool) -> String {
    let mut body = String::new();
    if unasked {
        body.push_str(UNASKED_PREFIX);
        body.push_str(SEPARATOR);
    }
    body.push_str(question);
    if let Some(value) = value.and_then(quotable_value) {
        body.push_str(SEPARATOR);
        body.push('「');
        body.push_str(&value);
        body.push('」');
    }
    body
}

/// The `body` of a tool approval card: 「도구를 실행해도 될까요? · 「name」」.
pub fn tool_request_body(tool_name: &str) -> String {
    question_body(TOOL_QUESTION, Some(tool_name), false)
}

/// The `body` of a work spawn's approval card: 「작업을 시작해도 될까요? · 「codex」」.
pub fn spawn_request_body(tool: &str) -> String {
    question_body(SPAWN_QUESTION, Some(tool), false)
}

/// The `body` of the in-place channel grant card.
pub fn in_place_grant_request_body() -> String {
    question_body(IN_PLACE_GRANT_QUESTION, None, false)
}

/// The `body` of a DM admission card: 「에이전트를 이 대화에 들여도 될까요? · 「코메토」」.
pub fn dm_admission_request_body(agent_display_name: &str) -> String {
    question_body(DM_ADMISSION_QUESTION, Some(agent_display_name), false)
}

/// The `body` of a workspace action's approval card, from the action and the arguments the
/// server validated. `unasked` is the card an agent raised on its own.
///
/// The value is quoted for `channel.create` only (its name, a short validated slug); every other
/// action asks without one — a card that names a person's text, a message or an image says so on
/// the card, which is opened in the app (D6-3: 「값이 길거나 사람의 글이면 본문에 넣지 않는다」).
pub fn action_request_body(
    action: &WorkspaceAction,
    args: Option<&Value>,
    unasked: bool,
) -> String {
    if action.id == ACTION_CHANNEL_CREATE {
        let name = args
            .and_then(|args| args.get("name"))
            .and_then(Value::as_str);
        let private = args
            .and_then(|args| args.get("kind"))
            .and_then(Value::as_str)
            .is_some_and(|kind| kind != "public");
        let question = if private {
            "비공개 채널을 만들어도 될까요?"
        } else {
            action.question
        };
        return question_body(question, name, unasked);
    }
    question_body(phrases_of(action, args).question, None, unasked)
}

/// The phrases of this action, with the profile update read for what it changes — a person
/// decides 「소개를 바꿔도 될까요?」, not 「프로필을…」, when the tagline is all the card touches.
/// Only the **presence** of the keys is read, never a value.
pub fn phrases_of(action: &WorkspaceAction, args: Option<&Value>) -> Phrases {
    if action.id == ACTION_AGENT_PROFILE_UPDATE {
        if let Some(phrases) = profile_update_phrases(args) {
            return phrases;
        }
    }
    Phrases {
        question: action.question,
        done: action.done,
        noun: action.title,
    }
}

/// What a profile update changes, when it changes one thing.
fn profile_update_phrases(args: Option<&Value>) -> Option<Phrases> {
    let keys: Vec<&str> = args?
        .as_object()?
        .keys()
        .map(String::as_str)
        // The target is who, not what.
        .filter(|key| *key != "targetHandle")
        .collect();
    let only = |allowed: &[&str]| !keys.is_empty() && keys.iter().all(|key| allowed.contains(key));
    if only(&["tagline"]) {
        Some(Phrases {
            question: "소개를 바꿔도 될까요?",
            done: "소개를 바꿨어요",
            noun: "소개 바꾸기",
        })
    } else if only(&["statusText", "statusEmoji", "statusExpiresInHours"]) {
        Some(Phrases {
            question: "상태를 바꿔도 될까요?",
            done: "상태를 바꿨어요",
            noun: "상태 바꾸기",
        })
    } else if only(&["roleLabel"]) {
        Some(Phrases {
            question: "역할 이름을 바꿔도 될까요?",
            done: "역할 이름을 바꿨어요",
            noun: "역할 이름 바꾸기",
        })
    } else if only(&["displayName"]) {
        Some(Phrases {
            question: "에이전트 이름을 바꿔도 될까요?",
            done: "에이전트 이름을 바꿨어요",
            noun: "에이전트 이름 바꾸기",
        })
    } else if only(&["avatar"]) {
        Some(Phrases {
            question: "에이전트 사진을 바꿔도 될까요?",
            done: "에이전트 사진을 바꿨어요",
            noun: "에이전트 사진 바꾸기",
        })
    } else {
        None
    }
}

/// What the decision said, for [`receipt_line`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineKind {
    /// This tap approved it.
    Approved,
    /// This tap rejected it.
    Rejected,
    /// It had been approved before this tap.
    AlreadyApproved,
    /// It had been rejected before this tap.
    AlreadyRejected,
}

/// `approval.action_type` of a work spawn (the host picker). Spelled as
/// `momo_t3::work_control::ACTION_TYPE_WORK_SPAWN`, which this crate cannot depend on; a test
/// in `momo-server` pins the two equal.
pub const WORK_SPAWN_ACTION_TYPE: &str = "work.spawn";

/// The noun of an approval this build cannot name.
const UNKNOWN_NOUN: &str = "요청";

/// The one line a decision's receipt carries (ADR-0204 증보 6 D6-4):
///
/// | kind | line |
/// |---|---|
/// | approved | ✓ 소개를 바꿨어요 |
/// | rejected | 소개 바꾸기를 거부했어요 |
/// | already approved / rejected | 이미 승인된(거부된) 요청이에요 · 소개 바꾸기 |
///
/// A tool approval names the tool after it (`· 「name」`) when it is short and plain
/// ([`quotable_value`]). The words of the failure — 「승인하지 못했어요」 — are the device's, not
/// this line's: a refusal carries none.
pub fn receipt_line(action_type: &str, payload: &Value, kind: LineKind) -> String {
    let words = receipt_words(action_type, payload);
    let quoted = words
        .value
        .as_ref()
        .map(|value| format!("{SEPARATOR}「{value}」"))
        .unwrap_or_default();
    // 「이미 승인된 요청이에요 · 소개 바꾸기」 — and nothing after it for a request with no name.
    let named = if words.noun == UNKNOWN_NOUN {
        String::new()
    } else {
        format!("{SEPARATOR}{}", words.noun)
    };
    match kind {
        LineKind::Approved => format!("✓ {}{quoted}", words.done),
        LineKind::Rejected => format!(
            "{}{} 거부했어요{quoted}",
            words.noun,
            particle_for(words.noun, ParticlePair::Object)
        ),
        LineKind::AlreadyApproved => format!("이미 승인된 요청이에요{named}"),
        LineKind::AlreadyRejected => format!("이미 거부된 요청이에요{named}"),
    }
}

struct ReceiptWords {
    done: &'static str,
    noun: &'static str,
    value: Option<String>,
}

/// The words of an approval's payload. A shape this build does not know reads as a plain
/// 「요청」: there is no title to name.
fn receipt_words(action_type: &str, payload: &Value) -> ReceiptWords {
    let unknown = ReceiptWords {
        done: "승인했어요",
        noun: UNKNOWN_NOUN,
        value: None,
    };
    match action_type {
        ACTION_TYPE_WORKSPACE_ACTION => {
            let block = payload.get("action");
            let action = block
                .and_then(|block| block.get("id"))
                .and_then(Value::as_str)
                .and_then(action_by_id);
            match action {
                Some(action) => {
                    let phrases = phrases_of(action, block.and_then(|block| block.get("args")));
                    ReceiptWords {
                        done: phrases.done,
                        noun: phrases.noun,
                        value: None,
                    }
                }
                None => unknown,
            }
        }
        ACTION_TYPE_TOOL_CALL => ReceiptWords {
            done: "승인했어요",
            noun: "도구 실행",
            value: payload
                .get("tool_call")
                .and_then(|call| call.get("name"))
                .and_then(Value::as_str)
                .and_then(quotable_value),
        },
        WORK_SPAWN_ACTION_TYPE => ReceiptWords {
            done: "작업 시작을 승인했어요",
            noun: "작업 시작",
            value: None,
        },
        _ => unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actions::{ACTIONS, ACTION_MESSAGE_PIN};
    use crate::korean::has_final_consonant;
    use serde_json::json;

    /// Every shape of hedge a machine writes when it declines to pick a particle
    /// (`을(를)`, `이(가)`, `은(는)`, `(으)로`…). One of these in a durable `body` is the defect
    /// the default frame exists to avoid.
    const HEDGES: [&str; 8] = [
        "(를)", "(을)", "(가)", "(이)", "(는)", "(은)", "(으)로", "(와)",
    ];

    fn assert_clean(label: &str, sentence: &str) {
        for hedge in HEDGES {
            assert!(
                !sentence.contains(hedge),
                "{label}: a hedged particle in {sentence:?}"
            );
        }
        assert!(
            !sentence.contains("Approval required") && !sentence.contains("승인 요청"),
            "{label}: the English and the old frame are gone: {sentence:?}"
        );
    }

    fn action(id: &str) -> &'static WorkspaceAction {
        action_by_id(id).expect("registered")
    }

    #[test]
    fn a_value_is_quoted_only_when_it_is_short_and_plain() {
        assert_eq!(quotable_value(" qa  team "), Some("qa team".to_string()));
        // Made inert, like every name this server writes into a body: no link can be formed.
        assert_eq!(
            quotable_value("김인턴 [봇]"),
            Some("김인턴 ［봇］".to_string())
        );
        let link = quotable_value("[x](https://evil.example)").expect("short and plain");
        assert!(!link.contains("](") && !link.contains("://"), "{link}");
        assert_eq!(
            quotable_value("a`b").map(|value| value.contains('`')),
            Some(false)
        );
        assert_eq!(
            quotable_value("work.session.end"),
            Some("work.session.end".to_string())
        );
        assert_eq!(
            quotable_value("가".repeat(VALUE_MAX_CHARS).as_str()).map(|v| v.chars().count()),
            Some(VALUE_MAX_CHARS)
        );
        // Too long is left out, not cut.
        assert_eq!(quotable_value(&"가".repeat(VALUE_MAX_CHARS + 1)), None);
        for rejected in [
            "",
            "   ",
            "a\nb",
            "a\u{0007}b",
            "a」b",
            "「a",
            "\u{202E}txt.exe",
            "a\u{200B}b",
            "a\u{2066}b",
        ] {
            assert_eq!(quotable_value(rejected), None, "{rejected:?}");
        }
    }

    /// **D6-3, the proposal.** Each registered action's card says its own question — one
    /// sentence that is a question and quotes nothing — and none of the old frames survives.
    #[test]
    fn every_registered_action_asks_one_clean_question() {
        for action in ACTIONS {
            let body = action_request_body(action, None, false);
            assert_eq!(body, action.question, "{}", action.id);
            assert!(body.ends_with("될까요?"), "{}: {body}", action.id);
            assert!(
                !body.contains(SEPARATOR),
                "{}: no value without a producer's say",
                action.id
            );
            assert_clean(action.id, &body);
            // The compatibility entry point says the same thing.
            assert_eq!(crate::actions::workspace_action_request_body(action), body);
        }
    }

    /// 「소개를 바꿔도 될까요?」 is what the owner sees when the tagline is all that changes
    /// (D6-3's own example); several fields, or an unknown one, stay 「에이전트 프로필」.
    #[test]
    fn a_profile_update_asks_about_what_it_changes() {
        let profile = action(ACTION_AGENT_PROFILE_UPDATE);
        let body = |args: Value| action_request_body(profile, Some(&args), false);
        assert_eq!(
            body(json!({"tagline": "알림 시험"})),
            "소개를 바꿔도 될까요?"
        );
        assert_eq!(
            body(json!({"tagline": "x", "targetHandle": "luna"})),
            "소개를 바꿔도 될까요?"
        );
        assert_eq!(
            body(json!({"statusText": "회의 중", "statusEmoji": "📅"})),
            "상태를 바꿔도 될까요?"
        );
        assert_eq!(
            body(json!({"roleLabel": "리뷰어"})),
            "역할 이름을 바꿔도 될까요?"
        );
        assert_eq!(
            body(json!({"displayName": "새 이름"})),
            "에이전트 이름을 바꿔도 될까요?"
        );
        assert_eq!(
            body(json!({"avatar": null})),
            "에이전트 사진을 바꿔도 될까요?"
        );
        assert_eq!(
            body(json!({"tagline": "x", "statusText": "y"})),
            "에이전트 프로필을 바꿔도 될까요?"
        );
        assert_eq!(body(json!({})), "에이전트 프로필을 바꿔도 될까요?");
        assert_eq!(body(json!("tagline")), "에이전트 프로필을 바꿔도 될까요?");
        // The tagline's own words never reach the sentence: a person's text is not quoted.
        assert!(!body(json!({"tagline": "알림 시험"})).contains("알림 시험"));
    }

    /// The one value a card quotes is a channel's name, **after** the sentence, never inside
    /// it — so an English or numeric ending cannot ask for a particle the server cannot pick.
    #[test]
    fn a_channel_name_is_quoted_after_the_sentence_and_no_particle_follows_it() {
        let create = action(ACTION_CHANNEL_CREATE);
        let body = |name: &str, kind: &str| {
            action_request_body(create, Some(&json!({"name": name, "kind": kind})), false)
        };
        // D6-3's own example.
        assert_eq!(
            body("qa", "private"),
            "비공개 채널을 만들어도 될까요? · 「qa」"
        );
        assert_eq!(body("qa", "public"), "채널을 만들어도 될까요? · 「qa」");
        // Every ending a name can have: a Hangul one with and without a final consonant, ㄹ,
        // Latin, a digit and a symbol. The name is always the last thing in the line.
        for name in [
            "달무리",
            "팀원들",
            "서울",
            "Hermes",
            "grok",
            "team2",
            "v1.2",
            "qa-lab_",
            "🌙",
        ] {
            let line = body(name, "private");
            assert_eq!(line, format!("비공개 채널을 만들어도 될까요? · 「{name}」"));
            assert!(line.ends_with('」'), "{line}");
            assert_clean(name, &line);
        }
        // A name that cannot be quoted is left out; the question stands alone.
        assert_eq!(
            body("가".repeat(VALUE_MAX_CHARS + 1).as_str(), "public"),
            "채널을 만들어도 될까요?"
        );
        assert_eq!(body("a」b", "public"), "채널을 만들어도 될까요?");
        // No arguments at all: the plain question.
        assert_eq!(
            action_request_body(create, None, false),
            "채널을 만들어도 될까요?"
        );
    }

    /// 「먼저 제안 · 」 stands in front of what nobody asked for, whatever the action.
    #[test]
    fn a_proposal_nobody_asked_for_says_so_first() {
        let pin = action(ACTION_MESSAGE_PIN);
        assert_eq!(
            action_request_body(pin, None, true),
            "먼저 제안 · 메시지 하나를 고정해도 될까요?"
        );
        assert_eq!(
            action_request_body(pin, None, false),
            "메시지 하나를 고정해도 될까요?"
        );
        assert_eq!(
            action_request_body(
                action(ACTION_CHANNEL_CREATE),
                Some(&json!({"name": "qa", "kind": "private"})),
                true
            ),
            "먼저 제안 · 비공개 채널을 만들어도 될까요? · 「qa」"
        );
    }

    /// The other card kinds, and the old English / old frame are not among them.
    #[test]
    fn the_tool_spawn_grant_and_admission_cards_ask_one_question_too() {
        assert_eq!(
            tool_request_body("shell"),
            "도구를 실행해도 될까요? · 「shell」"
        );
        assert_eq!(
            tool_request_body("work.session.login_handoff"),
            "도구를 실행해도 될까요? · 「work.session.login_handoff」"
        );
        // A tool name that is not plain is not quoted: the question stands alone.
        assert_eq!(tool_request_body("a\nb"), "도구를 실행해도 될까요?");
        assert_eq!(
            tool_request_body(&"x".repeat(80)),
            "도구를 실행해도 될까요?"
        );
        assert_eq!(
            spawn_request_body("codex"),
            "작업을 시작해도 될까요? · 「codex」"
        );
        assert_eq!(
            in_place_grant_request_body(),
            "이 채널에서 읽고 쓰게 해도 될까요?"
        );
        assert_eq!(
            dm_admission_request_body("코메토"),
            "에이전트를 이 대화에 들여도 될까요? · 「코메토」"
        );
        // The agent's name is a person's choice of words: it is made inert before it is quoted, so
        // a name that spells a markdown link cannot become one in a sentence the server wrote.
        let evil = dm_admission_request_body("[x](https://evil.example)");
        assert_eq!(
            evil,
            "에이전트를 이 대화에 들여도 될까요? · 「［x］(https：//evil.example)」"
        );
        assert!(!evil.contains("](") && !evil.contains("://"), "{evil}");
        for body in [
            tool_request_body("shell"),
            tool_request_body("Hermes"),
            tool_request_body("v2"),
            spawn_request_body("claude"),
            in_place_grant_request_body(),
            dm_admission_request_body("Hermes"),
            GENERIC_QUESTION.to_string(),
        ] {
            assert_clean("card kind", &body);
        }
    }

    fn card(id: &str, args: Value) -> Value {
        json!({"action": {"id": id, "args": args}})
    }

    /// **D6-4, the decision.** The owner's own examples, to the letter — and the same shape
    /// for every registered action.
    #[test]
    fn the_receipt_line_is_the_table_of_the_adr() {
        let tagline = card(ACTION_AGENT_PROFILE_UPDATE, json!({"tagline": "알림 시험"}));
        let line =
            |payload: &Value, kind| receipt_line(ACTION_TYPE_WORKSPACE_ACTION, payload, kind);
        assert_eq!(line(&tagline, LineKind::Approved), "✓ 소개를 바꿨어요");
        assert_eq!(
            line(&tagline, LineKind::Rejected),
            "소개 바꾸기를 거부했어요"
        );
        assert_eq!(
            line(&tagline, LineKind::AlreadyApproved),
            "이미 승인된 요청이에요 · 소개 바꾸기"
        );
        assert_eq!(
            line(&tagline, LineKind::AlreadyRejected),
            "이미 거부된 요청이에요 · 소개 바꾸기"
        );
        for action in ACTIONS {
            let payload = card(action.id, json!({}));
            let approved = line(&payload, LineKind::Approved);
            let rejected = line(&payload, LineKind::Rejected);
            assert!(approved.starts_with("✓ "), "{}: {approved}", action.id);
            assert!(
                rejected.ends_with("을 거부했어요") || rejected.ends_with("를 거부했어요"),
                "{}: {rejected}",
                action.id
            );
            for kind in [
                LineKind::Approved,
                LineKind::Rejected,
                LineKind::AlreadyApproved,
                LineKind::AlreadyRejected,
            ] {
                assert_clean(action.id, &line(&payload, kind));
            }
            // The sentence is the registry's own words, not a second copy.
            assert_eq!(approved, format!("✓ {}", action.done), "{}", action.id);
            assert_eq!(
                rejected,
                format!(
                    "{}{} 거부했어요",
                    action.title,
                    particle_for(action.title, ParticlePair::Object)
                ),
                "{}",
                action.id
            );
        }
    }

    /// The object particle behind a noun is chosen from its last Hangul syllable — and a noun
    /// that did not end in Hangul would hedge, so none may.
    #[test]
    fn every_noun_ends_in_hangul_so_no_particle_is_ever_hedged() {
        let mut nouns: Vec<&str> = ACTIONS.iter().map(|action| action.title).collect();
        nouns.extend([
            "소개 바꾸기",
            "상태 바꾸기",
            "역할 이름 바꾸기",
            "에이전트 이름 바꾸기",
            "에이전트 사진 바꾸기",
            "도구 실행",
            "작업 시작",
            UNKNOWN_NOUN,
        ]);
        for noun in nouns {
            assert!(
                has_final_consonant(noun).is_some(),
                "{noun} does not end in Hangul"
            );
            assert!(
                !particle_for(noun, ParticlePair::Object).contains('('),
                "{noun}"
            );
        }
        // The two ends of the rule, with the real words.
        assert_eq!(particle_for("채널 만들기", ParticlePair::Object), "를");
        assert_eq!(particle_for("메시지 고정", ParticlePair::Object), "을");
    }

    #[test]
    fn a_tool_and_a_spawn_and_an_unknown_shape_have_a_line_too() {
        let tool = json!({"tool_call": {"name": "shell"}});
        let tool_line = |kind| receipt_line(ACTION_TYPE_TOOL_CALL, &tool, kind);
        assert_eq!(tool_line(LineKind::Approved), "✓ 승인했어요 · 「shell」");
        assert_eq!(
            tool_line(LineKind::Rejected),
            "도구 실행을 거부했어요 · 「shell」"
        );
        assert_eq!(
            tool_line(LineKind::AlreadyApproved),
            "이미 승인된 요청이에요 · 도구 실행"
        );
        // A tool name that cannot be quoted is left out of the line.
        let odd = json!({"tool_call": {"name": "a\nb"}});
        assert_eq!(
            receipt_line(ACTION_TYPE_TOOL_CALL, &odd, LineKind::Approved),
            "✓ 승인했어요"
        );
        // A spawn.
        let spawn = json!({});
        assert_eq!(
            receipt_line(WORK_SPAWN_ACTION_TYPE, &spawn, LineKind::Approved),
            "✓ 작업 시작을 승인했어요"
        );
        assert_eq!(
            receipt_line(WORK_SPAWN_ACTION_TYPE, &spawn, LineKind::Rejected),
            "작업 시작을 거부했어요"
        );
        // A shape this build does not know names nothing, and says no more than it knows.
        for payload in [json!({}), card("no.such.action", json!({}))] {
            let unknown = |kind| receipt_line(ACTION_TYPE_WORKSPACE_ACTION, &payload, kind);
            assert_eq!(unknown(LineKind::Approved), "✓ 승인했어요");
            assert_eq!(unknown(LineKind::Rejected), "요청을 거부했어요");
            assert_eq!(unknown(LineKind::AlreadyApproved), "이미 승인된 요청이에요");
            assert_eq!(unknown(LineKind::AlreadyRejected), "이미 거부된 요청이에요");
        }
        assert_eq!(
            receipt_line("deploy", &json!({}), LineKind::Rejected),
            "요청을 거부했어요"
        );
    }

    /// Nothing in a line is built from a person's text: not the card's arguments (a tagline, a
    /// message id, an image), only the registry's words and a tool's name.
    #[test]
    fn a_receipt_line_never_carries_an_argument() {
        let payload = card(
            ACTION_AGENT_PROFILE_UPDATE,
            json!({"tagline": "비밀 소개 문구", "targetHandle": "luna"}),
        );
        for kind in [
            LineKind::Approved,
            LineKind::Rejected,
            LineKind::AlreadyApproved,
            LineKind::AlreadyRejected,
        ] {
            let line = receipt_line(ACTION_TYPE_WORKSPACE_ACTION, &payload, kind);
            assert!(!line.contains("비밀") && !line.contains("luna"), "{line}");
        }
    }
}
