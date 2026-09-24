//! #2630 (ADR-0188 §8.1, R1.3): the Codex isolation measured against the
//! **real** codex binary — the one codex-acp 1.13.0 runs (`@openai/codex`
//! `^0.155.1`), started the way codex-acp starts it (`codex app-server` with
//! the adapter's own environment, `dist/index.js` `startCodexConnection`).
//! No thread turn is ever started, so no model is called: the thread uses a
//! dead-end local model provider, and the probes are `codex sandbox`,
//! `thread/shellCommand` and `skills/list`.
//!
//! `#[ignore]` — needs the codex binary:
//!
//! ```text
//! MOMO_WORKD_CODEX_BIN=/path/to/codex \
//!   cargo test -p momo-workd --test codex_isolation_real -- --ignored --nocapture --test-threads=1
//! ```
//!
//! | test | the guard whose removal turns it red |
//! |---|---|
//! | `a_codex_command_sees_no_credential_from_the_host_or_the_owners_shell_files` | the agent environment allowlist (`policy::launch_spec`), `[shell_environment_policy]` and `shell_snapshot = false` in the host `config.toml` (`policy::codex_home_config`) |
//! | `codex_loads_no_skill_from_the_owners_home` | `HOME` in Codex's isolation environment (`policy::AdapterKind::isolation_env`, F5) |

