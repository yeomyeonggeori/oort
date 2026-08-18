//! HAP-E4 PG18 conformance. The verifier supplies a migrated disposable DB and
//! the canonical `momo_app` role; this binary never accepts a production DB as
//! a migration target.

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{run_migrations, SeedMode};
use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_messaging::{
    append_message_reference_in_tx, list_hosted_inbox_in_tx, HostedInboxReadError, NewMessage,
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
    author: Uuid,
    agent: Uuid,
    connection: Uuid,
    channels: [Uuid; 2],
}

/// A 32-byte stand-in for a real SHA-256, unique per token id. These fixtures
/// never present the credential over the wire, so only its uniqueness matters.
fn fake_token_hash(token: Uuid) -> Vec<u8> {
    let mut hash = vec![7_u8; 32];
    hash[..16].copy_from_slice(token.as_bytes());
    hash
}

async fn seed(su: &PgPool) -> Fixture {
    let fixture = Fixture {
        workspace: Uuid::new_v4(),
        author: Uuid::new_v4(),
        agent: Uuid::new_v4(),
        connection: Uuid::new_v4(),
        channels: [Uuid::new_v4(), Uuid::new_v4()],
    };
    sqlx::query("INSERT INTO workspace(id,slug,name) VALUES($1,$2,$2)")
        .bind(fixture.workspace)
        .bind(fixture.workspace.to_string())
        .execute(su)
        .await
        .unwrap();
    for (id, kind) in [(fixture.author, "human"), (fixture.agent, "agent")] {
        sqlx::query(
            "INSERT INTO member(id,workspace_id,kind,status,display_name,handle) \
             VALUES($1,$2,$3::member_kind,'active',$4,$4)",
        )
        .bind(id)
        .bind(fixture.workspace)
        .bind(kind)
        .bind(id.to_string())
        .execute(su)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO workspace_membership(workspace_id,member_id,role) \
             VALUES($1,$2,'member')",
        )
        .bind(fixture.workspace)
        .bind(id)
        .execute(su)
        .await
        .unwrap();
    }
    sqlx::query(
        "INSERT INTO agent(member_id,workspace_id,model,base_url,config) \
         VALUES($1,$2,'hosted-agent','https://hosted-agent.invalid/disabled', \
                '{\"execution_mode\":\"hosted_dial_in\"}'::jsonb)",
    )
    .bind(fixture.agent)
    .bind(fixture.workspace)
    .execute(su)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO agent_profile(agent_member_id,workspace_id,updated_by,paused) \
         VALUES($1,$2,$3,false)",
    )
    .bind(fixture.agent)
    .bind(fixture.workspace)
    .bind(fixture.author)
    .execute(su)
    .await
    .unwrap();
    for (index, channel) in fixture.channels.iter().enumerate() {
        sqlx::query("INSERT INTO channel(id,workspace_id,kind,name) VALUES($1,$2,'public',$3)")
            .bind(channel)
            .bind(fixture.workspace)
            .bind(format!("inbox-{index}-{}", fixture.workspace))
            .execute(su)
            .await
            .unwrap();
        sqlx::query("INSERT INTO channel_seq(channel_id,workspace_id,last_seq) VALUES($1,$2,0)")
            .bind(channel)
            .bind(fixture.workspace)
            .execute(su)
            .await
            .unwrap();
        for member in [fixture.author, fixture.agent] {
            sqlx::query(
                "INSERT INTO membership(workspace_id,channel_id,member_id) VALUES($1,$2,$3)",
            )
            .bind(fixture.workspace)
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
           ARRAY['agent:port:connect','agent:inbox:read']::text[],$4)",
    )
    .bind(fixture.connection)
    .bind(fixture.workspace)
    .bind(fixture.agent)
    .bind(fixture.author)
    .bind(fixture.channels.to_vec())
    .execute(su)
    .await
    .unwrap();
    let token = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO token(id,workspace_id,kind,actor_member_id,token_hash,scopes,created_by, \
                           credential_class,hosted_connection_id,audience) \
         VALUES($1,$2,'agent_bearer',$3,$4, \
           ARRAY['agent:port:connect','agent:inbox:read']::text[],$5, \
           'hosted_active',$6,'/v1/mcp/agent-port')",
    )
    .bind(token)
    .bind(fixture.workspace)
    .bind(fixture.agent)
    // Per-fixture rather than a constant: `token_hash` is globally unique, so a
    // literal would let this helper be called exactly once per database.
    .bind(fake_token_hash(token))
    .bind(fixture.author)
    .bind(fixture.connection)
    .execute(su)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE hosted_agent_connection SET status='active',active_token_id=$3, \
           proved_at=now(),proved_by=$4 WHERE workspace_id=$1 AND id=$2",
    )
    .bind(fixture.workspace)
    .bind(fixture.connection)
    .bind(token)
    .bind(fixture.agent)
    .execute(su)
    .await
    .unwrap();
    fixture
}

