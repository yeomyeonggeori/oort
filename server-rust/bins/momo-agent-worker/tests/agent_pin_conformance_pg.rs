//! #3873 — an agent pinned to one AI link runs on that link and on nothing else
//! (ADR-0147 증보 2026-10-16 「에이전트별 키 고정」).
//!
//! DB-backed and `#[ignore]`d like its siblings; run against an isolated
//! `pgvector/pgvector:pg18` (container name `keypin-3873-*`):
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:<port>/momo \
//!   cargo test -p momo-agent-worker --test agent_pin_conformance_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! The instance holds a stored team key (the Anthropic-shaped head link, plus one
//! chain hop) AND the operator's env link (`HERMES_BASE_URL`). Before the pin, the
//! stored key beat env, so the two could not coexist.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `an_env_pinned_agent_calls_hermes_while_the_team_key_is_stored` | resolve a pinned agent through the head link again; apply the 「기본 AI」 row to a pinned agent; read the pin from the payload instead of the agent row |
//! | `a_position_pin_calls_that_link_and_no_other` | ignore the pin's position; send position 0 to the chain hop |
//! | `a_pin_that_cannot_resolve_refuses_and_calls_nothing` | fall back to the head link, the env link or the 기본 AI row when the pin does not resolve; drop the label comparison; let position 0 mean "env when no link is stored" |
//! | `a_pinned_agent_has_no_team_welcome` | let the team's welcome opener run on the team link for a pinned agent |
//! | `an_env_pin_with_a_chosen_route_sends_provider_and_model_together` (#4143) | drop `provider` from the request, or send the pin's model without it; let the agent row's `hermes-agent` win over the pin |
//! | `an_env_pin_without_a_route_sends_exactly_what_it_sent_before` (#4143) | send a `provider` for a pin that chose none; send half a pair |
//! | `a_team_link_pin_never_carries_a_provider_and_the_store_refuses_a_half_pair` (#4143) | let a team_link pin or a one-sided pair into the table |
//! | `the_pin_resolver_names_no_personal_runtime_fact` | let the pin resolver read a personal profile or subscription table |

use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use momo_agent::{create_agent_run_in_tx, NewAgentRun, RunTrigger, WELCOME_JOB_CREATED_FROM};
use momo_agent_worker::provider::{ChatProvider, MockChatProvider};
use momo_agent_worker::{AgentWorker, DrainStats, WorkerConfig};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::{with_provider_link_admin_tx, with_tenant_tx, PgPool};
use momo_messaging::{send_message_in_tx, NewMessage};
use momo_outbox::{emit_outbox, OutboxKind};
use momo_settings::{
    redacted_endpoint_label, replace_chain, seal_bearer, set_agent_pin_model, upsert_agent_pin,
    upsert_default_ai, upsert_link, DefaultAiRole, PinKind, ProviderConfig, ProviderMode,
};
use serde_json::{json, Value};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

const MASTER_KEY: &str = "conformance-3873-master";
/// The team's Anthropic-shaped key: the stored head link.
const HEAD_URL: &str = "https://team-gw.example/v1";
const HEAD_BEARER: &str = "sk-head-3873-a1b2c3";
const HOP_URL: &str = "https://hop-gw.example/v1";
const HOP_BEARER: &str = "sk-hop-3873-d4e5f6";
/// The operator's env link: the co-hosted Hermes.
const ENV_URL: &str = "http://hermes.railway.internal:8642/v1";
const ENV_BEARER: &str = "hermes-env-3873-g7h8i9";
const INSTANCE_DEFAULT: &str = "hermes-agent";

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

