//! The owner's **stop** for a running work session — N4a (#3628), ADR-0198 D4 /
//! 표 N4, ADR-0188 D3, ADR-0146 D-8 (「꺼짐 쪽은 서명이 필요 없다」).
//!
//! ```text
//! POST /v1/workspaces/{ws}/work-sessions/{session}/kill      (human bearer, no body)
//! ```
//!
//! A phone or desktop that wants the session on **its owner's own Mac** to
//! stop now asks here. The route writes one `kill` `work_control` row in the
//! same transaction as the checks that justify it; the host (`momo-workd`)
//! reads its ledger by polling `pending-controls`, ends the whole process tree
//! (`SessionTable::kill`, workd invariant 15) and reports the session `ended`.
//! It is **not** `PATCH …/work-sessions/{id} {status: ended}`: that only
//! settles the ledger and does not reach the Mac (see "PATCH ended" below).
//!
//! The message send path (`momo-messaging`: `channel_seq` + message + outbox)
//! is not touched: no thread message, no outbox row from this route (the row is
//! written `dispatched`, as the owner's spawn is; the session's `ended` envelope
//! comes from the host when it has really stopped).
//!
//! ## Rules
//!
//! * **Human bearer only.** An agent bearer never reaches it (absent from
//!   `momo_auth::required_agent_scope`, so the auth layer closes it; the handler
//!   refuses anything but a human, too); a signed host is not on the allow-list.
//!   An agent's own off switch stays `POST /work-controls` (ADR-0188 D3).
//! * **Who.** The session's owner, on a `scope='member'` host the same person
//!   owns (ADR-0188 D3). A teammate gets 403 `kill_owner_only`. A missing
//!   session is 404 and a session of somebody else is 403 — the convention of
//!   `PATCH …/work-sessions/{id}` (session ids are unguessable uuids; the board
//!   already shows shared sessions to the room).
//! * **Unsigned.** `kill` is the one control that only takes work away; it
//!   needs no device signature so a lost device can still stop things
//!   (`momo-workd::human_trust::requires_signature`), and it works with the
//!   human-control flag off.
//! * **Live sessions only, idempotent.** `running` and `idle` (an idle session
//!   still has its agent process). A session that is already `ended` answers
//!   200 with nothing new written. A kill still waiting for the Mac answers
//!   200 with that control (`replayed`), so any number of taps makes one row;
//!   the session row lock serializes concurrent requests. Any other state
//!   (`orphaned`) is 409 `work_session_not_running`.
//! * **Offline Mac.** Not refused: the row waits dispatched and runs when the
//!   Mac polls again; `hostOnline` tells the client which it is.
//! * **The control window does not hold it back.** The poll withholds
//!   controls while a person holds the session's screen; a kill whose
//!   requester is the session's owner and the member host's owner is exempt
//!   (`pending_controls_for_host_in_tx` checks all three in SQL).
//!
//! ## PATCH ended — what it does to a Mac session
//!
//! `PATCH …/work-sessions/{id} {status:"ended"}` ends the **ledger row** (card,
//! billing, permission requests) and nothing more: no `work_control` is made
//! and the host is not told. `momo-workd` learns of it only by side effect:
//! its event/idle reports to an ended session get 409 (not 401/403/404), which
//! it logs and drops, and only its next idle→running transition (409, not
//! transient) makes it stop with `End::Gone`. A turn already running goes on.
//! So `PATCH ended` does **not** reliably stop a Mac session; this route does.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use momo_auth::{Principal, PrincipalKind};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{sqlx, PgConnection};
use momo_t3::work_control::{
    insert_work_control_in_tx, lock_work_control_in_tx, target_work_host_in_tx, NewWorkControl,
    WorkControlRow, HOST_SCOPE_MEMBER, KIND_KILL, STATUS_DISPATCHED,
};
use momo_t3::{lock_work_session_detail_in_tx, T3Error};
use serde_json::json;
use uuid::Uuid;

