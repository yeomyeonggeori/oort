//! #4621 / ADR-0200 증보 6 — 에이전트 확인 박자(`cadence`): 「다음 확인 때 가져가요」의 근거.
//!
//! 서버는 에이전트가 Agent Port에 **허용되어 부른 호출 시각**(`audit_log` `auth.agent_bearer.used`)에서
//! 깨어남 묶음을 만들고, 묶음 시작 사이 간격의 중앙값으로 박자를 추정한다. 이 파일은 실제 Axum 라우터를
//! `momo_app`(NOBYPASSRLS) 풀 위에 띄우고, 멤버가 읽는 `GET …/agents/{agent}/liveness`와 관리자가 읽는
//! `GET …/hosted-agent-connections`로만 확인한다. 순수 추정식의 표 시험은 `momo-agent`의
//! `hosted_cadence.rs`에 있다.
//!
//! 픽스처 행은 **실제 Agent Port 호출이 남긴 행을 본떠서** 만든다(`real_detail`): 호출 하나를 정말로 보내고
//! 그 행의 `detail`을 복제해, 쓰는 쪽(`auth.rs`)이 모양을 바꾸면 이 시험이 같이 빨개진다. 시각은 superuser가
//! 과거 `created_at`으로 직접 넣는다(실제 호출의 행은 `now()`로만 남아 늙힐 수 없다).
//!
//! | 시험 | 증명 | 빨개지면 |
//! |---|---|---|
//! | `a_fifteen_minute_routine_reads_routine_fifteen_for_the_member_and_the_admin` | 중앙값 15 ≠ 평균 16.8인 실측 모양 간격 + 깨어남마다 다른 호출 수·간격 → 멤버와 관리자가 같은 `routine(15)`, 마감 = 마지막 깨어남 시작 + 30분, 늦지 않음 | 중앙값→평균, 묶음 없이 원시 간격, 마감 배수 |
//! | `four_intervals_make_a_beat_and_three_do_not` | 깨어남 4개(간격 3) → `unknown`, 5개(간격 4) → `routine` | 최소 표본 |
//! | `a_beat_that_broke_reads_late_and_a_slow_one_does_not` | 마지막 호출이 3박(45분) 넘게 없으면 `late`, 아니면 아님 | 늦음 배수 |
//! | `a_poller_reads_realtime_and_carries_no_numbers` | 20초마다 40분 → `realtime` 하나만 | realtime 규칙 |
//! | `a_poller_that_went_quiet_is_not_realtime_any_more` | 같은 20초마다 40분이 두 시간 전에 끝났다 → `unknown`(`realtime`은 「지금」의 말이에요) | realtime의 현재 조건 |
//! | `an_agent_that_wakes_whenever_somebody_writes_reads_unknown` | 간격이 제각각 → `unknown` | 규칙성 |
//! | `the_loader_counts_only_this_agents_admitted_agent_port_calls_inside_the_window` | 창 밖·다른 에이전트·다른 action(`agent_port.call`, 거절된 호출 `scope_denied`)·REST 경로·다른 워크스페이스의 행은 세지 않고, 같은 id를 두 번 줘도 두 배가 되지 않고, 상한은 가장 새로운 것부터 | 술어 하나씩, 중복 제거 |
//! | `the_beat_is_read_from_the_rows_the_agent_port_really_writes` | 실제 호출 N번 = 로더가 N개 (감사 두 줄 중 `used`만) | 쓰는 쪽과 읽는 쪽이 어긋남 |
//! | `a_connection_that_is_not_active_reads_unknown_whatever_it_did` | 활성 에이전트가 era 안의 15분 루틴을 가진 채 `cleanup_pending`·`disconnected`로 가면 `unknown`(era가 아니라 연결이 이유) | 비활성 읽기 안 함 + 가드 |
//! | `the_wire_is_closed_and_a_stranger_gets_the_same_404` | 멤버 응답에 허용된 키 밖의 것(관리자 필드·간격 수)이 없고, 채널을 공유하지 않는 멤버는 404 (키 집합의 정확한 일치는 `agent_cadence_contract`가 잠가요) | 새 키·탐침 |
//! | `a_new_connection_counts_only_its_own_calls` | 해제 뒤 다시 등록한 새 연결은 옛 연결의 15분 루틴을 물려받지 않고(`unknown`) 자기 호출로만 박자를 만든다 | 연결 era 하한 |
//! | `the_read_stops_at_its_limit_even_when_the_planner_expects_a_handful` | 한 에이전트의 호출 6,000행, 플래너가 적게 보는 통계 → 한도 50이면 읽은 튜플이 150 이하(대조: 같은 문장을 플래너에 맡기면 1,000 이상) | 순서 인덱스 스캔 강제 |
//! | `a_beat_read_that_cannot_finish_leaves_the_liveness_routes_answering` | 표를 다른 세션이 잠그면 박자 읽기는 2초에 취소되고 라우트는 200 + `unknown`, 풀려나면 다시 `routine` | 읽기 실패 격리 |
//! | `the_limit_is_per_agent_not_for_the_whole_read` | 에이전트 둘 × 한도 2 → 각자 자기 최신 2개 | 에이전트별 LATERAL 한도 |
//! | `an_agent_with_a_new_connection_does_not_cost_its_old_rows` | 연결이 한 시간 전이고 그 전에 6,000행이 있는 에이전트에서 era 안 10행을 읽는 데 100튜플 이하(era 하한이 필터가 아니라 인덱스 조건) | era 하한의 계획 모양 |
//!
//! 격리 DB에서만:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:<port>/momo \
//!   cargo test -p momo-server --test agent_cadence_conformance_pg -- --ignored --test-threads=1
//! ```

