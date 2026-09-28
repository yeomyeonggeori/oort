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
//! may sign all three schemas: `momo.human.control.v1`,
//! `momo.human.device_endorse.v1` and `momo.human.device_revoke.v1`. Nothing
//! else — there is no "sign these bytes" entry point anywhere in this crate.
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
pub const DEVICE_ENDORSE_SCHEMA_V1: &str = "momo.human.device_endorse.v1";
pub const DEVICE_REVOKE_SCHEMA_V1: &str = "momo.human.device_revoke.v1";

/// The schemas this key signs, with each payload's exact line count. The Mac
/// is the root, so all three (the phone signs only the first, #3026).
pub const SIGNING_SCHEMAS: [(&str, usize); 3] = [
    (HUMAN_CONTROL_SCHEMA_V1, 13),
    (DEVICE_ENDORSE_SCHEMA_V1, 7),
    (DEVICE_REVOKE_SCHEMA_V1, 6),
];

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
        first_prompt: String,
    },
    Permission {
        request_event_id: Uuid,
        option_id: String,
        option_kind: String,
        scope: PermissionScope,
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
            ControlContent::Spawn { .. } => "spawn",
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

    pub fn canonical_bytes(&self) -> Result<Vec<u8>, PayloadError> {
        let text = match self {
            ControlContent::Input { text, .. } => nfc(text),
            ControlContent::Spawn {
                agent_member_id,
                folder_id,
                first_prompt,
            } => {
                token("folder_id", folder_id)?;
                format!("{agent_member_id}\n{folder_id}\n{}", nfc(first_prompt))
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
                no_control("label", label)?;
                format!("{host_public_key_b64}\n{host_id}\n{}", nfc(label))
            }
        };
        Ok(text.into_bytes())
    }

    pub fn content_sha256(&self) -> Result<String, PayloadError> {
        Ok(hex::encode(Sha256::digest(self.canonical_bytes()?)))
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

/// `device_key_sign_revoke`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevokeRequest {
    pub workspace_id: Uuid,
    pub target_key_id: Uuid,
    /// Required by workd on the local path (E4): a revoked key must not come
    /// back under a new id. Not signed.
    pub target_public_key: String,
    /// For the confirmation only.
    #[serde(default)]
    pub target_label: String,
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
        revoked_at_ms: i64,
    },
}

impl Statement {
    #[cfg(test)]
    pub fn schema(&self) -> &'static str {
        match self {
            Statement::Control { .. } => HUMAN_CONTROL_SCHEMA_V1,
            Statement::Endorse { .. } => DEVICE_ENDORSE_SCHEMA_V1,
            Statement::Revoke { .. } => DEVICE_REVOKE_SCHEMA_V1,
        }
    }

    /// The exact bytes the enclave signs. `now_ms` is checked against the
    /// control's window so a webview cannot obtain a long-lived statement.
    pub fn signed_bytes(&self, now_ms: i64) -> Result<Vec<u8>, PayloadError> {
        let bytes = match self {
            Statement::Control { signer, request } => {
                check_control_window(request.issued_at_ms, request.expires_at_ms, now_ms)?;
                control_bytes(signer, request)?
            }
            Statement::Endorse { signer, request } => endorse_bytes(signer, request)?,
            Statement::Revoke {
                signer,
                request,
                revoked_at_ms,
            } => {
                if *revoked_at_ms <= 0 || *revoked_at_ms > MAX_SAFE_INTEGER {
                    return Err(PayloadError::Field("revoked_at_ms", "out of range"));
                }
                p256_public_key(&request.target_public_key)?;
                revoke_bytes(signer, request.target_key_id, *revoked_at_ms)
            }
        };
        check_signing_payload(&bytes)?;
        Ok(bytes)
    }
}

