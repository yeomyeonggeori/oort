//! DB-backed conformance for A2A delegation (B7.2).
//!
//! The orchestrator's docker-gate red tests. Each proves one invariant with a
//! named assertion that goes red when the enforcement is reverted. They are
//! `#[ignore]` because they need a throwaway `pgvector/pgvector:pg18` superuser
//! DB plus the runtime roles:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-agent-worker --test a2a_conformance_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Harness contract is `agent_worker_conformance_pg.rs`'s, including the
//! [`settle_residual_worker_jobs`] sweep every test opens with — the worker's
//! claim is a **global** consumer claim (`kind='agent_job' AND
//! method='publish'`, no workspace predicate), so an earlier binary's leftover
//! row would otherwise land in this suite's batch.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `b72_1_an_agent_can_hand_the_work_to_another_agent` | drop `route_a2a_mentions_in_tx` from `commit_turn`, or restore B5.2's `a2a_source_run_unavailable` refusal on the worker path |
//! | `b72_2_a_mutual_mention_loop_stops_at_a_cap_instead_of_running_forever` | remove any cap from `evaluate_a2a_spawn` — the chain then grows once per drain, forever |
//! | `b72_3_a_chain_that_spends_its_budget_is_stopped_and_says_so` | drop the `chain_usage_in_tx` term, or evaluate it before `record_run_usage_in_tx` (the chain then never sees its own last turn) |
//! | `b72_4_a_delegated_run_records_the_parent_and_the_depth_it_inherited` | pass `parent_run_id: None` / `depth: 0` at child creation — the hop cap becomes unenforceable, exactly the B5.2 failure this batch exists to fix |

use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use momo_agent::{create_agent_run_in_tx, A2aLimits, NewAgentRun, RunTrigger};
use momo_agent_worker::provider::{ChatProvider, MockChatProvider};
use momo_agent_worker::{AgentWorker, DrainStats, WorkerConfig};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::{with_tenant_tx, PgPool};
use momo_messaging::{send_message_in_tx, NewMessage};
use momo_outbox::{emit_outbox, OutboxKind};
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

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations on a fresh pgvector/pg18 DB");
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
    *ready = true;
}

/// Retire every worker job this suite did not enqueue — see the module docs.
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
// fixtures
// ---------------------------------------------------------------------------

const AGENT_MODEL: &str = "hermes-agent";
const HUMAN_DISPLAY: &str = "성재";
/// The two agents the whole suite talks about. The handles are what
/// `contains_mention` matches on, so they are the API of every scripted answer.
const ALPHA: &str = "hermes";
const BETA: &str = "atlas";

struct Tenant {
    workspace_id: Uuid,
    human_id: Uuid,
    channel_id: Uuid,
    alpha_id: Uuid,
    beta_id: Uuid,
}

async fn seed_tenant(su: &PgPool) -> Tenant {
    let workspace_id = Uuid::new_v4();
    let human_id = Uuid::new_v4();
    let alpha_id = Uuid::new_v4();
    let beta_id = Uuid::new_v4();
    let channel_id = Uuid::new_v4();

    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace_id)
        .bind(workspace_id.to_string())
        .execute(su)
        .await
        .expect("seed workspace");

    for (id, kind, display, handle) in [
        (human_id, "human", HUMAN_DISPLAY, human_id.to_string()),
        (alpha_id, "agent", ALPHA, ALPHA.to_string()),
        (beta_id, "agent", BETA, BETA.to_string()),
    ] {
        sqlx::query(
            "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
             VALUES ($1, $2, $3::member_kind, $4, $5)",
        )
        .bind(id)
        .bind(workspace_id)
        .bind(kind)
        .bind(display)
        .bind(handle)
        .execute(su)
        .await
        .expect("seed member");
    }
    for agent_id in [alpha_id, beta_id] {
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
    }

    sqlx::query("INSERT INTO channel (id, workspace_id, kind, name) VALUES ($1, $2, 'public', $3)")
        .bind(channel_id)
        .bind(workspace_id)
        .bind(format!("b72-{}", &channel_id.simple().to_string()[..8]))
        .execute(su)
        .await
        .expect("seed channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel_id)
        .bind(workspace_id)
        .execute(su)
        .await
        .expect("seed channel_seq");

    for member_id in [human_id, alpha_id, beta_id] {
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
        channel_id,
        alpha_id,
        beta_id,
    }
}

