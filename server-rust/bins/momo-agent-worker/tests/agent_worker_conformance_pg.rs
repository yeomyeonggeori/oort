//! DB-backed conformance for the agent turn loop (B5.1).
//!
//! These are the orchestrator's docker-gate red tests. Each proves one invariant
//! with a **named assertion that goes red if the enforcement is reverted** (momo
//! red-test discipline). They are `#[ignore]` because they need a throwaway
//! `pgvector/pgvector:pg18` superuser DB plus the runtime roles:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-agent-worker --test agent_worker_conformance_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Harness contract (identical to `momo-agent`'s and `momo-messaging`'s suites):
//! `DATABASE_URL` connects as a **superuser** — applies all migrations via
//! `momo_db::run_migrations` plus `infra/e2e/bootstrap_roles.sql` through psql,
//! and seeds fixtures bypassing RLS. The worker itself runs as the BYPASSRLS
//! **`momo_worker`** role, which is the only faithful posture: the claim has no
//! workspace predicate because a worker drains every tenant.
//!
//! ## Why this suite sweeps residue and `momo-agent`'s does not
//!
//! `claim_agent_job_batch` is a **global** consumer claim — `kind='agent_job'
//! AND method='publish'`, no workspace predicate, on a pool that sets no tenant
//! GUC. That is the same shape as `momo-relay`'s broadcast claim, and it has the
//! same consequence: an earlier binary's (or an earlier test's) leftover row
//! lands in this suite's batch and inflates its `DrainStats`. So, exactly like
//! `momo-relay`, every test opens with [`settle_residual_worker_jobs`]. The
//! gateway suite needs no such sweep because its claim filters on
//! `workspace_id` — do not copy this helper there.
//!
//! Beyond the sweep, every assertion is scoped to the test's own fresh
//! `workspace_id`, so the suite returns the same verdict on a clean database and
//! on one a full `--test-threads=1` gate run has already been through.
//!
//! What each test breaks when reverted:
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `b51_1_a_turn_answers_in_the_channel_and_bills_the_run` | route the reply around `send_message_in_tx` (no `seq`, no broadcast), or drop `record_run_usage_in_tx`/`finish_run_in_tx` from the turn transaction |
//! | `b51_2_a_provider_failure_is_visible_to_the_user_and_retried_only_when_worth_it` | post the failure notice on every attempt instead of the last, or widen `is_retryable` so a 4xx is retried |
//! | `b51_3_one_agent_runs_one_job_at_a_time_and_two_agents_run_together` | drop the `NOT EXISTS` in-flight predicate or the `row_number() = 1` rank, or "fix" the claim into a global `LIMIT 1` |
//! | `b51_4_the_operators_bearer_never_reaches_a_row_a_message_or_an_error` | remove `redact_secrets`, or start logging/persisting the resolved endpoint |

use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use momo_agent::{create_agent_run_in_tx, NewAgentRun, RunTrigger};
use momo_agent_worker::provider::{ChatProvider, MockChatProvider, ProviderError};
use momo_agent_worker::{AgentWorker, WorkerConfig};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::{with_tenant_tx, PgPool};
use momo_messaging::{send_message_in_tx, NewMessage};
use momo_outbox::{emit_outbox, OutboxKind, DEFAULT_WORKER_LEASE_SECONDS};
use momo_settings::{seal_bearer, upsert_link};
use serde_json::{json, Value};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::Row;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a fresh pgvector/pg18 superuser DB")
}

/// The `momo_worker` runtime password — the committed test-only credential from
/// `infra/e2e/bootstrap_roles.sql:16` (not a real secret); override via env.
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

