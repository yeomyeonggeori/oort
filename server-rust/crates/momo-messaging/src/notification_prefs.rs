//! 알림 설정 v2 — 종류×표면·표현·근무 시간·지연·관통 스위치 (ADR-0206 D5·D13, #4494 N3).
//!
//! The read/write half of the columns migration 172 added to `notification_rule`. The push
//! judgment (`momo-push`) reads the same row; this module owns the **closed vocabulary**
//! ([`NotificationKind`]) both sides share and the one spelling of "is this kind's phone switch on"
//! ([`phone_switch_on`]).
//!
//! ## What is stored, and what a missing value means
//!
//! Every column is NULL or defaulted in "행 부재 = 오늘" (ADR-0206 I5): a member with no row, or a
//! row that never named a cell, gets the kind table's defaults — every phone switch on, desktop on
//! except `dm`. `kinds` stores **cells** (kind × surface); a cell that is absent is its default, and
//! writing `null` to a cell deletes it. `workDone.phone` is **not** a cell: the one stored value is
//! `work_complete_push` (115), so `PATCH …/notification-rules/push-kinds` and this surface are two
//! spellings of the same switch (D5 별칭).
//!
//! ## Reads are tolerant, writes are strict
//!
//! The jsonb columns have no DB CHECK (a rolled-back server must still be able to write its own
//! columns), so the API is the only validator and every reader — judgment SQL, this module — treats
//! an unknown key or a wrong type as "not set" and falls back to the default. A hand-edited `kinds`
//! can therefore never make a push disappear by accident: only a literal JSON `false` is "off".
//!
//! ## Rejections come before the first write
//!
//! [`patch_prefs_in_tx`] returns a [`PrefsRejection`] as a **value**, and the route turns it into a
//! 400 inside a transaction that still commits (`DbRejectable`'s contract: every rejection is
//! returned before the first write). So validation reads (the time-zone name, the current approval
//! switch) happen first, under a row lock when the row exists, and the default row is materialized
//! only once the patch is known to be acceptable.

use std::collections::BTreeMap;

use chrono::{DateTime, Datelike, Duration, NaiveDateTime, NaiveTime, Utc};
use momo_db::DbError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

/// The closed set of notification kinds (ADR-0206 종류 표 and 증보 1 F5). The server tags each push
/// target with one when it judges; the settings surface stores one switch per (kind, surface). The
/// engine owns this list: a UXUI client follows it, never extends it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NotificationKind {
    Dm,
    MentionHuman,
    MentionAgent,
    AgentAnswer,
    Approval,
    WorkDone,
    Keyword,
    ChannelAll,
    ThreadReply,
    ScheduledFailed,
}

impl NotificationKind {
    /// All ten, in the order the API lists them.
    pub const ALL: [NotificationKind; 10] = [
        NotificationKind::Dm,
        NotificationKind::MentionHuman,
        NotificationKind::MentionAgent,
        NotificationKind::AgentAnswer,
        NotificationKind::Approval,
        NotificationKind::WorkDone,
        NotificationKind::Keyword,
        NotificationKind::ChannelAll,
        NotificationKind::ThreadReply,
        NotificationKind::ScheduledFailed,
    ];

    /// The wire name (the API key, the diagnostics `kind`).
    pub fn as_str(self) -> &'static str {
        match self {
            NotificationKind::Dm => "dm",
            NotificationKind::MentionHuman => "mentionHuman",
            NotificationKind::MentionAgent => "mentionAgent",
            NotificationKind::AgentAnswer => "agentAnswer",
            NotificationKind::Approval => "approval",
            NotificationKind::WorkDone => "workDone",
            NotificationKind::Keyword => "keyword",
            NotificationKind::ChannelAll => "channelAll",
            NotificationKind::ThreadReply => "threadReply",
            NotificationKind::ScheduledFailed => "scheduledFailed",
        }
    }

    pub fn from_wire(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == raw)
    }

    /// Whether the kind has a desktop/web-banner cell at all. The desktop decides banners on the
    /// client from server values (D17) and has no way to know a keyword hit, an agent's answer, a
    /// followed thread's reply or a failed scheduled message (종류 표, 증보 1 F5), so a write to
    /// those cells is a 400 and the read omits them. Opening one later is migration-free (a missing
    /// cell is the default) — it is this list that changes.
    pub fn has_desktop(self) -> bool {
        !matches!(
            self,
            NotificationKind::AgentAnswer
                | NotificationKind::Keyword
                | NotificationKind::ThreadReply
                | NotificationKind::ScheduledFailed
        )
    }

    /// What a missing desktop cell reads as: on, except `dm` (성재 2026-10-02: today's desktop does
    /// not banner DMs, `preference.ts`). Meaningless for a kind with no desktop cell.
    pub fn desktop_default(self) -> bool {
        self != NotificationKind::Dm
    }
}

/// One kind's stored cells. `None` is "not set" = the kind table's default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Cells {
    pub phone: Option<bool>,
    pub desktop: Option<bool>,
}

/// One kind as the API shows it: the effective value of each surface that applies to the kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KindSwitch {
    pub phone: bool,
    /// `None` where the surface does not apply to the kind ([`NotificationKind::has_desktop`]).
    pub desktop: Option<bool>,
}

/// The known sound slots (ADR-0206 D10). A user file (`user:<sha256>`, D2) is #4345's and is not
/// accepted before the table that proves it exists.
pub const BUNDLED_SOUNDS: [&str; 7] = [
    "oort.message",
    "oort.mention",
    "oort.dm",
    "oort.approval",
    "oort.work",
    "oort.message.b",
    "oort.message.c",
];

/// `phoneDelaySecs`'s three values (D4) and the default a NULL column reads as.
pub const PHONE_DELAY_CHOICES: [i16; 3] = [0, 60, 300];
pub const PHONE_DELAY_DEFAULT_SECS: i16 = 60;

/// A sound slot value: a bundled id or `none` (no sound, banner kept — I1).
pub fn is_known_sound(id: &str) -> bool {
    id == "none" || BUNDLED_SOUNDS.contains(&id)
}

