//! `POST /v1/auth/login` — the one auth route this batch serves.
//!
//! Parity with Swift `AuthRoutes.login` (`AuthRoutes.swift:51-132`):
//!   * same path, same request/response bodies (`dto::LoginRequest`/`LoginResponse`);
//!   * the workspace defaults to the seeded demo workspace when the request omits
//!     it (single-tenant v0 convenience);
//!   * the password is verified **in Postgres** by `momo_password_verify`
//!     (pgcrypto/bcrypt, `005_auth_password_hash.sql`) — the same hashes work
//!     against either server;
//!   * suspended → 403, everything else that fails → 401 `invalid credentials`
//!     (one bucket, so the response cannot enumerate accounts);
//!   * on success an access (15m) + refresh (30d) HS256 pair is minted with the
//!     shared `momo-auth` claims and coarse v0 scopes;
//!   * **both halves are recorded in the `token` table** (`kind='session'`,
//!     `label='access'|'refresh'`, only `sha256(jwt)` stored) — Swift
//!     `recordSessionTokens` (`AuthRoutes.swift:412-426`). This is what makes the
//!     middleware's MOMO-300 revocation check meaningful: minting without a row
//!     would turn every subsequent request into a 401 `unknown token`.
//!
//! Deviations (deliberate, see PR body): no platform-admin scope elevation and
//! no privileged-session sweep on login. Absent elevation the issued scopes are
//! strictly the narrower set, so the deviation fails closed.

use axum::extract::State;
use axum::Json;
use momo_auth::{
    record_session_token, sign_access, sign_refresh, SESSION_LABEL_ACCESS, SESSION_LABEL_REFRESH,
};
use momo_db::{with_tenant_tx, DbError};
use momo_messaging::{verify_password_login, PasswordLogin};
use uuid::Uuid;

use crate::dto::{LoginRequest, LoginResponse, MemberDto};
use crate::error::{db_error, ApiError};
use crate::AppState;

/// The workspace seeded by `server/Migrations/002_seed.sql`, used when a login
/// omits an explicit workspace (Swift `AuthRoutes.demoWorkspaceID`).
pub const DEMO_WORKSPACE_ID: Uuid = Uuid::from_u128(0x0000_0000_0000_7000_8000_0000_0000_0001);

/// Coarse v0 scopes (Swift `AuthRoutes.login`). A real implementation derives
/// these from membership/role (L4 §7.2).
fn base_scopes() -> Vec<String> {
    vec!["messages:write".to_string(), "messages:read".to_string()]
}

/// The freshly minted pair, moved into the recording transaction. Holds raw
/// tokens only long enough to hash them inside Postgres — nothing here is logged.
struct SessionTokens {
    member_id: Uuid,
    scopes: Vec<String>,
    access_token: String,
    access_expires_at: i64,
    refresh_token: String,
    refresh_expires_at: i64,
}

pub async fn login(
    State(state): State<AppState>,
    Json(request): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, ApiError> {
    let workspace_id = request
        .workspace
        .as_deref()
        .and_then(|raw| Uuid::parse_str(raw).ok())
        .unwrap_or(DEMO_WORKSPACE_ID);

    // The tenant transaction is the sole RLS GUC seam; the lookup is therefore
    // scoped to the workspace being logged into (invariant #6).
    let email = request.email.clone();
    let password = request.password.clone();
    let resolution = with_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move { verify_password_login(conn, &email, &password).await })
    })
    .await
    .map_err(|error| db_error("auth.login", error))?;

    let member = match resolution {
        PasswordLogin::Suspended => return Err(ApiError::forbidden("member is suspended")),
        PasswordLogin::Invalid => return Err(ApiError::unauthorized("invalid credentials")),
        PasswordLogin::Active(member) => member,
    };

    let scopes = base_scopes();
    let access = sign_access(member.id, workspace_id, &scopes, &state.jwt_secret)
        .map_err(|error| ApiError::internal("auth.login.sign_access", error))?;
    let refresh = sign_refresh(member.id, workspace_id, &scopes, &state.jwt_secret)
        .map_err(|error| ApiError::internal("auth.login.sign_refresh", error))?;

    // Record both halves so they can be revoked later (MOMO-300). One
    // transaction rather than Swift's two connections: a session whose access
    // row committed but whose refresh row did not would be unrevocable by a
    // single logout, so the pair is atomic here.
    let session = SessionTokens {
        member_id: member.id,
        scopes: scopes.clone(),
        access_token: access.token.clone(),
        access_expires_at: access.expires_at,
        refresh_token: refresh.token.clone(),
        refresh_expires_at: refresh.expires_at,
    };
    with_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            record_session_token(
                conn,
                workspace_id,
                session.member_id,
                &session.access_token,
                SESSION_LABEL_ACCESS,
                &session.scopes,
                session.access_expires_at,
            )
            .await?;
            record_session_token(
                conn,
                workspace_id,
                session.member_id,
                &session.refresh_token,
                SESSION_LABEL_REFRESH,
                &session.scopes,
                session.refresh_expires_at,
            )
            .await?;
            Ok::<(), DbError>(())
        })
    })
    .await
    .map_err(|error| db_error("auth.login.record_session", error))?;

    Ok(Json(LoginResponse {
        access_token: access.token,
        refresh_token: refresh.token,
        member: MemberDto {
            id: member.id.to_string(),
            workspace_id: member.workspace_id.to_string(),
            kind: member.kind.as_db_label().to_string(),
            display_name: member.display_name,
            handle: member.handle,
        },
        realtime_web_socket_url: state.realtime_ws_url.to_string(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demo_workspace_matches_the_seed_migration() {
        assert_eq!(
            DEMO_WORKSPACE_ID.to_string(),
            "00000000-0000-7000-8000-000000000001",
            "must equal Swift AuthRoutes.demoWorkspaceID / 002_seed.sql"
        );
    }

    #[test]
    fn v0_scopes_match_swift() {
        assert_eq!(base_scopes(), vec!["messages:write", "messages:read"]);
    }
}
