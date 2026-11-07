//! ADR-0218 증보 6 §12 (L3·L7·L8·L10, #5459 S1a): the server's staging for an emoticon set.
//!
//! The team AI makes up to 40 pictures for one set, one slot at a time, over up to two hours. Until
//! a person approves, they live here: a head (`expression_set`), the slots the plan fixed
//! (`expression_set_slot`) and three renditions per picture (`expression_set_image`), under 158's
//! pixel CHECKs. It is the sibling of [`crate::assembly`]. A proposal (S1b) later names the set by
//! id only, so no picture ever travels in a proposal body.
//!
//! # Who writes, and why every statement names its owner
//!
//! The writer is the agent worker's BYPASSRLS `momo_worker`. RLS does not stand between that role
//! and any tenant's rows, so **RLS is not the last door here** (ADR-0218 §12 L10.1, threat T20):
//! the `expression-set-lockdown` block keeps each role to the verbs the code uses, the composite
//! foreign keys and triggers of migration 176 refuse a cross-tenant reference, a second write to a
//! slot and any step backwards, and **every statement below puts `workspace_id` and the owner
//! (agent, requester, run) into its own SQL**. A set that is another agent's, another person's,
//! another run's, another tenant's, expired, or already proposed is the same
//! [`Refusal::InvalidArguments`] as an unknown id.
//!
//! Every function takes the caller's connection (a tenant transaction) and none opens one. No
//! function here decodes or assembles a picture: it takes the finished [`Processed`] renditions, so
//! no child process runs inside the database transaction (the decode step is S5a's).
//!
//! # What this module does not do
//!
//! No route, card, registry row or proposal (S1b), no decision or registration (S2), no tool
//! loop, plan sieve or cooldown (S5a). The word `team_image_model` is never read or written here:
//! [`begin_in_tx`] takes no backend and stores `hermes` (A36; the column's CHECK closes the words).

use chrono::{DateTime, Utc};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::PgConnection;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::media::{Processed, Rendition};
use crate::{Error, ImageInfo};

/// L4: slots in one set, gray ones included.
pub const MAX_SLOTS: usize = 40;
/// L4: stored bytes of one set (three renditions per slot), 24 MiB.
pub const MAX_STORED_BYTES: i64 = 25_165_824;
/// L8-3: how long a staging set lives from the moment making starts.
pub const STAGING_SECS: i64 = 7_200;
/// The audit action of one reclaimed set (D6's closed list: ids and counts, never text or bytes).
pub const AUDIT_RECLAIMED: &str = "expression.set.reclaimed";
pub const AUDIT_RECLAIMED_SCHEMA: &str = "momo.expression.set.reclaimed.v1";
/// The audit action of one proposed set (ADR-0218 §12 L8-5, #5460 S1b): ids and counts only — no
/// byte, no prompt, no name, no link (D6).
pub const AUDIT_PROPOSED: &str = "expression.set.proposed";
pub const AUDIT_PROPOSED_SCHEMA: &str = "momo.expression.set.proposed.v1";

/// The run states in which a run is still alive (the `agent_run_active_idx` list).
const RUN_LIVE: &str = "('queued','running','awaiting_approval','paused')";

/// Why a call was refused. Nothing was written. The outer `Result` of every function carries
/// storage faults; this is the typed answer to a request the server will not take.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// Not the owner's, not found, not staging, expired, or not a plan the server takes: one
    /// answer for all of them, so nothing says which (G3.6, A6).
    InvalidArguments,
    /// The agent already has an undecided set (L8-1; the partial unique index is the last door).
    SetBusy,
    /// More than 40 slots (A9).
    SetFull,
    /// This write would take the set past 24 MiB (A9). The caller closes the slot gray instead.
    BytesOver,
    /// The slot was already written: a picture, or a gray code (A7).
    SlotClosed,
    /// The plan has no such slot (A7).
    SlotUnknown,
}

impl Refusal {
    /// The closed code the ADR names.
    pub const fn code(self) -> &'static str {
        match self {
            Refusal::InvalidArguments => "invalid_arguments",
            Refusal::SetBusy => "set_busy",
            Refusal::SetFull => "set_full",
            Refusal::BytesOver => "set_bytes_over",
            Refusal::SlotClosed => "set_slot_closed",
            Refusal::SlotUnknown => "set_slot_unknown",
        }
    }
}

/// The four codes of a gray slot (L7.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrayCode {
    Refused,
    Failed,
    NotMade,
    BaseMissing,
}

impl GrayCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            GrayCode::Refused => "refused",
            GrayCode::Failed => "failed",
            GrayCode::NotMade => "not_made",
            GrayCode::BaseMissing => "base_missing",
        }
    }
}

/// The motions a GIF slot may plan (the slot CHECK; `sprite` is not one of them).
pub const GIF_MOTIONS: [&str; 4] = ["bounce", "wobble", "pulse", "sparkle"];

/// What one slot is for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SlotKind {
    /// A picture Hermes draws from `scene` (1-300 characters).
    Still { scene: String },
    /// A motion the server assembles from the still slot `base`'s stored picture.
    Gif { base: u8, motion: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlotPlan {
    pub index: u8,
    pub name: String,
    pub display_name: String,
    pub tags: Vec<String>,
    pub kind: SlotKind,
}

/// The plan [`begin_in_tx`] stores. Written once; the database refuses every later change.
#[derive(Debug, Clone)]
pub struct Plan {
    pub title: String,
    pub prefix: String,
    /// `None`, or the requester (the team AI's door never carries another person's face).
    pub subject: Option<Uuid>,
    pub prompt: String,
    /// Pointers to the requester's own attachments the server chose (L18). Not a key to anything.
    pub reference_attachment_ids: Vec<Uuid>,
    /// Whether the plan card showed the member's first notice (L19.1).
    pub notice_shown: bool,
    pub slots: Vec<SlotPlan>,
}

/// The owner of a set: every statement below puts all four into its own SQL.
#[derive(Debug, Clone, Copy)]
pub struct Owner {
    pub workspace: Uuid,
    pub agent: Uuid,
    /// The person the run was raised by.
    pub requester: Uuid,
    pub run: Uuid,
}

#[derive(Debug, Clone)]
pub struct Begun {
    pub set_id: Uuid,
    /// Two hours from now. The plan card's confirmation moves it to its own time + two hours.
    pub expires_at: DateTime<Utc>,
    pub channel_id: Uuid,
}

/// What one picture write left behind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stored {
    /// The bytes of the three renditions this call added.
    pub bytes: i64,
    /// The set's stored bytes after this call.
    pub stored_bytes: i64,
}

