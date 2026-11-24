//! #6013 — an Agent Port agent's picture for its own message (ADR-0151 증보 10, ADR-0162 증보 7).
//!
//! The second road to an attachment row whose uploader is an agent (P13; the first is the worker's,
//! [`crate::agent_picture`]). An agent connected from outside over MCP asks the tool
//! `oort_picture_upload_begin` for a **single-use, 120-second upload address**, PUTs one picture to it
//! with its own hands (`PUT /v1/agent-uploads/{ws}/{token}`), and binds the attachment id it gets back to
//! its own `oort_message_post` (`attachmentIds`). This module is the database half of all three, and
//! nothing else:
//!
//! * [`issue_in_tx`] — the tool, after the bearer was proved (`authorize_in_tx`): the standing predicate,
//!   the five ceilings of P7, then one token row (hash only).
//! * [`redeem_in_tx`] — the upload route, inside a tenant transaction the **path's** workspace binds: one
//!   statement spends the token, then the same standing predicate is asked **now** (P3 1). The agent and
//!   the channel come from the token row, never from the request.
//! * [`write_upload_picture_in_tx`] — the route, after the decoder: the predicate a third time and the
//!   ceilings counted again (P3 2 · P7, the strict side), then the `complete` attachment row, the
//!   `agent_picture_mark` row that makes it count (shared with the worker's road, `run_id` NULL), the
//!   token's one-time record of the attachment and the audit line.
//! * [`pictures_linkable_in_tx`] — `oort_message_post`, before its send: every id is one **this** agent
//!   uploaded **through this road** into **this** channel, `complete` and not yet bound (P6).
//!
//! **One function decides who may upload** ([`standing_in_tx`]): issue, redeem and the row write all call
//! it. It is keyed on the connection the token row names, not on a presented bearer (the PUT carries
//! none, P3 6): the connection is `active` and proved, its current credential is not revoked (its
//! **expiry** is not asked — an OAuth access credential lives 30 minutes and may lapse inside the 120
//! seconds; the same rule as `momo_auth::hosted_connection_stands_in_tx`), both the credential and the
//! connection carry `messages:write`, the agent is an active agent member whose profile is not paused,
//! the channel is one the connection is approved for, and the agent is an active member of it and it is
//! not archived. `false` is every refusal alike.
//!
//! **One serialization point** for the counts: a transaction-scoped advisory lock on the workspace,
//! taken after the standing predicate's row locks, at issue and at the row write alike, so two
//! concurrent issues or writes cannot both pass a "not yet at the ceiling" count. (The worker's road does
//! not take it; its own count stays what 179 made it.)
//!
//! What is deliberately not here: any request value that names a channel, an agent or an uploader (the
//! token row does), any token in a log line, an audit row or a payload (the table holds the hash), and any
//! address the server would fetch (P14: there is none).

use chrono::{DateTime, Utc};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{DbError, PgConnection};
use serde_json::json;
use uuid::Uuid;

use crate::agent_picture::AGENT_PICTURES_DAILY_CEILING;
use crate::attachment::is_attachment_channel_member;
use crate::self_media::{new_token, token_hash, token_is_well_formed};

/// The fixed path prefix of the upload address. Not the worker's (`/v1/agent-media/`, which the public
/// edge answers 403 for): this one is public by design (P3 4), and keeping the two apart is what lets
/// the edge keep blocking the other.
pub const AGENT_UPLOADS_PATH_PREFIX: &str = "/v1/agent-uploads/";
/// How long an upload address lives (P2, 120 seconds: a model reads the tool result and writes a shell
/// command in between). The table's CHECK caps it at ten minutes.
pub const AGENT_UPLOAD_TTL_SECS: i64 = 120;
/// Pictures one message may carry (P6 · P7): the tool schema's `maxItems` and the server's check.
pub const AGENT_PORT_PICTURES_PER_MESSAGE: usize = 4;
/// Pictures one agent may have written in the last 24 hours, both roads together (P7).
pub const AGENT_PORT_PICTURES_PER_AGENT_DAILY: i64 = 30;
/// Upload addresses one agent may hold unspent and unexpired at once (P7).
pub const AGENT_UPLOAD_LIVE_TOKENS: i64 = 4;
/// Pictures one agent may hold uploaded through this road and not bound to any message (P7).
pub const AGENT_UPLOAD_UNLINKED_PICTURES: i64 = 8;
/// Upload addresses one agent may be issued in the last 24 hours (P7).
pub const AGENT_UPLOAD_DAILY_ISSUES: i64 = 60;

