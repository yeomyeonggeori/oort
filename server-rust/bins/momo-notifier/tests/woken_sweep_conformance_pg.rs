//! ADR-0200 증보 3 (#4284) — the run stall sweep's third rule, `woken_not_collected`,
//! against a real database. The decision itself is the pure `woken_uncollected_verdict`
//! (unit tests in `momo-agent`); this file proves what only a database can: the candidate
//! SQL is a superset of the verdict, the locked re-reads, the cross-tenant joins, and the
//! one transaction that ends the run (ledger, audit, system line, terminal frame, job).
//!
//! Status: WRITTEN AND TYPE-CHECKED, NOT YET RUN (stage 1 of #4284 had no Docker). The
//! second stage runs it:
//!
//! ```text
//! DATABASE_URL=postgres://… (superuser, pgvector/pg18) \
//!   cargo test -p momo-notifier --test woken_sweep_conformance_pg -- --ignored --nocapture --test-threads=1
//! ```
//!
//! Harness contract: `DATABASE_URL` is a **superuser** (migrations, bootstrap roles,
//! fixtures that bypass RLS); the sweep runs as **`momo_notifier`** with its production
//! column grants (ADR-0200 증보 3 E7). The clock is real: a ring row is stamped `now()` by
//! the REAL `record_doorbell_rung_in_tx` (the ledger refuses UPDATE, so a row cannot be
//! aged), so every test uses a 1-second window and waits 2 seconds. The run's own
//! `created_at` IS backdated by the superuser INSERT (the candidate read needs it old).
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `a_woken_uncollected_run_ends_in_one_transaction_with_every_trace` | drop the `WokenNotCollected` arm of the settle path, the line, the audit or the job retire |
//! | `each_protection_keeps_a_woken_run_alive_in_the_database` | drop the matching condition from `woken_uncollected_verdict` or the loader read behind it |
//! | `a_dead_token_does_not_protect_a_run_the_agent_never_collected` | add the token join back (the verdict must not read `token`) |
//! | `the_candidate_read_is_a_superset_of_the_verdict_at_the_boundary` | tighten the candidate read past `created_at <= now() - window` |
//! | `a_ring_row_of_another_workspace_never_wakes_this_workspaces_run` | drop `workspace_id` from the ring/ledger joins |
//! | `a_welcome_run_ends_silently_and_a_work_run_gets_its_line` | judge "welcome" by `trigger IS NULL`, or drop the welcome guard on the line |
//! | `runs_that_are_not_queued_or_have_no_ok_ring_are_left_alone` | drop `status = 'queued'` / the `_ok` ring condition |
//! | `a_hosted_agent_silent_for_days_is_not_handed_the_welcome_opener` (E5) | drop the signal / new-connection clause from `hosted_agent_is_deliverable`, or the two new SELECT columns |

use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::{with_tenant_tx, PgPool};
use momo_messaging::NewMessage;
use momo_outbox::StallPolicy;
use serde_json::json;
use uuid::Uuid;

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL (superuser)")
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect as superuser")
}

async fn notifier_pool() -> PgPool {
    let options: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
    let password = std::env::var("MOMO_NOTIFIER_PASSWORD")
        .unwrap_or_else(|_| "momo_notifier_dev_pw".to_string());
    PgPoolOptions::new()
        .max_connections(4)
        .connect_with(options.username("momo_notifier").password(&password))
        .await
        .expect("connect as momo_notifier (bootstrap_roles.sql first)")
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
        .expect("apply all migrations");
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args([
            "-v",
            "ON_ERROR_STOP=1",
            "--no-psqlrc",
            "--quiet",
            "--single-transaction",
            "-f",
        ])
        .arg(PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../infra/rust/sql/bootstrap_roles.sql"
        )))
        .status()
        .expect("spawn psql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
    *ready = true;
}

/// The sweep is global (every tenant, one batch) and the window is one second, so a
/// sibling test's sweep landing between this test's ring and its assertion would end ITS
/// run. Serialize the tests in-file, so nobody has to remember `--test-threads=1`.
async fn serial() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

const HOSTED_SCOPES: [&str; 6] = [
    "agent:port:connect",
    "agent:inbox:read",
    "messages:read",
    "messages:write",
    "agent:jobs:read",
    "agent:runs:callback",
];

