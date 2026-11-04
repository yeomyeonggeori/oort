//! The team AI's usage limits (ADR-0201 증보 v3 B9, #4944).
//!
//! The team AI answers on the team's own key, so **the team decides how much it may spend**:
//! with nothing set there is no limit at all (the old fixed 200,000 tokens and 50 searches a day
//! are gone), and a workspace administrator may switch on any of three limits —
//! `workspace.settings.team_ai_limits` = `{dailyTokens?, dailySearches?, monthlyUsd?}`
//! (`momo_settings::workspace_settings` validates and writes it; a helper's own
//! `workspace.settings.update` card cannot name the key, B13-I9).
//!
//! What stays operator-owned is a **ceiling**: the env `TEAM_AI_DAILY_TOKEN_CAP` and
//! `TEAM_AI_DAILY_SEARCH_CAP`. Unset or empty = no ceiling; a positive number = a ceiling no
//! workspace value can get past; `0` = the operator's emergency switch ([`OperatorCaps`]).
//!
//! ## What is judged, and when
//!
//! * **Before the model is asked** ([`judge`]): daily tokens and the monthly dollar amount. A hit
//!   means zero model calls, one honest sentence and the 「맡기기」 buttons (D5). Searches are not a
//!   reason to refuse the whole turn: a spent search allowance only withholds the search tool
//!   (H5), exactly as before ([`search_cap`]).
//! * **Where the numbers come from.** Daily tokens and searches are sums over `usage_ledger` (the
//!   system of record, no second counter; `team_ai::tokens_used_today_in_tx`). The monthly amount
//!   is `momo_agent::agent_month_spend_in_tx` — the read-time public-list-price figure of
//!   ADR-0147 증보 2026-10-30, so it is the number the usage screen shows; a run on a model with no
//!   price adds no dollars (B9-2). Day = UTC day, month = UTC calendar month.
//! * The jobs of one agent are claimed one at a time, so two turns cannot both read "under the
//!   limit" and overshoot together; the overshoot is at most the one turn that crossed it.

use momo_agent::{
    agent_month_spend_in_tx, latest_ledger_model_in_tx, pricing_available_for_model_in_tx,
    AgentMonthSpend,
};
use momo_db::{DbError, PgConnection};
use momo_settings::{
    valid_limit_usd, TEAM_AI_LIMITS_SETTING, TEAM_AI_LIMIT_DAILY_SEARCHES,
    TEAM_AI_LIMIT_DAILY_TOKENS, TEAM_AI_LIMIT_MONTHLY_USD,
};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::team_ai::{self, FallbackReason, TeamAiWorkspace};

/// `team_ai_limits` as the reader sees it. `None` = that limit is not set. A stored value the
/// settings door would refuse (a hand edit: `0`, a negative, a string) reads as **absent**, never
/// as some other limit — the door is where a limit is written, and it only writes real ones.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TeamAiLimits {
    pub daily_tokens: Option<i64>,
    pub daily_searches: Option<i64>,
    /// Micro-dollars (`monthlyUsd` × 1,000,000, rounded), the unit the ledger's cost is counted in.
    pub monthly_micro_usd: Option<i64>,
}

impl TeamAiLimits {
    pub fn from_settings(settings: &Value) -> TeamAiLimits {
        let Some(limits) = settings
            .get(TEAM_AI_LIMITS_SETTING)
            .and_then(Value::as_object)
        else {
            return TeamAiLimits::default();
        };
        let count = |field: &str| {
            limits
                .get(field)
                .and_then(Value::as_i64)
                .filter(|count| *count >= 1)
        };
        TeamAiLimits {
            daily_tokens: count(TEAM_AI_LIMIT_DAILY_TOKENS),
            daily_searches: count(TEAM_AI_LIMIT_DAILY_SEARCHES),
            monthly_micro_usd: limits
                .get(TEAM_AI_LIMIT_MONTHLY_USD)
                .filter(|value| valid_limit_usd(value))
                .and_then(Value::as_f64)
                .map(usd_to_micro)
                .filter(|micro| *micro >= 1),
        }
    }

    pub fn is_unlimited(&self) -> bool {
        *self == TeamAiLimits::default()
    }

    /// `monthlyUsd` as the dollars the administrator typed (micro-dollars ÷ 1,000,000).
    pub fn monthly_usd(&self) -> Option<f64> {
        self.monthly_micro_usd
            .map(|micro| micro as f64 / 1_000_000.0)
    }
}

