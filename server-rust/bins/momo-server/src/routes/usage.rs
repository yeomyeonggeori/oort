//! Workspace LLM-spend summary — Swift `UsageSummaryRoutes` (MOMO-615) parity.
//!
//! ```text
//! GET /v1/workspaces/{ws}/usage/summary?from=<ISO8601>&to=<ISO8601>&bucket=day|week|month
//! ```
//!
//! B2.2 identified `usage_ledger` as what this route aggregates and deferred the
//! route itself, because the ledger had no writer in Rust: a summary that could
//! only ever report zero is worse than no summary, since it reads as "you spent
//! nothing". B2.6 supplies the writer
//! (`momo_agent::record_run_usage_in_tx`), so the number is now produced and read
//! by the same server.
//!
//! ## Authorization: any active member, deliberately
//!
//! Swift mirrors the roster read here — **any** active workspace member may read
//! the summary, not just an admin ("워크스페이스에서 발생하는 과금은 사용자가 전부
//! 트래킹", :15-18). Spend is something the people generating it are entitled to
//! see; hiding it behind an admin role is how a workspace discovers its bill
//! after the fact.
//!
//! Nothing is written, so no migration is required — the
//! `usage_ledger_ws_time_idx (workspace_id, created_at DESC)` index from
//! `001_init.sql:472` already covers the workspace+time predicate.

use axum::extract::{Path, Query, State};
use axum::{Extension, Json};
use chrono::{SecondsFormat, Utc};
use momo_agent::{budget_state, usage_summary_in_tx, validated_window, UsageWindowError};
use momo_auth::{active_workspace_role, Principal};

use crate::dto::{
    UsageSummaryAgent, UsageSummaryBucket, UsageSummaryBudget, UsageSummaryModel,
    UsageSummaryQuery, UsageSummaryRange, UsageSummaryResponse, UsageSummaryTotals,
};
use crate::error::ApiError;
use crate::routes::shared::{agent_tenant_tx, settle_db, workspace_scope};
use crate::AppState;

/// `GET /v1/workspaces/{ws}/usage/summary`.
pub async fn summary(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Query(query): Query<UsageSummaryQuery>,
) -> Result<Json<UsageSummaryResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    // Validated before the transaction opens: a bad range must not cost a
    // connection, and every one of these is a 400 with the Swift wording.
    let window = validated_window(
        query.from.as_deref(),
        query.to.as_deref(),
        query.bucket.as_deref(),
        Utc::now(),
    )
    .map_err(window_error)?;

    let member_id = principal.member_id;
    let summary = settle_db(
        "usage.summary",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                // The membership check is a read inside the same tenant scope, so
                // a non-member's 403 and RLS's zero rows agree rather than the
                // route inventing an empty-but-successful answer.
                if active_workspace_role(conn, workspace_id, member_id)
                    .await?
                    .is_none()
                {
                    return Ok(Err(ApiError::forbidden("not a workspace member")));
                }
                Ok(Ok(usage_summary_in_tx(conn, workspace_id, window).await?))
            })
        })
        .await,
    )?;

    Ok(Json(UsageSummaryResponse {
        range: UsageSummaryRange {
            from: iso8601(summary.window.from),
            to: iso8601(summary.window.to),
            bucket: summary.window.bucket.as_str().to_string(),
        },
        totals: UsageSummaryTotals {
            cost_micro_usd: summary.totals.cost_micro_usd,
            estimated_micro_usd: summary.totals.estimated_micro_usd,
            prompt_tokens: summary.totals.prompt_tokens,
            completion_tokens: summary.totals.completion_tokens,
        },
        buckets: summary
            .buckets
            .iter()
            .map(|bucket| UsageSummaryBucket {
                start: iso8601(bucket.start),
                cost_micro_usd: bucket.cost_micro_usd,
                prompt_tokens: bucket.prompt_tokens,
                completion_tokens: bucket.completion_tokens,
            })
            .collect(),
        by_model: summary
            .by_model
            .iter()
            .map(|model| UsageSummaryModel {
                model: model.model.clone(),
                cost_micro_usd: model.cost_micro_usd,
                prompt_tokens: model.prompt_tokens,
                completion_tokens: model.completion_tokens,
            })
            .collect(),
        by_agent: summary
            .by_agent
            .iter()
            .map(|agent| UsageSummaryAgent {
                // Swift lowercases the agent id here (:295) while every other DTO
                // uses `uuidString`'s uppercase — kept, because a client keying a
                // map on this string would break on a case change.
                agent_member_id: agent.agent_member_id.to_string().to_lowercase(),
                display_name: agent.display_name.clone(),
                cost_micro_usd: agent.cost_micro_usd,
                prompt_tokens: agent.prompt_tokens,
                completion_tokens: agent.completion_tokens,
            })
            .collect(),
        budget: summary.budget.as_ref().map(|budget| UsageSummaryBudget {
            grain: budget.grain.clone(),
            limit_micro_usd: budget.limit_micro_usd,
            spent_micro_usd: budget.spent_micro_usd,
            reserved_micro_usd: budget.reserved_micro_usd,
            state: budget_state(
                budget.spent_micro_usd + budget.reserved_micro_usd,
                budget.soft_limit_micro_usd,
                budget.limit_micro_usd,
            ),
            period_start: iso8601(budget.period_start),
        }),
    }))
}

/// Every window rejection is a 400 with Swift's exact sentence.
fn window_error(error: UsageWindowError) -> ApiError {
    ApiError::bad_request(error.to_string())
}

/// `ISO8601DateFormatter` with `.withInternetDateTime` — second precision, `Z`
/// suffix (Swift `iso8601` :158-163).
fn iso8601(at: chrono::DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn timestamps_are_second_precision_utc_like_swift() {
        let at = Utc
            .with_ymd_and_hms(2026, 8, 1, 12, 30, 45)
            .single()
            .expect("a real instant");
        assert_eq!(iso8601(at), "2026-08-01T12:30:45Z");
        // Sub-second precision is dropped, not rounded into the string — the
        // Swift formatter emits whole seconds and clients parse that shape.
        let precise = at + chrono::Duration::milliseconds(750);
        assert_eq!(iso8601(precise), "2026-08-01T12:30:45Z");
    }

    #[test]
    fn every_window_rejection_is_a_400_with_the_swift_sentence() {
        for (error, message) in [
            (
                UsageWindowError::UnknownBucket,
                "bucket must be day, week, or month",
            ),
            (UsageWindowError::Inverted, "from must not be later than to"),
            (UsageWindowError::TooWide, "range must not exceed 93 days"),
            (
                UsageWindowError::UnparsableTimestamp("from"),
                "from must be an ISO8601 timestamp",
            ),
        ] {
            let api = window_error(error);
            assert_eq!(api.status, axum::http::StatusCode::BAD_REQUEST);
            assert_eq!(api.message, message);
        }
    }
}