/// Read `notification_rule.kinds` tolerantly: only the ten known kinds, only object cells, only
/// boolean values; everything else is "not set".
pub fn parse_cells(raw: Option<&Value>) -> BTreeMap<NotificationKind, Cells> {
    let mut out = BTreeMap::new();
    let Some(Value::Object(map)) = raw else {
        return out;
    };
    for kind in NotificationKind::ALL {
        let Some(Value::Object(cells)) = map.get(kind.as_str()) else {
            continue;
        };
        let phone = cells.get("phone").and_then(Value::as_bool);
        let desktop = if kind.has_desktop() {
            cells.get("desktop").and_then(Value::as_bool)
        } else {
            None
        };
        if phone.is_some() || desktop.is_some() {
            out.insert(kind, Cells { phone, desktop });
        }
    }
    out
}

/// The jsonb to store: only kinds that name at least one cell. `None` (SQL NULL) when nothing is set,
/// so a member who reset everything is a member with no `kinds` at all.
fn render_cells(cells: &BTreeMap<NotificationKind, Cells>) -> Option<Value> {
    let mut map = Map::new();
    for (kind, cell) in cells {
        let mut one = Map::new();
        if let Some(phone) = cell.phone {
            one.insert("phone".into(), Value::Bool(phone));
        }
        if let (true, Some(desktop)) = (kind.has_desktop(), cell.desktop) {
            one.insert("desktop".into(), Value::Bool(desktop));
        }
        if !one.is_empty() {
            map.insert(kind.as_str().into(), Value::Object(one));
        }
    }
    (!map.is_empty()).then_some(Value::Object(map))
}

/// The one spelling of "is this kind's phone switch on" for a stored row: `workDone` is the
/// `work_complete_push` column, every other kind is its `kinds` cell, and **only a literal `false` is
/// off** — a missing cell, a wrong type or an unknown shape is on. The push judgment's SQL spells the
/// same rule as `kinds->'<kind>'->'phone' IS DISTINCT FROM 'false'::jsonb`.
pub fn phone_switch_on(
    kind: NotificationKind,
    kinds: Option<&Value>,
    work_complete_push: bool,
) -> bool {
    if kind == NotificationKind::WorkDone {
        return work_complete_push;
    }
    parse_cells(kinds)
        .get(&kind)
        .and_then(|cells| cells.phone)
        .unwrap_or(true)
}

fn effective_switch(
    kind: NotificationKind,
    cells: Option<&Cells>,
    work_complete_push: bool,
) -> KindSwitch {
    let phone = if kind == NotificationKind::WorkDone {
        work_complete_push
    } else {
        cells.and_then(|cells| cells.phone).unwrap_or(true)
    };
    let desktop = kind.has_desktop().then(|| {
        cells
            .and_then(|cells| cells.desktop)
            .unwrap_or(kind.desktop_default())
    });
    KindSwitch { phone, desktop }
}

fn parse_sounds(raw: Option<&Value>) -> BTreeMap<NotificationKind, String> {
    let mut out = BTreeMap::new();
    let Some(Value::Object(map)) = raw.and_then(|value| value.get("sounds")) else {
        return out;
    };
    for kind in NotificationKind::ALL {
        if let Some(Value::String(id)) = map.get(kind.as_str()) {
            out.insert(kind, id.clone());
        }
    }
    out
}

fn render_sounds(sounds: &BTreeMap<NotificationKind, String>) -> Option<Value> {
    if sounds.is_empty() {
        return None;
    }
    let mut map = Map::new();
    for (kind, id) in sounds {
        map.insert(kind.as_str().into(), Value::String(id.clone()));
    }
    Some(json!({ "sounds": Value::Object(map) }))
}

// ---------------------------------------------------------------------------
// work hours
// ---------------------------------------------------------------------------

/// 근무 시간 (D13). Outside the window notifications behave like a pause except the kinds in
/// `pass_through`; a pause always wins (I6). **This slice stores and evaluates it for the
/// `effective.quiet` block; the judgment applying it is N7.**
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Schedule {
    pub enabled: bool,
    /// A name in `pg_timezone_names`, checked when written (400 `invalid_time_zone`).
    pub tz: String,
    /// 0 = Sunday … 6 = Saturday: the day a window **starts** (D13).
    pub days: Vec<u8>,
    /// `HH:MM`.
    pub start: String,
    pub end: String,
    pub pass_through: Vec<NotificationKind>,
}

impl Schedule {
    fn to_json(&self) -> Value {
        json!({
            "enabled": self.enabled,
            "tz": self.tz,
            "days": self.days,
            "start": self.start,
            "end": self.end,
            "passThrough": self.pass_through.iter().map(|kind| kind.as_str()).collect::<Vec<_>>(),
        })
    }

    /// Tolerant read of the stored jsonb: a value that is not a whole, well-shaped schedule is "no
    /// schedule" (the API validated it when it was written; this only guards a hand edit).
    fn from_json(raw: &Value) -> Option<Schedule> {
        let object = raw.as_object()?;
        let days: Vec<u8> = object
            .get("days")?
            .as_array()?
            .iter()
            .map(|day| day.as_u64().filter(|day| *day <= 6).map(|day| day as u8))
            .collect::<Option<_>>()?;
        let pass_through = object
            .get("passThrough")?
            .as_array()?
            .iter()
            .filter_map(|kind| kind.as_str().and_then(NotificationKind::from_wire))
            .collect();
        Some(Schedule {
            enabled: object.get("enabled")?.as_bool()?,
            tz: object.get("tz")?.as_str()?.to_string(),
            days,
            start: object.get("start")?.as_str()?.to_string(),
            end: object.get("end")?.as_str()?.to_string(),
            pass_through,
        })
    }
}

/// `HH:MM`, two digits each, 00:00–23:59 — the openapi pattern, exactly (chrono alone would accept
/// `7:5`).
pub fn parse_hhmm(raw: &str) -> Option<NaiveTime> {
    let bytes = raw.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        return None;
    }
    if !bytes
        .iter()
        .enumerate()
        .all(|(at, byte)| at == 2 || byte.is_ascii_digit())
    {
        return None;
    }
    NaiveTime::parse_from_str(raw, "%H:%M").ok()
}

