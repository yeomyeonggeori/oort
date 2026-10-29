//! ADR-0216 D6 (나) / #4700 — the **human-subject arm** of the OAuth authorization
//! server over HTTP: the endpoints `oort login` talks to.
//!
//! ```text
//! GET  /v1/oauth/authorize                                          public   client_id=oort-cli
//! POST /v1/oauth/token                                              public   code (+PKCE) | refresh
//! POST /v1/oauth/revoke                                             public   a login access/refresh
//! GET  /v1/workspaces/{ws}/dev-access/authorization-requests/preview  person
//! POST /v1/workspaces/{ws}/dev-access/authorization-requests/approve  person  + the current password
//! POST /v1/workspaces/{ws}/dev-access/authorization-requests/deny     person
//! ```
//!
//! The three public routes are the hosted adapter's
//! ([`super::agent_port_oauth`]): this module owns no path of its own there. Each of
//! them hands over at its first line when the request names the built-in client and the
//! arm is open ([`takes`]), **before** the hosted arm's own gate — so a server that has
//! the hosted arm closed (404) still serves `oort login`, and a server with this arm
//! closed answers `oort-cli` exactly as it answers any unknown client, because the hosted
//! code below that line is untouched.
//!
//! ## The two halves, and why nothing is stored by the first
//!
//! `GET /v1/oauth/authorize` is a browser arriving from a terminal with no oort
//! credential, so it writes **nothing**: it validates the request against the built-in
//! client's fixed loopback list and hands the browser one signed, ten-minute envelope
//! (`momo_auth::dev_login`), addressed to the consent screen. The person, the workspace and
//! the decision are resolved on the other side, in the authenticated, tenant-scoped
//! consent routes, where one ledger row finally exists, keyed on the envelope's nonce so
//! exactly one terminal decision survives.
//!
//! **The order of the authorize checks is the open-redirect defence.** The redirect URI
//! is compared with the built-in list first, and until it matches a failure is a plain
//! 400 that sends the browser nowhere. Only then may a refusal be an error redirect. The
//! redirect a consent route finally answers with is the envelope's own `ru` — compared
//! with the list again at the moment it is used.
//!
//! ## Approval is the card route's transaction, with a code at the end
//!
//! [`approve`] runs the order [`super::dev_access::issue`] runs, for the same reasons:
//! the walls (a developer token is refused twice) → the password budget's cheap look →
//! the body → one tenant transaction that takes the workspace's membership lock
//! **shared** first and without waiting, re-checks that the calling session is alive,
//! judges the switch, courtesy-checks the lineage limit, takes an atomic slot of the
//! **same** budget key (`dev-pw:{ws}:{member}`, so a card and a login together get five
//! wrong passwords a window, not five each), compares the password and only then writes the
//! ledger row. Every refusal found inside is returned as a value after its audit row is
//! written, so the transaction commits the audit row and no ledger row.
//!
//! One consequence worth knowing: the nonce's uniqueness is enforced by the INSERT, i.e.
//! **after** the password comparison. A second approval of the same request with the right
//! password is 409 `dev_login_already_decided`; with a wrong one it is 403. That is the
//! order of the card route (a refusal that needs the row comes after the one that needs
//! the secret), and no pre-read was added to change it.
//!
//! ## The exchange (public, no session)
//!
//! `POST /v1/oauth/token` with `grant_type=authorization_code` finds the workspace in the
//! code's own prefix, opens that tenant's transaction and runs, in this order: lock the
//! code (none → refused) → **a consumed code presented again ends the lineage its first use
//! opened, is audited, and the transaction commits** → a binding that does not match
//! (client, redirect, PKCE, resource, expiry) is refused **without burning the code**, so
//! the holder of the real verifier can still redeem it → redeem, which judges the member a
//! second time and opens the lineage. Every refusal is the same bytes, `invalid_grant`,
//! whatever the reason.
//!
//! ## Audit never changes an answer
//!
//! ADR-0216 D9: a failed audit write changes no response. Every audit row here is written
//! inside a savepoint ([`audit`]); a failure rolls the savepoint back, is logged, and the
//! decision it describes stands — in particular a replayed code's lineage revocation can
//! never be rolled back by its own audit row.

use std::time::Instant;

use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use momo_auth::{
    active_workspace_role, approve_dev_login_request_in_tx, count_live_dev_lineages_in_tx,
    deny_dev_login_request_in_tx, dev_login_code_workspace_id, dev_login_request_key,
    dev_refresh_workspace_id, dev_token_workspace_id, has_active_realtime_credential,
    lock_dev_login_code_in_tx, normalized_current_password, normalized_dev_device_name,
    normalized_dev_scopes, redeem_dev_login_code_in_tx, resolve_dev_login_revocation_target_in_tx,
    revoke_dev_credential_in_tx, revoke_dev_login_lineage_in_tx, sign_dev_login_request,
    verify_current_password_in_tx, verify_dev_login_request, DevLoginApproval, DevLoginRedeem,
    DevLoginRefusal, DevLoginRequestClaims, DevLoginRequestSeed, DevRotation, IssuedDevLogin,
    PasswordCheck, Principal, WorkspaceRole, DEV_ACCESS_TTL_SECONDS, DEV_FIXED_POLICY,
    DEV_LOGIN_LABEL, DEV_MAX_LIFETIME_DAYS, DEV_MAX_LIVE_LINEAGES, DEV_READ_ONLY_SCOPES,
    DEV_REFRESH_IDLE_DAYS, DEV_SCOPES, SCOPE_DEV_MESSAGES_WRITE,
};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{with_tenant_tx, DbError, PgConnection};
use momo_mcp::oauth::{
    authorization_redirect, oort_cli_redirect_uri_is_registered, parse_requested_scopes,
    percent_encode_query_value, validate_code_challenge, validate_resource, validate_state,
    verify_pkce_s256, OauthError, CODE_CHALLENGE_METHOD_S256, GRANT_TYPE_AUTHORIZATION_CODE,
    GRANT_TYPE_REFRESH_TOKEN, OORT_CLI_CLIENT_ID, RESPONSE_TYPE_CODE, TOKEN_TYPE_BEARER,
};
use momo_messaging::{get_member, get_workspace, is_active_human_member, MemberKind};
use momo_settings::try_share_membership_state;
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use super::agent_port_oauth::{
    authorization_refusal, chrono_now_seconds, found, no_store, oauth_failure, AuthorizeQuery,
    RevokeForm, TokenForm,
};
use crate::config::AgentPortOauthConfig;
use crate::dev_credential::DevCredential;
use crate::dto::{
    DevLoginApproveRequest, DevLoginDecisionResponse, DevLoginDenyRequest, DevLoginPreviewResponse,
    OptionalPatch,
};
use crate::error::ApiError;
use crate::routes::auth_routes::MEMBERSHIP_BUSY_RETRY_SECONDS;
use crate::routes::dev_access::{
    log_password_budget_full, password_recheck_exhausted, password_recheck_key,
    password_recheck_window, refund_password_recheck, refuse_developer_token,
    reserve_password_recheck, too_many_password_failures, AUDIT_REVOKED, AUDIT_TARGET,
    CODE_ACCESS_DENIED, CODE_CREDENTIAL_LIMIT, CODE_PASSWORD_INCORRECT, CODE_PASSWORD_UNAVAILABLE,
    POLICY, SCHEMA_REVOKED,
};
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, require_human, settle_db, workspace_scope, DbRejectable,
};
use crate::AppState;

/// `scopes_supported` of this arm in the authorization-server metadata.
pub(super) const SCOPES_SUPPORTED: [&str; 5] = DEV_SCOPES;

/// Refusal codes a client branches on (`error.code`). The three the card route already
/// speaks are re-used from there so each sentence has one source.
const CODE_REQUEST_NOT_FOUND: &str = "dev_login_request_not_found";
const CODE_ALREADY_DECIDED: &str = "dev_login_already_decided";

/// Lifecycle audit (D9). `detail` is a closed vocabulary: never a device name, a channel id,
/// a body, a code, a token or a password.
pub const AUDIT_CONSENT_GRANTED: &str = "dev_token.consent_granted";
pub const AUDIT_CONSENT_DENIED: &str = "dev_token.consent_denied";
pub const AUDIT_CONSENT_REFUSED: &str = "dev_token.consent_refused";
pub const AUDIT_LOGIN_ISSUED: &str = "dev_token.login_issued";
pub const AUDIT_CODE_REPLAYED: &str = "dev_token.code_replayed";
const SCHEMA_CONSENT_GRANTED: &str = "momo.dev_token.consent_granted.v1";
const SCHEMA_CONSENT_DENIED: &str = "momo.dev_token.consent_denied.v1";
const SCHEMA_CONSENT_REFUSED: &str = "momo.dev_token.consent_refused.v1";
const SCHEMA_LOGIN_ISSUED: &str = "momo.dev_token.login_issued.v1";
const SCHEMA_CODE_REPLAYED: &str = "momo.dev_token.code_replayed.v1";
/// Audit targets: the ledger row of a decision, and the lineage a code opened.
const TARGET_REQUEST: &str = "dev_login_request";
const TARGET_LINEAGE: &str = "dev_lineage";

// ---------------------------------------------------------------------------
// the branch
// ---------------------------------------------------------------------------

/// The one predicate the three public routes ask first: the request names the built-in
/// client **and** this arm is open. Anything else — another client, this arm closed — is the
/// hosted adapter's, unchanged, so a closed arm cannot be told from an unknown client.
pub(super) fn takes(oauth: &AgentPortOauthConfig, client_id: Option<&str>) -> bool {
    client_id == Some(OORT_CLI_CLIENT_ID) && oauth.dev_login_enabled()
}

// ---------------------------------------------------------------------------
// GET /v1/oauth/authorize
// ---------------------------------------------------------------------------

/// `GET /v1/oauth/authorize` for `client_id=oort-cli`.
///
/// Writes nothing and authenticates nobody (module docs). The redirect URI is judged
/// against the built-in list first; every later refusal is an error redirect to it.
pub(super) fn authorize(state: &AppState, query: &AuthorizeQuery) -> Response {
    let oauth = &state.agent_port.config.oauth;
    let (Some(issuer), Some(canonical_resource), Some(consent_url)) = (
        oauth.dev_login_issuer(),
        oauth.dev_login_resource(),
        oauth.dev_login_consent_url(),
    ) else {
        // `takes` already proved the arm open; failing closed is the answer to an
        // unknown client.
        return authorization_refusal(OauthError::InvalidClient);
    };

    let Some(redirect_uri) = query
        .redirect_uri
        .as_deref()
        .filter(|value| oort_cli_redirect_uri_is_registered(value))
    else {
        return authorization_refusal(OauthError::InvalidRequest);
    };

    // From here every refusal is an error redirect to a URI that is on the fixed list.
    let state_value = match validate_state(query.state.as_deref()) {
        Ok(state_value) => state_value,
        Err(error) => {
            return found(&authorization_redirect(
                redirect_uri,
                issuer,
                None,
                Err(error),
            ))
        }
    };
    let refuse = |error: OauthError| {
        found(&authorization_redirect(
            redirect_uri,
            issuer,
            state_value.as_deref(),
            Err(error),
        ))
    };

    if query.response_type.as_deref() != Some(RESPONSE_TYPE_CODE) {
        return refuse(OauthError::UnsupportedResponseType);
    }
    if let Err(error) = validate_resource(query.resource.as_deref(), &canonical_resource) {
        return refuse(error);
    }
    let Some(code_challenge) = query.code_challenge.as_deref() else {
        return refuse(OauthError::InvalidRequest);
    };
    if let Err(error) =
        validate_code_challenge(code_challenge, query.code_challenge_method.as_deref())
    {
        return refuse(error);
    }
    // `scope` is required and must be spelled in the `dev:` vocabulary; an unknown or
    // repeated entry is a refusal, never a silent drop (the consent screen's list is the
    // list the credential ends up with). `dev:identity` is then added in canonical order.
    let requested = match parse_requested_scopes(query.scope.as_deref(), &DEV_SCOPES) {
        Ok(requested) => requested,
        Err(error) => return refuse(error),
    };
    let Ok(scopes) = normalized_dev_scopes(Some(&requested)) else {
        return refuse(OauthError::InvalidScope);
    };
    // Only a value that passes the credential's own rule is ever signed (<= 80 characters,
    // no control characters, no envelope material); a blank one is no name.
    let Ok(device_name) = normalized_dev_device_name(query.device_name.as_deref()) else {
        return refuse(OauthError::InvalidRequest);
    };

    let envelope = sign_dev_login_request(
        &dev_login_request_key(&state.jwt_secret),
        DevLoginRequestSeed {
            nonce: Uuid::new_v4(),
            client_id: OORT_CLI_CLIENT_ID,
            redirect_uri,
            resource: &canonical_resource,
            scopes: &scopes,
            code_challenge,
            code_challenge_method: CODE_CHALLENGE_METHOD_S256,
            state: state_value.as_deref(),
            device_name: device_name.as_deref(),
        },
        chrono_now_seconds(),
    );
    let Ok(envelope) = envelope else {
        return refuse(OauthError::ServerError);
    };
    let separator = if consent_url.contains('?') { '&' } else { '?' };
    found(&format!(
        "{consent_url}{separator}request={}",
        percent_encode_query_value(&envelope)
    ))
}

