//! #3041 — the operator's 「기본 AI」 team rows reach the worker's answer path.
//!
//! DB-backed and `#[ignore]`d like its siblings; run against an isolated
//! `pgvector/pgvector:pg18` (container name `3041-*`):
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:<port>/momo \
//!   cargo test -p momo-agent-worker --test default_ai_conformance_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `the_model_precedence_is_agent_then_team_row_then_env_default` | apply the row over an agent's own model, or stop applying it to an agent on the instance default, or ignore `model_id` |
//! | `the_model_source_decides_not_the_models_name` | decide by comparing the payload model with `AGENT_MODEL` again (#3146 heuristic), or treat an absent `model_source` as `instance_default` |
//! | `a_row_on_a_chain_hop_calls_that_hop_and_no_other` | keep calling the head link for a position >= 1 |
//! | `a_row_whose_link_changed_refuses_honestly_and_calls_no_model` | drop the label comparison, or fall back to the head link / `AGENT_MODEL` when it fails |
//! | `the_summary_row_is_the_welcome_openers_and_the_team_row_is_the_mentions` | read one role for both jobs |
//! | `the_default_ai_resolver_names_no_personal_runtime_fact` | let the resolver read a personal profile or subscription table |

use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use momo_agent::{create_agent_run_in_tx, NewAgentRun, RunTrigger, WELCOME_JOB_CREATED_FROM};
use momo_agent_worker::provider::{ChatProvider, MockChatProvider};
use momo_agent_worker::{AgentWorker, DrainStats, WorkerConfig};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::{with_tenant_tx, PgPool};
use momo_messaging::{send_message_in_tx, NewMessage};
use momo_outbox::{emit_outbox, OutboxKind};
use momo_settings::{
    redacted_endpoint_label, replace_chain, seal_bearer, upsert_default_ai, upsert_link,
    DefaultAiRole,
};
use serde_json::{json, Value};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

const MASTER_KEY: &str = "conformance-3041-master";
const HEAD_URL: &str = "https://team-gw.example/v1";
const HEAD_BEARER: &str = "sk-head-3041-a1b2c3";
const HOP_URL: &str = "https://hop-gw.example/v1";
const HOP_BEARER: &str = "sk-hop-3041-d4e5f6";
const INSTANCE_DEFAULT: &str = "hermes-agent";

#[test]
fn the_default_ai_resolver_names_no_personal_runtime_fact() {
    let worker = include_str!("../src/lib.rs");
    let from = worker
        .find("async fn resolve_default_ai(")
        .expect("resolver marker is gone; re-point the #3041 guard");
    let to = worker[from..]
        .find("async fn settle_default_ai_unresolved(")
        .expect("end marker is gone");
    let region = &worker[from..from + to];
    assert!(
        region.contains("read_default_ai(") && region.contains("decrypt_chain_entry("),
        "anti-vacuity: the region is the resolver"
    );
    for fact in [
        "hosted_agent_connection",
        "agent_bearer",
        "FROM token",
        "token_hash",
        "owner_only",
        "invocation_scope",
        "subscription_harness",
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
        ".credentials.json",
    ] {
        assert!(
            !region.contains(fact),
            "the 기본 AI resolver names `{fact}`: a team row never reaches a personal credential"
        );
    }
}

// --- harness -----------------------------------------------------------------

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to an isolated pgvector/pg18 DB")
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect as superuser")
}

async fn momo_worker_pool() -> PgPool {
    let opts: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(
            opts.username("momo_worker").password(
                &std::env::var("MOMO_WORKER_PASSWORD")
                    .unwrap_or_else(|_| "momo_worker_dev_pw".to_string()),
            ),
        )
        .await
        .expect("connect as momo_worker (bootstrap_roles.sql)")
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
    panic!("psql client not found");
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply every migration");
    let roles = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/rust/sql/bootstrap_roles.sql"
    ));
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1", "--no-psqlrc", "--quiet"])
        .arg("--single-transaction")
        .arg("-f")
        .arg(roles)
        .status()
        .expect("spawn psql");
    assert!(status.success(), "bootstrap_roles.sql failed");
    *ready = true;
}

