//! #5837 / ADR-0224 D2·D6·D7·D9 — the two `channel` marks at the doors that write or read them,
//! over the real HTTP router on `momo_app` (NOBYPASSRLS). Fixtures are written as the superuser so
//! RLS does not hide setup; the migration's own fill is `channel_default_fill_pg.rs`.
//!
//! | test | what it pins | sabotage that turns it red |
//! |---|---|---|
//! | `new_public_channels_are_listed_and_the_channel_list_carries_both_marks` | `POST …/channels` makes a public channel `browseListed` and a private one not, neither default; `GET …/channels` carries both marks on every row; a new workspace's `general` is born default and listed | drop `browse_listed` from the create INSERT; drop it from the workspace seed |
//! | `an_invite_join_lands_in_the_default_channels_only` | a new person gets every default channel (listed or not) and nothing else; an existing member spending another link gains no channel, gets a left default channel back, and keeps the unread of a live one; a joined or restored default channel starts with 0 unread; another workspace is untouched | revert the join to every public channel; drop the read-cursor call; move the cursor for live memberships too |
//! | `a_workspace_without_a_default_channel_falls_back_to_its_oldest_live_public_channel` | no default → the single oldest live public channel (not an archived one, not a private one) | drop the fallback; let it pick an archived channel |
//! | `a_guest_never_lands_in_a_default_channel` | a member demoted to guest who spends a member link or a guest link is refused and holds no channel afterwards | — (held by the gates before the channel write, see the test) |
//! | `the_welcome_speaks_in_the_oldest_default_channel_whatever_its_name` | the welcome target and the speaker's seat are the oldest default channel, never the channel named `general` | look the welcome channel up by name again |
//!
//! `#[ignore]` because it needs a real Postgres. Run:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:15432/momo \
//!   cargo test -p momo-server --test channel_default_join_pg -- --ignored --test-threads=1
//! ```
//!
//! Fixture people are fictional (김도현·박서연).

use std::collections::BTreeSet;
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

const TEST_JWT_SECRET: &str = "channel-default-join-app-signing-secret";
const OWNER_PASSWORD: &str = "channel-default-owner-password";
const JOIN_PASSWORD: &str = "channel-default-joiner-password";

// ---------------------------------------------------------------------------
// harness (same contract as join_conformance_pg.rs)
// ---------------------------------------------------------------------------

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url())
        .await
        .expect("connect as superuser")
}

async fn momo_app_pool() -> PgPool {
    let options: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
    let password = std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".into());
    PgPoolOptions::new()
        .max_connections(4)
        .connect_with(options.username("momo_app").password(&password))
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

fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations");
    let roles = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/rust/sql/bootstrap_roles.sql"
    ));
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args([
            "-v",
            "ON_ERROR_STOP=1",
            "--no-psqlrc",
            "--quiet",
            "--single-transaction",
        ])
        .arg("-f")
        .arg(roles)
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
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

// ---------------------------------------------------------------------------
// fixtures (superuser → RLS does not hide setup)
// ---------------------------------------------------------------------------

struct Workspace {
    id: Uuid,
    owner: Uuid,
    owner_email: String,
}

async fn seed_workspace(su: &PgPool, hint: &str) -> Workspace {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(id)
        .bind(format!("{hint}-{id}"))
        .execute(su)
        .await
        .expect("seed workspace");
    let owner = Uuid::new_v4();
    let handle = format!("owner-{}", &owner.simple().to_string()[..8]);
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', '김도현', $3)",
    )
    .bind(owner)
    .bind(id)
    .bind(&handle)
    .execute(su)
    .await
    .expect("seed owner");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ($1, $2, 'owner')",
    )
    .bind(id)
    .bind(owner)
    .execute(su)
    .await
    .expect("seed owner role");
    let owner_email = format!("{owner}@channel-default.test");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         VALUES ($1, $2, $3, true, momo_password_hash($4))",
    )
    .bind(owner)
    .bind(id)
    .bind(&owner_email)
    .bind(OWNER_PASSWORD)
    .execute(su)
    .await
    .expect("seed owner human");
    Workspace {
        id,
        owner,
        owner_email,
    }
}

