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
        "/../../../infra/rust/sql/bootstrap_roles.sql"
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
    /// #3822: when set, the vendor answers 404 (a permanent give-up, no retry sleep).
    fail: Arc<std::sync::atomic::AtomicBool>,
}

impl RecordingTransport {
    fn new() -> Self {
        RecordingTransport {
            fail: Arc::new(std::sync::atomic::AtomicBool::new(false)),
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
        if self.fail.load(Ordering::SeqCst) {
            return DeliveryResult::Permanent {
                reason: "not found".to_string(),
                status: Some(404),
            };
        }
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
                true,
                true,
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

/// ADR-0200 D4 「다시 깨우기」 (#3743): a manual ring rings the SAME doorbell the same
/// way — one content-free signal through the sender's ordinary drain, nothing new on
/// the wire — even with no inbox event at all, even inside the cooldown window of a
/// ring that just happened; and it fires once, not on every later drain.
///
/// Tamper table:
///   * the ring does not clear `window_started_at`          -> the second ring (inside a fresh window) never fires
///   * the ring does not set `pending_trailing`             -> nothing fires
///   * the sender consumed nothing (no `consume_for_fire`)  -> every later drain fires again
///   * a ring that carried an identifier                    -> the body assertion fails
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn a_manual_ring_fires_the_same_content_free_signal_once_without_an_inbox_event() {
    ensure_schema();
    let pool = superuser_pool().await;
    let hosted = seed_hosted(&pool).await;
    register_doorbell(&pool, &hosted).await;
    let transport = RecordingTransport::new();
    let worker = worker(pool.clone(), transport.clone(), true);

    // a real ring just happened: the cooldown window is open
    append_human_message(&pool, &hosted).await;
    assert_eq!(worker.drain_once().await.expect("drain").fired, 1);
    assert_eq!(transport.rings.load(Ordering::SeqCst), 1);

    let ring = |hosted: &Hosted| {
        let (workspace, connection, human) = (hosted.workspace, hosted.connection, hosted.human);
        let pool = pool.clone();
        async move {
            with_tenant_tx(&pool, workspace, move |conn| {
                Box::pin(async move {
                    momo_webhook::request_manual_ring_in_tx(
                        conn, workspace, connection, human, true,
                    )
                    .await
                })
            })
            .await
            .expect("ring tx")
        }
    };
    assert!(matches!(
        ring(&hosted).await,
        momo_webhook::RingOutcome::Requested { .. }
    ));
    let stats = worker.drain_once().await.expect("drain after ring");
    assert_eq!(
        stats.fired, 1,
        "the ring fires inside the open window: {stats:?}"
    );
    assert_eq!(transport.rings.load(Ordering::SeqCst), 2);
    let bodies = transport.bodies.lock().unwrap().clone();
    assert_eq!(
        bodies[1], br#"{"kind":"oort.doorbell.v1"}"#,
        "same body, no identifier"
    );

    // consumed: later drains do not ring again
    let again = worker.drain_once().await.expect("drain again");
    assert_eq!(again.fired, 0);
    assert_eq!(transport.rings.load(Ordering::SeqCst), 2);

    // and the result is recorded where every ring's is
    let (status, fired_at): (Option<String>, Option<chrono::DateTime<chrono::Utc>>) =
        sqlx::query_as(
            "SELECT last_status, last_fired_at FROM hosted_agent_doorbell WHERE connection_id=$1",
        )
        .bind(hosted.connection)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(
        status.as_deref().is_some_and(|s| s.starts_with("ok_")),
        "{status:?}"
    );
    assert!(fired_at.is_some());
}

// ---------------------------------------------------------------------------
// #3822 — tracked work wakes without waiting out the message cooldown; the ring is
// recorded on the waiting runs' ledger.
// ---------------------------------------------------------------------------

/// A queued hosted run with its gateway job and the inbox `agent_job` reference, exactly
/// the three rows the real producer writes in one transaction.
async fn append_job(pool: &PgPool, hosted: &Hosted) -> Uuid {
    let run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run(id,workspace_id,agent_member_id,channel_id,idempotency_key) \
         VALUES($1,$2,$3,$4,$5)",
    )
    .bind(run)
    .bind(hosted.workspace)
    .bind(hosted.agent)
    .bind(hosted.channel)
    .bind(run.to_string())
    .execute(pool)
    .await
    .expect("run");
    let job: i64 = sqlx::query_scalar(
        "INSERT INTO outbox(workspace_id,kind,status,method,payload,partition_key) \
         VALUES($1,'agent_job','pending','gateway', \
           jsonb_build_object('run_id',upper($2::text),'agent_member_id',upper($3::text)),$3) \
         RETURNING id",
    )
    .bind(hosted.workspace)
    .bind(run.to_string())
    .bind(hosted.agent)
    .fetch_one(pool)
    .await
    .expect("job");
    let (workspace, agent, connection, channel) = (
        hosted.workspace,
        hosted.agent,
        hosted.connection,
        hosted.channel,
    );
    with_tenant_tx(pool, workspace, move |conn| {
        Box::pin(async move {
            momo_messaging::append_job_reference_in_tx(
                conn, workspace, agent, connection, channel, job, run,
            )
            .await?;
            Ok(())
        })
    })
    .await
    .expect("job reference");
    run
}

async fn expire_window(pool: &PgPool, hosted: &Hosted, seconds: i32) {
    sqlx::query(
        "UPDATE hosted_agent_doorbell \
            SET window_started_at = now() - make_interval(secs => $2) WHERE connection_id = $1",
    )
    .bind(hosted.connection)
    .bind(f64::from(seconds))
    .execute(pool)
    .await
    .expect("age window");
}

/// RED: without `coalesce_action_with_jobs` the job would be `MarkTrailing` and wait out
/// the 60 s window (the 4-minute-old complaint's first suspect). Message-only stays coalesced.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn a_tracked_job_wakes_inside_the_cooldown_but_a_message_does_not() {
    ensure_schema();
    let pool = superuser_pool().await;
    let hosted = seed_hosted(&pool).await;
    register_doorbell(&pool, &hosted).await;
    let transport = RecordingTransport::new();
    let worker = worker(pool.clone(), transport.clone(), true);

    append_human_message(&pool, &hosted).await;
    assert_eq!(worker.drain_once().await.expect("leading").fired, 1);

    // a message inside the open window: coalesced, nothing fires
    append_human_message(&pool, &hosted).await;
    let msg = worker.drain_once().await.expect("message");
    assert_eq!((msg.fired, msg.urgent), (0, 0), "{msg:?}");
    assert_eq!(transport.rings.load(Ordering::SeqCst), 1);

    // age the window past the 10 s urgent gap but not past the 60 s cooldown
    expire_window(&pool, &hosted, 15).await;
    append_job(&pool, &hosted).await;
    let job = worker.drain_once().await.expect("job");
    assert_eq!((job.fired, job.urgent), (1, 1), "{job:?}");
    assert_eq!(
        transport.rings.load(Ordering::SeqCst),
        2,
        "the job rang inside the 60 s window"
    );
}

/// The flood bound: a burst of jobs rings once per urgent gap, not once per job.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn a_burst_of_jobs_rings_once_per_urgent_gap_and_loses_none() {
    ensure_schema();
    let pool = superuser_pool().await;
    let hosted = seed_hosted(&pool).await;
    register_doorbell(&pool, &hosted).await;
    let transport = RecordingTransport::new();
    let worker = worker(pool.clone(), transport.clone(), true);

