//! `GET|PATCH …/notification-prefs` — ADR-0206 D5·D13, 수용 기준 27·40 and the `kind_off` half of
//! 수용 기준 1 (#4494 N3).
//!
//! The caller's per-kind switches (kind × surface), sound slots, work hours, phone delay and
//! pass-through switches, with the server's own `effective` evaluation. Every test proves one rule
//! with a named assertion that goes red when the rule is reverted (the sabotage that turns it red is
//! in the table below; the handoff lists the measured REDs). All are `#[ignore]`: they need a
//! `pgvector/pgvector:pg18` superuser DB plus the runtime roles.
//!
//! ```text
//! DATABASE_URL=postgres://postgres:postgres@127.0.0.1:26917/s8_4494 \
//!   cargo test -p momo-server --test notification_prefs_conformance_pg -- --ignored --test-threads=1
//! ```
//!
//! Harness contract is `notification_diagnostics_conformance_pg.rs`'s: `DATABASE_URL` is a
//! superuser (migrations + fixtures), the API runs as `momo_app` (NOBYPASSRLS), two tenants are used
//! where isolation matters.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `a_member_with_no_row_reads_the_kind_table_and_a_get_writes_nothing` | change a default (desktop `dm` on, a phone cell off), or let GET materialize the row |
//! | `patch_merges_per_cell_and_per_kind_and_a_null_resets_the_default` | replace the stored `kinds` instead of merging per cell, or store `null` instead of deleting the cell |
//! | `a_refused_patch_is_a_400_and_writes_nothing_not_even_a_row` | materialize the row before the checks, or accept a cell the kind does not have |
//! | `turning_approval_push_off_needs_the_confirm_token_and_leaves_one_audit_row` | drop the confirmation check, audit every approval write, or warn when it was already off |
//! | `work_done_phone_is_the_work_complete_push_switch_in_both_directions` | store `workDone.phone` in `kinds` instead of `work_complete_push` |
//! | `an_agent_bearer_is_refused_and_so_is_a_stranger` | drop `require_human` from a handler **and** list the path for agents |
//! | `two_tenants_never_see_each_others_preferences` | read the row without the tenant (`USING (true)`) |
//! | `kind_off_is_reported_for_a_kind_whose_phone_switch_is_off` | stop passing the kind into the diagnostics, or read the wrong kind's cell |
//! | `the_older_writes_leave_the_new_columns_alone` | make the old rule upsert write the new columns |
//! | `effective_quiet_is_the_servers_own_evaluation` | evaluate the window on UTC instead of the schedule's zone |
//! | `a_schedule_is_replaced_whole_and_null_removes_it` | merge a schedule field by field |

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::{with_tenant_tx, PgPool};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "notification-prefs-conformance-secret";
const TEST_PASSWORD: &str = "notification-prefs-password";

const KINDS: [&str; 10] = [
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
];

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url())
        .await
        .expect("connect as superuser")
}

async fn momo_app_pool() -> PgPool {
    let options: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
    let password = std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".into());
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options.username("momo_app").password(&password))
        .await
        .expect("connect as momo_app (run bootstrap_roles.sql first)")
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
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1", "--no-psqlrc", "--quiet"])
        .arg("--single-transaction")
        .arg("-f")
        .arg(PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../infra/rust/sql/bootstrap_roles.sql"
        )))
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

struct Tenant {
    workspace: Uuid,
    me: Uuid,
    email: String,
    agent: Uuid,
    channel: Uuid,
}

async fn seed_tenant(su: &PgPool) -> Tenant {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("prefs-{workspace}"))
        .execute(su)
        .await
        .expect("seed workspace");
    let me = Uuid::new_v4();
    let handle = format!("h-{}", &me.simple().to_string()[..10]);
    let email = format!("{me}@prefs.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(me)
    .bind(workspace)
    .bind(&handle)
    .execute(su)
    .await
    .expect("seed member");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         VALUES ($1, $2, $3, true, momo_password_hash($4))",
    )
    .bind(me)
    .bind(workspace)
    .bind(&email)
    .bind(TEST_PASSWORD)
    .execute(su)
    .await
    .expect("seed human");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ($1, $2, 'member')",
    )
    .bind(workspace)
    .bind(me)
    .execute(su)
    .await
    .expect("seed workspace membership");

    let agent = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', $3, $3)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(format!("ag-{}", &agent.simple().to_string()[..8]))
    .execute(su)
    .await
    .expect("seed agent member");
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, max_concurrent_runs, \
                            max_run_steps, owner_human_id) \
         VALUES ($1, $2, 'hermes-agent', 'https://gateway.invalid/v1', 2, 50, $3)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(me)
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
    .expect("seed agent workspace membership");

    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, topic, created_by) \
         VALUES ($1, $2, 'public', $3, '', $4)",
    )
    .bind(channel)
    .bind(workspace)
    .bind(format!("ch-{}", &channel.simple().to_string()[..8]))
    .bind(me)
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
        .bind(me)
        .execute(su)
        .await
        .expect("seed channel membership");
    Tenant {
        workspace,
        me,
        email,
        agent,
        channel,
    }
}

