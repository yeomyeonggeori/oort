//! A person's signed control, on the server — ADR-0146 개정 2026-09-28 D-8 ·
//! D-9 · D-10 (R2-E3, #3023).
//!
//! The routes that turn a person's instruction into a `work_control` row call
//! three things from here, in one tenant transaction:
//!
//! 1. [`authorize_human_control_in_tx`] — the chokepoint. It says whether a
//!    signature is required, refuses a missing one by name, and otherwise runs
//!    `momo_auth::human_control::verify_human_control_in_tx` (key, chain,
//!    statement, time window, nonce — last) against **this instance's** id.
//! 2. [`signature_columns`] — what the control row stores (095), passed to
//!    `insert_work_control_in_tx` as `NewWorkControl::human`.
//! 3. [`record_control_provenance_in_tx`] — the `action_signature` row
//!    (`alg = p256`, canonical low-s), bound to the control id the server just
//!    assigned.
//!
//! [`envelopes_in_tx`] is the other end: on the host's `pending-controls` read
//! a signed control carries `humanSignature` exactly as `momo-workd` verifies it
//! (E4 #3063's contract table): the stored columns plus the key's public key and
//! — for a phone — the root's endorsement letter.
//!
//! **The server's check is convenience and audit; the host is the boundary.**
//! Nothing here makes workd trust a key: workd rebuilds the statement from the
//! control it will act on and checks the key against the root it pinned itself.
//!
//! What needs a signature (D-8): a spawn, an input, a permission allow. The
//! switch-off side — `kill`, a `reject_*` decision, host revoke — never does,
//! so a lost device never stops its owner from stopping an agent. Only a
//! member-scoped host is in scope (ADR-0188); a workspace host keeps its rules.

use axum::http::StatusCode;
use momo_auth::device_key::{load_device_key_in_tx, DeviceKeyRecord};
use momo_auth::human_control::{
    db_now_ms, verify_human_control_in_tx, ControlTarget, HumanControlRefusal, HumanSignatureInput,
    VerifiedHumanControl,
};
use momo_db::{DbError, PgConnection};
use momo_t3::{HumanSignatureColumns, WorkControlRow};
use momo_wire::{
    record_human_provenance, EntityRef, Provenance, ProvenanceError, ENTITY_WORK_CONTROL,
};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::config::DeviceKeySettings;
use crate::dto::HumanSignatureRequest;
use crate::error::ApiError;

/// 503 when a signature arrives on an instance with no `MOMO_INSTANCE_ID` —
/// the label `POST …/work-hosts` already answers (#3022).
pub use crate::routes::work_hosts::REFUSAL_INSTANCE_ID_UNCONFIGURED;

/// A refusal → its named HTTP error.
pub fn refusal_error(refusal: HumanControlRefusal) -> ApiError {
    let (status, message) = match refusal {
        HumanControlRefusal::Required => (
            StatusCode::FORBIDDEN,
            "this instruction needs the owner's device-key signature",
        ),
        HumanControlRefusal::Invalid => (
            StatusCode::FORBIDDEN,
            "the device signature does not verify for this instruction",
        ),
        HumanControlRefusal::KeyRevoked => (StatusCode::FORBIDDEN, "the device key is revoked"),
        HumanControlRefusal::NotEndorsed => (
            StatusCode::FORBIDDEN,
            "this device is not approved to instruct yet (approve it from the host Mac)",
        ),
        HumanControlRefusal::Expired => (
            StatusCode::FORBIDDEN,
            "the signed instruction is outside its time window",
        ),
        HumanControlRefusal::NonceReplayed => (
            StatusCode::CONFLICT,
            "this signed instruction was already used",
        ),
    };
    ApiError::coded(status, refusal.code(), message)
}

fn signature_input(request: &HumanSignatureRequest) -> HumanSignatureInput {
    HumanSignatureInput {
        device_key_id: request.device_key_id,
        nonce: request.nonce,
        issued_at_ms: request.issued_at_ms,
        expires_at_ms: request.expires_at_ms,
        signature_b64: request.signature.clone(),
        mode: request.mode.clone(),
        scope: request.scope.clone(),
        agent_member_id: request.agent_member_id,
        folder_id: request.folder_id.clone(),
    }
}

