// This Mac as a work host (ADR-0188 D2 · R1, #2778).
//
// The app carries `momo-workd` as a sidecar (`tauri.conf.json > bundle >
// externalBin`, next to the app's own executable in `Contents/MacOS`) and
// starts it as its child. Five commands, all for the main webview's bundled
// origin only (`capabilities/work-host.json`):
//
//   work_host_status    what this Mac is: sidecar present, registered as which
//                       host, running, the heartbeat's last outcome, which ACP
//                       adapters were found
//   work_host_register  write the host config, `momo-workd register` with the
//                       owner's access token in the CHILD'S ENVIRONMENT (never
//                       argv, never a file, never a log line), then start
//   work_host_start     `momo-workd run --control-socket …` if registered
//   work_host_stop      `shutdown` over the control socket, SIGTERM fallback
//   work_host_forget    stop, then `momo-workd forget` (key + state) and the
//                       config; the web has already revoked the row
//
// App ↔ workd is the user-only Unix socket `momo-workd` binds in a 0700
// folder, and nothing else (no TCP). workd checks the app's code signature on
// every connection; the app checks the other way by **pid**: the socket's peer
// (`LOCAL_PEERPID`) must be the child this app started from its own bundle,
// whose binary the app's signature seals. A process squatting on the path is
// not that child and is not believed.
//
// Development builds (`debug_assertions`) are unsigned, so they keep the host
// key in a 0600 dev file and start workd with `--dev-unsigned-peer`. A release
// build never does either: its host key is the ThisDeviceOnly keychain item
// (ADR-0188 D2) and its workd checks this app's signature.

use std::io::{Read as _, Write as _};
use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _, PermissionsExt as _};
use std::os::unix::io::AsRawFd as _;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Manager;

/// The sidecar's file name inside `Contents/MacOS` (the bundler strips the
/// `-<target triple>` suffix of `binaries/momo-workd-<triple>`).
pub const SIDECAR_NAME: &str = "momo-workd";

/// The ACP adapters workd can drive, by the executable name each installs.
/// Resolved on this Mac's PATH; only the absolute path goes into the config.
pub const ADAPTERS: &[(&str, &str, &str)] = &[
    // (tool key the server names, workd adapter kind, executable)
    ("claude", "claude", "claude-agent-acp"),
    ("codex", "codex", "codex-acp"),
];

/// The folder remote sessions may open until a folder picker lands: a project
/// folder of its own under the home folder (ADR-0188 D6 허용 폴더; workd
/// refuses `/`, the home folder and anything above it).
pub const DEFAULT_WORK_FOLDER: &str = "oort-work";

/// Longest wait for `momo-workd register` (one HTTPS round trip plus a
/// keychain write that may show a system prompt).
const REGISTER_TIMEOUT: Duration = Duration::from_secs(90);
const SOCKET_TIMEOUT: Duration = Duration::from_secs(2);
const STOP_TIMEOUT: Duration = Duration::from_secs(8);

/// Where everything lives, under the app's data folder.
#[derive(Debug, Clone)]
pub struct Layout {
    pub root: PathBuf,
    pub config: PathBuf,
    pub state: PathBuf,
    pub dev_key: PathBuf,
    pub socket: PathBuf,
    pub log: PathBuf,
    pub work_folder: PathBuf,
}

impl Layout {
    pub fn new(app_data: &Path, home: &Path) -> Self {
        let root = app_data.join("work-host");
        Self {
            config: root.join("workd.json"),
            state: root.join("state").join("host.json"),
            dev_key: root.join("keys").join("host.key"),
            socket: root.join("workd.sock"),
            log: root.join("workd.log"),
            work_folder: home.join(DEFAULT_WORK_FOLDER),
            root,
        }
    }

    /// Create the private folder (0700) — the control socket's fence 1.
    fn ensure_root(&self) -> Result<(), String> {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&self.root)
            .map_err(|error| format!("work-host folder: {error}"))?;
        std::fs::set_permissions(&self.root, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("work-host folder: {error}"))
    }
}

