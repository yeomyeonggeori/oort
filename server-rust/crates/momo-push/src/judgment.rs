//! ADR-0204 addendum 6 D6-5 exception: approval-settlement candidates read
//! `source`, then use only the requester arm, at judgment time. Their category
//! is mention and their dispatch key differs from the original approval push.
//! Rollout: deploy the notifier before or together with the server, so an
//! already-settled approval is not pushed to deciders a second time.
//! Judgment v0 — **the** single place notification judgment lives (ux-bible P9).
//!
//! Port of `NotifierService.judgeTargets` / `unreadBadge`
//! (`NotifierService.swift:324-478`).
//!
//! The 011 trigger is deliberately unconditional: it records that activity
//! happened, never who should hear about it. Deciding *who* is this module's
//! job and nowhere else's — that separation is the Slack activity/delivery
//! lesson ADR-0120 D3 encodes.
//!
//! ## What is decided here
//!
//! * **DM** — every message in a `dm` channel notifies the other active members.
//! * **Mention** — from `message.props.mention_member_ids`, the server-recomputed
//!   projection persisted at insert time. Judgment **never re-parses the body**;
//!   it never even reads it.
//! * **Approval request** — an `approval_request` message notifies the humans
//!   who **may approve it**, excluding the requesting agent: active human members
//!   of its channel that the decision route would let through (ADR-0204 D7; the
//!   rule is read through [`crate::approvers::may_approve_in_tx`], which asks the
//!   same functions the route asks). Everyone else in the channel sees the card
//!   and hears nothing. A card with no `approval` row (a message that merely has
//!   the type) has nobody to ask and pushes nobody — the relay would refuse the
//!   dispatch anyway, since an approval category must name its approval.
//! * **Resume offer** — the owning member of the orphaned session.
//! * **Work complete (`work_session_idle`, ADR-0120 부록 A, #3341)** — only the
//!   member who started the session, only when the turn ran at least
//!   [`WORK_COMPLETE_MIN_RAN_MS`], only once per turn, only when they have not
//!   just been reading that channel ([`WORK_COMPLETE_FOREGROUND_WINDOW_SECS`]),
//!   and only while `notification_rule.work_complete_push` is on. An idle card
//!   that fails any of these selects NO reason — it must never fall through to
//!   `dm`, which would push the card's own text to a DM peer.
//! * **Work run done (`work_run_done`, ADR-0162 증보 3 D14, #3517)** — the final
//!   answer a hosted agent posts when its `type=work` run ends is the push
//!   candidate (one message per run: `client_msg_id = run_id`). Only the person
//!   who asked for the run (the actor of the run's `agent.work.queued` audit row —
//!   `agent_run` has no requester column; no row, no push), only when the run
//!   ended `succeeded`/`failed`/`timed_out` and ran at least
//!   [`WORK_COMPLETE_MIN_RAN_MS`], only when they have not just been reading that
//!   channel (same A-8 window as the idle card) and only while
//!   `notification_rule.work_complete_push` is on. A cancelled run posts no
//!   answer, so it has no candidate at all. For the requester, a run answer that
//!   fails any of these selects NO reason — like the idle card it must not fall
//!   through to `dm`, so turning the switch off really silences it. Everyone else
//!   in the channel is judged as for any message.
//! * **An agent's answer to you (ADR-0204 D8, #3929)** — a run's closing line pushes
//!   the person whose message the run answered: the final answer, the approval-expiry
//!   result, the stall notice. "Answers" is a fact the line carries — `reply_to_id`
//!   (the final answer, ADR-0148 rule 6) or `props.answers_message_id`
//!   ([`momo_agent::PROP_ANSWERS_MESSAGE_ID`], the two lines a sweep writes) — and the
//!   asker is the author of the message it names, in the same channel. Only an
//!   **agent's** line that belongs to a **run** counts: a work-session card quotes the
//!   owner's message too, but it has no run, and tool lines, rejection lines and
//!   notices carry neither marker. The wire reason is the existing `mention`; the
//!   asker is not pushed while they are reading the channel (the same 30 s
//!   [`WORK_COMPLETE_FOREGROUND_WINDOW_SECS`] as the work reasons). In a DM the `dm`
//!   arm has already answered, with its old rules: this arm is for everywhere else.
//!
//!   Everything else about the asker is the ordinary rules of a `mention`: a muted
//!   channel silences it unless the asker kept 「멘션은 예외」, DND silences it, and a
//!   person who left the channel is not a recipient at all (`left_at IS NULL` in the
//!   recipients join). A *failed* run's closing line is an answer like any other — the
//!   asker hears that it failed. A `type=work` run's requester is not this arm's
//!   business: `work_run_done` sits above it, and a work run raised from the work
//!   surface has no trigger message for the sweeps to point at, so its expiry and
//!   stall lines carry no marker. An agent can name any message of the room in
//!   `reply_to_id` when it sends over REST or the Agent Port (ADR-0148's quote); that
//!   is no more reach than its `@mention` already has, and the line must still belong
//!   to a run. Those REST sends (`send_message_with_mentions_in_tx`) record the quoted
//!   author as *mentioned*, so they are judged by the explicit-mention arm above — with
//!   no reading window — and never reach this one: only the worker's and the gateway's
//!   sends (`send_message_in_tx`, which records no mentions) do. The two paths differ
//!   in the window because ADR-0120 gives mentions none and D8 gives answers one.
//!
//!   **A streamed answer is judged when it closes (ADR-0204 증보 1 D8-a, #3987).** The
//!   in-process worker (`MessageStream`) writes one answer in two steps: the opening
//!   slice is the INSERT — which the 011 trigger turns into a candidate — and
//!   `commit_turn`'s closing slice is an UPDATE. A line that is still streaming
//!   (`momo.stream.streaming = true`) is therefore **held** by this arm: it has no
//!   answer yet, only the first words. So is one a retried turn froze between two attempts
//!   (`momo.stream.provisional = true`, written by the worker's between-attempts freeze): it
//!   reads `streaming: false, outcome: failed` like the end of a turn that really failed, but
//!   the turn expects to reopen it. The write that ends it enqueues the second
//!   candidate (`momo_messaging::stream_message_body_in_tx` →
//!   `momo_outbox::emit_stream_closed_push_candidate`), and this arm judges the finished
//!   answer then — with "reading" read at **judgment time** (`now()`), not at the opening
//!   slice (`created_at`), and without the `last_read_seq >= seq` shortcut: a cursor that
//!   reached the line when its first words arrived says they saw it begin, not that they
//!   are still there. So an asker who left during the stream is pushed once, at the
//!   close; one who was moving their cursor in the 30 s before it is not; and one who
//!   was away from the start gets one push, not an opening one and a closing one.
//!
//!   *Judgment time is when the notifier processes the candidate.* That is the moment of
//!   the close while the notifier keeps up (a second or two), and later by exactly its
//!   lag when it does not: the question the window asks is "are they looking at this
//!   channel right now?", and it is asked when the push would go out.
//!
//!   *What the cursor cannot tell, and the heartbeat that can* (ADR-0204 증보 3, #4018). A
//!   person's cursor — and `last_read_at` with it — moves only when `last_read_seq` does
//!   (`read_state.rs`), and a stream spends no `seq`. So an asker who watched a stream for
//!   longer than 30 s from a cursor that stood still looks, to the cursor alone, like one
//!   who left. A client with the channel on screen therefore beats
//!   `PUT .../channels/{ch}/viewing` (`channel_viewing.seen_at`), and this arm also reads
//!   that stamp inside the same window: a fresh beat means "looking", whatever the cursor
//!   says. The two signals OR together (either one inside the window suppresses the push),
//!   so a client that predates the heartbeat keeps today's cursor-only behaviour
//!   (`a_stream_watched_longer_than_the_window_from_a_standing_cursor_is_pushed_without_a_heartbeat`
//!   pins that edge; `..._is_not_pushed_while_the_heartbeat_is_fresh` pins the fix).
//!
//!   *Streams this arm does not judge at all.* A line that never streamed (the hosted
//!   gateway's `complete`, the team-AI helper's sends, both sweeps' lines, a worker turn
//!   that never opened a stream) is judged at its INSERT exactly as before — `created_at`,
//!   with the `seq` shortcut. REST streamers (prime/hermes) whose opening `POST` quotes the
//!   asker's message name that author as *mentioned*, so they are judged by the
//!   explicit-mention arm at their opening, as before; the close candidate finds that
//!   person's push already settled (`collapse_id`) and is skipped. One that quotes nobody has
//!   no asker for this arm. A stream that is never closed is never judged by this arm — a
//!   producer that died and whose run nobody closed, a close the domain refuses (the agent
//!   left the channel, the message was deleted), and a retried turn's freeze that no path
//!   ever ends — its job is never reclaimed, its run is parked on an approval that is then
//!   rejected, expires or is cancelled (those routes close no stream, an open one included),
//!   or a refused turn's run was cancelled before the refusal; and a close the worker
//!   attempts after its transaction and that fails (a database error) is only logged, as
//!   ADR-0155 chose for a best-effort close; the opening candidate has long been consumed,
//!   so there is nothing left to judge it.
//!
//!   Not settled here and left to the ADR's wording: a chat answer that arrives within 30 s
//!   of the asker's own question is "reading" even without streaming, because the question
//!   moved their cursor (ADR-0204 D8: 「30초 안에 움직였으면」).
//!
//!   *A provisional freeze is not a close.* `streaming: false` with `outcome: failed` is also
//!   how a turn that really failed ends, and a candidate judged inside a retried turn's freeze
//!   — the opening candidate when the notifier is a moment late, a judgment that was requeued
//!   — would push the asker the half answer, and spend the message's one push slot
//!   (`collapse_id` is per message) so the finished answer's push is skipped. The marker is
//!   what tells them apart: this arm holds a `provisional` block like an open stream, and the
//!   write that ends the turn (the retry's commit, or the terminal close when the retries
//!   never reopen the stream) enqueues the candidate that pushes.
//!
//!   *The close candidate re-judges the whole message*, not only this arm, against the
//!   ledgers as they are at that moment: the mute and DND rows, the asker's membership, a
//!   run's status. A person who muted the channel or left it between the opening and the
//!   close is judged as muted or gone; a hosted agent's `type=work` answer streamed over REST
//!   is also judged by `work_run_done` at its close, and can push its requester there if the
//!   run ended after the opening. The mentions recorded at the INSERT are not touched by the
//!   close.
//!
//!   *Roll-out.* A notifier that holds streaming lines depends on the producer that
//!   enqueues the closing candidate: ship the producers (server, agent-worker) first or
//!   together. The other order leaves a streamed answer held and never judged. An old
//!   notifier with the new producers is harmless: it holds no stream at all, so it judges
//!   the opening candidate when the stream opens, as before, and the closing candidate as
//!   one more opening — `collapse_id` keeps it to one push.
//! * **Mute (ADR-0124)** — the per-channel `notification_pref` row suppresses
//!   every reason, mentions and approvals included. Read at judgment time; no
//!   cache.
//! * **DND / mention-exception (ADR-0124 증보 1)** — the per-member,
//!   workspace-global `notification_rule` row. `dnd` suppresses every reason for
//!   that member (it sits ABOVE channel mute — DND wins even over a mention
//!   exception). `mention_overrides_mute` lets a `reason='mention'` candidate
//!   through a channel this member muted, and only a mention: it modifies the
//!   018 mute, it does not undo it for DMs or approvals.
//! * **Pause expiry (ADR-0124 증보 2)** — `notification_rule.dnd_until`. A pause
//!   suppresses only while `dnd_until IS NULL OR dnd_until > now()`, compared
//!   HERE at judgment time. There is no sweeper: an expired pause row simply
//!   stops matching. Declared DND reaches this SQL only through that same
//!   column — the presence write sets the pause in its own transaction
//!   (「묶어」), so judgment still reads one ledger and never `member`.
//!
//! Reason precedence per member is the `CASE` arm order below: the three work
//! reasons (`resume_offer`, `work_session_idle`, `work_run_done` — each claims its
//! message for the one person it names) > `approval_request` > `mention` > `dm` > an
//! agent's answer to you. That last arm never outranks a mention or a DM, and only a
//! person nothing else selected reaches it, so one message carries one reason.
//! Suppression precedence across the two ledgers
//! is `dnd > channel-mute(with mention exception) > deliver`, expressed by the
//! `WHERE` clause: absence of a `notification_rule` row is `dnd=false,
//! mention_overrides_mute=false`, which is the pre-증보 behaviour exactly.
//!
//! ## What is *not* read
//!
//! `message.body` appears nowhere in these statements. A target carries ids,
//! enum labels and a count — nothing this module returns can carry prose.
//!
//! The one table read here that does hold prose is `approval`, and it is read
//! through a **projection** of its payload: only the keys the shared functions
//! read — the audience's (`action.id`, `action.pins`, `execution`, `origin`; see
//! `momo_agent::decider`) and the open-in-app list's (`tool_call.name`, and a bare
//! marker for whether `action.args` is an object with an `avatar` key; see
//! `momo_agent::actions::opens_in_app`) — never the card's argument values,
//! `arguments` or rationale. That is a boundary (the card's text does not enter this
//! process) and a bound (a model-sized tool input is not copied once per recipient
//! and device). `tests/judgment_projection.rs` fails if the statement reads a path of
//! the payload that nobody listed, or reaches the approval row any other way. The
//! projection and `opens_in_app` must agree on every card (the decision route calls the
//! same function on the whole payload): the category test in `push_conformance_pg`
//! asserts it for each card of its table.

