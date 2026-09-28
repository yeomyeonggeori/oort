//! A person's signed control — the server's check (ADR-0146 개정 2026-09-28,
//! D-5 · D-8 · D-9 · D-10; R2-E3 #3023).
//!
//! [`verify_human_control_in_tx`] is the write chokepoint the routes call
//! before a person's `spawn`, `input` or `permission` allow becomes a
//! `work_control` row. **The server's check is convenience and audit; the
//! security boundary is the host** (`momo-workd` `human_trust`, E4 #3024),
//! which rebuilds and re-verifies the same statement against the root key it
//! pinned itself. What the server adds is an early, named refusal and the
//! `action_signature` row.
//!
//! ## What is checked, in order
//!
//! 1. **The key.** A `member_device_key` row of *this* workspace and *this*
//!    member (the requester, who the route has already made the host's owner),
//!    `alg = p256`, not revoked, and its session lineage still able to rotate.
//!    For a phone, its endorsing root's lineage too. Both lineages (token rows)
//!    and then both key rows, in id order, are share-locked for the rest of the
//!    transaction — the order every session end takes (token rows first) — so
//!    a logout of the phone *or of the Mac* cannot commit between this check
//!    and the control it authorizes (#3023 review M1).
//! 2. **The chain** (D-6). The key is a root candidate (a live `macos` key
//!    nobody endorsed), or an `ios` key whose `device_endorse.v1` letter from a
//!    live root candidate of the same member **re-verifies now** against the
//!    stored rows. An unendorsed phone key is 「지시 불가」.
//! 3. **The statement.** The 13 lines are rebuilt from what the server is about
//!    to write — the route's workspace, member, host, session and content, and
//!    this instance's id (`MOMO_INSTANCE_ID`, never the request's) — plus the
//!    envelope's key id, nonce, times, and the per-kind fields the content
//!    needs (input `mode`, permission `scope`, spawn agent/folder). A statement
//!    for another host, session, mode, text or option does not verify.
//!    Text must already be NFC: the host refuses any other spelling (#3024
//!    L4), so the server does too.
//! 4. **The time window** (D-9): ±5 min around the server clock, lifetime
//!    ≤ 10 min. Routes pass the database clock read inside the transaction
//!    ([`db_now_ms`]), the same clock the nonce prune uses.
//! 5. **The nonce, last** (D-9): `INSERT … ON CONFLICT DO NOTHING RETURNING`
//!    into `human_control_nonce` (095). Last among this module's checks,
//!    because a refused request in this codebase commits its transaction. A
//!    route may still lose a race after it (the request closed, the host id
//!    taken); that refusal commits with the nonce spent — the statement could
//!    never have succeeded, so closing it is the right outcome (#3023 L1).
//!
//! The switch-off side is never signed (D-8): `kill`, a `reject_*` decision
//! and host revoke do not reach this module.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use momo_wire::human_control::{
    check_control_window, ControlContent, DeviceEndorse, DeviceKeyAlg, HumanControl, InputMode,
    PermissionScope, MAX_CLOCK_SKEW_MS,
};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::device_key::{
    load_device_key_in_tx, lock_root_lineage, DeviceKeyRecord, DeviceKeyState, DEVICE_KEY_ALG_P256,
    DEVICE_KEY_PLATFORM_IOS, REFUSAL_DEVICE_KEY_REVOKED, REFUSAL_DEVICE_SIGNATURE_INVALID,
    REFUSAL_DEVICE_SIGNATURE_REQUIRED,
};

/// The key is live but not an instructing key: an `ios` key with no live,
/// verifying endorsement (「지시 불가」). Same label as the host's refusal.
pub const REFUSAL_DEVICE_KEY_NOT_ENDORSED: &str = "device_key_not_endorsed";
/// The statement is outside the time window. Same label as the host's.
pub const REFUSAL_DEVICE_SIGNATURE_EXPIRED: &str = "device_signature_expired";
/// The statement's nonce was already spent. Same label as the host's.
pub const REFUSAL_DEVICE_NONCE_REPLAYED: &str = "device_nonce_replayed";

/// Why a signed control was refused. Every arm is a named error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HumanControlRefusal {
    /// No signature where one is required (`device_signature_required`).
    Required,
    /// The signature, the statement or the envelope does not hold
    /// (`device_signature_invalid`): a key of another member or workspace, a
    /// statement for another target, a missing per-kind field, a bad encoding.
    Invalid,
    /// The key, or its session lineage, is revoked (`device_key_revoked`).
    KeyRevoked,
    /// A live key that cannot instruct (`device_key_not_endorsed`).
    NotEndorsed,
    /// Outside ±5 min, or a lifetime over 10 min (`device_signature_expired`).
    Expired,
    /// The nonce was already consumed (`device_nonce_replayed`).
    NonceReplayed,
}

