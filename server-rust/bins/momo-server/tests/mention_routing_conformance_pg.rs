//! DB-backed conformance for mention → run routing and the agent-invite surface
//! (B5.2).
//!
//! These are the orchestrator's docker-gate red tests. Each proves one property
//! with a **named assertion that goes red if the enforcement is reverted** (momo
//! red-test discipline). They are `#[ignore]` because they need a
//! `pgvector/pgvector:pg18` superuser DB plus the runtime roles:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test mention_routing_conformance_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Harness contract, identical to `http_smoke_pg.rs`: `DATABASE_URL` connects as
//! a **superuser** (migrations + `infra/e2e/bootstrap_roles.sql`, fixtures bypass
//! RLS); the **server** runs on `momo_app` (NOBYPASSRLS) so every assertion is
//! made through the policies production uses; and the **worker** runs on
//! `momo_worker` (BYPASSRLS), which is the only faithful posture for a consumer
//! whose claim has no workspace predicate.
//!
//! ## The suite is a 티키타카, not four unit tests
//!
//! B5.1 shipped the consumer and B2.6 the run's state machine, but nothing
//! produced a `method='publish'` job — so until this batch the loop had no first
//! step. `b52_1` therefore drives the **whole** loop over HTTP and then runs one
//! real worker iteration in-process: a human sends `@hermes …`, and the test
//! passes only if an agent-authored message with a `seq` comes back out of the
//! channel. Nothing is stubbed between those two points.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `b52_1_a_mention_starts_a_run_the_worker_answers` | drop `route_agent_mentions_in_tx` from the send path, emit the job with the wrong `method`/`partition_key`, or enqueue it outside the send transaction |
//! | `b52_2_the_same_utterance_never_starts_two_runs` | route mentions on a deduped retry, or drop the `mention:<message>:<agent>` idempotency key |
//! | `b52_3_mentioning_a_human_starts_no_run` | widen the candidate query past `member.kind = 'agent'`, or route on the read-state mention list instead of the agent one |
//! | `b52_4_a_created_agent_joins_the_roster_and_becomes_mentionable` | create the agent without its `workspace_membership` row (it vanishes from the roster), or with `kind='human'` (it stops being a mention candidate) |

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use momo_agent_worker::provider::{ChatProvider, MockChatProvider};
use momo_agent_worker::{AgentWorker, WorkerConfig};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::sqlx::Row;
use momo_db::PgPool;
use momo_messaging::{create_channel, ChannelKind, NewChannel};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET: &str = "b52-mention-conformance-secret";
const TEST_PASSWORD: &str = "b52-conformance-password";
const AGENT_MODEL: &str = "hermes-agent";
const HUMAN_DISPLAY: &str = "성재";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn momo_app_password() -> String {
    std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string())
}

fn momo_worker_password() -> String {
    std::env::var("MOMO_WORKER_PASSWORD").unwrap_or_else(|_| "momo_worker_dev_pw".to_string())
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect to conformance DB as superuser")
}

async fn role_pool(username: &str, password: &str) -> PgPool {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options.username(username).password(password))
        .await
        .unwrap_or_else(|error| panic!("connect as {username} (bootstrap_roles.sql?): {error}"))
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

fn apply_bootstrap_roles() {
    let path = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/e2e/bootstrap_roles.sql"
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
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations");
    apply_bootstrap_roles();
    *ready = true;
}

/// Retire every worker job this suite did not enqueue.
///
/// `claim_agent_job_batch` is a **global** claim — no workspace predicate, on a
/// pool that sets no tenant GUC — so a leftover row from another binary lands in
/// this suite's batch and inflates its `DrainStats`. Same sweep, same reason, as
/// `momo-agent-worker`'s own suite; every assertion below is additionally scoped
/// to this test's fresh `workspace_id`.
async fn settle_residual_worker_jobs(su: &PgPool) {
    sqlx::query(
        "UPDATE outbox SET status = 'done', processed_at = now() \
          WHERE kind = 'agent_job' AND method = 'publish' \
            AND status IN ('pending', 'processing')",
    )
    .execute(su)
    .await
    .expect("sweep residual worker agent_jobs");
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
// fixtures (superuser → RLS bypassed)
// ---------------------------------------------------------------------------

struct Tenant {
    workspace: Uuid,
    human: Uuid,
    email: String,
    channel: Uuid,
}

async fn seed_tenant(su: &PgPool, app: &PgPool) -> Tenant {
    let workspace = Uuid::new_v4();
    let human = Uuid::new_v4();
    let email = format!("{human}@b52.test");

    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(workspace.to_string())
        .execute(su)
        .await
        .expect("seed workspace");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $4)",
    )
    .bind(human)
    .bind(workspace)
    .bind(HUMAN_DISPLAY)
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
    // Owner, because `POST …/agents` is an admin surface.
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'owner')",
    )
    .bind(workspace)
    .bind(human)
    .execute(su)
    .await
    .expect("seed workspace membership");

    // `create_channel` also inserts the creator's `membership` row (as owner), so
    // the human is already in the channel — the send's membership gate passes
    // without a second insert, which `membership_uniq` would reject anyway.
    let channel = create_channel(
        app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("b52-{}", &Uuid::new_v4().simple().to_string()[..8]),
            topic: None,
            created_by: human,
        },
    )
    .await
    .expect("create channel")
    .id;

    Tenant {
        workspace,
        human,
        email,
        channel,
    }
}

