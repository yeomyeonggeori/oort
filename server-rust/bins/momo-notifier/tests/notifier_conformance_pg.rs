//! DB-backed conformance for the T3 durability worker (ADR-0140 D4 / ADR-0142
//! D3.1 / ADR-0125 D11, batch B2.3).
//!
//! These are the orchestrator's docker-gate red tests. Each proves one property
//! of "a host or a process died and the money still converged", with a named
//! assertion that goes red when the enforcement is reverted. They are `#[ignore]`
//! because they need a `pgvector/pgvector:pg18` database plus the runtime roles:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-notifier --test notifier_conformance_pg -- --ignored --nocapture
//! ```
//!
//! Harness contract (same as `momo-t3` and `momo-relay`):
//!   * `DATABASE_URL` connects as a **superuser** — applies every migration plus
//!     `infra/e2e/bootstrap_roles.sql`, and seeds/oracles rows bypassing RLS;
//!   * paid sessions are opened as **`momo_app`** (NOBYPASSRLS), the runtime role;
//!   * both notifier loops run as **`momo_notifier`** (BYPASSRLS) — the
//!     credential boundary that lets one process converge every tenant.
//!
//! A fresh database is not required (B1.6 migration runner). Both loops claim
//! **globally** by design, so — exactly like the relay suite — the tests
//! serialize on a process-wide lock and park any residue another binary left
//! before each run (`focus_lifecycle_intents`, `freshen_residual_hosts`).
//! Parking is non-destructive: it moves a row's next attempt out of the window
//! and refreshes a heartbeat, and never settles or transitions anything.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `d4_1_provider_missing_settles_once_and_only_on_an_honest_probe` | read `probe == present` as permission to settle (ADR-0142 D3.1), or move settlement out of `t3_terminate` |
//! | `d4_2_deadline_converges_on_the_probed_fact` | let the deadline branch guess instead of probing, or read `unknown` as `absent` |
//! | `d4_3_two_instances_settle_exactly_once` | drop the advisory/version claim in `t3_claim_lifecycle_operation` |
//! | `d4_4_sweep_settles_a_lost_host_and_spares_a_paused_one` | drop the paused-host exclusion or the grace re-check in the sweep |

use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};

use chrono::{DateTime, Utc};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::PgPool;
use momo_notifier::{FixedAdapterResolver, Notifier, NotifierConfig};
use momo_provider::{CloudInstancePresence, CloudInstanceRef, CloudProviderAdapter as _};
use momo_t3::provider::registry::MOCK_A_PROVIDER_ID;
use momo_t3::{
    bind_cloud_host_in_tx, create_work_session_in_tx, reserve_provisioning_slot_in_tx,
    start_usage_in_tx, with_t3_lifecycle_tx, CloudHostState, MockProviderAdapter, NewWorkSession,
    T3LockLadder,
};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::Row;
use uuid::Uuid;

/// micro-USD per active second for every fixture host.
const UNIT_RATE: i64 = 25;
/// Seeded workspace credit, comfortably above any fixture debit.
const TOPUP_MICRO_USD: i64 = 1_000_000_000;
/// The fixture heartbeat grace, small enough to state exactly in a test.
const GRACE_SECONDS: i64 = 90;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
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