/// Dollars → micro-dollars, rounded to the nearest.
pub fn usd_to_micro(usd: f64) -> i64 {
    (usd * 1_000_000.0).round() as i64
}

/// The operator's ceilings, from the env. Each field: `None` = no ceiling (unset or empty),
/// `Some(0)` = the emergency switch, `Some(n)` = a ceiling of `n` per UTC day.
///
/// The two `0`s are **not** the same switch, and neither changed with #4944: a token cap of `0`
/// turns the helper off (every request falls back at once), a search cap of `0` only withholds web
/// search (the helper still answers).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct OperatorCaps {
    pub daily_tokens: Option<i64>,
    pub daily_searches: Option<i64>,
}

impl OperatorCaps {
    /// The token ceiling as a positive number, if there is one (`0` is the switch, not a number).
    pub fn token_ceiling(&self) -> Option<i64> {
        self.daily_tokens.filter(|cap| *cap > 0)
    }

    pub fn search_ceiling(&self) -> Option<i64> {
        self.daily_searches.filter(|cap| *cap > 0)
    }

    /// The emergency switch: `TEAM_AI_DAILY_TOKEN_CAP=0`.
    pub fn helper_off(&self) -> bool {
        self.daily_tokens == Some(0)
    }

    /// `TEAM_AI_DAILY_SEARCH_CAP=0`: no web search for anybody.
    pub fn search_off(&self) -> bool {
        self.daily_searches == Some(0)
    }
}

/// An operator ceiling variable that is not a whole number.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperatorCapInvalid(pub &'static str);

impl std::fmt::Display for OperatorCapInvalid {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{} must be a whole number (empty = no ceiling, 0 = off)",
            self.0
        )
    }
}

impl std::error::Error for OperatorCapInvalid {}

/// One rule for both processes (the worker enforces, the api explains): `None` or blank = no
/// ceiling; a whole number is the ceiling; a negative one reads as `0` (off — the side that fails
/// visibly, as it always did); anything else is an error the caller decides how to treat.
pub fn parse_operator_cap(
    key: &'static str,
    raw: Option<&str>,
) -> Result<Option<i64>, OperatorCapInvalid> {
    let Some(raw) = raw.map(str::trim).filter(|raw| !raw.is_empty()) else {
        return Ok(None);
    };
    raw.parse::<i64>()
        .map(|cap| Some(cap.max(0)))
        .map_err(|_| OperatorCapInvalid(key))
}

/// The cap that applies once the workspace's own limit and the operator's ceiling are both taken
/// into account: the lower of the two that exist. `None` = unlimited.
pub fn effective_cap(workspace: Option<i64>, ceiling: Option<i64>) -> Option<i64> {
    match (workspace, ceiling) {
        (Some(workspace), Some(ceiling)) => Some(workspace.min(ceiling)),
        (Some(cap), None) | (None, Some(cap)) => Some(cap),
        (None, None) => None,
    }
}

/// The web-search allowance per UTC day for this turn: `None` = no cap. `Some(0)` is the
/// operator's search switch (today's count is always `>=` it).
pub fn search_cap(limits: &TeamAiLimits, caps: &OperatorCaps) -> Option<i64> {
    effective_cap(limits.daily_searches, caps.daily_searches)
}

/// What a turn has used so far, read before the model is asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Usage {
    pub tokens_today: i64,
    pub month_micro_usd: i64,
}

/// Which limit stopped a turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LimitHit {
    /// `TEAM_AI_DAILY_TOKEN_CAP=0` — the operator switched the helper off.
    OperatorOff,
    /// The operator's daily token ceiling is used up (the workspace cannot raise it).
    OperatorDay,
    /// The workspace's own `dailyTokens`.
    TeamDay,
    /// The workspace's own `monthlyUsd`.
    TeamMonth,
}

/// B9-2: the sentence of a limit the **team** set — the administrator can change it.
pub const TEAM_LIMIT_SENTENCE: &str =
    "팀이 정한 사용량을 다 썼어요. 관리자가 설정 › AI에서 바꿀 수 있어요.";
/// The operator's ceiling stopped the call. Telling the administrator to change a setting would be
/// false — no workspace value gets past a ceiling — so this says whose limit it is.
pub const OPERATOR_LIMIT_SENTENCE: &str =
    "서버 운영자가 정한 하루 사용량을 다 썼어요. 내일 다시 쓸 수 있어요.";
