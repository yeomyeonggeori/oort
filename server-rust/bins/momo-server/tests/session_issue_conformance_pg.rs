//! **A sign-in is ordered against the changes that end sessions** (#4636).
//!
//! `POST /v1/auth/login`, `POST /v1/claim` (both kinds), `PATCH …/members/me/password`
//! and `POST /v1/join` are the doors that create a session. Each takes the workspace's
//! membership lock in the mode its work needs — shared when it only reads who the member
//! is (login, join), exclusive when it also writes the credential and ends the member's
//! other sessions (claim, password change) — and does its checks and its recording in one
//! transaction under it. This file states, door by door, what that buys:
//!
//! * a change that meets a sign-in in flight **waits for it and has the last word**: a
//!   suspension, removal or departure revokes the pair the sign-in recorded, and a
//!   password change or reset sweeps it with the rest;
//! * a request that was waiting for the lock while the member's standing changed reads the
//!   new standing and refuses before it writes anything;
//! * a door that anyone can reach does not queue for the lock while holding a pooled
//!   connection;
//! * the operator's reissue of a reset link takes the same lock first, so it cannot wait for a
//!   claim that is spending the link, or for a suspension, in the opposite order;
//! * what a door writes is written by **one transaction**, which the timing tests above
//!   can only show by racing.
//!
//! How a sign-in is held in flight: the test takes a row lock on the member
//! (`SELECT … FOR UPDATE`) in a transaction of its own. Every door writes a row that
//! references the member (the session, the audit row, the redemption), and the foreign-key
//! check of that insert wants a `FOR KEY SHARE` on the same row, so the door stops there —
//! after its checks, inside its transaction, holding its lock — until the test lets go. The
//! change is then sent, and the test requires that it is **seen waiting for the membership
//! lock** (a change that finished while the door was held has not lined up with it).
//!
//! `#[ignore]` because it needs a real Postgres. Run:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test session_issue_conformance_pg -- \
//!   --ignored --test-threads=1 --nocapture
//! ```

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use momo_auth::mint_owner_claim_token;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::PgPool;
use momo_server::config::RateLimitConfig;
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use tokio::task::JoinHandle;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness (same contract as join_conformance_pg.rs)
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET: &str = "session-issue-conformance-app-signing-secret";
const OWNER_PASSWORD: &str = "session-issue-owner-password";
const MEMBER_PASSWORD: &str = "session-issue-member-password";
/// What the member's own change (the issuer or the arriving change) sets.
const CHANGED_PASSWORD: &str = "session-issue-changed-member-password";
/// What a claim sets.
const CLAIMED_PASSWORD: &str = "session-issue-claimed-member-password";

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn role_password(role: &str, env_key: &str) -> String {
    std::env::var(env_key).unwrap_or_else(|_| format!("{role}_dev_pw"))
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url())
        .await
        .expect("connect to conformance DB as superuser")
}

/// A pool authenticating as the API role, `connections` wide. The width matters to the
/// test that shows a door does not queue: it is what a stall would exhaust.
async fn momo_app_pool_of(connections: u32) -> PgPool {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    let options = options
        .username("momo_app")
        .password(&role_password("momo_app", "MOMO_APP_PASSWORD"));
    PgPoolOptions::new()
        .max_connections(connections)
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

async fn start_server(pool: PgPool) -> String {
    let state = AppState::new(
        pool,
        TEST_JWT_SECRET.to_string(),
        "ws://127.0.0.1:8000/connection/websocket".to_string(),
    )
    .with_rate_limit(RateLimitConfig::default());
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
// fixtures (superuser → past RLS)
// ---------------------------------------------------------------------------

/// One workspace with an owner who can sign in, one `member`, and the server in front of
/// them. The member is the one every scene is about.
struct World {
    su: PgPool,
    http: reqwest::Client,
    base: String,
    workspace: Uuid,
    owner_bearer: String,
    owner_email: String,
    member: Uuid,
    member_email: String,
}

/// `password: None` seeds a member who has none yet — the shape a first claim is for.
async fn world(label: &str, member_password: Option<&str>, pool_width: u32) -> World {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("{label}-{workspace}"))
        .execute(&su)
        .await
        .expect("seed workspace");

    let owner = Uuid::new_v4();
    let owner_email = format!("owner-{owner}@session-issue.test");
    seed_human(
        &su,
        workspace,
        owner,
        "owner",
        &owner_email,
        Some(OWNER_PASSWORD),
    )
    .await;
    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, topic, created_by) \
         VALUES ($1, $2, 'public', 'general', 'Team general channel', $3)",
    )
    .bind(channel)
    .bind(workspace)
    .bind(owner)
    .execute(&su)
    .await
    .expect("seed channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel)
        .bind(workspace)
        .execute(&su)
        .await
        .expect("seed channel_seq");
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'owner')",
    )
    .bind(workspace)
    .bind(channel)
    .bind(owner)
    .execute(&su)
    .await
    .expect("seed owner membership");

    let member = Uuid::new_v4();
    let member_email = format!("member-{member}@session-issue.test");
    seed_human(
        &su,
        workspace,
        member,
        "member",
        &member_email,
        member_password,
    )
    .await;

    let base = start_server(momo_app_pool_of(pool_width).await).await;
    let http = reqwest::Client::new();
    let (status, body, _) = api_login(&http, &base, workspace, &owner_email, OWNER_PASSWORD).await;
    assert_eq!(status, 200, "the owner signs in: {body}");
    let owner_bearer = body["accessToken"]
        .as_str()
        .expect("owner access token")
        .to_string();
    World {
        su,
        http,
        base,
        workspace,
        owner_bearer,
        owner_email,
        member,
        member_email,
    }
}

async fn seed_human(
    su: &PgPool,
    workspace: Uuid,
    id: Uuid,
    role: &str,
    email: &str,
    password: Option<&str>,
) {
    let handle = format!("{role}-{}", &id.to_string()[..8]);
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
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         VALUES ($1, $2, $3, true, \
                 CASE WHEN $4::text IS NULL THEN NULL ELSE momo_password_hash($4::text) END)",
    )
    .bind(id)
    .bind(workspace)
    .bind(email)
    .bind(password)
    .execute(su)
    .await
    .expect("seed human");
}

/// A one-time owner-bootstrap claim for a member who has no password, as the row the
/// migration tooling writes.
async fn seed_bootstrap_claim(su: &PgPool, workspace: Uuid, member: Uuid) -> String {
    let token = mint_owner_claim_token().expect("entropy");
    sqlx::query(
        "INSERT INTO credential_claim \
            (workspace_id, member_id, token_hash, expires_at, kind) \
         VALUES ($1, $2, digest($3::text, 'sha256'), now() + interval '1 hour', \
                 'owner_bootstrap')",
    )
    .bind(workspace)
    .bind(member)
    .bind(&token)
    .execute(su)
    .await
    .expect("seed the bootstrap claim");
    token
}

// ---------------------------------------------------------------------------
// requests
// ---------------------------------------------------------------------------

struct Reply {
    status: u16,
    body: Value,
    retry_after: Option<u64>,
}

async fn reply_of(response: reqwest::Response) -> Reply {
    let status = response.status().as_u16();
    let retry_after = response
        .headers()
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    let body: Value = response.json().await.unwrap_or(Value::Null);
    Reply {
        status,
        body,
        retry_after,
    }
}

async fn api_login(
    http: &reqwest::Client,
    base: &str,
    workspace: Uuid,
    email: &str,
    password: &str,
) -> (u16, Value, Option<u64>) {
    let reply = reply_of(
        http.post(format!("{base}/v1/auth/login"))
            .json(&json!({
                "email": email,
                "password": password,
                "workspace": workspace.to_string(),
            }))
            .send()
            .await
            .expect("login request"),
    )
    .await;
    (reply.status, reply.body, reply.retry_after)
}

async fn roster_status(w: &World, access: &str) -> u16 {
    w.http
        .get(format!("{}/v1/workspaces/{}/roster", w.base, w.workspace))
        .bearer_auth(access)
        .send()
        .await
        .expect("roster request")
        .status()
        .as_u16()
}

async fn issue_invite(w: &World) -> String {
    let response = w
        .http
        .post(format!("{}/v1/workspaces/{}/invites", w.base, w.workspace))
        .bearer_auth(&w.owner_bearer)
        .json(&json!({ "role": "member", "maxUses": 5 }))
        .send()
        .await
        .expect("create invite");
    assert_eq!(response.status().as_u16(), 201, "the invite is created");
    let body: Value = response.json().await.expect("invite body");
    body["code"].as_str().expect("the raw code").to_string()
}

