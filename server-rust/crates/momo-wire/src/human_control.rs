//! Human device-key signing — ADR-0146 개정 2026-09-28 (R2), D-1 · D-5 · D-9.
//!
//! A person's phone or Mac holds a Secure Enclave **P-256** key. It signs the
//! bytes this module builds; the server (E3 #3023) and workd (E4 #3024) rebuild
//! the same bytes from what they hold and verify with [`verify_p256`]. Host and
//! agent keys stay Ed25519 ([`crate::signing`]).
//!
//! Three sibling schemas, all in the `momo-wire` convention (schema string +
//! `\n`-joined fields, UTF-8, no trailing newline):
//!
//! ```text
//! momo.human.control.v2          momo.human.device_endorse.v1   momo.human.device_revoke.v1
//! {instance_id}                  {workspace_id}                 {workspace_id}
//! {workspace_id}                 {member_id}                    {member_id}
//! {member_id}                    {root_key_id}                  {root_key_id}
//! {device_key_id}                {target_alg}                   {target_key_id}
//! {host_id}                      {target_public_key_b64}        {revoked_at_ms}
//! {session_id | "-"}             {label (NFC)}
//! {kind}
//! {mode | "-"}
//! {nonce}
//! {issued_at_ms}
//! {expires_at_ms}
//! {content_sha256}
//! ```
//!
//! ## Field rules (what E1 fixes on top of the ADR)
//!
//! * UUIDs render lowercase + hyphenated (`Uuid` `Display`), integers as plain
//!   base-10, `content_sha256` as lowercase hex.
//! * Every free-form token (`instance_id`, `folder_id`, `option_id`,
//!   `option_kind`, labels) must be free of control characters, so no field can
//!   smuggle a `\n` and move a boundary. Tokens must also be non-empty; labels
//!   may be empty.
//! * A multi-field content body puts its fixed-format fields first and **at most
//!   one** free-text field last. The last field may contain `\n` (a first prompt
//!   is multi-line) without ambiguity because nothing before it can.
//! * Human-written text is NFC-normalized before hashing: the `input` body, the
//!   `spawn` first prompt, and labels. Machine data (IDs, the manifest JSON) is
//!   not.
//! * Public keys inside signed bytes are base64 STANDARD (padded) of the
//!   33-byte compressed SEC1 point, and must be the canonical encoding.
//!
//! ## Content bodies (`content_sha256` = SHA-256 of these bytes)
//!
//! | kind              | bytes                                                         |
//! |-------------------|---------------------------------------------------------------|
//! | `input`           | `NFC(text)`                                                   |
//! | `spawn` (v2)      | `{agent_member_id}\n{folder_id}\n{tool}\n{channel_id}\n{NFC(first_prompt)}` |
//! | `spawn` (v1)      | `{agent_member_id}\n{folder_id}\n{NFC(first_prompt)}` (retired) |
//! | `permission`      | `{request_event_id}\n{option_id}\n{option_kind}\n{scope}`     |
//! | `bundle_manifest` | [`canonical_json`] of the manifest                            |
//! | `host_register`   | `{host_public_key_b64}\n{host_id}\n{NFC(label)}`              |
//!
//! ## v2 (R2-E7 #3027) and what stays of v1
//!
//! `momo.human.control.v2` keeps v1's 13-line frame — only the schema string
//! changes — so a signer that checks the line count needs no other change.
//! Two things differ, both about `spawn`:
//!
//! * its content binds the **`tool`** (the allowlist key the host launches)
//!   and the **`channel_id`** (the room the session belongs to) as fixed
//!   fields before the free-text prompt. Under v1 a server could have swapped
//!   either under a valid signature (E4 #3063 deviation ①);
//! * its session line may carry a session: a resume names the successor
//!   session the owner chose, so the server cannot pick which session the
//!   owner's words join (#3024 review M2). A fresh spawn still writes `-`.
//!
//! Every other kind is byte-identical to v1 apart from the first line.
//! Verifiers ([`HumanControl::verify_any`]) therefore accept a v1 statement
//! for those kinds — nothing a v1 signature says differs from the v2 one —
//! and refuse a v1 `spawn`, which never bound the tool or the channel. (The
//! phone's native signer allows `momo.human.control.v1` only until its
//! allowlist moves; input and permission keep working meanwhile.)
//!
//! ## high-s: normalize, then verify (one rule, fixed here)
//!
//! ECDSA is malleable: `(r, s)` and `(r, n − s)` both verify. Neither CryptoKit
//! nor WebCrypto emits low-s, so a "reject high-s" rule would bounce about half
//! of all genuine client signatures unless every client added its own
//! normalization step — three extra implementations of a step whose omission
//! fails at random. ADR-0146 D-1 already puts one-time use on the **nonce**
//! (D-9), not on signature bytes, so malleability buys an attacker nothing.
//! Therefore: [`verify_p256`] accepts either form, verifies the **low-s** form,
//! and returns the canonical low-s 64 bytes. Whoever stores or dedups a
//! signature (E3's `action_signature` row) stores that return value, so both
//! forms of one signature collapse to one row.
//!
//! Freshness is a pure function here ([`check_control_window`]); the nonce
//! ledger lives in E3 (server) and E4 (workd).

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use p256::ecdsa::signature::Verifier as _;
use p256::ecdsa::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization as _;
use uuid::Uuid;