impl HumanControlRefusal {
    pub fn code(self) -> &'static str {
        match self {
            HumanControlRefusal::Required => REFUSAL_DEVICE_SIGNATURE_REQUIRED,
            HumanControlRefusal::Invalid => REFUSAL_DEVICE_SIGNATURE_INVALID,
            HumanControlRefusal::KeyRevoked => REFUSAL_DEVICE_KEY_REVOKED,
            HumanControlRefusal::NotEndorsed => REFUSAL_DEVICE_KEY_NOT_ENDORSED,
            HumanControlRefusal::Expired => REFUSAL_DEVICE_SIGNATURE_EXPIRED,
            HumanControlRefusal::NonceReplayed => REFUSAL_DEVICE_NONCE_REPLAYED,
        }
    }
}

/// What the client sent beside its instruction: the envelope fields the
/// server cannot derive. Everything else in the statement comes from the
/// server's own rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HumanSignatureInput {
    pub device_key_id: Uuid,
    pub nonce: Uuid,
    pub issued_at_ms: i64,
    pub expires_at_ms: i64,
    /// base64 raw `r‖s` (either s form; the canonical low-s one is kept).
    pub signature_b64: String,
    /// `input` only: `queue` | `interrupt`.
    pub mode: Option<String>,
    /// `permission` only: `once` | `session`.
    pub scope: Option<String>,
    /// `spawn` only.
    pub agent_member_id: Option<Uuid>,
    /// `spawn` only: the opaque folder id (ADR-0188 D6).
    pub folder_id: Option<String>,
}

/// What the control will do, as the **server** will write it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlSubject<'a> {
    /// `payload.text`.
    Input { text: &'a str },
    /// `payload.label` — the first prompt the host starts the agent with.
    Spawn { first_prompt: &'a str },
    /// The stored request's event id and the stored option (id and kind).
    Permission {
        request_event_id: Uuid,
        option_id: &'a str,
        option_kind: &'a str,
    },
}

impl ControlSubject<'_> {
    pub fn kind(&self) -> &'static str {
        match self {
            ControlSubject::Input { .. } => "input",
            ControlSubject::Spawn { .. } => "spawn",
            ControlSubject::Permission { .. } => "permission",
        }
    }
}

/// The control the statement must name — every field from the server's rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ControlTarget<'a> {
    pub workspace_id: Uuid,
    /// The requester: the bearer, whom the route has made the host's owner.
    pub member_id: Uuid,
    /// The host the control will be addressed to (the session's host, or the
    /// host a spawn was asked for).
    pub host_id: Uuid,
    /// `None` for a spawn (v1 has no session line for it).
    pub session_id: Option<Uuid>,
    pub subject: ControlSubject<'a>,
}

/// A statement that verified and whose nonce is now spent. Carries what the
/// `work_control` signature columns and `action_signature` store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedHumanControl {
    pub key: DeviceKeyRecord,
    pub instance_id: String,
    pub nonce: Uuid,
    pub issued_at_ms: i64,
    pub expires_at_ms: i64,
    pub mode: Option<&'static str>,
    pub scope: Option<&'static str>,
    pub agent_member_id: Option<Uuid>,
    pub folder_id: Option<String>,
    /// Canonical low-s raw `r‖s`, base64.
    pub signature_b64: String,
    /// The 13 lines that verified (for `action_signature`).
    pub signed_bytes: Vec<u8>,
}

/// Whether `text` is already in NFC (the form the signature covers).
fn is_nfc(text: &str) -> bool {
    ControlContent::Input {
        mode: InputMode::Queue,
        text,
    }
    .canonical_bytes()
    .is_ok_and(|bytes| bytes == text.as_bytes())
}

/// Spend a statement's nonce: `true` the first time, `false` on a replay.
/// Rows past their retention are pruned first (048's shape). Kept until the
/// statement's expiry plus the skew window — until then the time window could
/// still accept it.
pub async fn consume_human_nonce_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    nonce: Uuid,
    device_key_id: Uuid,
    kind: &str,
    expires_at_ms: i64,
) -> Result<bool, sqlx::Error> {
    sqlx::query("DELETE FROM human_control_nonce WHERE workspace_id = $1 AND expires_at < now()")
        .bind(workspace_id)
        .execute(&mut *conn)
        .await?;
    let keep_until_ms = expires_at_ms.saturating_add(MAX_CLOCK_SKEW_MS);
    let consumed: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO human_control_nonce (workspace_id, nonce, device_key_id, kind, expires_at) \
         VALUES ($1, $2, $3, $4, to_timestamp($5::double precision / 1000.0)) \
         ON CONFLICT (workspace_id, nonce) DO NOTHING \
         RETURNING nonce",
    )
    .bind(workspace_id)
    .bind(nonce)
    .bind(device_key_id)
    .bind(kind)
    .bind(keep_until_ms as f64)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(consumed.is_some())
}