/// The claim is global and the link/rows are instance-global: start from empty.
async fn reset_instance(su: &PgPool) {
    sqlx::query(
        "UPDATE outbox SET status = 'done', processed_at = now() \
          WHERE kind = 'agent_job' AND status IN ('pending', 'processing')",
    )
    .execute(su)
    .await
    .expect("sweep residual agent_jobs");
    for table in [
        "provider_default_ai",
        "provider_link_chain",
        "provider_link",
    ] {
        sqlx::query(&format!("DELETE FROM {table}"))
            .execute(su)
            .await
            .expect("empty instance table");
    }
}

/// Instance-global rows leak into sibling suites that share the database (an
/// agent on the default model would meet this suite's row), so each test hands
/// the instance back empty.
async fn leave_instance_empty(su: &PgPool) {
    reset_instance(su).await;
}

struct Tenant {
    workspace_id: Uuid,
    human_id: Uuid,
    agent_id: Uuid,
    channel_id: Uuid,
}

async fn seed(su: &PgPool, agent_model: &str) -> Tenant {
    let t = Tenant {
        workspace_id: Uuid::new_v4(),
        human_id: Uuid::new_v4(),
        agent_id: Uuid::new_v4(),
        channel_id: Uuid::new_v4(),
    };
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(t.workspace_id)
        .bind(t.workspace_id.to_string())
        .execute(su)
        .await
        .expect("workspace");
    for (id, kind, display) in [
        (t.human_id, "human", "성재"),
        (t.agent_id, "agent", "hermes"),
    ] {
        sqlx::query(
            "INSERT INTO member (id, workspace_id, kind, status, display_name, handle) \
             VALUES ($1, $2, $3::member_kind, 'active', $4, $5)",
        )
        .bind(id)
        .bind(t.workspace_id)
        .bind(kind)
        .bind(display)
        .bind(id.to_string())
        .execute(su)
        .await
        .expect("member");
        sqlx::query(
            "INSERT INTO workspace_membership (workspace_id, member_id, role) \
             VALUES ($1, $2, 'member')",
        )
        .bind(t.workspace_id)
        .bind(id)
        .execute(su)
        .await
        .expect("workspace_membership");
    }
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, owner_human_id, \
                            max_concurrent_runs, max_run_steps) \
         VALUES ($1, $2, $3, 'https://gateway.invalid/v1', $4, 4, 50)",
    )
    .bind(t.agent_id)
    .bind(t.workspace_id)
    .bind(agent_model)
    .bind(t.human_id)
    .execute(su)
    .await
    .expect("agent");
    sqlx::query("INSERT INTO channel (id, workspace_id, kind, name) VALUES ($1, $2, 'public', $3)")
        .bind(t.channel_id)
        .bind(t.workspace_id)
        .bind(format!("c3041-{}", &t.channel_id.simple().to_string()[..8]))
        .execute(su)
        .await
        .expect("channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(t.channel_id)
        .bind(t.workspace_id)
        .execute(su)
        .await
        .expect("channel_seq");
    for member in [t.human_id, t.agent_id] {
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)",
        )
        .bind(t.workspace_id)
        .bind(t.channel_id)
        .bind(member)
        .execute(su)
        .await
        .expect("membership");
    }
    t
}

/// A mention turn exactly as the send route freezes it. `model` is what the
/// server stamped on the payload (the agent's resolved model).
/// `source` is the payload's `model_source` (`None`: the key is absent).
async fn enqueue_mention(pool: &PgPool, t: &Tenant, model: &str, source: Option<&str>) -> Uuid {
    let (workspace_id, channel_id, human, agent) =
        (t.workspace_id, t.channel_id, t.human_id, t.agent_id);
    let model = model.to_string();
    let source = source.map(str::to_string);
    with_tenant_tx(pool, workspace_id, move |conn| {
        Box::pin(async move {
            let sent = send_message_in_tx(
                conn,
                workspace_id,
                NewMessage::text(channel_id, human, "@hermes 정리해 줘".to_string()),
            )
            .await?;
            let created = create_agent_run_in_tx(
                conn,
                workspace_id,
                NewAgentRun {
                    channel_id,
                    trigger: RunTrigger::Mention {
                        message_id: sent.message.id,
                        agent_member_id: agent,
                    },
                    parent_run_id: None,
                    max_steps: 50,
                    depth: 0,
                    input: json!({"schema": "momo.agent_run.input.v0", "surface": "mention",
                                  "prompt": "정리해 줘", "depth": 0}),
                },
            )
            .await?;
            emit_outbox(
                &mut *conn,
                workspace_id,
                OutboxKind::AgentJob,
                "publish",
                &json!({
                    "run_id": created.id,
                    "workspace_id": workspace_id,
                    "channel_id": channel_id,
                    "agent_member_id": agent,
                    "author_member_id": human,
                    "trigger_message_id": sent.message.id,
                    "trigger_message_seq": sent.message.seq,
                    "model": model,
                    "model_source": source,
                    "prompt": "정리해 줘",
                    "recent_messages": [{
                        "message_id": sent.message.id, "channel_id": channel_id,
                        "seq": sent.message.seq, "author_member_id": human,
                        "author_kind": "human", "author_display": "성재",
                        "type": "text", "body": "@hermes 정리해 줘",
                    }],
                    "max_output_tokens": 256,
                    "depth": 0,
                    "delivery": "worker",
                    "created_from": "server.message_send.agent_mention.v0",
                }),
                Some(agent),
            )
            .await
            .map_err(momo_db::DbError::from)?;
            Ok(created.id)
        })
    })
    .await
    .expect("enqueue mention")
}

