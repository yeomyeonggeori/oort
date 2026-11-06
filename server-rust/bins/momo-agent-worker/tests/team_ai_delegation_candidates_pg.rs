//! ADR-0201 증보 v4 P14-S5 (#5373) — the 「맡기기」 buttons list the team Hermes, against a real Postgres.
//!
//! The button is a person's click, not the helper's `ask_hermes` door: `delegation_candidates_in_tx`
//! names who the person may hand the request to. Connecting the team Hermes writes no hosted
//! connection and no channel membership (F2), so the old query — hosted agents only — never listed
//! it (F1). This file measures the new kind: a team Hermes (an agent pinned to the operator's env
//! link, `agent_provider_pin.kind = 'operator_env'`) is a candidate **only when all four hold**:
//! no connector owner · its call scope is open to the requester · not paused · a channel member.
//!
//! The function is called directly inside a tenant transaction, as `momo_app` (`rolsuper = false`,
//! `rolbypassrls = false`, so RLS is in force) and as `momo_worker` (`BYPASSRLS`, the role that
//! really calls it, so only the query's own predicates isolate tenants). DB-backed and `#[ignore]`d
//! like its siblings; run against an isolated `pgvector/pgvector:pg18`:
//!
//! ```text
//! DATABASE_URL=postgres://postgres:postgres@127.0.0.1:<port>/<db> \
//!   cargo test -p momo-agent-worker --test team_ai_delegation_candidates_pg \
//!     -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `a_team_hermes_that_meets_all_four_is_a_candidate_in_its_own_workspace_only` | drop the `operator_env` arm (hosted agents only again), or drop `m.id <> $2` (the pinned team AI lists itself). The RLS probe is the database's, not the query's: it fails if a joined tenant table loses its policy |
//! | `a_connector_owner_removes_the_team_hermes_from_the_buttons` | drop `a.connector_owner_human_id IS NULL`, or let the hosted arm judge a pinned agent (`pin.agent_member_id IS NULL` on that arm) |
//! | `a_call_scope_closed_to_the_requester_removes_the_team_hermes_from_the_buttons` | drop the `invocation_scope` clause, or accept any `owner_human_id` instead of comparing it with the requester |
//! | `a_paused_team_hermes_is_not_on_the_buttons` | drop `NOT ap.paused` |
//! | `a_team_hermes_outside_the_channel_is_not_on_the_buttons` | drop the `membership` predicate (or its `left_at IS NULL`) |
//! | `the_helpers_hand_off_line_asks_the_query_about_the_person_who_asked` | hand the worker's call a `Uuid` other than the requester's (every id there is a `Uuid`, so it compiles), or leave the requester out of the judgement |

use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use momo_agent::{create_agent_run_in_tx, NewAgentRun, RunTrigger};
use momo_agent_worker::provider::MockChatProvider;
use momo_agent_worker::{AgentWorker, WorkerConfig};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::{with_tenant_tx, PgPool};
use momo_messaging::{send_message_in_tx, NewMessage};
use momo_outbox::{emit_outbox, OutboxKind};
use momo_settings::{seal_bearer, upsert_link};
use serde_json::{json, Value};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

// --- harness (the shape of `team_ai_limits_conformance_pg.rs`, trimmed) --------

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to an isolated pgvector/pg18 DB")
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url())
        .await
        .expect("connect as superuser")
}

/// A pool for one of the bootstrap roles (`infra/rust/sql/bootstrap_roles.sql`).
async fn role_pool(role: &str, password_env: &str, default_password: &str) -> PgPool {
    let opts: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
    PgPoolOptions::new()
        .max_connections(4)
        .connect_with(opts.username(role).password(
            &std::env::var(password_env).unwrap_or_else(|_| default_password.to_string()),
        ))
        .await
        .unwrap_or_else(|error| panic!("connect as {role} (bootstrap_roles.sql): {error}"))
}

/// The API's role: `NOBYPASSRLS`, so row-level security is in force for every read below.
async fn momo_app_pool() -> PgPool {
    role_pool("momo_app", "MOMO_APP_PASSWORD", "momo_app_dev_pw").await
}

