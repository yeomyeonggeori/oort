//! #4618 / ADR-0200 증보 4 — Agent Port 호출 기록(`agent_port.call` 감사 행).
//!
//! 서버는 **인증을 통과한 Agent Port POST마다** 답이 정해진 뒤에 감사 행 한 줄을 남긴다:
//! JSON-RPC method, `tools/call`의 도구 이름, 결과 토큰, HTTP 상태, JSON-RPC 코드, 호출자가 말한
//! 프로토콜 era, 서버가 센 숫자 셋(`tools/list`가 보여 준 도구 수 · inbox 이벤트/`agent_job` 수 · 가져간 job 수). 실제 Axum 라우터를 `momo_app`(NOBYPASSRLS)
//! 풀 위에 띄우고 HTTP로만 확인한다.
//!
//! | 시험 | 증명 | 빨개지면 |
//! |---|---|---|
//! | `every_kind_of_call_leaves_one_exact_row` | 성공·-32602(인자 형식·모르는 인자·모르는 도구)·409·-32700(깨진 JSON)·-32600(배열·중복 헤더·64KiB 초과·Accept 누락 415)·-32022·-32020(Mcp-Method·Mcp-Name·프로토콜 헤더 누락)·-32601·legacy initialize·202가 각각 정확히 한 행이고 거절마다 `reason` 토큰이 붙으며 키 집합이 고정 | 결과 매핑·method/tool 분류·전송 거절 경로의 기록 중 하나가 빠짐 |
//! | `the_counts_tell_a_wake_that_saw_the_job_from_one_that_did_not` | 같은 도구가 성공이어도 `oort_inbox_read`는 받은 이벤트 수·`agent_job` 수, `oort_job_start`는 가져간 job 수(0/1)가 행에 남아, 「읽고 job을 봤는데 안 가져감」과 「읽었는데 job이 안 보임」과 「inbox가 빈 뒤 job_start가 가져감」을 가른다. id·핸들·커서·본문은 행 어디에도 없다 | 개수가 빠지거나 틀리거나 값이 새어 들어감 |
//! | `a_tool_outside_the_view_is_named_and_the_list_says_how_many_were_offered` | 도구 범위가 모자란 연결: `tools/list`는 제공 수(`tools_listed`), 못 쓰는 도구 호출은 도구 이름 + invalid_arguments | 「목록이 비었나 일부인가」를 가리는 숫자가 사라짐 |
//! | `a_call_that_was_not_admitted_leaves_no_row` | 위조·형식 오류 bearer(401)와 범위 없는 bearer(403)에는 이 행이 없다 | 인증 앞에서 기록하거나 신원 없는 호출을 귀속 |
//! | `the_trace_holds_nothing_the_caller_sent` | 호출자가 보낸 표지 문자열(도구 이름·커서·인자·method·헤더)이 감사 로그 어디에도 없다 | 값이 한 글자라도 새어 들어감 |
//! | `the_trace_stops_at_its_hourly_cap_and_the_answers_do_not_change` | 한 자격당 시간당 240행에서 멈추고 응답은 그대로, 다른 자격은 독립 | 상한이 없어져 감사 표가 무한히 자람 |
//! | `a_failing_trace_write_never_changes_the_answer` | 기록 INSERT가 실패해도 도구 응답 200이고 다른 감사 행은 계속 쓰인다 | 기록 실패가 응답으로 번짐 |
//! | `a_trace_write_that_outlasts_its_ceiling_is_abandoned_and_the_answer_is_unchanged` | 2초를 넘기는 기록은 포기된다: 응답 같음·행 없음·응답이 느린 쓰기(4초)를 기다리지 않음·취소된 tx가 풀을 망가뜨리지 않아 다음 호출은 기록됨 (거절 트리거 시험이 못 닿는 `timeout`의 `Err(_)` 경로) | 한도가 사라지거나 늘어나 느린 DB가 응답을 붙잡음 |
//! | `a_call_the_admission_limiter_refused_leaves_no_trace_row` | 입장 제한이 거절한 429에는 이 행이 없고(거절은 기존 `rate_limit.denied`가 맡음) 통과한 호출만 기록 | 신원 없이 거절된 호출에 행이 붙음 |
//!
//! 그리고 위 시험 가운데 셋(`every_kind_of_call_leaves_one_exact_row` · `the_counts_tell_…` · `the_trace_stops_at_its_hourly_cap_…`)은 끝에서 **모든 행**의 열(토큰·대상·run 비어 있음, actor = subject, `route`)과 `detail` 키(닫힌 집합)를 확인한다(첫 행만 보던 검사의 빈틈, 검수 R1-05).
//!
//! 격리 DB에서만:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:<port>/momo \
//!   cargo test -p momo-server --test agent_port_call_trace_pg -- --ignored --test-threads=1
//! ```

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

/// `CALL_TRACE_PER_HOUR` in `routes/agent_port.rs`, restated: a change there is a red test here.
const CAP: usize = 240;
const SCHEMA: &str = "oort.agent_port.call.v1";

