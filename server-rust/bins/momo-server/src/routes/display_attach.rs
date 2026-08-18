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
//! ## The boundary this file used to hold, and what replaced it
//!
//! Until LIVE-3 display capabilities were **observer-only** and a `controller`
//! request was a 403, held by three layers at once: this route,
//! [`momo_t3::AttachKind::permits_mode`], and 075's
//! `terminal_attach_display_observer_ck`. ADR-0004 증보 3 was Accepted on
//! 2026-08-15 and all three moved together in one commit, as 075's closing
//! comment promised they would.
//!
//! What took their place is not an absence. A lock that simply came off would
//! leave a build that can hand someone a keyboard into a live VM and has no
//! opinion about what the agent driving that VM is doing meanwhile — and that
//! opinion is the entire decision. So control here is three things at once:
//!
//! 1. **owner only.** The grant reuses the PTY controller predicate
//!    (`c.owner_member_id = ws.member_id`) rather than inventing a permission
//!    model: 증보 3 D1 says control is a person's act on their own session.
//! 2. **a window, in the ledger.** Every grant opens a
//!    `display_control_window` row (076) and every close writes a reason. That
//!    row is the SoT for the boundary events an agent is allowed to learn —
//!    정지 시각, 재개 시각 — and holds nothing else, because 증보 3 D2 puts the
//!    person's password out of reach of transcript, audit and Memory Plane
//!    alike.
//! 3. **the agent stopped.** While the window stands,
//!    [`crate::routes::work_controls::create`] refuses that session and the
//!    daemon poll withholds anything already dispatched. That pair is 증보 3
//!    D3's 기술적 차단, and it is enforcement rather than declaration: an agent
//!    that cannot ask for the screen cannot capture it.
//! 4. **the run layer parks.** Every `agent_run` driving that session goes
//!    `running` → `paused` in the window's own transaction
//!    ([`momo_agent::park_runs_for_control_window_in_tx`]) and back on every
//!    close. That is 증보 3 D6's other half — 「정지되는 것은 에이전트 런 층 …
//!    토큰 소진 0」 — and it is enforcement for the same reason (3) is: a parked
//!    run is `is_approval_held`, so the gateway refuses its progress events and
//!    its completion, and a run that cannot complete cannot write a
//!    `usage_ledger` row.
//!
//! The VM does not move (증보 3 D6): `work_session.status` is untouched here,
//! ADR-0140's state machine is untouched, and running-time billing continues.
//! What stops is the agent's reach into the session and the agent's spend on it,
//! which is the only thing that was ever supposed to stop.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::{Extension, Json};
use momo_agent::{park_runs_for_control_window_in_tx, resume_runs_from_control_window_in_tx};
use momo_auth::{active_workspace_role, Principal, PrincipalKind};
use momo_db::audit::{write_audit, AuditEntry};
use momo_messaging::{cent_channel, emit_message_edited_in_tx};
use momo_outbox::{emit_outbox, OutboxKind};
use momo_t3::{
    active_control_window_in_tx, active_observer_capability_count_in_tx,
    close_control_window_in_tx, control_window_payload, expire_lapsed_control_windows_in_tx,
    is_active_channel_member_in_tx, is_valid_capability_token, issue_attach_capability_in_tx,
    lock_attach_target_in_tx, lock_display_binding_target_in_tx, mint_capability_token,
    open_control_window_in_tx, renew_control_window_lease_in_tx,
    stamp_control_window_on_cards_in_tx, sweep_spent_observer_capabilities_in_tx,
    validate_attach_capability_in_tx, validated_display_binding, write_display_binding_in_tx,
    AttachKind, AttachMode, ControlWindow, ControlWindowEndReason, RemoteDisplayBinding, T3Error,
    AUDIT_ACTION_CONTROL_CLOSED, AUDIT_SCHEMA_CONTROL_CLOSED,
};
use momo_wire::{
    record_provenance, EntityRef, ProvenanceError, Signer,
    ENTITY_WORK_HOST_TERMINAL_ATTACH_VALIDATE,
};
use serde_json::json;
use uuid::Uuid;

