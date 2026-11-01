//! #5084 (a follow-up of #5066) — the progress rail says so when a run is parked on a person.
//!
//! Before this goal a run that stopped on an approval was `awaiting_approval` in the database and in the
//! progress read, while the rail's last word for it stayed `thinking / running`: a surface that reads
//! frames only said 「일하는 중」 until its own 90s cutoff. The producer now writes one
//! `(thinking, awaiting_approval)` frame in the park's own transaction, and these two tests are the
//! evidence that the frame is exactly one, that it is addressed to its own tenant's rail, and that every
//! way the hold can go on leaves the rail telling the truth.
//!
//! Real HTTP on `momo_app` (NOBYPASSRLS), the real worker in-process (`momo_worker`), the real expiry
//! sweep (`momo_notifier`); the rail is read from the `outbox` rows the relay would publish, so what is
//! asserted is the exact frame sequence a subscriber would receive, in the order it would receive it.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `t5084_1_a_parked_run_tells_the_rail_once_and_a_resumed_run_takes_it_back` | drop the worker's `emit_awaiting_approval_agent_status` (no frame), emit it before the card or outside the park's transaction, spell the frame `running`, drop the approval from its key (the second hold's frame would be eaten by Centrifugo's 5-minute cache), or give a resumed start the first start's key `thinking` (the frame that takes the rail off 승인 대기 would be eaten) |
//! | `t5084_2_rejecting_stopping_or_expiring_a_hold_leaves_the_rail_on_its_ending` | let any of the three endings skip its terminal frame, or emit a `running` frame after the wait |

use super::*;

/// The rule a frame-only client applies to a run's frames, quoted from `agentRail.ts` (`isRunOver`,
/// `turnStateOf`), so a sequence can be asserted as what the badge would say rather than as strings.
/// `agentRail.test.ts` pins the original.
fn rail_reads(phase: &str, run_status: &str) -> &'static str {
    if phase == "done"
        || phase == "error"
        || ["succeeded", "failed", "cancelled", "timed_out"].contains(&run_status)
    {
        return "over";
    }
    match run_status {
        "awaiting_approval" | "paused" => "awaiting_approval",
        "queued" => "queued",
        _ => "working",
    }
}

/// Every `agent.status` frame of one run, oldest first: `(phase, run_status, idempotency_key)`.
/// The run id rides the payload upper-cased (like Swift's `uuidString`), hence the `upper`.
async fn status_frames_of(
    su: &PgPool,
    workspace: Uuid,
    run: Uuid,
) -> Vec<(String, String, String)> {
    sqlx::query(
        "SELECT payload->'data'->'payload'->>'phase' AS phase, \
                payload->'data'->'payload'->>'run_status' AS run_status, \
                payload->>'idempotency_key' AS key \
           FROM outbox \
          WHERE workspace_id = $1 AND kind = 'broadcast' \
            AND payload->'data'->>'type' = 'agent.status' \
            AND upper(payload->'data'->'payload'->>'run_id') = upper($2::text) \
          ORDER BY id",
    )
    .bind(workspace)
    .bind(run.to_string())
    .fetch_all(su)
    .await
    .expect("read the run's rail frames")
    .into_iter()
    .map(|row| (row.get("phase"), row.get("run_status"), row.get("key")))
    .collect()
}

/// What the rail says about the run, frame by frame.
fn rail_story(frames: &[(String, String, String)]) -> Vec<&'static str> {
    frames
        .iter()
        .map(|(phase, status, _)| rail_reads(phase, status))
        .collect()
}

async fn approvals_of_run(su: &PgPool, run: Uuid) -> Vec<Uuid> {
    sqlx::query_scalar("SELECT id FROM approval WHERE run_id = $1 ORDER BY created_at, id")
        .bind(run)
        .fetch_all(su)
        .await
        .expect("read the run's approvals")
}

async fn run_state(su: &PgPool, run: Uuid) -> String {
    sqlx::query_scalar("SELECT status::text FROM agent_run WHERE id = $1")
        .bind(run)
        .fetch_one(su)
        .await
        .expect("read the run's status")
}

async fn decide(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    approval: Uuid,
    approve: bool,
) -> reqwest::Response {
    http.post(format!(
        "{base}/v1/workspaces/{workspace}/approvals/{approval}/decision"
    ))
    .bearer_auth(token)
    .json(&json!({
        "approval_id": approval,
        "approve": approve,
        "client_decision_id": Uuid::new_v4(),
    }))
    .send()
    .await
    .expect("decide")
}

