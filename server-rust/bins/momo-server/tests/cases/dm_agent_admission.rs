//! #4792 / ADR-0217. Dedicated PG, real HTTP, real NOBYPASSRLS reads.
use super::*;

struct Fixture {
    su: PgPool,
    app: PgPool,
    tenant: Tenant,
    agent: Uuid,
    peer: Uuid,
    channel: Uuid,
    http: reqwest::Client,
    base: String,
    caller_token: String,
    peer_token: String,
}
impl Fixture {
    async fn new() -> Self {
        ensure_schema_and_roles();
        let su = superuser_pool().await;
        let app = role_pool("momo_app", &momo_app_password()).await;
        let tenant = seed_tenant(&su, &app).await;
        let agent = seed_agent(&su, &tenant, "consent-agent", false).await;
        let peer = Uuid::new_v4();
        sqlx::query("INSERT INTO member (id,workspace_id,kind,display_name,handle) VALUES ($1,$2,'human','Peer',$3)").bind(peer).bind(tenant.workspace).bind(peer.to_string()).execute(&su).await.unwrap();
        let email = format!("{peer}@dm-admission.test");
        sqlx::query("INSERT INTO human (member_id,workspace_id,email,password_hash) VALUES ($1,$2,$3,momo_password_hash($4))").bind(peer).bind(tenant.workspace).bind(&email).bind(TEST_PASSWORD).execute(&su).await.unwrap();
        sqlx::query("INSERT INTO workspace_membership (workspace_id,member_id,role) VALUES ($1,$2,'member')").bind(tenant.workspace).bind(peer).execute(&su).await.unwrap();
        let state = AppState::new(
            app.clone(),
            TEST_JWT_SECRET.to_string(),
            "ws://127.0.0.1:8000/connection/websocket",
        )
        .with_agent_port(momo_server::config::AgentPortConfig {
            hosted_delivery_enabled: true,
            ..Default::default()
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            axum::serve(listener, build_app(state)).await.unwrap();
        });
        let http = reqwest::Client::new();
        let caller_token = login(&http, &base, &tenant).await;
        let other = Tenant {
            workspace: tenant.workspace,
            human: peer,
            email,
            channel: tenant.channel,
        };
        let peer_token = login(&http, &base, &other).await;
        let channel = seed_dm(&su, &tenant, tenant.human, peer).await;
        Self {
            su,
            app,
            tenant,
            agent,
            peer,
            channel,
            http,
            base,
            caller_token,
            peer_token,
        }
    }
    async fn third(&self) -> (Uuid, String) {
        let id = Uuid::new_v4();
        let email = format!("{id}@dm-admission.test");
        sqlx::query("INSERT INTO member(id,workspace_id,kind,display_name,handle) VALUES($1,$2,'human','Third',$3)").bind(id).bind(self.tenant.workspace).bind(id.to_string()).execute(&self.su).await.unwrap();
        sqlx::query("INSERT INTO human(member_id,workspace_id,email,password_hash) VALUES($1,$2,$3,momo_password_hash($4))").bind(id).bind(self.tenant.workspace).bind(&email).bind(TEST_PASSWORD).execute(&self.su).await.unwrap();
        sqlx::query(
            "INSERT INTO workspace_membership(workspace_id,member_id,role) VALUES($1,$2,'member')",
        )
        .bind(self.tenant.workspace)
        .bind(id)
        .execute(&self.su)
        .await
        .unwrap();
        sqlx::query("INSERT INTO membership(workspace_id,channel_id,member_id) VALUES($1,$2,$3)")
            .bind(self.tenant.workspace)
            .bind(self.channel)
            .bind(id)
            .execute(&self.su)
            .await
            .unwrap();
        let token = login(
            &self.http,
            &self.base,
            &Tenant {
                workspace: self.tenant.workspace,
                human: id,
                email,
                channel: self.channel,
            },
        )
        .await;
        (id, token)
    }
    async fn card_for(&self, person: Uuid) -> Uuid {
        sqlx::query_scalar("SELECT id FROM approval WHERE workspace_id=$1 AND payload->'action'->'pins'->>'target'=$2 AND status='pending' ORDER BY created_at DESC LIMIT 1").bind(self.tenant.workspace).bind(person.to_string()).fetch_one(&self.su).await.unwrap()
    }
    async fn say(&self, body: &str) -> Value {
        send_in_channel(
            &self.http,
            &self.base,
            &self.caller_token,
            &self.tenant,
            self.channel,
            Uuid::new_v4(),
            body,
        )
        .await
    }
    async fn propose(&self) -> Uuid {
        self.say("@consent-agent help with this message only until consent")
            .await;
        sqlx::query_scalar("SELECT id FROM approval WHERE workspace_id = $1 AND channel_id = $2 AND payload->>'origin' = 'dm_agent_admission' ORDER BY created_at DESC LIMIT 1").bind(self.tenant.workspace).bind(self.channel).fetch_one(&self.su).await.unwrap()
    }
    async fn decide(&self, id: Uuid, approve: bool, token: &str) -> reqwest::Response {
        self.http
            .post(format!(
                "{}/v1/workspaces/{}/approvals/{id}/decision",
                self.base, self.tenant.workspace
            ))
            .bearer_auth(token)
            .json(&json!({"approvalId":id,"approve":approve,"clientDecisionId":Uuid::new_v4()}))
            .send()
            .await
            .unwrap()
    }
    async fn pending_tool(&self) -> (Uuid, Uuid, Uuid) {
        let (ws, channel, agent) = (self.tenant.workspace, self.channel, self.agent);
        momo_db::with_tenant_tx(&self.app, ws, move |conn| Box::pin(async move {
            let run = Uuid::new_v4();
            sqlx::query("INSERT INTO agent_run(id,workspace_id,agent_member_id,channel_id,status,input,idempotency_key) VALUES($1,$2,$3,$4,'awaiting_approval','{}',$5)")
                .bind(run).bind(ws).bind(agent).bind(channel).bind(format!("r2:{run}")).execute(&mut *conn).await?;
            let approval = momo_agent::approval::create_pending_approval_in_tx(conn, ws, momo_agent::approval::NewApproval {
                run_id: run, channel_id: channel, requested_by: agent, action_type: "tool_call".into(),
                payload: json!({"tool_call":{"call_id":run.to_string(),"name":"github.search_issues","arguments":{}}}),
                expires_at: chrono::Utc::now()+chrono::Duration::hours(1),
            }).await?;
            let mut message = momo_messaging::NewMessage::text(channel, agent, "approval card");
            message.message_type = momo_messaging::MessageType::ApprovalRequest;
            message.run_id = Some(run);
            message.props = json!({"approval_id":approval,"status":"pending","last_attempt":"role_required"});
            let card = momo_messaging::send_message_in_tx(conn,ws,message).await?.message.id;
            momo_agent::approval::attach_request_message_in_tx(conn,ws,approval,card).await?;
            momo_outbox::emit_outbox(conn,ws,momo_outbox::OutboxKind::AgentJob,"publish",&json!({"run_id":run,"channel_id":channel,"agent_member_id":agent}),Some(agent)).await?;
            Ok((run,approval,card))
        })).await.unwrap()
    }
    async fn assert_cancelled(&self, run: Uuid, approval: Uuid, card: Uuid) {
        let (status, by, reason): (String, Option<Uuid>, Option<String>) = sqlx::query_as(
            "SELECT status::text,decided_by,decision_reason FROM approval WHERE id=$1",
        )
        .bind(approval)
        .fetch_one(&self.su)
        .await
        .unwrap();
        assert_eq!(
            status, "cancelled",
            "departure uses standard approval cancellation"
        );
        assert_eq!(by, None);
        assert_eq!(
            reason.as_deref(),
            Some(momo_agent::approval::RUN_CANCELLED_DECISION_REASON)
        );
        let (status, last_attempt): (String, bool) = sqlx::query_as(
            "SELECT props->>'status',props ? 'last_attempt' FROM message WHERE id=$1",
        )
        .bind(card)
        .fetch_one(&self.su)
        .await
        .unwrap();
        assert_eq!(status, "cancelled", "the durable card is terminal too");
        assert!(!last_attempt);
        let status: String = sqlx::query_scalar("SELECT status::text FROM agent_run WHERE id=$1")
            .bind(run)
            .fetch_one(&self.su)
            .await
            .unwrap();
        assert_eq!(status, "cancelled");
        let pending: i64 = sqlx::query_scalar("SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='agent_job' AND payload->>'run_id'=$2 AND status IN ('pending','processing')")
            .bind(self.tenant.workspace).bind(run.to_string()).fetch_one(&self.su).await.unwrap();
        assert_eq!(pending, 0, "the cancelled run has no deliverable job");
    }
    async fn seats(&self) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM membership WHERE workspace_id = $1 AND channel_id = $2 AND member_id = $3 AND left_at IS NULL").bind(self.tenant.workspace).bind(self.channel).bind(self.agent).fetch_one(&self.su).await.unwrap()
    }
    async fn read_as_agent(&self) -> Vec<String> {
        let ws = self.tenant.workspace;
        let channel = self.channel;
        momo_db::tenant::REQUEST_AGENT_MEMBER.scope(self.agent,momo_db::with_tenant_tx(&self.app,ws,move |conn|Box::pin(async move {
            Ok(sqlx::query_scalar("SELECT COALESCE(body,'') FROM message WHERE channel_id=$1 ORDER BY seq").bind(channel).fetch_all(conn).await?)
        }))).await.unwrap()
    }
    async fn admit(&self) {
        let id = self.propose().await;
        let r = self.decide(id, true, &self.peer_token).await;
        let status = r.status();
        let body = r.text().await.unwrap();
        assert_eq!(status, 200, "{body}");
        assert_eq!(
            self.seats().await,
            1,
            "all-human consent seats exactly one agent"
        );
    }
    async fn remove(&self) {
        let r = self
            .http
            .delete(format!(
                "{}/v1/workspaces/{}/channels/{}/dm-agents/{}",
                self.base, self.tenant.workspace, self.channel, self.agent
            ))
            .bearer_auth(&self.peer_token)
            .send()
            .await
            .unwrap();
        let status = r.status();
        let body = r.text().await.unwrap();
        assert_eq!(status, 200, "{body}");
    }
}

