// Sign-in -> agent registration, the app's part (#3389 AIH-5, ADR-0190 D3-h /
// D3-i, ADR-0193 D15-D16).
//
// After the official CLI signed the person in, the web layer registered an
// `owner_only` agent on the server (ADR-0193 D15) and got a one-time
// connection value. This module hands that value to the official CLI **without
// ever putting it in an argument, an environment variable or a log**, and runs
// the one CLI command that wires the CLI to the Agent Port.
//
//   agent_port_device                -> { deviceId, deviceLabel }
//   agent_port_connect               -> { outcome: "connected" } | { outcome: "manual", reason }
//   agent_port_replace_credential    -> boolean   (the ADR-0193 D16 swap, no CLI call)
//   agent_port_disconnect            -> boolean
//   agent_port_retire_legacy         -> { outcome, removedMcp }   (#3567, once per Mac)
//
// #3567 (ADR-0198 증보 1 D2): the app no longer registers subscription agents.
// Sign-in stops at "connected" (the web build flag, `SUBSCRIPTION_REGISTER_BUILD_FLAG`),
// so `agent_port_connect` has no caller. A Mac the old app registered still holds
// an `oort` entry in the CLI and a store entry marked `added`; `retire_legacy`
// removes both exactly once (see its docs). Nothing else here changed.
//
// The boundary (ADR-0190 D3-h, D3-i):
//
// 1. **Exactly two commands.** `REGISTER_COMMANDS` is the whole allowlist:
//    `claude mcp add-json --scope user oort <JSON>` and
//    `claude mcp remove --scope user oort`. Program and fixed arguments are
//    literals; the JSON is built here from validated fields; the webview
//    names a harness and data fields, never an argument. This list is separate
//    from the login-status list, `pty.rs` login rows and the git
//    reads, each of which counts itself. Codex is not on it: its `mcp add`
//    cannot take the value safely and rewrites the whole user config
//    (ADR-0190 D3-h), so it stays the manual two-field path.
// 2. **The value is never in argv.** The JSON carries
//    `headersHelper = "<this app's executable> <agent id>"`. When the CLI
//    connects it runs that helper, which reads the value from the app's own
//    store and prints `{"Authorization":"Bearer ..."}`. `main.rs` calls
//    `run_header_helper` before anything of the app starts, the same way the
//    pane hook client works. The CLI's own settings never contain the value.
// 3. **The store.** One file per agent in `~/Library/Application Support/oort/
//    agent-port/` (folder 0700, file 0600, replaced by rename). The keychain
//    is not used here: the helper is a separate process the CLI starts, and a
//    keychain item is bound to the signature of the binary that wrote it; a
//    differently signed reader raises a password dialog the person cannot
//    connect to anything (see `keychain.rs`). Same exposure class as the CLI
//    keeping a header in its own settings, and no worse (ADR-0190 D3-h).
// 4. **Exit code only.** stdin, stdout and stderr of the CLI are
//    `Stdio::null()`. Nothing the CLI prints is read, so nothing it prints can
//    reach the webview or a log. The argument vector is never logged either.
// 5. **Closed on failure.** A non-zero exit, a refused endpoint, a helper path
//    the rules do not allow, no CLI on this Mac or a store that cannot be
//    written all end in `manual`: the webview then shows the person the manual
//    path. There is no second attempt that puts the value in argv.
// 6. **`remove` only for what the app added.** The store entry carries
//    `added: true` once `add-json` exited 0. Without it, `agent_port_disconnect`
//    only deletes its own entry; it never runs `mcp remove`, so an `oort` entry
//    the person added by hand is left alone.
//
// This crate never opens the CLI's own settings or credential files (ADR-0190
// D3-b); the CLI changes its own configuration.

use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::harness_path;

/// The MCP server name the CLI lists (ADR-0190 D3-h; `AGENT_PORT_MCP_NAME` in
/// momo-core). One CLI setting, one name: one agent at a time goes this way.
pub const MCP_NAME: &str = "oort";
/// The only path an Agent Port address may have (momo-core `agentPortEndpoint`).
pub const ENDPOINT_PATH: &str = "/v1/mcp/agent-port";

/// One allowlisted CLI command: program, fixed arguments, and whether the one
/// built JSON argument follows them.
#[derive(Debug, PartialEq, Eq)]
pub struct RegisterCommand {
    pub id: &'static str,
    pub program: &'static str,
    pub args: &'static [&'static str],
    pub takes_json: bool,
}

/// The complete allowlist (ADR-0190 D3-h / D3-i): exactly two rows.
pub const REGISTER_COMMANDS: &[RegisterCommand] = &[
    RegisterCommand {
        id: "add",
        program: "claude",
        args: &["mcp", "add-json", "--scope", "user", MCP_NAME],
        takes_json: true,
    },
    RegisterCommand {
        id: "remove",
        program: "claude",
        args: &["mcp", "remove", "--scope", "user", MCP_NAME],
        takes_json: false,
    },
];

/// Upper bound for one CLI command (a cold Node start is about a second).
pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);
const POLL_EVERY: Duration = Duration::from_millis(25);

/// Why the app did not run (or could not finish) the CLI step. The webview
/// answers every one of them with the manual path and a calm sentence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManualReason {
    /// Not Claude Code (Codex has no safe command), or no desktop support.
    UnsupportedHarness,
    UnsupportedPlatform,
    /// Only `https`, or `http` on a loopback host, may receive the value.
    EndpointNotAllowed,
    /// The helper path breaks the rules in ADR-0190 D3-h.
    HelperPathNotAllowed,
    CliMissing,
    /// Non-zero exit (for example an `oort` entry already exists), did not
    /// run, or did not finish in time.
    CliFailed,
    StoreFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum ConnectOutcome {
    Connected,
    Manual { reason: ManualReason },
}

// No `Debug`: this carries the connection value, and a stray `{:?}` in a log
// line must not be able to print it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectRequest {
    pub harness: String,
    pub endpoint: String,
    pub agent_id: String,
    pub credential: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplaceRequest {
    pub agent_id: String,
    pub credential: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisconnectRequest {
    pub agent_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub device_id: String,
    pub device_label: Option<String>,
}

// ---------------------------------------------------------------------------
// Validation (pure)
// ---------------------------------------------------------------------------

/// A lowercase UUID: the agent member id, a selector and not a secret.
pub fn is_agent_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(byte),
        })
}

/// The connection value's alphabet (momo-core `COMMAND_SAFE_TOKEN`) and size.
pub fn is_connection_value(value: &str) -> bool {
    (16..=512).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._~-+/=".contains(&b))
}

