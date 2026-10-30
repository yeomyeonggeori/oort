//! #4772 / ADR-0186 D2, V3, V5, U-e: a human decision outlives an access token.
use super::*;

#[derive(Clone, Copy, Debug)]
enum Action {
    Create,
    AddMember,
    Pin,
    Unpin,
    Grant,
}

const ACTIONS: [Action; 5] = [
    Action::Create,
    Action::AddMember,
    Action::Pin,
    Action::Unpin,
    Action::Grant,
];

async fn start_server_with_oauth(pool: PgPool) -> String {
    use momo_server::config::{AgentPortOauthConfig, RegisteredOauthClient};
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_agent_port(AgentPortConfig {
        hosted_delivery_enabled: true,
        per_token_limit: 0,
        per_agent_limit: 0,
        per_ip_limit: 0,
        oauth: AgentPortOauthConfig::for_tests(
            "https://approval.example.test",
            "https://approval.example.test/consent",
            vec![RegisteredOauthClient {
                client_id: "approval-test-client".into(),
                redirect_uris: vec!["http://127.0.0.1/callback".into()],
            }],
        ),
        ..Default::default()
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            build_app(state).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    format!("http://{address}")
}

struct Trial {
    fixture: Fixture,
    approval: Uuid,
    name: String,
    guest: Uuid,
    message: Uuid,
    grant_room: Uuid,
}

async fn propose(su: &PgPool, client: &reqwest::Client, base: &str, action: Action) -> Trial {
    propose_with_auth(su, client, base, action, false).await
}

async fn oauth_fixture(su: &PgPool, mut fixture: Fixture) -> Fixture {
    let (ws, agent, human, channel, old_connection, old_token) = (
        fixture.workspace,
        fixture.hosted_agent,
        fixture.human,
        fixture.channel,
        fixture.hosted_connection,
        fixture.hosted_token,
    );
    let issued = momo_db::with_tenant_tx(su, ws, move |conn| Box::pin(async move {
        sqlx::query("UPDATE token SET revoked_at=now() WHERE workspace_id=$1 AND id=$2")
            .bind(ws).bind(old_token).execute(&mut *conn).await?;
        sqlx::query("UPDATE hosted_agent_connection SET status='expired', active_token_id=NULL WHERE workspace_id=$1 AND id=$2")
            .bind(ws).bind(old_connection).execute(&mut *conn).await?;
        let connection: Uuid = sqlx::query_scalar(
            "INSERT INTO hosted_agent_connection(workspace_id,agent_member_id,auth_mode,created_by) VALUES($1,$2,'oauth',$3) RETURNING id",
        ).bind(ws).bind(agent).bind(human).fetch_one(&mut *conn).await?;
        let scopes: Vec<String> = sqlx::query_scalar("SELECT approved_scopes FROM hosted_agent_connection WHERE workspace_id=$1 AND id=$2")
            .bind(ws).bind(old_connection).fetch_one(&mut *conn).await?;
        let now = chrono::Utc::now().timestamp().max(0) as usize;
        let claims = momo_auth::HostedOauthRequestClaims {
            jti: Uuid::new_v4().to_string(), cid: "approval-test-client".into(),
            ru: "http://127.0.0.1/callback".into(), res: "https://approval.example.test/v1/mcp/agent-port".into(),
            scp: scopes.clone(), cc: "a".repeat(43), ccm: "S256".into(), st: None,
            iat: now, exp: now + 600, typ: momo_auth::HOSTED_OAUTH_REQUEST_TYP.into(),
        };
        let approval = momo_auth::approve_hosted_oauth_request_in_tx(conn, ws, connection, human, &claims, &scopes, &[channel]).await?
            .expect("valid OAuth resource-owner consent");
        let code = momo_auth::lock_hosted_oauth_code_in_tx(conn, ws, &approval.authorization_code).await?
            .expect("the freshly approved code");
        let issued = momo_auth::consume_hosted_oauth_code_in_tx(conn, ws, &code).await?
            .expect("OAuth access and refresh pair");
        Ok::<_, momo_db::DbError>(issued)
    })).await.unwrap();
    fixture.hosted_connection = issued.connection_id;
    fixture.hosted_token = issued.access_token_id;
    fixture.hosted_bearer = issued.access_token;
    fixture
}

async fn disconnect_in_tx(conn: &mut sqlx::PgConnection, f: &Fixture) {
    let started = momo_auth::start_hosted_disconnect_in_tx(
        conn,
        f.workspace,
        f.hosted_connection,
        f.human,
        &[],
    )
    .await
    .unwrap();
    let momo_auth::HostedDisconnectStart::Applied(started) = started else {
        panic!("disconnect starts");
    };
    for artifact in started
        .artifacts
        .iter()
        .filter(|artifact| !artifact.resolved)
    {
        let disposition = if artifact.kind == "secret" {
            "revoke"
        } else {
            "delete"
        };
        let acknowledged = momo_auth::acknowledge_hosted_artifact_in_tx(
            conn,
            f.workspace,
            f.hosted_connection,
            momo_auth::HostedArtifactAcknowledgement {
                artifact_id: artifact.id,
                actor_member_id: f.human,
                current_status: "absent",
                disposition: Some(disposition),
                evidence: Some("isolated fixture cleanup"),
            },
        )
        .await
        .unwrap();
        assert!(matches!(
            acknowledged,
            momo_auth::HostedArtifactAck::Applied(_)
        ));
    }
    let completed =
        momo_auth::complete_hosted_disconnect_in_tx(conn, f.workspace, f.hosted_connection)
            .await
            .unwrap();
    assert!(matches!(
        completed,
        momo_auth::HostedDisconnectCompletion::Applied(_)
    ));
}

async fn propose_with_auth(
    su: &PgPool,
    client: &reqwest::Client,
    base: &str,
    action: Action,
    oauth: bool,
) -> Trial {
    let fixture = seed(su).await;
    let fixture = if oauth {
        oauth_fixture(su, fixture).await
    } else {
        fixture
    };
    let name = unique_channel_name();
    let (guest, handle) = seed_extra_member_3706(su, &fixture, "guest").await;
    let message = raw_says(su, &fixture, fixture.channel, "fixture pin target").await;
    let (grant_room, grant_name) = seed_channel_3707(su, &fixture, "public", &[]).await;
    let (id, args) = match action {
        Action::Create => (
            "channel.create",
            json!({"name": name, "memberHandles": [handle]}),
        ),
        Action::AddMember => (
            "channel.member.add",
            json!({"channel": fixture_channel_name(su, fixture.channel).await,
                   "memberHandles": [handle]}),
        ),
        Action::Pin => ("message.pin", json!({"messageId": message})),
        Action::Unpin => {
            sqlx::query("INSERT INTO message_pin(workspace_id, channel_id, message_id, pinned_by) VALUES($1,$2,$3,$4)")
                .bind(fixture.workspace).bind(fixture.channel).bind(message).bind(fixture.human)
                .execute(su).await.unwrap();
            ("message.unpin", json!({"messageId": message}))
        }
        Action::Grant => ("hosted.channels.grant", json!({"channels": [grant_name]})),
    };
    let (status, answer) = try_propose_action_3706(client, base, su, &fixture, id, args).await;
    assert_eq!(status, 200, "{action:?}: {answer}");
    let approval = proposed_approval_3706(&answer);
    let payload: Value = sqlx::query_scalar("SELECT payload FROM approval WHERE id=$1")
        .bind(approval)
        .fetch_one(su)
        .await
        .unwrap();
    assert_ne!(
        payload["origin"], "agent_initiated",
        "the human-requested path"
    );
    Trial {
        fixture,
        approval,
        name,
        guest,
        message,
        grant_room,
    }
}

async fn assert_effect(su: &PgPool, trial: &Trial, action: Action) {
    let f = &trial.fixture;
    let ws = f.workspace;
    let domain_audit = match action {
        Action::Create => {
            let (created, creator): (Uuid, Uuid) = sqlx::query_as(
                "SELECT id, created_by FROM channel WHERE workspace_id=$1 AND name=$2",
            )
            .bind(ws)
            .bind(&trial.name)
            .fetch_one(su)
            .await
            .unwrap();
            assert_eq!(creator, f.human);
            let seats: Vec<(Uuid, String)> = sqlx::query_as(
                "SELECT member_id, role::text FROM membership WHERE workspace_id=$1 AND channel_id=$2 AND left_at IS NULL ORDER BY member_id",
            ).bind(ws).bind(created).fetch_all(su).await.unwrap();
            let mut expected = vec![
                (f.human, "owner".to_string()),
                (f.hosted_agent, "member".to_string()),
                (trial.guest, "member".to_string()),
            ];
            expected.sort();
            assert_eq!(
                seats, expected,
                "all three memberships, with the approver as owner"
            );
            assert!(
                hosted_approved_3706(su, f).await.contains(&created),
                "the new room is covered"
            );
            let granted = audit_details_of(su, ws, "hosted_connection.channels_granted").await;
            assert_eq!(granted.len(), 1);
            assert_eq!(granted[0]["approval_id"], trial.approval.to_string());
            "channel.created"
        }
        Action::AddMember => {
            let seated: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM membership WHERE workspace_id=$1 AND channel_id=$2 AND member_id=$3 AND left_at IS NULL)",
            ).bind(ws).bind(f.channel).bind(trial.guest).fetch_one(su).await.unwrap();
            assert!(seated);
            "channel.member_added"
        }
        Action::Pin => {
            assert_eq!(pins_in(su, f.channel).await, vec![(trial.message, f.human)]);
            "message.pinned"
        }
        Action::Unpin => {
            assert!(pins_in(su, f.channel).await.is_empty());
            "message.unpinned"
        }
        Action::Grant => {
            assert!(hosted_approved_3706(su, f)
                .await
                .contains(&trial.grant_room));
            let seated: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM membership WHERE workspace_id=$1 AND channel_id=$2 AND member_id=$3 AND left_at IS NULL)",
            ).bind(ws).bind(trial.grant_room).bind(f.hosted_agent).fetch_one(su).await.unwrap();
            assert!(seated);
            "hosted_connection.channels_granted"
        }
    };
    let audits = audit_details_of(su, ws, domain_audit).await;
    assert_eq!(audits.len(), 1, "{action:?}: exactly one domain audit");
    assert_eq!(audits[0]["approval_id"], trial.approval.to_string());
    assert_eq!(audit_details_of(su, ws, "action.approved").await.len(), 1);
    assert_eq!(approval_status(su, trial.approval).await, "approved");
}

