//! HAP-E5 producer conformance (ADR-0162 D3/D6, migration 071).
//!
//! HAP-E4 shipped the inbox with **no producer**, so its own suite could only
//! exercise the `message` kind. This binary is the other two kinds plus the two
//! closures migration 071 adds, and it is deliberately adversarial: each case
//! writes the row a confused or malicious producer *would* write and proves the
//! database refuses it.
//!
//! The verifier supplies a migrated disposable PG18 database and the canonical
//! `momo_app` role; this binary never accepts a production DB as a target.

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{run_migrations, SeedMode};
use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_messaging::{
    append_job_reference_in_tx, append_run_reference_in_tx, hosted_inbox_recipients_in_tx,
    list_hosted_inbox_in_tx, HostedInboxReadError,
};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set disposable PG18 DATABASE_URL")
}

async fn pools() -> (PgPool, PgPool) {
    ensure_schema_and_roles();
    let url = database_url();
    let su = PgPoolOptions::new()
        .max_connections(8)
        .connect(&url)
        .await
        .expect("superuser pool");
    let opts: PgConnectOptions = url
        .parse::<PgConnectOptions>()
        .expect("postgres URL")
        .username("momo_app")
        .password(
            &std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string()),
        );
    let app = PgPoolOptions::new()
        .max_connections(16)
        .connect_with(opts)
        .await
        .expect("momo_app pool");
    (su, app)
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
    let mut ready = READY.lock().expect("schema lock");
    if *ready {
        return;
    }
    let migrations = std::env::var_os("HOSTED_INBOX_MIGRATIONS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../server/Migrations"
            ))
        });
    run_migrations(&database_url(), &migrations, SeedMode::None).expect("apply all migrations");
    let roles = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/e2e/bootstrap_roles.sql"
    ));
    let status = Command::new(resolve_psql())
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(roles)
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed");
    *ready = true;
}

struct Fixture {
    workspace: Uuid,
    human: Uuid,
    agent: Uuid,
    other_agent: Uuid,
    connection: Uuid,
    token: Uuid,
    channel: Uuid,
    other_channel: Uuid,
}

async fn seed(su: &PgPool) -> Fixture {
    let f = Fixture {
        workspace: Uuid::new_v4(),
        human: Uuid::new_v4(),
        agent: Uuid::new_v4(),
        other_agent: Uuid::new_v4(),
        connection: Uuid::new_v4(),
        token: Uuid::new_v4(),
        channel: Uuid::new_v4(),
        other_channel: Uuid::new_v4(),
    };
    sqlx::query("INSERT INTO workspace(id,slug,name) VALUES($1,$2,$2)")
        .bind(f.workspace)
        .bind(f.workspace.to_string())
        .execute(su)
        .await
        .unwrap();
    for (id, kind) in [
        (f.human, "human"),
        (f.agent, "agent"),
        (f.other_agent, "agent"),
    ] {
        sqlx::query(
            "INSERT INTO member(id,workspace_id,kind,status,display_name,handle) \
             VALUES($1,$2,$3::member_kind,'active',$4,$4)",
        )
        .bind(id)
        .bind(f.workspace)
        .bind(kind)
        .bind(id.to_string())
        .execute(su)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO workspace_membership(workspace_id,member_id,role) VALUES($1,$2,'member')",
        )
        .bind(f.workspace)
        .bind(id)
        .execute(su)
        .await
        .unwrap();
    }
    for agent in [f.agent, f.other_agent] {
        sqlx::query(
            "INSERT INTO agent(member_id,workspace_id,model,base_url,config) \
             VALUES($1,$2,'hosted-agent','https://hosted-agent.invalid/disabled', \
                    '{\"execution_mode\":\"hosted_dial_in\"}'::jsonb)",
        )
        .bind(agent)
        .bind(f.workspace)
        .execute(su)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agent_profile(agent_member_id,workspace_id,updated_by,paused) \
             VALUES($1,$2,$3,false)",
        )
        .bind(agent)
        .bind(f.workspace)
        .bind(f.human)
        .execute(su)
        .await
        .unwrap();
    }
    for (index, channel) in [f.channel, f.other_channel].iter().enumerate() {
        sqlx::query("INSERT INTO channel(id,workspace_id,kind,name) VALUES($1,$2,'public',$3)")
            .bind(channel)
            .bind(f.workspace)
            .bind(format!("producer-{index}-{}", f.workspace))
            .execute(su)
            .await
            .unwrap();
        sqlx::query("INSERT INTO channel_seq(channel_id,workspace_id,last_seq) VALUES($1,$2,0)")
            .bind(channel)
            .bind(f.workspace)
            .execute(su)
            .await
            .unwrap();
        for member in [f.human, f.agent, f.other_agent] {
            sqlx::query(
                "INSERT INTO membership(workspace_id,channel_id,member_id) VALUES($1,$2,$3)",
            )
            .bind(f.workspace)
            .bind(channel)
            .bind(member)
            .execute(su)
            .await
            .unwrap();
        }
    }
    sqlx::query(
        "INSERT INTO hosted_agent_connection( \
           id,workspace_id,agent_member_id,status,pairing_consumed_at,detected_at,detected_by, \
           confirmed_by,confirmed_at,approved_channel_ids,approved_scopes,created_by) \
         VALUES($1,$2,$3,'detected',now(),now(),$4,$4,now(),$5, \
           ARRAY['agent:port:connect','agent:inbox:read','agent:jobs:read']::text[],$4)",
    )
    .bind(f.connection)
    .bind(f.workspace)
    .bind(f.agent)
    .bind(f.human)
    .bind(vec![f.channel, f.other_channel])
    .execute(su)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO token(id,workspace_id,kind,actor_member_id,token_hash,scopes,created_by, \
                           credential_class,hosted_connection_id,audience) \
         VALUES($1,$2,'agent_bearer',$3,$4, \
           ARRAY['agent:port:connect','agent:inbox:read','agent:jobs:read']::text[],$5, \
           'hosted_active',$6,'/v1/mcp/agent-port')",
    )
    .bind(f.token)
    .bind(f.workspace)
    .bind(f.agent)
    .bind(Uuid::new_v4().as_bytes().repeat(2))
    .bind(f.human)
    .bind(f.connection)
    .execute(su)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE hosted_agent_connection SET status='active',active_token_id=$3, \
           proved_at=now(),proved_by=$4 WHERE workspace_id=$1 AND id=$2",
    )
    .bind(f.workspace)
    .bind(f.connection)
    .bind(f.token)
    .bind(f.agent)
    .execute(su)
    .await
    .unwrap();
    f
}

