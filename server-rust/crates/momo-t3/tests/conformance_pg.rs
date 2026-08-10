//! DB-backed conformance for the T3 lifecycle + billing spine (ADR-0140 /
//! ADR-0142, invariants-in-rust D2 #7).
//!
//! These are the orchestrator's docker-gate red tests. Each proves one
//! DB-enforced invariant with a **named assertion that goes red if the
//! enforcement is reverted** (momo red-test discipline). They are `#[ignore]`
//! because they need a throwaway `pgvector/pgvector:pg18` superuser DB plus the
//! runtime `momo_app` role:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-t3 --test conformance_pg -- --ignored --nocapture
//! ```
//!
//! Harness contract (identical to `momo-messaging`'s suite):
//!   * `DATABASE_URL` connects as a **superuser** — applies all migrations via
//!     psql + `infra/e2e/bootstrap_roles.sql`, and seeds fixtures bypassing RLS.
//!   * every lifecycle assertion runs as the runtime **`momo_app`** role
//!     (`NOBYPASSRLS`), the only faithful way to exercise the DB policies.
//!
//! What each test breaks when reverted:
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `d2_t3_1_settlement_is_one_statement_and_sealed` | drop `work_host_usage_settlement_guard`, or move settlement SQL into Rust |
//! | `d2_t3_2_transition_table_rejects_illegal_transitions` | drop `work_cloud_host_transition_guard`, or add the pair to `work_cloud_host_transition` |
//! | `d2_t3_3_advisory_lock_serializes_lifecycle_transactions` | remove `acquire_t3_lifecycle_lock` from the prelude |
//! | `d2_t3_4_double_termination_is_idempotent` | drop the `settled_at IS NULL` guard or the `credit_entry` unique key |
//! | `d2_t3_7_provider_credentials_never_enter_postgres` | persist any part of the `MOMO_T3_PROVIDER_*` namespace |
//! | `d2_t3_8_cubesandbox_running_is_not_liveness` | let any settlement path read a provider's reported `state` |

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::PgPool;
use momo_provider::{CloudInstanceSpec, CloudProviderAdapter};
use momo_t3::provider::registry::{load_endpoints, MOCK_A_PROVIDER_ID};
use momo_t3::sweep::{converge_stale_session, stale_session_candidates};
use momo_t3::{
    bind_cloud_host_in_tx, cloud_host_state_in_tx, create_work_session_in_tx, pause_usage_in_tx,
    reserve_provisioning_slot_in_tx, resume_usage_in_tx, start_usage_in_tx, terminate,
    terminate_in_tx, transition_cloud_host_in_tx, with_t3_lifecycle_tx, CloudHostState,
    MockProviderAdapter, NewWorkSession, T3Error, T3LockLadder, TerminationReason,
};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::Row;
use uuid::Uuid;

/// micro-USD per active second for every fixture host.
const UNIT_RATE: i64 = 25;
/// Seeded workspace credit, comfortably above any fixture debit.
const TOPUP_MICRO_USD: i64 = 1_000_000_000;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a fresh pgvector/pg18 superuser DB")
}

/// The `momo_app` runtime password — the committed test-only credential from
/// `infra/e2e/bootstrap_roles.sql` (not a real secret); override via env.
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

// ---------------------------------------------------------------------------
// fixtures (superuser → RLS bypassed)
// ---------------------------------------------------------------------------

/// A workspace with a member, a channel, a root message and topped-up credit.
struct Tenant {
    workspace_id: Uuid,
    member_id: Uuid,
    channel_id: Uuid,
    root_message_id: Uuid,
}

/// One provisioned cloud host: the `work_host` identity plus its
/// `work_cloud_host` lifecycle row, still `provisioning` and unbound.
#[derive(Clone, Copy)]
struct CloudHostFixture {
    cloud_host_id: Uuid,
    host_id: Uuid,
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
        .bind(format!("t3-{}", &channel_id.simple().to_string()[..8]))
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

    // Credit arrives the only way it can: an append-only `credit_entry` whose
    // trigger maintains `workspace_credit` (045:122-136).
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

/// A 64-hex bootstrap digest. The raw token never enters PostgreSQL (045:87-88);
/// only this digest does, which is also what makes it a useful *positive*
/// control for the invariant #7 scan.
fn bootstrap_digest() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

async fn seed_cloud_host(
    su: &PgPool,
    tenant: &Tenant,
    provider_id: &str,
    provider_sandbox_id: &str,
    digest: &str,
) -> CloudHostFixture {
    // `work_cloud_host.provider_sandbox_id` is UNIQUE; every test seeds its own
    // host, so suffix the caller's label with a fresh uuid — otherwise only the
    // first test's insert survives and the rest die on 23505 (gate 실측).
    let provider_sandbox_id = format!("{provider_sandbox_id}-{}", Uuid::new_v4());
    let provider_sandbox_id = provider_sandbox_id.as_str();
    // A cloud work host identity, exactly as the bootstrap registration creates
    // it (workspace scope, type 'cloud').
    let host_id: Uuid = sqlx::query_scalar(
        "INSERT INTO work_host \
           (workspace_id, scope, owner_member_id, type, display_name, public_key, last_seen_at) \
         VALUES ($1, 'workspace', $2, 'cloud', $3, $4, clock_timestamp()) \
         RETURNING id",
    )
    .bind(tenant.workspace_id)
    .bind(tenant.member_id)
    .bind("t3 fixture host")
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
    .bind(provider_id)
    .bind(provider_sandbox_id)
    .bind(digest)
    .bind(UNIT_RATE)
    .fetch_one(su)
    .await
    .expect("seed work cloud host");

    CloudHostFixture {
        cloud_host_id,
        host_id,
    }
}

/// Bind the host, open a session and open its usage ledger — the shape every
/// paid T3 session starts in.
async fn start_paid_session(app: &PgPool, tenant: &Tenant, host: CloudHostFixture) -> Uuid {
    let workspace_id = tenant.workspace_id;
    let member_id = tenant.member_id;
    let channel_id = tenant.channel_id;
    let root_message_id = tenant.root_message_id;
    let CloudHostFixture {
        cloud_host_id,
        host_id,
    } = host;

    with_t3_lifecycle_tx(
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
                assert_eq!(
                    state,
                    CloudHostState::Ready,
                    "a bound host with a known sandbox must land in `ready`"
                );
                let session = create_work_session_in_tx(
                    conn,
                    workspace_id,
                    NewWorkSession {
                        channel_id,
                        member_id,
                        host_id,
                        root_message_id,
                        tool: "claude".to_string(),
                        label: "t3 conformance run".to_string(),
                    },
                )
                .await?;
                let usage = start_usage_in_tx(conn, workspace_id, session.id, host_id)
                    .await?
                    .expect("a cloud host opens an active-time ledger");
                assert_eq!(usage.unit_rate_micro_usd_second, UNIT_RATE);
                Ok(session.id)
            })
        },
    )
    .await
    .expect("start a paid T3 session")
}

