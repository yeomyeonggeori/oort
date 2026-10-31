//! #3982: exercise the production routes, expiry loop and push drain, with PG.
use super::*;
use momo_push::{DispatchOutcome, PushCandidate, PushDispatch, PushDispatcher};
use std::sync::{Arc, Mutex};

type CardIdentity = (
    i64,
    String,
    Option<chrono::DateTime<chrono::Utc>>,
    Option<Uuid>,
    Option<Uuid>,
    Option<Uuid>,
);

#[derive(Default)]
struct CapturedPushes(Mutex<Vec<PushDispatch>>);
#[async_trait::async_trait]
impl PushDispatcher for CapturedPushes {
    async fn dispatch(&self, dispatch: &PushDispatch) -> DispatchOutcome {
        self.0.lock().unwrap().push(dispatch.clone());
        DispatchOutcome::Accepted {
            apns_status: 200,
            apns_reason: None,
        }
    }
}

async fn device(su: &PgPool, ws: Uuid, member: Uuid) {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO device(id, workspace_id, member_id, platform) VALUES($1,$2,$3,'ios')")
        .bind(id)
        .bind(ws)
        .bind(member)
        .execute(su)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO push_token(workspace_id, device_id, member_id, apns_token, env, topic) \
        VALUES($1,$2,$3,$4,'sandbox','test.approval.outcome')",
    )
    .bind(ws)
    .bind(id)
    .bind(member)
    .bind(format!("{}{}", id.simple(), id.simple()))
    .execute(su)
    .await
    .unwrap();
}

async fn pending(
    su: &PgPool,
    client: &reqwest::Client,
    base: &str,
    f: &Fixture,
    tool: bool,
) -> (Uuid, Uuid, Uuid) {
    let (approval, card) = propose_invite(
        client,
        base,
        su,
        f,
        json!({"role":"member", "maxUses":1, "expiresInDays":7}),
    )
    .await;
    let run: Uuid = sqlx::query_scalar("SELECT run_id FROM approval WHERE id=$1")
        .bind(approval)
        .fetch_one(su)
        .await
        .unwrap();
    if tool {
        sqlx::query("UPDATE approval SET action_type='tool_call', payload=$2 WHERE id=$1")
            .bind(approval).bind(json!({"tool_call":{"call_id":"test-call", "name":"github.search_issues", "arguments":{}},
                "resume_model":"same_run_new_agent_job"}))
            .execute(su).await.unwrap();
        sqlx::query("UPDATE message SET props=(props - 'action') || '{\"action_type\":\"tool_call\"}'::jsonb WHERE id=$1")
            .bind(card).execute(su).await.unwrap();
    }
    (approval, card, run)
}

async fn candidate(su: &PgPool, card: Uuid) -> PushCandidate {
    let payload: String = sqlx::query_scalar(
        "SELECT payload::text FROM outbox WHERE kind='push_candidate' \
        AND payload->>'source'='approval_settled' AND payload->>'message_id'=$1",
    )
    .bind(card.to_string())
    .fetch_one(su)
    .await
    .expect("one settlement candidate");
    let object: Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(
        object.as_object().unwrap().len(),
        6,
        "id-only payload: {object}"
    );
    PushCandidate::decode(&payload).unwrap()
}

async fn targets(
    pool: &PgPool,
    ws: Uuid,
    candidate: &PushCandidate,
) -> Vec<momo_push::JudgedTarget> {
    let candidate = candidate.clone();
    momo_db::with_tenant_tx(pool, ws, move |conn| {
        Box::pin(async move { momo_push::judge_candidate_targets(conn, ws, &candidate).await })
    })
    .await
    .unwrap()
}

