//! DB-backed conformance for **B2.4**: ADR-0139 reattach/replay, the ADR-0125
//! D10 terminal-attach capability plane, and the `audit_log` write path.
//!
//! `#[ignore]` because each needs a real Postgres. Run:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-server --test reattach_smoke_pg -- --ignored --nocapture
//! ```
//!
//! Harness contract is `http_smoke_pg.rs`'s and `t3_smoke_pg.rs`'s: `DATABASE_URL`
//! is a **superuser** (migrations + fixture seeding), the server runs as
//! **`momo_app`** (NOBYPASSRLS, so the RLS policies actually apply), and the
//! schema/roles step is re-runnable — this binary may share one
//! `pgvector/pgvector:pg18` container with the other suites, since every fixture
//! id is a fresh UUID.
//!
//! ## What each test goes red on
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `b24_1_replay_is_seq_contiguous_across_pages` | swap the replay cursor from `message.seq` to a wall-clock column, or drop the `+1` look-ahead that decides `nextCursor` |
//! | `b24_2_attach_token_round_trips_and_refusals_keep_their_status` | accept a capability without re-joining the live session/host/member, or collapse the 403/404 ladder |
//! | `b24_3_issuing_a_grant_writes_its_audit_row` | make `momo_db::audit::write_audit` a no-op, or move it out of the grant's transaction |
//!
//! ### The red in `b24_1`, spelled out
//!
//! Two of the seeded events are given an **identical `created_at`**. A cursor on
//! `created_at` cannot page through them: `> cursor` drops the second, `>=`
//! re-delivers the first. The test asserts that paging one row at a time yields
//! every event exactly once, in ascending `seq`, with no gap — which only a
//! `seq` cursor can satisfy. That is the ADR-0139 promise a reattached terminal
//! depends on: the client's next page starts precisely where the last one
//! stopped.

use std::collections::BTreeSet;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::sqlx::Row;
use momo_db::PgPool;
use momo_messaging::{create_channel, ChannelKind, NewChannel};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET: &str = "b24-reattach-smoke-signing-secret";
const TEST_PASSWORD: &str = "b24-reattach-smoke-password";
const PTY_ID: &str = "pty-b24-smoke";
const ATTACH_ENDPOINT: &str = "wss://host.b24.invalid/attach/pty-b24-smoke";

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
    // T3 stays OFF: nothing in this batch is billable, and leaving it off proves
    // reattach and terminal attach are tier-agnostic (a T1/T2 session reaches
    // every assertion below).
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
// fixtures (superuser → bypass RLS)
// ---------------------------------------------------------------------------

struct Fixture {
    workspace: Uuid,
    owner: Uuid,
    owner_email: String,
    /// A workspace member who is deliberately **not** in the session's channel.
    outsider_email: String,
    channel: Uuid,
}

async fn seed_member(su: &PgPool, workspace: Uuid, label: &str) -> (Uuid, String) {
    let member = Uuid::new_v4();
    let email = format!("{member}@{label}.b24.test");
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $3)",
    )
    .bind(member)
    .bind(workspace)
    .bind(member.to_string())
    .execute(su)
    .await
    .expect("seed member");
    sqlx::query(
        "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
         VALUES ($1, $2, $3, true, momo_password_hash($4))",
    )
    .bind(member)
    .bind(workspace)
    .bind(&email)
    .bind(TEST_PASSWORD)
    .execute(su)
    .await
    .expect("seed human");
    // Workspace membership is what `active_workspace_role` answers on, and the
    // owner role's trigger is what seeds `work_tool_profile` so `claude` is an
    // enabled tool here (029:161-176).
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ($1, $2, 'owner')",
    )
    .bind(workspace)
    .bind(member)
    .execute(su)
    .await
    .expect("seed workspace membership");
    (member, email)
}

