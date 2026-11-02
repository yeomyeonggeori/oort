//! #4341 — 알림 진단 API와 시험 알림 (ADR-0206 D11·D15).
//!
//! `GET …/notification-diagnostics` answers 「왜 알림이 안 와요」 as closed codes; `POST …/test`
//! sends a test push to the caller's own devices **past the judgment**. Every test runs the real
//! router over a real Postgres as `momo_app` (NOBYPASSRLS) with two tenants where it matters, and
//! each one names the sabotage that turns it red.
//!
//! | test | what it shows | sabotage that makes it red |
//! |---|---|---|
//! | `a_pause_is_reported_until_it_ends` | `paused` (open-ended, timed, expired) | invert `pause_in_force` / drop the expiry arm |
//! | `a_channel_mute_is_reported_only_for_a_channel_the_caller_belongs_to` | `channel_muted` + the 404s | drop the `is_channel_member` check / the expiry arm of the mute read |
//! | `the_devices_say_no_device_then_token_invalidated` | `no_device`, `token_invalidated` | read other members' tokens / drop the `devices.active == 0` condition |
//! | `relay_unreachable_is_inferred_from_stale_claims_and_stalled_tests` | `relay_unreachable` | drop the 2-minute floor / the 15-minute lookback / the active-token join |
//! | `the_last_delivery_failure_is_a_code_and_never_a_relays_words` | `last_delivery_failed` | return the recorded reason as is / count drop rows |
//! | `the_last_test_reads_the_dispatch_log_by_its_collapse_id` | `lastTest`: sent / relay_outdated / failed / queued / stalled, by `t:<id>` exactly | read the outbox instead / classify every 400 as outdated / match another test's rows |
//! | `the_last_test_read_is_served_by_the_partial_unique_index` | the `lastTest` SQL plans onto `push_dispatch_dedupe_uniq` (review M-1) | drop `AND push_token_id IS NOT NULL` from `LAST_TEST_ROWS_SQL` |
//! | `kind_off_needs_a_switched_off_kind_and_quiet_hours_waits_for_its_slice` | with no switch off `kind_off` stays out (it is emitted for a switched-off kind in `notification_prefs_conformance_pg`), `quiet_hours` stays out until N7; `kind` is validated | emit `kind_off` without a switch, or `quiet_hours` |
//! | `a_test_push_passes_a_pause_and_writes_one_id_only_row_for_the_caller` | judgment bypass, id-only, own member only | route the test through `judge_targets` / add a name key |
//! | `the_budget_is_three_per_minute_even_when_five_arrive_at_once` | exactly 3 of 5, 429 `rate_limited`, window reset | raise the limit to 4 / drop the row lock |
//! | `a_second_test_waits_on_the_row_lock_and_counts_after_the_first` | the row lock, measured: B blocks behind A at `FOR UPDATE`, the count ends at 2 (review L-1) | drop `FOR UPDATE` from `reserve_test_push_in_tx` |
//! | `a_refused_test_never_asks_the_client_to_wait_more_than_the_window` | `Retry-After` is 1..=60 even for a lock waiter that began before the window opened (review L-2) | drop the clamp in `retry_after_secs` |
//! | `no_device_is_409_and_spends_nothing` | 409 `no_device`, no budget, no row | spend the slot before the token check |
//! | `an_agent_bearer_and_a_stranger_get_nothing` | agent 403 on both routes, 401, cross-tenant | open the route to agent bearers |
//! | `a_suspended_or_deleted_member_is_refused_on_both_routes` | the door's JWT ignores member state; the handlers' `active_workspace_role` turns a suspended / deleted member away and nothing is written (review L-3) | remove `active_workspace_role` from either handler |
//! | `a_rolled_back_test_leaves_no_row_and_no_count` | counter and row share one transaction | write the row outside the transaction |
//! | `the_old_rule_writes_leave_the_test_columns_alone` | compat: PUT/PATCH keep `last_test_*` | write the test columns from `store_rule` |
//! | `a_test_push_reaches_the_dispatch_log_as_a_200_without_a_message` | POST → drain → `apns_status=200`, `message_id NULL`, `lastTest: sent` | `claim_dispatch` with a nil message id (FK) |
//! | `one_test_goes_to_at_most_the_five_freshest_devices_and_says_so` | six devices → `deviceCount` 5, five relay calls, the stalest device left out, `devices.active` still 6 (review H-1) | drop the `LIMIT` of `system_targets` / the `LEAST` of `reserve_test_push_in_tx` / order by something other than `updated_at DESC` |
//!
//! `#[ignore]` because it needs a real Postgres:
//!
//! ```text
//! DATABASE_URL=postgres://postgres:postgres@127.0.0.1:<port>/<db> \
//!   cargo test -p momo-server --test notification_diagnostics_conformance_pg \
//!     -- --ignored --test-threads=1
//! ```
//!
//! Harness contract is `notification_rules_patch_conformance_pg.rs`'s: `DATABASE_URL` is a
//! superuser (migrations + fixtures), the API runs as `momo_app`, and the consumer half of the
//! end-to-end test runs as `momo_notifier` against a recording stand-in for the relay.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_notifier::{PushConfig, PushDrain};
use momo_outbox::{emit_push_system, PushSystemReason};
use momo_push::{
    reserve_test_push_in_tx, test_notification_collapse_id, DispatchOutcome, PushDispatch,
    PushDispatcher, TestPushSlot, LAST_TEST_ROWS_SQL, SYSTEM_PUSH_MAX_TARGETS,
};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "notification-diagnostics-conformance-secret";
const TEST_PASSWORD: &str = "notification-diagnostics-password";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn role_password(env_key: &str, fallback: &str) -> String {
    std::env::var(env_key).unwrap_or_else(|_| fallback.to_string())
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url())
        .await
        .expect("connect as superuser")
}

async fn pool_as(role: &str, password: &str) -> PgPool {
    let options: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
    let options = options.username(role).password(password);
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await
        .unwrap_or_else(|error| {
            panic!("connect as {role} (run bootstrap_roles.sql first): {error}")
        })
}

async fn momo_app_pool() -> PgPool {
    pool_as(
        "momo_app",
        &role_password("MOMO_APP_PASSWORD", "momo_app_dev_pw"),
    )
    .await
}

async fn momo_notifier_pool() -> PgPool {
    pool_as(
        "momo_notifier",
        &role_password("MOMO_NOTIFIER_PASSWORD", "momo_notifier_dev_pw"),
    )
    .await
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

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations");
    let path = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/rust/sql/bootstrap_roles.sql"
    ));
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1", "--no-psqlrc", "--quiet"])
        .arg("--single-transaction")
        .arg("-f")
        .arg(path)
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
    *ready = true;
}

