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
//! ## B13 — the 1:1 DM rule (QA H7)
//!
//! A human alone in a DM with one agent no longer has to type `@handle`: in that
//! room there is nobody else the utterance could be for. The rule itself is
//! `momo_agent::dm`'s; this module composes it, and it composes it as a **union
//! with the explicit mentions** — see [`addressed_agents`], which is where the
//! "an `@mention` typed inside that DM is still one run" property lives.
//!
//! **Nothing about the safety posture moves.** A DM-addressed agent reaches
//! every gate below on exactly the path a named one takes; the two differ only
//! in *how the agent got onto the list*:
//!
//! | property | why the DM path cannot get around it |
//! |---|---|
//! | a paused agent stays silent | the `agent.paused` branch sits before the run and the DM rule does not touch it — same system line, still no run |
//! | G1/G2/G3, `a2a_depth`, the chain budget | those guard **agent-authored** delegation inside `momo-agent-worker`, and the DM rule refuses a non-human author outright (`DmAddressing::AuthorIsNotHuman`). What it produces is a human-triggered `depth = 0` run — the same thing an `@mention` has always produced |
//! | idempotency | the run key is still `mention:<message>:<agent>`, and the send's own `SentMessage::deduped` guard is upstream of this function |
//! | single write path, RLS FORCE, agent = member | untouched; this module still owns no SQL |
//!
//! The author gate is the load-bearing one, and it is deliberately doubled
//! (credential **and** roster). Two agents auto-answering each other in a DM
//! would be an unbounded loop in the one room where no A2A gate is watching —
//! the same danger that makes this module refuse agent-authored mentions with
//! `a2a_source_run_unavailable` below.
//!
//! ## ADR-0162 증보 5 W1~W3 — the thread-reply wake (#3851)
//!
//! A person's reply that addresses **no** agent, in a thread an agent opened,
//! wakes that agent ([`wake_thread_opener_in_tx`]). It is not a second router:
//! it is the "nobody was addressed" exit of this one, it passes the same
//! [`delivery_gate`] a mention passes, and it writes its turn through the same
//! [`enqueue_turn_in_tx`]. Three things differ, each on purpose:
//!
//! | | mention | wake |
//! |---|---|---|
//! | refusal | audit + a sentence in the timeline | audit only — nobody called the agent |
//! | run key / label | `mention:` / `mention`·`dm_implicit` | `thread_reply:` / `thread_reply` |
//! | a second reply before pickup | its own run | joins the waiting run (W2 합치기) |
//!
//! ## What is deliberately not ported (see the PR body)
//!
//! * **The Context Packet** (`context_packet_id` / `memory_refs`) — the memory
//!   plane is not on this server, and the B5.1 worker consumes neither.
//!   `tool_grants` is NOT that projection: it is the ADR-0113 증보 2 E5 app-grant
//!   evidence, written only for an agent with apps attached (#3945).
//! * **A2A causality.** An agent-authored mention needs the source run
//!   (`agent_run.input`'s `parent_run_id`/`depth`) to enforce the depth cap.
//!   Rather than create a depth-0 run — which would make the A2A hop cap
//!   unenforceable — an agent-authored mention is **skipped and audited**. Fail
//!   closed.
//!
//!   The original reason was that the send route refused `runId` outright, so on
//!   this path the source run had no name at all. ADR-0158 D5 removed that
//!   refusal — a REST send may now be bound to a validated run — and the skip
//!   nevertheless stays, deliberately: reading that binding as A2A *parentage*
//!   would let an out-of-process adapter choose its own hop depth, which is a cap
//!   semantics decision (`momo_agent::a2a`) rather than a wiring one. Serving
//!   `runId` made the follow-up possible; it did not make it correct by default.

