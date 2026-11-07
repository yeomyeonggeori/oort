//! The team AI's delegation to the team's Hermes — **the door** (ADR-0201 증보 v4 P2, #5369 = P14-S1).
//!
//! The helper answers on the team's own Claude key. A few things it cannot do (a picture; a web search
//! on a wire that cannot search) the team's Hermes can, so the helper may hand **one** request sentence
//! to Hermes through the tool `ask_hermes` and write the answer itself. **This slice builds the door and
//! nothing behind it**: whether the tool is on a request is decided here, in one pure function
//! ([`DoorFacts::judge`]) over ten gates; what happens when it is called is `unavailable` — Hermes is
//! not called (S2, #5370, does that).
//!
//! ## The ten gates (G1~G10) — the structure, not a prompt request (I3)
//!
//! | gate | open when | closed word ([`DoorClosed::word`]) |
//! |---|---|---|
//! | G1 | the role bundle `hermes` is on | `bundle_off` |
//! | G2 | the requester is a live human with a trigger message, and not a guest | `no_human_requester`, `guest_requester` |
//! | G3 | exactly one Hermes resolves as the target ([`resolve_target`]) | `hermes_not_connected`, `hermes_ambiguous` |
//! | G4 | the operator's declarations ([`HermesDeclarations`]) say so | `tools_not_locked`, `connection_mode` |
//! | G5 | the target's `operator_env` pin resolves (link and key configured) | `pin_unresolved` |
//! | G6 | the limits have room ([`judge_limits`]) | `ceiling_unset`, `daily_cap`, `rate_limited`, `busy`, `tasks_busy` |
//! | G7 | the request has read nothing yet | `already_read` |
//! | G8 | the trigger does not mention Hermes itself | `direct_mention` |
//! | G9 | this is the first turn, not a task step | `task_step` |
//! | G10 | nothing has been delegated in this request yet | `already_delegated` |
//!
//! When all ten are open **and** a kind can be offered, the verdict is [`DoorVerdict::Open`] with the kinds.
//! The evaluation order is the table's, so the closed word names the first gate that is shut; a test flips
//! each gate alone and counts what the tool list holds.
//!
//! ## G4 — the operator's declaration, and why the worker reads it (K-S2 flipped)
//!
//! The door opens only when `OORT_COHOSTED_AGENT_TOOLS_LOCKED` is true (the rule the api reads it by:
//! `1`/`true`/`yes`/`on`) **and** neither connection-mode declaration holds a **non-empty value**
//! (`OORT_COHOSTED_AGENT_CONNECTORS_LOCKED`, `OORT_COHOSTED_AGENT_CONNECTOR_APPS`). Review RL2: the wording
//! is 「비어 있지 않은 값이 없어야」 everywhere — compose's `${VAR:-}` makes an **empty** variable, which is
//! absent for this purpose; `0` or a malformed list is a value, and shuts the door. The check is on the
//! **presence of a non-empty raw value**, not on what the api's reader parses out of it: that reader turns a
//! malformed app list into an empty list, so a parse-based door would open on a typo (fail-open). The
//! declarations are the operator's own statement (ADR-0203 D6-5), not oort's verification, and the
//! templates give api and worker the same three variables (`scripts/tests/check_railway_catalog.py` and
//! `test_self_host_env_modes.sh` fail when one side differs): that is what makes a connection-mode instance
//! (a Hermes with one person's apps) shut here too.
//!
//! ## What is closed by default in production (사용자 영향 0)
//!
//! The operator's per-workspace ceiling (`TEAM_AI_HERMES_DAILY_CAP`) is **unset = closed**; the kind
//! declarations are unset = no kind; the image path is a constant that is `false` until S4. A deployment of
//! this slice therefore opens nothing by itself.

use momo_agent::connector_trial::{
    ConnectorTrialAttest, ENV_CONNECTORS_LOCKED, ENV_CONNECTOR_APPS,
};
use momo_agent::subscription::{owner_only_gate, OwnerOnlyScope, SubscriptionHarness};
use momo_agent::team_ai_roles::{TeamAiRoles, HERMES};
use momo_agent::tools::ASK_HERMES;
use momo_db::{DbError, PgConnection};
use sqlx::Row;
use uuid::Uuid;

use crate::team_ai::WebSearch;

/// `OORT_COHOSTED_AGENT_IMAGE_TOOL`: the operator's statement that the Hermes behind the worker can
/// draw a picture (`1`/`true`/`yes`/`on`). Paired with #5334's contract (the picture agent) — the name
/// pair `…_IMAGE_TOOL` / `…_SEARCH_TOOL` is fixed here by P14-S1. Worker-only; unset = not offered.
pub const ENV_IMAGE_TOOL: &str = "OORT_COHOSTED_AGENT_IMAGE_TOOL";
/// `OORT_COHOSTED_AGENT_SEARCH_TOOL`: the same for a web search. Worker-only; unset = not offered.
pub const ENV_SEARCH_TOOL: &str = "OORT_COHOSTED_AGENT_SEARCH_TOOL";

/// **S4 changes this**, and nothing else may (ADR-0201 증보 v4 P6, owner Q1 가): the code can put a
/// picture Hermes drew into an attachment. Until it is `true` the `image` kind is never offered —
/// whatever the operator declared and whether or not `OORT_API_INTERNAL_ORIGIN` is set (A10: the origin
/// is a variable an operator may set for other reasons, and is never this constant's evidence).
pub const ATTACHMENT_WRITE_PATH_READY: bool = false;

/// `audit_log.action` of one delegation (P11): run id, kind, the closed result code, ms, picture bytes,
/// the target agent's id — and **never** the request sentence, the result, a picture or a `MEDIA` line
/// (H9-I10). S1 writes it for the one ending it has (`unavailable`: the call passed every check and nothing
/// sits behind the door yet); S2 writes it for every other ending.
pub const AUDIT_DELEGATE: &str = "team_ai.delegate";
/// The schema string of [`AUDIT_DELEGATE`]'s detail. (Not `team_ai.delegate.v1`: that is the message
/// props kind of the 「맡기기」 hand-off line, a different thing.)
pub const AUDIT_DELEGATE_SCHEMA: &str = "momo.team_ai.delegate.audit.v1";

/// Delegations one requester may start in a rolling ten minutes **[추정]** (P2 G6, P7).
pub const REQUESTER_WINDOW_SECS: i64 = 10 * 60;
pub const REQUESTER_WINDOW_MAX: i64 = 6;
/// Delegations running at once in one workspace **[추정]** (P2 G6).
pub const CONCURRENT_MAX: i64 = 2;

/// One kind of work the helper may delegate (P1: a closed enum).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HermesKind {
    /// One still picture (P6). Never animated: the subscription path refuses a GIF (F11).
    Image,
    /// A web search, **only** where the helper's own wire cannot search or its non-zero allowance is
    /// spent (P2 「종류 배타」).
    WebSearch,
}

impl HermesKind {
    pub const ALL: [HermesKind; 2] = [HermesKind::Image, HermesKind::WebSearch];

    /// The wire name — the tool's `kind` enum value.
    pub fn as_str(self) -> &'static str {
        match self {
            HermesKind::Image => "image",
            HermesKind::WebSearch => "web_search",
        }
    }

    pub fn parse(raw: &str) -> Option<HermesKind> {
        HermesKind::ALL
            .into_iter()
            .find(|kind| kind.as_str() == raw)
    }
}

// ---------------------------------------------------------------------------
// G4 — the operator's declarations
// ---------------------------------------------------------------------------

/// What the operator declared about the Hermes behind this process (ADR-0201 증보 v4 P2 G4, #5369),
/// read from the **worker's** environment (K-S2 flipped: the worker reads what the api reads).
///
/// The two connection-mode fields are **presence of a non-empty value**, not parsed values — see the
/// module docs. A value of only whitespace is empty (the same blank rule every variable of this worker
/// is read by), `0` is a value.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HermesDeclarations {
    /// `OORT_COHOSTED_AGENT_TOOLS_LOCKED` is true by the api's own rule ([`ConnectorTrialAttest`]).
    pub tools_locked: bool,
    /// `OORT_COHOSTED_AGENT_CONNECTORS_LOCKED` holds a non-empty value (any value, even `0`).
    pub connectors_locked_set: bool,
    /// `OORT_COHOSTED_AGENT_CONNECTOR_APPS` holds a non-empty value (any value, even a malformed list).
    pub connector_apps_set: bool,
    /// `OORT_COHOSTED_AGENT_IMAGE_TOOL` is true.
    pub image_tool: bool,
    /// `OORT_COHOSTED_AGENT_SEARCH_TOOL` is true.
    pub search_tool: bool,
}

