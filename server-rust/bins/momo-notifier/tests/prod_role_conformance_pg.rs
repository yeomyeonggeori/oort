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
//! | `a_hosted_work_run_push_and_run_status_trigger_run_as_the_notifier_role` (#3553) | drop `GRANT SELECT (workspace_id, agent_member_id) ON hosted_agent_connection` — the push judgment `wrun` arm and the migration-120 `agent_run` trigger both read it |
//! | `a_hosted_work_run_push_and_run_status_trigger_run_as_the_notifier_role` (#3740) | drop `GRANT SELECT, INSERT ON agent_run_event TO momo_notifier` — the migration-128 ledger trigger appends as the invoking role (verified red: `permission denied for table agent_run_event`) |
//! | `an_approval_audience_is_judged_as_the_production_notifier_role` (ADR-0204 D7, #3928) | drop `GRANT SELECT (workspace_id, member_id, role) ON workspace_membership` — `may_approve_in_tx` reads it for every role-gated card (verified red: `permission denied for table workspace_membership`); or drop the `agent` / `work_host` SELECT the agent-owner and host-owner arms read |
//! | `the_personal_agent_member_trigger_runs_as_every_role_that_writes_member` (#3591) | drop `GRANT UPDATE ON agent` from a role that can UPDATE `member` (the migration-123 trigger updates `agent` as the invoking role), or add the trigger's table to a lockdown |
//! | `the_other_runtime_roles_reach_every_table_the_migrations_created` | a new table that `app`/`relay`/`worker` cannot read or write, or a cloud-box lockdown or a `scheduled_message*` lockdown (ADR-0208 D3: `momo_app` all four verbs, relay/worker/notifier none) that drifts |
//! | `a_dead_push_token_is_invalidated_by_the_production_notifier_role` (#3930) | drop `GRANT UPDATE (invalidated_at, updated_at) ON push_token TO momo_notifier` — the settle's `UPDATE push_token` dies with `permission denied for table push_token`, and rolls back to its savepoint, so ONLY this suite sees it; widen the grant past those two columns and the denied-write half goes red |
//! | `closing_a_stream_enqueues_its_candidate_as_every_role_that_writes_a_stream` (ADR-0204 증보 1 D8-a, #3987) | revoke `INSERT` on `outbox` from `momo_app` or `momo_worker` (the stream's closing write enqueues the `push_candidate` as the invoking role — the same privilege the 011 trigger already needs for the opening INSERT), or give the outbox a kind-specific lockdown |
//! | `a_woken_uncollected_run_is_ended_by_the_production_notifier_role_with_column_scoped_reads` (ADR-0200 증보 3 E7, #4284) | drop a column from the `hosted_agent_connection` / `hosted_agent_liveness` / `hosted_agent_doorbell_ring` / `agent_provider_pin` GRANT the woken verdict reads (the sweep dies with `permission denied for table …` and rolls back to its savepoint, so ONLY this suite sees it); or grant the notifier `token` / `hosted_agent_doorbell` / a table-level SELECT on the new tables (the denied-read half goes red) |
//! | `an_expired_hosted_proposal_is_swept_by_the_production_notifier_role_without_touching_the_inbox` (ADR-0186 증보 v5 U-f, #4702) | make the approval sweep write the proposer's inbox reference (`append_run_reference_in_tx` from `settle_expired_in_tx`): it dies with `permission denied for table token`, the whole workspace's sweep rolls back and the card stays `pending`; or grant the notifier `token` / a write on the inbox tables (the denied-write half goes red); or drop `momo_app`'s write on the inbox tables (the decision route's reference write goes red) |
//!
//! Why #3553 got through anyway: the first test below already called
//! `judge_targets` as the notifier (Postgres checks table privileges when a
//! statement starts, even for an unknown message id), so it was red from the
//! moment #3533 added `hosted_agent_connection` to the judgment SQL — but nothing
//! ran this suite: it is not wired into any PR gate, only into the manual
//! `scripts/verify_notifier_prod_roles.sh`. The #3553 test also drives a real
//! hosted work run through claim -> judge -> dispatch -> settle and the
//! `agent_run` status trigger, so the proof does not rest on that accident.

use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use momo_agent::{end_parked_run_in_tx, RunStatus};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::PgPool;
use momo_drive::StubDriveArchive;
use momo_messaging::{
    opening_stream_props, send_message_in_tx, stream_message_body_in_tx, MessageType, NewMessage,
    StreamEdit, STREAM_PROPS_KEY,
};
use momo_notifier::attachment_reclaim::AttachmentReclaimer;
use momo_notifier::avatar_reclaim::AvatarReclaimer;
use momo_notifier::inbox_retention_sweep::sweep_read_inbox_items;
use momo_notifier::push::PushDrain;
use momo_notifier::share_retention_sweep::sweep_expired_shares;
use momo_notifier::{
    approval_sweep, control_window_sweep, FixedAdapterResolver, Notifier, NotifierConfig,
    PushConfig,
};
use momo_push::{
    settle_dispatch_and_invalidate, DispatchOutcome, PushDispatch, PushDispatcher, SettleOutcome,
};
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

/// `bootstrap_runtime_roles.sql` rotates the four runtime roles' passwords and
/// attributes, and roles are cluster-global: only a disposable cluster may be the
/// target. Loopback is accepted; anything else needs an explicit opt-in.
fn assert_disposable_cluster() {
    let options: PgConnectOptions = cluster_url().parse().expect("DATABASE_URL parses");
    let host = options.get_host().to_string();
    let loopback = matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1");
    let opted_in = std::env::var("MOMO_ALLOW_ROLE_REPROVISION").as_deref() == Ok("1");
    assert!(
        loopback || opted_in,
        "refusing to re-provision the runtime roles on non-loopback host {host}; \
         set MOMO_ALLOW_ROLE_REPROVISION=1 only for a disposable cluster"
    );
}

/// Drop databases an earlier panicked run left behind (`finish` never ran).
/// Names carry their creation time, so a sibling test's live database is safe.
async fn drop_stale_databases(admin: &PgPool) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_secs();
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT datname::text FROM pg_database WHERE datname LIKE 'prodrole\\_%'",
    )
    .fetch_all(admin)
    .await
    .expect("list databases");
    for name in names {
        let created: u64 = name
            .split('_')
            .nth(1)
            .and_then(|secs| secs.parse().ok())
            .unwrap_or(0);
        if now.saturating_sub(created) > 3600 {
            sqlx::query(&format!("DROP DATABASE IF EXISTS {name} WITH (FORCE)"))
                .execute(admin)
                .await
                .expect("drop stale database");
        }
    }
}

/// A throwaway database provisioned the production way. Dropped on `finish`.
struct ProdDb {
    name: String,
    admin: PgPool,
    su: PgPool,
}

/// Copy the migration files numbered below `first_new` into a scratch directory, so that
/// `run_migrations` can lay down "the previous release's schema" before this release's own.
fn migrations_before(first_new: i64) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "momo-migrations-before-{first_new}-{}",
        Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&dir).expect("scratch migrations dir");
    for entry in std::fs::read_dir(default_migrations_dir()).expect("read migrations") {
        let entry = entry.expect("migration entry");
        let name = entry.file_name().to_string_lossy().to_string();
        let number: Option<i64> = name.split('_').next().and_then(|n| n.parse().ok());
        if name.ends_with(".sql") && matches!(number, Some(n) if n < first_new) {
            std::fs::copy(entry.path(), dir.join(&name)).expect("copy migration");
        }
    }
    dir
}

impl ProdDb {
    async fn create() -> ProdDb {
        Self::create_with(None, &[]).await
    }

    /// An **upgrade**: the previous release's schema (every migration below `first_new`)
    /// is already there — with `previous_release_rows` in it — when this release's roles
    /// file runs, before its own migrations (the order Railway's api pre-deploy and the
    /// compose `runtime-roles` service use), and then the rest of the migrations and the
    /// roles file again.
    async fn create_upgrading_from_before(
        first_new: i64,
        previous_release_rows: &[&str],
    ) -> ProdDb {
        Self::create_with(Some(first_new), previous_release_rows).await
    }

