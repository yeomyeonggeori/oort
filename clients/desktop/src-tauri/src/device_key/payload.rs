//! The three statements this Mac's device key may sign — ADR-0146 개정
//! 2026-09-28 D-5 — built **here**, from typed fields, never from bytes the
//! webview hands over.
//!
//! This is a port of `momo-wire`'s `human_control.rs` (E1 #3021, on
//! `track/engine`): the desktop crate is not a member of the server
//! workspace, and its base branch does not carry E1 yet. Drift is what the
//! tests stop: every case in the shared vectors
//! (`clients/mobile/__tests__/fixtures/human-control-signing.vectors.json`,
//! a byte-for-byte copy of `docs/api/human-control-signing.vectors.json`) is
//! rebuilt from its inputs here and must equal the recorded payload, and every
//! recorded signature must verify over the bytes this file builds.
//!
//! The Mac is the **root** (D-6), so unlike the phone (#3026, control only) it
//! may sign all three kinds of statement: `momo.human.control.v2`,
//! `momo.human.device_endorse.v1` and `momo.human.device_revoke.v2` — and,
//! like the phone, its own key's move onto a new sign-in,
//! `momo.human.device_rebind.v1` (#3103, ADR-0146 D-7 증보 #3097). Nothing
//! else — there is no "sign these bytes" entry point anywhere in this crate.
//!
//! #3028 (R2-E8, ADR-0146 증보 R2-E7): control moved to **v2** for every kind
//! (a spawn binds the tool and the channel, and a resume's successor session;
//! the other kinds are v1's bytes under a new first line), and revocations to
//! **device_revoke.v2** (the root also signs the revoked public key). The v1
//! recipes stay only so the E1 vectors still prove this port; the allow-list
//! below no longer lets them reach the enclave.
//!
//! #3128 (ADR-0146 증보 2026-09-29, R2 H1 · #3118): a **permission** is
//! signed as `momo.human.control.v3`, whose body has a fifth line, the
//! SHA-256 of the host's preview (`momo.work_permission.preview.v1`). The
//! webview hands over the preview it rendered and the hash it computed; this
//! shell re-validates the closed object, recomputes the hash itself
//! ([`permission_preview_sha256`]), refuses when the two differ or the preview
//! was cut, and shows the preview in the native dialog. Every other kind stays
//! v2: the server and workd accept v2 for them, so an app update does not break
//! instructions on a host that has not updated yet (the v3 recipe for those
//! kinds is byte-identical but the first line).
//!
//! The same typed statement also produces the native confirmation text
//! ([`Statement::summary`]), so what the person approves is what is signed —
//! including the first line of an instruction, which the signed bytes only
//! carry as `content_sha256`.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use p256::ecdsa::signature::Verifier as _;
use p256::ecdsa::{Signature, VerifyingKey};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization as _;
use uuid::Uuid;

pub const HUMAN_CONTROL_SCHEMA_V1: &str = "momo.human.control.v1";
pub const HUMAN_CONTROL_SCHEMA_V2: &str = "momo.human.control.v2";
/// #3128: what a permission allow is signed as (the preview hash line).
pub const HUMAN_CONTROL_SCHEMA_V3: &str = "momo.human.control.v3";
/// #3592 (P1, momo-wire `HUMAN_CONTROL_SCHEMA_V4`): a NEW-work spawn. The
/// 13-line frame again; its body is the eight lines of [`ControlContent::SpawnTask`].
pub const HUMAN_CONTROL_SCHEMA_V4: &str = "momo.human.control.v4";
pub const DEVICE_ENDORSE_SCHEMA_V1: &str = "momo.human.device_endorse.v1";
/// Kept for the E1 vectors only (tests); never signed (#3028).
#[cfg_attr(not(test), allow(dead_code))]
pub const DEVICE_REVOKE_SCHEMA_V1: &str = "momo.human.device_revoke.v1";
pub const DEVICE_REVOKE_SCHEMA_V2: &str = "momo.human.device_revoke.v2";
/// #3097 (momo-wire `DEVICE_REBIND_SCHEMA_V1`): a live key moves itself onto
/// the caller's new sign-in.
pub const DEVICE_REBIND_SCHEMA_V1: &str = "momo.human.device_rebind.v1";

/// The schemas this key signs, with each payload's exact line count. The Mac
/// is the root, so all three kinds (the phone signs only control, #3026), plus
/// its own rebind letter (#3103).
/// v1 control and v1 revocations are NOT here (#3028): the server and workd
/// refuse a v1 spawn, and a v1 revocation leaves the revoked key unsigned.
/// control v3 (#3128) is here for permission; v2 for the other kinds.
pub const SIGNING_SCHEMAS: [(&str, usize); 6] = [
    (HUMAN_CONTROL_SCHEMA_V2, 13),
    (HUMAN_CONTROL_SCHEMA_V3, 13),
    (HUMAN_CONTROL_SCHEMA_V4, 13),
    (DEVICE_ENDORSE_SCHEMA_V1, 7),
    (DEVICE_REVOKE_SCHEMA_V2, 7),
    (DEVICE_REBIND_SCHEMA_V1, 7),
];

/// Which control recipe. Production signs a permission as v3 and every other
/// kind as v2 ([`ControlContent::signing_schema`]); v1 is kept for the E1
/// vectors (the bytes of input·permission·bundle·host_register are the same
/// but the first line; spawn differs).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlSchema {
    /// The E1 vectors only; production never builds it.
    #[cfg_attr(not(test), allow(dead_code))]
    V1,
    V2,
    V3,
    /// #3592: the new-work spawn only (`SpawnTask`), and `SpawnTask` only here.
    V4,
}

impl ControlSchema {
    pub fn as_str(self) -> &'static str {
        match self {
            ControlSchema::V1 => HUMAN_CONTROL_SCHEMA_V1,
            ControlSchema::V2 => HUMAN_CONTROL_SCHEMA_V2,
            ControlSchema::V3 => HUMAN_CONTROL_SCHEMA_V3,
            ControlSchema::V4 => HUMAN_CONTROL_SCHEMA_V4,
        }
    }
}

/// Largest signed payload accepted: every line is an id, a number, a hex
/// digest, a key or a short label; free text is only ever hashed.
pub const MAX_SIGNING_PAYLOAD_BYTES: usize = 2048;

