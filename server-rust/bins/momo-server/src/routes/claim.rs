//! `POST /v1/claim` — first-owner password setup (ADR-0166 / T-1).
//!
//! ```text
//! POST /v1/claim   (public — no bearer, per-IP rate limited)
//!   → 200 { accessToken, refreshToken, member, realtimeWebSocketUrl }
//! ```
//!
//! ## Why it is mounted outside the auth middleware
//!
//! By construction: the caller holds a one-time claim token and nothing else.
//! Putting it behind `require_principal` would make it permanently unreachable —
//! the same measured reason `POST /v1/join` is public (`join.rs`, `lib.rs`
//! around the join mount).
//!
//! Being public is what makes the two guards below non-negotiable:
//!
//! * **the tenant is resolved by an EXECUTE-only definer function**, never by a
//!   client-supplied workspace id. `momo_join_private.owner_claim_workspace_id`
//!   (migration 078) is granted to `momo_app` alone; it returns one uuid and no
//!   tenant row, and everything after it runs inside
//!   `momo_db::with_tenant_tx` under that workspace's scope.
//! * **the route is rate limited per client IP** ([`crate::rate_limit`]), on its
//!   own bucket so join traffic cannot starve first-owner setup.
//!
//! ## This route owns no SQL
//!
//! Token lookup and consume live in `momo_auth::owner_claim`. Session rows are
//! `issue_and_record_session`. The audit row is `momo_db::audit::write_audit`.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use momo_auth::{
    consume_claim_in_tx, normalized_claim_password, normalized_claim_token,
    resolve_claim_workspace, ClaimMutation, ClaimSpecInvalid,
};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{with_tenant_tx, DbError};

use crate::dto::{ClaimRequest, LoginResponse, MemberDto};
use crate::error::{db_error, ApiError};
use crate::routes::auth_routes::{base_scopes, issue_and_record_session};
use crate::AppState;

fn spec_error(error: ClaimSpecInvalid) -> ApiError {
    ApiError::bad_request(error.to_string())
}

fn mutation_error(mutation: ClaimMutation) -> ApiError {
    match mutation {
        ClaimMutation::Applied(_) => {
            ApiError::internal("claim.unexpected_applied", "applied mapped as error")
        }
        ClaimMutation::NotFound => ApiError::not_found("claim token is invalid"),
        ClaimMutation::Expired => ApiError::new(StatusCode::GONE, "claim token has expired"),
        ClaimMutation::AlreadyUsed => {
            ApiError::new(StatusCode::CONFLICT, "claim token has already been used")
        }
        ClaimMutation::PasswordPresent => {
            ApiError::new(StatusCode::CONFLICT, "owner already has a password")
        }
    }
}

pub async fn claim(
    State(state): State<AppState>,
    Json(request): Json<ClaimRequest>,
) -> Result<Json<LoginResponse>, ApiError> {
    let token = normalized_claim_token(&request.token).map_err(spec_error)?;
    let password = normalized_claim_password(&request.password).map_err(spec_error)?;

    let mut conn = state
        .pool
        .acquire()
        .await
        .map_err(|error| ApiError::internal("claim.acquire", error))?;
    let resolved = resolve_claim_workspace(&mut conn, &token)
        .await
        .map_err(|error| ApiError::internal("claim.resolve_workspace", error))?;
    drop(conn);

    let Some(workspace_id) = resolved else {
        return Err(mutation_error(ClaimMutation::NotFound));
    };

    let mutation = with_tenant_tx(&state.pool, workspace_id, {
        let token = token.clone();
        let password = password.clone();
        move |conn| {
            Box::pin(async move {
                let mutation = consume_claim_in_tx(conn, workspace_id, &token, &password).await?;
                if let ClaimMutation::Applied(ref outcome) = mutation {
                    write_audit(
                        conn,
                        &AuditEntry::new(workspace_id, "owner.claim")
                            .by(outcome.member_id)
                            .target("owner_claim", outcome.claim_id)
                            .via_token(None)
                            .with_schema("momo.owner.claim.v1", serde_json::json!({})),
                    )
                    .await?;
                }
                Ok::<_, DbError>(mutation)
            })
        }
    })
    .await
    .map_err(|error| db_error("claim.consume", error))?;

    let ClaimMutation::Applied(outcome) = mutation else {
        return Err(mutation_error(mutation));
    };

    let (access, refresh) = issue_and_record_session(
        &state,
        workspace_id,
        outcome.member_id,
        base_scopes(),
        "claim.session",
    )
    .await?;

    Ok(Json(LoginResponse {
        access_token: access.token,
        refresh_token: refresh.token,
        member: MemberDto {
            id: outcome.member_id.to_string(),
            workspace_id: outcome.workspace_id.to_string(),
            kind: outcome.kind,
            display_name: outcome.display_name,
            handle: outcome.handle,
        },
        realtime_web_socket_url: state.realtime_ws_url.to_string(),
    }))
}