use std::collections::HashMap;

use momo_agent::actions::opens_in_app;
use momo_agent::PROP_ANSWERS_MESSAGE_ID;
use momo_db::DbError;
use momo_messaging::STREAM_PROPS_KEY;
use serde_json::Value;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::approvers::{ApprovalCard, CardAudience};
use crate::dispatch::{category_for, PushCategory, PushReason};

/// A work turn must have run at least this long (ms) to earn a 「작업 끝남」 push
/// (성재 2026-10-02: 「1분 이상」; ADR-0120 부록 A). Measured per turn at the
/// idle transition and stamped on the card as `props.ran_ms`.
pub const WORK_COMPLETE_MIN_RAN_MS: i64 = 60_000;

/// The "app is not in the foreground" heuristic (ADR-0120 부록 A-8). The server
/// has no foreground signal, so a person is treated as looking at the session
/// when their read cursor in its channel advanced within this many seconds
/// before the idle card, or already covers the card.
pub const WORK_COMPLETE_FOREGROUND_WINDOW_SECS: f64 = 30.0;

/// One (member, active token) pair to notify, with the reason that selected it.
#[derive(Debug, Clone)]
pub struct JudgedTarget {
    pub member_id: Uuid,
    pub token_id: Uuid,
    pub device_id: Uuid,
    pub device_platform: String,
    pub apns_token: String,
    pub apns_env: String,
    pub apns_topic: String,
    pub reason: PushReason,
    pub thread_id: Uuid,
    pub category: PushCategory,
    pub approval_id: Option<Uuid>,
}

