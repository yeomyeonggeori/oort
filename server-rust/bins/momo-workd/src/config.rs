//! Host configuration and registration state.
//!
//! Two files, written by two different parties:
//!
//! * the **config** (`--config`) is the owner's own statement about this Mac:
//!   which server, which workspace, which folder, and the **tool allowlist**
//!   (ADR-0188 D6). The executable and arguments a session runs come from here
//!   and only from here — the server's `work_tool_profile.launch_template` is
//!   never read, so nothing the server says can choose a binary or a flag.
//! * the **state** (`state_path`) is what registration learned: the host id and
//!   the owner the server bound it to. Written `0600`; it names no secret, but it
//!   is this host's identity and nobody else's business.

use std::collections::BTreeMap;
use std::io::{Read as _, Write as _};
use std::os::unix::fs::{DirBuilderExt as _, MetadataExt as _, OpenOptionsExt as _};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::policy::{self, AdapterKind};

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("{path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("{path}: invalid JSON: {message}")]
    Parse { path: String, message: String },
    #[error("invalid config: {0}")]
    Invalid(String),
    #[error("{path}: {detail}; it must be this user's own file that no one else can write")]
    Unsafe { path: String, detail: String },
}

/// Read a file this host takes orders from — the config (which executables
/// run) and the registration state (whose instructions count): not a symlink,
/// a regular file, owned by this user, writable by no one else (#2602 L-4).
/// Checked on the open descriptor and read from it, so what is checked is
/// what is read.
pub fn read_owned_file(path: &Path) -> Result<String, ConfigError> {
    let io = |source: std::io::Error| ConfigError::Io {
        path: path.display().to_string(),
        source,
    };
    let refuse = |detail: String| ConfigError::Unsafe {
        path: path.display().to_string(),
        detail,
    };
    // #2607 N-10: a folder someone else can write into lets them swap the
    // file between two reads.
    check_parent_folder(path)?;
    let mut file = match std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.raw_os_error() == Some(libc::ELOOP) => {
            return Err(refuse("a symbolic link".to_string()))
        }
        Err(error) => return Err(io(error)),
    };
    let metadata = file.metadata().map_err(io)?;
    if !metadata.file_type().is_file() {
        return Err(refuse("not a regular file".to_string()));
    }
    // SAFETY: `geteuid` has no preconditions and cannot fail.
    let uid = unsafe { libc::geteuid() };
    if metadata.uid() != uid {
        return Err(refuse(format!(
            "owned by uid {}, not {uid}",
            metadata.uid()
        )));
    }
    let mode = metadata.mode() & 0o777;
    if mode & 0o022 != 0 {
        return Err(refuse(format!("mode {mode:04o} lets others write it")));
    }
    let mut raw = String::new();
    file.read_to_string(&mut raw).map_err(io)?;
    Ok(raw)
}

/// Write `body` to `path` as this user's `0600` file: a sibling created with
/// `O_EXCL`, synced, then renamed into place, so a reader sees the old file or
/// the new one and never half of either. A missing folder is created `0700`
/// (#2602 L-4); an existing one must pass [`check_parent_folder`] (#2607 N-10).
pub fn write_private_file(path: &Path, body: &[u8]) -> Result<(), ConfigError> {
    let io = |source: std::io::Error| ConfigError::Io {
        path: path.display().to_string(),
        source,
    };
    if let Some(parent) = path.parent() {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)
            .map_err(io)?;
    }
    check_parent_folder(path)?;
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let _ = std::fs::remove_file(&temporary);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(io)?;
    file.write_all(body)
        .and_then(|()| file.sync_all())
        .map_err(io)?;
    drop(file);
    std::fs::rename(&temporary, path).map_err(io)?;
    // The rename itself durable: the nonce ledger must survive a power loss.
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::File::open(parent)
            .and_then(|folder| folder.sync_all())
            .map_err(io)?;
    }
    Ok(())
}

