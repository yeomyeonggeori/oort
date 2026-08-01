//! DB-backed conformance for the agent **operating** surface (B5.3a).
//!
//! B5.2 could invite an agent and read its profile. It could not put the agent in
//! a room, could not change what the agent was told, could not stop it, and
//! refused any per-request model choice. These four tests are the proof that each
//! of those four gaps is closed — and each one drives the loop far enough that a
//! revert shows up as *silence in a channel*, not as a missing row.
//!
//! They are `#[ignore]` because they need a `pgvector/pgvector:pg18` superuser DB
//! plus the runtime roles:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test agent_ops_conformance_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Harness contract, identical to `mention_routing_conformance_pg.rs`:
//! `DATABASE_URL` connects as a **superuser** (migrations +
//! `infra/e2e/bootstrap_roles.sql`, fixtures bypass RLS); the **server** runs on
//! `momo_app` (NOBYPASSRLS) so every assertion is made through the policies
//! production uses; the **worker** runs on `momo_worker` (BYPASSRLS), the only
//! faithful posture for a consumer whose claim has no workspace predicate.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `b53a_1_a_channel_invite_is_what_makes_an_agent_answer` | drop `POST …/channels/{ch}/members`, add the row without clearing `left_at`, or stop `DELETE …` from closing the membership |
//! | `b53a_2_pausing_stops_the_run_and_says_so` | drop `PUT …/pause`, write `paused` without the mention path reading it, or make the paused branch silent |
//! | `b53a_3_a_routing_block_reaches_the_run_and_its_job` | drop the `routing` echo from `agent_run.input`, resolve the job payload from `agent.model` instead of the request, or let a disallowed model through as a silent fallback |
//! | `b53a_4_the_operating_surface_refuses_the_unauthorized` | widen any of the three write gates to plain members, or narrow `allowed-models` away from them |

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use momo_agent_worker::provider::MockChatProvider;
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

const TEST_JWT_SECRET: &str = "b53a-agent-ops-conformance-secret";
const TEST_PASSWORD: &str = "b53a-conformance-password";
const AGENT_MODEL: &str = "hermes-agent";
/// A second model the effort table knows, with a **narrower** effort ceiling than
/// `hermes-agent` — which is what lets `b53a_3` prove the model×effort gate
/// rather than just the allow-list.
const ALT_MODEL: &str = "hermes-fast";

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

/// Retire every worker job this suite did not enqueue — `claim_agent_job_batch`
/// is a **global** claim (no workspace predicate, no tenant GUC), so a leftover
/// row from another binary would land in this suite's batch. Every assertion
/// below is additionally scoped to this test's fresh `workspace_id`.
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

async fn seed_human(su: &PgPool, workspace: Uuid, role: &str, display: &str) -> (Uuid, String) {
    let human = Uuid::new_v4();
    let email = format!("{human}@b53a.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $4)",
    )
    .bind(human)
    .bind(workspace)
    .bind(display)
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
    // `workspace_membership.role` is `membership_role` (026), the same enum the
    // per-channel role uses — the two are independent columns, not two types.
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, $3::membership_role)",
    )
    .bind(workspace)
    .bind(human)
    .bind(role)
    .execute(su)
    .await
    .expect("seed workspace membership");
    (human, email)
}

