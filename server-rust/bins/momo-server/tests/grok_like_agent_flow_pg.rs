//! #4618 — 「grok이 실행을 집어 가지 않음」의 서버 쪽 재현.
//!
//! 한 가지를 묻는다: **현행 루틴 지시문(`docs/SELF_HOST_AGENT.ko.md` §3.3.17.4)대로 부르는
//! 호스팅 에이전트가, 사람의 DM·채널 멘션·연속 DM을 서버에서 받아 답까지 갈 수 있는가.**
//! 실제 Axum 라우터를 `momo_app`(NOBYPASSRLS) 풀 위에 띄우고, grok이 쓰는 것과 같은 정적
//! bearer(같은 범위 7개)로 modern wire를 직접 쏜다(`common/modern_wire.rs`). 서버 안쪽 함수를
//! 부르지 않고 HTTP로만 확인한다.
//!
//! | 시험 | 따라가는 길 | 빨개지면 |
//! |---|---|---|
//! | `a_dm_goes_from_the_owner_to_a_reply_the_way_the_routine_does` | 유휴 wake(ping·inbox·job_start{}) → 소유자 DM → wake(ping·inbox: message+agent_job → job_start → run_event → run_complete) → 답이 DM에 | 수령·시작·완료 중 한 곳이 끊김 |
//! | `a_channel_mention_goes_the_same_way` | 승인 채널의 `@handle` 멘션 | 멘션 job·inbox 이벤트·claim 중 한 곳이 끊김 |
//! | `two_quick_dms_are_one_turn_and_the_next_one_after_the_claim_is_a_new_turn` | 연속 DM 합치기(#4017): run 1 · job 1 · message 이벤트 2 · agent_job 이벤트 1, 둘 다 job에 실림, 수령 뒤 DM은 새 run | 합치기가 claim·이벤트를 막거나 두 번째 말이 사라짐 |
//! | `a_job_whose_inbox_page_was_already_read_is_still_taken_by_job_start` | 다른 wake가 inbox 페이지를 먼저 읽어 이벤트가 안 보여도 `oort_job_start {}`가 job을 가져감(루틴 5단계 안전망) | 안전망이 서버에서 깨짐 |
//! | `an_app_marked_agent_still_serves_its_owners_dm` | `agent.connector_owner_human_id`가 소유자인 에이전트의 소유자 DM(#3938 claim 술어) | 새 claim 술어가 소유자까지 막음 |
//!
//! 사실 확인용 시험이라 서버 코드를 고치지 않는다. 초록이면 「이 길은 서버에서 끊기지 않는다」는 증거다.
//! 마지막 시험들은 이 호출 기록이 서버의 `agent_port.call` 감사 행과 일치하는지도 본다(ADR-0200 증보 4).
//!
//! 격리 DB에서만:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:<port>/momo \
//!   cargo test -p momo-server --test grok_like_agent_flow_pg -- --ignored --test-threads=1
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
    owner: Uuid,
    owner_jwt: String,
    agent: Uuid,
    handle: String,
    bearer: String,
    public: Uuid,
    dm: Uuid,
}

/// A workspace with one person (이도현), one public channel the agent is approved for, the
/// owner's 1:1 DM with the agent, and a hosted agent whose connection carries grok's seven
/// scopes (`workspace:propose` included).
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
    for sql in [
        "UPDATE hosted_agent_connection \
            SET approved_scopes = approved_scopes || ARRAY['workspace:propose']::text[] \
          WHERE workspace_id = $1 AND agent_member_id = $2",
        "UPDATE token SET scopes = scopes || ARRAY['workspace:propose']::text[] \
          WHERE workspace_id = $1 AND actor_member_id = $2 AND kind = 'agent_bearer'",
    ] {
        sqlx::query(sql)
            .bind(workspace)
            .bind(agent.id)
            .execute(&su)
            .await
            .expect("grok's seventh scope");
    }
    World {
        su,
        base,
        http: reqwest::Client::new(),
        workspace,
        owner,
        owner_jwt,
        agent: agent.id,
        handle: agent.handle.clone(),
        bearer: agent.bearer.expect("a live connection has a bearer"),
        public,
        dm,
    }
}