/// The pool the worker runs on: the BYPASSRLS `momo_worker` role.
async fn momo_worker_pool() -> PgPool {
    let opts: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    let opts = opts
        .username("momo_worker")
        .password(&momo_worker_password());
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(opts)
        .await
        .expect("connect as momo_worker (run bootstrap_roles.sql first)")
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

/// Retire every worker job this suite did not enqueue, so a global claim cannot
/// pull an unrelated run into this test's batch. See the module docs.
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

// ---------------------------------------------------------------------------
// fixtures (superuser → RLS bypassed)
// ---------------------------------------------------------------------------

const AGENT_MODEL: &str = "hermes-agent";
const HUMAN_DISPLAY: &str = "성재";

struct Tenant {
    workspace_id: Uuid,
    human_id: Uuid,
    agent_id: Uuid,
    channel_id: Uuid,
}

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

    for (id, kind, display) in [
        (human_id, "human", HUMAN_DISPLAY.to_string()),
        (agent_id, "agent", "hermes".to_string()),
    ] {
        sqlx::query(
            "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
             VALUES ($1, $2, $3::member_kind, $4, $5)",
        )
        .bind(id)
        .bind(workspace_id)
        .bind(kind)
        .bind(display)
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
        .bind(format!("b51-{}", &channel_id.simple().to_string()[..8]))
        .execute(su)
        .await
        .expect("seed channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel_id)
        .bind(workspace_id)
        .execute(su)
        .await
        .expect("seed channel_seq");

    // The agent's channel membership is load-bearing: `lock_gateway_run_in_tx`
    // returns `None` without it, and the worker would suppress every turn.
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

/// Seed a second agent inside an existing tenant (the per-agent serialization
/// test needs two partitions in one workspace).
async fn seed_second_agent(su: &PgPool, tenant: &Tenant) -> Uuid {
    let agent_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent'::member_kind, 'atlas', $3)",
    )
    .bind(agent_id)
    .bind(tenant.workspace_id)
    .bind(agent_id.to_string())
    .execute(su)
    .await
    .expect("seed second agent member");
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, \
                            max_concurrent_runs, max_run_steps) \
         VALUES ($1, $2, $3, 'https://gateway.invalid/v1', 4, 50)",
    )
    .bind(agent_id)
    .bind(tenant.workspace_id)
    .bind(AGENT_MODEL)
    .execute(su)
    .await
    .expect("seed second agent");
    sqlx::query("INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)")
        .bind(tenant.workspace_id)
        .bind(tenant.channel_id)
        .bind(agent_id)
        .execute(su)
        .await
        .expect("seed second agent membership");
    agent_id
}

/// The whole producer side of a mention, as `MessageRoutes.routeAgentMentions`
/// performs it: the human's message, an `agent_run` keyed on it, and the
/// `method='publish'` job — all through the same chokepoints the server uses.
async fn enqueue_mention_turn(
    pool: &PgPool,
    tenant: &Tenant,
    agent_id: Uuid,
    body: &str,
) -> (Uuid, Uuid, i64) {
    let workspace_id = tenant.workspace_id;
    let channel_id = tenant.channel_id;
    let human_id = tenant.human_id;
    let body = body.to_string();

    with_tenant_tx(pool, workspace_id, move |conn| {
        Box::pin(async move {
            let trigger_message = send_message_in_tx(
                conn,
                workspace_id,
                NewMessage::text(channel_id, human_id, body.clone()),
            )
            .await?;

            let created = create_agent_run_in_tx(
                conn,
                workspace_id,
                NewAgentRun {
                    channel_id,
                    trigger: RunTrigger::Mention {
                        message_id: trigger_message.message.id,
                        agent_member_id: agent_id,
                    },
                    parent_run_id: None,
                    max_steps: 50,
                    depth: 0,
                    input: json!({
                        "schema": "momo.agent_run.input.v0",
                        "surface": "mention",
                        "prompt": body,
                    }),
                },
            )
            .await?;

            let payload = json!({
                "run_id": created.id,
                "workspace_id": workspace_id,
                "channel_id": channel_id,
                "agent_member_id": agent_id,
                "author_member_id": human_id,
                "trigger_message_id": trigger_message.message.id,
                "trigger_message_seq": trigger_message.message.seq,
                "model": AGENT_MODEL,
                "prompt": body,
                "recent_messages": [{
                    "message_id": trigger_message.message.id,
                    "channel_id": channel_id,
                    "seq": trigger_message.message.seq,
                    "author_member_id": human_id,
                    "author_kind": "human",
                    "author_display": HUMAN_DISPLAY,
                    "type": "text",
                    "body": body,
                }],
                "max_output_tokens": 512,
                "delivery": "worker",
                "created_from": "server.message_send.agent_mention.v0",
            });
            let job_id = emit_outbox(
                &mut *conn,
                workspace_id,
                OutboxKind::AgentJob,
                // The worker's feed. `gateway` would be a different consumer's.
                "publish",
                &payload,
                Some(agent_id),
            )
            .await
            .map_err(momo_db::DbError::from)?;

            Ok((created.id, trigger_message.message.id, job_id))
        })
    })
    .await
    .expect("enqueue a mention turn")
}

