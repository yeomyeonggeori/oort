//! DB-backed conformance for the agent-run + LLM-billing spine (B2.6).
//!
//! These are the orchestrator's docker-gate red tests. Each proves one invariant
//! with a **named assertion that goes red if the enforcement is reverted** (momo
//! red-test discipline). They are `#[ignore]` because they need a throwaway
//! `pgvector/pgvector:pg18` superuser DB plus the runtime `momo_app` role:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-agent --test conformance_pg -- --ignored --nocapture
//! ```
//!
//! Harness contract (identical to `momo-t3`'s and `momo-messaging`'s suites):
//!   * `DATABASE_URL` connects as a **superuser** — applies all migrations via
//!     `momo_db::run_migrations` + `infra/e2e/bootstrap_roles.sql` through psql,
//!     and seeds fixtures bypassing RLS;
//!   * every assertion under test runs as the runtime **`momo_app`** role
//!     (`NOBYPASSRLS`), the only faithful way to exercise the DB policies.
//!
//! What each test breaks when reverted:
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `b26_1_ledger_row_matches_the_summary_aggregate` | drop the `NOT EXISTS` guard in `record_run_usage_in_tx`, or change the summary's inclusive window / `was_estimated` FILTER |
//! | `b26_2_one_trigger_produces_one_live_run` | drop `agent_run_idem_uniq`, or replace the `ON CONFLICT … DO NOTHING` with a read-then-write |
//! | `b26_3_an_unauthorized_gateway_callback_is_refused` | widen `gateway_lease_authorized`, or drop the run/agent binding from `lock_gateway_lease_in_tx` |
//! | `b26_4_the_shared_schema_still_carries_this_batchs_columns` | any migration edit that moves `usage_ledger.effort`, the `agent_run` idempotency key, or the 008 lease columns |

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_agent::{
    create_agent_run_in_tx, find_agent_run_by_trigger_in_tx, lock_gateway_run_in_tx,
    record_run_usage_in_tx, usage_summary_in_tx, validated_window, NewAgentRun, RunStatus,
    RunTrigger, RunUsageReport,
};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::{with_tenant_tx, PgPool};
use momo_outbox::{
    claim_gateway_jobs_in_tx, emit_outbox, gateway_lease_authorized, lock_gateway_lease_in_tx,
    GatewayLeaseBinding, OutboxKind,
};
use serde_json::json;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::Row;
use uuid::Uuid;

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

/// A workspace with a human, an agent (member + `agent` row), a channel both are
/// members of, and the channel's `channel_seq` row.
struct Tenant {
    workspace_id: Uuid,
    human_id: Uuid,
    agent_id: Uuid,
    channel_id: Uuid,
}

const AGENT_MODEL: &str = "hermes-agent";

async fn seed_tenant(su: &PgPool) -> Tenant {
    let workspace_id = Uuid::new_v4();
    let human_id = Uuid::new_v4();
    let agent_id = Uuid::new_v4();
    let channel_id = Uuid::new_v4();

    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace_id)
        .bind(workspace_id.to_string())
        .execute(su)
        .await
        .expect("seed workspace");

    for (id, kind) in [(human_id, "human"), (agent_id, "agent")] {
        sqlx::query(
            "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
             VALUES ($1, $2, $3::member_kind, $4, $4)",
        )
        .bind(id)
        .bind(workspace_id)
        .bind(kind)
        .bind(id.to_string())
        .execute(su)
        .await
        .expect("seed member");
    }
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, \
                            max_concurrent_runs, max_run_steps) \
         VALUES ($1, $2, $3, 'https://gateway.invalid/v1', 4, 50)",
    )
    .bind(agent_id)
    .bind(workspace_id)
    .bind(AGENT_MODEL)
    .execute(su)
    .await
    .expect("seed agent");

    sqlx::query("INSERT INTO channel (id, workspace_id, kind, name) VALUES ($1, $2, 'public', $3)")
        .bind(channel_id)
        .bind(workspace_id)
        .bind(format!("b26-{}", &channel_id.simple().to_string()[..8]))
        .execute(su)
        .await
        .expect("seed channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel_id)
        .bind(workspace_id)
        .execute(su)
        .await
        .expect("seed channel_seq");

    // Both members are in the channel — `lock_gateway_run_in_tx` requires the
    // agent's membership, so a fixture without it would make every callback 404.
    for member_id in [human_id, agent_id] {
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)",
        )
        .bind(workspace_id)
        .bind(channel_id)
        .bind(member_id)
        .execute(su)
        .await
        .expect("seed membership");
    }

    Tenant {
        workspace_id,
        human_id,
        agent_id,
        channel_id,
    }
}