pub const ABSENT: &str = "-";
/// `expires − issued` ceiling (D-5, D-9).
pub const MAX_LIFETIME_MS: i64 = 10 * 60 * 1000;
/// `|now − issued|` ceiling (D-9).
pub const MAX_CLOCK_SKEW_MS: i64 = 5 * 60 * 1000;
pub const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;
pub const P256_PUBLIC_KEY_LEN: usize = 33;
pub const P256_SIGNATURE_LEN: usize = 64;
/// Longest label a device key row stores (`member_device_key_label_ck`, E2).
pub const LABEL_MAX_CHARS: usize = 80;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PayloadError {
    Field(&'static str, &'static str),
    SessionRequired,
    SessionForbidden,
    HostIdMismatch,
    ManifestNumber,
    PublicKey,
    Window(&'static str),
    Schema(&'static str),
}

impl PayloadError {
    /// The short code the webview sees (`device_key_payload_rejected: …`).
    pub fn code(&self) -> String {
        match self {
            PayloadError::Field(field, reason) => format!("{field}: {reason}"),
            PayloadError::SessionRequired => "session_id required".into(),
            PayloadError::SessionForbidden => "session_id not allowed".into(),
            PayloadError::HostIdMismatch => "host_id mismatch".into(),
            PayloadError::ManifestNumber => "manifest number".into(),
            PayloadError::PublicKey => "public key".into(),
            PayloadError::Window(why) => format!("time window: {why}"),
            PayloadError::Schema(why) => format!("schema: {why}"),
        }
    }
}

// ---- requests the webview sends (typed; the shell fills the identity) --------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InputMode {
    Queue,
    Interrupt,
}

impl InputMode {
    pub fn as_str(self) -> &'static str {
        match self {
            InputMode::Queue => "queue",
            InputMode::Interrupt => "interrupt",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionScope {
    Once,
    Session,
}

impl PermissionScope {
    pub fn as_str(self) -> &'static str {
        match self {
            PermissionScope::Once => "once",
            PermissionScope::Session => "session",
        }
    }
}

/// The kind-specific content. The variant fixes `kind` (and `mode`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ControlContent {
    Input {
        mode: InputMode,
        text: String,
    },
    Spawn {
        agent_member_id: Uuid,
        folder_id: String,
        /// v2: the harness the host will run (`claude`, `codex`, …).
        tool: String,
        /// v2: the channel the session thread lives in.
        channel_id: Uuid,
        first_prompt: String,
    },
    /// #3592 (`momo.human.control.v4`): a NEW task on this Mac, called from a
    /// message (ADR-0198 D7). The whole prompt and the title are signed, so
    /// the dialog shows both; the personal agent is optional (`-` for a plain
    /// harness spawn).
    SpawnTask {
        #[serde(default)]
        agent_member_id: Option<Uuid>,
        folder_id: String,
        tool: String,
        channel_id: Uuid,
        #[serde(default)]
        thread_root_id: Option<Uuid>,
        #[serde(default)]
        origin_message_id: Option<Uuid>,
        label: String,
        prompt: String,
    },
    Permission {
        request_event_id: Uuid,
        option_id: String,
        option_kind: String,
        scope: PermissionScope,
        /// #3128: the host's closed preview object as the page rendered it
        /// (the owner's `GET …/permission-requests/{id}`). Required to sign;
        /// the shell hashes it itself and shows it in the dialog.
        #[serde(default)]
        preview: Option<serde_json::Value>,
        /// #3128: the hash the page computed (`checkPermissionPreview`). Must
        /// equal the shell's own; the v3 body's fifth line.
        #[serde(default)]
        preview_sha256: Option<String>,
    },
    BundleManifest {
        manifest: serde_json::Value,
    },
    HostRegister {
        host_public_key_b64: String,
        host_id: Uuid,
        label: String,
    },
}

impl ControlContent {
    pub fn kind(&self) -> &'static str {
        match self {
            ControlContent::Input { .. } => "input",
            ControlContent::Spawn { .. } | ControlContent::SpawnTask { .. } => "spawn",
            ControlContent::Permission { .. } => "permission",
            ControlContent::BundleManifest { .. } => "bundle_manifest",
            ControlContent::HostRegister { .. } => "host_register",
        }
    }

    pub fn mode(&self) -> &'static str {
        match self {
            ControlContent::Input { mode, .. } => mode.as_str(),
            _ => ABSENT,
        }
    }

    fn requires_session(&self) -> bool {
        matches!(
            self,
            ControlContent::Input { .. } | ControlContent::Permission { .. }
        )
    }

    /// v2 and v3: a spawn MAY name a session (a resume's successor id, #3027).
    fn allows_session(&self, schema: ControlSchema) -> bool {
        self.requires_session()
            || (schema != ControlSchema::V1 && matches!(self, ControlContent::Spawn { .. }))
    }

    /// The schema production signs this content as (#3128): a permission
    /// binds its preview (v3); every other kind stays v2, which the server
    /// and workd still accept for it.
    pub fn signing_schema(&self) -> ControlSchema {
        match self {
            ControlContent::Permission { .. } => ControlSchema::V3,
            ControlContent::SpawnTask { .. } => ControlSchema::V4,
            _ => ControlSchema::V2,
        }
    }

    pub fn canonical_bytes_for(&self, schema: ControlSchema) -> Result<Vec<u8>, PayloadError> {
        // v4 is the new-work spawn's schema and has no other body; that body
        // has no other schema. A v2/v3 signature can never stand for a new
        // task, nor a v4 one for a resume, an input or an allow.
        if (schema == ControlSchema::V4) != matches!(self, ControlContent::SpawnTask { .. }) {
            return Err(PayloadError::Schema(
                "v4 is the new-work spawn's, and only its",
            ));
        }
        let text = match self {
            ControlContent::SpawnTask {
                agent_member_id,
                folder_id,
                tool,
                channel_id,
                thread_root_id,
                origin_message_id,
                label,
                prompt,
            } => {
                token("folder_id", folder_id)?;
                token("tool", tool)?;
                spawn_label_ok(label)?;
                spawn_prompt_ok(prompt)?;
                let id = |v: &Option<Uuid>| v.map_or_else(|| ABSENT.to_string(), |v| v.to_string());
                format!(
                    "{}\n{folder_id}\n{tool}\n{channel_id}\n{}\n{}\n{}\n{}",
                    id(agent_member_id),
                    id(thread_root_id),
                    id(origin_message_id),
                    nfc(label),
                    nfc(prompt)
                )
            }
            ControlContent::Input { text, .. } => {
                readable_text("text", text)?;
                nfc(text)
            }
            ControlContent::Spawn {
                agent_member_id,
                folder_id,
                tool,
                channel_id,
                first_prompt,
            } => {
                token("folder_id", folder_id)?;
                readable_text("first_prompt", first_prompt)?;
                match schema {
                    ControlSchema::V1 => {
                        format!("{agent_member_id}\n{folder_id}\n{}", nfc(first_prompt))
                    }
                    ControlSchema::V4 => unreachable!("guarded above"),
                    ControlSchema::V2 | ControlSchema::V3 => {
                        token("tool", tool)?;
                        format!(
                            "{agent_member_id}\n{folder_id}\n{tool}\n{channel_id}\n{}",
                            nfc(first_prompt)
                        )
                    }
                }
            }
            ControlContent::Permission {
                request_event_id,
                option_id,
                option_kind,
                scope,
                preview_sha256,
                ..
            } => {
                token("option_id", option_id)?;
                token("option_kind", option_kind)?;
                let head = format!(
                    "{request_event_id}\n{option_id}\n{option_kind}\n{}",
                    scope.as_str()
                );
                // v3 has the preview line and only v3 has it: a v1/v2 body
                // could not say which preview the person saw (#3118).
                match (schema, preview_sha256) {
                    (ControlSchema::V3, Some(hash)) => {
                        lower_hex_sha256("preview_sha256", hash)?;
                        format!("{head}\n{hash}")
                    }
                    (ControlSchema::V3, None) => {
                        return Err(PayloadError::Field("preview_sha256", "missing"))
                    }
                    (_, None) => head,
                    (_, Some(_)) => return Err(PayloadError::Field("preview_sha256", "needs v3")),
                }
            }
            ControlContent::BundleManifest { manifest } => canonical_json(manifest)?,
            ControlContent::HostRegister {
                host_public_key_b64,
                host_id,
                label,
            } => {
                canonical_b64_of_len("host_public_key_b64", host_public_key_b64, 32)?;
                label_ok(label)?;
                format!("{host_public_key_b64}\n{host_id}\n{}", nfc(label))
            }
        };
        Ok(text.into_bytes())
    }

    pub fn content_sha256_for(&self, schema: ControlSchema) -> Result<String, PayloadError> {
        Ok(hex::encode(Sha256::digest(
            self.canonical_bytes_for(schema)?,
        )))
    }
}

