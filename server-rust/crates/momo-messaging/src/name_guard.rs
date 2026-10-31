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
pub const RESERVED_NAMES: [&str; 18] = [
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
    // ADR-0205 H-1 (#4084): the workspace's system author is named 「GitHub」.
    "github",
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
const RESERVED_WHOLE_WORDS: [&str; 6] = ["here", "all", "모두", "전체", "channel", "github"];

/// Further words an agent may not wear (substring, by skeleton).
const RESERVED_EXTRA: [&str; 4] = ["owner", "moderator", "staff", "official"];

/// ADR-0201 증보 v3 B10-5 (#4966): the words the **team AI's** display name and its
/// aliases may never be — the broadcast-mention words (`@here`, `@channel`,
/// `@everyone`, `@all`, `@모두`, `@전체`), the two role words people read as authority
/// (`admin`, `system`), and the helper's own handle (`oort-helper`).
///
/// This is the one server-side list for them. It is deliberately **not**
/// [`RESERVED_NAMES`]: that list also holds `oort` and `오르트`, which are the helper's
/// own default aliases, so reusing it would forbid naming the helper 「오르트」. The match
/// is on the **whole** name (by [`light_skeleton`], so `ALL`, `A-l-l` and a Cyrillic look-alike
/// are the same word), not a substring: `Allie` and `시스템 도우미` are not collateral.
pub const RESERVED_MENTION_WORDS: [&str; 9] = [
    "here",
    "channel",
    "everyone",
    "all",
    "admin",
    "system",
    "모두",
    "전체",
    "oort-helper",
];

/// Is `raw` — as a whole — one of [`RESERVED_MENTION_WORDS`]? Used for the team AI's
/// display name (before the write) and for the alias derived from it.
pub fn is_reserved_mention_word(raw: &str) -> bool {
    let wanted = light_skeleton(raw);
    !wanted.is_empty()
        && RESERVED_MENTION_WORDS
            .iter()
            .any(|word| light_skeleton(word) == wanted)
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
        if c == ' ' || c == '-' || c == '_' || c == '\u{30FB}' || is_combining_mark(c) {
            continue;
        }
        if is_emoji(c) {
            emoji += 1;
            continue;
        }
        if c.is_ascii_digit() || (c.is_alphabetic() && is_allowed_script(c)) {
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
                .any(|reserved| light_skeleton(word) == light_skeleton(reserved))
        });
    if reserved_hit {
        return Err(NameRejected::Reserved);
    }
    Ok(collapsed)
}

/// The scripts an **agent proposal** may spell a name in: Latin (with its
/// extensions), Hangul, Han, Kana, and — never mixed with Latin in one word —
/// Cyrillic and Greek. Everything else that is merely `Alphabetic` (Armenian,
/// Cherokee, the IPA and Latin-small-capital blocks, …) is refused: those are
/// where look-alikes of Latin letters live, and a block-by-block block-list would
/// always be one block behind. A name outside these scripts can still be given by
/// a person (`PATCH …/agents/{agent}`).
fn is_allowed_script(c: char) -> bool {
    is_latin(c)
        || is_cyrillic(c)
        || is_greek(c)
        || matches!(c as u32,
            0xAC00..=0xD7AF | 0x1100..=0x11FF | 0x3130..=0x318F | 0xA960..=0xA97F | 0xD7B0..=0xD7FF
            | 0x3005..=0x3007
            | 0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0x3040..=0x30FF | 0x31F0..=0x31FF)
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

/// Hangul jamo, kana and Han ideographs — **not** Hangul syllables. Some of them
/// are drawn like a Latin letter (`ㅣ`≈l, `ㅇ`≈o, `ー`≈-, `口`≈o, `エ`≈I), which is
/// why a word may not mix them with Latin; a Hangul *syllable* beside Latin
/// (`김A`, `Bot봇`) is ordinary and stays allowed.
fn is_shape_script(c: char) -> bool {
    matches!(c as u32,
        0x1100..=0x11FF | 0x3130..=0x318F | 0xA960..=0xA97F | 0xD7B0..=0xD7FF
        | 0x3007 | 0x3040..=0x30FF | 0x31F0..=0x31FF | 0x4E00..=0x9FFF | 0x3400..=0x4DBF)
}

/// Whether one word carries letters of more than one of Latin, Cyrillic, Greek
/// and the shape scripts ([`is_shape_script`]).
fn mixes_confusable_scripts(word: &str) -> bool {
    let latin = word.chars().any(is_latin);
    let cyrillic = word.chars().any(is_cyrillic);
    let greek = word.chars().any(is_greek);
    let shape = word.chars().any(is_shape_script);
    [latin, cyrillic, greek, shape]
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
        // Hangul jamo drawn like a Latin letter.
        // (NFKD turns the compatibility jamo into the conjoining ones.)
        'ㅣ' | '\u{1175}' => 'i',
        'ㅇ' | '\u{110B}' => 'o',
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
        .filter(|c| {
            !(c.is_whitespace() || matches!(*c, '-' | '_' | '\u{30FB}') || is_combining_mark(*c))
        })
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

/// [`skeleton`] without the ASCII look-alike folding (`i`/`l`/`1`, `0`/`o`,
/// `rn`/`m`): used where the question is "is this *the word* `all`", so that
/// the ordinary name `Ali` is not read as `all`.
fn light_skeleton(raw: &str) -> String {
    raw.nfkd()
        .flat_map(char::to_lowercase)
        .filter(|c| {
            !(c.is_whitespace() || matches!(*c, '-' | '_' | '\u{30FB}') || is_combining_mark(*c))
        })
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

/// The same fold as [`mention_words`] but split on whitespace only.
fn spaced_words(raw: &str) -> Vec<String> {
    let folded: String = raw
        .nfkd()
        .flat_map(char::to_lowercase)
        .filter(|c| !is_combining_mark(*c))
        .map(confusable)
        .map(ascii_confusable)
        .collect();
    folded.split_whitespace().map(str::to_string).collect()
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
    let wanted_spaced = spaced_words(candidate);
    let prefix_of = |short: &[String], long: &[String]| long.starts_with(short);
    roster
        .iter()
        .filter(|other| other.member_id != target)
        .any(|other| {
            [other.display_name, other.handle].into_iter().any(|name| {
                let theirs = mention_words(name);
                let theirs_spaced = spaced_words(name);
                // Two views: by mention boundary, and by plain spaces — the
                // second catches a member whose name has NO alphanumeric word
                // (`🤖`), which the first would skip.
                (!theirs.is_empty() && (prefix_of(&wanted, &theirs) || prefix_of(&theirs, &wanted)))
                    || (!theirs_spaced.is_empty()
                        && (prefix_of(&wanted_spaced, &theirs_spaced)
                            || prefix_of(&theirs_spaced, &wanted_spaced)))
            })
        })
}

/// Whether free text carries characters that hide, reorder or fake structure:
/// control and format characters (zero-width, bidi, BOM, tags), the invisible
/// Hangul fillers, line and paragraph separators — except `\n` when
/// `allow_newlines` (a welcome prompt is multi-line prose). Used on text an agent
/// *proposes* for another surface (`workspace.settings.update`), where the
/// approver reads it on a card.
pub fn has_hidden_characters(raw: &str, allow_newlines: bool) -> bool {
    let without_allowed: String = if allow_newlines {
        raw.replace('\n', " ")
    } else {
        raw.to_string()
    };
    has_invisible_or_control_characters(&without_allowed)
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
                | 0x2060..=0x206F | 0x2800 | 0xFEFF | 0xE0000..=0xE007F | 0xE0100..=0xE01EF
                | 0x17B4..=0x17B5 | 0xFFF9..=0xFFFB | 0x1D173..=0x1D17A | 0x180B..=0x180F)
    })
}