#[path = "common/apps_pg.rs"]
mod apps_pg;
#[path = "common/modern_wire.rs"]
mod modern_wire;

use apps_pg::*;
use chrono::{DateTime, Duration, TimeZone, Utc};
use modern_wire::*;
use momo_db::sqlx;
use momo_db::PgPool;
use serde_json::{json, Value};
use uuid::Uuid;

const MIN: i64 = 60;

/// Intervals (minutes, newest first) a real 15-minute routine produced (#4284: 10-29 min, median
/// 15). Median 15, mean 16.8: the two differ on purpose.
const REAL_15: [i64; 5] = [29, 15, 10, 16, 14];

struct World {
    su: PgPool,
    base: String,
    workspace: Uuid,
    admin_jwt: String,
    viewer_jwt: String,
    channel: Uuid,
    admin: Uuid,
    client: reqwest::Client,
}

async fn world() -> World {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let base = start_server(app, ServerOptions::hosted_open()).await;
    let workspace = seed_workspace(&su).await;
    let (admin, admin_jwt) = seed_human(&su, workspace, "owner", "이도현").await;
    let (viewer, viewer_jwt) = seed_human(&su, workspace, "member", "박서연").await;
    let channel = seed_channel(&su, workspace, "public", &[admin, viewer]).await;
    World {
        su,
        base,
        workspace,
        admin_jwt,
        viewer_jwt,
        channel,
        admin,
        client: reqwest::Client::new(),
    }
}

/// A moment on a whole millisecond, so what the database stores (microseconds) and what the wire
/// reports (milliseconds) are the same instant and a deadline can be compared exactly.
fn whole_ms_now() -> DateTime<Utc> {
    Utc.timestamp_millis_opt(Utc::now().timestamp_millis())
        .single()
        .expect("a valid instant")
}

/// The loader the way the routes call it: inside a transaction (it opens a savepoint), as the
/// superuser (RLS is covered by the route tests; here the predicates are what is under test).
async fn load(
    w: &World,
    agents: &[Uuid],
    since: DateTime<Utc>,
    limit: i64,
) -> std::collections::HashMap<Uuid, Vec<DateTime<Utc>>> {
    let mut tx = w.su.begin().await.expect("begin");
    let loaded =
        momo_agent::load_agent_call_times_in_tx(&mut tx, w.workspace, agents, since, limit)
            .await
            .expect("the savepoint machinery")
            .expect("the read");
    tx.rollback().await.expect("rollback");
    loaded
}

/// One routine wake: the first call `start` seconds before `now`, each next call `spread[i]` seconds
/// after the one before.
fn wake(now: DateTime<Utc>, start: i64, spread: &[i64]) -> Vec<DateTime<Utc>> {
    let mut at = start;
    let mut out = vec![now - Duration::seconds(at)];
    for step in spread {
        at -= step;
        out.push(now - Duration::seconds(at));
    }
    out
}

/// Wakes whose starts are `intervals_newest_first[i]` minutes apart, the newest starting
/// `newest_ago` seconds before `now`. Each wake has its own number of calls and spacing (3 to 6
/// calls, 8 to 55 s apart). Every interval stays at 8 minutes or more so that two wakes are never
/// one by the 5-minute wake gap.
fn wakes(
    now: DateTime<Utc>,
    newest_ago: i64,
    intervals_newest_first: &[i64],
) -> Vec<DateTime<Utc>> {
    let shapes: [&[i64]; 4] = [
        &[8, 21],
        &[12, 31, 9, 55],
        &[17, 40, 14],
        &[10, 25, 33, 46, 19],
    ];
    let mut calls = Vec::new();
    let mut start = newest_ago;
    for (n, minutes) in std::iter::once(&0)
        .chain(intervals_newest_first.iter())
        .enumerate()
    {
        start += minutes * MIN;
        calls.extend(wake(now, start, shapes[n % shapes.len()]));
    }
    calls
}