fn work_input(title: &str) -> serde_json::Value {
    json!({"type": "work", "title": title, "brief": "conformance run"})
}

fn work_trigger(tenant: &Tenant, client_run_id: Uuid) -> RunTrigger {
    RunTrigger::Work {
        channel_id: tenant.channel_id,
        actor_member_id: tenant.human_id,
        agent_member_id: tenant.agent_id,
        client_run_id,
    }
}

/// Create a run and enqueue its gateway `agent_job`, the way the route does —
/// through `emit_outbox`, in the run's own transaction.
async fn create_run_with_job(app: &PgPool, tenant: &Tenant, client_run_id: Uuid) -> (Uuid, i64) {
    let workspace_id = tenant.workspace_id;
    let channel_id = tenant.channel_id;
    let agent_id = tenant.agent_id;
    let trigger = work_trigger(tenant, client_run_id);

    with_tenant_tx(app, workspace_id, move |conn| {
        Box::pin(async move {
            let created = create_agent_run_in_tx(
                conn,
                workspace_id,
                NewAgentRun {
                    channel_id,
                    trigger,
                    parent_run_id: None,
                    max_steps: 50,
                    depth: 0,
                    input: work_input("conformance"),
                },
            )
            .await?;
            let payload = json!({
                "run_id": created.id.to_string(),
                "workspace_id": workspace_id.to_string(),
                "channel_id": channel_id.to_string(),
                "agent_member_id": agent_id.to_string(),
                "model": AGENT_MODEL,
                "delivery": "gateway",
            });
            let job_id = emit_outbox(
                &mut *conn,
                workspace_id,
                OutboxKind::AgentJob,
                "gateway",
                &payload,
                Some(agent_id),
            )
            .await?;
            Ok((created.id, job_id))
        })
    })
    .await
    .expect("create a run and its gateway job")
}

/// Claim the run's job, returning the lease the gateway would then present.
async fn claim_lease(app: &PgPool, tenant: &Tenant, run_id: Uuid) -> GatewayLeaseBinding {
    let workspace_id = tenant.workspace_id;
    let agent_id = tenant.agent_id;
    with_tenant_tx(app, workspace_id, move |conn| {
        Box::pin(async move {
            let claimed = claim_gateway_jobs_in_tx(conn, workspace_id, agent_id, 10).await?;
            let job = claimed
                .into_iter()
                .find(|job| job.run_id_field() == run_id.to_string())
                .expect("the run's job is claimable");
            Ok(GatewayLeaseBinding {
                job_id: job.id,
                lease_id: job.lease_id,
            })
        })
    })
    .await
    .expect("claim the gateway job")
}

// ---------------------------------------------------------------------------
// 1. the bill and the number the workspace is shown are the same number
// ---------------------------------------------------------------------------

