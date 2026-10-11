//! Display-name guard for agent renames — ADR-0186 증보 V4.
//!
//! A display name is a **trust surface**: it is drawn beside every message the
//! member writes, listed in the mention picker and read aloud in the server's
//! voice lines. It is also a **mention target** — `@Display Name` and
//! `<@Display Name>` are mentions (case-sensitive, `read_state::contains_mention`)
//! and `member` is unique only on `handle`. So a name an *agent* proposes for an
//! agent has to be unable to (a) carry markup or a link, (b) be invisible or
//! reorder text, and (c) equal — under any cheap disguise — somebody else's name
//! or handle, which would hijack their mentions.
//!
//! Two layers, because the two callers carry different responsibility:
//!
//! * [`validated_agent_proposed_display_name`] is the **strict** one, used on
//!   the agent-proposal path. Nobody typed the name with a keyboard they own, and
//!   the person approving reads it on a card, so the alphabet is a short
//!   allow-list.
//! * [`conflicts_with_roster`] is the part that is also right for a **human**
//!   rename of an agent (`PATCH …/agents/{agent}`): a person who chooses
//!   「김 인턴 (비서)」 is not blocked, but nobody — human or agent — may take a
//!   name whose [`skeleton`] is another member's.
//!
//! No dependency beyond `unicode-normalization`: the allow-list uses
//! `char::is_alphabetic`/`is_numeric` (letters, digits, and the combining marks
//! Unicode marks Alphabetic), plus explicit combining and emoji ranges. A
//! character class this misses is *refused*, never admitted.

use unicode_normalization::UnicodeNormalization as _;
use uuid::Uuid;

/// The longest name (in characters, after normalisation) an agent may propose.
pub const AGENT_NAME_MAX_CHARS: usize = 32;
/// At most this many emoji, so a name cannot be a row of pictures.
pub const AGENT_NAME_MAX_EMOJI: usize = 2;

/// Names no member may be given by an agent (compared by [`skeleton`]).
pub const RESERVED_NAMES: [&str; 17] = [
    "oort",
    "오르트",
    "admin",
    "administrator",
    "system",
    "시스템",
    "관리자",
    "운영자",
    "보안",
    "security",
    "support",
    "everyone",
    "channel",
    "here",
    "all",
    "모두",
    "전체",
];

/// Why a proposed name was refused. The proposal path folds every variant into
/// one `InvalidArguments`; the variants exist for tests and for the human route,
/// which answers a conflict with 409.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum NameRejected {
    #[error("display name must not be empty")]
    Empty,
    #[error("display name is too long")]
    TooLong,
    #[error("display name uses a character that is not allowed")]
    Disallowed,
    #[error("display name is reserved")]
    Reserved,
    #[error("display name is too close to another member's name or handle")]
    Conflict,
}

/// One other member of the workspace, for the collision check.
#[derive(Debug, Clone, Copy)]
pub struct RosterName<'a> {
    pub member_id: Uuid,
    pub display_name: &'a str,
    pub handle: &'a str,
}

/// Combining marks that `char::is_alphabetic` does not already admit.
fn is_combining_mark(c: char) -> bool {
    matches!(c as u32,
        0x0300..=0x036F | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0x20D0..=0x20FF
        | 0xFE00..=0xFE0F | 0xFE20..=0xFE2F)
}

/// A deliberately **narrow** pictograph set: the Misc Symbols & Pictographs
/// through Symbols & Pictographs Extended-A planes, Misc Symbols and Dingbats,
/// and two common stars. Anything outside is refused as `Disallowed`.
fn is_emoji(c: char) -> bool {
    matches!(c as u32,
        0x1F300..=0x1FAFF | 0x2600..=0x27BF | 0x2B50 | 0x2B55)
}

/// Characters that are `Alphabetic` yet render as nothing.
fn is_invisible_letter(c: char) -> bool {
    matches!(c as u32, 0x115F | 0x1160 | 0x3164 | 0xFFA0)
}

fn is_line_break(c: char) -> bool {
    matches!(
        c,
        '\n' | '\r' | '\u{000B}' | '\u{000C}' | '\u{0085}' | '\u{2028}' | '\u{2029}'
    )
}

