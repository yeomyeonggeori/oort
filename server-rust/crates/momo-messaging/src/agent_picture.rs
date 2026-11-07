//! #5371 — the agent-worker's picture write (ADR-0151 증보 8, the mirror of 증보 3's read).
//!
//! A picture Hermes drew reaches the agent-worker as bytes, and on Railway the worker cannot write to the
//! api's archive. So the worker mints a **single-use write address** in the database and spends it itself,
//! once, against the api's private address (`PUT /v1/agent-media/{ws}/{token}`); the api re-decides who may
//! write when it spends the token and again when it writes the row. This module is the database half of
//! both, and nothing else:
//!
//! * [`mint_in_tx`] — the worker, inside a tenant transaction, right before the call. One row per
//!   `(run, slot)`; only the SHA-256 of the token is stored.
//! * [`redeem_in_tx`] — the api, inside a tenant transaction the **path's** workspace binds. One
//!   `UPDATE … WHERE used_at IS NULL AND expires_at > now() AND slot <= the run's picture limit AND the
//!   run is in flight` spends the token; the requester and the channel are then **derived from the run**
//!   ([`agent_picture_binding_in_tx`]), never read from the row or the request. Every refusal is the
//!   same `None`.
//! * [`write_picture_in_tx`] — the api, after the picture was decoded and stored: the binding is asked
//!   a third time, the workspace's own 24-hour ceiling is counted, and only then the `complete`
//!   attachment row (uploader = the run's agent member), its audit row and the token's one-time
//!   attachment record are written.
//!
//! **One function decides who may write** (security review M1): [`agent_picture_binding_in_tx`] is what
//! the mint, the redeem and the row write all call. It is *not* `self_media::requester_in_conversation_in_tx`
//! (that one sees neither the run's state nor an archived channel; the read route gets both from its
//! attachment SQL, and a write has no attachment yet).
//!
//! What is deliberately not here: any request value that names a channel, a requester or an uploader
//! (all three come from the run), any token in a log line, an audit row or a payload (the table is the
//! record, hash only), and any way to hand a model an address (the worker spends the token on its own
//! request and the token is never text).

use chrono::{DateTime, Utc};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{DbError, PgConnection};
use serde_json::json;
use uuid::Uuid;

use crate::attachment::is_attachment_channel_member;
use crate::self_media::{new_token, token_hash, token_is_well_formed};

/// The fixed path prefix of the write address. Not the read prefix (`/v1/self-media/`): the read
/// route's contract, the Hermes guard plugin's pinned prefix and the public edge's block all stay apart.
pub const AGENT_MEDIA_PATH_PREFIX: &str = "/v1/agent-media/";
/// How long a write address lives: minted right before the worker spends it, so it covers the call
/// and nothing more. Same number as the read address (`SELF_MEDIA_INTERNAL_TTL_SECS`).
pub const AGENT_MEDIA_TTL_SECS: i64 = 60;
/// How many pictures one run may write (ADR-0201 R10, v1). The table's CHECK is open to 4; widening
/// this constant is a code change plus an amendment, not a migration.
pub const AGENT_PICTURES_PER_RUN: i16 = 1;
/// The api's own backstop (security review M2): the most agent-written attachments a workspace may
/// gain in 24 hours. The same number as ADR-0201 P7's highest settable delegation cap, so a legitimate
/// configuration never reaches it; a compromised worker that forges run, token or membership rows does.
///
/// **What it does not bound** (implementation review M-1 (b), ADR-0151 증보 8 T2): it counts `attachment`
/// rows, and `momo_worker` holds UPDATE and DELETE on that table, so a worker compromised at the database
/// level can roll the count back (`created_at`, `status`, a deleted row). Counting from a source the
/// worker cannot shrink is decided with the first caller (S4, #5372); this constant is not that.
pub const AGENT_PICTURES_DAILY_CEILING: i64 = 200;
/// The most bytes the route reads: one number with the decoder's input ceiling and the read route's
/// (a test pins the three together).
pub const AGENT_PICTURE_MAX_INPUT_BYTES: usize = 5 * 1024 * 1024;

/// Spent and expired rows stay a day, then the next mint in that workspace drops them.
const CLEANUP_AFTER_SECS: f64 = 86_400.0;

