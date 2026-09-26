// Local harness detection (#2813, ADR-0190 D3-a·D3-b, ADR-0193 D3).
//
// For each harness on the list below the shell reports two facts to the
// webview: is the CLI on this Mac, and what does the CLI itself say about its
// login. Nothing else crosses: no path, no version, no account, no output.
//
//   detect_local_harnesses  (no arguments)  -> LocalHarnessProbe[]
//       { id: "claude" | "codex", installed, auth: logged_in | needs_login | unknown }
//
// The boundary:
//
// 1. **Exactly two commands.** `STATUS_COMMANDS` is the whole allowlist:
//    `claude auth status` and `codex login status`. Program name and
//    arguments are literals here; the webview sends nothing (the command has
//    no parameters), and no event listener, deep link or server message calls
//    into this module. `run_status` is the only place in this file that builds
//    a `Command`, and it takes its argv from that table.
// 2. **Absolute path, no shell.** The program is resolved with
//    `harness_path::find_on_path` and run by that absolute path, directly
//    (never through `sh -c`). The child's PATH is the same search path, so an
//    npm-installed CLI whose first line is `#!/usr/bin/env node` finds `node`
//    even when the app was launched from Finder. The account variables
//    ADR-0191 D2 names are removed from the child's environment (their values
//    are never read), so the answer matches what a local terminal pane would
//    see. cwd is `$HOME`, not the GUI's `/`.
// 3. **Exit code only.** stdin, stdout and stderr are all `Stdio::null()`.
//    `claude auth status` prints JSON that can name the account; none of it
//    is read. 0 = the CLI says it is logged in, non-zero = needs login, could
//    not start or did not finish within `STATUS_TIMEOUT` = unknown. Known
//    loss (ADR-0190 D3-a): a broken CLI config also exits non-zero and so
//    shows as "needs login"; opening the CLI shows the real error.
// 4. **No credential files.** This crate never opens a harness's config
//    folder, its token file, the keychain entries of other apps, or reads an
//    environment variable's value to decide login. `shell_contract.rs` pins
//    the absence of those path strings across the whole shell source.
//
// A timed-out child is killed (the direct child only) and reaped.

use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::harness_path;

/// The complete allowlist: harness id, program name on PATH, fixed arguments.
/// Keep ids in lockstep with `LOCAL_HARNESS_IDS` in momo-core `detect.ts`.
pub const STATUS_COMMANDS: &[StatusCommand] = &[
    StatusCommand {
        id: "claude",
        program: "claude",
        args: &["auth", "status"],
    },
    StatusCommand {
        id: "codex",
        program: "codex",
        args: &["login", "status"],
    },
];

/// Upper bound for one status command. Both run in parallel, so the whole
/// probe takes at most this long. A cold Node start is about a second; the
/// rest is room for a slow disk or a busy machine.
pub const STATUS_TIMEOUT: Duration = Duration::from_secs(6);

const POLL_EVERY: Duration = Duration::from_millis(25);

#[derive(Debug, PartialEq, Eq)]
pub struct StatusCommand {
    pub id: &'static str,
    pub program: &'static str,
    pub args: &'static [&'static str],
}

/// What the CLI said, reduced to three values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessAuth {
    LoggedIn,
    NeedsLogin,
    Unknown,
}

/// One allowlisted harness, observed. Never carries a path, output or account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalHarnessProbe {
    pub id: &'static str,
    pub installed: bool,
    pub auth: HarnessAuth,
}

/// Exit status → login state. `None` = did not start or did not finish.
pub fn auth_from_exit(status: Option<ExitStatus>) -> HarnessAuth {
    match status {
        Some(status) if status.success() => HarnessAuth::LoggedIn,
        // A signal (no code) is not an answer from the CLI.
        Some(status) if status.code().is_some() => HarnessAuth::NeedsLogin,
        _ => HarnessAuth::Unknown,
    }
}