    async fn create_with(
        upgrade_from_before: Option<i64>,
        previous_release_rows: &[&str],
    ) -> ProdDb {
        assert_disposable_cluster();
        let admin = PgPoolOptions::new()
            .max_connections(2)
            .connect(&cluster_url())
            .await
            .expect("connect as superuser");
        drop_stale_databases(&admin).await;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_secs();
        let name = format!(
            "prodrole_{now}_{}",
            &Uuid::new_v4().simple().to_string()[..8]
        );
        sqlx::query(&format!("CREATE DATABASE {name}"))
            .execute(&admin)
            .await
            .expect("create database");
        let url = url_for(&name);
        // Same order as Railway's api pre-deploy: roles, migrate, roles again.
        apply_runtime_roles(&url);
        if let Some(first_new) = upgrade_from_before {
            let previous = migrations_before(first_new);
            run_migrations(&url, &previous, SeedMode::None)
                .expect("apply the previous release's migrations");
            let _ = std::fs::remove_dir_all(&previous);
            if !previous_release_rows.is_empty() {
                let previous_pool = PgPoolOptions::new()
                    .max_connections(1)
                    .connect(&url)
                    .await
                    .expect("connect to the previous release's database");
                for statement in previous_release_rows {
                    sqlx::query(statement)
                        .execute(&previous_pool)
                        .await
                        .unwrap_or_else(|error| panic!("seed {statement}: {error}"));
                }
                previous_pool.close().await;
            }
            // This release's pre-deploy runs the roles file on the OLD schema.
            apply_runtime_roles(&url);
        }
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

/// Records every dispatch (the stand-in for the push relay) and accepts it.
struct RecordingPush {
    sent: Mutex<Vec<PushDispatch>>,
}

#[async_trait::async_trait]
impl PushDispatcher for RecordingPush {
    async fn dispatch(&self, dispatch: &PushDispatch) -> DispatchOutcome {
        self.sent.lock().unwrap().push(dispatch.clone());
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
    // #4443: a completed attachment nothing carries and nothing holds, idle for 40 days —
    // the reclaim's candidate read (column-scoped, as the notifier) and its row delete
    // (as momo_app) both have to run for it to go.
    sqlx::query(
        "INSERT INTO attachment \
           (workspace_id, channel_id, uploader_member_id, drive_file_id, name, mime, size_bytes, \
            status, created_at) \
         VALUES ($1, $2, $3, 'attachment-file-1', 'secret-name.pdf', 'application/pdf', 10, \
                 'complete', now() - interval '40 days')",
    )
    .bind(workspace)
    .bind(channel)
    .bind(member)
    .execute(su)
    .await
    .expect("attachment row");
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
    // loop 2c'' — inbox retention (#3681): candidate read (notifier) + delete (app).
    report.check(
        "inbox retention sweep",
        "momo_notifier + momo_app",
        sweep_read_inbox_items(&notifier, &app, 32).await,
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
    // loop 2f — attachment reclaim (#4443). It ships off, so the production default is the
    // dry run: the one cross-tenant read of workspace ids (notifier, column-scoped GRANT)
    // plus the count over the full predicate (app) — and it must delete nothing.
    let dry_run = AttachmentReclaimer::dry_run(10)
        .sweep_once(&notifier, &app)
        .await;
    let dry_run_tally = dry_run.as_ref().ok().and_then(|stats| stats.dry_run);
    report.check(
        "attachment reclaim (dry run, the default)",
        "momo_notifier + momo_app",
        dry_run,
    );
    // …and switched on: the same read, the listing and the delete with its audit row (app).
    let attachment_reclaimer =
        AttachmentReclaimer::new(Arc::new(StubDriveArchive::new("http://drive.invalid")), 10);
    report.check(
        "attachment reclaim",
        "momo_notifier + momo_app",
        attachment_reclaimer.sweep_once(&notifier, &app).await,
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
    let attachments_left: i64 = sqlx::query_scalar("SELECT count(*) FROM attachment")
        .fetch_one(&db.su)
        .await
        .expect("count attachments");
    // The notifier's grant on `attachment` is column-scoped (#4443): the candidate columns
    // are readable, the Drive id, the file name, the mime and the uploader are not — and
    // the dev bootstrap, which holds table-level grants, cannot show that.
    let readable = sqlx::query(
        "SELECT workspace_id, status, message_id, reserved, unreserved_at, created_at \
           FROM attachment LIMIT 1",
    )
    .fetch_all(&notifier)
    .await;
    let mut unreadable = Vec::new();
    for column in [
        "id",
        "drive_file_id",
        "name",
        "mime",
        "uploader_member_id",
        "channel_id",
        "size_bytes",
    ] {
        let attempt = sqlx::query(&format!("SELECT {column} FROM attachment LIMIT 1"))
            .fetch_all(&notifier)
            .await;
        if attempt.is_ok() {
            unreadable.push(column);
        }
    }
    let sealed = sqlx::query("SELECT attachment_id FROM scheduled_message_attachment LIMIT 1")
        .fetch_all(&notifier)
        .await;
    db.finish().await;
    assert!(
        readable.is_ok(),
        "the production notifier reads the candidate columns of attachment: {readable:?}"
    );
    assert!(
        unreadable.is_empty(),
        "the production notifier must NOT read these attachment columns: {unreadable:?}"
    );
    assert!(
        sealed.is_err(),
        "the reservation table stays sealed from the notifier (ADR-0208 D3)"
    );
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
    assert_eq!(
        attachments_left, 0,
        "the idle unbound attachment was reclaimed (workspace ids read as the notifier, listing and delete as momo_app)"
    );
    assert_eq!(
        dry_run_tally,
        Some(momo_messaging::attachment_reclaim::ReclaimTally {
            candidates: 1,
            bytes: 10
        }),
        "the production default counts the one idle file the delete then took, as the production roles"
    );
}

/// **Upgrade order (#4443, migration 150).** The roles file runs before a release's
/// migrations as well as after them, and migration 150 adds `attachment.reserved` /
/// `unreserved_at` — columns the notifier's grant names. On an upgrade the first pass
/// sees the table without the columns; a grant that named them anyway stopped the whole
/// file (`column "reserved" of relation "attachment" does not exist`, ON_ERROR_STOP) and
/// with it the deploy. Every other suite here builds its database from nothing, where the
/// table does not exist yet on the first pass, so none of them could see it.
///
/// The previous release's database also holds a schedule that holds one of two files, so
/// the migration's backfill runs over a **real** reservation row (on an empty table its
/// row-count assertion is 0 = 0 and proves nothing): afterwards the held file is
/// `reserved` and the free one is not.
///
/// Take the existence guard off the grant in `bootstrap_runtime_roles.sql` and this goes
/// red inside `create_upgrading_from_before` (the pre-migrate pass fails); make the
/// backfill set `false`, or miss the row, and the flag assertion (or the migration's own
/// count) goes red.
#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL); creates and drops a database"]
async fn an_upgrade_survives_the_pre_migrate_roles_pass_and_ends_with_the_attachment_grant() {
    const WS: &str = "00000000-0000-4000-8000-0000000000a0";
    const MEMBER: &str = "00000000-0000-4000-8000-0000000000a1";
    const CHANNEL: &str = "00000000-0000-4000-8000-0000000000a2";
    const HELD: &str = "00000000-0000-4000-8000-0000000000a3";
    const FREE: &str = "00000000-0000-4000-8000-0000000000a4";
    const SCHEDULE: &str = "00000000-0000-4000-8000-0000000000a5";
    let previous_release = [
        format!("INSERT INTO workspace (id, slug, name) VALUES ('{WS}', 'upgrade-fixture', 'upgrade-fixture')"),
        format!(
            "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
             VALUES ('{MEMBER}', '{WS}', 'human', 'u', 'u-upgrade')"
        ),
        format!(
            "INSERT INTO channel (id, workspace_id, kind, name, created_by) \
             VALUES ('{CHANNEL}', '{WS}', 'public', 'upgrade', '{MEMBER}')"
        ),
        format!(
            "INSERT INTO attachment (id, workspace_id, channel_id, uploader_member_id, drive_file_id, \
                                    name, mime, size_bytes, status) \
             VALUES ('{HELD}', '{WS}', '{CHANNEL}', '{MEMBER}', 'upgrade-held', 'a.txt', 'text/plain', 1, 'complete'), \
                    ('{FREE}', '{WS}', '{CHANNEL}', '{MEMBER}', 'upgrade-free', 'b.txt', 'text/plain', 1, 'complete')"
        ),
        format!(
            "INSERT INTO scheduled_message (id, workspace_id, channel_id, author_member_id, body, \
                                            send_at, client_request_id) \
             VALUES ('{SCHEDULE}', '{WS}', '{CHANNEL}', '{MEMBER}', 'later', now() + interval '2 days', \
                     '00000000-0000-4000-8000-0000000000a6')"
        ),
        format!(
            "INSERT INTO scheduled_message_attachment \
               (scheduled_message_id, workspace_id, member_id, attachment_id, position) \
             VALUES ('{SCHEDULE}', '{WS}', '{MEMBER}', '{HELD}', 0)"
        ),
    ];
    let rows: Vec<&str> = previous_release.iter().map(String::as_str).collect();

    let db = ProdDb::create_upgrading_from_before(150, &rows).await;
    let notifier = db.role("momo_notifier", "momo_notifier_dev_pw").await;
    let reads = sqlx::query("SELECT reserved, unreserved_at FROM attachment LIMIT 1")
        .fetch_all(&notifier)
        .await;
    let name = sqlx::query("SELECT name FROM attachment LIMIT 1")
        .fetch_all(&notifier)
        .await;
    let flags: Vec<(String, bool, bool)> = sqlx::query_as(
        "SELECT id::text, reserved, unreserved_at IS NOT NULL FROM attachment ORDER BY id",
    )
    .fetch_all(&db.su)
    .await
    .expect("read the flags");
    db.finish().await;
    assert!(
        reads.is_ok(),
        "after the upgrade the notifier reads the candidate columns: {reads:?}"
    );
    assert!(
        name.is_err(),
        "…and still not the file name: the grant is the six columns of the cross-tenant read only"
    );
    assert_eq!(
        flags,
        vec![
            (HELD.to_string(), true, false),
            (FREE.to_string(), false, false)
        ],
        "the backfill flagged the file the previous release's schedule holds, and only it"
    );
}

/// #4443 (owner 승인 2026-10-26, 조건 C): migration 151 removes the file **name** from the
/// `attachment.upload_started` audit rows an older release wrote — and from nothing else.
///
/// The previous release's rows are seeded below schema 151 (the upgrade harness), the rest of the
/// migrations run, and the rows are read back. What the proof pins:
///
/// * the named rows lose exactly the top-level `name` key — a schema-v1 row, a row from the old
///   server that wrote no `schema` key at all, and one in **another workspace** (the scrub is
///   cross-tenant: it runs as the migration role, not as a tenant);
/// * every other key survives, the `schema` string is not rewritten;
/// * rows that must not change do not: a v2 row (no name), another action that has a `name` key
///   (`member.renamed`), another attachment action that happens to carry one, and a `name`
///   nested below the top level (the scrub is top-level only, which is the v1 shape);
/// * no row is lost;
/// * **idempotent**: running the file again changes nothing — not even a row version (`xmin`),
///   so an UPDATE that rewrites rows without a name is caught too.
///
/// Red proof: drop `action = 'attachment.upload_started'` from the UPDATE (`member.renamed` and the
/// completed row lose their `name`); delete a different key than `name` (the named rows keep it);
/// narrow the scrub to `detail->>'schema' = '…v1'` (the schema-less old row keeps its name); drop
/// `detail ? 'name'` (the second run rewrites the v2 row: its `xmin` moves). **Not provable here:**
/// the `SET LOCAL row_security = off` line — this harness connects as a superuser, which bypasses
/// RLS anyway (it is a safety net for a migration role that cannot, exactly as in 150).
#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL); creates and drops a database"]
async fn the_audit_scrub_removes_a_file_name_from_old_upload_rows_and_touches_nothing_else() {
    const WS: &str = "00000000-0000-4000-8000-0000000000d0";
    const WS2: &str = "00000000-0000-4000-8000-0000000000d1";
    const V1: &str = "00000000-0000-4000-8000-0000000000e1";
    const NO_SCHEMA: &str = "00000000-0000-4000-8000-0000000000e2";
    const OTHER_WORKSPACE: &str = "00000000-0000-4000-8000-0000000000e3";
    const V2: &str = "00000000-0000-4000-8000-0000000000e4";
    const OTHER_ACTION: &str = "00000000-0000-4000-8000-0000000000e5";
    const COMPLETED: &str = "00000000-0000-4000-8000-0000000000e6";
    const NESTED: &str = "00000000-0000-4000-8000-0000000000e7";
    const SECRET: &str = "private-payslip-name-visible-nowhere.pdf";

    let audit = |id: &str, workspace: &str, action: &str, detail: &str| {
        format!(
            "INSERT INTO audit_log (id, workspace_id, action, target_type, detail) \
             VALUES ('{id}', '{workspace}', '{action}', 'attachment', '{detail}'::jsonb)"
        )
    };
    let v1_named = format!(
        r#"{{"schema":"momo.attachment.upload_started.v1","channel_id":"c","name":"{SECRET}","mime":"text/plain","size_bytes":"1"}}"#
    );
    let schemaless_named =
        r#"{"name":"old-server-name.pdf","mime":"text/plain","size_bytes":"2"}"#.to_string();
    let v2 = r#"{"schema":"momo.attachment.upload_started.v2","channel_id":"c","mime":"text/plain","size_bytes":"3"}"#;
    let other_action = r#"{"schema":"momo.member.renamed.v1","name":"keep-this-name"}"#;
    let completed = r#"{"schema":"momo.attachment.upload_completed.v1","name":"keep-this-too","expected_mime":"text/plain"}"#;
    let nested = r#"{"schema":"x","file":{"name":"nested-stays"},"mime":"text/plain"}"#;
    let previous_release = [
        format!("INSERT INTO workspace (id, slug, name) VALUES ('{WS}', 'scrub-a', 'scrub-a'), ('{WS2}', 'scrub-b', 'scrub-b')"),
        audit(V1, WS, "attachment.upload_started", &v1_named),
        audit(NO_SCHEMA, WS, "attachment.upload_started", &schemaless_named),
        audit(OTHER_WORKSPACE, WS2, "attachment.upload_started", &v1_named),
        audit(V2, WS, "attachment.upload_started", v2),
        audit(OTHER_ACTION, WS, "member.renamed", other_action),
        audit(COMPLETED, WS, "attachment.upload_completed", completed),
        audit(NESTED, WS, "attachment.upload_started", nested),
    ];
    let rows: Vec<&str> = previous_release.iter().map(String::as_str).collect();

    let db = ProdDb::create_upgrading_from_before(151, &rows).await;

    let ids: Vec<Uuid> = [
        V1,
        NO_SCHEMA,
        OTHER_WORKSPACE,
        V2,
        OTHER_ACTION,
        COMPLETED,
        NESTED,
    ]
    .iter()
    .map(|id| id.parse().expect("uuid"))
    .collect();
    let read_state = |pool: PgPool| {
        let ids = ids.clone();
        async move {
            sqlx::query_as::<_, (String, String, String)>(
                "SELECT id::text, detail::text, xmin::text FROM audit_log \
                  WHERE id = ANY($1) ORDER BY id",
            )
            .bind(ids)
            .fetch_all(&pool)
            .await
            .expect("read the seeded audit rows")
        }
    };
    let detail_is = |id: &'static str, expected: String| {
        let pool = db.su.clone();
        async move {
            sqlx::query_scalar::<_, bool>(
                "SELECT detail = $2::jsonb FROM audit_log WHERE id = $1::uuid",
            )
            .bind(id)
            .bind(expected)
            .fetch_one(&pool)
            .await
            .expect("compare a detail")
        }
    };

    // 1. After the upgrade (migration 151 ran with the rest).
    let first = read_state(db.su.clone()).await;
    assert_eq!(first.len(), 7, "no audit row was lost");
    let v1_scrubbed =
        r#"{"schema":"momo.attachment.upload_started.v1","channel_id":"c","mime":"text/plain","size_bytes":"1"}"#
            .to_string();
    assert!(
        detail_is(V1, v1_scrubbed.clone()).await,
        "v1: only `name` is gone, the schema string and the other keys stay"
    );
    assert!(
        detail_is(
            NO_SCHEMA,
            r#"{"mime":"text/plain","size_bytes":"2"}"#.into()
        )
        .await,
        "the old server's row carried no schema key and lost its name anyway"
    );
    assert!(
        detail_is(OTHER_WORKSPACE, v1_scrubbed).await,
        "the scrub is cross-tenant: another workspace's row is cleaned too"
    );
    assert!(
        detail_is(V2, v2.into()).await,
        "a v2 row (no name) is unchanged"
    );
    assert!(
        detail_is(OTHER_ACTION, other_action.into()).await,
        "another action's `name` is not this scrub's business"
    );
    assert!(
        detail_is(COMPLETED, completed.into()).await,
        "another attachment action's row is unchanged"
    );
    assert!(
        detail_is(NESTED, nested.into()).await,
        "the scrub is top-level only (the v1 shape): a nested `name` stays"
    );
    let still_named: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE action = 'attachment.upload_started' AND detail ? 'name'",
    )
    .fetch_one(&db.su)
    .await
    .expect("count the rows still carrying a name");
    assert_eq!(
        still_named, 0,
        "no upload_started row keeps a top-level name"
    );
    let secret_anywhere: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE detail::text LIKE '%' || $1 || '%'",
    )
    .bind(SECRET)
    .fetch_one(&db.su)
    .await
    .expect("scan every audit detail for the secret name");
    assert_eq!(
        secret_anywhere, 0,
        "the file name appears in no audit detail"
    );

    // 2. Idempotent: the same file again changes nothing — not even a row version.
    let sql = std::fs::read_to_string(
        default_migrations_dir().join("151_audit_attachment_name_scrub.sql"),
    )
    .expect("read migration 151");
    sqlx::raw_sql(&sql)
        .execute(&db.su)
        .await
        .expect("the scrub runs a second time");
    let second = read_state(db.su.clone()).await;
    db.finish().await;
    assert_eq!(
        first, second,
        "a second run is a no-op: same details and the same row versions (an UPDATE that touches \
         a row without a name would move its xmin)"
    );
}

/// A hosted agent's finished `type=work` run, seeded as the production code
/// leaves it: hosted sentinel agent + `hosted_agent_connection`, a succeeded run
/// of 90 s, the requester's `agent.work.queued` audit row, and the agent's answer
/// (`client_msg_id = run_id`) — whose insert fires the 011 trigger and enqueues the
/// push candidate. A second run is parked on an approval for the status trigger.
struct HostedRun {
    workspace: Uuid,
    requester: Uuid,
    answer: Uuid,
    parked_run: Uuid,
    agent: Uuid,
    channel: Uuid,
}

async fn seed_hosted_work_run(su: &PgPool) -> HostedRun {
    let workspace = Uuid::new_v4();
    let requester = Uuid::new_v4();
    let agent = Uuid::new_v4();
    let channel = Uuid::new_v4();
    let device = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(workspace.to_string())
        .execute(su)
        .await
        .expect("workspace");
    for (id, kind, handle) in [(requester, "human", "req"), (agent, "agent", "hosted")] {
        sqlx::query(
            "INSERT INTO member (id, workspace_id, kind, status, display_name, handle) \
             VALUES ($1, $2, $3::member_kind, 'active', $4, $5)",
        )
        .bind(id)
        .bind(workspace)
        .bind(kind)
        .bind(handle)
        .bind(format!("{handle}{}", id.simple()))
        .execute(su)
        .await
        .expect("member");
    }
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, max_concurrent_runs, \
                            max_run_steps, owner_human_id, config) \
         VALUES ($1, $2, 'hosted-agent', 'https://hosted-agent.invalid/disabled', 4, 50, $3, \
                 jsonb_build_object('execution_mode', 'hosted_dial_in'))",
    )
    .bind(agent)
    .bind(workspace)
    .bind(requester)
    .execute(su)
    .await
    .expect("agent");
    sqlx::query(
        "INSERT INTO hosted_agent_connection \
           (workspace_id, agent_member_id, status, created_by, pairing_challenge_hash, \
            pairing_expires_at) \
         VALUES ($1, $2, 'pairing_pending', $3, '\\x00'::bytea, now() + interval '1 hour')",
    )
    .bind(workspace)
    .bind(agent)
    .bind(requester)
    .execute(su)
    .await
    .expect("hosted connection");
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name) VALUES ($1, $2, 'public', 'work')",
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
    for member in [requester, agent] {
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)",
        )
        .bind(workspace)
        .bind(channel)
        .bind(member)
        .execute(su)
        .await
        .expect("membership");
    }
    sqlx::query(
        "INSERT INTO device (id, workspace_id, member_id, platform) \
         VALUES ($1, $2, $3, 'ios'::device_platform)",
    )
    .bind(device)
    .bind(workspace)
    .bind(requester)
    .execute(su)
    .await
    .expect("device");
    sqlx::query(
        "INSERT INTO push_token (workspace_id, device_id, member_id, apns_token, env, topic) \
         VALUES ($1, $2, $3, $4, 'sandbox'::push_env, 'kim.dawn.momo.e2e')",
    )
    .bind(workspace)
    .bind(device)
    .bind(requester)
    .bind(Uuid::new_v4().simple().to_string().repeat(2))
    .execute(su)
    .await
    .expect("push token");

    let run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run \
           (id, workspace_id, agent_member_id, channel_id, status, input, idempotency_key, \
            started_at, finished_at) \
         VALUES ($1, $2, $3, $4, 'succeeded', jsonb_build_object('type', 'work'), $5, \
                 now() - interval '90 seconds', now())",
    )
    .bind(run)
    .bind(workspace)
    .bind(agent)
    .bind(channel)
    .bind(format!("t:{run}"))
    .execute(su)
    .await
    .expect("finished run");
    sqlx::query(
        "INSERT INTO audit_log (workspace_id, actor_member_id, action, target_type, target_id, run_id) \
         VALUES ($1, $2, 'agent.work.queued', 'agent_run', $3, $3)",
    )
    .bind(workspace)
    .bind(requester)
    .bind(run)
    .execute(su)
    .await
    .expect("requester audit row");
    let answer: Uuid = sqlx::query_scalar(
        "INSERT INTO message \
           (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body, \
            client_msg_id, run_id) \
         VALUES ($1, $2, 1, 1, 0, $3, 'text', 'answer', $4, $4) RETURNING id",
    )
    .bind(workspace)
    .bind(channel)
    .bind(agent)
    .bind(run)
    .fetch_one(su)
    .await
    .expect("run answer (fires push_candidate_enqueue_trg)");

    let parked_run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run \
           (id, workspace_id, agent_member_id, channel_id, status, input, idempotency_key, \
            started_at) \
         VALUES ($1, $2, $3, $4, 'awaiting_approval', jsonb_build_object('type', 'work'), $5, now())",
    )
    .bind(parked_run)
    .bind(workspace)
    .bind(agent)
    .bind(channel)
    .bind(format!("t:{parked_run}"))
    .execute(su)
    .await
    .expect("parked run");
    HostedRun {
        workspace,
        requester,
        answer,
        parked_run,
        agent,
        channel,
    }
}

