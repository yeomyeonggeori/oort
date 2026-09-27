// Pane status signals (#2776, ADR-0190 D2·D4-b): what a harness says about
// itself — Claude Code hooks, Codex `notify` — reaches the pane that runs it,
// and nothing else does.
//
//   harness ──hook──▶ this binary, `--oort-pane-hook <source>`   (client)
//          ──one JSON line──▶ app-only Unix socket               (listener)
//          ──closed enum──▶ the pane's `on_signal` channel        (webview)
//
// The boundary, in the order a signal meets it:
//
// 1. **Transport.** A Unix socket in a fresh 0700 folder under this process's
//    temp dir, named by this process's pid. No TCP port. Removed on exit. The
//    listener also refuses a peer whose uid is not ours.
// 2. **Who.** A spawn gives its pane three environment variables: the socket
//    path, the pane id and a random token. The listener accepts a line only if
//    the token is the one that pane was spawned with, so a process in pane 3
//    cannot move pane 5's dot, and a stale hook from a closed pane goes nowhere.
// 3. **What.** The client forwards only the hook's event name and its
//    notification type — never the message text, prompt, tool input, cwd or
//    transcript path — and the listener maps those two names through a closed
//    table (`signal_for`) to `PaneSignal`. An unknown event is dropped. The
//    line is `deny_unknown_fields` and at most `MAX_LINE` bytes.
// 4. **Never in the way.** The client always exits 0 with no output (Claude Code
//    reads exit 2 as "block", and stdout from some hooks as instructions). A
//    missing socket, a refused token or a slow listener cost the harness
//    nothing but `CLIENT_TIMEOUT`.
//
// PTY output is not an input anywhere in this file (D4-b 「긁지 않는다」);
// `shell_contract.rs` pins that by source.

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::pty::PtyManager;

/// argv[1] that turns the app binary into the hook client.
pub const HOOK_FLAG: &str = "--oort-pane-hook";
pub const ENV_SOCK: &str = "OORT_PANE_HOOK_SOCK";
pub const ENV_PANE: &str = "OORT_PANE_ID";
pub const ENV_TOKEN: &str = "OORT_PANE_TOKEN";

/// One forwarded line, client → listener.
pub const MAX_LINE: usize = 512;
/// A hook's stdin we are willing to read (the rest is drained and dropped).
const MAX_STDIN: usize = 1 << 20;
const MAX_NAME: usize = 64;
const CLIENT_TIMEOUT: Duration = Duration::from_millis(800);
const LISTENER_READ_TIMEOUT: Duration = Duration::from_millis(500);

/// The closed vocabulary the webview receives. Mirrors `PaneSignal` in
/// `@momo/core/features/workbench/paneStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PaneSignal {
    Ready,
    Working,
    WaitingPermission,
    WaitingInput,
    TurnDone,
}

/// Which harness wrote the hook. Fixed by the argv the app itself wired.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Claude,
    Codex,
}

impl Source {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            _ => None,
        }
    }
}

/// The only line the listener reads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HookLine {
    pub pane: u32,
    pub token: String,
    pub source: Source,
    /// Claude: `hook_event_name`. Codex: the notify payload's `type`.
    pub event: String,
    /// Claude `Notification` only: `notification_type`.
    #[serde(default)]
    pub detail: Option<String>,
}

/// The whole mapping. Anything not listed means nothing.
///
/// Measured with claude 2.1.x / codex-cli 0.156 (#2776 spike, PR body):
/// - `Notification` + `idle_prompt` is Claude re-announcing a finished turn
///   after ~60 s; the pane is already 「끝남」, so it does not become
///   「나를 기다림」 and does not notify twice.
/// - `PreToolUse` fires before the permission prompt, so it cannot clear a
///   wait; `PostToolUse` (the tool ran = the person allowed it) does.
pub fn signal_for(source: Source, event: &str, detail: Option<&str>) -> Option<PaneSignal> {
    match (source, event, detail) {
        (Source::Claude, "SessionStart", _) => Some(PaneSignal::Ready),
        (Source::Claude, "UserPromptSubmit" | "PostToolUse", _) => Some(PaneSignal::Working),
        (Source::Claude, "Notification", Some("permission_prompt")) => {
            Some(PaneSignal::WaitingPermission)
        }
        (Source::Claude, "Notification", Some("elicitation_dialog")) => {
            Some(PaneSignal::WaitingInput)
        }
        (Source::Claude, "Stop", _) => Some(PaneSignal::TurnDone),
        (Source::Codex, "agent-turn-complete", _) => Some(PaneSignal::TurnDone),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Wiring a harness (pure; the tests drive it)
// ---------------------------------------------------------------------------

/// Hook events the app registers for Claude Code. Exactly the ones
/// `signal_for` reads: registering more would run the client for nothing.
pub const CLAUDE_HOOK_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PostToolUse",
    "Notification",
    "Stop",
];

fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

fn toml_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', r"\\").replace('"', "\\\""))
}