/// One channel with its `channel_seq` row at `last_seq`, the owner as a member, and both marks
/// set explicitly. `age_days` orders creation (bigger = older).
#[allow(clippy::too_many_arguments)]
async fn seed_channel(
    su: &PgPool,
    ws: &Workspace,
    kind: &str,
    name: &str,
    age_days: i32,
    archived: bool,
    is_default: bool,
    browse_listed: bool,
    last_seq: i64,
) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, created_by, created_at, archived_at, \
                              is_default, browse_listed) \
         VALUES ($1, $2, $3::channel_kind, $4, $5, now() - make_interval(days => $6), \
                 CASE WHEN $7 THEN now() ELSE NULL END, $8, $9)",
    )
    .bind(id)
    .bind(ws.id)
    .bind(kind)
    .bind(name)
    .bind(ws.owner)
    .bind(age_days)
    .bind(archived)
    .bind(is_default)
    .bind(browse_listed)
    .execute(su)
    .await
    .expect("seed channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, $3)")
        .bind(id)
        .bind(ws.id)
        .bind(last_seq)
        .execute(su)
        .await
        .expect("seed channel_seq");
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
         VALUES ($1, $2, $3, 'owner')",
    )
    .bind(ws.id)
    .bind(id)
    .bind(ws.owner)
    .execute(su)
    .await
    .expect("seed owner membership");
    id
}

async fn set_last_seq(su: &PgPool, channel: Uuid, last_seq: i64) {
    sqlx::query("UPDATE channel_seq SET last_seq = $2 WHERE channel_id = $1")
        .bind(channel)
        .bind(last_seq)
        .execute(su)
        .await
        .expect("move channel head");
}

async fn login(
    http: &reqwest::Client,
    base: &str,
    workspace: Uuid,
    email: &str,
    pw: &str,
) -> String {
    let body: Value = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({"email": email, "password": pw, "workspace": workspace.to_string()}))
        .send()
        .await
        .expect("login")
        .json()
        .await
        .expect("login body");
    body["accessToken"]
        .as_str()
        .unwrap_or_else(|| panic!("login returns a token: {body}"))
        .to_string()
}

async fn issue_invite(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    ws: Uuid,
    role: &str,
) -> String {
    let response = http
        .post(format!("{base}/v1/workspaces/{ws}/invites"))
        .bearer_auth(token)
        .json(&json!({"role": role, "maxUses": 5}))
        .send()
        .await
        .expect("create invite");
    assert_eq!(response.status().as_u16(), 201, "invite create");
    let body: Value = response.json().await.expect("invite body");
    body["code"].as_str().expect("raw code").to_string()
}