async fn start_server(pool: PgPool) -> String {
    let app = build_app(AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind momo-server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{address}")
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Human {
    id: Uuid,
    email: String,
}

/// One tenant: two people, an agent, a channel `me` belongs to and a channel only `other` does.
struct Tenant {
    workspace: Uuid,
    me: Human,
    other: Human,
    agent: Uuid,
    my_channel: Uuid,
    others_channel: Uuid,
}

async fn seed_workspace(su: &PgPool) -> Uuid {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("diag-{workspace}"))
        .execute(su)
        .await
        .expect("seed workspace");
    workspace
}

async fn seed_human(su: &PgPool, workspace: Uuid) -> Human {
    let id = Uuid::new_v4();
    let handle = format!("h-{}", &id.simple().to_string()[..10]);
    let email = format!("{id}@diag.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(id)
    .bind(workspace)
    .bind(&handle)
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
        "INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ($1, $2, 'member')",
    )
    .bind(workspace)
    .bind(id)
    .execute(su)
    .await
    .expect("seed workspace membership");
    Human { id, email }
}

async fn seed_agent(su: &PgPool, workspace: Uuid, owner: Uuid) -> Uuid {
    let agent = Uuid::new_v4();
    let handle = format!("ag-{}", &agent.simple().to_string()[..8]);
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', $3, $3)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(&handle)
    .execute(su)
    .await
    .expect("seed agent member");
    sqlx::query(
        "INSERT INTO agent \
           (member_id, workspace_id, model, base_url, max_concurrent_runs, max_run_steps, owner_human_id) \
         VALUES ($1, $2, 'hermes-agent', 'https://gateway.invalid/v1', 2, 50, $3)",
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

async fn seed_channel(su: &PgPool, workspace: Uuid, creator: Uuid, member: Uuid) -> Uuid {
    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, topic, created_by) \
         VALUES ($1, $2, 'public', $3, '', $4)",
    )
    .bind(channel)
    .bind(workspace)
    .bind(format!("ch-{}", &channel.simple().to_string()[..8]))
    .bind(creator)
    .execute(su)
    .await
    .expect("seed channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel)
        .bind(workspace)
        .execute(su)
        .await
        .expect("seed channel_seq");
    sqlx::query("INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)")
        .bind(workspace)
        .bind(channel)
        .bind(member)
        .execute(su)
        .await
        .expect("seed membership");
    channel
}

async fn seed_tenant(su: &PgPool) -> Tenant {
    let workspace = seed_workspace(su).await;
    let me = seed_human(su, workspace).await;
    let other = seed_human(su, workspace).await;
    let agent = seed_agent(su, workspace, me.id).await;
    let my_channel = seed_channel(su, workspace, me.id, me.id).await;
    let others_channel = seed_channel(su, workspace, other.id, other.id).await;
    Tenant {
        workspace,
        me,
        other,
        agent,
        my_channel,
        others_channel,
    }
}

/// One live push token for `member` on a fresh device. Returns the token id.
async fn seed_token(su: &PgPool, workspace: Uuid, member: Uuid) -> Uuid {
    let device = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO device (id, workspace_id, member_id, platform) \
         VALUES ($1, $2, $3, 'ios'::device_platform)",
    )
    .bind(device)
    .bind(workspace)
    .bind(member)
    .execute(su)
    .await
    .expect("seed device");
    sqlx::query_scalar(
        "INSERT INTO push_token (workspace_id, device_id, member_id, apns_token, env, topic) \
         VALUES ($1, $2, $3, $4, 'sandbox'::push_env, 'kim.dawn.momo.e2e') RETURNING id",
    )
    .bind(workspace)
    .bind(device)
    .bind(member)
    .bind(Uuid::new_v4().simple().to_string().repeat(2))
    .fetch_one(su)
    .await
    .expect("seed push token")
}

async fn invalidate_token(su: &PgPool, token: Uuid) {
    sqlx::query("UPDATE push_token SET invalidated_at = now() WHERE id = $1")
        .bind(token)
        .execute(su)
        .await
        .expect("invalidate token");
}

/// One `push_dispatch_log` row `age_secs` old (the notifier's record of one dispatch).
async fn seed_dispatch_log(
    su: &PgPool,
    tenant: &Tenant,
    member: Uuid,
    token: Uuid,
    status: Option<i32>,
    reason: Option<&str>,
    age_secs: f64,
) {
    sqlx::query(
        "INSERT INTO push_dispatch_log \
           (workspace_id, member_id, push_token_id, collapse_id, apns_status, apns_reason, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6, now() - make_interval(secs => $7::double precision))",
    )
    .bind(tenant.workspace)
    .bind(member)
    .bind(token)
    .bind(format!("seed:{}", Uuid::new_v4()))
    .bind(status)
    .bind(reason)
    .bind(age_secs)
    .execute(su)
    .await
    .expect("seed dispatch log");
}

async fn clear_dispatch_log(su: &PgPool, member: Uuid) {
    sqlx::query("DELETE FROM push_dispatch_log WHERE member_id = $1")
        .bind(member)
        .execute(su)
        .await
        .expect("clear dispatch log");
}

/// Set (or clear) `me`'s pause through the superuser: `dnd` with an expiry `until_secs` from now.
async fn set_pause(su: &PgPool, tenant: &Tenant, dnd: bool, until_secs: Option<f64>) {
    sqlx::query(
        "INSERT INTO notification_rule (workspace_id, member_id, dnd, dnd_until) \
         VALUES ($1, $2, $3, now() + make_interval(secs => $4::double precision)) \
         ON CONFLICT (workspace_id, member_id) \
         DO UPDATE SET dnd = EXCLUDED.dnd, dnd_until = EXCLUDED.dnd_until",
    )
    .bind(tenant.workspace)
    .bind(tenant.me.id)
    .bind(dnd)
    .bind(until_secs)
    .execute(su)
    .await
    .expect("set pause");
}

async fn epoch_ms(su: &PgPool, sql: &str, bind: Uuid) -> i64 {
    sqlx::query_scalar(sql)
        .bind(bind)
        .fetch_one(su)
        .await
        .expect("epoch ms")
}

async fn login(http: &reqwest::Client, base: &str, workspace: Uuid, human: &Human) -> String {
    let response = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": human.email,
            "password": TEST_PASSWORD,
            "workspace": workspace.to_string(),
        }))
        .send()
        .await
        .expect("login");
    assert_eq!(response.status(), 200, "seeded human logs in");
    let body: Value = response.json().await.expect("login body");
    body["accessToken"]
        .as_str()
        .expect("login returns an access token")
        .to_string()
}

async fn agent_bearer(su: &PgPool, workspace: Uuid, agent: Uuid) -> String {
    let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token = format!("momo_agent_v1.{workspace}.{secret}");
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, \
                            token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), \
                 ARRAY['messages:write']::text[], 'notification-diagnostics-conformance')",
    )
    .bind(workspace)
    .bind(agent)
    .bind(&token)
    .execute(su)
    .await
    .expect("seed agent bearer");
    token
}

/// What the tests call: the server, an HTTP client and `me`'s bearer.
struct Caller {
    http: reqwest::Client,
    base: String,
    workspace: Uuid,
    token: String,
}

impl Caller {
    async fn of(base: &str, workspace: Uuid, human: &Human) -> Caller {
        let http = reqwest::Client::new();
        let token = login(&http, base, workspace, human).await;
        Caller {
            http,
            base: base.to_string(),
            workspace,
            token,
        }
    }

    fn url(&self, tail: &str) -> String {
        format!(
            "{}/v1/workspaces/{}/notification-diagnostics{tail}",
            self.base, self.workspace
        )
    }

    async fn diagnostics(&self, query: &str) -> (u16, Value) {
        let response = self
            .http
            .get(format!("{}{query}", self.url("")))
            .bearer_auth(&self.token)
            .send()
            .await
            .expect("GET diagnostics");
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(Value::Null))
    }

    async fn ok_diagnostics(&self, query: &str) -> Value {
        let (status, body) = self.diagnostics(query).await;
        assert_eq!(status, 200, "{body}");
        body
    }

    async fn send_test(&self) -> (u16, Value, Option<String>) {
        let response = self
            .http
            .post(self.url("/test"))
            .bearer_auth(&self.token)
            .send()
            .await
            .expect("POST test");
        let status = response.status().as_u16();
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        (
            status,
            response.json().await.unwrap_or(Value::Null),
            retry_after,
        )
    }
}

fn codes(body: &Value) -> Vec<String> {
    body["blockers"]
        .as_array()
        .expect("blockers is an array")
        .iter()
        .map(|blocker| blocker["code"].as_str().expect("a code").to_string())
        .collect()
}

fn blocker<'a>(body: &'a Value, code: &str) -> &'a Value {
    body["blockers"]
        .as_array()
        .expect("blockers is an array")
        .iter()
        .find(|blocker| blocker["code"] == code)
        .unwrap_or_else(|| panic!("no {code} blocker in {body}"))
}

async fn push_system_rows(su: &PgPool, workspace: Uuid) -> Vec<(String, String, Value)> {
    let rows: Vec<(String, String, Value)> = sqlx::query_as(
        "SELECT status::text, method, payload FROM outbox \
          WHERE workspace_id = $1 AND kind = 'push_system' ORDER BY id",
    )
    .bind(workspace)
    .fetch_all(su)
    .await
    .expect("read push_system rows");
    rows
}

// ---------------------------------------------------------------------------
// the read side: the closed codes
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn a_pause_is_reported_until_it_ends() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let tenant = seed_tenant(&su).await;
    seed_token(&su, tenant.workspace, tenant.me.id).await;
    let base = start_server(momo_app_pool().await).await;
    let me = Caller::of(&base, tenant.workspace, &tenant.me).await;

    // Baseline: a live token and nothing held back.
    let body = me.ok_diagnostics("").await;
    assert_eq!(body["ok"], json!(true), "{body}");
    assert_eq!(codes(&body), Vec::<String>::new());
    assert_eq!(body["devices"], json!({"active": 1, "invalidated": 0}));
    assert!(body["checkedAtMs"].as_i64().unwrap() > 0);
    assert!(
        body.get("lastTest").is_none(),
        "no test was ever sent: {body}"
    );

    // An open-ended pause: reported, with no end.
    set_pause(&su, &tenant, true, None).await;
    let body = me.ok_diagnostics("").await;
    assert_eq!(body["ok"], json!(false));
    assert_eq!(codes(&body), ["paused"]);
    assert!(blocker(&body, "paused").get("untilMs").is_none(), "{body}");

    // A timed pause: reported with the instant it ends.
    set_pause(&su, &tenant, true, Some(3600.0)).await;
    let until = epoch_ms(
        &su,
        "SELECT floor(extract(epoch FROM dnd_until) * 1000)::bigint \
           FROM notification_rule WHERE member_id = $1",
        tenant.me.id,
    )
    .await;
    let body = me.ok_diagnostics("").await;
    assert_eq!(blocker(&body, "paused")["untilMs"], json!(until), "{body}");

    // A pause whose time has passed is not a blocker, and neither is a pause that is switched off.
    set_pause(&su, &tenant, true, Some(-60.0)).await;
    assert_eq!(codes(&me.ok_diagnostics("").await), Vec::<String>::new());
    set_pause(&su, &tenant, false, None).await;
    assert_eq!(codes(&me.ok_diagnostics("").await), Vec::<String>::new());
}