/// Backdate the open interval so settlement has whole billable seconds to floor.
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
    assert_eq!(
        updated, 1,
        "exactly one interval must be open before settlement"
    );
}

struct UsageRow {
    ended_at: Option<DateTime<Utc>>,
    active_seconds: Option<i64>,
    active_micros: Option<i64>,
    settled_at: Option<DateTime<Utc>>,
    settled_reason: Option<String>,
}

async fn read_usage(su: &PgPool, session_id: Uuid) -> UsageRow {
    let row = sqlx::query(
        "SELECT ended_at, active_seconds, active_micros, settled_at, settled_reason \
           FROM work_host_usage WHERE session_id = $1",
    )
    .bind(session_id)
    .fetch_one(su)
    .await
    .expect("read the usage ledger row");
    UsageRow {
        ended_at: row.get("ended_at"),
        active_seconds: row.get("active_seconds"),
        active_micros: row.get("active_micros"),
        settled_at: row.get("settled_at"),
        settled_reason: row.get("settled_reason"),
    }
}

async fn credit_balance(su: &PgPool, workspace_id: Uuid) -> i64 {
    sqlx::query_scalar("SELECT balance_micro_usd FROM workspace_credit WHERE workspace_id = $1")
        .bind(workspace_id)
        .fetch_one(su)
        .await
        .expect("read workspace credit balance")
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

// ---------------------------------------------------------------------------
// #1 — settlement is one statement, and `settled_at` is sealed against the rest
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a fresh pgvector/pg18 DB + momo_app role"]
async fn d2_t3_1_settlement_is_one_statement_and_sealed() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let tenant = seed_tenant(&su).await;
    let host = seed_cloud_host(
        &su,
        &tenant,
        MOCK_A_PROVIDER_ID,
        "mock-a-1",
        &bootstrap_digest(),
    )
    .await;
    let session_id = start_paid_session(&app, &tenant, host).await;

    let opening_balance = credit_balance(&su, tenant.workspace_id).await;
    backdate_open_interval(&su, session_id, 3).await;

    // The ONLY settlement call the application makes.
    let settled = terminate(
        &app,
        tenant.workspace_id,
        session_id,
        TerminationReason::Ended,
    )
    .await
    .expect("t3_terminate");
    assert!(settled, "an open paid session must settle");

    // (a) the invoice is complete and named.
    let usage = read_usage(&su, session_id).await;
    assert!(
        usage.settled_at.is_some(),
        "settlement must set settled_at (t3_terminate, 058:224-231)"
    );
    assert!(
        usage.ended_at.is_some(),
        "settlement must close the usage row"
    );
    assert_eq!(
        usage.settled_reason.as_deref(),
        Some("ended"),
        "the first settlement's reason is canonical (ADR-0140 D3)"
    );
    assert_eq!(
        usage.active_seconds,
        Some(3),
        "billed seconds = floor(total micros / 1e6), floored exactly once (058:219)"
    );
    let micros = usage.active_micros.expect("058 records exact micros");
    assert!(
        (3_000_000..3_500_000).contains(&micros),
        "exact active micros must restate the interval, got {micros}"
    );

    // (b) exactly one debit, and the balance moved by exactly that much.
    let debits = t3_debits(&su, tenant.workspace_id, session_id).await;
    assert_eq!(
        debits,
        vec![-(3 * UNIT_RATE)],
        "one debit of floor(seconds) × rate"
    );
    assert_eq!(
        credit_balance(&su, tenant.workspace_id).await,
        opening_balance - 3 * UNIT_RATE,
        "the credit ledger must move by the single debit and nothing else"
    );

    // (c) the same statement left a durable destroy intent and revoked the host.
    let intent = sqlx::query(
        "SELECT state, lifecycle_operation_kind, lifecycle_operation_deadline_at \
           FROM work_cloud_host WHERE id = $1",
    )
    .bind(host.cloud_host_id)
    .fetch_one(&su)
    .await
    .unwrap();
    let state: String = intent.get("state");
    let kind: Option<String> = intent.get("lifecycle_operation_kind");
    let deadline: Option<DateTime<Utc>> = intent.get("lifecycle_operation_deadline_at");
    assert_eq!(
        state, "destroy_pending",
        "settlement leaves a destroy intent"
    );
    assert_eq!(kind.as_deref(), Some("destroy"));
    assert!(
        deadline.is_some(),
        "the 057 trigger must supply a deadline for any *ing state"
    );
    let revoked: Option<DateTime<Utc>> =
        sqlx::query_scalar("SELECT revoked_at FROM work_host WHERE id = $1")
            .bind(host.host_id)
            .fetch_one(&su)
            .await
            .unwrap();
    assert!(revoked.is_some(), "settlement revokes the paid host");

    // (d) THE SEAL. A second, unsettled session on another host: writing
    // `settled_at` directly — with every CHECK constraint satisfied — must be
    // refused by `work_host_usage_settlement_guard`, not merely frowned upon.
    let host2 = seed_cloud_host(
        &su,
        &tenant,
        MOCK_A_PROVIDER_ID,
        "mock-a-2",
        &bootstrap_digest(),
    )
    .await;
    let session2 = start_paid_session(&app, &tenant, host2).await;
    let workspace_id = tenant.workspace_id;

    let sealed = with_t3_lifecycle_tx(
        &app,
        workspace_id,
        T3LockLadder::host(host2.cloud_host_id).with_workspace_credit(),
        move |conn| {
            Box::pin(async move {
                sqlx::query(
                    "UPDATE work_host_usage \
                        SET ended_at = clock_timestamp(), \
                            active_seconds = 0, \
                            active_micros = 0, \
                            settled_at = clock_timestamp(), \
                            settled_reason = 'ended' \
                      WHERE workspace_id = $1 AND session_id = $2",
                )
                .bind(workspace_id)
                .bind(session2)
                .execute(conn)
                .await?;
                Ok(())
            })
        },
    )
    .await
    .expect_err("a direct settlement write must be refused");
    assert!(
        matches!(sealed, T3Error::SettlementSealed),
        "bypassing t3_terminate must fail by name, got {sealed:?}"
    );

    let still_open = read_usage(&su, session2).await;
    assert!(
        still_open.settled_at.is_none(),
        "the refused write must leave the session unsettled"
    );
    assert!(
        t3_debits(&su, workspace_id, session2).await.is_empty(),
        "a refused settlement must not have billed anything"
    );
}

