//! #2882 — a personal subscription credential can never reach a team agent's
//! answer (brief `claudedocs/ai-accounts` §4.5, ADR-0193 D2·D4, ADR-0135 D1).
//!
//! Two layers, because the invariant has two halves:
//!
//! * **Structural (runs in `cargo test`).** The only code that decides which
//!   credential a team turn presents is `AgentWorker::resolve_transport` and the
//!   `momo-settings` link/chain resolvers it calls. None of them may name a
//!   table, column or path that belongs to a *person's* runtime: the hosted
//!   connection, its Agent Port token, the owner, the harness, the scope, or a
//!   CLI profile folder. Each region is also required to contain the call it
//!   exists for, so an extraction that drifts to an empty string cannot pass.
//! * **Behavioural (isolated PostgreSQL, `#[ignore]`).** A workspace holds a
//!   team agent (`workspace` scope, served by this worker) and the owner's
//!   subscription agent (`owner_only`, an active proved hosted connection with a
//!   live Agent Port token, approved for the same channel). The team link is
//!   **empty**. A non-owner calls the team agent, the team agent's answer
//!   mentions the subscription agent, and a welcome runs with no team key:
//!   - every model call presents the team's env bearer and nothing else;
//!   - with no team key at all the turn cannot answer — zero model calls, the
//!     static `provider_required` line — and nothing is borrowed (ADR-0135 D1:
//!     no silent fallback);
//!   - the subscription agent gets zero runs, zero jobs, zero claimable hosted
//!     jobs and zero inbox events from any of it, while the owner's own plain
//!     message *does* reach its inbox (the fixture is live, so the zeros are
//!     not vacuous).
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:<port>/momo \
//!   cargo test -p momo-agent-worker --test personal_credential_isolation \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `the_team_resolver_names_no_personal_runtime_fact` | any read of `token` / `hosted_agent_connection` / owner / harness / profile path inside the team resolution path |
//! | `an_empty_team_link_answers_on_the_team_env_only_and_never_reaches_the_subscription_agent` | put a personal credential into the empty-link branch of `resolve_transport`; drop the owner predicate from the inbox fan-out (it is written twice — `hosted_inbox_recipients_in_tx` and `append_message_reference_in_tx` — and only removing both reaches the inbox); drop the hosted skip in the worker's A2A routing |
//! | `with_no_team_key_the_turn_cannot_answer_and_borrows_nothing` | call the model when `provider_is_configured` is false, or resolve a non-team credential for it |

use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use momo_agent::{create_agent_run_in_tx, NewAgentRun, RunTrigger, WELCOME_JOB_CREATED_FROM};
use momo_agent_worker::provider::{ChatProvider, MockChatProvider};
use momo_agent_worker::{AgentWorker, DrainStats, WorkerConfig};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::{with_tenant_tx, PgPool};
use momo_messaging::{send_message_with_mentions_in_tx, NewMessage, SendExtras};
use momo_outbox::{emit_outbox, OutboxKind};
use momo_settings::ProviderConfig;
use serde_json::json;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// structural
// ---------------------------------------------------------------------------

/// Identifiers that only a person's own runtime has. A team credential is
/// resolved from `provider_link` (and the `HERMES_*` env) — never from these.
const PERSONAL_RUNTIME_FACTS: &[&str] = &[
    "hosted_agent_connection",
    "hosted_agent_inbox",
    "hosted_active",
    "hosted_oauth_access",
    "agent_bearer",
    "FROM token",
    "JOIN token",
    "token_hash",
    "owner_human_id",
    "owner_only",
    "invocation_scope",
    "subscription_harness",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    ".credentials.json",
];

/// The text between `start` and `end` in `source`, panicking when either marker
/// is gone — a renamed function must fail this test, not shrink it to nothing.
fn region<'a>(source: &'a str, start: &str, end: &str) -> &'a str {
    let from = source
        .find(start)
        .unwrap_or_else(|| panic!("marker `{start}` is gone; re-point the #2882 guard"));
    let rest = &source[from..];
    let to = rest[start.len()..]
        .find(end)
        .unwrap_or_else(|| panic!("marker `{end}` is gone; re-point the #2882 guard"));
    &rest[..start.len() + to]
}