use crate::dto::{
    DisplayAttachCapabilityResponse, DisplayAttachValidationResponse, DisplayControlReturnResponse,
    IssueDisplayAttachRequest, PublishDisplayBindingRequest, ValidateDisplayAttachRequest,
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
// `AUDIT_ACTION_CONTROL_CLOSED` / `AUDIT_SCHEMA_CONTROL_CLOSED` are imported
// from `momo_t3::display_control` rather than declared here beside their two
// siblings, because since #1425 this route is not their only author: the
// notifier's control-window sweep closes a window nobody performed a close on,
// and the two must write the same action with the same schema or an operator
// reading the boundary back finds one story told in two vocabularies.

/// The grade a body that says nothing asks for.
///
/// Deliberately still `observer` after LIVE-3 opened control: a default is what
/// a client gets when it did not consider the question, and taking the keyboard
/// stops the agent (증보 3 D3). That is never the safe guess.
const DEFAULT_DISPLAY_MODE: AttachMode = AttachMode::Observer;

/// `issueMode`'s display twin. An absent, empty or `{}` body means `observer`;
/// both grades are now spellable, and anything else is a 400 that names the
/// closed vocabulary rather than surfacing a serde error.
fn requested_display_mode(body: &[u8]) -> Result<AttachMode, ApiError> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(DEFAULT_DISPLAY_MODE);
    }
    let request: IssueDisplayAttachRequest = serde_json::from_slice(body)
        .map_err(|_| ApiError::bad_request("mode must be controller or observer"))?;
    match request.mode.as_deref() {
        None | Some("observer") => Ok(AttachMode::Observer),
        Some("controller") => Ok(AttachMode::Controller),
        Some(_) => Err(ApiError::bad_request("mode must be controller or observer")),
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
    // Before the database, so a malformed grade costs no query and cannot be
    // used to probe which sessions exist.
    let mode = requested_display_mode(&body)?;

    // Minted outside the transaction for `terminal_attach::issue`'s reason: only
    // its digest is written, and a rolled-back transaction must not leave a live
    // bearer in a client's hands.
    let token = mint_capability_token();
    let member_id = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);
    let minted = token.clone();

    let issued = settle(
        "display_attach.issue",
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

    Ok(Json(DisplayAttachCapabilityResponse {
        display_endpoint: issued.binding.display_endpoint,
        capability_token: token,
        display_id: issued.binding.display_id,
        mode: mode.as_db_label(),
        control_started_at: issued.control_started_at,
        // Minted **after** the transaction committed, and deliberately so: the
        // credential is derived, never stored, so there is nothing for a
        // rollback to leave behind — and minting it inside the transaction would
        // put an HMAC on the hot path of a statement holding a session row lock
        // for no gain. Same reasoning the capability bearer above is minted
        // outside for, arrived at from the other direction.
        ice_servers: ice_servers_for(&state, session_id),
    }))
}

/// The relay credential this instance hands out for one work session, or an
/// empty list when it was never given a relay (LIVE-5a).
///
/// A free function rather than a method on `AppState` because it is the *policy*
/// that knows how to mint and `AppState` only knows whether one exists — and
/// because both routes that need it are in this file, which is the whole
/// surface momo has that touches TURN at all.
///
/// Empty is not an error and must not be rendered as one. An instance without a
/// policy is every instance today; the producer and the browser both still hold
/// the static credential the install runbook shipped, and that overlap is what
/// makes the static one removable later rather than in the same breath.
fn ice_servers_for(state: &AppState, session_id: Uuid) -> Vec<crate::dto::IceServerDto> {
    state
        .turn
        .as_ref()
        .map(|policy| {
            policy
                .ice_servers_for_session(session_id)
                .into_iter()
                .map(Into::into)
                .collect()
        })
        .unwrap_or_default()
}

/// What [`issue_in_tx`] hands back: the endpoint pair the client dials, plus the
/// boundary timestamp when this grant opened a control window.
struct IssuedDisplayGrant {
    binding: RemoteDisplayBinding,
    control_started_at: Option<i64>,
}