use momo_agent::{
    connector_owner_notice_body, lock_and_find_recent_notice_in_tx, notice_root, notice_thread_key,
    owner_only_gate, subscription_notice_body, subscription_notice_props, SubscriptionNoticeKind,
    CLAUDE_SUBSCRIPTION_AGENT_PAUSED, SKIP_CONNECTOR_OWNER_NON_OWNER, SKIP_OWNER_ONLY_NON_OWNER,
    SKIP_PERSONAL_AGENT_CLIENT_SIGNS, SKIP_SUBSCRIPTION_AGENTS_DISABLED,
    SUBSCRIPTION_NOTICE_AUDIT_SCHEMA, SUBSCRIPTION_NOTICE_POSTED_ACTION,
    SUBSCRIPTION_NOTICE_THROTTLED_ACTION,
};
use momo_agent::{
    create_agent_run_in_tx, find_unclaimed_dm_run_in_tx, find_unclaimed_thread_run_in_tx,
    load_dm_audience_in_tx, load_mention_candidates_in_tx, load_thread_wake_target_in_tx,
    mention_diagnostic_detail, mention_job_broadcast_payload, mention_job_payload,
    mention_run_input, paused_mention_body, paused_mention_props, resolve_dm_addressing,
    resolve_mention_routing, stamp_addressing, Addressing, DmAddressing, MentionCandidate,
    MentionRouting, MentionTrigger, NewAgentRun, RequestedRouting, RunTrigger,
    MENTION_JOB_METHOD_GATEWAY, MENTION_JOB_METHOD_WORKER, THREAD_REPLY_WAKE_REASON,
};
use momo_agent::{
    hosted_skip_notice_body_with_owner, hosted_skip_notice_key, hosted_skip_notice_props,
    lock_and_find_recent_server_notice_in_tx, unapproved_dm_reason, HostedSkipReason, RecentNotice,
    HOSTED_SKIP_NOTICE_AUDIT_SCHEMA, HOSTED_SKIP_NOTICE_KIND, HOSTED_SKIP_NOTICE_POSTED_ACTION,
    HOSTED_SKIP_NOTICE_SOURCE, HOSTED_SKIP_NOTICE_THROTTLED_ACTION,
    HOSTED_SKIP_NOTICE_THROTTLE_SECONDS,
};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{sqlx, DbError, PgConnection};
use momo_messaging::{
    agent_context_window_for_member_in_tx, contains_mention_with_aliases, send_message_in_tx,
    send_thread_notice_in_tx, MessageType, NewMessage,
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
/// ADR-0162 증보 5 W1~W2 (#3851) — the thread-reply wake's three outcomes, on
/// the mention outcomes' diagnostic schema.
const THREAD_WAKE_QUEUED_ACTION: &str = "agent.thread_wake.queued";
const THREAD_WAKE_SKIPPED_ACTION: &str = "agent.thread_wake.skipped";
/// #4017 — a 1:1 DM message folded into the same agent's still-unclaimed
/// `dm_implicit` run instead of starting a second one.
const DM_COALESCED_ACTION: &str = "agent.dm.coalesced";
const THREAD_WAKE_COALESCED_ACTION: &str = "agent.thread_wake.coalesced";

/// Everything the routing needs about the message that triggered it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct MentionSend<'a> {
    pub workspace_id: Uuid,
    pub channel_id: Uuid,
    pub message_id: Uuid,
    pub message_seq: i64,
    /// The trigger's thread root, `None` for a top-level message. Where an
    /// ADR-0193 notice is posted and what its throttle calls "the same thread".
    pub root_id: Option<Uuid>,
    pub author_member_id: Uuid,
    /// `true` when the send came in on an agent bearer — the A2A branch.
    pub author_is_agent: bool,
    /// `true` only when the send came in on a **person's** bearer. Not merely
    /// `!author_is_agent`: the in-place channel-grant card (ADR-0162 증보 5 G1)
    /// is raised for a person's explicit call and for nothing else.
    pub author_is_human: bool,
    pub body: &'a str,
    pub hlc_ts: i64,
    pub via_token_id: Option<Uuid>,
    /// `AgentGatewaySettings::enabled` — the **instance-global** provider mode.
    /// It decides `outbox.method` and the realtime wake-up for managed/BYOA
    /// agents, and it decides nothing at all for a hosted one.
    pub gateway_enabled: bool,
    /// ADR-0162 HAP-E5's production feature gate
    /// (`AgentPortConfig::hosted_delivery_enabled`), closed until #1367.
    /// Closed means a hosted agent is skipped exactly as HAP-E3 skipped it —
    /// never routed to a managed provider instead.
    pub hosted_delivery_enabled: bool,
    /// ADR-0193 D6 (#2815) — `AgentPortConfig::subscription_agents_enabled`,
    /// the operator's kill switch for `owner_only` (subscription) agents.
    pub subscription_agents_enabled: bool,
    /// #3397 (결재 2026-10-03) — `AgentPortConfig::claude_subscription_agents_enabled`.
    /// Off (the default) means a Claude subscription agent is not dispatched
    /// to, whenever it was registered.
    pub claude_subscription_agents_enabled: bool,
    /// #3948 (ADR-0203 증보 K2·K4) — what the operator declared about Hermes's
    /// connectors, read from the server's environment. Only a 「커넥터 시험」
    /// agent is judged by it ([`momo_agent::connector_trial_stop`]).
    pub connector_trial: &'a momo_agent::ConnectorTrialAttest,
    pub context_max_messages: i64,
    /// ADR-0162 증보 5 G5 — `MentionSettings::hosted_inplace_grant_enabled`.
    pub inplace_grant_enabled: bool,
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
    // A workspace with no agents has nothing either path could address, so it
    // does not pay for the channel read below.
    if candidates.is_empty() {
        return Ok(Ok(Vec::new()));
    }

    // B13 / QA H7 — the 1:1 DM rule. Skipped entirely for an agent-authored
    // send: `resolve_dm_addressing` would answer `AuthorIsNotHuman` anyway, and
    // not asking is one fewer query on the A2A path.
    // Whether this room is a DM at all — the hosted skip line needs it (a DM
    // can never be approved for hosted delivery, so "approve this room" would
    // be a false sentence there).
    let mut in_dm = false;
    // ADR-0162 증보 2 B1 — only a DM of exactly two can be opened by the owner.
    let mut one_to_one_dm = false;
    let dm_target = if send.author_is_agent {
        None
    } else {
        let audience = load_dm_audience_in_tx(&mut *conn, send.channel_id).await?;
        in_dm = audience.is_dm;
        one_to_one_dm = audience.is_dm && audience.participants.len() == 2;
        match resolve_dm_addressing(&audience, send.author_member_id, send.author_is_agent) {
            DmAddressing::Addressed(agent_member_id) => Some(agent_member_id),
            // Every other verdict is an ordinary "no": a group channel, a human↔
            // human DM and an agent-authored send are all just messages that
            // mention whoever they mention.
            _ => None,
        }
    };

    let addressed = addressed_agents(&candidates, send.body, dm_target);
    if addressed.is_empty() {
        // ADR-0162 증보 5 W1 (#3851): nobody was addressed — neither named nor by
        // the DM rule — so this is the only exit where a plain thread reply may
        // wake the agent that opened the thread.
        let woken = wake_thread_opener_in_tx(&mut *conn, &send, &candidates).await?;
        return Ok(Ok(woken.into_iter().collect()));
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
    let mut queued = Vec::new();

    for (agent, addressing) in &addressed {
        let mut context_window: Option<Vec<Value>> = None;
        if send.author_is_agent {
            // See the module docs: without the source run there is no depth to
            // inherit, and a depth-0 A2A run would make the cap unenforceable.
            skip(
                &mut *conn,
                &send,
                &trigger,
                agent,
                *addressing,
                "a2a_source_run_unavailable",
            )
            .await?;
            continue;
        }
        if in_dm && !agent.is_channel_member && *addressing == Addressing::Mention {
            let mut proposed = agent.clone();
            proposed.is_channel_member = true;
            proposed.hosted_channel_approved = true;
            if dm_admission_invocable(&proposed, &send) {
                if let Err(invalid) = resolve_mention_routing(agent, send.routing) {
                    return Ok(Err(ApiError::bad_request(invalid.to_string())));
                }
                if super::dm_agents::propose_in_tx(conn, &send, agent).await? {
                    continue;
                }
            }
        }
        // The gate chain itself lives in [`delivery_gate`] so the thread-reply
        // wake (ADR-0162 증보 5 W1) passes **the same** gates in the same order.
        // What differs is only what a refusal says: a mention is a human calling
        // this agent, so each refusal below tells them why in the timeline; a
        // wake is not, so it refuses silently ([`wake_thread_opener_in_tx`]).
        let gate = delivery_gate(agent, &send);
        let hosted_connection_id = match gate {
            DeliveryGate::Open {
                hosted_connection_id,
            } => hosted_connection_id,
            // ADR-0198 증보 1 D7 (#3592) — see [`DeliveryGate::PersonalAgent`].
            //   * a teammate → the existing `NonOwner` sentence, nothing started;
            //   * the owner  → an audited no-op (`personal_agent_client_signs`).
            DeliveryGate::PersonalAgent(Some(kind)) => {
                skip(
                    &mut *conn,
                    &send,
                    &trigger,
                    agent,
                    *addressing,
                    gate.skip_reason(),
                )
                .await?;
                subscription_notice(&mut *conn, &send, agent, kind).await?;
                continue;
            }
            DeliveryGate::PersonalAgent(None) | DeliveryGate::NotChannelMember => {
                skip(
                    &mut *conn,
                    &send,
                    &trigger,
                    agent,
                    *addressing,
                    gate.skip_reason(),
                )
                .await?;
                continue;
            }
            // ADR-0193 D4·D6 (#2815) — a non-owner's call of a subscription
            // agent. The D4 sentence is not a delivery either (no job, no inbox
            // row, no model call), so it is posted even while
            // `MOMO_HOSTED_DELIVERY_ENABLED` is closed.
            DeliveryGate::OwnerOnly(kind) => {
                skip(
                    &mut *conn,
                    &send,
                    &trigger,
                    agent,
                    *addressing,
                    gate.skip_reason(),
                )
                .await?;
                subscription_notice(&mut *conn, &send, agent, kind).await?;
                continue;
            }
            // ADR-0113 증보 2 E3 (#3938) — a person other than the owner called
            // an agent that runs the owner's apps: no job, no inbox row, and one
            // sentence in the agent's name (throttled).
            DeliveryGate::ConnectorOwner(kind) => {
                skip(
                    &mut *conn,
                    &send,
                    &trigger,
                    agent,
                    *addressing,
                    gate.skip_reason(),
                )
                .await?;
                subscription_notice(&mut *conn, &send, agent, kind).await?;
                continue;
            }
            // #3948 — the owner called a stopped 「커넥터 시험」: no job, no inbox
            // row, one sentence in the agent's name naming what to fix.
            DeliveryGate::ConnectorTrial(stop) => {
                skip(
                    &mut *conn,
                    &send,
                    &trigger,
                    agent,
                    *addressing,
                    gate.skip_reason(),
                )
                .await?;
                subscription_notice(&mut *conn, &send, agent, stop.into()).await?;
                continue;
            }
            // Not a person: nobody called, so nothing is said.
            DeliveryGate::ConnectorOwnerNonPerson => {
                skip(
                    &mut *conn,
                    &send,
                    &trigger,
                    agent,
                    *addressing,
                    gate.skip_reason(),
                )
                .await?;
                continue;
            }
            DeliveryGate::HostedDeliveryNotEnabled => {
                skip(
                    &mut *conn,
                    &send,
                    &trigger,
                    agent,
                    *addressing,
                    gate.skip_reason(),
                )
                .await?;
                // #2871 — the audit row alone is invisible from the timeline.
                hosted_skip_notice(
                    &mut *conn,
                    &send,
                    agent,
                    HostedSkipReason::DeliveryNotEnabled,
                )
                .await?;
                continue;
            }
            DeliveryGate::HostedConnectionUnavailable => {
                skip(
                    &mut *conn,
                    &send,
                    &trigger,
                    agent,
                    *addressing,
                    gate.skip_reason(),
                )
                .await?;
                // ADR-0193 D5 — the owner called and there is no live
                // connection. The existing contract stands (no job, no new
                // queue), so only the sentence that promises the future is
                // true — and only while a relaunch can still finish the
                // pairing. An expired or disconnected connection gets nothing.
                if agent
                    .owner_only
                    .as_ref()
                    .is_some_and(|scope| scope.reconnectable)
                {
                    subscription_notice(
                        &mut *conn,
                        &send,
                        agent,
                        SubscriptionNoticeKind::OfflineNotQueued,
                    )
                    .await?;
                } else {
                    // #2871 — every other agent without a live connection
                    // (a workspace hosted agent, or a subscription agent whose
                    // connection expired or was disconnected and needs a new
                    // pairing) is told so, with the door that re-pairs it.
                    // Never both lines: they would share `client_msg_id`.
                    hosted_skip_notice(
                        &mut *conn,
                        &send,
                        agent,
                        HostedSkipReason::ConnectionUnavailable,
                    )
                    .await?;
                }
                continue;
            }
            DeliveryGate::HostedChannelUnapproved => {
                // ADR-0162 증보 5 G1 (#3857) — a person explicitly called the
                // agent in a live non-DM room its connection is not approved
                // for: raise the in-place 「이 채널에서 쓰기」 card with a held
                // run and NO job. Every other shape (the DM rule, a DM, an
                // agent's or a non-person's send, a paused agent, the door
                // switched off, the per-connection ceiling) keeps the line below.
                if let Some(connection_id) = agent.hosted_active_connection_id {
                    if send.inplace_grant_enabled
                        && send.author_is_human
                        && !send.author_is_agent
                        && !in_dm
                        && *addressing == Addressing::Mention
                        && !agent.paused
                    {
                        // The sender's own routing block is judged now, exactly as
                        // on the queued path: an impossible model is their 400.
                        if let Err(invalid) = resolve_mention_routing(agent, send.routing) {
                            return Ok(Err(ApiError::bad_request(invalid.to_string())));
                        }
                        if in_place_grant_card(&mut *conn, &send, &trigger, agent, connection_id)
                            .await?
                        {
                            continue;
                        }
                    }
                }
                skip(
                    &mut *conn,
                    &send,
                    &trigger,
                    agent,
                    *addressing,
                    gate.skip_reason(),
                )
                .await?;
                // A DM is not a channel an admin approves at confirm
                // (`kind <> 'dm'`). ADR-0162 증보 2: the owner's own 1:1 DM is
                // already open (never reaches here), a 1:1 DM with anyone else
                // waits for the owner, and a group DM never opens — each gets
                // the sentence that is true there and no door to a screen the
                // reader cannot use.
                hosted_skip_notice(
                    &mut *conn,
                    &send,
                    agent,
                    if in_dm {
                        unapproved_dm_reason(
                            one_to_one_dm,
                            // 증보 2 B6: a connection a non-owner confirmed
                            // carries no DM, so there is no owner to ask.
                            agent
                                .owner_member_id
                                .filter(|_| agent.hosted_confirmed_by_owner),
                            agent.owner_only.is_some(),
                            send.author_member_id,
                        )
                    } else {
                        HostedSkipReason::ChannelUnapproved
                    },
                )
                .await?;
                continue;
            }
            DeliveryGate::Paused => {
                paused(&mut *conn, &send, &trigger, agent, *addressing).await?;
                continue;
            }
        };

        // Eligibility first, routing second (Swift :1976-1986). Reversing the two
        // would answer "your model is not allowed" for a mention of an agent that
        // was never going to run — a true sentence about the wrong problem.
        let routing = match resolve_mention_routing(agent, send.routing) {
            Ok(routing) => routing,
            Err(invalid) => return Ok(Err(ApiError::bad_request(invalid.to_string()))),
        };
        // #4017 — 「ㅎㅇ」 then 「반가」: the person said one thing in two bubbles.
        // When the DM rule's turn for this agent has not been picked up yet, the
        // new message joins that turn's conversation (the job's
        // `recent_messages` is re-read, anchored on this message) and no second
        // run starts. A claimed turn is underway and its answer cannot take the
        // new message in, so that case falls through to a turn of its own. Only
        // a bare, top-level DM message qualifies: an `@mention` or a `routing`
        // block is a choice a queued turn did not make, and a thread reply would
        // be answered under the first message's thread. The folded turn keeps the
        // first message as its trigger (the answer quotes it); the later one is
        // read from the refreshed `recent_messages`.
        if *addressing == Addressing::DirectMessage
            && send.routing.is_none()
            && send.root_id.is_none()
        {
            if let Some(pending) = find_unclaimed_dm_run_in_tx(
                &mut *conn,
                send.workspace_id,
                agent.member_id,
                send.channel_id,
            )
            .await?
            {
                if context_window.is_none() {
                    context_window = Some(
                        agent_context_window_for_member_in_tx(
                            &mut *conn,
                            send.channel_id,
                            send.message_id,
                            send.context_max_messages,
                            Some(agent.member_id),
                        )
                        .await?,
                    );
                }
                let window = context_window.clone().unwrap_or_default();
                let refreshed = momo_outbox::refresh_pending_agent_job_recent_messages_in_tx(
                    &mut *conn,
                    send.workspace_id,
                    pending.job_outbox_id,
                    &Value::Array(window),
                )
                .await?;
                if refreshed {
                    let mut detail = mention_diagnostic_detail(
                        &trigger,
                        agent,
                        "coalesced_into_queued_run",
                        Some(pending.run_id),
                        None,
                        None,
                        None,
                    );
                    stamp_addressing(&mut detail, Addressing::DirectMessage);
                    write_audit(
                        &mut *conn,
                        &AuditEntry::new(send.workspace_id, DM_COALESCED_ACTION)
                            .by(send.author_member_id)
                            .about(agent.member_id)
                            .target("message", send.message_id)
                            .via_token(send.via_token_id)
                            .run(pending.run_id)
                            .with_schema(MENTION_DIAGNOSTIC_SCHEMA, detail),
                    )
                    .await?;
                    continue;
                }
            }
        }
        // The run key is the same on both addressing paths —
        // `mention:<message>:<agent>` — so an @mention and the DM rule pointing
        // at the same agent collapse into one run at the SoT even if the union
        // above ever let both through.
        if let Some(turn) = enqueue_turn_in_tx(
            &mut *conn,
            &send,
            &trigger,
            agent,
            Turn {
                trigger: RunTrigger::Mention {
                    message_id: send.message_id,
                    agent_member_id: agent.member_id,
                },
                addressing: *addressing,
                requested: send.routing,
                wake_reason: None,
                queued_action: MENTION_QUEUED_ACTION,
                announce_offline_queue: true,
            },
            hosted_connection_id,
            &routing,
            &mut context_window,
        )
        .await?
        {
            queued.push(turn);
        }
    }

    Ok(Ok(queued))
}

/// What the per-agent gate chain decided — the one place a mention and a
/// thread-reply wake (ADR-0162 증보 5 W1 「같은 관문」) both ask.
///
/// The variants are the refusals in the order [`delivery_gate`] checks them,
/// plus `Open`. Pure data: the side effects of a refusal (audit row, timeline
/// sentence) are the caller's, because they are exactly what differs between
/// the two callers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeliveryGate {
    /// ADR-0198 증보 1 D7 (#3592) — a personal agent is the owner's own harness
    /// on the owner's own Mac. The server never starts it from a message: the
    /// owner's client sends the message and then a signed spawn, so there is no
    /// run, no job and no outbox row here, whoever called. Checked BEFORE
    /// channel membership on purpose: the owner calls the alias from any room
    /// (결재 2026-10-08, 「소유자면 어디서나」), and a teammate's call must still
    /// be told whose agent this is. `Some` = a teammate's call (the `NonOwner`
    /// sentence); `None` = the owner's (an audited no-op).
    PersonalAgent(Option<SubscriptionNoticeKind>),
    /// Not an active member of the channel: a no-op, not an error.
    NotChannelMember,
    /// ADR-0193 D4·D6 (#2815) — a subscription agent is its owner's alone.
    /// Before every hosted-delivery question, on purpose: a non-owner's call is
    /// refused whatever the delivery state is.
    OwnerOnly(SubscriptionNoticeKind),
    /// ADR-0113 증보 2 E3 (#3938) — the agent runs its owner's connected apps
    /// and a **person** other than the owner called. Refused with the owner's
    /// name in one sentence (throttled like D6), nothing delivered.
    ConnectorOwner(SubscriptionNoticeKind),
    /// Same refusal, but the caller is not a person (an agent's A2A mention, a
    /// work host, a system or webhook-shaped author): nobody called, so nobody
    /// is told. Audit only.
    ConnectorOwnerNonPerson,
    /// #3948 (ADR-0203 증보 K2·K4) — the owner called, but the 「커넥터 시험」 is
    /// stopped right now (an attestation is gone, the workspace has more than one
    /// person, or an app lost the owner's grant). Re-measured on every delivery.
    /// No job, no inbox row, one sentence to the owner (throttled).
    ConnectorTrial(momo_agent::ConnectorTrialStop),
    /// ADR-0162 HAP-E5's production feature gate is closed.
    HostedDeliveryNotEnabled,
    /// A hosted agent with no ACTIVE, proved connection. Never a fallback to a
    /// managed provider: that would run the turn on a runtime nobody approved,
    /// and a *second* time when the connection came back.
    HostedConnectionUnavailable,
    /// The human confirmed the connection for a NAMED set of channels (HAP-E3)
    /// and this is not one of them. The claim re-checks this live and is the
    /// authority; refusing here means the job is never written at all.
    HostedChannelUnapproved,
    /// `agent_profile.paused`.
    Paused,
    /// Deliver. `Some` = the hosted connection to deliver to (a `gateway` job
    /// plus an inbox reference); `None` = the instance's managed/BYOA path.
    Open { hosted_connection_id: Option<Uuid> },
}