/// **Ledger ↔ summary agreement, and the replay that must not double-charge.**
///
/// Two runs are completed with measured usage, then the same completion is
/// replayed. The summary must report the sum of the two rows — not three rows'
/// worth — and every dimension it slices by (`byModel`, `byAgent`, `buckets`,
/// `estimatedMicroUsd`) must add back up to the same total.
///
/// Goes red if the `NOT EXISTS` guard in `record_run_usage_in_tx` is dropped
/// (the replay charges twice), or if the summary's window stops being inclusive
/// on both ends, or if the `was_estimated` FILTER is lost.
#[tokio::test]
#[ignore = "requires a live pgvector/pg18 database (docker gate)"]
async fn b26_1_ledger_row_matches_the_summary_aggregate() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su).await;

    // Two completed runs: one measured, one the adapter could not measure.
    let measured = json!({"cost_micro_usd": 4_200i64, "prompt_tokens": 100,
                          "completion_tokens": 20, "was_estimated": false});
    let estimated = json!({"cost_micro_usd": 800i64, "prompt_tokens": 10,
                           "completion_tokens": 5, "was_estimated": true});
    let mut run_ids = Vec::new();
    for usage in [&measured, &estimated] {
        let (run_id, _) = create_run_with_job(&app, &tenant, Uuid::new_v4()).await;
        run_ids.push(run_id);
        charge_run(&app, &tenant, run_id, usage).await;
    }

    // The replay: same run, same completion, a second time.
    charge_run(&app, &tenant, run_ids[0], &measured).await;

    let workspace_id = tenant.workspace_id;
    let agent_id = tenant.agent_id;
    let ledger_rows: i64 =
        sqlx::query_scalar("SELECT count(*)::bigint FROM usage_ledger WHERE workspace_id = $1")
            .bind(workspace_id)
            .fetch_one(&su)
            .await
            .expect("count ledger rows");
    assert_eq!(
        ledger_rows, 2,
        "a replayed completion must not append a second ledger row — \
         usage_ledger has no UPDATE path, so a double row is a double charge \
         nothing can undo"
    );

    let window = validated_window(None, None, Some("day"), chrono::Utc::now())
        .expect("the default 30-day window");
    let summary = with_tenant_tx(&app, workspace_id, move |conn| {
        Box::pin(async move { usage_summary_in_tx(conn, workspace_id, window).await })
    })
    .await
    .expect("aggregate the ledger");

    assert_eq!(
        summary.totals.cost_micro_usd, 5_000,
        "the summary must report exactly the two ledger rows (4200 + 800)"
    );
    assert_eq!(
        summary.totals.estimated_micro_usd, 800,
        "estimatedMicroUsd isolates the spend the adapter did not measure"
    );
    assert_eq!(summary.totals.prompt_tokens, 110);
    assert_eq!(summary.totals.completion_tokens, 25);

    // Every slice must re-sum to the same total: a projection that disagreed
    // with its own total is how a billing dispute starts.
    let bucket_sum: i64 = summary.buckets.iter().map(|b| b.cost_micro_usd).sum();
    let model_sum: i64 = summary.by_model.iter().map(|m| m.cost_micro_usd).sum();
    let agent_sum: i64 = summary.by_agent.iter().map(|a| a.cost_micro_usd).sum();
    assert_eq!(
        bucket_sum, summary.totals.cost_micro_usd,
        "buckets vs total"
    );
    assert_eq!(model_sum, summary.totals.cost_micro_usd, "byModel vs total");
    assert_eq!(agent_sum, summary.totals.cost_micro_usd, "byAgent vs total");

    assert_eq!(summary.by_model.len(), 1);
    assert_eq!(
        summary.by_model[0].model, AGENT_MODEL,
        "an unreported model falls back to the agent's configured one"
    );
    assert_eq!(summary.by_agent.len(), 1);
    assert_eq!(summary.by_agent[0].agent_member_id, agent_id);

    // A window that ends before the rows exist must report zero, not the total —
    // this is the half that catches an aggregation ignoring its predicate.
    let past = validated_window(
        Some("2020-01-01"),
        Some("2020-02-01"),
        Some("day"),
        chrono::Utc::now(),
    )
    .expect("a past window");
    let empty = with_tenant_tx(&app, workspace_id, move |conn| {
        Box::pin(async move { usage_summary_in_tx(conn, workspace_id, past).await })
    })
    .await
    .expect("aggregate an empty window");
    assert_eq!(empty.totals.cost_micro_usd, 0);
    assert!(empty.buckets.is_empty());
}

/// Complete a run the way the gateway does: lock it, then append the ledger row.
async fn charge_run(app: &PgPool, tenant: &Tenant, run_id: Uuid, usage: &serde_json::Value) {
    let workspace_id = tenant.workspace_id;
    let report = RunUsageReport {
        cost_micro_usd: usage["cost_micro_usd"].as_i64(),
        prompt_tokens: usage["prompt_tokens"].as_i64().map(|v| v as i32),
        completion_tokens: usage["completion_tokens"].as_i64().map(|v| v as i32),
        was_estimated: usage["was_estimated"].as_bool(),
        ..RunUsageReport::default()
    };
    with_tenant_tx(app, workspace_id, move |conn| {
        Box::pin(async move {
            let run = lock_gateway_run_in_tx(conn, workspace_id, run_id)
                .await?
                .expect("the run is callable");
            let resolved = RunUsageReport::resolve(
                Some(&report),
                &run.model,
                run.requested_effort.as_deref(),
                run.profile_effort_pref.as_deref(),
            );
            record_run_usage_in_tx(
                conn,
                workspace_id,
                run_id,
                run.agent_member_id,
                run.channel_id,
                &resolved,
            )
            .await?;
            Ok(())
        })
    })
    .await
    .expect("charge the run");
}