#[allow(clippy::too_many_arguments)]
async fn issue_in_tx(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    via_token_id: Option<Uuid>,
    session_id: Uuid,
    mode: AttachMode,
    token: &str,
) -> Rejectable<IssuedDisplayGrant> {
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

    // The grade gate. Both arms are the PTY path's, and the display side adds
    // exactly one clause of its own (LIVE-3 / ADR-0004 증보 3).
    match mode {
        AttachMode::Controller => {
            // 증보 3 D1: control is a person acting on their own session, so the
            // predicate is the PTY controller's, reused rather than paraphrased
            // — `terminal_attach::issue_in_tx` refuses non-owners with this same
            // sentence, and the validate join shares the clause
            // (`c.mode = 'controller' AND c.owner_member_id = ws.member_id`).
            //
            // No observation clause and no channel-membership clause, again for
            // parity with PTY controller: `observation` governs who may WATCH,
            // and the owner of a session is not watching it.
            if target.owner_member_id != member_id {
                return Ok(Err(ApiError::forbidden(
                    "only the session owner can attach as controller",
                )));
            }
        }
        AttachMode::Observer => {
            // LIVE-1 wrote this arm verbatim from the PTY path and left one
            // consequence flagged for a decision: with no controller grade, an
            // `owner_only` session had no screen for **anybody, including its
            // owner**. 성재 settled it in the LIVE-3 wave — `owner_only` means
            // 「소유자만 본다」, not 「아무도 못 본다」 — so the owner is exempt
            // from the observation clause here.
            //
            // The exemption is scoped to `display` (the validate join scopes it
            // the same way) because PTY never had the problem it fixes: there,
            // an owner reaches their own `owner_only` session as controller.
            // Widening it to PTY observers would change a shipped permission
            // for no reason anybody asked for.
            //
            // It also matters more now than it did before this batch, and that
            // is the strongest argument for it: taking control STOPS THE AGENT
            // (증보 3 D3). Without an observer path an owner who only wants to
            // look would have to halt their own agent to do it.
            let is_owner = target.owner_member_id == member_id;
            if target.observation != "open" && !is_owner {
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

    // A control request is refused before any write if somebody else already
    // holds the keyboard. 076's partial unique index would catch it anyway, but
    // as a constraint violation rather than a sentence — and the caller is
    // entitled to know the difference between "this session cannot be
    // controlled" and "it is being controlled by someone else right now".
    //
    // Re-taking control while holding it is idempotent and handled inside
    // `open_control_window_in_tx`: a client retry must not mint a second window
    // and make 정지 시각 ambiguous for the agent.
    if mode == AttachMode::Controller {
        for lapsed in expire_lapsed_control_windows_in_tx(conn, workspace_id, session_id).await? {
            emit_control_closed_in_tx(conn, workspace_id, target.channel_id, None, None, &lapsed)
                .await?;
        }
        if let Some(existing) = active_control_window_in_tx(conn, workspace_id, session_id).await? {
            if existing.grantee_member_id != member_id {
                return Ok(Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "work session is already under human control",
                )));
            }
        }
    }

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
        AttachKind::Display,
    )
    .await?;

    // The window opens in the SAME transaction as the grant it belongs to. A
    // controller capability that exists without a window would be a keyboard
    // into a live VM with the agent still reading the screen — the exact state
    // ADR-0004 증보 3 D3 forbids — so the two cannot be allowed to come apart,
    // not even across a failed second statement.
    let control_window = if mode == AttachMode::Controller {
        match open_control_window_in_tx(conn, workspace_id, session_id, member_id, issued.id)
            .await?
        {
            Ok(window) => Some(window),
            // Unreachable: the check above already refused a foreign holder
            // under the session lock. Refusing rather than unwrapping keeps it
            // unreachable if that check is ever moved.
            Err(_) => {
                return Ok(Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "work session is already under human control",
                )))
            }
        }
    } else {
        None
    };

    // The run layer stops — ADR-0004 증보 3 D6, the half LIVE-3 left unwritten.
    //
    // Same transaction as the window, for the window's own reason: a standing
    // window with its runs still `running` is an agent that keeps spending
    // tokens on a screen it may not look at, and 증보 3 D6 says the spend is
    // exactly what stops ("토큰 소진 0 — 크레딧이 토큰으로 새지 않음"). It is
    // written **after** the window rather than before because the window is the
    // fact and this is its consequence; a park that survived a failed window
    // insert would be an agent stopped by nothing.
    //
    // What the VM does is unchanged and that is the other half of D6:
    // `work_session.status` is not touched here, ADR-0140's state machine does
    // not move, and running-time billing (ADR-0164) continues. The machine stays
    // up because the person is using it.
    //
    // Lock order, and this call site's part of it: the session row is held from
    // `lock_attach_target_in_tx` above, the window row was written a statement
    // ago, and the park takes the run rows LAST
    // (`momo_agent::run::lock_driver_runs_in_tx` states the contract and why the
    // window must precede the lock). The one thing that must not move is the
    // window write above this line: a run locked before its window exists gives
    // a waiting transaction a snapshot without it, which is the whole hole.
    let parked = if control_window.is_some() {
        park_runs_for_control_window_in_tx(conn, workspace_id, session_id)
            .await
            .map_err(T3Error::from)?
    } else {
        Vec::new()
    };

    // LIVE-4: 정지 시각 lands on the login handoff card that asked for this.
    //
    // In the same transaction as the window, and for the same reason the park
    // is: the card is the surface a person is looking at while they decide, and
    // a card whose 정지 시각 arrives one commit later is a card that was wrong
    // for as long as anybody was reading it. Almost always zero rows — a
    // control window opened for any other purpose stamps nothing, and that is
    // what the `props.kind` clause is for.
    if let Some(window) = control_window.as_ref() {
        stamp_handoff_cards_in_tx(conn, workspace_id, window).await?;
    }

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
                    "mode": mode.as_db_label(),
                    "kind": AttachKind::Display.as_db_label(),
                    "issued_at": issued.issued_at_ms,
                    "expires_at": issued.expires_at_ms,
                    // The boundary fact, in the log that is entitled to names.
                    // 증보 3 D2 keeps what the person TYPES out of this row;
                    // that they took control, and when, is exactly what an
                    // audit log is for.
                    "control_window_opened": control_window.is_some(),
                    // …and which runs it stopped. The broadcast cannot carry
                    // this (D3 lets an agent learn 정지 시각, not who else was
                    // stopped), but the audit log is scoped to people entitled
                    // to names, and "why did 김인턴 go quiet at 14:03" is a
                    // question this row is the only possible answer to.
                    "runs_parked": parked
                        .iter()
                        .map(|run| run.run_id.to_string())
                        .collect::<Vec<_>>(),
                    // …and the setting it displaced (077). `null` means the
                    // session was already `owner_only`, so this window closed
                    // nothing. An operator asked 「내 세션이 왜 팀원에게 안
                    // 보이지」 has one row to read, and the paired
                    // `observation_restored` on the close says it came back.
                    "observation_closed_from": control_window
                        .as_ref()
                        .and_then(|window| window.prior_observation.clone()),
                }),
            ),
    )
    .await
    .map_err(T3Error::from)?;

    match control_window.as_ref() {
        // The boundary event. It replaces the observer envelope rather than
        // joining it, because a controller grant is not a 관전자: folding it into
        // the count would make 관전자 수 tick up at the moment watching becomes
        // impossible for the agent and irrelevant for the badge.
        Some(window) => {
            let payload = control_window_payload(
                &cent_channel(workspace_id, target.channel_id),
                window,
                true,
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
        // The same count-only envelope the PTY observer path emits, and the same
        // count: `active_observer_capability_count_in_tx` is kind-blind, so a
        // teammate who opened the screen shows up in 관전자 수 like anyone else. A
        // second envelope, or a second number, would be the new observer model this
        // goal was told not to invent.
        None => {
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
    }

    Ok(Ok(IssuedDisplayGrant {
        binding,
        control_started_at: control_window.map(|window| window.started_at_ms),
    }))
}

// ---------------------------------------------------------------------------
// return (close the control window)
// ---------------------------------------------------------------------------

/// `DELETE /v1/workspaces/{ws}/work-sessions/{session}/display-control`.
///
/// The 반환 half of ADR-0004 증보 3: the person hands the keyboard back and the
/// agent resumes. One of three closes, and the only one anybody performs on
/// purpose — the other two (a lapsed lease, an ended session) are the world
/// happening to a window nobody closed.
///
/// **Idempotent, and answers 200 either way.** A client that retries a return
/// because the first response was lost must not be told it failed; a client that
/// returns a window that already lapsed is describing the state it wanted. What
/// distinguishes the two is `closed` in the body, not the status code.
///
/// Owner-only, matching who could have opened it. A teammate cannot end
/// somebody else's intervention mid-password, which is the same reason the grant
/// is owner-only in the first place.
pub async fn return_control(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, session)): Path<(String, String)>,
) -> Result<Json<DisplayControlReturnResponse>, ApiError> {
    require_human(&principal, "display control requires a human bearer")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let session_id = path_uuid(&session, "invalid work session id")?;
    let member_id = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);

    let closed = settle(
        "display_attach.return_control",
        tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                return_control_in_tx(conn, workspace_id, member_id, via_token_id, session_id).await
            })
        })
        .await,
    )?;

    Ok(Json(match closed {
        Some(window) => DisplayControlReturnResponse {
            closed: true,
            control_started_at: Some(window.started_at_ms),
            control_ended_at: window.ended_at_ms,
        },
        None => DisplayControlReturnResponse {
            closed: false,
            control_started_at: None,
            control_ended_at: None,
        },
    }))
}

