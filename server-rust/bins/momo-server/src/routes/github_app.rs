//! The GitHub App registration surface — the operator side of ADR-0205 (#3947 E-GH1).
//!
//! ```text
//! GET  /v1/integrations/github/app            operator: is an App registered? (no secrets)
//! POST /v1/integrations/github/app/manifest   operator: mint the manifest + one-time state
//! GET  /v1/integrations/github/app/callback   GitHub → browser redirect (public, state-guarded)
//! PUT  /v1/integrations/github/app            operator: paste an App made by hand (write-only)
//! ```
//!
//! Receiving events, linking an installation and subscribing channels are E-GH2 (#3954).
//!
//! ## Four things this module holds on to
//!
//! 1. **No `GITHUB_APP_MASTER_KEY`, no GitHub surface.** Every handler answers 503 without
//!    it and the rest of the server is untouched. Reusing another master key is a boot error
//!    (`config.rs`), so the key that seals the App is independent of every other root.
//! 2. **The plaintext PEM never leaves the callback function.** `callback` receives the
//!    conversion, seals both secrets on the next lines and drops them. No helper takes them,
//!    no log line, audit detail or response carries them, and `client_secret` is not even a
//!    field of the converted type (`momo-github`).
//! 3. **Phase 1 never opens the PEM.** Nothing here calls the PEM opener; a grep guard in
//!    `momo-settings` fails the build of any PR that does (acceptance 7).
//! 4. **The callback is unauthenticated, so the state is the authority.** It is a one-time,
//!    hash-only, one-hour token minted by an operator ([`momo_settings::new_state_token`]);
//!    the callback spends it, re-checks that its minter is *still* a listed instance operator,
//!    and only then goes to GitHub. A forged, replayed or expired state does nothing.

use axum::extract::{Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use momo_auth::Principal;
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::with_github_app_admin_tx;
use momo_settings::{
    build_manifest, consume_manifest_claim, default_app_name, insert_github_app,
    insert_manifest_claim, is_valid_org_login, looks_like_pem_private_key,
    manifest_registration_url, new_state_token, read_github_app_status, seal_github_secret,
    state_hash, state_workspace_hint, upsert_github_app, GithubAppStatus, GithubSecretSlot,
    ManifestIntent, ManifestOwner, NewGithubApp, GITHUB_DEFAULT_EVENTS, GITHUB_DEFAULT_PERMISSIONS,
};
use serde::{Deserialize, Serialize};

use crate::config::GithubAppSettings;
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, require_instance_operator,
    require_instance_operator_write, settle_db,
};
use crate::AppState;

const STATUS_SCHEMA: &str = "oort.github_app.status.v1";
const MANIFEST_SCHEMA: &str = "oort.github_app.manifest.v1";
const AUDIT_SCHEMA: &str = "oort.github_app.audit.v1";

pub const AUDIT_MANIFEST_STARTED: &str = "github_app.manifest_started";
pub const AUDIT_REGISTERED: &str = "github_app.registered";
pub const AUDIT_REGISTRATION_FAILED: &str = "github_app.registration_failed";
pub const AUDIT_PASTED: &str = "github_app.pasted";

/// The per-call budget for the one request phase 1 makes to GitHub.
pub const CONVERT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// The GitHub surface's process state: the sealing key and the one outbound hop.
pub struct GithubAppState {
    pub settings: GithubAppSettings,
    pub converter: std::sync::Arc<dyn momo_github::GithubAppConverter>,
}

impl GithubAppState {
    pub fn new(
        settings: GithubAppSettings,
        converter: std::sync::Arc<dyn momo_github::GithubAppConverter>,
    ) -> GithubAppState {
        GithubAppState {
            settings,
            converter,
        }
    }
}

impl Default for GithubAppState {
    /// No key (every route 503) and the production converter (public addresses only).
    fn default() -> Self {
        GithubAppState::new(
            GithubAppSettings::default(),
            std::sync::Arc::new(momo_github::GuardedGithubConverter::production(
                CONVERT_TIMEOUT,
            )),
        )
    }
}