async fn enqueue_welcome(pool: &PgPool, t: &Tenant, model: &str, source: Option<&str>) {
    let (workspace_id, channel_id, human, agent) =
        (t.workspace_id, t.channel_id, t.human_id, t.agent_id);
    let model = model.to_string();
    let source = source.map(str::to_string);
    with_tenant_tx(pool, workspace_id, move |conn| {
        Box::pin(async move {
            emit_outbox(
                &mut *conn,
                workspace_id,
                OutboxKind::AgentJob,
                "publish",
                &json!({
                    "workspace_id": workspace_id,
                    "channel_id": channel_id,
                    "agent_member_id": agent,
                    "author_member_id": human,
                    "model": model,
                    "model_source": source,
                    "prompt": "첫 인사",
                    "welcome_kind": "opener",
                    "created_from": WELCOME_JOB_CREATED_FROM,
                }),
                Some(agent),
            )
            .await
            .map_err(momo_db::DbError::from)?;
            Ok(())
        })
    })
    .await
    .expect("enqueue welcome");
}

async fn worker(provider: &Arc<MockChatProvider>) -> AgentWorker {
    let mut config = WorkerConfig::for_target(database_url());
    config.claim_batch_size = 10;
    config.provider_link_master_key = Some(MASTER_KEY.to_string());
    AgentWorker::new(
        momo_worker_pool().await,
        provider.clone() as Arc<dyn ChatProvider>,
        config,
    )
}

async fn drain(worker: &AgentWorker) -> DrainStats {
    let mut total = DrainStats::default();
    for _ in 0..8 {
        let stats = worker.drain_once().await.expect("drain");
        total.claimed += stats.claimed;
        total.answered += stats.answered;
        total.skipped += stats.skipped;
        total.failed += stats.failed;
        if stats.claimed == 0 {
            break;
        }
    }
    total
}

/// The head link and (optionally) one chain hop, sealed as the routes seal them.
async fn seed_links(su: &PgPool, owner: Uuid, with_hop: bool) {
    let mut conn = su.acquire().await.unwrap();
    let head = seal_bearer(HEAD_BEARER, MASTER_KEY).unwrap();
    upsert_link(&mut conn, HEAD_URL, &head, "external-hermes", owner)
        .await
        .expect("head link");
    if with_hop {
        set_hop(su, owner, HOP_URL).await;
    }
}

async fn set_hop(su: &PgPool, owner: Uuid, url: &str) {
    let mut conn = su.acquire().await.unwrap();
    let hop = seal_bearer(HOP_BEARER, MASTER_KEY).unwrap();
    replace_chain(
        &mut conn,
        &[(1, url.to_string(), hop, "external-hermes".to_string(), true)],
        owner,
    )
    .await
    .expect("chain hop");
}

async fn put_row(
    su: &PgPool,
    owner: Uuid,
    role: DefaultAiRole,
    position: i32,
    url: &str,
    model: Option<&str>,
) {
    let mut conn = su.acquire().await.unwrap();
    upsert_default_ai(
        &mut conn,
        role,
        position,
        &redacted_endpoint_label(url),
        model,
        owner,
    )
    .await
    .expect("default ai row");
}

async fn run_state(su: &PgPool, run_id: Uuid) -> (String, Value) {
    let row: (String, Option<Value>) =
        sqlx::query_as("SELECT status::text, error FROM agent_run WHERE id = $1")
            .bind(run_id)
            .fetch_one(su)
            .await
            .unwrap();
    (row.0, row.1.unwrap_or(Value::Null))
}

