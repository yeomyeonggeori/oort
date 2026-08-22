//! `POST /v1/join` — the public invite self-signup (B4.3, diff-matrix C-1).
//!
//! Port of Swift `Routes/JoinRoutes.join` (:24-214). B4.2 mounted the create
//! half of the 초대 surface and its PR said so plainly: *"you can mint an invite
//! that cannot yet be redeemed on this server"*. This is the door on the other
//! side of that link.
//!
//! ```text
//! POST /v1/join   (public — no bearer, per-IP rate limited)
//!   → 201 { accessToken, refreshToken, workspaceId, member, memberships,
//!           invite, redemptionId, createdMember: true }   account created
//!   → 200 same shape, createdMember: false                existing human rejoined
//! ```
//!
//! ## Why it is mounted outside the auth middleware
//!
//! By construction: the caller has no credential except the invite code. Putting
//! it behind `require_principal` would make it permanently unreachable — the
//! same measured reason `…/work-hosts/{host}/heartbeat` and
//! `/v1/centrifugo/subscribe` are public, and Swift mounts this one the same way
//! (`JoinRoutes.swift:6-12`).
//!
//! Being public is what makes the two guards below non-negotiable:
//!
//! * **the tenant is resolved by an EXECUTE-only definer function**, never by a
//!   client-supplied workspace id. `momo_join_private.invite_workspace_id`
//!   (migration 009) is granted to `momo_app` alone; it returns one uuid and no
//!   tenant row, and everything after it runs inside
//!   `momo_db::with_tenant_tx` under that workspace's scope. The route cannot
//!   name a workspace even if a client asks it to — there is no workspace field
//!   in the request body.
//! * **the route is rate limited per client IP** ([`crate::rate_limit`]). It
//!   accepts a bearer string in the body. `/v1/claim` is the other
//!   unauthenticated write and uses the same limiter shape on its own budget.
//!
//! ## This route owns no SQL
//!
//! Every statement is `momo_settings::join`'s (`invite_code` has one owner
//! crate), the token rows are `momo_auth::record_session_token`'s, and the audit
//! row is `momo_db::audit::write_audit`'s. What lives here is translation:
//! validation → 400, [`JoinRejection`] → its status, and the 201/200 split.
//!
//! ## Deliberate omission, recorded rather than implied
//!
//! Swift follows a successful join with `OnboardingGreeting.post` (MOMO-588 /
//! W-O3): the workspace agent posts a deterministic welcome through the
//! canonical write path. It is **not** ported here. It is best-effort and
//! error-swallowing on the Swift side too (a greeting failure must never fail a
//! join), so its absence changes no response field and no status — it is a
//! missing timeline message, nothing else. It also belongs to the agent surface
//! this batch was told to leave alone. Recorded in the PR body as open.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use momo_db::audit::{write_audit, AuditEntry};
use momo_settings::{
    fallback_handle, normalized_invite_code, normalized_join_display_name, normalized_join_email,
    normalized_join_password, normalized_join_time_zone, normalized_requested_handle,
    redeem_invite_in_tx, resolve_invite_workspace, JoinError, JoinOutcome, JoinRejection,
    JoinRequestValues, JoinSpecInvalid,
};

use crate::dto::{InviteCodeDto, JoinMembershipDto, JoinRequest, JoinResponse, MemberDto};
use crate::error::ApiError;
use crate::routes::auth_routes::{base_scopes, issue_and_record_session};
use crate::routes::shared::join_tenant_tx;
use crate::AppState;

/// A 400 with Swift's wording. Every field of the body is validated before a
/// single statement runs, so a malformed request never reaches the database —
/// which matters more here than elsewhere: this handler is reachable without a
/// credential, and `momo_password_hash` is bcrypt running inside Postgres.
fn spec_error(error: JoinSpecInvalid) -> ApiError {
    ApiError::bad_request(error.to_string())
}

/// [`JoinRejection`] → HTTP, using the status the domain type carries so the
/// table cannot drift from the messages beside it.
///
/// `Db` becomes an opaque 500 rather than going through
/// [`crate::error::db_error`]: that helper maps `RowNotFound` to *"channel not
/// found or not provisioned"*, which on this path would be a lie. Every refusal
/// a client can cause is a [`JoinRejection`], so a `Db` here is genuinely ours.
fn join_error(error: JoinError) -> ApiError {
    match error {
        JoinError::Rejected(rejection) => rejection_error(rejection),
        JoinError::Db(inner) => ApiError::internal("join.redeem", inner),
    }
}

