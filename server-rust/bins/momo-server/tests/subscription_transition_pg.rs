//! #3567 T2 — converting `kwak-claude` to a personal agent and retiring `@claude-code`
//! (ADR-0198 증보 1 D2 변경·D7). Every statement here runs as the **production**
//! `momo_app` role (`NOBYPASSRLS`, no superuser) on a database provisioned the way
//! Railway's api pre-deploy does: `bootstrap_runtime_roles.sql`, the migrations,
//! `bootstrap_runtime_roles.sql` again (the same recipe as `prod_role_conformance_pg`).
//! Fixtures are built by the real provisioning functions the register-after-login path
//! uses, so the rows are the ones production has: a paused `hosted_dial_in` sentinel
//! agent with a `pairing_pending` connection and a device slot.
//!
//! ```text
//! DATABASE_URL=postgres://momo:…@127.0.0.1:PORT/momo \
//!   cargo test -p momo-server --test subscription_transition_pg -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `a_dry_run_writes_nothing_and_says_what_it_would_do` | let the dry run reach `apply_in_tx`, or drop `SET LOCAL transaction_read_only` and write anywhere before the verdict |
//! | `convert_keeps_the_member_and_every_message_and_closes_every_door` | skip the connection close or the token revoke (P2's mark then answers `ConnectionsRemain` and the run rolls back), set `status = 'deleted'`, or forget the audit row |
//! | `the_old_lane_stays_shut_after_a_conversion_or_a_retirement` | drop migration 125's `hosted_agent_connection_closed_guard` (the in-test DROP proves the assertion can fail: regenerate then revives the connection) |
//! | `a_second_run_is_a_noop_with_no_second_audit_row` | drop the `AlreadyDone` arm of `decide`, or write the audit row outside the `Proceed` branch |
//! | `retire_suspends_marks_and_keeps_the_author_and_nobody_can_mention_it` | `status = 'deleted'` instead of `suspended`, drop `subscription_retired_at`, or widen the mention candidate query past `member.status = 'active'` |
//! | `the_tool_refuses_what_it_must_not_fake_and_writes_nothing` | let `decide` accept a credentialed (`cleanup_pending`) connection, or let `retire` take an `owner_only` agent / `convert` a workspace one |
//! | `the_binary_runs_only_as_the_application_role_and_executes_only_with_a_note` | drop `assert_least_privilege_role`, or let `--execute` through without `--note`; a table the tool writes that `momo_app` cannot (a prod-role GRANT gap) fails the executed run with `permission denied` |

use std::path::PathBuf;
use std::process::Command;

use momo_agent::subscription_transition::{
    run_transition, Transition, Verdict, AUDIT_CONVERTED, AUDIT_RETIRED,
};
use momo_agent::{AgentCreation, ModelSource, NewAgentMember, SubscriptionHarness};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::tenant::with_tenant_tx;
use momo_db::PgPool;
use serde_json::json;
use uuid::Uuid;

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
    let base = base.split('?').next().unwrap().to_string();
    let (head, _) = base.rsplit_once('/').expect("DATABASE_URL has a database");
    format!("{head}/{database}")
}

/// `postgres://user:password@host:port/db` for `role` on `database`.
fn role_url(database: &str, role: &str, password: &str) -> String {
    let base = url_for(database);
    let (scheme, rest) = base.split_once("://").expect("scheme");
    let (_, host_and_db) = rest.rsplit_once('@').expect("credentials in DATABASE_URL");
    format!("{scheme}://{role}:{password}@{host_and_db}")
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
    assert!(
        command.status().expect("spawn psql").success(),
        "bootstrap_runtime_roles.sql failed"
    );
}

/// Roles are cluster-global: only a disposable cluster may be re-provisioned.
fn assert_disposable_cluster() {
    let options: PgConnectOptions = cluster_url().parse().expect("DATABASE_URL parses");
    let host = options.get_host().to_string();
    let loopback = matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1");
    let opted_in = std::env::var("MOMO_ALLOW_ROLE_REPROVISION").as_deref() == Ok("1");
    assert!(
        loopback || opted_in,
        "refusing to re-provision the runtime roles on non-loopback host {host}"
    );
}

struct ProdDb {
    name: String,
    admin: PgPool,
    su: PgPool,
    app: PgPool,
}

