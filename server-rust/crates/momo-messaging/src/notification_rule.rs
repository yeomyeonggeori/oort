//! Member-global notification rules (ADR-0124 증보 1) — the read/write half of
//! the `notification_rule` row the notifier judgment consumes.
//!
//! Two orthogonal switches, both per (workspace, member) and both defaulting to
//! `false` by ROW ABSENCE (066 migration header):
//!
//!   * `dnd` — do not disturb. Suppresses every push for this member in this
//!     workspace. The notifier applies it above channel mute.
//!   * `mention_overrides_mute` — a channel this member muted in 018 still
//!     notifies them on `reason='mention'`, the switch ADR-0124 D3 reserved.
//!
//! Unlike [`crate::channel::set_notification_pref_in_tx`] there is no channel
//! membership gate: the row is the SIGNED-IN member's own workspace-wide
//! preference, and the caller is that member (the route binds
//! `principal.member_id`), so a `memberId` parameter would let one member edit
//! another's rules. Tenant isolation is FORCE RLS plus the `workspace_id` the
//! caller's tenant transaction sets.
//!
//! ## 증보 2 (#2850): expiry and the DND bundle
//!
//! `dnd_until` (migration 090) gives the pause an expiry. It is compared at the
//! point of use — the push judgment SQL and [`get_notification_rule_in_tx`] —
//! never by a sweeper: an expired pause reads as "off" and delivers.
//!
//! Declared DND (`member.presence_status='dnd'`) is bundled with the pause
//! (성재 2026-09-27 「묶어」). [`engage_presence_dnd_bundle_in_tx`] and
//! [`release_presence_dnd_bundle_in_tx`] are called ONLY from
//! `presence::set_declared_presence_in_tx`, inside the same transaction that
//! updates the member row and emits the presence broadcasts. The pre-bundle
//! pause is remembered in `presence_prev_dnd`/`presence_prev_dnd_until` and put
//! back on release. An explicit rule PUT that changes the pause breaks the link
//! (the memory is cleared) so releasing DND never overwrites a choice the member
//! made by hand.

use chrono::{DateTime, Utc};
use momo_db::DbError;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::presence::StatusPatch;

/// The effective rule for one member. Absence of a row is `Self::default()`
/// (all off, no expiry), which is the pre-증보 behaviour: nothing is suppressed
/// and no channel mute is pierced.
///
/// `dnd` here is always the EFFECTIVE value: a stored pause whose `dnd_until`
/// has passed reads as `dnd = false, dnd_until = None`. `dnd_until` is `Some`
/// only while a timed pause is still running.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct NotificationRule {
    pub dnd: bool,
    pub dnd_until: Option<DateTime<Utc>>,
    pub mention_overrides_mute: bool,
}

/// A rule write. `dnd_until` is a patch: `Absent` keeps a still-running expiry
/// when the pause stays on (so an older client's plain toggle does not wipe a
/// timer, and an expired timer never turns a fresh "on" into a no-op);
/// `Set(None)` is "no expiry"; `Set(Some(t))` is "until t". `dnd = false`
/// always clears the expiry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NotificationRuleUpdate {
    pub dnd: bool,
    pub dnd_until: StatusPatch<DateTime<Utc>>,
    pub mention_overrides_mute: bool,
}

impl From<NotificationRule> for NotificationRuleUpdate {
    /// Full replacement, expiry included.
    fn from(rule: NotificationRule) -> Self {
        Self {
            dnd: rule.dnd,
            dnd_until: StatusPatch::Set(rule.dnd_until),
            mention_overrides_mute: rule.mention_overrides_mute,
        }
    }
}

/// Whether a stored pause is in force at `now`. The single Rust spelling of the
/// judgment SQL's `dnd AND (dnd_until IS NULL OR dnd_until > now())`.
pub fn pause_in_force(dnd: bool, dnd_until: Option<DateTime<Utc>>, now: DateTime<Utc>) -> bool {
    dnd && dnd_until.is_none_or(|until| until > now)
}

