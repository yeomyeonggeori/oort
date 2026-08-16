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
//! | `uxc_a_1_a_completion_report_rides_the_ordinary_turn_message` | leave the report fence in the body, stop merging the card into the turn's props, take `elapsed_ms` from the model instead of `agent_run.started_at`, or give the card its own `message_type`/row instead of the turn's |
//! | `uxc_a_2_a_streamed_report_lands_on_the_message_the_reader_watched` | drop the props patch a deduped commit needs, move it after the closing slice (the row moves with no frame to say so), or stop cutting the fence out of the streamed slices |
//!
//! The DB-free half of the report's conformance — the producer against the core
//! contract file it must match — is `completion_report_conformance.rs`, which
//! needs no database and therefore runs in every `cargo test`.

use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use momo_agent::{create_agent_run_in_tx, A2aLimits, NewAgentRun, RunTrigger};
use momo_agent_worker::a2a::{route_a2a_mentions_in_tx, A2aSend};
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
        // Every method the claim can take, not just 'publish'. goal SRV-T1
        // widened `claim_agent_job_batch` to `method = ANY(['publish',
        // 'resume_approval'])`, so a sweep still filtering on 'publish' would
        // leave exactly the rows the claim now picks up — and this suite's
        // DrainStats would count another suite's resume job.
        "UPDATE outbox SET status = 'done', processed_at = now() \
          WHERE kind = 'agent_job' AND method = ANY($1) \
            AND status IN ('pending', 'processing')",
    )
    .bind(momo_outbox::WORKER_JOB_METHODS.map(str::to_string).to_vec())
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