/// The Agent Port address the CLI may be pointed at: `https`, or `http` on a
/// loopback host (the helper sends `Authorization: Bearer` in the clear
/// otherwise); no account part, query or fragment; exactly [`ENDPOINT_PATH`].
pub fn allowed_endpoint(value: &str) -> Option<String> {
    let url = url::Url::parse(value).ok()?;
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    if url.query().is_some() || url.fragment().is_some() || url.path() != ENDPOINT_PATH {
        return None;
    }
    let loopback = match url.host()? {
        url::Host::Domain(name) => name == "localhost",
        url::Host::Ipv4(address) => address.is_loopback(),
        url::Host::Ipv6(address) => address.is_loopback(),
    };
    match url.scheme() {
        "https" => {}
        "http" if loopback => {}
        _ => return None,
    }
    Some(url.to_string())
}

/// Characters a helper path may contain. The CLI may read the string as a
/// shell command, so a space, quote, `$` or backtick has no place in it.
pub fn helper_path_chars_ok(path: &Path) -> bool {
    let Some(text) = path.to_str() else {
        return false;
    };
    text.starts_with('/')
        && !text.contains("/../")
        && !text.ends_with("/..")
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/._-".contains(&b))
}

/// Where the helper may live (ADR-0190 D3-h): inside an application bundle
/// (`<name>.app/Contents/MacOS/<exe>`) none of whose folders another account
/// can write into, or directly in a folder this account owns with mode 0700.
#[cfg(unix)]
pub fn helper_location_ok(path: &Path, uid: u32) -> bool {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    if !helper_path_chars_ok(path) {
        return false;
    }
    let Ok(file) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if !file.is_file() || file.permissions().mode() & 0o022 != 0 {
        return false;
    }
    let text = path.to_string_lossy();
    let in_bundle = text.contains(".app/Contents/MacOS/");
    if in_bundle {
        // Every folder from the root to the file: not writable by group or
        // others unless sticky (`/tmp`-like) is irrelevant here, so refuse any
        // world-writable folder; group-writable system folders owned by root
        // (`/Applications`) are the normal install place.
        let mut folder = path.parent();
        while let Some(dir) = folder {
            let Ok(meta) = std::fs::symlink_metadata(dir) else {
                return false;
            };
            if !meta.is_dir() {
                return false;
            }
            let mode = meta.permissions().mode();
            if mode & 0o002 != 0 {
                return false;
            }
            if mode & 0o020 != 0 && meta.uid() != 0 && meta.uid() != uid {
                return false;
            }
            folder = dir.parent();
        }
        return true;
    }
    let Some(parent) = path.parent() else {
        return false;
    };
    match std::fs::symlink_metadata(parent) {
        Ok(meta) => {
            meta.is_dir() && meta.uid() == uid && meta.permissions().mode() & 0o777 == 0o700
        }
        Err(_) => false,
    }
}

#[cfg(not(unix))]
pub fn helper_location_ok(_path: &Path, _uid: u32) -> bool {
    false
}

