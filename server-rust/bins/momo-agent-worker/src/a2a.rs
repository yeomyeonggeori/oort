//! Agent-authored mention → the next agent's run, inside the turn transaction
//! (B7.2).
//!
//! This module is the **mirror image** of
//! `momo-server/src/routes/agent_mentions.rs`: the same four owners' statements
//! composed in the same order — `agent_run` (`momo-agent`), the outbox job
//! (`momo-outbox`), a system line (`momo-messaging`) and `audit_log`
//! (`momo-db`) — and, like that module, it owns **no SQL**; it owns the order.
//! Keeping the two symmetric is the point: a human's `@hermes` and an agent's
//! `@atlas` must produce the same kind of run, or the two surfaces will drift
//! into disagreeing about what a mention means.
//!
//! ## What the worker has that the route did not
//!
//! B5.2 refuses an agent-authored mention (`a2a_source_run_unavailable`) because
//! the HTTP send path has no source run *this crate can trust as a parent*: the
//! child would have to be created at `depth = 0` and the hop cap would be
//! unenforceable. **Here the source run is the thing being committed.** The
//! child therefore gets a real `parent_run_id` and `depth = parent + 1`, which
//! is what makes every cap in [`momo_agent::a2a`] enforceable rather than
//! decorative.
//!
//! ADR-0158 D5 gave the HTTP path a `runId` it validates (the run exists, is in
//! this workspace, and belongs to the caller), which narrows but does not close
//! that gap: a validated *authorship* binding is not a validated *parentage*
//! claim, and treating it as one would hand hop-depth selection to the producer
//! being capped. The route's skip therefore stands until a decision says
//! otherwise.
//!
//! ## Where it runs, and why exactly there
//!
//! [`route_a2a_mentions_in_tx`] is called from `AgentWorker::commit_turn`,
//! inside the same transaction, and **after**
//! `finish_run_in_tx` + `record_run_usage_in_tx`. All three positions are
//! load-bearing:
//!
//! * *inside the transaction* — the reply and the run it triggers commit
//!   together, so a rolled-back turn cannot leave a delegated run pointing at a
//!   message nobody can read;
//! * *after the ledger row* — the chain ceiling must see the money **this** turn
//!   just spent, or a chain would always be judged one turn stale and could
//!   overshoot its budget by its own last hop;
//! * *only when the reply actually inserted* (`!sent.deduped`) and only for a
//!   `Succeeded` turn — a re-claimed job must not spawn a second child (the
//!   `mention:<message>:<agent>` key would stop the run, but not the audit row
//!   or the step it consumes), and a provider-failure notice must not delegate
//!   the failure to somebody else.

use momo_agent::{
    consume_run_step_in_tx, create_agent_run_in_tx, evaluate_a2a_spawn, inherited_depth,
    load_a2a_gate_snapshot_in_tx, load_mention_candidates_in_tx, mention_diagnostic_detail,
    mention_job_broadcast_payload, mention_job_payload, mention_run_input, paused_mention_body,
    paused_mention_props, resolve_mention_routing, A2aBlock, A2aLimits, MentionCandidate,
    MentionTrigger, NewAgentRun, RunTrigger,
};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{DbError, PgConnection};
use momo_messaging::{
    agent_auto_reply_streak_in_tx, agent_context_window_in_tx, contains_mention,
    send_message_in_tx, MessageType, NewMessage,
};
use serde_json::Value;
use uuid::Uuid;

/// `audit_log.detail.schema` — the **same** schema B5.2's three mention outcomes
/// share (`routes::agent_mentions::MENTION_DIAGNOSTIC_SCHEMA`). One query
/// answers "what happened to this @mention" whether a human or an agent wrote
/// it; a second schema here would make an operator union two shapes to ask one
/// question.
const MENTION_DIAGNOSTIC_SCHEMA: &str = "momo.agent_mention.diagnostic.v0";
const MENTION_QUEUED_ACTION: &str = "agent.mention.queued";
const MENTION_SKIPPED_ACTION: &str = "agent.mention.skipped";
const MENTION_PAUSED_ACTION: &str = "agent.mention.paused";

