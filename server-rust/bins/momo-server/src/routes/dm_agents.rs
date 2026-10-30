//! ADR-0217: server-raised approval cards; every other human decides their own.
use super::agent_mentions::MentionSend;
use crate::{error::ApiError, AppState};
use axum::{
    extract::{Path, State},
    Extension, Json,
};
use chrono::Utc;
use momo_agent::{
    actions::{action_by_id, action_row, workspace_action_payload, ACTION_DM_AGENT_ADMIT},
    approval::LockedApproval,
    MentionCandidate,
};
use momo_auth::{Principal, PrincipalKind};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::sqlx::{self, Row};
use momo_db::{DbError, PgConnection};
use momo_messaging::{send_message_in_tx, MessageType, NewMessage};
use serde_json::{json, Value};
use uuid::Uuid;

pub(crate) const ORIGIN: &str = "dm_agent_admission";
pub(crate) fn is_admission(payload: &Value) -> bool {
    payload["origin"] == ORIGIN && payload["action"]["id"] == ACTION_DM_AGENT_ADMIT
}

async fn humans(conn: &mut PgConnection, ws: Uuid, channel: Uuid) -> Result<Vec<Uuid>, DbError> {
    Ok(sqlx::query_scalar("SELECT m.id FROM membership ms JOIN member m ON m.workspace_id = ms.workspace_id AND m.id = ms.member_id WHERE ms.workspace_id = $1 AND ms.channel_id = $2 AND ms.left_at IS NULL AND m.kind = 'human' AND m.status = 'active' AND m.deleted_at IS NULL ORDER BY m.id FOR SHARE OF ms, m")
        .bind(ws).bind(channel).fetch_all(conn).await?)
}

// All admission/removal/vote writes serialize with the message spine, before
// recording the cutover seq. No timestamp guessed by a client is authoritative.
async fn lock_room(conn: &mut PgConnection, ws: Uuid, channel: Uuid) -> Result<bool, DbError> {
    Ok(sqlx::query_scalar::<_, Uuid>("SELECT cs.channel_id FROM channel_seq cs JOIN channel c ON c.id = cs.channel_id WHERE c.workspace_id = $1 AND c.id = $2 AND c.kind = 'dm' AND c.archived_at IS NULL FOR UPDATE OF cs")
        .bind(ws).bind(channel).fetch_optional(conn).await?.is_some())
}

