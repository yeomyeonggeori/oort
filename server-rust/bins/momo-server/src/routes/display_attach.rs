//! Display-attach control plane — the LIVE-1 half of ADR-0165.
//!
//! ```text
//! POST /v1/workspaces/{ws}/work-sessions/{session}/display-attach     (bearer, human)
//! POST /v1/workspaces/{ws}/work-sessions/{session}/display-binding    (work-host-signed)
//! POST /v1/workspaces/{ws}/work-hosts/{host}/display-attach/validate  (PUBLIC, host-signed)
//! ```
//!
//! ## The line this module does not cross, restated for pixels
//!
//! [`crate::routes::terminal_attach`] says momo carries no terminal byte. This
//! module says momo carries no **frame**, and it means it one step earlier than
//! you might expect: it does not carry the *signalling* either. The endpoint
//! this server hands out is the sandbox's own WebRTC signalling WebSocket
//! (ADR-0165 D2); the SDP offer, the ICE candidates and the media that follows
//! are between the browser and the VM. There is no SFU, no TURN of ours, and no
//! recording — ADR-0165 D3 and D5 are absences in this file, and the way to
//! check them is that nothing here opens a socket.
//!
//! ## Why this is a route and not a `kind` query parameter on the PTY one
//!
//! The **machine** is shared — one table, one issue statement, one validation
//! join, one sweep ([`momo_t3::terminal_attach`]'s module header explains why).
//! The **wire** is not, and deliberately: the PTY response's `pty_id` is a
//! required field two shipped clients parse, so a body that sometimes carries
//! `display_id` instead would either break them or grow both fields optional and
//! let a client dial the wrong stream on a typo. Separate paths also put the
//! kind in the URL, which is where an operator reading an access log can see it.
//!
//! ## The boundary this file is currently holding
//!
//! Display capabilities are **observer-only**, and a `controller` request is a
//! 403 with its reason named. That is not an implementation gap: input is
//! ADR-0004 증보 3's decision and it has not been made. Three layers say so —
//! this route, [`momo_t3::AttachKind::permits_mode`], and 075's
//! `terminal_attach_display_observer_ck`. The day control opens, all three move
//! together and none of them can be missed.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::{Extension, Json};
use momo_auth::{active_workspace_role, Principal, PrincipalKind};
use momo_db::audit::{write_audit, AuditEntry};
use momo_outbox::{emit_outbox, OutboxKind};
use momo_t3::{
    active_observer_capability_count_in_tx, is_active_channel_member_in_tx,
    is_valid_capability_token, issue_attach_capability_in_tx, lock_attach_target_in_tx,
    lock_display_binding_target_in_tx, mint_capability_token,
    sweep_spent_observer_capabilities_in_tx, validate_attach_capability_in_tx,
    validated_display_binding, write_display_binding_in_tx, AttachKind, AttachMode,
    RemoteDisplayBinding, T3Error,
};
use momo_wire::{
    record_provenance, EntityRef, ProvenanceError, Signer,
    ENTITY_WORK_HOST_TERMINAL_ATTACH_VALIDATE,
};
use serde_json::json;
use uuid::Uuid;

use crate::dto::{
    DisplayAttachCapabilityResponse, DisplayAttachValidationResponse, IssueDisplayAttachRequest,
    PublishDisplayBindingRequest, ValidateDisplayAttachRequest,
};
use crate::error::ApiError;
use crate::routes::shared::{
    audit_via_token_id, path_uuid, require_human, settle, tenant_tx, workspace_scope, Rejectable,
};
use crate::routes::terminal_attach::observer_payload;
use crate::work_host_auth::{
    authenticate_signed_host_request, signed_request_unauthorized, VerifiedHostSignature,
    MAX_SIGNED_BODY_BYTES,
};
use crate::AppState;

/// `audit_log.action` for a minted display grant.
const AUDIT_ACTION_ISSUED: &str = "work.display_attach.issued";
/// `detail.schema` for that row.
const AUDIT_SCHEMA_ISSUED: &str = "momo.work.display_attach.issued.v1";
/// `audit_log.action` for a daemon publishing its screen.
const AUDIT_ACTION_BOUND: &str = "work.display_binding.published";
/// `detail.schema` for that row.
const AUDIT_SCHEMA_BOUND: &str = "momo.work.display_binding.published.v1";