#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn a_channel_mute_is_reported_only_for_a_channel_the_caller_belongs_to() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let tenant = seed_tenant(&su).await;
    let foreign = seed_tenant(&su).await;
    seed_token(&su, tenant.workspace, tenant.me.id).await;
    let base = start_server(momo_app_pool().await).await;
    let me = Caller::of(&base, tenant.workspace, &tenant.me).await;
    let query = format!("?channelId={}", tenant.my_channel);

    assert_eq!(
        codes(&me.ok_diagnostics(&query).await),
        Vec::<String>::new()
    );

    // A mute with no end.
    sqlx::query(
        "INSERT INTO notification_pref (workspace_id, member_id, channel_id, muted_until) \
         VALUES ($1, $2, $3, NULL)",
    )
    .bind(tenant.workspace)
    .bind(tenant.me.id)
    .bind(tenant.my_channel)
    .execute(&su)
    .await
    .expect("mute");
    let body = me.ok_diagnostics(&query).await;
    assert_eq!(codes(&body), ["channel_muted"]);
    assert_eq!(
        blocker(&body, "channel_muted")["channelId"],
        json!(tenant.my_channel.to_string())
    );
    assert!(blocker(&body, "channel_muted").get("untilMs").is_none());
    // The mute is about one channel: asking without `channelId` does not report it.
    assert_eq!(codes(&me.ok_diagnostics("").await), Vec::<String>::new());

    // A timed mute carries its end; an expired one is not a blocker.
    sqlx::query(
        "UPDATE notification_pref SET muted_until = now() + interval '1 hour' \
          WHERE member_id = $1 AND channel_id = $2",
    )
    .bind(tenant.me.id)
    .bind(tenant.my_channel)
    .execute(&su)
    .await
    .unwrap();
    let until: i64 = sqlx::query_scalar(
        "SELECT floor(extract(epoch FROM muted_until) * 1000)::bigint FROM notification_pref \
          WHERE member_id = $1 AND channel_id = $2",
    )
    .bind(tenant.me.id)
    .bind(tenant.my_channel)
    .fetch_one(&su)
    .await
    .unwrap();
    let body = me.ok_diagnostics(&query).await;
    assert_eq!(blocker(&body, "channel_muted")["untilMs"], json!(until));
    sqlx::query(
        "UPDATE notification_pref SET muted_until = now() - interval '1 minute' \
          WHERE member_id = $1 AND channel_id = $2",
    )
    .bind(tenant.me.id)
    .bind(tenant.my_channel)
    .execute(&su)
    .await
    .unwrap();
    assert_eq!(
        codes(&me.ok_diagnostics(&query).await),
        Vec::<String>::new()
    );

    // The 404s are one answer: a channel that exists but is not the caller's, one that does not
    // exist, one in another tenant, and one the caller left. Existence is not disclosed.
    let mut answers: Vec<(u16, Value)> = Vec::new();
    for channel in [tenant.others_channel, Uuid::new_v4(), foreign.my_channel] {
        answers.push(me.diagnostics(&format!("?channelId={channel}")).await);
    }
    sqlx::query("UPDATE membership SET left_at = now() WHERE channel_id = $1 AND member_id = $2")
        .bind(tenant.my_channel)
        .bind(tenant.me.id)
        .execute(&su)
        .await
        .unwrap();
    answers.push(me.diagnostics(&query).await);
    for (status, body) in &answers {
        assert_eq!(*status, 404, "{body}");
    }
    assert!(
        answers.windows(2).all(|pair| pair[0].1 == pair[1].1),
        "the four 404 bodies must be identical: {answers:?}"
    );

    // A malformed id is the caller's mistake, not a missing channel.
    let (status, _) = me.diagnostics("?channelId=not-a-uuid").await;
    assert_eq!(status, 400);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn the_devices_say_no_device_then_token_invalidated() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let tenant = seed_tenant(&su).await;
    // Somebody else's live token must not count for me.
    seed_token(&su, tenant.workspace, tenant.other.id).await;
    let base = start_server(momo_app_pool().await).await;
    let me = Caller::of(&base, tenant.workspace, &tenant.me).await;

    let body = me.ok_diagnostics("").await;
    assert_eq!(codes(&body), ["no_device"], "{body}");
    assert_eq!(body["devices"], json!({"active": 0, "invalidated": 0}));
    assert_eq!(body["ok"], json!(false));

    // Every token dead: `token_invalidated`, since the moment the last one died.
    let token = seed_token(&su, tenant.workspace, tenant.me.id).await;
    invalidate_token(&su, token).await;
    let since = epoch_ms(
        &su,
        "SELECT floor(extract(epoch FROM invalidated_at) * 1000)::bigint \
           FROM push_token WHERE id = $1",
        token,
    )
    .await;
    let body = me.ok_diagnostics("").await;
    assert_eq!(codes(&body), ["token_invalidated"], "{body}");
    assert_eq!(blocker(&body, "token_invalidated")["sinceMs"], json!(since));
    assert_eq!(body["devices"], json!({"active": 0, "invalidated": 1}));

    // One live token clears both codes.
    seed_token(&su, tenant.workspace, tenant.me.id).await;
    let body = me.ok_diagnostics("").await;
    assert_eq!(codes(&body), Vec::<String>::new(), "{body}");
    assert_eq!(body["devices"], json!({"active": 1, "invalidated": 1}));
}

#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn relay_unreachable_is_inferred_from_stale_claims_and_stalled_tests() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let tenant = seed_tenant(&su).await;
    let token = seed_token(&su, tenant.workspace, tenant.me.id).await;
    let base = start_server(momo_app_pool().await).await;
    let me = Caller::of(&base, tenant.workspace, &tenant.me).await;
    let (ws, member) = (tenant.workspace, tenant.me.id);

    // A claim still unsettled after 60 s is in flight, not stuck.
    seed_dispatch_log(&su, &tenant, member, token, None, None, 60.0).await;
    assert_eq!(codes(&me.ok_diagnostics("").await), Vec::<String>::new());

    // After 2 minutes it is `relay_unreachable`, since the oldest such claim.
    clear_dispatch_log(&su, member).await;
    seed_dispatch_log(&su, &tenant, member, token, None, None, 130.0).await;
    let body = me.ok_diagnostics("").await;
    assert_eq!(codes(&body), ["relay_unreachable"], "{body}");
    let since = blocker(&body, "relay_unreachable")["sinceMs"]
        .as_i64()
        .unwrap();
    let now = body["checkedAtMs"].as_i64().unwrap();
    assert!(
        (now - since - 130_000).abs() < 5_000,
        "since is the claim's age: now={now} since={since}"
    );

    // The same claim from 16 minutes ago says nothing about the relay now (lookback is 15).
    clear_dispatch_log(&su, member).await;
    seed_dispatch_log(&su, &tenant, member, token, None, None, 16.0 * 60.0).await;
    assert_eq!(codes(&me.ok_diagnostics("").await), Vec::<String>::new());

    // A claim of a token that has since died, and one of another member, are not mine to report.
    clear_dispatch_log(&su, member).await;
    let dead = seed_token(&su, ws, member).await;
    invalidate_token(&su, dead).await;
    seed_dispatch_log(&su, &tenant, member, dead, None, None, 200.0).await;
    let others_token = seed_token(&su, ws, tenant.other.id).await;
    seed_dispatch_log(
        &su,
        &tenant,
        tenant.other.id,
        others_token,
        None,
        None,
        200.0,
    )
    .await;
    assert_eq!(codes(&me.ok_diagnostics("").await), Vec::<String>::new());
    clear_dispatch_log(&su, member).await;
    clear_dispatch_log(&su, tenant.other.id).await;

    // A test push nobody processed: `queued` under 30 s, then `stalled` — and a stalled test is
    // `relay_unreachable` (the notifier may be off).
    let test_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO notification_rule (workspace_id, member_id, last_test_id, last_test_at) \
         VALUES ($1, $2, $3, now() - interval '20 seconds') \
         ON CONFLICT (workspace_id, member_id) \
         DO UPDATE SET last_test_id = EXCLUDED.last_test_id, last_test_at = EXCLUDED.last_test_at",
    )
    .bind(ws)
    .bind(member)
    .bind(test_id)
    .execute(&su)
    .await
    .unwrap();
    let body = me.ok_diagnostics("").await;
    assert_eq!(body["lastTest"]["status"], "queued", "{body}");
    assert_eq!(codes(&body), Vec::<String>::new());

    sqlx::query("UPDATE notification_rule SET last_test_at = now() - interval '31 seconds' WHERE member_id = $1")
        .bind(member)
        .execute(&su)
        .await
        .unwrap();
    let body = me.ok_diagnostics("").await;
    assert_eq!(body["lastTest"]["status"], "stalled", "{body}");
    assert_eq!(body["lastTest"]["id"], json!(test_id.to_string()));
    assert_eq!(codes(&body), ["relay_unreachable"]);
    assert_eq!(
        blocker(&body, "relay_unreachable")["sinceMs"],
        body["lastTest"]["atMs"],
        "the stalled test is where it started"
    );

    // A test that stalled 20 minutes ago is still `stalled` but no longer evidence.
    sqlx::query("UPDATE notification_rule SET last_test_at = now() - interval '20 minutes' WHERE member_id = $1")
        .bind(member)
        .execute(&su)
        .await
        .unwrap();
    let body = me.ok_diagnostics("").await;
    assert_eq!(body["lastTest"]["status"], "stalled");
    assert_eq!(codes(&body), Vec::<String>::new(), "{body}");
}

