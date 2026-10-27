//! How often does a hosted agent come to the Agent Port? (ADR-0200 증보 6, #4621)
//!
//! A hosted agent is not a socket. The grok bot wakes on a routine (about every 15
//! minutes, three to six calls a wake) and sleeps in between, yet the screen read
//! `hostOnline = false` and said "the connection may be off" — which is not what happened:
//! the agent was waiting for its next beat. This module estimates that beat from facts the
//! server already keeps, so a screen can say "다음 확인 때 가져가요(보통 N분 안)" instead.
//!
//! ## The material
//!
//! `audit_log` rows `auth.agent_bearer.used` on the Agent Port path — one row per admitted
//! call, written in the authentication transaction, never capped, and present from before
//! this change. The two other materials the issue names cannot carry the estimate alone:
//!
//! * `agent_port.call` is capped at 240 rows per credential per hour (a fast poller would
//!   look like a slower one) and exists only since #4634;
//! * `oort_ping` leaves one value (`hosted_agent_liveness.last_ping_at`), so there is no
//!   history to take a median of.
//!
//! The rows are keyed by `actor_member_id` — the agent — not by token: an OAuth access
//! token is replaced every 30 minutes and each replacement is a new `token` row.
//!
//! ## The estimate ([`derive_cadence`], pure)
//!
//! 1. Calls inside the window ([`CadenceParams::window`], 24 h — the staleness bound: with
//!    no call inside it the answer is `unknown`).
//! 2. A silence longer than [`CadenceParams::wake_gap`] (5 min) ends a **wake**: the three to
//!    six calls of one routine run are one event, not five.
//! 3. `realtime` when the agent was present — never silent for more than the wake gap — for
//!    at least 80 % of a span of at least 30 minutes, **and is present now** (its newest call is
//!    no more than a wake gap old: the word is about this moment, so a poller that stopped
//!    reads `unknown`, not `realtime`). Such an agent has no beat to estimate: "connected / not
//!    connected" is the right question for it. Without this rule a poller that calls every 10
//!    seconds is one 24-hour wake, has no intervals, and reads `unknown`.
//! 4. Otherwise the **intervals between wake starts**; with fewer than
//!    [`CadenceParams::min_intervals`] (4, i.e. five wakes) the answer is `unknown`.
//! 5. The **median** interval `M` is the beat — if it holds two things. `M` is at most
//!    [`CadenceParams::max_beat`] (90 min): a longer "beat" is a handful of wakes that happen to
//!    look regular. And at least 70 % of the intervals lie within ±50 % of `M`: an agent that
//!    wakes whenever someone writes has no beat, and the answer is `unknown`, not a made-up
//!    "보통 40분".
//! 6. `routine`: `typical_minutes` = `M` rounded to the nearest minute; `expected_check_at`
//!    = start of the newest wake + 2 × `M`; `late` = no call for more than 3 × `M`.
//!
//! The 70 % and the 90 minutes were chosen by simulation (ADR-0200 증보 6): on random wakes with
//! no schedule at all, 60 % and no ceiling called 9-47 % of the days a routine; 70 % and 90
//! minutes call 0.6-2.7 %, while a 15-minute routine with the measured 10-29 minute jitter is
//! still read as one on 90 % of days after 1.5 hours of history and on 100 % after a day.
//!
//! The 2× in step 6 is the allowance the screen needs. Half of all intervals are longer than
//! their median, so a deadline at `+ M` would flag a healthy routine as "못 가져감" on every
//! slow wake; 15-minute routines were measured at 10–29 minutes (#4284), and the same ratio
//! (30 = 2 × 15) is the sweep's `woken_not_collected` rule (증보 3 E2). The 3× is the issue's
//! "박자가 끊김" line. `late` is measured from the newest **call** (a sign of life) and the
//! deadline from the newest wake **start** (the beat is start to start): an agent working a
//! 50-minute job is calling, so it is not late.
//!
//! Nothing here changes a state: [`crate::derive_liveness`], the stall sweep and
//! [`crate::collected_since`] are untouched. A cadence is something to show, not an input to a
//! transition.

use std::collections::HashMap;

use chrono::{DateTime, Duration, Utc};
use momo_db::DbError;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

/// `audit_log.action` of one admitted Agent Port call. Restated here because this crate does
/// not depend on `momo-auth`, where the writer's constant (`AUDIT_ACTION_USED`) lives; the
/// server crate's unit test and the PG suite lock the two together.
pub const AGENT_PORT_CALL_ACTION: &str = "auth.agent_bearer.used";

/// `detail.path` of an Agent Port call. A hosted credential is only admitted on its own
/// audience, so for a hosted agent this is every `used` row it has; the filter is a second
/// line of defence (a REST call by some other credential of the same member is not a check).
pub const AGENT_PORT_CALL_PATH: &str = "/v1/mcp/agent-port";