#[tokio::test]
#[ignore = "dedicated real PG"]
async fn dm_admission_before_consent_has_no_seat_or_job_and_cannot_be_self_approved() {
    let f = Fixture::new().await;
    let id = f.propose().await;
    assert_eq!(f.seats().await, 0, "no seat before consent");
    let spoof=f.http.post(format!("{}/v1/workspaces/{}/channels/{}/messages",f.base,f.tenant.workspace,f.channel)).bearer_auth(&f.caller_token)
        .json(&json!({"clientMsgId":Uuid::new_v4(),"type":"system","body":"fixture announcement","props":{"kind":"dm_agent_membership","origin":"dm_agent_admission"}})).send().await.unwrap();
    assert_eq!(spoof.status(), 201);
    let spoof: Value = spoof.json().await.unwrap();
    assert!(
        spoof["id"].is_string(),
        "the actual send projection is being checked"
    );
    assert!(
        spoof["props"]["kind"].is_null(),
        "a caller cannot forge a membership announcement"
    );
    let ws = f.tenant.workspace;
    let foreign_count: i64 = momo_db::with_tenant_tx(&f.app, Uuid::new_v4(), move |conn| {
        Box::pin(async move {
            Ok(
                sqlx::query_scalar("SELECT count(*) FROM dm_agent_admission WHERE workspace_id=$1")
                    .bind(ws)
                    .fetch_one(conn)
                    .await?,
            )
        })
    })
    .await
    .unwrap();
    assert_eq!(foreign_count, 0, "consent requests retain tenant isolation");

    let jobs: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='agent_job'",
    )
    .bind(f.tenant.workspace)
    .fetch_one(&f.su)
    .await
    .unwrap();
    assert_eq!(jobs, 0, "no prompt leaves the server before consent");
    assert_eq!(
        f.decide(id, true, &f.caller_token).await.status(),
        403,
        "inviter/admin cannot impersonate peer consent"
    );
    assert!(
        f.read_as_agent().await.is_empty(),
        "unseated agent reads nothing"
    );
    // Generic admin membership editing must continue to refuse this DM.
    let r = f
        .http
        .post(format!(
            "{}/v1/workspaces/{}/channels/{}/members",
            f.base, f.tenant.workspace, f.channel
        ))
        .bearer_auth(&f.caller_token)
        .json(&json!({"memberId":f.agent}))
        .send()
        .await
        .unwrap();
    assert!(
        !r.status().is_success(),
        "ordinary membership route cannot bypass consent"
    );
    assert_eq!(f.seats().await, 0);
}