/// `agent_run.error`, which is where the provider's own words live now that the
/// channel notice is a fixed Korean sentence (goal B8 H2).
async fn run_error(su: &PgPool, run_id: Uuid) -> Value {
    sqlx::query_scalar::<_, Option<Value>>("SELECT error FROM agent_run WHERE id = $1")
        .bind(run_id)
        .fetch_one(su)
        .await
        .expect("read run error")
        .unwrap_or(Value::Null)
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

    // 1b. ADR-0148 규칙 6 — the answer QUOTES the message it answers. Agent =
    // member, no branch: this is the same `reply_to_id` a human's quote uses,
    // and it is what puts the question above the answer in the channel's main
    // flow instead of folding the exchange into a thread. Goes red if the worker
    // returns to pinning `None` and leaving the linkage in `props`, where only
    // this worker could read it.
    let quoted: Option<Uuid> = sqlx::query_scalar("SELECT reply_to_id FROM message WHERE id = $1")
        .bind(message_id)
        .fetch_one(&su)
        .await
        .expect("read reply_to_id");
    assert_eq!(
        quoted,
        Some(trigger_message_id),
        "an agent's answer points at the utterance that raised it"
    );

    // 2. It went out through the single write path, so the relay can publish it.
    let broadcasts: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox \
          WHERE workspace_id = $1 AND kind = 'broadcast' \
            AND payload->'data'->'payload'->>'id' = $2::text",
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
        Arc::new(MockChatProvider::failing(ProviderError::HttpStatus(
            500,
            "upstream model is unavailable".to_string(),
        ))),
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
        Arc::new(MockChatProvider::failing(ProviderError::HttpStatus(
            500,
            "upstream model is unavailable".to_string(),
        ))),
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
    // goal B8 H2: the notice is one Korean sentence and the provider's own text
    // is NOT in it. Both halves are asserted, because dropping either one is a
    // silent regression: a notice that leaks the raw reason is the bug, and a
    // run record that lost it is a support case with no evidence.
    assert!(
        body.contains("다시 멘션"),
        "the notice says what the reader can do: {body}"
    );
    assert!(
        !body.contains("upstream model is unavailable") && !body.contains("HTTP 500"),
        "the provider's own words never reach the channel: {body}"
    );
    assert!(
        props.get("error").is_none(),
        "…nor the message props: {props}"
    );
    assert_eq!(props["source"], json!("agent_worker.provider_failure.v0"));
    assert_eq!(run_status(&su, run_b).await, "failed");
    let recorded = run_error(&su, run_b).await;
    assert_eq!(recorded["code"], json!("provider_failed"));
    assert!(
        recorded["reason"]
            .as_str()
            .unwrap_or_default()
            .contains("upstream model is unavailable"),
        "…but the run record keeps them for support: {recorded}"
    );
    assert_eq!(job_row(&su, job_b).await.0, "failed");

    // --- half 3: a 4xx is terminal on the FIRST attempt, budget or not ---
    settle_residual_worker_jobs(&su).await;
    let (run_c, _, job_c) =
        enqueue_mention_turn(&su, &tenant, tenant.agent_id, "@hermes 세 번째").await;
    let mut generous = base_config();
    generous.max_attempts = 8;
    let worker = build_worker(
        Arc::new(MockChatProvider::failing(ProviderError::HttpStatus(
            401,
            "invalid api key".to_string(),
        ))),
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

// ---------------------------------------------------------------------------
// ADR-0155 — a cancel that lands on a turn which was already streaming
// ---------------------------------------------------------------------------

/// **The wiring, end to end.** The worker's suppressed-cancel arm must close the
/// message the turn left open — not just be *able* to.
///
/// The other cancel test in this repo (`stream_message_conformance_pg`) calls
/// the closing helper directly, which proves the statement and nothing about
/// whether anybody calls it. Here the only thing driven is `drain_once`: a run
/// with a half-written message, cancelled before the worker commits.
///
/// Delete the `close_stopped_stream` call from `commit_turn` and this is the
/// assertion that goes red — and the shape it goes red in is the shape a user
/// would have seen: a message sitting `streaming: true` under a `cancelled` run,
/// forever, with a caret blinking for text that is never coming. No error, no
/// log line, no failed request; that silence is why this test exists at the
/// worker's own entry point rather than one layer down.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a throwaway pgvector/pg18 database"]
async fn a_cancel_closes_the_message_a_streaming_turn_left_open() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let tenant = seed_tenant(&su).await;

    let (run_id, _trigger_message_id, _job_id) =
        enqueue_mention_turn(&su, &tenant, tenant.agent_id, "@hermes 긴 답 좀").await;

    // The turn starts streaming: the answer is already half in the channel when
    // the human reaches for the button. This is the producer sequence, not a
    // hand-written row — a fixture that reached `streaming: true` some other way
    // would prove the close against a shape production cannot make.
    let worker_pool = momo_worker_pool().await;
    let mut streaming = momo_agent_worker::stream::MessageStream::new(
        worker_pool.clone(),
        tenant.workspace_id,
        tenant.channel_id,
        tenant.agent_id,
        run_id,
        None,
        serde_json::json!({}),
    );
    streaming
        .push("생각해 보면", false)
        .await
        .expect("the first slice lands");
    streaming
        .push(" 그건", false)
        .await
        .expect("the second slice lands");
    let message_id = streaming.message_id().expect("the stream opened a message");

    // The human presses stop.
    let workspace_id = tenant.workspace_id;
    let cancelled = with_tenant_tx(&worker_pool, workspace_id, move |conn| {
        Box::pin(async move {
            momo_agent::cancel_run_in_tx(
                conn,
                workspace_id,
                run_id,
                &json!({"code": "cancelled", "reason": "사람이 정지를 눌렀다"}),
            )
            .await
        })
    })
    .await
    .expect("the cancel statement ran");
    assert!(cancelled, "the run was cancellable");

    // …and only now does the worker get to the job.
    let provider = Arc::new(MockChatProvider::echo());
    let worker = build_worker(provider.clone(), base_config()).await;
    let stats = worker.drain_once().await.expect("drain");
    assert_eq!(stats.claimed, 1, "the job was claimed");
    assert_eq!(
        stats.answered, 0,
        "the answer the human cancelled is never posted"
    );
    assert_eq!(stats.skipped, 1, "the job settles done without an answer");

    let messages = agent_messages(&su, &tenant, tenant.agent_id).await;
    assert_eq!(
        messages.len(),
        1,
        "the cancelled turn adds no second message — the one it was growing is all there is"
    );
    let (found_id, _seq, body, props) = messages.into_iter().next().unwrap();
    assert_eq!(found_id, message_id);
    assert_eq!(
        body, "생각해 보면 그건",
        "the half answer is frozen exactly where the human read it"
    );
    let stream_props = &props["momo.stream"];
    assert_eq!(
        stream_props["outcome"],
        json!("cancelled"),
        "THE assertion: the worker actually issued the closing PATCH — props were {props}"
    );
    assert_eq!(
        stream_props["streaming"],
        json!(false),
        "and nothing more is coming, so no client draws a caret on it"
    );

    let run_status: String = sqlx::query_scalar("SELECT status::text FROM agent_run WHERE id = $1")
        .bind(run_id)
        .fetch_one(&su)
        .await
        .expect("read run status");
    assert_eq!(
        run_status, "cancelled",
        "the cancel is not revived by the turn arriving late"
    );
}

// ---------------------------------------------------------------------------
// #1161 — the in-process flip: a turn's answer arrives while it is being written
// ---------------------------------------------------------------------------

/// Every broadcast this channel enqueued, as `(type, count, total payload
/// bytes)`.
///
/// Bytes as well as counts because the two halves of a window are not the same
/// size and the decision about whether both should stay turns on exactly that
/// (see `partial`'s module header).
async fn broadcast_stats(su: &PgPool, channel_id: Uuid) -> Vec<(String, i64, i64)> {
    sqlx::query(
        "SELECT payload->'data'->>'type' AS type, count(*) AS n, \
                sum(length(payload::text))::bigint AS bytes \
           FROM outbox \
          WHERE partition_key = $1 AND kind::text = 'broadcast' \
          GROUP BY 1 ORDER BY 1",
    )
    .bind(channel_id)
    .fetch_all(su)
    .await
    .expect("read broadcast stats")
    .into_iter()
    .map(|row| {
        (
            row.get::<Option<String>, _>("type").unwrap_or_default(),
            row.get::<i64, _>("n"),
            row.get::<i64, _>("bytes"),
        )
    })
    .collect()
}

fn count_of(stats: &[(String, i64, i64)], kind: &str) -> i64 {
    stats
        .iter()
        .find(|(name, _, _)| name == kind)
        .map(|(_, n, _)| *n)
        .unwrap_or(0)
}

fn bytes_of(stats: &[(String, i64, i64)], kind: &str) -> i64 {
    stats
        .iter()
        .find(|(name, _, _)| name == kind)
        .map(|(_, _, bytes)| *bytes)
        .unwrap_or(0)
}

async fn stream_props(su: &PgPool, message_id: Uuid) -> Value {
    let props: Value = sqlx::query_scalar("SELECT props FROM message WHERE id = $1")
        .bind(message_id)
        .fetch_one(su)
        .await
        .expect("read props");
    props
        .get(momo_messaging::STREAM_PROPS_KEY)
        .cloned()
        .unwrap_or(Value::Null)
}

/// **The flip, end to end.** One turn, one message, and that message *grows*.
///
/// The assertion that names the batch is `messages.len() == 1` next to
/// `message.edited > 1`: the answer reached the channel in several writes and is
/// still a single row with a single `seq`. Give the pump a `client_msg_id` other
/// than the run id — the obvious way to write this flip — and the count goes to
/// two: the growing answer, and the commit's own copy underneath it.
///
/// The rest pins what must NOT have changed while the message learned to grow:
/// the props a client reads, the quoted trigger, the ledger, the terminal run.
/// Those all used to ride the commit's `send`, which on a streamed turn is now
/// always a dedupe and writes nothing at all — so every one of them had to move
/// to the opening slice, and every one of them is a silent loss if it did not.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a throwaway pgvector/pg18 database"]
async fn a_streaming_turn_grows_one_message_and_the_commit_finishes_it() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let tenant = seed_tenant(&su).await;

    let (run_id, trigger_message_id, job_id) =
        enqueue_mention_turn(&su, &tenant, tenant.agent_id, "@hermes 길게 대답해줘").await;

    // Four slices, a window and a bit apart, so the pump coalesces into four
    // separate durable writes rather than one. The window is the shipped
    // constant — a test that shortened it would prove the pump against a
    // configuration production never runs.
    let provider = Arc::new(MockChatProvider::echo().streaming(4, Duration::from_millis(900)));
    let worker = build_worker(provider.clone(), base_config()).await;
    let stats = worker.drain_once().await.expect("drain");
    assert_eq!(stats.answered, 1, "the turn produced an answer");

    let messages = agent_messages(&su, &tenant, tenant.agent_id).await;
    assert_eq!(
        messages.len(),
        1,
        "one turn is one message however many writes it took — a second row here \
         is the commit posting its own copy beside the one the reader watched arrive"
    );
    let (message_id, seq, body, props) = messages.into_iter().next().unwrap();
    assert!(seq > 0, "the answer is recoverable by cursor");
    assert_eq!(
        body, "mock: [성재] @hermes 길게 대답해줘",
        "the body that stands is the answer the provider finally returned"
    );

    // The self-description that used to ride the commit's `send`.
    assert_eq!(props["run_id"], json!(run_id));
    assert_eq!(
        props["source"],
        json!("agent_worker.final_text.v0"),
        "a client cannot tell a streamed answer from any other one, and must not \
         have to — the props are the same props"
    );
    assert_eq!(props["trigger_message_id"], json!(trigger_message_id));
    let quoted: Option<Uuid> = sqlx::query_scalar("SELECT reply_to_id FROM message WHERE id = $1")
        .bind(message_id)
        .fetch_one(&su)
        .await
        .expect("read reply_to_id");
    assert_eq!(
        quoted,
        Some(trigger_message_id),
        "ADR-0148 규칙 6 survives the flip — and it had to be read from the RUN row \
         at turn start, because the opening slice happens long before the commit \
         locks anything"
    );

    // The stream block: closed, un-marked, and grown by more than one write.
    let stream = stream_props(&su, message_id).await;
    assert_eq!(
        stream["streaming"],
        json!(false),
        "the commit transaction closed it — a `succeeded` run with a message still \
         streaming is the one state ADR-0155 asks clients to render defensively, \
         and the ordinary path must never produce it"
    );
    assert!(
        stream.get("outcome").is_none(),
        "a turn that finished carries no outcome; `final: true` alone says so: {stream}"
    );
    let rev = stream["rev"].as_i64().expect("a revision");
    assert!(
        rev >= 3,
        "four coalescing windows plus the close should have spent several \
         revisions, not one: {rev}"
    );

    // No 수정됨 badge. An answer arriving is not a revision of itself.
    let (state, edited_at): (String, Option<chrono::DateTime<chrono::Utc>>) =
        sqlx::query_as("SELECT state::text, edited_at FROM message WHERE id = $1")
            .bind(message_id)
            .fetch_one(&su)
            .await
            .expect("read state");
    assert_eq!(
        state, "sent",
        "the state a message is born in — streaming must never move it to `edited`"
    );
    assert!(
        edited_at.is_none(),
        "streaming must not stamp the edit badge every message an agent writes"
    );

    // The run and the ledger, unchanged by the flip.
    assert_eq!(run_status(&su, run_id).await, "succeeded");
    let ledger: i64 = sqlx::query_scalar("SELECT count(*) FROM usage_ledger WHERE run_id = $1")
        .bind(run_id)
        .fetch_one(&su)
        .await
        .expect("count ledger");
    assert_eq!(ledger, 1, "exactly one immutable ledger row per run");

    // The arithmetic, printed so the PR can quote it rather than assert a
    // number that will move the next time a provider is faster.
    let stats = broadcast_stats(&su, tenant.channel_id).await;
    println!("--- #1161 window arithmetic for one streamed turn ---");
    for (kind, n, bytes) in &stats {
        println!("  {kind:<16} count={n:<4} bytes={bytes}");
    }
    assert_eq!(
        count_of(&stats, "message.new"),
        2,
        "the human's utterance and the agent's answer — the growing answer opens \
         exactly one message"
    );
    assert!(
        count_of(&stats, "message.edited") > 1,
        "the answer grew: {stats:?}"
    );
    assert!(
        count_of(&stats, "agent.partial") > 0,
        "the rail hint rides the same window and did not retire: {stats:?}"
    );
    // Decision ① in one measured line. Both halves ride ONE window, so their
    // counts track each other; what differs is size, because the durable slice
    // restates the whole answer while the hint carries only its window's delta.
    // Retiring the hint would save the cheaper of the two and blind every rail
    // surface. Printed rather than asserted against a threshold: the ratio grows
    // with the answer, and pinning today's number would go red on a longer
    // fixture for no reason at all.
    println!(
        "  durable/hint bytes = {} / {} (counts {} / {})",
        bytes_of(&stats, "message.edited"),
        bytes_of(&stats, "agent.partial"),
        count_of(&stats, "message.edited"),
        count_of(&stats, "agent.partial"),
    );

    // Re-draining changes nothing: no second answer, no second charge.
    let again = worker.drain_once().await.expect("second drain");
    assert_eq!(again.claimed, 0, "a settled job is not re-claimable");
    assert_eq!(agent_messages(&su, &tenant, tenant.agent_id).await.len(), 1);
    let (status, _, _) = job_row(&su, job_id).await;
    assert_eq!(status, "done");
}

