//! ADR-0162 증보 1 / HAP-E7 — the MCP OAuth 2.1 authorization-server surface.
//!
//! This adapter owns HTTP for six endpoints and nothing else. Protocol
//! arithmetic is `momo_mcp::oauth` (no database); the ledger is
//! `momo_auth::hosted_oauth` (no HTTP). The split is the same one HAP-E2 drew
//! between the MCP transport and `momo-mcp`.
//!
//! ## Disabled is 404, not 503
//!
//! [`crate::config::AgentPortOauthConfig::is_enabled`] gates every handler
//! here. With the flag off the well-knowns and `/v1/oauth/*` answer exactly
//! what they answered before this file existed — nothing is advertised, no
//! metadata document is served, and an OAuth access credential at the Agent
//! Port is refused with the ordinary `invalid_token` challenge. There is no
//! response shape that distinguishes "off" from "never implemented", so the
//! flag itself is not probeable.
//!
//! ## The two halves of the resource owner's decision
//!
//! `GET /v1/oauth/authorize` is unauthenticated — it is a browser redirect from
//! a provider — so it writes **nothing**. It validates the request against the
//! operator's client allowlist and hands the browser one signed, short-lived,
//! server-minted envelope. The workspace, the connection and the human are
//! resolved on the other side, inside the authenticated, tenant-scoped
//! approve/deny routes, where a row is finally written and keyed on the
//! envelope's nonce so exactly one terminal decision survives.

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Form, Json};
use momo_auth::{
    active_workspace_role, approve_hosted_oauth_request_in_tx, consume_hosted_oauth_code_in_tx,
    deny_hosted_oauth_request_in_tx, hosted_oauth_access_workspace_id,
    hosted_oauth_code_workspace_id, hosted_oauth_refresh_workspace_id, hosted_oauth_request_key,
    list_oauth_candidates_in_tx, lock_hosted_oauth_code_in_tx,
    resolve_hosted_oauth_revocation_target_in_tx, revoke_hosted_oauth_family_in_tx,
    rotate_hosted_oauth_refresh_in_tx, sign_authorization_request, verify_authorization_request,
    AuthorizationRequestSeed, HostedOauthRefresh, HostedOauthRefusal, HostedOauthRequestClaims,
    Principal, HOSTED_AGENT_SCOPES,
};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{with_tenant_tx, DbError};
use momo_mcp::oauth::{
    authorization_redirect, authorization_server_metadata, parse_requested_scopes,
    percent_encode_query_value, protected_resource_metadata, redirect_uri_is_registered,
    validate_code_challenge, validate_resource, validate_state, verify_pkce_s256, OauthError,
    GRANT_TYPE_AUTHORIZATION_CODE, GRANT_TYPE_REFRESH_TOKEN, MAX_CLIENT_ID_BYTES,
    RESPONSE_TYPE_CODE, TOKEN_TYPE_BEARER,
};
use serde::Deserialize;
use serde_json::json;

use crate::config::AgentPortOauthConfig;
use crate::dto::{
    HostedOauthCandidateDto, HostedOauthConsentPreviewResponse, HostedOauthDecisionRequest,
    HostedOauthDecisionResponse,
};
use crate::error::ApiError;
use crate::routes::shared::{agent_tenant_tx, require_human, settle_db, workspace_scope};
use crate::AppState;

pub const AUDIT_CONSENT_GRANTED: &str = "hosted_agent.oauth.consent_granted";
pub const AUDIT_CONSENT_DENIED: &str = "hosted_agent.oauth.consent_denied";
pub const AUDIT_SCOPE_DENIED: &str = "hosted_agent.oauth.scope_denied";
pub const AUDIT_TOKEN_ISSUED: &str = "hosted_agent.oauth.token_issued";
pub const AUDIT_TOKEN_REFRESHED: &str = "hosted_agent.oauth.token_refreshed";
pub const AUDIT_TOKEN_REVOKED: &str = "hosted_agent.oauth.token_revoked";
pub const AUDIT_CREDENTIAL_REPLAYED: &str = "hosted_agent.oauth.credential_replayed";

