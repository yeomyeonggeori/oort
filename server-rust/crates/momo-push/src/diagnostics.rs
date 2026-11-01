//! 알림 진단과 시험 알림의 서버 쪽 (ADR-0206 D11, #4341) — 「왜 알림이 안 와요」를 닫힌 코드로.
//!
//! Two halves, one subject (the caller's own push path):
//!
//! * **Read** — [`compute_diagnostics`]: the blockers the *server* can know, as the closed set of
//!   [`BlockerCode`], plus the device counts and the result of the last test push. `ok` means "the
//!   server holds nothing back" — **not** "the device shows it": the OS permission, the per-device
//!   switch and Focus are known only to the client (#4295).
//! * **Write** — [`reserve_test_push_in_tx`]: the test push's per-member per-minute budget and
//!   `last_test_*`, taken under one row lock on the caller's `notification_rule` row. The route
//!   writes the `push_system` outbox row in the same transaction.
//!
//! ## What the diagnostics read, and why it is inference
//!
//! The api process has no relay client and no APNs knowledge; it reads what the notifier left in
//! `push_dispatch_log`. So `relay_unreachable` is **inferred** (a claim that stayed unsettled for
//! minutes, or a test push nobody processed), and `last_delivery_failed` reports the latest settled
//! row. Both read only the member's **current active tokens'** rows from the last days — an old
//! token's failure or an old 410 must not stay on the screen after the person fixed it — and skip
//! the bulk layer's drop rows ([`RELAY_DROPPED_REASON`]): a drop is the server's own choice to send
//! fewer pushes, not a delivery failure.
//!
//! ## Nothing here quotes the relay
//!
//! `apns_reason` in the log can hold the start of a relay's refusal text. [`apns_reason_code`] turns
//! it into a **code** before it leaves this module, so a response never carries a relay's prose.
//!
//! `kind_off` (N3) and `quiet_hours` (N7) are part of the closed set but this module never emits
//! them: the conditions they report (a per-kind switch, a work-hours schedule) are stored by later
//! slices, so until then they do not exist for a member — and a test pins that.

use chrono::{DateTime, Utc};
use momo_db::DbError;
use momo_messaging::pause_in_force;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::dispatch_log::RELAY_DROPPED_REASON;

/// Test pushes one member may send per window (ADR-0206 D11: 「멤버당 분당 3회」).
pub const TEST_PUSH_PER_WINDOW: i16 = 3;

/// The test push's rate window: a fixed 60 seconds that starts at the first test of the window.
pub const TEST_PUSH_WINDOW_SECS: i64 = 60;

/// A test push with no settled record is `queued` until it is this old and `stalled` from then on.
/// A stalled test also makes `relay_unreachable` (the notifier may be off).
pub const TEST_STALLED_AFTER_SECS: f64 = 30.0;

/// A claimed-but-unsettled dispatch this old is no longer "in flight": it is `relay_unreachable`.
pub const UNSETTLED_AFTER_SECS: f64 = 120.0;

/// `relay_unreachable` looks only this far back (15 minutes). A stalled test or an unsettled claim
/// older than this says nothing about the relay now, and would otherwise stay on the screen forever.
pub const RELAY_LOOKBACK_SECS: f64 = 15.0 * 60.0;

/// `last_delivery_failed` looks only this far back (7 days).
pub const DELIVERY_LOOKBACK_SECS: f64 = 7.0 * 24.0 * 3600.0;

/// What the relay's closed-vocabulary refusal says (`momo-push-relay/src/app.rs`). Matched inside
/// the recorded `relay_http: HTTP 400: <excerpt>` text. Drift guard: the notifier's relay test
/// drives the **real** relay router and feeds the text it actually answers through
/// [`apns_reason_code`], so a reworded relay message turns that test red.
pub const RELAY_VOCABULARY_REFUSAL_TEXT: &str = "invalid momo.push.dispatch.v2 payload";

/// What the relay says when the dispatch's APNs environment is not the one it serves.
pub const RELAY_ENVIRONMENT_MISMATCH_TEXT: &str = "dispatch APNs environment does not match relay";