/// The stored row, raw (expiry not applied), plus the database clock.
#[derive(Debug, Clone, Copy, Default)]
struct StoredRule {
    dnd: bool,
    dnd_until: Option<DateTime<Utc>>,
    mention_overrides_mute: bool,
    prev_dnd: Option<bool>,
    prev_dnd_until: Option<DateTime<Utc>>,
}

impl StoredRule {
    fn effective(&self, now: DateTime<Utc>) -> NotificationRule {
        let on = pause_in_force(self.dnd, self.dnd_until, now);
        NotificationRule {
            dnd: on,
            dnd_until: if on { self.dnd_until } else { None },
            mention_overrides_mute: self.mention_overrides_mute,
        }
    }
}

/// How [`load_rule`] reads the row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Load {
    /// Plain read (GET).
    Read,
    /// Row-lock an existing row; an absent row stays absent (release: nothing
    /// to restore, nothing written).
    Lock,
    /// Insert the default row if absent, then row-lock it (every path that
    /// writes), so two first writers serialize instead of the later upsert
    /// overwriting the earlier one's switches.
    Materialize,
}

/// Read (and row-lock, per `mode`) the stored rule together with the database
/// clock, so every expiry comparison in one transaction uses the same `now()`
/// the judgment SQL uses.
async fn load_rule(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    mode: Load,
) -> Result<(StoredRule, DateTime<Utc>), DbError> {
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT now()")
        .fetch_one(&mut *conn)
        .await?;
    if mode == Load::Materialize {
        // `FOR UPDATE` on an absent row locks nothing: two first writers would
        // both compute from the defaults and the later upsert would overwrite
        // the earlier one's switches. Materialize the default row first so the
        // lock below always has a row to hold (second writer waits here).
        // Today the presence path is also serialized by its member `FOR
        // UPDATE` against the FK `KEY SHARE` a first rule INSERT takes; this
        // guard does not lean on that.
        sqlx::query(
            "INSERT INTO notification_rule (workspace_id, member_id) VALUES ($1, $2) \
             ON CONFLICT (workspace_id, member_id) DO NOTHING",
        )
        .bind(workspace_id)
        .bind(member_id)
        .execute(&mut *conn)
        .await?;
    }
    let sql = if mode != Load::Read {
        "SELECT dnd, dnd_until, mention_overrides_mute, presence_prev_dnd, presence_prev_dnd_until \
           FROM notification_rule \
          WHERE workspace_id = $1 AND member_id = $2 \
          FOR UPDATE"
    } else {
        "SELECT dnd, dnd_until, mention_overrides_mute, presence_prev_dnd, presence_prev_dnd_until \
           FROM notification_rule \
          WHERE workspace_id = $1 AND member_id = $2"
    };
    let row = sqlx::query(sql)
        .bind(workspace_id)
        .bind(member_id)
        .fetch_optional(&mut *conn)
        .await?;
    let stored = match row {
        Some(row) => StoredRule {
            dnd: row.try_get("dnd")?,
            dnd_until: row.try_get("dnd_until")?,
            mention_overrides_mute: row.try_get("mention_overrides_mute")?,
            prev_dnd: row.try_get("presence_prev_dnd")?,
            prev_dnd_until: row.try_get("presence_prev_dnd_until")?,
        },
        None => StoredRule::default(),
    };
    Ok((stored, now))
}

async fn store_rule(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    rule: &StoredRule,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO notification_rule \
           (workspace_id, member_id, dnd, dnd_until, mention_overrides_mute, \
            presence_prev_dnd, presence_prev_dnd_until) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) \
         ON CONFLICT (workspace_id, member_id) \
         DO UPDATE SET dnd = EXCLUDED.dnd, \
                       dnd_until = EXCLUDED.dnd_until, \
                       mention_overrides_mute = EXCLUDED.mention_overrides_mute, \
                       presence_prev_dnd = EXCLUDED.presence_prev_dnd, \
                       presence_prev_dnd_until = EXCLUDED.presence_prev_dnd_until, \
                       updated_at = now()",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(rule.dnd)
    .bind(rule.dnd_until)
    .bind(rule.mention_overrides_mute)
    .bind(rule.prev_dnd)
    .bind(rule.prev_dnd_until)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Read the calling member's effective rule, defaulting when no row exists.
