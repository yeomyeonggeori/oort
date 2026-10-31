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
//! What a person decides on a banner, when it is short and plain: a channel's name, the app being
//! installed, a tool's name, an agent's display name, and the one short text a profile change
//! carries (the tagline, the status, the role label) — in one line, never inside the sentence
//! ([`quotable_value`]). Without it the banner would ask 「소개를 바꿔도 될까요?」 and leave the
//! approver to approve a text nobody showed them. A message, a rationale, an image and anything
//! long are never quoted: the card is where those are read in full (D6-3: 「값이 길거나 사람의
//! 글이면 본문에 넣지 않는다」).
//!
//! ## What the sentence says when it cannot show
//!
//! A card the lock screen may decide ([`crate::actions::decision_mode`] answers `inline`) is
//! decided from this sentence alone, and that answer never reads a value. So a value that was
//! meant to be quoted and was not — too long, more than one line, anything that hides or
//! reorders text — is **said to be left out**: 「· 앱에서 확인」 ([`IN_APP_NOTE`]) follows the
//! question, instead of a question that reads as if there were nothing more to see. And a
//! profile or rename card that names an agent other than the proposer (`targetHandle`) names
//! it too, after the value: 「· 대상 에이전트 「luna」」 ([`TARGET_LABEL`]) — the push's title is
//! the agent that proposed it, and without the target the question reads as being about that
//! agent itself.

use serde_json::Value;