async fn issue_reset_token(w: &World) -> String {
    let response = w
        .http
        .post(format!(
            "{}/v1/workspaces/{}/members/{}/password-reset",
            w.base, w.workspace, w.member
        ))
        .bearer_auth(&w.owner_bearer)
        .send()
        .await
        .expect("issue a password reset");
    assert_eq!(response.status().as_u16(), 201, "the reset link is issued");
    let body: Value = response.json().await.expect("reset body");
    body["token"].as_str().expect("the raw token").to_string()
}

// ---------------------------------------------------------------------------
// reading the database and the lock table
// ---------------------------------------------------------------------------

async fn live_tokens(su: &PgPool, member: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*)::bigint FROM token \
          WHERE actor_member_id = $1 AND kind = 'session' AND revoked_at IS NULL",
    )
    .bind(member)
    .fetch_one(su)
    .await
    .expect("count live session tokens")
}

async fn member_status(su: &PgPool, member: Uuid) -> String {
    sqlx::query_scalar("SELECT status::text FROM member WHERE id = $1")
        .bind(member)
        .fetch_one(su)
        .await
        .expect("read the member's status")
}

async fn workspace_role(su: &PgPool, member: Uuid) -> Option<String> {
    sqlx::query_scalar("SELECT role::text FROM workspace_membership WHERE member_id = $1")
        .bind(member)
        .fetch_optional(su)
        .await
        .expect("read the workspace role")
}

async fn password_hash(su: &PgPool, member: Uuid) -> Option<String> {
    sqlx::query_scalar("SELECT password_hash FROM human WHERE member_id = $1")
        .bind(member)
        .fetch_one(su)
        .await
        .expect("read the password hash")
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
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("timed out waiting for {what}");
}

/// The 64-bit key of a workspace's membership lock, split the way `pg_locks` shows an
/// advisory key (`classid` the high 32 bits, `objid` the low 32, `objsubid = 1`).
async fn membership_key(su: &PgPool, workspace: Uuid) -> (i64, i64) {
    let key: i64 = sqlx::query_scalar("SELECT hashtextextended($1::text, 128)")
        .bind(workspace.to_string())
        .fetch_one(su)
        .await
        .expect("derive the membership lock key");
    ((key >> 32) & 0xFFFF_FFFF, key & 0xFFFF_FFFF)
}

/// How many holders (`granted`) or waiters (`!granted`) there are of **this workspace's
/// membership lock** in `mode`. Naming the key, rather than counting every advisory lock,
/// keeps the answer about the lock under test and no other.
async fn membership_lock_holders(su: &PgPool, workspace: Uuid, mode: &str, granted: bool) -> i64 {
    let (high, low) = membership_key(su, workspace).await;
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

/// The modes in which backend `pid` holds this workspace's membership lock.
async fn membership_modes_held_by(su: &PgPool, workspace: Uuid, pid: i32) -> Vec<String> {
    let (high, low) = membership_key(su, workspace).await;
    sqlx::query_scalar(
        "SELECT mode FROM pg_locks \
          WHERE locktype = 'advisory' AND objsubid = 1 AND granted AND pid = $1 \
            AND classid::bigint = $2 AND objid::bigint = $3 \
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
    )
    .bind(pid)
    .bind(high)
    .bind(low)
    .fetch_all(su)
    .await
    .expect("read pg_locks for a backend")
}

/// `xmin` of the row a token string was recorded as: the id of the transaction that wrote
/// it. The server records a session under its hash only.
async fn token_xmin(su: &PgPool, raw_token: &str) -> String {
    sqlx::query_scalar("SELECT xmin::text FROM token WHERE token_hash = digest($1::text, 'sha256')")
        .bind(raw_token)
        .fetch_one(su)
        .await
        .expect("the session row the door answered with")
}

// ---------------------------------------------------------------------------
// holding a door in flight
// ---------------------------------------------------------------------------

/// A row lock on a member, in a transaction of the test's own (see the module docs).
struct Hold {
    tx: sqlx::Transaction<'static, sqlx::Postgres>,
    pid: i32,
}

/// A row lock the test takes: `sql` is a `SELECT … FOR UPDATE` over the row, bound to `id`.
async fn hold_row(su: &PgPool, sql: &str, id: Uuid) -> Hold {
    let mut tx = su.begin().await.expect("begin the holding transaction");
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *tx)
        .await
        .expect("the holder's backend id");
    sqlx::query(sql)
        .bind(id)
        .execute(&mut *tx)
        .await
        .expect("lock the row");
    Hold { tx, pid }
}

async fn hold_member_row(su: &PgPool, member: Uuid) -> Hold {
    hold_row(su, "SELECT 1 FROM member WHERE id = $1 FOR UPDATE", member).await
}

impl Hold {
    async fn release(self) {
        self.tx.rollback().await.expect("release the member row");
    }
}

/// The backends stopped on `pid`'s locks, with the statement each is in.
async fn blocked_by(su: &PgPool, pid: i32) -> Vec<(i32, String)> {
    sqlx::query_as::<_, (i32, String)>(
        "SELECT pid, query FROM pg_stat_activity \
          WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))",
    )
    .bind(pid)
    .fetch_all(su)
    .await
    .expect("read pg_stat_activity")
}

// ---------------------------------------------------------------------------
// the doors and the changes
// ---------------------------------------------------------------------------

/// The doors that create a session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Issuer {
    Login,
    Join,
    PasswordChange,
    ClaimReset,
    ClaimBootstrap,
}

impl Issuer {
    /// The mode in which the door holds the membership lock.
    fn lock_mode(self) -> &'static str {
        match self {
            Issuer::Login | Issuer::Join => "ShareLock",
            Issuer::PasswordChange | Issuer::ClaimReset | Issuer::ClaimBootstrap => "ExclusiveLock",
        }
    }

    fn member_has_password(self) -> bool {
        self != Issuer::ClaimBootstrap
    }
}

/// What arrives while the door is held.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Change {
    /// An operator suspends the member.
    Suspend,
    /// An operator removes the member.
    Remove,
    /// The member leaves the workspace themself.
    SelfLeave,
    /// The member sets a new password of their own.
    NewPassword,
    /// The member spends an operator-issued reset link.
    ResetClaim,
}

/// What a scene needs in hand before anything is held.
struct Kit {
    /// The member's own bearer, from a sign-in made before anything was held (empty for a
    /// member who has no password).
    member_bearer: String,
    invite_code: String,
    /// The claim token the **door** spends.
    issuer_claim: String,
    /// The reset token the **arriving change** spends.
    change_claim: String,
}

async fn prepare(w: &World, issuer: Issuer, change: Change) -> Kit {
    let mut kit = Kit {
        member_bearer: String::new(),
        invite_code: String::new(),
        issuer_claim: String::new(),
        change_claim: String::new(),
    };
    if issuer.member_has_password() {
        let (status, body, _) = api_login(
            &w.http,
            &w.base,
            w.workspace,
            &w.member_email,
            MEMBER_PASSWORD,
        )
        .await;
        assert_eq!(status, 200, "the member signs in first: {body}");
        kit.member_bearer = body["accessToken"]
            .as_str()
            .expect("access token")
            .to_string();
    }
    match issuer {
        Issuer::Join => kit.invite_code = issue_invite(w).await,
        Issuer::ClaimReset => kit.issuer_claim = issue_reset_token(w).await,
        Issuer::ClaimBootstrap => {
            kit.issuer_claim = seed_bootstrap_claim(&w.su, w.workspace, w.member).await
        }
        Issuer::Login | Issuer::PasswordChange => {}
    }
    if change == Change::ResetClaim {
        kit.change_claim = issue_reset_token(w).await;
    }
    kit
}

fn spawn_issuer(w: &World, issuer: Issuer, kit: &Kit) -> JoinHandle<Reply> {
    let (http, base, workspace) = (w.http.clone(), w.base.clone(), w.workspace);
    let email = w.member_email.clone();
    let (bearer, code, claim) = (
        kit.member_bearer.clone(),
        kit.invite_code.clone(),
        kit.issuer_claim.clone(),
    );
    tokio::spawn(async move {
        let request = match issuer {
            Issuer::Login => http.post(format!("{base}/v1/auth/login")).json(&json!({
                "email": email,
                "password": MEMBER_PASSWORD,
                "workspace": workspace.to_string(),
            })),
            Issuer::Join => http.post(format!("{base}/v1/join")).json(&json!({
                "code": code,
                "email": email,
                "displayName": "Joining Member",
                "password": MEMBER_PASSWORD,
                "timeZone": "Asia/Seoul",
            })),
            Issuer::PasswordChange => http
                .patch(format!(
                    "{base}/v1/workspaces/{workspace}/members/me/password"
                ))
                .bearer_auth(bearer)
                .json(&json!({
                    "currentPassword": MEMBER_PASSWORD,
                    "newPassword": CHANGED_PASSWORD,
                })),
            Issuer::ClaimReset | Issuer::ClaimBootstrap => http
                .post(format!("{base}/v1/claim"))
                .json(&json!({ "token": claim, "password": CLAIMED_PASSWORD })),
        };
        reply_of(request.send().await.expect("send the door's request")).await
    })
}