/// A freshly minted write address: the token (shown once, never stored), when it dies and its slot.
///
/// `Debug` is written by hand: the token is the whole credential until it is spent.
#[derive(Clone, PartialEq, Eq)]
pub struct AgentPictureGrant {
    pub token: String,
    pub expires_at: DateTime<Utc>,
    pub slot: i16,
}

impl std::fmt::Debug for AgentPictureGrant {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Destructured so that a field added later has to be decided on here, not skipped silently.
        let AgentPictureGrant {
            token: _,
            expires_at,
            slot,
        } = self;
        formatter
            .debug_struct("AgentPictureGrant")
            .field("token", &"<redacted>")
            .field("expires_at", expires_at)
            .field("slot", slot)
            .finish()
    }
}

/// Who a run's picture is for: derived from the run, never from a row or a request. Not exported: the
/// callers outside this module ask [`mint_in_tx`], [`redeem_in_tx`] and [`write_picture_in_tx`], never the
/// predicate itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AgentPictureBinding {
    pub requester_member_id: Uuid,
    pub channel_id: Uuid,
}

/// What a redeemed token lets the route write: this run's agent, in this run's channel, in this slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentPictureTarget {
    pub run_id: Uuid,
    pub agent_member_id: Uuid,
    pub requester_member_id: Uuid,
    pub channel_id: Uuid,
    pub slot: i16,
}

/// **The one function that decides whether an agent's run may write a picture now** (W3, M1): the run
/// is `queued` or `running` and belongs to this agent, **the run's agent seat is held by an agent**
/// (`member.kind = 'agent'`, implementation review M-1: `agent_run.agent_member_id` only references
/// `member`, so a run row can name a person there, and the attachment would then be uploaded by that
/// person and escape the agent-written count), its trigger's author is a live human, and both the
/// agent and that human are active members of the run's channel, which is not archived
/// (`is_attachment_channel_member` holds `archived_at IS NULL`, member active and `left_at IS NULL` in
/// one statement). `None` is every refusal alike.
pub(crate) async fn agent_picture_binding_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    agent_member_id: Uuid,
) -> Result<Option<AgentPictureBinding>, DbError> {
    let row: Option<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT h.id, r.channel_id \
           FROM agent_run r \
           JOIN message t ON t.workspace_id = r.workspace_id AND t.id = r.trigger_message_id \
           JOIN member h ON h.workspace_id = t.workspace_id AND h.id = t.author_member_id \
           JOIN member a ON a.workspace_id = r.workspace_id AND a.id = r.agent_member_id \
          WHERE r.workspace_id = $1 AND r.id = $2 AND r.agent_member_id = $3 \
            AND r.status IN ('queued', 'running') \
            AND a.kind = 'agent' \
            AND h.kind = 'human' AND h.status = 'active' AND h.deleted_at IS NULL",
    )
    .bind(workspace_id)
    .bind(run_id)
    .bind(agent_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((requester, channel_id)) = row else {
        return Ok(None);
    };
    if !is_attachment_channel_member(conn, workspace_id, channel_id, agent_member_id).await?
        || !is_attachment_channel_member(conn, workspace_id, channel_id, requester).await?
    {
        return Ok(None);
    }
    Ok(Some(AgentPictureBinding {
        requester_member_id: requester,
        channel_id,
    }))
}

/// Mint the worker's write address for this run's next picture slot, with the production TTL.
/// `None` — the binding does not hold, the run's slots are used up, or there is no entropy — is every
/// refusal alike and writes nothing. The caller is the agent-worker and the token is for **its own**
/// request: it must never be put into text a model reads, a log line or an audit row.
pub async fn mint_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    agent_member_id: Uuid,
) -> Result<Option<AgentPictureGrant>, DbError> {
    mint_with_ttl_in_tx(
        conn,
        workspace_id,
        run_id,
        agent_member_id,
        AGENT_MEDIA_TTL_SECS,
    )
    .await
}