/// Resolve who to notify for one committed message, and on which active tokens.
///
/// One statement against committed state. A member with no active token
/// contributes no row, so agents (which never have devices) drop out naturally
/// — and `mem.kind = 'human'` is a second, defensive filter against schema
/// drift (review #424 L1).
pub async fn judge_targets(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    message_id: Uuid,
) -> Result<Vec<JudgedTarget>, DbError> {
    judge_targets_for_source(conn, workspace_id, message_id, false, None).await
}

/// Consume the source of an id-only candidate. Keep the original message-only
/// entry point for callers judging an INSERT/stream-close candidate.
pub async fn judge_candidate_targets(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    candidate: &crate::PushCandidate,
) -> Result<Vec<JudgedTarget>, DbError> {
    judge_targets_for_source(
        conn,
        workspace_id,
        candidate.message_id,
        candidate.is_approval_settlement(),
        Some(candidate.channel_id),
    )
    .await
}

async fn judge_targets_for_source(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    message_id: Uuid,
    approval_settled: bool,
    channel_id: Option<Uuid>,
) -> Result<Vec<JudgedTarget>, DbError> {
    let rows = sqlx::query(
        "WITH msg AS ( \
           SELECT m.id, m.channel_id, m.author_member_id, \
                  m.type::text AS message_type, \
                  COALESCE(m.props->'mention_member_ids', '[]'::jsonb) AS mention_ids, \
                  m.props->>'kind' AS props_kind, \
                  m.props#>>'{result,status}' AS result_status, \
                  m.props->>'owner_member_id' AS owner_member_id, \
                  m.props->>'session_id' AS session_id, \
                  m.props->'turn_started_ms' AS turn_started_ms, \
                  CASE WHEN jsonb_typeof(m.props->'ran_ms') = 'number' \
                       THEN (m.props->>'ran_ms')::numeric END AS ran_ms, \
                  m.seq, \
                  m.run_id, \
                  m.client_msg_id, \
                  m.created_at, \
                  m.root_id, \
                  m.reply_to_id, \
                  (COALESCE((m.props->$6::text)->>'streaming', '') = 'true' \
                   OR COALESCE((m.props->$6::text)->>'provisional', '') = 'true') AS streaming, \
                  jsonb_exists(m.props, $6::text) AS streamed, \
                  CASE WHEN m.props->>$5::text \
                            ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' \
                       THEN (m.props->>$5::text)::uuid END AS answers_message_id, \
                  (SELECT au.kind::text FROM member au \
                    WHERE au.workspace_id = $1 AND au.id = m.author_member_id) AS author_kind, \
                  c.kind::text AS channel_kind \
             FROM message m \
             JOIN channel c ON c.id = m.channel_id \
            WHERE m.id = $2 \
              AND m.workspace_id = $1 AND ($8::uuid IS NULL OR m.channel_id = $8) \
         ), \
         card AS ( \
           SELECT a.id, a.run_id, a.requested_by, a.decided_by, a.status, a.action_type, \
                  jsonb_build_object( \
                  'action', jsonb_build_object( \
                              'id', a.payload#>'{action,id}', \
                              'pins', a.payload#>'{action,pins}', \
                              'args', CASE \
                                WHEN jsonb_typeof(a.payload#>'{action,args}') = 'object' \
                                 AND jsonb_exists(a.payload#>'{action,args}', 'avatar') \
                                  THEN jsonb_build_object('avatar', true) \
                                ELSE '{}'::jsonb END), \
                  'tool_call', jsonb_build_object('name', a.payload#>'{tool_call,name}'), \
                  'execution', a.payload->'execution', \
                  'origin', a.payload->'origin') AS approval_payload \
             FROM msg \
             JOIN approval a ON a.workspace_id = $1 AND a.request_message_id = msg.id \
                            AND a.channel_id = msg.channel_id \
         ), \
         wrun AS ( \
           SELECT r.id AS run_id, \
                  CASE WHEN r.started_at IS NOT NULL AND r.finished_at IS NOT NULL \
                       THEN extract(epoch FROM (r.finished_at - r.started_at)) * 1000 \
                  END AS ran_ms, \
                  (SELECT a.actor_member_id FROM audit_log a \
                    WHERE a.workspace_id = $1 AND a.run_id = r.id \
                      AND a.action = 'agent.work.queued' \
                    ORDER BY a.created_at, a.id LIMIT 1) AS requester_id \
             FROM agent_run r \
             JOIN msg ON r.id = msg.run_id AND r.agent_member_id = msg.author_member_id \
                     AND msg.client_msg_id = r.id \
            WHERE r.workspace_id = $1 \
              AND r.input->>'type' = 'work' \
              AND r.status IN ('succeeded', 'failed', 'timed_out') \
              AND EXISTS ( \
                SELECT 1 FROM hosted_agent_connection hc \
                 WHERE hc.workspace_id = $1 AND hc.agent_member_id = r.agent_member_id) \
         ), \
         asked AS ( \
           SELECT t.author_member_id AS asker_id \
             FROM msg \
             JOIN message t \
               ON t.workspace_id = $1 \
              AND t.channel_id = msg.channel_id \
              AND t.id = COALESCE(msg.reply_to_id, msg.answers_message_id) \
            WHERE msg.author_kind = 'agent' \
              AND msg.run_id IS NOT NULL \
         ), \
         settled AS ( \
           SELECT trigger.author_member_id AS requester_id, a.decided_by \
             FROM msg \
             JOIN card a ON a.run_id = msg.run_id AND a.requested_by = msg.author_member_id \
             JOIN agent_run run ON run.workspace_id = $1 AND run.id = a.run_id \
             JOIN message trigger ON trigger.workspace_id = $1 \
                                 AND trigger.channel_id = msg.channel_id \
                                 AND trigger.id = run.trigger_message_id \
            WHERE $7::boolean AND msg.message_type = 'approval_request' \
              AND msg.author_kind = 'agent' \
              AND (a.status IN ('rejected', 'expired') \
                   OR (a.status = 'approved' AND a.action_type = 'workspace_action' \
                       AND msg.result_status = 'executed')) \
         ), \
         recipients AS ( \
           SELECT ms.member_id, \
                  CASE \
                    WHEN $7::boolean THEN \
                      CASE WHEN mem.id = (SELECT requester_id FROM settled) \
                             AND mem.id IS DISTINCT FROM (SELECT decided_by FROM settled) \
                             AND NOT EXISTS ( \
                               SELECT 1 FROM read_state seen \
                                WHERE seen.workspace_id = $1 \
                                  AND seen.channel_id = (SELECT channel_id FROM msg) \
                                  AND seen.member_id = mem.id \
                                  AND seen.last_read_at >= now() \
                                      - make_interval(secs => $4::double precision)) \
                             AND NOT EXISTS ( \
                               SELECT 1 FROM channel_viewing viewing \
                                WHERE viewing.workspace_id = $1 \
                                  AND viewing.channel_id = (SELECT channel_id FROM msg) \
                                  AND viewing.member_id = mem.id \
                                  AND viewing.seen_at >= now() \
                                      - make_interval(secs => $4::double precision)) \
                        THEN 'mention' END \
                    WHEN (SELECT props_kind FROM msg) = 'resume_offer' \
                         AND lower(mem.id::text) = lower((SELECT owner_member_id FROM msg)) \
                      THEN 'resume_offer' \
                    WHEN (SELECT props_kind FROM msg) = 'work_session_idle' THEN \
                      CASE WHEN lower(mem.id::text) = lower((SELECT owner_member_id FROM msg)) \
                            AND ( mem.id = (SELECT author_member_id FROM msg) \
                                  OR EXISTS ( \
                                    SELECT 1 FROM work_session pws \
                                     WHERE pws.workspace_id = $1 \
                                       AND lower(pws.id::text) = lower((SELECT session_id FROM msg)) \
                                       AND pws.member_id = mem.id \
                                       AND pws.persona_member_id = (SELECT author_member_id FROM msg) \
                                  ) ) \
                            AND (SELECT message_type FROM msg) = 'system' \
                            AND COALESCE((SELECT ran_ms FROM msg), 0) >= $3::bigint \
                            AND EXISTS ( \
                              SELECT 1 FROM work_session ws \
                               WHERE ws.workspace_id = $1 \
                                 AND lower(ws.id::text) = lower((SELECT session_id FROM msg)) \
                                 AND ws.member_id = mem.id \
                                 AND ws.root_message_id = (SELECT root_id FROM msg) \
                            ) \
                            AND NOT EXISTS ( \
                              SELECT 1 FROM message prior \
                               WHERE prior.workspace_id = $1 \
                                 AND prior.channel_id = (SELECT channel_id FROM msg) \
                                 AND prior.seq < (SELECT seq FROM msg) \
                                 AND prior.props->>'kind' = 'work_session_idle' \
                                 AND prior.props->>'session_id' = (SELECT session_id FROM msg) \
                                 AND prior.props->'turn_started_ms' = (SELECT turn_started_ms FROM msg) \
                            ) \
                            AND NOT EXISTS ( \
                              SELECT 1 FROM read_state seen \
                               WHERE seen.workspace_id = $1 \
                                 AND seen.channel_id = (SELECT channel_id FROM msg) \
                                 AND seen.member_id = mem.id \
                                 AND seen.last_read_seq > 0 \
                                 AND ( seen.last_read_seq >= (SELECT seq FROM msg) \
                                       OR seen.last_read_at >= (SELECT created_at FROM msg) \
                                            - make_interval(secs => $4::double precision) ) \
                            ) \
                        THEN 'work_session_idle' END \
                    WHEN mem.id = (SELECT requester_id FROM wrun) THEN \
                      CASE WHEN COALESCE((SELECT ran_ms FROM wrun), 0) >= $3::bigint \
                            AND NOT EXISTS ( \
                              SELECT 1 FROM read_state seen \
                               WHERE seen.workspace_id = $1 \
                                 AND seen.channel_id = (SELECT channel_id FROM msg) \
                                 AND seen.member_id = mem.id \
                                 AND seen.last_read_seq > 0 \
                                 AND ( seen.last_read_seq >= (SELECT seq FROM msg) \
                                       OR seen.last_read_at >= (SELECT created_at FROM msg) \
                                            - make_interval(secs => $4::double precision) ) \
                            ) \
                        THEN 'work_run_done' END \
                    WHEN (SELECT message_type FROM msg) = 'approval_request' \
                         AND mem.kind = 'human' THEN \
                      CASE WHEN EXISTS (SELECT 1 FROM card WHERE status = 'pending') \
                           THEN 'approval_request' END \
                    WHEN EXISTS ( \
                      SELECT 1 FROM jsonb_array_elements_text((SELECT mention_ids FROM msg)) t(v) \
                       WHERE lower(t.v) = lower(ms.member_id::text) \
                    ) THEN 'mention' \
                    WHEN (SELECT channel_kind FROM msg) = 'dm' THEN 'dm' \
                    WHEN mem.id = (SELECT asker_id FROM asked) THEN \
                      CASE WHEN NOT (SELECT streaming FROM msg) \
                            AND NOT EXISTS ( \
                            SELECT 1 FROM read_state seen \
                             WHERE seen.workspace_id = $1 \
                               AND seen.channel_id = (SELECT channel_id FROM msg) \
                               AND seen.member_id = mem.id \
                               AND seen.last_read_seq > 0 \
                               AND CASE WHEN (SELECT streamed FROM msg) \
                                    THEN seen.last_read_at >= now() \
                                           - make_interval(secs => $4::double precision) \
                                    ELSE ( seen.last_read_seq >= (SELECT seq FROM msg) \
                                           OR seen.last_read_at >= (SELECT created_at FROM msg) \
                                                - make_interval(secs => $4::double precision) ) \
                                    END \
                            ) \
                            AND NOT EXISTS ( \
                            SELECT 1 FROM channel_viewing viewing \
                             WHERE viewing.workspace_id = $1 \
                               AND viewing.channel_id = (SELECT channel_id FROM msg) \
                               AND viewing.member_id = mem.id \
                               AND viewing.seen_at >= CASE WHEN (SELECT streamed FROM msg) \
                                    THEN now() ELSE (SELECT created_at FROM msg) END \
                                    - make_interval(secs => $4::double precision) \
                            ) \
                        THEN 'mention' END \
                    ELSE NULL \
                  END AS reason \
             FROM membership ms \
             JOIN member mem \
               ON mem.id = ms.member_id \
              AND mem.workspace_id = $1 \
              AND mem.status = 'active' \
              AND mem.deleted_at IS NULL \
              AND mem.kind = 'human' \
            WHERE ms.channel_id = (SELECT channel_id FROM msg) \
              AND ms.workspace_id = $1 \
              AND ms.left_at IS NULL \
              AND ( \
                ms.member_id <> (SELECT author_member_id FROM msg) \
                OR (SELECT props_kind FROM msg) IN ('resume_offer', 'work_session_idle') \
              ) \
         ) \
         SELECT r.member_id, \
                t.id AS token_id, \
                d.id AS device_id, \
                d.platform::text AS platform, \
                t.apns_token, \
                t.env::text AS env, \
                t.topic, \
                r.reason, \
                COALESCE((SELECT root_id FROM msg), (SELECT channel_id FROM msg)) AS thread_id, \
                (SELECT message_type FROM msg) AS message_type, \
                (SELECT props_kind FROM msg) AS props_kind, \
                a.id AS approval_id, \
                a.action_type AS approval_action_type, \
                a.approval_payload AS approval_payload \
           FROM recipients r \
           JOIN push_token t \
             ON t.member_id = r.member_id \
            AND t.workspace_id = $1 \
            AND t.invalidated_at IS NULL \
           JOIN device d \
             ON d.id = t.device_id \
            AND d.workspace_id = $1 \
           LEFT JOIN notification_pref np \
             ON np.workspace_id = $1 \
            AND np.channel_id = (SELECT channel_id FROM msg) \
            AND np.member_id = r.member_id \
           LEFT JOIN notification_rule nr \
             ON nr.workspace_id = $1 \
            AND nr.member_id = r.member_id \
           LEFT JOIN card a ON true \
          WHERE r.reason IS NOT NULL \
            AND NOT ( \
              COALESCE(nr.dnd, false) \
              AND (nr.dnd_until IS NULL OR nr.dnd_until > now()) \
            ) \
            AND NOT (r.reason IN ('work_session_idle', 'work_run_done') \
                     AND NOT COALESCE(nr.work_complete_push, true)) \
            AND ( \
              np.member_id IS NULL \
              OR (np.muted_until IS NOT NULL AND np.muted_until <= now()) \
              OR (r.reason = 'mention' AND COALESCE(nr.mention_overrides_mute, false)) \
            ) \
          ORDER BY r.member_id, t.id",
    )
    .bind(workspace_id)
    .bind(message_id)
    .bind(WORK_COMPLETE_MIN_RAN_MS)
    .bind(WORK_COMPLETE_FOREGROUND_WINDOW_SECS)
    .bind(PROP_ANSWERS_MESSAGE_ID)
    .bind(STREAM_PROPS_KEY)
    .bind(approval_settled)
    .bind(channel_id)
    .fetch_all(&mut *conn)
    .await?;

    let mut targets = Vec::with_capacity(rows.len());
    // One answer per person per card: a member with three devices is asked once. And
    // one resolution per card: the gate it puts on its decider and the owner of the
    // machine it is about do not depend on who is being asked. (Keyed by approval, not
    // just by person: `approval.request_message_id` is not unique in the schema, and a
    // message that two approval rows claim must not let the second reuse the first's
    // answers.)
    let mut may_approve: HashMap<(Uuid, Uuid), bool> = HashMap::new();
    let mut audiences: HashMap<Uuid, CardAudience> = HashMap::new();
    for row in rows {
        let reason_label: String = row.get("reason");
        let Some(reason) = PushReason::from_db(&reason_label) else {
            // An unknown reason means the judgment SQL and this enum drifted.
            // Dropping the target silently would be a lost notification, so
            // treat it as a decode failure and let the candidate retry.
            return Err(DbError::Sqlx(sqlx::Error::Decode(
                format!("unknown push reason from judgment: {reason_label}").into(),
            )));
        };
        let message_type: String = row.get("message_type");
        let props_kind: Option<String> = row.get("props_kind");
        let member_id: Uuid = row.get("member_id");

        // The approval this message is the card of, when it is one.
        let card = row
            .get::<Option<Uuid>, _>("approval_id")
            .map(|approval_id| ApprovalCard {
                approval_id,
                action_type: row.get("approval_action_type"),
                payload: row.get::<Value, _>("approval_payload"),
            });

        // ADR-0204 D7 — an approval request goes to the people who may approve it.
        // The SQL above chose every active human in the room; the decision route's
        // role/owner conditions narrow that here, through the functions the route
        // calls (`crate::approvers`). Only the `approval_request` reason is
        // narrowed: a resume offer, a work card or a mention on the same message
        // were chosen by their own rules.
        if reason == PushReason::ApprovalRequest {
            let Some(card) = card.as_ref() else {
                // A card with no `approval` row has nobody to ask. Silent in the
                // result, loud in the log: this used to surface as the relay's 400.
                tracing::warn!(
                    workspace_id = %workspace_id,
                    message_id = %message_id,
                    "approval_request message has no approval row; nobody is pushed"
                );
                continue;
            };
            let key = (card.approval_id, member_id);
            let allowed = match may_approve.get(&key) {
                Some(answer) => *answer,
                None => {
                    let audience = match audiences.get(&card.approval_id) {
                        Some(audience) => audience.clone(),
                        None => {
                            let resolved = CardAudience::resolve(conn, workspace_id, card).await?;
                            audiences.insert(card.approval_id, resolved.clone());
                            resolved
                        }
                    };
                    let answer = audience.allows(conn, workspace_id, member_id).await?;
                    may_approve.insert(key, answer);
                    answer
                }
            };
            if !allowed {
                continue;
            }
        }

        let opens = card
            .as_ref()
            .is_some_and(|card| opens_in_app(&card.action_type, &card.payload));
        let category = if approval_settled {
            PushCategory::Mention
        } else {
            category_for(&message_type, props_kind.as_deref(), reason, opens)
        };

        targets.push(JudgedTarget {
            member_id,
            token_id: row.get("token_id"),
            device_id: row.get("device_id"),
            device_platform: row.get("platform"),
            apns_token: row.get("apns_token"),
            apns_env: row.get("env"),
            apns_topic: row.get("topic"),
            reason,
            thread_id: row.get("thread_id"),
            category,
            // An approval id is meaningful only for the two approval categories —
            // the relay and the NSE both reject the pair otherwise.
            approval_id: if category.carries_approval_id() {
                card.as_ref().map(|card| card.approval_id)
            } else {
                None
            },
        });
    }
    Ok(targets)
}