#[tokio::test]
#[ignore = "dedicated real PG"]
async fn dm_admission_rejection_or_expiry_never_seats() {
    for expired in [false, true] {
        let f = Fixture::new().await;
        let id = f.propose().await;
        if expired {
            sqlx::query("UPDATE dm_agent_admission SET expires_at=now()-interval '1 second' WHERE workspace_id=$1").bind(f.tenant.workspace).execute(&f.su).await.unwrap();
        }
        let r = f.decide(id, expired, &f.peer_token).await;
        let status = r.status();
        let body = r.text().await.unwrap();
        assert_eq!(status, 200, "decision settles: {body}");
        assert_eq!(
            f.seats().await,
            0,
            "one rejection or expiry closes the request"
        );
    }
}

#[tokio::test]
#[ignore = "dedicated real PG"]
async fn dm_admission_time_and_sequence_floor_filter_history_and_worker_context() {
    let f = Fixture::new().await;
    let private = f.say("PRIVATE BEFORE CONSENT").await;
    let private_id = private["id"].as_str().expect("stored private message id");
    f.admit().await;
    let quoted=f.http.post(format!("{}/v1/workspaces/{}/channels/{}/messages",f.base,f.tenant.workspace,f.channel)).bearer_auth(&f.caller_token)
        .json(&json!({"clientMsgId":Uuid::new_v4(),"body":"new quoted message","replyToId":private_id})).send().await.unwrap();
    assert_eq!(quoted.status(), 201);
    f.say("VISIBLE AFTER CONSENT").await;
    let bearer = agent_bearer(&f.su, &f.tenant, f.agent).await;
    sqlx::query("UPDATE token SET scopes=ARRAY['messages:read','messages:write'] WHERE workspace_id=$1 AND actor_member_id=$2").bind(f.tenant.workspace).bind(f.agent).execute(&f.su).await.unwrap();
    let response = f
        .http
        .get(format!(
            "{}/v1/workspaces/{}/channels/{}/messages",
            f.base, f.tenant.workspace, f.channel
        ))
        .bearer_auth(&bearer)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let wire = response.text().await.unwrap();
    assert!(
        !wire.contains("PRIVATE BEFORE"),
        "real REST agent authentication installs the read floor"
    );
    let bodies = f.read_as_agent().await;
    assert!(
        !bodies.iter().any(|b| b.contains("PRIVATE BEFORE")),
        "pre-admission history must stay private"
    );
    assert!(
        bodies.iter().any(|b| b.contains("VISIBLE AFTER")),
        "subsequent conversation is visible"
    );
    assert!(
        bodies.iter().any(|b| b.contains("help with this message")),
        "exact calling message is the only exception"
    );
    let ws = f.tenant.workspace;
    let channel = f.channel;
    let agent = f.agent;
    let trigger:Uuid=sqlx::query_scalar("SELECT trigger_message_id FROM dm_agent_admission WHERE workspace_id=$1 AND admitted_at IS NOT NULL").bind(ws).fetch_one(&f.su).await.unwrap();
    let window = momo_db::with_tenant_tx(&f.su, ws, move |conn| {
        Box::pin(async move {
            momo_messaging::agent_context_window_for_member_in_tx(
                conn,
                channel,
                trigger,
                200,
                Some(agent),
            )
            .await
        })
    })
    .await
    .unwrap();
    assert!(
        !serde_json::to_string(&window)
            .unwrap()
            .contains("PRIVATE BEFORE"),
        "BYPASSRLS worker uses the same explicit floor"
    );
    // Each half is necessary: an attacker can backdate a post-cutover seq or
    // raise an old message's timestamp; neither becomes history consent.
    sqlx::query("UPDATE message SET created_at=now()+interval '1 day' WHERE workspace_id=$1 AND body='PRIVATE BEFORE CONSENT'").bind(ws).execute(&f.su).await.unwrap();
    assert!(
        !f.read_as_agent()
            .await
            .iter()
            .any(|b| b.contains("PRIVATE BEFORE")),
        "seq floor also protects timestamp edits"
    );
    sqlx::query("UPDATE message SET created_at='2000-01-01' WHERE workspace_id=$1 AND body='VISIBLE AFTER CONSENT'").bind(ws).execute(&f.su).await.unwrap();
    assert!(
        !f.read_as_agent()
            .await
            .iter()
            .any(|b| b.contains("VISIBLE AFTER")),
        "timestamp floor is enforced independently"
    );
}