// --- behaviour ---------------------------------------------------------------

/// Tier 1 (the agent's own model) > tier 2 (the team row) > tier 3 (`AGENT_MODEL`).
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn the_model_precedence_is_agent_then_team_row_then_env_default() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let t = seed(&su, INSTANCE_DEFAULT).await;
    seed_links(&su, t.human_id, false).await;

    // Tier 3: no row — the turn runs on the instance default, as before.
    let provider = Arc::new(MockChatProvider::echo());
    let w = worker(&provider).await;
    enqueue_mention(&su, &t, INSTANCE_DEFAULT, Some("instance_default")).await;
    assert_eq!(drain(&w).await.answered, 1);
    assert_eq!(provider.calls()[0].model, INSTANCE_DEFAULT, "tier 3");

    // Tier 2: the row names a model; an agent on the instance default takes it,
    // on the row's link.
    put_row(
        &su,
        t.human_id,
        DefaultAiRole::TeamAgent,
        0,
        HEAD_URL,
        Some("team-model-x"),
    )
    .await;
    let provider = Arc::new(MockChatProvider::echo());
    let w = worker(&provider).await;
    enqueue_mention(&su, &t, INSTANCE_DEFAULT, Some("instance_default")).await;
    assert_eq!(drain(&w).await.answered, 1);
    let call = &provider.calls()[0];
    assert_eq!(call.model, "team-model-x", "tier 2 beats AGENT_MODEL");
    assert_eq!(call.base_url, HEAD_URL);

    // Tier 1: an agent that chose its own model keeps it; the row is a default,
    // never an override (brief §4.2).
    let provider = Arc::new(MockChatProvider::echo());
    let w = worker(&provider).await;
    enqueue_mention(&su, &t, "agent-own-model", Some("agent")).await;
    assert_eq!(drain(&w).await.answered, 1);
    assert_eq!(provider.calls()[0].model, "agent-own-model", "tier 1");

    // A row without a model id is "the link's default": the turn keeps its model.
    put_row(&su, t.human_id, DefaultAiRole::TeamAgent, 0, HEAD_URL, None).await;
    let provider = Arc::new(MockChatProvider::echo());
    let w = worker(&provider).await;
    enqueue_mention(&su, &t, INSTANCE_DEFAULT, Some("instance_default")).await;
    assert_eq!(drain(&w).await.answered, 1);
    assert_eq!(provider.calls()[0].model, INSTANCE_DEFAULT);

    // An empty payload model (nothing stamped) is also "no own model".
    put_row(
        &su,
        t.human_id,
        DefaultAiRole::TeamAgent,
        0,
        HEAD_URL,
        Some("team-model-x"),
    )
    .await;
    let provider = Arc::new(MockChatProvider::echo());
    let w = worker(&provider).await;
    enqueue_mention(&su, &t, "", Some("instance_default")).await;
    assert_eq!(drain(&w).await.answered, 1);
    assert_eq!(provider.calls()[0].model, "team-model-x");
    leave_instance_empty(&su).await;
}