// ---------------------------------------------------------------------------
// #2 — the transition table is the only authority on a legal state change
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a fresh pgvector/pg18 DB + momo_app role"]
async fn d2_t3_2_transition_table_rejects_illegal_transitions() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let tenant = seed_tenant(&su).await;
    let host = seed_cloud_host(
        &su,
        &tenant,
        MOCK_A_PROVIDER_ID,
        "mock-a-1",
        &bootstrap_digest(),
    )
    .await;
    let workspace_id = tenant.workspace_id;
    let cloud_host_id = host.cloud_host_id;
    let session_id = start_paid_session(&app, &tenant, host).await;
    assert_eq!(cloud_host_state(&su, cloud_host_id).await, "running");

    // Every declared transition below is a plain UPDATE. The app states the
    // destination; `work_cloud_host_transition` decides.
    let legal = [
        CloudHostState::Pausing,
        CloudHostState::Paused,
        CloudHostState::Resuming,
        CloudHostState::Running,
    ];
    for to_state in legal {
        let reached = with_t3_lifecycle_tx(
            &app,
            workspace_id,
            T3LockLadder::host(cloud_host_id),
            move |conn| {
                Box::pin(async move {
                    transition_cloud_host_in_tx(conn, workspace_id, cloud_host_id, to_state).await
                })
            },
        )
        .await
        .unwrap_or_else(|err| {
            panic!(
                "{} must be a legal transition: {err:?}",
                to_state.as_db_label()
            )
        });
        assert_eq!(reached, to_state);
    }

    // Illegal: `running -> ready` is not in the table (a host never un-starts).
    let err = attempt_transition(&app, workspace_id, cloud_host_id, CloudHostState::Ready)
        .await
        .expect_err("running -> ready must be refused");
    assert!(
        matches!(err, T3Error::IllegalTransition(_)),
        "an unlisted transition must be refused by name, got {err:?}"
    );
    assert_eq!(
        cloud_host_state(&su, cloud_host_id).await,
        "running",
        "a refused transition must not move the host"
    );

    // Illegal: `running -> destroyed` skips the durable destroy intent.
    let err = attempt_transition(&app, workspace_id, cloud_host_id, CloudHostState::Destroyed)
        .await
        .expect_err("running -> destroyed must be refused");
    assert!(matches!(err, T3Error::IllegalTransition(_)));

    // Settle, then try to walk back out of the terminal intent — the ADR-0140
    // "settled -> running" case.
    terminate(&app, workspace_id, session_id, TerminationReason::Ended)
        .await
        .expect("settle");
    assert_eq!(
        cloud_host_state(&su, cloud_host_id).await,
        "destroy_pending"
    );

    let err = attempt_transition(&app, workspace_id, cloud_host_id, CloudHostState::Running)
        .await
        .expect_err("destroy_pending -> running must be refused");
    assert!(
        matches!(err, T3Error::IllegalTransition(_)),
        "a settled host must not be resurrected into `running`, got {err:?}"
    );
    assert_eq!(
        cloud_host_state(&su, cloud_host_id).await,
        "destroy_pending",
        "the terminal intent survives the refused transition"
    );

    // Control: the one transition that IS listed out of destroy_pending works,
    // so the test is proving the table's contents and not a blanket refusal.
    let reached = with_t3_lifecycle_tx(
        &app,
        workspace_id,
        T3LockLadder::host(cloud_host_id),
        move |conn| {
            Box::pin(async move {
                transition_cloud_host_in_tx(
                    conn,
                    workspace_id,
                    cloud_host_id,
                    CloudHostState::Destroyed,
                )
                .await
            })
        },
    )
    .await
    .expect("destroy_pending -> destroyed is listed and must pass");
    assert_eq!(reached, CloudHostState::Destroyed);
}

async fn attempt_transition(
    app: &PgPool,
    workspace_id: Uuid,
    cloud_host_id: Uuid,
    to_state: CloudHostState,
) -> Result<CloudHostState, T3Error> {
    with_t3_lifecycle_tx(
        app,
        workspace_id,
        T3LockLadder::host(cloud_host_id),
        move |conn| {
            Box::pin(async move {
                transition_cloud_host_in_tx(conn, workspace_id, cloud_host_id, to_state).await
            })
        },
    )
    .await
}

