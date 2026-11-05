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
//! * **Bounded when it is not.** The skipped write still takes the row's lock, so one member's burst
//!   queues on one row and each queued request holds a pool connection. The wait is bounded
//!   ([`momo_messaging::ACTIVITY_LOCK_WAIT_SECS`], `lock_timeout`), and a beat that loses it — `55P03`,
//!   or the deadlock detector's `40P01` — answers **503 with `Retry-After`**, never 404/405 (those
//!   mean "this server has no such route" and make a client stop beating for good). Nothing was
//!   written, and the next beat is at most 20 s away.
//! * **No event, no outbox row.** A volatile signal for the notifier's next judgment, nothing else.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Extension;
use momo_auth::Principal;
use momo_db::DbError;
use momo_messaging::{touch_member_activity_in_tx, ActivityOutcome};

use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, require_human, settle_db, workspace_scope, DbRejectable,
};
use crate::AppState;

const HUMAN_ONLY: &str = "the activity heartbeat requires a human bearer";

/// `Retry-After` of the 503 a beat that lost its lock wait answers: shorter than the 20 s between
/// beats, so a client that honours it never skips a beat's worth of presence.
const LOCK_RACE_RETRY_SECONDS: u64 = 2;

/// `55P03` (the lock budget ran out) and `40P01` (the deadlock detector chose this transaction):
/// both mean "a lock race, nothing was written, ask again". The SQLSTATE comes back for the log.
fn lock_race(error: &DbError) -> Option<String> {
    match error {
        DbError::Sqlx(momo_db::sqlx::Error::Database(db)) => db
            .code()
            .filter(|code| matches!(code.as_ref(), "55P03" | "40P01"))
            .map(|code| code.into_owned()),
        _ => None,
    }
}

/// `204` when recorded; `403` for an agent or work-host bearer, a foreign workspace path, or a
/// caller that is not an active member of the workspace; `503` + `Retry-After` when the beat could
/// not get the member's row in time (nothing written).
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

    if let Err(error) = &outcome {
        if let Some(sqlstate) = lock_race(error) {
            tracing::warn!(
                %sqlstate,
                "an activity beat lost its lock wait; answering 503 (the client beats again)"
            );
            return Err(ApiError::busy(LOCK_RACE_RETRY_SECONDS));
        }
    }
    settle_db("presence.activity", outcome)?;
    Ok(StatusCode::NO_CONTENT)
}