impl ProdDb {
    async fn create() -> ProdDb {
        assert_disposable_cluster();
        let admin = PgPoolOptions::new()
            .max_connections(2)
            .connect(&cluster_url())
            .await
            .expect("connect as superuser");
        let name = format!("subtrans_{}", &Uuid::new_v4().simple().to_string()[..12]);
        sqlx::query(&format!("CREATE DATABASE {name}"))
            .execute(&admin)
            .await
            .expect("create database");
        let url = url_for(&name);
        apply_runtime_roles(&url);
        run_migrations(&url, &default_migrations_dir(), SeedMode::None)
            .expect("apply all migrations");
        apply_runtime_roles(&url);
        let su = PgPoolOptions::new()
            .max_connections(4)
            .connect(&url)
            .await
            .expect("connect to the fresh database");
        let app = PgPoolOptions::new()
            .max_connections(4)
            .connect(&role_url(&name, "momo_app", "momo_app_dev_pw"))
            .await
            .expect("connect as momo_app");
        ProdDb {
            name,
            admin,
            su,
            app,
        }
    }

    async fn finish(self) {
        self.su.close().await;
        self.app.close().await;
        sqlx::query(&format!(
            "DROP DATABASE IF EXISTS {} WITH (FORCE)",
            self.name
        ))
        .execute(&self.admin)
        .await
        .expect("drop database");
    }
}

// ---------------------------------------------------------------------------
// fixtures: the two oort-team rows, built the way production builds them
// ---------------------------------------------------------------------------

struct Fx {
    workspace: Uuid,
    owner: Uuid,
    /// `owner_only` Claude Code subscription agent, `pairing_pending`, with a device slot.
    kwak_claude: Uuid,
    kwak_connection: Uuid,
    /// workspace-scope hosted entry named after a harness, `pairing_pending`.
    claude_code: Uuid,
    channel: Uuid,
}

async fn seed_human(su: &PgPool, workspace: Uuid, handle: &str, role: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO member (id, workspace_id, kind, display_name, handle) VALUES ($1, $2, 'human', $3, $3)")
        .bind(id)
        .bind(workspace)
        .bind(handle)
        .execute(su)
        .await
        .expect("human member");
    sqlx::query("INSERT INTO human (member_id, workspace_id, email, email_verified) VALUES ($1, $2, $3, true)")
        .bind(id)
        .bind(workspace)
        .bind(format!("{handle}@sub.test"))
        .execute(su)
        .await
        .expect("human row");
    // `role` is a test literal (an enum column does not take a text bind).
    sqlx::query(&format!(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ($1, $2, '{role}')"
    ))
    .bind(workspace)
    .bind(id)
    .execute(su)
    .await
    .expect("human membership");
    id
}

async fn seed_message(su: &PgPool, workspace: Uuid, channel: Uuid, author: Uuid, body: &str) {
    let seq: i64 = sqlx::query_scalar(
        "UPDATE channel_seq SET last_seq = last_seq + 1 WHERE channel_id = $1 RETURNING last_seq",
    )
    .bind(channel)
    .fetch_one(su)
    .await
    .expect("seq");
    sqlx::query(
        "INSERT INTO message (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, \
         author_member_id, type, body) VALUES ($1, $2, $3, $4, 0, 0, $5, 'text', $6)",
    )
    .bind(Uuid::new_v4())
    .bind(workspace)
    .bind(channel)
    .bind(seq)
    .bind(author)
    .bind(body)
    .execute(su)
    .await
    .expect("message");
}

