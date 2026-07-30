//! Terminal-attach control plane — Swift `TerminalAttachRoutes.swift` parity.
//!
//! ```text
//! POST /v1/workspaces/{ws}/work-sessions/{session}/terminal-attach   (bearer, human)
//! POST /v1/workspaces/{ws}/work-hosts/{host}/terminal-attach/validate (PUBLIC, host-signed)
//! ```
//!
//! ## The line this module does not cross
//!
//! momo mints a bearer and answers whether one is still good. It does not carry
//! a byte: no stream, no websocket, no stdin, no resize, no relay — the same
//! sentence `TerminalAttachRoutes.swift:121-122` writes about itself. The PTY,
//! its ADR-0139 D2 ring buffer, and the `replay_end` splice are the host
//! daemon's (B5). This is what keeps `docs/security/README.ko.md`'s "실행 내용
//! 미보관" literally true rather than aspirational.
//!
//! ## Why `validate` is public and `issue` is not
//!
//! `issue` is a human asking for a capability, so it sits behind the bearer
//! middleware. `validate` is a **daemon** asking whether a capability is still
//! good; a daemon holds no bearer token, only its Ed25519 key — the same reason
//! `…/work-hosts/{host}/heartbeat` is mounted outside the middleware (B2.2).
//! It is authenticated by [`crate::work_host_auth`], which is the v2 request
//! signature: method, path, workspace, host, timestamp, **raw body digest** and
//! a one-time request id.
//!
//! ## No SQL here
//!
//! Every statement is `momo_t3::terminal_attach`; the audit row is
//! `momo_db::audit::write_audit`; the observer broadcast is
//! `momo_outbox::emit_outbox`, the workspace's only egress. This module is
//! translation only.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::{Extension, Json};
use momo_auth::{active_workspace_role, Principal};
use momo_db::audit::{write_audit, AuditEntry};
use momo_messaging::cent_channel;
use momo_outbox::{emit_outbox, OutboxKind};
use momo_t3::{
    active_observer_capability_count_in_tx, is_active_channel_member_in_tx,
    is_valid_capability_token, issue_attach_capability_in_tx, lock_attach_target_in_tx,
    mint_capability_token, sweep_spent_observer_capabilities_in_tx,
    validate_attach_capability_in_tx, AttachMode, T3Error,
};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::dto::{
    IssueTerminalAttachRequest, TerminalAttachCapabilityResponse, TerminalAttachValidationResponse,
    ValidateTerminalAttachRequest,
};
use crate::error::ApiError;
use crate::routes::shared::{
    audit_via_token_id, path_uuid, require_human, settle, tenant_tx, workspace_scope, Rejectable,
};
use crate::work_host_auth::{
    authenticate_signed_host_request, signed_request_unauthorized, MAX_SIGNED_BODY_BYTES,
};
use crate::AppState;

/// `audit_log.action` for a minted grant (`TerminalAttachRoutes.swift:239`).
const AUDIT_ACTION_ISSUED: &str = "work.terminal_attach.issued";
/// `detail.schema` for that row (:242).
const AUDIT_SCHEMA_ISSUED: &str = "momo.work.terminal_attach.issued.v1";

/// `issueMode` (:419-432): an absent, empty or `{}` body means `controller`; an
/// unparseable body or an unknown grade is a 400 with Swift's sentence.
fn requested_mode(body: &[u8]) -> Result<AttachMode, ApiError> {
    let invalid = || ApiError::bad_request("mode must be controller or observer");
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(AttachMode::Controller);
    }
    let request: IssueTerminalAttachRequest =
        serde_json::from_slice(body).map_err(|_| invalid())?;
    match request.mode.as_deref() {
        None => Ok(AttachMode::Controller),
        Some(raw) => AttachMode::from_db_label(raw).ok_or_else(invalid),
    }
}

/// The `work.session.observer` broadcast (`observerPayload`, :395-417).
///
/// Deliberately carries **no** `version`: this envelope does not advance the
/// channel's message seq, and claiming a version the relay would compare against
/// the channel's own would make it stale-skip a real `message.new` (the defect
/// batch 2 recorded). Ids are lowercase here, matching every other Rust-emitted
/// payload in this workspace; the clients fold UUID case (`api.ts:1216-1219`).
fn observer_payload(
    workspace_id: Uuid,
    channel_id: Uuid,
    session_id: Uuid,
    observer_count: i64,
    grant_id: Uuid,
    timestamp_ms: i64,
) -> Value {
    let channel = cent_channel(workspace_id, channel_id);
    json!({
        "channel": channel,
        "data": {
            "type": "work.session.observer",
            "v": 1,
            "ts": timestamp_ms,
            "payload": {
                "session_id": session_id.to_string(),
                "observer_count": observer_count,
            },
        },
        "idempotency_key": format!("{channel}:work.session.observer:{grant_id}"),
    })
}

// ---------------------------------------------------------------------------
// issue
// ---------------------------------------------------------------------------