// Expiry is routine for both static and OAuth access credentials. Every action uses the
// real human-requested proposal and decision routes; a replay must not duplicate any effect.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn expired_human_requested_actions_execute_completely_once() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let base = start_server_with_oauth(momo_app_pool().await).await;
    let client = reqwest::Client::new();
    for class in ["hosted_active", "hosted_oauth_access"] {
        for action in ACTIONS {
            let trial =
                propose_with_auth(&su, &client, &base, action, class == "hosted_oauth_access")
                    .await;
            let f = &trial.fixture;
            sqlx::query("UPDATE token SET expires_at=now()-interval '1 hour' WHERE workspace_id=$1 AND id=$2")
                .bind(f.workspace).bind(f.hosted_token).execute(&su).await.unwrap();
            let decision_id = Uuid::new_v4();
            let mut receipt = None;
            for _ in 0..2 {
                let (status, _, answer) = decide_as(
                    &client,
                    &base,
                    f.workspace,
                    &f.human_jwt,
                    trial.approval,
                    true,
                    decision_id,
                )
                .await;
                assert_eq!(status, 200, "{class} {action:?}: {answer}");
                if let Some(receipt) = &receipt {
                    assert_eq!(receipt, &answer, "replay returns the original receipt");
                } else {
                    receipt = Some(answer);
                }
                assert_effect(&su, &trial, action).await;
            }
        }
    }
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn ended_human_requested_connections_leave_every_action_pending_and_write_nothing() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let base = start_server(momo_app_pool().await, true).await;
    let client = reqwest::Client::new();
    for drift in ["revoked", "disconnected", "inactive", "paused"] {
        for action in ACTIONS {
            let trial = propose(&su, &client, &base, action).await;
            let f = &trial.fixture;
            if drift == "disconnected" {
                let mut tx = su.begin().await.unwrap();
                disconnect_in_tx(&mut tx, f).await;
                tx.commit().await.unwrap();
            } else {
                let (query, target) = match drift {
                "revoked" => ("UPDATE token SET revoked_at=now() WHERE workspace_id=$1 AND id=$2", f.hosted_token),
                "inactive" => ("UPDATE hosted_agent_connection SET status='expired' WHERE workspace_id=$1 AND id=$2", f.hosted_connection),
                "paused" => ("UPDATE agent_profile SET paused=true WHERE workspace_id=$1 AND agent_member_id=$2", f.hosted_agent),
                _ => unreachable!(),
            };
                sqlx::query(query)
                    .bind(f.workspace)
                    .bind(target)
                    .execute(&su)
                    .await
                    .unwrap();
            }
            let before = residue(&su, f.workspace).await;
            let coverage: Option<Vec<Uuid>> = sqlx::query_scalar("SELECT approved_channel_ids FROM hosted_agent_connection WHERE workspace_id=$1 AND id=$2")
                .bind(f.workspace).bind(f.hosted_connection).fetch_optional(&su).await.unwrap();
            let pins = pins_in(&su, f.channel).await;
            let (status, answer) = approve(&client, &base, f, trial.approval).await;
            assert_eq!(status, 409, "{drift} {action:?}: {answer}");
            assert_eq!(answer["status"], "action_args_invalid");
            assert_eq!(approval_status(&su, trial.approval).await, "pending");
            assert_eq!(
                residue(&su, f.workspace).await,
                before,
                "{drift} {action:?}"
            );
            let after: Option<Vec<Uuid>> = sqlx::query_scalar("SELECT approved_channel_ids FROM hosted_agent_connection WHERE workspace_id=$1 AND id=$2")
                .bind(f.workspace).bind(f.hosted_connection).fetch_optional(&su).await.unwrap();
            assert_eq!(after, coverage);
            assert_eq!(pins_in(&su, f.channel).await, pins);
            let audits: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE workspace_id=$1 AND detail->>'approval_id'=$2")
                .bind(f.workspace).bind(trial.approval.to_string()).fetch_one(&su).await.unwrap();
            assert_eq!(audits, 0, "no domain or decision audit");
        }
    }
}

