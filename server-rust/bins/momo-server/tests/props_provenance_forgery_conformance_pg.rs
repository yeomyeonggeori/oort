//! #5577 — a member cannot dress its own message as a result the server measured, by provenance.
//!
//! #5566 closed the card `kind` values. The same family has a second spelling: a **provenance**
//! value under an ordinary key. The clients draw a server result off it without asking who wrote it:
//!
//! * `source: "team_ai"` is the closed world of the helper's answer tail (`teamAiReply`,
//!   `teamAiDelegation`), `source: "hermes_gateway"` names where a run ran (`appsRunSiteOf`);
//! * `source: "agent_worker.final_text.v0"` or `schema: "momo.agent_gateway.timeline.v0"` plus a
//!   `run_id` marks the settled turn record a provider-cascade notice and the memory receipt hang on
//!   (`cascadeModel.turnRecordRunId`);
//! * `error_code` is the worker's failure code, which the turn card turns into our own repair copy;
//! * `team_ai_model`, `tools_used`, `web_citations` are the helper tail's server facts.
//!
//! A REST props map is the sender's own dictionary, so each of these must be one the route
//! **drops** — the treatment `source: "github"` (ADR-0205 H-1, #4084) already had: strip the entry,
//! keep the rest, 201.
//!
//! Real PostgreSQL, a real Axum router on the `momo_app` pool (NOBYPASSRLS), two tenants.
//!
//! | test | proves | goes red if |
//! |---|---|---|
//! | `p1_a_server_result_cannot_be_forged_over_rest` | a person (session JWT) and an agent (REST `messages:write` bearer) each post five server-result shapes → 201, and neither the echo, the row nor the history page carries a server provenance value or key; the readers' own tests (mirrored below) find nothing to draw; ordinary keys ride on | a value or key leaves the server-owned rule, or `props_value` stops consulting it |
//! | `p2_spellings_and_a_clients_own_source_are_told_apart` | case/space variants of the server's values are dropped too; a client's own `source`/`schema` (`prime`, `agent_worker` without the dot, `prime.v1`) is stored as sent; tenant B is held to the same rule | the rule widens to a blanket or narrows to an exact spelling |
//! | `p3_the_agent_port_post_has_no_props_to_forge_with` | `oort_message_post` carrying a provenance `props` block is refused and writes nothing | the tool's input schema opens |
//! | `p4_the_servers_own_writes_keep_their_provenance` | false positives 0: the send spine every server writer uses (`send_message_in_tx`, as `momo_app`) stores the gateway's, the worker's, the helper's and a server notice's props as written, and the history page returns them; tenant B's row never shows in tenant A | the filter moves into the spine (every server result would vanish) |
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:<port>/momo \
//!   cargo test -p momo-server --test props_provenance_forgery_conformance_pg -- --ignored --test-threads=1
//! ```

#[path = "common/apps_pg.rs"]
mod apps_pg;

use apps_pg::*;
use momo_db::sqlx;
use momo_db::{with_tenant_tx, PgPool};
use momo_messaging::{send_message_in_tx, MessageType, NewMessage};
use serde_json::{json, Value};
use std::sync::OnceLock;
use uuid::Uuid;

const PORT_PATH: &str = "/v1/mcp/agent-port";
const MODERN_VERSION: &str = "2026-07-28";

/// The provenance keys a server result is told apart by. Written out here on purpose rather than
/// read from the server: a value that leaves the server's rule must turn this suite red.
const PROVENANCE_KEYS: [&str; 6] = [
    "source",
    "schema",
    "error_code",
    "team_ai_model",
    "tools_used",
    "web_citations",
];

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

struct Tenant {
    workspace: Uuid,
    person: Uuid,
    person_jwt: String,
    channel: Uuid,
}

struct Fixture {
    a: Tenant,
    /// A plain agent posting over REST with a generic `messages:write` bearer (an out-of-process
    /// producer such as an adapter), a member of `a.channel`.
    bot: Uuid,
    bot_bearer: String,
    /// A hosted agent with a live Agent Port connection approved for `a.channel`, a member of it.
    porter: SeededAgent,
    b: Tenant,
}