/// The BYPASSRLS notifier credential (`bootstrap_roles.sql:33`): one process,
/// every tenant.
async fn momo_notifier_pool() -> PgPool {
    role_pool(
        "momo_notifier",
        role_password("MOMO_NOTIFIER_PASSWORD", "momo_notifier_dev_pw"),
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
        .expect("apply all migrations");
    apply_bootstrap_roles();
    *ready = true;
}

/// Both loops claim globally (BYPASSRLS), so two concurrent notifier tests would
/// converge each other's fixtures. Serialize them.
async fn notifier_test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

// ---------------------------------------------------------------------------
// shared-DB isolation (relay harness pattern)
// ---------------------------------------------------------------------------

/// Arm the durable intents this step is about and push every other one out of
/// the claim window. Non-destructive: it only schedules, it never converges.
async fn focus_lifecycle_intents(su: &PgPool, keep: &[Uuid]) {
    sqlx::query(
        "UPDATE work_cloud_host \
            SET lifecycle_operation_next_attempt_at = CASE \
                  WHEN id = ANY($1) THEN clock_timestamp() - interval '1 second' \
                  ELSE clock_timestamp() + interval '1 hour' END \
          WHERE state IN ('pausing', 'resuming', 'destroy_pending')",
    )
    .bind(keep)
    .execute(su)
    .await
    .expect("focus the durable intents under test");
}

/// Make every host this test does not own look alive, and clear the lost marker
/// on sessions it does not own, so the sweep's candidate set is exactly ours.
async fn freshen_residual_hosts(su: &PgPool, keep: &[Uuid]) {
    sqlx::query("UPDATE work_host SET last_seen_at = clock_timestamp() WHERE NOT (id = ANY($1))")
        .bind(keep)
        .execute(su)
        .await
        .expect("freshen residual host heartbeats");
    sqlx::query(
        "UPDATE work_session SET host_lost_at = NULL \
          WHERE host_lost_at IS NOT NULL AND NOT (host_id = ANY($1))",
    )
    .bind(keep)
    .execute(su)
    .await
    .expect("clear residual host-lost markers");
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

struct Tenant {
    workspace_id: Uuid,
    member_id: Uuid,
    channel_id: Uuid,
    root_message_id: Uuid,
}

/// One paid T3 session: the cloud host, the work host identity and the session
/// whose ledger is open.
#[derive(Clone, Copy)]
struct PaidSession {
    workspace_id: Uuid,
    cloud_host_id: Uuid,
    host_id: Uuid,
    session_id: Uuid,
}

async fn seed_tenant(su: &PgPool) -> Tenant {
    let workspace_id = Uuid::new_v4();
    let member_id = Uuid::new_v4();
    let channel_id = Uuid::new_v4();

    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace_id)
        .bind(workspace_id.to_string())
        .execute(su)
        .await
        .expect("seed workspace");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human'::member_kind, $3, $3)",
    )
    .bind(member_id)
    .bind(workspace_id)
    .bind(member_id.to_string())
    .execute(su)
    .await
    .expect("seed member");
    sqlx::query("INSERT INTO channel (id, workspace_id, kind, name) VALUES ($1, $2, 'public', $3)")
        .bind(channel_id)
        .bind(workspace_id)
        .bind(format!("nt-{}", &channel_id.simple().to_string()[..8]))
        .execute(su)
        .await
        .expect("seed channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 1)")
        .bind(channel_id)
        .bind(workspace_id)
        .execute(su)
        .await
        .expect("seed channel_seq");
    let root_message_id: Uuid = sqlx::query_scalar(
        "INSERT INTO message \
           (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body) \
         VALUES ($1, $2, 1, 1, 0, $3, 'system', 't3 run card') \
         RETURNING id",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(member_id)
    .fetch_one(su)
    .await
    .expect("seed root message");

    sqlx::query(
        "INSERT INTO credit_entry (workspace_id, delta_micro_usd, reason, ref_id) \
         VALUES ($1, $2, 'topup', $3)",
    )
    .bind(workspace_id)
    .bind(TOPUP_MICRO_USD)
    .bind(Uuid::new_v4())
    .execute(su)
    .await
    .expect("seed workspace credit topup");
    sqlx::query("INSERT INTO work_pool (workspace_id) VALUES ($1) ON CONFLICT DO NOTHING")
        .bind(workspace_id)
        .execute(su)
        .await
        .expect("seed work pool");

    Tenant {
        workspace_id,
        member_id,
        channel_id,
        root_message_id,
    }
}

/// A 64-hex bootstrap digest. The raw token never enters PostgreSQL (045:87-88).
fn bootstrap_digest() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

/// Seed a tenant, a `mock-a` cloud host and an open paid session on it.
async fn seed_paid_session(su: &PgPool, app: &PgPool) -> (Tenant, PaidSession) {
    let tenant = seed_tenant(su).await;
    let session = seed_paid_session_for(su, app, &tenant).await;
    (tenant, session)
}

async fn seed_paid_session_for(su: &PgPool, app: &PgPool, tenant: &Tenant) -> PaidSession {
    let host_id: Uuid = sqlx::query_scalar(
        "INSERT INTO work_host \
           (workspace_id, scope, owner_member_id, type, display_name, public_key, last_seen_at) \
         VALUES ($1, 'workspace', $2, 'cloud', $3, $4, clock_timestamp()) \
         RETURNING id",
    )
    .bind(tenant.workspace_id)
    .bind(tenant.member_id)
    .bind("notifier fixture host")
    // work_host_public_key_ck: 43 base64 chars + '='.
    .bind(format!("{}{}", "A".repeat(43 - 22), "b".repeat(22)) + "=")
    .fetch_one(su)
    .await
    .expect("seed work host");

    let cloud_host_id: Uuid = sqlx::query_scalar(
        "INSERT INTO work_cloud_host \
           (workspace_id, requester_member_id, provider, provider_sandbox_id, \
            bootstrap_token_digest, bootstrap_expires_at, unit_rate_micro_usd_second) \
         VALUES ($1, $2, $3, $4, $5, now() + interval '1 hour', $6) \
         RETURNING id",
    )
    .bind(tenant.workspace_id)
    .bind(tenant.member_id)
    .bind(MOCK_A_PROVIDER_ID)
    // `provider_sandbox_id` is UNIQUE and is also the mock's instance id.
    .bind(format!("mock-a-{}", Uuid::new_v4().simple()))
    .bind(bootstrap_digest())
    .bind(UNIT_RATE)
    .fetch_one(su)
    .await
    .expect("seed work cloud host");

    let workspace_id = tenant.workspace_id;
    let member_id = tenant.member_id;
    let channel_id = tenant.channel_id;
    let root_message_id = tenant.root_message_id;
    let session_id = with_t3_lifecycle_tx(
        app,
        workspace_id,
        T3LockLadder::host(cloud_host_id)
            .with_work_pool()
            .with_workspace_credit(),
        move |conn| {
            Box::pin(async move {
                reserve_provisioning_slot_in_tx(conn, workspace_id, member_id).await?;
                let state =
                    bind_cloud_host_in_tx(conn, workspace_id, cloud_host_id, host_id).await?;
                assert_eq!(state, CloudHostState::Ready);
                let session = create_work_session_in_tx(
                    conn,
                    workspace_id,
                    NewWorkSession {
                        channel_id,
                        member_id,
                        host_id,
                        root_message_id,
                        tool: "claude".to_string(),
                        label: "notifier conformance run".to_string(),
                    },
                )
                .await?;
                start_usage_in_tx(conn, workspace_id, session.id, host_id)
                    .await?
                    .expect("a cloud host opens an active-time ledger");
                Ok(session.id)
            })
        },
    )
    .await
    .expect("start a paid T3 session");

    PaidSession {
        workspace_id,
        cloud_host_id,
        host_id,
        session_id,
    }
}

/// Tell the substrate about the sandbox the fixture row already names.
///
/// The direction matters. `MockProviderAdapter::create` names instances from a
/// per-adapter counter (`mock-a-1`, `mock-a-2`, …), so making the row follow the
/// substrate gives every freshly built adapter in a test the *same* first id
/// while `work_cloud_host.provider_sandbox_id` is UNIQUE (045:95) — the rows
/// collide, and any way of resolving that collision leaves some row naming an
/// instance its substrate never created. Then `probe` answers `absent` for a
/// machine that is alive, and ADR-0140 D4 dutifully converges that **false
/// death** into a settlement. A verifier that can manufacture a death cannot
/// prove anything about deaths.
///
/// So the row keeps the unique id [`seed_paid_session_for`] gave it, and the
/// substrate adopts it. The assertion below is the guard: after this call the
/// instance must read `present`, or the fixture — not the convergence table — is
/// what the test is measuring.
async fn adopt_instance(
    adapter: &MockProviderAdapter,
    su: &PgPool,
    session: PaidSession,
) -> String {
    let instance_id: String =
        sqlx::query_scalar("SELECT provider_sandbox_id FROM work_cloud_host WHERE id = $1")
            .bind(session.cloud_host_id)
            .fetch_one(su)
            .await
            .expect("read the fixture's provider sandbox id");
    adapter.adopt_running_instance(&instance_id);

    let instance = CloudInstanceRef {
        provider_id: MOCK_A_PROVIDER_ID.to_string(),
        instance_id: instance_id.clone(),
    };
    assert_eq!(
        adapter.probe(&instance).await.expect("probe the fixture"),
        CloudInstancePresence::Present,
        "fixture guard: the substrate must report this host's sandbox alive before a \
         test stages anything — a fixture that starts from an invented death would \
         make every convergence assertion below meaningless"
    );
    instance_id
}

/// How the staged intent's deadline should read.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Deadline {
    /// Inside the bound — the reconciler calls the operation.
    Live,
    /// Past the bound — the reconciler asks the provider for the fact (057).
    Exceeded,
}

