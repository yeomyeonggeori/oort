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
    valid_daily_delegations, valid_limit_usd, DEFAULT_TEAM_AI_DAILY_DELEGATIONS,
    TEAM_AI_LIMITS_SETTING, TEAM_AI_LIMIT_DAILY_DELEGATIONS, TEAM_AI_LIMIT_DAILY_SEARCHES,
    TEAM_AI_LIMIT_DAILY_TOKENS, TEAM_AI_LIMIT_MONTHLY_USD,
};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::team_ai::{self, FallbackReason, TeamAiWorkspace};
use crate::team_ai_hermes;

/// `team_ai_limits` as the reader sees it. `None` = that limit is not set. A stored value the
/// settings door would refuse (a hand edit: `0`, a negative, a string) reads as **absent**, never
/// as some other limit — the door is where a limit is written, and it only writes real ones.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TeamAiLimits {
    pub daily_tokens: Option<i64>,
    pub daily_searches: Option<i64>,
    /// Micro-dollars (`monthlyUsd` × 1,000,000, rounded), the unit the ledger's cost is counted in.
    pub monthly_micro_usd: Option<i64>,
    /// `dailyDelegations` (ADR-0201 증보 v4 P7, #5369): the workspace's own cap on the day's delegations
    /// to the team's Hermes, a whole number in 1..=200. **`None` is not "no limit"** — it is the default
    /// ([`DEFAULT_TEAM_AI_DAILY_DELEGATIONS`]); read it through [`TeamAiLimits::delegation_cap`]. A stored
    /// value the settings door would refuse (`0`, `500`, a string) reads as `None`, never as that number.
    pub daily_delegations: Option<i64>,
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
            daily_delegations: limits
                .get(TEAM_AI_LIMIT_DAILY_DELEGATIONS)
                .filter(|value| valid_daily_delegations(value))
                .and_then(Value::as_i64),
        }
    }

    pub fn is_unlimited(&self) -> bool {
        *self == TeamAiLimits::default()
    }

    /// The workspace's own day cap on delegations to Hermes: what the administrator set, else the
    /// default 30 **[추정]**. Never "none" — the operator's `0` ([`HermesCeiling::Off`]) is what turns
    /// the delegation off, and this is what an administrator lowers or raises under any ceiling.
    pub fn delegation_cap(&self) -> i64 {
        self.daily_delegations
            .unwrap_or(DEFAULT_TEAM_AI_DAILY_DELEGATIONS)
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
    /// `TEAM_AI_HERMES_DAILY_CAP` (ADR-0201 증보 v4 P7, #5369; 증보 2026-11-12 #5685): the per-workspace
    /// ceiling on the day's delegations to Hermes. Its own type so "no ceiling" and "off" cannot be one
    /// `None`: unset or blank (and a default-constructed value) is [`HermesCeiling::NoCeiling`] — the
    /// workspace's own cap (or the default 30) is the cap; `0` is [`HermesCeiling::Off`]; a positive number
    /// is [`HermesCeiling::Ceiling`].
    pub daily_delegations: HermesCeiling,
}