/// The worker's role: `BYPASSRLS`, the one that really calls `delegation_candidates_in_tx`.
async fn momo_worker_pool() -> PgPool {
    role_pool("momo_worker", "MOMO_WORKER_PASSWORD", "momo_worker_dev_pw").await
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
    panic!("psql client not found");
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().unwrap();
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
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1", "--no-psqlrc", "--quiet"])
        .arg("--single-transaction")
        .arg("-f")
        .arg(roles)
        .status()
        .expect("spawn psql");
    assert!(status.success(), "bootstrap_roles.sql failed");
    *ready = true;
}

/// A workspace with a plain member (the requester), an owner (a second person), the team AI
/// **provisioned by the shipped function**, a public channel all of them share — and a team Hermes
/// built the way `POST …/cohosted-agent/connect` builds it: a `member`, an `agent`, an
/// `agent_profile` (nothing paused) and the `operator_env` pin, plus a channel membership (a person
/// added it to the room). Every one of the four conditions holds until a test breaks one.
struct World {
    workspace_id: Uuid,
    /// The person who asked the helper — the requester.
    requester_id: Uuid,
    /// A second person: the owner of the workspace, and the owner a scope test gives an agent.
    owner_id: Uuid,
    /// The team AI (the helper itself).
    helper_id: Uuid,
    channel_id: Uuid,
    hermes_id: Uuid,
}

async fn world(su: &PgPool, app: &PgPool) -> World {
    let w = World {
        workspace_id: Uuid::new_v4(),
        requester_id: Uuid::new_v4(),
        owner_id: Uuid::new_v4(),
        helper_id: Uuid::nil(),
        channel_id: Uuid::new_v4(),
        hermes_id: Uuid::new_v4(),
    };
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(w.workspace_id)
        .bind(w.workspace_id.to_string())
        .execute(su)
        .await
        .expect("workspace");
    for (id, kind, display, handle, role) in [
        (w.owner_id, "human", "성재", None, "owner"),
        (w.requester_id, "human", "민수", None, "member"),
        (w.hermes_id, "agent", "Hermes", Some("hermes"), "member"),
    ] {
        sqlx::query(
            "INSERT INTO member (id, workspace_id, kind, status, display_name, handle) \
             VALUES ($1, $2, $3::member_kind, 'active', $4, $5)",
        )
        .bind(id)
        .bind(w.workspace_id)
        .bind(kind)
        .bind(display)
        .bind(handle.map_or_else(
            || format!("h{}", &id.simple().to_string()[..8]),
            str::to_string,
        ))
        .execute(su)
        .await
        .expect("member");
        sqlx::query(
            "INSERT INTO workspace_membership (workspace_id, member_id, role) \
             VALUES ($1, $2, $3::membership_role)",
        )
        .bind(w.workspace_id)
        .bind(id)
        .bind(role)
        .execute(su)
        .await
        .expect("workspace_membership");
    }
    sqlx::query("INSERT INTO channel (id, workspace_id, kind, name) VALUES ($1, $2, 'public', $3)")
        .bind(w.channel_id)
        .bind(w.workspace_id)
        .bind(format!("c5373-{}", &w.channel_id.simple().to_string()[..8]))
        .execute(su)
        .await
        .expect("channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(w.channel_id)
        .bind(w.workspace_id)
        .execute(su)
        .await
        .expect("channel_seq");

    // The team AI, provisioned exactly as the settings PATCH does.
    let (workspace_id, owner_id) = (w.workspace_id, w.owner_id);
    let helper_id = with_tenant_tx(app, workspace_id, move |conn| {
        Box::pin(async move {
            momo_workspace_actions::team_ai::enable_in_tx(conn, workspace_id, owner_id).await
        })
    })
    .await
    .expect("enable the team AI");

    // The team Hermes: what `connect` writes (ADR-0203 D4-3) — no tools, no hosted connection.
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url) \
         VALUES ($1, $2, 'hermes-agent', 'https://cohosted-agent.invalid/v1')",
    )
    .bind(w.hermes_id)
    .bind(w.workspace_id)
    .execute(su)
    .await
    .expect("hermes agent");
    sqlx::query(
        "INSERT INTO agent_profile (workspace_id, agent_member_id, paused, updated_by) \
         VALUES ($1, $2, false, $3)",
    )
    .bind(w.workspace_id)
    .bind(w.hermes_id)
    .bind(w.owner_id)
    .execute(su)
    .await
    .expect("hermes profile");
    sqlx::query(
        "INSERT INTO agent_provider_pin (agent_member_id, workspace_id, kind, pinned_by) \
         VALUES ($1, $2, 'operator_env', $3)",
    )
    .bind(w.hermes_id)
    .bind(w.workspace_id)
    .bind(w.owner_id)
    .execute(su)
    .await
    .expect("operator_env pin");
    for member in [w.owner_id, w.requester_id, helper_id, w.hermes_id] {
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)",
        )
        .bind(w.workspace_id)
        .bind(w.channel_id)
        .bind(member)
        .execute(su)
        .await
        .expect("membership");
    }
    World { helper_id, ..w }
}