/// One workspace with a human owner, a hosted agent with an ACTIVE connection (a real
/// token row — the sweep must not need it), and a public channel the connection approves.
struct Hosted {
    workspace: Uuid,
    human: Uuid,
    agent: Uuid,
    connection: Uuid,
    channel: Uuid,
}

async fn seed_hosted(pool: &PgPool) -> Hosted {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace(id, slug, name) VALUES($1,$2,$2)")
        .bind(workspace)
        .bind(format!("wk-{}", workspace.simple()))
        .execute(pool)
        .await
        .expect("workspace");
    let human = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) \
         VALUES($1,$2,'human','Owner',$3)",
    )
    .bind(human)
    .bind(workspace)
    .bind(format!("o-{}", human.simple()))
    .execute(pool)
    .await
    .expect("human");
    sqlx::query(
        "INSERT INTO workspace_membership(workspace_id, member_id, role) VALUES($1,$2,'owner')",
    )
    .bind(workspace)
    .bind(human)
    .execute(pool)
    .await
    .expect("owner role");
    let agent = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) \
         VALUES($1,$2,'agent','hosted',$3)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(format!("a-{}", agent.simple()))
    .execute(pool)
    .await
    .expect("agent member");
    sqlx::query(
        "INSERT INTO agent(member_id, workspace_id, model, base_url, owner_human_id, config) \
         VALUES($1,$2,'hosted-agent','https://hosted-agent.invalid/disabled',$3, \
                '{\"execution_mode\":\"hosted_dial_in\"}'::jsonb)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(human)
    .execute(pool)
    .await
    .expect("agent row");
    sqlx::query(
        "INSERT INTO workspace_membership(workspace_id, member_id, role) VALUES($1,$2,'member')",
    )
    .bind(workspace)
    .bind(agent)
    .execute(pool)
    .await
    .expect("agent role");
    let channel = Uuid::new_v4();
    sqlx::query("INSERT INTO channel(id, workspace_id, kind, name) VALUES($1,$2,'public','r')")
        .bind(channel)
        .bind(workspace)
        .execute(pool)
        .await
        .expect("channel");
    sqlx::query("INSERT INTO channel_seq(channel_id, workspace_id, last_seq) VALUES($1,$2,0)")
        .bind(channel)
        .bind(workspace)
        .execute(pool)
        .await
        .expect("channel_seq");
    for member in [human, agent] {
        sqlx::query("INSERT INTO membership(workspace_id, channel_id, member_id) VALUES($1,$2,$3)")
            .bind(workspace)
            .bind(channel)
            .bind(member)
            .execute(pool)
            .await
            .expect("membership");
    }
    let connection = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO hosted_agent_connection( \
           id,workspace_id,agent_member_id,status,pairing_consumed_at,detected_at,detected_by, \
           confirmed_by,confirmed_at,approved_channel_ids,approved_scopes,created_by) \
         VALUES($1,$2,$3,'detected',now(),now(),$4,$4,now(),$5,$6,$4)",
    )
    .bind(connection)
    .bind(workspace)
    .bind(agent)
    .bind(human)
    .bind(vec![channel])
    .bind(
        HOSTED_SCOPES
            .iter()
            .map(|s| (*s).to_string())
            .collect::<Vec<String>>(),
    )
    .execute(pool)
    .await
    .expect("connection");
    let bearer = format!("momo_agent_v1.{workspace}.{}", Uuid::new_v4().simple());
    let token: Uuid = sqlx::query_scalar(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label, \
                           credential_class, hosted_connection_id, audience, created_by) \
         VALUES($1,'agent_bearer',$2,digest($3::text,'sha256'),$4,'h', \
                'hosted_active',$5,'/v1/mcp/agent-port',$6) RETURNING id",
    )
    .bind(workspace)
    .bind(agent)
    .bind(&bearer)
    .bind(
        HOSTED_SCOPES
            .iter()
            .map(|s| (*s).to_string())
            .collect::<Vec<String>>(),
    )
    .bind(connection)
    .bind(human)
    .fetch_one(pool)
    .await
    .expect("token");
    sqlx::query(
        "UPDATE hosted_agent_connection SET status='active', active_token_id=$3, \
           proved_at=now(), proved_by=$4 WHERE workspace_id=$1 AND id=$2",
    )
    .bind(workspace)
    .bind(connection)
    .bind(token)
    .bind(agent)
    .execute(pool)
    .await
    .expect("activate");
    Hosted {
        workspace,
        human,
        agent,
        connection,
        channel,
    }
}

