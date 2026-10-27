//! **The invite round trip, replayed against the real server** (B4.3).
//!
//! B4.2 landed the half that mints a link and said so in its own PR: *"you can
//! mint an invite that cannot yet be redeemed on this server"*. This test is the
//! evidence that the door is closed — it walks the whole loop in one process:
//!
//! ```text
//! login(owner) → POST …/invites → POST /v1/join → POST /v1/auth/login(new)
//!              → GET …/roster (with the JOIN-issued token)
//! ```
//!
//! Four properties are asserted that no single call could show on its own:
//!
//! * **The code issued by B4.2 is spendable by B4.3.** The raw code goes
//!   straight from the create response into the join body; nothing in between
//!   reconstructs or re-hashes it.
//! * **The password a join writes is the password login verifies.** The new
//!   account logs in through the ordinary route afterwards, which is the only
//!   way to prove `momo_password_hash` and `momo_password_verify` met.
//! * **The session a join issues is a real session.** The roster read uses the
//!   token the join returned, so the `token` row was recorded (MOMO-300) and the
//!   middleware accepts it — a join that minted a JWT without the row would 401
//!   here.
//! * **A join is not a broadcast.** The `outbox` count is unchanged across the
//!   whole sequence. That assertion is also where the deferred onboarding
//!   greeting would show up if it were ported, so it doubles as the marker for
//!   that deviation.
//!
//! Test 2 walks **every refusal** the Swift route can answer, and test 3 is the
//! one that is not about HTTP at all: `momo_join_private.invite_workspace_id` is
//! EXECUTE-granted to `momo_app` alone (migration 009 +
//! `infra/rust/sql/bootstrap_roles.sql`), and the join path is the only caller — so
//! the test connects as each non-locked role and requires the call to fail.
//! Test 4 is the tenant boundary on the rows a join creates.
//!
//! `#[ignore]` because it needs a real Postgres. Run:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test join_conformance_pg -- --ignored --nocapture
//! ```

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::sqlx::Row;
use momo_db::PgPool;
use momo_server::config::RateLimitConfig;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness (same contract as settings_conformance_pg.rs)
// ---------------------------------------------------------------------------

#[path = "common/password_cases.rs"]
mod password_cases;

const TEST_JWT_SECRET: &str = "join-conformance-app-signing-secret";
const OWNER_PASSWORD: &str = "join-conformance-owner-password";
/// What a joining human types into the onboarding form.
const JOIN_PASSWORD: &str = "join-conformance-new-member-password";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn role_password(role: &str, env_key: &str) -> String {
    std::env::var(env_key).unwrap_or_else(|_| format!("{role}_dev_pw"))
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect to conformance DB as superuser")
}

/// A pool authenticating as one of the four runtime roles. `momo_app` is the API
/// role; the other three are the BYPASSRLS background consumers that must NOT be
/// able to execute the locked lookup.
async fn role_pool(role: &str, env_key: &str) -> Result<PgPool, sqlx::Error> {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    let options = options
        .username(role)
        .password(&role_password(role, env_key));
    PgPoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await
}

async fn momo_app_pool() -> PgPool {
    role_pool("momo_app", "MOMO_APP_PASSWORD")
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
        "/../../../infra/rust/sql/bootstrap_roles.sql"
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

/// Boot the router. `rate_limit` is a parameter because one test needs a limit
/// small enough to trip deliberately, and every other test needs the production
/// default out of its way.
async fn start_server(pool: PgPool, rate_limit: RateLimitConfig) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_rate_limit(rate_limit);
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

// ---------------------------------------------------------------------------
// fixtures (superuser → bypass RLS)
// ---------------------------------------------------------------------------

struct Fixture {
    workspace: Uuid,
    owner: Uuid,
    owner_handle: String,
    owner_email: String,
    channel: Uuid,
}

/// One workspace with an owner and one public `#general` channel.
///
/// The channel is not decoration: `createPublicChannelMemberships` refuses a
/// join into a workspace with no joinable public channel, so a fixture without
/// one would make every join in this file a 409.
async fn seed(su: &PgPool, slug_hint: &str) -> Fixture {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("{slug_hint}-{workspace}"))
        .execute(su)
        .await
        .expect("seed workspace");

    let owner = Uuid::new_v4();
    let owner_handle = format!("owner-{}", &owner.to_string()[..8]);
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(owner)
    .bind(workspace)
    .bind(&owner_handle)
    .execute(su)
    .await
    .expect("seed owner member");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'owner')",
    )
    .bind(workspace)
    .bind(owner)
    .execute(su)
    .await
    .expect("seed workspace_membership");

    let owner_email = format!("{owner}@join.test");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         VALUES ($1, $2, $3, true, momo_password_hash($4))",
    )
    .bind(owner)
    .bind(workspace)
    .bind(&owner_email)
    .bind(OWNER_PASSWORD)
    .execute(su)
    .await
    .expect("seed owner human");

    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, topic, created_by) \
         VALUES ($1, $2, 'public', 'general', 'Team general channel', $3)",
    )
    .bind(channel)
    .bind(workspace)
    .bind(owner)
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
    .bind(owner)
    .execute(su)
    .await
    .expect("seed owner membership");

    Fixture {
        workspace,
        owner,
        owner_handle,
        owner_email,
        channel,
    }
}

async fn login(
    http: &reqwest::Client,
    base: &str,
    workspace: Uuid,
    email: &str,
    password: &str,
) -> Value {
    http.post(format!("{base}/v1/auth/login"))
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
        .expect("login body")
}

async fn owner_token(http: &reqwest::Client, base: &str, fixture: &Fixture) -> String {
    let body = login(
        http,
        base,
        fixture.workspace,
        &fixture.owner_email,
        OWNER_PASSWORD,
    )
    .await;
    body["accessToken"]
        .as_str()
        .expect("owner login returns an access token")
        .to_string()
}

/// Mint one invite through the real B4.2 route and hand back its raw code — the
/// only place the code ever exists outside the database.
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
    let code = body["code"]
        .as_str()
        .expect("the create response carries the raw code exactly once")
        .to_string();
    let id = body["invite"]["id"]
        .as_str()
        .expect("invite id")
        .to_string();
    (code, id)
}

struct JoinAttempt {
    status: u16,
    body: Value,
}

async fn post_join(http: &reqwest::Client, base: &str, payload: Value) -> JoinAttempt {
    let response = http
        .post(format!("{base}/v1/join"))
        .json(&payload)
        .send()
        .await
        .expect("join request");
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    JoinAttempt { status, body }
}

fn join_payload(code: &str, email: &str) -> Value {
    join_payload_with_password(code, email, JOIN_PASSWORD)
}

fn join_payload_with_password(code: &str, email: &str, password: &str) -> Value {
    json!({
        "code": code,
        "email": email,
        "displayName": "Joining Human",
        "password": password,
        "timeZone": "Asia/Seoul",
    })
}

async fn outbox_rows(su: &PgPool) -> i64 {
    sqlx::query("SELECT count(*)::bigint FROM outbox")
        .fetch_one(su)
        .await
        .expect("count outbox")
        .get::<i64, _>(0)
}

// ---------------------------------------------------------------------------
// 1. the round trip
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_issued_invite_is_spent_logged_into_and_visible_on_the_roster() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, "join").await;
    let base = start_server(app_pool, RateLimitConfig::default()).await;
    let http = reqwest::Client::new();

    let outbox_before = outbox_rows(&su).await;

    // -- 1. the operator mints a link (B4.2) -------------------------------
    let token = owner_token(&http, &base, &fixture).await;
    let (code, invite_id) =
        issue_invite(&http, &base, &token, fixture.workspace, "member", 3).await;

    // -- 2. someone spends it (B4.3) ---------------------------------------
    let joiner_email = format!("ada-{}@join.test", Uuid::new_v4());
    let joined = post_join(&http, &base, join_payload(&code, &joiner_email)).await;
    assert_eq!(
        joined.status, 201,
        "a join that created an account is 201: {}",
        joined.body
    );
    let body = &joined.body;
    assert_eq!(body["createdMember"], json!(true));
    assert_eq!(body["workspaceId"], fixture.workspace.to_string());
    assert_eq!(
        body["member"]["kind"], "human",
        "a public link may only ever create a human: {body}"
    );
    assert!(
        body["member"]["handle"]
            .as_str()
            .expect("handle")
            .starts_with("ada-"),
        "the handle is derived from the email's local part: {body}"
    );
    assert_eq!(
        body["invite"]["usedCount"],
        json!(1),
        "the invite is read AFTER the increment, so usedCount is this join's: {body}"
    );
    assert_eq!(body["invite"]["id"], invite_id);
    assert!(
        body["invite"].get("code").is_none() && !body.to_string().contains(&code),
        "the response must never echo the code back: {body}"
    );
    assert!(
        body["redemptionId"]
            .as_str()
            .is_some_and(|id| !id.is_empty()),
        "the redemption is named so an operator can audit it: {body}"
    );
    let memberships = body["memberships"]
        .as_array()
        .expect("memberships is an array");
    assert_eq!(
        memberships.len(),
        1,
        "the workspace has exactly one public channel: {body}"
    );
    assert_eq!(memberships[0]["channelId"], fixture.channel.to_string());
    assert_eq!(memberships[0]["role"], "member");
    assert_eq!(
        body["realtimeWebSocketUrl"], "ws://127.0.0.1:8000/connection/websocket",
        "ADR-0110: the join tells the client where the realtime rail is"
    );

    let join_access = body["accessToken"]
        .as_str()
        .expect("access token")
        .to_string();
    let joined_member_id = body["member"]["id"]
        .as_str()
        .expect("member id")
        .to_string();

    // -- 3. the token the JOIN issued is a real session --------------------
    // If the join had minted a JWT without recording the `token` row, the
    // middleware's MOMO-300 revocation check would answer 401 here.
    let roster: Value = http
        .get(format!("{base}/v1/workspaces/{}/roster", fixture.workspace))
        .bearer_auth(&join_access)
        .send()
        .await
        .expect("roster read with the join-issued token")
        .json()
        .await
        .expect("roster body");
    let members = roster["members"].as_array().expect("roster members");
    assert!(
        members
            .iter()
            .any(|member| member["id"] == joined_member_id.as_str()),
        "the new member must appear on the roster they just joined: {roster}"
    );
    assert!(
        members
            .iter()
            .any(|member| member["handle"] == fixture.owner_handle.as_str()),
        "…and so must the owner who invited them: {roster}"
    );

    // -- 4. the password the join wrote is the one login verifies ----------
    let relogin = login(
        &http,
        &base,
        fixture.workspace,
        &joiner_email,
        JOIN_PASSWORD,
    )
    .await;
    assert!(
        relogin["accessToken"].as_str().is_some(),
        "momo_password_hash on the join path must satisfy momo_password_verify \
         on the login path: {relogin}"
    );

    // -- 5. the same code, the same person: already redeemed ---------------
    let replay = post_join(&http, &base, join_payload(&code, &joiner_email)).await;
    assert_eq!(replay.status, 409, "{}", replay.body);
    assert_eq!(
        replay.body["error"]["message"],
        "invite code was already redeemed by this member"
    );

    // -- 6. the same code, a second person: the counter advances -----------
    let second_email = format!("grace-{}@join.test", Uuid::new_v4());
    let second = post_join(&http, &base, join_payload(&code, &second_email)).await;
    assert_eq!(second.status, 201, "{}", second.body);
    assert_eq!(
        second.body["invite"]["usedCount"],
        json!(2),
        "a multi-use link counts each redemption once: {}",
        second.body
    );

    // -- 7. the audit trail names the invite and never the code ------------
    let audit: Vec<String> = sqlx::query(
        "SELECT detail::text FROM audit_log \
          WHERE workspace_id = $1 AND action = 'invite.join' \
          ORDER BY created_at",
    )
    .bind(fixture.workspace)
    .fetch_all(&su)
    .await
    .expect("audit rows")
    .into_iter()
    .map(|row| row.get::<String, _>(0))
    .collect();
    assert_eq!(audit.len(), 2, "one row per successful join");
    for detail in &audit {
        assert!(
            !detail.contains(&code),
            "an audit row is read by more people than a response is: {detail}"
        );
        assert!(detail.contains("redemption_id"), "{detail}");
        assert!(detail.contains("momo.invite.join.v1"), "{detail}");
    }
    let actors: i64 = sqlx::query(
        "SELECT count(*)::bigint FROM audit_log \
          WHERE workspace_id = $1 AND action = 'invite.join' \
            AND actor_member_id IS NOT NULL AND via_token_id IS NULL",
    )
    .bind(fixture.workspace)
    .fetch_one(&su)
    .await
    .expect("audit provenance")
    .get(0);
    assert_eq!(
        actors, 2,
        "the joiner is the actor, and via_token_id is truthfully NULL — no token \
         authorized this call, an invite code did"
    );

    // -- 8. a join is not a broadcast --------------------------------------
    // This is also where the deferred onboarding greeting (MOMO-588) would
    // appear as an outbox row if it were ported; its absence is the deviation.
    assert_eq!(
        outbox_rows(&su).await,
        outbox_before,
        "no route in this batch may add an outbox row"
    );
}

// ---------------------------------------------------------------------------
// 2. every refusal
// ---------------------------------------------------------------------------