async fn build_worker(provider: Arc<dyn ChatProvider>, config: WorkerConfig) -> AgentWorker {
    AgentWorker::new(momo_worker_pool().await, provider, config)
}

/// The suite's only departure from the shipped defaults: a batch big enough that
/// `b51_3` can prove the claim admits **one job per agent** rather than one job
/// per call. Split from [`base_config`] so the pure assertion below can exercise
/// it without a database.
fn tune(mut config: WorkerConfig) -> WorkerConfig {
    config.claim_batch_size = 10;
    config
}

fn base_config() -> WorkerConfig {
    tune(WorkerConfig::for_target(database_url()))
}

// ---------------------------------------------------------------------------
// readers
// ---------------------------------------------------------------------------

async fn agent_messages(
    su: &PgPool,
    tenant: &Tenant,
    agent_id: Uuid,
) -> Vec<(Uuid, i64, String, Value)> {
    sqlx::query(
        "SELECT id, seq, COALESCE(body, '') AS body, props FROM message \
          WHERE workspace_id = $1 AND channel_id = $2 AND author_member_id = $3 \
          ORDER BY seq",
    )
    .bind(tenant.workspace_id)
    .bind(tenant.channel_id)
    .bind(agent_id)
    .fetch_all(su)
    .await
    .expect("read agent messages")
    .into_iter()
    .map(|row| {
        (
            row.get::<Uuid, _>("id"),
            row.get::<i64, _>("seq"),
            row.get::<String, _>("body"),
            row.get::<Value, _>("props"),
        )
    })
    .collect()
}

async fn run_status(su: &PgPool, run_id: Uuid) -> String {
    sqlx::query_scalar("SELECT status::text FROM agent_run WHERE id = $1")
        .bind(run_id)
        .fetch_one(su)
        .await
        .expect("read run status")
}

async fn job_row(su: &PgPool, job_id: i64) -> (String, i32, Option<String>) {
    let row = sqlx::query(
        "SELECT status::text AS status, attempts, last_error FROM outbox WHERE id = $1",
    )
    .bind(job_id)
    .fetch_one(su)
    .await
    .expect("read outbox job");
    (
        row.get::<String, _>("status"),
        row.get::<i32, _>("attempts"),
        row.get::<Option<String>, _>("last_error"),
    )
}

/// Every string this workspace persisted anywhere a secret could hide.
async fn all_persisted_text(su: &PgPool, tenant: &Tenant) -> String {
    let mut buffer = String::new();
    for sql in [
        "SELECT COALESCE(body, '') || ' ' || props::text FROM message WHERE workspace_id = $1",
        "SELECT payload::text FROM outbox WHERE workspace_id = $1",
        "SELECT COALESCE(input::text, '') || ' ' || COALESCE(output::text, '') || ' ' \
              || COALESCE(error::text, '') FROM agent_run WHERE workspace_id = $1",
        "SELECT model || ' ' || COALESCE(effort, '') FROM usage_ledger WHERE workspace_id = $1",
        "SELECT action || ' ' || COALESCE(detail::text, '') FROM audit_log WHERE workspace_id = $1",
    ] {
        let rows: Vec<String> = sqlx::query_scalar(sql)
            .bind(tenant.workspace_id)
            .fetch_all(su)
            .await
            .expect("read persisted text");
        for row in rows {
            buffer.push_str(&row);
            buffer.push('\n');
        }
    }
    // `outbox.last_error` is workspace-scoped too, but read separately because
    // it is the field a failure path writes and the one most likely to carry a
    // provider's own error string.
    let errors: Vec<String> =
        sqlx::query_scalar("SELECT COALESCE(last_error, '') FROM outbox WHERE workspace_id = $1")
            .bind(tenant.workspace_id)
            .fetch_all(su)
            .await
            .expect("read outbox errors");
    for error in errors {
        buffer.push_str(&error);
        buffer.push('\n');
    }
    buffer
}