// ---------------------------------------------------------------------------
// 2. one trigger, one run
// ---------------------------------------------------------------------------

/// **A re-triggered run is the same run, and the database is what says so.**
///
/// The same trigger is submitted twice — sequentially, then concurrently — and
/// must yield one `agent_run` row, one live run, and the same id both times.
///
/// Goes red if `agent_run_idem_uniq` is dropped, if the idempotency key stops
/// being derived from the trigger, or if `create_agent_run_in_tx` is rewritten as
/// a read-then-write (which the concurrent half of this test races directly).
#[tokio::test]
#[ignore = "requires a live pgvector/pg18 database (docker gate)"]
async fn b26_2_one_trigger_produces_one_live_run() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su).await;

    let client_run_id = Uuid::new_v4();
    let (first_id, _) = create_run_with_job(&app, &tenant, client_run_id).await;
    let (second_id, _) = create_run_with_job(&app, &tenant, client_run_id).await;
    assert_eq!(
        first_id, second_id,
        "the same trigger must return the run it already created"
    );

    // Concurrency: N simultaneous submissions of one trigger. Exactly one may
    // insert; the rest must read the winner's row rather than erroring or
    // inserting a sibling.
    let concurrent_trigger = Uuid::new_v4();
    let mut handles = Vec::new();
    for _ in 0..8 {
        let app = app.clone();
        let workspace_id = tenant.workspace_id;
        let channel_id = tenant.channel_id;
        let trigger = work_trigger(&tenant, concurrent_trigger);
        handles.push(tokio::spawn(async move {
            with_tenant_tx(&app, workspace_id, move |conn| {
                Box::pin(async move {
                    create_agent_run_in_tx(
                        conn,
                        workspace_id,
                        NewAgentRun {
                            channel_id,
                            trigger,
                            parent_run_id: None,
                            max_steps: 50,
                            depth: 0,
                            input: work_input("racing"),
                        },
                    )
                    .await
                })
            })
            .await
        }));
    }
    let mut ids = Vec::new();
    let mut creators = 0;
    for handle in handles {
        let created = handle
            .await
            .expect("task joins")
            .expect("a concurrent create never fails; it either inserts or reads");
        if created.created {
            creators += 1;
        }
        ids.push(created.id);
    }
    assert_eq!(
        creators, 1,
        "exactly one concurrent submission may insert — more means the unique \
         index is gone and a retry storm can fan out into N runs (and N bills)"
    );
    assert!(
        ids.windows(2).all(|pair| pair[0] == pair[1]),
        "every concurrent caller must hold the same run id"
    );

    let workspace_id = tenant.workspace_id;
    let agent_id = tenant.agent_id;
    let live: i64 = sqlx::query_scalar(
        "SELECT count(*)::bigint FROM agent_run \
          WHERE workspace_id = $1 AND agent_member_id = $2 \
            AND status IN ('queued','running','awaiting_approval','paused')",
    )
    .bind(workspace_id)
    .bind(agent_id)
    .fetch_one(&su)
    .await
    .expect("count live runs");
    assert_eq!(
        live, 2,
        "two distinct triggers produced two runs; the repeats produced none"
    );

    // The trigger is the lookup key, not an opaque id the caller has to keep.
    let trigger = work_trigger(&tenant, client_run_id);
    let found = with_tenant_tx(&app, workspace_id, move |conn| {
        Box::pin(async move { find_agent_run_by_trigger_in_tx(conn, workspace_id, &trigger).await })
    })
    .await
    .expect("look the run up by its trigger")
    .expect("the trigger names a run");
    assert_eq!(found.id, first_id);
    assert_eq!(found.status, RunStatus::Queued);
}

// ---------------------------------------------------------------------------
// 3. an unauthorized callback writes nothing
// ---------------------------------------------------------------------------