/// The one JSON argument of `add-json` (ADR-0190 D3-h). No secret in it.
pub fn build_add_json(endpoint: &str, helper: &Path, agent_id: &str) -> String {
    serde_json::json!({
        "type": "http",
        "url": endpoint,
        "headersHelper": format!("{} {}", helper.display(), agent_id),
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Store (the helper reads it)
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
struct Entry {
    endpoint: String,
    credential: String,
    /// `add-json` exited 0 for this agent: only then may `remove` run.
    added: bool,
}

pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn under_home(home: &Path) -> Store {
        Store {
            dir: home.join("Library/Application Support/oort/agent-port"),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn entry_path(&self, agent_id: &str) -> PathBuf {
        self.dir.join(format!("{agent_id}.entry"))
    }

    #[cfg(unix)]
    fn ensure_dir(&self) -> std::io::Result<()> {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true).mode(0o700);
        builder.create(&self.dir)?;
        std::fs::set_permissions(&self.dir, std::fs::Permissions::from_mode(0o700))
    }

    #[cfg(not(unix))]
    fn ensure_dir(&self) -> std::io::Result<()> {
        Err(std::io::Error::other("unsupported platform"))
    }

    #[cfg(unix)]
    fn write_entry(&self, agent_id: &str, entry: &Entry) -> std::io::Result<()> {
        use std::os::unix::fs::OpenOptionsExt;
        self.ensure_dir()?;
        let target = self.entry_path(agent_id);
        let temp = self.dir.join(format!("{agent_id}.entry.tmp"));
        let body = serde_json::to_vec(entry).map_err(std::io::Error::other)?;
        let result = (|| {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&temp)?;
            file.write_all(&body)?;
            file.sync_all()?;
            std::fs::rename(&temp, &target)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temp);
        }
        result
    }

    #[cfg(not(unix))]
    fn write_entry(&self, _agent_id: &str, _entry: &Entry) -> std::io::Result<()> {
        Err(std::io::Error::other("unsupported platform"))
    }

    fn read_entry(&self, agent_id: &str) -> Option<Entry> {
        let mut text = Vec::new();
        std::fs::File::open(self.entry_path(agent_id))
            .ok()?
            .take(8 * 1024)
            .read_to_end(&mut text)
            .ok()?;
        serde_json::from_slice(&text).ok()
    }

    fn owner_path(&self) -> PathBuf {
        self.dir.join("oort-owner")
    }

    fn write_owner(&self, agent_id: &str) -> std::io::Result<()> {
        self.ensure_dir()?;
        std::fs::write(self.owner_path(), agent_id)
    }

    fn owner(&self) -> Option<String> {
        std::fs::read_to_string(self.owner_path())
            .ok()
            .map(|text| text.trim().to_string())
    }

    fn remove_entry(&self, agent_id: &str) -> bool {
        std::fs::remove_file(self.entry_path(agent_id)).is_ok()
    }

    /// Agent ids that have a store entry (`<uuid>.entry`), sorted.
    fn entry_ids(&self) -> Vec<String> {
        let Ok(read) = std::fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        let mut ids: Vec<String> = read
            .filter_map(|item| item.ok())
            .filter_map(|item| item.file_name().into_string().ok())
            .filter_map(|name| name.strip_suffix(".entry").map(str::to_string))
            .filter(|id| is_agent_id(id))
            .collect();
        ids.sort();
        ids
    }

    fn retired_marker_path(&self) -> PathBuf {
        self.dir.join(RETIRED_MARKER)
    }

    fn retire_attempts_path(&self) -> PathBuf {
        self.dir.join(RETIRE_ATTEMPTS)
    }
}

/// Written once the legacy registration is cleaned: the one-time cleanup never runs again.
const RETIRED_MARKER: &str = "legacy-retired-v1";
/// How many times a failing `mcp remove` is retried (one per launch) before the
/// store entries are dropped anyway. A person who removed the `oort` entry by hand
/// would otherwise be retried for ever.
const RETIRE_ATTEMPTS: &str = "legacy-retire-attempts";
pub const RETIRE_MAX_ATTEMPTS: u32 = 3;

// ---------------------------------------------------------------------------
// The helper the CLI runs (`<app> <agent id>`)
// ---------------------------------------------------------------------------

/// `Some(exit code)` when this process was started as the header helper: its
/// whole argument list is one lowercase agent id. `main.rs` asks before
/// anything of the app starts. Prints one JSON line and nothing else; writes
/// no log and no stderr.
pub fn run_header_helper(args: &[String], home: Option<&Path>) -> Option<i32> {
    let [agent_id] = args else {
        return None;
    };
    if !is_agent_id(agent_id) {
        return None;
    }
    let line = home
        .and_then(|home| Store::under_home(home).read_entry(agent_id))
        .filter(|entry| is_connection_value(&entry.credential))
        .map(|entry| serde_json::json!({ "Authorization": format!("Bearer {}", entry.credential) }))
        .unwrap_or_else(|| serde_json::json!({}));
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
    Some(0)
}

// ---------------------------------------------------------------------------
// Running the CLI
// ---------------------------------------------------------------------------

/// What the connect step needs from the machine. Tests hand in their own.
pub struct Machine<'a> {
    pub home: &'a Path,
    pub search_path: &'a OsString,
    /// This app's own executable (never from the webview).
    pub exe: &'a Path,
    pub uid: u32,
    pub timeout: Duration,
}

fn run_exit_only(
    program: &Path,
    command: &RegisterCommand,
    json: Option<&str>,
    machine: &Machine<'_>,
) -> Option<ExitStatus> {
    if !program.is_absolute() {
        return None;
    }
    let mut cmd = Command::new(program);
    cmd.args(command.args);
    if let (true, Some(json)) = (command.takes_json, json) {
        cmd.arg(json);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env("PATH", machine.search_path)
        .current_dir(machine.home);
    for key in harness_path::STRIPPED_ENV {
        cmd.env_remove(key);
    }
    let mut child = cmd.spawn().ok()?;
    let deadline = Instant::now() + machine.timeout;
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

fn command_row(id: &str) -> &'static RegisterCommand {
    REGISTER_COMMANDS
        .iter()
        .find(|row| row.id == id)
        .expect("allowlisted row")
}

/// Store the value, run `claude mcp add-json`, remember that the app added it.
/// `Err` is a malformed request (a webview bug); everything the machine can
/// cause is an `Ok(Manual { .. })`.
pub fn connect(request: &ConnectRequest, machine: &Machine<'_>) -> Result<ConnectOutcome, String> {
    if !is_agent_id(&request.agent_id) {
        return Err("agentId is not a lowercase UUID".into());
    }
    if !is_connection_value(&request.credential) {
        return Err("credential has an unexpected shape".into());
    }
    if request.harness != "claude" {
        return Ok(ConnectOutcome::Manual {
            reason: ManualReason::UnsupportedHarness,
        });
    }
    if !cfg!(unix) {
        return Ok(ConnectOutcome::Manual {
            reason: ManualReason::UnsupportedPlatform,
        });
    }
    let Some(endpoint) = allowed_endpoint(&request.endpoint) else {
        return Ok(ConnectOutcome::Manual {
            reason: ManualReason::EndpointNotAllowed,
        });
    };
    if !helper_location_ok(machine.exe, machine.uid) {
        return Ok(ConnectOutcome::Manual {
            reason: ManualReason::HelperPathNotAllowed,
        });
    }
    let store = Store::under_home(machine.home);
    let previous = store.read_entry(&request.agent_id);
    // This agent is already wired (a repeat registration minted a fresh pairing
    // value): the CLI's setting names the helper, not the value, so swapping
    // the stored value is the whole step. No second `add-json`.
    if let Some(entry) = previous.as_ref().filter(|entry| entry.added) {
        // The CLI setting names the endpoint it was added with; a different
        // address needs the person's hands, not a silent swap.
        if entry.endpoint != endpoint {
            return Ok(ConnectOutcome::Manual {
                reason: ManualReason::CliFailed,
            });
        }
        let renewed = Entry {
            endpoint: entry.endpoint.clone(),
            credential: request.credential.clone(),
            added: true,
        };
        return Ok(match store.write_entry(&request.agent_id, &renewed) {
            Ok(()) => ConnectOutcome::Connected,
            Err(_) => ConnectOutcome::Manual {
                reason: ManualReason::StoreFailed,
            },
        });
    }
    let Some(program) = harness_path::find_on_path("claude", machine.search_path) else {
        return Ok(ConnectOutcome::Manual {
            reason: ManualReason::CliMissing,
        });
    };
    let pending = Entry {
        endpoint: endpoint.clone(),
        credential: request.credential.clone(),
        added: false,
    };
    if store.write_entry(&request.agent_id, &pending).is_err() {
        return Ok(ConnectOutcome::Manual {
            reason: ManualReason::StoreFailed,
        });
    }
    let json = build_add_json(&endpoint, machine.exe, &request.agent_id);
    let status = run_exit_only(&program, command_row("add"), Some(&json), machine);
    if status.is_some_and(|status| status.success()) {
        let added = Entry {
            added: true,
            ..pending
        };
        if store.write_entry(&request.agent_id, &added).is_ok() {
            // The CLI has one `oort` slot: remember whose it is, so a later
            // disconnect of another agent never removes it.
            let _ = store.write_owner(&request.agent_id);
            return Ok(ConnectOutcome::Connected);
        }
    }
    // Closed: no entry survives a failed step, and the manual path takes over.
    store.remove_entry(&request.agent_id);
    Ok(ConnectOutcome::Manual {
        reason: ManualReason::CliFailed,
    })
}

/// The ADR-0193 D16 swap: the CLI's setting names the helper, so putting the
/// active value in the store is the whole change. No CLI command.
pub fn replace_credential(request: &ReplaceRequest, home: &Path) -> Result<bool, String> {
    if !is_agent_id(&request.agent_id) {
        return Err("agentId is not a lowercase UUID".into());
    }
    if !is_connection_value(&request.credential) {
        return Err("credential has an unexpected shape".into());
    }
    let store = Store::under_home(home);
    let Some(entry) = store.read_entry(&request.agent_id) else {
        return Ok(false);
    };
    let renewed = Entry {
        credential: request.credential.clone(),
        ..entry
    };
    Ok(store.write_entry(&request.agent_id, &renewed).is_ok())
}

/// Delete the app's entry, and run `claude mcp remove` only when the app added
/// the CLI setting itself (ADR-0190 D3-h, second command).
pub fn disconnect(agent_id: &str, machine: &Machine<'_>) -> Result<bool, String> {
    if !is_agent_id(agent_id) {
        return Err("agentId is not a lowercase UUID".into());
    }
    let store = Store::under_home(machine.home);
    let Some(entry) = store.read_entry(agent_id) else {
        return Ok(false);
    };
    let mut removed = false;
    // Only the agent that owns the CLI's single `oort` slot may remove it.
    if entry.added && store.owner().as_deref() == Some(agent_id) {
        if let Some(program) = harness_path::find_on_path("claude", machine.search_path) {
            removed = run_exit_only(&program, command_row("remove"), None, machine)
                .is_some_and(|status| status.success());
        }
    }
    store.remove_entry(agent_id);
    if store.owner().as_deref() == Some(agent_id) {
        let _ = std::fs::remove_file(store.owner_path());
    }
    Ok(removed || !entry.added)
}

/// What the one-time cleanup of the old registration did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RetireState {
    /// The marker file exists: it ran before, nothing happens now.
    AlreadyDone,
    /// Cleaned in this call (store entries gone, marker written).
    Cleaned,
    /// `mcp remove` failed; the entries stay so the next launch tries again.
    Pending,
    /// `mcp remove` failed `RETIRE_MAX_ATTEMPTS` times; the entries were dropped anyway.
    GaveUp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetireOutcome {
    pub outcome: RetireState,
    /// `claude mcp remove --scope user oort` ran and exited 0 in this call.
    pub removed_mcp: bool,
}

/// #3567 (ADR-0198 증보 1 D2 4): retire what the old app registered, **once**.
///
/// * The marker file (`legacy-retired-v1`) makes it once per Mac: a later call
///   returns [`RetireState::AlreadyDone`] and runs nothing.
/// * `claude mcp remove --scope user oort` runs only when a store entry is marked
///   `added` (the app's own `add-json` succeeded) **and** that agent owns the
///   `oort` slot (`oort-owner`) — the same two conditions as [`disconnect`], so
///   an `oort` entry the person added by hand is never removed. A Mac the old app
///   never registered has no such entry: no CLI command runs at all.
/// * On success every store entry (they hold connection values the server has
///   revoked anyway) and the owner file go, then the marker is written.
/// * On failure the entries stay, so the next launch tries again, up to
///   [`RETIRE_MAX_ATTEMPTS`] launches; after that the entries are dropped and the
///   marker written, so a hand-removed `oort` entry cannot cost a command per launch.
pub fn retire_legacy(machine: &Machine<'_>) -> RetireOutcome {
    let store = Store::under_home(machine.home);
    if store.retired_marker_path().exists() {
        return RetireOutcome {
            outcome: RetireState::AlreadyDone,
            removed_mcp: false,
        };
    }
    let owner = store.owner();
    let ids = store.entry_ids();
    let owns_marked_slot = ids.iter().any(|id| {
        owner.as_deref() == Some(id.as_str())
            && store.read_entry(id).is_some_and(|entry| entry.added)
    });
    let mut removed_mcp = false;
    if owns_marked_slot {
        removed_mcp = harness_path::find_on_path("claude", machine.search_path)
            .and_then(|program| run_exit_only(&program, command_row("remove"), None, machine))
            .is_some_and(|status| status.success());
        if !removed_mcp {
            let attempts = std::fs::read_to_string(store.retire_attempts_path())
                .ok()
                .and_then(|text| text.trim().parse::<u32>().ok())
                .unwrap_or(0)
                + 1;
            if attempts < RETIRE_MAX_ATTEMPTS {
                let _ = store.ensure_dir();
                let _ = std::fs::write(store.retire_attempts_path(), attempts.to_string());
                return RetireOutcome {
                    outcome: RetireState::Pending,
                    removed_mcp: false,
                };
            }
        }
    }
    for id in &ids {
        store.remove_entry(id);
    }
    let _ = std::fs::remove_file(store.owner_path());
    let _ = std::fs::remove_file(store.retire_attempts_path());
    let gave_up = owns_marked_slot && !removed_mcp;
    // No marker means the next launch would retry; a store that cannot be written
    // (read-only home) is reported as pending rather than silently "done".
    if store.ensure_dir().is_err() || std::fs::write(store.retired_marker_path(), "done").is_err() {
        return RetireOutcome {
            outcome: RetireState::Pending,
            removed_mcp,
        };
    }
    RetireOutcome {
        outcome: if gave_up {
            RetireState::GaveUp
        } else {
            RetireState::Cleaned
        },
        removed_mcp,
    }
}

// ---------------------------------------------------------------------------
// This install (idempotency key for the server)
// ---------------------------------------------------------------------------

/// A random id for this install (`deviceId` of ADR-0193 D15): kept in the app
/// folder, not in web storage, so clearing site data cannot mint a second
/// agent toward the per-CLI limit. Not a hardware id, not a secret.
pub fn device_info(home: &Path) -> std::io::Result<DeviceInfo> {
    let store = Store::under_home(home);
    let path = store.dir().join("device-id");
    let existing = std::fs::read_to_string(&path)
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|text| (8..=64).contains(&text.len()));
    let device_id = match existing {
        Some(id) => id,
        None => {
            let id = format!("oort-{}", uuid::Uuid::new_v4().simple());
            store.ensure_dir()?;
            std::fs::write(&path, &id)?;
            id
        }
    };
    Ok(DeviceInfo {
        device_id,
        device_label: host_label(),
    })
}

/// What the person calls this Mac, reduced to the server's alphabet.
#[cfg(unix)]
fn host_label() -> Option<String> {
    let mut buffer = [0u8; 256];
    // SAFETY: the buffer is valid for its length; gethostname NUL-terminates
    // within it or fails.
    let rc = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) };
    if rc != 0 {
        return None;
    }
    let end = buffer.iter().position(|b| *b == 0).unwrap_or(buffer.len());
    let name = String::from_utf8_lossy(&buffer[..end]).to_string();
    let first = name.split('.').next().unwrap_or("");
    let label: String = first
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(32)
        .collect();
    (!label.is_empty()).then_some(label)
}