/// `TEAM_AI_DAILY_TOKEN_CAP=0`.
pub const OPERATOR_OFF_SENTENCE: &str = "서버 운영자가 팀 AI를 멈춰 뒀어요.";

impl LimitHit {
    pub fn sentence(self) -> &'static str {
        match self {
            LimitHit::TeamDay | LimitHit::TeamMonth => TEAM_LIMIT_SENTENCE,
            LimitHit::OperatorDay => OPERATOR_LIMIT_SENTENCE,
            LimitHit::OperatorOff => OPERATOR_OFF_SENTENCE,
        }
    }

    /// The same limit said **in the middle of a task** (B9-2 「작업 중에 닿으면 그 시점의 노트로 중간
    /// 보고」, B5-5): it names whose limit it is exactly as [`Self::sentence`] does (a team limit
    /// points at the settings, an operator's does not), and ends like every interim report — what
    /// follows is the note, the one thing that survives.
    pub fn task_sentence(self) -> &'static str {
        match self {
            LimitHit::TeamDay | LimitHit::TeamMonth => {
                "팀이 정한 사용량을 다 써서 여기서 멈췄어요. 관리자가 설정 › AI에서 바꿀 수 있어요. 지금까지 정리한 내용이에요."
            }
            LimitHit::OperatorDay => {
                "서버 운영자가 정한 하루 사용량을 다 써서 여기서 멈췄어요. 지금까지 정리한 내용이에요."
            }
            LimitHit::OperatorOff => {
                "서버 운영자가 팀 AI를 멈춰 둔 상태라서 작업도 여기서 멈췄어요. 지금까지 정리한 내용이에요."
            }
        }
    }

    /// Whose limit: `team` (the administrator's) or `operator` (the server's).
    pub fn source(self) -> &'static str {
        match self {
            LimitHit::TeamDay | LimitHit::TeamMonth => "team",
            LimitHit::OperatorDay | LimitHit::OperatorOff => "operator",
        }
    }

    /// Which window: `day`, `month`, or `off` (the emergency switch has no window).
    pub fn window(self) -> &'static str {
        match self {
            LimitHit::TeamDay | LimitHit::OperatorDay => "day",
            LimitHit::TeamMonth => "month",
            LimitHit::OperatorOff => "off",
        }
    }
}

/// Judge a turn **before the model is asked**. `None` = go ahead.
///
/// The order is the point: the operator's switch and ceiling come first, because a ceiling is
/// "regardless of the workspace's value" (B9-3) and, when it is what binds, the administrator's
/// own limit is not the thing to point at. With nothing set anywhere this is always `None` — a
/// team that never opened the settings is never stopped by a number somebody else chose.
pub fn judge(limits: &TeamAiLimits, caps: &OperatorCaps, usage: &Usage) -> Option<LimitHit> {
    if caps.helper_off() {
        return Some(LimitHit::OperatorOff);
    }
    if let Some(ceiling) = caps.token_ceiling() {
        if usage.tokens_today >= ceiling {
            return Some(LimitHit::OperatorDay);
        }
    }
    if let Some(cap) = limits.daily_tokens {
        if usage.tokens_today >= cap {
            return Some(LimitHit::TeamDay);
        }
    }
    if let Some(cap) = limits.monthly_micro_usd {
        if usage.month_micro_usd >= cap {
            return Some(LimitHit::TeamMonth);
        }
    }
    None
}

/// `message.props` of the line a limit produces: the ordinary 「맡기기」 hand-off
/// ([`team_ai::fallback_props`], reason `over_budget` — a code every client already knows) plus
/// `limit: {source, window}` so a screen can say whose limit and which window. Additive: a client
/// that has never heard of `limit` reads the same line it always did.
pub fn limit_fallback_props(
    hit: LimitHit,
    team_ai_member_id: Uuid,
    requester: Uuid,
    source_message_id: Option<Uuid>,
    candidates: &[(Uuid, String, String)],
) -> Value {
    let mut props = team_ai::fallback_props(
        FallbackReason::OverBudget,
        team_ai_member_id,
        requester,
        source_message_id,
        candidates,
    );
    if let Some(object) = props.as_object_mut() {
        object.insert(
            "limit".to_string(),
            json!({"source": hit.source(), "window": hit.window()}),
        );
    }
    props
}