use crate::actions::{
    action_by_id, plugin_install_label, WorkspaceAction, ACTION_AGENT_PROFILE_UPDATE,
    ACTION_AGENT_RENAME, ACTION_CHANNEL_CREATE, ACTION_CHANNEL_MEMBER_ADD, ACTION_PLUGIN_INSTALL,
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
/// Said after the question when a value it was meant to quote could not be shown (see the
/// module docs): the text is in the app, not in this sentence.
pub const IN_APP_NOTE: &str = "앱에서 확인";
/// In front of the agent a profile or rename card is about, when it is not the proposer. Spelled
/// as the card's own row label (`agent_rename_rows`).
pub const TARGET_LABEL: &str = "대상 에이전트";

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
/// could draw something else — no control or direction-changing character, no hidden or
/// blank-drawing character ([`is_hidden_char`]), no bracket of the quote itself, no long stack of
/// combining marks. `None` when it has to be left out.
///
/// The whole value is left out, not tidied: a value that had such a character in it is not the
/// value a person would read. (The link preview drops direction controls from the title of a page
/// because what it stores is what it shows, ADR-0170 증보 D13; this sentence quotes a value that
/// is kept elsewhere exactly as written.)
///
/// What is quoted is also made **inert** ([`inert_display_name`], the way the hosted notice
/// lines and the in-place card's body already name an agent): a `body` is parsed as markdown by
/// the clients, so a name that spells `[label](https://…)` must not be able to become a link in
/// a sentence this server wrote. An ordinary name is unchanged.
pub fn quotable_value(raw: &str) -> Option<String> {
    // Judged on the raw text: a line break or a tab is not tidied into a space — a value that
    // had one is not the value a person would read, so it is left out.
    let mut marks_in_a_row = 0usize;
    let mut previous: Option<char> = None;
    for c in raw.chars() {
        if is_hidden_char(c) || matches!(c, '「' | '」' | '『' | '』') {
            return None;
        }
        // The presentation selector of an emoji (❤️ is ❤ and U+FE0F) is part of what is drawn
        // — right behind a pictograph, once. Anywhere else it draws nothing.
        if matches!(c, '\u{FE0E}' | '\u{FE0F}') && !previous.is_some_and(is_pictograph) {
            return None;
        }
        if is_combining_mark(c) {
            marks_in_a_row += 1;
            if marks_in_a_row > MAX_COMBINING_RUN {
                return None;
            }
        } else {
            marks_in_a_row = 0;
        }
        previous = Some(c);
    }
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() || collapsed.chars().count() > VALUE_MAX_CHARS {
        return None;
    }
    Some(inert_display_name(&collapsed))
}

/// The most combining marks a quoted value may stack in a row — the limit a proposed name
/// carries (`momo_messaging::name_guard`). More is not text but noise drawn over its neighbours.
const MAX_COMBINING_RUN: usize = 2;

/// The pictographs an emoji presentation selector may follow — the narrow set a proposed status
/// emoji is made of (`momo_messaging::name_guard`'s `is_emoji`).
fn is_pictograph(c: char) -> bool {
    matches!(c as u32, 0x1F300..=0x1FAFF | 0x2600..=0x27BF | 0x2B50 | 0x2B55)
}

/// The combining-mark blocks a stack of marks is made of.
fn is_combining_mark(c: char) -> bool {
    matches!(c as u32,
        0x0300..=0x036F | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0x20D0..=0x20FF | 0xFE20..=0xFE2F)
}

/// A character that draws nothing, or draws something other than itself, and so cannot stand in
/// a value a person is asked to approve from a banner:
///
/// * a control character, and the line and paragraph separators;
/// * the zero-width and direction marks (U+200B–U+200F) and the embedding, override and isolate
///   controls (U+202A–U+202E, U+2066–U+2069 — the nine the link preview drops, ADR-0170 증보
///   D13), the word joiner and the other invisible operators (U+2060–U+206F), and the format
///   characters of other scripts (soft hyphen, Arabic and Syriac marks, the Mongolian
///   separator, shorthand and musical controls, the byte order mark);
/// * the characters that fill a space with nothing: the Hangul fillers, the Khmer inherent
///   vowels, the combining grapheme joiner and the braille blank;
/// * variation selectors (but for the emoji presentation selector right behind a pictograph,
///   which [`quotable_value`] lets through), tag characters, the specials block (annotation
///   marks, the object replacement and replacement characters), private use, and
///   noncharacters.
///
/// Spelled out as ranges: `char` has no general category. `momo-agent` has no normal dependency
/// on `momo-messaging`, whose `name_guard::has_invisible_or_control_characters` is the nearest
/// list; the unit test `every_character_name_guard_calls_hidden_is_left_out_here_too` walks all
/// of Unicode against it, so the two cannot drift apart without a red test.
fn is_hidden_char(c: char) -> bool {
    let code = c as u32;
    c.is_control()
        // The last two code points of every plane are noncharacters.
        || code & 0xFFFE == 0xFFFE
        || matches!(code,
            0x00AD // soft hyphen
            | 0x034F // combining grapheme joiner
            | 0x0600..=0x0605 | 0x061C | 0x06DD | 0x070F | 0x0890..=0x0891 | 0x08E2 // Arabic, Syriac
            | 0x115F..=0x1160 // Hangul choseong and jungseong fillers
            | 0x17B4..=0x17B5 // Khmer inherent vowels
            | 0x180B..=0x180F // Mongolian selectors and vowel separator
            | 0x200B..=0x200F // zero-width and direction marks
            | 0x2028..=0x202E // separators, embeddings and overrides
            | 0x2060..=0x206F // word joiner, invisible operators, isolates
            | 0x2800 // braille blank
            | 0x3164 // Hangul filler
            | 0xFDD0..=0xFDEF // noncharacters
            | 0xFE00..=0xFE0D // variation selectors (the emoji ones, FE0E and FE0F, see `quotable_value`)
            | 0xFEFF // byte order mark
            | 0xFFA0 // halfwidth Hangul filler
            | 0xFFF0..=0xFFFF // specials
            | 0x110BD | 0x110CD // Kaithi format characters
            | 0x13430..=0x1343F // Egyptian hieroglyph format controls
            | 0x1BCA0..=0x1BCA3 // shorthand format controls
            | 0x1D173..=0x1D17A // musical format controls
            | 0xE000..=0xF8FF // private use
            | 0xE0000..=0xE0FFF // tags, variation selectors supplement
            | 0xF0000..=0x10FFFF // private use planes
        )
}

/// `question`, or `question · 「value」`, behind 「먼저 제안 · 」 when nobody asked. A value that
/// was given and cannot be shown ([`quotable_value`]) is said to be left out
/// ([`IN_APP_NOTE`]); `None` — nothing to quote — adds nothing.
pub fn question_body(question: &str, value: Option<&str>, unasked: bool) -> String {
    question_body_about(question, value, None, unasked)
}

/// [`question_body`], with the agent the card is about named after the value when it is not
/// the proposer: `question · 「value」 · 대상 에이전트 「handle」`. Whatever was given and could
/// not be shown — the value or the handle — is said to be left out, once, at the end.
fn question_body_about(
    question: &str,
    value: Option<&str>,
    target: Option<&str>,
    unasked: bool,
) -> String {
    let mut body = String::new();
    if unasked {
        body.push_str(UNASKED_PREFIX);
        body.push_str(SEPARATOR);
    }
    body.push_str(question);
    let mut left_out = false;
    if let Some(raw) = value {
        match quotable_value(raw) {
            Some(value) => {
                body.push_str(SEPARATOR);
                body.push('「');
                body.push_str(&value);
                body.push('」');
            }
            None => left_out = true,
        }
    }
    if let Some(raw) = target {
        match quotable_value(raw) {
            Some(handle) => {
                body.push_str(SEPARATOR);
                body.push_str(TARGET_LABEL);
                body.push_str(" 「");
                body.push_str(&handle);
                body.push('」');
            }
            None => left_out = true,
        }
    }
    if left_out {
        body.push_str(SEPARATOR);
        body.push_str(IN_APP_NOTE);
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
/// A value is quoted after the question where it is what the approver decides and it is short
/// and plain ([`quoted_value`]): the channel a `channel.create` makes (and 「비공개 채널을」 for a
/// private one), the channel members are added to, the app being installed, the tagline, status
/// or role label of a profile change. Every other action asks without one.
pub fn action_request_body(
    action: &WorkspaceAction,
    args: Option<&Value>,
    unasked: bool,
) -> String {
    let private = action.id == ACTION_CHANNEL_CREATE
        && args
            .and_then(|args| args.get("kind"))
            .and_then(Value::as_str)
            .is_some_and(|kind| kind != "public");
    let question = if private {
        "비공개 채널을 만들어도 될까요?"
    } else {
        phrases_of(action, args).question
    };
    question_body_about(
        question,
        quoted_value(action, args),
        target_handle(action, args),
        unasked,
    )
}

/// The agent a profile or rename card is about, when the proposer named one (`targetHandle`;
/// absent or `null` means the proposer itself). The handle the server validated, never a name.
fn target_handle<'a>(action: &WorkspaceAction, args: Option<&'a Value>) -> Option<&'a str> {
    match action.id {
        ACTION_AGENT_PROFILE_UPDATE | ACTION_AGENT_RENAME => args?
            .get("targetHandle")
            .and_then(Value::as_str)
            .filter(|handle| !handle.trim().is_empty()),
        _ => None,
    }
}

/// The raw text a request card may quote for this action ([`question_body`] makes it safe).
fn quoted_value<'a>(action: &WorkspaceAction, args: Option<&'a Value>) -> Option<&'a str> {
    let text = |key: &str| args.and_then(|args| args.get(key)).and_then(Value::as_str);
    match action.id {
        ACTION_CHANNEL_CREATE => text("name"),
        ACTION_CHANNEL_MEMBER_ADD => text("channel"),
        // The official name of the app, never the id the model wrote. An id this build does not
        // list gives no name — `""` is given, so the sentence says it left the app out.
        ACTION_PLUGIN_INSTALL => text("pluginId").map(|id| plugin_install_label(id).unwrap_or("")),
        ACTION_AGENT_PROFILE_UPDATE => ProfileChange::of(args)?.quoted_key().and_then(text),
        _ => None,
    }
}

