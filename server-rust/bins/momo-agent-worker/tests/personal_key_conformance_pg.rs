//! #3396 — an owner-scoped personal API key (ADR-0147 증보 2026-10-03). The red
//! proofs of the credential boundary, in the pattern of #2882/#2897/#2924:
//!
//! * an `owner_only` agent whose brain is its owner's key answers on that key
//!   and on nothing else — not the team env bearer, not the team link, not a
//!   chain hop, not the 「기본 AI」 row, not another member's key;
//! * a team agent never reaches any personal key, with or without a team key;
//! * a key that is not there (revoked, never issued, unreadable) means no
//!   answer — never a fallback — and a revoke stops the very next turn;
//! * an owner-key agent neither delegates to team agents nor speaks a welcome;
//! * no row the system writes carries the key.
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:<port>/momo \
//!   cargo test -p momo-agent-worker --test personal_key_conformance_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `the_owner_key_door_is_not_the_team_door` | name `personal_provider_link` / `uses_owner_key` / `read_owner_key_for_agent` inside `resolve_transport` |
//! | `an_owner_key_agent_answers_on_its_owners_key_and_nothing_else` | resolve the owner-key transport through `resolve_transport` (env/team link wins); apply the 「기본 AI」 row to an owner-key turn |
//! | `a_team_agent_turn_never_presents_a_personal_key` | let the empty-team-key branch read `personal_provider_link` |
//! | `another_members_agent_never_reaches_a_key_it_does_not_own` | drop `l.owner_member_id = a.owner_human_id` from `read_owner_key_for_agent` |
//! | `revoke_stops_use_on_the_next_turn_and_borrows_nothing` | drop `l.revoked_at IS NULL`; cache the key; fall back to env on `None` |
//! | `an_unreadable_or_non_api_key_credential_refuses` | accept an OAuth envelope in `decrypt_personal_link`; fall back to env on a decrypt error |
//! | `a_key_on_an_operator_exempt_host_or_asked_by_a_non_holder_is_refused` | drop the `host_exempt` refusal in `resolve_owner_key_transport`; drop the caller == holder check in `process` |
//! | `an_owner_key_agent_neither_delegates_nor_welcomes` | drop the `owner_key_agent` guard before `route_a2a_mentions_in_tx`; drop the welcome skip |
//! | `no_row_carries_the_key` | write the provider error unredacted; put the key into an audit detail |

use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use momo_agent::{create_agent_run_in_tx, NewAgentRun, RunTrigger, WELCOME_JOB_CREATED_FROM};
use momo_agent_worker::provider::{ChatProvider, MockChatProvider, ProviderError};
use momo_agent_worker::{AgentWorker, DrainStats, WorkerConfig};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::{with_tenant_tx, PgPool};
use momo_messaging::{send_message_with_mentions_in_tx, NewMessage, SendExtras};
use momo_outbox::{emit_outbox, OutboxKind};
use momo_settings::{
    key_fingerprint, redacted_endpoint_label, seal_bearer, LinkCredential, ProviderConfig,
};
use serde_json::json;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

const MASTER_KEY: &str = "conformance-3396-master";
const TEAM_ENV_BEARER: &str = "sk-team-env-3396-a9f3c1";
const TEAM_LINK_BEARER: &str = "sk-team-link-3396-77d0e2";
const CHAIN_BEARER: &str = "sk-team-chain-3396-5be8aa";
const KEY_M: &str = "sk-personal-M-3396-1c4d9f0a";
const KEY_N: &str = "sk-personal-N-3396-e27b6a13";
const KEY_M2: &str = "sk-personal-M2-3396-0b8f55d4";
const BASE_M: &str = "https://api.m-key.example/v1";
const BASE_N: &str = "https://api.n-key.example/v1";
const TEAM_LINK_BASE: &str = "https://team-link.example/v1";
const CHAIN_BASE: &str = "https://team-chain.example/v1";
const TEAM: &str = "hermes";
const PM_HANDLE: &str = "mbrain";
const PN_HANDLE: &str = "nbrain";

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