/// What registration left behind (`momo-workd`'s state file), as far as the
/// webview needs it. Never the public key.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Registered {
    pub host_id: String,
    pub workspace_id: String,
    pub owner_member_id: String,
    pub server_url: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdapterFound {
    pub key: String,
    pub executable: String,
    pub found: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Heartbeat {
    pub last_ok_at_ms: Option<i64>,
    pub failing: bool,
}

/// `work_host_status`'s answer.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalStatus {
    /// This build carries a real `momo-workd` next to the app.
    pub sidecar: bool,
    pub registered: Option<Registered>,
    pub running: bool,
    /// The heartbeat as workd reports it; `None` when it is not running or
    /// did not answer on the control socket.
    pub heartbeat: Option<Heartbeat>,
    pub adapters: Vec<AdapterFound>,
    pub work_folder: String,
    pub display_name_suggestion: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterRequest {
    pub server_url: String,
    pub workspace_id: String,
    pub display_name: String,
    /// The owner's access token. Handed to the child's environment for the one
    /// `register` request and dropped.
    pub access_token: String,
}

impl std::fmt::Debug for WorkHostState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("WorkHostState")
    }
}

/// The running child, if any.
#[derive(Default)]
pub struct WorkHostState(Mutex<Option<Child>>);

impl WorkHostState {
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Child>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The running child's pid, reaping one that has exited.
    fn running_pid(&self) -> Option<u32> {
        let mut guard = self.lock();
        let alive = match guard.as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => false,
        };
        if !alive {
            *guard = None;
        }
        guard.as_ref().map(Child::id)
    }

    /// SIGTERM and wait; used when the app exits.
    pub fn stop_now(&self) {
        if let Some(mut child) = self.lock().take() {
            // SAFETY: plain syscall on our own child.
            unsafe {
                libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
            }
            let deadline = Instant::now() + STOP_TIMEOUT;
            while Instant::now() < deadline {
                if !matches!(child.try_wait(), Ok(None)) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

// ---- pure pieces (tested) -----------------------------------------------------

/// A Mach-O (thin or universal) rather than a build placeholder script.
pub fn is_mach_o(path: &Path) -> bool {
    let mut magic = [0u8; 4];
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    if file.read_exact(&mut magic).is_err() {
        return false;
    }
    matches!(
        u32::from_be_bytes(magic),
        0xfeed_facf | 0xcffa_edfe | 0xcafe_babe | 0xbeba_feca | 0xfeed_face | 0xcefa_edfe
    )
}

/// `momo-workd` next to this app's own executable.
pub fn sidecar_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let path = exe.parent()?.join(SIDECAR_NAME);
    is_mach_o(&path).then_some(path)
}

pub fn find_adapters(search_path: &std::ffi::OsString) -> Vec<AdapterFound> {
    ADAPTERS
        .iter()
        .map(|(key, _, executable)| {
            let found = crate::harness_path::find_on_path(executable, search_path);
            AdapterFound {
                key: key.to_string(),
                executable: found
                    .as_ref()
                    .map(|path| path.display().to_string())
                    .unwrap_or_else(|| executable.to_string()),
                found: found.is_some(),
            }
        })
        .collect()
}

/// `https://…` origin, or `http://` to loopback — workd's own rule, checked
/// here first so the person gets the sentence before a child is started.
pub fn validate_server_url(raw: &str) -> Result<String, String> {
    let url = url::Url::parse(raw.trim()).map_err(|_| "server_url_invalid".to_string())?;
    let loopback = matches!(
        url.host_str(),
        Some("localhost") | Some("127.0.0.1") | Some("[::1]")
    );
    let scheme_ok = url.scheme() == "https" || (url.scheme() == "http" && loopback);
    let origin_only = (url.path().is_empty() || url.path() == "/")
        && url.query().is_none()
        && url.fragment().is_none()
        && url.username().is_empty()
        && url.password().is_none();
    if !scheme_ok || !origin_only {
        return Err("server_url_invalid".to_string());
    }
    Ok(url.origin().ascii_serialization())
}

/// The config `momo-workd` reads. Everything in it is the owner's own
/// statement about this Mac; nothing comes from the server.
pub fn build_config(
    layout: &Layout,
    server_url: &str,
    workspace_id: &str,
    display_name: &str,
    adapters: &[AdapterFound],
) -> Result<Value, String> {
    let workspace_id = uuid_shape(workspace_id).ok_or("workspace_id_invalid")?;
    let name = display_name.trim();
    if !(1..=80).contains(&name.chars().count()) {
        return Err("display_name_invalid".to_string());
    }
    let mut tools = serde_json::Map::new();
    for (key, kind, _) in ADAPTERS {
        if let Some(found) = adapters.iter().find(|a| a.key == *key && a.found) {
            tools.insert(
                key.to_string(),
                json!({"adapter": kind, "executable": found.executable}),
            );
        }
    }
    if tools.is_empty() {
        return Err("no_acp_adapter".to_string());
    }
    Ok(json!({
        "server_url": validate_server_url(server_url)?,
        "workspace_id": workspace_id,
        "display_name": name,
        "state_path": layout.state,
        "working_directory": layout.work_folder,
        "tools": tools,
    }))
}

fn uuid_shape(raw: &str) -> Option<String> {
    let raw = raw.trim().to_ascii_lowercase();
    let groups: Vec<&str> = raw.split('-').collect();
    let lengths = [8, 4, 4, 4, 12];
    (groups.len() == 5
        && groups
            .iter()
            .zip(lengths)
            .all(|(g, n)| g.len() == n && g.chars().all(|c| c.is_ascii_hexdigit())))
    .then_some(raw)
}

/// The arguments `run` gets. Development builds add the two dev flags; a
/// release build never does.
pub fn run_args(layout: &Layout, development: bool) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> = vec![
        "run".into(),
        "--config".into(),
        layout.config.clone().into(),
        "--control-socket".into(),
        layout.socket.clone().into(),
    ];
    if development {
        args.extend([
            "--dev-key-file".into(),
            layout.dev_key.clone().into(),
            "--dev-unsigned-peer".into(),
        ]);
    }
    args
}

fn key_args(layout: &Layout, development: bool) -> Vec<std::ffi::OsString> {
    if development {
        vec!["--dev-key-file".into(), layout.dev_key.clone().into()]
    } else {
        Vec::new()
    }
}

/// The child's whole environment: the few variables workd needs, and PATH so
/// the adapters (Node scripts) find `node`. Nothing else of the app's.
fn child_env() -> Vec<(String, std::ffi::OsString)> {
    let mut env: Vec<(String, std::ffi::OsString)> =
        ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG"]
            .iter()
            .filter_map(|name| std::env::var_os(name).map(|value| (name.to_string(), value)))
            .collect();
    env.push(("PATH".into(), crate::harness_path::current_search_path()));
    env.push(("MOMO_WORKD_LOG".into(), "info".into()));
    env
}

fn read_registered(layout: &Layout) -> Option<Registered> {
    let raw = std::fs::read_to_string(&layout.state).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    let field = |name: &str| value.get(name)?.as_str().map(str::to_string);
    Some(Registered {
        host_id: field("host_id")?,
        workspace_id: field("workspace_id")?,
        owner_member_id: field("owner_member_id")?,
        server_url: field("server_url")?,
    })
}

/// The pid behind a connected Unix socket (macOS `LOCAL_PEERPID`).
fn peer_pid(stream: &UnixStream) -> Option<u32> {
    let mut pid: libc::pid_t = 0;
    let mut length = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
    // SAFETY: a connected AF_UNIX socket and a writable pid_t.
    let status = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            (&mut pid as *mut libc::pid_t).cast(),
            &mut length,
        )
    };
    (status == 0 && pid > 0).then_some(pid as u32)
}

