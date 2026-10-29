//! Cards an agent raises **nobody asked for** (ADR-0186 증보 v5 U-a~U-d, #4704).
//!
//! `oort_action_initiate` is the one Agent Port tool that needs no lease handle, so it has no
//! job to hang a run on. The server opens a short run of its own, born `awaiting_approval`
//! (the in-place channel-grant card is the precedent: `in_place_grant`), writes one
//! `workspace_action` approval and one card in the **owner's** one-to-one direct message,
//! and stops. Nothing here executes anything: the decision route does, as the approver, after a
//! person says yes.
//!
//! This module owns the vocabulary (origin, hold marker, lifetimes, the card's sentence) and the
//! reads the producer needs that do not touch another crate: the facts of the door, the member
//! lock, and the re-ask lookup. The order of the writes is the route's
//! (`routes::agent_initiative`), as for every other producer.

use chrono::{DateTime, Utc};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::DbError;
use serde_json::{json, Value};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::actions::{
    WorkspaceAction, ACTION_CHANNEL_CREATE, ACTION_CHANNEL_MEMBER_ADD, ACTION_MESSAGE_PIN,
    ACTION_MESSAGE_UNPIN,
};
use crate::approval::{effective_status, LockedApproval};
use crate::in_place_grant::RUN_HOLD_KEY;
use crate::run::{RunTrigger, AGENT_INITIATED_KEY_PREFIX as RUN_KEY_PREFIX};

/// `approval.payload.origin` of an unasked card. The in-place card's is `server_in_place`; every
/// other `workspace_action` was proposed by an agent a person called and carries no origin.
/// The push judgment already projects `origin`, so `opens_in_app` can read it
/// (`momo_push` `judgment.rs`).
pub const APPROVAL_ORIGIN_AGENT_INITIATED: &str = "agent_initiated";

/// `agent_run.input.hold` of the run behind an unasked card. [`crate::run::live_run_count_in_tx`]
/// does not count it: it holds no job and nothing of it reached the agent.
pub const RUN_HOLD_AGENT_INITIATED: &str = "agent_initiated";

/// How long an unasked card waits for its owner **by default**: a day. The default 1-hour
/// approval lifetime (`approval::DEFAULT_TTL_SECONDS`) exists because a parked run holds its
/// agent's concurrency slot; this run holds none (the hold above), and a card that lapses before
/// its owner is back at the screen would be raised again at once. An operator may change it
/// (`MOMO_AGENT_INITIATIVE_TTL_HOURS`, [`InitiativeLimits`]); this is what an unset variable means.
pub const INITIATIVE_TTL_SECONDS: i64 = TTL_HOURS_DEFAULT * 60 * 60;

/// The workspace settings key that switches unasked cards off for the whole workspace
/// (ADR-0186 증보 v5 U-b-3). Absent reads as **on**; `false` is off. Written by an administrator
/// through `PATCH …/settings` (`momo_settings::ALLOWED_SETTINGS_KEYS` spells the same key) and by
/// nothing an agent can reach: `workspace.settings.update` takes two other keys.
pub const SETTING_AGENT_INITIATIVE: &str = "agent_initiative";

/// Whether the workspace switch is **on**, read from the settings bag (`None`: the workspace row is
/// hidden from this transaction). Absent key = on; a literal `true` = on; a value that is not a
/// boolean (`"false"`, `0`) is not a switch somebody meant to leave on, and fails closed.
///
/// One definition for both readers — the door that raises a card and the decision that re-proves
/// it — so a switch cannot mean one thing to the first and another to the second.
pub fn switch_is_on(settings: Option<&Value>) -> bool {
    match settings {
        Some(bag) => match bag.get(SETTING_AGENT_INITIATIVE) {
            None => true,
            Some(Value::Bool(on)) => *on,
            Some(_) => false,
        },
        None => false,
    }
}

// ---------------------------------------------------------------------------
// limits (ADR-0186 증보 v5 U-d, #4704 PR B)
// ---------------------------------------------------------------------------

/// Of an agent's pending cards at most this many are ones it raised unasked. The total ceiling
/// ([`crate::actions::MAX_PENDING_WORKSPACE_ACTIONS`]) counts them too, so an unasked card can
/// never push the agent's third slot — the one a person's proposal may still take — out of reach.
pub const MAX_PENDING_INITIATIVE: i64 = 2;

/// After a person **rejects** an unasked card, the same proposal ([`initiative_key`]) is not
/// raised again for this long. A rejection is a person's 「그만」; an expiry is nobody's word and
/// does not start it.
pub const COOLDOWN_SECONDS: i64 = 24 * 60 * 60;

/// Cards per hour, the default and the range an operator may set it to.
pub const PER_HOUR_DEFAULT: i64 = 6;
pub const PER_HOUR_RANGE: (i64, i64) = (1, 60);
/// Cards per day.
pub const PER_DAY_DEFAULT: i64 = 20;
pub const PER_DAY_RANGE: (i64, i64) = (1, 240);
/// Hours an unasked card waits.
pub const TTL_HOURS_DEFAULT: i64 = 24;
pub const TTL_HOURS_RANGE: (i64, i64) = (1, 168);

/// The three numbers an operator may set (`MOMO_AGENT_INITIATIVE_PER_HOUR`, `_PER_DAY`,
/// `_TTL_HOURS`). Every one is inside its range **whatever the environment says**: a limit of zero
/// would close the door by typo, and an unbounded one would open it past the point of the ceiling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InitiativeLimits {
    pub per_hour: i64,
    pub per_day: i64,
    pub ttl_seconds: i64,
}