async fn agent_bearer(su: &PgPool, tenant: &Tenant) -> String {
    let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token = format!("momo_agent_v1.{}.{secret}", tenant.workspace);
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, \
                            token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), \
                 ARRAY['messages:write']::text[], 'notification-prefs-conformance')",
    )
    .bind(tenant.workspace)
    .bind(tenant.agent)
    .bind(&token)
    .execute(su)
    .await
    .expect("seed agent bearer");
    token
}

/// What the tests call: the server, an HTTP client and the member's bearer.
struct Caller {
    http: reqwest::Client,
    base: String,
    workspace: Uuid,
    token: String,
}

impl Caller {
    async fn of(base: &str, tenant: &Tenant) -> Caller {
        let http = reqwest::Client::new();
        let response = http
            .post(format!("{base}/v1/auth/login"))
            .json(&json!({
                "email": tenant.email,
                "password": TEST_PASSWORD,
                "workspace": tenant.workspace.to_string(),
            }))
            .send()
            .await
            .expect("login");
        assert_eq!(response.status(), 200, "seeded human logs in");
        let body: Value = response.json().await.expect("login body");
        Caller {
            http,
            base: base.to_string(),
            workspace: tenant.workspace,
            token: body["accessToken"].as_str().expect("token").to_string(),
        }
    }

    fn url(&self, tail: &str) -> String {
        format!("{}/v1/workspaces/{}/{tail}", self.base, self.workspace)
    }

    async fn get(&self, tail: &str) -> (u16, Value) {
        let response = self
            .http
            .get(self.url(tail))
            .bearer_auth(&self.token)
            .send()
            .await
            .expect("GET");
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(Value::Null))
    }

    async fn send(&self, method: reqwest::Method, tail: &str, body: &Value) -> (u16, Value) {
        let response = self
            .http
            .request(method, self.url(tail))
            .bearer_auth(&self.token)
            .json(body)
            .send()
            .await
            .expect("request");
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(Value::Null))
    }

    async fn prefs(&self) -> Value {
        let (status, body) = self.get("notification-prefs").await;
        assert_eq!(status, 200, "{body}");
        body
    }

    async fn patch(&self, body: Value) -> (u16, Value) {
        self.send(reqwest::Method::PATCH, "notification-prefs", &body)
            .await
    }

    async fn patch_ok(&self, body: Value) -> Value {
        let (status, response) = self.patch(body.clone()).await;
        assert_eq!(status, 200, "PATCH {body} -> {response}");
        response
    }
}

async fn rule_rows(su: &PgPool, tenant: &Tenant) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM notification_rule WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(tenant.workspace)
    .bind(tenant.me)
    .fetch_one(su)
    .await
    .expect("count rule rows")
}