/// Retired for `spawn`; still accepted for `input` / `permission` (see the
/// module docs, v2).
pub const HUMAN_CONTROL_SCHEMA_V1: &str = "momo.human.control.v1";
/// The current control schema (R2-E7 #3027).
pub const HUMAN_CONTROL_SCHEMA_V2: &str = "momo.human.control.v2";
pub const DEVICE_ENDORSE_SCHEMA_V1: &str = "momo.human.device_endorse.v1";
pub const DEVICE_REVOKE_SCHEMA_V1: &str = "momo.human.device_revoke.v1";

/// The placeholder for an absent `session_id` / `mode`.
pub const ABSENT: &str = "-";

/// `expires_at_ms − issued_at_ms` ceiling (ADR-0146 D-5, D-9: 발급 + 최대 10분).
pub const MAX_LIFETIME_MS: i64 = 10 * 60 * 1000;
/// `|now − issued_at_ms|` ceiling (ADR-0146 D-9: 서버 시각 기준 ±5분).
pub const MAX_CLOCK_SKEW_MS: i64 = 5 * 60 * 1000;
/// Largest integer every signer can represent exactly (JS `Number.MAX_SAFE_INTEGER`).
pub const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

/// Length of a compressed SEC1 P-256 public key.
pub const P256_PUBLIC_KEY_LEN: usize = 33;
/// Length of a raw `r‖s` P-256 signature.
pub const P256_SIGNATURE_LEN: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HumanSigningError {
    #[error("field `{field}` is invalid: {reason}")]
    InvalidField {
        field: &'static str,
        reason: &'static str,
    },
    #[error("kind `{0}` requires a session_id")]
    SessionRequired(&'static str),
    #[error("kind `{0}` must not carry a session_id")]
    SessionForbidden(&'static str),
    #[error("host_register: payload host_id and content host_id differ")]
    HostIdMismatch,
    #[error("bundle manifest: numbers must be integers within ±(2^53−1)")]
    ManifestNumber,
    #[error("P-256 public key must be a 33-byte compressed SEC1 point on the curve")]
    PublicKey,
    #[error("P-256 signature must be 64 bytes r‖s with r, s in [1, n−1]")]
    SignatureEncoding,
    #[error("P-256 signature does not verify")]
    BadSignature,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum FreshnessError {
    #[error("expires_at_ms is not after issued_at_ms")]
    ExpiresNotAfterIssued,
    #[error("lifetime exceeds {MAX_LIFETIME_MS} ms")]
    LifetimeTooLong,
    #[error("issued_at_ms is more than {MAX_CLOCK_SKEW_MS} ms from now")]
    ClockSkew,
    #[error("expired")]
    Expired,
}

/// Which `momo.human.control` schema a statement is built in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlSchema {
    V1,
    V2,
}

impl ControlSchema {
    pub fn as_str(self) -> &'static str {
        match self {
            ControlSchema::V1 => HUMAN_CONTROL_SCHEMA_V1,
            ControlSchema::V2 => HUMAN_CONTROL_SCHEMA_V2,
        }
    }
}

/// `input` delivery mode. The server may not turn a queued input into an
/// interrupt: the mode is inside the signed bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

/// Permission scope (ADR-0146 D-8: 「이번 한 번」 · 「이 세션 동안」).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

/// Algorithm of a human device key (the `alg` column, ADR-0146 D-1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceKeyAlg {
    /// ECDSA P-256 / SHA-256, raw `r‖s`, compressed SEC1 public key.
    P256,
}