/// Without the dedicated master key nothing can be sealed or opened, so the only
/// honest answer is 503 (the same posture `PROVIDER_LINK_MASTER_KEY` has).
fn master_key(state: &AppState) -> Result<&str, ApiError> {
    state.github.settings.master_key.as_deref().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "이 서버에는 GITHUB_APP_MASTER_KEY가 설정되어 있지 않아 GitHub 연결을 쓸 수 없어요. \
             인스턴스 운영자에게 문의해 주세요.",
        )
    })
}

/// The instance's public https origin, or `None` when GitHub cannot reach it.
fn public_base(state: &AppState) -> Option<String> {
    state.t3.ready_public_base_url()
}

fn no_public_address() -> ApiError {
    ApiError::coded(
        StatusCode::CONFLICT,
        "public_address_required",
        "공개 주소가 없어 GitHub 알림을 받을 수 없어요. MOMO_PUBLIC_BASE_URL에 이 서버의 공개 \
         HTTPS 주소를 먼저 정해 주세요.",
    )
}

// ---------------------------------------------------------------------------
// projection
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppDto {
    app_id: i64,
    slug: String,
    client_id: String,
    owner_login: String,
    owner_type: String,
    source: String,
    created_at_ms: i64,
    rotation_window_open: bool,
    install_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubAppStatusResponse {
    schema: &'static str,
    master_key_configured: bool,
    public_address_configured: bool,
    configured: bool,
    app: Option<AppDto>,
    permissions: std::collections::BTreeMap<&'static str, &'static str>,
    events: &'static [&'static str],
}

fn status_response(state: &AppState, app: Option<GithubAppStatus>) -> GithubAppStatusResponse {
    GithubAppStatusResponse {
        schema: STATUS_SCHEMA,
        master_key_configured: state.github.settings.master_key.is_some(),
        public_address_configured: public_base(state).is_some(),
        configured: app.is_some(),
        app: app.map(|app| AppDto {
            install_url: format!("https://github.com/apps/{}/installations/new", app.slug),
            app_id: app.app_id,
            slug: app.slug,
            client_id: app.client_id,
            owner_login: app.owner_login,
            owner_type: app.owner_type,
            source: app.source,
            created_at_ms: app.created_at_ms,
            rotation_window_open: app.rotation_window_open,
        }),
        permissions: GITHUB_DEFAULT_PERMISSIONS.iter().copied().collect(),
        events: &GITHUB_DEFAULT_EVENTS,
    }
}

// ---------------------------------------------------------------------------
// GET /v1/integrations/github/app
// ---------------------------------------------------------------------------

