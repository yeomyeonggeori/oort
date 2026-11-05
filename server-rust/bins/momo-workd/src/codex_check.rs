//! #2647 (ADR-0188 §8.10, R1.4) — Codex's effective settings, read back.
//!
//! The host switches 15 Codex features off with keys, in its own `config.toml`
//! and in `CODEX_CONFIG` ([`crate::policy::CODEX_DISABLED_FEATURES`]).
//! `shell_snapshot = false` is one of them, and it is what keeps the owner's
//! `.zshrc` exports out of every command a remote session runs. A key only
//! means something while the codex that reads it still understands it: a codex
//! update that ignored or renamed one would run the feature on its default and
//! nothing would say so (#2644 security review L1, a fail-open).
//!
//! So before every Codex session the host asks the adapter's own executable for
//! the table codex prints (`<adapter> cli features list`,
//! [`policy::CODEX_FEATURES_PROBE`]) and starts the session only when every one
//! of those features reads `false` ([`policy::check_codex_features`]). The
//! check fails closed: an executable that cannot be started, a table that
//! cannot be read, a check that does not finish in time and a feature that is
//! missing or reads anything but `false` all refuse the session
//! ([`policy::Refusal::CodexConfigUnverified`]). The reason goes to the host's
//! log; the adapter's stderr is dropped, as everywhere in this crate.
//!
//! The check runs the way a session would: the environment from
//! [`policy::launch_spec`] (the allowlist plus the Codex isolation variables,
//! so the codex it reaches reads the host's own `CODEX_HOME`), the owner's
//! `args` left out, stdin closed. Its working directory is the host's own temp
//! folder, never the allowed folder, so nothing in a repository can change what
//! the check reads.
//!
//! What it does not cover, said plainly (ADR-0188 §8.10): `cli` does not apply
//! `CODEX_CONFIG`, so the layer read is the host's `config.toml` (the same keys
//! sit in both); a feature codex adds later is not one of the 15; and
//! `[shell_environment_policy]` is not a feature, so a codex that ignored
//! `inherit = "core"` is not seen here. The pinned adapter range
//! (`^0.155.1`) and `tests/codex_isolation_real.rs` stand behind those.

use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncReadExt as _;
use tokio::process::{Child, Command};

use crate::config::{ToolEntry, WorkdConfig};
use crate::policy::{self, AdapterKind, CodexHome, FeatureDrift, Refusal};
use crate::proctree::ProcessTree;

/// Most of the table that is read. A real one is a few KiB (142 rows with
/// codex 0.165.0); a program that prints more is not `features list`.
const MAX_TABLE_BYTES: usize = 256 * 1024;

/// Why the host could not accept Codex's effective settings.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CodexConfigError {
    /// The adapter's executable could not be started or read from.
    #[error("the adapter could not be run for the check: {0}")]
    Launch(String),
    /// The check did not finish in time; its process tree was ended.
    #[error("the check did not finish within {0:?}")]
    TimedOut(Duration),
    /// The check ended with a failure status (an adapter without `cli`, a
    /// codex that rejected the command).
    #[error("the check ended with {0}")]
    Exit(String),
    /// The program printed more than any feature table is.
    #[error("the check printed more than {MAX_TABLE_BYTES} bytes")]
    TooLong,
    /// The table is not the one the host needs.
    #[error("Codex does not report these features off: {}", drift_list(.0))]
    Drift(Vec<FeatureDrift>),
}

fn drift_list(drift: &[FeatureDrift]) -> String {
    drift
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("; ")
}

/// Read Codex's effective feature table through `entry`'s adapter and check it.
/// `codex` is the home the session would use (a profile's, when the owner chose
/// an account), and its `config.toml` must already be the host's
/// ([`policy::prepare_codex_home`]). `timeout` bounds the whole check.
pub async fn verify_codex_features(
    entry: &ToolEntry,
    codex: &CodexHome,
    parent_env: &[(String, String)],
    timeout: Duration,
) -> Result<(), CodexConfigError> {
    let table = read_feature_table(entry, codex, parent_env, timeout).await?;
    policy::check_codex_features(&table).map_err(CodexConfigError::Drift)
}