/// The human's opening mention, produced exactly as
/// `routes::agent_mentions::route_agent_mentions_in_tx` produces it: the
/// message, a `depth = 0` run keyed on it, and the `method='publish'` job.
///
/// The `parent_run_id: None` / `depth: 0` here is what makes this the **root**
/// of the chain every later assertion walks.
async fn enqueue_human_mention(
    pool: &PgPool,
    tenant: &Tenant,
    agent_id: Uuid,
    body: &str,
) -> (Uuid, Uuid) {
    let workspace_id = tenant.workspace_id;
    let channel_id = tenant.channel_id;
    let human_id = tenant.human_id;
    let body = body.to_string();

    with_tenant_tx(pool, workspace_id, move |conn| {
        Box::pin(async move {
            let trigger = send_message_in_tx(
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
                        message_id: trigger.message.id,
                        agent_member_id: agent_id,
                    },
                    parent_run_id: None,
                    max_steps: 50,
                    depth: 0,
                    input: json!({
                        "schema": "momo.agent_run.input.v0",
                        "surface": "mention",
                        "prompt": body,
                        "depth": 0,
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
                "trigger_message_id": trigger.message.id,
                "trigger_message_seq": trigger.message.seq,
                "model": AGENT_MODEL,
                "prompt": body,
                "recent_messages": [{
                    "message_id": trigger.message.id,
                    "channel_id": channel_id,
                    "seq": trigger.message.seq,
                    "author_member_id": human_id,
                    "author_kind": "human",
                    "author_display": HUMAN_DISPLAY,
                    "type": "text",
                    "body": body,
                }],
                "max_output_tokens": 512,
                "depth": 0,
                "delivery": "worker",
                "created_from": "server.message_send.agent_mention.v0",
            });
            emit_outbox(
                &mut *conn,
                workspace_id,
                OutboxKind::AgentJob,
                "publish",
                &payload,
                Some(agent_id),
            )
            .await
            .map_err(momo_db::DbError::from)?;

            Ok((created.id, trigger.message.id))
        })
    })
    .await
    .expect("enqueue the human's opening mention")
}

async fn build_worker(provider: Arc<dyn ChatProvider>, config: WorkerConfig) -> AgentWorker {
    AgentWorker::new(momo_worker_pool().await, provider, config)
}

fn base_config() -> WorkerConfig {
    let mut config = WorkerConfig::for_target(database_url());
    config.claim_batch_size = 10;
    config
}

/// Drain until nothing is claimable, but **never more than `max_rounds`**.
///
/// A bounded loop rather than [`AgentWorker::drain_to_empty`] on purpose: with a
/// cap removed the chain is infinite, and a hang is a useless red. This turns
/// that revert into a failed assertion on the round budget instead.
async fn drain_bounded(worker: &AgentWorker, max_rounds: usize) -> (DrainStats, usize) {
    let mut total = DrainStats::default();
    for round in 1..=max_rounds {
        let stats = worker.drain_once().await.expect("drain");
        total.claimed += stats.claimed;
        total.answered += stats.answered;
        total.requeued += stats.requeued;
        total.failed += stats.failed;
        total.skipped += stats.skipped;
        total.delegated += stats.delegated;
        total.a2a_blocked += stats.a2a_blocked;
        if stats.claimed == 0 {
            return (total, round);
        }
    }
    (total, max_rounds)
}

// ---------------------------------------------------------------------------
// readers
// ---------------------------------------------------------------------------

/// Every message in the channel, oldest first: `(author, type, body, props)`.
async fn channel_messages(su: &PgPool, tenant: &Tenant) -> Vec<(Uuid, String, String, Value)> {
    sqlx::query(
        "SELECT author_member_id, type::text AS message_type, COALESCE(body, '') AS body, props \
           FROM message WHERE workspace_id = $1 AND channel_id = $2 ORDER BY seq",
    )
    .bind(tenant.workspace_id)
    .bind(tenant.channel_id)
    .fetch_all(su)
    .await
    .expect("read channel messages")
    .into_iter()
    .map(|row| {
        (
            row.get::<Uuid, _>("author_member_id"),
            row.get::<String, _>("message_type"),
            row.get::<String, _>("body"),
            row.get::<Value, _>("props"),
        )
    })
    .collect()
}

#[derive(Debug, Clone)]
struct RunRow {
    id: Uuid,
    agent_member_id: Uuid,
    parent_run_id: Option<Uuid>,
    depth: i32,
    step_count: i32,
    status: String,
    trigger_message_id: Option<Uuid>,
    input: Value,
}