fn spawn_change(w: &World, change: Change, kit: &Kit) -> JoinHandle<Reply> {
    let (http, base, workspace, member) = (w.http.clone(), w.base.clone(), w.workspace, w.member);
    let (owner_bearer, member_bearer, claim) = (
        w.owner_bearer.clone(),
        kit.member_bearer.clone(),
        kit.change_claim.clone(),
    );
    tokio::spawn(async move {
        let request = match change {
            Change::Suspend => http
                .post(format!(
                    "{base}/v1/workspaces/{workspace}/members/{member}/suspend"
                ))
                .bearer_auth(owner_bearer),
            Change::Remove => http
                .delete(format!("{base}/v1/workspaces/{workspace}/members/{member}"))
                .bearer_auth(owner_bearer),
            Change::SelfLeave => http
                .delete(format!("{base}/v1/workspaces/{workspace}/members/me"))
                .bearer_auth(member_bearer),
            Change::NewPassword => http
                .patch(format!(
                    "{base}/v1/workspaces/{workspace}/members/me/password"
                ))
                .bearer_auth(member_bearer)
                .json(&json!({
                    "currentPassword": MEMBER_PASSWORD,
                    "newPassword": CHANGED_PASSWORD,
                })),
            Change::ResetClaim => http
                .post(format!("{base}/v1/claim"))
                .json(&json!({ "token": claim, "password": CLAIMED_PASSWORD })),
        };
        reply_of(request.send().await.expect("send the change")).await
    })
}

// ---------------------------------------------------------------------------
// 1. a change that meets a sign-in in flight waits for it and has the last word
// ---------------------------------------------------------------------------

/// One scene: the door is held in flight, the change is sent and seen waiting for the
/// membership lock, the door is let go, and the change runs after it.
///
/// What the door holds while it is held is part of the claim and is asserted from the lock
/// table, by backend: the one stopped on the test's row lock holds the workspace's
/// membership lock, in the mode the door is meant to hold it. That is what puts the pair
/// the door goes on to record on the near side of the change — a pair recorded by a
/// transaction that does not hold the lock can be born just after the change ran.
async fn a_change_meets_a_door(issuer: Issuer, change: Change) {
    let scene = format!("{issuer:?} / {change:?}");
    let w = world(
        "session-issue-race",
        issuer.member_has_password().then_some(MEMBER_PASSWORD),
        4,
    )
    .await;
    let kit = prepare(&w, issuer, change).await;
    let hash_before = password_hash(&w.su, w.member).await;

    let hold = hold_member_row(&w.su, w.member).await;
    let door = spawn_issuer(&w, issuer, &kit);
    wait_until("the door to stop on the member row", || async {
        !blocked_by(&w.su, hold.pid).await.is_empty()
    })
    .await;
    let stopped = blocked_by(&w.su, hold.pid).await;
    assert_eq!(
        stopped.len(),
        1,
        "{scene}: exactly one request is stopped on the member row: {stopped:?}"
    );
    let (door_pid, door_statement) = &stopped[0];
    if issuer == Issuer::Login {
        // A login writes nothing but the pair, so the statement it stops in is the pair's.
        assert!(
            door_statement.contains("INSERT INTO token"),
            "{scene}: the login is held at the recording of its session: {door_statement}"
        );
    }
    assert_eq!(
        membership_modes_held_by(&w.su, w.workspace, *door_pid).await,
        vec![issuer.lock_mode().to_string()],
        "{scene}: the held door holds the membership lock in {} mode",
        issuer.lock_mode()
    );
    assert_eq!(
        membership_lock_holders(&w.su, w.workspace, "ExclusiveLock", false).await,
        0,
        "{scene}: no change is queued yet"
    );

    let change_task = spawn_change(&w, change, &kit);
    // The change must end up waiting for the door, not finish around it.
    let mut waiting = false;
    for _ in 0..150 {
        if change_task.is_finished() {
            break;
        }
        if membership_lock_holders(&w.su, w.workspace, "ExclusiveLock", false).await > 0 {
            waiting = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let finished_early = change_task.is_finished();
    let queued = membership_lock_holders(&w.su, w.workspace, "ExclusiveLock", false).await;
    hold.release().await;
    let door = door.await.expect("door task");
    let change_reply = change_task.await.expect("change task");
    assert!(
        waiting && !finished_early,
        "{scene}: the change finished while the door was held instead of waiting for it \
         (change: {} {}, door: {} {})",
        change_reply.status,
        change_reply.body,
        door.status,
        door.body
    );
    assert_eq!(
        queued, 1,
        "{scene}: the change was queued behind the door, exclusively"
    );
    assert_eq!(
        door.status, 200,
        "{scene}: the door was first: {}",
        door.body
    );
    assert_eq!(
        change_reply.status, 200,
        "{scene}: the change goes through: {}",
        change_reply.body
    );

    // The change is the last word.
    let door_access = door.body["accessToken"]
        .as_str()
        .expect("the door answers with a session")
        .to_string();
    assert_eq!(
        roster_status(&w, &door_access).await,
        401,
        "{scene}: the pair the door recorded is revoked"
    );
    match change {
        Change::Suspend => {
            assert_eq!(member_status(&w.su, w.member).await, "suspended", "{scene}");
            assert_eq!(
                live_tokens(&w.su, w.member).await,
                0,
                "{scene}: no session survives"
            );
        }
        Change::Remove | Change::SelfLeave => {
            assert_eq!(member_status(&w.su, w.member).await, "deleted", "{scene}");
            assert_eq!(
                workspace_role(&w.su, w.member).await,
                None,
                "{scene}: no role survives"
            );
            assert_eq!(
                live_tokens(&w.su, w.member).await,
                0,
                "{scene}: no session survives"
            );
        }
        Change::NewPassword | Change::ResetClaim => {
            assert_eq!(member_status(&w.su, w.member).await, "active", "{scene}");
            // The only session left is the change's own new pair.
            assert_eq!(
                live_tokens(&w.su, w.member).await,
                2,
                "{scene}: the change swept every other session, the door's included"
            );
            let new_access = change_reply.body["accessToken"]
                .as_str()
                .expect("the change answers with a new session");
            assert_eq!(
                roster_status(&w, new_access).await,
                200,
                "{scene}: the new pair works"
            );
        }
    }
    // A door that is itself a credential write left its own mark before the change ran.
    if matches!(
        issuer,
        Issuer::PasswordChange | Issuer::ClaimReset | Issuer::ClaimBootstrap
    ) {
        assert_ne!(
            password_hash(&w.su, w.member).await,
            hash_before,
            "{scene}: the password is not the one the member had"
        );
    }
}

macro_rules! scenes {
    ($($name:ident: $issuer:ident, $change:ident;)*) => {$(
        #[tokio::test]
        #[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
        async fn $name() {
            a_change_meets_a_door(Issuer::$issuer, Change::$change).await;
        }
    )*};
}

scenes! {
    a_suspension_that_meets_a_login_waits_for_it: Login, Suspend;
    a_removal_that_meets_a_login_waits_for_it: Login, Remove;
    a_departure_that_meets_a_login_waits_for_it: Login, SelfLeave;
    a_password_change_that_meets_a_login_sweeps_its_pair: Login, NewPassword;
    a_reset_that_meets_a_login_sweeps_its_pair: Login, ResetClaim;
    a_suspension_that_meets_a_join_waits_for_it: Join, Suspend;
    a_removal_that_meets_a_join_waits_for_it: Join, Remove;
    a_password_change_that_meets_a_join_sweeps_its_pair: Join, NewPassword;
    a_reset_that_meets_a_join_sweeps_its_pair: Join, ResetClaim;
    a_suspension_that_meets_a_password_change_waits_for_it: PasswordChange, Suspend;
    a_removal_that_meets_a_password_change_waits_for_it: PasswordChange, Remove;
    a_reset_that_meets_a_password_change_sweeps_its_pair: PasswordChange, ResetClaim;
    a_suspension_that_meets_a_reset_claim_waits_for_it: ClaimReset, Suspend;
    a_removal_that_meets_a_reset_claim_waits_for_it: ClaimReset, Remove;
    a_suspension_that_meets_a_first_claim_waits_for_it: ClaimBootstrap, Suspend;
    a_removal_that_meets_a_first_claim_waits_for_it: ClaimBootstrap, Remove;
}

// ---------------------------------------------------------------------------
// 1b. the control: a door that meets no change issues a working session
// ---------------------------------------------------------------------------

/// The control for the scenes above. Held and let go with nothing arriving, every door
/// answers with a session that works. Without it a door that recorded nothing at all would
/// pass every scene: a pair that does not exist is revoked, and swept, trivially.
async fn a_door_alone(issuer: Issuer) {
    let scene = format!("{issuer:?} alone");
    let w = world(
        "session-issue-alone",
        issuer.member_has_password().then_some(MEMBER_PASSWORD),
        4,
    )
    .await;
    let kit = prepare(&w, issuer, Change::Suspend).await;
    let hold = hold_member_row(&w.su, w.member).await;
    let door = spawn_issuer(&w, issuer, &kit);
    wait_until("the door to stop on the member row", || async {
        !blocked_by(&w.su, hold.pid).await.is_empty()
    })
    .await;
    hold.release().await;
    let door = door.await.expect("door task");
    assert_eq!(door.status, 200, "{scene}: {}", door.body);
    let access = door.body["accessToken"]
        .as_str()
        .expect("the door answers with a session");
    assert_eq!(
        roster_status(&w, access).await,
        200,
        "{scene}: the session works"
    );
    assert_eq!(member_status(&w.su, w.member).await, "active", "{scene}");
}

macro_rules! controls {
    ($($name:ident: $issuer:ident;)*) => {$(
        #[tokio::test]
        #[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
        async fn $name() {
            a_door_alone(Issuer::$issuer).await;
        }
    )*};
}

controls! {
    a_login_that_meets_no_change_issues_a_working_session: Login;
    a_join_that_meets_no_change_issues_a_working_session: Join;
    a_password_change_that_meets_no_change_issues_a_working_session: PasswordChange;
    a_reset_claim_that_meets_no_change_issues_a_working_session: ClaimReset;
    a_first_claim_that_meets_no_change_issues_a_working_session: ClaimBootstrap;
}

// ---------------------------------------------------------------------------
// 1c. the lock comes before the first read of the account
// ---------------------------------------------------------------------------

/// Where a door is held to show it already has its lock: at a table the test holds
/// (`ACCESS EXCLUSIVE`), or at the claim's own row.
#[derive(Clone, Copy)]
enum Park {
    Table(&'static str),
    ClaimRow,
}

async fn hold_for(su: &PgPool, park: Park, kit: &Kit) -> Hold {
    let mut tx = su.begin().await.expect("begin the holding transaction");
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *tx)
        .await
        .expect("the holder's backend id");
    match park {
        Park::Table(table) => {
            sqlx::query(&format!("LOCK TABLE {table} IN ACCESS EXCLUSIVE MODE"))
                .execute(&mut *tx)
                .await
                .expect("lock the table");
        }
        Park::ClaimRow => {
            sqlx::query(
                "SELECT 1 FROM credential_claim \
                  WHERE token_hash = digest($1::text, 'sha256') FOR UPDATE",
            )
            .bind(&kit.issuer_claim)
            .execute(&mut *tx)
            .await
            .expect("lock the claim row");
        }
    }
    Hold { tx, pid }
}

/// A door is held at the first read of the account it makes after taking its lock — the
/// password check of a login, the claim's own row, the standing check of a password change
/// — and must already hold the lock there. A lock taken after that read would leave the
/// read describing a workspace that a change can already have left.
async fn a_door_locks_before_it_reads(issuer: Issuer, park: Park, statement_has: &str) {
    let scene = format!("{issuer:?}");
    let w = world(
        "session-issue-lock-first",
        issuer.member_has_password().then_some(MEMBER_PASSWORD),
        4,
    )
    .await;
    let kit = prepare(&w, issuer, Change::Suspend).await;

    let hold = hold_for(&w.su, park, &kit).await;
    let door = spawn_issuer(&w, issuer, &kit);
    wait_until(
        "the door to stop at its first read of the account",
        || async { !blocked_by(&w.su, hold.pid).await.is_empty() },
    )
    .await;
    let stopped = blocked_by(&w.su, hold.pid).await;
    assert_eq!(
        stopped.len(),
        1,
        "{scene}: exactly one request is stopped: {stopped:?}"
    );
    let (door_pid, door_statement) = &stopped[0];
    assert!(
        door_statement.contains(statement_has),
        "{scene}: the door is held at its first read of the account: {door_statement}"
    );
    assert_eq!(
        membership_modes_held_by(&w.su, w.workspace, *door_pid).await,
        vec![issuer.lock_mode().to_string()],
        "{scene}: the door already holds the membership lock ({}) when it first reads the account",
        issuer.lock_mode()
    );
    hold.release().await;
    let door = door.await.expect("door task");
    assert_eq!(door.status, 200, "{scene}: {}", door.body);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_login_takes_its_lock_before_it_reads_the_account() {
    a_door_locks_before_it_reads(Issuer::Login, Park::Table("human"), "FROM human h").await;
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_claim_takes_its_lock_before_it_judges_the_token() {
    for issuer in [Issuer::ClaimReset, Issuer::ClaimBootstrap] {
        a_door_locks_before_it_reads(issuer, Park::ClaimRow, "FOR UPDATE OF oc").await;
    }
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_password_change_takes_its_lock_before_it_reads_the_standing() {
    a_door_locks_before_it_reads(
        Issuer::PasswordChange,
        Park::Table("member"),
        "FROM member WHERE id",
    )
    .await;
}

// ---------------------------------------------------------------------------
// 2. a request that was waiting for the lock reads the new standing
// ---------------------------------------------------------------------------

/// An operator's suspension, held open: the membership lock exclusively, the status
/// written and the member's tokens revoked, none of it committed.
async fn open_suspension(
    su: &PgPool,
    workspace: Uuid,
    member: Uuid,
) -> sqlx::Transaction<'static, sqlx::Postgres> {
    open_departure(su, workspace, member, false).await
}

/// The same for a member who is **removed** (`removed`: the status becomes `deleted` and
/// nothing else on the row, which is all a removal or a departure writes there) rather than
/// suspended.
async fn open_departure(
    su: &PgPool,
    workspace: Uuid,
    member: Uuid,
    removed: bool,
) -> sqlx::Transaction<'static, sqlx::Postgres> {
    let mut tx = su.begin().await.expect("begin the suspension");
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 128))")
        .bind(workspace.to_string())
        .execute(&mut *tx)
        .await
        .expect("take the membership lock");
    let write = if removed {
        "UPDATE member SET status = 'deleted', updated_at = now() WHERE id = $1"
    } else {
        "UPDATE member SET status = 'suspended', updated_at = now() WHERE id = $1"
    };
    sqlx::query(write)
        .bind(member)
        .execute(&mut *tx)
        .await
        .expect("change the member's standing");
    sqlx::query(
        "UPDATE token SET revoked_at = now() WHERE actor_member_id = $1 AND revoked_at IS NULL",
    )
    .bind(member)
    .execute(&mut *tx)
    .await
    .expect("revoke the member's tokens");
    tx
}

async fn password_changes_audited(su: &PgPool, member: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*)::bigint FROM audit_log \
          WHERE actor_member_id = $1 AND action = 'member.password_changed'",
    )
    .bind(member)
    .fetch_one(su)
    .await
    .expect("count audit rows")
}