async fn post_join(http: &reqwest::Client, base: &str, code: &str, email: &str) -> (u16, Value) {
    let response = http
        .post(format!("{base}/v1/join"))
        .json(&json!({
            "code": code,
            "email": email,
            "displayName": "박서연",
            "password": JOIN_PASSWORD,
            "timeZone": "Asia/Seoul",
        }))
        .send()
        .await
        .expect("join");
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

fn joined_channels(body: &Value) -> BTreeSet<String> {
    body["memberships"]
        .as_array()
        .unwrap_or_else(|| panic!("memberships array: {body}"))
        .iter()
        .map(|row| row["channelId"].as_str().expect("channelId").to_string())
        .collect()
}

fn ids(channels: &[Uuid]) -> BTreeSet<String> {
    channels.iter().map(Uuid::to_string).collect()
}

/// The member's live channel memberships, read as the superuser (the truth, not the response).
async fn live_channels(su: &PgPool, ws: Uuid, member: Uuid) -> BTreeSet<String> {
    let rows: Vec<Uuid> = sqlx::query_scalar(
        "SELECT channel_id FROM membership \
          WHERE workspace_id = $1 AND member_id = $2 AND left_at IS NULL",
    )
    .bind(ws)
    .bind(member)
    .fetch_all(su)
    .await
    .expect("live memberships");
    rows.iter().map(Uuid::to_string).collect()
}

/// `unread_count` per channel from the member's own read-state projection (the route the
/// sidebar reads), keyed by channel id.
async fn unread_by_channel(
    http: &reqwest::Client,
    base: &str,
    ws: Uuid,
    token: &str,
) -> std::collections::BTreeMap<String, i64> {
    let body: Value = http
        .get(format!("{base}/v1/workspaces/{ws}/read-state"))
        .bearer_auth(token)
        .send()
        .await
        .expect("read-state")
        .json()
        .await
        .expect("read-state body");
    body["read_states"]
        .as_array()
        .unwrap_or_else(|| panic!("read_states array: {body}"))
        .iter()
        .map(|row| {
            (
                row["channel_id"]
                    .as_str()
                    .expect("channel_id")
                    .to_lowercase(),
                row["unread_count"].as_i64().expect("unread_count"),
            )
        })
        .collect()
}

/// (membership rows, read_state rows) of one workspace.
async fn tenant_rows(su: &PgPool, ws: Uuid) -> (i64, i64) {
    sqlx::query_as(
        "SELECT (SELECT count(*) FROM membership WHERE workspace_id = $1), \
                (SELECT count(*) FROM read_state WHERE workspace_id = $1)",
    )
    .bind(ws)
    .fetch_one(su)
    .await
    .expect("tenant rows")
}

async fn member_id_by_email(su: &PgPool, ws: Uuid, email: &str) -> Uuid {
    sqlx::query_scalar("SELECT member_id FROM human WHERE workspace_id = $1 AND email = lower($2)")
        .bind(ws)
        .bind(email)
        .fetch_one(su)
        .await
        .expect("joined human")
}

// ---------------------------------------------------------------------------
// 1. creation writes the marks, the list carries them
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn new_public_channels_are_listed_and_the_channel_list_carries_both_marks() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let ws = seed_workspace(&su, "marks").await;
    let general = seed_channel(&su, &ws, "public", "general", 3, false, true, true, 0).await;
    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();
    let token = login(&http, &base, ws.id, &ws.owner_email, OWNER_PASSWORD).await;

    let mut created = Vec::new();
    for (kind, name) in [("public", "릴리스"), ("private", "인사")] {
        let response = http
            .post(format!("{base}/v1/workspaces/{}/channels", ws.id))
            .bearer_auth(&token)
            .json(&json!({"kind": kind, "name": name}))
            .send()
            .await
            .expect("create channel");
        assert_eq!(response.status().as_u16(), 201, "create {kind}");
        let body: Value = response.json().await.expect("create body");
        created.push((kind, body["channel"].clone()));
    }
    let (_, public) = &created[0];
    let (_, private) = &created[1];
    assert_eq!(
        public["browseListed"],
        json!(true),
        "a new public channel is listed: {public}"
    );
    assert_eq!(
        public["isDefault"],
        json!(false),
        "and not a default channel: {public}"
    );
    assert_eq!(
        private["browseListed"],
        json!(false),
        "a private channel never is: {private}"
    );
    assert_eq!(private["isDefault"], json!(false), "{private}");

    // The stored row agrees with the response.
    let stored: Vec<(String, bool, bool)> = sqlx::query_as(
        "SELECT kind::text, browse_listed, is_default FROM channel \
          WHERE workspace_id = $1 AND id <> $2 ORDER BY kind::text",
    )
    .bind(ws.id)
    .bind(general)
    .fetch_all(&su)
    .await
    .expect("stored marks");
    assert_eq!(
        stored,
        vec![
            ("private".to_string(), false, false),
            ("public".to_string(), true, false)
        ]
    );

    // The caller's channel list carries both marks on every row, by these names.
    let listed: Value = http
        .get(format!("{base}/v1/workspaces/{}/channels", ws.id))
        .bearer_auth(&token)
        .send()
        .await
        .expect("list channels")
        .json()
        .await
        .expect("list body");
    let rows = listed["channels"].as_array().expect("channels array");
    assert_eq!(rows.len(), 3, "general + the two created: {listed}");
    let marks: BTreeSet<(String, bool, bool)> = rows
        .iter()
        .map(|row| {
            (
                row["name"].as_str().expect("name").to_string(),
                row["browseListed"]
                    .as_bool()
                    .expect("browseListed is a bool on every row"),
                row["isDefault"]
                    .as_bool()
                    .expect("isDefault is a bool on every row"),
            )
        })
        .collect();
    assert_eq!(
        marks,
        BTreeSet::from([
            ("general".to_string(), true, true),
            ("릴리스".to_string(), true, false),
            ("인사".to_string(), false, false),
        ])
    );

    // A provisioned workspace is born with its `general` default and listed. The route is
    // instance-operator gated; the provisioning function it calls is the one under test, run on
    // `momo_app` inside the operator's tenant transaction exactly as the route runs it.
    let slug = format!("born-{}", Uuid::new_v4().simple());
    let (operator_ws, operator) = (ws.id, ws.owner);
    let created = momo_db::with_tenant_tx(&momo_app_pool().await, operator_ws, move |conn| {
        Box::pin(async move {
            momo_settings::create_workspace_in_tx(
                conn,
                operator_ws,
                operator,
                &slug,
                "새 워크스페이스",
            )
            .await
        })
    })
    .await
    .expect("provision a workspace")
    .unwrap_or_else(|rejected| panic!("provisioning refused: {rejected:?}"));
    let born = created.workspace_id;
    let seeded: Vec<(String, bool, bool)> = sqlx::query_as(
        "SELECT name, is_default, browse_listed FROM channel WHERE workspace_id = $1",
    )
    .bind(born)
    .fetch_all(&su)
    .await
    .expect("born channels");
    assert_eq!(seeded, vec![("general".to_string(), true, true)]);
}