/// **The lease is the callback's only authority.**
///
/// Four callers are refused against a real, live job: one presenting a forged
/// lease id, one presenting another run's genuine lease, one presenting the right
/// lease against the wrong run, and one presenting a lease for another agent.
/// Only the true owner is authorized.
///
/// Goes red if `gateway_lease_authorized` stops comparing the owner, or if the
/// `payload->>'run_id'` / `agent_member_id` predicates are dropped from
/// `lock_gateway_lease_in_tx` — either of which would let anybody who learned a
/// `run_id` complete (and bill) somebody else's run.
#[tokio::test]
#[ignore = "requires a live pgvector/pg18 database (docker gate)"]
async fn b26_3_an_unauthorized_gateway_callback_is_refused() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su).await;

    let (run_a, _) = create_run_with_job(&app, &tenant, Uuid::new_v4()).await;
    let (run_b, _) = create_run_with_job(&app, &tenant, Uuid::new_v4()).await;
    let lease_a = claim_lease(&app, &tenant, run_a).await;
    let lease_b = claim_lease(&app, &tenant, run_b).await;
    assert_ne!(lease_a.lease_id, lease_b.lease_id);

    let workspace_id = tenant.workspace_id;
    let agent_id = tenant.agent_id;
    let other_agent = Uuid::new_v4();

    let authorized = |run_id: Uuid, agent: Uuid, lease: GatewayLeaseBinding| {
        let app = app.clone();
        async move {
            with_tenant_tx(&app, workspace_id, move |conn| {
                Box::pin(async move {
                    let snapshot =
                        lock_gateway_lease_in_tx(conn, workspace_id, run_id, agent, lease).await?;
                    Ok(gateway_lease_authorized(snapshot, lease.lease_id, false))
                })
            })
            .await
            .expect("the lease read never fails")
        }
    };

    assert!(
        authorized(run_a, agent_id, lease_a).await,
        "the true owner must be authorized, or this test proves nothing"
    );
    assert!(
        !authorized(
            run_a,
            agent_id,
            GatewayLeaseBinding {
                job_id: lease_a.job_id,
                lease_id: Uuid::new_v4(),
            }
        )
        .await,
        "a forged lease id must be refused"
    );
    assert!(
        !authorized(
            run_a,
            agent_id,
            GatewayLeaseBinding {
                job_id: lease_a.job_id,
                lease_id: lease_b.lease_id,
            }
        )
        .await,
        "another job's GENUINE lease must not authorize this one"
    );
    assert!(
        !authorized(run_b, agent_id, lease_a).await,
        "a valid lease for run A must not authorize a callback about run B"
    );
    assert!(
        !authorized(run_a, other_agent, lease_a).await,
        "the lease is bound to the run's agent, not just to the job id"
    );

    // A second claimer must not be handed the same job: the claim is
    // `FOR UPDATE … SKIP LOCKED` over rows whose lease has not expired.
    let reclaimed = with_tenant_tx(&app, workspace_id, move |conn| {
        Box::pin(async move {
            claim_gateway_jobs_in_tx(conn, workspace_id, agent_id, 10)
                .await
                .map_err(momo_db::DbError::from)
        })
    })
    .await
    .expect("a second claim attempt");
    assert!(
        reclaimed.is_empty(),
        "both jobs are already leased; a second consumer must get nothing, or two \
         gateways would start provider work for one run"
    );

    // Nothing above wrote to the ledger.
    let charged: i64 =
        sqlx::query_scalar("SELECT count(*)::bigint FROM usage_ledger WHERE workspace_id = $1")
            .bind(workspace_id)
            .fetch_one(&su)
            .await
            .expect("count ledger rows");
    assert_eq!(charged, 0, "a refused callback must never bill");
}

// ---------------------------------------------------------------------------
// 4. the shared schema still carries what this batch depends on
// ---------------------------------------------------------------------------