/// The operator's env link, as `HERMES_BASE_URL` + `HERMES_API_KEY` configure it.
fn env_link() -> ProviderConfig {
    ProviderConfig {
        mode: ProviderMode::ExternalHermes,
        base_url: ENV_URL.to_string(),
        bearer: ENV_BEARER.to_string(),
        allow_local_loopback: false,
    }
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
        "agent_provider_pin",
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
                NewMessage::text(channel_id, human, "정리해 줘".to_string()),
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
                        "type": "text", "body": "정리해 줘",
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
    config.provider = env_link();
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

/// A second agent of the same tenant (the unpinned teammate). It joins the same
/// channel; its mention is enqueued through a copy of the tenant that names it.
async fn add_agent(su: &PgPool, t: &Tenant, agent_model: &str) -> Tenant {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, status, display_name, handle) \
         VALUES ($1, $2, 'agent'::member_kind, 'active', 'hermes', $3)",
    )
    .bind(id)
    .bind(t.workspace_id)
    .bind(id.to_string())
    .execute(su)
    .await
    .expect("member");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ($1, $2, 'member')",
    )
    .bind(t.workspace_id)
    .bind(id)
    .execute(su)
    .await
    .expect("workspace_membership");
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, owner_human_id, \
                            max_concurrent_runs, max_run_steps) \
         VALUES ($1, $2, $3, 'https://gateway.invalid/v1', $4, 4, 50)",
    )
    .bind(id)
    .bind(t.workspace_id)
    .bind(agent_model)
    .bind(t.human_id)
    .execute(su)
    .await
    .expect("agent");
    sqlx::query("INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)")
        .bind(t.workspace_id)
        .bind(t.channel_id)
        .bind(id)
        .execute(su)
        .await
        .expect("membership");
    Tenant {
        workspace_id: t.workspace_id,
        human_id: t.human_id,
        agent_id: id,
        channel_id: t.channel_id,
    }
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

/// Pin `agent` the way the operator route does: inside the operator transaction.
async fn pin_env(su: &PgPool, t: &Tenant, agent: Uuid) {
    let (ws, by) = (t.workspace_id, t.human_id);
    with_provider_link_admin_tx(su, ws, move |conn| {
        Box::pin(async move {
            upsert_agent_pin(conn, ws, agent, PinKind::OperatorEnv, None, None, by).await?;
            Ok(())
        })
    })
    .await
    .expect("pin env");
}

/// `pin_env` plus the co-hosted model route, the way the operator route writes it.
async fn pin_env_with_route(su: &PgPool, t: &Tenant, agent: Uuid, provider: &str, model: &str) {
    pin_env(su, t, agent).await;
    let (ws, provider, model) = (t.workspace_id, provider.to_string(), model.to_string());
    with_provider_link_admin_tx(su, ws, move |conn| {
        Box::pin(async move {
            assert!(set_agent_pin_model(conn, ws, agent, &provider, &model).await?);
            Ok(())
        })
    })
    .await
    .expect("set route");
}

async fn pin_link(su: &PgPool, t: &Tenant, agent: Uuid, position: i32, url_when_pinned: &str) {
    let (ws, by) = (t.workspace_id, t.human_id);
    let label = redacted_endpoint_label(url_when_pinned);
    with_provider_link_admin_tx(su, ws, move |conn| {
        Box::pin(async move {
            upsert_agent_pin(
                conn,
                ws,
                agent,
                PinKind::TeamLink,
                Some(position),
                Some(&label),
                by,
            )
            .await?;
            Ok(())
        })
    })
    .await
    .expect("pin link");
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

fn seen(provider: &MockChatProvider) -> Vec<(String, String, String)> {
    provider
        .calls()
        .into_iter()
        .map(|c| (c.base_url, c.bearer, c.model))
        .collect()
}

// --- behaviour ---------------------------------------------------------------

/// The reason this change exists: a team Anthropic key is stored AND a Hermes env
/// link is configured. The unpinned teammate keeps using the team key (and the
/// team's 「기본 AI」 model); the pinned agent calls Hermes with Hermes's key and
/// its own model. The pin is set AFTER the job was queued, which proves it is
/// read from the agent's row on the turn and not frozen into the payload.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn an_env_pinned_agent_calls_hermes_while_the_team_key_is_stored() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let team = seed(&su, INSTANCE_DEFAULT).await;
    let hermes = add_agent(&su, &team, INSTANCE_DEFAULT).await;
    seed_links(&su, team.human_id, false).await;
    put_row(
        &su,
        team.human_id,
        DefaultAiRole::TeamAgent,
        0,
        HEAD_URL,
        Some("claude-team-model"),
    )
    .await;

    // Both agents follow the instance default; both jobs are queued before the pin.
    let provider = Arc::new(MockChatProvider::echo());
    let w = worker(&provider).await;
    enqueue_mention(&su, &team, INSTANCE_DEFAULT, Some("instance_default")).await;
    enqueue_mention(&su, &hermes, INSTANCE_DEFAULT, Some("instance_default")).await;
    pin_env(&su, &team, hermes.agent_id).await;
    assert_eq!(drain(&w).await.answered, 2);

    let mut calls = seen(&provider);
    calls.sort();
    assert_eq!(
        calls,
        vec![
            (
                ENV_URL.to_string(),
                ENV_BEARER.to_string(),
                INSTANCE_DEFAULT.to_string()
            ),
            (
                HEAD_URL.to_string(),
                HEAD_BEARER.to_string(),
                "claude-team-model".to_string()
            ),
        ],
        "the pinned agent: Hermes link, Hermes key, its own model (the team row's model id \
         belongs to the team link); the teammate: the team key and the team row, unchanged"
    );

    // Clearing the pin sends the agent back to the team default.
    sqlx::query("DELETE FROM agent_provider_pin WHERE agent_member_id = $1")
        .bind(hermes.agent_id)
        .execute(&su)
        .await
        .unwrap();
    let provider = Arc::new(MockChatProvider::echo());
    let w = worker(&provider).await;
    enqueue_mention(&su, &hermes, INSTANCE_DEFAULT, Some("instance_default")).await;
    assert_eq!(drain(&w).await.answered, 1);
    assert_eq!(provider.calls()[0].base_url, HEAD_URL);
    leave_instance_empty(&su).await;
}

