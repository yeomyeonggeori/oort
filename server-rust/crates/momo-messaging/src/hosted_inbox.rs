//! Connection-scoped hosted-agent inbox projection (ADR-0162 / HAP-E4).
//!
//! This is not a second message or job ledger. Rows contain immutable source
//! identifiers only; callers still resolve bodies through the existing domain
//! stores after their current authorization checks. The append functions take
//! a caller-owned transaction so the source mutation and reference either both
//! commit or both roll back.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use momo_db::{DbError, PgConnection};
use sha2::{Digest, Sha256};
use sqlx::Row;
use uuid::Uuid;

const CURSOR_PREFIX: &str = "momo_inbox_cursor_v1.";
const CURSOR_DOMAIN: &[u8] = b"oort/hosted-agent-inbox/cursor/v1";
const CURSOR_VERSION: u8 = 1;
const CURSOR_NONCE_BYTES: usize = 12;
const CURSOR_PLAINTEXT_BYTES: usize = 1 + 16 + 16 + 16 + 8;
const CURSOR_ENVELOPE_BYTES: usize = CURSOR_NONCE_BYTES + CURSOR_PLAINTEXT_BYTES + 16;
const CURSOR_BODY_CHARS: usize = 114;

pub const HOSTED_INBOX_LIMIT_DEFAULT: i64 = 50;
pub const HOSTED_INBOX_LIMIT_MAX: i64 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostedInboxCursor {
    pub workspace_id: Uuid,
    pub agent_member_id: Uuid,
    pub connection_id: Uuid,
    pub position: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum HostedInboxCursorError {
    #[error("invalid hosted inbox cursor")]
    Invalid,
    #[error("hosted inbox cursor could not be issued")]
    Crypto,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum HostedInboxReadError {
    #[error("hosted inbox is unavailable")]
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedInboxEvent {
    pub inbox_seq: i64,
    pub event_kind: String,
    pub source_message_id: Option<Uuid>,
    pub source_channel_id: Option<Uuid>,
    pub source_message_seq: Option<i64>,
    pub source_outbox_id: Option<i64>,
    pub source_run_id: Option<Uuid>,
    pub channel_id: Option<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedInboxPage {
    pub events: Vec<HostedInboxEvent>,
    /// Always present, including an empty page. Pollers can safely retain the
    /// returned opaque cursor without learning the internal sequence.
    pub next_cursor: String,
    pub has_more: bool,
}

fn cursor_key(secret: &str) -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update(CURSOR_DOMAIN);
    digest.update([0]);
    digest.update(secret.as_bytes());
    digest.finalize().into()
}

pub fn encode_hosted_inbox_cursor(
    cursor: HostedInboxCursor,
    secret: &str,
) -> Result<String, HostedInboxCursorError> {
    if cursor.position < 0 || secret.is_empty() {
        return Err(HostedInboxCursorError::Invalid);
    }

    let mut plaintext = Vec::with_capacity(CURSOR_PLAINTEXT_BYTES);
    plaintext.push(CURSOR_VERSION);
    plaintext.extend_from_slice(cursor.workspace_id.as_bytes());
    plaintext.extend_from_slice(cursor.agent_member_id.as_bytes());
    plaintext.extend_from_slice(cursor.connection_id.as_bytes());
    plaintext.extend_from_slice(&cursor.position.to_be_bytes());

    let mut nonce_bytes = [0_u8; CURSOR_NONCE_BYTES];
    getrandom::getrandom(&mut nonce_bytes).map_err(|_| HostedInboxCursorError::Crypto)?;
    let cipher = Aes256Gcm::new_from_slice(&cursor_key(secret))
        .map_err(|_| HostedInboxCursorError::Crypto)?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            aes_gcm::aead::Payload {
                msg: &plaintext,
                aad: CURSOR_DOMAIN,
            },
        )
        .map_err(|_| HostedInboxCursorError::Crypto)?;

    let mut envelope = Vec::with_capacity(nonce_bytes.len() + ciphertext.len());
    envelope.extend_from_slice(&nonce_bytes);
    envelope.extend_from_slice(&ciphertext);
    Ok(format!(
        "{CURSOR_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(envelope)
    ))
}

pub fn decode_hosted_inbox_cursor(
    encoded: &str,
    secret: &str,
) -> Result<HostedInboxCursor, HostedInboxCursorError> {
    let body = encoded
        .strip_prefix(CURSOR_PREFIX)
        .ok_or(HostedInboxCursorError::Invalid)?;
    if body.len() != CURSOR_BODY_CHARS || secret.is_empty() {
        return Err(HostedInboxCursorError::Invalid);
    }
    let envelope = URL_SAFE_NO_PAD
        .decode(body)
        .map_err(|_| HostedInboxCursorError::Invalid)?;
    if envelope.len() != CURSOR_ENVELOPE_BYTES {
        return Err(HostedInboxCursorError::Invalid);
    }
    let (nonce, ciphertext) = envelope.split_at(CURSOR_NONCE_BYTES);
    let cipher = Aes256Gcm::new_from_slice(&cursor_key(secret))
        .map_err(|_| HostedInboxCursorError::Crypto)?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(nonce),
            aes_gcm::aead::Payload {
                msg: ciphertext,
                aad: CURSOR_DOMAIN,
            },
        )
        .map_err(|_| HostedInboxCursorError::Invalid)?;
    if plaintext.len() != CURSOR_PLAINTEXT_BYTES || plaintext[0] != CURSOR_VERSION {
        return Err(HostedInboxCursorError::Invalid);
    }

    let workspace_id =
        Uuid::from_slice(&plaintext[1..17]).map_err(|_| HostedInboxCursorError::Invalid)?;
    let agent_member_id =
        Uuid::from_slice(&plaintext[17..33]).map_err(|_| HostedInboxCursorError::Invalid)?;
    let connection_id =
        Uuid::from_slice(&plaintext[33..49]).map_err(|_| HostedInboxCursorError::Invalid)?;
    let position = i64::from_be_bytes(
        plaintext[49..57]
            .try_into()
            .map_err(|_| HostedInboxCursorError::Invalid)?,
    );
    if position < 0 {
        return Err(HostedInboxCursorError::Invalid);
    }
    Ok(HostedInboxCursor {
        workspace_id,
        agent_member_id,
        connection_id,
        position,
    })
}

/// Append one message reference to one authenticated hosted connection.
/// The explicit agent/connection target prevents a producer or future selector
/// from accidentally fanning a private event out to every hosted member in a
/// channel. Replaying the same source is idempotent and consumes no sequence.
///
/// ## Why the `seq` lookup carries no `deleted_at` filter (#1375, closed)
///
/// The #1365 review asked whether a soft-deleted message could enter the ledger
/// through this read. It cannot, and the reason is placement rather than a
/// predicate: HAP-E5 put the only call site inside the send transaction,
/// immediately after the message row is written (`send_message_in_tx`, step 5
/// of the product send spine). A message cannot be tombstoned before it is
/// sent, so a `deleted_at IS NULL` clause here would be unreachable — it would
/// read like a defended boundary while defending nothing. A future caller that
/// appends for an *already-stored* message is the change that makes the filter
/// meaningful, and it should arrive with that caller.
pub async fn append_message_reference_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    connection_id: Uuid,
    channel_id: Uuid,
    message_id: Uuid,
) -> Result<Vec<(Uuid, i64)>, DbError> {
    let source_message_seq: i64 = sqlx::query_scalar(
        "SELECT seq FROM message \
          WHERE workspace_id=$1 AND channel_id=$2 AND id=$3 FOR SHARE",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(message_id)
    .fetch_one(&mut *conn)
    .await?;

    let recipients: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT hc.id, hc.agent_member_id \
           FROM hosted_agent_connection hc \
           JOIN token t ON t.workspace_id=hc.workspace_id AND t.id=hc.active_token_id \
           JOIN member m ON m.workspace_id=hc.workspace_id AND m.id=hc.agent_member_id \
           JOIN workspace_membership wm \
             ON wm.workspace_id=hc.workspace_id AND wm.member_id=hc.agent_member_id \
           JOIN agent_profile ap \
             ON ap.workspace_id=hc.workspace_id AND ap.agent_member_id=hc.agent_member_id \
           JOIN membership cm \
             ON cm.workspace_id=hc.workspace_id AND cm.member_id=hc.agent_member_id \
            AND cm.channel_id=$2 AND cm.left_at IS NULL \
          WHERE hc.workspace_id=$1 AND hc.agent_member_id=$3 AND hc.id=$4 \
            AND hc.status='active' AND hc.proved_at IS NOT NULL \
            AND t.kind='agent_bearer' \
            AND t.credential_class IN ('hosted_active','hosted_oauth_access') \
            AND t.revoked_at IS NULL \
            AND (t.expires_at IS NULL OR t.expires_at > now()) \
            AND t.hosted_connection_id=hc.id AND t.actor_member_id=hc.agent_member_id \
            AND t.audience='/v1/mcp/agent-port' \
            AND 'agent:inbox:read'=ANY(t.scopes) \
            AND 'agent:inbox:read'=ANY(hc.approved_scopes) \
            AND $2=ANY(hc.approved_channel_ids) \
            AND m.kind='agent' AND m.status='active' AND m.deleted_at IS NULL \
            AND ap.paused=false \
          ORDER BY hc.id FOR SHARE OF hc,t,m,wm,ap,cm",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(agent_member_id)
    .bind(connection_id)
    .fetch_all(&mut *conn)
    .await?;

    let mut appended = Vec::with_capacity(recipients.len());
    for (connection_id, agent_member_id) in recipients {
        sqlx::query(
            "INSERT INTO hosted_agent_inbox_counter \
               (workspace_id, agent_member_id, connection_id) VALUES ($1,$2,$3) \
             ON CONFLICT (workspace_id, connection_id) DO NOTHING",
        )
        .bind(workspace_id)
        .bind(agent_member_id)
        .bind(connection_id)
        .execute(&mut *conn)
        .await?;

        let _locked: i64 = sqlx::query_scalar(
            "SELECT last_seq FROM hosted_agent_inbox_counter \
              WHERE workspace_id=$1 AND connection_id=$2 FOR UPDATE",
        )
        .bind(workspace_id)
        .bind(connection_id)
        .fetch_one(&mut *conn)
        .await?;

        if let Some(existing) = sqlx::query_scalar::<_, i64>(
            "SELECT inbox_seq FROM hosted_agent_inbox_event \
              WHERE workspace_id=$1 AND connection_id=$2 \
                AND event_kind='message' AND source_message_id=$3",
        )
        .bind(workspace_id)
        .bind(connection_id)
        .bind(message_id)
        .fetch_optional(&mut *conn)
        .await?
        {
            appended.push((connection_id, existing));
            continue;
        }

        let inbox_seq: i64 = sqlx::query_scalar(
            "UPDATE hosted_agent_inbox_counter \
                SET last_seq=last_seq+1, updated_at=now() \
              WHERE workspace_id=$1 AND connection_id=$2 \
              RETURNING last_seq",
        )
        .bind(workspace_id)
        .bind(connection_id)
        .fetch_one(&mut *conn)
        .await?;
        sqlx::query(
            "INSERT INTO hosted_agent_inbox_event \
               (workspace_id,agent_member_id,connection_id,inbox_seq,event_kind, \
                source_message_id,source_channel_id,source_message_seq) \
             VALUES ($1,$2,$3,$4,'message',$5,$6,$7)",
        )
        .bind(workspace_id)
        .bind(agent_member_id)
        .bind(connection_id)
        .bind(inbox_seq)
        .bind(message_id)
        .bind(channel_id)
        .bind(source_message_seq)
        .execute(&mut *conn)
        .await?;
        appended.push((connection_id, inbox_seq));
    }
    Ok(appended)
}

/// Every hosted connection that is currently allowed to receive references for
/// `channel_id`, as `(agent_member_id, connection_id)`.
///
/// This is the producer's fan-out list, and it is deliberately the **same**
/// authority predicate [`append_message_reference_in_tx`] applies per target:
/// one connection→token→member→membership join, in that lock order, so a
/// producer cannot widen delivery merely by asking a different question. The
/// caller still passes each pair back into an append, which re-proves the
/// authority under the same transaction rather than trusting this list.
pub async fn hosted_inbox_recipients_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
) -> Result<Vec<(Uuid, Uuid)>, DbError> {
    let rows: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT hc.agent_member_id, hc.id \
           FROM hosted_agent_connection hc \
           JOIN token t ON t.workspace_id=hc.workspace_id AND t.id=hc.active_token_id \
           JOIN member m ON m.workspace_id=hc.workspace_id AND m.id=hc.agent_member_id \
           JOIN workspace_membership wm \
             ON wm.workspace_id=hc.workspace_id AND wm.member_id=hc.agent_member_id \
           JOIN agent_profile ap \
             ON ap.workspace_id=hc.workspace_id AND ap.agent_member_id=hc.agent_member_id \
           JOIN membership cm \
             ON cm.workspace_id=hc.workspace_id AND cm.member_id=hc.agent_member_id \
            AND cm.channel_id=$2 AND cm.left_at IS NULL \
          WHERE hc.workspace_id=$1 \
            AND hc.status='active' AND hc.proved_at IS NOT NULL \
            AND t.kind='agent_bearer' \
            AND t.credential_class IN ('hosted_active','hosted_oauth_access') \
            AND t.revoked_at IS NULL \
            AND (t.expires_at IS NULL OR t.expires_at > now()) \
            AND t.hosted_connection_id=hc.id AND t.actor_member_id=hc.agent_member_id \
            AND t.audience='/v1/mcp/agent-port' \
            AND 'agent:inbox:read'=ANY(t.scopes) \
            AND 'agent:inbox:read'=ANY(hc.approved_scopes) \
            AND $2=ANY(hc.approved_channel_ids) \
            AND m.kind='agent' AND m.status='active' AND m.deleted_at IS NULL \
            AND ap.paused=false \
          ORDER BY hc.id FOR SHARE OF hc,t,m,wm,ap,cm",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows)
}

