//! The password rule (ADR-0215 D2, #4593).
//!
//! Two validators, and the split is the point.
//!
//! * [`normalized_new_password`] judges a password somebody is **choosing**:
//!   `POST /v1/join`, `POST /v1/claim` (the first owner's bootstrap included),
//!   `PATCH …/members/me/password`'s `newPassword`, and the signed reset the
//!   device route will add (ADR-0215 D7). One function, so those paths cannot
//!   drift apart.
//! * [`normalized_current_password`] judges a password somebody is **proving**:
//!   `PATCH …/members/me/password`'s `currentPassword`, and the admin's
//!   re-entered password on the reset-link issue (ADR-0215 D6). It only bounds
//!   the work the hash can be made to do. Holding it to the new rule would lock
//!   out every account whose password predates the rule — the people who most
//!   need to change it.
//!
//! Login uses neither. `verify_password_login` refuses an empty password and
//! nothing else, so an account that exists keeps signing in with the password it
//! has.
//!
//! ## The new rule
//!
//! * **At least [`NEW_PASSWORD_MIN_CHARS`] characters**, counted as Unicode
//!   scalar values of the input exactly as sent (owner decision 2026-10-26).
//! * **At most [`NEW_PASSWORD_MAX_BYTES`] bytes of UTF-8.** `gen_salt('bf')` is
//!   bcrypt, which reads the first 72 bytes and ignores the rest, so two
//!   passwords that agree on them hash alike. A longer one is refused, never
//!   truncated. This is a *byte* ceiling: a Korean syllable is 3 bytes (24
//!   syllables fit) and an emoji is 4 (18 fit).
//! * **No normalisation, no trimming, no composition rule.** Login compares the
//!   bytes it is handed, so a value this module rewrote would no longer sign in.
//!   Hangul typed as decomposed jamo (NFD) is one scalar value per jamo, so it
//!   clears the minimum sooner and meets the byte ceiling sooner; refusing at the
//!   ceiling is the safe side.
//! * **One character is refused: NUL (U+0000).** It is not a composition rule, it
//!   is a character the stack cannot carry. Postgres `text` cannot hold a NUL
//!   (the hash is computed inside Postgres, so a NUL reaches the database and
//!   becomes a 500), and bcrypt is a C-string function that reads up to the first
//!   NUL, so a value that did get through would hash only the part before it —
//!   two different passwords would be one. Refusing it is the safe side for both
//!   (planner decision on #4593, 2026-10-26). `normalized_current_password` does
//!   not look for it: a login or a current password containing NUL is a separate
//!   path with its own answer (#4597).
//!
//! The check order is cheap-first: the byte length is read from the string
//! header before any character is counted, and the character scans (the count,
//! then the NUL search) run only on a value already known to be at most 72 bytes,
//! so an oversized body never costs a scan.

/// Fewest characters (Unicode scalar values, input as sent) a newly chosen
/// password may have. Owner decision 2026-10-26, ADR-0215 D2.
pub const NEW_PASSWORD_MIN_CHARS: usize = 10;

/// Most UTF-8 bytes a newly chosen password may have: the part of the input
/// bcrypt (`gen_salt('bf')`) actually hashes.
pub const NEW_PASSWORD_MAX_BYTES: usize = 72;

/// Ceiling on a password somebody *proves*. It bounds hash work and nothing
/// else; it is the rule `POST /v1/claim`, `/v1/join` and the change route all
/// had before ADR-0215.
pub const CURRENT_PASSWORD_MAX_CHARS: usize = 1024;

/// `error.code` of a new password under [`NEW_PASSWORD_MIN_CHARS`].
pub const PASSWORD_TOO_SHORT_CODE: &str = "password_too_short";

/// `error.code` of a new password over [`NEW_PASSWORD_MAX_BYTES`].
pub const PASSWORD_TOO_LONG_CODE: &str = "password_too_long";

/// `error.code` of a new password that contains a NUL character (U+0000).
pub const PASSWORD_INVALID_CHAR_CODE: &str = "password_invalid_char";

/// Why a password somebody is choosing was refused.
///
/// The three real refusals carry a stable machine code (the sentence may be
/// reworded, the code may not). [`Self::Missing`] is the empty string and keeps
/// the code-less sentence every one of these routes answered before ADR-0215.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum NewPasswordInvalid {
    #[error("password is required")]
    Missing,
    #[error("password must be at least 10 characters")]
    TooShort,
    #[error("password must be at most 72 bytes in UTF-8")]
    TooLong,
    /// A NUL character (U+0000) anywhere in an otherwise acceptable password.
    #[error("password must not contain a NUL character")]
    InvalidChar,
}

