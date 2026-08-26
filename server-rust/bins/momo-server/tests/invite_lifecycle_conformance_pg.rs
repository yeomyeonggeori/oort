//! Invite revoke / regenerate / redeem-status against a real Postgres (#1769).
//!
//! Red proofs the ticket names, none of them mocked:
//!
//! * revoked code → public join 410
//! * regenerated old code → 410; new code → 201
//! * ordinary member revoke/regenerate → 403
//! * exhausted invite revoke → 409
//! * foreign-workspace invite → 403/404 + RLS self-check
//!
//! `#[ignore]` because it needs a real Postgres. Run:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test invite_lifecycle_conformance_pg -- --ignored --nocapture
//! ```

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "invite-lifecycle-conformance-app-signing-secret";
const OWNER_PASSWORD: &str = "invite-lifecycle-owner-password";
const MEMBER_PASSWORD: &str = "invite-lifecycle-member-password";
const JOIN_PASSWORD: &str = "invite-lifecycle-join-password";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn momo_app_password() -> String {
    std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string())
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect to conformance DB as superuser")
}

async fn momo_app_pool() -> PgPool {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    let options = options.username("momo_app").password(&momo_app_password());
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await
        .expect("connect as momo_app (run bootstrap_roles.sql first)")
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

fn apply_bootstrap_roles() {
    let path = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/e2e/bootstrap_roles.sql"
    ));
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(path)
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
}

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations");
    apply_bootstrap_roles();
    *ready = true;
}

async fn start_server(pool: PgPool) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    );
    let app = build_app(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind momo-server");
    let address: SocketAddr = listener.local_addr().expect("server address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{address}")
}

struct Person {
    id: Uuid,
    email: String,
}

struct Fixture {
    workspace: Uuid,
    owner: Person,
    member: Person,
}

async fn seed_human(
    su: &PgPool,
    workspace: Uuid,
    role: &str,
    password: &str,
    hint: &str,
) -> Person {
    let id = Uuid::new_v4();
    let handle = format!("{hint}-{}", &id.to_string()[..8]);
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(id)
    .bind(workspace)
    .bind(&handle)
    .execute(su)
    .await
    .expect("seed member");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, $3::membership_role)",
    )
    .bind(workspace)
    .bind(id)
    .bind(role)
    .execute(su)
    .await
    .expect("seed workspace_membership");
    let email = format!("{id}@invite-life.test");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         VALUES ($1, $2, $3, true, momo_password_hash($4))",
    )
    .bind(id)
    .bind(workspace)
    .bind(&email)
    .bind(password)
    .execute(su)
    .await
    .expect("seed human");
    Person { id, email }
}

async fn seed(su: &PgPool, slug_hint: &str) -> Fixture {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("{slug_hint}-{workspace}"))
        .execute(su)
        .await
        .expect("seed workspace");

    let owner = seed_human(su, workspace, "owner", OWNER_PASSWORD, "own").await;
    let member = seed_human(su, workspace, "member", MEMBER_PASSWORD, "mem").await;

    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, topic, created_by) \
         VALUES ($1, $2, 'public', 'general', 'Team general channel', $3)",
    )
    .bind(channel)
    .bind(workspace)
    .bind(owner.id)
    .execute(su)
    .await
    .expect("seed channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel)
        .bind(workspace)
        .execute(su)
        .await
        .expect("seed channel_seq");
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'owner')",
    )
    .bind(workspace)
    .bind(channel)
    .bind(owner.id)
    .execute(su)
    .await
    .expect("seed owner channel membership");

    Fixture {
        workspace,
        owner,
        member,
    }
}

async fn login(
    http: &reqwest::Client,
    base: &str,
    workspace: Uuid,
    email: &str,
    password: &str,
) -> String {
    let body: Value = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": email,
            "password": password,
            "workspace": workspace.to_string(),
        }))
        .send()
        .await
        .expect("login")
        .json()
        .await
        .expect("login body");
    body["accessToken"]
        .as_str()
        .expect("login returns an access token")
        .to_string()
}