/// Seed an agent member directly (the paths that are not testing the create
/// surface). Mirrors what `POST …/agents` writes, plus the channel membership
/// that creation deliberately leaves to a separate decision.
async fn seed_agent(su: &PgPool, tenant: &Tenant, handle: &str, in_channel: bool) -> Uuid {
    let agent = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', $3, $3)",
    )
    .bind(agent)
    .bind(tenant.workspace)
    .bind(handle)
    .execute(su)
    .await
    .expect("seed agent member");
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, \
                            max_concurrent_runs, max_run_steps, owner_human_id) \
         VALUES ($1, $2, $3, 'https://gateway.invalid/v1', 4, 50, $4)",
    )
    .bind(agent)
    .bind(tenant.workspace)
    .bind(AGENT_MODEL)
    .bind(tenant.human)
    .execute(su)
    .await
    .expect("seed agent");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'member')",
    )
    .bind(tenant.workspace)
    .bind(agent)
    .execute(su)
    .await
    .expect("seed agent workspace membership");
    if in_channel {
        join_channel(su, tenant, agent).await;
    }
    agent
}

async fn join_channel(su: &PgPool, tenant: &Tenant, member: Uuid) {
    sqlx::query("INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)")
        .bind(tenant.workspace)
        .bind(tenant.channel)
        .bind(member)
        .execute(su)
        .await
        .expect("seed channel membership");
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async fn login(http: &reqwest::Client, base: &str, tenant: &Tenant) -> String {
    let response = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": tenant.email,
            "password": TEST_PASSWORD,
            "workspace": tenant.workspace.to_string(),
        }))
        .send()
        .await
        .expect("login");
    assert_eq!(response.status(), 200, "the seeded human logs in");
    let body: Value = response.json().await.expect("login body");
    body["accessToken"]
        .as_str()
        .expect("accessToken")
        .to_string()
}

async fn send_message(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    tenant: &Tenant,
    client_msg_id: Uuid,
    body: &str,
) -> Value {
    send_in_channel(
        http,
        base,
        token,
        tenant,
        tenant.channel,
        client_msg_id,
        body,
    )
    .await
}

/// The same send against an explicit channel — B13 needs it because the DM the
/// rule is about is not `tenant.channel`.
async fn send_in_channel(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    tenant: &Tenant,
    channel: Uuid,
    client_msg_id: Uuid,
    body: &str,
) -> Value {
    let response = http
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{channel}/messages",
            tenant.workspace
        ))
        .bearer_auth(token)
        .json(&json!({"clientMsgId": client_msg_id, "body": body}))
        .send()
        .await
        .expect("send message");
    assert_eq!(response.status(), 201, "a send answers 201");
    response.json().await.expect("message body")
}

// ---------------------------------------------------------------------------
// readers
// ---------------------------------------------------------------------------

async fn runs_for(
    su: &PgPool,
    workspace: Uuid,
) -> Vec<(Uuid, Uuid, String, Value, Option<String>)> {
    sqlx::query(
        "SELECT id, agent_member_id, status::text AS status, input, idempotency_key \
           FROM agent_run WHERE workspace_id = $1 ORDER BY created_at",
    )
    .bind(workspace)
    .fetch_all(su)
    .await
    .expect("read agent runs")
    .into_iter()
    .map(|row| {
        (
            row.get("id"),
            row.get("agent_member_id"),
            row.get("status"),
            row.get("input"),
            row.get("idempotency_key"),
        )
    })
    .collect()
}

async fn agent_jobs_for(
    su: &PgPool,
    workspace: Uuid,
) -> Vec<(i64, String, String, Option<Uuid>, Value)> {
    sqlx::query(
        "SELECT id, status::text AS status, method, partition_key, payload \
           FROM outbox WHERE workspace_id = $1 AND kind = 'agent_job' ORDER BY id",
    )
    .bind(workspace)
    .fetch_all(su)
    .await
    .expect("read agent jobs")
    .into_iter()
    .map(|row| {
        (
            row.get("id"),
            row.get("status"),
            row.get("method"),
            row.get("partition_key"),
            row.get("payload"),
        )
    })
    .collect()
}

async fn messages_by(su: &PgPool, tenant: &Tenant, author: Uuid) -> Vec<(i64, String, Value)> {
    messages_by_in(su, tenant, tenant.channel, author).await
}

async fn messages_by_in(
    su: &PgPool,
    tenant: &Tenant,
    channel: Uuid,
    author: Uuid,
) -> Vec<(i64, String, Value)> {
    sqlx::query(
        "SELECT seq, COALESCE(body, '') AS body, props FROM message \
          WHERE workspace_id = $1 AND channel_id = $2 AND author_member_id = $3 \
          ORDER BY seq",
    )
    .bind(tenant.workspace)
    .bind(channel)
    .bind(author)
    .fetch_all(su)
    .await
    .expect("read messages")
    .into_iter()
    .map(|row| (row.get("seq"), row.get("body"), row.get("props")))
    .collect()
}

async fn audit_actions(su: &PgPool, workspace: Uuid) -> Vec<String> {
    sqlx::query_scalar("SELECT action FROM audit_log WHERE workspace_id = $1 ORDER BY created_at")
        .bind(workspace)
        .fetch_all(su)
        .await
        .expect("read audit actions")
}

async fn worker(provider: Arc<dyn ChatProvider>) -> AgentWorker {
    let pool = role_pool("momo_worker", &momo_worker_password()).await;
    AgentWorker::new(pool, provider, WorkerConfig::for_target(database_url()))
}

