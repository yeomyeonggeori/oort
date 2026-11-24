//! #6069 — an agent a person approved once registers its own team expressions without a card (ADR-0218
//! 증보 13 §19), end to end: the grant routes on a person's session, the Agent Port tool
//! `oort_expression_register` over real TCP, a real PG18 and the real isolated decoder child.
//!
//! ```text
//! cargo build -p momo-expressions --bins            # the decoder child sits next to the test exe
//! DATABASE_URL=postgres://postgres:postgres@127.0.0.1:PORT/DB \
//!   cargo test -p momo-server --test expression_self_register_pg -- --ignored --test-threads=1
//! ```
//!
//! The server runs as `momo_app` (no BYPASSRLS); fixtures are seeded as the superuser. Every test holds
//! one global mutex (the decoder counters are process-wide) and reads counter deltas.
//!
//! | test | acceptance (§19 Y7) | revert that makes it red |
//! |---|---|---|
//! | `a_granted_agent_registers_once_and_the_row_says_who` | YA1 · YA4 · YA9 · YA13 · YA14 | drop the grant clause of `standing_in_tx`; write `created_by` = the agent; drop the replay read in `begin_in_tx` |
//! | `every_closed_door_closes_the_next_call` | YA3 · YA18 | drop any one clause of `standing_in_tx`; drop `agent_keys` in the list route |
//! | `the_ceilings_are_judged_before_the_decoder_and_again_after` | YA2 · YA12 · YA16 · YA19 | drop a count in `counts_in_tx` or move `ceiling(…, true)` after the decode |
//! | `only_a_persons_session_reaches_the_grant` | YA5 · YA8 · YA20 | drop `require_human` / the `FullPersonSession` check; let a member give a grant |
//! | `a_picture_that_is_not_generated_is_an_argument_error` | YA6 · YA7 | widen the tool schema; skip the name rule |
//! | `a_self_registered_expression_is_not_an_agents_reaction` | YA21 (ADR-0162 증보 8 RA4 · RA8) | drop `grant_id IS NULL` from `AGENT_USABLE_EXPRESSION` |
//! | `the_big_body_is_read_only_through_an_open_door` | Y2.2 「큰 본문을 읽기 전에」 · `MAX_REGISTER_REQUEST_BYTES` | read 2 MiB for any propose-scoped agent (drop `register_door_open` in `agent_port.rs`); drop the register branch of the MCP budget |
//! | `only_the_api_holds_the_grant_tables` | Y2.1 「쓰기 권한」 | a grant to any other role in `expression-agent-grant-lockdown` |

#[path = "common/expression_children.rs"]
mod expression_children;

use std::io::Cursor;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use base64::Engine as _;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_expressions::media;
use momo_server::config::AgentPortConfig;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "expression-self-register-pg-signing-secret";
const MODERN_VERSION: &str = "2026-07-28";
const MCP_PATH: &str = "/v1/mcp/agent-port";
const AUDIENCE: &str = "/v1/mcp/agent-port";
const TOOL: &str = "oort_expression_register";
const PROMPT_MARK: &str = "PROMPT-MARK-6069";
const NAME_MARK: &str = "name-mark";

static GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a disposable PG18 superuser DB")
}

fn resolve_psql() -> PathBuf {
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join("psql");
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    for candidate in [
        "/opt/homebrew/opt/libpq/bin/psql",
        "/usr/local/opt/libpq/bin/psql",
    ] {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return path;
        }
    }
    panic!("psql client not found");
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations");
    let path = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/rust/sql/bootstrap_roles.sql"
    ));
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(path)
        .status()
        .expect("spawn psql");
    assert!(status.success(), "bootstrap_roles.sql failed");
    *ready = true;
}

fn require_decoder() {
    if std::env::var_os("OORT_EXPRESSION_DECODER").is_some() {
        return;
    }
    let path = expression_children::ready("momo-expression-decoder");
    assert!(
        path.is_ok(),
        "build the decoder first: cargo build -p momo-expressions --bins ({path:?})"
    );
}

async fn pool_as(role: &str, password_env: &str, fallback: &str, max: u32) -> PgPool {
    let options: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
    let password = std::env::var(password_env).unwrap_or_else(|_| fallback.to_string());
    PgPoolOptions::new()
        .max_connections(max)
        .connect_with(options.username(role).password(&password))
        .await
        .unwrap_or_else(|error| panic!("connect as {role}: {error}"))
}

struct World {
    base: String,
    addr: SocketAddr,
    su: PgPool,
}