// ---------------------------------------------------------------------------
// #3 — the host advisory serializes lifecycle transactions
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs DATABASE_URL to a fresh pgvector/pg18 DB + momo_app role"]
async fn d2_t3_3_advisory_lock_serializes_lifecycle_transactions() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let tenant = seed_tenant(&su).await;
    let host = seed_cloud_host(
        &su,
        &tenant,
        MOCK_A_PROVIDER_ID,
        "mock-a-1",
        &bootstrap_digest(),
    )
    .await;
    let workspace_id = tenant.workspace_id;
    let cloud_host_id = host.cloud_host_id;
    start_paid_session(&app, &tenant, host).await;

    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel::<()>();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();

    // Transaction A takes the ladder and holds it open.
    let app_a = app.clone();
    let task_a = tokio::spawn(async move {
        with_t3_lifecycle_tx(
            &app_a,
            workspace_id,
            T3LockLadder::host(cloud_host_id).with_workspace_credit(),
            move |conn| {
                Box::pin(async move {
                    let _ = cloud_host_state_in_tx(conn, workspace_id, cloud_host_id).await?;
                    entered_tx.send(()).ok();
                    release_rx.await.ok();
                    Ok(Instant::now())
                })
            },
        )
        .await
    });
    entered_rx.await.expect("transaction A entered the ladder");

    // Transaction B wants the same host.
    let started_b = Instant::now();
    let app_b = app.clone();
    let task_b = tokio::spawn(async move {
        with_t3_lifecycle_tx(
            &app_b,
            workspace_id,
            T3LockLadder::host(cloud_host_id).with_workspace_credit(),
            move |conn| {
                Box::pin(async move {
                    let _ = cloud_host_state_in_tx(conn, workspace_id, cloud_host_id).await?;
                    Ok(Instant::now())
                })
            },
        )
        .await
    });

    // Test-validity check (ADR-0140 D5): assert the two transactions really are
    // contending. Without this a serial run would go quietly green, which is
    // exactly how the third adversarial review's deadlock survived nine gates.
    tokio::time::sleep(Duration::from_millis(400)).await;
    let waiting: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted",
    )
    .fetch_one(&su)
    .await
    .unwrap();
    assert!(
        waiting >= 1,
        "the second lifecycle transaction must be WAITING on the host advisory; \
         no ungranted advisory lock means the two never contended"
    );
    let held: i64 =
        sqlx::query_scalar("SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND granted")
            .fetch_one(&su)
            .await
            .unwrap();
    assert!(
        held >= 1,
        "the first transaction must still hold the advisory"
    );

    release_tx.send(()).expect("release transaction A");
    let a_exit = task_a
        .await
        .expect("join A")
        .expect("transaction A committed");
    let b_enter = task_b
        .await
        .expect("join B")
        .expect("transaction B committed");

    assert!(
        b_enter >= a_exit,
        "the second lifecycle transaction must not enter the ladder before the first commits"
    );
    assert!(
        b_enter.duration_since(started_b) >= Duration::from_millis(300),
        "the second transaction must have been blocked for the whole time the first held \
         the advisory (serialization, not luck)"
    );
}

// ---------------------------------------------------------------------------
// #4 — double settlement is idempotent
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a fresh pgvector/pg18 DB + momo_app role"]
async fn d2_t3_4_double_termination_is_idempotent() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let tenant = seed_tenant(&su).await;
    let host = seed_cloud_host(
        &su,
        &tenant,
        MOCK_A_PROVIDER_ID,
        "mock-a-1",
        &bootstrap_digest(),
    )
    .await;
    let workspace_id = tenant.workspace_id;
    let session_id = start_paid_session(&app, &tenant, host).await;
    let opening_balance = credit_balance(&su, workspace_id).await;
    backdate_open_interval(&su, session_id, 5).await;

    assert!(
        terminate(&app, workspace_id, session_id, TerminationReason::Ended)
            .await
            .expect("first settlement")
    );
    let after_first = read_usage(&su, session_id).await;
    let balance_after_first = credit_balance(&su, workspace_id).await;
    assert_eq!(balance_after_first, opening_balance - 5 * UNIT_RATE);

    // A second call with a *different* reason: ADR-0140 D3 says the lineage /
    // sweep / reconciler paths may all call it, so it must be safe to call and
    // must not re-price or re-label the invoice.
    assert!(
        terminate(
            &app,
            workspace_id,
            session_id,
            TerminationReason::ProviderMissing
        )
        .await
        .expect("second settlement"),
        "a settled session reports success, not failure"
    );

    let after_second = read_usage(&su, session_id).await;
    assert_eq!(
        after_second.settled_at, after_first.settled_at,
        "the settlement timestamp must not move on a repeat call"
    );
    assert_eq!(
        after_second.settled_reason.as_deref(),
        Some("ended"),
        "the FIRST reason is canonical; a later caller must not relabel the invoice"
    );
    assert_eq!(after_second.active_seconds, after_first.active_seconds);
    assert_eq!(
        t3_debits(&su, workspace_id, session_id).await,
        vec![-(5 * UNIT_RATE)],
        "exactly one debit survives two settlement calls"
    );
    assert_eq!(
        credit_balance(&su, workspace_id).await,
        balance_after_first,
        "a repeat settlement must not double-charge"
    );

    // Third call, in a *separate* transaction path (in-tx form) — same answer.
    let repeated = with_t3_lifecycle_tx(
        &app,
        workspace_id,
        T3LockLadder::host(host.cloud_host_id).with_workspace_credit(),
        move |conn| {
            Box::pin(async move {
                terminate_in_tx(
                    conn,
                    workspace_id,
                    session_id,
                    TerminationReason::IdleTimeout,
                )
                .await
            })
        },
    )
    .await
    .expect("third settlement");
    assert!(repeated);
    assert_eq!(
        credit_balance(&su, workspace_id).await,
        balance_after_first,
        "still exactly one debit after three settlement calls"
    );
}

