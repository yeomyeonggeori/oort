//! Password surfaces for #1767.
//!
//! ```text
//! POST  /v1/workspaces/{ws}/members/{member}/password-reset   owner/admin
//! PATCH /v1/workspaces/{ws}/members/me/password               self, current password
//! ```
//!
//! Reset links are operator-mediated and out-of-band (invite convention).
//! There is no mailer. The raw token leaves the server once in the 201 body.
//!
//! ## The change is one transaction, under the workspace's membership lock (#4636)
//!
//! The standing check, the current-password check, the new hash, the sweep of the
//! member's sessions, the audit row and the new session's pair are **one tenant
//! transaction** whose first statement takes the workspace's membership lock
//! **exclusively** ([`lock_membership_mutation`]) — the lock a suspension, removal or
//! departure takes. The doors that sign someone in (login, join) hold it shared, so a
//! sign-in in flight finishes first and its pair is swept with the rest, or starts after
//! the change and reads the new password: the sweep never runs between a sign-in's checks
//! and its recording. A suspension that overlaps a change waits for its commit and
//! revokes the pair it recorded; one that committed first is found **inside** the lock
//! (the middleware judged the bearer before the lock was had, and a request can be
//! waiting for the lock while the member is suspended), which refuses the change before
//! anything is written.
//!
//! ## The reissue asks the operator for their own password first (#4596, ADR-0215 D6)
//!
//! `POST …/members/{member}/password-reset` takes `{ "currentPassword" }` — the **issuing
//! operator's** password, not the target's — because a stolen operator session alone must not be
//! enough to mint a link into any member's account. The order is fixed, and each step is a
//! reason the next one is safe:
//!
//! 1. the operator's reissue **budget** is spent (every request, a right password too);
//! 2. the caller must be an owner or admin — judged without the membership lock;
//! 3. the body must carry a password (400 `current_password_required`; a missing body, a body
//!    that is not JSON and a missing field are the same 400, not the extractor's 415/422);
//! 4. the password must be the operator's own (403 `current_password_incorrect`) — **still
//!    without the lock**: a request that is going to be refused must not queue every sign-in of
//!    the workspace behind a hash comparison (ADR-0215 증보 2 K5). Nothing about the *target* has
//!    been read yet, so a wrong password cannot tell a real member from a missing one;
//! 5. only then the membership lock, and the ladder, the previous link's end and the new link,
//!    exactly as before ([`issue_password_reset_in_tx`] judges the hierarchy under the lock).
//!
//! A refusal at step 4 leaves the previous live link as it was, writes **no** issue audit row,
//! and leaves one `member.password_reset.refused` row per operator and window (D9) — the shape
//! of a refusal is `via` and `reason`, never a value the caller sent.
//!
//! Lock order: membership lock → `human` row → member-wide sweep lock → `token` rows.
//! The membership lock is always first. The operator's reissue (`issue_password_reset`)
//! takes it first too, exclusively: it locks a member row and then that member's open link,
//! the opposite order of a claim that spends the link and then needs the member row for its
//! audit row, so without the shared first lock the two could wait for each other. Row locks
//! that a foreign key takes (an `audit_log` or `token` insert needs the member row) are not
//! part of this order: transactions that start with the membership lock are serialized by it
//! and cannot meet there; paths that do not start with it are outside this change.

use std::time::Duration;

use crate::session_end::end_member_sessions_in_tx;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use momo_auth::IssuedToken;
use momo_auth::{
    active_workspace_role, change_own_password_in_tx, issue_password_reset_in_tx,
    member_password_matches_in_tx, mint_owner_claim_token, normalized_current_password,
    normalized_new_password, IssuedPasswordReset, PasswordChangeMutation, PasswordResetIssueError,
    Principal, CLAIM_KIND_PASSWORD_RESET,
};
use momo_db::audit::{write_audit, AuditEntry};
use momo_messaging::{get_member, Member, RevocationCause};
use momo_settings::lock_membership_mutation;
use uuid::Uuid;