async fn boot(table: media::RenditionTable) -> World {
    require_decoder();
    ensure_schema_and_roles();
    let su = PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("superuser pool");
    let app = pool_as("momo_app", "MOMO_APP_PASSWORD", "momo_app_dev_pw", 8).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr: SocketAddr = listener.local_addr().unwrap();
    let state = AppState::new(
        app,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_agent_port(AgentPortConfig {
        per_token_limit: 0,
        per_agent_limit: 0,
        per_ip_limit: 0,
        hosted_delivery_enabled: true,
        ..AgentPortConfig::default()
    })
    .with_expression_rendition_table(table);
    let router = build_app(state);
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    World {
        base: format!("http://{addr}"),
        addr,
        su,
    }
}

// --- the fixture --------------------------------------------------------------

#[derive(Debug, Clone)]
struct Agent {
    member: Uuid,
    connection: Uuid,
    bearer: String,
}

#[derive(Debug, Clone)]
struct Person {
    member: Uuid,
    jwt: String,
}

#[derive(Debug, Clone)]
struct Tenant {
    ws: Uuid,
    /// The owner (an administrator) and the agents' owner.
    admin: Person,
    /// A plain member.
    member: Person,
    a: Agent,
}

async fn exec(su: &PgPool, sql: &str, ids: &[Uuid]) {
    let mut query = sqlx::query(sql);
    for id in ids {
        query = query.bind(*id);
    }
    query
        .execute(su)
        .await
        .unwrap_or_else(|error| panic!("{sql}: {error}"));
}

const SCOPES: &str = "ARRAY['agent:port:connect','agent:inbox:read','messages:read','messages:write','workspace:propose']::text[]";

async fn seed_connection(
    su: &PgPool,
    ws: Uuid,
    agent: Uuid,
    owner: Uuid,
    channel: Uuid,
) -> (Uuid, String) {
    let connection = Uuid::new_v4();
    sqlx::query(&format!(
        "INSERT INTO hosted_agent_connection( \
           id,workspace_id,agent_member_id,status,pairing_consumed_at,detected_at,detected_by, \
           confirmed_by,confirmed_at,approved_channel_ids,approved_scopes,created_by) \
         VALUES($1,$2,$3,'detected',now(),now(),$4,$4,now(),$5,{SCOPES},$4)"
    ))
    .bind(connection)
    .bind(ws)
    .bind(agent)
    .bind(owner)
    .bind(vec![channel])
    .execute(su)
    .await
    .expect("hosted connection");
    let bearer = format!(
        "momo_agent_v1.{ws}.{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    );
    let token_id: Uuid = sqlx::query_scalar(&format!(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label, \
                           credential_class, hosted_connection_id, audience, created_by) \
         VALUES($1,'agent_bearer',$2,digest($3::text,'sha256'),{SCOPES}, \
                'hosted agent port','hosted_active',$4,$5,$6) RETURNING id"
    ))
    .bind(ws)
    .bind(agent)
    .bind(&bearer)
    .bind(connection)
    .bind(AUDIENCE)
    .bind(owner)
    .fetch_one(su)
    .await
    .expect("hosted bearer");
    exec(
        su,
        "UPDATE hosted_agent_connection SET status='active', active_token_id=$3, proved_at=now(), \
           proved_by=$4 WHERE workspace_id=$1 AND id=$2",
        &[ws, connection, token_id, agent],
    )
    .await;
    (connection, bearer)
}

async fn seed_agent(su: &PgPool, ws: Uuid, owner: Uuid, channel: Uuid) -> Agent {
    let member = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) VALUES($1,$2,'agent','그림 도우미',$3)",
    )
    .bind(member)
    .bind(ws)
    .bind(format!("agent-{}", member.simple()))
    .execute(su)
    .await
    .expect("agent member");
    exec(
        su,
        "INSERT INTO agent(member_id, workspace_id, model, base_url, owner_human_id, config) \
         VALUES($1,$2,'hosted-agent','https://hosted-agent.invalid/disabled',$3, \
                '{\"execution_mode\":\"hosted_dial_in\"}'::jsonb)",
        &[member, ws, owner],
    )
    .await;
    exec(
        su,
        "INSERT INTO workspace_membership(workspace_id, member_id, role) VALUES($1,$2,'member')",
        &[ws, member],
    )
    .await;
    exec(
        su,
        "INSERT INTO agent_profile(agent_member_id, workspace_id, updated_by, paused) VALUES($1,$2,$3,false)",
        &[member, ws, owner],
    )
    .await;
    exec(
        su,
        "INSERT INTO membership(workspace_id, channel_id, member_id) VALUES($1,$2,$3)",
        &[ws, channel, member],
    )
    .await;
    let (connection, bearer) = seed_connection(su, ws, member, owner, channel).await;
    Agent {
        member,
        connection,
        bearer,
    }
}

async fn seed_person(su: &PgPool, ws: Uuid, role: &str, name: &str) -> Person {
    let member = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) VALUES($1,$2,'human',$3,$4)",
    )
    .bind(member)
    .bind(ws)
    .bind(name)
    .bind(format!("human-{}", member.simple()))
    .execute(su)
    .await
    .expect("human");
    sqlx::query(
        "INSERT INTO human(member_id, workspace_id, email, email_verified) VALUES($1,$2,$3,true)",
    )
    .bind(member)
    .bind(ws)
    .bind(format!("{member}@self-expression.test"))
    .execute(su)
    .await
    .expect("human identity");
    sqlx::query(&format!(
        "INSERT INTO workspace_membership(workspace_id, member_id, role) VALUES($1,$2,'{role}')"
    ))
    .bind(ws)
    .bind(member)
    .execute(su)
    .await
    .expect("membership");
    let jwt = momo_auth::sign_access(member, ws, &[], TEST_JWT_SECRET)
        .expect("sign a human App JWT")
        .token;
    sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label) \
         VALUES($1,'session',$2,digest($3::text,'sha256'),ARRAY[]::text[],'self-expression')",
    )
    .bind(ws)
    .bind(member)
    .bind(&jwt)
    .execute(su)
    .await
    .expect("human session");
    Person { member, jwt }
}

async fn seed(su: &PgPool) -> Tenant {
    let ws = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace(id, slug, name) VALUES($1,$2,$2)")
        .bind(ws)
        .bind(format!("self-{}", ws.simple()))
        .execute(su)
        .await
        .expect("workspace");
    let admin = seed_person(su, ws, "owner", "김도현").await;
    let member = seed_person(su, ws, "member", "이서연").await;
    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel(id, workspace_id, kind, name, browse_listed) VALUES($1,$2,'public',$3,true)",
    )
    .bind(channel)
    .bind(ws)
    .bind(format!("qa-{}", channel.simple()))
    .execute(su)
    .await
    .expect("channel");
    exec(
        su,
        "INSERT INTO channel_seq(channel_id, workspace_id, last_seq) VALUES($1,$2,0)",
        &[channel, ws],
    )
    .await;
    for person in [admin.member, member.member] {
        exec(
            su,
            "INSERT INTO membership(workspace_id, channel_id, member_id) VALUES($1,$2,$3)",
            &[ws, channel, person],
        )
        .await;
    }
    let a = seed_agent(su, ws, admin.member, channel).await;
    Tenant {
        ws,
        admin,
        member,
        a,
    }
}