/// `device_key_sign_control` — everything but the signer's identity, which the
/// shell fills from the root it registered (workspace → key id, member).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlRequest {
    pub workspace_id: Uuid,
    /// Server-issued, echoed verbatim (D-5).
    pub instance_id: String,
    pub host_id: Uuid,
    #[serde(default)]
    pub session_id: Option<Uuid>,
    pub nonce: Uuid,
    pub issued_at_ms: i64,
    pub expires_at_ms: i64,
    pub content: ControlContent,
}

/// `device_key_sign_endorse`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EndorseRequest {
    pub workspace_id: Uuid,
    /// The phone key row being approved (for the result only; not signed).
    pub target_key_id: Uuid,
    pub target_alg: String,
    pub target_public_key: String,
    /// The label the target row stores — the server rebuilds the letter from
    /// its rows, so any other value would not verify there.
    pub label: String,
}

/// `device_key_sign_revoke`. Names the key by id only (#3028, E7 인계 ③
/// High): the public key the letter signs is the one THIS shell recorded when
/// it endorsed that id, never a value the webview (i.e. server data) passes.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevokeRequest {
    pub workspace_id: Uuid,
    pub target_key_id: Uuid,
    /// For the confirmation only.
    #[serde(default)]
    pub target_label: String,
}

/// `device_key_sign_rebind` (#3103): move this Mac's key, left live on a
/// sign-in that ended without revoking it (a refresh reuse, an expiry), onto
/// the webview's current sign-in. The public key line is the enclave's own,
/// never the webview's. `key_id`/`member_id` are the server row the page read
/// (the shell's binding may be missing after a reinstall); the server rebuilds
/// the letter from ITS row and the caller, so a wrong id only fails to verify.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RebindRequest {
    pub workspace_id: Uuid,
    pub member_id: Uuid,
    pub key_id: Uuid,
    /// `signing-context` `sessionId` — the caller's own lineage.
    pub session_id: Uuid,
}

// ---- statements ------------------------------------------------------------

/// Who signs: filled by the shell from its own record, never by the webview.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Signer {
    pub workspace_id: Uuid,
    pub member_id: Uuid,
    pub key_id: Uuid,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Statement {
    Control {
        signer: Signer,
        request: ControlRequest,
    },
    Endorse {
        signer: Signer,
        request: EndorseRequest,
    },
    Revoke {
        signer: Signer,
        request: RevokeRequest,
        /// From the shell's endorsement record, not the request.
        target_public_key: String,
        revoked_at_ms: i64,
    },
    /// `momo.human.device_rebind.v1`: signed by the key it moves (the signer's
    /// `key_id` row), never by another.
    Rebind {
        signer: Signer,
        /// The enclave's public key, read by the shell.
        public_key: String,
        session_id: Uuid,
        signed_at_ms: i64,
    },
}

impl Statement {
    #[cfg(test)]
    pub fn schema(&self) -> &'static str {
        match self {
            Statement::Control { request, .. } => request.content.signing_schema().as_str(),
            Statement::Endorse { .. } => DEVICE_ENDORSE_SCHEMA_V1,
            Statement::Revoke { .. } => DEVICE_REVOKE_SCHEMA_V2,
            Statement::Rebind { .. } => DEVICE_REBIND_SCHEMA_V1,
        }
    }

    /// The exact bytes the enclave signs. `now_ms` is checked against the
    /// control's window so a webview cannot obtain a long-lived statement.
    pub fn signed_bytes(&self, now_ms: i64) -> Result<Vec<u8>, PayloadError> {
        let bytes = match self {
            Statement::Control { signer, request } => {
                check_control_window(request.issued_at_ms, request.expires_at_ms, now_ms)?;
                check_permission_preview(&request.content)?;
                control_bytes(signer, request)?
            }
            Statement::Endorse { signer, request } => endorse_bytes(signer, request)?,
            Statement::Revoke {
                signer,
                request,
                target_public_key,
                revoked_at_ms,
            } => {
                if *revoked_at_ms <= 0 || *revoked_at_ms > MAX_SAFE_INTEGER {
                    return Err(PayloadError::Field("revoked_at_ms", "out of range"));
                }
                if request.workspace_id != signer.workspace_id {
                    return Err(PayloadError::Field("workspace_id", "not the signer's"));
                }
                p256_public_key(target_public_key)?;
                revoke_bytes(
                    signer,
                    request.target_key_id,
                    target_public_key,
                    *revoked_at_ms,
                )
            }
            Statement::Rebind {
                signer,
                public_key,
                session_id,
                signed_at_ms,
            } => rebind_bytes(signer, public_key, *session_id, *signed_at_ms)?,
        };
        check_signing_payload(&bytes)?;
        Ok(bytes)
    }
}

/// The statement production signs: v3 for a permission, v2 otherwise.
pub fn control_bytes(signer: &Signer, request: &ControlRequest) -> Result<Vec<u8>, PayloadError> {
    control_bytes_for(request.content.signing_schema(), signer, request)
}