/// What the helper's worker would put on the 「맡기기」 buttons for `requester`, read in a tenant
/// transaction of `pool`'s role with the GUC set to `guc_workspace` and the arguments naming
/// `args`' workspace, helper and channel. (They are the same workspace unless a test wants them
/// apart.)
async fn buttons_as(
    pool: &PgPool,
    guc_workspace: Uuid,
    args: &World,
    requester: Uuid,
) -> Vec<Uuid> {
    let (workspace_id, helper_id, channel_id) =
        (args.workspace_id, args.helper_id, args.channel_id);
    with_tenant_tx(pool, guc_workspace, move |conn| {
        Box::pin(async move {
            Ok(
                momo_workspace_actions::team_ai::delegation_candidates_in_tx(
                    conn,
                    workspace_id,
                    helper_id,
                    channel_id,
                    requester,
                )
                .await?
                .into_iter()
                .map(|(id, _handle, _display_name)| id)
                .collect::<Vec<_>>(),
            )
        })
    })
    .await
    .expect("delegation candidates")
}

/// The requester's buttons in their own workspace.
async fn buttons(pool: &PgPool, w: &World) -> Vec<Uuid> {
    buttons_as(pool, w.workspace_id, w, w.requester_id).await
}

/// Run one statement as the superuser — how a test breaks (or restores) one condition.
async fn exec(su: &PgPool, sql: &str, binds: &[Uuid]) {
    let mut query = sqlx::query(sql);
    for bind in binds {
        query = query.bind(*bind);
    }
    let done = query
        .execute(su)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
    assert_eq!(done.rows_affected(), 1, "exactly one row changed: {sql}");
}

// --- behaviour -------------------------------------------------------------------------------

/// All four hold → the team Hermes is on the buttons, and only in its own workspace. Two fully
/// valid tenants, read as the non-bypass role (RLS) and as the worker's `BYPASSRLS` role (the query's
/// own predicates). The RLS probe names workspace B while the transaction is workspace A's: the
/// non-bypass role must list nothing — and the worker's role, same arguments, lists B's Hermes, so
/// the empty answer is RLS's and not an accident of the arguments.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn a_team_hermes_that_meets_all_four_is_a_candidate_in_its_own_workspace_only() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let worker = momo_worker_pool().await;
    let (a, b) = (world(&su, &app).await, world(&su, &app).await);

    // The measurement is only worth anything under the roles it claims.
    let non_bypass: bool = sqlx::query_scalar(
        "SELECT NOT rolsuper AND NOT rolbypassrls FROM pg_roles WHERE rolname = current_user",
    )
    .fetch_one(&app)
    .await
    .unwrap();
    assert!(
        non_bypass,
        "momo_app must be a non-superuser without BYPASSRLS"
    );
    let bypass: bool =
        sqlx::query_scalar("SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user")
            .fetch_one(&worker)
            .await
            .unwrap();
    assert!(
        bypass,
        "momo_worker is the BYPASSRLS poller this path really runs as"
    );

    for (role, pool) in [("momo_app", &app), ("momo_worker", &worker)] {
        assert_eq!(
            buttons(pool, &a).await,
            vec![a.hermes_id],
            "{role}: workspace A lists its own Hermes — and not B's"
        );
        assert_eq!(
            buttons(pool, &b).await,
            vec![b.hermes_id],
            "{role}: workspace B lists its own Hermes — and not A's"
        );
    }

    // The RLS probe: transaction = workspace A, arguments = workspace B.
    assert!(
        buttons_as(&app, a.workspace_id, &b, b.requester_id)
            .await
            .is_empty(),
        "non-bypass role: A's transaction cannot read B's rows even when the caller names B"
    );
    assert_eq!(
        buttons_as(&worker, a.workspace_id, &b, b.requester_id).await,
        vec![b.hermes_id],
        "anti-vacuity: the same arguments under BYPASSRLS do list B's Hermes"
    );

    // The helper never lists itself, even pinned to the operator's link like the Hermes.
    exec(
        &su,
        "INSERT INTO agent_provider_pin (agent_member_id, workspace_id, kind, pinned_by) \
         VALUES ($1, $2, 'operator_env', $3)",
        &[a.helper_id, a.workspace_id, a.owner_id],
    )
    .await;
    assert_eq!(
        buttons(&app, &a).await,
        vec![a.hermes_id],
        "the team AI is not a candidate for its own hand-off"
    );
}