/// Can a monthly dollar limit be switched on for this team AI? A limit that can never trigger is
/// worse than none (B9-2: no price, no dollar limit), and the model the helper will run on is not
/// readable from a tenant transaction — the 「기본 AI」 row is instance-global — so this reads what
/// it **last ran on** from the ledger and asks whether that model has a price.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsdAvailability {
    Available,
    /// The helper's last request ran on a model with no `model_pricing` row.
    ModelUnpriced,
    /// The helper has never been charged for a request: there is no model to ask about yet.
    NoUsageYet,
}

impl UsdAvailability {
    pub fn is_available(self) -> bool {
        self == UsdAvailability::Available
    }

    pub fn reason(self) -> Option<&'static str> {
        match self {
            UsdAvailability::Available => None,
            UsdAvailability::ModelUnpriced => Some("model_unpriced"),
            UsdAvailability::NoUsageYet => Some("no_usage_yet"),
        }
    }
}

pub async fn monthly_usd_availability_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    helper_member_id: Option<Uuid>,
) -> Result<UsdAvailability, DbError> {
    let Some(agent) = helper_member_id else {
        return Ok(UsdAvailability::NoUsageYet);
    };
    let Some(model) = latest_ledger_model_in_tx(conn, workspace_id, agent).await? else {
        return Ok(UsdAvailability::NoUsageYet);
    };
    Ok(
        if pricing_available_for_model_in_tx(conn, workspace_id, &model).await? {
            UsdAvailability::Available
        } else {
            UsdAvailability::ModelUnpriced
        },
    )
}

/// The month's list-price spend, read only when a monthly limit is set — a team with no dollar
/// limit never pays for the pricing statement on every turn.
pub async fn month_spend_if_limited_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    limits: &TeamAiLimits,
) -> Result<AgentMonthSpend, DbError> {
    if limits.monthly_micro_usd.is_none() {
        return Ok(AgentMonthSpend::default());
    }
    agent_month_spend_in_tx(conn, workspace_id, agent_member_id).await
}

