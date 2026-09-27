// "Is this profile folder signed out?" — the removal gate for a profile folder
// (#2878, ADR-0190 D3-d·D3-f, PR #2996 security re-review Medium-1).
//
// An exit code alone cannot answer it: both CLIs end a crash or an uncaught
// error with exit 1, the same code `claude auth status` uses for "not signed
// in". So deletion asks the official CLI for its structured answer, through
// the two D3-d account checks and nothing else:
//
// | harness | command (fixed)                | signed out when                                   |
// |---------|--------------------------------|---------------------------------------------------|
// | claude  | `claude auth status --json`    | exit 1 **and** stdout JSON has `"loggedIn": false` |
// | codex   | `codex app-server`, requests `initialize` → `account/read` | the `account/read` response has `"account": null` |
//
// Measured against empty profile folders (no login) on this Mac, 2026-09-28:
// - `claude` 2.1.283: exit 1, stdout `{"loggedIn": false, "authMethod": "none", …}`.
// - `codex-cli` 0.156.1: `{"id":2,"result":{"account":null,"requiresOpenaiAuth":true,…}}`.
//
// Anything else — no JSON, a JSON that does not say so, a crash, a timeout, a
// CLI that is not installed — is `Unknown`, and the folder stays.
//
// What is read: `loggedIn` (a bool) and whether `account` is JSON null. No
// other field is kept, returned, logged or sent; stderr is discarded. The
// caller gets one of three values. Nothing here opens a file.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use crate::harness_path;

/// One allowlisted sign-out check (D3-d). Kept apart from the status,
/// sign-in and sign-out lists (D3-g).
#[derive(Debug, PartialEq, Eq)]
pub struct SignOutCheck {
    pub id: &'static str,
    pub args: &'static [&'static str],
    /// JSON-RPC methods sent on stdin, in order (Codex app-server only).
    pub requests: &'static [&'static str],
}

pub const SIGNOUT_CHECKS: &[SignOutCheck] = &[
    SignOutCheck {
        id: "claude",
        args: &["auth", "status", "--json"],
        requests: &[],
    },
    SignOutCheck {
        id: "codex",
        args: &["app-server"],
        requests: &["initialize", "account/read"],
    },
];

/// The request lines for the Codex check: exactly two of the three requests
/// D3-d allows on this connection. `account/read` is id 2, the one answer
/// read.
const CODEX_LINES: &[&str] = &[
    r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"oort","title":"oort","version":"0"}}}"#,
    r#"{"jsonrpc":"2.0","id":2,"method":"account/read","params":{}}"#,
];
const CODEX_ACCOUNT_READ_ID: u64 = 2;

pub const SIGNOUT_TIMEOUT: Duration = Duration::from_secs(8);
/// More stdout than this is not an answer.
const MAX_STDOUT: u64 = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignOut {
    /// The CLI said, in its structured output, that this folder is signed out.
    SignedOut,
    /// The CLI said it is signed in.
    SignedIn,
    /// No usable answer. The folder stays.
    Unknown,
}

/// `claude auth status --json`: exit status + stdout → verdict.
pub fn claude_verdict(exit_code: Option<i32>, stdout: &[u8]) -> SignOut {
    #[derive(serde::Deserialize)]
    struct Status {
        #[serde(rename = "loggedIn")]
        logged_in: bool,
    }
    let Ok(status) = serde_json::from_slice::<Status>(stdout) else {
        return SignOut::Unknown;
    };
    match (exit_code, status.logged_in) {
        (Some(1), false) => SignOut::SignedOut,
        (Some(0), true) => SignOut::SignedIn,
        _ => SignOut::Unknown,
    }
}

/// One stdout line of the Codex app-server → verdict, if it is the
/// `account/read` answer.
pub fn codex_line_verdict(line: &str) -> Option<SignOut> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("id")?.as_u64()? != CODEX_ACCOUNT_READ_ID {
        return None;
    }
    let Some(result) = value.get("result").and_then(|r| r.as_object()) else {
        return Some(SignOut::Unknown);
    };
    Some(match result.get("account") {
        Some(serde_json::Value::Null) => SignOut::SignedOut,
        Some(serde_json::Value::Object(_)) => SignOut::SignedIn,
        _ => SignOut::Unknown,
    })
}

