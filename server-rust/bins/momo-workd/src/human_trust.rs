//! The host's half of R2 — ADR-0146 개정 2026-09-28, D-6 · D-7 · D-9 · D-10
//! (#3024). **The security boundary is here, not on the server.**
//!
//! Three things live in the host state folder (beside `state_path`), each a
//! `0600` file written by sibling + rename ([`crate::config::write_private_file`]):
//!
//! * `human-trust.json` — the **pinned root**: the Secure Enclave P-256 key of
//!   the desktop app on this Mac, handed over once on the code-signed control
//!   socket (`pin_root`, [`crate::control_socket`]). Nothing the server sends
//!   can set or change it; a different public key is refused
//!   (`root_already_pinned`) and only a local reset (`momo-workd reset-root`,
//!   or `forget` + register) clears it. **The pin is the public key** (#3078):
//!   the same key under a new key id — a re-login gives the key a new server
//!   row (D-7) — is rebound on the same socket, and the old id is retired.
//!   Also the revoked keys and the key-id ↔ public-key bindings.
//! * `human-nonces.json` — every nonce this host consumed, kept until its
//!   control has expired, so a restart does not reopen a replay window (D-9).
//!
//! ## Checking a control ([`HumanTrust::check_control`])
//!
//! The host never takes the server's word for what was signed. It rebuilds the
//! 13 `momo.human.control.v3` lines from **the control it would act on** — its
//! workspace, requester, target host, session, kind, and the payload text /
//! label / tool / permission decision and, for a spawn, its channel — plus the
//! envelope's own fields (instance id, key id, nonce, times, mode, scope, spawn
//! agent and folder), and verifies the device signature over those bytes. A v2
//! statement is accepted for every kind but a permission, and a v1 one for an
//! input (same bytes apart from the first line; `HumanControl::verify_any`,
//! #3027).
//!
//! A permission allow is rebuilt with **the preview hash this host computed**
//! when it relayed the request (#3118, R2 H1;
//! [`crate::session::SessionManager::permission_preview_sha256`]), never with
//! anything the server sent: the owner's statement must name the preview the
//! host itself read from the agent. A request this host has no preview for is
//! not one it is waiting on (`permission_request_unknown`). Then:
//!
//! 1. the key is the pinned root, or carries a `device_endorse.v1` signed by
//!    the pinned root over **this** public key, workspace and owner;
//! 2. neither the key id nor the public key is revoked;
//! 3. a public key keeps the first key id it was seen under, and a key id its
//!    first public key (an endorsement binds a public key while a revocation
//!    names a key id; without this a revoked key could come back under a new
//!    id). The pinned root's own key is the exception: a local `pin_root`
//!    moves it to a new id and retires the old one (#3078);
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
//! ## Revocation (`device_revoke.v2`, local socket or `pendingControls.deviceRevocations`)
//!
//! ```text
//! { "workspaceId", "memberId", "rootKeyId", "targetKeyId", "revokedAtMs",
//!   "signature": b64(r‖s), "targetPublicKey": b64 }
//! ```
//!
//! `targetPublicKey` is required on both paths: the endorsement binds a public
//! key, the revocation names a key id, and a key this host never saw has no id
//! binding yet. **Whose word the public key is** decides whether it counts
//! (#3068):
//!
//! * a `device_revoke.v2` letter carries it inside the root's signature — the
//!   root says which key it revoked, and the host revokes that key under any
//!   id;
//! * a `device_revoke.v1` letter does not. From the local socket (the
//!   code-signed desktop app, [`RevocationSource::LocalApp`]) the app's word
//!   is taken, as before. **Relayed by the server** it is not: only the signed
//!   key id (and every key this host already saw under it) is revoked, and the
//!   letter answers `revocation_key_unsigned`. Otherwise one genuine letter
//!   for key A carrying key B's public key would revoke B — or carry a decoy,
//!   so that A's real key came back under a new id with its endorsement.
//!   The desktop app (E5) signs v1 today; once it signs v2 the relay binds the
//!   key too, and until then the local socket does.
//!
//! Every letter this host applied is kept in `human-trust.json`
//! (`revocations`, by revoked key id) for good: the server relays at most the
//! newest 256 letters, and a revocation must not depend on the relay still
//! carrying it (#3068).
//!
//! ```text
//! (spawn) v2 (#3027) binds `payload.tool` and the control's `channel_id`, and
//! its session line is the control's `session_id`: `-` for a fresh spawn, the
//! successor session for a resume — the one the owner named when signing, so
//! the server cannot choose which session the owner's words join.
//! (input) `mode` is signed: `queue` waits behind the running turn, `interrupt`
//! cancels it (ACP `session/cancel`) and goes next.
//! ```

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use momo_wire::human_control::{
    check_control_window, parse_p256_public_key, ControlContent, DeviceEndorse, DeviceKeyAlg,
    DeviceRevoke, HumanControl, InputMode, PermissionScope, DEVICE_REVOKE_SCHEMA_V1,
    DEVICE_REVOKE_SCHEMA_V2, MAX_CLOCK_SKEW_MS, P256_PUBLIC_KEY_LEN,
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

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
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
    /// Every root-signed revocation letter applied, by revoked key id (#3068).
    #[serde(default)]
    revocations: BTreeMap<Uuid, StoredRevocation>,
    /// Key ids a root public key was pinned or bound under before it moved to
    /// a new id (#3078: a re-login gives the same key a new server row), →
    /// that public key. Kept across a local reset. Retired: never a root id
    /// again, never another key's id, never a revocation target; a letter the
    /// same root key signed under one still counts (the id is inside the
    /// signed bytes).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    retired_root_key_ids: BTreeMap<Uuid, String>,
}