// ---- the permission preview (#3128, momo-wire `permission_preview`) ---------

/// `momo.work_permission.preview.v1`.
pub const PREVIEW_SCHEMA_V1: &str = "momo.work_permission.preview.v1";
/// Most characters one preview text field carries (ADR-0188 D5).
pub const PREVIEW_FIELD_MAX_CHARS: usize = 3_500;
/// The ACP `ToolKind` vocabulary, closed.
pub const PREVIEW_KINDS: [&str; 10] = [
    "read",
    "edit",
    "delete",
    "move",
    "search",
    "execute",
    "think",
    "fetch",
    "switch_mode",
    "other",
];
const PREVIEW_TEXT_FIELDS: [&str; 3] = ["title", "locations", "input"];

/// A character the app's display would neutralise instead of show — the
/// `INVISIBLE` set of `@momo/core` `agentPane.ts`, which `checkPermissionPreview`
/// refuses as `display_altered` — plus the carriage return, which the dialog
/// would draw as a line break. The host removes every one of these before it
/// hashes (`momo-workd` `projection::preview_field`), so an honest preview
/// never carries one; the dialog shows exactly the hashed characters.
///
/// Deliberately NOT [`is_hidden_char`]: that set is wider than the host's
/// (private use, U+2800, …), and an honest preview with such a character would
/// then be allowable on the phone but never on this Mac (#3118 review M1).
pub fn is_preview_hidden_char(c: char) -> bool {
    matches!(
        c as u32,
        0x0000..=0x0008
            | 0x000B..=0x001F
            | 0x007F..=0x009F
            | 0x00AD
            | 0x061C
            | 0x180E
            | 0x200B..=0x200F
            | 0x2028..=0x202E
            | 0x2060..=0x2064
            | 0x2066..=0x206F
            | 0xFEFF
            | 0xFFF9..=0xFFFB
    )
}

/// The preview as the dialog reads it: only after [`permission_preview_sha256`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewView {
    pub kind: String,
    pub title: String,
    pub locations: String,
    pub input: String,
    pub truncated: bool,
}

/// The closed v1 object (momo-wire `validate_preview`), every text field free
/// of what the app would not show as is.
pub fn parse_preview(preview: &serde_json::Value) -> Result<PreviewView, PayloadError> {
    let object = preview
        .as_object()
        .ok_or(PayloadError::Field("preview", "not an object"))?;
    if object.len() != 6 {
        return Err(PayloadError::Field("preview", "wrong key set"));
    }
    if object.get("schema").and_then(|v| v.as_str()) != Some(PREVIEW_SCHEMA_V1) {
        return Err(PayloadError::Field("preview", "schema"));
    }
    let kind = object
        .get("kind")
        .and_then(|v| v.as_str())
        .filter(|kind| PREVIEW_KINDS.contains(kind))
        .ok_or(PayloadError::Field("preview", "kind"))?;
    let mut text = Vec::with_capacity(3);
    for field in PREVIEW_TEXT_FIELDS {
        let value = object
            .get(field)
            .and_then(|v| v.as_str())
            .ok_or(PayloadError::Field("preview", "text field"))?;
        if value.chars().count() > PREVIEW_FIELD_MAX_CHARS {
            return Err(PayloadError::Field("preview", "text field too long"));
        }
        if value.chars().any(is_preview_hidden_char) {
            return Err(PayloadError::Field("preview", "invisible character"));
        }
        text.push(value.to_string());
    }
    let truncated = object
        .get("truncated")
        .and_then(|v| v.as_bool())
        .ok_or(PayloadError::Field("preview", "truncated"))?;
    let input = text.pop().unwrap_or_default();
    let locations = text.pop().unwrap_or_default();
    let title = text.pop().unwrap_or_default();
    Ok(PreviewView {
        kind: kind.to_string(),
        title,
        locations,
        input,
        truncated,
    })
}

/// Lowercase hex SHA-256 of the preview's canonical bytes (sorted-key compact
/// JSON, [`canonical_json`]) — the fifth line of a v3 permission body. The
/// shell computes it; it never takes the page's word for it.
pub fn permission_preview_sha256(preview: &serde_json::Value) -> Result<String, PayloadError> {
    parse_preview(preview)?;
    Ok(hex::encode(Sha256::digest(canonical_json(preview)?)))
}

/// Before a permission is signed: the page sent a preview and a hash, the
/// shell's own hash of that preview equals the page's, and the preview was not
/// cut (ADR-0188 D5: a cut preview cannot be allowed). Other kinds pass.
pub fn check_permission_preview(content: &ControlContent) -> Result<(), PayloadError> {
    let ControlContent::Permission {
        preview,
        preview_sha256,
        ..
    } = content
    else {
        return Ok(());
    };
    let preview = preview
        .as_ref()
        .ok_or(PayloadError::Field("preview", "missing"))?;
    let claimed = preview_sha256
        .as_deref()
        .ok_or(PayloadError::Field("preview_sha256", "missing"))?;
    let view = parse_preview(preview)?;
    if permission_preview_sha256(preview)? != claimed {
        return Err(PayloadError::Field("preview_sha256", "mismatch"));
    }
    if view.truncated {
        return Err(PayloadError::Field("preview", "truncated"));
    }
    Ok(())
}

fn lower_hex_sha256(field: &'static str, value: &str) -> Result<(), PayloadError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(PayloadError::Field(field, "not a lowercase sha256"));
    }
    Ok(())
}

pub fn control_bytes_for(
    schema: ControlSchema,
    signer: &Signer,
    request: &ControlRequest,
) -> Result<Vec<u8>, PayloadError> {
    token("instance_id", &request.instance_id)?;
    if request.workspace_id != signer.workspace_id {
        return Err(PayloadError::Field("workspace_id", "not the signer's"));
    }
    let content = &request.content;
    let session = match (content.requires_session(), request.session_id) {
        (true, Some(id)) => id.to_string(),
        (true, None) => return Err(PayloadError::SessionRequired),
        (false, None) => ABSENT.to_string(),
        (false, Some(id)) if content.allows_session(schema) => id.to_string(),
        (false, Some(_)) => return Err(PayloadError::SessionForbidden),
    };
    if let ControlContent::HostRegister { host_id, .. } = content {
        if *host_id != request.host_id {
            return Err(PayloadError::HostIdMismatch);
        }
    }
    let content_sha256 = content.content_sha256_for(schema)?;
    Ok(format!(
        "{}\n{}\n{}\n{}\n{}\n{}\n{session}\n{}\n{}\n{}\n{}\n{}\n{content_sha256}",
        schema.as_str(),
        request.instance_id,
        signer.workspace_id,
        signer.member_id,
        signer.key_id,
        request.host_id,
        content.kind(),
        content.mode(),
        request.nonce,
        request.issued_at_ms,
        request.expires_at_ms,
    )
    .into_bytes())
}