pub async fn get(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<GithubAppStatusResponse>, ApiError> {
    require_instance_operator(&state, &principal).await?;
    master_key(&state)?;
    let app = with_github_app_admin_tx(&state.pool, principal.workspace_id, |conn| {
        Box::pin(async move { read_github_app_status(conn).await })
    })
    .await
    .map_err(|error| ApiError::internal("github_app.status", error))?;
    Ok(Json(status_response(&state, app)))
}

// ---------------------------------------------------------------------------
// POST /v1/integrations/github/app/manifest
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartManifestRequest {
    /// `user` (a personal account) or `organization`.
    owner_type: String,
    /// The organization login, when `ownerType` is `organization`.
    organization: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartManifestResponse {
    schema: &'static str,
    /// Where the operator's browser POSTs the form (it already carries `state`).
    registration_url: String,
    /// The form field to POST to `registrationUrl`, as a JSON object. The client sends it as
    /// a single `manifest` field holding this object serialised.
    manifest: serde_json::Value,
    expires_in_seconds: i64,
}

pub async fn start_manifest(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<StartManifestRequest>,
) -> Result<Json<StartManifestResponse>, ApiError> {
    require_instance_operator_write(&state, &principal).await?;
    master_key(&state)?;
    let base = public_base(&state).ok_or_else(no_public_address)?;

    let owner = match request.owner_type.trim() {
        "user" => ManifestOwner::User,
        "organization" => {
            let org = request.organization.as_deref().unwrap_or("").trim();
            if !is_valid_org_login(org) {
                return Err(ApiError::bad_request(
                    "organization must be a GitHub organization login (letters, digits, hyphen)",
                ));
            }
            ManifestOwner::Organization(org.to_string())
        }
        _ => {
            return Err(ApiError::bad_request(
                "ownerType must be one of user, organization",
            ))
        }
    };

    let workspace_id = principal.workspace_id;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);
    let token = new_state_token(workspace_id)
        .map_err(|error| ApiError::internal("github_app.state", error))?;
    let hash = state_hash(&token);
    let intent = ManifestIntent::from_owner(&owner);
    let audit_owner = match &owner {
        ManifestOwner::User => serde_json::json!({ "owner_type": "user" }),
        ManifestOwner::Organization(org) => {
            serde_json::json!({ "owner_type": "organization", "organization": org })
        }
    };

    let started = with_github_app_admin_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            if read_github_app_status(conn).await?.is_some() {
                return Ok(false);
            }
            insert_manifest_claim(conn, workspace_id, member_id, &hash, &intent).await?;
            write_audit(
                conn,
                &AuditEntry::new(workspace_id, AUDIT_MANIFEST_STARTED)
                    .by(member_id)
                    .via_token(via_token)
                    .with_schema(AUDIT_SCHEMA, audit_owner),
            )
            .await?;
            Ok(true)
        })
    })
    .await
    .map_err(|error| ApiError::internal("github_app.manifest_start", error))?;
    if !started {
        return Err(ApiError::coded(
            StatusCode::CONFLICT,
            "github_app_already_registered",
            "이 서버에는 이미 GitHub 앱이 등록되어 있어요.",
        ));
    }

    Ok(Json(StartManifestResponse {
        schema: MANIFEST_SCHEMA,
        registration_url: manifest_registration_url(&owner, &token),
        manifest: build_manifest(&base, &default_app_name(&base)),
        expires_in_seconds: momo_settings::github_app::MANIFEST_STATE_TTL_SECONDS,
    }))
}

// ---------------------------------------------------------------------------
// GET /v1/integrations/github/app/callback
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
}

/// Back to the web client with a verdict word, never a secret. The landing UI is U-GH1's.
fn back_to_client(base: &str, outcome: &str) -> Response {
    let location = format!("{}/?githubApp={outcome}", base.trim_end_matches('/'));
    let mut response = StatusCode::SEE_OTHER.into_response();
    if let Ok(value) = HeaderValue::from_str(&location) {
        response.headers_mut().insert(header::LOCATION, value);
    }
    // The request that brought us here carried `code` and `state` in its URL; the page we
    // redirect to must not learn it.
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}

/// Is `member` still an owner/admin whose verified email is on `PLATFORM_ADMIN_EMAILS`?
/// (The write-form of the instance-operator gate; `platform:read` is not enough.)
fn is_listed_operator(
    state: &AppState,
    role: Option<momo_auth::WorkspaceRole>,
    email: Option<String>,
) -> bool {
    role.is_some_and(|role| role.is_admin())
        && email.is_some_and(|email| state.settings.platform_admin_emails.contains(&email))
}