impl Default for InitiativeLimits {
    fn default() -> Self {
        InitiativeLimits {
            per_hour: PER_HOUR_DEFAULT,
            per_day: PER_DAY_DEFAULT,
            ttl_seconds: INITIATIVE_TTL_SECONDS,
        }
    }
}

/// How one environment value was read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LimitReading {
    /// Unset or blank: the default.
    Unset,
    /// A number inside the range, used as written.
    Valid,
    /// A number outside the range: used as the nearest bound. The operator is told at boot.
    Clamped { requested: i64 },
    /// Not a number: the default. The operator is told at boot.
    Unparsable,
}

fn read_bounded(raw: Option<&str>, default: i64, (low, high): (i64, i64)) -> (i64, LimitReading) {
    let Some(text) = raw.map(str::trim).filter(|text| !text.is_empty()) else {
        return (default, LimitReading::Unset);
    };
    let Ok(requested) = text.parse::<i64>() else {
        return (default, LimitReading::Unparsable);
    };
    if (low..=high).contains(&requested) {
        (requested, LimitReading::Valid)
    } else {
        (
            requested.clamp(low, high),
            LimitReading::Clamped { requested },
        )
    }
}

impl InitiativeLimits {
    /// The pure half of reading `MOMO_AGENT_INITIATIVE_PER_HOUR`, `_PER_DAY` and `_TTL_HOURS`:
    /// each value is clamped to its range and a value that is not a number falls back to the
    /// default (an abuse limit is not worth a failed boot, and not worth a silent zero either).
    /// The readings come back so the caller can say what it did.
    pub fn from_env_values(
        per_hour: Option<&str>,
        per_day: Option<&str>,
        ttl_hours: Option<&str>,
    ) -> (InitiativeLimits, [LimitReading; 3]) {
        let (per_hour, hour_reading) = read_bounded(per_hour, PER_HOUR_DEFAULT, PER_HOUR_RANGE);
        let (per_day, day_reading) = read_bounded(per_day, PER_DAY_DEFAULT, PER_DAY_RANGE);
        let (ttl_hours, ttl_reading) = read_bounded(ttl_hours, TTL_HOURS_DEFAULT, TTL_HOURS_RANGE);
        (
            InitiativeLimits {
                per_hour,
                per_day,
                ttl_seconds: ttl_hours * 60 * 60,
            },
            [hour_reading, day_reading, ttl_reading],
        )
    }
}

/// What the rate window counts: runs the producer wrote for this agent, by the key prefix the
/// producer alone writes ([`crate::run::AGENT_INITIATED_KEY_PREFIX`]) — the very predicate of the
/// partial index migration 155 builds, spelled the same so the planner can use it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecentInitiativeRuns {
    pub last_hour: i64,
    pub last_day: i64,
}

/// The statement [`count_recent_initiative_runs_in_tx`] runs (`$1` workspace, `$2` agent) — public so
/// a test can ask the planner about **this** text.
///
/// The key prefix is a literal in the statement, not a bind: a partial index is chosen from the
/// statement text, and a generic plan over a parameter could never prove `LIKE $3` implies the
/// predicate of `agent_run_initiative_rate_idx` (migration 155), which is spelled the same.
pub fn recent_runs_statement() -> String {
    format!(
        "SELECT count(*) FILTER (WHERE created_at > now() - interval '1 hour'), count(*) \
           FROM agent_run \
          WHERE workspace_id = $1 AND agent_member_id = $2 \
            AND idempotency_key LIKE '{RUN_KEY_PREFIX}%' \
            AND created_at > now() - interval '24 hours'"
    )
}

/// How many unasked cards this agent raised in the last hour and in the last day, counted in the
/// database (`agent_run`, so a restart or a second replica sees the same number).
///
/// Counted **by what was raised**, not by what was asked: a refusal writes no run, so a refused
/// call does not lengthen its own window (ADR-0186 증보 V4-10 5's rule). The windows are the
/// database's clock, as the pending ceiling's expiry is, so a test that moves `created_at`
/// moves them.
pub async fn count_recent_initiative_runs_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
) -> Result<RecentInitiativeRuns, DbError> {
    let (last_hour, last_day): (i64, i64) = sqlx::query_as(&recent_runs_statement())
        .bind(workspace_id)
        .bind(agent_member_id)
        .fetch_one(&mut *conn)
        .await?;
    Ok(RecentInitiativeRuns {
        last_hour,
        last_day,
    })
}

