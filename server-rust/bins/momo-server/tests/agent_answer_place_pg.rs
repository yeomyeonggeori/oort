//! #4622 / ADR-0200 증보 5 · ADR-0148 증보 「답 자리」 — 한 run의 **최종 답이 어디에 놓이는지**, 서버가 쓴 행으로 고정한다.
//!
//! 실제 Axum 라우터를 `momo_app`(NOBYPASSRLS) 풀 위에 띄우고, 호스팅 에이전트가 현행 루틴대로(ping·inbox·
//! `oort_job_start`·`oort_run_event`·`oort_run_complete`) 답하게 한 뒤, **`message` 행의 `root_id`·`reply_to_id`**를
//! 읽는다. 서버 안쪽 함수를 부르지 않고 HTTP로만 움직인다. 같은 harness를 쓰는 `grok_like_agent_flow_pg.rs`는
//! 답이 DM에 도착하는지까지만 보고, 어느 자리인지는 어떤 시험도 잠그지 않았다.
//!
//! | 시험 | 자리 | 고정하는 것 |
//! |---|---|---|
//! | `a_dm_answer_lands_in_the_main_flow_quoting_the_message` | 1:1 DM: 본류 + 인용 | 「1:1 DM만 예외」(owner 11-05 R1). 이 시험이 붉으면 DM 예외 줄이 깨진 거예요 |
//! | `a_top_level_channel_mention_is_answered_in_a_new_thread_under_it` | **채널 최상위: 트리거 자신이 root인 새 스레드 + 인용**, 요청의 「답글 N개」·참여자·`thread.updated`가 같이 움직여요 | #4646(ADR-0148 증보 2026-11-05, ADR-0186 증보 v6 R-c). 구현 전에 `(None, Some(asked))`로 붉었어요 |
//! | `a_mention_inside_a_thread_is_answered_inside_that_thread` | 같은 스레드 + 인용, root의 롤업·`thread.updated` | #4622 정렬 1차(ADR-0148 증보 2026-10-27) |
//! | `a_thread_whose_root_was_deleted_since_is_answered_in_the_main_flow` | 본류 + 인용, 롤업 불변 | 사람이 못 올릴 자리(지워진 root)에는 답도 안 올려요. 턴을 실패시키지 않고 본류로 돌아가요 |
//! | `an_approval_card_stands_where_the_runs_answer_would` | 카드가 답과 같은 세 자리(최상위→트리거 아래, 스레드→그 스레드, 1:1 DM→본류), `reply_to_id` 없음, 롤업이 같이 움직여요 | R-c: 한 run의 모든 줄이 한 규칙을 따라요 |
//! | `a_plain_reply_in_the_thread_the_answer_opened_wakes_the_agent_that_answered` | 답 아래 멘션 없는 사람 답글 → 답한 에이전트가 깨요(W1), 본류의 평문은 아무도 안 깨요 | ADR-0162 증보 5 W1이 의도대로인지 |
//! | `the_asker_follows_the_thread_and_the_answer_is_unread_in_it` | 요청한 사람만 `auto` 팔로우, 위치는 답 바로 앞 → 답이 안 읽음 1 | ADR-0206 증보 1 F2 (푸시 `thread_reply` arm·안 읽음 점이 읽는 사실) |
//!
//! 같은 결정을 쓰는 곳은 넷(여기 외부 `oort_run_complete`, REST 콜백 `gateway_mode_conformance_pg.rs`, 관리형 워커
//! `agent_worker_conformance_pg.rs`, 팀 AI `team_ai_conformance_pg.rs`)이고 모두 `GatewayRunSnapshot::trigger_root_id`
//! 한 곳에서 자리를 받아요(스냅샷 표는 `momo-agent/tests/conformance_pg.rs`). 보충으로, 외부 에이전트가 직접 올리는
//! 메시지로 같은 자리를 따를 수 있는 근거(트리거의 `rootId`가 job 시작 답의 대화에 실린다)도 같은 시험에서
//! 확인한다(지시문 `SELF_HOST_AGENT.md` §3.3.17.4 4번이 기대는 사실).
//!
//! 격리 DB에서만:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:<port>/momo \
//!   cargo test -p momo-server --test agent_answer_place_pg -- --ignored --test-threads=1
//! ```
//!
//! 이름·대화는 모두 지어낸 것이다(실명·실대화 없음).