/// Which kind of run to queue.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// A person's mention: has a trigger message.
    Chat,
    /// A person's "work" button: NO trigger message, still a thing a person asked for.
    Work,
    /// The server's own welcome run.
    Welcome,
}

struct Queued {
    run: Uuid,
    trigger: Option<Uuid>,
    job: i64,
}

/// A `queued` run created an hour ago, with its pending delivery job (payload shaped like
/// the real producers': lowercase run id, the channel the connection approves).
async fn queue_run(pool: &PgPool, hosted: &Hosted, kind: Kind) -> Queued {
    let trigger = if kind == Kind::Chat {
        let (workspace, channel, human) = (hosted.workspace, hosted.channel, hosted.human);
        let message = with_tenant_tx(pool, workspace, move |conn| {
            Box::pin(async move {
                let sent = momo_messaging::send_message_in_tx(
                    conn,
                    workspace,
                    NewMessage::text(channel, human, "hello".to_string()),
                )
                .await?;
                Ok(sent.message.id)
            })
        })
        .await
        .expect("trigger message");
        Some(message)
    } else {
        None
    };
    let run = Uuid::new_v4();
    let (input, key) = match kind {
        Kind::Chat => (json!({"type": "chat"}), format!("answer:{run}")),
        Kind::Work => (json!({"type": "work"}), format!("work:{run}")),
        Kind::Welcome => (
            json!({"welcome_kind": "opener"}),
            format!("welcome:{}:{}:opener:v1", hosted.workspace, hosted.human),
        ),
    };
    sqlx::query(
        "INSERT INTO agent_run(id, workspace_id, agent_member_id, channel_id, trigger_message_id, \
                               input, idempotency_key, created_at, updated_at) \
         VALUES($1,$2,$3,$4,$5,$6,$7, now() - interval '1 hour', now() - interval '1 hour')",
    )
    .bind(run)
    .bind(hosted.workspace)
    .bind(hosted.agent)
    .bind(hosted.channel)
    .bind(trigger)
    .bind(input)
    .bind(key)
    .execute(pool)
    .await
    .expect("run");
    let job: i64 = sqlx::query_scalar(
        "INSERT INTO outbox(workspace_id, kind, status, method, payload, partition_key) \
         VALUES($1,'agent_job','pending','gateway', \
                jsonb_build_object('run_id',$2::text,'agent_member_id',$3::text, \
                                   'channel_id',$4::text,'author_member_id',$5::text), $3) \
         RETURNING id",
    )
    .bind(hosted.workspace)
    .bind(run.to_string())
    .bind(hosted.agent)
    .bind(hosted.channel)
    .bind(hosted.human)
    .fetch_one(pool)
    .await
    .expect("job");
    // the sweep's system line takes the next channel sequence like any real send
    sqlx::query(
        "UPDATE channel_seq SET last_seq = COALESCE((SELECT max(seq) FROM message WHERE channel_id = $1), 0) \
          WHERE channel_id = $1",
    )
    .bind(hosted.channel)
    .execute(pool)
    .await
    .expect("channel_seq catch-up");
    Queued { run, trigger, job }
}

/// The doorbell reached the agent: the REAL ledger writer, once.
async fn ring_ok(pool: &PgPool, hosted: &Hosted) {
    let (workspace, connection) = (hosted.workspace, hosted.connection);
    with_tenant_tx(pool, workspace, move |conn| {
        Box::pin(async move {
            momo_webhook::record_doorbell_rung_in_tx(conn, workspace, connection, "leading", true)
                .await
        })
    })
    .await
    .expect("record a ring");
}

/// Liveness facts of the connection, set by a superuser upsert.
async fn set_liveness(pool: &PgPool, hosted: &Hosted, column: &str, value_sql: &str) {
    let sql = format!(
        "INSERT INTO hosted_agent_liveness AS l (workspace_id, connection_id, agent_member_id, {column}) \
         VALUES ($1,$2,$3,{value_sql}) \
         ON CONFLICT (workspace_id, connection_id) DO UPDATE SET {column} = {value_sql}"
    );
    sqlx::query(&sql)
        .bind(hosted.workspace)
        .bind(hosted.connection)
        .bind(hosted.agent)
        .execute(pool)
        .await
        .expect("liveness");
}