/// Spent and expired token rows stay a day past their expiry (the issue count's window and P6's "a day-old
/// picture is not bound" both read them), then the api's next spend in that workspace drops them.
const TOKEN_SWEEP_AFTER_SECS: f64 = 86_400.0;
/// The scope the road rides on (ADR-0162 증보 7 I2: no new scope).
const SCOPE: &str = "messages:write";

/// A freshly issued upload address: the token (shown once, never stored) and when it dies.
///
/// `Debug` is written by hand: the token is the whole credential until it is spent.
#[derive(Clone, PartialEq, Eq)]
pub struct AgentUploadGrant {
    pub token: String,
    pub expires_at: DateTime<Utc>,
}

impl std::fmt::Debug for AgentUploadGrant {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let AgentUploadGrant {
            token: _,
            expires_at,
        } = self;
        formatter
            .debug_struct("AgentUploadGrant")
            .field("token", &"<redacted>")
            .field("expires_at", expires_at)
            .finish()
    }
}

/// Why [`issue_in_tx`] issued nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UploadIssueRefused {
    /// The standing predicate does not hold (connection, scope, approval, membership, archive).
    NotAllowed,
    /// One of the five ceilings of P7 is reached.
    LimitReached,
}

/// What a spent token lets the route write: this agent, through this connection, into this channel.
/// `token_hash` names the row the write records its attachment in.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct AgentUploadTarget {
    pub connection_id: Uuid,
    pub agent_member_id: Uuid,
    pub channel_id: Uuid,
    pub token_hash: [u8; 32],
}

impl std::fmt::Debug for AgentUploadTarget {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // the hash is not the token, but it names the row: it stays out of printed text too
        formatter
            .debug_struct("AgentUploadTarget")
            .field("connection_id", &self.connection_id)
            .field("agent_member_id", &self.agent_member_id)
            .field("channel_id", &self.channel_id)
            .finish_non_exhaustive()
    }
}

/// What the route stored and wants recorded. Every field is the **server's** value: the name is fixed
/// ([`upload_picture_name`]), the mime and the size are the decoder's output.
#[derive(Debug, Clone)]
pub struct StoredUploadPicture {
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

/// Why [`write_upload_picture_in_tx`] wrote nothing. The caller deletes the stored object and answers a
/// closed word.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UploadWriteRefused {
    /// The standing predicate no longer holds (asked a third time, after the decode).
    NotAllowedNow,
    /// A ceiling was reached between the issue and the write (P3 2 · P7, the strict side).
    CapReached,
}

/// The server-fixed name of a picture this road wrote (P5): nothing the agent or the request said is ever
/// a file name.
pub fn upload_picture_name(mime: &str) -> String {
    let extension = if mime == "image/jpeg" { "jpg" } else { "png" };
    format!("picture.{extension}")
}