/// What a reclaim took back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Reclaimed {
    /// Rendition rows deleted.
    pub images: u64,
    /// Slots that held pixels.
    pub slots: u64,
    /// `false` when the set was already over (nothing left to do).
    pub closed_now: bool,
}

const FORBIDDEN_PLAIN: &[char] = &['@', '<', '>', '[', ']', '`', '\\'];

fn plain(text: &str, min: usize, max: usize) -> bool {
    let count = text.chars().count();
    (min..=max).contains(&count)
        && !text
            .chars()
            .any(|c| c.is_control() || FORBIDDEN_PLAIN.contains(&c))
}

fn free_text(text: &str, max: usize) -> bool {
    let count = text.chars().count();
    (1..=max).contains(&count) && !text.contains('\0')
}

fn lower_alnum(text: &str, min: usize, max: usize, extra: &[char]) -> bool {
    let count = text.chars().count();
    (min..=max).contains(&count)
        && text
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || extra.contains(&c))
}

impl Plan {
    /// The shape the server takes. The database constraints and triggers are the backstop for
    /// the same rules; this gives a typed refusal instead of a constraint error.
    fn well_formed(&self, requester: Uuid) -> bool {
        if !plain(&self.title, 1, 40)
            || !lower_alnum(&self.prefix, 2, 12, &[])
            || !free_text(&self.prompt, 800)
            || self.reference_attachment_ids.len() > 4
            || self.slots.is_empty()
            || self.subject.is_some_and(|subject| subject != requester)
        {
            return false;
        }
        let mut indexes = std::collections::BTreeSet::new();
        let mut names = std::collections::BTreeSet::new();
        for slot in &self.slots {
            let head = format!("{}_", self.prefix);
            if usize::from(slot.index) >= MAX_SLOTS
                || !indexes.insert(slot.index)
                || !names.insert(slot.name.as_str())
                || !lower_alnum(&slot.name, 2, 30, &['_', '-'])
                || !slot.name.starts_with(&head)
                || slot.name.chars().count() <= head.chars().count()
                || !plain(&slot.display_name, 1, 40)
                || slot.tags.len() > 5
                || slot.tags.iter().any(|tag| !plain(tag, 1, 16))
                || slot
                    .tags
                    .iter()
                    .collect::<std::collections::BTreeSet<_>>()
                    .len()
                    != slot.tags.len()
            {
                return false;
            }
            match &slot.kind {
                SlotKind::Still { scene } => {
                    if !free_text(scene, 300) {
                        return false;
                    }
                }
                SlotKind::Gif { base, motion } => {
                    let base_is_a_still = self.slots.iter().any(|other| {
                        other.index == *base && matches!(other.kind, SlotKind::Still { .. })
                    });
                    if !GIF_MOTIONS.contains(&motion.as_str()) || !base_is_a_still {
                        return false;
                    }
                }
            }
        }
        true
    }
}

/// Prove the run: it is the owner's agent's, still alive, and its trigger message was written
/// (and not deleted) by the requester, a live human who is still in the run's conversation. Every
/// write below asks again (L3.2: 「모든 쓰기는 같은 tx에서 run 상태·요청자·에이전트를 다시 증명한다」).
/// Returns the run's channel.
async fn prove_run(conn: &mut PgConnection, owner: Owner) -> Result<Option<Uuid>, Error> {
    Ok(sqlx::query_scalar(&format!(
        "SELECT r.channel_id \
           FROM agent_run r \
           JOIN message t ON t.workspace_id = r.workspace_id AND t.id = r.trigger_message_id \
                         AND t.deleted_at IS NULL \
           JOIN member h ON h.workspace_id = t.workspace_id AND h.id = t.author_member_id \
          WHERE r.workspace_id = $1 AND r.id = $2 AND r.agent_member_id = $3 \
            AND r.status IN {RUN_LIVE} \
            AND h.id = $4 AND h.kind = 'human' AND h.status = 'active' AND h.deleted_at IS NULL \
            AND EXISTS ( \
              SELECT 1 FROM membership ms \
               WHERE ms.workspace_id = r.workspace_id AND ms.channel_id = r.channel_id \
                 AND ms.member_id = h.id AND ms.left_at IS NULL)"
    ))
    .bind(owner.workspace)
    .bind(owner.run)
    .bind(owner.agent)
    .bind(owner.requester)
    .fetch_optional(&mut *conn)
    .await?)
}