async fn insert_run(su: &PgPool, f: &Fixture, agent: Uuid, channel: Uuid) -> Uuid {
    let run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run(id,workspace_id,agent_member_id,channel_id,idempotency_key) \
         VALUES($1,$2,$3,$4,$5)",
    )
    .bind(run)
    .bind(f.workspace)
    .bind(agent)
    .bind(channel)
    .bind(run.to_string())
    .execute(su)
    .await
    .unwrap();
    run
}

/// A `gateway` `agent_job` outbox row, exactly as `emit_outbox` writes one.
async fn insert_job(su: &PgPool, f: &Fixture, agent: Uuid, run: Uuid) -> i64 {
    sqlx::query_scalar(
        "INSERT INTO outbox(workspace_id,kind,status,method,payload,partition_key) \
         VALUES($1,'agent_job','pending','gateway', \
           jsonb_build_object('run_id',upper($2::text),'agent_member_id',upper($3::text)),$3) \
         RETURNING id",
    )
    .bind(f.workspace)
    .bind(run.to_string())
    .bind(agent)
    .fetch_one(su)
    .await
    .unwrap()
}

/// The wake **broadcast** the managed mention path emits on the *agent's*
/// partition key — the row the review measured and the reason 071 exists.
async fn insert_wake_broadcast(su: &PgPool, f: &Fixture, agent: Uuid, run: Uuid) -> i64 {
    sqlx::query_scalar(
        "INSERT INTO outbox(workspace_id,kind,status,method,payload,partition_key) \
         VALUES($1,'broadcast','pending','publish', \
           jsonb_build_object('run_id',upper($2::text),'agent_member_id',upper($3::text)),$3) \
         RETURNING id",
    )
    .bind(f.workspace)
    .bind(run.to_string())
    .bind(agent)
    .fetch_one(su)
    .await
    .unwrap()
}

