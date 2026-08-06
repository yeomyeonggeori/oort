//! DB-backed red tests for the tool-call + approval axis (goal SRV-T1).
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-agent --test approval_pg -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! No other env var is required. The three runtime passwords default to the
//! committed test-only credentials in `infra/e2e/bootstrap_roles.sql` (:10/:16/
//! :22) and are overridable with `MOMO_APP_PASSWORD`, `MOMO_WORKER_PASSWORD`
//! and `MOMO_NOTIFIER_PASSWORD`.
//!
//! Harness contract (identical to `conformance_pg.rs` and the worker suite's):
//! `DATABASE_URL` connects as a **superuser** — applies the migrations via
//! `momo_db::run_migrations` plus `infra/e2e/bootstrap_roles.sql` through psql,
//! and seeds fixtures bypassing RLS.
//!
//! ## Three roles, because the production posture is three roles
//!
//! This suite spans a request, a worker claim and a notifier sweep, and those
//! run as **different roles in production**. Using one role for all three would
//! not be a simplification — it would test a deployment that does not exist:
//!
//! | what | role | why |
//! |---|---|---|
//! | every request-path assertion | `momo_app` (**NOBYPASSRLS**) | the only faithful way to exercise the RLS policies |
//! | `claim_agent_job_batch` | `momo_worker` (**BYPASSRLS**) | the claim has **no workspace predicate and sets no tenant GUC** — a worker drains every tenant |
//! | `workspaces_with_overdue_approvals` | `momo_notifier` (**BYPASSRLS**) | same shape: a sweep cannot know which tenants need visiting until it looks |
//!
//! Getting that wrong is not a cosmetic test bug, and this suite learned it the
//! hard way: running the claim as `momo_app` makes the `outbox` policy evaluate
//! `current_setting('app.workspace_id', true)::uuid` with the GUC **unset**, and
//! Postgres answers `22P02 invalid input syntax for type uuid: ""` — a failure
//! that looks like a payload defect and is actually a posture defect. The two
//! BYPASSRLS pools below are what production uses, so the claim and the sweep
//! are exercised exactly as they ship.
//!
//! Each test is named after the thing that makes it red when reverted:
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `t1_1_an_approval_gated_tool_does_not_run_without_a_decision` | let the producer skip `park_run_for_approval_in_tx`, or make `approval_reason` default to exempt |
//! | `t1_2_a_rejection_ends_the_run_and_the_tool_never_runs` | let `end_parked_run_in_tx` drop its `awaiting_approval` guard, or resume on a rejection |
//! | `t1_3_an_approved_run_is_requeued_and_its_resume_job_is_claimable` | narrow the worker claim back to `method = 'publish'` (the B5.1 swallow) |
//! | `t1_4_an_expired_approval_releases_the_agents_concurrency_gate` | drop `expires_at` from `NewApproval`, or delete the sweep |
//! | `t1_5_tool_messages_consume_channel_seq_and_reach_the_outbox` | bypass `send_message_in_tx` for tool rows, or bump `channel_seq` by hand |
//! | `t1_6_another_tenants_approval_cannot_be_locked_or_decided` | drop the `workspace_id` predicate in `lock_approval_in_tx`, or `FORCE ROW LEVEL SECURITY` on `approval` |
//! | `t1_7_a_replayed_decision_is_idempotent` | drop `approval_decision_workspace_uniq` |

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use chrono::Utc;
use momo_agent::approval::{
    approval_payload, approval_request_props, attach_request_message_in_tx,
    create_pending_approval_in_tx, default_expires_at, existing_decision_in_tx,
    is_active_human_member_in_tx, list_approvals_in_tx, lock_approval_in_tx,
    mark_approval_decided_in_tx, mark_approval_expired_in_tx, record_decision_in_tx,
    resume_job_payload, NewApproval,
};
use momo_agent::tools::{ToolCall, ACTION_TYPE_TOOL_CALL};
use momo_agent::{
    approval_reason, consume_run_step_in_tx, create_agent_run_in_tx, end_parked_run_in_tx,
    live_run_count_in_tx, load_agent_run_in_tx, park_run_for_approval_in_tx,
    requeue_run_from_approval_in_tx, NewAgentRun, RunStatus, RunTrigger,
};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::{with_tenant_tx, PgPool};
use momo_messaging::{send_message_in_tx, MessageType, NewMessage};
use momo_outbox::{claim_agent_job_batch, emit_outbox, OutboxKind, RESUME_APPROVAL_JOB_METHOD};
use serde_json::json;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::Row;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness (mirrors conformance_pg.rs)
// ---------------------------------------------------------------------------

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("DATABASE_URL must point at a throwaway conformance DB")
}