// ---------------------------------------------------------------------------
// 2. the invite join: default channels only, read position at the end
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_invite_join_lands_in_the_default_channels_only() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let ws = seed_workspace(&su, "join").await;
    // Two default channels (one not listed: listing plays no part in the join), and three
    // channels the join must never touch — an older listed public one, an unlisted public one, a
    // private one.
    let general = seed_channel(&su, &ws, "public", "general", 10, false, true, true, 5).await;
    let notice = seed_channel(&su, &ws, "public", "공지", 9, false, true, false, 3).await;
    let older = seed_channel(&su, &ws, "public", "old-pub", 30, false, false, true, 9).await;
    let unlisted = seed_channel(&su, &ws, "public", "new-pub", 1, false, false, false, 2).await;
    let private = seed_channel(&su, &ws, "private", "secret", 40, false, false, false, 4).await;
    // Another tenant with its own default channel: nothing here may move.
    let other = seed_workspace(&su, "join-other").await;
    let other_general =
        seed_channel(&su, &other, "public", "general", 5, false, true, true, 0).await;
    let other_before = tenant_rows(&su, other.id).await;

    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, ws.id, &ws.owner_email, OWNER_PASSWORD).await;

    // -- a new person ----------------------------------------------------------
    let email = format!("seoyeon-{}@channel-default.test", Uuid::new_v4().simple());
    let code = issue_invite(&http, &base, &owner_token, ws.id, "member").await;
    let (status, body) = post_join(&http, &base, &code, &email).await;
    assert_eq!(status, 201, "a new person joins: {body}");
    assert_eq!(
        joined_channels(&body),
        ids(&[general, notice]),
        "the response: {body}"
    );
    let person = member_id_by_email(&su, ws.id, &email).await;
    assert_eq!(
        live_channels(&su, ws.id, person).await,
        ids(&[general, notice]),
        "every default channel, nothing else (not {older}, {unlisted}, {private})"
    );

    // D9: both default channels start read up to their head.
    let token = login(&http, &base, ws.id, &email, JOIN_PASSWORD).await;
    let unread = unread_by_channel(&http, &base, ws.id, &token).await;
    assert_eq!(
        unread.get(&general.to_string()),
        Some(&0),
        "general: {unread:?}"
    );
    assert_eq!(
        unread.get(&notice.to_string()),
        Some(&0),
        "공지: {unread:?}"
    );

    // -- the same person, now an existing member, spends another link ----------
    // Since joining: three new messages in general (unread stays theirs), and they left 공지.
    set_last_seq(&su, general, 8).await;
    set_last_seq(&su, notice, 6).await;
    sqlx::query("UPDATE membership SET left_at = now() WHERE channel_id = $1 AND member_id = $2")
        .bind(notice)
        .bind(person)
        .execute(&su)
        .await
        .expect("leave 공지");
    let second = issue_invite(&http, &base, &owner_token, ws.id, "member").await;
    let (status, body) = post_join(&http, &base, &second, &email).await;
    assert_eq!(status, 200, "an existing member rejoins: {body}");
    assert_eq!(
        joined_channels(&body),
        ids(&[general, notice]),
        "the response lists the default channels: {body}"
    );
    assert_eq!(
        live_channels(&su, ws.id, person).await,
        ids(&[general, notice]),
        "another link adds no public channel beyond the defaults; the left default comes back"
    );
    let unread = unread_by_channel(&http, &base, ws.id, &token).await;
    assert_eq!(
        unread.get(&general.to_string()),
        Some(&3),
        "a membership that was live keeps its unread: {unread:?}"
    );
    assert_eq!(
        unread.get(&notice.to_string()),
        Some(&0),
        "a restored default channel starts at its head: {unread:?}"
    );

    // The other tenant: same rows, and its default channel holds only its owner.
    assert_eq!(
        tenant_rows(&su, other.id).await,
        other_before,
        "another workspace moved"
    );
    assert_eq!(
        live_channels(&su, other.id, person).await,
        BTreeSet::new(),
        "the joiner reached {other_general}"
    );
}