// ---------------------------------------------------------------------------
// ADR-0186 증보 v3 V3-2 — the profile card an agent may propose for an agent
// ---------------------------------------------------------------------------

/// The longest `tagline` (소개), in characters after normalisation.
pub const AGENT_TAGLINE_MAX_CHARS: usize = 140;
/// The longest status text — the same bound `member.status_text` carries.
pub const AGENT_STATUS_TEXT_MAX_CHARS: usize = 80;
/// The longest `roleLabel`.
pub const AGENT_ROLE_LABEL_MAX_CHARS: usize = 24;
/// At most this many emoji in a status emoji.
pub const AGENT_STATUS_EMOJI_MAX: usize = 4;

/// Characters that form a mention, markdown or a URL. A card line an agent wrote
/// must carry none of them: it is rendered as plain text, and the approver reads
/// it as such.
fn is_link_or_mention_char(c: char) -> bool {
    matches!(
        c,
        '@' | '<' | '>' | '[' | ']' | '(' | ')' | '`' | ':' | '/' | '\\' | '#' | '&'
    )
}

/// The full stops a link detector (or a person) reads as a dot: NFKC already
/// folds U+FF0E / U+FE52 / U+2024 to `.`, but U+3002 and U+FF61 stay (they are
/// the dot of a CJK domain) and are added here.
fn is_dot_like(c: char) -> bool {
    matches!(
        c,
        '.' | '\u{3002}' | '\u{FF61}' | '\u{2024}' | '\u{FE52}' | '\u{FF0E}'
    )
}

/// `foo.com`, `a.b`, `x.io`, `x🔥.com`, `evil。com`: a dot with a non-space on its
/// left and an alphanumeric on its right is a domain-shaped token, the thing a
/// link detector would pick up. A sentence's closing `.` (followed by a space or
/// the end) is not, and neither is a number like `1.5`. The CJK full stops
/// (U+3002 / U+FF61) are a sentence end in Japanese and Chinese, so they count
/// only between two ASCII letters or digits (`evil。com`), never between kana.
fn has_domain_shaped_dot(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    chars.windows(3).any(|w| {
        let (left, dot, right) = (w[0], w[1], w[2]);
        if !is_dot_like(dot) || left.is_whitespace() || is_dot_like(left) {
            return false;
        }
        if matches!(dot, '\u{3002}' | '\u{FF61}') {
            return left.is_ascii_alphanumeric() && right.is_ascii_alphanumeric();
        }
        right.is_alphanumeric() && !(left.is_ascii_digit() && right.is_ascii_digit())
    })
}

/// A combining/mark character by canonical combining class or by the explicit
/// ranges — Arabic and Hebrew points carry a class and no block list covers them.
fn is_mark_like(c: char) -> bool {
    is_combining_mark(c) || unicode_normalization::char::canonical_combining_class(c) != 0
}

/// Format and invisible characters `has_invisible_or_control_characters` does not
/// list: Arabic number signs, the object replacement character, Egyptian
/// hieroglyph and shorthand format controls.
fn has_extra_invisible_characters(text: &str) -> bool {
    text.chars().any(|c| {
        matches!(c as u32,
            0x0600..=0x0605 | 0x06DD | 0x070F | 0x0890..=0x0891 | 0x08E2 | 0xFFFC
            | 0x1BCA0..=0x1BCA3 | 0x13430..=0x1345F)
    })
}