impl DeviceKeyAlg {
    pub fn as_str(self) -> &'static str {
        match self {
            DeviceKeyAlg::P256 => "p256",
        }
    }
}

/// The kind-specific content a control signs over via `content_sha256`.
/// The variant fixes `kind` (and, for `input`, `mode`).
#[derive(Debug, Clone, PartialEq)]
pub enum ControlContent<'a> {
    Input {
        mode: InputMode,
        text: &'a str,
    },
    Spawn {
        agent_member_id: Uuid,
        /// ADR-0188 D6 opaque folder id.
        folder_id: &'a str,
        /// v2: the allowlist key the host launches (`payload.tool`). Not
        /// encoded under v1.
        tool: &'a str,
        /// v2: the room the session belongs to (`work_control.channel_id`).
        /// Not encoded under v1.
        channel_id: Uuid,
        first_prompt: &'a str,
    },
    Permission {
        /// The D5 host nonce this decision answers.
        request_event_id: Uuid,
        option_id: &'a str,
        option_kind: &'a str,
        scope: PermissionScope,
    },
    BundleManifest {
        manifest: &'a serde_json::Value,
    },
    HostRegister {
        /// Base64 32-byte Ed25519 host public key.
        host_public_key_b64: &'a str,
        host_id: Uuid,
        label: &'a str,
    },
}