#[path = "common/apps_pg.rs"]
mod apps_pg;
#[path = "common/modern_wire.rs"]
mod modern_wire;

use apps_pg::*;
use modern_wire::*;
use momo_db::sqlx;
use momo_db::PgPool;
use serde_json::{json, Value};
use uuid::Uuid;

struct World {
    su: PgPool,
    base: String,
    http: reqwest::Client,
    workspace: Uuid,
    owner_jwt: String,
    agent: Uuid,
    handle: String,
    bearer: String,
    public: Uuid,
    dm: Uuid,
}

/// A workspace with one person (이도현), one public channel the agent is approved for, the person's
/// 1:1 DM with the agent, and a hosted agent with a live Agent Port connection.
async fn world() -> World {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let base = start_server(app, ServerOptions::hosted_open()).await;
    let workspace = seed_workspace(&su).await;
    let (owner, owner_jwt) = seed_human(&su, workspace, "member", "이도현").await;
    let public = seed_channel(&su, workspace, "public", &[owner]).await;
    let dm = seed_channel(&su, workspace, "dm", &[owner]).await;
    let agent = seed_hosted_agent(&su, workspace, owner, "grok", &[public], true, false).await;
    join_channel(&su, workspace, public, agent.id).await;
    join_channel(&su, workspace, dm, agent.id).await;
    World {
        su,
        base,
        http: reqwest::Client::new(),
        workspace,
        owner_jwt,
        agent: agent.id,
        handle: agent.handle.clone(),
        bearer: agent.bearer.expect("a live connection has a bearer"),
        public,
        dm,
    }
}

impl World {
    /// The person says something in `channel` (inside the thread of `root` when given); returns the
    /// message id.
    async fn say(&self, channel: Uuid, body: &str, root: Option<Uuid>) -> Uuid {
        let mut request = json!({"clientMsgId": Uuid::new_v4(), "body": body});
        if let Some(root) = root {
            request["rootId"] = json!(root);
        }
        let response = self
            .http
            .post(format!(
                "{}/v1/workspaces/{}/channels/{channel}/messages",
                self.base, self.workspace
            ))
            .bearer_auth(&self.owner_jwt)
            .json(&request)
            .send()
            .await
            .expect("send");
        let status = response.status().as_u16();
        let value: Value = response.json().await.expect("send body");
        assert_eq!(status, 201, "send: {value}");
        Uuid::parse_str(value["id"].as_str().expect("id")).expect("message uuid")
    }

    /// The agent's own messages in `channel` as `(root_id, reply_to_id)`, oldest first.
    async fn agent_places(&self, channel: Uuid) -> Vec<(Option<Uuid>, Option<Uuid>)> {
        sqlx::query_as(
            "SELECT root_id, reply_to_id FROM message \
              WHERE workspace_id = $1 AND channel_id = $2 AND author_member_id = $3 ORDER BY seq",
        )
        .bind(self.workspace)
        .bind(channel)
        .bind(self.agent)
        .fetch_all(&self.su)
        .await
        .expect("agent places")
    }

    /// The `seq` of the agent's only message in `channel`.
    async fn the_answers_seq(&self, channel: Uuid) -> i64 {
        sqlx::query_scalar(
            "SELECT seq FROM message \
              WHERE workspace_id = $1 AND channel_id = $2 AND author_member_id = $3",
        )
        .bind(self.workspace)
        .bind(channel)
        .bind(self.agent)
        .fetch_one(&self.su)
        .await
        .expect("the agent's one message")
    }

    /// A thread's rollup row — what the root's 「답글 N개」 reads — as
    /// `(reply_count, last_reply_seq, participant_ids)`. `None` when no reply ever made one.
    async fn rollup(&self, root: Uuid) -> Option<(i32, Option<i64>, Vec<Uuid>)> {
        sqlx::query_as(
            "SELECT reply_count, last_reply_seq, participant_ids FROM thread \
              WHERE workspace_id = $1 AND root_id = $2",
        )
        .bind(self.workspace)
        .bind(root)
        .fetch_optional(&self.su)
        .await
        .expect("thread rollup")
    }