/// One test rather than twelve, because the *set* is the contract: an onboarding
/// UI branches on these statuses, and a refusal that quietly changed status
/// would be a silently broken screen rather than a failing assertion.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn every_refusal_answers_the_status_and_sentence_swift_answers() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, "join-refuse").await;
    let base = start_server(app_pool, RateLimitConfig::default()).await;
    let http = reqwest::Client::new();
    let token = owner_token(&http, &base, &fixture).await;

    let expect = |attempt: &JoinAttempt, status: u16, message: &str, case: &str| {
        assert_eq!(attempt.status, status, "{case}: {}", attempt.body);
        assert_eq!(
            attempt.body["error"]["message"], message,
            "{case}: {}",
            attempt.body
        );
    };

    // -- shape (400) — every field, before a single statement runs ---------
    let (live_code, _) = issue_invite(&http, &base, &token, fixture.workspace, "member", 5).await;
    for (payload, message, case) in [
        (
            json!({"code": "", "email": "a@b.test", "displayName": "A", "password": JOIN_PASSWORD}),
            "invite code is invalid",
            "blank code",
        ),
        (
            json!({"code": live_code, "email": "nope", "displayName": "A", "password": JOIN_PASSWORD}),
            "email is invalid",
            "email without an @",
        ),
        (
            json!({"code": live_code, "email": "a@b.test", "password": JOIN_PASSWORD}),
            "displayName is required",
            "absent display name",
        ),
        (
            json!({"code": live_code, "email": "a@b.test", "displayName": "A"}),
            "password is required",
            "absent password",
        ),
        (
            json!({"code": live_code, "email": "a@b.test", "displayName": "A",
                   "password": JOIN_PASSWORD, "handle": "x"}),
            "handle must be 2-32 chars of a-z, 0-9, _ or -",
            "one-character handle",
        ),
    ] {
        let attempt = post_join(&http, &base, payload).await;
        expect(&attempt, 400, message, case);
    }

    // -- an unknown code is 404, indistinguishable from a wrong one --------
    let unknown = post_join(
        &http,
        &base,
        join_payload("this-code-was-never-issued", "ghost@join.test"),
    )
    .await;
    expect(&unknown, 404, "invite code is invalid", "unknown code");

    // -- expired: 410, because the link is gone rather than merely refused --
    let (expired_code, expired_id) =
        issue_invite(&http, &base, &token, fixture.workspace, "member", 5).await;
    sqlx::query(
        // invite_code_expires_ck(만료>생성)를 존중해 생성 시각도 함께 과거로 옮긴다.
        "UPDATE invite_code SET created_at = now() - interval '2 hours', \
         expires_at = now() - interval '1 hour' WHERE id = $1",
    )
    .bind(Uuid::parse_str(&expired_id).expect("invite id"))
    .execute(&su)
    .await
    .expect("expire the invite");
    let expired = post_join(
        &http,
        &base,
        join_payload(&expired_code, &format!("exp-{}@join.test", Uuid::new_v4())),
    )
    .await;
    expect(&expired, 410, "invite code is expired", "expired code");

    // -- revoked: 410 for the same reason ----------------------------------
    let (revoked_code, revoked_id) =
        issue_invite(&http, &base, &token, fixture.workspace, "member", 5).await;
    sqlx::query("UPDATE invite_code SET revoked_at = now(), revoked_by = $2 WHERE id = $1")
        .bind(Uuid::parse_str(&revoked_id).expect("invite id"))
        .bind(fixture.owner)
        .execute(&su)
        .await
        .expect("revoke the invite");
    let revoked = post_join(
        &http,
        &base,
        join_payload(&revoked_code, &format!("rev-{}@join.test", Uuid::new_v4())),
    )
    .await;
    expect(&revoked, 410, "invite code is revoked", "revoked code");

    // -- exhausted: 409, a race someone else won ---------------------------
    let (single_code, _) = issue_invite(&http, &base, &token, fixture.workspace, "member", 1).await;
    let first = post_join(
        &http,
        &base,
        join_payload(&single_code, &format!("first-{}@join.test", Uuid::new_v4())),
    )
    .await;
    assert_eq!(first.status, 201, "{}", first.body);
    let exhausted = post_join(
        &http,
        &base,
        join_payload(
            &single_code,
            &format!("second-{}@join.test", Uuid::new_v4()),
        ),
    )
    .await;
    expect(
        &exhausted,
        409,
        "invite code is exhausted",
        "a single-use code spent twice",
    );

    // -- banned: 409 would be wrong; this is an authorization refusal ------
    let banned_email = format!("banned-{}@join.test", Uuid::new_v4());
    sqlx::query(
        "INSERT INTO workspace_ban (workspace_id, email_norm, created_by, reason) \
         VALUES ($1, $2, $3, 'conformance')",
    )
    .bind(fixture.workspace)
    .bind(&banned_email)
    .bind(fixture.owner)
    .execute(&su)
    .await
    .expect("seed workspace_ban");
    let banned = post_join(&http, &base, join_payload(&live_code, &banned_email)).await;
    expect(
        &banned,
        403,
        "member is banned from this workspace",
        "a banned email",
    );

    // -- handle already taken: 409 -----------------------------------------
    let taken = post_join(
        &http,
        &base,
        json!({
            "code": live_code,
            "email": format!("dup-{}@join.test", Uuid::new_v4()),
            "displayName": "Impostor",
            "password": JOIN_PASSWORD,
            "handle": fixture.owner_handle,
        }),
    )
    .await;
    expect(
        &taken,
        409,
        "handle is already in use",
        "a handle the owner already holds",
    );

    // -- role escalation: an ADMIN link handed to an existing MEMBER -------
    // The direction is the point. The reverse (an admin redeeming a member
    // link) is allowed and is a no-op, so only this direction is a refusal.
    let existing_email = format!("existing-{}@join.test", Uuid::new_v4());
    let existing = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', 'Existing', $3)",
    )
    .bind(existing)
    .bind(fixture.workspace)
    .bind(format!("existing-{}", &existing.to_string()[..8]))
    .execute(&su)
    .await
    .expect("seed existing member");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, password_hash) \
         VALUES ($1, $2, $3, momo_password_hash($4))",
    )
    .bind(existing)
    .bind(fixture.workspace)
    .bind(&existing_email)
    .bind(OWNER_PASSWORD)
    .execute(&su)
    .await
    .expect("seed existing human");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'member')",
    )
    .bind(fixture.workspace)
    .bind(existing)
    .execute(&su)
    .await
    .expect("seed existing workspace_membership");

    // The member proves the account first (#4625): the escalation answer is about
    // the account, so it is only owed to someone who holds it. The request therefore
    // carries the account's own password.
    let (admin_code, _) = issue_invite(&http, &base, &token, fixture.workspace, "admin", 5).await;
    let escalation = post_join(
        &http,
        &base,
        join_payload_with_password(&admin_code, &existing_email, OWNER_PASSWORD),
    )
    .await;
    expect(
        &escalation,
        403,
        "public join cannot escalate an existing member role",
        "an admin link offered to an existing member",
    );

    // …and the permitted direction really is permitted: a plain `member` link
    // redeemed by that same member — who proves the account — joins them without
    // changing anything.
    let allowed = post_join(
        &http,
        &base,
        join_payload_with_password(&live_code, &existing_email, OWNER_PASSWORD),
    )
    .await;
    assert_eq!(
        allowed.status, 200,
        "an existing human rejoining is 200, not 201: {}",
        allowed.body
    );
    assert_eq!(allowed.body["createdMember"], json!(false));
    let role: String = sqlx::query(
        "SELECT role::text FROM workspace_membership WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(fixture.workspace)
    .bind(existing)
    .fetch_one(&su)
    .await
    .expect("role after rejoin")
    .get(0);
    assert_eq!(
        role, "member",
        "the workspace upsert is DO NOTHING: a rejoin never rewrites a role"
    );

    // -- a suspended human cannot join -------------------------------------
    sqlx::query("UPDATE member SET status = 'suspended' WHERE id = $1")
        .bind(existing)
        .execute(&su)
        .await
        .expect("suspend");
    // 새 코드로 간다: dedup(이미 상환)은 Swift에서도 eligibility보다 먼저라
    // (JoinRoutes :45 vs :78) 같은 코드로는 409가 정답이 되어 403 검증에 닿지 못한다.
    let (fresh_code, _) = issue_invite(&http, &base, &token, fixture.workspace, "member", 5).await;
    let suspended = post_join(&http, &base, join_payload(&fresh_code, &existing_email)).await;
    expect(
        &suspended,
        403,
        "human is not eligible to join",
        "a suspended account",
    );

    // -- a workspace with no joinable public channel -----------------------
    let closed = seed(&su, "join-closed").await;
    let closed_token = owner_token(&http, &base, &closed).await;
    let (closed_code, _) =
        issue_invite(&http, &base, &closed_token, closed.workspace, "member", 5).await;
    sqlx::query("UPDATE channel SET archived_at = now() WHERE id = $1")
        .bind(closed.channel)
        .execute(&su)
        .await
        .expect("archive the only public channel");
    let nowhere = post_join(
        &http,
        &base,
        join_payload(
            &closed_code,
            &format!("nowhere-{}@join.test", Uuid::new_v4()),
        ),
    )
    .await;
    expect(
        &nowhere,
        409,
        "workspace has no joinable public channels",
        "an archived-only workspace",
    );

    // A refused join leaves NOTHING behind — not a member, not a redemption,
    // not a spent use. This is the property the rollback-on-rejection channel
    // exists for, and it is asserted on the refusal that happens *after* the
    // member row was already inserted in the transaction.
    let stranded: i64 = sqlx::query(
        "SELECT count(*)::bigint FROM member \
          WHERE workspace_id = $1 AND handle LIKE 'nowhere-%'",
    )
    .bind(closed.workspace)
    .fetch_one(&su)
    .await
    .expect("count stranded members")
    .get(0);
    assert_eq!(
        stranded, 0,
        "a 409 must roll back the member row the transaction had already written"
    );
    let spent: i32 = sqlx::query("SELECT used_count FROM invite_code WHERE workspace_id = $1")
        .bind(closed.workspace)
        .fetch_one(&su)
        .await
        .expect("used_count")
        .get(0);
    assert_eq!(spent, 0, "a refused join must not spend a use");
}

/// ADR-0215 D2 (#4593) on `POST /v1/join`: the joining human is choosing a
/// password, so it must be at least 10 characters and at most 72 bytes.
///
/// The invite is single-use on purpose. A refusal is a coded 400 before any
/// statement runs, so none of the refusals below spends it, creates a member, or
/// leaves a row behind — and the very same code then takes a valid password.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_joining_password_is_held_to_the_new_password_rule() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, "join-rule").await;
    let base = start_server(app_pool, RateLimitConfig::default()).await;
    let http = reqwest::Client::new();
    let token = owner_token(&http, &base, &fixture).await;
    let (code, invite_id) =
        issue_invite(&http, &base, &token, fixture.workspace, "member", 1).await;

    let join = |email: String, password: Value| {
        let mut payload = json!({
            "code": code,
            "email": email,
            "displayName": "Joining Human",
            "timeZone": "Asia/Seoul",
        });
        if !password.is_null() {
            payload["password"] = password;
        }
        payload
    };

    let mut emails = Vec::new();
    for (index, (case, password, expected)) in password_cases::refused().into_iter().enumerate() {
        let email = format!("refused-{index}-{}@join.test", Uuid::new_v4());
        let attempt = post_join(&http, &base, join(email.clone(), json!(password))).await;
        assert_eq!(attempt.status, 400, "{case}: {}", attempt.body);
        assert_eq!(
            attempt.body["error"]["code"],
            json!(expected),
            "{case}: {}",
            attempt.body
        );
        emails.push(email);
    }
    // Empty and absent keep the sentence they always had, with no code.
    for (case, password) in [("empty", json!("")), ("absent", Value::Null)] {
        let email = format!("blank-{case}-{}@join.test", Uuid::new_v4());
        let attempt = post_join(&http, &base, join(email.clone(), password)).await;
        assert_eq!(attempt.status, 400, "{case}: {}", attempt.body);
        assert_eq!(
            attempt.body["error"]["message"],
            json!("password is required"),
            "{case}: {}",
            attempt.body
        );
        assert!(
            attempt.body["error"].get("code").is_none(),
            "{case}: a missing password has never carried an error.code: {}",
            attempt.body
        );
        emails.push(email);
    }

    // Nothing was left behind, and the single use is intact.
    for email in &emails {
        let members: i64 = sqlx::query(
            "SELECT count(*)::bigint FROM human WHERE workspace_id = $1 AND email = $2",
        )
        .bind(fixture.workspace)
        .bind(email)
        .fetch_one(&su)
        .await
        .expect("count humans")
        .get(0);
        assert_eq!(members, 0, "{email}: a refused join creates no member");
    }
    let spent: i32 = sqlx::query("SELECT used_count FROM invite_code WHERE id = $1")
        .bind(Uuid::parse_str(&invite_id).expect("invite id"))
        .fetch_one(&su)
        .await
        .expect("used_count")
        .get(0);
    assert_eq!(spent, 0, "a refused join must not spend a use");

    // The same single-use code, ten characters: the shortest the rule accepts.
    let email = format!("ten-{}@join.test", Uuid::new_v4());
    let attempt = post_join(
        &http,
        &base,
        join(email.clone(), json!(password_cases::TEN_CHARS)),
    )
    .await;
    assert_eq!(attempt.status, 201, "{}", attempt.body);
    let signed_in = login(
        &http,
        &base,
        fixture.workspace,
        &email,
        password_cases::TEN_CHARS,
    )
    .await;
    assert!(signed_in["accessToken"].is_string(), "{signed_in}");
}