impl ControlContent<'_> {
    pub fn kind(&self) -> &'static str {
        match self {
            ControlContent::Input { .. } => "input",
            ControlContent::Spawn { .. } => "spawn",
            ControlContent::Permission { .. } => "permission",
            ControlContent::BundleManifest { .. } => "bundle_manifest",
            ControlContent::HostRegister { .. } => "host_register",
        }
    }

    /// `mode` line: `queue`/`interrupt` for `input`, [`ABSENT`] otherwise.
    pub fn mode(&self) -> &'static str {
        match self {
            ControlContent::Input { mode, .. } => mode.as_str(),
            _ => ABSENT,
        }
    }

    /// The session line's rule for this kind under `schema`.
    fn session_rule(&self, schema: ControlSchema) -> SessionRule {
        match (self, schema) {
            (ControlContent::Input { .. } | ControlContent::Permission { .. }, _) => {
                SessionRule::Required
            }
            (ControlContent::Spawn { .. }, ControlSchema::V2) => SessionRule::Optional,
            _ => SessionRule::Forbidden,
        }
    }

    /// The canonical content bytes (see the module table), in the current
    /// schema (v2).
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, HumanSigningError> {
        self.canonical_bytes_as(ControlSchema::V2)
    }

    /// The canonical content bytes under `schema`. Only `spawn` differs.
    pub fn canonical_bytes_as(&self, schema: ControlSchema) -> Result<Vec<u8>, HumanSigningError> {
        let text = match self {
            ControlContent::Input { text, .. } => nfc(text),
            ControlContent::Spawn {
                agent_member_id,
                folder_id,
                tool,
                channel_id,
                first_prompt,
            } => {
                token("folder_id", folder_id)?;
                match schema {
                    ControlSchema::V1 => {
                        format!("{agent_member_id}\n{folder_id}\n{}", nfc(first_prompt))
                    }
                    ControlSchema::V2 => {
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
            } => {
                token("option_id", option_id)?;
                token("option_kind", option_kind)?;
                format!(
                    "{request_event_id}\n{option_id}\n{option_kind}\n{}",
                    scope.as_str()
                )
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

    /// Lowercase hex SHA-256 of [`Self::canonical_bytes`].
    pub fn content_sha256(&self) -> Result<String, HumanSigningError> {
        self.content_sha256_as(ControlSchema::V2)
    }

    /// Lowercase hex SHA-256 of [`Self::canonical_bytes_as`].
    pub fn content_sha256_as(&self, schema: ControlSchema) -> Result<String, HumanSigningError> {
        Ok(hex::encode(Sha256::digest(
            self.canonical_bytes_as(schema)?,
        )))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionRule {
    Required,
    Optional,
    Forbidden,
}

/// A `momo.human.control` statement (built as v2 unless a caller asks for v1).
#[derive(Debug, Clone, PartialEq)]
pub struct HumanControl<'a> {
    /// The server-issued instance id, echoed verbatim (never built from a URL).
    pub instance_id: &'a str,
    pub workspace_id: Uuid,
    pub member_id: Uuid,
    pub device_key_id: Uuid,
    /// Target host; for `host_register`, the host id candidate.
    pub host_id: Uuid,
    /// Required for `input`/`permission`; optional for a v2 `spawn` (a
    /// resume's successor session); absent for the rest.
    pub session_id: Option<Uuid>,
    /// 128-bit random; for `input` it is the `client_msg_id`.
    pub nonce: Uuid,
    pub issued_at_ms: i64,
    pub expires_at_ms: i64,
    pub content: ControlContent<'a>,
}

impl HumanControl<'_> {
    /// The 13-line v2 bytes the device key signs. Structural rules only;
    /// time is [`check_control_window`]'s job.
    pub fn signed_bytes(&self) -> Result<Vec<u8>, HumanSigningError> {
        self.signed_bytes_as(ControlSchema::V2)
    }

    /// The 13-line bytes under `schema`.
    pub fn signed_bytes_as(&self, schema: ControlSchema) -> Result<Vec<u8>, HumanSigningError> {
        token("instance_id", self.instance_id)?;
        let kind = self.content.kind();
        let session = match (self.content.session_rule(schema), self.session_id) {
            (SessionRule::Required | SessionRule::Optional, Some(id)) => id.to_string(),
            (SessionRule::Required, None) => return Err(HumanSigningError::SessionRequired(kind)),
            (SessionRule::Optional | SessionRule::Forbidden, None) => ABSENT.to_string(),
            (SessionRule::Forbidden, Some(_)) => {
                return Err(HumanSigningError::SessionForbidden(kind))
            }
        };
        if let ControlContent::HostRegister { host_id, .. } = &self.content {
            if *host_id != self.host_id {
                return Err(HumanSigningError::HostIdMismatch);
            }
        }
        let content_sha256 = self.content.content_sha256_as(schema)?;
        Ok(format!(
            "{}\n{}\n{}\n{}\n{}\n{}\n{session}\n{kind}\n{}\n{}\n{}\n{}\n{content_sha256}",
            schema.as_str(),
            self.instance_id,
            self.workspace_id,
            self.member_id,
            self.device_key_id,
            self.host_id,
            self.content.mode(),
            self.nonce,
            self.issued_at_ms,
            self.expires_at_ms,
        )
        .into_bytes())
    }

    /// Rebuild the v2 bytes and verify `signature` (raw `r‖s`) under the
    /// device key. Returns the canonical low-s signature. Does not check time.
    pub fn verify(
        &self,
        device_public_key: &[u8],
        signature: &[u8],
    ) -> Result<[u8; P256_SIGNATURE_LEN], HumanSigningError> {
        verify_p256(device_public_key, &self.signed_bytes()?, signature)
    }

    /// Verify under `schema`.
    pub fn verify_as(
        &self,
        schema: ControlSchema,
        device_public_key: &[u8],
        signature: &[u8],
    ) -> Result<[u8; P256_SIGNATURE_LEN], HumanSigningError> {
        verify_p256(device_public_key, &self.signed_bytes_as(schema)?, signature)
    }

    /// What a verifier accepts (module docs, v2): the v2 statement, or — for
    /// every kind but `spawn`, whose v1 bytes say the same thing — the v1 one.
    /// A v1 `spawn` is refused. Returns the schema that verified, its bytes
    /// and the canonical low-s signature.
    pub fn verify_any(
        &self,
        device_public_key: &[u8],
        signature: &[u8],
    ) -> Result<VerifiedStatement, HumanSigningError> {
        let v2 = self.signed_bytes_as(ControlSchema::V2)?;
        match verify_p256(device_public_key, &v2, signature) {
            Ok(canonical) => Ok(VerifiedStatement {
                schema: ControlSchema::V2,
                signed_bytes: v2,
                signature: canonical,
            }),
            Err(v2_error) => {
                if matches!(self.content, ControlContent::Spawn { .. }) {
                    return Err(v2_error);
                }
                let v1 = self.signed_bytes_as(ControlSchema::V1)?;
                let canonical = verify_p256(device_public_key, &v1, signature)?;
                Ok(VerifiedStatement {
                    schema: ControlSchema::V1,
                    signed_bytes: v1,
                    signature: canonical,
                })
            }
        }
    }
}

/// A statement [`HumanControl::verify_any`] accepted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedStatement {
    pub schema: ControlSchema,
    /// The exact bytes that verified (for `action_signature`).
    pub signed_bytes: Vec<u8>,
    /// Canonical low-s raw `r‖s`.
    pub signature: [u8; P256_SIGNATURE_LEN],
}

/// `momo.human.device_endorse.v1` — the root key approves another device key as
/// an instruction device. No expiry: it ends only by revocation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceEndorse<'a> {
    pub workspace_id: Uuid,
    pub member_id: Uuid,
    pub root_key_id: Uuid,
    pub target_alg: DeviceKeyAlg,
    /// Base64 of the 33-byte compressed SEC1 target key (canonical encoding).
    pub target_public_key_b64: &'a str,
    pub label: &'a str,
}

impl DeviceEndorse<'_> {
    pub fn signed_bytes(&self) -> Result<Vec<u8>, HumanSigningError> {
        match self.target_alg {
            DeviceKeyAlg::P256 => {
                let key = canonical_b64_of_len(
                    "target_public_key_b64",
                    self.target_public_key_b64,
                    P256_PUBLIC_KEY_LEN,
                )?;
                parse_p256_public_key(&key)?;
            }
        }
        label_ok(self.label)?;
        Ok(format!(
            "{DEVICE_ENDORSE_SCHEMA_V1}\n{}\n{}\n{}\n{}\n{}\n{}",
            self.workspace_id,
            self.member_id,
            self.root_key_id,
            self.target_alg.as_str(),
            self.target_public_key_b64,
            nfc(self.label),
        )
        .into_bytes())
    }

    pub fn verify(
        &self,
        root_public_key: &[u8],
        signature: &[u8],
    ) -> Result<[u8; P256_SIGNATURE_LEN], HumanSigningError> {
        verify_p256(root_public_key, &self.signed_bytes()?, signature)
    }
}

/// `momo.human.device_revoke.v1` — the root key revokes a device key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeviceRevoke {
    pub workspace_id: Uuid,
    pub member_id: Uuid,
    pub root_key_id: Uuid,
    pub target_key_id: Uuid,
    pub revoked_at_ms: i64,
}