/// The closed vocabulary (`cadence.kind` on the wire).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CadenceKind {
    /// Near-continuous presence, and present now: ask "is it connected", not "when does it
    /// next check".
    Realtime,
    /// Periodic: wakes about every `typical_minutes`.
    Routine,
    /// Not enough evidence, not periodic, or nothing recent. Honest "모름".
    Unknown,
}

impl CadenceKind {
    pub fn as_wire(self) -> &'static str {
        match self {
            CadenceKind::Realtime => "realtime",
            CadenceKind::Routine => "routine",
            CadenceKind::Unknown => "unknown",
        }
    }
}

/// Every number behind the estimate. Constants, not environment: nothing here is a knob an
/// operator needs, and a typo must not be able to make every agent look late.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CadenceParams {
    /// How far back a call still counts. Also the staleness bound: an agent silent for the
    /// whole window has no samples and reads `unknown`.
    pub window: Duration,
    /// Newest calls returned per agent. Also the ceiling on the rows READ (within a factor of about
    /// two: the agent's rows that are not calls are skipped) because the loader forces an ordered
    /// scan; see [`load_agent_call_times_in_tx`].
    pub max_calls: i64,
    /// A silence longer than this ends a wake.
    pub wake_gap: Duration,
    /// Intervals (wakes − 1) needed before a beat is claimed.
    pub min_intervals: usize,
    /// An interval is on the beat when within `M ± this` percent.
    pub on_beat_band_percent: i64,
    /// This share of the intervals must be on the beat.
    pub on_beat_share_percent: i64,
    /// A beat longer than this is not claimed.
    pub max_beat: Duration,
    /// `expected_check_at` = newest wake start + this many beats.
    pub expected_after_beats: i64,
    /// `late` when silent for more than this many beats.
    pub late_after_beats: i64,
    /// `realtime` needs at least this long a span between the first and last call …
    pub realtime_min_span: Duration,
    /// … and presence (gaps no longer than `wake_gap`) for this share of it.
    pub realtime_presence_percent: i64,
}

impl Default for CadenceParams {
    fn default() -> Self {
        CadenceParams {
            window: Duration::hours(24),
            max_calls: 2000,
            wake_gap: Duration::minutes(5),
            min_intervals: 4,
            on_beat_band_percent: 50,
            on_beat_share_percent: 70,
            max_beat: Duration::minutes(90),
            expected_after_beats: 2,
            late_after_beats: 3,
            realtime_min_span: Duration::minutes(30),
            realtime_presence_percent: 80,
        }
    }
}

/// The derived answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cadence {
    pub kind: CadenceKind,
    /// `Routine` only: the median beat, in whole minutes (at least 1).
    pub typical_minutes: Option<i64>,
    /// `Routine` only: when a still-waiting request should stop being explained by the beat.
    pub expected_check_at: Option<DateTime<Utc>>,
    /// `Routine` only: no call for more than three beats. Always `false` for the others.
    pub late: bool,
    /// How many intervals the estimate stood on (0 unless a beat was looked for).
    pub intervals: usize,
}

impl Cadence {
    pub fn unknown() -> Cadence {
        Cadence {
            kind: CadenceKind::Unknown,
            typical_minutes: None,
            expected_check_at: None,
            late: false,
            intervals: 0,
        }
    }

    fn realtime() -> Cadence {
        Cadence {
            kind: CadenceKind::Realtime,
            ..Cadence::unknown()
        }
    }
}

/// Median of a non-empty list of positive durations, in milliseconds (the mean of the two
/// middle values when the count is even).
fn median_ms(sorted: &[i64]) -> i64 {
    let mid = sorted.len() / 2;
    if sorted.len() % 2 == 1 {
        sorted[mid]
    } else {
        (sorted[mid - 1] + sorted[mid]) / 2
    }
}