async fn runs(su: &PgPool, tenant: &Tenant) -> Vec<RunRow> {
    sqlx::query(
        "SELECT id, agent_member_id, parent_run_id, depth, step_count, status::text AS status, \
                trigger_message_id, input \
           FROM agent_run WHERE workspace_id = $1 ORDER BY created_at, id",
    )
    .bind(tenant.workspace_id)
    .fetch_all(su)
    .await
    .expect("read runs")
    .into_iter()
    .map(|row| RunRow {
        id: row.get("id"),
        agent_member_id: row.get("agent_member_id"),
        parent_run_id: row.get("parent_run_id"),
        depth: row.get("depth"),
        step_count: row.get("step_count"),
        status: row.get("status"),
        trigger_message_id: row.get("trigger_message_id"),
        input: row.get("input"),
    })
    .collect()
}

/// Every A2A refusal this workspace audited, as `(reason, detail)`.
async fn a2a_audit_reasons(su: &PgPool, tenant: &Tenant) -> Vec<(String, Value)> {
    sqlx::query(
        "SELECT detail->>'reason' AS reason, detail \
           FROM audit_log \
          WHERE workspace_id = $1 \
            AND action = 'agent.mention.skipped' \
            AND detail->>'reason' LIKE 'a2a\\_%' \
          ORDER BY created_at, id",
    )
    .bind(tenant.workspace_id)
    .fetch_all(su)
    .await
    .expect("read a2a audit rows")
    .into_iter()
    .map(|row| {
        (
            row.get::<Option<String>, _>("reason").unwrap_or_default(),
            row.get::<Value, _>("detail"),
        )
    })
    .collect()
}

// ---------------------------------------------------------------------------
// b72_1 — the delegation happens at all
// ---------------------------------------------------------------------------

/// **The batch in one test.** A human mentions α; α's answer mentions β; β runs
/// and answers in the same channel.
///
/// The assertion that catches the tempting shortcut is `parent_run_id` +
/// `depth`: a child created with `None`/`0` would still produce this
/// conversation, and every cap in the batch would be silently unenforceable —
/// which is exactly why B5.2 refused to create one.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a throwaway pgvector/pg18 database"]
async fn b72_1_an_agent_can_hand_the_work_to_another_agent() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let tenant = seed_tenant(&su).await;

    let (root_run_id, _) =
        enqueue_human_mention(&su, &tenant, tenant.alpha_id, "@hermes 배포 준비 시작").await;

    // α hands off to β; β finishes without mentioning anyone, so the chain ends
    // on its own rather than on a cap — the cap tests are b72_2 and b72_3.
    let provider = Arc::new(MockChatProvider::scripted([
        ("배포 준비 시작", "@atlas 릴리스 노트 확인 부탁해"),
        ("릴리스 노트 확인 부탁해", "릴리스 노트 확인 완료했습니다."),
    ]));
    let worker = build_worker(provider.clone(), base_config()).await;
    let (stats, rounds) = drain_bounded(&worker, 6).await;

    assert_eq!(stats.answered, 2, "α answered and β answered: {stats:?}");
    assert_eq!(stats.delegated, 1, "exactly one delegation: {stats:?}");
    assert_eq!(stats.a2a_blocked, 0, "nothing was capped: {stats:?}");
    assert!(rounds <= 4, "the chain terminated on its own in {rounds}");

    // 1. Two runs: the human's root and β's delegated child.
    let runs = runs(&su, &tenant).await;
    assert_eq!(runs.len(), 2, "a root and one child: {runs:?}");
    let root = runs
        .iter()
        .find(|run| run.id == root_run_id)
        .expect("the root run");
    let child = runs
        .iter()
        .find(|run| run.id != root_run_id)
        .expect("the delegated run");

    assert_eq!(root.parent_run_id, None, "the human's run is the root");
    assert_eq!(root.depth, 0);
    assert_eq!(child.agent_member_id, tenant.beta_id, "β got the work");
    assert_eq!(
        child.parent_run_id,
        Some(root_run_id),
        "the child names the run that delegated to it — without this the hop \
         cap has nothing to count"
    );
    assert_eq!(child.depth, 1, "depth = parent + 1");
    assert_eq!(child.status, "succeeded");

    // 2. β's answer reached the channel through the message spine.
    let messages = channel_messages(&su, &tenant).await;
    let beta_reply = messages
        .iter()
        .find(|(author, kind, _, _)| *author == tenant.beta_id && kind == "text")
        .expect("β answered in the channel");
    assert_eq!(beta_reply.2, "릴리스 노트 확인 완료했습니다.");
    assert_eq!(beta_reply.3["run_id"], json!(child.id));

    // 3. The child's trigger is α's *reply*, not the human's message: the run
    //    and the utterance that caused it stay joined in the database.
    let alpha_reply_id: Uuid = sqlx::query_scalar(
        "SELECT id FROM message WHERE workspace_id = $1 AND author_member_id = $2 \
           AND type = 'text' ORDER BY seq LIMIT 1",
    )
    .bind(tenant.workspace_id)
    .bind(tenant.alpha_id)
    .fetch_one(&su)
    .await
    .expect("α's reply");
    assert_eq!(child.trigger_message_id, Some(alpha_reply_id));

    // 4. The delegating run spent one of its steps doing so — Swift's rule that
    //    a gate claim consumes a step is what makes G3 a runtime cap rather
    //    than a comment.
    assert_eq!(root.step_count, 1, "the hop consumed one of α's steps");
    assert_eq!(child.step_count, 0, "β has not delegated anything");
}