async fn read_feature_table(
    entry: &ToolEntry,
    codex: &CodexHome,
    parent_env: &[(String, String)],
    timeout: Duration,
) -> Result<String, CodexConfigError> {
    // The environment a session of this entry gets, nothing more.
    let spec = policy::launch_spec(entry, &codex.tmp, parent_env.iter().cloned(), codex, None);
    let mut command = Command::new(&spec.program);
    command
        .args(policy::CODEX_FEATURES_PROBE)
        .current_dir(&codex.tmp)
        .env_clear()
        .envs(
            spec.env
                .iter()
                .map(|(key, value)| (key.as_str(), value.as_str())),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        // Dropped, as `AcpConnection` drops it: it may carry anything.
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .process_group(0);
    let mut child = command
        .spawn()
        .map_err(|error| CodexConfigError::Launch(error.to_string()))?;
    let mut tree = ProcessTree::new(child.id().map_or(-1, |pid| pid as i32));
    let mut stdout = child.stdout.take().expect("piped stdout");

    let finished = tokio::time::timeout(timeout, async {
        let mut table = Vec::new();
        (&mut stdout)
            .take(MAX_TABLE_BYTES as u64 + 1)
            .read_to_end(&mut table)
            .await
            .map_err(|error| CodexConfigError::Launch(error.to_string()))?;
        if table.len() > MAX_TABLE_BYTES {
            return Err(CodexConfigError::TooLong);
        }
        let status = child
            .wait()
            .await
            .map_err(|error| CodexConfigError::Launch(error.to_string()))?;
        Ok((status, table))
    })
    .await;
    let (status, table) = match finished {
        Ok(Ok(done)) => done,
        Ok(Err(error)) => {
            end_probe(&mut child, &mut tree).await;
            return Err(error);
        }
        Err(_) => {
            end_probe(&mut child, &mut tree).await;
            return Err(CodexConfigError::TimedOut(timeout));
        }
    };
    if !status.success() {
        return Err(CodexConfigError::Exit(status.to_string()));
    }
    Ok(String::from_utf8_lossy(&table).into_owned())
}

/// Stop the check and what it started: the census first, while the adapter's
/// launcher is still the root of its tree (codex runs under a node launcher).
async fn end_probe(child: &mut Child, tree: &mut ProcessTree) {
    tree.census();
    let _ = child.start_kill();
    tree.signal_members(libc::SIGKILL);
    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
}

/// `momo-workd run`, at start: check every Codex entry once and say so in the
/// log, so an owner learns of a drifted codex before the first remote session
/// rather than from its refusal. The refusal itself is the check before each
/// session (`SessionManager::spawn`), which also catches an adapter replaced
/// while the host runs. Nothing here stops the host: Claude sessions go on.
pub async fn log_codex_checks(
    config: &WorkdConfig,
    codex: &CodexHome,
    parent_env: &[(String, String)],
) {
    let entries: Vec<(&String, &ToolEntry)> = config
        .tools
        .iter()
        .filter(|(_, entry)| entry.adapter == AdapterKind::Codex)
        .collect();
    if entries.is_empty() {
        return;
    }
    // The host's `config.toml` is written before every session; write it now
    // the same way, so the check reads the file a session would (it may be one
    // an older build wrote). A missing sign-in does not matter to the table.
    let allowed = std::fs::canonicalize(&config.working_directory)
        .unwrap_or_else(|_| config.working_directory.clone());
    match policy::prepare_codex_home(codex, &allowed) {
        Ok(()) | Err(Refusal::CodexLoginRequired) => {}
        Err(refusal) => {
            tracing::warn!(
                refusal = refusal.label(),
                "Codex's host-only home is not ready, so its settings were not checked; \
                 Codex sessions are refused until it is (ADR-0188 §8)"
            );
            return;
        }
    }
    let timeout = Duration::from_millis(config.acp_start_timeout_ms);
    for (tool, entry) in entries {
        match verify_codex_features(entry, codex, parent_env, timeout).await {
            Ok(()) => tracing::info!(
                tool = %tool,
                features = policy::CODEX_DISABLED_FEATURES.len(),
                "Codex reports every feature the host switched off as off (ADR-0188 §8.10)"
            ),
            Err(error) => tracing::warn!(
                tool = %tool,
                reason = %error,
                "Codex's effective settings are not the ones ADR-0188 §8 requires; \
                 Codex sessions are refused until they are (ADR-0188 §8.10)"
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt as _;
    use std::path::PathBuf;

    /// A fake `codex-acp` on disk, with the host's Codex folders beside it.
    struct Fixture {
        root: PathBuf,
        bin: PathBuf,
        codex: CodexHome,
        entry: ToolEntry,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /// The fake: `cli features list` records what it was given and prints
    /// `table.txt`, which a test writes. Anything else is a usage error.
    const PRINTS_THE_TABLE: &str = r#"
if [ "$1 $2 $3" != "cli features list" ]; then exit 64; fi
dir=$(dirname "$0")
{ env; echo "ZZ_PWD=$(pwd)"; echo "ZZ_ARGS=$*"; } > "$dir/probe.dump"
cat "$dir/table.txt"
"#;

    fn fixture(script_body: &str) -> Fixture {
        let root = std::env::temp_dir().join(format!(
            "momo-workd-codex-check-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let bin = root.join("bin");
        let script = bin.join("codex-acp");
        std::fs::write(&script, format!("#!/bin/sh\n{script_body}")).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let codex = CodexHome::beside(&root.join("state").join("host.json"))
            .with_owner_home(Some(root.join("owner-home")));
        std::fs::create_dir_all(&codex.tmp).unwrap();
        let entry = ToolEntry {
            adapter: AdapterKind::Codex,
            executable: script,
            args: vec!["--owner-flag".to_string()],
        };
        Fixture {
            root,
            bin,
            codex,
            entry,
        }
    }

    /// What `codex features list` prints: a row per feature, the stage column
    /// sometimes two words. `overrides` replace a feature's state; a name
    /// prefixed `-` leaves its row out.
    fn table(overrides: &[(&str, &str)]) -> String {
        let mut rows: Vec<(String, &str, String)> = vec![
            ("fast_mode".into(), "stable", "true".into()),
            ("code_mode".into(), "under development", "false".into()),
        ];
        for feature in policy::CODEX_DISABLED_FEATURES {
            rows.push((feature.to_string(), "stable", "false".into()));
        }
        for (name, state) in overrides {
            if let Some(gone) = name.strip_prefix('-') {
                rows.retain(|(row, _, _)| row != gone);
            } else if let Some(row) = rows.iter_mut().find(|row| row.0 == *name) {
                row.2 = state.to_string();
            }
        }
        rows.iter()
            .map(|(name, stage, state)| format!("{name:<40} {stage:<18} {state}\n"))
            .collect()
    }

    fn parent_env() -> Vec<(String, String)> {
        [
            ("PATH", "/usr/bin:/bin:/usr/sbin:/sbin"),
            ("HOME", "/Users/zz-owner"),
            ("ZZ_PROBE_TOKEN", "zz-fake-token-2647"),
            ("MOMO_WORKD_REGISTER_TOKEN", "zz-fake-registration-2647"),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect()
    }

    /// `verify_codex_features`, tolerating one thing only a test can cause: a
    /// script written a moment ago is "text file busy" while another test
    /// thread's fork still holds its descriptor.
    async fn verify(f: &Fixture, timeout: Duration) -> Result<(), CodexConfigError> {
        for _ in 0..40 {
            match verify_codex_features(&f.entry, &f.codex, &parent_env(), timeout).await {
                Err(CodexConfigError::Launch(message)) if message.contains("busy") => {
                    tokio::time::sleep(Duration::from_millis(50)).await
                }
                other => return other,
            }
        }
        panic!("the fake adapter stayed busy");
    }

    const SECONDS: Duration = Duration::from_secs(20);

    #[tokio::test]
    async fn the_check_runs_the_adapter_as_a_session_would_and_accepts_every_feature_off() {
        let f = fixture(PRINTS_THE_TABLE);
        std::fs::write(f.bin.join("table.txt"), table(&[])).unwrap();
        assert_eq!(verify(&f, SECONDS).await, Ok(()));

        let dump = std::fs::read_to_string(f.bin.join("probe.dump")).unwrap();
        let has = |line: String| dump.lines().any(|seen| seen == line);
        // The host's own Codex folders, as for a session.
        assert!(
            has(format!("CODEX_HOME={}", f.codex.home.display())),
            "{dump}"
        );
        assert!(
            has(format!("HOME={}", f.codex.user_home.display())),
            "{dump}"
        );
        assert!(has(format!("TMPDIR={}", f.codex.tmp.display())), "{dump}");
        // Only the allowlist of the host's own environment: no credential, no
        // host configuration.
        assert!(
            !dump.contains("ZZ_PROBE_TOKEN") && !dump.contains("MOMO_WORKD_REGISTER_TOKEN"),
            "the host's environment reached the check: {dump}"
        );
        // Not the owner's arguments, and not a repository.
        assert!(has("ZZ_ARGS=cli features list".to_string()), "{dump}");
        assert!(
            has(format!(
                "ZZ_PWD={}",
                std::fs::canonicalize(&f.codex.tmp).unwrap().display()
            )),
            "{dump}"
        );
    }

    #[tokio::test]
    async fn a_feature_that_reads_on_or_is_gone_from_the_table_refuses_the_session() {
        let f = fixture(PRINTS_THE_TABLE);
        for (case, printed, drift) in [
            (
                "codex ignores the key",
                table(&[("shell_snapshot", "true")]),
                vec![FeatureDrift::NotOff {
                    feature: "shell_snapshot",
                    state: "true".to_string(),
                }],
            ),
            (
                "codex renamed the feature",
                table(&[("-shell_snapshot", "")]),
                vec![FeatureDrift::Missing("shell_snapshot")],
            ),
            (
                "any one of the fifteen",
                table(&[("hooks", "true"), ("-memories", "")]),
                vec![
                    FeatureDrift::NotOff {
                        feature: "hooks",
                        state: "true".to_string(),
                    },
                    FeatureDrift::Missing("memories"),
                ],
            ),
        ] {
            std::fs::write(f.bin.join("table.txt"), printed).unwrap();
            assert_eq!(
                verify(&f, SECONDS).await,
                Err(CodexConfigError::Drift(drift)),
                "{case}"
            );
        }
    }

    #[tokio::test]
    async fn a_check_that_cannot_answer_is_a_refusal_never_a_pass() {
        // Fails with a status.
        let f = fixture("exit 3\n");
        let error = verify(&f, SECONDS).await.unwrap_err();
        assert!(
            matches!(&error, CodexConfigError::Exit(status) if status.contains('3')),
            "{error:?}"
        );
        // An adapter without `cli` prints something else (or nothing): every
        // feature is missing, which is not off.
        for body in ["echo 'error: unrecognized subcommand'\n", "exit 0\n"] {
            let f = fixture(body);
            match verify(&f, SECONDS).await {
                Err(CodexConfigError::Drift(drift)) => assert_eq!(
                    drift,
                    policy::CODEX_DISABLED_FEATURES
                        .iter()
                        .map(|&feature| FeatureDrift::Missing(feature))
                        .collect::<Vec<_>>(),
                    "{body}"
                ),
                other => panic!("{body}: {other:?}"),
            }
        }
        // Prints more than any table is.
        let f = fixture("yes | head -c 400000\n");
        assert_eq!(verify(&f, SECONDS).await, Err(CodexConfigError::TooLong));
        // Is not there.
        let mut f = fixture("exit 0\n");
        f.entry.executable = f.root.join("not-installed");
        assert!(matches!(
            verify(&f, SECONDS).await,
            Err(CodexConfigError::Launch(_))
        ));
    }

    #[tokio::test]
    async fn a_check_that_hangs_is_ended_with_everything_it_started() {
        let f =
            fixture("dir=$(dirname \"$0\")\nsleep 30 &\necho $! > \"$dir/sleeper.pid\"\nwait\n");
        let started = std::time::Instant::now();
        // Long enough that a loaded machine has started the script's `sleep`
        // (the census that finds it needs the tree to exist); the script
        // would run for 30 s.
        let limit = Duration::from_secs(4);
        let error = verify(&f, limit).await.unwrap_err();
        assert_eq!(error, CodexConfigError::TimedOut(limit));
        assert!(started.elapsed() < Duration::from_secs(15), "bounded");
        let sleeper: i32 = std::fs::read_to_string(f.bin.join("sleeper.pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let mut gone = false;
        for _ in 0..100 {
            if crate::proctree::info(sleeper).is_none_or(|process| process.zombie) {
                gone = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(gone, "the process the check started is still running");
    }
}
