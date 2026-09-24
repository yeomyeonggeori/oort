//! Credential masking for every piece of text a session relays (ADR-0188 D5
//! 「인식되는 자격 문자열을 가린다」; #2602 M-1; #2607 N-2·N-3).
//!
//! **A secondary defence, by construction.** It recognises the *shapes* of
//! credentials. A model that cooperates with an attacker — splits a secret
//! with words, encodes it, spells it out — gets past any shape filter. What
//! keeps secrets from being read in the first place is the read fence and the
//! sandbox (ADR-0188 D6, §8); this is what catches the ordinary accident of a
//! read secret landing in an answer.
//!
//! Within that role it is made hard to sidestep by accident or by cheap
//! tricks:
//! * the scan runs on a **folded copy** of the text — invisible characters
//!   (Unicode format characters such as ZWJ, soft hyphen and the tag
//!   characters, variation selectors, fillers) removed and fullwidth ASCII
//!   folded to ASCII — so a token cannot hide behind a character that renders
//!   as nothing, or be written in fullwidth letters. The span that is replaced
//!   is the original text's, invisible characters included;
//! * PEM headers are matched loosely (any case, three or more dashes), and a
//!   block that is not closed is masked to the end;
//! * a base64 run that decodes to a private-key header, or starts like a DER
//!   or OpenSSH key body, is masked together with the base64 lines after it;
//! * distinctive token prefixes (`sk-ant-`, `ghp_`, `glpat-`, …) match
//!   wherever they start, so `token-ghp_…` or `_sk-ant-…` are caught; only
//!   the generic `sk-` and bare `eyJ`/`AKIA` shapes need a non-alphanumeric
//!   character before them, so words like `risk-assessment` are left alone;
//! * a value after `secret…=`/`secret…:` (the AWS secret access key shape) and
//!   the password in `scheme://user:password@host` are masked by context.

/// What a masked credential becomes on the wire.
pub const REDACTED_CREDENTIAL: &str = "[redacted credential]";
/// What a masked private-key block becomes on the wire.
pub const REDACTED_PRIVATE_KEY: &str = "[redacted private key]";

/// Characters that render as nothing inside a token: Unicode format
/// characters (Cf), variation selectors, the combining grapheme joiner, and
/// the Hangul fillers.
pub fn is_invisible(character: char) -> bool {
    matches!(character,
        '\u{00AD}' | '\u{034F}' | '\u{061C}' | '\u{115F}' | '\u{1160}' | '\u{17B4}' | '\u{17B5}'
        | '\u{180B}'..='\u{180F}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}'
        | '\u{2060}'..='\u{206F}' | '\u{3164}' | '\u{FE00}'..='\u{FE0F}' | '\u{FEFF}'
        | '\u{FFA0}' | '\u{FFF0}'..='\u{FFFB}' | '\u{0600}'..='\u{0605}' | '\u{06DD}'
        | '\u{070F}' | '\u{08E2}' | '\u{110BD}' | '\u{110CD}' | '\u{13430}'..='\u{1343F}'
        | '\u{1BCA0}'..='\u{1BCA3}' | '\u{1D173}'..='\u{1D17A}' | '\u{E0000}'..='\u{E0FFF}'
    )
}

/// Fullwidth ASCII to ASCII; everything else unchanged.
fn fold(character: char) -> char {
    match character {
        '\u{FF01}'..='\u{FF5E}' => char::from_u32(character as u32 - 0xFEE0).unwrap_or(character),
        '\u{3000}' => ' ',
        _ => character,
    }
}

/// The scan copy, and for each of its bytes (plus one past the end) the
/// offset in the original text where that character starts.
struct Folded {
    scan: String,
    origin: Vec<usize>,
}

fn fold_text(text: &str) -> Folded {
    let mut scan = String::with_capacity(text.len());
    let mut origin = Vec::with_capacity(text.len() + 1);
    for (offset, character) in text.char_indices() {
        if is_invisible(character) {
            continue;
        }
        let folded = fold(character);
        origin.extend(std::iter::repeat_n(offset, folded.len_utf8()));
        scan.push(folded);
    }
    origin.push(text.len());
    Folded { scan, origin }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Key,
    Credential,
}

#[derive(Debug, Clone, Copy)]
struct Span {
    start: usize,
    end: usize,
    kind: Kind,
}