/// Estimate the beat from the times of one agent's admitted Agent Port calls (any order).
///
/// `now` is passed in, never read, so every boundary is testable.
pub fn derive_cadence(
    now: DateTime<Utc>,
    calls: &[DateTime<Utc>],
    params: &CadenceParams,
) -> Cadence {
    let mut times: Vec<DateTime<Utc>> = calls
        .iter()
        .copied()
        .filter(|at| now - *at <= params.window)
        .collect();
    times.sort_unstable();
    let (Some(&first), Some(&last_call)) = (times.first(), times.last()) else {
        return Cadence::unknown();
    };

    // Presence: time spent in gaps no longer than a wake gap, over the whole observed span.
    //
    // `realtime` is a statement about NOW — a screen reads it as "connected right now" — so the
    // agent must still be present: no more than a wake gap of silence up to `now`, the same
    // yardstick that makes a pause between two calls a silence. A poller that stopped an hour
    // ago was realtime then; it has no beat either, so it falls through and reads `unknown`.
    let span_ms = (last_call - first).num_milliseconds();
    let present_now = now - last_call <= params.wake_gap;
    if present_now && span_ms >= params.realtime_min_span.num_milliseconds() {
        let present_ms: i64 = times
            .windows(2)
            .map(|pair| pair[1] - pair[0])
            .filter(|gap| *gap <= params.wake_gap)
            .map(|gap| gap.num_milliseconds())
            .sum();
        if present_ms * 100 >= span_ms * params.realtime_presence_percent {
            return Cadence::realtime();
        }
    }

    // Wakes: a call within one wake gap of the previous call belongs to the same wake.
    let mut starts: Vec<DateTime<Utc>> = Vec::new();
    let mut previous: Option<DateTime<Utc>> = None;
    for at in &times {
        if previous.is_none_or(|before| *at - before > params.wake_gap) {
            starts.push(*at);
        }
        previous = Some(*at);
    }

    let mut intervals: Vec<i64> = starts
        .windows(2)
        .map(|pair| (pair[1] - pair[0]).num_milliseconds())
        .collect();
    let count = intervals.len();
    if count < params.min_intervals.max(1) {
        return Cadence {
            intervals: count,
            ..Cadence::unknown()
        };
    }
    intervals.sort_unstable();
    let beat_ms = median_ms(&intervals);

    // A beat this long is a few wakes that happen to look regular, not a routine to promise on.
    if beat_ms > params.max_beat.num_milliseconds() {
        return Cadence {
            intervals: count,
            ..Cadence::unknown()
        };
    }

    // Periodic? An agent that wakes whenever somebody writes has intervals all over the place.
    let low = beat_ms * (100 - params.on_beat_band_percent);
    let high = beat_ms * (100 + params.on_beat_band_percent);
    let on_beat = intervals
        .iter()
        .filter(|interval| **interval * 100 >= low && **interval * 100 <= high)
        .count() as i64;
    if on_beat * 100 < count as i64 * params.on_beat_share_percent {
        return Cadence {
            intervals: count,
            ..Cadence::unknown()
        };
    }

    let Some(&newest_wake_start) = starts.last() else {
        return Cadence::unknown();
    };
    // `checked_`: a plain `+` panics near chrono's last instant, and a request must not. A
    // deadline that cannot be told leaves no routine to promise: `routine` always carries all
    // three numbers on the wire, so the answer is `unknown`, not a half-empty routine.
    let Some(expected_check_at) = newest_wake_start.checked_add_signed(Duration::milliseconds(
        beat_ms * params.expected_after_beats,
    )) else {
        return Cadence {
            intervals: count,
            ..Cadence::unknown()
        };
    };
    let silence_ms = (now - last_call).num_milliseconds();
    Cadence {
        kind: CadenceKind::Routine,
        typical_minutes: Some(((beat_ms + 30_000) / 60_000).max(1)),
        expected_check_at: Some(expected_check_at),
        late: silence_ms > beat_ms * params.late_after_beats,
        intervals: count,
    }
}

/// How long one beat read may run before it is cancelled (and the beat reads `unknown`). The read
/// is a nicety on routes that must keep answering; it never gets to hold a pool connection longer.
pub const CALL_READ_TIMEOUT: &str = "2s";

/// The read, one statement for every agent asked about. Per agent: the agent's own admitted calls
/// ([`AGENT_PORT_CALL_ACTION`] on [`AGENT_PORT_CALL_PATH`]) newer than `$5` AND no older than the
/// agent's current connection (see "the era" on [`load_agent_call_times_in_tx`]), newest first,
/// at most `$6`. The connection chosen is the one the liveness route chooses for the same agent
/// (`liveness_target_for_viewer_in_tx`: an active one before an inactive one, then the newest);
/// an agent with no connection row has no entry.
///
/// The era bound MUST stay a bare outer column (`e.era_start`), never wrapped in `COALESCE` or a
/// scalar subselect: only then does the planner make it an index condition, so the ordered scan
/// stops at the era instead of reading every older row of the agent just to discard it. The PG
/// suite measures this on an agent whose connection is new and whose older rows are many, **as the
/// application role under RLS**: the same statement is an index condition for the superuser and a
/// filter for `momo_app`, so a measurement taken as the superuser cannot see the regression.
pub const CALL_TIMES_SQL: &str = "\
    SELECT a.agent_id, c.created_at \
      FROM unnest($2::uuid[]) AS a(agent_id) \
      CROSS JOIN LATERAL ( \
            SELECT hc.created_at AS era_start FROM hosted_agent_connection hc \
             WHERE hc.workspace_id = $1 AND hc.agent_member_id = a.agent_id \
             ORDER BY (hc.status = 'active') DESC, hc.created_at DESC \
             LIMIT 1) e \
      CROSS JOIN LATERAL ( \
            SELECT al.created_at FROM audit_log al \
             WHERE al.workspace_id = $1 \
               AND al.actor_member_id = a.agent_id \
               AND al.action = $3 \
               AND al.detail->>'path' = $4 \
               AND al.created_at > $5 \
               AND al.created_at >= e.era_start \
             ORDER BY al.created_at DESC \
             LIMIT $6) c";