pub async fn get_notification_rule_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<NotificationRule, DbError> {
    let (stored, now) = load_rule(conn, workspace_id, member_id, Load::Read).await?;
    Ok(stored.effective(now))
}

/// Upsert the calling member's rule and return the effective stored value.
///
/// PUT replaces both switches (the settings panel holds the full state); the
/// expiry is a patch (see [`NotificationRuleUpdate`]). A rule turned all the
/// way off is stored as an explicit row rather than deleted — judgment reads
/// `COALESCE(..., false)` either way, so the two are indistinguishable at the
/// point of use.
///
/// If the write changes the pause (`dnd` or `dnd_until`), a DND bundle in force
/// is broken: the member chose the pause by hand, and releasing DND must not
/// overwrite that. A write that leaves the pause as it was (toggling only the
/// mention exception) keeps the bundle.
pub async fn set_notification_rule_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    update: impl Into<NotificationRuleUpdate>,
) -> Result<NotificationRule, DbError> {
    let update = update.into();
    let (current, now) = load_rule(conn, workspace_id, member_id, Load::Materialize).await?;
    let dnd_until = if !update.dnd {
        None
    } else {
        match update.dnd_until {
            StatusPatch::Set(until) => until,
            // Keep a still-running expiry; an expired or absent one becomes "no
            // expiry" so a fresh "on" is never silently already over.
            StatusPatch::Absent => {
                if pause_in_force(current.dnd, current.dnd_until, now) {
                    current.dnd_until
                } else {
                    None
                }
            }
        }
    };
    let pause_changed = update.dnd != current.dnd || dnd_until != current.dnd_until;
    let next = StoredRule {
        dnd: update.dnd,
        dnd_until,
        mention_overrides_mute: update.mention_overrides_mute,
        prev_dnd: if pause_changed {
            None
        } else {
            current.prev_dnd
        },
        prev_dnd_until: if pause_changed {
            None
        } else {
            current.prev_dnd_until
        },
    };
    store_rule(conn, workspace_id, member_id, &next).await?;
    Ok(next.effective(now))
}

/// A field-level rule write (#3012, `PATCH …/notification-rules`). Every field
/// is optional: an absent field keeps what is stored **at the moment of the
/// write**, read under the row lock — not what the client last saw. That is
/// what lets the web settings panel and the phone each change their own switch
/// without erasing the other's (a PUT carries a whole snapshot, so the later of
/// two PUTs silently reverts the earlier one's field).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct NotificationRulePatch {
    pub dnd: Option<bool>,
    /// Same meaning as [`NotificationRuleUpdate::dnd_until`]; ignored (cleared)
    /// when the resulting `dnd` is false.
    pub dnd_until: StatusPatch<DateTime<Utc>>,
    pub mention_overrides_mute: Option<bool>,
}

impl NotificationRulePatch {
    /// Whether the patch names no field at all.
    pub fn is_empty(&self) -> bool {
        self.dnd.is_none()
            && self.mention_overrides_mute.is_none()
            && self.dnd_until == StatusPatch::Absent
    }
}

/// Apply a [`NotificationRulePatch`] to the calling member's rule and return the
/// effective stored value.
///
/// The row is materialized and row-locked **before** the merge base is read, so
/// two concurrent patches serialize: the second one waits, then merges onto the
/// first one's committed row. The write itself is [`set_notification_rule_in_tx`]
/// (same transaction, lock already held), so the expiry and DND-bundle rules
/// are exactly the PUT's: a patch that leaves the pause alone keeps a bundle.
pub async fn patch_notification_rule_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    patch: NotificationRulePatch,
) -> Result<NotificationRule, DbError> {
    let (current, now) = load_rule(conn, workspace_id, member_id, Load::Materialize).await?;
    let base = current.effective(now);
    let update = NotificationRuleUpdate {
        dnd: patch.dnd.unwrap_or(base.dnd),
        dnd_until: patch.dnd_until,
        mention_overrides_mute: patch
            .mention_overrides_mute
            .unwrap_or(base.mention_overrides_mute),
    };
    set_notification_rule_in_tx(conn, workspace_id, member_id, update).await
}

