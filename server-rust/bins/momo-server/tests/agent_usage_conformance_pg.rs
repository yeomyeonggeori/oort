//! #4781: model-A cost visibility through the real router and NOBYPASSRLS role.
//! Each test owns fresh workspace/member ids. No Docker or shared fixture DB.
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use chrono::{DateTime, SecondsFormat, Utc};
use momo_agent::{agent_month_spend_in_tx, agent_usage_in_tx, validated_window};
use momo_auth::{record_session_token, sign_access};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx::{self, postgres::PgConnectOptions, postgres::PgPoolOptions};
use momo_db::{with_tenant_tx, PgPool};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

const SECRET: &str = "agent-usage-4781-fixture-signing-secret";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set dedicated DATABASE_URL")
}

fn ensure_schema() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None).unwrap();
    let psql = [
        "/opt/homebrew/opt/libpq/bin/psql",
        "/usr/local/opt/libpq/bin/psql",
    ]
    .into_iter()
    .find(|path| PathBuf::from(path).is_file())
    .unwrap_or("psql");
    let status = Command::new(psql)
        .arg(database_url())
        .args([
            "-v",
            "ON_ERROR_STOP=1",
            "--no-psqlrc",
            "--quiet",
            "--single-transaction",
            "-f",
        ])
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../infra/rust/sql/bootstrap_roles.sql"
        ))
        .status()
        .unwrap();
    assert!(status.success());
    *ready = true;
}

struct Fixture {
    su: PgPool,
    app: PgPool,
    base: String,
    ws: Uuid,
    me: Uuid,
    shared: Uuid,
    mine: Uuid,
    other: Uuid,
    unshared: Uuid,
    member_token: String,
    admin_token: String,
    guest_token: String,
}

async fn human(su: &PgPool, ws: Uuid, role: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO member(id, workspace_id, kind, display_name, handle) VALUES($1,$2,'human',$3,$3)")
        .bind(id).bind(ws).bind(id.to_string()).execute(su).await.unwrap();
    sqlx::query("INSERT INTO human(member_id,workspace_id,email) VALUES($1,$2,$3)")
        .bind(id)
        .bind(ws)
        .bind(format!("{id}@usage.test"))
        .execute(su)
        .await
        .unwrap();
    sqlx::query("INSERT INTO workspace_membership(workspace_id,member_id,role) VALUES($1,$2,$3::membership_role)")
        .bind(ws).bind(id).bind(role).execute(su).await.unwrap();
    id
}

async fn token(su: &PgPool, ws: Uuid, member: Uuid) -> String {
    scoped_token(su, ws, member, &[]).await
}

async fn scoped_token(su: &PgPool, ws: Uuid, member: Uuid, scopes: &[String]) -> String {
    let issued = sign_access(member, ws, scopes, SECRET).unwrap();
    let mut conn = su.acquire().await.unwrap();
    record_session_token(
        &mut conn,
        ws,
        member,
        &issued.token,
        "usage-test",
        scopes,
        issued.expires_at,
        Uuid::new_v4(),
    )
    .await
    .unwrap();
    issued.token
}

async fn agent(su: &PgPool, ws: Uuid, owner: Uuid, personal: bool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id,workspace_id,kind,display_name,handle) VALUES($1,$2,'agent',$3,$3)",
    )
    .bind(id)
    .bind(ws)
    .bind(format!("agent-{id}"))
    .execute(su)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workspace_membership(workspace_id,member_id,role) VALUES($1,$2,'member')",
    )
    .bind(ws)
    .bind(id)
    .execute(su)
    .await
    .unwrap();
    sqlx::query("INSERT INTO agent(member_id,workspace_id,model,base_url,owner_human_id,invocation_scope,uses_owner_key) \
                 VALUES($1,$2,'usage-fixture','https://fixture.invalid/v1',$3,$4,$5)")
        .bind(id).bind(ws).bind(owner).bind(if personal { "owner_only" } else { "workspace" })
        .bind(personal).execute(su).await.unwrap();
    id
}