/// #3147 — the payload's `model_source` decides, not the model's name.
///
/// Under #3146's heuristic ("payload model empty or == `AGENT_MODEL`") case (a)
/// applied the row to an agent that deliberately chose the instance's own model
/// name, and case (b) skipped the row for an agent that follows the instance
/// default but stores another placeholder name.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn the_model_source_decides_not_the_models_name() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let t = seed(&su, INSTANCE_DEFAULT).await;
    seed_links(&su, t.human_id, false).await;
    put_row(
        &su,
        t.human_id,
        DefaultAiRole::TeamAgent,
        0,
        HEAD_URL,
        Some("team-model-x"),
    )
    .await;
    put_row(
        &su,
        t.human_id,
        DefaultAiRole::Summary,
        0,
        HEAD_URL,
        Some("summary-model"),
    )
    .await;

    // (a) The agent CHOSE a model that happens to be named like AGENT_MODEL: its
    // own choice stands, the row is not applied.
    let provider = Arc::new(MockChatProvider::echo());
    let w = worker(&provider).await;
    enqueue_mention(&su, &t, INSTANCE_DEFAULT, Some("agent")).await;
    assert_eq!(drain(&w).await.answered, 1);
    assert_eq!(provider.calls()[0].model, INSTANCE_DEFAULT, "(a)");

    // (b) The agent follows the instance default but stores another name: the row
    // applies although the name is not AGENT_MODEL.
    let provider = Arc::new(MockChatProvider::echo());
    let w = worker(&provider).await;
    enqueue_mention(&su, &t, "stored-placeholder", Some("instance_default")).await;
    assert_eq!(drain(&w).await.answered, 1);
    assert_eq!(provider.calls()[0].model, "team-model-x", "(b)");

    // (c) No `model_source` key (a job enqueued before #3147): never guessed from
    // the name — the row is not applied.
    let provider = Arc::new(MockChatProvider::echo());
    let w = worker(&provider).await;
    enqueue_mention(&su, &t, INSTANCE_DEFAULT, None).await;
    assert_eq!(drain(&w).await.answered, 1);
    assert_eq!(provider.calls()[0].model, INSTANCE_DEFAULT, "(c)");

    // (d) The same fact governs the welcome opener (summary row).
    let provider = Arc::new(MockChatProvider::echo());
    let w = worker(&provider).await;
    enqueue_welcome(&su, &t, INSTANCE_DEFAULT, Some("agent")).await;
    drain(&w).await;
    enqueue_welcome(&su, &t, "stored-placeholder", Some("instance_default")).await;
    drain(&w).await;
    let models: Vec<String> = provider.calls().into_iter().map(|c| c.model).collect();
    assert_eq!(
        models,
        vec![INSTANCE_DEFAULT.to_string(), "summary-model".to_string()],
        "(d)"
    );
    leave_instance_empty(&su).await;
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn a_row_on_a_chain_hop_calls_that_hop_and_no_other() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let t = seed(&su, INSTANCE_DEFAULT).await;
    seed_links(&su, t.human_id, true).await;
    put_row(
        &su,
        t.human_id,
        DefaultAiRole::TeamAgent,
        1,
        HOP_URL,
        Some("hop-model"),
    )
    .await;

    let provider = Arc::new(MockChatProvider::echo());
    let w = worker(&provider).await;
    enqueue_mention(&su, &t, INSTANCE_DEFAULT, Some("instance_default")).await;
    assert_eq!(drain(&w).await.answered, 1);
    let calls = provider.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0].base_url, HOP_URL,
        "the row's hop, not the head link"
    );
    assert_eq!(calls[0].bearer, HOP_BEARER, "the hop's own key");
    assert_eq!(calls[0].model, "hop-model");
    leave_instance_empty(&su).await;
}