use crate::dto::WorkKillResponse;
use crate::error::ApiError;
use crate::routes::shared::{
    audit_via_token_id, local_session_control_refusal, path_uuid, settle, tenant_tx,
    workspace_scope, Rejectable,
};
use crate::routes::work_controls::control_dto;
use crate::AppState;

/// Stable machine codes.
pub const CODE_NOT_HUMAN: &str = "kill_not_human";
pub const CODE_OWNER_ONLY: &str = "kill_owner_only";
pub const CODE_MEMBER_HOST_ONLY: &str = "kill_member_host_only";
pub const CODE_SESSION_NOT_RUNNING: &str = "work_session_not_running";
pub const CODE_HOST_REVOKED: &str = "work_host_revoked";

const AUDIT_KILL_REQUESTED: &str = "work.kill.requested";
const SCHEMA_KILL_REQUESTED: &str = "momo.work_kill.requested.v1";

/// The principal check, apart from the handler so a test can reach it without
/// the auth layer (which already closes the route to agents).
fn ensure_human(principal: &Principal) -> Result<(), ApiError> {
    if principal.kind == PrincipalKind::Human {
        Ok(())
    } else {
        Err(ApiError::coded(
            StatusCode::FORBIDDEN,
            CODE_NOT_HUMAN,
            "stopping a work session requires its owner's human bearer",
        ))
    }
}

/// `POST /v1/workspaces/{ws}/work-sessions/{session}/kill` → 201 for a new
/// kill, 200 for a retry or an already ended session.
pub async fn kill(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, session)): Path<(String, String)>,
) -> Result<(StatusCode, Json<WorkKillResponse>), ApiError> {
    ensure_human(&principal)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let session_id = path_uuid(&session, "invalid work session id")?;
    let member_id = principal.member_id;
    let via_token_id = audit_via_token_id(&principal);

    let response = settle(
        "work_kill.kill",
        tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                kill_in_tx(conn, workspace_id, session_id, member_id, via_token_id).await
            })
        })
        .await,
    )?;
    let status = if response.replayed {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    Ok((status, Json(response)))
}

/// The newest `kill` **this person** asked for on the session (an agent's own
/// off switch is a different row and must neither answer nor block their tap); `only_waiting` limits it to one the Mac
/// has not yet answered (`approved`/`dispatched`).
async fn latest_kill_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
    member_id: Uuid,
    only_waiting: bool,
) -> Result<Option<WorkControlRow>, T3Error> {
    let id: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM work_control \
          WHERE workspace_id = $1 AND session_id = $2 AND kind = 'kill' AND requester_member_id = $3 \
            AND (NOT $4 OR status IN ('approved', 'dispatched')) \
          ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .bind(workspace_id)
    .bind(session_id)
    .bind(member_id)
    .bind(only_waiting)
    .fetch_optional(&mut *conn)
    .await
    .map_err(momo_db::DbError::from)?;
    match id {
        Some(id) => lock_work_control_in_tx(conn, workspace_id, id).await,
        None => Ok(None),
    }
}

