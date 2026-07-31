//! The three provider-scoped settings surfaces that are not the AI 연결 link
//! (B4.2, diff-matrix D-3).
//!
//! ```text
//! GET|PUT /v1/provider/work-host-engine    코드 실행 호스트
//! GET     /v1/provider/effort-table        추론 강도 어휘 (ADR-0134 D2)
//! GET     /v1/provider/quota-snapshots     구독 잔여량 (ADR-0135 D2)
//! ```
//!
//! Three different authorization models sit side by side here, and the
//! differences are the point rather than an inconsistency:
//!
//! | surface | who | why |
//! |---|---|---|
//! | work-host-engine | workspace owner/admin (or `platform:read`) | the row is RLS-scoped to one tenant, so its blast radius is that tenant |
//! | effort-table | any authenticated principal | a compiled constant with no tenant row, no credential, and no side effect — and the composer needs it before a run exists |
//! | quota-snapshots | any **active** workspace member | instance-global telemetry with no secret in it, same convention as `usage/summary` — but a removed member must not keep reading the operator's provider state |

use axum::extract::State;
use axum::{Extension, Json};
use chrono::{SecondsFormat, Utc};
use momo_auth::{active_workspace_role, Principal};
use momo_db::audit::{write_audit, AuditEntry};
use momo_settings::{
    list_quota_snapshots, read_work_host_engine, upsert_work_host_engine, validated_engine,
    ALLOWED_ENGINES, DEFAULT_ENGINE,
};

use crate::dto::{
    ProviderEffortFallbackDto, ProviderEffortModelDto, ProviderEffortProviderDto,
    ProviderEffortTableResponse, ProviderQuotaSnapshotDto, ProviderQuotaSnapshotListResponse,
    PutWorkHostEngineRequest, WorkHostEngineResponse,
};
use crate::error::ApiError;
use crate::routes::shared::{
    agent_tenant_tx, audit_via_token_id, require_workspace_operator, settle_db, DbRejectable,
};
use crate::AppState;

const ENGINE_SCHEMA: &str = "momo.work_host_engine.v0";
const EFFORT_TABLE_SCHEMA: &str = "momo.provider.effort_table.v0";
const QUOTA_SCHEMA: &str = "momo.provider_quota_snapshots.v0";

// ---------------------------------------------------------------------------
// work host engine
// ---------------------------------------------------------------------------

/// A `None` row means the workspace never selected an engine, so the effective
/// engine is the boot default reported with `source: "default"` **and no write**
/// (Swift `makeResponse` :89-106). Writing a row on read would turn a question
/// into a decision.
fn engine_response(stored: Option<momo_settings::StoredWorkHostEngine>) -> WorkHostEngineResponse {
    match stored {
        Some(row) => WorkHostEngineResponse {
            engine: row.engine,
            source: "database",
            updated_by: row.updated_by_member_id.map(|id| id.to_string()),
            updated_at_ms: Some(row.updated_at_ms),
            schema: ENGINE_SCHEMA,
        },
        None => WorkHostEngineResponse {
            engine: DEFAULT_ENGINE.to_string(),
            source: "default",
            updated_by: None,
            updated_at_ms: None,
            schema: ENGINE_SCHEMA,
        },
    }
}

pub async fn get_work_host_engine(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<WorkHostEngineResponse>, ApiError> {
    let workspace_id = principal.workspace_id;
    require_workspace_operator(&state, &principal, workspace_id).await?;

    let stored = settle_db(
        "work_host_engine.get",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move { Ok(Ok(read_work_host_engine(conn, workspace_id).await?)) })
        })
        .await,
    )?;
    Ok(Json(engine_response(stored)))
}