/// The database clock, in ms — the one clock the time window and the nonce
/// prune share (#3023 review L3: a `now` taken before a lock wait could pass a
/// statement that expired while the request waited).
pub async fn db_now_ms(conn: &mut PgConnection) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint")
        .fetch_one(&mut *conn)
        .await
}

/// The key may instruct: a root candidate, or a phone whose endorsement
/// re-verifies against its (live, root-candidate, same-member) endorser whose
/// own lineage is live (`endorser_lineage_live`, locked by the caller).
async fn key_can_instruct(
    conn: &mut PgConnection,
    key: &DeviceKeyRecord,
    endorser_lineage_live: bool,
) -> Result<bool, sqlx::Error> {
    match key.state() {
        DeviceKeyState::Root => Ok(true),
        DeviceKeyState::Endorsed if !endorser_lineage_live => Ok(false),
        DeviceKeyState::Endorsed => {
            let (Some(root_id), Some(letter)) = (key.endorsed_by_key_id, &key.endorsement_sig)
            else {
                return Ok(false);
            };
            if key.platform != DEVICE_KEY_PLATFORM_IOS {
                return Ok(false);
            }
            let Some(root) = load_device_key_in_tx(conn, root_id).await? else {
                return Ok(false);
            };
            if root.member_id != key.member_id
                || root.workspace_id != key.workspace_id
                || !root.is_root_candidate()
            {
                return Ok(false);
            }
            let (Ok(root_key), Ok(signature)) =
                (BASE64.decode(&root.public_key), BASE64.decode(letter))
            else {
                return Ok(false);
            };
            Ok(DeviceEndorse {
                workspace_id: key.workspace_id,
                member_id: key.member_id,
                root_key_id: root.id,
                target_alg: DeviceKeyAlg::P256,
                target_public_key_b64: &key.public_key,
                label: &key.label,
            }
            .verify(&root_key, &signature)
            .is_ok())
        }
        DeviceKeyState::Unendorsed | DeviceKeyState::Revoked => Ok(false),
    }
}