/// The committed test-only credentials from `infra/e2e/bootstrap_roles.sql`
/// (not real secrets). Same defaults every other DB suite in this repo uses —
/// a suite that invented its own would fail auth on the shared gate.
fn momo_app_password() -> String {
    std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string())
}

fn momo_worker_password() -> String {
    std::env::var("MOMO_WORKER_PASSWORD").unwrap_or_else(|_| "momo_worker_dev_pw".to_string())
}

fn momo_notifier_password() -> String {
    std::env::var("MOMO_NOTIFIER_PASSWORD").unwrap_or_else(|_| "momo_notifier_dev_pw".to_string())
}

/// Reconnect `DATABASE_URL` as a named runtime role.
///
/// Built from `PgConnectOptions` rather than by rewriting the URL string: a
/// textual `replacen` silently produces a *valid-looking* URL when the input
/// does not match the shape it assumed, and the resulting auth failure points
/// at the credential instead of at the rewrite.
async fn role_pool(username: &str, password: &str) -> PgPool {
    let opts: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(opts.username(username).password(password))
        .await
        .unwrap_or_else(|error| {
            panic!("connect as {username} (run bootstrap_roles.sql first): {error}")
        })
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect as superuser")
}

/// The request path: NOBYPASSRLS, so every policy is live.
async fn momo_app_pool() -> PgPool {
    role_pool("momo_app", &momo_app_password()).await
}

/// The pool the agent worker runs on. BYPASSRLS by design — see the module docs.
async fn momo_worker_pool() -> PgPool {
    role_pool("momo_worker", &momo_worker_password()).await
}

/// The pool momo-notifier runs its sweeps on. BYPASSRLS for the same reason.
async fn momo_notifier_pool() -> PgPool {
    role_pool("momo_notifier", &momo_notifier_password()).await
}

/// Same resolver as this crate's `conformance_pg.rs` (goal SRV-B3f).
///
/// It used to be a bare `"psql"`, which meant this suite — the ONLY DB coverage
/// of the approval axis — silently required psql on `PATH`. On a machine where
/// it lives only in Homebrew's keg-only libpq (the usual macOS shape) all seven
/// cases failed at `apply_bootstrap_roles` with `NotFound`, before a single
/// assertion ran. `PSQL_BIN` still wins so an operator can point at a specific
/// client.
fn resolve_psql() -> PathBuf {
    if let Ok(explicit) = std::env::var("PSQL_BIN") {
        return PathBuf::from(explicit);
    }
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
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.pop();
    path.pop();
    path.pop();
    path.join("infra/e2e/bootstrap_roles.sql")
}

fn apply_bootstrap_roles() {
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .arg("-v")
        .arg("ON_ERROR_STOP=1")
        .arg("-f")
        .arg(bootstrap_roles_path())
        .status()
        .expect("run psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed");
}

static SCHEMA: Mutex<bool> = Mutex::new(false);

