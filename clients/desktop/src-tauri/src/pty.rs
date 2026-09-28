// Local terminal lane (ADR-0190 D1·D2, #2772): the desktop app process opens
// the PTY, the app webview draws it. Five commands plus two channels:
//
//   pty_spawn   { program, cwd?, cols, rows } + onOutput + onExit -> id
//   pty_write   raw bytes (invoke body) + header `x-oort-pty-id`
//   pty_resize  { id, cols, rows }
//   pty_kill    { id }
//   pty_ack     { id, bytes }   output flow control (see `OUTPUT_HIGH_WATER`)
//
// Tauri runs a sync command on the thread that received the IPC request —
// on macOS the main (event loop) thread — and an async one on a worker pool,
// one task per call. So: everything that can block (openpty/fork) is async
// and never on the main thread (#2824 review H1); `pty_write`
// is sync, because input order is the order calls run in and only the main
// thread runs them in arrival order (#2824 R2) — it only enqueues.
//
// The boundary, in the order a request meets it:
//
// 1. **Who may call.** The build declares an app ACL manifest (`build.rs`), so
//    every app command is refused unless a capability grants it. The pty
//    grants live only in `capabilities/pty.json`: the `main` window, local
//    (bundled) origin, no `remote` URLs. A page the webview loaded from the
//    network, or an iframe on another origin, is refused by Tauri before any
//    code here runs. `shell_contract.rs` asks Tauri's resolver.
// 2. **What may run.** The webview names a program kind, never a path or an
//    argv: `shell` is the user's login shell (`$SHELL`, which must be listed
//    in /etc/shells) with `-l`; `harness` is one id from `HARNESSES`, resolved
//    to an absolute path HERE with `harness_path` (inherited PATH + fixed
//    install folders; no login shell is run to ask for its PATH, #2813). No extra arguments pass
//    through — in particular no permission-bypass flag (ADR-0190 D2).
//    `login` is one row of `LOGIN_COMMANDS` (ADR-0190 D3-f, #2816): the
//    official CLI's own sign-in command with its arguments fixed here. The
//    page names a harness and a method, never an argument.
// 3. **Where.** `cwd` must canonicalize to a directory inside the user's home.
//    Validation happens before the command builder sees the path: portable-pty
//    silently falls back to $HOME for a cwd that is not a directory.
// 4. **With which environment.** The app's environment minus the account
//    variables ADR-0191 D2 names (`STRIPPED_ENV`), so a key the app inherited
//    does not decide which account a harness runs as. A login shell re-reads
//    the user's rc files, so what the user exports there still applies.
//
// Nothing else in the shell reaches this module: no event listener, no deep
// link, no discovery result and nothing from the server opens, writes or
// resizes a PTY. The one outside caller is `lib.rs`: the command table, and
// ending every session on app exit and when the main page (re)loads.
// `shell_contract.rs` pins that by source (ADR-0190 D1).
// Raw output stays on this machine; it is never sent to the server (D2).

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::Duration;

use crate::harness_path;
use crate::harness_profile;
use crate::pane_signal::{self, PaneSignal};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};

/// Harness CLIs a pane may start by id (ADR-0190 D3: the local PATH is the
/// source of truth, this list only bounds what may be asked for).
pub const HARNESSES: &[&str] = &["claude", "codex", "grok"];

/// Variables removed from every PTY's environment: the shared list in
/// `harness_path`, which the login-status probe (#2813) strips too.
pub use crate::harness_path::STRIPPED_ENV;

pub const MAX_SESSIONS: usize = 32;
pub const MAX_COLS: u16 = 1000;
pub const MAX_ROWS: u16 = 500;
/// One `pty_write` body. xterm sends keystrokes and pastes; a paste larger
/// than this is split by the web layer.
pub const MAX_WRITE_BYTES: usize = 1 << 20;
pub const ID_HEADER: &str = "x-oort-pty-id";
/// Keystrokes waiting for the child. A write that would push the queue past
/// this is refused whole ("busy") and nothing of it is sent: the web layer
/// retries or tells the user the terminal is not reading.
pub const MAX_QUEUED_WRITE_BYTES: usize = 4 << 20;
/// Output sent to the webview and not yet acknowledged with `pty_ack`. At
/// this mark the reader stops reading the PTY, so the kernel buffer fills and
/// the child blocks on its own writes — memory stays bounded however fast the
/// child prints.
pub const OUTPUT_HIGH_WATER: usize = 1 << 20;

const FALLBACK_LANG: &str = "en_US.UTF-8";
const READ_CHUNK: usize = 16 * 1024;
/// SIGHUP first, then SIGKILL for whatever is left of the process group.
const KILL_GRACE: Duration = Duration::from_millis(500);
/// After the child exits, how long to wait for the reader to drain before
/// reporting the exit anyway (a background job can hold the tty open).
const DRAIN_GRACE: Duration = Duration::from_secs(1);

// ---------------------------------------------------------------------------
// Request and validation (pure; the tests drive these directly)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Program {
    /// The user's login shell.
    Shell,
    /// One of `HARNESSES`, resolved on this machine. `profile` is a label
    /// (#3010, ADR-0191 D1): the account the person chose for new terminal
    /// sessions. The shell turns it into the profile folder exactly as for a
    /// sign-in (`harness_profile::existing_profile`). Absent = the CLI's own
    /// default location on this Mac.
    Harness {
        id: String,
        #[serde(default)]
        profile: Option<String>,
    },
    /// The official CLI's sign-in command: one row of `LOGIN_COMMANDS`.
    /// `profile` is a label (#2878): the shell turns it into the profile
    /// folder (`harness_profile::existing_profile`). Absent = the CLI's own
    /// default location on this Mac.
    Login {
        id: String,
        method: LoginMethod,
        #[serde(default)]
        profile: Option<String>,
    },
    /// The official CLI's sign-out: one row of `harness_profile::LOGOUT_COMMANDS`
    /// (ADR-0190 D3-f A2·A5). Always a profile folder — there is no sign-out
    /// of this Mac's default sign-in here.
    Logout { id: String, profile: String },
}

/// How the CLI finishes its sign-in. `Browser` = the CLI opens the system
/// browser and waits for its own localhost callback; `Device` = a device code
/// the person types on the provider's page (Codex only).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LoginMethod {
    Browser,
    Device,
}

/// One allowlisted sign-in: harness id, method, fixed arguments.
#[derive(Debug, PartialEq, Eq)]
pub struct LoginCommand {
    pub id: &'static str,
    pub method: LoginMethod,
    pub args: &'static [&'static str],
}