async fn ledger(
    f: &Fixture,
    agent: Uuid,
    model: &str,
    tokens: i32,
    stored_cost: i64,
    source: Option<&str>,
) {
    sqlx::query("INSERT INTO usage_ledger(workspace_id,agent_member_id,model,prompt_tokens,completion_tokens,cached_tokens,cost_micro_usd,source) \
                 VALUES($1,$2,$3,$4,$4/10,$4/10,$5,$6)")
        .bind(f.ws).bind(agent).bind(model).bind(tokens).bind(stored_cost).bind(source).execute(&f.su).await.unwrap();
}

async fn fixture() -> Fixture {
    ensure_schema();
    let su = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url())
        .await
        .unwrap();
    let options: PgConnectOptions = database_url().parse().unwrap();
    let app = PgPoolOptions::new()
        .max_connections(5)
        .connect_with(options.username("momo_app").password(
            &std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".into()),
        ))
        .await
        .unwrap();
    let ws = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace(id,slug,name) VALUES($1,$2,'usage fixture')")
        .bind(ws)
        .bind(ws.to_string())
        .execute(&su)
        .await
        .unwrap();
    let me = human(&su, ws, "member").await;
    let owner = human(&su, ws, "owner").await;
    let other_owner = human(&su, ws, "member").await;
    let guest = human(&su, ws, "guest").await;
    let shared = agent(&su, ws, me, false).await; // managing human must not turn shared into mine
    let mine = agent(&su, ws, me, true).await;
    let other = agent(&su, ws, other_owner, true).await;
    let unshared = agent(&su, ws, owner, false).await;
    let channel = Uuid::new_v4();
    sqlx::query("INSERT INTO channel(id,workspace_id,kind,name,created_by) VALUES($1,$2,'public','guest-room',$3)")
        .bind(channel).bind(ws).bind(owner).execute(&su).await.unwrap();
    for id in [guest, shared, other] {
        sqlx::query("INSERT INTO membership(workspace_id,channel_id,member_id,role) VALUES($1,$2,$3,'member')")
            .bind(ws).bind(channel).bind(id).execute(&su).await.unwrap();
    }
    for model in [
        "usage-public-4781",
        "usage-mine-4781",
        "usage-hidden-4781",
        "usage-unshared-4781",
    ] {
        sqlx::query("INSERT INTO model_pricing(workspace_id,model,input_micro_usd_per_token,output_micro_usd_per_token,cache_read_micro_usd_per_token,effective_from) \
                     VALUES($1,$2,1,2,0.1,'2020-01-01')")
            .bind(ws).bind(model).execute(&su).await.unwrap();
    }
    let member_token = token(&su, ws, me).await;
    let admin_token = token(&su, ws, owner).await;
    let guest_token = token(&su, ws, guest).await;
    let state = AppState::new(
        app.clone(),
        SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket",
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        axum::serve(listener, build_app(state)).await.unwrap();
    });
    let f = Fixture {
        su,
        app,
        base,
        ws,
        me,
        shared,
        mine,
        other,
        unshared,
        member_token,
        admin_token,
        guest_token,
    };
    ledger(
        &f,
        shared,
        "usage-public-4781",
        1000,
        10,
        Some("self_reported"),
    )
    .await;
    ledger(&f, mine, "usage-mine-4781", 2000, 20, Some("measured")).await;
    ledger(&f, other, "usage-hidden-4781", 9000, 90, Some("measured")).await;
    ledger(
        &f,
        unshared,
        "usage-unshared-4781",
        7000,
        70,
        Some("measured"),
    )
    .await;
    f
}

/// The upper bound every read in this file hands the route (#5087).
///
/// `usage_ledger.created_at` defaults to the **database's** `now()`, while the route's default
/// window ends at the **host's** `Utc::now()`: two clocks. A database clock only tens of
/// milliseconds ahead of the host (a Docker/Colima VM after sleep — +48 ms measured on
/// 2026-11-02) puts every row seeded a moment ago after `to`, and the first reads see sums of 0
/// or half. That is the trap #2950 fixed in `momo-agent/tests/conformance_pg.rs`; the production
/// limit reader (`agent_month_spend_in_tx`) already reads both its bounds from the database
/// clock. So the test asks the database what time it is — the clock that stamped the rows — and
/// passes that as `to`.
async fn db_now(su: &PgPool) -> DateTime<Utc> {
    sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(su)
        .await
        .expect("read the database clock")
}