impl DeviceRevoke {
    pub fn signed_bytes(&self) -> Vec<u8> {
        format!(
            "{DEVICE_REVOKE_SCHEMA_V1}\n{}\n{}\n{}\n{}\n{}",
            self.workspace_id,
            self.member_id,
            self.root_key_id,
            self.target_key_id,
            self.revoked_at_ms,
        )
        .into_bytes()
    }

    pub fn verify(
        &self,
        root_public_key: &[u8],
        signature: &[u8],
    ) -> Result<[u8; P256_SIGNATURE_LEN], HumanSigningError> {
        verify_p256(root_public_key, &self.signed_bytes(), signature)
    }
}

/// Freshness of a control against the verifier's clock (ADR-0146 D-9):
/// `issued < expires ≤ issued + 10 min`, `|now − issued| ≤ 5 min`, `now < expires`.
pub fn check_control_window(
    issued_at_ms: i64,
    expires_at_ms: i64,
    now_ms: i64,
) -> Result<(), FreshnessError> {
    let (issued, expires, now) = (
        i128::from(issued_at_ms),
        i128::from(expires_at_ms),
        i128::from(now_ms),
    );
    if expires <= issued {
        return Err(FreshnessError::ExpiresNotAfterIssued);
    }
    if expires - issued > i128::from(MAX_LIFETIME_MS) {
        return Err(FreshnessError::LifetimeTooLong);
    }
    if (now - issued).abs() > i128::from(MAX_CLOCK_SKEW_MS) {
        return Err(FreshnessError::ClockSkew);
    }
    if now >= expires {
        return Err(FreshnessError::Expired);
    }
    Ok(())
}

