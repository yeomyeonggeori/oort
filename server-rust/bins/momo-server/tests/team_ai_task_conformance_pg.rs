//! ADR-0201 증보 v3 B5 (#4967 S4) — the team AI's task mode, **api half**, against a real Postgres
//! and the real Axum router on a `momo_app` (NOBYPASSRLS) pool:
//!
//! | test | acceptance | goes red if |
//! |---|---|---|
//! | `s1_a_work_request_aimed_at_the_helper_is_a_409_and_writes_nothing` | B5-10, B15-A5 | the `agent_runs::create` check is dropped (the run is created and silently closed again) |
//! | `s2_the_409_is_the_helpers_alone` | B5-10 | the check refuses every agent, or the wrong id |
//! | `s3_a_stop_by_any_member_of_the_room_ends_the_task_and_retires_its_job` | B5-8, B15-A8, B13-I7 | `cancel_run_in_tx` stops ending the task, or the cancel stops retiring the pending step job |
//!
//! The worker half (steps, claims, bounds, requester, the ledger, the sweep, the table's isolation) is
//! `momo-agent-worker/tests/team_ai_task_conformance_pg.rs`.
//!
//! Isolated database only:
//!
//! ```text
//! DATABASE_URL=postgres://postgres:postgres@127.0.0.1:<port>/<db> PGHOST=127.0.0.1 PGPORT=<port> \
//!   PGDATABASE=<db> PGUSER=postgres PGPASSWORD=postgres \
//!   cargo test -p momo-server --test team_ai_task_conformance_pg -- --ignored --test-threads=1
//! ```

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_agent::{create_agent_run_in_tx, NewAgentRun, RunTrigger};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::{with_tenant_tx, PgPool};
use momo_messaging::{send_message_in_tx, NewMessage};
use momo_outbox::{emit_outbox, OutboxKind};
use momo_server::config::{
    AgentGatewayMode, AgentGatewaySettings, AgentPortConfig, SettingsConfig,
};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "team-ai-task-pg-conformance-signing-secret";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to an isolated PostgreSQL 18 URL")
}

fn required_pg_env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("set {name} for the psql bootstrap"))
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect as superuser")
}

async fn momo_app_pool() -> PgPool {
    let options: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
    PgPoolOptions::new()
        .max_connections(16)
        .connect_with(options.username("momo_app").password(
            &std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string()),
        ))
        .await
        .expect("connect as momo_app after bootstrap_roles.sql")
}

fn resolve_psql() -> PathBuf {
    if let Some(paths) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&paths) {
            let candidate = directory.join("psql");
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

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().expect("schema setup mutex is healthy");
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
        .args([
            "-h",
            &required_pg_env("PGHOST"),
            "-p",
            &required_pg_env("PGPORT"),
            "-U",
            &required_pg_env("PGUSER"),
            "-d",
        ])
        .arg(required_pg_env("PGDATABASE"))
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(roles)
        .env("PGPASSWORD", required_pg_env("PGPASSWORD"))
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
    *ready = true;
}