// ---------------------------------------------------------------------------
// b51_1 — the turn reaches the channel through the message spine
// ---------------------------------------------------------------------------

/// The whole point of the batch: a mention becomes an agent message a client can
/// recover by `seq`, a `succeeded` run, and one ledger row — committed together.
///
/// The `seq` assertion is the one that catches the tempting shortcut. An agent
/// reply written with its own INSERT would still *appear* in the channel, but it
/// would not have bumped `channel_seq`, would carry no broadcast row for the
/// relay, and would be invisible to every client that recovers by cursor.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a throwaway pgvector/pg18 database"]
async fn b51_1_a_turn_answers_in_the_channel_and_bills_the_run() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let tenant = seed_tenant(&su).await;

    let (run_id, trigger_message_id, job_id) =
        enqueue_mention_turn(&su, &tenant, tenant.agent_id, "@hermes 오늘 일정 알려줘").await;

    let provider = Arc::new(MockChatProvider::echo());
    let worker = build_worker(provider.clone(), base_config()).await;
    let stats = worker.drain_once().await.expect("drain");

    assert_eq!(stats.claimed, 1, "exactly this suite's job was claimed");
    assert_eq!(stats.answered, 1, "the turn produced an answer");

    // 1. The reply is a real channel message with a seq, authored by the agent.
    let messages = agent_messages(&su, &tenant, tenant.agent_id).await;
    assert_eq!(messages.len(), 1, "exactly one agent reply");
    let (message_id, seq, body, props) = messages.into_iter().next().unwrap();
    assert!(seq > 0, "the reply carries a channel_seq-assigned seq");
    assert_eq!(
        body, "mock: [성재] @hermes 오늘 일정 알려줘",
        "the provider saw the attributed history window, not a bare prompt"
    );
    assert_eq!(props["run_id"], json!(run_id));
    assert_eq!(props["source"], json!("agent_worker.final_text.v0"));
    assert_eq!(props["trigger_message_id"], json!(trigger_message_id));

    // 2. It went out through the single write path, so the relay can publish it.
    let broadcasts: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox \
          WHERE workspace_id = $1 AND kind = 'broadcast' \
            AND payload->'data'->>'id' = $2::text",
    )
    .bind(tenant.workspace_id)
    .bind(message_id.to_string())
    .fetch_one(&su)
    .await
    .expect("count broadcasts");
    assert_eq!(
        broadcasts, 1,
        "the reply enqueued exactly one broadcast — a hand-rolled INSERT would enqueue none"
    );

    // 3. The run reached its terminal state.
    assert_eq!(run_status(&su, run_id).await, "succeeded");

    // 4. The turn is billed once, with the measured token counts.
    let ledger = sqlx::query(
        "SELECT model, prompt_tokens, completion_tokens, cached_tokens, \
                reasoning_tokens, was_estimated \
           FROM usage_ledger WHERE workspace_id = $1 AND run_id = $2",
    )
    .bind(tenant.workspace_id)
    .bind(run_id)
    .fetch_all(&su)
    .await
    .expect("read ledger");
    assert_eq!(ledger.len(), 1, "exactly one immutable ledger row per run");
    assert_eq!(ledger[0].get::<String, _>("model"), AGENT_MODEL);
    assert_eq!(ledger[0].get::<i32, _>("prompt_tokens"), 11);
    assert_eq!(ledger[0].get::<i32, _>("completion_tokens"), 7);
    assert_eq!(ledger[0].get::<i32, _>("cached_tokens"), 3);
    assert_eq!(ledger[0].get::<i32, _>("reasoning_tokens"), 2);
    assert!(
        !ledger[0].get::<bool, _>("was_estimated"),
        "a provider that reported usage produces a measured row, not an estimated one"
    );

    // 5. The job is retired, so it can never run a second time.
    let (status, attempts, _) = job_row(&su, job_id).await;
    assert_eq!(status, "done");
    assert_eq!(attempts, 1);

    // 6. Re-draining changes nothing: no second answer, no second charge.
    let again = worker.drain_once().await.expect("second drain");
    assert_eq!(again.claimed, 0, "a settled job is not re-claimable");
    assert_eq!(agent_messages(&su, &tenant, tenant.agent_id).await.len(), 1);
    assert_eq!(provider.calls().len(), 1, "the provider was paid once");
}