/// Parse a device public key: exactly 33 bytes, compressed SEC1 (`02`/`03`
/// prefix), a point on P-256. Uncompressed keys are refused so a key has one
/// stored form.
pub fn parse_p256_public_key(bytes: &[u8]) -> Result<VerifyingKey, HumanSigningError> {
    if bytes.len() != P256_PUBLIC_KEY_LEN || !matches!(bytes[0], 0x02 | 0x03) {
        return Err(HumanSigningError::PublicKey);
    }
    VerifyingKey::from_sec1_bytes(bytes).map_err(|_| HumanSigningError::PublicKey)
}

/// Canonical low-s form of a raw `r‖s` signature. Rejects bad length and
/// `r`/`s` outside `[1, n−1]`.
pub fn normalize_p256_signature(
    signature: &[u8],
) -> Result<[u8; P256_SIGNATURE_LEN], HumanSigningError> {
    let sig = Signature::from_slice(signature).map_err(|_| HumanSigningError::SignatureEncoding)?;
    let mut out = [0u8; P256_SIGNATURE_LEN];
    out.copy_from_slice(&sig.normalize_s().to_bytes());
    Ok(out)
}

/// Verify ECDSA P-256 / SHA-256 over `payload`. Normalizes `s` to low-s first
/// (see the module docs) and returns the canonical low-s signature bytes.
pub fn verify_p256(
    public_key: &[u8],
    payload: &[u8],
    signature: &[u8],
) -> Result<[u8; P256_SIGNATURE_LEN], HumanSigningError> {
    let key = parse_p256_public_key(public_key)?;
    let canonical = normalize_p256_signature(signature)?;
    let sig =
        Signature::from_slice(&canonical).map_err(|_| HumanSigningError::SignatureEncoding)?;
    key.verify(payload, &sig)
        .map_err(|_| HumanSigningError::BadSignature)?;
    Ok(canonical)
}

/// [`verify_p256`] over base64 STANDARD key and signature.
pub fn verify_p256_base64(
    public_key_b64: &str,
    payload: &[u8],
    signature_b64: &str,
) -> Result<[u8; P256_SIGNATURE_LEN], HumanSigningError> {
    let key = BASE64
        .decode(public_key_b64)
        .map_err(|_| HumanSigningError::PublicKey)?;
    let sig = BASE64
        .decode(signature_b64)
        .map_err(|_| HumanSigningError::SignatureEncoding)?;
    verify_p256(&key, payload, &sig)
}

/// Canonical JSON for signed content (the `bundle_manifest` body): RFC 8785
/// (JCS) restricted to integer numbers. Compact, object keys sorted by UTF-16
/// code units (what JS `Array.prototype.sort` does), strings escaped as
/// `JSON.stringify` does (`\"` `\\` `\b` `\f` `\n` `\r` `\t`, other controls
/// `\u00xx` lowercase, everything else literal). Non-integers and integers
/// beyond ±(2^53−1) are refused rather than formatted, since the three signers
/// would not agree on them.
pub fn canonical_json(value: &serde_json::Value) -> Result<String, HumanSigningError> {
    let mut out = String::new();
    write_canonical(value, &mut out)?;
    Ok(out)
}