// ---------------------------------------------------------------------------
// b72_2 — the loop stops
// ---------------------------------------------------------------------------

/// Two agents that answer each other forever. The caps are the only reason this
/// test terminates.
///
/// Reverting any cap in `evaluate_a2a_spawn` makes the chain grow by one run per
/// drain until the round budget runs out, and the run-count assertion is what
/// reports it — deliberately, instead of hanging on `drain_to_empty`.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a throwaway pgvector/pg18 database"]
async fn b72_2_a_mutual_mention_loop_stops_at_a_cap_instead_of_running_forever() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let tenant = seed_tenant(&su).await;

    enqueue_human_mention(&su, &tenant, tenant.alpha_id, "@hermes start").await;

    // α always answers "@atlas PING", β always answers "@hermes PONG". Keyed on
    // what each agent was told, so a rule can only fire for the agent that was
    // actually woken.
    let provider = Arc::new(MockChatProvider::scripted([
        ("PONG", "@atlas PING"),
        ("PING", "@hermes PONG"),
        ("start", "@atlas PING"),
    ]));
    let worker = build_worker(provider, base_config()).await;

    const ROUND_BUDGET: usize = 24;
    let (stats, rounds) = drain_bounded(&worker, ROUND_BUDGET).await;
    assert!(
        rounds < ROUND_BUDGET,
        "the ping-pong never stopped: {rounds} rounds, {stats:?} — every cap in \
         evaluate_a2a_spawn must be gone"
    );

    let runs = runs(&su, &tenant).await;
    let limits = A2aLimits::default().clamped();
    // The root sits at depth 0, so the deepest run a chain can reach is
    // `max_depth`, i.e. `max_depth + 1` runs on a strictly linear ping-pong.
    let ceiling = (limits.max_depth + 1) as usize;
    assert_eq!(
        runs.len(),
        ceiling,
        "a linear A2A chain is bounded by the depth cap ({} runs at \
         A2A_MAX_DEPTH={}): {runs:?}",
        ceiling,
        limits.max_depth
    );
    assert!(
        runs.iter().all(|run| run.depth <= limits.max_depth),
        "no run may exceed the configured cap: {runs:?}"
    );
    assert!(
        runs.iter()
            .all(|run| run.depth <= momo_agent::SCHEMA_DEPTH_CEILING),
        "…and none may exceed the schema's own CHECK (007): {runs:?}"
    );

    // The depths are 0,1,2,…: each run's parent is the one exactly above it.
    let mut depths: Vec<i32> = runs.iter().map(|run| run.depth).collect();
    depths.sort_unstable();
    assert_eq!(
        depths,
        (0..ceiling as i32).collect::<Vec<_>>(),
        "one run per hop, no gaps and no repeats: {runs:?}"
    );

    // The refusal is audited under a named cap, and it is visible in the channel
    // — silence would be indistinguishable from "the other agent ignored me".
    assert_eq!(stats.a2a_blocked, 1, "exactly one refusal closed the loop");
    let audited = a2a_audit_reasons(&su, &tenant).await;
    assert_eq!(
        audited.len(),
        1,
        "the block is on the record, once: {audited:?}"
    );
    let (reason, detail) = &audited[0];
    assert_eq!(reason, "a2a_depth_cap");
    assert_eq!(
        detail["a2a"]["gate"],
        json!("a2a_depth"),
        "Swift labels the hop gate a2a_depth, never G4 (the canonical G4 is the \
         SimHash detector): {detail}"
    );
    assert_eq!(detail["a2a"]["max_depth"], json!(limits.max_depth));

    let messages = channel_messages(&su, &tenant).await;
    let notice = messages
        .iter()
        .find(|(_, kind, _, props)| kind == "system" && props["kind"] == json!("a2a_blocked"))
        .expect("the channel says why the chain stopped");
    assert!(
        notice.2.contains("위임 깊이 한도"),
        "the line names the limit that held: {}",
        notice.2
    );
    assert_eq!(notice.3["reason"], json!("a2a_depth_cap"));
}