/// `TEAM_AI_HERMES_DAILY_CAP` as one process read it (ADR-0201 증보 2026-11-12, #5685 — owner: unset = no
/// ceiling). Until #5685 an unset value was the closed door; now only an explicit `0` is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum HermesCeiling {
    /// Unset or blank: **no operator ceiling**. The effective day cap is the workspace's `dailyDelegations`,
    /// or the default 30 when it has none — the same shape as the two older ceilings' "unset = no ceiling".
    #[default]
    NoCeiling,
    /// `0` (a negative reads as `0`): the operator switched the delegation **off**. The api also reads a value
    /// it cannot parse as this (the worker refuses to boot on it).
    Off,
    /// A positive per-workspace ceiling no workspace value gets past.
    Ceiling(i64),
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

    /// The delegation ceiling as a positive number, if there is one — like [`Self::token_ceiling`]: `None`
    /// is "no positive ceiling" (unset, or the `0` that [`Self::delegation_off`] names), never "closed".
    pub fn delegation_ceiling(&self) -> Option<i64> {
        match self.daily_delegations {
            HermesCeiling::Ceiling(cap) if cap > 0 => Some(cap),
            _ => None,
        }
    }

    /// `TEAM_AI_HERMES_DAILY_CAP=0`: the operator switched the delegation to Hermes off. The only operator
    /// value that closes it (#5685); unset is no ceiling.
    pub fn delegation_off(&self) -> bool {
        match self.daily_delegations {
            HermesCeiling::Off => true,
            HermesCeiling::Ceiling(cap) => cap <= 0,
            HermesCeiling::NoCeiling => false,
        }
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

/// The day's delegations to Hermes one workspace may make (ADR-0201 증보 2026-11-12, #5685): the
/// workspace's own cap or the default 30, lowered by a positive operator ceiling when there is one —
/// `min(workspace or 30, ceiling)`; with no ceiling (unset, blank) it is the workspace's value or 30.
/// **`None` = closed, and only the operator's `0` gets here** ([`HermesCeiling::Off`]); an unset ceiling
/// never does.
pub fn delegation_cap(limits: &TeamAiLimits, caps: &OperatorCaps) -> Option<i64> {
    if caps.delegation_off() {
        return None;
    }
    let workspace = limits.delegation_cap();
    Some(match caps.delegation_ceiling() {
        Some(ceiling) => workspace.min(ceiling),
        None => workspace,
    })
}

/// `TEAM_AI_HERMES_DAILY_CAP`, read by **one** rule in both processes (#5685): unset or blank =
/// [`HermesCeiling::NoCeiling`]; `0` = [`HermesCeiling::Off`], a negative one reads as `0` (off — the side
/// that fails visibly, as [`parse_operator_cap`] does); a positive whole number = [`HermesCeiling::Ceiling`];
/// anything else (`ten`, `1.5`, `30 `-then-garbage, a unit) is an error the caller decides how to treat — the
/// worker refuses to boot on it like it does for the other two ceilings, the api warns and reads it as
/// [`HermesCeiling::Off`] because it merely explains the number. A number is read exactly as
/// [`parse_operator_cap`] reads it.
pub fn parse_hermes_cap(raw: Option<&str>) -> Result<HermesCeiling, OperatorCapInvalid> {
    Ok(match parse_operator_cap(HERMES_CAP_ENV, raw)? {
        None => HermesCeiling::NoCeiling,
        Some(cap) if cap > 0 => HermesCeiling::Ceiling(cap),
        Some(_) => HermesCeiling::Off,
    })
}

/// The variable behind [`parse_hermes_cap`].
pub const HERMES_CAP_ENV: &str = "TEAM_AI_HERMES_DAILY_CAP";

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

/// The two facts of the delegation door that are this **process's**, not the database's (ADR-0201 증보 v4
/// P8, #5374): G4's three declarations as the api reads them and whether an `operator_env` pin resolves
/// here (G5, [`team_ai_hermes::operator_env_pin_resolves`]). The api only explains; the worker enforces
/// with its own copy of the same variables. Default = nothing declared, nothing resolves (closed).
#[derive(Debug, Clone, Default)]
pub struct DelegationProcessFacts {
    pub declarations: team_ai_hermes::HermesDeclarations,
    pub env_pin_resolves: bool,
}

/// What the settings screen reads (B9-4) — the limits as set, the cap that actually applies after
/// the operator's ceiling, the ceiling itself, today's and this month's usage, and whether a
/// dollar limit can be switched on. Computed, never stored: it rides the settings GET/PATCH under
/// `team_ai_limits_status` when asked for, and is not a PATCH-able key.
///
/// **The delegation to Hermes** (ADR-0201 증보 v4 P7·P8, #5374) rides the same objects under the setting's
/// own name: `limits.dailyDelegations` (what the administrator set; `null` = the default 30, never "no
/// limit"), `effective.dailyDelegations` (`that or 30`, lowered by a positive ceiling; `0` = **closed**, the
/// operator's `0` — an unset ceiling is no ceiling since #5685), `operatorCeiling.dailyDelegations` (the
/// positive ceiling, else `null`) with `operatorCeiling.delegationOff` (the operator's `0`, like `helperOff`
/// and `searchOff`), `usage.todayDelegations` (delegations at
/// or past `called` today — the counters' own source, the task row's marker), and the door's workspace half:
/// `delegationAvailable` + `delegationUnavailableReason` (one closed word of the door, `null` when open —
/// [`team_ai_hermes::SettingsDoorFacts::closed`]).
///
/// **Only a boolean says whether the model is priced — never the model's name.** Nothing about the
/// delegation names a member or an agent either: the reason is a closed word.
pub async fn limits_status_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    caps: &OperatorCaps,
    process: &DelegationProcessFacts,
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
    // P7: the day's delegations are counted from the task row's marker (`called` or later, the UTC day of
    // `delegation_called_at`) — the same read the door's G6 and the `called` commit judge by. The requester
    // and the window only shape the two other counts, which this read does not show.
    let today_delegations =
        momo_agent::team_ai_task::delegation_counts_in_tx(conn, workspace_id, Uuid::nil(), 0)
            .await?
            .today;
    let day_delegation_cap = delegation_cap(&limits, caps);
    // G3 for the team: the helper (if it exists yet) is never a Hermes; no member has the nil id.
    let pinned = team_ai_hermes::pinned_agents_in_tx(
        conn,
        workspace_id,
        state.member_id.unwrap_or_else(Uuid::nil),
    )
    .await?;
    let delegation_closed = team_ai_hermes::SettingsDoorFacts {
        target: team_ai_hermes::resolve_team_target(&pinned),
        declarations: process.declarations.clone(),
        pin_resolves: process.env_pin_resolves,
        day_cap: day_delegation_cap,
        today: today_delegations,
    }
    .closed();
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
            "dailyDelegations": limits.daily_delegations,
        },
        "effective": {
            "dailyTokens": effective_cap(limits.daily_tokens, caps.daily_tokens),
            "dailySearches": search_cap(&limits, caps),
            // never "none": the delegation always has a cap, and `0` is the closed door
            "dailyDelegations": day_delegation_cap.unwrap_or(0),
        },
        "operatorCeiling": {
            "dailyTokens": caps.token_ceiling(),
            "dailySearches": caps.search_ceiling(),
            "helperOff": caps.helper_off(),
            "searchOff": caps.search_off(),
            "dailyDelegations": caps.delegation_ceiling(),
            "delegationOff": caps.delegation_off(),
        },
        "usage": {
            "todayTokens": tokens_today,
            "todaySearches": searches_today,
            "monthCostMicroUsd": month.cost_micro_usd,
            "monthRuns": month.runs,
            "monthUnpricedRuns": month.unpriced_runs,
            "monthEstimatedRuns": month.estimated_runs,
            "todayDelegations": today_delegations,
        },
        "monthlyUsdAvailable": availability.is_available(),
        "monthlyUsdUnavailableReason": availability.reason(),
        "delegationAvailable": delegation_closed.is_none(),
        "delegationUnavailableReason": delegation_closed.map(team_ai_hermes::DoorClosed::word),
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

    /// ADR-0201 증보 2026-11-12 (#5685): the operator's ceiling unset (or blank) is **no ceiling** — the
    /// cap is the workspace's own value, or the default 30 (never "no limit"). Only the operator's `0` is
    /// closed; a positive ceiling lowers the cap to `min(workspace or 30, ceiling)`. Every branch of that
    /// sentence is measured on its own.
    #[test]
    fn the_delegation_cap_is_the_workspace_value_without_a_ceiling_closed_only_by_zero() {
        let default = TeamAiLimits::default();
        let admin = |n: i64| TeamAiLimits {
            daily_delegations: Some(n),
            ..TeamAiLimits::default()
        };
        let ceiling = |c: HermesCeiling| OperatorCaps {
            daily_delegations: c,
            ..OperatorCaps::default()
        };
        // NO CEILING (unset, the default value): the workspace's value or 30 — open, never unlimited
        assert_eq!(
            OperatorCaps::default().daily_delegations,
            HermesCeiling::NoCeiling
        );
        assert_eq!(OperatorCaps::default().delegation_ceiling(), None);
        assert!(!OperatorCaps::default().delegation_off());
        assert_eq!(delegation_cap(&default, &OperatorCaps::default()), Some(30));
        assert_eq!(
            delegation_cap(&admin(200), &ceiling(HermesCeiling::NoCeiling)),
            Some(200)
        );
        assert_eq!(
            delegation_cap(&admin(1), &ceiling(HermesCeiling::NoCeiling)),
            Some(1)
        );
        // CLOSED: only the operator's `0`, whatever the administrator asked for
        assert!(ceiling(HermesCeiling::Off).delegation_off());
        assert_eq!(delegation_cap(&default, &ceiling(HermesCeiling::Off)), None);
        assert_eq!(
            delegation_cap(&admin(200), &ceiling(HermesCeiling::Off)),
            None
        );
        // a positive ceiling only lowers it; the workspace's default is 30
        assert_eq!(
            delegation_cap(&default, &ceiling(HermesCeiling::Ceiling(1000))),
            Some(30)
        );
        assert_eq!(
            delegation_cap(&default, &ceiling(HermesCeiling::Ceiling(10))),
            Some(10)
        );
        // an administrator may raise it up to the ceiling and no further
        assert_eq!(
            delegation_cap(&admin(100), &ceiling(HermesCeiling::Ceiling(1000))),
            Some(100)
        );
        assert_eq!(
            delegation_cap(&admin(100), &ceiling(HermesCeiling::Ceiling(50))),
            Some(50)
        );
        assert_eq!(
            delegation_cap(&admin(5), &ceiling(HermesCeiling::Ceiling(50))),
            Some(5)
        );
        assert!(!ceiling(HermesCeiling::Ceiling(50)).delegation_off());
        // `delegation_cap()` itself never says "none": absent is the default
        assert_eq!(default.delegation_cap(), 30);
        assert_eq!(admin(7).delegation_cap(), 7);
        // the two older ceilings are untouched: `None` there is still "no ceiling"
        assert_eq!(OperatorCaps::default().token_ceiling(), None);
        assert!(!OperatorCaps::default().helper_off());
        assert!(!OperatorCaps::default().search_off());
    }

    /// RL4 (review, ADR-0201 증보 v4) + #5685: `TEAM_AI_HERMES_DAILY_CAP` is read by one rule. Unset and
    /// blank are no ceiling, `0` is off (a negative reads as `0`), a positive whole number is the ceiling,
    /// and anything that is not a whole number is an error — never a number somebody else's parser would
    /// have guessed (`ten`, `1.5`, `10x`, `1e2`, `0x10`).
    #[test]
    fn the_hermes_cap_value_is_a_whole_number_and_anything_else_is_refused_by_name() {
        for (raw, expected) in [
            (None, HermesCeiling::NoCeiling),
            (Some(""), HermesCeiling::NoCeiling),
            (Some("   "), HermesCeiling::NoCeiling),
            (Some("0"), HermesCeiling::Off),
            (Some("-5"), HermesCeiling::Off),
            (Some("30"), HermesCeiling::Ceiling(30)),
            (Some(" 30 "), HermesCeiling::Ceiling(30)),
            (Some("+30"), HermesCeiling::Ceiling(30)),
        ] {
            assert_eq!(parse_hermes_cap(raw), Ok(expected), "{raw:?}");
        }
        for bad in [
            "ten", "1.5", "10x", "1e2", "0x10", "30,50", "٣٠", "NaN", "∞", "30 40",
        ] {
            assert_eq!(
                parse_hermes_cap(Some(bad)),
                Err(OperatorCapInvalid(HERMES_CAP_ENV)),
                "{bad:?}"
            );
        }
        // the five cases of #5685, read into the cap both processes judge by (no workspace value set)
        let cap = |raw| {
            delegation_cap(
                &TeamAiLimits::default(),
                &OperatorCaps {
                    daily_delegations: parse_hermes_cap(raw).unwrap(),
                    ..OperatorCaps::default()
                },
            )
        };
        assert_eq!(cap(None), Some(30), "unset: no ceiling, the default 30");
        assert_eq!(cap(Some("")), Some(30), "blank: no ceiling, the default 30");
        assert_eq!(cap(Some("0")), None, "0: off");
        assert_eq!(cap(Some("-5")), None, "a negative: off");
        assert_eq!(
            cap(Some("12")),
            Some(12),
            "a positive ceiling lowers the 30"
        );
    }

    /// `dailyDelegations` as the reader sees it: only a value the settings door would accept is a
    /// value; a hand edit (`0`, `201`, a string, a float) reads as absent = the default, never as the
    /// number that was typed.
    #[test]
    fn a_stored_daily_delegations_the_door_would_refuse_reads_as_the_default() {
        let read = |value: Value| {
            TeamAiLimits::from_settings(&json!({"team_ai_limits": {"dailyDelegations": value}}))
        };
        assert_eq!(read(json!(1)).delegation_cap(), 1);
        assert_eq!(read(json!(200)).delegation_cap(), 200);
        for bad in [
            json!(0),
            json!(-3),
            json!(201),
            json!(5000),
            json!("9"),
            json!(9.5),
            json!(true),
            Value::Null,
        ] {
            let limits = read(bad.clone());
            assert_eq!(limits.daily_delegations, None, "{bad}");
            assert_eq!(limits.delegation_cap(), 30, "{bad}");
        }
        // the other three fields still read as they did
        let all = TeamAiLimits::from_settings(&json!({"team_ai_limits": {
            "dailyTokens": 10, "dailySearches": 2, "monthlyUsd": 1.5, "dailyDelegations": 4}}));
        assert_eq!(all.daily_tokens, Some(10));
        assert_eq!(all.daily_searches, Some(2));
        assert_eq!(all.monthly_micro_usd, Some(1_500_000));
        assert_eq!(all.daily_delegations, Some(4));
    }
}