    /// The newest `thread.updated` broadcast for `root` as `(reply_count, last_reply_seq)` — what
    /// every open client is told about the thread. Read from the outbox, where the relay picks it up.
    async fn last_thread_updated(&self, root: Uuid) -> Option<(i64, i64)> {
        let payload: Option<Value> = sqlx::query_scalar(
            "SELECT payload->'data'->'payload' FROM outbox \
              WHERE workspace_id = $1 AND kind = 'broadcast' \
                AND payload->'data'->>'type' = 'thread.updated' \
                AND lower(payload->'data'->'payload'->>'root_id') = lower($2) \
              ORDER BY id DESC LIMIT 1",
        )
        .bind(self.workspace)
        .bind(root.to_string())
        .fetch_optional(&self.su)
        .await
        .expect("thread.updated broadcast");
        payload.map(|payload| {
            (
                payload["reply_count"].as_i64().expect("reply_count"),
                payload["last_reply_seq"].as_i64().expect("last_reply_seq"),
            )
        })
    }

    /// The person deletes one of their own messages (a tombstone, not a removal).
    async fn delete(&self, message: Uuid) {
        let response = self
            .http
            .delete(format!(
                "{}/v1/workspaces/{}/messages/{message}",
                self.base, self.workspace
            ))
            .bearer_auth(&self.owner_jwt)
            .send()
            .await
            .expect("delete");
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        assert_eq!(status, 200, "delete: {body}");
    }
}

