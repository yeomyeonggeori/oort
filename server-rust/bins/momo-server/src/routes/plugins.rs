//! ADR-0113 증보 2026-10-15 (#3838) P-S1 + P3 (#3914) — the plugin registry's two
//! reads and four writes, for the four official plugins only.
//!
//! ```text
//! GET    /v1/workspaces/{ws}/plugins                      catalog + the caller's own policy
//! GET    /v1/workspaces/{ws}/plugins/{plugin}             one manifest
//! POST   /v1/workspaces/{ws}/plugins/{plugin}/install     install / enable / disable   201 | 200
//! DELETE /v1/workspaces/{ws}/plugins/{plugin}/install     uninstall + revoke all grants
//! POST   /v1/workspaces/{ws}/plugins/{plugin}/grants      the caller grants one scope  201 | 200
//! DELETE /v1/workspaces/{ws}/plugins/{plugin}/grants/{scope}  the caller revokes it
//! ```
//!
//! 결재 원문(2026-10-15, 성재): 「이월 풀고 읽기부터 (추천)」 — 쓰기는 P3로 미룸.
//! 결재 원문(2026-10-16, 성재): 「미뤄둔 후속도 같이 작업해줘.」
//!
//! * **Wire = the deployed core parser.** `packages/momo-core/src/lib/api.ts`
//!   `pluginCatalogFromWire` / `pluginDetailFromWire` / `pluginMutationFromWire`
//!   already parse the Swift `PluginRoutes` shape (deleted in #2165); this module
//!   answers exactly that shape, and the conformance tests
//!   (`tests/plugin_registry_read_conformance_pg.rs`,
//!   `tests/plugin_registry_write_conformance_pg.rs`) pin the bytes to
//!   `server/Fixtures/plugin-wire/*.json`, which the web suite feeds through the
//!   same parser.
//! * **Four official plugins, three guards.** A row is shown only when it is
//!   `official`, not revoked, **and** one of [`OFFICIAL_PLUGIN_IDS`]. Anything
//!   else is the same 404 as an id that does not exist.
//! * **Admission.** Every row passes [`crate::plugin_manifest`] (digest, exact
//!   key sets, allowlisted vocabularies, no credential-shaped key) and its
//!   registry id must equal the manifest id. The catalog omits a row that
//!   fails; the detail and every creating write answer 409, as Swift did.
//! * **No credential, anywhere.** `plugin_registry` holds policy metadata only
//!   (013, ADR-0113 D1 custody A) and `momo_app` cannot write it (037). The
//!   writes touch only install / grant / projection / audit rows, accept a body
//!   with exactly the keys the core client sends (anything else is a 400, a
//!   credential-shaped key included — it is never read, stored or echoed), and
//!   answer without a token-shaped field.
//! * **Human bearer.** Tenant rows (`workspace_plugin_install`, `plugin_grant`,
//!   `plugin_capability_projection`) are read and written inside
//!   `with_tenant_tx` under RLS FORCE. The reads answer a caller who is not an
//!   active member with the same 404 as an unknown plugin (P-S1 ④); the writes
//!   answer 403 (Swift's `requireMember`), because a write has to say why.
//! * **The rules live in [`crate::plugin_writes`].** The handlers here only
//!   translate: path and body shape, the transaction, the status line. The team
//!   AI's `plugin.install` card (#3889) calls the same functions.

use std::collections::BTreeMap;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use momo_auth::workspace_authorization::active_workspace_role;
use momo_auth::Principal;
use momo_db::sqlx::{self, Row};
use momo_db::PgConnection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::error::ApiError;
use crate::plugin_manifest::{is_plugin_id, validate_registry_manifest, ValidatedPluginManifest};
use crate::plugin_writes::{self, Actor, Mutation, Provenance};
use crate::realtime_advert::derive_same_origin_http_base;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, require_human, settle_db, workspace_scope, DbRejectable,
};
use crate::AppState;

/// ADR-0113 증보 P2: the only plugin ids these reads ever show. One definition,
/// shared with the team AI's `list_plugins` read (ADR-0201 증보 v2 H4-1).
pub use momo_workspace_actions::team_ai_tools::OFFICIAL_PLUGIN_IDS;

/// ADR-0113 D6's onboarding example set (Swift `onboardingRecommendedPluginIDs`).
/// Product recommendation, distinct from each manifest's `recommendedFor`.
/// `external_webhook` is not a registry row; it is kept so the set reads as
/// the decision wrote it.
const ONBOARDING_RECOMMENDED: [&str; 3] = [
    "com.momo.plugins.github",
    "com.momo.plugins.drive",
    "external_webhook",
];

/// One body for every reason a caller cannot see a plugin (or the catalog).
pub const NOT_FOUND: &str = "plugin not found";