/// #4143: Hermes ignores a bare `model` on /v1/chat/completions, so the pin's
/// `(provider, model)` pair must reach the request together, and the model must be
/// the pin's, not the agent row's older `hermes-agent` alias.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn an_env_pin_with_a_chosen_route_sends_provider_and_model_together() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let team = seed(&su, INSTANCE_DEFAULT).await;
    let hermes = add_agent(&su, &team, INSTANCE_DEFAULT).await;
    seed_links(&su, team.human_id, false).await;
    // Queued with the alias model, pinned afterwards: the route is read per turn.
    let provider = Arc::new(MockChatProvider::echo());
    let w = worker(&provider).await;
    enqueue_mention(&su, &hermes, INSTANCE_DEFAULT, Some("agent")).await;
    pin_env_with_route(&su, &team, hermes.agent_id, "openai-codex", "gpt-5.6-sol").await;
    assert_eq!(drain(&w).await.answered, 1);
    let calls = provider.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].base_url, ENV_URL);
    assert_eq!(calls[0].bearer, ENV_BEARER);
    assert_eq!(
        (calls[0].provider.as_deref(), calls[0].model.as_str()),
        (Some("openai-codex"), "gpt-5.6-sol"),
        "the pair travels together"
    );
    leave_instance_empty(&su).await;
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn an_env_pin_without_a_route_sends_exactly_what_it_sent_before() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let team = seed(&su, INSTANCE_DEFAULT).await;
    let hermes = add_agent(&su, &team, INSTANCE_DEFAULT).await;
    seed_links(&su, team.human_id, false).await;
    pin_env(&su, &team, hermes.agent_id).await;
    let provider = Arc::new(MockChatProvider::echo());
    let w = worker(&provider).await;
    enqueue_mention(&su, &hermes, INSTANCE_DEFAULT, Some("agent")).await;
    assert_eq!(drain(&w).await.answered, 1);
    let calls = provider.calls();
    assert_eq!(
        (calls[0].provider.as_deref(), calls[0].model.as_str()),
        (None, INSTANCE_DEFAULT),
        "a pin that chose nothing sends today's model and no provider"
    );
    // The team's mentions are untouched by someone else's route.
    leave_instance_empty(&su).await;
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn a_team_link_pin_never_carries_a_provider_and_the_store_refuses_a_half_pair() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let team = seed(&su, INSTANCE_DEFAULT).await;
    let hermes = add_agent(&su, &team, INSTANCE_DEFAULT).await;
    pin_env_with_route(
        &su,
        &team,
        hermes.agent_id,
        "anthropic",
        "claude-sonnet-5-5",
    )
    .await;
    // Re-pinning clears the route: a stale provider can never follow a new pin.
    pin_env(&su, &team, hermes.agent_id).await;
    let cleared: (Option<String>, Option<String>) = sqlx::query_as(
        "SELECT model_provider, model_id FROM agent_provider_pin WHERE agent_member_id = $1",
    )
    .bind(hermes.agent_id)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(cleared, (None, None));
    // Half a pair, a team_link with a pair, and a malformed slug are table errors.
    for (what, sql) in [
        (
            "provider without model",
            "UPDATE agent_provider_pin SET model_provider = 'anthropic' WHERE agent_member_id = $1",
        ),
        (
            "model without provider",
            "UPDATE agent_provider_pin SET model_id = 'm' WHERE agent_member_id = $1",
        ),
        (
            "malformed slug",
            "UPDATE agent_provider_pin SET model_provider = 'A b', model_id = 'm' WHERE agent_member_id = $1",
        ),
        (
            "malformed model id",
            "UPDATE agent_provider_pin SET model_provider = 'a', model_id = 'm m' WHERE agent_member_id = $1",
        ),
        (
            "team_link carrying a pair",
            "UPDATE agent_provider_pin SET kind = 'team_link', link_position = 0, \
               link_endpoint_label = 'x', model_provider = 'a', model_id = 'm' WHERE agent_member_id = $1",
        ),
    ] {
        let refused = sqlx::query(sql)
            .bind(hermes.agent_id)
            .execute(&su)
            .await
            .is_err();
        assert!(refused, "{what} was stored");
    }
    leave_instance_empty(&su).await;
}

