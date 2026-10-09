//! What a folder's display name may contain (ADR-0188 D6, #3590) — one rule for
//! the host that makes the name, the server that accepts it, and (by a test that
//! feeds every range below to Postgres) `work_host_folder_name_ck`.
//!
//! A name is shown to people and must never be a path or look like one:
//! * ASCII and look-alike path separators (`/` `\` and U+2044, U+2215, U+2216,
//!   U+29F5, U+29F8, U+FF0F, U+FF3C);
//! * control characters (Cc) and the format characters (Cf) that reorder or hide
//!   text (U+202E right-to-left override, zero-width spaces and joiners, BOM).

/// Inclusive code point ranges refused in a folder display name, beyond Cc.
/// Keep in step with the `\u…` class in `server/Migrations/121_work_host_folder.sql`.
pub const FORBIDDEN_NAME_RANGES: &[(u32, u32)] = &[
    (0x002F, 0x002F),
    (0x005C, 0x005C),
    (0x00AD, 0x00AD),
    (0x0600, 0x0605),
    (0x061C, 0x061C),
    (0x06DD, 0x06DD),
    (0x070F, 0x070F),
    (0x08E2, 0x08E2),
    (0x180E, 0x180E),
    (0x200B, 0x200F),
    (0x202A, 0x202E),
    (0x2044, 0x2044),
    (0x2060, 0x2064),
    (0x2066, 0x206F),
    (0x2215, 0x2216),
    (0x29F5, 0x29F5),
    (0x29F8, 0x29F8),
    (0xFEFF, 0xFEFF),
    (0xFF0F, 0xFF0F),
    (0xFF3C, 0xFF3C),
    (0xFFF9, 0xFFFB),
    (0xE0001, 0xE0001),
    (0xE0020, 0xE007F),
];

/// Whether `c` may not appear in a folder display name.
pub fn is_forbidden_name_char(c: char) -> bool {
    let cp = c as u32;
    c.is_control()
        || FORBIDDEN_NAME_RANGES
            .iter()
            .any(|&(lo, hi)| (lo..=hi).contains(&cp))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn separators_lookalikes_and_invisibles_are_refused() {
        for c in [
            '/', '\\', '\u{2044}', '\u{2215}', '\u{FF0F}', '\u{202E}', '\u{200B}', '\u{200D}',
            '\u{FEFF}', '\u{2066}', '\n', '\u{0}',
        ] {
            assert!(is_forbidden_name_char(c), "{:04X}", c as u32);
        }
        for c in ['가', 'a', ' ', '-', '_', '.', '(', '😀'] {
            assert!(!is_forbidden_name_char(c), "{c}");
        }
    }
}
