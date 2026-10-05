//! What the runner hands a box beyond its volume, and what it keeps for the box's registration
//! (ADR-0197 D2/D8, M4 증보 2). **Runner-generated, runner-local, never from the server's text.**
//!
//! Per box, under `<stateDir>/boxes/<box id>/inject/` (mounted read-only at `/run/oort-runner`, root-owned,
//! readable only by the box-agent's group):
//!
//! | file | what | who reads it |
//! |---|---|---|
//! | `seal.key` | 32 CSPRNG bytes, b64: the key the box seals its host key with (D8). Born here, **destroyed on delete** (the crypto-shred anchor) | the box-agent installs it on tmpfs |
//! | `pairing.code` | 32 CSPRNG bytes, b64: the one-time code. Never leaves this machine and the box; the registration MAC proves the box holds it | the box-agent (HMAC key), this runner (verifier) |
//! | `owner-list.b64` | the box's first owner `DeviceList` as the server relayed it (opaque, public) | the box-agent (bootstrap) |
//!
//! The pairing code is **spent** the moment the runner attests the box's host key: the file is deleted, so the
//! box's own copy disappears with it. The runner never reads anything a box wrote; the only box-side directory it
//! touches is the `hostKeyRoot` entry it creates and, on delete, removes (`tests/no_volume_reads.rs` pins that).

use std::io::Write as _;
use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use uuid::Uuid;

use crate::client::{ClientError, ServerApi};
use crate::config::{PrepareKeyDirs, RunnerConfig};
use crate::template::{BoxMounts, AGENT_UID};

#[derive(Debug, thiserror::Error)]
pub enum ProvisionError {
    #[error("the server has no first owner device list for this box")]
    NoOwnerList,
    #[error(transparent)]
    Server(#[from] ClientError),
    #[error("cannot prepare the box's inject directory: {0}")]
    Io(String),
}

/// How a `create` gets what the box needs, and how a registration is checked afterwards. A trait so the executor
/// and the runner loop are testable without a filesystem of root-owned files.
#[async_trait]
pub trait Provisioner: Send + Sync {
    /// Everything the box's `create` needs: the owner list from the server, the seal key and the pairing code
    /// (created once, kept across a restart), and the persistent key directories when configured.
    async fn prepare(&self, box_id: Uuid) -> Result<BoxMounts, ProvisionError>;
    /// The pairing code of a box that has not registered yet.
    fn pairing_code(&self, box_id: Uuid) -> Option<Vec<u8>>;
    /// The runner attested this box's host key: the code is spent.
    fn mark_registered(&self, box_id: Uuid);
    /// The box is gone: destroy the seal key and everything else kept for it.
    fn forget(&self, box_id: Uuid);
}

pub struct HostProvisioner {
    cfg: Arc<RunnerConfig>,
    server: Arc<dyn ServerApi>,
    /// Hand the files to the box-agent's group. Production always does; tests on a machine that is not the
    /// runner host turn it off.
    chown: bool,
}

fn random_b64() -> Result<String, ProvisionError> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|error| ProvisionError::Io(error.to_string()))?;
    Ok(format!("{}\n", BASE64.encode(bytes)))
}

impl HostProvisioner {
    pub fn new(cfg: Arc<RunnerConfig>, server: Arc<dyn ServerApi>) -> Self {
        HostProvisioner {
            cfg,
            server,
            chown: true,
        }
    }

    /// For tests on a machine where the runner is not root: skip handing files to the agent's gid.
    pub fn without_chown(mut self) -> Self {
        self.chown = false;
        self
    }

    fn box_dir(&self, box_id: Uuid) -> PathBuf {
        self.cfg
            .state_dir
            .join("boxes")
            .join(box_id.as_hyphenated().to_string())
    }

    pub fn inject_dir(&self, box_id: Uuid) -> PathBuf {
        self.box_dir(box_id).join("inject")
    }

    fn registered_marker(&self, box_id: Uuid) -> PathBuf {
        self.box_dir(box_id).join("registered")
    }

    fn io(error: std::io::Error) -> ProvisionError {
        ProvisionError::Io(error.to_string())
    }

    fn give_to_agent(&self, path: &Path, uid: Option<u32>) -> Result<(), ProvisionError> {
        if !self.chown {
            return Ok(());
        }
        use std::os::unix::ffi::OsStrExt as _;
        let c_path = std::ffi::CString::new(path.as_os_str().as_bytes())
            .map_err(|_| ProvisionError::Io("path has a NUL".into()))?;
        // SAFETY: a valid NUL-terminated path; `u32::MAX` leaves the owner unchanged.
        let rc = unsafe { libc::chown(c_path.as_ptr(), uid.unwrap_or(u32::MAX), AGENT_UID) };
        if rc != 0 {
            return Err(Self::io(std::io::Error::last_os_error()));
        }
        Ok(())
    }