/// The phrases of this action, with the profile update read for what it changes — a person
/// decides 「소개를 바꿔도 될까요?」, not 「프로필을…」, when the tagline is all the card touches.
/// Only the **presence** of the keys is read, never a value.
pub fn phrases_of(action: &WorkspaceAction, args: Option<&Value>) -> Phrases {
    if action.id == ACTION_AGENT_PROFILE_UPDATE {
        if let Some(change) = ProfileChange::of(args) {
            return change.phrases();
        }
    }
    Phrases {
        question: action.question,
        done: action.done,
        noun: action.title,
    }
}

/// What a profile update changes, when it changes one thing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProfileChange {
    Tagline,
    Status,
    RoleLabel,
    DisplayName,
    Avatar,
}

impl ProfileChange {
    /// Read from the **presence** of the arguments' keys, never a value. `None` when the update
    /// changes several things, or something this reader does not know.
    fn of(args: Option<&Value>) -> Option<ProfileChange> {
        let keys: Vec<&str> = args?
            .as_object()?
            .keys()
            .map(String::as_str)
            // The target is who, not what.
            .filter(|key| *key != "targetHandle")
            .collect();
        let only =
            |allowed: &[&str]| !keys.is_empty() && keys.iter().all(|key| allowed.contains(key));
        if only(&["tagline"]) {
            Some(ProfileChange::Tagline)
        } else if only(&["statusText", "statusEmoji", "statusExpiresInHours"]) {
            Some(ProfileChange::Status)
        } else if only(&["roleLabel"]) {
            Some(ProfileChange::RoleLabel)
        } else if only(&["displayName"]) {
            Some(ProfileChange::DisplayName)
        } else if only(&["avatar"]) {
            Some(ProfileChange::Avatar)
        } else {
            None
        }
    }