async fn read(f: &Fixture, bearer: &str, path: &str) -> Value {
    let to = db_now(&f.su)
        .await
        .to_rfc3339_opts(SecondsFormat::Micros, true);
    let response = reqwest::Client::new()
        .get(format!("{}/v1/workspaces/{}/usage/{path}", f.base, f.ws))
        .query(&[("to", to.as_str())])
        .bearer_auth(bearer)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body = response.json().await.unwrap();
    capture_sample(
        "get",
        &format!("/v1/workspaces/{{workspaceId}}/usage/{path}"),
        200,
        &body,
    );
    body
}

async fn put(f: &Fixture, bearer: &str, agent: Uuid, body: Value) -> (u16, Value) {
    let response = reqwest::Client::new()
        .put(format!(
            "{}/v1/workspaces/{}/agents/{agent}/subscription-fee",
            f.base, f.ws
        ))
        .bearer_auth(bearer)
        .json(&body)
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    let body = response.json().await.unwrap();
    capture_sample(
        "put",
        "/v1/workspaces/{workspaceId}/agents/{agentMemberId}/subscription-fee",
        status,
        &body,
    );
    (status, body)
}

/// Optional real response samples for the repository's OpenAPI shape checker.
fn capture_sample(method: &str, path: &str, status: u16, body: &Value) {
    let Some(dir) = std::env::var_os("OORT_USAGE_SAMPLE_DIR") else {
        return;
    };
    let dir = PathBuf::from(dir);
    std::fs::create_dir_all(&dir).unwrap();
    let id = Uuid::new_v4();
    let body_file = dir.join(format!("{id}.body.json"));
    std::fs::write(&body_file, serde_json::to_vec(body).unwrap()).unwrap();
    std::fs::write(
        dir.join(format!("{id}.sample.json")),
        serde_json::to_vec(&json!({
            "name":format!("usage-{id}"), "method":method, "path":path,
            "status":status, "body_file":body_file,
        }))
        .unwrap(),
    )
    .unwrap();
}

async fn seed_budget(f: &Fixture) {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO budget(id,workspace_id,grain,limit_micro_usd,soft_limit_micro_usd) VALUES($1,$2,'workspace',1000,500)")
        .bind(id).bind(f.ws).execute(&f.su).await.unwrap();
    sqlx::query("INSERT INTO budget_window(budget_id,workspace_id,period_start,spent_micro_usd,reserved_micro_usd) \
                 VALUES($1,$2,to_timestamp(floor(extract(epoch from now())/86400)*86400),400,300)")
        .bind(id).bind(f.ws).execute(&f.su).await.unwrap();
}

fn row(body: &Value, id: Uuid) -> &Value {
    body["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["agentMemberId"] == json!(id))
        .expect("agent row")
}

#[tokio::test]
#[ignore = "needs dedicated PostgreSQL 18"]
async fn t1_member_visibility_and_admin_owner_grouping() {
    let f = fixture().await;
    for path in ["agents", "summary"] {
        let body = read(&f, &f.member_token, path).await;
        let text = body.to_string();
        assert!(!text.contains(&f.other.to_string()));
        assert!(!text.contains("usage-hidden-4781"));
        assert!(!text.contains(&format!("agent-{}", f.other)));
    }
    let body = read(&f, &f.member_token, "agents").await;
    assert_eq!(body["hiddenPersonalAgents"], 1);
    assert_eq!(body["agents"].as_array().unwrap().len(), 3);
    for key in [
        "displayName",
        "owner",
        "ownerHumanId",
        "brain",
        "channelId",
        "runId",
    ] {
        assert!(!body.to_string().contains(key));
    }
    let admin = read(&f, &f.admin_token, "agents").await;
    assert_eq!(row(&admin, f.other)["promptTokens"], 9000);
    assert_eq!(admin["hiddenPersonalAgents"], 0);
    // Grouping uses agentMemberId + the roster's owner, not a second identity projection.
    assert_eq!(admin["totals"]["workspace"]["promptTokens"], 19000);
}

#[tokio::test]
#[ignore = "needs dedicated PostgreSQL 18"]
async fn t2_visible_totals_and_all_summary_projections_exclude_hidden_costs() {
    let f = fixture().await;
    seed_budget(&f).await;
    let body = read(&f, &f.member_token, "agents").await;
    assert!(body["totals"].get("workspace").is_none());
    assert_eq!(body["totals"]["mine"]["costMicroUsd"], 2220);
    assert_eq!(body["totals"]["shared"]["costMicroUsd"], 8880);
    let sum: i64 = body["agents"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["costMicroUsd"].as_i64().unwrap())
        .sum();
    assert_eq!(sum, 11100);
    let summary = read(&f, &f.member_token, "summary").await;
    assert_eq!(summary["scope"], "visible");
    assert!(summary.get("budget").is_none());
    assert_eq!(summary["totals"]["costMicroUsd"], 100);
    assert_eq!(summary["totals"]["promptTokens"], 10000);
    for key in ["buckets", "byModel", "byAgent"] {
        let cost: i64 = summary[key]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["costMicroUsd"].as_i64().unwrap())
            .sum();
        assert_eq!(cost, 100, "{key} must use the same filter");
    }
}

