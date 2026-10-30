//! Workspace usage reads and optional shared-agent subscription fees (#4781).
//!
//! ADR-0147 (2026-10-30): every active member can read shared agents and their
//! own personal agents. Owner/admin see all; guests use the roster's channel
//! narrowing first. Both readers use the same visibility decision. In the
//! legacy summary, every aggregate is filtered and non-admin budget is omitted
//! to prevent subtraction from revealing someone else's personal costs.

use axum::extract::{Path, Query, State};
use axum::{Extension, Json};
use chrono::{Datelike, SecondsFormat, TimeZone, Utc};
use momo_agent::{budget_state, usage_summary_visible_in_tx, validated_window, UsageWindowError};
use momo_auth::{active_workspace_role, Principal, WorkspaceRole};
use momo_db::sqlx::Row;
use momo_db::{sqlx, DbError, PgConnection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

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
) -> Result<Json<Value>, ApiError> {
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
    let (summary, is_admin) = settle_db(
        "usage.summary",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                // The membership check is a read inside the same tenant scope, so
                // a non-member's 403 and RLS's zero rows agree rather than the
                // route inventing an empty-but-successful answer.
                let Some(role) = active_workspace_role(conn, workspace_id, member_id).await? else {
                    return Ok(Err(ApiError::forbidden("not a workspace member")));
                };
                let visibility = load_visibility(conn, workspace_id, member_id, role).await?;
                let ids = visibility.ids();
                let summary = usage_summary_visible_in_tx(
                    conn,
                    workspace_id,
                    window,
                    (!role.is_admin()).then_some(ids.as_slice()),
                )
                .await?;
                Ok(Ok((summary, role.is_admin())))
            })
        })
        .await,
    )?;

    let response = UsageSummaryResponse {
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
    };
    let mut response = json!(response);
    if !is_admin {
        // The budget's spent/reserved counters describe the whole workspace.
        // Removing only byAgent would disclose hidden costs through these and
        // through the other projections. All aggregates above use visible ids.
        response
            .as_object_mut()
            .expect("response object")
            .remove("budget");
        response["scope"] = json!("visible");
    }
    Ok(Json(response))
}

struct Visibility {
    facts: Vec<momo_agent::AgentReadFacts>,
    hidden_personal_agents: i64,
}

impl Visibility {
    fn ids(&self) -> Vec<Uuid> {
        self.facts.iter().map(|fact| fact.agent_member_id).collect()
    }
}

/// Model A: classification comes from the same facts as the roster, never from
/// "has an owner" (shared agents can also have a managing human).
fn visible(role: WorkspaceRole, viewer: Uuid, fact: &momo_agent::AgentReadFacts) -> bool {
    role.is_admin()
        || fact.callable_by == momo_agent::CALLABLE_BY_EVERYONE
        || fact.owner.as_ref().is_some_and(|(id, _)| *id == viewer)
}