/// Put the host into the durable `pausing` intent a REST pause leaves behind.
///
/// `running → pausing` is a legal transition (053:35) and the 057 trigger supplies
/// the canonical deadline for the `Live` case, so this fixture states only what a
/// writer states.
async fn stage_pause_intent(su: &PgPool, cloud_host_id: Uuid, deadline: Deadline) {
    sqlx::query(
        "UPDATE work_cloud_host \
            SET state = 'pausing', \
                lifecycle_operation_id = uuidv7(), \
                lifecycle_operation_kind = 'pause', \
                lifecycle_operation_started_at = clock_timestamp() - interval '30 seconds', \
                lifecycle_operation_version = lifecycle_operation_version + 1, \
                lifecycle_operation_attempts = 0, \
                lifecycle_operation_next_attempt_at = NULL, \
                lifecycle_operation_deadline_at = CASE \
                  WHEN $2 THEN clock_timestamp() - interval '1 second' ELSE NULL END, \
                updated_at = clock_timestamp() \
          WHERE id = $1",
    )
    .bind(cloud_host_id)
    .bind(deadline == Deadline::Exceeded)
    .execute(su)
    .await
    .expect("stage a durable pause intent");
}

/// Make the intent claimable again without waiting out `t3_lifecycle_backoff`.
async fn make_claimable_now(su: &PgPool, cloud_host_id: Uuid) {
    sqlx::query(
        "UPDATE work_cloud_host \
            SET lifecycle_operation_next_attempt_at = clock_timestamp() - interval '1 second' \
          WHERE id = $1",
    )
    .bind(cloud_host_id)
    .execute(su)
    .await
    .expect("re-arm the claim");
}