pub fn endorse_bytes(signer: &Signer, request: &EndorseRequest) -> Result<Vec<u8>, PayloadError> {
    if request.workspace_id != signer.workspace_id {
        return Err(PayloadError::Field("workspace_id", "not the signer's"));
    }
    if request.target_alg != "p256" {
        return Err(PayloadError::Field("target_alg", "not p256"));
    }
    p256_public_key(&request.target_public_key)?;
    label_ok(&request.label)?;
    if request.label.chars().count() > LABEL_MAX_CHARS {
        return Err(PayloadError::Field("label", "too long"));
    }
    Ok(format!(
        "{DEVICE_ENDORSE_SCHEMA_V1}\n{}\n{}\n{}\n{}\n{}\n{}",
        signer.workspace_id,
        signer.member_id,
        signer.key_id,
        request.target_alg,
        request.target_public_key,
        nfc(&request.label),
    )
    .into_bytes())
}

/// `momo.human.device_revoke.v2` (#3068): v1's lines plus the revoked public
/// key before the time, so the root's signature names the key, not only its id.
pub fn revoke_bytes(
    signer: &Signer,
    target_key_id: Uuid,
    target_public_key: &str,
    revoked_at_ms: i64,
) -> Vec<u8> {
    format!(
        "{DEVICE_REVOKE_SCHEMA_V2}\n{}\n{}\n{}\n{}\n{}\n{}",
        signer.workspace_id,
        signer.member_id,
        signer.key_id,
        target_key_id,
        target_public_key,
        revoked_at_ms,
    )
    .into_bytes()
}

/// `momo.human.device_rebind.v1` (#3097; momo-wire `DeviceRebind`):
///
/// ```text
/// momo.human.device_rebind.v1
/// {workspace_id}
/// {member_id}
/// {key_id}
/// {public_key_b64}
/// {session_id}        the lineage the key moves to — the caller's own
/// {signed_at_ms}
/// ```
pub fn rebind_bytes(
    signer: &Signer,
    public_key: &str,
    session_id: Uuid,
    signed_at_ms: i64,
) -> Result<Vec<u8>, PayloadError> {
    p256_public_key(public_key)?;
    if signed_at_ms <= 0 || signed_at_ms > MAX_SAFE_INTEGER {
        return Err(PayloadError::Field("signed_at_ms", "out of range"));
    }
    Ok(format!(
        "{DEVICE_REBIND_SCHEMA_V1}\n{}\n{}\n{}\n{public_key}\n{session_id}\n{signed_at_ms}",
        signer.workspace_id, signer.member_id, signer.key_id,
    )
    .into_bytes())
}

/// The last gate before the enclave: an allowed schema with exactly its line
/// count, UTF-8, no control character but the line breaks, bounded. Every
/// builder above already satisfies it; this is the allow-list that makes
/// "sign anything else" impossible even if a builder regresses.
pub fn check_signing_payload(message: &[u8]) -> Result<(), PayloadError> {
    if message.is_empty() {
        return Err(PayloadError::Schema("empty"));
    }
    if message.len() > MAX_SIGNING_PAYLOAD_BYTES {
        return Err(PayloadError::Schema("too long"));
    }
    let text = std::str::from_utf8(message).map_err(|_| PayloadError::Schema("not UTF-8"))?;
    if text.chars().any(|c| c != '\n' && c.is_control()) {
        return Err(PayloadError::Schema("control character"));
    }
    let lines: Vec<&str> = text.split('\n').collect();
    let expected = SIGNING_SCHEMAS
        .iter()
        .find(|(schema, _)| *schema == lines[0])
        .map(|(_, count)| *count)
        .ok_or(PayloadError::Schema("not an allowed schema"))?;
    if lines.len() != expected {
        return Err(PayloadError::Schema("wrong line count"));
    }
    Ok(())
}

/// `issued < expires ≤ issued + 10 min`, `|now − issued| ≤ 5 min`, `now < expires`.
pub fn check_control_window(issued: i64, expires: i64, now: i64) -> Result<(), PayloadError> {
    let (issued, expires, now) = (i128::from(issued), i128::from(expires), i128::from(now));
    if expires <= issued {
        return Err(PayloadError::Window("expires not after issued"));
    }
    if expires - issued > i128::from(MAX_LIFETIME_MS) {
        return Err(PayloadError::Window("lifetime over 10 minutes"));
    }
    if (now - issued).abs() > i128::from(MAX_CLOCK_SKEW_MS) {
        return Err(PayloadError::Window("issued more than 5 minutes from now"));
    }
    if now >= expires {
        return Err(PayloadError::Window("expired"));
    }
    Ok(())
}

// ---- P-256 encodings --------------------------------------------------------

/// A 33-byte compressed SEC1 point on P-256, canonical base64.
pub fn p256_public_key(b64: &str) -> Result<VerifyingKey, PayloadError> {
    let bytes = canonical_b64_of_len("public_key", b64, P256_PUBLIC_KEY_LEN)
        .map_err(|_| PayloadError::PublicKey)?;
    if !matches!(bytes[0], 0x02 | 0x03) {
        return Err(PayloadError::PublicKey);
    }
    VerifyingKey::from_sec1_bytes(&bytes).map_err(|_| PayloadError::PublicKey)
}

/// The Security framework hands out an EC public key as X9.63 uncompressed
/// (`04‖X‖Y`, 65 bytes); the server and workd store the compressed form.
pub fn compress_x963_public_key(x963: &[u8]) -> Option<[u8; P256_PUBLIC_KEY_LEN]> {
    let key = VerifyingKey::from_sec1_bytes(x963).ok()?;
    let point = key.to_encoded_point(true);
    let mut out = [0u8; P256_PUBLIC_KEY_LEN];
    out.copy_from_slice(point.as_bytes());
    Some(out)
}

/// `SecKeyCreateSignature(…X962SHA256)` answers in DER; the wire form is raw
/// `r‖s`, and the stored form is low-s (E1's normalize-then-verify rule).
pub fn der_to_raw_low_s(der: &[u8]) -> Option<[u8; P256_SIGNATURE_LEN]> {
    let signature = Signature::from_der(der).ok()?;
    let signature = signature.normalize_s().unwrap_or(signature);
    let mut out = [0u8; P256_SIGNATURE_LEN];
    out.copy_from_slice(&signature.to_bytes());
    Some(out)
}

