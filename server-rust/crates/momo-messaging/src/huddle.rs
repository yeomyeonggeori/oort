//! Voice huddle lifecycle and LiveKit grants (ADR-0122 / HD-1).
//!
//! PostgreSQL is the lifecycle source of truth. Every start/join/leave mutation,
//! its audit row, and its broadcast outbox row share one tenant transaction.
//! This module never contacts LiveKit or Centrifugo: the API's isolated token
//! issuer constructs the grant, and the existing relay is the sole durable
//! broadcast publisher.

use chrono::Utc;
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{with_tenant_tx_prelude, DbError, PgConnection, PgPool};
use momo_outbox::{emit_outbox, OutboxKind};
use momo_wire::payload::BroadcastPayload;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::cent_channel;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HuddleActor {
    pub member_id: Uuid,
    pub via_token_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HuddleParticipant {
    pub member_id: Uuid,
    pub display_name: String,
    pub joined_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Huddle {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub channel_id: Uuid,
    pub started_by: Uuid,
    pub started_at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at_ms: Option<i64>,
    pub participants: Vec<HuddleParticipant>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartHuddleOutcome {
    pub huddle: Huddle,
    pub created: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JoinHuddleOutcome<T> {
    pub huddle: Huddle,
    pub grant: T,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeaveHuddleOutcome {
    pub huddle: Huddle,
    pub ended: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum HuddleError {
    #[error(transparent)]
    Db(#[from] DbError),
    #[error("active channel membership required")]
    ActiveChannelMembershipRequired,
    #[error("active huddle changed concurrently — retry")]
    ActiveHuddleChanged,
    #[error("huddle has ended")]
    HuddleEnded,
    #[error("recording consent is required before joining this recorded huddle")]
    RecordingConsentRequired,
    #[error("member is not in this huddle")]
    MemberNotPresent,
    #[error("huddle response encoding failed")]
    ResponseEncoding,
    #[error("LiveKit grant encoding failed")]
    GrantEncoding,
}

impl From<sqlx::Error> for HuddleError {
    fn from(error: sqlx::Error) -> Self {
        HuddleError::Db(DbError::from(error))
    }
}

type HuddleFuture<'a, T> =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<T, HuddleError>> + Send + 'a>>;

async fn tenant_tx<T, F>(pool: &PgPool, workspace_id: Uuid, body: F) -> Result<T, HuddleError>
where
    T: Send,
    F: for<'c> FnOnce(&'c mut PgConnection) -> HuddleFuture<'c, T> + Send,
{
    with_tenant_tx_prelude(
        pool,
        workspace_id,
        |_conn| Box::pin(async { Ok(()) }),
        |_conn| Box::pin(async { Ok(()) }),
        body,
    )
    .await
}

pub async fn start_huddle(
    pool: &PgPool,
    workspace_id: Uuid,
    channel_id: Uuid,
    actor: HuddleActor,
) -> Result<StartHuddleOutcome, HuddleError> {
    tenant_tx(pool, workspace_id, move |conn| {
        Box::pin(async move {
            require_channel_member(conn, workspace_id, channel_id, actor.member_id).await?;
            let inserted: Option<Uuid> = sqlx::query_scalar(
                "INSERT INTO huddle (workspace_id, channel_id, started_by) \
                 VALUES ($1, $2, $3) \
                 ON CONFLICT (channel_id) WHERE ended_at IS NULL DO NOTHING \
                 RETURNING id",
            )
            .bind(workspace_id)
            .bind(channel_id)
            .bind(actor.member_id)
            .fetch_optional(&mut *conn)
            .await?;
            let created = inserted.is_some();
            let huddle_id = match inserted {
                Some(id) => id,
                None => sqlx::query_scalar(
                    "SELECT id FROM huddle WHERE channel_id = $1 AND ended_at IS NULL",
                )
                .bind(channel_id)
                .fetch_optional(&mut *conn)
                .await?
                .ok_or(HuddleError::ActiveHuddleChanged)?,
            };

            if created {
                emit_huddle_event(
                    conn,
                    workspace_id,
                    channel_id,
                    huddle_id,
                    "huddle_started",
                    &[],
                )
                .await?;
                write_huddle_audit(
                    conn,
                    workspace_id,
                    actor,
                    "huddle.started",
                    "momo.huddle.started.v1",
                    channel_id,
                    huddle_id,
                    json!({}),
                )
                .await?;
            }
            Ok(StartHuddleOutcome {
                huddle: load_huddle(conn, huddle_id).await?,
                created,
            })
        })
    })
    .await
}

pub async fn join_huddle<T, F>(
    pool: &PgPool,
    workspace_id: Uuid,
    huddle_id: Uuid,
    actor: HuddleActor,
    issue_grant: F,
) -> Result<JoinHuddleOutcome<T>, HuddleError>
where
    T: Send,
    F: FnOnce(Uuid, Uuid, &str) -> Result<T, HuddleError> + Send + 'static,
{
    tenant_tx(pool, workspace_id, move |conn| {
        Box::pin(async move {
            let scope =
                lock_huddle_for_member(conn, workspace_id, huddle_id, actor.member_id).await?;
            if scope.ended {
                return Err(HuddleError::HuddleEnded);
            }
            let recording_active: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM huddle_recording \
                  WHERE huddle_id = $1 AND status IN ('requested','recording'))",
            )
            .bind(huddle_id)
            .fetch_one(&mut *conn)
            .await?;
            if recording_active {
                let consented: bool = sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM huddle_recording_consent \
                      WHERE huddle_id = $1 AND member_id = $2)",
                )
                .bind(huddle_id)
                .bind(actor.member_id)
                .fetch_one(&mut *conn)
                .await?;
                if !consented {
                    return Err(HuddleError::RecordingConsentRequired);
                }
            }

            let inserted: Option<i64> = sqlx::query_scalar(
                "INSERT INTO huddle_participant (workspace_id, huddle_id, member_id) \
                 VALUES ($1, $2, $3) \
                 ON CONFLICT (huddle_id, member_id) WHERE left_at IS NULL DO NOTHING \
                 RETURNING floor(extract(epoch from joined_at) * 1000)::bigint",
            )
            .bind(workspace_id)
            .bind(huddle_id)
            .bind(actor.member_id)
            .fetch_optional(&mut *conn)
            .await?;
            if inserted.is_some() {
                let participant_ids = active_participant_ids(conn, huddle_id).await?;
                emit_huddle_event(
                    conn,
                    workspace_id,
                    scope.channel_id,
                    huddle_id,
                    "huddle_participants_changed",
                    &participant_ids,
                )
                .await?;
            }
            write_huddle_audit(
                conn,
                workspace_id,
                actor,
                "huddle.joined",
                "momo.huddle.joined.v1",
                scope.channel_id,
                huddle_id,
                json!({"participant_created": inserted.is_some()}),
            )
            .await?;
            let grant = issue_grant(huddle_id, actor.member_id, &scope.display_name)?;
            Ok(JoinHuddleOutcome {
                huddle: load_huddle(conn, huddle_id).await?,
                grant,
            })
        })
    })
    .await
}

pub async fn leave_huddle(
    pool: &PgPool,
    workspace_id: Uuid,
    huddle_id: Uuid,
    actor: HuddleActor,
) -> Result<LeaveHuddleOutcome, HuddleError> {
    tenant_tx(pool, workspace_id, move |conn| {
        Box::pin(async move {
            let scope =
                lock_huddle_for_member(conn, workspace_id, huddle_id, actor.member_id).await?;
            if scope.ended {
                return Ok(LeaveHuddleOutcome {
                    huddle: load_huddle(conn, huddle_id).await?,
                    ended: true,
                });
            }
            let left: Option<i64> = sqlx::query_scalar(
                "UPDATE huddle_participant SET left_at = now() \
                  WHERE huddle_id = $1 AND member_id = $2 AND left_at IS NULL \
                  RETURNING floor(extract(epoch from joined_at) * 1000)::bigint",
            )
            .bind(huddle_id)
            .bind(actor.member_id)
            .fetch_optional(&mut *conn)
            .await?;
            if left.is_none() {
                return Err(HuddleError::MemberNotPresent);
            }

            let participant_ids = active_participant_ids(conn, huddle_id).await?;
            let ended = participant_ids.is_empty();
            if ended {
                sqlx::query(
                    "UPDATE huddle SET ended_at = now() WHERE id = $1 AND ended_at IS NULL",
                )
                .bind(huddle_id)
                .execute(&mut *conn)
                .await?;
                enqueue_transcription_if_recording_ended(
                    conn,
                    workspace_id,
                    huddle_id,
                    scope.channel_id,
                )
                .await?;
            }
            emit_huddle_event(
                conn,
                workspace_id,
                scope.channel_id,
                huddle_id,
                if ended {
                    "huddle_ended"
                } else {
                    "huddle_participants_changed"
                },
                &participant_ids,
            )
            .await?;
            write_huddle_audit(
                conn,
                workspace_id,
                actor,
                "huddle.left",
                "momo.huddle.left.v1",
                scope.channel_id,
                huddle_id,
                json!({"ended": ended}),
            )
            .await?;
            Ok(LeaveHuddleOutcome {
                huddle: load_huddle(conn, huddle_id).await?,
                ended,
            })
        })
    })
    .await
}

pub async fn active_huddle(
    pool: &PgPool,
    workspace_id: Uuid,
    channel_id: Uuid,
    member_id: Uuid,
) -> Result<Option<Huddle>, HuddleError> {
    tenant_tx(pool, workspace_id, move |conn| {
        Box::pin(async move {
            require_channel_member(conn, workspace_id, channel_id, member_id).await?;
            let huddle_id: Option<Uuid> = sqlx::query_scalar(
                "SELECT id FROM huddle WHERE channel_id = $1 AND ended_at IS NULL",
            )
            .bind(channel_id)
            .fetch_optional(&mut *conn)
            .await?;
            match huddle_id {
                Some(id) => Ok(Some(load_huddle(conn, id).await?)),
                None => Ok(None),
            }
        })
    })
    .await
}

async fn require_channel_member(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    member_id: Uuid,
) -> Result<(), HuddleError> {
    let allowed: bool = sqlx::query_scalar(
        "SELECT EXISTS ( \
           SELECT 1 FROM channel c \
           JOIN membership ms ON ms.channel_id = c.id \
             AND ms.member_id = $3 AND ms.left_at IS NULL \
           JOIN member m ON m.id = ms.member_id \
             AND m.workspace_id = c.workspace_id \
             AND m.status = 'active' AND m.deleted_at IS NULL \
          WHERE c.id = $2 AND c.workspace_id = $1 AND c.archived_at IS NULL)",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(member_id)
    .fetch_one(&mut *conn)
    .await?;
    if allowed {
        Ok(())
    } else {
        Err(HuddleError::ActiveChannelMembershipRequired)
    }
}

struct HuddleScope {
    channel_id: Uuid,
    display_name: String,
    ended: bool,
}

async fn lock_huddle_for_member(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    huddle_id: Uuid,
    member_id: Uuid,
) -> Result<HuddleScope, HuddleError> {
    let row = sqlx::query(
        "SELECT h.channel_id, m.display_name, h.ended_at IS NOT NULL AS ended \
           FROM huddle h \
           JOIN membership ms ON ms.channel_id = h.channel_id \
             AND ms.member_id = $3 AND ms.left_at IS NULL \
           JOIN member m ON m.id = ms.member_id \
             AND m.workspace_id = h.workspace_id \
             AND m.status = 'active' AND m.deleted_at IS NULL \
          WHERE h.id = $2 AND h.workspace_id = $1 \
          FOR UPDATE OF h",
    )
    .bind(workspace_id)
    .bind(huddle_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else {
        return Err(HuddleError::ActiveChannelMembershipRequired);
    };
    Ok(HuddleScope {
        channel_id: row.try_get("channel_id")?,
        display_name: row.try_get("display_name")?,
        ended: row.try_get("ended")?,
    })
}

async fn active_participant_ids(
    conn: &mut PgConnection,
    huddle_id: Uuid,
) -> Result<Vec<Uuid>, HuddleError> {
    Ok(sqlx::query_scalar(
        "SELECT member_id FROM huddle_participant \
          WHERE huddle_id = $1 AND left_at IS NULL ORDER BY joined_at",
    )
    .bind(huddle_id)
    .fetch_all(&mut *conn)
    .await?)
}

async fn load_huddle(conn: &mut PgConnection, huddle_id: Uuid) -> Result<Huddle, HuddleError> {
    let row = sqlx::query(
        "SELECT id, workspace_id, channel_id, started_by, \
                floor(extract(epoch from started_at) * 1000)::bigint AS started_at_ms, \
                CASE WHEN ended_at IS NULL THEN NULL \
                     ELSE floor(extract(epoch from ended_at) * 1000)::bigint END AS ended_at_ms \
           FROM huddle WHERE id = $1",
    )
    .bind(huddle_id)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or(HuddleError::ResponseEncoding)?;
    let participants = sqlx::query(
        "SELECT hp.member_id, m.display_name, \
                floor(extract(epoch from hp.joined_at) * 1000)::bigint AS joined_at_ms \
           FROM huddle_participant hp \
           JOIN member m ON m.id = hp.member_id \
          WHERE hp.huddle_id = $1 AND hp.left_at IS NULL \
          ORDER BY hp.joined_at",
    )
    .bind(huddle_id)
    .fetch_all(&mut *conn)
    .await?
    .into_iter()
    .map(|row| {
        Ok(HuddleParticipant {
            member_id: row.try_get("member_id")?,
            display_name: row.try_get("display_name")?,
            joined_at_ms: row.try_get("joined_at_ms")?,
        })
    })
    .collect::<Result<Vec<_>, HuddleError>>()?;
    Ok(Huddle {
        id: row.try_get("id")?,
        workspace_id: row.try_get("workspace_id")?,
        channel_id: row.try_get("channel_id")?,
        started_by: row.try_get("started_by")?,
        started_at_ms: row.try_get("started_at_ms")?,
        ended_at_ms: row.try_get("ended_at_ms")?,
        participants,
    })
}

async fn enqueue_transcription_if_recording_ended(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    huddle_id: Uuid,
    channel_id: Uuid,
) -> Result<(), HuddleError> {
    sqlx::query(
        "WITH stopped AS ( \
           UPDATE huddle_recording SET status = 'stopped', stopped_at = now() \
            WHERE huddle_id = $2 AND status IN ('requested','recording') \
            RETURNING id, model) \
         INSERT INTO huddle_transcription_job \
           (workspace_id, huddle_id, recording_id, channel_id, model, status) \
         SELECT $1, $2, stopped.id, $3, stopped.model, 'queued' \
           FROM stopped ON CONFLICT (recording_id) DO NOTHING",
    )
    .bind(workspace_id)
    .bind(huddle_id)
    .bind(channel_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

async fn emit_huddle_event(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    huddle_id: Uuid,
    event_type: &str,
    participant_member_ids: &[Uuid],
) -> Result<(), HuddleError> {
    let timestamp_ms = Utc::now().timestamp_millis();
    let data = json!({
        "type": event_type,
        "v": 1,
        "ts": timestamp_ms,
        "payload": {
            "huddle_id": huddle_id.to_string().to_uppercase(),
            "channel_id": channel_id.to_string().to_uppercase(),
            "participant_member_ids": participant_member_ids
                .iter()
                .map(|id| id.to_string().to_uppercase())
                .collect::<Vec<_>>(),
        },
    });
    let envelope = BroadcastPayload {
        channel: cent_channel(workspace_id, channel_id),
        data,
        version: None,
        idempotency_key: Some(format!(
            "huddle:{}",
            Uuid::new_v4().to_string().to_uppercase()
        )),
    };
    let payload = serde_json::to_value(envelope).map_err(|_| HuddleError::ResponseEncoding)?;
    emit_outbox(
        &mut *conn,
        workspace_id,
        OutboxKind::Broadcast,
        "publish",
        &payload,
        Some(channel_id),
    )
    .await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn write_huddle_audit(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    actor: HuddleActor,
    action: &str,
    schema: &str,
    channel_id: Uuid,
    huddle_id: Uuid,
    extra: Value,
) -> Result<(), HuddleError> {
    let mut detail = extra.as_object().cloned().unwrap_or_default();
    detail.insert(
        "channel_id".into(),
        Value::String(channel_id.to_string().to_uppercase()),
    );
    let mut entry = AuditEntry::new(workspace_id, action)
        .target("huddle", huddle_id)
        .via_token(actor.via_token_id)
        .with_schema(schema, Value::Object(detail));
    entry.actor_member_id = Some(actor.member_id);
    write_audit(conn, &entry).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn huddle_wire_uses_camel_case_and_omits_an_unset_end_time() {
        let huddle = Huddle {
            id: Uuid::from_u128(1),
            workspace_id: Uuid::from_u128(2),
            channel_id: Uuid::from_u128(3),
            started_by: Uuid::from_u128(4),
            started_at_ms: 5,
            ended_at_ms: None,
            participants: vec![],
        };
        let value = serde_json::to_value(huddle).expect("serialize huddle");
        assert_eq!(value["workspaceId"], json!(Uuid::from_u128(2)));
        assert_eq!(value["startedAtMs"], json!(5));
        assert!(value.get("endedAtMs").is_none());
        assert!(value.get("workspace_id").is_none());
    }

    #[test]
    fn huddle_event_has_no_centrifugo_version_and_keeps_swift_uuid_case() {
        let workspace = Uuid::parse_str("00000000-0000-7000-8000-000000000001").unwrap();
        let channel = Uuid::parse_str("00000000-0000-7000-8000-000000000abc").unwrap();
        let participant = Uuid::parse_str("00000000-0000-7000-8000-000000000def").unwrap();
        let data = json!({
            "huddle_id": channel.to_string().to_uppercase(),
            "participant_member_ids": [participant.to_string().to_uppercase()],
        });
        let envelope = BroadcastPayload {
            channel: cent_channel(workspace, channel),
            data,
            version: None,
            idempotency_key: Some("huddle:test".into()),
        };
        let value = serde_json::to_value(envelope).unwrap();
        assert!(value.get("version").is_none());
        assert_eq!(
            value["data"]["participant_member_ids"][0],
            json!("00000000-0000-7000-8000-000000000DEF")
        );
    }
}