// ---------------------------------------------------------------------------
// b51_2 — failure is visible, and retried only when retrying can help
// ---------------------------------------------------------------------------

/// A failed turn must reach the user, and the retry split must hold: a 5xx is an
/// outage worth another attempt, a 4xx is an answer about this request that
/// retrying only re-buys.
///
/// Both halves are here because they fail in opposite directions. Post the
/// notice on every attempt and a flaky gateway spams the channel; never post it
/// and an outage is indistinguishable from an agent ignoring you.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a throwaway pgvector/pg18 database"]
async fn b51_2_a_provider_failure_is_visible_to_the_user_and_retried_only_when_worth_it() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let tenant = seed_tenant(&su).await;

    // --- half 1: a 5xx with attempts left is requeued SILENTLY ---
    let (run_a, _, job_a) =
        enqueue_mention_turn(&su, &tenant, tenant.agent_id, "@hermes 첫 번째").await;
    let mut retrying = base_config();
    retrying.max_attempts = 8;
    let worker = build_worker(
        Arc::new(MockChatProvider::failing(ProviderError::HttpStatus(500))),
        retrying,
    )
    .await;
    let stats = worker.drain_once().await.expect("drain");
    assert_eq!(stats.requeued, 1, "a 5xx with budget left is retried");
    assert_eq!(stats.failed, 0);

    let (status, attempts, last_error) = job_row(&su, job_a).await;
    assert_eq!(status, "pending", "the job went back to the queue");
    assert_eq!(attempts, 1);
    assert!(
        last_error.as_deref().unwrap_or_default().contains("500"),
        "the reason is recorded for the operator: {last_error:?}"
    );
    assert!(
        agent_messages(&su, &tenant, tenant.agent_id)
            .await
            .is_empty(),
        "a retryable blip must NOT post a failure notice — that is channel spam"
    );
    assert_eq!(
        run_status(&su, run_a).await,
        "failed",
        "a run between attempts is `failed`, not `running` — Swift :555, and G1's \
         live-run count must not keep the agent's slot held for a turn that is \
         only waiting out a backoff"
    );

    // --- half 2: the last attempt tells the user and stops ---
    settle_residual_worker_jobs(&su).await;
    let (run_b, _, job_b) =
        enqueue_mention_turn(&su, &tenant, tenant.agent_id, "@hermes 두 번째").await;
    let mut terminal = base_config();
    terminal.max_attempts = 1; // the claim's own increment exhausts the budget
    let worker = build_worker(
        Arc::new(MockChatProvider::failing(ProviderError::HttpStatus(500))),
        terminal,
    )
    .await;
    let stats = worker.drain_once().await.expect("drain");
    assert_eq!(stats.failed, 1, "an exhausted job stops");

    let messages = agent_messages(&su, &tenant, tenant.agent_id).await;
    assert_eq!(messages.len(), 1, "exactly one failure notice");
    let (_, seq, body, props) = messages.into_iter().next().unwrap();
    assert!(
        seq > 0,
        "the notice is a real message, recoverable by cursor"
    );
    assert!(
        body.contains("Check the local provider endpoint/token"),
        "the notice names what an operator can act on: {body}"
    );
    assert_eq!(props["source"], json!("agent_worker.provider_failure.v0"));
    assert_eq!(run_status(&su, run_b).await, "failed");
    assert_eq!(job_row(&su, job_b).await.0, "failed");

    // --- half 3: a 4xx is terminal on the FIRST attempt, budget or not ---
    settle_residual_worker_jobs(&su).await;
    let (run_c, _, job_c) =
        enqueue_mention_turn(&su, &tenant, tenant.agent_id, "@hermes 세 번째").await;
    let mut generous = base_config();
    generous.max_attempts = 8;
    let worker = build_worker(
        Arc::new(MockChatProvider::failing(ProviderError::HttpStatus(401))),
        generous,
    )
    .await;
    let stats = worker.drain_once().await.expect("drain");
    assert_eq!(
        stats.failed, 1,
        "a bad credential is not an outage; retrying it 8 times only re-buys the same 401"
    );
    assert_eq!(stats.requeued, 0);
    assert_eq!(job_row(&su, job_c).await.0, "failed");
    assert_eq!(run_status(&su, run_c).await, "failed");
    assert_eq!(
        agent_messages(&su, &tenant, tenant.agent_id).await.len(),
        2,
        "the 401 turn also told the user"
    );
}