pub async fn callback(
    State(state): State<AppState>,
    Query(query): Query<CallbackQuery>,
) -> Response {
    let key = match master_key(&state) {
        Ok(key) => key.to_string(),
        Err(error) => return error.into_response(),
    };
    let Some(base) = public_base(&state) else {
        return no_public_address().into_response();
    };

    // 1. The state: shape, then spend. Nothing below runs without a live, unspent one.
    let (Some(code), Some(token)) = (query.code.as_deref(), query.state.as_deref()) else {
        return back_to_client(&base, "invalid_request");
    };
    let Some(workspace_id) = state_workspace_hint(token) else {
        return back_to_client(&base, "state_invalid");
    };
    let hash = state_hash(token);
    let spent = settle_db(
        "github_app.callback.state",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let Some(claim) = consume_manifest_claim(conn, &hash).await? else {
                    return Ok(Ok(None));
                };
                let member_id = claim.member_id;
                let role = momo_auth::active_workspace_role(conn, workspace_id, member_id).await?;
                let email =
                    momo_auth::verified_operator_email(conn, workspace_id, member_id).await?;
                Ok(Ok(Some((claim.intent, member_id, role, email))))
            })
        })
        .await,
    );
    let (intent, member_id, role, email) = match spent {
        Ok(Some(found)) => found,
        Ok(None) => return back_to_client(&base, "state_invalid"),
        Err(error) => return error.into_response(),
    };
    // The minter must STILL be a listed operator: a demoted admin's pending state is dead.
    if !is_listed_operator(&state, role, email) {
        return back_to_client(&base, "not_operator");
    }

    // 2. GitHub: one conversion call. Failure reasons are labels, never response text.
    let converted = match state.github.converter.convert_manifest(code).await {
        Ok(converted) => converted,
        Err(error) => {
            let label = error.label();
            let _ = with_github_app_admin_tx(&state.pool, workspace_id, move |conn| {
                Box::pin(async move {
                    write_audit(
                        conn,
                        &AuditEntry::new(workspace_id, AUDIT_REGISTRATION_FAILED)
                            .by(member_id)
                            .with_schema(AUDIT_SCHEMA, serde_json::json!({ "reason": label })),
                    )
                    .await?;
                    Ok(())
                })
            })
            .await;
            return back_to_client(&base, &format!("convert_{label}"));
        }
    };

    // 2b. The App must belong to the account the operator asked for. A state that leaked cannot
    //     be paired with a `code` for an App created under someone else's account: that App
    //     (which exists at GitHub now) is refused here, and nothing about it is stored.
    if !intent.matches(&converted.owner_type, &converted.owner_login) {
        drop(converted);
        let _ = with_github_app_admin_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, AUDIT_REGISTRATION_FAILED)
                        .by(member_id)
                        .with_schema(
                            AUDIT_SCHEMA,
                            serde_json::json!({ "reason": "owner_mismatch" }),
                        ),
                )
                .await?;
                Ok(())
            })
        })
        .await;
        return back_to_client(&base, "owner_mismatch");
    }

    // 3. Seal, store, forget — in this function. The plaintext PEM and webhook secret are
    //    sealed on the next two statements and are not passed anywhere else.
    let pem_sealed = seal_github_secret(converted.pem.expose(), &key, GithubSecretSlot::Pem);
    let webhook_sealed = seal_github_secret(
        converted.webhook_secret.expose(),
        &key,
        GithubSecretSlot::WebhookSecret,
    );
    let (Ok(pem_sealed), Ok(webhook_sealed)) = (pem_sealed, webhook_sealed) else {
        tracing::error!("github app secret could not be sealed");
        return back_to_client(&base, "seal_failed");
    };
    let app_id = converted.app_id;
    let slug = converted.slug.clone();
    let client_id = converted.client_id.clone();
    let owner_login = converted.owner_login.clone();
    let owner_type = converted.owner_type.clone();
    drop(converted);

    let stored = with_github_app_admin_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            let inserted = insert_github_app(
                conn,
                &NewGithubApp {
                    app_id,
                    slug: &slug,
                    client_id: &client_id,
                    owner_login: &owner_login,
                    owner_type: &owner_type,
                    pem_sealed: &pem_sealed,
                    webhook_secret_sealed: &webhook_sealed,
                    source: "manifest",
                    created_by: Some(member_id),
                },
            )
            .await?;
            if inserted {
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, AUDIT_REGISTERED)
                        .by(member_id)
                        .with_schema(
                            AUDIT_SCHEMA,
                            // Identity only: no pem, no webhook secret, no client_secret.
                            serde_json::json!({
                                "source": "manifest",
                                "app_id": app_id,
                                "slug": slug,
                                "owner_login": owner_login,
                                "owner_type": owner_type,
                            }),
                        ),
                )
                .await?;
            }
            Ok(inserted)
        })
    })
    .await;
    match stored {
        Ok(true) => back_to_client(&base, "created"),
        Ok(false) => back_to_client(&base, "already_registered"),
        Err(error) => {
            tracing::error!(%error, "github app could not be stored");
            back_to_client(&base, "store_failed")
        }
    }
}

// ---------------------------------------------------------------------------
// PUT /v1/integrations/github/app  (write-only paste form)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteAppRequest {
    app_id: i64,
    slug: String,
    client_id: String,
    owner_login: String,
    /// `User` or `Organization`.
    owner_type: String,
    private_key: String,
    webhook_secret: String,
}