async fn seed_tenant(su: &PgPool, label: &str) -> Tenant {
    let workspace = seed_workspace(su).await;
    let (person, person_jwt) = seed_human(su, workspace, "member", label).await;
    let channel = seed_channel(su, workspace, "public", &[person]).await;
    Tenant {
        workspace,
        person,
        person_jwt,
        channel,
    }
}

async fn setup() -> (PgPool, PgPool, Fixture, String, reqwest::Client) {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let a = seed_tenant(&su, "provmembera").await;
    let bot = seed_managed_agent(&su, a.workspace, a.person, "provbot").await;
    join_channel(&su, a.workspace, a.channel, bot.id).await;
    let bot_bearer = seed_generic_agent_bearer(&su, a.workspace, bot.id).await;
    let porter = seed_hosted_agent(
        &su,
        a.workspace,
        a.person,
        "provporter",
        &[a.channel],
        true,
        false,
    )
    .await;
    join_channel(&su, a.workspace, a.channel, porter.id).await;
    let b = seed_tenant(&su, "provmemberb").await;
    let base = start_server(app.clone(), ServerOptions::default()).await;
    (
        su,
        app,
        Fixture {
            a,
            bot: bot.id,
            bot_bearer,
            porter,
            b,
        },
        base,
        reqwest::Client::new(),
    )
}

fn messages_url(base: &str, tenant: &Tenant) -> String {
    format!(
        "{base}/v1/workspaces/{}/channels/{}/messages",
        tenant.workspace, tenant.channel
    )
}

/// `(status, body)` of one REST send.
async fn post(
    client: &reqwest::Client,
    base: &str,
    tenant: &Tenant,
    bearer: &str,
    body: Value,
) -> (u16, Value) {
    let response = client
        .post(messages_url(base, tenant))
        .bearer_auth(bearer)
        .json(&body)
        .send()
        .await
        .expect("send");
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

async fn stored_props(su: &PgPool, message: &str) -> Value {
    sqlx::query_scalar("SELECT props FROM message WHERE id = $1::uuid")
        .bind(message)
        .fetch_one(su)
        .await
        .expect("stored props")
}

/// The history page a client reads.
async fn history(
    client: &reqwest::Client,
    base: &str,
    tenant: &Tenant,
    bearer: &str,
) -> Vec<Value> {
    let page: Value = client
        .get(messages_url(base, tenant))
        .bearer_auth(bearer)
        .send()
        .await
        .expect("history")
        .json()
        .await
        .expect("history body");
    page["messages"].as_array().expect("messages").clone()
}

fn row<'a>(page: &'a [Value], id: &str) -> &'a Value {
    page.iter()
        .find(|message| message["id"].as_str() == Some(id))
        .unwrap_or_else(|| panic!("{id} is on the history page"))
}

// ---- the clients' own tests, mirrored (packages/momo-core/src/features/timeline) ---------------

/// `cascadeModel.turnRecordRunId`: the settled turn record a cascade notice and the memory receipt
/// hang on — the gateway's schema or the worker's final-text source, plus a run id.
fn turn_record_run_id(props: &Value) -> Option<&str> {
    let settled = props["schema"] == json!("momo.agent_gateway.timeline.v0")
        || props["source"] == json!("agent_worker.final_text.v0");
    if !settled {
        return None;
    }
    props["run_id"].as_str().filter(|run| !run.is_empty())
}

/// `teamAiReply.parseTeamAiReplyMeta` / `teamAiDelegation.teamAiDelegationsOf`: the helper's closed
/// world opens on this value alone.
fn reads_as_the_helpers_answer(props: &Value) -> bool {
    props["source"] == json!("team_ai")
}

/// `teamAiReply.appsRunSiteOf`: 「Hermes에서 실행했어요」.
fn reads_as_run_on_hermes(props: &Value) -> bool {
    props["source"] == json!("hermes_gateway")
}