// ---------------------------------------------------------------------------
// 1 — the 티키타카
// ---------------------------------------------------------------------------

/// **@mention → run → one worker iteration → the agent's answer in the channel.**
///
/// This is the loop the packet calls 티키타카, and every hop is real: the message
/// goes in over HTTP against the `momo_app` (NOBYPASSRLS) pool, the job is
/// claimed by the shipped `claim_agent_job_batch` on the `momo_worker` pool, and
/// the answer comes back through `send_message_in_tx` — the same write path a
/// human uses, which is why it has a `seq` and a broadcast of its own.
///
/// Goes red if the routing is dropped from the send path, if the job is enqueued
/// with the gateway `method` (the worker's claim is `method = 'publish'`
/// **exactly**), or if `partition_key` stops being the agent (per-agent
/// serialization is that column).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn b52_1_a_mention_starts_a_run_the_worker_answers() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let agent = seed_agent(&su, &tenant, "hermes", true).await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, &tenant).await;

    // ---- 1. the human speaks ------------------------------------------------
    let sent = send_message(
        &http,
        &base,
        &token,
        &tenant,
        Uuid::new_v4(),
        "@hermes 배포 상태 알려줘",
    )
    .await;
    let trigger_seq = sent["seq"].as_i64().expect("the send returns its seq");

    // ---- 2. the run and its job exist, in the send's commit ------------------
    let runs = runs_for(&su, tenant.workspace).await;
    assert_eq!(runs.len(), 1, "one mention, one run: {runs:?}");
    let (run_id, run_agent, status, input, idempotency_key) = runs[0].clone();
    assert_eq!(run_agent, agent, "the run belongs to the mentioned agent");
    assert_eq!(status, "queued", "a fresh mention run starts queued");
    assert_eq!(input["surface"], json!("mention"));
    assert_eq!(
        idempotency_key.as_deref(),
        Some(
            format!(
                "mention:{}:{}",
                sent["id"].as_str().unwrap().to_uppercase(),
                agent.to_string().to_uppercase()
            )
            .as_str()
        ),
        "the key is derived from the trigger, which is what makes a replay a no-op"
    );

    let jobs = agent_jobs_for(&su, tenant.workspace).await;
    assert_eq!(jobs.len(), 1, "one run, one job: {jobs:?}");
    let (_, job_status, method, partition_key, payload) = jobs[0].clone();
    assert_eq!(job_status, "pending");
    assert_eq!(
        method, "publish",
        "the in-process worker claims `method = 'publish'` exactly; \
         'gateway' here would stall every mention silently"
    );
    assert_eq!(
        partition_key,
        Some(agent),
        "partition_key = agent_member_id is what serializes one agent's turns (L4 §3.5)"
    );
    assert_eq!(
        payload["run_id"],
        json!(run_id.to_string().to_uppercase()),
        "the job names the run, so the turn is attributable"
    );
    assert_eq!(payload["model"], json!(AGENT_MODEL), "ADR-0134 D4");
    assert_eq!(payload["trigger_message_seq"], json!(trigger_seq));
    assert!(
        payload["recent_messages"]
            .as_array()
            .is_some_and(|window| !window.is_empty()),
        "MOMO-302: the turn is a conversation, not an amnesiac single message: {payload}"
    );

    // ---- 3. one real worker iteration ---------------------------------------
    let provider = Arc::new(MockChatProvider::echo());
    let worker = worker(provider.clone()).await;
    let stats = worker.drain_once().await.expect("drain");
    assert_eq!(
        (stats.claimed, stats.answered),
        (1, 1),
        "the shipped claim picked up the job this send enqueued: {stats:?}"
    );

    // ---- 4. the agent answered, as a member -------------------------------
    let replies = messages_by(&su, &tenant, agent).await;
    assert_eq!(replies.len(), 1, "exactly one answer: {replies:?}");
    let (reply_seq, reply_body, reply_props) = replies[0].clone();
    assert!(
        reply_seq > trigger_seq,
        "the answer went through the channel_seq spine, after the trigger"
    );
    assert!(
        reply_body.contains("배포 상태 알려줘"),
        "the mock echoes the user's turn, so the prompt reached the provider: {reply_body}"
    );
    assert_eq!(
        reply_props["run_id"],
        json!(run_id.to_string()),
        "the answer carries its run, so a client can attribute it"
    );

    // The envelope is `momo_messaging::build_broadcast_payload`'s
    // (`{channel, data:{type, seq, payload:{…}}, version, idempotency_key}`), so
    // the count is keyed on the JSON path rather than a substring: an agent's
    // reply must reach clients the same way a human's does (invariant #3, and
    // then invariant #2 — the relay publishes it, never this server).
    let broadcast: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox \
          WHERE workspace_id = $1 AND kind = 'broadcast' \
            AND payload->'data'->>'type' = 'message.new' \
            AND (payload->'data'->>'seq')::bigint = $2",
    )
    .bind(tenant.workspace)
    .bind(reply_seq)
    .fetch_one(&su)
    .await
    .expect("count reply broadcasts");
    assert_eq!(
        broadcast, 1,
        "the agent's reply is published exactly once, like any other message"
    );

    let runs = runs_for(&su, tenant.workspace).await;
    assert_eq!(runs[0].2, "succeeded", "the run closed on the answer");

    // ---- 4b. …and the progress rail was TOLD it closed (goal SRV-B3c) -------
    //
    // The success case, on the path a default deployment actually takes
    // (`AGENT_GATEWAY_MODE=worker`). Before this goal the run reached
    // `succeeded` and the `agent:` namespace stayed silent — a subscription
    // every client is authorized for and nothing in this workspace ever
    // published to, so 작업 중 could only ever be cleared by a client-side
    // timeout. That is the frame 「작업 패널」 needs and the one Swift's own
    // projection folds away (`agentStatusProjection`: everything that is not
    // `streaming`/`cancelled` becomes `("thinking","running")`).
    let rail: Vec<Value> = sqlx::query_scalar(
        "SELECT payload FROM outbox \
          WHERE workspace_id = $1 AND kind = 'broadcast' \
            AND payload->'data'->>'type' = 'agent.status' \
          ORDER BY id",
    )
    .bind(tenant.workspace)
    .fetch_all(&su)
    .await
    .expect("read agent.status broadcasts");
    // goal SRV-B3d: the whole turn, in order. Before B3c/B3d this list was
    // EMPTY — `agent:` had a subscriber and no producer — so a badge could only
    // ever be cleared by a client-side timeout and could never show a clock.
    let phases: Vec<(String, String)> = rail
        .iter()
        .map(|frame| {
            (
                frame["data"]["payload"]["phase"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
                frame["data"]["payload"]["run_status"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
            )
        })
        .collect();
    assert_eq!(
        phases,
        vec![
            ("queued".to_string(), "queued".to_string()),
            ("thinking".to_string(), "running".to_string()),
            ("done".to_string(), "succeeded".to_string()),
        ],
        "여는 → 진행 → 종료, in the order the turn happened. The FIFO is the \
         channel partition key, shared with this turn's messages: {rail:?}"
    );
    // The opening frame is the only one that can start the client's clock
    // (`isRunOpening` reads `phase === "queued" || run_status === "queued"`).
    assert!(
        rail.iter()
            .any(|frame| frame["data"]["payload"]["phase"] == json!("queued")),
        "without an opening frame the badge renders with no elapsed time: {rail:?}"
    );
    // …and every frame is addressed to the same rail.
    let channels: std::collections::BTreeSet<&str> = rail
        .iter()
        .map(|frame| frame["channel"].as_str().unwrap_or_default())
        .collect();
    assert_eq!(channels.len(), 1, "one turn, one channel: {channels:?}");

    let frame = rail.last().expect("the terminal frame");
    assert_eq!(
        frame["channel"],
        json!(format!(
            "agent:ws{}.{}.{}",
            tenant.workspace.to_string().to_uppercase(),
            tenant.channel.to_string().to_uppercase(),
            agent.to_string().to_uppercase()
        )),
        "three uppercased segments — the name `centrifugoAgentChannelName` \
         builds and the namespace regex accepts: {frame}"
    );
    assert_eq!(
        (
            frame["data"]["payload"]["phase"].clone(),
            frame["data"]["payload"]["run_status"].clone()
        ),
        (json!("done"), json!("succeeded")),
        "phase done + run_status succeeded — a success that ANNOUNCES it ended: {frame}"
    );
    assert_eq!(
        frame["data"]["payload"]["run_id"],
        json!(run_id.to_string().to_uppercase()),
        "the frame names the run whose badge it clears"
    );
    assert!(
        frame.get("version").is_none(),
        "a status frame claims no place in the channel's seq: {frame}"
    );
    let ledger: i64 = sqlx::query_scalar("SELECT count(*) FROM usage_ledger WHERE run_id = $1")
        .bind(run_id)
        .fetch_one(&su)
        .await
        .expect("count ledger rows");
    assert_eq!(ledger, 1, "the turn was billed exactly once");

    let actions = audit_actions(&su, tenant.workspace).await;
    assert!(
        actions
            .iter()
            .any(|action| action == "agent.mention.queued"),
        "the enqueue is auditable: {actions:?}"
    );
}

// ---------------------------------------------------------------------------
// 2 — idempotency
// ---------------------------------------------------------------------------

/// **The same utterance never starts two runs**, and there are two independent
/// reasons for it — this test breaks if either is removed.
///
/// 1. `message_client_idem_uniq` makes the retried send a no-op, and the routing
///    is guarded on `!sent.deduped` (Swift's `if didInsert`);
/// 2. `agent_run.idempotency_key = mention:<message>:<agent>` is UNIQUE, so even
///    a second routing pass over the same message inserts nothing.
///
/// A duplicate would not just be an extra row: it is a second provider call and
/// a second answer in the channel for one question.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn b52_2_the_same_utterance_never_starts_two_runs() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let agent = seed_agent(&su, &tenant, "hermes", true).await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, &tenant).await;

    let client_msg_id = Uuid::new_v4();
    let first = send_message(&http, &base, &token, &tenant, client_msg_id, "@hermes 안녕").await;
    let retry = send_message(&http, &base, &token, &tenant, client_msg_id, "@hermes 안녕").await;
    assert_eq!(
        first["id"], retry["id"],
        "the retry returned the original message (exactly-once effect)"
    );
    assert_eq!(first["seq"], retry["seq"], "and its original seq");

    let runs = runs_for(&su, tenant.workspace).await;
    assert_eq!(runs.len(), 1, "a resent message starts ONE run: {runs:?}");
    let jobs = agent_jobs_for(&su, tenant.workspace).await;
    assert_eq!(jobs.len(), 1, "…and enqueues ONE job: {jobs:?}");

    let queued = audit_actions(&su, tenant.workspace)
        .await
        .into_iter()
        .filter(|action| action == "agent.mention.queued")
        .count();
    assert_eq!(queued, 1, "the audit trail records one enqueue, not two");

    // The worker answers once, which is the property a user can actually see.
    let worker = worker(Arc::new(MockChatProvider::echo())).await;
    let stats = worker.drain_once().await.expect("drain");
    assert_eq!(stats.answered, 1, "{stats:?}");
    assert_eq!(
        messages_by(&su, &tenant, agent).await.len(),
        1,
        "one question, one answer"
    );

    // A genuinely NEW utterance with the same text is a different question and
    // does start its own run — the key is the message, not the words.
    send_message(
        &http,
        &base,
        &token,
        &tenant,
        Uuid::new_v4(),
        "@hermes 안녕",
    )
    .await;
    assert_eq!(
        runs_for(&su, tenant.workspace).await.len(),
        2,
        "a second utterance is not deduplicated by its body"
    );
}