fn ensure_schema_and_roles() {
    let mut done = SCHEMA.lock().expect("schema lock");
    if *done {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations on a fresh pgvector/pg18 DB");
    apply_bootstrap_roles();
    *done = true;
}

struct Tenant {
    workspace_id: Uuid,
    human_id: Uuid,
    agent_id: Uuid,
    channel_id: Uuid,
}

/// `max_concurrent_runs = 1` on purpose: that is the schema default
/// (`001_init.sql:84`) and the number that makes an unreleased approval hold
/// fatal rather than merely untidy.
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
         VALUES ($1, $2, 'hermes-agent', 'https://gateway.invalid/v1', 1, 50)",
    )
    .bind(agent_id)
    .bind(workspace_id)
    .execute(su)
    .await
    .expect("seed agent");

    sqlx::query("INSERT INTO channel (id, workspace_id, kind, name) VALUES ($1, $2, 'public', $3)")
        .bind(channel_id)
        .bind(workspace_id)
        .bind(format!("t1-{}", &channel_id.simple().to_string()[..8]))
        .execute(su)
        .await
        .expect("seed channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel_id)
        .bind(workspace_id)
        .execute(su)
        .await
        .expect("seed channel_seq");
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

fn tool_call() -> ToolCall {
    ToolCall {
        call_id: "call_t1".to_string(),
        name: momo_agent::WORK_SESSION_END.to_string(),
        arguments: json!({"session_id": Uuid::new_v4().to_string()}),
    }
}

/// Create a run and drive it to `running`, the state the producer parks from.
async fn running_run(app: &PgPool, tenant: &Tenant) -> Uuid {
    let workspace_id = tenant.workspace_id;
    let agent_id = tenant.agent_id;
    let channel_id = tenant.channel_id;
    let human_id = tenant.human_id;
    with_tenant_tx(app, workspace_id, move |conn| {
        Box::pin(async move {
            let trigger = RunTrigger::Work {
                channel_id,
                actor_member_id: human_id,
                agent_member_id: agent_id,
                client_run_id: Uuid::new_v4(),
            };
            let created = create_agent_run_in_tx(
                conn,
                workspace_id,
                NewAgentRun {
                    channel_id,
                    trigger,
                    parent_run_id: None,
                    max_steps: 12,
                    depth: 0,
                    input: json!({"type": "work", "title": "t1"}),
                },
            )
            .await?;
            momo_agent::mark_run_started_in_tx(conn, created.id).await?;
            Ok(created.id)
        })
    })
    .await
    .expect("create running run")
}

/// The producer transaction, exactly as the worker composes it.
async fn park_on_approval(app: &PgPool, tenant: &Tenant, run_id: Uuid, ttl_seconds: i64) -> Uuid {
    let workspace_id = tenant.workspace_id;
    let agent_id = tenant.agent_id;
    let channel_id = tenant.channel_id;
    let call = tool_call();

    with_tenant_tx(app, workspace_id, move |conn| {
        Box::pin(async move {
            send_message_in_tx(
                conn,
                workspace_id,
                NewMessage {
                    channel_id,
                    author_member_id: agent_id,
                    message_type: MessageType::ToolCall,
                    body: Some(call.message_body()),
                    props: call.message_props(),
                    root_id: None,
                    reply_to_id: None,
                    client_msg_id: Some(Uuid::new_v5(&run_id, call.call_id.as_bytes())),
                    run_id: Some(run_id),
                    hlc_ts: None,
                    hlc_count: None,
                },
            )
            .await?;
            consume_run_step_in_tx(conn, run_id, 12).await?;

            let now = Utc::now();
            let expires_at = default_expires_at(now, ttl_seconds);
            let payload = approval_payload(
                run_id,
                ACTION_TYPE_TOOL_CALL,
                &call,
                "{}",
                None,
                "grant_missing_or_ambiguous",
                None,
            );
            let approval_id = create_pending_approval_in_tx(
                conn,
                workspace_id,
                NewApproval {
                    run_id,
                    channel_id,
                    requested_by: agent_id,
                    action_type: ACTION_TYPE_TOOL_CALL.to_string(),
                    payload,
                    expires_at,
                },
            )
            .await?;
            let card = send_message_in_tx(
                conn,
                workspace_id,
                NewMessage {
                    channel_id,
                    author_member_id: agent_id,
                    message_type: MessageType::ApprovalRequest,
                    body: Some(momo_agent::approval::approval_request_body(&call.name)),
                    props: approval_request_props(
                        approval_id,
                        run_id,
                        channel_id,
                        ACTION_TYPE_TOOL_CALL,
                        &call,
                        "{}",
                        expires_at,
                        None,
                    ),
                    root_id: None,
                    reply_to_id: None,
                    client_msg_id: Some(approval_id),
                    run_id: Some(run_id),
                    hlc_ts: None,
                    hlc_count: None,
                },
            )
            .await?;
            attach_request_message_in_tx(conn, workspace_id, approval_id, card.message.id).await?;
            assert!(
                park_run_for_approval_in_tx(conn, run_id, expires_at).await?,
                "a running run must be parkable"
            );
            Ok(approval_id)
        })
    })
    .await
    .expect("park on approval")
}

/// Settle every leftover pending/processing worker `agent_job` before a claim.
///
/// `claim_agent_job_batch` is a **global** consumer claim (`kind='agent_job'`,
/// no workspace predicate), exactly like `momo-relay`'s broadcast claim, so an
/// earlier binary's or an earlier suite's row lands in this suite's batch. The
/// worker suite opens the same way and documents the same reason. Without it
/// this test would also *steal* another suite's job — taking a 300 s lease on a
/// row it will never run.
async fn settle_residual_worker_jobs(su: &PgPool) {
    sqlx::query(
        "UPDATE outbox SET status = 'done', processed_at = now() \
          WHERE kind = 'agent_job' AND method = ANY($1) \
            AND status IN ('pending', 'processing')",
    )
    .bind(momo_outbox::WORKER_JOB_METHODS.map(str::to_string).to_vec())
    .execute(su)
    .await
    .expect("settle residual agent jobs");
}

// ---------------------------------------------------------------------------
// the red tests
// ---------------------------------------------------------------------------

/// **The gate itself.** A tool with no grant projection is approval-required
/// (G6 fails closed), the run parks, and nothing has executed.
#[tokio::test]
#[ignore]
async fn t1_1_an_approval_gated_tool_does_not_run_without_a_decision() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su).await;

    assert!(
        approval_reason(momo_agent::WORK_SESSION_END, None).requires_approval(),
        "G6 must fail closed with no tool_grants projection — a permissive \
         default lets an irreversible action run with nobody's permission"
    );

    let run_id = running_run(&app, &tenant).await;
    let approval_id = park_on_approval(&app, &tenant, run_id, 3_600).await;

    let workspace_id = tenant.workspace_id;
    let run = with_tenant_tx(&app, workspace_id, move |conn| {
        Box::pin(async move { load_agent_run_in_tx(conn, workspace_id, run_id).await })
    })
    .await
    .expect("load run")
    .expect("run exists");

    assert_eq!(
        run.status,
        RunStatus::AwaitingApproval,
        "the producer must transition the run into the hold; before this batch \
         NOTHING in Rust could reach this status"
    );
    assert!(
        run.step_count >= 1,
        "the tool call must spend a G3 step, or a model that always answers \
         with a tool call loops until the lease dies"
    );

    let pending: i64 =
        sqlx::query_scalar("SELECT count(*) FROM approval WHERE id = $1 AND status = 'pending'")
            .bind(approval_id)
            .fetch_one(&su)
            .await
            .expect("count pending");
    assert_eq!(pending, 1, "the approval row must exist and be pending");
}