/// `POST /v1/workspaces/{ws}/work-sessions/{session}/terminal-attach`
/// (Swift `issue`, :153-301).
pub async fn issue(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, session)): Path<(String, String)>,
    body: Bytes,
) -> Result<Json<TerminalAttachCapabilityResponse>, ApiError> {
    require_human(&principal, "terminal attach requires a human bearer")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let session_id = path_uuid(&session, "invalid work session id")?;
    let mode = requested_mode(&body)?;

    // Minted outside the transaction, exactly like Swift (:163): only its digest
    // is written, and a rolled-back transaction must not leave a live bearer in
    // a client's hands — so the value is returned only if the commit succeeds.
    let token = mint_capability_token();
    let member_id = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);
    let minted = token.clone();

    let binding = settle(
        "terminal_attach.issue",
        tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                issue_in_tx(
                    conn,
                    workspace_id,
                    member_id,
                    via_token_id,
                    session_id,
                    mode,
                    &minted,
                )
                .await
            })
        })
        .await,
    )?;

    Ok(Json(TerminalAttachCapabilityResponse {
        attach_endpoint: binding.attach_endpoint,
        capability_token: token,
        pty_id: binding.pty_id,
    }))
}

async fn issue_in_tx(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    via_token_id: Option<Uuid>,
    session_id: Uuid,
    mode: AttachMode,
    token: &str,
) -> Rejectable<momo_t3::RemotePtyBinding> {
    // ---- rejections first (nothing is written above the sweep) -------------
    // Workspace membership gates existence disclosure: a stranger learns 403,
    // never whether this session id is real (Swift :168-172).
    if active_workspace_role(conn, workspace_id, member_id)
        .await
        .map_err(|error| T3Error::from(momo_db::DbError::from(error)))?
        .is_none()
    {
        return Ok(Err(ApiError::forbidden("not an active workspace member")));
    }
    let Some(target) = lock_attach_target_in_tx(conn, workspace_id, session_id).await? else {
        return Ok(Err(ApiError::not_found("work session not found")));
    };
    match mode {
        AttachMode::Controller => {
            // Only the owner gets stdin/resize/kill (:192-196).
            if target.owner_member_id != member_id {
                return Ok(Err(ApiError::forbidden(
                    "only the session owner can attach as controller",
                )));
            }
        }
        AttachMode::Observer => {
            // Two separate refusals, in Swift's order, because they mean
            // different things: the owner closed the session (:197-200), versus
            // you are not in the channel it lives in (:201-207).
            if target.observation != "open" {
                return Ok(Err(ApiError::forbidden(
                    "session observation is owner-only",
                )));
            }
            if !is_active_channel_member_in_tx(conn, workspace_id, target.channel_id, member_id)
                .await?
            {
                return Ok(Err(ApiError::forbidden(
                    "active channel membership required",
                )));
            }
        }
    }
    // Live session + unrevoked host + a binding that still parses (:209-216).
    // One 409 for all three: which of them is false describes the host's
    // internal state to someone who is only entitled to know it is unavailable.
    if !target.is_attachable() {
        return Ok(Err(ApiError::new(
            StatusCode::CONFLICT,
            "terminal attach is unavailable",
        )));
    }
    let binding = target
        .binding
        .clone()
        .expect("is_attachable() is false without a binding");

    // ---- writes ------------------------------------------------------------
    sweep_spent_observer_capabilities_in_tx(conn, workspace_id, session_id).await?;
    let issued = issue_attach_capability_in_tx(
        conn,
        workspace_id,
        session_id,
        target.host_id,
        member_id,
        token,
        mode,
    )
    .await?;

    // The audit row is written in the SAME transaction as the grant (Swift's
    // `audited` CTE, :234-250): a capability that exists without a record of who
    // minted it is exactly what an audit log is for.
    write_audit(
        conn,
        &AuditEntry::new(workspace_id, AUDIT_ACTION_ISSUED)
            .by(member_id)
            .target("work_session", session_id)
            .via_token(via_token_id)
            .with_schema(
                AUDIT_SCHEMA_ISSUED,
                json!({
                    "owner_member_id": target.owner_member_id.to_string(),
                    "mode": mode.as_db_label(),
                    "issued_at": issued.issued_at_ms,
                    "expires_at": issued.expires_at_ms,
                }),
            ),
    )
    .await
    .map_err(T3Error::from)?;

    if mode == AttachMode::Observer {
        let observer_count =
            active_observer_capability_count_in_tx(conn, workspace_id, session_id).await?;
        let payload = observer_payload(
            workspace_id,
            target.channel_id,
            session_id,
            observer_count,
            issued.id,
            issued.issued_at_ms,
        );
        emit_outbox(
            &mut *conn,
            workspace_id,
            OutboxKind::Broadcast,
            "publish",
            &payload,
            Some(target.channel_id),
        )
        .await
        .map_err(|error| T3Error::from(momo_db::DbError::from(error)))?;
    }

    Ok(Ok(binding))
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

/// `POST /v1/workspaces/{ws}/work-hosts/{host}/terminal-attach/validate`
/// — PUBLIC, host-signed (Swift `validate`, :303-380).
///
/// Every rejection is `invalid terminal attach capability`, 401: an unknown
/// token, an expired one, an ended session and a revoked host are all the same
/// sentence, so a host that is probing learns nothing from the difference.
pub async fn validate(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    Path((workspace, host)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<TerminalAttachValidationResponse>, ApiError> {
    // Signature failures answer the *signature* 401; capability failures answer
    // the *capability* 401. The distinction is Swift's and is safe: a caller who
    // cannot sign never learns anything about a token.
    if body.len() > MAX_SIGNED_BODY_BYTES {
        return Err(signed_request_unauthorized());
    }
    // No principal: a daemon holds a signing key, never a bearer, so the
    // workspace comes from the path and is validated as a UUID only. RLS still
    // confines every statement below to it. A malformed id answers the signature
    // 401 rather than a 400 — on a signed route, an id that cannot be parsed is
    // an id that cannot have been signed, and the caller learns nothing either
    // way (Swift `hostID(fromPath:)` → `invalidCapability`, :454-458).
    let (Ok(workspace_id), Ok(host_id)) = (Uuid::parse_str(&workspace), Uuid::parse_str(&host))
    else {
        return Err(signed_request_unauthorized());
    };

    let signed = authenticate_signed_host_request(
        &state,
        &method,
        uri.path(),
        &headers,
        &body,
        workspace_id,
        host_id,
    )
    .await?;

    let request: ValidateTerminalAttachRequest =
        serde_json::from_slice(&body).map_err(|_| invalid_capability())?;
    // Shape before the database, so a malformed bearer costs no query (:316).
    if !is_valid_capability_token(&request.capability_token) {
        return Err(invalid_capability());
    }
    let token = request.capability_token.clone();
    let revalidating = request.stream.unwrap_or(false);
    let signing_host = signed.host_id;

    let validated = settle(
        "terminal_attach.validate",
        tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                Ok(Ok(validate_attach_capability_in_tx(
                    conn,
                    workspace_id,
                    signing_host,
                    &token,
                    revalidating,
                )
                .await?))
            })
        })
        .await,
    )?;

    let validated = validated.ok_or_else(invalid_capability)?;
    Ok(Json(TerminalAttachValidationResponse {
        work_session_id: validated.work_session_id.to_string(),
        pty_id: validated.pty_id,
        expires_at: validated.expires_at,
        mode: validated.mode.as_db_label(),
    }))
}