use crate::dto::{
    ChangePasswordRequest, IssuePasswordResetRequest, LoginResponse, MemberDto,
    PasswordResetClaimResponse,
};
use crate::error::ApiError;
use crate::rate_limit::{admit_password_reset_issue, client_ip, RefusalAuditSlot};
use crate::realtime_advert::{derive_same_origin_http_base, host_is_loopback_or_lan};
use crate::routes::auth_routes::{base_scopes, mint_and_record_session_in_tx};
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, path_uuid, require_human, settle_db, workspace_scope,
    DbRejectable,
};
use crate::AppState;

/// The password the caller *proves* (ADR-0215 D2): present and bounded, and
/// nothing more — an account whose password predates the new length rule must
/// still be able to change it. The password the caller *chooses* goes through
/// [`normalized_new_password`] and answers `password_too_short` /
/// `password_too_long`.
fn spec_current_password(raw: &str) -> Result<String, ApiError> {
    normalized_current_password(raw).map_err(|error| ApiError::bad_request(error.to_string()))
}

pub(crate) fn admit_password_change(
    state: &AppState,
    headers: &HeaderMap,
    member_id: Uuid,
) -> Result<(), ApiError> {
    let config = &state.rate_limit.config;
    let member_key = format!("pwchange:member:{member_id}");
    let ip = client_ip(headers, None);
    let ip_key = ip.as_ref().map(|addr| format!("pwchange:ip:{addr}"));
    let mut checks: Vec<(&str, u32)> = Vec::new();
    if config.password_change_per_member_limit > 0 {
        checks.push((&member_key, config.password_change_per_member_limit));
    }
    if let Some(ref key) = ip_key {
        if config.password_change_per_ip_limit > 0 {
            checks.push((key.as_str(), config.password_change_per_ip_limit));
        }
    }
    if checks.is_empty() {
        return Ok(());
    }
    let verdicts = state
        .rate_limit
        .limiter
        .check_many(&checks, Duration::from_secs(config.window_seconds));
    if verdicts.iter().any(|verdict| !verdict.allowed) {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "rate limit exceeded",
        ));
    }
    Ok(())
}

/// Invite management is workspace authority (ADR-0128).
async fn require_admin(
    conn: &mut momo_db::PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<Result<(), ApiError>, momo_db::DbError> {
    let role = active_workspace_role(conn, workspace_id, member_id).await?;
    Ok(match role {
        Some(role) if role.is_admin() => Ok(()),
        Some(_) => Err(ApiError::forbidden("workspace admin required")),
        None => Err(ApiError::forbidden("not a workspace member")),
    })
}

/// What the operator's password check decided (steps 2-4 of the module docs). The only thing it
/// reads is the operator's own standing and password; nothing is locked and nothing is written.
enum OperatorCheck {
    /// An owner or admin who proved their own password.
    Proven,
    /// An owner or admin whose password was not the one sent (or who has none).
    WrongPassword,
}

/// The link's address and whether the person who gets it can be expected to open it.
struct ClaimLinkOrigin {
    origin: String,
    secure: bool,
}

/// The origin a reset link that **another person** will open should point at (ADR-0215 D6,
/// precedent: the invite link an approval hands out, ADR-0186 부록 C).
///
/// 1. `MOMO_PUBLIC_BASE_URL` when the operator set it to an absolute https origin — it is read
///    before the request's own `Host`, for the reason the invite link already gives: the link
///    reaches its reader out of band, so the address the operator happens to be connected on
///    (a LAN address, loopback) is not an address the reader can reach, and the `Host` header
///    is the one thing about this request a caller chooses. A configured origin is https by
///    construction, so it is `secure`.
/// 2. Otherwise the request's own origin by the ADR-0167 rule (`Host` and
///    `X-Forwarded-Proto`). That is `secure` only when it is https **and** not loopback or a
///    private address: an `http://` or LAN-only origin yields a link only this network can open,
///    and the response says so (`claimUrlSecure: false`) instead of promising an "https".
fn claim_link_origin(
    state: &AppState,
    headers: &HeaderMap,
    connection_scheme: Option<&str>,
) -> Result<ClaimLinkOrigin, ApiError> {
    if let Some(configured) = state.t3.ready_public_base_url() {
        return Ok(ClaimLinkOrigin {
            origin: configured,
            secure: true,
        });
    }
    let forwarded_proto = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok());
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    let origin = derive_same_origin_http_base(forwarded_proto, host, connection_scheme)
        .map_err(|error| ApiError::internal("password_reset.origin", error))?;
    let secure =
        origin.starts_with("https://") && host.is_some_and(|host| !host_is_loopback_or_lan(host));
    Ok(ClaimLinkOrigin { origin, secure })
}

