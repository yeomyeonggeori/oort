//! The runner's own configuration (ADR-0197 D2): **what a box runs lives here, not in a
//! server control.** Image, name prefix, network, DNS, local limit caps, the workspace
//! this runner serves, where its credential file is. One JSON file, closed
//! (`deny_unknown_fields`), validated before anything starts.
//!
//! The credential is not in this file: `credentialFile` names a separate file that must be
//! a regular file, owned by the runner's uid, with no group/other access.

use std::net::IpAddr;
use std::os::unix::fs::MetadataExt as _;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use uuid::Uuid;

use crate::wire::Limits;

/// How the 10 GB disk limit is applied to a box volume.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiskQuota {
    /// The operator attests the Docker data root is xfs with project quotas: the volume is
    /// created with `--opt size=<disk>g`, and Docker refuses it otherwise.
    LocalDriverSize,
    /// Dev only: the disk limit is **not enforced**. Written out so nobody gets there by
    /// forgetting a field.
    UnenforcedDev,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShredConfig {
    /// Days a quarantined orphan volume waits before it can be destroyed (ADR-0197 D10: 14).
    #[serde(default = "default_grace_days")]
    pub grace_days: u32,
    /// The most volumes destroyed in any rolling 24 hours by the orphan path
    /// (D10 「파기 비율 상한」). Zero means the orphan path never destroys anything.
    #[serde(default = "default_daily_cap")]
    pub daily_cap: u32,
    /// Overwrite files in a box volume before removing it on `delete` (best effort; the
    /// key destruction of D10 is S4/M4's, and is a residual risk until then).
    #[serde(default = "default_true")]
    pub on_delete: bool,
    /// The most box deletions this runner carries out in any rolling 24 hours, whoever asked
    /// (#3509 review M5): a compromised server cannot wipe every box in one sweep. Over the cap a
    /// `delete` control is refused and reported failed (the box stays `delete_failed`).
    #[serde(default = "default_delete_cap")]
    pub delete_daily_cap: u32,
}

impl Default for ShredConfig {
    fn default() -> Self {
        ShredConfig {
            grace_days: default_grace_days(),
            daily_cap: default_daily_cap(),
            on_delete: true,
            delete_daily_cap: default_delete_cap(),
        }
    }
}

fn default_grace_days() -> u32 {
    14
}
fn default_daily_cap() -> u32 {
    2
}
fn default_delete_cap() -> u32 {
    10
}
fn default_true() -> bool {
    true
}
fn default_prefix() -> String {
    "momo-box-".to_string()
}
fn default_dns() -> Vec<String> {
    vec!["1.1.1.1".to_string(), "9.9.9.9".to_string()]
}
fn default_caps() -> Limits {
    Limits::ADR_CEILING
}
fn default_poll() -> u64 {
    5
}
fn default_reconcile() -> u64 {
    300
}
fn default_docker() -> String {
    "docker".to_string()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunnerConfig {
    /// `https://…`. `http://` only with `allowInsecureLoopback` and a loopback host.
    pub server_url: String,
    /// The one workspace this runner serves (D2: one runner host, one workspace).
    pub workspace_id: Uuid,
    /// File holding the runner credential (`oort_runner.…`).
    pub credential_file: PathBuf,
    /// The pinned box image: `name@sha256:<64 hex>` or a local image id `sha256:<64 hex>`.
    /// A tag is refused.
    pub image: String,
    /// Prefix of every container/volume name: `<prefix><box uuid>`.
    #[serde(default = "default_prefix")]
    pub name_prefix: String,
    /// The pre-created docker network every box joins (an `icc=false` bridge the install
    /// runbook sets up and the egress rules apply to).
    pub network: String,
    #[serde(default = "default_dns")]
    pub dns: Vec<String>,
    /// Local limit caps; a control above any of them is refused. Cannot exceed the ADR D3
    /// ceiling.
    #[serde(default = "default_caps")]
    pub caps: Limits,
    pub disk_quota: DiskQuota,
    /// Where the quarantine ledger lives.
    pub state_dir: PathBuf,
    #[serde(default)]
    pub allow_insecure_loopback: bool,
    #[serde(default = "default_poll")]
    pub poll_interval_seconds: u64,
    #[serde(default = "default_reconcile")]
    pub reconcile_interval_seconds: u64,
    #[serde(default)]
    pub shred: ShredConfig,
    #[serde(default = "default_docker")]
    pub docker_bin: String,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ConfigError {
    #[error("config is not valid JSON of the closed shape: {0}")]
    Shape(String),
    #[error(
        "image must be pinned by digest (`name@sha256:<64 hex>` or `sha256:<64 hex>`), not a tag"
    )]
    ImageNotPinned,
    #[error("namePrefix must be 1-24 characters of [a-z0-9-], starting with a letter")]
    BadPrefix,
    #[error("network must be a docker network name ([A-Za-z0-9][A-Za-z0-9_.-]*)")]
    BadNetwork,
    #[error("serverUrl must be https (http only for a loopback host with allowInsecureLoopback)")]
    InsecureServer,
    #[error("dns entries must be IP addresses")]
    BadDns,
    #[error("caps must be positive and no higher than the ADR-0197 D3 ceiling (1 vCPU, 2048 MB, 10 GB, 512 pids)")]
    BadCaps,
    #[error("poll and reconcile intervals must be at least 1 second")]
    BadInterval,
}