async fn send_and_append(app: &PgPool, f: &Fixture, channel: Uuid, body: &str) -> Uuid {
    let workspace = f.workspace;
    let author = f.author;
    let agent = f.agent;
    let connection = f.connection;
    let body = body.to_string();
    with_tenant_tx(app, workspace, move |conn| {
        Box::pin(async move {
            let sent = momo_messaging::send_message_in_tx(
                conn,
                workspace,
                NewMessage::text(channel, author, body),
            )
            .await?;
            let appended = append_message_reference_in_tx(
                conn,
                workspace,
                agent,
                connection,
                channel,
                sent.message.id,
            )
            .await?;
            assert_eq!(appended.len(), 1);
            Ok(sent.message.id)
        })
    })
    .await
    .unwrap()
}

async fn send_without_append(app: &PgPool, f: &Fixture, channel: Uuid, body: &str) -> Uuid {
    let workspace = f.workspace;
    let author = f.author;
    let body = body.to_string();
    with_tenant_tx(app, workspace, move |conn| {
        Box::pin(async move {
            Ok(momo_messaging::send_message_in_tx(
                conn,
                workspace,
                NewMessage::text(channel, author, body),
            )
            .await?
            .message
            .id)
        })
    })
    .await
    .unwrap()
}

#[tokio::test]
#[ignore = "needs verifier-owned disposable PG18 + migrated schema + momo_app role"]
async fn hosted_inbox_cursor_rls_idempotency_and_visibility() {
    let (su, app) = pools().await;
    let f = seed(&su).await;
    let first = send_and_append(&app, &f, f.channels[0], "first").await;
    let second = send_and_append(&app, &f, f.channels[1], "second").await;

    let workspace = f.workspace;
    let agent = f.agent;
    let connection = f.connection;
    let page1 = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            list_hosted_inbox_in_tx(conn, workspace, agent, connection, None, 1, "test-key").await
        })
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(page1.events.len(), 1);
    assert_eq!(page1.events[0].inbox_seq, 1);
    assert_eq!(page1.events[0].source_message_id, Some(first));
    assert_eq!(page1.events[0].source_channel_id, Some(f.channels[0]));
    assert_eq!(page1.events[0].source_message_seq, Some(1));
    assert!(page1.has_more);

    let cursor = page1.next_cursor.clone();
    let page2 = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            list_hosted_inbox_in_tx(
                conn,
                workspace,
                agent,
                connection,
                Some(&cursor),
                1,
                "test-key",
            )
            .await
        })
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(page2.events[0].inbox_seq, 2);
    assert_eq!(page2.events[0].source_message_id, Some(second));
    assert_eq!(page2.events[0].source_channel_id, Some(f.channels[1]));
    assert_eq!(page2.events[0].source_message_seq, Some(1));
    assert!(!page2.has_more);

    // Replaying the same source is exactly-once and consumes no counter value.
    let second_channel = f.channels[1];
    let replay = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            append_message_reference_in_tx(
                conn,
                workspace,
                agent,
                connection,
                second_channel,
                second,
            )
            .await
        })
    })
    .await
    .unwrap();
    assert_eq!(replay, vec![(connection, 2)]);

    // Two concurrent retries serialize on the connection counter, create one
    // reference, and both observe the same committed sequence.
    let concurrent_message = send_without_append(&app, &f, f.channels[0], "concurrent").await;
    let left_pool = app.clone();
    let right_pool = app.clone();
    let channel = f.channels[0];
    let left = tokio::spawn(async move {
        with_tenant_tx(&left_pool, workspace, move |conn| {
            Box::pin(async move {
                append_message_reference_in_tx(
                    conn,
                    workspace,
                    agent,
                    connection,
                    channel,
                    concurrent_message,
                )
                .await
            })
        })
        .await
        .unwrap()
    });
    let right = tokio::spawn(async move {
        with_tenant_tx(&right_pool, workspace, move |conn| {
            Box::pin(async move {
                append_message_reference_in_tx(
                    conn,
                    workspace,
                    agent,
                    connection,
                    channel,
                    concurrent_message,
                )
                .await
            })
        })
        .await
        .unwrap()
    });
    assert_eq!(left.await.unwrap(), vec![(connection, 3)]);
    assert_eq!(right.await.unwrap(), vec![(connection, 3)]);
    let duplicate_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_agent_inbox_event WHERE workspace_id=$1 \
         AND connection_id=$2 AND source_message_id=$3",
    )
    .bind(workspace)
    .bind(connection)
    .bind(concurrent_message)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(duplicate_count, 1);

    // A caller cannot select recipients from one channel while referencing a
    // message from another channel. The mismatch fails the whole tenant tx.
    let wrong_channel = f.channels[1];
    let mismatched = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            append_message_reference_in_tx(conn, workspace, agent, connection, wrong_channel, first)
                .await
        })
    })
    .await;
    assert!(mismatched.is_err());

    // The source write and projection are one transaction: a later DB failure
    // rolls both back and leaves no consumed inbox sequence.
    let rollback_body = format!("rollback-{}", Uuid::new_v4());
    let rollback_body_for_tx = rollback_body.clone();
    let author = f.author;
    let rollback: Result<(), DbError> = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            let sent = momo_messaging::send_message_in_tx(
                conn,
                workspace,
                NewMessage::text(channel, author, rollback_body_for_tx),
            )
            .await?;
            append_message_reference_in_tx(
                conn,
                workspace,
                agent,
                connection,
                channel,
                sent.message.id,
            )
            .await?;
            sqlx::query("SELECT 1 / 0").execute(conn).await?;
            Ok(())
        })
    })
    .await;
    assert!(rollback.is_err());
    let rollback_messages: i64 =
        sqlx::query_scalar("SELECT count(*) FROM message WHERE workspace_id=$1 AND body=$2")
            .bind(workspace)
            .bind(&rollback_body)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(rollback_messages, 0);
    let last_seq: i64 = sqlx::query_scalar(
        "SELECT last_seq FROM hosted_agent_inbox_counter WHERE workspace_id=$1 AND connection_id=$2",
    )
    .bind(workspace)
    .bind(connection)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(last_seq, 3);

    // Membership removal hides the old reference even with a previously issued cursor.
    sqlx::query("UPDATE membership SET left_at=now() WHERE channel_id=$1 AND member_id=$2")
        .bind(f.channels[1])
        .bind(agent)
        .execute(&su)
        .await
        .unwrap();
    let hidden = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            list_hosted_inbox_in_tx(conn, workspace, agent, connection, None, 10, "test-key").await
        })
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(hidden.events.len(), 2);
    assert_eq!(hidden.events[0].source_message_id, Some(first));
    assert_eq!(hidden.events[1].source_message_id, Some(concurrent_message));
    sqlx::query("UPDATE membership SET left_at=NULL WHERE channel_id=$1 AND member_id=$2")
        .bind(f.channels[1])
        .bind(agent)
        .execute(&su)
        .await
        .unwrap();
    let hidden_cursor = hidden.next_cursor;
    let not_replayed = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            list_hosted_inbox_in_tx(
                conn,
                workspace,
                agent,
                connection,
                Some(&hidden_cursor),
                10,
                "test-key",
            )
            .await
        })
    })
    .await
    .unwrap()
    .unwrap();
    assert!(not_replayed.events.is_empty());

    // FORCE RLS filters this tenant's rows when the runtime role carries a
    // different workspace GUC; both new tables are NOBYPASS-visible only.
    let foreign_workspace = Uuid::new_v4();
    let foreign_count: i64 = with_tenant_tx(&app, foreign_workspace, move |conn| {
        Box::pin(async move {
            sqlx::query_scalar("SELECT count(*) FROM hosted_agent_inbox_event")
                .fetch_one(conn)
                .await
                .map_err(DbError::from)
        })
    })
    .await
    .unwrap();
    assert_eq!(foreign_count, 0);
    let posture: (bool, bool, bool, bool) = sqlx::query_as(
        "SELECT c1.relrowsecurity,c1.relforcerowsecurity,c2.relrowsecurity,c2.relforcerowsecurity \
           FROM pg_class c1 CROSS JOIN pg_class c2 \
          WHERE c1.oid='hosted_agent_inbox_counter'::regclass \
            AND c2.oid='hosted_agent_inbox_event'::regclass",
    )
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(posture, (true, true, true, true));

    // UPDATE and DELETE are both rejected by the append-only trigger.
    let update_event = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            sqlx::query(
                "UPDATE hosted_agent_inbox_event SET created_at=now() \
                  WHERE workspace_id=$1 AND connection_id=$2 AND inbox_seq=1",
            )
            .bind(workspace)
            .bind(connection)
            .execute(conn)
            .await
            .map(|_| ())
            .map_err(DbError::from)
        })
    })
    .await;
    assert!(update_event.is_err());
    let delete_event = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            sqlx::query(
                "DELETE FROM hosted_agent_inbox_event \
                  WHERE workspace_id=$1 AND connection_id=$2 AND inbox_seq=1",
            )
            .bind(workspace)
            .bind(connection)
            .execute(conn)
            .await
            .map(|_| ())
            .map_err(DbError::from)
        })
    })
    .await;
    assert!(delete_event.is_err());

    // A cursor is connection-bound and cannot be replayed under another identity.
    let page2_cursor = page2.next_cursor.clone();
    let wrong = with_tenant_tx(&app, workspace, move |conn| {
        let cursor = page2_cursor.clone();
        Box::pin(async move {
            list_hosted_inbox_in_tx(
                conn,
                workspace,
                Uuid::new_v4(),
                connection,
                Some(&cursor),
                10,
                "test-key",
            )
            .await
        })
    })
    .await
    .unwrap();
    assert_eq!(wrong, Err(HostedInboxReadError::Unavailable));

    // Removing the inbox scope immediately stops both append and read. It
    // does not consume a sequence and restoring the exact scope resumes at
    // the next committed value.
    sqlx::query(
        "UPDATE token SET scopes=ARRAY['agent:port:connect']::text[] \
          WHERE workspace_id=$1 AND hosted_connection_id=$2 AND revoked_at IS NULL",
    )
    .bind(workspace)
    .bind(connection)
    .execute(&su)
    .await
    .unwrap();
    let no_scope_message = send_without_append(&app, &f, f.channels[0], "no-scope").await;
    let no_scope = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            append_message_reference_in_tx(
                conn,
                workspace,
                agent,
                connection,
                channel,
                no_scope_message,
            )
            .await
        })
    })
    .await
    .unwrap();
    assert!(no_scope.is_empty());
    let no_scope_read = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            list_hosted_inbox_in_tx(conn, workspace, agent, connection, None, 10, "test-key").await
        })
    })
    .await
    .unwrap();
    assert_eq!(no_scope_read, Err(HostedInboxReadError::Unavailable));
    sqlx::query(
        "UPDATE token SET scopes=ARRAY['agent:port:connect','agent:inbox:read']::text[] \
          WHERE workspace_id=$1 AND hosted_connection_id=$2 AND revoked_at IS NULL",
    )
    .bind(workspace)
    .bind(connection)
    .execute(&su)
    .await
    .unwrap();

    sqlx::query(
        "UPDATE hosted_agent_connection SET approved_scopes=ARRAY['agent:port:connect']::text[] \
          WHERE workspace_id=$1 AND id=$2",
    )
    .bind(workspace)
    .bind(connection)
    .execute(&su)
    .await
    .unwrap();
    let approval_scope_read = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            list_hosted_inbox_in_tx(conn, workspace, agent, connection, None, 10, "test-key").await
        })
    })
    .await
    .unwrap();
    assert_eq!(approval_scope_read, Err(HostedInboxReadError::Unavailable));
    sqlx::query(
        "UPDATE hosted_agent_connection SET approved_scopes= \
           ARRAY['agent:port:connect','agent:inbox:read']::text[] \
          WHERE workspace_id=$1 AND id=$2",
    )
    .bind(workspace)
    .bind(connection)
    .execute(&su)
    .await
    .unwrap();

    // Human pause and the approved-channel boundary independently stop
    // append/read without consuming a sequence.
    sqlx::query(
        "UPDATE agent_profile SET paused=true WHERE workspace_id=$1 AND agent_member_id=$2",
    )
    .bind(workspace)
    .bind(agent)
    .execute(&su)
    .await
    .unwrap();
    let paused_read = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            list_hosted_inbox_in_tx(conn, workspace, agent, connection, None, 10, "test-key").await
        })
    })
    .await
    .unwrap();
    assert_eq!(paused_read, Err(HostedInboxReadError::Unavailable));
    sqlx::query(
        "UPDATE agent_profile SET paused=false WHERE workspace_id=$1 AND agent_member_id=$2",
    )
    .bind(workspace)
    .bind(agent)
    .execute(&su)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE hosted_agent_connection SET approved_channel_ids=ARRAY[$3]::uuid[] \
          WHERE workspace_id=$1 AND id=$2",
    )
    .bind(workspace)
    .bind(connection)
    .bind(f.channels[1])
    .execute(&su)
    .await
    .unwrap();
    let narrowed_read = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            list_hosted_inbox_in_tx(conn, workspace, agent, connection, None, 10, "test-key").await
        })
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(narrowed_read.events.len(), 1);
    assert_eq!(narrowed_read.events[0].source_message_id, Some(second));
    let not_approved_message = send_without_append(&app, &f, f.channels[0], "not-approved").await;
    let not_approved = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            append_message_reference_in_tx(
                conn,
                workspace,
                agent,
                connection,
                channel,
                not_approved_message,
            )
            .await
        })
    })
    .await
    .unwrap();
    assert!(not_approved.is_empty());
    sqlx::query(
        "UPDATE hosted_agent_connection SET approved_channel_ids=$3 \
          WHERE workspace_id=$1 AND id=$2",
    )
    .bind(workspace)
    .bind(connection)
    .bind(f.channels.to_vec())
    .execute(&su)
    .await
    .unwrap();

    sqlx::query("UPDATE member SET status='suspended' WHERE workspace_id=$1 AND id=$2")
        .bind(workspace)
        .bind(agent)
        .execute(&su)
        .await
        .unwrap();
    let suspended_read = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            list_hosted_inbox_in_tx(conn, workspace, agent, connection, None, 10, "test-key").await
        })
    })
    .await
    .unwrap();
    assert_eq!(suspended_read, Err(HostedInboxReadError::Unavailable));
    sqlx::query("UPDATE member SET status='active' WHERE workspace_id=$1 AND id=$2")
        .bind(workspace)
        .bind(agent)
        .execute(&su)
        .await
        .unwrap();

    // New references stop as soon as the connection is no longer active.
    sqlx::query(
        "UPDATE hosted_agent_connection SET status='cleanup_pending' \
         WHERE workspace_id=$1 AND id=$2",
    )
    .bind(workspace)
    .bind(connection)
    .execute(&su)
    .await
    .unwrap();
    let third = send_without_append(&app, &f, f.channels[0], "inactive").await;
    let inactive_append = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            append_message_reference_in_tx(conn, workspace, agent, connection, channel, third).await
        })
    })
    .await
    .unwrap();
    assert!(inactive_append.is_empty());
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_agent_inbox_event WHERE workspace_id=$1 \
         AND source_message_id=$2",
    )
    .bind(workspace)
    .bind(third)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(count, 0);

    // Disconnect preserves the old ledger but a reconnect receives a fresh
    // connection/cursor namespace whose first committed event is sequence 1.
    sqlx::query(
        "UPDATE token SET revoked_at=now() \
          WHERE workspace_id=$1 AND hosted_connection_id=$2 AND revoked_at IS NULL",
    )
    .bind(workspace)
    .bind(connection)
    .execute(&su)
    .await
    .unwrap();
    // HAP-E6's migration 072 refuses a terminal state the lifecycle has not
    // actually reached: it must arrive from `cleanup_pending`, carry a seeded
    // manifest with nothing required left unresolved, hold zero live
    // credentials on the connection (revoked just above) and find the dedicated
    // agent paused. The fixture walks exactly that, then restores the pause —
    // what it is building is the *reconnect*, and a reconnected agent is not a
    // paused one.
    sqlx::query(
        "UPDATE agent_profile SET paused=true WHERE workspace_id=$1 AND agent_member_id=$2",
    )
    .bind(workspace)
    .bind(agent)
    .execute(&su)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE hosted_agent_connection SET status='cleanup_pending',active_token_id=NULL \
          WHERE workspace_id=$1 AND id=$2",
    )
    .bind(workspace)
    .bind(connection)
    .execute(&su)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO hosted_agent_connection_artifact \
           (workspace_id, connection_id, agent_member_id, kind, expected_action, \
            current_status, disposition, source, acknowledged_at) \
         VALUES ($1,$2,$3,'secret','revoke','absent','revoked','server_verified',now())",
    )
    .bind(workspace)
    .bind(connection)
    .bind(agent)
    .execute(&su)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE hosted_agent_connection SET status='disconnected' \
          WHERE workspace_id=$1 AND id=$2",
    )
    .bind(workspace)
    .bind(connection)
    .execute(&su)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE agent_profile SET paused=false WHERE workspace_id=$1 AND agent_member_id=$2",
    )
    .bind(workspace)
    .bind(agent)
    .execute(&su)
    .await
    .unwrap();
    let replacement = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO hosted_agent_connection( \
           id,workspace_id,agent_member_id,status,pairing_consumed_at,detected_at,detected_by, \
           confirmed_by,confirmed_at,approved_channel_ids,approved_scopes,created_by) \
         VALUES($1,$2,$3,'detected',now(),now(),$4,$4,now(),$5, \
           ARRAY['agent:port:connect','agent:inbox:read']::text[],$4)",
    )
    .bind(replacement)
    .bind(workspace)
    .bind(agent)
    .bind(f.author)
    .bind(f.channels.to_vec())
    .execute(&su)
    .await
    .unwrap();
    let replacement_token = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO token(id,workspace_id,kind,actor_member_id,token_hash,scopes,created_by, \
                           credential_class,hosted_connection_id,audience) \
         VALUES($1,$2,'agent_bearer',$3,$4, \
           ARRAY['agent:port:connect','agent:inbox:read']::text[],$5, \
           'hosted_active',$6,'/v1/mcp/agent-port')",
    )
    .bind(replacement_token)
    .bind(workspace)
    .bind(agent)
    .bind(vec![9_u8; 32])
    .bind(f.author)
    .bind(replacement)
    .execute(&su)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE hosted_agent_connection SET status='active',active_token_id=$3, \
           proved_at=now(),proved_by=$4 WHERE workspace_id=$1 AND id=$2",
    )
    .bind(workspace)
    .bind(replacement)
    .bind(replacement_token)
    .bind(agent)
    .execute(&su)
    .await
    .unwrap();

    let after_reconnect = send_without_append(&app, &f, f.channels[0], "reconnected").await;
    let reconnected_append = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            append_message_reference_in_tx(
                conn,
                workspace,
                agent,
                replacement,
                channel,
                after_reconnect,
            )
            .await
        })
    })
    .await
    .unwrap();
    assert_eq!(reconnected_append, vec![(replacement, 1)]);
    let old_history: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_agent_inbox_event \
          WHERE workspace_id=$1 AND connection_id=$2",
    )
    .bind(workspace)
    .bind(connection)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(old_history, 3);
    let old_cursor = page2.next_cursor;
    let replay_old_cursor = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            list_hosted_inbox_in_tx(
                conn,
                workspace,
                agent,
                replacement,
                Some(&old_cursor),
                10,
                "test-key",
            )
            .await
        })
    })
    .await
    .unwrap();
    assert_eq!(replay_old_cursor, Err(HostedInboxReadError::Unavailable));
}