/// One request on the control socket, believed only if the peer is `expected`.
pub fn ask_workd(socket: &Path, expected_pid: u32, op: &str) -> Result<Value, String> {
    let mut stream = UnixStream::connect(socket).map_err(|_| "socket_unavailable".to_string())?;
    if peer_pid(&stream) != Some(expected_pid) {
        return Err("socket_peer_not_our_child".to_string());
    }
    stream.set_read_timeout(Some(SOCKET_TIMEOUT)).ok();
    stream.set_write_timeout(Some(SOCKET_TIMEOUT)).ok();
    stream
        .write_all(format!("{{\"op\":\"{op}\"}}\n").as_bytes())
        .map_err(|_| "socket_write_failed".to_string())?;
    let mut out = String::new();
    stream
        .take(64 * 1024)
        .read_to_string(&mut out)
        .map_err(|_| "socket_read_failed".to_string())?;
    let value: Value =
        serde_json::from_str(out.trim()).map_err(|_| "socket_no_answer".to_string())?;
    if value.get("ok") != Some(&Value::Bool(true)) {
        return Err("socket_refused".to_string());
    }
    Ok(value)
}

fn heartbeat_of(status: &Value) -> Heartbeat {
    Heartbeat {
        last_ok_at_ms: status["heartbeat"]["lastOkAtMs"].as_i64(),
        failing: status["heartbeat"]["failing"].as_bool().unwrap_or(true),
    }
}