#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn the_last_delivery_failure_is_a_code_and_never_a_relays_words() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let tenant = seed_tenant(&su).await;
    let token = seed_token(&su, tenant.workspace, tenant.me.id).await;
    let base = start_server(momo_app_pool().await).await;
    let me = Caller::of(&base, tenant.workspace, &tenant.me).await;
    let (ws, member) = (tenant.workspace, tenant.me.id);

    // An APNs refusal is reported with its status and reason code.
    seed_dispatch_log(
        &su,
        &tenant,
        member,
        token,
        Some(410),
        Some("Unregistered"),
        60.0,
    )
    .await;
    let body = me.ok_diagnostics("").await;
    assert_eq!(codes(&body), ["last_delivery_failed"], "{body}");
    let failed = blocker(&body, "last_delivery_failed");
    assert_eq!(failed["apnsStatus"], 410);
    assert_eq!(failed["apnsReason"], "Unregistered");
    assert!(failed["atMs"].as_i64().unwrap() > 0);

    // A later 200 clears it: the latest settled record decides.
    seed_dispatch_log(&su, &tenant, member, token, Some(200), None, 10.0).await;
    assert_eq!(codes(&me.ok_diagnostics("").await), Vec::<String>::new());

    // A relay refusal is turned into a code; the relay's sentence never reaches the response.
    clear_dispatch_log(&su, member).await;
    seed_dispatch_log(
        &su,
        &tenant,
        member,
        token,
        Some(400),
        Some("relay_http: HTTP 400: invalid momo.push.dispatch.v2 payload"),
        30.0,
    )
    .await;
    let (status, raw) = me.diagnostics("").await;
    assert_eq!(status, 200);
    assert_eq!(
        blocker(&raw, "last_delivery_failed")["apnsReason"],
        "relay_vocabulary_refused"
    );
    let text = raw.to_string();
    for fragment in ["invalid momo", "payload", "relay_http", "HTTP 400"] {
        assert!(
            !text.contains(fragment),
            "a relay's words leaked ({fragment}): {text}"
        );
    }
    clear_dispatch_log(&su, member).await;
    seed_dispatch_log(
        &su,
        &tenant,
        member,
        token,
        Some(400),
        Some("relay_http: HTTP 400: dispatch APNs environment does not match relay"),
        30.0,
    )
    .await;
    assert_eq!(
        blocker(&me.ok_diagnostics("").await, "last_delivery_failed")["apnsReason"],
        "relay_environment_mismatch"
    );

    // The bulk layer's drop is the server's own choice to send fewer pushes — not a failure. Newer
    // than the real failure, it must be skipped, so the failure below it still decides.
    seed_dispatch_log(
        &su,
        &tenant,
        member,
        token,
        Some(429),
        Some("relay_http: dropped"),
        5.0,
    )
    .await;
    assert_eq!(
        blocker(&me.ok_diagnostics("").await, "last_delivery_failed")["apnsReason"],
        "relay_environment_mismatch"
    );
    clear_dispatch_log(&su, member).await;
    seed_dispatch_log(
        &su,
        &tenant,
        member,
        token,
        Some(429),
        Some("relay_http: dropped"),
        5.0,
    )
    .await;
    assert_eq!(
        codes(&me.ok_diagnostics("").await),
        Vec::<String>::new(),
        "a drop alone is not a delivery failure"
    );

    // Older than 7 days, or on a token that has since died, it is not on the screen.
    clear_dispatch_log(&su, member).await;
    seed_dispatch_log(
        &su,
        &tenant,
        member,
        token,
        Some(410),
        Some("Unregistered"),
        8.0 * 86_400.0,
    )
    .await;
    assert_eq!(codes(&me.ok_diagnostics("").await), Vec::<String>::new());
    clear_dispatch_log(&su, member).await;
    let dead = seed_token(&su, ws, member).await;
    seed_dispatch_log(
        &su,
        &tenant,
        member,
        dead,
        Some(410),
        Some("Unregistered"),
        5.0,
    )
    .await;
    invalidate_token(&su, dead).await;
    assert_eq!(codes(&me.ok_diagnostics("").await), Vec::<String>::new());
}

/// One log row of a test push: the dispatch of test `collapse` to `token`.
async fn seed_test_log(
    su: &PgPool,
    tenant: &Tenant,
    token: Uuid,
    collapse: &str,
    status: Option<i32>,
    reason: Option<&str>,
) {
    sqlx::query(
        "INSERT INTO push_dispatch_log \
           (workspace_id, member_id, push_token_id, collapse_id, apns_status, apns_reason) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(tenant.workspace)
    .bind(tenant.me.id)
    .bind(token)
    .bind(collapse)
    .bind(status)
    .bind(reason)
    .execute(su)
    .await
    .expect("seed a test dispatch log row");
}

#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn the_last_test_reads_the_dispatch_log_by_its_collapse_id() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let tenant = seed_tenant(&su).await;
    let device_a = seed_token(&su, tenant.workspace, tenant.me.id).await;
    let device_b = seed_token(&su, tenant.workspace, tenant.me.id).await;
    let base = start_server(momo_app_pool().await).await;
    let me = Caller::of(&base, tenant.workspace, &tenant.me).await;
    let test_id = Uuid::new_v4();
    let collapse = test_notification_collapse_id(test_id);
    sqlx::query(
        "INSERT INTO notification_rule (workspace_id, member_id, last_test_id, last_test_at) \
         VALUES ($1, $2, $3, now() - interval '5 seconds') \
         ON CONFLICT (workspace_id, member_id) \
         DO UPDATE SET last_test_id = EXCLUDED.last_test_id, last_test_at = EXCLUDED.last_test_at",
    )
    .bind(tenant.workspace)
    .bind(tenant.me.id)
    .bind(test_id)
    .execute(&su)
    .await
    .unwrap();
    let vocabulary = "relay_http: HTTP 400: invalid momo.push.dispatch.v2 payload";
    let environment = "relay_http: HTTP 400: dispatch APNs environment does not match relay";
    let status_of = |body: &Value| body["lastTest"]["status"].as_str().unwrap().to_string();

    // Nothing recorded and young: queued. The outbox is never read — there is no row to find.
    let body = me.ok_diagnostics("").await;
    assert_eq!(
        (status_of(&body), body["lastTest"].get("apnsStatus")),
        ("queued".into(), None)
    );

    // Unsettled claims only: still queued while young, stalled once it is 30 s old.
    seed_test_log(&su, &tenant, device_a, &collapse, None, None).await;
    assert_eq!(status_of(&me.ok_diagnostics("").await), "queued");
    sqlx::query("UPDATE notification_rule SET last_test_at = now() - interval '40 seconds' WHERE member_id = $1")
        .bind(tenant.me.id)
        .execute(&su)
        .await
        .unwrap();
    assert_eq!(status_of(&me.ok_diagnostics("").await), "stalled");
    sqlx::query("UPDATE notification_rule SET last_test_at = now() - interval '5 seconds' WHERE member_id = $1")
        .bind(tenant.me.id)
        .execute(&su)
        .await
        .unwrap();

    // Two devices, 200 and 410: sent (one device is enough).
    clear_dispatch_log(&su, tenant.me.id).await;
    seed_test_log(&su, &tenant, device_a, &collapse, Some(200), None).await;
    seed_test_log(
        &su,
        &tenant,
        device_b,
        &collapse,
        Some(410),
        Some("Unregistered"),
    )
    .await;
    let body = me.ok_diagnostics("").await;
    assert_eq!(
        (status_of(&body), &body["lastTest"]["apnsStatus"]),
        ("sent".into(), &json!(200))
    );

    // Every attempt the relay's vocabulary refusal: an outdated relay (and a code on the failure).
    clear_dispatch_log(&su, tenant.me.id).await;
    seed_test_log(
        &su,
        &tenant,
        device_a,
        &collapse,
        Some(400),
        Some(vocabulary),
    )
    .await;
    seed_test_log(
        &su,
        &tenant,
        device_b,
        &collapse,
        Some(400),
        Some(vocabulary),
    )
    .await;
    let body = me.ok_diagnostics("").await;
    assert_eq!(
        (status_of(&body), &body["lastTest"]["apnsStatus"]),
        ("relay_outdated".into(), &json!(400))
    );
    assert_eq!(
        blocker(&body, "last_delivery_failed")["apnsReason"],
        "relay_vocabulary_refused"
    );

    // The environment mismatch is also a 400 — and is only `failed`: the relay is not outdated.
    clear_dispatch_log(&su, tenant.me.id).await;
    seed_test_log(
        &su,
        &tenant,
        device_a,
        &collapse,
        Some(400),
        Some(environment),
    )
    .await;
    let body = me.ok_diagnostics("").await;
    assert_eq!(status_of(&body), "failed");
    assert_eq!(
        blocker(&body, "last_delivery_failed")["apnsReason"],
        "relay_environment_mismatch"
    );
    // One refusal and one device the relay accepted: sent.
    seed_test_log(&su, &tenant, device_b, &collapse, Some(200), None).await;
    assert_eq!(status_of(&me.ok_diagnostics("").await), "sent");

    // A relay 429 settled by the best-effort path: failed.
    clear_dispatch_log(&su, tenant.me.id).await;
    seed_test_log(
        &su,
        &tenant,
        device_a,
        &collapse,
        Some(429),
        Some("relay_http: HTTP 429"),
    )
    .await;
    let body = me.ok_diagnostics("").await;
    assert_eq!(
        (status_of(&body), &body["lastTest"]["apnsStatus"]),
        ("failed".into(), &json!(429))
    );

    // Another test's rows are not this test's: matched by the collapse id, exactly.
    clear_dispatch_log(&su, tenant.me.id).await;
    seed_test_log(
        &su,
        &tenant,
        device_a,
        &test_notification_collapse_id(Uuid::new_v4()),
        Some(200),
        None,
    )
    .await;
    seed_test_log(&su, &tenant, device_b, "m:some-message", Some(200), None).await;
    assert_eq!(
        status_of(&me.ok_diagnostics("").await),
        "queued",
        "a 200 for another test or for a message is not this test's result"
    );
}