// --- the wire -----------------------------------------------------------------

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("client")
}

fn modern_body(method: &str, extra: Value) -> Value {
    let mut params = json!({
        "_meta": {
            "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
            "io.modelcontextprotocol/clientCapabilities": {}
        }
    });
    for (key, value) in extra.as_object().expect("an object") {
        params[key] = value.clone();
    }
    json!({"jsonrpc": "2.0", "id": Uuid::new_v4().to_string(), "method": method, "params": params})
}

async fn call(w: &World, bearer: &str, arguments: Value) -> (u16, Value) {
    let response = client()
        .post(format!("{}{MCP_PATH}", w.base))
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", MODERN_VERSION)
        .header("mcp-method", "tools/call")
        .header("mcp-name", TOOL)
        .bearer_auth(bearer)
        .json(&modern_body(
            "tools/call",
            json!({"name": TOOL, "arguments": arguments}),
        ))
        .send()
        .await
        .expect("tools/call");
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

async fn listed(w: &World, bearer: &str) -> bool {
    let response = client()
        .post(format!("{}{MCP_PATH}", w.base))
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", MODERN_VERSION)
        .header("mcp-method", "tools/list")
        .bearer_auth(bearer)
        .json(&modern_body("tools/list", json!({})))
        .send()
        .await
        .expect("tools/list");
    assert_eq!(response.status().as_u16(), 200);
    let value: Value = response.json().await.expect("body");
    value["result"]["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .any(|tool| tool["name"] == TOOL)
}

async fn rest(w: &World, method: reqwest::Method, bearer: &str, path: &str) -> (u16, Value) {
    let response = client()
        .request(method, format!("{}{path}", w.base))
        .bearer_auth(bearer)
        .send()
        .await
        .expect("rest");
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

fn grant_path(t: &Tenant) -> String {
    format!(
        "/v1/workspaces/{}/agents/{}/expression-grant",
        t.ws, t.a.member
    )
}

async fn give(w: &World, t: &Tenant) {
    let (status, body) = rest(w, reqwest::Method::PUT, &t.admin.jwt, &grant_path(t)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["granted"], json!(true));
}

fn png(w: u32, h: u32) -> Vec<u8> {
    let image = image::RgbaImage::from_fn(w, h, |x, y| image::Rgba([x as u8, y as u8, 90, 255]));
    let mut out = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut out, image::ImageFormat::Png)
        .unwrap();
    out.into_inner()
}

fn args(name: &str) -> Value {
    json!({
        "clientRequestId": Uuid::new_v4(),
        "name": name,
        "displayName": "웃는 별",
        "tags": ["별"],
        "image": {
            "source": "generated",
            "mime": "image/png",
            "dataBase64": base64::engine::general_purpose::STANDARD.encode(png(96, 96)),
            "prompt": format!("{PROMPT_MARK} 웃는 별"),
        }
    })
}

fn code(body: &Value) -> Option<String> {
    body["error"]["data"]["code"].as_str().map(str::to_string)
}

async fn count(w: &World, sql: &str, ids: &[Uuid]) -> i64 {
    let mut query = sqlx::query_scalar::<_, i64>(sql);
    for id in ids {
        query = query.bind(*id);
    }
    query
        .fetch_one(&w.su)
        .await
        .unwrap_or_else(|error| panic!("{sql}: {error}"))
}

async fn expressions(w: &World, t: &Tenant) -> i64 {
    count(
        w,
        "SELECT count(*) FROM expression WHERE workspace_id = $1",
        &[t.ws],
    )
    .await
}

async fn images(w: &World, t: &Tenant) -> i64 {
    count(
        w,
        "SELECT count(*) FROM expression_image WHERE workspace_id = $1",
        &[t.ws],
    )
    .await
}

async fn audit_reasons(w: &World, t: &Tenant) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT detail->>'reason' FROM audit_log WHERE workspace_id = $1 \
            AND action = 'expression.self.refused' ORDER BY created_at",
    )
    .bind(t.ws)
    .fetch_all(&w.su)
    .await
    .expect("audit")
}

/// Seed `n` call rows for the agent with a past `created_at`, as the superuser (the window boundaries
/// are measured without `n` decodes).
async fn seed_calls(w: &World, t: &Tenant, n: usize, outcome: &str, age: &str) {
    let grant: Uuid = sqlx::query_scalar(
        "SELECT id FROM expression_agent_grant WHERE workspace_id = $1 AND agent_member_id = $2 AND revoked_at IS NULL",
    )
    .bind(t.ws)
    .bind(t.a.member)
    .fetch_one(&w.su)
    .await
    .expect("a live grant");
    for _ in 0..n {
        let expression = (outcome == "registered").then(Uuid::new_v4);
        sqlx::query(&format!(
            "INSERT INTO expression_agent_call(workspace_id, agent_member_id, grant_id, client_request_id, \
                 created_at, decoded, outcome, reason, expression_id, settled_at) \
             VALUES($1, $2, $3, $4, clock_timestamp() - interval '{age}', true, $5, \
                    CASE WHEN $5 = 'refused' THEN 'media_invalid' END, $6, clock_timestamp())"
        ))
        .bind(t.ws)
        .bind(t.a.member)
        .bind(grant)
        .bind(Uuid::new_v4())
        .bind(outcome)
        .bind(expression)
        .execute(&w.su)
        .await
        .expect("seed call");
    }
}

