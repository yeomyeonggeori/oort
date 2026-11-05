//! Activity heartbeat — `PUT /v1/workspaces/{ws}/presence/activity` (ADR-0206 D4, #4497).
//!
//! A web or desktop client that is **in front and was used in the last five minutes** beats here
//! at most every 20 s; the phone never does. The push judgment's tail reads the stamp as "my desktop
//! is active" for 30 s and holds the caller's phone pushes for their `phoneDelaySecs`
//! (`momo_push::refine_targets`). A client that never sends it keeps today's behavior.
//!
//! Decisions a reader will look for:
//!
//! * **The owner is the bearer.** The request carries no body and no member id, so no caller can
//!   stamp someone else, and there is **no read API**: nobody can ask whether another member is
//!   active (ADR-0206 보안·경계 요약). A forged beat only delays the forger's own phone push, once,
//!   by at most their `phoneDelaySecs` (≤ 300 s).
//! * **Human-only, twice over.** An agent has no desktop and no phone to spare. The primary gate is
//!   absence: this path is not in `momo_auth::required_agent_scope`, so the middleware answers 403 to
//!   any agent bearer before routing. `require_human` is the second layer and runs **first**, so it
//!   also refuses a signed work host the scope table has no opinion about.
//! * **Cheap.** The write is skipped when the stored stamp is under five seconds old
//!   ([`momo_messaging::ACTIVITY_MIN_REFRESH_SECS`]), the same cap as the channel-viewing beat.
//! * **No event, no outbox row.** A volatile signal for the notifier's next judgment, nothing else.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Extension;
use momo_auth::Principal;
use momo_messaging::{touch_member_activity_in_tx, ActivityOutcome};

use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, require_human, settle_db, workspace_scope, DbRejectable,
};
use crate::AppState;

const HUMAN_ONLY: &str = "the activity heartbeat requires a human bearer";

/// `204` when recorded; `403` for an agent or work-host bearer, a foreign workspace path, or a
/// caller that is not an active member of the workspace.
pub async fn touch(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
) -> Result<StatusCode, ApiError> {
    require_human(&principal, HUMAN_ONLY)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;

    let outcome: DbRejectable<()> = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            match touch_member_activity_in_tx(conn, workspace_id, principal.member_id).await? {
                ActivityOutcome::NotAnActiveMember => Ok(Err(ApiError::forbidden(
                    "not an active member of this workspace",
                ))),
                ActivityOutcome::Recorded => Ok(Ok(())),
            }
        })
    })
    .await;

    settle_db("presence.activity", outcome)?;
    Ok(StatusCode::NO_CONTENT)
}