/// `actor, subject, via_token, target_type, target_id, run_id` of one audit row.
type RowColumns = (
    Option<Uuid>,
    Option<Uuid>,
    Option<Uuid>,
    Option<String>,
    Option<Uuid>,
    Option<Uuid>,
);

struct World {
    su: PgPool,
    base: String,
    workspace: Uuid,
    owner: Uuid,
    owner_jwt: String,
    public: Uuid,
    agent: SeededAgent,
}

async fn world() -> World {
    world_with(ServerOptions::hosted_open()).await
}

async fn world_with(options: ServerOptions) -> World {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let base = start_server(app, options).await;
    let workspace = seed_workspace(&su).await;
    let (owner, owner_jwt) = seed_human(&su, workspace, "member", "박서연").await;
    let public = seed_channel(&su, workspace, "public", &[owner]).await;
    let agent = seed_hosted_agent(&su, workspace, owner, "trace", &[public], true, false).await;
    join_channel(&su, workspace, public, agent.id).await;
    World {
        su,
        base,
        workspace,
        owner,
        owner_jwt,
        public,
        agent,
    }
}

impl World {
    fn wire(&self) -> Wire {
        Wire::new(&self.base, self.agent.bearer.as_deref().expect("bearer"))
    }

    async fn count(&self, action: &str) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE workspace_id = $1 AND action = $2")
            .bind(self.workspace)
            .bind(action)
            .fetch_one(&self.su)
            .await
            .expect("count")
    }

    async fn rows(&self) -> Vec<Value> {
        trace_rows(&self.su, self.workspace, self.agent.id).await
    }

    /// The owner mentions the agent in the public channel; returns the message id.
    async fn ask(&self, body: &str) -> Uuid {
        self.say(&format!("@{} {body}", self.agent.handle)).await
    }

    /// The owner says something to the room (no mention: a `message` event, no job).
    async fn say(&self, body: &str) -> Uuid {
        let response = reqwest::Client::new()
            .post(format!(
                "{}/v1/workspaces/{}/channels/{}/messages",
                self.base, self.workspace, self.public
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
}

fn row(
    method: &str,
    tool: Option<&str>,
    outcome: &str,
    status: u16,
    rpc: Option<i64>,
    era: &str,
    listed: Option<usize>,
) -> Value {
    let mut expected = json!({
        "schema": SCHEMA, "method": method, "outcome": outcome, "status": status, "era": era
    });
    if let Some(tool) = tool {
        expected["tool"] = json!(tool);
    }
    if let Some(rpc) = rpc {
        expected["rpc_code"] = json!(rpc);
    }
    if let Some(listed) = listed {
        expected["tools_listed"] = json!(listed);
    }
    expected
}

/// A success row of a tool that counts: `events` / `agent_jobs` / `jobs` as the server computed them.
fn counted(tool: &str, events: Option<u32>, agent_jobs: Option<u32>, jobs: Option<u32>) -> Value {
    let mut expected = row("tools/call", Some(tool), "ok", 200, None, "modern", None);
    for (key, value) in [
        ("events", events),
        ("agent_jobs", agent_jobs),
        ("jobs", jobs),
    ] {
        if let Some(value) = value {
            expected[key] = json!(value);
        }
    }
    expected
}

/// The closed `reason` token a refusal row carries (`momo_mcp::REFUSAL_REASONS`).
fn why(mut row: Value, reason: &str) -> Value {
    row["reason"] = json!(reason);
    row
}

const MODERN_HEADERS: [(&str, &str); 2] = [
    ("mcp-protocol-version", MODERN),
    ("mcp-method", "tools/call"),
];

/// Every trace row of the workspace — **all** of them, not the first one found — has the columns the
/// ADR promises (a route row of the agent, naming no token, target or run) and only the closed `detail`
/// key set. A path that stamps one extra column on just one kind of call is caught here and nowhere else.
async fn assert_every_row_is_plain(su: &PgPool, workspace: Uuid) {
    let total: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE workspace_id = $1 AND action = 'agent_port.call'",
    )
    .bind(workspace)
    .fetch_one(su)
    .await
    .expect("count trace rows");
    assert!(
        total > 0,
        "nothing to check: the helper would pass vacuously"
    );
    let off_shape: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log \
          WHERE workspace_id = $1 AND action = 'agent_port.call' \
            AND (via_token_id IS NOT NULL OR target_id IS NOT NULL OR run_id IS NOT NULL \
                 OR target_type IS DISTINCT FROM 'route' \
                 OR actor_member_id IS NULL OR actor_member_id IS DISTINCT FROM subject_member_id)",
    )
    .bind(workspace)
    .fetch_one(su)
    .await
    .expect("count off-shape trace rows");
    assert_eq!(
        off_shape, 0,
        "{off_shape} of {total} trace rows carry a token, target or run, or a different actor and subject"
    );
    let stray_keys: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT k FROM audit_log a, LATERAL jsonb_object_keys(a.detail) k \
          WHERE a.workspace_id = $1 AND a.action = 'agent_port.call' \
            AND k <> ALL($2::text[])",
    )
    .bind(workspace)
    .bind(
        [
            "schema",
            "method",
            "tool",
            "outcome",
            "reason",
            "status",
            "rpc_code",
            "era",
            "tools_listed",
            "events",
            "agent_jobs",
            "jobs",
        ]
        .map(str::to_string)
        .to_vec(),
    )
    .fetch_all(su)
    .await
    .expect("read trace keys");
    assert!(
        stray_keys.is_empty(),
        "a key outside the closed set reached a trace row: {stray_keys:?}"
    );
}