/// The rule is judged **before the invite is looked up** (ADR-0215 D2, #4593
/// security review L-1), so a refused password gets the same answer whatever
/// state the invite is in, and nobody can tell from it which codes exist, are
/// spent, have expired or were revoked.
///
/// The regression this holds is a reorder that looks the invite up first: it
/// would answer 404 for an unknown code, 410 for an expired or revoked one and
/// 409 for a spent one, and keep the 400 for the live one alone — turning the
/// password check into an invite-existence oracle. Every other test in this file
/// uses a live invite, so none of them would notice.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_refused_join_password_is_answered_the_same_whatever_state_the_invite_is_in() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, "join-rule-order").await;
    let base = start_server(app_pool, RateLimitConfig::default()).await;
    let http = reqwest::Client::new();
    let token = owner_token(&http, &base, &fixture).await;

    // Five codes in five states: live, unknown, expired, revoked, spent.
    let (live_code, live_id) =
        issue_invite(&http, &base, &token, fixture.workspace, "member", 5).await;
    let unknown_code = "this-code-was-never-issued".to_string();

    let (expired_code, expired_id) =
        issue_invite(&http, &base, &token, fixture.workspace, "member", 5).await;
    sqlx::query(
        // invite_code_expires_ck(만료>생성)를 존중해 생성 시각도 함께 과거로 옮긴다.
        "UPDATE invite_code SET created_at = now() - interval '2 hours', \
         expires_at = now() - interval '1 hour' WHERE id = $1",
    )
    .bind(Uuid::parse_str(&expired_id).expect("invite id"))
    .execute(&su)
    .await
    .expect("expire the invite");

    let (revoked_code, revoked_id) =
        issue_invite(&http, &base, &token, fixture.workspace, "member", 5).await;
    sqlx::query("UPDATE invite_code SET revoked_at = now(), revoked_by = $2 WHERE id = $1")
        .bind(Uuid::parse_str(&revoked_id).expect("invite id"))
        .bind(fixture.owner)
        .execute(&su)
        .await
        .expect("revoke the invite");

    let (spent_code, _) = issue_invite(&http, &base, &token, fixture.workspace, "member", 1).await;
    let first = post_join(
        &http,
        &base,
        join_payload(&spent_code, &format!("first-{}@join.test", Uuid::new_v4())),
    )
    .await;
    assert_eq!(first.status, 201, "{}", first.body);

    // The premise: with a password the rule accepts, the dead codes really do
    // answer differently. Without this, "the same answer" would prove nothing.
    for (state, code, expected) in [
        ("unknown", &unknown_code, 404),
        ("expired", &expired_code, 410),
        ("revoked", &revoked_code, 410),
        ("spent", &spent_code, 409),
    ] {
        let attempt = post_join(
            &http,
            &base,
            join_payload(code, &format!("control-{}@join.test", Uuid::new_v4())),
        )
        .await;
        assert_eq!(
            attempt.status, expected,
            "{state}: a valid password still meets the invite's own verdict: {}",
            attempt.body
        );
    }

    // The point: a refused password gets the live invite's 400 from all five.
    let states = [
        ("live", &live_code),
        ("unknown", &unknown_code),
        ("expired", &expired_code),
        ("revoked", &revoked_code),
        ("spent", &spent_code),
    ];
    for (case, password, expected) in password_cases::refused() {
        let mut answers = Vec::new();
        for (state, code) in states {
            let attempt = post_join(
                &http,
                &base,
                json!({
                    "code": code,
                    "email": format!("order-{}@join.test", Uuid::new_v4()),
                    "displayName": "Joining Human",
                    "password": password,
                    "timeZone": "Asia/Seoul",
                }),
            )
            .await;
            assert_eq!(
                attempt.status, 400,
                "{case} / {state} invite: {}",
                attempt.body
            );
            assert_eq!(
                attempt.body["error"]["code"],
                json!(expected),
                "{case} / {state} invite: {}",
                attempt.body
            );
            answers.push((state, attempt.body));
        }
        let (_, live_answer) = &answers[0];
        for (state, answer) in &answers[1..] {
            assert_eq!(
                answer, live_answer,
                "{case}: the {state} invite must be answered exactly like the live one"
            );
        }
    }

    // And none of it spent the live invite.
    let spent: i32 = sqlx::query("SELECT used_count FROM invite_code WHERE id = $1")
        .bind(Uuid::parse_str(&live_id).expect("invite id"))
        .fetch_one(&su)
        .await
        .expect("used_count")
        .get(0);
    assert_eq!(spent, 0, "a refused join must not spend a use");
}

/// The accepting side: every shape on the boundary joins, and signs in with
/// exactly the string it joined with (nothing trimmed, nothing normalised).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn every_accepted_join_password_signs_in_exactly_as_typed() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, "join-rule-ok").await;
    let base = start_server(app_pool, RateLimitConfig::default()).await;
    let http = reqwest::Client::new();
    let token = owner_token(&http, &base, &fixture).await;

    for (case, password) in password_cases::accepted() {
        let (code, _) = issue_invite(&http, &base, &token, fixture.workspace, "member", 1).await;
        let email = format!("accepted-{}@join.test", Uuid::new_v4());
        let attempt = post_join(
            &http,
            &base,
            json!({
                "code": code,
                "email": email,
                "displayName": "Joining Human",
                "password": password,
            }),
        )
        .await;
        assert_eq!(attempt.status, 201, "{case}: {}", attempt.body);
        let signed_in = login(&http, &base, fixture.workspace, &email, &password).await;
        assert!(
            signed_in["accessToken"].is_string(),
            "{case}: the stored password signs in with the bytes it was set with: {signed_in}"
        );
    }
}

// ---------------------------------------------------------------------------
// 3. the rate limit
// ---------------------------------------------------------------------------

/// `POST /v1/join` is an unauthenticated write and it takes a bearer string in
/// the body, so an unlimited number of guesses is exactly what must not be
/// available.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_public_join_route_sheds_a_flood_from_one_address() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let _fixture = seed(&su, "join-limit").await;
    let base = start_server(
        app_pool,
        RateLimitConfig {
            per_ip_limit: 2,
            ..RateLimitConfig::default()
        },
    )
    .await;
    let http = reqwest::Client::new();

    let guess = |ip: &'static str| {
        let http = http.clone();
        let base = base.clone();
        async move {
            http.post(format!("{base}/v1/join"))
                .header("x-forwarded-for", ip)
                .json(&join_payload(
                    "a-code-that-does-not-exist",
                    "flood@join.test",
                ))
                .send()
                .await
                .expect("join guess")
        }
    };

    // Two guesses get the honest 404 …
    for attempt in 0..2 {
        assert_eq!(
            guess("198.51.100.7").await.status().as_u16(),
            404,
            "guess {attempt} is within the limit"
        );
    }
    // …the third is shed before it reaches the handler.
    let shed = guess("198.51.100.7").await;
    assert_eq!(shed.status().as_u16(), 429);
    let retry_after = shed
        .headers()
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .expect("a 429 must tell the client when to come back");
    assert!(
        (1..=60).contains(&retry_after),
        "Retry-After must be inside the window and never zero: {retry_after}"
    );
    let body: Value = shed.json().await.expect("429 body");
    assert_eq!(
        body["error"]["message"], "rate limit exceeded",
        "the 429 uses the same error envelope as every other refusal: {body}"
    );

    // A different address is unaffected — one noisy client must not close the
    // door on everyone else's onboarding.
    assert_eq!(
        guess("203.0.113.9").await.status().as_u16(),
        404,
        "the limit is per address, not global"
    );
}

// ---------------------------------------------------------------------------
// 4. the locked lookup's role boundary
// ---------------------------------------------------------------------------

/// `momo_join_private.invite_workspace_id` is the one primitive that reads
/// `invite_code` **without** a tenant GUC, so the grant on it is the whole
/// boundary: migration 009 revokes it from PUBLIC and every background role, and
/// `bootstrap_roles.sql` re-asserts that after the roles are created.
///
/// Both halves are required. "momo_app can" alone would pass against a function
/// granted to PUBLIC; "relay cannot" alone would pass against a function that
/// does not exist.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn only_the_api_role_may_execute_the_locked_invite_lookup() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, "join-grant").await;
    let base = start_server(app_pool.clone(), RateLimitConfig::default()).await;
    let http = reqwest::Client::new();
    let token = owner_token(&http, &base, &fixture).await;
    let (code, _) = issue_invite(&http, &base, &token, fixture.workspace, "member", 1).await;

    // momo_app resolves the code — and resolves it to the RIGHT workspace, so a
    // green result cannot come from a function that returns NULL for everything.
    let resolved = momo_settings::resolve_invite_workspace(
        &mut app_pool.acquire().await.expect("momo_app connection"),
        &code,
    )
    .await
    .expect("momo_app may execute the locked lookup");
    assert_eq!(resolved, Some(fixture.workspace));
    assert_eq!(
        momo_settings::resolve_invite_workspace(
            &mut app_pool.acquire().await.expect("momo_app connection"),
            "not-a-real-code",
        )
        .await
        .expect("an unknown code is not an error"),
        None,
        "an unknown code resolves to nothing rather than raising"
    );

    // Every background role is refused. They are BYPASSRLS, which is exactly why
    // they must not reach a function that resolves a tenant id from a bearer.
    for (role, env_key) in [
        ("momo_relay", "MOMO_RELAY_PASSWORD"),
        ("momo_worker", "MOMO_WORKER_PASSWORD"),
        ("momo_notifier", "MOMO_NOTIFIER_PASSWORD"),
    ] {
        let pool = role_pool(role, env_key)
            .await
            .unwrap_or_else(|error| panic!("connect as {role}: {error}"));
        let mut conn = pool
            .acquire()
            .await
            .unwrap_or_else(|error| panic!("{role} connection: {error}"));
        let denied = momo_settings::resolve_invite_workspace(&mut conn, &code).await;
        let error = denied.err().unwrap_or_else(|| {
            panic!("{role} must NOT be able to execute momo_join_private.invite_workspace_id")
        });
        let rendered = error.to_string();
        assert!(
            rendered.contains("permission denied") || rendered.contains("does not exist"),
            "{role} was refused for the wrong reason: {rendered}"
        );
        // sqlx Pool::close()는 대출 중 커넥션의 반납을 기다린다 — conn을 든 채
        // 부르면 자기 자신을 기다리는 데드락(게이트 44분 행 실측). 먼저 반납한다.
        drop(conn);
        pool.close().await;
    }
}

// ---------------------------------------------------------------------------
// 5. the tenant boundary on what a join writes
// ---------------------------------------------------------------------------

/// Everything a join creates is tenant data, and RLS — not a `WHERE` clause — is
/// what keeps it inside its workspace.
///
/// The second half of each assertion is what makes the first half evidence: the
/// same queries are re-run under the owning tenant's GUC and must find the rows,
/// so a green result cannot come from a broken query.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_foreign_tenant_sees_none_of_the_rows_a_join_wrote() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let owner = seed(&su, "join-owner").await;
    let stranger = seed(&su, "join-stranger").await;
    let base = start_server(app_pool.clone(), RateLimitConfig::default()).await;
    let http = reqwest::Client::new();

    let token = owner_token(&http, &base, &owner).await;
    let (code, _) = issue_invite(&http, &base, &token, owner.workspace, "member", 1).await;
    let joiner_email = format!("tenant-{}@join.test", Uuid::new_v4());
    let joined = post_join(&http, &base, join_payload(&code, &joiner_email)).await;
    assert_eq!(joined.status, 201, "{}", joined.body);
    let member_id: Uuid = joined.body["member"]["id"]
        .as_str()
        .and_then(|id| Uuid::parse_str(id).ok())
        .expect("member id");

    // Under the STRANGER's GUC none of it exists.
    momo_db::with_tenant_tx(&app_pool, stranger.workspace, move |conn| {
        Box::pin(async move {
            let redemptions: i64 =
                sqlx::query_scalar("SELECT count(*)::bigint FROM invite_code_redemption")
                    .fetch_one(&mut *conn)
                    .await?;
            assert_eq!(redemptions, 0, "invite_code_redemption crossed a tenant");
            let workspace_memberships: i64 = sqlx::query_scalar(
                "SELECT count(*)::bigint FROM workspace_membership WHERE member_id = $1",
            )
            .bind(member_id)
            .fetch_one(&mut *conn)
            .await?;
            assert_eq!(
                workspace_memberships, 0,
                "workspace_membership crossed a tenant"
            );
            let channel_memberships: i64 =
                sqlx::query_scalar("SELECT count(*)::bigint FROM membership WHERE member_id = $1")
                    .bind(member_id)
                    .fetch_one(&mut *conn)
                    .await?;
            assert_eq!(channel_memberships, 0, "membership crossed a tenant");
            let humans: i64 =
                sqlx::query_scalar("SELECT count(*)::bigint FROM human WHERE member_id = $1")
                    .bind(member_id)
                    .fetch_one(&mut *conn)
                    .await?;
            assert_eq!(humans, 0, "the human identity crossed a tenant");
            Ok(())
        })
    })
    .await
    .expect("foreign tenant read");

    // …and the same queries find them under the owner's GUC.
    momo_db::with_tenant_tx(&app_pool, owner.workspace, move |conn| {
        Box::pin(async move {
            let redemptions: i64 =
                sqlx::query_scalar("SELECT count(*)::bigint FROM invite_code_redemption")
                    .fetch_one(&mut *conn)
                    .await?;
            assert_eq!(redemptions, 1);
            let workspace_memberships: i64 = sqlx::query_scalar(
                "SELECT count(*)::bigint FROM workspace_membership WHERE member_id = $1",
            )
            .bind(member_id)
            .fetch_one(&mut *conn)
            .await?;
            assert_eq!(workspace_memberships, 1);
            let channel_memberships: i64 =
                sqlx::query_scalar("SELECT count(*)::bigint FROM membership WHERE member_id = $1")
                    .bind(member_id)
                    .fetch_one(&mut *conn)
                    .await?;
            assert_eq!(channel_memberships, 1);
            Ok(())
        })
    })
    .await
    .expect("owner tenant read");

    // The stranger's own workspace still cannot be joined with the owner's code:
    // the code resolves to the owner's tenant, not to whoever presents it.
    let resolved = momo_settings::resolve_invite_workspace(
        &mut app_pool.acquire().await.expect("connection"),
        &code,
    )
    .await
    .expect("resolve");
    assert_eq!(
        resolved,
        Some(owner.workspace),
        "a code names its own workspace and no other"
    );
    assert_ne!(resolved, Some(stranger.workspace));
}