impl HermesDeclarations {
    /// Read the declarations through `env` (so a test needs no process environment, and — like
    /// every test of this module — never calls `std::env::set_var`).
    pub fn from_lookup(env: impl Fn(&str) -> Option<String>) -> HermesDeclarations {
        let non_empty = |name: &str| env(name).is_some_and(|value| !value.trim().is_empty());
        let truthy = |name: &str| {
            matches!(
                env(name)
                    .map(|value| value.trim().to_ascii_lowercase())
                    .as_deref(),
                Some("1") | Some("true") | Some("yes") | Some("on")
            )
        };
        HermesDeclarations {
            // the api's reader, so the two processes cannot disagree about what "true" is
            tools_locked: ConnectorTrialAttest::from_env(&env).tools_locked,
            connectors_locked_set: non_empty(ENV_CONNECTORS_LOCKED),
            connector_apps_set: non_empty(ENV_CONNECTOR_APPS),
            image_tool: truthy(ENV_IMAGE_TOOL),
            search_tool: truthy(ENV_SEARCH_TOOL),
        }
    }

    /// Either connection-mode declaration holds a value: this instance is (or claims to be) in
    /// connection mode, a Hermes with one person's apps.
    pub fn connection_mode(&self) -> bool {
        self.connectors_locked_set || self.connector_apps_set
    }

    /// **G4**: the tool lock is declared and no connection-mode declaration holds a value.
    pub fn g4(&self) -> Result<(), AttestProblem> {
        if self.connection_mode() {
            return Err(AttestProblem::ConnectionMode);
        }
        if !self.tools_locked {
            return Err(AttestProblem::ToolsNotLocked);
        }
        Ok(())
    }

    /// Did the operator declare this kind?
    pub fn declares(&self, kind: HermesKind) -> bool {
        match kind {
            HermesKind::Image => self.image_tool,
            HermesKind::WebSearch => self.search_tool,
        }
    }
}

/// Why G4 is shut.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttestProblem {
    /// A connection-mode declaration holds a value: a Hermes with one person's apps is never a
    /// delegation target (T4), whoever asks.
    ConnectionMode,
    /// `OORT_COHOSTED_AGENT_TOOLS_LOCKED` is not true on this process.
    ToolsNotLocked,
}

// ---------------------------------------------------------------------------
// G3 — the target
// ---------------------------------------------------------------------------

/// The one Hermes a delegation goes to. `handle` and `display_name` are for the mention check (G8) and
/// the progress line — **never** for the body sent to Hermes (I1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HermesTarget {
    pub member_id: Uuid,
    pub handle: String,
    pub display_name: String,
}

/// One agent of the workspace pinned to the operator's own link (`agent_provider_pin.kind =
/// 'operator_env'`), with the facts the door judges it by. Read by [`pinned_agents_in_tx`].
#[derive(Debug, Clone)]
pub struct PinnedAgent {
    pub member_id: Uuid,
    pub handle: String,
    pub display_name: String,
    /// The helper itself (never a target, and never counted: an admin who pinned the helper to the
    /// operator's link did not connect a Hermes).
    pub is_helper: bool,
    /// `member.status = 'active'`.
    pub active: bool,
    /// `agent_profile.paused`.
    pub paused: bool,
    /// `agent.connector_owner_human_id IS NOT NULL`: this agent runs one person's apps (T4).
    pub connector_marked: bool,
    /// `Some` when `agent.invocation_scope = 'owner_only'` — judged by the very gate a mention is.
    pub scope: Option<OwnerOnlyScope>,
}

impl PinnedAgent {
    /// Is this agent a delegation target for `requester`? Not the helper, active, not paused, no connector
    /// mark, and its call scope open to the requester — the last through [`owner_only_gate`] with the
    /// connector branch off (the mark is its own condition above) and the instance's subscription switches
    /// passed as "on": those switches govern a subscription agent's *runtime*, which an operator-env
    /// Hermes is not; what is reused is the gate's owner comparison.
    pub fn is_target_for(&self, requester: Uuid) -> bool {
        !self.is_helper
            && self.active
            && !self.paused
            && !self.connector_marked
            && owner_only_gate(self.scope.as_ref(), None, requester, true, true).is_none()
    }
}

/// What G3 found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TargetResolution {
    /// No operator-env agent that qualifies: nothing is connected (or what is connected is a trial
    /// agent, paused, out of the requester's reach, or the helper itself).
    None,
    /// Exactly one.
    One(HermesTarget),
    /// More than one qualifies: which Hermes is meant is a guess the door does not make (P16-D ⑨).
    Ambiguous(usize),
}

/// **G3's rule**: of the workspace's operator-env agents, the ones that qualify for `requester`
/// ([`PinnedAgent::is_target_for`]) — exactly one resolves, none or several close the door.
pub fn resolve_target(pinned: &[PinnedAgent], requester: Uuid) -> TargetResolution {
    let mut qualifying = pinned.iter().filter(|agent| agent.is_target_for(requester));
    match (qualifying.next(), qualifying.next()) {
        (None, _) => TargetResolution::None,
        (Some(agent), None) => TargetResolution::One(HermesTarget {
            member_id: agent.member_id,
            handle: agent.handle.clone(),
            display_name: agent.display_name.clone(),
        }),
        (Some(_), Some(_)) => TargetResolution::Ambiguous(
            pinned
                .iter()
                .filter(|agent| agent.is_target_for(requester))
                .count(),
        ),
    }
}

/// The workspace's agents pinned to the operator's own link, with the facts G3 judges. One tenant read
/// (`app.workspace_id`, RLS), nothing written. Deleted members are not read; the helper is read and
/// flagged so the pure rule can ignore it.
pub async fn pinned_agents_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    helper_member_id: Uuid,
) -> Result<Vec<PinnedAgent>, DbError> {
    let rows = sqlx::query(
        "SELECT m.id, COALESCE(m.handle, '') AS handle, m.display_name, \
                (m.id = $2) AS is_helper, (m.status = 'active') AS active, \
                COALESCE(ap.paused, false) AS paused, \
                (a.connector_owner_human_id IS NOT NULL) AS connector_marked, \
                a.invocation_scope, a.owner_human_id, a.subscription_harness, \
                a.uses_owner_key, a.personal_agent \
           FROM agent_provider_pin p \
           JOIN member m ON m.workspace_id = p.workspace_id AND m.id = p.agent_member_id \
           JOIN agent a ON a.workspace_id = m.workspace_id AND a.member_id = m.id \
           LEFT JOIN agent_profile ap \
             ON ap.workspace_id = m.workspace_id AND ap.agent_member_id = m.id \
          WHERE p.workspace_id = $1 AND p.kind = 'operator_env' \
            AND m.kind = 'agent' AND m.deleted_at IS NULL \
          ORDER BY m.id",
    )
    .bind(workspace_id)
    .bind(helper_member_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        let invocation_scope: String = row.try_get("invocation_scope")?;
        // Migration 089's CHECK ties `owner_only` to an owner and a harness; a row that somehow had none
        // is read as `owner_only` with the owner unknown (the nil id) — which refuses everyone.
        let scope = (invocation_scope == momo_agent::subscription::INVOCATION_SCOPE_OWNER_ONLY)
            .then(|| -> Result<OwnerOnlyScope, sqlx::Error> {
                let owner: Option<Uuid> = row.try_get("owner_human_id")?;
                let harness: Option<String> = row.try_get("subscription_harness")?;
                Ok(OwnerOnlyScope {
                    owner_member_id: owner.unwrap_or_else(Uuid::nil),
                    owner_display_name: String::new(),
                    harness: harness
                        .as_deref()
                        .and_then(SubscriptionHarness::parse)
                        .unwrap_or(SubscriptionHarness::ClaudeCode),
                    recently_seen: false,
                    reconnectable: false,
                    uses_owner_key: row.try_get("uses_owner_key")?,
                    personal_agent: row.try_get("personal_agent")?,
                })
            })
            .transpose()?;
        out.push(PinnedAgent {
            member_id: row.try_get("id")?,
            handle: row.try_get("handle")?,
            display_name: row.try_get("display_name")?,
            is_helper: row.try_get("is_helper")?,
            active: row.try_get("active")?,
            paused: row.try_get("paused")?,
            connector_marked: row.try_get("connector_marked")?,
            scope,
        });
    }
    Ok(out)
}

