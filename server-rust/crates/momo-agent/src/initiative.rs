//! Cards an agent raises **nobody asked for** (ADR-0186 증보 v5 U-a~U-d, #4704).
//!
//! `oort_action_initiate` is the one Agent Port tool that needs no lease handle, so it has no
//! job to hang a run on. The server opens a short run of its own, born `awaiting_approval`
//! (the in-place channel-grant card is the precedent: `in_place_grant`), writes one
//! `workspace_action` approval and one card in the **owner's** one-to-one direct message,
//! and stops. Nothing here executes anything: the decision route does, as the approver, after a
//! person says yes.
//!
//! This module owns the vocabulary (origin, hold marker, lifetimes, the card's sentence) and the
//! reads the producer needs that do not touch another crate: the facts of the door, the member
//! lock, and the re-ask lookup. The order of the writes is the route's
//! (`routes::agent_initiative`), as for every other producer.

use chrono::{DateTime, Utc};
use momo_db::DbError;
use serde_json::{json, Value};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::actions::{WorkspaceAction, ACTION_CHANNEL_CREATE};
use crate::approval::effective_status;
use crate::in_place_grant::RUN_HOLD_KEY;
use crate::run::RunTrigger;

/// `approval.payload.origin` of an unasked card. The in-place card's is `server_in_place`; every
/// other `workspace_action` was proposed by an agent a person called and carries no origin.
/// The push judgment already projects `origin`, so `opens_in_app` can read it
/// (`momo_push` `judgment.rs`).
pub const APPROVAL_ORIGIN_AGENT_INITIATED: &str = "agent_initiated";

/// `agent_run.input.hold` of the run behind an unasked card. [`crate::run::live_run_count_in_tx`]
/// does not count it: it holds no job and nothing of it reached the agent.
pub const RUN_HOLD_AGENT_INITIATED: &str = "agent_initiated";

/// How long an unasked card waits for its owner: a day. The default 1-hour approval lifetime
/// (`approval::DEFAULT_TTL_SECONDS`) exists because a parked run holds its agent's concurrency
/// slot; this run holds none (the hold above), and a card that lapses before its owner is back
/// at the screen would be raised again at once.
pub const INITIATIVE_TTL_SECONDS: i64 = 24 * 60 * 60;

/// Whether an approval payload is an unasked card.
pub fn is_agent_initiated(payload: &Value) -> bool {
    payload.get("origin").and_then(Value::as_str) == Some(APPROVAL_ORIGIN_AGENT_INITIATED)
}

/// Whether a run's input marks it as held for an unasked card.
pub fn is_held_for_agent_initiative(input: &Value) -> bool {
    input.get(RUN_HOLD_KEY).and_then(Value::as_str) == Some(RUN_HOLD_AGENT_INITIATED)
}

/// `agent_run.input` of an unasked card's run: the hold marker and **nothing the agent wrote**.
pub fn initiative_run_input() -> Value {
    json!({ RUN_HOLD_KEY: RUN_HOLD_AGENT_INITIATED })
}

/// The sentence under the card's title. Says it was **not asked for**, then what approving does
/// and with whose authority. No name is baked in: the card is authored by the agent, and a name
/// copied into props goes stale after a rename (`actions::proposal_summary`'s reason).
pub fn initiative_summary(action: &WorkspaceAction) -> String {
    format!(
        "에이전트가 부탁받지 않고 먼저 제안했어요. 승인하면 {} 권한으로 {}.",
        action.required_role.korean(),
        action.effect_phrase()
    )
}

/// The facts of the door that only the database holds, read in the caller's transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InitiativeFacts {
    /// The agent's active human owner, who **confirmed this very connection** — the predicate
    /// under which `hosted_connection_channel_ids` covers the owner's direct message
    /// (migration 091, ADR-0162 증보 2 B6). The card is raised in that DM, so a connection
    /// confirmed by somebody else has no room to raise it in.
    pub owner_member_id: Uuid,
    /// `agent.max_run_steps`, the run's step ceiling (no step ever runs).
    pub max_run_steps: i32,
}