use std::collections::BTreeMap;
use std::io::{BufRead as _, BufReader, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use momo_workd::config::ToolEntry;
use momo_workd::policy::{self, AdapterKind, CodexHome, Refusal};
use serde_json::{json, Value};

fn codex_bin() -> PathBuf {
    std::env::var_os("MOMO_WORKD_CODEX_BIN")
        .map(PathBuf::from)
        .expect("set MOMO_WORKD_CODEX_BIN to the codex binary (codex-cli 0.155.1)")
}

/// A host that is about to start a Codex session: the owner's home (a
/// fixture with an owner-layer skill and shell startup files that export
/// fake credentials), the allowed folder, and the host's state folder.
struct Fixture {
    root: PathBuf,
    owner_home: PathBuf,
    repo: PathBuf,
    codex: CodexHome,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn fixture() -> Fixture {
    let root = std::env::temp_dir().join(format!(
        "momo-workd-codex-real-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let root = std::fs::canonicalize(root).unwrap();
    let owner_home = root.join("owner-home");
    let skill = owner_home
        .join(".agents")
        .join("skills")
        .join("zz-owner-skill");
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(
        skill.join("SKILL.md"),
        "---\nname: zz-owner-skill\ndescription: an owner-layer skill (fixture)\n---\n",
    )
    .unwrap();
    for (file, name) in [
        (".zshrc", "ZZ_RC_TOKEN"),
        (".zprofile", "ZZ_PROFILE_TOKEN"),
        (".zshenv", "ZZ_ZSHENV_TOKEN"),
    ] {
        std::fs::write(
            owner_home.join(file),
            format!("export {name}=zz-fake-{}-2630\n", name.to_lowercase()),
        )
        .unwrap();
    }
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let codex = CodexHome::beside(&root.join("state").join("host.json"))
        .with_owner_home(Some(owner_home.clone()));
    // No sign-in on purpose: nothing may reach an OpenAI endpoint. The home,
    // its temp folder and the host's config are prepared all the same.
    assert_eq!(
        policy::prepare_codex_home(&codex, &repo),
        Err(Refusal::CodexLoginRequired)
    );
    Fixture {
        root,
        owner_home,
        repo,
        codex,
    }
}

const PLANTED: [(&str, &str); 3] = [
    ("ZZ_TEST_TOKEN", "zz-fake-token-2630"),
    ("ZZ_TEST_API_KEY", "zz-fake-api-key-2630"),
    ("MOMO_WORKD_REGISTER_TOKEN", "zz-fake-registration-2630"),
];

/// The environment codex runs with: exactly what `launch_spec` hands the
/// adapter (codex-acp passes its own environment to `codex app-server`),
/// from a host environment carrying planted credentials — plus one more
/// credential placed in Codex's own environment directly, to measure the
/// `[shell_environment_policy]` layer on its own.
fn codex_process_env(f: &Fixture) -> Vec<(String, String)> {
    let mut host: Vec<(String, String)> = [
        ("PATH", "/usr/bin:/bin:/usr/sbin:/sbin"),
        ("USER", "momo-2630"),
        ("LOGNAME", "momo-2630"),
        ("SHELL", "/bin/zsh"),
        ("LANG", "en_US.UTF-8"),
        ("TERM", "xterm"),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_string(), value.to_string()))
    .collect();
    host.push(("HOME".into(), f.owner_home.display().to_string()));
    host.push(("TMPDIR".into(), std::env::temp_dir().display().to_string()));
    for (key, value) in PLANTED {
        host.push((key.into(), value.into()));
    }
    let entry = ToolEntry {
        adapter: AdapterKind::Codex,
        executable: PathBuf::from("/unused/codex-acp"),
        args: Vec::new(),
    };
    let mut env = policy::launch_spec(&entry, &f.repo, host, &f.codex).env;
    env.push(("ZZ_LEAKED_TOKEN".into(), "zz-fake-leaked-2630".into()));
    env
}

fn parse_env(output: &str) -> BTreeMap<String, String> {
    output
        .lines()
        .filter_map(|line| line.split_once('='))
        .filter(|(name, _)| {
            !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        })
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect()
}

/// No planted name in what a command saw.
fn assert_clean(vars: &BTreeMap<String, String>, path: &str) {
    let leaked: Vec<&String> = vars
        .keys()
        .filter(|name| name.starts_with("ZZ_") || name.starts_with("MOMO_"))
        .collect();
    assert!(
        leaked.is_empty(),
        "{path}: a planted credential reached a Codex command: {leaked:?}"
    );
}

/// `codex app-server` over stdio JSON-RPC, as codex-acp drives it.
struct AppServer {
    child: Child,
    stdin: ChildStdin,
    lines: mpsc::Receiver<String>,
    /// Messages read while waiting for another one.
    unread: Vec<Value>,
    next_id: i64,
}

impl AppServer {
    fn start(env: &[(String, String)], cwd: &Path) -> Self {
        let mut child = Command::new(codex_bin())
            .arg("app-server")
            .env_clear()
            .envs(env.iter().map(|(key, value)| (key, value)))
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("start codex app-server");
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (sender, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if sender.send(line).is_err() {
                    break;
                }
            }
        });
        let mut server = Self {
            child,
            stdin,
            lines,
            unread: Vec::new(),
            next_id: 1,
        };
        server.request(
            "initialize",
            json!({"clientInfo": {"name": "momo-workd-2630", "title": "measure", "version": "0"}}),
        );
        server.send(json!({"jsonrpc": "2.0", "method": "initialized"}));
        server
    }

    fn send(&mut self, message: Value) {
        writeln!(self.stdin, "{message}").unwrap();
        self.stdin.flush().unwrap();
    }

    fn wait_for(&mut self, what: &str, matches: impl Fn(&Value) -> bool) -> Value {
        if let Some(index) = self.unread.iter().position(&matches) {
            return self.unread.remove(index);
        }
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let line = self
                .lines
                .recv_timeout(left)
                .unwrap_or_else(|_| panic!("codex app-server: no {what}"));
            if let Ok(message) = serde_json::from_str::<Value>(&line) {
                if matches(&message) {
                    return message;
                }
                self.unread.push(message);
            }
        }
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        let answer = self.wait_for(method, |message| message["id"] == json!(id));
        answer
            .get("result")
            .cloned()
            .unwrap_or_else(|| panic!("{method} failed: {answer}"))
    }

    /// A thread whose model provider is a closed local port: nothing can
    /// leave this machine, and no turn is ever started.
    fn start_thread(&mut self, cwd: &Path, config: Value) -> String {
        let mut overrides = json!({
            "model_providers": {"zzlocal": {
                "name": "dead end (#2630 measurement)",
                "base_url": "http://127.0.0.1:9/v1",
                "wire_api": "responses",
            }},
        });
        if let (Some(target), Some(extra)) = (overrides.as_object_mut(), config.as_object()) {
            target.extend(extra.clone());
        }
        let started = self.request(
            "thread/start",
            json!({
                "cwd": cwd.display().to_string(),
                "sandbox": "workspace-write",
                "approvalPolicy": "on-request",
                "ephemeral": true,
                "modelProvider": "zzlocal",
                "model": "zz-none",
                "config": overrides,
            }),
        );
        started["thread"]["id"].as_str().unwrap().to_string()
    }

    /// `thread/shellCommand`: the thread's shell, its environment builder and
    /// its snapshot wrapper (unsandboxed by protocol; what matters here is
    /// the environment a command is given).
    fn shell(&mut self, thread: &str, command: &str) -> String {
        self.request(
            "thread/shellCommand",
            json!({"threadId": thread, "command": command, "timeoutMs": 20_000}),
        );
        let done = self.wait_for("completed command", |message| {
            message["method"] == "item/completed"
                && message["params"]["item"]["type"] == "commandExecution"
        });
        done["params"]["item"]["aggregatedOutput"]
            .as_str()
            .unwrap_or_default()
            .to_string()
    }

    fn skills(&mut self, cwd: &Path) -> Vec<(String, String)> {
        let listed = self.request(
            "skills/list",
            json!({"cwds": [cwd.display().to_string()], "forceReload": true}),
        );
        listed["data"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|entry| entry["skills"].as_array().cloned().unwrap_or_default())
            .map(|skill| {
                (
                    skill["name"].as_str().unwrap_or_default().to_string(),
                    skill["path"].as_str().unwrap_or_default().to_string(),
                )
            })
            .collect()
    }
}