// ---------------------------------------------------------------------------
// the consent routes: shared pieces
// ---------------------------------------------------------------------------

/// One sentence for every way a request can fail to be a consentable one — forged,
/// expired, another kind of envelope, another client, a resource or redirect that is no
/// longer current, or this arm closed — so the route is no oracle for any of them.
fn request_not_found() -> ApiError {
    ApiError::coded(
        StatusCode::NOT_FOUND,
        CODE_REQUEST_NOT_FOUND,
        "login request not found",
    )
}

fn already_decided() -> ApiError {
    ApiError::coded(
        StatusCode::CONFLICT,
        CODE_ALREADY_DECIDED,
        "this login request already has a decision",
    )
}

fn access_denied() -> ApiError {
    ApiError::coded(
        StatusCode::FORBIDDEN,
        CODE_ACCESS_DENIED,
        "developer access is not allowed for this member's role",
    )
}

fn invalid_field(field: &str) -> ApiError {
    ApiError::bad_request(format!("invalid {field}"))
}

/// A body or query the extractor could not read is a 400 that quotes nothing from it:
/// serde's messages can repeat a value, and that value could be a password typed into the
/// wrong field.
fn unreadable_request() -> ApiError {
    ApiError::bad_request("invalid login request")
}

/// The consent routes answer `no-store` whatever they answer: a decision, an error and a
/// preview are all about one browser's one request, and no cache may replay any of them.
fn finish(result: Result<Response, ApiError>) -> Response {
    no_store(match result {
        Ok(response) => response,
        Err(error) => error.into_response(),
    })
}

/// A person, and only a person: the principal kind the developer door builds for a
/// developer token is `Human` too, which is why [`refuse_developer_token`] exists — this
/// is the other check. A non-human is told what a refused role is told.
fn require_person(principal: &Principal) -> Result<(), ApiError> {
    require_human(principal, "developer access is not allowed for this member")
        .map_err(|_| access_denied())
}

/// The issuer of the open arm, or the one 404 a closed arm answers.
fn open_issuer(state: &AppState) -> Result<String, ApiError> {
    state
        .agent_port
        .config
        .oauth
        .dev_login_issuer()
        .map(str::to_string)
        .ok_or_else(request_not_found)
}

/// The envelope still describes something this server would approve today. The signature
/// already proves the server minted it; this proves it was minted for the built-in client,
/// for the resource and redirect this configuration still names, with a scope list that is
/// its own canonical form. Pure, and checked again at the moment the redirect is used.
fn claims_are_current(oauth: &AgentPortOauthConfig, claims: &DevLoginRequestClaims) -> bool {
    claims.cid == OORT_CLI_CLIENT_ID
        && oauth.dev_login_resource().as_deref() == Some(claims.res.as_str())
        && oort_cli_redirect_uri_is_registered(&claims.ru)
        && claims.ccm == CODE_CHALLENGE_METHOD_S256
        && validate_code_challenge(&claims.cc, Some(claims.ccm.as_str())).is_ok()
        && validate_state(claims.st.as_deref()).is_ok_and(|state| state == claims.st)
        && normalized_dev_device_name(claims.dn.as_deref()).is_ok_and(|name| name == claims.dn)
        && normalized_dev_scopes(Some(&claims.scp)).is_ok_and(|scopes| scopes == claims.scp)
}

fn verified_claims(state: &AppState, presented: &str) -> Result<DevLoginRequestClaims, ApiError> {
    let oauth = &state.agent_port.config.oauth;
    let claims = verify_dev_login_request(&dev_login_request_key(&state.jwt_secret), presented)
        .map_err(|_| request_not_found())?;
    if !claims_are_current(oauth, &claims) {
        return Err(request_not_found());
    }
    Ok(claims)
}

/// Where the browser goes next: the envelope's own redirect, which must be on the built-in
/// list **now** — the list is checked again at the moment of use, not only when the request
/// was signed.
fn decision_redirect(
    claims: &DevLoginRequestClaims,
    issuer: &str,
    outcome: Result<&str, OauthError>,
) -> Result<String, ApiError> {
    if !oort_cli_redirect_uri_is_registered(&claims.ru) {
        return Err(request_not_found());
    }
    Ok(authorization_redirect(
        &claims.ru,
        issuer,
        claims.st.as_deref(),
        outcome,
    ))
}

/// The host a person must recognise as the server they are connecting to: the authority of
/// the operator's configured issuer. Never a request header.
fn server_host(issuer: &str) -> String {
    let authority = issuer.split_once("://").map_or(issuer, |(_, rest)| rest);
    let authority = authority.split(['/', '?', '#']).next().unwrap_or(authority);
    authority
        .rsplit('@')
        .next()
        .unwrap_or(authority)
        .to_string()
}

/// The scopes an approval grants. Omitted is 「읽기만」 ∩ what the request named; a list is
/// normalized (vocabulary, order, `dev:identity` always) and must be a subset of what the
/// request named. `[]` and `null` are refused: the normalizer would quietly turn the first
/// into whoami-only and the second would pick a default nobody chose.
fn resolve_approved_scopes(
    requested: &[String],
    chosen: &OptionalPatch<Vec<String>>,
) -> Result<Vec<String>, ApiError> {
    let wanted: Vec<String> = match chosen {
        OptionalPatch::Absent => DEV_READ_ONLY_SCOPES
            .iter()
            .filter(|scope| requested.iter().any(|asked| asked == **scope))
            .map(|scope| scope.to_string())
            .collect(),
        OptionalPatch::Set(Some(list)) if !list.is_empty() => list.clone(),
        OptionalPatch::Set(_) => return Err(invalid_field("approvedScopes")),
    };
    let approved =
        normalized_dev_scopes(Some(&wanted)).map_err(|_| invalid_field("approvedScopes"))?;
    if approved
        .iter()
        .all(|scope| requested.iter().any(|asked| asked == scope))
    {
        Ok(approved)
    } else {
        Err(invalid_field("approvedScopes"))
    }
}

/// Why a consent was refused after the caller was identified. Each one writes one
/// `dev_token.consent_refused` row whose `detail.reason` is [`ConsentRefusal::reason`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConsentRefusal {
    /// The switch does not admit the caller's role (or the caller is not an active member).
    Policy,
    /// The member is not a human.
    NotHuman,
    /// The current password did not match. The one refusal the failure budget counts.
    PasswordMismatch,
    /// The account has no password to re-check.
    PasswordUnavailable,
    /// The member already holds the most login lineages the limit allows.
    Limit,
}

impl ConsentRefusal {
    /// `detail.reason` — the closed vocabulary.
    fn reason(self) -> &'static str {
        match self {
            ConsentRefusal::Policy => "policy_denied",
            ConsentRefusal::NotHuman => "not_human",
            ConsentRefusal::PasswordMismatch => "password_mismatch",
            ConsentRefusal::PasswordUnavailable => "password_unavailable",
            ConsentRefusal::Limit => "limit",
        }
    }

    fn error(self) -> ApiError {
        match self {
            ConsentRefusal::Policy | ConsentRefusal::NotHuman => access_denied(),
            ConsentRefusal::PasswordMismatch => ApiError::coded(
                StatusCode::FORBIDDEN,
                CODE_PASSWORD_INCORRECT,
                "current password is incorrect",
            ),
            ConsentRefusal::PasswordUnavailable => ApiError::coded(
                StatusCode::FORBIDDEN,
                CODE_PASSWORD_UNAVAILABLE,
                "this account has no password to confirm",
            ),
            ConsentRefusal::Limit => ApiError::coded(
                StatusCode::CONFLICT,
                CODE_CREDENTIAL_LIMIT,
                "developer credential limit reached",
            ),
        }
    }
}

// ---------------------------------------------------------------------------
// audit (never changes an answer — module docs)
// ---------------------------------------------------------------------------

/// Write one audit row inside a savepoint. A failed write rolls the savepoint back and is
/// logged; the surrounding transaction — and the decision, revocation or issuance in it —
/// carries on. Only a failure of the savepoint itself (a broken connection) is an error,
/// and then nothing could have continued anyway.
async fn audit(conn: &mut PgConnection, entry: AuditEntry) -> Result<(), DbError> {
    let mut savepoint = momo_db::sqlx::Connection::begin(&mut *conn)
        .await
        .map_err(DbError::from)?;
    match write_audit(&mut savepoint, &entry).await {
        Ok(_) => savepoint.commit().await.map_err(DbError::from)?,
        Err(error) => {
            savepoint.rollback().await.map_err(DbError::from)?;
            tracing::error!(
                error = %error,
                action = %entry.action,
                "developer login audit failed; the decision stands"
            );
        }
    }
    Ok(())
}

/// Write the refusal's audit row and return the refusal as a value, so the transaction
/// commits the row (and nothing else).
async fn refuse<T>(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    via_token: Option<Uuid>,
    refusal: ConsentRefusal,
) -> DbRejectable<T> {
    audit(
        conn,
        AuditEntry::new(workspace_id, AUDIT_CONSENT_REFUSED)
            .by(member_id)
            .via_token(via_token)
            .with_schema(
                SCHEMA_CONSENT_REFUSED,
                json!({ "reason": refusal.reason() }),
            ),
    )
    .await?;
    Ok(Err(refusal.error()))
}

// ---------------------------------------------------------------------------
// GET …/authorization-requests/preview
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct PreviewQuery {
    request: String,
}

/// What the screen shows about the person and the workspace.
struct PreviewFacts {
    role: WorkspaceRole,
    workspace_name: String,
    member_display_name: String,
}

/// `GET /v1/workspaces/{ws}/dev-access/authorization-requests/preview?request=<envelope>`
pub async fn preview(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    dev_credential: Option<Extension<DevCredential>>,
    Path(workspace): Path<String>,
    query: Result<Query<PreviewQuery>, QueryRejection>,
) -> Response {
    finish(preview_inner(state, principal, dev_credential.is_some(), workspace, query).await)
}