/// Condition 1: an agent that runs one person's connected apps answers only that person — it is no
/// candidate for anyone (ADR-0113 증보 2 E3; the 「커넥터 시험」 Hermes is exactly such an agent). A
/// stray hosted connection on the pinned agent must not bring it back.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn a_connector_owner_removes_the_team_hermes_from_the_buttons() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let w = world(&su, &app).await;
    assert_eq!(
        buttons(&app, &w).await,
        vec![w.hermes_id],
        "anti-vacuity: all four hold"
    );

    // Migration 139: the connector owner is the agent's owner.
    exec(
        &su,
        "UPDATE agent SET owner_human_id = $3, connector_owner_human_id = $3 \
          WHERE workspace_id = $1 AND member_id = $2",
        &[w.workspace_id, w.hermes_id, w.owner_id],
    )
    .await;
    assert!(
        buttons(&app, &w).await.is_empty(),
        "a connector owner is set: no candidate for a person who is not the owner"
    );
    assert!(
        buttons_as(&app, w.workspace_id, &w, w.owner_id)
            .await
            .is_empty(),
        "…and none for the owner either (v1 closes it)"
    );

    // The same agent with an active hosted connection: the hosted arm must not judge a pinned agent.
    activate_hosted_connection(&su, &w, w.hermes_id).await;
    assert!(
        buttons(&app, &w).await.is_empty(),
        "a hosted connection on the pinned agent does not skip condition 1"
    );
}

/// Condition 2: the call scope is open to the **requester**. An `owner_only` agent answers only its
/// owner: the requester who is not the owner gets no button, the owner does (so the clause reads
/// the requester, it is not a blanket refusal of `owner_only`).
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn a_call_scope_closed_to_the_requester_removes_the_team_hermes_from_the_buttons() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let w = world(&su, &app).await;
    assert_eq!(
        buttons(&app, &w).await,
        vec![w.hermes_id],
        "anti-vacuity: all four hold"
    );

    // The pin came first (migration 136 refuses a pin on an `owner_only` agent); the scope closes
    // after it, harness and owner together (migration 089/117's shape CHECK).
    exec(
        &su,
        "UPDATE agent SET invocation_scope = 'owner_only', subscription_harness = 'codex', \
                          owner_human_id = $3 \
          WHERE workspace_id = $1 AND member_id = $2",
        &[w.workspace_id, w.hermes_id, w.owner_id],
    )
    .await;
    assert!(
        buttons(&app, &w).await.is_empty(),
        "owner_only, and the requester is not the owner: no candidate"
    );
    assert_eq!(
        buttons_as(&app, w.workspace_id, &w, w.owner_id).await,
        vec![w.hermes_id],
        "the scope is open to its own owner: the same agent is a candidate for them"
    );
}