/// Project one just-written message onto every hosted connection allowed to see
/// it — **the producer contract for the `message` event kind**.
///
/// Two properties this placement buys, and they are the reason it is a function
/// rather than a call site:
///
/// * **Same transaction as the source write.** A reference can never name a
///   message that failed to commit, and a message can never commit without its
///   references. That is also what closes the tombstone question: a delete is a
///   tombstone rather than a row removal, and the reference is created while the
///   message is still live, so a `RESTRICT` foreign key has nothing to refuse.
/// * **The author never receives its own message.** A hosted agent posting
///   through the Agent Port would otherwise read its own utterance back out of
///   its inbox and answer it.
///
/// Callers are the product send spine
/// ([`crate::send_message_with_mentions_in_tx`]) and the gateway completion,
/// which writes the agent's final answer through the raw spine.
pub async fn fan_out_message_reference_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    message_id: Uuid,
    author_member_id: Uuid,
) -> Result<Vec<(Uuid, i64)>, DbError> {
    let recipients = hosted_inbox_recipients_in_tx(conn, workspace_id, channel_id).await?;
    let mut appended = Vec::new();
    for (agent_member_id, connection_id) in recipients {
        if agent_member_id == author_member_id {
            continue;
        }
        appended.extend(
            append_message_reference_in_tx(
                conn,
                workspace_id,
                agent_member_id,
                connection_id,
                channel_id,
                message_id,
            )
            .await?,
        );
    }
    Ok(appended)
}