/// The registry read both handlers share. `$1` = workspace, `$2` = the
/// allowlist, `$3` = one plugin id or NULL for all.
///
/// `computed_digest` is the expression migrations 013/015/031/059 used to seed
/// `manifest_digest`; only Postgres can reproduce its own canonical jsonb text.
const REGISTRY_SQL: &str = "\
SELECT pr.plugin_id, \
       pr.manifest::text AS manifest_text, \
       pr.manifest_digest, \
       'sha256:' || encode(sha256(convert_to(pr.manifest::text, 'UTF8')), 'hex') AS computed_digest, \
       pr.official, \
       (wpi.id IS NOT NULL AND wpi.revoked_at IS NULL) AS installed, \
       COALESCE(wpi.enabled, false) AS enabled \
  FROM plugin_registry pr \
  LEFT JOIN workspace_plugin_install wpi \
    ON wpi.workspace_id = $1 \
   AND wpi.plugin_id = pr.plugin_id \
 WHERE pr.official \
   AND pr.revoked_at IS NULL \
   AND pr.plugin_id = ANY($2) \
   AND ($3::text IS NULL OR pr.plugin_id = $3) \
 ORDER BY pr.plugin_id";

/// The caller's own effective tool policy (Swift `list` capability query): a
/// projection row counts only while its grant is active and the install is
/// enabled and unrevoked.
const POLICY_SQL: &str = "\
SELECT pcp.plugin_id, pcp.tool_name, pcp.risk, pcp.approval_tier \
  FROM plugin_capability_projection pcp \
  JOIN plugin_grant pg \
    ON pg.id = pcp.grant_id \
   AND pg.workspace_id = pcp.workspace_id \
   AND pg.member_id = pcp.member_id \
   AND pg.plugin_id = pcp.plugin_id \
   AND pg.scope = pcp.scope \
   AND pg.status = 'active' \
   AND pg.revoked_at IS NULL \
  JOIN workspace_plugin_install wpi \
    ON wpi.workspace_id = pcp.workspace_id \
   AND wpi.plugin_id = pcp.plugin_id \
   AND wpi.enabled \
   AND wpi.revoked_at IS NULL \
 WHERE pcp.workspace_id = $1 \
   AND pcp.member_id = $2 \
 ORDER BY pcp.plugin_id, pcp.tool_name";

#[derive(Debug, Clone)]
pub(crate) struct RegistryRow {
    plugin_id: String,
    manifest_text: String,
    /// `plugin_registry.manifest_digest` — what was declared; the audit rows
    /// record it as the manifest the member consented to.
    pub(crate) expected_digest: String,
    computed_digest: String,
    official: bool,
    installed: bool,
    enabled: bool,
}

impl RegistryRow {
    pub(crate) fn admit(
        &self,
    ) -> Result<ValidatedPluginManifest, crate::plugin_manifest::ManifestRejected> {
        validate_registry_manifest(
            &self.plugin_id,
            &self.manifest_text,
            &self.expected_digest,
            &self.computed_digest,
        )
    }
}

#[derive(Debug, Clone)]
struct PolicyRow {
    plugin_id: String,
    tool_name: String,
    risk: String,
    approval_tier: String,
}

// ---- wire (Swift PluginRoutes DTOs; camelCase; nil optionals omitted) -----

/// ADR-0113 증보 3 F1/F7 — one example sentence of a catalogue card. Plain text; the
/// `tool` is a tool of the same manifest (grade R or A, checked at admission).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct StarterPromptDto {
    pub text: String,
    pub tool: String,
}

