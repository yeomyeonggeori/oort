//! ADR-0225 D9 / D11: the CLI's second copy of the channel-name fold, held to the server's.
//!
//! The binary links no server crate, so `oort_cli::channel_name::fold_channel_name` retypes D3
//! steps 1-5. This file depends on `momo-messaging` as a dev-dependency only and proves the two
//! agree: on the shared vector file (read in place, never copied), on a seeded random batch, and
//! on the edges the random batch rarely hits. It then proves the names the CLI resolves
//! (`pick_channel`) go through that fold on both sides.
//!
//! | test | goes red if |
//! |---|---|
//! | `the_vector_file_is_read_in_full_and_the_cli_stores_what_it_says` | the CLI fold skips a step the vectors pin (any of the 34 `ok` lines), or the file shrinks |
//! | `the_cli_fold_is_the_servers_on_every_vector_line` | the CLI fold differs from the server's on any of the 57 inputs, refused ones included |
//! | `the_cli_fold_is_the_servers_on_five_thousand_random_names` | the two folds differ on a seeded random batch |
//! | `the_cli_fold_is_the_servers_on_the_named_edges` | decomposed Hangul, fullwidth, all blank kinds, invisible characters, 80/81 characters |
//! | `four_spellings_of_one_channel_all_find_it` | `pick_channel` compares raw, or folds only one side |
//! | `two_old_names_that_fold_together_are_ambiguous_never_guessed` | `pick_channel` picks one of two channels whose folded names collide |
//! | `a_name_the_server_would_refuse_finds_no_channel_by_the_ordinary_road` | a refused vector input matches a channel, or a new error kind appears |

use momo_messaging::channel::fold_channel_name as server_fold;
use oort_cli::api::Channel;
use oort_cli::channel_name::fold_channel_name as cli_fold;
use oort_cli::commands::pick_channel;
use oort_cli::error::Kind;
use serde_json::Value;

const VECTORS: &str = include_str!("../../../../docs/api/channel-name.vectors.json");

fn cases() -> Vec<Value> {
    let doc: Value = serde_json::from_str(VECTORS).expect("vector file is JSON");
    doc["cases"].as_array().expect("cases").clone()
}

fn channel(id: &str, name: &str) -> Channel {
    Channel {
        id: id.to_string(),
        kind: "public".to_string(),
        name: Some(name.to_string()),
        topic: None,
        archived_at_ms: None,
        muted: false,
    }
}

#[test]
fn the_vector_file_is_read_in_full_and_the_cli_stores_what_it_says() {
    let cases = cases();
    assert_eq!(cases.len(), 57, "the shared vector file has 57 lines");
    let mut ok = 0;
    for case in &cases {
        let input = case["input"].as_str().expect("input");
        if case["verdict"] == "ok" {
            let stored = case["stored"].as_str().expect("stored");
            assert_eq!(cli_fold(input), stored, "{}: {:?}", case["note"], input);
            // Folding twice changes nothing (ADR-0225 D3).
            assert_eq!(cli_fold(stored), stored, "{}: {:?}", case["note"], stored);
            ok += 1;
        }
    }
    assert_eq!(ok, 34, "34 vector lines are accepted names");
}

#[test]
fn the_cli_fold_is_the_servers_on_every_vector_line() {
    for case in cases() {
        let input = case["input"].as_str().expect("input");
        assert_eq!(
            cli_fold(input),
            server_fold(input),
            "{}: {:?}",
            case["note"],
            input
        );
    }
}

/// xorshift64*, seeded: the batch is the same on every run, so a red is reproducible.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

/// Characters that make the fold do something, plus every Unicode blank.
fn pool() -> Vec<char> {
    let mut pool: Vec<char> = (0..=0x10FFFF_u32)
        .filter_map(char::from_u32)
        .filter(|c| c.is_whitespace())
        .collect();
    assert_eq!(pool.len(), 25, "Unicode White_Space has 25 code points");
    pool.extend("abcXYZ09-_#".chars());
    pool.extend([
        '\u{ac00}', '\u{d55c}', '\u{1112}', '\u{1161}', '\u{11ab}', '\u{314b}',
    ]);
    pool.extend([
        '\u{ff21}', '\u{ff41}', '\u{ff10}', '\u{ff0d}', '\u{ff3f}', '\u{ff5e}', '\u{ff01}',
    ]);
    pool.extend([
        '\u{0301}', '\u{0041}', '\u{00c9}', '\u{0130}', '\u{03a3}', '\u{03c3}', '\u{1e9e}',
    ]);
    pool.extend([
        '\u{200b}', '\u{200d}', '\u{feff}', '\u{202e}', '\u{3164}', '\u{fe0f}', '\u{e000}',
    ]);
    pool.extend([
        '\u{ff71}',
        '\u{1f600}',
        '\u{4e2d}',
        '\u{0627}',
        '\u{0e01}',
        '\u{0000}',
    ]);
    pool
}

#[test]
fn the_cli_fold_is_the_servers_on_five_thousand_random_names() {
    let pool = pool();
    let mut rng = Rng(0x0DD5_EED5_5829_0001);
    for round in 0..5000 {
        let length = rng.below(40);
        let name: String = (0..length)
            .map(|_| {
                // One in eight is any scalar value at all, the rest come from the pool.
                if rng.below(8) == 0 {
                    loop {
                        if let Some(c) = char::from_u32((rng.next() % 0x11_0000) as u32) {
                            break c;
                        }
                    }
                } else {
                    pool[rng.below(pool.len())]
                }
            })
            .collect();
        assert_eq!(
            cli_fold(&name),
            server_fold(&name),
            "round {round}: {name:?}"
        );
    }
}