/// Move the agent's call rows back in time (the record is immutable to the api; the superuser lifts the
/// guard for the fixture only).
async fn age_calls(w: &World, t: &Tenant, to: &str) {
    exec(
        &w.su,
        "ALTER TABLE expression_agent_call DISABLE TRIGGER expression_agent_call_guard",
        &[],
    )
    .await;
    exec(
        &w.su,
        &format!("UPDATE expression_agent_call SET created_at = {to} WHERE workspace_id = $1"),
        &[t.ws],
    )
    .await;
    exec(
        &w.su,
        "ALTER TABLE expression_agent_call ENABLE TRIGGER expression_agent_call_guard",
        &[],
    )
    .await;
}

// --- tests --------------------------------------------------------------------

/// YA1 · YA4 · YA9 · YA13 · YA14: no grant, no tool and no row; one grant, one row that says the person
/// approved and the agent proposed; the same request id again is the first answer; no message, no seq;
/// the audit and the call record hold no name, prompt or bytes.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_granted_agent_registers_once_and_the_row_says_who() {
    let _gate = GATE.lock().await;
    let w = boot(media::RenditionTable::Wide).await;
    let t = seed(&w.su).await;

    // YA1: before any grant — not listed, one closed answer, nothing written.
    assert!(!listed(&w, &t.a.bearer).await);
    let (status, body) = call(&w, &t.a.bearer, args("star-one")).await;
    assert_eq!(
        (status, code(&body).as_deref()),
        (403, Some("not_allowed")),
        "{body}"
    );
    assert_eq!(expressions(&w, &t).await, 0);
    assert_eq!(images(&w, &t).await, 0);
    assert_eq!(audit_reasons(&w, &t).await, ["no_grant"]);

    give(&w, &t).await;
    assert!(listed(&w, &t.a.bearer).await);
    let seq_before = count(
        &w,
        "SELECT last_seq FROM channel_seq WHERE workspace_id = $1",
        &[t.ws],
    )
    .await;
    let messages_before = count(
        &w,
        "SELECT count(*) FROM message WHERE workspace_id = $1",
        &[t.ws],
    )
    .await;
    let children = media::decoder_children_started();
    let request = args("star-one");
    let (status, body) = call(&w, &t.a.bearer, request.clone()).await;
    assert_eq!(status, 200, "{body}");
    assert!(
        media::decoder_children_started() > children,
        "the picture went through the decoder"
    );
    let id: Uuid = body["result"]["structuredContent"]["expressionId"]
        .as_str()
        .expect("an id")
        .parse()
        .unwrap();
    // YA4: the row
    let row = sqlx::query(
        "SELECT created_by, proposed_by, grant_id IS NOT NULL AS granted, approval_id IS NULL AS no_card FROM expression \
          WHERE workspace_id = $1 AND id = $2",
    )
    .bind(t.ws)
    .bind(id)
    .fetch_one(&w.su)
    .await
    .expect("the row");
    use momo_db::sqlx::Row;
    assert_eq!(row.get::<Uuid, _>("created_by"), t.admin.member);
    assert_eq!(row.get::<Uuid, _>("proposed_by"), t.a.member);
    assert!(row.get::<bool, _>("granted"));
    assert!(row.get::<bool, _>("no_card"));
    // YA4: the list carries the two keys while the setting is on
    let (status, list) = rest(
        &w,
        reqwest::Method::GET,
        &t.member.jwt,
        &format!("/v1/workspaces/{}/expressions", t.ws),
    )
    .await;
    assert_eq!(status, 200, "{list}");
    let item = list["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == json!(id))
        .expect("listed")
        .clone();
    assert_eq!(item["proposedBy"], json!(t.a.member));
    assert_eq!(item["selfRegistered"], json!(true));
    assert_eq!(item["createdBy"], json!(t.admin.member));
    // YA9: the same request id again
    let (status, again) = call(&w, &t.a.bearer, request).await;
    assert_eq!(status, 200, "{again}");
    assert_eq!(
        again["result"]["structuredContent"]["expressionId"],
        json!(id)
    );
    assert_eq!(expressions(&w, &t).await, 1);
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM expression_agent_call WHERE workspace_id = $1",
            &[t.ws]
        )
        .await,
        1
    );
    // YA13: no message, no seq
    assert_eq!(
        count(
            &w,
            "SELECT last_seq FROM channel_seq WHERE workspace_id = $1",
            &[t.ws]
        )
        .await,
        seq_before
    );
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM message WHERE workspace_id = $1",
            &[t.ws]
        )
        .await,
        messages_before
    );
    // YA14: no name, prompt or bytes in the audit or the call record
    let audit: Vec<String> = sqlx::query_scalar(
        "SELECT detail::text FROM audit_log WHERE workspace_id = $1 AND action LIKE 'expression.%'",
    )
    .bind(t.ws)
    .fetch_all(&w.su)
    .await
    .unwrap();
    assert!(audit.len() >= 3, "{audit:?}");
    for detail in &audit {
        assert!(
            !detail.contains(PROMPT_MARK)
                && !detail.contains("star-one")
                && !detail.contains("iVBOR"),
            "{detail}"
        );
    }
    let record: String = sqlx::query_scalar(
        "SELECT to_jsonb(c)::text FROM expression_agent_call c WHERE workspace_id = $1",
    )
    .bind(t.ws)
    .fetch_one(&w.su)
    .await
    .unwrap();
    assert!(
        !record.contains(PROMPT_MARK) && !record.contains("star-one"),
        "{record}"
    );
}

