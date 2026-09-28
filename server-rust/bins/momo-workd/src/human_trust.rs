//! The host's half of R2 — ADR-0146 개정 2026-09-28, D-6 · D-7 · D-9 · D-10
//! (#3024). **The security boundary is here, not on the server.**
//!
//! Three things live in the host state folder (beside `state_path`), each a
//! `0600` file written by sibling + rename ([`crate::config::write_private_file`]):
//!
//! * `human-trust.json` — the **pinned root**: the Secure Enclave P-256 key of
//!   the desktop app on this Mac, handed over once on the code-signed control
//!   socket (`pin_root`, [`crate::control_socket`]). Nothing the server sends
//!   can set or change it; a different key is refused (`root_already_pinned`)
//!   and only a local reset (`momo-workd reset-root`, or `forget` + register)
//!   clears it. Also the revoked keys and the key-id ↔ public-key bindings.
//! * `human-nonces.json` — every nonce this host consumed, kept until its
//!   control has expired, so a restart does not reopen a replay window (D-9).
//!
//! ## Checking a control ([`HumanTrust::check_control`])
//!
//! The host never takes the server's word for what was signed. It rebuilds the
//! 13 `momo.human.control.v1` lines from **the control it would act on** — its
//! workspace, requester, target host, session, kind, and the payload text /
//! label / permission decision — plus the envelope's own fields (instance id,
//! key id, nonce, times, mode, scope, spawn ids), and verifies the device
//! signature over those bytes. Then:
//!
//! 1. the key is the pinned root, or carries a `device_endorse.v1` signed by
//!    the pinned root over **this** public key, workspace and owner;
//! 2. neither the key id nor the public key is revoked;
//! 3. a public key keeps the first key id it was seen under, and a key id its
//!    first public key (an endorsement binds a public key while a revocation
//!    names a key id; without this a revoked key could come back under a new
//!    id);
//! 4. the time window holds on the host clock (±5 min, ≤10 min lifetime);
//! 5. the nonce is new — and it is written to disk **before** the control is
//!    acted on.
//!
//! ## Envelope (`WorkControl.humanSignature`, camelCase)
//!
//! ```text
//! { "alg": "p256", "instanceId": "…", "deviceKeyId": uuid,
//!   "devicePublicKey": b64(33-byte compressed SEC1),
//!   "endorsement": { "rootKeyId": uuid, "label": "…", "signature": b64(r‖s) } | absent (root),
//!   "nonce": uuid, "issuedAtMs": i64, "expiresAtMs": i64,
//!   "mode": "queue"|"interrupt"   (input),
//!   "scope": "once"|"session"      (permission),
//!   "agentMemberId": uuid, "folderId": "…"   (spawn),
//!   "signature": b64(r‖s) }
//! ```
//!
//! ## Revocation (`device_revoke.v1`, local socket or `pendingControls.deviceRevocations`)
//!
//! ```text
//! { "workspaceId", "memberId", "rootKeyId", "targetKeyId", "revokedAtMs",
//!   "signature": b64(r‖s), "targetPublicKey": b64 (required on the socket) }
//! ```

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use momo_wire::human_control::{
    check_control_window, parse_p256_public_key, ControlContent, DeviceEndorse, DeviceKeyAlg,
    DeviceRevoke, HumanControl, InputMode, PermissionScope, MAX_CLOCK_SKEW_MS, P256_PUBLIC_KEY_LEN,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::client::WorkControl;
use crate::config::{read_owned_file, write_private_file, ConfigError};
use crate::policy::Refusal;

pub const TRUST_FILE: &str = "human-trust.json";
pub const NONCE_FILE: &str = "human-nonces.json";
/// Consumed nonces kept at once. Each lives ≤ 10 min + skew; past this many
/// the host refuses closed rather than forget one.
pub const MAX_NONCES: usize = 4096;
/// The only device-key algorithm (ADR-0146 D-1).
pub const ALG_P256: &str = "p256";

/// Whose host this is: what every signed statement must name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrustIdentity {
    pub workspace_id: Uuid,
    pub owner_member_id: Uuid,
    pub host_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PinnedRoot {
    pub key_id: Uuid,
    pub alg: String,
    /// Canonical base64 of the 33-byte compressed point.
    pub public_key: String,
    pub pinned_at_ms: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrustState {
    root: Option<PinnedRoot>,
    #[serde(default)]
    revoked_key_ids: BTreeSet<Uuid>,
    #[serde(default)]
    revoked_public_keys: BTreeSet<String>,
    /// Public key → the one key id it has been seen under.
    #[serde(default)]
    key_ids: BTreeMap<String, Uuid>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NonceLedger {
    /// Nonce → the `expiresAtMs` of the control that consumed it.
    nonces: BTreeMap<Uuid, i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    alg: String,
    instance_id: String,
    device_key_id: Uuid,
    device_public_key: String,
    #[serde(default)]
    endorsement: Option<Endorsement>,
    nonce: Uuid,
    issued_at_ms: i64,
    expires_at_ms: i64,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    agent_member_id: Option<Uuid>,
    #[serde(default)]
    folder_id: Option<String>,
    signature: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Endorsement {
    root_key_id: Uuid,
    label: String,
    signature: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Revocation {
    workspace_id: Uuid,
    member_id: Uuid,
    root_key_id: Uuid,
    target_key_id: Uuid,
    revoked_at_ms: i64,
    signature: String,
    #[serde(default)]
    target_public_key: Option<String>,
}

/// The host's trust state. Shared by the control loop and the control socket.
#[derive(Debug)]
pub struct HumanTrust {
    identity: TrustIdentity,
    trust_path: PathBuf,
    nonce_path: PathBuf,
    state: TrustState,
    ledger: NonceLedger,
}

/// A 33-byte compressed P-256 key given as its canonical base64.
fn device_public_key(b64: &str) -> Option<Vec<u8>> {
    let bytes = BASE64.decode(b64).ok()?;
    if bytes.len() != P256_PUBLIC_KEY_LEN || BASE64.encode(&bytes) != b64 {
        return None;
    }
    parse_p256_public_key(&bytes).ok()?;
    Some(bytes)
}

fn load<T: Default + for<'de> Deserialize<'de>>(path: &Path) -> Result<T, ConfigError> {
    match read_owned_file(path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|error| ConfigError::Parse {
            path: path.display().to_string(),
            message: error.to_string(),
        }),
        Err(ConfigError::Io { source, .. }) if source.kind() == std::io::ErrorKind::NotFound => {
            Ok(T::default())
        }
        Err(error) => Err(error),
    }
}

fn save<T: Serialize>(path: &Path, value: &T) -> Result<(), ConfigError> {
    let mut body = serde_json::to_vec_pretty(value).expect("trust state serialises");
    body.push(b'\n');
    write_private_file(path, &body)
}

impl HumanTrust {
    /// Open the trust state kept in `state_dir`. Missing files are an empty
    /// state (nothing pinned); an unreadable or foreign-owned one is an error.
    pub fn open(state_dir: &Path, identity: TrustIdentity) -> Result<Self, ConfigError> {
        let trust_path = state_dir.join(TRUST_FILE);
        let nonce_path = state_dir.join(NONCE_FILE);
        Ok(Self {
            identity,
            state: load(&trust_path)?,
            ledger: load(&nonce_path)?,
            trust_path,
            nonce_path,
        })
    }

    pub fn identity(&self) -> TrustIdentity {
        self.identity
    }

    pub fn root(&self) -> Option<&PinnedRoot> {
        self.state.root.as_ref()
    }

    fn commit_state(&mut self, next: TrustState) -> Result<(), &'static str> {
        save(&self.trust_path, &next).map_err(|error| {
            tracing::error!(error = %error, "could not write the human trust state");
            "trust_unavailable"
        })?;
        self.state = next;
        Ok(())
    }

    /// Pin the desktop app's root key, once. The same key again is a no-op
    /// (`Ok(false)`); any other key is refused until a local reset.
    pub fn pin_root(
        &mut self,
        key_id: Uuid,
        alg: &str,
        public_key_b64: &str,
        now_ms: i64,
    ) -> Result<bool, &'static str> {
        if alg != ALG_P256 || device_public_key(public_key_b64).is_none() {
            return Err("invalid_root_key");
        }
        if let Some(root) = &self.state.root {
            return if root.key_id == key_id && root.public_key == public_key_b64 {
                Ok(false)
            } else {
                Err("root_already_pinned")
            };
        }
        if self.state.revoked_key_ids.contains(&key_id)
            || self.state.revoked_public_keys.contains(public_key_b64)
        {
            return Err("root_key_revoked");
        }
        let mut next = self.state.clone();
        next.root = Some(PinnedRoot {
            key_id,
            alg: alg.to_string(),
            public_key: public_key_b64.to_string(),
            pinned_at_ms: now_ms,
        });
        self.commit_state(next)?;
        tracing::info!(root_key_id = %key_id, "human root key pinned");
        Ok(true)
    }

    /// Forget the pinned root (local reset only). Revocations stay.
    pub fn reset_root(&mut self) -> Result<(), ConfigError> {
        let mut next = self.state.clone();
        next.root = None;
        save(&self.trust_path, &next)?;
        self.state = next;
        Ok(())
    }

    /// Apply a root-signed `device_revoke.v1`. `require_public_key` is set on
    /// the local socket, where the app knows the revoked device's public key
    /// and must give it, so a revoked key cannot return under a new id.
    pub fn apply_revocation(
        &mut self,
        raw: &Value,
        require_public_key: bool,
    ) -> Result<(), &'static str> {
        let revocation: Revocation =
            serde_json::from_value(raw.clone()).map_err(|_| "invalid_revocation")?;
        let root = self.state.root.clone().ok_or("root_not_pinned")?;
        if revocation.workspace_id != self.identity.workspace_id
            || revocation.member_id != self.identity.owner_member_id
        {
            return Err("revocation_not_for_this_host");
        }
        if revocation.root_key_id != root.key_id {
            return Err("revocation_not_from_root");
        }
        if revocation.target_key_id == root.key_id
            || revocation.target_public_key.as_deref() == Some(root.public_key.as_str())
        {
            return Err("revocation_targets_root");
        }
        let target_public_key = match revocation.target_public_key.as_deref() {
            Some(b64) => Some(
                device_public_key(b64)
                    .map(|_| b64.to_string())
                    .ok_or("invalid_revocation")?,
            ),
            None if require_public_key => return Err("revocation_public_key_required"),
            None => None,
        };
        let root_key = BASE64
            .decode(&root.public_key)
            .map_err(|_| "trust_unavailable")?;
        let signature = BASE64
            .decode(&revocation.signature)
            .map_err(|_| "revocation_signature_invalid")?;
        DeviceRevoke {
            workspace_id: revocation.workspace_id,
            member_id: revocation.member_id,
            root_key_id: revocation.root_key_id,
            target_key_id: revocation.target_key_id,
            revoked_at_ms: revocation.revoked_at_ms,
        }
        .verify(&root_key, &signature)
        .map_err(|_| "revocation_signature_invalid")?;

        let mut next = self.state.clone();
        next.revoked_key_ids.insert(revocation.target_key_id);
        // Every public key ever seen under the revoked id goes with it.
        let bound: Vec<String> = next
            .key_ids
            .iter()
            .filter(|(_, id)| **id == revocation.target_key_id)
            .map(|(key, _)| key.clone())
            .collect();
        next.revoked_public_keys.extend(bound);
        if let Some(key) = target_public_key {
            next.key_ids
                .entry(key.clone())
                .or_insert(revocation.target_key_id);
            next.revoked_public_keys.insert(key);
        }
        self.commit_state(next)?;
        tracing::info!(target_key_id = %revocation.target_key_id, "device key revoked on this host");
        Ok(())
    }

    /// ADR-0146 D-10: verify the person's signature on `control` and consume
    /// its nonce. `Ok` means the host may act on exactly this control.
    pub fn check_control(&mut self, control: &WorkControl, now_ms: i64) -> Result<(), Refusal> {
        let raw = control
            .human_signature
            .as_ref()
            .ok_or(Refusal::DeviceSignatureRequired)?;
        let envelope: Envelope =
            serde_json::from_value(raw.clone()).map_err(|_| Refusal::DeviceSignatureInvalid)?;
        let root = self
            .state
            .root
            .clone()
            .ok_or(Refusal::DeviceRootNotPinned)?;
        if envelope.alg != ALG_P256 {
            return Err(Refusal::DeviceSignatureInvalid);
        }
        // The control is for this host, from its owner, in its workspace —
        // those are also the lines the signature covers.
        if control.workspace_id != self.identity.workspace_id
            || control.target_host_id != self.identity.host_id
        {
            return Err(Refusal::DeviceSignatureInvalid);
        }
        if control.requester_member_id != self.identity.owner_member_id {
            return Err(Refusal::RequesterNotOwner);
        }

        // Rebuild the content from what the host would act on.
        let payload = |key: &str| control.payload_str(key);
        let (content, session_id) = match control.kind.as_str() {
            "input" => {
                let mode = match envelope.mode.as_deref() {
                    Some("queue") => InputMode::Queue,
                    Some("interrupt") => InputMode::Interrupt,
                    _ => return Err(Refusal::DeviceSignatureInvalid),
                };
                let text = payload("text").ok_or(Refusal::InvalidControl)?;
                (ControlContent::Input { mode, text }, control.session_id)
            }
            "spawn" => {
                let (Some(agent_member_id), Some(folder_id)) =
                    (envelope.agent_member_id, envelope.folder_id.as_deref())
                else {
                    return Err(Refusal::DeviceSignatureInvalid);
                };
                let first_prompt = payload("label").ok_or(Refusal::InvalidControl)?;
                (
                    ControlContent::Spawn {
                        agent_member_id,
                        folder_id,
                        first_prompt,
                    },
                    None,
                )
            }
            "permission" => {
                let scope = match envelope.scope.as_deref() {
                    Some("once") => PermissionScope::Once,
                    Some("session") => PermissionScope::Session,
                    _ => return Err(Refusal::DeviceSignatureInvalid),
                };
                let (Some(request_event_id), Some(option_id), Some(option_kind)) = (
                    payload("request_event_id").and_then(|raw| Uuid::parse_str(raw).ok()),
                    payload("option_id"),
                    payload("kind"),
                ) else {
                    return Err(Refusal::InvalidControl);
                };
                (
                    ControlContent::Permission {
                        request_event_id,
                        option_id,
                        option_kind,
                        scope,
                    },
                    control.session_id,
                )
            }
            _ => return Err(Refusal::UnsupportedControl),
        };
        let statement = HumanControl {
            instance_id: &envelope.instance_id,
            workspace_id: control.workspace_id,
            member_id: control.requester_member_id,
            device_key_id: envelope.device_key_id,
            host_id: control.target_host_id,
            session_id,
            nonce: envelope.nonce,
            issued_at_ms: envelope.issued_at_ms,
            expires_at_ms: envelope.expires_at_ms,
            content,
        };

        // 1. The key chains to the pinned root.
        let key = device_public_key(&envelope.device_public_key)
            .ok_or(Refusal::DeviceSignatureInvalid)?;
        let root_key = BASE64
            .decode(&root.public_key)
            .map_err(|_| Refusal::DeviceTrustUnavailable)?;
        if envelope.device_key_id == root.key_id {
            if envelope.device_public_key != root.public_key {
                return Err(Refusal::DeviceKeyNotEndorsed);
            }
        } else {
            if envelope.device_public_key == root.public_key {
                // The root's key under another id.
                return Err(Refusal::DeviceSignatureInvalid);
            }
            let endorsement = envelope
                .endorsement
                .as_ref()
                .ok_or(Refusal::DeviceKeyNotEndorsed)?;
            if endorsement.root_key_id != root.key_id {
                return Err(Refusal::DeviceKeyNotEndorsed);
            }
            let signature = BASE64
                .decode(&endorsement.signature)
                .map_err(|_| Refusal::DeviceKeyNotEndorsed)?;
            DeviceEndorse {
                workspace_id: self.identity.workspace_id,
                member_id: self.identity.owner_member_id,
                root_key_id: root.key_id,
                target_alg: DeviceKeyAlg::P256,
                target_public_key_b64: &envelope.device_public_key,
                label: &endorsement.label,
            }
            .verify(&root_key, &signature)
            .map_err(|_| Refusal::DeviceKeyNotEndorsed)?;
        }
        // 2. Not revoked (by key id, or by any public key seen under it).
        if self.state.revoked_key_ids.contains(&envelope.device_key_id)
            || self
                .state
                .revoked_public_keys
                .contains(&envelope.device_public_key)
        {
            return Err(Refusal::DeviceKeyRevoked);
        }
        // 3. One id per key, one key per id.
        let new_binding = match self.state.key_ids.get(&envelope.device_public_key) {
            Some(id) if *id != envelope.device_key_id => {
                return Err(Refusal::DeviceSignatureInvalid)
            }
            Some(_) => false,
            None => {
                if self
                    .state
                    .key_ids
                    .values()
                    .any(|id| *id == envelope.device_key_id)
                {
                    return Err(Refusal::DeviceSignatureInvalid);
                }
                true
            }
        };
        // The signature over the rebuilt bytes.
        let signature = BASE64
            .decode(&envelope.signature)
            .map_err(|_| Refusal::DeviceSignatureInvalid)?;
        statement
            .verify(&key, &signature)
            .map_err(|_| Refusal::DeviceSignatureInvalid)?;
        // 4. Fresh on this host's clock.
        check_control_window(envelope.issued_at_ms, envelope.expires_at_ms, now_ms)
            .map_err(|_| Refusal::DeviceSignatureExpired)?;
        // What this host does not run yet is refused before a nonce is spent.
        if envelope.mode.as_deref() == Some("interrupt") && control.kind == "input" {
            return Err(Refusal::UnsupportedControl);
        }
        if envelope.scope.as_deref() == Some("session") && control.kind == "permission" {
            return Err(Refusal::UnsupportedControl);
        }
        // 5. The nonce, on disk before anything is done.
        let mut ledger = self.ledger.clone();
        ledger
            .nonces
            .retain(|_, expires| expires.saturating_add(MAX_CLOCK_SKEW_MS) >= now_ms);
        if ledger.nonces.contains_key(&envelope.nonce) {
            return Err(Refusal::DeviceNonceReplayed);
        }
        if ledger.nonces.len() >= MAX_NONCES {
            tracing::error!("human nonce ledger full; refusing closed");
            return Err(Refusal::DeviceTrustUnavailable);
        }
        if new_binding {
            let mut next = self.state.clone();
            next.key_ids
                .insert(envelope.device_public_key.clone(), envelope.device_key_id);
            self.commit_state(next)
                .map_err(|_| Refusal::DeviceTrustUnavailable)?;
        }
        ledger.nonces.insert(envelope.nonce, envelope.expires_at_ms);
        save(&self.nonce_path, &ledger).map_err(|error| {
            tracing::error!(error = %error, "could not write the human nonce ledger");
            Refusal::DeviceTrustUnavailable
        })?;
        self.ledger = ledger;
        Ok(())
    }
}

/// Which controls need a device signature when R2 is on (ADR-0146 D-8): a
/// spawn, an input, and a permission that is not a rejection. `kill`, a
/// rejection and host revoke switch things off and pass unsigned, so a lost
/// device never stops its owner from stopping an agent. A rejection cannot be
/// turned into an allow: the session answers only an offered option whose
/// kind is the stated one ([`crate::policy::owner_choice`]).
pub fn requires_signature(control: &WorkControl) -> bool {
    match control.kind.as_str() {
        "spawn" | "input" => true,
        "permission" => !control
            .payload_str("kind")
            .is_some_and(|kind| kind.starts_with("reject_")),
        _ => false,
    }
}
