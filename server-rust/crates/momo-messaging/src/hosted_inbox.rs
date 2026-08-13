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
    #[error("invalid hosted inbox cursor")]
    InvalidCursor,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedInboxEvent {
    pub inbox_seq: i64,
    pub event_kind: String,
    pub source_message_id: Option<Uuid>,
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

/// Append one message reference to every currently active hosted connection
/// that can see its channel. Connections are processed in UUID order so two
/// transactions touching the same audience acquire counter locks consistently.
/// Replaying the same source is idempotent and consumes no new sequence.
pub async fn append_message_reference_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    message_id: Uuid,
) -> Result<Vec<(Uuid, i64)>, DbError> {
    let recipients: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT hc.id, hc.agent_member_id \
           FROM hosted_agent_connection hc \
           JOIN token t ON t.workspace_id=hc.workspace_id AND t.id=hc.active_token_id \
           JOIN member m ON m.workspace_id=hc.workspace_id AND m.id=hc.agent_member_id \
           JOIN workspace_membership wm \
             ON wm.workspace_id=hc.workspace_id AND wm.member_id=hc.agent_member_id \
           JOIN membership cm \
             ON cm.workspace_id=hc.workspace_id AND cm.member_id=hc.agent_member_id \
            AND cm.channel_id=$2 AND cm.left_at IS NULL \
          WHERE hc.workspace_id=$1 AND hc.status='active' AND hc.proved_at IS NOT NULL \
            AND t.credential_class='hosted_active' AND t.revoked_at IS NULL \
            AND (t.expires_at IS NULL OR t.expires_at > now()) \
            AND m.kind='agent' AND m.status='active' AND m.deleted_at IS NULL \
          ORDER BY hc.id FOR KEY SHARE OF hc,t,m,wm,cm",
    )
    .bind(workspace_id)
    .bind(channel_id)
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
               (workspace_id,agent_member_id,connection_id,inbox_seq,event_kind,source_message_id) \
             VALUES ($1,$2,$3,$4,'message',$5)",
        )
        .bind(workspace_id)
        .bind(agent_member_id)
        .bind(connection_id)
        .bind(inbox_seq)
        .bind(message_id)
        .execute(&mut *conn)
        .await?;
        appended.push((connection_id, inbox_seq));
    }
    Ok(appended)
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
                Err(_) => return Ok(Err(HostedInboxReadError::InvalidCursor)),
            };
            if decoded.workspace_id != workspace_id
                || decoded.agent_member_id != agent_member_id
                || decoded.connection_id != connection_id
            {
                return Ok(Err(HostedInboxReadError::InvalidCursor));
            }
            decoded.position
        }
        None => 0,
    };
    let limit = limit.clamp(1, HOSTED_INBOX_LIMIT_MAX);

    let available: Option<i32> = sqlx::query_scalar(
        "SELECT 1 \
           FROM hosted_agent_connection hc \
           JOIN token t ON t.workspace_id=hc.workspace_id AND t.id=hc.active_token_id \
           JOIN member m ON m.workspace_id=hc.workspace_id AND m.id=hc.agent_member_id \
           JOIN workspace_membership wm \
             ON wm.workspace_id=hc.workspace_id AND wm.member_id=hc.agent_member_id \
          WHERE hc.workspace_id=$1 AND hc.id=$2 AND hc.agent_member_id=$3 \
            AND hc.status='active' AND hc.proved_at IS NOT NULL \
            AND t.credential_class='hosted_active' AND t.revoked_at IS NULL \
            AND (t.expires_at IS NULL OR t.expires_at > now()) \
            AND m.kind='agent' AND m.status='active' AND m.deleted_at IS NULL",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .bind(agent_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    if available.is_none() {
        return Ok(Err(HostedInboxReadError::Unavailable));
    }

    let rows = sqlx::query(
        "SELECT e.inbox_seq,e.event_kind,e.source_message_id,e.source_outbox_id, \
                e.source_run_id,m.channel_id \
           FROM hosted_agent_inbox_event e \
           LEFT JOIN message m ON m.workspace_id=e.workspace_id AND m.id=e.source_message_id \
          WHERE e.workspace_id=$1 AND e.connection_id=$2 AND e.agent_member_id=$3 \
            AND e.inbox_seq > $4 \
            AND (e.event_kind <> 'message' OR EXISTS ( \
                  SELECT 1 FROM membership visible \
                   WHERE visible.workspace_id=e.workspace_id \
                     AND visible.channel_id=m.channel_id \
                     AND visible.member_id=e.agent_member_id \
                     AND visible.left_at IS NULL)) \
          ORDER BY e.inbox_seq ASC LIMIT $5",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .bind(agent_member_id)
    .bind(position)
    .bind(limit + 1)
    .fetch_all(&mut *conn)
    .await?;

    let has_more = rows.len() > limit as usize;
    let events: Vec<HostedInboxEvent> = rows
        .into_iter()
        .take(limit as usize)
        .map(|row| HostedInboxEvent {
            inbox_seq: row.get("inbox_seq"),
            event_kind: row.get("event_kind"),
            source_message_id: row.get("source_message_id"),
            source_outbox_id: row.get("source_outbox_id"),
            source_run_id: row.get("source_run_id"),
            channel_id: row.get("channel_id"),
        })
        .collect();
    let next_position = events.last().map_or(position, |event| event.inbox_seq);
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
            position: 42,
        }
    }

    #[test]
    fn cursor_round_trips_without_exposing_plaintext_ids() {
        let cursor = sample();
        let encoded = encode_hosted_inbox_cursor(cursor, "cursor-secret").unwrap();
        assert_eq!(
            decode_hosted_inbox_cursor(&encoded, "cursor-secret"),
            Ok(cursor)
        );
        assert!(!encoded.contains(&cursor.workspace_id.to_string()));
        assert!(!encoded.contains("42"));
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