impl World {
    /// A hosted agent with a live connection that shares the channel with both people.
    async fn agent(&self, label: &str) -> SeededAgent {
        let agent = seed_hosted_agent(
            &self.su,
            self.workspace,
            self.admin,
            label,
            &[self.channel],
            true,
            false,
        )
        .await;
        join_channel(&self.su, self.workspace, self.channel, agent.id).await;
        // The beat counts an agent's calls from the creation of its current connection (the era).
        // The fixtures put calls hours in the past, so the connection is made older than the
        // 24-hour window; the era test sets its own date.
        sqlx::query(
            "UPDATE hosted_agent_connection SET created_at = now() - interval '48 hours' \
              WHERE workspace_id = $1 AND agent_member_id = $2",
        )
        .bind(self.workspace)
        .bind(agent.id)
        .execute(&self.su)
        .await
        .expect("age the connection");
        agent
    }

    fn wire(&self, agent: &SeededAgent) -> Wire {
        Wire::new(&self.base, agent.bearer.as_deref().expect("bearer"))
    }

    /// The `detail` of a REAL admitted Agent Port call, made right now by a throwaway agent. The
    /// fixture rows copy it, so a change to what the writer records changes the fixtures too.
    async fn real_detail(&self) -> Value {
        let probe = self.agent("probe").await;
        assert!(self.wire(&probe).ping().await.is_ok());
        let row: (Value, Option<String>) = sqlx::query_as(
            "SELECT detail, target_type FROM audit_log \
              WHERE workspace_id = $1 AND actor_member_id = $2 AND action = $3",
        )
        .bind(self.workspace)
        .bind(probe.id)
        .bind(momo_agent::AGENT_PORT_CALL_ACTION)
        .fetch_one(&self.su)
        .await
        .expect("the real call left its audit row");
        assert_eq!(row.1.as_deref(), Some("route"));
        assert_eq!(
            row.0["path"],
            json!(momo_agent::AGENT_PORT_CALL_PATH),
            "a real admitted call names the Agent Port path: {}",
            row.0
        );
        row.0
    }

    async fn token_of(&self, agent: Uuid) -> Option<Uuid> {
        sqlx::query_scalar(
            "SELECT id FROM token WHERE workspace_id = $1 AND actor_member_id = $2 \
                AND kind = 'agent_bearer' LIMIT 1",
        )
        .bind(self.workspace)
        .bind(agent)
        .fetch_optional(&self.su)
        .await
        .expect("token lookup")
    }

    /// Put `used` rows for `agent` at the given times, shaped exactly like the writer's.
    async fn put_calls(&self, agent: Uuid, times: &[DateTime<Utc>], detail: &Value) {
        self.put_rows(
            self.workspace,
            agent,
            momo_agent::AGENT_PORT_CALL_ACTION,
            times,
            detail,
        )
        .await;
    }

    async fn put_rows(
        &self,
        workspace: Uuid,
        agent: Uuid,
        action: &str,
        times: &[DateTime<Utc>],
        detail: &Value,
    ) {
        let token = self.token_of(agent).await;
        sqlx::query(
            "INSERT INTO audit_log(workspace_id, actor_member_id, action, target_type, via_token_id, \
                                   detail, created_at) \
             SELECT $1, $2, $3, 'route', $4, $5, t FROM unnest($6::timestamptz[]) AS t",
        )
        .bind(workspace)
        .bind(agent)
        .bind(action)
        .bind(token)
        .bind(detail)
        .bind(times)
        .execute(&self.su)
        .await
        .expect("put audit rows");
    }

    /// What a member who shares a channel with the agent reads.
    async fn member_view(&self, agent: Uuid) -> Value {
        let response = self
            .client
            .get(format!(
                "{}/v1/workspaces/{}/agents/{}/liveness",
                self.base, self.workspace, agent
            ))
            .bearer_auth(&self.viewer_jwt)
            .send()
            .await
            .expect("liveness");
        let status = response.status().as_u16();
        let body: Value = response.json().await.expect("liveness body");
        assert_eq!(status, 200, "liveness: {body}");
        body
    }

    /// What the workspace admin reads: the connection list, one row per connection.
    async fn admin_view(&self, agent: Uuid) -> Value {
        let response = self
            .client
            .get(format!(
                "{}/v1/workspaces/{}/hosted-agent-connections",
                self.base, self.workspace
            ))
            .bearer_auth(&self.admin_jwt)
            .send()
            .await
            .expect("connections");
        let status = response.status().as_u16();
        let body: Value = response.json().await.expect("connections body");
        assert_eq!(status, 200, "connections: {body}");
        body["connections"]
            .as_array()
            .expect("connections array")
            .iter()
            .find(|connection| {
                connection["agentMemberId"]
                    .as_str()
                    .is_some_and(|id| id.eq_ignore_ascii_case(&agent.to_string()))
            })
            .cloned()
            .expect("the agent's connection is listed")
    }

