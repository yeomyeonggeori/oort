//! The in-place 「이 채널에서 쓰기」 card (ADR-0162 증보 5 G1~G5, #3857).
//!
//! A person calls a hosted agent in a channel its connection was never approved
//! for. Until this module, the mention path skipped the call and left a notice
//! line pointing at the settings screen. Now — for an explicit mention by a
//! person, in a live non-DM channel, on an active proved connection — the same
//! send transaction writes three things instead:
//!
//! 1. the mention run, born `awaiting_approval` (never `queued`, so no
//!    `queued`/`started` ledger row claims a turn that has not begun);
//! 2. one `workspace_action` approval of the **existing** action
//!    `hosted.channels.grant` (ADR-0186 V5) naming exactly that channel, with
//!    `payload.origin = "server_in_place"`;
//! 3. the `approval_request` card in the caller's thread.
//!
//! **No `agent_job` is written.** Before a person approves, the prompt and the
//! room's recent messages reach neither the outbox nor the agent (HAP-E3). The
//! decision route (`routes::approvals`) is what writes the one job, inside the
//! same transaction that widens the grant, and only when re-queueing the held
//! run succeeds — that guard is the whole "exactly once" argument.
//!
//! This module owns the vocabulary (origin, hold marker, sentences, rows) and
//! the three small reads the producer needs. The order of the writes is the
//! route's (`routes::agent_mentions`), as for every other mention outcome.

use momo_db::DbError;
use serde_json::{json, Value};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::actions::{
    action_row, grant_channel_row, member_card_label, workspace_action_payload,
    ACTION_HOSTED_CHANNELS_GRANT, ACTION_TYPE_WORKSPACE_ACTION,
};

/// `approval.payload.origin` of a card the **server** raised in place (G2).
/// Every other `workspace_action` was proposed by an agent and has no origin.
pub const APPROVAL_ORIGIN_SERVER_IN_PLACE: &str = "server_in_place";

/// `agent_run.input.hold` of a run held for an in-place channel grant. The
/// concurrency cap does not count such a run (`live_run_count_in_tx`): nothing
/// is running and nothing has reached the agent, so an unanswered card must not
/// silence the agent everywhere else for an hour.
pub const RUN_HOLD_KEY: &str = "hold";
pub const RUN_HOLD_CHANNEL_GRANT: &str = "channel_grant";

/// G2 — pending in-place cards per connection before the producer falls back to
/// the old notice line. **[추정]** in the ADR; one number, here.
pub const MAX_PENDING_IN_PLACE_GRANTS_PER_CONNECTION: i64 = 5;

/// The card title (G2: 제목 「이 채널에서 쓰기」). The agent's name is not baked
/// into `props.title`: the card is authored by that agent, so its avatar and
/// current name are already on the row above, and a copied name would go stale
/// after a rename (the same reasoning as `actions::proposal_summary`).
pub const IN_PLACE_GRANT_TITLE: &str = "이 채널에서 쓰기";

/// The sentence under the title — what approving does.
pub const IN_PLACE_GRANT_SUMMARY: &str =
    "이 채널은 아직 이 에이전트가 읽고 쓸 수 없어요. 관리자가 승인하면 이 채널을 연결에 더하고, 기다리던 요청을 바로 처리해요.";

/// What a non-deciding viewer is told (G2 — rendered per viewer by the client).
pub const IN_PLACE_GRANT_WAITING_TEXT: &str = "관리자가 승인하면 바로 처리돼요";

/// The outcome line under a rejected in-place card — what the person who called
/// sees instead of the generic tool-call sentence.
pub const IN_PLACE_GRANT_REJECTED_BODY: &str =
    "관리자가 이 채널에서 쓰기를 승인하지 않아서 요청을 처리하지 않았어요.";

/// The outcome line under an expired in-place card (G4).
pub const IN_PLACE_GRANT_EXPIRED_BODY: &str =
    "시간이 지나 요청을 처리하지 않았어요. 다시 불러 주세요.";