/// Verify raw `r‖s` over `payload` (either s form). The shell checks every
/// enclave signature against the enclave's own public key before handing it
/// out, so an encoding slip fails here and not on the server.
pub fn verify_raw(public_key: &[u8], payload: &[u8], raw: &[u8]) -> bool {
    let Ok(key) = VerifyingKey::from_sec1_bytes(public_key) else {
        return false;
    };
    let Ok(signature) = Signature::from_slice(raw) else {
        return false;
    };
    let signature = signature.normalize_s().unwrap_or(signature);
    key.verify(payload, &signature).is_ok()
}

/// The fingerprint a person compares between the phone and this Mac:
/// SHA-256 over the 33 compressed-key bytes, the first 10 bytes as upper-case
/// hex in five groups of four (`clients/web/src/features/settings/deviceKeysShared.ts`
/// `deviceKeyFingerprint` computes the same, the shared case pins both).
pub fn fingerprint(public_key_b64: &str) -> Option<String> {
    let bytes = BASE64.decode(public_key_b64).ok()?;
    let digest = Sha256::digest(&bytes);
    let hex = hex::encode_upper(&digest[..10]);
    Some(
        hex.as_bytes()
            .chunks(4)
            .map(|chunk| std::str::from_utf8(chunk).expect("ascii"))
            .collect::<Vec<_>>()
            .join(" "),
    )
}

// ---- the native confirmation ------------------------------------------------

/// What the native dialog shows before the enclave is asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Summary {
    pub title: String,
    pub body: String,
    pub confirm: String,
    /// The whole instruction or first prompt, shown in a scrolling read-only
    /// view under the body: every signed character is on screen (security
    /// review H3), not only the first line.
    pub full_text: Option<String>,
}

const SUMMARY_LINE_CHARS: usize = 80;

/// One line of display text: the first non-blank line, trimmed to
/// [`SUMMARY_LINE_CHARS`]. Control and hidden characters never reach the
/// dialog (the signer already refuses them in signed text).
pub fn first_line(text: &str) -> String {
    let normalized = nfc(text);
    let mut lines = normalized.lines().map(str::trim).filter(|l| !l.is_empty());
    let Some(first) = lines.next() else {
        return "(빈 내용)".to_string();
    };
    let clean: String = first
        .chars()
        .filter(|c| !c.is_control() && !is_hidden_char(*c))
        .collect();
    let mut out: String = clean.chars().take(SUMMARY_LINE_CHARS).collect();
    if clean.chars().count() > SUMMARY_LINE_CHARS {
        out.push('…');
    }
    out
}

/// "3줄, 120자" for the text the scrolling view holds.
pub fn text_size(text: &str) -> String {
    let normalized = nfc(text);
    format!(
        "{}줄, {}자",
        normalized.lines().count().max(1),
        normalized.chars().count()
    )
}

fn short_id(id: Uuid) -> String {
    // The tail: a UUIDv7's head is its timestamp, so rows made the same day
    // share it and it would not tell two keys apart.
    let text = id.simple().to_string();
    text[text.len() - 8..].to_string()
}

/// The `host_register` dialog (security review H5, #3120): the person is
/// vouching for a host key with the root key, so the dialog shows the host
/// key (its fingerprint in the body, every character in the scrolling view),
/// the host id candidate in full and the label, and nothing about "이 맥" or
/// "다른 호스트" (the host does not exist yet).
fn host_register_summary(request: &ControlRequest) -> Summary {
    let ControlContent::HostRegister {
        host_public_key_b64,
        host_id,
        label,
    } = &request.content
    else {
        unreachable!("only called for host_register")
    };
    Summary {
        title: "oort: 이 맥의 작업 호스트 등록에 서명합니다".into(),
        body: format!(
            "호스트 키 지문: {}\n호스트 ID: {host_id}\n이름: 「{}」\n워크스페이스: {}\n서버 인스턴스: {}\n방금 이 맥에서 시작한 등록일 때만 서명하세요. 서명하면 이 호스트가 내 이름으로 지시를 받을 수 있게 됩니다.",
            fingerprint(host_public_key_b64).unwrap_or_else(|| "(읽을 수 없음)".into()),
            nfc(label),
            request.workspace_id,
            request.instance_id,
        ),
        confirm: "서명".into(),
        full_text: Some(format!("호스트 공개키 전체\n{host_public_key_b64}")),
    }
}

/// Whether `summary` shows everything a `host_register` signature covers:
/// the key's fingerprint, the whole key, the whole host id, the label, and
/// which workspace on which server instance it is for.
/// `sign_statement` refuses to ask, let alone sign, when one is missing.
pub fn host_register_dialog_complete(summary: &Summary, request: &ControlRequest) -> bool {
    let content = &request.content;
    let ControlContent::HostRegister {
        host_public_key_b64,
        host_id,
        label,
    } = content
    else {
        return true;
    };
    let fingerprint_shown = fingerprint(host_public_key_b64)
        .is_some_and(|fingerprint| summary.body.contains(&fingerprint));
    fingerprint_shown
        && summary.body.contains(&request.workspace_id.to_string())
        && summary.body.contains(&request.instance_id)
        && summary.body.contains(&host_id.to_string())
        && summary.body.contains(&nfc(label))
        && summary
            .full_text
            .as_ref()
            .is_some_and(|full| full.contains(host_public_key_b64.as_str()))
}