const CONSENT_SCHEMA: &str = "oort.hosted_agent.oauth.consent.v1";
const TOKEN_SCHEMA: &str = "oort.hosted_agent.oauth.token.v1";
const REPLAY_SCHEMA: &str = "oort.hosted_agent.oauth.replay.v1";

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/// Every OAuth response is `no-store`. RFC 6749 §5.1 requires it of the token
/// endpoint, and the rest of this surface carries authorization decisions that
/// no cache may ever replay to a second browser.
fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
        .headers_mut()
        .insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    response
}

fn oauth_failure(error: OauthError) -> Response {
    let status = StatusCode::from_u16(error.status()).unwrap_or(StatusCode::BAD_REQUEST);
    no_store((status, Json(error.body())).into_response())
}

/// The authorization endpoint's refusal, before a registered redirect exists.
///
/// Always 400, never the token endpoint's 401: the caller here is a browser
/// following a provider's redirect, not a client authenticating itself, so a
/// 401 would invite a credential prompt for a credential that does not exist.
/// RFC 6749 §4.1.2.1 says to inform the resource owner directly rather than
/// redirect when the client or the redirect URI cannot be trusted, and this is
/// that answer.
fn authorization_refusal(error: OauthError) -> Response {
    no_store((StatusCode::BAD_REQUEST, Json(error.body())).into_response())
}

/// The disabled answer, and the answer for an unknown resource path.
fn not_found() -> Response {
    no_store(StatusCode::NOT_FOUND.into_response())
}

fn metadata(document: serde_json::Value) -> Response {
    // Metadata is public and identical for every caller, but it still carries
    // the endpoints a client will send credentials to, so it is not cached by
    // shared infrastructure that could be poisoned into serving a stale issuer.
    let mut response = (StatusCode::OK, Json(document)).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, max-age=0"),
    );
    response
}

fn found(location: &str) -> Response {
    match HeaderValue::from_str(location) {
        Ok(value) => {
            let mut response = StatusCode::FOUND.into_response();
            response.headers_mut().insert(header::LOCATION, value);
            no_store(response)
        }
        // A location that cannot be a header value cannot be a redirect. This
        // is unreachable for a registered URI plus percent-encoded parameters,
        // and refusing rather than falling through keeps it that way.
        Err(_) => oauth_failure(OauthError::ServerError),
    }
}

// ---------------------------------------------------------------------------
// Metadata (RFC 9728, RFC 8414)
// ---------------------------------------------------------------------------

/// `GET /.well-known/oauth-protected-resource/v1/mcp/agent-port`
///
/// Path-specific per RFC 9728 §3.1: the resource identifier carries a path, so
/// its metadata lives under the well-known prefix followed by that exact path.
/// A request for any other path never reaches this handler.
pub async fn protected_resource(State(state): State<AppState>) -> Response {
    let oauth = &state.agent_port.config.oauth;
    let (Some(resource), Some(issuer)) = (oauth.resource(), oauth.issuer()) else {
        return not_found();
    };
    metadata(protected_resource_metadata(
        &resource,
        issuer,
        &HOSTED_AGENT_SCOPES,
    ))
}

/// `GET /.well-known/oauth-authorization-server`
pub async fn authorization_server(State(state): State<AppState>) -> Response {
    let oauth = &state.agent_port.config.oauth;
    let (Some(issuer), Some(authorize), Some(token), Some(revoke)) = (
        oauth.issuer(),
        oauth.endpoint("/v1/oauth/authorize"),
        oauth.endpoint("/v1/oauth/token"),
        oauth.endpoint("/v1/oauth/revoke"),
    ) else {
        return not_found();
    };
    metadata(authorization_server_metadata(
        issuer,
        &authorize,
        &token,
        &revoke,
        &HOSTED_AGENT_SCOPES,
    ))
}

// ---------------------------------------------------------------------------
// Authorization request
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct AuthorizeQuery {
    response_type: Option<String>,
    client_id: Option<String>,
    redirect_uri: Option<String>,
    scope: Option<String>,
    state: Option<String>,
    code_challenge: Option<String>,
    code_challenge_method: Option<String>,
    resource: Option<String>,
}