/// Raw insert as the runtime role, bypassing the producer helpers — this is how
/// an adversarial or confused producer would write the row.
async fn raw_event(
    app: &PgPool,
    f: &Fixture,
    kind: &str,
    channel: Option<Uuid>,
    outbox_id: Option<i64>,
    run: Option<Uuid>,
    seq: i64,
) -> Result<(), DbError> {
    let workspace = f.workspace;
    let agent = f.agent;
    let connection = f.connection;
    let kind = kind.to_string();
    with_tenant_tx(app, workspace, move |conn| {
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO hosted_agent_inbox_event \
                   (workspace_id,agent_member_id,connection_id,inbox_seq,event_kind, \
                    source_channel_id,source_outbox_id,source_run_id) \
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
            )
            .bind(workspace)
            .bind(agent)
            .bind(connection)
            .bind(seq)
            .bind(kind)
            .bind(channel)
            .bind(outbox_id)
            .bind(run)
            .execute(conn)
            .await
            .map(|_| ())
            .map_err(DbError::from)
        })
    })
    .await
}

#[tokio::test]
#[ignore = "needs verifier-owned disposable PG18 + migrated schema + momo_app role"]
async fn hosted_inbox_job_and_run_kinds_are_bound_to_one_piece_of_work() {
    let (su, app) = pools().await;
    let f = seed(&su).await;
    let workspace = f.workspace;
    let agent = f.agent;
    let connection = f.connection;
    let channel = f.channel;

    // ---- happy path: one job reference, one run reference ------------------
    let run = insert_run(&su, &f, f.agent, f.channel).await;
    let job = insert_job(&su, &f, f.agent, run).await;
    let appended = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            append_job_reference_in_tx(conn, workspace, agent, connection, channel, job, run).await
        })
    })
    .await
    .unwrap();
    assert_eq!(appended, Some(1));

    // Replay is idempotent and consumes no sequence — the same rule the
    // message append keeps.
    let replay = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            append_job_reference_in_tx(conn, workspace, agent, connection, channel, job, run).await
        })
    })
    .await
    .unwrap();
    assert_eq!(replay, Some(1));

    let run_reference = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            append_run_reference_in_tx(conn, workspace, agent, connection, channel, run).await
        })
    })
    .await
    .unwrap();
    assert_eq!(run_reference, Some(2));
    let run_replay = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            append_run_reference_in_tx(conn, workspace, agent, connection, channel, run).await
        })
    })
    .await
    .unwrap();
    assert_eq!(run_replay, Some(2), "the agent_run dedupe index holds");

    let page = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            list_hosted_inbox_in_tx(conn, workspace, agent, connection, None, 10, "test-key").await
        })
    })
    .await
    .unwrap()
    .unwrap();
    let kinds: Vec<&str> = page
        .events
        .iter()
        .map(|event| event.event_kind.as_str())
        .collect();
    assert_eq!(kinds, vec!["agent_job", "agent_run"]);
    assert_eq!(page.events[0].source_run_id, Some(run));
    assert_eq!(page.events[0].source_outbox_id, Some(job));
    assert_eq!(page.events[1].source_outbox_id, None);

    // ---- M1 (a): the reference cannot name another outbox KIND -------------
    let wake = insert_wake_broadcast(&su, &f, f.agent, run).await;
    let kind_confused = raw_event(
        &app,
        &f,
        "agent_job",
        Some(f.channel),
        Some(wake),
        Some(run),
        900,
    )
    .await;
    assert!(
        kind_confused.is_err(),
        "a wake broadcast on the agent's partition key must not pass as its job"
    );

    // ---- M1 (b): the job and the run must be the SAME work -----------------
    let other_run = insert_run(&su, &f, f.agent, f.channel).await;
    let mismatched_pair = raw_event(
        &app,
        &f,
        "agent_job",
        Some(f.channel),
        Some(job),
        Some(other_run),
        901,
    )
    .await;
    assert!(
        mismatched_pair.is_err(),
        "a job row paired with another run of the same agent must be refused"
    );

    // …including the cross-channel variant the review measured: same agent,
    // same workspace, a run in a different channel.
    let other_channel_run = insert_run(&su, &f, f.agent, f.other_channel).await;
    let other_channel_job = insert_job(&su, &f, f.agent, other_channel_run).await;
    let cross_channel = raw_event(
        &app,
        &f,
        "agent_job",
        Some(f.channel),
        Some(other_channel_job),
        Some(other_channel_run),
        902,
    )
    .await;
    assert!(
        cross_channel.is_err(),
        "the run FK binds the channel; a reference cannot relabel where the work lives"
    );

    // ---- the job must belong to THIS agent ---------------------------------
    let foreign_run = insert_run(&su, &f, f.other_agent, f.channel).await;
    let foreign_job = insert_job(&su, &f, f.other_agent, foreign_run).await;
    let foreign = raw_event(
        &app,
        &f,
        "agent_job",
        Some(f.channel),
        Some(foreign_job),
        Some(foreign_run),
        903,
    )
    .await;
    assert!(
        foreign.is_err(),
        "another agent's job must not be deliverable to this connection"
    );

    // ---- the shape CHECK is still the outer gate ---------------------------
    for (kind, channel, outbox, run_id) in [
        // agent_job without a run half
        ("agent_job", Some(f.channel), Some(job), None),
        // agent_job without an outbox half
        ("agent_job", Some(f.channel), None, Some(run)),
        // agent_run may not carry an outbox reference at all
        ("agent_run", Some(f.channel), Some(job), Some(run)),
        // neither kind may drop the channel
        ("agent_run", None, None, Some(run)),
    ] {
        let refused = raw_event(&app, &f, kind, channel, outbox, run_id, 910).await;
        assert!(refused.is_err(), "{kind} shape must be refused");
    }

    // ---- a settled job is still referenceable, a deleted one is not --------
    let deleted = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            sqlx::query("DELETE FROM outbox WHERE workspace_id=$1 AND id=$2")
                .bind(workspace)
                .bind(job)
                .execute(conn)
                .await
                .map(|_| ())
                .map_err(DbError::from)
        })
    })
    .await;
    assert!(
        deleted.is_err(),
        "ON DELETE RESTRICT must keep a referenced job row alive"
    );
}