/// [`mint_in_tx`] with an explicit TTL (seconds); the table's ten-minute ceiling and positivity check
/// apply exactly as for the read address.
pub async fn mint_with_ttl_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    agent_member_id: Uuid,
    ttl_secs: i64,
) -> Result<Option<AgentPictureGrant>, DbError> {
    // The binding is asked before a row is written, so a refused run leaves no trace in the table.
    if agent_picture_binding_in_tx(conn, workspace_id, run_id, agent_member_id)
        .await?
        .is_none()
    {
        return Ok(None);
    }
    let Some(token) = new_token() else {
        return Ok(None);
    };
    sqlx::query(
        "DELETE FROM attachment_write_token \
          WHERE workspace_id = $1 AND expires_at < clock_timestamp() - make_interval(secs => $2)",
    )
    .bind(workspace_id)
    .bind(CLEANUP_AFTER_SECS)
    .execute(&mut *conn)
    .await?;
    let taken: Vec<i16> = sqlx::query_scalar(
        "SELECT slot FROM attachment_write_token WHERE workspace_id = $1 AND run_id = $2",
    )
    .bind(workspace_id)
    .bind(run_id)
    .fetch_all(&mut *conn)
    .await?;
    let Some(slot) = (1..=AGENT_PICTURES_PER_RUN).find(|slot| !taken.contains(slot)) else {
        return Ok(None);
    };
    // `UNIQUE (workspace, run, slot)` is the guard a concurrent mint meets: the loser writes nothing.
    let expires_at: Option<DateTime<Utc>> = sqlx::query_scalar(
        "INSERT INTO attachment_write_token \
            (workspace_id, token_hash, run_id, agent_member_id, slot, created_at, expires_at) \
         VALUES ($1, $2, $3, $4, $5, clock_timestamp(), clock_timestamp() + make_interval(secs => $6)) \
         ON CONFLICT (workspace_id, run_id, slot) DO NOTHING \
         RETURNING expires_at",
    )
    .bind(workspace_id)
    .bind(token_hash(&token).to_vec())
    .bind(run_id)
    .bind(agent_member_id)
    .bind(slot)
    .bind(ttl_secs as f64)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(expires_at.map(|expires_at| AgentPictureGrant {
        token,
        expires_at,
        slot,
    }))
}

/// Spend a write token and name what it may write. `None` is every refusal alike.
///
/// The spend is one statement, so two requests with the same token can never both win. It commits even
/// when a later rule refuses (the token is gone either way). The slot must be within the run's limit
/// (a forged row cannot name slot 2 in v1), the run must still be in flight with this agent, and then
/// the requester and the channel are **derived from the run** by [`agent_picture_binding_in_tx`].
pub async fn redeem_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    token: &str,
) -> Result<Option<AgentPictureTarget>, DbError> {
    if !token_is_well_formed(token) {
        return Ok(None);
    }
    // The run-state list inside this statement is the second copy of the one in
    // `agent_picture_binding_in_tx` (review I-1): it keeps a token from being burned for a run that is
    // already over. It may be narrower than the predicate, never wider; if the predicate's list ever
    // grows (the ADR's open check ① names `awaiting_approval`), this one grows with it, or a run in the
    // new state would be refused here before the predicate is asked.
    let spent: Option<(Uuid, Uuid, i16)> = sqlx::query_as(
        "UPDATE attachment_write_token t SET used_at = clock_timestamp() \
          WHERE t.workspace_id = $1 AND t.token_hash = $2 \
            AND t.used_at IS NULL AND t.expires_at > clock_timestamp() \
            AND t.slot <= $3 \
            AND EXISTS (SELECT 1 FROM agent_run r \
                         WHERE r.workspace_id = t.workspace_id AND r.id = t.run_id \
                           AND r.agent_member_id = t.agent_member_id \
                           AND r.status IN ('queued', 'running')) \
          RETURNING t.run_id, t.agent_member_id, t.slot",
    )
    .bind(workspace_id)
    .bind(token_hash(token).to_vec())
    .bind(AGENT_PICTURES_PER_RUN)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((run_id, agent_member_id, slot)) = spent else {
        return Ok(None);
    };
    let Some(binding) =
        agent_picture_binding_in_tx(conn, workspace_id, run_id, agent_member_id).await?
    else {
        return Ok(None);
    };
    Ok(Some(AgentPictureTarget {
        run_id,
        agent_member_id,
        requester_member_id: binding.requester_member_id,
        channel_id: binding.channel_id,
        slot,
    }))
}