fn policy(window_seconds: i64) -> StallPolicy {
    StallPolicy {
        woken_expire_seconds: window_seconds,
        ..StallPolicy::default()
    }
}

/// The real sweep as the production notifier role. Global: other tenants' runs may be
/// swept too, which is why every assertion reads THIS fixture's rows.
async fn sweep(window_seconds: i64) -> momo_notifier::run_stall_sweep::RunStallStats {
    let pool = notifier_pool().await;
    let stats =
        momo_notifier::run_stall_sweep::sweep_stalled_runs(&pool, policy(window_seconds), 500)
            .await
            .expect("the sweep runs as the notifier role without a permission error");
    pool.close().await;
    stats
}

async fn state(pool: &PgPool, run: Uuid) -> (String, Option<String>) {
    sqlx::query_as("SELECT status::text, error->>'code' FROM agent_run WHERE id = $1")
        .bind(run)
        .fetch_one(pool)
        .await
        .expect("run state")
}

/// Let the 1-second window pass. The ring rows are stamped by the database clock.
async fn let_the_window_pass() {
    tokio::time::sleep(Duration::from_millis(2200)).await;
}

async fn count(pool: &PgPool, sql: &str, workspace: Uuid, run: Uuid) -> i64 {
    sqlx::query_scalar(sql)
        .bind(workspace)
        .bind(run)
        .fetch_one(pool)
        .await
        .expect("count")
}

const LINES: &str = "SELECT count(*) FROM message WHERE workspace_id = $1 AND run_id = $2 \
                       AND props->>'kind' = 'agent_run_timed_out'";
const AUDIT: &str = "SELECT count(*) FROM audit_log WHERE workspace_id = $1 AND run_id = $2 \
                       AND action = 'agent.run.stalled'";
const LEDGER_ENDS: &str = "SELECT count(*) FROM agent_run_event WHERE workspace_id = $1 \
                             AND run_id = $2 AND kind = 'timed_out' AND code = 'woken_not_collected'";
const TERMINAL_FRAMES: &str = "SELECT count(*) FROM outbox WHERE workspace_id = $1 \
                                 AND kind = 'broadcast' \
                                 AND payload->>'idempotency_key' LIKE '%:agent_status:%:terminal' \
                                 AND upper(payload->>'idempotency_key') LIKE '%' || upper($2::text) || '%'";

// ---------------------------------------------------------------------------------------

/// Acceptance 1, 11 (the cause is a silent site, not "off"), 14.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn a_woken_uncollected_run_ends_in_one_transaction_with_every_trace() {
    let _guard = serial().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let hosted = seed_hosted(&su).await;
    let queued = queue_run(&su, &hosted, Kind::Chat).await;
    ring_ok(&su, &hosted).await;
    // the agent pings `idle` (the incident): alive, never collecting
    set_liveness(&su, &hosted, "last_ping_at", "now()").await;
    let_the_window_pass().await;

    let stats = sweep(1).await;
    assert!(stats.woken_not_collected >= 1, "{stats:?}");
    assert_eq!(
        state(&su, queued.run).await,
        ("timed_out".into(), Some("woken_not_collected".into()))
    );
    assert_eq!(
        count(&su, LEDGER_ENDS, hosted.workspace, queued.run).await,
        1,
        "ledger"
    );
    assert_eq!(
        count(&su, AUDIT, hosted.workspace, queued.run).await,
        1,
        "audit"
    );
    assert_eq!(
        count(&su, LINES, hosted.workspace, queued.run).await,
        1,
        "channel line"
    );
    assert_eq!(
        count(&su, TERMINAL_FRAMES, hosted.workspace, queued.run).await,
        1,
        "terminal frame"
    );
    let body: String = sqlx::query_scalar(
        "SELECT body FROM message WHERE workspace_id=$1 AND run_id=$2 \
           AND props->>'kind'='agent_run_timed_out'",
    )
    .bind(hosted.workspace)
    .bind(queued.run)
    .fetch_one(&su)
    .await
    .unwrap();
    assert!(body.contains("가져가지 않아"), "{body}");
    // acceptance 14: the line answers the trigger; its client_msg_id is not the run id
    let (answers, client_msg_id): (Option<String>, Option<Uuid>) = sqlx::query_as(
        "SELECT props->>'answers_message_id', client_msg_id FROM message \
          WHERE workspace_id=$1 AND run_id=$2 AND props->>'kind'='agent_run_timed_out'",
    )
    .bind(hosted.workspace)
    .bind(queued.run)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(answers, queued.trigger.map(|id| id.to_string()));
    assert_ne!(client_msg_id, Some(queued.run));
    let job_status: String = sqlx::query_scalar("SELECT status FROM outbox WHERE id = $1")
        .bind(queued.job)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(job_status, "done", "the delivery job is retired");
}