/// What the settings screen reads (B9-4) — the limits as set, the cap that actually applies after
/// the operator's ceiling, the ceiling itself, today's and this month's usage, and whether a
/// dollar limit can be switched on. Computed, never stored: it rides the settings GET/PATCH under
/// `team_ai_limits_status` when asked for, and is not a PATCH-able key.
///
/// **Only a boolean says whether the model is priced — never the model's name.**
pub async fn limits_status_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    caps: &OperatorCaps,
) -> Result<Value, DbError> {
    let settings: Option<Value> =
        sqlx::query_scalar("SELECT settings FROM workspace WHERE id = $1")
            .bind(workspace_id)
            .fetch_optional(&mut *conn)
            .await?;
    let state = settings
        .as_ref()
        .map(TeamAiWorkspace::from_settings)
        .unwrap_or_default();
    let limits = state.limits;
    let (tokens_today, searches_today, month) = match state.member_id {
        Some(agent) => (
            team_ai::tokens_used_today_in_tx(conn, workspace_id, agent).await?,
            team_ai::searches_used_today_in_tx(conn, workspace_id, agent).await?,
            agent_month_spend_in_tx(conn, workspace_id, agent).await?,
        ),
        None => (0, 0, AgentMonthSpend::default()),
    };
    let availability = monthly_usd_availability_in_tx(conn, workspace_id, state.member_id).await?;
    let (day_resets_at_ms, month_resets_at_ms): (i64, i64) = sqlx::query_as(
        "SELECT \
           floor(extract(epoch FROM ((date_trunc('day', now() AT TIME ZONE 'UTC') \
                                      + interval '1 day') AT TIME ZONE 'UTC')) * 1000)::bigint, \
           floor(extract(epoch FROM ((date_trunc('month', now() AT TIME ZONE 'UTC') \
                                      + interval '1 month') AT TIME ZONE 'UTC')) * 1000)::bigint",
    )
    .fetch_one(&mut *conn)
    .await?;
    Ok(json!({
        "limits": {
            "dailyTokens": limits.daily_tokens,
            "dailySearches": limits.daily_searches,
            "monthlyUsd": limits.monthly_usd(),
        },
        "effective": {
            "dailyTokens": effective_cap(limits.daily_tokens, caps.daily_tokens),
            "dailySearches": search_cap(&limits, caps),
        },
        "operatorCeiling": {
            "dailyTokens": caps.token_ceiling(),
            "dailySearches": caps.search_ceiling(),
            "helperOff": caps.helper_off(),
            "searchOff": caps.search_off(),
        },
        "usage": {
            "todayTokens": tokens_today,
            "todaySearches": searches_today,
            "monthCostMicroUsd": month.cost_micro_usd,
            "monthRuns": month.runs,
            "monthUnpricedRuns": month.unpriced_runs,
            "monthEstimatedRuns": month.estimated_runs,
        },
        "monthlyUsdAvailable": availability.is_available(),
        "monthlyUsdUnavailableReason": availability.reason(),
        "dayResetsAtMs": day_resets_at_ms,
        "monthResetsAtMs": month_resets_at_ms,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(tokens_today: i64, month_micro_usd: i64) -> Usage {
        Usage {
            tokens_today,
            month_micro_usd,
        }
    }

    /// B9-1: nothing set, nothing in the env — whatever the usage, nothing stops a turn.
    #[test]
    fn with_no_limit_and_no_ceiling_nothing_ever_stops_a_turn() {
        let unlimited = TeamAiLimits::default();
        let none = OperatorCaps::default();
        assert!(unlimited.is_unlimited());
        assert_eq!(judge(&unlimited, &none, &usage(0, 0)), None);
        assert_eq!(
            judge(&unlimited, &none, &usage(i64::MAX, i64::MAX)),
            None,
            "the old 200,000 is gone"
        );
        assert_eq!(search_cap(&unlimited, &none), None);
    }

    #[test]
    fn a_workspace_limit_stops_a_turn_at_the_limit_and_not_before() {
        let tokens = TeamAiLimits {
            daily_tokens: Some(1_000),
            ..TeamAiLimits::default()
        };
        let none = OperatorCaps::default();
        assert_eq!(judge(&tokens, &none, &usage(999, 0)), None);
        assert_eq!(
            judge(&tokens, &none, &usage(1_000, 0)),
            Some(LimitHit::TeamDay)
        );
        let usd = TeamAiLimits {
            monthly_micro_usd: Some(5_000_000),
            ..TeamAiLimits::default()
        };
        assert_eq!(judge(&usd, &none, &usage(u32::MAX as i64, 4_999_999)), None);
        assert_eq!(
            judge(&usd, &none, &usage(0, 5_000_000)),
            Some(LimitHit::TeamMonth)
        );
    }

    /// B9-3: a positive operator ceiling wins whatever the workspace set, and says it is the
    /// operator's. `0` is the emergency switch and beats everything.
    #[test]
    fn the_operator_ceiling_beats_the_workspace_value_and_zero_is_the_switch() {
        let roomy = TeamAiLimits {
            daily_tokens: Some(10_000_000),
            ..TeamAiLimits::default()
        };
        let ceiling = OperatorCaps {
            daily_tokens: Some(1_000),
            ..OperatorCaps::default()
        };
        assert_eq!(judge(&roomy, &ceiling, &usage(999, 0)), None);
        assert_eq!(
            judge(&roomy, &ceiling, &usage(1_000, 0)),
            Some(LimitHit::OperatorDay),
            "the workspace's 10,000,000 does not lift the operator's 1,000"
        );
        let tight = TeamAiLimits {
            daily_tokens: Some(500),
            ..TeamAiLimits::default()
        };
        assert_eq!(
            judge(&tight, &ceiling, &usage(600, 0)),
            Some(LimitHit::TeamDay),
            "a workspace limit below the ceiling is the one that binds"
        );
        assert_eq!(
            judge(
                &TeamAiLimits::default(),
                &OperatorCaps {
                    daily_tokens: Some(0),
                    ..OperatorCaps::default()
                },
                &usage(0, 0)
            ),
            Some(LimitHit::OperatorOff)
        );
        assert_eq!(
            effective_cap(Some(10_000_000), Some(1_000)),
            Some(1_000),
            "the lower of the two"
        );
        assert_eq!(effective_cap(Some(5), None), Some(5));
        assert_eq!(effective_cap(None, Some(7)), Some(7));
        assert_eq!(effective_cap(None, None), None);
    }

    /// The search switch is not the helper's: `0` withholds search, it does not stop the turn.
    #[test]
    fn a_search_cap_of_zero_is_a_search_switch_not_a_helper_switch() {
        let off = OperatorCaps {
            daily_searches: Some(0),
            ..OperatorCaps::default()
        };
        assert!(off.search_off());
        assert!(!off.helper_off());
        assert_eq!(judge(&TeamAiLimits::default(), &off, &usage(0, 0)), None);
        assert_eq!(search_cap(&TeamAiLimits::default(), &off), Some(0));
        let both = TeamAiLimits {
            daily_searches: Some(30),
            ..TeamAiLimits::default()
        };
        let ceiling = OperatorCaps {
            daily_searches: Some(10),
            ..OperatorCaps::default()
        };
        assert_eq!(search_cap(&both, &ceiling), Some(10));
    }

    /// B9-3 + the rule both processes share.
    #[test]
    fn an_empty_operator_variable_is_no_ceiling_and_zero_is_off() {
        assert_eq!(parse_operator_cap("K", None), Ok(None));
        assert_eq!(parse_operator_cap("K", Some("")), Ok(None));
        assert_eq!(parse_operator_cap("K", Some("   ")), Ok(None));
        assert_eq!(parse_operator_cap("K", Some("0")), Ok(Some(0)));
        assert_eq!(parse_operator_cap("K", Some(" 250000 ")), Ok(Some(250_000)));
        assert_eq!(
            parse_operator_cap("K", Some("-5")),
            Ok(Some(0)),
            "a negative reads as off, the side that fails visibly"
        );
        assert_eq!(
            parse_operator_cap("TEAM_AI_DAILY_TOKEN_CAP", Some("200k")),
            Err(OperatorCapInvalid("TEAM_AI_DAILY_TOKEN_CAP"))
        );
        assert_eq!(
            parse_operator_cap("K", Some("1.5")),
            Err(OperatorCapInvalid("K"))
        );
    }

    #[test]
    fn stored_limits_are_read_as_set_and_a_value_the_door_would_refuse_reads_as_absent() {
        let limits = TeamAiLimits::from_settings(&json!({
            "team_ai_limits": {"dailyTokens": 500000, "dailySearches": 20, "monthlyUsd": 12.5}
        }));
        assert_eq!(limits.daily_tokens, Some(500_000));
        assert_eq!(limits.daily_searches, Some(20));
        assert_eq!(limits.monthly_micro_usd, Some(12_500_000));
        assert_eq!(limits.monthly_usd(), Some(12.5));
        for stored in [
            json!({}),
            json!({"team_ai_limits": null}),
            json!({"team_ai_limits": "lots"}),
            json!({"team_ai_limits": {"dailyTokens": 0, "dailySearches": -3, "monthlyUsd": 0}}),
            json!({"team_ai_limits": {"dailyTokens": "9", "dailySearches": 1.5, "monthlyUsd": "9"}}),
            json!({"team_ai_limits": {"dailyTokens": true, "monthlyUsd": null}}),
        ] {
            assert!(
                TeamAiLimits::from_settings(&stored).is_unlimited(),
                "{stored} must read as no limit"
            );
        }
    }

    #[test]
    fn a_limit_line_carries_whose_limit_and_which_window() {
        let (agent, requester) = (Uuid::from_u128(1), Uuid::from_u128(2));
        for (hit, source, window, sentence) in [
            (LimitHit::TeamDay, "team", "day", TEAM_LIMIT_SENTENCE),
            (LimitHit::TeamMonth, "team", "month", TEAM_LIMIT_SENTENCE),
            (
                LimitHit::OperatorDay,
                "operator",
                "day",
                OPERATOR_LIMIT_SENTENCE,
            ),
            (
                LimitHit::OperatorOff,
                "operator",
                "off",
                OPERATOR_OFF_SENTENCE,
            ),
        ] {
            let props = limit_fallback_props(hit, agent, requester, None, &[]);
            assert_eq!(props["reason"], "over_budget");
            assert_eq!(props["kind"], "team_ai.delegate.v1");
            assert_eq!(props["limit"], json!({"source": source, "window": window}));
            assert_eq!(hit.sentence(), sentence);
        }
        assert_eq!(
            TEAM_LIMIT_SENTENCE,
            "팀이 정한 사용량을 다 썼어요. 관리자가 설정 › AI에서 바꿀 수 있어요."
        );
    }
}