    /// Write `bytes` atomically: 0440, group = the box-agent, owner stays the runner (root).
    fn write_for_agent(&self, path: &Path, bytes: &[u8]) -> Result<(), ProvisionError> {
        let temp = path.with_extension("tmp");
        let _ = std::fs::remove_file(&temp);
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o440)
            .open(&temp)
            .map_err(Self::io)?;
        file.write_all(bytes).map_err(Self::io)?;
        file.sync_all().map_err(Self::io)?;
        self.give_to_agent(&temp, None)?;
        std::fs::rename(&temp, path).map_err(Self::io)
    }

    fn ensure_dir(&self, path: &Path, mode: u32, group_to_agent: bool) -> Result<(), ProvisionError> {
        std::fs::create_dir_all(path).map_err(Self::io)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).map_err(Self::io)?;
        if group_to_agent {
            self.give_to_agent(path, None)?;
        }
        Ok(())
    }

    fn prepare_key_dirs(&self, box_id: Uuid) -> Result<Option<PathBuf>, ProvisionError> {
        let Some(root) = &self.cfg.host_key_root else {
            return Ok(None);
        };
        let dir = root.path.join(box_id.as_hyphenated().to_string());
        if root.prepare == PrepareKeyDirs::Runner {
            for path in [dir.clone(), dir.join("key"), dir.join("state")] {
                std::fs::create_dir_all(&path).map_err(Self::io)?;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
                    .map_err(Self::io)?;
                // The box-agent's uid and gid own what it keeps.
                if self.chown {
                    use std::os::unix::ffi::OsStrExt as _;
                    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes())
                        .map_err(|_| ProvisionError::Io("path has a NUL".into()))?;
                    // SAFETY: a valid NUL-terminated path.
                    let rc = unsafe { libc::chown(c_path.as_ptr(), AGENT_UID, AGENT_UID) };
                    if rc != 0 {
                        return Err(Self::io(std::io::Error::last_os_error()));
                    }
                }
            }
        }
        Ok(Some(dir))
    }
}

#[async_trait]
impl Provisioner for HostProvisioner {
    async fn prepare(&self, box_id: Uuid) -> Result<BoxMounts, ProvisionError> {
        let list = match self.server.provisioning(box_id).await {
            Ok(list) => list,
            Err(ClientError::Status(404)) | Err(ClientError::NotEnabled) => {
                return Err(ProvisionError::NoOwnerList)
            }
            Err(error) => return Err(error.into()),
        };
        let boxes = self.state_dir_boxes();
        self.ensure_dir(&self.cfg.state_dir, 0o700, false)?;
        self.ensure_dir(&boxes, 0o700, false)?;
        self.ensure_dir(&self.box_dir(box_id), 0o700, false)?;
        let inject = self.inject_dir(box_id);
        self.ensure_dir(&inject, 0o750, true)?;
        // The owner list is public and immutable once the create control was handed out: rewrite it.
        self.write_for_agent(&inject.join("owner-list.b64"), format!("{}\n", BASE64.encode(list)).as_bytes())?;
        // The seal key lives as long as the box does: created once, kept across a restart.
        let seal = inject.join("seal.key");
        if !seal.exists() {
            self.write_for_agent(&seal, random_b64()?.as_bytes())?;
        }
        // The pairing code only until the box registered.
        let code = inject.join("pairing.code");
        if !code.exists() && !self.registered_marker(box_id).exists() {
            self.write_for_agent(&code, random_b64()?.as_bytes())?;
        }
        let key_dir = self.prepare_key_dirs(box_id)?;
        Ok(BoxMounts {
            inject_dir: inject,
            key_dir,
        })
    }

    fn pairing_code(&self, box_id: Uuid) -> Option<Vec<u8>> {
        let text = std::fs::read_to_string(self.inject_dir(box_id).join("pairing.code")).ok()?;
        BASE64.decode(text.trim()).ok().filter(|code| code.len() == 32)
    }

    fn mark_registered(&self, box_id: Uuid) {
        let _ = std::fs::write(self.registered_marker(box_id), b"registered\n");
        let _ = std::fs::remove_file(self.inject_dir(box_id).join("pairing.code"));
    }

    fn forget(&self, box_id: Uuid) {
        // The seal key first: from here on every copy of the box's sealed host key is ciphertext with no key.
        let _ = std::fs::remove_file(self.inject_dir(box_id).join("seal.key"));
        let _ = std::fs::remove_dir_all(self.box_dir(box_id));
        if let Some(root) = &self.cfg.host_key_root {
            if root.prepare == PrepareKeyDirs::Runner {
                let _ = std::fs::remove_dir_all(root.path.join(box_id.as_hyphenated().to_string()));
            }
        }
    }
}

impl HostProvisioner {
    fn state_dir_boxes(&self) -> PathBuf {
        self.cfg.state_dir.join("boxes")
    }
}