/// Arrange one protection AFTER the run and the ring exist.
async fn arrange(su: &PgPool, h: &Hosted, name: &str) {
    match name {
        "the agent read its inbox after the ring" => {
            set_liveness(su, h, "last_inbox_read_at", "now() + interval '1 second'").await
        }
        "a run event after the ring" => {
            set_liveness(su, h, "last_run_event_at", "now() + interval '1 second'").await
        }
        "oort refused the agent after the ring" => {
            set_liveness(su, h, "last_tool_error_at", "now() + interval '1 second'").await
        }
        "a working ping after the ring" => {
            set_liveness(su, h, "last_ping_state", "'working'").await;
            set_liveness(su, h, "last_ping_at", "now() + interval '1 second'").await
        }
        "the connection is no longer active" => {
            sqlx::query(
                "UPDATE hosted_agent_connection SET status='disconnected' \
                  WHERE workspace_id=$1 AND id=$2",
            )
            .bind(h.workspace)
            .bind(h.connection)
            .execute(su)
            .await
            .expect("disconnect");
        }
        "the connection no longer approves the channel" => {
            sqlx::query(
                "UPDATE hosted_agent_connection SET approved_channel_ids='{}' \
                  WHERE workspace_id=$1 AND id=$2",
            )
            .bind(h.workspace)
            .bind(h.connection)
            .execute(su)
            .await
            .expect("unapprove");
        }
        "the connection lost the jobs scope" => {
            sqlx::query(
                "UPDATE hosted_agent_connection \
                    SET approved_scopes=ARRAY['agent:port:connect','agent:inbox:read']::text[] \
                  WHERE workspace_id=$1 AND id=$2",
            )
            .bind(h.workspace)
            .bind(h.connection)
            .execute(su)
            .await
            .expect("scopes");
        }
        "the agent holds a live lease on another run's job" => {
            let other = Uuid::new_v4();
            sqlx::query(
                "INSERT INTO agent_run(id, workspace_id, agent_member_id, channel_id, \
                                       idempotency_key, status) \
                 VALUES($1,$2,$3,$4,$5,'running')",
            )
            .bind(other)
            .bind(h.workspace)
            .bind(h.agent)
            .bind(h.channel)
            .bind(format!("t:{other}"))
            .execute(su)
            .await
            .expect("other run");
            sqlx::query(
                "INSERT INTO outbox(workspace_id, kind, status, method, payload, partition_key, \
                                    lease_owner, lease_acquired_at, lease_expires_at) \
                 VALUES($1,'agent_job','pending','gateway', \
                        jsonb_build_object('run_id',$2::text,'agent_member_id',$3::text), $3, \
                        uuidv7(), now(), now() + interval '10 minutes')",
            )
            .bind(h.workspace)
            .bind(other.to_string())
            .bind(h.agent)
            .execute(su)
            .await
            .expect("other live lease");
        }
        other => panic!("unknown protection case {other}"),
    }
}

/// Acceptance 2: each protection, one agent per case so the connection facts never mix.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn each_protection_keeps_a_woken_run_alive_in_the_database() {
    let _guard = serial().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let cases = [
        "the agent read its inbox after the ring",
        "a run event after the ring",
        "oort refused the agent after the ring",
        "a working ping after the ring",
        "the connection is no longer active",
        "the connection no longer approves the channel",
        "the connection lost the jobs scope",
        "the agent holds a live lease on another run's job",
    ];
    for name in cases {
        let hosted = seed_hosted(&su).await;
        let queued = queue_run(&su, &hosted, Kind::Chat).await;
        ring_ok(&su, &hosted).await;
        arrange(&su, &hosted, name).await;
        let_the_window_pass().await;
        sweep(1).await;
        let (status, code) = state(&su, queued.run).await;
        assert!(
            !(status == "timed_out" && code.as_deref() == Some("woken_not_collected")),
            "RED: `{name}` must keep the run alive, but it was ended as woken_not_collected"
        );
    }
}