async fn backdate_open_interval(su: &PgPool, session_id: Uuid, seconds: i64) {
    let updated = sqlx::query(
        "UPDATE work_host_usage_interval i \
            SET started_at = i.started_at - make_interval(secs => $2::double precision) \
           FROM work_host_usage u \
          WHERE u.id = i.usage_id AND u.session_id = $1 AND i.ended_at IS NULL",
    )
    .bind(session_id)
    .bind(seconds as f64)
    .execute(su)
    .await
    .expect("backdate the open interval")
    .rows_affected();
    assert_eq!(updated, 1, "exactly one interval must be open");
}

async fn backdate_heartbeat(su: &PgPool, host_id: Uuid, seconds: i64) {
    sqlx::query(
        "UPDATE work_host \
            SET last_seen_at = clock_timestamp() - make_interval(secs => $2::double precision) \
          WHERE id = $1",
    )
    .bind(host_id)
    .bind(seconds as f64)
    .execute(su)
    .await
    .expect("backdate the host heartbeat");
}

// ---------------------------------------------------------------------------
// oracles (superuser reads; the notifier itself only writes through momo-t3)
// ---------------------------------------------------------------------------

struct UsageRow {
    settled_at: Option<DateTime<Utc>>,
    settled_reason: Option<String>,
    active_seconds: Option<i64>,
}

