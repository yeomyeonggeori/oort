//! ADR-0201 증보 v3 B9 (#4944) — the team AI's usage limits, against a real Postgres.
//!
//! BYOK: the team pays, so the team decides. With no `team_ai_limits` and no env ceiling nothing
//! ever stops a turn; an administrator may switch on a daily token limit and a monthly dollar
//! limit; the env caps are only an operator's ceiling. DB-backed and `#[ignore]`d like its
//! siblings; run against an isolated `pgvector/pgvector:pg18` (the web-search half lives in
//! `team_ai_tools_conformance_pg.rs`, next to the Anthropic-wire harness it needs):
//!
//! ```text
//! DATABASE_URL=postgres://postgres:postgres@127.0.0.1:<port>/<db> \
//!   cargo test -p momo-agent-worker --test team_ai_limits_conformance_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `no_limit_is_the_default_so_a_huge_day_still_calls_the_model` | bring a fixed default back (`for_target`/env: `Some(200_000)`), or read an unset limit as `0` |
//! | `a_limit_that_is_on_stops_the_turn_before_the_model_and_offers_the_hand_off` | judge after the call, drop the `dailyTokens` check, or post the hand-off without the buttons / the team sentence |
//! | `the_monthly_dollar_limit_counts_priced_runs_only` | drop the `monthlyUsd` check, read the ledger's own `cost_micro_usd` (always 0 for the helper) instead of the read-time price, or count an unpriced model's tokens as dollars |
//! | `the_operator_ceiling_beats_the_workspace_value` | let a workspace value win over the env ceiling, or point the administrator at settings when the ceiling bound |
//! | `a_token_cap_of_zero_switches_the_helper_off` | read `0` as "no ceiling" |
//! | `another_workspaces_usage_never_counts` | drop the `workspace_id` / `agent_member_id` predicate of either usage statement |
//! | `the_day_and_the_month_are_utc` | use a rolling 24 h / 30 d window, or a local-time `date_trunc` |

use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use momo_agent::{create_agent_run_in_tx, NewAgentRun, RunTrigger};
use momo_agent_worker::provider::{ChatProvider, MockChatProvider};
use momo_agent_worker::{AgentWorker, DrainStats, WorkerConfig};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::{with_tenant_tx, PgPool};
use momo_messaging::{send_message_in_tx, NewMessage};
use momo_outbox::{emit_outbox, OutboxKind};
use momo_settings::{seal_bearer, upsert_link};
use serde_json::{json, Value};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

const MASTER_KEY: &str = "conformance-4944-master";
const HEAD_URL: &str = "https://team-gw.example/v1";
const HEAD_BEARER: &str = "sk-head-4944-a1b2c3";
/// A model the test prices itself: one micro-dollar per token, in and out.
const PRICED_MODEL: &str = "limit-test-model";
/// A model nobody priced.
const UNPRICED_MODEL: &str = "limit-test-unpriced-model";

// --- harness (the shape of `team_ai_conformance_pg.rs`) -----------------------

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

struct Tenant {
    workspace_id: Uuid,
    owner_id: Uuid,
    member_id: Uuid,
    agent_id: Uuid, // the team AI
    other_agent_id: Uuid,
    channel_id: Uuid,
}