async fn preview_inner(
    state: AppState,
    principal: Principal,
    by_developer_token: bool,
    workspace: String,
    query: Result<Query<PreviewQuery>, QueryRejection>,
) -> Result<Response, ApiError> {
    refuse_developer_token(by_developer_token)?;
    require_person(&principal)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let issuer = open_issuer(&state)?;
    let Query(query) = query.map_err(|_| unreadable_request())?;
    let claims = verified_claims(&state, &query.request)?;
    let member_id = principal.member_id;

    let outcome: DbRejectable<PreviewFacts> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                // The switch (D3): a role it refuses is told so here, before it reads a
                // screen it could never act on.
                let role = active_workspace_role(conn, workspace_id, member_id).await?;
                let Some(role) = role.filter(|role| POLICY.allows(*role)) else {
                    return Ok(Err(access_denied()));
                };
                let Some(member) = get_member(conn, member_id).await? else {
                    return Ok(Err(access_denied()));
                };
                if member.kind != MemberKind::Human {
                    return Ok(Err(access_denied()));
                }
                let Some(workspace) = get_workspace(conn, workspace_id).await? else {
                    return Ok(Err(ApiError::not_found("workspace not found")));
                };
                Ok(Ok(PreviewFacts {
                    role,
                    workspace_name: workspace.name,
                    member_display_name: member.display_name,
                }))
            })
        })
        .await;
    let facts = settle_db("dev_login.preview", outcome)?;

    Ok(Json(DevLoginPreviewResponse {
        client_name: DEV_LOGIN_LABEL,
        client_id: OORT_CLI_CLIENT_ID,
        server_host: server_host(&issuer),
        issuer,
        workspace_id: workspace_id.to_string(),
        workspace_name: facts.workspace_name,
        member_display_name: facts.member_display_name,
        role: facts.role.as_db_label(),
        device_name: claims.dn.clone(),
        can_send: claims
            .scp
            .iter()
            .any(|scope| scope == SCOPE_DEV_MESSAGES_WRITE),
        requested_scopes: claims.scp.clone(),
        expires_at_ms: (claims.exp as i64) * 1000,
        access_minutes: DEV_ACCESS_TTL_SECONDS / 60,
        idle_days: DEV_REFRESH_IDLE_DAYS,
        max_days: DEV_MAX_LIFETIME_DAYS,
    })
    .into_response())
}

// ---------------------------------------------------------------------------
// POST …/authorization-requests/approve
// ---------------------------------------------------------------------------

/// `POST /v1/workspaces/{ws}/dev-access/authorization-requests/approve`
///
/// One tenant transaction: the membership lock, the session's liveness, the switch, the
/// limit, the password under the budget's atomic slot, and — only then — the ledger row
/// and its one-time code. The raw code leaves the process once, inside `redirectTo`.
pub async fn approve(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    dev_credential: Option<Extension<DevCredential>>,
    Path(workspace): Path<String>,
    body: Result<Json<DevLoginApproveRequest>, JsonRejection>,
) -> Response {
    finish(approve_inner(state, principal, dev_credential.is_some(), workspace, body).await)
}

async fn approve_inner(
    state: AppState,
    principal: Principal,
    by_developer_token: bool,
    workspace: String,
    body: Result<Json<DevLoginApproveRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    refuse_developer_token(by_developer_token)?;
    require_person(&principal)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let issuer = open_issuer(&state)?;
    let member_id = principal.member_id;

    // The budget's cheap look, before the body and before any database work: a member
    // whose window is full is turned away here, right password or not.
    let budget_key = password_recheck_key(workspace_id, member_id);
    let window = password_recheck_window(&state.rate_limit.config);
    if let Some(retry_after) =
        password_recheck_exhausted(&state.rate_limit.limiter, &budget_key, window)
    {
        return Err(too_many_password_failures(retry_after));
    }

    let Json(request) = body.map_err(|_| unreadable_request())?;
    let current_password = normalized_current_password(&request.current_password)
        .map_err(|_| invalid_field("currentPassword"))?;
    let claims = verified_claims(&state, &request.request)?;
    // A body check, before any slot is spent: an approval outside the request never gets
    // a password comparison. The ledger refuses it again as the second wall.
    let approved = resolve_approved_scopes(&claims.scp, &request.approved_scopes)?;
    // The session this request came in on; a person's access token always has its row.
    let session_token_id = principal
        .token_id
        .ok_or_else(|| ApiError::unauthorized("invalid or expired token"))?;
    let via_token = audit_via_token_id(&principal);
    let rate_limit = state.rate_limit.clone();
    let claims_for_tx = claims.clone();

    let outcome: DbRejectable<DevLoginApproval> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                // (1) The membership lock, shared, first, without waiting (#4695).
                if !try_share_membership_state(conn, workspace_id).await? {
                    return Ok(Err(ApiError::busy(MEMBERSHIP_BUSY_RETRY_SECONDS)));
                }
                // (2) The calling session is still alive, read after the lock so a password
                //     change either committed first and is seen here, or waits for this
                //     commit and then sweeps what this approval wrote.
                if !has_active_realtime_credential(conn, session_token_id, member_id, workspace_id)
                    .await?
                {
                    return Ok(Err(ApiError::unauthorized("invalid or expired token")));
                }
                // (3) The switch (D3), before the password: a role it refuses never gets a
                //     comparison, so it never costs or learns anything.
                let role = active_workspace_role(conn, workspace_id, member_id).await?;
                if !role.is_some_and(|role| POLICY.allows(role)) {
                    return refuse(
                        conn,
                        workspace_id,
                        member_id,
                        via_token,
                        ConsentRefusal::Policy,
                    )
                    .await;
                }
                if !is_active_human_member(conn, workspace_id, member_id).await? {
                    return refuse(
                        conn,
                        workspace_id,
                        member_id,
                        via_token,
                        ConsentRefusal::NotHuman,
                    )
                    .await;
                }
                // (4) The lineage limit, as a courtesy look before a password attempt is
                //     spent on a login the exchange could not open. Judged again, under
                //     its lock, when the code is redeemed.
                if count_live_dev_lineages_in_tx(conn, workspace_id, member_id).await?
                    >= DEV_MAX_LIVE_LINEAGES
                {
                    return refuse(
                        conn,
                        workspace_id,
                        member_id,
                        via_token,
                        ConsentRefusal::Limit,
                    )
                    .await;
                }
                // (5) The current password, under the failure budget's atomic slot — the
                //     budget the card route spends from.
                let slot = match reserve_password_recheck(
                    &rate_limit.limiter,
                    &budget_key,
                    window,
                    Instant::now(),
                ) {
                    Ok(slot) => slot,
                    Err(verdict) => {
                        if verdict.should_log {
                            log_password_budget_full(workspace_id, member_id);
                        }
                        return Ok(Err(too_many_password_failures(verdict.retry_after_seconds)));
                    }
                };
                match verify_current_password_in_tx(
                    conn,
                    workspace_id,
                    member_id,
                    &current_password,
                )
                .await?
                {
                    PasswordCheck::Ok => {
                        refund_password_recheck(&rate_limit.limiter, &budget_key, slot)
                    }
                    PasswordCheck::NoPassword => {
                        // Not a guess: there is nothing to guess against.
                        refund_password_recheck(&rate_limit.limiter, &budget_key, slot);
                        return refuse(
                            conn,
                            workspace_id,
                            member_id,
                            via_token,
                            ConsentRefusal::PasswordUnavailable,
                        )
                        .await;
                    }
                    // The slot stays spent: this is the failure the budget counts.
                    PasswordCheck::Mismatch => {
                        return refuse(
                            conn,
                            workspace_id,
                            member_id,
                            via_token,
                            ConsentRefusal::PasswordMismatch,
                        )
                        .await;
                    }
                }
                // (6) The ledger row and its code.
                match approve_dev_login_request_in_tx(
                    conn,
                    workspace_id,
                    member_id,
                    &claims_for_tx,
                    &approved,
                )
                .await?
                {
                    Ok(approval) => {
                        audit(
                            conn,
                            AuditEntry::new(workspace_id, AUDIT_CONSENT_GRANTED)
                                .by(member_id)
                                .via_token(via_token)
                                .target(TARGET_REQUEST, approval.request_id)
                                .with_schema(
                                    SCHEMA_CONSENT_GRANTED,
                                    json!({ "decision": "approved", "scopes": approved }),
                                ),
                        )
                        .await?;
                        Ok(Ok(approval))
                    }
                    Err(DevLoginRefusal::AlreadyDecided) => Ok(Err(already_decided())),
                    Err(DevLoginRefusal::NotFound) => Ok(Err(request_not_found())),
                    Err(DevLoginRefusal::InvalidApproval) => {
                        Ok(Err(invalid_field("approvedScopes")))
                    }
                }
            })
        })
        .await;
    let approval = settle_db("dev_login.approve", outcome)?;

    let redirect_to = decision_redirect(&claims, &issuer, Ok(&approval.authorization_code))?;
    Ok(Json(DevLoginDecisionResponse { redirect_to }).into_response())
}

// ---------------------------------------------------------------------------
// POST …/authorization-requests/deny
// ---------------------------------------------------------------------------

/// `POST /v1/workspaces/{ws}/dev-access/authorization-requests/deny`
///
/// A denial is a terminal decision on the same nonce, so it makes a later approval inert
/// (409). Nothing is issued. Back, close and timeout are all equivalent to never calling
/// this at all, which is also capability zero.
pub async fn deny(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    dev_credential: Option<Extension<DevCredential>>,
    Path(workspace): Path<String>,
    body: Result<Json<DevLoginDenyRequest>, JsonRejection>,
) -> Response {
    finish(deny_inner(state, principal, dev_credential.is_some(), workspace, body).await)
}

async fn deny_inner(
    state: AppState,
    principal: Principal,
    by_developer_token: bool,
    workspace: String,
    body: Result<Json<DevLoginDenyRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    refuse_developer_token(by_developer_token)?;
    require_person(&principal)?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let issuer = open_issuer(&state)?;
    let Json(request) = body.map_err(|_| unreadable_request())?;
    let claims = verified_claims(&state, &request.request)?;
    let member_id = principal.member_id;
    let session_token_id = principal
        .token_id
        .ok_or_else(|| ApiError::unauthorized("invalid or expired token"))?;
    let via_token = audit_via_token_id(&principal);
    let claims_for_tx = claims.clone();

    let outcome: DbRejectable<()> = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            // The same first three steps as an approval: a denial is a terminal decision
            // too, so it is made by a live session of a person the switch admits.
            if !try_share_membership_state(conn, workspace_id).await? {
                return Ok(Err(ApiError::busy(MEMBERSHIP_BUSY_RETRY_SECONDS)));
            }
            if !has_active_realtime_credential(conn, session_token_id, member_id, workspace_id)
                .await?
            {
                return Ok(Err(ApiError::unauthorized("invalid or expired token")));
            }
            let role = active_workspace_role(conn, workspace_id, member_id).await?;
            if !role.is_some_and(|role| POLICY.allows(role)) {
                return refuse(
                    conn,
                    workspace_id,
                    member_id,
                    via_token,
                    ConsentRefusal::Policy,
                )
                .await;
            }
            if !is_active_human_member(conn, workspace_id, member_id).await? {
                return refuse(
                    conn,
                    workspace_id,
                    member_id,
                    via_token,
                    ConsentRefusal::NotHuman,
                )
                .await;
            }
            match deny_dev_login_request_in_tx(conn, workspace_id, member_id, &claims_for_tx)
                .await?
            {
                Ok(request_id) => {
                    audit(
                        conn,
                        AuditEntry::new(workspace_id, AUDIT_CONSENT_DENIED)
                            .by(member_id)
                            .via_token(via_token)
                            .target(TARGET_REQUEST, request_id)
                            .with_schema(SCHEMA_CONSENT_DENIED, json!({ "decision": "denied" })),
                    )
                    .await?;
                    Ok(Ok(()))
                }
                Err(DevLoginRefusal::AlreadyDecided) => Ok(Err(already_decided())),
                Err(DevLoginRefusal::NotFound | DevLoginRefusal::InvalidApproval) => {
                    Ok(Err(request_not_found()))
                }
            }
        })
    })
    .await;
    settle_db("dev_login.deny", outcome)?;

    let redirect_to = decision_redirect(&claims, &issuer, Err(OauthError::AccessDenied))?;
    Ok(Json(DevLoginDecisionResponse { redirect_to }).into_response())
}

// ---------------------------------------------------------------------------
// POST /v1/oauth/token
// ---------------------------------------------------------------------------