/// What the route stored and wants recorded. Every field is the **server's** value: the name is
/// fixed ([`picture_name`]), the mime and the size are the decoder's output, never the request's.
#[derive(Debug, Clone)]
pub struct StoredPicture {
    pub drive_file_id: String,
    pub name: String,
    pub mime: String,
    pub size_bytes: i64,
    /// The sniffed type of the bytes that came in (audit only).
    pub mime_in: &'static str,
    pub bytes_in: i64,
    pub decode_ms: i64,
    /// `local`, `google` or `stub` (audit only).
    pub backend: &'static str,
}

/// Why [`write_picture_in_tx`] wrote nothing. The caller deletes the stored object and answers a closed
/// code (`run_over`, `cap_reached`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PictureWriteRefused {
    /// The binding no longer holds (the run ended or was cancelled, someone left, the channel was
    /// archived) — asked a third time, after the decode.
    RunOver,
    /// The workspace already gained [`AGENT_PICTURES_DAILY_CEILING`] agent-written attachments today.
    CapReached,
}

/// The server-fixed name of a picture: nothing the model, Hermes or the request said ever becomes a
/// file name.
pub fn picture_name(slot: i16, mime: &str) -> String {
    let extension = if mime == "image/jpeg" { "jpg" } else { "png" };
    format!("picture-{slot}.{extension}")
}

/// Write the `complete` attachment row for a picture that is already in the archive, its audit row and
/// the token's one-time record of it, in the caller's transaction. Every refusal happens **before** a
/// write, so a refused call leaves the transaction clean (the caller still deletes the stored object).
///
/// `daily_ceiling` is [`AGENT_PICTURES_DAILY_CEILING`] in production; it is a parameter so the test can
/// reach it without writing two hundred pictures.
pub async fn write_picture_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    target: &AgentPictureTarget,
    picture: &StoredPicture,
    daily_ceiling: i64,
) -> Result<Result<Uuid, PictureWriteRefused>, DbError> {
    // The third time the one function is asked: the run may have ended while the picture was decoded.
    let Some(binding) =
        agent_picture_binding_in_tx(conn, workspace_id, target.run_id, target.agent_member_id)
            .await?
    else {
        return Ok(Err(PictureWriteRefused::RunOver));
    };
    if binding.channel_id != target.channel_id {
        return Ok(Err(PictureWriteRefused::RunOver));
    }
    // The api counts for itself (M2): a worker that forges run, token or membership rows must not make
    // this unbounded. It counts `attachment` rows, which that worker can also rewrite: see
    // `AGENT_PICTURES_DAILY_CEILING` for what this backstop does not bound.
    let today: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM attachment a \
           JOIN member m ON m.workspace_id = a.workspace_id AND m.id = a.uploader_member_id \
          WHERE a.workspace_id = $1 AND m.kind = 'agent' AND a.status = 'complete' \
            AND a.created_at > clock_timestamp() - interval '24 hours'",
    )
    .bind(workspace_id)
    .fetch_one(&mut *conn)
    .await?;
    if today >= daily_ceiling {
        return Ok(Err(PictureWriteRefused::CapReached));
    }
    let attachment_id: Uuid = sqlx::query_scalar(
        "INSERT INTO attachment \
            (workspace_id, channel_id, uploader_member_id, message_id, drive_file_id, name, mime, \
             size_bytes, status) \
         VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, 'complete') \
         RETURNING id",
    )
    .bind(workspace_id)
    .bind(binding.channel_id)
    .bind(target.agent_member_id)
    .bind(&picture.drive_file_id)
    .bind(&picture.name)
    .bind(&picture.mime)
    .bind(picture.size_bytes)
    .fetch_one(&mut *conn)
    .await?;
    let recorded = sqlx::query(
        "UPDATE attachment_write_token SET attachment_id = $4 \
          WHERE workspace_id = $1 AND run_id = $2 AND slot = $3 AND agent_member_id = $5 \
            AND used_at IS NOT NULL AND attachment_id IS NULL",
    )
    .bind(workspace_id)
    .bind(target.run_id)
    .bind(target.slot)
    .bind(attachment_id)
    .bind(target.agent_member_id)
    .execute(&mut *conn)
    .await?;
    if recorded.rows_affected() != 1 {
        // Not reachable through the route (it just spent this very row); a hand-built target is refused
        // loudly and the caller's transaction rolls back with the row above.
        return Err(DbError::from(sqlx::Error::RowNotFound));
    }
    write_audit(
        &mut *conn,
        &AuditEntry::new(workspace_id, "attachment.agent_picture_written")
            .by(target.agent_member_id)
            .about_optional(None)
            .target("attachment", attachment_id)
            .via_token(None)
            .with_schema(
                "momo.attachment.agent_picture_written.v1",
                json!({
                    "channel_id": binding.channel_id.to_string(),
                    "run_id": target.run_id.to_string(),
                    "slot": target.slot,
                    "mime_in": picture.mime_in,
                    "mime": picture.mime,
                    "bytes_in": picture.bytes_in,
                    "bytes": picture.size_bytes,
                    "decode_ms": picture.decode_ms,
                    "backend": picture.backend,
                }),
            ),
    )
    .await?;
    Ok(Ok(attachment_id))
}