/// Which kinds of push this member wants (ADR-0120 부록 A, #3341).
///
/// Deliberately NOT a field of [`NotificationRule`]: that struct is the DND /
/// mention-exception pair every presence and PUT path builds literally, and its
/// writers (`store_rule`) replace a row wholesale. The kind switches live in
/// their own columns with their own read/patch functions, so a DND write cannot
/// reset them and a kind write cannot disturb a DND bundle. The notifier judgment
/// reads the same row (`notification_rule.work_complete_push`).
///
/// Absence of a row is `Self::default()`: every kind on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PushKinds {
    /// 「작업 끝남」 — `reason = work_session_idle`, only for sessions the member
    /// started (the judgment decides that; this is the member's own off switch).
    pub work_complete: bool,
}

impl Default for PushKinds {
    fn default() -> Self {
        Self {
            work_complete: true,
        }
    }
}

/// A field-level push-kinds write. An absent field keeps what is stored when the
/// write lands (read under the row lock).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PushKindsPatch {
    pub work_complete: Option<bool>,
}

impl PushKindsPatch {
    pub fn is_empty(&self) -> bool {
        self.work_complete.is_none()
    }
}

/// Read the calling member's push-kind switches, defaulting when no row exists.
pub async fn get_push_kinds_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<PushKinds, DbError> {
    let stored: Option<bool> = sqlx::query_scalar(
        "SELECT work_complete_push FROM notification_rule \
          WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(workspace_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(PushKinds {
        work_complete: stored.unwrap_or(true),
    })
}

/// Apply a [`PushKindsPatch`] and return the stored value. The default row is
/// materialized first (so two first writers serialize on its lock, as in
/// [`load_rule`]); only the named columns are written — the DND columns and any
/// presence bundle are untouched.
pub async fn patch_push_kinds_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    patch: PushKindsPatch,
) -> Result<PushKinds, DbError> {
    sqlx::query(
        "INSERT INTO notification_rule (workspace_id, member_id) VALUES ($1, $2) \
         ON CONFLICT (workspace_id, member_id) DO NOTHING",
    )
    .bind(workspace_id)
    .bind(member_id)
    .execute(&mut *conn)
    .await?;
    let stored: bool = sqlx::query_scalar(
        "UPDATE notification_rule \
            SET work_complete_push = COALESCE($3, work_complete_push), \
                updated_at = CASE WHEN $3 IS NOT NULL THEN now() ELSE updated_at END \
          WHERE workspace_id = $1 AND member_id = $2 \
      RETURNING work_complete_push",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(patch.work_complete)
    .fetch_one(&mut *conn)
    .await?;
    Ok(PushKinds {
        work_complete: stored,
    })
}

/// The pause a DND bundle sets: on, until the later of the pre-bundle pause
/// and the DND expiry. A pre-bundle pause with no expiry keeps the result
/// indefinite ("원래 켜져 있었으면 유지"); a pre-bundle pause that was off
/// makes the result expire exactly with DND ("만료 동시 해제").
fn bundled_until(
    prev_dnd: bool,
    prev_until: Option<DateTime<Utc>>,
    dnd_until: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    if !pause_in_force(prev_dnd, prev_until, now) {
        return dnd_until;
    }
    match (prev_until, dnd_until) {
        (Some(prev), Some(dnd)) => Some(prev.max(dnd)),
        _ => None,
    }
}

/// Declared DND turned on (or its expiry re-chosen): turn the pause on with the
/// same expiry, remembering the pre-bundle pause the first time only.
///
/// Called only from `presence::set_declared_presence_in_tx`, in the same
/// transaction as the member update and the presence outbox rows. Returns the
/// effective rule after the write.
pub(crate) async fn engage_presence_dnd_bundle_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    dnd_until: Option<DateTime<Utc>>,
) -> Result<NotificationRule, DbError> {
    let (current, now) = load_rule(conn, workspace_id, member_id, Load::Materialize).await?;
    // Snapshot once. Re-snapshotting while the bundle is in force would capture
    // the bundled value itself and releasing DND would then keep the pause on.
    let (prev_dnd, prev_until) = match current.prev_dnd {
        Some(prev) => (prev, current.prev_dnd_until),
        None => (current.dnd, current.dnd_until),
    };
    let next = StoredRule {
        dnd: true,
        dnd_until: bundled_until(prev_dnd, prev_until, dnd_until, now),
        mention_overrides_mute: current.mention_overrides_mute,
        prev_dnd: Some(prev_dnd),
        prev_dnd_until: if prev_dnd { prev_until } else { None },
    };
    store_rule(conn, workspace_id, member_id, &next).await?;
    Ok(next.effective(now))
}