    append_job(&pool, &hosted).await;
    assert_eq!(worker.drain_once().await.expect("first").fired, 1); // leading
    for _ in 0..5 {
        append_job(&pool, &hosted).await;
    }
    // window just opened (gap running): the five jobs are held back (not even claimed) and
    // none is consumed
    let held = worker.drain_once().await.expect("held");
    assert_eq!((held.claimed, held.fired), (0, 0), "{held:?}");
    let again = worker.drain_once().await.expect("held again");
    assert_eq!(again.fired, 0, "RED: one fire per job would be 5");
    assert_eq!(transport.rings.load(Ordering::SeqCst), 1);

    // the gap ends: ONE urgent ring covers the five jobs
    expire_window(&pool, &hosted, 11).await;
    let covered = worker.drain_once().await.expect("covered");
    assert_eq!((covered.fired, covered.urgent), (1, 1), "{covered:?}");
    assert_eq!(transport.rings.load(Ordering::SeqCst), 2);
    let quiet = worker.drain_once().await.expect("quiet");
    assert_eq!(quiet.fired, 0, "consumed: nothing left to ring for");
}

async fn rung_codes(pool: &PgPool, run: Uuid) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT code FROM agent_run_event WHERE run_id=$1 AND kind='doorbell_rung' ORDER BY seq",
    )
    .bind(run)
    .fetch_all(pool)
    .await
    .expect("rung codes")
}