// ---------------------------------------------------------------------------
// 6. the pre-flight lookups normalise their own argument (#1248)
// ---------------------------------------------------------------------------

/// The four email-keyed pre-flight reads must find their rows **without** the
/// caller having normalised first.
///
/// This is the one property the HTTP route cannot express, and that is exactly
/// why the defect existed: `POST /v1/join` runs `normalized_join_email` before
/// anything else, so every request that reaches `redeem_invite_in_tx` through the
/// route arrives pre-folded and the raw `h.email = $1` comparisons looked correct
/// forever. The discipline lived in the callers — and #1234 is what it looks like
/// when one caller forgets it (`verify_password_login` skipped precisely this
/// step, and an account that existed could not sign in).
///
/// So this test calls `redeem_invite_in_tx` **directly**, with a
/// `JoinRequestValues` built by hand from the spelling a person types rather than
/// the spelling the database holds. Each of the four predicates is reached in
/// turn, in the order the transaction evaluates them, so a green result cannot
/// come from an earlier check absorbing a later one.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_join_pre_flight_normalises_the_address_rather_than_trusting_its_caller() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, "join-email-norm").await;
    let base = start_server(app_pool.clone(), RateLimitConfig::default()).await;
    let http = reqwest::Client::new();
    let token = owner_token(&http, &base, &fixture).await;

    // The spelling the database holds, and the spelling somebody types. The
    // padding is not decoration: `btrim` is half of the fix, and `lower()` alone
    // would still miss on it.
    let stored = format!("norm-{}@join.test", Uuid::new_v4());
    let typed = format!("  {}  ", stored.to_uppercase());

    // -- the account, created the ordinary way (the route DOES normalise) --
    let (first_code, _) = issue_invite(&http, &base, &token, fixture.workspace, "member", 5).await;
    let created = post_join(&http, &base, join_payload(&first_code, &stored)).await;
    assert_eq!(created.status, 201, "{}", created.body);
    let member_id: Uuid = created.body["member"]["id"]
        .as_str()
        .and_then(|id| Uuid::parse_str(id).ok())
        .expect("member id");

    // -- (6) find_human_by_email: the un-normalised spelling REUSES the row --
    //
    // Without the fix this call does not merely mis-answer: it falls through to
    // the create arm and asks `human` to store `  NORM-…@JOIN.TEST  `, which
    // migration 064's `human_email_normalized_ck` refuses. That refusal is the
    // backstop the issue credits — it is why this is a lookup miss rather than a
    // duplicate account — and it is a 500, not a join.
    let (reuse_code, _) = issue_invite(&http, &base, &token, fixture.workspace, "member", 5).await;
    let reused = redeem_directly(&app_pool, fixture.workspace, &reuse_code, &typed).await;
    let outcome = reused.expect("an un-normalised address must still resolve to its account");
    assert!(
        !outcome.created_member,
        "the join reused the existing member rather than creating a second one"
    );
    assert_eq!(
        outcome.member.id, member_id,
        "and it reused THAT member, not merely some member"
    );

    // The read path did not become a write path: the stored spelling is intact.
    let after: String = sqlx::query("SELECT email FROM human WHERE member_id = $1")
        .bind(member_id)
        .fetch_one(&su)
        .await
        .expect("read the stored address back")
        .get(0);
    assert_eq!(
        after, stored,
        "a lookup must not rewrite the row it looked up"
    );

    // -- (10) invite_code_redemption.email: the audit row agrees (#1252) ----
    //
    // Step 10 used to bind `values.email` verbatim, so this very call — the one
    // that proves the *reads* no longer trust their caller — wrote a redemption
    // record spelled `  NORM-…@JOIN.TEST  ` against a `human` row spelled
    // `norm-…@join.test`. Nothing keyed off it, which is why #1248 left it; but
    // the redemption history is the record of who joined, and it disagreed with
    // the account it points at. The column has no CHECK (an audit row is not
    // rewritten after the fact, so 064's repair shape does not apply here) — the
    // write normalises instead, and this is what holds it to that.
    let audited: Vec<(String, String)> = sqlx::query_as(
        "SELECT r.email, h.email FROM invite_code_redemption r \
           JOIN human h ON h.member_id = r.member_id \
          WHERE r.member_id = $1",
    )
    .bind(member_id)
    .fetch_all(&su)
    .await
    .expect("read the redemption records back");
    assert!(
        !audited.is_empty(),
        "the reuse above must have left a redemption record to check"
    );
    for (redeemed_as, account) in &audited {
        assert_eq!(
            redeemed_as, account,
            "the redemption record and the account it names must spell the address the same way"
        );
        assert_eq!(
            redeemed_as, &stored,
            "and that spelling is the normalised one"
        );
    }

    // …and it still discriminates. An address nobody has used takes the create
    // arm, so the green above cannot come from a predicate that matches anything.
    let (fresh_code, _) = issue_invite(&http, &base, &token, fixture.workspace, "member", 5).await;
    let stranger_email = format!("norm-other-{}@join.test", Uuid::new_v4());
    let stranger = redeem_directly(&app_pool, fixture.workspace, &fresh_code, &stranger_email)
        .await
        .expect("an unknown address joins");
    assert!(
        stranger.created_member,
        "an unknown address is a new member"
    );
    assert_ne!(stranger.member.id, member_id);

    // -- (4) redeemed_by_email: the same code, the typed spelling again ----
    let twice = redeem_directly(&app_pool, fixture.workspace, &reuse_code, &typed).await;
    assert_rejected(
        twice,
        momo_settings::JoinRejection::AlreadyRedeemed,
        "a code already spent by this address",
    );

    // -- (5) workspace_role_for_email: an admin link for an existing member --
    let (admin_code, _) = issue_invite(&http, &base, &token, fixture.workspace, "admin", 5).await;
    let escalation = redeem_directly(&app_pool, fixture.workspace, &admin_code, &typed).await;
    assert_rejected(
        escalation,
        momo_settings::JoinRejection::RoleEscalation,
        "an admin link offered to an existing member",
    );

    // -- (3) is_banned: last, because a ban short-circuits everything above --
    sqlx::query(
        "INSERT INTO workspace_ban (workspace_id, email_norm, created_by, reason) \
         VALUES ($1, $2, $3, 'email-normalisation conformance')",
    )
    .bind(fixture.workspace)
    .bind(&stored)
    .bind(fixture.owner)
    .execute(&su)
    .await
    .expect("seed workspace_ban");
    let (banned_code, _) = issue_invite(&http, &base, &token, fixture.workspace, "member", 5).await;
    let banned = redeem_directly(&app_pool, fixture.workspace, &banned_code, &typed).await;
    assert_rejected(
        banned,
        momo_settings::JoinRejection::Banned,
        "a ban recorded against the normalised address",
    );
}

/// Spend a code through `redeem_invite_in_tx` with an email that never met
/// `normalized_join_email` — the caller the route is not.
///
/// `with_tenant_tx` rather than the route's `join_tenant_tx` (which is
/// `pub(crate)`): the rejections this test provokes are all raised in steps 3-5,
/// before the transaction's first write, so committing an empty transaction on a
/// refusal is a no-op here. It would not be for a step-9/10 refusal, which is
/// why the production path uses the rolling-back wrapper.
async fn redeem_directly(
    pool: &PgPool,
    workspace: Uuid,
    code: &str,
    email: &str,
) -> Result<momo_settings::JoinOutcome, momo_settings::JoinError> {
    let values = momo_settings::JoinRequestValues {
        email: email.to_string(),
        display_name: "Un-normalised Caller".to_string(),
        requested_handle: None,
        fallback_handle: format!("probe-{}", &Uuid::new_v4().to_string()[..8]),
        password: JOIN_PASSWORD.to_string(),
        time_zone: "Asia/Seoul".to_string(),
    };
    let code = code.to_string();
    momo_db::with_tenant_tx(pool, workspace, move |conn| {
        Box::pin(async move {
            Ok(momo_settings::redeem_invite_in_tx(
                conn,
                workspace,
                &code,
                &values,
                None,
                // This helper is about the lookups, not the guess budget (section 7
                // is): it says out loud that it is unbudgeted.
                &Unbudgeted,
            )
            .await)
        })
    })
    .await
    .expect("the tenant transaction itself must not fail")
}

/// A [`momo_settings::PasswordGuessBudget`] that always allows — for the tests that
/// call the domain function directly and are about something else.
struct Unbudgeted;

impl momo_settings::PasswordGuessBudget for Unbudgeted {
    fn spend(
        &self,
        _workspace_id: Uuid,
        _member_id: Uuid,
        _email: &str,
    ) -> Result<(), momo_settings::GuessRefused> {
        Ok(())
    }
}

fn assert_rejected(
    result: Result<momo_settings::JoinOutcome, momo_settings::JoinError>,
    expected: momo_settings::JoinRejection,
    case: &str,
) {
    match result {
        Ok(outcome) => panic!(
            "{case}: expected {expected:?}, but the join succeeded (member {})",
            outcome.member.id
        ),
        Err(momo_settings::JoinError::Rejected(rejection)) => {
            assert_eq!(rejection, expected, "{case}")
        }
        Err(momo_settings::JoinError::Db(error)) => {
            panic!("{case}: expected {expected:?}, got a database failure: {error}")
        }
    }
}

// ---------------------------------------------------------------------------
// 7. an existing account is resumed only with proof (#4625)
// ---------------------------------------------------------------------------
//
// An invite code names a workspace and a role, not a person. These tests hold the
// join door to what that implies for an address that already has an account:
//
// * `existing_account_requires_proof` — a wrong password gets login's own refusal
//   and leaves nothing behind (no session, no write to the account, no spent use, no
//   redemption, no audit row); the right one resumes the account untouched;
// * `existing_account_states_other_than_active_are_refused` — `invited` and
//   `deleted` are refused whatever password comes with them, with one answer for both,
//   and `suspended` keeps the refusal it always had;
// * `wrong_guesses_are_budgeted_per_account` — the budget is the account's (not the
//   code's, not the caller's address), is spent before the comparison, and holds under
//   parallel guesses;
// * `join_judges_a_password_the_way_login_does` — the same verdicts as the login door
//   over stored passwords of every shape;
// * `an_existing_account_is_not_discussed_before_the_proof` — the checks that talk
//   about the account (already redeemed, role escalation) wait for the proof;
// * `the_guess_budget_is_spent_once_per_comparison_and_before_it` — the domain
//   contract, called directly;
// * `the_invite_and_the_ban_are_judged_before_the_account` — a dead invite, or a
//   ban, gets the same answer whether or not the address has an account;
// * `a_spent_budget_runs_no_comparison` — the budget is asked before bcrypt runs,
//   told apart by the time a comparison costs;
// * `a_joins_rows_and_session_are_written_by_one_transaction` — the redemption, the
//   audit row and both session rows carry the same transaction id, which is what lets
//   a membership change that waited for the join revoke the session it recorded;
// * `a_membership_change_that_meets_a_join_waits_for_it_and_has_the_last_word` — the
//   join stands in line with every membership change: a removal, suspension,
//   self-leave or role change that arrives while a join is in flight waits for it,
//   and then undoes what it wrote, session included.
//
// Fixture passwords are at least ten characters and carry no NUL, so they stay valid
// when the stricter new-password rule (ADR-0215 D2) reaches the join path.

use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

const MEMBER_PASSWORD: &str = "join-conformance-member-password";
const ADMIN_PASSWORD: &str = "join-conformance-admin-password";
const WRONG_PASSWORD: &str = "join-conformance-not-the-password";