/// One audit line for a write the route refused **after** the caller proved the token (a refusal before
/// that is a 404 and leaves no line: nobody proved anything). `reason` is a closed word; no byte, name,
/// token or address is ever recorded.
pub async fn record_picture_refused_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    target: &AgentPictureTarget,
    reason: &'static str,
    bytes_in: i64,
) -> Result<(), DbError> {
    write_audit(
        &mut *conn,
        &AuditEntry::new(workspace_id, "attachment.agent_picture_refused")
            .by(target.agent_member_id)
            .about_optional(None)
            .target("agent_run", target.run_id)
            .via_token(None)
            .with_schema(
                "momo.attachment.agent_picture_refused.v1",
                json!({
                    "run_id": target.run_id.to_string(),
                    "slot": target.slot,
                    "reason": reason,
                    "bytes_in": bytes_in,
                }),
            ),
    )
    .await?;
    Ok(())
}

/// The attachments this run's pictures became, in slot order — the only ids the answer message may
/// bind (security review L2: the caller never names an id). Empty when the run wrote none.
pub async fn run_picture_ids_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
) -> Result<Vec<Uuid>, DbError> {
    Ok(sqlx::query_scalar(
        "SELECT attachment_id FROM attachment_write_token \
          WHERE workspace_id = $1 AND run_id = $2 AND attachment_id IS NOT NULL \
          ORDER BY slot",
    )
    .bind(workspace_id)
    .bind(run_id)
    .fetch_all(&mut *conn)
    .await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_picture_name_is_fixed_by_slot_and_type_alone() {
        assert_eq!(picture_name(1, "image/png"), "picture-1.png");
        assert_eq!(picture_name(2, "image/jpeg"), "picture-2.jpg");
        // anything that is not the decoder's JPEG output is the PNG name: the name never follows input
        assert_eq!(picture_name(1, "text/html"), "picture-1.png");
    }

    #[test]
    fn a_grant_never_prints_its_token() {
        let grant = AgentPictureGrant {
            token: "SECRET-TOKEN-TEXT".to_string(),
            expires_at: Utc::now(),
            slot: 1,
        };
        let printed = format!("{grant:?}");
        assert!(!printed.contains("SECRET-TOKEN-TEXT"), "{printed}");
        assert!(printed.contains("<redacted>"));
    }

    /// WA22: the route's body ceiling is one number with the decoder's input ceiling and the read
    /// route's, and the write address is as short-lived as the read address.
    #[test]
    fn the_limits_are_the_numbers_the_other_paths_already_use() {
        assert_eq!(
            AGENT_PICTURE_MAX_INPUT_BYTES as i64,
            crate::self_media::SELF_MEDIA_MAX_BYTES
        );
        assert_eq!(
            AGENT_MEDIA_TTL_SECS,
            crate::self_media::SELF_MEDIA_INTERNAL_TTL_SECS
        );
        // a compile-time fact about two constants: the code limit must sit inside the table's CHECK (1..=4)
        const { assert!(AGENT_PICTURES_PER_RUN >= 1 && AGENT_PICTURES_PER_RUN <= 4) };
    }
}