/// The folder holding a file the host takes orders from: owned by this user
/// (or root) and writable by no one else (#2607 N-10).
pub fn check_parent_folder(path: &Path) -> Result<(), ConfigError> {
    let parent = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    let metadata = std::fs::metadata(parent).map_err(|source| ConfigError::Io {
        path: parent.display().to_string(),
        source,
    })?;
    // SAFETY: `geteuid` has no preconditions and cannot fail.
    let uid = unsafe { libc::geteuid() };
    let mode = metadata.mode() & 0o7777;
    let detail = if !metadata.is_dir() {
        Some("its folder is not a directory".to_string())
    } else if metadata.uid() != uid && metadata.uid() != 0 {
        Some(format!("its folder is owned by uid {}", metadata.uid()))
    } else if mode & 0o022 != 0 {
        Some(format!(
            "its folder (mode {mode:04o}) lets others write into it"
        ))
    } else {
        None
    };
    match detail {
        Some(detail) => Err(ConfigError::Unsafe {
            path: path.display().to_string(),
            detail,
        }),
        None => Ok(()),
    }
}

/// The allowed folder is a project folder: not `/`, not the home folder, and
/// not a folder above it (#2607 N-1). Those would put the owner's credential
/// folders inside the read fence and under every command's reach.
pub fn check_working_directory(folder: &Path, home: Option<&Path>) -> Result<(), String> {
    let resolve = |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let folder = resolve(folder);
    let too_wide =
        folder.parent().is_none() || home.is_some_and(|home| resolve(home).starts_with(&folder));
    if too_wide {
        return Err(format!(
            "working_directory {} is `/`, the home folder or above it; allow a project folder",
            folder.display()
        ));
    }
    Ok(())
}

fn default_poll_interval_ms() -> u64 {
    2_000
}

fn default_heartbeat_interval_ms() -> u64 {
    30_000
}

fn default_acp_start_timeout_ms() -> u64 {
    60_000
}

fn default_max_sessions() -> usize {
    4
}

/// The owner-authored host configuration.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkdConfig {
    /// Team server origin, e.g. `https://oort.example.com`. Plain `http` only for
    /// a loopback host (local development and the conformance harness).
    pub server_url: String,
    pub workspace_id: Uuid,
    /// Shown to the owner's devices as this host's name (1…80 characters).
    pub display_name: String,
    /// Where `register` writes, and `run` reads, the registration state.
    pub state_path: PathBuf,
    /// The one folder a remote session may open in this slice (ADR-0188 D6
    /// 허용 폴더). Resolved with `realpath` at every spawn.
    pub working_directory: PathBuf,
    /// The host allowlist: tool key (as the server names it in a spawn) →
    /// how to launch it locally.
    pub tools: BTreeMap<String, ToolEntry>,
    /// Keychain access group of a signed bundle (`<TEAMID>.app.momo.desktop`).
    #[serde(default)]
    pub keychain_access_group: Option<String>,
    #[serde(default = "default_poll_interval_ms")]
    pub poll_interval_ms: u64,
    #[serde(default = "default_heartbeat_interval_ms")]
    pub heartbeat_interval_ms: u64,
    #[serde(default = "default_acp_start_timeout_ms")]
    pub acp_start_timeout_ms: u64,
    /// Most remote sessions (agent processes) at once; a spawn beyond it is
    /// refused with `host_busy` (#2602 L-2).
    #[serde(default = "default_max_sessions")]
    pub max_sessions: usize,
    /// ADR-0146 개정 D-10·D-11 (#3024): refuse a spawn, an input or an allow
    /// that does not carry the owner's device signature chaining to the root
    /// pinned on this Mac. Off by default until the server sends signatures
    /// and R2 is switched on (E10 #3030); off, the host behaves as before.
    #[serde(default)]
    pub require_human_signatures: bool,
}

/// The Linux box profile applies when the image's root-owned marker file
/// exists **or** the advisory env variable is set. The env alone can be unset
/// or emptied by the person; the marker cannot (H1 of the #3503 review).
pub fn box_profile_active(marker_file: bool, env_value: Option<&str>) -> bool {
    marker_file || env_value.is_some_and(|value| !value.is_empty())
}

/// One allowlisted tool.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolEntry {
    /// Which ACP adapter this is. Only adapters whose permission requests reach
    /// the host's ACP permission bridge are accepted (ADR-0188 D6).
    pub adapter: AdapterKind,
    /// Absolute path. No `PATH` lookup, so a directory earlier on `PATH` cannot
    /// substitute a binary.
    pub executable: PathBuf,
    /// Extra arguments, fixed by the owner. The host appends its own isolation
    /// arguments after these (see [`crate::policy::launch_spec`]).
    #[serde(default)]
    pub args: Vec<String>,
}