/// A position pin names that link and no other. Position 0 is the stored head
/// link itself; position 1 is the chain hop; neither is the env link.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn a_position_pin_calls_that_link_and_no_other() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let team = seed(&su, INSTANCE_DEFAULT).await;
    seed_links(&su, team.human_id, true).await;

    pin_link(&su, &team, team.agent_id, 1, HOP_URL).await;
    let provider = Arc::new(MockChatProvider::echo());
    let w = worker(&provider).await;
    enqueue_mention(&su, &team, "agent-own-model", Some("agent")).await;
    assert_eq!(drain(&w).await.answered, 1);
    assert_eq!(
        seen(&provider),
        vec![(
            HOP_URL.to_string(),
            HOP_BEARER.to_string(),
            "agent-own-model".to_string()
        )],
        "the hop, with the hop's own key"
    );

    pin_link(&su, &team, team.agent_id, 0, HEAD_URL).await;
    let provider = Arc::new(MockChatProvider::echo());
    let w = worker(&provider).await;
    enqueue_mention(&su, &team, "agent-own-model", Some("agent")).await;
    assert_eq!(drain(&w).await.answered, 1);
    assert_eq!(
        seen(&provider),
        vec![(
            HEAD_URL.to_string(),
            HEAD_BEARER.to_string(),
            "agent-own-model".to_string()
        )]
    );
    leave_instance_empty(&su).await;
}

