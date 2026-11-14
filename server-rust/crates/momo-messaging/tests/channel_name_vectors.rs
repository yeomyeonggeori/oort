//! ADR-0225 D11 (#5827): the channel name rule against the **shared vectors**,
//! `docs/api/channel-name.vectors.json` — the ADR's 57-row table moved into a
//! file the server, the shared core and the `oort` CLI all read, so the three
//! cannot drift apart. The expected values came from a reference implementation
//! on Unicode 14.0.0 (Python `unicodedata`); the server's tables are newer
//! (`unicode-properties` / `unicode-normalization` 17.0.0, `std` for lowercase
//! and `White_Space`), so a pass here is also the proof that the two versions
//! agree on every vector character.
//!
//! The file is ASCII only; every other character is a `\u` escape, so no editor
//! can quietly compose the decomposed Hangul or drop a zero-width space. It is
//! read from a test only (the server image does not copy `docs/api`), and the
//! PR CI rust filter covers `docs/api/*.vectors.json`.
//!
//! | test | proves | goes red if |
//! |---|---|---|
//! | `every_vector_gives_the_tables_answer` | all 57 rows: the stored value or the exact one of five refusals, and the server's two-error mapping | any one check (NFC, fullwidth fold, a blank, lowercase, length, hidden, letters, marks, edges) changes one row's answer |
//! | `every_stored_value_is_a_fixed_point` | an `ok` row's stored value folds to itself and is accepted again | normalizing twice moves a name |
//! | `the_file_is_the_adr_table` | 57 rows in the ADR's three groups, every refusal reason present, ASCII only | the table loses a row or a reason, or a raw non-ASCII character lands in it |
//! | `every_old_rule_name_is_kept_unchanged` | every name over `[az09_-]` up to 5 chars (and 80/81) is accepted by the new rule exactly when the old one took it, with the same stored value | the new rule refuses or rewrites a name the old one stored |
//! | `the_servers_unicode_tables_are_not_older_than_the_vectors` | the server's General_Category, normalization and `std` tables are at least the vectors' version | a dependency is downgraded below the table the expected values came from |

use momo_messaging::{
    fold_channel_name, judge_channel_name, normalize_channel_name, ChannelNameRefusal,
    ChannelSpecInvalid, CHANNEL_NAME_MAX_CHARS,
};
use serde_json::Value;

const VECTORS: &str = include_str!("../../../../docs/api/channel-name.vectors.json");

fn doc() -> Value {
    serde_json::from_str(VECTORS).expect("channel name vectors parse")
}

fn cases() -> Vec<Value> {
    doc()["cases"].as_array().expect("cases array").clone()
}

fn text<'a>(case: &'a Value, key: &str) -> &'a str {
    case[key]
        .as_str()
        .unwrap_or_else(|| panic!("string field {key} in {case}"))
}

/// A readable name for a failing row (the inputs themselves may be invisible).
fn label(case: &Value) -> String {
    format!(
        "{} ({})",
        text(case, "note"),
        text(case, "input").escape_unicode()
    )
}

fn answer(raw: &str) -> Result<String, &'static str> {
    judge_channel_name(raw).map_err(ChannelNameRefusal::vector_label)
}

#[test]
fn every_vector_gives_the_tables_answer() {
    let doc = doc();
    let length_errors: Vec<&str> = doc["serverErrors"]["length"]
        .as_array()
        .expect("length errors")
        .iter()
        .map(|v| v.as_str().expect("label"))
        .collect();
    let charset_errors: Vec<&str> = doc["serverErrors"]["charset"]
        .as_array()
        .expect("charset errors")
        .iter()
        .map(|v| v.as_str().expect("label"))
        .collect();

    let mut checked = 0;
    for case in cases() {
        let input = text(&case, "input");
        let verdict = text(&case, "verdict");
        if verdict == "ok" {
            let stored = text(&case, "stored");
            assert_eq!(answer(input), Ok(stored.to_string()), "{}", label(&case));
            assert_eq!(
                normalize_channel_name(input),
                Ok(stored.to_string()),
                "{}",
                label(&case)
            );
        } else {
            assert!(case.get("stored").is_none(), "{}", label(&case));
            assert_eq!(answer(input), Err(verdict), "{}", label(&case));
            let server = if length_errors.contains(&verdict) {
                ChannelSpecInvalid::NameLength
            } else {
                assert!(charset_errors.contains(&verdict), "{}", label(&case));
                ChannelSpecInvalid::NameCharset
            };
            assert_eq!(
                normalize_channel_name(input),
                Err(server),
                "{}",
                label(&case)
            );
        }
        checked += 1;
    }
    assert_eq!(checked, 57);
}

#[test]
fn every_stored_value_is_a_fixed_point() {
    let mut checked = 0;
    for case in cases() {
        let input = text(&case, "input");
        if text(&case, "verdict") != "ok" {
            continue;
        }
        let stored = text(&case, "stored");
        assert_eq!(fold_channel_name(stored), stored, "{}", label(&case));
        assert_eq!(answer(stored), Ok(stored.to_string()), "{}", label(&case));
        // The fold of the input is the stored value, so a lookup that folds a
        // typed name (CLI, B3) lands on the row the create stored.
        assert_eq!(fold_channel_name(input), stored, "{}", label(&case));
        checked += 1;
    }
    assert_eq!(checked, 34, "16 kept + 18 fixed rows are ok");
}

