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
    /// One of `HARNESSES`, resolved on this machine.
    Harness { id: String },
    /// The official CLI's sign-in command: one row of `LOGIN_COMMANDS`.
    Login { id: String, method: LoginMethod },
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
            })
        }
        Program::Login { id, method } => {
            if request.cwd.is_some() {
                return Err("refused: a sign-in runs in the home folder".into());
            }
            let row = LOGIN_COMMANDS
                .iter()
                .find(|row| row.id == id.as_str() && row.method == *method)
                .ok_or_else(|| format!("refused: no {method:?} sign-in for {id:?}"))?;
            let program = harness_path::find_on_path(row.id, &host.path)
                .ok_or_else(|| format!("refused: {id} is not installed on this machine"))?;
            Ok(SpawnPlan {
                program,
                args: row.args.to_vec(),
                cwd,
                size,
                path: Some(host.path.clone()),
            })
        }
        Program::Harness { id } => {
            if !HARNESSES.contains(&id.as_str()) {
                return Err(format!("refused: unknown harness {id:?}"));
            }
            let program = harness_path::find_on_path(id, &host.path)
                .ok_or_else(|| format!("refused: {id} is not installed on this machine"))?;
            Ok(SpawnPlan {
                program,
                args: Vec::new(),
                cwd,
                size,
                path: Some(host.path.clone()),
            })
        }
    }
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
    cmd
}

impl HostFacts {
    /// This machine, as `program` needs it. Runs nothing: a harness's PATH
    /// is the shared search path (inherited PATH + install folders, #2813).
    pub fn current(program: &Program) -> Result<Self, String> {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "refused: HOME unset".to_string())?
            .canonicalize()
            .map_err(|e| format!("refused: home: {e}"))?;
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
        if matches!(program, Program::Harness { .. } | Program::Login { .. }) {
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
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<u32, Session>>>,
    /// Sessions spawned or being spawned; reserved before spawning so two
    /// concurrent spawns cannot both pass the cap.
    live: Arc<AtomicUsize>,
    next_id: AtomicU32,
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

        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
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
) -> Result<u32, String> {
    let manager = state.0.clone();
    // openpty/fork block; keep them off the async workers as well as off the
    // main thread.
    tauri::async_runtime::spawn_blocking(move || {
        let host = HostFacts::current(&request.program)?;
        let plan = plan_spawn(&request, &host)?;
        let cmd = build_command(&plan, std::env::vars_os());
        let sink = Arc::new(ChannelSink {
            output: on_output,
            exit: on_exit,
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
            program: Program::Harness { id: id.into() },
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
                id: "claude".into()
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
        ] {
            assert!(STRIPPED_ENV.contains(&key), "{key}");
        }
        assert_eq!(STRIPPED_ENV.len(), 19);
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
    }

    impl PtySink for Recorder {
        fn output(&self, bytes: Vec<u8>) {
            self.bytes.lock().unwrap().extend(bytes);
        }
        fn exit(&self, exit: PtyExit) {
            *self.exit.lock().unwrap() = Some(exit);
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
            r#"{"program":{"kind":"login","id":"claude","method":"browser","profile":"/tmp/x"},"cols":80,"rows":24}"#,
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
}