async fn read_usage(su: &PgPool, session_id: Uuid) -> UsageRow {
    let row = sqlx::query(
        "SELECT settled_at, settled_reason, active_seconds \
           FROM work_host_usage WHERE session_id = $1",
    )
    .bind(session_id)
    .fetch_one(su)
    .await
    .expect("read the usage ledger row");
    UsageRow {
        settled_at: row.get("settled_at"),
        settled_reason: row.get("settled_reason"),
        active_seconds: row.get("active_seconds"),
    }
}

async fn t3_debits(su: &PgPool, workspace_id: Uuid, session_id: Uuid) -> Vec<i64> {
    sqlx::query_scalar(
        "SELECT delta_micro_usd FROM credit_entry \
          WHERE workspace_id = $1 AND reason = 't3_usage' AND ref_id = $2 \
          ORDER BY created_at, id",
    )
    .bind(workspace_id)
    .bind(session_id)
    .fetch_all(su)
    .await
    .expect("read t3 debits")
}

async fn cloud_host_state(su: &PgPool, cloud_host_id: Uuid) -> String {
    sqlx::query_scalar("SELECT state FROM work_cloud_host WHERE id = $1")
        .bind(cloud_host_id)
        .fetch_one(su)
        .await
        .expect("read cloud host state")
}

async fn next_attempt_is_in_the_future(su: &PgPool, cloud_host_id: Uuid) -> bool {
    sqlx::query_scalar(
        "SELECT COALESCE(lifecycle_operation_next_attempt_at > clock_timestamp(), false) \
           FROM work_cloud_host WHERE id = $1",
    )
    .bind(cloud_host_id)
    .fetch_one(su)
    .await
    .expect("read the next attempt marker")
}

async fn session_status(su: &PgPool, session_id: Uuid) -> String {
    sqlx::query_scalar("SELECT status FROM work_session WHERE id = $1")
        .bind(session_id)
        .fetch_one(su)
        .await
        .expect("read session status")
}

async fn host_is_revoked(su: &PgPool, host_id: Uuid) -> bool {
    sqlx::query_scalar("SELECT revoked_at IS NOT NULL FROM work_host WHERE id = $1")
        .bind(host_id)
        .fetch_one(su)
        .await
        .expect("read host revocation")
}

fn notifier_for(pool: PgPool, adapter: Arc<MockProviderAdapter>) -> Notifier {
    let mut config = NotifierConfig::for_target(database_url());
    config.host_offline_grace_seconds = GRACE_SECONDS;
    config.lifecycle_claim_delay_seconds = 5;
    Notifier::new(pool, config, Arc::new(FixedAdapterResolver::new(adapter)))
}