/// `POST /v1/oauth/token` for `client_id=oort-cli`: the authorization-code exchange and the
/// refresh rotation.
///
/// `resource` is optional here (the code already carries the one this arm protects); when
/// present it must be that exact string. Every refusal of a presented code, verifier or
/// refresh is the same `invalid_grant` bytes.
pub(super) async fn token(state: &AppState, form: &TokenForm) -> Response {
    match form.grant_type.as_deref() {
        Some(GRANT_TYPE_AUTHORIZATION_CODE) => exchange_code(state, form).await,
        Some(GRANT_TYPE_REFRESH_TOKEN) => refresh(state, form).await,
        _ => oauth_failure(OauthError::UnsupportedGrantType),
    }
}

/// What the code exchange is judged against, borrowed from the form and the config.
struct CodeExchange<'a> {
    raw_code: &'a str,
    verifier: &'a str,
    redirect_uri: &'a str,
    /// What the request named, when it named anything.
    presented_resource: Option<&'a str>,
    canonical_resource: &'a str,
}

async fn exchange_code(state: &AppState, form: &TokenForm) -> Response {
    let oauth = &state.agent_port.config.oauth;
    let Some(canonical_resource) = oauth.dev_login_resource() else {
        return oauth_failure(OauthError::InvalidClient);
    };
    let (Some(raw_code), Some(verifier), Some(redirect_uri)) = (
        form.code.as_deref(),
        form.code_verifier.as_deref(),
        form.redirect_uri.as_deref(),
    ) else {
        return oauth_failure(OauthError::InvalidRequest);
    };
    // The workspace is the code's own prefix: the API role is NOBYPASSRLS, so the tenant
    // transaction has to be opened before any row can be found. Nothing else is read from it.
    let Some(workspace_id) = dev_login_code_workspace_id(raw_code) else {
        return oauth_failure(OauthError::InvalidGrant);
    };

    let raw_code = raw_code.to_string();
    let verifier = verifier.to_string();
    let redirect_uri = redirect_uri.to_string();
    let presented_resource = form.resource.clone();
    let outcome = with_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            redeem_in_tx(
                conn,
                workspace_id,
                CodeExchange {
                    raw_code: &raw_code,
                    verifier: &verifier,
                    redirect_uri: &redirect_uri,
                    presented_resource: presented_resource.as_deref(),
                    canonical_resource: &canonical_resource,
                },
            )
            .await
        })
    })
    .await;
    settle_login(
        outcome,
        workspace_id,
        "oauth.dev_login.token.authorization_code",
    )
}

/// The exchange's transaction. **Every** exit is `Ok(..)`: a refusal that must persist (a
/// replayed code's lineage revocation, a burned code) commits because the closure returns
/// `Ok`; only a database failure rolls back.
async fn redeem_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    exchange: CodeExchange<'_>,
) -> Result<Result<IssuedDevLogin, OauthError>, DbError> {
    let Some(locked) = lock_dev_login_code_in_tx(conn, workspace_id, exchange.raw_code)
        .await
        .map_err(DbError::from)?
    else {
        return Ok(Err(OauthError::InvalidGrant));
    };
    // A code presented twice is a compromise signal, not a mistake: the lineage the first
    // use opened ends here, in the transaction that refuses the second, and is recorded once.
    if locked.status == "consumed" {
        let revoked = revoke_dev_login_lineage_in_tx(conn, workspace_id, &locked)
            .await
            .map_err(DbError::from)?;
        let entry = AuditEntry::new(workspace_id, AUDIT_CODE_REPLAYED).about(locked.member_id);
        let entry = match locked.session_id {
            Some(session_id) => entry.target(TARGET_LINEAGE, session_id),
            None => entry.target(TARGET_REQUEST, locked.request_id),
        };
        audit(
            conn,
            entry.with_schema(
                SCHEMA_CODE_REPLAYED,
                json!({
                    "credential": "authorization_code",
                    "action": "lineage_revoked",
                    "revoked_tokens": revoked,
                }),
            ),
        )
        .await?;
        return Ok(Err(OauthError::InvalidGrant));
    }
    // Every binding the code carries is asserted again — and none of these burns it: a wrong
    // verifier, redirect, client or resource is a mistake or a probe, and the holder of the
    // real verifier can still redeem within the code's 60 seconds.
    if locked.status != "approved"
        || locked.expired
        || locked.client_id != OORT_CLI_CLIENT_ID
        || locked.redirect_uri != exchange.redirect_uri
        || locked.resource != exchange.canonical_resource
        || exchange
            .presented_resource
            .is_some_and(|presented| presented != locked.resource)
        || !verify_pkce_s256(exchange.verifier, &locked.code_challenge)
    {
        return Ok(Err(OauthError::InvalidGrant));
    }
    match redeem_dev_login_code_in_tx(conn, workspace_id, &locked, DEV_FIXED_POLICY)
        .await
        .map_err(DbError::from)?
    {
        DevLoginRedeem::Issued(issued) => {
            audit(
                conn,
                AuditEntry::new(workspace_id, AUDIT_LOGIN_ISSUED)
                    .about(issued.member_id)
                    .target(TARGET_LINEAGE, issued.session_id)
                    .with_schema(SCHEMA_LOGIN_ISSUED, json!({ "scopes": issued.scopes })),
            )
            .await?;
            Ok(Ok(*issued))
        }
        // Refused: the re-judgement at exchange time said no (the member is no longer an
        // active human the switch admits, or the lineage limit is reached) and the code is
        // burned — this commits. NotRedeemable wrote nothing. Both answer like any bad code.
        DevLoginRedeem::Refused(_) | DevLoginRedeem::NotRedeemable => {
            Ok(Err(OauthError::InvalidGrant))
        }
    }
}

async fn refresh(state: &AppState, form: &TokenForm) -> Response {
    let Some(raw_refresh) = form.refresh_token.as_deref() else {
        return oauth_failure(OauthError::InvalidRequest);
    };
    let Some(workspace_id) = dev_refresh_workspace_id(raw_refresh) else {
        return oauth_failure(OauthError::InvalidGrant);
    };
    // The rotation (and its reuse detection, which commits the lineage's revocation) is the
    // door module's: this route calls it and answers.
    match crate::dev_access::rotate_dev_refresh(state, workspace_id, raw_refresh).await {
        Ok(DevRotation::Rotated(issued)) => token_response(&issued, workspace_id),
        // One answer for "no such refresh", "expired" and "already rotated away".
        Ok(DevRotation::Invalid | DevRotation::ReuseDetected { .. }) => {
            oauth_failure(OauthError::InvalidGrant)
        }
        Err(error) => {
            tracing::error!(error = %error, "OAuth developer refresh transaction failed");
            oauth_failure(OauthError::ServerError)
        }
    }
}

/// The 200 of a code exchange or a refresh. Raw material, once, with `no-store`: nothing
/// here is logged and nothing is stored (the database holds digests). `workspace_id` is the
/// tenant the CLI will address its REST calls to.
fn token_response(issued: &IssuedDevLogin, workspace_id: Uuid) -> Response {
    no_store(
        Json(json!({
            "access_token": issued.access,
            "token_type": TOKEN_TYPE_BEARER,
            "expires_in": DEV_ACCESS_TTL_SECONDS,
            "refresh_token": issued.refresh,
            "scope": issued.scopes.join(" "),
            "workspace_id": workspace_id,
        }))
        .into_response(),
    )
}

fn settle_login(
    outcome: Result<Result<IssuedDevLogin, OauthError>, DbError>,
    workspace_id: Uuid,
    context: &'static str,
) -> Response {
    match outcome {
        Ok(Ok(issued)) => token_response(&issued, workspace_id),
        Ok(Err(error)) => oauth_failure(error),
        Err(error) => {
            tracing::error!(error = %error, context, "OAuth developer token transaction failed");
            oauth_failure(OauthError::ServerError)
        }
    }
}

// ---------------------------------------------------------------------------
// POST /v1/oauth/revoke (RFC 7009)
// ---------------------------------------------------------------------------

/// `POST /v1/oauth/revoke` for `client_id=oort-cli`.
///
/// RFC 7009 §2.2: an unknown token is a success. A card token, a token of another client,
/// a string that is no token and one already revoked are all the same 200, so this route is
/// no oracle for what exists — the only observable difference between a real revocation and
/// a no-op is that the real one stops working. A login's access or refresh envelope ends the
/// **whole lineage**: revoking one half retires both.
pub(super) async fn revoke(state: &AppState, form: &RevokeForm) -> Response {
    let Some(raw_token) = form.token.as_deref() else {
        return oauth_failure(OauthError::InvalidRequest);
    };
    let Some(workspace_id) =
        dev_token_workspace_id(raw_token).or_else(|| dev_refresh_workspace_id(raw_token))
    else {
        return no_store(StatusCode::OK.into_response());
    };
    let raw_token = raw_token.to_string();
    let outcome = with_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            // Only a login's access or refresh half issued to this client — never a card.
            let Some(target) = resolve_dev_login_revocation_target_in_tx(
                conn,
                workspace_id,
                &raw_token,
                OORT_CLI_CLIENT_ID,
            )
            .await
            .map_err(DbError::from)?
            else {
                return Ok(());
            };
            let revoked = revoke_dev_credential_in_tx(conn, workspace_id, target.session_id)
                .await
                .map_err(DbError::from)?;
            if revoked > 0 {
                audit(
                    conn,
                    AuditEntry::new(workspace_id, AUDIT_REVOKED)
                        .about(target.member_id)
                        .target(AUDIT_TARGET, target.session_id)
                        .with_schema(SCHEMA_REVOKED, json!({ "via": "oauth", "kind": "session" })),
                )
                .await?;
            }
            Ok(())
        })
    })
    .await;
    if let Err(error) = outcome {
        tracing::error!(error = %error, "OAuth developer revocation transaction failed");
        return oauth_failure(OauthError::ServerError);
    }
    no_store(StatusCode::OK.into_response())
}

#[cfg(test)]
mod tests {
    //! What needs no database: the pure rules (host, default scopes, the envelope's currency,
    //! the redirect), the authorization endpoint end to end (it writes nothing), every wall the
    //! consent routes and the token endpoint put before the first query, and the two metadata
    //! documents. The transactions — lock, liveness, switch, limit, password, ledger, replay,
    //! lineage — are exercised against PostgreSQL by the conformance suites.

    use axum::body::{to_bytes, Body};
    use axum::extract::{Form, FromRequest};
    use axum::http::{header, Request};
    use momo_auth::{
        hosted_oauth_request_key, sign_authorization_request, AuthorizationRequestSeed, DevForm,
        PrincipalKind, DEV_LOGIN_CODE_PREFIX, DEV_REFRESH_PREFIX, DEV_TOKEN_PREFIX,
        HOSTED_AGENT_SCOPES, SCOPE_DEV_CHANNELS_READ, SCOPE_DEV_IDENTITY, SCOPE_DEV_INBOX_READ,
        SCOPE_DEV_MESSAGES_READ,
    };
    use serde_json::Value;

    use super::*;
    use crate::config::{AgentPortConfig, RegisteredOauthClient};

    const SECRET: &str = "dev-login-oauth-unit-test-secret";
    const ISSUER: &str = "https://oort.example";
    const CONSENT_URL: &str = "https://oort.example/oauth/cli";
    const RESOURCE: &str = "https://oort.example/v1/mcp/me";
    const REDIRECT: &str = "http://127.0.0.1:24681/callback";
    const CHALLENGE: &str = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    const WORKSPACE: Uuid = Uuid::from_u128(0x0190_f2a4_6b1d_7c3e_8f00_0000_0000_a1a1);
    const OTHER_WORKSPACE: Uuid = Uuid::from_u128(0x0190_f2a4_6b1d_7c3e_8f00_0000_0000_b2b2);
    const MEMBER: Uuid = Uuid::from_u128(0xd0);
    const SESSION_TOKEN: Uuid = Uuid::from_u128(0x5e);
    const DEV_TOKEN: Uuid = Uuid::from_u128(0xde);
    /// 43 characters, the shape of a minted secret. Not a credential.
    const SECRET_BODY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const PASSWORD_MARKER: &str = "pw-marker-달무리-스튜디오";