pub fn control_bytes(signer: &Signer, request: &ControlRequest) -> Result<Vec<u8>, PayloadError> {
    token("instance_id", &request.instance_id)?;
    if request.workspace_id != signer.workspace_id {
        return Err(PayloadError::Field("workspace_id", "not the signer's"));
    }
    let content = &request.content;
    let session = match (content.requires_session(), request.session_id) {
        (true, Some(id)) => id.to_string(),
        (true, None) => return Err(PayloadError::SessionRequired),
        (false, None) => ABSENT.to_string(),
        (false, Some(_)) => return Err(PayloadError::SessionForbidden),
    };
    if let ControlContent::HostRegister { host_id, .. } = content {
        if *host_id != request.host_id {
            return Err(PayloadError::HostIdMismatch);
        }
    }
    let content_sha256 = content.content_sha256()?;
    Ok(format!(
        "{HUMAN_CONTROL_SCHEMA_V1}\n{}\n{}\n{}\n{}\n{}\n{session}\n{}\n{}\n{}\n{}\n{}\n{content_sha256}",
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
    no_control("label", &request.label)?;
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

pub fn revoke_bytes(signer: &Signer, target_key_id: Uuid, revoked_at_ms: i64) -> Vec<u8> {
    format!(
        "{DEVICE_REVOKE_SCHEMA_V1}\n{}\n{}\n{}\n{}\n{}",
        signer.workspace_id, signer.member_id, signer.key_id, target_key_id, revoked_at_ms,
    )
    .into_bytes()
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
}

const SUMMARY_LINE_CHARS: usize = 80;

/// The first non-blank line, trimmed to [`SUMMARY_LINE_CHARS`], with a note
/// when more follows. Control characters (bidi overrides included) never reach
/// the dialog.
pub fn first_line(text: &str) -> String {
    let normalized = nfc(text);
    let mut lines = normalized.lines().map(str::trim).filter(|l| !l.is_empty());
    let Some(first) = lines.next() else {
        return "(빈 내용)".to_string();
    };
    let clean: String = first
        .chars()
        .filter(|c| !c.is_control() && !is_bidi_control(*c))
        .collect();
    let mut out: String = clean.chars().take(SUMMARY_LINE_CHARS).collect();
    let truncated = clean.chars().count() > SUMMARY_LINE_CHARS;
    if truncated {
        out.push('…');
    }
    if lines.next().is_some() {
        out.push_str(" (여러 줄)");
    }
    out
}

fn is_bidi_control(c: char) -> bool {
    matches!(c, '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

fn short_id(id: Uuid) -> String {
    id.to_string().chars().take(8).collect()
}

impl Statement {
    /// `local_host`: the host id this Mac is registered as, so "이 맥" can be
    /// named instead of an id.
    pub fn summary(&self, local_host: Option<Uuid>) -> Summary {
        match self {
            Statement::Control { request, .. } => {
                let host = if Some(request.host_id) == local_host {
                    format!("이 맥 ({})", short_id(request.host_id))
                } else {
                    format!("다른 호스트 ({})", short_id(request.host_id))
                };
                let session = request
                    .session_id
                    .map(|id| format!("세션 {}", short_id(id)))
                    .unwrap_or_else(|| "새 세션".to_string());
                let (kind, detail) = match &request.content {
                    ControlContent::Input { mode, text } => (
                        match mode {
                            InputMode::Queue => "지시 (다음 차례)",
                            InputMode::Interrupt => "지시 (지금 끼어들기)",
                        },
                        first_line(text),
                    ),
                    ControlContent::Spawn { first_prompt, .. } => {
                        ("새 작업", first_line(first_prompt))
                    }
                    ControlContent::Permission {
                        option_kind, scope, ..
                    } => (
                        "권한 허용",
                        format!(
                            "{} · {}",
                            first_line(option_kind),
                            match scope {
                                PermissionScope::Once => "이번 한 번",
                                PermissionScope::Session => "이 세션 동안",
                            }
                        ),
                    ),
                    ControlContent::BundleManifest { manifest } => (
                        "설정 묶음 목록",
                        match manifest.get("items").and_then(|v| v.as_array()) {
                            Some(items) => format!("항목 {}개", items.len()),
                            None => "목록".to_string(),
                        },
                    ),
                    ControlContent::HostRegister { label, .. } => {
                        ("호스트 등록", first_line(label))
                    }
                };
                Summary {
                    title: format!("oort: {kind}에 서명합니다"),
                    body: format!("대상: {host}, {session}\n내용: {detail}"),
                    confirm: "서명".into(),
                }
            }
            Statement::Endorse { request, .. } => Summary {
                title: "oort: 이 폰을 지시 기기로 승인합니다".into(),
                body: format!(
                    "기기: {}\n지문: {}\n설정 화면에 보인 지문과 같고, 방금 연결한 폰이 맞을 때만 승인하세요.",
                    first_line(&request.label),
                    fingerprint(&request.target_public_key).unwrap_or_default(),
                ),
                confirm: "승인".into(),
            },
            Statement::Revoke { request, .. } => Summary {
                title: "oort: 이 기기의 지시 권한을 끊습니다".into(),
                body: format!(
                    "기기: {}\n지문: {}\n끊은 기기는 이 맥에서 다시 승인해야 지시할 수 있습니다.",
                    if request.target_label.trim().is_empty() {
                        short_id(request.target_key_id)
                    } else {
                        first_line(&request.target_label)
                    },
                    fingerprint(&request.target_public_key).unwrap_or_default(),
                ),
                confirm: "끊기".into(),
            },
        }
    }
}

// ---- field rules (E1) --------------------------------------------------------

fn nfc(s: &str) -> String {
    s.nfc().collect()
}

fn token(field: &'static str, value: &str) -> Result<(), PayloadError> {
    if value.is_empty() {
        return Err(PayloadError::Field(field, "empty"));
    }
    no_control(field, value)
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