/// `GET /v1/oauth/authorize`
///
/// Writes nothing and authenticates nobody. Its whole job is to refuse anything
/// that is not a well-formed request from a registered client, and then to hand
/// the browser a signed envelope naming what was asked for.
///
/// **The order of the checks is the open-redirect defence.** `client_id` and
/// `redirect_uri` are validated against the operator's allowlist FIRST, and
/// until both pass, a failure is a plain 400 that never sends the browser
/// anywhere. Only after the redirect URI is known-registered may a later refusal
/// be delivered as an error redirect.
pub async fn authorize(
    State(state): State<AppState>,
    Query(query): Query<AuthorizeQuery>,
) -> Response {
    let oauth = &state.agent_port.config.oauth;
    let (Some(issuer), Some(canonical_resource), Some(consent_url)) =
        (oauth.issuer(), oauth.resource(), oauth.consent_url())
    else {
        return not_found();
    };

    let Some(client_id) = query
        .client_id
        .as_deref()
        .filter(|value| !value.is_empty() && value.len() <= MAX_CLIENT_ID_BYTES)
    else {
        return authorization_refusal(OauthError::InvalidClient);
    };
    let Some(client) = oauth.client(client_id) else {
        return authorization_refusal(OauthError::InvalidClient);
    };
    let Some(redirect_uri) = query
        .redirect_uri
        .as_deref()
        .filter(|value| redirect_uri_is_registered(value, &client.redirect_uris))
    else {
        return authorization_refusal(OauthError::InvalidRequest);
    };

    // From here every refusal is an error redirect to a URI the operator
    // registered, which is what RFC 6749 §4.1.2.1 asks for and what a client
    // needs to surface a real message instead of a blank page.
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
    let scopes = match parse_requested_scopes(query.scope.as_deref(), &HOSTED_AGENT_SCOPES) {
        Ok(scopes) => scopes,
        Err(error) => return refuse(error),
    };
    if !scopes.iter().any(|scope| scope == "agent:port:connect") {
        return refuse(OauthError::InvalidScope);
    }

    let envelope = sign_authorization_request(
        &hosted_oauth_request_key(&state.jwt_secret),
        AuthorizationRequestSeed {
            nonce: uuid::Uuid::new_v4(),
            client_id,
            redirect_uri,
            resource: &canonical_resource,
            scopes: &scopes,
            code_challenge,
            code_challenge_method: momo_mcp::oauth::CODE_CHALLENGE_METHOD_S256,
            state: state_value.as_deref(),
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

/// Wall-clock seconds. Isolated so the one place this surface reads a clock is
/// visible.
fn chrono_now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Resource-owner consent (authenticated, tenant-scoped)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct ConsentPreviewQuery {
    request: String,
}

fn enabled_oauth(state: &AppState) -> Result<&AgentPortOauthConfig, ApiError> {
    let oauth = &state.agent_port.config.oauth;
    if oauth.is_enabled() {
        Ok(oauth)
    } else {
        Err(ApiError::not_found("not found"))
    }
}

fn verified_claims(
    state: &AppState,
    presented: &str,
) -> Result<HostedOauthRequestClaims, ApiError> {
    verify_authorization_request(&hosted_oauth_request_key(&state.jwt_secret), presented)
        // Non-enumerable on purpose: a stale, forged, replayed or foreign
        // envelope is one indistinguishable refusal.
        .map_err(|_| ApiError::not_found("not found"))
}

async fn require_admin(
    conn: &mut momo_db::PgConnection,
    workspace_id: uuid::Uuid,
    actor_member_id: uuid::Uuid,
) -> Result<Result<(), ApiError>, momo_db::DbError> {
    if active_workspace_role(conn, workspace_id, actor_member_id)
        .await?
        .is_some_and(|role| role.is_admin())
    {
        Ok(Ok(()))
    } else {
        // Non-enumerable: an ordinary member learns nothing about whether a
        // pending authorization request exists.
        Ok(Err(ApiError::not_found("not found")))
    }
}

/// `GET /v1/workspaces/{ws}/oauth/authorization-requests/preview`
pub async fn preview(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Query(query): Query<ConsentPreviewQuery>,
) -> Result<Response, ApiError> {
    require_human(&principal, "human workspace admin required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let oauth = enabled_oauth(&state)?;
    let claims = verified_claims(&state, &query.request)?;
    // A request whose resource is no longer the canonical one — because the
    // operator moved the issuer — is dead, not merely stale.
    if oauth.resource().as_deref() != Some(claims.res.as_str()) {
        return Err(ApiError::not_found("not found"));
    }
    if oauth.client(&claims.cid).is_none() {
        return Err(ApiError::not_found("not found"));
    }
    let actor_member_id = principal.member_id;
    let candidates = settle_db(
        "hosted_oauth.preview",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(error) = require_admin(conn, workspace_id, actor_member_id).await? {
                    return Ok(Err(error));
                }
                Ok(Ok(list_oauth_candidates_in_tx(conn, workspace_id).await?))
            })
        })
        .await,
    )?;
    let issuer = oauth.issuer().unwrap_or_default().to_string();
    let resource = oauth.resource().unwrap_or_default();
    Ok(no_store(
        Json(HostedOauthConsentPreviewResponse {
            client_id: claims.cid,
            redirect_uri: claims.ru,
            resource,
            issuer,
            requested_scopes: claims.scp,
            expires_at_ms: (claims.exp as i64) * 1000,
            candidates: candidates
                .into_iter()
                .map(|candidate| HostedOauthCandidateDto {
                    connection_id: candidate.connection_id.to_string(),
                    agent_member_id: candidate.agent_member_id.to_string(),
                    agent_display_name: candidate.agent_display_name,
                    created_at_ms: candidate.created_at_ms,
                })
                .collect(),
        })
        .into_response(),
    ))
}