/// Extra argv for a harness pane: the hook wiring and nothing else. Claude
/// Code takes it as `--settings <json>` (an extra settings layer; the user's
/// own files are not touched and their hooks still run). Codex takes `notify`
/// as a `-c` override. `None` for a harness with no measured hook surface.
pub fn harness_hook_args(harness: &str, exe: &Path) -> Option<Vec<String>> {
    let exe = exe.to_str()?;
    match harness {
        "claude" => {
            let command = format!("{} {HOOK_FLAG} claude", sh_quote(exe));
            let entry = serde_json::json!([{
                "hooks": [{ "type": "command", "command": command, "timeout": 5 }]
            }]);
            let hooks: serde_json::Map<String, serde_json::Value> = CLAUDE_HOOK_EVENTS
                .iter()
                .map(|event| ((*event).to_string(), entry.clone()))
                .collect();
            let settings = serde_json::json!({ "hooks": hooks });
            Some(vec!["--settings".into(), settings.to_string()])
        }
        "codex" => Some(vec![
            "-c".into(),
            format!(
                "notify=[{},{},{}]",
                toml_string(exe),
                toml_string(HOOK_FLAG),
                toml_string("codex")
            ),
        ]),
        _ => None,
    }
}

/// 32 hex characters from the OS random source.
pub fn new_token() -> std::io::Result<String> {
    let mut bytes = [0u8; 16];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

// ---------------------------------------------------------------------------
// Client: `<app> --oort-pane-hook <source> [codex-json]`
// ---------------------------------------------------------------------------

fn bounded_name(value: Option<&serde_json::Value>) -> Option<String> {
    let s = value?.as_str()?;
    (!s.is_empty() && s.len() <= MAX_NAME && s.bytes().all(|b| b.is_ascii_graphic()))
        .then(|| s.to_string())
}

/// Pick the two names out of a hook payload. Everything else in it — message,
/// prompt, tool input and output, paths — is dropped here, in the hook
/// process, before anything is sent.
pub fn names_from_payload(source: Source, payload: &str) -> Option<(String, Option<String>)> {
    let value: serde_json::Value = serde_json::from_str(payload).ok()?;
    match source {
        Source::Claude => Some((
            bounded_name(value.get("hook_event_name"))?,
            bounded_name(value.get("notification_type")),
        )),
        Source::Codex => Some((bounded_name(value.get("type"))?, None)),
    }
}

/// The hook client's line, or `None` when anything is missing.
pub fn client_line(
    source: Source,
    payload: &str,
    pane: Option<&str>,
    token: Option<&str>,
) -> Option<String> {
    let (event, detail) = names_from_payload(source, payload)?;
    let line = HookLine {
        pane: pane?.parse().ok()?,
        token: token?.to_string(),
        source,
        event,
        detail,
    };
    let mut text = serde_json::to_string(&line).ok()?;
    text.push('\n');
    (text.len() <= MAX_LINE).then_some(text)
}

/// Run as the hook client and return the exit code (always 0).
pub fn run_client(args: &[String]) -> i32 {
    let _ = (|| -> Option<()> {
        let source = Source::parse(args.first()?)?;
        let payload = match source {
            // Codex passes the JSON as the last argument.
            Source::Codex => args.get(1)?.clone(),
            Source::Claude => {
                let mut buf = Vec::new();
                let mut stdin = std::io::stdin().lock();
                stdin
                    .by_ref()
                    .take(MAX_STDIN as u64)
                    .read_to_end(&mut buf)
                    .ok()?;
                // Drain the rest so the harness never sees a broken pipe.
                let _ = std::io::copy(&mut stdin, &mut std::io::sink());
                String::from_utf8(buf).ok()?
            }
        };
        let line = client_line(
            source,
            &payload,
            std::env::var(ENV_PANE).ok().as_deref(),
            std::env::var(ENV_TOKEN).ok().as_deref(),
        )?;
        let sock = std::env::var_os(ENV_SOCK)?;
        let mut stream = UnixStream::connect(PathBuf::from(sock)).ok()?;
        stream.set_write_timeout(Some(CLIENT_TIMEOUT)).ok()?;
        stream.write_all(line.as_bytes()).ok()
    })();
    0
}

// ---------------------------------------------------------------------------
// Listener
// ---------------------------------------------------------------------------

/// Where this process listens: `$TMPDIR/oort-pane-<pid>/hook.sock`. Per
/// process so a dev build and the installed app never share (or remove) each
/// other's socket.
pub fn socket_path() -> PathBuf {
    std::env::temp_dir()
        .join(format!("oort-pane-{}", std::process::id()))
        .join("hook.sock")
}

/// Bind the listener: a fresh 0700 folder, a stale socket from a recycled pid
/// removed first.
pub fn bind(path: &Path) -> std::io::Result<UnixListener> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    let dir = path.parent().ok_or(std::io::ErrorKind::InvalidInput)?;
    match std::fs::DirBuilder::new().mode(0o700).create(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    let meta = std::fs::symlink_metadata(dir)?;
    if !meta.is_dir() || meta.permissions().mode() & 0o077 != 0 {
        return Err(std::io::Error::other("socket folder is not private"));
    }
    let _ = std::fs::remove_file(path);
    let listener = UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(listener)
}

pub fn remove(path: &Path) {
    let _ = std::fs::remove_file(path);
    if let Some(dir) = path.parent() {
        let _ = std::fs::remove_dir(dir);
    }
}

/// Parse one line into (pane, token, signal). `None` = drop it.
pub fn accept_line(line: &str) -> Option<(u32, String, PaneSignal)> {
    if line.len() > MAX_LINE {
        return None;
    }
    let hook: HookLine = serde_json::from_str(line.trim_end()).ok()?;
    let signal = signal_for(hook.source, &hook.event, hook.detail.as_deref())?;
    Some((hook.pane, hook.token, signal))
}

#[cfg(unix)]
fn same_user(stream: &UnixStream) -> bool {
    use std::os::fd::AsRawFd;
    let (mut uid, mut gid) = (0, 0);
    // SAFETY: a valid fd and two out-pointers to locals.
    let rc = unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) };
    rc == 0 && uid == unsafe { libc::getuid() }
}

