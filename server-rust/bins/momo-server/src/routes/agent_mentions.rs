//! Mention → agent run, inside the send transaction (B5.2).
//!
//! Swift `MessageRoutes.routeAgentMentions` (:1441-1509) and `enqueueMentionJob`
//! (:1950-2154), composed here rather than in a domain crate for the reason
//! [`crate::routes::agent_runs`] composes the *work* trigger here: one run needs
//! four owners' statements — `agent_run` (`momo-agent`), the outbox row
//! (`momo-outbox`), the paused-agent message (`momo-messaging`) and `audit_log`
//! (`momo-db`) — and each of those crates deliberately owns only its own. This
//! module owns **no SQL**; it owns the order.
//!
//! ## Why it runs where it runs
//!
//! [`route_agent_mentions_in_tx`] is called by [`crate::routes::messages::send`]
//! **after** `send_message_with_mentions_in_tx` returns and **inside the same
//! transaction** — which is exactly Swift's position (:284-296, after the
//! broadcast INSERT, before the response). Three consequences, all load-bearing:
//!
//! * the run has a `trigger_message_id` that already exists, and a
//!   `trigger_message_seq` that is final;
//! * B1.2's mention pass has already written `props.mention_member_ids`, so the
//!   badge a human sees and the run an agent gets describe the same decision —
//!   they cannot disagree, because a rollback takes both;
//! * a retried send **never reaches here**: `SentMessage::deduped` is the
//!   message-level idempotency answer, and Swift's `if didInsert` guard is the
//!   same one. Together with the `mention:<message>:<agent>` run key that is two
//!   independent reasons one utterance produces at most one run.
//!
//! ## B5.3a — the request tier
//!
//! `routes::messages` now **serves** `routing { model?, effort? }`, so the
//! resolution here is the full ADR-0134 D3 chain rather than the agent tier
//! alone. Two consequences show up in this file's shape:
//!
//! * routing is resolved **after** eligibility (channel membership → paused),
//!   which is Swift's order (:1976-1986). A paused agent answers with its system
//!   line even when the same send carried an impossible model: the operator's
//!   pause is the more informative fact, and it is not the sender's fault.
//! * a violated request tier is a **rejection, not a failure**: it leaves through
//!   the caller's error channel so the send transaction rolls back, message and
//!   all. Swift gets that by throwing inside the transaction closure and says why
//!   — "the message the user just chose a bad model for is not silently delivered
//!   with a different one".
//!
//! ## What is deliberately not ported (see the PR body)
//!
//! * **The Context Packet** (`context_packet_id` / `memory_refs` / `tool_grants`)
//!   — the memory plane is not on this server, and the B5.1 worker consumes none
//!   of the three.
//! * **A2A causality.** An agent-authored mention needs the source run
//!   (`agent_run.input`'s `parent_run_id`/`depth`) to enforce the depth cap, and
//!   the send route refuses `runId`. Rather than create a depth-0 run — which
//!   would make the A2A hop cap unenforceable — an agent-authored mention is
//!   **skipped and audited**. Fail closed.

use momo_agent::{
    create_agent_run_in_tx, load_mention_candidates_in_tx, mention_diagnostic_detail,
    mention_job_broadcast_payload, mention_job_payload, mention_run_input, paused_mention_body,
    paused_mention_props, resolve_mention_routing, MentionCandidate, MentionTrigger, NewAgentRun,
    RequestedRouting, RunTrigger, MENTION_JOB_METHOD_GATEWAY, MENTION_JOB_METHOD_WORKER,
};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{DbError, PgConnection};
use momo_messaging::{
    agent_context_window_in_tx, contains_mention, send_message_in_tx, MessageType, NewMessage,
};
use serde_json::Value;
use uuid::Uuid;

use crate::error::ApiError;

/// `audit_log.detail.schema` shared by all three mention outcomes (Swift
/// `mentionDiagnosticDetail` :2767).
const MENTION_DIAGNOSTIC_SCHEMA: &str = "momo.agent_mention.diagnostic.v0";
const MENTION_QUEUED_ACTION: &str = "agent.mention.queued";
const MENTION_SKIPPED_ACTION: &str = "agent.mention.skipped";
const MENTION_PAUSED_ACTION: &str = "agent.mention.paused";
const MODEL_PREF_IGNORED_ACTION: &str = "agent.profile.model_pref.ignored";

