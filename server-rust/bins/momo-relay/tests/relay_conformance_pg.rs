//! DB-backed conformance for the outbox → Centrifugo relay (ADR-0145 B안, D2 #2).
//!
//! These are the orchestrator's docker-gate red tests for **invariant #2
//! (Centrifugo = transport-only)** and the relay's delivery contract. Each has a
//! named assertion that goes red if the behaviour is reverted. They are
//! `#[ignore]` because they need a throwaway `pgvector/pgvector:pg18` superuser
//! DB plus the runtime roles. Run:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-relay --test relay_conformance_pg -- --ignored --nocapture
//! ```
//!
//! **Give each test binary a FRESH database.** The harness applies the
//! migrations itself and is not idempotent against an already-migrated DB, so
//! reusing the database another conformance binary just ran against (e.g.
//! `momo-server`'s `http_smoke_pg`) fails in the migration step, not in an
//! assertion. One throwaway `pgvector/pgvector:pg18` container per test binary.
//!
//! Harness contract (same as `momo-messaging`'s conformance file):
//!   * `DATABASE_URL` connects as a **superuser** (applies the migrations via psql
//!     + `infra/e2e/bootstrap_roles.sql`, and seeds fixtures bypassing RLS);
//!   * the write path runs as **`momo_app`** (NOBYPASSRLS);
//!   * the relay runs as **`momo_relay`** (BYPASSRLS) — the credential boundary
//!     that lets one process drain every tenant.
//!
//! No real Centrifugo is needed: a mock HTTP receiver asserts the publish
//! *contract* (channel, version=seq, idempotency_key, `X-API-Key`), which is what
//! invariant #2 is about. The relay tests serialize on a process-wide lock
//! because a claim is global by design (BYPASSRLS), and every assertion is
//! additionally filtered to the test's own channel so leftovers cannot skew it.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::sqlx::{self, Row};
use momo_db::PgPool;
use momo_messaging::{
    cent_channel, create_channel, send_message, ChannelKind, NewChannel, NewMessage,
};
use momo_relay::{CentrifugoClient, Relay, RelayConfig};
use serde_json::Value;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a fresh pgvector/pg18 superuser DB")
}

/// Committed test-only role passwords from `infra/e2e/bootstrap_roles.sql`
/// (not secrets); overridable via env.
fn role_password(env_key: &str, fallback: &str) -> String {
    std::env::var(env_key).unwrap_or_else(|_| fallback.to_string())
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect to conformance DB as superuser")
}

async fn role_pool(role: &str, password: String, max_connections: u32) -> PgPool {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    let options = options.username(role).password(&password);
    PgPoolOptions::new()
        .max_connections(max_connections)
        .connect_with(options)
        .await
        .unwrap_or_else(|error| {
            panic!("connect as {role} (run bootstrap_roles.sql first): {error}")
        })
}

async fn momo_app_pool() -> PgPool {
    role_pool(
        "momo_app",
        role_password("MOMO_APP_PASSWORD", "momo_app_dev_pw"),
        8,
    )
    .await
}