/// `invalidCapability` (:460-462).
fn invalid_capability() -> ApiError {
    ApiError::unauthorized("invalid terminal attach capability")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_absent_or_empty_body_means_controller() {
        assert_eq!(requested_mode(b"").unwrap(), AttachMode::Controller);
        assert_eq!(requested_mode(b"   \n").unwrap(), AttachMode::Controller);
        assert_eq!(requested_mode(b"{}").unwrap(), AttachMode::Controller);
        assert_eq!(
            requested_mode(br#"{"mode":null}"#).unwrap(),
            AttachMode::Controller
        );
    }

    #[test]
    fn mode_is_a_closed_vocabulary_with_swifts_sentence() {
        assert_eq!(
            requested_mode(br#"{"mode":"observer"}"#).unwrap(),
            AttachMode::Observer
        );
        assert_eq!(
            requested_mode(br#"{"mode":"controller"}"#).unwrap(),
            AttachMode::Controller
        );
        for bad in [
            &br#"{"mode":"admin"}"#[..],
            &br#"{"mode":"Observer"}"#[..],
            &b"not json"[..],
            &br#"{"mode":7}"#[..],
        ] {
            let error = requested_mode(bad).expect_err("must be refused");
            assert_eq!(error.status, StatusCode::BAD_REQUEST);
            assert_eq!(error.message, "mode must be controller or observer");
        }
    }

    #[test]
    fn the_observer_broadcast_carries_no_version_and_a_per_grant_key() {
        let workspace = Uuid::from_u128(1);
        let channel = Uuid::from_u128(2);
        let session = Uuid::from_u128(3);
        let grant = Uuid::from_u128(4);
        let payload = observer_payload(workspace, channel, session, 3, grant, 1_700_000_000_000);

        assert!(
            payload.get("version").is_none(),
            "this envelope advances no channel seq; a version would make the \
             relay stale-skip a real message.new"
        );
        let channel_name = cent_channel(workspace, channel);
        assert_eq!(payload["channel"], json!(channel_name));
        assert_eq!(payload["data"]["type"], json!("work.session.observer"));
        assert_eq!(payload["data"]["v"], json!(1));
        assert_eq!(payload["data"]["payload"]["observer_count"], json!(3));
        assert_eq!(
            payload["data"]["payload"]["session_id"],
            json!(session.to_string())
        );
        assert_eq!(
            payload["idempotency_key"],
            json!(format!("{channel_name}:work.session.observer:{grant}")),
            "keyed per grant, so two observers joining are two events"
        );
    }

    #[test]
    fn every_capability_rejection_is_the_same_401() {
        let error = invalid_capability();
        assert_eq!(error.status, StatusCode::UNAUTHORIZED);
        assert_eq!(error.message, "invalid terminal attach capability");
    }
}