/// The reply that might delegate, and everything the routing needs about it.
#[derive(Debug, Clone, Copy)]
pub struct A2aSend<'a> {
    pub workspace_id: Uuid,
    pub channel_id: Uuid,
    /// The agent's own reply — the trigger message of any child run.
    pub message_id: Uuid,
    pub message_seq: i64,
    /// The agent that just answered: the *author* of this mention.
    pub author_agent_member_id: Uuid,
    /// The run that produced the reply — the child's `parent_run_id`.
    pub source_run_id: Uuid,
    pub body: &'a str,
    pub hlc_ts: i64,
    /// `agent_job.method` for the child: `publish` (this worker) or `gateway`
    /// (a BYOA adapter), resolved from `AGENT_GATEWAY_MODE` exactly as the
    /// server's send path resolves it.
    pub gateway_enabled: bool,
    pub context_max_messages: i64,
    pub limits: A2aLimits,
}

/// One agent that got a run out of this reply.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DelegatedMention {
    pub agent_member_id: Uuid,
    pub run_id: Uuid,
    pub job_outbox_id: i64,
    pub depth: i32,
}

/// What one A2A routing pass did — the unit the conformance suite asserts on.
#[derive(Debug, Clone, Default)]
pub struct A2aRouting {
    pub delegated: Vec<DelegatedMention>,
    /// Every refusal, with the block that produced it. Present in the return
    /// value as well as in `audit_log` so a test can name the cap that held
    /// without parsing Korean out of a channel.
    pub blocked: Vec<(Uuid, A2aBlock)>,
}