pub(crate) async fn propose_in_tx(
    conn: &mut PgConnection,
    send: &MentionSend<'_>,
    agent: &MentionCandidate,
) -> Result<bool, DbError> {
    if !send.author_is_human || send.author_is_agent || agent.is_channel_member {
        return Ok(false);
    }
    let mut seated = agent.clone();
    seated.is_channel_member = true;
    seated.hosted_channel_approved = true;
    if !super::agent_mentions::dm_admission_invocable(&seated, send) {
        return Ok(false);
    }
    if !lock_room(conn, send.workspace_id, send.channel_id).await? {
        return Ok(false);
    }
    let people = humans(conn, send.workspace_id, send.channel_id).await?;
    if people.len() < 2 || !people.contains(&send.author_member_id) {
        return Ok(false);
    }
    let pending: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM dm_agent_admission d WHERE d.workspace_id = $1 AND d.channel_id = $2 AND d.agent_member_id = $3 AND d.admitted_at IS NULL AND d.revoked_at IS NULL AND d.expires_at > now() AND NOT EXISTS (SELECT 1 FROM approval a WHERE a.payload->>'dm_admission_id' = d.id::text AND a.status IN ('rejected','expired','cancelled')))")
        .bind(send.workspace_id).bind(send.channel_id).bind(agent.member_id).fetch_one(&mut *conn).await?;
    if pending {
        return Ok(true);
    }
    let required: Vec<Uuid> = people
        .into_iter()
        .filter(|id| *id != send.author_member_id)
        .collect();
    let id = Uuid::new_v4();
    let expires = Utc::now() + chrono::Duration::minutes(15);
    sqlx::query("INSERT INTO dm_agent_admission (id, workspace_id, channel_id, agent_member_id, requested_by, trigger_message_id, required_human_ids, connection_id, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)")
        .bind(id).bind(send.workspace_id).bind(send.channel_id).bind(agent.member_id).bind(send.author_member_id).bind(send.message_id).bind(&required).bind(agent.hosted_active_connection_id).bind(expires).execute(&mut *conn).await?;
    let mut held_input = json!({"hold":"channel_grant", "dm_admission_id": id});
    if let Some(routing) = send
        .routing
        .and_then(momo_agent::RequestedRouting::json_value)
    {
        held_input["routing"] = routing;
    }
    let held = momo_agent::create_held_agent_run_in_tx(
        conn,
        send.workspace_id,
        momo_agent::NewAgentRun {
            channel_id: send.channel_id,
            trigger: momo_agent::RunTrigger::Work {
                channel_id: send.channel_id,
                actor_member_id: send.author_member_id,
                agent_member_id: agent.member_id,
                client_run_id: id,
            },
            parent_run_id: None,
            max_steps: agent.max_run_steps,
            depth: 0,
            input: held_input,
        },
        expires,
    )
    .await?;
    let action = action_by_id(ACTION_DM_AGENT_ADMIT).expect("registered admission action");
    for person in required {
        let mut payload = workspace_action_payload(
            ACTION_DM_AGENT_ADMIT,
            &json!({}),
            None,
            send.author_member_id,
        );
        payload["origin"] = json!(ORIGIN);
        payload["dm_admission_id"] = json!(id);
        payload["action"]["pins"] = json!({"target": person});
        let approval_id = momo_agent::create_pending_approval_in_tx(
            conn,
            send.workspace_id,
            momo_agent::NewApproval {
                run_id: held.id,
                channel_id: send.channel_id,
                requested_by: agent.member_id,
                action_type: momo_agent::ACTION_TYPE_WORKSPACE_ACTION.into(),
                payload,
                expires_at: expires,
            },
        )
        .await?;
        let block = json!({"id": ACTION_DM_AGENT_ADMIT, "title": action.title, "required_role": "dm_participant", "target_member_id":person, "rows": [
            action_row("에이전트", format!("{} (@{})", agent.display_name, agent.handle)),
            action_row("읽는 범위", "들어온 뒤의 글과 부른 메시지 하나만 봐요. 이전 대화는 보지 않아요."),
            action_row("내보내기", "이 대화의 사람 누구나 내보낼 수 있어요."),
        ]});
        let mut props = momo_agent::workspace_action_request_props(
            approval_id,
            held.id,
            send.channel_id,
            action,
            block,
            expires,
        );
        props["origin"] = json!(ORIGIN);
        props["target_member_id"] = json!(person);
        props["requested_for"] = json!(send.author_member_id);
        props["summary"] = json!(format!("모두 허락하면 {}이 이 대화에 들어와 이후 대화를 보고 답해요. 허락하지 않거나 15분이 지나면 들어오지 않아요.", agent.display_name));
        let card = send_message_in_tx(
            conn,
            send.workspace_id,
            NewMessage {
                channel_id: send.channel_id,
                author_member_id: send.author_member_id,
                message_type: MessageType::ApprovalRequest,
                body: Some(format!("{} 들이기 허락을 기다려요", agent.display_name)),
                props,
                root_id: None,
                reply_to_id: None,
                client_msg_id: Some(momo_agent::card_client_msg_id(approval_id)),
                run_id: Some(held.id),
                hlc_ts: None,
                hlc_count: None,
            },
        )
        .await?;
        momo_agent::attach_request_message_in_tx(
            conn,
            send.workspace_id,
            approval_id,
            card.message.id,
        )
        .await?;
    }
    write_audit(
        conn,
        &AuditEntry::new(send.workspace_id, "dm.agent.admission_requested")
            .by(send.author_member_id)
            .about(agent.member_id)
            .target("dm_agent_admission", id)
            .with_schema(
                "momo.dm_agent_admission.v1",
                json!({"channel_id":send.channel_id}),
            ),
    )
    .await?;
    Ok(true)
}