/// #4341 security review M-1: the `lastTest` read must be **index-exact**, and a plan is not a
/// result — the result-checking test above passes on a sequential scan too. So this one asks
/// Postgres for the plan of the production SQL text itself ([`LAST_TEST_ROWS_SQL`]) on one member's
/// 60,000 log rows and requires the partial unique index of migration 011 to serve it.
///
/// `enable_seqscan = off` takes "a scan is cheaper on a table this small" out of the question, so
/// what is left to choose from is only what the query is *allowed* to use: without the line
/// `AND push_token_id IS NOT NULL` the planner cannot prove that index's predicate and never
/// considers it. Everything runs in one rolled-back transaction: no row is left behind.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn the_last_test_read_is_served_by_the_partial_unique_index() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let tenant = seed_tenant(&su).await;
    let mut tokens = Vec::new();
    for _ in 0..3 {
        tokens.push(seed_token(&su, tenant.workspace, tenant.me.id).await);
    }
    let collapse = test_notification_collapse_id(Uuid::new_v4());

    let mut tx = su.begin().await.expect("begin");
    // The member's whole history: 20,000 message pushes per device, then this test's three rows.
    sqlx::query(
        "INSERT INTO push_dispatch_log \
           (workspace_id, member_id, push_token_id, collapse_id, apns_status, created_at) \
         SELECT $1, $2, token, 'm:' || n, 200, now() - make_interval(secs => n) \
           FROM unnest($3::uuid[]) AS token CROSS JOIN generate_series(1, 20000) AS n",
    )
    .bind(tenant.workspace)
    .bind(tenant.me.id)
    .bind(&tokens)
    .execute(&mut *tx)
    .await
    .expect("seed the member's history");
    sqlx::query(
        "INSERT INTO push_dispatch_log \
           (workspace_id, member_id, push_token_id, collapse_id, apns_status, created_at) \
         SELECT $1, $2, token, $4, 200, now() - interval '3 minutes' \
           FROM unnest($3::uuid[]) AS token",
    )
    .bind(tenant.workspace)
    .bind(tenant.me.id)
    .bind(&tokens)
    .bind(&collapse)
    .execute(&mut *tx)
    .await
    .expect("seed the test's rows");
    sqlx::query("ANALYZE push_dispatch_log")
        .execute(&mut *tx)
        .await
        .expect("analyze");
    sqlx::query("SET LOCAL enable_seqscan = off")
        .execute(&mut *tx)
        .await
        .expect("take the sequential scan off the table");

    let lines: Vec<String> =
        sqlx::query_scalar(&format!("EXPLAIN (COSTS OFF) {LAST_TEST_ROWS_SQL}"))
            .bind(tenant.workspace)
            .bind(tenant.me.id)
            .bind(&collapse)
            .fetch_all(&mut *tx)
            .await
            .expect("explain the lastTest read");
    let plan = lines.join("\n");
    // The same text must still answer: three rows, one per device.
    let answered: Vec<(Option<i32>,)> = sqlx::query_as(LAST_TEST_ROWS_SQL)
        .bind(tenant.workspace)
        .bind(tenant.me.id)
        .bind(&collapse)
        .fetch_all(&mut *tx)
        .await
        .expect("run the lastTest read");
    tx.rollback().await.expect("roll back");

    assert!(
        plan.contains("push_dispatch_dedupe_uniq"),
        "the lastTest read is not served by the partial unique index (the planner may use it only \
         when the query proves `push_token_id IS NOT NULL`):\n{plan}"
    );
    assert_eq!(answered.len(), 3, "one dispatch row per device\n{plan}");
}

#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn kind_off_needs_a_switched_off_kind_and_quiet_hours_waits_for_its_slice() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let tenant = seed_tenant(&su).await;
    let base = start_server(momo_app_pool().await).await;
    let me = Caller::of(&base, tenant.workspace, &tenant.me).await;

    // Everything that can be wrong at once: paused, the channel muted, no device. The codes come
    // in the response's fixed order. With no kind switch off `kind_off` is not among them for any
    // kind the caller names (the member in `notification_prefs_conformance_pg` who turned one off
    // gets it), and `quiet_hours` is not among them until the work-hours slice (N7) judges a schedule.
    set_pause(&su, &tenant, true, None).await;
    sqlx::query(
        "INSERT INTO notification_pref (workspace_id, member_id, channel_id, muted_until) \
         VALUES ($1, $2, $3, NULL)",
    )
    .bind(tenant.workspace)
    .bind(tenant.me.id)
    .bind(tenant.my_channel)
    .execute(&su)
    .await
    .unwrap();
    for kind in [
        "dm",
        "mentionHuman",
        "mentionAgent",
        "agentAnswer",
        "approval",
        "workDone",
        "keyword",
        "channelAll",
        "threadReply",
        "scheduledFailed",
    ] {
        let body = me
            .ok_diagnostics(&format!("?channelId={}&kind={kind}", tenant.my_channel))
            .await;
        assert_eq!(
            codes(&body),
            ["paused", "channel_muted", "no_device"],
            "kind={kind}: {body}"
        );
    }

    // An unknown kind is a 400, as is an empty one; the wire reasons are not kinds.
    for bad in ["bogus", "", "channel_message", "DM"] {
        let (status, _) = me.diagnostics(&format!("?kind={bad}")).await;
        assert_eq!(status, 400, "kind={bad:?}");
    }
}

