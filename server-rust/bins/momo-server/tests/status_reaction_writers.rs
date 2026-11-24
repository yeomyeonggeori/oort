//! ADR-0200 증보 8 L4 · LA1 · LA12 (#6067): the static list of every statement that writes a
//! terminal `agent_run.status`, and what removes the agent's status eye for each.
//!
//! * **same tx** — the call site calls `momo_messaging::status_reaction` right after the write
//!   (within the next [`FOLLOW_LINES`] lines);
//! * **follow-up** — left to the api's follow-up removal (L7 5). Only the notifier's two writes
//!   (approval expiry, abandoned lease) may be here; a third turns this red;
//! * **via claim** — the connector-closure CTE inside the gateway claim (`momo-outbox`, which cannot
//!   see `momo-messaging`): every claim call site calls `on_agent_jobs_released_in_tx` after it.
//!
//! A new terminal write anywhere in `crates/*/src` or `bins/*/src` that is in none of the three
//! turns this test red. And the notifier's sources name no `status_reaction` and no `reaction`
//! write at all (LA12).

use std::fs;
use std::path::{Path, PathBuf};

const FOLLOW_LINES: usize = 40;
const TERMINAL_CALLS: [&str; 5] = [
    "finish_run_in_tx(",
    "end_parked_run_in_tx(",
    "end_stalled_run_in_tx(",
    "succeed_parked_run_in_tx(",
    "cancel_run_in_tx(",
];
const TERMINAL_WORDS: [&str; 4] = ["'cancelled'", "'succeeded'", "'failed'", "'timed_out'"];
const FOLLOW_UP_ALLOWED: [&str; 2] = [
    "bins/momo-notifier/src/approval_sweep.rs",
    "bins/momo-notifier/src/run_stall_sweep.rs",
];
const VIA_CLAIM: &str = "crates/momo-outbox/src/gateway.rs";
const CLAIM_CALLS: [&str; 2] = [
    "claim_hosted_gateway_jobs_in_tx(",
    "claim_gateway_jobs_in_tx(",
];

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn rust_sources() -> Vec<(String, String)> {
    let mut out = Vec::new();
    for group in ["crates", "bins"] {
        let Ok(entries) = fs::read_dir(root().join(group)) else {
            continue;
        };
        for entry in entries.flatten() {
            walk(&entry.path().join("src"), &mut out);
        }
    }
    out
}

fn walk(dir: &Path, out: &mut Vec<(String, String)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            let rel = path
                .strip_prefix(root())
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let rel = rel.trim_start_matches("./").to_string();
            out.push((rel, fs::read_to_string(&path).unwrap_or_default()));
        }
    }
}

fn is_code(line: &str) -> bool {
    let trimmed = line.trim_start();
    !(trimmed.starts_with("//") || trimmed.starts_with("use ") || line.contains("pub async fn "))
}

/// The production part of a file: everything before its `#[cfg(test)]` module.
fn production(text: &str) -> &str {
    text.split("#[cfg(test)]").next().unwrap_or(text)
}

#[derive(Debug)]
struct Write {
    file: String,
    line: usize,
    removes_in_same_tx: bool,
}

fn terminal_writes() -> Vec<Write> {
    let mut found = Vec::new();
    for (file, text) in rust_sources() {
        // run.rs holds the definitions of the five calls; its own statements are found through
        // their callers.
        if file.ends_with("crates/momo-agent/src/run.rs") {
            continue;
        }
        let lines: Vec<&str> = production(&text).lines().collect();
        for (index, line) in lines.iter().enumerate() {
            let call = is_code(line) && TERMINAL_CALLS.iter().any(|call| line.contains(call));
            let raw = line.contains("UPDATE agent_run")
                && lines[index..lines.len().min(index + 8)].iter().any(|next| {
                    next.contains("status") && TERMINAL_WORDS.iter().any(|w| next.contains(w))
                });
            if !(call || raw) {
                continue;
            }
            let follow = &lines[index..lines.len().min(index + FOLLOW_LINES)];
            found.push(Write {
                file: file.clone(),
                line: index + 1,
                removes_in_same_tx: follow
                    .iter()
                    .any(|next| next.contains("status_reaction::on_run")),
            });
        }
    }
    found
}

#[test]
fn every_terminal_write_removes_the_eye_or_is_one_of_the_notifiers_two() {
    let writes = terminal_writes();
    assert!(
        writes.len() >= 15,
        "the scan found too few terminal writes: {writes:#?}"
    );
    let mut follow_up = Vec::new();
    for write in &writes {
        if write.removes_in_same_tx {
            continue;
        }
        if write.file.ends_with(VIA_CLAIM) {
            continue;
        }
        follow_up.push(format!("{}:{}", write.file, write.line));
    }
    follow_up.sort();
    let mut allowed: Vec<String> = FOLLOW_UP_ALLOWED.iter().map(|s| s.to_string()).collect();
    allowed.sort();
    let files: Vec<String> = follow_up
        .iter()
        .map(|at| {
            at.rsplit_once(':')
                .map(|(f, _)| f.to_string())
                .unwrap_or_default()
        })
        .collect();
    assert_eq!(
        files.len(),
        2,
        "only the notifier's two terminal writes may leave the eye to the follow-up removal: {follow_up:#?}"
    );
    for (file, expected) in files.iter().zip(allowed.iter()) {
        assert!(
            file.ends_with(expected.as_str()),
            "{file} is not {expected}"
        );
    }
}

#[test]
fn the_connector_closure_inside_the_claim_is_followed_by_a_release_sweep() {
    let sources = rust_sources();
    let gateway = sources
        .iter()
        .find(|(file, _)| file.ends_with(VIA_CLAIM))
        .expect("gateway.rs");
    let closures = production(&gateway.1).matches("UPDATE agent_run").count();
    assert_eq!(
        closures, 1,
        "momo-outbox gateway.rs: one terminal CTE expected"
    );
    let mut claims = 0;
    for (file, text) in &sources {
        if file.ends_with(VIA_CLAIM) || file.contains("momo-outbox/src/lib.rs") {
            continue;
        }
        let lines: Vec<&str> = production(text).lines().collect();
        for (index, line) in lines.iter().enumerate() {
            if !is_code(line) || !CLAIM_CALLS.iter().any(|call| line.contains(call)) {
                continue;
            }
            claims += 1;
            let follow = &lines[index..lines.len().min(index + 20)];
            assert!(
                follow
                    .iter()
                    .any(|next| next.contains("status_reaction::on_agent_jobs_released_in_tx")),
                "{file}:{} claims gateway jobs without the release sweep",
                index + 1
            );
        }
    }
    assert!(
        claims >= 3,
        "expected the three claim call sites, found {claims}"
    );
}

#[test]
fn the_notifier_never_writes_a_reaction() {
    for (file, text) in rust_sources() {
        if !file.contains("bins/momo-notifier/src/") {
            continue;
        }
        assert!(
            !text.contains("status_reaction"),
            "{file} reaches the status reaction module"
        );
        assert!(
            !text.contains("INSERT INTO reaction"),
            "{file} inserts a reaction"
        );
        assert!(
            !text.contains("DELETE FROM reaction"),
            "{file} deletes a reaction"
        );
        assert!(
            !text.contains("set_reaction_in_tx"),
            "{file} writes a reaction"
        );
    }
}
