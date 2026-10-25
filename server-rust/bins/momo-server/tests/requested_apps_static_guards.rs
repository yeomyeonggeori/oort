//! #4313 / ADR-0113 증보 3 F5 — `props.requestedApps` is a **marker, never a grant**: the guards that
//! need no database, so they run in every `cargo test`.
//!
//! The delivery gates and the `tool_grants` assembly take no props at all — `delivery_gate(agent,
//! send)` reads a candidate and a `MentionSend`, and `MentionSend` has no props — so "changing
//! `requestedApps` changes nothing" is *true by construction* and a test that only asserted equality of
//! two outputs could not fail. What can fail is the construction itself: someone threads the key (or a
//! flag derived from it) into a delivery decision. That is what this file watches.
//!
//! | test | what it keeps | revert that makes it red |
//! |---|---|---|
//! | `no_delivery_or_grant_file_names_the_requested_apps_marker` | the gate, the owner/connector/trial guards, the candidate loader and the `tool_grants` producer never read the marker | any spelling of the key in those files, outside comments |
//! | `the_send_composition_judges_the_marker_before_the_mention_pass` | in `deliver.rs` the marker is judged (and only judged) before `route_agent_mentions_in_tx` is called, so nothing downstream can have been handed it | a use of the marker after, or inside, the mention-pass call |
//! | `the_scan_goes_red_on_a_synthetic_offender` | the two scans above can fail (a text scan that cannot fail proves nothing) | the scan stops seeing a spelling, or stops reading code |
//!
//! The behavioural half — a non-owner who attaches `apps` is refused exactly like one who does not — is
//! `requested_apps_conformance_pg.rs`.

use std::path::PathBuf;

fn server_rust() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Every file that decides whether a message is delivered or which `tool_grants` it carries.
const DELIVERY_FILES: [&str; 6] = [
    "bins/momo-server/src/routes/agent_mentions.rs",
    "crates/momo-agent/src/mention.rs",
    "crates/momo-agent/src/subscription.rs",
    "crates/momo-agent/src/connector_trial.rs",
    "crates/momo-agent/src/app_tool_grants.rs",
    "crates/momo-agent/src/in_place_grant.rs",
];

const DELIVER_COMPOSITION: &str = "bins/momo-server/src/routes/deliver.rs";