fn serve_one(stream: UnixStream, manager: &PtyManager) {
    if !same_user(&stream) {
        return;
    }
    let _ = stream.set_read_timeout(Some(LISTENER_READ_TIMEOUT));
    let mut line = String::new();
    let mut reader = BufReader::new(stream.take(MAX_LINE as u64 + 1));
    if reader.read_line(&mut line).is_err() {
        return;
    }
    if let Some((pane, token, signal)) = accept_line(&line) {
        manager.deliver_signal(pane, &token, signal);
    }
}

/// Accept lines until the process ends. One short read per connection.
pub fn serve(listener: UnixListener, manager: Arc<PtyManager>) {
    std::thread::Builder::new()
        .name("pane-signal".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                serve_one(stream, &manager);
            }
        })
        .ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mapping_is_a_closed_table() {
        use PaneSignal::*;
        let c = Source::Claude;
        assert_eq!(signal_for(c, "SessionStart", None), Some(Ready));
        assert_eq!(signal_for(c, "UserPromptSubmit", None), Some(Working));
        assert_eq!(signal_for(c, "PostToolUse", None), Some(Working));
        assert_eq!(
            signal_for(c, "Notification", Some("permission_prompt")),
            Some(WaitingPermission)
        );
        assert_eq!(
            signal_for(c, "Notification", Some("elicitation_dialog")),
            Some(WaitingInput)
        );
        assert_eq!(signal_for(c, "Stop", None), Some(TurnDone));
        assert_eq!(
            signal_for(Source::Codex, "agent-turn-complete", None),
            Some(TurnDone)
        );
        for (source, event, detail) in [
            (c, "Notification", Some("idle_prompt")),
            (c, "Notification", None),
            (c, "PreToolUse", None),
            (c, "SessionEnd", None),
            (c, "agent-turn-complete", None),
            (Source::Codex, "Stop", None),
            (Source::Codex, "approval-requested", None),
        ] {
            assert_eq!(
                signal_for(source, event, detail),
                None,
                "{event} {detail:?}"
            );
        }
    }

    #[test]
    fn every_registered_claude_hook_means_something() {
        for event in CLAUDE_HOOK_EVENTS {
            let detail = (*event == "Notification").then_some("permission_prompt");
            assert!(
                signal_for(Source::Claude, event, detail).is_some(),
                "{event} registered but mapped to nothing"
            );
        }
    }

    #[test]
    fn the_client_forwards_names_only() {
        let payload = r#"{"session_id":"s1","transcript_path":"/Users/me/.claude/x.jsonl","cwd":"/Users/me/secret-repo","hook_event_name":"Notification","notification_type":"permission_prompt","message":"Claude needs your permission to use Bash: cat ~/.ssh/id_rsa sk-ant-XXXX"}"#;
        let line = client_line(Source::Claude, payload, Some("7"), Some("t0k")).unwrap();
        assert_eq!(
            line,
            "{\"pane\":7,\"token\":\"t0k\",\"source\":\"claude\",\"event\":\"Notification\",\"detail\":\"permission_prompt\"}\n"
        );
        for leak in [
            "secret-repo",
            "id_rsa",
            "sk-ant",
            "transcript",
            "message",
            "s1",
        ] {
            assert!(!line.contains(leak), "{leak} leaked: {line}");
        }
        let codex = r#"{"type":"agent-turn-complete","thread-id":"x","turn-id":"y","cwd":"/Users/me/r","input-messages":["deploy with token ghp_abc"],"last-assistant-message":"done: commit 'secret customer'"}"#;
        let line = client_line(Source::Codex, codex, Some("2"), Some("t")).unwrap();
        assert!(line.contains("\"event\":\"agent-turn-complete\""));
        for leak in ["ghp_", "customer", "/Users/me", "thread"] {
            assert!(!line.contains(leak), "{leak} leaked: {line}");
        }
    }

    #[test]
    fn the_client_gives_up_quietly_on_anything_missing() {
        let ok = r#"{"hook_event_name":"Stop"}"#;
        assert!(client_line(Source::Claude, ok, None, Some("t")).is_none());
        assert!(client_line(Source::Claude, ok, Some("x"), Some("t")).is_none());
        assert!(client_line(Source::Claude, ok, Some("1"), None).is_none());
        assert!(client_line(Source::Claude, "not json", Some("1"), Some("t")).is_none());
        let long = format!(r#"{{"hook_event_name":"{}"}}"#, "A".repeat(MAX_NAME + 1));
        assert!(client_line(Source::Claude, &long, Some("1"), Some("t")).is_none());
        let control = r#"{"hook_event_name":"Stop\u001b]0;x\u0007"}"#;
        assert!(client_line(Source::Claude, control, Some("1"), Some("t")).is_none());
        // Always exits 0, even with nothing usable.
        assert_eq!(run_client(&["nope".into()]), 0);
        assert_eq!(run_client(&[]), 0);
    }

    #[test]
    fn the_listener_takes_known_lines_only() {
        let good = r#"{"pane":3,"token":"abc","source":"claude","event":"Stop"}"#;
        assert_eq!(
            accept_line(good),
            Some((3, "abc".into(), PaneSignal::TurnDone))
        );
        for bad in [
            r#"{"pane":3,"token":"abc","source":"claude","event":"Stop","message":"hi"}"#,
            r#"{"pane":3,"token":"abc","source":"grok","event":"Stop"}"#,
            r#"{"pane":3,"token":"abc","source":"claude","event":"Whatever"}"#,
            r#"{"pane":-1,"token":"abc","source":"claude","event":"Stop"}"#,
            r#"{"token":"abc","source":"claude","event":"Stop"}"#,
            "",
        ] {
            assert_eq!(accept_line(bad), None, "{bad}");
        }
        let oversized = format!(
            r#"{{"pane":3,"token":"{}","source":"claude","event":"Stop"}}"#,
            "a".repeat(MAX_LINE)
        );
        assert_eq!(accept_line(&oversized), None);
    }

    #[test]
    fn claude_wiring_is_one_settings_layer_with_our_hooks() {
        let args = harness_hook_args("claude", Path::new("/Apps/o'ort.app/oort")).unwrap();
        assert_eq!(args.len(), 2);
        assert_eq!(args[0], "--settings");
        let v: serde_json::Value = serde_json::from_str(&args[1]).unwrap();
        let obj = v.as_object().unwrap();
        assert_eq!(obj.keys().collect::<Vec<_>>(), ["hooks"], "only hooks");
        let hooks = obj["hooks"].as_object().unwrap();
        let mut names: Vec<_> = hooks.keys().map(String::as_str).collect();
        names.sort();
        let mut want = CLAUDE_HOOK_EVENTS.to_vec();
        want.sort();
        assert_eq!(names, want);
        let cmd = hooks["Stop"][0]["hooks"][0]["command"].as_str().unwrap();
        assert_eq!(cmd, r"'/Apps/o'\''ort.app/oort' --oort-pane-hook claude");
        // No permission-mode or bypass setting rides along (ADR-0190 D2).
        assert!(!args[1].contains("permission"));
        assert!(!args[1].contains("dangerously"));
    }

    #[test]
    fn codex_wiring_is_one_notify_override() {
        let args = harness_hook_args("codex", Path::new("/A\"pp/oort")).unwrap();
        assert_eq!(
            args,
            ["-c", r#"notify=["/A\"pp/oort","--oort-pane-hook","codex"]"#]
        );
        assert_eq!(harness_hook_args("grok", Path::new("/x")), None);
    }

    #[test]
    fn tokens_are_random_hex() {
        let a = new_token().unwrap();
        let b = new_token().unwrap();
        assert_eq!(a.len(), 32);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn the_socket_folder_is_private_and_removed() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("oort-pane-test-{}", std::process::id()));
        let path = dir.join("hook.sock");
        let _listener = bind(&path).unwrap();
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
        // Rebinding over a stale socket works (a recycled pid).
        drop(_listener);
        let _again = bind(&path).unwrap();
        remove(&path);
        assert!(!dir.exists());
    }
}