/// **RED proof — 취소 시 이중 메시지 부재.** The human presses stop *while* the
/// answer is arriving, which is the case that only exists after the flip.
///
/// Two ways to get this wrong, and both are silent:
///
/// * revive the suppressed commit into a `send` — the channel then holds the
///   answer the human cancelled, written over the text they stopped;
/// * give the growing message any key but the run id — the commit no longer
///   dedupes, and the cancelled turn leaves **two** messages, one frozen and one
///   complete, saying different things about the same run.
///
/// `messages.len() == 1` plus `outcome: "cancelled"` is what closes both.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a throwaway pgvector/pg18 database"]
async fn a_cancel_during_a_streaming_turn_leaves_exactly_one_frozen_message() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let tenant = seed_tenant(&su).await;

    let (run_id, _trigger_message_id, _job_id) =
        enqueue_mention_turn(&su, &tenant, tenant.agent_id, "@hermes 아주 긴 답을 줘").await;

    let provider = Arc::new(MockChatProvider::echo().streaming(6, Duration::from_millis(400)));
    let worker = Arc::new(build_worker(provider.clone(), base_config()).await);
    let driving = tokio::spawn({
        let worker = Arc::clone(&worker);
        async move { worker.drain_once().await }
    });

    // Two windows in: the message is open in the channel and text is on screen.
    tokio::time::sleep(Duration::from_millis(1_600)).await;
    let open: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM message WHERE run_id = $1 AND props -> $2 ->> 'streaming' = 'true'",
    )
    .bind(run_id)
    .bind(momo_messaging::STREAM_PROPS_KEY)
    .fetch_one(&su)
    .await
    .expect("count open streams");
    assert_eq!(
        open, 1,
        "the premise of this test: by now the reader has half an answer in front \
         of them. Without the flip there is nothing here to cancel"
    );

    // The human presses stop.
    let workspace_id = tenant.workspace_id;
    let worker_pool = momo_worker_pool().await;
    let cancelled = with_tenant_tx(&worker_pool, workspace_id, move |conn| {
        Box::pin(async move {
            momo_agent::cancel_run_in_tx(
                conn,
                workspace_id,
                run_id,
                &json!({"code": "cancelled", "reason": "사람이 정지를 눌렀다"}),
            )
            .await
        })
    })
    .await
    .expect("the cancel statement ran");
    assert!(cancelled, "the run was cancellable mid-answer");

    let stats = driving.await.expect("join").expect("drain");
    assert_eq!(
        stats.answered, 0,
        "the answer the human cancelled is never posted"
    );
    assert_eq!(stats.skipped, 1, "the job settles done without an answer");

    let messages = agent_messages(&su, &tenant, tenant.agent_id).await;
    assert_eq!(
        messages.len(),
        1,
        "THE assertion: a cancelled streaming turn adds no second message — the \
         one it was growing is all there is"
    );
    let (message_id, _seq, body, _props) = messages.into_iter().next().unwrap();
    assert!(
        !body.is_empty(),
        "the text the human was reading when they pressed stop is still there"
    );
    let stream = stream_props(&su, message_id).await;
    assert_eq!(
        stream["outcome"],
        json!("cancelled"),
        "freeze AND mark (ADR-0155) — an unmarked half sentence wears a finished \
         answer's clothes: {stream}"
    );
    assert_eq!(stream["streaming"], json!(false));
    assert_eq!(
        run_status(&su, run_id).await,
        "cancelled",
        "the cancel is not revived by the turn arriving late"
    );
    let ledger: i64 = sqlx::query_scalar("SELECT count(*) FROM usage_ledger WHERE run_id = $1")
        .bind(run_id)
        .fetch_one(&su)
        .await
        .expect("count ledger");
    assert_eq!(ledger, 0, "a suppressed commit bills nothing");
}

