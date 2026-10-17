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

use crate::auth::{PushActionCredential, PushFetchCredential};
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
    action_credential: Option<Extension<PushActionCredential>>,
    fetch_credential: Option<Extension<PushFetchCredential>>,
) -> Result<Json<PushFetchTokenResponse>, ApiError> {
    // #3927: no narrow token mints a token, of either kind. The route lists already
    // answer 403 before the database; this is the second line.
    if action_credential.is_some() || fetch_credential.is_some() {
        return Err(ApiError::forbidden(
            "a narrow token cannot mint another token",
        ));
    }
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

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use axum::http::StatusCode;
    use momo_auth::{Principal, PrincipalKind};
    use uuid::Uuid;

    use super::*;

    /// A pool handle that never reaches a database: the refusals below are decided
    /// before the first query, and the control proves it by failing on the query.
    fn state_without_a_database() -> AppState {
        let pool = momo_db::sqlx::postgres::PgPoolOptions::new()
            .acquire_timeout(Duration::from_millis(300))
            .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
            .expect("a lazy pool never dials");
        AppState::new(
            pool,
            "unit-test-secret".to_string(),
            "ws://127.0.0.1:8000/connection/websocket".to_string(),
        )
    }

    fn a_signed_in_person() -> Principal {
        Principal {
            member_id: Uuid::from_u128(1),
            workspace_id: Uuid::from_u128(2),
            token_id: Some(Uuid::from_u128(3)),
            scopes: vec![],
            kind: PrincipalKind::Human,
        }
    }

    /// #3927 (second line): no narrow token mints a token — the push-fetch route is
    /// refused for BOTH narrow markers, whatever the route list in front of it says.
    #[tokio::test]
    async fn a_narrow_bearer_cannot_mint_here_whichever_narrow_token_it_is() {
        for (action, fetch) in [(true, false), (false, true), (true, true)] {
            let outcome = issue(
                State(state_without_a_database()),
                Extension(a_signed_in_person()),
                action.then_some(Extension(PushActionCredential)),
                fetch.then_some(Extension(PushFetchCredential)),
            )
            .await;
            let error = match outcome {
                Ok(_) => panic!("a narrow bearer must not mint (action={action} fetch={fetch})"),
                Err(error) => error,
            };
            assert_eq!(
                error.status,
                StatusCode::FORBIDDEN,
                "action={action} fetch={fetch}"
            );
        }
    }

    /// The control: an ordinary bearer is NOT refused by the marker check — it goes
    /// on to the database (which this test does not have), so the refusal above was
    /// the marker's doing and not a side effect of the harness.
    #[tokio::test]
    async fn an_ordinary_bearer_is_not_stopped_by_the_marker_check() {
        let outcome = issue(
            State(state_without_a_database()),
            Extension(a_signed_in_person()),
            None,
            None,
        )
        .await;
        let error = match outcome {
            Ok(_) => panic!("there is no database, so this cannot succeed"),
            Err(error) => error,
        };
        assert_ne!(error.status, StatusCode::FORBIDDEN, "{}", error.message);
    }
}