fn command(
    program: &Path,
    check: &SignOutCheck,
    path: &std::ffi::OsString,
    home: &Path,
    env: &str,
    dir: &Path,
) -> Command {
    let mut cmd = Command::new(program);
    cmd.args(check.args)
        .stdin(if check.requests.is_empty() {
            Stdio::null()
        } else {
            Stdio::piped()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .current_dir(home)
        .env("PATH", path);
    for key in harness_path::STRIPPED_ENV {
        cmd.env_remove(key);
    }
    cmd.env(env, dir);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd
}

fn end(child: &mut Child) {
    #[cfg(unix)]
    unsafe {
        // The whole group: the CLI and anything it started.
        libc::killpg(child.id() as i32, libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Run the check for `harness` with its profile variable `env` = `dir`.
pub fn check_signed_out(harness: &str, env: &str, dir: &Path, home: &Path) -> SignOut {
    check_with(
        harness,
        env,
        dir,
        home,
        &harness_path::current_search_path(),
        SIGNOUT_TIMEOUT,
    )
}

pub fn check_with(
    harness: &str,
    env: &str,
    dir: &Path,
    home: &Path,
    path: &std::ffi::OsString,
    timeout: Duration,
) -> SignOut {
    let Some(check) = SIGNOUT_CHECKS.iter().find(|row| row.id == harness) else {
        return SignOut::Unknown;
    };
    let Some(program) = harness_path::find_on_path(check.id, path) else {
        return SignOut::Unknown;
    };
    let Ok(mut child) = command(&program, check, path, home, env, dir).spawn() else {
        return SignOut::Unknown;
    };
    let Some(stdout) = child.stdout.take() else {
        end(&mut child);
        return SignOut::Unknown;
    };
    if check.requests.is_empty() {
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        // Claude: read all of stdout (bounded), then the exit code.
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stdout.take(MAX_STDOUT).read_to_end(&mut buf);
            let _ = tx.send(buf);
        });
        let verdict = match rx.recv_timeout(timeout) {
            Ok(buf) => {
                let code = wait_code(&mut child, timeout);
                claude_verdict(code, &buf)
            }
            Err(_) => SignOut::Unknown,
        };
        end(&mut child);
        verdict
    } else {
        // Codex: write the three requests, read lines until the answer.
        // stdin stays open until the end: the server exits on EOF before
        // answering.
        let mut held = child.stdin.take();
        let written = held.as_mut().is_some_and(|stdin| {
            CODEX_LINES
                .iter()
                .all(|line| writeln!(stdin, "{line}").is_ok())
                && stdin.flush().is_ok()
        });
        if !written {
            end(&mut child);
            return SignOut::Unknown;
        }
        let (tx, rx) = mpsc::channel::<SignOut>();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout.take(MAX_STDOUT));
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => {
                        let _ = tx.send(SignOut::Unknown);
                        return;
                    }
                    Ok(_) => {
                        if let Some(verdict) = codex_line_verdict(line.trim_end()) {
                            let _ = tx.send(verdict);
                            return;
                        }
                    }
                }
            }
        });
        let verdict = rx.recv_timeout(timeout).unwrap_or(SignOut::Unknown);
        end(&mut child);
        drop(held);
        verdict
    }
}

