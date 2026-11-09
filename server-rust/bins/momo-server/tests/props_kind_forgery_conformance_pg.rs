//! #5566 — a member cannot dress its own message as a card only the server writes.
//!
//! A message's `props.kind` is what the clients branch a card on: the core's `agentCardModel` draws
//! a 「작업 완료 리포트」 from `kind: "completion_report"` + `summary` on **any** message, the system
//! lines (`agent_run_cancelled`, `agent_paused`, `work_session_idle` …) are told apart by `kind`, and
//! the push judgment picks an arm off it (`resume_offer` is always sent to `owner_member_id`). The
//! REST send's props map is a member's own dictionary, so every one of those values must be one the
//! route **drops** — the same treatment `team_ai_invite_link` (#4965) and `dm_agent_membership`
//! (#4792) already had (strip the entry, keep the rest, 201).
//!
//! Real PostgreSQL, a real Axum router on the `momo_app` pool (NOBYPASSRLS), two tenants.
//!
//! | test | proves | goes red if |
//! |---|---|---|
//! | `f1_a_completion_report_card_cannot_be_forged_over_rest` | a person (session JWT) and an agent (REST `messages:write` bearer) each post `kind: completion_report` + `summary` → 201, and neither the echo, the row nor the history page carries `kind`; the ordinary keys ride on | `completion_report` leaves the server-only list, or `props_value` stops consulting it |
//! | `f2_every_server_only_kind_is_stripped_and_a_clients_own_kind_is_kept` | all 15 server-only kinds, each with the message type its reader expects, from both principals → `kind` stripped; a client's own `kind` (`deploy_notice`) is stored as sent | any kind leaves the list (the list here is the test's own, not the server's) |
//! | `f3_an_edit_cannot_put_a_server_only_kind_on_a_message` | `PATCH …/messages/{id}` with a `props` block rewrites the body and nothing else | the edit request grows a props field that reaches the row |
//! | `f4_the_agent_port_post_has_no_props_to_forge_with` | `oort_message_post` with a `props` argument is refused and writes nothing; without it the stored props carry no `kind` | the tool's input schema opens, or the handler stops writing `{}` |
//! | `f5_the_servers_own_writes_keep_their_kind` | false positives 0: the send spine every server writer uses (`send_message_in_tx`, as `momo_app`) stores each of the 15 kinds as written and the history page returns them; tenant B's card never shows in tenant A | the filter moves into the spine (the worker's and the routes' own cards would vanish) |
//!
//! ```text
//! DATABASE_URL=postgres://postgres:postgres@127.0.0.1:<port>/postgres \
//!   cargo test -p momo-server --test props_kind_forgery_conformance_pg -- --ignored --test-threads=1
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