/// The text with full-line `//` comments removed. Doc comments are where this codebase explains its
/// contracts, so a file may *talk about* the marker; only code may not use it.
fn code_of(text: &str) -> String {
    text.lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Case- and underscore-insensitive: `requestedApps`, `requested_apps`, `REQUESTED_APPS`,
/// `PROP_REQUESTED_APPS` and `requested-apps` are one spelling for this scan.
fn spellings_of_the_marker(code: &str) -> Vec<usize> {
    let folded: String = code
        .chars()
        .filter(|character| !matches!(character, '_' | '-'))
        .flat_map(char::to_lowercase)
        .collect();
    folded
        .match_indices("requestedapps")
        .map(|(index, _)| index)
        .collect()
}

/// `(file, why)` for every violation in `files` (`(path, text)` pairs), delivery files and the send
/// composition alike. Shared by the real scan and the synthetic one.
fn offences(files: &[(String, String)]) -> Vec<String> {
    let mut found = Vec::new();
    for (path, text) in files {
        let code = code_of(text);
        if DELIVERY_FILES.contains(&path.as_str()) {
            let hits = spellings_of_the_marker(&code);
            if !hits.is_empty() {
                found.push(format!(
                    "{path}: a delivery/grant file names the requested-apps marker ({} time(s))",
                    hits.len()
                ));
            }
        }
        if path == DELIVER_COMPOSITION {
            // Position, not count: fold only the characters the scan ignores *after* locating the call
            // in the same folded text, so the two offsets are comparable.
            let folded: String = code
                .chars()
                .filter(|character| !matches!(character, '_' | '-'))
                .flat_map(char::to_lowercase)
                .collect();
            let Some(call) = folded.find("routeagentmentionsintx(") else {
                found.push(format!("{path}: the mention-pass call was not found"));
                continue;
            };
            for hit in folded
                .match_indices("requestedapps")
                .map(|(index, _)| index)
            {
                if hit > call {
                    found.push(format!(
                        "{path}: the requested-apps marker is used after the mention pass starts"
                    ));
                    break;
                }
            }
        }
    }
    found
}

fn load(paths: &[&str]) -> Vec<(String, String)> {
    paths
        .iter()
        .map(|path| {
            let full = server_rust().join(path);
            let text = std::fs::read_to_string(&full)
                .unwrap_or_else(|error| panic!("read {}: {error}", full.display()));
            (path.to_string(), text)
        })
        .collect()
}

fn real_files() -> Vec<(String, String)> {
    let mut paths: Vec<&str> = DELIVERY_FILES.to_vec();
    paths.push(DELIVER_COMPOSITION);
    load(&paths)
}

#[test]
fn no_delivery_or_grant_file_names_the_requested_apps_marker() {
    let files = real_files();
    for (path, text) in &files {
        assert!(
            text.lines().count() > 100,
            "{path}: the scan must actually see the file"
        );
    }
    let problems = offences(&files);
    assert!(problems.is_empty(), "{problems:#?}");
}

/// The composition keeps the marker out of everything after the point it is judged: it reads it before
/// the mention pass and never again. (The positive half — it *is* read there — keeps the test from
/// passing on a file that no longer mentions the marker at all.)
#[test]
fn the_send_composition_judges_the_marker_before_the_mention_pass() {
    let text = &load(&[DELIVER_COMPOSITION])[0].1;
    let code = code_of(text);
    let hits = spellings_of_the_marker(&code);
    assert!(
        hits.len() >= 3,
        "deliver.rs must carry the field, the destructure and the judgement ({} hits)",
        hits.len()
    );
    assert!(offences(&load(&[DELIVER_COMPOSITION])).is_empty());
}

fn synthetic(path: &str, text: &str) -> (String, String) {
    (path.to_string(), text.to_string())
}

#[test]
fn the_scan_goes_red_on_a_synthetic_offender() {
    let baseline = real_files();
    assert!(offences(&baseline).is_empty(), "the baseline is clean");

    let with_extra_line = |path: &str, extra: &str| {
        let mut files = real_files();
        for (file, text) in &mut files {
            if file == path {
                text.push('\n');
                text.push_str(extra);
                text.push('\n');
            }
        }
        offences(&files)
    };

    // Every spelling, in every delivery file, as code.
    for path in DELIVERY_FILES {
        for spelling in [
            "let x = message_props.get(\"requestedApps\");",
            "if send.requested_apps { return skip_owner_check(); }",
            "const K: &str = momo_agent::PROP_REQUESTED_APPS;",
            "let REQUESTED_APPS = 1;",
            "let requested-apps = 1;",
        ] {
            let problems = with_extra_line(path, spelling);
            assert!(
                problems.iter().any(|problem| problem.starts_with(path)),
                "{path}: {spelling:?} must be flagged, got {problems:?}"
            );
        }
        // A comment about the marker is not a use of it.
        let comment = with_extra_line(path, "// requestedApps is a marker, never a grant");
        assert!(comment.is_empty(), "{path}: {comment:?}");
        let doc = with_extra_line(path, "/// the requested_apps chip is drawn by the client");
        assert!(doc.is_empty(), "{path}: {doc:?}");
    }

    // The composition: a use after the mention-pass call is flagged; before it is fine.
    let after = with_extra_line(DELIVER_COMPOSITION, "fn late() { let _ = requested_apps; }");
    assert!(
        after
            .iter()
            .any(|problem| problem.contains("after the mention pass")),
        "{after:?}"
    );
    let missing_call = offences(&[synthetic(DELIVER_COMPOSITION, "fn nothing() {}\n")]);
    assert!(
        missing_call
            .iter()
            .any(|problem| problem.contains("mention-pass call was not found")),
        "{missing_call:?}"
    );
}