impl Statement {
    /// `local_host`: the host id this Mac is registered as, so "이 맥" can be
    /// named instead of an id.
    pub fn summary(&self, local_host: Option<Uuid>) -> Summary {
        match self {
            Statement::Control { request, .. } => {
                if let ControlContent::HostRegister { .. } = &request.content {
                    return host_register_summary(request);
                }
                let host = if Some(request.host_id) == local_host {
                    format!("이 맥 ({})", short_id(request.host_id))
                } else {
                    format!("다른 호스트 ({})", short_id(request.host_id))
                };
                let target = match request.session_id {
                    Some(id) => format!("{host}, 세션 {}", short_id(id)),
                    None => host,
                };
                let (kind, lines, full_text): (&str, Vec<String>, Option<String>) =
                    match &request.content {
                        ControlContent::Input { mode, text } => (
                            match mode {
                                InputMode::Queue => "지시 (다음 차례)",
                                InputMode::Interrupt => "지시 (지금 끼어들기)",
                            },
                            vec![format!("내용: {} ({})", first_line(text), text_size(text))],
                            Some(nfc(text)),
                        ),
                        ControlContent::Spawn {
                            agent_member_id,
                            folder_id,
                            tool,
                            channel_id,
                            first_prompt,
                        } => (
                            if request.session_id.is_some() {
                                "이어서 하기"
                            } else {
                                "새 작업"
                            },
                            vec![
                                format!(
                                    "에이전트 {}, 도구 {}, 폴더 {}",
                                    short_id(*agent_member_id),
                                    first_line(tool),
                                    first_line(folder_id)
                                ),
                                // R2-E8 보안 Low (#3096): the channel the
                                // session thread lives in is bound by the
                                // signature (v2); the dialog names it.
                                format!("채널 {}", short_id(*channel_id)),
                                format!(
                                    "첫 지시: {} ({})",
                                    first_line(first_prompt),
                                    text_size(first_prompt)
                                ),
                            ],
                            Some(nfc(first_prompt)),
                        ),
                        ControlContent::SpawnTask {
                            agent_member_id,
                            folder_id,
                            tool,
                            channel_id,
                            thread_root_id,
                            origin_message_id,
                            label,
                            prompt,
                        } => (
                            "새 작업 맡기기",
                            vec![
                                format!(
                                    "에이전트 {}, 도구 {}, 폴더 {}",
                                    agent_member_id
                                        .map_or_else(|| "없음 (내 도구)".to_string(), short_id),
                                    first_line(tool),
                                    first_line(folder_id)
                                ),
                                // The room, thread and message are signed.
                                format!(
                                    "채널 {}, {}, {}",
                                    short_id(*channel_id),
                                    thread_root_id
                                        .map_or_else(|| "스레드 없음".to_string(), |id| format!("스레드 {}", short_id(id))),
                                    origin_message_id
                                        .map_or_else(|| "원본 메시지 없음".to_string(), |id| format!("메시지 {}", short_id(id))),
                                ),
                                // The title is a line of its own: the server
                                // shows it on the card, so it is signed.
                                format!("제목: 「{}」", first_line(label)),
                                format!(
                                    "프롬프트: {} ({})",
                                    first_line(prompt),
                                    text_size(prompt)
                                ),
                            ],
                            Some(nfc(prompt)),
                        ),
                        ControlContent::Permission {
                            request_event_id,
                            option_id,
                            option_kind,
                            scope,
                            preview,
                            ..
                        } => {
                            let mut lines = vec![format!(
                                "요청 {}, 선택 {} ({}), {}",
                                short_id(*request_event_id),
                                first_line(option_id),
                                first_line(option_kind),
                                match scope {
                                    PermissionScope::Once => "이번 한 번",
                                    PermissionScope::Session => "이 세션 동안",
                                }
                            )];
                            // #3128: the preview whose hash the statement
                            // signs, whole, in the scrolling view. Only a
                            // preview that passed `check_permission_preview`
                            // reaches a dialog (`sign_statement` builds the
                            // bytes first).
                            let view = preview.as_ref().and_then(|p| parse_preview(p).ok());
                            let full_text = match &view {
                                Some(view) => {
                                    lines.push(format!(
                                        "도구: {}, {}",
                                        preview_kind_label(&view.kind),
                                        if view.title.trim().is_empty() {
                                            "제목 없음".to_string()
                                        } else {
                                            first_line(&view.title)
                                        }
                                    ));
                                    let places = view.locations.lines().filter(|l| !l.trim().is_empty()).count();
                                    lines.push(format!(
                                        "위치 {places}곳, 입력 {}자. 아래 칸이 서명하는 미리보기 전체예요.",
                                        view.input.chars().count()
                                    ));
                                    Some(preview_full_text(view))
                                }
                                None => {
                                    lines.push("미리보기 없음".to_string());
                                    None
                                }
                            };
                            ("권한 허용", lines, full_text)
                        }
                        ControlContent::BundleManifest { manifest } => (
                            "설정 묶음 목록",
                            vec![match manifest.get("items").and_then(|v| v.as_array()) {
                                Some(items) => format!("항목 {}개", items.len()),
                                None => "목록".to_string(),
                            }],
                            None,
                        ),
                        // Built by `host_register_summary` above; a dialog that
                        // cannot show all of it is refused (`sign_statement`).
                        ControlContent::HostRegister { .. } => {
                            unreachable!("host_register returns its own summary")
                        }
                    };
                let mut body = format!("대상: {target}");
                for line in lines {
                    body.push('\n');
                    body.push_str(&line);
                }
                Summary {
                    title: format!("oort: {kind}에 서명합니다"),
                    body,
                    confirm: "서명".into(),
                    full_text,
                }
            }
            Statement::Endorse { request, .. } => Summary {
                title: "oort: 이 폰을 지시 기기로 승인합니다".into(),
                body: format!(
                    "지문: {}\n기기 이름: 「{}」, 키 {}\n설정 화면에 보인 지문과 같고, 방금 연결한 폰이 맞을 때만 승인하세요.",
                    fingerprint(&request.target_public_key).unwrap_or_default(),
                    first_line(&request.label),
                    short_id(request.target_key_id),
                ),
                confirm: "승인".into(),
                full_text: None,
            },
            Statement::Revoke {
                request,
                target_public_key,
                ..
            } => Summary {
                title: "oort: 이 기기의 지시 권한을 끊습니다".into(),
                // The fingerprint is the key this Mac's host will stop
                // trusting: the one this shell endorsed under that id, which
                // the v2 letter signs (security review H1b, #3028).
                body: format!(
                    "지문: {}\n기기 이름: 「{}」, 키 {}\n끊은 기기는 이 맥에서 다시 승인해야 지시할 수 있습니다.",
                    fingerprint(target_public_key).unwrap_or_else(|| "(읽을 수 없음)".into()),
                    if request.target_label.trim().is_empty() {
                        "이름 없음".to_string()
                    } else {
                        first_line(&request.target_label)
                    },
                    short_id(request.target_key_id),
                ),
                confirm: "끊기".into(),
                full_text: None,
            },
            Statement::Rebind {
                signer, public_key, ..
            } => Summary {
                title: "oort: 이 맥의 서명 키를 새 로그인에 다시 연결합니다".into(),
                body: format!(
                    "지문: {}\n키 {}\n로그인이 끊긴 사이 이 키는 서명할 수 없었습니다. 같은 키를 이 로그인으로 옮기며, 폰 승인과 작업 호스트 고정은 그대로입니다.",
                    fingerprint(public_key).unwrap_or_else(|| "(읽을 수 없음)".into()),
                    short_id(signer.key_id),
                ),
                confirm: "다시 연결".into(),
                full_text: None,
            },
        }
    }
}

/// The preview kind in the words the cards use.
pub fn preview_kind_label(kind: &str) -> &'static str {
    match kind {
        "read" => "파일 읽기",
        "edit" => "파일 고치기",
        "delete" => "파일 지우기",
        "move" => "파일 옮기기",
        "search" => "검색",
        "execute" => "명령 실행",
        "think" => "생각 정리",
        "fetch" => "웹에서 가져오기",
        "switch_mode" => "모드 바꾸기",
        _ => "기타 도구",
    }
}

