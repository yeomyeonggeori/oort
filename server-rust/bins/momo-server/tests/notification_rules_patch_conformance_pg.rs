//! #3012 — `PATCH …/notification-rules`: two clients each change their own
//! switch and neither erases the other's.
//!
//! The race the issue names: the web settings panel holds the whole rule and
//! PUTs it back; the phone turns the pause on in between. The web PUT carries
//! the pause it last saw (off), so the phone's pause is gone.
//!
//! | test | what it shows | sabotage that makes it red |
//! |---|---|---|
//! | `a_put_from_a_stale_snapshot_erases_the_other_clients_pause` | the bug, pinned as PUT's documented behaviour (a snapshot write) | — (this is the RED the PATCH exists for) |
//! | `two_concurrent_patches_keep_both_fields` | web patches the mention exception while the phone's pause patch is open; both survive | read the merge base without the row lock (`Load::Read`) in `patch_notification_rule_in_tx`, or merge onto `NotificationRule::default()` |
//! | `a_patch_that_leaves_the_pause_alone_keeps_a_dnd_bundle` | the PUT's bundle rule holds for PATCH | build the update with `dnd_until: Set(None)` |
//! | `the_patch_route_changes_only_named_fields_and_put_still_works` | the HTTP surface, 400 on an empty body, PUT compatibility | route `patch` to a full replace |
//!
//! `#[ignore]` because it needs a real Postgres:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:<port>/momo \
//!   cargo test -p momo-server --test notification_rules_patch_conformance_pg \
//!     -- --ignored --test-threads=1
//! ```
//!
//! Harness contract is `http_smoke_pg.rs`'s: `DATABASE_URL` is a superuser
//! (migrations + fixtures), the domain runs as `momo_app` (NOBYPASSRLS).

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use chrono::{Duration, Utc};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::{with_tenant_tx, PgPool};
use momo_messaging::{
    get_notification_rule_in_tx, patch_notification_rule_in_tx, set_declared_presence_in_tx,
    set_notification_rule_in_tx, CustomStatusPatch, NotificationRule, NotificationRulePatch,
    PresenceStatus, StatusPatch,
};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "notification-rules-patch-conformance-secret";
const TEST_PASSWORD: &str = "notification-rules-patch-password";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn momo_app_password() -> String {
    std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string())
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
    let options = options.username("momo_app").password(&momo_app_password());
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options)
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

struct Fixture {
    workspace: Uuid,
    member: Uuid,
    email: String,
}

/// One workspace, one verified human member with a password.
async fn seed(su: &PgPool) -> Fixture {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("rules-{workspace}"))
        .execute(su)
        .await
        .expect("seed workspace");
    let member = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(member)
    .bind(workspace)
    .bind(member.to_string())
    .execute(su)
    .await
    .expect("seed member");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'member')",
    )
    .bind(workspace)
    .bind(member)
    .execute(su)
    .await
    .expect("seed membership");
    let email = format!("{member}@rules.test");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         VALUES ($1, $2, $3, true, momo_password_hash($4))",
    )
    .bind(member)
    .bind(workspace)
    .bind(&email)
    .bind(TEST_PASSWORD)
    .execute(su)
    .await
    .expect("seed human");
    Fixture {
        workspace,
        member,
        email,
    }
}

/// An existing, committed rule row with both switches off — so the only thing
/// that can serialize two writers below is the row lock, not the first-insert.
async fn materialize_off(app: &PgPool, fixture: &Fixture) {
    let (workspace, member) = (fixture.workspace, fixture.member);
    with_tenant_tx(app, workspace, move |conn| {
        Box::pin(async move {
            set_notification_rule_in_tx(conn, workspace, member, NotificationRule::default()).await
        })
    })
    .await
    .expect("materialize the row");
}

async fn rule(app: &PgPool, fixture: &Fixture) -> NotificationRule {
    let (workspace, member) = (fixture.workspace, fixture.member);
    with_tenant_tx(app, workspace, move |conn| {
        Box::pin(async move { get_notification_rule_in_tx(conn, workspace, member).await })
    })
    .await
    .expect("read rule")
}

async fn patch(app: &PgPool, fixture: &Fixture, patch: NotificationRulePatch) {
    let (workspace, member) = (fixture.workspace, fixture.member);
    with_tenant_tx(app, workspace, move |conn| {
        Box::pin(async move { patch_notification_rule_in_tx(conn, workspace, member, patch).await })
    })
    .await
    .expect("patch rule");
}