/// **The third ending.** The provider dies with half an answer already in the
/// channel.
///
/// The interesting half is what does *not* happen: the Korean degraded notice
/// this path writes on a non-streamed turn never appears. It has nowhere to go —
/// the `client_msg_id` join makes it the same message — and writing it would
/// overwrite the very text that tells the reader something arrived before it
/// stopped. ADR-0155's answer is freeze and mark, and `outcome: "failed"` is the
/// mark. Restore the overwrite and this goes red on the body.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a throwaway pgvector/pg18 database"]
async fn a_provider_death_mid_answer_freezes_what_the_reader_already_read() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let tenant = seed_tenant(&su).await;

    let (run_id, _trigger_message_id, job_id) =
        enqueue_mention_turn(&su, &tenant, tenant.agent_id, "@hermes 답하다 죽어봐").await;

    // A 4xx: an answer about this request, not an outage, so the turn is
    // terminal on the first attempt rather than requeued.
    let provider = Arc::new(
        MockChatProvider::failing(ProviderError::HttpStatus(
            400,
            "model refused the request".to_string(),
        ))
        .streaming_text("생각해 보면 그건", 2, Duration::from_millis(900)),
    );
    let worker = build_worker(provider.clone(), base_config()).await;
    let stats = worker.drain_once().await.expect("drain");
    assert_eq!(stats.failed, 1, "a 4xx stops rather than retrying");

    let messages = agent_messages(&su, &tenant, tenant.agent_id).await;
    assert_eq!(
        messages.len(),
        1,
        "the half answer and the failure are one message, not a notice posted \
         under an orphan"
    );
    let (message_id, _seq, body, props) = messages.into_iter().next().unwrap();
    assert_eq!(
        body, "생각해 보면 그건",
        "frozen exactly where the provider stopped — the degraded notice must not \
         overwrite the evidence that anything arrived at all"
    );
    assert_eq!(
        props["source"],
        json!("agent_worker.final_text.v0"),
        "it is still the answer, half of one; the failure is recorded on the run \
         and in the stream outcome, not by relabelling the message"
    );
    let stream = stream_props(&su, message_id).await;
    assert_eq!(
        stream["outcome"],
        json!("failed"),
        "「응답이 끊김」, not 「중단됨」 — nobody pressed stop: {stream}"
    );
    assert_eq!(stream["streaming"], json!(false));

    assert_eq!(run_status(&su, run_id).await, "failed");
    assert_eq!(
        run_error(&su, run_id).await["code"],
        json!("provider_failed")
    );
    let (status, _, _) = job_row(&su, job_id).await;
    assert_eq!(status, "failed");
}

