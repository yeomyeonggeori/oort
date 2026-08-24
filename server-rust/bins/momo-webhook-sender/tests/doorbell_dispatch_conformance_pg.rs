//! ADR-0171 WD-1 doorbell dispatch — coalescing, disconnect, Q-LOOP, flag off.
//!
//! ```text
//! DATABASE_URL=postgres://momo:change-me-postgres@localhost:23202/momo \
//!   cargo test -p momo-webhook-sender --test doorbell_dispatch_conformance_pg -- --ignored --nocapture --test-threads=1
//! ```

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::PgPoolOptions;
use momo_db::{with_tenant_tx, PgPool};
use momo_messaging::NewMessage;
use momo_webhook::{seal_doorbell_secret, OutboundUrl};
use momo_webhook_sender::delivery::DeliveryResult;
use momo_webhook_sender::{DoorbellTransport, DoorbellWorker, SenderConfig};
use uuid::Uuid;

const TEST_MASTER_KEY: &str = "doorbell-dispatch-master-key";
const DOORBELL_SECRET: &str = "crsr_live_dispatch_secret_value";

const HOSTED_SCOPES: [&str; 6] = [
    "agent:port:connect",
    "agent:inbox:read",
    "messages:read",
    "messages:write",
    "agent:jobs:read",
    "agent:runs:callback",
];

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL")
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect")
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
    panic!("psql not found");
}

fn ensure_schema() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None).expect("migrations");
    let path = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/e2e/bootstrap_roles.sql"
    ));
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args([
            "-v",
            "ON_ERROR_STOP=1",
            "--no-psqlrc",
            "--quiet",
            "--single-transaction",
            "-f",
        ])
        .arg(path)
        .status()
        .expect("psql");
    assert!(status.success());
    *ready = true;
}

#[derive(Clone)]
struct RecordingTransport {
    rings: Arc<AtomicUsize>,
    bodies: Arc<Mutex<Vec<Vec<u8>>>>,
    auths: Arc<Mutex<Vec<String>>>,
}

impl RecordingTransport {
    fn new() -> Self {
        RecordingTransport {
            rings: Arc::new(AtomicUsize::new(0)),
            bodies: Arc::new(Mutex::new(Vec::new())),
            auths: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

impl DoorbellTransport for RecordingTransport {
    async fn ring(&self, _url: &OutboundUrl, secret: &str, body: &[u8]) -> DeliveryResult {
        self.rings.fetch_add(1, Ordering::SeqCst);
        self.bodies.lock().unwrap().push(body.to_vec());
        self.auths.lock().unwrap().push(format!("Bearer {secret}"));
        DeliveryResult::Ok(200)
    }
}

struct Hosted {
    workspace: Uuid,
    human: Uuid,
    agent: Uuid,
    connection: Uuid,
    channel: Uuid,
}

async fn seed_hosted(pool: &PgPool) -> Hosted {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace(id, slug, name) VALUES($1,$2,$2)")
        .bind(workspace)
        .bind(format!("dd-{}", workspace.simple()))
        .execute(pool)
        .await
        .expect("ws");
    let human = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) \
         VALUES($1,$2,'human','Owner',$3)",
    )
    .bind(human)
    .bind(workspace)
    .bind(format!("o-{}", human.simple()))
    .execute(pool)
    .await
    .expect("human");
    sqlx::query(
        "INSERT INTO workspace_membership(workspace_id, member_id, role) VALUES($1,$2,'owner')",
    )
    .bind(workspace)
    .bind(human)
    .execute(pool)
    .await
    .expect("wm");
    let agent = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) \
         VALUES($1,$2,'agent','hosted',$3)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(format!("a-{}", agent.simple()))
    .execute(pool)
    .await
    .expect("agent");
    sqlx::query(
        "INSERT INTO agent(member_id, workspace_id, model, base_url, owner_human_id, config) \
         VALUES($1,$2,'hosted-agent','https://hosted-agent.invalid/disabled',$3, \
                '{\"execution_mode\":\"hosted_dial_in\"}'::jsonb)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(human)
    .execute(pool)
    .await
    .expect("agent row");
    sqlx::query(
        "INSERT INTO workspace_membership(workspace_id, member_id, role) VALUES($1,$2,'member')",
    )
    .bind(workspace)
    .bind(agent)
    .execute(pool)
    .await
    .expect("agent wm");
    sqlx::query(
        "INSERT INTO agent_profile(agent_member_id, workspace_id, updated_by, paused) \
         VALUES($1,$2,$3,false)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(human)
    .execute(pool)
    .await
    .expect("profile");
    let channel = Uuid::new_v4();
    sqlx::query("INSERT INTO channel(id, workspace_id, kind, name) VALUES($1,$2,'public','r')")
        .bind(channel)
        .bind(workspace)
        .execute(pool)
        .await
        .expect("ch");
    sqlx::query("INSERT INTO channel_seq(channel_id, workspace_id, last_seq) VALUES($1,$2,0)")
        .bind(channel)
        .bind(workspace)
        .execute(pool)
        .await
        .expect("seq");
    for member in [human, agent] {
        sqlx::query("INSERT INTO membership(workspace_id, channel_id, member_id) VALUES($1,$2,$3)")
            .bind(workspace)
            .bind(channel)
            .bind(member)
            .execute(pool)
            .await
            .expect("cm");
    }
    let connection = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO hosted_agent_connection( \
           id,workspace_id,agent_member_id,status,pairing_consumed_at,detected_at,detected_by, \
           confirmed_by,confirmed_at,approved_channel_ids,approved_scopes,created_by) \
         VALUES($1,$2,$3,'detected',now(),now(),$4,$4,now(),$5, \
           ARRAY['agent:port:connect','agent:inbox:read','messages:read','messages:write', \
                 'agent:jobs:read','agent:runs:callback']::text[],$4)",
    )
    .bind(connection)
    .bind(workspace)
    .bind(agent)
    .bind(human)
    .bind(vec![channel])
    .execute(pool)
    .await
    .expect("hc");
    let bearer = format!("momo_agent_v1.{workspace}.{}", Uuid::new_v4().simple());
    let scopes: Vec<String> = HOSTED_SCOPES.iter().map(|s| (*s).to_string()).collect();
    let token: Uuid = sqlx::query_scalar(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label, \
                           credential_class, hosted_connection_id, audience, created_by) \
         VALUES($1,'agent_bearer',$2,digest($3::text,'sha256'),$4,'h', \
                'hosted_active',$5,'/v1/mcp/agent-port',$6) RETURNING id",
    )
    .bind(workspace)
    .bind(agent)
    .bind(&bearer)
    .bind(&scopes)
    .bind(connection)
    .bind(human)
    .fetch_one(pool)
    .await
    .expect("token");
    sqlx::query(
        "UPDATE hosted_agent_connection SET status='active', active_token_id=$3, \
           proved_at=now(), proved_by=$4 WHERE workspace_id=$1 AND id=$2",
    )
    .bind(workspace)
    .bind(connection)
    .bind(token)
    .bind(agent)
    .execute(pool)
    .await
    .expect("active");
    Hosted {
        workspace,
        human,
        agent,
        connection,
        channel,
    }
}

