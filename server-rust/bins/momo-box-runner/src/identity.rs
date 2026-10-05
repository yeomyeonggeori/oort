//! The runner's Ed25519 identity (ADR-0197 D5 chain step 1, M4 증보 2).
//!
//! The runner is the trust anchor a member pins **by fingerprint, out of band**: a runner operator reads the
//! fingerprint off this machine's console (`momo-box-runner init-identity`, and once at start) and tells the
//! member in a channel that is not oort. The seed lives in one 0600 file the runner owns; the server only ever
//! sees the public key (and, because the server is not trusted, the member's device computes the fingerprint from
//! the key bytes itself instead of being told one).
//!
//! This is the one place the runner signs: [`RunnerIdentity::attest_host`] says "I (the runner) made this host
//! key for this box". It signs only after the registration MAC proved the key came from the box that holds the
//! pairing code the runner injected (`provision.rs`, `runner.rs`).

use std::io::Write as _;
use std::os::unix::fs::{MetadataExt as _, OpenOptionsExt as _};
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use momo_blind_pty::trust::Runner;
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum IdentityError {
    #[error("identity file {0}: {1}")]
    Io(PathBuf, String),
    #[error("the identity file must be a regular file owned by this user with no group/other access")]
    Permissions,
    #[error("the identity file does not hold a 32-byte base64 seed")]
    Malformed,
    #[error("an identity already exists at {0}; refusing to replace the runner's key")]
    Exists(PathBuf),
}

pub struct RunnerIdentity {
    runner: Runner,
}

impl std::fmt::Debug for RunnerIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The seed is not printable from here, and the fingerprint is the thing meant to be seen.
        f.debug_struct("RunnerIdentity")
            .field("fingerprint", &self.fingerprint_hex())
            .finish()
    }
}

impl RunnerIdentity {
    /// Create a fresh identity at `path` (`create_new`: never overwrites a key).
    pub fn create(path: &Path) -> Result<RunnerIdentity, IdentityError> {
        let io = |error: std::io::Error| IdentityError::Io(path.to_path_buf(), error.to_string());
        let mut seed = [0u8; 32];
        getrandom::getrandom(&mut seed).map_err(|error| IdentityError::Io(path.to_path_buf(), error.to_string()))?;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    IdentityError::Exists(path.to_path_buf())
                } else {
                    io(error)
                }
            })?;
        file.write_all(format!("{}\n", BASE64.encode(seed)).as_bytes())
            .map_err(io)?;
        file.sync_all().map_err(io)?;
        Ok(RunnerIdentity {
            runner: Runner::from_seed(seed),
        })
    }

    /// Load the identity. Refuses a file anyone else could read.
    pub fn load(path: &Path) -> Result<RunnerIdentity, IdentityError> {
        let io = |error: std::io::Error| IdentityError::Io(path.to_path_buf(), error.to_string());
        let metadata = std::fs::symlink_metadata(path).map_err(io)?;
        // SAFETY: geteuid has no failure mode.
        let me = unsafe { libc::geteuid() };
        if !metadata.file_type().is_file() || metadata.uid() != me || metadata.mode() & 0o077 != 0 {
            return Err(IdentityError::Permissions);
        }
        let text = std::fs::read_to_string(path).map_err(io)?;
        let seed: [u8; 32] = BASE64
            .decode(text.trim())
            .ok()
            .and_then(|bytes| bytes.try_into().ok())
            .ok_or(IdentityError::Malformed)?;
        Ok(RunnerIdentity {
            runner: Runner::from_seed(seed),
        })
    }

    pub fn public_key(&self) -> [u8; 32] {
        self.runner.public()
    }

    pub fn public_key_b64(&self) -> String {
        BASE64.encode(self.public_key())
    }

    /// SHA-256 of the public key, lowercase hex. The member's device computes exactly this from the key bytes.
    pub fn fingerprint_hex(&self) -> String {
        hex::encode(self.runner.fingerprint())
    }

    /// The runner made `host_pub` for `box_id`.
    pub fn attest_host(&self, box_id: Uuid, host_pub: &[u8; 32]) -> [u8; 64] {
        self.runner.attest_host(box_id.as_bytes(), host_pub)
    }
}