/// Every way a pin can stop resolving refuses the turn: no model is called, on
/// no link. The head link, the env link and the hop are all configured and
/// healthy in each case, so any fallback would show up as a call.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn a_pin_that_cannot_resolve_refuses_and_calls_nothing() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let team = seed(&su, INSTANCE_DEFAULT).await;
    seed_links(&su, team.human_id, true).await;
    // A team row that a fallback to the team road would obey.
    put_row(
        &su,
        team.human_id,
        DefaultAiRole::TeamAgent,
        0,
        HEAD_URL,
        Some("claude-team-model"),
    )
    .await;

    // (a) The hop was re-saved with another host at the pinned position.
    pin_link(&su, &team, team.agent_id, 1, HOP_URL).await;
    set_hop(&su, team.human_id, "https://other-gw.example/v1").await;
    let provider = Arc::new(MockChatProvider::echo());
    let w = worker(&provider).await;
    let run_id = enqueue_mention(&su, &team, "agent-own-model", Some("agent")).await;
    drain(&w).await;
    assert!(
        provider.calls().is_empty(),
        "(a) a changed hop must not fall back: {:?}",
        seen(&provider)
    );
    let (status, error) = run_state(&su, run_id).await;
    assert_eq!(status, "failed");
    assert_eq!(error["code"], "pinned_link_unresolved");

    // The caller sees one honest line, the operator an audit row with no secret.
    let lines: Vec<(String, String, Value)> = sqlx::query_as(
        "SELECT type::text, COALESCE(body, ''), props FROM message \
          WHERE workspace_id = $1 AND author_member_id = $2 ORDER BY seq",
    )
    .bind(team.workspace_id)
    .bind(team.agent_id)
    .fetch_all(&su)
    .await
    .unwrap();
    assert_eq!(lines.len(), 1, "one honest line: {lines:?}");
    assert_eq!(lines[0].0, "system");
    assert!(lines[0].1.contains("고정해 둔"), "{}", lines[0].1);
    assert!(
        lines[0].1.contains("대신 답하지 않았어요"),
        "{}",
        lines[0].1
    );
    assert_eq!(lines[0].2["reason"], "pinned_link_unresolved");
    assert_eq!(lines[0].2["notice_action"]["href"], "/settings?section=ai");
    let audits: Vec<Value> =
        sqlx::query_scalar("SELECT detail FROM audit_log WHERE workspace_id = $1 AND action = $2")
            .bind(team.workspace_id)
            .bind("agent.provider_pin.unresolved")
            .fetch_all(&su)
            .await
            .unwrap();
    assert_eq!(audits.len(), 1, "one operator audit row");
    let audit = audits[0].to_string();
    assert!(
        audit.contains("hop-gw.example") && audit.contains("other-gw.example"),
        "{audit}"
    );
    assert!(audit.contains("team_link_changed"), "{audit}");
    for secret in [
        HEAD_BEARER,
        HOP_BEARER,
        ENV_BEARER,
        "sk-",
        "railway.internal",
    ] {
        assert!(!audit.contains(secret), "audit carries `{secret}`: {audit}");
    }

    // (b) A position the chain does not have.
    pin_link(&su, &team, team.agent_id, 4, HOP_URL).await;
    let provider = Arc::new(MockChatProvider::echo());
    let w = worker(&provider).await;
    let run_id = enqueue_mention(&su, &team, "agent-own-model", Some("agent")).await;
    drain(&w).await;
    assert!(provider.calls().is_empty(), "(b) {:?}", seen(&provider));
    assert_eq!(
        run_state(&su, run_id).await.1["code"],
        "pinned_link_unresolved"
    );

    // (c) A disabled hop.
    set_hop(&su, team.human_id, HOP_URL).await;
    sqlx::query("UPDATE provider_link_chain SET enabled = false WHERE position = 1")
        .execute(&su)
        .await
        .unwrap();
    pin_link(&su, &team, team.agent_id, 1, HOP_URL).await;
    let provider = Arc::new(MockChatProvider::echo());
    let w = worker(&provider).await;
    let run_id = enqueue_mention(&su, &team, "agent-own-model", Some("agent")).await;
    drain(&w).await;
    assert!(provider.calls().is_empty(), "(c) {:?}", seen(&provider));
    assert_eq!(
        run_state(&su, run_id).await.1["code"],
        "pinned_link_unresolved"
    );

    // (d) Position 0 pinned, then the stored link is deleted: the head falls back
    // to the ENV link, and the pin must not follow it there.
    pin_link(&su, &team, team.agent_id, 0, HEAD_URL).await;
    sqlx::query("DELETE FROM provider_default_ai")
        .execute(&su)
        .await
        .unwrap();
    sqlx::query("DELETE FROM provider_link")
        .execute(&su)
        .await
        .unwrap();
    let provider = Arc::new(MockChatProvider::echo());
    let w = worker(&provider).await;
    let run_id = enqueue_mention(&su, &team, "agent-own-model", Some("agent")).await;
    drain(&w).await;
    assert!(
        provider.calls().is_empty(),
        "(d) position 0 must never mean env: {:?}",
        seen(&provider)
    );
    assert_eq!(
        run_state(&su, run_id).await.1["code"],
        "pinned_link_unresolved"
    );

    // (e) An env pin while the env link is not configured (no key): the stored
    // team key is healthy and must not answer instead.
    seed_links(&su, team.human_id, false).await;
    pin_env(&su, &team, team.agent_id).await;
    let provider = Arc::new(MockChatProvider::echo());
    let mut config = WorkerConfig::for_target(database_url());
    config.claim_batch_size = 10;
    config.provider_link_master_key = Some(MASTER_KEY.to_string());
    config.provider = ProviderConfig {
        bearer: String::new(),
        ..env_link()
    };
    let w = AgentWorker::new(
        momo_worker_pool().await,
        provider.clone() as Arc<dyn ChatProvider>,
        config,
    );
    let run_id = enqueue_mention(&su, &team, "agent-own-model", Some("agent")).await;
    drain(&w).await;
    assert!(
        provider.calls().is_empty(),
        "(e) an unconfigured env link must not fall to the team key: {:?}",
        seen(&provider)
    );
    assert_eq!(
        run_state(&su, run_id).await.1["code"],
        "pinned_link_unresolved"
    );

    // (g) Position 0 pinned on a stored link that points at the SAME host as the
    // env link. While it is stored the pin calls it with the stored key; once it is
    // deleted the head falls back to env, whose label is now equal to the pinned
    // one, and the pin must still refuse (the env link has its own kind).
    sqlx::query("DELETE FROM provider_link")
        .execute(&su)
        .await
        .unwrap();
    {
        let mut conn = su.acquire().await.unwrap();
        let sealed = seal_bearer(HEAD_BEARER, MASTER_KEY).unwrap();
        upsert_link(
            &mut conn,
            ENV_URL,
            &sealed,
            "external-hermes",
            team.human_id,
        )
        .await
        .expect("same-host link");
    }
    pin_link(&su, &team, team.agent_id, 0, ENV_URL).await;
    let provider = Arc::new(MockChatProvider::echo());
    let w = worker(&provider).await;
    enqueue_mention(&su, &team, "agent-own-model", Some("agent")).await;
    assert_eq!(drain(&w).await.answered, 1);
    assert_eq!(
        seen(&provider),
        vec![(
            ENV_URL.to_string(),
            HEAD_BEARER.to_string(),
            "agent-own-model".to_string()
        )],
        "(g) while stored, the pin uses the STORED key"
    );
    sqlx::query("DELETE FROM provider_link")
        .execute(&su)
        .await
        .unwrap();
    let provider = Arc::new(MockChatProvider::echo());
    let w = worker(&provider).await;
    let run_id = enqueue_mention(&su, &team, "agent-own-model", Some("agent")).await;
    drain(&w).await;
    assert!(
        provider.calls().is_empty(),
        "(g) the env fallback with an equal label must not satisfy a position-0 pin: {:?}",
        seen(&provider)
    );
    assert_eq!(
        run_state(&su, run_id).await.1["code"],
        "pinned_link_unresolved"
    );
    seed_links(&su, team.human_id, false).await;

    // (f) And an unpinned agent of the same instance is untouched by all of it.
    let teammate = add_agent(&su, &team, "agent-own-model").await;
    let provider = Arc::new(MockChatProvider::echo());
    let w = worker(&provider).await;
    enqueue_mention(&su, &teammate, "agent-own-model", Some("agent")).await;
    assert_eq!(drain(&w).await.answered, 1);
    assert_eq!(provider.calls()[0].base_url, HEAD_URL);
    leave_instance_empty(&su).await;
}