// ---------------------------------------------------------------------------
// #1 — a provably missing instance settles exactly once, and a lying substrate
//      cannot produce that settlement
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn d4_1_provider_missing_settles_once_and_only_on_an_honest_probe() {
    ensure_schema_and_roles();
    let _guard = notifier_test_lock().await;
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let (_tenant, session) = seed_paid_session(&su, &app).await;
    let adapter = Arc::new(MockProviderAdapter::mock_a());
    adopt_instance(&adapter, &su, session).await;
    backdate_open_interval(&su, session.session_id, 3).await;
    stage_pause_intent(&su, session.cloud_host_id, Deadline::Live).await;
    focus_lifecycle_intents(&su, &[session.cloud_host_id]).await;

    let notifier = notifier_for(momo_notifier_pool().await, Arc::clone(&adapter));

    // ---- the red half: the substrate dies and then denies it ----------------
    adapter.kill_all_instances();
    adapter.set_dishonest_probe(true);

    let denied = notifier
        .reconcile_once()
        .await
        .expect("reconcile iteration");
    assert_eq!(denied.claimed, 1, "the due intent must be claimed");
    assert_eq!(
        denied.denied, 1,
        "named regression: a provider that answers `present` for an instance it just \
         reported missing must not be allowed to settle a paid session (ADR-0142 D3.1)"
    );
    assert_eq!(denied.terminated, 0);
    let unsettled = read_usage(&su, session.session_id).await;
    assert!(
        unsettled.settled_at.is_none(),
        "named regression: the contradiction must leave the session unsettled"
    );
    assert!(
        t3_debits(&su, session.workspace_id, session.session_id)
            .await
            .is_empty(),
        "a refused settlement must not have billed anything"
    );
    assert_eq!(
        cloud_host_state(&su, session.cloud_host_id).await,
        "pausing",
        "the durable intent must survive the refusal"
    );
    assert!(
        next_attempt_is_in_the_future(&su, session.cloud_host_id).await,
        "the claim must have counted the attempt and scheduled the next one \
         (t3_lifecycle_backoff, 057:68)"
    );

    // ---- the honest half: the same death, reported honestly -----------------
    adapter.set_dishonest_probe(false);
    make_claimable_now(&su, session.cloud_host_id).await;

    let converged = notifier
        .reconcile_once()
        .await
        .expect("reconcile iteration");
    assert_eq!(
        converged.terminated, 1,
        "a provably missing instance must converge to t3_terminate('provider_missing')"
    );

    let settled = read_usage(&su, session.session_id).await;
    assert!(settled.settled_at.is_some(), "the ledger must be settled");
    assert_eq!(
        settled.settled_reason.as_deref(),
        Some("provider_missing"),
        "the settlement reason is ADR-0140 D4's, not a generic one"
    );
    assert_eq!(
        settled.active_seconds,
        Some(3),
        "billed seconds are floored exactly once, by t3_terminate (058:219)"
    );
    assert_eq!(
        t3_debits(&su, session.workspace_id, session.session_id).await,
        vec![-(3 * UNIT_RATE)],
        "exactly one debit — settlement is one statement"
    );
    assert_eq!(
        cloud_host_state(&su, session.cloud_host_id).await,
        "destroyed",
        "a host whose instance is gone leaves service"
    );
    assert!(host_is_revoked(&su, session.host_id).await);

    // ---- and the converged intent leaves the queue --------------------------
    make_claimable_now(&su, session.cloud_host_id).await;
    let after = notifier
        .reconcile_once()
        .await
        .expect("a second iteration is harmless");
    assert_eq!(
        after.candidates, 0,
        "a converged host is no longer in an intermediate state, so it leaves the \
         claim queue even with its next-attempt marker armed"
    );
    assert_eq!(
        t3_debits(&su, session.workspace_id, session.session_id)
            .await
            .len(),
        1,
        "named regression: `settled_at` seals the invoice — re-running must not re-bill"
    );
}