/// The recorded-reason prefix [`crate::dispatch_log::settle_relay_refusal`] puts on a relay refusal.
const RELAY_REASON_PREFIX: &str = "relay_http: ";

/// An APNs reason code is a short identifier (`BadDeviceToken`, `Unregistered`, …). Anything with a
/// space, punctuation or more than this many characters is not one and is never passed through.
const APNS_REASON_CODE_MAX_CHARS: usize = 64;

/// The closed set of things the server can tell a member blocks their push (ADR-0206 D11).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockerCode {
    Paused,
    /// Stored by the work-hours slice (N7). Never emitted before that.
    QuietHours,
    ChannelMuted,
    /// Stored by the per-kind switch slice (N3). Never emitted before that.
    KindOff,
    NoDevice,
    TokenInvalidated,
    RelayUnreachable,
    LastDeliveryFailed,
}

impl BlockerCode {
    /// All eight, in the order the response lists them.
    pub const ALL: [BlockerCode; 8] = [
        BlockerCode::Paused,
        BlockerCode::QuietHours,
        BlockerCode::ChannelMuted,
        BlockerCode::KindOff,
        BlockerCode::NoDevice,
        BlockerCode::TokenInvalidated,
        BlockerCode::RelayUnreachable,
        BlockerCode::LastDeliveryFailed,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            BlockerCode::Paused => "paused",
            BlockerCode::QuietHours => "quiet_hours",
            BlockerCode::ChannelMuted => "channel_muted",
            BlockerCode::KindOff => "kind_off",
            BlockerCode::NoDevice => "no_device",
            BlockerCode::TokenInvalidated => "token_invalidated",
            BlockerCode::RelayUnreachable => "relay_unreachable",
            BlockerCode::LastDeliveryFailed => "last_delivery_failed",
        }
    }
}

/// The notification kinds the server tags a push target with (ADR-0206 종류 표 and 증보 1 F5). The
/// engine owns this list; the diagnostics `?kind=` is validated against it so an unknown kind is a
/// 400 today and `kind_off` / the `quiet_hours` pass-through can read it later without a contract
/// change.
pub const NOTIFICATION_KINDS: [&str; 10] = [
    "dm",
    "mentionHuman",
    "mentionAgent",
    "agentAnswer",
    "approval",
    "workDone",
    "keyword",
    "channelAll",
    "threadReply",
    "scheduledFailed",
];

/// One blocker with the values that go with its code (D11's 「덧붙는 값」 column). Only the fields
/// that belong to the code are `Some`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Blocker {
    pub code: BlockerCode,
    /// `paused` / `channel_muted`: when it ends (None = open-ended).
    pub until_ms: Option<i64>,
    /// `token_invalidated` / `relay_unreachable`: when it started.
    pub since_ms: Option<i64>,
    /// `last_delivery_failed`: when the failed dispatch was made.
    pub at_ms: Option<i64>,
    /// `channel_muted`.
    pub channel_id: Option<Uuid>,
    /// `last_delivery_failed`: the recorded status.
    pub apns_status: Option<i32>,
    /// `last_delivery_failed`: a **code** ([`apns_reason_code`]), never a relay's prose.
    pub apns_reason: Option<String>,
}

impl Blocker {
    fn bare(code: BlockerCode) -> Self {
        Blocker {
            code,
            until_ms: None,
            since_ms: None,
            at_ms: None,
            channel_id: None,
            apns_status: None,
            apns_reason: None,
        }
    }
}

/// How many of the member's push tokens are live and how many are dead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeviceCounts {
    pub active: i64,
    pub invalidated: i64,
}

/// What became of the last test push (ADR-0206 D11's table).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LastTestStatus {
    /// No record, or only unsettled ones, and younger than [`TEST_STALLED_AFTER_SECS`].
    Queued,
    /// The same, older (the notifier may be off, or the device vanished before it ran).
    Stalled,
    /// APNs answered 200 for at least one device.
    Sent,
    /// Every attempt was a relay's closed-vocabulary refusal: an old relay. Not retried.
    RelayOutdated,
    /// Settled records exist and none is a 200 (APNs refusal, environment mismatch, relay 429, …).
    Failed,
}