// ---------------------------------------------------------------------------
// #1375 — the ledger's delete surface
//
// 070 wrote two rules and got both slightly wrong, in opposite directions. The
// `ON DELETE RESTRICT` on the connection FK was too strict: it refused the
// agent teardown that owns the connection, and 070's own append-only trigger
// then refused the operator's attempt to clear the ledger by hand, so the wedge
// had no exit. The append-only trigger's `pg_trigger_depth() = 1` was too
// loose: it was meant to name the workspace cascade and instead named "not top
// level", which is every trigger in the database.
//
// Migration 073 replaces both with the same question — is this row's owner
// already gone? — and this test is the four answers.
// ---------------------------------------------------------------------------

async fn ledger_rows(su: &PgPool, workspace: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM hosted_agent_inbox_event WHERE workspace_id=$1")
        .bind(workspace)
        .fetch_one(su)
        .await
        .unwrap()
}

fn database_message(error: &sqlx::Error) -> String {
    error
        .as_database_error()
        .expect("a database error")
        .message()
        .to_string()
}

#[tokio::test]
#[ignore = "needs verifier-owned disposable PG18 + migrated schema + momo_app role"]
async fn the_inbox_ledger_is_deletable_only_by_the_teardown_that_owns_it() {
    let (su, app) = pools().await;

    // ---- (1) a live ledger refuses every direct removal --------------------
    let f = seed(&su).await;
    send_and_append(&app, &f, f.channels[0], "first").await;
    assert_eq!(ledger_rows(&su, f.workspace).await, 1);

    let top_level = sqlx::query("DELETE FROM hosted_agent_inbox_event WHERE workspace_id=$1")
        .bind(f.workspace)
        .execute(&su)
        .await
        .expect_err("append-only refuses a top-level DELETE");
    assert_eq!(
        database_message(&top_level),
        "hosted agent inbox events are append-only"
    );

    // The #1375 finding itself: before 073 this deleted the whole ledger and
    // committed, because a trigger body runs at depth 2 and 070 admitted any
    // depth above 1. The probe is an ordinary trigger on an unrelated table —
    // the point is precisely that it has nothing to do with the hosted inbox.
    sqlx::query("CREATE TABLE hosted_inbox_depth_probe(id int primary key)")
        .execute(&su)
        .await
        .unwrap();
    // A trigger function takes no arguments, so the workspace is closed over as
    // a literal. It is this test's own `Uuid::new_v4()`, never caller input.
    sqlx::query(&format!(
        "CREATE FUNCTION hosted_inbox_depth_probe_fn() RETURNS trigger \
         LANGUAGE plpgsql AS $fn$ BEGIN \
           DELETE FROM hosted_agent_inbox_event WHERE workspace_id = '{}'::uuid; \
           RETURN NEW; END $fn$",
        f.workspace
    ))
    .execute(&su)
    .await
    .unwrap();
    sqlx::query(
        "CREATE TRIGGER hosted_inbox_depth_probe_trg AFTER INSERT ON hosted_inbox_depth_probe \
         FOR EACH ROW EXECUTE FUNCTION hosted_inbox_depth_probe_fn()",
    )
    .execute(&su)
    .await
    .unwrap();
    let nested = sqlx::query("INSERT INTO hosted_inbox_depth_probe VALUES (1)")
        .execute(&su)
        .await
        .expect_err("073 refuses a DELETE issued from an unrelated trigger");
    assert_eq!(
        database_message(&nested),
        "hosted agent inbox events are append-only",
        "trigger depth is not permission"
    );
    assert_eq!(
        ledger_rows(&su, f.workspace).await,
        1,
        "nothing was removed"
    );
    sqlx::query("DROP TABLE hosted_inbox_depth_probe")
        .execute(&su)
        .await
        .unwrap();
    sqlx::query("DROP FUNCTION hosted_inbox_depth_probe_fn()")
        .execute(&su)
        .await
        .unwrap();

    // A bare connection delete is the case RESTRICT was worth having for, and
    // 073 keeps refusing it — with a message that names the ledger rather than
    // a constraint, because the operator's next question is what to do about it.
    let bare = sqlx::query("DELETE FROM hosted_agent_connection WHERE workspace_id=$1 AND id=$2")
        .bind(f.workspace)
        .bind(f.connection)
        .execute(&su)
        .await
        .expect_err("a connection carrying a ledger is not deletable on its own");
    assert_eq!(
        database_message(&bare),
        "hosted connection with inbox ledger rows cannot be deleted directly"
    );
    assert_eq!(ledger_rows(&su, f.workspace).await, 1);

    // ---- (2) the agent teardown, which used to wedge -----------------------
    // Before 073 this was:
    //   ERROR: update or delete on table "hosted_agent_connection" violates
    //          RESTRICT setting of foreign key constraint
    //          "hosted_agent_inbox_event_connection_fk"
    // with no way out, because the append-only trigger also refused the manual
    // cleanup the operator would have had to do first.
    let torn = seed(&su).await;
    send_and_append(&app, &torn, torn.channels[0], "doomed").await;
    assert_eq!(ledger_rows(&su, torn.workspace).await, 1);
    sqlx::query("DELETE FROM agent WHERE workspace_id=$1 AND member_id=$2")
        .bind(torn.workspace)
        .bind(torn.agent)
        .execute(&su)
        .await
        .expect("the agent teardown carries its connection and ledger away");
    assert_eq!(ledger_rows(&su, torn.workspace).await, 0);
    let connections: i64 =
        sqlx::query_scalar("SELECT count(*) FROM hosted_agent_connection WHERE workspace_id=$1")
            .bind(torn.workspace)
            .fetch_one(&su)
            .await
            .unwrap();
    assert_eq!(connections, 0);

    // ---- (3) the workspace teardown, which never wedged --------------------
    // #1375 predicted this one would fail and it does not: PostgreSQL queues
    // every FK action of the top-level DELETE before any action those cascades
    // queue in turn, so the ledger's own workspace-CASCADE always runs before
    // the connection cascade's referential check. Pinned here so a later
    // migration cannot quietly take it away.
    let razed = seed(&su).await;
    send_and_append(&app, &razed, razed.channels[0], "also doomed").await;
    assert_eq!(ledger_rows(&su, razed.workspace).await, 1);
    sqlx::query("DELETE FROM workspace WHERE id=$1")
        .bind(razed.workspace)
        .execute(&su)
        .await
        .expect("a workspace hard delete succeeds with a ledger present");
    assert_eq!(ledger_rows(&su, razed.workspace).await, 0);

    // ---- (4) and the first workspace is still intact -----------------------
    assert_eq!(ledger_rows(&su, f.workspace).await, 1);
}