/// ADR-0146 개정 D-10: verify a person's signed control and spend its nonce.
/// `Ok(Ok(_))` means the route may write exactly `target`, with the returned
/// columns, in this transaction. See the module docs for the order.
pub async fn verify_human_control_in_tx(
    conn: &mut PgConnection,
    instance_id: &str,
    target: &ControlTarget<'_>,
    input: &HumanSignatureInput,
    now_ms: i64,
) -> Result<Result<VerifiedHumanControl, HumanControlRefusal>, sqlx::Error> {
    // 1. The key. The endorser id is read unlocked (it never changes on a
    // live endorsement); then both lineages (token rows), then both key rows
    // in id order, all shared (review M1).
    let endorser: Option<Uuid> = sqlx::query_scalar::<_, Option<Uuid>>(
        "SELECT endorsed_by_key_id FROM member_device_key \
          WHERE id = $1 AND workspace_id = $2 AND member_id = $3",
    )
    .bind(input.device_key_id)
    .bind(target.workspace_id)
    .bind(target.member_id)
    .fetch_optional(&mut *conn)
    .await?
    .flatten();
    let lineage_live = lock_root_lineage(
        conn,
        target.workspace_id,
        target.member_id,
        input.device_key_id,
    )
    .await?;
    let endorser_lineage_live = match endorser {
        Some(root_id) => {
            lock_root_lineage(conn, target.workspace_id, target.member_id, root_id).await?
        }
        None => true,
    };
    let mut ids = vec![input.device_key_id];
    ids.extend(endorser);
    ids.sort();
    sqlx::query(
        "SELECT id FROM member_device_key WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE",
    )
    .bind(&ids)
    .fetch_all(&mut *conn)
    .await?;
    let Some(key) = load_device_key_in_tx(conn, input.device_key_id).await? else {
        return Ok(Err(HumanControlRefusal::Invalid));
    };
    if key.workspace_id != target.workspace_id
        || key.member_id != target.member_id
        || key.alg != DEVICE_KEY_ALG_P256
    {
        return Ok(Err(HumanControlRefusal::Invalid));
    }
    if !key.is_live() || !lineage_live {
        return Ok(Err(HumanControlRefusal::KeyRevoked));
    }
    // 2. The chain.
    if !key_can_instruct(conn, &key, endorser_lineage_live).await? {
        return Ok(Err(HumanControlRefusal::NotEndorsed));
    }

    // 3. The statement, from the server's rows plus the envelope.
    let (content, mode, scope, spawn) = match target.subject {
        ControlSubject::Input { text } => {
            if input.scope.is_some() || input.agent_member_id.is_some() || input.folder_id.is_some()
            {
                return Ok(Err(HumanControlRefusal::Invalid));
            }
            let mode = match input.mode.as_deref() {
                Some("queue") => InputMode::Queue,
                Some("interrupt") => InputMode::Interrupt,
                _ => return Ok(Err(HumanControlRefusal::Invalid)),
            };
            if !is_nfc(text) {
                return Ok(Err(HumanControlRefusal::Invalid));
            }
            (
                ControlContent::Input { mode, text },
                Some(mode.as_str()),
                None,
                None,
            )
        }
        ControlSubject::Spawn { first_prompt } => {
            if input.mode.is_some() || input.scope.is_some() {
                return Ok(Err(HumanControlRefusal::Invalid));
            }
            let (Some(agent_member_id), Some(folder_id)) =
                (input.agent_member_id, input.folder_id.as_deref())
            else {
                return Ok(Err(HumanControlRefusal::Invalid));
            };
            if !is_nfc(first_prompt) || folder_id.is_empty() || folder_id.len() > 256 {
                return Ok(Err(HumanControlRefusal::Invalid));
            }
            (
                ControlContent::Spawn {
                    agent_member_id,
                    folder_id,
                    first_prompt,
                },
                None,
                None,
                Some((agent_member_id, folder_id.to_string())),
            )
        }
        ControlSubject::Permission {
            request_event_id,
            option_id,
            option_kind,
        } => {
            if input.mode.is_some() || input.agent_member_id.is_some() || input.folder_id.is_some()
            {
                return Ok(Err(HumanControlRefusal::Invalid));
            }
            let scope = match input.scope.as_deref() {
                Some("once") => PermissionScope::Once,
                Some("session") => PermissionScope::Session,
                _ => return Ok(Err(HumanControlRefusal::Invalid)),
            };
            (
                ControlContent::Permission {
                    request_event_id,
                    option_id,
                    option_kind,
                    scope,
                },
                None,
                Some(scope.as_str()),
                None,
            )
        }
    };
    let statement = HumanControl {
        instance_id,
        workspace_id: target.workspace_id,
        member_id: target.member_id,
        device_key_id: key.id,
        host_id: target.host_id,
        session_id: target.session_id,
        nonce: input.nonce,
        issued_at_ms: input.issued_at_ms,
        expires_at_ms: input.expires_at_ms,
        content,
    };
    let Ok(signed_bytes) = statement.signed_bytes() else {
        return Ok(Err(HumanControlRefusal::Invalid));
    };
    let (Ok(public_key), Ok(signature)) = (
        BASE64.decode(&key.public_key),
        BASE64.decode(&input.signature_b64),
    ) else {
        return Ok(Err(HumanControlRefusal::Invalid));
    };
    let Ok(canonical) = statement.verify(&public_key, &signature) else {
        return Ok(Err(HumanControlRefusal::Invalid));
    };

    // 4. The time window.
    if check_control_window(input.issued_at_ms, input.expires_at_ms, now_ms).is_err() {
        return Ok(Err(HumanControlRefusal::Expired));
    }

    // 5. The nonce — last.
    if !consume_human_nonce_in_tx(
        conn,
        target.workspace_id,
        input.nonce,
        key.id,
        target.subject.kind(),
        input.expires_at_ms,
    )
    .await?
    {
        return Ok(Err(HumanControlRefusal::NonceReplayed));
    }

    let (agent_member_id, folder_id) = match spawn {
        Some((agent, folder)) => (Some(agent), Some(folder)),
        None => (None, None),
    };
    Ok(Ok(VerifiedHumanControl {
        key,
        instance_id: instance_id.to_string(),
        nonce: input.nonce,
        issued_at_ms: input.issued_at_ms,
        expires_at_ms: input.expires_at_ms,
        mode,
        scope,
        agent_member_id,
        folder_id,
        signature_b64: BASE64.encode(canonical),
        signed_bytes,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_refusal_has_its_named_code() {
        let codes = [
            (HumanControlRefusal::Required, "device_signature_required"),
            (HumanControlRefusal::Invalid, "device_signature_invalid"),
            (HumanControlRefusal::KeyRevoked, "device_key_revoked"),
            (HumanControlRefusal::NotEndorsed, "device_key_not_endorsed"),
            (HumanControlRefusal::Expired, "device_signature_expired"),
            (HumanControlRefusal::NonceReplayed, "device_nonce_replayed"),
        ];
        for (refusal, code) in codes {
            assert_eq!(refusal.code(), code);
        }
    }

    #[test]
    fn only_nfc_text_passes() {
        assert!(is_nfc("지시문 그대로"));
        // "é" as e + combining acute: the same text, another spelling.
        assert!(!is_nfc("caf\u{0065}\u{0301}"));
        assert!(is_nfc("caf\u{00e9}"));
    }
}
