// This Mac as a work host (ADR-0188 D2 · R1, #2778).
//
// The app carries `momo-workd` in a helper bundle,
// `Contents/Helpers/momo-workd.app` (`tauri.conf.json > bundle > macOS >
// files`, #3084), and starts its executable as its child. The helper has its
// own App ID and provisioning profile so a signed workd can hold the
// keychain-access-groups entitlement its data-protection host key needs,
// apart from this app's device-key group (ADR-0146 D-3). Five commands, all for the main webview's bundled
// origin only (`capabilities/work-host.json`):
//
//   work_host_status    what this Mac is: sidecar present, registered as which
//                       host, running, the heartbeat's last outcome, which ACP
//                       adapters were found
//   work_host_register  write the host config, `momo-workd register --token-stdin`
//                       with the owner's access token on the CHILD'S STDIN (never
//                       argv, env, a file or a log line), then start
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

/// The sidecar's executable name (`CFBundleExecutable` of the helper bundle).
pub const SIDECAR_NAME: &str = "momo-workd";

/// The helper bundle, relative to the app's `Contents` folder
/// (`scripts/desktop/build_workd_sidecar.sh` builds it).
pub const HELPER_BUNDLE: &str = "Helpers/momo-workd.app";

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

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterRequest {
    pub server_url: String,
    pub workspace_id: String,
    pub display_name: String,
    /// The owner's access token. Handed to the child's environment for the one
    /// `register` request and dropped.
    pub access_token: String,
}

/// Never prints the token (#2778 security review M3).
impl std::fmt::Debug for RegisterRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RegisterRequest")
            .field("server_url", &self.server_url)
            .field("workspace_id", &self.workspace_id)
            .field("display_name", &self.display_name)
            .field("access_token", &"<redacted>")
            .finish()
    }
}

impl std::fmt::Debug for WorkHostState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("WorkHostState")
    }
}

/// The running child, if any, and the one-registration-at-a-time lock (two
/// concurrent registers would both pass `already_registered`; security L5).
#[derive(Default)]
pub struct WorkHostState {
    child: Mutex<Option<Child>>,
    registering: Mutex<()>,
}

impl WorkHostState {
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Child>> {
        self.child
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

/// `momo-workd` inside this app's helper bundle. A debug build that runs
/// outside a bundle (`cargo tauri dev`) may name a built binary with
/// `MOMO_WORKD_BIN`; a release build never reads that variable.
pub fn sidecar_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let path = helper_executable(&exe)?;
    if is_mach_o(&path) {
        return Some(path);
    }
    if cfg!(debug_assertions) {
        let dev = PathBuf::from(std::env::var_os("MOMO_WORKD_BIN")?);
        return (dev.is_absolute() && is_mach_o(&dev)).then_some(dev);
    }
    None
}

/// `<app>/Contents/Helpers/momo-workd.app/Contents/MacOS/momo-workd` for the
/// app executable `<app>/Contents/MacOS/<exe>`.
pub fn helper_executable(exe: &Path) -> Option<PathBuf> {
    let contents = exe.parent()?.parent()?;
    Some(
        contents
            .join(HELPER_BUNDLE)
            .join("Contents/MacOS")
            .join(SIDECAR_NAME),
    )
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
    // Plain http to loopback is a development server only: in a release build
    // another local user could listen there and take the owner's token
    // (#2778 security review L1).
    let scheme_ok =
        url.scheme() == "https" || (url.scheme() == "http" && loopback && cfg!(debug_assertions));
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
    ask_workd_request(socket, expected_pid, &json!({ "op": op })).map_err(|error| match error {
        WorkdError::Refused(_) => "socket_refused".to_string(),
        WorkdError::Socket(code) => code,
    })
}

/// Why a control-socket request failed: the socket itself, or workd's own
/// `{"ok":false,"error":…}` (R2 needs the reason: `root_already_pinned`,
/// `revocation_signature_invalid`, …).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkdError {
    Socket(String),
    Refused(String),
}