/// A password change whose bearer was good when the request arrived, but which then waited
/// for the membership lock while the member was suspended or removed, **refuses**: the
/// standing is read under the lock and before the first write. The middleware cannot have
/// caught it — it judged the bearer before the lock was had — and a change that went ahead
/// would write the password and hand a member who is no longer active a new session.
///
/// (The departure is one transaction here. Through the API a suspension and a reinstatement are
/// two requests that each take the lock, and a change that queued behind the first wakes between
/// them and reads `suspended`; the reinstatement cannot overtake it.)
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_password_change_that_waited_for_a_suspension_or_removal_refuses() {
    for removed in [false, true] {
        let case = if removed { "removal" } else { "suspension" };
        let w = world("session-issue-stale-change", Some(MEMBER_PASSWORD), 4).await;
        let kit = prepare(&w, Issuer::PasswordChange, Change::Suspend).await;
        let hash_before = password_hash(&w.su, w.member).await;

        let departure = open_departure(&w.su, w.workspace, w.member, removed).await;
        let door = spawn_issuer(&w, Issuer::PasswordChange, &kit);
        wait_until("the change to wait for the membership lock", || async {
            membership_lock_holders(&w.su, w.workspace, "ExclusiveLock", false).await > 0
        })
        .await;
        assert!(
            !door.is_finished(),
            "{case}: the change waits for the open departure"
        );
        departure.commit().await.expect("commit the departure");
        let reply = door.await.expect("change task");

        assert_eq!(
            reply.status, 403,
            "{case}: the change is refused: {}",
            reply.body
        );
        assert_eq!(
            password_hash(&w.su, w.member).await,
            hash_before,
            "{case}: the password is untouched"
        );
        assert_eq!(
            live_tokens(&w.su, w.member).await,
            0,
            "{case}: no session was issued"
        );
        assert_eq!(
            password_changes_audited(&w.su, w.member).await,
            0,
            "{case}: nothing was audited"
        );
    }
}