impl Drop for AppServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// How long `codex app-server` takes to build a thread's shell snapshot
/// (a login shell that sources the owner's `.zshrc`), with margin: measured
/// at well under a second, and a command started before it is ready runs
/// without it.
const SNAPSHOT_SETTLE: Duration = Duration::from_secs(6);

#[test]
#[ignore = "needs MOMO_WORKD_CODEX_BIN (codex-cli 0.155.1)"]
fn a_codex_command_sees_no_credential_from_the_host_or_the_owners_shell_files() {
    let f = fixture();
    let env = codex_process_env(&f);

    // 1. The seatbelt path: `codex sandbox` gives a command the environment
    //    the exec tools give it (`create_env` with the configured policy,
    //    codex-rs/cli/src/debug_sandbox.rs:260), inside the same sandbox.
    let sandboxed = |extra: &[&str]| -> BTreeMap<String, String> {
        let output = Command::new(codex_bin())
            .arg("sandbox")
            .args(["-c", "sandbox_mode=\"workspace-write\""])
            .args(extra)
            .args(["--", "/usr/bin/env"])
            .env_clear()
            .envs(env.iter().map(|(key, value)| (key, value)))
            .current_dir(&f.repo)
            .output()
            .expect("codex sandbox");
        assert!(output.status.success(), "codex sandbox: {output:?}");
        parse_env(&String::from_utf8_lossy(&output.stdout))
    };
    let vars = sandboxed(&[]);
    eprintln!("codex sandbox: {:?}", vars.keys().collect::<Vec<_>>());
    assert_eq!(
        vars.get("CODEX_SANDBOX").map(String::as_str),
        Some("seatbelt")
    );
    assert_clean(&vars, "codex sandbox");
    assert_eq!(
        vars.get("TMPDIR").map(PathBuf::from),
        Some(f.codex.tmp.clone()),
        "the host's temp folder, still the command's TMPDIR"
    );
    assert!(
        vars.get("PATH")
            .is_some_and(|path| path.contains("/usr/bin")),
        "PATH kept: {:?}",
        vars.get("PATH")
    );
    assert_eq!(
        vars.get("HOME").map(PathBuf::from),
        Some(f.owner_home.clone()),
        "a command keeps the owner's HOME: its tools (rustup, git) live there"
    );
    // The probe can fail: the same run with codex's own default policy
    // (inherit everything, no default excludes) shows the credential that
    // is in Codex's environment.
    let inherited = sandboxed(&[
        "-c",
        "shell_environment_policy.inherit=\"all\"",
        "-c",
        "shell_environment_policy.ignore_default_excludes=true",
    ]);
    assert!(
        inherited.contains_key("ZZ_LEAKED_TOKEN"),
        "control: codex's default policy passes Codex's own environment on"
    );

    // 2. The thread exec path, after the shell snapshot would have been
    //    taken: codex wraps every command in `. <snapshot>` (codex-rs
    //    core/src/tools/runtimes/mod.rs `maybe_wrap_shell_lc_with_snapshot`),
    //    and the snapshot re-exports whatever the login shell that took it
    //    had — Codex's whole environment and the owner's startup files.
    let mut server = AppServer::start(&env, &f.repo);
    let thread = server.start_thread(&f.repo, json!({}));
    std::thread::sleep(SNAPSHOT_SETTLE);
    let vars = parse_env(&server.shell(&thread, "/usr/bin/env"));
    eprintln!("thread/shellCommand: {:?}", vars.keys().collect::<Vec<_>>());
    assert_clean(&vars, "thread/shellCommand");
    assert_eq!(
        vars.get("TMPDIR").map(PathBuf::from),
        Some(f.codex.tmp.clone())
    );
    assert_eq!(
        vars.get("HOME").map(PathBuf::from),
        Some(f.owner_home.clone())
    );
    // The probe can fail here too: with the snapshot switched back on for
    // one thread, the credential in Codex's environment comes back.
    let control = server.start_thread(&f.repo, json!({"features": {"shell_snapshot": true}}));
    std::thread::sleep(SNAPSHOT_SETTLE);
    let vars = parse_env(&server.shell(&control, "/usr/bin/env"));
    assert!(
        vars.contains_key("ZZ_LEAKED_TOKEN"),
        "control: the shell snapshot re-exports Codex's environment: {:?}",
        vars.keys().collect::<Vec<_>>()
    );
}