/// Condition 4 of the door (ADR-0186 증보 v5 U-b-4): the agent has an **active human owner** and
/// that owner confirmed this connection. `None` is the one answer for every way that fails.
pub async fn initiative_facts_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    connection_id: Uuid,
) -> Result<Option<InitiativeFacts>, DbError> {
    let row = sqlx::query(
        "SELECT a.owner_human_id, a.max_run_steps \
           FROM hosted_agent_connection hc \
           JOIN agent a \
             ON a.workspace_id = hc.workspace_id AND a.member_id = hc.agent_member_id \
           JOIN member o \
             ON o.workspace_id = a.workspace_id AND o.id = a.owner_human_id \
            AND o.kind = 'human' AND o.status = 'active' AND o.deleted_at IS NULL \
           JOIN workspace_membership wm \
             ON wm.workspace_id = o.workspace_id AND wm.member_id = o.id \
          WHERE hc.workspace_id = $1 AND hc.id = $2 AND hc.agent_member_id = $3 \
            AND hc.confirmed_by = a.owner_human_id",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .bind(agent_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some(InitiativeFacts {
        owner_member_id: row.try_get("owner_human_id")?,
        max_run_steps: row.try_get("max_run_steps")?,
    }))
}

/// Serialise one agent's unasked-card calls — and every re-ask of one — behind a transaction-scoped
/// **advisory** lock: two simultaneous calls of the same `clientRequestId` cannot both read "not
/// raised yet", and PR B's ceilings cannot be outrun by concurrency.
///
/// An advisory lock and not a row lock on the agent's `member` row (`FOR NO KEY UPDATE`, which
/// `lock_agent_and_count_pending_workspace_actions_in_tx` takes for the proposals a person asked
/// for): that row lock is exclusive against the `FOR SHARE` that every message write, every decision's
/// wake and every identity proof takes on the same row, so it formed lock cycles with all of them —
/// and, taken after the share lock the identity proof already holds, it made two simultaneous calls of
/// one agent wait on each other every time (a share-to-exclusive upgrade). Nothing else takes this
/// key, so it can be first in the transaction and can wait on nothing but its own kind.
pub async fn lock_agent_initiative_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
) -> Result<(), DbError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))")
        .bind(format!("oort:initiative:{workspace_id}:{agent_member_id}"))
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// What the database holds about the unasked card one `clientRequestId` produced.
#[derive(Debug, Clone, PartialEq)]
pub struct InitiativeRecord {
    pub approval_id: Uuid,
    /// As stored: `pending | approved | rejected | expired | cancelled`.
    pub status: String,
    pub expires_at: Option<DateTime<Utc>>,
    pub decided_at: Option<DateTime<Utc>>,
    pub action_id: Option<String>,
    /// `payload.action.args`, the **normalised** arguments the card was drawn from.
    pub args: Value,
    /// `agent_run.output.ref` — set by the decision that executed the action.
    pub output_ref: Option<Value>,
}