// ---------------------------------------------------------------------------
// #7 — provider credentials never enter PostgreSQL (invariants-in-rust D2 #7)
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a fresh pgvector/pg18 DB + momo_app role"]
async fn d2_t3_7_provider_credentials_never_enter_postgres() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    // Adapter configuration lives in the `MOMO_T3_PROVIDER_<ID>_*` namespace and
    // is injected, never read from a file (ADR-0142 D4).
    let operator_key = format!("momo-t3-operator-key-{}", Uuid::new_v4().simple());
    let mut env = BTreeMap::new();
    env.insert(
        "MOMO_T3_PROVIDER_MOCK_A_API_BASE_URL".to_string(),
        "https://substrate.invalid".to_string(),
    );
    env.insert(
        "MOMO_T3_PROVIDER_MOCK_A_API_KEY".to_string(),
        operator_key.clone(),
    );
    let endpoints = load_endpoints(&env);
    let endpoint = endpoints
        .get(MOCK_A_PROVIDER_ID)
        .expect("mock-a is configured");
    assert_eq!(endpoint.api_key(), operator_key);

    // A full lifecycle on the mock substrate: create → register → run → pause →
    // resume → settle.
    let adapter = MockProviderAdapter::mock_a();
    let tenant = seed_tenant(&su).await;
    let workspace_id = tenant.workspace_id;
    let registration_token = format!("workd-one-shot-{}", Uuid::new_v4().simple());
    let instance = adapter
        .create(
            &CloudInstanceSpec {
                provision_id: Uuid::new_v4(),
                workspace_id,
                display_name: "t3 conformance".to_string(),
                registration_token: registration_token.clone(),
                server_url: "https://momo.invalid".to_string(),
            },
            "prov-1",
        )
        .await
        .expect("mock create");

    let digest = bootstrap_digest();
    let host = seed_cloud_host(
        &su,
        &tenant,
        MOCK_A_PROVIDER_ID,
        &instance.instance_id,
        &digest,
    )
    .await;
    let session_id = start_paid_session(&app, &tenant, host).await;

    let host_id = host.host_id;
    with_t3_lifecycle_tx(
        &app,
        workspace_id,
        T3LockLadder::host(host.cloud_host_id),
        move |conn| {
            Box::pin(async move {
                pause_usage_in_tx(conn, workspace_id, host_id, Some(session_id)).await?;
                resume_usage_in_tx(conn, workspace_id, host_id, Some(session_id)).await?;
                Ok(())
            })
        },
    )
    .await
    .expect("pause/resume the active-time ledger");
    adapter.pause(&instance, "op-1").await.expect("mock pause");
    adapter
        .resume(&instance, "op-2")
        .await
        .expect("mock resume");

    backdate_open_interval(&su, session_id, 2).await;
    terminate(&app, workspace_id, session_id, TerminationReason::Ended)
        .await
        .expect("settle");
    adapter
        .destroy(&instance, "op-3")
        .await
        .expect("mock destroy");

    // (a) test-validity control: the scanner really does read these tables. The
    // bootstrap DIGEST is the one provider-adjacent string that is *supposed*
    // to be in PostgreSQL (045:87-88), so finding it proves a zero below means
    // "absent", not "never looked".
    assert!(
        scan_database_for(&su, &digest).await >= 1,
        "the scanner must find the bootstrap digest — otherwise a zero result is meaningless"
    );

    // (b) the invariant: the operator credential, the raw registration token and
    // the adapter's base URL are nowhere in the database.
    for (label, needle) in [
        ("provider API key", operator_key.as_str()),
        ("raw workd registration token", registration_token.as_str()),
        ("provider API base URL", endpoint.api_base_url()),
    ] {
        let hits = scan_database_for(&su, needle).await;
        assert_eq!(
            hits, 0,
            "{label} must not appear anywhere in PostgreSQL after a full T3 lifecycle"
        );
    }

    // (c) the log half: `Debug` is what tracing renders, so it must not carry
    // the credential either.
    let rendered = format!("{endpoint:?}");
    assert!(
        !rendered.contains(&operator_key),
        "provider credential must not survive a Debug rendering: {rendered}"
    );
    let calls = format!("{:?}", adapter.calls());
    assert!(
        !calls.contains(&operator_key) && !calls.contains(&registration_token),
        "the adapter call log must carry neither credential nor one-shot token"
    );
}

/// Count rows anywhere in the `public` schema whose text/JSON columns contain
/// `needle` — the executable form of "0 occurrences in a PG dump".
async fn scan_database_for(su: &PgPool, needle: &str) -> i64 {
    let columns: Vec<(String, String)> = sqlx::query_as(
        "SELECT c.table_name, c.column_name \
           FROM information_schema.columns c \
           JOIN information_schema.tables t \
             ON t.table_schema = c.table_schema AND t.table_name = c.table_name \
          WHERE c.table_schema = 'public' \
            AND t.table_type = 'BASE TABLE' \
            AND c.data_type IN ('text', 'character varying', 'character', 'json', 'jsonb') \
          ORDER BY c.table_name, c.column_name",
    )
    .fetch_all(su)
    .await
    .expect("enumerate text-bearing columns");
    assert!(
        columns.len() > 50,
        "the scan must cover the whole schema, saw {} columns",
        columns.len()
    );

    let pattern = format!("%{needle}%");
    let mut hits = 0i64;
    for (table, column) in columns {
        let sql = format!("SELECT count(*) FROM \"{table}\" WHERE \"{column}\"::text LIKE $1");
        let found: i64 = sqlx::query_scalar(&sql)
            .bind(&pattern)
            .fetch_one(su)
            .await
            .unwrap_or_else(|err| panic!("scan {table}.{column}: {err}"));
        hits += found;
    }
    hits
}

// ---------------------------------------------------------------------------
// #8 — CubeSandbox's `running` is not liveness (ADR-0156 D6② / 매핑표 §2.3)
// ---------------------------------------------------------------------------