/// YA3 · YA18: each way of closing the door closes the next call (nothing written), and with the server
/// setting off the door is closed, the tool is unlisted and the answers carry neither key.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn every_closed_door_closes_the_next_call() {
    let _gate = GATE.lock().await;
    let w = boot(media::RenditionTable::Wide).await;

    type Close = fn(&Tenant) -> (String, Vec<Uuid>);
    let cases: [(&str, Close); 5] = [
        ("switch_off", |t| {
            ("UPDATE workspace SET settings = settings || '{\"agent_self_expressions\": false}'::jsonb WHERE id = $1".into(), vec![t.ws])
        }),
        ("no_grant", |t| {
            ("UPDATE expression_agent_grant SET revoked_by = $2, revoked_at = clock_timestamp() WHERE workspace_id = $1 AND revoked_at IS NULL".into(), vec![t.ws, t.admin.member])
        }),
        ("agent_paused", |t| {
            ("UPDATE agent_profile SET paused = true WHERE workspace_id = $1 AND agent_member_id = $2".into(), vec![t.ws, t.a.member])
        }),
        ("connection_mismatch", |t| {
            (
                "UPDATE expression_agent_grant SET connection_id = $2 WHERE workspace_id = $1"
                    .into(),
                vec![t.ws, Uuid::new_v4()],
            )
        }),
        ("granter_invalid", |t| {
            ("UPDATE workspace_membership SET role = 'member' WHERE workspace_id = $1 AND member_id = $2".into(), vec![t.ws, t.admin.member])
        }),
    ];
    for (reason, close) in cases {
        let t = seed(&w.su).await;
        give(&w, &t).await;
        let (status, body) = call(&w, &t.a.bearer, args("first-one")).await;
        assert_eq!(status, 200, "{reason}: {body}");
        let (sql, ids) = close(&t);
        if reason == "connection_mismatch" {
            // the grant row is immutable to the api; the superuser bypasses the trigger for the fixture
            exec(
                &w.su,
                "ALTER TABLE expression_agent_grant DISABLE TRIGGER expression_agent_grant_guard",
                &[],
            )
            .await;
            exec(&w.su, &sql, &ids).await;
            exec(
                &w.su,
                "ALTER TABLE expression_agent_grant ENABLE TRIGGER expression_agent_grant_guard",
                &[],
            )
            .await;
        } else {
            exec(&w.su, &sql, &ids).await;
        }
        let before = expressions(&w, &t).await;
        let (status, body) = call(&w, &t.a.bearer, args("second-one")).await;
        if reason == "agent_paused" {
            // a paused agent has no live connection at all: every tool is gone
            assert_ne!(status, 200, "{reason}: {body}");
        } else {
            assert_eq!(
                (status, code(&body).as_deref()),
                (403, Some("not_allowed")),
                "{reason}: {body}"
            );
            assert!(
                audit_reasons(&w, &t).await.contains(&reason.to_string()),
                "{reason}"
            );
            assert!(!listed(&w, &t.a.bearer).await, "{reason}: still listed");
        }
        assert_eq!(
            expressions(&w, &t).await,
            before,
            "{reason}: a row was written"
        );
    }

    // YA18: the server setting off (the old table) — the same grant, no door, no keys.
    let t = seed(&w.su).await;
    give(&w, &t).await;
    let (status, _) = call(&w, &t.a.bearer, args("while-on")).await;
    assert_eq!(status, 200);
    let off = boot(media::RenditionTable::Legacy).await;
    assert!(!listed(&off, &t.a.bearer).await);
    let (status, body) = call(&off, &t.a.bearer, args("while-off")).await;
    assert_eq!(
        (status, code(&body).as_deref()),
        (403, Some("not_allowed")),
        "{body}"
    );
    assert!(audit_reasons(&w, &t)
        .await
        .contains(&"server_setting_off".to_string()));
    assert_eq!(expressions(&w, &t).await, 1);
    let (_, list) = rest(
        &off,
        reqwest::Method::GET,
        &t.member.jwt,
        &format!("/v1/workspaces/{}/expressions", t.ws),
    )
    .await;
    let text = list.to_string();
    assert!(
        !text.contains("proposedBy") && !text.contains("selfRegistered"),
        "{text}"
    );
    let (_, list) = rest(
        &w,
        reqwest::Method::GET,
        &t.member.jwt,
        &format!("/v1/workspaces/{}/expressions", t.ws),
    )
    .await;
    assert!(list.to_string().contains("selfRegistered"));
}