async fn seed(db: &ProdDb) -> Fx {
    let su = &db.su;
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("st-{}", &workspace.simple().to_string()[..12]))
        .execute(su)
        .await
        .expect("workspace");
    let owner = seed_human(su, workspace, "kwak", "owner").await;

    // The real provisioning functions, as `momo_app` in a tenant transaction.
    let (kwak_claude, kwak_connection, claude_code) =
        with_tenant_tx(&db.app, workspace, move |conn| {
            Box::pin(async move {
                let mut ids = Vec::new();
                for (handle, harness) in [
                    ("kwak-claude", Some(SubscriptionHarness::ClaudeCode)),
                    ("claude-code", None),
                ] {
                    let AgentCreation::Created(member) = momo_agent::create_agent_identity_in_tx(
                        conn,
                        workspace,
                        &NewAgentMember {
                            display_name: handle.to_string(),
                            handle: handle.to_string(),
                            model: momo_auth::HOSTED_AGENT_MODEL.to_string(),
                            model_source: ModelSource::Agent,
                            base_url: momo_auth::HOSTED_AGENT_INERT_BASE_URL.to_string(),
                            system_prompt: None,
                            config: json!({"execution_mode": "hosted_dial_in"}),
                            owner_human_id: owner,
                        },
                    )
                    .await?
                    else {
                        panic!("agent {handle} was not created");
                    };
                    momo_agent::set_agent_paused_in_tx(conn, workspace, member.id, owner, true)
                        .await?
                        .expect("paused profile");
                    if let Some(harness) = harness {
                        assert!(
                            momo_agent::mark_agent_owner_only_in_tx(
                                conn, workspace, member.id, harness
                            )
                            .await?
                        );
                        assert!(
                            momo_agent::set_subscription_device_in_tx(
                                conn,
                                workspace,
                                member.id,
                                "device-0001"
                            )
                            .await?
                        );
                    }
                    let issuance = momo_auth::create_hosted_connection_in_tx(
                        conn, workspace, member.id, owner,
                    )
                    .await?;
                    ids.push((member.id, issuance.connection.id));
                }
                Ok((ids[0].0, ids[0].1, ids[1].0))
            })
        })
        .await
        .expect("seed agents");

    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name) VALUES ($1, $2, 'public', 'general')",
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
    // Past messages by every author, so "the author is unchanged" has something to lose.
    seed_message(su, workspace, channel, owner, "@kwak-claude 안녕").await;
    seed_message(su, workspace, channel, kwak_claude, "kwak-claude의 예전 답").await;
    seed_message(su, workspace, channel, claude_code, "claude-code의 예전 글").await;
    Fx {
        workspace,
        owner,
        kwak_claude,
        kwak_connection,
        claude_code,
        channel,
    }
}

/// A live credential that acts as the agent (what a hosted CLI would hold).
async fn seed_live_token(su: &PgPool, workspace: Uuid, agent: Uuid) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO token (id, workspace_id, kind, actor_member_id, subject_member_id, \
                            token_hash, scopes, label) \
         VALUES ($1, $2, 'agent_bearer', $3, NULL, digest($4::text, 'sha256'), \
                 ARRAY['messages:write'], 'transition-test')",
    )
    .bind(id)
    .bind(workspace)
    .bind(agent)
    .bind(format!(
        "momo_agent_v1.{workspace}.{}",
        Uuid::new_v4().simple()
    ))
    .execute(su)
    .await
    .expect("token");
    id
}

/// Everything the tool could touch, as text, plus the audit count.
async fn snapshot(su: &PgPool, workspace: Uuid) -> String {
    sqlx::query_scalar(
        "SELECT jsonb_build_object( \
           'member',  (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM member x WHERE workspace_id = $1), \
           'agent',   (SELECT jsonb_agg(to_jsonb(x) ORDER BY member_id) FROM agent x WHERE workspace_id = $1), \
           'conn',    (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM hosted_agent_connection x WHERE workspace_id = $1), \
           'token',   (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM token x WHERE workspace_id = $1), \
           'profile', (SELECT jsonb_agg(to_jsonb(x) ORDER BY agent_member_id) FROM agent_profile x WHERE workspace_id = $1), \
           'message', (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM message x WHERE workspace_id = $1), \
           'audit',   (SELECT count(*) FROM audit_log WHERE workspace_id = $1) \
         )::text",
    )
    .bind(workspace)
    .fetch_one(su)
    .await
    .expect("snapshot")
}

async fn audit_rows(su: &PgPool, workspace: Uuid, action: &str) -> Vec<serde_json::Value> {
    sqlx::query_scalar(
        "SELECT detail FROM audit_log WHERE workspace_id = $1 AND action = $2 ORDER BY created_at",
    )
    .bind(workspace)
    .bind(action)
    .fetch_all(su)
    .await
    .expect("audit rows")
}

async fn authors(su: &PgPool, workspace: Uuid) -> Vec<(String, Uuid)> {
    sqlx::query_as(
        "SELECT body, author_member_id FROM message WHERE workspace_id = $1 ORDER BY seq",
    )
    .bind(workspace)
    .fetch_all(su)
    .await
    .expect("authors")
}