const PAUSE_ON: NotificationRulePatch = NotificationRulePatch {
    dnd: Some(true),
    dnd_until: StatusPatch::Absent,
    mention_overrides_mute: None,
};

const MENTION_ON: NotificationRulePatch = NotificationRulePatch {
    dnd: None,
    dnd_until: StatusPatch::Absent,
    mention_overrides_mute: Some(true),
};

#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn a_put_from_a_stale_snapshot_erases_the_other_clients_pause() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    materialize_off(&app, &fixture).await;

    // The web panel reads the rule…
    let web_snapshot = rule(&app, &fixture).await;
    // …the phone turns the pause on…
    let (workspace, member) = (fixture.workspace, fixture.member);
    with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            set_notification_rule_in_tx(
                conn,
                workspace,
                member,
                NotificationRule {
                    dnd: true,
                    ..NotificationRule::default()
                },
            )
            .await
        })
    })
    .await
    .unwrap();
    // …and the web PUTs its snapshot with the mention exception flipped.
    with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            set_notification_rule_in_tx(
                conn,
                workspace,
                member,
                NotificationRule {
                    mention_overrides_mute: true,
                    ..web_snapshot
                },
            )
            .await
        })
    })
    .await
    .unwrap();

    let after = rule(&app, &fixture).await;
    assert!(after.mention_overrides_mute);
    assert!(
        !after.dnd,
        "PUT is a whole-snapshot write: the phone's pause is gone. This is the \
         race #3012 removes by moving clients to PATCH"
    );
}

#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn two_concurrent_patches_keep_both_fields() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    materialize_off(&app, &fixture).await;

    // The phone's pause patch is open (uncommitted, row locked).
    let mut phone = app.begin().await.expect("begin phone");
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(fixture.workspace.to_string())
        .execute(&mut *phone)
        .await
        .unwrap();
    patch_notification_rule_in_tx(&mut phone, fixture.workspace, fixture.member, PAUSE_ON)
        .await
        .expect("phone patches, uncommitted");

    // The web patches the mention exception at the same moment.
    let (app_web, workspace, member) = (app.clone(), fixture.workspace, fixture.member);
    let web = tokio::spawn(async move {
        with_tenant_tx(&app_web, workspace, move |conn| {
            Box::pin(async move {
                patch_notification_rule_in_tx(conn, workspace, member, MENTION_ON).await
            })
        })
        .await
        .expect("web patch")
    });
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    assert!(
        !web.is_finished(),
        "the web patch must wait for the row lock"
    );
    phone.commit().await.expect("commit phone");
    web.await.expect("web joins");

    assert_eq!(
        rule(&app, &fixture).await,
        NotificationRule {
            dnd: true,
            dnd_until: None,
            mention_overrides_mute: true,
        },
        "each client changed its own switch; neither may erase the other's"
    );

    // And the other order, with a timed pause.
    let until = Utc::now() + Duration::hours(2);
    let mut web_tx = app.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.workspace_id', $1, true)")
        .bind(fixture.workspace.to_string())
        .execute(&mut *web_tx)
        .await
        .unwrap();
    patch_notification_rule_in_tx(
        &mut web_tx,
        fixture.workspace,
        fixture.member,
        NotificationRulePatch {
            mention_overrides_mute: Some(false),
            ..NotificationRulePatch::default()
        },
    )
    .await
    .unwrap();
    let app_phone = app.clone();
    let phone = tokio::spawn(async move {
        with_tenant_tx(&app_phone, workspace, move |conn| {
            Box::pin(async move {
                patch_notification_rule_in_tx(
                    conn,
                    workspace,
                    member,
                    NotificationRulePatch {
                        dnd: Some(true),
                        dnd_until: StatusPatch::Set(Some(until)),
                        mention_overrides_mute: None,
                    },
                )
                .await
            })
        })
        .await
        .unwrap()
    });
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    web_tx.commit().await.unwrap();
    phone.await.unwrap();
    let after = rule(&app, &fixture).await;
    assert!(after.dnd && !after.mention_overrides_mute, "{after:?}");
    assert_eq!(
        after.dnd_until.map(|at| at.timestamp_micros()),
        Some(until.timestamp_micros())
    );
}

