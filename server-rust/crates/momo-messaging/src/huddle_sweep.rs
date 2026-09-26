//! Ghost-participant settlement for the huddle sweep (#2758 / ADR-0122 증보
//! D-H4).
//!
//! A client that dies without calling leave (app crash, a phone dropping off
//! the network, a closed laptop) leaves its `huddle_participant` row open. The
//! huddle then never ends, and `huddle_channel_active_uniq` stops anyone from
//! starting a new one in that channel. The server-side sweep in `momo-notifier`
//! compares each active huddle with LiveKit's own room state and asks this
//! module to settle whoever LiveKit no longer has.
//!
//! The split follows `approval_sweep` (invariant #6):
//!
//! 1. [`active_huddles_for_sweep`] — one cross-tenant **read** on the pool, the
//!    only way a sweep can learn which tenants have work.
//! 2. [`settle_swept_departures`] — every **write** inside a per-workspace
//!    tenant transaction (`SET LOCAL app.workspace_id`) on a pool whose role
//!    RLS actually binds (the NOBYPASSRLS `momo_app` role — checked by
//!    [`ensure_rls_enforced`], never assumed), and through the same
//!    end path a person's leave takes
//!    ([`crate::huddle::settle_departures_in_tx`]): `left_at`, `ended_at`, the
//!    recording stop, and the `huddle_ended` outbox row commit together or not
//!    at all.
//!
//! This module never contacts LiveKit. Deciding *who* is gone (the two-miss
//! rule, the join grace, "unreachable changes nothing") is the notifier's; this
//! module only makes the settlement safe against a person acting at the same
//! moment.

use chrono::{DateTime, Utc};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{PgConnection, PgPool};
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::huddle::{active_participant_ids, settle_departures_in_tx, tenant_tx, HuddleError};

/// An open participation as the sweep observed it. `joined_at` is part of the
/// row's identity: a member who re-joins gets a new row, and a settlement aimed
/// at the old one must not close the new one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SweptParticipant {
    pub member_id: Uuid,
    pub joined_at: DateTime<Utc>,
}

/// A participant the sweep has judged gone, with the moment from which a
/// `join_huddle` call by that member proves them back.
///
/// `join_huddle` reuses an open row (`ON CONFLICT … DO NOTHING`), so a client
/// that crashed and re-joined keeps the same `(member_id, joined_at)` the sweep
/// has been counting. The re-join still writes a `huddle.joined` audit row in
/// its own transaction; a settlement that finds one at or after `rejoin_cutoff`
/// leaves the row open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SweptDeparture {
    pub participant: SweptParticipant,
    pub rejoin_cutoff: DateTime<Utc>,
}

/// One active huddle and its open participant rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SweepHuddle {
    pub huddle_id: Uuid,
    pub workspace_id: Uuid,
    pub channel_id: Uuid,
    pub started_at: DateTime<Utc>,
    pub participants: Vec<SweptParticipant>,
}

/// What one settlement did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SweepSettlement {
    /// Participant rows this settlement closed.
    pub marked_left: Vec<Uuid>,
    /// Whether the huddle ended in this transaction.
    pub ended: bool,
    /// The huddle had already ended, or every targeted row had already changed
    /// (a leave or a re-join won the race). Nothing was written.
    pub raced: bool,
}

/// Why the sweep refused to run or a settlement failed.
#[derive(Debug, thiserror::Error)]
pub enum SweepError {
    #[error(transparent)]
    Huddle(#[from] HuddleError),
    /// The write pool's role would ignore RLS. The sweep adds no RLS-bypassing
    /// write path (ADR-0122 증보 D-H4, AGENTS.md exception list unchanged), so
    /// it refuses to settle anything through such a pool.
    #[error(
        "huddle sweep write pool connects as {role}, which bypasses RLS; point \
         MOMO_HUDDLE_SWEEP_DATABASE_URL at the NOBYPASSRLS momo_app role"
    )]
    WritePoolBypassesRls { role: String },
}

impl From<sqlx::Error> for SweepError {
    fn from(error: sqlx::Error) -> Self {
        SweepError::Huddle(HuddleError::from(error))
    }
}

/// Refuse a write pool whose role is a superuser or BYPASSRLS.
///
/// Settlement writes (`left_at`, `ended_at`, the outbox row, the audit row) must
/// be filtered by the tenant policies exactly like a request's, so the GUC set
/// by the tenant transaction is binding rather than decorative.
pub async fn ensure_rls_enforced(pool: &PgPool) -> Result<(), SweepError> {
    let row = sqlx::query(
        "SELECT current_user::text AS role, (rolsuper OR rolbypassrls) AS bypasses \
           FROM pg_roles WHERE rolname = current_user",
    )
    .fetch_one(pool)
    .await?;
    let role: String = row.try_get("role")?;
    if row.try_get::<bool, _>("bypasses")? {
        return Err(SweepError::WritePoolBypassesRls { role });
    }
    Ok(())
}