impl NewPasswordInvalid {
    /// The wire `error.code`, or `None` for the refusals that never had one.
    pub const fn code(self) -> Option<&'static str> {
        match self {
            NewPasswordInvalid::Missing => None,
            NewPasswordInvalid::TooShort => Some(PASSWORD_TOO_SHORT_CODE),
            NewPasswordInvalid::TooLong => Some(PASSWORD_TOO_LONG_CODE),
            NewPasswordInvalid::InvalidChar => Some(PASSWORD_INVALID_CHAR_CODE),
        }
    }
}

/// Why a password somebody is proving was refused. Code-less, byte-for-byte the
/// two sentences these routes answered before ADR-0215.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum CurrentPasswordInvalid {
    #[error("password is required")]
    Missing,
    #[error("password is too long")]
    TooLong,
}

/// Judge a password that is being **chosen** (ADR-0215 D2). Returns it
/// unchanged: no trimming, no Unicode normalisation. Refuses the empty string,
/// fewer than [`NEW_PASSWORD_MIN_CHARS`] characters, more than
/// [`NEW_PASSWORD_MAX_BYTES`] bytes, and a NUL character, in that order.
pub fn normalized_new_password(raw: &str) -> Result<String, NewPasswordInvalid> {
    if raw.is_empty() {
        return Err(NewPasswordInvalid::Missing);
    }
    // Bytes, not characters. `str::len` is the UTF-8 byte length.
    if raw.len() > NEW_PASSWORD_MAX_BYTES {
        return Err(NewPasswordInvalid::TooLong);
    }
    // Characters, not bytes. At most 72 bytes here, so this scan is bounded.
    if raw.chars().count() < NEW_PASSWORD_MIN_CHARS {
        return Err(NewPasswordInvalid::TooShort);
    }
    // The one character the stack cannot carry (see the module docs). Bounded
    // for the same reason, and after the length checks so that a value which is
    // wrong in two ways is told about its length first.
    if raw.contains('\0') {
        return Err(NewPasswordInvalid::InvalidChar);
    }
    Ok(raw.to_string())
}