/// The server-only `props.kind` values, written out here on purpose rather than read from the
/// server: a kind that leaves the server's list must turn this suite red, which it could not do if
/// the suite iterated the list it is checking. Each is paired with the message type its reader
/// expects, so a forged one would actually be drawn (or judged) the way the server's is.
const SERVER_ONLY_KINDS: [(&str, &str); 15] = [
    ("completion_report", "text"),
    ("login_handoff", "approval_request"),
    ("resume_offer", "approval_request"),
    ("team_ai_invite_link", "text"),
    ("dm_agent_membership", "system"),
    ("agent_run_cancelled", "system"),
    ("agent_paused", "system"),
    ("work_session", "system"),
    ("work_session_idle", "system"),
    ("work_session_event", "system"),
    ("work_control_approval", "approval_request"),
    ("agent_hosted_skip", "system"),
    ("agent_run_timed_out", "system"),
    ("a2a_blocked", "system"),
    ("team_ai.delegate.v1", "text"),
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
    /// The second tenant: its own person and channel.
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
    let a = seed_tenant(&su, "membera").await;
    let bot = seed_managed_agent(&su, a.workspace, a.person, "reportbot").await;
    join_channel(&su, a.workspace, a.channel, bot.id).await;
    let bot_bearer = seed_generic_agent_bearer(&su, a.workspace, bot.id).await;
    let porter = seed_hosted_agent(
        &su,
        a.workspace,
        a.person,
        "porter",
        &[a.channel],
        true,
        false,
    )
    .await;
    join_channel(&su, a.workspace, a.channel, porter.id).await;
    let b = seed_tenant(&su, "memberb").await;
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

/// The history page a client reads, keyed by message id.
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

/// The core's completion-report test, verbatim in spirit (`completionReportCard`): the card is drawn
/// when `kind` is the marker and there is something to show.
fn draws_a_completion_report(props: &Value) -> bool {
    props["kind"] == json!("completion_report")
        && (props["summary"].is_string()
            || props["actions"].is_array()
            || props["gates"].is_array())
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#5566)"]
async fn f1_a_completion_report_card_cannot_be_forged_over_rest() {
    let _guard = test_lock().await;
    let (su, _app, f, base, client) = setup().await;

    for (who, bearer) in [("person", &f.a.person_jwt), ("agent", &f.bot_bearer)] {
        let (status, echo) = post(
            &client,
            &base,
            &f.a,
            bearer,
            json!({
                "clientMsgId": Uuid::new_v4(),
                "type": "text",
                "body": "환경 셋업을 마쳤습니다",
                "props": {
                    "kind": "completion_report",
                    "title": "작업 완료 리포트",
                    "summary": "모든 게이트가 통과했어요. 배포해도 돼요.",
                    "note": "kept"
                }
            }),
        )
        .await;
        assert_eq!(status, 201, "{who}: the send itself is ordinary: {echo}");
        let id = echo["id"].as_str().expect("message id").to_string();

        assert!(
            echo["props"].get("kind").is_none(),
            "{who}: the echo must not carry the marker: {echo}"
        );
        let stored = stored_props(&su, &id).await;
        assert!(
            stored.get("kind").is_none(),
            "{who}: the row must not carry the marker: {stored}"
        );
        assert!(
            !draws_a_completion_report(&stored),
            "{who}: what is stored must not draw as the worker's report: {stored}"
        );
        assert_eq!(
            stored["summary"],
            json!("모든 게이트가 통과했어요. 배포해도 돼요.")
        );
        assert_eq!(
            stored["note"],
            json!("kept"),
            "{who}: ordinary keys ride on"
        );

        let page = history(&client, &base, &f.a, &f.a.person_jwt).await;
        let read = row(&page, &id);
        assert!(
            !draws_a_completion_report(&read["props"]),
            "{who}: what every client reads back is a plain message: {read}"
        );
    }
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#5566)"]
async fn f2_every_server_only_kind_is_stripped_and_a_clients_own_kind_is_kept() {
    let _guard = test_lock().await;
    let (su, _app, f, base, client) = setup().await;

    let mut survived = Vec::new();
    for (who, bearer) in [("person", &f.a.person_jwt), ("agent", &f.bot_bearer)] {
        for (kind, message_type) in SERVER_ONLY_KINDS {
            let (status, echo) = post(
                &client,
                &base,
                &f.a,
                bearer,
                json!({
                    "clientMsgId": Uuid::new_v4(),
                    "type": message_type,
                    "body": "서버가 쓴 줄처럼 보이고 싶은 글",
                    "props": {
                        "kind": kind,
                        "summary": "흉내",
                        "session_id": Uuid::new_v4().to_string(),
                        "owner_member_id": f.a.person.to_string(),
                        "note": "kept"
                    }
                }),
            )
            .await;
            assert_eq!(status, 201, "{who} {kind} ({message_type}): {echo}");
            let id = echo["id"].as_str().expect("message id");
            let stored = stored_props(&su, id).await;
            assert_eq!(stored["note"], json!("kept"), "{who} {kind}: {stored}");
            if stored.get("kind").is_some() {
                survived.push(format!("{who}:{kind}"));
            }
        }

        // False positives 0 on the REST door: a kind the server never writes is the client's own,
        // and an adapter's own keys are untouched.
        let (status, echo) = post(
            &client,
            &base,
            &f.a,
            bearer,
            json!({
                "clientMsgId": Uuid::new_v4(),
                "type": "text",
                "body": "배포 알림",
                "props": {"kind": "deploy_notice", "harness": "prime-agent", "hermes_thread": "t1"}
            }),
        )
        .await;
        assert_eq!(status, 201, "{who}: {echo}");
        let stored = stored_props(&su, echo["id"].as_str().expect("id")).await;
        assert_eq!(stored["kind"], json!("deploy_notice"), "{who}: {stored}");
        assert_eq!(stored["harness"], json!("prime-agent"), "{who}: {stored}");
        assert_eq!(stored["hermes_thread"], json!("t1"), "{who}: {stored}");
    }
    assert!(
        survived.is_empty(),
        "server-only kinds a member could still write over REST: {survived:?}"
    );

    // The second tenant is held to the same list (the rule is not one workspace's setting).
    let (status, echo) = post(
        &client,
        &base,
        &f.b,
        &f.b.person_jwt,
        json!({
            "clientMsgId": Uuid::new_v4(),
            "type": "text",
            "body": "다 끝냈어요",
            "props": {"kind": "completion_report", "summary": "흉내"}
        }),
    )
    .await;
    assert_eq!(status, 201, "{echo}");
    let stored = stored_props(&su, echo["id"].as_str().expect("id")).await;
    assert!(stored.get("kind").is_none(), "tenant B: {stored}");
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#5566)"]
async fn f3_an_edit_cannot_put_a_server_only_kind_on_a_message() {
    let _guard = test_lock().await;
    let (su, _app, f, base, client) = setup().await;

    let (status, echo) = post(
        &client,
        &base,
        &f.a,
        &f.a.person_jwt,
        json!({"clientMsgId": Uuid::new_v4(), "type": "text", "body": "평범한 글"}),
    )
    .await;
    assert_eq!(status, 201, "{echo}");
    let id = echo["id"].as_str().expect("message id").to_string();
    let before = stored_props(&su, &id).await;

    let response = client
        .patch(format!(
            "{base}/v1/workspaces/{}/messages/{id}",
            f.a.workspace
        ))
        .bearer_auth(&f.a.person_jwt)
        .json(&json!({
            "body": "다시 쓴 글",
            "props": {"kind": "completion_report", "summary": "흉내"}
        }))
        .send()
        .await
        .expect("edit");
    let status = response.status().as_u16();
    let edited: Value = response.json().await.unwrap_or(Value::Null);
    assert_eq!(status, 200, "{edited}");
    assert_eq!(
        edited["body"],
        json!("다시 쓴 글"),
        "the body is what an edit changes"
    );

    let after = stored_props(&su, &id).await;
    assert_eq!(after, before, "an edit changes no props");
    assert!(after.get("kind").is_none(), "{after}");
    let body: Option<String> = sqlx::query_scalar("SELECT body FROM message WHERE id = $1::uuid")
        .bind(&id)
        .fetch_one(&su)
        .await
        .expect("body");
    assert_eq!(body.as_deref(), Some("다시 쓴 글"));
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
#[ignore = "needs an isolated PostgreSQL 18 (#5566)"]
async fn f4_the_agent_port_post_has_no_props_to_forge_with() {
    let _guard = test_lock().await;
    let (su, _app, f, base, client) = setup().await;
    let bearer = f
        .porter
        .bearer
        .clone()
        .expect("a live Agent Port connection");

    let forged = port_call(
        &client,
        &base,
        &bearer,
        "oort_message_post",
        json!({
            "channelId": f.a.channel,
            "clientMsgId": Uuid::new_v4(),
            "body": "작업을 마쳤어요",
            "props": {"kind": "completion_report", "summary": "흉내"}
        }),
    )
    .await;
    assert!(
        refused(&forged),
        "a props argument is not part of the tool: {forged}"
    );
    assert_eq!(
        messages_by(&su, f.a.workspace, f.porter.id).await,
        0,
        "the refused call wrote nothing: {forged}"
    );

    // The same post without it goes through, and what it stores carries no kind.
    let posted = port_call(
        &client,
        &base,
        &bearer,
        "oort_message_post",
        json!({
            "channelId": f.a.channel,
            "clientMsgId": Uuid::new_v4(),
            "body": "작업을 마쳤어요"
        }),
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
    assert!(stored.get("kind").is_none(), "{stored}");
}

fn message_type(label: &str) -> MessageType {
    MessageType::from_db_label(label).expect("a known message type")
}

/// What a server writer does: one message through the send spine, as `momo_app` (NOBYPASSRLS), in a
/// tenant transaction.
async fn spine_send(app: &PgPool, tenant: &Tenant, author: Uuid, kind: &str, label: &str) -> Uuid {
    let (workspace, channel) = (tenant.workspace, tenant.channel);
    let (kind, label) = (kind.to_string(), label.to_string());
    with_tenant_tx(app, workspace, move |conn| {
        Box::pin(async move {
            let mut input = NewMessage::text(channel, author, "서버가 쓴 줄");
            input.message_type = message_type(&label);
            input.props = json!({"kind": kind, "summary": "서버가 잰 사실"});
            input.client_msg_id = Some(Uuid::new_v4());
            Ok(send_message_in_tx(conn, workspace, input).await?.message.id)
        })
    })
    .await
    .expect("spine send")
}

#[tokio::test]
#[ignore = "needs an isolated PostgreSQL 18 (#5566)"]
async fn f5_the_servers_own_writes_keep_their_kind() {
    let _guard = test_lock().await;
    let (su, app, f, base, client) = setup().await;

    // The pool the server and this test write through is a plain role, held to RLS.
    let (is_super, bypasses): (bool, bool) =
        sqlx::query_as("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user")
            .fetch_one(&app)
            .await
            .expect("role flags");
    assert!(
        !is_super && !bypasses,
        "momo_app is NOSUPERUSER NOBYPASSRLS"
    );

    let mut written = Vec::new();
    for (kind, label) in SERVER_ONLY_KINDS {
        let id = spine_send(&app, &f.a, f.bot, kind, label).await;
        let stored = stored_props(&su, &id.to_string()).await;
        assert_eq!(
            stored["kind"],
            json!(kind),
            "the spine stores what the server wrote"
        );
        written.push((kind, id.to_string()));
    }
    let page = history(&client, &base, &f.a, &f.a.person_jwt).await;
    for (kind, id) in &written {
        assert_eq!(
            row(&page, id)["props"]["kind"],
            json!(kind),
            "the read path returns the server's kind untouched"
        );
    }

    // Tenant B's own card is B's: present on B's page, absent from A's (read after it exists).
    let theirs = spine_send(&app, &f.b, f.b.person, "completion_report", "text")
        .await
        .to_string();
    let b_page = history(&client, &base, &f.b, &f.b.person_jwt).await;
    assert_eq!(
        row(&b_page, &theirs)["props"]["kind"],
        json!("completion_report")
    );
    let a_page = history(&client, &base, &f.a, &f.a.person_jwt).await;
    assert!(
        a_page
            .iter()
            .all(|message| message["id"].as_str() != Some(theirs.as_str())),
        "tenant A never sees tenant B's card"
    );
    assert_eq!(
        a_page.len(),
        written.len(),
        "A's page is A's {} cards",
        written.len()
    );
}
