//! Production-role conformance (#3377 — the v0.1.16 `momo-notifier` incident).
//!
//! Every other `*_pg.rs` suite provisions roles with the **development** file
//! `bootstrap_roles.sql`, whose `ALTER DEFAULT PRIVILEGES … TO momo_notifier`
//! hands the notifier SELECT/INSERT/UPDATE/DELETE on every table. That is why the
//! share retention sweep (#3319) passed all its tests and then died in production
//! with `permission denied for table work_session_share`: the real notifier
//! role is table-scoped (`bootstrap_runtime_roles.sql`, no DELETE).
//!
//! This suite provisions a **fresh database** exactly the way Railway's api
//! pre-deploy does — `bootstrap_runtime_roles.sql`, then the migrations, then
//! `bootstrap_runtime_roles.sql` again (`momo-migrate` step 6) — and never applies
//! the dev file. Then it runs one iteration of each notifier job **as
//! `momo_notifier`** (and its RLS-bound write half as `momo_app`) and fails on any
//! `permission denied`.
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:20522/momo \
//!   cargo test -p momo-notifier --test prod_role_conformance_pg -- --ignored --nocapture
//! ```
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `every_notifier_job_iteration_runs_as_its_production_role` | drop a notifier GRANT the job needs (e.g. `work_session_share`), or move a write back onto the notifier pool |
//! | `the_notifier_role_has_no_delete_and_no_table_it_does_not_name` | add DELETE / `ALL TABLES` for `momo_notifier` |
//! | `the_other_runtime_roles_reach_every_table_the_migrations_created` | a new table that `app`/`relay`/`worker` cannot read or write |

use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::PgPool;
use momo_drive::StubDriveArchive;
use momo_notifier::avatar_reclaim::AvatarReclaimer;
use momo_notifier::push::PushDrain;
use momo_notifier::share_retention_sweep::sweep_expired_shares;
use momo_notifier::{
    approval_sweep, control_window_sweep, FixedAdapterResolver, Notifier, NotifierConfig,
    PushConfig,
};
use momo_push::{DispatchOutcome, PushDispatch, PushDispatcher};
use momo_t3::MockProviderAdapter;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

/// The passwords the runtime file reads through `\getenv`. They match the dev
/// passwords so the shared cluster's other suites keep connecting.
const PASSWORDS: [(&str, &str); 4] = [
    ("MOMO_APP_POSTGRES_PASSWORD", "momo_app_dev_pw"),
    ("RELAY_POSTGRES_PASSWORD", "momo_relay_dev_pw"),
    ("WORKER_POSTGRES_PASSWORD", "momo_worker_dev_pw"),
    ("NOTIFIER_POSTGRES_PASSWORD", "momo_notifier_dev_pw"),
];

fn cluster_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn url_for(database: &str) -> String {
    let base = cluster_url();
    let base = base.split('?').next().unwrap();
    let (head, _) = base.rsplit_once('/').expect("DATABASE_URL has a database");
    format!("{head}/{database}")
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

fn apply_runtime_roles(database_url: &str) {
    let mut command = Command::new(resolve_psql());
    command
        .arg(database_url)
        .args(["-v", "ON_ERROR_STOP=1", "--no-psqlrc", "--quiet"])
        .arg("-f")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../infra/rust/sql/bootstrap_runtime_roles.sql"
        ));
    for (key, value) in PASSWORDS {
        command.env(key, value);
    }
    let status = command.status().expect("spawn psql");
    assert!(status.success(), "bootstrap_runtime_roles.sql failed");
}

/// A throwaway database provisioned the production way. Dropped on `finish`.
struct ProdDb {
    name: String,
    admin: PgPool,
    su: PgPool,
}

impl ProdDb {
    async fn create() -> ProdDb {
        let admin = PgPoolOptions::new()
            .max_connections(2)
            .connect(&cluster_url())
            .await
            .expect("connect as superuser");
        let name = format!("prodrole_{}", &Uuid::new_v4().simple().to_string()[..12]);
        sqlx::query(&format!("CREATE DATABASE {name}"))
            .execute(&admin)
            .await
            .expect("create database");
        let url = url_for(&name);
        // Same order as Railway's api pre-deploy: roles, migrate, roles again.
        apply_runtime_roles(&url);
        run_migrations(&url, &default_migrations_dir(), SeedMode::None)
            .expect("apply all migrations");
        apply_runtime_roles(&url);
        let su = PgPoolOptions::new()
            .max_connections(4)
            .connect(&url)
            .await
            .expect("connect to the fresh database");
        ProdDb { name, admin, su }
    }

    async fn role(&self, role: &str, password: &str) -> PgPool {
        let options: PgConnectOptions = cluster_url().parse().expect("DATABASE_URL parses");
        PgPoolOptions::new()
            .max_connections(4)
            .connect_with(
                options
                    .database(&self.name)
                    .username(role)
                    .password(password),
            )
            .await
            .unwrap_or_else(|error| panic!("connect as {role}: {error}"))
    }