/// #3553 — the v0.1.18 incident: the push judgment's hosted-work-run arm and the
/// migration-120 `agent_run` status trigger both read `hosted_agent_connection`,
/// which the notifier role could not. Runs the real paths as `momo_notifier`.
#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL); creates and drops a database"]
async fn a_hosted_work_run_push_and_run_status_trigger_run_as_the_notifier_role() {
    let db = ProdDb::create().await;
    let seeded = seed_hosted_work_run(&db.su).await;
    let notifier = db.role("momo_notifier", "momo_notifier_dev_pw").await;
    let mut report = Report { failures: vec![] };

    // The judgment itself, on the real message: the `wrun` arm must select the
    // requester for `work_run_done`.
    {
        let mut conn = notifier.acquire().await.expect("acquire");
        match momo_push::judge_targets(&mut conn, seeded.workspace, seeded.answer).await {
            Ok(targets) => {
                let hit = targets.iter().any(|t| {
                    t.member_id == seeded.requester && t.reason.as_str() == "work_run_done"
                });
                if !hit {
                    report.failures.push(format!(
                        "push judgment (as momo_notifier): no work_run_done target for the requester: {targets:?}"
                    ));
                }
            }
            Err(error) => report
                .failures
                .push(format!("push judgment (as momo_notifier): {error}")),
        }
    }

    // The whole drain: claim → judge → badge → dispatch log → settle.
    let relay = Arc::new(RecordingPush {
        sent: Mutex::new(Vec::new()),
    });
    let drain = PushDrain::new(notifier.clone(), PushConfig::for_target(), relay.clone());
    report.check("push drain", "momo_notifier", drain.drain_once(16).await);
    let sent = relay.sent.lock().unwrap().clone();
    let delivered = sent
        .iter()
        .filter(|d| d.reason == "work_run_done" && d.message_id == seeded.answer.to_string())
        .count();
    if delivered != 1 {
        report.failures.push(format!(
            "push drain (as momo_notifier): expected one work_run_done dispatch, got {delivered}: {sent:?}"
        ));
    }

    // The status trigger: the approval sweep's real statement ends a parked hosted
    // run; migration 120's trigger then reads `hosted_agent_connection` and writes
    // `outbox`, both as the notifier.
    let ended: Result<bool, String> = async {
        let mut tx = notifier.begin().await.map_err(|e| e.to_string())?;
        let ended = end_parked_run_in_tx(
            &mut tx,
            seeded.parked_run,
            RunStatus::TimedOut,
            &serde_json::json!({"code": "approval_expired"}),
        )
        .await
        .map_err(|e| e.to_string())?;
        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(ended)
    }
    .await;
    report.check("agent_run status trigger", "momo_notifier", ended.clone());
    if ended == Ok(false) {
        report
            .failures
            .push("agent_run status trigger: the parked run was not ended".to_string());
    }
    let board_events: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox \
          WHERE workspace_id = $1 AND payload->'data'->>'type' = 'work.run.updated' \
            AND payload->'data'->'payload'->>'run_id' = $2",
    )
    .bind(seeded.workspace)
    .bind(seeded.parked_run.to_string())
    .fetch_one(&db.su)
    .await
    .expect("count board events");

    db.finish().await;
    assert!(
        report.failures.is_empty(),
        "hosted work run paths failed as the production notifier role:\n  {}",
        report.failures.join("\n  ")
    );
    assert!(
        board_events >= 1,
        "the migration-120 trigger wrote a work.run.updated outbox row"
    );
}

/// ADR-0200 D1-4 / D2 (#3744): the two new sweeps do REAL work as their production roles —
/// the stall sweep ends a stalled hosted run as `momo_notifier` (its UPDATE of `agent_run`,
/// the delivery job's retire, the ledger/realtime triggers, the system line, the audit row),
/// and the ledger retention reads as `momo_notifier` and deletes as `momo_app`. The dev
/// bootstrap would hand the notifier every table and pass anyway; this provisions the
/// table-scoped production grants.
#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL); creates and drops a database"]
async fn the_run_stall_and_ledger_retention_sweeps_do_real_work_as_their_production_roles() {
    let db = ProdDb::create().await;
    let seeded = seed_hosted_work_run(&db.su).await;
    let notifier = db.role("momo_notifier", "momo_notifier_dev_pw").await;
    let app = db.role("momo_app", "momo_app_dev_pw").await;

    // a hosted run whose agent claimed it 5 hours ago and never came back
    let stalled = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run (id, workspace_id, agent_member_id, channel_id, status, input, \
                                idempotency_key, started_at, updated_at) \
         VALUES ($1,$2,$3,$4,'running', '{}'::jsonb, $5, now() - interval '5 hours', \
                 now() - interval '4 hours')",
    )
    .bind(stalled)
    .bind(seeded.workspace)
    .bind(seeded.agent)
    .bind(seeded.channel)
    .bind(format!("t:{stalled}"))
    .execute(&db.su)
    .await
    .expect("stalled run");
    sqlx::query(
        "INSERT INTO outbox (workspace_id, kind, status, method, payload, partition_key, \
                             lease_owner, lease_acquired_at, lease_expires_at) \
         VALUES ($1,'agent_job','pending','gateway',$2,$3, uuidv7(), \
                 now() - interval '5 hours', now() - interval '4 hours')",
    )
    .bind(seeded.workspace)
    .bind(serde_json::json!({
        "agent_member_id": seeded.agent.to_string(),
        "run_id": stalled.to_string(),
        "channel_id": seeded.channel.to_string(),
    }))
    .bind(seeded.agent)
    .execute(&db.su)
    .await
    .expect("stalled job");

    // the fixture wrote a message row by hand; bring the channel's counter up to it so the
    // sweep's system line takes the next sequence like any real send
    sqlx::query(
        "UPDATE channel_seq SET last_seq = COALESCE((SELECT max(seq) FROM message WHERE channel_id = $1), 0) \
          WHERE channel_id = $1",
    )
    .bind(seeded.channel)
    .execute(&db.su)
    .await
    .expect("channel_seq catch-up");

    let stats = momo_notifier::run_stall_sweep::sweep_stalled_runs(
        &notifier,
        momo_outbox::StallPolicy::default(),
        32,
    )
    .await
    .expect("the stall sweep runs as the notifier role without a permission error");
    assert_eq!(stats.lease_abandoned, 1, "{stats:?}");
    let (status, code): (String, Option<String>) =
        sqlx::query_as("SELECT status::text, error->>'code' FROM agent_run WHERE id=$1")
            .bind(stalled)
            .fetch_one(&db.su)
            .await
            .unwrap();
    assert_eq!(
        (status.as_str(), code.as_deref()),
        ("timed_out", Some("lease_abandoned"))
    );
    let ledger_last: String = sqlx::query_scalar(
        "SELECT kind FROM agent_run_event WHERE run_id=$1 ORDER BY seq DESC LIMIT 1",
    )
    .bind(stalled)
    .fetch_one(&db.su)
    .await
    .unwrap();
    assert_eq!(
        ledger_last, "timed_out",
        "the ledger trigger appended as the notifier role"
    );
    let frames: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='broadcast' \
           AND payload->'data'->>'type'='agent.run.event' \
           AND lower(payload->'data'->'payload'->>'run_id') = lower($2::text)",
    )
    .bind(seeded.workspace)
    .bind(stalled)
    .fetch_one(&db.su)
    .await
    .unwrap();
    assert!(
        frames >= 1,
        "the realtime trigger emitted as the notifier role"
    );

    // retention: a finished run's ledger past 30 days
    let old = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run (id, workspace_id, agent_member_id, channel_id, status, input, \
                                idempotency_key, finished_at) \
         VALUES ($1,$2,$3,$4,'succeeded','{}'::jsonb,$5, now() - interval '40 days')",
    )
    .bind(old)
    .bind(seeded.workspace)
    .bind(seeded.agent)
    .bind(seeded.channel)
    .bind(format!("t:{old}"))
    .execute(&db.su)
    .await
    .expect("old finished run");
    let retained =
        momo_notifier::run_event_retention_sweep::sweep_expired_run_events(&notifier, &app, 32)
            .await
            .expect("the retention sweep reads as the notifier and deletes as momo_app");
    assert!(retained.deleted >= 1, "{retained:?}");
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM agent_run_event WHERE run_id=$1")
        .bind(old)
        .fetch_one(&db.su)
        .await
        .unwrap();
    assert_eq!(left, 0);
}