/// Reduce a proposal to the thing it is **about**, for the two rules that ask whether it is the
/// same proposal as one before: not raised again while it is pending ([`Blocker::Pending`]), and
/// not raised again for [`COOLDOWN_SECONDS`] after a person rejected it ([`Blocker::Cooldown`]).
///
/// The key is built from what the **server resolved**, not from the agent's spelling:
///
/// * `channel.create` — the channel's *name*, reduced: separators (`-`, `_`) dropped and trailing
///   digits stripped, so `qa`, `QA`, `qa2`, `qa-2` and `qa_02` are one proposal and a rejected
///   `qa` cannot be raised again as `qa2` (review M7). A name that is nothing but digits keeps
///   them. `qa-team` stays another proposal: it is another room.
/// * `channel.member.add` — the channel's id and the set of people's ids (sorted).
/// * `message.pin` / `message.unpin` — the message's id.
///
/// Ids are canonical, so they need no reduction; a name is the one thing an agent can respell.
pub fn initiative_key(action_id: &str, normalized: &Value, pins: &Value) -> String {
    let text = |value: Option<&Value>| value.and_then(Value::as_str).unwrap_or("").to_string();
    let rest = match action_id {
        ACTION_CHANNEL_CREATE => reduce_channel_name(&text(normalized.get("name"))),
        ACTION_CHANNEL_MEMBER_ADD => {
            let mut members: Vec<String> = pins
                .get("members")
                .and_then(Value::as_array)
                .map(|ids| {
                    ids.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            members.sort();
            format!("{}:{}", text(pins.get("channel")), members.join(","))
        }
        ACTION_MESSAGE_PIN | ACTION_MESSAGE_UNPIN => text(pins.get("message")),
        // Not an initiative action: nothing reaches here, but a key that cannot collide with
        // another action's is the safe answer (the whole normalised value).
        _ => normalized.to_string(),
    };
    format!("{action_id}:{rest}")
}

/// `qa`, `QA`, `qa2`, `qa-2`, `qa_02` → `qa`. See [`initiative_key`].
fn reduce_channel_name(name: &str) -> String {
    let compact: String = name
        .chars()
        .filter(|c| !matches!(c, '-' | '_'))
        .flat_map(char::to_lowercase)
        .collect();
    let stem = compact.trim_end_matches(|c: char| c.is_ascii_digit());
    if stem.is_empty() {
        compact
    } else {
        stem.to_string()
    }
}

/// What stands in the way of raising a proposal again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Blocker {
    /// The same proposal is waiting for its owner.
    Pending,
    /// A person rejected the same proposal less than [`COOLDOWN_SECONDS`] ago.
    Cooldown,
}

/// The statement [`find_blocker_in_tx`] runs (`$1` workspace, `$2` agent, `$3` key, `$4` the
/// cooldown in seconds) — public so a test can ask the planner about **this** text; its
/// `payload->>'origin' = 'agent_initiated'` is the predicate of `approval_initiative_idx`
/// (migration 155), spelled the same.
pub const FIND_BLOCKER_STATEMENT: &str = "SELECT status::text FROM approval \
          WHERE workspace_id = $1 AND requested_by = $2 \
            AND action_type = 'workspace_action' \
            AND payload->>'origin' = 'agent_initiated' \
            AND payload #>> '{initiative,key}' = $3 \
            AND ((status = 'pending' AND (expires_at IS NULL OR expires_at > now())) \
              OR (status = 'rejected' \
                  AND decided_at > now() - make_interval(secs => $4::double precision))) \
          ORDER BY (status = 'pending') DESC \
          LIMIT 1";

/// The first thing in the way of raising `key` again, if any: a **pending, unexpired** card of
/// this agent's with the same [`initiative_key`], or one a person **rejected** inside the cooldown.
/// An expired card is neither (nobody said no); an approved one is done.
///
/// Reads the key the producer stored in `payload.initiative.key` — computed from the server's
/// resolution, never from the agent's text — and only among cards that carry the unasked origin.
/// The windows are the database's clock, like the pending ceiling's.
pub async fn find_blocker_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    key: &str,
) -> Result<Option<Blocker>, DbError> {
    let status: Option<String> = sqlx::query_scalar(FIND_BLOCKER_STATEMENT)
        .bind(workspace_id)
        .bind(agent_member_id)
        .bind(key)
        .bind(COOLDOWN_SECONDS as f64)
        .fetch_optional(&mut *conn)
        .await?;
    Ok(status.map(|status| {
        if status == "pending" {
            Blocker::Pending
        } else {
            Blocker::Cooldown
        }
    }))
}

// ---------------------------------------------------------------------------
// the decision's re-proof (ADR-0186 증보 v5 U-d 「재증명」)
// ---------------------------------------------------------------------------

/// The part of the decision-time re-proof only the database can answer, for the connection the
/// card was raised through:
///
/// * that very connection is still **the agent's connection and still `active` and proved** — its
///   `status`, not the freshness of a credential: an OAuth connection's `active_token_id` is a
///   30-minute access token that is renewed on use, so a card that waited for its owner past the
///   token's expiry must not read as "the connection is gone" (security review of #4704 PR B, H1);
///   a connection torn down and made again is another id and is not this one;
/// * the human's approval of that connection still names `scope` (`workspace:initiate`);
/// * the **agent** is still an active member and its profile is not paused.
///
/// The owner is [`initiative_facts_in_tx`]'s; the switch is [`switch_is_on`]'s.
pub async fn initiative_standing_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    connection_id: Uuid,
    scope: &str,
) -> Result<bool, DbError> {
    let standing: bool = sqlx::query_scalar(
        "SELECT EXISTS ( \
           SELECT 1 FROM hosted_agent_connection hc \
             JOIN member m ON m.workspace_id = hc.workspace_id AND m.id = hc.agent_member_id \
             JOIN agent_profile ap \
               ON ap.workspace_id = hc.workspace_id AND ap.agent_member_id = hc.agent_member_id \
            WHERE hc.workspace_id = $1 AND hc.id = $2 AND hc.agent_member_id = $3 \
              AND hc.status = 'active' AND hc.proved_at IS NOT NULL \
              AND $4 = ANY(hc.approved_scopes) \
              AND m.kind = 'agent' AND m.status = 'active' AND m.deleted_at IS NULL \
              AND ap.paused = false)",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .bind(agent_member_id)
    .bind(scope)
    .fetch_one(&mut *conn)
    .await?;
    Ok(standing)
}

// ---------------------------------------------------------------------------
// the audit vocabulary (closed; no word an agent wrote, no argument, no name)
// ---------------------------------------------------------------------------

/// An unasked card was raised: actor the agent, subject its owner, target the approval.
pub const AUDIT_INITIATIVE_OPENED: &str = "agent.initiative.opened";
/// An unasked call was refused for one of nine reasons ([`RefusalReason`]).
pub const AUDIT_INITIATIVE_REFUSED: &str = "agent.initiative.refused";
/// `detail.schema` of both rows.
pub const INITIATIVE_AUDIT_SCHEMA: &str = "momo.agent.initiative.v1";

/// Why an unasked call was refused — the whole vocabulary, as the operator reads it. The agent is
/// told one of two things (`Unavailable` for the first six, `Conflict` for the next four,
/// `InvalidArguments` for the last), never which of these.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RefusalReason {
    /// Door 3: the workspace switch is off.
    SwitchOff,
    /// Door 4: no active human owner, or the owner did not confirm this connection (or the owner's
    /// direct message cannot be opened).
    NoOwner,
    /// Door 5: the owner could not decide this action now.
    OwnerCannotDecide,
    /// Door 6: a channel or message the owner could not already read.
    TargetUnavailable,
    /// The hourly or daily rate.
    RateLimited,
    /// The pending ceiling: three in all, or two unasked.
    PendingFull,
    /// The same proposal is already waiting.
    Duplicate,
    /// A person rejected the same proposal less than a day ago.
    Cooldown,
    /// The agent's own arguments: a name it cannot see, a value the domain refuses.
    InvalidArguments,
}