/// Condition 3: a paused agent takes no mention, so it is no button.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn a_paused_team_hermes_is_not_on_the_buttons() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let w = world(&su, &app).await;
    assert_eq!(
        buttons(&app, &w).await,
        vec![w.hermes_id],
        "anti-vacuity: all four hold"
    );

    let pause = |paused: bool| {
        let su = su.clone();
        let (workspace_id, hermes_id) = (w.workspace_id, w.hermes_id);
        async move {
            let done = sqlx::query(
                "UPDATE agent_profile SET paused = $3 WHERE workspace_id = $1 AND agent_member_id = $2",
            )
            .bind(workspace_id)
            .bind(hermes_id)
            .bind(paused)
            .execute(&su)
            .await
            .expect("pause flag");
            assert_eq!(done.rows_affected(), 1);
        }
    };
    pause(true).await;
    assert!(buttons(&app, &w).await.is_empty(), "paused: no candidate");
    pause(false).await;
    assert_eq!(
        buttons(&app, &w).await,
        vec![w.hermes_id],
        "the pause flag alone moved it: un-paused, it is back"
    );
}

/// Condition 4: the button posts an ordinary @mention, and a mention reaches an agent only in a room
/// it is in. Left the channel → no candidate; back in → candidate.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn a_team_hermes_outside_the_channel_is_not_on_the_buttons() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let w = world(&su, &app).await;
    assert_eq!(
        buttons(&app, &w).await,
        vec![w.hermes_id],
        "anti-vacuity: all four hold"
    );

    exec(
        &su,
        "UPDATE membership SET left_at = now() \
          WHERE workspace_id = $1 AND channel_id = $2 AND member_id = $3",
        &[w.workspace_id, w.channel_id, w.hermes_id],
    )
    .await;
    assert!(
        buttons(&app, &w).await.is_empty(),
        "left the channel: no candidate"
    );
    exec(
        &su,
        "UPDATE membership SET left_at = NULL \
          WHERE workspace_id = $1 AND channel_id = $2 AND member_id = $3",
        &[w.workspace_id, w.channel_id, w.hermes_id],
    )
    .await;
    assert_eq!(
        buttons(&app, &w).await,
        vec![w.hermes_id],
        "the membership alone moved it: back in the room, it is back"
    );
}

/// An active, proved hosted connection on `agent` — the fixture of
/// `team_ai_limits_conformance_pg.rs::make_hand_off_candidate` (an agent the 「맡기기」 button has
/// always listed), minus the profile row the world already wrote.
async fn activate_hosted_connection(su: &PgPool, w: &World, agent: Uuid) {
    let (connection_id, token_id) = (Uuid::new_v4(), Uuid::new_v4());
    sqlx::query(
        "UPDATE agent SET model='hosted-agent', base_url='https://hosted-agent.invalid/disabled', \
           config=jsonb_build_object('execution_mode','hosted_dial_in') \
         WHERE workspace_id=$1 AND member_id=$2",
    )
    .bind(w.workspace_id)
    .bind(agent)
    .execute(su)
    .await
    .expect("seal hosted sentinel");
    sqlx::query(
        "INSERT INTO hosted_agent_connection( \
           id,workspace_id,agent_member_id,status,pairing_challenge_hash,pairing_expires_at, \
           pairing_consumed_at,detected_at,detected_by,approved_scopes,created_by \
         ) VALUES ($1,$2,$3,'detected',digest($4,'sha256'),now()+interval '1 hour', \
           now(),now(),$3,'{}'::text[],$5)",
    )
    .bind(connection_id)
    .bind(w.workspace_id)
    .bind(agent)
    .bind(format!("candidates-{connection_id}"))
    .bind(w.owner_id)
    .execute(su)
    .await
    .expect("detected hosted connection");
    let activated: i64 = sqlx::query_scalar(
        "WITH inserted AS (INSERT INTO token(id,workspace_id,actor_member_id,kind,token_hash,scopes,label, \
          credential_class,hosted_connection_id,audience,created_by) \
         VALUES ($1,$2,$3,'agent_bearer',digest($6,'sha256'), \
          ARRAY['agent:port:connect'],'candidates fixture','hosted_active',$4, \
          '/v1/mcp/agent-port',$5) RETURNING id), \
         updated AS (UPDATE hosted_agent_connection SET status='active', \
          active_token_id=(SELECT id FROM inserted),confirmed_by=$5,confirmed_at=now(), \
          approved_scopes=ARRAY['agent:port:connect'],proved_at=now(),proved_by=$3 \
          WHERE workspace_id=$2 AND id=$4 RETURNING id) \
         SELECT count(*) FROM updated",
    )
    .bind(token_id)
    .bind(w.workspace_id)
    .bind(agent)
    .bind(connection_id)
    .bind(w.owner_id)
    .bind(format!("candidates-token-{token_id}"))
    .fetch_one(su)
    .await
    .expect("activate the hosted fixture");
    assert_eq!(activated, 1, "the hosted connection is active");
}