#[test]
fn the_cli_fold_is_the_servers_on_the_named_edges() {
    let mut edges: Vec<String> = vec![
        "\u{1112}\u{1161}\u{11ab}\u{1100}\u{1173}\u{11af}".to_string(),
        "\u{ff31}\u{ff21}-\u{ff54}\u{ff45}\u{ff41}\u{ff4d}".to_string(),
        "\u{ff25}\u{0301}quipe".to_string(),
        "\u{0391}\u{03a3}".to_string(),
        "I\u{0307}stanbul".to_string(),
        "a\u{200b}b".to_string(),
        "\u{feff}name".to_string(),
        "\u{3164}".to_string(),
        "-a-".to_string(),
        "a - b".to_string(),
        "a _ b".to_string(),
        "a\u{00a0}\u{3000}b".to_string(),
        "  eng   team  ".to_string(),
    ];
    for blank in (0..=0x10FFFF_u32)
        .filter_map(char::from_u32)
        .filter(|c| c.is_whitespace())
    {
        edges.push(format!("a{blank}b"));
        edges.push(format!("{blank}a{blank}"));
        edges.push(format!("a-{blank}b"));
        edges.push(format!("a{blank}_b"));
    }
    for length in [79_usize, 80, 81, 160] {
        edges.push("\u{d55c}".repeat(length));
        edges.push("\u{ff21}".repeat(length));
        edges.push("a b ".repeat(length / 4 + 1));
    }
    for edge in &edges {
        assert_eq!(cli_fold(edge), server_fold(edge), "{edge:?}");
    }
    assert!(edges.len() > 100);
}

#[test]
fn four_spellings_of_one_channel_all_find_it() {
    // The server stores folded names; the list below is what `oort channels` receives.
    let channels = vec![
        channel(
            "11111111-1111-4111-8111-111111111111",
            "\u{d55c}\u{ae00}-\u{d300}",
        ),
        channel("22222222-2222-4222-8222-222222222222", "qa"),
        channel("33333333-3333-4333-8333-333333333333", "eng-team"),
    ];
    let cases = [
        // decomposed Hangul (a Mac terminal), a blank, capitals, fullwidth Latin
        (
            "\u{1112}\u{1161}\u{11ab}\u{1100}\u{1173}\u{11af}-\u{d300}",
            &channels[0],
        ),
        ("\u{d55c}\u{ae00} \u{d300}", &channels[0]),
        ("eng team", &channels[2]),
        ("  Eng   Team ", &channels[2]),
        ("QA", &channels[1]),
        ("\u{ff31}\u{ff21}", &channels[1]),
        // unchanged names still work
        ("qa", &channels[1]),
        ("eng-team", &channels[2]),
    ];
    for (typed, want) in cases {
        assert_eq!(
            pick_channel(&channels, typed).as_deref().ok(),
            Some(want.id.as_str()),
            "{typed:?}"
        );
    }
    // The stored side is folded too: an old-rule list entry with a capital is still found.
    let old = vec![channel("44444444-4444-4444-8444-444444444444", "QA")];
    assert_eq!(pick_channel(&old, "qa").unwrap(), old[0].id);
}

#[test]
fn two_old_names_that_fold_together_are_ambiguous_never_guessed() {
    let channels = vec![
        channel("11111111-1111-4111-8111-111111111111", "qa"),
        channel("22222222-2222-4222-8222-222222222222", "QA"),
    ];
    let error = pick_channel(&channels, "qa").unwrap_err();
    assert_eq!(error.code, "ambiguous_channel");
    assert_eq!(error.kind, Kind::Usage);
    // An archived twin does not make it ambiguous.
    let mut archived = channels.clone();
    archived[1].archived_at_ms = Some(1);
    assert_eq!(pick_channel(&archived, "QA").unwrap(), archived[0].id);
}

#[test]
fn a_name_the_server_would_refuse_finds_no_channel_by_the_ordinary_road() {
    let stored: Vec<String> = cases()
        .iter()
        .filter(|case| case["verdict"] == "ok")
        .map(|case| case["stored"].as_str().expect("stored").to_string())
        .collect();
    let channels: Vec<Channel> = stored
        .iter()
        .enumerate()
        .map(|(i, name)| channel(&format!("{i:08x}-0000-4000-8000-000000000000"), name))
        .collect();
    let mut tried = 0;
    for case in cases() {
        if case["verdict"] == "ok" {
            continue;
        }
        let input = case["input"].as_str().expect("input");
        let error = pick_channel(&channels, input).expect_err(input);
        assert_eq!(error.kind, Kind::NotFound, "{}: {input:?}", case["note"]);
        assert_eq!(
            error.code, "channel_not_found",
            "{}: {input:?}",
            case["note"]
        );
        tried += 1;
    }
    assert_eq!(tried, 23, "23 vector lines are refused names");
    // An empty-folding name never matches, even a channel whose own name folds to nothing.
    let blank = vec![channel("55555555-5555-4555-8555-555555555555", " ")];
    assert_eq!(
        pick_channel(&blank, " ").unwrap_err().code,
        "channel_not_found"
    );
}
