//! #1166 — the reload closure for ADR-0155's defensive render.
//!
//! ## The hole this file closes
//!
//! ADR-0155 결정 3 says a half-written answer whose closing PATCH never landed
//! must still draw the same 「응답이 끊김」 tail, because the run's terminal state
//! is durable even when the message's `outcome` is missing. #1165 shipped that
//! as a **session-local** judgement: `endedRuns` holds the runs whose terminal
//! `agent.status` frame this tab watched arrive. A tab opened afterwards — a
//! reload, another device, a history reader — watched nothing, so on the
//! second failure of a double failure the half answer wears a finished answer's
//! clothes. That is exactly the lie option C was rejected for, surviving in the
//! one corner nobody could reach from the client.
//!
//! So the page read answers it. This file is the proof, over the real router,
//! the real Postgres and the real RLS policies:
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `a_reload_learns_the_run_ended_from_the_page_itself` | drop the enclosure — the reader is left with a row that says `streaming: true` and nothing else, which is the pre-#1166 lie verbatim |
//! | `a_run_that_has_not_ended_is_never_announced_as_ended` | widen the verdict past [`RunStatus::is_terminal`] (queued/running/awaiting_approval/paused) — every answer still arriving gets a tail |
//! | `a_closed_stream_asks_no_questions_about_its_run` | let the enclosure answer for closed streams too; the message's own `outcome` is then contradictable by a route |
//! | `a_run_id_from_another_workspace_is_not_answered` | drop the workspace predicate — a page read becomes a cross-tenant run-status oracle for anyone who can post |
//! | `the_thread_page_carries_the_same_verdict` | wire only history; a message then says two different things depending on which page a reader arrived through |
//! | `a_write_never_answers_about_a_run` | put the verdict on the send/edit echo; the write path grows a read it does not need |
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test run_terminal_backfill_conformance_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Harness contract is `stream_edit_conformance_pg.rs`'s: `DATABASE_URL`
//! connects as a **superuser** (migrations + `infra/e2e/bootstrap_roles.sql`,
//! fixture seeding bypasses RLS) while the server runs on the runtime
//! **`momo_app`** role (`NOBYPASSRLS`), so every assertion is made through the
//! policies production uses.
//!
//! ## Why the producer here is the domain crate and not two HTTP calls
//!
//! The half-written row this suite reads has to be authored by an **agent** and
//! carry `props.run_id` — the shape `MessageStream::open` writes
//! (`momo-agent-worker/src/stream.rs`, `opening_props`). An agent has no
//! password to log in with, so the opening write is made through the same
//! `momo_messaging` calls that producer makes, inside the same tenant
//! transaction, on the same `momo_app` pool. Everything the tests then assert
//! about — the page, its verdict, the policies it is read under — is reached
//! over HTTP.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_messaging::{
    create_channel, opening_stream_props, send_message_in_tx, stream_message_body_in_tx,
    ChannelKind, MessageType, NewChannel, NewMessage, StreamEdit, STREAM_PROPS_KEY,
};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET: &str = "run-terminal-backfill-conformance-secret";
const TEST_PASSWORD: &str = "run-terminal-backfill-password";
const AGENT_MODEL: &str = "hermes-agent";

/// The body the agent got halfway through. Kept mid-sentence on purpose: every
/// claim here is about a reader being told that this is where it stops.
const HALF_ANSWER: &str = "그 파일을 열어 보면 첫 줄에";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn momo_app_password() -> String {
    std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string())
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect to conformance DB as superuser")
}

async fn momo_app_pool() -> PgPool {
    let opts: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    let opts = opts.username("momo_app").password(&momo_app_password());
    PgPoolOptions::new()
        .max_connections(16)
        .connect_with(opts)
        .await
        .expect("connect as momo_app (run bootstrap_roles.sql first)")
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
    panic!("psql client not found on PATH or Homebrew libpq locations");
}

fn bootstrap_roles_path() -> PathBuf {
    PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/e2e/bootstrap_roles.sql"
    ))
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply every migration on the conformance DB");
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(bootstrap_roles_path())
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
    *ready = true;
}

