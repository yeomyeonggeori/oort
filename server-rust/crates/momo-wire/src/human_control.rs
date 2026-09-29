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
//! momo.human.control.v3          momo.human.device_endorse.v1   momo.human.device_revoke.v2
//! {instance_id}                  {workspace_id}                 {workspace_id}
//! {workspace_id}                 {member_id}                    {member_id}
//! {member_id}                    {root_key_id}                  {root_key_id}
//! {device_key_id}                {target_alg}                   {target_key_id}
//! {host_id}                      {target_public_key_b64}        {target_public_key_b64}
//! {session_id | "-"}             {label (NFC)}                  {revoked_at_ms}
//! {kind}
//! {mode | "-"}
//! {nonce}
//! {issued_at_ms}
//! {expires_at_ms}
//! {content_sha256}
//! ```
//!
//! (`device_revoke.v1` is the v2 letter without the public-key line; a host
//! takes a revoked public key only from a v2 letter, #3068.
//! `momo.human.device_rebind.v1`, #3097, is signed by the key it moves — see
//! [`DeviceRebind`]. `momo.human.refresh_proof.v1`, #3079, is signed by a
//! lineage's refresh key on every refresh — see [`RefreshProof`].)
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
//! | `permission` (v3) | `{request_event_id}\n{option_id}\n{option_kind}\n{scope}\n{preview_sha256}` |
//! | `permission` (v1·v2) | `{request_event_id}\n{option_id}\n{option_kind}\n{scope}` (only for a request with no preview) |
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
//! Verifiers ([`HumanControl::verify_any`]) accepted a v1 statement for those
//! kinds while the signers moved — nothing a v1 signature says differs from
//! the v2 one — and always refused a v1 `spawn`, which never bound the tool or
//! the channel. **Since #3154 they refuse v1 altogether**: the phone
//! (#3028, #3153) and the desktop (#3028) sign v2 and v3 only, and no build a
//! team runs signs v1.
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
//! ## v3 (#3118, R2 H1): an allow binds the preview the person saw
//!
//! `momo.human.control.v3` is v2's frame again with only the first line
//! changed; one body differs. A `permission` body gains a fifth line, the
//! lowercase hex SHA-256 of the request's **preview** — the tool kind, title,
//! locations and input summary the host itself read from the agent's ACP
//! request, in the closed canonical form of [`crate::permission_preview`].
//! Under v2 the statement named only the request id, so a server that swapped
//! the preview shown beside it (「파일을 읽어도 될까요? README.md」 over a
//! sandbox-escaping command) still collected a valid allow (E10 review H1).
//! The host compares the line with the hash it computed when it relayed the
//! request, so no server can change what an allow means.
//!
//! [`ControlContent::Permission::preview_sha256`] decides which bodies exist:
//! `Some` builds only under v3 (v1/v2 refuse to build), `None` — a request
//! recorded before hosts sent previews — only under v1/v2. A verifier
//! ([`HumanControl::verify_any`]) therefore never lets a v1/v2 signature
//! stand for a request that has a preview. Every other kind is byte-identical
//! to v2 under v3.
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

/// Retired (#3154): no verifier accepts it. Kept for the E1 vectors, which
/// build v1 bytes to prove they are refused (see the module docs, v2).
pub const HUMAN_CONTROL_SCHEMA_V1: &str = "momo.human.control.v1";
/// R2-E7 #3027. Accepted for every kind but a previewed `permission`.
pub const HUMAN_CONTROL_SCHEMA_V2: &str = "momo.human.control.v2";
/// The current control schema (#3118): a `permission` binds its preview.
pub const HUMAN_CONTROL_SCHEMA_V3: &str = "momo.human.control.v3";
pub const DEVICE_ENDORSE_SCHEMA_V1: &str = "momo.human.device_endorse.v1";
pub const DEVICE_REVOKE_SCHEMA_V1: &str = "momo.human.device_revoke.v1";
/// v2 (#3068): the root signs the revoked device's public key too.
pub const DEVICE_REVOKE_SCHEMA_V2: &str = "momo.human.device_revoke.v2";
/// #3097 (ADR-0146 D-7 증보): a live key moves itself onto a new sign-in.
pub const DEVICE_REBIND_SCHEMA_V1: &str = "momo.human.device_rebind.v1";
/// #3079 (ADR-0146 D-7 증보): a refresh request's proof of the lineage's
/// refresh key — the sender-constraint on a refresh token.
pub const REFRESH_PROOF_SCHEMA_V1: &str = "momo.human.refresh_proof.v1";

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
    V3,
}