async fn seed(su: &PgPool, app: &PgPool) -> Fixture {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(workspace.to_string())
        .execute(su)
        .await
        .expect("seed workspace");

    let (owner, owner_email) = seed_member(su, workspace, "owner").await;
    let (_outsider, outsider_email) = seed_member(su, workspace, "outsider").await;

    // `create_channel` also seeds `channel_seq` and the creator's channel
    // membership — the outsider gets neither, which is the point.
    let channel = create_channel(
        app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("b24-{}", Uuid::new_v4()),
            topic: None,
            created_by: owner,
        },
    )
    .await
    .expect("create channel");

    Fixture {
        workspace,
        owner,
        owner_email,
        outsider_email,
        channel: channel.id,
    }
}

/// A throwaway Ed25519 keypair for the "workd". The private half never leaves
/// this test, exactly as it never leaves a real daemon.
fn workd_keypair() -> ([u8; 32], String) {
    let mut seed = [0u8; 32];
    seed[..16].copy_from_slice(Uuid::new_v4().as_bytes());
    seed[16..].copy_from_slice(Uuid::new_v4().as_bytes());
    let public = ed25519_dalek::SigningKey::from_bytes(&seed)
        .verifying_key()
        .to_bytes();
    (seed, BASE64.encode(public))
}