/// The acceptance criterion 매핑표 §2.3 writes out in full, run against the
/// database.
///
/// CubeAPI folds every non-paused internal status into `running`, so a wedged
/// sandbox answers `200 {"state":"running"}` forever. The claim under test is
/// that momo's settlement path does not care: liveness is the workd heartbeat's
/// to report, and a session whose heartbeat went quiet is orphaned and settled
/// **while the substrate is still saying it is running**.
///
/// Red when reverted: teach any part of the settlement path to consult the
/// provider's `state` (or make `probe` answer anything other than `Present` for
/// `running`) and the sweep stops producing this candidate — a paid session
/// keeps billing on a machine that is doing nothing.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a fresh pgvector/pg18 DB + momo_app role"]
async fn d2_t3_8_cubesandbox_running_is_not_liveness() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    // A fake CubeAPI that reports `running` for every sandbox it is asked about,
    // forever — the lossy fold at its most confident.
    let sandbox_id = format!("iiny0783cype8gmoawzmx-{}", Uuid::new_v4().simple());
    let reported = sandbox_id.clone();
    let router = axum::Router::new().route(
        "/sandboxes/{id}",
        axum::routing::get(
            move |axum::extract::Path(id): axum::extract::Path<String>| {
                let reported = reported.clone();
                async move {
                    axum::Json(serde_json::json!({
                        "sandboxID": id,
                        "templateID": "tpl-oort-workd",
                        // The word that means nothing.
                        "state": "running",
                        "metadata": { "momo_provision_id": reported },
                    }))
                }
            },
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind fake cube api");
    let address = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    let adapter = momo_t3::CubeSandboxProviderAdapter::from_env(&BTreeMap::from([
        (
            "MOMO_T3_PROVIDER_CUBESANDBOX_API_BASE_URL".to_string(),
            format!("http://{address}"),
        ),
        (
            "MOMO_T3_PROVIDER_CUBESANDBOX_API_KEY".to_string(),
            "cube-operator-key-not-a-real-secret".to_string(),
        ),
    ]))
    .expect("the adapter is configured");

    let tenant = seed_tenant(&su).await;
    let host = seed_cloud_host(
        &su,
        &tenant,
        momo_t3::provider::CUBESANDBOX_PROVIDER_ID,
        &sandbox_id,
        &bootstrap_digest(),
    )
    .await;
    let session_id = start_paid_session(&app, &tenant, host).await;

    // The substrate insists the sandbox is up.
    let instance = momo_provider::CloudInstanceRef {
        provider_id: momo_t3::provider::CUBESANDBOX_PROVIDER_ID.to_string(),
        instance_id: sandbox_id.clone(),
    };
    assert_eq!(
        adapter.probe(&instance).await.expect("probe answers"),
        momo_provider::CloudInstancePresence::Present,
        "precondition: the fake upstream is reporting the sandbox as `running`"
    );

    // …and the daemon inside it stopped talking.
    sqlx::query(
        "UPDATE work_host SET last_seen_at = clock_timestamp() - interval '30 minutes' \
          WHERE id = $1 AND workspace_id = $2",
    )
    .bind(host.host_id)
    .bind(tenant.workspace_id)
    .execute(&su)
    .await
    .expect("age the heartbeat");

    // The candidate read is unscoped and runs as a BYPASSRLS role in production
    // (`momo-notifier`); the superuser pool is this harness's stand-in for it.
    // The settlement below still goes through the tenant-scoped `momo_app` pool,
    // which is where the RLS policies and the advisory ladder actually apply.
    let candidates = stale_session_candidates(&su, 90, 200)
        .await
        .expect("sweep candidates");
    let candidate = candidates
        .iter()
        .find(|candidate| candidate.session_id == session_id)
        .unwrap_or_else(|| {
            panic!(
                "named regression: the host-loss sweep must not consult the provider. \
                 CubeAPI's `running` is every non-paused status folded into one word \
                 (sandboxes.rs:917-923); liveness is the workd heartbeat (ADR-0156 D6②)"
            )
        });
    assert_eq!(
        candidate.cloud_host_id,
        Some(host.cloud_host_id),
        "the candidate carries the paid host, so the settlement reaches the ledger"
    );

    let convergence = converge_stale_session(&app, candidate, 90)
        .await
        .expect("converge the stale session");
    assert!(
        convergence.settled && convergence.transitioned,
        "a session whose heartbeat is gone is settled and moved off `running`, whatever the \
         substrate claims: {convergence:?}"
    );

    // The substrate has not changed its mind, and it never had a vote.
    assert_eq!(
        adapter.probe(&instance).await.expect("probe answers"),
        momo_provider::CloudInstancePresence::Present,
        "named regression: this is still `present`, and `present` is all it ever meant — the \
         settlement above happened without it"
    );

    let status: String =
        sqlx::query_scalar("SELECT status FROM work_session WHERE id = $1 AND workspace_id = $2")
            .bind(session_id)
            .bind(tenant.workspace_id)
            .fetch_one(&su)
            .await
            .expect("read the session back");
    assert_ne!(
        status, "running",
        "the session must not still claim to be running on a host nobody has heard from"
    );

    // ---------------------------------------------------------------------
    // #1197 B2 — settling the session is only half of it.
    // ---------------------------------------------------------------------
    //
    // The original version of this test stopped above, and that gap is what the
    // ticket found. Billing stops, the session moves — and the sandbox keeps
    // existing, keeps costing money, and keeps answering `200 running`. On this
    // substrate nothing ever corrects that on its own: D4-② SIGKILLed a VMM and
    // watched 15 consecutive probes over 300 s report `running`, with zero
    // self-convergence. `provider_missing` is reached from a 404 that never
    // arrives.
    //
    // So the sweep has to leave behind a *durable destroy intent*, issued on
    // momo's own evidence (the expired heartbeat) while the provider is still
    // insisting the instance is present. That intent is what the ADR-0140 D4
    // reconciler then drives to a real DELETE — the one thing the spike found
    // actually reclaims a crashed sandbox.
    assert!(
        convergence.destroy_intended,
        "named regression: a settled session whose instance is never destroyed is a paid sandbox \
         nobody is paying attention to. The substrate will not volunteer the 404 that would \
         reclaim it"
    );
    let host_state: String =
        sqlx::query_scalar("SELECT state FROM work_cloud_host WHERE id = $1 AND workspace_id = $2")
            .bind(host.cloud_host_id)
            .bind(tenant.workspace_id)
            .fetch_one(&su)
            .await
            .expect("read the cloud host back");
    assert_eq!(
        host_state, "destroy_pending",
        "named regression: the durable destroy intent must stand against the paid instance even \
         though the provider answered `present` for it moments ago. Adding a `don't destroy what \
         the provider still reports` guard would feel careful and would strand every crashed \
         sandbox permanently"
    );
    let kind: Option<String> = sqlx::query_scalar(
        "SELECT lifecycle_operation_kind FROM work_cloud_host WHERE id = $1 AND workspace_id = $2",
    )
    .bind(host.cloud_host_id)
    .bind(tenant.workspace_id)
    .fetch_one(&su)
    .await
    .expect("read the intent kind");
    assert_eq!(
        kind.as_deref(),
        Some("destroy"),
        "the intent the reconciler will claim is a destroy, in ADR-0140 D4's existing vocabulary \
         — #1197 B2 invents no new state"
    );
}

// ---------------------------------------------------------------------------
// #9 — the lease renewal and the host-loss sweep are complements (#1197 H1/B2)
// ---------------------------------------------------------------------------

/// The property that makes an unrenewed lease safe rather than reckless.
///
/// #1197 H1 shortened the CubeSandbox `timeout` from 96 h to 360 s, which is
/// only defensible if two things hold at once:
///
/// 1. every host momo still wants **is** renewed — including paused ones, whose
///    workd is frozen inside a memory snapshot and emits no heartbeat, and which
///    would otherwise all die at one lease, taking ADR-0141's 24 h
///    paused→hibernate window with them;
/// 2. every host momo has given up on **is not** — because that silence is the
///    only reclaim path that survives momo itself dying, and on a substrate
///    where a crashed VM answers `200 running` forever (D4-② §3.3) it is the
///    only automatic one that exists at all.
///
/// Those are exactly the two sides of `stale_session_candidates`' exclusion, so
/// this runs both queries against the same rows and asserts they partition.
///
/// Red when reverted: drop the heartbeat predicate from
/// `renewable_lease_candidates` and the dead host below shows up in both lists —
/// momo would be paying to keep alive the very instance it is orphaning.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a fresh pgvector/pg18 DB + momo_app role"]
async fn d2_t3_9_lease_renewal_is_the_complement_of_host_loss() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    // Host A: alive and working. Host B: its daemon went quiet 30 minutes ago.
    let tenant = seed_tenant(&su).await;
    let alive = seed_cloud_host(
        &su,
        &tenant,
        momo_t3::provider::CUBESANDBOX_PROVIDER_ID,
        "lease-alive",
        &bootstrap_digest(),
    )
    .await;
    let alive_session = start_paid_session(&app, &tenant, alive).await;

    let dead_tenant = seed_tenant(&su).await;
    let dead = seed_cloud_host(
        &su,
        &dead_tenant,
        momo_t3::provider::CUBESANDBOX_PROVIDER_ID,
        "lease-dead",
        &bootstrap_digest(),
    )
    .await;
    let dead_session = start_paid_session(&app, &dead_tenant, dead).await;
    sqlx::query(
        "UPDATE work_host SET last_seen_at = clock_timestamp() - interval '30 minutes' \
          WHERE id = $1 AND workspace_id = $2",
    )
    .bind(dead.host_id)
    .bind(dead_tenant.workspace_id)
    .execute(&su)
    .await
    .expect("age the heartbeat");

    let renewable = momo_t3::lease::renewable_lease_candidates(&su, 90, 500, None)
        .await
        .expect("lease candidates");
    let stale = stale_session_candidates(&su, 90, 500)
        .await
        .expect("sweep candidates");

    let renews = |id: Uuid| renewable.iter().any(|c| c.cloud_host_id == id);
    let orphans = |id: Uuid| stale.iter().any(|c| c.cloud_host_id == Some(id));

    assert!(
        renews(alive.cloud_host_id),
        "named regression: a live paid host must keep being renewed. With the lease at 360 s, a \
         host that stops being renewed is deleted by the substrate six minutes later — working \
         or not, because `timeout` is absolute and activity does not reset it"
    );
    assert!(!orphans(alive.cloud_host_id));

    assert!(
        orphans(dead.cloud_host_id),
        "precondition: a host quiet past the grace window is the sweep's candidate"
    );
    assert!(
        !renews(dead.cloud_host_id),
        "named regression: momo must stop renewing the lease of a host it is orphaning. That \
         silence is the only reclaim path that works when momo is not running to issue a \
         DELETE — and this substrate never volunteers the 404 that would trigger one"
    );

    // A paused host is renewed even though nothing is heartbeating for it: its
    // workd is inside the memory snapshot.
    with_t3_lifecycle_tx(
        &app,
        tenant.workspace_id,
        T3LockLadder::host(alive.cloud_host_id),
        move |conn| {
            Box::pin(async move {
                transition_cloud_host_in_tx(
                    conn,
                    tenant.workspace_id,
                    alive.cloud_host_id,
                    CloudHostState::Pausing,
                )
                .await?;
                transition_cloud_host_in_tx(
                    conn,
                    tenant.workspace_id,
                    alive.cloud_host_id,
                    CloudHostState::Paused,
                )
                .await
            })
        },
    )
    .await
    .expect("park the host");
    sqlx::query(
        "UPDATE work_host SET last_seen_at = clock_timestamp() - interval '30 minutes' \
          WHERE id = $1 AND workspace_id = $2",
    )
    .bind(alive.host_id)
    .bind(tenant.workspace_id)
    .execute(&su)
    .await
    .expect("freeze the paused host's heartbeat");

    let renewable = momo_t3::lease::renewable_lease_candidates(&su, 90, 500, None)
        .await
        .expect("lease candidates");
    let stale = stale_session_candidates(&su, 90, 500)
        .await
        .expect("sweep candidates");
    assert!(
        renewable
            .iter()
            .any(|c| c.cloud_host_id == alive.cloud_host_id),
        "named regression: a paused sandbox's lease ticks exactly like a running one's, and its \
         daemon is frozen so no heartbeat arrives. Keying renewal on heartbeat freshness alone \
         deletes every paused session at one lease"
    );
    assert!(
        !stale
            .iter()
            .any(|c| c.cloud_host_id == Some(alive.cloud_host_id)),
        "a parked host's quiet heartbeat is the pause working, not a loss"
    );

    // The keyset walk really walks: a batch size of 1 must still reach every
    // renewable host, because a renewal writes nothing and so cannot advance the
    // ordering the way the reconciler's claim does. If this ever caps, hosts
    // past the batch are deleted by the substrate one lease later while healthy.
    let mut walked: Vec<Uuid> = Vec::new();
    let mut cursor: Option<Uuid> = None;
    // Bounded on purpose. A cursor that does not advance — the exact shape of
    // the bug this asserts against — makes an unbounded walk spin forever, and a
    // regression that hangs CI is strictly worse than one that fails it.
    for _ in 0..(renewable.len() + 8) {
        let page = momo_t3::lease::renewable_lease_candidates(&su, 90, 1, cursor)
            .await
            .expect("lease page");
        let Some(last) = page.last() else { break };
        assert_ne!(
            Some(last.cloud_host_id),
            cursor,
            "named regression: the cursor did not advance, so the walk is standing still. \
             Renewal writes nothing, so nothing else can move it along"
        );
        cursor = Some(last.cloud_host_id);
        walked.extend(page.iter().map(|c| c.cloud_host_id));
    }
    let mut expected: Vec<Uuid> = renewable.iter().map(|c| c.cloud_host_id).collect();
    expected.sort();
    let mut walked_sorted = walked.clone();
    walked_sorted.sort();
    walked_sorted.dedup();
    assert_eq!(
        walked_sorted.len(),
        walked.len(),
        "named regression: the keyset walk returned a host twice — the cursor and the ORDER BY \
         have drifted apart"
    );
    assert_eq!(
        walked_sorted, expected,
        "named regression: paging with batch size 1 must reach exactly the same hosts one big \
         page does. A cap here silently stops renewing the tail of the fleet"
    );

    let _ = (alive_session, dead_session);
}