fn starter_prompt_dtos(manifest: &ValidatedPluginManifest) -> Vec<StarterPromptDto> {
    manifest
        .starter_prompts
        .iter()
        .map(|prompt| StarterPromptDto {
            text: prompt.text.clone(),
            tool: prompt.tool.clone(),
        })
        .collect()
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginCatalogItemDto {
    pub plugin_id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    /// `plugin.publisher.name` — the one developer field (ADR-0113 증보 3 F1).
    pub publisher_name: String,
    #[serde(rename = "termsURL", skip_serializing_if = "Option::is_none")]
    pub terms_url: Option<String>,
    #[serde(rename = "privacyPolicyURL", skip_serializing_if = "Option::is_none")]
    pub privacy_policy_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_text: Option<String>,
    /// ADR-0113 증보 3 F1 — name of a client-bundled logo asset. Omitted when the
    /// manifest declares none; a client that does not know the key draws `iconText`
    /// / the name's first character instead.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logo_key: Option<String>,
    /// ADR-0113 증보 3 F1 — one of `communication` · `productivity` · `developer` ·
    /// `files` · `project`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// ADR-0113 증보 3 F1/F7 — 0~3 example sentences; omitted when there are none.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub starter_prompts: Vec<StarterPromptDto>,
    #[serde(rename = "websiteURL", skip_serializing_if = "Option::is_none")]
    pub website_url: Option<String>,
    pub official: bool,
    pub recommended: bool,
    pub egress_domains: Vec<String>,
    pub recommended_for: Vec<String>,
    pub installed: bool,
    pub enabled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCatalogResponse {
    pub plugins: Vec<PluginCatalogItemDto>,
    pub tool_policy: PluginToolPolicyDto,
}

#[derive(Debug, Serialize)]
pub struct PluginToolPolicyDto {
    pub plugins: Vec<PluginPolicyDescriptorDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPolicyDescriptorDto {
    pub plugin_id: String,
    pub mcp: PluginPolicyMcpDto,
    pub egress_domains: Vec<String>,
    pub tools: Vec<PluginPolicyToolDto>,
}

#[derive(Debug, Serialize)]
pub struct PluginPolicyMcpDto {
    pub url: String,
    pub transport: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPolicyToolDto {
    pub name: String,
    pub risk: String,
    pub approval_tier: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDetailDto {
    pub plugin_id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    /// `plugin.publisher.name` (see [`PluginCatalogItemDto::publisher_name`]).
    pub publisher_name: String,
    #[serde(rename = "termsURL", skip_serializing_if = "Option::is_none")]
    pub terms_url: Option<String>,
    #[serde(rename = "privacyPolicyURL", skip_serializing_if = "Option::is_none")]
    pub privacy_policy_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logo_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub starter_prompts: Vec<StarterPromptDto>,
    #[serde(rename = "websiteURL", skip_serializing_if = "Option::is_none")]
    pub website_url: Option<String>,
    pub official: bool,
    pub egress_domains: Vec<String>,
    pub recommended_for: Vec<String>,
    pub installed: bool,
    pub enabled: bool,
    pub manifest: Value,
}

#[derive(Debug, Serialize)]
pub struct PluginDetailResponse {
    pub plugin: PluginDetailDto,
}

/// The core client sends exactly `{"enabled": true}` to install and nothing to
/// uninstall. `enabled` may be left out (the manifest's `enabledByDefault`
/// decides). **Nothing else is accepted**: an unknown key — `accessToken`,
/// `memberId`, anything a newer client invents — is a 400, so a credential cannot
/// be handed to a server that promises never to hold one, and a caller cannot
/// believe a field named another member took effect.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct InstallPluginRequest {
    enabled: Option<bool>,
}

/// `{"scope": "github:read"}` — the caller, for themselves. There is no member
/// field to fill in (D2): a grant is the delegating user's own consent.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GrantPluginRequest {
    scope: String,
}

/// The one message for every body that is not exactly the documented shape. It
/// names no key and quotes no value, so a rejected credential is not echoed.
const INVALID_BODY: &str = "invalid request body";

/// Swift `PluginMutationResponse` (camelCase; nil optionals omitted) plus the
/// D5 receipt `egressDomains` on the two writes that extend access. The deployed
/// core parser reads `pluginId`, `status`, `enabled`, `capabilities` (required)
/// and `memberId`, `scope` (optional) and ignores the rest.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginMutationDto {
    pub plugin_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    pub status: String,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audit_ref: Option<String>,
    pub capabilities: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub egress_domains: Option<Vec<String>>,
}

// ---- handlers --------------------------------------------------------------

/// `GET /v1/workspaces/{ws}/plugins`
pub async fn list(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    headers: HeaderMap,
) -> Result<Json<PluginCatalogResponse>, ApiError> {
    require_human(&principal, "human delegated user required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let member_id = principal.member_id;
    let outcome: DbRejectable<(Vec<RegistryRow>, Vec<PolicyRow>)> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if active_workspace_role(conn, workspace_id, member_id)
                    .await?
                    .is_none()
                {
                    return Ok(Err(ApiError::not_found(NOT_FOUND)));
                }
                let rows = registry_rows(conn, workspace_id, None).await?;
                let policy = policy_rows(conn, workspace_id, member_id).await?;
                Ok(Ok((rows, policy)))
            })
        })
        .await;
    let (rows, policy) = settle_db("plugins.list", outcome)?;
    let hosted_origin = hosted_origin(&state, &headers);
    Ok(Json(catalog_response(
        &rows,
        &policy,
        hosted_origin.as_deref(),
    )))
}

/// `GET /v1/workspaces/{ws}/plugins/{plugin}`
pub async fn detail(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, plugin)): Path<(String, String)>,
) -> Result<Json<PluginDetailResponse>, ApiError> {
    require_human(&principal, "human delegated user required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let plugin_id = plugin.to_ascii_lowercase();
    if !is_plugin_id(&plugin_id) {
        return Err(ApiError::bad_request("invalid plugin id"));
    }
    let member_id = principal.member_id;
    let outcome: DbRejectable<Option<RegistryRow>> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if active_workspace_role(conn, workspace_id, member_id)
                    .await?
                    .is_none()
                {
                    return Ok(Err(ApiError::not_found(NOT_FOUND)));
                }
                let mut rows = registry_rows(conn, workspace_id, Some(&plugin_id)).await?;
                Ok(Ok(rows.pop()))
            })
        })
        .await;
    let Some(row) = settle_db("plugins.detail", outcome)? else {
        return Err(ApiError::not_found(NOT_FOUND));
    };
    let manifest = row.admit().map_err(|error| {
        ApiError::new(
            StatusCode::CONFLICT,
            format!("plugin manifest rejected: {error}"),
        )
    })?;
    Ok(Json(PluginDetailResponse {
        plugin: detail_dto(&row, manifest),
    }))
}