fn host_name() -> String {
    let mut buffer = [0u8; 256];
    // SAFETY: a writable buffer of the stated length.
    let status = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) };
    if status != 0 {
        return "Mac".to_string();
    }
    let end = buffer.iter().position(|b| *b == 0).unwrap_or(buffer.len());
    let name = String::from_utf8_lossy(&buffer[..end]).to_string();
    let name = name.trim_end_matches(".local").trim();
    if name.is_empty() {
        "Mac".to_string()
    } else {
        name.chars().take(80).collect()
    }
}

// ---- the service -------------------------------------------------------------

pub struct Service<'a> {
    pub layout: Layout,
    pub sidecar: Option<PathBuf>,
    pub development: bool,
    pub state: &'a WorkHostState,
}

impl Service<'_> {
    pub fn status(&self) -> LocalStatus {
        let running_pid = self.state.running_pid();
        let heartbeat = running_pid
            .and_then(|pid| ask_workd(&self.layout.socket, pid, "status").ok())
            .map(|status| heartbeat_of(&status));
        LocalStatus {
            sidecar: self.sidecar.is_some(),
            registered: read_registered(&self.layout),
            running: running_pid.is_some(),
            heartbeat,
            adapters: find_adapters(&crate::harness_path::current_search_path()),
            work_folder: self.layout.work_folder.display().to_string(),
            display_name_suggestion: host_name(),
        }
    }

    fn sidecar(&self) -> Result<&Path, String> {
        self.sidecar
            .as_deref()
            .ok_or_else(|| "sidecar_missing".to_string())
    }

    pub fn register(&self, request: RegisterRequest) -> Result<LocalStatus, String> {
        let sidecar = self.sidecar()?.to_path_buf();
        if read_registered(&self.layout).is_some() {
            return Err("already_registered".to_string());
        }
        let adapters = find_adapters(&crate::harness_path::current_search_path());
        let config = build_config(
            &self.layout,
            &request.server_url,
            &request.workspace_id,
            &request.display_name,
            &adapters,
        )?;
        if request.access_token.trim().is_empty() {
            return Err("not_signed_in".to_string());
        }
        self.layout.ensure_root()?;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&self.layout.work_folder)
            .map_err(|error| format!("work folder: {error}"))?;
        write_private(
            &self.layout.config,
            &serde_json::to_vec_pretty(&config).expect("config serializes"),
        )?;

        let mut command = Command::new(&sidecar);
        command
            .arg("register")
            .arg("--config")
            .arg(&self.layout.config)
            .args(key_args(&self.layout, self.development))
            .env_clear()
            .envs(child_env())
            .env("MOMO_WORKD_REGISTER_TOKEN", request.access_token.trim())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let output = run_with_timeout(command, REGISTER_TIMEOUT)?;
        if !output.0 {
            // The last line of workd's stderr: it never carries the token
            // (workd_conformance_pg `register`), and it says why.
            let reason = output
                .2
                .lines()
                .rev()
                .find(|line| !line.trim().is_empty())
                .unwrap_or("register failed")
                .chars()
                .take(300)
                .collect::<String>();
            return Err(format!("register_failed: {reason}"));
        }
        self.start()?;
        Ok(self.status())
    }

    pub fn start(&self) -> Result<(), String> {
        let sidecar = self.sidecar()?.to_path_buf();
        if read_registered(&self.layout).is_none() {
            return Err("not_registered".to_string());
        }
        if self.state.running_pid().is_some() {
            return Ok(());
        }
        self.layout.ensure_root()?;
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(&self.layout.log)
            .map_err(|error| format!("workd log: {error}"))?;
        let child = Command::new(&sidecar)
            .args(run_args(&self.layout, self.development))
            .env_clear()
            .envs(child_env())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(log)
            .spawn()
            .map_err(|error| format!("start_failed: {error}"))?;
        *self.state.lock() = Some(child);
        Ok(())
    }

    pub fn stop(&self) {
        if let Some(pid) = self.state.running_pid() {
            let _ = ask_workd(&self.layout.socket, pid, "shutdown");
            let deadline = Instant::now() + STOP_TIMEOUT;
            while Instant::now() < deadline && self.state.running_pid().is_some() {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        self.state.stop_now();
    }

    pub fn forget(&self) -> Result<LocalStatus, String> {
        self.stop();
        if self.layout.config.exists() {
            let sidecar = self.sidecar()?.to_path_buf();
            let mut command = Command::new(&sidecar);
            command
                .arg("forget")
                .arg("--config")
                .arg(&self.layout.config)
                .args(key_args(&self.layout, self.development))
                .env_clear()
                .envs(child_env())
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped());
            let output = run_with_timeout(command, REGISTER_TIMEOUT)?;
            if !output.0 {
                return Err("forget_failed".to_string());
            }
            std::fs::remove_file(&self.layout.config)
                .map_err(|error| format!("config: {error}"))?;
        }
        Ok(self.status())
    }
}