/// The BYPASSRLS relay credential (L4 §2.2): one process, every tenant.
async fn momo_relay_pool() -> PgPool {
    role_pool(
        "momo_relay",
        role_password("MOMO_RELAY_PASSWORD", "momo_relay_dev_pw"),
        8,
    )
    .await
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

fn apply_bootstrap_roles() {
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
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations on a fresh pgvector/pg18 DB");
    apply_bootstrap_roles();
    *ready = true;
}

/// A relay claim is global (BYPASSRLS), so two concurrent relay tests would
/// steal each other's rows. Serialize them.
async fn relay_test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

// ---------------------------------------------------------------------------
// mock Centrifugo (the publish contract's receiver)
// ---------------------------------------------------------------------------

/// One recorded publish: the `X-API-Key` it carried and its JSON body.
type ReceivedPublish = (Option<String>, Value);

#[derive(Clone)]
struct MockCentrifugo {
    received: Arc<Mutex<Vec<ReceivedPublish>>>,
    status: StatusCode,
}

impl MockCentrifugo {
    /// Every publish this mock received, as `(X-API-Key, body)`.
    fn received(&self) -> Vec<ReceivedPublish> {
        self.received.lock().unwrap().clone()
    }

    /// Bodies published to one channel (ignores rows from other tests).
    fn bodies_for(&self, channel: &str) -> Vec<Value> {
        self.received()
            .into_iter()
            .map(|(_, body)| body)
            .filter(|body| body["channel"] == *channel)
            .collect()
    }
}

async fn publish_handler(
    State(state): State<MockCentrifugo>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    let api_key = headers
        .get("X-API-Key")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    state.received.lock().unwrap().push((api_key, body));
    if state.status.is_success() {
        (state.status, Json(serde_json::json!({"result": {}})))
    } else {
        (state.status, Json(serde_json::json!({})))
    }
}

/// Start a mock Centrifugo on an ephemeral port; returns the handle and its
/// `/api` base URL.
async fn start_mock_centrifugo(status: StatusCode) -> (MockCentrifugo, String) {
    let mock = MockCentrifugo {
        received: Arc::new(Mutex::new(Vec::new())),
        status,
    };
    let app = Router::new()
        .route("/api/publish", post(publish_handler))
        .with_state(mock.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock centrifugo");
    let address: SocketAddr = listener.local_addr().expect("mock address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (mock, format!("http://{address}/api"))
}

const TEST_API_KEY: &str = "conformance-cent-api-key";

fn relay_for(pool: PgPool, api_url: &str) -> Relay {
    let publisher = CentrifugoClient::new(api_url, TEST_API_KEY).expect("build centrifugo client");
    let mut config = RelayConfig::for_target(database_url(), api_url, TEST_API_KEY);
    config.claim_batch_size = 4;
    Relay::new(pool, publisher, config)
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

async fn seed_workspace(su: &PgPool, ws: Uuid) {
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(ws)
        .bind(ws.to_string())
        .execute(su)
        .await
        .expect("seed workspace");
}

async fn seed_member(su: &PgPool, ws: Uuid, id: Uuid) {
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(id)
    .bind(ws)
    .bind(id.to_string())
    .execute(su)
    .await
    .expect("seed member");
}

/// Read one outbox row's settlement state (test oracle — the relay itself only
/// touches the table through `momo-outbox`).
async fn outbox_state(su: &PgPool, id: i64) -> (String, i32, bool, bool) {
    let row = sqlx::query(
        "SELECT status::text AS status, attempts, processed_at IS NOT NULL AS processed, \
                available_at > now() AS backed_off \
           FROM outbox WHERE id = $1",
    )
    .bind(id)
    .fetch_one(su)
    .await
    .expect("read outbox row");
    (
        row.get("status"),
        row.get("attempts"),
        row.get("processed"),
        row.get("backed_off"),
    )
}

struct Fixture {
    workspace: Uuid,
    member: Uuid,
    channel: Uuid,
    app: PgPool,
}

async fn fixture(su: &PgPool) -> Fixture {
    let app = momo_app_pool().await;
    let workspace = Uuid::new_v4();
    let member = Uuid::new_v4();
    seed_workspace(su, workspace).await;
    seed_member(su, workspace, member).await;
    let channel = create_channel(
        &app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("relay-{}", Uuid::new_v4()),
            topic: None,
            created_by: member,
        },
    )
    .await
    .expect("create channel");
    Fixture {
        workspace,
        member,
        channel: channel.id,
        app,
    }
}

// ---------------------------------------------------------------------------
// #2 — Centrifugo = transport-only: the publish is the outbox row, verbatim
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a fresh pgvector/pg18 DB + bootstrap_roles.sql"]
async fn d2_2_relay_publishes_the_outbox_contract_and_settles_done() {
    let _guard = relay_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let fixture = fixture(&su).await;
    let (mock, api_url) = start_mock_centrifugo(StatusCode::OK).await;

    let sent = send_message(
        &fixture.app,
        fixture.workspace,
        NewMessage::text(fixture.channel, fixture.member, "relay me")
            .with_client_msg_id(Uuid::new_v4()),
    )
    .await
    .expect("send message");
    let outbox_id = sent.outbox_id.expect("send emits a broadcast row");

    let relay = relay_for(momo_relay_pool().await, &api_url);
    let stats = relay.drain_once().await.expect("drain");
    assert!(stats.published >= 1, "the claimed broadcast was published");

    // The publish carries exactly what the outbox row promised — the relay
    // forwards, it does not author (invariant #2).
    let channel = cent_channel(fixture.workspace, fixture.channel);
    let bodies = mock.bodies_for(&channel);
    assert_eq!(bodies.len(), 1, "exactly one publish for this channel");
    let body = &bodies[0];
    assert_eq!(body["channel"], Value::from(channel.as_str()));
    assert_eq!(
        body["version"],
        Value::from(sent.message.seq),
        "version = message.seq (Centrifugo history dedup)"
    );
    assert_eq!(
        body["idempotency_key"],
        Value::from(format!("{channel}:{}", sent.message.seq)),
        "idempotency_key = <channel>:<seq>"
    );
    assert_eq!(
        body["data"]["type"],
        Value::from("message.new"),
        "the event envelope is forwarded verbatim"
    );
    assert_eq!(
        body["data"]["payload"]["seq"],
        Value::from(sent.message.seq)
    );

    // Server API auth is the X-API-Key header (L4 §4.2).
    let keys: Vec<Option<String>> = mock.received().into_iter().map(|(key, _)| key).collect();
    assert!(
        keys.iter().all(|key| key.as_deref() == Some(TEST_API_KEY)),
        "every publish authenticates with X-API-Key"
    );

    let (status, _, processed, _) = outbox_state(&su, outbox_id).await;
    assert_eq!(status, "done", "a published row settles to done");
    assert!(processed, "processed_at is stamped on success");

    // Scope guard: the message insert's DB trigger also enqueues a
    // `push_candidate` row. The relay owns broadcast ONLY — anything else it
    // drained would be stealing another consumer's work (B1 gate lesson).
    let untouched: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox \
          WHERE partition_key = $1 AND kind <> 'broadcast' AND status <> 'pending'",
    )
    .bind(fixture.channel)
    .fetch_one(&su)
    .await
    .expect("count non-broadcast rows");
    assert_eq!(
        untouched, 0,
        "relay must not claim push_candidate/webhook/agent_job rows"
    );
}

// ---------------------------------------------------------------------------
// claim contention — FOR UPDATE SKIP LOCKED means no double publish
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a fresh pgvector/pg18 DB + bootstrap_roles.sql"]
async fn two_relay_instances_never_double_publish_a_row() {
    let _guard = relay_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let fixture = fixture(&su).await;
    let (mock, api_url) = start_mock_centrifugo(StatusCode::OK).await;

    const MESSAGES: usize = 8;
    let mut outbox_ids = Vec::new();
    for index in 0..MESSAGES {
        let sent = send_message(
            &fixture.app,
            fixture.workspace,
            NewMessage::text(fixture.channel, fixture.member, format!("m{index}"))
                .with_client_msg_id(Uuid::new_v4()),
        )
        .await
        .expect("send message");
        outbox_ids.push(sent.outbox_id.expect("broadcast row"));
    }

    // Two independent relay processes (separate pools, batch size 4) racing.
    let first = relay_for(momo_relay_pool().await, &api_url);
    let second = relay_for(momo_relay_pool().await, &api_url);
    let (left, right) = tokio::join!(first.drain_to_empty(), second.drain_to_empty());
    // `>=` because a claim is global (BYPASSRLS): a concurrently running test
    // binary may have left its own pending rows in this DB. Every assertion that
    // must be exact is scoped to THIS channel below.
    assert!(
        left.published + right.published >= MESSAGES,
        "every row this test wrote was published across the two instances"
    );

    let channel = cent_channel(fixture.workspace, fixture.channel);
    let bodies = mock.bodies_for(&channel);
    assert_eq!(bodies.len(), MESSAGES, "no row was published twice");
    let mut keys: Vec<String> = bodies
        .iter()
        .map(|body| body["idempotency_key"].as_str().unwrap_or("").to_string())
        .collect();
    keys.sort();
    let unique = {
        let mut unique = keys.clone();
        unique.dedup();
        unique
    };
    assert_eq!(
        keys, unique,
        "SKIP LOCKED must prevent duplicate idempotency keys"
    );

    for id in outbox_ids {
        let (status, attempts, processed, _) = outbox_state(&su, id).await;
        assert_eq!(status, "done", "row {id} settled");
        assert_eq!(attempts, 1, "row {id} was claimed exactly once");
        assert!(processed, "row {id} stamped");
    }
}

// ---------------------------------------------------------------------------
// transient failure — back to pending with backoff, attempts incremented
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a fresh pgvector/pg18 DB + bootstrap_roles.sql"]
async fn a_5xx_publish_requeues_with_backoff_instead_of_dropping() {
    let _guard = relay_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let fixture = fixture(&su).await;
    let (mock, api_url) = start_mock_centrifugo(StatusCode::INTERNAL_SERVER_ERROR).await;

    let sent = send_message(
        &fixture.app,
        fixture.workspace,
        NewMessage::text(fixture.channel, fixture.member, "will fail")
            .with_client_msg_id(Uuid::new_v4()),
    )
    .await
    .expect("send message");
    let outbox_id = sent.outbox_id.expect("broadcast row");

    let relay = relay_for(momo_relay_pool().await, &api_url);
    let stats = relay.drain_once().await.expect("drain");
    assert!(stats.requeued >= 1, "a 5xx is transient, not terminal");

    let channel = cent_channel(fixture.workspace, fixture.channel);
    assert_eq!(
        mock.bodies_for(&channel).len(),
        1,
        "the publish was attempted once"
    );

    let (status, attempts, processed, backed_off) = outbox_state(&su, outbox_id).await;
    assert_eq!(status, "pending", "a transient failure returns to pending");
    assert_eq!(attempts, 1, "the claim incremented attempts");
    assert!(!processed, "processed_at stays NULL until it succeeds");
    assert!(
        backed_off,
        "available_at moves into the future (exponential backoff)"
    );
}