/// The ring lands on the waiting run's ledger as one closed token; a claimed run, a
/// run that finished and a failed ring are told apart; the per-run cap holds; and the
/// rung never counts as run activity.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn a_ring_is_recorded_on_the_waiting_runs_ledger_and_only_there() {
    ensure_schema();
    let pool = superuser_pool().await;
    let hosted = seed_hosted(&pool).await;
    register_doorbell(&pool, &hosted).await;
    let transport = RecordingTransport::new();
    let worker = worker(pool.clone(), transport.clone(), true);

    let waiting = append_job(&pool, &hosted).await;
    let claimed = append_job(&pool, &hosted).await;
    let done = append_job(&pool, &hosted).await;
    sqlx::query("SELECT agent_run_event_append($1,$2,'claimed')")
        .bind(hosted.workspace)
        .bind(claimed)
        .execute(&pool)
        .await
        .expect("claimed row");
    sqlx::query("UPDATE agent_run SET status='cancelled' WHERE id=$1")
        .bind(done)
        .execute(&pool)
        .await
        .expect("cancel");
    let queued_at: chrono::DateTime<chrono::Utc> = sqlx::query_scalar(
        "SELECT max(created_at) FROM agent_run_event WHERE run_id=$1 AND kind='queued'",
    )
    .bind(waiting)
    .fetch_one(&pool)
    .await
    .expect("queued_at");

    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(worker.drain_once().await.expect("leading").fired, 1);
    assert_eq!(rung_codes(&pool, waiting).await, ["leading_ok"]);
    assert!(
        rung_codes(&pool, claimed).await.is_empty(),
        "already claimed"
    );
    assert!(
        rung_codes(&pool, done).await.is_empty(),
        "no longer waiting"
    );

    // a rung is not run activity: last_event_at is still the `queued` row's time
    let (workspace, channel) = (hosted.workspace, hosted.channel);
    let app = superuser_pool().await;
    let base = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            momo_agent::list_channel_run_progress_base_in_tx(conn, workspace, channel, true, 10)
                .await
        })
    })
    .await
    .expect("progress base");
    let row = base.iter().find(|r| r.summary.id == waiting).expect("row");
    assert_eq!(
        row.last_event_at,
        Some(queued_at),
        "RED: counting doorbell_rung would move last_event_at past the ring"
    );

    // the default read leaves the rung out (a client built before the kind rejects a
    // ledger with a kind it does not know); `include=doorbell` asks for it
    let (human, run_id) = (hosted.human, waiting);
    let (plain, with_rung) = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            let plain = momo_agent::list_run_events_in_tx(conn, workspace, run_id, human, false)
                .await?
                .expect("visible");
            let with_rung = momo_agent::list_run_events_in_tx(conn, workspace, run_id, human, true)
                .await?
                .expect("visible");
            Ok((plain, with_rung))
        })
    })
    .await
    .expect("events");
    assert!(
        plain.iter().all(|e| e.kind != "doorbell_rung"),
        "RED: an old client would reject this ledger"
    );
    let rungs: Vec<_> = with_rung
        .iter()
        .filter(|e| e.kind == "doorbell_rung")
        .collect();
    assert_eq!(rungs.len(), 1);
    assert_eq!(rungs[0].code.as_deref(), Some("leading_ok"));

    // a manual ring is recorded as the trailing edge; a dead vendor as `failed`
    transport.fail.store(true, Ordering::SeqCst);
    sqlx::query(
        "UPDATE hosted_agent_doorbell SET pending_trailing = true, window_started_at = NULL \
          WHERE connection_id = $1",
    )
    .bind(hosted.connection)
    .execute(&pool)
    .await
    .expect("rearm");
    assert_eq!(worker.drain_once().await.expect("trailing").failed, 1);
    assert_eq!(
        rung_codes(&pool, waiting).await,
        ["leading_ok", "trailing_failed"]
    );
    let leaked: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM agent_run_event WHERE kind='doorbell_rung' \
            AND (stage IS NOT NULL OR code ~ '[0-9]' OR approval_id IS NOT NULL \
                 OR actor_member_id IS NOT NULL)",
    )
    .fetch_one(&pool)
    .await
    .expect("leak scan");
    assert_eq!(
        leaked, 0,
        "no HTTP status, host, stage or actor in the ledger"
    );

    // the per-run cap: a run that waits for hours does not grow its ledger without bound
    for _ in 0..30 {
        let (workspace, connection) = (hosted.workspace, hosted.connection);
        with_tenant_tx(&pool, workspace, move |conn| {
            Box::pin(async move {
                momo_webhook::record_doorbell_rung_in_tx(
                    conn, workspace, connection, "trailing", true,
                )
                .await
            })
        })
        .await
        .expect("record");
    }
    assert_eq!(
        rung_codes(&pool, waiting).await.len() as i64,
        momo_webhook::DOORBELL_RUNG_PER_RUN_CAP
    );
}

