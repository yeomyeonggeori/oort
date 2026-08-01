//! The public auth routes: `login`, `refresh`, `logout`.
//!
//! All three are mounted **outside** the auth middleware, exactly like Swift's
//! `AuthRoutes.add(to:)` (`AuthRoutes.swift:36-44`): refresh and logout verify
//! the presented JWT themselves, and logout deliberately skips the revocation
//! check so revoking an already-revoked token stays a 200 (idempotency), not a
//! 401.
//!
//! ## `POST /v1/auth/login`
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
//! ## `POST /v1/auth/refresh` (B1.6)
//!
//! Parity with Swift `AuthRoutes.refresh` (`AuthRoutes.swift:140-227`), in the
//! same order, because the order *is* the contract:
//!   1. verify signature/exp → 401 `invalid or expired refresh token` (:146-149);
//!   2. `typ == "refresh"` → 401 `not a refresh token` (:150-152);
//!   3. `sub`/`ws` parse → 401 `malformed token claims` (:153-157);
//!   4. `requireActive` advisory pre-check → the precise 401 (:162);
//!   5. the member is still active in the workspace → else 403 (:164-167);
//!   6. **`revoke` is the atomic single-use gate** (:177-181): the loser of a
//!      concurrent replay gets 401 `refresh token already used or revoked`;
//!   7. mint + record a new pair, answer `{accessToken, refreshToken}`.
//!
//! ## `POST /v1/auth/logout` (B1.6)
//!
//! Parity with Swift `AuthRoutes.logout` (`AuthRoutes.swift:236-306`):
//!   * the access token comes from `Authorization: Bearer`, and is verified for
//!     signature/`typ` but **not** for revocation state — logging out twice is
//!     200 with `alreadyRevoked=true` (:229-235);
//!   * an optional body `{refreshToken}` is validated *before* anything is
//!     revoked (same member, same workspace, `typ=refresh`), else 403
//!     `refresh token does not match this session` — a mismatched body must not
//!     leave the session half-revoked (:261-276);
//!   * the response reports exactly which halves this call killed.
//!
//! Deviations (deliberate, see PR body):
//!   * no platform-admin scope elevation and no privileged-session sweep on
//!     login. Absent elevation the issued scopes are strictly the narrower set,
//!     so the deviation fails closed.
//!   * refresh consequently treats a privileged-scoped refresh token as **no
//!     longer eligible** (this server cannot mint one and has no operator
//!     allowlist to re-check against): it takes Swift's `remainsPrivileged =
//!     false` branch — strip the privileged scopes and bulk-revoke the member's
//!     sibling privileged sessions (:202-211) — instead of re-validating the
//!     operator. The narrower branch, again fail-closed.
//!   * logout does not write the `auth.logout` `audit_log` row Swift adds
//!     (:428-452): `momo_db::audit::write_audit` is still a B0 stub and
//!     `momo-db` beyond the migration runner is outside this batch's surface.
//!     Observability gap only — the revocation itself is complete.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;
use momo_auth::{
    carries_privileged_scope, record_session_token, revoke_privileged_session_tokens, revoke_token,
    sign_access, sign_refresh, token_state, verify_app_access, verify_app_refresh,
    without_privileged_scopes, AuthError, IssuedToken, TokenRejection, SESSION_LABEL_ACCESS,
    SESSION_LABEL_REFRESH,
};
use momo_db::{with_tenant_tx, DbError};
use momo_messaging::{get_member, verify_password_login, PasswordLogin};
use uuid::Uuid;

use crate::auth::bearer_token;
use crate::dto::{
    LoginRequest, LoginResponse, LogoutRequest, LogoutResponse, MemberDto, RefreshRequest,
    RefreshResponse,
};
use crate::error::{db_error, ApiError};
use crate::AppState;

/// The workspace seeded by `server/Migrations/002_seed.sql`, used when a login
/// omits an explicit workspace (Swift `AuthRoutes.demoWorkspaceID`).
pub const DEMO_WORKSPACE_ID: Uuid = Uuid::from_u128(0x0000_0000_0000_7000_8000_0000_0000_0001);