impl ControlSchema {
    pub fn as_str(self) -> &'static str {
        match self {
            ControlSchema::V1 => HUMAN_CONTROL_SCHEMA_V1,
            ControlSchema::V2 => HUMAN_CONTROL_SCHEMA_V2,
            ControlSchema::V3 => HUMAN_CONTROL_SCHEMA_V3,
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
        /// v3 (#3118): lowercase hex SHA-256 of the request's preview
        /// ([`crate::permission_preview::preview_sha256`]), as the **host**
        /// computed it. `None` only for a request recorded without one, which
        /// v1/v2 statements answer; `Some` builds only under v3.
        preview_sha256: Option<&'a str>,
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
            (ControlContent::Spawn { .. }, ControlSchema::V2 | ControlSchema::V3) => {
                SessionRule::Optional
            }
            _ => SessionRule::Forbidden,
        }
    }

    /// The canonical content bytes (see the module table), in the current
    /// schema (v3).
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, HumanSigningError> {
        self.canonical_bytes_as(ControlSchema::V3)
    }

    /// The canonical content bytes under `schema`. `spawn` differs between
    /// v1 and v2; `permission` between v2 and v3.
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
            } => {
                token("option_id", option_id)?;
                token("option_kind", option_kind)?;
                let base = format!(
                    "{request_event_id}\n{option_id}\n{option_kind}\n{}",
                    scope.as_str()
                );
                match (schema, preview_sha256) {
                    (ControlSchema::V3, Some(hash)) => {
                        lower_hex_sha256("preview_sha256", hash)?;
                        format!("{base}\n{hash}")
                    }
                    (ControlSchema::V3, None) => {
                        return Err(HumanSigningError::InvalidField {
                            field: "preview_sha256",
                            reason: "a v3 permission binds its preview",
                        })
                    }
                    (ControlSchema::V1 | ControlSchema::V2, None) => base,
                    // A v1/v2 allow never names a preview: it must not stand
                    // for a request that has one (#3118).
                    (ControlSchema::V1 | ControlSchema::V2, Some(_)) => {
                        return Err(HumanSigningError::InvalidField {
                            field: "preview_sha256",
                            reason: "only a v3 permission binds a preview",
                        })
                    }
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

    /// Lowercase hex SHA-256 of [`Self::canonical_bytes`].
    pub fn content_sha256(&self) -> Result<String, HumanSigningError> {
        self.content_sha256_as(ControlSchema::V3)
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

/// A `momo.human.control` statement (built as v3 unless a caller asks for an
/// older schema).
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
    /// The 13-line v3 bytes the device key signs. Structural rules only;
    /// time is [`check_control_window`]'s job.
    pub fn signed_bytes(&self) -> Result<Vec<u8>, HumanSigningError> {
        self.signed_bytes_as(ControlSchema::V3)
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

    /// Rebuild the v3 bytes and verify `signature` (raw `r‖s`) under the
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

    /// What a verifier accepts (module docs, v2 · v3): the v3 statement; the
    /// v2 one for every kind but a permission that has a preview (a v2
    /// permission body is built only when `preview_sha256` is `None`); and
    /// the v1 one for the kinds whose v1 bytes say what v2's do — never a
    /// `spawn`, whose v1 bytes bound neither tool nor channel. A statement
    /// that cannot be built under a schema is not tried under it. Returns the
    /// schema that verified, its bytes and the canonical low-s signature.
    pub fn verify_any(
        &self,
        device_public_key: &[u8],
        signature: &[u8],
    ) -> Result<VerifiedStatement, HumanSigningError> {
        let previewed = matches!(
            self.content,
            ControlContent::Permission {
                preview_sha256: Some(_),
                ..
            }
        );
        // #3154: v1 is not a schema a verifier accepts any more. The phone
        // and the desktop sign v2 (input, spawn) and v3 (permission); the
        // variant stays so the vectors can still build v1 bytes and prove
        // that they are refused.
        let mut schemas = Vec::with_capacity(2);
        // A permission without a preview has no v3 body.
        if !matches!(
            self.content,
            ControlContent::Permission {
                preview_sha256: None,
                ..
            }
        ) {
            schemas.push(ControlSchema::V3);
        }
        if !previewed {
            schemas.push(ControlSchema::V2);
        }
        let mut first_error = None;
        for schema in schemas {
            let bytes = self.signed_bytes_as(schema)?;
            match verify_p256(device_public_key, &bytes, signature) {
                Ok(canonical) => {
                    return Ok(VerifiedStatement {
                        schema,
                        signed_bytes: bytes,
                        signature: canonical,
                    })
                }
                Err(error) => {
                    first_error.get_or_insert(error);
                }
            }
        }
        Err(first_error.unwrap_or(HumanSigningError::BadSignature))
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

/// `momo.human.device_revoke.v1` / `.v2` — the root key revokes a device key
/// (v2 also names its public key, #3068).
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

    /// `momo.human.device_revoke.v2` (#3068): v1's lines with the revoked
    /// key's public key (base64 of the 33-byte compressed point, canonical)
    /// before the time. An endorsement binds a public key and v1 names only a
    /// key id, so under v1 a host that never saw the key could not tell which
    /// key the root meant; under v2 the root says it.
    ///
    /// ```text
    /// momo.human.device_revoke.v2
    /// {workspace_id}
    /// {member_id}
    /// {root_key_id}
    /// {target_key_id}
    /// {target_public_key_b64}
    /// {revoked_at_ms}
    /// ```
    pub fn signed_bytes_v2(
        &self,
        target_public_key_b64: &str,
    ) -> Result<Vec<u8>, HumanSigningError> {
        let key = canonical_b64_of_len(
            "target_public_key_b64",
            target_public_key_b64,
            P256_PUBLIC_KEY_LEN,
        )?;
        parse_p256_public_key(&key)?;
        Ok(format!(
            "{DEVICE_REVOKE_SCHEMA_V2}\n{}\n{}\n{}\n{}\n{target_public_key_b64}\n{}",
            self.workspace_id,
            self.member_id,
            self.root_key_id,
            self.target_key_id,
            self.revoked_at_ms,
        )
        .into_bytes())
    }

    /// Verify a v2 letter over `target_public_key_b64`.
    pub fn verify_v2(
        &self,
        target_public_key_b64: &str,
        root_public_key: &[u8],
        signature: &[u8],
    ) -> Result<[u8; P256_SIGNATURE_LEN], HumanSigningError> {
        verify_p256(
            root_public_key,
            &self.signed_bytes_v2(target_public_key_b64)?,
            signature,
        )
    }
}

/// `momo.human.device_rebind.v1` (#3097, ADR-0146 D-7 증보) — a device key
/// moves **itself** onto the caller's new sign-in, after the lineage it was
/// registered under ended without revoking it (a refresh-token reuse, or the
/// sign-in expiring). Signed by the key being moved, never by the root: the
/// proof is possession of that key, which a stolen refresh token does not give.
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
///
/// The destination lineage makes a letter single-use without a nonce: the
/// server moves the key only into the caller's own live lineage, and only out
/// of a lineage that can no longer rotate. A lineage never becomes live again,
/// so once the key sits in `session_id` the letter names the lineage it is
/// already in, and after that lineage ends it names a dead one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeviceRebind<'a> {
    pub workspace_id: Uuid,
    pub member_id: Uuid,
    pub key_id: Uuid,
    /// Base64 of the 33-byte compressed SEC1 key (canonical encoding).
    pub public_key_b64: &'a str,
    pub session_id: Uuid,
    pub signed_at_ms: i64,
}

impl DeviceRebind<'_> {
    pub fn signed_bytes(&self) -> Result<Vec<u8>, HumanSigningError> {
        let key = canonical_b64_of_len("public_key_b64", self.public_key_b64, P256_PUBLIC_KEY_LEN)?;
        parse_p256_public_key(&key)?;
        if self.signed_at_ms <= 0 || self.signed_at_ms > MAX_SAFE_INTEGER {
            return Err(HumanSigningError::InvalidField {
                field: "signed_at_ms",
                reason: "must be a positive safe integer",
            });
        }
        Ok(format!(
            "{DEVICE_REBIND_SCHEMA_V1}\n{}\n{}\n{}\n{}\n{}\n{}",
            self.workspace_id,
            self.member_id,
            self.key_id,
            self.public_key_b64,
            self.session_id,
            self.signed_at_ms,
        )
        .into_bytes())
    }

    /// Verify against the key's own public key (the one the letter names).
    pub fn verify(&self, signature: &[u8]) -> Result<[u8; P256_SIGNATURE_LEN], HumanSigningError> {
        let bytes = self.signed_bytes()?;
        let key = canonical_b64_of_len("public_key_b64", self.public_key_b64, P256_PUBLIC_KEY_LEN)?;
        verify_p256(&key, &bytes, signature)
    }
}

/// `momo.human.refresh_proof.v1` (#3079, ADR-0146 D-7 증보) — the proof a
/// native client attaches to `POST /v1/auth/refresh`, signed by the refresh
/// key its sign-in lineage is bound to (a Secure Enclave P-256 key with no
/// biometry or presence check, so a background refresh can sign):
///
/// ```text
/// momo.human.refresh_proof.v1
/// {workspace_id}
/// {member_id}
/// {public_key_b64}         the refresh key (canonical base64, 33-byte SEC1)
/// {refresh_token_sha256}   lowercase hex SHA-256 of the presented refresh token
/// {nonce}                  128 random bits, one-time on the server
/// {signed_at_ms}           server time ±5 min
/// ```
///
/// The token-hash line is the sender constraint (the role RFC 9449 §4.2's
/// `ath` plays for an access token): a proof is good for one refresh token
/// only, so a proof captured for a spent token proves nothing about its
/// successor. The nonce makes a proof single-use; the time bounds how long an
/// unconsumed one keeps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RefreshProof<'a> {
    pub workspace_id: Uuid,
    pub member_id: Uuid,
    /// Base64 of the 33-byte compressed SEC1 key (canonical encoding).
    pub public_key_b64: &'a str,
    /// [`refresh_token_sha256_hex`] of the presented refresh token.
    pub refresh_token_sha256: &'a str,
    pub nonce: Uuid,
    pub signed_at_ms: i64,
}

/// Lowercase hex SHA-256 of a raw refresh token — the
/// `{refresh_token_sha256}` line of [`RefreshProof`].
pub fn refresh_token_sha256_hex(raw_refresh_token: &str) -> String {
    hex::encode(Sha256::digest(raw_refresh_token.as_bytes()))
}

impl RefreshProof<'_> {
    pub fn signed_bytes(&self) -> Result<Vec<u8>, HumanSigningError> {
        let key = canonical_b64_of_len("public_key_b64", self.public_key_b64, P256_PUBLIC_KEY_LEN)?;
        parse_p256_public_key(&key)?;
        if self.refresh_token_sha256.len() != 64
            || !self
                .refresh_token_sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(HumanSigningError::InvalidField {
                field: "refresh_token_sha256",
                reason: "must be 64 lowercase hex characters",
            });
        }
        if self.signed_at_ms <= 0 || self.signed_at_ms > MAX_SAFE_INTEGER {
            return Err(HumanSigningError::InvalidField {
                field: "signed_at_ms",
                reason: "must be a positive safe integer",
            });
        }
        Ok(format!(
            "{REFRESH_PROOF_SCHEMA_V1}\n{}\n{}\n{}\n{}\n{}\n{}",
            self.workspace_id,
            self.member_id,
            self.public_key_b64,
            self.refresh_token_sha256,
            self.nonce,
            self.signed_at_ms,
        )
        .into_bytes())
    }

    /// Verify against the public key the proof names. The caller decides
    /// whether that key is the lineage's (the server compares it with the
    /// bound key before trusting this result).
    pub fn verify(&self, signature: &[u8]) -> Result<[u8; P256_SIGNATURE_LEN], HumanSigningError> {
        let bytes = self.signed_bytes()?;
        let key = canonical_b64_of_len("public_key_b64", self.public_key_b64, P256_PUBLIC_KEY_LEN)?;
        verify_p256(&key, &bytes, signature)
    }
}