async fn run(
    db: &ProdDb,
    fx: &Fx,
    transition: Transition,
    handle: &str,
    execute: bool,
) -> momo_agent::subscription_transition::TransitionReport {
    run_transition(
        &db.app,
        fx.workspace,
        transition,
        handle,
        execute,
        "성재 승인 2026-10-10 (#3567 시험)",
    )
    .await
    .expect("transition ran")
    .expect("agent exists")
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a disposable PostgreSQL 18 superuser URL in DATABASE_URL"]
async fn a_dry_run_writes_nothing_and_says_what_it_would_do() {
    let db = ProdDb::create().await;
    let fx = seed(&db).await;
    seed_live_token(&db.su, fx.workspace, fx.kwak_claude).await;
    let before = snapshot(&db.su, fx.workspace).await;

    let convert = run(&db, &fx, Transition::Convert, "kwak-claude", false).await;
    let retire = run(&db, &fx, Transition::Retire, "claude-code", false).await;

    assert_eq!(convert.verdict, Verdict::Proceed);
    assert_eq!(retire.verdict, Verdict::Proceed);
    assert!(!convert.execute && convert.changes.audit_id.is_none());
    let plan = convert.render();
    assert!(plan.contains("DRY-RUN"), "{plan}");
    assert!(plan.contains("connections_to_close=1"), "{plan}");
    assert!(plan.contains("tokens_to_revoke=1"), "{plan}");
    assert!(
        plan.contains("messages_authored(그대로 남아요): 1"),
        "{plan}"
    );
    assert_eq!(
        before,
        snapshot(&db.su, fx.workspace).await,
        "a dry run changed a row or the audit log"
    );
    db.finish().await;
}

#[tokio::test]
#[ignore = "needs a disposable PostgreSQL 18 superuser URL in DATABASE_URL"]
async fn convert_keeps_the_member_and_every_message_and_closes_every_door() {
    let db = ProdDb::create().await;
    let fx = seed(&db).await;
    let token = seed_live_token(&db.su, fx.workspace, fx.kwak_claude).await;
    let messages_before = authors(&db.su, fx.workspace).await;

    let report = run(&db, &fx, Transition::Convert, "kwak-claude", true).await;
    assert_eq!(report.verdict, Verdict::Proceed, "{}", report.render());
    let c = &report.changes;
    assert_eq!(
        (
            c.connections_closed,
            c.tokens_revoked,
            c.marked,
            c.device_slot_released
        ),
        (1, 1, true, true),
        "{}",
        report.render()
    );

    // Same member id and handle, still an active agent that belongs to the owner.
    let (handle, kind, status, deleted): (String, String, String, bool) = sqlx::query_as(
        "SELECT handle, kind::text, status::text, deleted_at IS NOT NULL FROM member WHERE id = $1",
    )
    .bind(fx.kwak_claude)
    .fetch_one(&db.su)
    .await
    .unwrap();
    assert_eq!(
        (handle.as_str(), kind.as_str(), status.as_str(), deleted),
        ("kwak-claude", "agent", "active", false)
    );
    // The D7 shape P2 reads and T5 accepts.
    let (personal, disabled, scope, harness, owner, mode, device): (
        bool,
        bool,
        String,
        Option<String>,
        Option<Uuid>,
        String,
        Option<String>,
    ) = sqlx::query_as(
        "SELECT personal_agent, personal_disabled_at IS NOT NULL, invocation_scope, \
                subscription_harness, owner_human_id, config->>'execution_mode', \
                subscription_device_id \
           FROM agent WHERE member_id = $1",
    )
    .bind(fx.kwak_claude)
    .fetch_one(&db.su)
    .await
    .unwrap();
    assert_eq!(
        (
            personal,
            disabled,
            scope.as_str(),
            harness.as_deref(),
            owner
        ),
        (
            true,
            false,
            "owner_only",
            Some("claude_code"),
            Some(fx.owner)
        )
    );
    assert_eq!(mode, "member_host", "no longer a hosted dial-in sentinel");
    assert_eq!(device, None, "the device slot is released");

    // Every author is unchanged, none added, none removed.
    assert_eq!(messages_before, authors(&db.su, fx.workspace).await);

    // The hosted connection is closed and its pairing value is gone; the token is revoked.
    let (status, hash, expires): (String, bool, bool) = sqlx::query_as(
        "SELECT status::text, pairing_challenge_hash IS NOT NULL, pairing_expires_at IS NOT NULL \
           FROM hosted_agent_connection WHERE id = $1",
    )
    .bind(fx.kwak_connection)
    .fetch_one(&db.su)
    .await
    .unwrap();
    assert_eq!((status.as_str(), hash, expires), ("expired", false, false));
    let live: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM token WHERE workspace_id = $1 AND actor_member_id = $2 AND revoked_at IS NULL",
    )
    .bind(fx.workspace)
    .bind(fx.kwak_claude)
    .fetch_one(&db.su)
    .await
    .unwrap();
    assert_eq!(live, 0);
    let revoked: bool =
        sqlx::query_scalar("SELECT revoked_at IS NOT NULL FROM token WHERE id = $1")
            .bind(token)
            .fetch_one(&db.su)
            .await
            .unwrap();
    assert!(revoked);

    // One audit row, attributable and carrying the approval citation.
    let rows = audit_rows(&db.su, fx.workspace, AUDIT_CONVERTED).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["note"], "성재 승인 2026-10-10 (#3567 시험)");
    assert_eq!(rows[0]["handle"], "kwak-claude");
    assert_eq!(rows[0]["messages_kept"], 1);
    let target: Uuid = sqlx::query_scalar(
        "SELECT target_id FROM audit_log WHERE workspace_id = $1 AND action = $2",
    )
    .bind(fx.workspace)
    .bind(AUDIT_CONVERTED)
    .fetch_one(&db.su)
    .await
    .unwrap();
    assert_eq!(target, fx.kwak_claude);

    // The read paths P2/P1 use see a personal agent, not a hosted one.
    let (found, facts) = with_tenant_tx(&db.app, fx.workspace, move |conn| {
        let (workspace, owner, agent) = (fx.workspace, fx.owner, fx.kwak_claude);
        Box::pin(async move {
            let found = momo_agent::find_owner_personal_agent_in_tx(
                conn,
                workspace,
                owner,
                SubscriptionHarness::ClaudeCode,
            )
            .await?;
            let facts = momo_agent::load_agent_read_facts_in_tx(conn, workspace, &[agent]).await?;
            Ok((found, facts))
        })
    })
    .await
    .unwrap();
    let found = found.expect("the owner's personal agent");
    assert_eq!(
        (found.id, found.handle.as_str(), found.enabled),
        (fx.kwak_claude, "kwak-claude", true)
    );
    let facts = &facts[0];
    assert!(facts.personal.is_some(), "{facts:?}");
    assert_eq!(
        facts.host_online, None,
        "a personal agent has no Agent Port liveness"
    );
    assert_eq!(facts.subscription_harness, None);
    assert!(!facts.subscription_retired);
    db.finish().await;
}

