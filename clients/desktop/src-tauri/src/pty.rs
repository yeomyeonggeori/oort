// Local terminal lane (ADR-0190 D1·D2, #2772): the desktop app process opens
// the PTY, the app webview draws it. Four commands plus two channels:
//
//   pty_spawn   { program, cwd?, cols, rows } + onOutput + onExit -> id
//   pty_write   raw bytes (invoke body) + header `x-oort-pty-id`
//   pty_resize  { id, cols, rows }
//   pty_kill    { id }
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
//    to an absolute path HERE from the login PATH. No extra arguments pass
//    through — in particular no permission-bypass flag (ADR-0190 D2).
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
// resizes a PTY. `shell_contract.rs` pins that by source (ADR-0190 D1).
// Raw output stays on this machine; it is never sent to the server (D2).

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Duration;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};

/// Harness CLIs a pane may start by id (ADR-0190 D3: the local PATH is the
/// source of truth, this list only bounds what may be asked for).
pub const HARNESSES: &[&str] = &["claude", "codex", "grok"];

/// Account variables removed from every PTY's environment (ADR-0191 D2).
/// Profile folders (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) are #2777's call.
pub const STRIPPED_ENV: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
];

pub const MAX_SESSIONS: usize = 32;
pub const MAX_COLS: u16 = 1000;
pub const MAX_ROWS: u16 = 500;
/// One `pty_write` body. xterm sends keystrokes and pastes; a paste larger
/// than this is split by the web layer.
pub const MAX_WRITE_BYTES: usize = 1 << 20;
pub const ID_HEADER: &str = "x-oort-pty-id";

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
}

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
    /// The PATH a harness runs with (login PATH + well-known bins).
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
        Program::Harness { id } => {
            if !HARNESSES.contains(&id.as_str()) {
                return Err(format!("refused: unknown harness {id:?}"));
            }
            let program = find_on_path(id, &host.path)
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

fn find_on_path(name: &str, path: &OsString) -> Option<PathBuf> {
    std::env::split_paths(path)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(name))
        .find(|candidate| is_executable(candidate))
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
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
    pub fn current() -> Result<Self, String> {
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
        let path = harness_path(&home, shell.as_deref());
        Ok(Self {
            home,
            shell,
            allowed_shells,
            path,
        })
    }
}

/// PATH for harness spawns: what the login shell reports, then the app's own,
/// then the usual install folders. Interim until local detection (#2775).
fn harness_path(home: &Path, shell: Option<&Path>) -> OsString {
    static LOGIN_PATH: OnceLock<Option<OsString>> = OnceLock::new();
    let login = LOGIN_PATH
        .get_or_init(|| shell.and_then(probe_login_path))
        .clone();
    let mut dirs: Vec<PathBuf> = Vec::new();
    for source in [login, std::env::var_os("PATH")].into_iter().flatten() {
        dirs.extend(std::env::split_paths(&source));
    }
    for extra in [".local/bin", ".claude/local", ".bun/bin", ".npm-global/bin"] {
        dirs.push(home.join(extra));
    }
    dirs.push("/opt/homebrew/bin".into());
    dirs.push("/usr/local/bin".into());
    let mut seen = Vec::new();
    dirs.retain(|d| {
        d.is_absolute() && !seen.contains(d) && {
            seen.push(d.clone());
            true
        }
    });
    std::env::join_paths(dirs).unwrap_or_default()
}