/// The chokepoint. `required` is the route's judgment of D-8 for this control
/// (a spawn / input / allow addressed to a member host, with
/// `MOMO_HUMAN_CONTROL_SIGNATURE_REQUIRED` on). A signature that is sent is
/// verified whether or not it was required (the #3022 precedent), so a client
/// can never store an unverified one.
///
/// `Ok(Ok(None))`: nothing was sent and nothing was required — today's
/// behaviour, untouched. `Ok(Ok(Some(_)))`: verified and the nonce is spent;
/// the caller writes the control with [`signature_columns`] and then
/// [`record_control_provenance_in_tx`] in this same transaction.
pub async fn authorize_human_control_in_tx(
    conn: &mut PgConnection,
    settings: &DeviceKeySettings,
    target: &ControlTarget<'_>,
    signature: Option<&HumanSignatureRequest>,
    required: bool,
) -> Result<Result<Option<VerifiedHumanControl>, ApiError>, DbError> {
    let Some(signature) = signature else {
        return Ok(if required {
            Err(refusal_error(HumanControlRefusal::Required))
        } else {
            Ok(None)
        });
    };
    let Some(instance_id) = settings.instance_id.as_deref() else {
        return Ok(Err(ApiError::coded(
            StatusCode::SERVICE_UNAVAILABLE,
            REFUSAL_INSTANCE_ID_UNCONFIGURED,
            "this instance has no MOMO_INSTANCE_ID, so no signed instruction can verify",
        )));
    };
    // The database clock, inside the transaction (review L3).
    let now_ms = db_now_ms(conn).await?;
    let verified = verify_human_control_in_tx(
        conn,
        instance_id,
        target,
        &signature_input(signature),
        now_ms,
    )
    .await?;
    Ok(verified.map(Some).map_err(refusal_error))
}

/// The `work_control` signature columns for a verified statement.
pub fn signature_columns(verified: &VerifiedHumanControl) -> HumanSignatureColumns {
    HumanSignatureColumns {
        device_key_id: verified.key.id,
        instance_id: verified.instance_id.clone(),
        nonce: verified.nonce,
        issued_at_ms: verified.issued_at_ms,
        expires_at_ms: verified.expires_at_ms,
        mode: verified.mode.map(str::to_string),
        scope: verified.scope.map(str::to_string),
        spawn_agent_member_id: verified.agent_member_id,
        spawn_folder_id: verified.folder_id.clone(),
        signature: verified.signature_b64.clone(),
    }
}

/// Record the verified statement in `action_signature`, bound to the control
/// the server just wrote (`entity_type = work_control`). Same transaction.
pub async fn record_control_provenance_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    control_id: Uuid,
    verified: &VerifiedHumanControl,
) -> Result<(), DbError> {
    record_signed_statement_in_tx(
        conn,
        workspace_id,
        &EntityRef::new(ENTITY_WORK_CONTROL, control_id),
        verified.key.member_id,
        &verified.key.public_key,
        &verified.signature_b64,
        &verified.signed_bytes,
    )
    .await
}

/// `record_human_provenance`, with a rejection (which a just-verified
/// statement cannot produce) surfaced as a failed transaction rather than a
/// silently missing row.
pub async fn record_signed_statement_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    entity: &EntityRef,
    member_id: Uuid,
    public_key_b64: &str,
    signature_b64: &str,
    signed_bytes: &[u8],
) -> Result<(), DbError> {
    match record_human_provenance(
        conn,
        workspace_id,
        entity,
        member_id,
        public_key_b64,
        signature_b64,
        signed_bytes,
    )
    .await
    {
        Ok(Provenance::Recorded(_)) => Ok(()),
        // The nonce makes a statement one action; an existing row for these
        // exact signature bytes would bind the control to another entity's
        // proof. Refused, not absorbed (#3023 review N1).
        Ok(Provenance::AlreadyRecorded(_)) => Err(DbError::Sqlx(momo_db::sqlx::Error::Protocol(
            "a human statement's signature is already recorded for another action".to_string(),
        ))),
        Err(ProvenanceError::Db(error)) => Err(DbError::from(error)),
        Err(ProvenanceError::SignatureRejected { .. }) => {
            Err(DbError::Sqlx(momo_db::sqlx::Error::Protocol(
                "a verified human statement failed provenance verification".to_string(),
            )))
        }
    }
}