/// Everything the routing needs about the message that triggered it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct MentionSend<'a> {
    pub workspace_id: Uuid,
    pub channel_id: Uuid,
    pub message_id: Uuid,
    pub message_seq: i64,
    pub author_member_id: Uuid,
    /// `true` when the send came in on an agent bearer — the A2A branch.
    pub author_is_agent: bool,
    pub body: &'a str,
    pub hlc_ts: i64,
    pub via_token_id: Option<Uuid>,
    /// `AgentGatewaySettings::enabled` — decides `outbox.method` and whether a
    /// realtime wake-up accompanies the job.
    pub gateway_enabled: bool,
    pub context_max_messages: i64,
    /// ADR-0134 D1's per-request tier, already shape-validated by the route
    /// before the transaction opened. `None` = the caller chose nothing and the
    /// agent's own preferences decide.
    pub routing: Option<&'a RequestedRouting>,
}

/// One agent that got a run out of this message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct QueuedMention {
    pub agent_member_id: Uuid,
    pub run_id: Uuid,
    pub job_outbox_id: i64,
}

/// Route every agent mentioned in `send.body`, returning what was queued.
///
/// **An agent's configuration never fails a send** — not in the channel, paused,
/// or mentioned by another agent each produce an audited no-op. That is Swift's
/// shape and it is the right one: a human's message must not be rejected because
/// of how someone else set an agent up.
///
/// **The caller's own `routing` block can.** `Ok(Err(_))` is that one rejection
/// (ADR-0134 D1): a model outside the workspace allow-list, or an effort the
/// resolved model cannot honour, is something the sender just chose, so it
/// surfaces as a 400 and the send rolls back with it. Delivering the message
/// under a different model would be a silent substitution of the one decision
/// the caller made explicitly.
pub(crate) async fn route_agent_mentions_in_tx(
    conn: &mut PgConnection,
    send: MentionSend<'_>,
) -> Result<Result<Vec<QueuedMention>, ApiError>, DbError> {
    let candidates =
        load_mention_candidates_in_tx(&mut *conn, send.workspace_id, send.channel_id).await?;
    let mentioned: Vec<MentionCandidate> = candidates
        .into_iter()
        .filter(|candidate| {
            contains_mention(
                send.body,
                &candidate.handle,
                &candidate.display_name,
                candidate.member_id,
            )
        })
        .collect();
    if mentioned.is_empty() {
        return Ok(Ok(Vec::new()));
    }

    let trigger = MentionTrigger {
        workspace_id: send.workspace_id,
        channel_id: send.channel_id,
        message_id: send.message_id,
        message_seq: send.message_seq,
        author_member_id: send.author_member_id,
        body: send.body,
        hlc_ts: send.hlc_ts,
    };

    // The history window is one query for the whole message, not one per agent:
    // every agent mentioned in the same utterance sees the same channel, and
    // `type='system'` rows (the only thing this function adds to the channel) are
    // excluded from it anyway. Read lazily so a message that mentions only
    // ineligible agents costs nothing.
    let mut context_window: Option<Vec<Value>> = None;
    let mut queued = Vec::new();

    for agent in &mentioned {
        if send.author_is_agent {
            // See the module docs: without the source run there is no depth to
            // inherit, and a depth-0 A2A run would make the cap unenforceable.
            skip(
                &mut *conn,
                &send,
                &trigger,
                agent,
                "a2a_source_run_unavailable",
            )
            .await?;
            continue;
        }
        if !agent.is_channel_member {
            skip(
                &mut *conn,
                &send,
                &trigger,
                agent,
                "agent_not_channel_member",
            )
            .await?;
            continue;
        }
        if agent.paused {
            paused(&mut *conn, &send, &trigger, agent).await?;
            continue;
        }

        // Eligibility first, routing second (Swift :1976-1986). Reversing the two
        // would answer "your model is not allowed" for a mention of an agent that
        // was never going to run — a true sentence about the wrong problem.
        let routing = match resolve_mention_routing(agent, send.routing) {
            Ok(routing) => routing,
            Err(invalid) => return Ok(Err(ApiError::bad_request(invalid.to_string()))),
        };
        let run_trigger = RunTrigger::Mention {
            message_id: send.message_id,
            agent_member_id: agent.member_id,
        };
        let idempotency_key = run_trigger.idempotency_key();
        let created = create_agent_run_in_tx(
            &mut *conn,
            send.workspace_id,
            NewAgentRun {
                channel_id: send.channel_id,
                trigger: run_trigger,
                parent_run_id: None,
                max_steps: agent.max_run_steps,
                depth: 0,
                input: mention_run_input(
                    &trigger,
                    agent.member_id,
                    &idempotency_key,
                    None,
                    0,
                    send.routing,
                ),
            },
        )
        .await?;
        if !created.created {
            // The unique index says this trigger already produced a run. Swift
            // returns early on exactly this (`guard let first = rows.first`), so
            // no second job and no second audit row — otherwise a replay would
            // queue a second turn for an answer that already exists.
            continue;
        }

        if context_window.is_none() {
            context_window = Some(
                agent_context_window_in_tx(
                    &mut *conn,
                    send.channel_id,
                    send.message_id,
                    send.context_max_messages,
                )
                .await?,
            );
        }
        let window = context_window.as_deref().unwrap_or_default();

        let delivery = if send.gateway_enabled {
            MENTION_JOB_METHOD_GATEWAY
        } else {
            "worker"
        };
        let payload =
            mention_job_payload(&trigger, agent, &routing, created.id, window, 0, delivery);
        let method = if send.gateway_enabled {
            MENTION_JOB_METHOD_GATEWAY
        } else {
            MENTION_JOB_METHOD_WORKER
        };
        let job_outbox_id = momo_outbox::emit_outbox(
            &mut *conn,
            send.workspace_id,
            momo_outbox::OutboxKind::AgentJob,
            method,
            &payload,
            // L4 §3.5: partition_key = agent_member_id is what serializes one
            // agent's turns; the worker's claim depends on it.
            Some(agent.member_id),
        )
        .await?;

        if send.gateway_enabled {
            let wake = mention_job_broadcast_payload(
                send.workspace_id,
                agent.member_id,
                job_outbox_id,
                created.id,
                &payload,
                send.hlc_ts,
            );
            momo_outbox::emit_outbox(
                &mut *conn,
                send.workspace_id,
                momo_outbox::OutboxKind::Broadcast,
                "publish",
                &wake,
                Some(agent.member_id),
            )
            .await?;
        }

        if let Some(ignored) = routing.ignored_model_pref.as_deref() {
            // ADR-0131 D2: an ignored inherited preference is only ever visible
            // as audit — never as a client error, and never silently.
            write_audit(
                &mut *conn,
                &AuditEntry::new(send.workspace_id, MODEL_PREF_IGNORED_ACTION)
                    .by(send.author_member_id)
                    .about(agent.member_id)
                    .target("agent_profile", agent.member_id)
                    .via_token(send.via_token_id)
                    .run(created.id)
                    .with_schema(
                        "momo.agent_profile.model_pref.ignored.v1",
                        serde_json::json!({
                            "requested_model": ignored,
                            "selected_model": routing.model,
                            "reason": "not_in_workspace_allowed_models",
                        }),
                    ),
            )
            .await?;
        }

        write_audit(
            &mut *conn,
            &AuditEntry::new(send.workspace_id, MENTION_QUEUED_ACTION)
                .by(send.author_member_id)
                .about(agent.member_id)
                .target("message", send.message_id)
                .via_token(send.via_token_id)
                .run(created.id)
                .with_schema(
                    MENTION_DIAGNOSTIC_SCHEMA,
                    mention_diagnostic_detail(
                        &trigger,
                        agent,
                        "queued",
                        Some(created.id),
                        Some(&idempotency_key),
                        Some(&routing),
                        send.routing,
                    ),
                ),
        )
        .await?;

        queued.push(QueuedMention {
            agent_member_id: agent.member_id,
            run_id: created.id,
            job_outbox_id,
        });
    }

    Ok(Ok(queued))
}