impl RefusalReason {
    /// Every reason, in the order the ADR lists them.
    pub const ALL: [RefusalReason; 9] = [
        RefusalReason::SwitchOff,
        RefusalReason::NoOwner,
        RefusalReason::OwnerCannotDecide,
        RefusalReason::TargetUnavailable,
        RefusalReason::RateLimited,
        RefusalReason::PendingFull,
        RefusalReason::Duplicate,
        RefusalReason::Cooldown,
        RefusalReason::InvalidArguments,
    ];

    /// The token written to `detail.reason` (and to `agent_initiative_refusal.reason`, whose
    /// CHECK lists the same nine).
    pub const fn code(self) -> &'static str {
        match self {
            RefusalReason::SwitchOff => "switch_off",
            RefusalReason::NoOwner => "no_owner",
            RefusalReason::OwnerCannotDecide => "owner_cannot_decide",
            RefusalReason::TargetUnavailable => "target_unavailable",
            RefusalReason::RateLimited => "rate_limited",
            RefusalReason::PendingFull => "pending_full",
            RefusalReason::Duplicate => "duplicate",
            RefusalReason::Cooldown => "cooldown",
            RefusalReason::InvalidArguments => "invalid_arguments",
        }
    }
}

/// Write the `agent.initiative.opened` row of a card that was just raised. Same transaction as the
/// card: a card that rolls back leaves no row claiming it stood.
#[allow(clippy::too_many_arguments)]
pub async fn record_opened_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    owner_member_id: Uuid,
    action_id: &str,
    approval_id: Uuid,
    run_id: Uuid,
    dm_created: bool,
) -> Result<(), DbError> {
    write_audit(
        conn,
        &AuditEntry::new(workspace_id, AUDIT_INITIATIVE_OPENED)
            .by(agent_member_id)
            .about(owner_member_id)
            .target("approval", approval_id)
            .run(run_id)
            .with_schema(
                INITIATIVE_AUDIT_SCHEMA,
                json!({
                    "action_id": action_id,
                    "approval_id": approval_id.to_string(),
                    "run_id": run_id.to_string(),
                    "dm_created": dm_created,
                }),
            ),
    )
    .await?;
    Ok(())
}

