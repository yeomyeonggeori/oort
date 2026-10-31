//! ADR-0218 G3.6: what `oort_expression_assemble` built, kept for one hour under an `assemblyId`.
//!
//! This is the sibling of the drafts in [`crate::action`], not a new place to put pictures: three
//! renditions per candidate under 158's CHECKs (byte and dimension caps, GIF/PNG shape,
//! `sha256 = sha256(bytes)`), the same one-hour TTL, the same reclaim (bytes deleted, the row
//! retired to state `expired` for the rest of its hour) and the same sweep entry point
//! ([`crate::store::sweep_in_tx`] calls [`sweep_in_tx`] here, so the notifier needs no new code).
//!
//! One difference from a draft, on purpose: a draft's header stays after its hour as a record the
//! immutability trigger protects, but a held assembly's header holds the agent's own words (the
//! prompt, up to 2,000 characters) and nothing needs them once the hour is up. So the sweep
//! **deletes** the row, bytes and header together, `ready` or already retired. The record that
//! survives is the `expression.assembled` audit row: ids, motions and hash prefixes.
//!
//! A held assembly belongs to **one workspace, one agent and one person**: the agent that asked
//! and the human the run was raised by. RLS holds the workspace (`ws_isolation`) and, inside an
//! Agent Port request, the agent (`expression_assembly_agent`); every read below also names the
//! agent in SQL, so the answer for another agent's id is the same `None` as for an unknown one.
//!
//! Every function takes the caller's connection (a tenant transaction); none opens one. What is
//! never written here, to a row other than the assembly's own or to an audit row: the agent's
//! picture, its base64, the attachment's id or Drive file.

use chrono::{DateTime, Utc};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::PgConnection;
use serde_json::{json, Value};
use sqlx::{postgres::PgRow, Row};
use uuid::Uuid;

use crate::assemble::{AssembleError, MotionKind, Outcome};
use crate::media::{Processed, Rendition};
use crate::{Error, ImageInfo};

/// G3.6: candidates one agent may hold at once (three pending proposals x four candidates).
pub const HELD_MAX: i64 = 12;
/// The audit action of one kept assembly (D6's closed list: facts and hash prefixes only).
pub const AUDIT_ASSEMBLED: &str = "expression.assembled";
pub const AUDIT_ASSEMBLED_SCHEMA: &str = "momo.expression.assembled.v1";

/// The agent already holds as many candidates as the cap allows, counting what this call would
/// add. Nothing was written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Full {
    pub held: i64,
}

/// One kept candidate as the tool answers it (`AssembleResult.candidates[]`, G7).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeptCandidate {
    pub index: u8,
    pub motion: &'static str,
    pub frames: u32,
    pub duration_ms: u32,
    pub bytes: usize,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Kept {
    pub assembly_id: Uuid,
    pub expires_at: DateTime<Utc>,
    pub candidates: Vec<KeptCandidate>,
    /// Slots that were built too large: `(index, measured bytes)`.
    pub failed: Vec<(u8, u64)>,
}

/// A candidate slot that holds no bytes because it was built too large (G3.8, partial failure).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FailedSlot {
    pub index: u8,
    pub motion: String,
    pub code: String,
    pub bytes: u64,
}

#[derive(Debug, Clone)]
pub struct HeldCandidate {
    pub index: u8,
    pub motion: String,
    pub media: Processed,
}

/// A held assembly, read back by the agent that made it.
#[derive(Debug, Clone)]
pub struct Held {
    pub id: Uuid,
    pub agent: Uuid,
    /// The person the run was raised by: the later proposal must be about the same one.
    pub requester: Uuid,
    /// The agent's own plain text, which becomes the candidates' `origin.prompt`.
    pub prompt: String,
    /// Verified at assembly time; becomes `origin.sourceAttachmentId`.
    pub source_attachment_id: Option<Uuid>,
    pub expires_at: DateTime<Utc>,
    /// Ready candidates, by index. A hole in the indexes is a [`FailedSlot`].
    pub candidates: Vec<HeldCandidate>,
    pub failed: Vec<FailedSlot>,
}