/// The password the operator sent, or the 400. Present and bounded, nothing more
/// ([`spec_current_password`]): the operator's own password may predate the new length rule.
/// Read by hand so a missing body, a body that is not JSON, a missing field and a field of the
/// wrong type are one answer (see [`IssuePasswordResetRequest`]).
fn presented_operator_password(body: &Bytes) -> Result<String, ApiError> {
    let required = || {
        ApiError::coded(
            StatusCode::BAD_REQUEST,
            "current_password_required",
            "currentPassword is required",
        )
    };
    let sent = serde_json::from_slice::<IssuePasswordResetRequest>(body)
        .ok()
        .and_then(|request| request.current_password)
        .ok_or_else(required)?;
    if sent.is_empty() {
        return Err(required());
    }
    spec_current_password(&sent)
}

/// One `member.password_reset.refused` row for a wrong operator password, at most one per
/// operator and window (ADR-0215 D9). Its own small transaction: the check that refused the
/// request wrote nothing, and the refusal must leave its trace even though the request fails.
///
/// The detail is `via` and `reason`, both fixed words — never the password sent, never the
/// target the request named. A refusal past the window's one row is not silent: it is one WARN
/// line (the operator's id and the reason code, nothing the request sent). A failure to write is
/// logged and swallowed: the 403 stands, and the slot goes back (it is not marked written) so the
/// next refusal of the window tries again.
///
/// The write runs on a task of its own, awaited by the request that asked for it, for the reason
/// `rate_limit::audit_denial_detached` gives: a server drops the future of a request whose client
/// went away, and a drop between the `COMMIT` and its answer would hand the slot back for a row
/// that was written, so the window's next refusal would write a second one.
async fn record_wrong_operator_password(
    state: &AppState,
    workspace_id: Uuid,
    operator_id: Uuid,
    via_token: Option<Uuid>,
) {
    let Some(slot) = RefusalAuditSlot::take(&state.rate_limit, operator_id) else {
        tracing::warn!(
            member_id = %operator_id,
            reason = "current_password_incorrect",
            "operator password-reset issue refused again in this window; the window's audit row is already written"
        );
        return;
    };
    let pool = state.pool.clone();
    let task = tokio::spawn(async move {
        let written = agent_tenant_tx(&pool, workspace_id, move |conn| {
            Box::pin(async move {
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, "member.password_reset.refused")
                        .by(operator_id)
                        .target("member", operator_id)
                        .via_token(via_token)
                        .with_schema(
                            "momo.member.password_reset.refused.v1",
                            serde_json::json!({
                                "via": "admin",
                                "reason": "current_password_incorrect"
                            }),
                        ),
                )
                .await
                .map(|_| ())
            })
        })
        .await;
        match written {
            Ok(()) => slot.written(),
            Err(error) => {
                tracing::error!(
                    error = %error,
                    "the refused-reissue audit row failed; the 403 stands and the next refusal retries"
                );
            }
        }
    });
    if let Err(error) = task.await {
        tracing::error!(error = %error, "the refused-reissue audit task did not finish");
    }
}