/// Coarse v0 scopes (Swift `AuthRoutes.login`). A real implementation derives
/// these from membership/role (L4 §7.2).
///
/// `pub(crate)` since B4.3: `POST /v1/join` signs the caller in on success and
/// must issue the *same* scopes login does. A second literal list there would be
/// a second answer to "what does a fresh session get".
pub(crate) fn base_scopes() -> Vec<String> {
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

/// Mint an access+refresh pair for `member_id` and record **both halves** in one
/// tenant transaction, returning the pair. Swift `recordSessionTokens`
/// (`AuthRoutes.swift:412-426`), shared by login and refresh so the two paths
/// cannot drift in what they persist.
///
/// One transaction rather than Swift's two connections: a session whose access
/// row committed but whose refresh row did not would be unrevocable by a single
/// logout, so the pair is atomic here. Recording is also what makes the
/// middleware's MOMO-300 revocation check meaningful — minting without a row
/// would turn every subsequent request into a 401 `unknown token`.
///
/// `pub(crate)` since B4.3 so `POST /v1/join` mints its session through this and
/// not a copy: a joined session must be revocable exactly like a logged-in one.
pub(crate) async fn issue_and_record_session(
    state: &AppState,
    workspace_id: Uuid,
    member_id: Uuid,
    scopes: Vec<String>,
    context: &str,
) -> Result<(IssuedToken, IssuedToken), ApiError> {
    let access = sign_access(member_id, workspace_id, &scopes, &state.jwt_secret)
        .map_err(|error| ApiError::internal(&format!("{context}.sign_access"), error))?;
    let refresh = sign_refresh(member_id, workspace_id, &scopes, &state.jwt_secret)
        .map_err(|error| ApiError::internal(&format!("{context}.sign_refresh"), error))?;

    let session = SessionTokens {
        member_id,
        scopes,
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
    .map_err(|error| db_error(&format!("{context}.record_session"), error))?;

    Ok((access, refresh))
}

/// The refusal for a `workspace` that was supplied and is not a workspace id.
///
/// It **names the field and both accepted shapes**, because the client maps
/// this 400 back to a Korean sentence by matching on the word `workspace`
/// (`connectModel.signInFailureCopy`). Renaming it silently degrades that
/// sentence to the generic one.
const WORKSPACE_NOT_AN_ID: &str =
    "workspace must be a workspace id (uuid), or omitted to use the default workspace";

/// Which workspace a login lands in.
///
/// | `workspace` | result |
/// |---|---|
/// | absent, empty, or whitespace | [`DEMO_WORKSPACE_ID`] |
/// | a parseable uuid | that workspace |
/// | anything else | **400** |
///
/// ## Why the last row is not a fallback (goal B13 R2 High 1)
///
/// This used to be `.and_then(|raw| Uuid::parse_str(raw).ok()).unwrap_or(DEMO)`,
/// so a `workspace` the caller actually typed — a slug, a workspace *name*, a
/// typo'd id — was parsed, dropped on the floor, and the person was signed in
/// somewhere else without being told. That is the failure mode the honesty
/// principle exists for: the user asked for A and the server quietly gave them
/// B, and every screen afterwards looked like a working session in the wrong
/// tenant.
///
/// It is a real trap rather than a theoretical one, because **the workspace id
/// is never shown anywhere in the product** — every other surface identifies a
/// workspace by slug and name — so a person filling a box labelled
/// "워크스페이스" has no id to type and will reach for the name they know.
///
/// The blank path is deliberately untouched: the connect form's empty box, the
/// smoke harness and every existing client depend on it, and "I named nothing"
/// is not a mistake to report. Only a value that was *supplied and unusable*
/// fails, and it fails visibly.
fn resolve_login_workspace(raw: Option<&str>) -> Result<Uuid, ApiError> {
    let Some(named) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(DEMO_WORKSPACE_ID);
    };
    Uuid::parse_str(named).map_err(|_| ApiError::bad_request(WORKSPACE_NOT_AN_ID))
}

pub async fn login(
    State(state): State<AppState>,
    Json(request): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, ApiError> {
    let workspace_id = resolve_login_workspace(request.workspace.as_deref())?;

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

    // Record both halves so they can be revoked later (MOMO-300).
    let (access, refresh) =
        issue_and_record_session(&state, workspace_id, member.id, base_scopes(), "auth.login")
            .await?;

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

// ---------------------------------------------------------------------------
// POST /v1/auth/refresh
// ---------------------------------------------------------------------------

/// What the refresh gate decided, resolved inside ONE tenant transaction so the
/// pre-check, the member check and the single-use revoke cannot interleave with
/// a competing rotation. Mapped to HTTP outside the transaction.
enum RefreshGate {
    /// The presented row is revoked/expired/unrecorded (Swift `requireActive`).
    Rejected(TokenRejection),
    /// The member is gone, suspended, or soft-deleted → 403, not 401.
    MemberInactive,
    /// The atomic single-use gate was lost: this token was already spent.
    AlreadyUsed,
    /// Gate passed — the presented refresh token is now revoked.
    Rotated,
}

/// Map a verification failure on the refresh path to Swift's wording.
fn refresh_auth_error(error: AuthError) -> ApiError {
    match error {
        AuthError::InvalidToken(_) => ApiError::unauthorized("invalid or expired refresh token"),
        AuthError::NotRefreshToken => ApiError::unauthorized("not a refresh token"),
        AuthError::NotAccessToken => ApiError::unauthorized("not an access token"),
        AuthError::MalformedClaims => ApiError::unauthorized("malformed token claims"),
    }
}

pub async fn refresh(
    State(state): State<AppState>,
    Json(request): Json<RefreshRequest>,
) -> Result<Json<RefreshResponse>, ApiError> {
    let principal = verify_app_refresh(&request.refresh_token, &state.jwt_secret)
        .map_err(refresh_auth_error)?;
    let workspace_id = principal.workspace_id;
    let member_id = principal.member_id;

    // Scope decision (Swift :183-201) with this server's narrower reality: it
    // never elevates on login, so a privileged refresh token cannot be one it
    // minted. Fail closed — downgrade the pair and sweep the member's sibling
    // privileged sessions, rather than re-issue a privileged token.
    let downgrade = carries_privileged_scope(&principal.scopes);
    let scopes = if downgrade {
        without_privileged_scopes(&principal.scopes)
    } else {
        principal.scopes.clone()
    };

    let presented = request.refresh_token.clone();
    let gate = with_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            // (1) Advisory pre-check — precise 401s for a logged-out/rotated
            // token. The *atomic* gate is the revoke below, not this read.
            if let Err(rejection) = token_state(conn, &presented)
                .await
                .map_err(DbError::from)?
                .require_active()
            {
                return Ok(RefreshGate::Rejected(rejection));
            }

            // (2) The credential is alive, but the human behind it may not be.
            // RLS scopes this lookup to the token's workspace, so "active in
            // *this* workspace" is checked by construction (Swift :454-470).
            let member = get_member(conn, member_id).await?;
            if !member.is_some_and(|member| member.status == "active") {
                return Ok(RefreshGate::MemberInactive);
            }

            // (3) THE single-use gate: exactly one concurrent replay flips the
            // row and may mint a replacement pair (Swift :169-181).
            if !revoke_token(conn, &presented)
                .await
                .map_err(DbError::from)?
                .revoked_now
            {
                return Ok(RefreshGate::AlreadyUsed);
            }

            // (4) Downgrade sweep: the presented row is already revoked above;
            // kill the sibling privileged rows in the same transaction so the
            // loss of privilege takes effect now, while the messages-only pair
            // issued below keeps ordinary use alive (Swift :202-211).
            if downgrade {
                revoke_privileged_session_tokens(conn, workspace_id, member_id)
                    .await
                    .map_err(DbError::from)?;
            }

            Ok(RefreshGate::Rotated)
        })
    })
    .await
    .map_err(|error| db_error("auth.refresh", error))?;

    match gate {
        RefreshGate::Rejected(rejection) => {
            return Err(ApiError::unauthorized(rejection.message()))
        }
        RefreshGate::MemberInactive => {
            return Err(ApiError::forbidden(
                "member is not active in this workspace",
            ))
        }
        RefreshGate::AlreadyUsed => {
            return Err(ApiError::unauthorized(
                "refresh token already used or revoked",
            ))
        }
        RefreshGate::Rotated => {}
    }

    let (access, refresh) =
        issue_and_record_session(&state, workspace_id, member_id, scopes, "auth.refresh").await?;

    Ok(Json(RefreshResponse {
        access_token: access.token,
        refresh_token: refresh.token,
    }))
}