/// **A rejection ends the run, and the tool never runs.**
#[tokio::test]
#[ignore]
async fn t1_2_a_rejection_ends_the_run_and_the_tool_never_runs() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su).await;

    let run_id = running_run(&app, &tenant).await;
    let approval_id = park_on_approval(&app, &tenant, run_id, 3_600).await;
    let workspace_id = tenant.workspace_id;
    let human_id = tenant.human_id;

    with_tenant_tx(&app, workspace_id, move |conn| {
        Box::pin(async move {
            let approval = lock_approval_in_tx(conn, workspace_id, approval_id)
                .await?
                .expect("approval visible in its own tenant");
            let now = Utc::now();
            mark_approval_decided_in_tx(conn, approval.id, "rejected", human_id, now, Some("no"))
                .await?;
            assert!(
                end_parked_run_in_tx(
                    conn,
                    approval.run_id,
                    RunStatus::Cancelled,
                    &json!({"code": "approval_rejected"}),
                )
                .await?,
                "a parked run must be endable by a rejection"
            );
            Ok(())
        })
    })
    .await
    .expect("reject");

    let run = with_tenant_tx(&app, workspace_id, move |conn| {
        Box::pin(async move { load_agent_run_in_tx(conn, workspace_id, run_id).await })
    })
    .await
    .expect("load run")
    .expect("run exists");
    assert_eq!(
        run.status,
        RunStatus::Cancelled,
        "a rejected approval must terminate its run, not leave it parked"
    );

    // And a second decision cannot revive it: the requeue is guarded on
    // `awaiting_approval`, which the rejection already left.
    let revived = with_tenant_tx(&app, workspace_id, move |conn| {
        Box::pin(async move { requeue_run_from_approval_in_tx(conn, run_id).await })
    })
    .await
    .expect("requeue attempt");
    assert!(
        !revived,
        "an approval arriving after a rejection must NOT resurrect the run — \
         the tool would run after a human said no"
    );
}