async fn register_doorbell(pool: &PgPool, hosted: &Hosted) {
    // BYPASSRLS drain sees every tenant. Isolate this test's row so a sibling
    // test's pending wake cannot inflate the fire count.
    sqlx::query("DELETE FROM hosted_agent_doorbell")
        .execute(pool)
        .await
        .expect("isolate doorbells");
    let sealed = seal_doorbell_secret(DOORBELL_SECRET, TEST_MASTER_KEY).expect("seal");
    sqlx::query(
        "INSERT INTO hosted_agent_doorbell \
           (workspace_id, connection_id, url, secret_sealed, secret_masked, registered_by) \
         VALUES ($1,$2,'https://example.com/hook',$3,'••••alue',$4)",
    )
    .bind(hosted.workspace)
    .bind(hosted.connection)
    .bind(sealed)
    .bind(hosted.human)
    .execute(pool)
    .await
    .expect("doorbell");
}

async fn append_message(pool: &PgPool, hosted: &Hosted, author: Uuid, body: &str) {
    let workspace = hosted.workspace;
    let channel = hosted.channel;
    let body = body.to_string();
    with_tenant_tx(pool, workspace, move |conn| {
        Box::pin(async move {
            let sent = momo_messaging::send_message_in_tx(
                conn,
                workspace,
                NewMessage::text(channel, author, body),
            )
            .await?;
            momo_messaging::fan_out_message_reference_in_tx(
                conn,
                workspace,
                channel,
                sent.message.id,
                author,
            )
            .await?;
            Ok(())
        })
    })
    .await
    .expect("send+fanout");
}

async fn append_human_message(pool: &PgPool, hosted: &Hosted) {
    append_message(pool, hosted, hosted.human, "hello").await;
}

async fn append_agent_message(pool: &PgPool, hosted: &Hosted) {
    append_message(pool, hosted, hosted.agent, "i am the agent").await;
}

fn worker(
    pool: PgPool,
    transport: RecordingTransport,
    enabled: bool,
) -> DoorbellWorker<RecordingTransport> {
    let mut config =
        SenderConfig::for_target(database_url(), TEST_MASTER_KEY).with_doorbell_enabled(enabled);
    config.doorbell_cooldown = Duration::from_secs(60);
    config.allow_development_http = true;
    DoorbellWorker::new(pool, transport, config)
}