/// The only grade this build mints. Named once so the response literal, the
/// audit row and the refusal cannot drift apart.
const DISPLAY_MODE: AttachMode = AttachMode::Observer;

/// The refusal ADR-0004 증보 3 is holding.
fn controller_display_forbidden() -> ApiError {
    ApiError::forbidden("display attach is view-only; controller mode is not available")
}

/// `issueMode`'s display twin. An absent, empty or `{}` body means `observer` —
/// the only grade this route can produce — and `controller` is refused **403,
/// not 400**: it is a well-formed request for a capability that exists in the
/// vocabulary and is not available to anyone, which is what 403 means. A 400
/// would tell a client it had mistyped something.
fn requested_display_mode(body: &[u8]) -> Result<AttachMode, ApiError> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(DISPLAY_MODE);
    }
    let request: IssueDisplayAttachRequest =
        serde_json::from_slice(body).map_err(|_| ApiError::bad_request("mode must be observer"))?;
    match request.mode.as_deref() {
        None | Some("observer") => Ok(DISPLAY_MODE),
        Some("controller") => Err(controller_display_forbidden()),
        Some(_) => Err(ApiError::bad_request("mode must be observer")),
    }
}

// ---------------------------------------------------------------------------
// issue
// ---------------------------------------------------------------------------

/// `POST /v1/workspaces/{ws}/work-sessions/{session}/display-attach`.
pub async fn issue(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, session)): Path<(String, String)>,
    body: Bytes,
) -> Result<Json<DisplayAttachCapabilityResponse>, ApiError> {
    require_human(&principal, "display attach requires a human bearer")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let session_id = path_uuid(&session, "invalid work session id")?;
    // Before the database, so a controller request costs no query and cannot be
    // used to probe which sessions exist.
    requested_display_mode(&body)?;

    // Minted outside the transaction for `terminal_attach::issue`'s reason: only
    // its digest is written, and a rolled-back transaction must not leave a live
    // bearer in a client's hands.
    let token = mint_capability_token();
    let member_id = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);
    let minted = token.clone();

    let binding = settle(
        "display_attach.issue",
        tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                issue_in_tx(
                    conn,
                    workspace_id,
                    member_id,
                    via_token_id,
                    session_id,
                    &minted,
                )
                .await
            })
        })
        .await,
    )?;

    Ok(Json(DisplayAttachCapabilityResponse {
        display_endpoint: binding.display_endpoint,
        capability_token: token,
        display_id: binding.display_id,
        mode: DISPLAY_MODE.as_db_label(),
    }))
}

async fn issue_in_tx(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    via_token_id: Option<Uuid>,
    session_id: Uuid,
    token: &str,
) -> Rejectable<RemoteDisplayBinding> {
    // ---- rejections first (nothing is written above the sweep) -------------
    // Workspace membership gates existence disclosure: a stranger learns 403,
    // never whether this session id is real.
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

    // The observer gate, **verbatim** from the PTY path — same two refusals, same
    // order, same sentences. LIVE-1 was told to reuse the existing observation
    // model rather than invent one for screens, and reuse means this and not a
    // paraphrase.
    //
    // One consequence is worth naming rather than discovering: because display
    // has no controller grade, an `owner_only` session has no display access
    // **for anyone, including its owner**. On the PTY side the owner reaches
    // their own session as controller; here that door does not exist yet. Whether
    // `owner_only` should mean "only the owner watches" (an owner exemption) or
    // "nobody watches" is a permission decision, and inventing the exemption here
    // would be exactly the new권한 model this goal was told not to write. Refusing
    // is the fail-closed direction, so refusing is what this does.
    if target.observation != "open" {
        return Ok(Err(ApiError::forbidden(
            "session observation is owner-only",
        )));
    }
    if !is_active_channel_member_in_tx(conn, workspace_id, target.channel_id, member_id).await? {
        return Ok(Err(ApiError::forbidden(
            "active channel membership required",
        )));
    }

    // Live session + unrevoked host + a display binding that still parses + a
    // host that advertised a display. One 409 for all four, for the PTY path's
    // reason: which of them is false describes the host's internal state to
    // someone who is only entitled to know it is unavailable.
    //
    // This is also the fail-closed gate the packet asks for. A host that never
    // advertised `display_attach` is refused here, and BYOC is refused *by that*
    // — momo does not image a BYOC box, so nothing on it advertises — rather than
    // by a provider-name test that would teach this route a vendor's identity.
    if !target.is_display_attachable() {
        return Ok(Err(ApiError::new(
            StatusCode::CONFLICT,
            "display attach is unavailable",
        )));
    }
    let binding = target
        .display_binding
        .clone()
        .expect("is_display_attachable() is false without a display binding");

    // ---- writes ------------------------------------------------------------
    sweep_spent_observer_capabilities_in_tx(conn, workspace_id, session_id).await?;
    let issued = issue_attach_capability_in_tx(
        conn,
        workspace_id,
        session_id,
        target.host_id,
        member_id,
        token,
        DISPLAY_MODE,
        AttachKind::Display,
    )
    .await?;

    // Same transaction as the grant, for `terminal_attach`'s reason: a
    // capability that exists without a record of who minted it is exactly what
    // an audit log is for. `display_id` is deliberately absent from the detail —
    // it is a host-side name, and the audit row's job is who/when/what grade.
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
                    "mode": DISPLAY_MODE.as_db_label(),
                    "kind": AttachKind::Display.as_db_label(),
                    "issued_at": issued.issued_at_ms,
                    "expires_at": issued.expires_at_ms,
                }),
            ),
    )
    .await
    .map_err(T3Error::from)?;

    // The same count-only envelope the PTY observer path emits, and the same
    // count: `active_observer_capability_count_in_tx` is kind-blind, so a
    // teammate who opened the screen shows up in 관전자 수 like anyone else. A
    // second envelope, or a second number, would be the new observer model this
    // goal was told not to invent.
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

    Ok(Ok(binding))
}