/// The characters free text may contain — an allow-list, because a deny-list of
/// invisible, mark and look-alike characters is always one block behind: ASCII
/// (minus the link and mention characters, which are refused separately), the
/// letters of the scripts a proposed name may use (Latin, Hangul, Han, kana,
/// Cyrillic and Greek — mixing them inside one word is refused too), digits, the
/// narrow emoji set, combining marks, and a short list of typographic and CJK
/// punctuation. Anything else — other scripts, symbols, phonetic extensions, the
/// private use area — is refused.
fn is_allowed_free_text_char(c: char) -> bool {
    if c.is_ascii() {
        return !c.is_ascii_control();
    }
    if is_emoji(c) || is_combining_mark(c) {
        return true;
    }
    if c.is_alphabetic() {
        return is_allowed_script(c);
    }
    if c.is_numeric() {
        // Digits of other scripts (Arabic-Indic, Devanagari…) are a look-alike
        // and spacing surface; only the fullwidth/ASCII ones survive NFKC.
        return false;
    }
    matches!(
        c as u32,
        0x00B7 | 0x2026 | 0x2018..=0x201D | 0x3001 | 0x3002 | 0x300C..=0x300F | 0x30FB | 0xFF61
            | 0x2013 | 0x2014 | 0x00A0
    )
}

/// Free text an **agent proposes for another surface** (a tagline, a status
/// line): NFKC, whitespace collapsed, no line breaks, no hidden or control
/// characters, no mention / markdown / URL characters, no domain-shaped token,
/// `1..=max_chars`. Which rule failed is not reported to the proposer.
pub fn validated_agent_free_text(raw: &str, max_chars: usize) -> Result<String, NameRejected> {
    let normalised: String = raw.nfkc().collect();
    if normalised.chars().any(is_line_break) {
        return Err(NameRejected::Disallowed);
    }
    let collapsed = normalised.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return Err(NameRejected::Empty);
    }
    if collapsed.chars().count() > max_chars {
        return Err(NameRejected::TooLong);
    }
    let without_spaces: String = collapsed.chars().filter(|c| !c.is_whitespace()).collect();
    if !collapsed.chars().all(|c| c == ' ' || is_allowed_free_text_char(c))
        || collapsed.split(' ').any(mixes_confusable_scripts)
        || has_invisible_or_control_characters(&collapsed)
        || has_extra_invisible_characters(&collapsed)
        || collapsed.chars().any(is_link_or_mention_char)
        || has_domain_shaped_dot(&collapsed)
        // `www .evil com`: the spaces are not a way around the `www.` check.
        || without_spaces.to_lowercase().contains("www.")
        || without_spaces.chars().any(is_dot_like) && without_spaces.to_lowercase().contains("www")
    {
        return Err(NameRejected::Disallowed);
    }
    // Combining marks: at most two in a row (zalgo), and never the combining
    // grapheme joiner — the same limit a proposed name carries.
    let mut run = 0usize;
    for c in collapsed.chars() {
        if is_mark_like(c) {
            run += 1;
            if run > 2 || c == '\u{034F}' {
                return Err(NameRejected::Disallowed);
            }
        } else {
            run = 0;
        }
    }
    Ok(collapsed)
}

/// A `tagline`: [`validated_agent_free_text`] at 140 characters.
pub fn validated_agent_tagline(raw: &str) -> Result<String, NameRejected> {
    validated_agent_free_text(raw, AGENT_TAGLINE_MAX_CHARS)
}

/// A status line: [`validated_agent_free_text`] at 80 characters.
pub fn validated_agent_status_text(raw: &str) -> Result<String, NameRejected> {
    validated_agent_free_text(raw, AGENT_STATUS_TEXT_MAX_CHARS)
}

/// A status emoji: only pictographs from the narrow [`is_emoji`] set, each
/// optionally followed by **one** emoji variation selector — at most
/// [`AGENT_STATUS_EMOJI_MAX`] pictographs, so at most twice that many scalars
/// (8, far inside the `member.status_emoji` CHECK of 32) **by construction**: a
/// selector may only follow a pictograph and each pictograph takes one. No
/// zero-width joiner (a format character), no text, no leading or repeated
/// selector.
pub fn validated_agent_status_emoji(raw: &str) -> Result<String, NameRejected> {
    let normalised: String = raw.nfkc().collect();
    let trimmed: String = normalised.split_whitespace().collect::<Vec<_>>().join("");
    if trimmed.is_empty() {
        return Err(NameRejected::Empty);
    }
    let mut emoji = 0usize;
    let mut previous_emoji = false;
    for c in trimmed.chars() {
        if is_emoji(c) {
            emoji += 1;
            previous_emoji = true;
        } else if c == '\u{FE0F}' && previous_emoji {
            // One selector per pictograph: it consumes the "just saw an emoji" flag.
            previous_emoji = false;
        } else {
            return Err(NameRejected::Disallowed);
        }
    }
    if emoji == 0 || emoji > AGENT_STATUS_EMOJI_MAX {
        return Err(NameRejected::Disallowed);
    }
    Ok(trimmed)
}

