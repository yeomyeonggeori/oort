//! DM 닫기 (ADR-0177 증보 D7, #4227) — the member's own "I closed this DM" fact.
//!
//! ```text
//! PUT    /v1/workspaces/{ws}/channels/{ch}/closure   { "seenSeq": <integer >= 0> }  → 204
//! DELETE /v1/workspaces/{ws}/channels/{ch}/closure                                  → 204
//! ```
//!
//! Migration 146's `dm_closure` holds one row per (member, channel): a watermark, `closed_at_seq`.
//! Whether a DM is shown is the client's comparison of that watermark with the channel's
//! `latest_readable_seq` (both on the `GET read-state` rows, D8) — this route only records and drops
//! the watermark. **The owner is the bearer**: no request names a member, exactly like the read
//! cursor and the sidebar prefs.
//!
//! Decisions a reader will look for:
//!
//! * **The watermark is the client's `seenSeq`, clamped by the head, and only moves forward.** The
//!   store is `GREATEST(existing, LEAST(seenSeq, channel_seq.last_seq))` (see
//!   [`momo_messaging::dm_closure`]). A message that landed between the projection and this `PUT` is
//!   above `seenSeq` and stays visible; a retransmit changes nothing; a late retransmit cannot lower
//!   it. The same `PUT` twice is the same row and the same `204`.
//! * **Human-only, twice over.** An agent has no sidebar and no DMs to tidy. The *primary* gate is
//!   absence: this path is not in `momo_auth::required_agent_scope`, so the middleware answers 403 to
//!   any agent bearer before routing. `require_human` below is the second layer, and it runs
//!   **first** — before the body is parsed or a connection is taken — so it is also what refuses the
//!   non-agent, non-human principal (a signed work host) the scope table has no opinion about. Each
//!   layer has its own test: `required_agent_scope` is asserted `None` for both verbs, and
//!   `tests/dm_closure_gates.rs` drives these handlers directly, with no middleware in front, with an
//!   agent and a work-host principal.
//! * **One 404.** A public channel the caller is in, a DM they are not part of, an archived DM and an
//!   id that names nothing all answer the same 404, so a probe never learns whether another member's
//!   DM exists. The check and the write share one transaction, and the refusal returns before the
//!   first write.
//! * **400 before the transaction.** A missing or negative `seenSeq`, a non-integer, an unknown key,
//!   unreadable JSON and a missing content type are all 400 — Axum's own extractor would answer 422
//!   or 415 — and none of them costs a connection.
//! * **No event, no outbox row (D10).** The writing device already has the new state; other devices
//!   converge on their next read-state projection. A personal realtime channel would be a new
//!   Centrifugo channel kind (a security boundary) and needs its own ADR.
//!
//! Client: `packages/momo-core/src/lib/api.ts` (`ReadState.closedAtSeq`), and the device-ledger
//! migration and sidebar rule in #4228 / #4229.

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_messaging::{close_dm_in_tx, reopen_dm_in_tx, DmClosureOutcome};

use crate::dto::PutDmClosureRequestDto;
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, path_uuid, require_human, settle_db, workspace_scope, DbRejectable,
};
use crate::AppState;

const HUMAN_ONLY: &str = "dm closure requires a human bearer";
const NOT_FOUND: &str = "dm not found";

/// Every refusal of the closure body is a 400 with one message, whatever Axum's extractor called it
/// (422 for a missing or mistyped field, 415 for a missing content type, 400 only for bad syntax).
fn closure_body_error(_rejection: JsonRejection) -> ApiError {
    ApiError::bad_request("seenSeq must be a non-negative integer")
}

/// The validated watermark. A negative value is refused here, before any transaction opens; the
/// table's `CHECK (closed_at_seq >= 0)` is only the backstop.
fn seen_seq_of(body: Result<Json<PutDmClosureRequestDto>, JsonRejection>) -> Result<i64, ApiError> {
    let Json(request) = body.map_err(closure_body_error)?;
    if request.seen_seq < 0 {
        return Err(ApiError::bad_request(
            "seenSeq must be a non-negative integer",
        ));
    }
    Ok(request.seen_seq)
}

/// `PUT /v1/workspaces/{ws}/channels/{ch}/closure` — close the DM, having seen up to `seenSeq`.
pub async fn put(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel)): Path<(String, String)>,
    body: Result<Json<PutDmClosureRequestDto>, JsonRejection>,
) -> Result<StatusCode, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let channel_id = path_uuid(&channel, "invalid channel id")?;
    let seen_seq = seen_seq_of(body)?;
    let member_id = principal.member_id;

    let outcome: DbRejectable<()> = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            match close_dm_in_tx(conn, workspace_id, channel_id, member_id, seen_seq).await? {
                DmClosureOutcome::NotFound => Ok(Err(ApiError::not_found(NOT_FOUND))),
                DmClosureOutcome::Applied => Ok(Ok(())),
            }
        })
    })
    .await;

    settle_db("dm_closure.put", outcome)?;
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /v1/workspaces/{ws}/channels/{ch}/closure` — reopen the DM (drop the caller's own row).
/// `204` whether or not a row existed; `404` exactly where the `PUT` is.
pub async fn delete(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, channel)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let channel_id = path_uuid(&channel, "invalid channel id")?;
    let member_id = principal.member_id;

    let outcome: DbRejectable<()> = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            match reopen_dm_in_tx(conn, workspace_id, channel_id, member_id).await? {
                DmClosureOutcome::NotFound => Ok(Err(ApiError::not_found(NOT_FOUND))),
                DmClosureOutcome::Applied => Ok(Ok(())),
            }
        })
    })
    .await;

    settle_db("dm_closure.delete", outcome)?;
    Ok(StatusCode::NO_CONTENT)
}