async fn notifier_pool() -> PgPool {
    let password = std::env::var("MOMO_NOTIFIER_PASSWORD")
        .unwrap_or_else(|_| "momo_notifier_dev_pw".to_string());
    role_pool("momo_notifier", &password).await
}

/// A provider whose every call asks for a **new** tool call (a fresh id each time), so one run can be
/// parked, resumed and parked again.
struct ToolEveryTime(std::sync::atomic::AtomicUsize);

#[async_trait::async_trait]
impl ChatProvider for ToolEveryTime {
    async fn complete(
        &self,
        _endpoint: &momo_agent_worker::provider::ProviderEndpoint,
        _request: &momo_agent_worker::provider::ChatRequest,
    ) -> Result<
        momo_agent_worker::provider::ChatCompletion,
        momo_agent_worker::provider::ProviderError,
    > {
        let n = self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(momo_agent_worker::provider::ChatCompletion {
            web_search_requests: 0,
            text: String::new(),
            usage: None,
            tool_calls: vec![momo_agent_worker::provider::ProviderToolCall {
                id: format!("call_5084_{n}"),
                name: "work.session.end".to_string(),
                arguments: r#"{"session_id":"019f0000-0000-7000-8000-000000000001"}"#.to_string(),
            }],
        })
    }
}

struct Room {
    tenant: Tenant,
    agent: Uuid,
    token: String,
}

/// A workspace with an agent that has `work.session.end` switched on and a person who is signed in.
async fn room(su: &PgPool, app: &PgPool, http: &reqwest::Client, base: &str) -> Room {
    let tenant = seed_tenant(su, app).await;
    let agent = seed_agent(su, &tenant, "hermes", true).await;
    enable_tools(su, &tenant, agent, &["work.session.end"]).await;
    let token = login(http, base, &tenant).await;
    Room {
        tenant,
        agent,
        token,
    }
}

/// The person asks, the worker takes the turn, the model asks for a tool: the run is parked. Returns the
/// run.
async fn ask_and_park(
    su: &PgPool,
    http: &reqwest::Client,
    base: &str,
    room: &Room,
    provider: &Arc<ToolEveryTime>,
    text: &str,
) -> Uuid {
    send_message(http, base, &room.token, &room.tenant, Uuid::new_v4(), text).await;
    let run = runs_for(su, room.tenant.workspace)
        .await
        .last()
        .expect("the mention started a run")
        .0;
    worker(provider.clone())
        .await
        .drain_once()
        .await
        .expect("drain");
    assert_eq!(run_state(su, run).await, "awaiting_approval");
    run
}