/// The welcome opener is the team's voice on the team link. A pinned agent does
/// not welcome, and the team's link is not spent for it.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn a_pinned_agent_has_no_team_welcome() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let team = seed(&su, INSTANCE_DEFAULT).await;
    seed_links(&su, team.human_id, false).await;
    put_row(
        &su,
        team.human_id,
        DefaultAiRole::Summary,
        0,
        HEAD_URL,
        Some("summary-model"),
    )
    .await;
    pin_env(&su, &team, team.agent_id).await;

    let provider = Arc::new(MockChatProvider::echo());
    let w = worker(&provider).await;
    enqueue_welcome(&su, &team, INSTANCE_DEFAULT, Some("instance_default")).await;
    drain(&w).await;
    assert!(
        provider.calls().is_empty(),
        "a pinned agent's welcome must not call the team link: {:?}",
        seen(&provider)
    );
    let welcome_lines: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM message WHERE workspace_id = $1 AND author_member_id = $2",
    )
    .bind(team.workspace_id)
    .bind(team.agent_id)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(welcome_lines, 0, "no welcome and no error line either");
    leave_instance_empty(&su).await;
}

#[test]
fn the_pin_resolver_names_no_personal_runtime_fact() {
    let worker = include_str!("../src/lib.rs");
    let from = worker
        .find("async fn resolve_agent_pin(")
        .expect("pin resolver marker is gone; re-point the #3873 guard");
    let to = worker[from..]
        .find("async fn settle_pinned_link_unresolved(")
        .expect("end marker is gone");
    let region = &worker[from..from + to];
    assert!(
        region.contains("read_agent_pin(") && region.contains("decrypt_chain_entry("),
        "anti-vacuity: the region is the pin resolver"
    );
    for fact in [
        "hosted_agent_connection",
        "agent_bearer",
        "FROM token",
        "token_hash",
        "invocation_scope",
        "subscription_harness",
        "personal_provider_link",
        "uses_owner_key",
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
        ".credentials.json",
    ] {
        assert!(
            !region.contains(fact),
            "the pin resolver names `{fact}`: a team pin never reaches a personal credential"
        );
    }
}