/// The complete sign-in allowlist (ADR-0190 D3-f rows A1, A3, A4; checked
/// against `claude` 2.1.280 and `codex-cli` 0.156.1 `--help`). The program is
/// the id itself, resolved like any harness. No API-billing, SSO, e-mail,
/// key or token variant, and no config override: a login that takes a key or
/// token on stdin is not on this path. The CLI opens the browser, receives
/// the callback and keeps what it receives in its own store; this process
/// only moves the terminal's bytes to the page and never looks at them.
pub const LOGIN_COMMANDS: &[LoginCommand] = &[
    LoginCommand {
        id: "claude",
        method: LoginMethod::Browser,
        args: &["auth", "login", "--claudeai"],
    },
    LoginCommand {
        id: "codex",
        method: LoginMethod::Browser,
        args: &["login"],
    },
    LoginCommand {
        id: "codex",
        method: LoginMethod::Device,
        args: &["login", "--device-auth"],
    },
];

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpawnRequest {
    pub program: Program,
    /// Absolute folder inside the user's home. Absent = home.
    #[serde(default)]
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

/// What this machine looks like to the validator. Built once from the real
/// process in `HostFacts::current`, by hand in tests.
#[derive(Debug, Clone)]
pub struct HostFacts {
    /// Canonical home directory: the only allowed folder root.
    pub home: PathBuf,
    /// `$SHELL` as the app inherited it.
    pub shell: Option<PathBuf>,
    /// Lines of /etc/shells.
    pub allowed_shells: Vec<PathBuf>,
    /// The PATH a harness runs with (`harness_path::search_path`).
    pub path: OsString,
}

/// A validated spawn: an absolute program, its fixed argv, a checked folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnPlan {
    pub program: PathBuf,
    pub args: Vec<&'static str>,
    pub cwd: PathBuf,
    pub size: (u16, u16),
    /// PATH to set for the child; `None` keeps the inherited one (a login
    /// shell rebuilds its own).
    pub path: Option<OsString>,
    /// Wire the harness's status hooks to this pane (#2776): the three
    /// `OORT_PANE_*` variables and `pane_signal::harness_hook_args`. Harness
    /// panes only; a shell or a sign-in has nothing to report.
    pub hooks: bool,
    /// A profile folder's variable (#2878): `CLAUDE_CONFIG_DIR` or
    /// `CODEX_HOME` → the folder `harness_profile` decided and checked.
    pub profile: Option<(&'static str, PathBuf)>,
}

pub fn plan_spawn(request: &SpawnRequest, host: &HostFacts) -> Result<SpawnPlan, String> {
    let size = check_size(request.cols, request.rows)?;
    let cwd = check_cwd(request.cwd.as_deref(), &host.home)?;
    match &request.program {
        Program::Shell => {
            let shell = check_shell(host)?;
            Ok(SpawnPlan {
                program: shell,
                args: vec!["-l"],
                cwd,
                size,
                path: None,
                hooks: false,
                profile: None,
            })
        }
        Program::Login {
            id,
            method,
            profile,
        } => {
            if request.cwd.is_some() {
                return Err("refused: a sign-in runs in the home folder".into());
            }
            let row = LOGIN_COMMANDS
                .iter()
                .find(|row| row.id == id.as_str() && row.method == *method)
                .ok_or_else(|| format!("refused: no {method:?} sign-in for {id:?}"))?;
            let profile = match profile {
                Some(label) => Some(profile_env(host, row.id, label)?),
                None => None,
            };
            let program = harness_path::find_on_path(row.id, &host.path)
                .ok_or_else(|| format!("refused: {id} is not installed on this machine"))?;
            Ok(SpawnPlan {
                program,
                args: row.args.to_vec(),
                cwd,
                size,
                path: Some(host.path.clone()),
                hooks: false,
                profile,
            })
        }
        Program::Logout { id, profile } => {
            if request.cwd.is_some() {
                return Err("refused: a sign-out runs in the home folder".into());
            }
            let row = harness_profile::LOGOUT_COMMANDS
                .iter()
                .find(|row| row.id == id.as_str())
                .ok_or_else(|| format!("refused: no sign-out for {id:?}"))?;
            let profile = profile_env(host, row.id, profile)?;
            let program = harness_path::find_on_path(row.id, &host.path)
                .ok_or_else(|| format!("refused: {id} is not installed on this machine"))?;
            Ok(SpawnPlan {
                program,
                args: row.args.to_vec(),
                cwd,
                size,
                path: Some(host.path.clone()),
                hooks: false,
                profile: Some(profile),
            })
        }
        Program::Harness { id, profile } => {
            if !HARNESSES.contains(&id.as_str()) {
                return Err(format!("refused: unknown harness {id:?}"));
            }
            // Checked before PATH: a missing or tampered profile folder is
            // refused, never quietly replaced by the default sign-in.
            let profile = match profile {
                Some(label) => Some(profile_env(host, id, label)?),
                None => None,
            };
            let program = harness_path::find_on_path(id, &host.path)
                .ok_or_else(|| format!("refused: {id} is not installed on this machine"))?;
            Ok(SpawnPlan {
                program,
                args: Vec::new(),
                cwd,
                size,
                path: Some(host.path.clone()),
                hooks: true,
                profile,
            })
        }
    }
}

/// A profile label → its checked folder and variable. The folder must exist
/// and pass `harness_profile::check_on_disk` (no symlink, under the root, not
/// a CLI's default folder).
fn profile_env(host: &HostFacts, id: &str, label: &str) -> Result<(&'static str, PathBuf), String> {
    let (dir, env) = harness_profile::existing_profile(&host.home, id, label)?;
    Ok((env, dir))
}

pub fn check_size(cols: u16, rows: u16) -> Result<(u16, u16), String> {
    if !(2..=MAX_COLS).contains(&cols) || !(1..=MAX_ROWS).contains(&rows) {
        return Err(format!("refused: size {cols}x{rows} out of range"));
    }
    Ok((cols, rows))
}

pub fn check_cwd(cwd: Option<&str>, home: &Path) -> Result<PathBuf, String> {
    let Some(raw) = cwd else {
        return Ok(home.to_path_buf());
    };
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err("refused: folder must be an absolute path".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| "refused: folder does not exist".to_string())?;
    if !canonical.is_dir() {
        return Err("refused: folder is not a directory".into());
    }
    if !canonical.starts_with(home) {
        return Err("refused: folder is outside the home directory".into());
    }
    Ok(canonical)
}

pub fn check_shell(host: &HostFacts) -> Result<PathBuf, String> {
    let shell = host
        .shell
        .as_ref()
        .ok_or_else(|| "refused: no login shell ($SHELL unset)".to_string())?;
    if !shell.is_absolute() || !host.allowed_shells.iter().any(|s| s == shell) {
        return Err(format!(
            "refused: {} is not listed in /etc/shells",
            shell.display()
        ));
    }
    Ok(shell.clone())
}

/// The command the PTY runs: the plan's program and argv, the environment
/// policy applied on top of `base` (the app's own environment in production).
pub fn build_command(
    plan: &SpawnPlan,
    base: impl IntoIterator<Item = (OsString, OsString)>,
) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(&plan.program);
    cmd.args(&plan.args);
    cmd.cwd(&plan.cwd);
    // Start from exactly `base`, not from whatever portable-pty captured.
    cmd.env_clear();
    for (key, value) in base {
        cmd.env(key, value);
    }
    for key in STRIPPED_ENV {
        cmd.env_remove(key);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "oort");
    // A Finder-launched app has no locale; without one zsh treats 한글 as
    // raw bytes. Only fill the gap — never override the user's choice.
    if cmd.get_env("LANG").is_none() && cmd.get_env("LC_ALL").is_none() {
        cmd.env("LANG", FALLBACK_LANG);
    }
    if let Some(path) = &plan.path {
        cmd.env("PATH", path);
    }
    if let Some((key, dir)) = &plan.profile {
        cmd.env(key, dir);
    }
    cmd
}

impl HostFacts {
    /// This machine, as `program` needs it. Runs nothing: a harness's PATH
    /// is the shared search path (inherited PATH + install folders, #2813).
    pub fn current(program: &Program) -> Result<Self, String> {
        // The same home `harness_profile` uses, so a profile folder is the
        // same string here and in the status probe.
        let home = harness_profile::current_home()?;
        let shell = std::env::var_os("SHELL").map(PathBuf::from);
        let allowed_shells = std::fs::read_to_string("/etc/shells")
            .unwrap_or_default()
            .lines()
            .map(str::trim)
            .filter(|l| l.starts_with('/'))
            .map(PathBuf::from)
            .collect();
        let mut facts = Self {
            home,
            shell,
            allowed_shells,
            path: OsString::new(),
        };
        if matches!(
            program,
            Program::Harness { .. } | Program::Login { .. } | Program::Logout { .. }
        ) {
            facts.path =
                harness_path::search_path(Some(&facts.home), std::env::var_os("PATH").as_ref());
        }
        Ok(facts)
    }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyExit {
    pub id: u32,
    /// `None` when the process was ended by a signal.
    pub code: Option<u32>,
    pub signal: Option<String>,
}

/// Where a session's bytes and its exit go. The Tauri channels in production,
/// an in-memory recorder in tests.
pub trait PtySink: Send + Sync + 'static {
    fn output(&self, bytes: Vec<u8>);
    fn exit(&self, exit: PtyExit);
    /// A harness hook's status signal for this session (#2776,
    /// `pane_signal.rs`). Never derived from output.
    fn signal(&self, _signal: PaneSignal) {}
}

/// Output credit: bytes handed to the sink and not yet acknowledged.
#[derive(Default)]
struct Flow {
    unacked: Mutex<usize>,
    wake: Condvar,
    closed: AtomicBool,
}

impl Flow {
    /// Block the reader (never a command) while the webview is behind.
    fn wait_for_credit(&self) {
        let mut unacked = self.unacked.lock().unwrap();
        while *unacked >= OUTPUT_HIGH_WATER && !self.closed.load(Ordering::Acquire) {
            unacked = self
                .wake
                .wait_timeout(unacked, Duration::from_millis(200))
                .unwrap()
                .0;
        }
    }
    fn sent(&self, n: usize) {
        *self.unacked.lock().unwrap() += n;
    }
    fn ack(&self, n: usize) {
        let mut unacked = self.unacked.lock().unwrap();
        *unacked = unacked.saturating_sub(n);
        self.wake.notify_all();
    }
    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.wake.notify_all();
    }
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    /// Keystrokes go to the session's writer thread; a command only enqueues.
    input: mpsc::Sender<Vec<u8>>,
    queued: Arc<AtomicUsize>,
    flow: Arc<Flow>,
    /// Session leader = session id (portable-pty calls setsid).
    pid: i32,
    /// The checked folder the session started in (`SpawnPlan::cwd`). The
    /// local git reads (ADR-0190 D3-c, #2855) run here and nowhere else: the
    /// webview names a pane, never a folder.
    folder: PathBuf,
    /// Where this session's hook signals go (#2776), and the token a hook
    /// line must carry to reach it. Empty token = no hooks wired.
    sink: Arc<dyn PtySink>,
    token: String,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<u32, Session>>>,
    /// Sessions spawned or being spawned; reserved before spawning so two
    /// concurrent spawns cannot both pass the cap.
    live: Arc<AtomicUsize>,
    next_id: AtomicU32,
    /// The pane-signal socket, once it is listening (#2776). Harness panes
    /// spawned before that (or if binding failed) simply get no hooks.
    hook_socket: std::sync::OnceLock<PathBuf>,
}

impl PtyManager {
    pub fn spawn(
        &self,
        plan: &SpawnPlan,
        cmd: CommandBuilder,
        sink: Arc<dyn PtySink>,
    ) -> Result<u32, String> {
        if self.live.fetch_add(1, Ordering::AcqRel) >= MAX_SESSIONS {
            self.live.fetch_sub(1, Ordering::AcqRel);
            return Err(format!("refused: {MAX_SESSIONS} terminals already open"));
        }
        self.spawn_reserved(plan, cmd, sink).inspect_err(|_| {
            self.live.fetch_sub(1, Ordering::AcqRel);
        })
    }

    fn spawn_reserved(
        &self,
        plan: &SpawnPlan,
        cmd: CommandBuilder,
        sink: Arc<dyn PtySink>,
    ) -> Result<u32, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let mut cmd = cmd;
        let token = match (plan.hooks, self.hook_socket.get()) {
            (true, Some(sock)) => {
                let token = pane_signal::new_token().map_err(|e| format!("token: {e}"))?;
                cmd.env(pane_signal::ENV_SOCK, sock);
                cmd.env(pane_signal::ENV_PANE, id.to_string());
                cmd.env(pane_signal::ENV_TOKEN, &token);
                token
            }
            _ => String::new(),
        };
        let pair = native_pty_system()
            .openpty(pty_size(plan.size))
            .map_err(|e| format!("openpty: {e}"))?;
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn: {e}"))?;
        // Only the child holds the slave now, so the reader sees EOF when the
        // child's session lets go of the terminal.
        drop(pair.slave);
        let pid = child.process_id().map(|p| p as i32).unwrap_or(-1);
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("reader: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("writer: {e}"))?;

        let (input, keystrokes) = mpsc::channel::<Vec<u8>>();
        let queued = Arc::new(AtomicUsize::new(0));
        let flow = Arc::new(Flow::default());

        {
            let queued = queued.clone();
            std::thread::Builder::new()
                .name(format!("pty-{id}-write"))
                .spawn(move || write_loop(writer, keystrokes, queued))
                .map_err(|e| format!("writer thread: {e}"))?;
        }
        let (drained_tx, drained_rx) = mpsc::channel::<()>();
        {
            let (flow, sink) = (flow.clone(), sink.clone());
            std::thread::Builder::new()
                .name(format!("pty-{id}-read"))
                .spawn(move || read_loop(reader, sink, flow, drained_tx))
                .map_err(|e| format!("reader thread: {e}"))?;
        }
        self.sessions.lock().unwrap().insert(
            id,
            Session {
                master: pair.master,
                input,
                queued,
                flow: flow.clone(),
                pid,
                folder: plan.cwd.clone(),
                sink: sink.clone(),
                token,
            },
        );

        let sessions = self.sessions.clone();
        let live = self.live.clone();
        std::thread::Builder::new()
            .name(format!("pty-{id}-wait"))
            .spawn(move || {
                let status = child.wait();
                // The leader is gone; whatever it left in its session (a
                // job that ignores SIGHUP, a disowned background job) goes
                // too, or it would keep the terminal — and the reader — open
                // with no session left to reach it.
                end_session(pid);
                flow.close();
                let _ = drained_rx.recv_timeout(DRAIN_GRACE);
                sessions.lock().unwrap().remove(&id);
                live.fetch_sub(1, Ordering::AcqRel);
                let (code, signal) = match status {
                    Ok(s) => match s.signal() {
                        Some(sig) => (None, Some(sig.to_string())),
                        None => (Some(s.exit_code()), None),
                    },
                    Err(_) => (None, None),
                };
                sink.exit(PtyExit { id, code, signal });
            })
            .map_err(|e| format!("waiter thread: {e}"))?;
        Ok(id)
    }