/// `agent_run.error.code` of a held run ended by a rejection. Distinct from the
/// tool-call `approval_rejected` so a reader can tell "a person said no to this
/// channel" from "a person said no to a tool call".
pub const IN_PLACE_GRANT_REJECTED_CODE: &str = "channel_grant_rejected";

pub const AUDIT_IN_PLACE_CARD_POSTED: &str = "agent.hosted_grant_card.posted";
pub const AUDIT_IN_PLACE_CARD_COALESCED: &str = "agent.hosted_grant_card.coalesced";
pub const AUDIT_IN_PLACE_CARD_SCHEMA: &str = "momo.agent.hosted_grant_card.v1";

/// `audit_log.detail.via` on `hosted_connection.channels_granted` when the grant
/// came from this card (G3-4).
pub const IN_PLACE_GRANT_AUDIT_VIA: &str = "in_place_card";

/// Whether an approval payload is an in-place card.
pub fn is_in_place_grant(payload: &Value) -> bool {
    payload.get("origin").and_then(Value::as_str) == Some(APPROVAL_ORIGIN_SERVER_IN_PLACE)
}

/// Whether a run's input marks it as held for an in-place grant.
pub fn is_held_for_channel_grant(input: &Value) -> bool {
    input.get(RUN_HOLD_KEY).and_then(Value::as_str) == Some(RUN_HOLD_CHANNEL_GRANT)
}

/// Mark a mention run's input as held for an in-place grant.
pub fn mark_held_for_channel_grant(input: &mut Value) {
    if let Some(object) = input.as_object_mut() {
        object.insert(RUN_HOLD_KEY.into(), json!(RUN_HOLD_CHANNEL_GRANT));
    }
}

/// The card body (D5 fallback for a client that does not know the card kind): one question,
/// quoting nothing (ADR-0204 증보 6 D6-3). The agent is the push's title and the channel is on
/// the notification, so a name written into the sentence would only be a second place for a
/// person-chosen text to reach a lock screen.
pub fn in_place_grant_body() -> String {
    crate::approval_sentence::in_place_grant_request_body()
}

/// What the server found about the channel and the connection — the only
/// inputs the card rows and the pins are drawn from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InPlaceChannelFacts {
    pub name: String,
    /// `public` | `private`.
    pub kind: String,
    pub member_count: i64,
    /// `cardinality(approved_channel_ids)` of the connection now.
    pub approved_before: usize,
}

/// G2 card rows (ADR-0186 V1-a — server-resolved values only): the agent, the
/// channel (name · 공개 범위 · 인원), then 「승인 채널 수」 before → after.
pub fn in_place_grant_rows(
    agent_display_name: &str,
    agent_handle: &str,
    facts: &InPlaceChannelFacts,
) -> Vec<Value> {
    vec![
        action_row(
            "에이전트",
            member_card_label(agent_display_name, agent_handle, true),
        ),
        grant_channel_row(&facts.name, &facts.kind, facts.member_count),
        action_row(
            "승인 채널 수",
            format!(
                "{}개 → {}개",
                facts.approved_before,
                facts.approved_before + 1
            ),
        ),
    ]
}