// ---------------------------------------------------------------------------
// the write side: the test push
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn a_test_push_passes_a_pause_and_writes_one_id_only_row_for_the_caller() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let tenant = seed_tenant(&su).await;
    let elsewhere = seed_tenant(&su).await;
    seed_token(&su, tenant.workspace, tenant.me.id).await;
    seed_token(&su, tenant.workspace, tenant.other.id).await;
    seed_token(&su, elsewhere.workspace, elsewhere.me.id).await;
    // The pause is on — the test must still go: the gates are what the GET reports.
    set_pause(&su, &tenant, true, None).await;
    let base = start_server(momo_app_pool().await).await;
    let me = Caller::of(&base, tenant.workspace, &tenant.me).await;

    let (status, body, _) = me.send_test().await;
    assert_eq!(status, 202, "{body}");
    assert_eq!(body["deviceCount"], 1);
    let test_id: Uuid = body["testId"].as_str().expect("testId").parse().unwrap();

    // Exactly one outbox row, for exactly this member, ids and labels only.
    let rows = push_system_rows(&su, tenant.workspace).await;
    assert_eq!(rows.len(), 1, "{rows:?}");
    let (row_status, method, payload) = &rows[0];
    assert_eq!(
        (row_status.as_str(), method.as_str()),
        ("pending", "notify")
    );
    assert_eq!(payload["schema"], "momo.push_system.v1");
    assert_eq!(payload["reason"], "test_notification");
    assert_eq!(payload["member_id"], json!(tenant.me.id.to_string()));
    assert_eq!(payload["ref_id"], json!(test_id.to_string()));
    assert_eq!(
        payload["collapse_id"],
        json!(test_notification_collapse_id(test_id))
    );
    let mut keys: Vec<&str> = payload
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        ["collapse_id", "member_id", "reason", "ref_id", "schema"],
        "a name, a body or a channel title has no key to ride on"
    );
    let text = payload.to_string();
    assert!(
        !text.contains(&tenant.other.id.to_string()),
        "the other member leaked: {text}"
    );
    assert!(push_system_rows(&su, elsewhere.workspace).await.is_empty());

    // The budget and the last test are written on the caller's rule row — and the pause the
    // caller set is still on (the test writes only its own four columns).
    let (dnd, count, last_id, has_at, has_window): (bool, Option<i16>, Option<Uuid>, bool, bool) =
        sqlx::query_as(
            "SELECT dnd, test_push_count, last_test_id, last_test_at IS NOT NULL, \
                    test_push_window_start IS NOT NULL \
               FROM notification_rule WHERE workspace_id = $1 AND member_id = $2",
        )
        .bind(tenant.workspace)
        .bind(tenant.me.id)
        .fetch_one(&su)
        .await
        .unwrap();
    assert!(dnd, "the test must not overwrite the pause");
    assert_eq!(
        (count, last_id, has_at, has_window),
        (Some(1), Some(test_id), true, true)
    );
    let others_rule: i64 =
        sqlx::query_scalar("SELECT count(*) FROM notification_rule WHERE member_id = $1")
            .bind(tenant.other.id)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(others_rule, 0, "nothing was written for anybody else");

    // The GET reads the test back: queued (nobody has drained it yet), the pause still reported.
    let body = me.ok_diagnostics("").await;
    assert_eq!(body["lastTest"]["status"], "queued", "{body}");
    assert_eq!(body["lastTest"]["id"], json!(test_id.to_string()));
    assert_eq!(codes(&body), ["paused"]);

    // Another tenant's member gets their own row in their own workspace and nobody's budget moves.
    let theirs = Caller::of(&base, elsewhere.workspace, &elsewhere.me).await;
    let (status, _, _) = theirs.send_test().await;
    assert_eq!(status, 202);
    assert_eq!(push_system_rows(&su, elsewhere.workspace).await.len(), 1);
    assert_eq!(push_system_rows(&su, tenant.workspace).await.len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn the_budget_is_three_per_minute_even_when_five_arrive_at_once() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let tenant = seed_tenant(&su).await;
    seed_token(&su, tenant.workspace, tenant.me.id).await;
    let base = start_server(momo_app_pool().await).await;
    let me = Arc::new(Caller::of(&base, tenant.workspace, &tenant.me).await);

    let mut handles = Vec::new();
    for _ in 0..5 {
        let me = Arc::clone(&me);
        handles.push(tokio::spawn(async move { me.send_test().await }));
    }
    let mut accepted = 0;
    let mut limited = 0;
    for handle in handles {
        let (status, body, retry_after) = handle.await.expect("request task");
        match status {
            202 => accepted += 1,
            429 => {
                limited += 1;
                assert_eq!(body["error"]["code"], "rate_limited", "{body}");
                let seconds: u64 = retry_after
                    .expect("a 429 says when to come back")
                    .parse()
                    .unwrap();
                assert!((1..=60).contains(&seconds), "Retry-After {seconds}");
            }
            other => panic!("unexpected status {other}: {body}"),
        }
    }
    assert_eq!(
        (accepted, limited),
        (3, 2),
        "the row lock makes the budget exact"
    );
    assert_eq!(push_system_rows(&su, tenant.workspace).await.len(), 3);
    let count: Option<i16> =
        sqlx::query_scalar("SELECT test_push_count FROM notification_rule WHERE member_id = $1")
            .bind(tenant.me.id)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(count, Some(3));

    // The fourth in a row is refused too, and refusing spends nothing.
    let (status, _, _) = me.send_test().await;
    assert_eq!(status, 429);
    assert_eq!(push_system_rows(&su, tenant.workspace).await.len(), 3);

    // 59 seconds into the window is still the window; 61 is a new one.
    sqlx::query("UPDATE notification_rule SET test_push_window_start = now() - interval '59 seconds' WHERE member_id = $1")
        .bind(tenant.me.id)
        .execute(&su)
        .await
        .unwrap();
    let (status, _, _) = me.send_test().await;
    assert_eq!(status, 429, "59 seconds in, the window is still open");
    sqlx::query("UPDATE notification_rule SET test_push_window_start = now() - interval '61 seconds' WHERE member_id = $1")
        .bind(tenant.me.id)
        .execute(&su)
        .await
        .unwrap();
    let (status, _, _) = me.send_test().await;
    assert_eq!(status, 202, "61 seconds in, the window has reset");
    let count: Option<i16> =
        sqlx::query_scalar("SELECT test_push_count FROM notification_rule WHERE member_id = $1")
            .bind(tenant.me.id)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(count, Some(1), "the new window counts from one");
    assert_eq!(push_system_rows(&su, tenant.workspace).await.len(), 4);
}