/// The shape checks that need no database (the zone name is checked against `pg_timezone_names`
/// separately). `start == end` is refused: 24 hours is `enabled: false`. An **enabled** schedule with
/// no day would silence every push for good except the pass-through kinds, which is the "why does
/// nothing arrive" this ADR exists to end — refused as well.
fn validate_schedule_shape(schedule: &Schedule) -> Result<(), PrefsRejection> {
    let (Some(start), Some(end)) = (parse_hhmm(&schedule.start), parse_hhmm(&schedule.end)) else {
        return Err(PrefsRejection::InvalidSchedule("start and end are HH:MM"));
    };
    if start == end {
        return Err(PrefsRejection::InvalidSchedule(
            "start and end must differ; use enabled=false for no schedule",
        ));
    }
    if schedule.days.iter().any(|day| *day > 6) {
        return Err(PrefsRejection::InvalidSchedule("days are 0 (Sunday) to 6"));
    }
    let mut seen = [false; 7];
    for day in &schedule.days {
        if std::mem::replace(&mut seen[*day as usize], true) {
            return Err(PrefsRejection::InvalidSchedule("days must be unique"));
        }
    }
    if schedule.enabled && schedule.days.is_empty() {
        return Err(PrefsRejection::InvalidSchedule(
            "an enabled schedule needs at least one day",
        ));
    }
    if schedule.tz.is_empty() || schedule.tz.chars().count() > 64 {
        return Err(PrefsRejection::InvalidTimeZone);
    }
    Ok(())
}

/// Where `local_now` stands against a schedule's window, in the schedule's own zone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowState {
    /// Inside a work window (notifications flow).
    pub inside: bool,
    /// When the window next opens, in the schedule's local time. `None` while inside.
    pub next_open: Option<NaiveDateTime>,
}

/// Evaluate the window for a local time (D13). The window's weekday is **the day it starts**: with
/// `end <= start` it crosses midnight, and Friday 22:00–06:00 covers Saturday 02:00 as a Friday
/// window. Pure — the zone arithmetic is Postgres's ([`notification_local_time`]); this is only the
/// calendar logic on the local clock. `None` for a schedule whose times do not parse, are equal, or
/// that names no day.
pub fn window_state(schedule: &Schedule, local_now: NaiveDateTime) -> Option<WindowState> {
    let start = parse_hhmm(&schedule.start)?;
    let end = parse_hhmm(&schedule.end)?;
    // The API refuses all three of these (`invalid_schedule`); a stored value that has one anyway (a
    // hand edit) is "no schedule" and not, say, a window that never opens — which would read as
    // "quiet for ever".
    if start == end || schedule.days.is_empty() {
        return None;
    }
    let day_on = |day: u8| schedule.days.contains(&day);
    let dow = local_now.weekday().num_days_from_sunday() as u8;
    let previous = (dow + 6) % 7;
    let time = local_now.time();
    let inside = if start < end {
        day_on(dow) && time >= start && time < end
    } else {
        (day_on(dow) && time >= start) || (day_on(previous) && time < end)
    };
    let next_open = if inside {
        None
    } else {
        (0..=7).find_map(|offset| {
            let date = local_now.date() + Duration::days(offset);
            let candidate = date.and_time(start);
            (candidate > local_now && day_on(date.weekday().num_days_from_sunday() as u8))
                .then_some(candidate)
        })
    };
    Some(WindowState { inside, next_open })
}

/// `effective.quiet` (D13): the server's own evaluation, so a desktop client never redoes the time
/// zone math.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Quiet {
    /// Outside the work-hours window right now.
    pub active: bool,
    /// When the window next opens (epoch ms), while `active`.
    pub resumes_at_ms: Option<i64>,
}

/// Evaluate a stored schedule now. A schedule that is off, absent or **whose zone the database no
/// longer knows** is "no schedule": the second return value says the zone was unknown so the caller can
/// log it — a stored name that stopped resolving (a tzdata change) must not break a read.
async fn evaluate_quiet(
    conn: &mut PgConnection,
    schedule: Option<&Schedule>,
) -> Result<(Quiet, bool), DbError> {
    let Some(schedule) = schedule.filter(|schedule| schedule.enabled) else {
        return Ok((Quiet::default(), false));
    };
    let local_now: Option<NaiveDateTime> =
        sqlx::query_scalar("SELECT notification_local_time($1, now())")
            .bind(&schedule.tz)
            .fetch_one(&mut *conn)
            .await?;
    let Some(local_now) = local_now else {
        return Ok((Quiet::default(), true));
    };
    let Some(state) = window_state(schedule, local_now) else {
        return Ok((Quiet::default(), false));
    };
    if state.inside {
        return Ok((Quiet::default(), false));
    }
    let resumes_at_ms = match state.next_open {
        Some(next_open) => {
            // The zone resolved a moment ago (`local_now` is not NULL), so this conversion cannot
            // fail on the name. A local time that does not exist on a spring-forward night is placed
            // by Postgres itself.
            let at: DateTime<Utc> = sqlx::query_scalar("SELECT ($1::timestamp AT TIME ZONE $2)")
                .bind(next_open)
                .bind(&schedule.tz)
                .fetch_one(&mut *conn)
                .await?;
            Some(at.timestamp_millis())
        }
        None => None,
    };
    Ok((
        Quiet {
            active: true,
            resumes_at_ms,
        },
        false,
    ))
}

// ---------------------------------------------------------------------------
// the read model
// ---------------------------------------------------------------------------

/// What `GET …/notification-prefs` answers: every kind (stored value or default), the stored
/// presentation, the schedule, the scalar switches, and the `effective` evaluation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrefsView {
    /// All ten kinds, in [`NotificationKind::ALL`] order.
    pub kinds: Vec<(NotificationKind, KindSwitch)>,
    /// Stored sound slots only; a kind that is absent plays its default.
    pub sounds: BTreeMap<NotificationKind, String>,
    pub schedule: Option<Schedule>,
    /// The stored delay or 60.
    pub phone_delay_secs: i16,
    pub keyword_overrides_mute: bool,
    pub approval_time_sensitive: bool,
    /// A pause is running (the same evaluation as `notification-rules`).
    pub paused: bool,
    pub paused_until: Option<DateTime<Utc>>,
    pub quiet: Quiet,
    /// The stored schedule names a zone the database does not know now (read as no schedule).
    pub schedule_zone_unknown: bool,
}