/// A workspace with an owner, a plain member, an unrelated agent, a public channel
/// all four share — and the team AI **provisioned by the shipped function**.
async fn seed(su: &PgPool, pool: &PgPool, switch_on: bool) -> Tenant {
    let t = Tenant {
        workspace_id: Uuid::new_v4(),
        owner_id: Uuid::new_v4(),
        member_id: Uuid::new_v4(),
        agent_id: Uuid::nil(),
        other_agent_id: Uuid::new_v4(),
        channel_id: Uuid::new_v4(),
    };
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(t.workspace_id)
        .bind(t.workspace_id.to_string())
        .execute(su)
        .await
        .expect("workspace");
    for (id, kind, display, role) in [
        (t.owner_id, "human", "성재", "owner"),
        (t.member_id, "human", "민수", "member"),
        (t.other_agent_id, "agent", "그록봇", "member"),
    ] {
        sqlx::query(
            "INSERT INTO member (id, workspace_id, kind, status, display_name, handle) \
             VALUES ($1, $2, $3::member_kind, 'active', $4, $5)",
        )
        .bind(id)
        .bind(t.workspace_id)
        .bind(kind)
        .bind(display)
        .bind(format!("h{}", &id.simple().to_string()[..8]))
        .execute(su)
        .await
        .expect("member");
        sqlx::query(
            "INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ($1, $2, $3::membership_role)",
        )
        .bind(t.workspace_id)
        .bind(id)
        .bind(role)
        .execute(su)
        .await
        .expect("workspace_membership");
    }
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, owner_human_id) \
         VALUES ($1, $2, 'grok', 'https://x.invalid/v1', $3)",
    )
    .bind(t.other_agent_id)
    .bind(t.workspace_id)
    .bind(t.owner_id)
    .execute(su)
    .await
    .expect("other agent");
    sqlx::query("INSERT INTO channel (id, workspace_id, kind, name) VALUES ($1, $2, 'public', $3)")
        .bind(t.channel_id)
        .bind(t.workspace_id)
        .bind(format!("c3835-{}", &t.channel_id.simple().to_string()[..8]))
        .execute(su)
        .await
        .expect("channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(t.channel_id)
        .bind(t.workspace_id)
        .execute(su)
        .await
        .expect("channel_seq");

    // The team AI, provisioned exactly as the settings PATCH does.
    let (workspace_id, owner_id) = (t.workspace_id, t.owner_id);
    let agent_id = with_tenant_tx(pool, workspace_id, move |conn| {
        Box::pin(async move {
            momo_workspace_actions::team_ai::enable_in_tx(conn, workspace_id, owner_id).await
        })
    })
    .await
    .expect("enable the team AI");
    if !switch_on {
        with_tenant_tx(pool, workspace_id, move |conn| {
            Box::pin(async move {
                momo_workspace_actions::team_ai::disable_in_tx(conn, workspace_id, owner_id).await
            })
        })
        .await
        .expect("disable");
    }
    for member in [t.owner_id, t.member_id, agent_id, t.other_agent_id] {
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
    Tenant { agent_id, ..t }
}

async fn seed_link(su: &PgPool, owner: Uuid) {
    let mut conn = su.acquire().await.unwrap();
    let head = seal_bearer(HEAD_BEARER, MASTER_KEY).unwrap();
    upsert_link(&mut conn, HEAD_URL, &head, "external-hermes", owner)
        .await
        .expect("team link");
}

async fn worker_with(
    provider: Arc<dyn ChatProvider>,
    tune: impl FnOnce(&mut WorkerConfig),
) -> AgentWorker {
    let mut config = WorkerConfig::for_target(database_url());
    config.claim_batch_size = 10;
    config.provider_link_master_key = Some(MASTER_KEY.to_string());
    tune(&mut config);
    AgentWorker::new(momo_worker_pool().await, provider, config)
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

async fn run_status(su: &PgPool, run_id: Uuid) -> (String, Value) {
    let row: (String, Option<Value>) =
        sqlx::query_as("SELECT status::text, error FROM agent_run WHERE id = $1")
            .bind(run_id)
            .fetch_one(su)
            .await
            .unwrap();
    (row.0, row.1.unwrap_or(Value::Null))
}

async fn agent_messages(su: &PgPool, t: &Tenant) -> Vec<(String, Option<String>, Value)> {
    sqlx::query_as::<_, (String, Option<String>, Value)>(
        "SELECT type::text, body, props FROM message \
          WHERE workspace_id = $1 AND author_member_id = $2 ORDER BY seq",
    )
    .bind(t.workspace_id)
    .bind(t.agent_id)
    .fetch_all(su)
    .await
    .unwrap()
}

/// A mention of the team AI exactly as the send route freezes it (the shape of
/// `team_ai_conformance_pg.rs::enqueue`, without its thread and earlier-message variants).
async fn enqueue(pool: &PgPool, t: &Tenant, text: &str) -> Uuid {
    let (workspace_id, channel_id, agent, author) =
        (t.workspace_id, t.channel_id, t.agent_id, t.owner_id);
    let text = text.to_string();
    with_tenant_tx(pool, workspace_id, move |conn| {
        let text = text.clone();
        Box::pin(async move {
            let sent = send_message_in_tx(
                conn,
                workspace_id,
                NewMessage::text(channel_id, author, text.clone()),
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
                                  "prompt": text, "depth": 0}),
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
                    "author_member_id": author,
                    "trigger_message_id": sent.message.id,
                    "trigger_message_seq": sent.message.seq,
                    "model": "team-ai-default",
                    "model_source": "instance_default",
                    "prompt": text,
                    "recent_messages": [{
                        "message_id": sent.message.id, "channel_id": channel_id,
                        "seq": sent.message.seq, "author_member_id": author,
                        "author_kind": "human", "author_display": "x",
                        "type": "text", "body": text,
                    }],
                    "enabled_tools": ["workspace_action_propose"],
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

// --- the ledger, the price and the limit, written the way the product writes them ----------

/// When a ledger row is stamped: the instants the UTC day and month turn on (the statements under
/// test read the database's clock the same way, so the edges are exact).
#[derive(Clone, Copy)]
enum At {
    Now,
    DayStart,
    DayStartMinus1s,
    MonthStart,
    MonthStartMinus1s,
}

impl At {
    fn sql(self) -> &'static str {
        match self {
            At::Now => "now()",
            At::DayStart => "(date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')",
            At::DayStartMinus1s => {
                "(date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - interval '1 second')"
            }
            At::MonthStart => "(date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')",
            At::MonthStartMinus1s => {
                "(date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - interval '1 second')"
            }
        }
    }
}

/// One ledger row of the helper. `cost_micro_usd` is the row's own claim (the helper writes 0;
/// the dollar limit must not read it).
async fn ledger(
    su: &PgPool,
    t: &Tenant,
    model: &str,
    prompt: i32,
    completion: i32,
    cost_micro_usd: i64,
    at: At,
) {
    sqlx::query(&format!(
        "INSERT INTO usage_ledger (workspace_id, agent_member_id, channel_id, model, \
                                   prompt_tokens, completion_tokens, cost_micro_usd, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, {})",
        at.sql()
    ))
    .bind(t.workspace_id)
    .bind(t.agent_id)
    .bind(t.channel_id)
    .bind(model)
    .bind(prompt)
    .bind(completion)
    .bind(cost_micro_usd)
    .execute(su)
    .await
    .expect("ledger row");
}

/// Price [`PRICED_MODEL`] for this workspace at one micro-dollar a token, in and out, in effect
/// since long before any row the tests write.
async fn price_the_model(su: &PgPool, workspace_id: Uuid) {
    sqlx::query(
        "INSERT INTO model_pricing (workspace_id, model, currency, input_micro_usd_per_token, \
                                    output_micro_usd_per_token, cache_read_micro_usd_per_token, \
                                    effective_from) \
         VALUES ($1, $2, 'USD', 1, 1, 1, now() - interval '120 days')",
    )
    .bind(workspace_id)
    .bind(PRICED_MODEL)
    .execute(su)
    .await
    .expect("model_pricing row");
}

/// What the administrator's PATCH leaves in the bag (the door itself is tested in `momo-server`).
async fn set_limits(su: &PgPool, workspace_id: Uuid, limits: Value) {
    sqlx::query(
        "UPDATE workspace SET settings = settings || jsonb_build_object('team_ai_limits', $2::jsonb) \
          WHERE id = $1",
    )
    .bind(workspace_id)
    .bind(limits)
    .execute(su)
    .await
    .expect("team_ai_limits");
}

async fn has_limits_key(su: &PgPool, workspace_id: Uuid) -> bool {
    sqlx::query_scalar::<_, bool>("SELECT settings ? 'team_ai_limits' FROM workspace WHERE id = $1")
        .bind(workspace_id)
        .fetch_one(su)
        .await
        .unwrap()
}

/// The helper's last line in the channel: its body and props.
async fn last_line(su: &PgPool, t: &Tenant) -> (String, Value) {
    let (_, body, props) = agent_messages(su, t).await.pop().expect("a line");
    (body.unwrap_or_default(), props)
}

/// Make the seed's second agent a hosted agent the helper's hand-off can name: the 「맡기기」 button
/// needs an active hosted connection and an unpaused profile (`delegation_candidates_in_tx`). Built
/// the way `agent_worker_conformance_pg.rs` builds its active hosted fixture.
async fn make_hand_off_candidate(su: &PgPool, t: &Tenant) {
    let (connection_id, token_id) = (Uuid::new_v4(), Uuid::new_v4());
    sqlx::query(
        "UPDATE agent SET model='hosted-agent', base_url='https://hosted-agent.invalid/disabled', \
           config=jsonb_build_object('execution_mode','hosted_dial_in') \
         WHERE workspace_id=$1 AND member_id=$2",
    )
    .bind(t.workspace_id)
    .bind(t.other_agent_id)
    .execute(su)
    .await
    .expect("seal hosted sentinel");
    sqlx::query(
        "INSERT INTO hosted_agent_connection( \
           id,workspace_id,agent_member_id,status,pairing_challenge_hash,pairing_expires_at, \
           pairing_consumed_at,detected_at,detected_by,approved_scopes,created_by \
         ) VALUES ($1,$2,$3,'detected',digest($4,'sha256'),now()+interval '1 hour', \
           now(),now(),$3,'{}'::text[],$5)",
    )
    .bind(connection_id)
    .bind(t.workspace_id)
    .bind(t.other_agent_id)
    .bind(format!("hand-off-{connection_id}"))
    .bind(t.owner_id)
    .execute(su)
    .await
    .expect("detected hosted connection");
    sqlx::query(
        "WITH inserted AS (INSERT INTO token(id,workspace_id,actor_member_id,kind,token_hash,scopes,label, \
          credential_class,hosted_connection_id,audience,created_by) \
         VALUES ($1,$2,$3,'agent_bearer',digest($6,'sha256'), \
          ARRAY['agent:port:connect'],'hand-off candidate','hosted_active',$4, \
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
    .bind(t.workspace_id)
    .bind(t.other_agent_id)
    .bind(connection_id)
    .bind(t.owner_id)
    .bind(format!("hand-off-token-{token_id}"))
    .execute(su)
    .await
    .expect("activate the hosted fixture");
}

async fn ready(su: &PgPool, pool: &PgPool) -> Tenant {
    let t = seed(su, pool, true).await;
    seed_link(su, t.owner_id).await;
    make_hand_off_candidate(su, &t).await;
    t
}

// --- behaviour -----------------------------------------------------------------------------

/// B9-1: nothing set and nothing in the env is **no limit**. Five million tokens today is twenty-five
/// times the old fixed 200,000 and the helper still answers.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn no_limit_is_the_default_so_a_huge_day_still_calls_the_model() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let pool = momo_worker_pool().await;
    reset_instance(&su).await;
    let t = ready(&su, &pool).await;
    ledger(&su, &t, UNPRICED_MODEL, 4_000_000, 1_000_000, 0, At::Now).await;
    assert!(!has_limits_key(&su, t.workspace_id).await, "nothing set");
    let provider = Arc::new(MockChatProvider::echo());
    let worker = worker_with(provider.clone(), |_| {}).await;
    let run = enqueue(&pool, &t, "오늘 많이 썼는데도 답해요?").await;
    drain(&worker).await;
    assert_eq!(provider.calls().len(), 1, "no limit: the model is called");
    let (status, _) = run_status(&su, run).await;
    assert_eq!(status, "succeeded");
}

/// B9-2: a limit that is on is judged BEFORE the model is asked. At the limit: zero model calls,
/// the team's sentence, and the 「맡기기」 buttons (D5). One token under it: the model is called.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn a_limit_that_is_on_stops_the_turn_before_the_model_and_offers_the_hand_off() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let pool = momo_worker_pool().await;
    reset_instance(&su).await;
    let t = ready(&su, &pool).await;
    set_limits(&su, t.workspace_id, json!({"dailyTokens": 1000})).await;
    ledger(&su, &t, UNPRICED_MODEL, 900, 99, 0, At::Now).await; // 999 of 1000
    let provider = Arc::new(MockChatProvider::echo());
    let worker = worker_with(provider.clone(), |_| {}).await;
    enqueue(&pool, &t, "아직 남았어요?").await;
    drain(&worker).await;
    assert_eq!(
        provider.calls().len(),
        1,
        "anti-vacuity: one token under the limit calls the model"
    );

    ledger(&su, &t, UNPRICED_MODEL, 1, 0, 0, At::Now).await; // now at least 1000
    let run = enqueue(&pool, &t, "이제는요?").await;
    drain(&worker).await;
    assert_eq!(provider.calls().len(), 1, "at the limit: zero model calls");
    let (status, error) = run_status(&su, run).await;
    assert_eq!(
        (status.as_str(), error["code"].as_str()),
        ("failed", Some("over_budget"))
    );
    let (body, props) = last_line(&su, &t).await;
    assert_eq!(
        body,
        "팀이 정한 사용량을 다 썼어요. 관리자가 설정 › AI에서 바꿀 수 있어요."
    );
    assert_eq!(props["kind"], "team_ai.delegate.v1");
    assert_eq!(props["reason"], "over_budget");
    assert_eq!(props["limit"], json!({"source": "team", "window": "day"}));
    let candidates = props["delegate"]["candidates"]
        .as_array()
        .expect("the hand-off buttons");
    assert_eq!(
        candidates.first().map(|c| c["member_id"].clone()),
        Some(json!(t.other_agent_id.to_string())),
        "the 「맡기기」 button is still there"
    );
}

/// B9-2: the monthly dollar limit is the **read-time public price** of the priced runs — not the
/// ledger's own `cost_micro_usd` (the helper writes 0, a self-report can write anything), and not a
/// run on a model nobody priced (counted in tokens, never in dollars).
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn the_monthly_dollar_limit_counts_priced_runs_only() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let pool = momo_worker_pool().await;
    reset_instance(&su).await;
    let t = ready(&su, &pool).await;
    price_the_model(&su, t.workspace_id).await;
    set_limits(&su, t.workspace_id, json!({"monthlyUsd": 5})).await;
    // $4.999999 of priced runs, plus an unpriced model that burned fifty million tokens and whose
    // row CLAIMS ninety-nine dollars: neither moves the dollar count.
    ledger(&su, &t, PRICED_MODEL, 4_000_000, 999_999, 0, At::Now).await;
    ledger(&su, &t, UNPRICED_MODEL, 50_000_000, 0, 99_000_000, At::Now).await;
    let provider = Arc::new(MockChatProvider::echo());
    let worker = worker_with(provider.clone(), |_| {}).await;
    enqueue(&pool, &t, "5달러가 안 됐어요?").await;
    drain(&worker).await;
    assert_eq!(
        provider.calls().len(),
        1,
        "$4.999999 of $5 is under the limit, whatever the unpriced row claims"
    );

    ledger(&su, &t, PRICED_MODEL, 1, 0, 0, At::Now).await; // exactly $5.000000
    let run = enqueue(&pool, &t, "이제는요?").await;
    drain(&worker).await;
    assert_eq!(provider.calls().len(), 1, "at $5: zero model calls");
    let (status, error) = run_status(&su, run).await;
    assert_eq!(
        (status.as_str(), error["code"].as_str()),
        ("failed", Some("over_budget"))
    );
    let (body, props) = last_line(&su, &t).await;
    assert_eq!(
        body,
        "팀이 정한 사용량을 다 썼어요. 관리자가 설정 › AI에서 바꿀 수 있어요."
    );
    assert_eq!(props["limit"], json!({"source": "team", "window": "month"}));
}

/// B9-3: a positive env ceiling holds whatever the workspace set — and says it is the operator's,
/// because the administrator's settings cannot lift it. A workspace value BELOW the ceiling is
/// still the one that binds, and says so.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn the_operator_ceiling_beats_the_workspace_value() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let pool = momo_worker_pool().await;
    reset_instance(&su).await;

    // Roomy workspace (10,000,000), tight ceiling (1,000), 1,000 used: the ceiling stops it.
    let roomy = ready(&su, &pool).await;
    set_limits(&su, roomy.workspace_id, json!({"dailyTokens": 10_000_000})).await;
    ledger(&su, &roomy, UNPRICED_MODEL, 500, 500, 0, At::Now).await;
    let provider = Arc::new(MockChatProvider::echo());
    let ceiling = worker_with(provider.clone(), |c| {
        c.team_ai_daily_token_cap = Some(1_000)
    })
    .await;
    enqueue(&pool, &roomy, "천장이 이기나요?").await;
    drain(&ceiling).await;
    assert_eq!(provider.calls().len(), 0, "the ceiling is not liftable");
    let (body, props) = last_line(&su, &roomy).await;
    assert_eq!(
        body,
        "서버 운영자가 정한 하루 사용량을 다 썼어요. 내일 다시 쓸 수 있어요."
    );
    assert_eq!(
        props["limit"],
        json!({"source": "operator", "window": "day"})
    );

    // Tight workspace (500), roomy ceiling (1,000,000), 600 used: the workspace's own limit binds.
    let tight = ready(&su, &pool).await;
    set_limits(&su, tight.workspace_id, json!({"dailyTokens": 500})).await;
    ledger(&su, &tight, UNPRICED_MODEL, 300, 300, 0, At::Now).await;
    let roomy_ceiling = worker_with(provider.clone(), |c| {
        c.team_ai_daily_token_cap = Some(1_000_000)
    })
    .await;
    enqueue(&pool, &tight, "내 한도가 이기나요?").await;
    drain(&roomy_ceiling).await;
    assert_eq!(provider.calls().len(), 0);
    let (body, props) = last_line(&su, &tight).await;
    assert_eq!(
        body,
        "팀이 정한 사용량을 다 썼어요. 관리자가 설정 › AI에서 바꿀 수 있어요."
    );
    assert_eq!(props["limit"], json!({"source": "team", "window": "day"}));

    // Anti-vacuity: one token under both, the same worker calls the model.
    let under = ready(&su, &pool).await;
    set_limits(&su, under.workspace_id, json!({"dailyTokens": 10_000_000})).await;
    ledger(&su, &under, UNPRICED_MODEL, 500, 499, 0, At::Now).await;
    enqueue(&pool, &under, "아직 남았어요?").await;
    drain(&ceiling).await;
    assert_eq!(provider.calls().len(), 1);
}

/// B9-3: `TEAM_AI_DAILY_TOKEN_CAP=0` is the operator's emergency switch — no model call at all, with
/// nothing used. `TEAM_AI_DAILY_SEARCH_CAP=0` is a different switch (web search only) and does not
/// stop the helper from answering.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn a_token_cap_of_zero_switches_the_helper_off() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let pool = momo_worker_pool().await;
    reset_instance(&su).await;
    let t = ready(&su, &pool).await;
    let provider = Arc::new(MockChatProvider::echo());
    let off = worker_with(provider.clone(), |c| c.team_ai_daily_token_cap = Some(0)).await;
    let run = enqueue(&pool, &t, "켜져 있나요?").await;
    drain(&off).await;
    assert_eq!(provider.calls().len(), 0, "0 = off, with nothing used");
    let (status, error) = run_status(&su, run).await;
    assert_eq!(
        (status.as_str(), error["code"].as_str()),
        ("failed", Some("over_budget"))
    );
    let (body, props) = last_line(&su, &t).await;
    assert_eq!(body, "서버 운영자가 팀 AI를 멈춰 뒀어요.");
    assert_eq!(
        props["limit"],
        json!({"source": "operator", "window": "off"})
    );
    assert_eq!(
        props["delegate"]["candidates"].as_array().map(Vec::len),
        Some(1),
        "the hand-off buttons are still offered"
    );

    let search_off = worker_with(provider.clone(), |c| c.team_ai_daily_search_cap = Some(0)).await;
    enqueue(&pool, &t, "검색만 꺼졌어요").await;
    drain(&search_off).await;
    assert_eq!(
        provider.calls().len(),
        1,
        "a search cap of 0 withholds search; the helper still answers"
    );
}

/// Two workspaces never count each other: B is far over every limit, A is under them, and A is
/// still answered while B is refused. (The worker's role bypasses RLS by design — the statements'
/// own `workspace_id` / `agent_member_id` predicates are the guard.)
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn another_workspaces_usage_never_counts() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let pool = momo_worker_pool().await;
    reset_instance(&su).await;
    let a = ready(&su, &pool).await;
    let b = ready(&su, &pool).await;
    for t in [&a, &b] {
        price_the_model(&su, t.workspace_id).await;
        set_limits(
            &su,
            t.workspace_id,
            json!({"dailyTokens": 1000, "monthlyUsd": 5}),
        )
        .await;
    }
    ledger(&su, &b, PRICED_MODEL, 6_000_000, 0, 0, At::Now).await; // B: 6M tokens, $6
    let provider = Arc::new(MockChatProvider::echo());
    let worker = worker_with(provider.clone(), |_| {}).await;
    let run_a = enqueue(&pool, &a, "A는 남았어요?").await;
    let run_b = enqueue(&pool, &b, "B는요?").await;
    drain(&worker).await;
    assert_eq!(
        provider.calls().len(),
        1,
        "only A reached the model: B's six million tokens are not A's"
    );
    assert_eq!(run_status(&su, run_a).await.0, "succeeded");
    let (status_b, error_b) = run_status(&su, run_b).await;
    assert_eq!(
        (status_b.as_str(), error_b["code"].as_str()),
        ("failed", Some("over_budget"))
    );
}