impl WorkdConfig {
    pub fn load(path: &Path) -> Result<Self, ConfigError> {
        let env = std::env::var(crate::keystore::box_store::ENV_BOX_MARKER).ok();
        let box_profile = box_profile_active(crate::keystore::box_store::in_box(), env.as_deref());
        Self::load_with_profile(path, box_profile)
    }

    /// [`Self::load`] with the profile chosen by the caller. `box_profile` is
    /// the Linux personal-box profile (ADR-0197 D6): the box image sets
    /// `OORT_BOX`, and in a box no Claude ACP adapter may be allowlisted.
    pub fn load_with_profile(path: &Path, box_profile: bool) -> Result<Self, ConfigError> {
        let raw = read_owned_file(path)?;
        let config: Self = serde_json::from_str(&raw).map_err(|error| ConfigError::Parse {
            path: path.display().to_string(),
            message: error.to_string(),
        })?;
        config.validate()?;
        if box_profile {
            config.validate_box_profile()?;
        }
        Ok(config)
    }

    /// ADR-0197 D6 / #3397: a box never drives Claude through an ACP adapter or
    /// `claude -p` (a Claude subscription is only ever used by the person, in
    /// the PTY). The server also refuses such a spawn; this is the host half,
    /// so a config that allowlists it does not load at all.
    pub fn validate_box_profile(&self) -> Result<(), ConfigError> {
        if let Some((key, _)) = self
            .tools
            .iter()
            .find(|(_, entry)| entry.adapter == AdapterKind::Claude)
        {
            return Err(ConfigError::Invalid(format!(
                "tools.{key}: the Claude ACP adapter is not allowed in a personal-cloud box \
                 (ADR-0197 D6); the person runs `claude` in the terminal"
            )));
        }
        Ok(())
    }

    pub fn validate(&self) -> Result<(), ConfigError> {
        let invalid = |message: String| Err(ConfigError::Invalid(message));
        validate_server_url(&self.server_url).map_err(ConfigError::Invalid)?;
        let name_length = self.display_name.trim().chars().count();
        if !(1..=80).contains(&name_length) {
            return invalid("display_name must contain 1...80 characters".to_string());
        }
        if !self.working_directory.is_absolute() {
            return invalid("working_directory must be an absolute path".to_string());
        }
        let home = std::env::var_os("HOME").map(PathBuf::from);
        check_working_directory(&self.working_directory, home.as_deref())
            .map_err(ConfigError::Invalid)?;
        if !self.state_path.is_absolute() {
            return invalid("state_path must be an absolute path".to_string());
        }
        if self.tools.is_empty() {
            return invalid("tools must allowlist at least one ACP adapter".to_string());
        }
        for (key, entry) in &self.tools {
            if !policy::is_valid_tool_key(key) {
                return invalid(format!("tool key {key:?} is not a valid work tool key"));
            }
            if !entry.executable.is_absolute() {
                return invalid(format!("tools.{key}.executable must be an absolute path"));
            }
            if let Some(argument) = entry
                .args
                .iter()
                .find(|argument| policy::is_forbidden_launch_argument(argument))
            {
                // ADR-0188 D6: a configuration that asks for bypass/auto is not
                // one this host will launch. Refusing the whole file here is the
                // config half of that rule; the session half is the mode check.
                return invalid(format!(
                    "tools.{key}.args contains {argument:?}, which would bypass the \
                     host's fixed permission mode"
                ));
            }
        }
        if !(100..=60_000).contains(&self.poll_interval_ms) {
            return invalid("poll_interval_ms must be within 100...60000".to_string());
        }
        // The server calls a host online for 90 s after its last heartbeat.
        if !(200..=60_000).contains(&self.heartbeat_interval_ms) {
            return invalid("heartbeat_interval_ms must be within 200...60000".to_string());
        }
        if !(1_000..=600_000).contains(&self.acp_start_timeout_ms) {
            return invalid("acp_start_timeout_ms must be within 1000...600000".to_string());
        }
        if !(1..=16).contains(&self.max_sessions) {
            return invalid("max_sessions must be within 1...16".to_string());
        }
        Ok(())
    }