    fn phrases(self) -> Phrases {
        match self {
            ProfileChange::Tagline => Phrases {
                question: "소개를 바꿔도 될까요?",
                done: "소개를 바꿨어요",
                noun: "소개 바꾸기",
            },
            ProfileChange::Status => Phrases {
                question: "상태를 바꿔도 될까요?",
                done: "상태를 바꿨어요",
                noun: "상태 바꾸기",
            },
            ProfileChange::RoleLabel => Phrases {
                question: "역할 이름을 바꿔도 될까요?",
                done: "역할 이름을 바꿨어요",
                noun: "역할 이름 바꾸기",
            },
            ProfileChange::DisplayName => Phrases {
                question: "에이전트 이름을 바꿔도 될까요?",
                done: "에이전트 이름을 바꿨어요",
                noun: "에이전트 이름 바꾸기",
            },
            ProfileChange::Avatar => Phrases {
                question: "에이전트 사진을 바꿔도 될까요?",
                done: "에이전트 사진을 바꿨어요",
                noun: "에이전트 사진 바꾸기",
            },
        }
    }

    /// The argument whose short text the question may quote — what a banner decides. The name
    /// and the picture are decided in the app, beside their old ones, so they quote nothing.
    fn quoted_key(self) -> Option<&'static str> {
        match self {
            ProfileChange::Tagline => Some("tagline"),
            ProfileChange::Status => Some("statusText"),
            ProfileChange::RoleLabel => Some("roleLabel"),
            ProfileChange::DisplayName | ProfileChange::Avatar => None,
        }
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