async fn stored_kinds(su: &PgPool, tenant: &Tenant) -> Option<Value> {
    sqlx::query_scalar(
        "SELECT kinds FROM notification_rule WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(tenant.workspace)
    .bind(tenant.me)
    .fetch_one(su)
    .await
    .expect("read stored kinds")
}

fn error_code(body: &Value) -> &str {
    body["error"]["code"].as_str().unwrap_or("")
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

/// 행 부재 = 오늘: a member with no row reads the kind table's defaults — every phone switch on,
/// desktop on except `dm`, a desktop cell only where the kind has one — and reading writes nothing.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn a_member_with_no_row_reads_the_kind_table_and_a_get_writes_nothing() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let tenant = seed_tenant(&su).await;
    let base = start_server(momo_app_pool().await).await;
    let me = Caller::of(&base, &tenant).await;

    let body = me.prefs().await;
    let kinds = body["kinds"].as_object().expect("kinds object");
    assert_eq!(kinds.len(), 10, "every kind is present: {body}");
    for kind in KINDS {
        assert_eq!(kinds[kind]["phone"], true, "{kind} phone defaults on");
    }
    for (kind, desktop) in [
        ("dm", Some(false)),
        ("mentionHuman", Some(true)),
        ("mentionAgent", Some(true)),
        ("approval", Some(true)),
        ("workDone", Some(true)),
        ("channelAll", Some(true)),
        // No desktop cell: the desktop cannot know these.
        ("agentAnswer", None),
        ("keyword", None),
        ("threadReply", None),
        ("scheduledFailed", None),
    ] {
        match desktop {
            Some(value) => assert_eq!(kinds[kind]["desktop"], value, "{kind} desktop"),
            None => assert!(
                kinds[kind].get("desktop").is_none(),
                "{kind} has no desktop cell: {body}"
            ),
        }
    }
    assert_eq!(body["presentation"], json!({"sounds": {}}));
    assert_eq!(body["schedule"], Value::Null);
    assert_eq!(body["phoneDelaySecs"], 60);
    assert_eq!(body["keywordOverridesMute"], true);
    assert_eq!(body["approvalTimeSensitive"], false);
    assert_eq!(
        body["effective"],
        json!({"paused": false, "pausedUntilMs": null,
               "quiet": {"active": false, "resumesAtMs": null}})
    );
    assert!(
        body.get("warnings").is_none(),
        "warnings is a PATCH-only key"
    );
    assert_eq!(rule_rows(&su, &tenant).await, 0, "a GET writes no row");
}

/// PATCH merges per cell (kind × surface) and per sound kind; `null` resets a cell to its default
/// and an emptied `kinds` leaves no trace; the scalars are independent fields.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn patch_merges_per_cell_and_per_kind_and_a_null_resets_the_default() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let tenant = seed_tenant(&su).await;
    let base = start_server(momo_app_pool().await).await;
    let me = Caller::of(&base, &tenant).await;

    let body = me
        .patch_ok(json!({"kinds": {"dm": {"phone": false}, "mentionHuman": {"desktop": false}}}))
        .await;
    assert_eq!(
        body["kinds"]["dm"],
        json!({"phone": false, "desktop": false})
    );
    assert_eq!(
        body["kinds"]["mentionHuman"],
        json!({"phone": true, "desktop": false})
    );
    assert!(body.get("warnings").is_none());
    assert_eq!(me.prefs().await, body, "GET answers what PATCH answered");

    // A second patch names only the other cell of `dm`: the first is kept.
    let body = me
        .patch_ok(json!({"kinds": {"dm": {"desktop": true}}}))
        .await;
    assert_eq!(
        body["kinds"]["dm"],
        json!({"phone": false, "desktop": true})
    );
    assert_eq!(
        body["kinds"]["mentionHuman"]["desktop"], false,
        "another kind is untouched"
    );

    // `null` resets one cell to its default.
    let body = me.patch_ok(json!({"kinds": {"dm": {"phone": null}}})).await;
    assert_eq!(body["kinds"]["dm"], json!({"phone": true, "desktop": true}));

    // Sounds merge per kind; `null` takes one back to its default.
    me.patch_ok(json!({"presentation": {"sounds": {"dm": "oort.dm", "mentionHuman": "none"}}}))
        .await;
    let body = me
        .patch_ok(json!({"presentation": {"sounds": {"dm": null, "approval": "oort.approval"}}}))
        .await;
    assert_eq!(
        body["presentation"]["sounds"],
        json!({"mentionHuman": "none", "approval": "oort.approval"})
    );

    // The scalars are their own fields: naming one keeps the others.
    let body = me
        .patch_ok(json!({"phoneDelaySecs": 300, "keywordOverridesMute": false,
                         "approvalTimeSensitive": true}))
        .await;
    assert_eq!(
        (
            &body["phoneDelaySecs"],
            &body["keywordOverridesMute"],
            &body["approvalTimeSensitive"]
        ),
        (&json!(300), &json!(false), &json!(true))
    );
    let body = me.patch_ok(json!({"phoneDelaySecs": 0})).await;
    assert_eq!(body["phoneDelaySecs"], 0);
    assert_eq!(body["keywordOverridesMute"], false);
    assert_eq!(
        body["kinds"]["mentionHuman"]["desktop"], false,
        "kinds survive a scalar patch"
    );

    // Reset everything that was ever set: the stored `kinds` is gone (SQL NULL), not an object of
    // empty objects. (`dm.desktop` was set explicitly above: a cell equal to its default is still a
    // stored cell until it is reset.)
    assert_eq!(
        stored_kinds(&su, &tenant).await,
        Some(json!({"dm": {"desktop": true}, "mentionHuman": {"desktop": false}})),
        "only the cells that were set are stored"
    );
    me.patch_ok(json!({"kinds": {"mentionHuman": {"desktop": null}}}))
        .await;
    assert_eq!(
        stored_kinds(&su, &tenant).await,
        Some(json!({"dm": {"desktop": true}})),
        "a kind with no cell left is dropped"
    );
    me.patch_ok(json!({"kinds": {"dm": {"desktop": null}}}))
        .await;
    assert_eq!(
        stored_kinds(&su, &tenant).await,
        None,
        "an emptied kinds leaves no trace"
    );
}