/// `POST /v1/workspaces/{ws}/oauth/authorization-requests/approve`
///
/// One tenant transaction records the terminal decision, the channel
/// memberships, the `pairing_pending → detected` transition and the
/// authorization code digest. The raw code leaves the process exactly once, in
/// the `Location`-shaped `redirectTo` this returns.
pub async fn approve(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<HostedOauthDecisionRequest>,
) -> Result<Response, ApiError> {
    decide(state, principal, workspace, request, true).await
}

/// `POST /v1/workspaces/{ws}/oauth/authorization-requests/deny`
///
/// A denial is a terminal decision on the same nonce, so it makes a later
/// approve inert. The connection is untouched: it stays `pairing_pending` with
/// no credential, no membership and no capability. Back, close and timeout are
/// all equivalent to never calling this at all, which is also capability zero.
pub async fn deny(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Json(request): Json<HostedOauthDecisionRequest>,
) -> Result<Response, ApiError> {
    decide(state, principal, workspace, request, false).await
}

async fn decide(
    state: AppState,
    principal: Principal,
    workspace: String,
    request: HostedOauthDecisionRequest,
    approve: bool,
) -> Result<Response, ApiError> {
    require_human(&principal, "human workspace admin required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let oauth = enabled_oauth(&state)?;
    let claims = verified_claims(&state, &request.request)?;
    if oauth.resource().as_deref() != Some(claims.res.as_str()) {
        return Err(ApiError::not_found("not found"));
    }
    let Some(client) = oauth.client(&claims.cid) else {
        return Err(ApiError::not_found("not found"));
    };
    // Re-checked at decision time, not only at authorize time: a redirect URI
    // that was deregistered while the human read the screen must not be
    // honoured.
    if !redirect_uri_is_registered(&claims.ru, &client.redirect_uris) {
        return Err(ApiError::not_found("not found"));
    }
    let issuer = oauth.issuer().unwrap_or_default().to_string();
    let connection_id = request.connection_id;
    let actor_member_id = principal.member_id;
    let via_token_id = crate::routes::shared::audit_via_token_id(&principal);
    let approved_scopes = request.approved_scopes.clone();
    let approved_channel_ids = request.approved_channel_ids.clone();
    let claims_for_tx = claims.clone();

    let outcome = settle_db(
        "hosted_oauth.decide",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if let Err(error) = require_admin(conn, workspace_id, actor_member_id).await? {
                    return Ok(Err(error));
                }
                if !approve {
                    let denied = deny_hosted_oauth_request_in_tx(
                        conn,
                        workspace_id,
                        connection_id,
                        actor_member_id,
                        &claims_for_tx,
                    )
                    .await?;
                    return match denied {
                        Ok(request_id) => {
                            write_audit(
                                conn,
                                &AuditEntry::new(workspace_id, AUDIT_CONSENT_DENIED)
                                    .by(actor_member_id)
                                    .via_token(via_token_id)
                                    .target("hosted_oauth_authorization_request", request_id)
                                    .with_schema(
                                        CONSENT_SCHEMA,
                                        json!({
                                            "decision": "denied",
                                            "client_id": claims_for_tx.cid,
                                            "connection_id": connection_id,
                                            "requested_scope_count": claims_for_tx.scp.len(),
                                        }),
                                    ),
                            )
                            .await?;
                            Ok(Ok(None))
                        }
                        Err(refusal) => Ok(Err(refusal_error(refusal))),
                    };
                }

                // The scope ceiling is shared with static activation: an
                // approval outside `HOSTED_AGENT_PORT_GRANTABLE_SCOPES`, or
                // outside what this request asked for, is refused BEFORE any
                // code exists, and the refusal is audited with counts only —
                // never a secret, never a digest.
                let unknown_scope = approved_scopes
                    .iter()
                    .any(|scope| !HOSTED_AGENT_SCOPES.contains(&scope.as_str()));
                let unrequested_scope = approved_scopes
                    .iter()
                    .any(|scope| !claims_for_tx.scp.iter().any(|asked| asked == scope));
                if unknown_scope || unrequested_scope {
                    write_audit(
                        conn,
                        &AuditEntry::new(workspace_id, AUDIT_SCOPE_DENIED)
                            .by(actor_member_id)
                            .via_token(via_token_id)
                            .target("hosted_agent_connection", connection_id)
                            .with_schema(
                                CONSENT_SCHEMA,
                                json!({
                                    "decision": "scope_denied",
                                    "client_id": claims_for_tx.cid,
                                    "outside_hosted_ceiling": unknown_scope,
                                    "outside_request": unrequested_scope,
                                    "approved_scope_count": approved_scopes.len(),
                                }),
                            ),
                    )
                    .await?;
                    return Ok(Err(ApiError::bad_request(
                        "approvedScopes must be a subset of the requested hosted scopes",
                    )));
                }

                let approved = approve_hosted_oauth_request_in_tx(
                    conn,
                    workspace_id,
                    connection_id,
                    actor_member_id,
                    &claims_for_tx,
                    &approved_scopes,
                    &approved_channel_ids,
                )
                .await?;
                match approved {
                    Ok(approval) => {
                        write_audit(
                            conn,
                            &AuditEntry::new(workspace_id, AUDIT_CONSENT_GRANTED)
                                .by(actor_member_id)
                                .via_token(via_token_id)
                                .target("hosted_oauth_authorization_request", approval.request_id)
                                .with_schema(
                                    CONSENT_SCHEMA,
                                    json!({
                                        "decision": "approved",
                                        "client_id": claims_for_tx.cid,
                                        "connection_id": approval.connection_id,
                                        "approved_scopes": approved_scopes,
                                        "approved_channel_count": approved_channel_ids.len(),
                                    }),
                                ),
                        )
                        .await?;
                        Ok(Ok(Some(approval)))
                    }
                    Err(refusal) => Ok(Err(refusal_error(refusal))),
                }
            })
        })
        .await,
    )?;

    let redirect_to = match &outcome {
        Some(approval) => authorization_redirect(
            &claims.ru,
            &issuer,
            claims.st.as_deref(),
            Ok(&approval.authorization_code),
        ),
        None => authorization_redirect(
            &claims.ru,
            &issuer,
            claims.st.as_deref(),
            Err(OauthError::AccessDenied),
        ),
    };
    Ok(no_store(
        Json(HostedOauthDecisionResponse {
            redirect_to,
            connection_id: connection_id.to_string(),
        })
        .into_response(),
    ))
}