    /// 「소개를 바꿔도 될까요? · 「알림 시험」」 is D6-3's own example: the tagline is all that
    /// changes, and a banner that is decided there shows the text being approved. Several fields,
    /// or an unknown one, stay 「에이전트 프로필」 with nothing quoted.
    #[test]
    fn a_profile_update_asks_about_what_it_changes_and_quotes_its_short_text() {
        let profile = action(ACTION_AGENT_PROFILE_UPDATE);
        let body = |args: Value| action_request_body(profile, Some(&args), false);
        assert_eq!(
            body(json!({"tagline": "알림 시험"})),
            "소개를 바꿔도 될까요? · 「알림 시험」"
        );
        // Another agent's profile names that agent after the text (the sentence's own test:
        // `a_card_about_another_agent_names_it_after_the_value`).
        assert_eq!(
            body(json!({"tagline": "x", "targetHandle": "luna"})),
            "소개를 바꿔도 될까요? · 「x」 · 대상 에이전트 「luna」"
        );
        assert_eq!(
            body(json!({"statusText": "회의 중", "statusEmoji": "📅"})),
            "상태를 바꿔도 될까요? · 「회의 중」"
        );
        assert_eq!(
            body(json!({"roleLabel": "리뷰어"})),
            "역할 이름을 바꿔도 될까요? · 「리뷰어」"
        );
        // The name and the picture are decided in the app beside their old ones: nothing quoted.
        assert_eq!(
            body(json!({"displayName": "새 이름"})),
            "에이전트 이름을 바꿔도 될까요?"
        );
        assert_eq!(
            body(json!({"avatar": null})),
            "에이전트 사진을 바꿔도 될까요?"
        );
        // Several things at once, none, or not an object: the general question, nothing quoted.
        for args in [
            json!({"tagline": "x", "statusText": "y"}),
            json!({}),
            json!("tagline"),
        ] {
            assert_eq!(body(args), "에이전트 프로필을 바꿔도 될까요?");
        }
        // An English or numeric ending asks for no particle: the text is quoted after the sentence.
        for text in ["Hello", "v2", "ready!", "7"] {
            let line = body(json!({"tagline": text}));
            assert_eq!(line, format!("소개를 바꿔도 될까요? · 「{text}」"));
            assert_clean(text, &line);
        }
        // Not short, not one line, or no text: left out — and the sentence says it was
        // (`a_value_that_cannot_be_shown_says_so_in_the_sentence` has the rest of the rows).
        let long = "가".repeat(VALUE_MAX_CHARS + 1);
        for text in [long.as_str(), "두 줄\n입니다", "닫는」괄호", ""] {
            assert_eq!(
                body(json!({"tagline": text})),
                "소개를 바꿔도 될까요? · 앱에서 확인",
                "{text:?}"
            );
        }
        // Made inert: a tagline that spells a link cannot become one.
        let link = body(json!({"tagline": "[x](https://evil.example)"}));
        assert!(!link.contains("](") && !link.contains("://"), "{link}");
    }