// ---------------------------------------------------------------------------
// b51_3 — per-agent serialization
// ---------------------------------------------------------------------------

/// L4 §3.5: `partition_key = agent_member_id` serializes an agent's turns. Two
/// jobs for one agent must run one at a time; two jobs for *different* agents
/// must not wait on each other.
///
/// The second half is what makes this test load-bearing. A claim "fixed" into a
/// global `LIMIT 1` would pass the first assertion and quietly serialize the
/// whole fleet behind one slow agent.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a throwaway pgvector/pg18 database"]
async fn b51_3_one_agent_runs_one_job_at_a_time_and_two_agents_run_together() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let tenant = seed_tenant(&su).await;
    let second_agent = seed_second_agent(&su, &tenant).await;

    // Two jobs for the first agent, one for the second — all pending at once.
    let (run_1, _, job_1) =
        enqueue_mention_turn(&su, &tenant, tenant.agent_id, "@hermes 하나").await;
    let (run_2, _, job_2) = enqueue_mention_turn(&su, &tenant, tenant.agent_id, "@hermes 둘").await;
    let (run_3, _, _) = enqueue_mention_turn(&su, &tenant, second_agent, "@atlas 하나").await;

    let provider = Arc::new(MockChatProvider::echo());
    let worker = build_worker(provider.clone(), base_config()).await;

    // One claim, batch size 10, three runnable jobs.
    let first = worker.drain_once().await.expect("first drain");
    assert_eq!(
        first.claimed, 2,
        "one job per agent — not three (no serialization) and not one (global serialization)"
    );
    assert_eq!(first.answered, 2);

    // The agent's own second job waited, and is claimable now that the first settled.
    assert_eq!(job_row(&su, job_1).await.0, "done");
    assert_eq!(job_row(&su, job_2).await.0, "pending");
    assert_eq!(run_status(&su, run_1).await, "succeeded");
    assert_eq!(run_status(&su, run_3).await, "succeeded");
    assert_eq!(
        run_status(&su, run_2).await,
        "queued",
        "the queued turn was not started while its agent was busy"
    );

    let second = worker.drain_once().await.expect("second drain");
    assert_eq!(
        second.claimed, 1,
        "the held job runs once its agent is free"
    );
    assert_eq!(second.answered, 1);
    assert_eq!(run_status(&su, run_2).await, "succeeded");

    // Both of the agent's turns are in the channel, in enqueue order.
    let messages = agent_messages(&su, &tenant, tenant.agent_id).await;
    assert_eq!(messages.len(), 2);
    assert!(messages[0].2.ends_with("하나"), "{}", messages[0].2);
    assert!(messages[1].2.ends_with("둘"), "{}", messages[1].2);
    assert!(
        messages[0].1 < messages[1].1,
        "the serialized turns kept their order in the timeline"
    );
}

// ---------------------------------------------------------------------------
// b51_4 — the operator's bearer stays out of everything durable
// ---------------------------------------------------------------------------