/// Start a set: prove the run and the requester, check that the agent has no other undecided set
/// (under a lock of the agent's own member row, with the partial unique index as the last door),
/// and write the head and every slot of the plan in this one transaction. The plan is never
/// written again; the database refuses every later change to it (A27).
///
/// Refusals write nothing: [`Refusal::SetFull`] for more than 40 slots, [`Refusal::SetBusy`] for a
/// second undecided set, [`Refusal::InvalidArguments`] for a run, requester or agent that does not
/// check out and for a plan the server does not take.
pub async fn begin_in_tx(
    conn: &mut PgConnection,
    owner: Owner,
    plan: &Plan,
) -> Result<Result<Begun, Refusal>, Error> {
    if plan.slots.len() > MAX_SLOTS {
        return Ok(Err(Refusal::SetFull));
    }
    if !plan.well_formed(owner.requester) {
        return Ok(Err(Refusal::InvalidArguments));
    }
    // The agent's member row is the mutex of its one undecided set: two simultaneous `begin`s meet
    // here, and the second reads the first's set below. FOR NO KEY UPDATE, so the key-share locks
    // of foreign-key checks elsewhere never wait on it.
    let agent: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM member WHERE workspace_id = $1 AND id = $2 AND kind = 'agent' \
            AND status = 'active' AND deleted_at IS NULL FOR NO KEY UPDATE",
    )
    .bind(owner.workspace)
    .bind(owner.agent)
    .fetch_optional(&mut *conn)
    .await?;
    if agent.is_none() {
        return Ok(Err(Refusal::InvalidArguments));
    }
    let Some(channel_id) = prove_run(conn, owner).await? else {
        return Ok(Err(Refusal::InvalidArguments));
    };
    let busy: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM expression_set WHERE workspace_id = $1 AND agent_member_id = $2 \
            AND state IN ('staging','proposed'))",
    )
    .bind(owner.workspace)
    .bind(owner.agent)
    .fetch_one(&mut *conn)
    .await?;
    if busy {
        return Ok(Err(Refusal::SetBusy));
    }
    // A savepoint, so the unique index's refusal (the race the lock above should have closed)
    // leaves the caller's transaction usable.
    let mut savepoint = sqlx::Connection::begin(&mut *conn).await?;
    let head = sqlx::query(
        "INSERT INTO expression_set(workspace_id,agent_member_id,requester_member_id,run_id,channel_id,\
            title,prefix,backend,subject_member_id,prompt,reference_attachment_ids,notice_shown) \
         VALUES($1,$2,$3,$4,$5,$6,$7,'hermes',$8,$9,$10,$11) RETURNING id, expires_at",
    )
    .bind(owner.workspace)
    .bind(owner.agent)
    .bind(owner.requester)
    .bind(owner.run)
    .bind(channel_id)
    .bind(&plan.title)
    .bind(&plan.prefix)
    .bind(plan.subject)
    .bind(&plan.prompt)
    .bind(&plan.reference_attachment_ids)
    .bind(plan.notice_shown)
    .fetch_one(&mut *savepoint)
    .await;
    let head = match head {
        Ok(head) => head,
        Err(sqlx::Error::Database(error))
            if error.code().as_deref() == Some("23505")
                && error.constraint() == Some("expression_set_one_undecided") =>
        {
            savepoint.rollback().await?;
            return Ok(Err(Refusal::SetBusy));
        }
        Err(error) => return Err(error.into()),
    };
    let set_id: Uuid = head.try_get("id")?;
    let expires_at: DateTime<Utc> = head.try_get("expires_at")?;
    // Still slots first: a GIF slot's base is a foreign key to a slot row of the same set.
    let mut ordered: Vec<&SlotPlan> = plan.slots.iter().collect();
    ordered.sort_by_key(|slot| (matches!(slot.kind, SlotKind::Gif { .. }), slot.index));
    for slot in ordered {
        let (kind, scene, base, motion) = match &slot.kind {
            SlotKind::Still { scene } => ("still", Some(scene.as_str()), None, None),
            SlotKind::Gif { base, motion } => {
                ("gif", None, Some(i32::from(*base)), Some(motion.as_str()))
            }
        };
        sqlx::query(
            "INSERT INTO expression_set_slot(workspace_id,set_id,slot_index,kind,name,display_name,tags,scene,base_index,motion) \
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        )
        .bind(owner.workspace)
        .bind(set_id)
        .bind(i32::from(slot.index))
        .bind(kind)
        .bind(&slot.name)
        .bind(&slot.display_name)
        .bind(Value::from(slot.tags.clone()))
        .bind(scene)
        .bind(base)
        .bind(motion)
        .execute(&mut *savepoint)
        .await?;
    }
    savepoint.commit().await?;
    Ok(Ok(Begun {
        set_id,
        expires_at,
        channel_id,
    }))
}

/// Lock the head for a write: the owner's, `staging` and unexpired, or nothing. **Every** predicate
/// is the SQL's own; a caller that forgot one would still be refused here (A6). Returns the set's
/// stored bytes.
async fn lock_staging(
    conn: &mut PgConnection,
    owner: Owner,
    set_id: Uuid,
) -> Result<Option<i64>, Error> {
    Ok(sqlx::query_scalar(
        "SELECT stored_bytes FROM expression_set WHERE workspace_id = $1 AND id = $2 \
            AND agent_member_id = $3 AND requester_member_id = $4 AND run_id = $5 \
            AND state = 'staging' AND expires_at > clock_timestamp() FOR UPDATE",
    )
    .bind(owner.workspace)
    .bind(set_id)
    .bind(owner.agent)
    .bind(owner.requester)
    .bind(owner.run)
    .fetch_optional(&mut *conn)
    .await?)
}

