//! #4622 / ADR-0200 증보 5 「답 자리 현황」 — 한 run의 **최종 답이 오늘 어디에 놓이는지**, 서버가 쓴 행으로 고정한다.
//!
//! 실제 Axum 라우터를 `momo_app`(NOBYPASSRLS) 풀 위에 띄우고, 호스팅 에이전트가 현행 루틴대로(ping·inbox·
//! `oort_job_start`·`oort_run_event`·`oort_run_complete`) 답하게 한 뒤, **`message` 행의 `root_id`·`reply_to_id`**를
//! 읽는다. 서버 안쪽 함수를 부르지 않고 HTTP로만 움직인다. 같은 harness를 쓰는 `grok_like_agent_flow_pg.rs`는
//! 답이 DM에 도착하는지까지만 보고, 어느 자리인지는 어떤 시험도 잠그지 않았다(인용 `reply_to_id`만 관리형
//! 워커 시험이 잠근다).
//!
//! | 시험 | 오늘의 자리 | 이 시험이 바뀌는 때 |
//! |---|---|---|
//! | `a_dm_answer_lands_in_the_main_flow_quoting_the_message` | 본류 + 인용 | 바뀌지 않아요(E도 DM은 본류) |
//! | `a_top_level_channel_mention_is_answered_in_the_main_flow_quoting_it` | **본류 + 인용** | 서버 정렬 2차(`ADR-0200 증보 5 「열어 두는 것」 1`)가 승인되면 `root_id`가 트리거 id가 돼요 |
//! | `a_mention_inside_a_thread_is_answered_outside_that_thread` | **스레드 밖 본류 + 인용** | 서버 정렬 1차가 승인되면 `root_id`가 그 스레드의 root가 돼요 |
//!
//! **이 시험은 현행 계약(ADR-0148 규칙 6, 「인용은 본류에 두고 맥락만 끌어온다」)을 고정하는 것이지 그 자리가
//! 옳다는 선언이 아니다.** 규칙 E(채널 최상위 멘션은 그 메시지의 스레드, 스레드 안은 같은 스레드)와 어긋나는 두
//! 줄이 어디인지를 시험이 이름으로 보여 주고, 서버가 정렬되는 PR은 이 시험을 **먼저 빨갛게 만들고** 고친다.
//! 보충으로, 외부 에이전트가 「스레드 안 → 같은 스레드」를 따를 수 있는 근거(트리거의 `rootId`가 job 시작 답의
//! 대화에 실린다)도 같은 시험에서 확인한다(지시문 `SELF_HOST_AGENT.md` §3.3.17.4 4번이 기대는 사실).
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
async fn a_top_level_channel_mention_is_answered_in_the_main_flow_quoting_it() {
    let w = world().await;
    let asked = w
        .say(
            w.public,
            &format!("@{} 이번 주 일정 모아줘", w.handle),
            None,
        )
        .await;
    answer_the_pending_turn(&w, w.public, "일정 모았어요").await;
    // TODAY (ADR-0148 rule 6): main flow + quote. Rule E wants a thread rooted at `asked`
    // (`root_id == asked`). That is ADR-0200 증보 5 「열어 두는 것」 1, second step.
    assert_eq!(
        w.agent_places(w.public).await,
        vec![(None, Some(asked))],
        "the server places a channel answer; it is not the agent's choice"
    );
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_mention_inside_a_thread_is_answered_outside_that_thread() {
    let w = world().await;
    let root = w.say(w.public, "다음 주 배포 일정", None).await;
    let asked = w
        .say(
            w.public,
            &format!("@{} 이어서 정리해줘", w.handle),
            Some(root),
        )
        .await;
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

    // TODAY: the final answer leaves the thread. `root_id` is NULL although the question was asked
    // inside the thread of `root`. Rule E wants `root_id == root`. That is ADR-0200 증보 5 「열어 두는
    // 것」 1, first step.
    assert_eq!(
        w.agent_places(w.public).await,
        vec![(None, Some(asked))],
        "the final answer is at the top level and quotes the in-thread message"
    );
}