/// Every refusal is a 400 (or the extractor's 422) **before the first write**: a member who only ever
/// sent bad patches has no row at all.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn a_refused_patch_is_a_400_and_writes_nothing_not_even_a_row() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let tenant = seed_tenant(&su).await;
    let base = start_server(momo_app_pool().await).await;
    let me = Caller::of(&base, &tenant).await;

    let schedule = |tz: &str, days: Value, start: &str, end: &str| {
        json!({"schedule": {"enabled": true, "tz": tz, "days": days, "start": start, "end": end,
                            "passThrough": ["approval"]}})
    };
    let refused: Vec<(&str, Value, u16, &str)> = vec![
        ("empty body", json!({}), 400, ""),
        ("empty kinds", json!({"kinds": {}}), 400, ""),
        (
            "keyword has no desktop cell",
            json!({"kinds": {"keyword": {"desktop": true}}}),
            400,
            "surface_not_applicable",
        ),
        (
            "threadReply has no desktop cell (증보 1 F5)",
            json!({"kinds": {"threadReply": {"desktop": true}}}),
            400,
            "surface_not_applicable",
        ),
        (
            "resetting a cell that does not exist",
            json!({"kinds": {"scheduledFailed": {"desktop": null}}}),
            400,
            "surface_not_applicable",
        ),
        (
            "a personal sound file is #4345's",
            json!({"presentation": {"sounds": {"dm": "user:abc"}}}),
            400,
            "unknown_sound",
        ),
        (
            "a sound slot of something that is not a kind",
            json!({"presentation": {"sounds": {"gong": "none"}}}),
            400,
            "unknown_kind",
        ),
        (
            "a delay of 30",
            json!({"phoneDelaySecs": 30}),
            400,
            "invalid_phone_delay",
        ),
        (
            "a time zone abbreviation",
            schedule("PST", json!([1]), "09:00", "18:00"),
            400,
            "invalid_time_zone",
        ),
        (
            "a POSIX time zone (the sign is inverted)",
            schedule("UTC+9", json!([1]), "09:00", "18:00"),
            400,
            "invalid_time_zone",
        ),
        (
            "a zone that does not exist",
            schedule("Mars/Phobos", json!([1]), "09:00", "18:00"),
            400,
            "invalid_time_zone",
        ),
        (
            "start == end",
            schedule("Asia/Seoul", json!([1]), "09:00", "09:00"),
            400,
            "invalid_schedule",
        ),
        (
            "an enabled schedule with no day",
            schedule("Asia/Seoul", json!([]), "09:00", "18:00"),
            400,
            "invalid_schedule",
        ),
        (
            "a clock that is not HH:MM",
            schedule("Asia/Seoul", json!([1]), "9:00", "18:00"),
            400,
            "invalid_schedule",
        ),
        (
            "approval off without the confirmation",
            json!({"kinds": {"approval": {"phone": false}}}),
            400,
            "confirmation_required",
        ),
        (
            "approval off beside valid fields is still refused as a whole",
            json!({"phoneDelaySecs": 300, "kinds": {"approval": {"phone": false}}}),
            400,
            "confirmation_required",
        ),
        // The extractor's 422: unknown fields, kinds, surfaces and tokens.
        ("an unknown field", json!({"nope": 1}), 422, ""),
        (
            "an unknown kind",
            json!({"kinds": {"channel_message": {"phone": false}}}),
            422,
            "",
        ),
        (
            "an unknown surface",
            json!({"kinds": {"dm": {"tablet": false}}}),
            422,
            "",
        ),
        (
            "an unknown token",
            json!({"confirm": ["yes_really"]}),
            422,
            "",
        ),
    ];
    for (label, body, status, code) in refused {
        let (got, response) = me.patch(body.clone()).await;
        assert_eq!(got, status, "{label}: {response}");
        assert_eq!(error_code(&response), code, "{label}: {response}");
    }
    assert_eq!(
        rule_rows(&su, &tenant).await,
        0,
        "every refusal is decided before the first write — no row, not even the default one"
    );

    // And the zone check lets a real, fixed-offset name through (D13: `Etc/GMT+5` is in the table).
    me.patch_ok(schedule("Etc/GMT+5", json!([1]), "09:00", "18:00"))
        .await;
    assert_eq!(rule_rows(&su, &tenant).await, 1);
}