// ---------------------------------------------------------------------------
// 3 — a human mention is not an agent mention
// ---------------------------------------------------------------------------

/// **Mentioning a human raises a badge and starts nothing.**
///
/// The read-state mention ledger (B1.2) and the agent-run routing (B5.2) read the
/// same body and must reach different conclusions. Routing off the read-state
/// recipient list — the obvious "simplification" — would start a run for every
/// human mentioned, so this test exists to make that mistake loud.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn b52_3_mentioning_a_human_starts_no_run() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    // An agent exists in the workspace and is in the channel — it simply is not
    // the one mentioned. Without it the test would pass on an empty workspace.
    let agent = seed_agent(&su, &tenant, "hermes", true).await;

    let teammate = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', '동료', 'dongryo')",
    )
    .bind(teammate)
    .bind(tenant.workspace)
    .execute(&su)
    .await
    .expect("seed teammate");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ($1, $2, 'member')",
    )
    .bind(tenant.workspace)
    .bind(teammate)
    .execute(&su)
    .await
    .expect("seed teammate workspace membership");
    join_channel(&su, &tenant, teammate).await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, &tenant).await;

    let sent = send_message(
        &http,
        &base,
        &token,
        &tenant,
        Uuid::new_v4(),
        "@dongryo 이거 봐줄래?",
    )
    .await;

    assert!(
        runs_for(&su, tenant.workspace).await.is_empty(),
        "a human mention starts no agent run"
    );
    assert!(
        agent_jobs_for(&su, tenant.workspace).await.is_empty(),
        "…and enqueues no agent_job"
    );

    // The human half of the same decision still happened, which is what makes
    // this a *discrimination* test rather than a "mentions are broken" test.
    assert_eq!(
        sent["props"]["mention_member_ids"],
        json!([teammate.to_string().to_uppercase()]),
        "B1.2 still recorded the human mention on the row: {sent}"
    );
    let badge: i32 = sqlx::query_scalar(
        "SELECT mention_count FROM read_state WHERE channel_id = $1 AND member_id = $2",
    )
    .bind(tenant.channel)
    .bind(teammate)
    .fetch_one(&su)
    .await
    .expect("read the teammate's badge");
    assert_eq!(badge, 1, "the teammate was notified");

    // Run a worker pass anyway: the agent must still be silent AFTER one, which
    // is the difference between "nothing was queued" and "something was queued
    // and happened not to run yet". The claim is global, so the assertion is on
    // this workspace's messages rather than on `DrainStats` — another test
    // binary's job is allowed to be in that batch.
    let worker = worker(Arc::new(MockChatProvider::echo())).await;
    worker.drain_once().await.expect("drain");
    assert!(
        messages_by(&su, &tenant, agent).await.is_empty(),
        "the uninvolved agent said nothing"
    );
}