fn tool_count(reply: &Reply) -> usize {
    reply.body["result"]["tools"].as_array().map_or(0, Vec::len)
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn every_kind_of_call_leaves_one_exact_row() {
    let w = world().await;
    let wire = w.wire();
    let mut expected: Vec<Value> = Vec::new();

    // 1. A success.
    assert!(wire.ping().await.is_ok());
    expected.push(row(
        "tools/call",
        Some("oort_ping"),
        "ok",
        200,
        None,
        "modern",
        None,
    ));

    // 2. The routine's once-per-wake `tools/list`: the row carries how many tools were offered.
    let listing = wire.list().await;
    assert!(listing.is_ok(), "{listing:?}");
    let offered = tool_count(&listing);
    assert!(offered > 0, "a full-scope connection is offered tools");
    expected.push(row(
        "tools/list",
        None,
        "ok",
        200,
        None,
        "modern",
        Some(offered),
    ));

    // 3. `oort_inbox_read` with a cursor of the wrong type — a refusal that leaves nothing in
    //    liveness, the run ledger or (before this row) anywhere but a log line.
    let bad_type = wire.tool("oort_inbox_read", json!({"cursor": 5})).await;
    assert_eq!((bad_type.status, bad_type.rpc_code()), (400, Some(-32602)));
    expected.push(why(
        row(
            "tools/call",
            Some("oort_inbox_read"),
            "invalid_arguments",
            400,
            Some(-32602),
            "modern",
            None,
        ),
        "tool_arguments",
    ));

    // 4. An argument the schema does not list.
    let extra = wire
        .tool("oort_inbox_read", json!({"limit": 1, "surprise": true}))
        .await;
    assert_eq!((extra.status, extra.rpc_code()), (400, Some(-32602)));
    expected.push(why(
        row(
            "tools/call",
            Some("oort_inbox_read"),
            "invalid_arguments",
            400,
            Some(-32602),
            "modern",
            None,
        ),
        "tool_arguments",
    ));

    // 5. A cursor the server cannot open: the 「Unavailable」 a stale saved cursor gets.
    let stale = wire
        .inbox(Some("momo_inbox_cursor_v1.not-a-real-cursor"))
        .await;
    assert_eq!((stale.status, stale.rpc_code()), (409, Some(-32004)));
    expected.push(why(
        row(
            "tools/call",
            Some("oort_inbox_read"),
            "unavailable",
            409,
            Some(-32004),
            "modern",
            None,
        ),
        "tool_unavailable",
    ));

    // 6. A tool that is not in the catalog at all.
    let unknown = wire.tool("oort_nonexistent", json!({})).await;
    assert_eq!((unknown.status, unknown.rpc_code()), (400, Some(-32602)));
    expected.push(why(
        row(
            "tools/call",
            Some("unknown"),
            "invalid_arguments",
            400,
            Some(-32602),
            "modern",
            None,
        ),
        "unknown_tool",
    ));

    // 7. A body that is not JSON: a cursor with a raw newline in it, as a shell that builds the
    //    JSON by string interpolation sends it.
    let broken = wire
        .raw(
            b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"oort_inbox_read\",\"arguments\":{\"cursor\":\"abc\ndef\"}}}",
            &[
                ("mcp-protocol-version", MODERN),
                ("mcp-method", "tools/call"),
                ("mcp-name", "oort_inbox_read"),
            ],
        )
        .await;
    assert_eq!((broken.status, broken.rpc_code()), (400, Some(-32700)));
    expected.push(why(
        row(
            "unparsed",
            None,
            "protocol_error",
            400,
            Some(-32700),
            "modern",
            None,
        ),
        "parse_error",
    ));

    // 8. A JSON-RPC batch (an array) instead of one request.
    let batch = wire
        .raw(
            b"[{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}]",
            &MODERN_HEADERS,
        )
        .await;
    assert_eq!((batch.status, batch.rpc_code()), (400, Some(-32600)));
    expected.push(why(
        row(
            "no_method",
            None,
            "protocol_error",
            400,
            Some(-32600),
            "modern",
            None,
        ),
        "request_shape",
    ));

    // 9. A client that proposes a protocol version this server does not speak.
    let version = wire
        .raw(
            br#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"trace-test","version":"1"}}}"#,
            &[("mcp-protocol-version", "2025-06-18")],
        )
        .await;
    assert_eq!((version.status, version.rpc_code()), (400, Some(-32022)));
    expected.push(why(
        row(
            "initialize",
            None,
            "protocol_error",
            400,
            Some(-32022),
            "other",
            None,
        ),
        "version_unsupported",
    ));

    // 10. A modern call whose `Mcp-Method` header disagrees with its body.
    let mismatch = wire
        .raw(
            &serde_json::to_vec(&json!({
                "jsonrpc": "2.0", "id": 1, "method": "tools/list",
                "params": {"_meta": {
                    "io.modelcontextprotocol/protocolVersion": MODERN,
                    "io.modelcontextprotocol/clientCapabilities": {}}}
            }))
            .unwrap(),
            &MODERN_HEADERS,
        )
        .await;
    assert_eq!((mismatch.status, mismatch.rpc_code()), (400, Some(-32020)));
    expected.push(why(
        row(
            "tools/list",
            None,
            "protocol_error",
            400,
            Some(-32020),
            "modern",
            None,
        ),
        "mcp_method_header",
    ));

    // 11. A method this server does not have (legacy era).
    let resources = wire
        .raw(
            br#"{"jsonrpc":"2.0","id":1,"method":"resources/list"}"#,
            &[("mcp-protocol-version", LEGACY)],
        )
        .await;
    assert_eq!(
        (resources.status, resources.rpc_code()),
        (400, Some(-32601))
    );
    expected.push(why(
        row(
            "other",
            None,
            "protocol_error",
            400,
            Some(-32601),
            "legacy",
            None,
        ),
        "method_not_found",
    ));

    // 12. A legacy handshake: `initialize`, then the `202` for `notifications/initialized`.
    let init = wire
        .raw(
            br#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"trace-test","version":"1"}}}"#,
            &[("mcp-protocol-version", LEGACY)],
        )
        .await;
    assert!(init.is_ok(), "{init:?}");
    expected.push(row("initialize", None, "ok", 200, None, "legacy", None));
    let initialized = wire
        .raw(
            br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            &[("mcp-protocol-version", LEGACY)],
        )
        .await;
    assert_eq!(initialized.status, 202);
    expected.push(row(
        "notifications/initialized",
        None,
        "ok",
        202,
        None,
        "legacy",
        None,
    ));

    // 13. A transport refusal: `Content-Type` named twice. Decided before the body is read,
    //     answered after authentication — and still a row.
    let duplicate = wire
        .raw(
            &serde_json::to_vec(&json!({
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": {"_meta": {
                    "io.modelcontextprotocol/protocolVersion": MODERN,
                    "io.modelcontextprotocol/clientCapabilities": {}},
                    "name": "oort_ping", "arguments": {}}
            }))
            .unwrap(),
            &[
                ("content-type", "application/json"),
                ("content-type", "application/json"),
                ("mcp-protocol-version", MODERN),
                ("mcp-method", "tools/call"),
                ("mcp-name", "oort_ping"),
            ],
        )
        .await;
    assert_eq!(
        (duplicate.status, duplicate.rpc_code()),
        (400, Some(-32600))
    );
    expected.push(why(
        row(
            "tools/call",
            Some("oort_ping"),
            "protocol_error",
            400,
            Some(-32600),
            "modern",
            None,
        ),
        "transport_headers",
    ));

    // 14. A body over the 64 KiB ceiling.
    let huge = wire.raw(&vec![b' '; 64 * 1024 + 16], &MODERN_HEADERS).await;
    assert_eq!((huge.status, huge.rpc_code()), (413, Some(-32600)));
    expected.push(why(
        row(
            "unparsed",
            None,
            "protocol_error",
            413,
            Some(-32600),
            "modern",
            None,
        ),
        "body_too_large",
    ));

    // 15-17: the three request-building mistakes a hand-written `curl` makes most. Each is a
    // refusal the server neither logs nor records anywhere else; each is told apart here.
    let ping_body = serde_json::to_vec(&json!({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"_meta": {
            "io.modelcontextprotocol/protocolVersion": MODERN,
            "io.modelcontextprotocol/clientCapabilities": {}},
            "name": "oort_ping", "arguments": {}}
    }))
    .unwrap();

    // 15. `Accept` without the event stream.
    let accept = wire
        .raw(
            &ping_body,
            &[
                ("accept", "application/json"),
                ("mcp-protocol-version", MODERN),
                ("mcp-method", "tools/call"),
                ("mcp-name", "oort_ping"),
            ],
        )
        .await;
    assert_eq!((accept.status, accept.rpc_code()), (415, Some(-32600)));
    expected.push(why(
        row(
            "tools/call",
            Some("oort_ping"),
            "protocol_error",
            415,
            Some(-32600),
            "modern",
            None,
        ),
        "accept",
    ));

    // 16. Modern `_meta` and no `MCP-Protocol-Version` header at all.
    let no_header = wire
        .raw(
            &ping_body,
            &[("mcp-method", "tools/call"), ("mcp-name", "oort_ping")],
        )
        .await;
    assert_eq!(
        (no_header.status, no_header.rpc_code()),
        (400, Some(-32020))
    );
    expected.push(why(
        row(
            "tools/call",
            Some("oort_ping"),
            "protocol_error",
            400,
            Some(-32020),
            "none",
            None,
        ),
        "version_header",
    ));

    // 17. `Mcp-Name` still names the previous call's tool (one `curl` reused for the next call).
    let stale_name = wire
        .raw(
            &ping_body,
            &[
                ("mcp-protocol-version", MODERN),
                ("mcp-method", "tools/call"),
                ("mcp-name", "oort_inbox_read"),
            ],
        )
        .await;
    assert_eq!(
        (stale_name.status, stale_name.rpc_code()),
        (400, Some(-32020))
    );
    expected.push(why(
        row(
            "tools/call",
            Some("oort_ping"),
            "protocol_error",
            400,
            Some(-32020),
            "modern",
            None,
        ),
        "mcp_name_header",
    ));

    // One row per call, in order, each exactly the closed shape — no other key.
    let rows = w.rows().await;
    assert_eq!(rows.len(), expected.len(), "{rows:#?}");
    for (index, (got, want)) in rows.iter().zip(&expected).enumerate() {
        assert_eq!(got, want, "call #{}", index + 1);
    }

    // The row is the agent's, a route row, and it names no token, target or run.
    let (actor, subject, via_token, target_type, target_id, run_id): RowColumns = sqlx::query_as(
        "SELECT actor_member_id, subject_member_id, via_token_id, target_type, target_id, run_id \
           FROM audit_log WHERE workspace_id = $1 AND action = 'agent_port.call' LIMIT 1",
    )
    .bind(w.workspace)
    .fetch_one(&w.su)
    .await
    .expect("one trace row");
    assert_eq!(actor, Some(w.agent.id));
    assert_eq!(subject, Some(w.agent.id));
    assert_eq!(
        via_token, None,
        "no token id: a pairing credential's id is not a token row"
    );
    assert_eq!(target_type.as_deref(), Some("route"));
    assert_eq!((target_id, run_id), (None, None));
    // … and that holds for every row, whatever kind of call left it.
    assert_every_row_is_plain(&w.su, w.workspace).await;
    // And the pre-dispatch row is still written, once per admitted call.
    assert_eq!(
        w.count("auth.agent_bearer.used").await,
        i64::try_from(expected.len()).unwrap(),
        "the used row is untouched"
    );
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_counts_tell_a_wake_that_saw_the_job_from_one_that_did_not() {
    let w = world().await;
    let wire = w.wire();

    // Wake 1: nothing to do. The page is empty and `oort_job_start {}` hands nothing over.
    assert!(wire.ping().await.is_ok());
    let quiet = wire.inbox(None).await;
    assert!(quiet.is_ok(), "{quiet:?}");
    let cursor = next_cursor(&quiet);
    let nothing = wire.job_start().await;
    assert!(nothing.is_ok() && nothing.structured()["job"].is_null());

    // The room talks (two plain messages — events with no job), then a person asks. Wake 2 reads the
    // page, SEES the tracked turn among the chatter — and goes away without claiming it (the saved
    // cursor has now moved past the event). Two plain messages around ONE tracked turn on purpose:
    // counting `message` events instead of `agent_job` ones would give 3 or 2, never 1.
    w.say("점심 뭐 먹을까요").await;
    w.ask("분기 보고서 초안 부탁해요").await;
    w.say("저는 국밥이요").await;
    assert!(wire.ping().await.is_ok());
    let saw = wire.inbox(Some(&cursor)).await;
    assert!(saw.is_ok(), "{saw:?}");
    assert_eq!(
        events(&saw).len(),
        4,
        "three messages and the tracked turn: {:?}",
        saw.body
    );
    let cursor = next_cursor(&saw);

    // Wake 3: the page is now empty (the cursor moved on) — the job is still there, and the
    // routine's step 5 (`oort_job_start {}` even on an empty page) takes it.
    assert!(wire.ping().await.is_ok());
    let empty = wire.inbox(Some(&cursor)).await;
    assert!(empty.is_ok() && events(&empty).is_empty(), "{empty:?}");
    let taken = wire.job_start().await;
    assert!(taken.is_ok(), "{taken:?}");
    let handle = taken.structured()["job"]["leaseHandle"]
        .as_str()
        .expect("the stranded turn is handed over")
        .to_string();
    assert!(wire.run_complete(&handle, "초안 올렸어요").await.is_ok());

    // The trace of those three wakes, one row per call, with the numbers that separate the
    // stories: wake 2 read four events of which ONE is a tracked turn and made no claim;
    // wake 3 read none and still took one.
    let ping = row(
        "tools/call",
        Some("oort_ping"),
        "ok",
        200,
        None,
        "modern",
        None,
    );
    let expected = vec![
        ping.clone(),
        counted("oort_inbox_read", Some(0), Some(0), None),
        counted("oort_job_start", None, None, Some(0)),
        ping.clone(),
        counted("oort_inbox_read", Some(4), Some(1), None),
        ping.clone(),
        counted("oort_inbox_read", Some(0), Some(0), None),
        counted("oort_job_start", None, None, Some(1)),
        row(
            "tools/call",
            Some("oort_run_complete"),
            "ok",
            200,
            None,
            "modern",
            None,
        ),
    ];
    let rows = w.rows().await;
    assert_eq!(rows.len(), expected.len(), "{rows:#?}");
    for (index, (got, want)) in rows.iter().zip(&expected).enumerate() {
        assert_eq!(got, want, "call #{}", index + 1);
    }

    // Counts are numbers and only numbers: nothing the answers carried (ids, the cursor, the
    // lease handle, the request text) is in any audit row of this workspace.
    for secret in [
        cursor.as_str(),
        handle.as_str(),
        "분기 보고서 초안",
        "초안 올렸어요",
    ] {
        let leaked: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM audit_log WHERE workspace_id = $1 AND position($2 in detail::text) > 0",
        )
        .bind(w.workspace)
        .bind(secret)
        .fetch_one(&w.su)
        .await
        .expect("scan");
        assert_eq!(leaked, 0, "{secret:?} must not be in the audit log");
    }
    for key in [
        "messageId",
        "channelId",
        "leaseHandle",
        "nextCursor",
        "runId",
    ] {
        let leaked: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM audit_log WHERE workspace_id = $1 AND action = 'agent_port.call' \
               AND position($2 in detail::text) > 0",
        )
        .bind(w.workspace)
        .bind(key)
        .fetch_one(&w.su)
        .await
        .expect("scan keys");
        assert_eq!(leaked, 0, "no `{key}` key in a call trace");
    }
    assert_every_row_is_plain(&w.su, w.workspace).await;
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_tool_outside_the_view_is_named_and_the_list_says_how_many_were_offered() {
    let w = world().await;
    let full = w.wire();
    let full_list = full.list().await;
    let full_count = tool_count(&full_list);

    // The same kind of agent, but its connection (and token) lack `agent:jobs:read`: the four
    // job tools are neither listed nor callable.
    let narrow = seed_hosted_agent(
        &w.su,
        w.workspace,
        w.owner,
        "narrow",
        &[w.public],
        true,
        false,
    )
    .await;
    for sql in [
        "UPDATE hosted_agent_connection SET approved_scopes = array_remove(approved_scopes, 'agent:jobs:read') \
          WHERE workspace_id = $1 AND agent_member_id = $2",
        "UPDATE token SET scopes = array_remove(scopes, 'agent:jobs:read') \
          WHERE workspace_id = $1 AND actor_member_id = $2 AND kind = 'agent_bearer'",
    ] {
        sqlx::query(sql)
            .bind(w.workspace)
            .bind(narrow.id)
            .execute(&w.su)
            .await
            .expect("narrow the scopes");
    }
    let wire = full.with_bearer(narrow.bearer.as_deref().expect("bearer"));
    let list = wire.list().await;
    assert!(list.is_ok(), "{list:?}");
    let offered = tool_count(&list);
    assert_eq!(
        offered,
        full_count - 4,
        "jobs_claim, job_start, job_renew, job_release are gone"
    );

    // Asking for one of them is the same 「unknown tool」 on the wire; the audit row says which
    // tool it was and that the caller was not given it.
    let claim = wire.tool("oort_jobs_claim", json!({})).await;
    assert_eq!((claim.status, claim.rpc_code()), (400, Some(-32602)));

    let rows = trace_rows(&w.su, w.workspace, narrow.id).await;
    assert_eq!(
        rows,
        vec![
            row("tools/list", None, "ok", 200, None, "modern", Some(offered)),
            why(
                row(
                    "tools/call",
                    Some("oort_jobs_claim"),
                    "invalid_arguments",
                    400,
                    Some(-32602),
                    "modern",
                    None
                ),
                "unknown_tool"
            ),
        ]
    );
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_call_that_was_not_admitted_leaves_no_row() {
    let w = world().await;
    let wire = w.wire();
    assert!(wire.ping().await.is_ok());
    assert_eq!(w.rows().await.len(), 1);

    // A forged envelope for this workspace, and a string that is no envelope at all: 401.
    let forged = format!("momo_agent_v1.{}.{}", w.workspace, "x".repeat(60));
    for bearer in [forged.as_str(), "not-a-credential"] {
        let reply = wire.with_bearer(bearer).ping().await;
        assert_eq!(reply.status, 401, "{reply:?}");
    }

    // A real agent bearer that lacks the connect scope: 403, and its own audit row — not this one.
    let generic = seed_generic_agent_bearer(&w.su, w.workspace, w.agent.id).await;
    let denied = wire.with_bearer(&generic).ping().await;
    assert_eq!(denied.status, 403, "{denied:?}");
    assert_eq!(w.count("auth.agent_bearer.scope_denied").await, 1);

    assert_eq!(
        w.count("agent_port.call").await,
        1,
        "only the admitted call left a trace row"
    );
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_trace_holds_nothing_the_caller_sent() {
    let w = world().await;
    let wire = w.wire();
    let marker = "MARKER_4618_CALLER_TEXT";

    // The marker rides in every place a caller controls: a tool name, an argument value, a
    // cursor, a method, a protocol-version header, a header the server never reads.
    wire.tool(&format!("oort_{marker}"), json!({"x": marker}))
        .await;
    wire.tool("oort_inbox_read", json!({"cursor": marker}))
        .await;
    wire.tool("oort_inbox_read", json!({"limit": 1, marker: marker}))
        .await;
    wire.raw(
        format!(r#"{{"jsonrpc":"2.0","id":"{marker}","method":"{marker}/list"}}"#).as_bytes(),
        &[("mcp-protocol-version", LEGACY), ("x-marker", marker)],
    )
    .await;
    wire.raw(
        format!(r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"protocolVersion":"{marker}"}}}}"#)
            .as_bytes(),
        &[("mcp-protocol-version", marker)],
    )
    .await;
    wire.raw(
        format!("{{\"{marker}\": \"line\nbreak\"").as_bytes(),
        &MODERN_HEADERS,
    )
    .await;

    let rows = w.rows().await;
    assert_eq!(rows.len(), 6, "one row per call: {rows:#?}");
    let needle = format!("%{}%", marker.to_lowercase());
    let leaked: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log \
          WHERE workspace_id = $1 \
            AND (lower(detail::text) LIKE $2 OR lower(action) LIKE $2 \
                 OR lower(COALESCE(target_type, '')) LIKE $2)",
    )
    .bind(w.workspace)
    .bind(&needle)
    .fetch_one(&w.su)
    .await
    .expect("scan the audit log");
    assert_eq!(leaked, 0, "no caller-chosen text reaches the audit log");
    // The closed vocabulary is what it is, row by row.
    let methods: Vec<&str> = rows.iter().map(|r| r["method"].as_str().unwrap()).collect();
    assert_eq!(
        methods,
        vec![
            "tools/call",
            "tools/call",
            "tools/call",
            "other",
            "initialize",
            "unparsed"
        ]
    );
    assert_eq!(rows[0]["tool"], "unknown");
    assert_eq!(rows[4]["era"], "other");
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn the_trace_stops_at_its_hourly_cap_and_the_answers_do_not_change() {
    let w = world().await;
    let wire = w.wire();
    for index in 0..CAP + 5 {
        let reply = wire.ping().await;
        assert!(
            reply.is_ok(),
            "call #{index} is answered normally: {reply:?}"
        );
    }
    let rows = w.rows().await;
    assert_eq!(
        rows.len(),
        CAP,
        "the trace stops at the cap, it does not rotate"
    );
    assert_eq!(
        w.count("auth.agent_bearer.used").await,
        i64::try_from(CAP + 5).unwrap(),
        "the cap limits the trace, not the calls or the pre-dispatch audit"
    );

    // The cap is per credential: another agent's first call is still recorded.
    let other = seed_hosted_agent(
        &w.su,
        w.workspace,
        w.owner,
        "other",
        &[w.public],
        true,
        false,
    )
    .await;
    let other_wire = wire.with_bearer(other.bearer.as_deref().expect("bearer"));
    assert!(other_wire.ping().await.is_ok());
    assert_eq!(trace_rows(&w.su, w.workspace, other.id).await.len(), 1);
    assert_every_row_is_plain(&w.su, w.workspace).await;
}