async fn start_server(pool: PgPool) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    );
    let app = build_app(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind momo-server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{address}")
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

struct Tenant {
    workspace: Uuid,
    email: String,
    channel: Uuid,
    agent: Uuid,
}

async fn seed_tenant(su: &PgPool, app: &PgPool) -> Tenant {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(workspace.to_string())
        .execute(su)
        .await
        .expect("seed workspace");

    let human = Uuid::new_v4();
    let email = format!("{human}@backfill.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(human)
    .bind(workspace)
    .bind(human.to_string())
    .execute(su)
    .await
    .expect("seed human member");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, password_hash) \
         VALUES ($1, $2, $3, momo_password_hash($4))",
    )
    .bind(human)
    .bind(workspace)
    .bind(&email)
    .bind(TEST_PASSWORD)
    .execute(su)
    .await
    .expect("seed human auth");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'owner'::membership_role)",
    )
    .bind(workspace)
    .bind(human)
    .execute(su)
    .await
    .expect("seed workspace membership");

    let channel = create_channel(
        app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("backfill-{}", &Uuid::new_v4().simple().to_string()[..8]),
            topic: None,
            created_by: human,
        },
    )
    .await
    .expect("create channel")
    .id;

    let agent = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', $3, $3)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(format!("agent-{}", &agent.simple().to_string()[..8]))
    .execute(su)
    .await
    .expect("seed agent member");
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, \
                            max_concurrent_runs, max_run_steps, owner_human_id) \
         VALUES ($1, $2, $3, 'https://gateway.invalid/v1', 4, 50, $4)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(AGENT_MODEL)
    .bind(human)
    .execute(su)
    .await
    .expect("seed agent");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'member'::membership_role)",
    )
    .bind(workspace)
    .bind(agent)
    .execute(su)
    .await
    .expect("seed agent workspace membership");
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'member'::membership_role) \
         ON CONFLICT (channel_id, member_id) DO NOTHING",
    )
    .bind(workspace)
    .bind(channel)
    .bind(agent)
    .execute(su)
    .await
    .expect("seed agent channel membership");

    Tenant {
        workspace,
        email,
        channel,
        agent,
    }
}

/// A run in an arbitrary status. Seeded directly because this suite is about
/// the read, and every status the verdict must distinguish has to be reachable.
async fn seed_run(su: &PgPool, tenant: &Tenant, status: &str) -> Uuid {
    let run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run \
           (id, workspace_id, agent_member_id, channel_id, status, input, idempotency_key) \
         VALUES ($1, $2, $3, $4, $5::run_status, $6, $7)",
    )
    .bind(run)
    .bind(tenant.workspace)
    .bind(tenant.agent)
    .bind(tenant.channel)
    .bind(status)
    .bind(json!({"type": "work", "title": "1166", "brief": "1166"}))
    .bind(format!("t1166:{run}"))
    .execute(su)
    .await
    .expect("seed agent run");
    run
}

/// The opening write of a streaming turn, verbatim in the shape
/// `MessageStream::open` produces: the turn's props plus `run_id` plus the
/// `momo.stream` marker, with the run id doubling as the idempotency key.
///
/// `reply_to_id` optional so the thread test can hang one under a root.
async fn open_stream(
    app: &PgPool,
    tenant: &Tenant,
    run: Uuid,
    reply_to_id: Option<Uuid>,
    root_id: Option<Uuid>,
) -> Uuid {
    let props = json!({
        "source": "agent_worker.final_text.v0",
        "run_id": run,
        STREAM_PROPS_KEY.to_string(): opening_stream_props(),
    });
    let workspace = tenant.workspace;
    let input = NewMessage {
        channel_id: tenant.channel,
        author_member_id: tenant.agent,
        message_type: MessageType::Text,
        body: Some(HALF_ANSWER.to_string()),
        props,
        root_id,
        reply_to_id,
        client_msg_id: Some(run),
        run_id: Some(run),
        hlc_ts: None,
        hlc_count: None,
    };
    with_tenant_tx(app, workspace, move |conn| {
        Box::pin(async move { send_message_in_tx(conn, workspace, input).await })
    })
    .await
    .expect("open the streamed message")
    .message
    .id
}