/// Judge a password that is being **proved**: present, and not so long that
/// hashing it is a way to burn database CPU. Deliberately blind to
/// [`NEW_PASSWORD_MIN_CHARS`] — an account whose password predates the rule must
/// still be able to change it.
pub fn normalized_current_password(raw: &str) -> Result<String, CurrentPasswordInvalid> {
    if raw.is_empty() {
        return Err(CurrentPasswordInvalid::Missing);
    }
    if raw.chars().count() > CURRENT_PASSWORD_MAX_CHARS {
        return Err(CurrentPasswordInvalid::TooLong);
    }
    Ok(raw.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// "한" typed as a decomposed jamo sequence: ᄒ + ᅡ + ᆫ. Spelled with escapes
    /// so no editor or formatter can recompose the literal into one syllable.
    const NFD_HAN: &str = "\u{1112}\u{1161}\u{11AB}";
    /// The same syllable, precomposed (NFC).
    const NFC_HAN: &str = "\u{D55C}";

    fn repeat(unit: &str, times: usize) -> String {
        unit.repeat(times)
    }

    #[test]
    fn the_constants_are_the_owners_numbers() {
        assert_eq!(NEW_PASSWORD_MIN_CHARS, 10);
        assert_eq!(NEW_PASSWORD_MAX_BYTES, 72);
        assert_eq!(CURRENT_PASSWORD_MAX_CHARS, 1024);
    }

    /// The sentences quote the numbers; a number changed in one place must not
    /// leave the other telling a client the old rule.
    #[test]
    fn the_sentences_quote_the_same_numbers_as_the_constants() {
        assert!(NewPasswordInvalid::TooShort
            .to_string()
            .contains(&NEW_PASSWORD_MIN_CHARS.to_string()));
        assert!(NewPasswordInvalid::TooLong
            .to_string()
            .contains(&NEW_PASSWORD_MAX_BYTES.to_string()));
    }

    #[test]
    fn nine_characters_is_too_short_and_ten_is_enough() {
        assert_eq!(
            normalized_new_password(&repeat("a", 9)),
            Err(NewPasswordInvalid::TooShort)
        );
        assert_eq!(
            normalized_new_password(&repeat("a", 10)),
            Ok(repeat("a", 10))
        );
    }

    #[test]
    fn seventy_two_bytes_is_enough_and_seventy_three_is_too_long() {
        assert_eq!(
            normalized_new_password(&repeat("a", 72)),
            Ok(repeat("a", 72))
        );
        assert_eq!(
            normalized_new_password(&repeat("a", 73)),
            Err(NewPasswordInvalid::TooLong)
        );
    }

    /// The minimum counts characters. Nine Hangul syllables are 27 bytes and
    /// still short; ten are enough.
    #[test]
    fn the_minimum_counts_characters_not_bytes() {
        let nine = repeat(NFC_HAN, 9);
        assert_eq!(nine.len(), 27);
        assert_eq!(
            normalized_new_password(&nine),
            Err(NewPasswordInvalid::TooShort)
        );
        let ten = repeat(NFC_HAN, 10);
        assert_eq!(normalized_new_password(&ten), Ok(ten));
    }

    /// The ceiling counts bytes. 24 Hangul syllables are 72 bytes and fit; one
    /// more ASCII byte is 73 and does not, though it is only 25 characters.
    #[test]
    fn the_ceiling_counts_bytes_not_characters() {
        let fits = repeat(NFC_HAN, 24);
        assert_eq!(fits.len(), 72);
        assert_eq!(normalized_new_password(&fits), Ok(fits.clone()));

        let one_byte_over = format!("{fits}a");
        assert_eq!(one_byte_over.len(), 73);
        assert_eq!(one_byte_over.chars().count(), 25);
        assert_eq!(
            normalized_new_password(&one_byte_over),
            Err(NewPasswordInvalid::TooLong)
        );
        // 25 syllables: 75 bytes, 25 characters.
        assert_eq!(
            normalized_new_password(&repeat(NFC_HAN, 25)),
            Err(NewPasswordInvalid::TooLong)
        );
    }

    /// An emoji is one character and four bytes.
    #[test]
    fn an_emoji_is_four_bytes() {
        let fits = repeat("\u{1F600}", 18);
        assert_eq!(fits.len(), 72);
        assert_eq!(normalized_new_password(&fits), Ok(fits));
        assert_eq!(
            normalized_new_password(&repeat("\u{1F600}", 19)),
            Err(NewPasswordInvalid::TooLong)
        );
        // Nine emoji: 36 bytes, 9 characters.
        assert_eq!(
            normalized_new_password(&repeat("\u{1F600}", 9)),
            Err(NewPasswordInvalid::TooShort)
        );
    }

    /// Nothing is normalised. Five decomposed syllables are fifteen scalar
    /// values and clear the minimum; recomposed they would be five characters
    /// and be refused — so passing proves the input was not rewritten. The
    /// decomposed form also reaches the byte ceiling at eight syllables (nine
    /// bytes each).
    #[test]
    fn hangul_is_judged_as_typed_without_normalisation() {
        let five_nfd = repeat(NFD_HAN, 5);
        assert_eq!(five_nfd.chars().count(), 15);
        assert_eq!(normalized_new_password(&five_nfd), Ok(five_nfd));
        assert_eq!(
            normalized_new_password(&repeat(NFC_HAN, 5)),
            Err(NewPasswordInvalid::TooShort),
            "the same five syllables precomposed are only five characters"
        );

        let eight_nfd = repeat(NFD_HAN, 8);
        assert_eq!(eight_nfd.len(), 72);
        assert_eq!(normalized_new_password(&eight_nfd), Ok(eight_nfd));
        let nine_nfd = repeat(NFD_HAN, 9);
        assert_eq!(nine_nfd.len(), 81);
        assert_eq!(
            normalized_new_password(&nine_nfd),
            Err(NewPasswordInvalid::TooLong)
        );
    }

    /// Whitespace is a character like any other: it counts, it is not trimmed
    /// away, and it is not refused. Six letters padded to ten characters pass
    /// (trimmed they would be six); padded to nine they are short.
    #[test]
    fn spaces_are_neither_trimmed_nor_refused() {
        let ten = "  abcdef  ";
        assert_eq!(ten.chars().count(), 10);
        assert_eq!(normalized_new_password(ten), Ok(ten.to_string()));
        let nine = "  abcdef ";
        assert_eq!(nine.chars().count(), 9);
        assert_eq!(
            normalized_new_password(nine),
            Err(NewPasswordInvalid::TooShort)
        );
    }

    #[test]
    fn an_empty_new_password_keeps_the_code_less_required_sentence() {
        assert_eq!(
            normalized_new_password(""),
            Err(NewPasswordInvalid::Missing)
        );
        assert_eq!(NewPasswordInvalid::Missing.code(), None);
        assert_eq!(
            NewPasswordInvalid::Missing.to_string(),
            "password is required"
        );
    }

    #[test]
    fn the_three_refusals_name_themselves() {
        assert_eq!(
            NewPasswordInvalid::TooShort.code(),
            Some("password_too_short")
        );
        assert_eq!(
            NewPasswordInvalid::TooLong.code(),
            Some("password_too_long")
        );
        assert_eq!(
            NewPasswordInvalid::InvalidChar.code(),
            Some("password_invalid_char")
        );
    }

    /// A NUL is refused wherever it sits, and each of these is a password that
    /// would be accepted if the NUL were any other character: ten or more
    /// characters and at most 72 bytes. That is what makes the NUL the only
    /// thing wrong — remove the NUL check and every row turns green.
    #[test]
    fn a_nul_character_is_refused_wherever_it_sits() {
        let at_the_limit_of_the_bytes = format!("{}\0", "a".repeat(71));
        assert_eq!(at_the_limit_of_the_bytes.len(), NEW_PASSWORD_MAX_BYTES);
        let hangul_with_nul = format!("{}\0", repeat(NFC_HAN, 23));
        assert_eq!(hangul_with_nul.len(), 70);
        for (case, password) in [
            ("the tenth character", "abcdefghi\0".to_string()),
            ("the first character", "\0abcdefghij".to_string()),
            ("the middle", "abcde\0fghij".to_string()),
            ("the last of many", "abcdefghijklmnop\0".to_string()),
            (
                "where bcrypt would stop reading",
                "ten-chars!\0and-then-some-more".to_string(),
            ),
            ("the 72nd byte", at_the_limit_of_the_bytes),
            ("after Hangul", hangul_with_nul),
        ] {
            assert!(
                password.chars().count() >= NEW_PASSWORD_MIN_CHARS
                    && password.len() <= NEW_PASSWORD_MAX_BYTES,
                "{case}: the row must be valid but for its NUL"
            );
            assert_eq!(
                normalized_new_password(&password),
                Err(NewPasswordInvalid::InvalidChar),
                "{case}"
            );
        }
    }

    /// Only NUL is refused. Every other control character, and the characters a
    /// terminal or a form might mangle, are ordinary password characters: this is
    /// not a composition rule.
    #[test]
    fn only_nul_is_refused_not_other_control_characters() {
        for (case, password) in [
            ("tab", "abcde\tfghij"),
            ("newline", "abcde\nfghij"),
            ("carriage return", "abcde\rfghij"),
            ("bell", "abcde\u{7}fghij"),
            ("unit separator", "abcde\u{1F}fghij"),
            ("delete", "abcde\u{7F}fghij"),
            ("zero-width space", "abcde\u{200B}fghij"),
        ] {
            assert_eq!(
                normalized_new_password(password),
                Ok(password.to_string()),
                "{case}"
            );
        }
    }

    /// A value that is wrong in two ways is told about its length: the NUL
    /// search runs last, on a value already known to be small.
    #[test]
    fn a_wrong_length_is_reported_before_a_nul() {
        // 9 characters, one of them NUL.
        assert_eq!(
            normalized_new_password("abcdefgh\0"),
            Err(NewPasswordInvalid::TooShort)
        );
        // 73 bytes, one of them NUL.
        let long = format!("{}\0", "a".repeat(72));
        assert_eq!(
            normalized_new_password(&long),
            Err(NewPasswordInvalid::TooLong)
        );
    }

    #[test]
    fn the_nul_sentence_says_what_to_remove() {
        assert_eq!(
            NewPasswordInvalid::InvalidChar.to_string(),
            "password must not contain a NUL character"
        );
    }

    /// The proving password is blind to the new minimum: a nine-character
    /// password that predates the rule is a perfectly good *current* password.
    #[test]
    fn a_short_current_password_is_accepted() {
        for short in ["a", "hunter2", "123456789"] {
            assert_eq!(
                normalized_current_password(short),
                Ok(short.to_string()),
                "{short:?}"
            );
        }
        // And the byte ceiling does not apply either: a current password longer
        // than 72 bytes is still a candidate to verify.
        let long = repeat("a", 200);
        assert_eq!(normalized_current_password(&long), Ok(long));
    }

    #[test]
    fn a_current_password_is_present_and_bounded_by_characters() {
        assert_eq!(
            normalized_current_password(""),
            Err(CurrentPasswordInvalid::Missing)
        );
        assert_eq!(
            normalized_current_password(&repeat("a", 1024)),
            Ok(repeat("a", 1024))
        );
        assert_eq!(
            normalized_current_password(&repeat("a", 1025)),
            Err(CurrentPasswordInvalid::TooLong)
        );
        // 1024 Hangul syllables: 3072 bytes, but 1024 characters — still in.
        assert_eq!(
            normalized_current_password(&repeat(NFC_HAN, 1024)),
            Ok(repeat(NFC_HAN, 1024))
        );
        assert_eq!(
            normalized_current_password(&repeat(NFC_HAN, 1025)),
            Err(CurrentPasswordInvalid::TooLong)
        );
    }

    /// Byte-for-byte what these routes said before ADR-0215.
    #[test]
    fn the_current_password_sentences_are_the_old_ones() {
        assert_eq!(
            CurrentPasswordInvalid::Missing.to_string(),
            "password is required"
        );
        assert_eq!(
            CurrentPasswordInvalid::TooLong.to_string(),
            "password is too long"
        );
    }
}
