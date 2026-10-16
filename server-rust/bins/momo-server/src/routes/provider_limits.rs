//! 「한도·남은 크레딧」 — the per-company budget and month-to-date spend
//! estimate behind the 팀 AI 키 panel (#3886, ADR-0147 증보 2026-10-16).
//!
//! ```text
//! GET /v1/provider/limits
//! PUT /v1/provider/limits/budget      { company, monthlyBudgetUsd | null }
//! ```
//!
//! Reads use the MOMO-583 gate as `provider/link`; the budget write uses the stricter
//! `require_instance_operator_write` (a read scope is not enough),
//! and both run inside `with_provider_link_admin_tx`: the budget table's policy
//! refuses every other transaction.
//!
//! ## What the numbers are — and are not
//!
//! Anthropic and OpenAI give an ordinary API key no endpoint for the remaining
//! credit (console only; their usage/cost reports need an admin credential, which
//! this server deliberately does not store). So `spend` here is **oort's own
//! estimate**: this workspace's `usage_ledger` tokens this UTC month times
//! `model_pricing`, per company (see `momo_agent::provider_spend_in_tx`), set
//! against the monthly figure the operator typed. The response says `estimate`
//! in its field names; the client labels it as such and never as a provider
//! balance. Nothing here touches a key: no bearer, envelope or provider text is
//! read, held or returned.

use axum::extract::State;
use axum::{Extension, Json};
use chrono::{DateTime, Datelike, TimeZone, Utc};
use momo_agent::{provider_spend_in_tx, ProviderModelSpend};
use momo_auth::Principal;
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::with_provider_link_admin_tx;
use momo_settings::{
    delete_key_budget, is_budget_company, list_key_budgets, upsert_key_budget, BUDGET_COMPANIES,
    MAX_BUDGET_MICRO_USD,
};
use serde::{Deserialize, Serialize};

use crate::error::ApiError;
use crate::routes::shared::{
    audit_via_token_id, require_instance_operator, require_instance_operator_write,
};
use crate::AppState;

const LIMITS_SCHEMA: &str = "momo.provider_limits.v0";

/// Unpriced model ids named per company — enough to act on, bounded.
const MAX_UNPRICED_LISTED: usize = 8;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderLimitsResponse {
    pub schema: &'static str,
    /// First instant of the UTC month the estimate covers.
    pub month_start_ms: i64,
    pub computed_at_ms: i64,
    pub companies: Vec<CompanyLimits>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanyLimits {
    pub company: &'static str,
    /// What the operator typed (micro-USD); `null` = none entered.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub monthly_budget_micro_usd: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub budget_updated_at_ms: Option<i64>,
    pub spend_estimate: SpendEstimate,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SpendEstimate {
    /// Priced runs only; see `unpriced_*` for what it leaves out.
    pub micro_usd: i64,
    pub runs: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    /// Runs on a model with no `model_pricing` row: counted in `runs`, but their
    /// dollars are not in `micro_usd`.
    pub unpriced_runs: i64,
    pub unpriced_models: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PutBudgetRequest {
    pub company: String,
    /// USD per month; `null` clears the entry.
    pub monthly_budget_usd: Option<f64>,
}

fn month_start(now: DateTime<Utc>) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(now.year(), now.month(), 1, 0, 0, 0)
        .single()
        .unwrap_or(now)
}

fn spend_for(company: &str, rows: &[ProviderModelSpend]) -> SpendEstimate {
    let mut out = SpendEstimate::default();
    for row in rows.iter().filter(|row| row.company == company) {
        out.runs = out.runs.saturating_add(row.runs);
        out.prompt_tokens = out.prompt_tokens.saturating_add(row.prompt_tokens);
        out.completion_tokens = out.completion_tokens.saturating_add(row.completion_tokens);
        if row.priced {
            out.micro_usd = out.micro_usd.saturating_add(row.cost_micro_usd);
        } else {
            out.unpriced_runs = out.unpriced_runs.saturating_add(row.runs);
            if out.unpriced_models.len() < MAX_UNPRICED_LISTED {
                out.unpriced_models.push(row.model.clone());
            }
        }
    }
    out
}

async fn build(
    state: &AppState,
    principal: &Principal,
) -> Result<ProviderLimitsResponse, ApiError> {
    let workspace_id = principal.workspace_id;
    let now = Utc::now();
    let since = month_start(now);
    let (budgets, spend) = with_provider_link_admin_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            let budgets = list_key_budgets(conn).await?;
            let spend = provider_spend_in_tx(conn, workspace_id, since).await?;
            Ok((budgets, spend))
        })
    })
    .await
    .map_err(|error| ApiError::internal("provider_limits.read", error))?;

    let companies = BUDGET_COMPANIES
        .iter()
        .map(|company| {
            let budget = budgets.iter().find(|row| row.company == *company);
            CompanyLimits {
                company,
                monthly_budget_micro_usd: budget.map(|row| row.monthly_budget_micro_usd),
                budget_updated_at_ms: budget.map(|row| row.updated_at.timestamp_millis()),
                spend_estimate: spend_for(company, &spend),
            }
        })
        .collect();
    Ok(ProviderLimitsResponse {
        schema: LIMITS_SCHEMA,
        month_start_ms: since.timestamp_millis(),
        computed_at_ms: now.timestamp_millis(),
        companies,
    })
}