/// Acceptance 2, the negative controls: facts that do NOT protect. A run whose token is
/// dead, or whose other job's lease EXPIRED (the `lease_owner` stays on the row, no reaper),
/// is still ended.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn a_dead_token_does_not_protect_a_run_the_agent_never_collected() {
    let _guard = serial().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let hosted = seed_hosted(&su).await;
    let queued = queue_run(&su, &hosted, Kind::Chat).await;
    // the OAuth access token expired: the agent's own fact
    sqlx::query(
        "UPDATE token SET revoked_at = now() WHERE workspace_id=$1 AND hosted_connection_id=$2",
    )
    .bind(hosted.workspace)
    .bind(hosted.connection)
    .execute(&su)
    .await
    .expect("revoke the token");
    // another run's job with an EXPIRED lease still carries `lease_owner`
    let other = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run(id, workspace_id, agent_member_id, channel_id, idempotency_key, status) \
         VALUES($1,$2,$3,$4,$5,'running')",
    )
    .bind(other)
    .bind(hosted.workspace)
    .bind(hosted.agent)
    .bind(hosted.channel)
    .bind(format!("t:{other}"))
    .execute(&su)
    .await
    .expect("other run");
    sqlx::query(
        "INSERT INTO outbox(workspace_id, kind, status, method, payload, partition_key, \
                            lease_owner, lease_acquired_at, lease_expires_at) \
         VALUES($1,'agent_job','pending','gateway', \
                jsonb_build_object('run_id',$2::text,'agent_member_id',$3::text), $3, \
                uuidv7(), now() - interval '3 hours', now() - interval '2 hours')",
    )
    .bind(hosted.workspace)
    .bind(other.to_string())
    .bind(hosted.agent)
    .execute(&su)
    .await
    .expect("expired lease");
    ring_ok(&su, &hosted).await;
    let_the_window_pass().await;
    sweep(1).await;
    assert_eq!(
        state(&su, queued.run).await,
        ("timed_out".into(), Some("woken_not_collected".into())),
        "RED: a dead token or an expired lease must not read as protection"
    );
}

/// Acceptance 9: every input the verdict accepts is a candidate. With the run created
/// exactly the window ago and ONE ring row, a longer window must NOT end it and a window
/// that has passed must.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn the_candidate_read_is_a_superset_of_the_verdict_at_the_boundary() {
    let _guard = serial().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let hosted = seed_hosted(&su).await;
    let queued = queue_run(&su, &hosted, Kind::Chat).await;
    ring_ok(&su, &hosted).await;
    // a person woke the agent again (moves T later than the ring): the run is created an
    // hour ago, so the candidate read still lists it and the verdict says "not yet"
    sqlx::query(
        "INSERT INTO hosted_agent_doorbell_ring(workspace_id, connection_id, requested_by) \
         VALUES($1,$2,$3)",
    )
    .bind(hosted.workspace)
    .bind(hosted.connection)
    .bind(hosted.human)
    .execute(&su)
    .await
    .expect("manual ring");
    let_the_window_pass().await;
    sweep(1800).await;
    assert_eq!(
        state(&su, queued.run).await.0,
        "queued",
        "29 minutes short: alive"
    );
    sweep(1).await;
    assert_eq!(
        state(&su, queued.run).await,
        ("timed_out".into(), Some("woken_not_collected".into())),
        "RED: the candidate read dropped a run the verdict accepts"
    );
}