/// Run one allowlisted command by absolute path and wait at most `timeout`.
fn run_status(
    program: &Path,
    command: &StatusCommand,
    search_path: &std::ffi::OsString,
    home: Option<&Path>,
    timeout: Duration,
) -> Option<ExitStatus> {
    if !program.is_absolute() {
        return None;
    }
    let mut cmd = Command::new(program);
    cmd.args(command.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env("PATH", search_path);
    for key in harness_path::ACCOUNT_ENV {
        cmd.env_remove(key);
    }
    if let Some(home) = home {
        cmd.current_dir(home);
    }
    let mut child = cmd.spawn().ok()?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(POLL_EVERY),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// Probe one allowlisted harness: resolve on `search_path`, run its status
/// command if found.
pub fn probe_one(
    command: &'static StatusCommand,
    search_path: &std::ffi::OsString,
    home: Option<&Path>,
    timeout: Duration,
) -> LocalHarnessProbe {
    match harness_path::find_on_path(command.program, search_path) {
        None => LocalHarnessProbe {
            id: command.id,
            installed: false,
            auth: HarnessAuth::Unknown,
        },
        Some(program) => LocalHarnessProbe {
            id: command.id,
            installed: true,
            auth: auth_from_exit(run_status(&program, command, search_path, home, timeout)),
        },
    }
}

/// Probe every allowlisted harness in parallel, in allowlist order.
pub fn probe_all(
    search_path: &std::ffi::OsString,
    home: Option<&Path>,
    timeout: Duration,
) -> Vec<LocalHarnessProbe> {
    std::thread::scope(|scope| {
        let handles: Vec<_> = STATUS_COMMANDS
            .iter()
            .map(|command| scope.spawn(move || probe_one(command, search_path, home, timeout)))
            .collect();
        handles
            .into_iter()
            .zip(STATUS_COMMANDS)
            .map(|(handle, command)| {
                handle.join().unwrap_or(LocalHarnessProbe {
                    id: command.id,
                    installed: false,
                    auth: HarnessAuth::Unknown,
                })
            })
            .collect()
    })
}

fn probe_live() -> Vec<LocalHarnessProbe> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    probe_all(
        &harness_path::current_search_path(),
        home.as_deref(),
        STATUS_TIMEOUT,
    )
}

/// Best-effort; never an error. Takes no arguments on purpose: the webview
/// cannot name a program, an argument or a path.
#[tauri::command]
pub async fn detect_local_harnesses() -> Vec<LocalHarnessProbe> {
    tauri::async_runtime::spawn_blocking(probe_live)
        .await
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    /// Production part of this file (everything before the test module).
    fn production_source() -> &'static str {
        include_str!("harness_status.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("production source")
    }

    // ① The allowlist is exactly two commands.
    #[test]
    fn allowlist_is_exactly_claude_auth_status_and_codex_login_status() {
        assert_eq!(
            STATUS_COMMANDS,
            &[
                StatusCommand {
                    id: "claude",
                    program: "claude",
                    args: &["auth", "status"],
                },
                StatusCommand {
                    id: "codex",
                    program: "codex",
                    args: &["login", "status"],
                },
            ]
        );
    }

    // ① A second command cannot be added beside the table either: this file
    // builds exactly one `Command`, never a shell.
    #[test]
    fn one_command_builder_and_no_shell() {
        let src = production_source();
        assert_eq!(src.matches("Command::new(").count(), 1);
        for needle in ["\"sh\"", "\"/bin/sh\"", "\"-c\"", "\"zsh\"", "\"bash\""] {
            assert!(
                !src.contains(needle),
                "status probe must not mention {needle}"
            );
        }
    }

    // ③ (source half) Output is discarded, never read.
    #[test]
    fn output_is_discarded_not_read() {
        let src = production_source();
        for needle in [
            ".stdout(Stdio::null())",
            ".stderr(Stdio::null())",
            ".stdin(Stdio::null())",
        ] {
            assert!(src.contains(needle), "missing {needle}");
        }
        for needle in [
            "Stdio::piped",
            "Stdio::inherit",
            ".output()",
            "read_to_string",
            "read_to_end",
        ] {
            assert!(!src.contains(needle), "status probe must not use {needle}");
        }
    }

    #[test]
    fn exit_code_is_the_whole_verdict() {
        assert_eq!(auth_from_exit(None), HarnessAuth::Unknown);
        assert_eq!(
            serde_json::to_value(HarnessAuth::NeedsLogin).unwrap(),
            serde_json::json!("needs_login")
        );
        assert_eq!(
            serde_json::to_value(LocalHarnessProbe {
                id: "claude",
                installed: true,
                auth: HarnessAuth::LoggedIn,
            })
            .unwrap(),
            serde_json::json!({ "id": "claude", "installed": true, "auth": "logged_in" })
        );
    }

    /// This Mac, for real: the two allowlisted commands against the installed
    /// CLIs. Prints only the three-value wire form. Run by hand:
    /// `PATH=/usr/bin:/bin:/usr/sbin:/sbin cargo test live_probe -- --ignored --nocapture`
    /// (the launchd PATH a Finder-launched app gets).
    #[test]
    #[ignore = "runs the real claude/codex status commands"]
    fn live_probe_on_this_mac() {
        let started = Instant::now();
        let probes = probe_live();
        println!(
            "live probes ({} ms): {}",
            started.elapsed().as_millis(),
            serde_json::to_string(&probes).unwrap()
        );
        assert_eq!(probes.len(), 2);
    }

    #[cfg(unix)]
    mod fake_cli {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        const TOKEN: &str = "sk-ant-oat01-FAKE2813TOKENvalueXYZ";

        struct Bin(PathBuf);

        impl Bin {
            fn new(tag: &str) -> Self {
                let dir =
                    std::env::temp_dir().join(format!("oort-2813-{tag}-{}", std::process::id()));
                let _ = std::fs::remove_dir_all(&dir);
                std::fs::create_dir_all(&dir).unwrap();
                Bin(dir)
            }

            fn script(&self, name: &str, body: &str) {
                let path = self.0.join(name);
                std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            }

            fn path(&self) -> OsString {
                std::env::join_paths([self.0.clone()]).unwrap()
            }
        }

        impl Drop for Bin {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }

        // ③ A CLI that prints a token and exits 0 is "logged in" — and the
        // token is nowhere in what the webview receives.
        #[test]
        fn token_on_stdout_and_stderr_never_reaches_the_webview_value() {
            let bin = Bin::new("token");
            let body = format!(
                "echo '{{\"loggedIn\":true,\"email\":\"someone@example.com\",\"token\":\"{TOKEN}\"}}'\n\
                 echo '{TOKEN}' >&2\nexit 0"
            );
            bin.script("claude", &body);
            bin.script("codex", &body);
            let probes = probe_all(&bin.path(), None, Duration::from_secs(10));
            let wire = serde_json::to_string(&probes).unwrap();
            assert!(!wire.contains(TOKEN), "wire = {wire}");
            assert!(!wire.contains("someone@example.com"), "wire = {wire}");
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&wire).unwrap(),
                serde_json::json!([
                    { "id": "claude", "installed": true, "auth": "logged_in" },
                    { "id": "codex", "installed": true, "auth": "logged_in" },
                ])
            );
        }

        #[test]
        fn the_fixed_arguments_are_what_the_cli_receives() {
            let bin = Bin::new("args");
            bin.script(
                "claude",
                "[ \"$#\" = 2 ] && [ \"$1\" = auth ] && [ \"$2\" = status ]",
            );
            bin.script(
                "codex",
                "[ \"$#\" = 2 ] && [ \"$1\" = login ] && [ \"$2\" = status ]",
            );
            let probes = probe_all(&bin.path(), None, Duration::from_secs(10));
            assert!(
                probes.iter().all(|p| p.auth == HarnessAuth::LoggedIn),
                "{probes:?}"
            );
        }

        #[test]
        fn non_zero_is_needs_login_and_a_hang_is_unknown() {
            let bin = Bin::new("verdicts");
            bin.script("claude", "echo 'Not logged in' >&2\nexit 1");
            // `exec` so the killed child is the sleeper itself; PATH is only the
            // fake bin folder, hence the absolute path.
            bin.script("codex", "exec /bin/sleep 30");
            let started = Instant::now();
            let probes = probe_all(&bin.path(), None, Duration::from_millis(300));
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "timeout not enforced"
            );
            assert_eq!(
                probes,
                vec![
                    LocalHarnessProbe {
                        id: "claude",
                        installed: true,
                        auth: HarnessAuth::NeedsLogin,
                    },
                    LocalHarnessProbe {
                        id: "codex",
                        installed: true,
                        auth: HarnessAuth::Unknown,
                    },
                ]
            );
        }

        #[test]
        fn missing_cli_is_not_installed_and_unknown() {
            let bin = Bin::new("missing");
            bin.script("codex", "exit 0");
            let probes = probe_all(&bin.path(), None, Duration::from_secs(10));
            assert_eq!(
                probes,
                vec![
                    LocalHarnessProbe {
                        id: "claude",
                        installed: false,
                        auth: HarnessAuth::Unknown,
                    },
                    LocalHarnessProbe {
                        id: "codex",
                        installed: true,
                        auth: HarnessAuth::LoggedIn,
                    },
                ]
            );
        }

        #[test]
        fn account_variables_do_not_reach_the_child() {
            let bin = Bin::new("env");
            // Exits 0 only when none of the account variables is set.
            let check = harness_path::ACCOUNT_ENV
                .iter()
                .map(|key| format!("[ -z \"${{{key}+x}}\" ]"))
                .collect::<Vec<_>>()
                .join(" && ");
            bin.script("claude", &check);
            bin.script("codex", &check);
            // The child would inherit these from this test process unless
            // `run_status` removes them. Dummy values, removed again below.
            for key in harness_path::ACCOUNT_ENV {
                std::env::set_var(key, "dummy-for-test");
            }
            let status = run_status(
                &bin.0.join("claude"),
                &STATUS_COMMANDS[0],
                &bin.path(),
                None,
                Duration::from_secs(10),
            );
            for key in harness_path::ACCOUNT_ENV {
                std::env::remove_var(key);
            }
            assert_eq!(auth_from_exit(status), HarnessAuth::LoggedIn);
        }
    }
}