pub async fn get(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<ProviderLimitsResponse>, ApiError> {
    require_instance_operator(&state, &principal).await?;
    Ok(Json(build(&state, &principal).await?))
}

pub async fn put_budget(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<PutBudgetRequest>,
) -> Result<Json<ProviderLimitsResponse>, ApiError> {
    // The write gate, not the read gate: a `platform:read` token may look but not
    // overwrite the instance-global budget (security review M1).
    require_instance_operator_write(&state, &principal).await?;
    if !is_budget_company(&request.company) {
        return Err(ApiError::bad_request(
            "company must be one of anthropic, openai, xai, openrouter",
        ));
    }
    let micro = match request.monthly_budget_usd {
        None => None,
        Some(usd) if usd.is_finite() && usd >= 0.0 => {
            let micro = (usd * 1_000_000.0).round();
            if micro > MAX_BUDGET_MICRO_USD as f64 {
                return Err(ApiError::bad_request(
                    "monthlyBudgetUsd must be between 0 and 1000000",
                ));
            }
            Some(micro as i64)
        }
        Some(_) => {
            return Err(ApiError::bad_request(
                "monthlyBudgetUsd must be between 0 and 1000000",
            ))
        }
    };

    let workspace_id = principal.workspace_id;
    let member_id = principal.member_id;
    let via_token = audit_via_token_id(&principal);
    let company = request.company.clone();
    with_provider_link_admin_tx(&state.pool, workspace_id, move |conn| {
        Box::pin(async move {
            match micro {
                Some(value) => upsert_key_budget(conn, &company, value, member_id).await?,
                None => {
                    delete_key_budget(conn, &company).await?;
                }
            }
            write_audit(
                conn,
                &AuditEntry::new(workspace_id, "provider_key_budget.updated")
                    .by(member_id)
                    .via_token(via_token)
                    .with_schema(
                        "momo.provider_key_budget.audit.v1",
                        serde_json::json!({
                            "company": company,
                            "monthly_budget_micro_usd": micro,
                        }),
                    ),
            )
            .await?;
            Ok(())
        })
    })
    .await
    .map_err(|error| ApiError::internal("provider_limits.put_budget", error))?;

    Ok(Json(build(&state, &principal).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(company: &str, model: &str, runs: i64, cost: i64, priced: bool) -> ProviderModelSpend {
        ProviderModelSpend {
            company: company.into(),
            model: model.into(),
            runs,
            prompt_tokens: runs * 100,
            completion_tokens: runs * 10,
            cost_micro_usd: cost,
            priced,
        }
    }

    #[test]
    fn unpriced_runs_are_counted_but_never_given_a_dollar_figure() {
        let rows = [
            row("anthropic", "claude-sonnet-5-5", 3, 1_500_000, true),
            row("anthropic", "claude-mystery-9", 2, 0, false),
            row("openai", "gpt-5.4-codex", 5, 0, false),
        ];
        let anthropic = spend_for("anthropic", &rows);
        assert_eq!(anthropic.micro_usd, 1_500_000);
        assert_eq!(anthropic.runs, 5);
        assert_eq!(anthropic.unpriced_runs, 2);
        assert_eq!(anthropic.unpriced_models, ["claude-mystery-9"]);
        let openai = spend_for("openai", &rows);
        assert_eq!(openai.micro_usd, 0);
        assert_eq!(openai.unpriced_runs, 5);
        assert_eq!(spend_for("xai", &rows).runs, 0);
    }

    #[test]
    fn the_month_starts_on_the_first_at_midnight_utc() {
        let now = Utc.with_ymd_and_hms(2026, 10, 16, 13, 5, 9).unwrap();
        assert_eq!(
            month_start(now),
            Utc.with_ymd_and_hms(2026, 10, 1, 0, 0, 0).unwrap()
        );
    }
}