impl World {
    fn wire(&self) -> Wire {
        Wire::new(&self.base, &self.bearer)
    }

    /// The owner says something in `channel`; returns the message id.
    async fn say(&self, channel: Uuid, body: &str) -> Uuid {
        let response = self
            .http
            .post(format!(
                "{}/v1/workspaces/{}/channels/{channel}/messages",
                self.base, self.workspace
            ))
            .bearer_auth(&self.owner_jwt)
            .json(&json!({"clientMsgId": Uuid::new_v4(), "body": body}))
            .send()
            .await
            .expect("send");
        let status = response.status().as_u16();
        let value: Value = response.json().await.expect("send body");
        assert_eq!(status, 201, "send: {value}");
        Uuid::parse_str(value["id"].as_str().expect("id")).expect("message uuid")
    }

    /// `(status, addressing)` of every run of the agent, oldest first.
    async fn runs(&self) -> Vec<(String, Option<String>)> {
        sqlx::query_as(
            "SELECT status::text, input->>'addressing' FROM agent_run \
              WHERE workspace_id = $1 AND agent_member_id = $2 ORDER BY created_at, id",
        )
        .bind(self.workspace)
        .bind(self.agent)
        .fetch_all(&self.su)
        .await
        .expect("runs")
    }

    async fn jobs(&self) -> i64 {
        jobs_for(&self.su, self.workspace, self.agent).await
    }

    /// The agent's own lines in `channel`, oldest first.
    async fn agent_lines(&self, channel: Uuid) -> Vec<String> {
        sqlx::query_scalar(
            "SELECT body FROM message WHERE workspace_id = $1 AND channel_id = $2 \
                AND author_member_id = $3 ORDER BY seq",
        )
        .bind(self.workspace)
        .bind(channel)
        .bind(self.agent)
        .fetch_all(&self.su)
        .await
        .expect("agent lines")
    }

    async fn audit_count(&self, action: &str) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE workspace_id = $1 AND action = $2")
            .bind(self.workspace)
            .bind(action)
            .fetch_one(&self.su)
            .await
            .expect("audit count")
    }
}

fn kinds_in(events: &[(String, String)], channel: Uuid) -> Vec<String> {
    let channel = channel.to_string().to_lowercase();
    let mut kinds: Vec<String> = events
        .iter()
        .filter(|(_, event_channel)| *event_channel == channel)
        .map(|(kind, _)| kind.clone())
        .collect();
    kinds.sort();
    kinds
}

/// Steps 0, 1 and 5 of the routine on a quiet inbox: ping, read, then `oort_job_start {}`
/// once. Returns the saved cursor.
async fn idle_wake(wire: &Wire, cursor: Option<&str>) -> String {
    let ping = wire.ping().await;
    assert!(ping.is_ok(), "{ping:?}");
    assert_eq!(ping.structured()["status"], "ok");
    let inbox = wire.inbox(cursor).await;
    assert!(inbox.is_ok(), "{inbox:?}");
    assert!(
        events(&inbox).is_empty(),
        "a quiet inbox has no events: {:?}",
        inbox.body
    );
    let start = wire.job_start().await;
    assert!(start.is_ok(), "{start:?}");
    assert!(
        start.structured()["job"].is_null(),
        "nothing pending → job is null: {:?}",
        start.body
    );
    next_cursor(&inbox)
}