/// The advisory-lock key of one agent's assembly keeping. Its own key: nothing else takes it, so
/// it waits on nothing but the same agent's other assemblies (and the initiative key is left
/// alone). One definition, so a test that holds the lock from outside holds **this** key and not
/// a copy of it.
pub fn lock_key(workspace: Uuid, agent: Uuid) -> String {
    format!("oort:expression-assembly:{workspace}:{agent}")
}

/// How many candidates `agent` holds right now: ready, unexpired, with bytes.
pub async fn held_in_tx(
    conn: &mut PgConnection,
    workspace: Uuid,
    agent: Uuid,
) -> Result<i64, Error> {
    Ok(sqlx::query_scalar(
        "SELECT count(*) FROM expression_assembly_image i \
           JOIN expression_assembly a ON (a.workspace_id,a.id) = (i.workspace_id,i.assembly_id) \
          WHERE a.workspace_id = $1 AND a.agent_member_id = $2 AND a.state = 'ready' \
            AND a.expires_at > clock_timestamp() AND i.variant = 'large'",
    )
    .bind(workspace)
    .bind(agent)
    .fetch_one(&mut *conn)
    .await?)
}

/// What one [`keep_in_tx`] call keeps.
pub struct Keep<'a> {
    pub workspace: Uuid,
    pub agent: Uuid,
    /// The person the run was raised by.
    pub requester: Uuid,
    pub prompt: &'a str,
    pub source_attachment_id: Option<Uuid>,
    /// The motion of every requested slot, in request order ([`crate::assemble::AssembleRequest::slot_kinds`]).
    pub motions: &'a [MotionKind],
    /// The assembler's answer, one entry per slot in the same order.
    pub outcomes: &'a [Outcome],
}

/// Keep what an assembly built. A slot that was built too large stays a hole at its own index (a
/// [`FailedSlot`] in the header, no bytes), the others are stored with all three renditions.
///
/// The twelve are proved **here**, under a lock of the agent's own, so two simultaneous calls
/// cannot both read "ten" and both add four. Refusing writes nothing. A call with nothing to keep
/// (no candidate at all, or every one too large), slots and answers that do not line up, or a
/// slot error other than "too large" is a caller's mistake: [`Error::Invalid`].
pub async fn keep_in_tx(
    conn: &mut PgConnection,
    keep: &Keep<'_>,
) -> Result<Result<Kept, Full>, Error> {
    let Keep {
        workspace,
        agent,
        requester,
        prompt,
        source_attachment_id,
        motions,
        outcomes,
    } = *keep;
    let ready = outcomes.iter().filter(|outcome| outcome.is_ok()).count();
    if outcomes.is_empty() || outcomes.len() > 4 || outcomes.len() != motions.len() || ready == 0 {
        return Err(Error::Invalid);
    }
    // A slot is a candidate or `OutputTooLarge`: the assembler's per-slot errors are that one and
    // nothing else (every other failure ends the whole call).
    let mut failed: Vec<(u8, &'static str, u64)> = Vec::new();
    for (index, outcome) in outcomes.iter().enumerate() {
        match outcome {
            Ok(_) => {}
            Err(AssembleError::OutputTooLarge { bytes }) => {
                failed.push((index as u8, motions[index].id(), *bytes));
            }
            Err(_) => return Err(Error::Invalid),
        }
    }
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))")
        .bind(lock_key(workspace, agent))
        .execute(&mut *conn)
        .await?;
    let held = held_in_tx(conn, workspace, agent).await?;
    if held + ready as i64 > HELD_MAX {
        return Ok(Err(Full { held }));
    }
    let failed_json: Vec<Value> = failed
        .iter()
        .map(|(index, motion, bytes)| {
            json!({
                "index": index,
                "motion": motion,
                "code": "assembly_output_too_large",
                "bytes": bytes,
            })
        })
        .collect();
    let header = sqlx::query(
        "INSERT INTO expression_assembly(workspace_id,agent_member_id,requester_member_id,prompt,source_attachment_id,failed) \
         VALUES($1,$2,$3,$4,$5,$6) RETURNING id, expires_at",
    )
    .bind(workspace)
    .bind(agent)
    .bind(requester)
    .bind(prompt)
    .bind(source_attachment_id)
    .bind(Value::Array(failed_json))
    .fetch_one(&mut *conn)
    .await?;
    let assembly_id: Uuid = header.try_get("id")?;
    let expires_at: DateTime<Utc> = header.try_get("expires_at")?;
    let mut kept = Vec::with_capacity(ready);
    for (index, outcome) in outcomes.iter().enumerate() {
        let Ok(candidate) = outcome else { continue };
        put_images(
            conn,
            workspace,
            assembly_id,
            index as u8,
            candidate.motion.id(),
            &candidate.media,
        )
        .await?;
        kept.push(KeptCandidate {
            index: index as u8,
            motion: candidate.motion.id(),
            frames: candidate.frames(),
            duration_ms: candidate.duration_ms(),
            bytes: candidate.bytes(),
            sha256: candidate.sha256().to_owned(),
        });
    }
    let failed_slots: Vec<(u8, u64)> = failed.iter().map(|(i, _, bytes)| (*i, *bytes)).collect();
    // D6's closed list: ids, motion names, hash prefixes and the closed code. Never the prompt,
    // a picture, base64, or the attachment.
    let detail = json!({
        "assembly_id": assembly_id.to_string(),
        "ready": kept.iter().map(|c| json!({
            "index": c.index,
            "motion": c.motion,
            "sha256_prefix": c.sha256.chars().take(12).collect::<String>(),
        })).collect::<Vec<_>>(),
        "failed": failed_slots.iter().map(|(index, bytes)| json!({
            "index": index,
            "code": "assembly_output_too_large",
            "bytes": bytes,
        })).collect::<Vec<_>>(),
    });
    write_audit(
        conn,
        &AuditEntry::new(workspace, AUDIT_ASSEMBLED)
            .by(agent)
            .target("expression_assembly", assembly_id)
            .with_schema(AUDIT_ASSEMBLED_SCHEMA, detail),
    )
    .await?;
    Ok(Ok(Kept {
        assembly_id,
        expires_at,
        candidates: kept,
        failed: failed_slots,
    }))
}