async fn return_control_in_tx(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    via_token_id: Option<Uuid>,
    session_id: Uuid,
) -> Rejectable<Option<ControlWindow>> {
    if active_workspace_role(conn, workspace_id, member_id)
        .await
        .map_err(|error| T3Error::from(momo_db::DbError::from(error)))?
        .is_none()
    {
        return Ok(Err(ApiError::forbidden("not an active workspace member")));
    }
    // The same lock the grant took, so a return cannot interleave with a
    // re-take and leave the agent blocked by a window nobody holds.
    let Some(target) = lock_attach_target_in_tx(conn, workspace_id, session_id).await? else {
        return Ok(Err(ApiError::not_found("work session not found")));
    };
    if target.owner_member_id != member_id {
        return Ok(Err(ApiError::forbidden(
            "only the session owner can return display control",
        )));
    }

    // Lapsed first, so a window whose producer already died closes with the
    // reason that is true (`expired`) rather than being relabelled `returned` by
    // whoever pressed the button afterwards. The ledger is the boundary event's
    // SoT and a wrong reason there is a wrong story about what happened.
    for lapsed in expire_lapsed_control_windows_in_tx(conn, workspace_id, session_id).await? {
        emit_control_closed_in_tx(conn, workspace_id, target.channel_id, None, None, &lapsed)
            .await?;
    }
    let Some(window) = close_control_window_in_tx(
        conn,
        workspace_id,
        session_id,
        ControlWindowEndReason::Returned,
    )
    .await?
    else {
        return Ok(Ok(None));
    };

    emit_control_closed_in_tx(
        conn,
        workspace_id,
        target.channel_id,
        Some(member_id),
        via_token_id,
        &window,
    )
    .await?;
    Ok(Ok(Some(window)))
}