pub async fn issue_password_reset(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, member)): Path<(String, String)>,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    require_human(&principal, "human operator required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let actor_id = principal.member_id;
    // 1. The operator's budget, spent before anything else about the request is looked at.
    admit_password_reset_issue(&state.rate_limit, actor_id)?;
    let target_id = path_uuid(&member, "invalid member id")?;
    let via_token = audit_via_token_id(&principal);
    let token = mint_owner_claim_token()
        .map_err(|error| ApiError::internal("password_reset.entropy", error))?;
    // Read now, judged below in the order the module docs give (a non-operator is told 403
    // whatever the body says; an address that cannot be built is told after the password).
    let presented = presented_operator_password(&body);
    let link_origin = claim_link_origin(&state, &headers, uri.scheme_str());

    // 2-4. Standing, body, password: one read-only transaction, no lock, no write. A request that
    // is going to be refused here must not queue behind the membership lock (ADR-0215 증보 2 K5),
    // and the target has not been looked at, so a wrong password learns nothing about it.
    let checked: DbRejectable<OperatorCheck> = agent_tenant_tx(&state.pool, workspace_id, {
        move |conn| {
            Box::pin(async move {
                if let Err(rejection) = require_admin(conn, workspace_id, actor_id).await? {
                    return Ok(Err(rejection));
                }
                let password = match presented {
                    Ok(password) => password,
                    Err(rejection) => {
                        // Not an audit row (nothing was guessed), but not silent either (ADR-0215
                        // D9): the operator's id and the reason code, and nothing the body held.
                        tracing::warn!(
                            member_id = %actor_id,
                            reason = rejection.code.unwrap_or("current_password_invalid"),
                            "operator password-reset issue request without a usable current password"
                        );
                        return Ok(Err(rejection));
                    }
                };
                let proven =
                    member_password_matches_in_tx(conn, workspace_id, actor_id, &password).await?;
                Ok(Ok(if proven {
                    OperatorCheck::Proven
                } else {
                    OperatorCheck::WrongPassword
                }))
            })
        }
    })
    .await;
    match settle_db("password_reset.confirm", checked)? {
        OperatorCheck::Proven => {}
        OperatorCheck::WrongPassword => {
            record_wrong_operator_password(&state, workspace_id, actor_id, via_token).await;
            return Err(ApiError::coded(
                StatusCode::FORBIDDEN,
                "current_password_incorrect",
                "current password is incorrect",
            ));
        }
    }
    // Nothing is minted for a link nobody can be given an address for.
    let link_origin = link_origin?;

    // 5. The membership lock, the ladder, the previous link's end and the new link.
    let outcome: DbRejectable<IssuedPasswordReset> = agent_tenant_tx(&state.pool, workspace_id, {
        let token = token.clone();
        move |conn| {
            Box::pin(async move {
                // The membership lock, exclusive, before any member row is locked, like every
                // other transaction that does: a reissue locks the target's member row and then
                // the target's open link, and the claim that spends that link holds the link and
                // then needs the member row (its audit row references it). Two transactions that
                // take those rows in opposite orders wait for each other until the database ends
                // one of them; behind this lock they cannot meet. The operator's standing was
                // judged above without it (a request that cannot succeed must not queue for it);
                // whether *this* operator may reset *this* member is judged by
                // `issue_password_reset_in_tx` under the lock.
                lock_membership_mutation(conn, workspace_id).await?;
                match issue_password_reset_in_tx(conn, workspace_id, actor_id, target_id, &token)
                    .await?
                {
                    Ok(issued) => {
                        write_audit(
                            conn,
                            &AuditEntry::new(workspace_id, "member.password_reset.issued")
                                .by(actor_id)
                                .target("credential_claim", issued.claim_id)
                                .via_token(via_token)
                                .with_schema(
                                    "momo.member.password_reset.issued.v1",
                                    serde_json::json!({
                                        "member_id": issued.member_id.to_string()
                                    }),
                                ),
                        )
                        .await?;
                        Ok(Ok(issued))
                    }
                    Err(PasswordResetIssueError::NotFound) => {
                        Ok(Err(ApiError::not_found("workspace member not found")))
                    }
                    Err(PasswordResetIssueError::NotHuman) => Ok(Err(ApiError::bad_request(
                        "password reset is for human members",
                    ))),
                    Err(PasswordResetIssueError::NotActive) => Ok(Err(ApiError::new(
                        StatusCode::CONFLICT,
                        "member is not active",
                    ))),
                    Err(PasswordResetIssueError::Forbidden) => {
                        Ok(Err(ApiError::forbidden("password reset not permitted")))
                    }
                }
            })
        }
    })
    .await;

    let issued = settle_db("password_reset.issue", outcome)?;
    let claim_path = format!("/claim/{token}");
    Ok((
        StatusCode::CREATED,
        Json(PasswordResetClaimResponse {
            token: issued.token,
            kind: CLAIM_KIND_PASSWORD_RESET,
            expires_at_ms: issued.expires_at_ms,
            claim_url: format!("{}{claim_path}", link_origin.origin),
            claim_url_secure: link_origin.secure,
            claim_path,
        }),
    )
        .into_response())
}