/// A reset claim that waited for a suspension refuses the same way, and rolls everything
/// back: the password is not written, the link is still unspent, and no session exists.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_reset_claim_that_waited_for_a_suspension_is_refused_and_spends_nothing() {
    let w = world("session-issue-stale-claim", Some(MEMBER_PASSWORD), 4).await;
    let kit = prepare(&w, Issuer::ClaimReset, Change::Suspend).await;
    let hash_before = password_hash(&w.su, w.member).await;

    let suspension = open_suspension(&w.su, w.workspace, w.member).await;
    let door = spawn_issuer(&w, Issuer::ClaimReset, &kit);
    wait_until("the claim to wait for the membership lock", || async {
        membership_lock_holders(&w.su, w.workspace, "ExclusiveLock", false).await > 0
    })
    .await;
    assert!(
        !door.is_finished(),
        "the claim waits for the open suspension"
    );
    suspension.commit().await.expect("commit the suspension");
    let reply = door.await.expect("claim task");

    assert_eq!(
        reply.status, 404,
        "the claim is refused in the documented words, not answered with a session: {}",
        reply.body
    );
    assert_eq!(
        reply.body["error"]["message"], "claim token is invalid",
        "and not by the consume failing halfway: {}",
        reply.body
    );
    assert!(
        reply.body.get("accessToken").is_none(),
        "no session in the answer: {}",
        reply.body
    );
    assert_eq!(
        password_hash(&w.su, w.member).await,
        hash_before,
        "the password is untouched"
    );
    assert_eq!(
        live_tokens(&w.su, w.member).await,
        0,
        "no session was issued"
    );
    let unspent: bool = sqlx::query_scalar(
        "SELECT consumed_at IS NULL FROM credential_claim \
          WHERE token_hash = digest($1::text, 'sha256')",
    )
    .bind(&kit.issuer_claim)
    .fetch_one(&w.su)
    .await
    .expect("read the claim");
    assert!(unspent, "the link is still unspent");
}

/// A login that finds the membership lock taken answers 503 with `Retry-After` and has
/// written nothing; once the change has committed, the same login is told the new standing.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_login_that_meets_a_change_in_flight_is_told_to_retry_and_then_the_new_standing() {
    let w = world("session-issue-busy-login", Some(MEMBER_PASSWORD), 4).await;
    let before = live_tokens(&w.su, w.member).await;

    let suspension = open_suspension(&w.su, w.workspace, w.member).await;
    // A login that waited for the lock would never answer while the test holds it, so the
    // wait is bounded and its end is the failure.
    let (status, body, retry_after) = tokio::time::timeout(
        Duration::from_secs(8),
        api_login(
            &w.http,
            &w.base,
            w.workspace,
            &w.member_email,
            MEMBER_PASSWORD,
        ),
    )
    .await
    .expect("the login answered instead of waiting for the lock");
    assert_eq!(status, 503, "the login does not wait for the lock: {body}");
    assert_eq!(retry_after, Some(1), "and says when to come back");
    assert!(
        body.get("accessToken").is_none(),
        "no session in the answer: {body}"
    );
    suspension.commit().await.expect("commit the suspension");

    let (status, body, _) = api_login(
        &w.http,
        &w.base,
        w.workspace,
        &w.member_email,
        MEMBER_PASSWORD,
    )
    .await;
    assert_eq!(
        status, 403,
        "after the change the standing is the new one: {body}"
    );
    assert_eq!(
        live_tokens(&w.su, w.member).await,
        before,
        "neither login wrote a session"
    );
}

// ---------------------------------------------------------------------------
// 3. a door anyone can reach does not queue for the lock
// ---------------------------------------------------------------------------

/// The membership lock held exclusively and nothing else: a change in flight that has
/// taken its first statement and not yet finished.
async fn open_lock(su: &PgPool, workspace: Uuid) -> sqlx::Transaction<'static, sqlx::Postgres> {
    let mut tx = su.begin().await.expect("begin the change");
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 128))")
        .bind(workspace.to_string())
        .execute(&mut *tx)
        .await
        .expect("take the membership lock");
    tx
}

async fn join_reply(w: &World, code: &str, email: &str) -> Reply {
    reply_of(
        w.http
            .post(format!("{}/v1/join", w.base))
            .json(&json!({
                "code": code,
                "email": email,
                "displayName": "Joining Member",
                "password": MEMBER_PASSWORD,
                "timeZone": "Asia/Seoul",
            }))
            .send()
            .await
            .expect("join request"),
    )
    .await
}

/// While a change holds the membership lock for seconds, a flood of logins and joins is
/// answered at once, writes nothing, and an unrelated request on the same instance is not
/// held up.
///
/// The pool is four connections wide. Doors that waited for the lock would each keep one
/// until the change committed, and every other request — whatever it asked for — would
/// queue for a connection behind them. The roster read has nothing to do with the lock;
/// what it measures is whether the pool is still there.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn logins_and_joins_do_not_queue_for_the_lock_and_leave_the_pool_alone() {
    let w = world("session-issue-pool", Some(MEMBER_PASSWORD), 4).await;
    let code = issue_invite(&w).await;
    let change = open_lock(&w.su, w.workspace).await;

    let started = Instant::now();
    let logins: Vec<JoinHandle<Reply>> = (0..16)
        .map(|_| {
            let (http, base, workspace, email) = (
                w.http.clone(),
                w.base.clone(),
                w.workspace,
                w.member_email.clone(),
            );
            tokio::spawn(async move {
                let (status, body, retry_after) =
                    api_login(&http, &base, workspace, &email, MEMBER_PASSWORD).await;
                Reply {
                    status,
                    body,
                    retry_after,
                }
            })
        })
        .collect();
    let joined_emails: Vec<String> = (0..8)
        .map(|n| format!("flood-{n}-{}@session-issue.test", Uuid::new_v4()))
        .collect();
    let joins: Vec<JoinHandle<Reply>> = joined_emails
        .iter()
        .map(|email| {
            let (http, base, code, email) =
                (w.http.clone(), w.base.clone(), code.clone(), email.clone());
            tokio::spawn(async move {
                reply_of(
                    http.post(format!("{base}/v1/join"))
                        .json(&json!({
                            "code": code,
                            "email": email,
                            "displayName": "Flooding Joiner",
                            "password": MEMBER_PASSWORD,
                            "timeZone": "Asia/Seoul",
                        }))
                        .send()
                        .await
                        .expect("join request"),
                )
                .await
            })
        })
        .collect();
    // Give the requests time to reach the server and, if they were going to wait, to take
    // their connections.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let roster = tokio::time::timeout(Duration::from_millis(1500), async {
        roster_status(&w, &w.owner_bearer).await
    })
    .await;
    let answered_in = started.elapsed();
    assert_eq!(
        roster.ok(),
        Some(200),
        "an unrelated request is answered while the lock is held and the doors are in \
         flight (took {answered_in:?})"
    );
    for door in logins.into_iter().chain(joins) {
        let reply = tokio::time::timeout(Duration::from_millis(1500), door)
            .await
            .expect("a door answers without waiting for the lock")
            .expect("door task");
        assert_eq!(reply.status, 503, "{}", reply.body);
        assert_eq!(reply.retry_after, Some(1));
    }
    // Nothing was written by the refused joins: no account for any address, the code unspent.
    let accounts: i64 = sqlx::query_scalar(
        "SELECT count(*)::bigint FROM human WHERE workspace_id = $1 AND email = ANY($2)",
    )
    .bind(w.workspace)
    .bind(&joined_emails)
    .fetch_one(&w.su)
    .await
    .expect("count accounts");
    assert_eq!(accounts, 0, "a refused join created no account");
    let spent: i32 = sqlx::query_scalar(
        "SELECT COALESCE(max(used_count), 0) FROM invite_code WHERE workspace_id = $1",
    )
    .bind(w.workspace)
    .fetch_one(&w.su)
    .await
    .expect("read the invite's use count");
    assert_eq!(spent, 0, "a refused join spent no use of the code");
    change.rollback().await.expect("release the lock");

    let (status, body, _) = api_login(
        &w.http,
        &w.base,
        w.workspace,
        &w.member_email,
        MEMBER_PASSWORD,
    )
    .await;
    assert_eq!(
        status, 200,
        "with the lock free the login goes through: {body}"
    );
    let joined = join_reply(&w, &code, &joined_emails[0]).await;
    assert_eq!(joined.status, 201, "and so does the join: {}", joined.body);
}