async fn seed_managed_create_approval(su: &PgPool, trial: &Trial) -> Uuid {
    let f = &trial.fixture;
    // A separate stored managed action: never rewrite an inbox-referenced run.
    let mut payload: Value = sqlx::query_scalar("SELECT payload FROM approval WHERE id=$1")
        .bind(trial.approval)
        .fetch_one(su)
        .await
        .unwrap();
    payload["proposed_by"] = json!(f.managed_agent);
    let run: Uuid = sqlx::query_scalar("INSERT INTO agent_run(workspace_id,agent_member_id,channel_id,status) VALUES($1,$2,$3,'awaiting_approval') RETURNING id")
        .bind(f.workspace).bind(f.managed_agent).bind(f.channel).fetch_one(su).await.unwrap();
    sqlx::query_scalar::<_, Uuid>("INSERT INTO approval(workspace_id,run_id,channel_id,requested_by,action_type,payload,status,expires_at) VALUES($1,$2,$3,$4,'workspace_action',$5,'pending',now()+interval '1 hour') RETURNING id")
        .bind(f.workspace).bind(run).bind(f.channel).bind(f.managed_agent).bind(payload).fetch_one(su).await.unwrap()
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn managed_human_requested_create_needs_no_hosted_connection() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let base = start_server(momo_app_pool().await, true).await;
    let client = reqwest::Client::new();
    let trial = propose(&su, &client, &base, Action::Create).await;
    let f = &trial.fixture;
    let approval = seed_managed_create_approval(&su, &trial).await;
    let (status, answer) = approve(&client, &base, f, approval).await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(approval_status(&su, approval).await, "approved");
    let created: Uuid =
        sqlx::query_scalar("SELECT id FROM channel WHERE workspace_id=$1 AND name=$2")
            .bind(f.workspace)
            .bind(&trial.name)
            .fetch_one(&su)
            .await
            .unwrap();
    let members: Vec<Uuid> = sqlx::query_scalar("SELECT member_id FROM membership WHERE workspace_id=$1 AND channel_id=$2 AND left_at IS NULL ORDER BY member_id")
        .bind(f.workspace).bind(created).fetch_all(&su).await.unwrap();
    let mut expected = vec![f.human, f.managed_agent, trial.guest];
    expected.sort();
    assert_eq!(members, expected);
    assert!(
        audit_details_of(&su, f.workspace, "hosted_connection.channels_granted")
            .await
            .is_empty()
    );
    assert_eq!(
        audit_details_of(&su, f.workspace, "action.approved")
            .await
            .len(),
        1
    );
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_hosted_sentinel_without_a_connection_cannot_be_classified_as_managed() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let f = seed(&su).await;
    // A ledger-less sentinel, without deleting any protected connection history.
    sqlx::query("UPDATE agent SET config=jsonb_set(config,'{execution_mode}','\"hosted_dial_in\"') WHERE workspace_id=$1 AND member_id=$2")
        .bind(f.workspace).bind(f.managed_agent).execute(&su).await.unwrap();
    let state = momo_db::with_tenant_tx(&momo_app_pool().await, f.workspace, move |conn| {
        Box::pin(async move {
            let state =
                momo_auth::hosted_action_connection_in_tx(conn, f.workspace, f.managed_agent)
                    .await?;
            Ok::<_, momo_db::DbError>(state)
        })
    })
    .await
    .unwrap();
    assert_eq!(state, momo_auth::HostedActionConnection::Unavailable);
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_converted_personal_agent_keeps_its_managed_action_path_despite_hosted_history() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let base = start_server(momo_app_pool().await, true).await;
    let client = reqwest::Client::new();
    let trial = propose(&su, &client, &base, Action::Create).await;
    let f = &trial.fixture;
    // Convert an uncredentialed subscription sentinel through the real D7
    // transition, then seed a NEW managed proposal. A protected hosted run is
    // never rewritten or carried across the conversion.
    sqlx::query("UPDATE agent SET base_url='https://hosted-agent.invalid/disabled', config=jsonb_set(config,'{execution_mode}','\"hosted_dial_in\"'), invocation_scope='owner_only', subscription_harness='codex' WHERE workspace_id=$1 AND member_id=$2")
        .bind(f.workspace).bind(f.managed_agent).execute(&su).await.unwrap();
    let (workspace, agent, human) = (f.workspace, f.managed_agent, f.human);
    let handle = hosted_handle(&su, agent).await;
    let history = momo_db::with_tenant_tx(&momo_app_pool().await, workspace, move |conn| {
        let handle = handle.clone();
        Box::pin(async move {
            let pending =
                momo_auth::create_hosted_connection_in_tx(conn, workspace, agent, human).await?;
            let report = momo_agent::subscription_transition::run_in_tx(
                conn,
                workspace,
                momo_agent::subscription_transition::Transition::Convert,
                &handle,
                true,
                "isolated fixture conversion",
                "isolated-pg",
            )
            .await?
            .expect("the subscription sentinel");
            assert!(report.changes.marked, "the real conversion ran");
            Ok::<_, momo_db::DbError>(pending.connection.id)
        })
    })
    .await
    .unwrap();
    let approval = seed_managed_create_approval(&su, &trial).await;
    let (status, answer) = approve(&client, &base, f, approval).await;
    assert_eq!(status, 200, "{answer}");
    let created: Uuid =
        sqlx::query_scalar("SELECT id FROM channel WHERE workspace_id=$1 AND name=$2")
            .bind(f.workspace)
            .bind(&trial.name)
            .fetch_one(&su)
            .await
            .unwrap();
    let seated: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM membership WHERE workspace_id=$1 AND channel_id=$2 AND member_id=$3 AND left_at IS NULL)")
        .bind(f.workspace).bind(created).bind(f.managed_agent).fetch_one(&su).await.unwrap();
    assert!(seated);
    let covered: bool = sqlx::query_scalar("SELECT $3=ANY(approved_channel_ids) FROM hosted_agent_connection WHERE workspace_id=$1 AND id=$2")
        .bind(f.workspace).bind(history).bind(created).fetch_one(&su).await.unwrap();
    assert!(!covered);
    assert!(
        audit_details_of(&su, f.workspace, "hosted_connection.channels_granted")
            .await
            .is_empty()
    );
    assert_eq!(approval_status(&su, approval).await, "approved");
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn human_requested_create_rechecks_a_connection_ended_while_waiting_for_its_lock() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let base = start_server(momo_app_pool().await, true).await;
    let client = reqwest::Client::new();
    for revoked in [false, true] {
        let trial = propose(&su, &client, &base, Action::Create).await;
        let f = &trial.fixture;
        let before = residue(&su, f.workspace).await;
        let mut holder = su.begin().await.unwrap();
        sqlx::query(
            "SELECT id FROM hosted_agent_connection WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        )
        .bind(f.workspace)
        .bind(f.hosted_connection)
        .fetch_one(&mut *holder)
        .await
        .unwrap();
        let holder_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *holder)
            .await
            .unwrap();
        let tap = tokio::spawn({
            let (client, base, jwt, workspace, approval) = (
                client.clone(),
                base.clone(),
                f.human_jwt.clone(),
                f.workspace,
                trial.approval,
            );
            async move {
                decide_as(
                    &client,
                    &base,
                    workspace,
                    &jwt,
                    approval,
                    true,
                    Uuid::new_v4(),
                )
                .await
            }
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            let waiting: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)))",
            ).bind(holder_pid).fetch_one(&su).await.unwrap();
            if waiting {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the decision must wait for the connection lock"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        if revoked {
            sqlx::query("UPDATE token SET revoked_at=now() WHERE workspace_id=$1 AND id=$2")
                .bind(f.workspace)
                .bind(f.hosted_token)
                .execute(&mut *holder)
                .await
                .unwrap();
        } else {
            disconnect_in_tx(&mut holder, f).await;
        }
        holder.commit().await.unwrap();
        let (status, _, answer) = tap.await.unwrap();
        assert_eq!(status, 409, "revoked={revoked}: {answer}");
        assert_eq!(answer["status"], "action_args_invalid");
        assert_eq!(approval_status(&su, trial.approval).await, "pending");
        assert_eq!(residue(&su, f.workspace).await, before);
        assert!(
            audit_details_of(&su, f.workspace, "hosted_connection.channels_granted")
                .await
                .is_empty()
        );
    }
}