/// An audited no-op — Swift `insertMentionDiagnostic` (:2195-2228).
///
/// The audit row is the whole point: "the agent ignored me" and "the agent is
/// not in this channel" look identical from the timeline, and only this row can
/// tell an operator which one happened.
async fn skip(
    conn: &mut PgConnection,
    send: &MentionSend<'_>,
    trigger: &MentionTrigger<'_>,
    agent: &MentionCandidate,
    reason: &str,
) -> Result<(), DbError> {
    write_audit(
        conn,
        &AuditEntry::new(send.workspace_id, MENTION_SKIPPED_ACTION)
            .by(send.author_member_id)
            .about(agent.member_id)
            .target("message", send.message_id)
            .via_token(send.via_token_id)
            .with_schema(
                MENTION_DIAGNOSTIC_SCHEMA,
                // The requested routing is deliberately absent here (Swift
                // `insertMentionDiagnostic` :2205-2216 passes nil): a skipped
                // agent never reached the resolver, so recording a request it
                // was not judged against would read as though it had been.
                mention_diagnostic_detail(trigger, agent, reason, None, None, None, None),
            ),
    )
    .await?;
    Ok(())
}

/// A paused agent answers **visibly** — Swift `insertPausedMentionSystemLine`
/// (:1594-1658): a system line in the channel plus an audit row.
///
/// Swift writes that line with its own `channel_seq` bump and its own outbox
/// INSERT. Here it goes through [`send_message_in_tx`] instead — the same spine
/// a human's message uses — because this server has exactly one message write
/// path (invariant #3/#4) and a second hand-rolled seq bump would be the drift
/// that path exists to prevent. The row it produces is identical: `type=system`,
/// authored by the agent, with the same body and props.
async fn paused(
    conn: &mut PgConnection,
    send: &MentionSend<'_>,
    trigger: &MentionTrigger<'_>,
    agent: &MentionCandidate,
) -> Result<(), DbError> {
    let sent = send_message_in_tx(
        &mut *conn,
        send.workspace_id,
        NewMessage {
            channel_id: send.channel_id,
            author_member_id: agent.member_id,
            message_type: MessageType::System,
            body: Some(paused_mention_body(&agent.display_name)),
            props: paused_mention_props(agent.member_id, send.message_id),
            root_id: None,
            reply_to_id: None,
            // Keyed on the trigger, so a replayed send cannot stack two identical
            // "is paused" lines into the channel.
            client_msg_id: Some(send.message_id),
            run_id: None,
            hlc_ts: None,
            hlc_count: None,
        },
    )
    .await?;

    let mut detail =
        mention_diagnostic_detail(trigger, agent, "agent_paused", None, None, None, None);
    if let Some(object) = detail.as_object_mut() {
        object.insert(
            "system_message_id".into(),
            serde_json::json!(sent.message.id),
        );
    }
    write_audit(
        conn,
        &AuditEntry::new(send.workspace_id, MENTION_PAUSED_ACTION)
            .by(send.author_member_id)
            .about(agent.member_id)
            .target("message", send.message_id)
            .via_token(send.via_token_id)
            .with_schema(MENTION_DIAGNOSTIC_SCHEMA, detail),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two `outbox.method` values are a contract with two different
    /// consumers, and picking the wrong one makes every mention stall silently:
    /// `momo_outbox::claim_agent_job_batch` (the in-process worker) matches
    /// `method = 'publish'` **exactly**, and the gateway claim matches
    /// `'gateway'`. Pinned here because the branch that chooses between them is
    /// a one-line `if`.
    #[test]
    fn the_job_method_matches_the_consumer_that_claims_it() {
        assert_eq!(MENTION_JOB_METHOD_WORKER, momo_outbox::WORKER_JOB_METHOD);
        assert_ne!(MENTION_JOB_METHOD_WORKER, MENTION_JOB_METHOD_GATEWAY);
    }

    /// One audit schema across queued/skipped/paused, so a single query answers
    /// "what happened to this @mention" instead of three shapes a reader unions.
    #[test]
    fn every_mention_outcome_shares_one_detail_schema() {
        let actions = [
            MENTION_QUEUED_ACTION,
            MENTION_SKIPPED_ACTION,
            MENTION_PAUSED_ACTION,
        ];
        let mut unique = actions.to_vec();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(
            unique.len(),
            actions.len(),
            "each outcome is its own action"
        );
        assert!(MENTION_DIAGNOSTIC_SCHEMA.ends_with(".v0"));
    }
}