// ---------------------------------------------------------------------------
// #2 — past the deadline, the provider decides what is true
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn d4_2_deadline_converges_on_the_probed_fact() {
    ensure_schema_and_roles();
    let _guard = notifier_test_lock().await;
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    // Three sessions, three answers to the same question.
    let (_alive_tenant, alive) = seed_paid_session(&su, &app).await;
    let (_dead_tenant, dead) = seed_paid_session(&su, &app).await;
    let (_mute_tenant, mute) = seed_paid_session(&su, &app).await;

    let alive_adapter = Arc::new(MockProviderAdapter::mock_a());
    let dead_adapter = Arc::new(MockProviderAdapter::mock_a());
    let mute_adapter = Arc::new(MockProviderAdapter::mock_a());
    adopt_instance(&alive_adapter, &su, alive).await;
    adopt_instance(&dead_adapter, &su, dead).await;
    adopt_instance(&mute_adapter, &su, mute).await;

    for session in [alive, dead, mute] {
        backdate_open_interval(&su, session.session_id, 2).await;
        stage_pause_intent(&su, session.cloud_host_id, Deadline::Exceeded).await;
    }

    // (a) the instance is alive: a pause past its bound falls back to the
    //     billable reading rather than guessing in the user's favour.
    focus_lifecycle_intents(&su, &[alive.cloud_host_id]).await;
    let stats = notifier_for(momo_notifier_pool().await, Arc::clone(&alive_adapter))
        .reconcile_once()
        .await
        .expect("reconcile iteration");
    assert_eq!(
        stats.reverted, 1,
        "presence must revert a pause, not confirm it"
    );
    assert_eq!(cloud_host_state(&su, alive.cloud_host_id).await, "running");
    let alive_usage = read_usage(&su, alive.session_id).await;
    assert!(
        alive_usage.settled_at.is_none(),
        "named regression: a pause that did not happen keeps billing — the active \
         interval was never closed"
    );

    // (b) the instance is gone: absence past the bound is terminal.
    dead_adapter.kill_all_instances();
    focus_lifecycle_intents(&su, &[dead.cloud_host_id]).await;
    let stats = notifier_for(momo_notifier_pool().await, Arc::clone(&dead_adapter))
        .reconcile_once()
        .await
        .expect("reconcile iteration");
    assert_eq!(stats.terminated, 1, "absence past the bound must settle");
    assert_eq!(
        read_usage(&su, dead.session_id)
            .await
            .settled_reason
            .as_deref(),
        Some("provider_missing")
    );
    assert_eq!(cloud_host_state(&su, dead.cloud_host_id).await, "destroyed");

    // (c) the control plane cannot answer: `unknown` is never read as `absent`.
    mute_adapter.set_probe_unavailable(true);
    focus_lifecycle_intents(&su, &[mute.cloud_host_id]).await;
    let stats = notifier_for(momo_notifier_pool().await, Arc::clone(&mute_adapter))
        .reconcile_once()
        .await
        .expect("reconcile iteration");
    assert_eq!(
        stats.terminated, 0,
        "named regression: an unreachable provider must never settle a live paid \
         session (ADR-0142 D3.1)"
    );
    assert_eq!(stats.reverted, 1);
    assert!(
        read_usage(&su, mute.session_id).await.settled_at.is_none(),
        "named regression: `could not ask` must not collapse to `it is gone`"
    );
    assert!(t3_debits(&su, mute.workspace_id, mute.session_id)
        .await
        .is_empty());
}

// ---------------------------------------------------------------------------
// #3 — two instances, one iteration each, one settlement
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn d4_3_two_instances_settle_exactly_once() {
    ensure_schema_and_roles();
    let _guard = notifier_test_lock().await;
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let (_tenant, session) = seed_paid_session(&su, &app).await;
    let adapter = Arc::new(MockProviderAdapter::mock_a());
    adopt_instance(&adapter, &su, session).await;
    backdate_open_interval(&su, session.session_id, 4).await;
    stage_pause_intent(&su, session.cloud_host_id, Deadline::Live).await;
    focus_lifecycle_intents(&su, &[session.cloud_host_id]).await;
    adapter.kill_all_instances();

    // Two processes, two pools, one shared substrate — the deployment shape a
    // rolling restart produces.
    let first = notifier_for(momo_notifier_pool().await, Arc::clone(&adapter));
    let second = notifier_for(momo_notifier_pool().await, Arc::clone(&adapter));
    let (left, right) =
        futures::future::join(first.reconcile_once(), second.reconcile_once()).await;
    let left = left.expect("first iteration");
    let right = right.expect("second iteration");

    assert_eq!(
        left.claimed + right.claimed,
        1,
        "named regression: the durable claim (advisory + version bump, 057:188) must \
         hand one intent to exactly one instance"
    );
    assert_eq!(
        left.terminated + right.terminated,
        1,
        "exactly one instance may converge the intent"
    );
    assert_eq!(
        t3_debits(&su, session.workspace_id, session.session_id).await,
        vec![-(4 * UNIT_RATE)],
        "named regression: two concurrent reconcilers must bill the session once"
    );
    assert_eq!(
        read_usage(&su, session.session_id)
            .await
            .settled_reason
            .as_deref(),
        Some("provider_missing")
    );
}

