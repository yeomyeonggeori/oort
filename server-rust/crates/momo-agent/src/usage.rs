//! `usage_ledger` — the immutable system of record for LLM spend, and the
//! aggregation that reads it.
//!
//! **This module owns every `usage_ledger` statement in the workspace.**
//!
//! ## One writer, measured
//!
//! `grep -rn 'INSERT INTO usage_ledger' server/Sources` returns exactly one hit:
//! `AgentGatewayRoutes.swift:1352`, inside the completion callback. That is the
//! whole accrual story on the Swift server — there is no per-event ledger write,
//! no worker-side write, and no reconciliation job. So [`record_run_usage_in_tx`]
//! is this server's single writer too, called from the same place: the gateway
//! completion, inside the transaction that also writes the final message and the
//! terminal run status. Either all three commit or none do; a billed run with no
//! output (or output with no bill) is not representable.
//!
//! ## Immutable by construction, idempotent by predicate
//!
//! `usage_ledger` has no `UPDATE` path and no unique index on `run_id` (only the
//! `usage_ledger_run_idx` lookup index, `001_init.sql:471`). Swift's
//! `WHERE NOT EXISTS (… workspace_id = ws AND run_id = run)` is therefore the
//! *only* thing standing between a replayed completion and a double charge —
//! which is why the insert runs inside the completion's row-locked transaction
//! (`lock_gateway_run_in_tx` takes `FOR UPDATE` on the run first), so two
//! concurrent completions serialize instead of both passing the `NOT EXISTS`.
//!
//! ## The summary reads it and writes nothing
//!
//! [`usage_summary_in_tx`] ports `UsageSummaryRoutes.swift` (MOMO-615): the same
//! five aggregations over the same predicate, with the inclusive-both-ends window
//! and UTC bucket boundaries that route fixed. It needs no migration — the
//! `usage_ledger_ws_time_idx (workspace_id, created_at DESC)` index already
//! covers `workspace_id + created_at`.

use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use momo_db::DbError;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

/// One accrual, as the gateway reports it (Swift `AgentGatewayUsage`).
///
/// Every field is optional because an adapter that cannot measure a dimension
/// must still be able to close a run: the missing values become `0`, and
/// `was_estimated` becomes `true` — see [`RunUsageReport::resolve`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunUsageReport {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub prompt_tokens: Option<i32>,
    pub completion_tokens: Option<i32>,
    pub cached_tokens: Option<i32>,
    pub reasoning_tokens: Option<i32>,
    pub cost_micro_usd: Option<i64>,
    pub was_estimated: Option<bool>,
}

/// The row that will be written, after defaults and the effort precedence are
/// applied. Split out from the INSERT so the accrual *rules* are unit-testable
/// without a database.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedUsage {
    pub model: String,
    pub effort: Option<&'static str>,
    pub prompt_tokens: i32,
    pub completion_tokens: i32,
    pub cached_tokens: i32,
    pub reasoning_tokens: i32,
    pub cost_micro_usd: i64,
    pub was_estimated: bool,
}

impl RunUsageReport {
    /// Apply Swift `reconcileUsage`'s defaults (:1336-1348).
    ///
    /// `report == None` and `report.was_estimated == None` both resolve to
    /// **`was_estimated = true`**, which is the honest reading: a gateway that
    /// reported nothing has not measured anything, so the zero row it produces
    /// must not be presented to an operator as a measured zero. The summary
    /// surfaces that distinction as `totals.estimatedMicroUsd`.
    pub fn resolve(
        report: Option<&RunUsageReport>,
        fallback_model: &str,
        requested_effort: Option<&str>,
        profile_effort_pref: Option<&str>,
    ) -> ResolvedUsage {
        let model = report
            .and_then(|usage| usage.model.as_deref())
            .map(str::to_string)
            .unwrap_or_else(|| fallback_model.to_string());
        let effort = crate::effort::ledger_effort(
            report.and_then(|usage| usage.effort.as_deref()),
            requested_effort,
            profile_effort_pref,
            &model,
        );
        ResolvedUsage {
            effort,
            prompt_tokens: report.and_then(|usage| usage.prompt_tokens).unwrap_or(0),
            completion_tokens: report
                .and_then(|usage| usage.completion_tokens)
                .unwrap_or(0),
            cached_tokens: report.and_then(|usage| usage.cached_tokens).unwrap_or(0),
            reasoning_tokens: report.and_then(|usage| usage.reasoning_tokens).unwrap_or(0),
            cost_micro_usd: report.and_then(|usage| usage.cost_micro_usd).unwrap_or(0),
            was_estimated: match report {
                None => true,
                Some(usage) => usage.was_estimated.unwrap_or(true),
            },
            model,
        }
    }
}