/// D5: turning approval push from on to off needs `confirm: ["approval_push_off"]`; with it the
/// response warns and the write is audited — once. Already off, or back on, or a reset, needs nothing.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn turning_approval_push_off_needs_the_confirm_token_and_leaves_one_audit_row() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let tenant = seed_tenant(&su).await;
    let base = start_server(momo_app_pool().await).await;
    let me = Caller::of(&base, &tenant).await;
    let audits = || async {
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM audit_log \
              WHERE workspace_id = $1 AND action = 'notification_prefs.approval_push_off'",
        )
        .bind(tenant.workspace)
        .fetch_one(&su)
        .await
        .expect("count audit rows")
    };

    // Without the token: 400, nothing changed, nothing audited.
    let (status, body) = me
        .patch(json!({"kinds": {"approval": {"phone": false}}}))
        .await;
    assert_eq!((status, error_code(&body)), (400, "confirmation_required"));
    assert_eq!(me.prefs().await["kinds"]["approval"]["phone"], true);
    assert_eq!(audits().await, 0);

    // The token alone is not a change.
    let (status, _) = me.patch(json!({"confirm": ["approval_push_off"]})).await;
    assert_eq!(status, 400);

    // With the token: 200, the warning, one audit row naming this member.
    let body = me
        .patch_ok(
            json!({"kinds": {"approval": {"phone": false}}, "confirm": ["approval_push_off"]}),
        )
        .await;
    assert_eq!(body["kinds"]["approval"]["phone"], false);
    assert_eq!(body["warnings"], json!(["approval_push_off"]));
    assert_eq!(audits().await, 1);
    let (actor, subject, schema): (Uuid, Uuid, String) = sqlx::query_as(
        "SELECT actor_member_id, subject_member_id, detail->>'schema' FROM audit_log \
          WHERE workspace_id = $1 AND action = 'notification_prefs.approval_push_off'",
    )
    .bind(tenant.workspace)
    .fetch_one(&su)
    .await
    .expect("read the audit row");
    assert_eq!((actor, subject), (tenant.me, tenant.me));
    assert_eq!(schema, "momo.notification_prefs.approval_push_off.v1");
    assert!(
        me.prefs().await.get("warnings").is_none(),
        "the warning is the answer of the write that turned it off, not a standing key"
    );

    // Already off: writing it off again needs no token, warns nothing, audits nothing more.
    let body = me
        .patch_ok(json!({"kinds": {"approval": {"phone": false}}}))
        .await;
    assert!(body.get("warnings").is_none(), "{body}");
    assert_eq!(audits().await, 1);

    // Back on, and a reset, need no token.
    let body = me
        .patch_ok(json!({"kinds": {"approval": {"phone": true}}}))
        .await;
    assert_eq!(body["kinds"]["approval"]["phone"], true);
    me.patch_ok(json!({"kinds": {"approval": {"phone": false}}, "confirm": ["approval_push_off"]}))
        .await;
    assert_eq!(
        audits().await,
        2,
        "a second turn-off is a second audited event"
    );
    let body = me
        .patch_ok(json!({"kinds": {"approval": {"phone": null}}}))
        .await;
    assert_eq!(body["kinds"]["approval"]["phone"], true);
    assert_eq!(audits().await, 2);

    // Turning the *desktop* approval switch off is not the dangerous one: no token.
    let body = me
        .patch_ok(json!({"kinds": {"approval": {"desktop": false}}}))
        .await;
    assert_eq!(body["kinds"]["approval"]["desktop"], false);
    assert!(body.get("warnings").is_none());
    assert_eq!(audits().await, 2);
}

/// D5 별칭: `workDone.phone` and `work_complete_push` (read and written by
/// `…/notification-rules/push-kinds`) are one stored value; the `kinds` document never keeps a second.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn work_done_phone_is_the_work_complete_push_switch_in_both_directions() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let tenant = seed_tenant(&su).await;
    let base = start_server(momo_app_pool().await).await;
    let me = Caller::of(&base, &tenant).await;
    let column = || async {
        sqlx::query_scalar::<_, bool>(
            "SELECT work_complete_push FROM notification_rule \
              WHERE workspace_id = $1 AND member_id = $2",
        )
        .bind(tenant.workspace)
        .bind(tenant.me)
        .fetch_one(&su)
        .await
        .expect("read work_complete_push")
    };

    // Prefs → the column → the old surface.
    let body = me
        .patch_ok(json!({"kinds": {"workDone": {"phone": false, "desktop": false}}}))
        .await;
    assert_eq!(
        body["kinds"]["workDone"],
        json!({"phone": false, "desktop": false})
    );
    assert!(!column().await);
    let (status, old) = me.get("notification-rules/push-kinds").await;
    assert_eq!((status, &old["workComplete"]), (200, &json!(false)));
    assert_eq!(
        stored_kinds(&su, &tenant).await,
        Some(json!({"workDone": {"desktop": false}})),
        "only the desktop cell is in kinds; the phone switch is the column"
    );

    // The old surface → the column → prefs.
    let (status, _) = me
        .send(
            reqwest::Method::PATCH,
            "notification-rules/push-kinds",
            &json!({"workComplete": true}),
        )
        .await;
    assert_eq!(status, 200);
    assert!(column().await);
    assert_eq!(me.prefs().await["kinds"]["workDone"]["phone"], true);

    // `null` is the default (on).
    me.patch_ok(json!({"kinds": {"workDone": {"phone": false}}}))
        .await;
    assert!(!column().await);
    me.patch_ok(json!({"kinds": {"workDone": {"phone": null}}}))
        .await;
    assert!(column().await, "a reset is the default, on");
}