/// `POST /v1/workspaces/{ws}/plugins/{plugin}/install` — 201 the first time, 200
/// for an existing row (updated, re-enabled, restored).
pub async fn install(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, plugin)): Path<(String, String)>,
    body: Bytes,
) -> Result<Response, ApiError> {
    require_human(&principal, "human delegated user required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let plugin_id = plugin_path_id(&plugin)?;
    let request = decode_install_body(&body)?;
    let actor = actor_of(&principal);
    let provenance = Provenance::default();
    let outcome: DbRejectable<Mutation> = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            plugin_writes::install(
                conn,
                workspace_id,
                &plugin_id,
                request.enabled,
                actor,
                &provenance,
            )
            .await
        })
    })
    .await;
    Ok(mutation_response(settle_db("plugins.install", outcome)?))
}

/// `DELETE /v1/workspaces/{ws}/plugins/{plugin}/install` — owner/admin. The app's
/// install, every member's grant of it and every capability projection go.
pub async fn uninstall(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, plugin)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    require_human(&principal, "human delegated user required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let plugin_id = plugin_path_id(&plugin)?;
    let actor = actor_of(&principal);
    let provenance = Provenance::default();
    let outcome: DbRejectable<Mutation> = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            plugin_writes::uninstall(conn, workspace_id, &plugin_id, actor, &provenance).await
        })
    })
    .await;
    Ok(mutation_response(settle_db("plugins.uninstall", outcome)?))
}

/// `POST /v1/workspaces/{ws}/plugins/{plugin}/grants` — the caller grants
/// themselves one scope the app declares. 201 new, 200 refreshed or restored.
pub async fn grant(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, plugin)): Path<(String, String)>,
    body: Bytes,
) -> Result<Response, ApiError> {
    require_human(&principal, "human delegated user required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let plugin_id = plugin_path_id(&plugin)?;
    let request = decode_grant_body(&body)?;
    let scope = scope_of(&request.scope)?;
    let actor = actor_of(&principal);
    let provenance = Provenance::default();
    let outcome: DbRejectable<Mutation> = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            plugin_writes::grant(conn, workspace_id, &plugin_id, &scope, actor, &provenance).await
        })
    })
    .await;
    Ok(mutation_response(settle_db("plugins.grant", outcome)?))
}

/// `DELETE /v1/workspaces/{ws}/plugins/{plugin}/grants/{scope}` — the caller's
/// own grant only. Nobody else's is addressable from here.
pub async fn revoke_grant(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, plugin, scope)): Path<(String, String, String)>,
) -> Result<Response, ApiError> {
    require_human(&principal, "human delegated user required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let plugin_id = plugin_path_id(&plugin)?;
    let scope = scope_of(&scope)?;
    let actor = actor_of(&principal);
    let provenance = Provenance::default();
    let outcome: DbRejectable<Mutation> = agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            plugin_writes::revoke_grant(conn, workspace_id, &plugin_id, &scope, actor, &provenance)
                .await
        })
    })
    .await;
    Ok(mutation_response(settle_db(
        "plugins.revoke_grant",
        outcome,
    )?))
}

// ---- write-side translation (pure) -----------------------------------------

fn actor_of(principal: &Principal) -> Actor {
    Actor {
        member_id: principal.member_id,
        via_token_id: audit_via_token_id(principal),
    }
}

/// Swift `pluginID`: lowercased, held to the registry id grammar.
fn plugin_path_id(raw: &str) -> Result<String, ApiError> {
    let id = raw.to_ascii_lowercase();
    if is_plugin_id(&id) {
        Ok(id)
    } else {
        Err(ApiError::bad_request("invalid plugin id"))
    }
}

/// Swift `normalizedScope`: trimmed, lowercased, held to the column grammar.
fn scope_of(raw: &str) -> Result<String, ApiError> {
    plugin_writes::normalize_scope(raw).ok_or_else(|| ApiError::bad_request("invalid plugin scope"))
}

/// An absent body is `{}` for install (every key is optional there); any other
/// body is exactly the documented object.
fn decode_install_body(body: &Bytes) -> Result<InstallPluginRequest, ApiError> {
    if body.iter().all(|byte| byte.is_ascii_whitespace()) {
        return Ok(InstallPluginRequest { enabled: None });
    }
    serde_json::from_slice(body).map_err(|_| ApiError::bad_request(INVALID_BODY))
}

fn decode_grant_body(body: &Bytes) -> Result<GrantPluginRequest, ApiError> {
    serde_json::from_slice(body).map_err(|_| ApiError::bad_request(INVALID_BODY))
}