impl WorkdError {
    pub fn code(&self) -> String {
        match self {
            WorkdError::Socket(code) => code.clone(),
            WorkdError::Refused(code) => format!("workd_refused: {code}"),
        }
    }
}

/// One JSON request on the control socket (ADR-0146 개정 D-6·D-7 `pin_root`,
/// `revoke_device`), believed only if the peer is `expected`.
pub fn ask_workd_request(
    socket: &Path,
    expected_pid: u32,
    request: &Value,
) -> Result<Value, WorkdError> {
    let socket_error = |code: &str| WorkdError::Socket(code.to_string());
    let mut stream = UnixStream::connect(socket).map_err(|_| socket_error("socket_unavailable"))?;
    if peer_pid(&stream) != Some(expected_pid) {
        return Err(socket_error("socket_peer_not_our_child"));
    }
    stream.set_read_timeout(Some(SOCKET_TIMEOUT)).ok();
    stream.set_write_timeout(Some(SOCKET_TIMEOUT)).ok();
    let mut line = serde_json::to_vec(request).map_err(|_| socket_error("socket_write_failed"))?;
    line.push(b'\n');
    stream
        .write_all(&line)
        .map_err(|_| socket_error("socket_write_failed"))?;
    let mut out = String::new();
    stream
        .take(64 * 1024)
        .read_to_string(&mut out)
        .map_err(|_| socket_error("socket_read_failed"))?;
    let value: Value =
        serde_json::from_str(out.trim()).map_err(|_| socket_error("socket_no_answer"))?;
    if value.get("ok") != Some(&Value::Bool(true)) {
        let reason = value
            .get("error")
            .and_then(Value::as_str)
            .filter(|code| {
                !code.is_empty()
                    && code.len() <= 64
                    && code.chars().all(|c| c.is_ascii_lowercase() || c == '_')
            })
            .unwrap_or("unknown");
        return Err(WorkdError::Refused(reason.to_string()));
    }
    Ok(value)
}

/// What the running workd says about R2 trust (`status.humanSignatures`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostTrust {
    pub host_id: String,
    pub workspace_id: String,
    pub owner_member_id: String,
    /// `None`: nothing pinned yet (or a workd from before #3024).
    pub root_key_id: Option<String>,
    /// The pinned root's public key (#3078). `None`: nothing pinned, or a
    /// workd from before #3078 (then only the id can be compared).
    pub root_public_key: Option<String>,
}