/// The times of each agent's admitted Agent Port calls since `since`, newest first, at most
/// `per_agent_limit` each. An agent with no such call has no entry.
///
/// The one `audit_log` read of this feature (the thirteenth in the server; the other twelve are
/// each narrowed to one action or one run). It is narrowed to the agent (`actor_member_id`,
/// so `audit_actor_idx` carries the range), the action, the path and the window — and to the
/// tenant twice over: the explicit `workspace_id` and the caller's `app.workspace_id` (RLS).
/// Only the derived [`Cadence`] ever leaves the server; no row does.
///
/// **The era.** Calls are counted from the creation of the agent's current connection, not from
/// the start of the window: the rows are keyed by the agent (an OAuth token is replaced every 30
/// minutes), and a disconnected agent can be registered again as a NEW connection on a new host.
/// Without the lower bound the new connection would inherit the old one's beat the moment it
/// went `active`, and a screen would promise "보통 15분 안" for a host that has never called.
///
/// **The bound on the work.** `per_agent_limit` is a ceiling on the rows RETURNED; it bounds the
/// rows READ only if the plan walks `audit_actor_idx` in order and stops. The planner does not
/// do that by itself: it estimates an agent's rows from the average over all actors, expects a
/// handful, and picks a bitmap scan plus a sort that reads every row the agent made in the window
/// (a polling agent makes up to ~690,000 a day). So the read runs with bitmap scans off and
/// under [`CALL_READ_TIMEOUT`], inside its own savepoint:
///
/// * the two `SET LOCAL`s are undone with the savepoint and never leak into the route's own
///   queries;
/// * a read that fails or times out does not abort the route's transaction. The outer `Result`
///   is the savepoint machinery (an error there means the transaction is unusable: propagate);
///   the inner `Result` is the read itself, and its `Err` means "no beat can be told": the
///   caller logs it and reads `unknown`. A beat is something to show; it must not take the
///   liveness route, which the admin uses to reach "disconnect", down with it.
pub async fn load_agent_call_times_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_ids: &[Uuid],
    since: DateTime<Utc>,
    per_agent_limit: i64,
) -> Result<Result<HashMap<Uuid, Vec<DateTime<Utc>>>, DbError>, DbError> {
    // A repeated id would be unnested twice and every call time pushed twice.
    let mut agent_ids = agent_member_ids.to_vec();
    agent_ids.sort_unstable();
    agent_ids.dedup();
    if agent_ids.is_empty() {
        return Ok(Ok(HashMap::new()));
    }
    sqlx::query("SAVEPOINT cadence_read")
        .execute(&mut *conn)
        .await?;
    let read = read_call_times(conn, workspace_id, &agent_ids, since, per_agent_limit).await;
    // Whatever the read did, return the transaction to how it was: this reverts both SET LOCALs
    // and, after an error or a timeout, clears the aborted state.
    sqlx::query("ROLLBACK TO SAVEPOINT cadence_read")
        .execute(&mut *conn)
        .await?;
    sqlx::query("RELEASE SAVEPOINT cadence_read")
        .execute(&mut *conn)
        .await?;
    Ok(read)
}