/// **The one function that decides whether an Agent Port agent may upload into a channel now** (P2 ·
/// P3 1 · P3 2, module doc). Row locks follow HAP-E4's order (connection → credential → member →
/// membership → profile), the same as `momo_auth::resolve_hosted_tool_identity_in_tx`.
pub(crate) async fn standing_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    connection_id: Uuid,
    agent_member_id: Uuid,
    channel_id: Uuid,
) -> Result<bool, DbError> {
    let approved: Option<Vec<Uuid>> = sqlx::query_scalar(
        "SELECT hosted_connection_channel_ids(hc.workspace_id, hc.id) \
           FROM hosted_agent_connection hc \
           JOIN token t ON t.workspace_id = hc.workspace_id AND t.id = hc.active_token_id \
           JOIN member m ON m.workspace_id = hc.workspace_id AND m.id = hc.agent_member_id \
           JOIN workspace_membership wm \
             ON wm.workspace_id = hc.workspace_id AND wm.member_id = hc.agent_member_id \
           JOIN agent_profile ap \
             ON ap.workspace_id = hc.workspace_id AND ap.agent_member_id = hc.agent_member_id \
          WHERE hc.workspace_id = $1 AND hc.id = $2 AND hc.agent_member_id = $3 \
            AND hc.status = 'active' AND hc.proved_at IS NOT NULL \
            AND t.kind = 'agent_bearer' \
            AND t.credential_class IN ('hosted_active', 'hosted_oauth_access') \
            AND t.revoked_at IS NULL \
            AND t.hosted_connection_id = hc.id AND t.actor_member_id = hc.agent_member_id \
            AND t.audience = $4 \
            AND 'agent:port:connect' = ANY(t.scopes) AND 'agent:port:connect' = ANY(hc.approved_scopes) \
            AND $5 = ANY(t.scopes) AND $5 = ANY(hc.approved_scopes) \
            AND m.kind = 'agent' AND m.status = 'active' AND m.deleted_at IS NULL \
            AND ap.paused = false \
          FOR SHARE OF hc, t, m, wm, ap",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .bind(agent_member_id)
    .bind(momo_auth::HOSTED_AGENT_PORT_AUDIENCE)
    .bind(SCOPE)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(approved) = approved else {
        return Ok(false);
    };
    if !approved.contains(&channel_id) {
        return Ok(false);
    }
    // active member of the channel, not left, and the channel not archived — one statement
    is_attachment_channel_member(conn, workspace_id, channel_id, agent_member_id).await
}

/// The one serialization point for this road's counts (module doc).
async fn lock_counts_in_tx(conn: &mut PgConnection, workspace_id: Uuid) -> Result<(), DbError> {
    sqlx::query(
        "SELECT pg_advisory_xact_lock(hashtextextended('momo.agent_upload:' || $1::text, 0))",
    )
    .bind(workspace_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// The picture counts both the issue and the write ask (P7): the agent's and the workspace's pictures of
/// the last 24 hours (`agent_picture_mark`, both roads) and the agent's pictures uploaded through this road
/// and bound to no message. `true` when any is at its ceiling.
async fn picture_ceiling_reached_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    workspace_daily_ceiling: i64,
) -> Result<bool, DbError> {
    let (agent_today, workspace_today): (i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE agent_member_id = $2), count(*) \
           FROM agent_picture_mark \
          WHERE workspace_id = $1 AND written_at > clock_timestamp() - interval '24 hours'",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .fetch_one(&mut *conn)
    .await?;
    if agent_today >= AGENT_PORT_PICTURES_PER_AGENT_DAILY
        || workspace_today >= workspace_daily_ceiling
    {
        return Ok(true);
    }
    let unlinked: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM agent_upload_token t \
           JOIN attachment a ON a.workspace_id = t.workspace_id AND a.id = t.attachment_id \
          WHERE t.workspace_id = $1 AND t.agent_member_id = $2 AND a.message_id IS NULL",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(unlinked >= AGENT_UPLOAD_UNLINKED_PICTURES)
}

/// Issue an upload address for `agent_member_id` into `channel_id` through `connection_id`, with the
/// production TTL and ceilings. The caller has already proved the presented bearer (the tool's
/// `authorize_in_tx`); this asks the standing predicate again from the connection's side, counts and
/// writes one row. Every refusal writes nothing.
pub async fn issue_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    connection_id: Uuid,
    agent_member_id: Uuid,
    channel_id: Uuid,
) -> Result<Result<AgentUploadGrant, UploadIssueRefused>, DbError> {
    issue_with_ttl_in_tx(
        conn,
        workspace_id,
        connection_id,
        agent_member_id,
        channel_id,
        AGENT_UPLOAD_TTL_SECS,
        AGENT_PICTURES_DAILY_CEILING,
    )
    .await
}

/// [`issue_in_tx`] with an explicit TTL (seconds; the table's ten-minute ceiling applies) and workspace
/// ceiling (so a test reaches it without writing two hundred pictures).
pub async fn issue_with_ttl_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    connection_id: Uuid,
    agent_member_id: Uuid,
    channel_id: Uuid,
    ttl_secs: i64,
    workspace_daily_ceiling: i64,
) -> Result<Result<AgentUploadGrant, UploadIssueRefused>, DbError> {
    if !standing_in_tx(
        conn,
        workspace_id,
        connection_id,
        agent_member_id,
        channel_id,
    )
    .await?
    {
        return Ok(Err(UploadIssueRefused::NotAllowed));
    }
    lock_counts_in_tx(conn, workspace_id).await?;
    let (live, issued_today): (i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE used_at IS NULL AND expires_at > clock_timestamp()), \
                count(*) FILTER (WHERE created_at > clock_timestamp() - interval '24 hours') \
           FROM agent_upload_token WHERE workspace_id = $1 AND agent_member_id = $2",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .fetch_one(&mut *conn)
    .await?;
    if live >= AGENT_UPLOAD_LIVE_TOKENS || issued_today >= AGENT_UPLOAD_DAILY_ISSUES {
        return Ok(Err(UploadIssueRefused::LimitReached));
    }
    if picture_ceiling_reached_in_tx(conn, workspace_id, agent_member_id, workspace_daily_ceiling)
        .await?
    {
        return Ok(Err(UploadIssueRefused::LimitReached));
    }
    let Some(token) = new_token() else {
        return Ok(Err(UploadIssueRefused::NotAllowed));
    };
    let expires_at: DateTime<Utc> = sqlx::query_scalar(
        "INSERT INTO agent_upload_token \
            (workspace_id, token_hash, connection_id, agent_member_id, channel_id, created_at, expires_at) \
         VALUES ($1, $2, $3, $4, $5, clock_timestamp(), clock_timestamp() + make_interval(secs => $6)) \
         RETURNING expires_at",
    )
    .bind(workspace_id)
    .bind(token_hash(&token).to_vec())
    .bind(connection_id)
    .bind(agent_member_id)
    .bind(channel_id)
    .bind(ttl_secs as f64)
    .fetch_one(&mut *conn)
    .await?;
    Ok(Ok(AgentUploadGrant { token, expires_at }))
}