/// Ask the login shell for its PATH, bounded by a timeout.
fn probe_login_path(shell: &Path) -> Option<OsString> {
    use std::process::{Command, Stdio};
    const MARK: &str = "__OORT_PATH__";
    let mut child = Command::new(shell)
        .args(["-l", "-c", &format!("printf '{MARK}%s{MARK}' \"$PATH\"")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut out = String::new();
        let _ = stdout.read_to_string(&mut out);
        let _ = tx.send(out);
    });
    let out = rx.recv_timeout(Duration::from_secs(3));
    let _ = child.kill();
    let _ = child.wait();
    let out = out.ok()?;
    let start = out.find(MARK)? + MARK.len();
    let end = start + out[start..].find(MARK)?;
    Some(OsString::from(&out[start..end]))
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

type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

struct Session {
    master: Box<dyn MasterPty + Send>,
    /// Its own lock: a write can block (a child that stopped reading fills
    /// the tty buffer), and it must not hold the session map while it does —
    /// kill, resize and app exit need that map.
    writer: SharedWriter,
    pid: i32,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<u32, Session>>>,
    next_id: AtomicU32,
}

impl PtyManager {
    pub fn spawn(
        &self,
        plan: &SpawnPlan,
        cmd: CommandBuilder,
        sink: Arc<dyn PtySink>,
    ) -> Result<u32, String> {
        if self.sessions.lock().unwrap().len() >= MAX_SESSIONS {
            return Err(format!("refused: {MAX_SESSIONS} terminals already open"));
        }
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
        self.sessions.lock().unwrap().insert(
            id,
            Session {
                master: pair.master,
                writer: Arc::new(Mutex::new(writer)),
                pid,
            },
        );

        let (drained_tx, drained_rx) = mpsc::channel::<()>();
        let out = sink.clone();
        std::thread::Builder::new()
            .name(format!("pty-{id}-read"))
            .spawn(move || read_loop(reader, out, drained_tx))
            .map_err(|e| format!("reader thread: {e}"))?;

        let sessions = self.sessions.clone();
        std::thread::Builder::new()
            .name(format!("pty-{id}-wait"))
            .spawn(move || {
                let status = child.wait();
                let _ = drained_rx.recv_timeout(DRAIN_GRACE);
                sessions.lock().unwrap().remove(&id);
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

    pub fn write(&self, id: u32, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() > MAX_WRITE_BYTES {
            return Err("refused: write too large".into());
        }
        let writer = self
            .sessions
            .lock()
            .unwrap()
            .get(&id)
            .map(|s| s.writer.clone())
            .ok_or_else(|| unknown(id))?;
        let mut writer = writer.lock().unwrap();
        writer
            .write_all(bytes)
            .and_then(|_| writer.flush())
            .map_err(|e| format!("write: {e}"))
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

    /// Hang up the session's process group; SIGKILL whatever ignores that.
    /// The exit arrives on the session's exit channel.
    pub fn kill(&self, id: u32) -> Result<(), String> {
        let pid = self
            .sessions
            .lock()
            .unwrap()
            .get(&id)
            .map(|s| s.pid)
            .ok_or_else(|| unknown(id))?;
        hang_up(pid);
        std::thread::spawn(move || {
            std::thread::sleep(KILL_GRACE);
            force_kill(pid);
        });
        Ok(())
    }

    /// App exit: every session's process group goes, synchronously.
    pub fn kill_all(&self) {
        let pids: Vec<i32> = self
            .sessions
            .lock()
            .map(|s| s.values().map(|s| s.pid).collect())
            .unwrap_or_default();
        if pids.is_empty() {
            return;
        }
        pids.iter().copied().for_each(hang_up);
        std::thread::sleep(Duration::from_millis(150));
        pids.iter().copied().for_each(force_kill);
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

fn read_loop(mut reader: Box<dyn Read + Send>, sink: Arc<dyn PtySink>, drained: mpsc::Sender<()>) {
    let mut buf = vec![0u8; READ_CHUNK];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => sink.output(buf[..n].to_vec()),
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

/// The child is a session leader (portable-pty calls setsid), so its pid is
/// also its process group id.
#[cfg(unix)]
fn hang_up(pid: i32) {
    if pid > 0 {
        unsafe {
            libc::killpg(pid, libc::SIGHUP);
        }
    }
}

#[cfg(unix)]
fn force_kill(pid: i32) {
    if pid > 0 {
        unsafe {
            libc::killpg(pid, libc::SIGKILL);
        }
    }
}

// The terminal lane ships on macOS (ADR-0190 D1). Elsewhere the commands
// exist but a session cannot be signalled by group; closing the master still
// hangs the console up when the session is dropped.
#[cfg(not(unix))]
fn hang_up(_pid: i32) {}
#[cfg(not(unix))]
fn force_kill(_pid: i32) {}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::State;

#[derive(Default)]
pub struct PtyState(pub PtyManager);

struct ChannelSink {
    output: Channel<InvokeResponseBody>,
    exit: Channel<PtyExit>,
}

impl PtySink for ChannelSink {
    fn output(&self, bytes: Vec<u8>) {
        // A closed webview must not stall the child: drop the bytes.
        let _ = self.output.send(InvokeResponseBody::Raw(bytes));
    }
    fn exit(&self, exit: PtyExit) {
        let _ = self.exit.send(exit);
    }
}

/// Open one PTY. Output arrives on `on_output` as raw bytes (`ArrayBuffer`),
/// the exit once on `on_exit`.
#[tauri::command]
pub fn pty_spawn(
    state: State<'_, PtyState>,
    request: SpawnRequest,
    on_output: Channel<InvokeResponseBody>,
    on_exit: Channel<PtyExit>,
) -> Result<u32, String> {
    let host = HostFacts::current()?;
    let plan = plan_spawn(&request, &host)?;
    let cmd = build_command(&plan, std::env::vars_os());
    state.0.spawn(
        &plan,
        cmd,
        Arc::new(ChannelSink {
            output: on_output,
            exit: on_exit,
        }),
    )
}

/// Keystrokes and pastes: raw bytes in the invoke body, the session id in
/// `x-oort-pty-id`. Raw bodies need the `ipc:` transport the CSP keeps open.
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
pub fn pty_resize(state: State<'_, PtyState>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    state.0.resize(id, cols, rows)
}

#[tauri::command]
pub fn pty_kill(state: State<'_, PtyState>, id: u32) -> Result<(), String> {
    state.0.kill(id)
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
        // ADR-0191 D2 names these four; the list is the contract.
        assert_eq!(
            STRIPPED_ENV,
            [
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_AUTH_TOKEN",
                "CLAUDE_CODE_OAUTH_TOKEN",
                "OPENAI_API_KEY"
            ]
        );
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
        let host = HostFacts::current().unwrap();
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

    /// A child that stops reading (a frozen TUI) fills the tty buffer and
    /// blocks the writer. Kill must still get through.
    #[test]
    fn a_blocked_write_does_not_block_kill() {
        let plan = SpawnPlan {
            program: "/bin/sh".into(),
            args: vec!["-c", "stty raw -echo; echo ready; sleep 600"],
            cwd: home(),
            size: (80, 24),
            path: None,
        };
        let manager = Arc::new(PtyManager::default());
        let sink = Arc::new(Recorder::default());
        let id = manager
            .spawn(
                &plan,
                build_command(&plan, base(&[("PATH", "/usr/bin:/bin")])),
                sink.clone(),
            )
            .unwrap();
        sink.wait_for("ready", Duration::from_secs(20));
        let m = manager.clone();
        std::thread::spawn(move || {
            let _ = m.write(id, &vec![b'x'; MAX_WRITE_BYTES]);
        });
        std::thread::sleep(Duration::from_millis(300));
        let (tx, rx) = mpsc::channel();
        let m = manager.clone();
        std::thread::spawn(move || {
            let start = Instant::now();
            let r = m.kill(id);
            let _ = tx.send((r, start.elapsed()));
        });
        let (result, took) = rx
            .recv_timeout(Duration::from_secs(3))
            .expect("kill blocked behind a stuck write");
        result.unwrap();
        assert!(took < Duration::from_secs(1), "{took:?}");
        sink.wait_exit(Duration::from_secs(10));
    }
}