impl DeliveryGate {
    /// The `agent.mention.skipped` / `agent.thread_wake.skipped` audit reason.
    /// `Open` has none; `Paused` keeps the paused line's own reason.
    fn skip_reason(self) -> &'static str {
        match self {
            DeliveryGate::PersonalAgent(Some(_)) => SKIP_OWNER_ONLY_NON_OWNER,
            DeliveryGate::PersonalAgent(None) => SKIP_PERSONAL_AGENT_CLIENT_SIGNS,
            DeliveryGate::NotChannelMember => "agent_not_channel_member",
            DeliveryGate::OwnerOnly(SubscriptionNoticeKind::NonOwner) => SKIP_OWNER_ONLY_NON_OWNER,
            DeliveryGate::OwnerOnly(SubscriptionNoticeKind::ClaudePaused) => {
                CLAUDE_SUBSCRIPTION_AGENT_PAUSED
            }
            DeliveryGate::OwnerOnly(_) => SKIP_SUBSCRIPTION_AGENTS_DISABLED,
            DeliveryGate::ConnectorOwner(_) | DeliveryGate::ConnectorOwnerNonPerson => {
                SKIP_CONNECTOR_OWNER_NON_OWNER
            }
            DeliveryGate::ConnectorTrial(stop) => stop.skip_reason(),
            DeliveryGate::HostedDeliveryNotEnabled => HostedSkipReason::DeliveryNotEnabled.as_str(),
            DeliveryGate::HostedConnectionUnavailable => {
                HostedSkipReason::ConnectionUnavailable.as_str()
            }
            DeliveryGate::HostedChannelUnapproved => HostedSkipReason::ChannelUnapproved.as_str(),
            DeliveryGate::Paused => "agent_paused",
            DeliveryGate::Open { .. } => "open",
        }
    }
}

/// The per-agent gate chain, in the order the mention path has always applied
/// it: personal agent → channel membership → `owner_only` (ADR-0193 D4·D6·D18)
/// → the hosted per-agent delivery selector (ADR-0162 HAP-E5: feature gate,
/// active connection, exact-channel grant) → paused.
///
/// Delivery is a property of the AGENT, not of the instance: the hosted branch
/// is taken on the agent's own hosted state and never consults
/// `gateway_enabled`.
fn delivery_gate(agent: &MentionCandidate, send: &MentionSend<'_>) -> DeliveryGate {
    let owner_gate = || {
        owner_only_gate(
            agent.owner_only.as_ref(),
            agent.connector_owner.as_ref(),
            send.author_member_id,
            send.subscription_agents_enabled,
            send.claude_subscription_agents_enabled,
        )
    };
    if agent
        .owner_only
        .as_ref()
        .is_some_and(|scope| scope.personal_agent)
    {
        // `owner_only_gate` returns `None` for the owner of a personal agent, so
        // neither instance switch (#3626 L2) can refuse it here.
        // E3: a connector refusal keeps its own shape (silent for a non-person)
        // even on a personal agent.
        let gate = owner_gate();
        if gate == Some(SubscriptionNoticeKind::ConnectorNonOwner) {
            return connector_refusal(send);
        }
        return DeliveryGate::PersonalAgent(gate);
    }
    if !agent.is_channel_member {
        return DeliveryGate::NotChannelMember;
    }
    if let Some(kind) = owner_gate() {
        // E3: a connector refusal is judged first inside `owner_only_gate`;
        // whether anyone is told depends on who called. Only a person is.
        if kind == SubscriptionNoticeKind::ConnectorNonOwner {
            return connector_refusal(send);
        }
        return DeliveryGate::OwnerOnly(kind);
    }
    // #3948: the caller is the owner (a non-owner was refused above). A 「커넥터
    // 시험」 agent is delivered to only while all three facts still hold.
    if let Some(stop) = momo_agent::connector_trial_stop(
        agent
            .connector_owner
            .as_ref()
            .and_then(|connector| connector.trial.as_ref()),
        send.connector_trial,
    ) {
        return DeliveryGate::ConnectorTrial(stop);
    }
    let hosted_connection_id = if agent.hosted_delivery_disabled {
        if !send.hosted_delivery_enabled {
            return DeliveryGate::HostedDeliveryNotEnabled;
        }
        let Some(connection_id) = agent.hosted_active_connection_id else {
            return DeliveryGate::HostedConnectionUnavailable;
        };
        if !agent.hosted_channel_approved {
            return DeliveryGate::HostedChannelUnapproved;
        }
        Some(connection_id)
    } else {
        None
    };
    if agent.paused {
        return DeliveryGate::Paused;
    }
    DeliveryGate::Open {
        hosted_connection_id,
    }
}

/// E3: the refusal of a connector agent's non-owner caller. Only a person is
/// told; an agent, work host or system-shaped author is refused silently.
fn connector_refusal(send: &MentionSend<'_>) -> DeliveryGate {
    if send.author_is_human && !send.author_is_agent {
        DeliveryGate::ConnectorOwner(SubscriptionNoticeKind::ConnectorNonOwner)
    } else {
        DeliveryGate::ConnectorOwnerNonPerson
    }
}

/// What kind of turn [`enqueue_turn_in_tx`] is writing. Everything else about
/// the turn — run, job, inbox reference, wake broadcast, rail frame, audit — is
/// the same for a mention and a thread-reply wake (W4 「같은 어휘」).
struct Turn<'a> {
    trigger: RunTrigger,
    addressing: Addressing,
    /// The sender's own `routing` block — the mention's. A wake carries none:
    /// the sender did not address this agent, so nothing they sent is a choice
    /// about how it runs.
    requested: Option<&'a RequestedRouting>,
    /// `payload.wake_reason` (`work.wakeReason` on the Agent Port). `None` for a
    /// mention, whose payload shape is unchanged.
    wake_reason: Option<&'static str>,
    queued_action: &'static str,
    /// ADR-0193 D5's 「이어서 답할게요」 line for an offline subscription agent.
    /// Only a call earns that sentence; a wake (nobody called) stays silent.
    announce_offline_queue: bool,
}

/// The delegated user of an app-attached agent's job: the trigger's author, and
/// only when that author is the agent's connector owner. The delivery gates
/// already refuse anyone else on the mention and thread-wake paths; the
/// granted-card path rebuilds its job from a stored `author_member_id` with no
/// gate in between, so the check is repeated here rather than assumed.
fn delegated_app_user(agent: &MentionCandidate, author_member_id: Uuid) -> Option<Uuid> {
    agent
        .connector_owner
        .as_ref()
        .filter(|connector| connector.owner_member_id == author_member_id)
        .map(|_| author_member_id)
}

/// ADR-0113 증보 2 E5 (#3945): put the delegated user's live app consents on a
/// mention job — evidence and audit, never enforcement (that is the executing
/// path's job). Only an agent with apps attached gets the key; a job whose
/// author is not the connector owner gets an empty list.
async fn attach_app_tool_grants_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    trigger: &MentionTrigger<'_>,
    agent: &MentionCandidate,
    payload: &mut Value,
) -> Result<(), DbError> {
    if agent.connector_owner.is_none() {
        return Ok(());
    }
    let grants = match delegated_app_user(agent, trigger.author_member_id) {
        Some(member) => {
            momo_agent::load_app_tool_grants_in_tx(&mut *conn, workspace_id, member).await?
        }
        None => Vec::new(),
    };
    momo_agent::attach_tool_grants(payload, &grants);
    Ok(())
}