async fn issue_invite(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    role: &str,
    max_uses: i32,
) -> (String, String) {
    let response = http
        .post(format!("{base}/v1/workspaces/{workspace}/invites"))
        .bearer_auth(token)
        .json(&json!({ "role": role, "maxUses": max_uses }))
        .send()
        .await
        .expect("create invite");
    assert_eq!(response.status().as_u16(), 201, "invite create must be 201");
    let body: Value = response.json().await.expect("invite body");
    let code = body["code"].as_str().expect("raw code once").to_string();
    let id = body["invite"]["id"]
        .as_str()
        .expect("invite id")
        .to_string();
    (code, id)
}

struct Attempt {
    status: u16,
    body: Value,
}

async fn send(builder: reqwest::RequestBuilder) -> Attempt {
    let response = builder.send().await.expect("request");
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    Attempt { status, body }
}

fn error_message(body: &Value) -> &str {
    body["error"]["message"].as_str().unwrap_or("")
}

async fn post_join(http: &reqwest::Client, base: &str, code: &str, email: &str) -> Attempt {
    send(http.post(format!("{base}/v1/join")).json(&json!({
        "code": code,
        "email": email,
        "displayName": "Invite Life Joiner",
        "password": JOIN_PASSWORD,
    })))
    .await
}

async fn audit_count(su: &PgPool, workspace: Uuid, action: &str, target: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*)::bigint FROM audit_log \
          WHERE workspace_id = $1 AND action = $2 AND target_id = $3",
    )
    .bind(workspace)
    .bind(action)
    .bind(target)
    .fetch_one(su)
    .await
    .expect("count audit")
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn invite_lifecycle_red_and_green_paths() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, "life").await;
    let stranger = seed(&su, "stranger").await;
    let base = start_server(app_pool.clone()).await;
    let http = reqwest::Client::new();
    let owner = login(
        &http,
        &base,
        fixture.workspace,
        &fixture.owner.email,
        OWNER_PASSWORD,
    )
    .await;
    let member = login(
        &http,
        &base,
        fixture.workspace,
        &fixture.member.email,
        MEMBER_PASSWORD,
    )
    .await;
    let stranger_token = login(
        &http,
        &base,
        stranger.workspace,
        &stranger.owner.email,
        OWNER_PASSWORD,
    )
    .await;

    // -- GREEN: revoke unused code, then join is 410 -----------------------
    let (revoked_code, revoked_id) =
        issue_invite(&http, &base, &owner, fixture.workspace, "member", 3).await;
    let revoked_uuid = Uuid::parse_str(&revoked_id).expect("invite uuid");
    let revoked = send(
        http.post(format!(
            "{base}/v1/workspaces/{}/invites/{revoked_id}/revoke",
            fixture.workspace
        ))
        .bearer_auth(&owner)
        .json(&json!({ "reason": "leaked" })),
    )
    .await;
    assert_eq!(revoked.status, 200, "{}", revoked.body);
    assert!(revoked.body["revokedAtMs"].as_i64().is_some());
    assert_eq!(revoked.body["revocationReason"], "leaked");
    assert!(
        revoked.body.get("code").is_none(),
        "revoke must not echo the raw code: {}",
        revoked.body
    );
    assert_eq!(
        audit_count(&su, fixture.workspace, "invite.revoked", revoked_uuid).await,
        1
    );
    let replay = send(
        http.post(format!(
            "{base}/v1/workspaces/{}/invites/{revoked_id}/revoke",
            fixture.workspace
        ))
        .bearer_auth(&owner)
        .json(&json!({ "reason": "again" })),
    )
    .await;
    assert_eq!(replay.status, 200, "already-revoked is idempotent");
    assert_eq!(
        audit_count(&su, fixture.workspace, "invite.revoked", revoked_uuid).await,
        1,
        "a replay must not write a second audit row"
    );
    let join_revoked = post_join(
        &http,
        &base,
        &revoked_code,
        &format!("revoked-{}@invite-life.test", Uuid::new_v4()),
    )
    .await;
    assert_eq!(join_revoked.status, 410, "{}", join_revoked.body);
    assert_eq!(error_message(&join_revoked.body), "invite code is revoked");

    // DELETE is the same handler.
    let (delete_code, delete_id) =
        issue_invite(&http, &base, &owner, fixture.workspace, "member", 1).await;
    let deleted = send(
        http.delete(format!(
            "{base}/v1/workspaces/{}/invites/{delete_id}",
            fixture.workspace
        ))
        .bearer_auth(&owner),
    )
    .await;
    assert_eq!(deleted.status, 200, "{}", deleted.body);
    let join_deleted = post_join(
        &http,
        &base,
        &delete_code,
        &format!("deleted-{}@invite-life.test", Uuid::new_v4()),
    )
    .await;
    assert_eq!(join_deleted.status, 410, "{}", join_deleted.body);

    // -- GREEN: regenerate invalidates the old code immediately ------------
    let (old_code, old_id) =
        issue_invite(&http, &base, &owner, fixture.workspace, "member", 2).await;
    let old_uuid = Uuid::parse_str(&old_id).expect("old invite");
    let regenerated = send(
        http.post(format!(
            "{base}/v1/workspaces/{}/invites/{old_id}/regenerate",
            fixture.workspace
        ))
        .bearer_auth(&owner),
    )
    .await;
    assert_eq!(regenerated.status, 201, "{}", regenerated.body);
    let new_code = regenerated.body["code"].as_str().expect("new code");
    let new_id = regenerated.body["invite"]["id"].as_str().expect("new id");
    assert_ne!(new_code, old_code);
    assert_ne!(new_id, old_id);
    assert_eq!(
        audit_count(&su, fixture.workspace, "invite.regenerated", old_uuid).await,
        1
    );
    let join_old = post_join(
        &http,
        &base,
        &old_code,
        &format!("old-{}@invite-life.test", Uuid::new_v4()),
    )
    .await;
    assert_eq!(join_old.status, 410, "{}", join_old.body);
    let join_new = post_join(
        &http,
        &base,
        new_code,
        &format!("new-{}@invite-life.test", Uuid::new_v4()),
    )
    .await;
    assert_eq!(join_new.status, 201, "{}", join_new.body);

    // -- GREEN: redeem status shows the join redemption --------------------
    let status = send(
        http.get(format!(
            "{base}/v1/workspaces/{}/invites/{new_id}",
            fixture.workspace
        ))
        .bearer_auth(&owner),
    )
    .await;
    assert_eq!(status.status, 200, "{}", status.body);
    assert_eq!(status.body["invite"]["usedCount"], 1);
    assert_eq!(
        status.body["redemptions"].as_array().expect("rows").len(),
        1
    );
    assert!(
        status.body.get("code").is_none() && status.body["invite"].get("code").is_none(),
        "status must not carry a redeemable code: {}",
        status.body
    );

    // -- GREEN: member-self redeem ----------------------------------------
    let (redeem_code, _) = issue_invite(&http, &base, &owner, fixture.workspace, "guest", 2).await;
    let redeemed = send(
        http.post(format!(
            "{base}/v1/workspaces/{}/invites/redeem",
            fixture.workspace
        ))
        .bearer_auth(&member)
        .json(&json!({ "code": redeem_code })),
    )
    .await;
    assert_eq!(redeemed.status, 200, "{}", redeemed.body);
    assert_eq!(redeemed.body["invite"]["usedCount"], 1);
    assert!(redeemed.body.get("code").is_none());

    // -- RED: ordinary member cannot revoke or regenerate -----------------
    let (protected_code, protected_id) =
        issue_invite(&http, &base, &owner, fixture.workspace, "member", 3).await;
    let member_revoke = send(
        http.post(format!(
            "{base}/v1/workspaces/{}/invites/{protected_id}/revoke",
            fixture.workspace
        ))
        .bearer_auth(&member)
        .json(&json!({ "reason": "no" })),
    )
    .await;
    assert_eq!(member_revoke.status, 403, "{}", member_revoke.body);
    assert_eq!(
        error_message(&member_revoke.body),
        "workspace admin required"
    );
    let member_regen = send(
        http.post(format!(
            "{base}/v1/workspaces/{}/invites/{protected_id}/regenerate",
            fixture.workspace
        ))
        .bearer_auth(&member),
    )
    .await;
    assert_eq!(member_regen.status, 403, "{}", member_regen.body);
    let still_live = post_join(
        &http,
        &base,
        &protected_code,
        &format!("still-{}@invite-life.test", Uuid::new_v4()),
    )
    .await;
    assert_eq!(
        still_live.status, 201,
        "a refused revoke must leave the code spendable: {}",
        still_live.body
    );

    // -- RED: exhausted invite cannot be revoked --------------------------
    let (spent_code, spent_id) =
        issue_invite(&http, &base, &owner, fixture.workspace, "member", 1).await;
    let spent_join = post_join(
        &http,
        &base,
        &spent_code,
        &format!("spent-{}@invite-life.test", Uuid::new_v4()),
    )
    .await;
    assert_eq!(spent_join.status, 201, "{}", spent_join.body);
    let spent_revoke = send(
        http.post(format!(
            "{base}/v1/workspaces/{}/invites/{spent_id}/revoke",
            fixture.workspace
        ))
        .bearer_auth(&owner)
        .json(&json!({ "reason": "too late" })),
    )
    .await;
    assert_eq!(spent_revoke.status, 409, "{}", spent_revoke.body);
    assert_eq!(
        error_message(&spent_revoke.body),
        "invite code is already consumed"
    );

    // -- RED: foreign workspace -------------------------------------------
    let (_, home_id) = issue_invite(&http, &base, &owner, fixture.workspace, "member", 1).await;
    let scope_mismatch = send(
        http.post(format!(
            "{base}/v1/workspaces/{}/invites/{home_id}/revoke",
            fixture.workspace
        ))
        .bearer_auth(&stranger_token)
        .json(&json!({ "reason": "cross" })),
    )
    .await;
    assert_eq!(
        scope_mismatch.status, 403,
        "path workspace must match the credential: {}",
        scope_mismatch.body
    );
    assert_eq!(
        error_message(&scope_mismatch.body),
        "workspace scope mismatch"
    );
    let hidden = send(
        http.post(format!(
            "{base}/v1/workspaces/{}/invites/{home_id}/revoke",
            stranger.workspace
        ))
        .bearer_auth(&stranger_token)
        .json(&json!({ "reason": "cross" })),
    )
    .await;
    assert_eq!(
        hidden.status, 404,
        "RLS + tenant GUC hide the foreign row: {}",
        hidden.body
    );

    let home_uuid = Uuid::parse_str(&home_id).expect("home invite");
    momo_db::with_tenant_tx(&app_pool, stranger.workspace, {
        move |conn| {
            Box::pin(async move {
                assert!(
                    momo_settings::read_invite(conn, home_uuid).await?.is_none(),
                    "invite_code crossed a tenant boundary"
                );
                match momo_settings::revoke_invite(conn, home_uuid, stranger.owner.id, None).await?
                {
                    Err(momo_settings::InviteMutationInvalid::NotFound) => {}
                    other => panic!("foreign revoke must be NotFound, got {other:?}"),
                }
                Ok(())
            })
        }
    })
    .await
    .expect("foreign tenant read");
    momo_db::with_tenant_tx(&app_pool, fixture.workspace, {
        move |conn| {
            Box::pin(async move {
                assert!(
                    momo_settings::read_invite(conn, home_uuid).await?.is_some(),
                    "the zero above must be the policy, not a broken query"
                );
                Ok(())
            })
        }
    })
    .await
    .expect("owner tenant read");
}