/// B9-2: the day and the month are UTC. A row one second before 00:00Z is yesterday's and one at
/// 00:00Z is today's; the same for the month's first instant.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn the_day_and_the_month_are_utc() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let pool = momo_worker_pool().await;
    reset_instance(&su).await;

    // Day: 5,000 tokens a second before the day began do not count against 1,000 ...
    let day = ready(&su, &pool).await;
    set_limits(&su, day.workspace_id, json!({"dailyTokens": 1000})).await;
    ledger(&su, &day, UNPRICED_MODEL, 5_000, 0, 0, At::DayStartMinus1s).await;
    let provider = Arc::new(MockChatProvider::echo());
    let worker = worker_with(provider.clone(), |_| {}).await;
    enqueue(&pool, &day, "어제 쓴 건 오늘이 아니에요").await;
    drain(&worker).await;
    assert_eq!(
        provider.calls().len(),
        1,
        "yesterday's last second is not today"
    );
    // ... and 1,000 tokens at the first instant of the day are today's.
    ledger(&su, &day, UNPRICED_MODEL, 1_000, 0, 0, At::DayStart).await;
    enqueue(&pool, &day, "오늘 0시 정각은 오늘이에요").await;
    drain(&worker).await;
    assert_eq!(provider.calls().len(), 1, "00:00:00Z is today: refused");

    // Month: $9 priced a second before the month began does not count against $5 ...
    let month = ready(&su, &pool).await;
    price_the_model(&su, month.workspace_id).await;
    set_limits(&su, month.workspace_id, json!({"monthlyUsd": 5})).await;
    ledger(
        &su,
        &month,
        PRICED_MODEL,
        9_000_000,
        0,
        0,
        At::MonthStartMinus1s,
    )
    .await;
    enqueue(&pool, &month, "지난달 쓴 건 이번 달이 아니에요").await;
    drain(&worker).await;
    assert_eq!(
        provider.calls().len(),
        2,
        "last month's last second is not this month"
    );
    // ... and $5 at the first instant of the month is this month's.
    ledger(&su, &month, PRICED_MODEL, 5_000_000, 0, 0, At::MonthStart).await;
    enqueue(&pool, &month, "이번 달 1일 0시 정각은 이번 달이에요").await;
    drain(&worker).await;
    assert_eq!(
        provider.calls().len(),
        2,
        "the month's first instant counts: refused"
    );
}