// ---------------------------------------------------------------------------
// publish binding (work-host-signed)
// ---------------------------------------------------------------------------

/// `POST /v1/workspaces/{ws}/work-sessions/{session}/display-binding`.
///
/// Ports the PTY publish Swift serves on its signed `PATCH …/work-sessions/{s}`
/// arm (`WorkSessionRoutes.swift:1583-1656`) — the arm this server refuses by
/// name because it is unported. It is a route of its own rather than that PATCH
/// arm for two reasons: the arm carries five other unported behaviours that
/// would have to land with it, and a path segment named `display-binding` is
/// what makes this signable in exactly one place
/// ([`crate::work_host_auth::is_allowed_signed_path`]).
///
/// **The signer pin lives here, not in the authenticator.** The path names a
/// session, not a host, so `scoped_host_id_from_path` has nothing to pin against
/// — the same shape as `…/work-controls/{control}/ack`, and the same remedy: the
/// handler reads the ledger and requires the signing host to be the session's
/// own. Without it, any registered host in the workspace could publish a screen
/// onto any other host's session, which is a redirect of every future observer.
pub async fn publish_binding(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, session)): Path<(String, String)>,
    Json(request): Json<PublishDisplayBindingRequest>,
) -> Result<StatusCode, ApiError> {
    // A human bearer is refused here exactly as it is on the PTY binding fields
    // of create/PATCH: publishing a binding is a claim about what is running on
    // a machine, and only the machine can make it.
    if principal.kind != PrincipalKind::WorkHost {
        return Err(ApiError::forbidden(
            "display binding requires work host signature",
        ));
    }
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let session_id = path_uuid(&session, "invalid work session id")?;
    // `token_id` carries the HOST id on a `WorkHost` principal (see
    // `auth::authenticate_signed_host`). Its absence is unreachable, and
    // treating it as a refusal rather than an unwrap keeps it that way.
    let Some(signing_host_id) = principal.token_id else {
        return Err(signed_request_unauthorized());
    };

    // Validated before the transaction, with the same grammar the ledger's
    // CHECKs use, so a malformed pair costs no lock and the 400 names the
    // grammar rather than surfacing a constraint violation.
    let Some(binding) = validated_display_binding(
        Some(request.display_id.as_str()),
        Some(request.display_endpoint.as_str()),
    ) else {
        return Err(ApiError::bad_request(
            "displayEndpoint must be a credential-free HTTPS or WSS URL and displayId must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
        ));
    };

    settle(
        "display_attach.publish_binding",
        tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                publish_binding_in_tx(conn, workspace_id, session_id, signing_host_id, &binding)
                    .await
            })
        })
        .await,
    )?;
    Ok(StatusCode::NO_CONTENT)
}

