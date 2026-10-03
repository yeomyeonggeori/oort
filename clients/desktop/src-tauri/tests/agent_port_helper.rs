//! The app binary as the CLI's `headersHelper` (#3389, ADR-0190 D3-h / D3-i).
//!
//! Runs the real built binary the way the official CLI runs a header helper:
//! one lowercase agent id as the only argument, a throwaway HOME. Asserts the
//! output is one JSON line with the stored value, `{}` for an unknown id, that
//! nothing reaches stderr and that no file appears (no log).
#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_momo-desktop");
const AGENT: &str = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const OTHER: &str = "11111111-2222-4333-8444-555555555555";
const VALUE: &str = "pairing-FAKE3389VALUE.zzzzzzzzzzzz~_+/=";

fn home(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("oort-3389-it-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn store(home: &Path) -> PathBuf {
    let dir = home.join("Library/Application Support/oort/agent-port");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    dir
}

fn run(home: &Path, args: &[&str]) -> std::process::Output {
    Command::new(BIN)
        .args(args)
        .env("HOME", home)
        .output()
        .unwrap()
}

#[test]
fn the_helper_prints_one_json_line_with_the_stored_value() {
    let home = home("hit");
    let dir = store(&home);
    std::fs::write(
        dir.join(format!("{AGENT}.entry")),
        format!(
            r#"{{"endpoint":"https://oort.example.test/v1/mcp/agent-port","credential":"{VALUE}","added":true}}"#
        ),
    )
    .unwrap();
    let before: Vec<_> = std::fs::read_dir(&dir).unwrap().collect();
    let out = run(&home, &[AGENT]);
    assert!(out.status.success());
    assert!(out.stderr.is_empty(), "the helper wrote to stderr");
    let text = String::from_utf8(out.stdout).unwrap();
    assert_eq!(text.lines().count(), 1, "{text}");
    let parsed: serde_json::Value = serde_json::from_str(text.trim()).unwrap();
    assert_eq!(
        parsed,
        serde_json::json!({ "Authorization": format!("Bearer {VALUE}") })
    );
    // No log, no marker, nothing new next to the store or in HOME.
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), before.len());
    assert_eq!(std::fs::read_dir(&home).unwrap().count(), 1);
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn an_unknown_agent_or_a_missing_store_prints_an_empty_object() {
    let home = home("miss");
    let out = run(&home, &[OTHER]);
    assert!(out.status.success());
    assert!(out.stderr.is_empty());
    assert_eq!(String::from_utf8(out.stdout).unwrap().trim(), "{}");
    assert!(!home.join("Library").exists(), "the helper created folders");
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn an_entry_with_a_value_outside_the_alphabet_is_not_printed() {
    let home = home("bad");
    let dir = store(&home);
    std::fs::write(
        dir.join(format!("{AGENT}.entry")),
        r#"{"endpoint":"https://oort.example.test/v1/mcp/agent-port","credential":"x\"; injected ...........","added":true}"#,
    )
    .unwrap();
    let out = run(&home, &[AGENT]);
    assert_eq!(String::from_utf8(out.stdout).unwrap().trim(), "{}");
    let _ = std::fs::remove_dir_all(&home);
}