fn mutation_dto(mutation: Mutation) -> PluginMutationDto {
    PluginMutationDto {
        plugin_id: mutation.plugin_id,
        member_id: mutation.member_id.map(|id| id.to_string()),
        scope: mutation.scope,
        status: mutation.status.to_string(),
        enabled: mutation.enabled,
        audit_ref: mutation.audit_ref.map(|id| id.to_string()),
        capabilities: mutation.capabilities,
        egress_domains: mutation.egress_domains,
    }
}

fn mutation_response(mutation: Mutation) -> Response {
    let status = if mutation.created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    (status, Json(mutation_dto(mutation))).into_response()
}

// ---- SQL -------------------------------------------------------------------

pub(crate) async fn registry_rows(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    plugin_id: Option<&str>,
) -> Result<Vec<RegistryRow>, momo_db::DbError> {
    let allowlist: Vec<String> = OFFICIAL_PLUGIN_IDS
        .iter()
        .map(|id| id.to_string())
        .collect();
    let rows = sqlx::query(REGISTRY_SQL)
        .bind(workspace_id)
        .bind(&allowlist)
        .bind(plugin_id)
        .fetch_all(&mut *conn)
        .await?;
    rows.into_iter()
        .map(|row| {
            Ok(RegistryRow {
                plugin_id: row.try_get("plugin_id")?,
                manifest_text: row.try_get("manifest_text")?,
                expected_digest: row.try_get("manifest_digest")?,
                computed_digest: row.try_get("computed_digest")?,
                official: row.try_get("official")?,
                installed: row.try_get("installed")?,
                enabled: row.try_get("enabled")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(Into::into)
}

async fn policy_rows(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<Vec<PolicyRow>, momo_db::DbError> {
    let rows = sqlx::query(POLICY_SQL)
        .bind(workspace_id)
        .bind(member_id)
        .fetch_all(&mut *conn)
        .await?;
    rows.into_iter()
        .map(|row| {
            Ok(PolicyRow {
                plugin_id: row.try_get("plugin_id")?,
                tool_name: row.try_get("tool_name")?,
                risk: row.try_get("risk")?,
                approval_tier: row.try_get("approval_tier")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(Into::into)
}

// ---- projection (pure) -----------------------------------------------------

/// The origin a hosted manifest's relative MCP path resolves against: the
/// configured public base URL, else the same Host/XFP derivation the realtime
/// advert and the invite link use. `None` drops hosted descriptors (fail closed)
/// instead of answering 500 as Swift did.
fn hosted_origin(state: &AppState, headers: &HeaderMap) -> Option<String> {
    if let Some(configured) = state.t3.ready_public_base_url() {
        return Some(configured);
    }
    let forwarded_proto = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok());
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    derive_same_origin_http_base(forwarded_proto, host, None).ok()
}

fn catalog_item(row: &RegistryRow, manifest: &ValidatedPluginManifest) -> PluginCatalogItemDto {
    PluginCatalogItemDto {
        plugin_id: manifest.plugin_id.clone(),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        description: manifest.description.clone(),
        publisher_name: manifest.publisher_name.clone(),
        terms_url: manifest.terms_url.clone(),
        privacy_policy_url: manifest.privacy_policy_url.clone(),
        icon_text: manifest.icon_text.clone(),
        logo_key: manifest.logo_key.clone(),
        category: manifest.category.clone(),
        starter_prompts: starter_prompt_dtos(manifest),
        website_url: manifest.website_url.clone(),
        official: row.official,
        recommended: ONBOARDING_RECOMMENDED.contains(&manifest.plugin_id.as_str()),
        egress_domains: manifest.egress_domains.clone(),
        recommended_for: manifest.recommended_for.clone(),
        installed: row.installed,
        enabled: row.installed && row.enabled,
    }
}

fn catalog_response(
    rows: &[RegistryRow],
    policy: &[PolicyRow],
    hosted_origin: Option<&str>,
) -> PluginCatalogResponse {
    let mut admitted: BTreeMap<String, ValidatedPluginManifest> = BTreeMap::new();
    let mut plugins = Vec::with_capacity(rows.len());
    for row in rows {
        match row.admit() {
            Ok(manifest) => {
                plugins.push(catalog_item(row, &manifest));
                admitted.insert(manifest.plugin_id.clone(), manifest);
            }
            Err(error) => {
                tracing::warn!(
                    plugin_id = %row.plugin_id,
                    reason = %error,
                    "plugin manifest rejected; omitted from catalog"
                );
            }
        }
    }

    let mut tools_by_plugin: BTreeMap<&str, Vec<PluginPolicyToolDto>> = BTreeMap::new();
    for row in policy {
        // A projection for a plugin that is not shown (not admitted, not one of
        // the four) is not this caller's policy here either.
        if !admitted.contains_key(&row.plugin_id) {
            continue;
        }
        tools_by_plugin
            .entry(row.plugin_id.as_str())
            .or_default()
            .push(PluginPolicyToolDto {
                name: row.tool_name.clone(),
                risk: row.risk.clone(),
                approval_tier: row.approval_tier.clone(),
            });
    }
    let descriptors = tools_by_plugin
        .into_iter()
        .filter_map(|(plugin_id, tools)| {
            let manifest = admitted.get(plugin_id)?;
            let url = if manifest.hosted {
                format!("{}{}", hosted_origin?, manifest.mcp_url)
            } else {
                manifest.mcp_url.clone()
            };
            Some(PluginPolicyDescriptorDto {
                plugin_id: plugin_id.to_string(),
                mcp: PluginPolicyMcpDto {
                    url,
                    transport: manifest.mcp_transport.clone(),
                },
                egress_domains: manifest.egress_domains.clone(),
                tools,
            })
        })
        .collect();

    PluginCatalogResponse {
        plugins,
        tool_policy: PluginToolPolicyDto {
            plugins: descriptors,
        },
    }
}

fn detail_dto(row: &RegistryRow, manifest: ValidatedPluginManifest) -> PluginDetailDto {
    let starter_prompts = starter_prompt_dtos(&manifest);
    PluginDetailDto {
        plugin_id: manifest.plugin_id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        publisher_name: manifest.publisher_name,
        terms_url: manifest.terms_url,
        privacy_policy_url: manifest.privacy_policy_url,
        icon_text: manifest.icon_text,
        logo_key: manifest.logo_key,
        category: manifest.category,
        starter_prompts,
        website_url: manifest.website_url,
        official: row.official,
        egress_domains: manifest.egress_domains,
        recommended_for: manifest.recommended_for,
        installed: row.installed,
        enabled: row.installed && row.enabled,
        manifest: manifest.json,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GITHUB: &str =
        include_str!("../../../../../server/Fixtures/plugin-manifests/github.json");
    const DRIVE: &str = include_str!("../../../../../server/Fixtures/plugin-manifests/drive.json");
    const DIGEST: &str = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

    fn row(plugin_id: &str, manifest: &str, installed: bool, enabled: bool) -> RegistryRow {
        RegistryRow {
            plugin_id: plugin_id.to_string(),
            manifest_text: manifest.to_string(),
            expected_digest: DIGEST.to_string(),
            computed_digest: DIGEST.to_string(),
            official: true,
            installed,
            enabled,
        }
    }

    fn policy(plugin_id: &str, tool: &str) -> PolicyRow {
        PolicyRow {
            plugin_id: plugin_id.to_string(),
            tool_name: tool.to_string(),
            risk: "read".to_string(),
            approval_tier: "read_only".to_string(),
        }
    }

    #[test]
    fn a_tampered_row_is_omitted_and_its_policy_with_it() {
        let mut tampered = row("com.momo.plugins.github", GITHUB, true, true);
        tampered.computed_digest =
            "sha256:1111111111111111111111111111111111111111111111111111111111111111".to_string();
        let response = catalog_response(
            &[tampered, row("com.momo.plugins.drive", DRIVE, false, false)],
            &[policy("com.momo.plugins.github", "github.get_commit")],
            Some("https://oort.example"),
        );
        let ids: Vec<&str> = response
            .plugins
            .iter()
            .map(|p| p.plugin_id.as_str())
            .collect();
        assert_eq!(ids, ["com.momo.plugins.drive"]);
        assert!(response.tool_policy.plugins.is_empty());
    }

    #[test]
    fn enabled_is_never_true_without_an_install() {
        let response = catalog_response(
            &[row("com.momo.plugins.github", GITHUB, false, true)],
            &[],
            None,
        );
        assert!(!response.plugins[0].installed);
        assert!(!response.plugins[0].enabled);
        assert!(response.plugins[0].recommended);
    }

    #[test]
    fn a_hosted_descriptor_resolves_against_the_origin_or_is_dropped() {
        let rows = [row("com.momo.plugins.drive", DRIVE, true, true)];
        let tools = [policy("com.momo.plugins.drive", "drive.search_files")];
        let resolved = catalog_response(&rows, &tools, Some("https://oort.example"));
        assert_eq!(
            resolved.tool_policy.plugins[0].mcp.url,
            "https://oort.example/v1/mcp/drive"
        );
        let dropped = catalog_response(&rows, &tools, None);
        assert!(dropped.tool_policy.plugins.is_empty());
        assert_eq!(dropped.plugins.len(), 1, "the catalog row itself stays");
    }

    fn mutation(created: bool) -> Mutation {
        Mutation {
            plugin_id: "com.momo.plugins.github".to_string(),
            member_id: Some(Uuid::from_u128(7)),
            scope: Some("github:read".to_string()),
            status: "active",
            enabled: true,
            audit_ref: Some(Uuid::from_u128(9)),
            capabilities: vec!["github.get_commit".to_string()],
            egress_domains: Some(vec!["api.githubcopilot.com".to_string()]),
            created,
        }
    }

    /// The deployed parser's required keys are all there, the optional ones are
    /// omitted rather than null, and no key on the wire is credential-shaped.
    #[test]
    fn a_mutation_answers_the_shape_the_core_parser_reads() {
        let wire = serde_json::to_value(mutation_dto(mutation(true))).expect("serialise");
        let object = wire.as_object().expect("object");
        for required in ["pluginId", "status", "enabled", "capabilities"] {
            assert!(object.contains_key(required), "{required}");
        }
        assert_eq!(wire["memberId"], "00000000-0000-0000-0000-000000000007");
        assert_eq!(wire["egressDomains"][0], "api.githubcopilot.com");

        let mut bare = mutation(false);
        bare.member_id = None;
        bare.scope = None;
        bare.audit_ref = None;
        bare.egress_domains = None;
        let wire = serde_json::to_value(mutation_dto(bare)).expect("serialise");
        let mut keys: Vec<&str> = wire
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, ["capabilities", "enabled", "pluginId", "status"]);
        for key in keys {
            assert!(!crate::plugin_manifest::is_secret_like_key(key), "{key}");
        }
    }

    #[test]
    fn created_is_201_and_everything_else_is_200() {
        assert_eq!(
            mutation_response(mutation(true)).status(),
            StatusCode::CREATED
        );
        assert_eq!(mutation_response(mutation(false)).status(), StatusCode::OK);
    }

    /// A body is exactly the documented object. A credential-shaped or any other
    /// unknown key is refused, and the refusal quotes neither the key nor the
    /// value that was sent.
    #[test]
    fn a_body_with_any_other_key_is_refused_without_echoing_it() {
        let marker = "sk-live-must-not-echo";
        for body in [
            format!(r#"{{"scope":"github:read","accessToken":"{marker}"}}"#),
            format!(r#"{{"scope":"github:read","memberId":"{marker}"}}"#),
            format!(r#"{{"scope":"github:read","authorization":"{marker}"}}"#),
        ] {
            let error = decode_grant_body(&Bytes::from(body)).expect_err("unknown key");
            assert_eq!(error.status, StatusCode::BAD_REQUEST);
            assert!(!error.message.contains(marker) && !error.message.contains("accessToken"));
        }
        let error = decode_install_body(&Bytes::from(format!(
            r#"{{"enabled":true,"access_token":"{marker}"}}"#
        )))
        .expect_err("unknown key");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        assert!(!error.message.contains(marker));
    }

    #[test]
    fn install_takes_an_absent_body_or_the_one_documented_key() {
        for empty in ["", "  \n"] {
            let request = decode_install_body(&Bytes::from(empty)).expect("empty is {}");
            assert_eq!(request.enabled, None);
        }
        let request =
            decode_install_body(&Bytes::from_static(br#"{"enabled":false}"#)).expect("enabled");
        assert_eq!(request.enabled, Some(false));
        let request = decode_install_body(&Bytes::from_static(b"{}")).expect("{}");
        assert_eq!(request.enabled, None);
        for bad in ["null", "[]", "true", r#"{"enabled":"yes"}"#, "{"] {
            assert!(decode_install_body(&Bytes::from(bad)).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_grant_needs_a_string_scope_and_a_scope_is_normalised() {
        assert!(
            decode_grant_body(&Bytes::new()).is_err(),
            "grant has no empty body"
        );
        for bad in [
            "{}",
            r#"{"scope":null}"#,
            r#"{"scope":1}"#,
            r#"{"scope":["a"]}"#,
        ] {
            assert!(decode_grant_body(&Bytes::from(bad)).is_err(), "{bad}");
        }
        assert_eq!(
            scope_of(" GitHub:Read ").expect("normalised"),
            "github:read"
        );
        assert_eq!(
            scope_of("not a scope").expect_err("grammar").status,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            plugin_path_id("Com.Momo.Plugins.GitHub").expect("lowercased"),
            "com.momo.plugins.github"
        );
        assert_eq!(
            plugin_path_id("Bad Id!").expect_err("grammar").status,
            StatusCode::BAD_REQUEST
        );
    }

    /// `require_human` is each handler's own gate. The middleware keeps agent
    /// bearers off these paths today, but a principal that reached a handler anyway
    /// is refused with 403 before any path, body or database work. The pool below
    /// never dials and each request is otherwise well-formed, so without the guard
    /// it would reach `agent_tenant_tx` and come back a 500.
    #[tokio::test]
    async fn an_agent_principal_is_refused_by_all_four_handlers_before_any_database_work() {
        use momo_auth::PrincipalKind;

        let pool = momo_db::sqlx::postgres::PgPoolOptions::new()
            .acquire_timeout(std::time::Duration::from_millis(300))
            .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
            .expect("a lazy pool never dials");
        let state = AppState::new(
            pool,
            "test-secret".to_string(),
            "ws://127.0.0.1:8000/connection/websocket".to_string(),
        );
        let workspace = Uuid::from_u128(1);
        let agent = Principal {
            member_id: Uuid::from_u128(2),
            workspace_id: workspace,
            token_id: None,
            scopes: Vec::new(),
            kind: PrincipalKind::Agent,
        };
        let ws = workspace.to_string();
        let plugin = "com.momo.plugins.github".to_string();
        let refusals = [
            install(
                State(state.clone()),
                Extension(agent.clone()),
                Path((ws.clone(), plugin.clone())),
                Bytes::from_static(br#"{"enabled":true}"#),
            )
            .await,
            uninstall(
                State(state.clone()),
                Extension(agent.clone()),
                Path((ws.clone(), plugin.clone())),
            )
            .await,
            grant(
                State(state.clone()),
                Extension(agent.clone()),
                Path((ws.clone(), plugin.clone())),
                Bytes::from_static(br#"{"scope":"github:read"}"#),
            )
            .await,
            revoke_grant(
                State(state.clone()),
                Extension(agent.clone()),
                Path((ws.clone(), plugin.clone(), "github:read".to_string())),
            )
            .await,
        ];
        for refusal in refusals {
            let error = refusal.expect_err("an agent principal is refused");
            assert_eq!(error.status, StatusCode::FORBIDDEN, "{}", error.message);
            assert_eq!(error.message, "human delegated user required");
        }
    }

    #[test]
    fn the_allowlist_is_the_seven_official_plugins() {
        assert_eq!(OFFICIAL_PLUGIN_IDS.len(), 7);
        assert!(OFFICIAL_PLUGIN_IDS.iter().all(|id| is_plugin_id(id)));
    }

    /// ADR-0113 증보 3 F1: the list and the detail both carry the display fields, camelCase, with the
    /// two URL-ish keys spelled `websiteURL` (like `termsURL`), and the developer column is the manifest's
    /// own `publisher.name` — one source, so the card and the manifest cannot disagree.
    #[test]
    fn the_catalog_and_the_detail_carry_the_display_fields() {
        let github = row("com.momo.plugins.github", GITHUB, true, true);
        let response = catalog_response(std::slice::from_ref(&github), &[], None);
        let item = serde_json::to_value(&response.plugins[0]).expect("serialise item");
        let detail = serde_json::to_value(detail_dto(&github, github.admit().expect("admitted")))
            .expect("serialise detail");
        for (label, wire) in [("list", &item), ("detail", &detail)] {
            assert_eq!(wire["publisherName"], "GitHub", "{label}");
            assert_eq!(wire["logoKey"], "github", "{label}");
            assert_eq!(wire["category"], "developer", "{label}");
            assert_eq!(wire["websiteURL"], "https://github.com", "{label}");
            let prompts = wire["starterPrompts"].as_array().expect("starterPrompts");
            assert_eq!(prompts.len(), 3, "{label}");
            for prompt in prompts {
                let keys: Vec<&str> = prompt
                    .as_object()
                    .expect("prompt object")
                    .keys()
                    .map(String::as_str)
                    .collect();
                assert_eq!(keys, ["text", "tool"], "{label}");
            }
            // No remote image key ever leaves the server, and nothing is credential-shaped.
            for key in wire.as_object().expect("object").keys() {
                assert!(
                    !crate::plugin_manifest::is_secret_like_key(key),
                    "{label}: {key}"
                );
                assert!(
                    !["iconURL", "logoURL", "imageURL"].contains(&key.as_str()),
                    "{label}: {key}"
                );
            }
        }
        // The detail still echoes the manifest verbatim, display fields included.
        assert_eq!(detail["manifest"]["plugin"]["logoKey"], "github");
    }

    /// Additive and old-client-harmless: a manifest that declares none of the four display fields
    /// serialises **without** the keys (never `null`, never `[]`), while the developer name — always
    /// present in a manifest — is always on the wire.
    #[test]
    fn an_app_without_display_fields_omits_the_keys_and_keeps_the_developer() {
        let mut manifest: Value = serde_json::from_str(GITHUB).expect("fixture");
        for key in ["logoKey", "category", "websiteURL", "starterPrompts"] {
            manifest["plugin"]
                .as_object_mut()
                .expect("plugin")
                .remove(key);
        }
        let bare = row("com.momo.plugins.github", &manifest.to_string(), true, true);
        let response = catalog_response(std::slice::from_ref(&bare), &[], None);
        let item = serde_json::to_value(&response.plugins[0]).expect("serialise item");
        let detail = serde_json::to_value(detail_dto(&bare, bare.admit().expect("admitted")))
            .expect("serialise detail");
        for (label, wire) in [("list", &item), ("detail", &detail)] {
            let object = wire.as_object().expect("object");
            for key in ["logoKey", "category", "websiteURL", "starterPrompts"] {
                assert!(!object.contains_key(key), "{label}: {key} must be omitted");
            }
            assert_eq!(wire["publisherName"], "GitHub", "{label}");
        }
    }
}