// ---------------------------------------------------------------------------
// 4 — 에이전트 초대 → roster → mentionable
// ---------------------------------------------------------------------------

/// **Create an agent over HTTP, find it in the roster as `kind=agent`, mention
/// it, get a run.**
///
/// This is the invite story end to end, and it also pins the two halves of
/// invariant #5 that are easy to break separately: the `workspace_membership`
/// row (without it the roster's `JOIN` drops the agent and every message stays
/// labelled with a uuid) and `member.kind='agent'` (without it the agent is not a
/// mention candidate at all).
///
/// The channel membership is seeded rather than posted because creation
/// deliberately stops at the workspace identity boundary — Swift's create adds no
/// channels either. B5.2 additionally had no route to post it with; B5.3a serves
/// `POST …/channels/{ch}/members`, and
/// `agent_ops_conformance_pg::b53a_1_a_channel_invite_is_what_makes_an_agent_answer`
/// drives that route instead. This test keeps the seed on purpose, so it stays a
/// proof about **creation → roster → mentionable** and does not start failing for
/// a membership reason.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn b52_4_a_created_agent_joins_the_roster_and_becomes_mentionable() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, &tenant).await;

    // ---- create ------------------------------------------------------------
    let response = http
        .post(format!("{base}/v1/workspaces/{}/agents", tenant.workspace))
        .bearer_auth(&token)
        .json(&json!({
            "displayName": "아틀라스",
            "handle": "atlas",
            "model": AGENT_MODEL,
            "baseUrl": "https://gateway.example.com/v1",
            "systemPrompt": "you are atlas",
            "config": {"max_output_tokens": 512},
            "profile": {
                "instructions": "한국어로 간결하게",
                "enabledTools": [],
            }
        }))
        .send()
        .await
        .expect("create agent");
    assert_eq!(response.status(), 201, "creation answers 201");
    let created: Value = response.json().await.expect("create body");
    let agent: Uuid = created["agent"]["id"]
        .as_str()
        .and_then(|id| Uuid::parse_str(id).ok())
        .expect("the created agent's id");
    assert_eq!(created["agent"]["handle"], json!("atlas"));

    // A credential-shaped field is refused even though every other key is valid.
    let refused = http
        .post(format!("{base}/v1/workspaces/{}/agents", tenant.workspace))
        .bearer_auth(&token)
        .json(&json!({
            "displayName": "leaky", "handle": "leaky", "model": AGENT_MODEL,
            "baseUrl": "https://gateway.example.com/v1",
            "config": {"provider": {"api_key": "sk-live-nope"}}
        }))
        .send()
        .await
        .expect("credential-shaped create");
    assert_eq!(
        refused.status(),
        400,
        "ADR-0004: a provider credential must not reach a momo row"
    );

    // ---- roster ------------------------------------------------------------
    let roster: Value = http
        .get(format!("{base}/v1/workspaces/{}/roster", tenant.workspace))
        .bearer_auth(&token)
        .send()
        .await
        .expect("roster")
        .json()
        .await
        .expect("roster body");
    let listed = roster["members"]
        .as_array()
        .expect("members")
        .iter()
        .find(|member| member["id"] == json!(agent.to_string()))
        .unwrap_or_else(|| panic!("the created agent must be in the roster: {roster}"));
    assert_eq!(
        listed["kind"],
        json!("agent"),
        "invariant #5: an agent is a member, listed beside the humans"
    );
    assert_eq!(listed["displayName"], json!("아틀라스"));
    assert_eq!(listed["agentModel"], json!(AGENT_MODEL));
    assert_eq!(
        roster["agentCount"],
        json!(1),
        "the roster counts it as an agent: {roster}"
    );

    // ---- profile read ------------------------------------------------------
    let profile: Value = http
        .get(format!(
            "{base}/v1/workspaces/{}/agents/{agent}/profile",
            tenant.workspace
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("profile")
        .json()
        .await
        .expect("profile body");
    assert_eq!(
        profile["profile"]["instructions"],
        json!("한국어로 간결하게")
    );
    assert_eq!(
        profile["profile"]["triggers"]["mention"],
        json!(true),
        "the mention trigger is what makes the next step possible"
    );

    // ---- and now it can be mentioned ---------------------------------------
    join_channel(&su, &tenant, agent).await;
    send_message(
        &http,
        &base,
        &token,
        &tenant,
        Uuid::new_v4(),
        "@atlas 처음 뵙겠습니다",
    )
    .await;

    let runs = runs_for(&su, tenant.workspace).await;
    assert_eq!(
        runs.len(),
        1,
        "the newly created agent took the run: {runs:?}"
    );
    assert_eq!(runs[0].1, agent);

    let worker = worker(Arc::new(MockChatProvider::echo())).await;
    let stats = worker.drain_once().await.expect("drain");
    assert_eq!(stats.answered, 1, "{stats:?}");
    let replies = messages_by(&su, &tenant, agent).await;
    assert_eq!(
        replies.len(),
        1,
        "an agent invited five seconds ago is already talking"
    );

    let actions = audit_actions(&su, tenant.workspace).await;
    for expected in [
        "agent.created",
        "agent.profile.created",
        "agent.mention.queued",
    ] {
        assert!(
            actions.iter().any(|action| action == expected),
            "{expected} must be auditable: {actions:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// B13 — implicit addressing in a 1:1 DM (QA H7)
// ---------------------------------------------------------------------------
//
// | test | revert that makes it red |
// |---|---|
// | `b13_1_a_dm_answers_without_a_mention` | drop the DM rule from `route_agent_mentions_in_tx`, or stop stamping `addressing` |
// | `b13_2_an_agent_never_auto_answers_another_agent_in_a_dm` | relax either half of the author gate (credential or roster) — the agent↔agent loop |
// | `b13_3_a_paused_agent_stays_silent_in_a_dm` | move the DM rule past the `agent.paused` branch |
// | `b13_4_a_mention_inside_the_dm_starts_exactly_one_run` | concatenate the two addressing paths instead of unioning them |
// | `b13_5_a_group_channel_without_a_mention_starts_nothing` | widen the rule past `channel.kind = 'dm'` |

/// Open the caller's DM with `target` through the surface a client uses.
async fn open_dm(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    tenant: &Tenant,
    target: Uuid,
) -> Uuid {
    let response = http
        .post(format!("{base}/v1/workspaces/{}/dms", tenant.workspace))
        .bearer_auth(token)
        .json(&json!({"memberId": target}))
        .send()
        .await
        .expect("open dm");
    assert!(
        response.status() == 200 || response.status() == 201,
        "opening a DM answers 200/201, got {}",
        response.status()
    );
    let body: Value = response.json().await.expect("dm body");
    assert_eq!(body["channel"]["kind"], json!("dm"), "{body}");
    Uuid::parse_str(body["channel"]["id"].as_str().expect("channel id")).expect("channel uuid")
}

/// A DM seeded directly, for the pair `POST /dms` will not open: it needs a
/// human on one end, and the agent↔agent room is the one this batch must prove
/// stays quiet.
async fn seed_dm(su: &PgPool, tenant: &Tenant, first: Uuid, second: Uuid) -> Uuid {
    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, topic, dm_key, created_by) \
         VALUES ($1, $2, 'dm', NULL, NULL, $3, $4)",
    )
    .bind(channel)
    .bind(tenant.workspace)
    .bind(channel.to_string())
    .bind(first)
    .execute(su)
    .await
    .expect("seed dm channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel)
        .bind(tenant.workspace)
        .execute(su)
        .await
        .expect("seed dm channel_seq");
    for member in [first, second] {
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)",
        )
        .bind(tenant.workspace)
        .bind(channel)
        .bind(member)
        .execute(su)
        .await
        .expect("seed dm membership");
    }
    channel
}

/// Mint an agent bearer for `agent` — the credential an external/BYOA runtime
/// posts with, and the one the author gate has to refuse in a DM.
async fn agent_bearer(su: &PgPool, tenant: &Tenant, agent: Uuid) -> String {
    let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token = format!("momo_agent_v1.{}.{secret}", tenant.workspace);
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, \
                            token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), \
                 ARRAY['messages:write'], 'b13-conformance')",
    )
    .bind(tenant.workspace)
    .bind(agent)
    .bind(&token)
    .execute(su)
    .await
    .expect("seed agent bearer");
    token
}