/// The stored approval payload: the same `workspace_action` shape an agent's
/// `oort_action_propose` stores for `hosted.channels.grant`, so the decision
/// route re-proves it with the same resolver — plus the origin and the pins the
/// resolver will compare (`{connection, channels:[id], hostedConnection}`).
///
/// `hostedConnection` is the proposal-time binding every card of a hosted
/// proposer carries (ADR-0186 U-d, #4821): the decision resolver puts the
/// connection it proves into the pins it compares, so a card written without
/// this key could never be approved (`action_args_invalid`, even on the very
/// connection that raised it). Here it is the connection the card was raised on.
pub fn in_place_grant_payload(
    agent_member_id: Uuid,
    requested_for: Uuid,
    connection_id: Uuid,
    channel_id: Uuid,
    channel_name: &str,
    trigger_message_id: Uuid,
) -> Value {
    let mut payload = workspace_action_payload(
        ACTION_HOSTED_CHANNELS_GRANT,
        &json!({"channels": [channel_name]}),
        None,
        agent_member_id,
    );
    if let Some(action) = payload.get_mut("action").and_then(Value::as_object_mut) {
        action.insert(
            "pins".into(),
            json!({
                "connection": connection_id.to_string(),
                "channels": [channel_id.to_string()],
                "hostedConnection": connection_id.to_string(),
            }),
        );
    }
    if let Some(object) = payload.as_object_mut() {
        object.insert("origin".into(), json!(APPROVAL_ORIGIN_SERVER_IN_PLACE));
        // Who called — the person the outcome is for. Not an authority: the
        // decider is judged on their own role at decision time.
        object.insert("requested_for".into(), json!(requested_for.to_string()));
        object.insert(
            "trigger_message_id".into(),
            json!(trigger_message_id.to_string()),
        );
    }
    payload
}

/// Drop the hold marker from a run the decision route just released
/// (`awaiting_approval` → `queued`). `live_run_count_in_tx` skips a run that is
/// `awaiting_approval` **and** marked held; left in place, the marker would make
/// the same run invisible to the concurrency cap if it later parked on an
/// ordinary approval (an `oort_action_propose` card) during its own turn.
pub async fn clear_channel_grant_hold_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE agent_run SET input = input - $3, updated_at = now() \
          WHERE workspace_id = $1 AND id = $2 AND input->>$3 = $4",
    )
    .bind(workspace_id)
    .bind(run_id)
    .bind(RUN_HOLD_KEY)
    .bind(RUN_HOLD_CHANNEL_GRANT)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Serialize every in-place card producer of one connection for the rest of the
/// transaction (G2's per-connection ceiling). An advisory lock only this path
/// takes, so it cannot close a cycle with the decision route's row locks; one
/// channel's producers are serialized already by that channel's `channel_seq`
/// row, which the send took before it got here.
pub async fn lock_in_place_grant_slot_in_tx(
    conn: &mut PgConnection,
    connection_id: Uuid,
) -> Result<(), DbError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("momo.in_place_grant:{connection_id}"))
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// The pending, not-yet-expired in-place card for this agent in this channel,
/// if there is one (G2: one card per (connection, channel)). An expired card the
/// sweep has not reached yet does not count — nobody can still decide it.
pub async fn pending_in_place_grant_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    connection_id: Uuid,
    channel_id: Uuid,
) -> Result<Option<Uuid>, DbError> {
    Ok(sqlx::query_scalar(
        "SELECT id FROM approval \
          WHERE workspace_id = $1 AND requested_by = $2 AND channel_id = $4 \
            AND action_type = $5 AND status = 'pending' \
            AND payload->>'origin' = $6 \
            AND payload->'action'->'pins'->>'connection' = $3::text \
            AND (expires_at IS NULL OR expires_at > now()) \
          ORDER BY created_at LIMIT 1",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .bind(connection_id.to_string())
    .bind(channel_id)
    .bind(ACTION_TYPE_WORKSPACE_ACTION)
    .bind(APPROVAL_ORIGIN_SERVER_IN_PLACE)
    .fetch_optional(&mut *conn)
    .await?)
}

/// How many in-place cards this connection has pending and not yet expired.
pub async fn count_pending_in_place_grants_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    connection_id: Uuid,
) -> Result<i64, DbError> {
    Ok(sqlx::query_scalar(
        "SELECT count(*) FROM approval \
          WHERE workspace_id = $1 AND action_type = $3 AND status = 'pending' \
            AND payload->>'origin' = $4 \
            AND payload->'action'->'pins'->>'connection' = $2::text \
            AND (expires_at IS NULL OR expires_at > now())",
    )
    .bind(workspace_id)
    .bind(connection_id.to_string())
    .bind(ACTION_TYPE_WORKSPACE_ACTION)
    .bind(APPROVAL_ORIGIN_SERVER_IN_PLACE)
    .fetch_one(&mut *conn)
    .await?)
}