// ---------------------------------------------------------------------------
// #4 — the sweep settles a lost host, and spares a paused one
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn d4_4_sweep_settles_a_lost_host_and_spares_a_paused_one() {
    ensure_schema_and_roles();
    let _guard = notifier_test_lock().await;
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let (_lost_tenant, lost) = seed_paid_session(&su, &app).await;
    let (_paused_tenant, paused) = seed_paid_session(&su, &app).await;
    let (_alive_tenant, alive) = seed_paid_session(&su, &app).await;
    backdate_open_interval(&su, lost.session_id, 5).await;

    // The lost host stopped answering; the paused host is equally quiet, but its
    // cloud row says the quiet is a pause working as designed.
    backdate_heartbeat(&su, lost.host_id, GRACE_SECONDS * 10).await;
    backdate_heartbeat(&su, paused.host_id, GRACE_SECONDS * 10).await;
    sqlx::query(
        "UPDATE work_cloud_host \
            SET state = 'pausing', \
                lifecycle_operation_id = uuidv7(), \
                lifecycle_operation_kind = 'pause', \
                lifecycle_operation_started_at = clock_timestamp(), \
                updated_at = clock_timestamp() \
          WHERE id = $1",
    )
    .bind(paused.cloud_host_id)
    .execute(&su)
    .await
    .expect("stage a pausing cloud host");

    freshen_residual_hosts(&su, &[lost.host_id, paused.host_id, alive.host_id]).await;
    // The sweep never calls a provider; the adapter is here only to build a
    // notifier.
    let notifier = notifier_for(
        momo_notifier_pool().await,
        Arc::new(MockProviderAdapter::mock_a()),
    );

    let stats = notifier.sweep_once().await.expect("sweep iteration");
    assert_eq!(
        stats.candidates, 1,
        "named regression: only the lost host is a candidate — a `pausing` host's quiet \
         heartbeat is the pause working, and a live host is not stale at all"
    );
    assert_eq!(stats.transitioned, 1);
    assert_eq!(stats.settled, 1);

    // the lost session: orphaned (policy default `ask`) and settled as orphaned.
    assert_eq!(
        session_status(&su, lost.session_id).await,
        "orphaned",
        "a resumable policy parks the session rather than ending it"
    );
    let usage = read_usage(&su, lost.session_id).await;
    assert_eq!(
        usage.settled_reason.as_deref(),
        Some("orphaned"),
        "host loss is an ordinary billing end, named as such (ADR-0140 §T3 상시화 2)"
    );
    assert_eq!(usage.active_seconds, Some(5));
    assert_eq!(
        t3_debits(&su, lost.workspace_id, lost.session_id).await,
        vec![-(5 * UNIT_RATE)],
        "one debit, from t3_terminate and nowhere else"
    );

    // the spared sessions: untouched, unbilled.
    for spared in [paused, alive] {
        assert_eq!(
            session_status(&su, spared.session_id).await,
            "running",
            "named regression: the sweep must not orphan a session it has no evidence about"
        );
        assert!(
            read_usage(&su, spared.session_id)
                .await
                .settled_at
                .is_none(),
            "a spared session must keep billing"
        );
    }

    // a second pass finds nothing: the transition is not repeatable.
    let again = notifier.sweep_once().await.expect("second sweep iteration");
    assert_eq!(
        again.candidates, 0,
        "an orphaned session is no longer running/idle, so it leaves the candidate set"
    );
    assert_eq!(
        t3_debits(&su, lost.workspace_id, lost.session_id)
            .await
            .len(),
        1,
        "named regression: re-sweeping must not re-bill"
    );
}
