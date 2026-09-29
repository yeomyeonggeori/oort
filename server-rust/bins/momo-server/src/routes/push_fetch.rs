//! `POST /v1/auth/push-fetch-token` — mint the notification extension's token
//! (#3121, ADR-0188 §8.7).
//!
//! Protected: the caller presents its ordinary access token, and gets back a
//! second, narrower one to park in the keychain group the extension can read
//! (see [`momo_auth::push_fetch_token`] for what makes it narrow). The full
//! access token and the refresh token then never need to leave the app's own
//! group.
//!
//! Who may ask: a human access bearer, nothing else.
//!   * a push-fetch token is refused by the middleware's route list, so the
//!     extension's own token cannot mint a successor (no self-renewal — the app
//!     is the only party that can extend the extension's access);
//!   * an agent bearer is not on the agent route list;
//!   * a work-host signature is not on the signed-path list.
//!
//! The row is recorded as a `session` row in the CALLER's lineage, under the
//! label `push_fetch`; the middleware accepts it only while that lineage can
//! still rotate (`momo_auth::push_fetch_session_live`). The mint takes the same single-row `FOR SHARE` lock a push
//! registration takes, so a logout that commits first is seen (401) instead of
//! being outlived by a token minted a moment after it.

use axum::extract::State;
use axum::{Extension, Json};
use momo_auth::{
    live_push_fetch_count, lock_session_for_registration, record_session_token, sign_push_fetch,
    Principal, PrincipalKind, RegistrationSession, MAX_LIVE_PUSH_FETCH_PER_LINEAGE,
    SCOPE_PUSH_FETCH, SESSION_LABEL_PUSH_FETCH,
};
use momo_db::{with_tenant_tx, DbError};

use crate::dto::PushFetchTokenResponse;
use crate::error::ApiError;
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
) -> Result<Json<PushFetchTokenResponse>, ApiError> {
    if principal.kind != PrincipalKind::Human {
        return Err(ApiError::forbidden(
            "only a signed-in person can mint a push-fetch token",
        ));
    }
    let caller_token_id = principal
        .token_id
        .ok_or_else(|| ApiError::forbidden("credential cannot be bound to a session"))?;

    let workspace_id = principal.workspace_id;
    let member_id = principal.member_id;
    let issued = sign_push_fetch(member_id, workspace_id, &state.jwt_secret)
        .map_err(|error| ApiError::internal("auth.push_fetch.sign", error))?;

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
            if live_push_fetch_count(conn, workspace_id, member_id, lineage)
                .await
                .map_err(DbError::from)?
                >= MAX_LIVE_PUSH_FETCH_PER_LINEAGE
            {
                return Ok(Minted::TooMany);
            }
            record_session_token(
                conn,
                workspace_id,
                member_id,
                &raw,
                SESSION_LABEL_PUSH_FETCH,
                &[SCOPE_PUSH_FETCH.to_string()],
                expires_at,
                lineage,
            )
            .await
            .map_err(DbError::from)?;
            Ok::<Minted, DbError>(Minted::Recorded)
        })
    })
    .await
    .map_err(|error| ApiError::internal("auth.push_fetch.record", error))?;

    match minted {
        Minted::Recorded => Ok(Json(PushFetchTokenResponse {
            token: issued.token,
            expires_at_ms: issued.expires_at * 1000,
            ttl_seconds: momo_auth::PUSH_FETCH_TTL_SECONDS,
            workspace_id: workspace_id.to_string(),
        })),
        Minted::Ended => Err(ApiError::unauthorized("token has been revoked")),
        Minted::TooMany => Err(ApiError::new(
            axum::http::StatusCode::TOO_MANY_REQUESTS,
            "too many live push-fetch tokens for this session; use the one already minted",
        )),
        Minted::NoLineage => Err(ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "session has no lineage yet; refresh and ask again",
        )),
    }
}