/// **The swallow, closed.** An approved decision enqueues `resume_approval`, and
/// the worker's claim actually returns it. Before this batch the claim predicate
/// was `method = 'publish'` and this row sat forever.
#[tokio::test]
#[ignore]
async fn t1_3_an_approved_run_is_requeued_and_its_resume_job_is_claimable() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    settle_residual_worker_jobs(&su).await;
    let tenant = seed_tenant(&su).await;

    let run_id = running_run(&app, &tenant).await;
    let approval_id = park_on_approval(&app, &tenant, run_id, 3_600).await;
    let workspace_id = tenant.workspace_id;
    let human_id = tenant.human_id;
    let agent_id = tenant.agent_id;

    with_tenant_tx(&app, workspace_id, move |conn| {
        Box::pin(async move {
            let approval = lock_approval_in_tx(conn, workspace_id, approval_id)
                .await?
                .expect("approval");
            let now = Utc::now();
            let event = momo_agent::approval::decision_event_payload(
                &approval,
                "approved",
                Some(human_id),
                now,
                None,
            );
            mark_approval_decided_in_tx(conn, approval.id, "approved", human_id, now, None).await?;
            record_decision_in_tx(
                conn,
                workspace_id,
                approval.id,
                Uuid::new_v4(),
                human_id,
                true,
                "approved",
                None,
                &momo_agent::approval::decision_receipt(
                    approval.id,
                    "approved",
                    Some(human_id),
                    now,
                    None,
                ),
            )
            .await?;
            assert!(
                requeue_run_from_approval_in_tx(conn, approval.run_id).await?,
                "an approved run must leave the hold"
            );
            emit_outbox(
                &mut *conn,
                workspace_id,
                OutboxKind::AgentJob,
                RESUME_APPROVAL_JOB_METHOD,
                &resume_job_payload(workspace_id, &approval, human_id, &event, None),
                Some(agent_id),
            )
            .await
            .map_err(momo_db::DbError::from)?;
            Ok(())
        })
    })
    .await
    .expect("approve");

    let run = with_tenant_tx(&app, workspace_id, move |conn| {
        Box::pin(async move { load_agent_run_in_tx(conn, workspace_id, run_id).await })
    })
    .await
    .expect("load run")
    .expect("run exists");
    assert_eq!(
        run.status,
        RunStatus::Queued,
        "an approved run returns to the queue so the worker can resume it"
    );

    // THE assertion this batch exists for on the consumer side.
    //
    // Claimed on the **`momo_worker`** pool, which is the posture the worker
    // binary actually runs in: the claim carries no workspace predicate and
    // sets no tenant GUC, so a NOBYPASSRLS role would make the `outbox` policy
    // cast an unset `app.workspace_id` and die with
    // `22P02 … invalid input syntax for type uuid: ""`.
    let worker = momo_worker_pool().await;
    let claimed = claim_agent_job_batch(&worker, 50, 300)
        .await
        .expect("claim agent jobs");
    let mine = claimed
        .iter()
        .find(|job| job.method == RESUME_APPROVAL_JOB_METHOD && job.workspace_id == workspace_id);
    let mine = mine.expect(
        "the worker claim must return `resume_approval` rows — with the B5.1 \
         `method = 'publish'` predicate this job is never claimed, and a person \
         who tapped 승인 watches nothing happen, with no failure anywhere",
    );
    assert_eq!(mine.partition_key, Some(agent_id));
    let payload: serde_json::Value =
        serde_json::from_str(&mine.payload).expect("resume payload decodes");
    assert_eq!(payload["resume_from_approval_id"], approval_id.to_string());
    assert_eq!(payload["approved_by"], human_id.to_string());
    assert_eq!(
        payload["step_count"], 1,
        "the G3 budget must survive the pause, or an approved call resumes with \
         a fresh allowance and the step cap stops bounding the loop"
    );

    // The consumer's two REQUIRED keys. `AgentJobPayload` decodes every other
    // field with `#[serde(default)]`, so a resume payload missing either of
    // these is poison: the worker fails the row permanently and — because the
    // claim serializes per agent — that dead row would then block every future
    // job for this agent. A shape only the producer knows is exactly the defect
    // class this batch was sent back for.
    assert!(
        payload["agent_member_id"].is_string() && payload["channel_id"].is_string(),
        "the resume payload must carry the two keys AgentJobPayload requires: {payload}"
    );
    assert_eq!(payload["agent_member_id"], agent_id.to_string());
    assert_eq!(
        payload["approved_tool_call"]["name"],
        momo_agent::WORK_SESSION_END,
        "the approved call must survive the pause, or the resume runs nothing"
    );
    assert_eq!(payload["approved_tool_call"]["call_id"], "call_t1");
}