/// A new 0600 file (replacing an old one), written through a sibling.
fn write_private(path: &Path, body: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let _ = std::fs::remove_file(&temporary);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|error| format!("config: {error}"))?;
    file.write_all(body)
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("config: {error}"))?;
    std::fs::rename(&temporary, path).map_err(|error| format!("config: {error}"))
}

/// (success, stdout, stderr), killing the child past `timeout`.
fn run_with_timeout(
    mut command: Command,
    timeout: Duration,
) -> Result<(bool, String, String), String> {
    let mut child = command
        .spawn()
        .map_err(|error| format!("start_failed: {error}"))?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = String::new();
                let mut stderr = String::new();
                if let Some(mut out) = child.stdout.take() {
                    let _ = out.read_to_string(&mut stdout);
                }
                if let Some(mut err) = child.stderr.take() {
                    let _ = err.read_to_string(&mut stderr);
                }
                return Ok((status.success(), stdout, stderr));
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("timeout".to_string());
            }
        }
    }
}

// ---- commands -----------------------------------------------------------------

fn service<'a>(app: &tauri::AppHandle, state: &'a WorkHostState) -> Result<Service<'a>, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("app data folder: {error}"))?;
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|home| home.is_absolute())
        .ok_or_else(|| "no_home".to_string())?;
    Ok(Service {
        layout: Layout::new(&app_data, &home),
        sidecar: sidecar_path(),
        development: cfg!(debug_assertions),
        state,
    })
}

async fn blocking<T: Send + 'static>(
    app: tauri::AppHandle,
    work: impl FnOnce(&Service<'_>) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WorkHostState>();
        let service = service(&app, &state)?;
        work(&service)
    })
    .await
    .map_err(|error| format!("task: {error}"))?
}

#[tauri::command]
pub async fn work_host_status(app: tauri::AppHandle) -> Result<LocalStatus, String> {
    blocking(app, |service| Ok(service.status())).await
}

#[tauri::command]
pub async fn work_host_register(
    app: tauri::AppHandle,
    request: RegisterRequest,
) -> Result<LocalStatus, String> {
    blocking(app, move |service| service.register(request)).await
}

#[tauri::command]
pub async fn work_host_start(app: tauri::AppHandle) -> Result<LocalStatus, String> {
    blocking(app, |service| {
        service.start()?;
        Ok(service.status())
    })
    .await
}

#[tauri::command]
pub async fn work_host_stop(app: tauri::AppHandle) -> Result<LocalStatus, String> {
    blocking(app, |service| {
        service.stop();
        Ok(service.status())
    })
    .await
}

#[tauri::command]
pub async fn work_host_forget(app: tauri::AppHandle) -> Result<LocalStatus, String> {
    blocking(app, |service| service.forget()).await
}