    /// Queue keystrokes for the child. Never blocks: a child that is not
    /// reading fills the queue and further writes are refused whole.
    pub fn write(&self, id: u32, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() > MAX_WRITE_BYTES {
            return Err("refused: write too large".into());
        }
        let (input, queued) = self
            .sessions
            .lock()
            .unwrap()
            .get(&id)
            .map(|s| (s.input.clone(), s.queued.clone()))
            .ok_or_else(|| unknown(id))?;
        let before = queued.fetch_add(bytes.len(), Ordering::AcqRel);
        if before + bytes.len() > MAX_QUEUED_WRITE_BYTES {
            queued.fetch_sub(bytes.len(), Ordering::AcqRel);
            return Err("busy: the terminal is not reading its input".into());
        }
        input.send(bytes.to_vec()).map_err(|_| {
            queued.fetch_sub(bytes.len(), Ordering::AcqRel);
            unknown(id)
        })
    }

    /// The folder session `id` started in, if it is still open. Read-only:
    /// the only thing `git_read.rs` may ask of a session (#2855).
    pub fn folder_of(&self, id: u32) -> Option<PathBuf> {
        self.sessions
            .lock()
            .ok()?
            .get(&id)
            .map(|s| s.folder.clone())
    }

    /// Start handing harness panes the hook environment (#2776).
    pub fn set_hook_socket(&self, path: PathBuf) {
        let _ = self.hook_socket.set(path);
    }

    pub fn hook_socket(&self) -> Option<&Path> {
        self.hook_socket.get().map(PathBuf::as_path)
    }

    /// A hook line reached the socket: hand its signal to session `id` if the
    /// token is the one that session was spawned with. Anything else is
    /// dropped without a word — the hook client exits 0 either way.
    pub fn deliver_signal(&self, id: u32, token: &str, signal: PaneSignal) -> bool {
        let sink = {
            let sessions = self.sessions.lock().unwrap();
            match sessions.get(&id) {
                Some(s) if !s.token.is_empty() && tokens_match(&s.token, token) => s.sink.clone(),
                _ => return false,
            }
        };
        sink.signal(signal);
        true
    }

    /// The webview drew `bytes` more of this session's output.
    pub fn ack(&self, id: u32, bytes: usize) -> Result<(), String> {
        let flow = self
            .sessions
            .lock()
            .unwrap()
            .get(&id)
            .map(|s| s.flow.clone())
            .ok_or_else(|| unknown(id))?;
        flow.ack(bytes);
        Ok(())
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        let size = check_size(cols, rows)?;
        let sessions = self.sessions.lock().unwrap();
        let session = sessions.get(&id).ok_or_else(|| unknown(id))?;
        session
            .master
            .resize(pty_size(size))
            .map_err(|e| format!("resize: {e}"))
    }

    /// Hang up every process in the session — the shell and each job's
    /// process group — then SIGKILL what ignored that. The exit arrives on
    /// the session's exit channel.
    pub fn kill(&self, id: u32) -> Result<(), String> {
        let pid = self
            .sessions
            .lock()
            .unwrap()
            .get(&id)
            .map(|s| s.pid)
            .ok_or_else(|| unknown(id))?;
        signal_session(pid, SIG_HUP);
        std::thread::spawn(move || {
            std::thread::sleep(KILL_GRACE);
            // Re-enumerated by session id: a pid reused since is not in it.
            signal_session(pid, SIG_KILL);
        });
        Ok(())
    }

    /// App exit and page reload: every session goes, synchronously.
    pub fn kill_all(&self) {
        let pids: Vec<i32> = self
            .sessions
            .lock()
            .map(|s| s.values().map(|s| s.pid).collect())
            .unwrap_or_default();
        if pids.is_empty() {
            return;
        }
        pids.iter().for_each(|&pid| signal_session(pid, SIG_HUP));
        std::thread::sleep(Duration::from_millis(150));
        pids.iter().for_each(|&pid| signal_session(pid, SIG_KILL));
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.sessions.lock().map(|s| s.len()).unwrap_or(0)
    }
}

impl Drop for PtyManager {
    fn drop(&mut self) {
        self.kill_all();
    }
}

fn write_loop(
    mut writer: Box<dyn Write + Send>,
    keystrokes: mpsc::Receiver<Vec<u8>>,
    queued: Arc<AtomicUsize>,
) {
    let mut broken = false;
    // Ends when the session (the only sender) is dropped.
    for chunk in keystrokes {
        if !broken {
            broken = writer
                .write_all(&chunk)
                .and_then(|_| writer.flush())
                .is_err();
        }
        queued.fetch_sub(chunk.len(), Ordering::AcqRel);
    }
}

fn read_loop(
    mut reader: Box<dyn Read + Send>,
    sink: Arc<dyn PtySink>,
    flow: Arc<Flow>,
    drained: mpsc::Sender<()>,
) {
    let mut buf = vec![0u8; READ_CHUNK];
    loop {
        flow.wait_for_credit();
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                flow.sent(n);
                sink.output(buf[..n].to_vec());
            }
        }
    }
    let _ = drained.send(());
}

/// Compare without stopping at the first different byte.
fn tokens_match(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

fn pty_size((cols, rows): (u16, u16)) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn unknown(id: u32) -> String {
    format!("no terminal {id}")
}

#[cfg(unix)]
const SIG_HUP: i32 = libc::SIGHUP;
#[cfg(unix)]
const SIG_KILL: i32 = libc::SIGKILL;
#[cfg(not(unix))]
const SIG_HUP: i32 = 1;
#[cfg(not(unix))]
const SIG_KILL: i32 = 9;

/// The leader's exit: hang up what is left of its session, SIGKILL the rest.
fn end_session(sid: i32) {
    if session_members(sid).is_empty() {
        return;
    }
    signal_session(sid, SIG_HUP);
    let deadline = std::time::Instant::now() + KILL_GRACE;
    while std::time::Instant::now() < deadline && !session_members(sid).is_empty() {
        std::thread::sleep(Duration::from_millis(25));
    }
    signal_session(sid, SIG_KILL);
}

/// Signal every process whose session id is `sid`. An interactive login shell
/// runs each job in its own process group (job control), so signalling only
/// the leader's group would miss them (#2824 review M1).
#[cfg(unix)]
fn signal_session(sid: i32, signal: i32) {
    if sid <= 0 {
        return;
    }
    // Twice: a member may fork between the listing and the signal. Only
    // members are signalled — never a bare group id, which may have been
    // reused once the session is gone (#2824 review L2).
    for _ in 0..2 {
        for pid in session_members(sid) {
            unsafe {
                libc::kill(pid, signal);
            }
        }
    }
}

/// Live pids in session `sid`.
#[cfg(target_os = "macos")]
fn session_members(sid: i32) -> Vec<i32> {
    if sid <= 0 {
        return Vec::new();
    }
    let mut pids = vec![0i32; 8192];
    let bytes = (pids.len() * std::mem::size_of::<i32>()) as libc::c_int;
    let n = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
    if n <= 0 {
        return vec![sid];
    }
    pids.truncate(n as usize);
    pids.into_iter()
        .filter(|&pid| pid > 0 && unsafe { libc::getsid(pid) } == sid)
        .collect()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn session_members(sid: i32) -> Vec<i32> {
    if sid <= 0 {
        return Vec::new();
    }
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return vec![sid];
    };
    dir.filter_map(|e| e.ok()?.file_name().to_str()?.parse::<i32>().ok())
        .filter(|&pid| unsafe { libc::getsid(pid) } == sid)
        .collect()
}

// The terminal lane ships on macOS (ADR-0190 D1). Elsewhere the commands
// exist but a session cannot be signalled by id; dropping the master still
// hangs the console up.
#[cfg(not(unix))]
fn signal_session(_sid: i32, _signal: i32) {}
#[cfg(not(unix))]
fn session_members(_sid: i32) -> Vec<i32> {
    Vec::new()
}

// ---------------------------------------------------------------------------
// Tauri commands — all async, see the module header
// ---------------------------------------------------------------------------

use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::State;

#[derive(Default)]
pub struct PtyState(pub Arc<PtyManager>);

struct ChannelSink {
    output: Channel<InvokeResponseBody>,
    exit: Channel<PtyExit>,
    signal: Channel<PaneSignal>,
}

impl PtySink for ChannelSink {
    fn output(&self, bytes: Vec<u8>) {
        // Bounded by `OUTPUT_HIGH_WATER`: the reader stops until the page
        // acknowledges, so Tauri's channel queue cannot grow without limit.
        let _ = self.output.send(InvokeResponseBody::Raw(bytes));
    }
    fn exit(&self, exit: PtyExit) {
        let _ = self.exit.send(exit);
    }
    fn signal(&self, signal: PaneSignal) {
        let _ = self.signal.send(signal);
    }
}

/// Open one PTY. Output arrives on `on_output` as raw bytes (`ArrayBuffer`)
/// and must be acknowledged with `pty_ack`; the exit arrives once on
/// `on_exit`.
#[tauri::command]
pub async fn pty_spawn(
    state: State<'_, PtyState>,
    request: SpawnRequest,
    on_output: Channel<InvokeResponseBody>,
    on_exit: Channel<PtyExit>,
    on_signal: Channel<PaneSignal>,
) -> Result<u32, String> {
    let manager = state.0.clone();
    // openpty/fork block; keep them off the async workers as well as off the
    // main thread.
    tauri::async_runtime::spawn_blocking(move || {
        let host = HostFacts::current(&request.program)?;
        let plan = plan_spawn(&request, &host)?;
        let mut cmd = build_command(&plan, std::env::vars_os());
        // The hook wiring is the only argv a harness gets, and it is fixed
        // here: this binary's own path and a closed event list (#2776).
        if let (Program::Harness { id, .. }, true) = (&request.program, plan.hooks) {
            if manager.hook_socket().is_some() {
                if let Some(args) = std::env::current_exe()
                    .ok()
                    .and_then(|exe| pane_signal::harness_hook_args(id, &exe))
                {
                    cmd.args(&args);
                }
            }
        }
        let sink = Arc::new(ChannelSink {
            output: on_output,
            exit: on_exit,
            signal: on_signal,
        });
        manager.spawn(&plan, cmd, sink)
    })
    .await
    .map_err(|e| format!("spawn did not run: {e}"))?
}

/// Keystrokes and pastes: raw bytes in the invoke body, the session id in
/// `x-oort-pty-id`. Raw bodies need the `ipc:` transport the CSP keeps open.
/// Queued, never written inline; `busy` when the child is not reading.
///
/// **Deliberately sync** (#2824 R2): an async command is spawned per call on
/// a multi-thread runtime, so two keystrokes can be enqueued in the wrong
/// order — measured 1,2xx adjacent swaps and a lost tail in 3,000 unawaited
/// writes. Sync commands run in IPC arrival order on the main thread, which
/// is safe here because `PtyManager::write` only enqueues (a short map lock,
/// one copy of at most 1 MiB, a channel send) and never touches the PTY.
#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("refused: expected raw bytes".to_string());
    };
    let id = request
        .headers()
        .get(ID_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u32>().ok())
        .ok_or_else(|| format!("refused: missing {ID_HEADER}"))?;
    state.0.write(id, bytes)
}