/// ADR-0004 Rules #2/#5: the decrypted `provider_link` bearer exists in memory on
/// the request boundary and nowhere else.
///
/// The test is deliberately not vacuous. It first proves the worker *did* resolve
/// and use the operator's secret (a worker that silently fell back to env would
/// pass a naive "the secret is absent" scan trivially), and only then proves the
/// secret is absent from every durable surface — including the failure path,
/// where a gateway echoes the key back inside its own error text.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a throwaway pgvector/pg18 database"]
async fn b51_4_the_operators_bearer_never_reaches_a_row_a_message_or_an_error() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let tenant = seed_tenant(&su).await;

    const MASTER_KEY: &str = "b51-conformance-master-key";
    const BEARER: &str = "sk-live-b51conformanceonly";
    let sealed = seal_bearer(BEARER, MASTER_KEY).expect("seal the operator bearer");
    let worker_pool = momo_worker_pool().await;
    {
        // Seeded as the BYPASSRLS worker role: `provider_link` is an
        // instance-global singleton behind an operator-only policy, and this is
        // the same posture the worker itself reads it with.
        let mut conn = worker_pool.acquire().await.expect("acquire");
        upsert_link(
            &mut conn,
            "https://gateway.example/v1",
            &sealed,
            "external-hermes",
            tenant.human_id,
        )
        .await
        .expect("seed provider_link");
    }

    let mut config = base_config();
    config.provider_link_master_key = Some(MASTER_KEY.to_string());

    // --- half 1: the worker really used the operator's link ---
    let (_, _, _) = enqueue_mention_turn(&su, &tenant, tenant.agent_id, "@hermes 비밀 확인").await;
    let provider = Arc::new(MockChatProvider::echo());
    let worker = AgentWorker::new(worker_pool.clone(), provider.clone(), config.clone());
    let stats = worker.drain_once().await.expect("drain");
    assert_eq!(stats.answered, 1);

    let calls = provider.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0].bearer, BEARER,
        "the DB link must beat env, or this test proves nothing"
    );
    assert_eq!(calls[0].base_url, "https://gateway.example/v1");

    // --- half 2: a gateway that echoes the key back must not publish it ---
    settle_residual_worker_jobs(&su).await;
    let (run_b, _, job_b) =
        enqueue_mention_turn(&su, &tenant, tenant.agent_id, "@hermes 실패 확인").await;
    let mut terminal = config.clone();
    terminal.max_attempts = 1;
    let leaky = Arc::new(MockChatProvider::failing(ProviderError::ErrorEnvelope(
        format!("invalid api key: {BEARER} — rotate it"),
    )));
    let worker = AgentWorker::new(worker_pool.clone(), leaky, terminal);
    let stats = worker.drain_once().await.expect("drain");
    assert_eq!(stats.failed, 1);
    assert_eq!(run_status(&su, run_b).await, "failed");

    let (_, _, last_error) = job_row(&su, job_b).await;
    let last_error = last_error.unwrap_or_default();
    assert!(
        last_error.contains("<redacted>"),
        "the echoed key is redacted in outbox.last_error: {last_error}"
    );

    // --- the scan: nothing durable in this workspace carries the secret ---
    let persisted = all_persisted_text(&su, &tenant).await;
    assert!(
        !persisted.contains(BEARER),
        "the decrypted bearer reached a durable row"
    );
    assert!(
        !persisted.contains(MASTER_KEY),
        "the master key reached a durable row"
    );
    // The ciphertext is the ONLY place the secret may live, and it is not in
    // this scan's tables — assert it is still there so the test cannot pass by
    // the link having been wiped.
    let stored_len: i32 =
        sqlx::query_scalar("SELECT octet_length(bearer_ciphertext) FROM provider_link WHERE id")
            .fetch_one(&su)
            .await
            .expect("read the sealed bearer");
    assert!(stored_len > 28, "the sealed bearer is still stored");

    // And the turns still happened — a worker that answered nothing would also
    // leak nothing.
    let messages = agent_messages(&su, &tenant, tenant.agent_id).await;
    assert_eq!(messages.len(), 2, "one answer plus one failure notice");
}

/// The suite's fixtures must not silently drift away from the shipped defaults —
/// a lease shorter than a turn would make `b51_3`'s serialization assertion pass
/// for the wrong reason (takeover, not queueing). Runs without a database.
#[test]
fn the_suite_runs_on_the_shipped_lease_default() {
    let config = tune(WorkerConfig::for_target(
        "postgres://unused/for-this-assertion",
    ));
    assert_eq!(
        config.lease_seconds, DEFAULT_WORKER_LEASE_SECONDS,
        "a shortened lease would let b51_3 pass by takeover instead of queueing"
    );
    assert_eq!(
        config.claim_batch_size, 10,
        "batch > 1 is what makes b51_3 meaningful"
    );
}