#[tokio::test]
#[ignore = "needs a disposable PostgreSQL 18 superuser URL in DATABASE_URL"]
async fn the_old_lane_stays_shut_after_a_conversion_or_a_retirement() {
    let db = ProdDb::create().await;
    let fx = seed(&db).await;
    let connections: Vec<(Uuid, Uuid)> = {
        let claude_code_connection: Uuid =
            sqlx::query_scalar("SELECT id FROM hosted_agent_connection WHERE agent_member_id = $1")
                .bind(fx.claude_code)
                .fetch_one(&db.su)
                .await
                .unwrap();
        vec![
            (fx.kwak_claude, fx.kwak_connection),
            (fx.claude_code, claude_code_connection),
        ]
    };
    run(&db, &fx, Transition::Convert, "kwak-claude", true).await;
    run(&db, &fx, Transition::Retire, "claude-code", true).await;

    let regenerate = |connection: Uuid| {
        let workspace = fx.workspace;
        let app = db.app.clone();
        async move {
            with_tenant_tx(&app, workspace, move |conn| {
                Box::pin(async move {
                    // An administrator's 「다시 연결」: `expired` -> `pairing_pending`.
                    momo_auth::regenerate_pairing_in_tx(conn, workspace, connection)
                        .await
                        .map(|_| ())
                        .map_err(momo_db::DbError::from)
                })
            })
            .await
        }
    };
    for (agent, connection) in &connections {
        let error = regenerate(*connection)
            .await
            .expect_err(&format!("{agent}: regenerate must be refused"));
        assert!(
            error
                .to_string()
                .contains("cannot hold a live hosted connection"),
            "{error}"
        );
        let status: String =
            sqlx::query_scalar("SELECT status::text FROM hosted_agent_connection WHERE id = $1")
                .bind(connection)
                .fetch_one(&db.su)
                .await
                .unwrap();
        assert_eq!(status, "expired");
    }

    // The assertion above can fail: with the guard gone the same call revives the lane.
    sqlx::query("DROP TRIGGER hosted_agent_connection_closed_guard ON hosted_agent_connection")
        .execute(&db.su)
        .await
        .unwrap();
    regenerate(fx.kwak_connection)
        .await
        .expect("without migration 125's guard an administrator can re-arm the lane");
    db.finish().await;
}