    async fn finish(self) {
        self.su.close().await;
        sqlx::query(&format!(
            "DROP DATABASE IF EXISTS {} WITH (FORCE)",
            self.name
        ))
        .execute(&self.admin)
        .await
        .expect("drop database");
    }
}

struct NoPush;

#[async_trait::async_trait]
impl PushDispatcher for NoPush {
    async fn dispatch(&self, _dispatch: &PushDispatch) -> DispatchOutcome {
        DispatchOutcome::Accepted {
            apns_status: 200,
            apns_reason: None,
        }
    }
}

/// One failing iteration, named by job and role.
struct Report {
    failures: Vec<String>,
}

impl Report {
    fn check<T, E: std::fmt::Display>(&mut self, job: &str, role: &str, result: Result<T, E>) {
        if let Err(error) = result {
            self.failures.push(format!("{job} (as {role}): {error}"));
        }
    }
}

/// Seed an expired shared session and a reclaimable avatar row so the *write*
/// halves of the two-pool jobs really execute, not only their reads.
async fn seed_work(su: &PgPool) {
    let workspace = Uuid::new_v4();
    let member = Uuid::new_v4();
    let channel = Uuid::new_v4();
    let host = Uuid::new_v4();
    let root = Uuid::new_v4();
    let session = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(workspace.to_string())
        .execute(su)
        .await
        .expect("workspace");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', 'p', $3)",
    )
    .bind(member)
    .bind(workspace)
    .bind(member.to_string())
    .execute(su)
    .await
    .expect("member");
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name) VALUES ($1, $2, 'public', 'c')",
    )
    .bind(channel)
    .bind(workspace)
    .execute(su)
    .await
    .expect("channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel)
        .bind(workspace)
        .execute(su)
        .await
        .expect("channel_seq");
    sqlx::query(
        "INSERT INTO work_host (id, workspace_id, scope, owner_member_id, type, display_name, \
                                public_key, capabilities, last_seen_at) \
         VALUES ($1, $2, 'member', $3, 'app', 'mac', $4, '{}'::jsonb, clock_timestamp())",
    )
    .bind(host)
    .bind(workspace)
    .bind(member)
    .bind("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
    .execute(su)
    .await
    .expect("host");
    sqlx::query(
        "INSERT INTO message (id, workspace_id, channel_id, seq, author_member_id, type, props, hlc_ts) \
         VALUES ($1, $2, $3, 1, $4, 'system', '{\"kind\":\"work.session\"}'::jsonb, 1)",
    )
    .bind(root)
    .bind(workspace)
    .bind(channel)
    .bind(member)
    .execute(su)
    .await
    .expect("root message");
    sqlx::query(
        "INSERT INTO work_session (id, workspace_id, channel_id, member_id, host_id, \
                                   root_message_id, tool, label, started_at, origin, folder_label) \
         VALUES ($1, $2, $3, $4, $5, $6, 'shell', 'dev', now() - interval '60 days', \
                 'local_pty', 'momo')",
    )
    .bind(session)
    .bind(workspace)
    .bind(channel)
    .bind(member)
    .bind(host)
    .bind(root)
    .execute(su)
    .await
    .expect("work_session");
    sqlx::query(
        "UPDATE work_session SET status = 'ended', ended_at = now() - interval '40 days' \
          WHERE id = $1",
    )
    .bind(session)
    .execute(su)
    .await
    .expect("end session");
    sqlx::query(
        "INSERT INTO work_session_share (workspace_id, session_id, repo_label, branch, harness, derived_state) \
         VALUES ($1, $2, 'repo', 'main', 'claude', 'done')",
    )
    .bind(workspace)
    .bind(session)
    .execute(su)
    .await
    .expect("share row");
    sqlx::query(
        "INSERT INTO member_avatar_media \
           (workspace_id, member_id, drive_file_id, name, mime, size_bytes, status) \
         VALUES ($1, $2, 'file-1', 'a.png', 'image/png', 10, 'failed')",
    )
    .bind(workspace)
    .bind(member)
    .execute(su)
    .await
    .expect("avatar row");
}

#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL); creates and drops a database"]
async fn every_notifier_job_iteration_runs_as_its_production_role() {
    let db = ProdDb::create().await;
    seed_work(&db.su).await;
    let notifier = db.role("momo_notifier", "momo_notifier_dev_pw").await;
    let app = db.role("momo_app", "momo_app_dev_pw").await;
    let mut report = Report { failures: vec![] };

    let config = NotifierConfig::for_target(url_for(&db.name));
    let service = Notifier::new(
        notifier.clone(),
        config.clone(),
        Arc::new(FixedAdapterResolver::new(Arc::new(
            MockProviderAdapter::mock_a(),
        ))),
    );
    // loops 1 / 2 / 3 — T3 reconcile, tier fallback sweep, lease renewal.
    report.check(
        "t3 reconcile",
        "momo_notifier",
        service.reconcile_once().await,
    );
    report.check(
        "t3 stale sweep",
        "momo_notifier",
        service.sweep_once().await,
    );
    report.check(
        "t3 lease renewal",
        "momo_notifier",
        service.renew_leases_once().await,
    );
    // loop 2b / 2c — approval expiry, control-window lease.
    report.check(
        "approval expiry sweep",
        "momo_notifier",
        approval_sweep::sweep_expired_approvals(&notifier, 32).await,
    );
    report.check(
        "control window sweep",
        "momo_notifier",
        control_window_sweep::sweep_lapsed_control_windows(&notifier, 32).await,
    );
    // loop 2c' — share retention.
    report.check(
        "share retention sweep",
        "momo_notifier",
        sweep_expired_shares(&notifier, &app, 32).await,
    );
    // loop 2d — huddle ghost sweep: the candidate read on the notifier pool.
    report.check(
        "huddle sweep candidate read",
        "momo_notifier",
        momo_messaging::huddle_sweep::active_huddles_for_sweep(&notifier, 32).await,
    );
    // loop 2e — avatar reclaim: candidate read (notifier) + settlement (app).
    let reclaimer =
        AvatarReclaimer::new(Arc::new(StubDriveArchive::new("http://drive.invalid")), 10);
    report.check(
        "avatar reclaim",
        "momo_notifier + momo_app",
        reclaimer.sweep_once(&notifier, &app).await,
    );
    // loop 4 — push drain: claim, and the judgment queries on an unknown message.
    let drain = PushDrain::new(notifier.clone(), PushConfig::for_target(), Arc::new(NoPush));
    report.check(
        "push drain claim",
        "momo_notifier",
        drain.drain_once(8).await,
    );
    {
        let mut conn = notifier.acquire().await.expect("acquire");
        report.check(
            "push judgment",
            "momo_notifier",
            momo_push::judge_targets(&mut conn, Uuid::new_v4(), Uuid::new_v4()).await,
        );
        report.check(
            "push unread badge",
            "momo_notifier",
            momo_push::unread_badge(&mut conn, Uuid::new_v4(), Uuid::new_v4()).await,
        );
    }

    // The write halves really ran (an error-free no-op would prove nothing): the
    // expired payload is gone and the abandoned avatar row is marked reclaimed —
    // both written by `momo_app`, the notifier having no DELETE and no UPDATE on
    // the avatar tables.
    let shares: i64 = sqlx::query_scalar("SELECT count(*) FROM work_session_share")
        .fetch_one(&db.su)
        .await
        .expect("count shares");
    let unreclaimed: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM member_avatar_media WHERE drive_reclaimed_at IS NULL",
    )
    .fetch_one(&db.su)
    .await
    .expect("count avatars");
    db.finish().await;
    assert!(
        report.failures.is_empty(),
        "notifier jobs failed as their production role:\n  {}",
        report.failures.join("\n  ")
    );
    assert_eq!(
        shares, 0,
        "the expired share payload was deleted by the sweep"
    );
    assert_eq!(unreclaimed, 0, "the abandoned avatar row was reclaimed");
}