#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL); creates and drops a database"]
async fn dm_expiry_and_stall_lines_run_as_the_production_notifier_without_membership_writes() {
    let db = ProdDb::create().await;
    let seeded = seed_hosted_work_run(&db.su).await;
    sqlx::query("UPDATE channel SET kind='dm', dm_key='admitted:' || id::text WHERE id=$1")
        .bind(seeded.channel)
        .execute(&db.su)
        .await
        .unwrap();
    sqlx::query("INSERT INTO dm_agent_admission(workspace_id,channel_id,agent_member_id,requested_by,trigger_message_id,required_human_ids,expires_at,admitted_at,admitted_after_seq) \
        VALUES($1,$2,$3,$4,$5,ARRAY[$4::uuid],now()+interval '15 minutes',clock_timestamp(),1)")
        .bind(seeded.workspace).bind(seeded.channel).bind(seeded.agent).bind(seeded.requester).bind(seeded.answer)
        .execute(&db.su).await.unwrap();
    sqlx::query("UPDATE channel_seq SET last_seq=1 WHERE channel_id=$1")
        .bind(seeded.channel)
        .execute(&db.su)
        .await
        .unwrap();
    let approval = Uuid::new_v4();
    sqlx::query("INSERT INTO approval(id,workspace_id,run_id,channel_id,requested_by,action_type,payload,status,expires_at) \
        VALUES($1,$2,$3,$4,$5,'workspace_action','{\"action\":{\"id\":\"channel.create\",\"args\":{}}}','pending',now()-interval '1 minute')")
        .bind(approval).bind(seeded.workspace).bind(seeded.parked_run).bind(seeded.channel).bind(seeded.agent)
        .execute(&db.su).await.unwrap();
    let stalled = Uuid::new_v4();
    sqlx::query("INSERT INTO agent_run(id,workspace_id,agent_member_id,channel_id,status,input,idempotency_key,started_at,updated_at) \
        VALUES($1,$2,$3,$4,'running','{}',$5,now()-interval '5 hours',now()-interval '4 hours')")
        .bind(stalled).bind(seeded.workspace).bind(seeded.agent).bind(seeded.channel).bind(format!("t:{stalled}"))
        .execute(&db.su).await.unwrap();
    sqlx::query("INSERT INTO outbox(workspace_id,kind,status,method,payload,partition_key,lease_owner,lease_acquired_at,lease_expires_at) \
        VALUES($1,'agent_job','pending','gateway',$2,$3,uuidv7(),now()-interval '5 hours',now()-interval '4 hours')")
        .bind(seeded.workspace).bind(serde_json::json!({"agent_member_id":seeded.agent,"run_id":stalled,"channel_id":seeded.channel}))
        .bind(seeded.agent).execute(&db.su).await.unwrap();

    let notifier = db.role("momo_notifier", "momo_notifier_dev_pw").await;
    let actual_role: String = sqlx::query_scalar("SELECT current_user::text")
        .fetch_one(&notifier)
        .await
        .unwrap();
    assert_eq!(actual_role, "momo_notifier");
    let may_update: bool =
        sqlx::query_scalar("SELECT has_any_column_privilege(current_user,'membership','UPDATE')")
            .fetch_one(&notifier)
            .await
            .unwrap();
    assert!(
        !may_update,
        "membership remains SELECT-only for the notifier"
    );
    let expired = approval_sweep::sweep_expired_approvals(&notifier, 32)
        .await
        .unwrap();
    assert_eq!(
        expired.expired, 1,
        "the whole expiry transaction must commit in a DM: {expired:?}"
    );
    let stalled_stats = momo_notifier::run_stall_sweep::sweep_stalled_runs(
        &notifier,
        momo_outbox::StallPolicy::default(),
        32,
    )
    .await
    .unwrap();
    assert_eq!(
        stalled_stats.lease_abandoned, 1,
        "the stall line must commit in a DM: {stalled_stats:?}"
    );
    let status: String = sqlx::query_scalar("SELECT status::text FROM approval WHERE id=$1")
        .bind(approval)
        .fetch_one(&db.su)
        .await
        .unwrap();
    assert_eq!(status, "expired");
    for run in [seeded.parked_run, stalled] {
        let status: String = sqlx::query_scalar("SELECT status::text FROM agent_run WHERE id=$1")
            .bind(run)
            .fetch_one(&db.su)
            .await
            .unwrap();
        assert_eq!(status, "timed_out");
        let lines: i64 = sqlx::query_scalar("SELECT count(*) FROM message WHERE channel_id=$1 AND author_member_id=$2 AND run_id=$3")
            .bind(seeded.channel).bind(seeded.agent).bind(run).fetch_one(&db.su).await.unwrap();
        assert_eq!(lines, 1, "one durable agent-authored line for each sweep");
    }
    notifier.close().await;
    db.finish().await;
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
    // `mem_*` tables (#3161), the migration-owned read-only catalogs (`plugin_registry`,
    // `schema_migrations`, `work_cloud_host_transition`: #4372, see
    // `migration_owned_catalogs_are_read_only_for_every_runtime_role`), the `cloud_box*` tables (ADR-0197 D10 lockdown, see
    // below) and the `scheduled_message*` tables (ADR-0208 D3 lockdown, see below) are
    // the only tables outside the rule; everything else must be readable and writable
    // by the three ALL-TABLES roles.
    let missing: Vec<String> = sqlx::query_scalar(
        "SELECT format('%s:%s:%s', r.rolname, c.relname, p.priv) \
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
           CROSS JOIN (VALUES ('momo_app'), ('momo_relay'), ('momo_worker')) AS r(rolname) \
           CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS p(priv) \
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') \
            AND c.relname NOT LIKE 'mem\\_%' AND c.relname NOT IN ('plugin_registry', 'schema_migrations', 'work_cloud_host_transition') \
            AND c.relname NOT LIKE 'cloud\\_box%' \
            AND c.relname NOT LIKE 'scheduled\\_message%' \
            AND NOT has_table_privilege(r.rolname, c.oid, p.priv) \
          ORDER BY 1",
    )
    .fetch_all(&db.su)
    .await
    .expect("privilege scan");
    // `cloud-box-lockdown` (bootstrap_runtime_roles.sql, #3500 M1): momo_app holds
    // exactly SELECT/INSERT/UPDATE on the box tables; relay/worker/notifier none.
    let box_drift: Vec<String> = sqlx::query_scalar(
        "SELECT format('%s:%s:%s has=%s', r.rolname, c.relname, p.priv, \
                       has_table_privilege(r.rolname, c.oid, p.priv)) \
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
           CROSS JOIN (VALUES ('momo_app'), ('momo_relay'), ('momo_worker'), ('momo_notifier')) AS r(rolname) \
           CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS p(priv) \
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') \
            AND c.relname LIKE 'cloud\\_box%' \
            AND has_table_privilege(r.rolname, c.oid, p.priv) \
                IS DISTINCT FROM (r.rolname = 'momo_app' AND p.priv <> 'DELETE') \
          ORDER BY 1",
    )
    .fetch_all(&db.su)
    .await
    .expect("cloud box privilege scan");
    // `scheduled-message-lockdown` (bootstrap_runtime_roles.sql, ADR-0208 D3): the body of a
    // schedule that has not gone out belongs to its author alone, and the BYPASSRLS roles skip
    // RLS, so their table privileges are what keeps it from them. `momo_app` keeps **all four**
    // verbs — the tick and the retention sweep DELETE as `momo_app` (the cloud-box block
    // revokes DELETE because a box row is never deleted; this table's rows are).
    let schedule_drift: Vec<String> = sqlx::query_scalar(
        "SELECT format('%s:%s:%s has=%s', r.rolname, c.relname, p.priv, \
                       has_table_privilege(r.rolname, c.oid, p.priv)) \
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
           CROSS JOIN (VALUES ('momo_app'), ('momo_relay'), ('momo_worker'), ('momo_notifier')) AS r(rolname) \
           CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS p(priv) \
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') \
            AND c.relname LIKE 'scheduled\\_message%' \
            AND has_table_privilege(r.rolname, c.oid, p.priv) \
                IS DISTINCT FROM (r.rolname = 'momo_app') \
          ORDER BY 1",
    )
    .fetch_all(&db.su)
    .await
    .expect("scheduled message privilege scan");
    let sealed_tables: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') \
            AND c.relname LIKE 'scheduled\\_message%'",
    )
    .fetch_one(&db.su)
    .await
    .expect("scheduled message table count");
    db.finish().await;
    assert!(
        missing.is_empty(),
        "runtime roles cannot reach tables: {missing:?}"
    );
    assert!(
        box_drift.is_empty(),
        "cloud_box* privileges drifted from the lockdown: {box_drift:?}"
    );
    assert_eq!(
        sealed_tables, 2,
        "the scan must actually see both scheduled_message tables, or it proves nothing"
    );
    assert!(
        schedule_drift.is_empty(),
        "scheduled_message* privileges drifted from the lockdown: {schedule_drift:?}"
    );
}

/// The three tables only a migration (the schema owner) writes. #4372 (SEC-04 follow-up):
/// no runtime role may write them, whatever the ALL TABLES grant or DEFAULT PRIVILEGES say.
const MIGRATION_OWNED_CATALOGS: [&str; 3] = [
    "plugin_registry",
    "schema_migrations",
    "work_cloud_host_transition",
];

/// A real column of each catalog, for the UPDATE probe (a system column or a typo would die in
/// parse analysis, before the permission check, and prove nothing).
fn probe_column(table: &str) -> &'static str {
    match table {
        "plugin_registry" => "plugin_id",
        "schema_migrations" => "version",
        "work_cloud_host_transition" => "from_state",
        other => panic!("no probe column for {other}"),
    }
}

/// Each statement would succeed, or die on a constraint, never on permission, if the role held
/// the verb: `DEFAULT VALUES` on a NOT NULL table fails with 23502 only after the permission
/// check passed. So `42501` is the proof that the privilege itself is gone.
fn write_probes(table: &str) -> [(&'static str, String); 4] {
    [
        (
            "INSERT",
            format!("INSERT INTO public.{table} DEFAULT VALUES"),
        ),
        ("UPDATE", {
            let c = probe_column(table);
            format!("UPDATE public.{table} SET {c} = {c} WHERE false")
        }),
        ("DELETE", format!("DELETE FROM public.{table} WHERE false")),
        ("TRUNCATE", format!("TRUNCATE public.{table}")),
    ]
}

#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL); creates and drops a database"]
async fn migration_owned_catalogs_are_read_only_for_every_runtime_role() {
    let db = ProdDb::create().await;
    let mut failures: Vec<String> = Vec::new();
    for (role, password) in [
        ("momo_app", "momo_app_dev_pw"),
        ("momo_relay", "momo_relay_dev_pw"),
        ("momo_worker", "momo_worker_dev_pw"),
        ("momo_notifier", "momo_notifier_dev_pw"),
    ] {
        let pool = db.role(role, password).await;
        for table in MIGRATION_OWNED_CATALOGS {
            for (verb, sql) in write_probes(table) {
                match sqlx::query(&sql).execute(&pool).await {
                    Ok(_) => failures.push(format!("{role}: {verb} {table} succeeded")),
                    Err(sqlx::Error::Database(error))
                        if error.code().as_deref() == Some("42501") => {}
                    Err(error) => failures.push(format!(
                        "{role}: {verb} {table} failed for a reason other than permission: {error}"
                    )),
                }
            }
        }
        pool.close().await;
    }
    // The revoke must not take reads with it: the API/relay/worker roles read the catalog and
    // the migration ledger, and the notifier's T3 trigger reads the transition table.
    let mut read_failures: Vec<String> = Vec::new();
    for (role, password, tables) in [
        ("momo_app", "momo_app_dev_pw", &MIGRATION_OWNED_CATALOGS[..]),
        (
            "momo_relay",
            "momo_relay_dev_pw",
            &MIGRATION_OWNED_CATALOGS[..],
        ),
        (
            "momo_worker",
            "momo_worker_dev_pw",
            &MIGRATION_OWNED_CATALOGS[..],
        ),
        (
            "momo_notifier",
            "momo_notifier_dev_pw",
            &MIGRATION_OWNED_CATALOGS[2..],
        ),
    ] {
        let pool = db.role(role, password).await;
        for table in tables {
            let rows: Result<i64, _> =
                sqlx::query_scalar(&format!("SELECT count(*) FROM public.{table}"))
                    .fetch_one(&pool)
                    .await;
            match rows {
                Ok(n) if n > 0 => {}
                Ok(_) => read_failures.push(format!("{role}: {table} reads zero rows")),
                Err(error) => read_failures.push(format!("{role}: SELECT {table}: {error}")),
            }
        }
        pool.close().await;
    }
    db.finish().await;
    assert!(
        failures.is_empty(),
        "runtime roles can still write a migration-owned catalog: {failures:?}"
    );
    assert!(
        read_failures.is_empty(),
        "the lockdown took a needed read away: {read_failures:?}"
    );
}

/// The lockdown block is the same text in the dev and prod bootstrap files and names all three
/// tables, so the CI posture (`bootstrap_roles.sql`) cannot drift from production.
#[test]
fn catalog_readonly_lockdown_block_is_identical_in_both_bootstrap_files() {
    fn block(relative: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .join(relative);
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path:?}: {e}"));
        assert_eq!(
            text.matches("-- BEGIN catalog-readonly-lockdown").count(),
            1,
            "{relative}"
        );
        assert_eq!(
            text.matches("-- END catalog-readonly-lockdown").count(),
            1,
            "{relative}"
        );
        let begin = text.find("-- BEGIN catalog-readonly-lockdown").unwrap();
        let end = text.find("-- END catalog-readonly-lockdown").unwrap();
        assert!(begin < end, "{relative}: markers out of order");
        text[begin..end].to_string()
    }
    let dev = block("infra/rust/sql/bootstrap_roles.sql");
    let prod = block("infra/rust/sql/bootstrap_runtime_roles.sql");
    assert_eq!(
        dev, prod,
        "catalog-readonly-lockdown differs between dev and prod bootstrap"
    );
    for table in MIGRATION_OWNED_CATALOGS {
        assert!(
            prod.contains(&format!("'{table}'")),
            "lockdown must name {table}"
        );
    }
    assert!(!prod.contains("GRANT "), "the lockdown revokes only");
}