/// HAP-E3 production exclusion is enforced by the actual worker consumer and
/// the actual A2A producer, not merely by matching copies of their predicates.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a throwaway pgvector/pg18 database"]
async fn hosted_identities_never_enter_worker_claim_or_a2a_delivery() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let tenant = seed_tenant(&su).await;
    let (source_run_id, _, source_job_id) =
        enqueue_mention_turn(&su, &tenant, tenant.agent_id, "source run").await;
    sqlx::query("UPDATE outbox SET status='done',processed_at=now() WHERE id=$1")
        .bind(source_job_id)
        .execute(&su)
        .await
        .expect("retire source fixture job");

    for status in ["pairing_pending", "detected", "expired", "active"] {
        let initial_status = if status == "active" {
            "detected"
        } else {
            status
        };
        let hosted_id = seed_second_agent(&su, &tenant).await;
        let connection_id = Uuid::new_v4();
        sqlx::query(
            "UPDATE agent SET model='hosted-agent', \
               base_url='https://hosted-agent.invalid/disabled', \
               config=jsonb_build_object('execution_mode','hosted_dial_in') \
             WHERE workspace_id=$1 AND member_id=$2",
        )
        .bind(tenant.workspace_id)
        .bind(hosted_id)
        .execute(&su)
        .await
        .expect("seal hosted sentinel");
        sqlx::query(
            "INSERT INTO hosted_agent_connection( \
               id,workspace_id,agent_member_id,status,pairing_challenge_hash,pairing_expires_at, \
               pairing_consumed_at,detected_at,detected_by,confirmed_by,confirmed_at, \
               approved_scopes,created_by \
             ) VALUES ($1,$2,$3,$4,digest($5,'sha256'), \
               CASE WHEN $4='expired' THEN now()-interval '1 second' ELSE now()+interval '1 hour' END, \
               CASE WHEN $4 IN ('detected','active') THEN now() END, \
               CASE WHEN $4 IN ('detected','active') THEN now() END, \
               CASE WHEN $4 IN ('detected','active') THEN $3 END, \
               CASE WHEN $4='active' THEN $6 END, CASE WHEN $4='active' THEN now() END, \
               CASE WHEN $4='active' THEN ARRAY['agent:port:connect']::text[] ELSE '{}'::text[] END,$6)",
        )
        .bind(connection_id)
        .bind(tenant.workspace_id)
        .bind(hosted_id)
        .bind(initial_status)
        .bind(format!("hosted-{status}"))
        .bind(tenant.human_id)
        .execute(&su)
        .await
        .expect("seed hosted lifecycle row");
        if status == "active" {
            let token_id = Uuid::new_v4();
            sqlx::query(
                "WITH inserted AS (INSERT INTO token(id,workspace_id,actor_member_id,kind,token_hash,scopes,label, \
                  credential_class,hosted_connection_id,audience,created_by) \
                 VALUES ($1,$2,$3,'agent_bearer',digest('hosted-active','sha256'), \
                  ARRAY['agent:port:connect'],'hosted test','hosted_active',$4, \
                  '/v1/mcp/agent-port',$5) RETURNING id), \
                 updated AS (UPDATE hosted_agent_connection SET status='active', \
                  active_token_id=(SELECT id FROM inserted),confirmed_by=$5,confirmed_at=now(), \
                  approved_scopes=ARRAY['agent:port:connect'],proved_at=now(),proved_by=$3 \
                  WHERE workspace_id=$2 AND id=$4 RETURNING id), \
                 profiled AS (INSERT INTO agent_profile(workspace_id,agent_member_id,paused,updated_by) \
                  SELECT $2,$3,false,$5 FROM updated RETURNING agent_member_id) \
                 SELECT count(*) FROM profiled",
            )
            .bind(token_id)
            .bind(tenant.workspace_id)
            .bind(hosted_id)
            .bind(connection_id)
            .bind(tenant.human_id)
            .execute(&su)
            .await
            .expect("activate hosted fixture");
        }

        let hosted_job_id: i64 = sqlx::query_scalar(
            "INSERT INTO outbox(workspace_id,kind,status,method,payload,partition_key) \
             VALUES ($1,'agent_job','pending','publish',jsonb_build_object('agent_member_id',$2),$2) \
             RETURNING id",
        )
        .bind(tenant.workspace_id)
        .bind(hosted_id)
        .fetch_one(&su)
        .await
        .expect("seed hosted worker job");
        let claimed = momo_outbox::claim_agent_job_batch(
            &momo_worker_pool().await,
            100,
            DEFAULT_WORKER_LEASE_SECONDS,
        )
        .await
        .expect("invoke actual worker claim");
        assert!(
            claimed.iter().all(|job| job.id != hosted_job_id),
            "{status}: actual worker claim admitted hosted job"
        );
        let claim_state: (String, i32, bool) = sqlx::query_as(
            "SELECT status::text,attempts,lease_owner IS NULL FROM outbox WHERE id=$1",
        )
        .bind(hosted_job_id)
        .fetch_one(&su)
        .await
        .expect("read hosted claim state");
        assert_eq!(claim_state, ("pending".into(), 0, true));

        let body = format!("@{} do not delegate", hosted_id);
        let workspace_id = tenant.workspace_id;
        let channel_id = tenant.channel_id;
        let author_id = tenant.agent_id;
        let (run_before, jobs_before, messages_before): (i64, i64, i64) = sqlx::query_as(
            "SELECT (SELECT count(*) FROM agent_run WHERE workspace_id=$1 AND agent_member_id=$2), \
                    (SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='agent_job'), \
                    (SELECT count(*) FROM message WHERE workspace_id=$1)",
        )
        .bind(workspace_id)
        .bind(hosted_id)
        .fetch_one(&su)
        .await
        .expect("read A2A baseline");
        let routing = with_tenant_tx(&su, workspace_id, move |conn| {
            Box::pin(async move {
                let reply = send_message_in_tx(
                    conn,
                    workspace_id,
                    NewMessage::text(channel_id, author_id, body.clone()),
                )
                .await?;
                route_a2a_mentions_in_tx(
                    conn,
                    A2aSend {
                        workspace_id,
                        channel_id,
                        message_id: reply.message.id,
                        message_seq: reply.message.seq,
                        author_agent_member_id: author_id,
                        source_run_id,
                        body: &body,
                        hlc_ts: reply.message.hlc_ts,
                        gateway_enabled: false,
                        context_max_messages: 20,
                        limits: A2aLimits::default(),
                    },
                )
                .await
            })
        })
        .await
        .expect("invoke actual A2A producer");
        assert!(
            routing.delegated.is_empty(),
            "{status}: A2A delegated hosted identity"
        );
        let after: (i64, i64, i64) = sqlx::query_as(
            "SELECT (SELECT count(*) FROM agent_run WHERE workspace_id=$1 AND agent_member_id=$2), \
                    (SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='agent_job'), \
                    (SELECT count(*) FROM message WHERE workspace_id=$1)",
        )
        .bind(workspace_id)
        .bind(hosted_id)
        .fetch_one(&su)
        .await
        .expect("read A2A result");
        assert_eq!(after.0, run_before, "{status}: A2A inserted hosted run");
        assert_eq!(
            after.1, jobs_before,
            "{status}: A2A inserted hosted job/outbox"
        );
        assert_eq!(
            after.2,
            messages_before + 1,
            "{status}: only source reply may persist"
        );
        sqlx::query("UPDATE outbox SET status='done',processed_at=now() WHERE id=$1")
            .bind(hosted_job_id)
            .execute(&su)
            .await
            .expect("retire hosted fixture job");
    }
}