/// Poll `pg_stat_activity` until a `momo_app` backend of this database waits on a lock, and return
/// the statement it is stuck on. Bounded: five seconds, then the test fails instead of hanging.
async fn the_statement_a_backend_is_blocked_on(su: &PgPool) -> String {
    for _ in 0..250 {
        let blocked: Option<String> = sqlx::query_scalar(
            "SELECT query FROM pg_stat_activity \
              WHERE datname = current_database() AND usename = 'momo_app' \
                AND state = 'active' AND wait_event_type = 'Lock' \
              LIMIT 1",
        )
        .fetch_optional(su)
        .await
        .expect("read pg_stat_activity");
        if let Some(query) = blocked {
            return query;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("no backend ever waited on a lock: the second test did not queue behind the first");
}

/// #4341 security review L-1: the row lock, measured instead of raced. Request A has read the
/// member's budget **under the row lock** and has not yet written it (the paused middle of
/// `reserve_test_push_in_tx`); a `POST` (B) arrives meanwhile. B must *queue at its own `FOR UPDATE`
/// read* and, once A has written and committed, count after A: the budget ends at 2. Without the
/// lock B reads the stale count, goes on to its `UPDATE` (where it waits for A's row instead) and
/// overwrites A's count with 1 — a lost update that five concurrent requests only sometimes show.
///
/// Why A is not simply `reserve_test_push_in_tx` held open: once a request has **updated** the rule
/// row, a later request's `INSERT … ON CONFLICT DO NOTHING` (the step before the read) waits for
/// that transaction by itself, so B would queue there with or without `FOR UPDATE` and the test
/// would prove nothing about the lock. The lock is decisive only between a request's read and its
/// write — so that is the state A is held in. The rule row is also committed beforehand (with no
/// row, B would wait on A's uncommitted `INSERT` for the same reason).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn a_second_test_waits_on_the_row_lock_and_counts_after_the_first() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let tenant = seed_tenant(&su).await;
    seed_token(&su, tenant.workspace, tenant.me.id).await;
    sqlx::query("INSERT INTO notification_rule (workspace_id, member_id) VALUES ($1, $2)")
        .bind(tenant.workspace)
        .bind(tenant.me.id)
        .execute(&su)
        .await
        .expect("commit the rule row first");
    let app = momo_app_pool().await;
    let base = start_server(app.clone()).await;
    let me = Arc::new(Caller::of(&base, tenant.workspace, &tenant.me).await);

    let (read_tx, read_rx) = tokio::sync::oneshot::channel::<()>();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
    let (workspace, member) = (tenant.workspace, tenant.me.id);
    let holder = tokio::spawn(async move {
        with_tenant_tx(&app, workspace, move |conn| {
            Box::pin(async move {
                // The read half of a request, under the lock …
                let spent: Option<i16> = sqlx::query_scalar(
                    "SELECT test_push_count FROM notification_rule \
                      WHERE workspace_id = $1 AND member_id = $2 FOR UPDATE",
                )
                .bind(workspace)
                .bind(member)
                .fetch_one(&mut *conn)
                .await?;
                assert_eq!(spent, None, "a fresh budget");
                read_tx.send(()).ok();
                // … paused here until released (or until the test gives up and drops the sender) …
                release_rx.await.ok();
                // … and its write half: one slot spent.
                let test_id: Uuid = sqlx::query_scalar("SELECT uuidv7()")
                    .fetch_one(&mut *conn)
                    .await?;
                sqlx::query(
                    "UPDATE notification_rule \
                        SET test_push_window_start = now(), test_push_count = 1, \
                            last_test_id = $3, last_test_at = now() \
                      WHERE workspace_id = $1 AND member_id = $2",
                )
                .bind(workspace)
                .bind(member)
                .bind(test_id)
                .execute(&mut *conn)
                .await?;
                Ok(test_id)
            })
        })
        .await
    });
    read_rx.await.expect("A read the budget under the lock");

    let second = {
        let me = Arc::clone(&me);
        tokio::spawn(async move { me.send_test().await })
    };
    let blocked_on = the_statement_a_backend_is_blocked_on(&su).await;
    assert!(
        blocked_on.contains("FOR UPDATE"),
        "B must queue at the row-locking read of the budget, not get past it and wait later: \
         blocked on `{blocked_on}`"
    );
    assert!(
        !second.is_finished(),
        "B answered while A still held the row: the budget is not serialized"
    );

    release_tx
        .send(())
        .expect("A is still waiting for its release");
    let first_test = holder.await.expect("A task").expect("A commits its slot");
    let (status, body, _) = second.await.expect("B task");
    assert_eq!(status, 202, "B is the second of three: {body}");

    let (count, last_id): (Option<i16>, Option<Uuid>) = sqlx::query_as(
        "SELECT test_push_count, last_test_id FROM notification_rule \
          WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(workspace)
    .bind(member)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(
        count,
        Some(2),
        "B must count after A's write; 1 is B overwriting A's count (a lost update)"
    );
    let second_test: Uuid = body["testId"].as_str().expect("testId").parse().unwrap();
    assert_ne!(first_test, second_test);
    assert_eq!(
        last_id,
        Some(second_test),
        "B committed last, so its test is the last test"
    );
    assert_eq!(
        push_system_rows(&su, workspace).await.len(),
        1,
        "only B wrote an outbox row"
    );
}

/// #4341 security review L-2: `Retry-After` never exceeds the window. A request that waited on the
/// row lock can have begun its transaction *before* the one that opened the window, so its `now()`
/// is earlier than `test_push_window_start`; the plain remainder was then a whole window **plus**
/// the gap (61 s). The same state is made directly: the window "opens" two seconds from now with
/// the budget spent.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn a_refused_test_never_asks_the_client_to_wait_more_than_the_window() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let tenant = seed_tenant(&su).await;
    seed_token(&su, tenant.workspace, tenant.me.id).await;
    sqlx::query(
        "INSERT INTO notification_rule \
           (workspace_id, member_id, test_push_window_start, test_push_count) \
         VALUES ($1, $2, now() + interval '2 seconds', 3)",
    )
    .bind(tenant.workspace)
    .bind(tenant.me.id)
    .execute(&su)
    .await
    .expect("a spent window that starts in the future");
    let base = start_server(momo_app_pool().await).await;
    let me = Caller::of(&base, tenant.workspace, &tenant.me).await;

    let (status, body, retry_after) = me.send_test().await;
    assert_eq!(status, 429, "{body}");
    assert_eq!(body["error"]["code"], "rate_limited", "{body}");
    assert_eq!(
        retry_after.as_deref(),
        Some("60"),
        "a whole window is the longest anyone is told to wait"
    );
    assert!(push_system_rows(&su, tenant.workspace).await.is_empty());
}

#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn no_device_is_409_and_spends_nothing() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let tenant = seed_tenant(&su).await;
    let base = start_server(momo_app_pool().await).await;
    let me = Caller::of(&base, tenant.workspace, &tenant.me).await;

    // No token at all, and then only a dead one: the same answer.
    let (status, body, _) = me.send_test().await;
    assert_eq!(
        (status, &body["error"]["code"]),
        (409, &json!("no_device")),
        "{body}"
    );
    let dead = seed_token(&su, tenant.workspace, tenant.me.id).await;
    invalidate_token(&su, dead).await;
    for _ in 0..5 {
        // More than the budget: a refusal is not a use of it.
        let (status, body, _) = me.send_test().await;
        assert_eq!(
            (status, &body["error"]["code"]),
            (409, &json!("no_device")),
            "{body}"
        );
    }
    assert!(push_system_rows(&su, tenant.workspace).await.is_empty());
    let rule_rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM notification_rule WHERE member_id = $1")
            .bind(tenant.me.id)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(
        rule_rows, 0,
        "a refused test writes nothing, not even the rule row"
    );

    // The first real test still gets its whole budget.
    seed_token(&su, tenant.workspace, tenant.me.id).await;
    for _ in 0..3 {
        let (status, _, _) = me.send_test().await;
        assert_eq!(status, 202);
    }
    let (status, _, _) = me.send_test().await;
    assert_eq!(status, 429);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn an_agent_bearer_and_a_stranger_get_nothing() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let tenant = seed_tenant(&su).await;
    let elsewhere = seed_tenant(&su).await;
    seed_token(&su, tenant.workspace, tenant.me.id).await;
    seed_token(&su, tenant.workspace, tenant.agent).await;
    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();
    let agent = agent_bearer(&su, tenant.workspace, tenant.agent).await;
    let get_url = format!(
        "{base}/v1/workspaces/{}/notification-diagnostics",
        tenant.workspace
    );
    let post_url = format!("{get_url}/test");

    // An agent bearer is refused on both routes, and nothing was written.
    assert_eq!(
        http.get(&get_url)
            .bearer_auth(&agent)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        http.post(&post_url)
            .bearer_auth(&agent)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    // No credential at all is 401.
    assert_eq!(http.get(&get_url).send().await.unwrap().status(), 401);
    assert_eq!(http.post(&post_url).send().await.unwrap().status(), 401);
    assert!(push_system_rows(&su, tenant.workspace).await.is_empty());

    // A person of another tenant, addressing this tenant's path, is refused (the path's tenant
    // must be the credential's) and writes nothing here.
    let stranger = login(&http, &base, elsewhere.workspace, &elsewhere.me).await;
    assert_eq!(
        http.get(&get_url)
            .bearer_auth(&stranger)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        http.post(&post_url)
            .bearer_auth(&stranger)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert!(push_system_rows(&su, tenant.workspace).await.is_empty());
    assert!(push_system_rows(&su, elsewhere.workspace).await.is_empty());
}

/// #4341 security review L-3: the door's JWT does not look at the member's state (a suspended or
/// soft-deleted member keeps a valid access token until it expires), so `active_workspace_role` in
/// the two handlers is what turns that member away. Both routes, three ways of no longer being an
/// active member, and nothing is written — no outbox row, no budget, not even the rule row.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn a_suspended_or_deleted_member_is_refused_on_both_routes() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let tenant = seed_tenant(&su).await;
    seed_token(&su, tenant.workspace, tenant.me.id).await;
    let base = start_server(momo_app_pool().await).await;
    // The credential is issued while the member is in good standing, and kept.
    let me = Caller::of(&base, tenant.workspace, &tenant.me).await;
    assert_eq!(
        me.ok_diagnostics("").await["ok"],
        true,
        "the baseline works"
    );

    for (state, sql) in [
        (
            "suspended",
            "UPDATE member SET status = 'suspended' WHERE id = $1",
        ),
        (
            "soft-deleted",
            "UPDATE member SET deleted_at = now() WHERE id = $1",
        ),
        (
            "status deleted",
            "UPDATE member SET status = 'deleted' WHERE id = $1",
        ),
    ] {
        sqlx::query(sql)
            .bind(tenant.me.id)
            .execute(&su)
            .await
            .expect("take the member out of good standing");

        let (status, body) = me.diagnostics("").await;
        assert_eq!(status, 403, "GET for a {state} member: {body}");
        assert_eq!(
            body["error"]["message"], "active human membership required",
            "GET for a {state} member is turned away by the handler's membership check: {body}"
        );
        let (status, body, _) = me.send_test().await;
        assert_eq!(status, 403, "POST for a {state} member: {body}");
        assert_eq!(
            body["error"]["message"], "active human membership required",
            "POST for a {state} member is turned away by the handler's membership check: {body}"
        );
        assert!(
            push_system_rows(&su, tenant.workspace).await.is_empty(),
            "a {state} member's test wrote an outbox row"
        );
        let rule_rows: i64 =
            sqlx::query_scalar("SELECT count(*) FROM notification_rule WHERE member_id = $1")
                .bind(tenant.me.id)
                .fetch_one(&su)
                .await
                .unwrap();
        assert_eq!(rule_rows, 0, "a {state} member's refusal wrote a rule row");

        sqlx::query("UPDATE member SET status = 'active', deleted_at = NULL WHERE id = $1")
            .bind(tenant.me.id)
            .execute(&su)
            .await
            .expect("reinstate the member");
        assert_eq!(
            me.ok_diagnostics("").await["ok"],
            true,
            "the same credential works again once the member is active: the refusal was the state"
        );
    }
}

#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn a_rolled_back_test_leaves_no_row_and_no_count() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let tenant = seed_tenant(&su).await;
    seed_token(&su, tenant.workspace, tenant.me.id).await;
    let app = momo_app_pool().await;
    let (workspace, member) = (tenant.workspace, tenant.me.id);

    // Reserve and enqueue, then fail before the commit: the counter and the row share a fate.
    let failed: Result<(), DbError> = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            let TestPushSlot::Reserved { test_id, .. } =
                reserve_test_push_in_tx(conn, workspace, member).await?
            else {
                panic!("a member with a live token gets a slot");
            };
            emit_push_system(
                conn,
                workspace,
                PushSystemReason::TestNotification,
                member,
                None,
                test_id,
                &test_notification_collapse_id(test_id),
            )
            .await?;
            Err(DbError::Sqlx(sqlx::Error::RowNotFound))
        })
    })
    .await;
    assert!(failed.is_err());
    assert!(
        push_system_rows(&su, workspace).await.is_empty(),
        "the row rolled back"
    );
    let rule: Option<(Option<i16>, Option<Uuid>)> = sqlx::query_as(
        "SELECT test_push_count, last_test_id FROM notification_rule \
          WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(workspace)
    .bind(member)
    .fetch_optional(&su)
    .await
    .unwrap();
    assert!(
        rule.is_none_or(|(count, last)| count.is_none() && last.is_none()),
        "the counter and the last test rolled back with the row: {rule:?}"
    );

    // The budget is whole afterwards.
    let base = start_server(app).await;
    let me = Caller::of(&base, workspace, &tenant.me).await;
    for _ in 0..3 {
        assert_eq!(me.send_test().await.0, 202);
    }
    assert_eq!(me.send_test().await.0, 429);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn the_old_rule_writes_leave_the_test_columns_alone() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let tenant = seed_tenant(&su).await;
    seed_token(&su, tenant.workspace, tenant.me.id).await;
    let base = start_server(momo_app_pool().await).await;
    let me = Caller::of(&base, tenant.workspace, &tenant.me).await;

    let (status, sent, _) = me.send_test().await;
    assert_eq!(status, 202);
    let test_id = sent["testId"].as_str().unwrap().to_string();
    let rules = format!(
        "{base}/v1/workspaces/{}/notification-rules",
        tenant.workspace
    );
    let put = me
        .http
        .put(&rules)
        .bearer_auth(&me.token)
        .json(&json!({"dnd": true, "mentionOverridesMute": true}))
        .send()
        .await
        .unwrap();
    assert_eq!(put.status(), 200);
    let patch = me
        .http
        .patch(&rules)
        .bearer_auth(&me.token)
        .json(&json!({"dnd": false}))
        .send()
        .await
        .unwrap();
    assert_eq!(patch.status(), 200);

    let (count, last_id): (Option<i16>, Option<Uuid>) = sqlx::query_as(
        "SELECT test_push_count, last_test_id FROM notification_rule WHERE member_id = $1",
    )
    .bind(tenant.me.id)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(count, Some(1));
    assert_eq!(last_id.map(|id| id.to_string()), Some(test_id.clone()));
    let body = me.ok_diagnostics("").await;
    assert_eq!(body["lastTest"]["id"], json!(test_id), "{body}");
}

