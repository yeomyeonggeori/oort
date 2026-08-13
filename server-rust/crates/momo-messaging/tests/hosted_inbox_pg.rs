//! HAP-E4 PG18 conformance. The verifier supplies a migrated disposable DB and
//! the canonical `momo_app` role; this binary never accepts a production DB as
//! a migration target.

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

struct Fixture {
    workspace: Uuid,
    author: Uuid,
    agent: Uuid,
    connection: Uuid,
    channels: [Uuid; 2],
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
    .bind(vec![7_u8; 32])
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
    let body = body.to_string();
    with_tenant_tx(app, workspace, move |conn| {
        Box::pin(async move {
            let sent = momo_messaging::send_message_in_tx(
                conn,
                workspace,
                NewMessage::text(channel, author, body),
            )
            .await?;
            let appended =
                append_message_reference_in_tx(conn, workspace, channel, sent.message.id).await?;
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
    assert!(!page2.has_more);

    // Replaying the same source is exactly-once and consumes no counter value.
    let second_channel = f.channels[1];
    let replay = with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            append_message_reference_in_tx(conn, workspace, second_channel, second).await
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
                append_message_reference_in_tx(conn, workspace, channel, concurrent_message).await
            })
        })
        .await
        .unwrap()
    });
    let right = tokio::spawn(async move {
        with_tenant_tx(&right_pool, workspace, move |conn| {
            Box::pin(async move {
                append_message_reference_in_tx(conn, workspace, channel, concurrent_message).await
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
            append_message_reference_in_tx(conn, workspace, channel, sent.message.id).await?;
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

    // A cursor is connection-bound and cannot be replayed under another identity.
    let wrong = with_tenant_tx(&app, workspace, move |conn| {
        let cursor = page2.next_cursor.clone();
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
    assert_eq!(wrong, Err(HostedInboxReadError::InvalidCursor));

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
    let third = send_and_append(&app, &f, f.channels[0], "inactive").await;
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
}