fn rejection_error(rejection: JoinRejection) -> ApiError {
    let status =
        StatusCode::from_u16(rejection.status_code()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    ApiError::new(status, rejection.to_string())
}

pub async fn join(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<JoinRequest>,
) -> Result<Response, ApiError> {
    // -- 1. shape ----------------------------------------------------------
    // In Swift's order (`JoinRoutes.swift:26-32`), because the order decides
    // which 400 a request with two problems receives.
    let code = normalized_invite_code(&request.code).map_err(spec_error)?;
    let email = normalized_join_email(&request.email).map_err(spec_error)?;
    let display_name = normalized_join_display_name(&request.display_name).map_err(spec_error)?;
    let requested_handle =
        normalized_requested_handle(request.handle.as_deref()).map_err(spec_error)?;
    let derived_handle = fallback_handle(&email).map_err(spec_error)?;
    let password = normalized_join_password(request.password.as_deref()).map_err(spec_error)?;
    let time_zone = normalized_join_time_zone(request.time_zone.as_deref()).map_err(spec_error)?;

    let values = JoinRequestValues {
        email,
        display_name,
        requested_handle,
        fallback_handle: derived_handle,
        password,
        time_zone,
    };
    let user_agent = headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    // -- 2. which tenant? --------------------------------------------------
    // The locked definer lookup, on a connection with NO tenant GUC — there is
    // nothing to bind one to until this answers. `momo_app` is the only role
    // granted EXECUTE (migration 009 + bootstrap_roles.sql), so a server running
    // under any other credential fails here rather than reading `invite_code`
    // some other way.
    let mut conn = state
        .pool
        .acquire()
        .await
        .map_err(|error| ApiError::internal("join.acquire", error))?;
    let resolved = resolve_invite_workspace(&mut conn, &code)
        .await
        .map_err(|error| ApiError::internal("join.resolve_workspace", error))?;
    drop(conn);

    // An unknown code and a code for a deleted workspace are the same 404. The
    // route must not become an oracle for which codes exist.
    let Some(workspace_id) = resolved else {
        return Err(rejection_error(JoinRejection::InviteInvalid));
    };

    // -- 3. the join, in one tenant transaction ----------------------------
    let outcome: JoinOutcome = join_tenant_tx(&state.pool, workspace_id, {
        let values = values.clone();
        let code = code.clone();
        let user_agent = user_agent.clone();
        move |conn| {
            Box::pin(async move {
                let outcome =
                    redeem_invite_in_tx(conn, workspace_id, &code, &values, user_agent.as_deref())
                        .await?;
                // Swift writes this row inside the same transaction
                // (`insertAuditLog` :652-683) and so does this: an audit row that
                // survived a rolled-back join would be a false record.
                //
                // `via_token_id` is NULL and truthfully so — no token authorized
                // this call, the invite code did, and the code is named by
                // `target_id` without its value ever being written down.
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, "invite.join")
                        .by(outcome.member.id)
                        .target("invite_code", outcome.invite_id)
                        .via_token(None)
                        .with_schema(
                            "momo.invite.join.v1",
                            serde_json::json!({
                                "redemption_id": outcome.redemption_id.to_string(),
                                "role": outcome.invite_role,
                                "user_agent": user_agent,
                            }),
                        ),
                )
                .await?;
                Ok(outcome)
            })
        }
    })
    .await
    .map_err(join_error)?;

    // -- 4. the session ----------------------------------------------------
    // The same mint-and-record path login uses, so a joined session is revocable
    // exactly like a logged-in one (MOMO-300). Reusing it rather than re-minting
    // here is what keeps the two from drifting in what they persist.
    let (access, refresh) = issue_and_record_session(
        &state,
        workspace_id,
        outcome.member.id,
        base_scopes(),
        "join.session",
    )
    .await?;

    let status = if outcome.created_member {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    let body = JoinResponse {
        access_token: access.token,
        refresh_token: refresh.token,
        workspace_id: workspace_id.to_string(),
        member: MemberDto {
            id: outcome.member.id.to_string(),
            workspace_id: outcome.member.workspace_id.to_string(),
            kind: outcome.member.kind,
            display_name: outcome.member.display_name,
            handle: outcome.member.handle,
        },
        realtime_web_socket_url: state.realtime_ws_url.to_string(),
        memberships: outcome
            .memberships
            .into_iter()
            .map(|membership| JoinMembershipDto {
                id: membership.id.to_string(),
                channel_id: membership.channel_id.to_string(),
                role: membership.role,
            })
            .collect(),
        invite: InviteCodeDto {
            id: outcome.invite.id.to_string(),
            workspace_id: outcome.invite.workspace_id.to_string(),
            code_preview: outcome.invite.code_preview,
            role: outcome.invite.role,
            max_uses: outcome.invite.max_uses,
            used_count: outcome.invite.used_count,
            expires_at_ms: outcome.invite.expires_at_ms,
            revoked_at_ms: outcome.invite.revoked_at_ms,
            revoked_by: outcome.invite.revoked_by.map(|id| id.to_string()),
            revocation_reason: outcome.invite.revocation_reason,
            created_by: outcome.invite.created_by.to_string(),
            created_at_ms: outcome.invite.created_at_ms,
            updated_at_ms: outcome.invite.updated_at_ms,
        },
        redemption_id: outcome.redemption_id.to_string(),
        created_member: outcome.created_member,
    };
    Ok((status, Json(body)).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The refusal table, end to end: domain variant → status → message. This is
    /// the surface an onboarding UI branches on, so it is asserted at the layer
    /// that actually answers rather than only in the domain crate.
    #[test]
    fn every_refusal_reaches_the_client_with_swifts_status_and_sentence() {
        let cases = [
            (JoinRejection::InviteInvalid, 404, "invite code is invalid"),
            (JoinRejection::InviteExpired, 410, "invite code is expired"),
            (JoinRejection::InviteRevoked, 410, "invite code is revoked"),
            (
                JoinRejection::InviteExhausted,
                409,
                "invite code is exhausted",
            ),
            (
                JoinRejection::AlreadyRedeemed,
                409,
                "invite code was already redeemed by this member",
            ),
            (JoinRejection::HandleTaken, 409, "handle is already in use"),
            (
                JoinRejection::NoPublicChannels,
                409,
                "workspace has no joinable public channels",
            ),
            (
                JoinRejection::RoleNotPubliclyJoinable,
                403,
                "public join cannot grant owner or platform admin",
            ),
            (
                JoinRejection::RoleEscalation,
                403,
                "public join cannot escalate an existing member role",
            ),
            (
                JoinRejection::Banned,
                403,
                "member is banned from this workspace",
            ),
            (
                JoinRejection::NotHuman,
                403,
                "invite can only join human members",
            ),
            (
                JoinRejection::HumanIneligible,
                403,
                "human is not eligible to join",
            ),
        ];
        for (rejection, status, message) in cases {
            let api = rejection_error(rejection);
            assert_eq!(api.status.as_u16(), status, "{rejection:?}");
            assert_eq!(api.message, message, "{rejection:?}");
        }
    }

    /// A `410 Gone` is not a stylistic choice: expired and revoked links are
    /// permanently dead, and a client that saw 404 would keep offering "try
    /// again" while one that sees 410 can say "ask for a new link".
    #[test]
    fn a_dead_link_is_gone_and_a_contended_one_is_a_conflict() {
        assert_eq!(rejection_error(JoinRejection::InviteExpired).status, 410);
        assert_eq!(rejection_error(JoinRejection::InviteRevoked).status, 410);
        assert_eq!(
            rejection_error(JoinRejection::InviteExhausted).status,
            409,
            "exhausted is a race someone else won, not a dead link"
        );
    }

    /// A database failure on this path must not borrow the write path's
    /// `RowNotFound → 404 channel not found` mapping.
    #[test]
    fn a_db_failure_is_an_opaque_500_not_a_borrowed_404() {
        let api = join_error(JoinError::Db(momo_db::DbError::from(
            momo_db::sqlx::Error::RowNotFound,
        )));
        assert_eq!(api.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(api.message, "internal server error");
    }

    /// A 400 says what Swift says, so a client's error copy needs no branch.
    #[test]
    fn validation_failures_carry_swifts_wording() {
        assert_eq!(
            spec_error(JoinSpecInvalid::Email).message,
            "email is invalid"
        );
        assert_eq!(
            spec_error(JoinSpecInvalid::DisplayName).message,
            "displayName is required"
        );
        assert_eq!(
            spec_error(JoinSpecInvalid::PasswordMissing).status,
            StatusCode::BAD_REQUEST
        );
    }
}