// ---------------------------------------------------------------------------
// b72_3 — the money stops it too
// ---------------------------------------------------------------------------

/// A chain whose ledger total crosses `A2A_MAX_CHAIN_TOKENS` stops **before**
/// spawning the next hop, with a visible line.
///
/// The mock bills 20 tokens per turn (11 prompt + 7 completion + 2 reasoning;
/// `cached_tokens` is deliberately not summed — it is a subset of the prompt).
/// The ceiling is set to exactly 20, so the root's own turn reaches it and the
/// first delegation is refused; 21 would let the hop through, which is what
/// makes this a test of the inclusive `>=` rather than of the wiring.
///
/// It is also the **ordering** assertion in disguise: evaluating the budget
/// before `record_run_usage_in_tx` would leave the chain reading 0 and let the
/// hop through no matter what the ceiling said.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a throwaway pgvector/pg18 database"]
async fn b72_3_a_chain_that_spends_its_budget_is_stopped_and_says_so() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let tenant = seed_tenant(&su).await;

    let (root_run_id, _) =
        enqueue_human_mention(&su, &tenant, tenant.alpha_id, "@hermes 예산 테스트").await;

    let provider = Arc::new(MockChatProvider::scripted([
        ("예산 테스트", "@atlas 이어서 부탁해"),
        ("이어서 부탁해", "이어서 처리했습니다."),
    ]));
    let mut config = base_config();
    // Exactly one turn's spend. `21` would let the hop through, so this pins the
    // inclusive `>=` and not merely that the term is wired up.
    const ONE_TURN_TOKENS: i64 = 11 + 7 + 2;
    config.a2a = A2aLimits {
        max_chain_tokens: ONE_TURN_TOKENS,
        ..A2aLimits::default()
    }
    .clamped();
    let worker = build_worker(provider, config).await;

    let (stats, _) = drain_bounded(&worker, 6).await;
    assert_eq!(stats.answered, 1, "α answered; β never ran: {stats:?}");
    assert_eq!(stats.delegated, 0, "the budget refused the hop: {stats:?}");
    assert_eq!(stats.a2a_blocked, 1);

    let runs = runs(&su, &tenant).await;
    assert_eq!(
        runs.len(),
        1,
        "no child run may exist once the chain is over budget: {runs:?}"
    );
    assert_eq!(runs[0].id, root_run_id);

    let audited = a2a_audit_reasons(&su, &tenant).await;
    assert_eq!(audited.len(), 1, "{audited:?}");
    let (reason, detail) = &audited[0];
    assert_eq!(reason, "a2a_chain_budget");
    assert_eq!(detail["a2a"]["axis"], json!("tokens"));
    assert_eq!(
        detail["a2a"]["chain_tokens"],
        json!(ONE_TURN_TOKENS),
        "the chain total includes the turn that just committed — 11 prompt + 7 \
         completion + 2 reasoning, with cached excluded: {detail}"
    );
    assert_eq!(detail["a2a"]["max"], json!(ONE_TURN_TOKENS));

    let messages = channel_messages(&su, &tenant).await;
    let notice = messages
        .iter()
        .find(|(_, kind, _, props)| kind == "system" && props["kind"] == json!("a2a_blocked"))
        .expect("the channel says the chain ran out of budget");
    assert!(
        notice.2.contains("토큰 한도"),
        "the line names the axis that tripped: {}",
        notice.2
    );

    // And the money it did spend is on the ledger under the root, so the number
    // the gate read is the number an operator can audit.
    let billed: i64 = sqlx::query_scalar(
        "SELECT COALESCE(sum(prompt_tokens + completion_tokens + reasoning_tokens), 0)::bigint \
           FROM usage_ledger WHERE workspace_id = $1",
    )
    .bind(tenant.workspace_id)
    .fetch_one(&su)
    .await
    .expect("read the ledger");
    assert_eq!(billed, ONE_TURN_TOKENS);
}