/// The unasked card this agent raised under `client_request_id`, if any (the re-ask lookup).
///
/// Keyed by the run's idempotency key, which names the **agent**: one agent can never read
/// another's proposal, and no argument can aim it elsewhere.
pub async fn find_initiative_by_request_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    client_request_id: Uuid,
) -> Result<Option<InitiativeRecord>, DbError> {
    let key = RunTrigger::AgentInitiated {
        agent_member_id,
        client_request_id,
    }
    .idempotency_key();
    let row = sqlx::query(
        "SELECT a.id AS approval_id, a.status::text AS status, a.expires_at, a.decided_at, \
                a.payload, r.output \
           FROM agent_run r \
           JOIN approval a ON a.workspace_id = r.workspace_id AND a.run_id = r.id \
          WHERE r.workspace_id = $1 AND r.agent_member_id = $2 AND r.idempotency_key = $3 \
          LIMIT 1",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .bind(&key)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    let payload: Value = row.try_get("payload")?;
    let output: Option<Value> = row.try_get("output")?;
    Ok(Some(InitiativeRecord {
        approval_id: row.try_get("approval_id")?,
        status: row.try_get("status")?,
        expires_at: row.try_get("expires_at")?,
        decided_at: row.try_get("decided_at")?,
        action_id: payload
            .pointer("/action/id")
            .and_then(Value::as_str)
            .map(str::to_string),
        args: payload
            .pointer("/action/args")
            .cloned()
            .unwrap_or(Value::Null),
        output_ref: output.and_then(|output| output.get("ref").cloned()),
    }))
}

/// The answer to a re-ask: `{approvalId, status, expiresAtMs?, decidedAtMs?, ref?}`.
///
/// * `status` is [`effective_status`] on the **application's** clock — the very predicate the
///   decision route settles a late tap with — so a `pending` card past its deadline reads
///   `expired` before the sweep has written it down (ADR-0186 증보 v5 U-f).
/// * `expiresAtMs` only while it is `pending`; `decidedAtMs` only once somebody decided.
/// * `ref` only when `approved`, and never an id the agent was not told: a channel the agent
///   asked to be left out of (`addProposer:false`) is a private room it knows nothing of
///   (ADR-0186 증보 v5 U-d, review L3).
pub fn reask_answer(record: &InitiativeRecord, now: DateTime<Utc>) -> Value {
    let status = effective_status(&record.status, record.expires_at, now);
    let mut answer = json!({
        "approvalId": record.approval_id,
        "status": status,
    });
    if status == "pending" {
        if let Some(expires_at) = record.expires_at {
            answer["expiresAtMs"] = json!(expires_at.timestamp_millis());
        }
    }
    if let Some(decided_at) = record.decided_at {
        answer["decidedAtMs"] = json!(decided_at.timestamp_millis());
    }
    if status == "approved" {
        let agent_not_told = record.action_id.as_deref() == Some(ACTION_CHANNEL_CREATE)
            && record.args.get("addProposer").and_then(Value::as_bool) == Some(false);
        if let (false, Some(reference)) = (agent_not_told, record.output_ref.as_ref()) {
            answer["ref"] = reference.clone();
        }
    }
    answer
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn record(status: &str, expires_in: Option<i64>) -> InitiativeRecord {
        let now = Utc::now();
        InitiativeRecord {
            approval_id: Uuid::from_u128(7),
            status: status.to_string(),
            expires_at: expires_in.map(|seconds| now + Duration::seconds(seconds)),
            decided_at: None,
            action_id: Some("message.pin".into()),
            args: json!({"messageId": Uuid::nil()}),
            output_ref: None,
        }
    }

    #[test]
    fn an_unasked_card_waits_a_day() {
        // ADR-0186 증보 v5 U-d: 24 hours (PR B makes it a bounded setting; the default stays).
        assert_eq!(INITIATIVE_TTL_SECONDS, 86_400);
    }

    #[test]
    fn the_origin_and_the_hold_are_read_only_from_their_own_keys() {
        assert!(is_agent_initiated(&json!({"origin": "agent_initiated"})));
        assert!(!is_agent_initiated(&json!({"origin": "server_in_place"})));
        assert!(!is_agent_initiated(
            &json!({"action": {"origin": "agent_initiated"}})
        ));
        assert!(is_held_for_agent_initiative(&initiative_run_input()));
        assert!(!is_held_for_agent_initiative(
            &json!({"hold": "channel_grant"})
        ));
        // The run's input carries the marker and nothing an agent wrote.
        assert_eq!(initiative_run_input(), json!({"hold": "agent_initiated"}));
    }

    #[test]
    fn a_pending_card_past_its_deadline_reads_expired_and_an_open_one_shows_its_deadline() {
        let now = Utc::now();
        let lapsed = reask_answer(&record("pending", Some(-1)), now);
        assert_eq!(lapsed["status"], "expired");
        assert!(lapsed.get("expiresAtMs").is_none());
        let open = reask_answer(&record("pending", Some(3_600)), now);
        assert_eq!(open["status"], "pending");
        assert!(open["expiresAtMs"].is_i64());
        // A settled card keeps what it was settled as, whatever its deadline says.
        assert_eq!(
            reask_answer(&record("rejected", Some(-1)), now)["status"],
            "rejected"
        );
    }

    #[test]
    fn ref_is_only_for_an_approved_card_and_never_for_a_channel_the_agent_was_left_out_of() {
        let now = Utc::now();
        let reference = json!({"type": "message", "id": Uuid::nil()});
        let mut approved = record("approved", None);
        approved.output_ref = Some(reference.clone());
        assert_eq!(reask_answer(&approved, now)["ref"], reference);
        let mut pending = record("pending", Some(60));
        pending.output_ref = Some(reference.clone());
        assert!(reask_answer(&pending, now).get("ref").is_none());
        let mut hidden = record("approved", None);
        hidden.action_id = Some(ACTION_CHANNEL_CREATE.into());
        hidden.args = json!({"name": "qa", "addProposer": false});
        hidden.output_ref = Some(json!({"type": "channel", "id": Uuid::nil()}));
        assert!(reask_answer(&hidden, now).get("ref").is_none());
        hidden.args = json!({"name": "qa", "addProposer": true});
        assert!(reask_answer(&hidden, now).get("ref").is_some());
    }
}