/// A foreign workspace's waiting run never gets this connection's ring.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn a_ring_never_marks_another_connections_or_workspaces_run() {
    ensure_schema();
    let pool = superuser_pool().await;
    let mine = seed_hosted(&pool).await;
    let other = seed_hosted(&pool).await;
    register_doorbell(&pool, &mine).await;
    let transport = RecordingTransport::new();
    let worker = worker(pool.clone(), transport.clone(), true);

    let mine_run = append_job(&pool, &mine).await;
    let other_run = append_job(&pool, &other).await;
    assert_eq!(worker.drain_once().await.expect("drain").fired, 1);
    assert_eq!(rung_codes(&pool, mine_run).await, ["leading_ok"]);
    assert!(
        rung_codes(&pool, other_run).await.is_empty(),
        "RED: dropping the connection/workspace join would mark it"
    );
}

/// Security review H-1: connections whose only news is a job inside the urgent gap are not
/// claimed at all. Without that, a full batch of them is re-claimed on every pass (nothing is
/// consumed), so the drain spins and the connections behind them starve.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn connections_held_back_by_the_urgent_gap_do_not_spin_the_drain_or_starve_others() {
    ensure_schema();
    let pool = superuser_pool().await;
    sqlx::query("DELETE FROM hosted_agent_doorbell")
        .execute(&pool)
        .await
        .expect("isolate doorbells");
    let sealed = seal_doorbell_secret(DOORBELL_SECRET, TEST_MASTER_KEY).expect("seal");
    let transport = RecordingTransport::new();
    let worker = worker(pool.clone(), transport.clone(), true);

    let batch = 16;
    let mut held = Vec::new();
    for _ in 0..batch + 2 {
        let hosted = seed_hosted(&pool).await;
        sqlx::query(
            "INSERT INTO hosted_agent_doorbell \
               (workspace_id, connection_id, url, secret_sealed, secret_masked, registered_by, \
                window_started_at) \
             VALUES ($1,$2,'https://example.com/hook',$3,'••••alue',$4, now())",
        )
        .bind(hosted.workspace)
        .bind(hosted.connection)
        .bind(&sealed)
        .bind(hosted.human)
        .execute(&pool)
        .await
        .expect("doorbell");
        append_job(&pool, &hosted).await;
        held.push(hosted);
    }

    let held_pass = worker.drain_once().await.expect("held pass");
    assert_eq!(
        (held_pass.claimed, held_pass.fired),
        (0, 0),
        "RED: claiming the held rows is what spins the drain: {held_pass:?}"
    );
    let total = worker.drain_to_empty().await;
    assert_eq!(total.fired, 0, "{total:?}");
    assert_eq!(transport.rings.load(Ordering::SeqCst), 0);

    // the gap ends for all of them: each gets exactly one ring (the batch loops, no starvation)
    sqlx::query(
        "UPDATE hosted_agent_doorbell SET window_started_at = now() - interval '11 seconds'",
    )
    .execute(&pool)
    .await
    .expect("age");
    let total = worker.drain_to_empty().await;
    assert_eq!(
        (total.fired, total.urgent),
        (batch as usize + 2, batch as usize + 2),
        "{total:?}"
    );
    assert_eq!(transport.rings.load(Ordering::SeqCst), batch as usize + 2);
}

/// Security review L-4: one ring marks at most DOORBELL_RUNG_RUNS_PER_RING waiting runs.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn one_ring_marks_at_most_twenty_waiting_runs() {
    ensure_schema();
    let pool = superuser_pool().await;
    let hosted = seed_hosted(&pool).await;
    register_doorbell(&pool, &hosted).await;
    let transport = RecordingTransport::new();
    let worker = worker(pool.clone(), transport.clone(), true);
    let mut runs = Vec::new();
    for _ in 0..25 {
        runs.push(append_job(&pool, &hosted).await);
    }
    assert_eq!(worker.drain_once().await.expect("leading").fired, 1);
    let marked: i64 = sqlx::query_scalar(
        "SELECT count(DISTINCT run_id) FROM agent_run_event \
          WHERE workspace_id=$1 AND kind='doorbell_rung'",
    )
    .bind(hosted.workspace)
    .fetch_one(&pool)
    .await
    .expect("count");
    assert_eq!(marked, momo_webhook::DOORBELL_RUNG_RUNS_PER_RING);
}