/// What an account's `human.password_hash` holds.
enum Stored<'a> {
    Password(&'a str),
    /// A real bcrypt hash at cost 14 (the app's own is 6), so comparing against it is
    /// slow enough to be told apart from not comparing.
    Costly(&'a str),
    Null,
    Empty,
    Malformed,
}

struct Seeded {
    id: Uuid,
    email: String,
}

/// An account that already exists, written the way the other fixtures write one — by
/// the superuser, past RLS — with a display name and a time zone that no join request
/// in this section ever sends, so "left alone" can be told from "overwritten with the
/// same value".
async fn seed_account(
    su: &PgPool,
    workspace: Uuid,
    label: &str,
    role: &str,
    stored: Stored<'_>,
) -> Seeded {
    let id = Uuid::new_v4();
    let handle = format!("{label}-{}", &id.to_string()[..8]);
    let email = format!("{label}-{id}@join.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $4)",
    )
    .bind(id)
    .bind(workspace)
    .bind(format!("Seeded {label}"))
    .bind(&handle)
    .execute(su)
    .await
    .expect("seed member");
    let (kind, password) = match stored {
        Stored::Password(password) => ("password", password),
        Stored::Costly(password) => ("costly", password),
        Stored::Null => ("null", ""),
        Stored::Empty => ("empty", ""),
        Stored::Malformed => ("malformed", ""),
    };
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz) \
         VALUES ($1, $2, $3, true, \
                 CASE $5::text \
                   WHEN 'password' THEN momo_password_hash($4::text) \
                   WHEN 'costly' THEN crypt($4::text, gen_salt('bf', 14)) \
                   WHEN 'empty' THEN '' \
                   WHEN 'malformed' THEN 'not-a-bcrypt-hash' \
                   ELSE NULL \
                 END, \
                 'Europe/Paris')",
    )
    .bind(id)
    .bind(workspace)
    .bind(&email)
    .bind(password)
    .bind(kind)
    .execute(su)
    .await
    .expect("seed human");
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
    Seeded { id, email }
}

/// Everything about an account a refused join must leave exactly as it found it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct AccountState {
    status: String,
    deleted: bool,
    display_name: String,
    handle: String,
    tz: String,
    email: String,
    password_hash: Option<String>,
    role: Option<String>,
    channel_memberships: i64,
}

async fn account_state(su: &PgPool, member: Uuid) -> AccountState {
    let row = sqlx::query(
        "SELECT m.status::text, m.deleted_at IS NOT NULL, m.display_name, m.handle, \
                h.tz, h.email, h.password_hash \
           FROM member m JOIN human h ON h.member_id = m.id \
          WHERE m.id = $1",
    )
    .bind(member)
    .fetch_one(su)
    .await
    .expect("read the account");
    let role: Option<String> =
        sqlx::query_scalar("SELECT role::text FROM workspace_membership WHERE member_id = $1")
            .bind(member)
            .fetch_optional(su)
            .await
            .expect("read the role");
    let channel_memberships: i64 =
        sqlx::query_scalar("SELECT count(*)::bigint FROM membership WHERE member_id = $1")
            .bind(member)
            .fetch_one(su)
            .await
            .expect("count channel memberships");
    AccountState {
        status: row.get(0),
        deleted: row.get(1),
        display_name: row.get(2),
        handle: row.get(3),
        tz: row.get(4),
        email: row.get(5),
        password_hash: row.get(6),
        role,
        channel_memberships,
    }
}

/// The account plus every row a join writes on its behalf: the sessions, the redemption,
/// the audit row and the spent use of the invite.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Footprint {
    account: AccountState,
    tokens: i64,
    redemptions: i64,
    join_audits: i64,
    used_count: i32,
}

async fn footprint(su: &PgPool, workspace: Uuid, member: Uuid, invite: Uuid) -> Footprint {
    let count = |sql: &'static str, bound: Uuid| async move {
        sqlx::query_scalar::<_, i64>(sql)
            .bind(bound)
            .fetch_one(su)
            .await
            .expect("count")
    };
    let used_count: i32 = sqlx::query_scalar("SELECT used_count FROM invite_code WHERE id = $1")
        .bind(invite)
        .fetch_one(su)
        .await
        .expect("used_count");
    let join_audits: i64 = sqlx::query_scalar(
        "SELECT count(*)::bigint FROM audit_log \
          WHERE workspace_id = $1 AND action = 'invite.join' AND actor_member_id = $2",
    )
    .bind(workspace)
    .bind(member)
    .fetch_one(su)
    .await
    .expect("count audit rows");
    Footprint {
        account: account_state(su, member).await,
        tokens: count(
            "SELECT count(*)::bigint FROM token WHERE actor_member_id = $1",
            member,
        )
        .await,
        redemptions: count(
            "SELECT count(*)::bigint FROM invite_code_redemption WHERE member_id = $1",
            member,
        )
        .await,
        join_audits,
        used_count,
    }
}

/// `POST /v1/join` from a stated source address; the third element is `Retry-After`.
async fn post_join_from(
    http: &reqwest::Client,
    base: &str,
    ip: &str,
    payload: Value,
) -> (u16, Value, Option<u64>) {
    let response = http
        .post(format!("{base}/v1/join"))
        .header("x-forwarded-for", ip)
        .json(&payload)
        .send()
        .await
        .expect("join request");
    let status = response.status().as_u16();
    let retry_after = response
        .headers()
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    let body: Value = response.json().await.unwrap_or(Value::Null);
    (status, body, retry_after)
}

async fn login_status(
    http: &reqwest::Client,
    base: &str,
    workspace: Uuid,
    email: &str,
    password: &str,
) -> u16 {
    http.post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": email,
            "password": password,
            "workspace": workspace.to_string(),
        }))
        .send()
        .await
        .expect("login")
        .status()
        .as_u16()
}

fn uuid_of(raw: &str) -> Uuid {
    Uuid::parse_str(raw).expect("a uuid")
}

/// The answer login's own 401 has, plus the machine code this door adds.
fn invalid_credentials_body() -> Value {
    json!({"error": {"message": "invalid credentials", "code": "invalid_credentials"}})
}

/// A wrong password for an account that exists is login's refusal, and it leaves nothing
/// behind; the right one resumes the account exactly as it was. Run for an owner, an
/// admin and a member, because what a resumed session can do is the account's, not the
/// invite's.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn existing_account_requires_proof() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, "join-proof").await;
    let base = start_server(app_pool, RateLimitConfig::default()).await;
    let http = reqwest::Client::new();
    let token = owner_token(&http, &base, &fixture).await;

    let owner = Seeded {
        id: fixture.owner,
        email: fixture.owner_email.clone(),
    };
    let admin = seed_account(
        &su,
        fixture.workspace,
        "proof-admin",
        "admin",
        Stored::Password(ADMIN_PASSWORD),
    )
    .await;
    let member = seed_account(
        &su,
        fixture.workspace,
        "proof-member",
        "member",
        Stored::Password(MEMBER_PASSWORD),
    )
    .await;

    // (label, account, its password, may its session create invites?)
    let accounts = [
        ("owner", &owner, OWNER_PASSWORD, true),
        ("admin", &admin, ADMIN_PASSWORD, true),
        ("member", &member, MEMBER_PASSWORD, false),
    ];
    for (label, account, password, may_invite) in accounts {
        let (code, invite_id) =
            issue_invite(&http, &base, &token, fixture.workspace, "member", 20).await;
        let invite = uuid_of(&invite_id);
        let before = footprint(&su, fixture.workspace, account.id, invite).await;

        // -- a password that is not the account's: refused, in every spelling ----
        for typed in [
            account.email.clone(),
            format!("  {}  ", account.email.to_uppercase()),
        ] {
            let refused = post_join(
                &http,
                &base,
                join_payload_with_password(&code, &typed, WRONG_PASSWORD),
            )
            .await;
            assert_eq!(
                refused.status, 401,
                "{label} as {typed:?}: {}",
                refused.body
            );
            assert_eq!(refused.body, invalid_credentials_body(), "{label}");
        }
        assert_eq!(
            footprint(&su, fixture.workspace, account.id, invite).await,
            before,
            "{label}: a refused proof leaves no session, no write to the account, no spent \
             use, no redemption and no audit row"
        );

        // -- the account's own password: resumed, and nothing of it rewritten ----
        let resumed = post_join(
            &http,
            &base,
            join_payload_with_password(&code, &account.email, password),
        )
        .await;
        assert_eq!(resumed.status, 200, "{label}: {}", resumed.body);
        assert_eq!(resumed.body["createdMember"], json!(false), "{label}");
        assert_eq!(
            resumed.body["member"]["id"],
            account.id.to_string(),
            "{label}: the session is for the account the address names"
        );
        let access = resumed.body["accessToken"].as_str().expect("access token");
        let probe = http
            .post(format!(
                "{base}/v1/workspaces/{}/invites",
                fixture.workspace
            ))
            .bearer_auth(access)
            .json(&json!({"role": "member", "maxUses": 1}))
            .send()
            .await
            .expect("probe with the resumed session");
        assert_eq!(
            probe.status().as_u16() == 201,
            may_invite,
            "{label}: the resumed session acts with the account's own authority"
        );
        let after = footprint(&su, fixture.workspace, account.id, invite).await;
        assert_eq!(
            AccountState {
                channel_memberships: before.account.channel_memberships,
                ..after.account.clone()
            },
            before.account,
            "{label}: password, name, time zone, status and role are exactly as they were — \
             the request's displayName and timeZone are never written"
        );
        assert!(
            after.account.channel_memberships >= 1,
            "{label}: the resumed account is in the workspace's public channel"
        );
        assert_eq!(after.tokens, before.tokens + 2, "{label}: one session pair");
        assert_eq!(after.used_count, before.used_count + 1, "{label}");
        assert_eq!(after.redemptions, before.redemptions + 1, "{label}");
        assert_eq!(after.join_audits, before.join_audits + 1, "{label}");
        assert_eq!(
            login_status(&http, &base, fixture.workspace, &account.email, password).await,
            200,
            "{label}: the original password still signs in"
        );
    }
}