/// What a slot write puts in the slot.
enum Fill<'a> {
    Still(&'a Processed),
    Gif(&'a Processed),
    Gray(GrayCode),
}

/// The one write path: the head is locked and the run proved again, the slot must be in the plan
/// and still `planned`, and a picture must fit the set's cap. A refusal writes nothing.
async fn fill_in_tx(
    conn: &mut PgConnection,
    owner: Owner,
    set_id: Uuid,
    index: u8,
    fill: Fill<'_>,
) -> Result<Result<Stored, Refusal>, Error> {
    let Some(stored) = lock_staging(conn, owner, set_id).await? else {
        return Ok(Err(Refusal::InvalidArguments));
    };
    if prove_run(conn, owner).await?.is_none() {
        return Ok(Err(Refusal::InvalidArguments));
    }
    let slot = sqlx::query(
        "SELECT kind, state FROM expression_set_slot \
          WHERE workspace_id = $1 AND set_id = $2 AND slot_index = $3 FOR UPDATE",
    )
    .bind(owner.workspace)
    .bind(set_id)
    .bind(i32::from(index))
    .fetch_optional(&mut *conn)
    .await?;
    let Some(slot) = slot else {
        return Ok(Err(Refusal::SlotUnknown));
    };
    let kind: String = slot.try_get("kind")?;
    let state: String = slot.try_get("state")?;
    if state != "planned" {
        return Ok(Err(Refusal::SlotClosed));
    }
    let media = match fill {
        Fill::Gray(code) => {
            // `refused` is Hermes's answer to a drawn still; `base_missing` is a GIF's.
            let fits = match code {
                GrayCode::Refused => kind == "still",
                GrayCode::BaseMissing => kind == "gif",
                GrayCode::Failed | GrayCode::NotMade => true,
            };
            if !fits {
                return Ok(Err(Refusal::InvalidArguments));
            }
            let closed = sqlx::query(
                "UPDATE expression_set_slot SET state = 'gray', code = $4 \
                  WHERE workspace_id = $1 AND set_id = $2 AND slot_index = $3 AND state = 'planned'",
            )
            .bind(owner.workspace)
            .bind(set_id)
            .bind(i32::from(index))
            .bind(code.as_str())
            .execute(&mut *conn)
            .await?
            .rows_affected();
            if closed != 1 {
                return Ok(Err(Refusal::SlotClosed));
            }
            return Ok(Ok(Stored {
                bytes: 0,
                stored_bytes: stored,
            }));
        }
        Fill::Still(media) => {
            if kind != "still" || !is_still(media) {
                return Ok(Err(Refusal::InvalidArguments));
            }
            media
        }
        Fill::Gif(media) => {
            if kind != "gif" || !is_gif(media) {
                return Ok(Err(Refusal::InvalidArguments));
            }
            media
        }
    };
    let bytes: i64 = media
        .variants()
        .iter()
        .map(|(_, rendition)| rendition.data.len() as i64)
        .sum();
    // A9: the cap is proved here, from the set's own stored bytes, never trimmed. The row CHECK
    // alone admits far more than 24 MiB (it only sees what this function adds up).
    if stored + bytes > MAX_STORED_BYTES {
        return Ok(Err(Refusal::BytesOver));
    }
    for (variant, rendition) in media.variants() {
        sqlx::query(
            "INSERT INTO expression_set_image(workspace_id,set_id,slot_index,variant,mime,bytes,sha256,width,height,frame_count,duration_ms) \
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        )
        .bind(owner.workspace)
        .bind(set_id)
        .bind(i32::from(index))
        .bind(variant)
        .bind(&rendition.info.mime)
        .bind(&rendition.data)
        .bind(&rendition.info.sha256)
        .bind(rendition.info.width as i32)
        .bind(rendition.info.height as i32)
        .bind(rendition.info.frame_count as i32)
        .bind(rendition.info.duration_ms as i32)
        .execute(&mut *conn)
        .await?;
    }
    let ready = sqlx::query(
        "UPDATE expression_set_slot SET state = 'ready' \
          WHERE workspace_id = $1 AND set_id = $2 AND slot_index = $3 AND state = 'planned'",
    )
    .bind(owner.workspace)
    .bind(set_id)
    .bind(i32::from(index))
    .execute(&mut *conn)
    .await?
    .rows_affected();
    if ready != 1 {
        return Ok(Err(Refusal::SlotClosed));
    }
    let now: i64 = sqlx::query_scalar(
        "UPDATE expression_set SET stored_bytes = stored_bytes + $3 \
          WHERE workspace_id = $1 AND id = $2 RETURNING stored_bytes",
    )
    .bind(owner.workspace)
    .bind(set_id)
    .bind(bytes)
    .fetch_one(&mut *conn)
    .await?;
    Ok(Ok(Stored {
        bytes,
        stored_bytes: now,
    }))
}

fn is_still(media: &Processed) -> bool {
    media
        .variants()
        .iter()
        .all(|(_, r)| r.info.mime == "image/png" && r.info.frame_count == 1)
}

fn is_gif(media: &Processed) -> bool {
    media.large.info.mime == "image/gif"
        && media.small.info.mime == "image/gif"
        && media.thumb.info.mime == "image/png"
}

/// Keep one drawn picture (the three renditions of Hermes's answer, already decoded) in a still
/// slot. The slot becomes `ready` in the same transaction.
pub async fn put_still_in_tx(
    conn: &mut PgConnection,
    owner: Owner,
    set_id: Uuid,
    index: u8,
    media: &Processed,
) -> Result<Result<Stored, Refusal>, Error> {
    fill_in_tx(conn, owner, set_id, index, Fill::Still(media)).await
}

/// Keep one assembled GIF (the assembler's three renditions) in a GIF slot.
pub async fn put_gif_in_tx(
    conn: &mut PgConnection,
    owner: Owner,
    set_id: Uuid,
    index: u8,
    media: &Processed,
) -> Result<Result<Stored, Refusal>, Error> {
    fill_in_tx(conn, owner, set_id, index, Fill::Gif(media)).await
}

/// Close a slot gray (L7). A gray slot holds no pixels, no draft and no id, and is never written
/// again: the database refuses a second change to the slot.
pub async fn put_gray_in_tx(
    conn: &mut PgConnection,
    owner: Owner,
    set_id: Uuid,
    index: u8,
    code: GrayCode,
) -> Result<Result<Stored, Refusal>, Error> {
    fill_in_tx(conn, owner, set_id, index, Fill::Gray(code)).await
}

/// The stored **large** rendition of the still slot a GIF slot is based on: the assembler's input
/// (L3.2). `None` when the GIF slot is not in this owner's live staging set, or when the base is
/// not a `ready` still (then the GIF slot closes `base_missing`).
pub async fn base_large_in_tx(
    conn: &mut PgConnection,
    owner: Owner,
    set_id: Uuid,
    gif_index: u8,
) -> Result<Option<Rendition>, Error> {
    let row = sqlx::query(
        "SELECT i.mime, i.bytes, i.sha256, i.width, i.height, i.frame_count, i.duration_ms \
           FROM expression_set h \
           JOIN expression_set_slot g ON g.workspace_id = h.workspace_id AND g.set_id = h.id \
                                     AND g.slot_index = $3 AND g.kind = 'gif' AND g.state = 'planned' \
           JOIN expression_set_slot b ON b.workspace_id = g.workspace_id AND b.set_id = g.set_id \
                                     AND b.slot_index = g.base_index AND b.kind = 'still' AND b.state = 'ready' \
           JOIN expression_set_image i ON i.workspace_id = b.workspace_id AND i.set_id = b.set_id \
                                      AND i.slot_index = b.slot_index AND i.variant = 'large' \
          WHERE h.workspace_id = $1 AND h.id = $2 AND h.agent_member_id = $4 \
            AND h.requester_member_id = $5 AND h.run_id = $6 \
            AND h.state = 'staging' AND h.expires_at > clock_timestamp()",
    )
    .bind(owner.workspace)
    .bind(set_id)
    .bind(i32::from(gif_index))
    .bind(owner.agent)
    .bind(owner.requester)
    .bind(owner.run)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    let data: Vec<u8> = row.try_get("bytes")?;
    Ok(Some(Rendition {
        info: ImageInfo {
            mime: row.try_get("mime")?,
            sha256: row.try_get("sha256")?,
            bytes: data.len(),
            width: row.try_get::<i32, _>("width")? as u32,
            height: row.try_get::<i32, _>("height")? as u32,
            frame_count: row.try_get::<i32, _>("frame_count")? as u32,
            duration_ms: row.try_get::<i32, _>("duration_ms")? as u32,
        },
        data,
    }))
}

/// One slot as the database holds it (never a picture).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlotRow {
    pub index: u8,
    pub kind: String,
    pub name: String,
    pub display_name: String,
    pub tags: Vec<String>,
    pub scene: Option<String>,
    pub base_index: Option<u8>,
    pub motion: Option<String>,
    pub state: String,
    pub code: Option<String>,
    /// Rendition rows the slot holds right now (0 or 3).
    pub renditions: i64,
}

/// A set as its owner reads it back.
#[derive(Debug, Clone)]
pub struct Held {
    pub id: Uuid,
    pub channel_id: Uuid,
    pub title: String,
    pub prefix: String,
    pub backend: String,
    pub subject: Option<Uuid>,
    pub prompt: Option<String>,
    pub reference_attachment_ids: Vec<Uuid>,
    pub notice_shown: bool,
    pub state: String,
    pub plan_confirmed_at: Option<DateTime<Utc>>,
    pub stored_bytes: i64,
    pub approval_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub slots: Vec<SlotRow>,
}

/// Read a set back for its owner: all four of workspace, id, agent, requester and run are the SQL's
/// own predicates, in any state (a proposal checks `state` itself). Another agent's, person's,
/// run's or tenant's set and an unknown id are the same `None` (A6).
pub async fn get_in_tx(
    conn: &mut PgConnection,
    owner: Owner,
    set_id: Uuid,
) -> Result<Option<Held>, Error> {
    let Some(head) = sqlx::query(
        "SELECT id, channel_id, title, prefix, backend, subject_member_id, prompt, reference_attachment_ids, \
                notice_shown, state, plan_confirmed_at, stored_bytes, approval_id, created_at, expires_at \
           FROM expression_set WHERE workspace_id = $1 AND id = $2 \
            AND agent_member_id = $3 AND requester_member_id = $4 AND run_id = $5",
    )
    .bind(owner.workspace)
    .bind(set_id)
    .bind(owner.agent)
    .bind(owner.requester)
    .bind(owner.run)
    .fetch_optional(&mut *conn)
    .await?
    else {
        return Ok(None);
    };
    let rows = sqlx::query(
        "SELECT s.slot_index, s.kind, s.name, s.display_name, s.tags, s.scene, s.base_index, s.motion, s.state, s.code, \
                (SELECT count(*) FROM expression_set_image i \
                  WHERE i.workspace_id = s.workspace_id AND i.set_id = s.set_id AND i.slot_index = s.slot_index) AS renditions \
           FROM expression_set_slot s WHERE s.workspace_id = $1 AND s.set_id = $2 ORDER BY s.slot_index",
    )
    .bind(owner.workspace)
    .bind(set_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut slots = Vec::with_capacity(rows.len());
    for row in &rows {
        let tags: Value = row.try_get("tags")?;
        slots.push(SlotRow {
            index: u8::try_from(row.try_get::<i32, _>("slot_index")?)
                .map_err(|_| Error::Invalid)?,
            kind: row.try_get("kind")?,
            name: row.try_get("name")?,
            display_name: row.try_get("display_name")?,
            tags: match tags {
                Value::Array(items) => items
                    .iter()
                    .map(|tag| tag.as_str().map(str::to_owned))
                    .collect::<Option<Vec<_>>>()
                    .ok_or(Error::Invalid)?,
                _ => return Err(Error::Invalid),
            },
            scene: row.try_get("scene")?,
            base_index: row
                .try_get::<Option<i32>, _>("base_index")?
                .map(u8::try_from)
                .transpose()
                .map_err(|_| Error::Invalid)?,
            motion: row.try_get("motion")?,
            state: row.try_get("state")?,
            code: row.try_get("code")?,
            renditions: row.try_get("renditions")?,
        });
    }
    Ok(Some(Held {
        id: head.try_get("id")?,
        channel_id: head.try_get("channel_id")?,
        title: head.try_get("title")?,
        prefix: head.try_get("prefix")?,
        backend: head.try_get("backend")?,
        subject: head.try_get("subject_member_id")?,
        prompt: head.try_get("prompt")?,
        reference_attachment_ids: head.try_get("reference_attachment_ids")?,
        notice_shown: head.try_get("notice_shown")?,
        state: head.try_get("state")?,
        plan_confirmed_at: head.try_get("plan_confirmed_at")?,
        stored_bytes: head.try_get("stored_bytes")?,
        approval_id: head.try_get("approval_id")?,
        created_at: head.try_get("created_at")?,
        expires_at: head.try_get("expires_at")?,
        slots,
    }))
}

/// Take a set's pixels and words back and close its head: the one reclaim every end path shares
/// (the run's cancel through [`abandon_in_tx`], the TTL sweep). The head must already be locked by
/// the caller. The head moves to `expired` with its `prompt` blanked, the slots lose their
/// `scene`, the renditions are deleted, and one `expression.set.reclaimed` audit row records ids
/// and counts only. Idempotent: an `expired` head is left as it is.
pub(crate) async fn reclaim_in_tx(
    conn: &mut PgConnection,
    workspace: Uuid,
    set_id: Uuid,
    why: &'static str,
) -> Result<Reclaimed, Error> {
    let closed = sqlx::query(
        "UPDATE expression_set SET state = 'expired', prompt = NULL \
          WHERE workspace_id = $1 AND id = $2 AND state = 'staging'",
    )
    .bind(workspace)
    .bind(set_id)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    if closed == 0 {
        return Ok(Reclaimed::default());
    }
    sqlx::query(
        "UPDATE expression_set_slot SET scene = NULL \
          WHERE workspace_id = $1 AND set_id = $2 AND scene IS NOT NULL",
    )
    .bind(workspace)
    .bind(set_id)
    .execute(&mut *conn)
    .await?;
    let gone: Vec<i32> = sqlx::query_scalar(
        "DELETE FROM expression_set_image WHERE workspace_id = $1 AND set_id = $2 RETURNING slot_index",
    )
    .bind(workspace)
    .bind(set_id)
    .fetch_all(&mut *conn)
    .await?;
    let slots = gone.iter().collect::<std::collections::BTreeSet<_>>().len() as u64;
    write_audit(
        conn,
        &AuditEntry::new(workspace, AUDIT_RECLAIMED)
            .target("expression_set", set_id)
            .with_schema(
                AUDIT_RECLAIMED_SCHEMA,
                json!({"set_id": set_id.to_string(), "slots": slots, "why": why}),
            ),
    )
    .await?;
    Ok(Reclaimed {
        images: gone.len() as u64,
        slots,
        closed_now: true,
    })
}

/// Lock a set for its proposal and read it back (ADR-0218 §12 L3.2): the owner's four predicates,
/// `staging`, the plan **confirmed** (nothing is made, so nothing is proposed, before the person's
/// 「이대로 만들기」, L19.3) and the two hours not yet over. The head is locked `FOR UPDATE`, so a
/// `put_*`, an `abandon` or the sweep waits for this transaction. Every other answer — another
/// agent's, person's, run's or tenant's set, an unconfirmed one, an expired one, one already
/// proposed, an unknown id — is the same `None` (A6).
pub async fn lock_for_proposal_in_tx(
    conn: &mut PgConnection,
    owner: Owner,
    set_id: Uuid,
) -> Result<Option<Held>, Error> {
    let locked: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM expression_set WHERE workspace_id = $1 AND id = $2 \
            AND agent_member_id = $3 AND requester_member_id = $4 AND run_id = $5 \
            AND state = 'staging' AND plan_confirmed_at IS NOT NULL \
            AND expires_at > clock_timestamp() FOR UPDATE",
    )
    .bind(owner.workspace)
    .bind(set_id)
    .bind(owner.agent)
    .bind(owner.requester)
    .bind(owner.run)
    .fetch_optional(&mut *conn)
    .await?;
    if locked.is_none() {
        return Ok(None);
    }
    get_in_tx(conn, owner, set_id).await
}

/// What handing a set to its approval left behind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HandedOver {
    /// Slots that became a draft (a ready picture).
    pub ready: u64,
    /// Slots that stay gray (no draft, no picture).
    pub gray: u64,
    /// Rendition rows copied into the drafts (three per ready slot) and then deleted from the set.
    pub renditions: u64,
}