/// One more slice, `final: false` — the state a turn is left in when the
/// closing PATCH never lands. Nothing after this ever writes `outcome`.
async fn grow_stream(app: &PgPool, tenant: &Tenant, message_id: Uuid, rev: i64) {
    let workspace = tenant.workspace;
    let author = tenant.agent;
    with_tenant_tx(app, workspace, move |conn| {
        Box::pin(async move {
            let outcome = stream_message_body_in_tx(
                conn,
                workspace,
                message_id,
                author,
                HALF_ANSWER,
                StreamEdit {
                    rev,
                    is_final: false,
                    outcome: None,
                },
            )
            .await?;
            assert!(outcome.is_ok(), "the slice was refused: {outcome:?}");
            Ok::<_, DbError>(())
        })
    })
    .await
    .expect("grow the streamed message");
}

/// A message whose props name a run **without** ever having streamed — the
/// shape every agent-authored row has (`run_id` rides them all).
async fn post_turn_record(app: &PgPool, tenant: &Tenant, run: Uuid) -> Uuid {
    let workspace = tenant.workspace;
    let input = NewMessage {
        channel_id: tenant.channel,
        author_member_id: tenant.agent,
        message_type: MessageType::Text,
        body: Some("턴 기록".into()),
        props: json!({ "run_id": run }),
        root_id: None,
        reply_to_id: None,
        client_msg_id: Some(Uuid::new_v4()),
        run_id: Some(run),
        hlc_ts: None,
        hlc_count: None,
    };
    with_tenant_tx(app, workspace, move |conn| {
        Box::pin(async move { send_message_in_tx(conn, workspace, input).await })
    })
    .await
    .expect("post the turn record")
    .message
    .id
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async fn login(http: &reqwest::Client, base: &str, tenant: &Tenant) -> String {
    let body: Value = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": tenant.email,
            "password": TEST_PASSWORD,
            "workspace": tenant.workspace.to_string(),
        }))
        .send()
        .await
        .expect("login")
        .json()
        .await
        .expect("login body");
    body["accessToken"]
        .as_str()
        .expect("accessToken")
        .to_string()
}

/// `GET …/messages` — the reload, exactly as a freshly opened tab performs it.
async fn history(http: &reqwest::Client, base: &str, token: &str, tenant: &Tenant) -> Vec<Value> {
    let response = http
        .get(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages?limit=50",
            tenant.workspace, tenant.channel
        ))
        .bearer_auth(token)
        .send()
        .await
        .expect("read history");
    assert_eq!(response.status(), 200, "history is readable");
    let body: Value = response.json().await.expect("history body");
    body["messages"].as_array().expect("messages array").clone()
}

async fn replies(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    tenant: &Tenant,
    root: Uuid,
) -> Vec<Value> {
    let response = http
        .get(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages/{root}/replies",
            tenant.workspace, tenant.channel
        ))
        .bearer_auth(token)
        .send()
        .await
        .expect("read replies");
    assert_eq!(response.status(), 200, "the thread is readable");
    let body: Value = response.json().await.expect("replies body");
    body["messages"].as_array().expect("messages array").clone()
}