/// `invited` and `deleted` accounts are never resumed on a public code, whatever
/// password comes with the request — and the answer is the same for both, and for every
/// password, so it does not say which state the account is in. A `suspended` account keeps
/// the refusal it always had. Nothing about any of them changes.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn existing_account_states_other_than_active_are_refused() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, "join-states").await;
    let base = start_server(app_pool, RateLimitConfig::default()).await;
    let http = reqwest::Client::new();
    let token = owner_token(&http, &base, &fixture).await;

    let invited = seed_account(
        &su,
        fixture.workspace,
        "state-invited",
        "member",
        Stored::Password(MEMBER_PASSWORD),
    )
    .await;
    sqlx::query("UPDATE member SET status = 'invited' WHERE id = $1")
        .bind(invited.id)
        .execute(&su)
        .await
        .expect("mark the account invited");

    // `deleted` through the real removal route, so the row is in the state an
    // operator's own action leaves it in.
    let deleted = seed_account(
        &su,
        fixture.workspace,
        "state-deleted",
        "member",
        Stored::Password(MEMBER_PASSWORD),
    )
    .await;
    let removed = http
        .delete(format!(
            "{base}/v1/workspaces/{}/members/{}",
            fixture.workspace, deleted.id
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("remove the member");
    assert_eq!(removed.status().as_u16(), 200, "the operator removes them");

    let suspended = seed_account(
        &su,
        fixture.workspace,
        "state-suspended",
        "member",
        Stored::Password(MEMBER_PASSWORD),
    )
    .await;
    let suspend = http
        .post(format!(
            "{base}/v1/workspaces/{}/members/{}/suspend",
            fixture.workspace, suspended.id
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("suspend the member");
    assert_eq!(suspend.status().as_u16(), 200, "the operator suspends them");

    assert_eq!(account_state(&su, invited.id).await.status, "invited");
    let deleted_before = account_state(&su, deleted.id).await;
    assert_eq!(deleted_before.status, "deleted");
    assert_eq!(
        (
            deleted_before.role.as_deref(),
            deleted_before.channel_memberships
        ),
        (None, 0),
        "removal ends the member's whole presence: no workspace role, no channel"
    );
    assert_eq!(account_state(&su, suspended.id).await.status, "suspended");

    // The password that is the account's, the one a person would pick for a fresh
    // start, and one that is neither: none of them may open a refused account.
    let passwords = [MEMBER_PASSWORD, JOIN_PASSWORD, WRONG_PASSWORD];

    let mut unavailable_answers = Vec::new();
    for (label, account) in [("invited", &invited), ("deleted", &deleted)] {
        let (code, invite_id) =
            issue_invite(&http, &base, &token, fixture.workspace, "member", 20).await;
        let invite = uuid_of(&invite_id);
        let before = footprint(&su, fixture.workspace, account.id, invite).await;
        for password in passwords {
            let refused = post_join(
                &http,
                &base,
                join_payload_with_password(&code, &account.email, password),
            )
            .await;
            assert_eq!(
                refused.status, 409,
                "{label} / {password}: {}",
                refused.body
            );
            assert_eq!(
                refused.body["error"]["code"],
                json!("join_email_unavailable"),
                "{label} / {password}: {}",
                refused.body
            );
            unavailable_answers.push((label, password, refused.body));
        }
        assert_eq!(
            footprint(&su, fixture.workspace, account.id, invite).await,
            before,
            "{label}: no session, no resumption, no write to the account, no spent use"
        );
    }
    let (_, _, first_answer) = &unavailable_answers[0];
    for (label, password, answer) in &unavailable_answers {
        assert_eq!(
            answer, first_answer,
            "{label} / {password}: one answer for every refused state and every password"
        );
    }
    assert_eq!(
        account_state(&su, deleted.id).await,
        deleted_before,
        "a removed account is not re-activated and its password is not replaced"
    );

    // suspended: the refusal that was here before the gate, answered before any
    // comparison (so the same for a right and a wrong password).
    let (code, invite_id) =
        issue_invite(&http, &base, &token, fixture.workspace, "member", 20).await;
    let invite = uuid_of(&invite_id);
    let before = footprint(&su, fixture.workspace, suspended.id, invite).await;
    for password in [MEMBER_PASSWORD, WRONG_PASSWORD] {
        let refused = post_join(
            &http,
            &base,
            join_payload_with_password(&code, &suspended.email, password),
        )
        .await;
        assert_eq!(
            refused.status, 403,
            "suspended / {password}: {}",
            refused.body
        );
        assert_eq!(
            refused.body["error"]["message"],
            json!("human is not eligible to join"),
            "suspended / {password}"
        );
    }
    assert_eq!(
        footprint(&su, fixture.workspace, suspended.id, invite).await,
        before,
        "suspended: nothing changed"
    );
}

/// The guess budget is the account's: not the invite code's, not the caller's source
/// address, and not shared with people who have no account to guess at. It is spent
/// before the comparison, so the attempt after the last allowed one is refused even with
/// the right password, and a burst of parallel guesses cannot all slip through.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn wrong_guesses_are_budgeted_per_account() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, "join-budget").await;
    let base = start_server(
        app_pool,
        RateLimitConfig {
            password_guess_per_account_limit: 3,
            // The per-IP gate is its own test (the flood test above); here it must
            // not be what answers.
            per_ip_limit: 0,
            ..RateLimitConfig::default()
        },
    )
    .await;
    let http = reqwest::Client::new();
    let token = owner_token(&http, &base, &fixture).await;

    let target = seed_account(
        &su,
        fixture.workspace,
        "budget-target",
        "member",
        Stored::Password(MEMBER_PASSWORD),
    )
    .await;
    let bystander = seed_account(
        &su,
        fixture.workspace,
        "budget-bystander",
        "member",
        Stored::Password(MEMBER_PASSWORD),
    )
    .await;

    // Five codes and five source addresses: neither one buys a second budget.
    let mut codes = Vec::new();
    for _ in 0..5 {
        codes.push(issue_invite(&http, &base, &token, fixture.workspace, "member", 20).await);
    }
    for (attempt, (code, _)) in codes.iter().enumerate().take(3) {
        let (status, body, _) = post_join_from(
            &http,
            &base,
            &format!("198.51.100.{attempt}"),
            join_payload_with_password(code, &target.email, WRONG_PASSWORD),
        )
        .await;
        assert_eq!(status, 401, "guess {attempt} is inside the budget: {body}");
    }

    // The fourth carries the RIGHT password, in another spelling of the address, from
    // another source, with another code — and is refused anyway, because the budget is
    // spent before the comparison and belongs to the account.
    let invite = uuid_of(&codes[3].1);
    let before = footprint(&su, fixture.workspace, target.id, invite).await;
    let (status, body, retry_after) = post_join_from(
        &http,
        &base,
        "203.0.113.77",
        join_payload_with_password(
            &codes[3].0,
            &format!("  {}  ", target.email.to_uppercase()),
            MEMBER_PASSWORD,
        ),
    )
    .await;
    assert_eq!(status, 429, "{body}");
    assert_eq!(
        body,
        json!({"error": {"message": "rate limit exceeded"}}),
        "the same body every other limiter answers with"
    );
    assert!(
        retry_after.is_some_and(|seconds| (1..=60).contains(&seconds)),
        "a 429 says when to come back, inside the window and never zero: {retry_after:?}"
    );
    assert_eq!(
        footprint(&su, fixture.workspace, target.id, invite).await,
        before,
        "a refused guess — even a right one — mints no session and spends nothing"
    );

    // It is the account's budget and nobody else's.
    let (code, _) = &codes[4];
    let (status, body, _) = post_join_from(
        &http,
        &base,
        "203.0.113.78",
        join_payload_with_password(code, &bystander.email, MEMBER_PASSWORD),
    )
    .await;
    assert_eq!(status, 200, "another account is unaffected: {body}");
    let (code, _) = issue_invite(&http, &base, &token, fixture.workspace, "member", 20).await;
    let (status, body, _) = post_join_from(
        &http,
        &base,
        "203.0.113.79",
        join_payload(&code, &format!("new-{}@join.test", Uuid::new_v4())),
    )
    .await;
    assert_eq!(
        status, 201,
        "someone with no account has nothing to guess at and no budget to spend: {body}"
    );

    // Login is not part of this change: the budget does not reach it.
    assert_eq!(
        login_status(
            &http,
            &base,
            fixture.workspace,
            &target.email,
            MEMBER_PASSWORD
        )
        .await,
        200,
        "login has no limiter of its own yet (ADR-0215 F9, #4597) and this budget is not it"
    );

    // Parallel guesses: twelve at once, each with its own code and source, against an
    // account nobody has touched. Admission is atomic, so exactly the budget gets a
    // comparison and the rest are refused — never "everyone looked, nobody had counted".
    let flood_target = seed_account(
        &su,
        fixture.workspace,
        "budget-flood",
        "member",
        Stored::Password(MEMBER_PASSWORD),
    )
    .await;
    let mut flood_codes = Vec::new();
    for _ in 0..12 {
        flood_codes.push(
            issue_invite(&http, &base, &token, fixture.workspace, "member", 20)
                .await
                .0,
        );
    }
    let mut guesses = Vec::new();
    for (index, code) in flood_codes.into_iter().enumerate() {
        let (http, base, email) = (http.clone(), base.clone(), flood_target.email.clone());
        guesses.push(tokio::spawn(async move {
            post_join_from(
                &http,
                &base,
                &format!("192.0.2.{index}"),
                join_payload_with_password(&code, &email, WRONG_PASSWORD),
            )
            .await
            .0
        }));
    }
    let mut statuses = Vec::new();
    for guess in guesses {
        statuses.push(guess.await.expect("guess task"));
    }
    let compared = statuses.iter().filter(|status| **status == 401).count();
    let refused = statuses.iter().filter(|status| **status == 429).count();
    assert_eq!(
        (compared, refused),
        (3, 9),
        "twelve parallel guesses, a budget of three: {statuses:?}"
    );
}

/// The door and the login door reach the same verdict about the same password, over the
/// shapes a stored password can take — a right one, none at all, an empty string, a
/// value that is not bcrypt — and over spellings of the right one that are not it. The
/// one documented difference is the suspended account, which this door answers (403)
/// before it compares anything, as it did before the gate.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn join_judges_a_password_the_way_login_does() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, "join-parity").await;
    let base = start_server(
        app_pool,
        RateLimitConfig {
            // Twenty-odd guesses at four accounts: the budget is not what is measured.
            password_guess_per_account_limit: 10_000,
            per_ip_limit: 0,
            ..RateLimitConfig::default()
        },
    )
    .await;
    let http = reqwest::Client::new();
    let token = owner_token(&http, &base, &fixture).await;

    let right = seed_account(
        &su,
        fixture.workspace,
        "parity-right",
        "member",
        Stored::Password(MEMBER_PASSWORD),
    )
    .await;
    let none = seed_account(
        &su,
        fixture.workspace,
        "parity-null",
        "member",
        Stored::Null,
    )
    .await;
    let empty = seed_account(
        &su,
        fixture.workspace,
        "parity-empty",
        "member",
        Stored::Empty,
    )
    .await;
    let malformed = seed_account(
        &su,
        fixture.workspace,
        "parity-bad",
        "member",
        Stored::Malformed,
    )
    .await;

    let spellings = [
        MEMBER_PASSWORD.to_string(),
        WRONG_PASSWORD.to_string(),
        format!("{MEMBER_PASSWORD} "),
        MEMBER_PASSWORD.to_uppercase(),
    ];
    let mut agreed_resumed = 0;
    let mut agreed_refused = 0;
    for (label, account) in [
        ("right", &right),
        ("no stored password", &none),
        ("empty stored password", &empty),
        ("not a bcrypt string", &malformed),
    ] {
        let before = account_state(&su, account.id).await;
        for password in &spellings {
            let on_login =
                login_status(&http, &base, fixture.workspace, &account.email, password).await;
            let (code, _) =
                issue_invite(&http, &base, &token, fixture.workspace, "member", 1).await;
            let on_join = post_join(
                &http,
                &base,
                join_payload_with_password(&code, &account.email, password),
            )
            .await
            .status;
            assert_eq!(
                on_login, on_join,
                "{label} / {password:?}: login answered {on_login}, join answered {on_join}"
            );
            match on_join {
                200 => agreed_resumed += 1,
                401 => agreed_refused += 1,
                other => panic!("{label} / {password:?}: unexpected status {other}"),
            }
        }
        // The one account that is let in joins the public channel, which is the join
        // doing its job; everything else about every account is exactly as it was.
        let after = account_state(&su, account.id).await;
        assert_eq!(
            AccountState {
                channel_memberships: before.channel_memberships,
                ..after
            },
            before,
            "{label}: neither door writes a password — an account with none stays without"
        );
    }
    assert_eq!(
        (agreed_resumed, agreed_refused),
        (1, 15),
        "only the right account with the right password gets in, through either door"
    );

    // The documented difference: a suspended account.
    let suspended = seed_account(
        &su,
        fixture.workspace,
        "parity-suspended",
        "member",
        Stored::Password(MEMBER_PASSWORD),
    )
    .await;
    sqlx::query("UPDATE member SET status = 'suspended' WHERE id = $1")
        .bind(suspended.id)
        .execute(&su)
        .await
        .expect("suspend");
    let (code, _) = issue_invite(&http, &base, &token, fixture.workspace, "member", 5).await;
    assert_eq!(
        login_status(
            &http,
            &base,
            fixture.workspace,
            &suspended.email,
            MEMBER_PASSWORD
        )
        .await,
        403,
        "login: a right password, a suspended account"
    );
    assert_eq!(
        post_join(
            &http,
            &base,
            join_payload_with_password(&code, &suspended.email, MEMBER_PASSWORD)
        )
        .await
        .status,
        403,
        "join: the same"
    );
    assert_eq!(
        login_status(
            &http,
            &base,
            fixture.workspace,
            &suspended.email,
            WRONG_PASSWORD
        )
        .await,
        401,
        "login compares first and says 401 to a wrong password"
    );
    assert_eq!(
        post_join(
            &http,
            &base,
            join_payload_with_password(&code, &suspended.email, WRONG_PASSWORD)
        )
        .await
        .status,
        403,
        "join answers a suspended account's 403 before any comparison, as it always did"
    );
}

/// The two checks that talk about an existing account — "this code was already spent by
/// it" and "it holds a higher role than this link grants" — are owed only to someone who
/// has shown they hold the account. Before the proof the answer is the same refusal login
/// gives a wrong password; after it, the checks answer as they always did.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_existing_account_is_not_discussed_before_the_proof() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, "join-order").await;
    let base = start_server(app_pool, RateLimitConfig::default()).await;
    let http = reqwest::Client::new();
    let token = owner_token(&http, &base, &fixture).await;

    let member = seed_account(
        &su,
        fixture.workspace,
        "order-member",
        "member",
        Stored::Password(MEMBER_PASSWORD),
    )
    .await;

    // The account spends this code once, properly.
    let (spent_code, _) = issue_invite(&http, &base, &token, fixture.workspace, "member", 20).await;
    let first = post_join(
        &http,
        &base,
        join_payload_with_password(&spent_code, &member.email, MEMBER_PASSWORD),
    )
    .await;
    assert_eq!(first.status, 200, "{}", first.body);

    // -- already redeemed: only the holder is told ---------------------------
    let stranger = post_join(
        &http,
        &base,
        join_payload_with_password(&spent_code, &member.email, WRONG_PASSWORD),
    )
    .await;
    assert_eq!(stranger.status, 401, "{}", stranger.body);
    assert_eq!(stranger.body, invalid_credentials_body());
    let holder = post_join(
        &http,
        &base,
        join_payload_with_password(&spent_code, &member.email, MEMBER_PASSWORD),
    )
    .await;
    assert_eq!(holder.status, 409, "{}", holder.body);
    assert_eq!(
        holder.body["error"]["message"],
        json!("invite code was already redeemed by this member")
    );

    // -- role escalation: only the holder is told ----------------------------
    let (admin_code, _) = issue_invite(&http, &base, &token, fixture.workspace, "admin", 20).await;
    let stranger = post_join(
        &http,
        &base,
        join_payload_with_password(&admin_code, &member.email, WRONG_PASSWORD),
    )
    .await;
    assert_eq!(stranger.status, 401, "{}", stranger.body);
    assert_eq!(stranger.body, invalid_credentials_body());
    let holder = post_join(
        &http,
        &base,
        join_payload_with_password(&admin_code, &member.email, MEMBER_PASSWORD),
    )
    .await;
    assert_eq!(holder.status, 403, "{}", holder.body);
    assert_eq!(
        holder.body["error"]["message"],
        json!("public join cannot escalate an existing member role")
    );
    let role: String = sqlx::query_scalar(
        "SELECT role::text FROM workspace_membership WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(fixture.workspace)
    .bind(member.id)
    .fetch_one(&su)
    .await
    .expect("role");
    assert_eq!(role, "member", "the refused escalation changed nothing");
}

/// A [`momo_settings::PasswordGuessBudget`] that counts the guesses it is asked for,
/// remembers whose they were, and either allows them all or refuses them all.
struct CountingBudget {
    spent: AtomicUsize,
    seen: Mutex<Vec<(Uuid, Uuid, String)>>,
    refuse_with: Option<u64>,
}

impl CountingBudget {
    fn allowing() -> Self {
        CountingBudget {
            spent: AtomicUsize::new(0),
            seen: Mutex::new(Vec::new()),
            refuse_with: None,
        }
    }

    fn refusing(retry_after_seconds: u64) -> Self {
        CountingBudget {
            refuse_with: Some(retry_after_seconds),
            ..CountingBudget::allowing()
        }
    }

    fn spent(&self) -> usize {
        self.spent.load(AtomicOrdering::SeqCst)
    }
}

impl momo_settings::PasswordGuessBudget for CountingBudget {
    fn spend(
        &self,
        workspace_id: Uuid,
        member_id: Uuid,
        email: &str,
    ) -> Result<(), momo_settings::GuessRefused> {
        self.spent.fetch_add(1, AtomicOrdering::SeqCst);
        self.seen
            .lock()
            .expect("budget log")
            .push((workspace_id, member_id, email.to_string()));
        match self.refuse_with {
            Some(retry_after_seconds) => Err(momo_settings::GuessRefused {
                retry_after_seconds,
            }),
            None => Ok(()),
        }
    }
}

/// The domain contract, called directly: a guess is spent for an `active` account and for
/// no one else, it is spent against the account as the database stores it, and it is spent
/// **before** the comparison — a refusing budget turns even the right password away.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_guess_budget_is_spent_once_per_comparison_and_before_it() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, "join-contract").await;
    let base = start_server(app_pool.clone(), RateLimitConfig::default()).await;
    let http = reqwest::Client::new();
    let token = owner_token(&http, &base, &fixture).await;

    let active = seed_account(
        &su,
        fixture.workspace,
        "contract-active",
        "member",
        Stored::Password(MEMBER_PASSWORD),
    )
    .await;
    let invited = seed_account(
        &su,
        fixture.workspace,
        "contract-invited",
        "member",
        Stored::Password(MEMBER_PASSWORD),
    )
    .await;
    let deleted = seed_account(
        &su,
        fixture.workspace,
        "contract-deleted",
        "member",
        Stored::Password(MEMBER_PASSWORD),
    )
    .await;
    let suspended = seed_account(
        &su,
        fixture.workspace,
        "contract-suspended",
        "member",
        Stored::Password(MEMBER_PASSWORD),
    )
    .await;
    for (account, status) in [
        (&invited, "invited"),
        (&deleted, "deleted"),
        (&suspended, "suspended"),
    ] {
        sqlx::query("UPDATE member SET status = $2::member_status WHERE id = $1")
            .bind(account.id)
            .bind(status)
            .execute(&su)
            .await
            .expect("set the status");
    }

    let attempt = |budget: Arc<CountingBudget>, email: String, password: &'static str| {
        let (pool, workspace) = (app_pool.clone(), fixture.workspace);
        let (http, base, token) = (http.clone(), base.clone(), token.clone());
        async move {
            let (code, _) = issue_invite(&http, &base, &token, workspace, "member", 5).await;
            redeem_with_budget(&pool, workspace, &code, &email, password, budget).await
        }
    };

    // No account, an invited, a deleted and a suspended one: no guess is ever spent.
    let allowing = Arc::new(CountingBudget::allowing());
    let created = attempt(
        allowing.clone(),
        format!("contract-new-{}@join.test", Uuid::new_v4()),
        JOIN_PASSWORD,
    )
    .await
    .expect("an unused address joins");
    assert!(created.created_member);
    for (account, expected) in [
        (&invited, momo_settings::JoinRejection::EmailUnavailable),
        (&deleted, momo_settings::JoinRejection::EmailUnavailable),
        (&suspended, momo_settings::JoinRejection::HumanIneligible),
    ] {
        let result = attempt(allowing.clone(), account.email.clone(), MEMBER_PASSWORD).await;
        assert_rejected(result, expected, "an account the gate refuses outright");
    }
    assert_eq!(
        allowing.spent(),
        0,
        "no guess is spent where no comparison can matter"
    );

    // An active account: one guess per comparison, against the account as stored.
    let resumed = attempt(
        allowing.clone(),
        format!("  {}  ", active.email.to_uppercase()),
        MEMBER_PASSWORD,
    )
    .await
    .expect("the right password resumes the account");
    assert_eq!(resumed.member.id, active.id);
    let wrong = attempt(allowing.clone(), active.email.clone(), WRONG_PASSWORD).await;
    assert_rejected(
        wrong,
        momo_settings::JoinRejection::InvalidCredentials,
        "a wrong password",
    );
    assert_eq!(
        allowing.spent(),
        2,
        "one guess per comparison, right or wrong"
    );
    let seen = allowing.seen.lock().expect("budget log").clone();
    assert!(
        seen.iter().all(|(workspace, member, email)| {
            *workspace == fixture.workspace && *member == active.id && *email == active.email
        }),
        "the budget is told the account as the database stores it, not the spelling typed: {seen:?}"
    );

    // Spent BEFORE the comparison: a refusing budget turns the right password away.
    let refusing = Arc::new(CountingBudget::refusing(42));
    let turned_away = attempt(refusing.clone(), active.email.clone(), MEMBER_PASSWORD).await;
    match turned_away {
        Err(momo_settings::JoinError::Rejected(rejection)) => assert_eq!(
            rejection,
            momo_settings::JoinRejection::PasswordGuessLimited {
                retry_after_seconds: 42
            }
        ),
        other => panic!("a refusing budget must end the join, got {other:?}"),
    }
    assert_eq!(refusing.spent(), 1);
}