/// AC 40: an agent bearer is 403 on both methods (and nothing is written); no credential is 401; a
/// person of another tenant addressing this path is refused.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn an_agent_bearer_is_refused_and_so_is_a_stranger() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let tenant = seed_tenant(&su).await;
    let elsewhere = seed_tenant(&su).await;
    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();
    let url = format!(
        "{base}/v1/workspaces/{}/notification-prefs",
        tenant.workspace
    );
    let agent = agent_bearer(&su, &tenant).await;
    let body = json!({"phoneDelaySecs": 300});

    assert_eq!(
        http.get(&url)
            .bearer_auth(&agent)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        http.patch(&url)
            .bearer_auth(&agent)
            .json(&body)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(http.get(&url).send().await.unwrap().status(), 401);
    assert_eq!(
        http.patch(&url).json(&body).send().await.unwrap().status(),
        401
    );

    let stranger = Caller::of(&base, &elsewhere).await;
    assert_eq!(
        http.get(&url)
            .bearer_auth(&stranger.token)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        http.patch(&url)
            .bearer_auth(&stranger.token)
            .json(&body)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        rule_rows(&su, &tenant).await,
        0,
        "nothing was written for the refused"
    );
    assert_eq!(rule_rows(&su, &elsewhere).await, 0);
}

/// Two tenants: one member's switches are invisible to the other, a write never crosses, and the
/// table itself is RLS-bound (a `momo_app` transaction of the other tenant sees no row of this one).
#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn two_tenants_never_see_each_others_preferences() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let (a, b) = (seed_tenant(&su).await, seed_tenant(&su).await);
    let app = momo_app_pool().await;
    let base = start_server(app.clone()).await;
    let (alice, bob) = (Caller::of(&base, &a).await, Caller::of(&base, &b).await);

    alice
        .patch_ok(json!({"kinds": {"dm": {"phone": false}}, "phoneDelaySecs": 300}))
        .await;
    let seen_by_bob = bob.prefs().await;
    assert_eq!(seen_by_bob["kinds"]["dm"]["phone"], true);
    assert_eq!(seen_by_bob["phoneDelaySecs"], 60);

    bob.patch_ok(json!({"kinds": {"mentionHuman": {"phone": false}}}))
        .await;
    let seen_by_alice = alice.prefs().await;
    assert_eq!(seen_by_alice["kinds"]["mentionHuman"]["phone"], true);
    assert_eq!(seen_by_alice["kinds"]["dm"]["phone"], false);

    // The row of A is not visible from B's tenant context, whatever the query says.
    let b_workspace = b.workspace;
    let visible: i64 = with_tenant_tx(&app, b_workspace, move |conn| {
        Box::pin(async move {
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM notification_rule")
                .fetch_one(&mut *conn)
                .await?;
            Ok::<_, momo_db::DbError>(count)
        })
    })
    .await
    .expect("count rows from B's context");
    assert_eq!(visible, 1, "B's context sees B's own row and nothing of A");
}