/// The real router, the managed gateway on (a work run needs one), on a `momo_app` pool.
async fn start_server(pool: PgPool) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_settings(SettingsConfig::default())
    .with_agent_gateway(AgentGatewaySettings {
        mode: AgentGatewayMode::Gateway,
        secret: "team-ai-task-conformance-gateway-secret".to_string(),
        allow_legacy_secret: false,
    })
    .with_agent_port(AgentPortConfig {
        external_origin: None,
        window_seconds: 60,
        per_token_limit: 0,
        per_agent_limit: 0,
        per_ip_limit: 0,
        hosted_delivery_enabled: true,
        subscription_agents_enabled: true,
        claude_subscription_agents_enabled: true,
        hosted_lease_seconds: momo_outbox::HOSTED_LEASE_SECONDS_DEFAULT,
        oauth: Default::default(),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind conformance server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            build_app(state).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    format!("http://{address}")
}

async fn seed_human(su: &PgPool, workspace: Uuid, role: &str, handle: &str) -> (Uuid, String) {
    let human = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) \
         VALUES($1,$2,'human'::member_kind,$3,$3)",
    )
    .bind(human)
    .bind(workspace)
    .bind(handle)
    .execute(su)
    .await
    .expect("seed member");
    sqlx::query(
        "INSERT INTO human(member_id, workspace_id, email, email_verified) VALUES($1,$2,$3,true)",
    )
    .bind(human)
    .bind(workspace)
    .bind(format!("{human}@team-ai-task.test"))
    .execute(su)
    .await
    .expect("seed human identity");
    sqlx::query(
        "INSERT INTO workspace_membership(workspace_id, member_id, role) VALUES($1,$2,$3::membership_role)",
    )
    .bind(workspace)
    .bind(human)
    .bind(role)
    .execute(su)
    .await
    .expect("seed human membership");
    let jwt = momo_auth::sign_access(human, workspace, &[], TEST_JWT_SECRET)
        .expect("sign a human App JWT")
        .token;
    sqlx::query(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label) \
         VALUES($1,'session',$2,digest($3::text,'sha256'),ARRAY[]::text[],'team-ai-task')",
    )
    .bind(workspace)
    .bind(human)
    .bind(&jwt)
    .execute(su)
    .await
    .expect("record the human session token");
    (human, jwt)
}

struct Fixture {
    workspace: Uuid,
    channel: Uuid,
    /// The person who asked, and another member of the room.
    requester: Uuid,
    requester_jwt: String,
    bystander_jwt: String,
    /// A workspace member who is not in the room.
    outsider_jwt: String,
    helper: Uuid,
    other_agent: Uuid,
}

async fn seed(su: &PgPool, app: &PgPool) -> Fixture {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace(id, slug, name) VALUES($1,$2,$2)")
        .bind(workspace)
        .bind(workspace.to_string())
        .execute(su)
        .await
        .expect("workspace");
    let (requester, requester_jwt) = seed_human(su, workspace, "owner", "asker").await;
    let (bystander, bystander_jwt) = seed_human(su, workspace, "member", "bystander").await;
    let (_outsider, outsider_jwt) = seed_human(su, workspace, "member", "outsider").await;
    let other_agent = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id, workspace_id, kind, display_name, handle) \
         VALUES($1,$2,'agent'::member_kind,'그록봇','grokbot')",
    )
    .bind(other_agent)
    .bind(workspace)
    .execute(su)
    .await
    .expect("other agent member");
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, owner_human_id) \
         VALUES ($1, $2, 'grok', 'https://x.invalid/v1', $3)",
    )
    .bind(other_agent)
    .bind(workspace)
    .bind(requester)
    .execute(su)
    .await
    .expect("other agent");
    let channel = Uuid::new_v4();
    sqlx::query("INSERT INTO channel(id, workspace_id, kind, name) VALUES($1,$2,'public',$3)")
        .bind(channel)
        .bind(workspace)
        .bind(format!("c4967-{}", &channel.simple().to_string()[..8]))
        .execute(su)
        .await
        .expect("channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel)
        .bind(workspace)
        .execute(su)
        .await
        .expect("channel_seq");
    let helper = with_tenant_tx(app, workspace, move |conn| {
        Box::pin(async move {
            momo_workspace_actions::team_ai::enable_in_tx(conn, workspace, requester).await
        })
    })
    .await
    .expect("enable the team AI");
    for member in [requester, bystander, helper, other_agent] {
        sqlx::query("INSERT INTO membership(workspace_id, channel_id, member_id) VALUES($1,$2,$3)")
            .bind(workspace)
            .bind(channel)
            .bind(member)
            .execute(su)
            .await
            .expect("membership");
    }
    Fixture {
        workspace,
        channel,
        requester,
        requester_jwt,
        bystander_jwt,
        outsider_jwt,
        helper,
        other_agent,
    }
}

async fn count(su: &PgPool, sql: &str, f: &Fixture) -> i64 {
    sqlx::query_scalar(sql)
        .bind(f.workspace)
        .fetch_one(su)
        .await
        .expect("count")
}