impl TrustState {
    /// `key_id` is the pinned root's, now or before a re-login (#3078).
    fn root_holds(&self, root: &PinnedRoot, key_id: Uuid) -> bool {
        root.key_id == key_id || self.retired_root_key_ids.get(&key_id) == Some(&root.public_key)
    }
}

/// A `device_revoke` letter as it was verified and applied.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredRevocation {
    /// `momo.human.device_revoke.v1` | `.v2`.
    pub schema: String,
    pub root_key_id: Uuid,
    pub revoked_at_ms: i64,
    pub signature: String,
    /// Kept only when this host took it (see the module docs).
    #[serde(default)]
    pub target_public_key: Option<String>,
}

/// Where a revocation letter came from — whose word its unsigned public key
/// would be (#3068).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevocationSource {
    /// The code-signed desktop app on this Mac, over the control socket.
    LocalApp,
    /// `pendingControls.deviceRevocations` — the server's word.
    Relayed,
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

/// Unknown fields are tolerated (as on every server DTO): a field the server
/// adds later must not turn every relayed revocation into a dropped one.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
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

    /// An empty state at `state_dir` that has not read its files: for a host
    /// with R2 off whose trust files cannot be read (it must still start).
    pub fn empty(state_dir: &Path, identity: TrustIdentity) -> Self {
        Self {
            identity,
            trust_path: state_dir.join(TRUST_FILE),
            nonce_path: state_dir.join(NONCE_FILE),
            state: TrustState::default(),
            ledger: NonceLedger::default(),
        }
    }

    pub fn identity(&self) -> TrustIdentity {
        self.identity
    }

    pub fn root(&self) -> Option<&PinnedRoot> {
        self.state.root.as_ref()
    }

    /// The revocation letters this host keeps (#3068), by revoked key id.
    pub fn revocations(&self) -> &BTreeMap<Uuid, StoredRevocation> {
        &self.state.revocations
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
    /// (`Ok(false)`); any other **public key** is refused until a local reset.
    ///
    /// The same public key under a new key id is a **rebind** (`Ok(true)`,
    /// #3078): a re-login revokes the old key row with its session lineage and
    /// the server gives the same Secure Enclave key a new row (ADR-0146 D-7).
    /// The pin is the key, so the app may move it to the new id; the old id is
    /// retired. This is reachable only from the code-signed control socket —
    /// nothing on the server path calls it (D-6 ①, `inv_26`, `inv_33`).
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
        let current = self.state.root.clone();
        if let Some(root) = &current {
            if root.public_key != public_key_b64 {
                return Err("root_already_pinned");
            }
        }
        let unchanged = current.as_ref().is_some_and(|root| root.key_id == key_id);
        if self.state.retired_root_key_ids.contains_key(&key_id) {
            return Err("root_key_id_retired");
        }
        if self.state.revoked_key_ids.contains(&key_id)
            || self.state.revoked_public_keys.contains(public_key_b64)
        {
            return Err("root_key_revoked");
        }
        if self
            .state
            .key_ids
            .iter()
            .any(|(key, id)| *id == key_id && key != public_key_b64)
        {
            return Err("root_key_id_taken");
        }
        let mut next = self.state.clone();
        // Every other id this key was the root under, or was bound under
        // (step 3 of `check_control` — also one left behind by a local reset
        // and a pin under a new id), is retired; the key's binding moves to
        // `key_id`. The same key and id again only heals a stale binding.
        let previous = [
            current.as_ref().map(|root| root.key_id),
            next.key_ids.get(public_key_b64).copied(),
        ];
        for id in previous.into_iter().flatten() {
            if id != key_id {
                next.retired_root_key_ids
                    .insert(id, public_key_b64.to_string());
            }
        }
        next.key_ids.insert(public_key_b64.to_string(), key_id);
        next.root = Some(match current.clone().filter(|_| unchanged) {
            Some(root) => root,
            None => PinnedRoot {
                key_id,
                alg: alg.to_string(),
                public_key: public_key_b64.to_string(),
                pinned_at_ms: now_ms,
            },
        });
        if next != self.state {
            self.commit_state(next)?;
        }
        if unchanged {
            return Ok(false);
        }
        match current {
            Some(root) => {
                tracing::info!(root_key_id = %key_id, former_key_id = %root.key_id, "human root key rebound to a new key id")
            }
            None => tracing::info!(root_key_id = %key_id, "human root key pinned"),
        }
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

    /// Apply a root-signed revocation letter (`device_revoke.v2`, or v1 —
    /// see the module docs for what a v1 letter's public key is worth).
    ///
    /// `Err("revocation_key_unsigned")` (#3068): a relayed v1 letter whose
    /// public key this host had not already bound to the revoked id. The id
    /// (the signed part) is revoked all the same; the key is not taken.
    pub fn apply_revocation(
        &mut self,
        raw: &Value,
        source: RevocationSource,
    ) -> Result<(), &'static str> {
        let revocation: Revocation =
            serde_json::from_value(raw.clone()).map_err(|_| "invalid_revocation")?;
        let root = self.state.root.clone().ok_or("root_not_pinned")?;
        // The key is named on both paths (#3024 review M1).
        let target_public_key = revocation
            .target_public_key
            .as_deref()
            .ok_or("revocation_public_key_required")?;
        // Already applied (the server relays the list on every poll): nothing
        // to verify or write again. A relayed letter for an id this host
        // already keeps a letter for is the same stored letter again (the
        // server records one per key) — including a v1 one whose key was not
        // taken, which would otherwise be re-verified and re-reported on
        // every poll.
        if self
            .state
            .revoked_key_ids
            .contains(&revocation.target_key_id)
            && (self.state.revoked_public_keys.contains(target_public_key)
                || (source == RevocationSource::Relayed
                    && self
                        .state
                        .revocations
                        .contains_key(&revocation.target_key_id)))
        {
            return Ok(());
        }
        if revocation.workspace_id != self.identity.workspace_id
            || revocation.member_id != self.identity.owner_member_id
        {
            return Err("revocation_not_for_this_host");
        }
        // A letter the root signed under an id it held before a re-login is
        // still the root's (#3078): the signature is checked against the same
        // pinned key, over bytes that name that id.
        if !self.state.root_holds(&root, revocation.root_key_id) {
            return Err("revocation_not_from_root");
        }
        if self.state.root_holds(&root, revocation.target_key_id)
            || target_public_key == root.public_key
        {
            return Err("revocation_targets_root");
        }
        if device_public_key(target_public_key).is_none() {
            return Err("invalid_revocation");
        }
        let root_key = BASE64
            .decode(&root.public_key)
            .map_err(|_| "trust_unavailable")?;
        let signature = BASE64
            .decode(&revocation.signature)
            .map_err(|_| "revocation_signature_invalid")?;
        let letter = DeviceRevoke {
            workspace_id: revocation.workspace_id,
            member_id: revocation.member_id,
            root_key_id: revocation.root_key_id,
            target_key_id: revocation.target_key_id,
            revoked_at_ms: revocation.revoked_at_ms,
        };
        // v2: the root signed the key. v1: only the id.
        let key_signed = if letter
            .verify_v2(target_public_key, &root_key, &signature)
            .is_ok()
        {
            true
        } else {
            letter
                .verify(&root_key, &signature)
                .map_err(|_| "revocation_signature_invalid")?;
            false
        };
        let take_key = key_signed || source == RevocationSource::LocalApp;

        let mut next = self.state.clone();
        next.revoked_key_ids.insert(revocation.target_key_id);
        // Every public key ever seen under the revoked id goes with it.
        let bound: Vec<String> = next
            .key_ids
            .iter()
            .filter(|(_, id)| **id == revocation.target_key_id)
            .map(|(key, _)| key.clone())
            .collect();
        let already_bound = bound.iter().any(|key| key == target_public_key);
        next.revoked_public_keys.extend(bound);
        if take_key {
            next.key_ids
                .entry(target_public_key.to_string())
                .or_insert(revocation.target_key_id);
            next.revoked_public_keys
                .insert(target_public_key.to_string());
        }
        next.revocations
            .entry(revocation.target_key_id)
            .or_insert(StoredRevocation {
                schema: if key_signed {
                    DEVICE_REVOKE_SCHEMA_V2
                } else {
                    DEVICE_REVOKE_SCHEMA_V1
                }
                .to_string(),
                root_key_id: revocation.root_key_id,
                revoked_at_ms: revocation.revoked_at_ms,
                signature: revocation.signature.clone(),
                target_public_key: take_key.then(|| target_public_key.to_string()),
            });
        if next != self.state {
            self.commit_state(next)?;
            tracing::info!(target_key_id = %revocation.target_key_id, key_signed, "device key revoked on this host");
        }
        if !take_key && !already_bound {
            return Err("revocation_key_unsigned");
        }
        Ok(())
    }

    /// ADR-0146 D-10: verify the person's signature on `control` and consume
    /// its nonce. `Ok` means the host may act on exactly this control. A
    /// `permission` control needs [`Self::check_control_with_preview`].
    pub fn check_control(&mut self, control: &WorkControl, now_ms: i64) -> Result<(), Refusal> {
        self.check_control_with_preview(control, None, now_ms)
    }

    /// [`Self::check_control`], with the preview hash this host relayed for
    /// the `permission` control's request (#3118) — `None` when it relayed no
    /// such request, which is refused for a permission.
    pub fn check_control_with_preview(
        &mut self,
        control: &WorkControl,
        permission_preview_sha256: Option<&str>,
        now_ms: i64,
    ) -> Result<(), Refusal> {
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
                require_nfc(text)?;
                (ControlContent::Input { mode, text }, control.session_id)
            }
            "spawn" => {
                let (Some(agent_member_id), Some(folder_id)) =
                    (envelope.agent_member_id, envelope.folder_id.as_deref())
                else {
                    return Err(Refusal::DeviceSignatureInvalid);
                };
                let first_prompt = payload("label").ok_or(Refusal::InvalidControl)?;
                let tool = payload("tool").ok_or(Refusal::InvalidControl)?;
                require_nfc(first_prompt)?;
                // v2 (#3027): the session line is the control's session — `-`
                // for a fresh spawn, and for a resume the successor the owner
                // signed, so the server cannot pick which session the words
                // join (#3024 review M2). v1 (no such line) is refused below by
                // `verify_any`.
                (
                    ControlContent::Spawn {
                        agent_member_id,
                        folder_id,
                        tool,
                        channel_id: control.channel_id,
                        first_prompt,
                    },
                    control.session_id,
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
                // #3118: the hash of the preview THIS host relayed. A request
                // it is not waiting on has none.
                let preview_sha256 =
                    permission_preview_sha256.ok_or(Refusal::PermissionRequestUnknown)?;
                (
                    ControlContent::Permission {
                        request_event_id,
                        option_id,
                        option_kind,
                        scope,
                        preview_sha256: Some(preview_sha256),
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
        if self
            .state
            .retired_root_key_ids
            .contains_key(&envelope.device_key_id)
        {
            // Retired by a re-login (#3078): not the root, nor anyone else.
            return Err(Refusal::DeviceSignatureInvalid);
        }
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
            .verify_any(&key, &signature)
            .map_err(|_| Refusal::DeviceSignatureInvalid)?;
        // 4. Fresh on this host's clock.
        check_control_window(envelope.issued_at_ms, envelope.expires_at_ms, now_ms)
            .map_err(|_| Refusal::DeviceSignatureExpired)?;
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

/// The signature covers NFC text (momo-wire D-5) while the host acts on the
/// bytes it was given: text whose NFC form differs could be swapped for
/// another spelling of the same signature (#3024 review L4). Refused.
fn require_nfc(text: &str) -> Result<(), Refusal> {
    let normalized = ControlContent::Input {
        mode: InputMode::Queue,
        text,
    }
    .canonical_bytes()
    .map_err(|_| Refusal::DeviceSignatureInvalid)?;
    if normalized == text.as_bytes() {
        Ok(())
    } else {
        Err(Refusal::DeviceSignatureInvalid)
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