/// Append the run's ledger row, unless this run already has one.
///
/// Returns `true` when this call wrote the row — the caller uses that to tell a
/// first completion from a replay. Must be called on a connection whose
/// transaction already holds the run's `FOR UPDATE` lock (see the module docs);
/// without it the `NOT EXISTS` is a TOCTOU window wide enough to double-charge.
pub async fn record_run_usage_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    agent_member_id: Uuid,
    channel_id: Uuid,
    usage: &ResolvedUsage,
) -> Result<bool, DbError> {
    let inserted = sqlx::query(
        "INSERT INTO usage_ledger \
           (workspace_id, run_id, agent_member_id, channel_id, model, \
            prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens, \
            cost_micro_usd, was_estimated, effort) \
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12 \
          WHERE NOT EXISTS ( \
            SELECT 1 FROM usage_ledger WHERE workspace_id = $1 AND run_id = $2 \
          )",
    )
    .bind(workspace_id)
    .bind(run_id)
    .bind(agent_member_id)
    .bind(channel_id)
    .bind(&usage.model)
    .bind(usage.prompt_tokens)
    .bind(usage.completion_tokens)
    .bind(usage.cached_tokens)
    .bind(usage.reasoning_tokens)
    .bind(usage.cost_micro_usd)
    .bind(usage.was_estimated)
    .bind(usage.effort)
    .execute(&mut *conn)
    .await?;
    Ok(inserted.rows_affected() > 0)
}

// ---------------------------------------------------------------------------
// summary (Swift UsageSummaryRoutes.swift)
// ---------------------------------------------------------------------------

/// `?bucket=` (Swift `UsageSummaryRoutes.Bucket`). The value is bound as a
/// parameter to `date_trunc`, never interpolated, and the enum is what makes
/// that safe — an arbitrary string can never reach the function.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsageBucket {
    Day,
    Week,
    Month,
}

impl UsageBucket {
    pub fn as_str(self) -> &'static str {
        match self {
            UsageBucket::Day => "day",
            UsageBucket::Week => "week",
            UsageBucket::Month => "month",
        }
    }

    pub fn parse(raw: &str) -> Option<UsageBucket> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "day" => Some(UsageBucket::Day),
            "week" => Some(UsageBucket::Week),
            "month" => Some(UsageBucket::Month),
            _ => None,
        }
    }
}

/// The validated request window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UsageWindow {
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    pub bucket: UsageBucket,
}

/// Default lookback when `from` is omitted (Swift :106).
pub const DEFAULT_LOOKBACK_DAYS: i64 = 30;
/// Hard ceiling on the requested span (Swift :108) — a wider one is a 400.
pub const MAX_RANGE_DAYS: i64 = 93;

/// Why a window was rejected, with the Swift 400 messages verbatim.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum UsageWindowError {
    #[error("bucket must be day, week, or month")]
    UnknownBucket,
    #[error("{0} must be an ISO8601 timestamp")]
    UnparsableTimestamp(&'static str),
    #[error("from must not be later than to")]
    Inverted,
    #[error("range must not exceed 93 days")]
    TooWide,
}

/// Parse one `from`/`to` value. Accepts the three shapes Swift's
/// `ISO8601DateFormatter` option list does (:152-156): internet date-time with
/// fractional seconds, internet date-time, and a bare `yyyy-MM-dd` (midnight UTC).
fn parse_timestamp(
    raw: Option<&str>,
    label: &'static str,
) -> Result<Option<DateTime<Utc>>, UsageWindowError> {
    let Some(raw) = raw else { return Ok(None) };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if let Ok(parsed) = DateTime::parse_from_rfc3339(trimmed) {
        return Ok(Some(parsed.with_timezone(&Utc)));
    }
    if let Ok(date) = NaiveDate::parse_from_str(trimmed, "%Y-%m-%d") {
        let midnight = date
            .and_hms_opt(0, 0, 0)
            .expect("00:00:00 is a valid time of day");
        return Ok(Some(Utc.from_utc_datetime(&midnight)));
    }
    Err(UsageWindowError::UnparsableTimestamp(label))
}