/// Authority words a role label may not **contain** (compared by [`skeleton`]), on
/// top of the proposed-name reserved list: the Korean and English words a person
/// reads as 「this one decides」 or 「this one is verified」. `관리` alone is
/// deliberately absent (「일정 관리 비서」 is an honest label); `관리자` is
/// already reserved.
const ROLE_LABEL_AUTHORITY: &[&str] = &[
    "소유자",
    "오너",
    "어드민",
    "운영진",
    "인증",
    "공식",
    "verified",
    "대표",
    "팀장",
    "리더",
    "마스터",
    "총괄",
    "책임자",
    "founder",
    "manager",
    "boss",
    "master",
    "lead",
    "head of",
    "director",
];
/// Short authority words refused only as a whole word of the label.
const ROLE_LABEL_AUTHORITY_WHOLE: &[&str] = &["ceo", "hr", "cto", "cfo", "coo"];

/// The letters digits stand in for when someone writes `Own3r` or `4dmin`.
fn undo_leet(raw: &str) -> String {
    raw.chars()
        .map(|c| match c {
            '3' => 'e',
            '4' | '@' => 'a',
            '5' | '$' => 's',
            '7' => 't',
            '8' => 'b',
            other => other,
        })
        .collect()
}

/// The labels every workspace has before it overrides any (the client's
/// defaults and their English roots). A role label equal to one is refused.
pub const DEFAULT_ROLE_LABEL_WORDS: [&str; 8] = [
    "소유자",
    "관리자",
    "멤버",
    "게스트",
    "owner",
    "admin",
    "member",
    "guest",
];

/// A `roleLabel`: the proposed-name rules (allow-list, scripts, reserved words)
/// at 24 characters, plus the authority words above. A label like 「관리자」 or
/// 「Security」 wears authority the agent does not have.
pub fn validated_agent_role_label(raw: &str) -> Result<String, NameRejected> {
    let label = validated_agent_proposed_display_name(raw)?;
    if label.chars().count() > AGENT_ROLE_LABEL_MAX_CHARS {
        return Err(NameRejected::TooLong);
    }
    // Judged on the label as written and with digits read as the letters they
    // imitate (`Own3r`, `4dmin`).
    let unleeted = undo_leet(&label);
    let authority_hit = [label.as_str(), unleeted.as_str()].into_iter().any(|text| {
        let text_skeleton = skeleton(text);
        ROLE_LABEL_AUTHORITY
            .iter()
            .any(|word| text_skeleton.contains(&skeleton(word)))
            || text.split(' ').any(|word| {
                ROLE_LABEL_AUTHORITY_WHOLE
                    .iter()
                    .any(|reserved| light_skeleton(word) == light_skeleton(reserved))
            })
    }) || {
        // The proposed-name reserved list too, on the unleeted spelling.
        validated_agent_proposed_display_name(&unleeted).is_err()
    };
    if authority_hit {
        return Err(NameRejected::Reserved);
    }
    Ok(label)
}

/// Whether `label` equals a default role word, or equals / contains a label the
/// workspace defined (`defined`, from `settings.role_labels`). Containment only
/// for defined labels of at least three skeleton characters, so a one-letter
/// override cannot ban the alphabet.
pub fn role_label_collides(label: &str, defined: &[&str]) -> bool {
    let wanted = skeleton(label);
    if wanted.is_empty() {
        return true;
    }
    DEFAULT_ROLE_LABEL_WORDS
        .iter()
        .any(|word| skeleton(word) == wanted)
        || defined.iter().any(|name| {
            let theirs = skeleton(name);
            // Raw letters, not skeleton characters: a Hangul syllable folds to
            // several jamo, so counting those would let a one-syllable override
            // ban every label containing it.
            let letters = name.chars().filter(|c| c.is_alphanumeric()).count();
            let wide = name.chars().any(is_hangul_or_han);
            let contained = wanted.contains(&theirs) && letters >= if wide { 2 } else { 3 };
            !theirs.is_empty() && (theirs == wanted || contained)
        })
}

/// Korean particles and endings that attach directly to a name: 「김인턴**이**」,
/// 「김인턴**님이**」, 「김인턴**에게**」. A name followed by one of these (and nothing
/// else) is the name.
const KOREAN_NAME_SUFFIXES: &[&str] = &[
    "",
    "이",
    "가",
    "은",
    "는",
    "을",
    "를",
    "의",
    "와",
    "과",
    "도",
    "만",
    "에",
    "로",
    "랑",
    "나",
    "님",
    "씨",
    "군",
    "양",
    "님이",
    "님은",
    "님을",
    "님의",
    "님과",
    "님도",
    "님께",
    "에게",
    "한테",
    "께서",
    "에서",
    "으로",
    "이랑",
    "이나",
    "이라",
    "라고",
    "이라고",
    "님께서",
    "님에게",
    "이다",
];

/// The tokens of `raw` for name matching: NFKC, split on everything that is not
/// a letter or digit (so `Alice-Kim`, `alice,kim` and `Al~ice` all split), each
/// token folded like [`skeleton`] minus the separators.
fn name_tokens(raw: &str) -> Vec<String> {
    let nfkc: String = raw.nfkc().collect();
    nfkc.split(|c: char| !c.is_alphanumeric())
        .filter(|token| !token.is_empty())
        .map(skeleton)
        .filter(|token| !token.is_empty())
        .collect()
}

/// Whether `candidate` is `name` (already folded and concatenated), optionally
/// followed by a Korean particle: 「김인턴님이」 and also 「Alice님이」 — a Latin name
/// in Korean prose takes the same endings.
fn is_name_with_suffix(candidate: &str, name: &str) -> bool {
    candidate == name
        || candidate.strip_prefix(name).is_some_and(|rest| {
            KOREAN_NAME_SUFFIXES
                .iter()
                .any(|suffix| skeleton(suffix) == rest)
        })
}

