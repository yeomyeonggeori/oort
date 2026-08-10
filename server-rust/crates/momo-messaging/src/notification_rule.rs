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

use momo_db::DbError;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

/// The effective rule for one member. Absence of a row is `Self::default()`
/// (both `false`, since `bool` defaults to `false`), which is the pre-증보
/// behaviour: nothing is suppressed and no channel mute is pierced.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct NotificationRule {
    pub dnd: bool,
    pub mention_overrides_mute: bool,
}

/// Read the calling member's rule, defaulting when no row exists.
pub async fn get_notification_rule_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<NotificationRule, DbError> {
    let row = sqlx::query(
        "SELECT dnd, mention_overrides_mute \
           FROM notification_rule \
          WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(workspace_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(match row {
        Some(row) => NotificationRule {
            dnd: row.get("dnd"),
            mention_overrides_mute: row.get("mention_overrides_mute"),
        },
        None => NotificationRule::default(),
    })
}

/// Upsert the calling member's rule and return the stored value.
///
/// PUT replaces the whole rule (both booleans), matching the settings panel that
/// always holds the full state and the `deny_unknown_fields` request DTO. Both
/// defaulting to `false` means a rule that is turned all the way off is stored as
/// an explicit `(false, false)` row rather than deleted — the row is cheap, and
/// keeping it avoids a delete/insert dance when a member toggles one switch back
/// and forth. Judgment reads `COALESCE(..., false)` either way, so a stored
/// `(false, false)` and an absent row are indistinguishable at the point of use.
pub async fn set_notification_rule_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    rule: NotificationRule,
) -> Result<NotificationRule, DbError> {
    sqlx::query(
        "INSERT INTO notification_rule \
           (workspace_id, member_id, dnd, mention_overrides_mute) \
         VALUES ($1, $2, $3, $4) \
         ON CONFLICT (workspace_id, member_id) \
         DO UPDATE SET dnd = EXCLUDED.dnd, \
                       mention_overrides_mute = EXCLUDED.mention_overrides_mute, \
                       updated_at = now()",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(rule.dnd)
    .bind(rule.mention_overrides_mute)
    .execute(&mut *conn)
    .await?;
    Ok(rule)
}