#[derive(Debug, Default)]
struct StoredPrefs {
    kinds: Option<Value>,
    presentation: Option<Value>,
    schedule: Option<Value>,
    phone_delay_secs: Option<i16>,
    keyword_overrides_mute: bool,
    approval_time_sensitive: bool,
    work_complete_push: bool,
    dnd: bool,
    dnd_until: Option<DateTime<Utc>>,
    now: Option<DateTime<Utc>>,
}

impl StoredPrefs {
    /// A member with no `notification_rule` row: every column at its default.
    fn absent(now: DateTime<Utc>) -> Self {
        StoredPrefs {
            keyword_overrides_mute: true,
            work_complete_push: true,
            now: Some(now),
            ..StoredPrefs::default()
        }
    }
}

const SELECT_PREFS: &str = "SELECT now() AS now, r.workspace_id IS NOT NULL AS present, \
            r.kinds, r.presentation, r.schedule, r.phone_delay_secs, \
            COALESCE(r.keyword_overrides_mute, true) AS keyword_overrides_mute, \
            COALESCE(r.approval_time_sensitive, false) AS approval_time_sensitive, \
            COALESCE(r.work_complete_push, true) AS work_complete_push, \
            COALESCE(r.dnd, false) AS dnd, r.dnd_until \
       FROM (SELECT 1) one \
       LEFT JOIN notification_rule r ON r.workspace_id = $1 AND r.member_id = $2";

/// Read the row (`lock` takes `FOR UPDATE` on an existing row; an absent row locks nothing). The
/// boolean is whether the row exists.
async fn load_prefs(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    lock: bool,
) -> Result<(StoredPrefs, bool), DbError> {
    // `FOR UPDATE` cannot take the nullable side of an outer join, so the locking read is a plain
    // select of the one row, taken first; the shared read above then sees the locked state.
    if lock {
        sqlx::query(
            "SELECT 1 FROM notification_rule WHERE workspace_id = $1 AND member_id = $2 FOR UPDATE",
        )
        .bind(workspace_id)
        .bind(member_id)
        .fetch_optional(&mut *conn)
        .await?;
    }
    let row = sqlx::query(SELECT_PREFS)
        .bind(workspace_id)
        .bind(member_id)
        .fetch_one(&mut *conn)
        .await?;
    let now: DateTime<Utc> = row.try_get("now")?;
    let present: bool = row.try_get("present")?;
    if !present {
        return Ok((StoredPrefs::absent(now), false));
    }
    Ok((
        StoredPrefs {
            kinds: row.try_get("kinds")?,
            presentation: row.try_get("presentation")?,
            schedule: row.try_get("schedule")?,
            phone_delay_secs: row.try_get("phone_delay_secs")?,
            keyword_overrides_mute: row.try_get("keyword_overrides_mute")?,
            approval_time_sensitive: row.try_get("approval_time_sensitive")?,
            work_complete_push: row.try_get("work_complete_push")?,
            dnd: row.try_get("dnd")?,
            dnd_until: row.try_get("dnd_until")?,
            now: Some(now),
        },
        true,
    ))
}

async fn view_of(conn: &mut PgConnection, stored: &StoredPrefs) -> Result<PrefsView, DbError> {
    let cells = parse_cells(stored.kinds.as_ref());
    let kinds = NotificationKind::ALL
        .into_iter()
        .map(|kind| {
            (
                kind,
                effective_switch(kind, cells.get(&kind), stored.work_complete_push),
            )
        })
        .collect();
    let schedule = stored.schedule.as_ref().and_then(Schedule::from_json);
    let (quiet, schedule_zone_unknown) = evaluate_quiet(conn, schedule.as_ref()).await?;
    let now = stored.now.unwrap_or_else(Utc::now);
    let paused = crate::notification_rule::pause_in_force(stored.dnd, stored.dnd_until, now);
    Ok(PrefsView {
        kinds,
        sounds: parse_sounds(stored.presentation.as_ref()),
        schedule,
        phone_delay_secs: stored.phone_delay_secs.unwrap_or(PHONE_DELAY_DEFAULT_SECS),
        keyword_overrides_mute: stored.keyword_overrides_mute,
        approval_time_sensitive: stored.approval_time_sensitive,
        paused,
        paused_until: if paused { stored.dnd_until } else { None },
        quiet,
        schedule_zone_unknown,
    })
}

/// Read the caller's preferences (GET). **Self-scoped by construction**: the member is the
/// credential's, never a request field. No row answers every default.
pub async fn get_prefs_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<PrefsView, DbError> {
    let (stored, _) = load_prefs(conn, workspace_id, member_id, false).await?;
    view_of(conn, &stored).await
}

/// Is the member's **phone** switch for `kind` on, as stored right now. The diagnostics' `kind_off`
/// reads this, and the judgment SQL spells the same rule ([`phone_switch_on`]).
pub async fn kind_phone_switch_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    kind: NotificationKind,
) -> Result<bool, DbError> {
    let row = sqlx::query(
        "SELECT kinds, COALESCE(work_complete_push, true) AS work_complete_push \
           FROM notification_rule WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(workspace_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else {
        return Ok(true);
    };
    let kinds: Option<Value> = row.try_get("kinds")?;
    let work_complete_push: bool = row.try_get("work_complete_push")?;
    Ok(phone_switch_on(kind, kinds.as_ref(), work_complete_push))
}

// ---------------------------------------------------------------------------
// the write model
// ---------------------------------------------------------------------------

/// A patch of one cell: keep what is stored, reset to the default (JSON `null`), or set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CellPatch {
    #[default]
    Keep,
    Reset,
    Set(bool),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CellsPatch {
    pub phone: CellPatch,
    pub desktop: CellPatch,
}

impl CellsPatch {
    fn names_a_cell(&self) -> bool {
        self.phone != CellPatch::Keep || self.desktop != CellPatch::Keep
    }
}