#[tokio::test]
#[ignore = "needs a disposable PostgreSQL 18 superuser URL in DATABASE_URL"]
async fn a_second_run_is_a_noop_with_no_second_audit_row() {
    let db = ProdDb::create().await;
    let fx = seed(&db).await;
    run(&db, &fx, Transition::Convert, "kwak-claude", true).await;
    run(&db, &fx, Transition::Retire, "claude-code", true).await;
    let after_first = snapshot(&db.su, fx.workspace).await;

    for execute in [false, true] {
        let again = run(&db, &fx, Transition::Convert, "kwak-claude", execute).await;
        assert_eq!(again.verdict, Verdict::AlreadyDone, "{}", again.render());
        assert!(again.changes.audit_id.is_none());
        let again = run(&db, &fx, Transition::Retire, "claude-code", execute).await;
        assert_eq!(again.verdict, Verdict::AlreadyDone, "{}", again.render());
    }
    assert_eq!(
        after_first,
        snapshot(&db.su, fx.workspace).await,
        "a re-run wrote"
    );
    assert_eq!(
        audit_rows(&db.su, fx.workspace, AUDIT_CONVERTED)
            .await
            .len(),
        1
    );
    assert_eq!(
        audit_rows(&db.su, fx.workspace, AUDIT_RETIRED).await.len(),
        1
    );
    db.finish().await;
}

#[tokio::test]
#[ignore = "needs a disposable PostgreSQL 18 superuser URL in DATABASE_URL"]
async fn retire_suspends_marks_and_keeps_the_author_and_nobody_can_mention_it() {
    let db = ProdDb::create().await;
    let fx = seed(&db).await;
    let token = seed_live_token(&db.su, fx.workspace, fx.claude_code).await;
    let messages_before = authors(&db.su, fx.workspace).await;

    // Before: both agents are mention candidates.
    let candidates = |db: &ProdDb, workspace: Uuid, channel: Uuid| {
        let app = db.app.clone();
        async move {
            with_tenant_tx(&app, workspace, move |conn| {
                Box::pin(async move {
                    let all =
                        momo_agent::load_mention_candidates_in_tx(conn, workspace, channel).await?;
                    Ok(all.into_iter().map(|c| c.handle).collect::<Vec<_>>())
                })
            })
            .await
            .unwrap()
        }
    };
    let before = candidates(&db, fx.workspace, fx.channel).await;
    assert!(before.contains(&"claude-code".to_string()), "{before:?}");

    let report = run(&db, &fx, Transition::Retire, "claude-code", true).await;
    assert_eq!(report.verdict, Verdict::Proceed, "{}", report.render());
    assert!(report.changes.member_suspended && report.changes.marked);

    let (status, deleted, kind): (String, bool, String) = sqlx::query_as(
        "SELECT status::text, deleted_at IS NOT NULL, kind::text FROM member WHERE id = $1",
    )
    .bind(fx.claude_code)
    .fetch_one(&db.su)
    .await
    .unwrap();
    assert_eq!(
        (status.as_str(), deleted, kind.as_str()),
        ("suspended", false, "agent")
    );
    let (retired, personal, paused): (bool, bool, bool) = sqlx::query_as(
        "SELECT a.subscription_retired_at IS NOT NULL, a.personal_agent, p.paused \
           FROM agent a JOIN agent_profile p ON p.agent_member_id = a.member_id \
          WHERE a.member_id = $1",
    )
    .bind(fx.claude_code)
    .fetch_one(&db.su)
    .await
    .unwrap();
    assert_eq!((retired, personal, paused), (true, false, true));
    assert_eq!(
        messages_before,
        authors(&db.su, fx.workspace).await,
        "an author changed"
    );
    let revoked: bool =
        sqlx::query_scalar("SELECT revoked_at IS NOT NULL FROM token WHERE id = $1")
            .bind(token)
            .fetch_one(&db.su)
            .await
            .unwrap();
    assert!(revoked);
    let rows = audit_rows(&db.su, fx.workspace, AUDIT_RETIRED).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["handle"], "claude-code");

    // After: it is no longer a candidate for a mention, but the other agent still is.
    let after = candidates(&db, fx.workspace, fx.channel).await;
    assert!(!after.contains(&"claude-code".to_string()), "{after:?}");
    assert!(after.contains(&"kwak-claude".to_string()), "{after:?}");

    // The read contract carries the 「이전 구독 에이전트」 marker.
    let facts = with_tenant_tx(&db.app, fx.workspace, move |conn| {
        let (workspace, agent) = (fx.workspace, fx.claude_code);
        Box::pin(
            async move { momo_agent::load_agent_read_facts_in_tx(conn, workspace, &[agent]).await },
        )
    })
    .await
    .unwrap();
    assert!(facts[0].subscription_retired);
    db.finish().await;
}