/// One tracked turn, the way step 3 a)…d) goes: start, one progress report, complete.
/// Returns the `oort_run_complete` answer.
async fn work_one_turn(wire: &Wire, expected_channel: Uuid, answer: &str) -> (Value, Reply) {
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
        Some(expected_channel.to_string().to_lowercase()),
        "the job is for the channel the person spoke in"
    );
    assert_eq!(
        start.structured()["started"],
        json!(true),
        "the start report went in"
    );
    assert_eq!(start.structured()["resumed"], json!(false));
    let handle = job["leaseHandle"]
        .as_str()
        .expect("leaseHandle")
        .to_string();
    let event = wire.run_event(&handle, "자료 정리 중").await;
    assert!(event.is_ok(), "{event:?}");
    let done = wire.run_complete(&handle, answer).await;
    assert!(done.is_ok(), "{done:?}");
    assert!(
        done.structured()["messageId"].is_string(),
        "a non-empty answer lands as a message: {:?}",
        done.body
    );
    (start.structured().clone(), done)
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_dm_goes_from_the_owner_to_a_reply_the_way_the_routine_does() {
    let w = world().await;
    let wire = w.wire();

    // Wake 1: nothing to do.
    let cursor = idle_wake(&wire, None).await;
    assert!(w.runs().await.is_empty());

    // The owner talks to the agent in their 1:1 DM, with no handle: the DM rule.
    w.say(w.dm, "배포 결과 정리해줄래요?").await;
    assert_eq!(w.jobs().await, 1, "one hosted job");
    assert_eq!(
        w.runs().await,
        vec![("queued".to_string(), Some("dm_implicit".to_string()))]
    );

    // Wake 2: ping, read (message + agent_job), start, report, complete.
    assert!(wire.ping().await.is_ok());
    let inbox = wire.inbox(Some(&cursor)).await;
    assert!(inbox.is_ok(), "{inbox:?}");
    assert_eq!(
        kinds_in(&events(&inbox), w.dm),
        vec!["agent_job".to_string(), "message".to_string()],
        "the DM shows up as its message and as the job: {:?}",
        inbox.body
    );
    let (started, done) = work_one_turn(&wire, w.dm, "정리했어요").await;
    assert!(
        started.to_string().contains("배포 결과 정리해줄래요?"),
        "the request is in the start answer"
    );
    assert_eq!(
        w.runs().await,
        vec![("succeeded".to_string(), Some("dm_implicit".to_string()))]
    );
    assert_eq!(w.agent_lines(w.dm).await, vec!["정리했어요".to_string()]);

    // The agent never reads its own answer back out of the inbox, and nothing is left to take.
    let after = wire.inbox(Some(&next_cursor(&inbox))).await;
    let own_message = done.structured()["messageId"]
        .as_str()
        .expect("messageId")
        .to_lowercase();
    assert!(
        after.structured()["events"]
            .as_array()
            .expect("events")
            .iter()
            .all(|event| event["messageId"].as_str().map(str::to_lowercase)
                != Some(own_message.clone())),
        "the author does not receive its own message: {:?}",
        after.body
    );
    let again = wire.job_start().await;
    assert!(again.structured()["job"].is_null());

    // What the server wrote down about this client is what this client did.
    assert_eq!(
        trace_as_sent(&trace_rows(&w.su, w.workspace, w.agent).await),
        wire.log()
    );
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_channel_mention_goes_the_same_way() {
    let w = world().await;
    let wire = w.wire();
    let cursor = idle_wake(&wire, None).await;

    w.say(w.public, &format!("@{} 이번 주 일정 모아줘", w.handle))
        .await;
    assert_eq!(w.jobs().await, 1);
    assert!(wire.ping().await.is_ok());
    let inbox = wire.inbox(Some(&cursor)).await;
    assert!(inbox.is_ok(), "{inbox:?}");
    assert_eq!(
        kinds_in(&events(&inbox), w.public),
        vec!["agent_job".to_string(), "message".to_string()],
        "{:?}",
        inbox.body
    );
    let (started, _) = work_one_turn(&wire, w.public, "일정 모았어요").await;
    assert!(started.to_string().contains("이번 주 일정 모아줘"));
    assert_eq!(
        w.runs().await,
        vec![("succeeded".to_string(), Some("mention".to_string()))]
    );
    assert_eq!(
        w.agent_lines(w.public).await,
        vec!["일정 모았어요".to_string()]
    );
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn two_quick_dms_are_one_turn_and_the_next_one_after_the_claim_is_a_new_turn() {
    let w = world().await;
    let wire = w.wire();
    let cursor = idle_wake(&wire, None).await;

    // 「ㅎㅇ」 then 「반가」: one utterance in two bubbles (#4017).
    w.say(w.dm, "첫째 말이에요").await;
    w.say(w.dm, "둘째 말도 있어요").await;
    assert_eq!(
        w.jobs().await,
        1,
        "the second message joins the queued turn"
    );
    assert_eq!(w.runs().await.len(), 1);
    assert_eq!(w.audit_count("agent.dm.coalesced").await, 1);

    // The runtime still sees both messages, and exactly one job.
    assert!(wire.ping().await.is_ok());
    let inbox = wire.inbox(Some(&cursor)).await;
    assert_eq!(
        kinds_in(&events(&inbox), w.dm),
        vec![
            "agent_job".to_string(),
            "message".to_string(),
            "message".to_string()
        ],
        "{:?}",
        inbox.body
    );

    // One start answer carries both lines — in the job's snapshot and in the live page.
    let start = wire.job_start().await;
    assert!(start.is_ok(), "{start:?}");
    let job = &start.structured()["job"];
    let snapshot = job["work"]["recentMessages"].to_string();
    assert!(
        snapshot.contains("첫째 말이에요") && snapshot.contains("둘째 말도 있어요"),
        "the folded turn's snapshot has both: {snapshot}"
    );
    let live = start.structured()["conversation"].to_string();
    assert!(
        live.contains("첫째 말이에요") && live.contains("둘째 말도 있어요"),
        "{live}"
    );
    let handle = job["leaseHandle"].as_str().expect("handle").to_string();
    assert!(wire.run_complete(&handle, "둘 다 읽었어요").await.is_ok());
    assert_eq!(
        w.agent_lines(w.dm).await,
        vec!["둘 다 읽었어요".to_string()]
    );

    // After the claim, a new message is a turn of its own.
    w.say(w.dm, "셋째 말이에요").await;
    assert_eq!(
        w.jobs().await,
        2,
        "a claimed turn cannot take a new message in"
    );
    assert_eq!(w.runs().await.len(), 2);
    assert_eq!(
        w.audit_count("agent.dm.coalesced").await,
        1,
        "and nothing was folded"
    );
    let (second, _) = work_one_turn(&wire, w.dm, "셋째도 받았어요").await;
    assert!(second.to_string().contains("셋째 말이에요"));
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_job_whose_inbox_page_was_already_read_is_still_taken_by_job_start() {
    let w = world().await;
    let wire = w.wire();
    let cursor = idle_wake(&wire, None).await;
    w.say(w.dm, "표 하나 만들어줘").await;

    // Another wake read the page first and went away without claiming (routine step 5).
    let first = wire.inbox(Some(&cursor)).await;
    assert!(
        kinds_in(&events(&first), w.dm).contains(&"agent_job".to_string()),
        "{:?}",
        first.body
    );
    let saved = next_cursor(&first);

    // This wake finds nothing new in the inbox — and `oort_job_start {}` still hands the job over.
    assert!(wire.ping().await.is_ok());
    let second = wire.inbox(Some(&saved)).await;
    assert!(events(&second).is_empty(), "{:?}", second.body);
    work_one_turn(&wire, w.dm, "표 만들었어요").await;
    assert_eq!(
        w.runs().await,
        vec![("succeeded".to_string(), Some("dm_implicit".to_string()))]
    );
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn an_app_marked_agent_still_serves_its_owners_dm() {
    let w = world().await;
    let wire = w.wire();
    let cursor = idle_wake(&wire, None).await;
    // The 「앱 실행 장소」 mark (#3938): the agent runs its owner's connected apps.
    mark_connector_owner(&w.su, w.workspace, w.agent, w.owner).await;

    w.say(w.dm, "메일 요약해줘").await;
    assert_eq!(w.jobs().await, 1);
    assert!(wire.ping().await.is_ok());
    let inbox = wire.inbox(Some(&cursor)).await;
    assert_eq!(
        kinds_in(&events(&inbox), w.dm),
        vec!["agent_job".to_string(), "message".to_string()],
        "the owner's own message is still visible to the marked agent: {:?}",
        inbox.body
    );
    work_one_turn(&wire, w.dm, "요약했어요").await;
    assert_eq!(
        w.runs().await,
        vec![("succeeded".to_string(), Some("dm_implicit".to_string()))],
        "the owner's turn is served, not cancelled by the connector-owner predicate"
    );
    assert_eq!(w.audit_count("agent.connector_owner.job_closed").await, 0);
}