/// YA2 · YA12 · YA16 · YA19: the day's two, the day's six attempts (the seventh never reaches the
/// decoder), the 30 days' twenty (deleted ones still count, an old one does not) and the store of fifty.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn the_ceilings_are_judged_before_the_decoder_and_again_after() {
    let _gate = GATE.lock().await;
    let w = boot(media::RenditionTable::Wide).await;

    // YA2: two pass, the third is daily_cap and writes nothing.
    let t = seed(&w.su).await;
    give(&w, &t).await;
    for name in ["day-one", "day-two"] {
        let (status, body) = call(&w, &t.a.bearer, args(name)).await;
        assert_eq!(status, 200, "{body}");
    }
    let (status, body) = call(&w, &t.a.bearer, args("day-three")).await;
    assert_eq!(
        (status, code(&body).as_deref()),
        (409, Some("daily_cap")),
        "{body}"
    );
    assert_eq!(expressions(&w, &t).await, 2);
    // a day later the window has moved (the two registrations are now 25 hours old)
    age_calls(&w, &t, "created_at - interval '25 hours'").await;
    let (status, body) = call(&w, &t.a.bearer, args("day-four")).await;
    assert_eq!(status, 200, "{body}");

    // YA16: six attempts reached the decoder today (all refused pictures) — the seventh is attempt_cap
    // and starts no decoder child.
    let t = seed(&w.su).await;
    give(&w, &t).await;
    seed_calls(&w, &t, 5, "refused", "1 hour").await;
    let children = media::decoder_children_started();
    let (status, body) = call(&w, &t.a.bearer, args("sixth-try")).await;
    assert_eq!(status, 200, "the sixth attempt reaches the decoder: {body}");
    assert!(media::decoder_children_started() > children);
    let children = media::decoder_children_started();
    let (status, body) = call(&w, &t.a.bearer, args("seventh-try")).await;
    assert_eq!(
        (status, code(&body).as_deref()),
        (409, Some("attempt_cap")),
        "{body}"
    );
    assert_eq!(
        media::decoder_children_started(),
        children,
        "the seventh never reached the decoder"
    );

    // YA19: twenty in the last 30 days (two days old, so the day's cap is not what refuses), all deleted
    // or not — the twenty-first is period_cap; once they are 31 days old it passes.
    let t = seed(&w.su).await;
    give(&w, &t).await;
    seed_calls(&w, &t, 20, "registered", "2 days").await;
    let (status, body) = call(&w, &t.a.bearer, args("period-21")).await;
    assert_eq!(
        (status, code(&body).as_deref()),
        (409, Some("period_cap")),
        "{body}"
    );
    age_calls(&w, &t, "clock_timestamp() - interval '31 days'").await;
    let (status, body) = call(&w, &t.a.bearer, args("period-ok")).await;
    assert_eq!(status, 200, "{body}");

    // YA12: fifty self-registered expressions of this agent (active or hidden) — the next is store_cap.
    let t = seed(&w.su).await;
    give(&w, &t).await;
    let grant: Uuid =
        sqlx::query_scalar("SELECT id FROM expression_agent_grant WHERE workspace_id = $1")
            .bind(t.ws)
            .fetch_one(&w.su)
            .await
            .unwrap();
    for n in 0..50 {
        sqlx::query(
            "INSERT INTO expression(workspace_id, name, display_name, tags, origin, created_by, proposed_by, grant_id, version, kind, status) \
             VALUES($1, $2, '별', '[]'::jsonb, '{\"kind\":\"generated\",\"sourceUrl\":null,\"prompt\":null}'::jsonb, $3, $4, $5, $6, 'emoji', \
                    CASE WHEN $6 % 2 = 0 THEN 'active' ELSE 'hidden' END)",
        )
        .bind(t.ws)
        .bind(format!("seeded-{n}"))
        .bind(t.admin.member)
        .bind(t.a.member)
        .bind(grant)
        .bind(n as i64 + 1)
        .execute(&w.su)
        .await
        .expect("seed expression");
    }
    let (status, body) = call(&w, &t.a.bearer, args("store-51")).await;
    assert_eq!(
        (status, code(&body).as_deref()),
        (409, Some("store_cap")),
        "{body}"
    );
    assert_eq!(expressions(&w, &t).await, 50);
}

/// YA5 · YA8 · YA20: the grant routes refuse an agent bearer and a plain member; the owner reads its own
/// agent; deleting a self-registered expression is the approving person's or an administrator's.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn only_a_persons_session_reaches_the_grant() {
    let _gate = GATE.lock().await;
    let w = boot(media::RenditionTable::Wide).await;
    let t = seed(&w.su).await;
    let path = grant_path(&t);
    let list_path = format!("/v1/workspaces/{}/expression-grants", t.ws);
    for method in [
        reqwest::Method::PUT,
        reqwest::Method::GET,
        reqwest::Method::DELETE,
    ] {
        let (status, _) = rest(&w, method.clone(), &t.a.bearer, &path).await;
        assert_eq!(status, 403, "agent bearer {method}");
    }
    let (status, _) = rest(&w, reqwest::Method::GET, &t.a.bearer, &list_path).await;
    assert_eq!(status, 403);
    // a plain member who owns no agent
    let (status, _) = rest(&w, reqwest::Method::PUT, &t.member.jwt, &path).await;
    assert_eq!(status, 403);
    let (status, _) = rest(&w, reqwest::Method::GET, &t.member.jwt, &path).await;
    assert_eq!(status, 403);
    let (status, _) = rest(&w, reqwest::Method::GET, &t.member.jwt, &list_path).await;
    assert_eq!(status, 403);
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM expression_agent_grant WHERE workspace_id = $1",
            &[t.ws]
        )
        .await,
        0
    );

    give(&w, &t).await;
    let (status, read) = rest(&w, reqwest::Method::GET, &t.admin.jwt, &path).await;
    assert_eq!(status, 200, "{read}");
    assert_eq!(read["remaining"], json!({"today": 2, "period": 20}));
    let (status, all) = rest(&w, reqwest::Method::GET, &t.admin.jwt, &list_path).await;
    assert_eq!(
        (status, all["items"].as_array().map(Vec::len)),
        (200, Some(1))
    );

    // YA8: delete — the agent and a plain member 403, the approving person 200
    let (status, body) = call(&w, &t.a.bearer, args("to-delete")).await;
    assert_eq!(status, 200, "{body}");
    let id = body["result"]["structuredContent"]["expressionId"]
        .as_str()
        .unwrap()
        .to_string();
    let delete = format!("/v1/workspaces/{}/expressions/{id}", t.ws);
    assert_eq!(
        rest(&w, reqwest::Method::DELETE, &t.a.bearer, &delete)
            .await
            .0,
        403
    );
    assert_eq!(
        rest(&w, reqwest::Method::DELETE, &t.member.jwt, &delete)
            .await
            .0,
        403
    );
    assert_eq!(
        rest(&w, reqwest::Method::DELETE, &t.admin.jwt, &delete)
            .await
            .0,
        200
    );

    // revoking: the plain member may not, the owner (here the admin) may; the row stays as a record
    let (status, _) = rest(&w, reqwest::Method::DELETE, &t.member.jwt, &path).await;
    assert_eq!(status, 403);
    let (status, after) = rest(&w, reqwest::Method::DELETE, &t.admin.jwt, &path).await;
    assert_eq!((status, &after["granted"]), (200, &json!(false)));
    assert_eq!(count(&w, "SELECT count(*) FROM expression_agent_grant WHERE workspace_id = $1 AND revoked_at IS NOT NULL", &[t.ws]).await, 1);
    // the DB refuses a grant given by a plain member even past the app
    let refused = sqlx::query(
        "INSERT INTO expression_agent_grant(workspace_id, agent_member_id, granted_by, connection_id, granted_via) VALUES($1,$2,$3,$4,'settings')",
    )
    .bind(t.ws)
    .bind(t.a.member)
    .bind(t.member.member)
    .bind(t.a.connection)
    .execute(&w.su)
    .await;
    assert!(
        refused.is_err(),
        "the trigger refuses a non-administrator's grant"
    );
}