/// **G8**: does the trigger mention the target itself (`@handle`, `@Display Name`, `<@id>` — the one
/// parser every mention is read by)? A person who calls Hermes directly is answered by Hermes alone and
/// the helper never takes it over (D1, R9).
pub fn mentions_target(trigger: &str, target: &HermesTarget) -> bool {
    momo_messaging::contains_mention(
        trigger,
        &target.handle,
        &target.display_name,
        target.member_id,
    )
}

// ---------------------------------------------------------------------------
// G6 — the limits
// ---------------------------------------------------------------------------

/// What one delegation is allowed to cost — every number already **effective** (the workspace's value,
/// the default, the operator's ceiling and the task bounds folded in). Built by the worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DelegationBounds {
    /// `min(workspace cap or the default 30, operator ceiling)`; **`None` = closed** — the operator has
    /// not opened the delegation (`TEAM_AI_HERMES_DAILY_CAP` unset, blank or `0`).
    pub day_cap: Option<i64>,
    /// [`REQUESTER_WINDOW_MAX`] in ten minutes.
    pub requester_window_max: i64,
    /// [`CONCURRENT_MAX`].
    pub concurrent_max: i64,
    /// `TaskLimits::max_per_workspace` (a delegation is a task: B5-5).
    pub tasks_workspace_max: i64,
    /// `TaskLimits::max_per_requester`.
    pub tasks_requester_max: i64,
}

/// What has been used. **S1 reads only the two task counts** (rows that already exist); the three
/// delegation counts are read from the delegation marker on a `team_ai_task` row that S2's migration
/// creates, so until then the worker passes `0` for them (and the tests inject real numbers).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DelegationUsage {
    /// Delegations at or past `called`, today (UTC).
    pub today: i64,
    /// Delegations this requester started in the last ten minutes.
    pub requester_recent: i64,
    /// Delegations running now.
    pub in_flight: i64,
    /// Tasks running in this workspace (ordinary tasks count: a delegation is one).
    pub tasks_workspace: i64,
    /// Tasks running for this requester.
    pub tasks_requester: i64,
}

/// Why G6 is shut.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LimitProblem {
    /// The operator's ceiling is unset (or `0`): the delegation is **closed**, not unlimited.
    CeilingUnset,
    /// The day's cap is spent.
    DayCap,
    /// This requester started [`REQUESTER_WINDOW_MAX`] delegations in ten minutes.
    RequesterRate,
    /// [`CONCURRENT_MAX`] delegations are running.
    Concurrent,
    /// The workspace or the requester already has the most tasks running it allows.
    TasksBusy,
}

/// **G6**: is there room? Judged at advertisement (an estimate, no lock) and again at the `called` commit
/// (the authoritative judgement under the workspace lock — S2).
pub fn judge_limits(
    bounds: &DelegationBounds,
    usage: &DelegationUsage,
) -> Result<(), LimitProblem> {
    let Some(day_cap) = bounds.day_cap else {
        return Err(LimitProblem::CeilingUnset);
    };
    if usage.today >= day_cap {
        return Err(LimitProblem::DayCap);
    }
    if usage.requester_recent >= bounds.requester_window_max {
        return Err(LimitProblem::RequesterRate);
    }
    if usage.in_flight >= bounds.concurrent_max {
        return Err(LimitProblem::Concurrent);
    }
    if usage.tasks_workspace >= bounds.tasks_workspace_max
        || usage.tasks_requester >= bounds.tasks_requester_max
    {
        return Err(LimitProblem::TasksBusy);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// the door
// ---------------------------------------------------------------------------

/// G2's inputs: who asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RequesterFacts {
    /// A live human authored the trigger message (`suggestion_requester_in_tx` found one). A `Work`
    /// trigger has none.
    pub human: bool,
    /// The requester is a guest of the workspace or of the channel.
    pub guest: bool,
}

/// Which gate is shut, and why — a closed word for each (the settings screen's 「지금은 쓸 수 없어요」
/// reasons, an audit row's `closed`, and the tests' labels).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DoorClosed {
    /// G1.
    BundleOff,
    /// G2: no live human authored the trigger (a `Work` trigger, an agent's message, a person who left).
    NoHumanRequester,
    /// G2: the requester is a guest.
    GuestRequester,
    /// G3: no Hermes is connected for this requester.
    NotConnected,
    /// G3: more than one Hermes qualifies.
    Ambiguous,
    /// G4.
    Attest(AttestProblem),
    /// G5: the target's `operator_env` pin does not resolve (link or key not configured).
    PinUnresolved,
    /// G6.
    Limit(LimitProblem),
    /// G7: the request has read something.
    AlreadyRead,
    /// G8: the trigger mentions Hermes directly.
    DirectMention,
    /// G9: a task step.
    TaskStep,
    /// G10: this request already delegated once.
    AlreadyDelegated,
    /// All ten gates are open and there is still nothing to offer: no kind is declared, the helper's own
    /// wire searches, or the image path is not ready.
    NoKind,
}

impl DoorClosed {
    /// The gate this word belongs to (`None` for [`DoorClosed::NoKind`], which is not a gate).
    pub fn gate(self) -> Option<&'static str> {
        Some(match self {
            DoorClosed::BundleOff => "G1",
            DoorClosed::NoHumanRequester | DoorClosed::GuestRequester => "G2",
            DoorClosed::NotConnected | DoorClosed::Ambiguous => "G3",
            DoorClosed::Attest(_) => "G4",
            DoorClosed::PinUnresolved => "G5",
            DoorClosed::Limit(_) => "G6",
            DoorClosed::AlreadyRead => "G7",
            DoorClosed::DirectMention => "G8",
            DoorClosed::TaskStep => "G9",
            DoorClosed::AlreadyDelegated => "G10",
            DoorClosed::NoKind => return None,
        })
    }

    /// The closed word. Names only — no value, no id, no text (audit-safe).
    pub fn word(self) -> &'static str {
        match self {
            DoorClosed::BundleOff => "bundle_off",
            DoorClosed::NoHumanRequester => "no_human_requester",
            DoorClosed::GuestRequester => "guest_requester",
            DoorClosed::NotConnected => "hermes_not_connected",
            DoorClosed::Ambiguous => "hermes_ambiguous",
            DoorClosed::Attest(AttestProblem::ToolsNotLocked) => "tools_not_locked",
            DoorClosed::Attest(AttestProblem::ConnectionMode) => "connection_mode",
            DoorClosed::PinUnresolved => "pin_unresolved",
            DoorClosed::Limit(LimitProblem::CeilingUnset) => "ceiling_unset",
            DoorClosed::Limit(LimitProblem::DayCap) => "daily_cap",
            DoorClosed::Limit(LimitProblem::RequesterRate) => "rate_limited",
            DoorClosed::Limit(LimitProblem::Concurrent) => "busy",
            DoorClosed::Limit(LimitProblem::TasksBusy) => "tasks_busy",
            DoorClosed::AlreadyRead => "already_read",
            DoorClosed::DirectMention => "direct_mention",
            DoorClosed::TaskStep => "task_step",
            DoorClosed::AlreadyDelegated => "already_delegated",
            DoorClosed::NoKind => "no_kind",
        }
    }
}

/// What the door decided for one request at one moment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DoorVerdict {
    /// The tool is on the request, with exactly these kinds (never empty).
    Open {
        kinds: Vec<HermesKind>,
    },
    Closed(DoorClosed),
}

impl DoorVerdict {
    pub fn is_open(&self) -> bool {
        matches!(self, DoorVerdict::Open { .. })
    }

    /// The kinds on offer (empty when closed).
    pub fn kinds(&self) -> &[HermesKind] {
        match self {
            DoorVerdict::Open { kinds } => kinds,
            DoorVerdict::Closed(_) => &[],
        }
    }

    pub fn closed(&self) -> Option<DoorClosed> {
        match self {
            DoorVerdict::Open { .. } => None,
            DoorVerdict::Closed(closed) => Some(*closed),
        }
    }