fn write_canonical(value: &serde_json::Value, out: &mut String) -> Result<(), HumanSigningError> {
    use serde_json::Value;
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            let int = n
                .as_i64()
                .filter(|i| (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(i))
                .ok_or(HumanSigningError::ManifestNumber)?;
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

fn nfc(s: &str) -> String {
    s.nfc().collect()
}

fn token(field: &'static str, value: &str) -> Result<(), HumanSigningError> {
    if value.is_empty() {
        return Err(HumanSigningError::InvalidField {
            field,
            reason: "empty",
        });
    }
    no_control(field, value)
}

fn label_ok(label: &str) -> Result<(), HumanSigningError> {
    no_control("label", label)
}

fn no_control(field: &'static str, value: &str) -> Result<(), HumanSigningError> {
    if value.chars().any(char::is_control) {
        return Err(HumanSigningError::InvalidField {
            field,
            reason: "contains a control character",
        });
    }
    Ok(())
}

fn canonical_b64_of_len(
    field: &'static str,
    value: &str,
    len: usize,
) -> Result<Vec<u8>, HumanSigningError> {
    let bytes = BASE64
        .decode(value)
        .map_err(|_| HumanSigningError::InvalidField {
            field,
            reason: "not base64",
        })?;
    if bytes.len() != len {
        return Err(HumanSigningError::InvalidField {
            field,
            reason: "wrong decoded length",
        });
    }
    if BASE64.encode(&bytes) != value {
        return Err(HumanSigningError::InvalidField {
            field,
            reason: "not the canonical base64 encoding",
        });
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_accepts_inside_and_rejects_each_edge() {
        let t = 1_790_000_000_000;
        assert_eq!(check_control_window(t, t + MAX_LIFETIME_MS, t), Ok(()));
        assert_eq!(
            check_control_window(t, t + MAX_LIFETIME_MS + 1, t),
            Err(FreshnessError::LifetimeTooLong)
        );
        assert_eq!(
            check_control_window(t, t, t),
            Err(FreshnessError::ExpiresNotAfterIssued)
        );
        assert_eq!(
            check_control_window(t, t + 1000, t + 1000),
            Err(FreshnessError::Expired)
        );
        assert_eq!(check_control_window(t, t + 1000, t + 999), Ok(()));
        // Skew both ways, exactly at and one past the ±5 min edge.
        assert_eq!(
            check_control_window(t, t + MAX_LIFETIME_MS, t - MAX_CLOCK_SKEW_MS),
            Ok(())
        );
        assert_eq!(
            check_control_window(t, t + MAX_LIFETIME_MS, t - MAX_CLOCK_SKEW_MS - 1),
            Err(FreshnessError::ClockSkew)
        );
        assert_eq!(
            check_control_window(t, t + MAX_LIFETIME_MS, t + MAX_CLOCK_SKEW_MS),
            Ok(())
        );
        assert_eq!(
            check_control_window(t, t + MAX_LIFETIME_MS, t + MAX_CLOCK_SKEW_MS + 1),
            Err(FreshnessError::ClockSkew)
        );
        // No overflow at the i64 extremes.
        assert!(check_control_window(i64::MIN, i64::MAX, 0).is_err());
    }

    #[test]
    fn canonical_json_sorts_by_utf16_and_escapes_like_json_stringify() {
        // U+FF61 sorts before U+1F600 in UTF-8/char order but after it in
        // UTF-16 (0xFF61 > 0xD83D) — JS order is the UTF-16 one.
        let v = serde_json::json!({"\u{FF61}": 1, "\u{1F600}": 2, "b": [true, null, "\u{1}\n\"é"], "a": -3});
        assert_eq!(
            canonical_json(&v).unwrap(),
            "{\"a\":-3,\"b\":[true,null,\"\\u0001\\n\\\"é\"],\"\u{1F600}\":2,\"\u{FF61}\":1}"
        );
        assert_eq!(
            canonical_json(&serde_json::json!({"x": 1.5})),
            Err(HumanSigningError::ManifestNumber)
        );
        assert_eq!(
            canonical_json(&serde_json::json!(MAX_SAFE_INTEGER + 1)),
            Err(HumanSigningError::ManifestNumber)
        );
        assert_eq!(
            canonical_json(&serde_json::json!(u64::MAX)),
            Err(HumanSigningError::ManifestNumber)
        );
    }

    #[test]
    fn newline_in_a_token_is_refused_so_no_boundary_can_move() {
        let content = ControlContent::Permission {
            request_event_id: Uuid::from_u128(1),
            option_id: "allow-once\nallow_once",
            option_kind: "x",
            scope: PermissionScope::Once,
        };
        assert!(matches!(
            content.canonical_bytes(),
            Err(HumanSigningError::InvalidField {
                field: "option_id",
                ..
            })
        ));
        let content = ControlContent::Spawn {
            agent_member_id: Uuid::from_u128(1),
            folder_id: "a\nb",
            tool: "claude",
            channel_id: Uuid::from_u128(2),
            first_prompt: "p",
        };
        assert!(content.canonical_bytes().is_err());
        let content = ControlContent::Spawn {
            agent_member_id: Uuid::from_u128(1),
            folder_id: "f",
            tool: "claude\ncodex",
            channel_id: Uuid::from_u128(2),
            first_prompt: "p",
        };
        assert!(matches!(
            content.canonical_bytes(),
            Err(HumanSigningError::InvalidField { field: "tool", .. })
        ));
    }
}