#[tokio::test]
#[ignore = "needs dedicated PostgreSQL 18"]
async fn t3_guest_uses_roster_channel_narrowing_on_both_routes() {
    let f = fixture().await;
    for path in ["agents", "summary"] {
        let body = read(&f, &f.guest_token, path).await;
        for id in [f.mine, f.other, f.unshared, f.me] {
            assert!(!body.to_string().contains(&id.to_string()));
        }
        assert!(!body.to_string().contains("usage-unshared-4781"));
    }
    let body = read(&f, &f.guest_token, "agents").await;
    assert_eq!(body["agents"].as_array().unwrap().len(), 1);
    assert_eq!(body["totals"]["shared"]["costMicroUsd"], 1110);
}

#[tokio::test]
#[ignore = "needs dedicated PostgreSQL 18"]
async fn t4_workspace_rls_and_explicit_scope_are_independent() {
    let f = fixture().await;
    let other = fixture().await;
    assert_eq!(
        put(
            &f,
            &f.admin_token,
            f.shared,
            json!({"monthlyMicroUsd":30000000})
        )
        .await
        .0,
        200
    );
    let fees = with_tenant_tx(&f.app, other.ws, |conn| {
        Box::pin(async move {
            Ok(sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM agent_subscription_fee WHERE workspace_id=$1",
            )
            .bind(f.ws)
            .fetch_one(&mut *conn)
            .await?)
        })
    })
    .await
    .unwrap();
    assert_eq!(
        fees, 0,
        "wrong tenant GUC hides the seeded subscription fee"
    );
    let count = with_tenant_tx(&f.app, other.ws, |conn| {
        Box::pin(async move {
            Ok(sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM usage_ledger WHERE workspace_id=$1",
            )
            .bind(f.ws)
            .fetch_one(&mut *conn)
            .await?)
        })
    })
    .await
    .unwrap();
    assert_eq!(count, 0, "wrong GUC hides every ledger row");
    // The window must end on the database clock, or rows seeded a moment ago can sit after `to`
    // and this read is empty with or without the workspace predicate (#5087).
    let window = validated_window(None, None, None, db_now(&f.su).await).unwrap();
    let rows = with_tenant_tx(&f.app, other.ws, |conn| {
        Box::pin(async move {
            // Even an authorized id in the GUC tenant cannot be queried using a
            // different workspace parameter. Removing that predicate makes this red.
            agent_usage_in_tx(conn, f.ws, window, &[other.shared]).await
        })
    })
    .await
    .unwrap();
    assert!(rows.is_empty());
    let response = reqwest::Client::new()
        .get(format!(
            "{}/v1/workspaces/{}/usage/agents",
            f.base, other.ws
        ))
        .bearer_auth(&f.member_token)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
}

