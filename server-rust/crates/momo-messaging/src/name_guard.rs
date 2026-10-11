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
///
/// The long, distinctive ones are refused anywhere inside a name
/// (`Oort Support`, `AdminBot`, `🔒Security`); the short, ordinary words
/// ([`RESERVED_WHOLE_WORDS`]) only when they are a whole word, so `Allie` and
/// `Archery` are not collateral.
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

/// The reserved words that are also everyday words: refused only as a whole
/// word of the name (by skeleton), not as a substring.
const RESERVED_WHOLE_WORDS: [&str; 5] = ["here", "all", "모두", "전체", "channel"];

/// Further words an agent may not wear (substring, by skeleton).
const RESERVED_EXTRA: [&str; 4] = ["owner", "moderator", "staff", "official"];

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
    // One word may not mix Latin, Cyrillic and Greek letters: that is how a
    // look-alike is built, and no honest name needs it.
    if collapsed.split(' ').any(mixes_confusable_scripts) {
        return Err(NameRejected::Disallowed);
    }
    // Combining marks: at most two in a row, and never the combining grapheme
    // joiner or a stray variation selector (zalgo, invisible padding).
    let mut run = 0usize;
    let mut previous_emoji = false;
    for c in collapsed.chars() {
        if is_combining_mark(c) {
            run += 1;
            let ok_selector = c == '\u{FE0F}' && previous_emoji;
            if run > 2
                || c == '\u{034F}'
                || ((0xFE00..=0xFE0F).contains(&(c as u32)) && !ok_selector)
            {
                return Err(NameRejected::Disallowed);
            }
        } else {
            run = 0;
        }
        previous_emoji = is_emoji(c);
    }
    let name_skeleton = skeleton(&collapsed);
    let reserved_hit = RESERVED_NAMES
        .iter()
        .filter(|reserved| !RESERVED_WHOLE_WORDS.contains(reserved))
        .chain(RESERVED_EXTRA.iter())
        .any(|reserved| name_skeleton.contains(&skeleton(reserved)))
        || collapsed.split(' ').any(|word| {
            RESERVED_WHOLE_WORDS
                .iter()
                .any(|reserved| skeleton(word) == skeleton(reserved))
        });
    if reserved_hit {
        return Err(NameRejected::Reserved);
    }
    Ok(collapsed)
}

fn is_latin(c: char) -> bool {
    c.is_alphabetic()
        && matches!(c as u32, 0x41..=0x5A | 0x61..=0x7A | 0xC0..=0x24F | 0x1E00..=0x1EFF)
}

fn is_cyrillic(c: char) -> bool {
    matches!(c as u32, 0x0400..=0x052F)
}

fn is_greek(c: char) -> bool {
    matches!(c as u32, 0x0370..=0x03FF | 0x1F00..=0x1FFF)
}

/// Whether one word carries letters of more than one of Latin/Cyrillic/Greek.
fn mixes_confusable_scripts(word: &str) -> bool {
    let latin = word.chars().any(is_latin);
    let cyrillic = word.chars().any(is_cyrillic);
    let greek = word.chars().any(is_greek);
    [latin, cyrillic, greek]
        .into_iter()
        .filter(|present| *present)
        .count()
        > 1
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
        'ω' => 'w',
        'η' => 'n',
        'ӏ' => 'l',
        'ԛ' => 'q',
        'ԝ' => 'w',
        // Latin letters NFKD does not decompose.
        'ı' => 'i',
        'ł' => 'l',
        'ø' => 'o',
        'đ' => 'd',
        'ð' => 'd',
        'ɑ' => 'a',
        'ɡ' => 'g',
        other => other,
    }
}

/// The comparison form of a name or handle: NFKD → case-folded → combining marks,
/// whitespace, `-` and `_` removed → common Cyrillic/Greek look-alikes mapped to
/// Latin. Two names with the same skeleton are the same name to a reader.
pub fn skeleton(raw: &str) -> String {
    // NFKD, not NFKC: the precomposed `é` and `e` + U+0301 must reach the same
    // skeleton, and only the decomposed form lets the mark be dropped.
    let folded: String = raw
        .nfkd()
        .flat_map(char::to_lowercase)
        .filter(|c| !(c.is_whitespace() || *c == '-' || *c == '_' || is_combining_mark(*c)))
        .map(confusable)
        .map(ascii_confusable)
        .collect();
    // `rn` reads as `m`, `vv` as `w`.
    folded.replace("rn", "m").replace("vv", "w")
}