/// Normalise and judge a name an **agent** proposes: steps 1–4 and 6 of 증보 V4
/// (the roster collision, step 5, is [`conflicts_with_roster`] because it needs
/// the workspace).
///
/// 1. NFKC, trim, inner whitespace collapsed to one space — but a line break,
///    `Zl` or `Zp` is *refused*, not collapsed;
/// 2. 1..=[`AGENT_NAME_MAX_CHARS`] characters;
/// 3. allow-list: letters, digits, combining marks, a space, `-`, `_`, and at
///    most [`AGENT_NAME_MAX_EMOJI`] emoji — so `@ < > [ ] ( ) : / \ . # & `` ` ``
///    and quotes, i.e. everything that forms a mention, markdown or a URL, cannot
///    appear;
/// 4. no control or format characters (zero-width, bidi) — implied by 3 and
///    asserted again;
/// 6. not a [`RESERVED_NAMES`] entry by skeleton.
pub fn validated_agent_proposed_display_name(raw: &str) -> Result<String, NameRejected> {
    let normalised: String = raw.nfkc().collect();
    if normalised.chars().any(is_line_break) {
        return Err(NameRejected::Disallowed);
    }
    let collapsed = normalised.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return Err(NameRejected::Empty);
    }
    if collapsed.chars().count() > AGENT_NAME_MAX_CHARS {
        return Err(NameRejected::TooLong);
    }
    let mut emoji = 0usize;
    let mut has_letter_or_digit = false;
    for c in collapsed.chars() {
        if c.is_control() || is_invisible_letter(c) {
            return Err(NameRejected::Disallowed);
        }
        if c == ' ' || c == '-' || c == '_' || is_combining_mark(c) {
            continue;
        }
        if is_emoji(c) {
            emoji += 1;
            continue;
        }
        if c.is_alphabetic() || c.is_numeric() {
            has_letter_or_digit = true;
            continue;
        }
        return Err(NameRejected::Disallowed);
    }
    if emoji > AGENT_NAME_MAX_EMOJI || !has_letter_or_digit {
        return Err(NameRejected::Disallowed);
    }
    let name_skeleton = skeleton(&collapsed);
    if RESERVED_NAMES
        .iter()
        .any(|reserved| skeleton(reserved) == name_skeleton)
    {
        return Err(NameRejected::Reserved);
    }
    Ok(collapsed)
}

/// Common Cyrillic and Greek lower-case letters that look like a Latin one.
/// (Lower case only: [`skeleton`] lower-cases first.)
fn confusable(c: char) -> char {
    match c {
        // Cyrillic
        'а' => 'a',
        'е' => 'e',
        'о' => 'o',
        'р' => 'p',
        'с' => 'c',
        'у' => 'y',
        'х' => 'x',
        'і' => 'i',
        'ј' => 'j',
        'ѕ' => 's',
        'ԁ' => 'd',
        'һ' => 'h',
        'к' => 'k',
        'м' => 'm',
        'н' => 'h',
        'т' => 't',
        // Greek
        'α' => 'a',
        'ε' => 'e',
        'ι' => 'i',
        'κ' => 'k',
        'ν' => 'v',
        'ο' => 'o',
        'ρ' => 'p',
        'τ' => 't',
        'υ' => 'u',
        'χ' => 'x',
        other => other,
    }
}

/// The comparison form of a name or handle: NFKD → case-folded → combining marks,
/// whitespace, `-` and `_` removed → common Cyrillic/Greek look-alikes mapped to
/// Latin. Two names with the same skeleton are the same name to a reader.
pub fn skeleton(raw: &str) -> String {
    // NFKD, not NFKC: the precomposed `é` and `e` + U+0301 must reach the same
    // skeleton, and only the decomposed form lets the mark be dropped.
    raw.nfkd()
        .flat_map(char::to_lowercase)
        .filter(|c| !(c.is_whitespace() || *c == '-' || *c == '_' || is_combining_mark(*c)))
        .map(confusable)
        .collect()
}