/// `WorkControl.humanSignature` for one signed row (E4 #3063's shape).
pub fn envelope(columns: &HumanSignatureColumns, key: &DeviceKeyRecord) -> Value {
    let mut body = Map::new();
    body.insert("alg".into(), json!(key.alg));
    body.insert("instanceId".into(), json!(columns.instance_id));
    body.insert(
        "deviceKeyId".into(),
        json!(columns.device_key_id.to_string()),
    );
    body.insert("devicePublicKey".into(), json!(key.public_key));
    if let (Some(root_key_id), Some(letter)) = (key.endorsed_by_key_id, &key.endorsement_sig) {
        body.insert(
            "endorsement".into(),
            json!({
                "rootKeyId": root_key_id.to_string(),
                "label": key.label,
                "signature": letter,
            }),
        );
    }
    body.insert("nonce".into(), json!(columns.nonce.to_string()));
    body.insert("issuedAtMs".into(), json!(columns.issued_at_ms));
    body.insert("expiresAtMs".into(), json!(columns.expires_at_ms));
    if let Some(mode) = &columns.mode {
        body.insert("mode".into(), json!(mode));
    }
    if let Some(scope) = &columns.scope {
        body.insert("scope".into(), json!(scope));
    }
    if let Some(agent) = columns.spawn_agent_member_id {
        body.insert("agentMemberId".into(), json!(agent.to_string()));
    }
    if let Some(folder) = &columns.spawn_folder_id {
        body.insert("folderId".into(), json!(folder));
    }
    body.insert("signature".into(), json!(columns.signature));
    Value::Object(body)
}

/// The envelope of each signed control in `controls`, by control id. A key
/// row is read once per distinct key (a poll holds at most 100 controls).
pub async fn envelopes_in_tx(
    conn: &mut PgConnection,
    controls: &[WorkControlRow],
) -> Result<std::collections::HashMap<Uuid, Value>, DbError> {
    let mut keys: std::collections::HashMap<Uuid, Option<DeviceKeyRecord>> =
        std::collections::HashMap::new();
    let mut out = std::collections::HashMap::new();
    for control in controls {
        let Some(columns) = &control.human else {
            continue;
        };
        if let std::collections::hash_map::Entry::Vacant(slot) = keys.entry(columns.device_key_id) {
            slot.insert(load_device_key_in_tx(conn, columns.device_key_id).await?);
        }
        // The FK keeps the key row; rows are never deleted (D-7).
        if let Some(Some(key)) = keys.get(&columns.device_key_id) {
            out.insert(control.id, envelope(columns, key));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(endorsed: bool) -> DeviceKeyRecord {
        DeviceKeyRecord {
            id: Uuid::from_u128(1),
            workspace_id: Uuid::from_u128(2),
            member_id: Uuid::from_u128(3),
            session_id: Uuid::from_u128(4),
            alg: "p256".into(),
            public_key: "Al5MJdwsIiT7groXgUDS9kC6VMwSS1QutnuZEZlbxi5S".into(),
            platform: if endorsed { "ios" } else { "macos" }.into(),
            label: "폰".into(),
            endorsed_by_key_id: endorsed.then(|| Uuid::from_u128(9)),
            endorsement_sig: endorsed.then(|| format!("{}==", "A".repeat(86))),
            endorsed_at_ms: endorsed.then_some(1),
            endorser_live: endorsed,
            created_at_ms: 0,
            revoked_at_ms: None,
            revoked_reason: None,
            revoked_by_key_id: None,
            revocation_sig: None,
            revocation_signed_at_ms: None,
        }
    }

    fn columns() -> HumanSignatureColumns {
        HumanSignatureColumns {
            device_key_id: Uuid::from_u128(1),
            instance_id: "inst".into(),
            nonce: Uuid::from_u128(7),
            issued_at_ms: 10,
            expires_at_ms: 20,
            mode: None,
            scope: Some("once".into()),
            spawn_agent_member_id: None,
            spawn_folder_id: None,
            signature: "sig".into(),
        }
    }

    #[test]
    fn a_root_envelope_has_no_endorsement_and_a_phone_one_carries_the_letter() {
        let root = envelope(&columns(), &key(false));
        assert!(root.get("endorsement").is_none());
        assert_eq!(root["alg"], "p256");
        assert_eq!(root["scope"], "once");
        assert!(root.get("mode").is_none());
        let phone = envelope(&columns(), &key(true));
        assert_eq!(
            phone["endorsement"]["rootKeyId"],
            Uuid::from_u128(9).to_string()
        );
        assert_eq!(phone["endorsement"]["label"], "폰");
    }

    #[test]
    fn named_refusals_keep_their_codes() {
        assert_eq!(
            refusal_error(HumanControlRefusal::Required).code,
            Some("device_signature_required")
        );
        assert_eq!(
            refusal_error(HumanControlRefusal::NonceReplayed).status,
            StatusCode::CONFLICT
        );
    }
}