/// One tracked turn the way the routine does it: ping, inbox, `oort_job_start {}`, one progress
/// report, `oort_run_complete`. Returns the job-start answer, so the test can look at what the agent
/// was told about the message that called it.
async fn answer_the_pending_turn(w: &World, channel: Uuid, answer: &str) -> Value {
    let wire = Wire::new(&w.base, &w.bearer);
    assert!(wire.ping().await.is_ok());
    assert!(wire.inbox(None).await.is_ok());
    let start = wire.job_start().await;
    assert!(start.is_ok(), "{start:?}");
    let job = start.structured()["job"].clone();
    assert!(
        job.is_object(),
        "a pending turn is handed over: {:?}",
        start.body
    );
    assert_eq!(
        job["work"]["channelId"].as_str().map(str::to_lowercase),
        Some(channel.to_string().to_lowercase()),
        "the job is for the channel the person spoke in"
    );
    let handle = job["leaseHandle"]
        .as_str()
        .expect("leaseHandle")
        .to_string();
    assert!(wire.run_event(&handle, "자료 정리 중").await.is_ok());
    let done = wire.run_complete(&handle, answer).await;
    assert!(done.is_ok(), "{done:?}");
    assert!(
        done.structured()["messageId"].is_string(),
        "a non-empty answer lands as a message: {:?}",
        done.body
    );
    start.structured().clone()
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_dm_answer_lands_in_the_main_flow_quoting_the_message() {
    let w = world().await;
    let asked = w.say(w.dm, "배포 결과 정리해줄래요?", None).await;
    answer_the_pending_turn(&w, w.dm, "정리했어요").await;
    assert_eq!(
        w.agent_places(w.dm).await,
        vec![(None, Some(asked))],
        "rule E also puts a DM answer in the main flow; it quotes the message it answers"
    );
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_top_level_channel_mention_is_answered_in_a_new_thread_under_it() {
    let w = world().await;
    let asked = w
        .say(
            w.public,
            &format!("@{} 이번 주 일정 모아줘", w.handle),
            None,
        )
        .await;
    answer_the_pending_turn(&w, w.public, "일정 모았어요").await;
    // #4646 (ADR-0148 증보, ADR-0186 증보 v6 R-c): the request is the root of a new thread and the answer
    // is its first reply — and it still quotes the message it answers (`reply_to_id` = the root; the
    // client does not draw a quote that points at the thread's own root).
    assert_eq!(
        w.agent_places(w.public).await,
        vec![(Some(asked), Some(asked))],
        "the server places a channel answer under the request; it is not the agent's choice"
    );
    // …and it is a REPLY the thread knows about: the request's 「답글 N개」 moved from nothing to one, the
    // agent joined the thread, and every open client was told.
    let answer_seq = w.the_answers_seq(w.public).await;
    let (count, last_seq, participants) = w.rollup(asked).await.expect("the thread has a rollup");
    assert_eq!(count, 1, "the agent's answer is the thread's only reply");
    assert_eq!(last_seq, Some(answer_seq));
    assert_eq!(
        participants,
        vec![w.agent],
        "the agent that answered is the thread's participant"
    );
    assert_eq!(
        w.last_thread_updated(asked).await,
        Some((1, answer_seq)),
        "`thread.updated` was published for the answer, so a client holding the request re-draws its count"
    );
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_mention_inside_a_thread_is_answered_inside_that_thread() {
    let w = world().await;
    let root = w.say(w.public, "다음 주 배포 일정", None).await;
    let asked = w
        .say(
            w.public,
            &format!("@{} 이어서 정리해줘", w.handle),
            Some(root),
        )
        .await;
    // The person's reply is the first reply the thread has; the answer will be the second.
    assert_eq!(w.rollup(root).await.map(|r| r.0), Some(1));
    let started = answer_the_pending_turn(&w, w.public, "이어서 정리했어요").await;

    // What an external agent is told about the message that called it: the trigger id, and in the
    // conversation that same message with its `rootId` — the fact the routine's step 4 relies on to
    // answer in the same thread when it posts for itself.
    let work = &started["job"]["work"];
    assert_eq!(
        work["triggerMessageId"].as_str().map(str::to_lowercase),
        Some(asked.to_string().to_lowercase())
    );
    let trigger = started["conversation"]["messages"]
        .as_array()
        .expect("the conversation rides with the job start")
        .iter()
        .find(|message| {
            message["id"].as_str().map(str::to_lowercase) == Some(asked.to_string().to_lowercase())
        })
        .expect("the message that called the agent is in the conversation");
    assert_eq!(
        trigger["rootId"].as_str().map(str::to_lowercase),
        Some(root.to_string().to_lowercase()),
        "the trigger carries the root of the thread it was said in"
    );

    // #4622 (ADR-0148 증보): the final answer stays in the thread the question was asked in — and
    // still quotes the message it answers (규칙 1: belonging and aim are two columns).
    assert_eq!(
        w.agent_places(w.public).await,
        vec![(Some(root), Some(asked))],
        "the final answer is inside the thread of `root` and quotes the in-thread message"
    );

    // …and it is a REPLY the thread knows about, not a row that happens to carry a `root_id`: the
    // root's 「답글 N개」 moved, the answer's author joined the thread, and every open client was told.
    // This is the half a bare `root_id: Some(_)` on the raw spine silently skips.
    let answer_seq = w.the_answers_seq(w.public).await;
    let (count, last_seq, participants) = w.rollup(root).await.expect("the thread has a rollup");
    assert_eq!(count, 2, "the person's reply and the agent's answer");
    assert_eq!(
        last_seq,
        Some(answer_seq),
        "the rollup's newest reply is the answer"
    );
    assert!(
        participants.contains(&w.agent),
        "the agent that answered is a participant of the thread: {participants:?}"
    );
    assert_eq!(
        w.last_thread_updated(root).await,
        Some((2, answer_seq)),
        "`thread.updated` was published for the answer, so a client holding the root re-draws its count"
    );
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_thread_whose_root_was_deleted_since_is_answered_in_the_main_flow() {
    let w = world().await;
    let root = w.say(w.public, "다음 주 배포 일정", None).await;
    let asked = w
        .say(
            w.public,
            &format!("@{} 이어서 정리해줘", w.handle),
            Some(root),
        )
        .await;
    // The person deletes the thread's root while the agent is working. A REPLY under a deleted root is
    // refused to people (`validate_thread_root_in_tx`), so the agent's answer must not be written
    // there either — and must not fail the turn: it goes where answers went before #4622.
    w.delete(root).await;
    answer_the_pending_turn(&w, w.public, "이어서 정리했어요").await;

    assert_eq!(
        w.agent_places(w.public).await,
        vec![(None, Some(asked))],
        "no live thread to belong to: main flow, quoting the message it answers"
    );
    assert_eq!(
        w.rollup(root).await.map(|r| r.0),
        Some(1),
        "the deleted thread's rollup still counts only the person's reply: the answer was not added to it"
    );
}

// ---------------------------------------------------------------------------
// #4646 — the lines around the answer follow the answer
// ---------------------------------------------------------------------------

impl World {
    /// The agent's approval cards in `channel` as `(root_id, reply_to_id)`, oldest first.
    async fn card_places(&self, channel: Uuid) -> Vec<(Option<Uuid>, Option<Uuid>)> {
        sqlx::query_as(
            "SELECT root_id, reply_to_id FROM message \
              WHERE workspace_id = $1 AND channel_id = $2 AND author_member_id = $3 \
                AND type = 'approval_request' ORDER BY seq",
        )
        .bind(self.workspace)
        .bind(channel)
        .bind(self.agent)
        .fetch_all(&self.su)
        .await
        .expect("card places")
    }

    /// Agent runs of the agent whose idempotency key is a thread wake's (ADR-0162 증보 5 W1).
    async fn wake_runs(&self) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM agent_run WHERE workspace_id = $1 AND agent_member_id = $2 \
               AND idempotency_key LIKE 'thread_reply:%'",
        )
        .bind(self.workspace)
        .bind(self.agent)
        .fetch_one(&self.su)
        .await
        .expect("wake runs")
    }
}

/// Start the pending turn, propose a workspace action over the Agent Port (which raises the approval
/// card and parks the run), and return after the card stands.
async fn propose_during_the_pending_turn(w: &World, channel: Uuid) {
    // The seeded connection reads and posts; proposing a workspace action is a scope of its own.
    sqlx::query(
        "UPDATE hosted_agent_connection SET approved_scopes = \
           array_append(array_remove(approved_scopes, 'workspace:propose'), 'workspace:propose') \
          WHERE workspace_id = $1 AND agent_member_id = $2",
    )
    .bind(w.workspace)
    .bind(w.agent)
    .execute(&w.su)
    .await
    .expect("approve the propose scope");
    sqlx::query(
        "UPDATE token SET scopes = \
           array_append(array_remove(scopes, 'workspace:propose'), 'workspace:propose') \
          WHERE workspace_id = $1 AND actor_member_id = $2 AND kind = 'agent_bearer'",
    )
    .bind(w.workspace)
    .bind(w.agent)
    .execute(&w.su)
    .await
    .expect("grant the propose scope");
    let wire = Wire::new(&w.base, &w.bearer);
    assert!(wire.ping().await.is_ok());
    assert!(wire.inbox(None).await.is_ok());
    let start = wire.job_start().await;
    assert!(start.is_ok(), "{start:?}");
    let job = start.structured()["job"].clone();
    assert!(
        job.is_object(),
        "a pending turn is handed over: {:?}",
        start.body
    );
    assert_eq!(
        job["work"]["channelId"].as_str().map(str::to_lowercase),
        Some(channel.to_string().to_lowercase())
    );
    let handle = job["leaseHandle"]
        .as_str()
        .expect("leaseHandle")
        .to_string();
    let proposed = wire
        .tool(
            "oort_action_propose",
            json!({"handle": handle, "actionId": "invite.create", "args": {}}),
        )
        .await;
    assert!(proposed.is_ok(), "the proposal raises a card: {proposed:?}");
}

/// **The approval card stands where the answer would (R-c: one place for every line of a run).**
///
/// The same Agent Port proposal, three conversations. A channel's top level puts the card under the request
/// (a thread the request roots, counted by the thread like any reply); a thread keeps it in that thread;
/// a 1:1 DM keeps it in the main flow. The card does not quote the request (`reply_to_id` stays empty —
/// it is a trace of the agent's work, not an answer), and the rollup moves with it, which is what a bare
/// `root_id` on the raw spine would skip.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn an_approval_card_stands_where_the_runs_answer_would() {
    let w = world().await;

    // A channel's top level: a new thread under the request.
    let asked = w
        .say(w.public, &format!("@{} 초대 링크 만들어줘", w.handle), None)
        .await;
    propose_during_the_pending_turn(&w, w.public).await;
    assert_eq!(
        w.card_places(w.public).await,
        vec![(Some(asked), None)],
        "the card is the first reply of a thread rooted at the request"
    );
    let (count, _, participants) = w.rollup(asked).await.expect("the card made a rollup");
    assert_eq!(count, 1, "the card is a reply the thread counts");
    assert_eq!(participants, vec![w.agent]);
    sqlx::query(
        "UPDATE agent_run SET status = 'cancelled'::run_status, finished_at = now() \
          WHERE workspace_id = $1 AND agent_member_id = $2",
    )
    .bind(w.workspace)
    .bind(w.agent)
    .execute(&w.su)
    .await
    .expect("settle the parked run so the next turn can start");

    // A thread: the same thread.
    let root = w.say(w.public, "다음 주 배포 일정", None).await;
    w.say(
        w.public,
        &format!("@{} 이어서 초대 링크도", w.handle),
        Some(root),
    )
    .await;
    propose_during_the_pending_turn(&w, w.public).await;
    let places = w.card_places(w.public).await;
    assert_eq!(
        places.last().copied(),
        Some((Some(root), None)),
        "a request made inside a thread gets its card inside that thread"
    );
    sqlx::query(
        "UPDATE agent_run SET status = 'cancelled'::run_status, finished_at = now() \
          WHERE workspace_id = $1 AND agent_member_id = $2",
    )
    .bind(w.workspace)
    .bind(w.agent)
    .execute(&w.su)
    .await
    .expect("settle the parked run so the next turn can start");

    // A 1:1 DM: the main flow.
    w.say(w.dm, &format!("@{} 여기서도 초대 링크", w.handle), None)
        .await;
    propose_during_the_pending_turn(&w, w.dm).await;
    assert_eq!(
        w.card_places(w.dm).await,
        vec![(None, None)],
        "the DM is the work room: its card stays in the main flow"
    );
}

/// **A plain reply in the thread the answer opened wakes the agent that answered (ADR-0162 증보 5 W1).**
///
/// The wake reads the thread's first reply when the root is a person's message: "a human called an agent at
/// channel level and the agent answered in a thread under it". Until #4646 a channel-level answer was in the
/// main flow, so that sentence was true only for threads people had opened. Now every channel call is such
/// a thread, and the person's follow-up — no mention, in the answer's thread — is a turn for the same
/// agent. Pinned here because it is the visible half of the change: a person who types under 「답글 1개」
/// is talking to the agent that answered, and one who types in the main flow is not.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_plain_reply_in_the_thread_the_answer_opened_wakes_the_agent_that_answered() {
    let w = world().await;
    let asked = w
        .say(w.public, &format!("@{} 일정 모아줘", w.handle), None)
        .await;
    answer_the_pending_turn(&w, w.public, "일정 모았어요").await;
    assert_eq!(w.wake_runs().await, 0, "nothing woke the agent yet");

    // A plain message in the main flow is not addressed to anyone.
    w.say(w.public, "다들 점심 뭐 먹어요?", None).await;
    assert_eq!(w.wake_runs().await, 0, "a main-flow message wakes no agent");

    // The same kind of message under the request, in the answer's thread, is.
    let follow = w.say(w.public, "하나 더 정리해줘", Some(asked)).await;
    assert_eq!(
        w.wake_runs().await,
        1,
        "a plain reply in the thread the agent answered in wakes that agent once"
    );
    let trigger: Option<Uuid> = sqlx::query_scalar(
        "SELECT trigger_message_id FROM agent_run \
          WHERE workspace_id = $1 AND agent_member_id = $2 AND idempotency_key LIKE 'thread_reply:%'",
    )
    .bind(w.workspace)
    .bind(w.agent)
    .fetch_one(&w.su)
    .await
    .expect("the wake run");
    assert_eq!(
        trigger,
        Some(follow),
        "the wake run is for the person's reply"
    );
}