/// Declared DND turned off: put the pre-bundle pause back and forget it. A
/// member with no bundle in force (never bundled, or the link was broken by an
/// explicit rule PUT) is left untouched.
pub(crate) async fn release_presence_dnd_bundle_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<NotificationRule, DbError> {
    let (current, now) = load_rule(conn, workspace_id, member_id, Load::Lock).await?;
    let Some(prev_dnd) = current.prev_dnd else {
        return Ok(current.effective(now));
    };
    let next = StoredRule {
        dnd: prev_dnd,
        dnd_until: if prev_dnd {
            current.prev_dnd_until
        } else {
            None
        },
        mention_overrides_mute: current.mention_overrides_mute,
        prev_dnd: None,
        prev_dnd_until: None,
    };
    store_rule(conn, workspace_id, member_id, &next).await?;
    Ok(next.effective(now))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    #[test]
    fn an_expired_pause_is_not_in_force() {
        let now = Utc::now();
        assert!(pause_in_force(true, None, now));
        assert!(pause_in_force(true, Some(now + Duration::minutes(1)), now));
        assert!(!pause_in_force(true, Some(now), now));
        assert!(!pause_in_force(true, Some(now - Duration::seconds(1)), now));
        assert!(!pause_in_force(false, None, now));
    }

    #[test]
    fn the_bundle_expires_with_dnd_when_the_pause_was_off() {
        let now = Utc::now();
        let dnd = Some(now + Duration::hours(1));
        assert_eq!(bundled_until(false, None, dnd, now), dnd);
        assert_eq!(bundled_until(false, None, None, now), None);
        // An expired pre-bundle pause counts as off.
        assert_eq!(
            bundled_until(true, Some(now - Duration::minutes(1)), dnd, now),
            dnd
        );
    }

    #[test]
    fn a_pause_that_was_on_is_kept_through_the_bundle() {
        let now = Utc::now();
        let short = Some(now + Duration::minutes(30));
        let long = Some(now + Duration::hours(2));
        // Indefinite stays indefinite.
        assert_eq!(bundled_until(true, None, long, now), None);
        // Timed pause vs timed DND: the later one wins either way round.
        assert_eq!(bundled_until(true, short, long, now), long);
        assert_eq!(bundled_until(true, long, short, now), long);
        // Timed pause vs indefinite DND: indefinite.
        assert_eq!(bundled_until(true, short, None, now), None);
    }

    #[test]
    fn an_expired_stored_pause_reads_as_off() {
        let now = Utc::now();
        let stored = StoredRule {
            dnd: true,
            dnd_until: Some(now - Duration::seconds(1)),
            mention_overrides_mute: true,
            prev_dnd: None,
            prev_dnd_until: None,
        };
        assert_eq!(
            stored.effective(now),
            NotificationRule {
                dnd: false,
                dnd_until: None,
                mention_overrides_mute: true,
            }
        );
    }
}