async fn pause_agent(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    tenant: &Tenant,
    agent: Uuid,
) {
    let response = http
        .put(format!(
            "{base}/v1/workspaces/{}/agents/{agent}/pause",
            tenant.workspace
        ))
        .bearer_auth(token)
        .json(&json!({"paused": true}))
        .send()
        .await
        .expect("pause agent");
    assert_eq!(response.status(), 200, "the owner may pause its agent");
}

/// **(a) A human alone with one agent does not have to type a handle.**
///
/// The whole reason for the batch, driven end to end: the DM is opened through
/// `POST /dms`, the message carries no `@`, and one real worker iteration turns
/// the run into an answer in that DM. Goes red if the DM rule leaves
/// `route_agent_mentions_in_tx`.
///
/// It also pins the provenance: `input.addressing = "dm_implicit"` is how an
/// operator tells "nobody typed a mention" from "somebody did", and
/// `input.surface` stays `mention` because the run *is* a mention-shaped run —
/// the worker decodes one payload, not two.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn b13_1_a_dm_answers_without_a_mention() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let agent = seed_agent(&su, &tenant, "hermes", false).await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, &tenant).await;
    let dm = open_dm(&http, &base, &token, &tenant, agent).await;

    send_in_channel(
        &http,
        &base,
        &token,
        &tenant,
        dm,
        Uuid::new_v4(),
        "배포 상태 알려줘",
    )
    .await;

    let runs = runs_for(&su, tenant.workspace).await;
    assert_eq!(
        runs.len(),
        1,
        "a bare utterance in the 1:1 DM addresses the agent: {runs:?}"
    );
    let (run_id, run_agent, status, input, _) = runs[0].clone();
    assert_eq!(run_agent, agent);
    assert_eq!(status, "queued");
    assert_eq!(
        input["addressing"],
        json!("dm_implicit"),
        "the provenance says nobody typed a mention: {input}"
    );
    assert_eq!(
        input["surface"],
        json!("mention"),
        "one run shape, one payload the worker decodes: {input}"
    );
    assert_eq!(input["depth"], json!(0), "a human trigger is depth 0");
    assert!(
        input.get("parent_run_id").is_none(),
        "no parent: this is not a delegation: {input}"
    );

    let worker = worker(Arc::new(MockChatProvider::echo())).await;
    let stats = worker.drain_once().await.expect("drain");
    assert_eq!((stats.claimed, stats.answered), (1, 1), "{stats:?}");

    let replies = messages_by_in(&su, &tenant, dm, agent).await;
    assert_eq!(
        replies.len(),
        1,
        "the agent answered in the DM: {replies:?}"
    );
    assert_eq!(
        replies[0].2["run_id"],
        json!(run_id.to_string()),
        "the answer carries its run"
    );

    let actions = audit_actions(&su, tenant.workspace).await;
    assert!(
        actions
            .iter()
            .any(|action| action == "agent.mention.queued"),
        "the DM enqueue is auditable under the one mention schema: {actions:?}"
    );
}