async fn publish_binding_in_tx(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
    signing_host_id: Uuid,
    binding: &RemoteDisplayBinding,
) -> Rejectable<()> {
    let Some(target) = lock_display_binding_target_in_tx(conn, workspace_id, session_id).await?
    else {
        return Ok(Err(ApiError::not_found("work session not found")));
    };
    // The pin (module docs). Swift's sentence.
    if target.host_id != signing_host_id {
        return Ok(Err(ApiError::forbidden(
            "work host cannot bind another host session",
        )));
    }
    if target.host_revoked {
        return Ok(Err(ApiError::new(
            StatusCode::CONFLICT,
            "display binding requires an unrevoked work host",
        )));
    }
    // Fail-closed the other way round from issuance: a host that did not
    // advertise a display cannot publish one either. Otherwise a binding would
    // sit in the ledger looking real while every capability request 409s, and
    // the operator would have two surfaces disagreeing about the same box.
    if !target.host_display_capable {
        return Ok(Err(ApiError::new(
            StatusCode::CONFLICT,
            "work host does not advertise a display",
        )));
    }
    if target.status != "running" && target.status != "idle" {
        return Ok(Err(ApiError::new(
            StatusCode::CONFLICT,
            "display binding requires a running or idle session",
        )));
    }
    // Publishing is once. A restarted daemon republishing its own binding is the
    // same statement twice and answers 204; a *different* binding is 409, because
    // two producers claiming one session's screen is a state the ledger cannot
    // describe and picking a winner silently would point half the observers at a
    // stream that is not this session.
    if target.conflicts_with(binding) {
        return Ok(Err(ApiError::new(
            StatusCode::CONFLICT,
            "work session already has a different display binding",
        )));
    }
    if target.already_bound_to(binding) {
        return Ok(Ok(()));
    }

    if !write_display_binding_in_tx(conn, workspace_id, session_id, binding).await? {
        // The row moved out of `running|idle` under our own lock, which cannot
        // happen — but reporting a write that did not happen is worse than a
        // 409 nobody ever sees.
        return Ok(Err(ApiError::new(
            StatusCode::CONFLICT,
            "display binding requires a running or idle session",
        )));
    }

    // `by` is deliberately absent and `via_token` is NULL: a host is not a
    // member, and naming its owning human here would record that a person did
    // something they did not (`routes::shared::audit_via_token_id`'s rule). The
    // acting host is named in the detail instead.
    write_audit(
        conn,
        &AuditEntry::new(workspace_id, AUDIT_ACTION_BOUND)
            .target("work_session", session_id)
            .with_schema(
                AUDIT_SCHEMA_BOUND,
                json!({
                    "host_id": signing_host_id.to_string(),
                    "display_id": binding.display_id,
                }),
            ),
    )
    .await
    .map_err(T3Error::from)?;

    Ok(Ok(()))
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

/// `POST /v1/workspaces/{ws}/work-hosts/{host}/display-attach/validate`
/// — PUBLIC, host-signed.
///
/// Public for the reason its PTY twin is: the caller is the **producer daemon**
/// inside the sandbox, and a daemon holds a signing key, never a bearer.
/// Every rejection is the same 401 with the same sentence, so a host that is
/// probing learns nothing from the difference.
pub async fn validate(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    Path((workspace, host)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<DisplayAttachValidationResponse>, ApiError> {
    if body.len() > MAX_SIGNED_BODY_BYTES {
        return Err(signed_request_unauthorized());
    }
    let (Ok(workspace_id), Ok(_host_id)) = (Uuid::parse_str(&workspace), Uuid::parse_str(&host))
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
    )
    .await?;

    let request: ValidateDisplayAttachRequest =
        serde_json::from_slice(&body).map_err(|_| invalid_capability())?;
    // Shape before the database, so a malformed bearer costs no query.
    if !is_valid_capability_token(&request.capability_token) {
        return Err(invalid_capability());
    }
    let token = request.capability_token.clone();
    let revalidating = request.stream.unwrap_or(false);
    let signing_host = signed.host_id;
    let host_signature = signed.signature.clone();

    let validated = settle(
        "display_attach.validate",
        tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                // `AttachKind::Display` is a **predicate**, not a filter applied
                // afterwards: a producer presenting a terminal bearer gets the
                // ordinary 401, so the two surfaces on one box do not lend each
                // other authority.
                let validated = validate_attach_capability_in_tx(
                    conn,
                    workspace_id,
                    signing_host,
                    &token,
                    revalidating,
                    AttachKind::Display,
                )
                .await?;
                if let Some(validated) = validated.as_ref() {
                    if let Err(rejection) = record_display_validation(
                        conn,
                        workspace_id,
                        signing_host,
                        validated.work_session_id,
                        &host_signature,
                    )
                    .await?
                    {
                        return Ok(Err(rejection));
                    }
                }
                Ok(Ok(validated))
            })
        })
        .await,
    )?;

    let validated = validated.ok_or_else(invalid_capability)?;
    // Unreachable while 075's CHECK stands and the domain re-checks it; refusing
    // rather than serving is what keeps it unreachable if either is ever lost.
    if validated.mode != DISPLAY_MODE {
        return Err(invalid_capability());
    }
    Ok(Json(DisplayAttachValidationResponse {
        work_session_id: validated.work_session_id.to_string(),
        display_id: validated.target_id,
        expires_at: validated.expires_at,
        mode: DISPLAY_MODE.as_db_label(),
        // ADR-0165 D4, stated to the only process that can honour it.
        input_enabled: false,
    }))
}