/// Whether `candidate` collides with any other member's display name or handle
/// (step 5). `target` is the member being renamed: its own current name is not a
/// conflict, so renaming to the same name is a no-op rather than an error.
pub fn conflicts_with_roster(candidate: &str, target: Uuid, roster: &[RosterName<'_>]) -> bool {
    let wanted = skeleton(candidate);
    if wanted.is_empty() {
        return true;
    }
    roster
        .iter()
        .filter(|other| other.member_id != target)
        .any(|other| skeleton(other.display_name) == wanted || skeleton(other.handle) == wanted)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roster() -> Vec<RosterName<'static>> {
        vec![
            RosterName {
                member_id: Uuid::from_u128(1),
                display_name: "Alice Kim",
                handle: "alice",
            },
            RosterName {
                member_id: Uuid::from_u128(2),
                display_name: "김 인턴",
                handle: "intern",
            },
        ]
    }

    #[test]
    fn ordinary_names_pass_and_are_normalised() {
        assert_eq!(
            validated_agent_proposed_display_name("  김   인턴  2 "),
            Ok("김 인턴 2".to_string())
        );
        assert_eq!(
            validated_agent_proposed_display_name("Ｈｅｒｍｅｓ-bot_1"),
            Ok("Hermes-bot_1".to_string())
        );
        assert_eq!(
            validated_agent_proposed_display_name("Helper 🤖"),
            Ok("Helper 🤖".to_string())
        );
    }

    /// ADR-0186 V4 / 1819: every shape that forms a link, mention or markup.
    #[test]
    fn markup_links_and_mentions_cannot_be_a_name() {
        for hostile in [
            "[보안 재인증](https://evil.example)",
            "https://evil.example",
            "evil.example",
            "@Alice Kim",
            "<@Alice Kim>",
            "@everyone",
            "a#b",
            "a&b",
            "a/b",
            "a\\b",
            "a:b",
            "a`b",
            "a'b",
            "a\"b",
            "a(b)",
            "a[b]",
            "<b>bold</b>",
        ] {
            assert_eq!(
                validated_agent_proposed_display_name(hostile),
                Err(NameRejected::Disallowed),
                "{hostile}"
            );
        }
    }

    #[test]
    fn a_tab_is_whitespace_and_collapses() {
        assert_eq!(
            validated_agent_proposed_display_name("tab\there"),
            Ok("tab here".to_string())
        );
    }

    #[test]
    fn invisible_and_reordering_characters_are_refused() {
        for hostile in [
            "Al\u{200B}ice", // zero-width space
            "Al\u{200D}ice", // zero-width joiner
            "Al\u{202E}ice", // right-to-left override
            "Al\u{2066}ice", // isolate
            "a\u{FEFF}b",    // BOM
            "ㅤ",              // hangul filler
            "a\u{3164}b",
            "a\u{2800}b", // braille blank
            "two\nlines",
            "two\r\nlines",
            "para\u{2029}graph",
            "line\u{2028}sep",
        ] {
            assert!(
                validated_agent_proposed_display_name(hostile).is_err(),
                "{hostile:?}"
            );
        }
    }

    #[test]
    fn length_emoji_and_emptiness_are_bounded() {
        assert!(validated_agent_proposed_display_name(&"가".repeat(32)).is_ok());
        assert_eq!(
            validated_agent_proposed_display_name(&"가".repeat(33)),
            Err(NameRejected::TooLong)
        );
        assert!(validated_agent_proposed_display_name("ab 🤖🚀").is_ok());
        assert_eq!(
            validated_agent_proposed_display_name("ab 🤖🚀🎉"),
            Err(NameRejected::Disallowed)
        );
        for empty in ["", "   ", "\u{3000}"] {
            assert_eq!(
                validated_agent_proposed_display_name(empty),
                Err(NameRejected::Empty),
                "{empty:?}"
            );
        }
        // Not a name: no letter or digit at all.
        assert_eq!(
            validated_agent_proposed_display_name("🤖"),
            Err(NameRejected::Disallowed)
        );
        assert_eq!(
            validated_agent_proposed_display_name("- _"),
            Err(NameRejected::Disallowed)
        );
    }

    #[test]
    fn reserved_names_are_refused_under_every_disguise() {
        for reserved in [
            "oort",
            "OORT",
            "Ｏｏｒｔ",
            "오르트",
            "Admin",
            "ａｄｍｉｎ",
            "аdmin", // Cyrillic а
            "Sys-tem",
            "시스템",
            "관리자",
            "Security",
            "Support",
            "everyone",
            "Channel",
            "here",
            "All",
            "모두",
            "전체",
            "o o r t",
        ] {
            assert_eq!(
                validated_agent_proposed_display_name(reserved),
                Err(NameRejected::Reserved),
                "{reserved}"
            );
        }
    }

    #[test]
    fn a_name_that_skeletons_to_another_members_is_a_conflict() {
        let roster = roster();
        let target = Uuid::from_u128(99);
        for hostile in [
            "Alice Kim",
            "alice kim",
            "ALICE KIM",
            "Ａｌｉｃｅ Ｋｉｍ",
            "Alice-Kim",
            "Alice_Kim",
            "A l i c e K i m",
            "Аlice Kim", // Cyrillic А
            "Αlice Κim", // Greek Α, Κ
            "alice",     // another member's HANDLE
            "Alice",
            "김인턴",
            "intern",
            "Álice Kim", // combining acute (precomposed)
            "Ali\u{0301}ce Kim",
        ] {
            assert!(
                conflicts_with_roster(hostile, target, &roster),
                "{hostile:?} must collide"
            );
        }
        for fine in ["Bob", "Alice K", "김 인턴 2", "Alicia Kim"] {
            assert!(!conflicts_with_roster(fine, target, &roster), "{fine}");
        }
    }

    #[test]
    fn your_own_current_name_is_not_a_conflict() {
        let roster = roster();
        // Renaming member 1 to its own name: a no-op, not a collision.
        assert!(!conflicts_with_roster(
            "Alice Kim",
            Uuid::from_u128(1),
            &roster
        ));
        // …but it still collides for anybody else.
        assert!(conflicts_with_roster(
            "Alice Kim",
            Uuid::from_u128(2),
            &roster
        ));
    }

    #[test]
    fn a_name_that_skeletons_to_nothing_collides() {
        assert!(conflicts_with_roster(
            "- _ -",
            Uuid::from_u128(9),
            &roster()
        ));
    }
}