async fn login(http: &reqwest::Client, base: &str, workspace: Uuid, email: &str) -> String {
    let body: Value = http
        .post(format!("{base}/v1/auth/login"))
        .json(&json!({
            "email": email,
            "password": TEST_PASSWORD,
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
        .expect("accessToken")
        .to_string()
}

/// Publish the host's PTY binding.
///
/// Written as superuser rather than through REST because the only route that
/// sets these two columns is the **work-host-signed** `PATCH …/work-sessions/
/// {session}` (`UpdateWorkSessionRequest.ptyId`, MOMO-655), which this server
/// refuses by name — binding a PTY is workd's act and lands in B5. The capability
/// plane under test starts *after* the binding exists.
async fn bind_pty(su: &PgPool, session: Uuid) {
    let updated =
        sqlx::query("UPDATE work_session SET pty_id = $2, attach_endpoint = $3 WHERE id = $1")
            .bind(session)
            .bind(PTY_ID)
            .bind(ATTACH_ENDPOINT)
            .execute(su)
            .await
            .expect("bind the remote PTY")
            .rows_affected();
    assert_eq!(updated, 1, "exactly one session is bound");
}

/// Append one event to the session's thread, the way the ACP relay does
/// (`WorkSessionRoutes.recordACPEvent` :1483-1502): bump `channel_seq`, insert a
/// `system` message under `root_id`.
async fn append_thread_event(
    su: &PgPool,
    workspace: Uuid,
    channel: Uuid,
    author: Uuid,
    root_message: Uuid,
    body: &str,
) -> i64 {
    let seq: i64 = sqlx::query_scalar(
        "WITH bumped AS ( \
           UPDATE channel_seq SET last_seq = last_seq + 1 \
            WHERE workspace_id = $1 AND channel_id = $2 \
           RETURNING last_seq AS seq \
         ) \
         INSERT INTO message \
           (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body, \
            props, root_id) \
         SELECT $1, $2, b.seq, 1, 0, $3, 'system', $4, \
                jsonb_build_object('kind', 'work_session_event'), $5 \
           FROM bumped b \
         RETURNING seq",
    )
    .bind(workspace)
    .bind(channel)
    .bind(author)
    .bind(body)
    .bind(root_message)
    .fetch_one(su)
    .await
    .expect("append a thread event");
    seq
}

/// Force two rows onto the SAME `created_at`, which is what a wall-clock cursor
/// cannot page through (module docs).
async fn collide_created_at(su: &PgPool, channel: Uuid, seqs: &[i64]) {
    let updated = sqlx::query(
        "UPDATE message SET created_at = timestamptz '2026-07-31 00:00:00.000+00' \
          WHERE channel_id = $1 AND seq = ANY($2)",
    )
    .bind(channel)
    .bind(seqs)
    .execute(su)
    .await
    .expect("collide created_at")
    .rows_affected();
    assert_eq!(updated as usize, seqs.len());
}

/// Create a work session over REST and return `(session_id, root_message_id)`.
async fn create_session(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
    channel: Uuid,
    host: &str,
) -> (Uuid, Uuid) {
    let response = http
        .post(format!("{base}/v1/workspaces/{workspace}/work-sessions"))
        .bearer_auth(token)
        .json(&json!({
            "channelId": channel.to_string(),
            "hostId": host,
            "tool": "claude",
            "label": "b24 reattach smoke",
        }))
        .send()
        .await
        .expect("create work session");
    assert_eq!(response.status(), 201, "the session is created");
    let body: Value = response.json().await.expect("session body");
    let session = &body["workSession"];
    (
        Uuid::parse_str(session["id"].as_str().expect("id")).expect("session uuid"),
        Uuid::parse_str(session["rootMessageId"].as_str().expect("rootMessageId"))
            .expect("root uuid"),
    )
}

/// Register a workd host over REST and return `(host_id, signing_seed)`.
async fn register_host(
    http: &reqwest::Client,
    base: &str,
    token: &str,
    workspace: Uuid,
) -> (String, [u8; 32]) {
    let (seed, public_key) = workd_keypair();
    let response = http
        .post(format!("{base}/v1/workspaces/{workspace}/work-hosts"))
        .bearer_auth(token)
        .json(&json!({
            "scope": "workspace",
            "type": "workd",
            "displayName": "b24 smoke box",
            "publicKey": public_key,
            "capabilities": {"terminal_attach": true},
        }))
        .send()
        .await
        .expect("register work host");
    assert_eq!(response.status(), 201, "the host is registered");
    let body: Value = response.json().await.expect("host body");
    (
        body["workHost"]["id"]
            .as_str()
            .expect("workHost.id")
            .to_string(),
        seed,
    )
}

/// Send a `MomoHost`-signed request, the way a real workd does.
async fn signed_host_post(
    http: &reqwest::Client,
    base: &str,
    seed: &[u8; 32],
    workspace: Uuid,
    host_id: &str,
    path: &str,
    body: &Value,
) -> reqwest::Response {
    let raw = serde_json::to_vec(body).expect("serialize the signed body");
    let digest = momo_wire::signing::sha256_hex(&raw);
    let request_id = Uuid::new_v4();
    let sent_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64;
    let payload = momo_wire::signing::request_payload(
        "POST",
        path,
        workspace,
        Uuid::parse_str(host_id).expect("host uuid"),
        sent_at_ms,
        &digest,
        request_id,
    );
    let signature = momo_wire::signing::sign_base64(seed, &payload).expect("sign");

    http.post(format!("{base}{path}"))
        .header("Authorization", format!("MomoHost {host_id}"))
        .header("X-Momo-Work-Host-Sent-At", sent_at_ms.to_string())
        .header("X-Momo-Work-Host-Signature", signature)
        .header("X-Momo-Work-Host-Request-ID", request_id.to_string())
        .header("Content-Type", "application/json")
        .body(raw)
        .send()
        .await
        .expect("signed host request")
}

// ---------------------------------------------------------------------------
// b24-1 — replay is a seq cursor, and a seq cursor is gapless
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn b24_1_replay_is_seq_contiguous_across_pages() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let workspace = fixture.workspace;

    let token = login(&http, &base, workspace, &fixture.owner_email).await;
    let (host_id, _seed) = register_host(&http, &base, &token, workspace).await;
    let (session, root_message) =
        create_session(&http, &base, &token, workspace, fixture.channel, &host_id).await;
    bind_pty(&su, session).await;

    // Six events. Two of them share a `created_at` to the microsecond, which is
    // exactly what a burst of ACP events produces and exactly what a wall-clock
    // cursor cannot page through.
    let mut seeded = Vec::new();
    for index in 0..6 {
        seeded.push(
            append_thread_event(
                &su,
                workspace,
                fixture.channel,
                fixture.owner,
                root_message,
                &format!("event {index}"),
            )
            .await,
        );
    }
    collide_created_at(&su, fixture.channel, &seeded[2..4]).await;

    // ---- the snapshot half ------------------------------------------------
    let first: Value = http
        .get(format!(
            "{base}/v1/workspaces/{workspace}/work-sessions/{session}/reattach?limit=2"
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("reattach")
        .json()
        .await
        .expect("reattach body");

    assert_eq!(
        first["verdict"], "reattach",
        "a running session on an unrevoked host with a live PTY binding is a \
         reattach, not a lineage resume (ADR-0139 D3)"
    );
    assert_eq!(first["workSession"]["status"], "running");
    assert_eq!(first["workSession"]["remoteAttachAvailable"], json!(true));
    assert_eq!(first["hostRevoked"], json!(false));
    assert_eq!(
        first["lastEventSeq"],
        json!(*seeded.last().expect("six events")),
        "lastEventSeq is the thread's high-water mark, so a client holding it \
         knows it is up to date without fetching a page"
    );
    assert_eq!(
        first["rootMessageSeq"].as_i64().expect("rootMessageSeq"),
        seeded[0] - 1,
        "the card sits immediately before its first reply"
    );

    // ---- the replay half: page one row at a time --------------------------
    let mut collected: Vec<i64> = Vec::new();
    let mut cursor: Option<i64> = None;
    for _ in 0..20 {
        let url = match cursor {
            Some(cursor) => format!(
                "{base}/v1/workspaces/{workspace}/work-sessions/{session}/reattach?limit=1&cursor={cursor}"
            ),
            None => format!(
                "{base}/v1/workspaces/{workspace}/work-sessions/{session}/reattach?limit=1"
            ),
        };
        let page: Value = http
            .get(url)
            .bearer_auth(&token)
            .send()
            .await
            .expect("reattach page")
            .json()
            .await
            .expect("page body");
        for event in page["events"].as_array().expect("events array") {
            collected.push(event["seq"].as_i64().expect("seq"));
            assert_eq!(
                event["rootId"].as_str().expect("rootId"),
                root_message.to_string(),
                "every replayed row belongs to this session's thread"
            );
        }
        match page["nextCursor"].as_i64() {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }

    assert_eq!(
        collected, seeded,
        "paging one row at a time must yield every event exactly once, in \
         ascending seq, with no gap — the ADR-0139 promise a reattached \
         terminal depends on. A `created_at` cursor cannot satisfy this: two of \
         these rows share a timestamp, so `>` drops one and `>=` repeats one."
    );
    let unique: BTreeSet<i64> = collected.iter().copied().collect();
    assert_eq!(unique.len(), collected.len(), "no event is delivered twice");
    for window in collected.windows(2) {
        assert_eq!(
            window[1] - window[0],
            1,
            "channel_seq's row-locked bump makes this thread's seqs contiguous; \
             a gap here means the cursor skipped a row"
        );
    }

    // A cursor at the high-water mark returns nothing and offers no next page.
    let tail: Value = http
        .get(format!(
            "{base}/v1/workspaces/{workspace}/work-sessions/{session}/reattach?cursor={}",
            seeded.last().expect("six events")
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("tail reattach")
        .json()
        .await
        .expect("tail body");
    assert_eq!(tail["events"].as_array().expect("events").len(), 0);
    assert_eq!(tail["nextCursor"], Value::Null);

    // A malformed cursor is a 400, never a silent restart from 0 — restarting
    // would re-deliver the whole session as if it had just happened.
    let bad = http
        .get(format!(
            "{base}/v1/workspaces/{workspace}/work-sessions/{session}/reattach?cursor=yesterday"
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("bad cursor");
    assert_eq!(bad.status(), 400);

    // ---- the D3 branch ----------------------------------------------------
    sqlx::query("UPDATE work_session SET status = 'orphaned' WHERE id = $1")
        .bind(session)
        .execute(&su)
        .await
        .expect("orphan the session");
    let orphaned: Value = http
        .get(format!(
            "{base}/v1/workspaces/{workspace}/work-sessions/{session}/reattach"
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("reattach orphaned")
        .json()
        .await
        .expect("orphaned body");
    assert_eq!(
        orphaned["verdict"], "resume_lineage",
        "a dead host is 새 호스트에서 재개, and ADR-0139 D3 forbids spelling it \
         like 이어서 보기"
    );
    assert_eq!(
        orphaned["events"].as_array().expect("events").len(),
        6,
        "replay still works on an orphaned session — the record outlives the PTY"
    );
}

// ---------------------------------------------------------------------------
// b24-2 — the capability round trip, and the refusal ladder
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn b24_2_attach_token_round_trips_and_refusals_keep_their_status() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let workspace = fixture.workspace;

    let token = login(&http, &base, workspace, &fixture.owner_email).await;
    let (host_id, signing_seed) = register_host(&http, &base, &token, workspace).await;
    let (session, _root) =
        create_session(&http, &base, &token, workspace, fixture.channel, &host_id).await;
    bind_pty(&su, session).await;

    // ---- issue (controller) ----------------------------------------------
    let response = http
        .post(format!(
            "{base}/v1/workspaces/{workspace}/work-sessions/{session}/terminal-attach"
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("issue attach");
    assert_eq!(response.status(), 200, "an owner may attach as controller");
    let grant: Value = response.json().await.expect("grant body");
    let capability = grant["capability_token"]
        .as_str()
        .expect("capability_token (snake_case — the mac/web wire contract)")
        .to_string();
    assert_eq!(grant["pty_id"], json!(PTY_ID));
    assert_eq!(
        grant["attach_endpoint"],
        json!(ATTACH_ENDPOINT),
        "momo hands back the HOST's endpoint; it never proxies the stream"
    );

    // Only the digest reached PostgreSQL.
    let stored: Vec<u8> = sqlx::query_scalar(
        "SELECT token_hash FROM terminal_attach_capability WHERE work_session_id = $1",
    )
    .bind(session)
    .fetch_one(&su)
    .await
    .expect("stored capability");
    assert_eq!(stored.len(), 32, "sha256, not the bearer");
    assert!(
        !String::from_utf8_lossy(&stored).contains("momo_terminal_attach_v1"),
        "the raw capability token must never be persisted"
    );

    // ---- validate (the host's side of the round trip) ---------------------
    let validate_path =
        format!("/v1/workspaces/{workspace}/work-hosts/{host_id}/terminal-attach/validate");
    let response = signed_host_post(
        &http,
        &base,
        &signing_seed,
        workspace,
        &host_id,
        &validate_path,
        &json!({"capability_token": capability}),
    )
    .await;
    assert_eq!(
        response.status(),
        200,
        "the bearer this server minted checks out"
    );
    let validated: Value = response.json().await.expect("validation body");
    assert_eq!(
        validated["work_session_id"].as_str().expect("session"),
        session.to_string()
    );
    assert_eq!(validated["pty_id"], json!(PTY_ID));
    assert_eq!(validated["mode"], json!("controller"));
    assert!(
        validated["expires_at"]
            .as_str()
            .is_some_and(|value| value.ends_with('Z') && value.contains('T')),
        "ISO-8601 with fractional seconds, rendered by PostgreSQL"
    );

    // A replayed request id is refused even though the signature is still valid:
    // migration 048's barrier, not the signature, is what stops a replay.
    let raw = serde_json::to_vec(&json!({"capability_token": capability})).expect("body");
    let digest = momo_wire::signing::sha256_hex(&raw);
    let request_id = Uuid::new_v4();
    let sent_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64;
    let payload = momo_wire::signing::request_payload(
        "POST",
        &validate_path,
        workspace,
        Uuid::parse_str(&host_id).expect("host uuid"),
        sent_at_ms,
        &digest,
        request_id,
    );
    let signature = momo_wire::signing::sign_base64(&signing_seed, &payload).expect("sign");
    let replay = |body: Vec<u8>| {
        http.post(format!("{base}{validate_path}"))
            .header("Authorization", format!("MomoHost {host_id}"))
            .header("X-Momo-Work-Host-Sent-At", sent_at_ms.to_string())
            .header("X-Momo-Work-Host-Signature", signature.clone())
            .header("X-Momo-Work-Host-Request-ID", request_id.to_string())
            .header("Content-Type", "application/json")
            .body(body)
            .send()
    };
    assert_eq!(replay(raw.clone()).await.expect("first use").status(), 200);
    assert_eq!(
        replay(raw).await.expect("replay").status(),
        401,
        "a request id is consumed exactly once (048)"
    );

    // An unsigned caller learns nothing.
    let unsigned = http
        .post(format!("{base}{validate_path}"))
        .json(&json!({"capability_token": capability}))
        .send()
        .await
        .expect("unsigned validate");
    assert_eq!(unsigned.status(), 401);

    // ---- the refusal ladder, statuses kept apart --------------------------
    // 404: an unknown session, to a member who IS in the workspace.
    let unknown = http
        .post(format!(
            "{base}/v1/workspaces/{workspace}/work-sessions/{}/terminal-attach",
            Uuid::new_v4()
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("unknown session");
    assert_eq!(
        unknown.status(),
        404,
        "a workspace member may learn that a session id is not theirs to find"
    );

    // 403: a workspace member who is not in the session's channel. The session
    // EXISTS, and they still must not be told so by a 404/200 difference.
    let outsider = login(&http, &base, workspace, &fixture.outsider_email).await;
    let refused = http
        .post(format!(
            "{base}/v1/workspaces/{workspace}/work-sessions/{session}/terminal-attach"
        ))
        .bearer_auth(&outsider)
        .json(&json!({"mode": "observer"}))
        .send()
        .await
        .expect("outsider observer");
    assert_eq!(refused.status(), 403);
    let body: Value = refused.json().await.expect("refusal body");
    assert_eq!(
        body["error"]["message"], "active channel membership required",
        "the refusal names the missing membership, not the session"
    );

    // 403: a channel member who is not the owner may not take the controller
    // grade — a different sentence, because it is a different rule.
    let non_owner = http
        .post(format!(
            "{base}/v1/workspaces/{workspace}/work-sessions/{session}/terminal-attach"
        ))
        .bearer_auth(&outsider)
        .send()
        .await
        .expect("outsider controller");
    assert_eq!(non_owner.status(), 403);
    let body: Value = non_owner.json().await.expect("controller refusal");
    assert_eq!(
        body["error"]["message"],
        "only the session owner can attach as controller"
    );

    // 409: the session ends, and every outstanding capability dies with it —
    // the validate join is re-evaluated, so nothing is cached to go stale.
    let ended = http
        .patch(format!(
            "{base}/v1/workspaces/{workspace}/work-sessions/{session}"
        ))
        .bearer_auth(&token)
        .json(&json!({"status": "ended"}))
        .send()
        .await
        .expect("end session");
    assert_eq!(ended.status(), 200);

    let after_end = signed_host_post(
        &http,
        &base,
        &signing_seed,
        workspace,
        &host_id,
        &validate_path,
        &json!({"capability_token": capability, "stream": true}),
    )
    .await;
    assert_eq!(
        after_end.status(),
        401,
        "`stream: true` relaxes expiry and ONLY expiry — an ended session still \
         revokes the stream on the next revalidation"
    );

    let unavailable = http
        .post(format!(
            "{base}/v1/workspaces/{workspace}/work-sessions/{session}/terminal-attach"
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("issue after end");
    assert_eq!(
        unavailable.status(),
        409,
        "an ended session is a conflict, not a 404: it exists, it just cannot be \
         attached to"
    );
}

// ---------------------------------------------------------------------------
// b24-3 — the audit row the B0 stub owed
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + bootstrap_roles.sql"]
async fn b24_3_issuing_a_grant_writes_its_audit_row() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app_pool = momo_app_pool().await;
    let fixture = seed(&su, &app_pool).await;
    let base = start_server(app_pool).await;
    let http = reqwest::Client::new();
    let workspace = fixture.workspace;

    let token = login(&http, &base, workspace, &fixture.owner_email).await;
    let (host_id, _seed) = register_host(&http, &base, &token, workspace).await;
    let (session, _root) =
        create_session(&http, &base, &token, workspace, fixture.channel, &host_id).await;
    bind_pty(&su, session).await;

    let response = http
        .post(format!(
            "{base}/v1/workspaces/{workspace}/work-sessions/{session}/terminal-attach"
        ))
        .bearer_auth(&token)
        .json(&json!({"mode": "observer"}))
        .send()
        .await
        .expect("issue observer attach");
    assert_eq!(response.status(), 200);

    let row = sqlx::query(
        "SELECT actor_member_id, subject_member_id, target_type, target_id, via_token_id, detail \
           FROM audit_log \
          WHERE workspace_id = $1 AND action = 'work.terminal_attach.issued'",
    )
    .bind(workspace)
    .fetch_one(&su)
    .await
    .expect(
        "the grant's audit row — write_audit was a B0 `unimplemented!()` stub \
         until this batch, so every issue used to mint a capability with no \
         record of who asked for it",
    );

    let actor: Option<Uuid> = row.get("actor_member_id");
    let subject: Option<Uuid> = row.get("subject_member_id");
    let target_type: Option<String> = row.get("target_type");
    let target_id: Option<Uuid> = row.get("target_id");
    let via_token_id: Option<Uuid> = row.get("via_token_id");
    let detail: Value = row.get("detail");

    assert_eq!(actor, Some(fixture.owner));
    assert_eq!(subject, Some(fixture.owner), "a self-directed action");
    assert_eq!(target_type.as_deref(), Some("work_session"));
    assert_eq!(target_id, Some(session));
    assert!(
        via_token_id.is_some(),
        "a human bearer's token_id IS a `token` row, and delegation provenance \
         is what this column is for"
    );
    assert_eq!(
        detail["schema"], "momo.work.terminal_attach.issued.v1",
        "every audit detail opens with its own schema version"
    );
    assert_eq!(detail["mode"], "observer");
    assert_eq!(
        detail["owner_member_id"].as_str().expect("owner_member_id"),
        fixture.owner.to_string()
    );

    // The row is in the SAME transaction as the grant: exactly one capability
    // and exactly one audit row.
    let grants: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM terminal_attach_capability WHERE work_session_id = $1",
    )
    .bind(session)
    .fetch_one(&su)
    .await
    .expect("count grants");
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log \
          WHERE workspace_id = $1 AND action = 'work.terminal_attach.issued'",
    )
    .bind(workspace)
    .fetch_one(&su)
    .await
    .expect("count audit rows");
    assert_eq!(grants, 1);
    assert_eq!(
        audits, grants,
        "one grant, one record — the atomicity write_audit exists for"
    );

    // The observer grant also broadcast its count through the ONE egress.
    let outbox: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox \
          WHERE workspace_id = $1 \
            AND payload->'data'->>'type' = 'work.session.observer'",
    )
    .bind(workspace)
    .fetch_one(&su)
    .await
    .expect("count observer broadcasts");
    assert_eq!(
        outbox, 1,
        "emitted through momo_outbox::emit_outbox, in the same tx"
    );
}