#[cfg(not(unix))]
fn host_label() -> Option<String> {
    None
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|home| home.is_absolute())
        .ok_or_else(|| "no home folder".to_string())
}

#[cfg(unix)]
fn current_uid() -> u32 {
    // SAFETY: getuid has no failure mode and no arguments.
    unsafe { libc::getuid() }
}

#[cfg(not(unix))]
fn current_uid() -> u32 {
    0
}

fn with_machine<T>(work: impl FnOnce(&Machine<'_>) -> T) -> Result<T, String> {
    let home = home_dir()?;
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let exe = std::fs::canonicalize(exe).map_err(|error| error.to_string())?;
    let search_path = harness_path::current_search_path();
    Ok(work(&Machine {
        home: &home,
        search_path: &search_path,
        exe: &exe,
        uid: current_uid(),
        timeout: COMMAND_TIMEOUT,
    }))
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "agent port task failed".to_string())?
}

#[tauri::command]
pub async fn agent_port_device() -> Result<DeviceInfo, String> {
    blocking(|| {
        let home = home_dir()?;
        device_info(&home).map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub async fn agent_port_connect(request: ConnectRequest) -> Result<ConnectOutcome, String> {
    blocking(move || with_machine(|machine| connect(&request, machine))?).await
}

#[tauri::command]
pub async fn agent_port_replace_credential(request: ReplaceRequest) -> Result<bool, String> {
    blocking(move || replace_credential(&request, &home_dir()?)).await
}

#[tauri::command]
pub async fn agent_port_disconnect(request: DisconnectRequest) -> Result<bool, String> {
    blocking(move || with_machine(|machine| disconnect(&request.agent_id, machine))?).await
}

#[tauri::command]
pub async fn agent_port_retire_legacy() -> Result<RetireOutcome, String> {
    blocking(move || with_machine(retire_legacy)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const AGENT: &str = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    const OTHER_AGENT: &str = "11111111-2222-4333-8444-555555555555";
    // A value in the alphabet the server uses; unmistakable in a dump.
    const VALUE: &str = "pairing-FAKE3389VALUE.zzzzzzzzzzzz~_+/=";
    const ENDPOINT: &str = "https://oort.example.test/v1/mcp/agent-port";

    #[test]
    fn the_allowlist_is_exactly_two_claude_commands() {
        assert_eq!(REGISTER_COMMANDS.len(), 2);
        assert!(REGISTER_COMMANDS.iter().all(|row| row.program == "claude"));
        assert_eq!(
            REGISTER_COMMANDS[0].args,
            ["mcp", "add-json", "--scope", "user", "oort"]
        );
        assert!(REGISTER_COMMANDS[0].takes_json);
        assert_eq!(
            REGISTER_COMMANDS[1].args,
            ["mcp", "remove", "--scope", "user", "oort"]
        );
        assert!(!REGISTER_COMMANDS[1].takes_json);
        // Not the status list, and no Codex row anywhere.
        let status: Vec<_> = crate::harness_status::STATUS_COMMANDS
            .iter()
            .map(|row| row.args)
            .collect();
        for row in REGISTER_COMMANDS {
            assert!(!status.contains(&row.args));
        }
        assert!(!REGISTER_COMMANDS.iter().any(|row| row.program == "codex"));
    }

    #[test]
    fn selectors_and_values_are_shape_checked() {
        assert!(is_agent_id(AGENT));
        for bad in [
            "",
            "0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D",
            "0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d",
            "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4;",
            "../0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c",
        ] {
            assert!(!is_agent_id(bad), "{bad}");
        }
        assert!(is_connection_value(VALUE));
        let long = "x".repeat(513);
        for bad in [
            "short",
            "has space ................",
            "quo\"te..................",
            "a;b.....................",
            long.as_str(),
        ] {
            assert!(!is_connection_value(bad), "{bad}");
        }
    }

    #[test]
    fn the_endpoint_must_be_https_or_loopback_and_exactly_the_agent_port() {
        assert!(allowed_endpoint(ENDPOINT).is_some());
        assert!(allowed_endpoint("http://127.0.0.1:8080/v1/mcp/agent-port").is_some());
        assert!(allowed_endpoint("http://localhost:3000/v1/mcp/agent-port").is_some());
        assert!(allowed_endpoint("http://[::1]:3000/v1/mcp/agent-port").is_some());
        for bad in [
            "http://oort.example.test/v1/mcp/agent-port",
            "http://localhost.evil.example/v1/mcp/agent-port",
            "http://127.0.0.1.evil.example/v1/mcp/agent-port",
            "https://user:pw@oort.example.test/v1/mcp/agent-port",
            "https://oort.example.test/v1/mcp/agent-port?x=1",
            "https://oort.example.test/v1/mcp/agent-port#frag",
            "https://oort.example.test/v1/mcp/other",
            "https://oort.example.test/",
            "ftp://oort.example.test/v1/mcp/agent-port",
            "file:///v1/mcp/agent-port",
            "not a url",
            "",
        ] {
            assert!(allowed_endpoint(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn the_helper_path_characters_are_closed() {
        assert!(helper_path_chars_ok(Path::new(
            "/Applications/oort.app/Contents/MacOS/oort"
        )));
        for bad in [
            "/Applications/My App.app/Contents/MacOS/oort",
            "/Applications/o'ort.app/Contents/MacOS/oort",
            "/Applications/o\"ort.app/Contents/MacOS/oort",
            "/Applications/$HOME/oort",
            "/Applications/`id`/oort",
            "/Applications/a;b/oort",
            "/Applications/../tmp/oort",
            "relative/oort",
            "oort",
            "",
        ] {
            assert!(!helper_path_chars_ok(Path::new(bad)), "{bad}");
        }
    }

    #[test]
    fn the_add_json_has_a_fixed_shape_and_no_value() {
        let json = build_add_json(
            ENDPOINT,
            Path::new("/Applications/oort.app/Contents/MacOS/oort"),
            AGENT,
        );
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        let object = parsed.as_object().unwrap();
        assert_eq!(object.len(), 3);
        assert_eq!(parsed["type"], "http");
        assert_eq!(parsed["url"], ENDPOINT);
        assert_eq!(
            parsed["headersHelper"],
            format!("/Applications/oort.app/Contents/MacOS/oort {AGENT}")
        );
        assert!(!json.contains(VALUE));
    }

    #[cfg(unix)]
    mod fake_cli {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        /// A throwaway HOME, a bin folder with a fake `claude`, and a 0700 folder
        /// holding a fake app executable. Nothing here touches the real home.
        struct Sandbox {
            root: PathBuf,
            home: PathBuf,
            exe: PathBuf,
            argv: PathBuf,
            search: OsString,
        }

        impl Sandbox {
            fn new(tag: &str, exit_code: i32, claude: bool) -> Sandbox {
                let root = std::env::temp_dir().join(format!(
                    "oort-3389-{tag}-{}-{}",
                    std::process::id(),
                    uuid::Uuid::new_v4().simple()
                ));
                let home = root.join("home");
                let bin = root.join("bin");
                let app = root.join("app");
                for dir in [&home, &bin, &app] {
                    std::fs::create_dir_all(dir).unwrap();
                }
                std::fs::set_permissions(&app, std::fs::Permissions::from_mode(0o700)).unwrap();
                let exe = app.join("oort");
                std::fs::write(&exe, "#!/bin/sh\nexit 0\n").unwrap();
                std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
                let argv = root.join("argv.txt");
                if claude {
                    let script = format!(
                        "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\necho '{VALUE} should never travel'\necho 'noise' >&2\nexit {exit_code}\n",
                        argv.display()
                    );
                    let path = bin.join("claude");
                    std::fs::write(&path, script).unwrap();
                    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                        .unwrap();
                }
                let search = OsString::from(bin.as_os_str());
                Sandbox {
                    root,
                    home,
                    exe,
                    argv,
                    search,
                }
            }

            fn machine(&self) -> Machine<'_> {
                Machine {
                    home: &self.home,
                    search_path: &self.search,
                    exe: &self.exe,
                    uid: unsafe { libc::getuid() },
                    timeout: Duration::from_secs(10),
                }
            }

            fn request(&self) -> ConnectRequest {
                ConnectRequest {
                    harness: "claude".into(),
                    endpoint: ENDPOINT.into(),
                    agent_id: AGENT.into(),
                    credential: VALUE.into(),
                }
            }

            fn recorded_argv(&self) -> Vec<String> {
                std::fs::read_to_string(&self.argv)
                    .unwrap_or_default()
                    .lines()
                    .map(str::to_string)
                    .collect()
            }

            fn store(&self) -> Store {
                Store::under_home(&self.home)
            }
        }

        impl Drop for Sandbox {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.root);
            }
        }

        #[test]
        fn connect_runs_the_fixed_command_and_the_value_is_nowhere_in_argv() {
            let sandbox = Sandbox::new("argv", 0, true);
            let outcome = connect(&sandbox.request(), &sandbox.machine()).unwrap();
            assert_eq!(outcome, ConnectOutcome::Connected);
            let argv = sandbox.recorded_argv();
            assert_eq!(argv.len(), 6, "{argv:?}");
            assert_eq!(&argv[..5], ["mcp", "add-json", "--scope", "user", "oort"]);
            let joined = argv.join("\n");
            assert!(!joined.contains(VALUE), "the value reached argv");
            assert!(
                !joined.contains("FAKE3389"),
                "a fragment of the value reached argv"
            );
            let store_dir = sandbox.store().dir().to_string_lossy().to_string();
            assert!(
                !joined.contains(&store_dir),
                "the store location reached argv"
            );
            let json: serde_json::Value = serde_json::from_str(&argv[5]).unwrap();
            assert_eq!(
                json["headersHelper"],
                format!("{} {AGENT}", sandbox.exe.display())
            );
            // The value is in the store, 0600 in a 0700 folder, and marked added.
            let entry = sandbox.store().read_entry(AGENT).unwrap();
            assert!(entry.added);
            assert_eq!(entry.credential, VALUE);
            let file_mode = std::fs::metadata(sandbox.store().entry_path(AGENT))
                .unwrap()
                .permissions()
                .mode();
            let dir_mode = std::fs::metadata(sandbox.store().dir())
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(file_mode & 0o777, 0o600);
            assert_eq!(dir_mode & 0o777, 0o700);
        }

        #[test]
        fn what_the_cli_prints_never_reaches_the_outcome() {
            let sandbox = Sandbox::new("stdout", 0, true);
            let outcome = connect(&sandbox.request(), &sandbox.machine()).unwrap();
            let text = serde_json::to_string(&outcome).unwrap();
            assert!(!text.contains("should never travel"));
            assert!(!text.contains(VALUE));
            assert_eq!(text, r#"{"outcome":"connected"}"#);
        }

        #[test]
        fn a_failing_cli_leaves_no_entry_and_asks_for_the_manual_path() {
            let sandbox = Sandbox::new("fail", 1, true);
            let outcome = connect(&sandbox.request(), &sandbox.machine()).unwrap();
            assert_eq!(
                outcome,
                ConnectOutcome::Manual {
                    reason: ManualReason::CliFailed
                }
            );
            assert!(sandbox.store().read_entry(AGENT).is_none());
            // The value was not retried through another door.
            assert!(!sandbox.recorded_argv().join("\n").contains(VALUE));
            assert!(!serde_json::to_string(&outcome).unwrap().contains(VALUE));
        }

        #[test]
        fn a_missing_cli_asks_for_the_manual_path_and_stores_nothing() {
            let sandbox = Sandbox::new("nocli", 0, false);
            let outcome = connect(&sandbox.request(), &sandbox.machine()).unwrap();
            assert_eq!(
                outcome,
                ConnectOutcome::Manual {
                    reason: ManualReason::CliMissing
                }
            );
            assert!(sandbox.store().read_entry(AGENT).is_none());
        }

        #[test]
        fn codex_and_unsafe_destinations_never_reach_the_cli() {
            let sandbox = Sandbox::new("refuse", 0, true);
            let mut codex = sandbox.request();
            codex.harness = "codex".into();
            assert_eq!(
                connect(&codex, &sandbox.machine()).unwrap(),
                ConnectOutcome::Manual {
                    reason: ManualReason::UnsupportedHarness
                }
            );
            let mut plain = sandbox.request();
            plain.endpoint = "http://oort.example.test/v1/mcp/agent-port".into();
            assert_eq!(
                connect(&plain, &sandbox.machine()).unwrap(),
                ConnectOutcome::Manual {
                    reason: ManualReason::EndpointNotAllowed
                }
            );
            assert!(!sandbox.argv.exists(), "the CLI ran for a refused request");
            assert!(sandbox.store().read_entry(AGENT).is_none());
        }

        #[test]
        fn a_helper_path_outside_the_rules_never_reaches_the_cli() {
            let sandbox = Sandbox::new("helperloc", 0, true);
            // 0755 folder: another account could swap the helper.
            let loose = sandbox.root.join("loose");
            std::fs::create_dir_all(&loose).unwrap();
            std::fs::set_permissions(&loose, std::fs::Permissions::from_mode(0o755)).unwrap();
            let exe = loose.join("oort");
            std::fs::write(&exe, "x").unwrap();
            std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
            let machine = Machine {
                exe: &exe,
                ..sandbox.machine()
            };
            assert_eq!(
                connect(&sandbox.request(), &machine).unwrap(),
                ConnectOutcome::Manual {
                    reason: ManualReason::HelperPathNotAllowed
                }
            );
            // A path with a space in it.
            let spaced = sandbox.root.join("sp ace");
            std::fs::create_dir_all(&spaced).unwrap();
            std::fs::set_permissions(&spaced, std::fs::Permissions::from_mode(0o700)).unwrap();
            let exe = spaced.join("oort");
            std::fs::write(&exe, "x").unwrap();
            std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
            let machine = Machine {
                exe: &exe,
                ..sandbox.machine()
            };
            assert_eq!(
                connect(&sandbox.request(), &machine).unwrap(),
                ConnectOutcome::Manual {
                    reason: ManualReason::HelperPathNotAllowed
                }
            );
            assert!(!sandbox.argv.exists());
        }

        #[test]
        fn malformed_requests_are_errors_not_commands() {
            let sandbox = Sandbox::new("malformed", 0, true);
            let mut bad_id = sandbox.request();
            bad_id.agent_id = "../../etc/passwd".into();
            assert!(connect(&bad_id, &sandbox.machine()).is_err());
            let mut bad_value = sandbox.request();
            bad_value.credential = "x; rm -rf /                ".into();
            assert!(connect(&bad_value, &sandbox.machine()).is_err());
            assert!(!sandbox.argv.exists());
        }

        #[test]
        fn a_repeat_registration_swaps_the_stored_value_without_a_second_add() {
            let sandbox = Sandbox::new("repeat", 0, true);
            assert_eq!(
                connect(&sandbox.request(), &sandbox.machine()).unwrap(),
                ConnectOutcome::Connected
            );
            std::fs::remove_file(&sandbox.argv).unwrap();
            let mut again = sandbox.request();
            again.credential = "second-FAKE3389VALUE.yyyyyyyyyyyy".into();
            assert_eq!(
                connect(&again, &sandbox.machine()).unwrap(),
                ConnectOutcome::Connected
            );
            assert!(!sandbox.argv.exists(), "add-json ran twice");
            assert_eq!(
                sandbox.store().read_entry(AGENT).unwrap().credential,
                again.credential
            );
        }

        #[test]
        fn replace_changes_only_an_existing_entry_and_runs_no_command() {
            let sandbox = Sandbox::new("replace", 0, true);
            let request = ReplaceRequest {
                agent_id: AGENT.into(),
                credential: "active-FAKE3389VALUE.xxxxxxxxxxxx".into(),
            };
            assert!(!replace_credential(&request, &sandbox.home).unwrap());
            assert!(sandbox.store().read_entry(AGENT).is_none());
            connect(&sandbox.request(), &sandbox.machine()).unwrap();
            std::fs::remove_file(&sandbox.argv).unwrap();
            assert!(replace_credential(&request, &sandbox.home).unwrap());
            let entry = sandbox.store().read_entry(AGENT).unwrap();
            assert_eq!(entry.credential, request.credential);
            assert!(entry.added);
            assert!(!sandbox.argv.exists(), "replace ran a CLI command");
        }

        #[test]
        fn remove_runs_only_for_an_entry_the_app_added() {
            let sandbox = Sandbox::new("remove", 0, true);
            // No entry: nothing runs.
            assert!(!disconnect(AGENT, &sandbox.machine()).unwrap());
            assert!(!sandbox.argv.exists());
            // An entry whose `add-json` never succeeded: only the entry goes; an
            // `oort` the person added by hand is left alone.
            sandbox
                .store()
                .write_entry(
                    OTHER_AGENT,
                    &Entry {
                        endpoint: ENDPOINT.into(),
                        credential: VALUE.into(),
                        added: false,
                    },
                )
                .unwrap();
            assert!(disconnect(OTHER_AGENT, &sandbox.machine()).unwrap());
            assert!(!sandbox.argv.exists(), "mcp remove ran for a foreign entry");
            assert!(sandbox.store().read_entry(OTHER_AGENT).is_none());
            // An added entry: `mcp remove --scope user oort`, then the entry goes.
            connect(&sandbox.request(), &sandbox.machine()).unwrap();
            std::fs::remove_file(&sandbox.argv).unwrap();
            assert!(disconnect(AGENT, &sandbox.machine()).unwrap());
            assert_eq!(
                sandbox.recorded_argv(),
                ["mcp", "remove", "--scope", "user", "oort"]
            );
            assert!(sandbox.store().read_entry(AGENT).is_none());
        }

        #[test]
        fn a_repeat_with_another_endpoint_is_left_to_the_person() {
            let sandbox = Sandbox::new("endpoint", 0, true);
            connect(&sandbox.request(), &sandbox.machine()).unwrap();
            std::fs::remove_file(&sandbox.argv).unwrap();
            let mut moved = sandbox.request();
            moved.endpoint = "https://other.example.test/v1/mcp/agent-port".into();
            assert_eq!(
                connect(&moved, &sandbox.machine()).unwrap(),
                ConnectOutcome::Manual {
                    reason: ManualReason::CliFailed
                }
            );
            assert!(!sandbox.argv.exists());
            assert_eq!(
                sandbox.store().read_entry(AGENT).unwrap().credential,
                VALUE,
                "the stored value was swapped for another address"
            );
        }

        #[test]
        fn only_the_agent_that_owns_the_oort_slot_may_remove_it() {
            let sandbox = Sandbox::new("slot", 0, true);
            connect(&sandbox.request(), &sandbox.machine()).unwrap();
            // A second agent's entry that claims `added` without owning the slot.
            sandbox
                .store()
                .write_entry(
                    OTHER_AGENT,
                    &Entry {
                        endpoint: ENDPOINT.into(),
                        credential: VALUE.into(),
                        added: true,
                    },
                )
                .unwrap();
            std::fs::remove_file(&sandbox.argv).unwrap();
            disconnect(OTHER_AGENT, &sandbox.machine()).unwrap();
            assert!(!sandbox.argv.exists(), "mcp remove ran for a non-owner");
            disconnect(AGENT, &sandbox.machine()).unwrap();
            assert_eq!(
                sandbox.recorded_argv(),
                ["mcp", "remove", "--scope", "user", "oort"]
            );
        }

        fn marked_entry(sandbox: &Sandbox, id: &str, added: bool) {
            sandbox
                .store()
                .write_entry(
                    id,
                    &Entry {
                        endpoint: ENDPOINT.into(),
                        credential: VALUE.into(),
                        added,
                    },
                )
                .unwrap();
        }

        #[test]
        fn the_legacy_cleanup_removes_the_cli_entry_once_and_never_again() {
            let sandbox = Sandbox::new("retire-once", 0, true);
            connect(&sandbox.request(), &sandbox.machine()).unwrap();
            std::fs::remove_file(&sandbox.argv).unwrap();

            let first = retire_legacy(&sandbox.machine());
            assert_eq!(
                first,
                RetireOutcome {
                    outcome: RetireState::Cleaned,
                    removed_mcp: true
                }
            );
            assert_eq!(
                sandbox.recorded_argv(),
                ["mcp", "remove", "--scope", "user", "oort"]
            );
            assert!(sandbox.store().entry_ids().is_empty(), "entries stayed");
            assert!(sandbox.store().owner().is_none());

            // A device the old app registers again later (or a repeat launch): no command.
            std::fs::remove_file(&sandbox.argv).unwrap();
            marked_entry(&sandbox, AGENT, true);
            sandbox.store().write_owner(AGENT).unwrap();
            let second = retire_legacy(&sandbox.machine());
            assert_eq!(second.outcome, RetireState::AlreadyDone);
            assert!(!sandbox.argv.exists(), "the cleanup ran twice");
        }

        #[test]
        fn the_legacy_cleanup_never_touches_an_oort_entry_the_app_did_not_add() {
            let sandbox = Sandbox::new("retire-foreign", 0, true);
            // No store at all: a Mac the old app never registered.
            let none = retire_legacy(&sandbox.machine());
            assert_eq!(none.outcome, RetireState::Cleaned);
            assert!(!none.removed_mcp);
            assert!(!sandbox.argv.exists(), "mcp remove ran on a clean Mac");

            // An entry whose `add-json` never succeeded, and one marked `added`
            // that does not own the slot: neither may reach `mcp remove`.
            let sandbox = Sandbox::new("retire-foreign-2", 0, true);
            marked_entry(&sandbox, AGENT, false);
            sandbox.store().write_owner(AGENT).unwrap();
            marked_entry(&sandbox, OTHER_AGENT, true);
            let outcome = retire_legacy(&sandbox.machine());
            assert_eq!(outcome.outcome, RetireState::Cleaned);
            assert!(!sandbox.argv.exists(), "mcp remove ran for a foreign entry");
            assert!(sandbox.store().entry_ids().is_empty());
        }

        #[test]
        fn a_failing_remove_is_retried_a_few_launches_then_given_up() {
            let sandbox = Sandbox::new("retire-retry", 1, true);
            // The fake CLI exits 1, but an added entry needs to exist.
            marked_entry(&sandbox, AGENT, true);
            sandbox.store().write_owner(AGENT).unwrap();
            for attempt in 1..RETIRE_MAX_ATTEMPTS {
                let outcome = retire_legacy(&sandbox.machine());
                assert_eq!(outcome.outcome, RetireState::Pending, "attempt {attempt}");
                assert!(
                    sandbox.store().read_entry(AGENT).is_some(),
                    "the marker entry must stay while the removal is pending"
                );
            }
            let last = retire_legacy(&sandbox.machine());
            assert_eq!(last.outcome, RetireState::GaveUp);
            assert!(!last.removed_mcp);
            assert!(sandbox.store().entry_ids().is_empty());
            assert_eq!(retire_legacy(&sandbox.machine()).outcome, RetireState::AlreadyDone);
        }

        #[test]
        fn a_missing_cli_with_a_marked_entry_is_pending_not_done() {
            let sandbox = Sandbox::new("retire-nocli", 0, false);
            marked_entry(&sandbox, AGENT, true);
            sandbox.store().write_owner(AGENT).unwrap();
            let outcome = retire_legacy(&sandbox.machine());
            assert_eq!(outcome.outcome, RetireState::Pending);
            assert!(sandbox.store().read_entry(AGENT).is_some());
        }

        #[test]
        fn the_install_id_is_stable_and_server_valid() {
            let sandbox = Sandbox::new("device", 0, false);
            let first = device_info(&sandbox.home).unwrap();
            let second = device_info(&sandbox.home).unwrap();
            assert_eq!(first.device_id, second.device_id);
            assert!((8..=64).contains(&first.device_id.len()));
            assert!(first
                .device_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)));
        }
    }

    #[test]
    fn a_header_helper_only_answers_to_a_lone_agent_id() {
        assert!(run_header_helper(&[], None).is_none());
        assert!(run_header_helper(&["--oort-pane-hook".into(), "claude".into()], None).is_none());
        assert!(run_header_helper(&["not-an-id".into()], None).is_none());
        assert!(run_header_helper(&[AGENT.into(), "x".into()], None).is_none());
    }

    /// The module names no harness config or credential file and logs nothing;
    /// its value-carrying types cannot be `{:?}`-printed.
    #[test]
    fn the_source_has_no_credential_path_no_logging_and_no_debug_on_value_types() {
        let src = include_str!("agent_port.rs");
        let production = src.split("#[cfg(test)]\nmod tests").next().unwrap();
        for needle in [
            format!("{}{}", ".claude", ".json"),
            format!("{}{}", ".claude", "/"),
            format!("{}{}", "auth", ".json"),
            "eprintln!".to_string(),
            "println!".to_string(),
            "dbg!".to_string(),
            "tracing::".to_string(),
            "log::".to_string(),
        ] {
            assert!(
                !production.contains(&needle),
                "agent_port.rs mentions {needle}"
            );
        }
        for name in ["ConnectRequest", "ReplaceRequest", "Entry"] {
            let marker = format!("struct {name} ");
            let at = production.find(&marker).unwrap();
            let attrs = &production[at.saturating_sub(140)..at];
            assert!(!attrs.contains("Debug"), "{name} derives Debug");
        }
        // One place builds a `Command`, and only the allowlist rows reach it.
        assert_eq!(production.matches("Command::new(").count(), 1);
        // `connect` (add), `disconnect` (remove) and the one-time `retire_legacy`
        // (remove, #3567). Every call site names an allowlist row by id.
        assert_eq!(production.matches("run_exit_only(&program").count(), 3);
        assert!(production.contains("run_exit_only(&program, command_row(\"remove\"), None, machine)"));
    }
}