fn refusal_error(refusal: HostedOauthRefusal) -> ApiError {
    match refusal {
        // Not-found rather than a distinct 409 for the two states that would
        // otherwise tell a caller which connections exist.
        HostedOauthRefusal::NotFound | HostedOauthRefusal::Expired => {
            ApiError::not_found("not found")
        }
        HostedOauthRefusal::WrongState => ApiError::new(
            StatusCode::CONFLICT,
            "connection is not awaiting authorization",
        ),
        // The one terminal decision already exists. A duplicate click, a
        // reload, a back-then-approve and a late callback all land here.
        HostedOauthRefusal::AlreadyDecided => ApiError::new(
            StatusCode::CONFLICT,
            "this authorization request already has a decision",
        ),
        HostedOauthRefusal::InvalidApproval => {
            ApiError::bad_request("approved scopes or channels are not valid for this request")
        }
    }
}

// ---------------------------------------------------------------------------
// Token endpoint (RFC 6749 §4.1.3 / §6, RFC 8707, RFC 7636)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct TokenForm {
    grant_type: Option<String>,
    client_id: Option<String>,
    code: Option<String>,
    code_verifier: Option<String>,
    redirect_uri: Option<String>,
    refresh_token: Option<String>,
    resource: Option<String>,
}

/// `POST /v1/oauth/token`
pub async fn token(State(state): State<AppState>, Form(form): Form<TokenForm>) -> Response {
    let oauth = &state.agent_port.config.oauth;
    let Some(canonical_resource) = oauth.resource() else {
        return not_found();
    };
    let Some(client_id) = form
        .client_id
        .as_deref()
        .filter(|value| !value.is_empty() && value.len() <= MAX_CLIENT_ID_BYTES)
    else {
        return oauth_failure(OauthError::InvalidClient);
    };
    let Some(client) = oauth.client(client_id) else {
        return oauth_failure(OauthError::InvalidClient);
    };
    // RFC 8707: the resource is required on the token request too, not only on
    // the authorization request, so an access token cannot be minted for an
    // audience the client stopped naming.
    if let Err(error) = validate_resource(form.resource.as_deref(), &canonical_resource) {
        return oauth_failure(error);
    }
    let registered_redirects = client.redirect_uris.clone();
    let client_id = client_id.to_string();

    match form.grant_type.as_deref() {
        Some(GRANT_TYPE_AUTHORIZATION_CODE) => {
            exchange_code(
                &state,
                &client_id,
                &registered_redirects,
                &canonical_resource,
                &form,
            )
            .await
        }
        Some(GRANT_TYPE_REFRESH_TOKEN) => refresh(&state, &client_id, &form).await,
        _ => oauth_failure(OauthError::UnsupportedGrantType),
    }
}