/// Retire every worker job this binary did not enqueue (the claim is global) and
/// empty the instance-global team rows.
async fn reset_instance(su: &PgPool) {
    sqlx::query(
        "UPDATE outbox SET status = 'done', processed_at = now() \
          WHERE kind = 'agent_job' AND status IN ('pending', 'processing')",
    )
    .execute(su)
    .await
    .expect("sweep residual agent_jobs");
    // The key fingerprint is unique among active rows instance-wide, so the keys
    // of an earlier test would collide with this one's.
    for table in [
        "provider_default_ai",
        "provider_link_chain",
        "provider_link",
        "personal_provider_link",
    ] {
        sqlx::query(&format!("DELETE FROM {table}"))
            .execute(su)
            .await
            .expect("empty the team rows");
    }
}

struct Tenant {
    workspace_id: Uuid,
    m: Uuid,
    n: Uuid,
    channel_id: Uuid,
    team_agent: Uuid,
    /// M's personal agent (owner_only, uses_owner_key).
    pm: Uuid,
    /// N's personal agent.
    pn: Uuid,
}

async fn seed(su: &PgPool) -> Tenant {
    let t = Tenant {
        workspace_id: Uuid::new_v4(),
        m: Uuid::new_v4(),
        n: Uuid::new_v4(),
        channel_id: Uuid::new_v4(),
        team_agent: Uuid::new_v4(),
        pm: Uuid::new_v4(),
        pn: Uuid::new_v4(),
    };
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(t.workspace_id)
        .bind(t.workspace_id.to_string())
        .execute(su)
        .await
        .expect("workspace");
    for (id, kind, display, handle) in [
        (t.m, "human", "엠", format!("m-{}", t.m.simple())),
        (t.n, "human", "엔", format!("n-{}", t.n.simple())),
        (t.team_agent, "agent", TEAM, TEAM.to_string()),
        (t.pm, "agent", PM_HANDLE, PM_HANDLE.to_string()),
        (t.pn, "agent", PN_HANDLE, PN_HANDLE.to_string()),
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
    // The team agent: workspace scope, the team's key.
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, owner_human_id, \
                            max_concurrent_runs, max_run_steps) \
         VALUES ($1, $2, 'hermes-agent', 'https://gateway.invalid/v1', $3, 4, 50)",
    )
    .bind(t.team_agent)
    .bind(t.workspace_id)
    .bind(t.m)
    .execute(su)
    .await
    .expect("team agent");
    // The personal agents exactly as `mark_agent_owner_key_in_tx` leaves them.
    // `model_source = 'instance_default'` on purpose: if the 「기본 AI」 row were
    // ever applied to an owner-key turn, this is the agent it would reroute.
    for (agent, owner) in [(t.pm, t.m), (t.pn, t.n)] {
        sqlx::query(
            "INSERT INTO agent (member_id, workspace_id, model, model_source, base_url, \
                                owner_human_id, invocation_scope, uses_owner_key, \
                                max_concurrent_runs, max_run_steps) \
             VALUES ($1, $2, 'personal-model', 'instance_default', 'https://personal.invalid/v1', \
                     $3, 'owner_only', true, 4, 50)",
        )
        .bind(agent)
        .bind(t.workspace_id)
        .bind(owner)
        .execute(su)
        .await
        .expect("personal agent");
    }
    for agent in [t.team_agent, t.pm, t.pn] {
        sqlx::query(
            "INSERT INTO agent_profile (agent_member_id, workspace_id, updated_by, paused) \
             VALUES ($1, $2, $3, false)",
        )
        .bind(agent)
        .bind(t.workspace_id)
        .bind(t.m)
        .execute(su)
        .await
        .expect("agent_profile");
    }
    sqlx::query("INSERT INTO channel (id, workspace_id, kind, name) VALUES ($1, $2, 'public', $3)")
        .bind(t.channel_id)
        .bind(t.workspace_id)
        .bind(format!("c3396-{}", &t.channel_id.simple().to_string()[..8]))
        .execute(su)
        .await
        .expect("channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(t.channel_id)
        .bind(t.workspace_id)
        .execute(su)
        .await
        .expect("channel_seq");
    for member in [t.m, t.n, t.team_agent, t.pm, t.pn] {
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

/// Issue a key the way the route does (sealed box + fingerprint), under `master`.
async fn issue_key_under(
    su: &PgPool,
    t: &Tenant,
    owner: Uuid,
    plaintext: &str,
    base_url: &str,
    master: &str,
) -> Uuid {
    let (format, sealed_plaintext) = if plaintext.starts_with("{\"kind\"") {
        ("openai", plaintext.to_string())
    } else {
        (
            "openai",
            LinkCredential::Bearer(plaintext.to_string()).to_sealed_plaintext(),
        )
    };
    let ciphertext = seal_bearer(&sealed_plaintext, master).unwrap();
    sqlx::query_scalar(
        "INSERT INTO personal_provider_link \
           (workspace_id, owner_member_id, format, base_url, bearer_ciphertext, key_fingerprint, issued_by) \
         VALUES ($1, $2, $3, $4, $5, $6, $2) RETURNING id",
    )
    .bind(t.workspace_id)
    .bind(owner)
    .bind(format)
    .bind(base_url)
    .bind(ciphertext)
    .bind(key_fingerprint(plaintext, master))
    .fetch_one(su)
    .await
    .expect("personal key")
}

async fn issue_key(su: &PgPool, t: &Tenant, owner: Uuid, plaintext: &str, base_url: &str) -> Uuid {
    issue_key_under(su, t, owner, plaintext, base_url, MASTER_KEY).await
}

/// The team's own credentials, all of them set: the env bearer (config), the
/// `provider_link`, a chain hop and the 「기본 AI」 row pointing at that hop.
async fn arm_team_credentials(su: &PgPool) {
    let link = seal_bearer(TEAM_LINK_BEARER, MASTER_KEY).unwrap();
    sqlx::query(
        "INSERT INTO provider_link (id, base_url, bearer_ciphertext, mode) \
         VALUES (true, $1, $2, 'external-hermes')",
    )
    .bind(TEAM_LINK_BASE)
    .bind(link)
    .execute(su)
    .await
    .expect("team link");
    let chain = seal_bearer(CHAIN_BEARER, MASTER_KEY).unwrap();
    sqlx::query(
        "INSERT INTO provider_link_chain (position, base_url, bearer_ciphertext, mode) \
         VALUES (1, $1, $2, 'external-hermes')",
    )
    .bind(CHAIN_BASE)
    .bind(chain)
    .execute(su)
    .await
    .expect("chain hop");
    sqlx::query(
        "INSERT INTO provider_default_ai (role, link_position, link_endpoint_label, model_id) \
         VALUES ('team_agent', 1, $1, NULL)",
    )
    .bind(redacted_endpoint_label(CHAIN_BASE))
    .execute(su)
    .await
    .expect("default ai row");
}

fn worker_config(env_bearer: Option<&str>) -> WorkerConfig {
    let mut config = WorkerConfig::for_target(database_url());
    config.claim_batch_size = 10;
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

/// One `agent_job` for `agent`, written the way the send route writes it. With
/// `welcome` the job carries the welcome marker.
async fn job(
    pool: &PgPool,
    t: &Tenant,
    agent: Uuid,
    author: Uuid,
    body: &str,
    welcome: bool,
) -> Uuid {
    let (workspace_id, channel_id) = (t.workspace_id, t.channel_id);
    let body = body.to_string();
    let model = if agent == t.team_agent {
        "hermes-agent"
    } else {
        "personal-model"
    };
    let model_source = if agent == t.team_agent {
        "agent"
    } else {
        "instance_default"
    };
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
                                  "prompt": body, "depth": 0}),
                },
            )
            .await?;
            let mut payload = json!({
                "run_id": created.id,
                "workspace_id": workspace_id,
                "channel_id": channel_id,
                "agent_member_id": agent,
                "author_member_id": author,
                "trigger_message_id": sent.message.id,
                "trigger_message_seq": sent.message.seq,
                "model": model,
                "model_source": model_source,
                "prompt": body,
                "recent_messages": [{
                    "message_id": sent.message.id, "channel_id": channel_id,
                    "seq": sent.message.seq, "author_member_id": author,
                    "author_kind": "human", "author_display": "엠",
                    "type": "text", "body": body,
                }],
                "max_output_tokens": 256,
                "depth": 0,
                "delivery": "worker",
                "created_from": "server.message_send.agent_mention.v0",
            });
            if welcome {
                payload["created_from"] = json!(WELCOME_JOB_CREATED_FROM);
            }
            emit_outbox(
                &mut *conn,
                workspace_id,
                OutboxKind::AgentJob,
                "publish",
                &payload,
                Some(agent),
            )
            .await
            .map_err(momo_db::DbError::from)?;
            Ok(created.id)
        })
    })
    .await
    .expect("job")
}