/// Acceptance 12: the ledger has no foreign key (migration 128), so another workspace can
/// carry a ring row with this run's id. It must not wake this workspace's run.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn a_ring_row_of_another_workspace_never_wakes_this_workspaces_run() {
    let _guard = serial().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let hosted = seed_hosted(&su).await;
    let other = seed_hosted(&su).await;
    let queued = queue_run(&su, &hosted, Kind::Chat).await;
    // NO ring in the run's own workspace; one `_ok` ring in the other, same run id
    sqlx::query(
        "INSERT INTO agent_run_event(workspace_id, run_id, kind, code) \
         VALUES($1,$2,'doorbell_rung','leading_ok')",
    )
    .bind(other.workspace)
    .bind(queued.run)
    .execute(&su)
    .await
    .expect("foreign ring row (the ledger has no FK)");
    let_the_window_pass().await;
    sweep(1).await;
    assert_eq!(
        state(&su, queued.run).await.0,
        "queued",
        "RED: another workspace's ring row woke this run"
    );
}

/// Acceptance 6: the welcome discriminator is the run's own marker; a Work run has no
/// trigger either and is a thing a person asked for.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn a_welcome_run_ends_silently_and_a_work_run_gets_its_line() {
    let _guard = serial().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let welcome_host = seed_hosted(&su).await;
    let welcome = queue_run(&su, &welcome_host, Kind::Welcome).await;
    ring_ok(&su, &welcome_host).await;
    let work_host = seed_hosted(&su).await;
    let work = queue_run(&su, &work_host, Kind::Work).await;
    ring_ok(&su, &work_host).await;
    let_the_window_pass().await;
    sweep(1).await;

    for run in [&welcome, &work] {
        assert_eq!(
            state(&su, run.run).await,
            ("timed_out".into(), Some("woken_not_collected".into()))
        );
    }
    // welcome: ended, nothing said, no badge to clear (never claimed → no terminal frame)
    assert_eq!(
        count(&su, LINES, welcome_host.workspace, welcome.run).await,
        0
    );
    assert_eq!(
        count(&su, TERMINAL_FRAMES, welcome_host.workspace, welcome.run).await,
        0
    );
    assert_eq!(
        count(&su, AUDIT, welcome_host.workspace, welcome.run).await,
        1,
        "still audited"
    );
    assert_eq!(
        count(&su, LEDGER_ENDS, welcome_host.workspace, welcome.run).await,
        1
    );
    // work: no trigger, but a person asked — the line and the frame are there
    assert!(work.trigger.is_none());
    assert_eq!(count(&su, LINES, work_host.workspace, work.run).await, 1);
    assert_eq!(
        count(&su, TERMINAL_FRAMES, work_host.workspace, work.run).await,
        1
    );
}

/// Acceptance 8: runs the rule must not touch, each lacking exactly one thing.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn runs_that_are_not_queued_or_have_no_ok_ring_are_left_alone() {
    let _guard = serial().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;

    // no ring at all (no doorbell, or it never rang)
    let quiet = seed_hosted(&su).await;
    let no_ring = queue_run(&su, &quiet, Kind::Chat).await;

    // only a FAILED ring (`_failed` is not a wake)
    let failed = seed_hosted(&su).await;
    let failed_ring = queue_run(&su, &failed, Kind::Chat).await;
    let (workspace, connection) = (failed.workspace, failed.connection);
    with_tenant_tx(&su, workspace, move |conn| {
        Box::pin(async move {
            momo_webhook::record_doorbell_rung_in_tx(conn, workspace, connection, "leading", false)
                .await
        })
    })
    .await
    .expect("a failed ring");

    // rung, but the run is already running / awaiting approval
    let running_host = seed_hosted(&su).await;
    let running = queue_run(&su, &running_host, Kind::Chat).await;
    ring_ok(&su, &running_host).await;
    sqlx::query("UPDATE agent_run SET status='running' WHERE id=$1")
        .bind(running.run)
        .execute(&su)
        .await
        .expect("running");
    let parked_host = seed_hosted(&su).await;
    let parked = queue_run(&su, &parked_host, Kind::Chat).await;
    ring_ok(&su, &parked_host).await;
    sqlx::query("UPDATE agent_run SET status='awaiting_approval' WHERE id=$1")
        .bind(parked.run)
        .execute(&su)
        .await
        .expect("parked");

    let_the_window_pass().await;
    sweep(1).await;
    for (what, run) in [
        ("no ring", no_ring.run),
        ("only a failed ring", failed_ring.run),
    ] {
        assert_eq!(
            state(&su, run).await.0,
            "queued",
            "RED: `{what}` must be left alone"
        );
    }
    assert_eq!(state(&su, running.run).await.0, "running");
    assert_eq!(state(&su, parked.run).await.0, "awaiting_approval");
}