/// **The gate is released without anyone clicking.** `max_concurrent_runs` is 1
/// here, so a parked run occupies the agent's only slot; the expiry path must
/// hand it back.
#[tokio::test]
#[ignore]
async fn t1_4_an_expired_approval_releases_the_agents_concurrency_gate() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su).await;

    let run_id = running_run(&app, &tenant).await;
    // A deadline already in the past — what the sweep finds on its next tick.
    let approval_id = park_on_approval(&app, &tenant, run_id, 3_600).await;
    sqlx::query("UPDATE approval SET expires_at = now() - interval '1 minute' WHERE id = $1")
        .bind(approval_id)
        .execute(&su)
        .await
        .expect("backdate the deadline");

    let workspace_id = tenant.workspace_id;
    let agent_id = tenant.agent_id;

    let held = with_tenant_tx(&app, workspace_id, move |conn| {
        Box::pin(async move { live_run_count_in_tx(conn, workspace_id, agent_id).await })
    })
    .await
    .expect("count live runs");
    assert_eq!(
        held, 1,
        "a parked run counts as live — this is the gate the expiry has to free \
         (agent.max_concurrent_runs defaults to 1)"
    );

    // Step 1 of the sweep, in the posture momo-notifier actually runs it: a
    // cross-tenant read on the **`momo_notifier`** pool with no tenant GUC. This
    // is the same shape that broke the claim above, so it is asserted here
    // rather than assumed — a sweep that cannot find its candidates releases
    // nothing, and the gate stays held with no error anywhere.
    let notifier = momo_notifier_pool().await;
    let mut notifier_conn = notifier
        .acquire()
        .await
        .expect("acquire a momo_notifier connection");
    let due = momo_agent::approval::workspaces_with_overdue_approvals(&mut notifier_conn, 500)
        .await
        .expect("the notifier role must be able to scan for overdue approvals across tenants");
    drop(notifier_conn);
    assert!(
        due.contains(&workspace_id),
        "the sweep's candidate query must find this workspace; without it the \
         expiry never runs and one unanswered approval silences the agent forever"
    );

    // Step 2: the settlement, through the same domain calls momo-notifier makes.
    let expired = with_tenant_tx(&app, workspace_id, move |conn| {
        Box::pin(async move {
            let candidates =
                momo_agent::approval::overdue_approvals_in_tx(conn, workspace_id, 50).await?;
            let mut count = 0usize;
            for candidate in candidates {
                let approval = lock_approval_in_tx(conn, workspace_id, candidate.id)
                    .await?
                    .expect("approval");
                if mark_approval_expired_in_tx(conn, approval.id, Utc::now(), "expired").await? {
                    end_parked_run_in_tx(
                        conn,
                        approval.run_id,
                        RunStatus::TimedOut,
                        &json!({"code": "approval_expired"}),
                    )
                    .await?;
                    count += 1;
                }
            }
            Ok(count)
        })
    })
    .await
    .expect("sweep");
    assert_eq!(expired, 1, "the overdue approval must be found and settled");

    let after = with_tenant_tx(&app, workspace_id, move |conn| {
        Box::pin(async move { live_run_count_in_tx(conn, workspace_id, agent_id).await })
    })
    .await
    .expect("count live runs");
    assert_eq!(
        after, 0,
        "an expired approval MUST release the concurrency gate. Without this the \
         first unanswered approval silences the agent permanently — every later \
         run is refused and nothing anywhere says why"
    );

    let run = with_tenant_tx(&app, workspace_id, move |conn| {
        Box::pin(async move { load_agent_run_in_tx(conn, workspace_id, run_id).await })
    })
    .await
    .expect("load run")
    .expect("run exists");
    assert_eq!(run.status, RunStatus::TimedOut);
}