fn worker_with(provider: &Arc<MockChatProvider>, env: Option<&str>, pool: PgPool) -> AgentWorker {
    AgentWorker::new(
        pool,
        provider.clone() as Arc<dyn ChatProvider>,
        worker_config(env),
    )
}

async fn run_status(su: &PgPool, run: Uuid) -> String {
    sqlx::query_scalar("SELECT status::text FROM agent_run WHERE id = $1")
        .bind(run)
        .fetch_one(su)
        .await
        .unwrap()
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
// structural
// ---------------------------------------------------------------------------

#[test]
fn the_owner_key_door_is_not_the_team_door() {
    let worker = include_str!("../src/lib.rs");
    let from = worker
        .find("pub async fn resolve_endpoint(")
        .expect("resolve_endpoint marker");
    let to = from
        + worker[from..]
            .find("// OAuth refresh + re-seal")
            .expect("end marker");
    let team = &worker[from..to];
    assert!(team.contains("read_link(&mut conn)"), "the team region");
    for fact in [
        "personal_provider_link",
        "uses_owner_key",
        "read_owner_key_for_agent",
        "decrypt_personal_link",
        "resolve_owner_key_transport",
        "OwnerKey",
    ] {
        assert!(
            !team.contains(fact),
            "the team resolver names `{fact}`: a team turn must never be able to reach a personal key"
        );
    }
    // And the owner-key door is its own function, in its own file, that never
    // reaches for a team credential.
    let personal = include_str!("../src/personal.rs");
    let personal = personal.split("#[cfg(test)]").next().unwrap();
    assert!(personal.contains("read_owner_key_for_agent("));
    for team_fact in [
        "read_link(",
        "read_chain(",
        "read_default_ai(",
        "resolve_transport(",
        "config.provider.bearer",
        "env_transport",
    ] {
        assert!(
            !personal.contains(team_fact),
            "the owner-key door reaches for the team credential via `{team_fact}`"
        );
    }
}

// ---------------------------------------------------------------------------
// behavioural
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn an_owner_key_agent_answers_on_its_owners_key_and_nothing_else() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    arm_team_credentials(&su).await;
    let t = seed(&su).await;
    issue_key(&su, &t, t.m, KEY_M, BASE_M).await;
    issue_key(&su, &t, t.n, KEY_N, BASE_N).await;

    let provider = Arc::new(MockChatProvider::echo());
    let worker = worker_with(&provider, Some(TEAM_ENV_BEARER), momo_worker_pool().await);
    let run_m = job(&su, &t, t.pm, t.m, "엠의 일", false).await;
    let run_n = job(&su, &t, t.pn, t.n, "엔의 일", false).await;
    let stats = drain(&worker).await;
    assert_eq!(stats.answered, 2, "{stats:?}");

    let calls = provider.calls();
    assert_eq!(calls.len(), 2, "one call per personal turn");
    let mut by_prompt = calls.iter().map(|call| {
        let user = call
            .messages
            .iter()
            .map(|message| message.content.clone())
            .collect::<Vec<_>>()
            .join("\n");
        (user, call)
    });
    let m_call = by_prompt
        .clone()
        .find(|(text, _)| text.contains("엠의 일"))
        .expect("M's turn")
        .1;
    let n_call = by_prompt
        .find(|(text, _)| text.contains("엔의 일"))
        .expect("N's turn")
        .1;
    assert_eq!(
        (m_call.bearer.as_str(), m_call.base_url.as_str()),
        (KEY_M, BASE_M)
    );
    assert_eq!(
        (n_call.bearer.as_str(), n_call.base_url.as_str()),
        (KEY_N, BASE_N)
    );
    for call in &calls {
        for foreign in [TEAM_ENV_BEARER, TEAM_LINK_BEARER, CHAIN_BEARER] {
            assert_ne!(
                call.bearer, foreign,
                "a personal turn presented a team credential"
            );
        }
        assert!(call.account_id.is_none());
    }
    assert_eq!(run_status(&su, run_m).await, "succeeded");
    assert_eq!(run_status(&su, run_n).await, "succeeded");
    assert_eq!(messages_by(&su, &t, t.pm).await.len(), 1);
    assert_eq!(messages_by(&su, &t, t.pn).await.len(), 1);
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn a_team_agent_turn_never_presents_a_personal_key() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let t = seed(&su).await;
    issue_key(&su, &t, t.m, KEY_M, BASE_M).await;
    issue_key(&su, &t, t.n, KEY_N, BASE_N).await;

    // The team agent, asked by the key's own holder, with only the env bearer.
    let provider = Arc::new(MockChatProvider::echo());
    let worker = worker_with(&provider, Some(TEAM_ENV_BEARER), momo_worker_pool().await);
    job(&su, &t, t.team_agent, t.m, "팀 일", false).await;
    assert_eq!(drain(&worker).await.answered, 1);
    let calls = provider.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].bearer, TEAM_ENV_BEARER, "{calls:?}");

    // No team key at all: the turn cannot answer, and the personal keys sitting
    // in the same workspace are not borrowed (ADR-0135 D1).
    let provider = Arc::new(MockChatProvider::echo());
    let worker = worker_with(&provider, None, momo_worker_pool().await);
    let run = job(&su, &t, t.team_agent, t.m, "또 팀 일", false).await;
    drain(&worker).await;
    assert!(
        provider.calls().is_empty(),
        "a team turn with no team key called a model: {:?}",
        provider
            .calls()
            .iter()
            .map(|c| c.base_url.clone())
            .collect::<Vec<_>>()
    );
    assert_eq!(run_status(&su, run).await, "failed");
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn another_members_agent_never_reaches_a_key_it_does_not_own() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let t = seed(&su).await;
    // Only M has a key. N's personal agent has none.
    issue_key(&su, &t, t.m, KEY_M, BASE_M).await;

    let provider = Arc::new(MockChatProvider::echo());
    let worker = worker_with(&provider, Some(TEAM_ENV_BEARER), momo_worker_pool().await);
    // N asks N's agent; and (the cross-member probe) M asks N's agent.
    let run_n = job(&su, &t, t.pn, t.n, "엔이 엔 에이전트에게", false).await;
    let run_cross = job(&su, &t, t.pn, t.m, "엠이 엔 에이전트에게", false).await;
    drain(&worker).await;
    assert!(
        provider.calls().is_empty(),
        "N's agent ran on a credential: {:?}",
        provider
            .calls()
            .iter()
            .map(|c| c.bearer.len())
            .collect::<Vec<_>>()
    );
    assert_eq!(run_status(&su, run_n).await, "failed");
    assert_eq!(run_status(&su, run_cross).await, "failed");
    let said = messages_by(&su, &t, t.pn).await;
    assert!(
        said.iter().any(|line| line.contains("개인 API 키")),
        "the refusal says why: {said:?}"
    );

    // The same fact in the schema: an owner-only agent's owner and brain are
    // final, so M's key can never be pointed at N's agent by an UPDATE.
    for statement in [
        "UPDATE agent SET owner_human_id = $2 WHERE member_id = $1",
        "UPDATE agent SET uses_owner_key = false WHERE member_id = $1",
        "UPDATE agent SET invocation_scope = 'workspace' WHERE member_id = $1",
    ] {
        let error = sqlx::query(statement)
            .bind(t.pn)
            .bind(t.m)
            .execute(&su)
            .await
            .expect_err(statement);
        assert!(error.to_string().contains("cannot"), "{statement}: {error}");
    }
    // A personal key cannot be moved to another member either.
    let error = sqlx::query("UPDATE personal_provider_link SET owner_member_id = $1")
        .bind(t.n)
        .execute(&su)
        .await
        .expect_err("owner is final");
    assert!(error.to_string().contains("cannot change"), "{error}");
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn revoke_stops_use_on_the_next_turn_and_borrows_nothing() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    arm_team_credentials(&su).await;
    let t = seed(&su).await;
    let key = issue_key(&su, &t, t.m, KEY_M, BASE_M).await;

    let provider = Arc::new(MockChatProvider::echo());
    let worker = worker_with(&provider, Some(TEAM_ENV_BEARER), momo_worker_pool().await);
    job(&su, &t, t.pm, t.m, "첫 번째", false).await;
    assert_eq!(drain(&worker).await.answered, 1);
    assert_eq!(provider.calls().len(), 1);
    assert_eq!(provider.calls()[0].bearer, KEY_M, "positive control");

    // Revoke. The same running worker; the very next turn is refused.
    sqlx::query("UPDATE personal_provider_link SET revoked_at = now(), revoked_by = owner_member_id WHERE id = $1")
        .bind(key)
        .execute(&su)
        .await
        .expect("revoke");
    let run = job(&su, &t, t.pm, t.m, "두 번째", false).await;
    drain(&worker).await;
    assert_eq!(
        provider.calls().len(),
        1,
        "a revoked key (or the team's keys in its place) was used: {:?}",
        provider
            .calls()
            .iter()
            .map(|c| (c.base_url.clone(), c.bearer.len()))
            .collect::<Vec<_>>()
    );
    assert_eq!(run_status(&su, run).await, "failed");
    let audited: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE workspace_id = $1 AND action = 'agent.personal_key.unavailable'",
    )
    .bind(t.workspace_id)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(audited, 1);

    // A re-issue is a new row and works on the next turn.
    issue_key(&su, &t, t.m, KEY_M2, BASE_M).await;
    job(&su, &t, t.pm, t.m, "세 번째", false).await;
    assert_eq!(drain(&worker).await.answered, 1);
    let calls = provider.calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[1].bearer, KEY_M2);
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn an_unreadable_or_non_api_key_credential_refuses() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    arm_team_credentials(&su).await;
    let t = seed(&su).await;
    // M's key sealed under another master key; N's is a subscription grant.
    issue_key_under(&su, &t, t.m, KEY_M, BASE_M, "some-other-master").await;
    let grant = r#"{"kind":"oauth-openai","refresh_token":"r-3396","access_token":"a-3396"}"#;
    issue_key_under(&su, &t, t.n, grant, BASE_N, MASTER_KEY).await;

    let provider = Arc::new(MockChatProvider::echo());
    let worker = worker_with(&provider, Some(TEAM_ENV_BEARER), momo_worker_pool().await);
    let run_m = job(&su, &t, t.pm, t.m, "읽을 수 없는 키", false).await;
    let run_n = job(&su, &t, t.pn, t.n, "구독 토큰", false).await;
    drain(&worker).await;
    assert!(provider.calls().is_empty(), "{:?}", provider.calls().len());
    assert_eq!(run_status(&su, run_m).await, "failed");
    assert_eq!(run_status(&su, run_n).await, "failed");
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn an_owner_key_agent_neither_delegates_nor_welcomes() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let t = seed(&su).await;
    issue_key(&su, &t, t.m, KEY_M, BASE_M).await;

    // M's agent answers by mentioning the team agent.
    let provider = Arc::new(MockChatProvider::scripted([(
        "위임해 줘",
        format!("@{TEAM} 이거 부탁해"),
    )]));
    let worker = worker_with(&provider, Some(TEAM_ENV_BEARER), momo_worker_pool().await);
    job(&su, &t, t.pm, t.m, "위임해 줘", false).await;
    let stats = drain(&worker).await;
    assert_eq!(stats.answered, 1, "{stats:?}");
    assert_eq!(
        stats.delegated, 0,
        "an owner-key answer spawned a team agent"
    );
    let team_runs: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM agent_run WHERE workspace_id = $1 AND agent_member_id = $2",
    )
    .bind(t.workspace_id)
    .bind(t.team_agent)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(team_runs, 0);
    assert_eq!(
        provider.calls().len(),
        1,
        "only the personal turn called a model"
    );

    // A welcome job for the personal agent speaks nothing and calls nothing.
    let before = provider.calls().len();
    job(&su, &t, t.pm, t.m, "환영", true).await;
    drain(&worker).await;
    assert_eq!(provider.calls().len(), before);
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn no_row_carries_the_key() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let t = seed(&su).await;
    issue_key(&su, &t, t.m, KEY_M, BASE_M).await;

    // A provider that echoes the key back in its own error sentence (the 401
    // "invalid key sk-…" shape), then a normal answer.
    let provider = Arc::new(MockChatProvider::failing(ProviderError::HttpStatus(
        401,
        format!("invalid api key {KEY_M}"),
    )));
    let worker = worker_with(&provider, Some(TEAM_ENV_BEARER), momo_worker_pool().await);
    job(&su, &t, t.pm, t.m, "실패하는 턴", false).await;
    drain(&worker).await;
    assert!(
        !provider.calls().is_empty(),
        "the failing turn reached the provider"
    );

    let ciphertext_hex: String = sqlx::query_scalar(
        "SELECT encode(bearer_ciphertext, 'hex') FROM personal_provider_link WHERE workspace_id = $1",
    )
    .bind(t.workspace_id)
    .fetch_one(&su)
    .await
    .unwrap();
    let fingerprint = key_fingerprint(KEY_M, MASTER_KEY);
    for table in [
        "audit_log",
        "message",
        "agent_run",
        "outbox",
        "usage_ledger",
        "agent_job_attempt",
    ] {
        let exists: Option<String> = sqlx::query_scalar("SELECT to_regclass($1)::text")
            .bind(table)
            .fetch_one(&su)
            .await
            .unwrap();
        if exists.is_none() {
            continue;
        }
        // This test's workspace only: the database is shared with other suites.
        let rows: Vec<String> = sqlx::query_scalar(&format!(
            "SELECT row_to_json(x)::text FROM {table} x WHERE workspace_id = $1"
        ))
        .bind(t.workspace_id)
        .fetch_all(&su)
        .await
        .unwrap();
        if table == "agent_run" || table == "message" {
            assert!(!rows.is_empty(), "{table}: nothing to scan (vacuous guard)");
        }
        for row in rows {
            assert!(!row.contains(KEY_M), "{table} carries the key: {row}");
            assert!(
                !row.contains(&fingerprint),
                "{table} carries the fingerprint"
            );
            assert!(
                !row.contains(&ciphertext_hex),
                "{table} carries the sealed box"
            );
        }
    }
}