// --- the worker's call site ------------------------------------------------------------------

const MASTER_KEY: &str = "conformance-5373-master";
const HEAD_URL: &str = "https://team-gw.example/v1";
const HEAD_BEARER: &str = "sk-head-5373-a1b2c3";

/// The team link the helper's turn needs to be a turn at all (an instance table: emptied first, so
/// nothing another file left behind answers for it).
async fn seed_team_link(su: &PgPool, owner: Uuid) {
    for table in [
        "provider_default_ai",
        "provider_link_chain",
        "provider_link",
    ] {
        sqlx::query(&format!("DELETE FROM {table}"))
            .execute(su)
            .await
            .expect("empty instance table");
    }
    let mut conn = su.acquire().await.unwrap();
    let head = seal_bearer(HEAD_BEARER, MASTER_KEY).unwrap();
    upsert_link(&mut conn, HEAD_URL, &head, "external-hermes", owner)
        .await
        .expect("team link");
}

/// A mention of the team AI by `author`, exactly as the send route freezes it (the shape of
/// `team_ai_limits_conformance_pg.rs::enqueue`, with the author a parameter).
async fn enqueue(pool: &PgPool, w: &World, author: Uuid, text: &str) -> Uuid {
    let (workspace_id, channel_id, agent) = (w.workspace_id, w.channel_id, w.helper_id);
    let text = text.to_string();
    with_tenant_tx(pool, workspace_id, move |conn| {
        let text = text.clone();
        Box::pin(async move {
            let sent = send_message_in_tx(
                conn,
                workspace_id,
                NewMessage::text(channel_id, author, text.clone()),
            )
            .await?;
            let created = create_agent_run_in_tx(
                conn,
                workspace_id,
                NewAgentRun {
                    channel_id,
                    trigger: RunTrigger::Mention {
                        message_id: sent.message.id,
                        agent_member_id: agent,
                    },
                    parent_run_id: None,
                    max_steps: 50,
                    depth: 0,
                    input: json!({"schema": "momo.agent_run.input.v0", "surface": "mention",
                                  "prompt": text, "depth": 0}),
                },
            )
            .await?;
            emit_outbox(
                &mut *conn,
                workspace_id,
                OutboxKind::AgentJob,
                "publish",
                &json!({
                    "run_id": created.id,
                    "workspace_id": workspace_id,
                    "channel_id": channel_id,
                    "agent_member_id": agent,
                    "author_member_id": author,
                    "trigger_message_id": sent.message.id,
                    "trigger_message_seq": sent.message.seq,
                    "model": "team-ai-default",
                    "model_source": "instance_default",
                    "prompt": text,
                    "recent_messages": [{
                        "message_id": sent.message.id, "channel_id": channel_id,
                        "seq": sent.message.seq, "author_member_id": author,
                        "author_kind": "human", "author_display": "x",
                        "type": "text", "body": text,
                    }],
                    "enabled_tools": ["workspace_action_propose"],
                    "max_output_tokens": 256,
                    "depth": 0,
                    "delivery": "worker",
                    "created_from": "server.message_send.agent_mention.v0",
                }),
                Some(agent),
            )
            .await
            .map_err(momo_db::DbError::from)?;
            Ok(created.id)
        })
    })
    .await
    .expect("enqueue mention")
}