/// Whether `text` repeats another member's display name or handle, so a line
/// cannot read as something that member said or endorsed.
///
/// Matching is by **token**, never by raw substring, so ordinary words that merely
/// contain a short name (`Maximum` for `Max`, `plan new` for `Ann`) are fine:
/// * the name's tokens appear in order as whole tokens (`Alice Kim`, `Alice-Kim`,
///   `alice,kim`);
/// * the name, glued, equals one token or up to eight adjacent tokens
///   (`AliceKim`, `Al~ice Kim`, `ALICE_KIM`);
/// * a token or glued run that is the name plus a Korean particle (`김인턴이`,
///   `김인턴님이`, `김,인턴이`, `Alice님이`).
///
/// A Latin display name must have at least four letters (a three-letter name is
/// too often an ordinary word), a Hangul or Han name at least two characters, and
/// a handle at least five; shorter names are not protected by this rule (the
/// proposed-name rules still stop an agent *taking* them).
pub fn text_repeats_roster_name(text: &str, target: Uuid, roster: &[RosterName<'_>]) -> bool {
    let tokens = name_tokens(text);
    if tokens.is_empty() {
        return false;
    }
    roster
        .iter()
        .filter(|other| other.member_id != target)
        .any(|other| {
            [(other.display_name, false), (other.handle, true)]
                .into_iter()
                .any(|(name, is_handle)| name_appears_in(&tokens, name, is_handle))
        })
}

fn name_appears_in(tokens: &[String], name: &str, is_handle: bool) -> bool {
    let name_toks = name_tokens(name);
    if name_toks.is_empty() {
        return false;
    }
    let letters = name.chars().filter(|c| c.is_alphanumeric()).count();
    let wide = name.chars().any(is_hangul_or_han);
    let long_enough = if wide {
        letters >= 2
    } else if is_handle {
        letters >= 5
    } else {
        letters >= 4
    };
    if !long_enough {
        return false;
    }
    // In-order whole tokens.
    if tokens
        .windows(name_toks.len())
        .any(|window| window == name_toks.as_slice())
    {
        return true;
    }
    // Glued: the name's tokens concatenated against runs of up to eight tokens
    // (`A l i c e`).
    let joined = name_toks.concat();
    (1..=tokens.len().min(8)).any(|run| {
        tokens
            .windows(run)
            .any(|window| is_name_with_suffix(&window.concat(), &joined))
    })
}

fn is_hangul_or_han(c: char) -> bool {
    matches!(c as u32,
        0xAC00..=0xD7AF | 0x1100..=0x11FF | 0x3130..=0x318F | 0x4E00..=0x9FFF | 0x3400..=0x4DBF
        | 0x3040..=0x30FF)
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
            "GitHub",
            "ＧｉｔＨｕｂ",
            "git-hub",
        ] {
            assert_eq!(
                validated_agent_proposed_display_name(reserved),
                Err(NameRejected::Reserved),
                "{reserved}"
            );
        }
    }

    /// ADR-0201 증보 v3 B10-5 (#4966): the team AI's reserved words are matched as a whole
    /// name, under the usual disguises — and the helper's own default aliases are not among them.
    #[test]
    fn the_team_ai_reserved_words_are_whole_names() {
        for reserved in [
            "here",
            "Channel",
            "EVERYONE",
            "all",
            "A-l-l",
            "Admin",
            "ａｄｍｉｎ",
            "system",
            "모두",
            "전체",
            "oort-helper",
            "Oort Helper",
            "аll", // Cyrillic а
        ] {
            assert!(is_reserved_mention_word(reserved), "{reserved}");
        }
        for ordinary in [
            "oort",
            "오르트",
            "claude",
            "Allie",
            "Ali",
            "allday",
            "시스템 도우미",
            "모두의 비서",
            "oort 도우미",
            "",
            "   ",
        ] {
            assert!(!is_reserved_mention_word(ordinary), "{ordinary:?}");
        }
        // Every entry is a fixed point of its own check (a typo in the list cannot hide).
        for word in RESERVED_MENTION_WORDS {
            assert!(is_reserved_mention_word(word), "{word}");
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

    /// Review N1: only Latin/Hangul/Han/Kana (and un-mixed Cyrillic/Greek) letters.
    #[test]
    fn letters_outside_the_allowed_scripts_are_refused() {
        for hostile in [
            "ᴀᴅᴍɪɴ", // Latin small capitals
            "admiո", // Armenian
            "օrt",   // Armenian
            "Ꭺdmin", // Cherokee
            "ɑdmin", // IPA
            "สวัสดี",  // Thai (a person may choose it; an agent proposal may not)
            "١٢٣",   // Arabic-Indic digits
        ] {
            assert!(
                validated_agent_proposed_display_name(hostile).is_err(),
                "{hostile}"
            );
        }
        for fine in [
            "김 인턴",
            "山田 ボット",
            "ヘルメス",
            "Hermes",
            "Привет",
            "Αλφα",
            "Zoë 3",
        ] {
            assert!(
                validated_agent_proposed_display_name(fine).is_ok(),
                "{fine}"
            );
        }
    }

    /// Review N8/N11: shape-alike jamo/kana/Han beside Latin, and ordinary
    /// Japanese names.
    #[test]
    fn latin_cannot_borrow_shapes_from_jamo_kana_or_han_but_names_stay_usable() {
        for hostile in [
            "Aㅣice", "Admㅣn", "ㅇㅇrt", "Aliceー", "Bロt", "Aエ", "〇〇rt",
        ] {
            assert!(
                validated_agent_proposed_display_name(hostile).is_err(),
                "{hostile}"
            );
        }
        for fine in [
            "김A",
            "Bot봇",
            "佐々木",
            "ジョン・スミス",
            "ㅋㅋ",
            "山田 Bot",
        ] {
            assert!(
                validated_agent_proposed_display_name(fine).is_ok(),
                "{fine}"
            );
        }
        assert_eq!(skeleton("Aㅣice"), skeleton("Alice"));
        // The katakana middle dot is a separator like `-`: it cannot split a word
        // to dodge the reserved list or a collision.
        assert_eq!(skeleton("Ad・min"), skeleton("admin"));
        assert_eq!(skeleton("Ad･min"), skeleton("admin"));
        // …and inside a Latin word it is a mixed-script word, refused outright.
        assert!(validated_agent_proposed_display_name("Ad・min").is_err());
    }

    /// Review N2: `Ali` is a name, not the word `all`.
    #[test]
    fn ordinary_names_that_fold_onto_a_short_reserved_word_pass() {
        for fine in ["Ali", "Ail", "Ali Baba"] {
            assert!(
                validated_agent_proposed_display_name(fine).is_ok(),
                "{fine}"
            );
        }
        assert_eq!(
            validated_agent_proposed_display_name("All"),
            Err(NameRejected::Reserved)
        );
    }

    /// Review N5: a member whose name has no word at all is still mentioned.
    #[test]
    fn a_symbol_only_name_still_overlaps_by_plain_words() {
        let roster = vec![RosterName {
            member_id: Uuid::from_u128(5),
            display_name: "🤖",
            handle: "robot-fan",
        }];
        assert!(mention_overlaps_roster(
            "🤖 Bot",
            Uuid::from_u128(9),
            &roster
        ));
        assert!(!mention_overlaps_roster("Bot", Uuid::from_u128(9), &roster));
    }

    #[test]
    fn free_text_may_keep_newlines_but_not_hide_anything() {
        assert!(!has_hidden_characters("환영해요\n처음이시죠", true));
        assert!(has_hidden_characters("환영해요\n처음이시죠", false));
        for hostile in [
            "a\u{200B}b",
            "a\u{202E}b",
            "a\u{FEFF}b",
            "a\rb",
            "a\u{2028}b",
            "a\u{0007}b",
        ] {
            assert!(has_hidden_characters(hostile, true), "{hostile:?}");
        }
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
            "a\u{E0100}b",
            "a\u{17B4}b",
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

    // ---- ADR-0186 증보 v3 V3-2 ------------------------------------------------

    #[test]
    fn a_tagline_cannot_carry_a_link_a_mention_or_markdown() {
        for bad in [
            "see [docs](http://evil.example)",
            "ping @김인턴 now",
            "<@김인턴> hi",
            "visit https://evil.example",
            "go to www.evil.example",
            "mail me at a@b.co",
            "docs at evil.example",
            "line one\nline two",
            "zero\u{200B}width",
            "bidi \u{202E}flip",
            "`code`",
            "a\\b",
        ] {
            assert!(validated_agent_tagline(bad).is_err(), "{bad:?}");
        }
        assert_eq!(
            validated_agent_tagline("  영업 보조.  요약을   정리해요 ").unwrap(),
            "영업 보조. 요약을 정리해요"
        );
        assert!(validated_agent_tagline(&"가".repeat(141)).is_err());
        assert!(validated_agent_tagline(&"가".repeat(140)).is_ok());
        assert!(validated_agent_tagline("   ").is_err());
    }

    #[test]
    fn a_status_text_has_the_same_text_rules_at_eighty() {
        assert!(validated_agent_status_text(&"가".repeat(81)).is_err());
        assert!(validated_agent_status_text("회의 중 [잠시]").is_err());
        assert_eq!(
            validated_agent_status_text("집중 모드").unwrap(),
            "집중 모드"
        );
    }

    #[test]
    fn a_status_emoji_is_pictographs_only() {
        assert_eq!(validated_agent_status_emoji("🤖").unwrap(), "🤖");
        assert_eq!(validated_agent_status_emoji("🤖 🔥").unwrap(), "🤖🔥");
        assert!(validated_agent_status_emoji("🤖🤖🤖🤖🤖").is_err());
        assert!(validated_agent_status_emoji("ok").is_err());
        assert!(validated_agent_status_emoji("🤖x").is_err());
        assert!(
            validated_agent_status_emoji("👨\u{200D}👩").is_err(),
            "ZWJ is a format character"
        );
        assert!(validated_agent_status_emoji("").is_err());
    }

    #[test]
    fn a_role_label_wears_no_authority_and_is_short() {
        for bad in [
            "관리자",
            "Security",
            "oort 공식",
            "System",
            "Owner team",
            "보안 담당",
        ] {
            assert!(validated_agent_role_label(bad).is_err(), "{bad:?}");
        }
        assert!(validated_agent_role_label(&"a".repeat(25)).is_err());
        assert_eq!(
            validated_agent_role_label("영업 비서").unwrap(),
            "영업 비서"
        );
    }

    #[test]
    fn text_that_repeats_another_members_name_is_caught_as_whole_words() {
        let alice = Uuid::from_u128(1);
        let roster = [
            RosterName {
                member_id: alice,
                display_name: "Alice Kim",
                handle: "alice",
            },
            RosterName {
                member_id: Uuid::from_u128(2),
                display_name: "AI",
                handle: "ai",
            },
        ];
        let me = Uuid::from_u128(9);
        assert!(text_repeats_roster_name(
            "Alice Kim approved this",
            me,
            &roster
        ));
        assert!(text_repeats_roster_name("approved by alice.", me, &roster));
        // A short name folds under three characters and is ignored.
        assert!(!text_repeats_roster_name(
            "AI helps with sales",
            me,
            &roster
        ));
        // Matching is by token, so a name inside a longer word is not a repeat.
        assert!(!text_repeats_roster_name(
            "Alicex is unrelated",
            me,
            &roster
        ));
        assert!(!text_repeats_roster_name("Bob is unrelated", me, &roster));
        // The target's own name is not a repeat of "another" member.
        assert!(!text_repeats_roster_name(
            "Alice Kim approved this",
            alice,
            &roster
        ));
    }

    // ---- security review of #3797 (M1·M2·M3·L1·L2) ------------------------------

    #[test]
    fn a_status_emoji_cannot_be_padded_with_selectors() {
        let padded = format!("🤖{}", "\u{FE0F}".repeat(40));
        assert!(
            validated_agent_status_emoji(&padded).is_err(),
            "40 selectors"
        );
        assert!(
            validated_agent_status_emoji("\u{FE0F}🤖").is_err(),
            "a leading selector"
        );
        assert!(
            validated_agent_status_emoji("🤖\u{FE0F}\u{FE0F}").is_err(),
            "two selectors"
        );
        assert_eq!(
            validated_agent_status_emoji("🤖\u{FE0F}").unwrap(),
            "🤖\u{FE0F}",
            "one selector after a pictograph is fine"
        );
        // The longest legal value is within the column's CHECK (32).
        let longest = "🤖\u{FE0F}".repeat(AGENT_STATUS_EMOJI_MAX);
        assert!(
            validated_agent_status_emoji(&longest)
                .unwrap()
                .chars()
                .count()
                <= 32
        );
    }

    #[test]
    fn a_role_label_wears_no_authority_even_in_korean() {
        for bad in [
            "소유자",
            "오너",
            "어드민",
            "운영진 비서",
            "인증 담당",
            "공식 봇",
            "대표 비서",
            "CEO",
            "HR Bot",
            "팀장",
            "Verified Bot",
        ] {
            assert!(validated_agent_role_label(bad).is_err(), "{bad:?}");
        }
        assert_eq!(
            validated_agent_role_label("일정 관리 비서").unwrap(),
            "일정 관리 비서"
        );
        assert_eq!(validated_agent_role_label("Chef").unwrap(), "Chef");
    }

    #[test]
    fn a_role_label_may_not_equal_a_default_or_contain_a_defined_label() {
        for default in [
            "멤버",
            "게스트",
            "소유자",
            "관리자",
            "Member",
            "GUEST",
            "Owner",
            "admin",
        ] {
            assert!(role_label_collides(default, &[]), "{default:?}");
        }
        assert!(role_label_collides("Captain", &["Captain"]));
        assert!(
            role_label_collides("Captain Bot", &["Captain"]),
            "contains the defined label"
        );
        assert!(!role_label_collides("Chef", &["Captain"]));
        assert!(
            !role_label_collides("Chef", &["X"]),
            "a one-letter override bans nothing"
        );
        assert!(
            !role_label_collides("Axe", &["X"]),
            "and is not contained either"
        );
    }

    #[test]
    fn a_name_cannot_hide_inside_particles_hyphens_or_glue() {
        let roster = [
            RosterName {
                member_id: Uuid::from_u128(1),
                display_name: "Alice Kim",
                handle: "alice",
            },
            RosterName {
                member_id: Uuid::from_u128(2),
                display_name: "김인턴",
                handle: "intern",
            },
            RosterName {
                member_id: Uuid::from_u128(3),
                display_name: "김철",
                handle: "cheol",
            },
            RosterName {
                member_id: Uuid::from_u128(4),
                display_name: "박",
                handle: "park",
            },
        ];
        let me = Uuid::from_u128(9);
        for sneaky in [
            "김인턴이 승인함",
            "김인턴님이 승인",
            "Alice-Kim approved",
            "AliceKim approved",
            "ALICE_KIM ok",
            "김철이 확인",
            "approved by alice,",
            "ａｌｉｃｅ approved",
        ] {
            assert!(text_repeats_roster_name(sneaky, me, &roster), "{sneaky:?}");
        }
        // One Hangul syllable is ignored.
        let park_only = [RosterName {
            member_id: Uuid::from_u128(4),
            display_name: "박",
            handle: "p",
        }];
        assert!(!text_repeats_roster_name("박 대리와 함께", me, &park_only));
        assert!(!text_repeats_roster_name(
            "영업 요약을 정리해요",
            me,
            &roster
        ));
    }

    #[test]
    fn domain_shaped_text_is_caught_across_dots_and_spaces() {
        for bad in [
            "evil\u{3002}com",
            "evil\u{FF61}com",
            "x🔥.com",
            "x\u{0302}.com",
            "www .evil com",
            "WWW。evil",
            "see evil.example",
        ] {
            assert!(validated_agent_tagline(bad).is_err(), "{bad:?}");
        }
        assert!(
            validated_agent_tagline("버전 1.5 지원해요").is_ok(),
            "a number is not a domain"
        );
        assert!(
            validated_agent_tagline("끝. 다음 문장").is_ok(),
            "a sentence stop is not a domain"
        );
    }

    #[test]
    fn invisible_and_stacked_marks_are_refused_across_scripts() {
        for bad in [
            "a\u{0600}b",
            "a\u{FFFC}b",
            "a\u{1BCA0}b",
            "a\u{13430}b",
            &format!("ب{}", "\u{064E}".repeat(8)),
            &format!("x{}", "\u{05B4}".repeat(5)),
        ] {
            assert!(validated_agent_tagline(bad).is_err(), "{bad:?}");
        }
    }

    // ---- second security review of #3797 (F2·F3·F4) ------------------------------

    #[test]
    fn ordinary_text_is_not_mistaken_for_a_member_name() {
        let roster: Vec<RosterName<'_>> = [
            ("Ann", "ann"),
            ("Max", "max"),
            ("Eve", "eve"),
            ("Ali", "ali"),
            ("Tom", "tom"),
            ("Dev Bot", "dev"),
            ("Alice Kim", "alice"),
        ]
        .iter()
        .enumerate()
        .map(|(i, (name, handle))| RosterName {
            member_id: Uuid::from_u128(i as u128 + 1),
            display_name: name,
            handle,
        })
        .collect();
        let me = Uuid::from_u128(99);
        for fine in [
            "I manage the channel",
            "Maximum uptime watcher",
            "Reviews every event",
            "Helps with all your calls",
            "Custom automation",
            "Developer tools helper",
            "plan new things",
            "Alicex is unrelated",
            "Annual reports",
            "Tomorrow's tasks",
        ] {
            assert!(!text_repeats_roster_name(fine, me, &roster), "{fine:?}");
        }
        // Names that are real words in Korean are only caught as whole tokens.
        let korean = [RosterName {
            member_id: Uuid::from_u128(5),
            display_name: "김철",
            handle: "cheol",
        }];
        for fine in [
            "일정 비서",
            "고객 지원 담당",
            "문서 수정 도우미",
            "김철수 팀장 아님",
        ] {
            assert!(!text_repeats_roster_name(fine, me, &korean), "{fine:?}");
        }
        assert!(text_repeats_roster_name("김철 승인", me, &korean));
        assert!(text_repeats_roster_name("김철님이 승인", me, &korean));
    }

    #[test]
    fn punctuation_inside_a_name_does_not_hide_it() {
        let roster = [
            RosterName {
                member_id: Uuid::from_u128(1),
                display_name: "Alice Kim",
                handle: "alice",
            },
            RosterName {
                member_id: Uuid::from_u128(2),
                display_name: "김인턴",
                handle: "intern",
            },
        ];
        let me = Uuid::from_u128(9);
        for sneaky in [
            "Al~ice Kim",
            "Al*ice",
            "Al.ice Kim",
            "A l i c e",
            "김,인턴이",
            "김 인턴님이 승인",
            "ALICE_KIM",
            "Alice—Kim",
        ] {
            let ok = validated_agent_tagline(sneaky).is_ok();
            // Whatever the text validator says, the repeat rule must see the name.
            assert!(
                !ok || text_repeats_roster_name(sneaky, me, &roster),
                "{sneaky:?} passed both"
            );
        }
        for sneaky in [
            "Al~ice Kim",
            "Al*ice",
            "A l i c e",
            "김,인턴이",
            "김 인턴님이 승인",
            "ALICE_KIM",
        ] {
            assert!(text_repeats_roster_name(sneaky, me, &roster), "{sneaky:?}");
        }
    }

    #[test]
    fn free_text_is_an_allow_list_of_scripts_and_marks() {
        for bad in [
            "ᎪᏞᎥᏟᎬ", // Cherokee look-alikes
            "ᴀlice", // small capital A
            "ꓮlice", // Lisu
            "สวัสดี",  // Thai
            "नमस्ते",  // Devanagari
            "مرحبا", // Arabic
            "x\u{0E31}\u{0E31}\u{0E31}\u{0E31}\u{0E31}",
            "a\u{110BD}b",   // Kaithi number sign
            "٣٤٥",           // Arabic-Indic digits
            "mix\u{0430}bc", // Cyrillic a inside a Latin word
        ] {
            assert!(validated_agent_tagline(bad).is_err(), "{bad:?}");
        }
        for fine in [
            "일정을 정리하는 비서예요",
            "Summarises your sales calls",
            "こんにちは。ありがとう",
            "你好，世界",
            "Привет мир",
            "버전 1.5 지원",
            "끝. 다음 문장",
            "Hello — world…",
        ] {
            assert!(validated_agent_tagline(fine).is_ok(), "{fine:?}");
        }
        assert!(
            validated_agent_tagline("Node.js helper").is_err(),
            "a dotted token is link-shaped"
        );
    }

    #[test]
    fn more_authority_words_and_leet_are_refused_in_a_role_label() {
        for bad in [
            "Team Lead",
            "Manager",
            "Founder",
            "Boss",
            "총괄",
            "책임자",
            "마스터",
            "리더",
            "Own3r",
            "4dmin",
            "Dir3ctor",
            "CFO",
        ] {
            assert!(validated_agent_role_label(bad).is_err(), "{bad:?}");
        }
        assert!(validated_agent_role_label("Sales helper").is_ok());
        // A one-syllable override does not ban every label that contains it.
        assert!(!role_label_collides("팀 지원", &["팀"]));
        assert!(role_label_collides("팀", &["팀"]));
        assert!(role_label_collides("영업팀 비서", &["영업팀"]));
    }
}