    /// The wire names, for `momo_agent::tools::ask_hermes_definition`.
    pub fn kind_names(&self) -> Vec<&'static str> {
        self.kinds().iter().map(|kind| kind.as_str()).collect()
    }
}

/// Everything the door reads about one request **except** whether it has read something yet (G7 changes
/// during the loop; the rest is gathered once). The worker builds it in its first read transaction.
#[derive(Debug, Clone)]
pub struct DoorFacts {
    /// G1.
    pub roles: TeamAiRoles,
    /// G2.
    pub requester: RequesterFacts,
    /// G3.
    pub target: TargetResolution,
    /// G4 and the kinds the operator declared.
    pub declarations: HermesDeclarations,
    /// G5: the target's pin resolves.
    pub pin_resolves: bool,
    /// G6.
    pub bounds: DelegationBounds,
    pub usage: DelegationUsage,
    /// G8: the trigger mentions the target.
    pub direct_mention: bool,
    /// G9: this job is a task step.
    pub task_step: bool,
    /// G10: this request already delegated.
    pub delegated: bool,
    /// How the request's web search reads (P2 「종류 배타」): the `web_search` kind exists only for
    /// [`WebSearch::NotSupported`] and [`WebSearch::DailyCapReached`].
    pub web: WebSearch,
    /// [`ATTACHMENT_WRITE_PATH_READY`] — a parameter, so the day it flips is a test, not a surprise.
    pub image_path_ready: bool,
}

impl DoorFacts {
    /// **The door.** Is `ask_hermes` on a request that has (`tainted`) or has not read something yet —
    /// `tainted = read_used || web_searches > 0`, the same variable the card path reads (F15)? One
    /// function; the tool list, the prompt line and the closed word all come from this verdict.
    pub fn judge(&self, tainted: bool) -> DoorVerdict {
        // G1
        if !self.roles.is_on(HERMES) {
            return DoorVerdict::Closed(DoorClosed::BundleOff);
        }
        // G2
        if !self.requester.human {
            return DoorVerdict::Closed(DoorClosed::NoHumanRequester);
        }
        if self.requester.guest {
            return DoorVerdict::Closed(DoorClosed::GuestRequester);
        }
        // G3
        match &self.target {
            TargetResolution::None => return DoorVerdict::Closed(DoorClosed::NotConnected),
            TargetResolution::Ambiguous(_) => return DoorVerdict::Closed(DoorClosed::Ambiguous),
            TargetResolution::One(_) => {}
        }
        // G4
        if let Err(problem) = self.declarations.g4() {
            return DoorVerdict::Closed(DoorClosed::Attest(problem));
        }
        // G5
        if !self.pin_resolves {
            return DoorVerdict::Closed(DoorClosed::PinUnresolved);
        }
        // G6
        if let Err(problem) = judge_limits(&self.bounds, &self.usage) {
            return DoorVerdict::Closed(DoorClosed::Limit(problem));
        }
        // G7
        if tainted {
            return DoorVerdict::Closed(DoorClosed::AlreadyRead);
        }
        // G8
        if self.direct_mention {
            return DoorVerdict::Closed(DoorClosed::DirectMention);
        }
        // G9
        if self.task_step {
            return DoorVerdict::Closed(DoorClosed::TaskStep);
        }
        // G10
        if self.delegated {
            return DoorVerdict::Closed(DoorClosed::AlreadyDelegated);
        }
        let kinds: Vec<HermesKind> = HermesKind::ALL
            .into_iter()
            .filter(|kind| self.declarations.declares(*kind))
            .filter(|kind| match kind {
                HermesKind::Image => self.image_path_ready,
                HermesKind::WebSearch => web_search_goes_to_hermes(self.web),
            })
            .collect();
        if kinds.is_empty() {
            return DoorVerdict::Closed(DoorClosed::NoKind);
        }
        DoorVerdict::Open { kinds }
    }

    /// The target's member id, when exactly one Hermes resolved (for the audit row of a delegation).
    pub fn target_member_id(&self) -> Option<Uuid> {
        match &self.target {
            TargetResolution::One(target) => Some(target.member_id),
            _ => None,
        }
    }

    /// Has the operator done everything it takes to open the delegation — the declarations hold, at least
    /// one kind is declared and the ceiling is set? Only then does a closed door say anything to the
    /// model ([`Self::prompt`]): an instance that never opted in is not given a sentence about a
    /// capability nobody switched on (사용자 영향 0).
    pub fn operator_opted_in(&self) -> bool {
        self.declarations.g4().is_ok()
            && (self.declarations.image_tool || self.declarations.search_tool)
            && self.bounds.day_cap.is_some()
    }

    /// What the system prompt says about Hermes for a request in this state (B15-A16: the prompt speaks
    /// about exactly what the request is offered — and, after a read, says what was taken away).
    pub fn prompt(&self, tainted: bool) -> HermesPrompt {
        match self.judge(tainted) {
            DoorVerdict::Open { kinds } => HermesPrompt::Offered { kinds },
            DoorVerdict::Closed(closed) => {
                // The one closed state worth a sentence on its own: the request WOULD have been offered
                // had it not read something (R8).
                if closed == DoorClosed::AlreadyRead && self.judge(false).is_open() {
                    return HermesPrompt::WithheldByRead;
                }
                if !self.roles.is_on(HERMES) || !self.operator_opted_in() {
                    return HermesPrompt::Off;
                }
                match closed {
                    DoorClosed::NotConnected | DoorClosed::Ambiguous => HermesPrompt::NotConnected,
                    DoorClosed::Limit(
                        LimitProblem::DayCap
                        | LimitProblem::RequesterRate
                        | LimitProblem::Concurrent,
                    ) => HermesPrompt::LimitReached,
                    _ => HermesPrompt::Off,
                }
            }
        }
    }
}

/// P2 「종류 배타」: the `web_search` kind is for a wire that cannot search itself and for a non-zero
/// allowance spent today — and for nothing else. **`Off` (the administrator's switch) and `OperatorOff`
/// (`TEAM_AI_DAILY_SEARCH_CAP=0`) never reach Hermes**, whatever the wire: both switches turn Hermes's
/// search off too (F14, T14). `Available` searches itself (R2); `AfterRead` is the task step's own state.
pub fn web_search_goes_to_hermes(web: WebSearch) -> bool {
    matches!(web, WebSearch::NotSupported | WebSearch::DailyCapReached)
}

// ---------------------------------------------------------------------------
// what the model is told
// ---------------------------------------------------------------------------

/// What the system prompt carries about Hermes. Like every capability sentence it exists only while the
/// request is offered the capability (B15-A16); the closed states have a sentence only for the situations
/// where a person asking would otherwise be told something false.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HermesPrompt {
    /// No sentence (the bundle is off, or the instance never opened the delegation).
    Off,
    /// The tool is on this request, with these kinds.
    Offered { kinds: Vec<HermesKind> },
    /// The operator opened the delegation and no Hermes qualifies (G3).
    NotConnected,
    /// The operator opened it and today's room is spent (G6).
    LimitReached,
    /// R8: the request has read something, so what it read cannot be handed to Hermes.
    WithheldByRead,
}

/// The sentence for a kind (written only for an offered kind). Neither promises motion (F11) nor names a
/// model (F10).
fn kind_sentence(kind: HermesKind) -> &'static str {
    match kind {
        HermesKind::Image => "그림은 `image`로 맡겨(정지 그림 한 장).",
        HermesKind::WebSearch => "네 웹 검색이 안 되는 지금, 최신 웹 정보는 `web_search`로 맡겨.",
    }
}

/// P2-R: what Hermes cannot be asked to do with what the request read.
pub const HERMES_WITHHELD_SENTENCE: &str =
    "읽은 내용으로는 Hermes에 맡길 수 없어요. 어떤 그림인지 직접 말해 주세요.";
/// G3 shut with the delegation opened: the honest line (P2 table).
pub const HERMES_NOT_CONNECTED_SENTENCE: &str = "Hermes가 연결돼 있지 않아요.";
/// G6 shut by a count (P9 `cap_reached`).
pub const HERMES_LIMIT_SENTENCE: &str =
    "오늘 Hermes에 맡길 수 있는 횟수를 다 썼어요. 관리자가 설정 › AI에서 바꿀 수 있어요.";

