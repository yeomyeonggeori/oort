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
//! `mint_and_record_session_in_tx`. The audit row is `momo_db::audit::write_audit`.
//!
//! ## One transaction, under the workspace's membership lock (#4636)
//!
//! The claim, the sweep of the member's other sessions (a reset), the audit row and
//! the new session's pair are **one tenant transaction** whose first statement takes
//! the workspace's membership lock **exclusively** ([`lock_membership_mutation`]).
//! Exclusive for both kinds, so the handler has one mode: a claim writes the
//! credential, and a reset ends every other session of the member, and both must be
//! ordered against the doors that sign someone in under the shared lock (login, join):
//! a sign-in in flight finishes first and is swept with the rest, or starts after and
//! reads the new password. A suspension or removal that overlaps a claim waits for its
//! commit and revokes the pair it recorded; one that committed first makes the claim
//! find an inactive member, which rolls the whole transaction back (no password
//! written, the token still unspent, no session).
//!
//! **A token that can never be spent does not queue for it.** This route is public and the
//! lock is exclusive, so a request that holds or waits for it makes every sign-in of the
//! workspace wait or retry. Before the lock, a read that takes none
//! ([`claim_refusal_in_tx`]) refuses what is already refused — no such token, spent,
//! expired, an owner-bootstrap token for an account that has a password, a member who is
//! not active — with the answers the consume itself has. What it lets through is read
//! again once the lock is held, where nothing can change underneath it (a suspension or
//! another claim that came first is refused before anything is written), and the consume
//! judges it a last time. Before the lock the read can only be wrong in the safe
//! direction (a spent token never comes back).
//!
//! Lock order: membership lock → claim row → `human` row → member-wide sweep lock →
//! `token` rows. The membership lock is always first. The operator's reissue
//! (`issue_password_reset`) takes it first too: it locks a member row and then that
//! member's open link, the opposite order of this route (the link, then the member row for
//! the audit row), so without the shared first lock the two could wait for each other.
//! Row locks that a foreign key takes are not part of this order; transactions that start
//! with the membership lock are serialized by it.

use crate::session_end::end_member_sessions_in_tx;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::Json;
use momo_auth::{
    claim_refusal_in_tx, consume_claim_in_tx, normalized_claim_token, normalized_new_password,
    resolve_claim_workspace, ClaimMutation, ClaimSpecInvalid,
};
use momo_auth::{ClaimOutcome, IssuedToken};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{with_tenant_tx, DbError};
use momo_messaging::RevocationCause;
use momo_settings::lock_membership_mutation;

use crate::dto::{ClaimRequest, LoginResponse, MemberDto};
use crate::error::{db_error, ApiError};
use crate::routes::auth_routes::{base_scopes, mint_and_record_session_in_tx};
use crate::AppState;

/// What the claim transaction decided, mapped to HTTP outside it.
enum Claimed {
    /// The token was not spendable (unknown, expired, used, password already set).
    /// Nothing was written.
    Refused(ClaimMutation),
    /// The claim is applied and the new session's pair is recorded, in the same
    /// transaction that holds the membership lock.
    Issued {
        outcome: ClaimOutcome,
        access: IssuedToken,
        refresh: IssuedToken,
    },
}

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
    uri: Uri,
    headers: HeaderMap,
    Json(request): Json<ClaimRequest>,
) -> Result<Json<LoginResponse>, ApiError> {
    let token = normalized_claim_token(&request.token).map_err(spec_error)?;
    // The caller is choosing this password — for the first owner's bootstrap and
    // for an operator-issued reset alike (ADR-0215 D2). A refusal is a 400 before
    // any statement runs, so the one-time token is not spent on a typo.
    let password = normalized_new_password(&request.password)?;

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
    let gateway_enabled = state.agent_gateway.enabled();
    let hosted_delivery_enabled = state.agent_port.config.hosted_delivery_enabled;
    let subscription_agents_enabled = state.agent_port.config.subscription_agents_enabled;
    let claude_subscription_agents_enabled =
        state.agent_port.config.claude_subscription_agents_enabled;
    let jwt_secret = state.jwt_secret.clone();

    let claimed = with_tenant_tx(&state.pool, workspace_id, {
        let token = token.clone();
        let password = password.clone();
        move |conn| {
            Box::pin(async move {
                // A token that can never be spent is answered here, without the lock.
                if let Some(refusal) = claim_refusal_in_tx(conn, workspace_id, &token).await? {
                    return Ok(Claimed::Refused(refusal));
                }
                // The membership lock, exclusive, before anything is judged under it (see
                // the module docs).
                lock_membership_mutation(conn, workspace_id).await?;
                // Read again under the lock: a suspension, or another claim, that committed
                // while this request waited is refused here, before a single write — in the
                // documented words, instead of by the consume failing halfway.
                if let Some(refusal) = claim_refusal_in_tx(conn, workspace_id, &token).await? {
                    return Ok(Claimed::Refused(refusal));
                }
                let mutation = consume_claim_in_tx(conn, workspace_id, &token, &password).await?;
                let ClaimMutation::Applied(outcome) = mutation else {
                    return Ok(Claimed::Refused(mutation));
                };
                let (action, schema) = if outcome.claim_kind == momo_auth::CLAIM_KIND_PASSWORD_RESET
                {
                    ("member.password_reset", "momo.member.password_reset.v1")
                } else {
                    ("owner.claim", "momo.owner.claim.v1")
                };
                // A reset revokes every session of the member
                // (`consume_claim_in_tx`); their push registrations and device keys (#3022) end in
                // the same commit (#2677). An owner bootstrap revokes none.
                if outcome.claim_kind == momo_auth::CLAIM_KIND_PASSWORD_RESET {
                    end_member_sessions_in_tx(
                        conn,
                        workspace_id,
                        outcome.member_id,
                        RevocationCause::PasswordReset,
                    )
                    .await?;
                }
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, action)
                        .by(outcome.member_id)
                        .target("credential_claim", outcome.claim_id)
                        .via_token(None)
                        .with_schema(schema, serde_json::json!({})),
                )
                .await?;
                if outcome.claim_kind == momo_auth::CLAIM_KIND_OWNER_BOOTSTRAP {
                    crate::routes::welcome::enqueue_welcome_kickoff_in_tx(
                        conn,
                        workspace_id,
                        outcome.member_id,
                        gateway_enabled,
                        hosted_delivery_enabled,
                        subscription_agents_enabled,
                        claude_subscription_agents_enabled,
                        None,
                    )
                    .await?;
                }
                // The new session's pair, on THIS connection and after the sweep above, so
                // the sweep cannot take it and a suspension that follows can.
                let (access, refresh) = mint_and_record_session_in_tx(
                    conn,
                    &jwt_secret,
                    workspace_id,
                    outcome.member_id,
                    base_scopes(),
                )
                .await?;
                Ok::<_, DbError>(Claimed::Issued {
                    outcome,
                    access,
                    refresh,
                })
            })
        }
    })
    .await
    .map_err(|error| db_error("claim.consume", error))?;

    let (outcome, access, refresh) = match claimed {
        Claimed::Refused(mutation) => return Err(mutation_error(mutation)),
        Claimed::Issued {
            outcome,
            access,
            refresh,
        } => (outcome, access, refresh),
    };

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
        realtime_web_socket_url: state.advertised_realtime_ws_url(&headers, uri.scheme_str())?,
    }))
}