#[tokio::test]
#[ignore = "needs a disposable PostgreSQL 18 superuser URL in DATABASE_URL"]
async fn the_tool_refuses_what_it_must_not_fake_and_writes_nothing() {
    let db = ProdDb::create().await;
    let fx = seed(&db).await;
    let before = snapshot(&db.su, fx.workspace).await;

    // Wrong tool for the shape.
    let wrong = run(&db, &fx, Transition::Convert, "claude-code", true).await;
    assert!(
        matches!(
            wrong.verdict,
            Verdict::Refused {
                code: "not_a_subscription_agent",
                ..
            }
        ),
        "{}",
        wrong.render()
    );
    let wrong = run(&db, &fx, Transition::Retire, "kwak-claude", true).await;
    assert!(
        matches!(
            wrong.verdict,
            Verdict::Refused {
                code: "not_a_hosted_workspace_agent",
                ..
            }
        ),
        "{}",
        wrong.render()
    );
    // A human's handle is "no agent", not a conversion target.
    let none = run_transition(
        &db.app,
        fx.workspace,
        Transition::Convert,
        "kwak",
        true,
        "x",
    )
    .await
    .unwrap();
    assert!(none.is_none());
    // Another tenant cannot see the row at all (RLS under the tenant transaction).
    let elsewhere = run_transition(
        &db.app,
        Uuid::new_v4(),
        Transition::Convert,
        "kwak-claude",
        true,
        "x",
    )
    .await
    .unwrap();
    assert!(elsewhere.is_none());

    // A credentialed connection needs the administrator's provider-side cleanup first.
    sqlx::query(
        "UPDATE hosted_agent_connection SET status = 'cleanup_pending', pairing_consumed_at = now(), \
                detected_at = now(), detected_by = $2 WHERE id = $1",
    )
    .bind(fx.kwak_connection)
    .bind(fx.owner)
    .execute(&db.su)
    .await
    .unwrap();
    let mid_snapshot = snapshot(&db.su, fx.workspace).await;
    let blocked = run(&db, &fx, Transition::Convert, "kwak-claude", true).await;
    assert!(
        matches!(
            blocked.verdict,
            Verdict::Refused {
                code: "connection_needs_admin_disconnect",
                ..
            }
        ),
        "{}",
        blocked.render()
    );
    assert_eq!(
        mid_snapshot,
        snapshot(&db.su, fx.workspace).await,
        "a refused run wrote"
    );
    assert_ne!(before, mid_snapshot);

    // An administrator-suspended agent is not this tool's to switch back on.
    sqlx::query("UPDATE hosted_agent_connection SET status = 'pairing_pending', pairing_consumed_at = NULL, detected_at = NULL, detected_by = NULL WHERE id = $1")
        .bind(fx.kwak_connection)
        .execute(&db.su)
        .await
        .unwrap();
    sqlx::query("UPDATE member SET status = 'suspended' WHERE id = $1")
        .bind(fx.kwak_claude)
        .execute(&db.su)
        .await
        .unwrap();
    let suspended = run(&db, &fx, Transition::Convert, "kwak-claude", true).await;
    assert!(
        matches!(
            suspended.verdict,
            Verdict::Refused {
                code: "member_not_active",
                ..
            }
        ),
        "{}",
        suspended.render()
    );
    assert!(audit_rows(&db.su, fx.workspace, AUDIT_CONVERTED)
        .await
        .is_empty());
    db.finish().await;
}