// ---------------------------------------------------------------------------
// b72_4 — the provenance is recorded, not inferred
// ---------------------------------------------------------------------------

/// Depth and parentage are written in **four** places that must agree: the run
/// row, the run's stored `input`, the job payload the next worker reads, and the
/// audit row.
///
/// Any one of them alone would let a reader answer "who asked this agent to
/// work"; all four together are what makes a disagreement impossible to hide,
/// and the job payload in particular is what carries the depth to a BYOA gateway
/// that never touches this database.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a throwaway pgvector/pg18 database"]
async fn b72_4_a_delegated_run_records_the_parent_and_the_depth_it_inherited() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let tenant = seed_tenant(&su).await;

    let (root_run_id, _) =
        enqueue_human_mention(&su, &tenant, tenant.alpha_id, "@hermes 인수인계").await;

    let provider = Arc::new(MockChatProvider::scripted([
        ("인수인계", "@atlas 이어받아 주세요"),
        ("이어받아 주세요", "이어받았습니다."),
    ]));
    let worker = build_worker(provider, base_config()).await;
    drain_bounded(&worker, 6).await;

    let runs = runs(&su, &tenant).await;
    let child = runs
        .iter()
        .find(|run| run.agent_member_id == tenant.beta_id)
        .expect("β's delegated run");

    // 1. The columns — the ones `agent_run_chain_idx` (001:297) indexes, so the
    //    whole tree is one recursive query.
    assert_eq!(child.parent_run_id, Some(root_run_id));
    assert_eq!(child.depth, 1);

    // 2. The stored input, which is what a run detail surface renders.
    assert_eq!(child.input["depth"], json!(1));
    assert_eq!(
        child.input["parent_run_id"],
        json!(root_run_id.to_string().to_uppercase()),
        "ids on the wire are Foundation-uppercase: a lowercase one would stop \
         matching rows the Swift server wrote"
    );
    assert_eq!(child.input["surface"], json!("mention"));

    // 3. The job payload — the copy that leaves this database.
    let payload: Value = sqlx::query_scalar(
        "SELECT payload FROM outbox \
          WHERE workspace_id = $1 AND kind = 'agent_job' \
            AND payload->>'run_id' = $2 LIMIT 1",
    )
    .bind(tenant.workspace_id)
    .bind(child.id.to_string().to_uppercase())
    .fetch_one(&su)
    .await
    .expect("the delegated job payload");
    assert_eq!(payload["depth"], json!(1));
    assert_eq!(
        payload["author_member_id"],
        json!(tenant.alpha_id.to_string().to_uppercase()),
        "the delegating agent is the author of the mention that caused this run"
    );

    // 4. The audit row, under the same schema a human's mention writes.
    let detail: Value = sqlx::query_scalar(
        "SELECT detail FROM audit_log \
          WHERE workspace_id = $1 AND action = 'agent.mention.queued' AND run_id = $2 \
          LIMIT 1",
    )
    .bind(tenant.workspace_id)
    .bind(child.id)
    .fetch_one(&su)
    .await
    .expect("the delegation's audit row");
    assert_eq!(detail["schema"], json!("momo.agent_mention.diagnostic.v0"));
    assert_eq!(detail["a2a"]["depth"], json!(1));
    assert_eq!(
        detail["a2a"]["parent_run_id"],
        json!(root_run_id.to_string().to_uppercase())
    );
    assert_eq!(
        detail["a2a"]["author_agent_member_id"],
        json!(tenant.alpha_id.to_string().to_uppercase())
    );

    // 5. The four agree with each other. Stated as its own assertion because
    //    that agreement — not any single field — is the provenance guarantee.
    assert_eq!(
        (
            child.depth,
            child.input["depth"].as_i64().unwrap_or(-1) as i32,
            payload["depth"].as_i64().unwrap_or(-1) as i32,
            detail["a2a"]["depth"].as_i64().unwrap_or(-1) as i32,
        ),
        (1, 1, 1, 1),
        "row, input, payload and audit must report one depth"
    );
}