/// 수용 기준 1 / 27: the diagnostics' `kind_off` — the request names a kind and the member's **phone**
/// switch for it is off. It sits after `channel_muted` in the fixed order, carries the kind, and is
/// absent for another kind, for no kind, and when only the desktop cell is off.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn kind_off_is_reported_for_a_kind_whose_phone_switch_is_off() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let tenant = seed_tenant(&su).await;
    let base = start_server(momo_app_pool().await).await;
    let me = Caller::of(&base, &tenant).await;
    let codes = |body: &Value| -> Vec<String> {
        body["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|blocker| blocker["code"].as_str().unwrap().to_string())
            .collect()
    };
    let diagnostics = |query: String| {
        let me = &me;
        async move {
            let (status, body) = me.get(&format!("notification-diagnostics{query}")).await;
            assert_eq!(status, 200, "{body}");
            body
        }
    };

    // Nothing switched off: no `kind_off`, for any kind.
    for kind in KINDS {
        let body = diagnostics(format!("?kind={kind}")).await;
        assert!(
            !codes(&body).contains(&"kind_off".to_string()),
            "{kind}: {body}"
        );
    }

    me.patch_ok(json!({"kinds": {"dm": {"phone": false}, "mentionHuman": {"desktop": false}}}))
        .await;
    // A pause and a mute beside it: `kind_off` takes its place after `channel_muted`.
    sqlx::query(
        "INSERT INTO notification_rule (workspace_id, member_id, dnd) VALUES ($1, $2, true) \
         ON CONFLICT (workspace_id, member_id) DO UPDATE SET dnd = true, dnd_until = NULL",
    )
    .bind(tenant.workspace)
    .bind(tenant.me)
    .execute(&su)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO notification_pref (workspace_id, member_id, channel_id, muted_until) \
         VALUES ($1, $2, $3, NULL)",
    )
    .bind(tenant.workspace)
    .bind(tenant.me)
    .bind(tenant.channel)
    .execute(&su)
    .await
    .unwrap();

    let body = diagnostics(format!("?channelId={}&kind=dm", tenant.channel)).await;
    assert_eq!(
        codes(&body),
        ["paused", "channel_muted", "kind_off", "no_device"],
        "{body}"
    );
    let blocker = body["blockers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|blocker| blocker["code"] == "kind_off")
        .unwrap();
    assert_eq!(blocker, &json!({"code": "kind_off", "kind": "dm"}));
    assert_eq!(body["ok"], false);

    // Another kind, no kind, and a kind whose only *desktop* cell is off: not blocked.
    for query in ["?kind=mentionAgent", "?kind=mentionHuman", ""] {
        let body = diagnostics(query.to_string()).await;
        assert!(
            !codes(&body).contains(&"kind_off".to_string()),
            "{query}: {body}"
        );
    }

    // `workDone` is read from `work_complete_push`, the same value the old surface writes.
    me.patch_ok(json!({"kinds": {"workDone": {"phone": false}}}))
        .await;
    let body = diagnostics("?kind=workDone".to_string()).await;
    let blocker = body["blockers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|blocker| blocker["code"] == "kind_off")
        .expect("workDone is off");
    assert_eq!(blocker["kind"], "workDone");
}

/// The older writes name their own columns: a `PUT …/notification-rules` and a pause written after the
/// new preferences leave every new column as it was (and the pause reads through `effective`).
#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn the_older_writes_leave_the_new_columns_alone() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let tenant = seed_tenant(&su).await;
    let base = start_server(momo_app_pool().await).await;
    let me = Caller::of(&base, &tenant).await;

    me.patch_ok(json!({
        "kinds": {"dm": {"phone": false}}, "phoneDelaySecs": 300, "approvalTimeSensitive": true,
        "presentation": {"sounds": {"dm": "oort.dm"}},
        "schedule": {"enabled": false, "tz": "Asia/Seoul", "days": [1, 2], "start": "09:00",
                     "end": "18:00", "passThrough": ["approval"]},
    }))
    .await;

    let until = chrono::Utc::now().timestamp_millis() + 3_600_000;
    for (method, tail, body) in [
        (
            reqwest::Method::PUT,
            "notification-rules",
            json!({"dnd": true, "mentionOverridesMute": true, "dndUntilMs": until}),
        ),
        (
            reqwest::Method::PATCH,
            "notification-rules",
            json!({"mentionOverridesMute": false}),
        ),
    ] {
        let (status, response) = me.send(method, tail, &body).await;
        assert_eq!(status, 200, "{response}");
    }

    let body = me.prefs().await;
    assert_eq!(body["kinds"]["dm"]["phone"], false);
    assert_eq!(body["phoneDelaySecs"], 300);
    assert_eq!(body["approvalTimeSensitive"], true);
    assert_eq!(body["presentation"]["sounds"]["dm"], "oort.dm");
    assert_eq!(body["schedule"]["tz"], "Asia/Seoul");
    assert_eq!(body["effective"]["paused"], true);
    assert_eq!(body["effective"]["pausedUntilMs"], until);
}