/// A field-level write of `PATCH …/notification-prefs`. Every field is optional; an omitted one keeps
/// what is stored **when the write lands**, read under the row lock.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PrefsPatch {
    /// Per kind and surface. `workDone.phone` writes `work_complete_push` (D5 별칭).
    pub kinds: BTreeMap<NotificationKind, CellsPatch>,
    /// Per kind: a sound id, or `None` to reset to the default sound.
    pub sounds: BTreeMap<NotificationKind, Option<String>>,
    /// `Some(None)` removes the schedule; `Some(Some(_))` replaces it whole (D13: no partial merge).
    pub schedule: Option<Option<Schedule>>,
    pub phone_delay_secs: Option<i16>,
    pub keyword_overrides_mute: Option<bool>,
    pub approval_time_sensitive: Option<bool>,
    /// `confirm: ["approval_push_off"]` was sent.
    pub confirm_approval_push_off: bool,
}

impl PrefsPatch {
    /// Whether the patch names nothing to change. `confirm` alone is not a change.
    pub fn is_empty(&self) -> bool {
        !self.kinds.values().any(CellsPatch::names_a_cell)
            && self.sounds.is_empty()
            && self.schedule.is_none()
            && self.phone_delay_secs.is_none()
            && self.keyword_overrides_mute.is_none()
            && self.approval_time_sensitive.is_none()
    }
}

/// A patch the server refuses. Each is a 400 and **none has written anything** (see the module note).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrefsRejection {
    /// `approval.phone` true → false without `confirm: ["approval_push_off"]` (D5).
    ConfirmationRequired,
    /// `schedule.tz` is not a name in `pg_timezone_names` (an abbreviation like `PST` and a POSIX form
    /// like `UTC+9` are refused: Postgres's `AT TIME ZONE` would accept both, the second with the sign
    /// inverted).
    InvalidTimeZone,
    InvalidSchedule(&'static str),
    UnknownSound,
    /// A cell of a surface the kind does not have (`keyword.desktop`, …).
    SurfaceNotApplicable(NotificationKind),
    InvalidPhoneDelay,
}

impl PrefsRejection {
    /// The `error.code` the route sends.
    pub fn code(&self) -> &'static str {
        match self {
            PrefsRejection::ConfirmationRequired => "confirmation_required",
            PrefsRejection::InvalidTimeZone => "invalid_time_zone",
            PrefsRejection::InvalidSchedule(_) => "invalid_schedule",
            PrefsRejection::UnknownSound => "unknown_sound",
            PrefsRejection::SurfaceNotApplicable(_) => "surface_not_applicable",
            PrefsRejection::InvalidPhoneDelay => "invalid_phone_delay",
        }
    }

    pub fn message(&self) -> String {
        match self {
            PrefsRejection::ConfirmationRequired => {
                "turning approval push off needs confirm: [\"approval_push_off\"]".to_string()
            }
            PrefsRejection::InvalidTimeZone => {
                "schedule.tz must be a time zone name the database knows (an IANA name)".to_string()
            }
            PrefsRejection::InvalidSchedule(why) => format!("invalid schedule: {why}"),
            PrefsRejection::UnknownSound => "unknown sound id".to_string(),
            PrefsRejection::SurfaceNotApplicable(kind) => {
                format!("{} has no desktop switch", kind.as_str())
            }
            PrefsRejection::InvalidPhoneDelay => "phoneDelaySecs must be 0, 60 or 300".to_string(),
        }
    }
}

/// A patch that was applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrefsApplied {
    /// The stored preferences after the patch, evaluated in the same transaction.
    pub view: PrefsView,
    /// This write turned `approval.phone` from on to off (it was on, it is off now): the route adds
    /// the `approval_push_off` warning and writes the audit row.
    pub approval_push_turned_off: bool,
}

/// The pure checks of a patch — everything that needs neither the row nor the database.
fn validate_patch(patch: &PrefsPatch) -> Result<(), PrefsRejection> {
    for (kind, cells) in &patch.kinds {
        if !kind.has_desktop() && cells.desktop != CellPatch::Keep {
            return Err(PrefsRejection::SurfaceNotApplicable(*kind));
        }
    }
    for sound in patch.sounds.values().flatten() {
        if !is_known_sound(sound) {
            return Err(PrefsRejection::UnknownSound);
        }
    }
    if let Some(delay) = patch.phone_delay_secs {
        if !PHONE_DELAY_CHOICES.contains(&delay) {
            return Err(PrefsRejection::InvalidPhoneDelay);
        }
    }
    if let Some(Some(schedule)) = &patch.schedule {
        validate_schedule_shape(schedule)?;
    }
    Ok(())
}

/// Apply a [`CellsPatch`] to one kind's stored cells.
fn merge_cells(current: Cells, patch: &CellsPatch) -> Cells {
    let apply = |current: Option<bool>, patch: CellPatch| match patch {
        CellPatch::Keep => current,
        CellPatch::Reset => None,
        CellPatch::Set(value) => Some(value),
    };
    Cells {
        phone: apply(current.phone, patch.phone),
        desktop: apply(current.desktop, patch.desktop),
    }
}

/// The merged `kinds` cells. `workDone.phone` is **not** a cell (it is `work_complete_push`), so a
/// stray stored `workDone.phone` is dropped on the next write rather than being kept as a second,
/// disagreeing source of the same value.
fn merge_kinds(
    stored: &BTreeMap<NotificationKind, Cells>,
    patch: &BTreeMap<NotificationKind, CellsPatch>,
) -> BTreeMap<NotificationKind, Cells> {
    let mut merged = stored.clone();
    for (kind, cells_patch) in patch {
        if !cells_patch.names_a_cell() {
            continue;
        }
        let mut cells_patch = *cells_patch;
        if *kind == NotificationKind::WorkDone {
            cells_patch.phone = CellPatch::Keep;
        }
        let next = merge_cells(merged.get(kind).copied().unwrap_or_default(), &cells_patch);
        if next == Cells::default() {
            merged.remove(kind);
        } else {
            merged.insert(*kind, next);
        }
    }
    if let Some(cells) = merged.get_mut(&NotificationKind::WorkDone) {
        cells.phone = None;
        if *cells == Cells::default() {
            merged.remove(&NotificationKind::WorkDone);
        }
    }
    merged
}

/// Does `name` exist in `pg_timezone_names`? A name that Postgres only tolerates (an abbreviation, a
/// POSIX form) is not there, which is the point. This scans the whole view (about 15 ms a call), so
/// [`patch_prefs_in_tx`] asks it only for a name it cannot already vouch for.
async fn time_zone_name_exists(conn: &mut PgConnection, name: &str) -> Result<bool, DbError> {
    Ok(
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = $1)")
            .bind(name)
            .fetch_one(&mut *conn)
            .await?,
    )
}