// ---------------------------------------------------------------------------
// POST /v1/auth/logout
// ---------------------------------------------------------------------------

/// Map a verification failure on the logout path to Swift's wording — the same
/// strings the middleware uses, because logout re-implements the same access
/// check minus the revocation state.
fn logout_auth_error(error: AuthError) -> ApiError {
    match error {
        AuthError::InvalidToken(_) => ApiError::unauthorized("invalid or expired token"),
        AuthError::NotAccessToken => ApiError::unauthorized("not an access token"),
        AuthError::NotRefreshToken => ApiError::unauthorized("not a refresh token"),
        AuthError::MalformedClaims => ApiError::unauthorized("malformed token claims"),
    }
}

pub async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<LogoutResponse>, ApiError> {
    let raw_access = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(bearer_token)
        .ok_or_else(|| ApiError::unauthorized("missing bearer token"))?
        .to_string();

    // Signature + `typ` only. The revocation check is deliberately absent: a
    // second logout of an already-revoked token must stay a 200 (Swift :229-235).
    let principal = verify_app_access(&raw_access, &state.jwt_secret).map_err(logout_auth_error)?;
    let workspace_id = principal.workspace_id;

    // The body is optional in every shape (Swift decodes it with `try?`): no
    // body, a non-JSON body, or `{}` all mean "revoke the access token only".
    let requested: LogoutRequest = serde_json::from_slice(&body).unwrap_or_default();
    let raw_refresh = match requested.refresh_token {
        Some(raw) if !raw.is_empty() => {
            // Validate BEFORE revoking anything, so a mismatched body cannot
            // leave the session half-revoked behind an error response
            // (Swift :261-276). A refresh token belonging to someone else — or
            // to another workspace — is a 403, never a silent revoke.
            let refresh_principal = verify_app_refresh(&raw, &state.jwt_secret)
                .map_err(|_| ApiError::forbidden("refresh token does not match this session"))?;
            if refresh_principal.member_id != principal.member_id
                || refresh_principal.workspace_id != workspace_id
            {
                return Err(ApiError::forbidden(
                    "refresh token does not match this session",
                ));
            }
            Some(raw)
        }
        _ => None,
    };

    // Both revokes in one transaction (Swift uses two connections): a logout
    // that killed the access half but not the refresh half would leave the
    // session rotatable, which is precisely what logout must prevent.
    let (revoked_access, revoked_refresh) =
        with_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let access = revoke_token(conn, &raw_access)
                    .await
                    .map_err(DbError::from)?;
                let refresh = match raw_refresh {
                    Some(raw) => {
                        revoke_token(conn, &raw)
                            .await
                            .map_err(DbError::from)?
                            .revoked_now
                    }
                    None => false,
                };
                Ok::<(bool, bool), DbError>((access.revoked_now, refresh))
            })
        })
        .await
        .map_err(|error| db_error("auth.logout", error))?;

    // Swift also writes an `auth.logout` audit_log row here when something was
    // actually revoked (:288-297). Deferred — see the module deviation note.
    let already_revoked = !(revoked_access || revoked_refresh);
    Ok(Json(LogoutResponse {
        status: "ok",
        revoked_access,
        revoked_refresh,
        already_revoked,
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

    #[test]
    fn refresh_rejections_use_swift_wording_and_status() {
        let cases = [
            (AuthError::NotRefreshToken, 401, "not a refresh token"),
            (AuthError::MalformedClaims, 401, "malformed token claims"),
        ];
        for (error, status, message) in cases {
            let api = refresh_auth_error(error);
            assert_eq!(api.status.as_u16(), status);
            assert_eq!(api.message, message);
        }
        // An unverifiable token yields AuthError::InvalidToken without this
        // crate depending on the JWT library.
        let unverifiable = verify_app_refresh("not.a.jwt", "secret").expect_err("must not verify");
        let mapped = refresh_auth_error(unverifiable);
        assert_eq!(mapped.status.as_u16(), 401);
        assert_eq!(
            mapped.message, "invalid or expired refresh token",
            "the refresh route says 'refresh token', not the middleware's wording"
        );
    }

    #[test]
    fn logout_rejections_use_the_middleware_wording() {
        assert_eq!(
            logout_auth_error(AuthError::NotAccessToken).message,
            "not an access token"
        );
        let unverifiable = verify_app_access("not.a.jwt", "secret").expect_err("must not verify");
        assert_eq!(
            logout_auth_error(unverifiable).message,
            "invalid or expired token"
        );
        assert_eq!(
            logout_auth_error(AuthError::MalformedClaims)
                .status
                .as_u16(),
            401
        );
    }

    /// The refresh route can only ever hand a *downgraded* scope list to the
    /// new pair: this server never elevates, so carrying a privileged scope is
    /// by definition not re-issuable here (module deviation note).
    #[test]
    fn refresh_downgrades_a_privileged_scope_list() {
        let carried = vec![
            "messages:write".to_string(),
            "platform:read".to_string(),
            "messages:read".to_string(),
        ];
        assert!(carries_privileged_scope(&carried));
        assert_eq!(
            without_privileged_scopes(&carried),
            vec!["messages:write".to_string(), "messages:read".to_string()]
        );
        // An ordinary session round-trips unchanged (no gratuitous scope loss).
        let ordinary = base_scopes();
        assert!(!carries_privileged_scope(&ordinary));
        assert_eq!(without_privileged_scopes(&ordinary), ordinary);
    }

    /// **The blank path still lands on the demo workspace — the regression
    /// guard for goal B13 R2 High 1.**
    ///
    /// The connect form ships with this box EMPTY (`CONFIGURED_WORKSPACE`), the
    /// smoke harness omits it unless `MOMO_WORKSPACE` is set, and every client
    /// written before this batch sends nothing. Making an unusable value fail
    /// must not make "I named nothing" fail with it: that would lock everyone
    /// out of the default workspace at once.
    #[test]
    fn a_login_that_names_no_workspace_still_gets_the_default() {
        for absent in [None, Some(""), Some("   "), Some("\t\n")] {
            assert_eq!(
                resolve_login_workspace(absent).expect("blank is not an error"),
                DEMO_WORKSPACE_ID,
                "{absent:?} names nothing, which is not a mistake to report"
            );
        }
    }

    /// A named workspace is honoured, whatever case it arrives in.
    #[test]
    fn a_named_workspace_id_is_the_one_the_session_is_scoped_to() {
        let target = Uuid::from_u128(0x0199_aa11_2222_7000_8000_0000_0000_00d1);
        assert_eq!(
            resolve_login_workspace(Some(&target.to_string())).expect("a uuid"),
            target
        );
        assert_eq!(
            resolve_login_workspace(Some(&target.to_string().to_uppercase())).expect("a uuid"),
            target
        );
        // Surrounding whitespace is a paste artifact, not a different workspace.
        assert_eq!(
            resolve_login_workspace(Some(&format!("  {target}  "))).expect("a uuid"),
            target
        );
    }

    /// **A supplied-but-unusable workspace fails loudly instead of signing the
    /// person into a different tenant.**
    ///
    /// The old code parsed, discarded and fell back, so `workspace: "dawn-team"`
    /// logged you into the demo workspace and said nothing. The values below are
    /// exactly what a person reaches for when the box says "워크스페이스" and the
    /// product has never once shown them an id: the slug and the display name.
    ///
    /// The sentence must keep naming `workspace`, because the web client keys
    /// its Korean copy off that word.
    #[test]
    fn a_workspace_that_is_not_an_id_is_a_visible_400() {
        for typed in ["dawn-team", "우리 팀", "not-a-uuid", "00000000", "0"] {
            let rejection = resolve_login_workspace(Some(typed))
                .expect_err("a supplied value that cannot be a workspace id");
            assert_eq!(
                rejection.status,
                axum::http::StatusCode::BAD_REQUEST,
                "{typed:?} must be refused, never silently swapped for the default"
            );
            assert!(
                rejection.message.to_lowercase().contains("workspace"),
                "the client matches on this word to translate the refusal: {}",
                rejection.message
            );
        }
    }
}