async fn seed_tenant(su: &PgPool, app: &PgPool) -> Tenant {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(workspace.to_string())
        .execute(su)
        .await
        .expect("seed workspace");
    // Owner: `POST …/agents` and the membership writes are admin surfaces.
    let (human, email) = seed_human(su, workspace, "owner", "성재").await;

    // `create_channel` seeds the creator's `membership` row (as owner), so the
    // human is already in the channel and the send's membership gate passes.
    let channel = create_channel(
        app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("b53a-{}", &Uuid::new_v4().simple().to_string()[..8]),
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

/// Seed an agent member directly — the paths not testing the create surface.
/// Mirrors what `POST …/agents` writes, **without** any channel membership:
/// that is exactly the state B5.3a's `POST …/channels/{ch}/members` exists to
/// change.
async fn seed_agent(su: &PgPool, tenant: &Tenant, handle: &str, model: &str) -> Uuid {
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
    .bind(model)
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
    agent
}

/// ADR-0131 D2's allow-list, written where the enforcement paths read it.
async fn allow_models(su: &PgPool, workspace: Uuid, models: &[&str]) {
    sqlx::query("UPDATE workspace SET settings = $2 WHERE id = $1")
        .bind(workspace)
        .bind(json!({ "allowed_agent_models": models }))
        .execute(su)
        .await
        .expect("write the workspace allow-list");
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async fn login(http: &reqwest::Client, base: &str, workspace: Uuid, email: &str) -> String {
    let response = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": email,
            "password": TEST_PASSWORD,
            "workspace": workspace.to_string(),
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

fn messages_url(base: &str, tenant: &Tenant) -> String {
    format!(
        "{base}/v1/workspaces/{}/channels/{}/messages",
        tenant.workspace, tenant.channel
    )
}

fn members_url(base: &str, tenant: &Tenant) -> String {
    format!(
        "{base}/v1/workspaces/{}/channels/{}/members",
        tenant.workspace, tenant.channel
    )
}

/// A send that is expected to succeed.
async fn send(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    tenant: &Tenant,
    body: &str,
    routing: Option<Value>,
) -> Value {
    let mut payload = json!({"clientMsgId": Uuid::new_v4(), "body": body});
    if let Some(routing) = routing {
        payload["routing"] = routing;
    }
    let response = http
        .post(messages_url(base, tenant))
        .bearer_auth(token)
        .json(&payload)
        .send()
        .await
        .expect("send message");
    assert_eq!(
        response.status(),
        201,
        "a send answers 201: {:?}",
        response.text().await
    );
    response.json().await.expect("message body")
}

/// A send that is expected to be refused — returns `(status, message)`.
async fn send_refused(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    tenant: &Tenant,
    body: &str,
    routing: Value,
) -> (u16, String) {
    let response = http
        .post(messages_url(base, tenant))
        .bearer_auth(token)
        .json(&json!({
            "clientMsgId": Uuid::new_v4(),
            "body": body,
            "routing": routing,
        }))
        .send()
        .await
        .expect("send message");
    let status = response.status().as_u16();
    let payload: Value = response.json().await.expect("error body");
    (
        status,
        payload["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
    )
}

async fn add_member(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    tenant: &Tenant,
    member: Uuid,
) -> reqwest::Response {
    http.post(members_url(base, tenant))
        .bearer_auth(token)
        .json(&json!({"memberId": member}))
        .send()
        .await
        .expect("add channel member")
}

async fn set_paused(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    tenant: &Tenant,
    agent: Uuid,
    paused: bool,
) -> reqwest::Response {
    http.put(format!(
        "{base}/v1/workspaces/{}/agents/{agent}/pause",
        tenant.workspace
    ))
    .bearer_auth(token)
    .json(&json!({"paused": paused}))
    .send()
    .await
    .expect("pause agent")
}

// ---------------------------------------------------------------------------
// readers
// ---------------------------------------------------------------------------

async fn runs_for(su: &PgPool, workspace: Uuid) -> Vec<(Uuid, Uuid, Value)> {
    sqlx::query(
        "SELECT id, agent_member_id, input FROM agent_run \
          WHERE workspace_id = $1 ORDER BY created_at, id",
    )
    .bind(workspace)
    .fetch_all(su)
    .await
    .expect("read agent runs")
    .into_iter()
    .map(|row| (row.get("id"), row.get("agent_member_id"), row.get("input")))
    .collect()
}

async fn agent_job_payloads(su: &PgPool, workspace: Uuid) -> Vec<Value> {
    sqlx::query_scalar(
        "SELECT payload FROM outbox \
          WHERE workspace_id = $1 AND kind = 'agent_job' ORDER BY id",
    )
    .bind(workspace)
    .fetch_all(su)
    .await
    .expect("read agent jobs")
}

async fn messages_by(su: &PgPool, tenant: &Tenant, author: Uuid) -> Vec<(i64, String, Value)> {
    sqlx::query(
        "SELECT seq, COALESCE(body, '') AS body, props FROM message \
          WHERE workspace_id = $1 AND channel_id = $2 AND author_member_id = $3 \
          ORDER BY seq",
    )
    .bind(tenant.workspace)
    .bind(tenant.channel)
    .bind(author)
    .fetch_all(su)
    .await
    .expect("read messages")
    .into_iter()
    .map(|row| (row.get("seq"), row.get("body"), row.get("props")))
    .collect()
}

async fn channel_message_count(su: &PgPool, tenant: &Tenant) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM message WHERE channel_id = $1")
        .bind(tenant.channel)
        .fetch_one(su)
        .await
        .expect("count channel messages")
}

async fn audit_actions(su: &PgPool, workspace: Uuid) -> Vec<String> {
    sqlx::query_scalar("SELECT action FROM audit_log WHERE workspace_id = $1 ORDER BY created_at")
        .bind(workspace)
        .fetch_all(su)
        .await
        .expect("read audit actions")
}

async fn audit_details(su: &PgPool, workspace: Uuid, action: &str) -> Vec<Value> {
    sqlx::query_scalar(
        "SELECT detail FROM audit_log \
          WHERE workspace_id = $1 AND action = $2 ORDER BY created_at",
    )
    .bind(workspace)
    .bind(action)
    .fetch_all(su)
    .await
    .expect("read audit details")
}

async fn live_membership(su: &PgPool, tenant: &Tenant, member: Uuid) -> bool {
    sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM membership \
           WHERE channel_id = $1 AND member_id = $2 AND left_at IS NULL)",
    )
    .bind(tenant.channel)
    .bind(member)
    .fetch_one(su)
    .await
    .expect("read channel membership")
}

async fn drain_once() -> momo_agent_worker::DrainStats {
    let pool = role_pool("momo_worker", &momo_worker_password()).await;
    let worker = AgentWorker::new(
        pool,
        Arc::new(MockChatProvider::echo()),
        WorkerConfig::for_target(database_url()),
    );
    worker.drain_once().await.expect("drain")
}

// ---------------------------------------------------------------------------
// 1 — 채널 초대 → 멘션 → 응답 (the 접합 B5.2 could not make)
// ---------------------------------------------------------------------------

/// **An agent answers because it was invited to the channel, and stops when it
/// is removed.**
///
/// B5.2's own suite had to seed the `membership` row with raw SQL and recorded
/// the missing route as a deviation, which meant the story it proved began one
/// step after the one an operator actually performs. This test starts where the
/// operator does — `POST …/channels/{ch}/members` — and only then does the loop
/// run for real: mention → run → one worker iteration → an agent-authored
/// message with a `seq` in the channel.
///
/// The two negatives around it are what make it a *membership* test rather than
/// a "mentions work" test: before the invite the same mention starts nothing and
/// is audited `agent_not_channel_member`, and after the removal it does so again.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn b53a_1_a_channel_invite_is_what_makes_an_agent_answer() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let agent = seed_agent(&su, &tenant, "hermes", AGENT_MODEL).await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, tenant.workspace, &tenant.email).await;

    // ---- before the invite: a workspace member, but nobody in this room ------
    send(&http, &base, &token, &tenant, "@hermes 있어?", None).await;
    assert!(
        runs_for(&su, tenant.workspace).await.is_empty(),
        "an agent that is not in the channel starts no run — fail closed"
    );
    let skipped = audit_details(&su, tenant.workspace, "agent.mention.skipped").await;
    assert_eq!(
        skipped.first().and_then(|detail| detail["reason"].as_str()),
        Some("agent_not_channel_member"),
        "the reason is auditable, or 'the agent ignored me' and 'the agent is not \
         here' look identical from the timeline: {skipped:?}"
    );

    // ---- the invite ---------------------------------------------------------
    let response = add_member(&http, &base, &token, &tenant, agent).await;
    assert_eq!(response.status(), 200, "the invite answers 200");
    let added: Value = response.json().await.expect("membership body");
    assert_eq!(added["membership"]["memberId"], json!(agent.to_string()));
    assert_eq!(
        added["membership"]["role"],
        json!("member"),
        "an absent role means `member`, never an inherited owner"
    );
    assert!(
        added["membership"].get("leftAtMs").is_none(),
        "a live membership carries no departure stamp: {added}"
    );
    assert!(
        live_membership(&su, &tenant, agent).await,
        "invariant #5: the agent holds an ordinary `membership` row, like a human"
    );

    // ---- …and now the same words start the loop ----------------------------
    let trigger = send(
        &http,
        &base,
        &token,
        &tenant,
        "@hermes 배포 상태 알려줘",
        None,
    )
    .await;
    let trigger_seq = trigger["seq"].as_i64().expect("the send returns its seq");
    let runs = runs_for(&su, tenant.workspace).await;
    assert_eq!(
        runs.len(),
        1,
        "the invited agent took the run this time: {runs:?}"
    );
    assert_eq!(runs[0].1, agent);

    let stats = drain_once().await;
    assert_eq!(
        (stats.claimed, stats.answered),
        (1, 1),
        "the shipped claim picked up the job the invite made possible: {stats:?}"
    );
    let replies = messages_by(&su, &tenant, agent).await;
    assert_eq!(replies.len(), 1, "exactly one answer: {replies:?}");
    assert!(
        replies[0].0 > trigger_seq,
        "the answer went through the channel_seq spine, after the trigger"
    );
    assert!(
        replies[0].1.contains("배포 상태 알려줘"),
        "the mock echoes the user's turn, so the prompt reached the provider: {}",
        replies[0].1
    );

    // ---- removal is the other half -----------------------------------------
    let removed = http
        .delete(format!("{}/{agent}", members_url(&base, &tenant)))
        .bearer_auth(&token)
        .send()
        .await
        .expect("remove channel member");
    assert_eq!(removed.status(), 200);
    let removed: Value = removed.json().await.expect("membership body");
    assert!(
        removed["membership"]["leftAtMs"].is_i64(),
        "the removal answers with the row it closed: {removed}"
    );
    assert!(
        !live_membership(&su, &tenant, agent).await,
        "the membership is closed, not deleted — the row is the evidence"
    );

    send(&http, &base, &token, &tenant, "@hermes 아직 있어?", None).await;
    assert_eq!(
        runs_for(&su, tenant.workspace).await.len(),
        1,
        "a removed agent starts no further run"
    );
    // Run a worker pass anyway: the agent must still be silent AFTER one, which
    // is the difference between "nothing was queued" and "something was queued
    // and happened not to run yet". The claim is global, so the assertion is on
    // this workspace's messages rather than on `DrainStats` — another test
    // binary's job is allowed to be in that batch.
    drain_once().await;
    assert_eq!(
        messages_by(&su, &tenant, agent).await.len(),
        1,
        "the agent said nothing after it left"
    );

    // A repeat removal is a 404, not a second silent success: "already gone" and
    // "you named the wrong channel" must not look identical.
    let again = http
        .delete(format!("{}/{agent}", members_url(&base, &tenant)))
        .bearer_auth(&token)
        .send()
        .await
        .expect("remove twice");
    assert_eq!(again.status(), 404);

    // Re-inviting works on the first try — `left_at` is cleared rather than
    // colliding with `membership_uniq`.
    assert_eq!(
        add_member(&http, &base, &token, &tenant, agent)
            .await
            .status(),
        200,
        "an agent removed from a room can be brought back into it"
    );
    assert!(live_membership(&su, &tenant, agent).await);
}

// ---------------------------------------------------------------------------
// 2 — pause: 0 runs, and a line that says why
// ---------------------------------------------------------------------------

/// **A paused agent starts no run and says so; resuming restores the loop.**
///
/// B5.2 respected `agent_profile.paused` on the read side with nothing able to
/// write it, so the flag was unreachable through the API — the only way to stop
/// an agent was to remove it from every channel. This test drives the switch over
/// HTTP in both directions.
///
/// The visible system line is half the property. Silence would be
/// indistinguishable from a broken agent, and a team that cannot tell those apart
/// debugs the wrong thing; the Korean sentence and its `agent_paused` props are
/// what the timeline renders instead.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn b53a_2_pausing_stops_the_run_and_says_so() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let agent = seed_agent(&su, &tenant, "hermes", AGENT_MODEL).await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, tenant.workspace, &tenant.email).await;
    assert_eq!(
        add_member(&http, &base, &token, &tenant, agent)
            .await
            .status(),
        200
    );

    // ---- pause --------------------------------------------------------------
    let paused = set_paused(&http, &base, &token, &tenant, agent, true).await;
    assert_eq!(paused.status(), 200, "the pause answers 200");
    let paused: Value = paused.json().await.expect("profile body");
    assert_eq!(
        paused["profile"]["paused"],
        json!(true),
        "the response is the stored profile, not an echo of the request"
    );
    let version_after_pause = paused["profile"]["version"].as_i64().expect("version");

    // A second identical pause does not bump `version`: a hub UI polling the
    // switch must not inflate the edit count of a profile nobody edited.
    let repeat: Value = set_paused(&http, &base, &token, &tenant, agent, true)
        .await
        .json()
        .await
        .expect("profile body");
    assert_eq!(
        repeat["profile"]["version"].as_i64(),
        Some(version_after_pause),
        "an unchanged flag is not an edit: {repeat}"
    );

    // ---- the mention that must not run --------------------------------------
    let trigger = send(&http, &base, &token, &tenant, "@hermes 지금 돼?", None).await;
    let trigger_seq = trigger["seq"].as_i64().expect("seq");
    assert!(
        runs_for(&su, tenant.workspace).await.is_empty(),
        "a paused agent starts ZERO runs"
    );
    assert!(
        agent_job_payloads(&su, tenant.workspace).await.is_empty(),
        "…and enqueues no job for anything to claim"
    );

    let lines = messages_by(&su, &tenant, agent).await;
    assert_eq!(
        lines.len(),
        1,
        "the pause is VISIBLE — silence would look like a broken agent: {lines:?}"
    );
    let (line_seq, line_body, line_props) = lines[0].clone();
    assert!(
        line_seq > trigger_seq,
        "the notice went through the same channel_seq spine, after the trigger"
    );
    assert!(
        line_body.contains("일시정지"),
        "the line says why in the reader's language: {line_body}"
    );
    assert_eq!(line_props["kind"], json!("agent_paused"));
    assert_eq!(
        line_props["agent_member_id"],
        json!(agent.to_string()),
        "these two props ids are lowercase on purpose (Swift writes them so)"
    );

    // The worker pass proves "nothing was queued" rather than "not queued yet".
    // Scoped to this workspace's messages, not to `DrainStats`: the claim is
    // global, so another test binary's job may share the batch.
    drain_once().await;
    assert_eq!(
        messages_by(&su, &tenant, agent).await.len(),
        1,
        "still only the notice — no answer arrived late"
    );

    let actions = audit_actions(&su, tenant.workspace).await;
    for expected in ["agent.profile.paused", "agent.mention.paused"] {
        assert!(
            actions.iter().any(|action| action == expected),
            "{expected} must be auditable: {actions:?}"
        );
    }

    // ---- resume -------------------------------------------------------------
    let resumed: Value = set_paused(&http, &base, &token, &tenant, agent, false)
        .await
        .json()
        .await
        .expect("profile body");
    assert_eq!(resumed["profile"]["paused"], json!(false));
    assert!(
        resumed["profile"]["version"].as_i64() > Some(version_after_pause),
        "a real change IS an edit: {resumed}"
    );

    send(&http, &base, &token, &tenant, "@hermes 이제 돼?", None).await;
    let runs = runs_for(&su, tenant.workspace).await;
    assert_eq!(runs.len(), 1, "resuming restores the loop: {runs:?}");
    let stats = drain_once().await;
    assert_eq!(stats.answered, 1, "{stats:?}");
    assert_eq!(
        messages_by(&su, &tenant, agent).await.len(),
        2,
        "the notice, then a real answer"
    );
    assert!(
        audit_actions(&su, tenant.workspace)
            .await
            .iter()
            .any(|action| action == "agent.profile.resumed"),
        "resume is its own audited act, not an untyped profile edit"
    );
}

