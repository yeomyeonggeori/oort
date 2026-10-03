//! DB-backed conformance for the shared-session payload retention sweep
//! (#2862 — ADR-0190 증보 D4-b: 「세션이 끝나고 30일이 지나면 S1 확장 필드를 지운다」).
//!
//! The candidate read runs as `momo_notifier` (BYPASSRLS, the sweep's existing
//! exception) and every delete as a per-tenant transaction under the tenant GUC on
//! the RLS-bound `momo_app` pool (#3377). This suite uses the development role
//! file, so it proves behaviour, not grants: `prod_role_conformance_pg` is the
//! one that provisions roles the production way.
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-notifier --test share_retention_conformance_pg -- --ignored --nocapture
//! ```
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `a_payload_is_deleted_thirty_days_after_the_end_and_not_before` | change `SHARE_RETENTION_DAYS` / drop the `ended_at <` predicate |
//! | `the_sweep_announces_the_deletion_through_the_outbox_without_names` | drop the `emit_outbox` in `sweep_workspace_in_tx` |

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::{with_tenant_tx, PgPool};
use momo_messaging::{send_message_in_tx, MessageType, NewMessage};
use momo_notifier::share_retention_sweep::sweep_expired_shares;
use momo_t3::{create_local_pty_work_session_with_id_in_tx, NewWorkSession};
use serde_json::Value;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

async fn role_pool(role: &str, password: &str) -> PgPool {
    let options: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
    PgPoolOptions::new()
        .max_connections(4)
        .connect_with(options.username(role).password(password))
        .await
        .unwrap_or_else(|error| panic!("connect as {role}: {error}"))
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url())
        .await
        .expect("connect as superuser")
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
    PathBuf::from("/opt/homebrew/opt/libpq/bin/psql")
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
        ])
        .arg("-f")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../infra/rust/sql/bootstrap_roles.sql"
        ))
        .status()
        .expect("spawn psql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
    *ready = true;
}

/// The sweep reads every tenant's rows; serialize the tests in this binary.
async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

struct Seeded {
    workspace: Uuid,
    channel: Uuid,
}

async fn seed_workspace(su: &PgPool, app: &PgPool) -> (Seeded, Uuid) {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(workspace.to_string())
        .execute(su)
        .await
        .expect("workspace");
    let member = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', '성재', $3)",
    )
    .bind(member)
    .bind(workspace)
    .bind(member.to_string())
    .execute(su)
    .await
    .expect("member");
    let channel = momo_messaging::create_channel(
        app,
        workspace,
        momo_messaging::NewChannel {
            kind: momo_messaging::ChannelKind::Public,
            name: format!("c-{}", &Uuid::new_v4().simple().to_string()[..8]),
            topic: None,
            created_by: member,
        },
    )
    .await
    .expect("channel")
    .id;
    (Seeded { workspace, channel }, member)
}

/// A shared local session with an S1 payload; `ended_days_ago = None` keeps it running.
async fn seed_shared(
    su: &PgPool,
    app: &PgPool,
    seeded: &Seeded,
    member: Uuid,
    ended_days_ago: Option<i32>,
) -> Uuid {
    let session = Uuid::new_v4();
    let host = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO work_host (id, workspace_id, scope, owner_member_id, type, display_name, \
                                public_key, capabilities, last_seen_at) \
         VALUES ($1, $2, 'member', $3, 'app', 'mac', $4, '{}'::jsonb, clock_timestamp())",
    )
    .bind(host)
    .bind(seeded.workspace)
    .bind(member)
    .bind("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
    .execute(su)
    .await
    .expect("host");
    let workspace = seeded.workspace;
    let channel = seeded.channel;
    with_tenant_tx(app, workspace, move |conn| {
        Box::pin(async move {
            let card = send_message_in_tx(
                conn,
                workspace,
                NewMessage {
                    channel_id: channel,
                    author_member_id: member,
                    message_type: MessageType::System,
                    body: None,
                    props: serde_json::json!({"kind": "work.session"}),
                    root_id: None,
                    reply_to_id: None,
                    client_msg_id: Some(session),
                    run_id: None,
                    hlc_ts: None,
                    hlc_count: None,
                },
            )
            .await
            .map_err(|e| momo_db::DbError::from(sqlx::Error::Protocol(e.to_string())))?;
            create_local_pty_work_session_with_id_in_tx(
                conn,
                workspace,
                session,
                NewWorkSession {
                    channel_id: channel,
                    member_id: member,
                    host_id: host,
                    root_message_id: card.message.id,
                    tool: "shell".into(),
                    label: "dev server".into(),
                },
                Some("momo"),
            )
            .await
            .map_err(|e| momo_db::DbError::from(sqlx::Error::Protocol(e.to_string())))?;
            Ok::<_, momo_db::DbError>(())
        })
    })
    .await
    .expect("seed session");
    sqlx::query(
        "INSERT INTO work_session_share (workspace_id, session_id, repo_label, branch, harness, derived_state) \
         VALUES ($1, $2, 'secret-repo-name', 'feat/secret-branch', 'claude', 'done')",
    )
    .bind(workspace)
    .bind(session)
    .execute(su)
    .await
    .expect("share row");
    if let Some(days) = ended_days_ago {
        sqlx::query(
            "UPDATE work_session SET status = 'ended', \
                    started_at = now() - make_interval(days => $2 + 5), \
                    ended_at = now() - make_interval(days => $2) \
              WHERE id = $1",
        )
        .bind(session)
        .bind(days)
        .execute(su)
        .await
        .expect("end session");
    }
    session
}