/// Route every agent mentioned in an agent's reply.
///
/// **Nothing here can fail the turn.** Every refusal — not a channel member,
/// paused, a tripped gate, a spent budget — is an audited no-op, and the visible
/// ones also leave a system line. That is B5.2's shape and the reason is the
/// same one: the reply is already written, and rejecting it because of how
/// somebody else configured a third agent would lose an answer a user asked for.
/// Only a database error propagates, and that rolls the whole turn back for
/// retry.
pub async fn route_a2a_mentions_in_tx(
    conn: &mut PgConnection,
    send: A2aSend<'_>,
) -> Result<A2aRouting, DbError> {
    let mut routing = A2aRouting::default();
    if send.body.trim().is_empty() {
        return Ok(routing);
    }

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
        return Ok(routing);
    }

    let trigger = MentionTrigger {
        workspace_id: send.workspace_id,
        channel_id: send.channel_id,
        message_id: send.message_id,
        message_seq: send.message_seq,
        author_member_id: send.author_agent_member_id,
        body: send.body,
        hlc_ts: send.hlc_ts,
    };

    // One window for the whole reply, read lazily — same rule as B5.2: every
    // agent mentioned in the same utterance sees the same channel.
    let mut context_window: Option<Vec<Value>> = None;

    for agent in &mentioned {
        // An agent mentioning itself. Not a Swift gate (Swift has no A2A spawn),
        // but the degenerate case this spawn point creates: the reply is a new
        // message every time, so the `mention:<message>:<agent>` key never
        // collides and only G2 would stop it — three provider calls later.
        if agent.member_id == send.author_agent_member_id {
            let block = A2aBlock::SelfMention;
            skip(&mut *conn, &send, &trigger, agent, &block).await?;
            routing.blocked.push((agent.member_id, block));
            continue;
        }
        if !agent.is_channel_member {
            // Reuses B5.2's reason code verbatim: the fact ("this agent is not
            // in the channel") is identical whoever asked, and a parallel
            // `a2a_*` spelling would split one diagnostic into two.
            skip_reason(
                &mut *conn,
                &send,
                &trigger,
                agent,
                "agent_not_channel_member",
                None,
            )
            .await?;
            continue;
        }
        if agent.hosted_delivery_disabled {
            skip_reason(
                &mut *conn,
                &send,
                &trigger,
                agent,
                "hosted_delivery_not_enabled",
                None,
            )
            .await?;
            continue;
        }
        if agent.paused {
            paused(&mut *conn, &send, &trigger, agent).await?;
            continue;
        }

        // The gates. G2's counter is a `message` read, so it comes from
        // momo-messaging and is handed to the policy — see `momo_agent::a2a`.
        let streak =
            agent_auto_reply_streak_in_tx(&mut *conn, send.channel_id, agent.member_id).await?;
        let snapshot = load_a2a_gate_snapshot_in_tx(
            &mut *conn,
            send.workspace_id,
            send.source_run_id,
            agent.member_id,
            streak,
            &send.limits,
        )
        .await?;
        let Some(snapshot) = snapshot else {
            // No source run, or the target is not a dispatchable agent. Fail
            // closed with B5.2's own reason: without the source run there is no
            // depth to inherit, which is the exact sentence that module wrote.
            skip_reason(
                &mut *conn,
                &send,
                &trigger,
                agent,
                "a2a_source_run_unavailable",
                None,
            )
            .await?;
            continue;
        };
        if let Err(block) = evaluate_a2a_spawn(&snapshot, &send.limits) {
            blocked(&mut *conn, &send, &trigger, agent, &block).await?;
            routing.blocked.push((agent.member_id, block));
            continue;
        }
        let Some(depth) = inherited_depth(snapshot.source_depth, &send.limits) else {
            // Unreachable while `evaluate_a2a_spawn` checks the same predicate,
            // and kept as the second half of the belt-and-suspenders pair Swift
            // describes: the depth that reaches the INSERT is the one this
            // function returned, never one derived a second way.
            let block = A2aBlock::Depth {
                source_depth: snapshot.source_depth,
                max_depth: send.limits.max_depth,
            };
            blocked(&mut *conn, &send, &trigger, agent, &block).await?;
            routing.blocked.push((agent.member_id, block));
            continue;
        };

        // G3's write half. The predicate is inside the UPDATE, so the step is
        // spent atomically or not at all; `false` means another writer took the
        // last one between the snapshot and here, and the honest answer is the
        // same refusal the snapshot would have given.
        let step_cap = snapshot.source_max_steps.min(send.limits.max_steps);
        if !consume_run_step_in_tx(&mut *conn, send.source_run_id, step_cap).await? {
            let block = A2aBlock::StepCap {
                step_count: snapshot.source_step_count,
                max: step_cap,
            };
            blocked(&mut *conn, &send, &trigger, agent, &block).await?;
            routing.blocked.push((agent.member_id, block));
            continue;
        }

        // A2A never carries a per-request routing tier: nobody made a request.
        // The agent's own profile decides, and an unusable preference is
        // ignored + audited exactly as it is on the human path (ADR-0131 D2) —
        // which is why this cannot return the `Err` the route has to surface.
        let routing_choice = match resolve_mention_routing(agent, None) {
            Ok(resolved) => resolved,
            Err(invalid) => {
                // Structurally unreachable (every refusal in the chain belongs
                // to the request tier, and there is no request here), but an
                // `expect` inside a worker turn would be a panic in a
                // transaction. Record it and move on.
                skip_reason(
                    &mut *conn,
                    &send,
                    &trigger,
                    agent,
                    "a2a_routing_unresolvable",
                    Some(invalid.to_string()),
                )
                .await?;
                continue;
            }
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
                // The two columns that make the whole chain answerable from SQL:
                // `agent_run_chain_idx` (001:297) indexes `parent_run_id`, so
                // "what did this trigger set off" is one recursive query.
                parent_run_id: Some(send.source_run_id),
                max_steps: agent.max_run_steps,
                depth,
                input: mention_run_input(
                    &trigger,
                    agent.member_id,
                    &idempotency_key,
                    Some(send.source_run_id),
                    depth,
                    None,
                ),
            },
        )
        .await?;
        if !created.created {
            // This reply already produced a run for this agent. No second job
            // and no second audit row, same as B5.2.
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
            momo_agent::MENTION_JOB_METHOD_GATEWAY
        } else {
            "worker"
        };
        let payload = mention_job_payload(
            &trigger,
            agent,
            &routing_choice,
            created.id,
            window,
            depth,
            delivery,
        );
        let method = if send.gateway_enabled {
            momo_agent::MENTION_JOB_METHOD_GATEWAY
        } else {
            momo_agent::MENTION_JOB_METHOD_WORKER
        };
        let job_outbox_id = momo_outbox::emit_outbox(
            &mut *conn,
            send.workspace_id,
            momo_outbox::OutboxKind::AgentJob,
            method,
            &payload,
            // L4 §3.5: the partition key serializes one agent's turns. A
            // delegated turn is still that agent's turn.
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

        let mut detail = mention_diagnostic_detail(
            &trigger,
            agent,
            "queued",
            Some(created.id),
            Some(&idempotency_key),
            Some(&routing_choice),
            None,
        );
        if let Some(object) = detail.as_object_mut() {
            // The provenance the ticket asks for, on the audit row as well as on
            // the run: `depth`/`parent_run_id` answer "who asked this agent to
            // work" without joining anything.
            object.insert("a2a".into(), a2a_provenance(&send, depth));
        }
        write_audit(
            &mut *conn,
            &AuditEntry::new(send.workspace_id, MENTION_QUEUED_ACTION)
                .by(send.author_agent_member_id)
                .about(agent.member_id)
                .target("message", send.message_id)
                .run(created.id)
                .with_schema(MENTION_DIAGNOSTIC_SCHEMA, detail),
        )
        .await?;

        routing.delegated.push(DelegatedMention {
            agent_member_id: agent.member_id,
            run_id: created.id,
            job_outbox_id,
            depth,
        });
    }

    Ok(routing)
}

