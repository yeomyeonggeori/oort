//! ADR-0113 증보 2026-10-15 (#3838) P-S1 — the plugin registry's two reads,
//! for the four official plugins only.
//!
//! ```text
//! GET /v1/workspaces/{ws}/plugins            catalog + the caller's own policy
//! GET /v1/workspaces/{ws}/plugins/{plugin}   one manifest
//! ```
//!
//! 결재 원문(2026-10-15, 성재): 「이월 풀고 읽기부터 (추천)」.
//!
//! * **Wire = the deployed core parser.** `packages/momo-core/src/lib/api.ts`
//!   `pluginCatalogFromWire` / `pluginDetailFromWire` already parse the Swift
//!   `PluginRoutes` shape (deleted in #2165); this module answers exactly that
//!   shape, and `tests/plugin_registry_read_conformance_pg.rs` pins the bytes to
//!   `server/Fixtures/plugin-wire/*.json`, which the web suite feeds through the
//!   same parser.
//! * **Four official plugins, three guards.** A row is shown only when it is
//!   `official`, not revoked, **and** one of [`OFFICIAL_PLUGIN_IDS`]. Anything
//!   else is the same 404 as an id that does not exist.
//! * **Admission.** Every row passes [`crate::plugin_manifest`] (digest, exact
//!   key sets, allowlisted vocabularies, no credential-shaped key) and its
//!   registry id must equal the manifest id. The catalog omits a row that
//!   fails; the detail answers 409, as Swift did.
//! * **No credential, no write.** `plugin_registry` holds policy metadata only
//!   (013, ADR-0113 D1 custody A) and `momo_app` cannot write it (037). These
//!   handlers write nothing; install / grant (ADR-0113 P3) stay 404.
//! * **Human bearer, active member.** Tenant rows (`workspace_plugin_install`,
//!   `plugin_grant`, `plugin_capability_projection`) are read inside
//!   `with_tenant_tx` under RLS FORCE. A caller who is not an active member gets
//!   the same 404 as an unknown plugin (ADR-0113 P-S1 ④).

use std::collections::BTreeMap;

use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::{Extension, Json};
use momo_auth::workspace_authorization::active_workspace_role;
use momo_auth::Principal;
use momo_db::sqlx::{self, Row};
use momo_db::PgConnection;
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

use crate::error::ApiError;
use crate::plugin_manifest::{is_plugin_id, validate_registry_manifest, ValidatedPluginManifest};
use crate::realtime_advert::derive_same_origin_http_base;
use crate::routes::shared::{
    agent_tenant_tx, require_human, settle_db, workspace_scope, DbRejectable,
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
struct RegistryRow {
    plugin_id: String,
    manifest_text: String,
    expected_digest: String,
    computed_digest: String,
    official: bool,
    installed: bool,
    enabled: bool,
}

impl RegistryRow {
    fn admit(&self) -> Result<ValidatedPluginManifest, crate::plugin_manifest::ManifestRejected> {
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

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginCatalogItemDto {
    pub plugin_id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    #[serde(rename = "termsURL", skip_serializing_if = "Option::is_none")]
    pub terms_url: Option<String>,
    #[serde(rename = "privacyPolicyURL", skip_serializing_if = "Option::is_none")]
    pub privacy_policy_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_text: Option<String>,
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
    #[serde(rename = "termsURL", skip_serializing_if = "Option::is_none")]
    pub terms_url: Option<String>,
    #[serde(rename = "privacyPolicyURL", skip_serializing_if = "Option::is_none")]
    pub privacy_policy_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_text: Option<String>,
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
    let plugin_id = plugin.to_lowercase();
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

// ---- SQL -------------------------------------------------------------------

async fn registry_rows(
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
        terms_url: manifest.terms_url.clone(),
        privacy_policy_url: manifest.privacy_policy_url.clone(),
        icon_text: manifest.icon_text.clone(),
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
    PluginDetailDto {
        plugin_id: manifest.plugin_id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        terms_url: manifest.terms_url,
        privacy_policy_url: manifest.privacy_policy_url,
        icon_text: manifest.icon_text,
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
            &[policy(
                "com.momo.plugins.github",
                "github.list_repositories",
            )],
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

    #[test]
    fn the_allowlist_is_the_four_official_plugins() {
        assert_eq!(OFFICIAL_PLUGIN_IDS.len(), 4);
        assert!(OFFICIAL_PLUGIN_IDS.iter().all(|id| is_plugin_id(id)));
    }
}