/// YA6 · YA7: a picture that is not `generated`, a face, a source attachment, a bad name — argument errors,
/// nothing counted, nothing written; a reserved standard name is the library's own refusal.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_picture_that_is_not_generated_is_an_argument_error() {
    let _gate = GATE.lock().await;
    let w = boot(media::RenditionTable::Wide).await;
    let t = seed(&w.su).await;
    give(&w, &t).await;
    let mut cases = Vec::new();
    let mut url = args("by-url");
    url["image"] = json!({"source": "url", "url": "https://example.test/a.png"});
    cases.push(("url", url));
    let mut attachment = args("by-attachment");
    attachment["image"] = json!({"source": "attachment", "attachmentId": Uuid::new_v4()});
    cases.push(("attachment", attachment));
    let mut face = args("with-face");
    face["subjectMemberId"] = json!(t.admin.member);
    cases.push(("subjectMemberId", face));
    let mut source = args("with-source");
    source["image"]["sourceAttachmentId"] = json!(Uuid::new_v4());
    cases.push(("sourceAttachmentId", source));
    cases.push(("bad name", args("Bad Name")));
    for (what, arguments) in cases {
        let (status, body) = call(&w, &t.a.bearer, arguments).await;
        assert_eq!(status, 400, "{what}: {body}");
    }
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM expression_agent_call WHERE workspace_id = $1",
            &[t.ws]
        )
        .await,
        0
    );
    let mut not_a_picture = args("not-picture");
    not_a_picture["image"]["dataBase64"] =
        json!(base64::engine::general_purpose::STANDARD.encode(b"<html>not a picture</html>"));
    let (status, body) = call(&w, &t.a.bearer, not_a_picture).await;
    assert_eq!(
        (status, code(&body).as_deref()),
        (400, Some("expression_media_invalid")),
        "{body}"
    );
    let (status, body) = call(&w, &t.a.bearer, args("smile")).await;
    assert_eq!(
        (status, code(&body).as_deref()),
        (409, Some("expression_name_reserved")),
        "{body}"
    );
    assert_eq!(expressions(&w, &t).await, 0);
    let _ = NAME_MARK;
}

/// Y2.1 「쓰기 권한은 사람 세션이 쓰는 역할에만」: after the bootstrap, only `momo_app` holds anything on the
/// two tables (grants without DELETE).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn only_the_api_holds_the_grant_tables() {
    let _gate = GATE.lock().await;
    let w = boot(media::RenditionTable::Legacy).await;
    let drift: Vec<String> = sqlx::query_scalar(
        "SELECT format('%s:%s:%s has=%s', r.rolname, c.relname, p.priv, has_table_privilege(r.rolname, c.oid, p.priv)) \
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
           CROSS JOIN (SELECT rolname FROM pg_roles WHERE rolname IN ('momo_app', 'momo_relay', 'momo_worker', \
                       'momo_notifier', 'momo_platform_admin', 'momo_helper_read', 'momo_memory')) AS r \
           CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv) \
          WHERE n.nspname = 'public' AND c.relname IN ('expression_agent_grant', 'expression_agent_call') \
            AND has_table_privilege(r.rolname, c.oid, p.priv) IS DISTINCT FROM ( \
                r.rolname = 'momo_app' AND (p.priv IN ('SELECT', 'INSERT', 'UPDATE') \
                  OR (p.priv = 'DELETE' AND c.relname = 'expression_agent_call'))) \
          ORDER BY 1",
    )
    .fetch_all(&w.su)
    .await
    .expect("privilege scan");
    let tables: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_class WHERE relname IN ('expression_agent_grant', 'expression_agent_call')",
    )
    .fetch_one(&w.su)
    .await
    .unwrap();
    assert_eq!(tables, 2, "the scan must see both tables");
    assert!(drift.is_empty(), "{drift:?}");
}

