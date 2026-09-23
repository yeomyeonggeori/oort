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
use std::io::Write as _;
use std::os::unix::fs::OpenOptionsExt as _;
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
        let raw = std::fs::read_to_string(path).map_err(|source| ConfigError::Io {
            path: path.display().to_string(),
            source,
        })?;
        let config: Self = serde_json::from_str(&raw).map_err(|error| ConfigError::Parse {
            path: path.display().to_string(),
            message: error.to_string(),
        })?;
        config.validate()?;
        Ok(config)
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
            if policy::check_adapter_admitted(entry.adapter).is_err() {
                // #2602 M-2: said at startup, not only as a refused control.
                return invalid(format!(
                    "tools.{key}: the {:?} adapter is not admitted for remote sessions \
                     (no mode asks before every command and write; ADR-0188 D6)",
                    entry.adapter
                ));
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
        let raw = std::fs::read_to_string(path).map_err(|source| ConfigError::Io {
            path: path.display().to_string(),
            source,
        })?;
        serde_json::from_str(&raw).map_err(|error| ConfigError::Parse {
            path: path.display().to_string(),
            message: error.to_string(),
        })
    }

    /// Written with `0600` via a sibling + rename, like the dev key file.
    pub fn save(&self, path: &Path) -> Result<(), ConfigError> {
        let io = |source: std::io::Error| ConfigError::Io {
            path: path.display().to_string(),
            source,
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(io)?;
        }
        let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
        let _ = std::fs::remove_file(&temporary);
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(io)?;
        let body = serde_json::to_vec_pretty(self).expect("HostState serialises");
        file.write_all(&body)
            .and_then(|()| file.write_all(b"\n"))
            .and_then(|()| file.sync_all())
            .map_err(io)?;
        drop(file);
        std::fs::rename(&temporary, path).map_err(io)
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
        assert_eq!(config.server_base(), "https://oort.example.com");
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
    fn a_codex_tool_entry_is_refused_at_load() {
        let mut value = base_json();
        value["tools"]["codex"] = serde_json::json!({
            "adapter": "codex", "executable": "/usr/local/bin/codex-acp"
        });
        match parse(value) {
            Err(ConfigError::Invalid(message)) => {
                assert!(message.contains("not admitted"), "{message}")
            }
            other => panic!("a codex entry must be refused, got {other:?}"),
        }
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
}