/// Swift `validatedWindow` (:110-137).
///
/// `now` is a parameter rather than `Utc::now()` so the defaulting and the span
/// ceiling are testable without a clock.
pub fn validated_window(
    from: Option<&str>,
    to: Option<&str>,
    bucket: Option<&str>,
    now: DateTime<Utc>,
) -> Result<UsageWindow, UsageWindowError> {
    let bucket = match bucket.map(str::trim).filter(|raw| !raw.is_empty()) {
        Some(raw) => UsageBucket::parse(raw).ok_or(UsageWindowError::UnknownBucket)?,
        None => UsageBucket::Day,
    };
    let upper = parse_timestamp(to, "to")?.unwrap_or(now);
    let lower = parse_timestamp(from, "from")?
        .unwrap_or_else(|| upper - Duration::days(DEFAULT_LOOKBACK_DAYS));
    if lower > upper {
        return Err(UsageWindowError::Inverted);
    }
    if upper - lower > Duration::days(MAX_RANGE_DAYS) {
        return Err(UsageWindowError::TooWide);
    }
    Ok(UsageWindow {
        from: lower,
        to: upper,
        bucket,
    })
}

/// Totals over the window (Swift `UsageSummaryTotalsDTO`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct UsageTotals {
    pub cost_micro_usd: i64,
    /// The share of `cost_micro_usd` that came from rows the adapter did **not**
    /// measure. Surfacing it is the point: an operator must be able to tell a
    /// bill from a guess.
    pub estimated_micro_usd: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageBucketRow {
    pub start: DateTime<Utc>,
    pub cost_micro_usd: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageModelRow {
    pub model: String,
    pub cost_micro_usd: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageAgentRow {
    pub agent_member_id: Uuid,
    pub display_name: String,
    pub cost_micro_usd: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
}

/// The workspace-grain budget projection (Swift `fetchWorkspaceBudget` :308-353).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageBudget {
    pub grain: String,
    pub limit_micro_usd: i64,
    pub soft_limit_micro_usd: Option<i64>,
    pub spent_micro_usd: i64,
    pub reserved_micro_usd: i64,
    pub period_start: DateTime<Utc>,
}

/// Everything `GET …/usage/summary` answers with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageSummary {
    pub window: UsageWindow,
    pub totals: UsageTotals,
    pub buckets: Vec<UsageBucketRow>,
    pub by_model: Vec<UsageModelRow>,
    pub by_agent: Vec<UsageAgentRow>,
    pub budget: Option<UsageBudget>,
}