/// Record a refusal, **at most one row per (agent, reason) per hour** (review M5).
///
/// A refusal is cheap to repeat — an agent in a loop asks again every second — and an audit row per
/// ask would be the flood the ceilings exist to prevent, so the first refusal of a reason opens a
/// one-hour window and writes its row; every further one inside the window only raises a counter
/// (`agent_initiative_refusal.suppressed`, migration 155); and the first refusal **after** the
/// window writes its row carrying how many the last window held back (`detail.suppressed`, `0`
/// when none), then starts the next window. The counter lives in the database, so a restart or a
/// second replica cannot write a second row for one hour, and nothing is mutated that was already
/// written to `audit_log`.
///
/// The row holds a closed vocabulary and nothing else: the schema, the action's id from the
/// registry's closed list (`other` for none), the reason, and the count. No argument, no name, no
/// rationale, no id of anything the agent named.
///
/// Call it inside the agent's initiative advisory lock ([`lock_agent_initiative_in_tx`]): the
/// read-then-write of the window is serialised by it, and `FOR UPDATE` and `ON CONFLICT DO
/// NOTHING` are the belt. Returns whether a row was written.
pub async fn record_refused_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    action_id: Option<&str>,
    reason: RefusalReason,
) -> Result<bool, DbError> {
    let window = sqlx::query(
        "SELECT suppressed, window_started_at > now() - interval '1 hour' AS in_window \
           FROM agent_initiative_refusal \
          WHERE workspace_id = $1 AND agent_member_id = $2 AND reason = $3 \
            FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .bind(reason.code())
    .fetch_optional(&mut *conn)
    .await?;
    let carried: i32 = match &window {
        Some(row) => {
            let in_window: bool = row.try_get("in_window")?;
            if in_window {
                sqlx::query(
                    "UPDATE agent_initiative_refusal SET suppressed = suppressed + 1 \
                      WHERE workspace_id = $1 AND agent_member_id = $2 AND reason = $3",
                )
                .bind(workspace_id)
                .bind(agent_member_id)
                .bind(reason.code())
                .execute(&mut *conn)
                .await?;
                return Ok(false);
            }
            row.try_get("suppressed")?
        }
        None => {
            // The first refusal of this reason: open the window — and if another transaction
            // opened it between the read and here, this one is that window's suppressed call.
            let opened = sqlx::query(
                "INSERT INTO agent_initiative_refusal \
                   (workspace_id, agent_member_id, reason, window_started_at, suppressed) \
                 VALUES ($1, $2, $3, now(), 0) \
                 ON CONFLICT (workspace_id, agent_member_id, reason) DO NOTHING",
            )
            .bind(workspace_id)
            .bind(agent_member_id)
            .bind(reason.code())
            .execute(&mut *conn)
            .await?;
            if opened.rows_affected() == 0 {
                return Ok(false);
            }
            0
        }
    };
    if window.is_some() {
        // A window that has run out: the next one starts with this refusal, counter back to zero.
        sqlx::query(
            "UPDATE agent_initiative_refusal SET window_started_at = now(), suppressed = 0 \
              WHERE workspace_id = $1 AND agent_member_id = $2 AND reason = $3",
        )
        .bind(workspace_id)
        .bind(agent_member_id)
        .bind(reason.code())
        .execute(&mut *conn)
        .await?;
    }
    write_audit(
        conn,
        &AuditEntry::new(workspace_id, AUDIT_INITIATIVE_REFUSED)
            .by(agent_member_id)
            .with_schema(
                INITIATIVE_AUDIT_SCHEMA,
                json!({
                    "action_id": action_id.unwrap_or("other"),
                    "reason": reason.code(),
                    "suppressed": carried,
                }),
            ),
    )
    .await?;
    Ok(true)
}

/// Whether an approval payload is an unasked card.
pub fn is_agent_initiated(payload: &Value) -> bool {
    payload.get("origin").and_then(Value::as_str) == Some(APPROVAL_ORIGIN_AGENT_INITIATED)
}

/// Whether a run's input marks it as held for an unasked card.
pub fn is_held_for_agent_initiative(input: &Value) -> bool {
    input.get(RUN_HOLD_KEY).and_then(Value::as_str) == Some(RUN_HOLD_AGENT_INITIATED)
}

/// Whether a locked approval is a card an agent raised **unasked**, by **either** server-written
/// marker: the payload's `origin`, and the run's `input.hold` (written when the run is born).
/// A row whose `origin` was dropped is still an unasked card while its run says so — the decision
/// judges it by the unasked card's rules, and its audit rows say where it came from.
pub fn is_unasked_card(approval: &LockedApproval) -> bool {
    is_agent_initiated(&approval.payload) || is_held_for_agent_initiative(&approval.run_input)
}

/// The `detail` of a decision-side audit row (`action.approved`, the domain row,
/// `approval.rejected`, `approval.expired`) for the card `approval`.
///
/// A card a person asked for is returned exactly as it was. A card the agent raised **unasked**
/// gets two changes, both closed: `origin: "agent_initiated"` (one token the server wrote), and the
/// stored `payload` is **taken out** — the generic decision event carries the whole approval
/// payload, which for this card holds the agent's own words (`rationale`, the names it chose), and
/// ADR-0186 증보 v5 U-d says no decision-side row carries them (review of #4704 PR B, M2). What
/// remains is ids, the status, who decided and when. (The domain rows' own detail, ADR V6's, is the
/// executed fact and is not touched here beyond `origin`.) An `origin` the row already carries wins.
pub fn decision_audit_detail(approval: &LockedApproval, mut detail: Value) -> Value {
    if is_unasked_card(approval) {
        if let Some(object) = detail.as_object_mut() {
            object.remove("payload");
            object
                .entry("origin")
                .or_insert_with(|| Value::String(APPROVAL_ORIGIN_AGENT_INITIATED.into()));
        }
    }
    detail
}

/// `agent_run.input` of an unasked card's run: the hold marker and **nothing the agent wrote**.
pub fn initiative_run_input() -> Value {
    json!({ RUN_HOLD_KEY: RUN_HOLD_AGENT_INITIATED })
}

/// The sentence under the card's title. Says it was **not asked for**, then what approving does
/// and with whose authority. No name is baked in: the card is authored by the agent, and a name
/// copied into props goes stale after a rename (`actions::proposal_summary`'s reason).
pub fn initiative_summary(action: &WorkspaceAction) -> String {
    format!(
        "에이전트가 부탁받지 않고 먼저 제안했어요. 승인하면 {} 권한으로 {}.",
        action.required_role.korean(),
        action.effect_phrase()
    )
}

/// The facts of the door that only the database holds, read in the caller's transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InitiativeFacts {
    /// The agent's active human owner, who **confirmed this very connection** — the predicate
    /// under which `hosted_connection_channel_ids` covers the owner's direct message
    /// (migration 091, ADR-0162 증보 2 B6). The card is raised in that DM, so a connection
    /// confirmed by somebody else has no room to raise it in.
    pub owner_member_id: Uuid,
    /// `agent.max_run_steps`, the run's step ceiling (no step ever runs).
    pub max_run_steps: i32,
}