pub async fn put_work_host_engine(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<PutWorkHostEngineRequest>,
) -> Result<Json<WorkHostEngineResponse>, ApiError> {
    let workspace_id = principal.workspace_id;
    require_workspace_operator(&state, &principal, workspace_id).await?;

    // Validate against migration 040's CHECK set here, so an unknown label is a
    // 400 and never a 500 surfaced from the constraint.
    let engine = validated_engine(&request.engine).ok_or_else(|| {
        ApiError::bad_request(format!(
            "engine must be one of {}",
            ALLOWED_ENGINES.join(", ")
        ))
    })?;

    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);
    let stored = settle_db(
        "work_host_engine.put",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let saved = upsert_work_host_engine(conn, workspace_id, engine, member_id).await?;
                write_audit(
                    conn,
                    &AuditEntry::new(workspace_id, "work_host_engine.updated")
                        .by(member_id)
                        .via_token(via_token)
                        .with_schema(
                            "momo.work_host_engine.audit.v0",
                            // Only the label. There is nothing else on this row
                            // that could leak (ADR-0004).
                            serde_json::json!({"engine": engine}),
                        ),
                )
                .await?;
                Ok(Ok(saved))
            })
        })
        .await,
    )?;
    Ok(Json(engine_response(Some(stored))))
}

// ---------------------------------------------------------------------------
// effort table
// ---------------------------------------------------------------------------

/// `GET /v1/provider/effort-table` (Swift `ProviderEffortTableRoutes`).
///
/// The table itself already lives in `momo_agent::effort` — it is the same
/// vocabulary the ledger writer validates against — so this route projects that
/// module rather than restating the rows. A second copy is how the picker and
/// the writer come to disagree about what `xhigh` means.
///
/// **A note the reclassification depends on.** The web client uses this endpoint
/// as its effort-axis capability probe (`features/routing/capability.ts:14-17`):
/// a 404 reads as "this server has no effort axis". Serving it therefore flips
/// that verdict from `absent` to `ready` while `…/agents/{a}/profile` — the
/// axis's *second* tier — is still 404 on this server. Measured consequence:
/// both consumers of the verdict gate on the profile first
/// (`MentionRoutingBar.tsx:148` `profileFailed` leads the reason chain;
/// `AgentProfileDialog` cannot open without the profile), so the composer stays
/// locked with an accurate sentence and no picker is opened over a write that
/// would fail. See the B4.2 entry in `docs/planning/2026-08-01-b4-contract-diff.md`.
pub async fn get_effort_table(
    Extension(_principal): Extension<Principal>,
) -> Json<ProviderEffortTableResponse> {
    Json(effort_table_response())
}

/// The projection, pure so the wire shape is pinned by a unit test.
fn effort_table_response() -> ProviderEffortTableResponse {
    ProviderEffortTableResponse {
        schema: EFFORT_TABLE_SCHEMA,
        levels: momo_agent::effort::EFFORT_LEVELS.to_vec(),
        fallback: ProviderEffortFallbackDto {
            efforts: momo_agent::effort::FALLBACK_EFFORTS.to_vec(),
            default_effort: momo_agent::effort::FALLBACK_DEFAULT_EFFORT,
        },
        providers: momo_agent::effort::providers()
            .into_iter()
            .map(|(provider, models)| ProviderEffortProviderDto {
                provider,
                models: models
                    .iter()
                    .map(|model| ProviderEffortModelDto {
                        model: model.model,
                        efforts: model.efforts.to_vec(),
                        default_effort: model.default_effort,
                    })
                    .collect(),
            })
            .collect(),
    }
}

// ---------------------------------------------------------------------------
// quota snapshots
// ---------------------------------------------------------------------------