/// Production half of a module: everything before its `#[cfg(test)]`.
fn production(source: &str) -> &str {
    source
        .split("#[cfg(test)]")
        .next()
        .expect("split always yields a first part")
}

#[test]
fn the_team_resolver_names_no_personal_runtime_fact() {
    let worker = include_str!("../src/lib.rs");
    let resolve = region(
        worker,
        "pub async fn resolve_endpoint(",
        "// OAuth refresh + re-seal",
    );
    let fallback = region(worker, "fn transport_or_env(", "\n}\n");
    let link = production(include_str!("../../../crates/momo-settings/src/link.rs"));
    let chain = production(include_str!("../../../crates/momo-settings/src/chain.rs"));

    // Anti-vacuity: each region is the code it claims to be.
    assert!(
        resolve.contains("read_link(&mut conn)"),
        "resolve_transport region"
    );
    assert!(resolve.contains("decrypt_link(&stored, master_key)"));
    assert!(
        fallback.contains("None => env_transport()"),
        "transport_or_env region"
    );
    assert!(
        link.contains("FROM provider_link"),
        "link.rs production half"
    );
    assert!(
        chain.contains("FROM provider_link_chain"),
        "chain.rs production half"
    );

    for (name, text) in [
        ("AgentWorker::resolve_transport", resolve),
        ("transport_or_env", fallback),
        ("momo-settings link.rs", link),
        ("momo-settings chain.rs", chain),
    ] {
        for fact in PERSONAL_RUNTIME_FACTS {
            assert!(
                !text.contains(fact),
                "{name} names `{fact}`: a team turn's credential must come from \
                 provider_link or the operator env only (brief §4.5-2, ADR-0193 D2)"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// isolated database harness (same contract as agent_worker_conformance_pg.rs)
// ---------------------------------------------------------------------------

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

/// Retire every worker job this binary did not enqueue (the claim is global),
/// and empty the instance-global team link: this suite is about the empty chain.
async fn reset_instance(su: &PgPool) {
    sqlx::query(
        "UPDATE outbox SET status = 'done', processed_at = now() \
          WHERE kind = 'agent_job' AND status IN ('pending', 'processing')",
    )
    .execute(su)
    .await
    .expect("sweep residual agent_jobs");
    sqlx::query("DELETE FROM provider_link_chain")
        .execute(su)
        .await
        .expect("empty the fallback chain");
    sqlx::query("DELETE FROM provider_link")
        .execute(su)
        .await
        .expect("empty the team link");
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const MASTER_KEY: &str = "conformance-2882-master";
/// The operator's env bearer — the only credential a team turn may present
/// while the team link is empty.
const TEAM_ENV_BEARER: &str = "sk-team-env-2882-a9f3c1";
const TEAM: &str = "hermes";
const SUBSCRIBER: &str = "kometto";

struct Tenant {
    workspace_id: Uuid,
    owner_id: Uuid,
    teammate_id: Uuid,
    channel_id: Uuid,
    team_agent_id: Uuid,
    subscription_agent_id: Uuid,
    subscription_connection_id: Uuid,
    /// Hex of the subscription agent's Agent Port token hash — the only
    /// per-person secret material the server holds for it.
    subscription_token_hex: String,
}

async fn seed(su: &PgPool) -> Tenant {
    let t = Tenant {
        workspace_id: Uuid::new_v4(),
        owner_id: Uuid::new_v4(),
        teammate_id: Uuid::new_v4(),
        channel_id: Uuid::new_v4(),
        team_agent_id: Uuid::new_v4(),
        subscription_agent_id: Uuid::new_v4(),
        subscription_connection_id: Uuid::new_v4(),
        subscription_token_hex: String::new(),
    };
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(t.workspace_id)
        .bind(t.workspace_id.to_string())
        .execute(su)
        .await
        .expect("workspace");
    for (id, kind, display, handle) in [
        (
            t.owner_id,
            "human",
            "성재",
            format!("owner-{}", t.owner_id.simple()),
        ),
        (
            t.teammate_id,
            "human",
            "동료",
            format!("mate-{}", t.teammate_id.simple()),
        ),
        (t.team_agent_id, "agent", TEAM, TEAM.to_string()),
        (
            t.subscription_agent_id,
            "agent",
            SUBSCRIBER,
            SUBSCRIBER.to_string(),
        ),
    ] {
        sqlx::query(
            "INSERT INTO member (id, workspace_id, kind, status, display_name, handle) \
             VALUES ($1, $2, $3::member_kind, 'active', $4, $5)",
        )
        .bind(id)
        .bind(t.workspace_id)
        .bind(kind)
        .bind(display)
        .bind(handle)
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
    // The team agent: `workspace` scope (the column default), served here.
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, owner_human_id, \
                            max_concurrent_runs, max_run_steps) \
         VALUES ($1, $2, 'hermes-agent', 'https://gateway.invalid/v1', $3, 4, 50)",
    )
    .bind(t.team_agent_id)
    .bind(t.workspace_id)
    .bind(t.owner_id)
    .execute(su)
    .await
    .expect("team agent");
    // The owner's subscription agent, exactly as the hosted create route
    // leaves it (`mark_agent_owner_only_in_tx`).
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, config, owner_human_id, \
                            invocation_scope, subscription_harness) \
         VALUES ($1, $2, 'hosted-agent', 'https://hosted-agent.invalid/disabled', \
                 '{\"execution_mode\":\"hosted_dial_in\"}'::jsonb, $3, \
                 'owner_only', 'claude_code')",
    )
    .bind(t.subscription_agent_id)
    .bind(t.workspace_id)
    .bind(t.owner_id)
    .execute(su)
    .await
    .expect("subscription agent");
    for agent in [t.team_agent_id, t.subscription_agent_id] {
        sqlx::query(
            "INSERT INTO agent_profile (agent_member_id, workspace_id, updated_by, paused) \
             VALUES ($1, $2, $3, false)",
        )
        .bind(agent)
        .bind(t.workspace_id)
        .bind(t.owner_id)
        .execute(su)
        .await
        .expect("agent_profile");
    }
    sqlx::query("INSERT INTO channel (id, workspace_id, kind, name) VALUES ($1, $2, 'public', $3)")
        .bind(t.channel_id)
        .bind(t.workspace_id)
        .bind(format!("c2882-{}", &t.channel_id.simple().to_string()[..8]))
        .execute(su)
        .await
        .expect("channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(t.channel_id)
        .bind(t.workspace_id)
        .execute(su)
        .await
        .expect("channel_seq");
    for member in [
        t.owner_id,
        t.teammate_id,
        t.team_agent_id,
        t.subscription_agent_id,
    ] {
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
    // A live, proved connection approved for this channel, with inbox AND job
    // scopes — everything the owner's CLI would need to be handed work.
    sqlx::query(
        "INSERT INTO hosted_agent_connection ( \
           id, workspace_id, agent_member_id, status, pairing_consumed_at, detected_at, \
           detected_by, confirmed_by, confirmed_at, approved_channel_ids, approved_scopes, \
           created_by) \
         VALUES ($1, $2, $3, 'detected', now(), now(), $4, $4, now(), ARRAY[$5]::uuid[], \
           ARRAY['agent:port:connect','agent:inbox:read','agent:jobs:read']::text[], $4)",
    )
    .bind(t.subscription_connection_id)
    .bind(t.workspace_id)
    .bind(t.subscription_agent_id)
    .bind(t.owner_id)
    .bind(t.channel_id)
    .execute(su)
    .await
    .expect("hosted connection");
    let token = Uuid::new_v4();
    let mut hash = vec![0x28_u8; 32];
    hash[..16].copy_from_slice(token.as_bytes());
    sqlx::query(
        "INSERT INTO token (id, workspace_id, kind, actor_member_id, token_hash, scopes, \
                            created_by, credential_class, hosted_connection_id, audience) \
         VALUES ($1, $2, 'agent_bearer', $3, $4, \
           ARRAY['agent:port:connect','agent:inbox:read','agent:jobs:read']::text[], $5, \
           'hosted_active', $6, '/v1/mcp/agent-port')",
    )
    .bind(token)
    .bind(t.workspace_id)
    .bind(t.subscription_agent_id)
    .bind(&hash)
    .bind(t.owner_id)
    .bind(t.subscription_connection_id)
    .execute(su)
    .await
    .expect("hosted token");
    sqlx::query(
        "UPDATE hosted_agent_connection SET status = 'active', active_token_id = $3, \
           proved_at = now(), proved_by = $4 WHERE workspace_id = $1 AND id = $2",
    )
    .bind(t.workspace_id)
    .bind(t.subscription_connection_id)
    .bind(token)
    .bind(t.owner_id)
    .execute(su)
    .await
    .expect("activate hosted connection");
    Tenant {
        subscription_token_hex: hash.iter().map(|b| format!("{b:02x}")).collect(),
        ..t
    }
}

/// A channel message through the REST send's own function (the product spine,
/// hosted inbox fan-out included), optionally with the mention run + worker job the send
/// route writes for the team agent.
async fn send(pool: &PgPool, t: &Tenant, author: Uuid, body: &str, mention_team: bool) {
    let (workspace_id, channel_id, team) = (t.workspace_id, t.channel_id, t.team_agent_id);
    let body = body.to_string();
    with_tenant_tx(pool, workspace_id, move |conn| {
        Box::pin(async move {
            let sent = send_message_with_mentions_in_tx(
                conn,
                workspace_id,
                NewMessage::text(channel_id, author, body.clone()),
                SendExtras::default(),
            )
            .await?
            .expect("a plain unsigned send is never refused");
            if !mention_team {
                return Ok(());
            }
            let created = create_agent_run_in_tx(
                conn,
                workspace_id,
                NewAgentRun {
                    channel_id,
                    trigger: RunTrigger::Mention {
                        message_id: sent.message.id,
                        agent_member_id: team,
                    },
                    parent_run_id: None,
                    max_steps: 50,
                    depth: 0,
                    input: json!({"schema": "momo.agent_run.input.v0", "surface": "mention",
                                  "prompt": body, "depth": 0}),
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
                    "agent_member_id": team,
                    "author_member_id": author,
                    "trigger_message_id": sent.message.id,
                    "trigger_message_seq": sent.message.seq,
                    "model": "hermes-agent",
                    "prompt": body,
                    "recent_messages": [{
                        "message_id": sent.message.id, "channel_id": channel_id,
                        "seq": sent.message.seq, "author_member_id": author,
                        "author_kind": "human", "author_display": "동료",
                        "type": "text", "body": body,
                    }],
                    "max_output_tokens": 256,
                    "depth": 0,
                    "delivery": "worker",
                    "created_from": "server.message_send.agent_mention.v0",
                }),
                Some(team),
            )
            .await
            .map_err(momo_db::DbError::from)?;
            Ok(())
        })
    })
    .await
    .expect("send");
}

fn worker_config(env_bearer: Option<&str>) -> WorkerConfig {
    let mut config = WorkerConfig::for_target(database_url());
    config.claim_batch_size = 10;
    // The DB tier is exercised: without a master key `resolve_transport`
    // short-circuits to env and the empty-link branch would never run.
    config.provider_link_master_key = Some(MASTER_KEY.to_string());
    config.provider = match env_bearer {
        Some(bearer) => ProviderConfig {
            bearer: bearer.to_string(),
            ..ProviderConfig::default()
        },
        None => ProviderConfig::default(),
    };
    config
}

async fn drain(worker: &AgentWorker) -> DrainStats {
    let mut total = DrainStats::default();
    for _ in 0..8 {
        let stats = worker.drain_once().await.expect("drain");
        total.claimed += stats.claimed;
        total.answered += stats.answered;
        total.skipped += stats.skipped;
        total.failed += stats.failed;
        total.delegated += stats.delegated;
        if stats.claimed == 0 {
            break;
        }
    }
    total
}

/// Everything the subscription agent's runtime could ever be handed.
#[derive(Debug, PartialEq, Eq)]
struct SubscriptionReach {
    runs: i64,
    jobs: i64,
    inbox_events: i64,
    claimable_hosted_jobs: usize,
}

async fn subscription_reach(su: &PgPool, t: &Tenant) -> SubscriptionReach {
    let runs: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM agent_run WHERE workspace_id = $1 AND agent_member_id = $2",
    )
    .bind(t.workspace_id)
    .bind(t.subscription_agent_id)
    .fetch_one(su)
    .await
    .unwrap();
    let jobs: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id = $1 AND kind = 'agent_job' \
            AND (partition_key = $2 OR lower(payload->>'agent_member_id') = lower($2::text))",
    )
    .bind(t.workspace_id)
    .bind(t.subscription_agent_id)
    .fetch_one(su)
    .await
    .unwrap();
    let inbox_events: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_agent_inbox_event \
          WHERE workspace_id = $1 AND connection_id = $2",
    )
    .bind(t.workspace_id)
    .bind(t.subscription_connection_id)
    .fetch_one(su)
    .await
    .unwrap();
    // The exact door the owner's CLI would knock on for work.
    let mut tx = su.begin().await.unwrap();
    let claimable = momo_outbox::claim_hosted_gateway_jobs_in_tx(
        &mut tx,
        t.workspace_id,
        t.subscription_agent_id,
        t.subscription_connection_id,
        50,
    )
    .await
    .unwrap()
    .len();
    tx.rollback().await.unwrap();
    SubscriptionReach {
        runs,
        jobs,
        inbox_events,
        claimable_hosted_jobs: claimable,
    }
}