/// Seed one workspace with an owner and a personal agent, as the superuser.
/// Returns `(workspace, owner, agent)`.
async fn seed_personal_agent(su: &PgPool) -> (Uuid, Uuid, Uuid) {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("pa-{}", &workspace.simple().to_string()[..12]))
        .execute(su)
        .await
        .expect("workspace");
    let owner = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', 'owner', 'owner-h')",
    )
    .bind(owner)
    .bind(workspace)
    .execute(su)
    .await
    .expect("owner");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified) \
         VALUES ($1, $2, 'owner@pa.test', true)",
    )
    .bind(owner)
    .bind(workspace)
    .execute(su)
    .await
    .expect("human");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ($1, $2, 'owner')",
    )
    .bind(workspace)
    .bind(owner)
    .execute(su)
    .await
    .expect("owner membership");
    let agent = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', 'kwak-claude', 'kwak-claude')",
    )
    .bind(agent)
    .bind(workspace)
    .execute(su)
    .await
    .expect("agent member");
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, owner_human_id) \
         VALUES ($1, $2, 'hosted-agent', 'https://hosted-agent.invalid/disabled', $3)",
    )
    .bind(agent)
    .bind(workspace)
    .bind(owner)
    .execute(su)
    .await
    .expect("agent row");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ($1, $2, 'member')",
    )
    .bind(workspace)
    .bind(agent)
    .execute(su)
    .await
    .expect("agent membership");
    (workspace, owner, agent)
}

/// Put the agent back to "personal, switched off by its owner".
async fn arm_personal_agent(su: &PgPool, workspace: Uuid, agent: Uuid) {
    sqlx::query("UPDATE member SET status = 'suspended', deleted_at = NULL WHERE id = $1")
        .bind(agent)
        .execute(su)
        .await
        .expect("reset member");
    sqlx::query(
        "UPDATE agent SET invocation_scope = CASE WHEN subscription_harness IS NULL \
                                                  THEN 'owner_only' ELSE invocation_scope END, \
                subscription_harness = COALESCE(subscription_harness, 'claude_code'), \
                personal_agent = true, personal_disabled_at = now() \
          WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(workspace)
    .bind(agent)
    .execute(su)
    .await
    .expect("arm agent");
}

async fn personal_state(su: &PgPool, agent: Uuid) -> (bool, bool) {
    sqlx::query_as(
        "SELECT personal_agent, personal_disabled_at IS NOT NULL FROM agent WHERE member_id = $1",
    )
    .bind(agent)
    .fetch_one(su)
    .await
    .expect("state")
}

#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL); creates and drops a database"]
async fn the_personal_agent_member_trigger_runs_as_every_role_that_writes_member() {
    let db = ProdDb::create().await;
    let (workspace, owner, agent) = seed_personal_agent(&db.su).await;
    let mut failures: Vec<String> = vec![];

    // Every role the production grants let UPDATE `member`: the trigger's inner
    // `UPDATE agent` runs as that role (SECURITY INVOKER) and must not be denied.
    // The two BYPASSRLS roles write directly; momo_app writes in a tenant tx.
    for (role, password) in [
        ("momo_relay", "momo_relay_dev_pw"),
        ("momo_worker", "momo_worker_dev_pw"),
    ] {
        let pool = db.role(role, password).await;
        for (what, sql) in [
            (
                "status",
                "UPDATE member SET status = 'suspended' WHERE id = $1",
            ),
            (
                "deleted_at",
                "UPDATE member SET deleted_at = now() WHERE id = $1",
            ),
        ] {
            arm_personal_agent(&db.su, workspace, agent).await;
            match sqlx::query(sql).bind(agent).execute(&pool).await {
                Err(error) => failures.push(format!("{role} {what}: {error}")),
                Ok(_) => {
                    let (personal, disabled) = personal_state(&db.su, agent).await;
                    let expected = if what == "deleted_at" {
                        (false, false)
                    } else {
                        (true, false)
                    };
                    if (personal, disabled) != expected {
                        failures.push(format!(
                            "{role} {what}: trigger ran but left {personal}/{disabled}"
                        ));
                    }
                }
            }
        }
    }

    let app = db.role("momo_app", "momo_app_dev_pw").await;
    for (what, sql) in [
        (
            "status",
            "UPDATE member SET status = 'suspended' WHERE id = $1",
        ),
        (
            "deleted_at",
            "UPDATE member SET deleted_at = now() WHERE id = $1",
        ),
    ] {
        arm_personal_agent(&db.su, workspace, agent).await;
        let outcome = momo_db::tenant::with_tenant_tx(&app, workspace, move |conn| {
            Box::pin(async move {
                sqlx::query(sql).bind(agent).execute(&mut *conn).await?;
                Ok(())
            })
        })
        .await;
        if let Err(error) = outcome {
            failures.push(format!("momo_app {what}: {error}"));
        }
    }

    // The real API through the app role: the administrator's suspension and the
    // member removal (status 'deleted').
    arm_personal_agent(&db.su, workspace, agent).await;
    sqlx::query("UPDATE member SET status = 'active' WHERE id = $1")
        .bind(agent)
        .execute(&db.su)
        .await
        .unwrap();
    sqlx::query("UPDATE agent SET personal_disabled_at = now() WHERE member_id = $1")
        .bind(agent)
        .execute(&db.su)
        .await
        .unwrap();
    let suspended = momo_db::tenant::with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            momo_settings::set_member_status_in_tx(
                conn,
                workspace,
                owner,
                agent,
                momo_settings::StatusTransition::Suspend,
            )
            .await
            .map(|inner| inner.is_ok())
        })
    })
    .await;
    match suspended {
        Ok(true) => {
            let (personal, disabled) = personal_state(&db.su, agent).await;
            assert!(personal, "a suspension keeps the personal agent");
            assert!(
                !disabled,
                "an administrator's suspension erases the owner's switch-off evidence"
            );
        }
        Ok(false) => failures.push("set_member_status_in_tx refused the suspension".into()),
        Err(error) => failures.push(format!("set_member_status_in_tx as momo_app: {error}")),
    }
    let removed = momo_db::tenant::with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            momo_settings::remove_workspace_member_in_tx(conn, workspace, owner, agent, false, None)
                .await
                .map(|inner| inner.is_ok())
        })
    })
    .await;
    match removed {
        Ok(true) => {
            let (personal, _) = personal_state(&db.su, agent).await;
            assert!(!personal, "removing the member releases the personal slot");
        }
        Ok(false) => failures.push("remove_workspace_member_in_tx refused".into()),
        Err(error) => failures.push(format!(
            "remove_workspace_member_in_tx as momo_app: {error}"
        )),
    }

    // The notifier never reaches the trigger: it holds SELECT on member only, so
    // a write is denied on `member` itself, before any trigger could run.
    let notifier = db.role("momo_notifier", "momo_notifier_dev_pw").await;
    let denied = sqlx::query("UPDATE member SET status = 'suspended' WHERE id = $1")
        .bind(agent)
        .execute(&notifier)
        .await
        .expect_err("the notifier must not be able to write member");
    assert!(
        denied
            .to_string()
            .contains("permission denied for table member"),
        "unexpected notifier error: {denied}"
    );

    db.finish().await;
    assert!(
        failures.is_empty(),
        "role failures:\n{}",
        failures.join("\n")
    );
}

// ---------------------------------------------------------------------------
// ADR-0204 D7 (#3928) — the approval audience reads, as the production role
// ---------------------------------------------------------------------------

/// Three approval cards, each of which sends `judge_targets` down a different read:
///
/// | card | the read that decides who is woken | table |
/// |---|---|---|
/// | an admin-gated workspace action | `active_workspace_role` | `workspace_membership` (column grant) |
/// | an `agent_editor` action | `active_workspace_role` + `agent_owner_in_tx` | `workspace_membership`, `agent` |
/// | a spawn whose card sits on a member's laptop | `remote_host_owner_in_tx` | `work_host` |
struct AudienceFixture {
    workspace: Uuid,
    owner: Uuid,
    admin: Uuid,
    agent_owner: Uuid,
    host_owner: Uuid,
    admin_card: Uuid,
    editor_card: Uuid,
    spawn_card: Uuid,
}

async fn seed_audience_fixture(su: &PgPool) -> AudienceFixture {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(workspace.to_string())
        .execute(su)
        .await
        .expect("workspace");

    let mut people = Vec::new();
    for (handle, role) in [
        ("owner", "owner"),
        ("admin", "admin"),
        ("plain", "member"),
        ("agentowner", "member"),
        ("hostowner", "member"),
    ] {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO member (id, workspace_id, kind, status, display_name, handle) \
             VALUES ($1, $2, 'human', 'active', $3, $3)",
        )
        .bind(id)
        .bind(workspace)
        .bind(handle)
        .execute(su)
        .await
        .expect("human");
        sqlx::query(
            "INSERT INTO workspace_membership (workspace_id, member_id, role) \
             VALUES ($1, $2, $3::membership_role)",
        )
        .bind(workspace)
        .bind(id)
        .bind(role)
        .execute(su)
        .await
        .expect("workspace membership");
        people.push(id);
    }
    let (owner, admin, _plain, agent_owner, host_owner) =
        (people[0], people[1], people[2], people[3], people[4]);

    let requester = Uuid::new_v4();
    let pet = Uuid::new_v4();
    for (id, handle, owned_by) in [(requester, "requester", owner), (pet, "pet", agent_owner)] {
        sqlx::query(
            "INSERT INTO member (id, workspace_id, kind, status, display_name, handle) \
             VALUES ($1, $2, 'agent', 'active', $3, $3)",
        )
        .bind(id)
        .bind(workspace)
        .bind(handle)
        .execute(su)
        .await
        .expect("agent member");
        sqlx::query(
            "INSERT INTO agent (member_id, workspace_id, model, base_url, max_concurrent_runs, \
                                max_run_steps, owner_human_id) \
             VALUES ($1, $2, 'hermes-agent', 'https://gateway.invalid/v1', 4, 50, $3)",
        )
        .bind(id)
        .bind(workspace)
        .bind(owned_by)
        .execute(su)
        .await
        .expect("agent");
    }

    let channel = Uuid::new_v4();
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
    for member in people.iter().copied().chain([requester, pet]) {
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)",
        )
        .bind(workspace)
        .bind(channel)
        .bind(member)
        .execute(su)
        .await
        .expect("membership");
    }
    // Every human has a device: a target that is not returned is then the narrowing,
    // not a missing token.
    for human in &people {
        let device = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO device (id, workspace_id, member_id, platform) \
             VALUES ($1, $2, $3, 'ios'::device_platform)",
        )
        .bind(device)
        .bind(workspace)
        .bind(human)
        .execute(su)
        .await
        .expect("device");
        sqlx::query(
            "INSERT INTO push_token (workspace_id, device_id, member_id, apns_token, env, topic) \
             VALUES ($1, $2, $3, $4, 'sandbox'::push_env, 'kim.dawn.momo.e2e')",
        )
        .bind(workspace)
        .bind(device)
        .bind(human)
        .bind(Uuid::new_v4().simple().to_string().repeat(2))
        .execute(su)
        .await
        .expect("push token");
    }

    let laptop = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO work_host (id, workspace_id, scope, owner_member_id, type, display_name, \
                                public_key, capabilities, last_seen_at) \
         VALUES ($1, $2, 'member', $3, 'app', 'laptop', $4, '{}'::jsonb, clock_timestamp())",
    )
    .bind(laptop)
    .bind(workspace)
    .bind(host_owner)
    .bind("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
    .execute(su)
    .await
    .expect("laptop");

    let run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run \
           (id, workspace_id, agent_member_id, channel_id, status, input, idempotency_key) \
         VALUES ($1, $2, $3, $4, 'awaiting_approval', jsonb_build_object('type', 'chat'), $5)",
    )
    .bind(run)
    .bind(workspace)
    .bind(requester)
    .bind(channel)
    .bind(format!("t:{run}"))
    .execute(su)
    .await
    .expect("run");

    let mut cards = Vec::new();
    for (seq, (action_type, payload)) in [
        (
            "workspace_action",
            serde_json::json!({"action": {"id": "channel.create", "args": {}}}),
        ),
        (
            "workspace_action",
            serde_json::json!({"action": {"id": "agent.rename", "args": {},
                                          "pins": {"target": pet.to_string()}}}),
        ),
        (
            "work.spawn",
            serde_json::json!({"execution": {
                "kind": "work_session_spawn", "tool": "codex", "label": "x",
                "requested_host_id": laptop.to_string(),
                "default_host_id": laptop.to_string(),
                "host_candidates": [{"host_id": laptop.to_string(), "selectable": true}]}}),
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let approval = Uuid::new_v4();
        let message: Uuid = sqlx::query_scalar(
            "INSERT INTO message \
               (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body, props) \
             VALUES ($1, $2, $3, $3, 0, $4, 'approval_request', 'Approve it', \
                     jsonb_build_object('approval_id', $5::text)) \
             RETURNING id",
        )
        .bind(workspace)
        .bind(channel)
        .bind(seq as i64 + 1)
        .bind(requester)
        .bind(approval.to_string())
        .fetch_one(su)
        .await
        .expect("approval card (fires push_candidate_enqueue_trg)");
        sqlx::query(
            "INSERT INTO approval \
               (id, workspace_id, run_id, channel_id, request_message_id, requested_by, \
                action_type, payload, status, expires_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', now() + interval '1 hour')",
        )
        .bind(approval)
        .bind(workspace)
        .bind(run)
        .bind(channel)
        .bind(message)
        .bind(requester)
        .bind(action_type)
        .bind(&payload)
        .execute(su)
        .await
        .expect("approval");
        cards.push(message);
    }

    AudienceFixture {
        workspace,
        owner,
        admin,
        agent_owner,
        host_owner,
        admin_card: cards[0],
        editor_card: cards[1],
        spawn_card: cards[2],
    }
}