/// `GET /v1/provider/quota-snapshots` (Swift `list` :110-139).
///
/// The membership check is not redundant with RLS: migration 043's read policy
/// only requires *some* `app.workspace_id`, which every authenticated request
/// has. What it cannot see is whether the caller is still an active member of
/// that workspace — so the role read is what stops a removed member from
/// continuing to watch the operator's provider state.
pub async fn get_quota_snapshots(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<ProviderQuotaSnapshotListResponse>, ApiError> {
    let workspace_id = principal.workspace_id;
    let member_id = principal.member_id;

    let outcome: DbRejectable<Vec<momo_settings::QuotaSnapshot>> =
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                if active_workspace_role(conn, workspace_id, member_id)
                    .await?
                    .is_none()
                {
                    return Ok(Err(ApiError::forbidden("not a workspace member")));
                }
                Ok(Ok(list_quota_snapshots(conn).await?))
            })
        })
        .await;
    let rows = settle_db("provider_quota.list", outcome)?;

    let now = Utc::now();
    Ok(Json(ProviderQuotaSnapshotListResponse {
        schema: QUOTA_SCHEMA,
        observed_at: iso8601(now),
        snapshots: rows
            .into_iter()
            .map(|row| ProviderQuotaSnapshotDto {
                age_seconds: row.age_seconds(now),
                provider_ref: row.provider_ref,
                window: row.window,
                remaining_ratio: row.remaining_ratio,
                // `string | null` by contract, so this key is EMITTED as null
                // rather than omitted — the client distinguishes "no reset
                // reported" from "this server does not send the field".
                resets_at: row.resets_at.map(iso8601),
                probed_at: iso8601(row.probed_at),
                ingested_at: iso8601(row.ingested_at),
            })
            .collect(),
    }))
}

/// Second-resolution UTC with a `Z` suffix — the same helper `usage.rs` uses,
/// matching Swift's `ISO8601DateFormatter` with `.withInternetDateTime`.
fn iso8601(at: chrono::DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_absent_row_reports_the_boot_default_without_claiming_a_write() {
        let response = engine_response(None);
        assert_eq!(response.engine, "opencode");
        assert_eq!(response.source, "default");
        assert!(response.updated_at_ms.is_none());
        assert!(response.updated_by.is_none());
    }

    #[test]
    fn a_stored_row_is_reported_as_a_database_choice() {
        let response = engine_response(Some(momo_settings::StoredWorkHostEngine {
            engine: "goose".into(),
            updated_by_member_id: Some(uuid::Uuid::from_u128(3)),
            updated_at_ms: 1_700_000_000_123,
        }));
        assert_eq!(response.engine, "goose");
        assert_eq!(response.source, "database");
        assert_eq!(response.updated_at_ms, Some(1_700_000_000_123));
    }

    /// The `resetsAt` key must survive as an explicit `null`; the client tells
    /// "no reset reported" from "this server does not send the field".
    #[test]
    fn a_missing_reset_instant_is_emitted_as_null_not_omitted() {
        let json = serde_json::to_value(ProviderQuotaSnapshotDto {
            provider_ref: "codex".into(),
            window: "short".into(),
            remaining_ratio: 0.42,
            resets_at: None,
            probed_at: "2026-08-01T12:00:00Z".into(),
            ingested_at: "2026-08-01T12:00:01Z".into(),
            age_seconds: 12,
        })
        .expect("serialize");
        assert!(json.get("resetsAt").is_some(), "{json}");
        assert!(json["resetsAt"].is_null());
        assert_eq!(json["remainingRatio"], 0.42);
        assert_eq!(json["ageSeconds"], 12);
    }

    /// The picker's vocabulary and the ledger writer's must be one table.
    #[test]
    fn the_projected_table_is_the_ledger_writers_table() {
        let table = serde_json::to_value(effort_table_response()).expect("serialize");
        assert_eq!(
            table["levels"],
            serde_json::json!(["low", "medium", "high", "xhigh", "max"])
        );
        assert_eq!(table["fallback"]["defaultEffort"], "medium");
        assert_eq!(table["providers"][0]["provider"], "hermes");
        let models = table["providers"][0]["models"]
            .as_array()
            .expect("models")
            .clone();
        assert_eq!(models.len(), 4);
        let fast = models
            .iter()
            .find(|model| model["model"] == "hermes-fast")
            .expect("hermes-fast");
        assert_eq!(fast["efforts"], serde_json::json!(["low", "medium"]));
        assert_eq!(
            fast["defaultEffort"], "low",
            "a model that tops out at medium must not default to medium's parent"
        );
    }
}