fn row(page: &[Value], message_id: Uuid) -> &Value {
    page.iter()
        .find(|row| row["id"] == json!(message_id.to_string()))
        .unwrap_or_else(|| panic!("message {message_id} is on the page"))
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

/// **The reload closure.** A turn streamed, the closing PATCH never landed, the
/// run is over, and the tab that would have seen the terminal frame is gone.
/// The page read is the only thing left that can tell the truth, and it does.
#[tokio::test]
#[ignore = "requires DATABASE_URL (pg18 superuser) + bootstrap_roles.sql"]
async fn a_reload_learns_the_run_ended_from_the_page_itself() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su, &app).await;
    let base = start_server(app.clone()).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, &tenant).await;

    let run = seed_run(&su, &tenant, "cancelled").await;
    let message = open_stream(&app, &tenant, run, None, None).await;
    grow_stream(&app, &tenant, message, 1).await;

    let page = history(&http, &base, &token, &tenant).await;
    let streamed = row(&page, message);

    // **RED proof ① — the row alone does not know.** These two assertions are
    // the pre-#1166 state of the world verbatim: the message says it is still
    // being written and names no ending. Delete the enclosure and this is
    // everything a reloaded tab has, which is why it drew a finished answer.
    assert_eq!(
        streamed["props"][STREAM_PROPS_KEY]["streaming"],
        json!(true),
        "the closing PATCH is still missing: {streamed}"
    );
    assert!(
        streamed["props"][STREAM_PROPS_KEY].get("outcome").is_none(),
        "no outcome was ever written: {streamed}"
    );
    assert_eq!(
        streamed["body"],
        json!(HALF_ANSWER),
        "the half answer is kept, not deleted (ADR-0155 B안 기각)"
    );

    // And the page hands the reader what the row cannot.
    assert_eq!(
        streamed["runEnded"],
        json!(true),
        "the page must carry the run's ending: {streamed}"
    );
}

/// **RED proof ② — a run that has not ended cannot be marked as ended.**
///
/// Every non-terminal status, one page. If any of these ever answers, the
/// defensive tail stops being a report of a failure and becomes noise stapled
/// to every answer that is still arriving — the mirror image of the lie.
#[tokio::test]
#[ignore = "requires DATABASE_URL (pg18 superuser) + bootstrap_roles.sql"]
async fn a_run_that_has_not_ended_is_never_announced_as_ended() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su, &app).await;
    let base = start_server(app.clone()).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, &tenant).await;

    let mut live = Vec::new();
    for status in ["queued", "running", "awaiting_approval", "paused"] {
        let run = seed_run(&su, &tenant, status).await;
        let message = open_stream(&app, &tenant, run, None, None).await;
        grow_stream(&app, &tenant, message, 1).await;
        live.push((status, message));
    }
    // One terminal run in the same page, so a suite that silently stopped
    // enclosing anything at all cannot pass this test.
    let ended_run = seed_run(&su, &tenant, "timed_out").await;
    let ended_message = open_stream(&app, &tenant, ended_run, None, None).await;
    grow_stream(&app, &tenant, ended_message, 1).await;

    let page = history(&http, &base, &token, &tenant).await;
    for (status, message) in live {
        let json = row(&page, message);
        assert!(
            json.get("runEnded").is_none(),
            "a `{status}` run must not be reported as ended: {json}"
        );
    }
    assert_eq!(
        row(&page, ended_message)["runEnded"],
        json!(true),
        "the terminal run on the same page still answers"
    );
}

/// A message that already says how it ended is not re-litigated by a route, and
/// a message that never streamed is not annotated because it happens to name a
/// run — every agent-authored row does.
#[tokio::test]
#[ignore = "requires DATABASE_URL (pg18 superuser) + bootstrap_roles.sql"]
async fn a_closed_stream_asks_no_questions_about_its_run() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su, &app).await;
    let base = start_server(app.clone()).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, &tenant).await;

    let run = seed_run(&su, &tenant, "cancelled").await;
    let closed = open_stream(&app, &tenant, run, None, None).await;
    // The closing PATCH, this time landing: `final: true` + `outcome`.
    let workspace = tenant.workspace;
    let author = tenant.agent;
    with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            let outcome = stream_message_body_in_tx(
                conn,
                workspace,
                closed,
                author,
                HALF_ANSWER,
                StreamEdit {
                    rev: 1,
                    is_final: true,
                    outcome: Some(momo_messaging::StreamCloseOutcome::Cancelled),
                },
            )
            .await?;
            assert!(
                outcome.is_ok(),
                "the closing slice was refused: {outcome:?}"
            );
            Ok::<_, DbError>(())
        })
    })
    .await
    .expect("close the stream");

    let turn_record = post_turn_record(&app, &tenant, run).await;

    let page = history(&http, &base, &token, &tenant).await;
    let closed_row = row(&page, closed);
    assert_eq!(
        closed_row["props"][STREAM_PROPS_KEY]["outcome"],
        json!("cancelled"),
        "the message describes itself: {closed_row}"
    );
    assert!(
        closed_row.get("runEnded").is_none(),
        "a self-describing message needs no second opinion: {closed_row}"
    );
    let record_row = row(&page, turn_record);
    assert!(
        record_row.get("runEnded").is_none(),
        "naming a run is not streaming: {record_row}"
    );
}