/// Append one **job** reference for one authenticated hosted connection.
///
/// `source_outbox_id` and `source_run_id` are the two halves of one piece of
/// work and migration 071 binds them: the outbox FK now carries `kind`, and the
/// job-binding trigger requires the referenced row to be a `gateway` job of
/// this agent whose `payload.run_id` is exactly `run_id`. So a caller that
/// mixed up a wake broadcast, another agent's job, or another run's job cannot
/// commit — the transaction that produced the job dies with it.
#[allow(clippy::too_many_arguments)]
pub async fn append_job_reference_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    connection_id: Uuid,
    channel_id: Uuid,
    source_outbox_id: i64,
    run_id: Uuid,
) -> Result<Option<i64>, DbError> {
    append_reference_in_tx(
        conn,
        workspace_id,
        agent_member_id,
        connection_id,
        channel_id,
        ReferenceSource::Job {
            source_outbox_id,
            run_id,
        },
    )
    .await
}

/// Append one **run** reference for one authenticated hosted connection.
///
/// Used for a run-state mutation the agent did not itself perform — a human
/// cancel is the one this goal wires — so an agent that only reads its inbox
/// still learns that the work it was handed has been withdrawn.
pub async fn append_run_reference_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    connection_id: Uuid,
    channel_id: Uuid,
    run_id: Uuid,
) -> Result<Option<i64>, DbError> {
    append_reference_in_tx(
        conn,
        workspace_id,
        agent_member_id,
        connection_id,
        channel_id,
        ReferenceSource::Run { run_id },
    )
    .await
}