/// Aggregate the ledger for one workspace and window. Reads only.
///
/// The window is **inclusive on both ends** (`>= from AND <= to`) and bucket
/// boundaries are computed in UTC regardless of the database session timezone —
/// both are choices `UsageSummaryRoutes` fixed (:20-25) and both are load-bearing
/// for "does the sum of the buckets equal the total".
pub async fn usage_summary_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    window: UsageWindow,
) -> Result<UsageSummary, DbError> {
    let totals_row = sqlx::query(
        "SELECT COALESCE(sum(cost_micro_usd), 0)::bigint AS cost_micro_usd, \
                COALESCE(sum(cost_micro_usd) FILTER (WHERE was_estimated), 0)::bigint \
                  AS estimated_micro_usd, \
                COALESCE(sum(prompt_tokens), 0)::bigint AS prompt_tokens, \
                COALESCE(sum(completion_tokens), 0)::bigint AS completion_tokens \
           FROM usage_ledger \
          WHERE workspace_id = $1 AND created_at >= $2 AND created_at <= $3",
    )
    .bind(workspace_id)
    .bind(window.from)
    .bind(window.to)
    .fetch_one(&mut *conn)
    .await?;
    let totals = UsageTotals {
        cost_micro_usd: totals_row.try_get("cost_micro_usd")?,
        estimated_micro_usd: totals_row.try_get("estimated_micro_usd")?,
        prompt_tokens: totals_row.try_get("prompt_tokens")?,
        completion_tokens: totals_row.try_get("completion_tokens")?,
    };

    let bucket_rows = sqlx::query(
        "SELECT (date_trunc($4::text, created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') \
                  AS bucket_start, \
                COALESCE(sum(cost_micro_usd), 0)::bigint AS cost_micro_usd, \
                COALESCE(sum(prompt_tokens), 0)::bigint AS prompt_tokens, \
                COALESCE(sum(completion_tokens), 0)::bigint AS completion_tokens \
           FROM usage_ledger \
          WHERE workspace_id = $1 AND created_at >= $2 AND created_at <= $3 \
          GROUP BY 1 ORDER BY 1",
    )
    .bind(workspace_id)
    .bind(window.from)
    .bind(window.to)
    .bind(window.bucket.as_str())
    .fetch_all(&mut *conn)
    .await?;
    let buckets = bucket_rows
        .iter()
        .map(|row| {
            Ok(UsageBucketRow {
                start: row.try_get("bucket_start")?,
                cost_micro_usd: row.try_get("cost_micro_usd")?,
                prompt_tokens: row.try_get("prompt_tokens")?,
                completion_tokens: row.try_get("completion_tokens")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;

    let model_rows = sqlx::query(
        "SELECT model, \
                COALESCE(sum(cost_micro_usd), 0)::bigint AS cost_micro_usd, \
                COALESCE(sum(prompt_tokens), 0)::bigint AS prompt_tokens, \
                COALESCE(sum(completion_tokens), 0)::bigint AS completion_tokens \
           FROM usage_ledger \
          WHERE workspace_id = $1 AND created_at >= $2 AND created_at <= $3 \
          GROUP BY model ORDER BY cost_micro_usd DESC, model ASC",
    )
    .bind(workspace_id)
    .bind(window.from)
    .bind(window.to)
    .fetch_all(&mut *conn)
    .await?;
    let by_model = model_rows
        .iter()
        .map(|row| {
            Ok(UsageModelRow {
                model: row.try_get("model")?,
                cost_micro_usd: row.try_get("cost_micro_usd")?,
                prompt_tokens: row.try_get("prompt_tokens")?,
                completion_tokens: row.try_get("completion_tokens")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;

    let agent_rows = sqlx::query(
        "SELECT u.agent_member_id, \
                COALESCE(m.display_name, '') AS display_name, \
                COALESCE(sum(u.cost_micro_usd), 0)::bigint AS cost_micro_usd, \
                COALESCE(sum(u.prompt_tokens), 0)::bigint AS prompt_tokens, \
                COALESCE(sum(u.completion_tokens), 0)::bigint AS completion_tokens \
           FROM usage_ledger u \
           LEFT JOIN member m \
             ON m.id = u.agent_member_id AND m.workspace_id = u.workspace_id \
          WHERE u.workspace_id = $1 AND u.created_at >= $2 AND u.created_at <= $3 \
          GROUP BY u.agent_member_id, m.display_name \
          ORDER BY cost_micro_usd DESC, u.agent_member_id ASC",
    )
    .bind(workspace_id)
    .bind(window.from)
    .bind(window.to)
    .fetch_all(&mut *conn)
    .await?;
    let by_agent = agent_rows
        .iter()
        .map(|row| {
            Ok(UsageAgentRow {
                agent_member_id: row.try_get("agent_member_id")?,
                display_name: row.try_get("display_name")?,
                cost_micro_usd: row.try_get("cost_micro_usd")?,
                prompt_tokens: row.try_get("prompt_tokens")?,
                completion_tokens: row.try_get("completion_tokens")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;

    // The tightest workspace-grain budget wins, and its OWN rolling window row
    // supplies spent/reserved — so grain, period and counters always come from
    // one budget row rather than being mixed across two.
    let budget_row = sqlx::query(
        "SELECT b.grain::text AS grain, \
                b.limit_micro_usd::bigint AS limit_micro_usd, \
                b.soft_limit_micro_usd::bigint AS soft_limit_micro_usd, \
                COALESCE(w.spent_micro_usd, 0)::bigint AS spent_micro_usd, \
                COALESCE(w.reserved_micro_usd, 0)::bigint AS reserved_micro_usd, \
                p.period_start \
           FROM budget b \
           CROSS JOIN LATERAL ( \
             SELECT to_timestamp( \
                      floor(extract(epoch from now()) / b.period_seconds) * b.period_seconds \
                    ) AS period_start \
           ) p \
           LEFT JOIN budget_window w \
             ON w.budget_id = b.id AND w.period_start = p.period_start \
          WHERE b.workspace_id = $1 AND b.grain::text = 'workspace' \
          ORDER BY b.limit_micro_usd ASC, b.id ASC \
          LIMIT 1",
    )
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?;
    let budget = budget_row
        .as_ref()
        .map(|row| {
            Ok::<_, sqlx::Error>(UsageBudget {
                grain: row.try_get("grain")?,
                limit_micro_usd: row.try_get("limit_micro_usd")?,
                soft_limit_micro_usd: row.try_get("soft_limit_micro_usd")?,
                spent_micro_usd: row.try_get("spent_micro_usd")?,
                reserved_micro_usd: row.try_get("reserved_micro_usd")?,
                period_start: row.try_get("period_start")?,
            })
        })
        .transpose()?;

    Ok(UsageSummary {
        window,
        totals,
        buckets,
        by_model,
        by_agent,
        budget,
    })
}

/// The budget state label (Swift `CostProjectionRoutes.limitState` :64-72,
/// reached from `UsageSummaryRoutes:346-350`).
///
/// The caller passes `observed = spent + reserved`, because a reservation is
/// money already committed even though it has not settled — a projection that
/// ignored it would report "normal" right up until the charge lands.
pub fn budget_state(
    observed_micro_usd: i64,
    soft_limit_micro_usd: Option<i64>,
    hard_limit_micro_usd: i64,
) -> &'static str {
    if observed_micro_usd >= hard_limit_micro_usd {
        return "hard_limit";
    }
    match soft_limit_micro_usd {
        Some(soft) if observed_micro_usd >= soft => "soft_limit",
        _ => "normal",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(iso: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(iso)
            .expect("fixture timestamp parses")
            .with_timezone(&Utc)
    }

    /// A gateway that reports nothing still closes the run — with a row that says
    /// so.
    #[test]
    fn an_absent_report_resolves_to_an_estimated_zero_row() {
        let resolved = RunUsageReport::resolve(None, "hermes-agent", None, None);
        assert_eq!(
            resolved,
            ResolvedUsage {
                model: "hermes-agent".to_string(),
                effort: None,
                prompt_tokens: 0,
                completion_tokens: 0,
                cached_tokens: 0,
                reasoning_tokens: 0,
                cost_micro_usd: 0,
                was_estimated: true,
            }
        );
    }

    /// `was_estimated` defaults to `true` even when a report exists but omits it:
    /// silence is not a measurement claim.
    #[test]
    fn an_unspecified_was_estimated_is_true_not_false() {
        let report = RunUsageReport {
            prompt_tokens: Some(10),
            ..RunUsageReport::default()
        };
        let resolved = RunUsageReport::resolve(Some(&report), "hermes-agent", None, None);
        assert!(resolved.was_estimated);
        assert_eq!(resolved.prompt_tokens, 10);

        let measured = RunUsageReport {
            was_estimated: Some(false),
            ..report
        };
        assert!(
            !RunUsageReport::resolve(Some(&measured), "hermes-agent", None, None).was_estimated
        );
    }

    /// The reported model wins over the agent's configured one — the ledger must
    /// record what ran, not what was configured.
    #[test]
    fn the_reported_model_overrides_the_agent_model_and_drives_the_effort_table() {
        let report = RunUsageReport {
            model: Some("hermes-fast".to_string()),
            ..RunUsageReport::default()
        };
        let resolved = RunUsageReport::resolve(Some(&report), "hermes-agent", Some("xhigh"), None);
        assert_eq!(resolved.model, "hermes-fast");
        assert_eq!(
            resolved.effort, None,
            "the requested xhigh is not supported by the model that actually ran"
        );
    }

    #[test]
    fn the_window_defaults_to_the_last_30_days_bucketed_by_day() {
        let now = at("2026-08-01T12:00:00Z");
        let window = validated_window(None, None, None, now).expect("defaults are valid");
        assert_eq!(window.to, now);
        assert_eq!(window.from, now - Duration::days(30));
        assert_eq!(window.bucket, UsageBucket::Day);
    }

    #[test]
    fn the_window_accepts_the_three_swift_timestamp_shapes() {
        let now = at("2026-08-01T12:00:00Z");
        for (raw, expected) in [
            ("2026-07-01T00:00:00Z", at("2026-07-01T00:00:00Z")),
            // Fractional seconds are preserved, not truncated: the ledger's
            // `created_at` has sub-second precision, so a boundary that rounded
            // would silently include or exclude a row.
            ("2026-07-01T00:00:00.123Z", at("2026-07-01T00:00:00.123Z")),
            // A bare date is midnight UTC.
            ("2026-07-01", at("2026-07-01T00:00:00Z")),
            // An offset is honoured, then normalized to UTC.
            ("2026-07-01T09:00:00+09:00", at("2026-07-01T00:00:00Z")),
        ] {
            let window =
                validated_window(Some(raw), None, None, now).expect("a supported ISO8601 shape");
            assert_eq!(window.from, expected, "{raw} parsed to the wrong instant");
        }
        assert_eq!(
            validated_window(Some("last tuesday"), None, None, now),
            Err(UsageWindowError::UnparsableTimestamp("from"))
        );
        assert_eq!(
            validated_window(None, Some("nope"), None, now),
            Err(UsageWindowError::UnparsableTimestamp("to"))
        );
    }

    #[test]
    fn the_window_rejects_an_inverted_or_too_wide_range() {
        let now = at("2026-08-01T12:00:00Z");
        assert_eq!(
            validated_window(Some("2026-08-02"), Some("2026-08-01"), None, now),
            Err(UsageWindowError::Inverted)
        );
        assert_eq!(
            validated_window(Some("2026-01-01"), Some("2026-08-01"), None, now),
            Err(UsageWindowError::TooWide)
        );
        // Exactly 93 days is accepted; the ceiling is inclusive.
        let to = at("2026-08-01T00:00:00Z");
        let from = to - Duration::days(MAX_RANGE_DAYS);
        assert!(
            validated_window(Some(&from.to_rfc3339()), Some(&to.to_rfc3339()), None, now).is_ok()
        );
    }

    #[test]
    fn the_bucket_is_a_closed_set() {
        let now = at("2026-08-01T12:00:00Z");
        for (raw, expected) in [
            ("day", UsageBucket::Day),
            ("WEEK", UsageBucket::Week),
            (" month ", UsageBucket::Month),
        ] {
            assert_eq!(
                validated_window(None, None, Some(raw), now)
                    .expect("a known bucket")
                    .bucket,
                expected
            );
        }
        assert_eq!(
            validated_window(None, None, Some("hour"), now),
            Err(UsageWindowError::UnknownBucket)
        );
        // An empty bucket parameter is "not supplied", not an error.
        assert_eq!(
            validated_window(None, None, Some("  "), now)
                .expect("empty means default")
                .bucket,
            UsageBucket::Day
        );
    }

    #[test]
    fn window_error_messages_match_swift() {
        assert_eq!(
            UsageWindowError::UnknownBucket.to_string(),
            "bucket must be day, week, or month"
        );
        assert_eq!(
            UsageWindowError::UnparsableTimestamp("from").to_string(),
            "from must be an ISO8601 timestamp"
        );
        assert_eq!(
            UsageWindowError::Inverted.to_string(),
            "from must not be later than to"
        );
        assert_eq!(
            UsageWindowError::TooWide.to_string(),
            "range must not exceed 93 days"
        );
    }

    /// The three labels are a wire contract (`CostProjectionRoutes.limitState`),
    /// so they are asserted by name, and each boundary is inclusive.
    #[test]
    fn budget_state_labels_and_boundaries_match_swift() {
        assert_eq!(budget_state(0, Some(80), 100), "normal");
        assert_eq!(budget_state(79, Some(80), 100), "normal");
        assert_eq!(budget_state(80, Some(80), 100), "soft_limit");
        assert_eq!(budget_state(100, Some(80), 100), "hard_limit");
        assert_eq!(budget_state(150, None, 100), "hard_limit");
        assert_eq!(budget_state(99, None, 100), "normal");
    }
}