async fn exchange_code(
    state: &AppState,
    client_id: &str,
    registered_redirects: &[String],
    canonical_resource: &str,
    form: &TokenForm,
) -> Response {
    let (Some(raw_code), Some(verifier), Some(redirect_uri)) = (
        form.code.as_deref(),
        form.code_verifier.as_deref(),
        form.redirect_uri.as_deref(),
    ) else {
        return oauth_failure(OauthError::InvalidRequest);
    };
    if !redirect_uri_is_registered(redirect_uri, registered_redirects) {
        return oauth_failure(OauthError::InvalidGrant);
    }
    let Some(workspace_id) = hosted_oauth_code_workspace_id(raw_code) else {
        return oauth_failure(OauthError::InvalidGrant);
    };

    let raw_code = raw_code.to_string();
    let verifier = verifier.to_string();
    let redirect_uri = redirect_uri.to_string();
    let canonical_resource = canonical_resource.to_string();
    let client_id = client_id.to_string();
    let outcome = with_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            let Some(locked) = lock_hosted_oauth_code_in_tx(conn, workspace_id, &raw_code)
                .await
                .map_err(DbError::from)?
            else {
                return Ok(Err(OauthError::InvalidGrant));
            };
            // A code presented twice is a compromise signal, not a mistake: the
            // whole family it minted is revoked here, in the same transaction
            // that refuses the exchange, and the reason is recorded once.
            if locked.status == "consumed" {
                revoke_hosted_oauth_family_in_tx(conn, workspace_id, locked.connection_id)
                    .await
                    .map_err(DbError::from)?;
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, AUDIT_CREDENTIAL_REPLAYED)
                        .about(locked.agent_member_id)
                        .target("hosted_agent_connection", locked.connection_id)
                        .with_schema(
                            REPLAY_SCHEMA,
                            json!({
                                "credential": "authorization_code",
                                "client_id": locked.client_id,
                                "action": "family_revoked",
                            }),
                        ),
                )
                .await?;
                return Ok(Err(OauthError::InvalidGrant));
            }
            // Every binding the code carries is re-asserted, and each of these
            // is one row of the attack matrix: wrong client, wrong redirect,
            // wrong resource, wrong connection state, expired code, bad
            // verifier.
            if locked.status != "approved"
                || locked.expired
                || locked.client_id != client_id
                || locked.redirect_uri != redirect_uri
                || locked.resource != canonical_resource
                || locked.connection_status != "detected"
                || !verify_pkce_s256(&verifier, &locked.code_challenge)
            {
                return Ok(Err(OauthError::InvalidGrant));
            }
            let Some(issuance) = consume_hosted_oauth_code_in_tx(conn, workspace_id, &locked)
                .await
                .map_err(DbError::from)?
            else {
                return Ok(Err(OauthError::InvalidGrant));
            };
            write_audit(
                conn,
                &AuditEntry::new(workspace_id, AUDIT_TOKEN_ISSUED)
                    .about(issuance.agent_member_id)
                    .via_token(Some(issuance.access_token_id))
                    .target("hosted_agent_connection", issuance.connection_id)
                    .with_schema(
                        TOKEN_SCHEMA,
                        json!({
                            "grant_type": GRANT_TYPE_AUTHORIZATION_CODE,
                            "client_id": client_id,
                            "audience": momo_auth::HOSTED_AGENT_PORT_AUDIENCE,
                            "scopes": issuance.scopes,
                            "expires_in_seconds": issuance.expires_in_seconds,
                        }),
                    ),
            )
            .await?;
            Ok(Ok(issuance))
        })
    })
    .await;
    settle_token(outcome, "oauth.token.authorization_code")
}