    /// Both views' `cadence`, which must say the same thing.
    async fn cadence(&self, agent: Uuid) -> Value {
        let member = self.member_view(agent).await["cadence"].clone();
        let admin = self.admin_view(agent).await["liveness"]["cadence"].clone();
        assert!(
            member.is_object(),
            "the member view carries a cadence: {member}"
        );
        assert_eq!(member, admin, "member and admin read the same beat");
        member
    }
}

/// `kind` is the closed vocabulary; a `routine` carries exactly the three measurements and the
/// others carry none; nothing outside the four keys exists.
fn assert_cadence_is_closed(cadence: &Value) {
    let object = cadence.as_object().expect("cadence object");
    let kind = cadence["kind"].as_str().expect("kind");
    assert!(
        ["realtime", "routine", "unknown"].contains(&kind),
        "{cadence}"
    );
    let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
    keys.sort_unstable();
    if kind == "routine" {
        assert_eq!(
            keys,
            ["expectedCheckAtMs", "kind", "late", "typicalMinutes"],
            "{cadence}"
        );
        assert!(cadence["typicalMinutes"].as_i64().is_some_and(|m| m >= 1));
        assert!(cadence["expectedCheckAtMs"].as_i64().is_some());
        assert!(cadence["late"].is_boolean());
    } else {
        assert_eq!(keys, ["kind"], "{kind} carries no numbers: {cadence}");
    }
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_fifteen_minute_routine_reads_routine_fifteen_for_the_member_and_the_admin() {
    let w = world().await;
    let detail = w.real_detail().await;
    let agent = w.agent("grokish").await;
    let now = whole_ms_now();
    // the newest wake began 4 minutes ago; the five intervals are the real, uneven ones
    w.put_calls(agent.id, &wakes(now, 4 * MIN, &REAL_15), &detail)
        .await;

    let cadence = w.cadence(agent.id).await;
    assert_cadence_is_closed(&cadence);
    assert_eq!(cadence["kind"], "routine", "{cadence}");
    assert_eq!(
        cadence["typicalMinutes"], 15,
        "median 15, not the mean (16.8 -> 17): {cadence}"
    );
    assert_eq!(cadence["late"], false, "{cadence}");
    assert_eq!(
        cadence["expectedCheckAtMs"].as_i64(),
        Some((now - Duration::minutes(4) + Duration::minutes(30)).timestamp_millis()),
        "the deadline is the newest wake's start + two beats: {cadence}"
    );
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn four_intervals_make_a_beat_and_three_do_not() {
    let w = world().await;
    let detail = w.real_detail().await;
    let now = whole_ms_now();

    let four_wakes = w.agent("fourwakes").await;
    w.put_calls(four_wakes.id, &wakes(now, 2 * MIN, &[15, 15, 15]), &detail)
        .await;
    let cadence = w.cadence(four_wakes.id).await;
    assert_cadence_is_closed(&cadence);
    assert_eq!(cadence["kind"], "unknown", "three intervals: {cadence}");

    let five_wakes = w.agent("fivewakes").await;
    w.put_calls(
        five_wakes.id,
        &wakes(now, 2 * MIN, &[15, 15, 15, 15]),
        &detail,
    )
    .await;
    let cadence = w.cadence(five_wakes.id).await;
    assert_cadence_is_closed(&cadence);
    assert_eq!(cadence["kind"], "routine", "four intervals: {cadence}");
    assert_eq!(cadence["typicalMinutes"], 15);
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_beat_that_broke_reads_late_and_a_slow_one_does_not() {
    let w = world().await;
    let detail = w.real_detail().await;
    let now = whole_ms_now();

    // the newest wake began 50 minutes ago: its last call was about 49 minutes ago (> 3 beats = 45)
    let gone = w.agent("gone").await;
    w.put_calls(gone.id, &wakes(now, 50 * MIN, &[15; 6]), &detail)
        .await;
    let cadence = w.cadence(gone.id).await;
    assert_cadence_is_closed(&cadence);
    assert_eq!(cadence["kind"], "routine", "{cadence}");
    assert_eq!(cadence["late"], true, "no call for ~49 minutes: {cadence}");

    // began 40 minutes ago: ~39 minutes of silence is slow, not broken
    let slow = w.agent("slow").await;
    w.put_calls(slow.id, &wakes(now, 40 * MIN, &[15; 6]), &detail)
        .await;
    let cadence = w.cadence(slow.id).await;
    assert_eq!(cadence["kind"], "routine", "{cadence}");
    assert_eq!(
        cadence["late"], false,
        "~39 minutes is under three beats: {cadence}"
    );
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_poller_reads_realtime_and_carries_no_numbers() {
    let w = world().await;
    let detail = w.real_detail().await;
    let agent = w.agent("poller").await;
    let now = whole_ms_now();
    // a call every 20 seconds for 40 minutes, up to a few seconds ago
    let steady: Vec<_> = (0..=118)
        .map(|k| now - Duration::seconds(40 * MIN - k * 20))
        .collect();
    w.put_calls(agent.id, &steady, &detail).await;
    let cadence = w.cadence(agent.id).await;
    assert_cadence_is_closed(&cadence);
    assert_eq!(cadence["kind"], "realtime", "{cadence}");
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_poller_that_went_quiet_is_not_realtime_any_more() {
    let w = world().await;
    let detail = w.real_detail().await;
    let agent = w.agent("quiet-poller").await;
    let now = whole_ms_now();
    // the same call every 20 seconds for 40 minutes, but it ended two hours ago: `realtime` is a
    // word about this moment, so a poller that stopped is not it, and has no beat either
    let steady: Vec<_> = (0..=118)
        .map(|k| now - Duration::seconds(160 * MIN - k * 20))
        .collect();
    w.put_calls(agent.id, &steady, &detail).await;
    let cadence = w.cadence(agent.id).await;
    assert_cadence_is_closed(&cadence);
    assert_eq!(cadence["kind"], "unknown", "{cadence}");
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn an_agent_that_wakes_whenever_somebody_writes_reads_unknown() {
    let w = world().await;
    let detail = w.real_detail().await;
    let agent = w.agent("chatty").await;
    let now = whole_ms_now();
    // intervals all over the place: 8, 25, 200, 14, 90, 9 minutes
    w.put_calls(
        agent.id,
        &wakes(now, 2 * MIN, &[9, 90, 14, 200, 25, 8]),
        &detail,
    )
    .await;
    let cadence = w.cadence(agent.id).await;
    assert_cadence_is_closed(&cadence);
    assert_eq!(cadence["kind"], "unknown", "not periodic: {cadence}");
}

/// The one `audit_log` read of this feature, asked directly, once per predicate. The route tests
/// above cannot tell these apart: the pure function drops calls outside the window by itself, and
/// RLS hides another tenant's rows from `momo_app`. So the loader is called on a superuser
/// connection (RLS does not apply) and what it returns is counted.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_loader_counts_only_this_agents_admitted_agent_port_calls_inside_the_window() {
    let w = world().await;
    let detail = w.real_detail().await;
    let agent = w.agent("counted").await;
    let other = w.agent("neighbor").await;
    let now = whole_ms_now();
    let since = now - Duration::hours(24);
    let at = |minutes_ago: i64| now - Duration::minutes(minutes_ago);

    // what counts: three admitted calls inside the window
    w.put_calls(agent.id, &[at(10), at(20), at(30)], &detail)
        .await;
    // outside the window (older than `since`)
    w.put_calls(
        agent.id,
        &[now - Duration::hours(25), now - Duration::hours(30)],
        &detail,
    )
    .await;
    // another agent of the same workspace
    w.put_calls(other.id, &[at(11), at(21), at(31), at(41)], &detail)
        .await;
    // another action of the same agent: the #4618 trace row ...
    w.put_rows(
        w.workspace,
        agent.id,
        "agent_port.call",
        &[at(12), at(22)],
        &detail,
    )
    .await;
    // ... and a REFUSED call, which carries the very same path and detail keys as an admitted one
    // (`write_agent_bearer_audit` writes both): the action is the only thing telling them apart
    w.put_rows(
        w.workspace,
        agent.id,
        "auth.agent_bearer.scope_denied",
        &[at(15), at(25)],
        &detail,
    )
    .await;
    // the same action on a path that is not the Agent Port (a REST call of some other credential)
    let mut rest = detail.clone();
    rest["path"] = json!("/v1/workspaces/rest-only/channels");
    w.put_calls(agent.id, &[at(13), at(23)], &rest).await;
    // another workspace: the same agent member id as actor (the FK is on member alone)
    let stranger_ws = seed_workspace(&w.su).await;
    w.put_rows(
        stranger_ws,
        agent.id,
        momo_agent::AGENT_PORT_CALL_ACTION,
        &[at(14), at(24)],
        &detail,
    )
    .await;

    // the same id twice: the calls must not be counted twice
    let loaded = load(&w, &[agent.id, agent.id, other.id], since, 2000).await;
    let mut mine = loaded
        .get(&agent.id)
        .cloned()
        .expect("this agent has calls");
    mine.sort_unstable();
    assert_eq!(
        mine,
        vec![at(30), at(20), at(10)],
        "exactly the three admitted Agent Port calls of this agent in this workspace inside the window"
    );
    assert_eq!(
        loaded.get(&other.id).map(Vec::len),
        Some(4),
        "the neighbor's calls are its own"
    );

    // the newest `limit` calls, newest first
    let capped = load(&w, &[other.id], since, 3).await;
    assert_eq!(
        capped.get(&other.id).cloned(),
        Some(vec![at(11), at(21), at(31)]),
        "the limit keeps the newest and says them newest first"
    );
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_beat_is_read_from_the_rows_the_agent_port_really_writes() {
    let w = world().await;
    let agent = w.agent("realcalls").await;
    let wire = w.wire(&agent);
    // five real admitted calls: each writes one `used` row (and one `agent_port.call` trace row)
    assert!(wire.ping().await.is_ok());
    assert!(wire.list().await.is_ok());
    assert!(wire.inbox(None).await.is_ok());
    assert!(wire.ping().await.is_ok());
    assert!(wire.inbox(None).await.is_ok());

    let used: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE workspace_id = $1 AND actor_member_id = $2 AND action = $3",
    )
    .bind(w.workspace)
    .bind(agent.id)
    .bind(momo_agent::AGENT_PORT_CALL_ACTION)
    .fetch_one(&w.su)
    .await
    .expect("count used rows");
    let traces: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE workspace_id = $1 AND actor_member_id = $2 AND action = 'agent_port.call'",
    )
    .bind(w.workspace)
    .bind(agent.id)
    .fetch_one(&w.su)
    .await
    .expect("count trace rows");
    assert_eq!(used, 5, "one `used` row per admitted call");
    assert_eq!(
        traces, 5,
        "the #4618 trace row is a second, different row per call"
    );

    let loaded = load(&w, &[agent.id], Utc::now() - Duration::hours(1), 2000).await;
    assert_eq!(
        loaded.get(&agent.id).map(Vec::len),
        Some(5),
        "the reader sees the five real calls — not ten, not zero"
    );

    // five calls in one go are one wake: nothing to take a median of yet
    let cadence = w.cadence(agent.id).await;
    assert_cadence_is_closed(&cadence);
    assert_eq!(cadence["kind"], "unknown", "{cadence}");
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_connection_that_is_not_active_reads_unknown_whatever_it_did() {
    let w = world().await;
    let detail = w.real_detail().await;
    let now = whole_ms_now();
    // an ACTIVE agent whose calls are all inside its connection's era: a perfect 15-minute routine
    let agent = w.agent("dormant").await;
    w.put_calls(agent.id, &wakes(now, 4 * MIN, &REAL_15), &detail)
        .await;
    assert_eq!(w.cadence(agent.id).await["kind"], "routine");
    // the connection leaves `active`: the history is still there and inside the era, so the only
    // reason for `unknown` is the connection (the era plays no part)
    for status in ["cleanup_pending", "disconnected"] {
        // `disconnected` is reachable only through the disconnect lifecycle (a trigger demands a
        // cleanup manifest); the fixture jumps there inside ONE transaction with user triggers off,
        // which touches nothing outside it
        let mut tx = w.su.begin().await.expect("begin");
        sqlx::query("SET LOCAL session_replication_role = replica")
            .execute(&mut *tx)
            .await
            .expect("this transaction only");
        sqlx::query(
            "UPDATE hosted_agent_connection SET status = $3 \
              WHERE workspace_id = $1 AND agent_member_id = $2",
        )
        .bind(w.workspace)
        .bind(agent.id)
        .bind(status)
        .execute(&mut *tx)
        .await
        .expect("leave active");
        tx.commit().await.expect("commit");
        let cadence = w.cadence(agent.id).await;
        assert_cadence_is_closed(&cadence);
        assert_eq!(
            cadence["kind"], "unknown",
            "a connection that is `{status}` promises nothing: {cadence}"
        );
    }
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_wire_is_closed_and_a_stranger_gets_the_same_404() {
    let w = world().await;
    let detail = w.real_detail().await;
    let agent = w.agent("closed").await;
    let now = whole_ms_now();
    w.put_calls(agent.id, &wakes(now, 4 * MIN, &REAL_15), &detail)
        .await;

    let member = w.member_view(agent.id).await;
    let mut keys: Vec<&str> = member
        .as_object()
        .expect("object")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert!(
        keys.iter()
            .all(|key| ["agentMemberId", "state", "lastSignalAtMs", "cadence"].contains(key)),
        "a member reads the label, when it last spoke, and the beat — nothing else: {member}"
    );
    let rendered = serde_json::to_string(&member).expect("render");
    for hidden in [
        "intervals",
        "lastToolError",
        "lastPing",
        "doorbell",
        "workWaiting",
    ] {
        assert!(
            !rendered.contains(hidden),
            "{hidden} must not reach a member: {rendered}"
        );
    }

    // a person who shares no channel with the agent: the same 404 as before, and no beat in it
    let (_outsider, outsider_jwt) = seed_human(&w.su, w.workspace, "member", "최민수").await;
    let response = w
        .client
        .get(format!(
            "{}/v1/workspaces/{}/agents/{}/liveness",
            w.base, w.workspace, agent.id
        ))
        .bearer_auth(&outsider_jwt)
        .send()
        .await
        .expect("outsider liveness");
    assert_eq!(response.status().as_u16(), 404);
    let body = response.text().await.expect("404 body");
    assert!(!body.contains("cadence"), "{body}");
}

/// Heap tuples this transaction has fetched from `audit_log` so far (index fetches + sequential
/// reads), from the transaction-local statistics: the work a statement did, whatever its plan.
async fn fetched(conn: &mut sqlx::PgConnection) -> i64 {
    sqlx::query_scalar(
        "SELECT COALESCE(sum(COALESCE(idx_tup_fetch, 0) + COALESCE(seq_tup_read, 0)), 0)::bigint \
           FROM pg_stat_xact_user_tables WHERE relname = 'audit_log'",
    )
    .fetch_one(&mut *conn)
    .await
    .expect("transaction-local table statistics")
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_new_connection_counts_only_its_own_calls() {
    let w = world().await;
    let detail = w.real_detail().await;
    let agent = w.agent("reborn").await;
    let now = whole_ms_now();
    // The connection the agent has now was created three hours ago. Before it, the agent made a
    // perfect 15-minute routine: that was another connection (a host that was disconnected).
    sqlx::query(
        "UPDATE hosted_agent_connection SET created_at = $3 \
          WHERE workspace_id = $1 AND agent_member_id = $2",
    )
    .bind(w.workspace)
    .bind(agent.id)
    .bind(now - Duration::hours(3))
    .execute(&w.su)
    .await
    .expect("date the connection");
    w.put_calls(agent.id, &wakes(now, 4 * 60 * MIN, &[15; 12]), &detail)
        .await;
    let cadence = w.cadence(agent.id).await;
    assert_eq!(
        cadence["kind"], "unknown",
        "the old connection's routine is not the new connection's: {cadence}"
    );
    // its own calls, since it was created, are what make its beat
    w.put_calls(agent.id, &wakes(now, 20 * MIN, &REAL_15), &detail)
        .await;
    let cadence = w.cadence(agent.id).await;
    assert_eq!(cadence["kind"], "routine", "{cadence}");
    assert_eq!(cadence["typicalMinutes"], 15, "{cadence}");
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_read_stops_at_its_limit_even_when_the_planner_expects_a_handful() {
    let w = world().await;
    let detail = w.real_detail().await;
    let agent = w.agent("hammer").await;
    let now = whole_ms_now();
    // a poller that made 6,000 admitted calls in the last 20 hours
    let calls: Vec<_> = (0..6000)
        .map(|k| now - Duration::seconds(20 * 60 * MIN - k * 12))
        .collect();
    w.put_calls(agent.id, &calls, &detail).await;
    let since = now - Duration::hours(24);

    // The table's statistics are shared with the other suites, so a leftover override from a run
    // that died half way is healed first, and NOTHING that can fail sits between the override and
    // its reset: the measurements are collected as plain values and judged after the reset.
    sqlx::query("ALTER TABLE audit_log ALTER COLUMN actor_member_id RESET (n_distinct)")
        .execute(&w.su)
        .await
        .expect("reset n_distinct");
    // Production's planner estimates one agent's rows from the average over very many actors and
    // expects a handful (15 rows per actor here, of which a few pass the other predicates);
    // say so, whatever this small database's own statistics would have said.
    sqlx::query("ALTER TABLE audit_log ALTER COLUMN actor_member_id SET (n_distinct = -0.0667)")
        .execute(&w.su)
        .await
        .expect("n_distinct");
    sqlx::query("ANALYZE audit_log")
        .execute(&w.su)
        .await
        .expect("analyze");

    let measured = async {
        // control: the same statement when the planner takes the plan that reads them all (an
        // ordered index scan switched off, so the bitmap scan - or a sequential one - is left)
        let mut tx = w.su.begin().await?;
        sqlx::query("SET LOCAL enable_indexscan = off")
            .execute(&mut *tx)
            .await?;
        let before = fetched(&mut tx).await;
        let rows = sqlx::query(momo_agent::CALL_TIMES_SQL)
            .bind(w.workspace)
            .bind(vec![agent.id])
            .bind(momo_agent::AGENT_PORT_CALL_ACTION)
            .bind(momo_agent::AGENT_PORT_CALL_PATH)
            .bind(since)
            .bind(50_i64)
            .fetch_all(&mut *tx)
            .await?;
        let control = fetched(&mut tx).await - before;
        tx.rollback().await?;

        // the loader reads about as many as it returns
        let mut tx = w.su.begin().await?;
        let before = fetched(&mut tx).await;
        let loaded =
            momo_agent::load_agent_call_times_in_tx(&mut tx, w.workspace, &[agent.id], since, 50)
                .await;
        let bounded = fetched(&mut tx).await - before;
        tx.rollback().await?;
        Ok::<_, sqlx::Error>((rows.len(), control, loaded, bounded))
    }
    .await;

    sqlx::query("ALTER TABLE audit_log ALTER COLUMN actor_member_id RESET (n_distinct)")
        .execute(&w.su)
        .await
        .expect("reset n_distinct");
    sqlx::query("ANALYZE audit_log")
        .execute(&w.su)
        .await
        .expect("analyze");

    let (control_rows, control, loaded, bounded) = measured.expect("the measurements");
    let loaded = loaded.expect("the savepoint machinery").expect("the read");
    eprintln!(
        "50 rows of a 6,000-row agent: the read-everything plan fetched {control} tuples, the loader {bounded}"
    );
    assert_eq!(control_rows, 50);
    assert_eq!(loaded[&agent.id].len(), 50);
    assert!(
        control >= 1000,
        "the control must show the problem or this test proves nothing: it fetched {control}"
    );
    assert!(
        bounded <= 150,
        "50 rows returned must not cost {bounded} fetched tuples (control: {control})"
    );
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_beat_read_that_cannot_finish_leaves_the_liveness_routes_answering() {
    let w = world().await;
    let detail = w.real_detail().await;
    let agent = w.agent("blocked").await;
    let now = whole_ms_now();
    w.put_calls(agent.id, &wakes(now, 4 * MIN, &REAL_15), &detail)
        .await;
    assert_eq!(w.cadence(agent.id).await["kind"], "routine");

    // another session holds the table: the beat read waits, is cancelled at its 2-second
    // ceiling, and the route still answers - with everything but the beat
    let su = w.su.clone();
    let holder = tokio::spawn(async move {
        let mut tx = su.begin().await.expect("begin");
        sqlx::query("LOCK TABLE audit_log IN ACCESS EXCLUSIVE MODE")
            .execute(&mut *tx)
            .await
            .expect("lock");
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        tx.rollback().await.expect("release");
    });
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let member = w.member_view(agent.id).await; // asserts 200
    holder.await.expect("the lock holder");
    assert_eq!(member["cadence"]["kind"], "unknown", "{member}");
    assert!(
        member["state"].is_string(),
        "the rest of the answer is there: {member}"
    );
    // nothing is left behind: the same read, once the table is free, is a routine again
    assert_eq!(w.cadence(agent.id).await["kind"], "routine");
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_limit_is_per_agent_not_for_the_whole_read() {
    let w = world().await;
    let detail = w.real_detail().await;
    let a = w.agent("limit-a").await;
    let b = w.agent("limit-b").await;
    let now = whole_ms_now();
    let at = |minutes: i64| now - Duration::minutes(minutes);
    w.put_calls(a.id, &[at(10), at(20), at(30), at(40)], &detail)
        .await;
    w.put_calls(b.id, &[at(11), at(21), at(31), at(41)], &detail)
        .await;
    let loaded = load(&w, &[a.id, b.id], now - Duration::hours(1), 2).await;
    assert_eq!(loaded[&a.id], vec![at(10), at(20)]);
    assert_eq!(loaded[&b.id], vec![at(11), at(21)]);
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn an_agent_with_a_new_connection_does_not_cost_its_old_rows() {
    let w = world().await;
    let detail = w.real_detail().await;
    let agent = w.agent("reborn-heavy").await;
    let now = whole_ms_now();
    // The connection is an hour old. Before it, the agent made 6,000 calls (a polling host that was
    // disconnected and registered again); since it, ten. The era bound must stop the ordered scan
    // at the connection, not read the 6,000 only to throw them away.
    sqlx::query(
        "UPDATE hosted_agent_connection SET created_at = $3 \
          WHERE workspace_id = $1 AND agent_member_id = $2",
    )
    .bind(w.workspace)
    .bind(agent.id)
    .bind(now - Duration::hours(1))
    .execute(&w.su)
    .await
    .expect("date the connection");
    let before_era: Vec<_> = (0..6000)
        .map(|k| now - Duration::seconds(23 * 60 * MIN - k * 10))
        .collect();
    let since_era: Vec<_> = (0..10)
        .map(|k| now - Duration::minutes(50 - k * 5))
        .collect();
    w.put_calls(agent.id, &before_era, &detail).await;
    w.put_calls(agent.id, &since_era, &detail).await;

    let mut tx = w.su.begin().await.expect("begin");
    let before = fetched(&mut tx).await;
    let loaded = momo_agent::load_agent_call_times_in_tx(
        &mut tx,
        w.workspace,
        &[agent.id],
        now - Duration::hours(24),
        2000,
    )
    .await
    .expect("the savepoint machinery")
    .expect("the read");
    let cost = fetched(&mut tx).await - before;
    tx.rollback().await.expect("rollback");

    assert_eq!(
        loaded[&agent.id].len(),
        10,
        "only the connection's own calls"
    );
    assert!(
        cost <= 100,
        "ten calls in the era must not cost {cost} fetched tuples: the era bound is a filter, not an index condition"
    );
}