/// Write one agent turn inside the send transaction: run → job → hosted inbox
/// reference | managed wake broadcast → rail opening frame → audit.
///
/// `Ok(None)` is an idempotency hit: the unique `(workspace_id,
/// idempotency_key)` index says this trigger already produced a run. Swift
/// returns early on exactly this (`guard let first = rows.first`), so no second
/// job and no second audit row — otherwise a replay would queue a second turn
/// for an answer that already exists.
#[allow(clippy::too_many_arguments)]
async fn enqueue_turn_in_tx(
    conn: &mut PgConnection,
    send: &MentionSend<'_>,
    trigger: &MentionTrigger<'_>,
    agent: &MentionCandidate,
    turn: Turn<'_>,
    hosted_connection_id: Option<Uuid>,
    routing: &MentionRouting,
    context_window: &mut Option<Vec<Value>>,
) -> Result<Option<QueuedMention>, DbError> {
    let idempotency_key = turn.trigger.idempotency_key();
    let mut input = mention_run_input(
        trigger,
        agent.member_id,
        &idempotency_key,
        None,
        0,
        turn.requested,
    );
    stamp_addressing(&mut input, turn.addressing);
    let created = create_agent_run_in_tx(
        &mut *conn,
        send.workspace_id,
        NewAgentRun {
            channel_id: send.channel_id,
            trigger: turn.trigger,
            parent_run_id: None,
            max_steps: agent.max_run_steps,
            depth: 0,
            input,
        },
    )
    .await?;
    if !created.created {
        return Ok(None);
    }

    if context_window.is_none() {
        *context_window = Some(
            agent_context_window_for_member_in_tx(
                &mut *conn,
                send.channel_id,
                send.message_id,
                send.context_max_messages,
                Some(agent.member_id),
            )
            .await?,
        );
    }
    let window = context_window.as_deref().unwrap_or_default();

    // A hosted turn is a `gateway` job whatever the instance mode is: the
    // Agent Port's claim is the gateway claim's hosted branch, and using a
    // second method would need a second consumer.
    let hosted = hosted_connection_id.is_some();
    let delivery = if hosted || send.gateway_enabled {
        MENTION_JOB_METHOD_GATEWAY
    } else {
        "worker"
    };
    let mut payload = mention_job_payload(trigger, agent, routing, created.id, window, 0, delivery);
    attach_app_tool_grants_in_tx(&mut *conn, send.workspace_id, trigger, agent, &mut payload)
        .await?;
    if let (Some(reason), Some(object)) = (turn.wake_reason, payload.as_object_mut()) {
        object.insert("wake_reason".into(), Value::String(reason.to_string()));
    }
    let method = if hosted || send.gateway_enabled {
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

    // The hosted inbox reference for this job — **in this transaction**, so
    // a rolled-back mention takes the notification with it and a committed
    // job can never be invisible to the runtime that must claim it.
    //
    // Migration 071 is what makes the pair below safe to write: the FK now
    // binds `outbox.kind`, so the wake broadcast emitted a few lines down
    // for the managed path can never be mistaken for this job row, and the
    // job/run trigger requires `payload.run_id` to equal `created.id`.
    if let Some(connection_id) = hosted_connection_id {
        momo_messaging::append_job_reference_in_tx(
            &mut *conn,
            send.workspace_id,
            agent.member_id,
            connection_id,
            send.channel_id,
            job_outbox_id,
            created.id,
        )
        .await?;
    }

    // The realtime wake-up is the managed gateway's doorbell. A hosted
    // runtime is woken by its own inbox instead, and emitting a broadcast
    // row on the agent's partition key for it would put exactly the
    // kind-confusable row 071 now refuses next to every hosted job.
    if !hosted && send.gateway_enabled {
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

    // The opening frame (goal SRV-B3d). The run row exists and is queued;
    // this is what tells the rail WHEN the turn began, and it is the only
    // frame that can — `isRunOpening` reads nothing else, so a rail that
    // never sees one renders the badge with no elapsed clock.
    //
    // Emitted after the job so the FIFO on this channel reads the way the
    // turn happened, and inside the send transaction so a rolled-back
    // mention cannot leave a turn that never started showing as queued.
    crate::routes::shared::emit_rail_frame(
        &mut *conn,
        send.workspace_id,
        send.channel_id,
        &momo_agent::opening_agent_status_payload(
            momo_agent::AgentRunAddress {
                workspace_id: send.workspace_id,
                channel_id: send.channel_id,
                agent_member_id: agent.member_id,
                run_id: created.id,
            },
            send.hlc_ts,
        ),
    )
    .await?;

    // ADR-0193 D5 — the owner's call is queued on a live connection whose
    // CLI has not reached the Agent Port lately. The job above stays
    // pending (gateway jobs do not expire) and the next `oort_jobs_claim`
    // takes it, so 「이어서 답할게요」 is the true sentence.
    if turn.announce_offline_queue
        && hosted
        && agent
            .owner_only
            .as_ref()
            .is_some_and(|scope| !scope.recently_seen)
    {
        subscription_notice(
            &mut *conn,
            send,
            agent,
            SubscriptionNoticeKind::OfflineQueued,
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

    let mut queued_detail = mention_diagnostic_detail(
        trigger,
        agent,
        "queued",
        Some(created.id),
        Some(&idempotency_key),
        Some(routing),
        turn.requested,
    );
    stamp_addressing(&mut queued_detail, turn.addressing);
    write_audit(
        &mut *conn,
        &AuditEntry::new(send.workspace_id, turn.queued_action)
            .by(send.author_member_id)
            .about(agent.member_id)
            .target("message", send.message_id)
            .via_token(send.via_token_id)
            .run(created.id)
            .with_schema(MENTION_DIAGNOSTIC_SCHEMA, queued_detail),
    )
    .await?;

    Ok(Some(QueuedMention {
        agent_member_id: agent.member_id,
        run_id: created.id,
        job_outbox_id,
    }))
}

/// ADR-0162 증보 5 W1~W3 (#3851, 결재 「깨우기 (추천)」 2026-10-15) — a human's
/// reply that addressed **no** agent, in a thread an agent opened, wakes that
/// agent as a job.
///
/// Called only from [`route_agent_mentions_in_tx`]'s "nobody was addressed"
/// exit, so the mention path keeps precedence by construction (W1 ②: a reply
/// that mentions any agent — the opener included — is the mention path's, and a
/// 1:1 DM's bare utterance is the DM rule's). Its callers' own guards hold too:
/// a real insert (`!deduped`), a `text` message, a non-empty body.
///
/// Every refusal is **silent** — an audit row at most, never a timeline line,
/// never the in-place approval card (W1 「같은 관문… 조용히」, G6 ⑦·⑮): the
/// person replied in a thread, they did not call the agent.
///
/// The loop guard is doubled like the DM rule's: the agent **credential** is
/// refused here, and the **roster** (`member.kind = 'human'`) is required by
/// [`load_thread_wake_target_in_tx`]. Two agents answering each other in a
/// thread would otherwise wake each other forever.
async fn wake_thread_opener_in_tx(
    conn: &mut PgConnection,
    send: &MentionSend<'_>,
    candidates: &[MentionCandidate],
) -> Result<Option<QueuedMention>, DbError> {
    let Some(root_id) = send.root_id else {
        return Ok(None);
    };
    if send.author_is_agent {
        return Ok(None);
    }
    let Some(opener) = load_thread_wake_target_in_tx(
        &mut *conn,
        send.workspace_id,
        send.channel_id,
        root_id,
        send.message_id,
        send.message_seq,
        send.author_member_id,
    )
    .await?
    else {
        return Ok(None);
    };
    // A suspended or deleted opener is not a candidate: nobody to wake.
    let Some(agent) = candidates
        .iter()
        .find(|candidate| candidate.member_id == opener)
    else {
        return Ok(None);
    };
    // W3: the owner's switch. Off is silent and writes nothing at all — not
    // even an audit row per reply in a busy thread.
    if !agent.thread_reply_wake {
        return Ok(None);
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
    let gate = delivery_gate(agent, send);
    let DeliveryGate::Open {
        hosted_connection_id,
    } = gate
    else {
        wake_audit(
            &mut *conn,
            send,
            &trigger,
            agent,
            THREAD_WAKE_SKIPPED_ACTION,
            gate.skip_reason(),
            None,
        )
        .await?;
        return Ok(None);
    };

    // W2 합치기: a turn of this agent in this thread that nobody has picked up
    // yet takes this reply into the conversation it answers from.
    //
    // #3855 review: the job's `recent_messages` is a snapshot taken when it was
    // queued, and the managed worker and the gateway claim answer from that
    // snapshot alone — so folding the reply in without re-reading it would drop
    // the reply from every turn. The job row is locked by the lookup (claimers
    // skip it until this send commits), and the snapshot is re-read here,
    // anchored on this reply, in the same transaction.
    if let Some(pending) = find_unclaimed_thread_run_in_tx(
        &mut *conn,
        send.workspace_id,
        agent.member_id,
        send.channel_id,
        root_id,
    )
    .await?
    {
        let window = agent_context_window_for_member_in_tx(
            &mut *conn,
            send.channel_id,
            send.message_id,
            send.context_max_messages,
            Some(agent.member_id),
        )
        .await?;
        let refreshed = momo_outbox::refresh_pending_agent_job_recent_messages_in_tx(
            &mut *conn,
            send.workspace_id,
            pending.job_outbox_id,
            &Value::Array(window),
        )
        .await?;
        if refreshed {
            wake_audit(
                &mut *conn,
                send,
                &trigger,
                agent,
                THREAD_WAKE_COALESCED_ACTION,
                "coalesced_into_queued_run",
                Some(pending.run_id),
            )
            .await?;
            return Ok(None);
        }
        // Unreachable while the row lock holds; if the job was taken after
        // all, this reply gets a turn of its own rather than none.
    }

    // No request tier (see [`Turn::requested`]), so the agent's own preferences
    // decide; an unusable one is ignored-with-audit, exactly as for a mention.
    let routing = match resolve_mention_routing(agent, None) {
        Ok(routing) => routing,
        Err(_) => {
            wake_audit(
                &mut *conn,
                send,
                &trigger,
                agent,
                THREAD_WAKE_SKIPPED_ACTION,
                "routing_unavailable",
                None,
            )
            .await?;
            return Ok(None);
        }
    };
    let mut context_window = None;
    enqueue_turn_in_tx(
        &mut *conn,
        send,
        &trigger,
        agent,
        Turn {
            trigger: RunTrigger::ThreadReply {
                message_id: send.message_id,
                agent_member_id: agent.member_id,
            },
            addressing: Addressing::ThreadReply,
            requested: None,
            wake_reason: Some(THREAD_REPLY_WAKE_REASON),
            queued_action: THREAD_WAKE_QUEUED_ACTION,
            announce_offline_queue: false,
        },
        hosted_connection_id,
        &routing,
        &mut context_window,
    )
    .await
}

/// The audit row of a wake that did not start a turn. Same diagnostic schema
/// as the mention outcomes, so one query answers "what happened to this reply";
/// ids only — the reply's body is never copied into the audit detail.
async fn wake_audit(
    conn: &mut PgConnection,
    send: &MentionSend<'_>,
    trigger: &MentionTrigger<'_>,
    agent: &MentionCandidate,
    action: &'static str,
    reason: &str,
    run_id: Option<Uuid>,
) -> Result<(), DbError> {
    let mut detail = mention_diagnostic_detail(trigger, agent, reason, run_id, None, None, None);
    stamp_addressing(&mut detail, Addressing::ThreadReply);
    let mut entry = AuditEntry::new(send.workspace_id, action)
        .by(send.author_member_id)
        .about(agent.member_id)
        .target("message", send.message_id)
        .via_token(send.via_token_id)
        .with_schema(MENTION_DIAGNOSTIC_SCHEMA, detail);
    if let Some(run_id) = run_id {
        entry = entry.run(run_id);
    }
    write_audit(conn, &entry).await?;
    Ok(())
}

/// **Where the two ways of addressing an agent meet — and the only place they
/// are allowed to.**
///
/// A message can reach an agent two ways now: it named the agent (`@handle`, the
/// display name, or the id — `momo_messaging::contains_mention`), or it was said
/// in a 1:1 DM with that agent (`momo_agent::dm`). This is a **union keyed on
/// `member_id`**, never a concatenation:
///
/// * `@hermes 안녕` typed *inside the DM with hermes* satisfies both rules and
///   must still produce exactly **one** run. The `mention:<message>:<agent>` run
///   key would also collapse it at the INSERT, but only after a second
///   context-window read and a second audit row had already been spent — and
///   "the SoT will catch it" is not a reason to hand it a duplicate.
/// * the explicit mention **wins the label**: when a human typed the handle,
///   `addressing = "mention"` is the true record of what happened, and the DM
///   rule did not need to do anything.
/// * `dm_target` that is not a live agent candidate (suspended, deleted, or
///   simply not an agent) addresses nobody. Fail closed.
///
/// Pure so the composition can be pinned without a database — the docker gate is
/// not part of `cargo test`.
fn addressed_agents(
    candidates: &[MentionCandidate],
    body: &str,
    dm_target: Option<Uuid>,
) -> Vec<(MentionCandidate, Addressing)> {
    let mut addressed: Vec<(MentionCandidate, Addressing)> = candidates
        .iter()
        .filter(|candidate| {
            contains_mention_with_aliases(
                body,
                &candidate.handle,
                &candidate.display_name,
                candidate.member_id,
                &candidate.aliases,
            )
        })
        .cloned()
        .map(|candidate| (candidate, Addressing::Mention))
        .collect();

    if let Some(target) = dm_target {
        let already_named = addressed
            .iter()
            .any(|(candidate, _)| candidate.member_id == target);
        if !already_named {
            if let Some(counterpart) = candidates
                .iter()
                .find(|candidate| candidate.member_id == target)
            {
                addressed.push((counterpart.clone(), Addressing::DirectMessage));
            }
        }
    }
    addressed
}

// ---------------------------------------------------------------------------
// ADR-0162 증보 5 G1~G5 (#3857) — the in-place 「이 채널에서 쓰기」 card
// ---------------------------------------------------------------------------

/// Raise the in-place channel-grant card for one agent, inside the send
/// transaction. `Ok(true)` = handled (a card was raised, or an existing pending
/// card absorbed this call); `Ok(false)` = declined, and the caller writes the
/// old notice line instead.
///
/// What is written, in order (G2):
/// 1. the mention run, **born** `awaiting_approval` with `deadline_at` = the
///    approval's expiry and `input.hold = "channel_grant"`;
/// 2. one `workspace_action` approval of `hosted.channels.grant` naming exactly
///    this channel, proposer = the agent, `origin = "server_in_place"`;
/// 3. the `approval_request` card, in the thread the person spoke in.
///
/// **What is not:** an `agent_job`, a hosted inbox reference, a wake-up. The
/// prompt and the room's recent messages stay on this side of HAP-E3 until a
/// workspace admin approves this channel; the decision route writes the one
/// job ([`enqueue_granted_mention_job_in_tx`]).
///
/// One card per (connection, channel) while pending: a second call in the same
/// room is coalesced (audited, nothing else), and the person's message is still
/// there for the first job's recent-conversation window to read.
async fn in_place_grant_card(
    conn: &mut PgConnection,
    send: &MentionSend<'_>,
    trigger: &MentionTrigger<'_>,
    agent: &MentionCandidate,
    connection_id: Uuid,
) -> Result<bool, DbError> {
    use momo_agent::in_place_grant as grant;

    // Every producer of this connection serializes here for the rest of the
    // transaction (the per-connection ceiling below). One room's producers are
    // already serialized by its `channel_seq` row, which the send holds.
    grant::lock_in_place_grant_slot_in_tx(&mut *conn, connection_id).await?;

    if let Some(existing) = grant::pending_in_place_grant_in_tx(
        &mut *conn,
        send.workspace_id,
        agent.member_id,
        connection_id,
        send.channel_id,
    )
    .await?
    {
        write_audit(
            &mut *conn,
            &AuditEntry::new(send.workspace_id, grant::AUDIT_IN_PLACE_CARD_COALESCED)
                .by(send.author_member_id)
                .about(agent.member_id)
                .target("message", send.message_id)
                .via_token(send.via_token_id)
                .with_schema(
                    grant::AUDIT_IN_PLACE_CARD_SCHEMA,
                    serde_json::json!({
                        "approval_id": existing,
                        "channel_id": send.channel_id,
                        "trigger_message_id": send.message_id,
                    }),
                ),
        )
        .await?;
        return Ok(true);
    }
    if grant::count_pending_in_place_grants_in_tx(&mut *conn, send.workspace_id, connection_id)
        .await?
        >= grant::MAX_PENDING_IN_PLACE_GRANTS_PER_CONNECTION
    {
        return Ok(false);
    }
    // A DM, an archived room or a connection that stopped being active and
    // proved since the candidate read: the card would promise a grant the
    // decision could never make.
    let Some(facts) = grant::in_place_channel_facts_in_tx(
        &mut *conn,
        send.workspace_id,
        send.channel_id,
        connection_id,
    )
    .await?
    else {
        return Ok(false);
    };
    if facts.approved_before >= momo_auth::MAX_HOSTED_APPROVED_CHANNELS {
        return Ok(false);
    }
    let Some(action) =
        momo_agent::actions::action_by_id(momo_agent::actions::ACTION_HOSTED_CHANNELS_GRANT)
    else {
        return Ok(false);
    };

    let now = chrono::Utc::now();
    let expires_at = momo_agent::default_expires_at(now, momo_agent::DEFAULT_TTL_SECONDS);

    let run_trigger = RunTrigger::Mention {
        message_id: send.message_id,
        agent_member_id: agent.member_id,
    };
    let idempotency_key = run_trigger.idempotency_key();
    let mut input = mention_run_input(
        trigger,
        agent.member_id,
        &idempotency_key,
        None,
        0,
        send.routing,
    );
    stamp_addressing(&mut input, Addressing::Mention);
    grant::mark_held_for_channel_grant(&mut input);
    let created = momo_agent::create_held_agent_run_in_tx(
        &mut *conn,
        send.workspace_id,
        NewAgentRun {
            channel_id: send.channel_id,
            trigger: run_trigger,
            parent_run_id: None,
            max_steps: agent.max_run_steps,
            depth: 0,
            input,
        },
        expires_at,
    )
    .await?;
    if !created.created {
        // This trigger already produced its run (a replay the send's own
        // dedupe did not catch): nothing more to write, and no notice either.
        return Ok(true);
    }

    let approval_id = momo_agent::create_pending_approval_in_tx(
        &mut *conn,
        send.workspace_id,
        momo_agent::NewApproval {
            run_id: created.id,
            channel_id: send.channel_id,
            // The agent is the proposer of record: the grant widens ITS
            // connection, the resolver re-finds it from this id, and a decision
            // requires a human — so self-approval stays structurally impossible.
            requested_by: agent.member_id,
            action_type: momo_agent::ACTION_TYPE_WORKSPACE_ACTION.to_string(),
            payload: grant::in_place_grant_payload(
                agent.member_id,
                send.author_member_id,
                connection_id,
                send.channel_id,
                &facts.name,
                send.message_id,
            ),
            expires_at,
        },
    )
    .await?;

    let mut props = momo_agent::workspace_action_request_props(
        approval_id,
        created.id,
        send.channel_id,
        action,
        momo_agent::action_block(
            action,
            grant::in_place_grant_rows(&agent.display_name, &agent.handle, &facts),
            None,
        ),
        expires_at,
    );
    if let Some(object) = props.as_object_mut() {
        object.insert(
            "title".into(),
            Value::String(grant::IN_PLACE_GRANT_TITLE.into()),
        );
        object.insert(
            "summary".into(),
            Value::String(grant::IN_PLACE_GRANT_SUMMARY.into()),
        );
        object.insert(
            "origin".into(),
            Value::String(grant::APPROVAL_ORIGIN_SERVER_IN_PLACE.into()),
        );
        object.insert(
            "waiting_text".into(),
            Value::String(grant::IN_PLACE_GRANT_WAITING_TEXT.into()),
        );
        object.insert(
            "requested_for".into(),
            Value::String(send.author_member_id.to_string()),
        );
    }
    let card = send_thread_notice_in_tx(
        &mut *conn,
        send.workspace_id,
        NewMessage {
            channel_id: send.channel_id,
            author_member_id: agent.member_id,
            message_type: MessageType::ApprovalRequest,
            body: Some(grant::in_place_grant_body(&agent.display_name)),
            props,
            // Where the person spoke: their thread, or the main timeline.
            root_id: send.root_id,
            reply_to_id: None,
            // The same derived key an agent's proposal card uses, so the card
            // can never collide with this approval's own rejection or expiry
            // line (both keyed on `approval.id`, same author, same channel).
            client_msg_id: Some(momo_agent::card_client_msg_id(approval_id)),
            run_id: Some(created.id),
            hlc_ts: None,
            hlc_count: None,
        },
    )
    .await?;
    momo_agent::attach_request_message_in_tx(
        &mut *conn,
        send.workspace_id,
        approval_id,
        card.message.id,
    )
    .await?;

    write_audit(
        &mut *conn,
        &AuditEntry::new(send.workspace_id, grant::AUDIT_IN_PLACE_CARD_POSTED)
            .by(send.author_member_id)
            .about(agent.member_id)
            .target("approval", approval_id)
            .via_token(send.via_token_id)
            .run(created.id)
            .with_schema(
                grant::AUDIT_IN_PLACE_CARD_SCHEMA,
                serde_json::json!({
                    "approval_id": approval_id,
                    "run_id": created.id,
                    "channel_id": send.channel_id,
                    "connection_id": connection_id,
                    "trigger_message_id": send.message_id,
                    "card_message_id": card.message.id,
                }),
            ),
    )
    .await?;
    Ok(true)
}

/// The one `agent_job` an approved in-place card releases (ADR-0162 증보 5 G3-3).
///
/// Called by the decision route **only** after `requeue_run_from_approval_in_tx`
/// returned `true` in the same transaction — that guarded update is the single
/// gate, so a replayed or concurrent decision cannot reach here twice for one
/// run. Built exactly as the mention path builds a hosted job, from what the run
/// recorded at mention time and from the room **as it is now**: the recent
/// conversation is read at approval, so a call coalesced into the pending card
/// is in front of the agent on its first turn (증보 4 J5).
///
/// `Ok(None)` = the agent is no longer a deliverable candidate here; the caller
/// rolls the whole decision back rather than widen a grant with no job behind it.
pub(crate) async fn enqueue_granted_mention_job_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run: &momo_agent::AgentRunRow,
    connection_id: Uuid,
    context_max_messages: i64,
) -> Result<Option<i64>, DbError> {
    let candidates =
        load_mention_candidates_in_tx(&mut *conn, workspace_id, run.channel_id).await?;
    let Some(agent) = candidates
        .iter()
        .find(|candidate| candidate.member_id == run.agent_member_id)
    else {
        return Ok(None);
    };
    let Some(trigger_message_id) = run.trigger_message_id else {
        return Ok(None);
    };
    let text = |key: &str| run.input.get(key).and_then(Value::as_str);
    let body = text("prompt").unwrap_or_default().to_string();
    let Some(author_member_id) = text("author_member_id").and_then(|id| Uuid::parse_str(id).ok())
    else {
        return Ok(None);
    };
    let message_seq = run
        .input
        .get("source")
        .and_then(|source| source.get("message_seq"))
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let requested = run.input.get("routing").map(|routing| RequestedRouting {
        model: routing
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string),
        effort: routing
            .get("effort")
            .and_then(Value::as_str)
            .map(str::to_string),
    });
    // The request tier was judged when the person sent it (a bad one was their
    // 400 then). If the workspace allow-list narrowed while the card waited, the
    // hosted runtime picks its own model anyway; the agent tier decides.
    let routing = match resolve_mention_routing(agent, requested.as_ref()) {
        Ok(routing) => routing,
        Err(_) => match resolve_mention_routing(agent, None) {
            Ok(routing) => routing,
            Err(_) => return Ok(None),
        },
    };
    let now_ms = chrono::Utc::now().timestamp_millis();
    let trigger = MentionTrigger {
        workspace_id,
        channel_id: run.channel_id,
        message_id: trigger_message_id,
        message_seq,
        author_member_id,
        body: &body,
        hlc_ts: now_ms,
    };
    let window = agent_context_window_for_member_in_tx(
        &mut *conn,
        run.channel_id,
        trigger_message_id,
        context_max_messages,
        Some(agent.member_id),
    )
    .await?;
    let mut payload = mention_job_payload(
        &trigger,
        agent,
        &routing,
        run.id,
        &window,
        0,
        MENTION_JOB_METHOD_GATEWAY,
    );
    attach_app_tool_grants_in_tx(&mut *conn, workspace_id, &trigger, agent, &mut payload).await?;
    let job_outbox_id = momo_outbox::emit_outbox(
        &mut *conn,
        workspace_id,
        momo_outbox::OutboxKind::AgentJob,
        MENTION_JOB_METHOD_GATEWAY,
        &payload,
        Some(agent.member_id),
    )
    .await?;
    // The hosted inbox reference (and with it the doorbell), in this
    // transaction — the same pair the mention path writes for a hosted job.
    momo_messaging::append_job_reference_in_tx(
        &mut *conn,
        workspace_id,
        agent.member_id,
        connection_id,
        run.channel_id,
        job_outbox_id,
        run.id,
    )
    .await?;
    // The opening frame: the turn begins now, not when the card was raised.
    crate::routes::shared::emit_rail_frame(
        &mut *conn,
        workspace_id,
        run.channel_id,
        &momo_agent::opening_agent_status_payload(
            momo_agent::AgentRunAddress {
                workspace_id,
                channel_id: run.channel_id,
                agent_member_id: agent.member_id,
                run_id: run.id,
            },
            now_ms,
        ),
    )
    .await?;
    Ok(Some(job_outbox_id))
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
    addressing: Addressing,
    reason: &str,
) -> Result<(), DbError> {
    // The requested routing is deliberately absent here (Swift
    // `insertMentionDiagnostic` :2205-2216 passes nil): a skipped agent never
    // reached the resolver, so recording a request it was not judged against
    // would read as though it had been.
    let mut detail = mention_diagnostic_detail(trigger, agent, reason, None, None, None, None);
    stamp_addressing(&mut detail, addressing);
    write_audit(
        conn,
        &AuditEntry::new(send.workspace_id, MENTION_SKIPPED_ACTION)
            .by(send.author_member_id)
            .about(agent.member_id)
            .target("message", send.message_id)
            .via_token(send.via_token_id)
            .with_schema(MENTION_DIAGNOSTIC_SCHEMA, detail),
    )
    .await?;
    Ok(())
}

/// Post one ADR-0193 sentence in the agent's name, at most once per thread,
/// person, sentence and ten minutes.
///
/// The static-copy path of ADR-0181 D5 (`provider_required`): the server writes
/// a text message **authored by the agent member** through the single write
/// path — `channel_seq` bump, `message` INSERT, broadcast outbox INSERT, the
/// same transaction as the call that caused it. No run, no job, no model call,
/// so the owner's subscription is never spent on it; that is also why it works
/// for a hosted agent whose runtime is not there to speak. It is a `text`
/// message, not a `system` line: the sentence is the agent's, and a server
/// line dressed in the agent's name is the bot wrapping ADR-0181 refused.
///
/// `client_msg_id` is the trigger's id, so a replayed send cannot stack a
/// second copy even before the throttle is asked (`message_client_idem_uniq` is
/// per channel **and author**, so two agents never collide on it).
async fn subscription_notice(
    conn: &mut PgConnection,
    send: &MentionSend<'_>,
    agent: &MentionCandidate,
    kind: SubscriptionNoticeKind,
) -> Result<(), DbError> {
    // E3 (#3938): the connector sentence needs only the connector owner's name —
    // an agent that is not `owner_only` has no `OwnerOnlyScope` to read it from.
    let body = if let Some(stop) = kind.connector_trial_stop() {
        // #3948: the trial sentences name nobody; only the owner is ever told.
        momo_agent::connector_trial_notice_body(stop).to_string()
    } else if kind == SubscriptionNoticeKind::ConnectorNonOwner {
        let Some(connector) = agent.connector_owner.as_ref() else {
            return Ok(());
        };
        connector_owner_notice_body(&connector.owner_display_name)
    } else {
        let Some(scope) = agent.owner_only.as_ref() else {
            return Ok(());
        };
        subscription_notice_body(kind, scope)
    };
    let thread_key = notice_thread_key(send.channel_id, send.root_id);
    let recent = lock_and_find_recent_notice_in_tx(
        &mut *conn,
        send.workspace_id,
        agent.member_id,
        send.channel_id,
        thread_key,
        send.author_member_id,
        kind,
    )
    .await?;
    let detail = serde_json::json!({
        "notice": kind.as_str(),
        "channel_id": send.channel_id,
        "trigger_message_id": send.message_id,
        "thread_key": thread_key,
    });
    if recent {
        write_audit(
            &mut *conn,
            &AuditEntry::new(send.workspace_id, SUBSCRIPTION_NOTICE_THROTTLED_ACTION)
                .by(send.author_member_id)
                .about(agent.member_id)
                .target("message", send.message_id)
                .via_token(send.via_token_id)
                .with_schema(SUBSCRIPTION_NOTICE_AUDIT_SCHEMA, detail),
        )
        .await?;
        return Ok(());
    }
    let sent = send_thread_notice_in_tx(
        &mut *conn,
        send.workspace_id,
        NewMessage {
            channel_id: send.channel_id,
            author_member_id: agent.member_id,
            message_type: MessageType::Text,
            body: Some(body),
            props: subscription_notice_props(
                kind,
                send.author_member_id,
                thread_key,
                send.message_id,
            ),
            root_id: Some(notice_root(send.message_id, send.root_id)),
            reply_to_id: None,
            client_msg_id: Some(send.message_id),
            run_id: None,
            hlc_ts: None,
            hlc_count: None,
        },
    )
    .await?;
    let mut detail = detail;
    if let Some(object) = detail.as_object_mut() {
        object.insert(
            "notice_message_id".into(),
            serde_json::json!(sent.message.id),
        );
    }
    write_audit(
        &mut *conn,
        &AuditEntry::new(send.workspace_id, SUBSCRIPTION_NOTICE_POSTED_ACTION)
            .by(send.author_member_id)
            .about(agent.member_id)
            .target("message", send.message_id)
            .via_token(send.via_token_id)
            .with_schema(SUBSCRIPTION_NOTICE_AUDIT_SCHEMA, detail),
    )
    .await?;
    Ok(())
}

/// #2871 — say, in the conversation, why a hosted agent did not answer.
///
/// A `system` line authored by the agent member (the paused line's shape: a
/// server fact about the agent, not the agent speaking), written through the
/// single message path in the send's own transaction — `channel_seq` bump,
/// `message` INSERT, broadcast outbox INSERT. At most once per thread, person,
/// reason and [`HOSTED_SKIP_NOTICE_THROTTLE_SECONDS`]; a held-back line leaves
/// an audit row instead so "why only one line" is still answerable.
///
/// `client_msg_id` is the trigger's id, so a replayed send cannot stack a
/// second copy even before the throttle is asked.
async fn hosted_skip_notice(
    conn: &mut PgConnection,
    send: &MentionSend<'_>,
    agent: &MentionCandidate,
    reason: HostedSkipReason,
) -> Result<(), DbError> {
    let thread_key = notice_thread_key(send.channel_id, send.root_id);
    let key = hosted_skip_notice_key(
        agent.member_id,
        send.channel_id,
        thread_key,
        send.author_member_id,
        reason,
    );
    let recent = lock_and_find_recent_server_notice_in_tx(
        &mut *conn,
        RecentNotice {
            key: &key,
            workspace_id: send.workspace_id,
            channel_id: send.channel_id,
            author_member_id: agent.member_id,
            source: HOSTED_SKIP_NOTICE_SOURCE,
            kind_prop: "reason",
            kind: reason.as_str(),
            recipient_member_id: send.author_member_id,
            thread_key,
            window_seconds: HOSTED_SKIP_NOTICE_THROTTLE_SECONDS,
        },
    )
    .await?;
    let mut detail = serde_json::json!({
        "notice": HOSTED_SKIP_NOTICE_KIND,
        "reason": reason.as_str(),
        "channel_id": send.channel_id,
        "trigger_message_id": send.message_id,
        "thread_key": thread_key,
    });
    if recent {
        write_audit(
            &mut *conn,
            &AuditEntry::new(send.workspace_id, HOSTED_SKIP_NOTICE_THROTTLED_ACTION)
                .by(send.author_member_id)
                .about(agent.member_id)
                .target("message", send.message_id)
                .via_token(send.via_token_id)
                .with_schema(HOSTED_SKIP_NOTICE_AUDIT_SCHEMA, detail),
        )
        .await?;
        return Ok(());
    }
    let sent = send_thread_notice_in_tx(
        &mut *conn,
        send.workspace_id,
        NewMessage {
            channel_id: send.channel_id,
            author_member_id: agent.member_id,
            message_type: MessageType::System,
            body: Some(hosted_skip_notice_body_with_owner(
                reason,
                &agent.display_name,
                agent.owner_display_name.as_deref(),
            )),
            props: {
                let mut props = hosted_skip_notice_props(
                    reason,
                    agent.member_id,
                    send.author_member_id,
                    thread_key,
                    send.message_id,
                );
                // ADR-0113 증보 2 E8 (#4054): "no live connection" is the server's own
                // observation of a site that is off, said only for an agent that has
                // apps attached (the surface that reads this key). No `site`: a
                // hosted connection is not known to be a Mac or Hermes from here.
                if let (true, Some(notice), Some(object)) = (
                    reason == HostedSkipReason::ConnectionUnavailable,
                    momo_agent::connection_unavailable_app_notice(agent.connector_owner.is_some()),
                    props.as_object_mut(),
                ) {
                    object.insert(momo_agent::PROP_APP_NOTICE.into(), notice.to_json());
                }
                props
            },
            // Where the caller spoke: the thread they were in, or the main
            // timeline right under their message (the paused line's place).
            root_id: send.root_id,
            reply_to_id: None,
            client_msg_id: Some(send.message_id),
            run_id: None,
            hlc_ts: None,
            hlc_count: None,
        },
    )
    .await?;
    if let Some(object) = detail.as_object_mut() {
        object.insert(
            "notice_message_id".into(),
            serde_json::json!(sent.message.id),
        );
    }
    write_audit(
        &mut *conn,
        &AuditEntry::new(send.workspace_id, HOSTED_SKIP_NOTICE_POSTED_ACTION)
            .by(send.author_member_id)
            .about(agent.member_id)
            .target("message", send.message_id)
            .via_token(send.via_token_id)
            .with_schema(HOSTED_SKIP_NOTICE_AUDIT_SCHEMA, detail),
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
    addressing: Addressing,
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
    stamp_addressing(&mut detail, addressing);
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

/// Test the ordinary invocation gates with only the proposed seat/room approval supplied.
pub(crate) fn dm_admission_invocable(agent: &MentionCandidate, send: &MentionSend<'_>) -> bool {
    matches!(delivery_gate(agent, send), DeliveryGate::Open { .. })
}

#[allow(clippy::too_many_arguments)]
fn admission_send<'a>(
    state: &'a crate::AppState,
    ws: Uuid,
    channel: Uuid,
    requester: Uuid,
    message: Uuid,
    seq: i64,
    body: &'a str,
    connector_trial: &'a momo_agent::ConnectorTrialAttest,
) -> MentionSend<'a> {
    MentionSend {
        workspace_id: ws,
        channel_id: channel,
        message_id: message,
        message_seq: seq,
        root_id: None,
        author_member_id: requester,
        author_is_agent: false,
        author_is_human: true,
        body,
        hlc_ts: chrono::Utc::now().timestamp_millis(),
        via_token_id: None,
        gateway_enabled: state.agent_gateway.enabled(),
        hosted_delivery_enabled: state.agent_port.config.hosted_delivery_enabled,
        subscription_agents_enabled: state.agent_port.config.subscription_agents_enabled,
        claude_subscription_agents_enabled: state
            .agent_port
            .config
            .claude_subscription_agents_enabled,
        connector_trial,
        context_max_messages: state.mentions.context_max_messages,
        inplace_grant_enabled: false,
        routing: None,
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn reprove_dm_admission_in_tx(
    conn: &mut PgConnection,
    state: &crate::AppState,
    ws: Uuid,
    channel: Uuid,
    requester: Uuid,
    target: Uuid,
    connection: Option<Uuid>,
) -> Result<bool, DbError> {
    let candidates = load_mention_candidates_in_tx(conn, ws, channel).await?;
    let Some(mut agent) = candidates.into_iter().find(|a| a.member_id == target) else {
        return Ok(false);
    };
    if agent.hosted_active_connection_id != connection
        || (connection.is_some() && !agent.hosted_confirmed_by_owner)
    {
        return Ok(false);
    }
    agent.is_channel_member = true;
    agent.hosted_channel_approved = true;
    let attest = state.cohosted.config.attest();
    Ok(dm_admission_invocable(
        &agent,
        &admission_send(state, ws, channel, requester, Uuid::nil(), 0, "", &attest),
    ))
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn enqueue_dm_admission_trigger_in_tx(
    conn: &mut PgConnection,
    state: &crate::AppState,
    ws: Uuid,
    channel: Uuid,
    requester: Uuid,
    target: Uuid,
    message: Uuid,
    requested: Option<&RequestedRouting>,
) -> Result<(), DbError> {
    let row = momo_messaging::find_message_in_tx(conn, channel, message)
        .await?
        .ok_or(sqlx::Error::RowNotFound)?;
    if row.author_member_id != requester || row.state == "deleted" {
        return Err(sqlx::Error::RowNotFound.into());
    }
    let seq = row.seq;
    let body = row.body.unwrap_or_default();
    let attest = state.cohosted.config.attest();
    let mut send = admission_send(state, ws, channel, requester, message, seq, &body, &attest);
    send.routing = requested;
    let candidates = load_mention_candidates_in_tx(conn, ws, channel).await?;
    let agent = candidates
        .iter()
        .find(|a| a.member_id == target)
        .ok_or(sqlx::Error::RowNotFound)?;
    let DeliveryGate::Open {
        hosted_connection_id,
    } = delivery_gate(agent, &send)
    else {
        return Err(sqlx::Error::Protocol("admitted agent failed delivery gate".into()).into());
    };
    let trigger = MentionTrigger {
        workspace_id: ws,
        channel_id: channel,
        message_id: message,
        message_seq: seq,
        author_member_id: requester,
        body: &body,
        hlc_ts: send.hlc_ts,
    };
    let routing = resolve_mention_routing(agent, requested)
        .map_err(|e| sqlx::Error::Protocol(e.to_string()))?;
    enqueue_turn_in_tx(
        conn,
        &send,
        &trigger,
        agent,
        Turn {
            trigger: RunTrigger::Mention {
                message_id: message,
                agent_member_id: target,
            },
            addressing: Addressing::Mention,
            requested,
            wake_reason: None,
            queued_action: MENTION_QUEUED_ACTION,
            announce_offline_queue: false,
        },
        hosted_connection_id,
        &routing,
        &mut None,
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #3945: the delegated user is the author only while the author is the
    /// connector owner; anyone else, or an agent with no apps, has none.
    #[test]
    fn the_delegated_app_user_is_the_connector_owner_alone() {
        let owner = Uuid::from_u128(7);
        let stranger = Uuid::from_u128(8);
        let mut agent = candidate(Uuid::from_u128(2), "appagent");
        assert_eq!(delegated_app_user(&agent, owner), None, "no apps attached");
        agent.connector_owner = Some(momo_agent::ConnectorOwner {
            owner_member_id: owner,
            owner_display_name: "세은".into(),
            // This unit pins who the delegated user is; a stopped trial never
            // reaches job assembly (`delivery_gate` refuses first).
            trial: None,
        });
        assert_eq!(delegated_app_user(&agent, owner), Some(owner));
        assert_eq!(delegated_app_user(&agent, stranger), None);
    }

    fn candidate(member_id: Uuid, handle: &str) -> MentionCandidate {
        MentionCandidate {
            member_id,
            handle: handle.into(),
            display_name: handle.into(),
            base_model: "hermes-agent".into(),
            base_model_source: momo_agent::ModelSource::Agent,
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
            hosted_active_connection_id: None,
            hosted_channel_approved: false,
            is_channel_member: true,
            owner_only: None,
            connector_owner: None,
            owner_member_id: None,
            owner_display_name: None,
            hosted_confirmed_by_owner: false,
            thread_reply_wake: true,
            aliases: Vec::new(),
        }
    }

    fn labelled(addressed: &[(MentionCandidate, Addressing)]) -> Vec<(Uuid, &'static str)> {
        addressed
            .iter()
            .map(|(agent, addressing)| (agent.member_id, addressing.as_label()))
            .collect()
    }

    /// **(d) A mention *and* the DM rule pointing at the same agent is ONE run.**
    ///
    /// The whole reason [`addressed_agents`] is a union: `@hermes 안녕` typed
    /// inside the DM with hermes satisfies both rules at once. A concatenation
    /// would enqueue two jobs, read the context window twice and write two audit
    /// rows before `mention:<message>:<agent>` collapsed them at the INSERT.
    ///
    /// The label is the mention's, because that is what actually happened: the
    /// human named the agent, and the DM rule had nothing left to do.
    #[test]
    fn a_mention_inside_the_dm_stays_one_run_and_keeps_the_mention_label() {
        let hermes = Uuid::from_u128(2);
        let candidates = vec![candidate(hermes, "hermes")];
        let addressed = addressed_agents(&candidates, "@hermes 안녕", Some(hermes));
        assert_eq!(
            labelled(&addressed),
            vec![(hermes, "mention")],
            "one entry, labelled by the thing the human actually did"
        );
    }

    /// (a) The batch's reason to exist: no handle, one run — and it is recorded
    /// as the DM rule's doing, not as a mention nobody typed.
    #[test]
    fn a_bare_utterance_in_a_dm_addresses_the_counterpart() {
        let hermes = Uuid::from_u128(2);
        let candidates = vec![candidate(hermes, "hermes")];
        let addressed = addressed_agents(&candidates, "이거 좀 봐줘", Some(hermes));
        assert_eq!(labelled(&addressed), vec![(hermes, "dm_implicit")]);
    }

    /// (b)/(e) collapsed into the one input that expresses both: **no DM target,
    /// no mention, no run.** `dm_target = None` is what an agent author
    /// (`AuthorIsNotHuman`) and a group channel (`NotDirectMessage`) both reduce
    /// to by the time they reach here, so this pins the group-channel regression
    /// and the agent↔agent refusal at the composition layer at once.
    #[test]
    fn without_a_dm_target_a_bare_utterance_addresses_nobody() {
        let hermes = Uuid::from_u128(2);
        let candidates = vec![candidate(hermes, "hermes")];
        assert!(addressed_agents(&candidates, "이거 좀 봐줘", None).is_empty());
        // …and the mention path is completely unaffected by the new rule.
        assert_eq!(
            labelled(&addressed_agents(&candidates, "@hermes 봐줘", None)),
            vec![(hermes, "mention")]
        );
    }

    /// A DM target that is not a live agent candidate addresses nobody: the
    /// candidate query is what says "active, undeleted, `kind='agent'`", and a
    /// target missing from it has been suspended or removed since the roster was
    /// read. Fail closed rather than enqueue a run for a member who is gone.
    #[test]
    fn a_dm_target_that_is_not_a_live_candidate_addresses_nobody() {
        let hermes = Uuid::from_u128(2);
        let vanished = Uuid::from_u128(9);
        let candidates = vec![candidate(hermes, "hermes")];
        assert!(addressed_agents(&candidates, "안녕", Some(vanished)).is_empty());
    }

    /// A mention of one agent inside a DM with another still reaches both — the
    /// DM rule adds an addressee, it never replaces the one that was named. (The
    /// mentioned outsider is then refused downstream as
    /// `agent_not_channel_member`, which is the existing fail-closed answer.)
    #[test]
    fn the_dm_rule_adds_an_addressee_rather_than_replacing_the_named_one() {
        let hermes = Uuid::from_u128(2);
        let atlas = Uuid::from_u128(3);
        let candidates = vec![candidate(hermes, "hermes"), candidate(atlas, "atlas")];
        let addressed = addressed_agents(&candidates, "@atlas 이것 좀", Some(hermes));
        assert_eq!(
            labelled(&addressed),
            vec![(atlas, "mention"), (hermes, "dm_implicit")]
        );
    }

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

    /// Nothing attested — what a server without the trial variables holds.
    static NO_ATTEST: momo_agent::ConnectorTrialAttest = momo_agent::ConnectorTrialAttest {
        tools_locked: false,
        connectors_locked: false,
        apps: Vec::new(),
    };

    fn send_for(author: Uuid) -> MentionSend<'static> {
        MentionSend {
            workspace_id: Uuid::from_u128(100),
            channel_id: Uuid::from_u128(101),
            message_id: Uuid::from_u128(102),
            message_seq: 7,
            root_id: Some(Uuid::from_u128(103)),
            author_member_id: author,
            author_is_agent: false,
            author_is_human: true,
            body: "고마워요",
            hlc_ts: 0,
            via_token_id: None,
            gateway_enabled: true,
            hosted_delivery_enabled: true,
            subscription_agents_enabled: true,
            claude_subscription_agents_enabled: true,
            connector_trial: &NO_ATTEST,
            context_max_messages: 30,
            routing: None,
            // The in-place grant door (#3857) is off here: these units pin the
            // shared gate, not the card.
            inplace_grant_enabled: false,
        }
    }

    fn send_for_closed(author: Uuid) -> MentionSend<'static> {
        MentionSend {
            hosted_delivery_enabled: false,
            ..send_for(author)
        }
    }

    /// ADR-0162 증보 5 W1 「같은 관문」: the wake and the mention ask ONE gate
    /// function, so its order is the mention path's order. Pinned here so a
    /// reorder shows up as a unit failure, not only in the docker suite.
    #[test]
    fn the_delivery_gate_keeps_the_mention_order() {
        let human = Uuid::from_u128(1);
        let send = send_for(human);
        let base = candidate(Uuid::from_u128(2), "opener");

        assert_eq!(
            delivery_gate(&base, &send),
            DeliveryGate::Open {
                hosted_connection_id: None
            }
        );

        // Not in the channel is answered before paused.
        let mut absent = base.clone();
        absent.is_channel_member = false;
        absent.paused = true;
        assert_eq!(
            delivery_gate(&absent, &send),
            DeliveryGate::NotChannelMember
        );

        // Every hosted refusal is answered before paused.
        let mut hosted = base.clone();
        hosted.hosted_delivery_disabled = true;
        hosted.paused = true;
        assert_eq!(
            delivery_gate(&hosted, &send_for_closed(human)),
            DeliveryGate::HostedDeliveryNotEnabled
        );
        assert_eq!(
            delivery_gate(&hosted, &send),
            DeliveryGate::HostedConnectionUnavailable
        );
        hosted.hosted_active_connection_id = Some(Uuid::from_u128(9));
        assert_eq!(
            delivery_gate(&hosted, &send),
            DeliveryGate::HostedChannelUnapproved
        );
        hosted.hosted_channel_approved = true;
        assert_eq!(delivery_gate(&hosted, &send), DeliveryGate::Paused);
        hosted.paused = false;
        assert_eq!(
            delivery_gate(&hosted, &send),
            DeliveryGate::Open {
                hosted_connection_id: Some(Uuid::from_u128(9))
            }
        );
        assert_eq!(
            DeliveryGate::HostedChannelUnapproved.skip_reason(),
            "hosted_channel_unapproved"
        );
        assert_eq!(DeliveryGate::Paused.skip_reason(), "agent_paused");
    }

    /// What F8 (`GET …/members/me/app-runtimes`, ADR-0113 증보 3) says about one delivery-gate stage.
    #[derive(Debug, PartialEq, Eq)]
    enum F8View {
        /// `blocked: null`.
        Deliverable,
        /// `blocked: <reason>`.
        Blocked(crate::routes::app_runtimes::Blocked),
        /// Differs per conversation (membership, the hosted connection's per-channel approval): F8
        /// carries no `channelId`, so the client judges it from the roster / the gate answers after the
        /// send (ADR-0113 증보 3 F8 「대화마다 다른 사실」).
        PerConversation,
        /// A stage that cannot refuse the caller of an F8 agent: F8 projects only the caller's own
        /// non-`owner_only` agents, and the caller is its connector owner.
        CannotApply,
    }

    /// **The one line that turns red when the gate grows a stage.** An exhaustive `match` — no wildcard
    /// arm — over every [`DeliveryGate`] variant. Adding a variant to the gate does not compile here
    /// until someone has decided what F8 says about it (a new agent-level stage almost certainly needs a
    /// new `blocked` value, a new OpenAPI enum entry and a new client sentence, and a `null` that quietly
    /// meant "deliverable" would send people messages the door throws away). The classification below is
    /// ADR-0113 증보 3 F8, line for line.
    fn f8_view(gate: DeliveryGate) -> F8View {
        use crate::routes::app_runtimes::Blocked;
        match gate {
            DeliveryGate::Open { .. } => F8View::Deliverable,
            DeliveryGate::ConnectorTrial(stop) => F8View::Blocked(Blocked::from(stop)),
            DeliveryGate::HostedDeliveryNotEnabled => F8View::Blocked(Blocked::HostedOff),
            DeliveryGate::HostedConnectionUnavailable => F8View::Blocked(Blocked::Connection),
            DeliveryGate::Paused => F8View::Blocked(Blocked::Paused),
            DeliveryGate::HostedChannelUnapproved | DeliveryGate::NotChannelMember => {
                F8View::PerConversation
            }
            DeliveryGate::PersonalAgent(_)
            | DeliveryGate::OwnerOnly(_)
            | DeliveryGate::ConnectorOwner(_)
            | DeliveryGate::ConnectorOwnerNonPerson => F8View::CannotApply,
        }
    }

    fn f8_answer(blocked: Option<crate::routes::app_runtimes::Blocked>) -> F8View {
        blocked.map_or(F8View::Deliverable, F8View::Blocked)
    }

    /// ADR-0113 증보 3 F8 수용 7 (#4313): `blocked` is the delivery gate's agent-level chain, not a
    /// parallel opinion. The real [`delivery_gate`] is driven over every combination of the facts F8
    /// reads — instance switch, attestation, trial facts, grants, connection, pause — for both paths,
    /// as the agent's owner in a channel the agent belongs to and is approved for, and must agree with
    /// `app_runtimes::blocked` on every one. The sabotages: drop a stage from `blocked` (or reorder two),
    /// and the combinations where that stage decides disagree.
    #[test]
    fn app_runtimes_blocked_agrees_with_the_real_delivery_gate() {
        use crate::routes::app_runtimes::{blocked, runtime_path, Blocked, RuntimePath};
        use momo_agent::{ConnectorOwner, ConnectorTrialAttest, ConnectorTrialFacts};

        const GMAIL: &str = "com.momo.plugins.gmail";
        let owner = Uuid::from_u128(1);
        let owned = |trial: Option<ConnectorTrialFacts>| {
            Some(ConnectorOwner {
                owner_member_id: owner,
                owner_display_name: "이도현".into(),
                trial,
            })
        };
        // Everything the owner's call needs that F8 does not carry: member of the channel, and (hosted)
        // approved for it.
        let in_the_room = |mut agent: MentionCandidate| {
            agent.is_channel_member = true;
            agent.hosted_channel_approved = true;
            agent
        };
        let attests = [
            ConnectorTrialAttest::default(),
            ConnectorTrialAttest {
                tools_locked: true,
                connectors_locked: false,
                apps: vec![GMAIL.to_string()],
            },
            ConnectorTrialAttest {
                tools_locked: true,
                connectors_locked: true,
                apps: Vec::new(),
            },
            ConnectorTrialAttest {
                tools_locked: true,
                connectors_locked: true,
                apps: vec![GMAIL.to_string()],
            },
        ];
        let mut seen: Vec<F8View> = Vec::new();
        let mut checked = 0;

        // hosted_vendor: switch × active connection × paused × attestation (which a hosted agent ignores).
        for hosted_enabled in [true, false] {
            for connection in [None, Some(Uuid::from_u128(9))] {
                for paused in [false, true] {
                    for attest in &attests {
                        let mut agent = candidate(Uuid::from_u128(2), "hosted");
                        agent.connector_owner = owned(None);
                        agent.hosted_delivery_disabled = true;
                        agent.hosted_active_connection_id = connection;
                        agent.paused = paused;
                        let agent = in_the_room(agent);
                        let send = MentionSend {
                            hosted_delivery_enabled: hosted_enabled,
                            connector_trial: attest,
                            ..send_for(owner)
                        };
                        let path = runtime_path(&agent, owner).expect("an F8 hosted agent");
                        assert_eq!(path, RuntimePath::HostedVendor);
                        let view = f8_view(delivery_gate(&agent, &send));
                        assert_eq!(
                            f8_answer(blocked(path, &agent, hosted_enabled, attest)),
                            view,
                            "hosted: enabled={hosted_enabled} connection={connection:?} paused={paused}"
                        );
                        checked += 1;
                        seen.push(view);
                    }
                }
            }
        }

        // hermes_trial: attestation × people × grants × paused × the hosted switch (which the trial ignores).
        for attest in &attests {
            for humans in [0, 1, 2] {
                for granted in [vec![GMAIL.to_string()], Vec::new()] {
                    for paused in [false, true] {
                        for hosted_enabled in [true, false] {
                            let mut agent = candidate(Uuid::from_u128(3), "hermes");
                            agent.connector_owner = owned(Some(ConnectorTrialFacts {
                                active_humans: humans,
                                granted_apps: granted.clone(),
                            }));
                            agent.paused = paused;
                            let agent = in_the_room(agent);
                            let send = MentionSend {
                                hosted_delivery_enabled: hosted_enabled,
                                connector_trial: attest,
                                ..send_for(owner)
                            };
                            let path = runtime_path(&agent, owner).expect("an F8 trial agent");
                            assert_eq!(path, RuntimePath::HermesTrial);
                            let view = f8_view(delivery_gate(&agent, &send));
                            assert_eq!(
                                f8_answer(blocked(path, &agent, hosted_enabled, attest)),
                                view,
                                "hermes: attest={attest:?} humans={humans} granted={granted:?} paused={paused}"
                            );
                            checked += 1;
                            seen.push(view);
                        }
                    }
                }
            }
        }

        // hermes_trial that ALSO has a hosted connection row (review r1 M2: the operator pinned a
        // connected agent to the env link). The gate reads the trial first and then goes on to the
        // hosted stages, so F8 has to follow it there: attestation × people × the hosted switch ×
        // the live connection × paused.
        for attest in &attests {
            for humans in [1, 2] {
                for hosted_enabled in [true, false] {
                    for connection in [None, Some(Uuid::from_u128(9))] {
                        for paused in [false, true] {
                            let mut agent = candidate(Uuid::from_u128(4), "mixed");
                            agent.connector_owner = owned(Some(ConnectorTrialFacts {
                                active_humans: humans,
                                granted_apps: vec![GMAIL.to_string()],
                            }));
                            agent.hosted_delivery_disabled = true;
                            agent.hosted_active_connection_id = connection;
                            agent.paused = paused;
                            let agent = in_the_room(agent);
                            let send = MentionSend {
                                hosted_delivery_enabled: hosted_enabled,
                                connector_trial: attest,
                                ..send_for(owner)
                            };
                            let path = runtime_path(&agent, owner).expect("an F8 trial agent");
                            assert_eq!(path, RuntimePath::HermesTrial);
                            let view = f8_view(delivery_gate(&agent, &send));
                            assert_eq!(
                                f8_answer(blocked(path, &agent, hosted_enabled, attest)),
                                view,
                                "mixed: attest={attest:?} humans={humans} hosted_enabled={hosted_enabled} \
                                 connection={connection:?} paused={paused}"
                            );
                            checked += 1;
                            seen.push(view);
                        }
                    }
                }
            }
        }

        // The grid is not vacuous: it reached deliverable and every blocked value at least once.
        assert!(checked >= 100, "{checked}");
        for expected in [
            F8View::Deliverable,
            F8View::Blocked(Blocked::HostedOff),
            F8View::Blocked(Blocked::Connection),
            F8View::Blocked(Blocked::Attest),
            F8View::Blocked(Blocked::Members),
            F8View::Blocked(Blocked::Apps),
            F8View::Blocked(Blocked::Paused),
        ] {
            assert!(
                seen.contains(&expected),
                "the grid never produced {expected:?}"
            );
        }
        assert!(
            !seen.contains(&F8View::PerConversation) && !seen.contains(&F8View::CannotApply),
            "as the owner, in the room, no non-F8 stage can refuse"
        );
    }

    /// The stages F8 does not carry are exactly the ones the gate answers per conversation or per
    /// caller — pinned by driving them, so the `PerConversation` / `CannotApply` classes in [`f8_view`] are
    /// facts and not labels.
    #[test]
    fn the_stages_f8_leaves_out_are_per_conversation_or_per_caller() {
        let owner = Uuid::from_u128(1);
        let stranger = Uuid::from_u128(5);
        let mut hosted = candidate(Uuid::from_u128(2), "hosted");
        hosted.connector_owner = Some(momo_agent::ConnectorOwner {
            owner_member_id: owner,
            owner_display_name: "이도현".into(),
            trial: None,
        });
        hosted.hosted_delivery_disabled = true;
        hosted.hosted_active_connection_id = Some(Uuid::from_u128(9));
        // Connected, but this channel is not approved for it: per conversation.
        hosted.is_channel_member = true;
        hosted.hosted_channel_approved = false;
        assert_eq!(
            f8_view(delivery_gate(&hosted, &send_for(owner))),
            F8View::PerConversation
        );
        // Not in the channel at all: per conversation.
        hosted.is_channel_member = false;
        assert_eq!(
            f8_view(delivery_gate(&hosted, &send_for(owner))),
            F8View::PerConversation
        );
        // Someone other than the owner calls: per caller (F8 answers for the owner only).
        hosted.is_channel_member = true;
        hosted.hosted_channel_approved = true;
        assert_eq!(
            f8_view(delivery_gate(&hosted, &send_for(stranger))),
            F8View::CannotApply
        );
    }

    /// ADR-0113 증보 2 E3 (#3938): an agent that runs its owner's apps is called
    /// by that human alone. A person other than the owner is told (one
    /// sentence); anyone who is not a person — an agent's A2A mention, a work
    /// host, a system or webhook-shaped author — is refused silently. The owner
    /// passes to the ordinary checks, and no mark changes nothing.
    #[test]
    fn the_connector_owner_gate_tells_a_person_and_stays_silent_for_the_rest() {
        let owner = Uuid::from_u128(1);
        let other_person = Uuid::from_u128(5);
        let mut agent = candidate(Uuid::from_u128(2), "appagent");
        agent.connector_owner = Some(momo_agent::ConnectorOwner {
            owner_member_id: owner,
            owner_display_name: "세은".into(),
            trial: None,
        });
        let open = DeliveryGate::Open {
            hosted_connection_id: None,
        };

        assert_eq!(delivery_gate(&agent, &send_for(owner)), open);
        assert_eq!(
            delivery_gate(&agent, &send_for(other_person)),
            DeliveryGate::ConnectorOwner(SubscriptionNoticeKind::ConnectorNonOwner)
        );
        // Not a person: a work host / webhook / system author.
        let non_person = MentionSend {
            author_is_human: false,
            ..send_for(other_person)
        };
        assert_eq!(
            delivery_gate(&agent, &non_person),
            DeliveryGate::ConnectorOwnerNonPerson
        );
        // An agent author (A2A) — even one that claims the owner's member id is
        // not a person (`author_is_human` is the principal's kind, not an id).
        let a2a = MentionSend {
            author_is_agent: true,
            author_is_human: false,
            ..send_for(other_person)
        };
        assert_eq!(
            delivery_gate(&agent, &a2a),
            DeliveryGate::ConnectorOwnerNonPerson
        );
        // Both refusals share one reason word, so one query answers for both.
        assert_eq!(
            DeliveryGate::ConnectorOwner(SubscriptionNoticeKind::ConnectorNonOwner).skip_reason(),
            SKIP_CONNECTOR_OWNER_NON_OWNER
        );
        assert_eq!(
            DeliveryGate::ConnectorOwnerNonPerson.skip_reason(),
            SKIP_CONNECTOR_OWNER_NON_OWNER
        );
        // A personal agent with the mark: same shapes, not the personal NonOwner arm.
        let mut personal = agent.clone();
        personal.owner_only = Some(momo_agent::OwnerOnlyScope {
            owner_member_id: owner,
            owner_display_name: "세은".into(),
            harness: momo_agent::SubscriptionHarness::Codex,
            recently_seen: true,
            reconnectable: false,
            uses_owner_key: false,
            personal_agent: true,
        });
        assert_eq!(
            delivery_gate(&personal, &non_person),
            DeliveryGate::ConnectorOwnerNonPerson
        );
        // No mark: a stranger's call is the ordinary agent's ordinary call.
        agent.connector_owner = None;
        assert_eq!(delivery_gate(&agent, &send_for(other_person)), open);
    }

    /// The wake's three outcomes are their own actions, distinct from the
    /// mention's, on the same diagnostic schema.
    #[test]
    fn thread_wake_outcomes_are_their_own_actions() {
        let actions = [
            MENTION_QUEUED_ACTION,
            MENTION_SKIPPED_ACTION,
            MENTION_PAUSED_ACTION,
            THREAD_WAKE_QUEUED_ACTION,
            THREAD_WAKE_SKIPPED_ACTION,
            THREAD_WAKE_COALESCED_ACTION,
        ];
        let mut unique = actions.to_vec();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), actions.len());
        assert_eq!(THREAD_REPLY_WAKE_REASON, Addressing::ThreadReply.as_label());
    }
}