async fn refresh(state: &AppState, client_id: &str, form: &TokenForm) -> Response {
    let Some(raw_refresh) = form.refresh_token.as_deref() else {
        return oauth_failure(OauthError::InvalidRequest);
    };
    let Some(workspace_id) = hosted_oauth_refresh_workspace_id(raw_refresh) else {
        return oauth_failure(OauthError::InvalidGrant);
    };
    let raw_refresh = raw_refresh.to_string();
    let client_id = client_id.to_string();
    let outcome = with_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            let rotated =
                rotate_hosted_oauth_refresh_in_tx(conn, workspace_id, &raw_refresh, &client_id)
                    .await
                    .map_err(DbError::from)?;
            match rotated {
                HostedOauthRefresh::Rotated(issuance) => {
                    write_audit(
                        conn,
                        &AuditEntry::new(workspace_id, AUDIT_TOKEN_REFRESHED)
                            .about(issuance.agent_member_id)
                            .via_token(Some(issuance.access_token_id))
                            .target("hosted_agent_connection", issuance.connection_id)
                            .with_schema(
                                TOKEN_SCHEMA,
                                json!({
                                    "grant_type": GRANT_TYPE_REFRESH_TOKEN,
                                    "client_id": client_id,
                                    "audience": momo_auth::HOSTED_AGENT_PORT_AUDIENCE,
                                    "scopes": issuance.scopes,
                                    "expires_in_seconds": issuance.expires_in_seconds,
                                }),
                            ),
                    )
                    .await?;
                    Ok(Ok(*issuance))
                }
                HostedOauthRefresh::Reused {
                    connection_id,
                    agent_member_id,
                } => {
                    // `rotate_…` already revoked the family under the lock. The
                    // audit is the other half and belongs to the same
                    // transaction, so a rolled-back revocation cannot leave a
                    // record claiming it happened. It names the same
                    // subject/target the code-replay audit does — the dedicated
                    // member and its connection — so the two replay rows are
                    // queryable the same way, and neither carries a secret or a
                    // digest.
                    write_audit(
                        conn,
                        &AuditEntry::new(workspace_id, AUDIT_CREDENTIAL_REPLAYED)
                            .about(agent_member_id)
                            .target("hosted_agent_connection", connection_id)
                            .with_schema(
                                REPLAY_SCHEMA,
                                json!({
                                    "credential": "refresh_token",
                                    "client_id": client_id,
                                    "action": "family_revoked",
                                }),
                            ),
                    )
                    .await?;
                    Ok(Err(OauthError::InvalidGrant))
                }
                HostedOauthRefresh::Invalid | HostedOauthRefresh::Unknown => {
                    Ok(Err(OauthError::InvalidGrant))
                }
            }
        })
    })
    .await;
    settle_token(outcome, "oauth.token.refresh")
}