/// `effective.quiet` is the server's own evaluation, in the schedule's zone: inside the window it is
/// inactive; outside it is active and says when the window next opens; a schedule that is off — or
/// names a zone the database no longer knows — is "no schedule", never an error.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn effective_quiet_is_the_servers_own_evaluation() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let tenant = seed_tenant(&su).await;
    let base = start_server(momo_app_pool().await).await;
    let me = Caller::of(&base, &tenant).await;

    // Seoul has no DST: its wall clock is UTC+9 all year, so the expectation is plain arithmetic on
    // `now()`. Taken in one statement so the strings and the instant agree.
    let (inside_start, inside_end, ahead_start, ahead_end, ahead_instant_ms): (
        String,
        String,
        String,
        String,
        i64,
    ) = sqlx::query_as(
        "SELECT to_char(now() AT TIME ZONE 'Asia/Seoul' - interval '1 hour', 'HH24:MI'), \
                to_char(now() AT TIME ZONE 'Asia/Seoul' + interval '1 hour', 'HH24:MI'), \
                to_char(now() AT TIME ZONE 'Asia/Seoul' + interval '1 hour', 'HH24:MI'), \
                to_char(now() AT TIME ZONE 'Asia/Seoul' + interval '2 hours', 'HH24:MI'), \
                (extract(epoch FROM date_trunc('minute', now() + interval '1 hour')) * 1000)::bigint",
    )
    .fetch_one(&su)
    .await
    .unwrap();
    let every_day = json!([0, 1, 2, 3, 4, 5, 6]);
    let schedule = |enabled: bool, start: &str, end: &str| {
        json!({"schedule": {"enabled": enabled, "tz": "Asia/Seoul", "days": every_day,
                            "start": start, "end": end, "passThrough": ["approval"]}})
    };

    // Inside the window (an hour either side of now, every day): flowing.
    let body = me
        .patch_ok(schedule(true, &inside_start, &inside_end))
        .await;
    assert_eq!(
        body["effective"]["quiet"],
        json!({"active": false, "resumesAtMs": null}),
        "{body}"
    );

    // The window opens an hour from now: quiet, and it says exactly when.
    let body = me.patch_ok(schedule(true, &ahead_start, &ahead_end)).await;
    assert_eq!(body["effective"]["quiet"]["active"], true, "{body}");
    assert_eq!(
        body["effective"]["quiet"]["resumesAtMs"], ahead_instant_ms,
        "{body}"
    );
    assert_eq!(
        me.prefs().await["effective"]["quiet"],
        body["effective"]["quiet"]
    );

    // The same window switched off is no schedule.
    let body = me.patch_ok(schedule(false, &ahead_start, &ahead_end)).await;
    assert_eq!(
        body["effective"]["quiet"],
        json!({"active": false, "resumesAtMs": null})
    );

    // A stored zone the database does not know (a tzdata change, a hand edit): the read still
    // answers, and it reads as no schedule.
    me.patch_ok(schedule(true, &ahead_start, &ahead_end)).await;
    sqlx::query(
        "UPDATE notification_rule SET schedule = jsonb_set(schedule, '{tz}', '\"Mars/Phobos\"') \
          WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(tenant.workspace)
    .bind(tenant.me)
    .execute(&su)
    .await
    .unwrap();
    let body = me.prefs().await;
    assert_eq!(
        body["effective"]["quiet"],
        json!({"active": false, "resumesAtMs": null}),
        "{body}"
    );
}

/// A schedule is replaced whole (D13: no partial merge) and `null` removes it.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn a_schedule_is_replaced_whole_and_null_removes_it() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let tenant = seed_tenant(&su).await;
    let base = start_server(momo_app_pool().await).await;
    let me = Caller::of(&base, &tenant).await;

    let first = json!({"enabled": true, "tz": "Asia/Seoul", "days": [1, 2, 3], "start": "09:00",
                       "end": "18:00", "passThrough": ["approval", "dm"]});
    let body = me.patch_ok(json!({"schedule": first})).await;
    assert_eq!(body["schedule"], first);

    // A different schedule replaces every field — including the pass-through list.
    let second = json!({"enabled": false, "tz": "America/Los_Angeles", "days": [5],
                        "start": "22:00", "end": "06:00", "passThrough": []});
    let body = me.patch_ok(json!({"schedule": second})).await;
    assert_eq!(body["schedule"], second);
    assert_eq!(me.prefs().await["schedule"], second);

    // A duplicate in the pass-through list is folded; the day list is stored as sent.
    let body = me
        .patch_ok(
            json!({"schedule": {"enabled": true, "tz": "UTC", "days": [0], "start": "01:00",
                                      "end": "02:00", "passThrough": ["dm", "dm", "approval"]}}),
        )
        .await;
    assert_eq!(body["schedule"]["passThrough"], json!(["dm", "approval"]));

    // `null` removes it.
    let body = me.patch_ok(json!({"schedule": null})).await;
    assert_eq!(body["schedule"], Value::Null);
    assert_eq!(body["effective"]["quiet"]["active"], false);
}