/// `|now − signed_at_ms| ≤ 5 min` (ADR-0146 D-9's skew window), overflow-safe.
pub fn within_clock_skew(signed_at_ms: i64, now_ms: i64) -> bool {
    (i128::from(now_ms) - i128::from(signed_at_ms)).abs() <= i128::from(MAX_CLOCK_SKEW_MS)
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

/// 64 lowercase hex characters (a SHA-256 line).
fn lower_hex_sha256(field: &'static str, value: &str) -> Result<(), HumanSigningError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(HumanSigningError::InvalidField {
            field,
            reason: "must be 64 lowercase hex characters",
        });
    }
    Ok(())
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

    /// #3079: the refresh proof's exact bytes, and that it binds the key, the
    /// presented token, the nonce and the time — and verifies only under the
    /// key it names.
    #[test]
    fn refresh_proof_bytes_are_fixed_and_bind_the_presented_token() {
        use p256::ecdsa::signature::Signer as _;
        let signing = p256::ecdsa::SigningKey::from_slice(&[9u8; 32]).unwrap();
        let public = BASE64.encode(signing.verifying_key().to_sec1_point(true).as_bytes());
        let token_hash = refresh_token_sha256_hex("header.payload.signature");
        assert_eq!(
            token_hash,
            hex::encode(Sha256::digest(b"header.payload.signature")),
            "the token line is the lowercase hex SHA-256 of the raw token"
        );
        let proof = RefreshProof {
            workspace_id: Uuid::from_u128(1),
            member_id: Uuid::from_u128(2),
            public_key_b64: &public,
            refresh_token_sha256: &token_hash,
            nonce: Uuid::from_u128(3),
            signed_at_ms: 1_790_000_000_000,
        };
        assert_eq!(
            String::from_utf8(proof.signed_bytes().unwrap()).unwrap(),
            format!(
                "momo.human.refresh_proof.v1\n\
                 00000000-0000-0000-0000-000000000001\n\
                 00000000-0000-0000-0000-000000000002\n\
                 {public}\n\
                 {token_hash}\n\
                 00000000-0000-0000-0000-000000000003\n\
                 1790000000000"
            )
        );
        let signature: p256::ecdsa::Signature = signing.sign(&proof.signed_bytes().unwrap());
        assert!(proof.verify(&signature.to_bytes()).is_ok());
        let successor_hash = refresh_token_sha256_hex("header.payload.other");
        let for_another_token = RefreshProof {
            refresh_token_sha256: &successor_hash,
            ..proof
        };
        assert_eq!(
            for_another_token.verify(&signature.to_bytes()),
            Err(HumanSigningError::BadSignature),
            "a proof for one refresh token proves nothing about another"
        );
        assert_eq!(
            RefreshProof {
                nonce: Uuid::from_u128(4),
                ..proof
            }
            .verify(&signature.to_bytes()),
            Err(HumanSigningError::BadSignature),
            "the nonce is signed"
        );
        let other_key = p256::ecdsa::SigningKey::from_slice(&[8u8; 32]).unwrap();
        let forged: p256::ecdsa::Signature = other_key.sign(&proof.signed_bytes().unwrap());
        assert_eq!(
            proof.verify(&forged.to_bytes()),
            Err(HumanSigningError::BadSignature),
            "only the named key proves"
        );
        let upper = token_hash.to_uppercase();
        assert!(RefreshProof {
            refresh_token_sha256: &upper,
            ..proof
        }
        .signed_bytes()
        .is_err());
        assert!(RefreshProof {
            signed_at_ms: 0,
            ..proof
        }
        .signed_bytes()
        .is_err());
        assert!(within_clock_skew(1_000_000, 1_000_000 + MAX_CLOCK_SKEW_MS));
        assert!(!within_clock_skew(
            1_000_000,
            1_000_000 + MAX_CLOCK_SKEW_MS + 1
        ));
        assert!(!within_clock_skew(i64::MIN, i64::MAX));
    }

    /// #3097: the rebind letter's exact bytes, and that it binds the key, the
    /// destination lineage and the time — and verifies only under the key it
    /// names.
    #[test]
    fn device_rebind_bytes_are_fixed_and_bind_the_destination_lineage() {
        use p256::ecdsa::signature::Signer as _;
        let signing = p256::ecdsa::SigningKey::from_slice(&[7u8; 32]).unwrap();
        let public = BASE64.encode(signing.verifying_key().to_sec1_point(true).as_bytes());
        let letter = DeviceRebind {
            workspace_id: Uuid::from_u128(1),
            member_id: Uuid::from_u128(2),
            key_id: Uuid::from_u128(3),
            public_key_b64: &public,
            session_id: Uuid::from_u128(4),
            signed_at_ms: 1_790_000_000_000,
        };
        assert_eq!(
            String::from_utf8(letter.signed_bytes().unwrap()).unwrap(),
            format!(
                "momo.human.device_rebind.v1\n\
                 00000000-0000-0000-0000-000000000001\n\
                 00000000-0000-0000-0000-000000000002\n\
                 00000000-0000-0000-0000-000000000003\n\
                 {public}\n\
                 00000000-0000-0000-0000-000000000004\n\
                 1790000000000"
            )
        );
        let signature: p256::ecdsa::Signature = signing.sign(&letter.signed_bytes().unwrap());
        assert!(letter.verify(&signature.to_bytes()).is_ok());
        let elsewhere = DeviceRebind {
            session_id: Uuid::from_u128(5),
            ..letter
        };
        assert_eq!(
            elsewhere.verify(&signature.to_bytes()),
            Err(HumanSigningError::BadSignature),
            "a letter for one lineage moves the key into no other"
        );
        let other_key = p256::ecdsa::SigningKey::from_slice(&[8u8; 32]).unwrap();
        let forged: p256::ecdsa::Signature = other_key.sign(&letter.signed_bytes().unwrap());
        assert_eq!(
            letter.verify(&forged.to_bytes()),
            Err(HumanSigningError::BadSignature),
            "only the key being moved can sign its move"
        );
        assert!(DeviceRebind {
            signed_at_ms: 0,
            ..letter
        }
        .signed_bytes()
        .is_err());
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

    /// #3118: a v3 permission's exact bytes; the preview line is load-bearing;
    /// a v2 signature never stands for a previewed request, and a request
    /// with no preview has no v3 body.
    #[test]
    fn a_v3_allow_binds_the_preview_and_a_v2_one_cannot_stand_for_it() {
        use p256::ecdsa::signature::Signer as _;
        let signing = p256::ecdsa::SigningKey::from_slice(&[5u8; 32]).unwrap();
        let public = signing
            .verifying_key()
            .to_sec1_point(true)
            .as_bytes()
            .to_vec();
        let seen = "a".repeat(64);
        let swapped = "b".repeat(64);
        let statement = |preview_sha256| HumanControl {
            instance_id: "inst",
            workspace_id: Uuid::from_u128(1),
            member_id: Uuid::from_u128(2),
            device_key_id: Uuid::from_u128(3),
            host_id: Uuid::from_u128(4),
            session_id: Some(Uuid::from_u128(5)),
            nonce: Uuid::from_u128(6),
            issued_at_ms: 1_790_000_000_000,
            expires_at_ms: 1_790_000_060_000,
            content: ControlContent::Permission {
                request_event_id: Uuid::from_u128(7),
                option_id: "allow-once",
                option_kind: "allow_once",
                scope: PermissionScope::Once,
                preview_sha256,
            },
        };
        let v3 = statement(Some(seen.as_str()));
        assert_eq!(
            String::from_utf8(v3.content.canonical_bytes().unwrap()).unwrap(),
            format!("00000000-0000-0000-0000-000000000007\nallow-once\nallow_once\nonce\n{seen}")
        );
        assert!(String::from_utf8(v3.signed_bytes().unwrap())
            .unwrap()
            .starts_with("momo.human.control.v3\n"));
        let signature: p256::ecdsa::Signature = signing.sign(&v3.signed_bytes().unwrap());
        let verified = v3.verify_any(&public, &signature.to_bytes()).unwrap();
        assert_eq!(verified.schema, ControlSchema::V3);
        // The host rebuilds with the hash it computed; the server's swap shows.
        assert_eq!(
            statement(Some(swapped.as_str())).verify_any(&public, &signature.to_bytes()),
            Err(HumanSigningError::BadSignature)
        );
        // A v2 allow (no preview line) is not accepted for a previewed request.
        let legacy = statement(None);
        let v2_sig: p256::ecdsa::Signature =
            signing.sign(&legacy.signed_bytes_as(ControlSchema::V2).unwrap());
        assert!(legacy.verify_any(&public, &v2_sig.to_bytes()).is_ok());
        assert_eq!(
            v3.verify_any(&public, &v2_sig.to_bytes()),
            Err(HumanSigningError::BadSignature)
        );
        assert!(v3.signed_bytes_as(ControlSchema::V2).is_err());
        assert!(legacy.signed_bytes_as(ControlSchema::V3).is_err());
        let upper = seen.to_uppercase();
        assert!(statement(Some(upper.as_str())).signed_bytes().is_err());
    }

    #[test]
    fn newline_in_a_token_is_refused_so_no_boundary_can_move() {
        let content = ControlContent::Permission {
            request_event_id: Uuid::from_u128(1),
            option_id: "allow-once\nallow_once",
            option_kind: "x",
            scope: PermissionScope::Once,
            preview_sha256: None,
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