#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn a_key_on_an_operator_exempt_host_or_asked_by_a_non_holder_is_refused() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    reset_instance(&su).await;
    let t = seed(&su).await;

    // (1) A key whose endpoint is the operator's own provider host: that host is
    // exempt from the connect-time address check, so a key somebody else issued
    // must not ride it. Refused before any call.
    issue_key(
        &su,
        &t,
        t.m,
        KEY_M,
        "https://operator-gw.example:8443/prefix/v1",
    )
    .await;
    let provider = Arc::new(MockChatProvider::echo());
    let mut config = worker_config(Some(TEAM_ENV_BEARER));
    config.egress = momo_settings::EgressPolicy::default()
        .with_operator_base_url("https://operator-gw.example/v1");
    let worker = AgentWorker::new(
        momo_worker_pool().await,
        provider.clone() as Arc<dyn ChatProvider>,
        config,
    );
    let run = job(&su, &t, t.pm, t.m, "운영자 호스트", false).await;
    drain(&worker).await;
    assert!(
        provider.calls().is_empty(),
        "a key aimed at the operator's host was called"
    );
    assert_eq!(run_status(&su, run).await, "failed");

    // (2) The same worker, a key on a public host, but the caller is not the
    // holder (a door that forgot the owner gate): the key is not spent.
    sqlx::query("UPDATE personal_provider_link SET revoked_at = now() WHERE workspace_id = $1")
        .bind(t.workspace_id)
        .execute(&su)
        .await
        .unwrap();
    issue_key(&su, &t, t.m, KEY_M2, BASE_M).await;
    let stranger = job(&su, &t, t.pm, t.n, "엔이 엠의 에이전트를", false).await;
    drain(&worker).await;
    assert!(
        provider.calls().is_empty(),
        "a non-holder's job spent the holder's key"
    );
    assert_eq!(run_status(&su, stranger).await, "failed");
    // Positive control: the holder's own job on the same key is answered.
    job(&su, &t, t.pm, t.m, "엠이 직접", false).await;
    assert_eq!(drain(&worker).await.answered, 1);
    assert_eq!(provider.calls().len(), 1);
    assert_eq!(provider.calls()[0].bearer, KEY_M2);
}