async fn assert_card(su: &PgPool, ws: Uuid, card: Uuid, status: &str, result: bool) {
    let (props, body): (Value, String) =
        sqlx::query_as("SELECT props, body FROM message WHERE id=$1")
            .bind(card)
            .fetch_one(su)
            .await
            .unwrap();
    assert_eq!(props["status"], status);
    assert_eq!(props["approval_status"], status);
    assert!(props["code"].is_string());
    assert!(props["decided_at_ms"].is_number());
    assert!(props.get("last_attempt").is_none());
    assert!(
        !body.contains("Tool call") && !body.contains("Approval"),
        "{body}"
    );
    if result {
        assert_eq!(props["result"]["line"], body);
        assert_eq!(
            props["result"]["status"],
            if status == "approved" {
                "executed"
            } else {
                status
            }
        );
    } else {
        assert!(
            props.get("result").is_none(),
            "resumed tools have no result yet: {props}"
        );
    }
    let frames: Vec<Value> = sqlx::query_scalar(
        "SELECT payload FROM outbox WHERE workspace_id=$1 \
        AND kind='broadcast' AND payload->'data'->>'type'='message.edited' \
        AND payload->'data'->'payload'->>'id'=$2",
    )
    .bind(ws)
    .bind(card.to_string())
    .fetch_all(su)
    .await
    .unwrap();
    assert_eq!(frames.len(), 1, "one full realtime frame: {frames:?}");
    assert_eq!(frames[0]["data"]["payload"]["props"], props);
    assert_eq!(frames[0]["data"]["payload"]["body"], body);
    let decisions: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id=$1 \
        AND kind='broadcast' AND payload->'data'->>'type'='approval.decided' \
        AND payload->'data'->'payload'->>'approval_id'=$2",
    )
    .bind(ws)
    .bind(props["approval_id"].as_str().unwrap())
    .fetch_one(su)
    .await
    .unwrap();
    assert_eq!(decisions, 1, "one approval.decided envelope");
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn all_five_terminal_paths_patch_one_card_for_actions_and_tools() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let notifier = momo_notifier_pool().await;
    let base = start_server(app.clone(), true).await;
    let client = reqwest::Client::new();
    for tool in [false, true] {
        for path in ["approved", "rejected", "sweep", "late_click", "cancelled"] {
            let f = seed(&su).await;
            let (approval, card, run) = pending(&su, &client, &base, &f, tool).await;
            let before: CardIdentity =
                sqlx::query_as("SELECT seq,state::text,edited_at,root_id,reply_to_id,client_msg_id FROM message WHERE id=$1")
                    .bind(card).fetch_one(&su).await.unwrap();
            let count = channel_message_count(&su, f.workspace, f.channel).await;
            let result_count: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM message WHERE workspace_id=$1 AND type='tool_result'",
            )
            .bind(f.workspace)
            .fetch_one(&su)
            .await
            .unwrap();
            if matches!(path, "sweep" | "late_click") {
                sqlx::query("UPDATE approval SET expires_at=now()-interval '1 minute' WHERE id=$1")
                    .bind(approval)
                    .execute(&su)
                    .await
                    .unwrap();
            }
            if path == "sweep" {
                let stats = momo_notifier::approval_sweep::sweep_expired_approvals(&notifier, 1000)
                    .await
                    .unwrap();
                assert!(stats.expired >= 1, "{stats:?}");
            } else if path == "cancelled" {
                for _ in 0..2 {
                    let response = client
                        .post(format!(
                            "{base}/v1/workspaces/{}/agent-runs/{run}/cancel",
                            f.workspace
                        ))
                        .bearer_auth(&f.human_jwt)
                        .send()
                        .await
                        .unwrap();
                    assert_eq!(
                        response.status().as_u16(),
                        200,
                        "{}",
                        response.text().await.unwrap()
                    );
                }
            } else {
                let key = Uuid::new_v4();
                for attempt in 0..2 {
                    let (status, _, receipt) = decide_as(
                        &client,
                        &base,
                        f.workspace,
                        &f.human_jwt,
                        approval,
                        path != "rejected",
                        key,
                    )
                    .await;
                    assert_eq!(
                        status,
                        if path == "late_click" && attempt == 0 {
                            409
                        } else {
                            200
                        },
                        "{receipt}"
                    );
                }
            }
            let status = if matches!(path, "sweep" | "late_click") {
                "expired"
            } else {
                path
            };
            assert_card(
                &su,
                f.workspace,
                card,
                status,
                !(tool && path == "approved"),
            )
            .await;
            let after: CardIdentity = sqlx::query_as("SELECT seq,state::text,edited_at,root_id,reply_to_id,client_msg_id FROM message WHERE id=$1")
                .bind(card).fetch_one(&su).await.unwrap();
            assert_eq!(
                before, after,
                "message identity/state/position preserved: {tool}/{path}"
            );
            let new_count = channel_message_count(&su, f.workspace, f.channel).await;
            assert_eq!(
                new_count - count,
                i64::from(path == "cancelled"),
                "no standalone outcome: {tool}/{path}"
            );
            let results: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM message WHERE workspace_id=$1 AND type='tool_result'",
            )
            .bind(f.workspace)
            .fetch_one(&su)
            .await
            .unwrap();
            assert_eq!(results, result_count, "no terminal tool_result INSERT");
            let candidates: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM outbox WHERE workspace_id=$1 AND kind='push_candidate' \
                AND payload->>'source'='approval_settled' AND payload->>'message_id'=$2",
            )
            .bind(f.workspace)
            .bind(card.to_string())
            .fetch_one(&su)
            .await
            .unwrap();
            assert_eq!(
                candidates,
                i64::from(path != "cancelled" && !(tool && path == "approved"))
            );
            // The body-only Agent Port reader still sees the terminal sentence.
            let (read_status, read) = call(
                &client,
                &base,
                &f.hosted_bearer,
                "oort_conversation_read",
                json!({"channelId": f.channel, "limit": 100}),
            )
            .await;
            assert_eq!(read_status, 200, "{read}");
            let body: String = sqlx::query_scalar("SELECT body FROM message WHERE id=$1")
                .bind(card)
                .fetch_one(&su)
                .await
                .unwrap();
            assert!(
                read.to_string().contains(&body),
                "body fallback survives Agent Port: {read}"
            );
        }
    }
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn settled_pushes_only_wake_the_requester_and_survive_prior_approval_dedupe() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let notifier = momo_notifier_pool().await;
    let base = start_server(app.clone(), true).await;
    let client = reqwest::Client::new();
    for path in ["approved", "rejected", "expired"] {
        let f = seed(&su).await;
        let admin_jwt = seed_plain_member(&su, &f).await;
        let decider: Uuid = sqlx::query_scalar(
            "SELECT actor_member_id FROM token WHERE token_hash=digest($1::text,'sha256')",
        )
        .bind(&admin_jwt)
        .fetch_one(&su)
        .await
        .unwrap();
        sqlx::query(
            "UPDATE workspace_membership SET role='admin' WHERE workspace_id=$1 AND member_id=$2",
        )
        .bind(f.workspace)
        .bind(decider)
        .execute(&su)
        .await
        .unwrap();
        let _bystander_jwt = seed_plain_member(&su, &f).await;
        let bystander: Uuid = sqlx::query_scalar(
            "SELECT actor_member_id FROM token WHERE token_hash=digest($1::text,'sha256')",
        )
        .bind(&_bystander_jwt)
        .fetch_one(&su)
        .await
        .unwrap();
        for person in [f.human, f.human, decider, bystander] {
            device(&su, f.workspace, person).await;
        }
        let (approval, card, _) = pending(&su, &client, &base, &f, false).await;
        sqlx::query("UPDATE message SET created_at=now()-interval '2 hours' WHERE id=$1")
            .bind(card)
            .execute(&su)
            .await
            .unwrap();
        let capture = Arc::new(CapturedPushes::default());
        let drain = momo_notifier::push::PushDrain::new(
            notifier.clone(),
            momo_notifier::PushConfig::for_target(),
            capture.clone(),
        );
        drain.drain_to_empty(1000).await;
        let proposal_key = momo_push::collapse_id(card);
        assert!(
            capture
                .0
                .lock()
                .unwrap()
                .iter()
                .any(|d| d.collapse_id == proposal_key),
            "proposal was pushed first"
        );
        // Seeing the old card must not suppress a later outcome when the requester is now away.
        sqlx::query(
            "INSERT INTO read_state(workspace_id,channel_id,member_id,last_read_seq,last_read_at) \
            VALUES($1,$2,$3,999999,now()-interval '1 hour') ON CONFLICT(channel_id,member_id) \
            DO UPDATE SET last_read_seq=999999,last_read_at=now()-interval '1 hour'",
        )
        .bind(f.workspace)
        .bind(f.channel)
        .bind(f.human)
        .execute(&su)
        .await
        .unwrap();
        if path == "expired" {
            sqlx::query("UPDATE approval SET expires_at=now()-interval '1 minute' WHERE id=$1")
                .bind(approval)
                .execute(&su)
                .await
                .unwrap();
            momo_notifier::approval_sweep::sweep_expired_approvals(&notifier, 1000)
                .await
                .unwrap();
        } else {
            let (status, _, body) = decide_as(
                &client,
                &base,
                f.workspace,
                &admin_jwt,
                approval,
                path == "approved",
                Uuid::new_v4(),
            )
            .await;
            assert_eq!(status, 200, "{body}");
        }
        let c = candidate(&su, card).await;
        let chosen = targets(&notifier, f.workspace, &c).await;
        assert_eq!(chosen.len(), 2, "one requester on two devices: {chosen:?}");
        for target in &chosen {
            assert_eq!(target.member_id, f.human);
            assert_eq!(target.reason, momo_push::PushReason::Mention);
            assert_eq!(target.category, momo_push::PushCategory::Mention);
            assert_eq!(target.approval_id, None);
        }
        assert_ne!(c.collapse_id(), proposal_key);
        assert!(c.collapse_id().len() <= 64);
        drain.drain_to_empty(1000).await;
        sqlx::query(
            "UPDATE outbox SET status='pending' WHERE kind='push_candidate' \
            AND payload->>'source'='approval_settled' AND payload->>'message_id'=$1",
        )
        .bind(card.to_string())
        .execute(&su)
        .await
        .unwrap();
        drain.drain_to_empty(1000).await;
        let sent = capture
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|d| d.collapse_id == c.collapse_id())
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(
            sent.len(),
            2,
            "exactly once per device, despite prior proposal and redelivery"
        );
        assert!(sent
            .iter()
            .all(|d| d.category == "momo.mention" && d.approval_id.is_none()));
        // Exclusive source branch: no approval/DM fallback for any other person,
        // forged card props cannot redirect the requester's server-owned run fact.
        sqlx::query("UPDATE message SET props=props || jsonb_build_object('answers_message_id',$2::text) WHERE id=$1")
            .bind(card).bind(Uuid::new_v4().to_string()).execute(&su).await.unwrap();
        assert_eq!(targets(&notifier, f.workspace, &c).await.len(), 2);
        sqlx::query(
            "INSERT INTO channel_viewing(workspace_id,channel_id,member_id) VALUES($1,$2,$3)",
        )
        .bind(f.workspace)
        .bind(f.channel)
        .bind(f.human)
        .execute(&su)
        .await
        .unwrap();
        assert!(
            targets(&notifier, f.workspace, &c).await.is_empty(),
            "looking at the conversation"
        );
        sqlx::query("DELETE FROM channel_viewing WHERE channel_id=$1")
            .bind(f.channel)
            .execute(&su)
            .await
            .unwrap();
        sqlx::query("UPDATE read_state SET last_read_at=now() WHERE channel_id=$1")
            .bind(f.channel)
            .execute(&su)
            .await
            .unwrap();
        assert!(
            targets(&notifier, f.workspace, &c).await.is_empty(),
            "recent read cursor"
        );
        sqlx::query(
            "UPDATE read_state SET last_read_at=now()-interval '1 hour' WHERE channel_id=$1",
        )
        .bind(f.channel)
        .execute(&su)
        .await
        .unwrap();
        sqlx::query("INSERT INTO notification_rule(workspace_id,member_id,dnd) VALUES($1,$2,true)")
            .bind(f.workspace)
            .bind(f.human)
            .execute(&su)
            .await
            .unwrap();
        assert!(targets(&notifier, f.workspace, &c).await.is_empty(), "DND");
        sqlx::query("UPDATE notification_rule SET dnd=false WHERE workspace_id=$1")
            .bind(f.workspace)
            .execute(&su)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO notification_pref(workspace_id,channel_id,member_id) VALUES($1,$2,$3)",
        )
        .bind(f.workspace)
        .bind(f.channel)
        .bind(f.human)
        .execute(&su)
        .await
        .unwrap();
        assert!(
            targets(&notifier, f.workspace, &c).await.is_empty(),
            "muted"
        );
        sqlx::query(
            "UPDATE notification_rule SET mention_overrides_mute=true WHERE workspace_id=$1",
        )
        .bind(f.workspace)
        .execute(&su)
        .await
        .unwrap();
        assert_eq!(
            targets(&notifier, f.workspace, &c).await.len(),
            2,
            "mention override"
        );
        if path != "expired" {
            sqlx::query("UPDATE approval SET decided_by=$2 WHERE id=$1")
                .bind(approval)
                .bind(f.human)
                .execute(&su)
                .await
                .unwrap();
            assert!(
                targets(&notifier, f.workspace, &c).await.is_empty(),
                "requester decided it themselves"
            );
        }
        sqlx::query("UPDATE membership SET left_at=now() WHERE channel_id=$1 AND member_id=$2")
            .bind(f.channel)
            .bind(f.human)
            .execute(&su)
            .await
            .unwrap();
        assert!(
            targets(&notifier, f.workspace, &c).await.is_empty(),
            "requester left the conversation"
        );
        assert!(
            targets(&notifier, Uuid::new_v4(), &c).await.is_empty(),
            "tenant scope"
        );
    }
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_sweep_racing_a_late_click_settles_the_card_and_push_once() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let notifier = momo_notifier_pool().await;
    let base = start_server(momo_app_pool().await, true).await;
    let client = reqwest::Client::new();
    for tool in [false, true] {
        for _ in 0..3 {
            let f = seed(&su).await;
            let (approval, card, _) = pending(&su, &client, &base, &f, tool).await;
            sqlx::query("UPDATE approval SET expires_at=now()-interval '1 minute' WHERE id=$1")
                .bind(approval)
                .execute(&su)
                .await
                .unwrap();
            let (sweep, (status, _, receipt)) = tokio::join!(
                momo_notifier::approval_sweep::sweep_expired_approvals(&notifier, 1000),
                decide_as(
                    &client,
                    &base,
                    f.workspace,
                    &f.human_jwt,
                    approval,
                    true,
                    Uuid::new_v4()
                )
            );
            sweep.unwrap();
            assert_eq!(status, 409, "{receipt}");
            assert_card(&su, f.workspace, card, "expired", true).await;
            candidate(&su, card).await; // fetch_one also rejects missing producer
            let count: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM outbox WHERE kind='push_candidate' \
                AND payload->>'source'='approval_settled' AND payload->>'message_id'=$1",
            )
            .bind(card.to_string())
            .fetch_one(&su)
            .await
            .unwrap();
            assert_eq!(count, 1);
        }
    }
}