#[tokio::test]
#[ignore = "dedicated real PG"]
async fn dm_admission_an_unseated_agent_cannot_write_in_an_admitted_room() {
    let f = Fixture::new().await;
    f.admit().await;
    let stranger = seed_agent(&f.su, &f.tenant, "not-consented", false).await;
    let (ws, channel) = (f.tenant.workspace, f.channel);
    let result = momo_db::with_tenant_tx(&f.su, ws, move |conn| {
        Box::pin(async move {
            momo_messaging::send_message_in_tx(
                conn,
                ws,
                momo_messaging::NewMessage::text(channel, stranger, "not seated".to_string()),
            )
            .await
        })
    })
    .await;
    let error = result.expect_err("no admission row must not bypass an admitted room's gate");
    assert!(
        error
            .to_string()
            .contains("agent is not an active DM member"),
        "{error}"
    );
}

#[tokio::test]
#[ignore = "dedicated real PG"]
async fn dm_admission_server_card_updates_survive_departure_but_agent_edits_do_not() {
    let f = Fixture::new().await;
    f.admit().await;
    let (_, _, card) = f.pending_tool().await;
    f.remove().await;
    let (ws, agent) = (f.tenant.workspace, f.agent);
    momo_db::with_tenant_tx(&f.app, ws, move |conn| Box::pin(async move {
        // Server-owned card updates can include body as well as props.
        sqlx::query("UPDATE message SET body='closed by server', props=props || '{\"server_closed\":true}'::jsonb WHERE id=$1")
            .bind(card).execute(&mut *conn).await?;
        Ok(())
    })).await.unwrap();
    let closed: bool = sqlx::query_scalar("SELECT body='closed by server' AND props->>'server_closed'='true' FROM message WHERE id=$1")
        .bind(card).fetch_one(&f.su).await.unwrap();
    assert!(
        closed,
        "server bookkeeping commits after the agent has left"
    );
    let edit = momo_db::tenant::REQUEST_AGENT_MEMBER
        .scope(
            agent,
            momo_db::with_tenant_tx(&f.app, ws, move |conn| {
                Box::pin(async move {
                    momo_messaging::edit_message_in_tx(
                        conn,
                        ws,
                        card,
                        agent,
                        "agent after departure",
                    )
                    .await
                })
            }),
        )
        .await
        .unwrap();
    assert!(
        edit.is_err(),
        "an authenticated agent cannot use the server UPDATE path"
    );
}

#[tokio::test]
#[ignore = "dedicated real PG"]
async fn dm_admission_remove_revokes_read_write_and_rejoin_resets_history() {
    let f = Fixture::new().await;
    f.admit().await;
    f.say("FIRST MEMBERSHIP").await;
    f.remove().await;
    assert_eq!(f.seats().await, 0);
    assert!(
        f.read_as_agent().await.is_empty(),
        "departure revokes every read immediately"
    );
    let ws = f.tenant.workspace;
    let channel = f.channel;
    let agent = f.agent;
    let result = momo_db::with_tenant_tx(&f.su, ws, move |conn| {
        Box::pin(async move {
            momo_messaging::send_message_in_tx(
                conn,
                ws,
                momo_messaging::NewMessage {
                    channel_id: channel,
                    author_member_id: agent,
                    message_type: momo_messaging::MessageType::Text,
                    body: Some("late answer".into()),
                    props: json!({}),
                    root_id: None,
                    reply_to_id: None,
                    client_msg_id: None,
                    run_id: None,
                    hlc_ts: None,
                    hlc_count: None,
                },
            )
            .await
        })
    })
    .await;
    assert!(
        result.is_err(),
        "even BYPASSRLS writer cannot publish after removal"
    );
    f.admit().await;
    assert!(
        !f.read_as_agent()
            .await
            .iter()
            .any(|b| b.contains("FIRST MEMBERSHIP")),
        "rejoining never reopens the previous seat's history"
    );
}