// ---------------------------------------------------------------------------
// #10 — a stale T3 host is condemned even when there is nothing to bill (B2)
// ---------------------------------------------------------------------------

/// The branch `t3_terminate` returns early from, and the leak it used to leave.
///
/// `t3_terminate` (058:116) declares the durable destroy intent as part of
/// settling — but it returns `false` at its very first `IF v_usage_id IS NULL`
/// check, which is *before* that declaration. A stale T3 host with no open
/// ledger row therefore reached the end of the sweep with its session moved,
/// nothing billed, and **its paid sandbox still alive in a live state, with no
/// intent standing against it**.
///
/// This is the same defensive branch
/// `momo_t3::reconcile::terminate_missing_instance_in_tx` already guards with
/// `declare_destroy_intent_in_tx` (Swift :437-452); the sweep simply did not.
/// The window that produces it is a session bound to a cloud host whose usage
/// row is absent — a crash between the two writes, or a repair that removed one.
///
/// It matters more here than it would have on any previous substrate. Elsewhere
/// an un-condemned host is eventually rescued by the reconciler's
/// `provider_missing` path when the provider starts answering 404. D4-② proved
/// this substrate never does: 15 consecutive `200 running` replies over 300 s
/// after the VMM was SIGKILLed, zero self-convergence. Nothing rescues it, so
/// the intent has to be declared here or not at all.
///
/// Red when reverted: drop the explicit declaration from `converge_in_tx` and
/// this host stays `running` with a live sandbox nobody will ever destroy.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a fresh pgvector/pg18 DB + momo_app role"]
async fn d2_t3_10_a_stale_host_is_condemned_even_with_nothing_to_bill() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let tenant = seed_tenant(&su).await;
    let host = seed_cloud_host(
        &su,
        &tenant,
        momo_t3::provider::CUBESANDBOX_PROVIDER_ID,
        "nothing-to-bill",
        &bootstrap_digest(),
    )
    .await;
    let session_id = start_paid_session(&app, &tenant, host).await;

    // Remove the ledger row, leaving a live paid host with a running session and
    // nothing for `t3_terminate` to find. The settlement guard (053:86) refuses
    // an application-side `settled_at`, so the window is reproduced by deleting
    // the row rather than by closing it.
    sqlx::query(
        "DELETE FROM work_host_usage_interval i \
          USING work_host_usage u \
          WHERE i.usage_id = u.id AND u.session_id = $1",
    )
    .bind(session_id)
    .execute(&su)
    .await
    .expect("drop the open interval");
    let removed = sqlx::query("DELETE FROM work_host_usage WHERE session_id = $1")
        .bind(session_id)
        .execute(&su)
        .await
        .expect("drop the usage row")
        .rows_affected();
    assert_eq!(removed, 1, "precondition: there is now nothing to bill");

    // The host is up and billable; the daemon has gone quiet.
    let state: String =
        sqlx::query_scalar("SELECT state FROM work_cloud_host WHERE id = $1 AND workspace_id = $2")
            .bind(host.cloud_host_id)
            .bind(tenant.workspace_id)
            .fetch_one(&su)
            .await
            .expect("read the host");
    assert_eq!(
        state, "running",
        "precondition: the sandbox is alive and billable"
    );
    sqlx::query(
        "UPDATE work_host SET last_seen_at = clock_timestamp() - interval '30 minutes' \
          WHERE id = $1 AND workspace_id = $2",
    )
    .bind(host.host_id)
    .bind(tenant.workspace_id)
    .execute(&su)
    .await
    .expect("age the heartbeat");

    let candidates = stale_session_candidates(&su, 90, 500)
        .await
        .expect("sweep candidates");
    let candidate = candidates
        .iter()
        .find(|candidate| candidate.session_id == session_id)
        .expect("the host is quiet past the grace window");

    let convergence = converge_stale_session(&app, candidate, 90)
        .await
        .expect("converge");
    assert!(
        !convergence.settled,
        "precondition: there was nothing left to bill, which is exactly the branch \
         `t3_terminate` returns early from"
    );
    assert!(
        convergence.transitioned,
        "the session still leaves `running` — that half never depended on the ledger"
    );
    assert!(
        convergence.destroy_intended,
        "named regression: nothing to bill is not nothing to reclaim. Without the explicit \
         declaration this host keeps a live paid sandbox with no intent standing against it, and \
         this substrate never volunteers the 404 that would rescue it"
    );

    let state: String =
        sqlx::query_scalar("SELECT state FROM work_cloud_host WHERE id = $1 AND workspace_id = $2")
            .bind(host.cloud_host_id)
            .bind(tenant.workspace_id)
            .fetch_one(&su)
            .await
            .expect("read the host back");
    assert_eq!(
        state, "destroy_pending",
        "the reconciler can only destroy what carries a durable destroy intent"
    );
}
