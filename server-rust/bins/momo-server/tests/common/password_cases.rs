#![allow(dead_code)]
//! The passwords ADR-0215 D2 is judged on — one table shared by the three suites
//! that hold a route to it (`claim_conformance_pg`, `join_conformance_pg`,
//! `password_reset_conformance_pg`), so the paths cannot be tested against
//! different rules. The rule itself (10 characters minimum, 72 bytes maximum, no
//! normalisation) is `momo_auth::password_rules`.
//!
//! Every non-ASCII value is spelled with escapes: an editor or a formatter that
//! normalised the literal would silently test a different string.

/// Hangul "한" precomposed (NFC): 3 bytes, 1 scalar value.
pub const NFC_HAN: &str = "\u{D55C}";
/// The same syllable decomposed (NFD): ᄒ + ᅡ + ᆫ — 9 bytes, 3 scalar values.
pub const NFD_HAN: &str = "\u{1112}\u{1161}\u{11AB}";
/// An emoji: 4 bytes, 1 scalar value.
pub const EMOJI: &str = "\u{1F600}";

/// Exactly ten characters: the shortest password the rule accepts.
pub const TEN_CHARS: &str = "abcdefghij";
/// Nine characters: one short of the rule.
pub const NINE_CHARS: &str = "abcdefghi";
/// The NUL character (U+0000) — the one character the rule refuses outright.
pub const NUL: &str = "\u{0}";

/// `(case, password, error.code)` — every one of these is a 400 on every path
/// that sets a password.
pub fn refused() -> Vec<(&'static str, String, &'static str)> {
    vec![
        (
            "nine ASCII characters",
            NINE_CHARS.to_string(),
            "password_too_short",
        ),
        (
            "nine Hangul syllables: 27 bytes but only 9 characters",
            NFC_HAN.repeat(9),
            "password_too_short",
        ),
        (
            "nine emoji: 36 bytes but only 9 characters",
            EMOJI.repeat(9),
            "password_too_short",
        ),
        ("73 ASCII bytes", "a".repeat(73), "password_too_long"),
        (
            "24 Hangul syllables and one more byte: 73 bytes but only 25 characters",
            format!("{}a", NFC_HAN.repeat(24)),
            "password_too_long",
        ),
        (
            "25 Hangul syllables: 75 bytes",
            NFC_HAN.repeat(25),
            "password_too_long",
        ),
        ("19 emoji: 76 bytes", EMOJI.repeat(19), "password_too_long"),
        (
            "nine decomposed Hangul syllables: 81 bytes, so NFD reaches the ceiling first",
            NFD_HAN.repeat(9),
            "password_too_long",
        ),
        (
            "1025 characters: over the old ceiling too",
            "a".repeat(1025),
            "password_too_long",
        ),
        // Each NUL row below is a password the rule would accept were the NUL any
        // other character (ten characters or more, 72 bytes or fewer), so the NUL
        // is the only thing wrong with it — a NUL check that is missing turns
        // these rows, and only these rows, from 400 into the database's 500.
        (
            "the tenth of ten characters is a NUL",
            format!("{}{NUL}", NINE_CHARS),
            "password_invalid_char",
        ),
        (
            "a NUL first",
            format!("{NUL}{TEN_CHARS}"),
            "password_invalid_char",
        ),
        (
            "a NUL in the middle",
            format!("abcde{NUL}fghij"),
            "password_invalid_char",
        ),
        (
            "ten characters, then a NUL where bcrypt would stop reading, then more",
            format!("ten-chars!{NUL}and-then-some-more"),
            "password_invalid_char",
        ),
        (
            "71 ASCII bytes and a NUL: exactly 72 bytes",
            format!("{}{NUL}", "a".repeat(71)),
            "password_invalid_char",
        ),
    ]
}

/// `(case, password)` — every one of these is accepted, stored as typed, and
/// signs in with exactly the same string.
pub fn accepted() -> Vec<(&'static str, String)> {
    vec![
        ("ten ASCII characters", TEN_CHARS.to_string()),
        ("72 ASCII bytes", "a".repeat(72)),
        (
            "24 Hangul syllables: exactly 72 bytes",
            NFC_HAN.repeat(24),
        ),
        (
            "ten Hangul syllables: 30 bytes, enough characters",
            NFC_HAN.repeat(10),
        ),
        ("18 emoji: exactly 72 bytes", EMOJI.repeat(18)),
        (
            "eight decomposed Hangul syllables: exactly 72 bytes",
            NFD_HAN.repeat(8),
        ),
        (
            "five decomposed Hangul syllables: 15 scalar values, which would be 5 if the server normalised",
            NFD_HAN.repeat(5),
        ),
        (
            "padded with spaces: ten characters, six letters, not trimmed",
            "  abcdef  ".to_string(),
        ),
    ]
}