/// A change that is waiting for the lock is not overtaken. While a suspension waits behind a
/// sign-in in flight, another login is answered 503 instead of slipping in ahead of it; if
/// shared requests could jump the queue, a steady stream of logins would keep a suspension
/// waiting for as long as the stream lasted.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_login_does_not_overtake_a_change_that_is_waiting_for_the_lock() {
    let w = world("session-issue-overtake", Some(MEMBER_PASSWORD), 4).await;
    let kit = prepare(&w, Issuer::Login, Change::Suspend).await;

    let hold = hold_member_row(&w.su, w.member).await;
    let door = spawn_issuer(&w, Issuer::Login, &kit);
    wait_until("the login to stop on the member row", || async {
        !blocked_by(&w.su, hold.pid).await.is_empty()
    })
    .await;
    let change = spawn_change(&w, Change::Suspend, &kit);
    wait_until("the suspension to queue for the lock", || async {
        membership_lock_holders(&w.su, w.workspace, "ExclusiveLock", false).await == 1
    })
    .await;

    // Someone else signs in now. The lock is held shared (by the first login) and the
    // suspension is next for it.
    let (status, body, retry_after) = tokio::time::timeout(
        Duration::from_millis(1500),
        api_login(
            &w.http,
            &w.base,
            w.workspace,
            &w.owner_email,
            OWNER_PASSWORD,
        ),
    )
    .await
    .expect("the late login answered instead of waiting or slipping in");
    assert_eq!(
        status, 503,
        "the late login does not overtake the queued change: {body}"
    );
    assert_eq!(retry_after, Some(1));

    hold.release().await;
    let door = door.await.expect("door task");
    let change = change.await.expect("change task");
    assert_eq!(
        door.status, 200,
        "the login that was first answers as it would alone"
    );
    assert_eq!(change.status, 200, "and the suspension runs after it");
    assert_eq!(member_status(&w.su, w.member).await, "suspended");
    assert_eq!(
        live_tokens(&w.su, w.member).await,
        0,
        "the first login's pair is revoked"
    );
}

// ---------------------------------------------------------------------------
// 3b. a claim token that can never be spent does not queue for the lock
// ---------------------------------------------------------------------------

/// A one-time claim row of `kind` for `member`, created and expiring at the SQL
/// expressions given (an expired row must have been created before it expired), with a
/// token the test knows.
async fn seed_claim(
    su: &PgPool,
    workspace: Uuid,
    member: Uuid,
    kind: &str,
    created_sql: &str,
    expires_sql: &str,
) -> String {
    let token = mint_owner_claim_token().expect("entropy");
    let insert = format!(
        "INSERT INTO credential_claim \
            (workspace_id, member_id, token_hash, created_at, expires_at, kind) \
         VALUES ($1, $2, digest($3::text, 'sha256'), {created_sql}, {expires_sql}, $4)"
    );
    sqlx::query(&insert)
        .bind(workspace)
        .bind(member)
        .bind(&token)
        .bind(kind)
        .execute(su)
        .await
        .expect("seed the claim");
    token
}

async fn claim_reply(w: &World, token: &str) -> Reply {
    reply_of(
        w.http
            .post(format!("{}/v1/claim", w.base))
            .json(&json!({ "token": token, "password": CLAIMED_PASSWORD }))
            .send()
            .await
            .expect("claim request"),
    )
    .await
}

/// `POST /v1/claim` is public and takes the membership lock exclusively, so a request that
/// holds or waits for it holds up every sign-in of the workspace. A token that can never be
/// spent is therefore refused **before** the lock, with the answer it has always had: spent,
/// expired, an owner-bootstrap token for an account that has a password, a member who is not
/// active. While a change holds the lock they are answered at once and none of them is
/// queued for it; a token that can still be spent is the one that waits.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_claim_token_that_can_never_be_spent_does_not_queue_for_the_lock() {
    let w = world("session-issue-dead-claim", Some(MEMBER_PASSWORD), 4).await;

    // Spent: a real link, spent through the route.
    let spent = issue_reset_token(&w).await;
    assert_eq!(
        claim_reply(&w, &spent).await.status,
        200,
        "the link is spent once"
    );
    // Still spendable: the member's open link (a member has at most one).
    let live = issue_reset_token(&w).await;

    // Every other row belongs to a member of its own, because a member has at most one open
    // reset link and the rows below are open as far as the table is concerned.
    let other_member = |label: &'static str| {
        let (su, workspace) = (w.su.clone(), w.workspace);
        async move {
            let id = Uuid::new_v4();
            seed_human(
                &su,
                workspace,
                id,
                "member",
                &format!("{label}-{id}@session-issue.test"),
                Some(MEMBER_PASSWORD),
            )
            .await;
            id
        }
    };
    // Expired.
    let expiring = other_member("expired").await;
    let expired = seed_claim(
        &w.su,
        w.workspace,
        expiring,
        "password_reset",
        "now() - interval '2 hours'",
        "now() - interval '1 hour'",
    )
    .await;
    // An owner-bootstrap token for an account that has a password.
    let owner_like = other_member("bootstrapped").await;
    let bootstrap_with_password = seed_claim(
        &w.su,
        w.workspace,
        owner_like,
        "owner_bootstrap",
        "now()",
        "now() + interval '1 hour'",
    )
    .await;
    // A live link of a member who is not active.
    let sidelined = other_member("sidelined").await;
    sqlx::query("UPDATE member SET status = 'suspended' WHERE id = $1")
        .bind(sidelined)
        .execute(&w.su)
        .await
        .expect("suspend the member");
    let inactive_member = seed_claim(
        &w.su,
        w.workspace,
        sidelined,
        "password_reset",
        "now()",
        "now() + interval '1 hour'",
    )
    .await;
    // A token that names nothing at all.
    let unknown = mint_owner_claim_token().expect("entropy");

    let change = open_lock(&w.su, w.workspace).await;
    for (case, token, status) in [
        ("spent", &spent, 409),
        ("expired", &expired, 410),
        (
            "owner-bootstrap token of an account that has a password",
            &bootstrap_with_password,
            409,
        ),
        ("member who is not active", &inactive_member, 404),
        ("unknown", &unknown, 404),
    ] {
        let reply = tokio::time::timeout(Duration::from_millis(1500), claim_reply(&w, token))
            .await
            .unwrap_or_else(|_| {
                panic!("{case}: the claim waited for the lock instead of being refused")
            });
        assert_eq!(reply.status, status, "{case}: {}", reply.body);
    }
    assert_eq!(
        membership_lock_holders(&w.su, w.workspace, "ExclusiveLock", false).await,
        0,
        "no refused claim is queued for the lock"
    );

    // The token that can still be spent is the one that waits.
    let waiting = {
        let (http, base) = (w.http.clone(), w.base.clone());
        tokio::spawn(async move {
            reply_of(
                http.post(format!("{base}/v1/claim"))
                    .json(&json!({ "token": live, "password": CLAIMED_PASSWORD }))
                    .send()
                    .await
                    .expect("claim request"),
            )
            .await
        })
    };
    wait_until("the live claim to queue for the lock", || async {
        membership_lock_holders(&w.su, w.workspace, "ExclusiveLock", false).await == 1
    })
    .await;
    assert!(
        !waiting.is_finished(),
        "the live claim waits for the open change"
    );
    change.rollback().await.expect("release the lock");
    let reply = waiting.await.expect("claim task");
    assert_eq!(
        reply.status, 200,
        "and goes through once the lock is free: {}",
        reply.body
    );
}

// ---------------------------------------------------------------------------
// 3c. the operator's reissue is ordered with the doors that spend or end a link
// ---------------------------------------------------------------------------

fn spawn_reissue(w: &World) -> JoinHandle<Reply> {
    let (http, base, workspace, member, bearer) = (
        w.http.clone(),
        w.base.clone(),
        w.workspace,
        w.member,
        w.owner_bearer.clone(),
    );
    tokio::spawn(async move {
        reply_of(
            http.post(format!(
                "{base}/v1/workspaces/{workspace}/members/{member}/password-reset"
            ))
            .bearer_auth(bearer)
            .send()
            .await
            .expect("send the reissue"),
        )
        .await
    })
}

fn spawn_claim(w: &World, token: &str) -> JoinHandle<Reply> {
    let (http, base, token) = (w.http.clone(), w.base.clone(), token.to_string());
    tokio::spawn(async move {
        reply_of(
            http.post(format!("{base}/v1/claim"))
                .json(&json!({ "token": token, "password": CLAIMED_PASSWORD }))
                .send()
                .await
                .expect("send the claim"),
        )
        .await
    })
}

fn no_kit() -> Kit {
    Kit {
        member_bearer: String::new(),
        invite_code: String::new(),
        issuer_claim: String::new(),
        change_claim: String::new(),
    }
}