    /// The other two actions a banner decides that have one short thing to say: which channel
    /// the members join, and which app is installed (by its official name, never the id).
    #[test]
    fn a_member_add_names_its_channel_and_an_install_its_app() {
        let add = action(ACTION_CHANNEL_MEMBER_ADD);
        assert_eq!(
            action_request_body(
                add,
                Some(&json!({"channel": "design", "memberHandles": ["luna"]})),
                false
            ),
            "채널에 멤버를 추가해도 될까요? · 「design」"
        );
        let install = action(ACTION_PLUGIN_INSTALL);
        assert_eq!(
            action_request_body(
                install,
                Some(&json!({"pluginId": "com.momo.plugins.github"})),
                false
            ),
            "앱을 설치해도 될까요? · 「GitHub」"
        );
        // An id this build does not list names no app, and the id itself is not quoted: the
        // sentence says the app was left out.
        assert_eq!(
            action_request_body(install, Some(&json!({"pluginId": "evil.example"})), false),
            "앱을 설치해도 될까요? · 앱에서 확인"
        );
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
        // A name that cannot be quoted is left out, and the sentence says so.
        assert_eq!(
            body("가".repeat(VALUE_MAX_CHARS + 1).as_str(), "public"),
            "채널을 만들어도 될까요? · 앱에서 확인"
        );
        assert_eq!(
            body("a」b", "public"),
            "채널을 만들어도 될까요? · 앱에서 확인"
        );
        // No arguments at all: nothing was given, so the plain question.
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
        // A tool name that is not plain is not quoted, and the sentence says so.
        assert_eq!(
            tool_request_body("a\nb"),
            "도구를 실행해도 될까요? · 앱에서 확인"
        );
        assert_eq!(
            tool_request_body(&"x".repeat(80)),
            "도구를 실행해도 될까요? · 앱에서 확인"
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

    /// A character that draws nothing, or draws something other than itself, is never inside a
    /// quoted value — whichever of the kinds it is. Each row is one character from one kind
    /// ([`is_hidden_char`]): inside a value, in front of one, and repeated alone to the length
    /// limit.
    #[test]
    fn a_value_with_a_hidden_character_is_left_out() {
        let hidden: [(&str, char); 45] = [
            ("soft hyphen", '\u{00AD}'),
            ("combining grapheme joiner", '\u{034F}'),
            ("arabic letter mark", '\u{061C}'),
            ("hangul choseong filler", '\u{115F}'),
            ("hangul jungseong filler", '\u{1160}'),
            ("khmer inherent vowel", '\u{17B4}'),
            ("mongolian selector", '\u{180B}'),
            ("mongolian vowel separator", '\u{180E}'),
            ("zero width space", '\u{200B}'),
            ("zero width non-joiner", '\u{200C}'),
            ("zero width joiner", '\u{200D}'),
            ("left-to-right mark", '\u{200E}'),
            ("right-to-left mark", '\u{200F}'),
            ("line separator", '\u{2028}'),
            ("paragraph separator", '\u{2029}'),
            // The nine the link preview drops (ADR-0170 증보 D13).
            ("left-to-right embedding", '\u{202A}'),
            ("right-to-left embedding", '\u{202B}'),
            ("pop directional formatting", '\u{202C}'),
            ("left-to-right override", '\u{202D}'),
            ("right-to-left override", '\u{202E}'),
            ("left-to-right isolate", '\u{2066}'),
            ("right-to-left isolate", '\u{2067}'),
            ("first strong isolate", '\u{2068}'),
            ("pop directional isolate", '\u{2069}'),
            ("word joiner", '\u{2060}'),
            ("invisible separator", '\u{2063}'),
            ("braille blank", '\u{2800}'),
            ("hangul filler", '\u{3164}'),
            ("halfwidth hangul filler", '\u{FFA0}'),
            ("variation selector", '\u{FE0F}'),
            ("ideographic variation selector", '\u{FE00}'),
            ("variation selector supplement", '\u{E0100}'),
            ("byte order mark", '\u{FEFF}'),
            ("annotation anchor", '\u{FFF9}'),
            ("object replacement", '\u{FFFC}'),
            ("replacement character", '\u{FFFD}'),
            ("language tag", '\u{E0001}'),
            ("tag space", '\u{E0020}'),
            ("cancel tag", '\u{E007F}'),
            ("private use", '\u{E000}'),
            ("plane 15 private use", '\u{F0000}'),
            ("noncharacter", '\u{FDD0}'),
            ("plane 1 noncharacter", '\u{1FFFE}'),
            ("musical format", '\u{1D173}'),
            ("control", '\u{0007}'),
        ];
        for (label, c) in hidden {
            assert_eq!(quotable_value(&format!("a{c}b")), None, "{label}: inside");
            assert_eq!(quotable_value(&format!("{c}ab")), None, "{label}: in front");
            assert_eq!(
                quotable_value(&c.to_string().repeat(VALUE_MAX_CHARS)),
                None,
                "{label}: alone, thirty times"
            );
        }
        // The emoji presentation selector is drawn with its pictograph — once, right behind it,
        // and nowhere else.
        for text in [
            "❤\u{FE0F}",
            "팀 ☀\u{FE0F} 화이팅",
            "🌙\u{FE0E}",
            "✈\u{FE0F} 출장",
        ] {
            assert!(quotable_value(text).is_some(), "{text:?}");
        }
        for text in [
            "❤\u{FE0F}\u{FE0F}",
            "\u{FE0F}❤",
            "a\u{FE0F}",
            "❤ \u{FE0F}",
            "❤\u{FE00}",
            "\u{FE0F}",
        ] {
            assert_eq!(quotable_value(text), None, "{text:?}");
        }
        // A stack of combining marks is noise, two are an accent.
        assert_eq!(quotable_value("a\u{0300}\u{0301}\u{0302}"), None);
        assert_eq!(quotable_value(&format!("a{}", "\u{0301}".repeat(12))), None);
        assert!(quotable_value("a\u{0300}\u{0301}").is_some());
        assert!(quotable_value("e\u{0301} e\u{0301}\u{0323}").is_some());
        // Plain text of any script is still quoted — including the letters of a right-to-left
        // script, which are not direction controls.
        for text in [
            "달무리",
            "Hermes",
            "v1.2",
            "qa-lab_",
            "🌙",
            "مرحبا",
            "日本語",
            "회의 중 · 점검",
            "a — b…",
        ] {
            assert!(quotable_value(text).is_some(), "{text:?}");
        }
    }

    /// `momo-agent` has no normal dependency on `momo-messaging`, whose `name_guard` already
    /// judges what a person-facing name may not carry (`has_invisible_or_control_characters`).
    /// Every character that list calls hidden is left out of a quoted value here too, over all
    /// of Unicode — so the two lists cannot drift apart without this going red.
    #[test]
    fn every_character_name_guard_calls_hidden_is_left_out_here_too() {
        use momo_messaging::name_guard::has_invisible_or_control_characters;
        let mut checked = 0usize;
        for code in 0..=0x10FFFFu32 {
            let Some(c) = char::from_u32(code) else {
                continue;
            };
            if has_invisible_or_control_characters(&c.to_string()) {
                checked += 1;
                assert_eq!(quotable_value(&format!("a{c}b")), None, "U+{code:04X}");
            }
        }
        // The walk found the list (controls, tags, selectors, the format characters).
        assert!(checked > 400, "only {checked} characters were judged");
    }

    /// **D6-3, a value left out.** A card the lock screen may decide is decided from its sentence,
    /// and the decision word never reads a value; so when the text it was meant to quote cannot
    /// be shown — too long, more than one line, a bracket of the quote, hidden characters — the
    /// sentence says 「앱에서 확인」 instead of reading as if there were nothing more to see.
    #[test]
    fn a_value_that_cannot_be_shown_says_so_in_the_sentence() {
        let profile = action(ACTION_AGENT_PROFILE_UPDATE);
        let with = |key: &str, text: &str| {
            let mut args = serde_json::Map::new();
            args.insert(key.to_string(), json!(text));
            action_request_body(profile, Some(&Value::Object(args)), false)
        };
        let long = "가".repeat(VALUE_MAX_CHARS + 1);
        let only_hidden = "\u{3164}".repeat(VALUE_MAX_CHARS);
        let hidden_inside = "회의\u{2800}중";
        for (key, question) in [
            ("tagline", "소개를 바꿔도 될까요?"),
            ("statusText", "상태를 바꿔도 될까요?"),
            ("roleLabel", "역할 이름을 바꿔도 될까요?"),
        ] {
            for text in [
                long.as_str(),
                "두 줄\n입니다",
                "닫는」괄호",
                only_hidden.as_str(),
                hidden_inside,
            ] {
                let line = with(key, text);
                assert_eq!(line, format!("{question} · 앱에서 확인"), "{key}: {text:?}");
                assert_clean(key, &line);
            }
            // Something that can be shown is shown, and no note follows it.
            assert_eq!(
                with(key, "알림 시험"),
                format!("{question} · 「알림 시험」"),
                "{key}"
            );
        }
        // Nothing given — a cleared field, no arguments — leaves nothing out.
        assert_eq!(
            action_request_body(profile, Some(&json!({"tagline": null})), false),
            "소개를 바꿔도 될까요?"
        );
        assert_eq!(action_request_body(profile, None, false), profile.question);
        // The note stays at the back, behind 「먼저 제안 · 」 at the front.
        assert_eq!(
            action_request_body(profile, Some(&json!({"tagline": long})), true),
            "먼저 제안 · 소개를 바꿔도 될까요? · 앱에서 확인"
        );
        // The other quoting cards say it the same way.
        assert_eq!(
            dm_admission_request_body(&"가".repeat(VALUE_MAX_CHARS + 2)),
            "에이전트를 이 대화에 들여도 될까요? · 앱에서 확인"
        );
        assert_eq!(
            spawn_request_body("a\u{2800}b"),
            "작업을 시작해도 될까요? · 앱에서 확인"
        );
        // A card with no value to quote (the in-place grant) has nothing to leave out.
        assert_eq!(
            in_place_grant_request_body(),
            "이 채널에서 읽고 쓰게 해도 될까요?"
        );
    }

    /// **D6-3, the target.** A profile or rename card about another agent says which one, after
    /// the value — the push's title is the agent that proposed it, so without the target the
    /// question reads as being about that agent itself. The handle is the validated one; a value
    /// is never put inside the sentence, so no particle follows it.
    #[test]
    fn a_card_about_another_agent_names_it_after_the_value() {
        let profile = action(ACTION_AGENT_PROFILE_UPDATE);
        let rename = action(ACTION_AGENT_RENAME);
        let about = |action: &WorkspaceAction, args: Value| {
            let line = action_request_body(action, Some(&args), false);
            assert_clean(action.id, &line);
            line
        };
        assert_eq!(
            about(profile, json!({"tagline": "x", "targetHandle": "luna"})),
            "소개를 바꿔도 될까요? · 「x」 · 대상 에이전트 「luna」"
        );
        assert_eq!(
            about(
                profile,
                json!({"statusText": "회의 중", "targetHandle": "luna"})
            ),
            "상태를 바꿔도 될까요? · 「회의 중」 · 대상 에이전트 「luna」"
        );
        assert_eq!(
            about(profile, json!({"avatar": null, "targetHandle": "luna"})),
            "에이전트 사진을 바꿔도 될까요? · 대상 에이전트 「luna」"
        );
        assert_eq!(
            about(
                profile,
                json!({"displayName": "새 이름", "targetHandle": "luna"})
            ),
            "에이전트 이름을 바꿔도 될까요? · 대상 에이전트 「luna」"
        );
        assert_eq!(
            about(
                profile,
                json!({"tagline": "x", "roleLabel": "y", "targetHandle": "luna"})
            ),
            "에이전트 프로필을 바꿔도 될까요? · 대상 에이전트 「luna」"
        );
        assert_eq!(
            about(
                rename,
                json!({"displayName": "새 이름", "targetHandle": "luna"})
            ),
            "에이전트 이름을 바꿔도 될까요? · 대상 에이전트 「luna」"
        );
        // The proposer itself: no handle, or `null` (a rename is stored with `null`).
        for args in [
            json!({"displayName": "새 이름"}),
            json!({"displayName": "새 이름", "targetHandle": null}),
        ] {
            assert_eq!(about(rename, args), "에이전트 이름을 바꿔도 될까요?");
        }
        assert_eq!(
            about(profile, json!({"tagline": "x", "targetHandle": null})),
            "소개를 바꿔도 될까요? · 「x」"
        );
        // Behind 「먼저 제안 · 」, and a value left out and a target make one note, at the back.
        assert_eq!(
            action_request_body(
                profile,
                Some(&json!({"tagline": "x", "targetHandle": "luna"})),
                true
            ),
            "먼저 제안 · 소개를 바꿔도 될까요? · 「x」 · 대상 에이전트 「luna」"
        );
        let long = "가".repeat(VALUE_MAX_CHARS + 1);
        assert_eq!(
            about(profile, json!({"tagline": long, "targetHandle": "luna"})),
            "소개를 바꿔도 될까요? · 대상 에이전트 「luna」 · 앱에서 확인"
        );
        // A handle that cannot be shown is left out the same way.
        assert_eq!(
            about(profile, json!({"tagline": "x", "targetHandle": long})),
            "소개를 바꿔도 될까요? · 「x」 · 앱에서 확인"
        );
        // Only these two actions have a target: a stray key on another is nothing.
        assert_eq!(
            about(
                action(ACTION_CHANNEL_CREATE),
                json!({"name": "qa", "kind": "public", "targetHandle": "luna"})
            ),
            "채널을 만들어도 될까요? · 「qa」"
        );
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