    fn state_with(oauth: AgentPortOauthConfig) -> AppState {
        // A pool that never dials: a handler that reached the database would answer 500, so
        // any other answer proves the refusal came first.
        let pool = momo_db::sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
            .expect("a lazy pool never dials");
        AppState::new(
            pool,
            SECRET.to_string(),
            "ws://127.0.0.1:8000/connection/websocket".to_string(),
        )
        .with_agent_port(AgentPortConfig {
            oauth,
            ..AgentPortConfig::default()
        })
    }

    fn open_state() -> AppState {
        state_with(AgentPortOauthConfig::for_tests_dev_login(
            ISSUER,
            CONSENT_URL,
        ))
    }

    fn closed_state() -> AppState {
        state_with(AgentPortOauthConfig::default())
    }

    fn hosted_client() -> RegisteredOauthClient {
        RegisteredOauthClient {
            client_id: "hosted-client".to_string(),
            redirect_uris: vec!["https://client.example/cb".to_string()],
        }
    }

    fn hosted_only_config() -> AgentPortOauthConfig {
        AgentPortOauthConfig::for_tests(
            ISSUER,
            "https://oort.example/oauth/consent",
            vec![hosted_client()],
        )
    }

    fn query() -> AuthorizeQuery {
        AuthorizeQuery {
            response_type: Some("code".to_string()),
            client_id: Some(OORT_CLI_CLIENT_ID.to_string()),
            redirect_uri: Some(REDIRECT.to_string()),
            scope: Some("dev:channels:read dev:messages:read".to_string()),
            state: Some("state-1".to_string()),
            code_challenge: Some(CHALLENGE.to_string()),
            code_challenge_method: Some("S256".to_string()),
            resource: Some(RESOURCE.to_string()),
            device_name: Some("달무리 노트북".to_string()),
        }
    }

    fn person() -> Principal {
        Principal {
            member_id: MEMBER,
            workspace_id: WORKSPACE,
            token_id: Some(SESSION_TOKEN),
            scopes: Vec::new(),
            kind: PrincipalKind::Human,
        }
    }

    /// What the developer door puts beside the person `Principal` it builds.
    fn developer_marker() -> Option<Extension<DevCredential>> {
        Some(Extension(DevCredential {
            token_id: DEV_TOKEN,
            form: DevForm::Card,
            scopes: vec![SCOPE_DEV_IDENTITY.to_string()],
            channel_ids: None,
        }))
    }

    fn now_seconds() -> i64 {
        chrono_now_seconds()
    }