/// The link the row was chosen on is gone: no model is called, on no link and
/// under no other model; the caller and the operator are both told.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn a_row_whose_link_changed_refuses_honestly_and_calls_no_model() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let t = seed(&su, INSTANCE_DEFAULT).await;
    seed_links(&su, t.human_id, true).await;

    // Chosen on the hop, then the operator re-saved the chain with another host
    // at the same position — the exact case a bare position cannot see.
    put_row(
        &su,
        t.human_id,
        DefaultAiRole::TeamAgent,
        1,
        HOP_URL,
        Some("hop-model"),
    )
    .await;
    set_hop(&su, t.human_id, "https://other-gw.example/v1").await;

    let provider = Arc::new(MockChatProvider::echo());
    let w = worker(&provider).await;
    let run_id = enqueue_mention(&su, &t, INSTANCE_DEFAULT, Some("instance_default")).await;
    drain(&w).await;

    assert!(
        provider.calls().is_empty(),
        "an unresolved row must not fall back to the head link or AGENT_MODEL: {:?}",
        provider
            .calls()
            .iter()
            .map(|c| (&c.base_url, &c.model))
            .collect::<Vec<_>>()
    );
    let (status, error) = run_state(&su, run_id).await;
    assert_eq!(status, "failed");
    assert_eq!(error["code"], "default_ai_unresolved");

    let lines: Vec<(String, String, Value)> = sqlx::query_as(
        "SELECT type::text, COALESCE(body, ''), props FROM message \
          WHERE workspace_id = $1 AND author_member_id = $2 ORDER BY seq",
    )
    .bind(t.workspace_id)
    .bind(t.agent_id)
    .fetch_all(&su)
    .await
    .unwrap();
    assert_eq!(lines.len(), 1, "one honest line: {lines:?}");
    assert_eq!(lines[0].0, "system");
    assert!(lines[0].1.contains("기본 AI"), "{}", lines[0].1);
    assert_eq!(lines[0].2["reason"], "default_ai_unresolved");
    assert_eq!(lines[0].2["notice_action"]["href"], "/settings?section=ai");

    let audits: Vec<Value> =
        sqlx::query_scalar("SELECT detail FROM audit_log WHERE workspace_id = $1 AND action = $2")
            .bind(t.workspace_id)
            .bind("provider_default_ai.unresolved")
            .fetch_all(&su)
            .await
            .unwrap();
    assert_eq!(audits.len(), 1, "one operator audit row");
    let audit = audits[0].to_string();
    assert!(
        audit.contains("hop-gw.example") && audit.contains("other-gw.example"),
        "{audit}"
    );
    for secret in [HEAD_BEARER, HOP_BEARER, "sk-"] {
        assert!(!audit.contains(secret), "audit carries `{secret}`: {audit}");
    }

    // A position the chain no longer has is the same refusal.
    put_row(
        &su,
        t.human_id,
        DefaultAiRole::TeamAgent,
        4,
        HOP_URL,
        Some("gone"),
    )
    .await;
    let provider = Arc::new(MockChatProvider::echo());
    let w = worker(&provider).await;
    let run_id = enqueue_mention(&su, &t, INSTANCE_DEFAULT, Some("instance_default")).await;
    drain(&w).await;
    assert!(provider.calls().is_empty());
    assert_eq!(
        run_state(&su, run_id).await.1["code"],
        "default_ai_unresolved"
    );

    // The head link swapped for another host: position 0 refuses too.
    put_row(
        &su,
        t.human_id,
        DefaultAiRole::TeamAgent,
        0,
        "https://old-head.example/v1",
        None,
    )
    .await;
    let provider = Arc::new(MockChatProvider::echo());
    let w = worker(&provider).await;
    let run_id = enqueue_mention(&su, &t, INSTANCE_DEFAULT, Some("instance_default")).await;
    drain(&w).await;
    assert!(provider.calls().is_empty());
    assert_eq!(
        run_state(&su, run_id).await.1["code"],
        "default_ai_unresolved"
    );

    // And an agent with its own model is not touched by a broken team row.
    let provider = Arc::new(MockChatProvider::echo());
    let w = worker(&provider).await;
    enqueue_mention(&su, &t, "agent-own-model", Some("agent")).await;
    assert_eq!(drain(&w).await.answered, 1);
    assert_eq!(provider.calls()[0].model, "agent-own-model");
    leave_instance_empty(&su).await;
}

/// 채널 요약·첫 인사 reads the `summary` row; the mention reads `team_agent`.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn the_summary_row_is_the_welcome_openers_and_the_team_row_is_the_mentions() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let t = seed(&su, INSTANCE_DEFAULT).await;
    seed_links(&su, t.human_id, false).await;
    put_row(
        &su,
        t.human_id,
        DefaultAiRole::TeamAgent,
        0,
        HEAD_URL,
        Some("team-model"),
    )
    .await;
    put_row(
        &su,
        t.human_id,
        DefaultAiRole::Summary,
        0,
        HEAD_URL,
        Some("summary-model"),
    )
    .await;

    let provider = Arc::new(MockChatProvider::echo());
    let w = worker(&provider).await;
    enqueue_welcome(&su, &t, INSTANCE_DEFAULT, Some("instance_default")).await;
    drain(&w).await;
    enqueue_mention(&su, &t, INSTANCE_DEFAULT, Some("instance_default")).await;
    drain(&w).await;
    let models: Vec<String> = provider.calls().into_iter().map(|c| c.model).collect();
    assert_eq!(
        models,
        vec!["summary-model".to_string(), "team-model".to_string()]
    );

    // With only the team row stored, the opener keeps the instance default —
    // the team-agent row is not the summary's.
    sqlx::query("DELETE FROM provider_default_ai WHERE role = 'summary'")
        .execute(&su)
        .await
        .unwrap();
    let provider = Arc::new(MockChatProvider::echo());
    let w = worker(&provider).await;
    let t2 = seed(&su, INSTANCE_DEFAULT).await;
    enqueue_welcome(&su, &t2, INSTANCE_DEFAULT, Some("instance_default")).await;
    drain(&w).await;
    assert_eq!(provider.calls()[0].model, INSTANCE_DEFAULT);
    leave_instance_empty(&su).await;
}