/// Write the window's boundary facts onto the waiting login handoff cards **and
/// publish the rows that moved** (LIVE-4 freeze H1).
///
/// The two halves are one statement because a durable copy nobody is told about
/// is not a durable copy of anything a person can see: the timeline renders the
/// `props` it was handed, so a card stamped without a frame keeps saying
/// 「사람이 조작 중」 until a reload, and 재개 pressed on that stale card claims
/// 「개입 완료」 about a window that already lapsed. (The agent is safe either
/// way — the ledger refuses it — but a card that lies to a person is the failure
/// this repo names first.)
///
/// The frame is the existing `message.edited` (#1152 / #1130 전제①), which
/// carries the whole row including `props` at the message's own `seq` and which
/// both clients already merge in place. Nothing new is minted here.
///
/// It lives in this route layer, not in `momo-t3`, for the reason that crate's
/// manifest states: `momo-t3` owns no `outbox` SQL and no message spine
/// dependency, so the composition is the caller's — inside the caller's
/// transaction, exactly like the lifecycle broadcasts beside it.
async fn stamp_handoff_cards_in_tx(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    window: &ControlWindow,
) -> Result<(), T3Error> {
    let stamped = stamp_control_window_on_cards_in_tx(
        conn,
        workspace_id,
        momo_agent::approval::LOGIN_HANDOFF_PROPS_KIND,
        window,
    )
    .await
    .map_err(T3Error::from)?;
    for message_id in stamped.into_message_ids() {
        emit_message_edited_in_tx(&mut *conn, workspace_id, message_id)
            .await
            .map_err(T3Error::from)?;
    }
    Ok(())
}