/// What the change transaction decided, mapped to HTTP outside it.
enum PasswordChanged {
    /// The current password did not match, or there is none: nothing was written.
    Refused(PasswordChangeMutation),
    /// The password is changed, the member's other sessions are swept, and the caller's
    /// new pair is recorded — in the same transaction that holds the membership lock.
    Applied {
        member: Member,
        access: IssuedToken,
        refresh: IssuedToken,
    },
}

pub async fn change_own_password(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    uri: Uri,
    headers: HeaderMap,
    Json(request): Json<ChangePasswordRequest>,
) -> Result<Json<LoginResponse>, ApiError> {
    require_human(&principal, "only a human member can change a password")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;
    admit_password_change(&state, &headers, member_id)?;

    let current = spec_current_password(&request.current_password)?;
    let new_password = normalized_new_password(&request.new_password)?;
    if current == new_password {
        return Err(ApiError::bad_request("new password must be different"));
    }
    let via_token = audit_via_token_id(&principal);
    let jwt_secret = state.jwt_secret.clone();

    let outcome: DbRejectable<PasswordChanged> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                // The membership lock, exclusive and first (see the module docs).
                lock_membership_mutation(conn, workspace_id).await?;
                // The standing is read under the lock and before the first write: the
                // bearer was judged before the lock was had, and a suspension or removal
                // that committed in between has already revoked it.
                let Some(member) = get_member(conn, member_id).await? else {
                    return Ok(Err(ApiError::forbidden("not a workspace member")));
                };
                if member.status != "active" {
                    return Ok(Err(ApiError::forbidden("member is not active")));
                }
                let mutation = change_own_password_in_tx(
                    conn,
                    workspace_id,
                    member_id,
                    &current,
                    &new_password,
                )
                .await?;
                let PasswordChangeMutation::Applied { sessions_revoked } = mutation else {
                    return Ok(Ok(PasswordChanged::Refused(mutation)));
                };
                // The change revoked every session of the member (the caller gets a
                // fresh one below); every phone registered under them stops receiving
                // pushes now (#2677).
                end_member_sessions_in_tx(
                    conn,
                    workspace_id,
                    member_id,
                    RevocationCause::PasswordChanged,
                )
                .await?;
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, "member.password_changed")
                        .by(member_id)
                        .target("member", member_id)
                        .via_token(via_token)
                        .with_schema(
                            "momo.member.password_changed.v1",
                            serde_json::json!({
                                "sessions_revoked": sessions_revoked.to_string()
                            }),
                        ),
                )
                .await?;
                // The new session's pair, on THIS connection and after the sweep above, so
                // the sweep cannot take it and a suspension that follows can.
                let (access, refresh) = mint_and_record_session_in_tx(
                    conn,
                    &jwt_secret,
                    workspace_id,
                    member_id,
                    base_scopes(),
                )
                .await?;
                Ok(Ok(PasswordChanged::Applied {
                    member,
                    access,
                    refresh,
                }))
            })
        })
        .await;

    let (member, access, refresh) = match settle_db("password.change", outcome)? {
        PasswordChanged::Refused(PasswordChangeMutation::CurrentMismatch) => {
            return Err(ApiError::forbidden("current password is incorrect"));
        }
        PasswordChanged::Refused(PasswordChangeMutation::NoPassword) => {
            return Err(ApiError::new(StatusCode::CONFLICT, "no password to change"));
        }
        PasswordChanged::Refused(PasswordChangeMutation::Applied { .. }) => {
            return Err(ApiError::internal(
                "password.change.unexpected_applied",
                "applied mapped as a refusal",
            ));
        }
        PasswordChanged::Applied {
            member,
            access,
            refresh,
        } => (member, access, refresh),
    };

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
        realtime_web_socket_url: state.advertised_realtime_ws_url(&headers, uri.scheme_str())?,
    }))
}