// ---------------------------------------------------------------------------
// UXC-A (#1454) — the completion report producer, end to end
// ---------------------------------------------------------------------------

/// The model's turn: prose for the reader, then the report fence.
const REPORTED_TURN: &str = "환경 셋업을 마쳤습니다.\n\n```oort:report\n\
{\"title\":\"oort 환경 셋업 완료\",\
 \"summary\":\"Rust 서버·TS 코어·웹/폰이 한 트리에 있고, 게이트를 전부 초록으로 맞췄습니다.\",\
 \"elapsed_ms\":999,\
 \"actions\":[{\"text\":\"Rust 툴체인을 1.83에서 1.97로 올림\",\"note\":\"edition2024 때문\"},\
              {\"text\":\"compose 기동 후 헬스체크 확인\"}],\
 \"gates\":[{\"surface\":\"웹\",\"checks\":[{\"label\":\"테스트\",\"outcome\":\"pass\",\"detail\":\"896 통과\"}]},\
            {\"surface\":\"엔진\",\"checks\":[{\"label\":\"빌드\",\"outcome\":\"pass\"},\
                                             {\"label\":\"소크\",\"outcome\":\"skip\"}]}]}\n```";

/// Every assertion this pair makes about the card's own keys, in one place —
/// so the streaming and non-streaming halves are held to the *same* envelope
/// rather than to two lists that can drift apart.
fn assert_card_envelope(props: &Value, run_id: Uuid, trigger_message_id: Uuid) {
    // The turn still says everything it always said. The card is an addition to
    // this envelope, not a replacement for it — a props object that lost
    // `source` would take the attribution of every reply with it.
    assert_eq!(props["run_id"], json!(run_id));
    assert_eq!(props["source"], json!("agent_worker.final_text.v0"));
    assert_eq!(props["trigger_message_id"], json!(trigger_message_id));

    assert_eq!(
        props["kind"],
        json!("completion_report"),
        "the one key that decides whether a card is drawn at all"
    );
    assert_eq!(props["title"], json!("oort 환경 셋업 완료"));
    assert_eq!(
        props["summary"],
        json!("Rust 서버·TS 코어·웹/폰이 한 트리에 있고, 게이트를 전부 초록으로 맞췄습니다.")
    );
    assert_eq!(
        props["actions"],
        json!([
            {"text": "Rust 툴체인을 1.83에서 1.97로 올림", "note": "edition2024 때문"},
            {"text": "compose 기동 후 헬스체크 확인"}
        ])
    );
    // `skip` reaches the card as `skip`. A producer that folded it into `fail`
    // would paint an un-run gate red, which is exactly the false narrative
    // ADR-0132 exists to stop.
    assert_eq!(
        props["gates"],
        json!([
            {"surface": "웹", "checks": [{"label": "테스트", "outcome": "pass", "detail": "896 통과"}]},
            {"surface": "엔진", "checks": [
                {"label": "빌드", "outcome": "pass"},
                {"label": "소크", "outcome": "skip"}
            ]}
        ])
    );

    // The model claimed 999ms. What ships is the server's measurement against
    // `agent_run.started_at`, which is a real duration and therefore not 999.
    let elapsed = props["elapsed_ms"]
        .as_i64()
        .expect("a run that started has a measured elapsed");
    assert!(
        elapsed >= 0 && elapsed != 999,
        "elapsed_ms must be the server's clock, not the model's claim (got {elapsed})"
    );
}