/// Resume the parked runs, write the close audit row, and broadcast the 재개
/// boundary event.
///
/// Shared by every close path so that "the agent resumed" is one statement with
/// one shape, whoever caused it — the explicit 반환, the lapse detected by a
/// route, and the session that ended underneath the keyboard. `actor` is `None`
/// when nobody did — a lapsed lease and an ended session are events, not acts,
/// and naming a person in the audit row for them would record that somebody did
/// something they did not (`routes::shared::audit_via_token_id`'s rule).
///
/// The resume is **first**, and inside this function rather than at the three
/// call sites, for the reason the sentence above gives: 「사용자 개입 완료」 is
/// one fact, and a close path that forgot to resume would leave a run `paused`
/// with no window anywhere to explain it and no second event ever coming. Doing
/// it here means adding a fourth close path cannot forget.
///
/// The fourth author of this settlement is not a route at all — `momo-notifier`
/// closes a window whose producer died and nobody asked about. It composes the
/// same three steps from the same functions rather than calling this one,
/// because a binary that reached into `momo-server` would be the layering
/// inversion the approval sweep was careful not to make.
///
/// **Every caller must have closed its window before calling this.** All four
/// do, and it is a correctness condition rather than a tidiness one: the resume
/// judges "is another window still holding this run" against a snapshot taken
/// *after* it acquires the run lock, so a transaction that waited here sees the
/// winner's close only if the winner wrote it before taking the same lock. The
/// contract, and the two failures it prevents, are stated once in
/// `momo_agent::run::lock_driver_runs_in_tx`.
pub(crate) async fn emit_control_closed_in_tx(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    actor: Option<Uuid>,
    via_token_id: Option<Uuid>,
    window: &ControlWindow,
) -> Result<(), T3Error> {
    let resumed = resume_runs_from_control_window_in_tx(conn, workspace_id, window.work_session_id)
        .await
        .map_err(T3Error::from)?;

    // LIVE-4: 재개 시각 and the reason land on the card, here rather than at each
    // caller, for the same argument the resume above is written with — a close
    // path that forgets is a card that says 「사람이 조작 중」 forever. This
    // covers all four closes, including the lapse nobody performs.
    stamp_handoff_cards_in_tx(conn, workspace_id, window).await?;

    let mut entry = AuditEntry::new(workspace_id, AUDIT_ACTION_CONTROL_CLOSED)
        .target("work_session", window.work_session_id)
        .via_token(via_token_id)
        .with_schema(
            AUDIT_SCHEMA_CONTROL_CLOSED,
            json!({
                "grantee_member_id": window.grantee_member_id.to_string(),
                "started_at": window.started_at_ms,
                "ended_at": window.ended_at_ms,
                "end_reason": window.end_reason.map(|reason| reason.as_db_label()),
                "runs_resumed": resumed
                    .iter()
                    .map(|run| run.run_id.to_string())
                    .collect::<Vec<_>>(),
                // The other half of `observation_closed_from` (077). The write
                // itself already happened — it rides inside the close statement
                // so no close path can forget it — and this records that the
                // owner's setting is back and what it was.
                "observation_restored": window.prior_observation.clone(),
            }),
        );
    if let Some(actor) = actor {
        entry = entry.by(actor);
    }
    write_audit(conn, &entry).await.map_err(T3Error::from)?;

    let payload = control_window_payload(&cent_channel(workspace_id, channel_id), window, false);
    emit_outbox(
        &mut *conn,
        workspace_id,
        OutboxKind::Broadcast,
        "publish",
        &payload,
        Some(channel_id),
    )
    .await
    .map_err(|error| T3Error::from(momo_db::DbError::from(error)))?;
    Ok(())
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
                let Some(validated) = validated else {
                    return Ok(Ok(None));
                };
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

                // The lease renewal, and the reason the window outlives the
                // 60-second dial TTL its capability carries (076's header).
                // This call IS the liveness signal: a producer re-validating
                // every 30 seconds is a producer saying the stream is still up,
                // and a producer that stops saying it lets the window lapse and
                // the agent resume.
                //
                // Keyed by capability rather than session so a bearer for a
                // window that has since closed cannot hold a newer one open.
                let control_window = if validated.mode == AttachMode::Controller {
                    renew_control_window_lease_in_tx(conn, workspace_id, validated.capability_id)
                        .await?
                } else {
                    None
                };
                Ok(Ok(Some((validated, control_window))))
            })
        })
        .await,
    )?;

    let (validated, control_window) = validated.ok_or_else(invalid_capability)?;
    // ADR-0165 D4, stated to the only process that can honour it — and stated as
    // a conjunction, not as the grade alone.
    //
    // A controller bearer whose window is gone gets `false`, which is what makes
    // 반환 real: the person pressed 돌려주기, the window closed, and within one
    // re-validation period the producer is told to stop accepting input. If this
    // read `mode == Controller` on its own, returning control would be a row in
    // a table and a keyboard that still worked.
    let input_enabled = validated.mode == AttachMode::Controller && control_window.is_some();
    Ok(Json(DisplayAttachValidationResponse {
        work_session_id: validated.work_session_id.to_string(),
        display_id: validated.target_id,
        expires_at: validated.expires_at,
        mode: validated.mode.as_db_label(),
        input_enabled,
        // The producer's copy, minted on the SAME policy and the SAME session
        // subject the browser was served. Both ends of one media path therefore
        // allocate under one relay username, which is what makes a coturn log
        // line answer 「어느 세션이었나」 — the static credential this replaces
        // answered it for every session at once, i.e. not at all.
        //
        // Re-minted on every re-validation rather than pinned to the grant: the
        // producer calls this every 30 seconds, so its credential is renewed
        // faster than any TTL can expire it, and a media session outliving its
        // credential is a stream that dies on ALLOCATE refresh with no
        // user-visible cause.
        ice_servers: ice_servers_for(&state, validated.work_session_id),
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

    /// LIVE-3: the grade is spellable now. Who may hold it is a question for
    /// the transaction (owner only) and what it implies is a question for the
    /// control window — neither of them this function's.
    #[test]
    fn control_is_a_grade_this_route_can_be_asked_for() {
        assert_eq!(
            requested_display_mode(br#"{"mode":"controller"}"#).unwrap(),
            AttachMode::Controller
        );
    }

    /// The default did NOT move with the boundary. A body that says nothing
    /// asks to watch, because taking control stops the agent (ADR-0004 증보 3
    /// D3) and that is never what a client meant by silence.
    #[test]
    fn silence_still_means_observer() {
        for quiet in [
            &b""[..],
            &b"   \n"[..],
            &b"{}"[..],
            &br#"{"mode":null}"#[..],
        ] {
            assert_eq!(
                requested_display_mode(quiet).unwrap(),
                AttachMode::Observer,
                "the default is the grade that changes nothing"
            );
        }
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
            assert_eq!(error.message, "mode must be controller or observer");
        }
    }

    #[test]
    fn every_capability_rejection_is_the_same_401() {
        let error = invalid_capability();
        assert_eq!(error.status, StatusCode::UNAUTHORIZED);
        assert_eq!(error.message, "invalid display attach capability");
    }
}