impl HermesPrompt {
    /// The one capability line, or `None`.
    pub fn line(&self) -> Option<String> {
        match self {
            HermesPrompt::Off => None,
            HermesPrompt::Offered { kinds } => {
                let kinds: Vec<&str> = kinds.iter().map(|kind| kind_sentence(*kind)).collect();
                Some(format!(
                    "Hermes 도움 — 네가 직접 못 하는 일은 `{tool}` 도구로 팀 Hermes에게 한 번 맡겨. {kinds} \
                     부탁한 사람이 원한 일만 한두 문장으로 적고, 이름·메일·채널 이름·읽은 내용은 쓰지 마. \
                     한 요청에 한 번만 맡길 수 있어.",
                    tool = ASK_HERMES,
                    kinds = kinds.join(" "),
                ))
            }
            HermesPrompt::NotConnected => Some(format!(
                "Hermes 도움 — 그림이나 Hermes가 있어야 하는 일을 부탁받으면 「{HERMES_NOT_CONNECTED_SENTENCE}」라고 말해."
            )),
            HermesPrompt::LimitReached => Some(format!(
                "Hermes 도움 — 그림이나 검색을 Hermes에 맡겨 달라는 부탁을 받으면 「{HERMES_LIMIT_SENTENCE}」라고 말해."
            )),
            HermesPrompt::WithheldByRead => Some(format!(
                "Hermes 도움 — 이번 요청은 이미 읽은 내용이 있어서 Hermes에 맡길 수 없어. 그림이나 검색을 \
                 Hermes에 맡겨 달라는 부탁을 받으면 「{HERMES_WITHHELD_SENTENCE}」라고 말해."
            )),
        }
    }

    /// Does the prompt hand the web search to Hermes (so the 「웹 검색을 못 해요」 refusal sentence
    /// would contradict the line above it and is left out)?
    pub fn offers_web_search(&self) -> bool {
        matches!(self, HermesPrompt::Offered { kinds } if kinds.contains(&HermesKind::WebSearch))
    }
}

// ---------------------------------------------------------------------------
// the closed result codes (P1, P9)
// ---------------------------------------------------------------------------

/// The audit row's and the trace's word for a delegation that **ended well** (#5370). P1's twelve codes
/// are the results a model or a person is told; a good result is neither a refusal nor a failure, so it
/// has no code there. The audit row (`team_ai.delegate`) says `ok`.
pub const AUDIT_CODE_OK: &str = "ok";
/// The trace's word (`team_ai.turn` → `hermes.results`) for a call that passed every check and became the
/// delegation step: what happens next is the next step's audit row, not this one's.
pub const AUDIT_CODE_ACCEPTED: &str = "accepted";

/// The closed codes of a delegation's result (P1). The model reads `code` (and, for the first two, a
/// reason); a person reads [`DelegateCode::sentence`] where there is one (P9). S1 produces `not_offered`,
/// `invalid_arguments` and `unavailable`; the rest are S2's, named here so the set is closed in one place.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DelegateCode {
    NotOffered,
    InvalidArguments,
    CapReached,
    RateLimited,
    Busy,
    Timeout,
    Unavailable,
    NoTool,
    Refused,
    Failed,
    Cancelled,
    PictureFailed,
}