async fn work_request(
    client: &reqwest::Client,
    base: &str,
    f: &Fixture,
    jwt: &str,
    agent: Uuid,
) -> (u16, Value) {
    let response = client
        .post(format!(
            "{base}/v1/workspaces/{}/channels/{}/agent-runs",
            f.workspace, f.channel
        ))
        .bearer_auth(jwt)
        .json(
            &json!({"agent_member_id": agent, "client_run_id": Uuid::new_v4(),
                      "input": {"type": "work", "title": "t", "brief": "b"}}),
        )
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

/// B5-10, B15-A5: `type=work` aimed at the workspace's team AI is a 409 with its own code, before any
/// write. (Until this slice the run was created and then closed again without a word — the helper
/// derives its requester from a trigger message and a work run has none.)
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn s1_a_work_request_aimed_at_the_helper_is_a_409_and_writes_nothing() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let f = seed(&su, &app).await;
    let base = start_server(app.clone()).await;
    let client = reqwest::Client::new();

    let runs = "SELECT count(*) FROM agent_run WHERE workspace_id = $1";
    let jobs = "SELECT count(*) FROM outbox WHERE workspace_id = $1 AND kind = 'agent_job'";
    let queued =
        "SELECT count(*) FROM audit_log WHERE workspace_id = $1 AND action = 'agent.work.queued'";
    let (runs_before, jobs_before, queued_before) = (
        count(&su, runs, &f).await,
        count(&su, jobs, &f).await,
        count(&su, queued, &f).await,
    );
    let (status, body) = work_request(&client, &base, &f, &f.requester_jwt, f.helper).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(
        body["error"]["code"].as_str().or(body["code"].as_str()),
        Some("team_ai_use_mention"),
        "{body}"
    );
    assert!(
        body.to_string().contains("멘션이나 DM"),
        "the answer says how to call the helper: {body}"
    );
    assert_eq!(
        count(&su, runs, &f).await,
        runs_before,
        "no run was written"
    );
    assert_eq!(
        count(&su, jobs, &f).await,
        jobs_before,
        "no job was written"
    );
    assert_eq!(
        count(&su, queued, &f).await,
        queued_before,
        "no audit row was written"
    );

    // A stranger to the room still gets the 403/404 of before — nothing about the helper leaks.
    let (outsider_status, _) = work_request(&client, &base, &f, &f.outsider_jwt, f.helper).await;
    assert_ne!(
        outsider_status, 409,
        "someone who cannot address the helper is not told about it"
    );
}

/// B5-10: the check is the team AI's alone — an ordinary agent in the same room takes a work run
/// exactly as before (and the helper is told apart by the workspace's own record, not by a name).
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn s2_the_409_is_the_helpers_alone() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let f = seed(&su, &app).await;
    let base = start_server(app.clone()).await;
    let client = reqwest::Client::new();

    let (status, body) = work_request(&client, &base, &f, &f.requester_jwt, f.other_agent).await;
    assert_eq!(
        status, 201,
        "an ordinary agent still takes a work run: {body}"
    );
    // Switch the team AI off: it is still the team AI (the workspace's record names it), still 409.
    sqlx::query(
        "UPDATE workspace SET settings = settings || '{\"team_ai_fast_path\": false}'::jsonb WHERE id = $1",
    )
    .bind(f.workspace)
    .execute(&su)
    .await
    .unwrap();
    let (status, body) = work_request(&client, &base, &f, &f.requester_jwt, f.helper).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(
        body["error"]["code"].as_str().or(body["code"].as_str()),
        Some("team_ai_use_mention")
    );
}