    /// `server_url` without a trailing slash, ready for `/v1/...` paths.
    pub fn server_base(&self) -> String {
        self.server_url.trim_end_matches('/').to_string()
    }
}

/// `https://…`, or `http://` to a loopback address; no path, query or fragment.
fn validate_server_url(raw: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(raw).map_err(|error| format!("server_url: {error}"))?;
    let host = url.host_str().unwrap_or_default();
    let loopback = host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host == "::1";
    match url.scheme() {
        "https" => {}
        "http" if loopback => {}
        _ => return Err("server_url must be https (http only for a loopback host)".to_string()),
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("server_url must not carry a query or fragment".to_string());
    }
    if !(url.path().is_empty() || url.path() == "/") {
        return Err("server_url must be an origin without a path".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("server_url must not carry credentials".to_string());
    }
    Ok(())
}

/// What registration learned. `owner_member_id` is the human the server bound
/// this host to (ADR-0188 D3 — the only person whose instructions it follows).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HostState {
    pub server_url: String,
    pub workspace_id: Uuid,
    pub host_id: Uuid,
    pub owner_member_id: Uuid,
    pub public_key: String,
    /// The host's scope as the server registered it. `run` serves `member`
    /// only (ADR-0188 D3, #2602 M-4); a state file without it predates the
    /// field and is refused until re-registered.
    #[serde(default)]
    pub scope: String,
}

/// The only host scope `momo-workd run` serves (ADR-0188 D3: a desktop host is
/// its owner's; team hosts are outside goal A).
pub const SERVED_SCOPE: &str = "member";

impl HostState {
    pub fn load(path: &Path) -> Result<Self, ConfigError> {
        let raw = read_owned_file(path)?;
        serde_json::from_str(&raw).map_err(|error| ConfigError::Parse {
            path: path.display().to_string(),
            message: error.to_string(),
        })
    }

    /// Written with `0600` via a sibling + rename, like the dev key file.
    pub fn save(&self, path: &Path) -> Result<(), ConfigError> {
        let mut body = serde_json::to_vec_pretty(self).expect("HostState serialises");
        body.push(b'\n');
        write_private_file(path, &body)
    }