/// **UXC-A 1 — a report is an ordinary turn message that happens to carry a card.**
///
/// No new `message_type`, no new ledger, no migration: the same single write path
/// (`REST send → message + outbox → relay`) every other agent answer takes, with
/// six more keys on the props it was already writing. This is the whole design,
/// and it is what makes the card survive a reload, a new device, and a teammate
/// scrolling back a week later.
///
/// Goes red if the producer stops cutting the fence out of the body (raw JSON in
/// the channel), stops emitting the card, invents an `elapsed_ms` from the
/// model's own claim, or routes the reply around the message spine so the
/// broadcast no longer carries the props the relay must publish.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a throwaway pgvector/pg18 database"]
async fn uxc_a_1_a_completion_report_rides_the_ordinary_turn_message() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let tenant = seed_tenant(&su).await;

    let (run_id, trigger_message_id, _job_id) =
        enqueue_mention_turn(&su, &tenant, tenant.agent_id, "@hermes 환경 만들어줘").await;

    let provider = Arc::new(MockChatProvider::scripted([(
        "환경 만들어줘",
        REPORTED_TURN,
    )]));
    let worker = build_worker(provider.clone(), base_config()).await;
    let stats = worker.drain_once().await.expect("drain");
    assert_eq!(stats.answered, 1, "the turn produced an answer");

    let messages = agent_messages(&su, &tenant, tenant.agent_id).await;
    assert_eq!(
        messages.len(),
        1,
        "a report is one turn message — not a second card row beside the answer"
    );
    let (message_id, seq, body, props) = messages.into_iter().next().unwrap();
    assert!(
        seq > 0,
        "it took a real channel_seq like every other message"
    );

    // 1. The fence is gone from the body. The reader gets prose; the card gets
    //    the structure. Leaving the block in would put raw JSON in the channel.
    assert_eq!(body, "환경 셋업을 마쳤습니다.");
    assert!(
        !body.contains("oort:report") && !body.contains("\"gates\""),
        "the envelope must never be shown as text: {body}"
    );

    // 2. The card, key for key.
    assert_card_envelope(&props, run_id, trigger_message_id);

    // 3. schema_v0 is untouched: this is a plain `text` message, exactly as the
    //    core's fixture says it must be. A new `message_type` would need a
    //    migration, and this goal's contract is that there is none.
    let message_type: String = sqlx::query_scalar("SELECT type::text FROM message WHERE id = $1")
        .bind(message_id)
        .fetch_one(&su)
        .await
        .expect("read message type");
    assert_eq!(message_type, "text");

    // 4. **REST ↔ outbox agree.** The relay publishes what is in the outbox row,
    //    so a card that exists only in the `message` table is a card nobody sees
    //    until they reload.
    let broadcast: Value = sqlx::query_scalar(
        "SELECT payload FROM outbox \
          WHERE workspace_id = $1 AND kind = 'broadcast' \
            AND payload->'data'->'payload'->>'id' = $2::text \
          ORDER BY id DESC LIMIT 1",
    )
    .bind(tenant.workspace_id)
    .bind(message_id.to_string())
    .fetch_one(&su)
    .await
    .expect("read the broadcast the relay will publish");
    let published = &broadcast["data"]["payload"];
    assert_eq!(published["body"], json!("환경 셋업을 마쳤습니다."));
    assert_card_envelope(&published["props"], run_id, trigger_message_id);
}