#[tauri::command]
pub async fn pty_resize(
    state: State<'_, PtyState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.0.resize(id, cols, rows)
}

#[tauri::command]
pub async fn pty_kill(state: State<'_, PtyState>, id: u32) -> Result<(), String> {
    state.0.kill(id)
}

/// The page drew `bytes` more of session `id`'s output.
#[tauri::command]
pub async fn pty_ack(state: State<'_, PtyState>, id: u32, bytes: u32) -> Result<(), String> {
    state.0.ack(id, bytes as usize)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn home() -> PathBuf {
        PathBuf::from(std::env::var_os("HOME").unwrap())
            .canonicalize()
            .unwrap()
    }

    fn host(path: OsString) -> HostFacts {
        HostFacts {
            home: home(),
            shell: Some("/bin/zsh".into()),
            allowed_shells: vec!["/bin/sh".into(), "/bin/zsh".into()],
            path,
        }
    }

    fn shell_request(cwd: Option<&str>) -> SpawnRequest {
        SpawnRequest {
            program: Program::Shell,
            cwd: cwd.map(str::to_string),
            cols: 80,
            rows: 24,
        }
    }

    fn harness_request(id: &str) -> SpawnRequest {
        SpawnRequest {
            program: Program::Harness {
                id: id.into(),
                profile: None,
            },
            cwd: None,
            cols: 80,
            rows: 24,
        }
    }

    /// A folder on PATH holding a fake `claude` and a fake `sh-like` binary.
    fn fake_bin() -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("oort-pty-bin-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["claude", "bash-evil"] {
            let file = dir.join(name);
            std::fs::write(&file, "#!/bin/sh\necho fake\n").unwrap();
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        dir
    }

    // --- the request shape -------------------------------------------------

    #[test]
    fn the_request_carries_no_path_and_no_argv() {
        let ok: SpawnRequest = serde_json::from_str(
            r#"{"program":{"kind":"harness","id":"claude"},"cols":80,"rows":24}"#,
        )
        .unwrap();
        assert_eq!(
            ok.program,
            Program::Harness {
                id: "claude".into(),
                profile: None,
            }
        );
        for extra in [
            r#"{"program":{"kind":"shell"},"cols":80,"rows":24,"args":["-c","id"]}"#,
            r#"{"program":{"kind":"shell"},"cols":80,"rows":24,"env":{"A":"1"}}"#,
            r#"{"program":{"kind":"harness","id":"claude","args":["--dangerously-skip-permissions"]},"cols":80,"rows":24}"#,
            r#"{"program":{"kind":"harness","id":"claude","path":"/bin/sh"},"cols":80,"rows":24}"#,
            r#"{"program":{"kind":"exec","path":"/bin/sh"},"cols":80,"rows":24}"#,
        ] {
            assert!(
                serde_json::from_str::<SpawnRequest>(extra).is_err(),
                "accepted {extra}"
            );
        }
    }

    // --- program -----------------------------------------------------------

    #[test]
    fn a_harness_is_one_allowlisted_id_resolved_here() {
        let bin = fake_bin();
        let host = host(bin.clone().into_os_string());
        let plan = plan_spawn(&harness_request("claude"), &host).unwrap();
        assert_eq!(plan.program, bin.join("claude"));
        assert!(plan.args.is_empty(), "no argv passthrough: {:?}", plan.args);
        assert_eq!(plan.path.as_deref(), Some(host.path.as_os_str()));
        // On PATH but not on the list; a path; a traversal; a list entry that
        // is not installed.
        for id in ["bash-evil", "/bin/sh", "../claude", "claude ", "codex"] {
            let err = plan_spawn(&harness_request(id), &host).unwrap_err();
            assert!(err.starts_with("refused"), "{id}: {err}");
        }
    }

    #[test]
    fn the_shell_is_the_login_shell_listed_in_etc_shells() {
        let host = host(OsString::new());
        let plan = plan_spawn(&shell_request(None), &host).unwrap();
        assert_eq!(plan.program, PathBuf::from("/bin/zsh"));
        assert_eq!(plan.args, ["-l"]);
        assert_eq!(plan.cwd, home());

        for shell in [Some("/tmp/zsh"), Some("zsh"), None] {
            let mut h = host.clone();
            h.shell = shell.map(PathBuf::from);
            let err = plan_spawn(&shell_request(None), &h).unwrap_err();
            assert!(err.starts_with("refused"), "{shell:?}: {err}");
        }
    }

    #[test]
    fn a_harness_path_is_the_shared_search_path_and_runs_nothing() {
        // No login-shell probe any more (#2813): building the PATH executes
        // nothing, so a hostile `$SHELL` has nothing to be run by.
        let production = include_str!("pty.rs")
            .split("#[cfg(test)]\nmod tests")
            .next()
            .unwrap();
        for needle in ["std::process::Command", "Command::new(", "\"-c\""] {
            assert!(!production.contains(needle), "pty.rs has {needle}");
        }
        let facts = HostFacts::current(&Program::Harness {
            id: "claude".into(),
            profile: None,
        })
        .unwrap();
        assert_eq!(
            facts.path,
            crate::harness_path::search_path(Some(&facts.home), std::env::var_os("PATH").as_ref())
        );
    }

    // --- folder --------------------------------------------------------------

    #[test]
    fn the_folder_must_be_a_real_directory_inside_home() {
        let host = host(OsString::new());
        let home = home();
        let inside = home.to_string_lossy().into_owned();
        assert_eq!(
            plan_spawn(&shell_request(Some(&inside)), &host)
                .unwrap()
                .cwd,
            home
        );

        let escape = format!("{inside}/..");
        let missing = format!("{inside}/oort-pty-does-not-exist-{}", std::process::id());
        let file = std::env::current_exe().unwrap();
        let file = file.to_string_lossy().into_owned();
        // /tmp is /private/tmp on macOS: outside home after canonicalization.
        for cwd in [
            "relative/dir",
            "/",
            "/tmp",
            "/etc",
            &escape,
            &missing,
            &file,
        ] {
            let err = plan_spawn(&shell_request(Some(cwd)), &host).unwrap_err();
            assert!(err.starts_with("refused"), "{cwd}: {err}");
        }
    }

    #[test]
    fn the_size_is_bounded() {
        let host = host(OsString::new());
        for (cols, rows) in [
            (0, 24),
            (1, 24),
            (80, 0),
            (MAX_COLS + 1, 24),
            (80, MAX_ROWS + 1),
        ] {
            let mut r = shell_request(None);
            r.cols = cols;
            r.rows = rows;
            assert!(plan_spawn(&r, &host).is_err(), "{cols}x{rows}");
        }
        assert!(check_size(MAX_COLS, MAX_ROWS).is_ok());
    }

    // --- environment ---------------------------------------------------------

    fn env_of(cmd: &CommandBuilder) -> HashMap<String, String> {
        cmd.iter_full_env_as_str()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn base(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect()
    }

    #[test]
    fn account_variables_are_removed_and_the_rest_is_kept() {
        let plan = plan_spawn(&shell_request(None), &host(OsString::new())).unwrap();
        let mut pairs = vec![
            ("HOME", "/Users/x"),
            ("EDITOR", "vim"),
            ("LANG", "ko_KR.UTF-8"),
        ];
        pairs.extend(STRIPPED_ENV.iter().map(|k| (*k, "sk-sentinel")));
        let env = env_of(&build_command(&plan, base(&pairs)));
        for key in STRIPPED_ENV {
            assert!(!env.contains_key(*key), "{key} leaked: {env:?}");
        }
        assert!(!env.values().any(|v| v == "sk-sentinel"));
        assert_eq!(env["EDITOR"], "vim");
        assert_eq!(env["LANG"], "ko_KR.UTF-8", "the user's locale wins");
        assert_eq!(env["TERM"], "xterm-256color");
        // ADR-0191 D2's four lead the list; the rest came from the #2824
        // review. A shorter list is a regression.
        assert_eq!(
            STRIPPED_ENV[..4],
            [
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_AUTH_TOKEN",
                "CLAUDE_CODE_OAUTH_TOKEN",
                "OPENAI_API_KEY"
            ]
        );
        for key in [
            "XAI_API_KEY",
            "GROK_API_KEY",
            "CODEX_API_KEY",
            "ANTHROPIC_BASE_URL",
            "CLAUDECODE",
            // #2878 security review H-1: keychain/profile redirects.
            "CLAUDE_SECURESTORAGE_CONFIG_DIR",
            "ANTHROPIC_CONFIG_DIR",
            "ANTHROPIC_PROFILE",
        ] {
            assert!(STRIPPED_ENV.contains(&key), "{key}");
        }
        assert_eq!(STRIPPED_ENV.len(), 22);
    }

    #[test]
    fn a_missing_locale_becomes_utf8_and_a_harness_gets_the_login_path() {
        let bin = fake_bin();
        let host = host(bin.clone().into_os_string());
        let plan = plan_spawn(&harness_request("claude"), &host).unwrap();
        let env = env_of(&build_command(&plan, base(&[("PATH", "/usr/bin")])));
        assert_eq!(env["LANG"], FALLBACK_LANG);
        assert_eq!(env["PATH"], bin.to_string_lossy());

        let env = env_of(&build_command(&plan, base(&[("LC_ALL", "C.UTF-8")])));
        assert!(!env.contains_key("LANG"), "LC_ALL already decides: {env:?}");
    }

    // --- sessions (real PTYs) ------------------------------------------------

    #[derive(Default)]
    struct Recorder {
        bytes: Mutex<Vec<u8>>,
        exit: Mutex<Option<PtyExit>>,
        signals: Mutex<Vec<PaneSignal>>,
    }

    impl PtySink for Recorder {
        fn output(&self, bytes: Vec<u8>) {
            self.bytes.lock().unwrap().extend(bytes);
        }
        fn exit(&self, exit: PtyExit) {
            *self.exit.lock().unwrap() = Some(exit);
        }
        fn signal(&self, signal: PaneSignal) {
            self.signals.lock().unwrap().push(signal);
        }
    }

    impl Recorder {
        fn text(&self) -> String {
            String::from_utf8_lossy(&self.bytes.lock().unwrap()).into_owned()
        }
        fn wait_for(&self, needle: &str, timeout: Duration) {
            let start = Instant::now();
            while !self.text().contains(needle) {
                assert!(
                    start.elapsed() < timeout,
                    "no {needle:?} within {timeout:?}; output: {:?}",
                    self.text()
                );
                std::thread::sleep(Duration::from_millis(25));
            }
        }
        fn wait_exit(&self, timeout: Duration) -> PtyExit {
            let start = Instant::now();
            loop {
                if let Some(exit) = self.exit.lock().unwrap().clone() {
                    return exit;
                }
                assert!(start.elapsed() < timeout, "no exit within {timeout:?}");
                std::thread::sleep(Duration::from_millis(25));
            }
        }
    }

    fn alive(pid: i32) -> bool {
        unsafe { libc::kill(pid, 0) == 0 }
    }

    fn wait_dead(pid: i32, timeout: Duration) {
        let start = Instant::now();
        while alive(pid) {
            assert!(start.elapsed() < timeout, "pid {pid} still alive");
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    const SLOW: Duration = Duration::from_secs(20);

    /// spawn → 한글 echo → resize → kill, through the user's real login shell.
    #[test]
    fn a_login_shell_round_trips_hangul_resizes_and_dies_on_kill() {
        let host = HostFacts::current(&Program::Shell).unwrap();
        let plan = plan_spawn(&shell_request(None), &host).unwrap();
        let cmd = build_command(&plan, std::env::vars_os());
        let manager = PtyManager::default();
        let sink = Arc::new(Recorder::default());
        let id = manager.spawn(&plan, cmd, sink.clone()).unwrap();
        let pid = manager.sessions.lock().unwrap()[&id].pid;
        assert!(alive(pid));

        // The typed line is echoed back, so look for what only the shell's
        // arithmetic can produce.
        manager
            .write(id, "echo 한글-$((40+2))\r".as_bytes())
            .unwrap();
        sink.wait_for("한글-42", SLOW);

        manager.resize(id, 100, 40).unwrap();
        manager.write(id, b"stty size\r").unwrap();
        sink.wait_for("40 100", SLOW);
        assert!(manager.resize(id, 0, 0).is_err());

        manager.kill(id).unwrap();
        let exit = sink.wait_exit(SLOW);
        assert_eq!(exit.id, id);
        assert!(exit.code != Some(0) || exit.signal.is_some(), "{exit:?}");
        wait_dead(pid, SLOW);
        assert_eq!(manager.len(), 0);
        assert!(
            manager.write(id, b"x").is_err(),
            "a dead session takes no input"
        );
    }

    /// The environment policy holds in a real child, not only in the builder.
    #[test]
    fn a_child_does_not_see_the_account_variables() {
        let plan = SpawnPlan {
            program: "/bin/sh".into(),
            args: vec![
                "-c",
                "echo K=${ANTHROPIC_API_KEY:-gone} T=${CLAUDE_CODE_OAUTH_TOKEN:-gone} E=$EDITOR",
            ],
            cwd: home(),
            size: (80, 24),
            path: None,
            hooks: false,
            profile: None,
        };
        let cmd = build_command(
            &plan,
            base(&[
                ("PATH", "/usr/bin:/bin"),
                ("EDITOR", "vim"),
                ("ANTHROPIC_API_KEY", "sk-sentinel"),
                ("CLAUDE_CODE_OAUTH_TOKEN", "sk-sentinel"),
            ]),
        );
        let manager = PtyManager::default();
        let sink = Arc::new(Recorder::default());
        manager.spawn(&plan, cmd, sink.clone()).unwrap();
        let exit = sink.wait_exit(SLOW);
        assert_eq!(exit.code, Some(0));
        let text = sink.text();
        assert!(text.contains("K=gone T=gone E=vim"), "{text:?}");
        assert!(!text.contains("sk-sentinel"));
    }

    /// App exit: dropping the manager (what `RunEvent::Exit` does through
    /// `kill_all`) ends every session's process group, including a child that
    /// ignores SIGHUP.
    #[test]
    fn closing_the_app_kills_every_session() {
        let plan = SpawnPlan {
            program: "/bin/sh".into(),
            args: vec!["-c", "trap '' HUP; sleep 600 & echo ready; wait"],
            cwd: home(),
            size: (80, 24),
            path: None,
            hooks: false,
            profile: None,
        };
        let manager = PtyManager::default();
        let sink = Arc::new(Recorder::default());
        let id = manager
            .spawn(
                &plan,
                build_command(&plan, base(&[("PATH", "/usr/bin:/bin")])),
                sink.clone(),
            )
            .unwrap();
        sink.wait_for("ready", SLOW);
        let pid = manager.sessions.lock().unwrap()[&id].pid;
        drop(manager);
        wait_dead(pid, Duration::from_secs(5));
        // The background `sleep` shared the group and went with it.
        let pgrp_left = std::process::Command::new("/bin/ps")
            .args(["-o", "pid=", "-g", &pid.to_string()])
            .output()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&pgrp_left.stdout).trim().is_empty(),
            "group {pid} still has {:?}",
            String::from_utf8_lossy(&pgrp_left.stdout)
        );
    }

    /// The git reads (#2855) run in the folder a session started in; the
    /// table answers for open sessions only, and forgets a session that ended.
    #[test]
    fn a_session_remembers_its_folder_until_it_ends() {
        let plan = SpawnPlan {
            program: "/bin/sh".into(),
            args: vec!["-c", "echo ready; read _"],
            cwd: home(),
            size: (80, 24),
            path: None,
            hooks: false,
            profile: None,
        };
        let manager = PtyManager::default();
        let sink = Arc::new(Recorder::default());
        let id = manager
            .spawn(
                &plan,
                build_command(&plan, base(&[("PATH", "/usr/bin:/bin")])),
                sink.clone(),
            )
            .unwrap();
        sink.wait_for("ready", SLOW);
        assert_eq!(manager.folder_of(id), Some(home()));
        assert_eq!(manager.folder_of(id + 1000), None);
        manager.kill(id).unwrap();
        sink.wait_exit(SLOW);
        assert_eq!(manager.folder_of(id), None);
    }

    #[test]
    fn unknown_sessions_and_oversized_writes_are_refused() {
        let manager = PtyManager::default();
        assert!(manager.write(999, b"x").is_err());
        assert!(manager.resize(999, 80, 24).is_err());
        assert!(manager.kill(999).is_err());
        assert!(manager
            .write(999, &vec![b'a'; MAX_WRITE_BYTES + 1])
            .unwrap_err()
            .contains("too large"));
    }

    fn sh(script: &'static str) -> SpawnPlan {
        SpawnPlan {
            program: "/bin/sh".into(),
            args: vec!["-c", script],
            cwd: home(),
            size: (80, 24),
            path: None,
            hooks: false,
            profile: None,
        }
    }

    /// `/bin/zsh -f -i`: interactive, so job control is on and every job gets
    /// its own process group — what a real login shell pane does.
    fn interactive_zsh() -> SpawnPlan {
        SpawnPlan {
            program: "/bin/zsh".into(),
            args: vec!["-f", "-i"],
            cwd: home(),
            size: (80, 24),
            path: None,
            hooks: false,
            profile: None,
        }
    }

    fn path_env() -> Vec<(OsString, OsString)> {
        base(&[("PATH", "/usr/bin:/bin")])
    }

    /// First `<tag>=<digits>` in the output (the typed line only has `$$`).
    fn number_after(text: &str, tag: &str) -> Option<i32> {
        let needle = format!("{tag}=");
        text.match_indices(&needle).find_map(|(at, _)| {
            let digits: String = text[at + needle.len()..]
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            digits.parse().ok()
        })
    }

    fn wait_number(sink: &Recorder, tag: &str) -> i32 {
        let start = Instant::now();
        loop {
            if let Some(n) = number_after(&sink.text(), tag) {
                return n;
            }
            assert!(start.elapsed() < SLOW, "no {tag}=<pid>: {:?}", sink.text());
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    /// A child that is not reading its input (a build, `sleep`, a frozen TUI)
    /// fills the tty and a blocking write would hang whoever called it — on
    /// the real app, the main thread (#2824 review H1). Writes only enqueue:
    /// each returns at once, and past `MAX_QUEUED_WRITE_BYTES` they are
    /// refused whole with `busy`.
    #[test]
    fn a_write_to_a_child_that_is_not_reading_never_blocks() {
        let plan = sh("echo ready; sleep 600");
        let manager = PtyManager::default();
        let sink = Arc::new(Recorder::default());
        let id = manager
            .spawn(&plan, build_command(&plan, path_env()), sink.clone())
            .unwrap();
        sink.wait_for("ready", SLOW);
        let paste = "a\n".repeat(32 * 1024).into_bytes(); // 64 KiB of lines
        let mut accepted = 0usize;
        let busy = loop {
            let start = Instant::now();
            let result = manager.write(id, &paste);
            let took = start.elapsed();
            assert!(took < Duration::from_millis(100), "write took {took:?}");
            match result {
                Ok(()) => accepted += paste.len(),
                Err(e) => break e,
            }
            assert!(
                accepted <= MAX_QUEUED_WRITE_BYTES + (64 << 10),
                "never refused"
            );
        };
        assert!(busy.starts_with("busy"), "{busy}");
        assert!(
            accepted >= MAX_QUEUED_WRITE_BYTES - (64 << 10),
            "{accepted}"
        );

        let start = Instant::now();
        manager.kill(id).unwrap();
        assert!(start.elapsed() < Duration::from_millis(100));
        sink.wait_exit(SLOW);
    }

    /// Queued input reaches the child in order and in full: 3,000 writes
    /// fired back to back arrive as 0..2999, nothing lost (#2824 R2 — the
    /// dispatch half of this is the app smoke in the PR).
    #[test]
    fn queued_input_arrives_in_order_and_in_full() {
        let dir = std::env::temp_dir().join(format!("oort-pty-order-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("order.txt");
        let _ = std::fs::remove_file(&file);
        let script: &'static str = Box::leak(
            format!("stty -echo; echo ready; cat > '{}'", file.display()).into_boxed_str(),
        );
        let plan = sh(script);
        let manager = PtyManager::default();
        let sink = Arc::new(Recorder::default());
        let id = manager
            .spawn(&plan, build_command(&plan, path_env()), sink.clone())
            .unwrap();
        sink.wait_for("ready", SLOW);
        for i in 0..3000 {
            manager.write(id, format!("{i}\n").as_bytes()).unwrap();
        }
        manager.write(id, b"\x04").unwrap();
        sink.wait_exit(SLOW);
        let got: Vec<usize> = std::fs::read_to_string(&file)
            .unwrap()
            .lines()
            .map(|l| l.parse().unwrap())
            .collect();
        assert_eq!(got, (0..3000).collect::<Vec<_>>());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Kill reaches a job the interactive shell put in its own process group,
    /// even one that ignores SIGHUP (#2824 review M1).
    #[test]
    fn kill_ends_every_job_of_an_interactive_shell() {
        let plan = interactive_zsh();
        let manager = PtyManager::default();
        let sink = Arc::new(Recorder::default());
        let id = manager
            .spawn(&plan, build_command(&plan, path_env()), sink.clone())
            .unwrap();
        let shell = manager.sessions.lock().unwrap()[&id].pid;
        manager
            .write(id, b"sh -c 'trap \"\" HUP; echo JOB=$$; exec sleep 600'\r")
            .unwrap();
        let job = wait_number(&sink, "JOB");
        let job_group = unsafe { libc::getpgid(job) };
        assert_ne!(job_group, shell, "job control put the job in its own group");
        assert!(alive(job));

        manager.kill(id).unwrap();
        sink.wait_exit(SLOW);
        wait_dead(job, Duration::from_secs(5));
    }

    /// A shell that exits on its own takes what it left behind — here a
    /// disowned background job that ignores SIGHUP. Otherwise the job keeps
    /// the terminal (and the reader thread) alive with no session to reach it.
    #[test]
    fn a_shell_that_exits_takes_its_leftover_jobs() {
        let plan = interactive_zsh();
        let manager = PtyManager::default();
        let sink = Arc::new(Recorder::default());
        let id = manager
            .spawn(&plan, build_command(&plan, path_env()), sink.clone())
            .unwrap();
        manager
            .write(id, b"(trap '' HUP; exec sleep 600) & echo BG=$!; disown\r")
            .unwrap();
        let job = wait_number(&sink, "BG");
        assert!(alive(job));
        manager.write(id, b"exit\r").unwrap();
        sink.wait_exit(SLOW);
        wait_dead(job, Duration::from_secs(5));
        assert_eq!(manager.len(), 0);
    }

    /// Counts output without keeping it (the flow tests move 100 MB).
    #[derive(Default)]
    struct Counter {
        bytes: AtomicUsize,
        exit: Mutex<Option<PtyExit>>,
    }

    impl PtySink for Counter {
        fn output(&self, bytes: Vec<u8>) {
            self.bytes.fetch_add(bytes.len(), Ordering::AcqRel);
        }
        fn exit(&self, exit: PtyExit) {
            *self.exit.lock().unwrap() = Some(exit);
        }
    }

    /// Output that nobody acknowledges stops at the high-water mark: the
    /// reader pauses, the child blocks, nothing piles up in memory (#2824
    /// review M3). Acknowledging lets output flow again.
    #[test]
    fn unacknowledged_output_stops_at_the_high_water_mark() {
        let plan = sh("yes | head -c 100000000; echo; echo DONE");
        let manager = PtyManager::default();
        let sink = Arc::new(Counter::default());
        let id = manager
            .spawn(&plan, build_command(&plan, path_env()), sink.clone())
            .unwrap();
        let start = Instant::now();
        while sink.bytes.load(Ordering::Acquire) < OUTPUT_HIGH_WATER {
            assert!(start.elapsed() < SLOW, "never reached the mark");
            std::thread::sleep(Duration::from_millis(10));
        }
        std::thread::sleep(Duration::from_millis(800));
        let held = sink.bytes.load(Ordering::Acquire);
        assert!(
            held <= OUTPUT_HIGH_WATER + READ_CHUNK,
            "{held} bytes unacked"
        );
        std::thread::sleep(Duration::from_millis(400));
        assert_eq!(
            sink.bytes.load(Ordering::Acquire),
            held,
            "reader kept going"
        );
        assert!(
            sink.exit.lock().unwrap().is_none(),
            "child should be blocked"
        );

        // Now draw what arrives: output flows again, 20 MB of it, and the
        // window never exceeds the mark.
        let mut acked = 0usize;
        let start = Instant::now();
        while acked < 20_000_000 {
            assert!(
                start.elapsed() < Duration::from_secs(60),
                "stalled at {acked}"
            );
            let now = sink.bytes.load(Ordering::Acquire);
            assert!(
                now - acked <= OUTPUT_HIGH_WATER + READ_CHUNK,
                "{}",
                now - acked
            );
            if now > acked {
                manager.ack(id, now - acked).unwrap();
                acked = now;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        manager.kill(id).unwrap();
        let start = Instant::now();
        while sink.exit.lock().unwrap().is_none() {
            assert!(start.elapsed() < SLOW, "no exit after kill");
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    #[test]
    fn the_harness_list_is_pinned_and_ids_are_names() {
        // Widening this list is a product decision (ADR-0190 D3), not a patch.
        assert_eq!(HARNESSES, ["claude", "codex", "grok"]);
        let bin = fake_bin().into_os_string();
        for name in ["/bin/sh", "../claude", "a/claude", "", ".."] {
            assert!(harness_path::find_on_path(name, &bin).is_none(), "{name:?}");
        }
        assert!(harness_path::find_on_path("claude", &bin).is_some());
    }

    #[test]
    fn the_session_cap_is_enforced() {
        let manager = PtyManager::default();
        manager.live.store(MAX_SESSIONS, Ordering::Release);
        let plan = sh("true");
        let err = manager
            .spawn(
                &plan,
                build_command(&plan, path_env()),
                Arc::new(Recorder::default()),
            )
            .unwrap_err();
        assert!(err.contains("already open"), "{err}");
        assert_eq!(manager.live.load(Ordering::Acquire), MAX_SESSIONS);
    }

    // --- sign-in (ADR-0190 D3-f, #2816) --------------------------------------

    fn login_request(id: &str, method: LoginMethod) -> SpawnRequest {
        SpawnRequest {
            program: Program::Login {
                id: id.into(),
                method,
                profile: None,
            },
            cwd: None,
            cols: 80,
            rows: 24,
        }
    }

    /// Production part of this file.
    fn production() -> &'static str {
        include_str!("pty.rs")
            .split("#[cfg(test)]\nmod tests")
            .next()
            .unwrap()
    }

    #[test]
    fn the_sign_in_list_is_exactly_three_fixed_commands() {
        // Widening this list is an ADR change (ADR-0190 D3-f), not a patch.
        assert_eq!(
            LOGIN_COMMANDS,
            &[
                LoginCommand {
                    id: "claude",
                    method: LoginMethod::Browser,
                    args: &["auth", "login", "--claudeai"],
                },
                LoginCommand {
                    id: "codex",
                    method: LoginMethod::Browser,
                    args: &["login"],
                },
                LoginCommand {
                    id: "codex",
                    method: LoginMethod::Device,
                    args: &["login", "--device-auth"],
                },
            ]
        );
        // Every sign-in program is a harness a pane may start anyway.
        assert!(LOGIN_COMMANDS.iter().all(|row| HARNESSES.contains(&row.id)));
    }

    #[test]
    fn the_sign_in_request_names_a_harness_and_a_method_only() {
        let ok: SpawnRequest = serde_json::from_str(
            r#"{"program":{"kind":"login","id":"codex","method":"device"},"cols":80,"rows":24}"#,
        )
        .unwrap();
        assert_eq!(
            ok.program,
            login_request("codex", LoginMethod::Device).program
        );
        for extra in [
            r#"{"program":{"kind":"login","id":"claude","method":"browser","args":["--console"]},"cols":80,"rows":24}"#,
            r#"{"program":{"kind":"login","id":"claude","method":"browser","env":{"CLAUDE_CONFIG_DIR":"/tmp"}},"cols":80,"rows":24}"#,
            r#"{"program":{"kind":"login","id":"claude","method":"console"},"cols":80,"rows":24}"#,
            r#"{"program":{"kind":"login","id":"claude"},"cols":80,"rows":24}"#,
        ] {
            assert!(
                serde_json::from_str::<SpawnRequest>(extra).is_err(),
                "accepted {extra}"
            );
        }
    }

    #[test]
    fn a_sign_in_resolves_one_row_here_and_refuses_the_rest() {
        let bin = login_bin("plan");
        let host = host(bin.clone().into_os_string());
        let plan = plan_spawn(&login_request("claude", LoginMethod::Browser), &host).unwrap();
        assert_eq!(plan.program, bin.join("claude"));
        assert_eq!(plan.args, ["auth", "login", "--claudeai"]);
        assert_eq!(plan.cwd, home());
        assert_eq!(plan.path.as_deref(), Some(host.path.as_os_str()));
        let plan = plan_spawn(&login_request("codex", LoginMethod::Device), &host).unwrap();
        assert_eq!(plan.args, ["login", "--device-auth"]);

        // Claude has no device flow here; grok has no sign-in; ids are names.
        for (id, method) in [
            ("claude", LoginMethod::Device),
            ("grok", LoginMethod::Browser),
            ("../claude", LoginMethod::Browser),
            ("/bin/sh", LoginMethod::Browser),
            ("sh", LoginMethod::Browser),
        ] {
            let err = plan_spawn(&login_request(id, method), &host).unwrap_err();
            assert!(err.starts_with("refused"), "{id} {method:?}: {err}");
        }
        // A sign-in always runs in home; the page cannot pick the folder.
        let mut with_cwd = login_request("claude", LoginMethod::Browser);
        with_cwd.cwd = Some(home().to_string_lossy().into_owned());
        assert!(plan_spawn(&with_cwd, &host)
            .unwrap_err()
            .starts_with("refused"));
        // Not installed.
        let empty = self::host(OsString::from("/nonexistent-2816"));
        assert!(
            plan_spawn(&login_request("codex", LoginMethod::Browser), &empty)
                .unwrap_err()
                .contains("not installed")
        );
        std::fs::remove_dir_all(bin).ok();
    }

    /// The shell source names none of the sign-in variants D3-f keeps off
    /// this path, and never prints or logs: terminal bytes go to the page's
    /// channel and nowhere else.
    #[test]
    fn no_other_sign_in_flag_and_no_logging_in_the_shell_source() {
        let src = production();
        for needle in [
            "--console",
            "--sso",
            "--email",
            "--with-api-key",
            "--with-access-token",
            "--dangerously",
            "\"-c\"",
            "\"--config\"",
            "\"logout\"",
        ] {
            assert!(!src.contains(needle), "pty.rs names {needle}");
        }
        for needle in [
            "println!",
            "eprintln!",
            "print!(",
            "eprint!(",
            "dbg!(",
            "log::",
            "tracing::",
            "std::fs::write",
            "File::create",
        ] {
            assert!(!src.contains(needle), "pty.rs uses {needle}");
        }
    }

    const FAKE_URL: &str = "https://claude.ai/oauth/authorize?code_challenge=FAKE2816";
    const FAKE_TOKEN: &str = "sk-ant-oat01-FAKE2816TOKENvalue";
    const FAKE_CODE: &str = "PASTED-2816-code";

    /// A folder with fake `claude` and `codex` sign-in commands: each checks
    /// its exact argv, prints URL- and token-shaped lines, then either waits
    /// for a pasted code (`claude`) or finishes as if the browser called
    /// back (`codex`).
    fn login_bin(tag: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("oort-2816-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let claude = format!(
            "#!/bin/sh\n\
             [ \"$#\" = 3 ] && [ \"$1\" = auth ] && [ \"$2\" = login ] && [ \"$3\" = --claudeai ] || exit 9\n\
             echo 'Opening browser: {FAKE_URL}'\n\
             printf 'Paste code here if prompted > '\n\
             read code\n\
             [ \"$code\" = '{FAKE_CODE}' ] || exit 3\n\
             echo 'token {FAKE_TOKEN}'\n\
             echo 'Login successful.'\n"
        );
        let codex = format!(
            "#!/bin/sh\n\
             if [ \"$#\" = 1 ] && [ \"$1\" = login ]; then echo 'browser {FAKE_URL}'; exit 0; fi\n\
             if [ \"$#\" = 2 ] && [ \"$1\" = login ] && [ \"$2\" = --device-auth ]; then echo 'code ABCD-EFGH'; exit 0; fi\n\
             exit 9\n"
        );
        for (name, body) in [("claude", claude), ("codex", codex)] {
            let file = dir.join(name);
            std::fs::write(&file, body).unwrap();
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        dir
    }

    #[test]
    fn a_fake_sign_in_runs_with_its_fixed_argv_and_takes_a_pasted_code() {
        let bin = login_bin("code");
        let host = host(bin.clone().into_os_string());
        let manager = PtyManager::default();

        // Claude: waits at the prompt until the page writes the pasted code.
        let plan = plan_spawn(&login_request("claude", LoginMethod::Browser), &host).unwrap();
        let sink = Arc::new(Recorder::default());
        let id = manager
            .spawn(&plan, build_command(&plan, path_env()), sink.clone())
            .unwrap();
        sink.wait_for("Paste code", SLOW);
        manager
            .write(id, format!("{FAKE_CODE}\r").as_bytes())
            .unwrap();
        let exit = sink.wait_exit(SLOW);
        assert_eq!(exit.code, Some(0), "output: {:?}", sink.text());
        // The bytes reached the page's sink (to be drawn only if asked).
        assert!(sink.text().contains(FAKE_TOKEN));

        // Codex, both methods: argv is exactly the row's.
        for method in [LoginMethod::Browser, LoginMethod::Device] {
            let plan = plan_spawn(&login_request("codex", method), &host).unwrap();
            let sink = Arc::new(Recorder::default());
            manager
                .spawn(&plan, build_command(&plan, path_env()), sink.clone())
                .unwrap();
            assert_eq!(
                sink.wait_exit(SLOW).code,
                Some(0),
                "{method:?}: {:?}",
                sink.text()
            );
        }
        std::fs::remove_dir_all(bin).ok();
    }

    #[test]
    fn a_wrong_code_fails_and_cancel_ends_a_waiting_sign_in() {
        let bin = login_bin("cancel");
        let host = host(bin.clone().into_os_string());
        let manager = PtyManager::default();
        let plan = plan_spawn(&login_request("claude", LoginMethod::Browser), &host).unwrap();

        let sink = Arc::new(Recorder::default());
        let id = manager
            .spawn(&plan, build_command(&plan, path_env()), sink.clone())
            .unwrap();
        sink.wait_for("Paste code", SLOW);
        manager.write(id, b"not-the-code\r").unwrap();
        assert_eq!(sink.wait_exit(SLOW).code, Some(3));

        // Cancel (and the page's timeout, which calls the same kill).
        let sink = Arc::new(Recorder::default());
        let id = manager
            .spawn(&plan, build_command(&plan, path_env()), sink.clone())
            .unwrap();
        sink.wait_for("Paste code", SLOW);
        manager.kill(id).unwrap();
        let exit = sink.wait_exit(SLOW);
        assert_ne!(exit.code, Some(0), "{exit:?}");
        std::fs::remove_dir_all(bin).ok();
    }

    // --- profiles: sign-in and sign-out (#2878, ADR-0190 D3-f A1·A2·A3·A5) ---

    /// A throwaway home holding one profile per harness, and a host whose
    /// PATH is `bin`. Never the real home.
    fn profile_host(tag: &str, bin: &Path) -> HostFacts {
        let home = std::env::temp_dir().join(format!("oort-2878-pty-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        let home = home.canonicalize().unwrap();
        harness_profile::create_profile(&home, "claude", "회사").unwrap();
        harness_profile::create_profile(&home, "codex", "개인").unwrap();
        HostFacts {
            home,
            shell: Some("/bin/zsh".into()),
            allowed_shells: vec!["/bin/zsh".into()],
            path: bin.as_os_str().to_owned(),
        }
    }

    fn logout_request(id: &str, profile: &str) -> SpawnRequest {
        SpawnRequest {
            program: Program::Logout {
                id: id.into(),
                profile: profile.into(),
            },
            cwd: None,
            cols: 80,
            rows: 24,
        }
    }

    fn profile_login_request(id: &str, method: LoginMethod, profile: &str) -> SpawnRequest {
        SpawnRequest {
            program: Program::Login {
                id: id.into(),
                method,
                profile: Some(profile.into()),
            },
            cwd: None,
            cols: 80,
            rows: 24,
        }
    }

    fn profile_harness_request(id: &str, profile: &str) -> SpawnRequest {
        SpawnRequest {
            program: Program::Harness {
                id: id.into(),
                profile: Some(profile.into()),
            },
            cwd: None,
            cols: 80,
            rows: 24,
        }
    }

    /// #3010 (ADR-0191 D1): a new terminal session opens the account chosen in
    /// 기본 AI — the profile folder's variable reaches the harness, over
    /// whatever the app inherited. Without a profile none is set.
    #[test]
    fn a_harness_session_runs_in_the_chosen_profile_folder() {
        let ok: SpawnRequest = serde_json::from_str(
            r#"{"program":{"kind":"harness","id":"claude","profile":"회사"},"cols":80,"rows":24}"#,
        )
        .unwrap();
        assert_eq!(
            ok.program,
            profile_harness_request("claude", "회사").program
        );

        let bin = login_bin("profile-harness");
        let host = profile_host("harness", &bin);
        let claude_dir = harness_profile::profile_root(&host.home).join("claude/회사");
        let plan = plan_spawn(&profile_harness_request("claude", "회사"), &host).unwrap();
        assert_eq!(plan.program, bin.join("claude"));
        assert!(plan.hooks);
        assert_eq!(
            plan.profile,
            Some(("CLAUDE_CONFIG_DIR", claude_dir.clone()))
        );
        let env = env_of(&build_command(
            &plan,
            base(&[
                ("PATH", "/usr/bin"),
                ("CLAUDE_CONFIG_DIR", "/somewhere/else"),
            ]),
        ));
        assert_eq!(
            env.get("CLAUDE_CONFIG_DIR").map(String::as_str),
            Some(claude_dir.to_str().unwrap())
        );

        let plain = plan_spawn(&harness_request("claude"), &host).unwrap();
        assert_eq!(plain.profile, None);
        std::fs::remove_dir_all(&host.home).ok();
        std::fs::remove_dir_all(bin).ok();
    }

    /// #3010: a chosen account that is gone (or never was) is refused, not
    /// swapped for this Mac's default sign-in. The web layer says so and opens
    /// a shell instead (core `resolveRow`).
    #[test]
    fn a_harness_session_refuses_a_profile_that_is_not_there() {
        let bin = login_bin("profile-harness-refuse");
        let host = profile_host("harness-refuse", &bin);
        for (id, profile) in [
            ("claude", "없는계정"),
            ("claude", ""),
            ("claude", "../codex/개인"),
            // Grok has no profile folder (ADR-0191 D1: spike first).
            ("grok", "회사"),
        ] {
            assert!(
                plan_spawn(&profile_harness_request(id, profile), &host).is_err(),
                "accepted {id} {profile:?}"
            );
        }
        std::fs::remove_dir_all(&host.home).ok();
        std::fs::remove_dir_all(bin).ok();
    }

    /// ADR-0190 D3-g: the sign-in and sign-out lists are separate. A row that
    /// moved from one to the other, or a sign-out that crept into the
    /// sign-in list, fails here.
    #[test]
    fn the_sign_out_list_is_not_the_sign_in_list() {
        assert_eq!(harness_profile::LOGOUT_COMMANDS.len(), 2);
        for row in harness_profile::LOGOUT_COMMANDS {
            assert!(HARNESSES.contains(&row.id));
            assert!(!LOGIN_COMMANDS.iter().any(|login| login.args == row.args));
        }
        for row in LOGIN_COMMANDS {
            assert!(!row.args.iter().any(|a| a.ends_with("logout")));
        }
    }

    #[test]
    fn the_sign_out_request_names_a_harness_and_a_profile_label_only() {
        let ok: SpawnRequest = serde_json::from_str(
            r#"{"program":{"kind":"logout","id":"claude","profile":"회사"},"cols":80,"rows":24}"#,
        )
        .unwrap();
        assert_eq!(ok.program, logout_request("claude", "회사").program);
        let ok: SpawnRequest = serde_json::from_str(
            r#"{"program":{"kind":"login","id":"codex","method":"browser","profile":"개인"},"cols":80,"rows":24}"#,
        )
        .unwrap();
        assert_eq!(
            ok.program,
            profile_login_request("codex", LoginMethod::Browser, "개인").program
        );
        for bad in [
            // No sign-out of the default location: the profile is required.
            r#"{"program":{"kind":"logout","id":"claude"},"cols":80,"rows":24}"#,
            r#"{"program":{"kind":"logout","id":"claude","profile":null},"cols":80,"rows":24}"#,
            r#"{"program":{"kind":"logout","id":"claude","profile":"a","path":"/tmp"},"cols":80,"rows":24}"#,
            r#"{"program":{"kind":"logout","id":"claude","profile":"a","args":["--all"]},"cols":80,"rows":24}"#,
        ] {
            assert!(
                serde_json::from_str::<SpawnRequest>(bad).is_err(),
                "accepted {bad}"
            );
        }
    }

    #[test]
    fn a_profile_sign_in_and_sign_out_get_the_same_folder_variable() {
        let bin = login_bin("profile-plan");
        let host = profile_host("plan", &bin);
        let claude_dir = harness_profile::profile_root(&host.home).join("claude/회사");
        let codex_dir = harness_profile::profile_root(&host.home).join("codex/개인");

        let login = plan_spawn(
            &profile_login_request("claude", LoginMethod::Browser, "회사"),
            &host,
        )
        .unwrap();
        let logout = plan_spawn(&logout_request("claude", "회사"), &host).unwrap();
        assert_eq!(login.args, ["auth", "login", "--claudeai"]);
        assert_eq!(logout.args, ["auth", "logout"]);
        assert_eq!(logout.program, bin.join("claude"));
        assert_eq!(
            login.profile,
            Some(("CLAUDE_CONFIG_DIR", claude_dir.clone()))
        );
        // Byte-identical: Claude Code names its keychain item after this string.
        assert_eq!(login.profile, logout.profile);

        let logout = plan_spawn(&logout_request("codex", "개인"), &host).unwrap();
        assert_eq!(logout.args, ["logout"]);
        assert_eq!(logout.profile, Some(("CODEX_HOME", codex_dir.clone())));

        // The variable reaches the child, over whatever the app inherited.
        let env = env_of(&build_command(
            &logout,
            base(&[("PATH", "/usr/bin"), ("CODEX_HOME", "/somewhere/else")]),
        ));
        assert_eq!(
            env.get("CODEX_HOME").map(String::as_str),
            Some(codex_dir.to_str().unwrap())
        );
        // A plain sign-in sets none.
        let plain = plan_spawn(&login_request("claude", LoginMethod::Browser), &host).unwrap();
        assert_eq!(plain.profile, None);
        std::fs::remove_dir_all(&host.home).ok();
        std::fs::remove_dir_all(bin).ok();
    }

    #[test]
    fn a_sign_out_refuses_anything_but_an_existing_checked_profile() {
        let bin = login_bin("profile-refuse");
        let host = profile_host("refuse", &bin);
        // A stand-in for the CLI's default folder inside the throwaway home,
        // and a profile entry that is a symlink to it.
        let default = host.home.join(".claude");
        std::fs::create_dir_all(&default).unwrap();
        std::os::unix::fs::symlink(
            &default,
            harness_profile::profile_root(&host.home).join("claude/evil"),
        )
        .unwrap();
        for (id, profile) in [
            ("claude", ""),
            ("claude", ".."),
            ("claude", "../../../../../.claude"),
            ("claude", "/tmp/x"),
            ("claude", "없는 계정"),
            ("claude", "evil"),
            ("grok", "회사"),
            ("sh", "회사"),
        ] {
            let err = plan_spawn(&logout_request(id, profile), &host).unwrap_err();
            assert!(err.starts_with("refused"), "{id} {profile:?}: {err}");
            let err = plan_spawn(
                &profile_login_request(id, LoginMethod::Browser, profile),
                &host,
            )
            .unwrap_err();
            assert!(err.starts_with("refused"), "login {id} {profile:?}: {err}");
        }
        let mut with_cwd = logout_request("claude", "회사");
        with_cwd.cwd = Some(host.home.to_string_lossy().into_owned());
        assert!(plan_spawn(&with_cwd, &host)
            .unwrap_err()
            .starts_with("refused"));
        assert!(default.is_dir());
        std::fs::remove_dir_all(&host.home).ok();
        std::fs::remove_dir_all(bin).ok();
    }

    /// A fake CLI checks its argv and the folder variable, then signs out.
    #[test]
    fn a_fake_sign_out_runs_with_its_fixed_argv_in_that_folder() {
        use std::os::unix::fs::PermissionsExt;
        let bin = std::env::temp_dir().join(format!("oort-2878-logout-bin-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&bin);
        std::fs::create_dir_all(&bin).unwrap();
        let host = profile_host("run", &bin);
        let dir = harness_profile::profile_root(&host.home).join("claude/회사");
        let claude = format!(
            "#!/bin/sh\n\
             [ \"$#\" = 2 ] && [ \"$1\" = auth ] && [ \"$2\" = logout ] || exit 9\n\
             [ \"$CLAUDE_CONFIG_DIR\" = '{}' ] || exit 8\n\
             echo 'Successfully logged out'\n",
            dir.display()
        );
        std::fs::write(bin.join("claude"), claude).unwrap();
        std::fs::set_permissions(bin.join("claude"), std::fs::Permissions::from_mode(0o755))
            .unwrap();
        let manager = PtyManager::default();
        let plan = plan_spawn(&logout_request("claude", "회사"), &host).unwrap();
        let sink = Arc::new(Recorder::default());
        manager
            .spawn(&plan, build_command(&plan, path_env()), sink.clone())
            .unwrap();
        assert_eq!(sink.wait_exit(SLOW).code, Some(0), "{:?}", sink.text());
        std::fs::remove_dir_all(&host.home).ok();
        std::fs::remove_dir_all(bin).ok();
    }

    // --- pane signals (#2776) -------------------------------------------------

    /// A harness pane gets the socket, its id and a token; a hook line with
    /// that token reaches this pane's sink, and a line with another token, or
    /// one aimed at a shell pane, reaches nothing. Output that looks like a
    /// permission prompt is not a signal (ADR-0190 D4-b).
    #[test]
    fn a_hook_line_reaches_its_own_pane_and_output_never_does() {
        let dir = std::env::temp_dir().join(format!("oort-pty-sig-{}", std::process::id()));
        let sock = dir.join("hook.sock");
        let listener = pane_signal::bind(&sock).unwrap();
        let manager = Arc::new(PtyManager::default());
        manager.set_hook_socket(sock.clone());
        pane_signal::serve(listener, manager.clone());

        // The pane prints a fake permission prompt (output), then sends one
        // good line and one line carrying a wrong token, both via nc -U.
        let script = r#"echo 'Notification permission_prompt: Allow Bash? sk-ant-XXXX'
line() { printf '{"pane":%s,"token":"%s","source":"claude","event":"%s","detail":"permission_prompt"}\n' "$OORT_PANE_ID" "$1" "$2" | /usr/bin/nc -U "$OORT_PANE_HOOK_SOCK"; }
line "$OORT_PANE_TOKEN" Notification
line "not-the-token" Stop
echo "id=$OORT_PANE_ID tlen=${#OORT_PANE_TOKEN} done"
"#;
        let mut plan = sh(script);
        plan.hooks = true;
        let sink = Arc::new(Recorder::default());
        let id = manager
            .spawn(&plan, build_command(&plan, path_env()), sink.clone())
            .unwrap();
        sink.wait_exit(SLOW);
        let text = sink.text();
        assert!(text.contains(&format!("id={id} tlen=32 done")), "{text:?}");
        let start = Instant::now();
        while sink.signals.lock().unwrap().is_empty() && start.elapsed() < SLOW {
            std::thread::sleep(Duration::from_millis(25));
        }
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(
            *sink.signals.lock().unwrap(),
            [PaneSignal::WaitingPermission],
            "only the line with this pane's token"
        );

        // A shell pane gets no hook environment at all.
        let plan = sh(r#"echo "sock=[${OORT_PANE_HOOK_SOCK}] tok=[${OORT_PANE_TOKEN}]""#);
        let shell_sink = Arc::new(Recorder::default());
        manager
            .spawn(&plan, build_command(&plan, path_env()), shell_sink.clone())
            .unwrap();
        shell_sink.wait_exit(SLOW);
        assert!(
            shell_sink.text().contains("sock=[] tok=[]"),
            "{:?}",
            shell_sink.text()
        );
        pane_signal::remove(&sock);
    }

    #[test]
    fn a_signal_for_a_closed_or_unknown_pane_goes_nowhere() {
        let manager = PtyManager::default();
        assert!(!manager.deliver_signal(1, "", PaneSignal::TurnDone));
        assert!(!manager.deliver_signal(99, "abc", PaneSignal::TurnDone));
        assert!(tokens_match("abc", "abc"));
        assert!(!tokens_match("abc", "abd"));
        assert!(!tokens_match("abc", "abcd"));
    }
}