/// B5-8, B15-A8, B13-I7: the existing cancel route stops a task — any active member of the room can
/// (not only the requester), a stranger cannot, and the same transaction ends the task row (its
/// plan and note gone) and retires the step job that was waiting.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn s3_a_stop_by_any_member_of_the_room_ends_the_task_and_retires_its_job() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let f = seed(&su, &app).await;
    let base = start_server(app.clone()).await;
    let client = reqwest::Client::new();

    // A task in flight: a mention run that is `running`, its row (step 1 done), its pending step job.
    let (workspace, channel, helper, requester) = (f.workspace, f.channel, f.helper, f.requester);
    let run = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            let sent = send_message_in_tx(
                conn,
                workspace,
                NewMessage::text(
                    channel,
                    requester,
                    "@oort-helper 오래 조사해 줘".to_string(),
                ),
            )
            .await?;
            let created = create_agent_run_in_tx(
                conn,
                workspace,
                NewAgentRun {
                    channel_id: channel,
                    trigger: RunTrigger::Mention {
                        message_id: sent.message.id,
                        agent_member_id: helper,
                    },
                    parent_run_id: None,
                    max_steps: 50,
                    depth: 0,
                    input: json!({"schema": "momo.agent_run.input.v0", "surface": "mention",
                                  "prompt": "조사", "depth": 0}),
                },
            )
            .await?;
            Ok(created.id)
        })
    })
    .await
    .expect("a mention run");
    sqlx::query("UPDATE agent_run SET status = 'running', started_at = now() WHERE id = $1")
        .bind(run)
        .execute(&su)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO team_ai_task (workspace_id, run_id, agent_member_id, steps_done, plan, note) \
         VALUES ($1, $2, $3, 1, '[\"다음 단계\"]'::jsonb, '남아 있으면 안 되는 노트')",
    )
    .bind(workspace)
    .bind(run)
    .bind(helper)
    .execute(&su)
    .await
    .unwrap();
    let step_job = momo_agent::team_ai_task::step_job_payload(
        workspace,
        run,
        helper,
        channel,
        2,
        "team-ai-default",
        Some("instance_default"),
    );
    let job_id = emit_outbox(
        &su,
        workspace,
        OutboxKind::AgentJob,
        "publish",
        &step_job,
        Some(helper),
    )
    .await
    .expect("the pending step job");

    let cancel = |jwt: String| {
        let client = client.clone();
        let url = format!("{base}/v1/workspaces/{workspace}/agent-runs/{run}/cancel");
        async move { client.post(url).bearer_auth(jwt).send().await.unwrap() }
    };
    let task_state = |su: PgPool| async move {
        sqlx::query_as::<_, (String, Option<String>, Option<String>, bool)>(
            "SELECT state, end_reason, note, plan IS NOT NULL FROM team_ai_task WHERE run_id = $1",
        )
        .bind(run)
        .fetch_one(&su)
        .await
        .unwrap()
    };

    // A stranger to the room cannot stop it — and nothing changes.
    let refused = cancel(f.outsider_jwt.clone()).await;
    assert!(
        matches!(refused.status().as_u16(), 403 | 404),
        "a non-member's stop is refused: {}",
        refused.status()
    );
    assert_eq!(task_state(su.clone()).await.0, "active");

    // A member of the room who is not the requester can.
    let stopped = cancel(f.bystander_jwt.clone()).await;
    assert_eq!(stopped.status().as_u16(), 200, "{:?}", stopped.text().await);
    let (state, reason, note, has_plan) = task_state(su.clone()).await;
    assert_eq!(
        (state.as_str(), reason.as_deref(), note, has_plan),
        ("ended", Some("task_cancelled"), None, false),
        "the stop ends the task in its own transaction, and its note goes"
    );
    let (job_status, last_error): (String, Option<String>) =
        sqlx::query_as("SELECT status::text, last_error FROM outbox WHERE id = $1")
            .bind(job_id)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(
        job_status, "done",
        "the waiting step job is retired with the run"
    );
    assert_eq!(
        last_error.as_deref(),
        Some(momo_outbox::RUN_CANCELLED_JOB_LAST_ERROR)
    );
    let run_status: String = sqlx::query_scalar("SELECT status::text FROM agent_run WHERE id = $1")
        .bind(run)
        .fetch_one(&su)
        .await
        .unwrap();
    assert_eq!(run_status, "cancelled");

    // A second stop is the route's idempotent 200 and writes nothing more.
    let again = cancel(f.requester_jwt.clone()).await;
    assert_eq!(again.status().as_u16(), 200);
    assert_eq!(
        task_state(su.clone()).await.1.as_deref(),
        Some("task_cancelled")
    );
}