/// Replace every recognised private key and credential in `text`.
pub fn redact_credentials(text: &str) -> String {
    let folded = fold_text(text);
    let spans = find_spans(&folded.scan);
    if spans.is_empty() {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut position = 0;
    for span in spans {
        let start = folded.origin[span.start];
        let end = folded.origin[span.end];
        if start < position {
            continue;
        }
        out.push_str(&text[position..start]);
        out.push_str(match span.kind {
            Kind::Key => REDACTED_PRIVATE_KEY,
            Kind::Credential => REDACTED_CREDENTIAL,
        });
        position = end;
    }
    out.push_str(&text[position..]);
    out
}

/// Where a private-key block that is still open (or a header that is not
/// finished) starts, if the text ends inside one: the relay holds everything
/// from there until it closes. Covers PEM blocks and base64 key blocks.
pub fn open_private_key_block(text: &str) -> Option<usize> {
    let folded = fold_text(text);
    let scan = folded.scan.as_str();
    let mut open = None;
    for block in pem_blocks(scan) {
        if !block.closed {
            open = Some(block.start);
            break;
        }
    }
    if open.is_none() {
        // A base64 key block reaching the end may still continue.
        open = base64_key_blocks(scan)
            .into_iter()
            .find(|block| scan[block.end..].trim().is_empty())
            .map(|block| block.start);
    }
    open.map(|start| folded.origin[start])
}

fn find_spans(scan: &str) -> Vec<Span> {
    let mut spans: Vec<Span> = Vec::new();
    for block in pem_blocks(scan) {
        spans.push(Span {
            start: block.start,
            end: if block.closed { block.end } else { scan.len() },
            kind: Kind::Key,
        });
    }
    for block in base64_key_blocks(scan) {
        spans.push(Span {
            start: block.start,
            end: block.end,
            kind: Kind::Key,
        });
    }
    spans.extend(token_spans(scan));
    spans.extend(secret_value_spans(scan));
    spans.extend(url_password_spans(scan));
    spans.sort_by_key(|span| (span.start, std::cmp::Reverse(span.end)));
    let mut merged: Vec<Span> = Vec::new();
    for span in spans {
        match merged.last_mut() {
            Some(last) if span.start < last.end => {
                last.end = last.end.max(span.end);
                if span.kind == Kind::Key {
                    last.kind = Kind::Key;
                }
            }
            _ => merged.push(span),
        }
    }
    merged
}

// ---------------------------------------------------------------------------
// PEM blocks
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
struct Block {
    start: usize,
    end: usize,
    closed: bool,
}

/// One `-----BEGIN …-----` / `-----END …-----` line, matched loosely.
#[derive(Debug, Clone, Copy)]
struct Marker {
    start: usize,
    end: usize,
    begin: bool,
    /// The label names a private key — or is not finished and still could.
    private: bool,
}

fn ascii_find_ci(haystack: &str, needle: &str, from: usize) -> Option<usize> {
    let bytes = haystack.as_bytes();
    let needle = needle.as_bytes();
    if needle.is_empty() || bytes.len() < needle.len() {
        return None;
    }
    (from..=bytes.len() - needle.len())
        .find(|&at| bytes[at..at + needle.len()].eq_ignore_ascii_case(needle))
}

fn pem_markers(scan: &str) -> Vec<Marker> {
    let bytes = scan.as_bytes();
    let mut markers = Vec::new();
    for (word, begin) in [("BEGIN", true), ("END", false)] {
        let mut from = 0;
        while let Some(at) = ascii_find_ci(scan, word, from) {
            from = at + word.len();
            // Three or more dashes before the word, spaces allowed between.
            let mut cursor = at;
            while cursor > 0 && bytes[cursor - 1] == b' ' {
                cursor -= 1;
            }
            let dashes_end = cursor;
            while cursor > 0 && bytes[cursor - 1] == b'-' {
                cursor -= 1;
            }
            if dashes_end - cursor < 3 {
                continue;
            }
            let start = cursor;
            // The label runs to the closing dashes on the same line.
            let label_start = at + word.len();
            let line_end = scan[label_start..]
                .find('\n')
                .map_or(scan.len(), |offset| label_start + offset);
            let line = &scan[label_start..line_end];
            let (label, end, finished) = match line.find("---") {
                Some(close) => {
                    let mut end = label_start + close;
                    while end < line_end && bytes[end] == b'-' {
                        end += 1;
                    }
                    (&line[..close], end, true)
                }
                // No closing dashes before the line ends: a header written
                // without them, or one that has not arrived in full yet.
                None => (line, line_end, line_end < scan.len()),
            };
            let names_key = ascii_find_ci(label, "PRIVATE KEY", 0).is_some();
            markers.push(Marker {
                start,
                end,
                begin,
                private: names_key || !finished,
            });
        }
    }
    markers.sort_by_key(|marker| marker.start);
    markers
}

fn pem_blocks(scan: &str) -> Vec<Block> {
    let markers = pem_markers(scan);
    let mut blocks = Vec::new();
    let mut index = 0;
    while index < markers.len() {
        let marker = markers[index];
        index += 1;
        if !marker.begin || !marker.private {
            continue;
        }
        let footer = markers[index..]
            .iter()
            .position(|next| !next.begin && next.private && next.start >= marker.end);
        match footer {
            Some(offset) => {
                let footer = markers[index + offset];
                blocks.push(Block {
                    start: marker.start,
                    end: footer.end,
                    closed: true,
                });
                index += offset + 1;
            }
            None => {
                blocks.push(Block {
                    start: marker.start,
                    end: scan.len(),
                    closed: false,
                });
                break;
            }
        }
    }
    blocks
}

// ---------------------------------------------------------------------------
// base64 key blocks
// ---------------------------------------------------------------------------

fn is_base64_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=' | b'-' | b'_')
}