/// **Tool rows are messages.** They take a real `channel_seq` bump, land in
/// `message` with gapless seqs, and produce a broadcast outbox row — no private
/// path, no hand-rolled counter.
#[tokio::test]
#[ignore]
async fn t1_5_tool_messages_consume_channel_seq_and_reach_the_outbox() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su).await;

    let run_id = running_run(&app, &tenant).await;
    park_on_approval(&app, &tenant, run_id, 3_600).await;

    let rows = sqlx::query(
        "SELECT type::text AS kind, seq FROM message \
          WHERE channel_id = $1 ORDER BY seq",
    )
    .bind(tenant.channel_id)
    .fetch_all(&su)
    .await
    .expect("read messages");
    let kinds: Vec<String> = rows
        .iter()
        .map(|row| row.get::<String, _>("kind"))
        .collect();
    assert_eq!(
        kinds,
        vec!["tool_call".to_string(), "approval_request".to_string()],
        "the producer writes the call and then the card, in that order — a \
         person must see the agent ask before anything is decided about it"
    );

    let seqs: Vec<i64> = rows.iter().map(|row| row.get::<i64, _>("seq")).collect();
    assert_eq!(
        seqs,
        vec![1, 2],
        "tool rows are ordinary messages and must consume the channel counter \
         gaplessly — a private insert that skipped channel_seq would desync \
         every client's ordering"
    );

    let last_seq: i64 =
        sqlx::query_scalar("SELECT last_seq FROM channel_seq WHERE channel_id = $1")
            .bind(tenant.channel_id)
            .fetch_one(&su)
            .await
            .expect("read counter");
    assert_eq!(last_seq, 2, "the counter itself must have advanced");

    let broadcasts: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox \
          WHERE workspace_id = $1 AND kind = 'broadcast' AND partition_key = $2",
    )
    .bind(tenant.workspace_id)
    .bind(tenant.channel_id)
    .fetch_one(&su)
    .await
    .expect("count broadcasts");
    assert_eq!(
        broadcasts, 2,
        "each tool message must leave through emit_outbox — the single egress \
         (invariant #3). A tool row that skipped it would never reach a client"
    );
}

