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
//! | `the_other_runtime_roles_reach_every_table_the_migrations_created` | a new table that `app`/`relay`/`worker` cannot read or write, or a cloud-box lockdown that drifts |
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

impl ProdDb {
    async fn create() -> ProdDb {
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
    // `mem_*` tables (#3161), the migration-owned `plugin_registry` (revoked from
    // momo_app on purpose) and the `cloud_box*` tables (ADR-0197 D10 lockdown, see
    // below) are the only tables outside the rule; everything else must be readable
    // and writable by the three ALL-TABLES roles.
    let missing: Vec<String> = sqlx::query_scalar(
        "SELECT format('%s:%s:%s', r.rolname, c.relname, p.priv) \
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
           CROSS JOIN (VALUES ('momo_app'), ('momo_relay'), ('momo_worker')) AS r(rolname) \
           CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS p(priv) \
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') \
            AND c.relname NOT LIKE 'mem\\_%' AND c.relname <> 'plugin_registry' \
            AND c.relname NOT LIKE 'cloud\\_box%' \
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
    db.finish().await;
    assert!(
        missing.is_empty(),
        "runtime roles cannot reach tables: {missing:?}"
    );
    assert!(
        box_drift.is_empty(),
        "cloud_box* privileges drifted from the lockdown: {box_drift:?}"
    );
}
