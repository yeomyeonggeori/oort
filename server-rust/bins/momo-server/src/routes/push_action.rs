//! `POST /v1/auth/push-action-token` — mint the lock screen's decision token
//! (#3927, ADR-0204 D6).
//!
//! Protected: the caller presents its ordinary access token, and gets back a
//! second, narrower one to park in the app-only keychain group (NOT the group the
//! notification extension reads). A native handler woken by a lock-screen
//! [승인] / [거절] press sends it as the bearer of exactly one request,
//! `POST /v1/workspaces/{ws}/approvals/{approval}/decision` — see
//! [`momo_auth::push_action_token`] for what makes it narrow. The decision route
//! keeps every check it has; this token only replaces the bearer.
//!
//! Who may ask: a human access bearer, nothing else.
//!   * a push-action token is refused by the middleware's route list, so it
//!     cannot mint a successor (no self-renewal — the app is the only party that
//!     can extend the handler's access);
//!   * a push-fetch token is refused by ITS route list, so the extension's token
//!     cannot mint this one either;
//!   * an agent bearer is not on the agent route list;
//!   * a work-host signature is not on the signed-path list.
//!
//! The row is recorded as a `session` row in the CALLER's lineage, under the
//! label `push_action`; the middleware accepts it only while that lineage can
//! still rotate (`momo_auth::push_action_session_live`). The mint takes the same
//! single-row `FOR SHARE` lock a push registration takes, so a logout that
//! commits first is seen (401) instead of being outlived by a token minted a
//! moment after it.

use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use momo_auth::{
    live_push_action_count, lock_push_action_mints_in_tx, lock_session_for_registration,
    record_session_token, sign_push_action, Principal, PrincipalKind, RegistrationSession,
    MAX_LIVE_PUSH_ACTION_PER_LINEAGE, SCOPE_PUSH_ACTION, SESSION_LABEL_PUSH_ACTION,
};
use momo_db::{with_tenant_tx, DbError};

use crate::dto::PushActionTokenResponse;
use crate::error::ApiError;
use crate::routes::webhooks::no_store;
use crate::AppState;

/// What `with_tenant_tx` decides inside the transaction.
enum Minted {
    Recorded,
    Ended,
    NoLineage,
    TooMany,
}

pub async fn issue(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> Result<Response, ApiError> {
    if principal.kind != PrincipalKind::Human {
        return Err(ApiError::forbidden(
            "only a signed-in person can mint a push-action token",
        ));
    }
    let caller_token_id = principal
        .token_id
        .ok_or_else(|| ApiError::forbidden("credential cannot be bound to a session"))?;

    let workspace_id = principal.workspace_id;
    let member_id = principal.member_id;
    let issued = sign_push_action(member_id, workspace_id, &state.jwt_secret)
        .map_err(|error| ApiError::internal("auth.push_action.sign", error))?;

    let raw = issued.token.clone();
    let expires_at = issued.expires_at;
    let minted = with_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            let lineage =
                match lock_session_for_registration(conn, workspace_id, member_id, caller_token_id)
                    .await
                    .map_err(DbError::from)?
                {
                    RegistrationSession::Live(lineage) => lineage,
                    RegistrationSession::Ended | RegistrationSession::NotASession => {
                        return Ok(Minted::Ended)
                    }
                };
            // A pre-088 session has no lineage to derive the token's life
            // from; its next rotation gives it one, and the app asks again.
            let Some(lineage) = lineage else {
                return Ok(Minted::NoLineage);
            };
            // Count-then-insert must be atomic per lineage, or parallel mints
            // from a leaked access token walk straight past the cap.
            lock_push_action_mints_in_tx(conn, lineage)
                .await
                .map_err(DbError::from)?;
            if live_push_action_count(conn, workspace_id, member_id, lineage)
                .await
                .map_err(DbError::from)?
                >= MAX_LIVE_PUSH_ACTION_PER_LINEAGE
            {
                return Ok(Minted::TooMany);
            }
            record_session_token(
                conn,
                workspace_id,
                member_id,
                &raw,
                SESSION_LABEL_PUSH_ACTION,
                &[SCOPE_PUSH_ACTION.to_string()],
                expires_at,
                lineage,
            )
            .await
            .map_err(DbError::from)?;
            Ok::<Minted, DbError>(Minted::Recorded)
        })
    })
    .await
    .map_err(|error| ApiError::internal("auth.push_action.record", error))?;

    match minted {
        // A bearer credential in a body is never cached (RFC 6749 §5.1's rule for
        // token responses): `no-store` on the one answer that carries it.
        Minted::Recorded => Ok(no_store(
            Json(PushActionTokenResponse {
                token: issued.token,
                expires_at_ms: issued.expires_at * 1000,
                ttl_seconds: momo_auth::PUSH_ACTION_TTL_SECONDS,
                workspace_id: workspace_id.to_string(),
            })
            .into_response(),
        )),
        Minted::Ended => Err(ApiError::unauthorized("token has been revoked")),
        Minted::TooMany => Err(ApiError::new(
            axum::http::StatusCode::TOO_MANY_REQUESTS,
            "too many live push-action tokens for this session; use the one already minted",
        )),
        Minted::NoLineage => Err(ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "session has no lineage yet; refresh and ask again",
        )),
    }
}