/// Every hashed character of the preview, under a heading per field. The
/// text fields go in as they are (the check refused anything the dialog would
/// not show as is); an empty field says so instead of leaving a gap.
///
/// The agent writes the title, and a field may hold line breaks, so a field
/// could otherwise carry a fake `[입력]` heading and push the real one below
/// the fold of the scroll box (#3128 security review M). So every line of a
/// field starts with a gutter mark a heading never has, and the input — what
/// actually runs — comes first.
pub fn preview_full_text(view: &PreviewView) -> String {
    let field = |text: &str| {
        if text.is_empty() {
            "│ (없음)".to_string()
        } else {
            text.split('\n')
                .map(|line| format!("│ {line}"))
                .collect::<Vec<_>>()
                .join("\n")
        }
    };
    format!(
        "[도구] {}\n\n[입력]\n{}\n\n[위치]\n{}\n\n[제목]\n{}",
        preview_kind_label(&view.kind),
        field(&view.input),
        field(&view.locations),
        field(&view.title),
    )
}

// ---- field rules (E1) --------------------------------------------------------

fn nfc(s: &str) -> String {
    s.nfc().collect()
}

fn token(field: &'static str, value: &str) -> Result<(), PayloadError> {
    if value.is_empty() {
        return Err(PayloadError::Field(field, "empty"));
    }
    no_control(field, value)?;
    no_hidden(field, value)
}

/// Characters that render as nothing, or as a line break a dialog cannot
/// tell from a real one, yet are signed: format characters (Cf, bidi and
/// zero-width included, U+200D ZWJ excepted so emoji sequences survive),
/// variation selectors (U+FE0F, the emoji presentation selector, excepted),
/// blank fillers (Hangul fillers, U+034F, U+180B–D, U+2800), the
/// Unicode line and paragraph separators (Zl, Zp), private use (Co) and the
/// tag block a language model reads but a person cannot see. E1 only refuses
/// Cc; this signer refuses more, so it never signs what it could not show
/// (security review H2·H3).
pub fn is_hidden_char(c: char) -> bool {
    matches!(
        c as u32,
        0x00AD
            | 0x034F
            | 0x115F..=0x1160
            | 0x180B..=0x180D
            | 0x2800
            | 0x3164
            | 0xFE00..=0xFE0E
            | 0xFFA0
            | 0xE0100..=0xE01EF
            | 0x0600..=0x0605
            | 0x061C
            | 0x06DD
            | 0x070F
            | 0x0890..=0x0891
            | 0x08E2
            | 0x180E
            | 0x200B..=0x200C
            | 0x200E..=0x200F
            | 0x2028..=0x202E
            | 0x2060..=0x2064
            | 0x2066..=0x206F
            | 0xFEFF
            | 0xFFF9..=0xFFFB
            | 0x110BD
            | 0x110CD
            | 0x13430..=0x1343F
            | 0x1BCA0..=0x1BCA3
            | 0x1D173..=0x1D17A
            | 0xE000..=0xF8FF
            | 0xE0000..=0xE007F
            | 0xF0000..=0x10FFFF
    )
}

fn no_hidden(field: &'static str, value: &str) -> Result<(), PayloadError> {
    if value.chars().any(is_hidden_char) {
        return Err(PayloadError::Field(field, "invisible character"));
    }
    Ok(())
}

/// Free text a person reads (an instruction, a first prompt): line breaks
/// and tabs are text; every other control character and every hidden one is
/// refused.
fn readable_text(field: &'static str, value: &str) -> Result<(), PayloadError> {
    if value
        .chars()
        .any(|c| (c.is_control() && c != '\n' && c != '\t') || is_hidden_char(c))
    {
        return Err(PayloadError::Field(field, "invisible or control character"));
    }
    Ok(())
}

/// The title of a new task (#3592): one trimmed NFC line of 1...120 characters
/// (the server's `validated_label`), nothing hidden. Signed as the server stores it.
fn spawn_label_ok(value: &str) -> Result<(), PayloadError> {
    // The statement signs the NFC form (the page may hand over decomposed text).
    let value = nfc(value);
    label_ok(&value)?;
    if value.trim() != value {
        return Err(PayloadError::Field("label", "not trimmed"));
    }
    let chars = value.chars().count();
    if !(1..=120).contains(&chars) {
        return Err(PayloadError::Field("label", "1...120 characters"));
    }
    Ok(())
}

/// The prompt of a new task: text of 1...32768 characters, line breaks and
/// tabs allowed (as in `readable_text`), not blank, not an adapter command.
fn spawn_prompt_ok(value: &str) -> Result<(), PayloadError> {
    let value = nfc(value);
    let value = value.as_str();
    readable_text("prompt", value)?;
    let chars = value.chars().count();
    if chars == 0 || chars > 32_768 || value.trim().is_empty() {
        return Err(PayloadError::Field("prompt", "1...32768 characters"));
    }
    if value.trim_start().starts_with('/') {
        return Err(PayloadError::Field("prompt", "starts with /"));
    }
    Ok(())
}

/// A label: one line, nothing hidden.
fn label_ok(value: &str) -> Result<(), PayloadError> {
    no_control("label", value)?;
    no_hidden("label", value)
}

fn no_control(field: &'static str, value: &str) -> Result<(), PayloadError> {
    if value.chars().any(char::is_control) {
        return Err(PayloadError::Field(field, "control character"));
    }
    Ok(())
}

fn canonical_b64_of_len(
    field: &'static str,
    value: &str,
    len: usize,
) -> Result<Vec<u8>, PayloadError> {
    let bytes = BASE64
        .decode(value)
        .map_err(|_| PayloadError::Field(field, "not base64"))?;
    if bytes.len() != len {
        return Err(PayloadError::Field(field, "wrong length"));
    }
    if BASE64.encode(&bytes) != value {
        return Err(PayloadError::Field(field, "not canonical base64"));
    }
    Ok(bytes)
}

/// RFC 8785 restricted to integers — E1's `canonical_json`, byte for byte.
pub fn canonical_json(value: &serde_json::Value) -> Result<String, PayloadError> {
    let mut out = String::new();
    write_canonical(value, &mut out)?;
    Ok(out)
}

fn write_canonical(value: &serde_json::Value, out: &mut String) -> Result<(), PayloadError> {
    use serde_json::Value;
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            let int = n
                .as_i64()
                .filter(|i| (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(i))
                .ok_or(PayloadError::ManifestNumber)?;
            out.push_str(&int.to_string());
        }
        Value::String(s) => write_json_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, (key, item)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json_string(key, out);
                out.push(':');
                write_canonical(item, out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

fn write_json_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0C}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests;