/// The three renditions of one candidate, the way [`crate::store`] writes a draft's.
async fn put_images(
    conn: &mut PgConnection,
    workspace: Uuid,
    assembly: Uuid,
    index: u8,
    motion: &str,
    media: &Processed,
) -> Result<(), Error> {
    for (variant, rendition) in media.variants() {
        sqlx::query(
            "INSERT INTO expression_assembly_image(workspace_id,assembly_id,candidate_index,motion,variant,mime,bytes,sha256,width,height,frame_count,duration_ms) \
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
        )
        .bind(workspace)
        .bind(assembly)
        .bind(i32::from(index))
        .bind(motion)
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
    Ok(())
}

fn rendition(row: &PgRow) -> Result<Rendition, Error> {
    let data: Vec<u8> = row.try_get("bytes")?;
    Ok(Rendition {
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
    })
}

/// Read one assembly back for `agent`: ready, unexpired and **its own**. An unknown id, another
/// agent's, another workspace's (RLS) and an expired one are the same `None`.
pub async fn get_in_tx(
    conn: &mut PgConnection,
    workspace: Uuid,
    agent: Uuid,
    id: Uuid,
) -> Result<Option<Held>, Error> {
    let Some(header) = sqlx::query(
        "SELECT * FROM expression_assembly WHERE workspace_id = $1 AND id = $2 \
            AND agent_member_id = $3 AND state = 'ready' AND expires_at > clock_timestamp()",
    )
    .bind(workspace)
    .bind(id)
    .bind(agent)
    .fetch_optional(&mut *conn)
    .await?
    else {
        return Ok(None);
    };
    let rows = sqlx::query(
        "SELECT candidate_index, motion, variant, mime, bytes, sha256, width, height, frame_count, duration_ms \
           FROM expression_assembly_image WHERE workspace_id = $1 AND assembly_id = $2 \
          ORDER BY candidate_index, variant",
    )
    .bind(workspace)
    .bind(id)
    .fetch_all(&mut *conn)
    .await?;
    let mut candidates: Vec<HeldCandidate> = Vec::new();
    let mut parts: std::collections::BTreeMap<i32, (String, [Option<Rendition>; 3])> =
        Default::default();
    for row in &rows {
        let entry = parts
            .entry(row.try_get("candidate_index")?)
            .or_insert_with(|| (String::new(), [None, None, None]));
        entry.0 = row.try_get("motion")?;
        let slot = match row.try_get::<String, _>("variant")?.as_str() {
            "small" => 0,
            "large" => 1,
            "thumb" => 2,
            _ => return Err(Error::Invalid),
        };
        entry.1[slot] = Some(rendition(row)?);
    }
    for (index, (motion, [small, large, thumb])) in parts {
        // A candidate is all three renditions or it is not served.
        let (Some(small), Some(large), Some(thumb)) = (small, large, thumb) else {
            return Err(Error::Invalid);
        };
        candidates.push(HeldCandidate {
            index: u8::try_from(index).map_err(|_| Error::Invalid)?,
            motion,
            media: Processed {
                small,
                large,
                thumb,
            },
        });
    }
    let failed = match header.try_get::<Value, _>("failed")? {
        Value::Array(items) => items
            .iter()
            .map(|item| {
                Some(FailedSlot {
                    index: u8::try_from(item.get("index")?.as_u64()?).ok()?,
                    motion: item.get("motion")?.as_str()?.to_owned(),
                    code: item.get("code")?.as_str()?.to_owned(),
                    bytes: item.get("bytes")?.as_u64()?,
                })
            })
            .collect::<Option<Vec<_>>>()
            .ok_or(Error::Invalid)?,
        _ => return Err(Error::Invalid),
    };
    Ok(Some(Held {
        id,
        agent: header.try_get("agent_member_id")?,
        requester: header.try_get("requester_member_id")?,
        prompt: header.try_get("prompt")?,
        source_attachment_id: header.try_get("source_attachment_id")?,
        expires_at: header.try_get("expires_at")?,
        candidates,
        failed,
    }))
}

/// Reclaim the bytes of one assembly (a proposal that took what it needed, a cancelled or
/// closed card). The row is retired (`expired`) and stays for the rest of its own hour, when the
/// sweep deletes it ([`sweep_in_tx`]); returns the rendition rows deleted. Idempotent.
pub async fn reclaim_in_tx(
    conn: &mut PgConnection,
    workspace: Uuid,
    id: Uuid,
) -> Result<u64, Error> {
    sqlx::query("SELECT id FROM expression_assembly WHERE workspace_id = $1 AND id = $2 AND state = 'ready' FOR UPDATE")
        .bind(workspace)
        .bind(id)
        .fetch_all(&mut *conn)
        .await?;
    let freed = sqlx::query(
        "DELETE FROM expression_assembly_image WHERE workspace_id = $1 AND assembly_id = $2",
    )
    .bind(workspace)
    .bind(id)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    sqlx::query("UPDATE expression_assembly SET state = 'expired' WHERE workspace_id = $1 AND id = $2 AND state = 'ready'")
        .bind(workspace)
        .bind(id)
        .execute(&mut *conn)
        .await?;
    Ok(freed)
}

/// The TTL half of [`crate::store::sweep_in_tx`]: every assembly of the tenant whose hour is up is
/// **deleted whole** (its bytes, then its header with the agent's prompt). A header still `ready`
/// and one a reclaim already retired (`expired`) are due alike, so no prompt outlives the hour
/// however the bytes went. Returns the rendition rows deleted.
///
/// Blanking the prompt instead is not on offer: the header's trigger lets only `state` change and
/// the column must hold 1 to 2,000 characters. What is kept is the audit row.
pub(crate) async fn sweep_in_tx(conn: &mut PgConnection, workspace: Uuid) -> Result<u64, Error> {
    sqlx::query("SELECT id FROM expression_assembly WHERE workspace_id = $1 AND expires_at <= clock_timestamp() FOR UPDATE")
        .bind(workspace)
        .fetch_all(&mut *conn)
        .await?;
    let freed = sqlx::query(
        "DELETE FROM expression_assembly_image i USING expression_assembly a \
          WHERE (i.workspace_id,i.assembly_id) = (a.workspace_id,a.id) AND a.workspace_id = $1 \
            AND a.expires_at <= clock_timestamp()",
    )
    .bind(workspace)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    sqlx::query("DELETE FROM expression_assembly WHERE workspace_id = $1 AND expires_at <= clock_timestamp()")
        .bind(workspace)
        .execute(&mut *conn)
        .await?;
    Ok(freed)
}