#[tokio::test]
#[ignore = "dedicated real PG"]
async fn dm_admission_group_requires_every_other_human_and_routes_only_mentions() {
    let f = Fixture::new().await;
    let third = Uuid::new_v4();
    sqlx::query("INSERT INTO member(id,workspace_id,kind,display_name,handle) VALUES($1,$2,'human','Third',$3)").bind(third).bind(f.tenant.workspace).bind(third.to_string()).execute(&f.su).await.unwrap();
    sqlx::query("INSERT INTO membership(workspace_id,channel_id,member_id) VALUES($1,$2,$3)")
        .bind(f.tenant.workspace)
        .bind(f.channel)
        .bind(third)
        .execute(&f.su)
        .await
        .unwrap();
    f.propose().await;
    let peer_card: Uuid = sqlx::query_scalar(
        "SELECT id FROM approval WHERE workspace_id=$1 AND payload->'action'->'pins'->>'target'=$2",
    )
    .bind(f.tenant.workspace)
    .bind(f.peer.to_string())
    .fetch_one(&f.su)
    .await
    .unwrap();
    assert_eq!(f.decide(peer_card, true, &f.peer_token).await.status(), 200);
    assert_eq!(
        f.seats().await,
        0,
        "one of two required peers is insufficient"
    );
    // Change of audience invalidates consent rather than silently shrinking quorum.
    sqlx::query("UPDATE membership SET left_at=now() WHERE channel_id=$1 AND member_id=$2")
        .bind(f.channel)
        .bind(third)
        .execute(&f.su)
        .await
        .unwrap();
    assert_eq!(f.seats().await, 0);
    let f = Fixture::new().await;
    f.admit().await;
    let before: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='agent_job'",
    )
    .bind(f.tenant.workspace)
    .fetch_one(&f.su)
    .await
    .unwrap();
    f.say("a conversation between people").await;
    let after: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='agent_job'",
    )
    .bind(f.tenant.workspace)
    .fetch_one(&f.su)
    .await
    .unwrap();
    assert_eq!(
        before, after,
        "group DM never auto-answers every human message"
    );
    f.say("@consent-agent now answer").await;
    let after: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='agent_job'",
    )
    .bind(f.tenant.workspace)
    .fetch_one(&f.su)
    .await
    .unwrap();
    assert_eq!(
        after,
        before + 1,
        "seated group DM member receives explicit calls"
    );
}

#[tokio::test]
#[ignore = "dedicated real PG"]
async fn dm_admission_owner_only_cannot_be_invited_by_a_teammate() {
    let f = Fixture::new().await;
    sqlx::query("UPDATE agent SET invocation_scope='owner_only',uses_owner_key=true,owner_human_id=$2 WHERE member_id=$1").bind(f.agent).bind(f.peer).execute(&f.su).await.unwrap();
    f.say("@consent-agent you must join").await;
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM dm_agent_admission WHERE workspace_id=$1")
            .bind(f.tenant.workspace)
            .fetch_one(&f.su)
            .await
            .unwrap();
    assert_eq!(count, 0, "inviter must be able to invoke this agent");
}

#[tokio::test]
#[ignore = "dedicated real PG"]
async fn dm_admission_every_person_must_agree_and_one_no_cancels_the_other_cards() {
    let f = Fixture::new().await;
    let (third, token) = f.third().await;
    f.propose().await;
    let a = f.card_for(f.peer).await;
    let b = f.card_for(third).await;
    // ADR-0204 증보 6 D6-2 · D6-3: a consent is read in the conversation, so the app decides it;
    // the card asks one question and quotes the agent's name after it, never inside it.
    let (card_body, card_props): (String, Value) = sqlx::query_as(
        "SELECT m.body, m.props FROM message m JOIN approval a ON a.request_message_id = m.id \
          WHERE a.id = $1",
    )
    .bind(a)
    .fetch_one(&f.su)
    .await
    .expect("the consent card");
    assert_eq!(card_props["decision_mode"], json!("open"));
    assert!(
        card_body.starts_with("에이전트를 이 대화에 들여도 될까요? · 「")
            && card_body.ends_with('」'),
        "{card_body}"
    );
    assert_eq!(f.decide(a, true, &f.peer_token).await.status(), 200);
    assert_eq!(
        f.seats().await,
        0,
        "one peer's vote is not the other peer's vote"
    );
    assert_eq!(f.decide(b, false, &token).await.status(), 200);
    assert_eq!(f.seats().await, 0, "one no wins over prior yes");
    f.propose().await;
    let a = f.card_for(f.peer).await;
    let b = f.card_for(third).await;
    assert_eq!(f.decide(a, true, &f.peer_token).await.status(), 200);
    assert_eq!(f.seats().await, 0);
    let r = f.decide(b, true, &token).await;
    let status = r.status();
    let body = r.text().await.unwrap();
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        f.seats().await,
        1,
        "last valid vote admits exactly one seat"
    );
}