/// `detail.a2a` — the causality of one delegation, in the shape the run row also
/// carries.
fn a2a_provenance(send: &A2aSend<'_>, depth: i32) -> Value {
    serde_json::json!({
        "parent_run_id": send.source_run_id.to_string().to_uppercase(),
        "depth": depth,
        "max_depth": send.limits.max_depth,
        "author_agent_member_id": send.author_agent_member_id.to_string().to_uppercase(),
    })
}

/// A refused delegation: the audit row **and** — for every real cap — a system
/// line in the channel.
///
/// The line is not decoration. "the other agent never answered" and "the other
/// agent was not allowed to start" look identical from the timeline, and a
/// person watching two agents work has no `audit_log` to read.
async fn blocked(
    conn: &mut PgConnection,
    send: &A2aSend<'_>,
    trigger: &MentionTrigger<'_>,
    agent: &MentionCandidate,
    block: &A2aBlock,
) -> Result<(), DbError> {
    if !block.is_visible() {
        return skip(conn, send, trigger, agent, block).await;
    }
    let sent = send_message_in_tx(
        &mut *conn,
        send.workspace_id,
        NewMessage {
            channel_id: send.channel_id,
            author_member_id: send.author_agent_member_id,
            message_type: MessageType::System,
            body: Some(block.system_line(&agent.display_name)),
            props: a2a_block_props(send, agent, block),
            root_id: None,
            reply_to_id: None,
            // Keyed on the reply that carried the mention, so a re-claimed job
            // cannot stack two identical refusals into the channel. `client_msg_id`
            // is unique per `(channel, author, id)`, and the author here is the
            // delegating agent — one line per reply, which is the right grain
            // when one reply mentions several blocked agents.
            client_msg_id: Some(send.message_id),
            run_id: Some(send.source_run_id),
            hlc_ts: None,
            hlc_count: None,
        },
    )
    .await?;

    let mut detail =
        mention_diagnostic_detail(trigger, agent, block.reason_code(), None, None, None, None);
    if let Some(object) = detail.as_object_mut() {
        object.insert("a2a".into(), block.detail());
        object.insert(
            "system_message_id".into(),
            serde_json::json!(sent.message.id),
        );
        object.insert(
            "parent_run_id".into(),
            serde_json::json!(send.source_run_id.to_string().to_uppercase()),
        );
    }
    write_audit(
        conn,
        &AuditEntry::new(send.workspace_id, MENTION_SKIPPED_ACTION)
            .by(send.author_agent_member_id)
            .about(agent.member_id)
            .target("message", send.message_id)
            .run(send.source_run_id)
            .with_schema(MENTION_DIAGNOSTIC_SCHEMA, detail),
    )
    .await?;
    Ok(())
}

/// `props` for the refusal line. Same convention as `paused_mention_props`:
/// lowercase ids, a `kind` a client can branch on instead of matching Korean.
fn a2a_block_props(send: &A2aSend<'_>, agent: &MentionCandidate, block: &A2aBlock) -> Value {
    serde_json::json!({
        "kind": "a2a_blocked",
        "reason": block.reason_code(),
        "agent_member_id": agent.member_id.to_string(),
        "source_message_id": send.message_id.to_string(),
        "parent_run_id": send.source_run_id.to_string(),
        "a2a": block.detail(),
    })
}

/// An audited no-op with a block's reason and no channel line.
async fn skip(
    conn: &mut PgConnection,
    send: &A2aSend<'_>,
    trigger: &MentionTrigger<'_>,
    agent: &MentionCandidate,
    block: &A2aBlock,
) -> Result<(), DbError> {
    let mut detail =
        mention_diagnostic_detail(trigger, agent, block.reason_code(), None, None, None, None);
    if let Some(object) = detail.as_object_mut() {
        object.insert("a2a".into(), block.detail());
    }
    write_audit(
        conn,
        &AuditEntry::new(send.workspace_id, MENTION_SKIPPED_ACTION)
            .by(send.author_agent_member_id)
            .about(agent.member_id)
            .target("message", send.message_id)
            .run(send.source_run_id)
            .with_schema(MENTION_DIAGNOSTIC_SCHEMA, detail),
    )
    .await?;
    Ok(())
}