async fn read_call_times(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_ids: &[Uuid],
    since: DateTime<Utc>,
    per_agent_limit: i64,
) -> Result<HashMap<Uuid, Vec<DateTime<Utc>>>, DbError> {
    sqlx::query("SET LOCAL enable_bitmapscan = off")
        .execute(&mut *conn)
        .await?;
    sqlx::query(&format!(
        "SET LOCAL statement_timeout = '{CALL_READ_TIMEOUT}'"
    ))
    .execute(&mut *conn)
    .await?;
    let rows = sqlx::query(CALL_TIMES_SQL)
        .bind(workspace_id)
        .bind(agent_ids)
        .bind(AGENT_PORT_CALL_ACTION)
        .bind(AGENT_PORT_CALL_PATH)
        .bind(since)
        .bind(per_agent_limit)
        .fetch_all(&mut *conn)
        .await?;
    let mut by_agent: HashMap<Uuid, Vec<DateTime<Utc>>> = HashMap::new();
    for row in &rows {
        by_agent
            .entry(row.try_get::<Uuid, _>("agent_id")?)
            .or_default()
            .push(row.try_get::<DateTime<Utc>, _>("created_at")?);
    }
    Ok(by_agent)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: i64 = 60;

    /// `now` is far from the epoch so no fixture sits near a window edge by accident.
    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-27T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    fn ago(seconds: i64) -> DateTime<Utc> {
        now() - Duration::seconds(seconds)
    }

    /// One routine wake: the first call `start` seconds ago, each next call `spread[i]`
    /// seconds after the one before (a model thinking between tool calls: 8 to 55 s).
    fn wake(start: i64, spread: &[i64]) -> Vec<DateTime<Utc>> {
        let mut at = start;
        let mut out = vec![ago(at)];
        for step in spread {
            at -= step;
            out.push(ago(at));
        }
        out
    }

    /// Wakes whose starts are `intervals_newest_first[i]` minutes apart, the newest one starting
    /// `newest_ago` seconds ago. Each wake has a different number of calls and spacing (3 to 6
    /// calls, 8 to 55 s apart, 29 to 133 s long), the way a real routine's wakes differ.
    ///
    /// Keep every interval at 8 minutes or more: a wake can run 133 s, and the next wake must
    /// begin more than the 5-minute wake gap after it ends, or the two are one wake by design.
    fn wakes_with_intervals(newest_ago: i64, intervals_newest_first: &[i64]) -> Vec<DateTime<Utc>> {
        let shapes: [&[i64]; 4] = [
            &[8, 21],
            &[12, 31, 9, 55],
            &[17, 40, 14],
            &[10, 25, 33, 46, 19],
        ];
        let mut calls = Vec::new();
        let mut start = newest_ago;
        for (n, minutes) in std::iter::once(&0)
            .chain(intervals_newest_first.iter())
            .enumerate()
        {
            start += minutes * MIN;
            calls.extend(wake(start, shapes[n % shapes.len()]));
        }
        calls
    }

    /// Intervals a real 15-minute routine produced (#4284: 10-29 min, median 15), in an order
    /// that is not sorted. Median 15, mean 16.8: the two differ on purpose.
    const REAL_15: [i64; 5] = [29, 15, 10, 16, 14];

    fn p() -> CadenceParams {
        CadenceParams::default()
    }

    fn newest_call(calls: &[DateTime<Utc>]) -> DateTime<Utc> {
        calls.iter().max().copied().unwrap()
    }

    #[test]
    fn a_fifteen_minute_routine_reads_routine_fifteen_not_the_mean_and_not_the_raw_call_gaps() {
        // newest wake began 4 minutes ago: well inside the beat
        let calls = wakes_with_intervals(4 * MIN, &REAL_15);
        let cadence = derive_cadence(now(), &calls, &p());
        assert_eq!(cadence.kind, CadenceKind::Routine);
        assert_eq!(
            cadence.typical_minutes,
            Some(15),
            "median 15, not mean 16.8 -> 17"
        );
        assert_eq!(cadence.intervals, 5);
        assert!(!cadence.late);
        // newest wake start + 2 beats (30 min)
        assert_eq!(
            cadence.expected_check_at,
            Some(ago(4 * MIN) + Duration::minutes(30))
        );
    }

    #[test]
    fn the_median_is_the_mean_of_the_middle_two_when_the_count_is_even() {
        // 12, 14, 16, 18 minutes: the middle two are 14 and 16 -> 15
        let calls = wakes_with_intervals(2 * MIN, &[18, 12, 16, 14]);
        let cadence = derive_cadence(now(), &calls, &p());
        assert_eq!(cadence.typical_minutes, Some(15));
        assert_eq!(cadence.intervals, 4);
    }

    #[test]
    fn fewer_than_four_intervals_is_unknown_and_four_is_enough() {
        // three intervals = four wakes
        let calls = wakes_with_intervals(2 * MIN, &[15, 15, 15]);
        let cadence = derive_cadence(now(), &calls, &p());
        assert_eq!(cadence.kind, CadenceKind::Unknown);
        assert_eq!(cadence.intervals, 3);
        assert_eq!(cadence.typical_minutes, None);
        assert_eq!(cadence.expected_check_at, None);
        assert!(!cadence.late);
        // four intervals = five wakes
        let calls = wakes_with_intervals(2 * MIN, &[15, 15, 15, 15]);
        assert_eq!(
            derive_cadence(now(), &calls, &p()).kind,
            CadenceKind::Routine
        );
    }

    #[test]
    fn nothing_inside_the_window_is_unknown_and_a_stale_routine_is_late_not_forgotten() {
        assert_eq!(derive_cadence(now(), &[], &p()), Cadence::unknown());
        // a perfect 15-minute routine whose newest wake was 25 hours ago has nothing inside the window
        let calls = wakes_with_intervals(25 * 60 * MIN, &[15; 6]);
        assert_eq!(derive_cadence(now(), &calls, &p()), Cadence::unknown());
        // the same routine with its newest wake 22 hours ago is still a routine - and late
        let calls = wakes_with_intervals(22 * 60 * MIN, &[15; 6]);
        let cadence = derive_cadence(now(), &calls, &p());
        assert_eq!(cadence.kind, CadenceKind::Routine);
        assert!(cadence.late);
    }

    #[test]
    fn a_routine_silent_for_more_than_three_beats_is_late_and_exactly_three_is_not() {
        let calls = wakes_with_intervals(10 * MIN, &[15; 6]);
        let last = newest_call(&calls);
        let at_exactly_three = last + Duration::minutes(45);
        let cadence = derive_cadence(at_exactly_three, &calls, &p());
        assert_eq!(cadence.kind, CadenceKind::Routine);
        assert!(!cadence.late, "3 beats of silence is the edge, not past it");
        assert!(derive_cadence(at_exactly_three + Duration::seconds(1), &calls, &p()).late);
        // and a routine seen two minutes ago is not late
        assert!(!derive_cadence(last + Duration::minutes(2), &calls, &p()).late);
    }

    #[test]
    fn lateness_is_measured_from_the_newest_call_so_a_long_job_is_not_late() {
        // a regular 15-minute routine whose newest wake is a 50-minute job: a call every 2 minutes
        let mut calls = wakes_with_intervals(50 * MIN, &[15; 5]);
        for k in 0..=25 {
            calls.push(ago(50 * MIN - k * 2 * MIN));
        }
        let cadence = derive_cadence(now(), &calls, &p());
        assert_eq!(cadence.kind, CadenceKind::Routine);
        assert_eq!(cadence.intervals, 5);
        assert!(
            !cadence.late,
            "it is calling right now; measuring from the wake start (50 min > 3 beats) would call it late"
        );
    }

    #[test]
    fn a_call_stamped_a_moment_in_the_future_is_not_late_and_breaks_nothing() {
        // database and API clocks can disagree by a little
        let mut calls = wakes_with_intervals(4 * MIN, &REAL_15);
        calls.push(now() + Duration::seconds(30));
        let cadence = derive_cadence(now(), &calls, &p());
        assert_eq!(cadence.kind, CadenceKind::Routine);
        assert!(!cadence.late);
    }

    #[test]
    fn the_deadline_is_two_beats_after_the_newest_wake_start_not_one() {
        let calls = wakes_with_intervals(10 * MIN, &[15; 5]);
        let cadence = derive_cadence(now(), &calls, &p());
        assert_eq!(
            cadence.expected_check_at,
            Some(ago(10 * MIN) + Duration::minutes(30)),
            "one beat after would flag half of all healthy wakes"
        );
    }

    #[test]
    fn an_agent_that_wakes_whenever_somebody_writes_is_not_a_routine() {
        // intervals all over the place: 8, 25, 200, 14, 90, 9 minutes
        let calls = wakes_with_intervals(2 * MIN, &[9, 90, 14, 200, 25, 8]);
        let cadence = derive_cadence(now(), &calls, &p());
        assert_eq!(cadence.kind, CadenceKind::Unknown);
        assert_eq!(cadence.intervals, 6);
        assert_eq!(cadence.typical_minutes, None);
        assert_eq!(cadence.expected_check_at, None);
    }

    #[test]
    fn the_beat_share_edge_is_seventy_percent() {
        // 7 of 10 on the beat (70 %) is periodic
        let calls = wakes_with_intervals(2 * MIN, &[15, 15, 15, 15, 15, 15, 15, 60, 90, 120]);
        let cadence = derive_cadence(now(), &calls, &p());
        assert_eq!(cadence.kind, CadenceKind::Routine);
        assert_eq!(cadence.typical_minutes, Some(15));
        // 6 of 10 (60 %) is not
        let calls = wakes_with_intervals(2 * MIN, &[15, 15, 15, 15, 15, 15, 60, 90, 120, 200]);
        assert_eq!(
            derive_cadence(now(), &calls, &p()).kind,
            CadenceKind::Unknown
        );
    }

    #[test]
    fn a_beat_longer_than_ninety_minutes_is_not_claimed_and_ninety_is() {
        // an hourly-and-a-half cron, perfectly regular: the edge passes
        let calls = wakes_with_intervals(2 * MIN, &[90; 8]);
        let cadence = derive_cadence(now(), &calls, &p());
        assert_eq!(cadence.kind, CadenceKind::Routine);
        assert_eq!(cadence.typical_minutes, Some(90));
        // one more minute is a few wakes that happen to look regular
        let calls = wakes_with_intervals(2 * MIN, &[91; 8]);
        let cadence = derive_cadence(now(), &calls, &p());
        assert_eq!(cadence.kind, CadenceKind::Unknown);
        assert_eq!(cadence.intervals, 8, "it was a candidate, then refused");
        assert_eq!(cadence.typical_minutes, None);
        // a two-hour cron likewise
        let calls = wakes_with_intervals(2 * MIN, &[120; 8]);
        assert_eq!(
            derive_cadence(now(), &calls, &p()).kind,
            CadenceKind::Unknown
        );
    }

    #[test]
    fn the_measured_shape_of_a_fifteen_minute_routine_passes_the_gates() {
        // 36 gaps shaped like the #4284 measurement: 10-29 min, median 15, mean about 16.3. Real
        // jitter must not push a real routine into `unknown`: 32 of the 36 gaps (89 %) are on the beat.
        let mut gaps: Vec<i64> = Vec::new();
        for (minutes, times) in [
            (10, 3),
            (12, 4),
            (14, 5),
            (15, 8),
            (16, 5),
            (18, 4),
            (20, 3),
            (24, 2),
            (29, 2),
        ] {
            gaps.extend(std::iter::repeat_n(minutes, times));
        }
        assert_eq!(gaps.len(), 36);
        // an order that is not sorted
        gaps.rotate_left(11);
        let calls = wakes_with_intervals(3 * MIN, &gaps);
        let cadence = derive_cadence(now(), &calls, &p());
        assert_eq!(cadence.kind, CadenceKind::Routine);
        assert_eq!(cadence.typical_minutes, Some(15));
        assert_eq!(cadence.intervals, 36);
    }

    #[test]
    fn typical_minutes_rounds_to_the_nearest_minute() {
        // a scheduler that fires 7 s late every time: 15 min 7 s -> 15
        let mut calls = Vec::new();
        let mut start = 2 * MIN;
        for _ in 0..6 {
            calls.extend(wake(start, &[10, 20]));
            start += 15 * MIN + 7;
        }
        assert_eq!(
            derive_cadence(now(), &calls, &p()).typical_minutes,
            Some(15)
        );
        // 15 min 40 s -> 16
        let mut calls = Vec::new();
        let mut start = 2 * MIN;
        for _ in 0..6 {
            calls.extend(wake(start, &[10, 20]));
            start += 15 * MIN + 40;
        }
        assert_eq!(
            derive_cadence(now(), &calls, &p()).typical_minutes,
            Some(16)
        );
    }

    #[test]
    fn a_poller_is_realtime_and_twenty_minutes_of_it_is_not_enough_to_say_so() {
        // a call every 20 seconds for 40 minutes
        let steady: Vec<_> = (0..=120).map(|k| ago(40 * MIN - k * 20)).collect();
        let cadence = derive_cadence(now(), &steady, &p());
        assert_eq!(cadence.kind, CadenceKind::Realtime);
        assert_eq!(cadence.typical_minutes, None);
        assert_eq!(cadence.expected_check_at, None);
        assert!(!cadence.late);
        // the same poller seen for only 20 minutes: not enough evidence either way
        let brief: Vec<_> = (0..=60).map(|k| ago(20 * MIN - k * 20)).collect();
        assert_eq!(
            derive_cadence(now(), &brief, &p()).kind,
            CadenceKind::Unknown
        );
    }

    #[test]
    fn a_routine_that_once_ran_a_forty_minute_job_is_still_a_routine_not_realtime() {
        // regular 15-minute wakes, and 2 hours ago a 40-minute job with a call every 2 minutes
        let mut calls = wakes_with_intervals(3 * MIN, &[15, 15, 15, 15, 15, 15]);
        for k in 0..=20 {
            calls.push(ago(120 * MIN - k * 2 * MIN));
        }
        let cadence = derive_cadence(now(), &calls, &p());
        assert_ne!(
            cadence.kind,
            CadenceKind::Realtime,
            "one long wake among short ones is not continuous presence"
        );
    }

    #[test]
    fn a_poller_with_one_ten_minute_restart_is_still_realtime() {
        // 3 hours of a call every 30 s, with a 10-minute hole in the middle: present ~94 %
        let mut calls = Vec::new();
        for k in 0..=(3 * 60 * 2) {
            let at = ago(3 * 60 * MIN - k * 30);
            if !(ago(95 * MIN)..=ago(85 * MIN)).contains(&at) {
                calls.push(at);
            }
        }
        assert_eq!(
            derive_cadence(now(), &calls, &p()).kind,
            CadenceKind::Realtime
        );
    }

    #[test]
    fn a_poller_that_went_quiet_is_realtime_only_while_its_silence_is_within_a_wake_gap() {
        // a call every 20 seconds for 40 minutes; ask at different moments after the last one
        let steady: Vec<_> = (0..=120).map(|k| ago(40 * MIN - k * 20)).collect();
        let last = newest_call(&steady);
        let read_at = |silence: Duration| derive_cadence(last + silence, &steady, &p());
        assert_eq!(read_at(Duration::zero()).kind, CadenceKind::Realtime);
        assert_eq!(
            read_at(Duration::minutes(5)).kind,
            CadenceKind::Realtime,
            "5:00 of silence is still presence (the same edge that keeps two calls in one wake)"
        );
        // "realtime" is about this moment: one second past the wake gap it is gone, and so it
        // stays - an hour later, and 23 hours later while the calls are still inside the window
        assert_eq!(
            read_at(Duration::minutes(5) + Duration::seconds(1)),
            Cadence::unknown()
        );
        assert_eq!(read_at(Duration::hours(1)), Cadence::unknown());
        assert_eq!(read_at(Duration::hours(23)), Cadence::unknown());
    }

    #[test]
    fn the_on_beat_band_is_half_a_beat_either_side_and_both_edges_count() {
        // the median is 20 minutes in all four; four of ten intervals sit away from it
        let read = |intervals: &[i64]| {
            derive_cadence(now(), &wakes_with_intervals(4 * MIN, intervals), &p())
        };
        let around = |far: i64| {
            let mut intervals = vec![far; 4];
            intervals.extend([20; 6]);
            intervals
        };
        // exactly half a beat (10) and exactly one and a half beats (30) are on the beat
        assert_eq!(read(&around(10)).kind, CadenceKind::Routine);
        assert_eq!(read(&around(30)).kind, CadenceKind::Routine);
        // a minute outside either edge: six of ten is 60 %, under the 70 % share
        assert_eq!(read(&around(31)).kind, CadenceKind::Unknown);
        assert_eq!(read(&around(9)).kind, CadenceKind::Unknown);
    }

    #[test]
    fn realtime_needs_thirty_minutes_and_eighty_percent_presence_and_both_edges_count() {
        let kind = |calls: &[DateTime<Utc>]| derive_cadence(now(), calls, &p()).kind;
        // a call a minute, the newest now: a span of exactly 30 minutes is enough, 29 is not
        let steady =
            |minutes: i64| -> Vec<_> { (0..=minutes).map(|k| ago((minutes - k) * MIN)).collect() };
        assert_eq!(kind(&steady(30)), CadenceKind::Realtime);
        assert_eq!(kind(&steady(29)), CadenceKind::Unknown);
        // 40 minutes of a call a minute, then `silence` seconds with no call, then one call now:
        // 600 s of silence in a 3,000 s span is present exactly 80 % of the time, 601 s is not
        let after_silence = |silence: i64| -> Vec<_> {
            let mut calls: Vec<_> = (0..=40).map(|k| ago(silence + 2400 - k * 60)).collect();
            calls.push(ago(0));
            calls
        };
        assert_eq!(kind(&after_silence(600)), CadenceKind::Realtime);
        assert_eq!(kind(&after_silence(601)), CadenceKind::Unknown);
        // a call every 5:00 exactly is present (the edge that also keeps two calls in one wake)
        let every_five_minutes: Vec<_> = (0..=12).map(|k| ago(60 * MIN - k * 5 * MIN)).collect();
        assert_eq!(kind(&every_five_minutes), CadenceKind::Realtime);
    }

    #[test]
    fn a_call_exactly_a_day_old_is_inside_the_window_and_one_second_older_is_not() {
        // five single-call wakes 15 minutes apart, the oldest exactly 24 hours old (or a second more)
        let oldest = 24 * 60 * MIN;
        let five =
            |extra: i64| -> Vec<_> { (0..5).map(|k| ago(oldest + extra - k * 15 * MIN)).collect() };
        assert_eq!(derive_cadence(now(), &five(0), &p()).intervals, 4);
        assert_eq!(derive_cadence(now(), &five(1), &p()).intervals, 3);
    }

    #[test]
    fn a_deadline_that_cannot_be_told_is_unknown_not_a_routine_without_a_deadline() {
        // five single-call wakes 15 minutes apart, the newest one minute before chrono's last
        // instant: its deadline (+ 30 minutes) does not exist. A plain `+` would panic here, and a
        // routine without its deadline would break the wire's closed shape (a routine carries all
        // three numbers).
        let last = DateTime::<Utc>::MAX_UTC;
        let calls: Vec<_> = (0..5)
            .map(|k| last - Duration::minutes(1 + 15 * k))
            .collect();
        let cadence = derive_cadence(last, &calls, &p());
        assert_eq!(cadence.kind, CadenceKind::Unknown);
        assert_eq!(cadence.typical_minutes, None);
        assert_eq!(cadence.expected_check_at, None);
        assert!(!cadence.late);
        assert_eq!(cadence.intervals, 4, "the evidence is still counted");
    }

    #[test]
    fn a_silence_of_exactly_the_wake_gap_keeps_one_wake_and_one_second_more_splits_it() {
        // five wakes 15 minutes apart: four intervals
        let base = wakes_with_intervals(30 * MIN, &[15, 15, 15, 15]);
        let last = newest_call(&base);
        let mut inside = base.clone();
        inside.push(last + Duration::minutes(5));
        assert_eq!(
            derive_cadence(now(), &inside, &p()).intervals,
            4,
            "5:00 of silence is inside the wake"
        );
        let mut outside = base;
        outside.push(last + Duration::minutes(5) + Duration::seconds(1));
        assert_eq!(
            derive_cadence(now(), &outside, &p()).intervals,
            5,
            "5:01 of silence ends the wake"
        );
    }

    #[test]
    fn the_order_the_calls_arrive_in_does_not_matter() {
        let mut calls = wakes_with_intervals(4 * MIN, &REAL_15);
        let as_built = derive_cadence(now(), &calls, &p());
        calls.sort_unstable();
        let ascending = derive_cadence(now(), &calls, &p());
        calls.reverse();
        let descending = derive_cadence(now(), &calls, &p());
        assert_eq!(as_built, ascending);
        assert_eq!(ascending, descending);
    }

    #[test]
    fn the_wire_words_are_the_closed_vocabulary() {
        assert_eq!(CadenceKind::Realtime.as_wire(), "realtime");
        assert_eq!(CadenceKind::Routine.as_wire(), "routine");
        assert_eq!(CadenceKind::Unknown.as_wire(), "unknown");
    }
}
