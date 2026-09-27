//! The app binary as a harness hook client (#2776, ADR-0190 D4-b).
//!
//! Runs the real built binary the way Claude Code and Codex run it: payload on
//! stdin (Claude) or as the last argument (Codex), the three `OORT_PANE_*`
//! variables in the environment. Asserts what reaches the socket — names only
//! — and that the harness always sees exit 0 and no output, even with the app
//! gone.
#![cfg(unix)]

use std::io::{Read, Write};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_momo-desktop");

fn socket(tag: &str) -> (PathBuf, UnixListener) {
    let dir = std::env::temp_dir().join(format!("oort-hook-it-{tag}-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("h.sock");
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).unwrap();
    (path, listener)
}

fn run(args: &[&str], sock: &PathBuf, stdin: &str) -> std::process::Output {
    let mut child = Command::new(BIN)
        .arg("--oort-pane-hook")
        .args(args)
        .env("OORT_PANE_HOOK_SOCK", sock)
        .env("OORT_PANE_ID", "4")
        .env("OORT_PANE_TOKEN", "feedface")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

fn received(listener: &UnixListener) -> String {
    listener.set_nonblocking(false).unwrap();
    let (mut stream, _) = listener.accept().unwrap();
    let mut text = String::new();
    stream.read_to_string(&mut text).unwrap();
    text
}

#[test]
fn claude_hook_payload_becomes_one_names_only_line() {
    let (sock, listener) = socket("claude");
    let payload = r#"{"session_id":"abc","transcript_path":"/Users/me/.claude/projects/x.jsonl","cwd":"/Users/me/customer-repo","hook_event_name":"Notification","notification_type":"permission_prompt","message":"Claude needs your permission to use Bash: git commit -m 'secret customer'"}"#;
    let out = run(&["claude"], &sock, payload);
    assert_eq!(out.status.code(), Some(0));
    assert!(
        out.stdout.is_empty(),
        "a hook's stdout can steer the harness"
    );
    assert_eq!(
        received(&listener),
        "{\"pane\":4,\"token\":\"feedface\",\"source\":\"claude\",\"event\":\"Notification\",\"detail\":\"permission_prompt\"}\n"
    );
    let _ = std::fs::remove_file(&sock);
}

#[test]
fn codex_notify_argument_becomes_one_line() {
    let (sock, listener) = socket("codex");
    let payload = r#"{"type":"agent-turn-complete","thread-id":"t","turn-id":"u","cwd":"/Users/me/r","input-messages":["ship it"],"last-assistant-message":"done"}"#;
    let out = run(&["codex", payload], &sock, "");
    assert_eq!(out.status.code(), Some(0));
    assert!(out.stdout.is_empty());
    assert_eq!(
        received(&listener),
        "{\"pane\":4,\"token\":\"feedface\",\"source\":\"codex\",\"event\":\"agent-turn-complete\",\"detail\":null}\n"
    );
    let _ = std::fs::remove_file(&sock);
}

#[test]
fn with_the_app_gone_the_hook_still_exits_zero_quickly() {
    let sock =
        std::env::temp_dir().join(format!("oort-hook-it-none-{}/x.sock", std::process::id()));
    let start = Instant::now();
    let out = run(&["claude"], &sock, r#"{"hook_event_name":"Stop"}"#);
    assert_eq!(out.status.code(), Some(0));
    assert!(out.stdout.is_empty() && out.stderr.is_empty());
    assert!(
        start.elapsed() < Duration::from_secs(3),
        "{:?}",
        start.elapsed()
    );
    // Garbage and unknown sources too.
    assert_eq!(run(&["claude"], &sock, "not json").status.code(), Some(0));
    assert_eq!(run(&["grok"], &sock, "{}").status.code(), Some(0));
    assert_eq!(run(&[], &sock, "").status.code(), Some(0));
}
