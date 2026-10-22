//! #4214 / ADR-0208 — scheduled messages against real Postgres.
//!
//! The server keeps a person's message and sends it itself at `sendAtMs`, even when none of their
//! devices is on. Everything below is proved through the same seams production uses: REST on an
//! ephemeral port as `momo_app` (NOBYPASSRLS), the tick as `momo_app`, fixtures as the superuser.
//!
//! | test | what it keeps | revert that makes it red |
//! |---|---|---|
//! | `a_due_message_is_sent_once_under_two_schedulers_and_send_now` | no duplicate send; a held row is skipped, not waited on | `FOR UPDATE SKIP LOCKED` or `client_msg_id = schedule id` removed |
//! | `a_rejection_never_overwrites_a_sent_or_cancelled_row` | the refusal closes under the same lock, never over a finished row | the refusal's `UPDATE` loses its `status IN (…)` guard, or the savepoint is replaced by a separate transaction |
//! | `scheduled_rows_are_visible_only_to_their_author` | no other member, workspace owner or workspace sees a schedule | the policy loses its `author_member_id` term |
//! | `the_scheduler_write_runs_as_a_role_that_does_not_bypass_rls` | no BYPASSRLS write path | the tick's pool is connected as `momo_relay` (the guard is removed) |
//! | `the_due_functions_owner_cannot_read_bodies_and_sees_only_due_or_expired_rows` | the definer's exposure | owner → superuser, `body` granted, policy `true` |
//! | `only_momo_app_may_call_the_due_functions` | who may enumerate | `PUBLIC` EXECUTE, the self-check removed |
//! | `bodies_are_unreachable_for_the_bypassrls_roles_and_momo_app_keeps_all_four_privileges` | the seal | block removed, `momo_app` loses DELETE |
//! | `a_scheduled_mention_starts_the_same_agent_run_as_a_rest_send` | the canonical path is one path | the mention step skipped on the scheduler's side |
//! | `each_failure_reason_is_named_and_the_grace_boundary_holds` | the eight reasons, the grace edge, the attempt accounting | decision order, backoff, `attempts` bump moved |
//! | `a_poison_row_does_not_stop_the_tick` | one bad row is skipped, not fatal | isolation or the five-minute skip removed |
//! | `a_large_backlog_in_one_workspace_does_not_starve_the_others` | fair selection | the function's per-workspace window removed |
//! | `the_due_functions_work_on_a_connection_that_already_ran_a_tenant_tx` | no 22P02 on a pooled connection | the policy's `NULLIF` removed |
//! | `post_answers_a_known_client_request_id_before_any_validation` / `the_cap_holds_under_concurrency` | idempotent create, cap of 50 | lookup order, UNIQUE, advisory lock |
//! | `an_edit_in_the_last_30_seconds_is_refused_but_a_cancel_races_safely` | the edit lock; the row lock decides a race | the 30 s judgment or the row lock removed |
//! | `a_member_wide_session_end_holds_pending_and_failed_schedules_and_logout_does_not` | credential revocation | hook removed, failed rows skipped, logout hooked |
//! | `a_device_unlink_or_refresh_reuse_holds_only_that_lineages_schedules` | per-lineage hold | `armed_session_id` condition, the refresh of the lineage on edit, the `Revoked`-only condition |
//! | `removal_and_leave_cancel_schedules_and_a_foreign_member_guc_is_bound_only_in_the_three_named_functions` | cancel on removal; the foreign GUC exception | hook removed, a binding outside the three |
//! | `the_tick_purges_expired_rows_without_the_author_writing` / `a_deleted_workspace_row_is_cancelled_not_retried` | retention; soft-deleted workspaces | the sweep or the workspace judgment removed |
//! | `the_event_rides_the_personal_channel_with_ids_only` | no body in the frame | `body` added to the event |
//!
//! `#[ignore]` — needs a real PG18 superuser DB plus the runtime roles:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:24214/momo \
//!   PGHOST=127.0.0.1 PGPORT=24214 PGUSER=momo PGPASSWORD=momo PGDATABASE=momo \
//!   cargo test -p momo-server --test scheduled_message_conformance_pg \
//!   -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Assertion messages never interpolate a body or a token.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::sqlx::Row;
use momo_db::PgPool;
use momo_server::config::{DeviceKeySettings, SchedulerSettings};
use momo_server::scheduler::{run_tick, TickMemory, TickReport};
use momo_server::{build_app, AppState, RealtimeAdvert};
use serde_json::{json, Value};
use tokio::sync::watch;
use uuid::Uuid;

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

const TEST_JWT_SECRET: &str = "scheduled-message-conformance-signing-secret";
const TEST_PASSWORD: &str = "scheduled-message-test-password";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn role_options(username: &str, password: &str) -> PgConnectOptions {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    options.username(username).password(password)
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect to conformance DB as superuser")
}

async fn role_pool(username: &str, password: &str, connections: u32) -> PgPool {
    PgPoolOptions::new()
        .max_connections(connections)
        .connect_with(role_options(username, password))
        .await
        .unwrap_or_else(|error| panic!("connect as {username} (bootstrap_roles.sql?): {error}"))
}

async fn momo_app_pool(connections: u32) -> PgPool {
    let password =
        std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string());
    role_pool("momo_app", &password, connections).await
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

fn apply_sql_file(relative: &str) -> std::process::ExitStatus {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative);
    Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(path)
        .status()
        .expect("spawn psql")
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().expect("schema lock");
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations");
    assert!(
        apply_sql_file("../../../infra/rust/sql/bootstrap_roles.sql").success(),
        "bootstrap_roles.sql failed to apply"
    );
    *ready = true;
}

// ---------------------------------------------------------------------------
// fixtures (superuser → RLS bypassed)
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Human {
    id: Uuid,
    email: String,
}

async fn seed_workspace(su: &PgPool, hint: &str) -> Uuid {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("{hint}-{workspace}"))
        .execute(su)
        .await
        .expect("seed workspace");
    workspace
}

async fn seed_human(su: &PgPool, workspace: Uuid, handle: &str, role: &str) -> Human {
    let id = Uuid::new_v4();
    let email = format!("{id}@scheduled.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $4)",
    )
    .bind(id)
    .bind(workspace)
    .bind(handle)
    .bind(format!("{handle}-{}", &id.simple().to_string()[..6]))
    .execute(su)
    .await
    .expect("seed human member");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         VALUES ($1, $2, $3, true, momo_password_hash($4))",
    )
    .bind(id)
    .bind(workspace)
    .bind(&email)
    .bind(TEST_PASSWORD)
    .execute(su)
    .await
    .expect("seed human auth");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ($1, $2, $3::membership_role)",
    )
    .bind(workspace)
    .bind(id)
    .bind(role)
    .execute(su)
    .await
    .expect("seed workspace_membership");
    Human { id, email }
}

async fn seed_agent(su: &PgPool, workspace: Uuid, owner: Uuid, handle: &str) -> Uuid {
    let agent = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', $3, $3)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(handle)
    .execute(su)
    .await
    .expect("seed agent member");
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, max_concurrent_runs, \
                            max_run_steps, owner_human_id) \
         VALUES ($1, $2, 'hermes-agent', 'https://gateway.invalid/v1', 4, 50, $3)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(owner)
    .execute(su)
    .await
    .expect("seed agent");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ($1, $2, 'member')",
    )
    .bind(workspace)
    .bind(agent)
    .execute(su)
    .await
    .expect("seed agent membership");
    agent
}

async fn seed_channel(su: &PgPool, workspace: Uuid, created_by: Uuid, members: &[Uuid]) -> Uuid {
    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, topic, created_by) \
         VALUES ($1, $2, 'public', $3, '', $4)",
    )
    .bind(channel)
    .bind(workspace)
    .bind(format!("ch-{}", &channel.simple().to_string()[..8]))
    .bind(created_by)
    .execute(su)
    .await
    .expect("seed channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel)
        .bind(workspace)
        .execute(su)
        .await
        .expect("seed channel_seq");
    for member in members {
        join_channel(su, workspace, channel, *member).await;
    }
    channel
}

async fn join_channel(su: &PgPool, workspace: Uuid, channel: Uuid, member: Uuid) {
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'member')",
    )
    .bind(workspace)
    .bind(channel)
    .bind(member)
    .execute(su)
    .await
    .expect("seed channel membership");
}

struct Fixture {
    workspace: Uuid,
    admin: Human,
    a: Human,
    b: Human,
    channel: Uuid,
    /// A channel `a` is NOT a member of.
    other_channel: Uuid,
}

async fn fixture(su: &PgPool, hint: &str) -> Fixture {
    let workspace = seed_workspace(su, hint).await;
    let admin = seed_human(su, workspace, "admin", "owner").await;
    let a = seed_human(su, workspace, "alice", "member").await;
    let b = seed_human(su, workspace, "bob", "member").await;
    let channel = seed_channel(su, workspace, admin.id, &[admin.id, a.id, b.id]).await;
    let other_channel = seed_channel(su, workspace, admin.id, &[admin.id, b.id]).await;
    Fixture {
        workspace,
        admin,
        a,
        b,
        channel,
        other_channel,
    }
}

async fn insert_attachment(
    su: &PgPool,
    workspace: Uuid,
    channel: Uuid,
    uploader: Uuid,
    status: &str,
) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO attachment (id, workspace_id, channel_id, uploader_member_id, drive_file_id, \
                                 name, mime, size_bytes, status) \
         VALUES ($1, $2, $3, $4, $5, 'notes.txt', 'text/plain', 12, $6)",
    )
    .bind(id)
    .bind(workspace)
    .bind(channel)
    .bind(uploader)
    .bind(format!("drive-{id}"))
    .bind(status)
    .execute(su)
    .await
    .expect("seed attachment");
    id
}

/// A message by `author` in `channel` (a thread root, or a plain one), as the superuser.
async fn insert_message(
    su: &PgPool,
    workspace: Uuid,
    channel: Uuid,
    author: Uuid,
    body: &str,
) -> Uuid {
    let seq: i64 = sqlx::query_scalar(
        "UPDATE channel_seq SET last_seq = last_seq + 1 WHERE channel_id = $1 RETURNING last_seq",
    )
    .bind(channel)
    .fetch_one(su)
    .await
    .expect("bump seq");
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO message (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, \
                              author_member_id, type, body) \
         VALUES ($1, $2, $3, $4, 0, 0, $5, 'text', $6)",
    )
    .bind(id)
    .bind(workspace)
    .bind(channel)
    .bind(seq)
    .bind(author)
    .bind(body)
    .execute(su)
    .await
    .expect("seed message");
    id
}

/// One schedule row inserted directly (the paths that are not testing the create route).
/// `send_at_offset_secs` is relative to the **database** clock.
#[allow(clippy::too_many_arguments)]
async fn insert_schedule(
    su: &PgPool,
    workspace: Uuid,
    channel: Uuid,
    author: Uuid,
    body: &str,
    send_at_offset_secs: i64,
    armed_session: Option<Uuid>,
) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO scheduled_message \
           (id, workspace_id, channel_id, author_member_id, body, send_at, client_request_id, armed_session_id) \
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6), $7, $8)",
    )
    .bind(id)
    .bind(workspace)
    .bind(channel)
    .bind(author)
    .bind(body)
    .bind(send_at_offset_secs as f64)
    .bind(Uuid::new_v4())
    .bind(armed_session)
    .execute(su)
    .await
    .expect("seed scheduled message");
    id
}

#[derive(Debug, Clone)]
struct Snap {
    status: String,
    reason: Option<String>,
    attempts: i32,
    body: Option<String>,
    rev: i32,
    sent_message_id: Option<Uuid>,
    armed_session_id: Option<Uuid>,
    next_attempt_in_secs: Option<f64>,
}

async fn row(su: &PgPool, id: Uuid) -> Snap {
    let row = sqlx::query(
        "SELECT status, failure_reason, attempts, body, rev, sent_message_id, armed_session_id, \
                EXTRACT(EPOCH FROM (next_attempt_at - now()))::float8 AS next_in \
           FROM scheduled_message WHERE id = $1",
    )
    .bind(id)
    .fetch_one(su)
    .await
    .expect("schedule row");
    Snap {
        status: row.get("status"),
        reason: row.get("failure_reason"),
        attempts: row.get("attempts"),
        body: row.get("body"),
        rev: row.get("rev"),
        sent_message_id: row.get("sent_message_id"),
        armed_session_id: row.get("armed_session_id"),
        next_attempt_in_secs: row.get("next_in"),
    }
}

async fn row_exists(su: &PgPool, id: Uuid) -> bool {
    sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM scheduled_message WHERE id = $1)")
        .bind(id)
        .fetch_one(su)
        .await
        .expect("exists")
}

/// How many messages carry this schedule's id as their `client_msg_id` (a schedule's send is
/// idempotent on it, so more than one is a duplicate).
async fn messages_of(su: &PgPool, schedule: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM message WHERE client_msg_id = $1")
        .bind(schedule)
        .fetch_one(su)
        .await
        .expect("message count")
}

async fn move_send_at(su: &PgPool, id: Uuid, offset_secs: i64) {
    sqlx::query(
        "UPDATE scheduled_message SET send_at = now() + make_interval(secs => $2) WHERE id = $1",
    )
    .bind(id)
    .bind(offset_secs as f64)
    .execute(su)
    .await
    .expect("move send_at");
}

async fn audit_actions_for(su: &PgPool, schedule: Uuid) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT action FROM audit_log WHERE target_type = 'scheduled_message' AND target_id = $1 \
          ORDER BY created_at, id",
    )
    .bind(schedule)
    .fetch_all(su)
    .await
    .expect("audit actions")
}

/// The `scheduled_message.updated` frames queued for one schedule, oldest first.
async fn events_for(su: &PgPool, workspace: Uuid, schedule: Uuid) -> Vec<Value> {
    sqlx::query_scalar(
        "SELECT payload FROM outbox \
          WHERE workspace_id = $1 AND kind = 'broadcast' \
            AND payload -> 'data' ->> 'type' = 'scheduled_message.updated' \
            AND payload -> 'data' -> 'payload' ->> 'scheduled_message_id' = $2 \
          ORDER BY id",
    )
    .bind(workspace)
    .bind(schedule.to_string().to_uppercase())
    .fetch_all(su)
    .await
    .expect("events")
}

// ---------------------------------------------------------------------------
// the rig: a server, a tick, and the HTTP helpers
// ---------------------------------------------------------------------------

struct Rig {
    su: PgPool,
    app: PgPool,
    tick_pool: PgPool,
    state: AppState,
    base: String,
    http: reqwest::Client,
    settings: SchedulerSettings,
    memory: TickMemory,
    _stop_tx: watch::Sender<bool>,
    stop: watch::Receiver<bool>,
}

impl Rig {
    async fn new() -> Rig {
        Rig::with(SchedulerSettings::default(), DeviceKeySettings::default()).await
    }

    async fn with_settings(settings: SchedulerSettings) -> Rig {
        Rig::with(settings, DeviceKeySettings::default()).await
    }

    async fn with(settings: SchedulerSettings, device_keys: DeviceKeySettings) -> Rig {
        ensure_schema_and_roles();
        let su = superuser_pool().await;
        // Every test starts from an empty table: a tick looks at the due rows of **every**
        // tenant, so a row another test left behind would be this test's noise.
        sqlx::query("DELETE FROM scheduled_message")
            .execute(&su)
            .await
            .expect("start from an empty schedule table");
        let app = momo_app_pool(10).await;
        let tick_pool = momo_app_pool(2).await;
        let state = AppState::new(
            app.clone(),
            TEST_JWT_SECRET.to_string(),
            RealtimeAdvert::SameOrigin,
        )
        .with_scheduler(settings)
        .with_device_keys(device_keys);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind momo-server");
        let address: SocketAddr = listener.local_addr().expect("server address");
        let served = build_app(state.clone());
        tokio::spawn(async move {
            let _ = axum::serve(listener, served).await;
        });
        let (stop_tx, stop) = watch::channel(false);
        Rig {
            su,
            app,
            tick_pool,
            state,
            base: format!("http://{address}"),
            http: reqwest::Client::new(),
            settings,
            memory: TickMemory::default(),
            _stop_tx: stop_tx,
            stop,
        }
    }

    /// One look of the scheduler, exactly as `run_loop` runs it.
    async fn tick(&mut self) -> TickReport {
        let mut memory = std::mem::take(&mut self.memory);
        let report = self.tick_with(&self.tick_pool, &mut memory).await;
        self.memory = memory;
        report
    }

    /// One look on a pool and a memory of the caller's — a second "replica" for the races.
    async fn tick_with(&self, pool: &PgPool, memory: &mut TickMemory) -> TickReport {
        run_tick(pool, &self.state, &self.settings, memory, &self.stop)
            .await
            .expect("the tick runs")
    }

    fn workspace_url(&self, workspace: Uuid, path: &str) -> String {
        format!("{}/v1/workspaces/{workspace}{path}", self.base)
    }

    async fn login(&self, workspace: Uuid, human: &Human) -> Session {
        let response = self
            .http
            .post(format!("{}/v1/auth/login", self.base))
            .json(&json!({
                "email": human.email,
                "password": TEST_PASSWORD,
                "workspace": workspace.to_string(),
            }))
            .send()
            .await
            .expect("login");
        assert_eq!(response.status().as_u16(), 200, "a seeded human logs in");
        let body: Value = response.json().await.expect("login body");
        Session {
            access: body["accessToken"].as_str().expect("access").to_string(),
            refresh: body["refreshToken"].as_str().expect("refresh").to_string(),
        }
    }

    async fn token(&self, workspace: Uuid, human: &Human) -> String {
        self.login(workspace, human).await.access
    }

