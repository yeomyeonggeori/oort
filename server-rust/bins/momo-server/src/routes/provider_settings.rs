//! The provider-scoped settings surfaces that are not the AI 연결 link
//! (B4.2, diff-matrix D-3).
//!
//! `GET|PUT /v1/provider/work-host-engine` (워크스페이스 단위 실행 엔진) was
//! removed by #3584 — ADR-0198 D1·D4: 하네스는 워크스페이스 설정이 아니라 내 도구다.
//!
//! ```text
//! GET     /v1/provider/effort-table        추론 강도 어휘 (ADR-0134 D2)
//! GET     /v1/provider/quota-snapshots     구독 잔여량 (ADR-0135 D2)
//! ```
//!
//! Three different authorization models sit side by side here, and the
//! differences are the point rather than an inconsistency:
//!
//! | surface | who | why |
//! |---|---|---|
//! | effort-table | any authenticated principal | a compiled constant with no tenant row, no credential, and no side effect — and the composer needs it before a run exists |
//! | quota-snapshots | any **active** workspace member | instance-global telemetry with no secret in it, same convention as `usage/summary` — but a removed member must not keep reading the operator's provider state |

use axum::extract::State;
use axum::{Extension, Json};
use chrono::{SecondsFormat, Utc};
use momo_auth::{active_workspace_role, Principal};
use momo_settings::list_quota_snapshots;

use crate::dto::{
    ProviderEffortFallbackDto, ProviderEffortModelDto, ProviderEffortProviderDto,
    ProviderEffortTableResponse, ProviderQuotaSnapshotDto, ProviderQuotaSnapshotListResponse,
};
use crate::error::ApiError;
use crate::routes::shared::{agent_tenant_tx, settle_db, DbRejectable};
use crate::AppState;

const EFFORT_TABLE_SCHEMA: &str = "momo.provider.effort_table.v0";
const QUOTA_SCHEMA: &str = "momo.provider_quota_snapshots.v0";

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

    /// SRV-B3: the measured upstream catalog reaches the wire as its own
    /// provider group, and the two levels 성재 could not select are on it.
    ///
    /// This asserts the *serialized* shape rather than the constant, because the
    /// composer's 강도 상자 is built from this JSON: a projection that dropped
    /// `xhigh`/`max` would leave the picker at 낮음/보통/높음 no matter what the
    /// table said.
    #[test]
    fn the_measured_catalog_reaches_the_wire_with_xhigh_and_max() {
        let table = serde_json::to_value(effort_table_response()).expect("serialize");
        let codex = table["providers"]
            .as_array()
            .expect("providers")
            .iter()
            .find(|group| group["provider"] == "openai-codex")
            .expect("the measured catalog is served");
        let luna = codex["models"]
            .as_array()
            .expect("models")
            .iter()
            .find(|model| model["model"] == "gpt-5.6-luna")
            .expect("gpt-5.6-luna is on the wire");
        assert_eq!(
            luna["efforts"],
            serde_json::json!(["low", "medium", "high", "xhigh", "max"])
        );
        assert_eq!(luna["defaultEffort"], "medium");

        let sol = codex["models"]
            .as_array()
            .expect("models")
            .iter()
            .find(|model| model["model"] == "gpt-5.6-sol")
            .expect("gpt-5.6-sol");
        assert!(
            sol["efforts"]
                .as_array()
                .expect("efforts")
                .iter()
                .all(|level| level != "ultra"),
            "momo does not serve the upstream's sixth level: {sol}"
        );
    }
}