/// Spend an upload token and name what it may write. `None` is every refusal alike (P3 5: the route
/// answers one 404 for all of them).
///
/// The spend is one statement, so two requests with the same token can never both win, and it commits even
/// when the predicate below refuses (the token is gone either way). Then this workspace's day-old token rows
/// are swept, and the standing predicate is asked **now** for the row's connection, agent and channel.
pub async fn redeem_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    token: &str,
) -> Result<Option<AgentUploadTarget>, DbError> {
    if !token_is_well_formed(token) {
        return Ok(None);
    }
    let hash = token_hash(token);
    let spent: Option<(Uuid, Uuid, Uuid)> = sqlx::query_as(
        "UPDATE agent_upload_token SET used_at = clock_timestamp() \
          WHERE workspace_id = $1 AND token_hash = $2 \
            AND used_at IS NULL AND expires_at > clock_timestamp() \
          RETURNING connection_id, agent_member_id, channel_id",
    )
    .bind(workspace_id)
    .bind(hash.to_vec())
    .fetch_optional(&mut *conn)
    .await?;
    let Some((connection_id, agent_member_id, channel_id)) = spent else {
        return Ok(None);
    };
    sqlx::query(
        "DELETE FROM agent_upload_token \
          WHERE workspace_id = $1 AND expires_at < clock_timestamp() - make_interval(secs => $2)",
    )
    .bind(workspace_id)
    .bind(TOKEN_SWEEP_AFTER_SECS)
    .execute(&mut *conn)
    .await?;
    if !standing_in_tx(
        conn,
        workspace_id,
        connection_id,
        agent_member_id,
        channel_id,
    )
    .await?
    {
        return Ok(None);
    }
    Ok(Some(AgentUploadTarget {
        connection_id,
        agent_member_id,
        channel_id,
        token_hash: hash,
    }))
}