/// `agentCardModel.turnCard` → `failureGuidance(props.error_code)`: our own repair copy for the
/// worker's failure code (「연결된 계정 인증이 만료되었습니다」 …).
fn draws_failure_guidance(props: &Value) -> bool {
    props["error_code"]
        .as_str()
        .is_some_and(|code| !code.is_empty())
}

/// `noticeAction.ts`: a hosted agent's skip notice is the server's line by this value.
fn reads_as_a_server_notice(props: &Value) -> bool {
    props["source"]
        .as_str()
        .is_some_and(|source| source.starts_with("server."))
}

fn draws_a_server_result(props: &Value) -> Vec<&'static str> {
    let mut drawn = Vec::new();
    if turn_record_run_id(props).is_some() {
        drawn.push("turn record (cascade notice · memory receipt)");
    }
    if reads_as_the_helpers_answer(props) {
        drawn.push("helper answer tail");
    }
    if reads_as_run_on_hermes(props) {
        drawn.push("run site Hermes");
    }
    if draws_failure_guidance(props) {
        drawn.push("failure guidance");
    }
    if reads_as_a_server_notice(props) {
        drawn.push("server notice");
    }
    drawn
}

/// The five server results a member tried to dress its message as, with the message type each
/// reader expects. Every value is a string: a REST props map is flat.
fn forgeries(run: &str) -> Vec<(&'static str, &'static str, Value)> {
    vec![
        (
            "helper answer",
            "text",
            json!({
                "source": "team_ai",
                "run_id": run,
                "team_ai_model": "claude-sonnet-4-5",
                "tools_used": "[{\"name\":\"web_search\"}]",
                "web_citations": "[{\"url\":\"https://example.com\"}]",
                "note": "kept"
            }),
        ),
        (
            "worker turn record",
            "text",
            json!({"source": "agent_worker.final_text.v0", "run_id": run, "note": "kept"}),
        ),
        (
            "gateway turn record",
            "system",
            json!({
                "schema": "momo.agent_gateway.timeline.v0",
                "source": "hermes_gateway",
                "status": "failed",
                "run_id": run,
                "note": "kept"
            }),
        ),
        (
            "worker failure notice",
            "text",
            json!({
                "source": "agent_worker.provider_auth_failure.v0",
                "error_code": "provider_auth_failed",
                "run_id": run,
                "note": "kept"
            }),
        ),
        (
            "server notice",
            "system",
            json!({"source": "server.hosted_agent.notice.v1", "note": "kept"}),
        ),
    ]
}