fn is_slug(value: &str) -> bool {
    (1..=100).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

pub async fn paste(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<PasteAppRequest>,
) -> Result<Json<GithubAppStatusResponse>, ApiError> {
    require_instance_operator_write(&state, &principal).await?;
    let key = master_key(&state)?.to_string();

    if request.app_id <= 0 {
        return Err(ApiError::bad_request("appId must be a positive integer"));
    }
    if !is_slug(request.slug.trim()) {
        return Err(ApiError::bad_request(
            "slug must be a GitHub App slug (letters, digits, hyphen)",
        ));
    }
    if request.client_id.trim().is_empty() || request.client_id.len() > 200 {
        return Err(ApiError::bad_request("clientId must not be empty"));
    }
    if !is_valid_org_login(request.owner_login.trim()) {
        return Err(ApiError::bad_request(
            "ownerLogin must be a GitHub account login",
        ));
    }
    if !matches!(request.owner_type.as_str(), "User" | "Organization") {
        return Err(ApiError::bad_request(
            "ownerType must be one of User, Organization",
        ));
    }
    if !looks_like_pem_private_key(&request.private_key) {
        return Err(ApiError::bad_request(
            "privateKey must be the PEM private key GitHub generated for the app",
        ));
    }
    if request.webhook_secret.trim().is_empty() {
        return Err(ApiError::bad_request("webhookSecret must not be empty"));
    }

    // Seal before anything else touches them; the request body is dropped with this function.
    let pem_sealed = seal_github_secret(&request.private_key, &key, GithubSecretSlot::Pem)
        .map_err(|error| ApiError::internal("github_app.seal", error))?;
    let webhook_sealed = seal_github_secret(
        &request.webhook_secret,
        &key,
        GithubSecretSlot::WebhookSecret,
    )
    .map_err(|error| ApiError::internal("github_app.seal", error))?;
    let slug = request.slug.trim().to_string();
    let client_id = request.client_id.trim().to_string();
    let owner_login = request.owner_login.trim().to_string();
    let owner_type = request.owner_type.clone();
    let app_id = request.app_id;
    drop(request);

    let workspace_id = principal.workspace_id;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);
    let app = with_github_app_admin_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            upsert_github_app(
                conn,
                &NewGithubApp {
                    app_id,
                    slug: &slug,
                    client_id: &client_id,
                    owner_login: &owner_login,
                    owner_type: &owner_type,
                    pem_sealed: &pem_sealed,
                    webhook_secret_sealed: &webhook_sealed,
                    source: "paste",
                    created_by: Some(member_id),
                },
            )
            .await?;
            write_audit(
                conn,
                &AuditEntry::new(workspace_id, AUDIT_PASTED)
                    .by(member_id)
                    .via_token(via_token)
                    .with_schema(
                        AUDIT_SCHEMA,
                        serde_json::json!({
                            "source": "paste",
                            "app_id": app_id,
                            "slug": slug,
                            "owner_login": owner_login,
                            "owner_type": owner_type,
                        }),
                    ),
            )
            .await?;
            read_github_app_status(conn).await
        })
    })
    .await
    .map_err(|error| ApiError::internal("github_app.paste", error))?;
    Ok(Json(status_response(&state, app)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_are_policed() {
        assert!(is_slug("oort-team"));
        for bad in ["", "a b", "a/b", "a?x", &"x".repeat(101)] {
            assert!(!is_slug(bad), "{bad}");
        }
    }

    #[tokio::test]
    async fn the_status_response_names_the_permissions_it_asks_for() {
        let state = crate::AppState::new(
            sqlx_lazy_pool(),
            "jwt".to_string(),
            "ws://127.0.0.1:1/connection/websocket".to_string(),
        );
        let response = status_response(&state, None);
        assert_eq!(response.permissions.len(), 5);
        assert!(response.permissions.values().all(|level| *level == "read"));
        assert!(!response.configured);
        assert!(!response.master_key_configured);
    }

    fn sqlx_lazy_pool() -> momo_db::PgPool {
        momo_db::sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://u:p@127.0.0.1:1/none")
            .expect("lazy pool")
    }
}