#[tokio::test]
#[ignore = "dedicated real PG"]
async fn dm_admission_reproves_audience_and_invocation_before_spending_the_last_vote() {
    let f = Fixture::new().await;
    let id = f.propose().await;
    let _ = f.third().await;
    assert_eq!(
        f.decide(id, true, &f.peer_token).await.status(),
        403,
        "new participant invalidates the old audience"
    );
    assert_eq!(f.seats().await, 0);
    let f = Fixture::new().await;
    let id = f.propose().await;
    sqlx::query("INSERT INTO agent_profile(workspace_id,agent_member_id,paused,updated_by) VALUES($1,$2,true,$3) ON CONFLICT(agent_member_id) DO UPDATE SET paused=true").bind(f.tenant.workspace).bind(f.agent).bind(f.tenant.human).execute(&f.su).await.unwrap();
    assert_eq!(
        f.decide(id, true, &f.peer_token).await.status(),
        403,
        "a paused agent is re-proved at approval"
    );
    assert_eq!(f.seats().await, 0);
}

#[tokio::test]
#[ignore = "dedicated real PG"]
async fn dm_admission_concurrent_last_votes_queue_only_one_job() {
    let f = Fixture::new().await;
    let id = f.propose().await;
    let (a, b) = tokio::join!(
        f.decide(id, true, &f.peer_token),
        f.decide(id, true, &f.peer_token)
    );
    let mut statuses = vec![a.status().as_u16(), b.status().as_u16()];
    statuses.sort_unstable();
    assert_eq!(statuses, vec![200, 409]);
    assert_eq!(f.seats().await, 1);
    let jobs: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='agent_job'",
    )
    .bind(f.tenant.workspace)
    .fetch_one(&f.su)
    .await
    .unwrap();
    assert_eq!(
        jobs, 1,
        "a repeated or concurrent final consent never starts a second turn"
    );
}