/// A reissue takes the membership lock, exclusively, before it locks the member. It locks the
/// member's row and then the member's open link; the claim that spends the link holds the link and
/// then needs the member's row, and a suspension holds the operator's rows and then the member's.
/// Taking the lock first is what keeps those orders from meeting.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_reissue_takes_the_membership_lock_before_it_locks_the_member() {
    let w = world("session-issue-reissue-lock", Some(MEMBER_PASSWORD), 4).await;
    let hold = hold_member_row(&w.su, w.member).await;
    let reissue = spawn_reissue(&w);
    wait_until("the reissue to stop on the member row", || async {
        !blocked_by(&w.su, hold.pid).await.is_empty()
    })
    .await;
    let stopped = blocked_by(&w.su, hold.pid).await;
    assert_eq!(
        stopped.len(),
        1,
        "exactly one request is stopped: {stopped:?}"
    );
    let (pid, statement) = &stopped[0];
    assert!(
        statement.contains("FOR UPDATE OF m"),
        "the reissue is held at the lock on the member's row: {statement}"
    );
    assert_eq!(
        membership_modes_held_by(&w.su, w.workspace, *pid).await,
        vec!["ExclusiveLock".to_string()],
        "the reissue already holds the membership lock, exclusively, when it locks the member"
    );
    hold.release().await;
    let reply = reissue.await.expect("reissue task");
    assert_eq!(
        reply.status, 201,
        "the reissue goes through: {}",
        reply.body
    );
}

/// A claim that is spending the member's link and a reissue for the same member meet: the claim
/// holds the link and is about to need the member's row for its audit row, and the reissue locks
/// the member's row and then wants the link. Without the shared first lock each ends up waiting
/// for the other until the database ends one of them (a 500); behind it the reissue waits for the
/// claim and both answer.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_claim_and_a_reissue_that_meet_do_not_wait_for_each_other() {
    let w = world("session-issue-claim-reissue", Some(MEMBER_PASSWORD), 4).await;
    let live = issue_reset_token(&w).await;

    // Stop the claim after it holds its link: on the member's credential row, which it writes
    // next.
    let hold = hold_row(
        &w.su,
        "SELECT 1 FROM human WHERE member_id = $1 FOR UPDATE",
        w.member,
    )
    .await;
    let claim = spawn_claim(&w, &live);
    wait_until("the claim to stop on the credential row", || async {
        !blocked_by(&w.su, hold.pid).await.is_empty()
    })
    .await;

    let reissue = spawn_reissue(&w);
    wait_until("the reissue to queue for the membership lock", || async {
        membership_lock_holders(&w.su, w.workspace, "ExclusiveLock", false).await == 1
    })
    .await;
    hold.release().await;

    let claim = claim.await.expect("claim task");
    let reissue = reissue.await.expect("reissue task");
    assert_eq!(claim.status, 200, "the claim goes through: {}", claim.body);
    assert_eq!(
        reissue.status, 201,
        "and so does the reissue, after it: {}",
        reissue.body
    );
}

/// A suspension and a reissue for the same member meet: the suspension holds the operator's rows
/// and goes on to the member's, and the reissue holds the member's row and then needs the
/// operator's for its audit row. Behind the lock the suspension queues for the reissue and both
/// answer.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_suspension_and_a_reissue_that_meet_do_not_wait_for_each_other() {
    let w = world("session-issue-suspend-reissue", Some(MEMBER_PASSWORD), 4).await;
    let _open_link = issue_reset_token(&w).await;

    // Stop the reissue after it holds the member's row: on the member's open link, which it
    // spends next.
    let hold = hold_row(
        &w.su,
        "SELECT 1 FROM credential_claim \
          WHERE member_id = $1 AND consumed_at IS NULL FOR UPDATE",
        w.member,
    )
    .await;
    let reissue = spawn_reissue(&w);
    wait_until("the reissue to stop on the open link", || async {
        !blocked_by(&w.su, hold.pid).await.is_empty()
    })
    .await;

    let suspension = spawn_change(&w, Change::Suspend, &no_kit());
    wait_until(
        "the suspension to queue for the membership lock",
        || async { membership_lock_holders(&w.su, w.workspace, "ExclusiveLock", false).await == 1 },
    )
    .await;
    assert!(
        !suspension.is_finished(),
        "the suspension waits for the reissue"
    );
    hold.release().await;

    let reissue = reissue.await.expect("reissue task");
    let suspension = suspension.await.expect("suspension task");
    assert_eq!(
        reissue.status, 201,
        "the reissue goes through: {}",
        reissue.body
    );
    assert_eq!(
        suspension.status, 200,
        "and the suspension after it: {}",
        suspension.body
    );
    assert_eq!(member_status(&w.su, w.member).await, "suspended");
}

/// Someone who is not an operator is refused before the membership lock: while a change holds
/// the lock, a reissue by an ordinary member is answered at once instead of queueing for it —
/// a request that cannot succeed must not be able to hold up every sign-in of the workspace.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_reissue_by_someone_who_is_not_an_operator_does_not_queue_for_the_lock() {
    let w = world("session-issue-reissue-refused", Some(MEMBER_PASSWORD), 4).await;
    let (status, body, _) = api_login(
        &w.http,
        &w.base,
        w.workspace,
        &w.member_email,
        MEMBER_PASSWORD,
    )
    .await;
    assert_eq!(status, 200, "the member signs in first: {body}");
    let member_bearer = body["accessToken"].as_str().expect("access token");

    let change = open_lock(&w.su, w.workspace).await;
    let refused = tokio::time::timeout(Duration::from_millis(1500), async {
        reply_of(
            w.http
                .post(format!(
                    "{}/v1/workspaces/{}/members/{}/password-reset",
                    w.base,
                    w.workspace,
                    Uuid::new_v4()
                ))
                .bearer_auth(member_bearer)
                .send()
                .await
                .expect("send the reissue"),
        )
        .await
    })
    .await
    .expect("the refusal came without waiting for the lock");
    assert_eq!(refused.status, 403, "{}", refused.body);
    assert_eq!(
        membership_lock_holders(&w.su, w.workspace, "ExclusiveLock", false).await,
        0,
        "the refused request is not queued for the lock"
    );
    change.rollback().await.expect("release the lock");
}

// ---------------------------------------------------------------------------
// 3d. a change the caller may not make is refused before the lock
// ---------------------------------------------------------------------------

/// What the changes below act on: the workspace owner, and that owner's channel.
struct ChangeTargets {
    owner: Uuid,
    channel: Uuid,
}

async fn change_targets(w: &World) -> ChangeTargets {
    let owner: Uuid = sqlx::query_scalar(
        "SELECT member_id FROM workspace_membership \
          WHERE workspace_id = $1 AND role = 'owner'::membership_role",
    )
    .bind(w.workspace)
    .fetch_one(&w.su)
    .await
    .expect("the owner");
    let channel: Uuid = sqlx::query_scalar("SELECT id FROM channel WHERE workspace_id = $1")
        .bind(w.workspace)
        .fetch_one(&w.su)
        .await
        .expect("the channel");
    ChangeTargets { owner, channel }
}

/// Every membership change somebody who is not an operator can send, with the answer the route
/// has always given them. (`None` for the channel is a membership that does not exist.)
fn unauthorised_changes(
    w: &World,
    targets: &ChangeTargets,
    bearer: &str,
) -> Vec<(&'static str, reqwest::RequestBuilder, u16)> {
    let ws = format!("{}/v1/workspaces/{}", w.base, w.workspace);
    let (owner, channel) = (targets.owner, targets.channel);
    vec![
        (
            "suspend",
            w.http
                .post(format!("{ws}/members/{owner}/suspend"))
                .bearer_auth(bearer),
            403,
        ),
        (
            "reinstate",
            w.http
                .post(format!("{ws}/members/{owner}/reinstate"))
                .bearer_auth(bearer),
            403,
        ),
        (
            "remove",
            w.http
                .delete(format!("{ws}/members/{owner}"))
                .bearer_auth(bearer),
            403,
        ),
        (
            "workspace role",
            w.http
                .patch(format!("{ws}/members/{owner}/role"))
                .bearer_auth(bearer)
                .json(&json!({ "role": "guest" })),
            403,
        ),
        (
            "channel role",
            w.http
                .patch(format!("{ws}/channels/{channel}/members/{owner}/role"))
                .bearer_auth(bearer)
                .json(&json!({ "role": "member" })),
            403,
        ),
        (
            "channel role of someone who is not in the channel",
            w.http
                .patch(format!(
                    "{ws}/channels/{channel}/members/{}/role",
                    Uuid::new_v4()
                ))
                .bearer_auth(bearer)
                .json(&json!({ "role": "member" })),
            404,
        ),
    ]
}

async fn sign_in_as(w: &World, role: &str) -> String {
    let id = Uuid::new_v4();
    let email = format!("{role}-{id}@session-issue.test");
    seed_human(&w.su, w.workspace, id, role, &email, Some(MEMBER_PASSWORD)).await;
    let (status, body, _) = api_login(&w.http, &w.base, w.workspace, &email, MEMBER_PASSWORD).await;
    assert_eq!(status, 200, "the {role} signs in: {body}");
    body["accessToken"]
        .as_str()
        .expect("access token")
        .to_string()
}