fn run_bin(args: &[&str], database_url: &str) -> (i32, String, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_momo-subscription-migrate"))
        .args(args)
        .env("DATABASE_URL", database_url)
        .output()
        .expect("spawn momo-subscription-migrate");
    (
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

#[tokio::test]
#[ignore = "needs a disposable PostgreSQL 18 superuser URL in DATABASE_URL"]
async fn the_binary_runs_only_as_the_application_role_and_executes_only_with_a_note() {
    let db = ProdDb::create().await;
    let fx = seed(&db).await;
    let ws = fx.workspace.to_string();
    let app_url = role_url(&db.name, "momo_app", "momo_app_dev_pw");
    let before = snapshot(&db.su, fx.workspace).await;

    // Dry-run is the default: exit 0, the plan on stdout, nothing written.
    let (code, out, err) = run_bin(
        &["convert", "--workspace", &ws, "--handle", "@kwak-claude"],
        &app_url,
    );
    assert_eq!(code, 0, "{out}\n{err}");
    assert!(
        out.contains("DRY-RUN") && out.contains("verdict: PROCEED"),
        "{out}"
    );
    assert!(err.contains("role: momo_app"), "{err}");
    assert_eq!(before, snapshot(&db.su, fx.workspace).await);

    // `--execute` without a note is a usage error, before any connection.
    let (code, _, err) = run_bin(
        &[
            "convert",
            "--workspace",
            &ws,
            "--handle",
            "kwak-claude",
            "--execute",
        ],
        &app_url,
    );
    assert_eq!(code, 2, "{err}");
    assert_eq!(before, snapshot(&db.su, fx.workspace).await);

    // No role that bypasses row-level security: the superuser and the BYPASSRLS
    // runtime roles are refused (exit 3) and write nothing.
    for (role, password) in [
        ("momo", "t3567pw_unused"),
        ("momo_relay", "momo_relay_dev_pw"),
        ("momo_worker", "momo_worker_dev_pw"),
        ("momo_notifier", "momo_notifier_dev_pw"),
    ] {
        let url = if role == "momo" {
            url_for(&db.name)
        } else {
            role_url(&db.name, role, password)
        };
        let (code, _, err) = run_bin(
            &[
                "convert",
                "--workspace",
                &ws,
                "--handle",
                "kwak-claude",
                "--execute",
                "--note",
                "승인",
            ],
            &url,
        );
        assert_eq!(code, 3, "{role}: {err}");
        assert!(err.contains("refusing to run as role"), "{role}: {err}");
    }
    assert_eq!(
        before,
        snapshot(&db.su, fx.workspace).await,
        "a refused role wrote"
    );

    // Executed as momo_app against the production grants: no `permission denied`.
    let (code, out, err) = run_bin(
        &[
            "convert",
            "--workspace",
            &ws,
            "--handle",
            "kwak-claude",
            "--execute",
            "--note",
            "성재 승인 2026-10-10",
        ],
        &app_url,
    );
    assert_eq!(code, 0, "{out}\n{err}");
    assert!(!err.contains("permission denied"), "{err}");
    let (code, out, err) = run_bin(
        &[
            "retire",
            "--workspace",
            &ws,
            "--handle",
            "claude-code",
            "--execute",
            "--note",
            "성재 승인 2026-10-10",
        ],
        &app_url,
    );
    assert_eq!(code, 0, "{out}\n{err}");
    assert_eq!(
        audit_rows(&db.su, fx.workspace, AUDIT_CONVERTED)
            .await
            .len(),
        1
    );
    assert_eq!(
        audit_rows(&db.su, fx.workspace, AUDIT_RETIRED).await.len(),
        1
    );

    // A re-run through the binary is a no-op that still exits 0.
    let (code, out, _) = run_bin(
        &[
            "convert",
            "--workspace",
            &ws,
            "--handle",
            "kwak-claude",
            "--execute",
            "--note",
            "again",
        ],
        &app_url,
    );
    assert_eq!(code, 0);
    assert!(out.contains("ALREADY_DONE"), "{out}");
    assert_eq!(
        audit_rows(&db.su, fx.workspace, AUDIT_CONVERTED)
            .await
            .len(),
        1
    );

    // A refusal exits 3 and names the code.
    let (code, out, _) = run_bin(
        &["retire", "--workspace", &ws, "--handle", "kwak-claude"],
        &app_url,
    );
    assert_eq!(code, 3, "{out}");
    db.finish().await;
}