/// **(b) An agent never auto-answers another agent in a DM.**
///
/// Two agents alone in a room, each auto-replying to the other, is a loop with
/// no human in it and no end: the A2A gates (G1/G2/G3, `a2a_depth`, the chain
/// budget) guard the *worker's* delegation path, and an HTTP send on an agent
/// bearer never reaches them. This test posts as a real agent bearer into a real
/// agent↔agent DM and asserts **zero** runs — twice:
///
/// * with no mention, which is the DM rule's own refusal (`AuthorIsNotHuman`);
/// * with an explicit `@atlas`, which is the older `a2a_source_run_unavailable`
///   refusal that must survive this batch untouched.
///
/// Goes red the moment either half of the author gate is relaxed.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn b13_2_an_agent_never_auto_answers_another_agent_in_a_dm() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let hermes = seed_agent(&su, &tenant, "hermes", false).await;
    let atlas = seed_agent(&su, &tenant, "atlas", false).await;
    let dm = seed_dm(&su, &tenant, hermes, atlas).await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let bearer = agent_bearer(&su, &tenant, hermes).await;

    // 1. no mention — the DM rule must not fire for an agent author.
    send_in_channel(
        &http,
        &base,
        &bearer,
        &tenant,
        dm,
        Uuid::new_v4(),
        "네 알겠습니다",
    )
    .await;
    let runs = runs_for(&su, tenant.workspace).await;
    assert!(
        runs.is_empty(),
        "an agent's utterance in an agent↔agent DM starts NOTHING — this is the \
         infinite-loop gate: {runs:?}"
    );

    // 2. an explicit mention — the pre-existing fail-closed refusal still holds.
    send_in_channel(
        &http,
        &base,
        &bearer,
        &tenant,
        dm,
        Uuid::new_v4(),
        "@atlas 이어서 해줘",
    )
    .await;
    let runs = runs_for(&su, tenant.workspace).await;
    assert!(
        runs.is_empty(),
        "an agent-authored mention has no source run to inherit depth from, so it \
         is still skipped: {runs:?}"
    );
    let jobs = agent_jobs_for(&su, tenant.workspace).await;
    assert!(jobs.is_empty(), "no run, no job: {jobs:?}");

    let actions = audit_actions(&su, tenant.workspace).await;
    assert!(
        actions
            .iter()
            .any(|action| action == "agent.mention.skipped"),
        "the refusal is audited rather than silent: {actions:?}"
    );
    assert!(
        !actions
            .iter()
            .any(|action| action == "agent.mention.queued"),
        "nothing was queued: {actions:?}"
    );
}