// ---------------------------------------------------------------------------
// 3. no default channel → the oldest live public channel
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_workspace_without_a_default_channel_falls_back_to_its_oldest_live_public_channel() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let ws = seed_workspace(&su, "fallback").await;
    // Older than the expected one, but archived / private: neither may be picked.
    let _archived = seed_channel(
        &su,
        &ws,
        "public",
        "archived-pub",
        50,
        true,
        false,
        false,
        0,
    )
    .await;
    let _private = seed_channel(&su, &ws, "private", "secret", 60, false, false, false, 0).await;
    let oldest_live =
        seed_channel(&su, &ws, "public", "first-pub", 20, false, false, false, 4).await;
    let _newer = seed_channel(&su, &ws, "public", "second-pub", 10, false, false, true, 0).await;

    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, ws.id, &ws.owner_email, OWNER_PASSWORD).await;
    let email = format!("fallback-{}@channel-default.test", Uuid::new_v4().simple());
    let code = issue_invite(&http, &base, &owner_token, ws.id, "member").await;
    let (status, body) = post_join(&http, &base, &code, &email).await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(joined_channels(&body), ids(&[oldest_live]), "{body}");
    let person = member_id_by_email(&su, ws.id, &email).await;
    assert_eq!(live_channels(&su, ws.id, person).await, ids(&[oldest_live]));
    let token = login(&http, &base, ws.id, &email, JOIN_PASSWORD).await;
    let unread = unread_by_channel(&http, &base, ws.id, &token).await;
    assert_eq!(unread.get(&oldest_live.to_string()), Some(&0), "{unread:?}");
}

// ---------------------------------------------------------------------------
// 4. a guest never lands in a default channel (D8)
// ---------------------------------------------------------------------------

/// Guest invites are paused, but a member can be demoted to guest (ADR-0219 D4), so this is a real
/// guest: a person who joined as a member, was demoted, and left the default channel. Neither a
/// member link nor a guest link puts them back. What answers is the gate before the channel
/// write — role escalation for the member link, the paused role for the guest link — so the
/// default-channel statement never runs for a guest.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_guest_never_lands_in_a_default_channel() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let ws = seed_workspace(&su, "guest").await;
    let general = seed_channel(&su, &ws, "public", "general", 10, false, true, true, 0).await;

    let base = start_server(momo_app_pool().await).await;
    let http = reqwest::Client::new();
    let owner_token = login(&http, &base, ws.id, &ws.owner_email, OWNER_PASSWORD).await;
    let email = format!("guest-{}@channel-default.test", Uuid::new_v4().simple());
    let code = issue_invite(&http, &base, &owner_token, ws.id, "member").await;
    let (status, body) = post_join(&http, &base, &code, &email).await;
    assert_eq!(status, 201, "{body}");
    let person = member_id_by_email(&su, ws.id, &email).await;

    sqlx::query("UPDATE workspace_membership SET role = 'guest' WHERE member_id = $1")
        .bind(person)
        .execute(&su)
        .await
        .expect("demote to guest");
    sqlx::query("UPDATE membership SET left_at = now() WHERE channel_id = $1 AND member_id = $2")
        .bind(general)
        .bind(person)
        .execute(&su)
        .await
        .expect("guest is out of general");

    let member_link = issue_invite(&http, &base, &owner_token, ws.id, "member").await;
    let (status, body) = post_join(&http, &base, &member_link, &email).await;
    assert_eq!(status, 403, "a member link cannot raise a guest: {body}");
    assert!(
        body.to_string()
            .contains("cannot escalate an existing member role"),
        "the role-escalation gate answers, before any channel write: {body}"
    );

    let guest_link: String = {
        // A guest code cannot be minted through the route while guest invites are paused, so the
        // row is written directly with a known code.
        let raw = format!("guest-code-{}", Uuid::new_v4().simple());
        sqlx::query(
            "INSERT INTO invite_code (workspace_id, code_hash, code_preview, role, max_uses, \
                                      expires_at, created_by) \
             VALUES ($1, momo_invite_code_hash($2), right($2, 6), 'guest', 5, \
                     now() + interval '1 day', $3)",
        )
        .bind(ws.id)
        .bind(&raw)
        .bind(ws.owner)
        .execute(&su)
        .await
        .expect("seed a guest invite row");
        raw
    };
    let (status, body) = post_join(&http, &base, &guest_link, &email).await;
    assert_eq!(status, 400, "a guest link is paused: {body}");
    assert!(
        body.to_string().contains("guest_invites_paused"),
        "the paused-role gate answers: {body}"
    );

    assert_eq!(
        live_channels(&su, ws.id, person).await,
        BTreeSet::new(),
        "a guest holds no channel after either link"
    );
}