#[derive(Debug, Clone, Copy)]
enum ReferenceSource {
    Job { source_outbox_id: i64, run_id: Uuid },
    Run { run_id: Uuid },
}

impl ReferenceSource {
    fn event_kind(self) -> &'static str {
        match self {
            ReferenceSource::Job { .. } => "agent_job",
            ReferenceSource::Run { .. } => "agent_run",
        }
    }
}

/// The shared body of the job/run appends: same authority predicate, same lock
/// order, same counter discipline and same replay idempotency as
/// [`append_message_reference_in_tx`].
///
/// One connection at a time, by explicit target, for the reason the message
/// append states: a producer must not be able to fan one agent's private work
/// item out to every hosted member of a channel.
async fn append_reference_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    connection_id: Uuid,
    channel_id: Uuid,
    source: ReferenceSource,
) -> Result<Option<i64>, DbError> {
    let authorized: Option<Uuid> = sqlx::query_scalar(
        "SELECT hc.id \
           FROM hosted_agent_connection hc \
           JOIN token t ON t.workspace_id=hc.workspace_id AND t.id=hc.active_token_id \
           JOIN member m ON m.workspace_id=hc.workspace_id AND m.id=hc.agent_member_id \
           JOIN workspace_membership wm \
             ON wm.workspace_id=hc.workspace_id AND wm.member_id=hc.agent_member_id \
           JOIN agent_profile ap \
             ON ap.workspace_id=hc.workspace_id AND ap.agent_member_id=hc.agent_member_id \
           JOIN membership cm \
             ON cm.workspace_id=hc.workspace_id AND cm.member_id=hc.agent_member_id \
            AND cm.channel_id=$2 AND cm.left_at IS NULL \
          WHERE hc.workspace_id=$1 AND hc.agent_member_id=$3 AND hc.id=$4 \
            AND hc.status='active' AND hc.proved_at IS NOT NULL \
            AND t.kind='agent_bearer' \
            AND t.credential_class IN ('hosted_active','hosted_oauth_access') \
            AND t.revoked_at IS NULL \
            AND (t.expires_at IS NULL OR t.expires_at > now()) \
            AND t.hosted_connection_id=hc.id AND t.actor_member_id=hc.agent_member_id \
            AND t.audience='/v1/mcp/agent-port' \
            AND 'agent:inbox:read'=ANY(t.scopes) \
            AND 'agent:inbox:read'=ANY(hc.approved_scopes) \
            AND $2=ANY(hc.approved_channel_ids) \
            AND m.kind='agent' AND m.status='active' AND m.deleted_at IS NULL \
            AND ap.paused=false \
          ORDER BY hc.id FOR SHARE OF hc,t,m,wm,ap,cm",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(agent_member_id)
    .bind(connection_id)
    .fetch_optional(&mut *conn)
    .await?;
    if authorized.is_none() {
        return Ok(None);
    }

    sqlx::query(
        "INSERT INTO hosted_agent_inbox_counter \
           (workspace_id, agent_member_id, connection_id) VALUES ($1,$2,$3) \
         ON CONFLICT (workspace_id, connection_id) DO NOTHING",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .bind(connection_id)
    .execute(&mut *conn)
    .await?;

    let _locked: i64 = sqlx::query_scalar(
        "SELECT last_seq FROM hosted_agent_inbox_counter \
          WHERE workspace_id=$1 AND connection_id=$2 FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .fetch_one(&mut *conn)
    .await?;

    let existing: Option<i64> = match source {
        ReferenceSource::Job {
            source_outbox_id, ..
        } => {
            sqlx::query_scalar(
                "SELECT inbox_seq FROM hosted_agent_inbox_event \
                  WHERE workspace_id=$1 AND connection_id=$2 \
                    AND event_kind='agent_job' AND source_outbox_id=$3",
            )
            .bind(workspace_id)
            .bind(connection_id)
            .bind(source_outbox_id)
            .fetch_optional(&mut *conn)
            .await?
        }
        ReferenceSource::Run { run_id } => {
            sqlx::query_scalar(
                "SELECT inbox_seq FROM hosted_agent_inbox_event \
                  WHERE workspace_id=$1 AND connection_id=$2 \
                    AND event_kind='agent_run' AND source_run_id=$3",
            )
            .bind(workspace_id)
            .bind(connection_id)
            .bind(run_id)
            .fetch_optional(&mut *conn)
            .await?
        }
    };
    if let Some(existing) = existing {
        return Ok(Some(existing));
    }

    let inbox_seq: i64 = sqlx::query_scalar(
        "UPDATE hosted_agent_inbox_counter \
            SET last_seq=last_seq+1, updated_at=now() \
          WHERE workspace_id=$1 AND connection_id=$2 \
          RETURNING last_seq",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .fetch_one(&mut *conn)
    .await?;
    let (source_outbox_id, run_id) = match source {
        ReferenceSource::Job {
            source_outbox_id,
            run_id,
        } => (Some(source_outbox_id), run_id),
        ReferenceSource::Run { run_id } => (None, run_id),
    };
    sqlx::query(
        "INSERT INTO hosted_agent_inbox_event \
           (workspace_id,agent_member_id,connection_id,inbox_seq,event_kind, \
            source_channel_id,source_outbox_id,source_run_id) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .bind(connection_id)
    .bind(inbox_seq)
    .bind(source.event_kind())
    .bind(channel_id)
    .bind(source_outbox_id)
    .bind(run_id)
    .execute(&mut *conn)
    .await?;
    Ok(Some(inbox_seq))
}

#[allow(clippy::too_many_arguments)]
pub async fn list_hosted_inbox_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    connection_id: Uuid,
    cursor: Option<&str>,
    limit: i64,
    cursor_secret: &str,
) -> Result<Result<HostedInboxPage, HostedInboxReadError>, DbError> {
    let position = match cursor {
        Some(raw) => {
            let decoded = match decode_hosted_inbox_cursor(raw, cursor_secret) {
                Ok(decoded) => decoded,
                Err(_) => return Ok(Err(HostedInboxReadError::Unavailable)),
            };
            if decoded.workspace_id != workspace_id
                || decoded.agent_member_id != agent_member_id
                || decoded.connection_id != connection_id
            {
                return Ok(Err(HostedInboxReadError::Unavailable));
            }
            decoded.position
        }
        None => 0,
    };
    let limit = limit.clamp(1, HOSTED_INBOX_LIMIT_MAX);

    // Keep the authority rows share-locked until the caller-owned transaction
    // completes. Lifecycle revoke/disconnect, membership removal, and pause
    // updates must therefore serialize before or after this page read rather
    // than between the authority check and the event query.
    let approved_channels: Option<Vec<Uuid>> = sqlx::query_scalar(
        "SELECT hc.approved_channel_ids \
           FROM hosted_agent_connection hc \
           JOIN token t ON t.workspace_id=hc.workspace_id AND t.id=hc.active_token_id \
           JOIN member m ON m.workspace_id=hc.workspace_id AND m.id=hc.agent_member_id \
           JOIN workspace_membership wm \
             ON wm.workspace_id=hc.workspace_id AND wm.member_id=hc.agent_member_id \
           JOIN agent_profile ap \
             ON ap.workspace_id=hc.workspace_id AND ap.agent_member_id=hc.agent_member_id \
          WHERE hc.workspace_id=$1 AND hc.id=$2 AND hc.agent_member_id=$3 \
            AND hc.status='active' AND hc.proved_at IS NOT NULL \
            AND t.kind='agent_bearer' \
            AND t.credential_class IN ('hosted_active','hosted_oauth_access') \
            AND t.revoked_at IS NULL \
            AND (t.expires_at IS NULL OR t.expires_at > now()) \
            AND t.hosted_connection_id=hc.id AND t.actor_member_id=hc.agent_member_id \
            AND t.audience='/v1/mcp/agent-port' \
            AND 'agent:inbox:read'=ANY(t.scopes) \
            AND 'agent:inbox:read'=ANY(hc.approved_scopes) \
            AND m.kind='agent' AND m.status='active' AND m.deleted_at IS NULL \
            AND ap.paused=false \
          FOR SHARE OF hc,t,m,wm,ap",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .bind(agent_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(approved_channels) = approved_channels else {
        return Ok(Err(HostedInboxReadError::Unavailable));
    };

    // Lock the currently approved live channel memberships as part of the
    // same authority snapshot. A concurrent membership removal must finish
    // before this page or wait until after it; it cannot commit between the
    // visibility decision and event projection.
    let _locked_channel_memberships: Vec<Uuid> = sqlx::query_scalar(
        "SELECT cm.channel_id FROM membership cm \
          WHERE cm.workspace_id=$1 AND cm.member_id=$2 \
            AND cm.channel_id=ANY($3) AND cm.left_at IS NULL \
          ORDER BY cm.channel_id FOR SHARE",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .bind(&approved_channels)
    .fetch_all(&mut *conn)
    .await?;

    let rows = sqlx::query(
        "SELECT e.inbox_seq,e.event_kind,e.source_message_id,e.source_channel_id, \
                e.source_message_seq,e.source_outbox_id,e.source_run_id, \
                (e.source_channel_id=ANY($6) AND EXISTS ( \
                  SELECT 1 FROM membership visible \
                   WHERE visible.workspace_id=e.workspace_id \
                     AND visible.channel_id=e.source_channel_id \
                     AND visible.member_id=e.agent_member_id \
                     AND visible.left_at IS NULL)) AS visible \
           FROM hosted_agent_inbox_event e \
          WHERE e.workspace_id=$1 AND e.connection_id=$2 AND e.agent_member_id=$3 \
            AND e.inbox_seq > $4 \
          ORDER BY e.inbox_seq ASC LIMIT $5",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .bind(agent_member_id)
    .bind(position)
    .bind(limit + 1)
    .bind(approved_channels)
    .fetch_all(&mut *conn)
    .await?;

    let has_more = rows.len() > limit as usize;
    let scanned = rows.into_iter().take(limit as usize).collect::<Vec<_>>();
    // Cursor position follows the scanned connection-local ledger, not the
    // last currently visible item. A hidden-only tail is skipped exactly once
    // and cannot reappear merely because membership is restored later.
    let next_position = scanned
        .last()
        .map_or(position, |row| row.get::<i64, _>("inbox_seq"));
    let events: Vec<HostedInboxEvent> = scanned
        .into_iter()
        .filter(|row| row.get::<bool, _>("visible"))
        .map(|row| HostedInboxEvent {
            inbox_seq: row.get("inbox_seq"),
            event_kind: row.get("event_kind"),
            source_message_id: row.get("source_message_id"),
            source_channel_id: row.get("source_channel_id"),
            source_message_seq: row.get("source_message_seq"),
            source_outbox_id: row.get("source_outbox_id"),
            source_run_id: row.get("source_run_id"),
            channel_id: row.get("source_channel_id"),
        })
        .collect();
    let next_cursor = encode_hosted_inbox_cursor(
        HostedInboxCursor {
            workspace_id,
            agent_member_id,
            connection_id,
            position: next_position,
        },
        cursor_secret,
    )
    .map_err(|_| DbError::Sqlx(sqlx::Error::Protocol("cursor issuance failed".into())))?;

    Ok(Ok(HostedInboxPage {
        events,
        next_cursor,
        has_more,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> HostedInboxCursor {
        HostedInboxCursor {
            workspace_id: Uuid::new_v4(),
            agent_member_id: Uuid::new_v4(),
            connection_id: Uuid::new_v4(),
            // Every byte distinct and non-zero, so the leak scan below is
            // searching for a sequence that carries real information rather
            // than for a run of padding zeros that any buffer might contain.
            position: 0x1122_3344_5566_7788,
        }
    }

    /// Whether `haystack` contains `needle` anywhere.
    fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
        needle.len() <= haystack.len()
            && haystack
                .windows(needle.len())
                .any(|window| window == needle)
    }

    /// **The confidentiality canary, measured in the right units.**
    ///
    /// This assertion used to read `!encoded.contains("42")` — a two-character
    /// substring searched for in the *base64 text* of random-nonce ciphertext.
    /// That is a coin flip, not a check: roughly 3% of runs contain `"42"` by
    /// chance, and CI duly hit one. The property it was reaching for is real,
    /// so it is kept and stated over the bytes that actually carry the secret:
    /// none of the four plaintext fields appears anywhere in the sealed
    /// envelope, in either endianness.
    ///
    /// The false-positive probability is now negligible rather than 3%: a
    /// specific 16-byte sequence appearing in an 89-byte envelope is about
    /// 2^-121, and the 8-byte position about 2^-58. A failure here is a leak,
    /// not luck.
    #[test]
    fn cursor_round_trips_without_exposing_plaintext_ids() {
        let cursor = sample();
        let encoded = encode_hosted_inbox_cursor(cursor, "cursor-secret").unwrap();
        assert_eq!(
            decode_hosted_inbox_cursor(&encoded, "cursor-secret"),
            Ok(cursor)
        );
        // A 36-character uuid rendering is its own negligible-collision check.
        assert!(!encoded.contains(&cursor.workspace_id.to_string()));

        let envelope = URL_SAFE_NO_PAD
            .decode(
                encoded
                    .strip_prefix(CURSOR_PREFIX)
                    .expect("the cursor carries its version prefix"),
            )
            .expect("the body is base64url");
        assert_eq!(envelope.len(), CURSOR_ENVELOPE_BYTES);
        for (field, plaintext) in [
            ("workspace_id", cursor.workspace_id.as_bytes().to_vec()),
            (
                "agent_member_id",
                cursor.agent_member_id.as_bytes().to_vec(),
            ),
            ("connection_id", cursor.connection_id.as_bytes().to_vec()),
            ("position(be)", cursor.position.to_be_bytes().to_vec()),
            ("position(le)", cursor.position.to_le_bytes().to_vec()),
        ] {
            assert!(
                !contains_bytes(&envelope, &plaintext),
                "{field} appears verbatim inside the sealed cursor"
            );
        }

        // Nonce freshness: sealing the same cursor twice must not produce the
        // same envelope, or the opaque token would become a stable fingerprint
        // of the connection that holds it.
        let again = encode_hosted_inbox_cursor(cursor, "cursor-secret").unwrap();
        assert_ne!(encoded, again);
        assert_eq!(
            decode_hosted_inbox_cursor(&again, "cursor-secret"),
            Ok(cursor)
        );
    }

    #[test]
    fn cursor_is_bound_to_ciphertext_and_key() {
        let cursor = sample();
        let encoded = encode_hosted_inbox_cursor(cursor, "cursor-secret").unwrap();
        assert_eq!(
            decode_hosted_inbox_cursor(&encoded, "wrong-secret"),
            Err(HostedInboxCursorError::Invalid)
        );
        let mut bytes = encoded.into_bytes();
        let last = bytes.len() - 1;
        bytes[last] = if bytes[last] == b'A' { b'B' } else { b'A' };
        let tampered = String::from_utf8(bytes).unwrap();
        assert_eq!(
            decode_hosted_inbox_cursor(&tampered, "cursor-secret"),
            Err(HostedInboxCursorError::Invalid)
        );
    }

    #[test]
    fn cursor_rejects_empty_secret_and_negative_position() {
        let mut cursor = sample();
        cursor.position = -1;
        assert_eq!(
            encode_hosted_inbox_cursor(cursor, "cursor-secret"),
            Err(HostedInboxCursorError::Invalid)
        );
        assert_eq!(
            decode_hosted_inbox_cursor("momo_inbox_cursor_v1.AA", ""),
            Err(HostedInboxCursorError::Invalid)
        );
    }
}