/// At launch: a registered host starts with the app (ADR-0188 D2 첫 단계).
pub fn start_if_registered(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WorkHostState>();
        if let Ok(service) = service(&app, &state) {
            if read_registered(&service.layout).is_some() && service.sidecar.is_some() {
                let _ = service.start();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout(dir: &Path) -> Layout {
        Layout::new(&dir.join("data"), &dir.join("home"))
    }

    fn found(key: &str) -> AdapterFound {
        AdapterFound {
            key: key.into(),
            executable: format!("/opt/bin/{key}-acp"),
            found: true,
        }
    }

    #[test]
    fn a_release_build_never_passes_the_dev_flags() {
        let layout = layout(Path::new("/x"));
        let release: Vec<String> = run_args(&layout, false)
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            release,
            [
                "run",
                "--config",
                "/x/data/work-host/workd.json",
                "--control-socket",
                "/x/data/work-host/workd.sock"
            ]
        );
        assert!(key_args(&layout, false).is_empty());
        let development: Vec<String> = run_args(&layout, true)
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(development.contains(&"--dev-unsigned-peer".to_string()));
        assert!(development.contains(&"--dev-key-file".to_string()));
    }

    #[test]
    fn the_token_is_never_an_argument_or_in_the_config() {
        let layout = layout(Path::new("/x"));
        let config = build_config(
            &layout,
            "https://team.example",
            "0F8FAD5B-D9CB-469F-A165-70867728950E",
            "성재의 맥",
            &[found("claude")],
        )
        .unwrap();
        let text = config.to_string();
        assert!(!text.contains("token"), "{text}");
        assert_eq!(config["server_url"], "https://team.example");
        assert_eq!(
            config["workspace_id"],
            "0f8fad5b-d9cb-469f-a165-70867728950e"
        );
        assert_eq!(config["tools"]["claude"]["adapter"], "claude");
        assert!(
            config["tools"].get("codex").is_none(),
            "not found → not allowed"
        );
        assert_eq!(config["working_directory"], "/x/home/oort-work");
        // The token goes to the child's env only: nothing in this module
        // builds an argument out of it.
        let src = include_str!("work_host.rs");
        let code = &src[..src.find("#[cfg(test)]").unwrap()];
        assert_eq!(
            code.matches("access_token").count(),
            3,
            "the field, the empty check, the child env"
        );
        assert!(code.contains(".env(\"MOMO_WORKD_REGISTER_TOKEN\", request.access_token.trim())"));
        assert!(!code.contains(".arg(request.access_token"));
    }

    #[test]
    fn config_inputs_are_checked_before_any_child_runs() {
        let layout = layout(Path::new("/x"));
        let ok = |url: &str, ws: &str, name: &str, adapters: &[AdapterFound]| {
            build_config(&layout, url, ws, name, adapters)
        };
        let ws = "0f8fad5b-d9cb-469f-a165-70867728950e";
        assert_eq!(
            ok("https://t.example", ws, "m", &[]).unwrap_err(),
            "no_acp_adapter"
        );
        for url in [
            "http://team.example",
            "https://t.example/path",
            "https://u:p@t.example",
            "ftp://t.example",
            "not a url",
        ] {
            assert_eq!(
                ok(url, ws, "m", &[found("claude")]).unwrap_err(),
                "server_url_invalid",
                "{url}"
            );
        }
        assert!(ok("http://127.0.0.1:8080", ws, "m", &[found("claude")]).is_ok());
        assert_eq!(
            ok("https://t.example", "nope", "m", &[found("claude")]).unwrap_err(),
            "workspace_id_invalid"
        );
        assert_eq!(
            ok("https://t.example", ws, "  ", &[found("claude")]).unwrap_err(),
            "display_name_invalid"
        );
    }

    #[test]
    fn only_a_mach_o_counts_as_the_sidecar() {
        let dir = std::env::temp_dir().join(format!("wh-macho-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("placeholder");
        std::fs::write(&script, "#!/bin/sh\nexit 78\n").unwrap();
        assert!(!is_mach_o(&script));
        assert!(!is_mach_o(&dir.join("missing")));
        assert!(is_mach_o(&std::env::current_exe().unwrap()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The app believes the socket only when its peer is the child it
    /// started: a process squatting on the path is refused.
    #[test]
    fn a_socket_whose_peer_is_not_our_child_is_not_believed() {
        let dir = PathBuf::from(format!("/tmp/wh-sock-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("workd.sock");
        let _ = std::fs::remove_file(&socket);
        let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        let server = std::thread::spawn(move || {
            for stream in listener.incoming().take(2) {
                let mut stream = stream.unwrap();
                let mut line = String::new();
                let _ =
                    std::io::BufRead::read_line(&mut std::io::BufReader::new(&stream), &mut line);
                let _ = stream.write_all(
                    b"{\"ok\":true,\"heartbeat\":{\"lastOkAtMs\":1,\"failing\":false}}\n",
                );
            }
        });
        // The squatter here is this very process, not a child we started.
        let impostor_pid = std::process::id() + 1;
        assert_eq!(
            ask_workd(&socket, impostor_pid, "status").unwrap_err(),
            "socket_peer_not_our_child"
        );
        let answer = ask_workd(&socket, std::process::id(), "status").unwrap();
        assert!(!heartbeat_of(&answer).failing);
        drop(UnixStream::connect(&socket));
        let _ = server.join();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_registration_state_is_read_without_its_key() {
        let dir = std::env::temp_dir().join(format!("wh-state-{}", std::process::id()));
        let layout = layout(&dir);
        std::fs::create_dir_all(layout.state.parent().unwrap()).unwrap();
        std::fs::write(
            &layout.state,
            r#"{"server_url":"https://t.example","workspace_id":"w","host_id":"h","owner_member_id":"o","public_key":"PK","scope":"member"}"#,
        )
        .unwrap();
        let registered = read_registered(&layout).unwrap();
        assert_eq!(registered.host_id, "h");
        assert!(!serde_json::to_string(&registered).unwrap().contains("PK"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The real sidecar as the app's child: start → the control socket answers
    /// the app (peer pid = our child) → stop → forget deletes key, state and
    /// config. Needs the momo-workd binary:
    ///
    /// ```text
    /// cargo build -p momo-workd --manifest-path server-rust/Cargo.toml
    /// MOMO_WORKD_BIN=$PWD/server-rust/target/debug/momo-workd \
    ///   cargo test --manifest-path clients/desktop/src-tauri/Cargo.toml \
    ///   work_host::tests::the_real_sidecar -- --ignored
    /// ```
    #[test]
    #[ignore = "needs MOMO_WORKD_BIN (a built momo-workd)"]
    fn the_real_sidecar_starts_answers_its_parent_and_is_forgotten() {
        let bin = PathBuf::from(std::env::var_os("MOMO_WORKD_BIN").expect("MOMO_WORKD_BIN"));
        assert!(is_mach_o(&bin), "MOMO_WORKD_BIN is a Mach-O");
        let dir = PathBuf::from(format!("/tmp/wh-e2e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let layout = layout(&dir);
        layout.ensure_root().unwrap();
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&layout.work_folder)
            .unwrap();
        // A registration as `register` would leave it (no server here: the
        // heartbeat fails, which the status reports).
        let config = build_config(
            &layout,
            "http://127.0.0.1:9",
            "00000000-0000-0000-0000-00000000000c",
            "e2e",
            &[AdapterFound {
                key: "claude".into(),
                executable: "/usr/bin/true".into(),
                found: true,
            }],
        )
        .unwrap();
        write_private(&layout.config, config.to_string().as_bytes()).unwrap();
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(layout.dev_key.parent().unwrap())
            .unwrap();
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(layout.state.parent().unwrap())
            .unwrap();
        // workd's dev key file: the base64 seed, 0600. Seed [7; 32] and its
        // Ed25519 public key (RFC 8032 derivation, precomputed).
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&layout.dev_key)
            .unwrap()
            .write_all(b"BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=\n")
            .unwrap();
        let state = WorkHostState::default();
        let service = Service {
            layout: layout.clone(),
            sidecar: Some(bin),
            development: true,
            state: &state,
        };
        assert_eq!(service.start().unwrap_err(), "not_registered");
        let public_key = "6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=";
        write_private(
            &layout.state,
            json!({
                "server_url": "http://127.0.0.1:9",
                "workspace_id": "00000000-0000-0000-0000-00000000000c",
                "host_id": "00000000-0000-0000-0000-00000000000b",
                "owner_member_id": "00000000-0000-0000-0000-00000000000d",
                "public_key": public_key,
                "scope": "member",
            })
            .to_string()
            .as_bytes(),
        )
        .unwrap();
        service.start().unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut status = service.status();
        while status.heartbeat.is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
            status = service.status();
        }
        let log = std::fs::read_to_string(&layout.log).unwrap_or_default();
        assert!(status.running, "{log}");
        assert_eq!(
            status.registered.as_ref().map(|r| r.host_id.as_str()),
            Some("00000000-0000-0000-0000-00000000000b")
        );
        let heartbeat = status
            .heartbeat
            .expect("workd answered its parent on the socket");
        assert!(heartbeat.failing, "no server behind 127.0.0.1:9");
        service.stop();
        assert!(!service.status().running);
        assert!(!layout.socket.exists(), "workd removed its socket");
        let after = service.forget().unwrap();
        assert!(after.registered.is_none());
        assert!(!layout.dev_key.exists() && !layout.state.exists() && !layout.config.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