/// A vote only settles this person's card. Admission requires every card, the
/// same human audience, a live caller/agent/runtime, and an unexpired request.
pub(crate) async fn vote_in_tx(
    conn: &mut PgConnection,
    approval: &LockedApproval,
    person: Uuid,
    approve: bool,
    state: &AppState,
) -> Result<Result<&'static str, &'static str>, DbError> {
    if momo_agent::decider::pinned_target_member(&approval.payload) != Some(person) {
        return Ok(Err("forbidden"));
    }
    let Some(id) = approval.payload["dm_admission_id"]
        .as_str()
        .and_then(|s| Uuid::parse_str(s).ok())
    else {
        return Ok(Err("args_invalid"));
    };
    if !lock_room(conn, approval.workspace_id, approval.channel_id).await? {
        return Ok(Err("args_invalid"));
    }
    let Some(row) = sqlx::query("SELECT * FROM dm_agent_admission WHERE workspace_id = $1 AND id = $2 AND channel_id = $3 FOR UPDATE")
        .bind(approval.workspace_id).bind(id).bind(approval.channel_id).fetch_optional(&mut *conn).await? else { return Ok(Err("args_invalid")); };
    let requester: Uuid = row.try_get("requested_by")?;
    let agent_id: Uuid = row.try_get("agent_member_id")?;
    let required: Vec<Uuid> = row.try_get("required_human_ids")?;
    let expires: chrono::DateTime<Utc> = row.try_get("expires_at")?;
    if row
        .try_get::<Option<chrono::DateTime<Utc>>, _>("revoked_at")?
        .is_some()
        || row
            .try_get::<Option<chrono::DateTime<Utc>>, _>("admitted_at")?
            .is_some()
    {
        return Ok(Err("args_invalid"));
    }
    if approve && expires > Utc::now() {
        let mut expected = required.clone();
        expected.push(requester);
        expected.sort_unstable();
        let connection: Option<Uuid> = row.try_get("connection_id")?;
        if humans(conn, approval.workspace_id, approval.channel_id).await? != expected
            || !super::agent_mentions::reprove_dm_admission_in_tx(
                conn,
                state,
                approval.workspace_id,
                approval.channel_id,
                requester,
                agent_id,
                connection,
            )
            .await?
        {
            return Ok(Err("args_invalid"));
        }
    }
    let status = if expires <= Utc::now() {
        "expired"
    } else if approve {
        "approved"
    } else {
        "rejected"
    };
    if status == "expired" {
        momo_agent::mark_approval_expired_in_tx(
            conn,
            approval.id,
            Utc::now(),
            "DM consent expired",
        )
        .await?;
    } else {
        momo_agent::mark_approval_decided_in_tx(
            conn,
            approval.id,
            status,
            person,
            Utc::now(),
            None,
        )
        .await?;
    }
    if status != "approved" {
        let sibling_cards: Vec<Uuid> = sqlx::query_scalar("UPDATE approval SET status='cancelled', decided_at=now() WHERE workspace_id=$1 AND payload->>'dm_admission_id'=$2 AND status='pending' RETURNING request_message_id")
            .bind(approval.workspace_id).bind(id.to_string()).fetch_all(&mut *conn).await?;
        for message in sibling_cards {
            momo_messaging::patch_message_props_in_tx(
                conn,
                approval.workspace_id,
                message,
                &json!({"status":"cancelled", "decided_at_ms":Utc::now().timestamp_millis()}),
            )
            .await?;
            momo_messaging::emit_message_edited_in_tx(conn, approval.workspace_id, message).await?;
        }
        sqlx::query("UPDATE dm_agent_admission SET revoked_at = clock_timestamp() WHERE workspace_id = $1 AND id = $2").bind(approval.workspace_id).bind(id).execute(&mut *conn).await?;
        sqlx::query("UPDATE agent_run SET status = 'cancelled', finished_at = now(), updated_at = now() WHERE workspace_id = $1 AND id = $2 AND status = 'awaiting_approval'").bind(approval.workspace_id).bind(approval.run_id).execute(&mut *conn).await?;
        return Ok(Ok(status));
    }
    let complete: bool = sqlx::query_scalar("SELECT NOT EXISTS (SELECT 1 FROM unnest($2::uuid[]) AS p(member_id) WHERE NOT EXISTS (SELECT 1 FROM approval a WHERE a.workspace_id = $1 AND a.payload->>'dm_admission_id' = $3 AND a.payload->'action'->'pins'->>'target' = p.member_id::text AND a.status = 'approved' AND a.expires_at > now()))")
        .bind(approval.workspace_id).bind(&required).bind(id.to_string()).fetch_one(&mut *conn).await?;
    if !complete {
        return Ok(Ok(status));
    }
    let mut expected = required.clone();
    expected.push(requester);
    expected.sort_unstable();
    if humans(conn, approval.workspace_id, approval.channel_id).await? != expected {
        return Err(sqlx::Error::Protocol("DM audience changed during consent".into()).into());
    }
    let connection: Option<Uuid> = row.try_get("connection_id")?;
    if !super::agent_mentions::reprove_dm_admission_in_tx(
        conn,
        state,
        approval.workspace_id,
        approval.channel_id,
        requester,
        agent_id,
        connection,
    )
    .await?
    {
        // Roll back the final vote as well: a failed re-proof never spends consent.
        return Err(sqlx::Error::Protocol("DM admission is no longer invocable".into()).into());
    }
    let cutover: i64 = sqlx::query_scalar("SELECT last_seq FROM channel_seq WHERE channel_id = $1")
        .bind(approval.channel_id)
        .fetch_one(&mut *conn)
        .await?;
    lock_agent_seat(conn, approval.workspace_id, approval.channel_id, agent_id).await?;
    sqlx::query("UPDATE dm_agent_admission SET admitted_at = clock_timestamp(), admitted_after_seq = $3 WHERE workspace_id = $1 AND id = $2 AND admitted_at IS NULL AND revoked_at IS NULL").bind(approval.workspace_id).bind(id).bind(cutover).execute(&mut *conn).await?;
    sqlx::query("INSERT INTO membership (workspace_id, channel_id, member_id, role, joined_at) VALUES ($1,$2,$3,'member',clock_timestamp()) ON CONFLICT (channel_id,member_id) DO UPDATE SET left_at = NULL, joined_at = EXCLUDED.joined_at")
        .bind(approval.workspace_id).bind(approval.channel_id).bind(agent_id).execute(&mut *conn).await?;
    // The original pair may start a new private 1:1. This conversation keeps its id.
    sqlx::query(
        "UPDATE channel SET dm_key = 'admitted:' || id::text WHERE workspace_id = $1 AND id = $2",
    )
    .bind(approval.workspace_id)
    .bind(approval.channel_id)
    .execute(&mut *conn)
    .await?;
    sqlx::query("UPDATE agent_run SET status = 'succeeded', finished_at = now(), updated_at = now() WHERE workspace_id = $1 AND id = $2 AND status = 'awaiting_approval'").bind(approval.workspace_id).bind(approval.run_id).execute(&mut *conn).await?;
    let name: String =
        sqlx::query_scalar("SELECT display_name FROM member WHERE workspace_id = $1 AND id = $2")
            .bind(approval.workspace_id)
            .bind(agent_id)
            .fetch_one(&mut *conn)
            .await?;
    system_line(
        conn,
        approval.workspace_id,
        approval.channel_id,
        person,
        agent_id,
        &format!("{name}이 들어왔어요 · 이후 대화를 봐요"),
        "joined",
    )
    .await?;
    let trigger: Uuid = row.try_get("trigger_message_id")?;
    let requested = momo_agent::validate_request_routing(approval.run_input.get("routing"))
        .map_err(|invalid| sqlx::Error::Protocol(invalid.to_string()))?;

    super::agent_mentions::enqueue_dm_admission_trigger_in_tx(
        conn,
        state,
        approval.workspace_id,
        approval.channel_id,
        requester,
        agent_id,
        trigger,
        requested.as_ref(),
    )
    .await?;
    write_audit(
        conn,
        &AuditEntry::new(approval.workspace_id, "dm.agent.admitted")
            .by(person)
            .about(agent_id)
            .target("dm_agent_admission", id)
            .with_schema(
                "momo.dm_agent_admission.v1",
                json!({"channel_id":approval.channel_id,"after_seq":cutover}),
            ),
    )
    .await?;
    Ok(Ok(status))
}