/// An audited no-op under a plain reason string (B5.2's own codes).
async fn skip_reason(
    conn: &mut PgConnection,
    send: &A2aSend<'_>,
    trigger: &MentionTrigger<'_>,
    agent: &MentionCandidate,
    reason: &str,
    note: Option<String>,
) -> Result<(), DbError> {
    let mut detail = mention_diagnostic_detail(trigger, agent, reason, None, None, None, None);
    if let Some(object) = detail.as_object_mut() {
        object.insert(
            "parent_run_id".into(),
            serde_json::json!(send.source_run_id.to_string().to_uppercase()),
        );
        if let Some(note) = note {
            object.insert("note".into(), serde_json::json!(note));
        }
    }
    write_audit(
        conn,
        &AuditEntry::new(send.workspace_id, MENTION_SKIPPED_ACTION)
            .by(send.author_agent_member_id)
            .about(agent.member_id)
            .target("message", send.message_id)
            .run(send.source_run_id)
            .with_schema(MENTION_DIAGNOSTIC_SCHEMA, detail),
    )
    .await?;
    Ok(())
}

/// A paused target answers visibly — the same line B5.2 writes for a human's
/// mention (`routes::agent_mentions::paused`), through the same message spine.
async fn paused(
    conn: &mut PgConnection,
    send: &A2aSend<'_>,
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
        object.insert(
            "parent_run_id".into(),
            serde_json::json!(send.source_run_id.to_string().to_uppercase()),
        );
    }
    write_audit(
        conn,
        &AuditEntry::new(send.workspace_id, MENTION_PAUSED_ACTION)
            .by(send.author_agent_member_id)
            .about(agent.member_id)
            .target("message", send.message_id)
            .run(send.source_run_id)
            .with_schema(MENTION_DIAGNOSTIC_SCHEMA, detail),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The audit surface B5.2 built must keep answering for A2A too: one schema,
    /// and the three actions a reader already knows. A new schema here would
    /// make "what happened to this @mention" a two-query question.
    #[test]
    fn a2a_records_under_the_same_audit_schema_the_human_path_uses() {
        assert_eq!(
            MENTION_DIAGNOSTIC_SCHEMA,
            "momo.agent_mention.diagnostic.v0"
        );
        for action in [
            MENTION_QUEUED_ACTION,
            MENTION_SKIPPED_ACTION,
            MENTION_PAUSED_ACTION,
        ] {
            assert!(action.starts_with("agent.mention."));
        }
    }

    /// The refusal line's props are a stable contract: a client that wants to
    /// render "delegation blocked" differently from "agent paused" branches on
    /// `kind`, never on the Korean sentence.
    #[test]
    fn the_refusal_props_name_the_cap_without_the_client_reading_korean() {
        let send = A2aSend {
            workspace_id: Uuid::from_u128(1),
            channel_id: Uuid::from_u128(2),
            message_id: Uuid::from_u128(3),
            message_seq: 7,
            author_agent_member_id: Uuid::from_u128(4),
            source_run_id: Uuid::from_u128(5),
            body: "@atlas 확인해줘",
            hlc_ts: 1_700_000_000_000,
            gateway_enabled: false,
            context_max_messages: 30,
            limits: A2aLimits::default(),
        };
        let agent = MentionCandidate {
            member_id: Uuid::from_u128(6),
            handle: "atlas".into(),
            display_name: "아틀라스".into(),
            base_model: "hermes-agent".into(),
            model_pref: None,
            effort_pref: None,
            system_prompt: None,
            tool_schema: serde_json::json!([]),
            enabled_tools: Vec::new(),
            config: serde_json::json!({}),
            max_run_steps: 50,
            workspace_settings: serde_json::json!({}),
            paused: false,
            hosted_delivery_disabled: false,
            is_channel_member: true,
        };
        let block = A2aBlock::Depth {
            source_depth: 3,
            max_depth: 3,
        };
        let props = a2a_block_props(&send, &agent, &block);
        assert_eq!(props["kind"], serde_json::json!("a2a_blocked"));
        assert_eq!(props["reason"], serde_json::json!("a2a_depth_cap"));
        assert_eq!(props["a2a"]["gate"], serde_json::json!("a2a_depth"));
        assert_eq!(
            props["parent_run_id"],
            serde_json::json!(send.source_run_id.to_string())
        );

        // The queued half records the causality the ticket asks to be traceable.
        let provenance = a2a_provenance(&send, 1);
        assert_eq!(provenance["depth"], serde_json::json!(1));
        assert_eq!(
            provenance["parent_run_id"],
            serde_json::json!(send.source_run_id.to_string().to_uppercase()),
            "ids on the wire are Foundation-uppercase, like every other id momo writes"
        );
    }
}