impl LastTestStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            LastTestStatus::Queued => "queued",
            LastTestStatus::Stalled => "stalled",
            LastTestStatus::Sent => "sent",
            LastTestStatus::RelayOutdated => "relay_outdated",
            LastTestStatus::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LastTest {
    pub id: Uuid,
    pub status: LastTestStatus,
    /// When the test was made (`notification_rule.last_test_at`).
    pub at_ms: i64,
    pub apns_status: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostics {
    pub checked_at_ms: i64,
    pub ok: bool,
    pub blockers: Vec<Blocker>,
    pub devices: DeviceCounts,
    pub last_test: Option<LastTest>,
}

/// One `push_dispatch_log` row of a test push (one per device).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TestDispatchRow {
    pub apns_status: Option<i32>,
    pub apns_reason: Option<String>,
}

/// Is this recorded refusal the relay's closed-vocabulary refusal? Exactly a relay 400 whose text
/// holds the vocabulary message. The environment-mismatch 400 is a different message and is **not**
/// this: it means the relay is fine and configured for another APNs environment.
pub fn is_relay_vocabulary_refusal(apns_status: i32, apns_reason: Option<&str>) -> bool {
    apns_status == 400
        && apns_reason.is_some_and(|reason| {
            reason.starts_with(RELAY_REASON_PREFIX)
                && reason.contains(RELAY_VOCABULARY_REFUSAL_TEXT)
        })
}

/// The **code** for a recorded `apns_status` / `apns_reason` pair (ADR-0206 D11 「`apnsReason`은
/// 코드만 내보내요」):
///
/// * a relay refusal (`relay_http: …`): `relay_vocabulary_refused`, `relay_environment_mismatch`,
///   or `relay_http_<status>` — the relay's own words are never returned;
/// * an APNs reason (`BadDeviceToken`, `Unregistered`, …) as it is, **if** it looks like a code
///   (letters, digits and `_`, at most 64 characters); anything else is dropped (`None`), so a relay
///   that stuffed prose into a receipt cannot get it onto a response;
/// * nothing recorded: `None`.
pub fn apns_reason_code(apns_status: i32, apns_reason: Option<&str>) -> Option<String> {
    let reason = apns_reason?;
    if reason.starts_with(RELAY_REASON_PREFIX) {
        if is_relay_vocabulary_refusal(apns_status, Some(reason)) {
            return Some("relay_vocabulary_refused".to_string());
        }
        if apns_status == 400 && reason.contains(RELAY_ENVIRONMENT_MISMATCH_TEXT) {
            return Some("relay_environment_mismatch".to_string());
        }
        return Some(format!("relay_http_{apns_status}"));
    }
    let code_shaped = !reason.is_empty()
        && reason.chars().count() <= APNS_REASON_CODE_MAX_CHARS
        && reason
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_');
    code_shaped.then(|| reason.to_string())
}

/// The status of the last test from its dispatch rows (newest first) and its age in seconds.
/// Returns the status and the HTTP status worth showing next to it.
pub fn classify_last_test(
    rows: &[TestDispatchRow],
    age_secs: f64,
) -> (LastTestStatus, Option<i32>) {
    let settled: Vec<(i32, Option<&str>)> = rows
        .iter()
        .filter_map(|row| {
            row.apns_status
                .map(|status| (status, row.apns_reason.as_deref()))
        })
        .collect();
    if settled.iter().any(|(status, _)| *status == 200) {
        return (LastTestStatus::Sent, Some(200));
    }
    if settled.is_empty() {
        let status = if age_secs < TEST_STALLED_AFTER_SECS {
            LastTestStatus::Queued
        } else {
            LastTestStatus::Stalled
        };
        return (status, None);
    }
    let every_attempt_was_settled = settled.len() == rows.len();
    let status = if every_attempt_was_settled
        && settled
            .iter()
            .all(|(status, reason)| is_relay_vocabulary_refusal(*status, *reason))
    {
        LastTestStatus::RelayOutdated
    } else {
        LastTestStatus::Failed
    };
    (status, settled.first().map(|(status, _)| *status))
}