/// The admission limiter's own `429` leaves no trace row: it is answered before any identity is
/// resolved, so there is nobody to attribute a row to. The refusal is recorded where it always was
/// (`agent_port.rate_limit.denied`), and the calls that were admitted are traced as usual.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_call_the_admission_limiter_refused_leaves_no_trace_row() {
    // Two calls per window per credential; the third inside the same 60 s is a 429.
    let w = world_with(ServerOptions::hosted_open().with_agent_port_limits(2, 0)).await;
    let wire = w.wire();
    assert!(wire.ping().await.is_ok());
    assert!(wire.ping().await.is_ok());
    let refused = wire.ping().await;
    assert_eq!(
        refused.status, 429,
        "the third call is over the limit: {refused:?}"
    );
    assert_eq!(
        w.count("agent_port.call").await,
        2,
        "only the two admitted calls are traced"
    );
    assert_eq!(
        w.count("agent_port.rate_limit.denied").await,
        1,
        "the refusal is recorded where it always was"
    );
    assert_eq!(
        w.count("auth.agent_bearer.used").await,
        2,
        "a refused call writes no used row either"
    );
    assert_every_row_is_plain(&w.su, w.workspace).await;
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_failing_trace_write_never_changes_the_answer() {
    let w = world().await;
    let wire = w.wire();
    let cleanup = |su: PgPool| async move {
        sqlx::query("DROP TRIGGER IF EXISTS test_4618_refuse_call_trace ON audit_log")
            .execute(&su)
            .await
            .expect("drop trigger");
        sqlx::query("DROP FUNCTION IF EXISTS test_4618_refuse_call_trace()")
            .execute(&su)
            .await
            .expect("drop function");
    };
    cleanup(w.su.clone()).await;
    sqlx::query(
        "CREATE FUNCTION test_4618_refuse_call_trace() RETURNS trigger LANGUAGE plpgsql AS \
         $$ BEGIN RAISE EXCEPTION 'test 4618: the call trace is refused'; END $$",
    )
    .execute(&w.su)
    .await
    .expect("create function");
    // Scoped to THIS test's workspace: a panic before the cleanup below leaves the trigger behind,
    // and it must not be able to refuse another test's (or another run's) rows.
    sqlx::query(&format!(
        "CREATE TRIGGER test_4618_refuse_call_trace BEFORE INSERT ON audit_log \
           FOR EACH ROW WHEN (NEW.action = 'agent_port.call' AND NEW.workspace_id = '{}') \
           EXECUTE FUNCTION test_4618_refuse_call_trace()",
        w.workspace
    ))
    .execute(&w.su)
    .await
    .expect("create trigger");

    // With every trace INSERT refused, the calls are answered exactly as before …
    let ping = wire.ping().await;
    assert!(ping.is_ok(), "{ping:?}");
    assert_eq!(ping.structured()["status"], "ok");
    let inbox = wire.inbox(None).await;
    assert!(inbox.is_ok(), "{inbox:?}");
    let refused = wire.tool("oort_inbox_read", json!({"cursor": 5})).await;
    assert_eq!((refused.status, refused.rpc_code()), (400, Some(-32602)));
    // … the failure is the trace's alone: no trace row, the pre-dispatch audit row still lands.
    assert_eq!(w.count("agent_port.call").await, 0);
    assert_eq!(w.count("auth.agent_bearer.used").await, 3);

    // The injection is real: without it the very next call is recorded.
    cleanup(w.su.clone()).await;
    assert!(wire.ping().await.is_ok());
    assert_eq!(w.count("agent_port.call").await, 1);
}