/// AC3: burst inside the window → ≤2 fires (leading + trailing).
/// RED: fire-every-event would ring 5 times.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn a_cooldown_window_coalesces_a_burst_to_leading_and_trailing() {
    ensure_schema();
    let pool = superuser_pool().await;
    let hosted = seed_hosted(&pool).await;
    register_doorbell(&pool, &hosted).await;
    let transport = RecordingTransport::new();
    let worker = worker(pool.clone(), transport.clone(), true);

    append_human_message(&pool, &hosted).await;
    let first = worker.drain_once().await.expect("drain 1");
    assert_eq!(first.fired, 1, "leading fire");
    assert_eq!(transport.rings.load(Ordering::SeqCst), 1);

    for _ in 0..4 {
        append_human_message(&pool, &hosted).await;
    }
    let mid = worker.drain_once().await.expect("drain 2");
    assert_eq!(mid.fired, 0, "AC3 red: fire-per-event would fail here");
    assert!(mid.coalesced >= 1);
    assert_eq!(transport.rings.load(Ordering::SeqCst), 1);

    sqlx::query(
        "UPDATE hosted_agent_doorbell SET window_started_at = now() - interval '61 seconds' \
          WHERE connection_id = $1",
    )
    .bind(hosted.connection)
    .execute(&pool)
    .await
    .expect("expire window");
    let trail = worker.drain_once().await.expect("drain 3");
    assert_eq!(trail.fired, 1, "trailing fire");
    assert_eq!(
        transport.rings.load(Ordering::SeqCst),
        2,
        "AC3: burst must be ≤2"
    );
    let body = transport.bodies.lock().unwrap();
    assert_eq!(body.len(), 2);
    assert_eq!(body[0], br#"{"kind":"oort.doorbell.v1"}"#);
    assert!(
        !std::str::from_utf8(&body[0])
            .unwrap()
            .contains(&hosted.workspace.to_string()),
        "D2: payload must not name the workspace"
    );
}

/// AC4: disconnect clears the doorbell; subsequent inbox events fire 0.
/// RED: leaving the row would still ring.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn a_disconnected_connection_fires_zero_doorbells() {
    ensure_schema();
    let pool = superuser_pool().await;
    let hosted = seed_hosted(&pool).await;
    register_doorbell(&pool, &hosted).await;
    let mut tx = pool.begin().await.expect("tx");
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(hosted.workspace.to_string())
        .execute(&mut *tx)
        .await
        .ok();
    let started = momo_auth::start_hosted_disconnect_in_tx(
        &mut tx,
        hosted.workspace,
        hosted.connection,
        hosted.human,
        &[],
    )
    .await
    .expect("disconnect");
    assert!(matches!(
        started,
        momo_auth::HostedDisconnectStart::Applied(_)
    ));
    tx.commit().await.expect("commit");
    let left: i64 = sqlx::query_scalar(
        "SELECT count(*)::bigint FROM hosted_agent_doorbell WHERE connection_id=$1",
    )
    .bind(hosted.connection)
    .fetch_one(&pool)
    .await
    .expect("count");
    assert_eq!(
        left, 0,
        "AC4 red: skipping clear_hosted_doorbell_in_tx leaves the row"
    );

    append_human_message(&pool, &hosted).await;
    let transport = RecordingTransport::new();
    let worker = worker(pool.clone(), transport.clone(), true);
    let stats = worker.drain_once().await.expect("drain");
    assert_eq!(stats.fired, 0);
    assert_eq!(transport.rings.load(Ordering::SeqCst), 0);
}

/// AC5 Q-LOOP: the agent's own message does not enter its inbox, so no fire.
/// RED: dropping the author skip in fan_out would ring.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn an_agents_own_message_does_not_ring_its_doorbell() {
    ensure_schema();
    let pool = superuser_pool().await;
    let hosted = seed_hosted(&pool).await;
    register_doorbell(&pool, &hosted).await;
    append_agent_message(&pool, &hosted).await;
    let seq: i64 = sqlx::query_scalar(
        "SELECT COALESCE(last_seq,0) FROM hosted_agent_inbox_counter \
          WHERE connection_id=$1",
    )
    .bind(hosted.connection)
    .fetch_optional(&pool)
    .await
    .expect("seq")
    .unwrap_or(0);
    assert_eq!(
        seq, 0,
        "Q-LOOP red: fan_out including the author would bump inbox_seq"
    );
    let transport = RecordingTransport::new();
    let worker = worker(pool.clone(), transport.clone(), true);
    let stats = worker.drain_once().await.expect("drain");
    assert_eq!(stats.fired, 0);
    assert_eq!(transport.rings.load(Ordering::SeqCst), 0);
}

/// AC6: flag off drain is a no-op even with pending inbox.
/// RED: ignoring doorbell_enabled would fire.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn flag_off_dispatch_is_a_noop() {
    ensure_schema();
    let pool = superuser_pool().await;
    let hosted = seed_hosted(&pool).await;
    register_doorbell(&pool, &hosted).await;
    append_human_message(&pool, &hosted).await;
    let transport = RecordingTransport::new();
    let worker = worker(pool.clone(), transport.clone(), false);
    let stats = worker.drain_once().await.expect("drain");
    assert_eq!(stats.claimed, 0);
    assert_eq!(stats.fired, 0);
    assert_eq!(
        transport.rings.load(Ordering::SeqCst),
        0,
        "AC6 red: drain without the gate would POST"
    );
}