#[test]
#[ignore = "needs MOMO_WORKD_CODEX_BIN (codex-cli 0.155.1)"]
fn codex_loads_no_skill_from_the_owners_home() {
    let f = fixture();
    let env = codex_process_env(&f);
    let mut server = AppServer::start(&env, &f.repo);
    let skills = server.skills(&f.repo);
    eprintln!("skills/list: {skills:?}");
    assert!(
        !skills
            .iter()
            .any(|(name, path)| name == "zz-owner-skill"
                || Path::new(path).starts_with(&f.owner_home)),
        "an owner-layer skill was loaded: {skills:?}"
    );
    drop(server);
    // The probe can fail: the same codex, given the owner's HOME, loads the
    // owner's `~/.agents/skills` (codex ext/skills/src/host_roots.rs).
    let owners: Vec<(String, String)> = env
        .iter()
        .map(|(key, value)| {
            if key == "HOME" {
                (key.clone(), f.owner_home.display().to_string())
            } else {
                (key.clone(), value.clone())
            }
        })
        .collect();
    let mut server = AppServer::start(&owners, &f.repo);
    assert!(
        server
            .skills(&f.repo)
            .iter()
            .any(|(name, _)| name == "zz-owner-skill"),
        "control: with the owner's HOME the owner layer is loaded"
    );
}