fn settle_token(
    outcome: Result<Result<momo_auth::HostedOauthIssuance, OauthError>, DbError>,
    context: &'static str,
) -> Response {
    match outcome {
        Ok(Ok(issuance)) => {
            // Raw material, once, with `no-store`. Nothing here is logged and
            // nothing here is stored: the database holds only digests.
            no_store(
                Json(json!({
                    "access_token": issuance.access_token,
                    "token_type": TOKEN_TYPE_BEARER,
                    "expires_in": issuance.expires_in_seconds,
                    "refresh_token": issuance.refresh_token,
                    "scope": issuance.scopes.join(" "),
                }))
                .into_response(),
            )
        }
        Ok(Err(error)) => oauth_failure(error),
        Err(error) => {
            tracing::error!(error = %error, context, "OAuth token transaction failed");
            oauth_failure(OauthError::ServerError)
        }
    }
}

// ---------------------------------------------------------------------------
// Revocation (RFC 7009)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct RevokeForm {
    token: Option<String>,
    client_id: Option<String>,
}

/// `POST /v1/oauth/revoke`
///
/// RFC 7009 §2.2: an unknown token is a success. This endpoint therefore never
/// tells a caller whether a credential exists — the only observable difference
/// between a real revocation and a no-op is that the real one stops working.
///
/// Revoking either half retires both. A resource owner who revokes access has
/// not asked for the refresh credential to keep minting new ones.
pub async fn revoke(State(state): State<AppState>, Form(form): Form<RevokeForm>) -> Response {
    let oauth = &state.agent_port.config.oauth;
    if !oauth.is_enabled() {
        return not_found();
    }
    let Some(client_id) = form
        .client_id
        .as_deref()
        .filter(|value| oauth.client(value).is_some())
    else {
        return oauth_failure(OauthError::InvalidClient);
    };
    let Some(raw_token) = form.token.as_deref() else {
        return oauth_failure(OauthError::InvalidRequest);
    };
    let Some(workspace_id) = hosted_oauth_access_workspace_id(raw_token)
        .or_else(|| hosted_oauth_refresh_workspace_id(raw_token))
    else {
        return no_store(StatusCode::OK.into_response());
    };
    let raw_token = raw_token.to_string();
    let client_id = client_id.to_string();
    let outcome = with_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            let Some(connection_id) = resolve_hosted_oauth_revocation_target_in_tx(
                conn,
                workspace_id,
                &raw_token,
                &client_id,
            )
            .await
            .map_err(DbError::from)?
            else {
                return Ok(());
            };
            let revoked = revoke_hosted_oauth_family_in_tx(conn, workspace_id, connection_id)
                .await
                .map_err(DbError::from)?;
            if revoked > 0 {
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, AUDIT_TOKEN_REVOKED)
                        .target("hosted_agent_connection", connection_id)
                        .with_schema(
                            TOKEN_SCHEMA,
                            json!({
                                "client_id": client_id,
                                "revoked_credential_count": revoked,
                            }),
                        ),
                )
                .await?;
            }
            Ok(())
        })
    })
    .await;
    if let Err(error) = outcome {
        tracing::error!(error = %error, "OAuth revocation transaction failed");
        return oauth_failure(OauthError::ServerError);
    }
    no_store(StatusCode::OK.into_response())
}