/// **(c) A paused agent stays silent in a DM too.**
///
/// The DM rule adds an addressee; it does not move the `agent.paused` branch it
/// then walks into. Goes red if the rule is applied after eligibility instead of
/// before it.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn b13_3_a_paused_agent_stays_silent_in_a_dm() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let agent = seed_agent(&su, &tenant, "hermes", false).await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, &tenant).await;
    let dm = open_dm(&http, &base, &token, &tenant, agent).await;
    pause_agent(&http, &base, &token, &tenant, agent).await;

    send_in_channel(
        &http,
        &base,
        &token,
        &tenant,
        dm,
        Uuid::new_v4(),
        "지금 되나요",
    )
    .await;

    let runs = runs_for(&su, tenant.workspace).await;
    assert!(runs.is_empty(), "a paused agent takes no run: {runs:?}");
    let jobs = agent_jobs_for(&su, tenant.workspace).await;
    assert!(jobs.is_empty(), "…and no job: {jobs:?}");

    // The existing paused path is kept whole: the person still learns why.
    let lines = messages_by_in(&su, &tenant, dm, agent).await;
    assert_eq!(lines.len(), 1, "the pause is explained once: {lines:?}");
    assert_eq!(lines[0].2["kind"], json!("agent_paused"), "{:?}", lines[0]);

    let actions = audit_actions(&su, tenant.workspace).await;
    assert!(
        actions
            .iter()
            .any(|action| action == "agent.mention.paused"),
        "{actions:?}"
    );
}

/// **(d) A mention *inside* the DM is still exactly one run.**
///
/// Both addressing rules match the same agent at once; a concatenation would
/// enqueue two jobs before `mention:<message>:<agent>` collapsed them at the
/// INSERT — having already spent a second context-window read and a second audit
/// row. The label is the mention's, because that is what the human did.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn b13_4_a_mention_inside_the_dm_starts_exactly_one_run() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let agent = seed_agent(&su, &tenant, "hermes", false).await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, &tenant).await;
    let dm = open_dm(&http, &base, &token, &tenant, agent).await;

    send_in_channel(
        &http,
        &base,
        &token,
        &tenant,
        dm,
        Uuid::new_v4(),
        "@hermes 배포 상태 알려줘",
    )
    .await;

    let runs = runs_for(&su, tenant.workspace).await;
    assert_eq!(
        runs.len(),
        1,
        "the mention path and the DM path are a UNION, not a sum: {runs:?}"
    );
    assert_eq!(
        runs[0].3["addressing"],
        json!("mention"),
        "the human typed the handle, so that is what is recorded: {:?}",
        runs[0].3
    );
    let jobs = agent_jobs_for(&su, tenant.workspace).await;
    assert_eq!(jobs.len(), 1, "one run, one job: {jobs:?}");

    let queued = audit_actions(&su, tenant.workspace)
        .await
        .into_iter()
        .filter(|action| action == "agent.mention.queued")
        .count();
    assert_eq!(queued, 1, "one utterance, one queued audit row");
}

/// **(e) The group-channel regression.**
///
/// Without a mention, a message in a channel an agent merely belongs to must
/// still start nothing — otherwise every message in every shared channel becomes
/// a provider call. Goes red if the rule is widened past `channel.kind = 'dm'`.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn b13_5_a_group_channel_without_a_mention_starts_nothing() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let agent = seed_agent(&su, &tenant, "hermes", true).await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, &tenant).await;

    send_message(
        &http,
        &base,
        &token,
        &tenant,
        Uuid::new_v4(),
        "오늘 배포 언제 하죠",
    )
    .await;

    let runs = runs_for(&su, tenant.workspace).await;
    assert!(
        runs.is_empty(),
        "a public channel still requires an explicit mention: {runs:?}"
    );
    let jobs = agent_jobs_for(&su, tenant.workspace).await;
    assert!(jobs.is_empty(), "{jobs:?}");

    // …and the same agent in the same workspace still answers when it IS named,
    // so the assertion above is about the rule and not about a broken fixture.
    send_message(
        &http,
        &base,
        &token,
        &tenant,
        Uuid::new_v4(),
        "@hermes 오늘 배포 언제 하죠",
    )
    .await;
    let runs = runs_for(&su, tenant.workspace).await;
    assert_eq!(runs.len(), 1, "the mention path is untouched: {runs:?}");
    assert_eq!(runs[0].1, agent);
    assert_eq!(runs[0].3["addressing"], json!("mention"));
}