#[tokio::test]
#[ignore = "dedicated real PG"]
async fn dm_admission_hosted_port_reads_only_the_consented_runtime_and_current_seat() {
    let f = Fixture::new().await;
    f.say("PRIVATE HOSTED BEFORE").await;
    sqlx::query("UPDATE agent SET model='hosted-agent',base_url='https://hosted-agent.invalid/disabled',config=jsonb_build_object('execution_mode','hosted_dial_in') WHERE member_id=$1").bind(f.agent).execute(&f.su).await.unwrap();
    sqlx::query(
        "INSERT INTO agent_profile(workspace_id,agent_member_id,updated_by) VALUES($1,$2,$3)",
    )
    .bind(f.tenant.workspace)
    .bind(f.agent)
    .bind(f.tenant.human)
    .execute(&f.su)
    .await
    .unwrap();
    let connection = Uuid::new_v4();
    let raw = format!(
        "momo_agent_v1.{}.{}{}",
        f.tenant.workspace,
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    );
    sqlx::query("INSERT INTO hosted_agent_connection(id,workspace_id,agent_member_id,status,created_by,pairing_consumed_at,detected_at,detected_by) VALUES($1,$2,$3,'detected',$4,now(),now(),$4)").bind(connection).bind(f.tenant.workspace).bind(f.agent).bind(f.tenant.human).execute(&f.su).await.unwrap();
    let token:Uuid=sqlx::query_scalar("INSERT INTO token(workspace_id,kind,actor_member_id,token_hash,scopes,label,credential_class,hosted_connection_id,audience,created_by) VALUES($1,'agent_bearer',$2,digest($3::text,'sha256'),ARRAY['agent:port:connect','messages:read','messages:write','agent:inbox:read','agent:jobs:read','agent:runs:callback'],'consent-test','hosted_active',$4,'/v1/mcp/agent-port',$5) RETURNING id").bind(f.tenant.workspace).bind(f.agent).bind(&raw).bind(connection).bind(f.tenant.human).fetch_one(&f.su).await.unwrap();
    sqlx::query("UPDATE hosted_agent_connection SET status='active',active_token_id=$2,pairing_consumed_at=now(),detected_at=now(),detected_by=$3,confirmed_by=$3,confirmed_at=now(),proved_at=now(),proved_by=$3,approved_scopes=ARRAY['agent:port:connect','messages:read','messages:write','agent:inbox:read','agent:jobs:read','agent:runs:callback'] WHERE id=$1").bind(connection).bind(token).bind(f.tenant.human).execute(&f.su).await.unwrap();
    async fn read(f: &Fixture, raw: &str) -> (u16, Value) {
        let tool = "oort_conversation_read";
        let r=f.http.post(format!("{}/v1/mcp/agent-port",f.base)).header("accept","application/json, text/event-stream").header("mcp-protocol-version","2026-07-28").header("mcp-method","tools/call").header("mcp-name",tool).bearer_auth(raw).json(&json!({"jsonrpc":"2.0","id":"consent-read","method":"tools/call","params":{"name":tool,"arguments":{"channelId":f.channel},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}})).send().await.unwrap();
        let status = r.status().as_u16();
        let text = r.text().await.unwrap();
        (status, serde_json::from_str(&text).unwrap())
    }
    let before = read(&f, &raw).await;
    assert_eq!(before.0, 409);
    assert_eq!(
        before.1["error"]["code"], -32004,
        "unseated hosted agent cannot read the human DM"
    );
    f.admit().await;
    f.say("HOSTED AFTER CONSENT").await;
    let page = read(&f, &raw).await;
    assert_eq!(page.0, 200, "{}", page.1);
    let text = page.1.to_string();
    assert!(
        !text.contains("PRIVATE HOSTED BEFORE"),
        "Agent Port respects the time/seq floor"
    );
    assert!(
        text.contains("HOSTED AFTER CONSENT"),
        "consented group DM now reaches the hosted agent"
    );
    let inbox: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_agent_inbox_event e JOIN message m ON m.workspace_id=e.workspace_id AND m.id=e.source_message_id WHERE e.workspace_id=$1 AND e.connection_id=$2 AND e.event_kind='message' AND m.body='HOSTED AFTER CONSENT'",
    )
    .bind(f.tenant.workspace)
    .bind(connection)
    .fetch_one(&f.su)
    .await
    .unwrap();
    assert!(
        inbox > 0,
        "subsequent group DM events reach the same hosted runtime"
    );
    // Even a live runtime cannot inherit this DM through another person's confirmation.
    sqlx::query("UPDATE hosted_agent_connection SET confirmed_by=$2 WHERE id=$1")
        .bind(connection)
        .bind(f.peer)
        .execute(&f.su)
        .await
        .unwrap();
    assert_eq!(
        read(&f, &raw).await.0,
        409,
        "runtime confirmation must still belong to the agent owner"
    );
    sqlx::query("UPDATE hosted_agent_connection SET confirmed_by=$2 WHERE id=$1")
        .bind(connection)
        .bind(f.tenant.human)
        .execute(&f.su)
        .await
        .unwrap();
    let single = seed_dm(&f.su, &f.tenant, f.tenant.human, f.agent).await;
    let (pending_run, approval, card) = f.pending_tool().await;
    f.remove().await;
    f.assert_cancelled(pending_run, approval, card).await;
    let references: i64=sqlx::query_scalar("SELECT count(*) FROM hosted_agent_inbox_event WHERE connection_id=$1 AND event_kind='agent_run' AND source_run_id=$2")
        .bind(connection).bind(pending_run).fetch_one(&f.su).await.unwrap();
    assert_eq!(
        references, 1,
        "the hosted runtime hears the standard run cancellation"
    );
    let removed = read(&f, &raw).await;
    assert_eq!(
        removed.0, 409,
        "removal withdraws hosted coverage immediately"
    );
    assert_eq!(removed.1["error"]["code"], -32004);
    let cover: Vec<Uuid> = momo_db::with_tenant_tx(&f.app, f.tenant.workspace, move |conn| {
        Box::pin(async move {
            Ok(
                sqlx::query_scalar("SELECT hosted_connection_channel_ids($1,$2)")
                    .bind(f.tenant.workspace)
                    .bind(connection)
                    .fetch_one(conn)
                    .await?,
            )
        })
    })
    .await
    .unwrap();
    assert!(!cover.contains(&f.channel));
    assert!(
        cover.contains(&single),
        "existing owner-human/agent 1:1 hosted coverage remains open"
    );
}

#[tokio::test]
#[ignore = "dedicated real PG"]
async fn dm_admission_retains_the_callers_routing_choice_and_rejects_invalid_choices_before_consent(
) {
    let f = Fixture::new().await;
    let response = f.http.post(format!("{}/v1/workspaces/{}/channels/{}/messages", f.base, f.tenant.workspace, f.channel))
        .bearer_auth(&f.caller_token).json(&json!({"clientMsgId":Uuid::new_v4(),"body":"@consent-agent help","routing":{"model":"not-an-allowed-model"}})).send().await.unwrap();
    assert_eq!(
        response.status(),
        400,
        "an invalid override rolls back the send before consent"
    );
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM dm_agent_admission WHERE workspace_id=$1")
            .bind(f.tenant.workspace)
            .fetch_one(&f.su)
            .await
            .unwrap();
    assert_eq!(count, 0);
    let response = f.http.post(format!("{}/v1/workspaces/{}/channels/{}/messages", f.base, f.tenant.workspace, f.channel))
        .bearer_auth(&f.caller_token).json(&json!({"clientMsgId":Uuid::new_v4(),"body":"@consent-agent help","routing":{"model":AGENT_MODEL}})).send().await.unwrap();
    assert_eq!(response.status(), 201);
    let held: Value = sqlx::query_scalar(
        "SELECT input FROM agent_run WHERE workspace_id=$1 AND status='awaiting_approval'",
    )
    .bind(f.tenant.workspace)
    .fetch_one(&f.su)
    .await
    .unwrap();
    assert_eq!(
        held["routing"]["model"], AGENT_MODEL,
        "the held request preserves the exact caller choice"
    );
    let card = f.card_for(f.peer).await;
    assert_eq!(f.decide(card, true, &f.peer_token).await.status(), 200);
    let input: Value =
        sqlx::query_scalar("SELECT input FROM agent_run WHERE workspace_id=$1 AND status='queued'")
            .bind(f.tenant.workspace)
            .fetch_one(&f.su)
            .await
            .unwrap();
    assert_eq!(
        input["routing"]["model"], AGENT_MODEL,
        "the admitted turn retains the caller override"
    );
}