/// Condition 4 of the door (ADR-0186 증보 v5 U-b-4): the agent has an **active human owner** and
/// that owner confirmed this connection. `None` is the one answer for every way that fails.
pub async fn initiative_facts_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    connection_id: Uuid,
) -> Result<Option<InitiativeFacts>, DbError> {
    let row = sqlx::query(
        "SELECT a.owner_human_id, a.max_run_steps \
           FROM hosted_agent_connection hc \
           JOIN agent a \
             ON a.workspace_id = hc.workspace_id AND a.member_id = hc.agent_member_id \
           JOIN member o \
             ON o.workspace_id = a.workspace_id AND o.id = a.owner_human_id \
            AND o.kind = 'human' AND o.status = 'active' AND o.deleted_at IS NULL \
           JOIN workspace_membership wm \
             ON wm.workspace_id = o.workspace_id AND wm.member_id = o.id \
          WHERE hc.workspace_id = $1 AND hc.id = $2 AND hc.agent_member_id = $3 \
            AND hc.confirmed_by = a.owner_human_id",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .bind(agent_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some(InitiativeFacts {
        owner_member_id: row.try_get("owner_human_id")?,
        max_run_steps: row.try_get("max_run_steps")?,
    }))
}

/// Serialise one agent's unasked-card calls — and every re-ask of one, and every proposal a person
/// asked for — behind a transaction-scoped **advisory** lock: two simultaneous calls of the same
/// `clientRequestId` cannot both read "not raised yet", and the ceilings (three waiting in all, two
/// unasked, the rate) cannot be outrun by concurrency.
///
/// An advisory lock and not a row lock on the agent's `member` row (`FOR NO KEY UPDATE`, which
/// `lock_agent_and_count_pending_workspace_actions_in_tx` takes for the proposals a person asked
/// for): that row lock is exclusive against the `FOR SHARE` that every message write, every decision's
/// wake and every identity proof takes on the same row, so it formed lock cycles with all of them —
/// and, taken after the share lock the identity proof already holds, it made two simultaneous calls of
/// one agent wait on each other every time (a share-to-exclusive upgrade). Only two producers take
/// this key — the unasked-card door, and a person's proposal (`oort_action_propose`, which counts
/// the same three places and so must not interleave with it) — and both take it **first**, before
/// any share lock, so it can wait on nothing but the agent's own other calls.
pub async fn lock_agent_initiative_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
) -> Result<(), DbError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))")
        .bind(initiative_lock_key(workspace_id, agent_member_id))
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// The text [`lock_agent_initiative_in_tx`] hashes into its advisory lock — one definition, so a
/// test that holds the lock from outside (to show which producers wait on it) holds **this** key
/// and not a copy of it.
pub fn initiative_lock_key(workspace_id: Uuid, agent_member_id: Uuid) -> String {
    format!("oort:initiative:{workspace_id}:{agent_member_id}")
}

/// What the database holds about the unasked card one `clientRequestId` produced.
#[derive(Debug, Clone, PartialEq)]
pub struct InitiativeRecord {
    pub approval_id: Uuid,
    /// As stored: `pending | approved | rejected | expired | cancelled`.
    pub status: String,
    pub expires_at: Option<DateTime<Utc>>,
    pub decided_at: Option<DateTime<Utc>>,
    pub action_id: Option<String>,
    /// `payload.action.args`, the **normalised** arguments the card was drawn from.
    pub args: Value,
    /// `agent_run.output.ref` — set by the decision that executed the action.
    pub output_ref: Option<Value>,
}