#[tokio::test]
#[ignore = "needs dedicated PostgreSQL 18"]
async fn t5_unpriced_runs_are_counted_but_never_converted_to_dollars() {
    let f = fixture().await;
    sqlx::query(
        "INSERT INTO usage_ledger(workspace_id,agent_member_id,model,prompt_tokens,created_at) \
                 VALUES($1,$2,'old-unpriced-4781',999999,now()-interval '120 days')",
    )
    .bind(f.ws)
    .bind(f.shared)
    .execute(&f.su)
    .await
    .unwrap();
    ledger(
        &f,
        f.shared,
        "unknown-4781",
        8000,
        999999,
        Some("self_reported"),
    )
    .await;
    let body = read(&f, &f.member_token, "agents").await;
    let observed = row(&body, f.shared);
    assert_eq!(observed["runs"], 2);
    assert_eq!(observed["reportedRuns"], 2);
    assert_eq!(observed["unpricedRuns"], 1);
    assert_eq!(observed["unpricedModels"], json!(["unknown-4781"]));
    assert_eq!(
        observed["costMicroUsd"], 1110,
        "ignore callback-supplied costs"
    );
    assert_eq!(observed["cachedTokens"], 900);
    // Historical REST rows can contain any int32. A malformed dimension
    // must not make every later visible-agent read fail with integer overflow.
    sqlx::query("INSERT INTO usage_ledger(workspace_id,agent_member_id,model,prompt_tokens,cached_tokens,source) \
                 VALUES($1,$2,'usage-public-4781',-2147483648,1,'self_reported')")
        .bind(f.ws).bind(f.shared).execute(&f.su).await.unwrap();
    let repaired = read(&f, &f.member_token, "agents").await;
    assert_eq!(row(&repaired, f.shared)["costMicroUsd"], 1110);
    assert_eq!(row(&repaired, f.shared)["promptTokens"], 9000);
    assert_eq!(row(&repaired, f.shared)["estimatedRuns"], 1);

    // One ledger row can aggregate several calls. Standard rates are a lower
    // bound when per-request long-context surcharges cannot be reconstructed.
    let priced = agent(&f.su, f.ws, f.me, false).await;
    for (model, prompt, completion, cached) in [
        ("openai/gpt-6.1-sol", 2000, 200, 200),
        ("grok-4-fast-reasoning", 150000, 1000, 0),
        ("grok-4.7", 220000, 2000, 0),
    ] {
        sqlx::query("INSERT INTO usage_ledger(workspace_id,agent_member_id,model,prompt_tokens,completion_tokens,cached_tokens,source) \
                     VALUES($1,$2,$3,$4,$5,$6,'measured')")
            .bind(f.ws).bind(priced).bind(model).bind(prompt).bind(completion).bind(cached).execute(&f.su).await.unwrap();
    }
    let seeded = read(&f, &f.member_token, "agents").await;
    assert_eq!(row(&seeded, priced)["costMicroUsd"], 5620 + 30500 + 452000);
    assert_eq!(row(&seeded, priced)["unpricedRuns"], 0);
    assert_eq!(row(&seeded, priced)["estimatedRuns"], 2);
    let documented: i64 = sqlx::query_scalar("SELECT count(*) FROM model_pricing WHERE workspace_id IS NULL AND verified_on='2026-10-30' AND source_url IS NOT NULL")
        .fetch_one(&f.su).await.unwrap();
    assert!(documented >= 11);
}

#[tokio::test]
#[ignore = "needs dedicated PostgreSQL 18"]
async fn t6_subscription_fee_is_separate_and_never_added_to_spend() {
    let f = fixture().await;
    let before = read(&f, &f.member_token, "agents").await;
    assert_eq!(
        put(
            &f,
            &f.admin_token,
            f.shared,
            json!({"monthlyMicroUsd":30000000,"label":"External plan"})
        )
        .await
        .0,
        200
    );
    let after = read(&f, &f.member_token, "agents").await;
    assert_eq!(
        row(&after, f.shared)["subscriptionFee"]["monthlyMicroUsd"],
        30000000
    );
    assert_eq!(
        row(&after, f.shared)["costMicroUsd"],
        row(&before, f.shared)["costMicroUsd"]
    );
    assert_eq!(after["totals"], before["totals"]);
    let audit: Value = sqlx::query_scalar("SELECT detail FROM audit_log WHERE workspace_id=$1 AND action='agent.subscription_fee.updated'")
        .bind(f.ws).fetch_one(&f.su).await.unwrap();
    assert_eq!(audit, json!({"monthlyMicroUsd":30000000}));
    assert_eq!(
        put(
            &f,
            &f.admin_token,
            f.shared,
            json!({"monthlyMicroUsd":null})
        )
        .await
        .0,
        200
    );
    assert!(row(&read(&f, &f.member_token, "agents").await, f.shared)
        .get("subscriptionFee")
        .is_none());
}