async fn load_visibility(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    viewer: Uuid,
    role: WorkspaceRole,
) -> Result<Visibility, DbError> {
    let ids = if role == WorkspaceRole::Guest {
        // Reuse the actual roster's guest narrowing, without its HTTP page cap.
        momo_messaging::list_workspace_roster(
            conn,
            workspace_id,
            viewer,
            true,
            Some(momo_messaging::MemberKind::Agent),
            i64::MAX,
        )
        .await?
        .into_iter()
        .map(|member| member.id)
        .collect::<Vec<_>>()
    } else {
        sqlx::query_scalar::<_, Uuid>(
            "SELECT id FROM member WHERE workspace_id = $1 AND kind = 'agent' AND deleted_at IS NULL ORDER BY id",
        ).bind(workspace_id).fetch_all(&mut *conn).await?
    };
    let facts = momo_agent::load_agent_read_facts_in_tx(conn, workspace_id, &ids).await?;
    let hidden_personal_agents = facts
        .iter()
        .filter(|fact| !visible(role, viewer, fact))
        .count() as i64;
    Ok(Visibility {
        facts: facts
            .into_iter()
            .filter(|fact| visible(role, viewer, fact))
            .collect(),
        hidden_personal_agents,
    })
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsageMetrics {
    runs: i64,
    reported_runs: i64,
    prompt_tokens: i64,
    completion_tokens: i64,
    cached_tokens: i64,
    cost_micro_usd: i64,
    unpriced_runs: i64,
    unpriced_models: Vec<String>,
    estimated_runs: i64,
    /// null means no usage, never a measured zero.
    source: Option<&'static str>,
}

impl AgentUsageMetrics {
    fn add(&mut self, other: &Self) {
        self.runs += other.runs;
        self.reported_runs += other.reported_runs;
        self.prompt_tokens += other.prompt_tokens;
        self.completion_tokens += other.completion_tokens;
        self.cached_tokens += other.cached_tokens;
        self.cost_micro_usd += other.cost_micro_usd;
        self.unpriced_runs += other.unpriced_runs;
        self.estimated_runs += other.estimated_runs;
        self.unpriced_models
            .extend(other.unpriced_models.iter().cloned());
        self.unpriced_models.sort();
        self.unpriced_models.dedup();
        self.unpriced_models.truncate(8);
        self.source = match (self.source, other.source) {
            (Some("self_reported"), _) | (_, Some("self_reported")) => Some("self_reported"),
            (Some(_), _) | (_, Some(_)) => Some("measured"),
            _ => None,
        };
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    agent_member_id: Uuid,
    #[serde(flatten)]
    metrics: AgentUsageMetrics,
    #[serde(skip_serializing_if = "Option::is_none")]
    subscription_fee: Option<SubscriptionFee>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsageTotals {
    mine: AgentUsageMetrics,
    shared: AgentUsageMetrics,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace: Option<AgentUsageMetrics>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsageResponse {
    range: UsageSummaryRange,
    agents: Vec<AgentUsage>,
    totals: AgentUsageTotals,
    hidden_personal_agents: i64,
}

pub async fn agents(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(workspace): Path<String>,
    Query(query): Query<UsageSummaryQuery>,
) -> Result<Json<AgentUsageResponse>, ApiError> {
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let window = agent_window(&query, Utc::now()).map_err(window_error)?;
    let viewer = principal.member_id;
    let response = settle_db(
        "usage.agents",
        agent_tenant_tx(&state.pool, workspace_id, move |conn| {
            Box::pin(async move {
                let Some(role) = active_workspace_role(conn, workspace_id, viewer).await? else {
                    return Ok(Err(ApiError::forbidden("not a workspace member")));
                };
                let visibility = load_visibility(conn, workspace_id, viewer, role).await?;
                let rows =
                    momo_agent::agent_usage_in_tx(conn, workspace_id, window, &visibility.ids())
                        .await?;
                let fees = load_subscription_fees(conn, workspace_id, &visibility.ids()).await?;
                let mut agents = Vec::with_capacity(visibility.facts.len());
                let mut totals = AgentUsageTotals {
                    workspace: role.is_admin().then(AgentUsageMetrics::default),
                    ..Default::default()
                };
                for fact in &visibility.facts {
                    let mut metrics = AgentUsageMetrics::default();
                    for row in rows
                        .iter()
                        .filter(|row| row.agent_member_id == fact.agent_member_id)
                    {
                        let source = match row.source.as_deref() {
                            Some("measured") => "measured",
                            Some("self_reported") => "self_reported",
                            _ => match fact.brain {
                                momo_agent::AgentBrain::External
                                | momo_agent::AgentBrain::Subscription => "self_reported",
                                _ => "measured",
                            },
                        };
                        metrics.add(&AgentUsageMetrics {
                            runs: row.runs,
                            reported_runs: row.reported_runs,
                            prompt_tokens: row.prompt_tokens,
                            completion_tokens: row.completion_tokens,
                            cached_tokens: row.cached_tokens,
                            cost_micro_usd: row.cost_micro_usd,
                            unpriced_runs: row.unpriced_runs,
                            unpriced_models: if row.unpriced_runs > 0 {
                                vec![row.model.clone()]
                            } else {
                                vec![]
                            },
                            estimated_runs: row.estimated_runs,
                            source: Some(source),
                        });
                    }
                    if fact.callable_by == momo_agent::CALLABLE_BY_EVERYONE {
                        totals.shared.add(&metrics);
                    } else if fact
                        .owner
                        .as_ref()
                        .is_some_and(|(owner, _)| *owner == viewer)
                    {
                        totals.mine.add(&metrics);
                    }
                    if let Some(workspace) = &mut totals.workspace {
                        workspace.add(&metrics);
                    }
                    agents.push(AgentUsage {
                        agent_member_id: fact.agent_member_id,
                        metrics,
                        subscription_fee: fees.get(&fact.agent_member_id).cloned(),
                    });
                }
                Ok(Ok(AgentUsageResponse {
                    range: UsageSummaryRange {
                        from: iso8601(window.from),
                        to: iso8601(window.to),
                        bucket: "month".into(),
                    },
                    agents,
                    totals,
                    hidden_personal_agents: visibility.hidden_personal_agents,
                }))
            })
        })
        .await,
    )?;
    Ok(Json(response))
}

fn agent_window(
    query: &UsageSummaryQuery,
    now: chrono::DateTime<Utc>,
) -> Result<momo_agent::UsageWindow, UsageWindowError> {
    let mut window = validated_window(
        query.from.as_deref(),
        query.to.as_deref(),
        Some("month"),
        now,
    )?;
    if query
        .from
        .as_deref()
        .is_none_or(|from| from.trim().is_empty())
    {
        window.from = Utc
            .with_ymd_and_hms(window.to.year(), window.to.month(), 1, 0, 0, 0)
            .single()
            .expect("UTC calendar month start");
    }
    Ok(window)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionFee {
    monthly_micro_usd: i64,
    label: Option<String>,
}

async fn load_subscription_fees(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    visible_agents: &[Uuid],
) -> Result<std::collections::HashMap<Uuid, SubscriptionFee>, DbError> {
    let rows = sqlx::query(
        "SELECT agent_member_id, monthly_micro_usd, label FROM agent_subscription_fee \
         WHERE workspace_id = $1 AND agent_member_id = ANY($2)",
    )
    .bind(workspace_id)
    .bind(visible_agents)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(|row| {
            Ok((
                row.try_get("agent_member_id")?,
                SubscriptionFee {
                    monthly_micro_usd: row.try_get("monthly_micro_usd")?,
                    label: row.try_get("label")?,
                },
            ))
        })
        .collect::<Result<_, sqlx::Error>>()
        .map_err(DbError::from)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PutSubscriptionFee {
    /// null clears the setting; zero is an explicitly free subscription.
    monthly_micro_usd: Option<i64>,
    #[serde(default)]
    label: Option<String>,
}

pub async fn put_subscription_fee(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((workspace, agent)): Path<(String, String)>,
    Json(request): Json<PutSubscriptionFee>,
) -> Result<Json<Value>, ApiError> {
    use crate::routes::shared::{audit_via_token_id, path_uuid, require_human};
    use momo_db::audit::{write_audit, AuditEntry};
    require_human(&principal, "workspace owner/admin human required")?;
    let workspace_id = workspace_scope(&workspace, &principal)?;
    let agent_id = path_uuid(&agent, "invalid agent id")?;
    if request
        .monthly_micro_usd
        .is_some_and(|amount| !(0..=1_000_000_000_000).contains(&amount))
        || request
            .label
            .as_ref()
            .is_some_and(|label| label.chars().count() > 120)
    {
        return Err(ApiError::bad_request(
            "invalid subscription amount or label",
        ));
    }
    let response = settle_db("usage.subscription_fee", agent_tenant_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            // No platform-scope bypass: the actual workspace role is required.
            if !active_workspace_role(conn, workspace_id, principal.member_id).await?.is_some_and(|role| role.is_admin()) {
                return Ok(Err(ApiError::forbidden("workspace owner/admin required")));
            }
            let scope: Option<String> = sqlx::query_scalar(
                "SELECT invocation_scope FROM agent WHERE workspace_id = $1 AND member_id = $2 FOR UPDATE",
            ).bind(workspace_id).bind(agent_id).fetch_optional(&mut *conn).await?;
            match scope.as_deref() {
                None => return Ok(Err(ApiError::not_found("agent not found"))),
                Some("owner_only") => return Ok(Err(ApiError::new(axum::http::StatusCode::CONFLICT, "personal agent subscription cannot be set by the workspace"))),
                _ => {}
            }
            sqlx::query("SELECT set_config('app.agent_subscription_fee_admin', 'on', true)").execute(&mut *conn).await?;
            if let Some(amount) = request.monthly_micro_usd {
                sqlx::query(
                    "INSERT INTO agent_subscription_fee (workspace_id, agent_member_id, monthly_micro_usd, label, updated_by) \
                     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (agent_member_id) DO UPDATE \
                     SET monthly_micro_usd = EXCLUDED.monthly_micro_usd, label = EXCLUDED.label, \
                         updated_by = EXCLUDED.updated_by, updated_at = now() \
                     WHERE agent_subscription_fee.workspace_id = EXCLUDED.workspace_id",
                ).bind(workspace_id).bind(agent_id).bind(amount).bind(&request.label).bind(principal.member_id).execute(&mut *conn).await?;
            } else {
                sqlx::query("DELETE FROM agent_subscription_fee WHERE workspace_id = $1 AND agent_member_id = $2")
                    .bind(workspace_id).bind(agent_id).execute(&mut *conn).await?;
            }
            let mut audit = AuditEntry::new(workspace_id, "agent.subscription_fee.updated");
            audit.actor_member_id = Some(principal.member_id);
            audit.subject_member_id = Some(agent_id);
            audit.target_type = Some("agent".into());
            audit.target_id = Some(agent_id);
            audit.via_token_id = audit_via_token_id(&principal);
            // The label is free text: audit only the amount, never that text.
            audit.detail = json!({"monthlyMicroUsd": request.monthly_micro_usd});
            write_audit(conn, &audit).await?;
            Ok(Ok(json!({"agentMemberId": agent_id, "subscriptionFee": request.monthly_micro_usd.map(|amount| SubscriptionFee {
                monthly_micro_usd: amount, label: request.label,
            })})))
        })
    }).await)?;
    Ok(Json(response))
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

    #[test]
    fn agent_windows_default_to_utc_calendar_month_and_keep_explicit_bounds() {
        let query = UsageSummaryQuery {
            from: None,
            to: None,
            bucket: None,
        };
        let now = Utc.with_ymd_and_hms(2026, 10, 30, 8, 45, 0).unwrap();
        let window = agent_window(&query, now).unwrap();
        assert_eq!(iso8601(window.from), "2026-10-01T00:00:00Z");
        assert_eq!(window.to, now);
        let query = UsageSummaryQuery {
            from: Some("2026-09-01T00:00:00Z".into()),
            to: Some("2026-09-30T23:59:59Z".into()),
            bucket: None,
        };
        let window = agent_window(&query, now).unwrap();
        assert_eq!(iso8601(window.from), "2026-09-01T00:00:00Z");
        assert_eq!(iso8601(window.to), "2026-09-30T23:59:59Z");
    }
}