/// Write the `complete` attachment row for a picture that is already in the archive, the mark that makes
/// it count, the token's one-time record of it and the audit line, in the caller's transaction. Every
/// refusal happens **before** a write, so a refused call leaves the transaction clean (the caller still
/// deletes the stored object).
///
/// `workspace_daily_ceiling` is [`AGENT_PICTURES_DAILY_CEILING`] in production; it is a parameter so the
/// test can reach it.
pub async fn write_upload_picture_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    target: &AgentUploadTarget,
    picture: &StoredUploadPicture,
    workspace_daily_ceiling: i64,
) -> Result<Result<Uuid, UploadWriteRefused>, DbError> {
    // The third time the one function is asked: something may have changed while the picture was decoded.
    if !standing_in_tx(
        conn,
        workspace_id,
        target.connection_id,
        target.agent_member_id,
        target.channel_id,
    )
    .await?
    {
        return Ok(Err(UploadWriteRefused::NotAllowedNow));
    }
    // The ceilings again, under the same lock the issue took (P3 2 · P7: judged at issue, counted again here).
    lock_counts_in_tx(conn, workspace_id).await?;
    if picture_ceiling_reached_in_tx(
        conn,
        workspace_id,
        target.agent_member_id,
        workspace_daily_ceiling,
    )
    .await?
    {
        return Ok(Err(UploadWriteRefused::CapReached));
    }
    let attachment_id: Uuid = sqlx::query_scalar(
        "INSERT INTO attachment \
            (workspace_id, channel_id, uploader_member_id, message_id, drive_file_id, name, mime, \
             size_bytes, status) \
         VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, 'complete') \
         RETURNING id",
    )
    .bind(workspace_id)
    .bind(target.channel_id)
    .bind(target.agent_member_id)
    .bind(&picture.drive_file_id)
    .bind(&picture.name)
    .bind(&picture.mime)
    .bind(picture.size_bytes)
    .fetch_one(&mut *conn)
    .await?;
    // The mark that makes this picture count — the table the worker's road counts from too (P7), no run.
    sqlx::query(
        "INSERT INTO agent_picture_mark (workspace_id, attachment_id, run_id, agent_member_id) \
         VALUES ($1, $2, NULL, $3)",
    )
    .bind(workspace_id)
    .bind(attachment_id)
    .bind(target.agent_member_id)
    .execute(&mut *conn)
    .await?;
    let recorded = sqlx::query(
        "UPDATE agent_upload_token SET attachment_id = $3 \
          WHERE workspace_id = $1 AND token_hash = $2 AND agent_member_id = $4 \
            AND used_at IS NOT NULL AND attachment_id IS NULL",
    )
    .bind(workspace_id)
    .bind(target.token_hash.to_vec())
    .bind(attachment_id)
    .bind(target.agent_member_id)
    .execute(&mut *conn)
    .await?;
    if recorded.rows_affected() != 1 {
        // Not reachable through the route (it just spent this very row); a hand-built target is refused
        // loudly and the caller's transaction rolls back with the rows above.
        return Err(DbError::from(sqlx::Error::RowNotFound));
    }
    write_audit(
        &mut *conn,
        &AuditEntry::new(workspace_id, "attachment.agent_port_picture_written")
            .by(target.agent_member_id)
            .about_optional(None)
            .target("attachment", attachment_id)
            .via_token(None)
            .with_schema(
                "momo.attachment.agent_port_picture_written.v1",
                json!({
                    "channel_id": target.channel_id.to_string(),
                    "connection_id": target.connection_id.to_string(),
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

/// One audit line for an upload the route refused **after** the caller proved the token (a refusal before
/// that is a 404 and leaves no line). `reason` is a closed word; no byte, name, token or address is ever
/// recorded.
pub async fn record_upload_refused_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    target: &AgentUploadTarget,
    reason: &'static str,
    bytes_in: i64,
) -> Result<(), DbError> {
    write_audit(
        &mut *conn,
        &AuditEntry::new(workspace_id, "attachment.agent_port_picture_refused")
            .by(target.agent_member_id)
            .about_optional(None)
            .target("channel", target.channel_id)
            .via_token(None)
            .with_schema(
                "momo.attachment.agent_port_picture_refused.v1",
                json!({
                    "channel_id": target.channel_id.to_string(),
                    "reason": reason,
                    "bytes_in": bytes_in,
                }),
            ),
    )
    .await?;
    Ok(())
}

/// May `agent_member_id` bind every one of `attachment_ids` to its message in `channel_id`? (P6.) True only
/// when the list holds 1..=[`AGENT_PORT_PICTURES_PER_MESSAGE`] distinct ids and **each** one is recorded on a
/// token row of this road issued to this agent for this channel, and its attachment is `complete`, uploaded
/// by this agent into this channel and bound to no message. The attachment rows are locked, so two posts
/// that name the same id cannot both pass. One `false` for every refusal: the caller answers one closed
/// shape and never says which id or why.
///
/// A **retry** is the exception the send's idempotence already owns: when this agent already sent a message
/// with this `client_msg_id` in this channel, the send answers that message and binds nothing (the pictures
/// are bound to it already), so this answers `true` without judging the ids again — a retry of a post that
/// landed is not refused because its own pictures are now bound.
pub async fn pictures_linkable_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    channel_id: Uuid,
    client_msg_id: Uuid,
    attachment_ids: &[Uuid],
) -> Result<bool, DbError> {
    let already_sent: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM message \
                         WHERE channel_id = $1 AND author_member_id = $2 AND client_msg_id = $3)",
    )
    .bind(channel_id)
    .bind(agent_member_id)
    .bind(client_msg_id)
    .fetch_one(&mut *conn)
    .await?;
    if already_sent {
        return Ok(true);
    }
    if attachment_ids.is_empty() || attachment_ids.len() > AGENT_PORT_PICTURES_PER_MESSAGE {
        return Ok(false);
    }
    let mut distinct = attachment_ids.to_vec();
    distinct.sort_unstable();
    distinct.dedup();
    if distinct.len() != attachment_ids.len() {
        return Ok(false);
    }
    let found: Vec<Uuid> = sqlx::query_scalar(
        "SELECT a.id FROM attachment a \
          WHERE a.workspace_id = $1 AND a.id = ANY($4) \
            AND a.status = 'complete' AND a.uploader_member_id = $2 AND a.channel_id = $3 \
            AND a.message_id IS NULL \
            AND EXISTS (SELECT 1 FROM agent_upload_token t \
                         WHERE t.workspace_id = a.workspace_id AND t.attachment_id = a.id \
                           AND t.agent_member_id = $2 AND t.channel_id = $3) \
          FOR UPDATE OF a",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .bind(channel_id)
    .bind(&distinct)
    .fetch_all(&mut *conn)
    .await?;
    Ok(found.len() == distinct.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_picture_name_is_fixed_by_type_alone() {
        assert_eq!(upload_picture_name("image/png"), "picture.png");
        assert_eq!(upload_picture_name("image/jpeg"), "picture.jpg");
        assert_eq!(upload_picture_name("text/html"), "picture.png");
    }

    #[test]
    fn a_grant_and_a_target_never_print_their_secret() {
        let grant = AgentUploadGrant {
            token: "SECRET-TOKEN-TEXT".to_string(),
            expires_at: Utc::now(),
        };
        let printed = format!("{grant:?}");
        assert!(!printed.contains("SECRET-TOKEN-TEXT"), "{printed}");
        assert!(printed.contains("<redacted>"));
        let target = AgentUploadTarget {
            connection_id: Uuid::nil(),
            agent_member_id: Uuid::nil(),
            channel_id: Uuid::nil(),
            token_hash: [7; 32],
        };
        assert!(!format!("{target:?}").contains("token_hash"));
    }

    #[test]
    fn the_numbers_are_the_amendments() {
        // ADR-0151 증보 10 P2 · P7 (Accepted 2026-11-23): changing one is an amendment, not a refactor
        assert_eq!(AGENT_UPLOAD_TTL_SECS, 120);
        assert_eq!(AGENT_PORT_PICTURES_PER_MESSAGE, 4);
        assert_eq!(AGENT_PORT_PICTURES_PER_AGENT_DAILY, 30);
        assert_eq!(AGENT_UPLOAD_LIVE_TOKENS, 4);
        assert_eq!(AGENT_UPLOAD_UNLINKED_PICTURES, 8);
        assert_eq!(AGENT_UPLOAD_DAILY_ISSUES, 60);
        assert_eq!(AGENT_PICTURES_DAILY_CEILING, 200);
        assert_ne!(AGENT_UPLOADS_PATH_PREFIX, crate::AGENT_MEDIA_PATH_PREFIX);
    }
}