/// ADR-0200 증보 3 E5 (acceptance 7): the 10-23 incident — a hosted agent whose last work
/// signal is days old and whose connection was activated two weeks ago — is NOT handed the
/// welcome opener; a connection that just became active (no signal yet) and an agent that
/// read its inbox ten minutes ago are. The pure decision is unit-tested in `momo-agent`;
/// this proves the two new SELECT columns answer it. (A designated agent that fails the
/// check yielding no opener rather than the next candidate is the unchanged `welcome.rs`
/// early return and is covered by the existing welcome conformance, not repeated here.)
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn a_hosted_agent_silent_for_days_is_not_handed_the_welcome_opener() {
    let _guard = serial().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let hosted = seed_hosted(&su).await;
    // the welcome speaks in #general: both the person and the agent are in it
    let general = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel(id, workspace_id, kind, name) VALUES($1,$2,'public','general')",
    )
    .bind(general)
    .bind(hosted.workspace)
    .execute(&su)
    .await
    .expect("#general");
    sqlx::query("INSERT INTO channel_seq(channel_id, workspace_id, last_seq) VALUES($1,$2,0)")
        .bind(general)
        .bind(hosted.workspace)
        .execute(&su)
        .await
        .expect("#general seq");
    for member in [hosted.human, hosted.agent] {
        sqlx::query("INSERT INTO membership(workspace_id, channel_id, member_id) VALUES($1,$2,$3)")
            .bind(hosted.workspace)
            .bind(general)
            .bind(member)
            .execute(&su)
            .await
            .expect("#general membership");
    }
    sqlx::query(
        "UPDATE hosted_agent_connection SET approved_channel_ids = approved_channel_ids || $3::uuid \
          WHERE workspace_id = $1 AND id = $2",
    )
    .bind(hosted.workspace)
    .bind(hosted.connection)
    .bind(general)
    .execute(&su)
    .await
    .expect("approve #general");

    async fn target(su: &PgPool, hosted: &Hosted) -> Option<Uuid> {
        let (workspace, human) = (hosted.workspace, hosted.human);
        with_tenant_tx(su, workspace, move |conn| {
            Box::pin(async move {
                let found = momo_agent::resolve_welcome_target_in_tx(
                    conn, workspace, true, None, human, false, false,
                )
                .await?;
                Ok(found.map(|target| target.agent_member_id))
            })
        })
        .await
        .expect("resolve the welcome target")
    }

    // the incident: activated 14 days ago, last read 4 days ago, last claim 5 days ago
    sqlx::query(
        "UPDATE hosted_agent_connection SET proved_at = now() - interval '14 days' \
          WHERE workspace_id = $1 AND id = $2",
    )
    .bind(hosted.workspace)
    .bind(hosted.connection)
    .execute(&su)
    .await
    .expect("old activation");
    set_liveness(
        &su,
        &hosted,
        "last_inbox_read_at",
        "now() - interval '4 days'",
    )
    .await;
    set_liveness(&su, &hosted, "last_claim_at", "now() - interval '5 days'").await;
    assert_eq!(
        target(&su, &hosted).await,
        None,
        "RED: a hosted agent silent for days was handed the welcome opener"
    );

    // an agent that reads its inbox every 15 minutes
    set_liveness(
        &su,
        &hosted,
        "last_inbox_read_at",
        "now() - interval '10 minutes'",
    )
    .await;
    assert_eq!(target(&su, &hosted).await, Some(hosted.agent));

    // a connection that just became active, with no signal at all yet
    sqlx::query("DELETE FROM hosted_agent_liveness WHERE workspace_id = $1 AND connection_id = $2")
        .bind(hosted.workspace)
        .bind(hosted.connection)
        .execute(&su)
        .await
        .expect("no liveness row");
    sqlx::query(
        "UPDATE hosted_agent_connection SET proved_at = now() WHERE workspace_id = $1 AND id = $2",
    )
    .bind(hosted.workspace)
    .bind(hosted.connection)
    .execute(&su)
    .await
    .expect("fresh activation");
    assert_eq!(
        target(&su, &hosted).await,
        Some(hosted.agent),
        "RED: the new-connection exception (ADR-0185 D-C c2) was lost"
    );
}