#[test]
fn the_file_is_the_adr_table() {
    assert!(
        VECTORS.is_ascii(),
        "the vectors file must stay ASCII; write other characters as \\u escapes"
    );
    let doc = doc();
    assert_eq!(
        doc["maxChars"].as_u64(),
        Some(CHANNEL_NAME_MAX_CHARS as u64)
    );
    let cases = cases();
    assert_eq!(cases.len(), 57);
    let count = |group: &str| cases.iter().filter(|c| text(c, "group") == group).count();
    assert_eq!(
        (count("kept"), count("fixed"), count("refused")),
        (16, 18, 23)
    );

    let mut inputs: Vec<&str> = cases.iter().map(|c| text(c, "input")).collect();
    inputs.sort_unstable();
    inputs.dedup();
    assert_eq!(inputs.len(), 57, "no two rows share an input");

    for case in &cases {
        let verdict = text(case, "verdict");
        match text(case, "group") {
            "kept" => {
                assert_eq!(verdict, "ok", "{}", label(case));
                assert_eq!(text(case, "stored"), text(case, "input"), "{}", label(case));
            }
            "fixed" => {
                assert_eq!(verdict, "ok", "{}", label(case));
                assert_ne!(text(case, "stored"), text(case, "input"), "{}", label(case));
            }
            "refused" => assert_ne!(verdict, "ok", "{}", label(case)),
            other => panic!("unknown group {other}"),
        }
    }
    for reason in [
        ChannelNameRefusal::Required,
        ChannelNameRefusal::TooLong,
        ChannelNameRefusal::Hidden,
        ChannelNameRefusal::Unsupported,
        ChannelNameRefusal::Edge,
    ] {
        assert!(
            cases
                .iter()
                .any(|c| text(c, "verdict") == reason.vector_label()),
            "the table has a row for {reason:?}"
        );
    }
}

/// The rule before ADR-0225: trim, lowercase, then
/// `^[a-z0-9][a-z0-9_-]*[a-z0-9]$|^[a-z0-9]$` and 1..=80 characters.
fn old_rule(raw: &str) -> Option<String> {
    let value = raw.trim().to_lowercase();
    let length = value.chars().count();
    if length == 0 || length > 80 {
        return None;
    }
    let edge = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit();
    let inner = |c: char| edge(c) || c == '-' || c == '_';
    let first = value.chars().next()?;
    let last = value.chars().next_back()?;
    (edge(first) && edge(last) && value.chars().all(inner)).then_some(value)
}

#[test]
fn every_old_rule_name_is_kept_unchanged() {
    const ALPHABET: [char; 6] = ['a', 'z', '0', '9', '-', '_'];
    let mut names: Vec<String> = vec![String::new()];
    let mut frontier: Vec<String> = vec![String::new()];
    for _ in 0..5 {
        let mut next = Vec::new();
        for prefix in &frontier {
            for c in ALPHABET {
                next.push(format!("{prefix}{c}"));
            }
        }
        names.extend(next.iter().cloned());
        frontier = next;
    }
    names.extend(["a".repeat(80), "a".repeat(81), "a-".repeat(40) + "a"]);

    let mut kept = 0;
    for name in &names {
        let old = old_rule(name);
        // Over this alphabet the two rules agree exactly: nothing the old
        // rule stored is refused or rewritten, and nothing it refused is
        // newly let through.
        assert_eq!(normalize_channel_name(name).ok(), old, "{name:?}");
        if let Some(stored) = &old {
            assert_eq!(stored, name, "an old-rule name is stored as typed");
            // The old rule also trimmed and lowercased; those inputs keep
            // their old stored value too.
            let dressed = format!(" \t{} \n", name.to_uppercase());
            assert_eq!(old_rule(&dressed).as_deref(), Some(name.as_str()));
            assert_eq!(
                normalize_channel_name(&dressed).as_deref(),
                Ok(name.as_str())
            );
            kept += 1;
        }
    }
    assert!(kept > 1_000, "the sweep reached real names ({kept})");
}

fn version(raw: &str) -> (u64, u64, u64) {
    let mut parts = raw.split('.').map(|p| p.parse::<u64>().expect("number"));
    (
        parts.next().expect("major"),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    )
}

#[test]
fn the_servers_unicode_tables_are_not_older_than_the_vectors() {
    let vectors = version(
        doc()["unicodeVersionOfExpectedValues"]
            .as_str()
            .expect("unicode version"),
    );
    let properties = unicode_properties::UNICODE_VERSION;
    let normalization = unicode_normalization::UNICODE_VERSION;
    let normalization = (
        u64::from(normalization.0),
        u64::from(normalization.1),
        u64::from(normalization.2),
    );
    let std_tables = char::UNICODE_VERSION;
    let std_tables = (
        u64::from(std_tables.0),
        u64::from(std_tables.1),
        u64::from(std_tables.2),
    );
    assert!(properties >= vectors, "{properties:?} < {vectors:?}");
    assert!(normalization >= vectors, "{normalization:?} < {vectors:?}");
    assert!(std_tables >= vectors, "{std_tables:?} < {vectors:?}");
}