/// Does the database still resolve `name` (one conversion, microseconds)? It accepts everything `AT
/// TIME ZONE` tolerates — an abbreviation, a POSIX form — so it is **never the validation of a new
/// name**: it only proves that a name which was validated when it was stored still works (a tzdata
/// change can retire one).
async fn time_zone_resolves(conn: &mut PgConnection, name: &str) -> Result<bool, DbError> {
    Ok(
        sqlx::query_scalar("SELECT notification_local_time($1, now()) IS NOT NULL")
            .bind(name)
            .fetch_one(&mut *conn)
            .await?,
    )
}

/// Apply a patch to the caller's preferences (PATCH). Returns the stored preferences after it, or the
/// rejection — **every rejection is decided before the first write** (see the module note).
///
/// Order: pure checks → the row (locked when it exists) → the zone name (a name equal to the stored one
/// is not looked up again) → the confirmation rule → materialize the default row and lock it → merge
/// onto what the lock shows → write only the named columns. The merge base is read under the lock, so two concurrent patches serialize and the second
/// merges onto the first one's committed row (a client that omits a field never reverts another
/// client's value of it).
pub async fn patch_prefs_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    patch: &PrefsPatch,
) -> Result<Result<PrefsApplied, PrefsRejection>, DbError> {
    if let Err(rejection) = validate_patch(patch) {
        return Ok(Err(rejection));
    }

    // The row first (locked when it exists): the zone check and the confirmation rule both decide on
    // what it says now. Reading is not writing — every rejection below still precedes the first write.
    let (early, _) = load_prefs(conn, workspace_id, member_id, true).await?;

    // The zone name. A name equal to the one already stored was validated when it was stored, so it
    // needs only the cheap proof that it still resolves; a schedule is replaced whole, so a client that
    // sends it back with one field changed would otherwise pay the 15 ms scan of `pg_timezone_names` on
    // every edit. Any other name — and a stored one that no longer resolves — takes the full lookup.
    if let Some(Some(schedule)) = &patch.schedule {
        let unchanged = early
            .schedule
            .as_ref()
            .and_then(Schedule::from_json)
            .is_some_and(|stored| stored.tz == schedule.tz);
        let vouched_for = unchanged && time_zone_resolves(conn, &schedule.tz).await?;
        if !vouched_for && !time_zone_name_exists(conn, &schedule.tz).await? {
            return Ok(Err(PrefsRejection::InvalidTimeZone));
        }
    }

    // The confirmation rule, decided on what the row says now. An absent row reads as the default
    // (on), so turning approval off without `confirm` is refused with nothing written.
    let turning_off = |stored: &StoredPrefs| {
        patch
            .kinds
            .get(&NotificationKind::Approval)
            .is_some_and(|cells| cells.phone == CellPatch::Set(false))
            && phone_switch_on(
                NotificationKind::Approval,
                stored.kinds.as_ref(),
                stored.work_complete_push,
            )
    };
    if turning_off(&early) && !patch.confirm_approval_push_off {
        return Ok(Err(PrefsRejection::ConfirmationRequired));
    }

    // From here on the patch is acceptable. `FOR UPDATE` on an absent row locks nothing, so the
    // default row is materialized first: two first writers serialize on its lock.
    sqlx::query(
        "INSERT INTO notification_rule (workspace_id, member_id) VALUES ($1, $2) \
         ON CONFLICT (workspace_id, member_id) DO NOTHING",
    )
    .bind(workspace_id)
    .bind(member_id)
    .execute(&mut *conn)
    .await?;
    let (locked, _) = load_prefs(conn, workspace_id, member_id, true).await?;
    let approval_push_turned_off = turning_off(&locked);

    let stored_cells = parse_cells(locked.kinds.as_ref());
    let merged_cells = merge_kinds(&stored_cells, &patch.kinds);
    // Rewritten only when a cell actually changes: a hand-edited `kinds` that this patch does not
    // touch is left as it is, and one it does touch is normalized to the known cells.
    let kinds_changed = merged_cells != stored_cells;

    let mut sounds = parse_sounds(locked.presentation.as_ref());
    for (kind, sound) in &patch.sounds {
        match sound {
            Some(id) => {
                sounds.insert(*kind, id.clone());
            }
            None => {
                sounds.remove(kind);
            }
        }
    }
    let sounds_changed = !patch.sounds.is_empty();

    // `workDone.phone` is `work_complete_push`: `Set` writes it, `Reset` is the default (on).
    let work_complete_push: Option<bool> =
        patch
            .kinds
            .get(&NotificationKind::WorkDone)
            .and_then(|cells| match cells.phone {
                CellPatch::Keep => None,
                CellPatch::Reset => Some(true),
                CellPatch::Set(value) => Some(value),
            });
    let schedule_value: Option<Value> = patch
        .schedule
        .as_ref()
        .and_then(|schedule| schedule.as_ref().map(Schedule::to_json));

    sqlx::query(
        "UPDATE notification_rule \
            SET kinds = CASE WHEN $3 THEN $4 ELSE kinds END, \
                presentation = CASE WHEN $5 THEN $6 ELSE presentation END, \
                schedule = CASE WHEN $7 THEN $8 ELSE schedule END, \
                phone_delay_secs = COALESCE($9, phone_delay_secs), \
                keyword_overrides_mute = COALESCE($10, keyword_overrides_mute), \
                approval_time_sensitive = COALESCE($11, approval_time_sensitive), \
                work_complete_push = COALESCE($12, work_complete_push), \
                updated_at = now() \
          WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(kinds_changed)
    .bind(render_cells(&merged_cells))
    .bind(sounds_changed)
    .bind(render_sounds(&sounds))
    .bind(patch.schedule.is_some())
    .bind(schedule_value)
    .bind(patch.phone_delay_secs)
    .bind(patch.keyword_overrides_mute)
    .bind(patch.approval_time_sensitive)
    .bind(work_complete_push)
    .execute(&mut *conn)
    .await?;

    let (after, _) = load_prefs(conn, workspace_id, member_id, false).await?;
    let view = view_of(conn, &after).await?;
    Ok(Ok(PrefsApplied {
        view,
        approval_push_turned_off,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn local(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(year, month, day)
            .unwrap()
            .and_hms_opt(hour, minute, 0)
            .unwrap()
    }

    fn schedule(days: &[u8], start: &str, end: &str) -> Schedule {
        Schedule {
            enabled: true,
            tz: "Asia/Seoul".into(),
            days: days.to_vec(),
            start: start.into(),
            end: end.into(),
            pass_through: vec![NotificationKind::Approval],
        }
    }

    #[test]
    fn the_kind_table_has_ten_kinds_and_four_without_a_desktop_cell() {
        assert_eq!(NotificationKind::ALL.len(), 10);
        let without_desktop: Vec<_> = NotificationKind::ALL
            .into_iter()
            .filter(|kind| !kind.has_desktop())
            .map(NotificationKind::as_str)
            .collect();
        assert_eq!(
            without_desktop,
            ["agentAnswer", "keyword", "threadReply", "scheduledFailed"]
        );
        for kind in NotificationKind::ALL {
            assert_eq!(NotificationKind::from_wire(kind.as_str()), Some(kind));
        }
        assert_eq!(NotificationKind::from_wire("Dm"), None);
    }

    /// A kind's wire name has two spellings in this crate: `as_str` (the keys of `kinds` and `sounds`,
    /// the diagnostics' `kind`) and serde's `camelCase` (the items of `passThrough`, the blocker's
    /// `kind`). A rename on one side alone would split the API in two; this pins that they agree.
    #[test]
    fn the_two_spellings_of_a_kind_agree() {
        for kind in NotificationKind::ALL {
            assert_eq!(serde_json::to_value(kind).unwrap(), json!(kind.as_str()));
            let back: NotificationKind = serde_json::from_value(json!(kind.as_str())).unwrap();
            assert_eq!(back, kind);
        }
    }

    #[test]
    fn a_missing_cell_is_the_default_and_only_a_literal_false_is_off() {
        let kinds = json!({
            "dm": {"phone": false},
            "mentionHuman": {"phone": "no"},
            "approval": "off",
            "bogusKind": {"phone": false},
        });
        assert!(!phone_switch_on(NotificationKind::Dm, Some(&kinds), true));
        for on in [
            NotificationKind::MentionHuman,
            NotificationKind::Approval,
            NotificationKind::ThreadReply,
        ] {
            assert!(phone_switch_on(on, Some(&kinds), true), "{on:?}");
        }
        assert!(phone_switch_on(NotificationKind::Dm, None, true));
        // `workDone` is the column, whatever a stray cell says.
        let stray = json!({"workDone": {"phone": false}});
        assert!(phone_switch_on(
            NotificationKind::WorkDone,
            Some(&stray),
            true
        ));
        assert!(!phone_switch_on(NotificationKind::WorkDone, None, false));
    }

    #[test]
    fn the_desktop_default_is_on_except_dm_and_absent_where_the_surface_does_not_apply() {
        let dm = effective_switch(NotificationKind::Dm, None, true);
        assert_eq!(
            dm,
            KindSwitch {
                phone: true,
                desktop: Some(false)
            }
        );
        let mention = effective_switch(NotificationKind::MentionHuman, None, true);
        assert_eq!(mention.desktop, Some(true));
        let keyword = effective_switch(NotificationKind::Keyword, None, true);
        assert_eq!(keyword.desktop, None);
    }

    #[test]
    fn a_null_cell_resets_to_the_default_and_an_emptied_kind_leaves_no_trace() {
        let mut stored = BTreeMap::new();
        stored.insert(
            NotificationKind::Dm,
            Cells {
                phone: Some(false),
                desktop: Some(true),
            },
        );
        let mut patch = BTreeMap::new();
        patch.insert(
            NotificationKind::Dm,
            CellsPatch {
                phone: CellPatch::Reset,
                desktop: CellPatch::Keep,
            },
        );
        let merged = merge_kinds(&stored, &patch);
        assert_eq!(
            merged.get(&NotificationKind::Dm),
            Some(&Cells {
                phone: None,
                desktop: Some(true)
            })
        );
        patch.insert(
            NotificationKind::Dm,
            CellsPatch {
                phone: CellPatch::Keep,
                desktop: CellPatch::Reset,
            },
        );
        let merged = merge_kinds(&merged, &patch);
        assert!(merged.is_empty());
        assert_eq!(render_cells(&merged), None);
    }

    #[test]
    fn work_done_phone_is_never_kept_as_a_cell() {
        let mut stored = BTreeMap::new();
        stored.insert(
            NotificationKind::WorkDone,
            Cells {
                phone: Some(false),
                desktop: None,
            },
        );
        let mut patch = BTreeMap::new();
        patch.insert(
            NotificationKind::WorkDone,
            CellsPatch {
                phone: CellPatch::Set(false),
                desktop: CellPatch::Set(false),
            },
        );
        let merged = merge_kinds(&stored, &patch);
        assert_eq!(
            merged.get(&NotificationKind::WorkDone),
            Some(&Cells {
                phone: None,
                desktop: Some(false)
            })
        );
    }

    #[test]
    fn a_desktop_write_to_a_kind_without_one_is_refused_and_so_is_an_unknown_sound() {
        let mut patch = PrefsPatch::default();
        patch.kinds.insert(
            NotificationKind::Keyword,
            CellsPatch {
                phone: CellPatch::Keep,
                desktop: CellPatch::Set(true),
            },
        );
        assert_eq!(
            validate_patch(&patch),
            Err(PrefsRejection::SurfaceNotApplicable(
                NotificationKind::Keyword
            ))
        );
        // Resetting a cell that does not exist is a write to it as well.
        patch.kinds.insert(
            NotificationKind::Keyword,
            CellsPatch {
                phone: CellPatch::Keep,
                desktop: CellPatch::Reset,
            },
        );
        assert!(validate_patch(&patch).is_err());

        let mut sounds = PrefsPatch::default();
        sounds
            .sounds
            .insert(NotificationKind::Dm, Some("user:abc".into()));
        assert_eq!(validate_patch(&sounds), Err(PrefsRejection::UnknownSound));
        sounds
            .sounds
            .insert(NotificationKind::Dm, Some("oort.dm".into()));
        assert_eq!(validate_patch(&sounds), Ok(()));
        sounds
            .sounds
            .insert(NotificationKind::Dm, Some("none".into()));
        assert_eq!(validate_patch(&sounds), Ok(()));
    }

    #[test]
    fn the_delay_is_one_of_three_values() {
        for ok in [0, 60, 300] {
            let patch = PrefsPatch {
                phone_delay_secs: Some(ok),
                ..PrefsPatch::default()
            };
            assert_eq!(validate_patch(&patch), Ok(()));
        }
        let patch = PrefsPatch {
            phone_delay_secs: Some(30),
            ..PrefsPatch::default()
        };
        assert_eq!(
            validate_patch(&patch),
            Err(PrefsRejection::InvalidPhoneDelay)
        );
    }

    #[test]
    fn a_schedule_with_equal_ends_no_days_or_a_bad_clock_is_invalid() {
        assert!(validate_schedule_shape(&schedule(&[1, 2], "09:00", "18:00")).is_ok());
        for bad in [
            schedule(&[1], "09:00", "09:00"),
            schedule(&[], "09:00", "18:00"),
            schedule(&[1, 1], "09:00", "18:00"),
            schedule(&[7], "09:00", "18:00"),
            schedule(&[1], "9:00", "18:00"),
            schedule(&[1], "09:00", "24:00"),
            schedule(&[1], "09:00", "18:60"),
        ] {
            assert!(
                matches!(
                    validate_schedule_shape(&bad),
                    Err(PrefsRejection::InvalidSchedule(_))
                ),
                "{bad:?}"
            );
        }
        // Switched off, an empty day list is just a saved-but-idle schedule.
        let mut off = schedule(&[], "09:00", "18:00");
        off.enabled = false;
        assert!(validate_schedule_shape(&off).is_ok());
    }

    #[test]
    fn a_same_day_window_is_inside_between_start_and_end_on_its_days() {
        // 2026-11-02 is a Monday (1).
        let work = schedule(&[1, 2, 3, 4, 5], "09:00", "18:00");
        let inside = window_state(&work, local(2026, 11, 2, 10, 0)).unwrap();
        assert!(inside.inside);
        assert_eq!(inside.next_open, None);
        let before = window_state(&work, local(2026, 11, 2, 8, 59)).unwrap();
        assert!(!before.inside);
        assert_eq!(before.next_open, Some(local(2026, 11, 2, 9, 0)));
        let after = window_state(&work, local(2026, 11, 2, 18, 0)).unwrap();
        assert!(!after.inside);
        assert_eq!(after.next_open, Some(local(2026, 11, 3, 9, 0)));
        // Friday evening: the next opening is Monday.
        let friday = window_state(&work, local(2026, 11, 6, 19, 0)).unwrap();
        assert_eq!(friday.next_open, Some(local(2026, 11, 9, 9, 0)));
        // A Sunday is not a window day.
        assert!(
            !window_state(&work, local(2026, 11, 8, 12, 0))
                .unwrap()
                .inside
        );
    }

    #[test]
    fn a_window_that_crosses_midnight_belongs_to_the_day_it_starts() {
        // Friday (5) 22:00 – 06:00.
        let night = schedule(&[5], "22:00", "06:00");
        // Friday 23:00 and Saturday 02:00 are inside; Saturday 22:00 is not (Saturday is no start day).
        assert!(
            window_state(&night, local(2026, 11, 6, 23, 0))
                .unwrap()
                .inside
        );
        assert!(
            window_state(&night, local(2026, 11, 7, 2, 0))
                .unwrap()
                .inside
        );
        let saturday_night = window_state(&night, local(2026, 11, 7, 22, 0)).unwrap();
        assert!(!saturday_night.inside);
        assert_eq!(saturday_night.next_open, Some(local(2026, 11, 13, 22, 0)));
        // Friday 02:00 belongs to Thursday's window, which does not exist.
        assert!(
            !window_state(&night, local(2026, 11, 6, 2, 0))
                .unwrap()
                .inside
        );
        // The end is exclusive.
        assert!(
            !window_state(&night, local(2026, 11, 7, 6, 0))
                .unwrap()
                .inside
        );
    }

    #[test]
    fn a_degenerate_schedule_has_no_window_state() {
        assert_eq!(
            window_state(&schedule(&[1], "09:00", "09:00"), local(2026, 11, 2, 9, 0)),
            None
        );
        assert_eq!(
            window_state(&schedule(&[1], "nine", "18:00"), local(2026, 11, 2, 9, 0)),
            None
        );
        // No day at all would be a window that never opens: not "quiet for ever", no schedule.
        assert_eq!(
            window_state(&schedule(&[], "09:00", "18:00"), local(2026, 11, 2, 9, 0)),
            None
        );
    }

    #[test]
    fn a_stored_schedule_reads_back_and_a_malformed_one_is_no_schedule() {
        let original = schedule(&[1, 5], "22:00", "06:00");
        assert_eq!(Schedule::from_json(&original.to_json()), Some(original));
        assert_eq!(Schedule::from_json(&json!({"enabled": true})), None);
        assert_eq!(Schedule::from_json(&json!("nope")), None);
        let bad_day = json!({"enabled": true, "tz": "UTC", "days": [9], "start": "09:00",
                             "end": "18:00", "passThrough": []});
        assert_eq!(Schedule::from_json(&bad_day), None);
    }

    #[test]
    fn an_empty_patch_names_nothing_and_confirm_alone_is_not_a_change() {
        assert!(PrefsPatch::default().is_empty());
        let confirm_only = PrefsPatch {
            confirm_approval_push_off: true,
            ..PrefsPatch::default()
        };
        assert!(confirm_only.is_empty());
        let mut naming_a_kind = PrefsPatch::default();
        naming_a_kind
            .kinds
            .insert(NotificationKind::Dm, CellsPatch::default());
        assert!(
            naming_a_kind.is_empty(),
            "a kind that names no cell is no change"
        );
        naming_a_kind.kinds.insert(
            NotificationKind::Dm,
            CellsPatch {
                phone: CellPatch::Reset,
                desktop: CellPatch::Keep,
            },
        );
        assert!(!naming_a_kind.is_empty());
    }
}
