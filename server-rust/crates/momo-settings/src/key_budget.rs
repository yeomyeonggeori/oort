//! `provider_key_budget` — the operator's own 「월 크레딧」 per AI company
//! (migration 137, #3886, ADR-0147 증보 2026-10-16).
//!
//! Anthropic and OpenAI expose no remaining-credit endpoint to an ordinary API
//! key, so the settings panel compares oort's own month-to-date spend estimate
//! with a number the operator types in (for example the Max plan's monthly API
//! credit). This table holds only that number: no key, envelope or URL. Both
//! reads and writes run inside `with_provider_link_admin_tx` — the policy
//! refuses everything else.

use chrono::{DateTime, Utc};
use momo_db::DbError;
use sqlx::PgConnection;
use uuid::Uuid;

/// The companies a budget may name — the preset ids, closed.
pub const BUDGET_COMPANIES: [&str; 4] = ["anthropic", "openai", "xai", "openrouter"];

/// $1,000,000 in micro-USD — the table's CHECK ceiling.
pub const MAX_BUDGET_MICRO_USD: i64 = 1_000_000_000_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyBudget {
    pub company: String,
    pub monthly_budget_micro_usd: i64,
    pub updated_at: DateTime<Utc>,
}

pub fn is_budget_company(raw: &str) -> bool {
    BUDGET_COMPANIES.contains(&raw)
}

pub async fn list_key_budgets(conn: &mut PgConnection) -> Result<Vec<KeyBudget>, DbError> {
    let rows: Vec<(String, i64, DateTime<Utc>)> = sqlx::query_as(
        "SELECT company, monthly_budget_micro_usd, updated_at \
           FROM provider_key_budget ORDER BY company ASC",
    )
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(company, monthly_budget_micro_usd, updated_at)| KeyBudget {
                company,
                monthly_budget_micro_usd,
                updated_at,
            },
        )
        .collect())
}

/// Insert or replace one company's budget.
pub async fn upsert_key_budget(
    conn: &mut PgConnection,
    company: &str,
    monthly_budget_micro_usd: i64,
    updated_by: Uuid,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO provider_key_budget (company, monthly_budget_micro_usd, updated_by) \
         VALUES ($1, $2, $3) \
         ON CONFLICT (company) DO UPDATE SET \
           monthly_budget_micro_usd = EXCLUDED.monthly_budget_micro_usd, \
           updated_by = EXCLUDED.updated_by, updated_at = now()",
    )
    .bind(company)
    .bind(monthly_budget_micro_usd)
    .bind(updated_by)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Remove one company's budget; `true` when a row existed.
pub async fn delete_key_budget(conn: &mut PgConnection, company: &str) -> Result<bool, DbError> {
    let done = sqlx::query("DELETE FROM provider_key_budget WHERE company = $1")
        .bind(company)
        .execute(&mut *conn)
        .await?;
    Ok(done.rows_affected() > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_preset_companies_are_budget_companies() {
        for preset in crate::PROVIDER_PRESETS {
            assert!(is_budget_company(preset.id), "{}", preset.id);
        }
        assert!(!is_budget_company("other"));
        assert!(!is_budget_company("Anthropic"));
        assert!(!is_budget_company(""));
    }
}