/// The ADR-0109 badge: the server-owned unread projection summed across every
/// active channel membership.
///
/// Deliberately the same `channel_seq`/`read_state` formula as
/// `GET /read-state` — clients and the notifier never derive unread from a
/// local message cache, so the number on the app icon and the number in the app
/// cannot disagree.
pub async fn unread_badge(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<i64, DbError> {
    let badge: Option<i64> = sqlx::query_scalar(
        "SELECT COALESCE(SUM(GREATEST( \
                  COALESCE(cs.last_seq, 0) - COALESCE(rs.last_read_seq, 0), \
                  0 \
                )), 0)::bigint \
           FROM membership ms \
           JOIN channel c \
             ON c.id = ms.channel_id \
            AND c.workspace_id = $1 \
            AND c.archived_at IS NULL \
           JOIN channel_seq cs \
             ON cs.channel_id = c.id \
            AND cs.workspace_id = $1 \
           LEFT JOIN read_state rs \
             ON rs.channel_id = ms.channel_id \
            AND rs.member_id = ms.member_id \
            AND rs.workspace_id = $1 \
          WHERE ms.workspace_id = $1 \
            AND ms.member_id = $2 \
            AND ms.left_at IS NULL",
    )
    .bind(workspace_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?
    .flatten();
    Ok(badge.unwrap_or(0))
}