/// The token axes HAP-E4's SQL asserted and nothing exercised: **audience**,
/// **actor**, and **connection**. Each is flipped alone, with every other
/// condition left valid, so a passing case cannot be explained by a different
/// predicate.
#[tokio::test]
#[ignore = "needs verifier-owned disposable PG18 + migrated schema + momo_app role"]
async fn hosted_inbox_authority_checks_the_token_audience_actor_and_connection() {
    let (su, app) = pools().await;
    let f = seed(&su).await;
    let workspace = f.workspace;
    let agent = f.agent;
    let connection = f.connection;
    let channel = f.channel;

    let read = |app: PgPool| async move {
        with_tenant_tx(&app, workspace, move |conn| {
            Box::pin(async move {
                list_hosted_inbox_in_tx(conn, workspace, agent, connection, None, 10, "test-key")
                    .await
            })
        })
        .await
        .unwrap()
    };
    assert!(read(app.clone()).await.is_ok(), "baseline is readable");
    let recipients = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move { hosted_inbox_recipients_in_tx(conn, workspace, channel).await })
    })
    .await
    .unwrap();
    assert_eq!(recipients, vec![(f.agent, f.connection)]);

    // ---- audience / credential class ---------------------------------------
    //
    // A *hosted_active* row cannot carry another audience at all —
    // `token_hosted_binding_ck` (migration 069) refuses it — so the reachable
    // shape of "wrong audience" is a **generic** agent bearer standing in as the
    // connection's active credential. That is also the interesting attack: it is
    // exactly the "recreate a generic principal on the Agent Port" move
    // ADR-0162 refuses, and the read's `credential_class`/`audience` predicates
    // are the pair that must refuse it.
    let generic = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO token(id,workspace_id,kind,actor_member_id,token_hash,scopes,created_by) \
         VALUES($1,$2,'agent_bearer',$3,$4,ARRAY['agent:inbox:read']::text[],$5)",
    )
    .bind(generic)
    .bind(workspace)
    .bind(f.agent)
    .bind(Uuid::new_v4().as_bytes().repeat(2))
    .bind(f.human)
    .execute(&su)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE hosted_agent_connection SET active_token_id=$3 WHERE workspace_id=$1 AND id=$2",
    )
    .bind(workspace)
    .bind(f.connection)
    .bind(generic)
    .execute(&su)
    .await
    .unwrap();
    assert_eq!(
        read(app.clone()).await,
        Err(HostedInboxReadError::Unavailable),
        "a generic bearer cannot stand in as an Agent Port credential"
    );
    assert!(
        with_tenant_tx(&app, workspace, move |conn| Box::pin(async move {
            hosted_inbox_recipients_in_tx(conn, workspace, channel).await
        }))
        .await
        .unwrap()
        .is_empty(),
        "…and the producer stops fanning out to it"
    );
    // The DB itself refuses the other spelling, which is the stronger statement.
    let forbidden_audience =
        sqlx::query("UPDATE token SET audience='/v1/workspaces' WHERE workspace_id=$1 AND id=$2")
            .bind(workspace)
            .bind(f.token)
            .execute(&su)
            .await;
    assert!(
        forbidden_audience.is_err(),
        "a hosted_active credential is pinned to the Agent Port audience by CHECK"
    );
    sqlx::query(
        "UPDATE hosted_agent_connection SET active_token_id=$3 WHERE workspace_id=$1 AND id=$2",
    )
    .bind(workspace)
    .bind(f.connection)
    .bind(f.token)
    .execute(&su)
    .await
    .unwrap();
    assert!(read(app.clone()).await.is_ok(), "restored");

    // ---- actor -------------------------------------------------------------
    sqlx::query("UPDATE token SET actor_member_id=$3 WHERE workspace_id=$1 AND id=$2")
        .bind(workspace)
        .bind(f.token)
        .bind(f.other_agent)
        .execute(&su)
        .await
        .unwrap();
    assert_eq!(
        read(app.clone()).await,
        Err(HostedInboxReadError::Unavailable),
        "a token whose actor is another member cannot borrow this connection"
    );
    sqlx::query("UPDATE token SET actor_member_id=$3 WHERE workspace_id=$1 AND id=$2")
        .bind(workspace)
        .bind(f.token)
        .bind(f.agent)
        .execute(&su)
        .await
        .unwrap();
    assert!(read(app.clone()).await.is_ok(), "restored");

    // ---- connection --------------------------------------------------------
    //
    // One live connection per agent is a unique index (069), so the reachable
    // shape of "a token from elsewhere" is another agent's live connection
    // credential being adopted as this connection's active token. Both
    // `t.hosted_connection_id = hc.id` and `t.actor_member_id =
    // hc.agent_member_id` are false then, and the read must refuse — this is the
    // cross-connection replay the pair exists to stop.
    let foreign_connection = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO hosted_agent_connection( \
           id,workspace_id,agent_member_id,status,pairing_consumed_at,detected_at,detected_by, \
           confirmed_by,confirmed_at,approved_channel_ids,approved_scopes,created_by) \
         VALUES($1,$2,$3,'detected',now(),now(),$4,$4,now(),$5, \
           ARRAY['agent:port:connect','agent:inbox:read']::text[],$4)",
    )
    .bind(foreign_connection)
    .bind(workspace)
    .bind(f.other_agent)
    .bind(f.human)
    .bind(vec![f.channel])
    .execute(&su)
    .await
    .unwrap();
    let foreign_token = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO token(id,workspace_id,kind,actor_member_id,token_hash,scopes,created_by, \
                           credential_class,hosted_connection_id,audience) \
         VALUES($1,$2,'agent_bearer',$3,$4, \
           ARRAY['agent:port:connect','agent:inbox:read']::text[],$5, \
           'hosted_active',$6,'/v1/mcp/agent-port')",
    )
    .bind(foreign_token)
    .bind(workspace)
    .bind(f.other_agent)
    .bind(Uuid::new_v4().as_bytes().repeat(2))
    .bind(f.human)
    .bind(foreign_connection)
    .execute(&su)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE hosted_agent_connection SET status='active',active_token_id=$3, \
           proved_at=now(),proved_by=$4 WHERE workspace_id=$1 AND id=$2",
    )
    .bind(workspace)
    .bind(foreign_connection)
    .bind(foreign_token)
    .bind(f.other_agent)
    .execute(&su)
    .await
    .unwrap();
    // Adoption is not even representable: `active_token_id` is globally unique,
    // so a credential that is already one connection's active token cannot
    // become another's. The refusal below is the schema saying so — a stronger
    // answer than the read merely returning nothing.
    let adopted = sqlx::query(
        "UPDATE hosted_agent_connection SET active_token_id=$3 WHERE workspace_id=$1 AND id=$2",
    )
    .bind(workspace)
    .bind(f.connection)
    .bind(foreign_token)
    .execute(&su)
    .await;
    assert!(
        adopted.is_err(),
        "one credential cannot be the active token of two connections"
    );
    assert!(
        read(app.clone()).await.is_ok(),
        "the original binding stands"
    );

    // …and the mirror image is unrepresentable too: an `active` connection with
    // no active token fails `hosted_agent_connection_activation_shape_ck`, so
    // "active but unauthenticated" is not a state this ledger can hold.
    let unbound = sqlx::query(
        "UPDATE hosted_agent_connection SET active_token_id=NULL \
         WHERE workspace_id=$1 AND id=$2",
    )
    .bind(workspace)
    .bind(f.connection)
    .execute(&su)
    .await;
    assert!(
        unbound.is_err(),
        "an active connection cannot drop its credential and stay active"
    );
    assert!(read(app.clone()).await.is_ok());
}