/// The channel and connection facts the card is drawn from — **no row lock**.
///
/// The decision route takes the connection row `FOR UPDATE` and then bumps this
/// channel's `channel_seq` (its outcome line). The send that reaches here already
/// holds that `channel_seq` row, so locking the connection here would be the
/// opposite order. A plain read is enough: the decision re-proves everything
/// under its own locks (V1-d) and the pins catch a channel or connection that
/// moved in between.
///
/// `None` when the channel is not a live public/private channel (a DM, an
/// archived room) or the connection is not active and proved.
pub async fn in_place_channel_facts_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    connection_id: Uuid,
) -> Result<Option<InPlaceChannelFacts>, DbError> {
    let row: Option<(String, String, i64, i32)> = sqlx::query_as(
        "SELECT c.name, c.kind::text, \
                (SELECT count(*) FROM membership x \
                  WHERE x.workspace_id = c.workspace_id AND x.channel_id = c.id \
                    AND x.left_at IS NULL), \
                cardinality(hc.approved_channel_ids) \
           FROM channel c \
           JOIN hosted_agent_connection hc \
             ON hc.workspace_id = c.workspace_id AND hc.id = $3 \
            AND hc.status = 'active' AND hc.proved_at IS NOT NULL \
          WHERE c.workspace_id = $1 AND c.id = $2 \
            AND c.kind IN ('public', 'private') AND c.archived_at IS NULL",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(connection_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(
        row.map(|(name, kind, member_count, approved)| InPlaceChannelFacts {
            name,
            kind,
            member_count,
            approved_before: usize::try_from(approved).unwrap_or(0),
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_payload_is_a_hosted_grant_of_exactly_one_channel_with_its_pins_and_origin() {
        let agent = Uuid::new_v4();
        let human = Uuid::new_v4();
        let connection = Uuid::new_v4();
        let channel = Uuid::new_v4();
        let trigger = Uuid::new_v4();
        let payload = in_place_grant_payload(agent, human, connection, channel, "general", trigger);
        assert_eq!(payload["action"]["id"], json!("hosted.channels.grant"));
        assert_eq!(payload["action"]["args"], json!({"channels": ["general"]}));
        assert_eq!(
            payload["action"]["pins"],
            json!({
                "connection": connection.to_string(),
                "channels": [channel.to_string()],
                // #4821: the connection the card was raised on, in the one key the
                // decision compares for every hosted proposer's card.
                "hostedConnection": connection.to_string(),
            })
        );
        assert_eq!(payload["proposed_by"], json!(agent.to_string()));
        assert_eq!(payload["requested_for"], json!(human.to_string()));
        assert!(is_in_place_grant(&payload));
        assert!(!is_in_place_grant(&json!({"action": {"id": "x"}})));
    }

    #[test]
    fn the_hold_marker_round_trips_and_nothing_else_reads_as_held() {
        let mut input = json!({"surface": "mention"});
        assert!(!is_held_for_channel_grant(&input));
        mark_held_for_channel_grant(&mut input);
        assert!(is_held_for_channel_grant(&input));
        assert!(!is_held_for_channel_grant(&json!({"hold": "other"})));
    }

    #[test]
    fn the_rows_say_agent_channel_and_the_count_after_one_more() {
        let rows = in_place_grant_rows(
            "그록",
            "grok",
            &InPlaceChannelFacts {
                name: "dev".into(),
                kind: "private".into(),
                member_count: 4,
                approved_before: 2,
            },
        );
        assert_eq!(
            rows,
            vec![
                json!({"label": "에이전트", "value": "그록 (@grok, 에이전트)"}),
                json!({"label": "채널", "value": "#dev · 비공개 · 4명"}),
                json!({"label": "승인 채널 수", "value": "2개 → 3개"}),
            ]
        );
    }

    #[test]
    fn the_body_is_one_question_and_quotes_nothing() {
        assert_eq!(in_place_grant_body(), "이 채널에서 읽고 쓰게 해도 될까요?");
    }
}