#[tokio::test]
#[ignore = "needs dedicated PostgreSQL 18"]
async fn t7_subscription_writes_require_workspace_human_admin_and_shared_agent() {
    let f = fixture().await;
    let body = json!({"monthlyMicroUsd":1000000});
    assert_eq!(
        put(&f, &f.member_token, f.shared, body.clone()).await.0,
        403
    );
    let platform_reader = scoped_token(&f.su, f.ws, f.me, &["platform:read".into()]).await;
    assert_eq!(
        put(&f, &platform_reader, f.shared, body.clone()).await.0,
        403
    );
    assert_eq!(put(&f, &f.guest_token, f.shared, body.clone()).await.0, 403);
    assert_eq!(put(&f, &f.admin_token, f.mine, body.clone()).await.0, 409);
    let bearer = momo_auth::mint_agent_bearer(f.ws).unwrap();
    sqlx::query("INSERT INTO token(workspace_id,kind,actor_member_id,token_hash,scopes,label) VALUES($1,'agent_bearer',$2,digest($3::text,'sha256'),ARRAY['agent:runs:callback'],'usage-agent')")
        .bind(f.ws).bind(f.shared).bind(&bearer).execute(&f.su).await.unwrap();
    assert_eq!(put(&f, &bearer, f.shared, body.clone()).await.0, 403);
    assert_eq!(put(&f, &f.admin_token, f.shared, body).await.0, 200);
    let admin = human(&f.su, f.ws, "admin").await;
    let admin = token(&f.su, f.ws, admin).await;
    assert_eq!(
        put(&f, &admin, f.shared, json!({"monthlyMicroUsd":1}))
            .await
            .0,
        200
    );
    let changed = with_tenant_tx(&f.app, f.ws, |conn| {
        Box::pin(async move {
            Ok(sqlx::query(
                "UPDATE agent_subscription_fee SET monthly_micro_usd=1 WHERE workspace_id=$1",
            )
            .bind(f.ws)
            .execute(&mut *conn)
            .await?
            .rows_affected())
        })
    })
    .await
    .unwrap();
    assert_eq!(changed, 0, "route role gate also has a DB write gate");
    let forced: bool = sqlx::query_scalar("SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='agent_subscription_fee'::regclass")
        .fetch_one(&f.su).await.unwrap();
    assert!(forced);
}

#[tokio::test]
#[ignore = "needs dedicated PostgreSQL 18"]
async fn t8_source_constraint_and_historical_brain_inference() {
    let f = fixture().await;
    ledger(&f, f.mine, "usage-mine-4781", 100, 0, None).await;
    sqlx::query(
        "UPDATE agent SET config='{\"execution_mode\":\"hosted_dial_in\"}' WHERE member_id=$1",
    )
    .bind(f.shared)
    .execute(&f.su)
    .await
    .unwrap();
    ledger(&f, f.shared, "usage-public-4781", 100, 0, None).await;
    let body = read(&f, &f.member_token, "agents").await;
    assert_eq!(row(&body, f.mine)["source"], "measured");
    assert_eq!(row(&body, f.shared)["source"], "self_reported");
    let invalid = sqlx::query("INSERT INTO usage_ledger(workspace_id,agent_member_id,model,source) VALUES($1,$2,'x','invented')")
        .bind(f.ws).bind(f.shared).execute(&f.su).await;
    assert!(invalid.is_err());
}

#[tokio::test]
#[ignore = "needs dedicated PostgreSQL 18"]
async fn t9_admin_summary_retains_legacy_shape_and_amounts() {
    let f = fixture().await;
    let body = read(&f, &f.admin_token, "summary").await;
    let mut keys: Vec<_> = body
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort();
    assert_eq!(
        keys,
        ["buckets", "budget", "byAgent", "byModel", "range", "totals"]
    );
    assert_eq!(body["budget"], Value::Null);
    assert_eq!(
        body["totals"],
        json!({"costMicroUsd":190,"estimatedMicroUsd":0,"promptTokens":19000,"completionTokens":1900})
    );
    assert_eq!(body["byAgent"].as_array().unwrap().len(), 4);
    assert!(body["byAgent"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row.get("displayName").is_some()));
    seed_budget(&f).await;
    let budget = read(&f, &f.admin_token, "summary").await;
    assert_eq!(budget["budget"]["state"], "soft_limit");
    assert_eq!(budget["budget"]["spentMicroUsd"], 400);
    assert_eq!(budget["budget"]["reservedMicroUsd"], 300);
}