/// ADR-0204 D7 (#3928): `judge_targets` now asks who MAY approve an
/// `approval_request`. Those reads — `workspace_membership.role`, `agent.owner_human_id`,
/// `work_host.owner_member_id` — run as `momo_notifier`, which the dev bootstrap would
/// hand every table and the production file does not. The column grant on
/// `workspace_membership` is the new one; this is the only test that EXECUTES it.
///
/// It has to be a real card in a room with real people. The first test above also
/// calls `judge_targets` as the notifier, but with a message id that does not exist: no
/// row comes back, the per-target loop never runs, and `may_approve_in_tx` is never
/// called — deleting the grant would leave that test green.
#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL); creates and drops a database"]
async fn an_approval_audience_is_judged_as_the_production_notifier_role() {
    let db = ProdDb::create().await;
    let seeded = seed_audience_fixture(&db.su).await;
    let notifier = db.role("momo_notifier", "momo_notifier_dev_pw").await;
    let mut report = Report { failures: vec![] };

    for (label, card, expected) in [
        (
            "admin-gated action (reads workspace_membership)",
            seeded.admin_card,
            vec![seeded.owner, seeded.admin],
        ),
        (
            "agent_editor action (reads workspace_membership + agent)",
            seeded.editor_card,
            vec![seeded.owner, seeded.admin, seeded.agent_owner],
        ),
        (
            "spawn on a member's laptop (reads work_host)",
            seeded.spawn_card,
            vec![seeded.host_owner],
        ),
    ] {
        let mut conn = notifier.acquire().await.expect("acquire");
        match momo_push::judge_targets(&mut conn, seeded.workspace, card).await {
            Ok(targets) => {
                let mut got: Vec<Uuid> = targets.iter().map(|t| t.member_id).collect();
                got.sort();
                got.dedup();
                let mut want = expected;
                want.sort();
                if got != want {
                    report
                        .failures
                        .push(format!("{label}: expected {want:?}, got {got:?}"));
                }
                if targets
                    .iter()
                    .any(|t| t.reason.as_str() != "approval_request")
                {
                    report
                        .failures
                        .push(format!("{label}: a target with another reason"));
                }
            }
            Err(error) => report
                .failures
                .push(format!("{label} (as momo_notifier): {error}")),
        }
    }

    db.finish().await;
    assert!(
        report.failures.is_empty(),
        "the approval audience failed as the production notifier role:\n  {}",
        report.failures.join("\n  ")
    );
}

/// Answers every dispatch the way APNs answers a token that was uninstalled.
struct DeadTokenPush;

#[async_trait::async_trait]
impl PushDispatcher for DeadTokenPush {
    async fn dispatch(&self, _dispatch: &PushDispatch) -> DispatchOutcome {
        DispatchOutcome::Accepted {
            apns_status: 410,
            apns_reason: Some("Unregistered".to_string()),
        }
    }
}

/// ADR-0204 D9 / #3930 — a dead APNs token is invalidated by the PRODUCTION
/// notifier role. The dev role file hands `momo_notifier` every verb on every
/// table, so no other `push_*` suite can see a missing `UPDATE` grant on
/// `push_token` — the v0.1.16 shape (`permission denied for table …` only in
/// production). The invalidation also runs in a SAVEPOINT, so the production
/// failure would be a log line and a token that is never retired: this suite is
/// the only place it turns red.
#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL); creates and drops a database"]
async fn a_dead_push_token_is_invalidated_by_the_production_notifier_role() {
    let db = ProdDb::create().await;
    let seeded = seed_hosted_work_run(&db.su).await;
    let notifier = db.role("momo_notifier", "momo_notifier_dev_pw").await;
    let mut report = Report { failures: vec![] };

    let token_id: Uuid =
        sqlx::query_scalar("SELECT id FROM push_token WHERE workspace_id = $1 AND member_id = $2")
            .bind(seeded.workspace)
            .bind(seeded.requester)
            .fetch_one(&db.su)
            .await
            .expect("the requester's push token");
    let invalidated = |su: PgPool| async move {
        sqlx::query_scalar::<_, bool>(
            "SELECT invalidated_at IS NOT NULL FROM push_token WHERE id = $1",
        )
        .bind(token_id)
        .fetch_one(&su)
        .await
        .expect("read push_token")
    };

    // (1) The settle itself, as the production role, so a missing grant is NAMED:
    // the drain below swallows it (SAVEPOINT) and could only say "not invalidated".
    let log_id: Uuid = sqlx::query_scalar(
        "INSERT INTO push_dispatch_log \
           (workspace_id, message_id, member_id, push_token_id, collapse_id) \
         VALUES ($1, $2, $3, $4, 'm:prod-role-direct') RETURNING id",
    )
    .bind(seeded.workspace)
    .bind(seeded.answer)
    .bind(seeded.requester)
    .bind(token_id)
    .fetch_one(&db.su)
    .await
    .expect("claim a dispatch-log row");
    let workspace = seeded.workspace;
    let outcome = momo_db::tenant::with_tenant_tx(&notifier, workspace, move |conn| {
        Box::pin(async move {
            settle_dispatch_and_invalidate(
                conn,
                workspace,
                log_id,
                token_id,
                410,
                Some("Unregistered"),
            )
            .await
        })
    })
    .await;
    match outcome {
        Ok(SettleOutcome::Invalidated(_)) => {}
        Ok(SettleOutcome::InvalidationFailed { error, .. }) => report.failures.push(format!(
            "settle_dispatch_and_invalidate (as momo_notifier): the UPDATE failed: {error}"
        )),
        Ok(other) => report.failures.push(format!(
            "settle_dispatch_and_invalidate (as momo_notifier): expected Invalidated, got {other:?}"
        )),
        Err(error) => report.failures.push(format!(
            "settle_dispatch_and_invalidate (as momo_notifier): {error}"
        )),
    }
    if !invalidated(db.su.clone()).await {
        report
            .failures
            .push("the token was not invalidated by the settle (as momo_notifier)".to_string());
    }
    let status: Option<i32> =
        sqlx::query_scalar("SELECT apns_status FROM push_dispatch_log WHERE id = $1")
            .bind(log_id)
            .fetch_one(&db.su)
            .await
            .expect("read the settled log row");
    if status != Some(410) {
        report.failures.push(format!(
            "the receipt was not settled with the invalidation: {status:?}"
        ));
    }

    // (2) End to end through the drain: claim -> judge -> dispatch (410) -> settle.
    sqlx::query("UPDATE push_token SET invalidated_at = NULL WHERE id = $1")
        .bind(token_id)
        .execute(&db.su)
        .await
        .expect("revive the token");
    let drain = PushDrain::new(
        notifier.clone(),
        PushConfig::for_target(),
        Arc::new(DeadTokenPush),
    );
    report.check(
        "push drain (410)",
        "momo_notifier",
        drain.drain_once(16).await,
    );
    if !invalidated(db.su.clone()).await {
        report.failures.push(
            "push drain (as momo_notifier): a 410 left the token active — the invalidating UPDATE \
             was denied or skipped (check GRANT UPDATE (invalidated_at, updated_at) ON push_token)"
                .to_string(),
        );
    }

    // (3) The grant is two columns and nothing else: the notifier must not be able
    // to rewrite where a push goes, whose it is, or delete the row.
    for (what, sql) in [
        (
            "apns_token",
            "UPDATE push_token SET apns_token = 'x' WHERE id = $1",
        ),
        (
            "member_id",
            "UPDATE push_token SET member_id = member_id WHERE id = $1",
        ),
        (
            "device_id",
            "UPDATE push_token SET device_id = device_id WHERE id = $1",
        ),
        ("topic", "UPDATE push_token SET topic = 'x' WHERE id = $1"),
        (
            "created_at",
            "UPDATE push_token SET created_at = now() WHERE id = $1",
        ),
        ("DELETE", "DELETE FROM push_token WHERE id = $1"),
    ] {
        match sqlx::query(sql).bind(token_id).execute(&notifier).await {
            Ok(_) => report.failures.push(format!(
                "momo_notifier could write push_token ({what}) — the grant must be exactly \
                 UPDATE (invalidated_at, updated_at)"
            )),
            Err(error) if error.to_string().contains("permission denied") => {}
            Err(error) => report.failures.push(format!(
                "momo_notifier push_token ({what}): unexpected error {error}"
            )),
        }
    }

    db.finish().await;
    assert!(
        report.failures.is_empty(),
        "push token invalidation as the production notifier role failed:\n  {}",
        report.failures.join("\n  ")
    );
}

/// ADR-0204 증보 1 D8-a (#3987): the write that closes a streamed message also enqueues the
/// message's second push candidate, **as the role that closes it**. In production that is
/// `momo_app` (the REST `PATCH` with a `stream` block, in a tenant transaction) and
/// `momo_worker` (the agent worker's commit and cancel). Both can already write the outbox —
/// the 011 trigger inserts a candidate as the role that inserts the message — but a new
/// writer is a new place for "permission denied" to surface only in production, so this
/// opens and closes a stream as each of the two under the PRODUCTION grants
/// (`bootstrap_runtime_roles.sql`, applied in the Railway order), and reads the candidate back.
#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL); creates and drops a database"]
async fn closing_a_stream_enqueues_its_candidate_as_every_role_that_writes_a_stream() {
    let db = ProdDb::create().await;
    let (workspace, owner, agent) = seed_personal_agent(&db.su).await;
    let channel = Uuid::new_v4();
    sqlx::query("INSERT INTO channel (id, workspace_id, kind, name) VALUES ($1, $2, 'public', 'stream-roles')")
        .bind(channel)
        .bind(workspace)
        .execute(&db.su)
        .await
        .expect("channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel)
        .bind(workspace)
        .execute(&db.su)
        .await
        .expect("channel_seq");
    for member in [owner, agent] {
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)",
        )
        .bind(workspace)
        .bind(channel)
        .bind(member)
        .execute(&db.su)
        .await
        .expect("membership");
    }

    let mut failures: Vec<String> = vec![];
    for (role, password) in [
        ("momo_app", "momo_app_dev_pw"),
        ("momo_worker", "momo_worker_dev_pw"),
    ] {
        let pool = db.role(role, password).await;
        let run = Uuid::new_v4();
        let opened = momo_db::tenant::with_tenant_tx(&pool, workspace, move |conn| {
            Box::pin(async move {
                send_message_in_tx(
                    conn,
                    workspace,
                    NewMessage {
                        channel_id: channel,
                        author_member_id: agent,
                        message_type: MessageType::Text,
                        body: Some("답을 쓰는 중".to_string()),
                        props: serde_json::json!({ STREAM_PROPS_KEY.to_string(): opening_stream_props() }),
                        root_id: None,
                        reply_to_id: None,
                        client_msg_id: Some(run),
                        run_id: None,
                        hlc_ts: None,
                        hlc_count: None,
                    },
                )
                .await
            })
        })
        .await;
        let message = match opened {
            Ok(sent) => sent.message.id,
            Err(error) => {
                failures.push(format!("{role} open: {error}"));
                continue;
            }
        };
        let closed = momo_db::tenant::with_tenant_tx(&pool, workspace, move |conn| {
            Box::pin(async move {
                stream_message_body_in_tx(
                    conn,
                    workspace,
                    message,
                    agent,
                    "답이 끝났어요",
                    StreamEdit {
                        rev: 1,
                        is_final: true,
                        outcome: None,
                        provisional: false,
                    },
                )
                .await
            })
        })
        .await;
        match closed {
            Err(error) => failures.push(format!("{role} close: {error}")),
            Ok(Err(refused)) => failures.push(format!("{role} close refused: {refused}")),
            Ok(Ok(_)) => {
                let candidates: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM outbox WHERE kind = 'push_candidate' \
                        AND payload->>'message_id' = $1 AND payload->>'source' = 'stream_closed'",
                )
                .bind(message.to_string())
                .fetch_one(&db.su)
                .await
                .expect("count the closing candidate");
                if candidates != 1 {
                    failures.push(format!(
                        "{role}: {candidates} closing candidates, expected 1"
                    ));
                }
            }
        }
    }
    db.finish().await;
    assert!(
        failures.is_empty(),
        "closing a stream under the production grants failed:\n  {}",
        failures.join("\n  ")
    );
}