/// Every active huddle with its open participant rows, oldest first.
///
/// Cross-tenant by necessity and read-only; the caller connects as the
/// BYPASSRLS notifier role exactly like the approval and control-window sweeps.
pub async fn active_huddles_for_sweep(
    pool: &PgPool,
    limit: i64,
) -> Result<Vec<SweepHuddle>, HuddleError> {
    let rows = sqlx::query(
        "WITH active AS ( \
           SELECT id, workspace_id, channel_id, started_at FROM huddle \
            WHERE ended_at IS NULL ORDER BY started_at, id LIMIT $1) \
         SELECT a.id, a.workspace_id, a.channel_id, a.started_at, \
                hp.member_id, hp.joined_at \
           FROM active a \
           LEFT JOIN huddle_participant hp \
             ON hp.huddle_id = a.id AND hp.left_at IS NULL \
          ORDER BY a.started_at, a.id, hp.joined_at",
    )
    .bind(limit.max(1))
    .fetch_all(pool)
    .await?;

    let mut huddles: Vec<SweepHuddle> = Vec::new();
    for row in rows {
        let huddle_id: Uuid = row.try_get("id")?;
        if huddles.last().map(|h| h.huddle_id) != Some(huddle_id) {
            huddles.push(SweepHuddle {
                huddle_id,
                workspace_id: row.try_get("workspace_id")?,
                channel_id: row.try_get("channel_id")?,
                started_at: row.try_get("started_at")?,
                participants: Vec::new(),
            });
        }
        let member_id: Option<Uuid> = row.try_get("member_id")?;
        let joined_at: Option<DateTime<Utc>> = row.try_get("joined_at")?;
        if let (Some(member_id), Some(joined_at), Some(huddle)) =
            (member_id, joined_at, huddles.last_mut())
        {
            huddle.participants.push(SweptParticipant {
                member_id,
                joined_at,
            });
        }
    }
    Ok(huddles)
}

/// Close the given participant rows and, when nobody is left, end the huddle —
/// one tenant transaction.
///
/// `end_if_empty` covers a huddle that has no open participant rows at all (it
/// was started and nobody ever joined, or its rows were closed some other way):
/// the sweep asks for it to end only after observing it empty twice.
///
/// Race rules, each of which leaves the row a person just wrote untouched:
/// * the huddle row is locked `FOR UPDATE`, the lock `join_huddle` and
///   `leave_huddle` take, so the sweep and a person serialize;
/// * an already-ended huddle is a race, not an error;
/// * each `left_at` is keyed on the full identity `(huddle_id, member_id,
///   joined_at)`, so a leave → re-join (a new row) survives;
/// * a crash → re-join reuses the open row, so a `huddle.joined` audit row by
///   that member at or after [`SweptDeparture::rejoin_cutoff`] keeps it open;
/// * the end is re-derived inside the transaction from the rows as they are
///   now, never from the observation.
pub async fn settle_swept_departures(
    pool: &PgPool,
    workspace_id: Uuid,
    huddle_id: Uuid,
    departures: Vec<SweptDeparture>,
    end_if_empty: bool,
) -> Result<SweepSettlement, HuddleError> {
    tenant_tx(pool, workspace_id, move |conn| {
        Box::pin(async move {
            settle_in_tx(conn, workspace_id, huddle_id, &departures, end_if_empty).await
        })
    })
    .await
}

async fn settle_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    huddle_id: Uuid,
    departures: &[SweptDeparture],
    end_if_empty: bool,
) -> Result<SweepSettlement, HuddleError> {
    let raced = SweepSettlement {
        raced: true,
        ..SweepSettlement::default()
    };
    let row = sqlx::query(
        "SELECT channel_id, ended_at IS NOT NULL AS ended FROM huddle \
          WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
    )
    .bind(huddle_id)
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else {
        return Ok(raced);
    };
    if row.try_get::<bool, _>("ended")? {
        return Ok(raced);
    }
    let channel_id: Uuid = row.try_get("channel_id")?;

    let mut marked_left = Vec::new();
    for departure in departures {
        let closed: Option<Uuid> = sqlx::query_scalar(
            "UPDATE huddle_participant hp SET left_at = now() \
              WHERE hp.huddle_id = $1 AND hp.member_id = $2 AND hp.joined_at = $3 \
                AND hp.left_at IS NULL \
                AND NOT EXISTS ( \
                  SELECT 1 FROM audit_log a \
                   WHERE a.workspace_id = hp.workspace_id \
                     AND a.action = 'huddle.joined' \
                     AND a.target_type = 'huddle' AND a.target_id = hp.huddle_id \
                     AND a.actor_member_id = hp.member_id \
                     AND a.created_at >= $4) \
              RETURNING hp.member_id",
        )
        .bind(huddle_id)
        .bind(departure.participant.member_id)
        .bind(departure.participant.joined_at)
        .bind(departure.rejoin_cutoff)
        .fetch_optional(&mut *conn)
        .await?;
        if let Some(member_id) = closed {
            marked_left.push(member_id);
        }
    }

    if marked_left.is_empty() {
        // Nothing closed. Only an observed-empty huddle that is still empty
        // right now may end here; anything else is a race someone else won.
        if !end_if_empty || !active_participant_ids(conn, huddle_id).await?.is_empty() {
            return Ok(raced);
        }
    }

    let ended = settle_departures_in_tx(conn, workspace_id, channel_id, huddle_id).await?;

    // No member decided this, so the actor is NULL — the approval sweep's shape.
    let entry = AuditEntry::new(workspace_id, "huddle.sweep_settled")
        .target("huddle", huddle_id)
        .with_schema(
            "momo.huddle.sweep_settled.v1",
            json!({
                "channel_id": channel_id.to_string().to_uppercase(),
                "reason": "livekit_absent",
                "left_member_ids": marked_left
                    .iter()
                    .map(|id| id.to_string().to_uppercase())
                    .collect::<Vec<_>>(),
                "ended": ended,
            }),
        );
    write_audit(conn, &entry).await?;

    Ok(SweepSettlement {
        marked_left,
        ended,
        raced: false,
    })
}