/// One ledger row at the fixture's public price (1 in, 2 out, 0.1 cached per token; completion and
/// cached are a tenth of the prompt, so `tokens` tokens list at `1.11 × tokens` micro-dollars).
/// `run` is the run the row belongs to: a task of several steps writes one row per step.
async fn run_row(f: &Fixture, agent: Uuid, run: Option<Uuid>, tokens: i32, stored_cost: i64) {
    sqlx::query("INSERT INTO usage_ledger(workspace_id,agent_member_id,run_id,model,prompt_tokens,completion_tokens,cached_tokens,cost_micro_usd,source) \
                 VALUES($1,$2,$3,'usage-public-4781',$4,$4/10,$4/10,$5,'measured')")
        .bind(f.ws).bind(agent).bind(run).bind(tokens).bind(stored_cost).execute(&f.su).await.unwrap();
}

/// #5087: the three readers of one ledger — the agents screen, the monthly limit and the summary
/// screen — add every row exactly once. A task of several steps is ONE run (#4967) and a row with
/// no run is a run of its own, but neither moves a sum: no row is counted twice, none is dropped.
#[tokio::test]
#[ignore = "needs dedicated PostgreSQL 18"]
async fn t10_the_screens_and_the_monthly_limit_add_every_ledger_row_once() {
    let f = fixture().await;
    let worker = agent(&f.su, f.ws, f.me, false).await;
    let room = Uuid::new_v4();
    sqlx::query("INSERT INTO channel(id,workspace_id,kind,name,created_by) VALUES($1,$2,'public','task-room',$3)")
        .bind(room).bind(f.ws).bind(f.me).execute(&f.su).await.unwrap();
    let run = Uuid::new_v4();
    sqlx::query("INSERT INTO agent_run(id,workspace_id,agent_member_id,channel_id,idempotency_key) VALUES($1,$2,$3,$4,$5)")
        .bind(run).bind(f.ws).bind(worker).bind(room).bind(format!("t10-{run}"))
        .execute(&f.su).await.unwrap();
    // Three steps of one run, then two answers that carry no run at all.
    for (tokens, stored) in [(1000, 10), (2000, 20), (3000, 30)] {
        run_row(&f, worker, Some(run), tokens, stored).await;
    }
    for (tokens, stored) in [(500, 5), (700, 7)] {
        run_row(&f, worker, None, tokens, stored).await;
    }

    // The agents screen: list price of every row, once — 1110 + 2220 + 3330 + 555 + 777.
    let body = read(&f, &f.member_token, "agents").await;
    let seen = row(&body, worker);
    assert_eq!(
        seen["runs"], 3,
        "three steps are one run; each runless row is its own"
    );
    assert_eq!(seen["reportedRuns"], 3);
    assert_eq!(seen["promptTokens"], 7200);
    assert_eq!(seen["completionTokens"], 720);
    assert_eq!(seen["cachedTokens"], 720);
    assert_eq!(seen["costMicroUsd"], 7992);
    assert_eq!(seen["unpricedRuns"], 0);
    assert_eq!(seen["estimatedRuns"], 0);

    // The monthly limit reads the very same figure: a limit and the screen that explains it
    // must not disagree (the limit's `to` is the database clock, so no `to` is passed here).
    let spend = with_tenant_tx(&f.app, f.ws, |conn| {
        Box::pin(async move { agent_month_spend_in_tx(conn, f.ws, worker).await })
    })
    .await
    .unwrap();
    assert_eq!(spend.cost_micro_usd, 7992);
    assert_eq!(spend.runs, 3);
    assert_eq!(spend.unpriced_runs, 0);
    assert_eq!(spend.estimated_runs, 0);
    assert_eq!(json!(spend.cost_micro_usd), seen["costMicroUsd"]);
    assert_eq!(json!(spend.runs), seen["runs"]);

    // The summary screen adds the stored (reported) cost of the same five rows: 10+20+30+5+7.
    let summary = read(&f, &f.member_token, "summary").await;
    let by_agent = summary["byAgent"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["agentMemberId"] == json!(worker))
        .expect("the agent's summary row");
    assert_eq!(by_agent["costMicroUsd"], 72);
    assert_eq!(by_agent["promptTokens"], 7200);
    assert_eq!(by_agent["completionTokens"], 720);
}
