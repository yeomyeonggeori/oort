//! From "I have a host key" to "I am the box host and the owner has confirmed me" (ADR-0197 D2, M4 증보 2).
//!
//! 1. **Registration.** A box that was attested before keeps its registration on the persistent key mount
//!    (`registered.json`) and does not register again. Otherwise it proves the pairing code (read from the runner's
//!    read-only inject directory) with a MAC and waits for the runner's attestation ([`crate::enroll`]).
//! 2. **The owner's first device list**, as the runner placed it in the inject directory. It is the only thing that
//!    confirms a host (`BoxHost::confirm_owner`); a list the server relays later changes nothing without an owner
//!    signature. This module is shared by `main.rs` and the end-to-end tests, so what runs in a box is what is
//!    tested.
//!
//! Every file goes through the [`FsGate`], like everything else the agent reads or writes.

use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use uuid::Uuid;

use crate::enroll::{register_until_active, EnrollError, Enrollment};
use crate::fsgate::{FsError, FsGate};
use crate::host::{BoxHost, HostError, RunnerLocalOwnerList};
use crate::register::PairingSecret;

#[derive(Debug, thiserror::Error)]
pub enum BootError {
    #[error("no pairing code and no earlier registration: {0}")]
    NoPairing(String),
    #[error("the pairing code is not 32 bytes of base64")]
    BadPairingCode,
    #[error("no owner device list: {0}")]
    NoOwnerList(String),
    #[error("the owner device list is not base64")]
    BadOwnerList,
    #[error("registration: {0}")]
    Enroll(#[from] EnrollError),
    #[error("{0}")]
    Host(#[from] HostError),
    #[error("{0}")]
    Fs(#[from] FsError),
    #[error("the stored registration is not JSON")]
    BadRegistration,
}

#[derive(Debug, Clone)]
pub struct BootEnv {
    pub server_url: String,
    pub workspace_id: Uuid,
    pub box_id: Uuid,
    /// The runner's read-only inject directory (`/run/oort-runner`).
    pub inject_dir: PathBuf,
    /// The agent's persistent state (`registered.json`, `nonces.bin`).
    pub state_dir: PathBuf,
    pub give_up_after: Duration,
    pub poll: Duration,
}

fn not_found(error: &FsError) -> bool {
    matches!(error, FsError::Io { source, .. } if source.kind() == std::io::ErrorKind::NotFound)
}

/// Register (or recall the registration), then confirm the owner. Returns the box host's id.
pub async fn enroll_and_confirm(
    host: &mut BoxHost,
    gate: &FsGate,
    env: &BootEnv,
) -> Result<Uuid, BootError> {
    let public = host.host_public_key();
    let public_b64 = BASE64.encode(public);
    let registered_path = env.state_dir.join("registered.json");
    let answer: serde_json::Value = match gate.read(&registered_path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| BootError::BadRegistration)?,
        Err(error) if not_found(&error) => {
            let code_text = gate
                .read(&env.inject_dir.join("pairing.code"))
                .map_err(|error| BootError::NoPairing(error.to_string()))?;
            let secret = PairingSecret::from_file_text(&String::from_utf8_lossy(&code_text))
                .ok_or(BootError::BadPairingCode)?;
            let answer = register_until_active(
                &Enrollment {
                    server_url: &env.server_url,
                    workspace_id: env.workspace_id,
                    box_id: env.box_id,
                    host_public_key_b64: &public_b64,
                    host_public_key: public,
                },
                &secret,
                env.give_up_after,
                env.poll,
            )
            .await?;
            // The stored answer is the only thing a restart needs: no code, no secret.
            gate.write_private(&registered_path, answer.to_string().as_bytes())?;
            answer
        }
        Err(error) => return Err(error.into()),
    };
    host.record_registration(&answer)?;
    let list_text = gate
        .read(&env.inject_dir.join("owner-list.b64"))
        .map_err(|error| BootError::NoOwnerList(error.to_string()))?;
    let list_bytes = BASE64
        .decode(String::from_utf8_lossy(&list_text).trim())
        .map_err(|_| BootError::BadOwnerList)?;
    host.confirm_owner(RunnerLocalOwnerList::from_bytes(&list_bytes)?)?;
    host.registered()
        .and_then(|registered| Uuid::parse_str(&registered.host_id).ok())
        .ok_or(BootError::BadRegistration)
}

/// Where the spent-challenge store lives under a state directory.
pub fn nonce_path(state_dir: &Path) -> PathBuf {
    state_dir.join("nonces.bin")
}