/// **The workspace predicate is load-bearing.** `run_id` sits in props, which a
/// client can write, so without the predicate a page read would answer "is run
/// X over?" for any id anyone pastes — including one belonging to a tenant this
/// caller cannot see at all.
#[tokio::test]
#[ignore = "requires DATABASE_URL (pg18 superuser) + bootstrap_roles.sql"]
async fn a_run_id_from_another_workspace_is_not_answered() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su, &app).await;
    let neighbour = seed_tenant(&su, &app).await;
    let base = start_server(app.clone()).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, &tenant).await;

    // A real, genuinely terminal run — in somebody else's workspace.
    let foreign_run = seed_run(&su, &neighbour, "succeeded").await;
    let message = open_stream(&app, &tenant, foreign_run, None, None).await;
    grow_stream(&app, &tenant, message, 1).await;

    let page = history(&http, &base, &token, &tenant).await;
    let json = row(&page, message);
    assert!(
        json.get("runEnded").is_none(),
        "another tenant's run status must not leak through a page read: {json}"
    );
}

/// One message, one answer, whichever page a reader arrived through.
#[tokio::test]
#[ignore = "requires DATABASE_URL (pg18 superuser) + bootstrap_roles.sql"]
async fn the_thread_page_carries_the_same_verdict() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su, &app).await;
    let base = start_server(app.clone()).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, &tenant).await;

    // A human root, so the thread is an ordinary one.
    let root: Value = http
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            tenant.workspace, tenant.channel
        ))
        .bearer_auth(&token)
        .json(&json!({ "body": "이거 좀 봐줘", "clientMsgId": Uuid::new_v4().to_string() }))
        .send()
        .await
        .expect("post the thread root")
        .json()
        .await
        .expect("root body");
    let root_id = Uuid::parse_str(root["id"].as_str().expect("root id")).expect("root uuid");

    let run = seed_run(&su, &tenant, "failed").await;
    let reply = open_stream(&app, &tenant, run, None, Some(root_id)).await;
    grow_stream(&app, &tenant, reply, 1).await;

    let thread = replies(&http, &base, &token, &tenant, root_id).await;
    assert_eq!(
        row(&thread, reply)["runEnded"],
        json!(true),
        "the thread page answers the same question the channel page does"
    );
}

/// A write describes the write. Asking a run's state on the send echo would put
/// a read inside the send transaction for an answer that is always the same.
#[tokio::test]
#[ignore = "requires DATABASE_URL (pg18 superuser) + bootstrap_roles.sql"]
async fn a_write_never_answers_about_a_run() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su, &app).await;
    let base = start_server(app.clone()).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, &tenant).await;

    let run = seed_run(&su, &tenant, "cancelled").await;
    let echo: Value = http
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/messages",
            tenant.workspace, tenant.channel
        ))
        .bearer_auth(&token)
        .json(&json!({
            "body": "내가 쓴 글",
            "clientMsgId": Uuid::new_v4().to_string(),
            // A client may write `run_id` in its own props; the send echo still
            // says nothing about that run.
            "props": { "run_id": run.to_string() },
        }))
        .send()
        .await
        .expect("send")
        .json()
        .await
        .expect("send echo");
    assert!(
        echo.get("runEnded").is_none(),
        "the send echo answers about the write: {echo}"
    );

    // …and the human's own message is not annotated on the page either: it
    // never streamed, so there is no half answer for an ending to explain.
    let message = Uuid::parse_str(echo["id"].as_str().expect("id")).expect("uuid");
    let page = history(&http, &base, &token, &tenant).await;
    let json = row(&page, message);
    assert!(json.get("runEnded").is_none(), "{json}");
}