async fn kill_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
    member_id: Uuid,
    via_token_id: Option<Uuid>,
) -> Rejectable<WorkKillResponse> {
    // The session row lock serializes two taps of the same button.
    let Some((session, _)) = lock_work_session_detail_in_tx(conn, workspace_id, session_id).await?
    else {
        return Ok(Err(ApiError::not_found("work session not found")));
    };
    // ADR-0188 D3: the session's owner, and nobody else.
    if session.member_id != member_id {
        return Ok(Err(ApiError::coded(
            StatusCode::FORBIDDEN,
            CODE_OWNER_ONLY,
            "only the session owner can stop it",
        )));
    }
    // A shared local pane takes no control from anyone (ADR-0190 D4), answered
    // after the owner check as `PATCH …/work-sessions/{id}` does.
    if session.origin == "local_pty" {
        return Ok(Err(local_session_control_refusal()));
    }
    // Already over: nothing to stop and nothing to write.
    if session.status == "ended" {
        let control = latest_kill_in_tx(conn, workspace_id, session_id, member_id, false).await?;
        return Ok(Ok(WorkKillResponse {
            work_control: control.map(control_dto),
            session_status: session.status,
            host_online: false,
            replayed: true,
        }));
    }
    if !matches!(session.status.as_str(), "running" | "idle") {
        return Ok(Err(ApiError::coded(
            StatusCode::CONFLICT,
            CODE_SESSION_NOT_RUNNING,
            "the work session is not running",
        )));
    }
    let Some(host) = target_work_host_in_tx(conn, workspace_id, session.host_id).await? else {
        return Ok(Err(ApiError::coded(
            StatusCode::CONFLICT,
            CODE_HOST_REVOKED,
            "the session's work host is revoked",
        )));
    };
    if host.scope != HOST_SCOPE_MEMBER || host.owner_member_id != member_id {
        return Ok(Err(ApiError::coded(
            StatusCode::FORBIDDEN,
            if host.scope != HOST_SCOPE_MEMBER {
                CODE_MEMBER_HOST_ONLY
            } else {
                CODE_OWNER_ONLY
            },
            "only the owner can stop a session on their own member work host",
        )));
    }
    // A kill still waiting for the Mac is the answer to every further tap.
    if let Some(waiting) =
        latest_kill_in_tx(conn, workspace_id, session_id, member_id, true).await?
    {
        return Ok(Ok(WorkKillResponse {
            work_control: Some(control_dto(waiting)),
            session_status: session.status,
            host_online: host.online,
            replayed: true,
        }));
    }

    // ---- writes ------------------------------------------------------------
    let control = insert_work_control_in_tx(
        conn,
        workspace_id,
        NewWorkControl {
            channel_id: session.channel_id,
            requester_member_id: member_id,
            target_host_id: session.host_id,
            session_id: Some(session_id),
            kind: KIND_KILL.to_string(),
            payload: json!({}),
            // Dispatched at once, like the owner's spawn: the host polls its
            // ledger and nobody needs a broadcast about a kill. The host row
            // was read FOR SHARE above, so a revoke either landed first (409)
            // or waits for this commit.
            status: STATUS_DISPATCHED.to_string(),
            human: None,
        },
    )
    .await?;
    write_audit(
        conn,
        &AuditEntry::new(workspace_id, AUDIT_KILL_REQUESTED)
            .by(member_id)
            .about(member_id)
            .target("work_control", control.id)
            .via_token(via_token_id)
            .with_schema(
                SCHEMA_KILL_REQUESTED,
                json!({
                    "work_session_id": session_id.to_string(),
                    "host_id": session.host_id.to_string(),
                    "control_id": control.id.to_string(),
                    "control_status": control.status,
                    "host_online": host.online,
                }),
            ),
    )
    .await
    .map_err(T3Error::from)?;

    Ok(Ok(WorkKillResponse {
        work_control: Some(control_dto(control)),
        session_status: session.status,
        host_online: host.online,
        replayed: false,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn principal(kind: PrincipalKind) -> Principal {
        Principal {
            kind,
            member_id: Uuid::from_u128(1),
            workspace_id: Uuid::from_u128(2),
            token_id: None,
            scopes: Vec::new(),
        }
    }

    #[test]
    fn only_a_human_bearer_passes() {
        assert!(ensure_human(&principal(PrincipalKind::Human)).is_ok());
        for kind in [PrincipalKind::Agent, PrincipalKind::WorkHost] {
            let error = ensure_human(&principal(kind)).expect_err("not a person");
            assert_eq!(error.status, StatusCode::FORBIDDEN);
            assert_eq!(error.code, Some(CODE_NOT_HUMAN));
        }
    }

    #[test]
    fn the_route_is_neither_an_agent_route_nor_signable_by_a_host() {
        let path = format!(
            "/v1/workspaces/{}/work-sessions/{}/kill",
            Uuid::from_u128(2),
            Uuid::from_u128(4)
        );
        assert_eq!(momo_auth::required_agent_scope("POST", &path), None);
        assert!(!crate::work_host_auth::is_allowed_signed_path(
            &axum::http::Method::POST,
            &path
        ));
    }
}