#[tokio::test]
#[ignore = "dedicated real PG"]
async fn dm_admission_remove_cancels_pending_approvals_and_a_human_can_close_the_card() {
    let f = Fixture::new().await;
    f.admit().await;
    let (run, approval, card) = f.pending_tool().await;
    f.remove().await;
    f.assert_cancelled(run, approval, card).await;
    let response = f.decide(approval, false, &f.peer_token).await;
    assert_eq!(
        response.status(),
        200,
        "a click on the cancelled card is acknowledged"
    );
    let body: Value = response.json().await.unwrap();
    assert_eq!(
        body["status"], "cancelled",
        "a late click cannot resurrect the action"
    );
}

#[tokio::test]
#[ignore = "dedicated real PG"]
async fn dm_admission_member_suspend_and_retire_reuse_standard_cancellation() {
    for retire in [false, true] {
        let f = Fixture::new().await;
        f.admit().await;
        let (run, approval, card) = f.pending_tool().await;
        let url = format!(
            "{}/v1/workspaces/{}/members/{}",
            f.base, f.tenant.workspace, f.agent
        );
        let response = if retire {
            f.http.delete(url)
        } else {
            f.http.post(format!("{url}/suspend"))
        }
        .bearer_auth(&f.caller_token)
        .send()
        .await
        .unwrap();
        let status = response.status();
        let body = response.text().await.unwrap();
        assert_eq!(status, 200, "lifecycle retire={retire}: {body}");
        f.assert_cancelled(run, approval, card).await;
    }
}

#[tokio::test]
#[ignore = "dedicated real PG"]
async fn dm_admission_a_human_can_reject_a_legacy_orphan_after_departure() {
    for state in ["removed", "suspended", "deleted"] {
        let f = Fixture::new().await;
        f.admit().await;
        let (_, approval, card) = f.pending_tool().await;
        // Old deployments may have left a pending card behind. Exercise the
        // decision path itself, rather than relying on new departure cleanup.
        if state == "removed" {
            sqlx::query("UPDATE membership SET left_at=now() WHERE channel_id=$1 AND member_id=$2")
                .bind(f.channel)
                .bind(f.agent)
                .execute(&f.su)
                .await
                .unwrap();
            sqlx::query("UPDATE dm_agent_admission SET revoked_at=now() WHERE channel_id=$1")
                .bind(f.channel)
                .execute(&f.su)
                .await
                .unwrap();
        } else {
            sqlx::query("UPDATE member SET status=$2::member_status WHERE id=$1")
                .bind(f.agent)
                .bind(state)
                .execute(&f.su)
                .await
                .unwrap();
        }
        let response = f.decide(approval, false, &f.peer_token).await;
        let status = response.status();
        let body = response.text().await.unwrap();
        assert_eq!(
            status, 200,
            "the old card can be closed after {state}: {body}"
        );
        let closed: bool=sqlx::query_scalar("SELECT a.status='rejected' AND m.props->>'status'='rejected' FROM approval a JOIN message m ON m.id=a.request_message_id WHERE a.id=$1 AND m.id=$2")
            .bind(approval).bind(card).fetch_one(&f.su).await.unwrap();
        assert!(closed, "both the ledger and card close after {state}");
    }
}

#[tokio::test]
#[ignore = "dedicated real PG"]
async fn dm_admission_consent_cards_do_not_consume_the_agents_action_ceiling() {
    let f = Fixture::new().await;
    f.propose().await;
    let (ws, agent) = (f.tenant.workspace, f.agent);
    let counts = momo_db::with_tenant_tx(&f.app, ws, move |conn| {
        Box::pin(
            async move { momo_agent::count_pending_workspace_actions_in_tx(conn, ws, agent).await },
        )
    })
    .await
    .unwrap();
    assert_eq!(
        (counts.all, counts.unasked),
        (0, 0),
        "a real consent card is not an agent proposal"
    );
    let run: Uuid=sqlx::query_scalar("SELECT run_id FROM approval WHERE workspace_id=$1 AND payload->>'origin'='dm_agent_admission' LIMIT 1")
        .bind(ws).fetch_one(&f.su).await.unwrap();
    momo_db::with_tenant_tx(&f.app,ws,move |conn|Box::pin(async move {
        momo_agent::approval::create_pending_approval_in_tx(conn,ws,momo_agent::approval::NewApproval {
            run_id:run, channel_id:f.channel, requested_by:agent, action_type:"workspace_action".into(),
            payload:json!({"origin":"agent_initiated","action":{"id":"channel.create","args":{}}}),
            expires_at:chrono::Utc::now()+chrono::Duration::hours(1),
        }).await?;
        let counts=momo_agent::count_pending_workspace_actions_in_tx(conn,ws,agent).await?;
        assert_eq!((counts.all,counts.unasked),(1,1),"ordinary agent proposals still consume the ceiling");
        Ok(())
    })).await.unwrap();
}