/// Suspending, reinstating, removing and changing a role take the membership lock exclusively,
/// and login and join answer 503 while it is held. A request that is going to be refused anyway
/// must not be able to hold it: while a change holds the lock, each of these requests from a
/// plain member and from a guest is answered at once, in the words it has always had, and none of
/// them queues for the lock.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_change_the_caller_may_not_make_does_not_queue_for_the_lock() {
    let w = world("session-issue-unauthorised", Some(MEMBER_PASSWORD), 4).await;
    let targets = change_targets(&w).await;
    let callers = [
        ("member", sign_in_as(&w, "member").await),
        ("guest", sign_in_as(&w, "guest").await),
    ];

    let change = open_lock(&w.su, w.workspace).await;
    for (who, bearer) in &callers {
        for (what, request, expected) in unauthorised_changes(&w, &targets, bearer) {
            let reply = tokio::time::timeout(Duration::from_millis(1500), async {
                reply_of(request.send().await.expect("send the change")).await
            })
            .await
            .unwrap_or_else(|_| {
                panic!("{who} / {what}: waited for the lock instead of being refused")
            });
            assert_eq!(
                reply.status, expected,
                "{who} / {what}: refused as it always was: {}",
                reply.body
            );
        }
    }
    assert_eq!(
        membership_lock_holders(&w.su, w.workspace, "ExclusiveLock", false).await,
        0,
        "no refused request is queued for the lock"
    );
    change.rollback().await.expect("release the lock");
}

/// The same thing end to end: a guest sends refused changes as fast as the server answers, on
/// several connections at once, and a login and a join that arrive meanwhile are not turned away.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_member_sending_refused_changes_does_not_turn_sign_ins_away() {
    let w = world("session-issue-flood", Some(MEMBER_PASSWORD), 10).await;
    let targets = change_targets(&w).await;
    let guest = sign_in_as(&w, "guest").await;
    let code = issue_invite(&w).await;

    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flooders: Vec<JoinHandle<u32>> = (0..4)
        .map(|_| {
            let (http, base, workspace, guest, owner, stop) = (
                w.http.clone(),
                w.base.clone(),
                w.workspace,
                guest.clone(),
                targets.owner,
                stop.clone(),
            );
            tokio::spawn(async move {
                let mut sent = 0u32;
                while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                    let status = http
                        .patch(format!(
                            "{base}/v1/workspaces/{workspace}/members/{owner}/role"
                        ))
                        .bearer_auth(&guest)
                        .json(&json!({ "role": "guest" }))
                        .send()
                        .await
                        .expect("send the refused change")
                        .status()
                        .as_u16();
                    assert_eq!(status, 403, "the guest is refused");
                    sent += 1;
                }
                sent
            })
        })
        .collect();
    tokio::time::sleep(Duration::from_millis(300)).await;

    let mut turned_away = 0;
    for n in 0..20 {
        let (status, body, _) = api_login(
            &w.http,
            &w.base,
            w.workspace,
            &w.member_email,
            MEMBER_PASSWORD,
        )
        .await;
        if status == 503 {
            turned_away += 1;
        } else {
            assert_eq!(status, 200, "login {n}: {body}");
        }
    }
    let joined = join_reply(
        &w,
        &code,
        &format!("flood-join-{}@session-issue.test", Uuid::new_v4()),
    )
    .await;
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let mut sent = 0;
    for flooder in flooders {
        sent += flooder.await.expect("flood task");
    }
    assert!(sent > 50, "the flood really ran ({sent} refused changes)");
    assert_eq!(
        turned_away, 0,
        "no login was turned away while the guest sent {sent} refused changes"
    );
    assert_eq!(
        joined.status, 201,
        "and the join went through: {}",
        joined.body
    );
}

// ---------------------------------------------------------------------------
// 4. what a door writes is written by one transaction
// ---------------------------------------------------------------------------

async fn xmin_of(su: &PgPool, sql: &'static str, bound: &str) -> String {
    sqlx::query_scalar(sql)
        .bind(bound)
        .fetch_one(su)
        .await
        .unwrap_or_else(|error| panic!("read an xmin ({sql}): {error}"))
}

/// The pair a door answers with is written by **the door's own transaction**: the claim row,
/// the password, the audit row, the sweep of the older sessions and both session rows
/// carry one transaction id.
///
/// This is the property that lets a suspension or removal that waited for the door revoke
/// the pair it recorded — a pair written afterwards, by a transaction of its own, can be
/// born just after that revocation ran and escape it. The tests above show the consequence,
/// but only by racing; this one states the cause and cannot miss.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_claims_rows_and_session_are_written_by_one_transaction() {
    for (issuer, member_password, audit_action) in [
        (
            Issuer::ClaimReset,
            Some(MEMBER_PASSWORD),
            "member.password_reset",
        ),
        (Issuer::ClaimBootstrap, None, "owner.claim"),
    ] {
        let case = format!("{issuer:?}");
        let w = world("session-issue-claim-one-tx", member_password, 4).await;
        let kit = prepare(&w, issuer, Change::Suspend).await;
        let reply = spawn_issuer(&w, issuer, &kit).await.expect("claim task");
        assert_eq!(reply.status, 200, "{case}: {}", reply.body);
        let access = reply.body["accessToken"].as_str().expect("access token");
        let refresh = reply.body["refreshToken"].as_str().expect("refresh token");

        let claim = xmin_of(
            &w.su,
            "SELECT xmin::text FROM credential_claim WHERE token_hash = digest($1::text, 'sha256')",
            &kit.issuer_claim,
        )
        .await;
        let human: String = sqlx::query_scalar("SELECT xmin::text FROM human WHERE member_id = $1")
            .bind(w.member)
            .fetch_one(&w.su)
            .await
            .expect("the human row");
        let audit: String = sqlx::query_scalar(
            "SELECT xmin::text FROM audit_log \
              WHERE actor_member_id = $1 AND action = $2 ORDER BY created_at DESC LIMIT 1",
        )
        .bind(w.member)
        .bind(audit_action)
        .fetch_one(&w.su)
        .await
        .expect("the audit row");
        let (access_tx, refresh_tx) = (
            token_xmin(&w.su, access).await,
            token_xmin(&w.su, refresh).await,
        );
        assert_eq!(
            [&human, &audit, &access_tx, &refresh_tx],
            [&claim, &claim, &claim, &claim],
            "{case}: the claim row, the password, the audit row and both session rows were \
             written by one transaction (claim {claim}, human {human}, audit {audit}, \
             access {access_tx}, refresh {refresh_tx})"
        );
        if issuer == Issuer::ClaimReset {
            // The sweep of the older pair is the same transaction's too.
            let swept: Vec<String> = sqlx::query_scalar(
                "SELECT DISTINCT xmin::text FROM token \
                  WHERE actor_member_id = $1 AND revoked_at IS NOT NULL",
            )
            .bind(w.member)
            .fetch_all(&w.su)
            .await
            .expect("the swept rows");
            assert_eq!(
                swept,
                vec![claim.clone()],
                "{case}: the sweep is the claim's"
            );
        }
    }
}

/// The password change is the same: the password, the audit row, the sweep and the new
/// pair are one transaction.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_password_changes_rows_and_session_are_written_by_one_transaction() {
    let w = world("session-issue-change-one-tx", Some(MEMBER_PASSWORD), 4).await;
    let kit = prepare(&w, Issuer::PasswordChange, Change::Suspend).await;
    let reply = spawn_issuer(&w, Issuer::PasswordChange, &kit)
        .await
        .expect("change task");
    assert_eq!(reply.status, 200, "{}", reply.body);
    let access = reply.body["accessToken"].as_str().expect("access token");
    let refresh = reply.body["refreshToken"].as_str().expect("refresh token");

    let human: String = sqlx::query_scalar("SELECT xmin::text FROM human WHERE member_id = $1")
        .bind(w.member)
        .fetch_one(&w.su)
        .await
        .expect("the human row");
    let audit: String = sqlx::query_scalar(
        "SELECT xmin::text FROM audit_log \
          WHERE actor_member_id = $1 AND action = 'member.password_changed' \
          ORDER BY created_at DESC LIMIT 1",
    )
    .bind(w.member)
    .fetch_one(&w.su)
    .await
    .expect("the audit row");
    let (access_tx, refresh_tx) = (
        token_xmin(&w.su, access).await,
        token_xmin(&w.su, refresh).await,
    );
    let swept: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT xmin::text FROM token \
          WHERE actor_member_id = $1 AND revoked_at IS NOT NULL",
    )
    .bind(w.member)
    .fetch_all(&w.su)
    .await
    .expect("the swept rows");
    assert_eq!(
        [&audit, &access_tx, &refresh_tx],
        [&human, &human, &human],
        "the password, the audit row and both session rows were written by one transaction \
         (human {human}, audit {audit}, access {access_tx}, refresh {refresh_tx})"
    );
    assert_eq!(swept, vec![human], "the sweep is the change's too");
}