/// **The asker follows the thread their request opened (ADR-0206 증보 1 F2) — the unread facts.**
///
/// The answer is a `text` reply of a counted thread, so the automatic follow gives the root's author (the
/// person who asked) a row, positioned just before the answer: the thread's 「답글 1개」 is unread for them
/// until they open it, and the channel's main flow shows no new message. The agent is not a follower (the
/// follow is for people). This is the fact the push (`thread_reply` arm; an agent's answer to you outranks it,
/// so one push) and the unread dot both read.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_asker_follows_the_thread_and_the_answer_is_unread_in_it() {
    let w = world().await;
    let asked = w
        .say(w.public, &format!("@{} 일정 모아줘", w.handle), None)
        .await;
    answer_the_pending_turn(&w, w.public, "일정 모았어요").await;
    let answer_seq = w.the_answers_seq(w.public).await;
    let follows: Vec<(Uuid, String, i64)> = sqlx::query_as(
        "SELECT member_id, state, last_read_reply_seq FROM thread_follow \
          WHERE workspace_id = $1 AND root_id = $2 ORDER BY member_id",
    )
    .bind(w.workspace)
    .bind(asked)
    .fetch_all(&w.su)
    .await
    .expect("thread follows");
    assert_eq!(follows.len(), 1, "only the asker follows: {follows:?}");
    assert_ne!(follows[0].0, w.agent, "the agent never follows");
    assert_eq!(follows[0].1, "auto");
    assert_eq!(
        follows[0].2,
        answer_seq - 1,
        "the position is just before the answer, so the answer is the asker's one unread reply"
    );
}