/// The unasked card this agent raised under `client_request_id`, if any (the re-ask lookup).
///
/// Keyed by the run's idempotency key, which names the **agent**: one agent can never read
/// another's proposal, and no argument can aim it elsewhere.
pub async fn find_initiative_by_request_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    client_request_id: Uuid,
) -> Result<Option<InitiativeRecord>, DbError> {
    let key = RunTrigger::AgentInitiated {
        agent_member_id,
        client_request_id,
    }
    .idempotency_key();
    let row = sqlx::query(
        "SELECT a.id AS approval_id, a.status::text AS status, a.expires_at, a.decided_at, \
                a.payload, r.output \
           FROM agent_run r \
           JOIN approval a ON a.workspace_id = r.workspace_id AND a.run_id = r.id \
          WHERE r.workspace_id = $1 AND r.agent_member_id = $2 AND r.idempotency_key = $3 \
          LIMIT 1",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .bind(&key)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    let payload: Value = row.try_get("payload")?;
    let output: Option<Value> = row.try_get("output")?;
    Ok(Some(InitiativeRecord {
        approval_id: row.try_get("approval_id")?,
        status: row.try_get("status")?,
        expires_at: row.try_get("expires_at")?,
        decided_at: row.try_get("decided_at")?,
        action_id: payload
            .pointer("/action/id")
            .and_then(Value::as_str)
            .map(str::to_string),
        args: payload
            .pointer("/action/args")
            .cloned()
            .unwrap_or(Value::Null),
        output_ref: output.and_then(|output| output.get("ref").cloned()),
    }))
}

/// The answer to a re-ask: `{approvalId, status, expiresAtMs?, decidedAtMs?, ref?}`.
///
/// * `status` is [`effective_status`] on the **application's** clock — the very predicate the
///   decision route settles a late tap with — so a `pending` card past its deadline reads
///   `expired` before the sweep has written it down (ADR-0186 증보 v5 U-f).
/// * `expiresAtMs` only while it is `pending`; `decidedAtMs` only once somebody decided.
/// * `ref` only when `approved`, and never an id the agent was not told: a channel the agent
///   asked to be left out of (`addProposer:false`) is a private room it knows nothing of
///   (ADR-0186 증보 v5 U-d, review L3).
pub fn reask_answer(record: &InitiativeRecord, now: DateTime<Utc>) -> Value {
    let status = effective_status(&record.status, record.expires_at, now);
    let mut answer = json!({
        "approvalId": record.approval_id,
        "status": status,
    });
    if status == "pending" {
        if let Some(expires_at) = record.expires_at {
            answer["expiresAtMs"] = json!(expires_at.timestamp_millis());
        }
    }
    if let Some(decided_at) = record.decided_at {
        answer["decidedAtMs"] = json!(decided_at.timestamp_millis());
    }
    if status == "approved" {
        let agent_not_told = record.action_id.as_deref() == Some(ACTION_CHANNEL_CREATE)
            && record.args.get("addProposer").and_then(Value::as_bool) == Some(false);
        if let (false, Some(reference)) = (agent_not_told, record.output_ref.as_ref()) {
            answer["ref"] = reference.clone();
        }
    }
    answer
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn record(status: &str, expires_in: Option<i64>) -> InitiativeRecord {
        let now = Utc::now();
        InitiativeRecord {
            approval_id: Uuid::from_u128(7),
            status: status.to_string(),
            expires_at: expires_in.map(|seconds| now + Duration::seconds(seconds)),
            decided_at: None,
            action_id: Some("message.pin".into()),
            args: json!({"messageId": Uuid::nil()}),
            output_ref: None,
        }
    }

    #[test]
    fn an_unasked_card_waits_a_day() {
        // ADR-0186 증보 v5 U-d: 24 hours is what an unset `MOMO_AGENT_INITIATIVE_TTL_HOURS` means.
        assert_eq!(INITIATIVE_TTL_SECONDS, 86_400);
        assert_eq!(InitiativeLimits::default().ttl_seconds, 86_400);
    }

    #[test]
    fn the_origin_and_the_hold_are_read_only_from_their_own_keys() {
        assert!(is_agent_initiated(&json!({"origin": "agent_initiated"})));
        assert!(!is_agent_initiated(&json!({"origin": "server_in_place"})));
        assert!(!is_agent_initiated(
            &json!({"action": {"origin": "agent_initiated"}})
        ));
        assert!(is_held_for_agent_initiative(&initiative_run_input()));
        assert!(!is_held_for_agent_initiative(
            &json!({"hold": "channel_grant"})
        ));
        // The run's input carries the marker and nothing an agent wrote.
        assert_eq!(initiative_run_input(), json!({"hold": "agent_initiated"}));
    }

    #[test]
    fn a_pending_card_past_its_deadline_reads_expired_and_an_open_one_shows_its_deadline() {
        let now = Utc::now();
        let lapsed = reask_answer(&record("pending", Some(-1)), now);
        assert_eq!(lapsed["status"], "expired");
        assert!(lapsed.get("expiresAtMs").is_none());
        let open = reask_answer(&record("pending", Some(3_600)), now);
        assert_eq!(open["status"], "pending");
        assert!(open["expiresAtMs"].is_i64());
        // A settled card keeps what it was settled as, whatever its deadline says.
        assert_eq!(
            reask_answer(&record("rejected", Some(-1)), now)["status"],
            "rejected"
        );
    }

    /// The proposal is "the same one" by what the server resolved, and a name is the one thing an
    /// agent can respell (review M7): the table is the rule.
    #[test]
    fn a_channel_name_is_reduced_so_a_respelling_is_the_same_proposal() {
        let key = |name: &str| {
            initiative_key(ACTION_CHANNEL_CREATE, &json!({ "name": name }), &json!({}))
        };
        let qa = key("qa");
        for same in [
            "QA", "qa2", "qa-2", "qa_2", "qa-02", "q-a", "Qa_10", "qa--2",
        ] {
            assert_eq!(key(same), qa, "{same} is a respelling of qa");
        }
        for other in ["qa-team", "qb", "q", "team-qa", "release"] {
            assert_ne!(key(other), qa, "{other} is another room");
        }
        // Nothing but digits keeps them: `2024` and `2025` are not one proposal.
        assert_ne!(key("2024"), key("2025"));
        assert_eq!(key("team-2024"), key("team-2025"));
        // The action is part of the key: the same words for another action are another proposal.
        assert_ne!(
            initiative_key(ACTION_MESSAGE_PIN, &json!({}), &json!({"message": "m"})),
            initiative_key(ACTION_MESSAGE_UNPIN, &json!({}), &json!({"message": "m"})),
        );
    }

    #[test]
    fn ids_are_the_key_of_a_member_add_and_a_pin_and_their_order_does_not_matter() {
        let channel = Uuid::from_u128(1).to_string();
        let (a, b) = (
            Uuid::from_u128(2).to_string(),
            Uuid::from_u128(3).to_string(),
        );
        let add = |members: Value| {
            initiative_key(
                ACTION_CHANNEL_MEMBER_ADD,
                &json!({}),
                &json!({"channel": channel, "members": members}),
            )
        };
        assert_eq!(add(json!([a, b])), add(json!([b, a])));
        assert_ne!(add(json!([a, b])), add(json!([a])));
        let pin = |message: &str| {
            initiative_key(ACTION_MESSAGE_PIN, &json!({}), &json!({"message": message}))
        };
        assert_eq!(pin(&a), pin(&a));
        assert_ne!(pin(&a), pin(&b));
    }

    /// `MOMO_AGENT_INITIATIVE_PER_HOUR` / `_PER_DAY` / `_TTL_HOURS`: inside their ranges whatever
    /// the environment says (review L6).
    #[test]
    fn the_operators_numbers_are_inside_their_ranges_whatever_the_environment_says() {
        let read = |hour, day, ttl| InitiativeLimits::from_env_values(hour, day, ttl);
        // Unset or blank: the defaults of the ADR (6 an hour, 20 a day, a day's wait).
        let (limits, readings) = read(None, Some("  "), Some(""));
        assert_eq!(
            limits,
            InitiativeLimits {
                per_hour: 6,
                per_day: 20,
                ttl_seconds: 86_400
            }
        );
        assert_eq!(readings, [LimitReading::Unset; 3]);
        // In range: as written (whitespace is an env file's newline, not a typo).
        let (limits, readings) = read(Some(" 3 "), Some("50"), Some("48"));
        assert_eq!(
            limits,
            InitiativeLimits {
                per_hour: 3,
                per_day: 50,
                ttl_seconds: 48 * 3600
            }
        );
        assert_eq!(readings, [LimitReading::Valid; 3]);
        // Outside: the nearest bound, and the reading says what was asked. Zero and negative never
        // close the door by typo; a huge number never opens it past the range.
        let (limits, readings) = read(Some("0"), Some("-5"), Some("100000"));
        assert_eq!(
            (limits.per_hour, limits.per_day, limits.ttl_seconds),
            (1, 1, 168 * 3600)
        );
        assert_eq!(
            readings,
            [
                LimitReading::Clamped { requested: 0 },
                LimitReading::Clamped { requested: -5 },
                LimitReading::Clamped { requested: 100_000 },
            ]
        );
        let (limits, _) = read(Some("61"), Some("241"), Some("0"));
        assert_eq!(
            (limits.per_hour, limits.per_day, limits.ttl_seconds),
            (60, 240, 3600)
        );
        // Not a number: the default, and the reading says so.
        let (limits, readings) = read(Some("six"), Some("2.5"), Some("1e3"));
        assert_eq!(limits, InitiativeLimits::default());
        assert_eq!(readings, [LimitReading::Unparsable; 3]);
    }

    /// The nine reasons are the ADR's list and nothing else: closed, distinct, and written the way
    /// the table's CHECK (migration 155) spells them.
    #[test]
    fn the_refusal_reasons_are_the_nine_of_the_adr() {
        let codes: Vec<&str> = RefusalReason::ALL
            .iter()
            .map(|reason| reason.code())
            .collect();
        assert_eq!(
            codes,
            [
                "switch_off",
                "no_owner",
                "owner_cannot_decide",
                "target_unavailable",
                "rate_limited",
                "pending_full",
                "duplicate",
                "cooldown",
                "invalid_arguments",
            ]
        );
        let mut unique = codes.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), 9, "every code is its own");
    }

    /// The rate window counts by the prefix the producer writes: the two are one constant, and the
    /// key the producer builds starts with it.
    #[test]
    fn the_rate_window_counts_the_keys_the_producer_writes() {
        let key = RunTrigger::AgentInitiated {
            agent_member_id: Uuid::from_u128(9),
            client_request_id: Uuid::from_u128(10),
        }
        .idempotency_key();
        assert!(key.starts_with(RUN_KEY_PREFIX), "{key}");
        assert_eq!(RUN_KEY_PREFIX, "agent_initiated:");
    }

    /// Absent = on; a literal `true` = on; `false` and anything that is not a boolean = off; a
    /// workspace row this transaction cannot see = off.
    #[test]
    fn the_switch_is_on_only_when_absent_or_true() {
        assert!(switch_is_on(Some(&json!({}))));
        assert!(switch_is_on(Some(&json!({"agent_initiative": true}))));
        assert!(!switch_is_on(Some(&json!({"agent_initiative": false}))));
        for not_a_switch in [
            json!("false"),
            json!("true"),
            json!(0),
            json!(1),
            json!(null),
            json!([]),
        ] {
            assert!(
                !switch_is_on(Some(&json!({"agent_initiative": not_a_switch}))),
                "{not_a_switch} is not a switch somebody meant to leave on"
            );
        }
        assert!(!switch_is_on(None));
    }

    #[test]
    fn ref_is_only_for_an_approved_card_and_never_for_a_channel_the_agent_was_left_out_of() {
        let now = Utc::now();
        let reference = json!({"type": "message", "id": Uuid::nil()});
        let mut approved = record("approved", None);
        approved.output_ref = Some(reference.clone());
        assert_eq!(reask_answer(&approved, now)["ref"], reference);
        let mut pending = record("pending", Some(60));
        pending.output_ref = Some(reference.clone());
        assert!(reask_answer(&pending, now).get("ref").is_none());
        let mut hidden = record("approved", None);
        hidden.action_id = Some(ACTION_CHANNEL_CREATE.into());
        hidden.args = json!({"name": "qa", "addProposer": false});
        hidden.output_ref = Some(json!({"type": "channel", "id": Uuid::nil()}));
        assert!(reask_answer(&hidden, now).get("ref").is_none());
        hidden.args = json!({"name": "qa", "addProposer": true});
        assert!(reask_answer(&hidden, now).get("ref").is_some());
    }
}