fn invalid_capability() -> ApiError {
    ApiError::unauthorized("invalid display attach capability")
}

/// Record the producer's verified v2 signature as provenance for the display
/// attach it just validated (ADR-0146 §범위 2).
///
/// Shares [`ENTITY_WORK_HOST_TERMINAL_ATTACH_VALIDATE`] with the PTY path on
/// purpose. The question an auditor asks is "which host proved it may attach to
/// this session", and the answer is the same act with the same proof against the
/// same entity; a second entity kind would split one audit question into two
/// tables to search. Which surface it was is already in the `audit_log` row the
/// grant wrote.
async fn record_display_validation(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    host_id: Uuid,
    work_session_id: Uuid,
    signature: &VerifiedHostSignature,
) -> Rejectable<()> {
    let action = signature.action(workspace_id, host_id);
    match record_provenance(
        conn,
        workspace_id,
        &EntityRef::new(ENTITY_WORK_HOST_TERMINAL_ATTACH_VALIDATE, work_session_id),
        &Signer::work_host(&signature.signer_pubkey_b64),
        &signature.signature_b64,
        &action,
    )
    .await
    {
        Ok(_) => Ok(Ok(())),
        Err(ProvenanceError::SignatureRejected { .. }) => Ok(Err(signed_request_unauthorized())),
        Err(ProvenanceError::Db(error)) => Err(T3Error::from(momo_db::DbError::from(error))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_absent_or_empty_body_means_observer() {
        assert_eq!(requested_display_mode(b"").unwrap(), AttachMode::Observer);
        assert_eq!(
            requested_display_mode(b"   \n").unwrap(),
            AttachMode::Observer
        );
        assert_eq!(requested_display_mode(b"{}").unwrap(), AttachMode::Observer);
        assert_eq!(
            requested_display_mode(br#"{"mode":null}"#).unwrap(),
            AttachMode::Observer
        );
        assert_eq!(
            requested_display_mode(br#"{"mode":"observer"}"#).unwrap(),
            AttachMode::Observer
        );
    }

    /// The LIVE-1 boundary at the wire. 403 and not 400: the grade exists, it is
    /// spelled correctly, and it is not available to anybody.
    #[test]
    fn asking_for_control_is_forbidden_not_malformed() {
        let error = requested_display_mode(br#"{"mode":"controller"}"#)
            .expect_err("controller must be refused");
        assert_eq!(error.status, StatusCode::FORBIDDEN);
        assert_eq!(
            error.message,
            "display attach is view-only; controller mode is not available"
        );
    }

    #[test]
    fn mode_is_a_closed_vocabulary() {
        for bad in [
            &br#"{"mode":"admin"}"#[..],
            &br#"{"mode":"Observer"}"#[..],
            &br#"{"mode":"Controller"}"#[..],
            &b"not json"[..],
            &br#"{"mode":7}"#[..],
        ] {
            let error = requested_display_mode(bad).expect_err("must be refused");
            assert_eq!(error.status, StatusCode::BAD_REQUEST);
            assert_eq!(error.message, "mode must be observer");
        }
    }

    #[test]
    fn every_capability_rejection_is_the_same_401() {
        let error = invalid_capability();
        assert_eq!(error.status, StatusCode::UNAUTHORIZED);
        assert_eq!(error.message, "invalid display attach capability");
    }
}