/// **Cross-tenant.** Another workspace's approval is invisible and undecidable,
/// under the runtime role with RLS FORCE.
#[tokio::test]
#[ignore]
async fn t1_6_another_tenants_approval_cannot_be_locked_or_decided() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let victim = seed_tenant(&su).await;
    let attacker = seed_tenant(&su).await;

    let run_id = running_run(&app, &victim).await;
    let approval_id = park_on_approval(&app, &victim, run_id, 3_600).await;

    let attacker_ws = attacker.workspace_id;
    let attacker_human = attacker.human_id;

    // Locking it from the attacker's tenant transaction finds nothing.
    let seen = with_tenant_tx(&app, attacker_ws, move |conn| {
        Box::pin(async move { lock_approval_in_tx(conn, attacker_ws, approval_id).await })
    })
    .await
    .expect("lock attempt");
    assert!(
        seen.is_none(),
        "another tenant's approval must be NOT FOUND — a 403 would confirm it \
         exists, and a successful lock would be a cross-tenant write"
    );

    // Naming the victim's workspace_id while holding the attacker's GUC is
    // refused by RLS FORCE, not merely by the predicate.
    let cross = with_tenant_tx(&app, attacker_ws, move |conn| {
        Box::pin(async move {
            let victim_ws =
                sqlx::query_scalar::<_, i64>("SELECT count(*) FROM approval WHERE id = $1")
                    .bind(approval_id)
                    .fetch_one(&mut *conn)
                    .await?;
            Ok(victim_ws)
        })
    })
    .await
    .expect("cross-tenant count");
    assert_eq!(
        cross, 0,
        "FORCE ROW LEVEL SECURITY must hide the row from the momo_app role even \
         when the query names its id directly"
    );

    // And it never appears in the attacker's inbox.
    let inbox = with_tenant_tx(&app, attacker_ws, move |conn| {
        Box::pin(async move {
            list_approvals_in_tx(conn, attacker_ws, attacker_human, "pending", 100).await
        })
    })
    .await
    .expect("list");
    assert!(
        inbox.is_empty(),
        "the inbox joins membership, so an approval raised in a room this person \
         is not in cannot be listed"
    );

    // The victim's own human still sees exactly one — the control that proves
    // the assertions above are not passing because everything is invisible.
    let victim_ws = victim.workspace_id;
    let victim_human = victim.human_id;
    let owned = with_tenant_tx(&app, victim_ws, move |conn| {
        Box::pin(async move {
            assert!(is_active_human_member_in_tx(conn, victim_human).await?);
            list_approvals_in_tx(conn, victim_ws, victim_human, "pending", 100).await
        })
    })
    .await
    .expect("list");
    assert_eq!(owned.len(), 1, "the owning tenant still sees its approval");
    assert_eq!(owned[0].id, approval_id);
}

/// A replayed decision returns the first receipt rather than deciding twice.
#[tokio::test]
#[ignore]
async fn t1_7_a_replayed_decision_is_idempotent() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su).await;

    let run_id = running_run(&app, &tenant).await;
    let approval_id = park_on_approval(&app, &tenant, run_id, 3_600).await;
    let workspace_id = tenant.workspace_id;
    let human_id = tenant.human_id;
    let client_decision_id = Uuid::new_v4();

    let receipt = momo_agent::approval::decision_receipt(
        approval_id,
        "approved",
        Some(human_id),
        Utc::now(),
        None,
    );
    let stored = receipt.clone();
    with_tenant_tx(&app, workspace_id, move |conn| {
        Box::pin(async move {
            record_decision_in_tx(
                conn,
                workspace_id,
                approval_id,
                client_decision_id,
                human_id,
                true,
                "approved",
                None,
                &stored,
            )
            .await
        })
    })
    .await
    .expect("record decision");

    let replay = with_tenant_tx(&app, workspace_id, move |conn| {
        Box::pin(
            async move { existing_decision_in_tx(conn, workspace_id, client_decision_id).await },
        )
    })
    .await
    .expect("replay lookup")
    .expect("the ledger row is found");
    assert_eq!(replay.approval_id, approval_id);
    assert!(replay.approve);
    assert_eq!(
        replay.receipt, receipt,
        "a double-tap on a phone must return the ORIGINAL receipt — re-deciding \
         would let one tap produce two histories"
    );

    // The unique index is what enforces it, not the read above.
    let second = with_tenant_tx(&app, workspace_id, move |conn| {
        Box::pin(async move {
            record_decision_in_tx(
                conn,
                workspace_id,
                approval_id,
                client_decision_id,
                human_id,
                true,
                "approved",
                None,
                &json!({}),
            )
            .await
        })
    })
    .await;
    assert!(
        second.is_err(),
        "approval_decision_workspace_uniq must refuse a second row for one \
         client_decision_id"
    );
}