// ---------------------------------------------------------------------------
// 3 — routing{} on send reaches the run and the job
// ---------------------------------------------------------------------------

/// **A `routing` block chooses the model the turn actually runs on — and an
/// unchosen one fails the send instead of substituting a different model.**
///
/// Three separate claims, and each has its own way of going wrong silently:
///
/// 1. the run's stored `input.routing` echoes **what was asked for** (that is
///    where `usage_ledger` reads the request tier back from);
/// 2. the job payload carries the **resolved** model/effort, so the adapter runs
///    what the caller chose rather than `agent.model` (ADR-0134 D4);
/// 3. a model outside `workspace.settings.allowed_agent_models` is a 400 **and
///    the message is not stored** — a silent fallback would deliver the user's
///    words under a model they refused.
///
/// The agent's own model is `hermes-agent` and the request asks for
/// `hermes-fast`, so claim 2 cannot pass by accident.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn b53a_3_a_routing_block_reaches_the_run_and_its_job() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let agent = seed_agent(&su, &tenant, "hermes", AGENT_MODEL).await;
    allow_models(&su, tenant.workspace, &[ALT_MODEL]).await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, tenant.workspace, &tenant.email).await;
    assert_eq!(
        add_member(&http, &base, &token, &tenant, agent)
            .await
            .status(),
        200
    );

    // The picker's vocabulary is served from the same helper the gate uses, so a
    // client cannot be offered a model the send would then refuse.
    let allowed: Value = http
        .get(format!(
            "{base}/v1/workspaces/{}/agents/{agent}/allowed-models",
            tenant.workspace
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("allowed models")
        .json()
        .await
        .expect("allowed models body");
    assert_eq!(
        allowed,
        json!({"allowedAgentModels": [AGENT_MODEL, ALT_MODEL]}),
        "agent.model ∪ settings, sorted: {allowed}"
    );

    // ---- the honoured request ----------------------------------------------
    send(
        &http,
        &base,
        &token,
        &tenant,
        "@hermes 빠르게 요약해줘",
        Some(json!({"model": ALT_MODEL, "effort": "low"})),
    )
    .await;

    let runs = runs_for(&su, tenant.workspace).await;
    assert_eq!(
        runs.len(),
        1,
        "the routed mention started its run: {runs:?}"
    );
    assert_eq!(
        runs[0].2["routing"],
        json!({"model": ALT_MODEL, "effort": "low"}),
        "the stored input echoes the REQUEST — usage_ledger reads the request \
         tier from `input.routing.effort`: {:?}",
        runs[0].2
    );

    let jobs = agent_job_payloads(&su, tenant.workspace).await;
    assert_eq!(jobs.len(), 1, "one run, one job");
    assert_eq!(
        jobs[0]["model"],
        json!(ALT_MODEL),
        "ADR-0134 D4: the job carries the RESOLVED model, not `agent.model` — \
         `{AGENT_MODEL}` here would mean the selector lied to the user: {}",
        jobs[0]
    );
    assert_eq!(jobs[0]["effort"], json!("low"));

    let queued = audit_details(&su, tenant.workspace, "agent.mention.queued").await;
    assert_eq!(
        queued
            .first()
            .and_then(|detail| detail["resolved_model"].as_str()),
        Some(ALT_MODEL)
    );
    assert_eq!(
        queued.first().map(|detail| detail["routing"].clone()),
        Some(json!({"model": ALT_MODEL, "effort": "low"})),
        "what was asked for is recorded beside what was resolved: {queued:?}"
    );

    // ---- the refused request, and the rollback that comes with it ----------
    let before = channel_message_count(&su, &tenant).await;
    let (status, message) = send_refused(
        &http,
        &base,
        &token,
        &tenant,
        "@hermes 이건 안 되는 모델",
        json!({"model": "gpt-4o"}),
    )
    .await;
    assert_eq!(
        status, 400,
        "an explicit disallowed model is refused: {message}"
    );
    assert!(
        message.contains("allowed_agent_models"),
        "the sentence names the allow-list the caller must consult: {message}"
    );
    assert_eq!(
        channel_message_count(&su, &tenant).await,
        before,
        "THE SEND ROLLED BACK. Delivering the message under a different model \
         would substitute the one decision the caller made explicitly."
    );
    assert_eq!(
        runs_for(&su, tenant.workspace).await.len(),
        1,
        "and no second run was created"
    );

    // An effort the resolved model cannot honour is the same kind of refusal —
    // `hermes-fast` tops out below `max`, and the pair is judged together.
    let (status, message) = send_refused(
        &http,
        &base,
        &token,
        &tenant,
        "@hermes 최대로",
        json!({"model": ALT_MODEL, "effort": "max"}),
    )
    .await;
    assert_eq!(status, 400);
    assert!(
        message.contains("routing.effort") && message.contains(ALT_MODEL),
        "the refusal names both halves of the pair it judged: {message}"
    );

    // Shape errors are answered before the transaction opens — this is the web
    // capability probe's request, and a 400 naming `routing` is what makes the
    // composer open a selector that then works.
    let (status, message) = send_refused(
        &http,
        &base,
        &token,
        &tenant,
        "",
        json!({"effort": "__momo-capability-probe__"}),
    )
    .await;
    assert_eq!(status, 400);
    assert!(
        message.to_lowercase().contains("routing"),
        "`verdictFromSendProbe` matches /routing/i to reach `ready`: {message}"
    );
    assert_eq!(
        channel_message_count(&su, &tenant).await,
        before,
        "a probe writes nothing at all"
    );

    // The honoured turn still completes end to end.
    let stats = drain_once().await;
    assert_eq!(stats.answered, 1, "{stats:?}");
    assert_eq!(messages_by(&su, &tenant, agent).await.len(), 1);
}

// ---------------------------------------------------------------------------
// 4 — 비인가
// ---------------------------------------------------------------------------

/// **Every write on this surface refuses a plain member; the picker's read does
/// not.**
///
/// The asymmetry is the test's subject. Adding someone to a channel changes who
/// can read a room's history and pausing an agent stops it acting for everyone,
/// so both are workspace/owner authority. `allowed-models` is the vocabulary of
/// the composer's selector — gating it would leave a teammate guessing which
/// `routing.model` values the send path accepts, and a wrong guess is a 400 on a
/// message they meant to send.
///
/// The last case is the tenant boundary itself: a credential for one workspace
/// cannot address another's path, whatever the row-level policies would have
/// said.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn b53a_4_the_operating_surface_refuses_the_unauthorized() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let tenant = seed_tenant(&su, &app_pool).await;
    let agent = seed_agent(&su, &tenant, "hermes", AGENT_MODEL).await;
    // A plain member of the same workspace: in the roster, not in authority.
    let (outsider, outsider_email) = seed_human(&su, tenant.workspace, "member", "동료").await;

    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, tenant.workspace, &tenant.email).await;
    let member_token = login(&http, &base, tenant.workspace, &outsider_email).await;

    // ---- channel membership: owner/admin only ------------------------------
    let refused = add_member(&http, &base, &member_token, &tenant, agent).await;
    assert_eq!(
        refused.status(),
        403,
        "a plain member cannot decide who reads this room's history"
    );
    assert!(
        !live_membership(&su, &tenant, agent).await,
        "…and nothing was written"
    );
    assert_eq!(
        add_member(&http, &base, &owner_token, &tenant, agent)
            .await
            .status(),
        200,
        "the owner can"
    );
    assert_eq!(
        http.delete(format!("{}/{agent}", members_url(&base, &tenant)))
            .bearer_auth(&member_token)
            .send()
            .await
            .expect("remove as member")
            .status(),
        403
    );
    assert!(
        live_membership(&su, &tenant, agent).await,
        "the refused removal removed nothing"
    );

    // ---- profile + pause: the agent's owner or a workspace admin ------------
    let profile_url = format!(
        "{base}/v1/workspaces/{}/agents/{agent}/profile",
        tenant.workspace
    );
    let refused = http
        .put(&profile_url)
        .bearer_auth(&member_token)
        .json(&json!({"instructions": "내 맘대로", "enabledTools": []}))
        .send()
        .await
        .expect("put profile as member");
    assert_eq!(
        refused.status(),
        403,
        "a teammate cannot rewrite what someone else's agent was told"
    );
    assert_eq!(
        set_paused(&http, &base, &member_token, &tenant, agent, true)
            .await
            .status(),
        403,
        "…nor stop it acting for the whole workspace"
    );
    assert_eq!(
        http.get(&profile_url)
            .bearer_auth(&member_token)
            .send()
            .await
            .expect("get profile as member")
            .status(),
        403,
        "the instructions an operator wrote are not a workspace-wide read"
    );
    let stored: Value = http
        .get(&profile_url)
        .bearer_auth(&owner_token)
        .send()
        .await
        .expect("get profile as owner")
        .json()
        .await
        .expect("profile body");
    assert!(
        stored["profile"].is_null() || stored["profile"]["paused"] == json!(false),
        "the refused pause did not take: {stored}"
    );

    // ---- the owner's own edit works, and is audited ------------------------
    let edited = http
        .put(&profile_url)
        .bearer_auth(&owner_token)
        .json(&json!({
            "instructions": "한국어로 간결하게",
            "enabledTools": ["read"],
            "effortPref": "high",
        }))
        .send()
        .await
        .expect("put profile as owner");
    assert_eq!(edited.status(), 200);
    let edited: Value = edited.json().await.expect("profile body");
    assert_eq!(
        edited["profile"]["instructions"],
        json!("한국어로 간결하게")
    );
    assert_eq!(edited["profile"]["effortPref"], json!("high"));
    assert_eq!(
        edited["profile"]["version"],
        json!(1),
        "the first write is version 1, which is what makes it `created` in audit"
    );

    // A `modelPref` outside the allow-list is a 400 at WRITE time — the
    // asymmetry ADR-0131 D2 draws against the silently-ignored runtime case.
    let refused = http
        .put(&profile_url)
        .bearer_auth(&owner_token)
        .json(&json!({
            "instructions": "x", "enabledTools": [], "modelPref": "gpt-4o",
        }))
        .send()
        .await
        .expect("put a disallowed modelPref");
    assert_eq!(refused.status(), 400);

    // ---- allowed-models: any active member ---------------------------------
    let picker: Value = http
        .get(format!(
            "{base}/v1/workspaces/{}/agents/{agent}/allowed-models",
            tenant.workspace
        ))
        .bearer_auth(&member_token)
        .send()
        .await
        .expect("allowed models as member")
        .json()
        .await
        .expect("allowed models body");
    assert_eq!(
        picker,
        json!({"allowedAgentModels": [AGENT_MODEL]}),
        "the picker's vocabulary is readable by whoever uses the picker: {picker}"
    );
    assert!(
        picker.get("settings").is_none() && picker.as_object().expect("object").len() == 1,
        "…and it carries the model list ALONE — never the workspace settings bag"
    );

    // ---- the tenant boundary ------------------------------------------------
    let other_workspace = Uuid::new_v4();
    assert_eq!(
        http.post(format!(
            "{base}/v1/workspaces/{other_workspace}/channels/{}/members",
            tenant.channel
        ))
        .bearer_auth(&owner_token)
        .json(&json!({"memberId": outsider}))
        .send()
        .await
        .expect("cross-tenant add")
        .status(),
        403,
        "the {{ws}} path must match the credential's workspace, whatever RLS would say"
    );

    let actions = audit_actions(&su, tenant.workspace).await;
    assert!(
        actions
            .iter()
            .any(|action| action == "agent.profile.created"),
        "the owner's edit is auditable: {actions:?}"
    );
    assert!(
        !actions
            .iter()
            .any(|action| action == "agent.profile.paused"),
        "a refused pause leaves no trace of having happened: {actions:?}"
    );
}