fn base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    }
}

/// Standard or URL-safe base64, padding ignored, stopping at anything else.
fn decode_base64_lenient(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for &byte in input {
        let Some(value) = base64_value(byte) else {
            break;
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    out
}

fn contains_ci(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window.eq_ignore_ascii_case(needle))
}

/// The start of a base64 key: a run that decodes (at any alignment) to text
/// naming a private key — a PEM file base64-wrapped — or that starts like a
/// DER (`MII…`, EC `MHcCAQEE…`, Ed25519 `MC4CAQAwBQYDK2Vw…`) or OpenSSH
/// (`b3BlbnNzaC1rZXktdjE…`) key body without its PEM lines.
fn is_base64_key_start(run: &str) -> bool {
    if run.len() < 40 {
        return false;
    }
    const BODIES: [&str; 5] = [
        "MII",
        "MHcCAQEE",
        "MHQCAQEE",
        "MC4CAQAwBQYDK2Vw",
        "b3BlbnNzaC1rZXktdjE",
    ];
    if BODIES.iter().any(|body| run.starts_with(body)) {
        return true;
    }
    (0..4).any(|skip| {
        contains_ci(
            &decode_base64_lenient(&run.as_bytes()[skip..]),
            b"PRIVATE KEY",
        )
    })
}

/// Runs of base64 characters, as byte ranges of `scan`.
fn base64_runs(scan: &str) -> Vec<(usize, usize)> {
    let bytes = scan.as_bytes();
    let mut runs = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if is_base64_char(bytes[index]) {
            let start = index;
            while index < bytes.len() && is_base64_char(bytes[index]) {
                index += 1;
            }
            runs.push((start, index));
        } else {
            index += 1;
        }
    }
    runs
}

fn base64_key_blocks(scan: &str) -> Vec<Block> {
    let runs = base64_runs(scan);
    let mut blocks = Vec::new();
    let mut index = 0;
    while index < runs.len() {
        let (start, mut end) = runs[index];
        index += 1;
        if !is_base64_key_start(&scan[start..end]) {
            continue;
        }
        // The lines of base64 that follow belong to the same key.
        while index < runs.len() {
            let (next_start, next_end) = runs[index];
            let between = &scan[end..next_start];
            if between.trim().is_empty() && next_end - next_start >= 16 {
                end = next_end;
                index += 1;
            } else {
                break;
            }
        }
        blocks.push(Block {
            start,
            end,
            closed: true,
        });
    }
    blocks
}

// ---------------------------------------------------------------------------
// tokens
// ---------------------------------------------------------------------------

fn run_len(text: &str, allowed: impl Fn(char) -> bool) -> usize {
    text.char_indices()
        .find(|(_, character)| !allowed(*character))
        .map(|(index, _)| index)
        .unwrap_or(text.len())
}

fn alnum(character: char) -> bool {
    character.is_ascii_alphanumeric()
}

fn base64url(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '_' || character == '-'
}

fn slack(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '-'
}

fn word(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '_'
}