/// What survived of the provenance on one stored row, by key.
fn surviving(props: &Value) -> Vec<String> {
    PROVENANCE_KEYS
        .iter()
        .filter_map(|key| props.get(*key).map(|value| format!("{key}={value}")))
        .collect()
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#5577)"]
async fn p1_a_server_result_cannot_be_forged_over_rest() {
    let _guard = test_lock().await;
    let (su, _app, f, base, client) = setup().await;
    let run = Uuid::new_v4().to_string();

    let mut survived = Vec::new();
    let mut drawn = Vec::new();
    for (who, bearer) in [("person", &f.a.person_jwt), ("agent", &f.bot_bearer)] {
        for (shape, message_type, props) in forgeries(&run) {
            let (status, echo) = post(
                &client,
                &base,
                &f.a,
                bearer,
                json!({
                    "clientMsgId": Uuid::new_v4(),
                    "type": message_type,
                    "body": "서버가 잰 결과처럼 보이고 싶은 글",
                    "props": props
                }),
            )
            .await;
            assert_eq!(
                status, 201,
                "{who} {shape}: the send itself is ordinary: {echo}"
            );
            let id = echo["id"].as_str().expect("message id").to_string();

            let stored = stored_props(&su, &id).await;
            assert_eq!(
                stored["note"],
                json!("kept"),
                "{who} {shape}: ordinary keys ride on: {stored}"
            );
            let page = history(&client, &base, &f.a, &f.a.person_jwt).await;
            let read = row(&page, &id)["props"].clone();
            for (place, props) in [
                ("echo", &echo["props"]),
                ("row", &stored),
                ("history", &read),
            ] {
                for key in surviving(props) {
                    survived.push(format!("{who} {shape} {place}: {key}"));
                }
                for reader in draws_a_server_result(props) {
                    drawn.push(format!("{who} {shape} {place}: {reader}"));
                }
            }
        }
    }
    assert!(
        survived.is_empty() && drawn.is_empty(),
        "server provenance a member could still write over REST:\n{}\nso a client draws:\n{}",
        survived.join("\n"),
        drawn.join("\n")
    );
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#5577)"]
async fn p2_spellings_and_a_clients_own_source_are_told_apart() {
    let _guard = test_lock().await;
    let (su, _app, f, base, client) = setup().await;

    let mut survived = Vec::new();
    for (key, value) in [
        ("source", " Team_AI "),
        ("source", "HERMES_GATEWAY"),
        ("source", "Agent_Worker.final_text.v0"),
        ("source", "agent_worker.anything.v9"),
        ("source", "SERVER.subscription_agent.notice.v1"),
        ("Source", "team_ai"),
        ("schema", "momo.agent_gateway.timeline.v0"),
        ("schema", " MOMO.work_session.acp_event.v1"),
    ] {
        let (status, echo) = post(
            &client,
            &base,
            &f.a,
            &f.a.person_jwt,
            json!({
                "clientMsgId": Uuid::new_v4(),
                "type": "text",
                "body": "흉내",
                "props": {key: value, "note": "kept"}
            }),
        )
        .await;
        assert_eq!(status, 201, "{key}={value}: {echo}");
        let stored = stored_props(&su, echo["id"].as_str().expect("id")).await;
        assert_eq!(stored["note"], json!("kept"), "{key}={value}: {stored}");
        if stored.get(key).is_some() {
            survived.push(format!("{key}={value:?}"));
        }
    }
    assert!(
        survived.is_empty(),
        "spellings of the server's provenance a member could still write: {survived:?}"
    );

    // False positives 0 on the REST door: a provenance the server never writes is the client's own.
    for (key, value) in [
        ("source", "prime"),
        ("source", "agent_worker"),
        ("source", "team_ai_v2"),
        ("source", "my.server.relay"),
        ("schema", "prime.v1"),
        ("schema", "momo"),
    ] {
        let (status, echo) = post(
            &client,
            &base,
            &f.a,
            &f.bot_bearer,
            json!({
                "clientMsgId": Uuid::new_v4(),
                "type": "text",
                "body": "어댑터 글",
                "props": {key: value, "harness": "prime-agent"}
            }),
        )
        .await;
        assert_eq!(status, 201, "{key}={value}: {echo}");
        let stored = stored_props(&su, echo["id"].as_str().expect("id")).await;
        assert_eq!(
            stored[key],
            json!(value),
            "{key}={value} is the client's own: {stored}"
        );
        assert_eq!(stored["harness"], json!("prime-agent"), "{stored}");
    }

    // The second tenant is held to the same rule (it is not one workspace's setting).
    let (status, echo) = post(
        &client,
        &base,
        &f.b,
        &f.b.person_jwt,
        json!({
            "clientMsgId": Uuid::new_v4(),
            "type": "text",
            "body": "다 끝냈어요",
            "props": {"source": "agent_worker.final_text.v0", "run_id": Uuid::new_v4().to_string()}
        }),
    )
    .await;
    assert_eq!(status, 201, "{echo}");
    let stored = stored_props(&su, echo["id"].as_str().expect("id")).await;
    assert!(stored.get("source").is_none(), "tenant B: {stored}");
    assert!(turn_record_run_id(&stored).is_none(), "tenant B: {stored}");
}

/// One Agent Port `tools/call`, answered as the raw JSON-RPC envelope.
async fn port_call(
    client: &reqwest::Client,
    base: &str,
    bearer: &str,
    tool: &str,
    arguments: Value,
) -> Value {
    let body = json!({
        "jsonrpc": "2.0",
        "id": Uuid::new_v4().to_string(),
        "method": "tools/call",
        "params": {
            "_meta": {
                "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
                "io.modelcontextprotocol/clientCapabilities": {}
            },
            "name": tool,
            "arguments": arguments,
        }
    });
    client
        .post(format!("{base}{PORT_PATH}"))
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", MODERN_VERSION)
        .header("mcp-method", "tools/call")
        .header("mcp-name", tool)
        .bearer_auth(bearer)
        .json(&body)
        .send()
        .await
        .expect("tools/call")
        .json()
        .await
        .expect("tools/call body")
}

fn refused(envelope: &Value) -> bool {
    envelope.get("error").is_some_and(|error| !error.is_null())
        || envelope["result"]["isError"] == json!(true)
}

async fn messages_by(su: &PgPool, workspace: Uuid, author: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM message WHERE workspace_id = $1 AND author_member_id = $2",
    )
    .bind(workspace)
    .bind(author)
    .fetch_one(su)
    .await
    .expect("count")
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#5577)"]
async fn p3_the_agent_port_post_has_no_props_to_forge_with() {
    let _guard = test_lock().await;
    let (su, _app, f, base, client) = setup().await;
    let bearer = f
        .porter
        .bearer
        .clone()
        .expect("a live Agent Port connection");

    for (shape, _type, props) in forgeries(&Uuid::new_v4().to_string()) {
        let forged = port_call(
            &client,
            &base,
            &bearer,
            "oort_message_post",
            json!({
                "channelId": f.a.channel,
                "clientMsgId": Uuid::new_v4(),
                "body": "작업을 마쳤어요",
                "props": props
            }),
        )
        .await;
        assert!(
            refused(&forged),
            "{shape}: props is not part of the tool: {forged}"
        );
    }
    assert_eq!(
        messages_by(&su, f.a.workspace, f.porter.id).await,
        0,
        "the refused calls wrote nothing"
    );

    // The same post without it goes through, and what it stores carries no provenance.
    let posted = port_call(
        &client,
        &base,
        &bearer,
        "oort_message_post",
        json!({"channelId": f.a.channel, "clientMsgId": Uuid::new_v4(), "body": "작업을 마쳤어요"}),
    )
    .await;
    assert!(!refused(&posted), "the control call is accepted: {posted}");
    let stored: Value = sqlx::query_scalar(
        "SELECT props FROM message WHERE workspace_id = $1 AND author_member_id = $2",
    )
    .bind(f.a.workspace)
    .bind(f.porter.id)
    .fetch_one(&su)
    .await
    .expect("the agent's message");
    assert!(surviving(&stored).is_empty(), "{stored}");
    assert!(draws_a_server_result(&stored).is_empty(), "{stored}");
}

/// What a server writer does: one message through the send spine, as `momo_app` (NOBYPASSRLS), in a
/// tenant transaction.
async fn spine_send(
    app: &PgPool,
    tenant: &Tenant,
    author: Uuid,
    label: &str,
    props: Value,
) -> Uuid {
    let (workspace, channel) = (tenant.workspace, tenant.channel);
    let label = label.to_string();
    with_tenant_tx(app, workspace, move |conn| {
        Box::pin(async move {
            let mut input = NewMessage::text(channel, author, "서버가 쓴 결과");
            input.message_type = MessageType::from_db_label(&label).expect("a known message type");
            input.props = props;
            input.client_msg_id = Some(Uuid::new_v4());
            Ok(send_message_in_tx(conn, workspace, input).await?.message.id)
        })
    })
    .await
    .expect("spine send")
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#5577)"]
async fn p4_the_servers_own_writes_keep_their_provenance() {
    let _guard = test_lock().await;
    let (su, app, f, base, client) = setup().await;

    let (is_super, bypasses): (bool, bool) =
        sqlx::query_as("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user")
            .fetch_one(&app)
            .await
            .expect("role flags");
    assert!(
        !is_super && !bypasses,
        "momo_app is NOSUPERUSER NOBYPASSRLS"
    );

    let run = Uuid::new_v4().to_string();
    // The shapes the server's writers put on a message (agent_gateway.rs `timeline_props`, the
    // worker's `success_props` / `failure_props`, the helper's `answer_props` — the same shape as
    // the core fixture `__fixtures__/team-ai-reply-props.json` — and a hosted skip notice).
    let written = [
        (
            "gateway turn record",
            "text",
            json!({
                "schema": "momo.agent_gateway.timeline.v0",
                "source": "hermes_gateway",
                "status": "succeeded",
                "run_id": run,
                "agent_member_id": f.bot.to_string(),
                "usage": {"model": "claude-opus-4", "prompt_tokens": 10, "completion_tokens": 5},
                "error": null
            }),
        ),
        (
            "worker turn record",
            "text",
            json!({"run_id": run, "source": "agent_worker.final_text.v0"}),
        ),
        (
            "worker failure notice",
            "text",
            json!({
                "run_id": run,
                "source": "agent_worker.provider_auth_failure.v0",
                "error_code": "provider_auth_failed"
            }),
        ),
        (
            "helper answer",
            "text",
            json!({
                "run_id": run,
                "source": "team_ai",
                "team_ai_model": {"model": "claude-sonnet-4-5", "wire": "anthropic"},
                "tools_used": [{"name": "web_search"}],
                "web_citations": [{"url": "https://example.com", "title": "예시"}]
            }),
        ),
        (
            "hosted skip notice",
            "system",
            json!({"source": "server.hosted_agent.notice.v1", "notice_for_member_id": f.a.person.to_string()}),
        ),
    ];
    let mut ids = Vec::new();
    for (shape, label, props) in &written {
        let id = spine_send(&app, &f.a, f.bot, label, props.clone()).await;
        let stored = stored_props(&su, &id.to_string()).await;
        assert_eq!(
            &stored, props,
            "{shape}: the spine stores what the server wrote"
        );
        ids.push((*shape, id.to_string(), props.clone()));
    }
    let page = history(&client, &base, &f.a, &f.a.person_jwt).await;
    for (shape, id, props) in &ids {
        let read = &row(&page, id)["props"];
        for key in PROVENANCE_KEYS {
            assert_eq!(
                read.get(key),
                props.get(key),
                "{shape}: the read path returns the server's {key} untouched"
            );
        }
    }
    assert_eq!(
        turn_record_run_id(&row(&page, &ids[0].1)["props"]),
        Some(run.as_str()),
        "the gateway's record is still the run's settled record"
    );
    assert_eq!(
        turn_record_run_id(&row(&page, &ids[1].1)["props"]),
        Some(run.as_str()),
        "the worker's record is still the run's settled record"
    );
    assert!(draws_failure_guidance(&row(&page, &ids[2].1)["props"]));
    assert!(reads_as_the_helpers_answer(&row(&page, &ids[3].1)["props"]));
    assert!(reads_as_a_server_notice(&row(&page, &ids[4].1)["props"]));

    // Tenant B's own record is B's: present on B's page, absent from A's (read after it exists).
    let theirs = spine_send(
        &app,
        &f.b,
        f.b.person,
        "text",
        json!({"run_id": run, "source": "agent_worker.final_text.v0"}),
    )
    .await
    .to_string();
    let b_page = history(&client, &base, &f.b, &f.b.person_jwt).await;
    assert_eq!(
        row(&b_page, &theirs)["props"]["source"],
        json!("agent_worker.final_text.v0")
    );
    let a_page = history(&client, &base, &f.a, &f.a.person_jwt).await;
    assert!(
        a_page
            .iter()
            .all(|message| message["id"].as_str() != Some(theirs.as_str())),
        "tenant A never sees tenant B's record"
    );
    assert_eq!(
        a_page.len(),
        written.len(),
        "A's page is A's {} rows",
        written.len()
    );
}