    fn scopes(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    /// A request envelope this server signed — the canonical one unless the case bends it.
    struct Signed {
        client_id: &'static str,
        redirect_uri: &'static str,
        resource: &'static str,
        scopes: Vec<String>,
        issued_at: i64,
        key_secret: &'static str,
    }

    impl Default for Signed {
        fn default() -> Self {
            Signed {
                client_id: OORT_CLI_CLIENT_ID,
                redirect_uri: REDIRECT,
                resource: RESOURCE,
                scopes: scopes(&[SCOPE_DEV_IDENTITY, SCOPE_DEV_CHANNELS_READ]),
                issued_at: now_seconds(),
                key_secret: SECRET,
            }
        }
    }

    impl Signed {
        fn envelope(&self) -> String {
            sign_dev_login_request(
                &dev_login_request_key(self.key_secret),
                DevLoginRequestSeed {
                    nonce: Uuid::new_v4(),
                    client_id: self.client_id,
                    redirect_uri: self.redirect_uri,
                    resource: self.resource,
                    scopes: &self.scopes,
                    code_challenge: CHALLENGE,
                    code_challenge_method: CODE_CHALLENGE_METHOD_S256,
                    state: Some("state-1"),
                    device_name: Some("달무리 노트북"),
                },
                self.issued_at,
            )
            .expect("signs")
        }
    }

    fn claims_of(envelope: &str) -> DevLoginRequestClaims {
        verify_dev_login_request(&dev_login_request_key(SECRET), envelope).expect("verifies")
    }

    async fn json_of(response: Response) -> Value {
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("a readable body");
        serde_json::from_slice(&bytes).unwrap_or_else(|_| {
            panic!(
                "not JSON: {:?}",
                String::from_utf8_lossy(&bytes).into_owned()
            )
        })
    }

    async fn bytes_of(response: Response) -> Vec<u8> {
        to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("a readable body")
            .to_vec()
    }

    fn header_of(response: &Response, name: header::HeaderName) -> Option<String> {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
    }

    fn location(response: &Response) -> String {
        header_of(response, header::LOCATION).expect("a Location header")
    }

    fn percent_decode(raw: &str) -> String {
        let bytes = raw.as_bytes();
        let mut out = Vec::new();
        let mut index = 0;
        while index < bytes.len() {
            if bytes[index] == b'%' && index + 2 < bytes.len() {
                let hex = &raw[index + 1..index + 3];
                out.push(u8::from_str_radix(hex, 16).expect("two hex digits"));
                index += 3;
            } else {
                out.push(bytes[index]);
                index += 1;
            }
        }
        String::from_utf8(out).expect("UTF-8")
    }

    /// `(base, [(key, decoded value)])` of a URL with a query.
    fn parts_of(url: &str) -> (String, Vec<(String, String)>) {
        let (base, query) = url.split_once('?').expect("a query");
        let pairs = query
            .split('&')
            .map(|pair| {
                let (key, value) = pair.split_once('=').expect("key=value");
                (key.to_string(), percent_decode(value))
            })
            .collect();
        (base.to_string(), pairs)
    }

    fn param<'a>(pairs: &'a [(String, String)], key: &str) -> Option<&'a str> {
        pairs
            .iter()
            .find(|(candidate, _)| candidate == key)
            .map(|(_, value)| value.as_str())
    }

    // -- the pure rules ------------------------------------------------------------------

    #[test]
    fn the_server_host_is_the_authority_of_the_configured_issuer() {
        for (issuer, host) in [
            ("https://oort.example", "oort.example"),
            ("https://oort.example:8443", "oort.example:8443"),
            ("https://[::1]:8443", "[::1]:8443"),
            ("https://oort.example/", "oort.example"),
            ("https://oort.example/path?x=1#y", "oort.example"),
            ("https://user@oort.example", "oort.example"),
            ("oort.example", "oort.example"),
        ] {
            assert_eq!(server_host(issuer), host, "{issuer}");
        }
    }

    #[test]
    fn only_the_built_in_client_on_an_open_arm_is_taken() {
        let dev = AgentPortOauthConfig::for_tests_dev_login(ISSUER, CONSENT_URL);
        assert!(takes(&dev, Some("oort-cli")));
        for other in [
            None,
            Some(""),
            Some("OORT-CLI"),
            Some("oort-cli "),
            Some("hosted-client"),
        ] {
            assert!(!takes(&dev, other), "{other:?}");
        }
        // The arm closed: the hosted adapter's, whatever the hosted arm says.
        for closed in [AgentPortOauthConfig::default(), hosted_only_config()] {
            assert!(!takes(&closed, Some("oort-cli")));
        }
        // Both open: the built-in client is still this arm's, a registered one the hosted's.
        let both = hosted_only_config().with_dev_login_for_tests(CONSENT_URL);
        assert!(takes(&both, Some("oort-cli")));
        assert!(!takes(&both, Some("hosted-client")));
    }

    #[test]
    fn an_omitted_approval_is_the_read_only_preset_within_what_was_requested() {
        let everything = scopes(&DEV_SCOPES);
        let preset: Vec<String> = DEV_READ_ONLY_SCOPES.iter().map(|s| s.to_string()).collect();
        assert_eq!(
            resolve_approved_scopes(&everything, &OptionalPatch::Absent).expect("preset"),
            preset
        );
        // A request for less than the preset gets that, never more.
        let narrow = scopes(&[SCOPE_DEV_IDENTITY, SCOPE_DEV_CHANNELS_READ]);
        assert_eq!(
            resolve_approved_scopes(&narrow, &OptionalPatch::Absent).expect("narrow"),
            narrow
        );
        // A request for writing alone: the preset is the identity (reading was not asked for).
        let write_only = scopes(&[SCOPE_DEV_IDENTITY, SCOPE_DEV_MESSAGES_WRITE]);
        assert_eq!(
            resolve_approved_scopes(&write_only, &OptionalPatch::Absent).expect("write only"),
            scopes(&[SCOPE_DEV_IDENTITY])
        );
    }

    #[test]
    fn a_chosen_approval_is_normalized_and_must_stay_inside_the_request() {
        let everything = scopes(&DEV_SCOPES);
        let chosen = |names: &[&str]| OptionalPatch::Set(Some(scopes(names)));
        // Vocabulary spelling, order, duplicates and `dev:identity` are the normalizer's.
        assert_eq!(
            resolve_approved_scopes(
                &everything,
                &chosen(&[
                    " DEV:Messages:Write ",
                    SCOPE_DEV_CHANNELS_READ,
                    SCOPE_DEV_CHANNELS_READ
                ])
            )
            .expect("normalized"),
            scopes(&[
                SCOPE_DEV_IDENTITY,
                SCOPE_DEV_CHANNELS_READ,
                SCOPE_DEV_MESSAGES_WRITE
            ])
        );
        // Outside the request: 400.
        let narrow = scopes(&[SCOPE_DEV_IDENTITY, SCOPE_DEV_CHANNELS_READ]);
        for outside in [
            chosen(&[SCOPE_DEV_MESSAGES_WRITE]),
            chosen(&[SCOPE_DEV_CHANNELS_READ, SCOPE_DEV_INBOX_READ]),
        ] {
            let error = resolve_approved_scopes(&narrow, &outside).expect_err("outside");
            assert_eq!(error.status, StatusCode::BAD_REQUEST);
            assert_eq!(error.code, None);
        }
        // Not in the vocabulary, reserved, empty, or `null`: 400.
        for refused in [
            chosen(&["dev:admin"]),
            chosen(&["dev:search"]),
            chosen(&["messages:write"]),
            chosen(&[]),
            OptionalPatch::Set(None),
        ] {
            let error = resolve_approved_scopes(&everything, &refused).expect_err("refused");
            assert_eq!(error.status, StatusCode::BAD_REQUEST);
        }
    }

    #[test]
    fn the_envelope_is_current_only_while_it_describes_what_this_server_would_approve() {
        let oauth = AgentPortOauthConfig::for_tests_dev_login(ISSUER, CONSENT_URL);
        let canonical = claims_of(&Signed::default().envelope());
        assert!(claims_are_current(&oauth, &canonical));

        let bent: [(&str, DevLoginRequestClaims); 9] = [
            (
                "another client",
                DevLoginRequestClaims {
                    cid: "other".to_string(),
                    ..canonical.clone()
                },
            ),
            (
                "another resource",
                DevLoginRequestClaims {
                    res: "https://oort.example/v1/mcp/agent-port".to_string(),
                    ..canonical.clone()
                },
            ),
            (
                "a redirect off the list",
                DevLoginRequestClaims {
                    ru: "http://localhost:24681/callback".to_string(),
                    ..canonical.clone()
                },
            ),
            (
                "plain challenge",
                DevLoginRequestClaims {
                    ccm: "plain".to_string(),
                    ..canonical.clone()
                },
            ),
            (
                "a short challenge",
                DevLoginRequestClaims {
                    cc: "short".to_string(),
                    ..canonical.clone()
                },
            ),
            (
                "scopes that are not canonical (no identity)",
                DevLoginRequestClaims {
                    scp: scopes(&[SCOPE_DEV_CHANNELS_READ]),
                    ..canonical.clone()
                },
            ),
            (
                "a scope outside the vocabulary",
                DevLoginRequestClaims {
                    scp: scopes(&[SCOPE_DEV_IDENTITY, "agent:port:connect"]),
                    ..canonical.clone()
                },
            ),
            (
                "a blank device name",
                DevLoginRequestClaims {
                    dn: Some("  ".to_string()),
                    ..canonical.clone()
                },
            ),
            (
                "an oversized state",
                DevLoginRequestClaims {
                    st: Some("s".repeat(513)),
                    ..canonical.clone()
                },
            ),
        ];
        for (case, claims) in &bent {
            assert!(!claims_are_current(&oauth, claims), "{case}");
        }
        // The operator moved the issuer after the request was signed: it is stale, not live.
        let moved = AgentPortOauthConfig::for_tests_dev_login("https://moved.example", CONSENT_URL);
        assert!(!claims_are_current(&moved, &canonical));
    }

    #[test]
    fn the_redirect_is_the_envelopes_own_and_is_checked_again_when_used() {
        let claims = claims_of(&Signed::default().envelope());
        let approved =
            decision_redirect(&claims, ISSUER, Ok("momo_devc_v1.code")).expect("redirect");
        let (base, pairs) = parts_of(&approved);
        assert_eq!(base, REDIRECT);
        assert_eq!(param(&pairs, "code"), Some("momo_devc_v1.code"));
        assert_eq!(param(&pairs, "state"), Some("state-1"));
        assert_eq!(param(&pairs, "iss"), Some(ISSUER));
        assert_eq!(param(&pairs, "error"), None);

        let denied =
            decision_redirect(&claims, ISSUER, Err(OauthError::AccessDenied)).expect("redirect");
        let (base, pairs) = parts_of(&denied);
        assert_eq!(base, REDIRECT);
        assert_eq!(param(&pairs, "error"), Some("access_denied"));
        assert_eq!(param(&pairs, "state"), Some("state-1"));
        assert_eq!(param(&pairs, "iss"), Some(ISSUER));
        assert_eq!(param(&pairs, "code"), None);

        // No state in the request: none in the redirect.
        let stateless = DevLoginRequestClaims {
            st: None,
            ..claims.clone()
        };
        let (_, pairs) = parts_of(&decision_redirect(&stateless, ISSUER, Ok("c")).expect("ok"));
        assert_eq!(param(&pairs, "state"), None);

        // A client's own state is encoded: it cannot add a parameter of its own.
        let hostile = DevLoginRequestClaims {
            st: Some("x&code=stolen#frag".to_string()),
            ..claims.clone()
        };
        let url = decision_redirect(&hostile, ISSUER, Ok("real")).expect("ok");
        let (_, pairs) = parts_of(&url);
        assert_eq!(param(&pairs, "code"), Some("real"));
        assert_eq!(param(&pairs, "state"), Some("x&code=stolen#frag"));
        assert_eq!(pairs.iter().filter(|(key, _)| key == "code").count(), 1);

        // A redirect that is not on the list now is never used, whatever the envelope says.
        let off_list = DevLoginRequestClaims {
            ru: "http://127.0.0.1:24681/callback/".to_string(),
            ..claims
        };
        let error = decision_redirect(&off_list, ISSUER, Ok("c")).expect_err("off the list");
        assert_eq!(error.status, StatusCode::NOT_FOUND);
        assert_eq!(error.code, Some("dev_login_request_not_found"));
    }

    #[test]
    fn every_consent_refusal_has_a_closed_reason_and_its_code() {
        for (refusal, reason, status, code) in [
            (
                ConsentRefusal::Policy,
                "policy_denied",
                403,
                "dev_access_denied",
            ),
            (
                ConsentRefusal::NotHuman,
                "not_human",
                403,
                "dev_access_denied",
            ),
            (
                ConsentRefusal::PasswordMismatch,
                "password_mismatch",
                403,
                "current_password_incorrect",
            ),
            (
                ConsentRefusal::PasswordUnavailable,
                "password_unavailable",
                403,
                "current_password_unavailable",
            ),
            (ConsentRefusal::Limit, "limit", 409, "dev_credential_limit"),
        ] {
            assert_eq!(refusal.reason(), reason);
            let error = refusal.error();
            assert_eq!(error.status.as_u16(), status, "{reason}");
            assert_eq!(error.code, Some(code), "{reason}");
        }
    }

    #[test]
    fn the_decision_conflicts_and_the_missing_request_have_their_codes() {
        let conflict = already_decided();
        assert_eq!(conflict.status, StatusCode::CONFLICT);
        assert_eq!(conflict.code, Some("dev_login_already_decided"));
        let missing = request_not_found();
        assert_eq!(missing.status, StatusCode::NOT_FOUND);
        assert_eq!(missing.code, Some("dev_login_request_not_found"));
    }

    // -- GET /v1/oauth/authorize ---------------------------------------------------------

    #[tokio::test]
    async fn a_valid_request_is_handed_to_the_consent_screen_as_a_signed_envelope() {
        let state = open_state();
        let response = authorize(&state, &query());
        assert_eq!(response.status(), StatusCode::FOUND);
        assert_eq!(
            header_of(&response, header::CACHE_CONTROL).as_deref(),
            Some("no-store")
        );
        let target = location(&response);
        let (base, request) = target
            .split_once("?request=")
            .expect("the consent URL carries the request");
        assert_eq!(base, CONSENT_URL);
        let claims = claims_of(request);
        assert_eq!(claims.cid, "oort-cli");
        assert_eq!(claims.ru, REDIRECT);
        assert_eq!(claims.res, RESOURCE);
        // The request named two scopes; `dev:identity` is added and the order is canonical.
        assert_eq!(
            claims.scp,
            scopes(&[
                SCOPE_DEV_IDENTITY,
                SCOPE_DEV_CHANNELS_READ,
                SCOPE_DEV_MESSAGES_READ
            ])
        );
        assert_eq!(claims.cc, CHALLENGE);
        assert_eq!(claims.ccm, "S256");
        assert_eq!(claims.st.as_deref(), Some("state-1"));
        assert_eq!(claims.dn.as_deref(), Some("달무리 노트북"));
        assert!(claims_are_current(&state.agent_port.config.oauth, &claims));
        // Every authorization is its own request: the nonce is the decision's uniqueness key.
        let second = location(&authorize(&state, &query()));
        let second_claims = claims_of(second.split_once("?request=").expect("request").1);
        assert_ne!(claims.jti, second_claims.jti);
    }

    #[tokio::test]
    async fn a_consent_url_that_already_has_a_query_gets_the_request_appended() {
        let state = state_with(AgentPortOauthConfig::for_tests_dev_login(
            ISSUER,
            "https://oort.example/oauth/cli?from=cli",
        ));
        let target = location(&authorize(&state, &query()));
        assert!(
            target.starts_with("https://oort.example/oauth/cli?from=cli&request="),
            "{target}"
        );
    }

    #[tokio::test]
    async fn a_request_without_optional_parts_is_signed_without_them() {
        let state = open_state();
        let mut bare = query();
        bare.state = None;
        bare.device_name = None;
        bare.scope = Some("dev:messages:write".to_string());
        let target = location(&authorize(&state, &bare));
        let claims = claims_of(target.split_once("?request=").expect("request").1);
        assert_eq!(claims.st, None);
        assert_eq!(claims.dn, None);
        assert_eq!(
            claims.scp,
            scopes(&[SCOPE_DEV_IDENTITY, SCOPE_DEV_MESSAGES_WRITE])
        );

        // A blank device name is no name; a padded one is trimmed — the rule of the credential.
        for (given, signed) in [("   ", None), ("  내 노트북  ", Some("내 노트북"))] {
            let mut named = query();
            named.device_name = Some(given.to_string());
            let target = location(&authorize(&state, &named));
            let claims = claims_of(target.split_once("?request=").expect("request").1);
            assert_eq!(claims.dn.as_deref(), signed, "{given:?}");
        }
    }

    #[tokio::test]
    async fn a_redirect_off_the_fixed_list_is_a_plain_400_that_sends_the_browser_nowhere() {
        let state = open_state();
        let mut cases: Vec<Option<String>> = [
            "http://localhost:24681/callback",
            "http://127.0.0.1:24686/callback",
            "http://127.0.0.1:24680/callback",
            "http://127.0.0.1:24681/callback/",
            "http://127.0.0.1:24681/Callback",
            "http://127.0.0.1:24681/callback?x=1",
            "http://127.0.0.1:24681/callback#frag",
            "http://127.0.0.1:24681",
            "http://127.0.0.1/callback",
            "http://[::1]:24681/callback",
            "http://0.0.0.0:24681/callback",
            "https://127.0.0.1:24681/callback",
            " http://127.0.0.1:24681/callback",
            "http://127.0.0.1:24681/callback ",
            "https://evil.example/cb",
            "",
        ]
        .iter()
        .map(|uri| Some(uri.to_string()))
        .collect();
        cases.push(None);
        for uri in cases {
            // Everything else about the request is also wrong: the redirect is judged first.
            let mut bad = query();
            bad.redirect_uri = uri.clone();
            bad.response_type = Some("token".to_string());
            bad.scope = None;
            let response = authorize(&state, &bad);
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{uri:?}");
            assert!(
                response.headers().get(header::LOCATION).is_none(),
                "{uri:?}"
            );
            assert_eq!(
                json_of(response).await,
                serde_json::json!({ "error": "invalid_request" }),
                "{uri:?}"
            );
        }
    }

    #[tokio::test]
    async fn every_later_refusal_is_an_error_redirect_to_the_registered_redirect() {
        type Bend = fn(&mut AuthorizeQuery);
        let state = open_state();
        let cases: [(&str, Bend, &str); 19] = [
            (
                "no response_type",
                |q| q.response_type = None,
                "unsupported_response_type",
            ),
            (
                "token",
                |q| q.response_type = Some("token".to_string()),
                "unsupported_response_type",
            ),
            ("no resource", |q| q.resource = None, "invalid_target"),
            (
                "the hosted resource",
                |q| q.resource = Some("https://oort.example/v1/mcp/agent-port".to_string()),
                "invalid_target",
            ),
            (
                "the resource with a slash",
                |q| q.resource = Some(format!("{RESOURCE}/")),
                "invalid_target",
            ),
            (
                "no challenge",
                |q| q.code_challenge = None,
                "invalid_request",
            ),
            (
                "no method",
                |q| q.code_challenge_method = None,
                "invalid_request",
            ),
            (
                "plain",
                |q| q.code_challenge_method = Some("plain".to_string()),
                "invalid_request",
            ),
            (
                "a short challenge",
                |q| q.code_challenge = Some("short".to_string()),
                "invalid_request",
            ),
            ("no scope", |q| q.scope = None, "invalid_scope"),
            (
                "an empty scope",
                |q| q.scope = Some(String::new()),
                "invalid_scope",
            ),
            (
                "an unknown scope",
                |q| q.scope = Some("dev:identity dev:admin".to_string()),
                "invalid_scope",
            ),
            (
                "a hosted scope",
                |q| q.scope = Some("agent:port:connect".to_string()),
                "invalid_scope",
            ),
            (
                "the reserved search scope",
                |q| q.scope = Some("dev:search".to_string()),
                "invalid_scope",
            ),
            (
                "a repeated scope",
                |q| q.scope = Some("dev:identity dev:identity".to_string()),
                "invalid_scope",
            ),
            (
                "a device name with a control character",
                |q| q.device_name = Some("bad\nname".to_string()),
                "invalid_request",
            ),
            (
                "a device name that is too long",
                |q| q.device_name = Some("x".repeat(81)),
                "invalid_request",
            ),
            (
                "a device name that is a pasted secret",
                |q| q.device_name = Some(format!("{DEV_TOKEN_PREFIX}.{WORKSPACE}.{SECRET_BODY}")),
                "invalid_request",
            ),
            (
                "a refresh envelope as a device name",
                |q| q.device_name = Some(format!("x {DEV_REFRESH_PREFIX}.abc")),
                "invalid_request",
            ),
        ];
        for (case, bend, error) in cases {
            let mut bad = query();
            bend(&mut bad);
            let response = authorize(&state, &bad);
            assert_eq!(response.status(), StatusCode::FOUND, "{case}");
            let (base, pairs) = parts_of(&location(&response));
            assert_eq!(base, REDIRECT, "{case}");
            assert_eq!(param(&pairs, "error"), Some(error), "{case}");
            assert_eq!(param(&pairs, "state"), Some("state-1"), "{case}");
            assert_eq!(param(&pairs, "iss"), Some(ISSUER), "{case}");
            assert_eq!(param(&pairs, "code"), None, "{case}");
            assert_eq!(param(&pairs, "request"), None, "{case}");
        }

        // A state that is not acceptable cannot be echoed: the refusal carries none.
        let mut oversized = query();
        oversized.state = Some("s".repeat(513));
        let (base, pairs) = parts_of(&location(&authorize(&state, &oversized)));
        assert_eq!(base, REDIRECT);
        assert_eq!(param(&pairs, "error"), Some("invalid_request"));
        assert_eq!(param(&pairs, "state"), None);
        assert_eq!(param(&pairs, "iss"), Some(ISSUER));
    }

    #[tokio::test]
    async fn an_arm_that_is_closed_answers_like_an_unknown_client() {
        let response = authorize(&closed_state(), &query());
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(response.headers().get(header::LOCATION).is_none());
        assert_eq!(
            json_of(response).await,
            serde_json::json!({ "error": "invalid_client" })
        );
    }

    // -- the consent routes: every wall before the first query ---------------------------

    fn preview_query(request: &str) -> Result<Query<PreviewQuery>, QueryRejection> {
        Ok(Query(PreviewQuery {
            request: request.to_string(),
        }))
    }

    fn approve_body(request: &str) -> DevLoginApproveRequest {
        DevLoginApproveRequest {
            request: request.to_string(),
            current_password: PASSWORD_MARKER.to_string(),
            approved_scopes: OptionalPatch::Absent,
        }
    }

    fn deny_body(request: &str) -> DevLoginDenyRequest {
        DevLoginDenyRequest {
            request: request.to_string(),
        }
    }

    /// The three consent handlers, called with the same caller and the same envelope.
    async fn all_three(
        state: &AppState,
        principal: Principal,
        marker: Option<Extension<DevCredential>>,
        workspace: &str,
        request: &str,
    ) -> [Response; 3] {
        let marker_again = marker.as_ref().map(|Extension(credential)| {
            Extension(DevCredential {
                token_id: credential.token_id,
                form: credential.form,
                scopes: credential.scopes.clone(),
                channel_ids: credential.channel_ids.clone(),
            })
        });
        let principal_again = principal.clone();
        [
            preview(
                State(state.clone()),
                Extension(principal.clone()),
                marker.as_ref().map(|Extension(credential)| {
                    Extension(DevCredential {
                        token_id: credential.token_id,
                        form: credential.form,
                        scopes: credential.scopes.clone(),
                        channel_ids: credential.channel_ids.clone(),
                    })
                }),
                Path(workspace.to_string()),
                preview_query(request),
            )
            .await,
            approve(
                State(state.clone()),
                Extension(principal),
                marker_again,
                Path(workspace.to_string()),
                Ok(Json(approve_body(request))),
            )
            .await,
            deny(
                State(state.clone()),
                Extension(principal_again),
                marker,
                Path(workspace.to_string()),
                Ok(Json(deny_body(request))),
            )
            .await,
        ]
    }

    async fn code_of(response: Response) -> (u16, Option<String>, Option<String>) {
        let status = response.status().as_u16();
        let cache = header_of(&response, header::CACHE_CONTROL);
        let body = json_of(response).await;
        (
            status,
            cache,
            body["error"]["code"].as_str().map(str::to_string),
        )
    }

    #[tokio::test]
    async fn a_developer_token_is_refused_by_all_three_consent_handlers_before_the_database() {
        let state = open_state();
        let envelope = Signed::default().envelope();
        for response in all_three(
            &state,
            person(),
            developer_marker(),
            &WORKSPACE.to_string(),
            &envelope,
        )
        .await
        {
            let (status, cache, code) = code_of(response).await;
            assert_eq!(status, 403);
            assert_eq!(cache.as_deref(), Some("no-store"));
            assert_eq!(code.as_deref(), Some("dev_route_not_allowed"));
        }
    }

    #[tokio::test]
    async fn a_principal_that_is_not_a_person_is_refused_like_a_role_the_switch_does_not_admit() {
        let state = open_state();
        let envelope = Signed::default().envelope();
        let agent = Principal {
            kind: PrincipalKind::Agent,
            ..person()
        };
        for response in all_three(&state, agent, None, &WORKSPACE.to_string(), &envelope).await {
            let (status, _, code) = code_of(response).await;
            assert_eq!(status, 403);
            assert_eq!(code.as_deref(), Some("dev_access_denied"));
        }
    }

    #[tokio::test]
    async fn another_workspace_or_no_workspace_is_refused_before_the_database() {
        let state = open_state();
        let envelope = Signed::default().envelope();
        for response in all_three(
            &state,
            person(),
            None,
            &OTHER_WORKSPACE.to_string(),
            &envelope,
        )
        .await
        {
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
        }
        for response in all_three(&state, person(), None, "not-a-uuid", &envelope).await {
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
    }

    #[tokio::test]
    async fn a_closed_arm_is_one_404_on_all_three_routes_even_for_a_good_envelope() {
        let envelope = Signed::default().envelope();
        for state in [closed_state(), state_with(hosted_only_config())] {
            for response in
                all_three(&state, person(), None, &WORKSPACE.to_string(), &envelope).await
            {
                let (status, cache, code) = code_of(response).await;
                assert_eq!(status, 404);
                assert_eq!(cache.as_deref(), Some("no-store"));
                assert_eq!(code.as_deref(), Some("dev_login_request_not_found"));
            }
        }
    }

    #[tokio::test]
    async fn a_forged_stale_or_foreign_envelope_is_one_404_sentence_on_all_three_routes() {
        let state = open_state();
        let hosted_scopes = vec!["agent:port:connect".to_string()];
        let hosted_envelope = sign_authorization_request(
            &hosted_oauth_request_key(SECRET),
            AuthorizationRequestSeed {
                nonce: Uuid::new_v4(),
                client_id: "hosted-client",
                redirect_uri: "https://client.example/cb",
                resource: "https://oort.example/v1/mcp/agent-port",
                scopes: &hosted_scopes,
                code_challenge: CHALLENGE,
                code_challenge_method: "S256",
                state: None,
            },
            now_seconds(),
        )
        .expect("a hosted envelope");
        let good = Signed::default().envelope();
        let mut tampered: Vec<String> = good.split('.').map(str::to_string).collect();
        let flipped = if tampered[1].starts_with('A') {
            'B'
        } else {
            'A'
        };
        tampered[1] = format!("{flipped}{}", &tampered[1][1..]);

        let envelopes: Vec<(&str, String)> = vec![
            ("garbage", "not-an-envelope".to_string()),
            ("empty", String::new()),
            ("a hosted request envelope", hosted_envelope),
            ("tampered", tampered.join(".")),
            (
                "signed under another secret",
                Signed {
                    key_secret: "another-secret",
                    ..Signed::default()
                }
                .envelope(),
            ),
            (
                "expired",
                Signed {
                    issued_at: now_seconds() - 3_600,
                    ..Signed::default()
                }
                .envelope(),
            ),
            (
                "another client",
                Signed {
                    client_id: "other",
                    ..Signed::default()
                }
                .envelope(),
            ),
            (
                "another resource",
                Signed {
                    resource: "https://oort.example/v1/mcp/agent-port",
                    ..Signed::default()
                }
                .envelope(),
            ),
            (
                "a redirect off the list",
                Signed {
                    redirect_uri: "http://localhost:24681/callback",
                    ..Signed::default()
                }
                .envelope(),
            ),
            (
                "scopes that are not canonical",
                Signed {
                    scopes: scopes(&[SCOPE_DEV_CHANNELS_READ]),
                    ..Signed::default()
                }
                .envelope(),
            ),
        ];
        let mut first: Option<Vec<u8>> = None;
        for (case, envelope) in envelopes {
            for response in
                all_three(&state, person(), None, &WORKSPACE.to_string(), &envelope).await
            {
                assert_eq!(response.status(), StatusCode::NOT_FOUND, "{case}");
                let body = bytes_of(response).await;
                assert_eq!(
                    serde_json::from_slice::<Value>(&body).expect("JSON")["error"]["code"],
                    "dev_login_request_not_found",
                    "{case}"
                );
                // Not "a 404 each": the very same bytes, whichever way it failed.
                match &first {
                    None => first = Some(body),
                    Some(expected) => assert_eq!(&body, expected, "{case}"),
                }
            }
        }
    }

    #[tokio::test]
    async fn a_full_password_window_turns_the_approval_away_before_anything_is_read() {
        let state = open_state();
        let key = password_recheck_key(WORKSPACE, MEMBER);
        let window = password_recheck_window(&state.rate_limit.config);
        let start = Instant::now();
        for _ in 0..5 {
            reserve_password_recheck(&state.rate_limit.limiter, &key, window, start)
                .expect("a slot");
        }
        // A good envelope and a body that would otherwise go on: still 429, not compared.
        let envelope = Signed::default().envelope();
        let response = approve(
            State(state.clone()),
            Extension(person()),
            None,
            Path(WORKSPACE.to_string()),
            Ok(Json(approve_body(&envelope))),
        )
        .await;
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(header_of(&response, header::RETRY_AFTER).is_some());
        assert_eq!(
            header_of(&response, header::CACHE_CONTROL).as_deref(),
            Some("no-store")
        );
        // Preview and deny spend no password attempt, so the full window does not reach them.
        let forged = "not-an-envelope";
        let denied = deny(
            State(state.clone()),
            Extension(person()),
            None,
            Path(WORKSPACE.to_string()),
            Ok(Json(deny_body(forged))),
        )
        .await;
        assert_eq!(denied.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn an_approval_outside_the_request_is_a_400_that_spends_no_password_attempt() {
        let state = open_state();
        let envelope = Signed::default().envelope();
        let key = password_recheck_key(WORKSPACE, MEMBER);
        let window = password_recheck_window(&state.rate_limit.config);
        let chosen = |names: &[&str]| OptionalPatch::Set(Some(scopes(names)));
        for (case, approved_scopes) in [
            ("outside the request", chosen(&[SCOPE_DEV_MESSAGES_WRITE])),
            ("not in the vocabulary", chosen(&["dev:admin"])),
            ("an empty list", chosen(&[])),
            ("null", OptionalPatch::Set(None)),
        ] {
            let body = DevLoginApproveRequest {
                approved_scopes,
                ..approve_body(&envelope)
            };
            let response = approve(
                State(state.clone()),
                Extension(person()),
                None,
                Path(WORKSPACE.to_string()),
                Ok(Json(body)),
            )
            .await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{case}");
            assert_eq!(
                json_of(response).await["error"]["message"],
                "invalid approvedScopes",
                "{case}"
            );
        }
        // Nothing was reserved: the window is as empty as it was.
        assert_eq!(
            password_recheck_exhausted(&state.rate_limit.limiter, &key, window),
            None
        );
    }

    #[tokio::test]
    async fn an_empty_current_password_is_a_400() {
        let state = open_state();
        let envelope = Signed::default().envelope();
        let body = DevLoginApproveRequest {
            current_password: String::new(),
            ..approve_body(&envelope)
        };
        let response = approve(
            State(state),
            Extension(person()),
            None,
            Path(WORKSPACE.to_string()),
            Ok(Json(body)),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            json_of(response).await["error"]["message"],
            "invalid currentPassword"
        );
    }

    async fn parsed<T: serde::de::DeserializeOwned>(body: &str) -> Result<Json<T>, JsonRejection> {
        let request = Request::builder()
            .method("POST")
            .uri("/")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .expect("a request");
        Json::<T>::from_request(request, &()).await
    }

    #[tokio::test]
    async fn the_approval_body_is_closed_and_quotes_nothing_when_it_cannot_be_read() {
        // The shape.
        let good = format!(r#"{{"request":"e","currentPassword":"{PASSWORD_MARKER}"}}"#);
        let Json(request) = parsed::<DevLoginApproveRequest>(&good)
            .await
            .expect("parses");
        assert_eq!(request.approved_scopes, OptionalPatch::Absent);
        let explicit = format!(
            r#"{{"request":"e","currentPassword":"{PASSWORD_MARKER}","approvedScopes":["dev:identity"]}}"#
        );
        let Json(request) = parsed::<DevLoginApproveRequest>(&explicit)
            .await
            .expect("parses");
        assert_eq!(
            request.approved_scopes,
            OptionalPatch::Set(Some(scopes(&["dev:identity"])))
        );
        let null = format!(
            r#"{{"request":"e","currentPassword":"{PASSWORD_MARKER}","approvedScopes":null}}"#
        );
        let Json(request) = parsed::<DevLoginApproveRequest>(&null)
            .await
            .expect("parses");
        assert_eq!(request.approved_scopes, OptionalPatch::Set(None));

        // `Debug` never prints the password.
        let shown = format!("{request:?}");
        assert!(!shown.contains(PASSWORD_MARKER), "{shown}");

        // A misspelt key, a wrong type and a missing field are all unreadable — and the
        // answer to each is the same fixed sentence, which repeats nothing of the body.
        let unreadable = [
            format!(
                r#"{{"request":"e","currentPassword":"{PASSWORD_MARKER}","approved_scopes":[]}}"#
            ),
            format!(r#"{{"request":"e","currentPassword":["{PASSWORD_MARKER}"]}}"#),
            format!(r#"{{"currentPassword":"{PASSWORD_MARKER}"}}"#),
            format!(r#"not json {PASSWORD_MARKER}"#),
        ];
        for body in unreadable {
            let rejection = parsed::<DevLoginApproveRequest>(&body)
                .await
                .expect_err("unreadable");
            let response = approve(
                State(open_state()),
                Extension(person()),
                None,
                Path(WORKSPACE.to_string()),
                Err(rejection),
            )
            .await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{body}");
            let text = String::from_utf8(bytes_of(response).await).expect("UTF-8");
            assert!(!text.contains(PASSWORD_MARKER), "{text}");
            assert!(text.contains("invalid login request"), "{text}");
        }
        let rejection = parsed::<DevLoginDenyRequest>(r#"{"request":"e","extra":1}"#)
            .await
            .expect_err("closed");
        let response = deny(
            State(open_state()),
            Extension(person()),
            None,
            Path(WORKSPACE.to_string()),
            Err(rejection),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn the_decision_response_never_prints_its_code_in_debug() {
        let shown = format!(
            "{:?}",
            DevLoginDecisionResponse {
                redirect_to: format!("{REDIRECT}?code=momo_devc_v1.{WORKSPACE}.{SECRET_BODY}"),
            }
        );
        assert!(!shown.contains(SECRET_BODY), "{shown}");
    }

    // -- POST /v1/oauth/token and /revoke: the walls before the first query ---------------

    fn token_form(grant_type: Option<&str>) -> TokenForm {
        TokenForm {
            grant_type: grant_type.map(str::to_string),
            client_id: Some(OORT_CLI_CLIENT_ID.to_string()),
            code: None,
            code_verifier: None,
            redirect_uri: None,
            refresh_token: None,
            resource: None,
        }
    }

    async fn through_the_public_route(state: &AppState, form: TokenForm) -> (u16, Value) {
        let response =
            super::super::agent_port_oauth::token(State(state.clone()), Form(form)).await;
        let status = response.status().as_u16();
        let cache = header_of(&response, header::CACHE_CONTROL);
        assert_eq!(cache.as_deref(), Some("no-store"));
        (status, json_of(response).await)
    }

    #[tokio::test]
    async fn the_token_endpoint_hands_the_built_in_client_over_before_the_hosted_gate() {
        // The hosted arm is closed in this state, and the built-in client is served anyway:
        // its answer is this arm's, not the hosted 404.
        let state = open_state();
        let (status, body) =
            through_the_public_route(&state, token_form(Some("client_credentials"))).await;
        assert_eq!(
            (status, body),
            (400, serde_json::json!({"error": "unsupported_grant_type"}))
        );
        let (status, body) = through_the_public_route(&state, token_form(None)).await;
        assert_eq!(
            (status, body),
            (400, serde_json::json!({"error": "unsupported_grant_type"}))
        );

        // Another client's request is the hosted adapter's, untouched: 404 while it is closed.
        let mut other = token_form(Some("authorization_code"));
        other.client_id = Some("hosted-client".to_string());
        let response =
            super::super::agent_port_oauth::token(State(state.clone()), Form(other)).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn a_closed_arm_leaves_the_built_in_client_to_the_hosted_adapter_unchanged() {
        // Both closed: the hosted 404, exactly what the route answered before this arm existed.
        let (status, body) = {
            let response = super::super::agent_port_oauth::token(
                State(closed_state()),
                Form(token_form(Some("authorization_code"))),
            )
            .await;
            (response.status().as_u16(), bytes_of(response).await)
        };
        assert_eq!(status, 404);
        assert!(body.is_empty());
        // Hosted open, this arm closed: the built-in client is an unknown client (401).
        let hosted = state_with(hosted_only_config());
        let response = super::super::agent_port_oauth::token(
            State(hosted),
            Form(token_form(Some("authorization_code"))),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn a_code_exchange_with_a_missing_parameter_is_invalid_request() {
        let state = open_state();
        for form in [
            token_form(Some("authorization_code")),
            TokenForm {
                code: Some("c".to_string()),
                ..token_form(Some("authorization_code"))
            },
            TokenForm {
                code: Some("c".to_string()),
                code_verifier: Some("v".to_string()),
                ..token_form(Some("authorization_code"))
            },
            token_form(Some("refresh_token")),
        ] {
            let (status, body) = through_the_public_route(&state, form).await;
            assert_eq!(
                (status, body),
                (400, serde_json::json!({"error": "invalid_request"}))
            );
        }
    }

    #[tokio::test]
    async fn anything_that_is_not_a_code_or_a_refresh_is_the_same_invalid_grant_before_the_database(
    ) {
        let state = open_state();
        let ws = WORKSPACE;
        let bad_codes = [
            "not-a-code".to_string(),
            String::new(),
            format!("{DEV_LOGIN_CODE_PREFIX}.{ws}"),
            format!("{DEV_LOGIN_CODE_PREFIX}.{ws}.short"),
            format!("{DEV_LOGIN_CODE_PREFIX}.not-a-uuid.{SECRET_BODY}"),
            // The same secret bytes under another family's prefix.
            format!("{DEV_TOKEN_PREFIX}.{ws}.{SECRET_BODY}"),
            format!("{DEV_REFRESH_PREFIX}.{ws}.{SECRET_BODY}"),
            format!("momo_oauth_code_v1.{ws}.{SECRET_BODY}"),
        ];
        let mut answers = Vec::new();
        for code in bad_codes {
            let form = TokenForm {
                code: Some(code.clone()),
                code_verifier: Some("v".repeat(43)),
                redirect_uri: Some(REDIRECT.to_string()),
                ..token_form(Some("authorization_code"))
            };
            answers.push(through_the_public_route(&state, form).await);
            let _ = code;
        }
        let bad_refreshes = [
            "not-a-refresh".to_string(),
            format!("{DEV_REFRESH_PREFIX}.{ws}"),
            format!("{DEV_REFRESH_PREFIX}.{ws}.short"),
            // A card or an access envelope is not a refresh.
            format!("{DEV_TOKEN_PREFIX}.{ws}.{SECRET_BODY}"),
            format!("momo_oauth_refresh_v1.{ws}.{SECRET_BODY}"),
        ];
        for refresh in bad_refreshes {
            let form = TokenForm {
                refresh_token: Some(refresh),
                ..token_form(Some("refresh_token"))
            };
            answers.push(through_the_public_route(&state, form).await);
        }
        for answer in &answers {
            assert_eq!(
                answer,
                &(400, serde_json::json!({"error": "invalid_grant"}))
            );
        }
    }

    #[tokio::test]
    async fn revocation_of_anything_that_names_no_login_is_an_empty_200_without_the_database() {
        let state = open_state();
        for token in [
            "not-a-token".to_string(),
            String::new(),
            format!("momo_agent_v1.{WORKSPACE}.{SECRET_BODY}"),
            format!("{DEV_TOKEN_PREFIX}.not-a-uuid.{SECRET_BODY}"),
            format!("{DEV_REFRESH_PREFIX}.{WORKSPACE}.short"),
        ] {
            let response = super::super::agent_port_oauth::revoke(
                State(state.clone()),
                Form(RevokeForm {
                    token: Some(token.clone()),
                    client_id: Some(OORT_CLI_CLIENT_ID.to_string()),
                }),
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK, "{token:?}");
            assert_eq!(
                header_of(&response, header::CACHE_CONTROL).as_deref(),
                Some("no-store")
            );
            assert!(bytes_of(response).await.is_empty());
        }
        let missing = super::super::agent_port_oauth::revoke(
            State(state),
            Form(RevokeForm {
                token: None,
                client_id: Some(OORT_CLI_CLIENT_ID.to_string()),
            }),
        )
        .await;
        assert_eq!(missing.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            json_of(missing).await,
            serde_json::json!({"error": "invalid_request"})
        );
    }

    // -- GET /.well-known/oauth-authorization-server -------------------------------------

    async fn metadata_of(state: &AppState) -> (u16, Option<Value>) {
        let response =
            super::super::agent_port_oauth::authorization_server(State(state.clone())).await;
        let status = response.status().as_u16();
        if status != 200 {
            return (status, None);
        }
        (status, Some(json_of(response).await))
    }

    #[tokio::test]
    async fn the_metadata_document_is_served_while_either_arm_is_open_and_names_only_open_scopes() {
        // Both closed: 404, as before.
        assert_eq!(metadata_of(&closed_state()).await, (404, None));

        // The human arm alone: its own scopes, endpoints from the one issuer.
        let (status, dev) = metadata_of(&open_state()).await;
        assert_eq!(status, 200);
        let dev = dev.expect("a document");
        assert_eq!(dev["issuer"], ISSUER);
        assert_eq!(
            dev["authorization_endpoint"],
            format!("{ISSUER}/v1/oauth/authorize")
        );
        assert_eq!(dev["token_endpoint"], format!("{ISSUER}/v1/oauth/token"));
        assert_eq!(
            dev["revocation_endpoint"],
            format!("{ISSUER}/v1/oauth/revoke")
        );
        assert_eq!(dev["scopes_supported"], serde_json::json!(DEV_SCOPES));
        assert_eq!(
            dev["code_challenge_methods_supported"],
            serde_json::json!(["S256"])
        );

        // The hosted arm alone: exactly its vocabulary — nothing of the `dev:` namespace.
        let (_, hosted) = metadata_of(&state_with(hosted_only_config())).await;
        let hosted = hosted.expect("a document");
        assert_eq!(
            hosted["scopes_supported"],
            serde_json::json!(HOSTED_AGENT_SCOPES)
        );
        assert_eq!(hosted["issuer"], ISSUER);

        // Both: the union, hosted first, and nothing twice.
        let both = state_with(hosted_only_config().with_dev_login_for_tests(CONSENT_URL));
        let (_, union) = metadata_of(&both).await;
        let union = union.expect("a document");
        let expected: Vec<&str> = HOSTED_AGENT_SCOPES
            .iter()
            .chain(DEV_SCOPES.iter())
            .copied()
            .collect();
        assert_eq!(union["scopes_supported"], serde_json::json!(expected));
        // Everything else about the two documents is the same.
        let mut union_rest = union.clone();
        union_rest
            .as_object_mut()
            .expect("object")
            .remove("scopes_supported");
        let mut hosted_rest = hosted.clone();
        hosted_rest
            .as_object_mut()
            .expect("object")
            .remove("scopes_supported");
        assert_eq!(union_rest, hosted_rest);
    }
}