async fn system_line(
    conn: &mut PgConnection,
    ws: Uuid,
    channel: Uuid,
    author: Uuid,
    agent: Uuid,
    body: &str,
    event: &str,
) -> Result<(), DbError> {
    send_message_in_tx(
        conn,
        ws,
        NewMessage {
            channel_id: channel,
            author_member_id: author,
            message_type: MessageType::System,
            body: Some(body.into()),
            props: json!({"kind":"dm_agent_membership", "agent_member_id":agent, "event":event}),
            root_id: None,
            reply_to_id: None,
            client_msg_id: None,
            run_id: None,
            hlc_ts: None,
            hlc_count: None,
        },
    )
    .await?;
    Ok(())
}

/// Any active human participant can remove a consented agent; admins outside
/// the DM have no authority. Existing human↔agent 1:1 DMs keep their old path.
pub async fn remove(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((ws, channel, agent)): Path<(Uuid, Uuid, Uuid)>,
) -> Result<Json<Value>, ApiError> {
    if principal.workspace_id != ws || principal.kind != PrincipalKind::Human {
        return Err(ApiError::forbidden("human DM participant required"));
    }
    let found = momo_db::with_tenant_tx(&state.pool, ws, move |conn| Box::pin(async move {
        if !lock_room(conn, ws, channel).await? || !humans(conn,ws,channel).await?.contains(&principal.member_id) { return Ok(false); }
        lock_agent_seat(conn, ws, channel, agent).await?;
        let seated: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM dm_agent_admission WHERE workspace_id=$1 AND channel_id=$2 AND agent_member_id=$3 AND admitted_at IS NOT NULL AND revoked_at IS NULL)")
            .bind(ws).bind(channel).bind(agent).fetch_one(&mut *conn).await?;
        if !seated { return Ok(false); }
        // The standard hosted reference needs the still-valid seat. Its stop
        // and the revocation below commit together under the exclusive lock.
        super::agent_runs::cancel_agent_runs_in_tx(conn, ws, agent, Some(channel), principal.member_id).await?;
        let changed = sqlx::query("UPDATE dm_agent_admission SET revoked_at = clock_timestamp() WHERE workspace_id = $1 AND channel_id = $2 AND agent_member_id = $3 AND admitted_at IS NOT NULL AND revoked_at IS NULL")
            .bind(ws).bind(channel).bind(agent).execute(&mut *conn).await?.rows_affected();
        if changed == 0 { return Ok(false); }
        sqlx::query("UPDATE membership SET left_at = clock_timestamp() WHERE workspace_id = $1 AND channel_id = $2 AND member_id = $3 AND left_at IS NULL").bind(ws).bind(channel).bind(agent).execute(&mut *conn).await?;
        let name: String = sqlx::query_scalar("SELECT display_name FROM member WHERE workspace_id = $1 AND id = $2").bind(ws).bind(agent).fetch_one(&mut *conn).await?;
        system_line(conn,ws,channel,principal.member_id,agent,&format!("{name}을 내보냈어요 · 이제 이 대화를 보지 못해요"),"removed").await?;
        write_audit(conn,&AuditEntry::new(ws,"dm.agent.removed").by(principal.member_id).about(agent).target("channel",channel)).await?;
        Ok(true)
    })).await.map_err(|e| ApiError::internal("dm_agents.remove",e))?;
    if !found {
        return Err(ApiError::not_found("DM agent membership not found"));
    }
    Ok(Json(json!({"removed":true})))
}

/// Same key as migration 156's message trigger, after the channel sequence lock.
/// A writer keeps its shared lock until commit; no seat change can overtake it.
async fn lock_agent_seat(
    conn: &mut PgConnection,
    ws: Uuid,
    channel: Uuid,
    agent: Uuid,
) -> Result<(), DbError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('dm-agent:' || $1::text || ':' || $2::text || ':' || $3::text, 0))")
        .bind(ws)
        .bind(channel)
        .bind(agent)
        .execute(conn)
        .await?;
    Ok(())
}