/// ADR-0200 증보 3 E7 (#4284, acceptance 10): the `woken_not_collected` rule runs as the
/// REAL production notifier role. The dev bootstrap would hand the notifier every table and
/// pass anyway; this provisions the table-scoped production grants, ends a real woken run
/// with them, and then asserts what the role must NOT be able to read.
///
/// Status: written and type-checked, not run in stage 1 of #4284 (no Docker).
#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL); creates and drops a database"]
async fn a_woken_uncollected_run_is_ended_by_the_production_notifier_role_with_column_scoped_reads()
{
    let db = ProdDb::create().await;
    let seeded = seed_hosted_work_run(&db.su).await;
    let notifier = db.role("momo_notifier", "momo_notifier_dev_pw").await;

    // an ACTIVE hosted connection with a real token row (the sweep must not read it)
    let connection: Uuid = sqlx::query_scalar(
        "SELECT id FROM hosted_agent_connection WHERE workspace_id = $1 AND agent_member_id = $2",
    )
    .bind(seeded.workspace)
    .bind(seeded.agent)
    .fetch_one(&db.su)
    .await
    .expect("the seeded connection");
    let scopes: Vec<String> = [
        "agent:port:connect",
        "agent:inbox:read",
        "messages:read",
        "messages:write",
        "agent:jobs:read",
        "agent:runs:callback",
    ]
    .iter()
    .map(|scope| (*scope).to_string())
    .collect();
    sqlx::query(
        "UPDATE hosted_agent_connection \
            SET status = 'detected', pairing_consumed_at = now(), detected_at = now(), \
                detected_by = $3, confirmed_by = $3, confirmed_at = now(), \
                approved_channel_ids = $4, approved_scopes = $5 \
          WHERE workspace_id = $1 AND id = $2",
    )
    .bind(seeded.workspace)
    .bind(connection)
    .bind(seeded.requester)
    .bind(vec![seeded.channel])
    .bind(&scopes)
    .execute(&db.su)
    .await
    .expect("detected connection");
    let token: Uuid = sqlx::query_scalar(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label, \
                           credential_class, hosted_connection_id, audience, created_by) \
         VALUES($1,'agent_bearer',$2,digest($3::text,'sha256'),$4,'h', \
                'hosted_active',$5,'/v1/mcp/agent-port',$6) RETURNING id",
    )
    .bind(seeded.workspace)
    .bind(seeded.agent)
    .bind(format!(
        "momo_agent_v1.{}.{}",
        seeded.workspace,
        Uuid::new_v4().simple()
    ))
    .bind(&scopes)
    .bind(connection)
    .bind(seeded.requester)
    .fetch_one(&db.su)
    .await
    .expect("token");
    sqlx::query(
        "UPDATE hosted_agent_connection SET status = 'active', active_token_id = $3, \
                proved_at = now(), proved_by = $4 WHERE workspace_id = $1 AND id = $2",
    )
    .bind(seeded.workspace)
    .bind(connection)
    .bind(token)
    .bind(seeded.agent)
    .execute(&db.su)
    .await
    .expect("activate");

    // a queued chat run raised an hour ago, its delivery job, and ONE `_ok` ring row
    let run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run (id, workspace_id, agent_member_id, channel_id, status, input, \
                                idempotency_key, created_at, updated_at) \
         VALUES ($1,$2,$3,$4,'queued', jsonb_build_object('type','chat'), $5, \
                 now() - interval '1 hour', now() - interval '1 hour')",
    )
    .bind(run)
    .bind(seeded.workspace)
    .bind(seeded.agent)
    .bind(seeded.channel)
    .bind(format!("t:{run}"))
    .execute(&db.su)
    .await
    .expect("queued run");
    sqlx::query(
        "INSERT INTO outbox (workspace_id, kind, status, method, payload, partition_key) \
         VALUES ($1,'agent_job','pending','gateway', \
                 jsonb_build_object('run_id',$2::text,'agent_member_id',$3::text, \
                                    'channel_id',$4::text,'author_member_id',$5::text), $3)",
    )
    .bind(seeded.workspace)
    .bind(run.to_string())
    .bind(seeded.agent)
    .bind(seeded.channel)
    .bind(seeded.requester)
    .execute(&db.su)
    .await
    .expect("delivery job");
    sqlx::query(
        "SELECT agent_run_event_append($1, $2, 'doorbell_rung', NULL, 'leading_ok', NULL, NULL)",
    )
    .bind(seeded.workspace)
    .bind(run)
    .execute(&db.su)
    .await
    .expect("an ok ring row");
    // the fixture wrote a message row by hand; bring the channel's counter up to it
    sqlx::query(
        "UPDATE channel_seq SET last_seq = COALESCE((SELECT max(seq) FROM message WHERE channel_id = $1), 0) \
          WHERE channel_id = $1",
    )
    .bind(seeded.channel)
    .execute(&db.su)
    .await
    .expect("channel_seq catch-up");
    tokio::time::sleep(std::time::Duration::from_millis(2200)).await;

    let stats = momo_notifier::run_stall_sweep::sweep_stalled_runs(
        &notifier,
        momo_outbox::StallPolicy {
            woken_expire_seconds: 1,
            ..momo_outbox::StallPolicy::default()
        },
        32,
    )
    .await
    .expect("the sweep runs as the production notifier role without a permission error");
    assert!(stats.woken_not_collected >= 1, "{stats:?}");
    let (status, code): (String, Option<String>) =
        sqlx::query_as("SELECT status::text, error->>'code' FROM agent_run WHERE id = $1")
            .bind(run)
            .fetch_one(&db.su)
            .await
            .unwrap();
    assert_eq!(
        (status.as_str(), code.as_deref()),
        ("timed_out", Some("woken_not_collected"))
    );

    // What the role must hold, and must not. `has_*_privilege` answers for the role itself.
    let privilege = |sql: &'static str| {
        let su = db.su.clone();
        async move {
            sqlx::query_scalar::<_, bool>(sql)
                .fetch_one(&su)
                .await
                .unwrap()
        }
    };
    for (what, sql) in [
        (
            "hosted_agent_liveness.last_inbox_read_at",
            "SELECT has_column_privilege('momo_notifier','hosted_agent_liveness','last_inbox_read_at','SELECT')",
        ),
        (
            "hosted_agent_liveness.last_tool_error_at",
            "SELECT has_column_privilege('momo_notifier','hosted_agent_liveness','last_tool_error_at','SELECT')",
        ),
        (
            "hosted_agent_doorbell_ring.requested_at",
            "SELECT has_column_privilege('momo_notifier','hosted_agent_doorbell_ring','requested_at','SELECT')",
        ),
        (
            "agent_provider_pin.kind",
            "SELECT has_column_privilege('momo_notifier','agent_provider_pin','kind','SELECT')",
        ),
        (
            "hosted_agent_connection.approved_scopes",
            "SELECT has_column_privilege('momo_notifier','hosted_agent_connection','approved_scopes','SELECT')",
        ),
    ] {
        assert!(privilege(sql).await, "the notifier must read {what}");
    }
    for (what, sql) in [
        (
            "a table-level SELECT on hosted_agent_liveness",
            "SELECT has_table_privilege('momo_notifier','hosted_agent_liveness','SELECT')",
        ),
        (
            "hosted_agent_liveness.last_tool_call_at (not read)",
            "SELECT has_column_privilege('momo_notifier','hosted_agent_liveness','last_tool_call_at','SELECT')",
        ),
        (
            "a table-level SELECT on hosted_agent_doorbell_ring",
            "SELECT has_table_privilege('momo_notifier','hosted_agent_doorbell_ring','SELECT')",
        ),
        (
            "a table-level SELECT on agent_provider_pin",
            "SELECT has_table_privilege('momo_notifier','agent_provider_pin','SELECT')",
        ),
        (
            "any column of token",
            "SELECT has_any_column_privilege('momo_notifier','token','SELECT')",
        ),
        (
            "any column of hosted_agent_doorbell (url, secret_sealed)",
            "SELECT has_any_column_privilege('momo_notifier','hosted_agent_doorbell','SELECT')",
        ),
        (
            "hosted_agent_connection.pairing_challenge_hash",
            "SELECT has_column_privilege('momo_notifier','hosted_agent_connection','pairing_challenge_hash','SELECT')",
        ),
    ] {
        assert!(!privilege(sql).await, "RED: the notifier must NOT hold {what}");
    }
    db.finish().await;
}

/// Make the seeded hosted connection a LIVE one — `active`, proved, with a real token row
/// and the channel approved — the state a hosted proposer is in when its card lapses.
async fn activate_seeded_hosted_connection(su: &PgPool, seeded: &HostedRun) -> Uuid {
    let connection: Uuid = sqlx::query_scalar(
        "SELECT id FROM hosted_agent_connection WHERE workspace_id = $1 AND agent_member_id = $2",
    )
    .bind(seeded.workspace)
    .bind(seeded.agent)
    .fetch_one(su)
    .await
    .expect("the seeded connection");
    // The reference writer's authority predicate joins the agent's workspace membership and
    // profile rows too; the seeded work-run fixture does not need them and has neither.
    sqlx::query(
        "INSERT INTO workspace_membership(workspace_id, member_id, role) VALUES($1,$2,'member') \
         ON CONFLICT DO NOTHING",
    )
    .bind(seeded.workspace)
    .bind(seeded.agent)
    .execute(su)
    .await
    .expect("agent workspace membership");
    sqlx::query(
        "INSERT INTO agent_profile(agent_member_id, workspace_id, updated_by, paused) \
         VALUES($1,$2,$3,false) ON CONFLICT DO NOTHING",
    )
    .bind(seeded.agent)
    .bind(seeded.workspace)
    .bind(seeded.requester)
    .execute(su)
    .await
    .expect("agent profile");
    let scopes: Vec<String> = [
        "agent:port:connect",
        "agent:inbox:read",
        "messages:read",
        "messages:write",
        "agent:jobs:read",
        "agent:runs:callback",
        "workspace:propose",
    ]
    .iter()
    .map(|scope| (*scope).to_string())
    .collect();
    sqlx::query(
        "UPDATE hosted_agent_connection \
            SET status = 'detected', pairing_consumed_at = now(), detected_at = now(), \
                detected_by = $3, confirmed_by = $3, confirmed_at = now(), \
                approved_channel_ids = $4, approved_scopes = $5 \
          WHERE workspace_id = $1 AND id = $2",
    )
    .bind(seeded.workspace)
    .bind(connection)
    .bind(seeded.requester)
    .bind(vec![seeded.channel])
    .bind(&scopes)
    .execute(su)
    .await
    .expect("detected connection");
    let token: Uuid = sqlx::query_scalar(
        "INSERT INTO token(workspace_id, kind, actor_member_id, token_hash, scopes, label, \
                           credential_class, hosted_connection_id, audience, created_by) \
         VALUES($1,'agent_bearer',$2,digest($3::text,'sha256'),$4,'h', \
                'hosted_active',$5,'/v1/mcp/agent-port',$6) RETURNING id",
    )
    .bind(seeded.workspace)
    .bind(seeded.agent)
    .bind(format!(
        "momo_agent_v1.{}.{}",
        seeded.workspace,
        Uuid::new_v4().simple()
    ))
    .bind(&scopes)
    .bind(connection)
    .bind(seeded.requester)
    .fetch_one(su)
    .await
    .expect("token");
    sqlx::query(
        "UPDATE hosted_agent_connection SET status = 'active', active_token_id = $3, \
                proved_at = now(), proved_by = $4 WHERE workspace_id = $1 AND id = $2",
    )
    .bind(seeded.workspace)
    .bind(connection)
    .bind(token)
    .bind(seeded.agent)
    .execute(su)
    .await
    .expect("activate");
    connection
}