/// The member ids on the buttons of the helper's last line in the channel, and the run's end.
async fn last_hand_off(
    su: &PgPool,
    w: &World,
    run_id: Uuid,
) -> (String, Option<String>, Vec<String>) {
    let (status, error): (String, Option<Value>) =
        sqlx::query_as("SELECT status::text, error FROM agent_run WHERE id = $1")
            .bind(run_id)
            .fetch_one(su)
            .await
            .unwrap();
    let props: Value = sqlx::query_scalar(
        "SELECT props FROM message WHERE workspace_id = $1 AND author_member_id = $2 \
          ORDER BY seq DESC LIMIT 1",
    )
    .bind(w.workspace_id)
    .bind(w.helper_id)
    .fetch_one(su)
    .await
    .expect("the helper's last line");
    assert_eq!(
        props["kind"], "team_ai.delegate.v1",
        "the last line is the hand-off"
    );
    let candidates = props["delegate"]["candidates"]
        .as_array()
        .expect("the hand-off buttons")
        .iter()
        .map(|c| c["member_id"].as_str().expect("member_id").to_string())
        .collect();
    (
        status,
        error.and_then(|e| e["code"].as_str().map(str::to_string)),
        candidates,
    )
}

/// The worker passes the **requester** to the query. Every id in that call is a `Uuid`, so a call
/// that handed over the wrong one would still compile and every direct call above would stay green.
/// The helper's turn is stopped by a daily token limit before the model (the one place the buttons
/// are drawn from); the Hermes answers only its owner. The owner who asks gets the Hermes button, the
/// teammate who asks gets none.
#[tokio::test]
#[ignore = "requires an isolated PostgreSQL 18 (see module docs)"]
async fn the_helpers_hand_off_line_asks_the_query_about_the_person_who_asked() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let worker_pool = momo_worker_pool().await;
    let w = world(&su, &app).await;
    seed_team_link(&su, w.owner_id).await;
    // The Hermes is the owner's alone — pin first, scope second (migration 136).
    exec(
        &su,
        "UPDATE agent SET invocation_scope = 'owner_only', subscription_harness = 'codex', \
                          owner_human_id = $3 \
          WHERE workspace_id = $1 AND member_id = $2",
        &[w.workspace_id, w.hermes_id, w.owner_id],
    )
    .await;
    // The team's daily limit is already reached: both turns end at the hand-off, no model call.
    sqlx::query(
        "UPDATE workspace SET settings = settings || \
           jsonb_build_object('team_ai_limits', '{\"dailyTokens\": 1000}'::jsonb) WHERE id = $1",
    )
    .bind(w.workspace_id)
    .execute(&su)
    .await
    .expect("team_ai_limits");
    sqlx::query(
        "INSERT INTO usage_ledger (workspace_id, agent_member_id, channel_id, model, \
                                   prompt_tokens, completion_tokens, cost_micro_usd, created_at) \
         VALUES ($1, $2, $3, 'candidates-test-model', 1000, 0, 0, now())",
    )
    .bind(w.workspace_id)
    .bind(w.helper_id)
    .bind(w.channel_id)
    .execute(&su)
    .await
    .expect("ledger row");

    let provider = Arc::new(MockChatProvider::echo());
    let mut config = WorkerConfig::for_target(database_url());
    config.claim_batch_size = 10;
    config.provider_link_master_key = Some(MASTER_KEY.to_string());
    let worker = AgentWorker::new(worker_pool.clone(), provider.clone(), config);

    for (asker, asker_is_owner) in [(w.requester_id, false), (w.owner_id, true)] {
        let run = enqueue(&worker_pool, &w, asker, "이거 맡길 수 있어요?").await;
        for _ in 0..8 {
            if worker.drain_once().await.expect("drain").claimed == 0 {
                break;
            }
        }
        let (status, code, candidates) = last_hand_off(&su, &w, run).await;
        assert_eq!(
            (status.as_str(), code.as_deref()),
            ("failed", Some("over_budget")),
            "anti-vacuity: the turn ended at the team's limit, on the hand-off line"
        );
        let hermes = vec![w.hermes_id.to_string()];
        assert_eq!(
            candidates,
            if asker_is_owner { hermes } else { Vec::new() },
            "the buttons are judged for the person who asked (owner: {asker_is_owner})"
        );
    }
    assert!(
        provider.calls().is_empty(),
        "the limit stopped both turns before the model"
    );
}