#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn a_patch_that_leaves_the_pause_alone_keeps_a_dnd_bundle() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let fixture = seed(&su).await;
    let (workspace, member) = (fixture.workspace, fixture.member);

    // Declared DND engages the bundle (pause on, pre-bundle `false` remembered).
    with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            set_declared_presence_in_tx(
                conn,
                workspace,
                member,
                PresenceStatus::Dnd,
                StatusPatch::Absent,
                CustomStatusPatch::default(),
            )
            .await
        })
    })
    .await
    .expect("declare dnd");

    patch(&app, &fixture, MENTION_ON).await;
    let memory: Option<bool> =
        sqlx::query_scalar("SELECT presence_prev_dnd FROM notification_rule WHERE member_id = $1")
            .bind(member)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(memory, Some(false), "a mention-only patch keeps the bundle");
    let after = rule(&app, &fixture).await;
    assert!(after.dnd && after.mention_overrides_mute, "{after:?}");

    // A patch that changes the pause breaks it, as a PUT does.
    patch(
        &app,
        &fixture,
        NotificationRulePatch {
            dnd: Some(false),
            ..NotificationRulePatch::default()
        },
    )
    .await;
    let memory: Option<bool> =
        sqlx::query_scalar("SELECT presence_prev_dnd FROM notification_rule WHERE member_id = $1")
            .bind(member)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(memory, None);
}

async fn start_server(pool: PgPool) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    );
    let app = build_app(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address: SocketAddr = listener.local_addr().expect("address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{address}")
}

#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn the_patch_route_changes_only_named_fields_and_put_still_works() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let fixture = seed(&su).await;
    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();
    let login: Value = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": fixture.email,
            "password": TEST_PASSWORD,
            "workspace": fixture.workspace.to_string(),
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let token = login["accessToken"].as_str().expect("token").to_string();
    let url = format!(
        "{base}/v1/workspaces/{}/notification-rules",
        fixture.workspace
    );
    let send = |request: reqwest::RequestBuilder| {
        let request = request.bearer_auth(&token);
        async move {
            let response = request.send().await.unwrap();
            let status = response.status().as_u16();
            (
                status,
                response.json::<Value>().await.unwrap_or(Value::Null),
            )
        }
    };

    // The phone pauses (PATCH), the web flips the mention exception (PATCH).
    let (status, phone) = send(http.patch(&url).json(&json!({"dnd": true}))).await;
    assert_eq!(status, 200, "{phone}");
    let (_, web) = send(
        http.patch(&url)
            .json(&json!({"mentionOverridesMute": true})),
    )
    .await;
    assert_eq!(
        web,
        json!({"dnd": true, "dndUntilMs": null, "mentionOverridesMute": true}),
        "the web patch kept the phone's pause"
    );

    // A timed pause through PATCH leaves the mention exception alone.
    let until = (Utc::now() + Duration::hours(1)).timestamp_millis();
    let (_, timed) = send(
        http.patch(&url)
            .json(&json!({"dnd": true, "dndUntilMs": until})),
    )
    .await;
    assert_eq!(timed["dndUntilMs"], json!(until));
    assert_eq!(timed["mentionOverridesMute"], json!(true));

    // Refusals: empty body, unknown field, past expiry.
    for body in [
        json!({}),
        json!({"dnd": true, "keyword": "x"}),
        json!({"dndUntilMs": 5}),
    ] {
        let (status, _) = send(http.patch(&url).json(&body)).await;
        assert!((400..500).contains(&status), "{body}: {status}");
    }

    // PUT is unchanged: a full replace.
    let (status, put) = send(
        http.put(&url)
            .json(&json!({"dnd": false, "mentionOverridesMute": false})),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        put,
        json!({"dnd": false, "dndUntilMs": null, "mentionOverridesMute": false})
    );
    let (_, read) = send(http.get(&url)).await;
    assert_eq!(read, put);

    // The audit row names the patched fields.
    let patched: Vec<Value> = sqlx::query_scalar(
        "SELECT detail->'patched' FROM audit_log \
          WHERE workspace_id = $1 AND action = 'notification_rule.updated' \
            AND detail ? 'patched' ORDER BY created_at",
    )
    .bind(fixture.workspace)
    .fetch_all(&su)
    .await
    .unwrap();
    assert_eq!(
        patched,
        vec![
            json!(["dnd"]),
            json!(["mentionOverridesMute"]),
            json!(["dnd", "dndUntilMs"]),
        ]
    );
}