/// YA21 (ADR-0162 증보 8 RA8 · R6 3): an expression registered without a card is not in the names an agent
/// may react with; the same workspace's card-less-free registration is.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_self_registered_expression_is_not_an_agents_reaction() {
    let _gate = GATE.lock().await;
    let w = boot(media::RenditionTable::Wide).await;
    let t = seed(&w.su).await;
    give(&w, &t).await;
    let (status, body) = call(&w, &t.a.bearer, args("self-made")).await;
    assert_eq!(status, 200, "{body}");
    sqlx::query(
        "INSERT INTO expression(workspace_id, name, display_name, tags, origin, created_by, version, kind) \
         VALUES($1, 'person-made', '별', '[]'::jsonb, '{\"kind\":\"upload\",\"sourceUrl\":null,\"prompt\":null}'::jsonb, $2, 99, 'emoji')",
    )
    .bind(t.ws)
    .bind(t.admin.member)
    .execute(&w.su)
    .await
    .expect("a person's expression");
    let app = pool_as("momo_app", "MOMO_APP_PASSWORD", "momo_app_dev_pw", 2).await;
    let ws = t.ws;
    let (names, _) = momo_db::with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move {
            momo_messaging::agent_reaction::agent_expression_names_in_tx(conn, ws).await
        })
    })
    .await
    .expect("names");
    assert!(names.iter().any(|name| name == "person-made"), "{names:?}");
    assert!(!names.iter().any(|name| name == "self-made"), "{names:?}");
}

/// A noise PNG: incompressible, so its base64 is well past the 64 KiB ceiling and under 1 MiB decoded.
fn noise_png(side: u32) -> Vec<u8> {
    let mut seed: u32 = 0x6069_2026;
    let image = image::RgbaImage::from_fn(side, side, |_, _| {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        let [a, b, c, _] = seed.to_le_bytes();
        image::Rgba([a, b, c, 255])
    });
    let mut out = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut out, image::ImageFormat::Png)
        .unwrap();
    out.into_inner()
}

/// A `tools/call` head of `oort_expression_register` announcing `declared` bytes, then only `sent` of them,
/// reading the answer meanwhile. `None`: no answer within `patience` — the server is waiting for the rest.
async fn register_head_then_part(
    addr: SocketAddr,
    bearer: &str,
    declared: usize,
    sent: usize,
    patience: std::time::Duration,
) -> Option<u16> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let socket = tokio::net::TcpStream::connect(addr).await.expect("connect");
    let (mut reader, mut writer) = socket.into_split();
    let head = format!(
        "POST {MCP_PATH} HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\n\
         Accept: application/json, text/event-stream\r\nMCP-Protocol-Version: {MODERN_VERSION}\r\n\
         Mcp-Method: tools/call\r\nMcp-Name: {TOOL}\r\nAuthorization: Bearer {bearer}\r\n\
         Content-Length: {declared}\r\n\r\n"
    );
    let sender = tokio::spawn(async move {
        if writer.write_all(head.as_bytes()).await.is_err() {
            return;
        }
        let _ = writer.write_all(&vec![b' '; sent]).await;
        std::future::pending::<()>().await;
    });
    let mut received = Vec::new();
    let _ = tokio::time::timeout(patience, async {
        let mut buffer = [0u8; 4096];
        loop {
            let n = reader.read(&mut buffer).await.unwrap_or(0);
            if n == 0 {
                break;
            }
            received.extend_from_slice(&buffer[..n]);
            if received.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
    })
    .await;
    sender.abort();
    let line = String::from_utf8_lossy(&received)
        .lines()
        .next()?
        .to_string();
    line.split_whitespace().nth(1)?.parse().ok()
}

/// Y2.2 「인증 · scope · 승인 기록을 큰 본문을 읽기 전에」: a real picture past 64 KiB registers through an open
/// door (200), the same body to a closed door is 413 with nothing written, and a closed door answers while
/// only 100 KiB of an announced 1.5 MiB has arrived — the rest is never waited for — where an open door
/// waits for the body it is allowed to read.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn the_big_body_is_read_only_through_an_open_door() {
    let _gate = GATE.lock().await;
    let w = boot(media::RenditionTable::Wide).await;
    let open = seed(&w.su).await;
    give(&w, &open).await;
    let closed = seed(&w.su).await;

    let picture = noise_png(300);
    let mut big = args("big-one");
    big["image"]["dataBase64"] = json!(base64::engine::general_purpose::STANDARD.encode(&picture));
    let body = serde_json::to_vec(&modern_body(
        "tools/call",
        json!({"name": TOOL, "arguments": big.clone()}),
    ))
    .unwrap();
    assert!(
        body.len() > 64 * 1024 && picture.len() <= 1024 * 1024,
        "the case is past the standard ceiling and within the picture limit: body {} picture {}",
        body.len(),
        picture.len()
    );

    let (status, value) = call(&w, &open.a.bearer, big.clone()).await;
    assert_eq!(status, 200, "{value}");
    assert_eq!(expressions(&w, &open).await, 1);

    let (status, value) = call(&w, &closed.a.bearer, big).await;
    assert_eq!(status, 413, "{value}");
    assert_eq!(expressions(&w, &closed).await, 0);
    assert_eq!(
        count(
            &w,
            "SELECT count(*) FROM expression_agent_call WHERE workspace_id = $1",
            &[closed.ws]
        )
        .await,
        0
    );

    let declared = 1536 * 1024;
    let sent = 100 * 1024;
    let answered = register_head_then_part(
        w.addr,
        &closed.a.bearer,
        declared,
        sent,
        std::time::Duration::from_secs(5),
    )
    .await;
    assert_eq!(
        answered,
        Some(413),
        "a closed door answers before the body has arrived"
    );
    let waited = register_head_then_part(
        w.addr,
        &open.a.bearer,
        declared,
        sent,
        std::time::Duration::from_secs(3),
    )
    .await;
    assert_eq!(waited, None, "an open door waits for the body it may read");
}