// ---------------------------------------------------------------------------
// 5. the welcome speaks in the default channel, found by its mark
// ---------------------------------------------------------------------------

async fn seed_native_agent(su: &PgPool, ws: &Workspace, seats: &[Uuid]) -> Uuid {
    let agent = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'agent', 'hermes', $3)",
    )
    .bind(agent)
    .bind(ws.id)
    .bind(format!("hermes-{}", &agent.simple().to_string()[..8]))
    .execute(su)
    .await
    .expect("seed agent member");
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url, max_concurrent_runs, \
                            max_run_steps) \
         VALUES ($1, $2, 'hermes-agent', 'https://gateway.invalid/v1', 4, 50)",
    )
    .bind(agent)
    .bind(ws.id)
    .execute(su)
    .await
    .expect("seed agent");
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ($1, $2, 'member')",
    )
    .bind(ws.id)
    .bind(agent)
    .execute(su)
    .await
    .expect("seed agent role");
    for channel in seats {
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id, role) \
             VALUES ($1, $2, $3, 'member')",
        )
        .bind(ws.id)
        .bind(channel)
        .bind(agent)
        .execute(su)
        .await
        .expect("seat the agent");
    }
    agent
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_welcome_speaks_in_the_oldest_default_channel_whatever_its_name() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let ws = seed_workspace(&su, "welcome").await;
    // A public channel NAMED general that is not a default channel, older than everything; the
    // default channels are Hangul-named, and the older of the two is the welcome channel.
    let named_general =
        seed_channel(&su, &ws, "public", "general", 30, false, false, true, 0).await;
    let welcome = seed_channel(&su, &ws, "public", "공지", 20, false, true, true, 0).await;
    let _later_default = seed_channel(&su, &ws, "public", "안내", 10, false, true, false, 0).await;
    let seated = seed_native_agent(&su, &ws, &[named_general, welcome]).await;
    let unseated = seed_native_agent(&su, &ws, &[named_general]).await;
    let app = momo_app_pool().await;

    // The target the opener is written for.
    let (workspace, owner) = (ws.id, ws.owner);
    let target = momo_db::with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            momo_agent::resolve_welcome_target_in_tx(
                conn,
                workspace,
                false,
                Some(seated),
                owner,
                false,
                false,
            )
            .await
        })
    })
    .await
    .expect("resolve welcome target")
    .expect("a seated native agent can speak");
    assert_eq!(
        target.channel_id, welcome,
        "not the channel named general ({named_general})"
    );
    assert_eq!(target.agent_member_id, seated);

    // The speaker's seat: an agent outside the welcome channel is put there (and only there).
    let joined = momo_db::with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            momo_agent::ensure_agent_in_general_in_tx(conn, workspace, unseated).await
        })
    })
    .await
    .expect("seat the speaker");
    assert!(joined, "the agent was not in the welcome channel before");
    assert_eq!(
        live_channels(&su, ws.id, unseated).await,
        ids(&[named_general, welcome]),
        "seated in the oldest default channel"
    );
    let again = momo_db::with_tenant_tx(&app, workspace, move |conn| {
        Box::pin(async move {
            momo_agent::ensure_agent_in_general_in_tx(conn, workspace, unseated).await
        })
    })
    .await
    .expect("seat the speaker again");
    assert!(!again, "already seated in the welcome channel");
}