// ---------------------------------------------------------------------------
// #1375 — the outbox retention contract
//
// `outbox` is documented as a queue whose rows are deleted after consumption,
// and 071 bound the ledger's job reference to a real `outbox` row. Those two
// facts pull against each other, and migration 073 decides which way: the
// ledger is the retention floor for the job rows it names, because a hosted
// agent fetches the job the reference resolves to, so a reference whose target
// was pruned is not a preserved fact but a dangling one.
//
// A decision written only in a header is a decision the next pruner will not
// read, so it is spelled here as the two shapes a pruner can take.
// ---------------------------------------------------------------------------
#[tokio::test]
#[ignore = "needs verifier-owned disposable PG18 + migrated schema + momo_app role"]
async fn a_referenced_job_row_is_pinned_and_an_anti_joining_pruner_still_drains() {
    let (su, app) = pools().await;
    let f = seed(&su).await;
    let workspace = f.workspace;
    let agent = f.agent;
    let connection = f.connection;
    let channel = f.channel;

    let run = insert_run(&su, &f, f.agent, f.channel).await;
    let referenced = insert_job(&su, &f, f.agent, run).await;
    with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            append_job_reference_in_tx(conn, workspace, agent, connection, channel, referenced, run)
                .await
        })
    })
    .await
    .expect("the reference lands");

    // A second, unreferenced job of the same shape: the row a pruner is for.
    let spare_run = insert_run(&su, &f, f.agent, f.channel).await;
    let unreferenced = insert_job(&su, &f, f.agent, spare_run).await;
    sqlx::query("UPDATE outbox SET status='done', processed_at=now() WHERE workspace_id=$1")
        .bind(workspace)
        .execute(&su)
        .await
        .unwrap();

    // (1) The naive pruner — age alone — is refused, and named by the FK that
    // refused it. This is the RESTRICT 073 keeps on purpose.
    let naive =
        sqlx::query("DELETE FROM outbox WHERE workspace_id=$1 AND processed_at IS NOT NULL")
            .bind(workspace)
            .execute(&su)
            .await
            .expect_err("a pruner that ignores the ledger is refused");
    assert_eq!(
        naive
            .as_database_error()
            .expect("a database error")
            .constraint(),
        Some("hosted_agent_inbox_event_outbox_fk"),
        "the refusal names the reference, so a pruner knows what to exclude"
    );

    // (2) The contract-obeying pruner drains everything the ledger does not
    // name, in one statement, and leaves the referenced row exactly where the
    // hosted agent will look for it.
    let pruned = sqlx::query(
        "DELETE FROM outbox o WHERE o.workspace_id=$1 AND o.processed_at IS NOT NULL \
           AND NOT EXISTS ( \
             SELECT 1 FROM hosted_agent_inbox_event e \
              WHERE e.workspace_id = o.workspace_id AND e.source_outbox_id = o.id \
                AND e.event_kind = 'agent_job')",
    )
    .bind(workspace)
    .execute(&su)
    .await
    .expect("an anti-joining pruner drains");
    assert_eq!(pruned.rows_affected(), 1, "exactly the unreferenced row");

    let survivors: Vec<i64> = sqlx::query_scalar("SELECT id FROM outbox WHERE workspace_id=$1")
        .bind(workspace)
        .fetch_all(&su)
        .await
        .unwrap();
    assert_eq!(survivors, vec![referenced]);
    assert!(!survivors.contains(&unreferenced));

    // And the reference still resolves, which is the whole point of pinning it.
    let resolves: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM hosted_agent_inbox_event e JOIN outbox o \
           ON o.workspace_id = e.workspace_id AND o.id = e.source_outbox_id \
          WHERE e.workspace_id=$1 AND e.event_kind='agent_job')",
    )
    .bind(workspace)
    .fetch_one(&su)
    .await
    .unwrap();
    assert!(resolves, "the ledger never names a pruned job");
}