// ---------------------------------------------------------------------------
// the whole path: POST → the notifier's second drain → the dispatch log → GET
// ---------------------------------------------------------------------------

/// Records every dispatch and answers 200 — the stand-in for the relay.
struct AcceptingRelay {
    sent: Mutex<Vec<PushDispatch>>,
}

#[async_trait::async_trait]
impl PushDispatcher for AcceptingRelay {
    async fn dispatch(&self, dispatch: &PushDispatch) -> DispatchOutcome {
        self.sent.lock().unwrap().push(dispatch.clone());
        DispatchOutcome::Accepted {
            apns_status: 200,
            apns_reason: None,
        }
    }
}

#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn a_test_push_reaches_the_dispatch_log_as_a_200_without_a_message() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let tenant = seed_tenant(&su).await;
    let my_token = seed_token(&su, tenant.workspace, tenant.me.id).await;
    seed_token(&su, tenant.workspace, tenant.other.id).await;
    // Paused, and the push must still arrive (ADR-0206 I6's one exception: the test the person pressed).
    set_pause(&su, &tenant, true, None).await;
    let base = start_server(momo_app_pool().await).await;
    let me = Caller::of(&base, tenant.workspace, &tenant.me).await;

    let started = std::time::Instant::now();
    let (status, body, _) = me.send_test().await;
    assert_eq!(status, 202, "{body}");
    let test_id: Uuid = body["testId"].as_str().unwrap().parse().unwrap();

    // The consumer: the notifier's role, the second drain, a recording relay.
    let relay = Arc::new(AcceptingRelay {
        sent: Mutex::new(Vec::new()),
    });
    let drain = PushDrain::new(
        momo_notifier_pool().await,
        PushConfig::for_target(),
        relay.clone(),
    );
    let stats = drain
        .drain_system_once(50)
        .await
        .expect("drain the push_system feed");
    assert!(stats.claimed >= 1, "{stats:?}");
    assert!(
        started.elapsed() < std::time::Duration::from_secs(5),
        "request to settled log row took {:?}",
        started.elapsed()
    );

    // Only this tenant's rows matter below: the drain claims the whole feed.
    let sent: Vec<PushDispatch> = relay
        .sent
        .lock()
        .unwrap()
        .iter()
        .filter(|dispatch| dispatch.workspace_id == tenant.workspace.to_string())
        .cloned()
        .collect();
    assert_eq!(
        sent.len(),
        1,
        "one device, one dispatch — and nothing for the other member"
    );
    assert_eq!(sent[0].reason, "test_notification");
    assert_eq!(sent[0].category, "momo.system");
    assert_eq!(sent[0].collapse_id, test_notification_collapse_id(test_id));
    let nil = Uuid::nil().to_string();
    assert_eq!(
        (&sent[0].channel_id, &sent[0].message_id, &sent[0].thread_id),
        (&nil, &nil, &nil)
    );

    let rows: Vec<(Uuid, Option<Uuid>, Option<i32>, String)> = sqlx::query_as(
        "SELECT push_token_id, message_id, apns_status, collapse_id FROM push_dispatch_log \
          WHERE workspace_id = $1",
    )
    .bind(tenant.workspace)
    .fetch_all(&su)
    .await
    .unwrap();
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(
        rows[0].0, my_token,
        "the caller's token, not the other member's"
    );
    assert_eq!(
        rows[0].1, None,
        "the log row names no message (NULL, not a nil id)"
    );
    assert_eq!(rows[0].2, Some(200));
    assert_eq!(rows[0].3, test_notification_collapse_id(test_id));
    let outbox_status: String = sqlx::query_scalar(
        "SELECT status::text FROM outbox WHERE workspace_id = $1 AND kind = 'push_system'",
    )
    .bind(tenant.workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(outbox_status, "done");

    // The GET reads the outcome from the log by the test's collapse id: sent, with the pause
    // still reported (the test passed it; the gate is for the next real push).
    let body = me.ok_diagnostics("").await;
    assert_eq!(body["lastTest"]["status"], "sent", "{body}");
    assert_eq!(body["lastTest"]["apnsStatus"], 200);
    assert_eq!(body["lastTest"]["id"], json!(test_id.to_string()));
    assert_eq!(codes(&body), ["paused"]);
}

/// #4341 security review H-1: one `POST` is at most [`SYSTEM_PUSH_MAX_TARGETS`] relay calls, however
/// many devices the member registered — the number of devices is the requester's to choose.
///
/// Six live devices, created in one order and *refreshed* in another: the first was just registered
/// again (a phone signing back in), the second has not been seen for an hour. The device left out
/// must be that stalest one — not the first created, not the last — so the order is read from
/// `updated_at` and not from the id. The response says how many devices the test goes to, and the
/// diagnostics still say how many the member has.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn one_test_goes_to_at_most_the_five_freshest_devices_and_says_so() {
    ensure_schema_and_roles();
    assert_eq!(
        SYSTEM_PUSH_MAX_TARGETS, 5,
        "the number this test is written around"
    );
    let su = superuser_pool().await;
    let tenant = seed_tenant(&su).await;
    let mut devices: Vec<(Uuid, Uuid)> = Vec::new(); // (token id, device id), in creation order
    for age_minutes in [0, 60, 5, 4, 3, 2] {
        let token = seed_token(&su, tenant.workspace, tenant.me.id).await;
        let device: Uuid = sqlx::query_scalar(
            "UPDATE push_token SET updated_at = now() - make_interval(mins => $2) \
              WHERE id = $1 RETURNING device_id",
        )
        .bind(token)
        .bind(age_minutes)
        .fetch_one(&su)
        .await
        .expect("set the token's last registration");
        devices.push((token, device));
    }
    let stalest = devices[1];
    let others_token = seed_token(&su, tenant.workspace, tenant.other.id).await;
    let base = start_server(momo_app_pool().await).await;
    let me = Caller::of(&base, tenant.workspace, &tenant.me).await;

    let (status, body, _) = me.send_test().await;
    assert_eq!(status, 202, "{body}");
    assert_eq!(
        body["deviceCount"], 5,
        "deviceCount is the number of devices the test goes to, not the number registered: {body}"
    );
    assert_eq!(
        me.ok_diagnostics("").await["devices"]["active"],
        6,
        "the diagnostics keep saying how many devices the member really has"
    );

    // The consumer: the notifier's role, the second drain, a recording relay. Drain until this
    // tenant's row is done (other tests' pending rows share the feed).
    let relay = Arc::new(AcceptingRelay {
        sent: Mutex::new(Vec::new()),
    });
    let drain = PushDrain::new(
        momo_notifier_pool().await,
        PushConfig::for_target(),
        relay.clone(),
    );
    for _ in 0..20 {
        drain
            .drain_system_once(50)
            .await
            .expect("drain the push_system feed");
        let unfinished: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM outbox \
              WHERE workspace_id = $1 AND kind = 'push_system' AND status::text <> 'done'",
        )
        .bind(tenant.workspace)
        .fetch_one(&su)
        .await
        .unwrap();
        if unfinished == 0 {
            break;
        }
    }

    let sent: Vec<PushDispatch> = relay
        .sent
        .lock()
        .unwrap()
        .iter()
        .filter(|dispatch| dispatch.workspace_id == tenant.workspace.to_string())
        .cloned()
        .collect();
    assert_eq!(
        sent.len(),
        5,
        "one POST is five relay calls at most, whatever the member registered"
    );
    let mut reached: Vec<String> = sent
        .iter()
        .map(|dispatch| dispatch.device_id.clone())
        .collect();
    reached.sort();
    let mut freshest: Vec<String> = devices
        .iter()
        .filter(|device| **device != stalest)
        .map(|(_, device)| device.to_string())
        .collect();
    freshest.sort();
    assert_eq!(
        reached, freshest,
        "the five most recently registered devices, not the stalest one"
    );

    let mut logged: Vec<Uuid> = sqlx::query_scalar(
        "SELECT push_token_id FROM push_dispatch_log \
          WHERE workspace_id = $1 AND member_id = $2 ORDER BY push_token_id",
    )
    .bind(tenant.workspace)
    .bind(tenant.me.id)
    .fetch_all(&su)
    .await
    .unwrap();
    logged.sort();
    let mut expected_tokens: Vec<Uuid> = devices
        .iter()
        .filter(|device| **device != stalest)
        .map(|(token, _)| *token)
        .collect();
    expected_tokens.sort();
    assert_eq!(
        logged, expected_tokens,
        "five settled log rows, none for the stalest device"
    );
    assert!(
        !logged.contains(&others_token),
        "nothing for the other member"
    );
    let body = me.ok_diagnostics("").await;
    assert_eq!(body["lastTest"]["status"], "sent", "{body}");
}