/// `redeem_directly` with a budget of the caller's choosing and a password of its own.
async fn redeem_with_budget(
    pool: &PgPool,
    workspace: Uuid,
    code: &str,
    email: &str,
    password: &str,
    budget: Arc<CountingBudget>,
) -> Result<momo_settings::JoinOutcome, momo_settings::JoinError> {
    let values = momo_settings::JoinRequestValues {
        email: email.to_string(),
        display_name: "Direct Caller".to_string(),
        requested_handle: None,
        fallback_handle: format!("direct-{}", &Uuid::new_v4().to_string()[..8]),
        password: password.to_string(),
        time_zone: "Asia/Seoul".to_string(),
    };
    let code = code.to_string();
    momo_db::with_tenant_tx(pool, workspace, move |conn| {
        Box::pin(async move {
            Ok(
                momo_settings::redeem_invite_in_tx(conn, workspace, &code, &values, None, &*budget)
                    .await,
            )
        })
    })
    .await
    .expect("the tenant transaction itself must not fail")
}

/// `xmin` of the row a token string was recorded as: the id of the transaction that wrote
/// it. The route records a session under its hash only.
async fn token_xmin(su: &PgPool, raw_token: &str) -> String {
    sqlx::query_scalar("SELECT xmin::text FROM token WHERE token_hash = digest($1::text, 'sha256')")
        .bind(raw_token)
        .fetch_one(su)
        .await
        .expect("the session row the join answered with")
}

/// The session a join answers with is written by **the join's own transaction**: the
/// redemption, the audit row and both token rows carry one transaction id, for an
/// existing account that proves itself and for a new one alike.
///
/// This is the property that lets a suspension or removal that waited for the join revoke
/// the pair it recorded — a pair written afterwards, by a transaction of its own, can be
/// born just after that revocation ran and escape it. The membership-change test shows
/// the consequence, but only by racing; this one states the cause and cannot miss.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_joins_rows_and_session_are_written_by_one_transaction() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, "join-one-tx").await;
    let base = start_server(app_pool, RateLimitConfig::default()).await;
    let http = reqwest::Client::new();
    let token = owner_token(&http, &base, &fixture).await;
    let existing = seed_account(
        &su,
        fixture.workspace,
        "one-tx-existing",
        "member",
        Stored::Password(MEMBER_PASSWORD),
    )
    .await;
    let new_email = format!("one-tx-new-{}@join.test", Uuid::new_v4());

    for (case, email, password, expected_status) in [
        (
            "an existing account",
            existing.email.clone(),
            MEMBER_PASSWORD,
            200,
        ),
        ("a new account", new_email, JOIN_PASSWORD, 201),
    ] {
        let (code, _) = issue_invite(&http, &base, &token, fixture.workspace, "member", 5).await;
        let joined = post_join(
            &http,
            &base,
            join_payload_with_password(&code, &email, password),
        )
        .await;
        assert_eq!(joined.status, expected_status, "{case}: {}", joined.body);
        let member = uuid_of(joined.body["member"]["id"].as_str().expect("member id"));
        let access = joined.body["accessToken"].as_str().expect("access token");
        let refresh = joined.body["refreshToken"].as_str().expect("refresh token");

        let redemption: String = sqlx::query_scalar(
            "SELECT xmin::text FROM invite_code_redemption WHERE member_id = $1 \
              ORDER BY redeemed_at DESC LIMIT 1",
        )
        .bind(member)
        .fetch_one(&su)
        .await
        .expect("the redemption row");
        let audit: String = sqlx::query_scalar(
            "SELECT xmin::text FROM audit_log \
              WHERE workspace_id = $1 AND action = 'invite.join' AND actor_member_id = $2 \
              ORDER BY created_at DESC LIMIT 1",
        )
        .bind(fixture.workspace)
        .bind(member)
        .fetch_one(&su)
        .await
        .expect("the audit row");
        let (access_tx, refresh_tx) = (
            token_xmin(&su, access).await,
            token_xmin(&su, refresh).await,
        );
        assert_eq!(
            [&audit, &access_tx, &refresh_tx],
            [&redemption, &redemption, &redemption],
            "{case}: the redemption, the audit row and both session rows were written by one \
             transaction (redemption {redemption}, audit {audit}, access {access_tx}, \
             refresh {refresh_tx})"
        );
    }
}

/// A dead invite — revoked, expired, spent, or never issued — is answered by the invite
/// alone: asking about an address that has an account, in any state, with a password
/// that is not its, gets exactly what asking about an address that has none gets. The
/// same goes for a ban. Both are judged **before** the account is looked at (the order
/// in the module's docs), and a result that only checked the status codes of live
/// invites would not notice them swapped: a dead invite link, which is easy to come by,
/// would then say which addresses have accounts.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_invite_and_the_ban_are_judged_before_the_account() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, "join-before").await;
    let base = start_server(app_pool, RateLimitConfig::default()).await;
    let http = reqwest::Client::new();
    let token = owner_token(&http, &base, &fixture).await;

    // One account in each state a join can meet.
    let mut accounts = Vec::new();
    for (label, status) in [
        ("before-active", "active"),
        ("before-suspended", "suspended"),
        ("before-invited", "invited"),
        ("before-deleted", "deleted"),
    ] {
        let account = seed_account(
            &su,
            fixture.workspace,
            label,
            "member",
            Stored::Password(MEMBER_PASSWORD),
        )
        .await;
        sqlx::query("UPDATE member SET status = $2::member_status WHERE id = $1")
            .bind(account.id)
            .bind(status)
            .execute(&su)
            .await
            .expect("set the status");
        accounts.push((status, account));
    }

    // The four ways an invite can be dead, each with the answer it is owed.
    let (revoked_code, revoked_id) =
        issue_invite(&http, &base, &token, fixture.workspace, "member", 5).await;
    sqlx::query("UPDATE invite_code SET revoked_at = now(), revoked_by = $2 WHERE id = $1")
        .bind(uuid_of(&revoked_id))
        .bind(fixture.owner)
        .execute(&su)
        .await
        .expect("revoke");
    let (expired_code, expired_id) =
        issue_invite(&http, &base, &token, fixture.workspace, "member", 5).await;
    sqlx::query(
        "UPDATE invite_code SET created_at = now() - interval '2 hours', \
         expires_at = now() - interval '1 hour' WHERE id = $1",
    )
    .bind(uuid_of(&expired_id))
    .execute(&su)
    .await
    .expect("expire");
    let (spent_code, _) = issue_invite(&http, &base, &token, fixture.workspace, "member", 1).await;
    let first = post_join(
        &http,
        &base,
        join_payload(
            &spent_code,
            &format!("spender-{}@join.test", Uuid::new_v4()),
        ),
    )
    .await;
    assert_eq!(first.status, 201, "{}", first.body);
    let dead = [
        ("revoked", revoked_code, 410),
        ("expired", expired_code, 410),
        ("spent", spent_code, 409),
        ("unknown", "this-code-was-never-issued".to_string(), 404),
    ];
    for (kind, code, expected) in &dead {
        let (expected, code) = (*expected, code);
        let control = post_join(
            &http,
            &base,
            join_payload(code, &format!("dead-new-{}@join.test", Uuid::new_v4())),
        )
        .await;
        assert_eq!(
            control.status, expected,
            "{kind}: an address with no account meets the invite's own verdict: {}",
            control.body
        );
        for (status, account) in &accounts {
            let asked = post_join(
                &http,
                &base,
                join_payload_with_password(code, &account.email, WRONG_PASSWORD),
            )
            .await;
            assert_eq!(
                (asked.status, &asked.body),
                (control.status, &control.body),
                "{kind} invite / {status} account: a dead invite must say nothing about the account"
            );
        }
    }

    // A ban is judged before the account too: a banned address answers 403 whether or
    // not it has an account, and with a password that is not the account's.
    let banned_account = seed_account(
        &su,
        fixture.workspace,
        "before-banned",
        "member",
        Stored::Password(MEMBER_PASSWORD),
    )
    .await;
    let banned_new = format!("banned-new-{}@join.test", Uuid::new_v4());
    for email in [&banned_account.email, &banned_new] {
        sqlx::query(
            "INSERT INTO workspace_ban (workspace_id, email_norm, created_by, reason) \
             VALUES ($1, $2, $3, 'order conformance')",
        )
        .bind(fixture.workspace)
        .bind(email)
        .bind(fixture.owner)
        .execute(&su)
        .await
        .expect("ban");
    }
    let (live_code, _) = issue_invite(&http, &base, &token, fixture.workspace, "member", 5).await;
    let with_account = post_join(
        &http,
        &base,
        join_payload_with_password(&live_code, &banned_account.email, WRONG_PASSWORD),
    )
    .await;
    let without_account = post_join(&http, &base, join_payload(&live_code, &banned_new)).await;
    assert_eq!(without_account.status, 403, "{}", without_account.body);
    assert_eq!(
        (with_account.status, &with_account.body),
        (without_account.status, &without_account.body),
        "a banned address is refused the same way whether or not it has an account"
    );

    // …and the invite's own state comes before the ban: a dead link answers for itself,
    // even to an address that is banned, so it cannot be used to read the ban list.
    for (kind, code, expected) in &dead {
        for email in [&banned_account.email, &banned_new] {
            let asked = post_join(
                &http,
                &base,
                join_payload_with_password(code, email, WRONG_PASSWORD),
            )
            .await;
            assert_eq!(
                asked.status, *expected,
                "{kind} invite / banned address: the invite is judged before the ban: {}",
                asked.body
            );
        }
    }
}