/// The ASCII look-alikes that survive lower-casing: `0`/`o`, and `1`/`l`/`i`/`|`
/// (a capital `I`, a lower-case `L` and a digit one are one shape in most fonts).
fn ascii_confusable(c: char) -> char {
    match c {
        '0' => 'o',
        '1' | 'i' | '|' => 'l',
        other => other,
    }
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

/// The words of a name as a **mention** reads them: folded like [`skeleton`]
/// (so look-alikes and case agree) but split where
/// `read_state::is_mention_boundary` ends a mention — on anything that is not
/// alphanumeric, `_` or `-`.
fn mention_words(raw: &str) -> Vec<String> {
    let folded: String = raw
        .nfkd()
        .flat_map(char::to_lowercase)
        .filter(|c| !is_combining_mark(*c))
        .map(confusable)
        .map(ascii_confusable)
        .collect();
    folded
        .split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '-'))
        .filter(|word| !word.is_empty())
        .map(str::to_string)
        .collect()
}

/// Whether writing `@candidate` would also be read as a mention of another
/// member, or `@that member` as a mention of the candidate (ADR-0186 증보 V4).
///
/// A mention only has to END on a boundary, so `@Alice Kim` also mentions a member
/// named `Alice` (and a handle `intern` is mentioned by `@intern helper`). Equality
/// of skeletons is therefore not enough for an *agent proposal*: a name that is a
/// whole-word prefix of another member's name or handle — or the reverse — would
/// let a message meant for one reach the other. This is stricter than
/// [`conflicts_with_roster`] on purpose and is applied only to names an agent
/// proposes; a person's own choice is judged by skeleton equality alone.
pub fn mention_overlaps_roster(candidate: &str, target: Uuid, roster: &[RosterName<'_>]) -> bool {
    let wanted = mention_words(candidate);
    if wanted.is_empty() {
        return true;
    }
    let prefix_of = |short: &[String], long: &[String]| long.starts_with(short);
    roster
        .iter()
        .filter(|other| other.member_id != target)
        .any(|other| {
            [other.display_name, other.handle].into_iter().any(|name| {
                let theirs = mention_words(name);
                !theirs.is_empty() && (prefix_of(&wanted, &theirs) || prefix_of(&theirs, &wanted))
            })
        })
}

/// Whether a name a **person** typed carries something invisible, reordering or
/// line-breaking — the part of the agent allow-list that is also right for a
/// human rename of an agent, because the name is read by other people on cards
/// and in voice lines: control and format characters (zero-width, bidi, BOM,
/// tags), line and paragraph separators, and the invisible Hangul fillers.
pub fn has_invisible_or_control_characters(raw: &str) -> bool {
    raw.chars().any(|c| {
        c.is_control()
            || is_line_break(c)
            || is_invisible_letter(c)
            || matches!(c as u32,
                0x00AD | 0x034F | 0x061C | 0x180E | 0x200B..=0x200F | 0x202A..=0x202E
                | 0x2060..=0x206F | 0x2800 | 0xFEFF | 0xE0000..=0xE007F)
    })
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
            validated_agent_proposed_display_name("tab\tstop"),
            Ok("tab stop".to_string())
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
    fn a_reserved_word_in_a_mixed_script_spelling_is_still_refused() {
        // Cyrillic а + Latin: refused as a mixed-script word before the reserved
        // list is even consulted.
        assert!(validated_agent_proposed_display_name("аdmin").is_err());
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

    /// Review M1: ASCII and non-decomposing look-alikes.
    #[test]
    fn ascii_and_latin_lookalikes_share_a_skeleton() {
        let roster = roster();
        let target = Uuid::from_u128(99);
        for hostile in [
            "AIice Kim", // capital i for l
            "A1ice Kim", // digit one for l
            "Alıce Kim", // dotless i
            "Ａłice Kim",
            "Alice Kim",
            "Allce Kim",
            "A|ice Kim",
        ] {
            let cleaned = hostile.replace('|', "l");
            assert!(
                conflicts_with_roster(&cleaned, target, &roster)
                    || conflicts_with_roster(hostile, target, &roster),
                "{hostile:?}"
            );
        }
        assert_eq!(skeleton("adm1n"), skeleton("admin"));
        assert_eq!(skeleton("0ort"), skeleton("oort"));
        assert_eq!(skeleton("rnatt"), skeleton("matt"));
        assert_eq!(skeleton("vvhale"), skeleton("whale"));
    }

    /// Review M2: reserved words anywhere in the name.
    #[test]
    fn reserved_words_are_refused_inside_a_longer_name() {
        for hostile in [
            "Admin 2",
            "Oort Support",
            "Security Team",
            "관리자 봇",
            "AdminBot",
            "Adm1n",
            "System Notice",
            "Official Helper",
            "Staff",
            "Moderator Mia",
            "Owner Bot",
            "All Hands",
            "모두 봇",
        ] {
            assert_eq!(
                validated_agent_proposed_display_name(hostile),
                Err(NameRejected::Reserved),
                "{hostile}"
            );
        }
        // …but the everyday words are only reserved as WHOLE words.
        for fine in ["Allie", "Archery", "Hereford", "Channeler", "Overall"] {
            assert!(
                validated_agent_proposed_display_name(fine).is_ok(),
                "{fine}"
            );
        }
    }

    /// Review M3: `@Alice Kim` also mentions a member called `Alice`.
    #[test]
    fn a_whole_word_prefix_of_another_name_or_handle_overlaps_a_mention() {
        let roster = roster();
        let target = Uuid::from_u128(99);
        for overlapping in [
            "Alice", // prefix of "Alice Kim"
            "alice",
            "Alice Kim Bot", // "Alice Kim" is a prefix of it
            "Intern",        // the handle `intern`
            "Intern Helper", // `@intern helper` mentions handle `intern`
            "김",            // prefix of "김 인턴"
            "김 인턴 비서",
        ] {
            assert!(
                mention_overlaps_roster(overlapping, target, &roster),
                "{overlapping}"
            );
        }
        for clear in ["Bob", "Alicia", "Ali", "Kim Alice", "인턴 김"] {
            assert!(!mention_overlaps_roster(clear, target, &roster), "{clear}");
        }
        // Renaming a member does not collide with itself.
        assert!(!mention_overlaps_roster(
            "Alice Kim Jr",
            Uuid::from_u128(1),
            &roster
        ));
    }

    /// Review M1/L5: mixed scripts in one word and stacked marks.
    #[test]
    fn mixed_scripts_and_stacked_marks_are_refused() {
        for hostile in [
            "Аlice",                      // Cyrillic А + Latin
            "Pаypal",                     // Cyrillic а
            "Αlpha",                      // Greek Α + Latin
            "x\u{0301}\u{0302}\u{0303}b", // three marks in a row
            "a\u{034F}b",
            "a\u{FE00}b",
            "a\u{FE0F}b", // selector not after an emoji
        ] {
            assert!(
                validated_agent_proposed_display_name(hostile).is_err(),
                "{hostile:?}"
            );
        }
        assert!(validated_agent_proposed_display_name("Привет").is_ok());
        assert!(validated_agent_proposed_display_name("Αλφα").is_ok());
        assert!(validated_agent_proposed_display_name("Zoë").is_ok());
        assert!(validated_agent_proposed_display_name("bot \u{2764}\u{FE0F}").is_ok());
    }

    #[test]
    fn a_persons_name_may_not_hide_or_break_lines() {
        for hostile in [
            "Al\u{200B}ice",
            "Al\u{202E}ice",
            "two\nlines",
            "a\u{FEFF}b",
            "ㅤ",
            "tab\there",
            "a\u{2800}b",
            "a\u{E0041}b",
        ] {
            assert!(has_invisible_or_control_characters(hostile), "{hostile:?}");
        }
        for fine in ["김 인턴 (비서)", "Helper 🤖", "a-b_c", "Zoë"] {
            assert!(!has_invisible_or_control_characters(fine), "{fine:?}");
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