async fn share_exists(su: &PgPool, session: Uuid) -> bool {
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM work_session_share WHERE session_id = $1")
        .bind(session)
        .fetch_one(su)
        .await
        .expect("count")
        > 0
}

async fn session_exists(su: &PgPool, session: Uuid) -> bool {
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM work_session WHERE id = $1")
        .bind(session)
        .fetch_one(su)
        .await
        .expect("count")
        > 0
}

#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL)"]
async fn a_payload_is_deleted_thirty_days_after_the_end_and_not_before() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = role_pool("momo_app", "momo_app_dev_pw").await;
    let notifier = role_pool("momo_notifier", "momo_notifier_dev_pw").await;
    let (a, member_a) = seed_workspace(&su, &app).await;
    let (b, member_b) = seed_workspace(&su, &app).await;

    let old_a = seed_shared(&su, &app, &a, member_a, Some(31)).await;
    let young_a = seed_shared(&su, &app, &a, member_a, Some(29)).await;
    let running_a = seed_shared(&su, &app, &a, member_a, None).await;
    let old_b = seed_shared(&su, &app, &b, member_b, Some(45)).await;

    let stats = sweep_expired_shares(&notifier, &app, 100)
        .await
        .expect("sweep");
    // `>=`: a crashed earlier run may have left expired rows for the sweep to take too.
    assert!(
        stats.deleted >= 2,
        "the two payloads past retention, across tenants"
    );
    assert!(
        !share_exists(&su, old_a).await,
        "31 days after the end: deleted"
    );
    assert!(
        !share_exists(&su, old_b).await,
        "another tenant's expired payload: deleted"
    );
    assert!(
        share_exists(&su, young_a).await,
        "29 days after the end: kept"
    );
    assert!(
        share_exists(&su, running_a).await,
        "a running session is never swept"
    );
    // The ledger rows follow their own rules and stay.
    assert!(session_exists(&su, old_a).await && session_exists(&su, old_b).await);

    // A second tick has nothing to do.
    let again = sweep_expired_shares(&notifier, &app, 100)
        .await
        .expect("sweep");
    assert_eq!(again.deleted, 0);
}

#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL)"]
async fn the_sweep_announces_the_deletion_through_the_outbox_without_names() {
    let _guard = test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = role_pool("momo_app", "momo_app_dev_pw").await;
    let notifier = role_pool("momo_notifier", "momo_notifier_dev_pw").await;
    let (a, member) = seed_workspace(&su, &app).await;
    let session = seed_shared(&su, &app, &a, member, Some(40)).await;

    sweep_expired_shares(&notifier, &app, 100)
        .await
        .expect("sweep");
    let events: Vec<Value> = sqlx::query_scalar(
        "SELECT payload FROM outbox WHERE workspace_id = $1 \
           AND payload->'data'->>'type' = 'work.session.share_changed'",
    )
    .bind(a.workspace)
    .fetch_all(&su)
    .await
    .expect("events");
    assert_eq!(
        events.len(),
        1,
        "one transition event for the deleted payload"
    );
    let payload = &events[0]["data"]["payload"];
    assert_eq!(payload["kind"], "disabled");
    assert_eq!(payload["session_id"], session.to_string());
    let text = events[0].to_string();
    assert!(!text.contains("secret-repo-name") && !text.contains("secret-branch"));
}
