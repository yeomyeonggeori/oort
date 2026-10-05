//! The quarantine ledger: the runner's own memory of volumes it stopped because the server
//! does not know them (ADR-0197 D10 「격리」), whether an operator confirmed their
//! destruction, and when it last destroyed one. A small JSON file in the runner's state
//! directory, `0600`, replaced atomically. It holds box ids and times — nothing from a box.

use std::collections::BTreeMap;
use std::io::Write as _;
use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

const FILE: &str = "quarantine.json";
const DAY_SECONDS: u64 = 86_400;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    /// Unix seconds the volume was first quarantined.
    pub quarantined_at: u64,
    /// An operator ran `confirm-shred` for it.
    #[serde(default)]
    pub confirmed: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Ledger {
    #[serde(default)]
    pub entries: BTreeMap<Uuid, Entry>,
    /// Unix seconds of each volume the orphan path destroyed (pruned past a day on write).
    #[serde(default)]
    pub shredded: Vec<u64>,
    /// Unix seconds of each box deletion this runner carried out (pruned past a day on write).
    #[serde(default)]
    pub deleted: Vec<u64>,
}

#[derive(Debug, thiserror::Error)]
pub enum LedgerError {
    #[error("ledger {0}: {1}")]
    Io(PathBuf, String),
    #[error("ledger {0} is not valid; refusing to start from an empty one: {1}")]
    Corrupt(PathBuf, String),
}

pub fn path_in(state_dir: &Path) -> PathBuf {
    state_dir.join(FILE)
}

impl Ledger {
    /// Load the ledger; a missing file is an empty one, a damaged file is an error (an
    /// empty ledger would forget quarantines and restart every grace period).
    pub fn load(state_dir: &Path) -> Result<Ledger, LedgerError> {
        let path = path_in(state_dir);
        match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text)
                .map_err(|error| LedgerError::Corrupt(path, error.to_string())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Ledger::default()),
            Err(error) => Err(LedgerError::Io(path, error.to_string())),
        }
    }

    /// Write the ledger atomically with mode 0600.
    pub fn save(&self, state_dir: &Path) -> Result<(), LedgerError> {
        let path = path_in(state_dir);
        let io = |error: std::io::Error| LedgerError::Io(path.clone(), error.to_string());
        std::fs::create_dir_all(state_dir).map_err(io)?;
        std::fs::set_permissions(state_dir, std::fs::Permissions::from_mode(0o700)).map_err(io)?;
        let temp = state_dir.join(format!("{FILE}.tmp"));
        let text = serde_json::to_string_pretty(self)
            .map_err(|error| LedgerError::Corrupt(path.clone(), error.to_string()))?;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&temp)
            .map_err(io)?;
        file.write_all(text.as_bytes()).map_err(io)?;
        file.sync_all().map_err(io)?;
        std::fs::rename(&temp, &path).map_err(io)
    }

    /// Volumes destroyed by the orphan path in the 24 hours before `now`.
    pub fn shredded_in_last_day(&self, now: u64) -> u32 {
        self.shredded
            .iter()
            .filter(|at| now.saturating_sub(**at) < DAY_SECONDS)
            .count() as u32
    }

    /// Box deletions carried out in the 24 hours before `now`.
    pub fn deleted_in_last_day(&self, now: u64) -> u32 {
        self.deleted
            .iter()
            .filter(|at| now.saturating_sub(**at) < DAY_SECONDS)
            .count() as u32
    }

    pub fn record_delete(&mut self, now: u64) {
        self.deleted
            .retain(|at| now.saturating_sub(*at) < DAY_SECONDS);
        self.deleted.push(now);
    }

    pub fn record_shred(&mut self, now: u64) {
        self.shredded
            .retain(|at| now.saturating_sub(*at) < DAY_SECONDS);
        self.shredded.push(now);
    }
}