    /// The state must describe the host this config points at.
    pub fn check_matches(&self, config: &WorkdConfig) -> Result<(), ConfigError> {
        if self.server_url.trim_end_matches('/') != config.server_base()
            || self.workspace_id != config.workspace_id
        {
            return Err(ConfigError::Invalid(
                "the registration state belongs to a different server or workspace; \
                 run `momo-workd register` for this config"
                    .to_string(),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_json() -> serde_json::Value {
        serde_json::json!({
            "server_url": "https://oort.example.com",
            "workspace_id": Uuid::from_u128(1),
            "display_name": "성재의 MacBook",
            "state_path": "/tmp/momo-workd/state.json",
            "working_directory": "/tmp",
            "tools": {
                "claude": {"adapter": "claude", "executable": "/usr/local/bin/claude-agent-acp"}
            }
        })
    }

    fn parse(value: serde_json::Value) -> Result<WorkdConfig, ConfigError> {
        let config: WorkdConfig =
            serde_json::from_value(value).map_err(|error| ConfigError::Parse {
                path: "inline".to_string(),
                message: error.to_string(),
            })?;
        config.validate()?;
        Ok(config)
    }

    #[test]
    fn a_minimal_config_is_accepted_with_defaults() {
        let config = parse(base_json()).expect("valid");
        assert_eq!(config.poll_interval_ms, 2_000);
        assert_eq!(config.heartbeat_interval_ms, 30_000);
        assert_eq!(config.max_sessions, 4);
        assert_eq!(config.server_base(), "https://oort.example.com");
        assert!(!config.require_human_signatures, "R2 is off by default");
    }

    #[test]
    fn the_box_profile_rests_on_the_marker_file_not_on_the_environment() {
        // An emptied or absent env does not leave a box: the marker decides.
        assert!(box_profile_active(true, Some("")));
        assert!(box_profile_active(true, None));
        assert!(box_profile_active(true, Some("1")));
        // Outside a box the env is still honoured (a Mac developer opting in).
        assert!(box_profile_active(false, Some("1")));
        assert!(!box_profile_active(false, Some("")));
        assert!(!box_profile_active(false, None));
    }

    fn codex_only_json() -> serde_json::Value {
        let mut value = base_json();
        value["tools"] = serde_json::json!({
            "codex": {"adapter": "codex", "executable": "/usr/local/bin/codex-acp"}
        });
        value
    }

    /// ADR-0197 D6 / M3: the Linux box profile has no Claude ACP adapter.
    #[test]
    fn the_box_profile_refuses_a_claude_acp_adapter_and_accepts_codex() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = std::env::temp_dir().join(format!("momo-workd-box-{}", Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let write = |name: &str, value: &serde_json::Value| {
            let path = dir.join(name);
            std::fs::write(&path, serde_json::to_vec(value).unwrap()).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
            path
        };
        let claude = write("claude.json", &base_json());
        let codex = write("codex.json", &codex_only_json());
        let mixed = {
            let mut value = codex_only_json();
            value["tools"]["claude"] =
                serde_json::json!({"adapter": "claude", "executable": "/opt/tools/claude-acp"});
            write("mixed.json", &value)
        };

        // The desktop profile is unchanged: Claude is allowlisted there.
        WorkdConfig::load_with_profile(&claude, false).expect("desktop keeps Claude");
        WorkdConfig::load_with_profile(&codex, true).expect("a box may run Codex over ACP");
        for path in [&claude, &mixed] {
            match WorkdConfig::load_with_profile(path, true) {
                Err(ConfigError::Invalid(message)) => {
                    assert!(message.contains("Claude ACP adapter"), "{message}")
                }
                other => panic!("a box must refuse a Claude adapter, got {other:?}"),
            }
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn plain_http_is_only_for_loopback() {
        let mut value = base_json();
        value["server_url"] = "http://oort.example.com".into();
        assert!(parse(value.clone()).is_err());
        value["server_url"] = "http://127.0.0.1:18080".into();
        assert!(parse(value.clone()).is_ok());
        value["server_url"] = "https://oort.example.com/api".into();
        assert!(
            parse(value.clone()).is_err(),
            "a path would re-root every signed path"
        );
        value["server_url"] = "https://oort.example.com/?x=1".into();
        assert!(parse(value).is_err());
    }

    #[test]
    fn relative_executables_and_bypass_arguments_are_refused() {
        let mut value = base_json();
        value["tools"]["claude"]["executable"] = "claude-agent-acp".into();
        assert!(
            parse(value).is_err(),
            "PATH lookup would let PATH pick the binary"
        );

        for argument in [
            "--dangerously-skip-permissions",
            "--permission-mode=bypassPermissions",
            "--dangerously-bypass-approvals-and-sandbox",
            "--yolo",
            "--full-auto",
            "approval_policy=never",
        ] {
            let mut value = base_json();
            value["tools"]["claude"]["args"] = serde_json::json!([argument]);
            match parse(value) {
                Err(ConfigError::Invalid(message)) => {
                    assert!(message.contains("fixed permission mode"), "{message}")
                }
                other => panic!("{argument} must be refused, got {other:?}"),
            }
        }
    }

    #[test]
    fn a_codex_tool_entry_is_accepted_at_load() {
        // ADR-0188 §8 (2026-09-24): Codex runs inside its accepted sandbox;
        // the conditions are checked at every spawn, not here.
        let mut value = base_json();
        value["tools"]["codex"] = serde_json::json!({
            "adapter": "codex", "executable": "/usr/local/bin/codex-acp"
        });
        let config = parse(value).expect("a codex entry is accepted");
        assert_eq!(config.tools["codex"].adapter, AdapterKind::Codex);
    }

    #[test]
    fn unknown_adapters_and_fields_are_refused() {
        let mut value = base_json();
        value["tools"]["claude"]["adapter"] = "shell".into();
        assert!(
            parse(value).is_err(),
            "only ACP adapters with a permission bridge"
        );
        let mut value = base_json();
        value["launch_template"] = serde_json::json!({"command": "sh"});
        assert!(parse(value).is_err(), "deny_unknown_fields");
    }

    #[test]
    fn host_state_is_written_0600() {
        use std::os::unix::fs::MetadataExt as _;
        let dir =
            std::env::temp_dir().join(format!("momo-workd-state-{}", Uuid::new_v4().simple()));
        let path = dir.join("state.json");
        let state = HostState {
            server_url: "https://oort.example.com".to_string(),
            workspace_id: Uuid::from_u128(1),
            host_id: Uuid::from_u128(2),
            owner_member_id: Uuid::from_u128(3),
            public_key: "AAAA".to_string(),
            scope: "member".to_string(),
        };
        state.save(&path).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(&dir).unwrap().mode() & 0o777, 0o700);
        assert_eq!(HostState::load(&path).unwrap(), state);
        // A state file from before the field reads with an empty scope, which
        // `run` refuses (re-register), rather than defaulting to member.
        std::fs::write(
            &path,
            r#"{"server_url":"https://oort.example.com","workspace_id":"00000000-0000-0000-0000-000000000001","host_id":"00000000-0000-0000-0000-000000000002","owner_member_id":"00000000-0000-0000-0000-000000000003","public_key":"AAAA"}"#,
        )
        .unwrap();
        assert_eq!(HostState::load(&path).unwrap().scope, "");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_allowed_folder_is_a_project_folder() {
        let home = Path::new("/Users/me");
        for wide in ["/", "/Users", "/Users/me", "/Users/me/"] {
            assert!(
                check_working_directory(Path::new(wide), Some(home)).is_err(),
                "{wide}"
            );
        }
        for project in ["/Users/me/src/app", "/opt/work"] {
            assert!(
                check_working_directory(Path::new(project), Some(home)).is_ok(),
                "{project}"
            );
        }
        // A config naming the home folder is refused at load.
        let mut value = base_json();
        value["working_directory"] = std::env::var("HOME").unwrap().into();
        assert!(
            matches!(parse(value), Err(ConfigError::Invalid(message)) if message.contains("home folder"))
        );
    }

    #[test]
    fn a_config_or_state_in_a_folder_others_can_write_is_refused() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir =
            std::env::temp_dir().join(format!("momo-workd-folder-{}", Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let config = dir.join("workd.json");
        std::fs::write(&config, serde_json::to_vec(&base_json()).unwrap()).unwrap();
        std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o600)).unwrap();
        WorkdConfig::load(&config).expect("a private folder is fine");

        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777)).unwrap();
        match WorkdConfig::load(&config) {
            Err(ConfigError::Unsafe { detail, .. }) => {
                assert!(detail.contains("folder"), "{detail}")
            }
            other => panic!("a world-writable folder must be refused, got {other:?}"),
        }
        let state = HostState {
            server_url: "https://oort.example.com".to_string(),
            workspace_id: Uuid::from_u128(1),
            host_id: Uuid::from_u128(2),
            owner_member_id: Uuid::from_u128(3),
            public_key: "AAAA".to_string(),
            scope: "member".to_string(),
        };
        assert!(
            matches!(
                state.save(&dir.join("state.json")),
                Err(ConfigError::Unsafe { .. })
            ),
            "no state is written into a folder others can write"
        );
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_config_or_state_others_can_write_or_swap_is_refused() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir =
            std::env::temp_dir().join(format!("momo-workd-owned-{}", Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        // The owner's own folder whatever the umask (`check_parent_folder`).
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let config = dir.join("workd.json");
        std::fs::write(&config, serde_json::to_vec(&base_json()).unwrap()).unwrap();
        std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o644)).unwrap();
        WorkdConfig::load(&config).expect("the owner's 0644 config is read");

        std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o664)).unwrap();
        match WorkdConfig::load(&config) {
            Err(ConfigError::Unsafe { detail, .. }) => assert!(detail.contains("0664")),
            other => panic!("a group-writable config must be refused, got {other:?}"),
        }
        std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o600)).unwrap();
        let link = dir.join("linked.json");
        std::os::unix::fs::symlink(&config, &link).unwrap();
        match WorkdConfig::load(&link) {
            Err(ConfigError::Unsafe { detail, .. }) => assert!(detail.contains("symbolic link")),
            other => panic!("a symlinked config must be refused, got {other:?}"),
        }
        match HostState::load(&link) {
            Err(ConfigError::Unsafe { .. }) => {}
            other => panic!("a symlinked state must be refused, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