impl DelegateCode {
    pub const ALL: [DelegateCode; 12] = [
        DelegateCode::NotOffered,
        DelegateCode::InvalidArguments,
        DelegateCode::CapReached,
        DelegateCode::RateLimited,
        DelegateCode::Busy,
        DelegateCode::Timeout,
        DelegateCode::Unavailable,
        DelegateCode::NoTool,
        DelegateCode::Refused,
        DelegateCode::Failed,
        DelegateCode::Cancelled,
        DelegateCode::PictureFailed,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            DelegateCode::NotOffered => "not_offered",
            DelegateCode::InvalidArguments => "invalid_arguments",
            DelegateCode::CapReached => "cap_reached",
            DelegateCode::RateLimited => "rate_limited",
            DelegateCode::Busy => "busy",
            DelegateCode::Timeout => "timeout",
            DelegateCode::Unavailable => "unavailable",
            DelegateCode::NoTool => "no_tool",
            DelegateCode::Refused => "refused",
            DelegateCode::Failed => "failed",
            DelegateCode::Cancelled => "cancelled",
            DelegateCode::PictureFailed => "picture_failed",
        }
    }

    /// The fixed sentence (해요체) a person reads when the delegation ends with this code (P9). The two
    /// codes that are results **to the model** (`not_offered`, `invalid_arguments`) have a sentence the
    /// model reads, and `cancelled` is the existing cancel message, so it has none here.
    pub fn sentence(self) -> Option<&'static str> {
        match self {
            DelegateCode::NotOffered => {
                Some("이번 요청에서는 Hermes에 맡길 수 없어요. 직접 답하거나, 할 수 없다고 말해요.")
            }
            DelegateCode::InvalidArguments => None,
            DelegateCode::CapReached => Some(HERMES_LIMIT_SENTENCE),
            DelegateCode::RateLimited => Some("요청이 너무 빨라요. 잠시 뒤에 다시 해 주세요."),
            DelegateCode::Busy => Some("Hermes가 지금 다른 일을 하고 있어요. 조금 뒤에 다시 불러 주세요."),
            DelegateCode::Timeout => Some("Hermes가 제때 답하지 못했어요. 잠시 뒤에 다시 불러 주세요. (일은 끝났을 수 있어요)"),
            DelegateCode::Unavailable => Some("지금은 Hermes에 닿지 못했어요."),
            DelegateCode::NoTool => Some("Hermes에 이 도구가 켜져 있지 않아요(Codex 로그인이 필요해요). 관리자에게 알려 주세요."),
            DelegateCode::Refused => Some("이 요청은 만들 수 없다고 했어요. 다르게 설명해 주세요."),
            DelegateCode::Failed => Some("Hermes가 일을 끝내지 못했어요."),
            DelegateCode::Cancelled => None,
            DelegateCode::PictureFailed => Some("그림은 만들어졌지만 올리지 못했어요."),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use momo_agent::tools::ASK_HERMES_KINDS;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();
        move |key| map.get(key).cloned()
    }

    fn agent(name: &str) -> PinnedAgent {
        PinnedAgent {
            member_id: Uuid::new_v4(),
            handle: name.to_string(),
            display_name: name.to_string(),
            is_helper: false,
            active: true,
            paused: false,
            connector_marked: false,
            scope: None,
        }
    }

    fn bounds() -> DelegationBounds {
        DelegationBounds {
            day_cap: Some(30),
            requester_window_max: REQUESTER_WINDOW_MAX,
            concurrent_max: CONCURRENT_MAX,
            tasks_workspace_max: 3,
            tasks_requester_max: 1,
        }
    }

    /// The baseline: every gate open and the search kind on offer (a wire that cannot search).
    fn open_facts() -> DoorFacts {
        DoorFacts {
            roles: TeamAiRoles::default(),
            requester: RequesterFacts {
                human: true,
                guest: false,
            },
            target: TargetResolution::One(HermesTarget {
                member_id: Uuid::new_v4(),
                handle: "hermes".into(),
                display_name: "Hermes".into(),
            }),
            declarations: HermesDeclarations {
                tools_locked: true,
                connectors_locked_set: false,
                connector_apps_set: false,
                image_tool: true,
                search_tool: true,
            },
            pin_resolves: true,
            bounds: bounds(),
            usage: DelegationUsage::default(),
            direct_mention: false,
            task_step: false,
            delegated: false,
            web: WebSearch::NotSupported,
            image_path_ready: false,
        }
    }

    fn search_only() -> DoorVerdict {
        DoorVerdict::Open {
            kinds: vec![HermesKind::WebSearch],
        }
    }

    #[test]
    fn the_baseline_door_is_open_for_the_search_kind_and_the_image_kind_waits_for_s4() {
        assert_eq!(open_facts().judge(false), search_only());
        // `image` needs BOTH the operator's declaration and the code constant (P6, A10)
        let mut ready = open_facts();
        ready.image_path_ready = true;
        assert_eq!(
            ready.judge(false),
            DoorVerdict::Open {
                kinds: vec![HermesKind::Image, HermesKind::WebSearch]
            }
        );
        // …and the constant ships `false`
        // The pin S4's PR flips in the same commit as this line; `black_box` keeps the compiler from
        // folding the constant, so the failure is a test failure naming this line, not a build error.
        assert!(!std::hint::black_box(ATTACHMENT_WRITE_PATH_READY));
        assert_eq!(ASK_HERMES_KINDS, HermesKind::ALL.map(HermesKind::as_str));
        assert_eq!(ASK_HERMES, "ask_hermes");
    }

    /// P15-A1: each gate, broken ALONE from a baseline that is open, shuts the door — and the word names
    /// that gate. Deleting a gate's branch from `judge` fails exactly its row.
    #[test]
    fn each_gate_broken_alone_shuts_the_door_and_names_itself() {
        let baseline = open_facts();
        assert!(baseline.judge(false).is_open());
        type Break = Box<dyn Fn(&mut DoorFacts)>;
        let cases: Vec<(&str, DoorClosed, Break)> = vec![
            (
                "G1",
                DoorClosed::BundleOff,
                Box::new(|f: &mut DoorFacts| f.roles = f.roles.with(HERMES, false)),
            ),
            (
                "G2",
                DoorClosed::NoHumanRequester,
                Box::new(|f: &mut DoorFacts| f.requester.human = false),
            ),
            (
                "G2",
                DoorClosed::GuestRequester,
                Box::new(|f: &mut DoorFacts| f.requester.guest = true),
            ),
            (
                "G3",
                DoorClosed::NotConnected,
                Box::new(|f: &mut DoorFacts| f.target = TargetResolution::None),
            ),
            (
                "G3",
                DoorClosed::Ambiguous,
                Box::new(|f: &mut DoorFacts| f.target = TargetResolution::Ambiguous(2)),
            ),
            (
                "G4",
                DoorClosed::Attest(AttestProblem::ToolsNotLocked),
                Box::new(|f: &mut DoorFacts| f.declarations.tools_locked = false),
            ),
            (
                "G4",
                DoorClosed::Attest(AttestProblem::ConnectionMode),
                Box::new(|f: &mut DoorFacts| f.declarations.connectors_locked_set = true),
            ),
            (
                "G4",
                DoorClosed::Attest(AttestProblem::ConnectionMode),
                Box::new(|f: &mut DoorFacts| f.declarations.connector_apps_set = true),
            ),
            (
                "G5",
                DoorClosed::PinUnresolved,
                Box::new(|f: &mut DoorFacts| f.pin_resolves = false),
            ),
            (
                "G6",
                DoorClosed::Limit(LimitProblem::CeilingUnset),
                Box::new(|f: &mut DoorFacts| f.bounds.day_cap = None),
            ),
            (
                "G6",
                DoorClosed::Limit(LimitProblem::DayCap),
                Box::new(|f: &mut DoorFacts| f.usage.today = 30),
            ),
            (
                "G6",
                DoorClosed::Limit(LimitProblem::RequesterRate),
                Box::new(|f: &mut DoorFacts| f.usage.requester_recent = 6),
            ),
            (
                "G6",
                DoorClosed::Limit(LimitProblem::Concurrent),
                Box::new(|f: &mut DoorFacts| f.usage.in_flight = 2),
            ),
            (
                "G6",
                DoorClosed::Limit(LimitProblem::TasksBusy),
                Box::new(|f: &mut DoorFacts| f.usage.tasks_workspace = 3),
            ),
            (
                "G6",
                DoorClosed::Limit(LimitProblem::TasksBusy),
                Box::new(|f: &mut DoorFacts| f.usage.tasks_requester = 1),
            ),
            (
                "G8",
                DoorClosed::DirectMention,
                Box::new(|f: &mut DoorFacts| f.direct_mention = true),
            ),
            (
                "G9",
                DoorClosed::TaskStep,
                Box::new(|f: &mut DoorFacts| f.task_step = true),
            ),
            (
                "G10",
                DoorClosed::AlreadyDelegated,
                Box::new(|f: &mut DoorFacts| f.delegated = true),
            ),
        ];
        for (gate, expected, break_it) in &cases {
            let mut facts = open_facts();
            break_it(&mut facts);
            let verdict = facts.judge(false);
            assert_eq!(verdict.closed(), Some(*expected), "{gate} {expected:?}");
            assert_eq!(expected.gate(), Some(*gate), "{expected:?}");
            assert!(verdict.kinds().is_empty() && verdict.kind_names().is_empty());
        }
        // G7 alone: the same request, after it read something
        let after_read = baseline.judge(true);
        assert_eq!(after_read.closed(), Some(DoorClosed::AlreadyRead));
        assert_eq!(DoorClosed::AlreadyRead.gate(), Some("G7"));
        // and every gate of the table is covered by a case above
        let mut gates: Vec<&str> = cases.iter().map(|(gate, _, _)| *gate).collect();
        gates.push("G7");
        gates.sort_unstable();
        gates.dedup();
        assert_eq!(
            gates,
            ["G1", "G10", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9"]
        );
    }

    /// The limit edges: `n - 1` is room, `n` is not (a `>` for a `>=` fails here), and every number is
    /// its own gate.
    #[test]
    fn the_limits_close_exactly_at_their_numbers() {
        let one = |usage: DelegationUsage| judge_limits(&bounds(), &usage);
        assert_eq!(one(DelegationUsage::default()), Ok(()));
        assert_eq!(
            one(DelegationUsage {
                today: 29,
                ..Default::default()
            }),
            Ok(())
        );
        assert_eq!(
            one(DelegationUsage {
                today: 30,
                ..Default::default()
            }),
            Err(LimitProblem::DayCap)
        );
        assert_eq!(
            one(DelegationUsage {
                requester_recent: 5,
                ..Default::default()
            }),
            Ok(())
        );
        assert_eq!(
            one(DelegationUsage {
                requester_recent: 6,
                ..Default::default()
            }),
            Err(LimitProblem::RequesterRate)
        );
        assert_eq!(
            one(DelegationUsage {
                in_flight: 1,
                ..Default::default()
            }),
            Ok(())
        );
        assert_eq!(
            one(DelegationUsage {
                in_flight: 2,
                ..Default::default()
            }),
            Err(LimitProblem::Concurrent)
        );
        assert_eq!(
            one(DelegationUsage {
                tasks_workspace: 2,
                ..Default::default()
            }),
            Ok(())
        );
        assert_eq!(
            one(DelegationUsage {
                tasks_workspace: 3,
                ..Default::default()
            }),
            Err(LimitProblem::TasksBusy)
        );
        assert_eq!(
            one(DelegationUsage {
                tasks_requester: 0,
                ..Default::default()
            }),
            Ok(())
        );
        assert_eq!(
            one(DelegationUsage {
                tasks_requester: 1,
                ..Default::default()
            }),
            Err(LimitProblem::TasksBusy)
        );
        // the operator's ceiling unset is closed whatever else is true — even with room everywhere
        let closed = DelegationBounds {
            day_cap: None,
            ..bounds()
        };
        assert_eq!(
            judge_limits(&closed, &DelegationUsage::default()),
            Err(LimitProblem::CeilingUnset)
        );
        // a cap of 1 spent after one
        let tight = DelegationBounds {
            day_cap: Some(1),
            ..bounds()
        };
        assert_eq!(judge_limits(&tight, &DelegationUsage::default()), Ok(()));
        assert_eq!(
            judge_limits(
                &tight,
                &DelegationUsage {
                    today: 1,
                    ..Default::default()
                }
            ),
            Err(LimitProblem::DayCap)
        );
    }

    /// RL2 + P2 G4: the connection-mode declarations are judged by the **presence of a non-empty value**.
    /// An empty variable (compose's `${VAR:-}`) and a blank one are absent; `0`, a malformed app list
    /// and any other value shut the door — the case a parse-based door would open on.
    #[test]
    fn the_connection_mode_declarations_close_the_door_by_a_non_empty_value_not_by_what_parses() {
        let tools = ("OORT_COHOSTED_AGENT_TOOLS_LOCKED", "1");
        let read = |extra: &[(&str, &str)]| {
            let mut pairs = vec![tools];
            pairs.extend_from_slice(extra);
            HermesDeclarations::from_lookup(env(&pairs))
        };
        // team default mode: nothing else
        assert_eq!(read(&[]).g4(), Ok(()));
        // EMPTY and blank are absent — the shape compose gives an unset `${VAR:-}`
        for empty in ["", " ", "\t", "  \n "] {
            assert_eq!(
                read(&[(ENV_CONNECTORS_LOCKED, empty), (ENV_CONNECTOR_APPS, empty)]).g4(),
                Ok(()),
                "{empty:?}"
            );
        }
        // a value shuts it — whatever the api's reader would make of it
        for value in [
            "0",
            "false",
            "1",
            "true",
            "no",
            "com.momo.plugins.gmail",
            "Not A Plugin!!",
            "a,b",
            ",",
            "0 ",
        ] {
            for name in [ENV_CONNECTORS_LOCKED, ENV_CONNECTOR_APPS] {
                let declarations = read(&[(name, value)]);
                assert_eq!(
                    declarations.g4(),
                    Err(AttestProblem::ConnectionMode),
                    "{name}={value:?}"
                );
                assert!(declarations.connection_mode());
            }
        }
        // the api's reader makes an EMPTY list of a malformed one: the very reason this is not parse-based
        let malformed =
            ConnectorTrialAttest::from_env(env(&[(ENV_CONNECTOR_APPS, "Not A Plugin!!")]));
        assert!(
            malformed.apps.is_empty(),
            "the api reader drops a malformed list: {malformed:?}"
        );
        assert_eq!(
            read(&[(ENV_CONNECTOR_APPS, "Not A Plugin!!")]).g4(),
            Err(AttestProblem::ConnectionMode)
        );
        // the tool lock: the api's truthy rule, and nothing else is true
        for truthy in ["1", "true", "TRUE", "yes", "on", " 1 ", "On"] {
            let d = HermesDeclarations::from_lookup(env(&[(
                "OORT_COHOSTED_AGENT_TOOLS_LOCKED",
                truthy,
            )]));
            assert_eq!(d.g4(), Ok(()), "{truthy:?}");
        }
        for falsy in ["", "0", "false", "no", "off", "2", "enabled", "y"] {
            let d = HermesDeclarations::from_lookup(env(&[(
                "OORT_COHOSTED_AGENT_TOOLS_LOCKED",
                falsy,
            )]));
            assert_eq!(d.g4(), Err(AttestProblem::ToolsNotLocked), "{falsy:?}");
        }
        assert_eq!(
            HermesDeclarations::from_lookup(env(&[])).g4(),
            Err(AttestProblem::ToolsNotLocked)
        );
        // connection mode wins over a missing lock (the more serious word)
        let both = HermesDeclarations::from_lookup(env(&[(ENV_CONNECTOR_APPS, "x")]));
        assert_eq!(both.g4(), Err(AttestProblem::ConnectionMode));
    }

    /// The kind declarations read the same truthy rule and are independent of each other and of G4.
    #[test]
    fn the_kind_declarations_are_the_operators_own_and_independent() {
        let d =
            HermesDeclarations::from_lookup(env(&[(ENV_IMAGE_TOOL, "1"), (ENV_SEARCH_TOOL, "no")]));
        assert!(d.declares(HermesKind::Image) && !d.declares(HermesKind::WebSearch));
        assert!(!d.tools_locked);
        let none = HermesDeclarations::from_lookup(env(&[]));
        assert!(!none.declares(HermesKind::Image) && !none.declares(HermesKind::WebSearch));
        assert_eq!(ENV_IMAGE_TOOL, "OORT_COHOSTED_AGENT_IMAGE_TOOL");
        assert_eq!(ENV_SEARCH_TOOL, "OORT_COHOSTED_AGENT_SEARCH_TOOL");
    }

    /// P2 「종류 배타」 and review RL3. The `web_search` kind exists only for a wire that cannot search
    /// (`NotSupported`) and for a **non-zero** allowance spent (`DailyCapReached`). The administrator's
    /// switch and the operator's zero close it **whatever the wire** — the 2×2 of
    /// {switch off, operator zero} × {wire that searches, wire that cannot} is all zeros, and the two
    /// states that open it are the only two.
    #[test]
    fn the_search_kind_goes_to_hermes_only_for_a_wire_that_cannot_search_or_a_spent_allowance() {
        let kinds_for = |web: WebSearch| {
            let mut facts = open_facts();
            facts.web = web;
            facts.declarations.image_tool = false; // isolate the search kind
            facts.judge(false)
        };
        assert_eq!(kinds_for(WebSearch::NotSupported), search_only());
        assert_eq!(kinds_for(WebSearch::DailyCapReached), search_only());
        for web in [
            WebSearch::Available,
            WebSearch::Off,
            WebSearch::OperatorOff,
            WebSearch::AfterRead,
        ] {
            assert_eq!(
                kinds_for(web),
                DoorVerdict::Closed(DoorClosed::NoKind),
                "{web:?}"
            );
        }
        // and the cross, through the ONE reading of the web state the worker uses
        for (admin_on, operator_off) in [(false, false), (false, true), (true, true)] {
            for wire_searches in [true, false] {
                for cap_reached in [false, true] {
                    let web = WebSearch::judge(admin_on, operator_off, wire_searches, cap_reached);
                    assert!(
                        !web_search_goes_to_hermes(web),
                        "admin_on={admin_on} operator_off={operator_off} wire_searches={wire_searches} cap_reached={cap_reached} -> {web:?}"
                    );
                }
            }
        }
        // the two that open it: reached only with the switches on
        assert_eq!(
            WebSearch::judge(true, false, false, false),
            WebSearch::NotSupported
        );
        assert_eq!(
            WebSearch::judge(true, false, true, true),
            WebSearch::DailyCapReached
        );
        assert!(web_search_goes_to_hermes(WebSearch::judge(
            true, false, false, true
        )));
        assert_eq!(
            WebSearch::judge(true, false, true, false),
            WebSearch::Available
        );
    }

    /// With every gate open and nothing to offer the door is still shut — the tool is never on a request
    /// with an empty `kind` enum.
    #[test]
    fn nothing_declared_means_nothing_offered() {
        let mut facts = open_facts();
        facts.declarations.image_tool = false;
        facts.declarations.search_tool = false;
        assert_eq!(facts.judge(false), DoorVerdict::Closed(DoorClosed::NoKind));
        assert_eq!(DoorClosed::NoKind.gate(), None);
        // declared but the wire searches: nothing
        let mut facts = open_facts();
        facts.web = WebSearch::Available;
        facts.declarations.image_tool = false;
        assert_eq!(facts.judge(false).closed(), Some(DoorClosed::NoKind));
        // image declared, the path not ready: nothing
        let mut facts = open_facts();
        facts.declarations.search_tool = false;
        assert_eq!(facts.judge(false).closed(), Some(DoorClosed::NoKind));
    }

    /// G3: exactly one qualifying Hermes resolves; none or several close the door; the helper itself, a
    /// deleted-like (inactive) member, a paused one, a connector-marked one and one whose scope is not open
    /// to the requester each do not qualify — measured one at a time from a single good agent.
    #[test]
    fn the_target_is_the_one_operator_env_agent_that_qualifies_for_this_requester() {
        let requester = Uuid::new_v4();
        let good = agent("hermes");
        let one = |agents: &[PinnedAgent]| resolve_target(agents, requester);
        match one(std::slice::from_ref(&good)) {
            TargetResolution::One(target) => assert_eq!(target.member_id, good.member_id),
            other => panic!("{other:?}"),
        }
        assert_eq!(one(&[]), TargetResolution::None);
        // each disqualifier alone
        let mut helper = good.clone();
        helper.is_helper = true;
        let mut inactive = good.clone();
        inactive.active = false;
        let mut paused = good.clone();
        paused.paused = true;
        let mut marked = good.clone();
        marked.connector_marked = true;
        let mut others_only = good.clone();
        others_only.scope = Some(owner_only_scope(Uuid::new_v4()));
        for disqualified in [helper.clone(), inactive, paused, marked, others_only] {
            assert_eq!(
                one(std::slice::from_ref(&disqualified)),
                TargetResolution::None,
                "{disqualified:?}"
            );
        }
        // an owner_only agent IS a target for its own owner (the gate's owner comparison, reused)
        let mut mine = good.clone();
        mine.scope = Some(owner_only_scope(requester));
        assert!(matches!(one(&[mine]), TargetResolution::One(_)));
        // two that qualify: ambiguous, whichever order
        let second = agent("hermes-2");
        assert_eq!(
            one(&[good.clone(), second.clone()]),
            TargetResolution::Ambiguous(2)
        );
        assert_eq!(
            one(&[second.clone(), good.clone()]),
            TargetResolution::Ambiguous(2)
        );
        // the helper pinned to the operator's link is not counted: it does not make the other one ambiguous
        match one(&[helper, good.clone()]) {
            TargetResolution::One(target) => assert_eq!(target.member_id, good.member_id),
            other => panic!("{other:?}"),
        }
        // one that does not qualify beside one that does leaves the one
        let mut paused_second = second;
        paused_second.paused = true;
        assert!(matches!(
            one(&[good, paused_second]),
            TargetResolution::One(_)
        ));
    }

    fn owner_only_scope(owner: Uuid) -> OwnerOnlyScope {
        OwnerOnlyScope {
            owner_member_id: owner,
            owner_display_name: String::new(),
            harness: SubscriptionHarness::ClaudeCode,
            recently_seen: false,
            reconnectable: false,
            uses_owner_key: false,
            personal_agent: false,
        }
    }

    /// G8: the mention parser every mention is read by — handle, display name and `<@id>` forms.
    #[test]
    fn a_direct_mention_is_read_by_the_one_mention_parser() {
        let target = HermesTarget {
            member_id: Uuid::new_v4(),
            handle: "hermes".into(),
            display_name: "Hermes Bot".into(),
        };
        assert!(mentions_target("@hermes 고양이 그려 줘", &target));
        assert!(mentions_target("@oort 그리고 @HERMES 도", &target));
        assert!(mentions_target("@Hermes Bot 부탁해", &target));
        assert!(mentions_target(
            &format!("<@{}> 부탁", target.member_id),
            &target
        ));
        assert!(!mentions_target(
            "@oort 헤르메스 같은 그림 그려 줘",
            &target
        ));
        assert!(!mentions_target("@hermesbot 아님", &target));
        assert!(!mentions_target("hermes 그냥 단어", &target));
    }

    /// B15-A16 / P2: the prompt speaks about exactly what the request is offered. Closed states are
    /// silent unless the operator opened the delegation; after a read, a request that would have been
    /// offered is told what was taken away (R8).
    #[test]
    fn the_prompt_speaks_only_about_what_is_offered_or_was_taken_away() {
        // open: the one line, with exactly the offered kinds' sentences — and no motion, no model
        let open = open_facts();
        let line = open.prompt(false).line().expect("a line for an open door");
        assert!(
            line.contains("ask_hermes") && line.contains("web_search") && !line.contains("`image`"),
            "{line}"
        );
        let mut ready = open_facts();
        ready.image_path_ready = true;
        let line = ready.prompt(false).line().unwrap();
        assert!(
            line.contains("`image`") && line.contains("web_search"),
            "{line}"
        );
        for banned in ["GIF", "gif", "움직", "애니", "gpt", "GPT", "모델"] {
            assert!(!line.contains(banned), "{banned}: {line}");
        }
        assert!(open.prompt(false).offers_web_search());
        assert!(!HermesPrompt::Off.offers_web_search());
        // after a read: not offered, and the request is told why (R8) — only because it would have been
        let withheld = open.prompt(true);
        assert_eq!(withheld, HermesPrompt::WithheldByRead);
        assert!(withheld.line().unwrap().contains(HERMES_WITHHELD_SENTENCE));
        // …but a request that was never going to be offered says nothing about having read
        let mut off = open_facts();
        off.roles = off.roles.with(HERMES, false);
        assert_eq!(off.prompt(true), HermesPrompt::Off);
        assert_eq!(off.prompt(false), HermesPrompt::Off);
        let mut never = open_facts();
        never.target = TargetResolution::None;
        assert_eq!(never.prompt(true), HermesPrompt::NotConnected);
        // not connected: a sentence only for an operator who opened the delegation
        let mut not_connected = open_facts();
        not_connected.target = TargetResolution::None;
        assert_eq!(not_connected.prompt(false), HermesPrompt::NotConnected);
        assert!(not_connected
            .prompt(false)
            .line()
            .unwrap()
            .contains(HERMES_NOT_CONNECTED_SENTENCE));
        for undo in [
            Box::new(|f: &mut DoorFacts| f.bounds.day_cap = None) as Box<dyn Fn(&mut DoorFacts)>,
            Box::new(|f: &mut DoorFacts| f.declarations.tools_locked = false),
            Box::new(|f: &mut DoorFacts| f.declarations.connector_apps_set = true),
            Box::new(|f: &mut DoorFacts| {
                f.declarations.image_tool = false;
                f.declarations.search_tool = false;
            }),
        ] {
            let mut instance = open_facts();
            instance.target = TargetResolution::None;
            undo(&mut instance);
            assert_eq!(
                instance.prompt(false),
                HermesPrompt::Off,
                "an instance that never opened it says nothing"
            );
        }
        // limits by a count: the honest sentence; a number the operator unset: nothing
        let mut spent = open_facts();
        spent.usage.today = 30;
        assert_eq!(spent.prompt(false), HermesPrompt::LimitReached);
        assert!(spent
            .prompt(false)
            .line()
            .unwrap()
            .contains(HERMES_LIMIT_SENTENCE));
        let mut unset = open_facts();
        unset.bounds.day_cap = None;
        assert_eq!(unset.prompt(false), HermesPrompt::Off);
        // other closed gates are silent
        for shut in [
            Box::new(|f: &mut DoorFacts| f.direct_mention = true) as Box<dyn Fn(&mut DoorFacts)>,
            Box::new(|f: &mut DoorFacts| f.task_step = true),
            Box::new(|f: &mut DoorFacts| f.delegated = true),
            Box::new(|f: &mut DoorFacts| f.requester.guest = true),
            Box::new(|f: &mut DoorFacts| f.pin_resolves = false),
        ] {
            let mut facts = open_facts();
            shut(&mut facts);
            assert_eq!(facts.prompt(false), HermesPrompt::Off);
        }
    }

    /// The closed codes (P1): twelve, each with a unique name; the sentences a person reads are 해요체
    /// sentences and the two model-facing codes are not among the person-facing ones.
    #[test]
    fn the_result_codes_are_the_twelve_of_p1() {
        let names: Vec<&str> = DelegateCode::ALL.iter().map(|code| code.as_str()).collect();
        assert_eq!(
            names,
            [
                "not_offered",
                "invalid_arguments",
                "cap_reached",
                "rate_limited",
                "busy",
                "timeout",
                "unavailable",
                "no_tool",
                "refused",
                "failed",
                "cancelled",
                "picture_failed",
            ]
        );
        let mut unique = names.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), 12);
        for code in DelegateCode::ALL {
            if let Some(sentence) = code.sentence() {
                assert!(
                    sentence.ends_with("요.") || sentence.ends_with("요)"),
                    "{code:?}: {sentence}"
                );
            }
        }
        assert_eq!(
            DelegateCode::Unavailable.sentence(),
            Some("지금은 Hermes에 닿지 못했어요.")
        );
        assert_eq!(DelegateCode::Cancelled.sentence(), None);
        assert_eq!(DelegateCode::InvalidArguments.sentence(), None);
        // every closed word is a name: lower snake, no value in it
        for closed in [
            DoorClosed::BundleOff,
            DoorClosed::NoHumanRequester,
            DoorClosed::GuestRequester,
            DoorClosed::NotConnected,
            DoorClosed::Ambiguous,
            DoorClosed::Attest(AttestProblem::ToolsNotLocked),
            DoorClosed::Attest(AttestProblem::ConnectionMode),
            DoorClosed::PinUnresolved,
            DoorClosed::Limit(LimitProblem::CeilingUnset),
            DoorClosed::Limit(LimitProblem::DayCap),
            DoorClosed::Limit(LimitProblem::RequesterRate),
            DoorClosed::Limit(LimitProblem::Concurrent),
            DoorClosed::Limit(LimitProblem::TasksBusy),
            DoorClosed::AlreadyRead,
            DoorClosed::DirectMention,
            DoorClosed::TaskStep,
            DoorClosed::AlreadyDelegated,
            DoorClosed::NoKind,
        ] {
            assert!(
                closed
                    .word()
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c == '_'),
                "{closed:?}"
            );
        }
        assert_eq!(AUDIT_DELEGATE, "team_ai.delegate");
    }
}