/// A token family: its prefix, the characters of its body, and the shortest
/// body that counts.
type Family = (&'static str, fn(char) -> bool, usize);

/// Prefixes distinctive enough to match wherever they start.
const DISTINCTIVE: &[Family] = &[
    // Anthropic.
    ("sk-ant-", base64url, 20),
    // Stripe secret and restricted keys.
    ("sk_live_", alnum, 16),
    ("rk_live_", alnum, 16),
    ("sk_test_", alnum, 16),
    ("rk_test_", alnum, 16),
    // GitHub.
    ("github_pat_", word, 20),
    ("ghp_", alnum, 30),
    ("gho_", alnum, 30),
    ("ghu_", alnum, 30),
    ("ghs_", alnum, 30),
    ("ghr_", alnum, 30),
    // GitLab personal access tokens.
    ("glpat-", base64url, 20),
    // npm access tokens.
    ("npm_", alnum, 30),
    // Slack bot, user, app and refresh tokens.
    ("xoxa-", slack, 10),
    ("xoxb-", slack, 10),
    ("xoxp-", slack, 10),
    ("xoxr-", slack, 10),
    ("xoxs-", slack, 10),
    ("xoxo-", slack, 10),
    ("xapp-", slack, 10),
    // Google API keys.
    ("AIza", base64url, 35),
];

/// The byte length of a credential token starting exactly at `rest`.
fn token_len(rest: &str, previous: Option<char>) -> Option<usize> {
    for (prefix, allowed, minimum) in DISTINCTIVE {
        if let Some(body) = rest.strip_prefix(prefix) {
            let run = run_len(body, allowed);
            if run >= *minimum {
                return Some(prefix.len() + run);
            }
        }
    }
    let after_alnum = previous.is_some_and(|character| character.is_ascii_alphanumeric());
    if after_alnum {
        return None;
    }
    // OpenAI-style keys (`sk-…`, `sk-proj-…`).
    if let Some(body) = rest.strip_prefix("sk-") {
        let run = run_len(body, base64url);
        return (run >= 20).then_some(3 + run);
    }
    // AWS access key ids: exactly 16 more upper-case alphanumerics.
    if rest.starts_with("AKIA") || rest.starts_with("ASIA") {
        let run = run_len(&rest[4..], |c| c.is_ascii_uppercase() || c.is_ascii_digit());
        return (run == 16).then_some(20);
    }
    // JWTs: three base64url segments, the first two JSON objects (`eyJ`).
    if rest.starts_with("eyJ") {
        let first = run_len(rest, base64url);
        let after_first = &rest[first..];
        if first >= 10 && after_first.starts_with(".eyJ") {
            let second = run_len(&after_first[1..], base64url);
            let after_second = &after_first[1 + second..];
            if second >= 10 && after_second.starts_with('.') {
                let third = run_len(&after_second[1..], base64url);
                if third >= 8 {
                    return Some(first + 1 + second + 1 + third);
                }
            }
        }
    }
    None
}

fn token_spans(scan: &str) -> Vec<Span> {
    let mut spans = Vec::new();
    let mut previous: Option<char> = None;
    let mut index = 0;
    while index < scan.len() {
        let rest = &scan[index..];
        if let Some(length) = token_len(rest, previous) {
            spans.push(Span {
                start: index,
                end: index + length,
                kind: Kind::Credential,
            });
            index += length;
            previous = scan[..index].chars().next_back();
            continue;
        }
        let character = rest.chars().next().expect("index is on a char boundary");
        previous = Some(character);
        index += character.len_utf8();
    }
    spans
}

/// A 40-character value after `secret…` and `=` or `:` on the same line —
/// the AWS secret access key shape (`AWS_SECRET_ACCESS_KEY=…`,
/// `"SecretAccessKey": "…"`).
fn secret_value_spans(scan: &str) -> Vec<Span> {
    let bytes = scan.as_bytes();
    let mut spans = Vec::new();
    let mut from = 0;
    while let Some(at) = ascii_find_ci(scan, "secret", from) {
        from = at + "secret".len();
        let line_end = scan[from..]
            .find('\n')
            .map_or(scan.len(), |offset| from + offset);
        // Up to 40 characters on, on a character boundary.
        let window_end = scan[from..line_end]
            .char_indices()
            .nth(40)
            .map_or(line_end, |(offset, _)| from + offset);
        let Some(separator) = scan[from..window_end].find(['=', ':']) else {
            continue;
        };
        let mut start = from + separator + 1;
        while start < line_end && matches!(bytes[start], b' ' | b'"' | b'\'' | b'\t') {
            start += 1;
        }
        let run = run_len(&scan[start..], |c| {
            c.is_ascii_alphanumeric() || c == '/' || c == '+'
        });
        let next = scan[start + run..].chars().next();
        if run == 40
            && !next.is_some_and(|c| c.is_ascii_alphanumeric() || c == '/' || c == '+' || c == '=')
        {
            spans.push(Span {
                start,
                end: start + run,
                kind: Kind::Credential,
            });
        }
    }
    spans
}

/// The password in `scheme://user:password@host`.
fn url_password_spans(scan: &str) -> Vec<Span> {
    let mut spans = Vec::new();
    let mut from = 0;
    while let Some(offset) = scan[from..].find("://") {
        let authority_start = from + offset + 3;
        from = authority_start;
        let authority_end = scan[authority_start..]
            .find(|c: char| {
                c.is_whitespace() || matches!(c, '/' | '?' | '#' | '"' | '\'' | '<' | '>' | '`')
            })
            .map_or(scan.len(), |end| authority_start + end);
        let authority = &scan[authority_start..authority_end];
        let Some(at) = authority.rfind('@') else {
            continue;
        };
        let userinfo = &authority[..at];
        let Some(colon) = userinfo.find(':') else {
            continue;
        };
        if colon + 1 < at {
            spans.push(Span {
                start: authority_start + colon + 1,
                end: authority_start + at,
                kind: Kind::Credential,
            });
        }
    }
    spans
}

#[cfg(test)]
mod tests {
    use super::*;

    // Synthetic, well-formed shapes — never real. Assembled with `concat!` so
    // the source carries no scanner-shaped literal (scripts/check_secrets.sh
    // scans every ref).
    const SK_ANT: &str = concat!(
        "sk-",
        "ant-api03-",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    );
    const GHP: &str = concat!("ghp", "_abcdefghijklmnopqrstuvwxyz0123456789");
    const AWS: &str = concat!("AKIA", "ABCDEFGHIJKLMNOP");
    const AWS_SECRET: &str = concat!("wJalrXUtnFEMI/K7MDENG/", "bPxRfiCYEXAMPLEKEY");
    const STRIPE: &str = concat!("sk_", "live_", "4eC39HqLyjWDarjtT1zdp7dc");
    const NPM: &str = concat!("npm", "_abcdefghijklmnopqrstuvwxyz0123456789");
    const GLPAT: &str = concat!("glpat", "-abcdefghij0123456789");
    const GOOGLE: &str = concat!("AIza", "SyA-abcdefghijklmnopqrstuvwxyz01234");
    const XAPP: &str = concat!("xapp", "-1-A0123456789-0123456789-abcdef");
    const PEM_BODY: &str = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ";

    fn masked(text: &str) -> String {
        redact_credentials(text)
    }

    #[test]
    fn the_known_families_are_masked() {
        for token in [SK_ANT, GHP, AWS, STRIPE, NPM, GLPAT, GOOGLE, XAPP] {
            let text = format!("key {token} end");
            assert_eq!(
                masked(&text),
                format!("key {REDACTED_CREDENTIAL} end"),
                "{token}"
            );
        }
        assert_eq!(
            masked(&format!("AWS_SECRET_ACCESS_KEY={AWS_SECRET}\n")),
            format!("AWS_SECRET_ACCESS_KEY={REDACTED_CREDENTIAL}\n")
        );
        assert_eq!(
            masked(&format!("{{\"SecretAccessKey\": \"{AWS_SECRET}\"}}")),
            format!("{{\"SecretAccessKey\": \"{REDACTED_CREDENTIAL}\"}}")
        );
        assert_eq!(
            masked("postgres://momo:hunter2secret@db:5432/momo"),
            format!("postgres://momo:{REDACTED_CREDENTIAL}@db:5432/momo")
        );
    }

    #[test]
    fn invisible_and_fullwidth_characters_do_not_hide_a_token() {
        // #2607 N-2: ZWJ, soft hyphen, a tag character inside the token.
        for inserted in ['\u{200D}', '\u{00AD}', '\u{E0041}', '\u{FE0F}'] {
            let mut disguised = String::from(&SK_ANT[..10]);
            disguised.push(inserted);
            disguised.push_str(&SK_ANT[10..]);
            let text = format!("key {disguised} end");
            assert_eq!(
                masked(&text),
                format!("key {REDACTED_CREDENTIAL} end"),
                "{inserted:?}"
            );
        }
        // Fullwidth letters.
        let fullwidth: String = GHP
            .chars()
            .map(|c| char::from_u32(c as u32 + 0xFEE0).unwrap())
            .collect();
        assert_eq!(
            masked(&format!("a {fullwidth} b")),
            format!("a {REDACTED_CREDENTIAL} b")
        );
    }

    #[test]
    fn a_prefix_glued_to_a_word_is_still_masked() {
        // #2607 N-2: `_sk-…` and `token-ghp_…`.
        assert_eq!(
            masked(&format!("x_{SK_ANT}")),
            format!("x_{REDACTED_CREDENTIAL}")
        );
        assert_eq!(
            masked(&format!("token-{GHP}")),
            format!("token-{REDACTED_CREDENTIAL}")
        );
        let generic = concat!("sk-", "proj-abcdefghijklmnopqrstuvwxyz");
        assert_eq!(
            masked(&format!("key=_{generic}")),
            format!("key=_{REDACTED_CREDENTIAL}")
        );
    }

    #[test]
    fn words_that_merely_contain_a_prefix_are_left_alone() {
        for text in [
            "risk-assessment of the rollout",
            "the task-runner and ghost_mode",
            "AKIA is a prefix",
            "eyJ.not.a.jwt",
            "a secret = short",
            "https://example.com/path?q=1",
            "user:pass without a scheme",
            "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
        ] {
            assert_eq!(masked(text), text);
        }
    }

    #[test]
    fn loose_pem_headers_and_wrapped_or_headless_keys_are_masked() {
        // #2607 N-2: lower case, four dashes.
        let lower = concat!(
            "before\n----begin rsa ",
            "private key----\nMIIEow\n----end rsa ",
            "private key----\nafter"
        );
        assert_eq!(
            masked(lower),
            format!("before\n{REDACTED_PRIVATE_KEY}\nafter")
        );
        // A PEM file wrapped in base64.
        let pem = concat!(
            "-----BEGIN RSA ",
            "PRIVATE KEY-----\nMIIEowIBAAKCAQEAxyz\n-----END RSA ",
            "PRIVATE KEY-----\n"
        );
        let wrapped = encode_base64(pem.as_bytes());
        assert_eq!(
            masked(&format!("blob: {wrapped} done")),
            format!("blob: {REDACTED_PRIVATE_KEY} done")
        );
        // A key body without its PEM lines, over several lines.
        let body = format!("{PEM_BODY}AAAABbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZWQy\nNTUxOQAAACB1c2VyQGhvc3QAAAAAAAAAAAAAAAAAAAAAAAAA\n");
        assert_eq!(
            masked(&format!("key:\n{body}thanks")),
            format!("key:\n{REDACTED_PRIVATE_KEY}\nthanks")
        );
    }

    #[test]
    fn an_open_block_is_reported_and_masked_to_the_end() {
        let open = concat!("before\n-----BEGIN RSA ", "PRIVATE KEY-----\nMIIEow");
        assert_eq!(masked(open), format!("before\n{REDACTED_PRIVATE_KEY}"));
        assert_eq!(open_private_key_block(open), Some("before\n".len()));
        assert_eq!(open_private_key_block("-----BEGIN OPENSSH PRIV"), Some(0));
        assert_eq!(open_private_key_block("nothing here"), None);
        let closed = concat!(
            "-----BEGIN RSA ",
            "PRIVATE KEY-----\nMIIEow\n-----END RSA ",
            "PRIVATE KEY-----\n"
        );
        assert_eq!(open_private_key_block(closed), None);
        // An invisible character before the header still reports the original offset.
        let shifted = format!("a\u{200D}b\n{open}");
        assert_eq!(
            open_private_key_block(&shifted),
            Some("a\u{200D}b\nbefore\n".len())
        );
    }

    fn encode_base64(input: &[u8]) -> String {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in input.chunks(3) {
            let b = [
                chunk[0],
                *chunk.get(1).unwrap_or(&0),
                *chunk.get(2).unwrap_or(&0),
            ];
            let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
            for i in 0..4 {
                if i <= chunk.len() {
                    out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
                } else {
                    out.push('=');
                }
            }
        }
        out
    }
}