fn wait_code(child: &mut Child, timeout: Duration) -> Option<i32> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.code(),
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20))
            }
            _ => return None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    const TOKEN: &str = "sk-ant-oat01-FAKE2996TOKENvalue";

    struct Bin(PathBuf);
    impl Bin {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("oort-2996-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Bin(dir.canonicalize().unwrap())
        }
        fn script(&self, name: &str, body: &str) {
            let path = self.0.join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        fn path(&self) -> std::ffi::OsString {
            std::env::join_paths([
                self.0.clone(),
                PathBuf::from("/bin"),
                PathBuf::from("/usr/bin"),
            ])
            .unwrap()
        }
        fn run(&self, harness: &str, env: &str) -> SignOut {
            let dir = self.0.join("prof");
            std::fs::create_dir_all(&dir).unwrap();
            check_with(
                harness,
                env,
                &dir,
                &self.0,
                &self.path(),
                Duration::from_secs(5),
            )
        }
    }
    impl Drop for Bin {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn the_check_list_is_exact() {
        assert_eq!(
            SIGNOUT_CHECKS,
            &[
                SignOutCheck {
                    id: "claude",
                    args: &["auth", "status", "--json"],
                    requests: &[]
                },
                SignOutCheck {
                    id: "codex",
                    args: &["app-server"],
                    requests: &["initialize", "account/read"],
                },
            ]
        );
        // The lines sent are exactly those three methods, in order.
        let methods: Vec<String> = CODEX_LINES
            .iter()
            .map(|l| {
                serde_json::from_str::<serde_json::Value>(l).unwrap()["method"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(methods, SIGNOUT_CHECKS[1].requests);
        // No login/logout/credit method can be sent on this connection (D3-d).
        let src = include_str!("profile_signout.rs")
            .split("#[cfg(test)]\nmod tests")
            .next()
            .unwrap();
        for needle in [
            "account/login",
            "account/logout",
            "rateLimitResetCredit",
            "sendAddCreditsNudgeEmail",
            "thread/",
            "turn/",
        ] {
            assert!(!src.contains(needle), "{needle}");
        }
    }

    #[test]
    fn claude_verdict_needs_both_the_exit_code_and_the_json() {
        let out = br#"{"loggedIn": false, "authMethod": "none", "configDirectory": "/x"}"#;
        assert_eq!(claude_verdict(Some(1), out), SignOut::SignedOut);
        assert_eq!(
            claude_verdict(Some(0), br#"{"loggedIn": true, "email": "a@b.c"}"#),
            SignOut::SignedIn
        );
        // A crash: exit 1 with no JSON, or a stack trace.
        assert_eq!(claude_verdict(Some(1), b""), SignOut::Unknown);
        assert_eq!(
            claude_verdict(
                Some(1),
                b"TypeError: undefined is not a function\n    at JL"
            ),
            SignOut::Unknown
        );
        // Contradictions and other codes are not an answer.
        assert_eq!(
            claude_verdict(Some(1), br#"{"loggedIn": true}"#),
            SignOut::Unknown
        );
        assert_eq!(claude_verdict(Some(2), out), SignOut::Unknown);
        assert_eq!(claude_verdict(None, out), SignOut::Unknown);
        assert_eq!(
            claude_verdict(Some(1), br#"{"authMethod": "none"}"#),
            SignOut::Unknown
        );
    }

    #[test]
    fn codex_verdict_reads_only_the_account_read_answer() {
        assert_eq!(
            codex_line_verdict(r#"{"id":1,"result":{"userAgent":"x"}}"#),
            None
        );
        assert_eq!(
            codex_line_verdict(r#"{"method":"remoteControl/status/changed","params":{}}"#),
            None
        );
        assert_eq!(
            codex_line_verdict(r#"{"id":2,"result":{"account":null,"requiresOpenaiAuth":true}}"#),
            Some(SignOut::SignedOut)
        );
        assert_eq!(
            codex_line_verdict(
                r#"{"id":2,"result":{"account":{"type":"chatgpt","email":"a@b.c"}}}"#
            ),
            Some(SignOut::SignedIn)
        );
        assert_eq!(
            codex_line_verdict(r#"{"id":2,"error":{"code":-1}}"#),
            Some(SignOut::Unknown)
        );
        assert_eq!(
            codex_line_verdict(r#"{"id":2,"result":{}}"#),
            Some(SignOut::Unknown)
        );
        assert_eq!(codex_line_verdict("not json"), None);
    }

    // PR #2996 re-review Medium-1: a CLI that crashes with exit 1 keeps the
    // folder. Before this module the gate read the exit code alone and said
    // "signed out".
    #[test]
    fn a_crash_with_exit_1_is_not_signed_out() {
        let bin = Bin::new("crash");
        bin.script("claude", "echo 'Error: keychain read failed' >&2\nexit 1");
        assert_eq!(bin.run("claude", "CLAUDE_CONFIG_DIR"), SignOut::Unknown);
        bin.script("codex", "echo 'Error: panic' >&2\nexit 1");
        assert_eq!(bin.run("codex", "CODEX_HOME"), SignOut::Unknown);
    }

    #[test]
    fn a_real_signed_out_answer_in_that_folder_is_signed_out() {
        let bin = Bin::new("out");
        let dir = bin.0.join("prof");
        bin.script(
            "claude",
            &format!(
                "[ \"$#\" = 3 ] && [ \"$1\" = auth ] && [ \"$2\" = status ] && [ \"$3\" = --json ] || exit 9\n\
                 [ \"$CLAUDE_CONFIG_DIR\" = '{}' ] || exit 8\n\
                 echo '{{\"loggedIn\": false, \"authMethod\": \"none\", \"configDirectory\": \"{TOKEN}\"}}'\nexit 1",
                dir.display()
            ),
        );
        assert_eq!(bin.run("claude", "CLAUDE_CONFIG_DIR"), SignOut::SignedOut);
        bin.script(
            "codex",
            &format!(
                "[ \"$#\" = 1 ] && [ \"$1\" = app-server ] || exit 9\n\
                 [ \"$CODEX_HOME\" = '{}' ] || exit 8\n\
                 read a; read b\n\
                 case \"$b\" in *account/read*) ;; *) exit 7;; esac\n\
                 echo '{{\"id\":1,\"result\":{{\"userAgent\":\"x\"}}}}'\n\
                 echo '{{\"id\":2,\"result\":{{\"account\":null,\"requiresOpenaiAuth\":true}}}}'\n\
                 sleep 30",
                dir.display()
            ),
        );
        let started = std::time::Instant::now();
        assert_eq!(bin.run("codex", "CODEX_HOME"), SignOut::SignedOut);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "server not ended"
        );
    }

    #[test]
    fn signed_in_hangs_and_missing_clis_keep_the_folder() {
        let bin = Bin::new("in");
        bin.script(
            "claude",
            &format!("echo '{{\"loggedIn\": true, \"email\": \"{TOKEN}\"}}'\nexit 0"),
        );
        assert_eq!(bin.run("claude", "CLAUDE_CONFIG_DIR"), SignOut::SignedIn);
        bin.script(
            "codex",
            "read a; read b\necho '{\"id\":2,\"result\":{\"account\":{\"type\":\"apiKey\"}}}'\nsleep 30",
        );
        assert_eq!(bin.run("codex", "CODEX_HOME"), SignOut::SignedIn);
        bin.script("codex", "exec /bin/sleep 30");
        let started = std::time::Instant::now();
        assert_eq!(bin.run("codex", "CODEX_HOME"), SignOut::Unknown);
        assert!(started.elapsed() < Duration::from_secs(8));
        let empty = Bin::new("none");
        assert_eq!(empty.run("claude", "CLAUDE_CONFIG_DIR"), SignOut::Unknown);
        assert_eq!(bin.run("grok", "X"), SignOut::Unknown);
    }

    #[test]
    fn redirect_variables_do_not_reach_the_check() {
        let bin = Bin::new("env");
        let check = harness_path::STRIPPED_ENV
            .iter()
            .map(|key| format!("[ -z \"${{{key}+x}}\" ]"))
            .collect::<Vec<_>>()
            .join(" && ");
        bin.script(
            "claude",
            &format!("{check} || exit 5\necho '{{\"loggedIn\": false}}'\nexit 1"),
        );
        for key in harness_path::STRIPPED_ENV {
            std::env::set_var(key, "dummy-for-test");
        }
        let verdict = bin.run("claude", "CLAUDE_CONFIG_DIR");
        for key in harness_path::STRIPPED_ENV {
            std::env::remove_var(key);
        }
        assert_eq!(verdict, SignOut::SignedOut);
    }

    /// This Mac, for real: both official CLIs against an empty scratch
    /// profile folder must answer "signed out". Run by hand:
    /// `cargo test live_signout -- --ignored --nocapture`
    #[test]
    #[ignore = "runs the real claude/codex against a scratch folder"]
    fn live_signout_on_this_mac() {
        let home = PathBuf::from(std::env::var_os("HOME").unwrap())
            .canonicalize()
            .unwrap();
        for (harness, env) in [("claude", "CLAUDE_CONFIG_DIR"), ("codex", "CODEX_HOME")] {
            let dir = std::env::temp_dir()
                .join(format!("oort-2996-live-{harness}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let dir = dir.canonicalize().unwrap();
            let verdict = check_signed_out(harness, env, &dir, &home);
            println!("live {harness}: {verdict:?}");
            let _ = std::fs::remove_dir_all(&dir);
            assert_eq!(verdict, SignOut::SignedOut, "{harness}");
        }
    }

    /// Nothing here logs, stores or opens a file; output reaches no one but
    /// the two verdict functions.
    #[test]
    fn no_logging_and_no_file_access() {
        let src = include_str!("profile_signout.rs")
            .split("#[cfg(test)]\nmod tests")
            .next()
            .unwrap();
        for needle in [
            "println!",
            "eprintln!",
            "dbg!(",
            "log::",
            "tracing::",
            "File::open",
            "File::create",
            "std::fs::",
            "Stdio::inherit",
        ] {
            assert!(!src.contains(needle), "{needle}");
        }
    }
}