/// **No-regression premise: this batch adds no migration, so it depends entirely
/// on columns the shared schema already has.**
///
/// Every fact asserted here is one the Rust code above would silently
/// mis-execute against a drifted schema: the `agent_run` idempotency uniqueness,
/// `usage_ledger.effort`'s nullable-`text`-with-length-CHECK shape (041), the
/// migration-008 lease columns, and `usage_ledger`'s FORCE RLS.
///
/// Goes red on any migration edit that moves them — which is exactly the review
/// signal wanted, since `server/Migrations/` is shared with the Swift server.
#[tokio::test]
#[ignore = "requires a live pgvector/pg18 database (docker gate)"]
async fn b26_4_the_shared_schema_still_carries_this_batchs_columns() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;

    // agent_run: the trigger-bound idempotency key is UNIQUE per workspace.
    let idem_unique: bool = sqlx::query_scalar(
        "SELECT EXISTS ( \
           SELECT 1 FROM pg_constraint \
            WHERE conrelid = 'agent_run'::regclass \
              AND conname = 'agent_run_idem_uniq' \
              AND contype = 'u')",
    )
    .fetch_one(&su)
    .await
    .expect("inspect agent_run constraints");
    assert!(
        idem_unique,
        "agent_run_idem_uniq (001:290) is what makes one trigger produce one run; \
         without it create_agent_run_in_tx's ON CONFLICT has no target"
    );

    // usage_ledger.effort — added by 041 as nullable text, length 1..32.
    let effort = sqlx::query(
        "SELECT data_type, is_nullable FROM information_schema.columns \
          WHERE table_name = 'usage_ledger' AND column_name = 'effort'",
    )
    .fetch_optional(&su)
    .await
    .expect("inspect usage_ledger.effort")
    .expect("041 added usage_ledger.effort");
    assert_eq!(effort.get::<String, _>("data_type"), "text");
    assert_eq!(
        effort.get::<String, _>("is_nullable"),
        "YES",
        "NULL is the honest value for a run with no chosen or inherited effort (041)"
    );
    let effort_check: bool = sqlx::query_scalar(
        "SELECT EXISTS ( \
           SELECT 1 FROM pg_constraint \
            WHERE conrelid = 'usage_ledger'::regclass \
              AND conname = 'usage_ledger_effort_ck')",
    )
    .fetch_one(&su)
    .await
    .expect("inspect usage_ledger constraints");
    assert!(
        effort_check,
        "the 1..32 length CHECK is the DB half of momo_agent::effort's cap"
    );
    // The cap is enforced by the database, not only by the Rust normalizer.
    let over_length = sqlx::query(
        "INSERT INTO usage_ledger \
           (workspace_id, agent_member_id, model, effort) \
         VALUES ($1, $2, 'm', $3)",
    )
    .bind(Uuid::new_v4())
    .bind(Uuid::new_v4())
    .bind("x".repeat(33))
    .execute(&su)
    .await;
    assert!(
        over_length.is_err(),
        "a 33-character effort must be refused by Postgres even as superuser"
    );

    // usage_ledger has no natural uniqueness on run_id — which is precisely why
    // record_run_usage_in_tx's NOT EXISTS guard must run under the run's lock.
    let run_unique: bool = sqlx::query_scalar(
        "SELECT EXISTS ( \
           SELECT 1 FROM pg_index i \
            WHERE i.indrelid = 'usage_ledger'::regclass AND i.indisunique \
              AND pg_get_indexdef(i.indexrelid) LIKE '%run_id%')",
    )
    .fetch_one(&su)
    .await
    .expect("inspect usage_ledger indexes");
    assert!(
        !run_unique,
        "if a UNIQUE(run_id) index is ever added, record_run_usage_in_tx's \
         NOT EXISTS guard should be replaced by ON CONFLICT DO NOTHING — this \
         assertion exists so that change is a decision, not a surprise"
    );

    // migration 008 lease columns + their shape CHECK.
    for column in ["lease_owner", "lease_acquired_at", "lease_expires_at"] {
        let present: bool = sqlx::query_scalar(
            "SELECT EXISTS ( \
               SELECT 1 FROM information_schema.columns \
                WHERE table_name = 'outbox' AND column_name = $1)",
        )
        .bind(column)
        .fetch_one(&su)
        .await
        .expect("inspect outbox columns");
        assert!(present, "008 added outbox.{column}");
    }
    let lease_shape: bool = sqlx::query_scalar(
        "SELECT EXISTS ( \
           SELECT 1 FROM pg_constraint \
            WHERE conrelid = 'outbox'::regclass \
              AND conname = 'outbox_gateway_lease_shape_ck')",
    )
    .fetch_one(&su)
    .await
    .expect("inspect outbox constraints");
    assert!(
        lease_shape,
        "the all-or-nothing lease CHECK (008) is what stops a half-written claim"
    );

    // FORCE RLS on both tables this batch writes.
    for table in ["agent_run", "usage_ledger"] {
        let row = sqlx::query(
            "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1",
        )
        .bind(table)
        .fetch_one(&su)
        .await
        .expect("inspect pg_class");
        assert!(
            row.get::<bool, _>("relrowsecurity") && row.get::<bool, _>("relforcerowsecurity"),
            "{table} must be FORCE ROW LEVEL SECURITY (invariant #6)"
        );
    }
}