/// ADR-0186 증보 v5 U-f (#4702): a person's decision tells the hosted proposer through its
/// inbox — and **an expiry does not**. The reason is a grant, so only the production roles
/// can show it:
///
/// * the approval sweep runs as `momo_notifier`, which holds no column of `token` (a
///   BYPASSRLS role never reads a credential) and no write on the inbox tables, so a sweep
///   that wrote the proposer's reference would die with `permission denied`, roll the whole
///   workspace's sweep back and leave the run `awaiting_approval`. The dev role file hands the
///   notifier every table, and an inbox write there would pass.
/// * the decision route runs as `momo_app`, whose production grants do cover the reference
///   write — the two statements the approve and reject arms issue run here as that role.
///
/// | revert that makes it red |
/// |---|
/// | call `append_run_reference_in_tx` from `settle_expired_in_tx` (the sweep): `permission denied for table token`, the approval stays `pending` |
/// | grant `momo_notifier` a write on `hosted_agent_inbox_event` / `_counter`, or any column of `token` |
/// | drop `momo_app`'s write on the inbox tables: the reference write below fails |
#[tokio::test]
#[ignore = "needs a pgvector/pg18 superuser DB (DATABASE_URL); creates and drops a database"]
async fn an_expired_hosted_proposal_is_swept_by_the_production_notifier_role_without_touching_the_inbox(
) {
    let db = ProdDb::create().await;
    let seeded = seed_hosted_work_run(&db.su).await;
    let connection = activate_seeded_hosted_connection(&db.su, &seeded).await;
    let notifier = db.role("momo_notifier", "momo_notifier_dev_pw").await;
    let app = db.role("momo_app", "momo_app_dev_pw").await;

    // A `workspace_action` the hosted agent proposed, parked on the seeded run and overdue.
    let approval = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO approval \
           (id, workspace_id, run_id, channel_id, requested_by, action_type, payload, status, \
            expires_at) \
         VALUES ($1, $2, $3, $4, $5, 'workspace_action', \
                 jsonb_build_object('action', jsonb_build_object('id', 'channel.create', \
                                                                  'args', jsonb_build_object())), \
                 'pending', now() - interval '1 minute')",
    )
    .bind(approval)
    .bind(seeded.workspace)
    .bind(seeded.parked_run)
    .bind(seeded.channel)
    .bind(seeded.agent)
    .execute(&db.su)
    .await
    .expect("an overdue workspace action");
    // The fixture wrote its message row by hand; bring the channel's counter up to it, so the
    // expiry line the sweep writes takes the next `seq` rather than colliding with it.
    sqlx::query(
        "UPDATE channel_seq SET last_seq = COALESCE((SELECT max(seq) FROM message WHERE channel_id = $1), 0) \
          WHERE channel_id = $1",
    )
    .bind(seeded.channel)
    .execute(&db.su)
    .await
    .expect("channel_seq catch-up");

    // #3982: exercise the actual props/body UPDATE and its triggers, rather
    // than settling an approval with no request_message_id (which proves no grants).
    let (ws, channel, agent, run) = (
        seeded.workspace,
        seeded.channel,
        seeded.agent,
        seeded.parked_run,
    );
    let card = momo_db::with_tenant_tx(&app, ws, move |conn| Box::pin(async move {
        send_message_in_tx(conn, ws, NewMessage {
            channel_id: channel, author_member_id: agent, message_type: MessageType::ApprovalRequest,
            body: Some("채널을 만들어도 될까요?".into()),
            props: serde_json::json!({"approval_id": approval, "status":"pending", "last_attempt":"role_required"}),
            root_id: None, reply_to_id: None, client_msg_id: Some(Uuid::new_v4()),
            run_id: Some(run), hlc_ts: None, hlc_count: None,
        }).await
    })).await.expect("request card through the production app role");
    sqlx::query("UPDATE approval SET request_message_id=$2 WHERE id=$1")
        .bind(approval)
        .bind(card.message.id)
        .execute(&db.su)
        .await
        .unwrap();

    let stats = approval_sweep::sweep_expired_approvals(&notifier, 32)
        .await
        .expect("the sweep runs as the production notifier role");
    assert_eq!(
        stats.expired, 1,
        "the overdue card was settled — a sweep that tried to write the proposer's inbox \
         would have been denied and rolled back: {stats:?}"
    );
    let (approval_status, run_status): (String, String) = sqlx::query_as(
        "SELECT a.status::text, r.status::text FROM approval a JOIN agent_run r ON r.id = a.run_id \
          WHERE a.id = $1",
    )
    .bind(approval)
    .fetch_one(&db.su)
    .await
    .expect("the approval and its run");
    assert_eq!(
        (approval_status.as_str(), run_status.as_str()),
        ("expired", "timed_out")
    );
    let (props, body, state, edited): (
        serde_json::Value,
        String,
        String,
        Option<chrono::DateTime<chrono::Utc>>,
    ) = sqlx::query_as("SELECT props,body,state::text,edited_at FROM message WHERE id=$1")
        .bind(card.message.id)
        .fetch_one(&db.su)
        .await
        .unwrap();
    assert_eq!(
        props["status"], "expired",
        "notifier updated the actual card under production grants"
    );
    assert_eq!(props["result"]["line"], body);
    assert_eq!(body, "승인을 기다리다 만료됐어요");
    assert!(props.get("last_attempt").is_none());
    assert_eq!(state, "sent");
    assert!(edited.is_none());
    let frames: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 \
        AND payload->'data'->>'type'='message.edited' AND payload->'data'->'payload'->>'id'=$2",
    )
    .bind(ws)
    .bind(card.message.id.to_string())
    .fetch_one(&db.su)
    .await
    .unwrap();
    assert_eq!(frames, 1, "the notifier can publish the full row too");

    let inbox_rows = |su: PgPool| async move {
        let events: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM hosted_agent_inbox_event WHERE connection_id = $1",
        )
        .bind(connection)
        .fetch_one(&su)
        .await
        .expect("count inbox events");
        let counter: i64 = sqlx::query_scalar(
            "SELECT coalesce(max(last_seq), 0) FROM hosted_agent_inbox_counter \
              WHERE connection_id = $1",
        )
        .bind(connection)
        .fetch_one(&su)
        .await
        .expect("read the inbox counter");
        (events, counter)
    };
    assert_eq!(
        inbox_rows(db.su.clone()).await,
        (0, 0),
        "an expiry writes nothing to the proposer's inbox"
    );

    // The grants that keep it so.
    let privilege = |sql: &'static str| {
        let su = db.su.clone();
        async move {
            sqlx::query_scalar::<_, bool>(sql)
                .fetch_one(&su)
                .await
                .unwrap()
        }
    };
    for (what, sql) in [
        (
            "any column of token",
            "SELECT has_any_column_privilege('momo_notifier','token','SELECT')",
        ),
        (
            "INSERT on hosted_agent_inbox_event",
            "SELECT has_table_privilege('momo_notifier','hosted_agent_inbox_event','INSERT')",
        ),
        (
            "INSERT on hosted_agent_inbox_counter",
            "SELECT has_table_privilege('momo_notifier','hosted_agent_inbox_counter','INSERT')",
        ),
        (
            "UPDATE on hosted_agent_inbox_counter",
            "SELECT has_table_privilege('momo_notifier','hosted_agent_inbox_counter','UPDATE')",
        ),
    ] {
        assert!(
            !privilege(sql).await,
            "RED: the notifier must NOT hold {what}"
        );
    }

    // The decision route's half, as `momo_app` under the production grants: the reference
    // an approve or reject writes for a run — here the seeded, finished one — is written,
    // and writing it again is the same row.
    let finished_run: Uuid = sqlx::query_scalar(
        "SELECT id FROM agent_run WHERE workspace_id = $1 AND status = 'succeeded'",
    )
    .bind(seeded.workspace)
    .fetch_one(&db.su)
    .await
    .expect("the seeded finished run");
    let (workspace, agent, channel) = (seeded.workspace, seeded.agent, seeded.channel);
    let mut sequences = Vec::new();
    for _ in 0..2 {
        let seq = momo_db::with_tenant_tx(&app, workspace, move |conn| {
            Box::pin(async move {
                momo_messaging::append_run_reference_in_tx(
                    conn,
                    workspace,
                    agent,
                    connection,
                    channel,
                    finished_run,
                )
                .await
            })
        })
        .await
        .expect("momo_app writes the proposer's reference under the production grants");
        sequences.push(seq);
    }
    assert!(
        sequences[0].is_some(),
        "the live connection covers the room"
    );
    assert_eq!(sequences[0], sequences[1], "a replay is the same reference");
    assert_eq!(
        inbox_rows(db.su.clone()).await,
        (1, 1),
        "one run reference, one counter step"
    );

    db.finish().await;
}

// ADR-0217: seed the real card while the agent is seated. Later mutations model
// rows an older deployment left behind, independently of new stop cleanup.
async fn seed_dm_expiry_card(db: &ProdDb) -> (HostedRun, Uuid, Uuid) {
    let seeded = seed_hosted_work_run(&db.su).await;
    sqlx::query("UPDATE channel SET kind='dm',dm_key='admitted:' || id::text WHERE id=$1")
        .bind(seeded.channel)
        .execute(&db.su)
        .await
        .unwrap();
    sqlx::query("INSERT INTO dm_agent_admission(workspace_id,channel_id,agent_member_id,requested_by,trigger_message_id,required_human_ids,expires_at,admitted_at,admitted_after_seq) VALUES($1,$2,$3,$4,$5,ARRAY[$4::uuid],now()+interval '15 minutes',clock_timestamp(),1)")
        .bind(seeded.workspace).bind(seeded.channel).bind(seeded.agent).bind(seeded.requester).bind(seeded.answer).execute(&db.su).await.unwrap();
    sqlx::query("UPDATE channel_seq SET last_seq=(SELECT max(seq) FROM message WHERE channel_id=$1) WHERE channel_id=$1")
        .bind(seeded.channel).execute(&db.su).await.unwrap();
    let (approval, card) = add_dm_expiry_card(db, &seeded, seeded.parked_run).await;
    (seeded, approval, card)
}
async fn add_dm_expiry_card(db: &ProdDb, seeded: &HostedRun, run: Uuid) -> (Uuid, Uuid) {
    let (ws, channel, agent) = (seeded.workspace, seeded.channel, seeded.agent);
    let app = db.role("momo_app", "momo_app_dev_pw").await;
    let result=momo_db::with_tenant_tx(&app,ws,move |conn| Box::pin(async move {
        let approval=Uuid::new_v4();
        sqlx::query("INSERT INTO approval(id,workspace_id,run_id,channel_id,requested_by,action_type,payload,status,expires_at) VALUES($1,$2,$3,$4,$5,'tool_call','{}','pending',now()-interval '1 minute')")
            .bind(approval).bind(ws).bind(run).bind(channel).bind(agent).execute(&mut *conn).await?;
        let mut message=NewMessage::text(channel,agent,"pending card");
        message.message_type=MessageType::ApprovalRequest; message.run_id=Some(run);
        message.props=serde_json::json!({"status":"pending","approval_id":approval});
        let card=send_message_in_tx(conn,ws,message).await?.message.id;
        momo_agent::approval::attach_request_message_in_tx(conn,ws,approval,card).await?;
        Ok((approval,card))
    })).await.unwrap();
    app.close().await;
    result
}

#[tokio::test]
#[ignore = "dedicated real PG; production notifier grants"]
async fn dm_expiry_closes_legacy_cards_after_removal_suspension_and_retirement() {
    let db = ProdDb::create().await;
    let notifier = db.role("momo_notifier", "momo_notifier_dev_pw").await;
    let role: String = sqlx::query_scalar("SELECT current_user::text")
        .fetch_one(&notifier)
        .await
        .unwrap();
    assert_eq!(role, "momo_notifier");
    for state in ["removed", "suspended", "deleted"] {
        let (seeded, approval, card) = seed_dm_expiry_card(&db).await;
        if state == "removed" {
            sqlx::query("UPDATE membership SET left_at=now() WHERE channel_id=$1 AND member_id=$2")
                .bind(seeded.channel)
                .bind(seeded.agent)
                .execute(&db.su)
                .await
                .unwrap();
            sqlx::query("UPDATE dm_agent_admission SET revoked_at=now() WHERE channel_id=$1")
                .bind(seeded.channel)
                .execute(&db.su)
                .await
                .unwrap();
        } else {
            sqlx::query("UPDATE member SET status=$2::member_status WHERE id=$1")
                .bind(seeded.agent)
                .bind(state)
                .execute(&db.su)
                .await
                .unwrap();
        }
        let pass = approval_sweep::sweep_expired_approvals(&notifier, 32)
            .await
            .unwrap();
        assert_eq!(
            (pass.expired, pass.failed),
            (1, 0),
            "old {state} card must settle as notifier: {pass:?}"
        );
        let closed: bool=sqlx::query_scalar("SELECT a.status='expired' AND m.props->>'status'='expired' AND r.status='timed_out' FROM approval a JOIN message m ON m.id=a.request_message_id JOIN agent_run r ON r.id=a.run_id WHERE a.id=$1 AND m.id=$2")
            .bind(approval).bind(card).fetch_one(&db.su).await.unwrap();
        assert!(closed, "both the card and run close after {state}");
        let lines: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM message WHERE channel_id=$1 AND run_id=$2 AND type='tool_result'",
        )
        .bind(seeded.channel)
        .bind(seeded.parked_run)
        .fetch_one(&db.su)
        .await
        .unwrap();
        assert_eq!(lines, 0, "no fresh agent utterance after {state}");
        let audited: i64=sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE workspace_id=$1 AND action='approval.expired' AND target_id=$2")
            .bind(seeded.workspace).bind(approval).fetch_one(&db.su).await.unwrap();
        assert_eq!(audited, 1, "a skipped line still records the expiry");
    }
    notifier.close().await;
    db.finish().await;
}

#[tokio::test]
#[ignore = "dedicated real PG; production notifier grants"]
async fn dm_expiry_savepoint_isolates_one_bad_card_and_retries_it_next_tick() {
    let db = ProdDb::create().await;
    let (seeded, bad, bad_card) = seed_dm_expiry_card(&db).await;
    let other_run = Uuid::new_v4();
    sqlx::query("INSERT INTO agent_run(id,workspace_id,agent_member_id,channel_id,status,input,idempotency_key) VALUES($1,$2,$3,$4,'awaiting_approval','{}',$5)")
        .bind(other_run).bind(seeded.workspace).bind(seeded.agent).bind(seeded.channel).bind(other_run.to_string()).execute(&db.su).await.unwrap();
    let (good, good_card) = add_dm_expiry_card(&db, &seeded, other_run).await;
    // Fail during card UPDATE, after the approval status and its side effects
    // were written. This proves rollback as well as continuation.
    let fault=format!("CREATE FUNCTION r2_fail_card() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='{bad_card}'::uuid THEN RAISE EXCEPTION 'injected card update failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER r2_fail_card BEFORE UPDATE ON message FOR EACH ROW EXECUTE FUNCTION r2_fail_card();");
    sqlx::raw_sql(&fault).execute(&db.su).await.unwrap();
    let notifier = db.role("momo_notifier", "momo_notifier_dev_pw").await;
    let first = approval_sweep::sweep_expired_approvals(&notifier, 32)
        .await
        .unwrap();
    assert_eq!(
        (first.expired, first.failed),
        (1, 1),
        "one failure cannot abort its neighbor: {first:?}"
    );
    for (id, card, want) in [(bad, bad_card, "pending"), (good, good_card, "expired")] {
        let (ledger,face):(String,String)=sqlx::query_as("SELECT a.status::text,m.props->>'status' FROM approval a JOIN message m ON m.id=a.request_message_id WHERE a.id=$1 AND m.id=$2")
            .bind(id).bind(card).fetch_one(&db.su).await.unwrap();
        assert_eq!(
            (ledger.as_str(), face.as_str()),
            (want, want),
            "atomic settlement for {id}"
        );
    }
    sqlx::raw_sql("DROP TRIGGER r2_fail_card ON message; DROP FUNCTION r2_fail_card();")
        .execute(&db.su)
        .await
        .unwrap();
    let second = approval_sweep::sweep_expired_approvals(&notifier, 32)
        .await
        .unwrap();
    assert_eq!(
        (second.expired, second.failed),
        (1, 0),
        "the failed approval is retried next tick"
    );
    let done: bool=sqlx::query_scalar("SELECT a.status='expired' AND r.status='timed_out' FROM approval a JOIN agent_run r ON r.id=a.run_id WHERE a.id=$1").bind(bad).fetch_one(&db.su).await.unwrap();
    assert!(
        done,
        "the retry commits rather than merely skipping the failed card"
    );
    notifier.close().await;
    db.finish().await;
}