pub fn host_trust_of(status: &Value) -> Option<HostTrust> {
    let field = |name: &str| status.get(name)?.as_str().map(str::to_string);
    Some(HostTrust {
        host_id: field("hostId")?,
        workspace_id: field("workspaceId")?,
        owner_member_id: field("ownerMemberId")?,
        root_key_id: status["humanSignatures"]["rootKeyId"]
            .as_str()
            .map(str::to_string),
        root_public_key: status["humanSignatures"]["rootPublicKey"]
            .as_str()
            .map(str::to_string),
    })
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

    /// The running workd's R2 view, or `None` when it is not running.
    pub fn host_trust(&self) -> Result<Option<HostTrust>, WorkdError> {
        let Some(pid) = self.state.running_pid() else {
            return Ok(None);
        };
        let status = ask_workd_request(&self.layout.socket, pid, &json!({ "op": "status" }))?;
        Ok(host_trust_of(&status))
    }

    /// `pin_root` (ADR-0146 D-6 ①): the root's public half, once. `Ok(true)`
    /// pinned now, `Ok(false)` the same key was already pinned.
    pub fn pin_root(&self, key_id: &str, public_key: &str) -> Result<bool, WorkdError> {
        let pid = self
            .state
            .running_pid()
            .ok_or_else(|| WorkdError::Socket("not_running".into()))?;
        let answer = ask_workd_request(
            &self.layout.socket,
            pid,
            &json!({ "op": "pin_root", "keyId": key_id, "alg": "p256", "publicKey": public_key }),
        )?;
        Ok(answer.get("pinned") == Some(&Value::Bool(true)))
    }

    /// `revoke_device` (ADR-0146 D-7): a root-signed letter, straight to the
    /// host — the server cannot hide it.
    pub fn revoke_device(&self, revocation: &Value) -> Result<(), WorkdError> {
        let pid = self
            .state
            .running_pid()
            .ok_or_else(|| WorkdError::Socket("not_running".into()))?;
        ask_workd_request(
            &self.layout.socket,
            pid,
            &json!({ "op": "revoke_device", "revocation": revocation }),
        )
        .map(|_| ())
    }

    /// Where this Mac is registered, if it is.
    pub fn registered(&self) -> Option<Registered> {
        read_registered(&self.layout)
    }

    fn sidecar(&self) -> Result<&Path, String> {
        self.sidecar
            .as_deref()
            .ok_or_else(|| "sidecar_missing".to_string())
    }

    pub fn register(&self, request: RegisterRequest) -> Result<LocalStatus, String> {
        let sidecar = self.sidecar()?.to_path_buf();
        let _one_at_a_time = self
            .state
            .registering
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
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
            .arg("--token-stdin")
            .arg("--config")
            .arg(&self.layout.config)
            .args(key_args(&self.layout, self.development))
            .env_clear()
            .envs(child_env())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // The token crosses a pipe, not the child's environment: another
        // same-user process can read a running child's environment (#2778
        // security review M3), not its stdin.
        let output =
            run_with_timeout(command, REGISTER_TIMEOUT, Some(request.access_token.trim()))?;
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
            let output = run_with_timeout(command, REGISTER_TIMEOUT, None)?;
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
    stdin_line: Option<&str>,
) -> Result<(bool, String, String), String> {
    let mut child = command
        .spawn()
        .map_err(|error| format!("start_failed: {error}"))?;
    if let Some(line) = stdin_line {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(format!("{line}\n").as_bytes());
            // Dropped here: EOF after the one line.
        }
    }
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

pub(crate) fn service<'a>(
    app: &tauri::AppHandle,
    state: &'a WorkHostState,
) -> Result<Service<'a>, String> {
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
    let status = blocking(app.clone(), move |service| service.register(request)).await?;
    // Registration starts the host; pin a root bound before it existed (#3025).
    crate::device_key::pin_after_start(&app);
    Ok(status)
}

#[tauri::command]
pub async fn work_host_start(app: tauri::AppHandle) -> Result<LocalStatus, String> {
    let status = blocking(app.clone(), |service| {
        service.start()?;
        Ok(service.status())
    })
    .await?;
    // R2 (#3025): a root bound before this host existed is pinned now.
    crate::device_key::pin_after_start(&app);
    Ok(status)
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
            if read_registered(&service.layout).is_some()
                && service.sidecar.is_some()
                && service.start().is_ok()
            {
                crate::device_key::pin_after_start(&app);
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
        // The token goes to the child's stdin only: never an argument, never
        // the child's environment, never Debug output.
        let src = include_str!("work_host.rs");
        let code = &src[..src.find("#[cfg(test)]").unwrap()];
        assert_eq!(
            code.matches("request.access_token").count(),
            2,
            "the empty check and the stdin line"
        );
        assert!(code.contains("Some(request.access_token.trim())"));
        assert!(code.contains(".arg(\"--token-stdin\")"));
        assert!(!code.contains("MOMO_WORKD_REGISTER_TOKEN"));
        let request = RegisterRequest {
            server_url: "https://t.example".into(),
            workspace_id: "w".into(),
            display_name: "n".into(),
            access_token: "secret-token-value".into(),
        };
        assert!(!format!("{request:?}").contains("secret-token-value"));
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