    async fn call(
        &self,
        method: reqwest::Method,
        url: String,
        token: &str,
        body: Option<Value>,
    ) -> (u16, Value) {
        let mut request = self.http.request(method, url).bearer_auth(token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.expect("request");
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    async fn create(
        &self,
        token: &str,
        workspace: Uuid,
        channel: Uuid,
        body: Value,
    ) -> (u16, Value) {
        self.call(
            reqwest::Method::POST,
            self.workspace_url(
                workspace,
                &format!("/channels/{channel}/scheduled-messages"),
            ),
            token,
            Some(body),
        )
        .await
    }

    async fn list(&self, token: &str, workspace: Uuid, query: &str) -> (u16, Value) {
        self.call(
            reqwest::Method::GET,
            self.workspace_url(workspace, &format!("/scheduled-messages{query}")),
            token,
            None,
        )
        .await
    }

    async fn patch(&self, token: &str, workspace: Uuid, id: &str, body: Value) -> (u16, Value) {
        self.call(
            reqwest::Method::PATCH,
            self.workspace_url(workspace, &format!("/scheduled-messages/{id}")),
            token,
            Some(body),
        )
        .await
    }

    async fn delete(&self, token: &str, workspace: Uuid, id: &str) -> (u16, Value) {
        self.call(
            reqwest::Method::DELETE,
            self.workspace_url(workspace, &format!("/scheduled-messages/{id}")),
            token,
            None,
        )
        .await
    }

    async fn send_now(&self, token: &str, workspace: Uuid, id: &str) -> (u16, Value) {
        self.call(
            reqwest::Method::POST,
            self.workspace_url(workspace, &format!("/scheduled-messages/{id}/send-now")),
            token,
            None,
        )
        .await
    }

    /// A REST send (`POST …/messages`), the thing a schedule must be indistinguishable from.
    async fn rest_send(
        &self,
        token: &str,
        workspace: Uuid,
        channel: Uuid,
        client_msg_id: Uuid,
        body: &str,
    ) -> (u16, Value) {
        self.call(
            reqwest::Method::POST,
            self.workspace_url(workspace, &format!("/channels/{channel}/messages")),
            token,
            Some(json!({"clientMsgId": client_msg_id, "body": body})),
        )
        .await
    }
}

struct Session {
    access: String,
    refresh: String,
}

/// A create request `in_secs` from now on the **host** clock. Callers keep a margin of a few
/// seconds against the database clock (the boundary tests read the database's own).
fn create_body(text: &str, in_secs: i64) -> Value {
    json!({
        "body": text,
        "sendAtMs": chrono::Utc::now().timestamp_millis() + in_secs * 1000,
        "clientRequestId": Uuid::new_v4(),
    })
}

fn scheduled_id(value: &Value) -> Uuid {
    Uuid::parse_str(
        value["scheduledMessage"]["id"]
            .as_str()
            .unwrap_or_else(|| panic!("a scheduledMessage with an id: {value}")),
    )
    .expect("uuid")
}

fn error_code(value: &Value) -> Option<&str> {
    value["error"]["code"].as_str()
}

// ---------------------------------------------------------------------------
// the five routes, end to end
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_five_routes_round_trip_and_a_sent_schedule_is_a_plain_message() {
    let _lock = test_lock().await;
    let rig = Rig::new().await;
    let fx = fixture(&rig.su, "sm-roundtrip").await;
    let ta = rig.token(fx.workspace, &fx.a).await;

    // create → 201, a pending row, the 30-second edit lock named in the answer
    let request = create_body("hello later", 3600);
    let (status, created) = rig
        .create(&ta, fx.workspace, fx.channel, request.clone())
        .await;
    assert_eq!(status, 201, "{created}");
    let id = scheduled_id(&created);
    let sm = &created["scheduledMessage"];
    assert_eq!(sm["status"], "pending");
    assert_eq!(sm["body"], "hello later");
    assert_eq!(sm["memberId"], fx.a.id.to_string());
    assert_eq!(sm["channelId"], fx.channel.to_string());
    assert_eq!(sm["rev"], 0);
    assert_eq!(sm["sendAtMs"], request["sendAtMs"]);
    assert_eq!(
        sm["editableUntilMs"].as_i64().unwrap(),
        request["sendAtMs"].as_i64().unwrap() - 30_000
    );
    assert!(sm.get("rootId").is_none() && sm.get("attachments").is_none());

    // the same clientRequestId again → 201 and the very same row; no second row
    let (status, again) = rig.create(&ta, fx.workspace, fx.channel, request).await;
    assert_eq!(status, 201);
    assert_eq!(scheduled_id(&again), id);

    // list: mine, soonest first, the filter is a closed set
    let (status, listed) = rig.list(&ta, fx.workspace, "").await;
    assert_eq!(status, 200);
    let ids: Vec<&str> = listed["scheduledMessages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec![id.to_string().as_str()]);
    assert_eq!(
        rig.list(&ta, fx.workspace, "?status=failed").await.1["scheduledMessages"],
        json!([])
    );
    assert_eq!(rig.list(&ta, fx.workspace, "?status=sent").await.0, 400);
    assert_eq!(
        rig.list(&ta, fx.workspace, "?channelId=not-a-uuid").await.0,
        400
    );

    // patch the text, then the time
    let (status, patched) = rig
        .patch(
            &ta,
            fx.workspace,
            &id.to_string(),
            json!({"body": "edited"}),
        )
        .await;
    assert_eq!(status, 200, "{patched}");
    assert_eq!(patched["scheduledMessage"]["body"], "edited");
    assert_eq!(patched["scheduledMessage"]["rev"], 1);
    let later = chrono::Utc::now().timestamp_millis() + 7200 * 1000;
    let (status, patched) = rig
        .patch(
            &ta,
            fx.workspace,
            &id.to_string(),
            json!({"sendAtMs": later}),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(patched["scheduledMessage"]["sendAtMs"], later);
    assert_eq!(patched["scheduledMessage"]["rev"], 2);
    assert_eq!(
        rig.patch(&ta, fx.workspace, &id.to_string(), json!({}))
            .await
            .0,
        400,
        "at least one field"
    );

    // send now → 200, the row is `sent`, its body is gone, and a plain message exists
    let (status, sent) = rig.send_now(&ta, fx.workspace, &id.to_string()).await;
    assert_eq!(status, 200, "{sent}");
    let sm = &sent["scheduledMessage"];
    assert_eq!(sm["status"], "sent");
    assert!(sm.get("body").is_none() && sm.get("editableUntilMs").is_none());
    let message_id = Uuid::parse_str(sm["sentMessageId"].as_str().unwrap()).unwrap();
    assert_eq!(
        row(&rig.su, id).await.body,
        None,
        "a sent row keeps no body (D14)"
    );
    let message = sqlx::query(
        "SELECT body, author_member_id, client_msg_id, props FROM message WHERE id = $1",
    )
    .bind(message_id)
    .fetch_one(&rig.su)
    .await
    .unwrap();
    assert_eq!(message.get::<String, _>("body"), "edited");
    assert_eq!(message.get::<Uuid, _>("author_member_id"), fx.a.id);
    assert_eq!(
        message.get::<Option<Uuid>, _>("client_msg_id"),
        Some(id),
        "the schedule id is the idempotency key"
    );
    assert_eq!(
        message.get::<Value, _>("props"),
        json!({}),
        "no `scheduled` marker for the recipients (D4)"
    );
    assert_eq!(
        rig.list(&ta, fx.workspace, "").await.1["scheduledMessages"],
        json!([])
    );

    // a sent row answers 409 to edits, cancels and a second send
    for (status, body) in [
        rig.patch(&ta, fx.workspace, &id.to_string(), json!({"body": "x"}))
            .await,
        rig.delete(&ta, fx.workspace, &id.to_string()).await,
        rig.send_now(&ta, fx.workspace, &id.to_string()).await,
    ] {
        assert_eq!(status, 409);
        assert_eq!(error_code(&body), Some("scheduled_already_sent"));
    }
    assert_eq!(messages_of(&rig.su, id).await, 1);

    // audit: the five verbs carry no body
    assert_eq!(
        audit_actions_for(&rig.su, id).await,
        vec![
            "scheduled_message.created",
            "scheduled_message.updated",
            "scheduled_message.updated",
            "scheduled_message.sent",
        ]
    );
    let audit_text: String = sqlx::query_scalar(
        "SELECT string_agg(detail::text, ' ') FROM audit_log WHERE target_id = $1",
    )
    .bind(id)
    .fetch_one(&rig.su)
    .await
    .unwrap();
    assert!(
        !audit_text.contains("hello later") && !audit_text.contains("edited"),
        "{audit_text}"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_request_is_closed_and_each_refusal_has_its_status_and_code() {
    let _lock = test_lock().await;
    let rig = Rig::new().await;
    let fx = fixture(&rig.su, "sm-refusals").await;
    let ta = rig.token(fx.workspace, &fx.a).await;

    // closed: replyToId / routing / props / type / signature are a 400, not silently dropped
    for field in [
        "replyToId",
        "routing",
        "props",
        "type",
        "signature",
        "memberId",
    ] {
        let mut body = create_body("x", 3600);
        body[field] = json!("anything");
        let (status, value) = rig.create(&ta, fx.workspace, fx.channel, body).await;
        assert_eq!(status, 400, "{field}: {value}");
    }
    // a malformed id is 400 (not axum's 422)
    let mut malformed = create_body("x", 3600);
    malformed["clientRequestId"] = json!("nope");
    assert_eq!(
        rig.create(&ta, fx.workspace, fx.channel, malformed).await.0,
        400
    );

    // time: the past counts as too soon; beyond 120 days is too far
    let now = chrono::Utc::now().timestamp_millis();
    for (offset_ms, code) in [
        (-5_000_i64, "send_at_too_soon"),
        (30_000, "send_at_too_soon"),
        (121 * 24 * 3600 * 1000, "send_at_too_far"),
    ] {
        let body =
            json!({"body": "x", "sendAtMs": now + offset_ms, "clientRequestId": Uuid::new_v4()});
        let (status, value) = rig.create(&ta, fx.workspace, fx.channel, body).await;
        assert_eq!((status, error_code(&value)), (400, Some(code)), "{value}");
    }
    // an empty message
    let mut blank = create_body("   ", 3600);
    blank["attachmentIds"] = json!([]);
    let (status, value) = rig.create(&ta, fx.workspace, fx.channel, blank).await;
    assert_eq!((status, error_code(&value)), (400, Some("empty_message")));

    // not a member of the channel → 403, the same judgment `sendMessage` makes
    let (status, _) = rig
        .create(&ta, fx.workspace, fx.other_channel, create_body("x", 3600))
        .await;
    assert_eq!(status, 403);
    // a thread root that does not exist → 404; one in another channel counts as missing
    let mut reply = create_body("x", 3600);
    reply["rootId"] = json!(Uuid::new_v4());
    assert_eq!(
        rig.create(&ta, fx.workspace, fx.channel, reply).await.0,
        404
    );
    let foreign_root =
        insert_message(&rig.su, fx.workspace, fx.other_channel, fx.b.id, "root").await;
    let mut reply = create_body("x", 3600);
    reply["rootId"] = json!(foreign_root);
    assert_eq!(
        rig.create(&ta, fx.workspace, fx.channel, reply).await.0,
        404
    );
    // a live root works, and the schedule is a reply in that thread
    let root = insert_message(&rig.su, fx.workspace, fx.channel, fx.b.id, "root").await;
    let mut reply = create_body("a reply", 3600);
    reply["rootId"] = json!(root);
    let (status, value) = rig.create(&ta, fx.workspace, fx.channel, reply).await;
    assert_eq!(status, 201, "{value}");
    assert_eq!(value["scheduledMessage"]["rootId"], root.to_string());

    // ids and the other member's rows
    let (_, mine) = rig
        .create(&ta, fx.workspace, fx.channel, create_body("mine", 3600))
        .await;
    let mine_id = scheduled_id(&mine).to_string();
    assert_eq!(
        rig.patch(&ta, fx.workspace, "not-a-uuid", json!({"body": "x"}))
            .await
            .0,
        400
    );
    assert_eq!(rig.delete(&ta, fx.workspace, "not-a-uuid").await.0, 400);
    assert_eq!(rig.send_now(&ta, fx.workspace, "not-a-uuid").await.0, 400);
    let unknown = Uuid::new_v4().to_string();
    assert_eq!(rig.delete(&ta, fx.workspace, &unknown).await.0, 404);

    // an agent bearer is not on the allow-list: 403 before any handler
    let agent = seed_agent(&rig.su, fx.workspace, fx.a.id, "robot").await;
    let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let bearer = format!("momo_agent_v1.{}.{secret}", fx.workspace);
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), ARRAY['messages:write']::text[], 'sm')",
    )
    .bind(fx.workspace)
    .bind(agent)
    .bind(&bearer)
    .execute(&rig.su)
    .await
    .unwrap();
    assert_eq!(
        rig.create(&bearer, fx.workspace, fx.channel, create_body("x", 3600))
            .await
            .0,
        403
    );
    assert_eq!(rig.list(&bearer, fx.workspace, "").await.0, 403);
    assert_eq!(rig.delete(&bearer, fx.workspace, &mine_id).await.0, 403);
    assert_eq!(rig.send_now(&bearer, fx.workspace, &mine_id).await.0, 403);
    assert_eq!(
        rig.patch(&bearer, fx.workspace, &mine_id, json!({"body": "x"}))
            .await
            .0,
        403
    );
    // no bearer at all
    assert_eq!(rig.list("", fx.workspace, "").await.0, 401);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_server_with_the_scheduler_off_refuses_to_take_a_schedule_but_lets_one_be_dropped() {
    let _lock = test_lock().await;
    let rig = Rig::with_settings(SchedulerSettings {
        enabled: false,
        ..SchedulerSettings::default()
    })
    .await;
    let fx = fixture(&rig.su, "sm-off").await;
    let ta = rig.token(fx.workspace, &fx.a).await;
    let existing = insert_schedule(
        &rig.su,
        fx.workspace,
        fx.channel,
        fx.a.id,
        "waiting",
        3600,
        None,
    )
    .await;

    let (status, value) = rig
        .create(&ta, fx.workspace, fx.channel, create_body("x", 3600))
        .await;
    assert_eq!(
        (status, error_code(&value)),
        (503, Some("scheduler_disabled")),
        "{value}"
    );
    let (status, value) = rig
        .patch(
            &ta,
            fx.workspace,
            &existing.to_string(),
            json!({"body": "y"}),
        )
        .await;
    assert_eq!(
        (status, error_code(&value)),
        (503, Some("scheduler_disabled"))
    );
    let (status, value) = rig.send_now(&ta, fx.workspace, &existing.to_string()).await;
    assert_eq!(
        (status, error_code(&value)),
        (503, Some("scheduler_disabled"))
    );
    // list and delete keep working
    let (status, listed) = rig.list(&ta, fx.workspace, "").await;
    assert_eq!(status, 200);
    assert_eq!(listed["scheduledMessages"].as_array().unwrap().len(), 1);
    assert_eq!(
        rig.delete(&ta, fx.workspace, &existing.to_string()).await.0,
        204
    );
    assert_eq!(row(&rig.su, existing).await.status, "cancelled");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn attachments_are_reserved_at_schedule_time_and_bound_when_it_is_sent() {
    let _lock = test_lock().await;
    let mut rig = Rig::new().await;
    let fx = fixture(&rig.su, "sm-attach").await;
    let ta = rig.token(fx.workspace, &fx.a).await;
    let file = insert_attachment(&rig.su, fx.workspace, fx.channel, fx.a.id, "complete").await;

    // an attachment-only schedule: no text, one file
    let mut request = create_body("", 3600);
    request["body"] = Value::Null;
    request["attachmentIds"] = json!([file]);
    let (status, created) = rig.create(&ta, fx.workspace, fx.channel, request).await;
    assert_eq!(status, 201, "{created}");
    let id = scheduled_id(&created);
    assert_eq!(created["scheduledMessage"]["body"], "");
    assert_eq!(
        created["scheduledMessage"]["attachments"][0]["id"],
        file.to_string()
    );
    assert_eq!(
        created["scheduledMessage"]["attachments"][0]["name"],
        "notes.txt"
    );

    // the same file in a second schedule is reserved (409 attachment_reserved)
    let mut again = create_body("two", 3600);
    again["attachmentIds"] = json!([file]);
    let (status, value) = rig.create(&ta, fx.workspace, fx.channel, again).await;
    assert_eq!(
        (status, error_code(&value)),
        (409, Some("attachment_reserved")),
        "{value}"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM scheduled_message WHERE author_member_id = $1"
        )
        .bind(fx.a.id)
        .fetch_one(&rig.su)
        .await
        .unwrap(),
        1,
        "the refused create left no row behind (rolled back whole)"
    );

    // the send's own binding rules, in the send's own words
    let someone_elses =
        insert_attachment(&rig.su, fx.workspace, fx.channel, fx.b.id, "complete").await;
    let pending = insert_attachment(&rig.su, fx.workspace, fx.channel, fx.a.id, "pending").await;
    let wrong_channel =
        insert_attachment(&rig.su, fx.workspace, fx.other_channel, fx.a.id, "complete").await;
    for (ids, expected) in [
        (json!([Uuid::new_v4()]), 404),
        (json!([someone_elses]), 403),
        (json!([pending]), 409),
        (json!([wrong_channel]), 403),
        (json!([pending, pending]), 400),
    ] {
        let mut body = create_body("x", 3600);
        body["attachmentIds"] = ids.clone();
        let (status, value) = rig.create(&ta, fx.workspace, fx.channel, body).await;
        assert_eq!(status, expected, "{ids}: {value}");
    }

    // cancelling releases the reservation (the file stays)
    assert_eq!(rig.delete(&ta, fx.workspace, &id.to_string()).await.0, 204);
    let reserved: i64 = sqlx::query_scalar("SELECT count(*) FROM scheduled_message_attachment")
        .fetch_one(&rig.su)
        .await
        .unwrap();
    assert_eq!(reserved, 0);

    // …so it can be scheduled again, and when it is sent the message carries it
    let mut again = create_body("with a file", 3600);
    again["attachmentIds"] = json!([file]);
    let (status, created) = rig.create(&ta, fx.workspace, fx.channel, again).await;
    assert_eq!(status, 201, "{created}");
    let id = scheduled_id(&created);
    move_send_at(&rig.su, id, -2).await;
    let report = rig.tick().await;
    assert_eq!(report.sent, vec![id], "{report:?}");
    let row_after = row(&rig.su, id).await;
    assert_eq!(row_after.status, "sent");
    let linked: Option<Uuid> =
        sqlx::query_scalar("SELECT message_id FROM attachment WHERE id = $1")
            .bind(file)
            .fetch_one(&rig.su)
            .await
            .unwrap();
    assert_eq!(
        linked, row_after.sent_message_id,
        "the file is on the message that went out"
    );
    let held: i64 = sqlx::query_scalar("SELECT count(*) FROM scheduled_message_attachment")
        .fetch_one(&rig.su)
        .await
        .unwrap();
    assert_eq!(held, 0, "a sent schedule holds nothing");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_tick_sends_a_due_message_as_the_same_message_a_rest_send_makes() {
    let _lock = test_lock().await;
    let mut rig = Rig::new().await;
    let fx = fixture(&rig.su, "sm-tick").await;
    let ta = rig.token(fx.workspace, &fx.a).await;
    let tb = rig.token(fx.workspace, &fx.b).await;

    // the REST send, as the baseline
    let (status, rest) = rig
        .rest_send(&ta, fx.workspace, fx.channel, Uuid::new_v4(), "same text")
        .await;
    assert_eq!(status, 201, "{rest}");

    let id = insert_schedule(
        &rig.su,
        fx.workspace,
        fx.channel,
        fx.a.id,
        "same text",
        -2,
        None,
    )
    .await;
    // not yet due → untouched
    let early = insert_schedule(
        &rig.su,
        fx.workspace,
        fx.channel,
        fx.a.id,
        "early",
        600,
        None,
    )
    .await;
    let report = rig.tick().await;
    assert_eq!(report.sent, vec![id], "{report:?}");
    assert!(report.failed.is_empty() && report.decision_failed.is_empty());
    assert_eq!(row(&rig.su, early).await.status, "pending");

    let scheduled = row(&rig.su, id).await;
    assert_eq!(scheduled.status, "sent");
    assert_eq!(scheduled.body, None);
    assert_eq!(
        scheduled.attempts, 1,
        "the decision transaction raised it once"
    );
    async fn fields(
        su: &PgPool,
        message: Uuid,
    ) -> (
        Uuid,
        String,
        Option<String>,
        Value,
        Option<Uuid>,
        Option<Uuid>,
        Uuid,
    ) {
        let row = sqlx::query(
            "SELECT author_member_id, type::text AS kind, body, props, root_id, reply_to_id, channel_id \
               FROM message WHERE id = $1",
        )
        .bind(message)
        .fetch_one(su)
        .await
        .unwrap();
        (
            row.get("author_member_id"),
            row.get("kind"),
            row.get("body"),
            row.get("props"),
            row.get("root_id"),
            row.get("reply_to_id"),
            row.get("channel_id"),
        )
    }
    let rest_message = Uuid::parse_str(rest["id"].as_str().unwrap()).unwrap();
    assert_eq!(
        fields(&rig.su, scheduled.sent_message_id.unwrap()).await,
        fields(&rig.su, rest_message).await,
        "a scheduled message is a plain message: same author, type, text, props, channel"
    );

    // the message went through the one outbox seam: a broadcast row exists for it
    let broadcasts: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id = $1 AND kind = 'broadcast' \
            AND payload -> 'data' -> 'payload' ->> 'id' = $2",
    )
    .bind(fx.workspace)
    .bind(scheduled.sent_message_id.unwrap().to_string())
    .fetch_one(&rig.su)
    .await
    .unwrap();
    assert!(
        broadcasts >= 1,
        "the send enqueued its broadcast in its own transaction"
    );

    // the recipient sees it in history like any message
    let (status, history) = rig
        .call(
            reqwest::Method::GET,
            rig.workspace_url(fx.workspace, &format!("/channels/{}/messages", fx.channel)),
            &tb,
            None,
        )
        .await;
    assert_eq!(status, 200);
    let texts: Vec<&str> = history["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|message| message["body"].as_str())
        .collect();
    assert_eq!(
        texts.iter().filter(|text| **text == "same text").count(),
        2,
        "{texts:?}"
    );
}

// ---------------------------------------------------------------------------
// once, under every race (D7, D9)
// ---------------------------------------------------------------------------

/// Hold a row's lock from the outside, as a tick or a request mid-flight would.
async fn hold_row_lock(su: &PgPool, id: Uuid) -> sqlx::Transaction<'static, sqlx::Postgres> {
    let mut held = su.begin().await.expect("begin the holder");
    sqlx::query("SELECT 1 FROM scheduled_message WHERE id = $1 FOR UPDATE")
        .bind(id)
        .fetch_one(&mut *held)
        .await
        .expect("lock the row");
    held
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_due_message_is_sent_once_under_two_schedulers_and_send_now() {
    let _lock = test_lock().await;
    let rig = Rig::new().await;
    let fx = fixture(&rig.su, "sm-once").await;
    let ta = rig.token(fx.workspace, &fx.a).await;

    // 1. two replicas and a request, all at once, for one due row
    let id = insert_schedule(&rig.su, fx.workspace, fx.channel, fx.a.id, "once", -2, None).await;
    let other_pool = momo_app_pool(2).await;
    let (mut first, mut second) = (TickMemory::default(), TickMemory::default());
    let id_text = id.to_string();
    let (one, two, request) = tokio::join!(
        rig.tick_with(&rig.tick_pool, &mut first),
        rig.tick_with(&other_pool, &mut second),
        rig.send_now(&ta, fx.workspace, &id_text),
    );
    assert_eq!(
        messages_of(&rig.su, id).await,
        1,
        "exactly one message went out: {one:?} {two:?} {request:?}"
    );
    assert_eq!(row(&rig.su, id).await.status, "sent");
    let senders = one.sent.len() + two.sent.len() + usize::from(request.0 == 200);
    assert_eq!(senders, 1, "exactly one of the three did the sending");
    assert!(
        request.0 == 200
            || (request.0 == 409 && error_code(&request.1) == Some("scheduled_already_sent")),
        "the loser of the race is told it was already sent: {request:?}"
    );

    // 2. a row someone else holds is skipped, not waited on (SKIP LOCKED): the tick returns at
    //    once instead of burning its 3-second lock budget on it
    let mut rig = rig;
    let held_id =
        insert_schedule(&rig.su, fx.workspace, fx.channel, fx.a.id, "held", -2, None).await;
    let holder = hold_row_lock(&rig.su, held_id).await;
    let started = std::time::Instant::now();
    let report = rig.tick().await;
    let waited = started.elapsed();
    assert_eq!(report.skipped, vec![held_id], "{report:?}");
    assert!(
        report.decision_failed.is_empty(),
        "no lock timeout: {report:?}"
    );
    assert!(
        waited < std::time::Duration::from_millis(2500),
        "the tick did not queue behind the lock ({waited:?})"
    );
    holder.rollback().await.unwrap();
    let report = rig.tick().await;
    assert_eq!(report.sent, vec![held_id], "{report:?}");
    assert_eq!(messages_of(&rig.su, held_id).await, 1);

    // 3. the schedule's id IS the message's clientMsgId: when the author already used that id for a
    //    different message in this channel, the schedule is refused (`send_error`), it does not
    //    pass that message off as its own, and the failed attempt leaves no gap in the sequence
    let collided =
        insert_schedule(&rig.su, fx.workspace, fx.channel, fx.a.id, "mine", -2, None).await;
    let (status, theirs) = rig
        .rest_send(
            &ta,
            fx.workspace,
            fx.channel,
            collided,
            "a different message",
        )
        .await;
    assert_eq!(status, 201, "{theirs}");
    let seq_before: i64 =
        sqlx::query_scalar("SELECT last_seq FROM channel_seq WHERE channel_id = $1")
            .bind(fx.channel)
            .fetch_one(&rig.su)
            .await
            .unwrap();
    let report = rig.tick().await;
    assert_eq!(
        report.failed,
        vec![(collided, momo_messaging::ScheduleFailure::SendError)],
        "{report:?}"
    );
    let after = row(&rig.su, collided).await;
    assert_eq!(
        (after.status.as_str(), after.reason.as_deref()),
        ("failed", Some("send_error"))
    );
    assert_eq!(
        after.body.as_deref(),
        Some("mine"),
        "the author can still read what they wrote"
    );
    assert_eq!(
        messages_of(&rig.su, collided).await,
        1,
        "still only the REST message"
    );
    let seq_after: i64 =
        sqlx::query_scalar("SELECT last_seq FROM channel_seq WHERE channel_id = $1")
            .bind(fx.channel)
            .fetch_one(&rig.su)
            .await
            .unwrap();
    assert_eq!(
        seq_before, seq_after,
        "the refused attempt rolled its seq bump back with it"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_rejection_never_overwrites_a_sent_or_cancelled_row() {
    let _lock = test_lock().await;
    let mut rig = Rig::new().await;
    let fx = fixture(&rig.su, "sm-reject").await;
    let ta = rig.token(fx.workspace, &fx.a).await;

    // (a) the domain: closing a row `failed` matches only an OPEN row. A cancelled or sent row
    //     answers `None` and is left exactly as it was.
    let cancelled =
        insert_schedule(&rig.su, fx.workspace, fx.channel, fx.a.id, "x", 3600, None).await;
    assert_eq!(
        rig.delete(&ta, fx.workspace, &cancelled.to_string())
            .await
            .0,
        204
    );
    let (_, sent_body) = rig
        .create(&ta, fx.workspace, fx.channel, create_body("y", 3600))
        .await;
    let sent = scheduled_id(&sent_body);
    assert_eq!(
        rig.send_now(&ta, fx.workspace, &sent.to_string()).await.0,
        200
    );
    for finished in [cancelled, sent] {
        let before = row(&rig.su, finished).await;
        let (workspace, member) = (fx.workspace, fx.a.id);
        let result = momo_db::with_tenant_tx(&rig.app, workspace, move |conn| {
            Box::pin(async move {
                momo_messaging::mark_failed_in_tx(
                    conn,
                    member,
                    finished,
                    momo_messaging::ScheduleFailure::NotMember,
                    momo_messaging::ScheduleActor::System,
                )
                .await
            })
        })
        .await
        .expect("the statement itself is fine");
        assert!(result.is_none(), "a finished row is not closed again");
        let after = row(&rig.su, finished).await;
        assert_eq!(
            (after.status.clone(), after.rev),
            (before.status, before.rev)
        );
    }

    // (b) the race: a cancel lands between the decision and the send. The send transaction
    //     re-locks `attempts = k`, finds a cancelled row and does nothing — no message, no
    //     `failed` audit, and the row stays cancelled.
    let cancel_race =
        insert_schedule(&rig.su, fx.workspace, fx.channel, fx.a.id, "race", -2, None).await;
    let (http, url, token) = (
        rig.http.clone(),
        rig.workspace_url(fx.workspace, &format!("/scheduled-messages/{cancel_race}")),
        ta.clone(),
    );
    rig.memory.after_decision = Some(momo_server::scheduler::after_decision_hook(move |_, _| {
        let (http, url, token) = (http.clone(), url.clone(), token.clone());
        async move {
            let response = http
                .delete(url)
                .bearer_auth(token)
                .send()
                .await
                .expect("cancel");
            assert_eq!(response.status().as_u16(), 204, "the cancel wins the gap");
        }
    }));
    let report = rig.tick().await;
    assert_eq!(report.skipped, vec![cancel_race], "{report:?}");
    assert_eq!(row(&rig.su, cancel_race).await.status, "cancelled");
    assert_eq!(messages_of(&rig.su, cancel_race).await, 0);
    assert!(
        !audit_actions_for(&rig.su, cancel_race)
            .await
            .contains(&"scheduled_message.failed".to_string()),
        "a cancelled row is not also failed"
    );

    // …and a send-now that lands in the same gap sends; the tick's send then finds nothing to send
    let now_race = insert_schedule(
        &rig.su,
        fx.workspace,
        fx.channel,
        fx.a.id,
        "race2",
        -2,
        None,
    )
    .await;
    let (http, url, token) = (
        rig.http.clone(),
        rig.workspace_url(
            fx.workspace,
            &format!("/scheduled-messages/{now_race}/send-now"),
        ),
        ta.clone(),
    );
    rig.memory.after_decision = Some(momo_server::scheduler::after_decision_hook(move |_, _| {
        let (http, url, token) = (http.clone(), url.clone(), token.clone());
        async move {
            let response = http
                .post(url)
                .bearer_auth(token)
                .send()
                .await
                .expect("send now");
            assert_eq!(response.status().as_u16(), 200, "send-now wins the gap");
        }
    }));
    let report = rig.tick().await;
    assert_eq!(report.skipped, vec![now_race], "{report:?}");
    assert_eq!(
        messages_of(&rig.su, now_race).await,
        1,
        "one message, not two"
    );
    rig.memory.after_decision = None;

    // (c) a refusal closes the row exactly once: the author left the channel → `failed`
    //     (`not_member`), one `.failed` audit row, one revision; the next tick leaves it alone
    sqlx::query("UPDATE membership SET left_at = now() WHERE channel_id = $1 AND member_id = $2")
        .bind(fx.channel)
        .bind(fx.a.id)
        .execute(&rig.su)
        .await
        .unwrap();
    let refused = insert_schedule(
        &rig.su,
        fx.workspace,
        fx.channel,
        fx.a.id,
        "no longer allowed",
        -2,
        None,
    )
    .await;
    let report = rig.tick().await;
    assert_eq!(
        report.failed,
        vec![(refused, momo_messaging::ScheduleFailure::NotMember)],
        "{report:?}"
    );
    let after = row(&rig.su, refused).await;
    assert_eq!(
        (after.status.as_str(), after.reason.as_deref(), after.rev),
        ("failed", Some("not_member"), 1)
    );
    assert_eq!(
        audit_actions_for(&rig.su, refused)
            .await
            .iter()
            .filter(|action| action.as_str() == "scheduled_message.failed")
            .count(),
        1
    );
    assert!(
        rig.tick().await.is_quiet(),
        "a failed row is not tried again"
    );

    // (d) a refusal that arrives AFTER the message was inserted (an attachment that was used
    //     elsewhere) takes the message back with it: nothing is sent and the file stays where it was
    sqlx::query("UPDATE membership SET left_at = NULL WHERE channel_id = $1 AND member_id = $2")
        .bind(fx.channel)
        .bind(fx.a.id)
        .execute(&rig.su)
        .await
        .unwrap();
    let file = insert_attachment(&rig.su, fx.workspace, fx.channel, fx.a.id, "complete").await;
    let mut with_file = create_body("with a file", 3600);
    with_file["attachmentIds"] = json!([file]);
    let (status, created) = rig.create(&ta, fx.workspace, fx.channel, with_file).await;
    assert_eq!(status, 201, "{created}");
    let id = scheduled_id(&created);
    let elsewhere =
        insert_message(&rig.su, fx.workspace, fx.channel, fx.b.id, "took the file").await;
    sqlx::query("UPDATE attachment SET message_id = $2 WHERE id = $1")
        .bind(file)
        .bind(elsewhere)
        .execute(&rig.su)
        .await
        .unwrap();
    move_send_at(&rig.su, id, -2).await;
    let seq_before: i64 =
        sqlx::query_scalar("SELECT last_seq FROM channel_seq WHERE channel_id = $1")
            .bind(fx.channel)
            .fetch_one(&rig.su)
            .await
            .unwrap();
    let report = rig.tick().await;
    assert_eq!(
        report.failed,
        vec![(id, momo_messaging::ScheduleFailure::AttachmentUnavailable)],
        "{report:?}"
    );
    assert_eq!(
        messages_of(&rig.su, id).await,
        0,
        "the half-written message was rolled back"
    );
    let seq_after: i64 =
        sqlx::query_scalar("SELECT last_seq FROM channel_seq WHERE channel_id = $1")
            .bind(fx.channel)
            .fetch_one(&rig.su)
            .await
            .unwrap();
    assert_eq!(seq_before, seq_after, "no sequence number was spent on it");
    let linked: Option<Uuid> =
        sqlx::query_scalar("SELECT message_id FROM attachment WHERE id = $1")
            .bind(file)
            .fetch_one(&rig.su)
            .await
            .unwrap();
    assert_eq!(
        linked,
        Some(elsewhere),
        "the file stayed on the message that has it"
    );
}

// ---------------------------------------------------------------------------
// who can see and call what (D3, D6)
// ---------------------------------------------------------------------------

async fn count_as(app: &PgPool, workspace: Option<Uuid>, member: Option<Uuid>, table: &str) -> i64 {
    let mut tx = app.begin().await.expect("begin");
    if let Some(workspace) = workspace {
        sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
            .bind(workspace.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    if let Some(member) = member {
        sqlx::query("SELECT set_config('app.member_id', $1, true)")
            .bind(member.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    let count = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
        .fetch_one(&mut *tx)
        .await
        .expect("count under the scope");
    tx.rollback().await.unwrap();
    count
}

/// The SQLSTATE a statement fails with as `role` (or `None` when it succeeds).
async fn sqlstate_of(pool: &PgPool, sql: &str) -> Option<String> {
    match sqlx::query(sql).fetch_all(pool).await {
        Ok(_) => None,
        Err(sqlx::Error::Database(db)) => db.code().map(|code| code.to_string()),
        Err(other) => panic!("not a database error: {other}"),
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn scheduled_rows_are_visible_only_to_their_author() {
    let _lock = test_lock().await;
    let rig = Rig::new().await;
    let fx = fixture(&rig.su, "sm-owner").await;
    let elsewhere = fixture(&rig.su, "sm-owner-b").await;
    let (ta, tb, tadmin) = (
        rig.token(fx.workspace, &fx.a).await,
        rig.token(fx.workspace, &fx.b).await,
        rig.token(fx.workspace, &fx.admin).await,
    );
    let (_, created) = rig
        .create(
            &ta,
            fx.workspace,
            fx.channel,
            create_body("private plan", 3600),
        )
        .await;
    let id = scheduled_id(&created).to_string();

    // another member, and the workspace owner: not forbidden — absent
    for (who, token) in [("member", &tb), ("owner", &tadmin)] {
        let (status, listed) = rig.list(token, fx.workspace, "").await;
        assert_eq!(status, 200);
        assert_eq!(
            listed["scheduledMessages"],
            json!([]),
            "{who} lists nothing of A's"
        );
        assert_eq!(
            rig.patch(token, fx.workspace, &id, json!({"body": "x"}))
                .await
                .0,
            404,
            "{who}"
        );
        assert_eq!(rig.delete(token, fx.workspace, &id).await.0, 404, "{who}");
        assert_eq!(rig.send_now(token, fx.workspace, &id).await.0, 404, "{who}");
    }
    assert_eq!(
        row(&rig.su, Uuid::parse_str(&id).unwrap()).await.status,
        "pending"
    );

    // the policy itself, as `momo_app` with hand-set GUCs
    let table = "scheduled_message";
    assert_eq!(
        count_as(&rig.app, None, None, table).await,
        0,
        "no scope, no rows"
    );
    assert_eq!(
        count_as(&rig.app, Some(fx.workspace), None, table).await,
        0,
        "a workspace alone is not enough"
    );
    assert_eq!(
        count_as(&rig.app, Some(fx.workspace), Some(fx.a.id), table).await,
        1
    );
    assert_eq!(
        count_as(&rig.app, Some(fx.workspace), Some(fx.b.id), table).await,
        0,
        "another member"
    );
    assert_eq!(
        count_as(&rig.app, Some(fx.workspace), Some(fx.admin.id), table).await,
        0,
        "the owner"
    );
    assert_eq!(
        count_as(&rig.app, Some(elsewhere.workspace), Some(fx.a.id), table).await,
        0,
        "another workspace, even with the author's id"
    );
    // writes are checked too: a row cannot be filed under someone else's scope
    let mut tx = rig.app.begin().await.unwrap();
    sqlx::query(
        "SELECT set_config('app.workspace_id', $1, true), set_config('app.member_id', $2, true)",
    )
    .bind(fx.workspace.to_string())
    .bind(fx.b.id.to_string())
    .execute(&mut *tx)
    .await
    .unwrap();
    let forged = sqlx::query(
        "INSERT INTO scheduled_message (workspace_id, channel_id, author_member_id, body, send_at, client_request_id) \
         VALUES ($1, $2, $3, 'forged', now() + interval '1 hour', $4)",
    )
    .bind(fx.workspace)
    .bind(fx.channel)
    .bind(fx.a.id)
    .bind(Uuid::new_v4())
    .execute(&mut *tx)
    .await;
    match forged {
        Err(sqlx::Error::Database(db)) => assert_eq!(db.code().as_deref(), Some("42501")),
        other => panic!("a forged author must be refused by WITH CHECK: {other:?}"),
    }
    tx.rollback().await.unwrap();
    // the child table has the same policy
    let file = insert_attachment(&rig.su, fx.workspace, fx.channel, fx.a.id, "complete").await;
    let mut with_file = create_body("with file", 3600);
    with_file["attachmentIds"] = json!([file]);
    assert_eq!(
        rig.create(&ta, fx.workspace, fx.channel, with_file).await.0,
        201
    );
    let child = "scheduled_message_attachment";
    assert_eq!(
        count_as(&rig.app, Some(fx.workspace), Some(fx.a.id), child).await,
        1
    );
    assert_eq!(
        count_as(&rig.app, Some(fx.workspace), Some(fx.b.id), child).await,
        0
    );
    assert_eq!(count_as(&rig.app, None, None, child).await, 0);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_scheduler_write_runs_as_a_role_that_does_not_bypass_rls() {
    let _lock = test_lock().await;
    let rig = Rig::new().await;
    // the pool the tick uses is `momo_app` (NOBYPASSRLS): the guard says so
    momo_server::scheduler::ensure_write_pool_rls_bound(&rig.tick_pool)
        .await
        .expect("momo_app is RLS-bound");
    // …and refuses every role that is not
    for (role, password) in [
        ("momo_relay", "momo_relay_dev_pw"),
        ("momo_worker", "momo_worker_dev_pw"),
        ("momo_notifier", "momo_notifier_dev_pw"),
    ] {
        let pool = role_pool(role, password, 1).await;
        let verdict = momo_server::scheduler::ensure_write_pool_rls_bound(&pool).await;
        assert!(
            matches!(
                verdict,
                Err(momo_server::scheduler::SchedulerError::PoolBypassesRls)
            ),
            "{role} must be refused, got {verdict:?}"
        );
    }
    // the superuser, too
    assert!(momo_server::scheduler::ensure_write_pool_rls_bound(&rig.su)
        .await
        .is_err());
    // …and a tick on such a pool cannot even read the due list: the lists are `momo_app`'s alone
    let relay = role_pool("momo_relay", "momo_relay_dev_pw", 2).await;
    let mut memory = TickMemory::default();
    let outcome = run_tick(&relay, &rig.state, &rig.settings, &mut memory, &rig.stop).await;
    assert!(
        outcome.is_err(),
        "a tick on a BYPASSRLS pool reads and writes nothing"
    );

    // `start` is the one entry `main` uses. On a role that skips RLS it does not start the tick…
    let fx = fixture(&rig.su, "sm-role-guard").await;
    let token = rig.token(fx.workspace, &fx.a).await;
    let (_, stop) = watch::channel(false);
    assert_eq!(
        rig.create(
            &token,
            fx.workspace,
            fx.channel,
            create_body("before", 3600)
        )
        .await
        .0,
        201,
        "the routes accept schedules while nothing has refused the tick"
    );
    let refused =
        momo_server::scheduler::start(rig.state.clone(), relay.clone(), rig.settings, stop.clone())
            .await;
    assert!(refused.is_none(), "no tick on a BYPASSRLS pool");
    // …and says so on the wire: a server that will not send a schedule must not accept one
    // (the same 503 as the operator's off switch); listing and deleting still work
    let (status, value) = rig
        .create(&token, fx.workspace, fx.channel, create_body("after", 3600))
        .await;
    assert_eq!(
        (status, error_code(&value)),
        (503, Some("scheduler_disabled")),
        "{value}"
    );
    let (status, listed) = rig.list(&token, fx.workspace, "").await;
    assert_eq!(status, 200);
    let kept = listed["scheduledMessages"][0]["id"]
        .as_str()
        .expect("the earlier schedule is still listed")
        .to_string();
    assert_eq!(
        rig.patch(&token, fx.workspace, &kept, json!({"body": "x"}))
            .await
            .0,
        503
    );
    assert_eq!(rig.send_now(&token, fx.workspace, &kept).await.0, 503);
    assert_eq!(rig.delete(&token, fx.workspace, &kept).await.0, 204);
    // an RLS-bound pool starts the tick and lifts the block
    let (stop_tx, stop_rx) = watch::channel(false);
    let mut settings = rig.settings;
    settings.tick_ms = 1000;
    let running =
        momo_server::scheduler::start(rig.state.clone(), rig.tick_pool.clone(), settings, stop_rx)
            .await
            .expect("momo_app starts the tick");
    assert_eq!(
        rig.create(&token, fx.workspace, fx.channel, create_body("again", 3600))
            .await
            .0,
        201,
        "the routes accept schedules again once a tick runs"
    );
    // …and the loop ends when it is told to, promptly, and also when its sender is gone
    stop_tx.send(true).expect("signal the tick to stop");
    tokio::time::timeout(std::time::Duration::from_secs(10), running)
        .await
        .expect("the tick stops within seconds of the signal")
        .expect("the tick task did not panic");
    let (orphan_tx, orphan_rx) = watch::channel(false);
    let orphan = momo_server::scheduler::start(
        rig.state.clone(),
        rig.tick_pool.clone(),
        settings,
        orphan_rx,
    )
    .await
    .expect("starts");
    drop(orphan_tx);
    tokio::time::timeout(std::time::Duration::from_secs(10), orphan)
        .await
        .expect("a tick whose stop sender is gone ends instead of spinning")
        .expect("no panic");
}

/// A schedule row inserted straight into a finished state (the retention and definer tests).
async fn insert_finished(
    su: &PgPool,
    fx: &Fixture,
    status: &str,
    age_days: i64,
    message: Option<Uuid>,
) -> Uuid {
    let id = Uuid::new_v4();
    let (body, reason, sent_message, sent_at): (Option<&str>, Option<&str>, Option<Uuid>, bool) =
        match status {
            "sent" => (None, None, message, true),
            "cancelled" => (None, None, None, false),
            "failed" => (Some("kept for a month"), Some("missed"), None, false),
            other => panic!("not a finished state: {other}"),
        };
    sqlx::query(
        "INSERT INTO scheduled_message \
           (id, workspace_id, channel_id, author_member_id, body, send_at, status, failure_reason, \
            sent_message_id, sent_at, client_request_id, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, now() - make_interval(days => $6 + 1), $7, $8, $9, \
                 CASE WHEN $10 THEN now() - make_interval(days => $6) END, $11, \
                 now() - make_interval(days => $6 + 1), now() - make_interval(days => $6))",
    )
    .bind(id)
    .bind(fx.workspace)
    .bind(fx.channel)
    .bind(fx.a.id)
    .bind(body)
    .bind(age_days as i32)
    .bind(status)
    .bind(reason)
    .bind(sent_message)
    .bind(sent_at)
    .bind(Uuid::new_v4())
    .execute(su)
    .await
    .expect("seed a finished schedule");
    id
}

async fn probe_as_definer(su: &PgPool, sql: &str) -> Result<Vec<Uuid>, String> {
    let mut tx = su.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE momo_sched_definer")
        .execute(&mut *tx)
        .await
        .unwrap();
    let result = sqlx::query(sql).fetch_all(&mut *tx).await;
    let _ = tx.rollback().await;
    match result {
        Ok(rows) => Ok(rows
            .iter()
            .filter_map(|row| row.try_get::<Uuid, _>(0).ok())
            .collect()),
        Err(sqlx::Error::Database(db)) => Err(db.code().map(|c| c.to_string()).unwrap_or_default()),
        Err(other) => panic!("not a database error: {other}"),
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_due_functions_owner_cannot_read_bodies_and_sees_only_due_or_expired_rows() {
    let _lock = test_lock().await;
    let rig = Rig::new().await;
    let fx = fixture(&rig.su, "sm-definer").await;
    let message = insert_message(&rig.su, fx.workspace, fx.channel, fx.a.id, "went out").await;

    let due = insert_schedule(
        &rig.su,
        fx.workspace,
        fx.channel,
        fx.a.id,
        "due body",
        -5,
        None,
    )
    .await;
    let future = insert_schedule(
        &rig.su,
        fx.workspace,
        fx.channel,
        fx.a.id,
        "future body",
        3600,
        None,
    )
    .await;
    let backing_off = insert_schedule(
        &rig.su,
        fx.workspace,
        fx.channel,
        fx.a.id,
        "backing off",
        -5,
        None,
    )
    .await;
    sqlx::query(
        "UPDATE scheduled_message SET next_attempt_at = now() + interval '1 minute' WHERE id = $1",
    )
    .bind(backing_off)
    .execute(&rig.su)
    .await
    .unwrap();
    let recent_sent = insert_finished(&rig.su, &fx, "sent", 1, Some(message)).await;
    let old_sent = insert_finished(&rig.su, &fx, "sent", 8, Some(message)).await;
    let old_cancelled = insert_finished(&rig.su, &fx, "cancelled", 8, None).await;
    let recent_failed = insert_finished(&rig.su, &fx, "failed", 29, None).await;
    let old_failed = insert_finished(&rig.su, &fx, "failed", 31, None).await;

    // what the owner can see: due pending rows and rows past retention — nothing else
    let visible = probe_as_definer(&rig.su, "SELECT id FROM scheduled_message")
        .await
        .expect("the id column is readable");
    let mut expected = vec![due, old_sent, old_cancelled, old_failed];
    let mut visible_sorted = visible.clone();
    visible_sorted.sort();
    expected.sort();
    assert_eq!(visible_sorted, expected, "visible rows");
    for hidden in [future, backing_off, recent_sent, recent_failed] {
        assert!(
            !visible.contains(&hidden),
            "{hidden} must not be visible to the definer"
        );
    }
    // …and what it can read of them: seven columns, no body, channel or root
    for column in [
        "body",
        "channel_id",
        "root_id",
        "failure_reason",
        "client_request_id",
        "armed_session_id",
        "sent_message_id",
    ] {
        assert_eq!(
            probe_as_definer(&rig.su, &format!("SELECT {column} FROM scheduled_message")).await,
            Err("42501".to_string()),
            "{column} must be unreadable"
        );
    }
    assert_eq!(
        probe_as_definer(&rig.su, "SELECT * FROM scheduled_message").await,
        Err("42501".to_string())
    );
    assert!(
        probe_as_definer(&rig.su, "SELECT id FROM message LIMIT 1")
            .await
            .is_err(),
        "it reaches no other table"
    );
    assert_eq!(
        probe_as_definer(
            &rig.su,
            "UPDATE scheduled_message SET attempts = 0 RETURNING id"
        )
        .await,
        Err("42501".to_string()),
        "and writes nothing"
    );

    // the posture of the role and of the functions it owns
    let posture = sqlx::query(
        "SELECT r.rolsuper, r.rolbypassrls, r.rolcanlogin, \
                (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'momo_schedule_private'::regnamespace \
                    AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'momo_sched_definer') AS owned, \
                (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'momo_schedule_private'::regnamespace) AS total \
           FROM pg_roles r WHERE r.rolname = 'momo_sched_definer'",
    )
    .fetch_one(&rig.su)
    .await
    .unwrap();
    assert!(!posture.get::<bool, _>("rolsuper"), "not a superuser");
    assert!(!posture.get::<bool, _>("rolbypassrls"), "not BYPASSRLS");
    assert!(!posture.get::<bool, _>("rolcanlogin"), "not a login role");
    assert_eq!(posture.get::<i64, _>("total"), 2);
    assert_eq!(
        posture.get::<i64, _>("owned"),
        2,
        "both functions are SECURITY DEFINER and owned by it"
    );
    let members: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE g.rolname = 'momo_sched_definer'",
    )
    .fetch_one(&rig.su)
    .await
    .unwrap();
    assert_eq!(members, 0, "no runtime role is a member of it");

    // what the functions hand to `momo_app`: ids, no more
    let mut conn = rig.app.acquire().await.unwrap();
    let due_rows = momo_messaging::due_schedules(&mut conn, 100).await.unwrap();
    assert_eq!(
        due_rows
            .iter()
            .map(|r| r.scheduled_message_id)
            .collect::<Vec<_>>(),
        vec![due]
    );
    let expired_rows = momo_messaging::expired_schedules(&mut conn, 100)
        .await
        .unwrap();
    let mut expired_ids: Vec<Uuid> = expired_rows
        .iter()
        .map(|r| r.scheduled_message_id)
        .collect();
    expired_ids.sort();
    let mut expected_expired = vec![old_sent, old_cancelled, old_failed];
    expected_expired.sort();
    assert_eq!(expired_ids, expected_expired);
    let columns: Vec<String> = sqlx::query_scalar(
        "SELECT a.attname::text FROM pg_proc p, unnest(p.proargnames) WITH ORDINALITY AS a(attname, n) \
          WHERE p.proname = 'due_scheduled_messages' AND p.pronamespace = 'momo_schedule_private'::regnamespace \
            AND p.proargmodes[a.n] = 't' ORDER BY a.n",
    )
    .fetch_all(&rig.su)
    .await
    .unwrap();
    assert_eq!(
        columns,
        vec!["workspace_id", "scheduled_message_id", "author_member_id"]
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn only_momo_app_may_call_the_due_functions() {
    let _lock = test_lock().await;
    let rig = Rig::new().await;
    let calls = [
        "SELECT * FROM momo_schedule_private.due_scheduled_messages(5)",
        "SELECT * FROM momo_schedule_private.expired_scheduled_messages(5)",
    ];
    for (role, password) in [
        ("momo_relay", "momo_relay_dev_pw"),
        ("momo_worker", "momo_worker_dev_pw"),
        ("momo_notifier", "momo_notifier_dev_pw"),
    ] {
        let pool = role_pool(role, password, 1).await;
        for call in calls {
            assert_eq!(
                sqlstate_of(&pool, call).await.as_deref(),
                Some("42501"),
                "{role} must not enumerate schedules ({call})"
            );
        }
    }
    for call in calls {
        assert_eq!(
            sqlstate_of(&rig.app, call).await,
            None,
            "momo_app may call it"
        );
    }
    let public_may: bool = sqlx::query_scalar(
        "SELECT has_function_privilege('public', 'momo_schedule_private.due_scheduled_messages(integer)', 'EXECUTE')",
    )
    .fetch_one(&rig.su)
    .await
    .unwrap();
    assert!(!public_may, "PUBLIC holds no EXECUTE");

    // the bootstrap re-seals what a careless GRANT opened, and re-grants what a REVOKE took away…
    sqlx::query(
        "GRANT EXECUTE ON FUNCTION momo_schedule_private.due_scheduled_messages(integer) TO PUBLIC",
    )
    .execute(&rig.su)
    .await
    .unwrap();
    sqlx::query("GRANT USAGE ON SCHEMA momo_schedule_private TO PUBLIC")
        .execute(&rig.su)
        .await
        .unwrap();
    sqlx::query("REVOKE EXECUTE ON FUNCTION momo_schedule_private.expired_scheduled_messages(integer) FROM momo_app")
        .execute(&rig.su)
        .await
        .unwrap();
    assert!(
        apply_sql_file("../../../infra/rust/sql/bootstrap_roles.sql").success(),
        "the bootstrap re-applies"
    );
    let relay = role_pool("momo_relay", "momo_relay_dev_pw", 1).await;
    assert_eq!(
        sqlstate_of(&relay, calls[0]).await.as_deref(),
        Some("42501"),
        "the bootstrap took the PUBLIC grant back"
    );
    assert_eq!(
        sqlstate_of(&rig.app, calls[1]).await,
        None,
        "…and gave momo_app its EXECUTE back"
    );

    // …and it fails loudly when the definer is no longer what it must be: a role that can log in
    // would make the function a way in
    sqlx::query("ALTER ROLE momo_sched_definer LOGIN")
        .execute(&rig.su)
        .await
        .unwrap();
    let status = apply_sql_file("../../../infra/rust/sql/bootstrap_roles.sql");
    sqlx::query("ALTER ROLE momo_sched_definer NOLOGIN")
        .execute(&rig.su)
        .await
        .unwrap();
    assert!(
        !status.success(),
        "the bootstrap's self-check refused a login-capable definer"
    );
    // restored: the next apply is clean again
    assert!(apply_sql_file("../../../infra/rust/sql/bootstrap_roles.sql").success());
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn bodies_are_unreachable_for_the_bypassrls_roles_and_momo_app_keeps_all_four_privileges() {
    let _lock = test_lock().await;
    let rig = Rig::new().await;
    let fx = fixture(&rig.su, "sm-seal").await;
    let id = insert_schedule(
        &rig.su,
        fx.workspace,
        fx.channel,
        fx.a.id,
        "top secret plan",
        3600,
        None,
    )
    .await;
    let file = insert_attachment(&rig.su, fx.workspace, fx.channel, fx.a.id, "complete").await;
    sqlx::query(
        "INSERT INTO scheduled_message_attachment (scheduled_message_id, workspace_id, member_id, attachment_id, position) \
         VALUES ($1, $2, $3, $4, 0)",
    )
    .bind(id)
    .bind(fx.workspace)
    .bind(fx.a.id)
    .bind(file)
    .execute(&rig.su)
    .await
    .unwrap();

    // BYPASSRLS skips the policies, so the table privileges are the seal
    for (role, password) in [
        ("momo_relay", "momo_relay_dev_pw"),
        ("momo_worker", "momo_worker_dev_pw"),
        ("momo_notifier", "momo_notifier_dev_pw"),
    ] {
        let pool = role_pool(role, password, 1).await;
        for sql in [
            "SELECT body FROM scheduled_message",
            "SELECT count(*) FROM scheduled_message",
            "SELECT count(*) FROM scheduled_message_attachment",
            "UPDATE scheduled_message SET body = 'x'",
            "DELETE FROM scheduled_message",
            "INSERT INTO scheduled_message_attachment (scheduled_message_id) VALUES (gen_random_uuid())",
        ] {
            assert_eq!(
                sqlstate_of(&pool, sql).await.as_deref(),
                Some("42501"),
                "{role}: {sql}"
            );
        }
    }
    // `momo_app` keeps SELECT, INSERT, UPDATE **and DELETE** on both
    for table in ["scheduled_message", "scheduled_message_attachment"] {
        for privilege in ["SELECT", "INSERT", "UPDATE", "DELETE"] {
            let held: bool = sqlx::query_scalar("SELECT has_table_privilege('momo_app', $1, $2)")
                .bind(table)
                .bind(privilege)
                .fetch_one(&rig.su)
                .await
                .unwrap();
            assert!(held, "momo_app must hold {privilege} on {table}");
        }
        for privilege in ["TRUNCATE", "REFERENCES", "TRIGGER"] {
            let held: bool = sqlx::query_scalar("SELECT has_table_privilege('momo_app', $1, $2)")
                .bind(table)
                .bind(privilege)
                .fetch_one(&rig.su)
                .await
                .unwrap();
            assert!(!held, "momo_app must not hold {privilege} on {table}");
        }
    }
    // it can really delete (the retention sweep does it as `momo_app`)
    let mut tx = rig.app.begin().await.unwrap();
    sqlx::query(
        "SELECT set_config('app.workspace_id', $1, true), set_config('app.member_id', $2, true)",
    )
    .bind(fx.workspace.to_string())
    .bind(fx.a.id.to_string())
    .execute(&mut *tx)
    .await
    .unwrap();
    let deleted = sqlx::query("DELETE FROM scheduled_message WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .unwrap()
        .rows_affected();
    assert_eq!(deleted, 1);
    tx.rollback().await.unwrap();

    // the three files carry one and the same lockdown block
    let block = |relative: &str| {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative);
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path:?}: {e}"));
        let begin = text
            .find("-- BEGIN scheduled-message-lockdown")
            .expect("begin marker");
        let end = text
            .find("-- END scheduled-message-lockdown")
            .expect("end marker");
        text[begin..end].to_string()
    };
    let migration = block("../../../server/Migrations/145_scheduled_message.sql");
    assert_eq!(
        migration,
        block("../../../infra/rust/sql/bootstrap_roles.sql")
    );
    assert_eq!(
        migration,
        block("../../../infra/rust/sql/bootstrap_runtime_roles.sql")
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_due_functions_work_on_a_connection_that_already_ran_a_tenant_tx() {
    let _lock = test_lock().await;
    let rig = Rig::new().await;
    let fx = fixture(&rig.su, "sm-guc").await;
    let due = insert_schedule(&rig.su, fx.workspace, fx.channel, fx.a.id, "due", -5, None).await;

    // ONE connection, so the pool hands the same one back: after a tenant transaction its GUC
    // placeholders are `''`, and `''::uuid` is a 22P02 unless the policy reads them through NULLIF
    let pool = momo_app_pool(1).await;
    let (workspace, member) = (fx.workspace, fx.a.id);
    let own = momo_db::with_tenant_tx(&pool, workspace, move |conn| {
        Box::pin(async move {
            momo_messaging::bind_owner_guc(conn, member).await?;
            let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM scheduled_message")
                .fetch_one(&mut *conn)
                .await?;
            Ok(rows)
        })
    })
    .await
    .unwrap();
    assert_eq!(
        own, 1,
        "the author sees their row inside the tenant transaction"
    );
    let mut conn = pool.acquire().await.unwrap();
    let leftover: Option<String> =
        sqlx::query_scalar("SELECT current_setting('app.workspace_id', true)")
            .fetch_one(&mut *conn)
            .await
            .unwrap();
    assert_eq!(
        leftover.as_deref(),
        Some(""),
        "the scenario is real: the pooled connection carries an empty placeholder"
    );
    // the functions answer, and a direct read says "no rows", not an error
    let found = momo_messaging::due_schedules(&mut conn, 100)
        .await
        .expect("no 22P02");
    assert_eq!(
        found
            .iter()
            .map(|r| r.scheduled_message_id)
            .collect::<Vec<_>>(),
        vec![due]
    );
    assert!(momo_messaging::expired_schedules(&mut conn, 100)
        .await
        .expect("no 22P02")
        .is_empty());
    let direct: i64 = sqlx::query_scalar("SELECT count(*) FROM scheduled_message")
        .fetch_one(&mut *conn)
        .await
        .expect("a policy that cannot error on an empty scope");
    assert_eq!(direct, 0);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_large_backlog_in_one_workspace_does_not_starve_the_others() {
    let _lock = test_lock().await;
    let rig = Rig::new().await;
    let big = fixture(&rig.su, "sm-fair-big").await;
    let small_one = fixture(&rig.su, "sm-fair-one").await;
    let small_two = fixture(&rig.su, "sm-fair-two").await;
    // sixty overdue rows in one workspace, all OLDER than the single rows of the other two
    sqlx::query(
        "INSERT INTO scheduled_message (workspace_id, channel_id, author_member_id, body, send_at, client_request_id) \
         SELECT $1, $2, $3, 'backlog ' || n, now() - make_interval(secs => 1800 - n), gen_random_uuid() \
           FROM generate_series(1, 60) AS n",
    )
    .bind(big.workspace)
    .bind(big.channel)
    .bind(big.a.id)
    .execute(&rig.su)
    .await
    .unwrap();
    let one = insert_schedule(
        &rig.su,
        small_one.workspace,
        small_one.channel,
        small_one.a.id,
        "one",
        -3,
        None,
    )
    .await;
    let two = insert_schedule(
        &rig.su,
        small_two.workspace,
        small_two.channel,
        small_two.a.id,
        "two",
        -2,
        None,
    )
    .await;

    let mut conn = rig.app.acquire().await.unwrap();
    // a batch of three: the first row of EACH workspace, not the three oldest of the big one
    let first = momo_messaging::due_schedules(&mut conn, 3).await.unwrap();
    let workspaces: std::collections::HashSet<Uuid> =
        first.iter().map(|r| r.workspace_id).collect();
    assert_eq!(
        workspaces,
        [big.workspace, small_one.workspace, small_two.workspace]
            .into_iter()
            .collect(),
        "every workspace is in the first batch: {first:?}"
    );
    // a big batch is still capped at 25 per workspace
    let all = momo_messaging::due_schedules(&mut conn, 200).await.unwrap();
    let from_big = all
        .iter()
        .filter(|r| r.workspace_id == big.workspace)
        .count();
    assert_eq!(
        from_big, 25,
        "one workspace's backlog is cut at 25 per look"
    );
    assert!(
        all.iter().any(|r| r.scheduled_message_id == one)
            && all.iter().any(|r| r.scheduled_message_id == two)
    );
    drop(conn);

    // and the tick, with a batch of three, reaches the small ones before it has worked the big one down
    let mut rig = rig;
    rig.settings.batch = 3;
    let report = rig.tick().await;
    let position = |id: Uuid| {
        report
            .sent
            .iter()
            .position(|sent| *sent == id)
            .unwrap_or(usize::MAX)
    };
    assert!(
        position(one) < 3 && position(two) < 3,
        "the small workspaces went out first: {:?}",
        &report.sent[..6.min(report.sent.len())]
    );
    assert_eq!(
        report.sent.len(),
        62,
        "and the whole backlog went out in the end"
    );
}

// ---------------------------------------------------------------------------
// the same path as a REST send, the eight reasons, the poison row
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_scheduled_mention_starts_the_same_agent_run_as_a_rest_send() {
    let _lock = test_lock().await;
    let mut rig = Rig::new().await;
    let fx = fixture(&rig.su, "sm-mention").await;
    let agent = seed_agent(&rig.su, fx.workspace, fx.admin.id, "robot").await;
    join_channel(&rig.su, fx.workspace, fx.channel, agent).await;
    let ta = rig.token(fx.workspace, &fx.a).await;

    // the baseline: the same words as a REST send
    let (status, rest) = rig
        .rest_send(
            &ta,
            fx.workspace,
            fx.channel,
            Uuid::new_v4(),
            "@robot please look",
        )
        .await;
    assert_eq!(status, 201, "{rest}");
    // …and as a schedule that the tick sends
    let id = insert_schedule(
        &rig.su,
        fx.workspace,
        fx.channel,
        fx.a.id,
        "@robot please look",
        -2,
        None,
    )
    .await;
    let report = rig.tick().await;
    assert_eq!(report.sent, vec![id], "{report:?}");

    let runs = sqlx::query(
        "SELECT agent_member_id, status::text AS status, input, idempotency_key, trigger_message_id \
           FROM agent_run WHERE workspace_id = $1 ORDER BY created_at",
    )
    .bind(fx.workspace)
    .fetch_all(&rig.su)
    .await
    .unwrap();
    assert_eq!(
        runs.len(),
        2,
        "one run for the REST send and one for the scheduled one"
    );
    let shape = |row: &sqlx::postgres::PgRow| {
        let input: Value = row.get("input");
        let mut keys: Vec<String> = input
            .as_object()
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default();
        keys.sort();
        (
            row.get::<Uuid, _>("agent_member_id"),
            row.get::<String, _>("status"),
            keys,
            row.get::<Option<String>, _>("idempotency_key")
                .map(|key| key.split(':').next().unwrap_or_default().to_string()),
        )
    };
    assert_eq!(
        shape(&runs[0]),
        shape(&runs[1]),
        "the scheduled call is the REST call"
    );
    assert_eq!(runs[0].get::<Uuid, _>("agent_member_id"), agent);
    let triggers: Vec<Uuid> = runs.iter().map(|r| r.get("trigger_message_id")).collect();
    assert_ne!(
        triggers[0], triggers[1],
        "each run points at its own message"
    );
    assert_eq!(
        triggers[1],
        row(&rig.su, id).await.sent_message_id.unwrap(),
        "the scheduled run is triggered by the message that went out"
    );
    // the job the worker claims, one each, with the same method and partition
    let jobs = sqlx::query(
        "SELECT method, partition_key IS NOT NULL AS partitioned FROM outbox \
          WHERE workspace_id = $1 AND kind = 'agent_job' ORDER BY id",
    )
    .bind(fx.workspace)
    .fetch_all(&rig.su)
    .await
    .unwrap();
    assert_eq!(jobs.len(), 2);
    assert_eq!(
        (
            jobs[0].get::<String, _>("method"),
            jobs[0].get::<bool, _>("partitioned")
        ),
        (
            jobs[1].get::<String, _>("method"),
            jobs[1].get::<bool, _>("partitioned")
        )
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn each_failure_reason_is_named_and_the_grace_boundary_holds() {
    let _lock = test_lock().await;
    let mut rig = Rig::with_settings(SchedulerSettings {
        grace_seconds: 300,
        ..SchedulerSettings::default()
    })
    .await;
    let fx = fixture(&rig.su, "sm-reasons").await;
    use momo_messaging::ScheduleFailure as Reason;

    // a fresh channel per case, so one case's membership change is not another's
    async fn fresh_channel(su: &PgPool, fx: &Fixture) -> Uuid {
        seed_channel(
            su,
            fx.workspace,
            fx.admin.id,
            &[fx.admin.id, fx.a.id, fx.b.id],
        )
        .await
    }
    fn expect_failed(report: &TickReport, id: Uuid, reason: Reason) {
        assert_eq!(report.failed, vec![(id, reason)], "{report:?}");
    }

    // not_member
    let channel = fresh_channel(&rig.su, &fx).await;
    sqlx::query("UPDATE membership SET left_at = now() WHERE channel_id = $1 AND member_id = $2")
        .bind(channel)
        .bind(fx.a.id)
        .execute(&rig.su)
        .await
        .unwrap();
    let id = insert_schedule(&rig.su, fx.workspace, channel, fx.a.id, "left", -2, None).await;
    let report = rig.tick().await;
    expect_failed(&report, id, Reason::NotMember);
    assert_eq!(row(&rig.su, id).await.reason.as_deref(), Some("not_member"));

    // root_unavailable: the message it replies to was deleted
    let channel = fresh_channel(&rig.su, &fx).await;
    let root = insert_message(&rig.su, fx.workspace, channel, fx.b.id, "root").await;
    sqlx::query(
        "UPDATE message SET deleted_at = now(), state = 'deleted', body = NULL WHERE id = $1",
    )
    .bind(root)
    .execute(&rig.su)
    .await
    .unwrap();
    let id = insert_schedule(&rig.su, fx.workspace, channel, fx.a.id, "reply", -2, None).await;
    sqlx::query("UPDATE scheduled_message SET root_id = $2 WHERE id = $1")
        .bind(id)
        .bind(root)
        .execute(&rig.su)
        .await
        .unwrap();
    let report = rig.tick().await;
    expect_failed(&report, id, Reason::RootUnavailable);

    // attachment_unavailable: the file was used by another message after it was reserved
    let channel = fresh_channel(&rig.su, &fx).await;
    let file = insert_attachment(&rig.su, fx.workspace, channel, fx.a.id, "complete").await;
    let id = insert_schedule(&rig.su, fx.workspace, channel, fx.a.id, "file", -2, None).await;
    sqlx::query(
        "INSERT INTO scheduled_message_attachment (scheduled_message_id, workspace_id, member_id, attachment_id, position) \
         VALUES ($1, $2, $3, $4, 0)",
    )
    .bind(id)
    .bind(fx.workspace)
    .bind(fx.a.id)
    .bind(file)
    .execute(&rig.su)
    .await
    .unwrap();
    let used_by = insert_message(&rig.su, fx.workspace, channel, fx.b.id, "took it").await;
    sqlx::query("UPDATE attachment SET message_id = $2 WHERE id = $1")
        .bind(file)
        .bind(used_by)
        .execute(&rig.su)
        .await
        .unwrap();
    let report = rig.tick().await;
    expect_failed(&report, id, Reason::AttachmentUnavailable);
    assert_eq!(messages_of(&rig.su, id).await, 0);

    // author_inactive: suspended at send time
    let channel = fresh_channel(&rig.su, &fx).await;
    let id = insert_schedule(
        &rig.su,
        fx.workspace,
        channel,
        fx.a.id,
        "suspended",
        -2,
        None,
    )
    .await;
    sqlx::query("UPDATE member SET status = 'suspended' WHERE id = $1")
        .bind(fx.a.id)
        .execute(&rig.su)
        .await
        .unwrap();
    let report = rig.tick().await;
    sqlx::query("UPDATE member SET status = 'active' WHERE id = $1")
        .bind(fx.a.id)
        .execute(&rig.su)
        .await
        .unwrap();
    expect_failed(&report, id, Reason::AuthorInactive);

    // ── the order the reasons are judged in (D8): a deleted workspace, the grace window, an inactive
    //    author, membership, the thread root, and only then the send itself
    // an author who is both suspended and gone from the channel is `author_inactive`
    let channel = fresh_channel(&rig.su, &fx).await;
    sqlx::query("UPDATE membership SET left_at = now() WHERE channel_id = $1 AND member_id = $2")
        .bind(channel)
        .bind(fx.a.id)
        .execute(&rig.su)
        .await
        .unwrap();
    let id = insert_schedule(&rig.su, fx.workspace, channel, fx.a.id, "both", -2, None).await;
    sqlx::query("UPDATE member SET status = 'suspended' WHERE id = $1")
        .bind(fx.a.id)
        .execute(&rig.su)
        .await
        .unwrap();
    let report = rig.tick().await;
    sqlx::query("UPDATE member SET status = 'active' WHERE id = $1")
        .bind(fx.a.id)
        .execute(&rig.su)
        .await
        .unwrap();
    expect_failed(&report, id, Reason::AuthorInactive);
    // a member who left a channel whose thread root is also gone is `not_member`, not `root_unavailable`
    let channel = fresh_channel(&rig.su, &fx).await;
    let root = insert_message(&rig.su, fx.workspace, channel, fx.b.id, "root").await;
    sqlx::query(
        "UPDATE message SET deleted_at = now(), state = 'deleted', body = NULL WHERE id = $1",
    )
    .bind(root)
    .execute(&rig.su)
    .await
    .unwrap();
    sqlx::query("UPDATE membership SET left_at = now() WHERE channel_id = $1 AND member_id = $2")
        .bind(channel)
        .bind(fx.a.id)
        .execute(&rig.su)
        .await
        .unwrap();
    let id = insert_schedule(
        &rig.su,
        fx.workspace,
        channel,
        fx.a.id,
        "left and orphaned",
        -2,
        None,
    )
    .await;
    sqlx::query("UPDATE scheduled_message SET root_id = $2 WHERE id = $1")
        .bind(id)
        .bind(root)
        .execute(&rig.su)
        .await
        .unwrap();
    let report = rig.tick().await;
    expect_failed(&report, id, Reason::NotMember);
    // a deleted workspace comes before the grace window: its row is cancelled, not `missed`
    let gone = fixture(&rig.su, "sm-reasons-gone").await;
    let id = insert_schedule(
        &rig.su,
        gone.workspace,
        gone.channel,
        gone.a.id,
        "late and orphaned",
        -400,
        None,
    )
    .await;
    sqlx::query("UPDATE workspace SET deleted_at = now() WHERE id = $1")
        .bind(gone.workspace)
        .execute(&rig.su)
        .await
        .unwrap();
    let report = rig.tick().await;
    assert_eq!(report.cancelled, vec![id], "{report:?}");
    assert!(report.failed.is_empty(), "{report:?}");

    // sessions_ended: held by the lifecycle hook (exercised through the routes below); here the
    // reason is checked to be a value the row accepts and the tick never picks up
    let channel = fresh_channel(&rig.su, &fx).await;
    let held = insert_schedule(&rig.su, fx.workspace, channel, fx.a.id, "held", -2, None).await;
    let (workspace, member) = (fx.workspace, fx.a.id);
    // every pending row and every failed row of this member that is not already held
    let open_rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM scheduled_message WHERE author_member_id = $1 \
            AND (status = 'pending' OR (status = 'failed' AND failure_reason <> 'sessions_ended'))",
    )
    .bind(fx.a.id)
    .fetch_one(&rig.su)
    .await
    .unwrap();
    assert!(
        open_rows >= 6,
        "the cases above left a failed row of each kind: {open_rows}"
    );
    let changed = momo_db::with_tenant_tx(&rig.app, workspace, move |conn| {
        Box::pin(async move {
            momo_messaging::hold_member_schedules_in_tx(conn, workspace, member).await
        })
    })
    .await
    .unwrap();
    // the pending row AND every failed row of the member, whatever it failed for: whatever a
    // stolen session may have left behind must be re-read by its author before it goes out
    assert_eq!(changed.len() as i64, open_rows, "{changed:?}");
    assert!(changed
        .iter()
        .all(|row| row.failure_reason == Some(Reason::SessionsEnded)));
    assert_eq!(
        row(&rig.su, held).await.reason.as_deref(),
        Some("sessions_ended")
    );
    assert!(
        rig.tick().await.is_quiet(),
        "a held row waits for its author"
    );

    // the closed set: the column's CHECK names exactly the eight codes the code knows
    let definition: String = sqlx::query_scalar(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'scheduled_message_reason_ck'",
    )
    .fetch_one(&rig.su)
    .await
    .unwrap();
    for reason in Reason::ALL {
        assert!(
            definition.contains(&format!("'{}'", reason.as_code())),
            "{} in {definition}",
            reason.as_code()
        );
    }
    assert_eq!(
        definition.matches("::text").count(),
        8,
        "no ninth code: {definition}"
    );

    // ── transient errors: the attempt is recorded, backs off 5 s · 15 s · 45 s, and the grace window
    //    closes the row as `send_error` once somebody has tried (and `missed` when nobody has)
    let channel = fresh_channel(&rig.su, &fx).await;
    let id = insert_schedule(&rig.su, fx.workspace, channel, fx.a.id, "flaky", -2, None).await;
    sqlx::query("DELETE FROM channel_seq WHERE channel_id = $1")
        .bind(channel)
        .execute(&rig.su)
        .await
        .unwrap();
    let expect_backoff = |snap: Snap, attempts: i32, low: f64, high: f64| {
        assert_eq!((snap.status.as_str(), snap.attempts), ("pending", attempts));
        let wait = snap.next_attempt_in_secs.expect("a backoff is set");
        assert!(
            wait > low && wait < high,
            "attempt {attempts} backs off {wait}s, expected ({low}, {high})"
        );
    };
    let report = rig.tick().await;
    assert_eq!(report.deferred, vec![id], "{report:?}");
    expect_backoff(row(&rig.su, id).await, 1, 3.0, 5.5);
    assert!(
        rig.tick().await.is_quiet(),
        "inside the backoff the row is not due"
    );
    assert_eq!(
        row(&rig.su, id).await.attempts,
        1,
        "and nobody counted another attempt"
    );
    for (attempts, low, high) in [
        (2, 13.0, 15.5),
        (3, 43.0, 45.5),
        (4, 118.0, 120.5),
        (5, 298.0, 300.5),
    ] {
        sqlx::query("UPDATE scheduled_message SET next_attempt_at = now() - interval '1 second' WHERE id = $1")
            .bind(id)
            .execute(&rig.su)
            .await
            .unwrap();
        let report = rig.tick().await;
        assert_eq!(report.deferred, vec![id], "{report:?}");
        expect_backoff(row(&rig.su, id).await, attempts, low, high);
    }
    // the grace window ends: five attempts were made, so it is `send_error`, not `missed`
    move_send_at(&rig.su, id, -301).await;
    sqlx::query("UPDATE scheduled_message SET next_attempt_at = NULL WHERE id = $1")
        .bind(id)
        .execute(&rig.su)
        .await
        .unwrap();
    let report = rig.tick().await;
    expect_failed(&report, id, Reason::SendError);
    let closed = row(&rig.su, id).await;
    assert_eq!(
        (closed.attempts, closed.body.as_deref()),
        (5, Some("flaky")),
        "no sixth attempt; the text is kept"
    );

    // `missed`: nobody ever tried (attempts = 0) and the window is over
    let channel = fresh_channel(&rig.su, &fx).await;
    let missed = insert_schedule(
        &rig.su,
        fx.workspace,
        channel,
        fx.a.id,
        "slept through",
        -301,
        None,
    )
    .await;
    let report = rig.tick().await;
    expect_failed(&report, missed, Reason::Missed);
    assert_eq!(
        row(&rig.su, missed).await.attempts,
        0,
        "closing it is not an attempt"
    );

    // the edge, one second either side of the window
    let channel = fresh_channel(&rig.su, &fx).await;
    let inside = insert_schedule(
        &rig.su,
        fx.workspace,
        channel,
        fx.a.id,
        "just in time",
        -299,
        None,
    )
    .await;
    let outside = insert_schedule(
        &rig.su,
        fx.workspace,
        channel,
        fx.a.id,
        "just too late",
        -301,
        None,
    )
    .await;
    let report = rig.tick().await;
    assert_eq!(report.sent, vec![inside], "{report:?}");
    assert_eq!(report.failed, vec![(outside, Reason::Missed)], "{report:?}");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_poison_row_does_not_stop_the_tick() {
    let _lock = test_lock().await;
    let mut rig = Rig::new().await;
    let fx = fixture(&rig.su, "sm-poison").await;

    // a row whose decision transaction can never commit: `attempts + 1` overflows. It is the
    // oldest, so the tick meets it first.
    let poison = insert_schedule(
        &rig.su,
        fx.workspace,
        fx.channel,
        fx.a.id,
        "poison",
        -20,
        None,
    )
    .await;
    sqlx::query("UPDATE scheduled_message SET attempts = 2147483647 WHERE id = $1")
        .bind(poison)
        .execute(&rig.su)
        .await
        .unwrap();
    let good = insert_schedule(&rig.su, fx.workspace, fx.channel, fx.a.id, "good", -2, None).await;
    let report = rig.tick().await;
    assert_eq!(report.decision_failed, vec![poison], "{report:?}");
    assert_eq!(
        report.sent,
        vec![good],
        "the rows behind it still went out: {report:?}"
    );
    let still = row(&rig.su, poison).await;
    assert_eq!(
        (still.status.as_str(), still.attempts),
        ("pending", i32::MAX)
    );

    // the next look leaves it alone (five minutes, in memory) instead of hammering the database
    let report = rig.tick().await;
    assert_eq!(report.left_alone, 1, "{report:?}");
    assert!(report.decision_failed.is_empty(), "{report:?}");
    assert_eq!(rig.memory.skipped_count(), 1);

    // a panic is one row's JoinError: the tick goes on, and the row backs off like any attempt
    let panicky = insert_schedule(
        &rig.su,
        fx.workspace,
        fx.channel,
        fx.a.id,
        "panics",
        -20,
        None,
    )
    .await;
    let after_panicky = insert_schedule(
        &rig.su,
        fx.workspace,
        fx.channel,
        fx.a.id,
        "after",
        -2,
        None,
    )
    .await;
    rig.memory.after_decision = Some(momo_server::scheduler::after_decision_hook(
        move |id, _| async move {
            if id == panicky {
                panic!("this row's task blows up");
            }
        },
    ));
    let report = rig.tick().await;
    assert_eq!(report.panicked, vec![panicky], "{report:?}");
    assert_eq!(report.sent, vec![after_panicky], "{report:?}");
    let backed_off = row(&rig.su, panicky).await;
    assert_eq!(
        (backed_off.status.as_str(), backed_off.attempts),
        ("pending", 1)
    );
    assert!(
        backed_off.next_attempt_in_secs.unwrap_or(0.0) > 3.0,
        "the committed attempt carries its backoff"
    );
}

// ---------------------------------------------------------------------------
// create: idempotent first, capped at fifty (D9, D10)
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn post_answers_a_known_client_request_id_before_any_validation() {
    let _lock = test_lock().await;
    let rig = Rig::new().await;
    let fx = fixture(&rig.su, "sm-idem").await;
    let ta = rig.token(fx.workspace, &fx.a).await;

    let request = create_body("the first answer", 3600);
    let (status, first) = rig
        .create(&ta, fx.workspace, fx.channel, request.clone())
        .await;
    assert_eq!(status, 201);
    let id = scheduled_id(&first);

    // the same id with a time that is impossible, other text and an attachment that does not exist:
    // none of it is looked at — the stored row comes back
    let mut replay = request.clone();
    replay["sendAtMs"] = json!(chrono::Utc::now().timestamp_millis() - 10_000);
    replay["body"] = json!("something else entirely");
    replay["attachmentIds"] = json!([Uuid::new_v4()]);
    replay["rootId"] = json!(Uuid::new_v4());
    let (status, again) = rig.create(&ta, fx.workspace, fx.channel, replay).await;
    assert_eq!(status, 201, "{again}");
    assert_eq!(scheduled_id(&again), id);
    assert_eq!(again["scheduledMessage"]["body"], "the first answer");
    // …even after the first row has been sent
    assert_eq!(
        rig.send_now(&ta, fx.workspace, &id.to_string()).await.0,
        200
    );
    let (status, after_send) = rig.create(&ta, fx.workspace, fx.channel, request).await;
    assert_eq!(status, 201);
    assert_eq!(after_send["scheduledMessage"]["status"], "sent");
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM scheduled_message WHERE author_member_id = $1"
        )
        .bind(fx.a.id)
        .fetch_one(&rig.su)
        .await
        .unwrap(),
        1,
        "still one row"
    );
    // the database is the backstop behind the lookup: the same (workspace, author, request id) cannot be
    // stored twice, whoever tries — a retry that races the first create dies here instead of doubling
    let duplicate = sqlx::query(
        "INSERT INTO scheduled_message (workspace_id, channel_id, author_member_id, body, send_at, client_request_id) \
         SELECT workspace_id, channel_id, author_member_id, 'duplicate', send_at, client_request_id \
           FROM scheduled_message WHERE id = $1",
    )
    .bind(id)
    .execute(&rig.su)
    .await;
    match duplicate {
        Err(sqlx::Error::Database(db)) => assert_eq!(db.code().as_deref(), Some("23505")),
        other => panic!("a second row for one request id must be refused by UNIQUE: {other:?}"),
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_cap_holds_under_concurrency() {
    let _lock = test_lock().await;
    let rig = Rig::new().await;
    let fx = fixture(&rig.su, "sm-cap").await;
    let ta = rig.token(fx.workspace, &fx.a).await;
    let tb = rig.token(fx.workspace, &fx.b).await;

    // sixty creates at once for one member: exactly fifty are taken
    let url = rig.workspace_url(
        fx.workspace,
        &format!("/channels/{}/scheduled-messages", fx.channel),
    );
    let mut attempts = Vec::new();
    for index in 0..60 {
        let (http, url, token) = (rig.http.clone(), url.clone(), ta.clone());
        let body = create_body(&format!("burst {index}"), 3600);
        attempts.push(tokio::spawn(async move {
            let response = http
                .post(url)
                .bearer_auth(token)
                .json(&body)
                .send()
                .await
                .expect("create");
            let status = response.status().as_u16();
            let value: Value = response.json().await.unwrap_or(Value::Null);
            (status, value)
        }));
    }
    let mut taken = 0;
    let mut refused = 0;
    for attempt in attempts {
        let (status, value) = attempt.await.unwrap();
        match status {
            201 => taken += 1,
            409 => {
                assert_eq!(error_code(&value), Some("pending_limit_reached"), "{value}");
                refused += 1;
            }
            other => panic!("unexpected status {other}: {value}"),
        }
    }
    assert_eq!((taken, refused), (50, 10));
    let pending: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM scheduled_message WHERE author_member_id = $1 AND status = 'pending'",
    )
    .bind(fx.a.id)
    .fetch_one(&rig.su)
    .await
    .unwrap();
    assert_eq!(pending, 50, "the cap held under the race");

    // the cap is per member: another member of the same workspace is not affected
    assert_eq!(
        rig.create(&tb, fx.workspace, fx.channel, create_body("b", 3600))
            .await
            .0,
        201
    );
    // a failed row does not hold a slot; re-arming it takes one, and the cap is checked again then
    let failed = insert_schedule(
        &rig.su,
        fx.workspace,
        fx.channel,
        fx.a.id,
        "failed",
        -1,
        None,
    )
    .await;
    sqlx::query(
        "UPDATE scheduled_message SET status = 'failed', failure_reason = 'missed' WHERE id = $1",
    )
    .bind(failed)
    .execute(&rig.su)
    .await
    .unwrap();
    let later = chrono::Utc::now().timestamp_millis() + 3_600_000;
    let (status, value) = rig
        .patch(
            &ta,
            fx.workspace,
            &failed.to_string(),
            json!({"sendAtMs": later}),
        )
        .await;
    assert_eq!(
        (status, error_code(&value)),
        (409, Some("pending_limit_reached")),
        "{value}"
    );
    assert_eq!(
        row(&rig.su, failed).await.status,
        "failed",
        "a refused re-arm changed nothing"
    );
    // a body-only edit of a failed row is not a re-arm and needs no slot
    assert_eq!(
        rig.patch(
            &ta,
            fx.workspace,
            &failed.to_string(),
            json!({"body": "kept"})
        )
        .await
        .0,
        200
    );
    assert_eq!(row(&rig.su, failed).await.status, "failed");

    // ten retries of ONE create, concurrently: one row, ten identical 201s
    let one = create_body("retry", 3600);
    let id = rig_create_burst(&rig, &tb, fx.workspace, fx.channel, one).await;
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM scheduled_message WHERE id = $1")
            .bind(id)
            .fetch_one(&rig.su)
            .await
            .unwrap(),
        1
    );
}

/// Ten concurrent copies of one create; returns the one id every copy answered with.
async fn rig_create_burst(
    rig: &Rig,
    token: &str,
    workspace: Uuid,
    channel: Uuid,
    body: Value,
) -> Uuid {
    let url = rig.workspace_url(
        workspace,
        &format!("/channels/{channel}/scheduled-messages"),
    );
    let mut copies = Vec::new();
    for _ in 0..10 {
        let (http, url, token, body) = (
            rig.http.clone(),
            url.clone(),
            token.to_string(),
            body.clone(),
        );
        copies.push(tokio::spawn(async move {
            let response = http
                .post(url)
                .bearer_auth(token)
                .json(&body)
                .send()
                .await
                .expect("create");
            let status = response.status().as_u16();
            let value: Value = response.json().await.unwrap_or(Value::Null);
            (status, value)
        }));
    }
    let mut ids = std::collections::HashSet::new();
    for copy in copies {
        let (status, value) = copy.await.unwrap();
        assert_eq!(status, 201, "a retry is never an error: {value}");
        ids.insert(scheduled_id(&value));
    }
    assert_eq!(ids.len(), 1, "every copy answered with the same row");
    ids.into_iter().next().unwrap()
}

// ---------------------------------------------------------------------------
// edit lock and the row lock (D9)
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_edit_in_the_last_30_seconds_is_refused_but_a_cancel_races_safely() {
    let _lock = test_lock().await;
    let mut rig = Rig::new().await;
    let fx = fixture(&rig.su, "sm-lock").await;
    let ta = rig.token(fx.workspace, &fx.a).await;

    // inside its last 30 seconds a pending row is not editable (409 scheduled_too_late)…
    let (_, created) = rig
        .create(&ta, fx.workspace, fx.channel, create_body("soon", 3600))
        .await;
    let id = scheduled_id(&created);
    move_send_at(&rig.su, id, 20).await;
    for body in [
        json!({"body": "changed"}),
        json!({"sendAtMs": chrono::Utc::now().timestamp_millis() + 7_200_000}),
    ] {
        let (status, value) = rig.patch(&ta, fx.workspace, &id.to_string(), body).await;
        assert_eq!(
            (status, error_code(&value)),
            (409, Some("scheduled_too_late")),
            "{value}"
        );
    }
    assert_eq!(row(&rig.su, id).await.body.as_deref(), Some("soon"));
    // …thirty-odd seconds out it is
    move_send_at(&rig.su, id, 45).await;
    assert_eq!(
        rig.patch(&ta, fx.workspace, &id.to_string(), json!({"body": "ok"}))
            .await
            .0,
        200
    );
    // a cancel is allowed all the way to the send — the last 30 seconds included
    move_send_at(&rig.su, id, 20).await;
    assert_eq!(rig.delete(&ta, fx.workspace, &id.to_string()).await.0, 204);
    assert_eq!(row(&rig.su, id).await.status, "cancelled");
    assert_eq!(
        rig.delete(&ta, fx.workspace, &id.to_string()).await.0,
        204,
        "cancelling twice is fine"
    );
    assert_eq!(
        rig.patch(&ta, fx.workspace, &id.to_string(), json!({"body": "x"}))
            .await
            .0,
        404,
        "a cancelled row is gone for edits"
    );
    assert_eq!(
        rig.send_now(&ta, fx.workspace, &id.to_string()).await.0,
        404
    );
    // a due row that has not been sent yet can still be cancelled or sent by hand
    let overdue = insert_schedule(
        &rig.su,
        fx.workspace,
        fx.channel,
        fx.a.id,
        "overdue",
        -30,
        None,
    )
    .await;
    assert_eq!(
        rig.delete(&ta, fx.workspace, &overdue.to_string()).await.0,
        204
    );
    assert!(rig.tick().await.is_quiet(), "a cancelled row is never sent");
    assert_eq!(messages_of(&rig.su, overdue).await, 0);

    // the row lock decides a race. A sender holds the row; the cancel waits for it and then finds it SENT
    let racing = insert_schedule(
        &rig.su,
        fx.workspace,
        fx.channel,
        fx.a.id,
        "going out",
        -2,
        None,
    )
    .await;
    let mut holder = hold_row_lock(&rig.su, racing).await;
    let (http, url, token) = (
        rig.http.clone(),
        rig.workspace_url(fx.workspace, &format!("/scheduled-messages/{racing}")),
        ta.clone(),
    );
    let waiting = tokio::spawn(async move {
        let response = http
            .delete(url)
            .bearer_auth(token)
            .send()
            .await
            .expect("cancel");
        let status = response.status().as_u16();
        (
            status,
            response.json::<Value>().await.unwrap_or(Value::Null),
        )
    });
    tokio::time::sleep(std::time::Duration::from_millis(700)).await;
    assert!(
        !waiting.is_finished(),
        "the cancel is waiting on the row lock, not racing past it"
    );
    sqlx::query(
        "UPDATE scheduled_message SET status = 'sent', body = NULL, sent_message_id = gen_random_uuid(), \
                sent_at = now(), rev = rev + 1 WHERE id = $1",
    )
    .bind(racing)
    .execute(&mut *holder)
    .await
    .unwrap();
    holder.commit().await.unwrap();
    let (status, value) = waiting.await.unwrap();
    assert_eq!(
        (status, error_code(&value)),
        (409, Some("scheduled_already_sent")),
        "{value}"
    );
    assert_eq!(row(&rig.su, racing).await.status, "sent", "the send stands");

    // a lock held longer than three seconds is `scheduled_busy` — try again — not a hang
    let held_long = insert_schedule(
        &rig.su,
        fx.workspace,
        fx.channel,
        fx.a.id,
        "slow",
        3600,
        None,
    )
    .await;
    let holder = hold_row_lock(&rig.su, held_long).await;
    let started = std::time::Instant::now();
    let (status, value) = rig.delete(&ta, fx.workspace, &held_long.to_string()).await;
    let waited = started.elapsed();
    assert_eq!(
        (status, error_code(&value)),
        (409, Some("scheduled_busy")),
        "{value}"
    );
    assert!(
        waited >= std::time::Duration::from_millis(2500)
            && waited < std::time::Duration::from_secs(6),
        "it waited the 3-second budget and no more ({waited:?})"
    );
    holder.rollback().await.unwrap();
    assert_eq!(
        row(&rig.su, held_long).await.status,
        "pending",
        "the busy answer changed nothing"
    );
    assert_eq!(
        rig.delete(&ta, fx.workspace, &held_long.to_string())
            .await
            .0,
        204
    );
    let _ = &mut rig;
}

// ---------------------------------------------------------------------------
// retention, a deleted workspace, and the event (D12, D14)
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_tick_purges_expired_rows_without_the_author_writing() {
    let _lock = test_lock().await;
    let mut rig = Rig::new().await;
    let fx = fixture(&rig.su, "sm-purge").await;
    let message = insert_message(&rig.su, fx.workspace, fx.channel, fx.a.id, "went out").await;
    let old_sent = insert_finished(&rig.su, &fx, "sent", 8, Some(message)).await;
    let old_cancelled = insert_finished(&rig.su, &fx, "cancelled", 8, None).await;
    let old_failed = insert_finished(&rig.su, &fx, "failed", 31, None).await;
    let young_sent = insert_finished(&rig.su, &fx, "sent", 6, Some(message)).await;
    let young_cancelled = insert_finished(&rig.su, &fx, "cancelled", 1, None).await;
    let young_failed = insert_finished(&rig.su, &fx, "failed", 29, None).await;
    let pending = insert_schedule(
        &rig.su,
        fx.workspace,
        fx.channel,
        fx.a.id,
        "waiting",
        3600,
        None,
    )
    .await;
    // an expired failed row's reserved attachment goes with it
    let file = insert_attachment(&rig.su, fx.workspace, fx.channel, fx.a.id, "complete").await;
    sqlx::query(
        "INSERT INTO scheduled_message_attachment (scheduled_message_id, workspace_id, member_id, attachment_id, position) \
         VALUES ($1, $2, $3, $4, 0)",
    )
    .bind(old_failed)
    .bind(fx.workspace)
    .bind(fx.a.id)
    .bind(file)
    .execute(&rig.su)
    .await
    .unwrap();

    let report = rig.tick().await;
    assert_eq!(report.purged, 3, "{report:?}");
    for gone in [old_sent, old_cancelled, old_failed] {
        assert!(!row_exists(&rig.su, gone).await, "{gone} is past its keep");
    }
    for kept in [young_sent, young_cancelled, young_failed, pending] {
        assert!(row_exists(&rig.su, kept).await, "{kept} is still within it");
    }
    let held: i64 = sqlx::query_scalar("SELECT count(*) FROM scheduled_message_attachment")
        .fetch_one(&rig.su)
        .await
        .unwrap();
    assert_eq!(held, 0, "the reservation went with the row");
    assert!(rig.tick().await.is_quiet(), "nothing left to do");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_deleted_workspace_row_is_cancelled_not_retried() {
    let _lock = test_lock().await;
    let mut rig = Rig::new().await;
    let gone = fixture(&rig.su, "sm-deleted").await;
    let alive = fixture(&rig.su, "sm-alive").await;
    let in_gone = insert_schedule(
        &rig.su,
        gone.workspace,
        gone.channel,
        gone.a.id,
        "dying",
        -2,
        None,
    )
    .await;
    let in_alive = insert_schedule(
        &rig.su,
        alive.workspace,
        alive.channel,
        alive.a.id,
        "living",
        -2,
        None,
    )
    .await;
    sqlx::query("UPDATE workspace SET deleted_at = now() WHERE id = $1")
        .bind(gone.workspace)
        .execute(&rig.su)
        .await
        .unwrap();

    let report = rig.tick().await;
    assert_eq!(report.cancelled, vec![in_gone], "{report:?}");
    assert_eq!(report.sent, vec![in_alive], "{report:?}");
    let closed = row(&rig.su, in_gone).await;
    assert_eq!((closed.status.as_str(), closed.body), ("cancelled", None));
    assert_eq!(
        messages_of(&rig.su, in_gone).await,
        0,
        "nothing went to a deleted workspace"
    );
    assert_eq!(closed.attempts, 0, "it was not tried");
    assert!(rig.tick().await.is_quiet(), "and it is not looked at again");
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_event_rides_the_personal_channel_with_ids_only() {
    let _lock = test_lock().await;
    let mut rig = Rig::new().await;
    let fx = fixture(&rig.su, "sm-event").await;
    let ta = rig.token(fx.workspace, &fx.a).await;
    let secret = "a body that must never leave the table";
    let (_, created) = rig
        .create(&ta, fx.workspace, fx.channel, create_body(secret, 3600))
        .await;
    let id = scheduled_id(&created);
    let (workspace, upper) = (fx.workspace, |value: Uuid| value.to_string().to_uppercase());
    assert_eq!(
        rig.patch(
            &ta,
            fx.workspace,
            &id.to_string(),
            json!({"body": format!("{secret} v2")})
        )
        .await
        .0,
        200
    );
    move_send_at(&rig.su, id, -2).await;
    assert_eq!(rig.tick().await.sent, vec![id]);

    let events = events_for(&rig.su, workspace, id).await;
    assert_eq!(
        events.len(),
        3,
        "created, edited, sent — one frame each: {events:?}"
    );
    let member_channel = format!("user:read-state#{}", upper(fx.a.id));
    let mut revs = Vec::new();
    for (position, frame) in events.iter().enumerate() {
        let text = frame.to_string();
        assert!(
            !text.contains("never leave") && !text.contains("body"),
            "no text in a frame: {text}"
        );
        assert_eq!(frame["channel"], member_channel);
        assert_eq!(frame["data"]["type"], "scheduled_message.updated");
        assert_eq!(frame["data"]["v"], 1);
        let payload = &frame["data"]["payload"];
        assert_eq!(payload["workspace_id"], upper(fx.workspace));
        assert_eq!(payload["member_id"], upper(fx.a.id));
        assert_eq!(payload["scheduled_message_id"], upper(id));
        assert_eq!(payload["channel_id"], upper(fx.channel));
        let rev = payload["rev"].as_i64().unwrap();
        assert_eq!(rev, position as i64, "rev rises by one per change");
        assert_eq!(
            frame["idempotency_key"],
            format!("{member_channel}:scheduled:{}:{rev}", upper(id))
        );
        revs.push(rev);
    }
    assert_eq!(events[0]["data"]["payload"]["status"], "pending");
    assert_eq!(events[2]["data"]["payload"]["status"], "sent");
    assert!(events[2]["data"]["payload"]["sent_message_id"].is_string());
    // the frame is queued for the author's own partition, in the one outbox
    let partition: Option<Uuid> = sqlx::query_scalar(
        "SELECT partition_key FROM outbox WHERE workspace_id = $1 AND payload -> 'data' -> 'payload' ->> 'scheduled_message_id' = $2 LIMIT 1",
    )
    .bind(fx.workspace)
    .bind(upper(id))
    .fetch_one(&rig.su)
    .await
    .unwrap();
    assert_eq!(partition, Some(fx.a.id));
    let _ = &mut rig;
}

// ---------------------------------------------------------------------------
// credential revocation (D14): holding, per lineage, and cancelling
// ---------------------------------------------------------------------------

#[path = "common/owner_scope_scan.rs"]
mod owner_scope_scan;

impl Rig {
    fn host(&self) -> String {
        self.base.trim_start_matches("http://").to_string()
    }

    /// A device-link voucher issued by the signed-in `access` session.
    async fn issue_link(&self, access: &str) -> String {
        let response = self
            .http
            .post(format!("{}/v1/auth/device-link", self.base))
            .bearer_auth(access)
            .header("host", self.host())
            .header("x-forwarded-proto", "http")
            .send()
            .await
            .expect("issue device-link");
        assert_eq!(response.status().as_u16(), 201, "a voucher is issued");
        let body: Value = response.json().await.expect("issue body");
        body["token"].as_str().expect("voucher").to_string()
    }

    /// A phone session: redeem a voucher as a named linked device (its own sign-in lineage).
    async fn redeem(&self, voucher: &str, name: &str) -> Session {
        let response = self
            .http
            .post(format!("{}/v1/auth/device-link/redeem", self.base))
            .header("host", self.host())
            .header("x-forwarded-proto", "http")
            .json(&json!({"token": voucher, "device": {"name": name, "platform": "ios"}}))
            .send()
            .await
            .expect("redeem");
        assert_eq!(response.status().as_u16(), 200, "a voucher redeems");
        let body: Value = response.json().await.expect("redeem body");
        Session {
            access: body["accessToken"].as_str().expect("access").to_string(),
            refresh: body["refreshToken"].as_str().expect("refresh").to_string(),
        }
    }

    async fn linked_phone(&self, desktop: &Session, name: &str) -> (Session, String) {
        let voucher = self.issue_link(&desktop.access).await;
        let phone = self.redeem(&voucher, name).await;
        let (status, listed) = self
            .call(
                reqwest::Method::GET,
                format!("{}/v1/auth/devices", self.base),
                &desktop.access,
                None,
            )
            .await;
        assert_eq!(status, 200);
        let device_id = listed["devices"]
            .as_array()
            .expect("devices")
            .iter()
            .find(|device| device["label"].as_str() == Some(name))
            .unwrap_or_else(|| panic!("the linked device {name} is listed"))["id"]
            .as_str()
            .expect("device id")
            .to_string();
        (phone, device_id)
    }

    async fn unlink(&self, access: &str, device_id: &str) -> u16 {
        self.call(
            reqwest::Method::DELETE,
            format!("{}/v1/auth/devices/{device_id}", self.base),
            access,
            None,
        )
        .await
        .0
    }

    async fn logout(&self, session: &Session) -> u16 {
        let response = self
            .http
            .post(format!("{}/v1/auth/logout", self.base))
            .bearer_auth(&session.access)
            .json(&json!({"refreshToken": session.refresh}))
            .send()
            .await
            .expect("logout");
        response.status().as_u16()
    }

    async fn refresh(&self, refresh_token: &str) -> (u16, Value) {
        let response = self
            .http
            .post(format!("{}/v1/auth/refresh", self.base))
            .json(&json!({"refreshToken": refresh_token}))
            .send()
            .await
            .expect("refresh");
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(Value::Null))
    }
}

/// `token.session_id` of the session an access token belongs to.
async fn lineage_of(su: &PgPool, raw_token: &str) -> Uuid {
    sqlx::query_scalar::<_, Option<Uuid>>(
        "SELECT session_id FROM token WHERE token_hash = digest($1::text, 'sha256')",
    )
    .bind(raw_token)
    .fetch_one(su)
    .await
    .expect("token row")
    .expect("a session token carries a lineage")
}

/// Force a row into `failed` with the given reason (a prior failure), as the superuser.
async fn fail_row(su: &PgPool, id: Uuid, reason: &str) {
    sqlx::query(
        "UPDATE scheduled_message SET status = 'failed', failure_reason = $2, next_attempt_at = NULL WHERE id = $1",
    )
    .bind(id)
    .bind(reason)
    .execute(su)
    .await
    .expect("fail the row");
}

/// The `status` of every frame a schedule has produced, oldest first.
async fn frame_statuses(su: &PgPool, workspace: Uuid, id: Uuid) -> Vec<String> {
    events_for(su, workspace, id)
        .await
        .iter()
        .map(|frame| {
            let payload = &frame["data"]["payload"];
            match payload["failure_reason"].as_str() {
                Some(reason) => format!("{}:{reason}", payload["status"].as_str().unwrap()),
                None => payload["status"].as_str().unwrap().to_string(),
            }
        })
        .collect()
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_member_wide_session_end_holds_pending_and_failed_schedules_and_logout_does_not() {
    let _lock = test_lock().await;
    let mut rig = Rig::new().await;
    let fx = fixture(&rig.su, "sm-hold").await;
    let admin_token = rig.token(fx.workspace, &fx.admin).await;

    // ── a password change ends every sign-in of the member ───────────────────────────────────
    let pending = insert_schedule(
        &rig.su,
        fx.workspace,
        fx.channel,
        fx.a.id,
        "pending text",
        3600,
        None,
    )
    .await;
    let failed = insert_schedule(
        &rig.su,
        fx.workspace,
        fx.channel,
        fx.a.id,
        "failed text",
        3600,
        None,
    )
    .await;
    fail_row(&rig.su, failed, "missed").await;
    let held_already = insert_schedule(
        &rig.su,
        fx.workspace,
        fx.channel,
        fx.a.id,
        "held text",
        3600,
        None,
    )
    .await;
    fail_row(&rig.su, held_already, "sessions_ended").await;
    let cancelled =
        insert_schedule(&rig.su, fx.workspace, fx.channel, fx.a.id, "x", 3600, None).await;
    sqlx::query("UPDATE scheduled_message SET status = 'cancelled', body = NULL WHERE id = $1")
        .bind(cancelled)
        .execute(&rig.su)
        .await
        .unwrap();
    let others = insert_schedule(
        &rig.su,
        fx.workspace,
        fx.channel,
        fx.b.id,
        "someone else's",
        3600,
        None,
    )
    .await;
    let before_held = row(&rig.su, held_already).await;

    let session = rig.login(fx.workspace, &fx.a).await;
    let (status, changed) = rig
        .call(
            reqwest::Method::PATCH,
            rig.workspace_url(fx.workspace, "/members/me/password"),
            &session.access,
            Some(
                json!({"currentPassword": TEST_PASSWORD, "newPassword": "a-brand-new-password-1"}),
            ),
        )
        .await;
    assert_eq!(status, 200, "{changed}");
    for id in [pending, failed] {
        let held = row(&rig.su, id).await;
        assert_eq!(
            (held.status.as_str(), held.reason.as_deref(), held.rev),
            ("failed", Some("sessions_ended"), 1),
            "{id}: held, not cancelled"
        );
        assert!(
            held.body.is_some(),
            "the text is kept so its author can read it and decide"
        );
        assert_eq!(
            frame_statuses(&rig.su, fx.workspace, id).await,
            vec!["failed:sessions_ended"]
        );
        assert_eq!(
            audit_actions_for(&rig.su, id).await,
            vec!["scheduled_message.failed"]
        );
    }
    let after_held = row(&rig.su, held_already).await;
    assert_eq!(
        after_held.rev, before_held.rev,
        "a row that is already held is not touched again"
    );
    assert!(
        frame_statuses(&rig.su, fx.workspace, held_already)
            .await
            .is_empty(),
        "…and says nothing"
    );
    assert_eq!(
        row(&rig.su, cancelled).await.status,
        "cancelled",
        "a finished row stays finished"
    );
    assert_eq!(
        row(&rig.su, others).await.status,
        "pending",
        "another member's schedule is not this member's to lose"
    );

    // a held row never goes out by itself, even when its time comes…
    move_send_at(&rig.su, pending, -2).await;
    assert!(
        rig.tick().await.is_quiet(),
        "nothing is sent for a held row"
    );
    assert_eq!(messages_of(&rig.su, pending).await, 0);
    // ── a logout is the author leaving: what they armed still goes out (the point of the feature) ──
    let b_session = rig.login(fx.workspace, &fx.b).await;
    let (status, created) = rig
        .create(
            &b_session.access,
            fx.workspace,
            fx.channel,
            create_body("goes out while I am away", 3600),
        )
        .await;
    assert_eq!(status, 201, "{created}");
    let armed_then_away = scheduled_id(&created);
    assert_eq!(rig.logout(&b_session).await, 200);
    assert_eq!(
        row(&rig.su, armed_then_away).await.status,
        "pending",
        "a logout holds nothing"
    );
    move_send_at(&rig.su, armed_then_away, -2).await;
    let report = rig.tick().await;
    assert!(
        report.sent.contains(&armed_then_away),
        "and it is sent with nobody signed in: {report:?}"
    );

    // ── suspension holds, and reinstatement does not bring it back ───────────────────────────
    let target = seed_human(&rig.su, fx.workspace, "carol", "member").await;
    join_channel(&rig.su, fx.workspace, fx.channel, target.id).await;
    let carol_pending = insert_schedule(
        &rig.su,
        fx.workspace,
        fx.channel,
        target.id,
        "carol's",
        3600,
        None,
    )
    .await;
    let (status, value) = rig
        .call(
            reqwest::Method::POST,
            rig.workspace_url(fx.workspace, &format!("/members/{}/suspend", target.id)),
            &admin_token,
            None,
        )
        .await;
    assert_eq!(status, 200, "{value}");
    let held = row(&rig.su, carol_pending).await;
    assert_eq!(
        (held.status.as_str(), held.reason.as_deref()),
        ("failed", Some("sessions_ended"))
    );
    let (status, value) = rig
        .call(
            reqwest::Method::POST,
            rig.workspace_url(fx.workspace, &format!("/members/{}/reinstate", target.id)),
            &admin_token,
            None,
        )
        .await;
    assert_eq!(status, 200, "{value}");
    let still = row(&rig.su, carol_pending).await;
    assert_eq!(
        (still.status.as_str(), still.reason.as_deref()),
        ("failed", Some("sessions_ended")),
        "reinstating the member does not revive what the stolen-session case held (#2677)"
    );
    // the author signs in again, reads it, and decides: send now is the re-confirmation
    let carol_token = rig.token(fx.workspace, &target).await;
    let (_, listed) = rig.list(&carol_token, fx.workspace, "?status=failed").await;
    assert_eq!(listed["scheduledMessages"][0]["body"], "carol's");
    assert_eq!(
        listed["scheduledMessages"][0]["failureReason"],
        "sessions_ended"
    );
    let (status, sent) = rig
        .send_now(&carol_token, fx.workspace, &carol_pending.to_string())
        .await;
    assert_eq!(status, 200, "{sent}");
    assert_eq!(messages_of(&rig.su, carol_pending).await, 1);
    let _ = &mut rig;
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_device_unlink_or_refresh_reuse_holds_only_that_lineages_schedules() {
    let _lock = test_lock().await;
    let rig = Rig::with(
        SchedulerSettings::default(),
        // a password sign-in is swept on reuse only when the operator turned this on; the
        // linked-device lineage is swept always
        DeviceKeySettings {
            refresh_reuse_sweep_all_sessions: true,
            ..DeviceKeySettings::default()
        },
    )
    .await;
    let fx = fixture(&rig.su, "sm-lineage").await;
    let desktop = rig.login(fx.workspace, &fx.a).await;
    let (phone, phone_device) = rig.linked_phone(&desktop, "Phone").await;
    let desktop_lineage = lineage_of(&rig.su, &desktop.access).await;
    let phone_lineage = lineage_of(&rig.su, &phone.access).await;
    assert_ne!(
        desktop_lineage, phone_lineage,
        "a linked device is its own sign-in lineage"
    );

    let make = |session: &Session, text: &'static str| {
        let (rig, access) = (&rig, session.access.clone());
        let (workspace, channel) = (fx.workspace, fx.channel);
        async move {
            let (status, created) = rig
                .create(&access, workspace, channel, create_body(text, 3600))
                .await;
            assert_eq!(status, 201, "{created}");
            scheduled_id(&created)
        }
    };
    let from_phone = make(&phone, "armed on the phone").await;
    let from_phone_time_only =
        make(&phone, "armed on the phone, time moved from the desktop").await;
    let from_phone_text_edited =
        make(&phone, "armed on the phone, text rewritten on the desktop").await;
    let from_desktop = make(&desktop, "armed on the desktop").await;
    assert_eq!(
        row(&rig.su, from_phone).await.armed_session_id,
        Some(phone_lineage)
    );
    assert_eq!(
        row(&rig.su, from_desktop).await.armed_session_id,
        Some(desktop_lineage)
    );

    // the lineage that last wrote the CONTENT is the one a hold looks for
    let later = chrono::Utc::now().timestamp_millis() + 7_200_000;
    let (status, _) = rig
        .patch(
            &desktop.access,
            fx.workspace,
            &from_phone_time_only.to_string(),
            json!({"sendAtMs": later}),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(
        row(&rig.su, from_phone_time_only).await.armed_session_id,
        Some(phone_lineage),
        "moving the time is not rewriting the text: it stays armed by the phone"
    );
    let (status, _) = rig
        .patch(
            &desktop.access,
            fx.workspace,
            &from_phone_text_edited.to_string(),
            json!({"body": "rewritten here"}),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(
        row(&rig.su, from_phone_text_edited).await.armed_session_id,
        Some(desktop_lineage),
        "rewriting the text makes the editing session the one that vouches for it"
    );

    // ── unlink the phone from the desktop: only what the phone last wrote is held ─────────────
    assert_eq!(rig.unlink(&desktop.access, &phone_device).await, 204);
    for id in [from_phone, from_phone_time_only] {
        let held = row(&rig.su, id).await;
        assert_eq!(
            (held.status.as_str(), held.reason.as_deref()),
            ("failed", Some("sessions_ended")),
            "{id}"
        );
    }
    for id in [from_phone_text_edited, from_desktop] {
        assert_eq!(
            row(&rig.su, id).await.status,
            "pending",
            "{id} was not armed by the unlinked phone"
        );
    }
    assert_eq!(
        frame_statuses(&rig.su, fx.workspace, from_phone).await,
        vec!["pending", "failed:sessions_ended"],
        "the create left a frame and the hold left one, so the phone's other devices see it stop"
    );

    // ── a phone that signed out and was then unlinked is held too (the link row outlives its tokens) ──
    let (phone2, phone2_device) = rig.linked_phone(&desktop, "Phone 2").await;
    let from_phone2 = make(&phone2, "armed on the second phone").await;
    assert_eq!(rig.logout(&phone2).await, 200);
    assert_eq!(
        row(&rig.su, from_phone2).await.status,
        "pending",
        "a logout alone holds nothing (D14: arming a message and signing out is the feature)"
    );
    let (status, value) = rig
        .call(
            reqwest::Method::DELETE,
            format!("{}/v1/auth/devices/{phone2_device}", rig.base),
            &desktop.access,
            None,
        )
        .await;
    assert_eq!(
        status, 404,
        "the route still answers what it always answered for a link with no live token: {value}"
    );
    let held = row(&rig.su, from_phone2).await;
    assert_eq!(
        (held.status.as_str(), held.reason.as_deref()),
        ("failed", Some("sessions_ended")),
        "…but the lineage that armed it is held anyway"
    );
    // an unknown or foreign id holds nothing and leaks nothing
    assert_eq!(
        rig.unlink(&desktop.access, &Uuid::new_v4().to_string())
            .await,
        404
    );
    let b_session = rig.login(fx.workspace, &fx.b).await;
    assert_eq!(
        rig.unlink(&b_session.access, &phone2_device).await,
        404,
        "another member cannot reach it"
    );

    // ── refresh-token reuse ends the linked lineage ──────────────────────────────────────────
    let (phone3, _) = rig.linked_phone(&desktop, "Phone 3").await;
    let from_phone3 = make(&phone3, "armed on the third phone").await;
    let (status, rotated) = rig.refresh(&phone3.refresh).await;
    assert_eq!(status, 200, "{rotated}");
    assert!(rotated["refreshToken"].is_string());
    // the spent token comes back after the 30-second grace: a copy, not a retry
    sqlx::query(
        "UPDATE token SET revoked_at = now() - interval '2 minutes' WHERE token_hash = digest($1::text, 'sha256')",
    )
    .bind(&phone3.refresh)
    .execute(&rig.su)
    .await
    .unwrap();
    let (status, _) = rig.refresh(&phone3.refresh).await;
    assert_eq!(status, 401, "the reuse is refused");
    let held = row(&rig.su, from_phone3).await;
    assert_eq!(
        (held.status.as_str(), held.reason.as_deref()),
        ("failed", Some("sessions_ended"))
    );
    assert_eq!(
        row(&rig.su, from_desktop).await.status,
        "pending",
        "the desktop's lineage is a different one"
    );
    assert_eq!(row(&rig.su, from_phone_text_edited).await.status, "pending");

    // a password sign-in's lineage is swept on reuse only when the operator opted in (it is, here)
    let tab = rig.login(fx.workspace, &fx.a).await;
    let from_tab = make(&tab, "armed in a browser tab").await;
    let (status, _) = rig.refresh(&tab.refresh).await;
    assert_eq!(status, 200);
    sqlx::query(
        "UPDATE token SET revoked_at = now() - interval '2 minutes' WHERE token_hash = digest($1::text, 'sha256')",
    )
    .bind(&tab.refresh)
    .execute(&rig.su)
    .await
    .unwrap();
    assert_eq!(rig.refresh(&tab.refresh).await.0, 401);
    assert_eq!(
        row(&rig.su, from_tab).await.status,
        "failed",
        "the tab's lineage was swept and its schedule held"
    );
    assert_eq!(
        row(&rig.su, from_desktop).await.status,
        "pending",
        "…and only the tab's: the desktop session that armed `from_desktop` is another lineage"
    );

    // a held row can be sent by hand, after its author has read it
    let (status, sent) = rig
        .send_now(&desktop.access, fx.workspace, &from_phone.to_string())
        .await;
    assert_eq!(status, 200, "{sent}");
    assert_eq!(messages_of(&rig.su, from_phone).await, 1);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn removal_and_leave_cancel_schedules_and_a_foreign_member_guc_is_bound_only_in_the_three_named_functions(
) {
    let _lock = test_lock().await;
    let mut rig = Rig::new().await;
    let fx = fixture(&rig.su, "sm-cancel").await;
    let admin_token = rig.token(fx.workspace, &fx.admin).await;

    // one member of each kind of row: pending (with a reserved file), failed, already held
    let su_for_seed = rig.su.clone();
    let seed_for = |member: Uuid| {
        let (su, workspace, channel) = (su_for_seed.clone(), fx.workspace, fx.channel);
        async move {
            let pending =
                insert_schedule(&su, workspace, channel, member, "pending text", 3600, None).await;
            let file = insert_attachment(&su, workspace, channel, member, "complete").await;
            sqlx::query(
                "INSERT INTO scheduled_message_attachment (scheduled_message_id, workspace_id, member_id, attachment_id, position) \
                 VALUES ($1, $2, $3, $4, 0)",
            )
            .bind(pending)
            .bind(workspace)
            .bind(member)
            .bind(file)
            .execute(&su)
            .await
            .unwrap();
            let failed =
                insert_schedule(&su, workspace, channel, member, "failed text", 3600, None).await;
            fail_row(&su, failed, "not_member").await;
            let held =
                insert_schedule(&su, workspace, channel, member, "held text", 3600, None).await;
            fail_row(&su, held, "sessions_ended").await;
            (pending, failed, held)
        }
    };
    let bystander = insert_schedule(
        &rig.su,
        fx.workspace,
        fx.channel,
        fx.admin.id,
        "the admin's own",
        3600,
        None,
    )
    .await;

    // ── removal ───────────────────────────────────────────────────────────────────────────────
    let (p, f, h) = seed_for(fx.b.id).await;
    let (status, value) = rig
        .call(
            reqwest::Method::DELETE,
            rig.workspace_url(fx.workspace, &format!("/members/{}", fx.b.id)),
            &admin_token,
            None,
        )
        .await;
    assert_eq!(status, 200, "{value}");
    for id in [p, f, h] {
        let cancelled = row(&rig.su, id).await;
        assert_eq!(
            (cancelled.status.as_str(), cancelled.reason, cancelled.body),
            ("cancelled", None, None),
            "{id}: removed means cancelled, with the text erased"
        );
    }
    let reservations: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM scheduled_message_attachment WHERE member_id = $1",
    )
    .bind(fx.b.id)
    .fetch_one(&rig.su)
    .await
    .unwrap();
    assert_eq!(reservations, 0, "the files are released");
    assert_eq!(
        row(&rig.su, bystander).await.status,
        "pending",
        "nobody else's schedule is touched"
    );
    // hold and cancel both ran, in either order the result is the same: pending → failed → cancelled
    assert_eq!(
        frame_statuses(&rig.su, fx.workspace, p).await,
        vec!["failed:sessions_ended", "cancelled"]
    );
    assert_eq!(
        audit_actions_for(&rig.su, p).await,
        vec!["scheduled_message.failed", "scheduled_message.cancelled"]
    );
    assert_eq!(
        frame_statuses(&rig.su, fx.workspace, h).await,
        vec!["cancelled"],
        "an already-held row is only cancelled"
    );
    assert!(
        rig.tick().await.is_quiet(),
        "nothing of a removed member's is ever sent"
    );

    // ── leaving the workspace ─────────────────────────────────────────────────────────────────
    let (p, f, h) = seed_for(fx.a.id).await;
    let a_token = rig.token(fx.workspace, &fx.a).await;
    let (status, value) = rig
        .call(
            reqwest::Method::DELETE,
            rig.workspace_url(fx.workspace, "/members/me"),
            &a_token,
            None,
        )
        .await;
    assert_eq!(status, 200, "{value}");
    for id in [p, f, h] {
        let cancelled = row(&rig.su, id).await;
        assert_eq!(
            (cancelled.status.as_str(), cancelled.body),
            ("cancelled", None),
            "{id}"
        );
    }
    assert_eq!(row(&rig.su, bystander).await.status, "pending");

    // ── the exception to "a request speaks for itself": the three functions restore what they displaced ──
    // `with_tenant_tx` binds only the workspace, so the member scope the function binds is somebody else's.
    let (workspace, other) = (fx.workspace, fx.admin.id);
    let probe = |label: &'static str, run: u8| {
        let app = rig.app.clone();
        async move {
            momo_db::with_tenant_tx(&app, workspace, move |conn| {
                Box::pin(async move {
                    let before = momo_messaging::current_owner_guc(conn).await?;
                    match run {
                        0 => {
                            momo_messaging::hold_member_schedules_in_tx(conn, workspace, other)
                                .await?;
                        }
                        1 => {
                            momo_messaging::hold_lineage_schedules_in_tx(
                                conn,
                                workspace,
                                other,
                                Uuid::new_v4(),
                            )
                            .await?;
                        }
                        _ => {
                            momo_messaging::cancel_member_schedules_in_tx(
                                conn,
                                workspace,
                                Uuid::new_v4(),
                            )
                            .await?;
                        }
                    }
                    let after = momo_messaging::current_owner_guc(conn).await?;
                    Ok((label, before, after))
                })
            })
            .await
            .expect("the hook runs")
        }
    };
    for run in 0..3u8 {
        let (label, before, after) = probe(
            ["hold_member", "hold_lineage", "cancel_member"][run as usize],
            run,
        )
        .await;
        assert_eq!(
            before, "",
            "{label}: the transaction starts with no member scope"
        );
        assert_eq!(
            after, "",
            "{label}: …and ends with none — the member it spoke for is not left bound"
        );
    }
    // and a scope the transaction already held comes back exactly
    let restored = momo_db::with_tenant_tx(&rig.app, workspace, move |conn| {
        Box::pin(async move {
            momo_messaging::bind_owner_guc(conn, fx.b.id).await?;
            momo_messaging::hold_member_schedules_in_tx(conn, workspace, other).await?;
            momo_messaging::current_owner_guc(conn).await
        })
    })
    .await
    .unwrap();
    assert_eq!(
        restored,
        fx.b.id.to_string(),
        "a displaced scope is put back"
    );

    // the source scan: nothing else binds another member's scope (and the scan itself can fail)
    let sources =
        owner_scope_scan::load_sources(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."));
    let problems = owner_scope_scan::violations(&sources);
    assert!(problems.is_empty(), "{problems:#?}");
    let mut polluted =
        owner_scope_scan::load_sources(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."));
    polluted.push(owner_scope_scan::Source {
        path: "bins/momo-server/src/routes/sneaky.rs".into(),
        text: "async fn grab(conn: &mut C, m: Uuid) { bind_foreign_owner_guc(conn, m).await; }"
            .into(),
    });
    assert!(
        !owner_scope_scan::violations(&polluted).is_empty(),
        "a binding outside the three named functions is caught"
    );
}