fn ms(at: DateTime<Utc>) -> i64 {
    at.timestamp_millis()
}

/// Compute the caller's blockers. **Self-scoped by construction**: every read is for `member_id`
/// (the credential's, never a request field) in `workspace_id`. `channel_id`, when given, must
/// already be known to be a channel this member belongs to — the route answers 404 otherwise, so
/// a channel's existence is not disclosed.
pub async fn compute_diagnostics(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    channel_id: Option<Uuid>,
) -> Result<Diagnostics, DbError> {
    // One row whether or not the member has a `notification_rule` row (absence = no pause, no test).
    let rule = sqlx::query(
        "SELECT now() AS now, \
                r.dnd, r.dnd_until, r.last_test_id, r.last_test_at, \
                EXTRACT(EPOCH FROM (now() - r.last_test_at))::double precision AS last_test_age_secs \
           FROM (SELECT 1) one \
           LEFT JOIN notification_rule r \
             ON r.workspace_id = $1 AND r.member_id = $2",
    )
    .bind(workspace_id)
    .bind(member_id)
    .fetch_one(&mut *conn)
    .await?;
    let now: DateTime<Utc> = rule.try_get("now")?;
    let dnd: Option<bool> = rule.try_get("dnd")?;
    let dnd_until: Option<DateTime<Utc>> = rule.try_get("dnd_until")?;
    let last_test_id: Option<Uuid> = rule.try_get("last_test_id")?;
    let last_test_at: Option<DateTime<Utc>> = rule.try_get("last_test_at")?;
    let last_test_age: Option<f64> = rule.try_get("last_test_age_secs")?;

    let mut blockers: Vec<Blocker> = Vec::new();

    // paused — the pause is in force when `dnd` and the expiry (if any) is still ahead.
    if pause_in_force(dnd.unwrap_or(false), dnd_until, now) {
        let mut blocker = Blocker::bare(BlockerCode::Paused);
        blocker.until_ms = dnd_until.map(ms);
        blockers.push(blocker);
    }

    // channel_muted — a row of `notification_pref` whose expiry (if any) is still ahead.
    if let Some(channel_id) = channel_id {
        let muted = sqlx::query(
            "SELECT muted_until FROM notification_pref \
              WHERE workspace_id = $1 AND member_id = $2 AND channel_id = $3 \
                AND (muted_until IS NULL OR muted_until > now())",
        )
        .bind(workspace_id)
        .bind(member_id)
        .bind(channel_id)
        .fetch_optional(&mut *conn)
        .await?;
        if let Some(row) = muted {
            let until: Option<DateTime<Utc>> = row.try_get("muted_until")?;
            let mut blocker = Blocker::bare(BlockerCode::ChannelMuted);
            blocker.channel_id = Some(channel_id);
            blocker.until_ms = until.map(ms);
            blockers.push(blocker);
        }
    }

    // no_device / token_invalidated — the member's push tokens, live and dead.
    let tokens = sqlx::query(
        "SELECT count(*) FILTER (WHERE invalidated_at IS NULL) AS active, \
                count(*) FILTER (WHERE invalidated_at IS NOT NULL) AS invalidated, \
                max(invalidated_at) AS last_invalidated_at \
           FROM push_token \
          WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(workspace_id)
    .bind(member_id)
    .fetch_one(&mut *conn)
    .await?;
    let devices = DeviceCounts {
        active: tokens.try_get("active")?,
        invalidated: tokens.try_get("invalidated")?,
    };
    let last_invalidated_at: Option<DateTime<Utc>> = tokens.try_get("last_invalidated_at")?;
    if devices.active == 0 && devices.invalidated == 0 {
        blockers.push(Blocker::bare(BlockerCode::NoDevice));
    } else if devices.active == 0 {
        let mut blocker = Blocker::bare(BlockerCode::TokenInvalidated);
        blocker.since_ms = last_invalidated_at.map(ms);
        blockers.push(blocker);
    }

    // The last test: read by its collapse id, exactly — never by scanning the outbox.
    let mut last_test: Option<LastTest> = None;
    if let (Some(test_id), Some(test_at), Some(age)) = (last_test_id, last_test_at, last_test_age) {
        let collapse = crate::system::test_notification_collapse_id(test_id);
        let rows = sqlx::query(
            "SELECT apns_status, apns_reason FROM push_dispatch_log \
              WHERE workspace_id = $1 AND member_id = $2 AND collapse_id = $3 \
              ORDER BY created_at DESC, id DESC",
        )
        .bind(workspace_id)
        .bind(member_id)
        .bind(&collapse)
        .fetch_all(&mut *conn)
        .await?;
        let mut dispatches = Vec::with_capacity(rows.len());
        for row in rows {
            dispatches.push(TestDispatchRow {
                apns_status: row.try_get("apns_status")?,
                apns_reason: row.try_get("apns_reason")?,
            });
        }
        let (status, apns_status) = classify_last_test(&dispatches, age);
        last_test = Some(LastTest {
            id: test_id,
            status,
            at_ms: ms(test_at),
            apns_status,
        });
    }

    // relay_unreachable — inferred (the api has no relay client): a claim of a current token that
    // stayed unsettled for minutes, or a test push nobody processed. Both only inside the lookback.
    let unsettled_since: Option<DateTime<Utc>> = sqlx::query_scalar(
        "SELECT min(l.created_at) \
           FROM push_dispatch_log l \
           JOIN push_token t \
             ON t.id = l.push_token_id \
            AND t.workspace_id = $1 \
            AND t.member_id = $2 \
            AND t.invalidated_at IS NULL \
          WHERE l.workspace_id = $1 \
            AND l.member_id = $2 \
            AND l.apns_status IS NULL \
            AND l.created_at <= now() - make_interval(secs => $3::double precision) \
            AND l.created_at >  now() - make_interval(secs => $4::double precision)",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(UNSETTLED_AFTER_SECS)
    .bind(RELAY_LOOKBACK_SECS)
    .fetch_one(&mut *conn)
    .await?;
    let stalled_test_since = last_test.as_ref().and_then(|test| {
        let age = last_test_age?;
        (test.status == LastTestStatus::Stalled && age <= RELAY_LOOKBACK_SECS).then_some(test.at_ms)
    });
    let relay_since = [unsettled_since.map(ms), stalled_test_since]
        .into_iter()
        .flatten()
        .min();
    if let Some(since) = relay_since {
        let mut blocker = Blocker::bare(BlockerCode::RelayUnreachable);
        blocker.since_ms = Some(since);
        blockers.push(blocker);
    }

    // last_delivery_failed — the latest settled record of a current token, 400 or above.
    let latest = sqlx::query(
        "SELECT l.apns_status, l.apns_reason, l.created_at \
           FROM push_dispatch_log l \
           JOIN push_token t \
             ON t.id = l.push_token_id \
            AND t.workspace_id = $1 \
            AND t.member_id = $2 \
            AND t.invalidated_at IS NULL \
          WHERE l.workspace_id = $1 \
            AND l.member_id = $2 \
            AND l.apns_status IS NOT NULL \
            AND l.created_at > now() - make_interval(secs => $3::double precision) \
            AND l.apns_reason IS DISTINCT FROM $4 \
          ORDER BY l.created_at DESC, l.id DESC \
          LIMIT 1",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(DELIVERY_LOOKBACK_SECS)
    .bind(RELAY_DROPPED_REASON)
    .fetch_optional(&mut *conn)
    .await?;
    if let Some(row) = latest {
        let status: i32 = row.try_get("apns_status")?;
        if status >= 400 {
            let reason: Option<String> = row.try_get("apns_reason")?;
            let at: DateTime<Utc> = row.try_get("created_at")?;
            let mut blocker = Blocker::bare(BlockerCode::LastDeliveryFailed);
            blocker.at_ms = Some(ms(at));
            blocker.apns_status = Some(status);
            blocker.apns_reason = apns_reason_code(status, reason.as_deref());
            blockers.push(blocker);
        }
    }

    Ok(Diagnostics {
        checked_at_ms: ms(now),
        ok: blockers.is_empty(),
        blockers,
        devices,
        last_test,
    })
}

/// The answer of [`reserve_test_push_in_tx`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TestPushSlot {
    /// The member has no live push token: nothing to test, and **no budget was spent**.
    NoDevice,
    /// The member already sent [`TEST_PUSH_PER_WINDOW`] tests in this window.
    RateLimited { retry_after_secs: u64 },
    /// One test is reserved: `last_test_*` and the window were written under the row lock. The
    /// caller must write the `push_system` row in the **same transaction** (a rollback then undoes
    /// the counter too) and answer with `test_id` and `device_count`.
    Reserved { test_id: Uuid, device_count: i64 },
}

/// Take one test push's slot for `member_id` (ADR-0206 D11 「속도 제한」).
///
/// The count lives on the member's `notification_rule` row, **not** in a scan of `outbox`: a
/// finished row is not in the `pending`-only index, so counting there would read the table. The row
/// is created if absent (as `PATCH notification-rules` does), then locked `FOR UPDATE`, so two
/// requests of one member are serialized by one row lock and the budget cannot be overspent by a
/// burst. Order: live tokens first (a member with no device spends nothing), then the window, then
/// the write of the window, `last_test_id` and `last_test_at` under the same lock. Only the four
/// test columns are written — never `dnd` or the other rule fields.
pub async fn reserve_test_push_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<TestPushSlot, DbError> {
    let device_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM push_token \
          WHERE workspace_id = $1 AND member_id = $2 AND invalidated_at IS NULL",
    )
    .bind(workspace_id)
    .bind(member_id)
    .fetch_one(&mut *conn)
    .await?;
    if device_count == 0 {
        return Ok(TestPushSlot::NoDevice);
    }

    // `FOR UPDATE` on an absent row locks nothing: materialize it first so the lock below always
    // has a row to hold (the second of two first-time requests waits there).
    sqlx::query(
        "INSERT INTO notification_rule (workspace_id, member_id) VALUES ($1, $2) \
         ON CONFLICT (workspace_id, member_id) DO NOTHING",
    )
    .bind(workspace_id)
    .bind(member_id)
    .execute(&mut *conn)
    .await?;
    let window = sqlx::query(
        "SELECT test_push_window_start, test_push_count, now() AS now \
           FROM notification_rule \
          WHERE workspace_id = $1 AND member_id = $2 \
          FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(member_id)
    .fetch_one(&mut *conn)
    .await?;
    let started: Option<DateTime<Utc>> = window.try_get("test_push_window_start")?;
    let spent: Option<i16> = window.try_get("test_push_count")?;
    let now: DateTime<Utc> = window.try_get("now")?;

    // A window is still open until it is a full minute old (`now < start` — a lock waiter whose
    // transaction began before the winner's — counts as open, never as expired).
    let open_for = started.map(|start| (now - start).num_milliseconds());
    let window_open = open_for.is_some_and(|elapsed| elapsed < TEST_PUSH_WINDOW_SECS * 1000);
    let spent_now = if window_open { spent.unwrap_or(0) } else { 0 };
    if spent_now >= TEST_PUSH_PER_WINDOW {
        let remaining_ms = TEST_PUSH_WINDOW_SECS * 1000 - open_for.unwrap_or(0);
        return Ok(TestPushSlot::RateLimited {
            retry_after_secs: (remaining_ms.max(1000) as u64).div_ceil(1000),
        });
    }
    let window_start = if window_open {
        started.unwrap_or(now)
    } else {
        now
    };

    let test_id: Uuid = sqlx::query_scalar("SELECT uuidv7()")
        .fetch_one(&mut *conn)
        .await?;
    sqlx::query(
        "UPDATE notification_rule \
            SET test_push_window_start = $3, \
                test_push_count = $4, \
                last_test_id = $5, \
                last_test_at = now() \
          WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(window_start)
    .bind(spent_now + 1)
    .bind(test_id)
    .execute(&mut *conn)
    .await?;
    Ok(TestPushSlot::Reserved {
        test_id,
        device_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(status: Option<i32>, reason: Option<&str>) -> TestDispatchRow {
        TestDispatchRow {
            apns_status: status,
            apns_reason: reason.map(str::to_string),
        }
    }

    const VOCABULARY_400: &str = "relay_http: HTTP 400: invalid momo.push.dispatch.v2 payload";
    const ENVIRONMENT_400: &str =
        "relay_http: HTTP 400: dispatch APNs environment does not match relay";

    /// ADR-0206 D11: the code set is closed at eight, in this order, spelled exactly so.
    #[test]
    fn the_blocker_codes_are_the_closed_eight() {
        let spelled: Vec<&str> = BlockerCode::ALL.iter().map(|code| code.as_str()).collect();
        assert_eq!(
            spelled,
            [
                "paused",
                "quiet_hours",
                "channel_muted",
                "kind_off",
                "no_device",
                "token_invalidated",
                "relay_unreachable",
                "last_delivery_failed",
            ]
        );
    }

    /// The `?kind=` list is the kind table of ADR-0206 (ten kinds, `threadReply` from 증보 1).
    #[test]
    fn the_notification_kinds_are_the_ten_of_the_kind_table() {
        assert_eq!(NOTIFICATION_KINDS.len(), 10);
        let unique: std::collections::BTreeSet<&str> = NOTIFICATION_KINDS.into_iter().collect();
        assert_eq!(unique.len(), 10);
        assert!(NOTIFICATION_KINDS.contains(&"threadReply"));
        assert!(
            !NOTIFICATION_KINDS.contains(&"channel_message"),
            "a wire reason is not a kind"
        );
    }

    /// `apnsReason` leaves this module as a code. A relay's own prose — even one that quotes
    /// something content-shaped — is never returned.
    #[test]
    fn a_relay_refusal_is_turned_into_a_code_and_its_words_are_dropped() {
        assert_eq!(
            apns_reason_code(400, Some(VOCABULARY_400)).as_deref(),
            Some("relay_vocabulary_refused")
        );
        assert_eq!(
            apns_reason_code(400, Some(ENVIRONMENT_400)).as_deref(),
            Some("relay_environment_mismatch")
        );
        assert_eq!(
            apns_reason_code(
                403,
                Some("relay_http: HTTP 403: unregistered or invalid server signature")
            )
            .as_deref(),
            Some("relay_http_403")
        );
        assert_eq!(
            apns_reason_code(400, Some("relay_http: HTTP 400")).as_deref(),
            Some("relay_http_400"),
            "a refusal that kept no excerpt is still a relay refusal, never an APNs code"
        );
        assert_eq!(
            apns_reason_code(429, Some("relay_http: HTTP 429")).as_deref(),
            Some("relay_http_429")
        );
        // The vocabulary text under another status, or with another prefix, is not the refusal.
        assert_eq!(
            apns_reason_code(
                403,
                Some("relay_http: HTTP 403: invalid momo.push.dispatch.v2 payload")
            )
            .as_deref(),
            Some("relay_http_403")
        );
        for code in [
            apns_reason_code(400, Some(VOCABULARY_400)),
            apns_reason_code(
                400,
                Some("relay_http: HTTP 400: anything the relay felt like saying"),
            ),
        ] {
            assert!(
                code.as_deref().is_some_and(|code| !code.contains(' ')),
                "{code:?} carries prose"
            );
        }
    }

    #[test]
    fn an_apns_reason_passes_only_when_it_is_shaped_like_a_code() {
        assert_eq!(
            apns_reason_code(410, Some("Unregistered")).as_deref(),
            Some("Unregistered")
        );
        assert_eq!(
            apns_reason_code(400, Some("BadDeviceToken")).as_deref(),
            Some("BadDeviceToken")
        );
        assert_eq!(apns_reason_code(400, None), None);
        assert_eq!(apns_reason_code(400, Some("")), None);
        // Prose, punctuation or length never gets through, even without the relay prefix.
        assert_eq!(
            apns_reason_code(400, Some("please call 010-1234 about oort")),
            None
        );
        assert_eq!(apns_reason_code(400, Some("Bad Device Token")), None);
        assert_eq!(apns_reason_code(400, Some("a:b")), None);
        assert_eq!(apns_reason_code(400, Some(&"x".repeat(65))), None);
        assert_eq!(
            apns_reason_code(400, Some(&"x".repeat(64))).as_deref(),
            Some("x".repeat(64).as_str())
        );
        assert_eq!(
            apns_reason_code(400, Some("invalid momo.push.dispatch.v2 payload")),
            None,
            "the relay's words without the relay prefix are not an APNs code either"
        );
    }

    #[test]
    fn only_the_vocabulary_refusal_counts_as_an_outdated_relay() {
        assert!(is_relay_vocabulary_refusal(400, Some(VOCABULARY_400)));
        assert!(!is_relay_vocabulary_refusal(400, Some(ENVIRONMENT_400)));
        assert!(!is_relay_vocabulary_refusal(403, Some(VOCABULARY_400)));
        assert!(!is_relay_vocabulary_refusal(400, Some("BadDeviceToken")));
        assert!(!is_relay_vocabulary_refusal(400, None));
        assert!(!is_relay_vocabulary_refusal(
            400,
            Some("HTTP 400: invalid momo.push.dispatch.v2 payload")
        ));
    }

    /// ADR-0206 D11's `lastTest` table, row by row, including the 30-second edge.
    #[test]
    fn the_last_test_status_follows_the_table() {
        // no record / only unsettled: queued under 30 s, stalled from 30 s
        assert_eq!(classify_last_test(&[], 0.0), (LastTestStatus::Queued, None));
        assert_eq!(
            classify_last_test(&[], 29.9),
            (LastTestStatus::Queued, None)
        );
        assert_eq!(
            classify_last_test(&[], 30.0),
            (LastTestStatus::Stalled, None)
        );
        let unsettled = [row(None, None), row(None, None)];
        assert_eq!(
            classify_last_test(&unsettled, 5.0).0,
            LastTestStatus::Queued
        );
        assert_eq!(
            classify_last_test(&unsettled, 31.0).0,
            LastTestStatus::Stalled
        );
        // any device answered 200
        let mixed = [row(Some(410), Some("Unregistered")), row(Some(200), None)];
        assert_eq!(
            classify_last_test(&mixed, 3.0),
            (LastTestStatus::Sent, Some(200))
        );
        // every attempt a vocabulary refusal: an old relay
        let outdated = [
            row(Some(400), Some(VOCABULARY_400)),
            row(Some(400), Some(VOCABULARY_400)),
        ];
        assert_eq!(
            classify_last_test(&outdated, 3.0),
            (LastTestStatus::RelayOutdated, Some(400))
        );
        // an environment mismatch is a 400 too — and is *not* an outdated relay
        let environment = [row(Some(400), Some(ENVIRONMENT_400))];
        assert_eq!(
            classify_last_test(&environment, 3.0),
            (LastTestStatus::Failed, Some(400))
        );
        // one refusal and one still unsettled attempt: not "every attempt refused"
        let partial = [row(Some(400), Some(VOCABULARY_400)), row(None, None)];
        assert_eq!(classify_last_test(&partial, 3.0).0, LastTestStatus::Failed);
        // APNs refusal, relay 429: failed, with the newest settled row's status
        let apns = [
            row(Some(429), Some("relay_http: HTTP 429")),
            row(Some(410), Some("Unregistered")),
        ];
        assert_eq!(
            classify_last_test(&apns, 3.0),
            (LastTestStatus::Failed, Some(429))
        );
    }
}
