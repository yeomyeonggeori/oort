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
//! `infra/e2e/bootstrap_roles.sql`), and the join path is the only caller — so
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
use std::sync::Mutex;

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
    json!({
        "code": code,
        "email": email,
        "displayName": "Joining Human",
        "password": JOIN_PASSWORD,
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
    sqlx::query("UPDATE invite_code SET expires_at = now() - interval '1 hour' WHERE id = $1")
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

    let (admin_code, _) = issue_invite(&http, &base, &token, fixture.workspace, "admin", 5).await;
    let escalation = post_join(&http, &base, join_payload(&admin_code, &existing_email)).await;
    expect(
        &escalation,
        403,
        "public join cannot escalate an existing member role",
        "an admin link offered to an existing member",
    );

    // …and the permitted direction really is permitted: a plain `member` link
    // redeemed by that same member joins them without changing anything.
    let allowed = post_join(&http, &base, join_payload(&live_code, &existing_email)).await;
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
    let suspended = post_join(&http, &base, join_payload(&live_code, &existing_email)).await;
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

// ---------------------------------------------------------------------------
// 3. the rate limit
// ---------------------------------------------------------------------------

/// `POST /v1/join` is the only unauthenticated write on this server and it takes
/// a bearer string in the body, so an unlimited number of guesses is exactly
/// what must not be available.
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
            window_seconds: 60,
            per_ip_limit: 2,
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