#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL); creates and drops a database"]
async fn the_notifier_role_has_no_delete_and_no_table_it_does_not_name() {
    let db = ProdDb::create().await;
    let offenders: Vec<String> = sqlx::query_scalar(
        "SELECT format('%s:%s', c.relname, p.priv) \
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
           CROSS JOIN (VALUES ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv) \
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') \
            AND has_table_privilege('momo_notifier', c.oid, p.priv) \
          ORDER BY 1",
    )
    .fetch_all(&db.su)
    .await
    .expect("privilege scan");
    db.finish().await;
    assert!(
        offenders.is_empty(),
        "momo_notifier holds privileges it must never have: {offenders:?}"
    );
}

#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL); creates and drops a database"]
async fn the_other_runtime_roles_reach_every_table_the_migrations_created() {
    let db = ProdDb::create().await;
    // `mem_*` tables (#3161) and the migration-owned `plugin_registry` (revoked from
    // momo_app on purpose) are the only tables outside the rule; everything else must
    // be readable and writable by the three ALL-TABLES roles.
    let missing: Vec<String> = sqlx::query_scalar(
        "SELECT format('%s:%s:%s', r.rolname, c.relname, p.priv) \
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
           CROSS JOIN (VALUES ('momo_app'), ('momo_relay'), ('momo_worker')) AS r(rolname) \
           CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS p(priv) \
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') \
            AND c.relname NOT LIKE 'mem\\_%' AND c.relname <> 'plugin_registry' \
            AND NOT has_table_privilege(r.rolname, c.oid, p.priv) \
          ORDER BY 1",
    )
    .fetch_all(&db.su)
    .await
    .expect("privilege scan");
    db.finish().await;
    assert!(
        missing.is_empty(),
        "runtime roles cannot reach tables: {missing:?}"
    );
}