/// Move a staged set under its approval, in the proposal's own transaction (ADR-0218 §12 L3.2):
/// one draft per **ready** slot (`candidate_index` = the slot index, `expires_at` = the approval's,
/// `origin` = the set's prompt as `generated`, the first reference as the original-photo pointer),
/// its three renditions **copied inside the database** (`INSERT … SELECT`, so the bytes never pass
/// through the worker's memory), the staged renditions deleted, and the head moved
/// `staging → proposed` with `approval_id` in **the same UPDATE** (the trigger accepts the two only
/// together). The approval row must already exist (the foreign keys), and the caller holds the
/// head lock ([`lock_for_proposal_in_tx`]). `stored_bytes` is left as it is: it only ever grows
/// and is the record of what was made.
///
/// Every statement repeats the owner's predicates (BYPASSRLS writer, T20). Refusals write nothing:
/// a slot still `planned` (the set is not finished), no ready slot at all (nothing a person could
/// choose), and any owner/state mismatch are [`Refusal::InvalidArguments`]. An inconsistent
/// database (a count that is not what the proofs said) is an `Err`, and the caller's transaction
/// rolls back with it.
pub async fn hand_over_in_tx(
    conn: &mut PgConnection,
    owner: Owner,
    set_id: Uuid,
    approval_id: Uuid,
    expires_at: DateTime<Utc>,
) -> Result<Result<HandedOver, Refusal>, Error> {
    let head = sqlx::query(
        "SELECT prompt, reference_attachment_ids, stored_bytes FROM expression_set \
          WHERE workspace_id = $1 AND id = $2 AND agent_member_id = $3 AND requester_member_id = $4 \
            AND run_id = $5 AND state = 'staging' AND plan_confirmed_at IS NOT NULL \
            AND expires_at > clock_timestamp() FOR UPDATE",
    )
    .bind(owner.workspace)
    .bind(set_id)
    .bind(owner.agent)
    .bind(owner.requester)
    .bind(owner.run)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(head) = head else {
        return Ok(Err(Refusal::InvalidArguments));
    };
    let prompt: Option<String> = head.try_get("prompt")?;
    let references: Vec<Uuid> = head.try_get("reference_attachment_ids")?;
    let stored_bytes: i64 = head.try_get("stored_bytes")?;
    let Some(prompt) = prompt else {
        return Ok(Err(Refusal::InvalidArguments));
    };
    let counts = sqlx::query(
        "SELECT count(*) FILTER (WHERE state = 'planned') AS planned, \
                count(*) FILTER (WHERE state = 'ready') AS ready, \
                count(*) FILTER (WHERE state = 'gray') AS gray, \
                count(*) AS slots \
           FROM expression_set_slot WHERE workspace_id = $1 AND set_id = $2",
    )
    .bind(owner.workspace)
    .bind(set_id)
    .fetch_one(&mut *conn)
    .await?;
    let (planned, ready, gray, slots): (i64, i64, i64, i64) = (
        counts.try_get("planned")?,
        counts.try_get("ready")?,
        counts.try_get("gray")?,
        counts.try_get("slots")?,
    );
    // A card is raised for a finished set that has something to choose from.
    if planned != 0 || ready == 0 || slots != ready + gray {
        return Ok(Err(Refusal::InvalidArguments));
    }
    let origin = json!({"kind": "generated", "sourceUrl": null, "prompt": prompt});
    let drafted = sqlx::query(
        "INSERT INTO expression_draft(workspace_id,name,display_name,tags,subject_member_id,origin,creator,\
            approval_id,candidate_index,state,expires_at,origin_source_attachment_id) \
         SELECT s.workspace_id, s.name, s.display_name, s.tags, h.subject_member_id, $6, h.agent_member_id, \
                $7, s.slot_index, 'ready', $8, $9 \
           FROM expression_set_slot s \
           JOIN expression_set h ON h.workspace_id = s.workspace_id AND h.id = s.set_id \
          WHERE s.workspace_id = $1 AND s.set_id = $2 AND s.state = 'ready' \
            AND h.agent_member_id = $3 AND h.requester_member_id = $4 AND h.run_id = $5 \
            AND h.state = 'staging' \
          ORDER BY s.slot_index",
    )
    .bind(owner.workspace)
    .bind(set_id)
    .bind(owner.agent)
    .bind(owner.requester)
    .bind(owner.run)
    .bind(&origin)
    .bind(approval_id)
    .bind(expires_at)
    .bind(references.first().copied())
    .execute(&mut *conn)
    .await?
    .rows_affected();
    if i64::try_from(drafted).ok() != Some(ready) {
        return Err(Error::Invalid);
    }
    let copied = sqlx::query(
        "INSERT INTO expression_draft_image(workspace_id,draft_id,variant,mime,bytes,sha256,width,height,\
            frame_count,duration_ms,revision) \
         SELECT i.workspace_id, d.id, i.variant, i.mime, i.bytes, i.sha256, i.width, i.height, \
                i.frame_count, i.duration_ms, d.revision \
           FROM expression_set_image i \
           JOIN expression_set h ON h.workspace_id = i.workspace_id AND h.id = i.set_id \
           JOIN expression_draft d ON d.workspace_id = i.workspace_id AND d.approval_id = $6 \
                                  AND d.candidate_index = i.slot_index \
          WHERE i.workspace_id = $1 AND i.set_id = $2 \
            AND h.agent_member_id = $3 AND h.requester_member_id = $4 AND h.run_id = $5 \
            AND h.state = 'staging'",
    )
    .bind(owner.workspace)
    .bind(set_id)
    .bind(owner.agent)
    .bind(owner.requester)
    .bind(owner.run)
    .bind(approval_id)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    if i64::try_from(copied).ok() != Some(3 * ready) {
        return Err(Error::Invalid);
    }
    // The staged copy goes in the same transaction: the drafts are the pictures from here on.
    let freed = sqlx::query(
        "DELETE FROM expression_set_image i USING expression_set h \
          WHERE i.workspace_id = $1 AND i.set_id = $2 \
            AND h.workspace_id = i.workspace_id AND h.id = i.set_id \
            AND h.agent_member_id = $3 AND h.requester_member_id = $4 AND h.run_id = $5",
    )
    .bind(owner.workspace)
    .bind(set_id)
    .bind(owner.agent)
    .bind(owner.requester)
    .bind(owner.run)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    if freed != copied {
        return Err(Error::Invalid);
    }
    // `state` and `approval_id` together, or the trigger and the table's CHECK refuse (L10.3).
    let moved = sqlx::query(
        "UPDATE expression_set SET state = 'proposed', approval_id = $6 \
          WHERE workspace_id = $1 AND id = $2 AND agent_member_id = $3 AND requester_member_id = $4 \
            AND run_id = $5 AND state = 'staging'",
    )
    .bind(owner.workspace)
    .bind(set_id)
    .bind(owner.agent)
    .bind(owner.requester)
    .bind(owner.run)
    .bind(approval_id)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    if moved != 1 {
        return Err(Error::Invalid);
    }
    let codes = sqlx::query(
        "SELECT code, count(*) AS n FROM expression_set_slot \
          WHERE workspace_id = $1 AND set_id = $2 AND state = 'gray' GROUP BY code ORDER BY code",
    )
    .bind(owner.workspace)
    .bind(set_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut gray_by_code = serde_json::Map::new();
    for row in &codes {
        gray_by_code.insert(
            row.try_get::<String, _>("code")?,
            json!(row.try_get::<i64, _>("n")?),
        );
    }
    write_audit(
        conn,
        &AuditEntry::new(owner.workspace, AUDIT_PROPOSED)
            .by(owner.agent)
            .target("expression_set", set_id)
            .with_schema(
                AUDIT_PROPOSED_SCHEMA,
                json!({
                    "set_id": set_id.to_string(),
                    "approval_id": approval_id.to_string(),
                    "slots": slots,
                    "ready": ready,
                    "gray": gray_by_code,
                    "references": references.len(),
                    "stored_bytes": stored_bytes,
                }),
            ),
    )
    .await?;
    Ok(Ok(HandedOver {
        ready: ready as u64,
        gray: gray as u64,
        renditions: copied,
    }))
}

/// `approval_request.props.action.expressionSet` (ADR-0218 §12 L5.2, core `SetApproval`): the set as
/// the approval now stands on it, read back from the rows — the head's plan, every slot (a ready
/// slot with the draft that holds its pictures, a gray one with its code) in slot order. The strings
/// are the stored plan's, once each; the card is what is stored (X8-2). A ready slot's kind must
/// agree with its stored large picture (a still is a PNG, a motion a GIF): a card that says
/// otherwise is not written.
pub async fn card_in_tx(
    conn: &mut PgConnection,
    workspace: Uuid,
    set_id: Uuid,
    approval_id: Uuid,
    expires_at: DateTime<Utc>,
) -> Result<Value, Error> {
    let head = sqlx::query(
        "SELECT title, prefix, subject_member_id, prompt, reference_attachment_ids FROM expression_set \
          WHERE workspace_id = $1 AND id = $2 AND approval_id = $3 AND state = 'proposed'",
    )
    .bind(workspace)
    .bind(set_id)
    .bind(approval_id)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or(Error::NotFound)?;
    let prompt: String = head
        .try_get::<Option<String>, _>("prompt")?
        .ok_or(Error::Invalid)?;
    let references: Vec<Uuid> = head.try_get("reference_attachment_ids")?;
    let rows = sqlx::query(
        "SELECT s.slot_index, s.kind, s.state, s.code, s.name, s.display_name, s.tags, \
                d.id AS draft_id, d.revision \
           FROM expression_set_slot s \
           LEFT JOIN expression_draft d ON d.workspace_id = s.workspace_id AND d.approval_id = $3 \
                                       AND d.candidate_index = s.slot_index \
          WHERE s.workspace_id = $1 AND s.set_id = $2 ORDER BY s.slot_index",
    )
    .bind(workspace)
    .bind(set_id)
    .bind(approval_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut slots = Vec::with_capacity(rows.len());
    for row in &rows {
        let index = row.try_get::<i32, _>("slot_index")?;
        let kind: String = row.try_get("kind")?;
        let state: String = row.try_get("state")?;
        let mut slot = json!({
            "index": index,
            "kind": kind,
            "state": state,
            "code": row.try_get::<Option<String>, _>("code")?,
            "name": row.try_get::<String, _>("name")?,
            "displayName": row.try_get::<String, _>("display_name")?,
            "tags": row.try_get::<Value, _>("tags")?,
        });
        match state.as_str() {
            "ready" => {
                let draft: Uuid = row
                    .try_get::<Option<Uuid>, _>("draft_id")?
                    .ok_or(Error::Invalid)?;
                let media = crate::store::media_json(conn, workspace, draft, true).await?;
                let mime = media["large"]["mime"].as_str().unwrap_or_default();
                if !matches!(
                    (kind.as_str(), mime),
                    ("still", "image/png") | ("gif", "image/gif")
                ) {
                    return Err(Error::Invalid);
                }
                let object = slot.as_object_mut().ok_or(Error::Invalid)?;
                object.insert("draftId".into(), json!(draft));
                object.insert(
                    "revision".into(),
                    json!(row.try_get::<i64, _>("revision")?.to_string()),
                );
                object.insert("media".into(), media);
            }
            "gray" => {}
            _ => return Err(Error::Invalid),
        }
        slots.push(slot);
    }
    Ok(json!({
        "v": 1,
        "workspaceId": workspace,
        "setId": set_id,
        "title": head.try_get::<String, _>("title")?,
        "prefix": head.try_get::<String, _>("prefix")?,
        "subjectMemberId": head.try_get::<Option<Uuid>, _>("subject_member_id")?,
        "prompt": prompt,
        "references": references.iter().map(|id| json!({"attachmentId": id})).collect::<Vec<_>>(),
        "expiresAtMs": expires_at.timestamp_millis(),
        "slots": slots,
    }))
}

/// End a set that will not be proposed (the run was cancelled, the requester left, the plan card
/// went unanswered): reclaim its bytes and close its head in this one transaction (L8-4). The
/// owner's four predicates are the SQL's own; a `proposed` or `decided` set is not this function's
/// (the decision paths close it) and answers [`Refusal::InvalidArguments`]. A set that is already
/// `expired` is a success that does nothing, so a cancel racing the sweep is not an error.
pub async fn abandon_in_tx(
    conn: &mut PgConnection,
    owner: Owner,
    set_id: Uuid,
) -> Result<Result<Reclaimed, Refusal>, Error> {
    let state: Option<String> = sqlx::query_scalar(
        "SELECT state FROM expression_set WHERE workspace_id = $1 AND id = $2 \
            AND agent_member_id = $3 AND requester_member_id = $4 AND run_id = $5 \
            AND state IN ('staging','expired') FOR UPDATE",
    )
    .bind(owner.workspace)
    .bind(set_id)
    .bind(owner.agent)
    .bind(owner.requester)
    .bind(owner.run)
    .fetch_optional(&mut *conn)
    .await?;
    match state.as_deref() {
        None => Ok(Err(Refusal::InvalidArguments)),
        Some("expired") => Ok(Ok(Reclaimed::default())),
        Some(_) => Ok(Ok(
            reclaim_in_tx(conn, owner.workspace, set_id, "abandon").await?
        )),
    }
}

/// The TTL half of [`crate::store::sweep_in_tx`] for sets (L8-3, A29): every `staging` head of the
/// tenant whose two hours are up is reclaimed. **Only `staging`**: a `proposed` head is not the
/// store's to expire, the approval's end moves it in one transaction with the drafts. Runs on
/// the notifier's RLS-bound `momo_app` pool. Returns the rendition rows deleted.
pub(crate) async fn sweep_in_tx(conn: &mut PgConnection, workspace: Uuid) -> Result<u64, Error> {
    let due: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM expression_set WHERE workspace_id = $1 AND state = 'staging' \
            AND expires_at <= clock_timestamp() ORDER BY id FOR UPDATE",
    )
    .bind(workspace)
    .fetch_all(&mut *conn)
    .await?;
    let mut freed = 0;
    for set_id in due {
        freed += reclaim_in_tx(conn, workspace, set_id, "expired")
            .await?
            .images;
    }
    Ok(freed)
}