#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_triggerless_run_never_produces_a_requester_notification() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let base = start_server(momo_app_pool().await, true).await;
    let client = reqwest::Client::new();
    for approve in [true, false] {
        let f = seed(&su).await;
        let (approval, card, run) = pending(&su, &client, &base, &f, false).await;
        sqlx::query("UPDATE agent_run SET trigger_message_id=NULL WHERE id=$1")
            .bind(run)
            .execute(&su)
            .await
            .unwrap();
        let (status, _, receipt) = decide_as(
            &client,
            &base,
            f.workspace,
            &f.human_jwt,
            approval,
            approve,
            Uuid::new_v4(),
        )
        .await;
        assert_eq!(status, 200, "{receipt}");
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM outbox WHERE kind='push_candidate' \
            AND payload->>'source'='approval_settled' AND payload->>'message_id'=$1",
        )
        .bind(card.to_string())
        .fetch_one(&su)
        .await
        .unwrap();
        assert_eq!(count, 0, "nobody requested this run");
    }
}

/// ADR-0204 증보 6 D6-2 · D6-3, from the real Agent Port producer: the card a proposal leaves
/// behind says **one question** (never the old 「승인 요청: …」, never English), quotes a channel's
/// name after the sentence and never inside it, and carries `props.decision_mode` — the word the
/// one function answers for the payload that was stored. A client reads that word; it does not
/// work the answer out again.
///
/// Revert: put `stamp_decision_mode` back out of the props at the producer, or write the body
/// from `action.title` again.
#[tokio::test]
#[ignore = "needs verifier-owned isolated PostgreSQL 18"]
async fn a_proposal_card_asks_one_question_and_carries_the_decision_mode() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let base = start_server(momo_app_pool().await, true).await;
    let client = reqwest::Client::new();
    for (action_id, args, body, mode) in [
        (
            "invite.create",
            json!({"role": "member", "maxUses": 1, "expiresInDays": 7}),
            "팀원 초대 링크를 만들어도 될까요?",
            "open",
        ),
        (
            "channel.create",
            json!({"name": "qa-asked", "kind": "private"}),
            "비공개 채널을 만들어도 될까요? · 「qa-asked」",
            "inline",
        ),
        (
            "channel.create",
            json!({"name": "team2", "kind": "public"}),
            "채널을 만들어도 될까요? · 「team2」",
            "inline",
        ),
    ] {
        let f = seed(&su).await;
        let (status, proposed) =
            try_propose_action_3706(&client, &base, &su, &f, action_id, args).await;
        assert_eq!(status, 200, "{action_id}: {proposed}");
        let approval = proposed_approval_3706(&proposed);
        let card = Uuid::parse_str(
            structured(&proposed)["cardMessageId"]
                .as_str()
                .expect("cardMessageId"),
        )
        .expect("uuid");
        let (card_body, props): (String, Value) =
            sqlx::query_as("SELECT body, props FROM message WHERE id=$1")
                .bind(card)
                .fetch_one(&su)
                .await
                .unwrap();
        assert_eq!(card_body, body, "{action_id}");
        assert!(
            !card_body.contains("승인 요청") && !card_body.contains("Approval required"),
            "{card_body}"
        );
        assert_eq!(props["decision_mode"], mode, "{action_id}");
        let (action_type, payload): (String, Value) =
            sqlx::query_as("SELECT action_type, payload FROM approval WHERE id=$1")
                .bind(approval)
                .fetch_one(&su)
                .await
                .unwrap();
        assert_eq!(
            momo_agent::actions::decision_mode(&action_type, &payload).as_str(),
            mode,
            "{action_id}: the card carries the one function's own answer"
        );
    }
}