/// A write that outlasts its ceiling is abandoned, not waited for: the answer is the same, nothing is
/// committed, the call is not held longer than the ceiling allows, and the cancelled transaction does
/// not poison the pool — once the slowness is gone the very next call is recorded. This is the one
/// failure path (`Err(_)` of the `timeout`) the refusing-trigger test above cannot reach.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_trace_write_that_outlasts_its_ceiling_is_abandoned_and_the_answer_is_unchanged() {
    let w = world().await;
    let wire = w.wire();
    let cleanup = |su: PgPool| async move {
        sqlx::query("DROP TRIGGER IF EXISTS test_4618_slow_call_trace ON audit_log")
            .execute(&su)
            .await
            .expect("drop trigger");
        sqlx::query("DROP FUNCTION IF EXISTS test_4618_slow_call_trace()")
            .execute(&su)
            .await
            .expect("drop function");
    };
    cleanup(w.su.clone()).await;
    // Well past the 2 s ceiling, so the timeout fires first.
    sqlx::query(
        "CREATE FUNCTION test_4618_slow_call_trace() RETURNS trigger LANGUAGE plpgsql AS \
         $$ BEGIN PERFORM pg_sleep(4); RETURN NEW; END $$",
    )
    .execute(&w.su)
    .await
    .expect("create function");
    // Scoped to THIS test's workspace, for the same reason as the refusing trigger above.
    sqlx::query(&format!(
        "CREATE TRIGGER test_4618_slow_call_trace BEFORE INSERT ON audit_log \
           FOR EACH ROW WHEN (NEW.action = 'agent_port.call' AND NEW.workspace_id = '{}') \
           EXECUTE FUNCTION test_4618_slow_call_trace()",
        w.workspace
    ))
    .execute(&w.su)
    .await
    .expect("create trigger");

    let started = std::time::Instant::now();
    let ping = wire.ping().await;
    let waited = started.elapsed();
    assert!(ping.is_ok(), "{ping:?}");
    assert_eq!(ping.structured()["status"], "ok");
    assert!(
        waited < std::time::Duration::from_secs(4),
        "the answer is held for the ceiling (2 s), not for the slow write (4 s): {waited:?}"
    );
    assert_eq!(
        w.count("agent_port.call").await,
        0,
        "the abandoned write committed nothing"
    );
    assert_eq!(
        w.count("auth.agent_bearer.used").await,
        1,
        "the pre-dispatch row is untouched"
    );

    // The injection is real, and the pool survived the cancelled transaction: without the trigger the
    // next call is recorded.
    cleanup(w.su.clone()).await;
    assert!(wire.ping().await.is_ok());
    assert_eq!(w.count("agent_port.call").await, 1);
}