/// The budget is asked before bcrypt runs, and a spent budget costs the caller no
/// comparison. The outcome of a refused guess is the same either way, so only the time
/// can tell: the account here stores a cost-14 hash, so a comparison takes a visible
/// fraction of a second and a refusal takes the time of a request. Both are measured in
/// this run, on this machine, and compared with each other, not with a clock.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_spent_budget_runs_no_comparison() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, "join-cost").await;
    let base = start_server(
        app_pool,
        RateLimitConfig {
            password_guess_per_account_limit: 2,
            per_ip_limit: 0,
            ..RateLimitConfig::default()
        },
    )
    .await;
    let http = reqwest::Client::new();
    let token = owner_token(&http, &base, &fixture).await;
    let target = seed_account(
        &su,
        fixture.workspace,
        "cost-target",
        "member",
        Stored::Costly(MEMBER_PASSWORD),
    )
    .await;
    let mut codes = Vec::new();
    for _ in 0..3 {
        codes.push(
            issue_invite(&http, &base, &token, fixture.workspace, "member", 5)
                .await
                .0,
        );
    }

    let mut timed = Vec::new();
    for (attempt, code) in codes.iter().enumerate() {
        let started = std::time::Instant::now();
        let (status, body, _) = post_join_from(
            &http,
            &base,
            &format!("198.51.100.{attempt}"),
            join_payload_with_password(code, &target.email, WRONG_PASSWORD),
        )
        .await;
        timed.push((status, started.elapsed(), body));
    }
    assert_eq!(timed[0].0, 401, "inside the budget: {}", timed[0].2);
    assert_eq!(timed[1].0, 401, "inside the budget: {}", timed[1].2);
    assert_eq!(timed[2].0, 429, "over the budget: {}", timed[2].2);
    let (compared, refused) = (timed[0].1, timed[2].1);
    assert!(
        compared > std::time::Duration::from_millis(150),
        "a cost-14 comparison must take long enough to be measured here: {compared:?}"
    );
    assert!(
        refused * 5 < compared,
        "a refused guess ran the comparison anyway: refused in {refused:?}, compared in {compared:?}"
    );
}

/// Poll `condition` until it holds, a hundred milliseconds apart, or fail the test with
/// `what` after fifteen seconds.
async fn wait_until<F, Fut>(what: &str, mut condition: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    for _ in 0..150 {
        if condition().await {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    panic!("timed out waiting for {what}");
}

/// How many backends of this database are parked on a lock inside a statement whose
/// text contains `fragment`.
async fn parked_on_a_lock(su: &PgPool, fragment: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*)::bigint FROM pg_stat_activity \
          WHERE datname = current_database() AND state = 'active' \
            AND wait_event_type = 'Lock' AND query ILIKE $1",
    )
    .bind(format!("%{fragment}%"))
    .fetch_one(su)
    .await
    .expect("read pg_stat_activity")
}

/// How many holders (`granted`) or waiters (`!granted`) there are of **this workspace's
/// membership lock** in `mode`.
///
/// The lock is named by the same 64-bit key the server derives
/// (`hashtextextended(workspace_id::text, 128)`); `pg_locks` shows a bigint advisory key
/// as two halves (`classid` the high 32 bits, `objid` the low 32, `objsubid = 1`), so the
/// key is split the same way here. Naming the key, rather than counting every advisory
/// lock, keeps the answer about the lock under test and no other.
async fn membership_lock_holders(su: &PgPool, workspace: Uuid, mode: &str, granted: bool) -> i64 {
    let key: i64 = sqlx::query_scalar("SELECT hashtextextended($1::text, 128)")
        .bind(workspace.to_string())
        .fetch_one(su)
        .await
        .expect("derive the membership lock key");
    let (high, low) = (((key >> 32) & 0xFFFF_FFFF), (key & 0xFFFF_FFFF));
    sqlx::query_scalar(
        "SELECT count(*)::bigint FROM pg_locks \
          WHERE locktype = 'advisory' AND objsubid = 1 AND mode = $1 AND granted = $2 \
            AND classid::bigint = $3 AND objid::bigint = $4 \
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
    )
    .bind(mode)
    .bind(granted)
    .bind(high)
    .bind(low)
    .fetch_one(su)
    .await
    .expect("read pg_locks")
}

/// What changes a member's standing while a join for them is in flight.
#[derive(Clone, Copy, Debug)]
enum Change {
    /// The operator removes the member (`DELETE …/members/{id}`).
    Remove,
    /// The operator suspends the member.
    Suspend,
    /// The member leaves the workspace themself (`DELETE …/members/me`).
    SelfLeave,
    /// The operator demotes the member to guest.
    Demote,
}

/// A membership change that meets a join in flight waits for it, and then has the
/// last word.
///
/// The join is parked just after the gate (a table lock on the redemption ledger
/// holds its next read) with the workspace's membership lock held in shared mode. The
/// change is sent while it waits, and the test requires that it is **seen waiting for
/// that lock** — a change that finished while the join was parked has not lined up
/// with it. Then the ledger is released: the join finishes, and the change runs after
/// it and undoes what it wrote.
///
/// Four changes, because they reach the member through different statements: removal
/// and suspension lock the member first, self-leave deletes the membership rows first
/// and only then touches the member (a row lock on the member deadlocked with it — the
/// reason the join takes the workspace lock instead), and a role change writes the
/// authority row. And two links for removal: with an admin link the escalation check
/// is the one a removal that slipped in would have skipped.
///
/// What each leaves behind is the point. A removed or departed member has no role, no
/// channel and no live token — **including the pair the join minted**, which is only
/// revocable if it was recorded before the change took its turn. A suspended member's
/// rows stay and every token is revoked, again the join's included.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_membership_change_that_meets_a_join_waits_for_it_and_has_the_last_word() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;

    // (the change, the role the join's link grants, the join's expected answer)
    let scenes = [
        (Change::Remove, "member", 200),
        (Change::Remove, "admin", 403),
        (Change::Suspend, "member", 200),
        (Change::SelfLeave, "member", 200),
        (Change::Demote, "member", 200),
    ];
    for (change, invite_role, expected_join) in scenes {
        let scene = format!("{change:?} / {invite_role} link");
        let app_pool = momo_app_pool().await;
        let fixture = seed(&su, "join-race").await;
        let base = start_server(app_pool, RateLimitConfig::default()).await;
        let http = reqwest::Client::new();
        let token = owner_token(&http, &base, &fixture).await;
        let target = seed_account(
            &su,
            fixture.workspace,
            "race-target",
            "member",
            Stored::Password(MEMBER_PASSWORD),
        )
        .await;
        // The member's own sign-in, before anything is held: self-leave needs a token.
        let member_token = login(
            &http,
            &base,
            fixture.workspace,
            &target.email,
            MEMBER_PASSWORD,
        )
        .await["accessToken"]
            .as_str()
            .expect("the member signs in")
            .to_string();
        let (code, _) = issue_invite(&http, &base, &token, fixture.workspace, invite_role, 5).await;
        let live_tokens = || async {
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*)::bigint FROM token \
                  WHERE actor_member_id = $1 AND kind = 'session' AND revoked_at IS NULL",
            )
            .bind(target.id)
            .fetch_one(&su)
            .await
            .expect("count live tokens")
        };
        assert_eq!(
            live_tokens().await,
            2,
            "{scene}: the sign-in's pair is live"
        );

        // Hold the redemption ledger, so the join stops at the read that follows the gate.
        let mut ledger = su.begin().await.expect("begin the holding transaction");
        sqlx::query("LOCK TABLE invite_code_redemption IN ACCESS EXCLUSIVE MODE")
            .execute(&mut *ledger)
            .await
            .expect("lock the ledger");
        let join = tokio::spawn({
            let (http, base, email) = (http.clone(), base.clone(), target.email.clone());
            async move {
                post_join(
                    &http,
                    &base,
                    join_payload_with_password(&code, &email, MEMBER_PASSWORD),
                )
                .await
            }
        });
        wait_until("the join to park on the redemption ledger", || async {
            parked_on_a_lock(&su, "invite_code_redemption").await > 0
        })
        .await;
        // The join holds the membership lock **shared** while it is parked: shared, so
        // that joins do not wait for each other (an exclusive hold would line every join
        // up behind the one in front), and held, so that a change has to wait for it.
        assert_eq!(
            membership_lock_holders(&su, fixture.workspace, "ShareLock", true).await,
            1,
            "{scene}: the parked join holds the workspace membership lock in shared mode"
        );
        assert_eq!(
            membership_lock_holders(&su, fixture.workspace, "ExclusiveLock", true).await,
            0,
            "{scene}: no one holds it exclusively yet"
        );

        let change_task = tokio::spawn({
            let (http, base) = (http.clone(), base.clone());
            let (workspace, member) = (fixture.workspace, target.id);
            let (owner_token, member_token) = (token.clone(), member_token.clone());
            async move {
                let request = match change {
                    Change::Remove => http
                        .delete(format!("{base}/v1/workspaces/{workspace}/members/{member}"))
                        .bearer_auth(owner_token),
                    Change::Suspend => http
                        .post(format!(
                            "{base}/v1/workspaces/{workspace}/members/{member}/suspend"
                        ))
                        .bearer_auth(owner_token),
                    Change::SelfLeave => http
                        .delete(format!("{base}/v1/workspaces/{workspace}/members/me"))
                        .bearer_auth(member_token),
                    Change::Demote => http
                        .patch(format!(
                            "{base}/v1/workspaces/{workspace}/members/{member}/role"
                        ))
                        .bearer_auth(owner_token)
                        .json(&json!({ "role": "guest" })),
                };
                request
                    .send()
                    .await
                    .expect("send the membership change")
                    .status()
                    .as_u16()
            }
        });
        // The change must end up waiting for the join, not finish around it.
        let mut waiting = false;
        for _ in 0..150 {
            if change_task.is_finished() {
                break;
            }
            if membership_lock_holders(&su, fixture.workspace, "ExclusiveLock", false).await > 0 {
                waiting = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        let finished_early = change_task.is_finished();
        let queued_exclusive =
            membership_lock_holders(&su, fixture.workspace, "ExclusiveLock", false).await;
        ledger.rollback().await.expect("release the ledger");
        let joined = join.await.expect("join task");
        let changed = change_task.await.expect("change task");
        assert!(
            waiting && !finished_early,
            "{scene}: the change finished while the join was parked instead of waiting for it \
             (changed: {changed}, join: {} {})",
            joined.status,
            joined.body
        );
        assert_eq!(
            queued_exclusive, 1,
            "{scene}: the change was queued behind the join for the lock, exclusively"
        );
        assert_eq!(changed, 200, "{scene}: the change itself goes through");
        assert_eq!(
            joined.status, expected_join,
            "{scene}: the join was first, and answers as it would have alone: {}",
            joined.body
        );

        // The change is the last word.
        let state = account_state(&su, target.id).await;
        match change {
            Change::Remove | Change::SelfLeave => {
                assert_eq!(state.status, "deleted", "{scene}");
                assert_eq!(
                    (state.role.as_deref(), state.channel_memberships),
                    (None, 0),
                    "{scene}: no role or channel row survives"
                );
                assert_eq!(
                    live_tokens().await,
                    0,
                    "{scene}: no live token survives, the join's own pair included"
                );
            }
            Change::Suspend => {
                assert_eq!(state.status, "suspended", "{scene}");
                assert_eq!(
                    live_tokens().await,
                    0,
                    "{scene}: every token is revoked, the join's own pair included"
                );
            }
            Change::Demote => {
                assert_eq!(state.status, "active", "{scene}");
                assert_eq!(
                    state.role.as_deref(),
                    Some("guest"),
                    "{scene}: the demotion is the last word on the role"
                );
            }
        }
    }
}