/// **UXC-A 2 — the same card on a turn the reader watched arrive.**
///
/// This is the half that could quietly not work. On a streamed turn the commit's
/// `send` is a dedupe (stream rule 4): the opening slice wrote this turn's props
/// long before the model had written a word of the report, and a deduped send
/// updates nothing. So the card lands by props patch, written *before* the
/// closing slice so that slice's `message.edited` frame carries it.
///
/// Goes red if the patch is dropped (card missing on every streamed answer — i.e.
/// on every real one), if it is moved after the closing slice (the row moves with
/// no frame to say so, and the timeline keeps rendering the props it was handed),
/// or if the streaming cut stops matching the committed body (the reader watches
/// raw JSON type itself out and then vanish).
#[tokio::test]
#[ignore = "requires DATABASE_URL to a throwaway pgvector/pg18 database"]
async fn uxc_a_2_a_streamed_report_lands_on_the_message_the_reader_watched() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let tenant = seed_tenant(&su).await;

    let (run_id, trigger_message_id, _job_id) =
        enqueue_mention_turn(&su, &tenant, tenant.agent_id, "@hermes 환경 만들어줘").await;

    let provider = Arc::new(
        MockChatProvider::scripted([("환경 만들어줘", REPORTED_TURN)])
            .streaming(6, Duration::from_millis(900)),
    );
    let worker = build_worker(provider.clone(), base_config()).await;
    let stats = worker.drain_once().await.expect("drain");
    assert_eq!(stats.answered, 1, "the streamed turn produced an answer");

    let messages = agent_messages(&su, &tenant, tenant.agent_id).await;
    assert_eq!(
        messages.len(),
        1,
        "one turn is one message however many writes it took"
    );
    let (message_id, _seq, body, props) = messages.into_iter().next().unwrap();
    assert_eq!(body, "환경 셋업을 마쳤습니다.");
    assert_card_envelope(&props, run_id, trigger_message_id);

    // The stream is closed under a terminal run (ADR-0155) — the card did not
    // cost the turn its close.
    assert_eq!(
        props[momo_messaging::STREAM_PROPS_KEY]["streaming"],
        json!(false),
        "the closing slice still runs in the commit transaction"
    );
    assert_eq!(run_status(&su, run_id).await, "succeeded");

    // Every durable slice this turn wrote — the whole of what a reader could
    // have had on screen — and not one of them showed the envelope.
    let published: Vec<Value> = sqlx::query_scalar(
        "SELECT payload FROM outbox \
          WHERE workspace_id = $1 AND kind = 'broadcast' \
            AND payload->'data'->'payload'->>'id' = $2::text \
          ORDER BY id",
    )
    .bind(tenant.workspace_id)
    .bind(message_id.to_string())
    .fetch_all(&su)
    .await
    .expect("read the frames the relay will publish");
    assert!(
        published.len() > 1,
        "the premise of this test: the answer arrived in slices, not in one write"
    );
    for frame in &published {
        let shown = frame["data"]["payload"]["body"]
            .as_str()
            .unwrap_or_default();
        assert!(
            !shown.contains("oort:report") && !shown.contains("\"gates\""),
            "a frame typed the report envelope out to the reader: {shown}"
        );
    }

    // The LAST frame — the closing slice — is the one every client applies in
    // place, and it is where the card has to be.
    let last = published.last().expect("at least one frame");
    assert_card_envelope(
        &last["data"]["payload"]["props"],
        run_id,
        trigger_message_id,
    );
}