/// **A parked run tells the rail exactly once, in its own tenant, behind its card; a resumed run takes
/// the rail back; a second hold is its own frame** (#5084).
///
/// Two tenants each park one run. The frame is read from the `outbox` the relay drains, as the
/// non-bypass role under each tenant's own scope, so the same rows are both what a subscriber would get
/// and what row-level security lets a tenant see.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn t5084_1_a_parked_run_tells_the_rail_once_and_a_resumed_run_takes_it_back() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let base = start_server(app_pool.clone()).await;
    let http = reqwest::Client::new();
    let a = room(&su, &app_pool, &http, &base).await;
    let b = room(&su, &app_pool, &http, &base).await;
    let provider = Arc::new(ToolEveryTime(std::sync::atomic::AtomicUsize::new(0)));

    // ---- one park, one frame ------------------------------------------------
    let run_a = ask_and_park(&su, &http, &base, &a, &provider, "@hermes 세션 정리해줘").await;
    let frames = status_frames_of(&su, a.tenant.workspace, run_a).await;
    let first_hold = approvals_of_run(&su, run_a).await;
    assert_eq!(first_hold.len(), 1, "one tool call, one card");
    assert_eq!(
        frames
            .iter()
            .filter(|(_, status, _)| status == "awaiting_approval")
            .count(),
        1,
        "a park is exactly one frame on the rail: {frames:?}"
    );
    assert_eq!(
        rail_story(&frames),
        ["queued", "working", "awaiting_approval"],
        "opening, the pick-up, then the wait — and the wait is the rail's last word: {frames:?}"
    );
    let waiting = frames.last().expect("a frame");
    assert_eq!(
        waiting.0, "thinking",
        "the strict-enum phase the clients decode"
    );
    assert!(
        waiting
            .2
            .ends_with(&format!("awaiting_approval:{}", first_hold[0])),
        "the hold is named by its approval, so the next hold cannot share the key: {}",
        waiting.2
    );

    // …behind the card it points at: a reader who sees 승인 대기 can find the card.
    let (card_seq, card_channel): (i64, Uuid) = sqlx::query_as(
        "SELECT seq, channel_id FROM message WHERE run_id = $1 AND type = 'approval_request'",
    )
    .bind(run_a)
    .fetch_one(&su)
    .await
    .expect("the approval card");
    assert_eq!(card_channel, a.tenant.channel);
    let card_row: i64 = sqlx::query_scalar(
        "SELECT id FROM outbox WHERE workspace_id = $1 AND kind = 'broadcast' \
            AND partition_key = $2 AND payload->'data'->>'type' = 'message.new' \
            AND (payload->>'version')::bigint = $3",
    )
    .bind(a.tenant.workspace)
    .bind(a.tenant.channel)
    .bind(card_seq)
    .fetch_one(&su)
    .await
    .expect("the card's broadcast row");
    let frame_row: i64 = sqlx::query_scalar(
        "SELECT id FROM outbox WHERE workspace_id = $1 AND kind = 'broadcast' \
            AND payload->'data'->>'type' = 'agent.status' \
            AND payload->'data'->'payload'->>'run_status' = 'awaiting_approval' \
            AND upper(payload->'data'->'payload'->>'run_id') = upper($2::text)",
    )
    .bind(a.tenant.workspace)
    .bind(run_a.to_string())
    .fetch_one(&su)
    .await
    .expect("the awaiting frame's row");
    assert!(
        frame_row > card_row,
        "the wait queues behind its card on the channel's one FIFO: card {card_row}, frame {frame_row}"
    );
    // …and on the channel's own FIFO, addressed to this agent's rail.
    let addressed: (String, Option<Uuid>) =
        sqlx::query_as("SELECT payload->>'channel', partition_key FROM outbox WHERE id = $1")
            .bind(frame_row)
            .fetch_one(&su)
            .await
            .expect("the frame row");
    assert_eq!(
        addressed.0,
        momo_agent::agent_status_channel(a.tenant.workspace, a.tenant.channel, a.agent),
        "the agent's own rail in this channel"
    );
    assert_eq!(addressed.1, Some(a.tenant.channel));

    // ---- two tenants: each rail gets its own frame, and sees no other ------------
    let run_b = ask_and_park(&su, &http, &base, &b, &provider, "@hermes 세션 정리해줘").await;
    for (room, run, other) in [(&a, run_a, run_b), (&b, run_b, run_a)] {
        let seen: Vec<Value> =
            momo_db::with_tenant_tx(&app_pool, room.tenant.workspace, move |conn| {
                Box::pin(async move {
                    Ok(sqlx::query_scalar::<_, Value>(
                        "SELECT payload FROM outbox WHERE kind = 'broadcast' \
                        AND payload->'data'->>'type' = 'agent.status' \
                        AND payload->'data'->'payload'->>'run_status' = 'awaiting_approval' \
                      ORDER BY id",
                    )
                    .fetch_all(&mut *conn)
                    .await?)
                })
            })
            .await
            .expect("read this tenant's waiting frames as the non-bypass role");
        assert_eq!(
            seen.len(),
            1,
            "a tenant sees exactly its own one waiting frame: {seen:?}"
        );
        let data = &seen[0]["data"]["payload"];
        assert_eq!(data["run_id"], json!(run.to_string().to_uppercase()));
        assert_eq!(
            data["agent_member_id"],
            json!(room.agent.to_string().to_uppercase())
        );
        assert!(
            !seen[0]
                .to_string()
                .to_lowercase()
                .contains(&other.to_string()),
            "the other tenant's run never appears on this tenant's rail: {seen:?}"
        );
    }

    // ---- a resumed run takes the rail back; a second hold is its own frame --------
    let decided = decide(
        &http,
        &base,
        &a.token,
        a.tenant.workspace,
        first_hold[0],
        true,
    )
    .await;
    assert_eq!(decided.status(), 200, "the person approves");
    worker(provider.clone())
        .await
        .drain_once()
        .await
        .expect("drain the resume");
    assert_eq!(
        run_state(&su, run_a).await,
        "awaiting_approval",
        "the resumed turn asked for another tool: a second hold"
    );
    let holds = approvals_of_run(&su, run_a).await;
    assert_eq!(holds.len(), 2, "the second tool call raised its own card");
    let frames = status_frames_of(&su, a.tenant.workspace, run_a).await;
    assert_eq!(
        rail_story(&frames),
        [
            "queued",
            "working",
            "awaiting_approval",
            "working",
            "awaiting_approval"
        ],
        "approving takes the rail off 승인 대기, and the second hold puts it back: {frames:?}"
    );
    assert!(
        frames[3]
            .2
            .ends_with(&format!("thinking:resumed:{}", holds[0])),
        "the resumed start is its own frame, named by the approval it resumed: {}",
        frames[3].2
    );
    assert!(
        frames[4]
            .2
            .ends_with(&format!("awaiting_approval:{}", holds[1])),
        "the second hold is named by its own approval: {}",
        frames[4].2
    );
    // The point of every key above: Centrifugo's 5-minute cache swallows a second publish under a key
    // it has seen, so a run's state frames must never share one — an `awaiting_approval` that is
    // swallowed leaves no wait on the rail, and a resumed `thinking` that is swallowed leaves the wait
    // there after the person approved.
    let keys: std::collections::BTreeSet<&str> =
        frames.iter().map(|(_, _, key)| key.as_str()).collect();
    assert_eq!(
        keys.len(),
        frames.len(),
        "no two state frames of one run share an idempotency key: {frames:?}"
    );
    // The first start keeps the key it always had; only a resumed start is renamed.
    assert!(frames[1].2.ends_with(":thinking"), "{}", frames[1].2);
}