fn is_hex64(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_name_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-')
}

impl RunnerConfig {
    pub fn parse(text: &str) -> Result<RunnerConfig, ConfigError> {
        let config: RunnerConfig =
            serde_json::from_str(text).map_err(|error| ConfigError::Shape(error.to_string()))?;
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<(), ConfigError> {
        // An image reference that starts with `-` would be read by docker as a flag.
        if self.image.starts_with('-') {
            return Err(ConfigError::ImageNotPinned);
        }
        let digest_ok = match self.image.rsplit_once("@sha256:") {
            Some((name, digest)) => !name.is_empty() && is_hex64(digest),
            None => self.image.strip_prefix("sha256:").is_some_and(is_hex64),
        };
        if !digest_ok {
            return Err(ConfigError::ImageNotPinned);
        }
        let prefix = self.name_prefix.as_bytes();
        let prefix_ok = (1..=24).contains(&prefix.len())
            && prefix[0].is_ascii_lowercase()
            && prefix
                .iter()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-');
        if !prefix_ok {
            return Err(ConfigError::BadPrefix);
        }
        let network = self.network.as_bytes();
        if network.is_empty()
            || !network[0].is_ascii_alphanumeric()
            || !network.iter().all(|b| is_name_char(*b))
        {
            return Err(ConfigError::BadNetwork);
        }
        let https = self.server_url.starts_with("https://");
        let loopback_http = self.allow_insecure_loopback
            && ["http://127.0.0.1", "http://localhost", "http://[::1]"]
                .iter()
                .any(|p| {
                    self.server_url
                        .strip_prefix(p)
                        .is_some_and(|rest| rest.is_empty() || rest.starts_with([':', '/']))
                });
        if !(https || loopback_http) {
            return Err(ConfigError::InsecureServer);
        }
        if self.dns.is_empty() || self.dns.iter().any(|d| d.parse::<IpAddr>().is_err()) {
            return Err(ConfigError::BadDns);
        }
        if !self.caps.all_positive() || !self.caps.within(&Limits::ADR_CEILING) {
            return Err(ConfigError::BadCaps);
        }
        if self.poll_interval_seconds == 0 || self.reconcile_interval_seconds == 0 {
            return Err(ConfigError::BadInterval);
        }
        Ok(())
    }

    /// Container and volume name for a box.
    pub fn resource_name(&self, box_id: Uuid) -> String {
        format!("{}{}", self.name_prefix, box_id.as_hyphenated())
    }

    /// The box id a resource name encodes, if it is exactly `<prefix><uuid>` — the only
    /// names this runner will ever touch.
    pub fn box_id_of_name(&self, name: &str) -> Option<Uuid> {
        let id = name.strip_prefix(&self.name_prefix)?;
        let parsed = Uuid::parse_str(id).ok()?;
        (parsed.as_hyphenated().to_string() == id).then_some(parsed)
    }
}

/// Read the config file. The runner's only file reads are this, the credential file and
/// the quarantine ledger; `tests/no_volume_reads.rs` keeps it so.
pub fn load_config(path: &Path) -> Result<RunnerConfig, ConfigError> {
    let text = std::fs::read_to_string(path)
        .map_err(|error| ConfigError::Shape(format!("cannot read {}: {error}", path.display())))?;
    RunnerConfig::parse(&text)
}

#[derive(Debug, thiserror::Error)]
pub enum CredentialError {
    #[error("cannot read the credential file: {0}")]
    Unreadable(String),
    #[error(
        "the credential file must be a regular file owned by this user with no group/other access"
    )]
    Permissions,
    #[error("the credential file does not hold a runner credential")]
    NotACredential,
}

/// Load the runner credential. Refuses a file anyone else could read.
pub fn load_credential(path: &Path) -> Result<String, CredentialError> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| CredentialError::Unreadable(error.to_string()))?;
    // SAFETY: geteuid has no failure mode.
    let me = unsafe { libc::geteuid() };
    if !metadata.file_type().is_file() || metadata.uid() != me || metadata.mode() & 0o077 != 0 {
        return Err(CredentialError::Permissions);
    }
    let text = std::fs::read_to_string(path)
        .map_err(|error| CredentialError::Unreadable(error.to_string()))?;
    let token = text.trim().to_string();
    if !token.starts_with("oort_runner.") || token.contains(char::is_whitespace) {
        return Err(CredentialError::NotACredential);
    }
    Ok(token)
}