async fn messages_by(su: &PgPool, t: &Tenant, author: Uuid) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT COALESCE(body, '') FROM message \
          WHERE workspace_id = $1 AND channel_id = $2 AND author_member_id = $3 ORDER BY seq",
    )
    .bind(t.workspace_id)
    .bind(t.channel_id)
    .bind(author)
    .fetch_all(su)
    .await
    .unwrap()
}

// ---------------------------------------------------------------------------
// behavioural
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn an_empty_team_link_answers_on_the_team_env_only_and_never_reaches_the_subscription_agent()
{
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let t = seed(&su).await;

    // Positive control: the owner's own plain message IS delivered to the
    // subscription agent's inbox. Without it every zero below could be a dead
    // fixture rather than a boundary.
    send(&su, &t, t.owner_id, "오늘 뭐 할까", false).await;
    let baseline = subscription_reach(&su, &t).await;
    assert_eq!(
        baseline,
        SubscriptionReach {
            runs: 0,
            jobs: 0,
            inbox_events: 1,
            claimable_hosted_jobs: 0
        },
        "the owner's own message must reach the subscription agent (live fixture)"
    );

    // A teammate calls the TEAM agent; its answer mentions the subscription
    // agent, which is the one way a team turn could try to hand work over.
    let provider = Arc::new(MockChatProvider::scripted([(
        "정리해 줘",
        format!("@{SUBSCRIBER} 이거 네 구독으로 이어서 해 줘"),
    )]));
    let worker = AgentWorker::new(
        momo_worker_pool().await,
        provider.clone() as Arc<dyn ChatProvider>,
        worker_config(Some(TEAM_ENV_BEARER)),
    );
    send(
        &su,
        &t,
        t.teammate_id,
        &format!("@{TEAM} 회의록 정리해 줘"),
        true,
    )
    .await;
    let stats = drain(&worker).await;
    assert_eq!(stats.answered, 1, "the team agent answered once: {stats:?}");
    assert_eq!(stats.delegated, 0, "nothing was delegated: {stats:?}");

    // The credential: every model call presented the team env bearer, and the
    // resolver says so too. The chain is empty, so there is nowhere else to go.
    let endpoint = worker.resolve_endpoint().await;
    assert_eq!(endpoint.source, "environment");
    assert_eq!(endpoint.bearer, TEAM_ENV_BEARER);
    let calls = provider.calls();
    assert_eq!(calls.len(), 1, "one team turn, one model call");
    for call in &calls {
        assert_eq!(
            call.bearer, TEAM_ENV_BEARER,
            "a team turn with an empty team link presented a non-team credential"
        );
        assert!(!call.bearer.contains(&t.subscription_token_hex));
        assert!(
            call.account_id.is_none(),
            "no subscription account on a team turn"
        );
    }

    // The team agent's answer is in the channel, and the subscription agent's
    // runtime was handed nothing from the teammate's call or from the answer.
    let answers = messages_by(&su, &t, t.team_agent_id).await;
    assert_eq!(answers.len(), 1, "{answers:?}");
    assert!(answers[0].contains(SUBSCRIBER));
    assert_eq!(
        subscription_reach(&su, &t).await,
        baseline,
        "a team turn reached the owner's subscription agent"
    );
    let skipped: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE workspace_id = $1 \
            AND action = 'agent.mention.skipped' AND subject_member_id = $2",
    )
    .bind(t.workspace_id)
    .bind(t.subscription_agent_id)
    .fetch_one(&su)
    .await
    .unwrap_or(-1);
    assert_eq!(skipped, 1, "the A2A path saw the mention and skipped it");
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn with_no_team_key_the_turn_cannot_answer_and_borrows_nothing() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let t = seed(&su).await;
    send(&su, &t, t.owner_id, "안녕", false).await;
    let baseline = subscription_reach(&su, &t).await;
    assert_eq!(baseline.inbox_events, 1, "live fixture");

    // No team link, no team env key (the shipped placeholder). The owner's own
    // subscription agent is right there, live, in the same channel.
    let provider = Arc::new(MockChatProvider::echo());
    let worker = AgentWorker::new(
        momo_worker_pool().await,
        provider.clone() as Arc<dyn ChatProvider>,
        worker_config(None),
    );
    let (workspace_id, channel_id, team, owner) =
        (t.workspace_id, t.channel_id, t.team_agent_id, t.owner_id);
    with_tenant_tx(&su, workspace_id, move |conn| {
        Box::pin(async move {
            emit_outbox(
                &mut *conn,
                workspace_id,
                OutboxKind::AgentJob,
                "publish",
                &json!({
                    "workspace_id": workspace_id,
                    "channel_id": channel_id,
                    "agent_member_id": team,
                    "author_member_id": owner,
                    "prompt": "첫 인사",
                    "welcome_kind": "opener",
                    "created_from": WELCOME_JOB_CREATED_FROM,
                }),
                Some(team),
            )
            .await
            .map_err(momo_db::DbError::from)?;
            Ok(())
        })
    })
    .await
    .expect("enqueue welcome");
    drain(&worker).await;

    assert!(
        provider.calls().is_empty(),
        "an empty team chain must not reach any model (ADR-0135 D1: no silent fallback): {:?}",
        provider
            .calls()
            .iter()
            .map(|call| call.base_url.clone())
            .collect::<Vec<_>>()
    );
    assert_eq!(
        messages_by(&su, &t, t.team_agent_id).await,
        vec![momo_agent::PROVIDER_REQUIRED_BODY.to_string()],
        "the team agent says it cannot answer — it does not answer by other means"
    );
    assert_eq!(
        subscription_reach(&su, &t).await,
        baseline,
        "the owner's subscription agent was used as a fallback speaker"
    );
}