/// **Every way a hold ends leaves the rail on its ending, not on the wait** (#5084).
///
/// Three runs are parked on one agent, then one is rejected, one is stopped by the person and one lapses
/// under the real expiry sweep. In each, the frame right after the wait is the ending (`error` with the
/// reason that closed it), it is the last frame, and no `running` frame sits between them.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a pgvector/pg18 superuser DB"]
async fn t5084_2_rejecting_stopping_or_expiring_a_hold_leaves_the_rail_on_its_ending() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_worker_jobs(&su).await;
    let app_pool = role_pool("momo_app", &momo_app_password()).await;
    let base = start_server(app_pool.clone()).await;
    let http = reqwest::Client::new();
    let room = room(&su, &app_pool, &http, &base).await;
    let provider = Arc::new(ToolEveryTime(std::sync::atomic::AtomicUsize::new(0)));
    let workspace = room.tenant.workspace;

    let rejected = ask_and_park(&su, &http, &base, &room, &provider, "@hermes 첫째 정리").await;
    let stopped = ask_and_park(&su, &http, &base, &room, &provider, "@hermes 둘째 정리").await;
    let lapsed = ask_and_park(&su, &http, &base, &room, &provider, "@hermes 셋째 정리").await;
    for run in [rejected, stopped, lapsed] {
        let frames = status_frames_of(&su, workspace, run).await;
        assert_eq!(
            rail_story(&frames),
            ["queued", "working", "awaiting_approval"],
            "each hold is on the rail before it ends: {frames:?}"
        );
    }

    // ---- rejected -----------------------------------------------------------
    let card = approvals_of_run(&su, rejected).await[0];
    let response = decide(&http, &base, &room.token, workspace, card, false).await;
    assert_eq!(response.status(), 200, "the person rejects");
    assert_eq!(run_state(&su, rejected).await, "cancelled");

    // ---- stopped ------------------------------------------------------------
    let response = http
        .post(format!(
            "{base}/v1/workspaces/{workspace}/agent-runs/{stopped}/cancel"
        ))
        .bearer_auth(&room.token)
        .send()
        .await
        .expect("stop the run");
    assert_eq!(response.status(), 200, "the person stops the run");
    assert_eq!(run_state(&su, stopped).await, "cancelled");

    // ---- lapsed (the production sweep, as its own role) -----------------------
    let card = approvals_of_run(&su, lapsed).await[0];
    sqlx::query("UPDATE approval SET expires_at = now() - interval '1 minute' WHERE id = $1")
        .bind(card)
        .execute(&su)
        .await
        .expect("make the approval overdue");
    let stats = momo_notifier::approval_sweep::sweep_expired_approvals(&notifier_pool().await, 50)
        .await
        .expect("the production sweep");
    assert!(stats.expired >= 1, "{stats:?}");
    assert_eq!(run_state(&su, lapsed).await, "timed_out");

    for (run, reason) in [
        (rejected, "cancelled"),
        (stopped, "cancelled"),
        (lapsed, "timed_out"),
    ] {
        let frames = status_frames_of(&su, workspace, run).await;
        assert_eq!(
            rail_story(&frames),
            ["queued", "working", "awaiting_approval", "over"],
            "the wait is followed by the ending and nothing between them: {frames:?}"
        );
        let ending = frames.last().expect("a frame");
        assert_eq!(ending.0, "error", "{frames:?}");
        assert_eq!(ending.1, reason, "{frames:?}");
        assert_eq!(
            frames
                .iter()
                .filter(|(_, status, _)| status == "awaiting_approval")
                .count(),
            1,
            "still exactly one wait on the rail: {frames:?}"
        );
    }
}
