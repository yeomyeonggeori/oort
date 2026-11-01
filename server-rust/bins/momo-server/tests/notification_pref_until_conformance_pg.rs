//! #4343 — `PUT …/channels/{ch}/notification-pref` takes an end: `mutedUntilMs`
//! (ADR-0206 D12).
//!
//! The judgment already read the end (`muted_until IS NULL OR muted_until > now()`, five
//! places), and the column has been there since migration 018; the API wrote `NULL` and nothing
//! else. This suite measures the whole chain a person's tap travels — the write, its answer, the
//! rows of the channel lists, the audit row, and the push that is or is not sent — on the real
//! router as `momo_app` (NOBYPASSRLS), with two tenants wherever isolation is the question.
//!
//! | test | what it shows | sabotage that makes it red |
//! |---|---|---|
//! | `a_timed_mute_is_written_answered_listed_and_audited_and_lapses_with_no_sweeper` | ① the old body is unchanged · the end is stored, answered, listed (channel list, DM list, DM open) and audited · it is the caller's own (the other person in the DM sees none) · a new `{muted:true}` makes it open-ended · after the end the lists read unmuted while the row is still there | drop `muted_until` from the upsert, the `> now()` clause or the `member_id` predicate from a list read (any of the three), the key from the audit detail, or emit `null` instead of omitting the key |
//! | `a_refused_window_or_body_writes_nothing` | ② a past end · ⑤ more than 366 days · a deadline on an un-mute are 400 (codes for the first two) · a body the extractor refuses is 422 · nothing was written, nothing audited · a non-member is 403 | remove the `until <= now` check, the 366-day cap or the un-mute refusal from `validate_channel_mute` |
//! | `a_write_answers_the_mute_as_it_reads_now_not_as_it_was_asked` | the answer is the effective value: an end already behind `now()` reads unmuted | answer `muted: true` / the request's end instead of the stored row's `muted_until > now()` |
//! | `a_mute_never_crosses_a_tenant` | two tenants: B cannot write A's channel, neither list names the other's mute, and under B's GUC A's row is zero rows. Isolation here is layered (scope check, membership predicate, RLS FORCE), so it pins the outcome | connect the pool as a role that bypasses RLS (the zero-rows step goes red) |
//! | `a_push_candidate_after_the_end_is_sent_one_before_it_is_not` | ③ `until = now + 2 s`: the mention at t0 sends nothing and leaves no `push_dispatch_log` row; the **new** mention at t0 + 3 s is sent once; no sweeper touched the row; the other tenant is not affected | flip the comparison in `judge_targets` (`np.muted_until <= now()`), or write the end as `NULL` |
//!
//! No test sleeps: the clock is the database's `now()`, and "three seconds later" is the stored
//! end moved three seconds earlier, the same way `a_timed_pause_suppresses_until_it_expires_then_delivers`
//! lets a pause lapse. That is exactly what a lazily-expired row looks like with no sweeper.
//!
//! `#[ignore]` because it needs a real Postgres:
//!
//! ```text
//! DATABASE_URL=postgres://postgres:postgres@127.0.0.1:<port>/<db> \
//!   cargo test -p momo-server --test notification_pref_until_conformance_pg \
//!     -- --ignored --test-threads=1
//! ```
//!
//! Harness contract is `http_smoke_pg.rs`'s: `DATABASE_URL` is a superuser (migrations + fixtures),
//! the domain runs as `momo_app` (NOBYPASSRLS); the push drain runs as `momo_notifier` (BYPASSRLS,
//! the one role that serves every tenant) against an injected recording relay — nothing here
//! contacts Apple.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::{with_tenant_tx, PgPool};
use momo_messaging::{
    create_channel, db_now_in_tx, set_notification_pref_in_tx, ChannelKind, ChannelMute,
    ChannelMuteWrite, NewChannel,
};
use momo_notifier::{PushConfig, PushDrain};
use momo_push::{DispatchOutcome, PushDispatch, PushDispatcher};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

const TEST_JWT_SECRET: &str = "notification-pref-until-conformance-secret";
const TEST_PASSWORD: &str = "notification-pref-until-password";
const DAY_MS: i64 = 86_400_000;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn password_of(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url())
        .await
        .expect("connect as superuser")
}

async fn role_pool(username: &str, password: &str) -> PgPool {
    let options: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options.username(username).password(password))
        .await
        .unwrap_or_else(|error| panic!("connect as {username} (bootstrap_roles.sql?): {error}"))
}

async fn momo_app_pool() -> PgPool {
    let pool = role_pool(
        "momo_app",
        &password_of("MOMO_APP_PASSWORD", "momo_app_dev_pw"),
    )
    .await;
    // This suite's claim is "as a role RLS applies to": measure it, never assume it.
    let (superuser, bypass_rls): (bool, bool) =
        sqlx::query_as("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user")
            .fetch_one(&pool)
            .await
            .expect("read the app role's attributes");
    assert!(
        !superuser && !bypass_rls,
        "the app pool must be NOSUPERUSER NOBYPASSRLS (superuser={superuser}, bypassrls={bypass_rls})"
    );
    pool
}

async fn momo_notifier_pool() -> PgPool {
    role_pool(
        "momo_notifier",
        &password_of("MOMO_NOTIFIER_PASSWORD", "momo_notifier_dev_pw"),
    )
    .await
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
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1", "--no-psqlrc", "--quiet"])
        .arg("--single-transaction")
        .arg("-f")
        .arg(PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../infra/rust/sql/bootstrap_roles.sql"
        )))
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
        .expect("bind");
    let address: SocketAddr = listener.local_addr().expect("address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{address}")
}

// ---------------------------------------------------------------------------
// fixtures (superuser → bypass RLS; the channel goes through the domain crate)
// ---------------------------------------------------------------------------

struct Person {
    member: Uuid,
    email: String,
}

/// One workspace: `owner` (who mutes) and `peer` (a second member), plus a public channel only the
/// owner is in.
struct Tenant {
    workspace: Uuid,
    owner: Person,
    peer: Person,
    channel: Uuid,
}

async fn seed_person(su: &PgPool, workspace: Uuid) -> Person {
    let member = Uuid::new_v4();
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
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'member')",
    )
    .bind(workspace)
    .bind(member)
    .execute(su)
    .await
    .expect("seed workspace membership");
    let email = format!("{member}@mute-until.test");
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
    Person { member, email }
}

async fn seed_tenant(su: &PgPool, app: &PgPool) -> Tenant {
    let workspace = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace)
        .bind(format!("mute-until-{workspace}"))
        .execute(su)
        .await
        .expect("seed workspace");
    let owner = seed_person(su, workspace).await;
    let peer = seed_person(su, workspace).await;
    let channel = create_channel(
        app,
        workspace,
        NewChannel {
            kind: ChannelKind::Public,
            name: format!("general-{}", Uuid::new_v4()),
            topic: None,
            created_by: owner.member,
        },
    )
    .await
    .expect("create channel")
    .id;
    Tenant {
        workspace,
        owner,
        peer,
        channel,
    }
}

/// A person at the HTTP door with a real login.
struct Api {
    http: reqwest::Client,
    base: String,
    token: String,
    workspace: Uuid,
}

impl Api {
    async fn login(base: &str, workspace: Uuid, person: &Person) -> Api {
        let http = reqwest::Client::new();
        let login: Value = http
            .post(format!("{base}/v1/auth/login"))
            .json(&json!({
                "email": person.email,
                "password": TEST_PASSWORD,
                "workspace": workspace.to_string(),
            }))
            .send()
            .await
            .expect("login")
            .json()
            .await
            .expect("login body");
        let token = login["accessToken"].as_str().expect("token").to_string();
        Api {
            http,
            base: base.to_string(),
            token,
            workspace,
        }
    }

    async fn send(&self, request: reqwest::RequestBuilder) -> (u16, Value) {
        let response = request.bearer_auth(&self.token).send().await.expect("send");
        let status = response.status().as_u16();
        (
            status,
            response.json::<Value>().await.unwrap_or(Value::Null),
        )
    }

    /// `PUT …/channels/{ch}/notification-pref` in this person's own workspace.
    async fn put(&self, channel: Uuid, body: Value) -> (u16, Value) {
        self.put_in(self.workspace, channel, body).await
    }

    async fn put_in(&self, workspace: Uuid, channel: Uuid, body: Value) -> (u16, Value) {
        let url = format!(
            "{}/v1/workspaces/{workspace}/channels/{channel}/notification-pref",
            self.base
        );
        self.send(self.http.put(url).json(&body)).await
    }

    async fn channels(&self) -> Value {
        let url = format!("{}/v1/workspaces/{}/channels", self.base, self.workspace);
        let (status, body) = self.send(self.http.get(url)).await;
        assert_eq!(status, 200, "{body}");
        body
    }

    async fn dms(&self) -> Value {
        let url = format!("{}/v1/workspaces/{}/dms", self.base, self.workspace);
        let (status, body) = self.send(self.http.get(url)).await;
        assert_eq!(status, 200, "{body}");
        body
    }

    /// `POST …/dms`: opens the pair's DM, or finds it. Returns the status and `channel`.
    async fn open_dm(&self, with: Uuid) -> (u16, Value) {
        let url = format!("{}/v1/workspaces/{}/dms", self.base, self.workspace);
        let (status, body) = self
            .send(self.http.post(url).json(&json!({ "memberId": with })))
            .await;
        (status, body["channel"].clone())
    }
}

/// The row of `list["channels"]` for `id`.
fn row_of(list: &Value, id: Uuid) -> &Value {
    list["channels"]
        .as_array()
        .expect("channels array")
        .iter()
        .find(|row| row["id"].as_str() == Some(id.to_string().as_str()))
        .unwrap_or_else(|| panic!("channel {id} is listed: {list}"))
}

fn channel_id_of(channel: &Value) -> Uuid {
    Uuid::parse_str(channel["id"].as_str().expect("channel id")).expect("uuid")
}

async fn db_now_ms(su: &PgPool) -> i64 {
    sqlx::query_scalar("SELECT floor(extract(epoch from now()) * 1000)::bigint")
        .fetch_one(su)
        .await
        .expect("database clock")
}

/// `None`: no row. `Some(None)`: an open-ended mute. `Some(Some(ms))`: a timed one.
async fn stored_until(
    su: &PgPool,
    workspace: Uuid,
    channel: Uuid,
    member: Uuid,
) -> Option<Option<i64>> {
    sqlx::query_scalar::<_, Option<i64>>(
        "SELECT CASE WHEN muted_until IS NULL THEN NULL \
                     ELSE floor(extract(epoch from muted_until) * 1000)::bigint END \
           FROM notification_pref \
          WHERE workspace_id = $1 AND channel_id = $2 AND member_id = $3",
    )
    .bind(workspace)
    .bind(channel)
    .bind(member)
    .fetch_optional(su)
    .await
    .expect("read the stored mute")
}

/// What the audit rows for one channel recorded, oldest first: `(muted, mutedUntilMs)`.
async fn audited(su: &PgPool, workspace: Uuid, channel: Uuid) -> Vec<(Value, Value)> {
    use momo_db::sqlx::Row;
    sqlx::query(
        "SELECT detail->'muted' AS muted, detail->'mutedUntilMs' AS until, \
                detail ? 'mutedUntilMs' AS has_until, detail->'schema' AS sc \
           FROM audit_log \
          WHERE workspace_id = $1 AND action = 'notification_pref.updated' AND target_id = $2 \
          ORDER BY created_at, id",
    )
    .bind(workspace)
    .bind(channel)
    .fetch_all(su)
    .await
    .expect("read audit")
    .into_iter()
    .map(|row| {
        assert_eq!(
            row.get::<Value, _>("sc"),
            json!("momo.notification_pref.updated.v1"),
            "the schema tag stays: the new key is additive"
        );
        assert!(
            row.get::<bool, _>("has_until"),
            "every record carries the key, `null` when there is no end"
        );
        (row.get("muted"), row.get("until"))
    })
    .collect()
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

/// ① the old body, then the end through the write, its answer, every list that carries the row,
/// and the audit; then the end passes and nothing has swept the row.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn a_timed_mute_is_written_answered_listed_and_audited_and_lapses_with_no_sweeper() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su, &app).await;
    let base = start_server(app.clone()).await;
    let api = Api::login(&base, tenant.workspace, &tenant.owner).await;
    let (ws, ch, me) = (tenant.workspace, tenant.channel, tenant.owner.member);

    // The DM readers: `GET …/dms` and `POST …/dms` (open) are two of the three places that list.
    let (status, dm_channel) = api.open_dm(tenant.peer.member).await;
    assert_eq!(status, 201, "{dm_channel}");
    let dm = channel_id_of(&dm_channel);

    // ① The body every older client sends is an open-ended mute, byte for byte as before.
    let (status, body) = api.put(ch, json!({"muted": true})).await;
    assert_eq!((status, &body), (200, &json!({"muted": true})));
    assert_eq!(stored_until(&su, ws, ch, me).await, Some(None));
    let row = row_of(&api.channels().await, ch).clone();
    assert_eq!(row["muted"], json!(true));
    assert!(
        row.get("mutedUntilMs").is_none(),
        "an open-ended mute has no end to report: {row}"
    );

    // The end: stored to the millisecond, answered, listed in all three readers.
    let until = db_now_ms(&su).await + 3_600_000;
    let (status, body) = api
        .put(ch, json!({"muted": true, "mutedUntilMs": until}))
        .await;
    assert_eq!(
        (status, &body),
        (200, &json!({"muted": true, "mutedUntilMs": until}))
    );
    assert_eq!(stored_until(&su, ws, ch, me).await, Some(Some(until)));
    let listed = api.channels().await;
    assert_eq!(row_of(&listed, ch)["muted"], json!(true));
    assert_eq!(row_of(&listed, ch)["mutedUntilMs"], json!(until));

    let (status, body) = api
        .put(dm, json!({"muted": true, "mutedUntilMs": until}))
        .await;
    assert_eq!(
        (status, &body),
        (200, &json!({"muted": true, "mutedUntilMs": until}))
    );
    assert_eq!(
        row_of(&api.channels().await, dm)["mutedUntilMs"],
        json!(until),
        "the channel list carries DMs too"
    );
    assert_eq!(
        row_of(&api.dms().await, dm)["mutedUntilMs"],
        json!(until),
        "GET …/dms"
    );
    let (status, reopened) = api.open_dm(tenant.peer.member).await;
    assert_eq!(status, 200, "the pair's DM already exists: {reopened}");
    assert_eq!(
        reopened["mutedUntilMs"],
        json!(until),
        "POST …/dms (open) reads the same row"
    );

    // The mute is the caller's own preference: the other person in that DM sees neither a mute
    // nor an end, in any of the three readers.
    let peer_api = Api::login(&base, ws, &tenant.peer).await;
    let others = [
        (
            "GET …/channels",
            row_of(&peer_api.channels().await, dm).clone(),
        ),
        ("GET …/dms", row_of(&peer_api.dms().await, dm).clone()),
        ("POST …/dms", peer_api.open_dm(tenant.owner.member).await.1),
    ];
    for (reader, row) in others {
        assert_eq!(row["muted"], json!(false), "{reader}: {row}");
        assert!(
            row.get("mutedUntilMs").is_none(),
            "{reader}: someone else's mute end must not leak: {row}"
        );
    }

    // A plain `{muted:true}` over a timed mute makes it open-ended, as it always overwrote.
    let (status, body) = api.put(ch, json!({"muted": true})).await;
    assert_eq!((status, &body), (200, &json!({"muted": true})));
    assert_eq!(stored_until(&su, ws, ch, me).await, Some(None));
    assert!(row_of(&api.channels().await, ch)
        .get("mutedUntilMs")
        .is_none());

    // The end passes. Only the clock moves: no sweeper, the row stays, and every reader says unmuted.
    let until_again = db_now_ms(&su).await + 3_600_000;
    let (status, _) = api
        .put(ch, json!({"muted": true, "mutedUntilMs": until_again}))
        .await;
    assert_eq!(status, 200);
    sqlx::query(
        "UPDATE notification_pref SET muted_until = now() - interval '1 second' \
          WHERE workspace_id = $1 AND member_id = $2 AND channel_id = ANY($3)",
    )
    .bind(ws)
    .bind(me)
    .bind(vec![ch, dm])
    .execute(&su)
    .await
    .expect("let both mutes lapse");
    let listed = api.channels().await;
    for id in [ch, dm] {
        let row = row_of(&listed, id);
        assert_eq!(row["muted"], json!(false), "an ended mute is not a mute");
        assert!(
            row.get("mutedUntilMs").is_none(),
            "…and has no end to report: {row}"
        );
    }
    let row = row_of(&api.dms().await, dm).clone();
    assert_eq!(row["muted"], json!(false));
    assert!(row.get("mutedUntilMs").is_none(), "{row}");
    let (_, reopened) = api.open_dm(tenant.peer.member).await;
    assert_eq!(reopened["muted"], json!(false));
    assert!(reopened.get("mutedUntilMs").is_none(), "{reopened}");
    assert!(
        matches!(stored_until(&su, ws, ch, me).await, Some(Some(_))),
        "nothing swept the lapsed row"
    );

    // Un-mute deletes the row; a `null` end on an un-mute is no end.
    let (status, body) = api.put(ch, json!({"muted": false})).await;
    assert_eq!((status, &body), (200, &json!({"muted": false})));
    assert_eq!(stored_until(&su, ws, ch, me).await, None);
    let (status, body) = api
        .put(ch, json!({"muted": false, "mutedUntilMs": null}))
        .await;
    assert_eq!((status, &body), (200, &json!({"muted": false})));

    // ⑤ The audit rows say what each write stored, in order. `null` is open-ended or un-muted.
    assert_eq!(
        audited(&su, ws, ch).await,
        vec![
            (json!(true), Value::Null),
            (json!(true), json!(until)),
            (json!(true), Value::Null),
            (json!(true), json!(until_again)),
            (json!(false), Value::Null),
            (json!(false), Value::Null),
        ]
    );
}

/// ② a past end, ⑤ more than 366 days, a deadline on an un-mute: refused before any write.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn a_refused_window_or_body_writes_nothing() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su, &app).await;
    let base = start_server(app.clone()).await;
    let api = Api::login(&base, tenant.workspace, &tenant.owner).await;
    let (ws, ch, me) = (tenant.workspace, tenant.channel, tenant.owner.member);
    let now = db_now_ms(&su).await;

    // 400 with the machine code the client branches on.
    for (label, until, code) in [
        ("a second ago", now - 1_000, "muted_until_in_past"),
        ("the epoch", 0, "muted_until_in_past"),
        ("negative", -1, "muted_until_in_past"),
        ("367 days out", now + 367 * DAY_MS, "muted_until_too_far"),
        ("the largest int64", i64::MAX, "muted_until_too_far"),
    ] {
        let (status, body) = api
            .put(ch, json!({"muted": true, "mutedUntilMs": until}))
            .await;
        assert_eq!(status, 400, "{label}: {body}");
        assert_eq!(body["error"]["code"], json!(code), "{label}: {body}");
    }

    // A deadline on an un-mute is a 400 too, and it carries no code (no client sends one).
    let (status, body) = api
        .put(ch, json!({"muted": false, "mutedUntilMs": now + 60_000}))
        .await;
    assert_eq!(status, 400, "{body}");
    assert!(body["error"].get("code").is_none(), "{body}");

    // A body the JSON extractor refuses never reaches the handler: 422, as on the sibling routes.
    for body in [
        json!({"muted": true, "mutedUntilMs": "soon"}),
        json!({"muted": true, "mutedUntilMs": 1.5}),
        json!({"muted": true, "level": "none"}),
        json!({"mutedUntilMs": now + 60_000}),
        json!({"muted": true, "memberId": tenant.peer.member}),
    ] {
        let (status, _) = api.put(ch, body.clone()).await;
        assert_eq!(status, 422, "{body}");
    }

    assert_eq!(
        stored_until(&su, ws, ch, me).await,
        None,
        "not one of those wrote a row"
    );
    assert!(audited(&su, ws, ch).await.is_empty(), "…or an audit record");

    // The window's accepted side: a year out is fine.
    let near_cap = now + 365 * DAY_MS;
    let (status, body) = api
        .put(ch, json!({"muted": true, "mutedUntilMs": near_cap}))
        .await;
    assert_eq!(
        (status, &body),
        (200, &json!({"muted": true, "mutedUntilMs": near_cap}))
    );

    // A workspace member who is not in the channel cannot set its preference.
    let stranger = Api::login(&base, ws, &tenant.peer).await;
    let (status, _) = stranger
        .put(ch, json!({"muted": true, "mutedUntilMs": now + 60_000}))
        .await;
    assert_eq!(status, 403);
    assert_eq!(
        stored_until(&su, ws, ch, tenant.peer.member).await,
        None,
        "the refusal wrote nothing for the stranger"
    );
}

/// The answer of a write is the mute as it reads **now**, not the request. The route never lets a
/// past end through, so this goes to the write function itself — through `momo_app` in a tenant
/// transaction, as the route does.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn a_write_answers_the_mute_as_it_reads_now_not_as_it_was_asked() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su, &app).await;
    let (ws, ch, me) = (tenant.workspace, tenant.channel, tenant.owner.member);

    let write = |app: PgPool, offset_seconds: Option<i64>, member: Uuid| async move {
        with_tenant_tx(&app, ws, move |conn| {
            Box::pin(async move {
                let now = db_now_in_tx(conn).await?;
                let until = offset_seconds.map(|seconds| now + chrono::Duration::seconds(seconds));
                set_notification_pref_in_tx(conn, ws, ch, member, ChannelMuteWrite::Mute { until })
                    .await
            })
        })
        .await
        .expect("write")
    };

    // An end already behind now(): stored as asked, answered as it reads — not muted, no end.
    assert_eq!(
        write(app.clone(), Some(-1), me).await,
        Some(ChannelMute {
            muted: false,
            muted_until_ms: None
        })
    );
    assert!(matches!(stored_until(&su, ws, ch, me).await, Some(Some(_))));

    // An end ahead: muted, and the answer carries it.
    let answered = write(app.clone(), Some(3_600), me)
        .await
        .expect("a member may write");
    assert!(answered.muted);
    assert_eq!(
        Some(answered.muted_until_ms.expect("a timed mute has an end")),
        stored_until(&su, ws, ch, me).await.flatten()
    );

    // No end: muted, nothing to report.
    assert_eq!(
        write(app.clone(), None, me).await,
        Some(ChannelMute {
            muted: true,
            muted_until_ms: None
        })
    );

    // Not a member of the channel: no answer at all, and no row.
    assert_eq!(write(app, Some(3_600), tenant.peer.member).await, None);
    assert_eq!(stored_until(&su, ws, ch, tenant.peer.member).await, None);
}

/// Two tenants. Nothing one writes is visible in, or reachable from, the other.
#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres"]
async fn a_mute_never_crosses_a_tenant() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let a = seed_tenant(&su, &app).await;
    let b = seed_tenant(&su, &app).await;
    let base = start_server(app.clone()).await;
    let api_a = Api::login(&base, a.workspace, &a.owner).await;
    let api_b = Api::login(&base, b.workspace, &b.owner).await;
    let now = db_now_ms(&su).await;
    let (until_a, until_b) = (now + 3_600_000, now + 7_200_000);

    let (status, _) = api_a
        .put(a.channel, json!({"muted": true, "mutedUntilMs": until_a}))
        .await;
    assert_eq!(status, 200);

    // B's person cannot reach A's channel: not through A's workspace path (the credential's
    // workspace is B's), and not through their own (A's channel is not in B's tenant).
    let attempt = json!({"muted": true, "mutedUntilMs": until_b});
    let (status, _) = api_b.put_in(a.workspace, a.channel, attempt.clone()).await;
    assert_eq!(status, 403);
    let (status, _) = api_b.put_in(b.workspace, a.channel, attempt).await;
    assert_eq!(status, 403);
    assert_eq!(
        stored_until(&su, a.workspace, a.channel, a.owner.member).await,
        Some(Some(until_a)),
        "A's mute is untouched"
    );
    assert_eq!(
        stored_until(&su, b.workspace, a.channel, b.owner.member).await,
        None
    );

    // B mutes B's own channel on a different end; each list names its own tenant's channel only.
    let (status, _) = api_b
        .put(b.channel, json!({"muted": true, "mutedUntilMs": until_b}))
        .await;
    assert_eq!(status, 200);
    let list_a = api_a.channels().await;
    let list_b = api_b.channels().await;
    assert_eq!(row_of(&list_a, a.channel)["mutedUntilMs"], json!(until_a));
    assert_eq!(row_of(&list_b, b.channel)["mutedUntilMs"], json!(until_b));
    let ids = |list: &Value| -> Vec<String> {
        list["channels"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["id"].as_str().unwrap().to_string())
            .collect()
    };
    assert!(!ids(&list_a).contains(&b.channel.to_string()), "{list_a}");
    assert!(!ids(&list_b).contains(&a.channel.to_string()), "{list_b}");

    // Under B's tenant GUC, as `momo_app`, A's preference row is not there to read: zero rows,
    // not filtered rows.
    let (a_ws, a_channel) = (a.workspace, a.channel);
    let visible: i64 = with_tenant_tx(&app, b.workspace, move |conn| {
        Box::pin(async move {
            Ok(sqlx::query_scalar(
                "SELECT count(*) FROM notification_pref WHERE channel_id = $1 OR workspace_id = $2",
            )
            .bind(a_channel)
            .bind(a_ws)
            .fetch_one(&mut *conn)
            .await?)
        })
    })
    .await
    .expect("count under B's GUC");
    assert_eq!(visible, 0);
}

// ---------------------------------------------------------------------------
// ③ the push: lazy expiry through the real drain
// ---------------------------------------------------------------------------

/// Records every dispatch and answers 200. It stands where the push relay stands in production,
/// and is the only thing this suite ever "sends" to.
struct RecordingDispatcher {
    sent: Mutex<Vec<PushDispatch>>,
}

impl RecordingDispatcher {
    fn new() -> Arc<Self> {
        Arc::new(RecordingDispatcher {
            sent: Mutex::new(Vec::new()),
        })
    }

    fn take(&self) -> Vec<PushDispatch> {
        std::mem::take(&mut *self.sent.lock().unwrap())
    }
}

#[async_trait::async_trait]
impl PushDispatcher for RecordingDispatcher {
    async fn dispatch(&self, dispatch: &PushDispatch) -> DispatchOutcome {
        self.sent.lock().unwrap().push(dispatch.clone());
        DispatchOutcome::Accepted {
            apns_status: 200,
            apns_reason: None,
        }
    }
}

/// A registered iPhone for `member`.
async fn give_device(su: &PgPool, workspace: Uuid, member: Uuid) {
    let device = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO device (id, workspace_id, member_id, platform) \
         VALUES ($1, $2, $3, 'ios'::device_platform)",
    )
    .bind(device)
    .bind(workspace)
    .bind(member)
    .execute(su)
    .await
    .expect("seed device");
    sqlx::query(
        "INSERT INTO push_token (workspace_id, device_id, member_id, apns_token, env, topic) \
         VALUES ($1, $2, $3, $4, 'sandbox'::push_env, 'kim.dawn.momo.e2e')",
    )
    .bind(workspace)
    .bind(device)
    .bind(member)
    .bind(Uuid::new_v4().simple().to_string().repeat(2))
    .execute(su)
    .await
    .expect("seed push token");
}

/// A message in `channel` that mentions `mentioned` — the same `props.mention_member_ids`
/// projection the real send path writes. The insert fires the 011 trigger, which enqueues one
/// push candidate.
async fn mention(
    su: &PgPool,
    workspace: Uuid,
    channel: Uuid,
    author: Uuid,
    mentioned: Uuid,
    seq: i64,
) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO message \
           (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body, props) \
         VALUES ($1, $2, $3, $3, 0, $4, 'text', 'please look', \
                 jsonb_build_object('mention_member_ids', jsonb_build_array($5::text))) \
         RETURNING id",
    )
    .bind(workspace)
    .bind(channel)
    .bind(seq)
    .bind(author)
    .bind(mentioned.to_string())
    .fetch_one(su)
    .await
    .expect("insert a mention (fires push_candidate_enqueue_trg)")
}

async fn dispatch_log_rows(su: &PgPool, workspace: Uuid, message: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM push_dispatch_log WHERE workspace_id = $1 AND message_id = $2",
    )
    .bind(workspace)
    .bind(message)
    .fetch_one(su)
    .await
    .expect("count dispatch log")
}

/// The drain claims across every tenant, so park any candidate this test does not own. It only
/// reschedules; a candidate left behind by an earlier, failed run cannot add a dispatch here.
async fn focus_candidates(su: &PgPool, keep: &[Uuid]) {
    sqlx::query(
        "UPDATE outbox SET available_at = clock_timestamp() + interval '1 hour' \
          WHERE kind = 'push_candidate' AND status = 'pending' AND NOT (workspace_id = ANY($1))",
    )
    .bind(keep)
    .execute(su)
    .await
    .expect("park other fixtures' candidates");
}

/// ③ `until = now + 2 s`. A mention that arrives while the mute runs sends nothing and leaves no
/// dispatch-log row; a **new** mention three seconds later is sent once — judged lazily against
/// `now()`, with nothing in between to flip the row. (A candidate already `done` is never judged
/// again, so the second push is a second message, not the first one retried.)
#[tokio::test]
#[ignore = "requires DATABASE_URL to a real Postgres and the momo_notifier role"]
async fn a_push_candidate_after_the_end_is_sent_one_before_it_is_not() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let base = start_server(app.clone()).await;

    // Tenant A mutes through the real route; tenant B never mutes. Each has one person who
    // owns a device and one who writes to them in a DM.
    let a = seed_tenant(&su, &app).await;
    let b = seed_tenant(&su, &app).await;
    let api_a = Api::login(&base, a.workspace, &a.owner).await;
    let api_b = Api::login(&base, b.workspace, &b.owner).await;
    let (_, dm_a) = api_a.open_dm(a.peer.member).await;
    let (_, dm_b) = api_b.open_dm(b.peer.member).await;
    let (dm_a, dm_b) = (channel_id_of(&dm_a), channel_id_of(&dm_b));
    give_device(&su, a.workspace, a.owner.member).await;
    give_device(&su, b.workspace, b.owner.member).await;
    focus_candidates(&su, &[a.workspace, b.workspace]).await;

    // t0: the member mutes the DM until the database's now + 2 s.
    let until = db_now_ms(&su).await + 2_000;
    let (status, body) = api_a
        .put(dm_a, json!({"muted": true, "mutedUntilMs": until}))
        .await;
    assert_eq!(
        (status, &body),
        (200, &json!({"muted": true, "mutedUntilMs": until}))
    );

    // t0: a mention arrives in each tenant, and one drain serves both.
    let first_a = mention(&su, a.workspace, dm_a, a.peer.member, a.owner.member, 1).await;
    let first_b = mention(&su, b.workspace, dm_b, b.peer.member, b.owner.member, 1).await;
    let relay = RecordingDispatcher::new();
    let notifier = momo_notifier_pool().await;
    let drain = PushDrain::new(notifier, PushConfig::for_target(), relay.clone());
    let stats = drain.drain_once(32).await.expect("drain at t0");
    assert_eq!(
        stats.claimed, 2,
        "both candidates were produced and consumed"
    );

    let sent = relay.take();
    assert_eq!(
        sent.iter()
            .map(|d| d.message_id.clone())
            .collect::<Vec<_>>(),
        vec![first_b.to_string()],
        "while the mute runs, A hears nothing; B's unmuted mention is the only push: {sent:?}"
    );
    assert_eq!(
        dispatch_log_rows(&su, a.workspace, first_a).await,
        0,
        "a suppressed target leaves no push_dispatch_log row (ADR-0124 D2)"
    );
    assert_eq!(dispatch_log_rows(&su, b.workspace, first_b).await, 1);

    // t0 + 3 s, with no sleep: the stored end moves three seconds earlier, which is the database
    // clock three seconds later. Only the timestamp moves — the row is still there, still a mute row.
    sqlx::query(
        "UPDATE notification_pref SET muted_until = muted_until - interval '3 seconds' \
          WHERE workspace_id = $1 AND member_id = $2 AND channel_id = $3",
    )
    .bind(a.workspace)
    .bind(a.owner.member)
    .bind(dm_a)
    .execute(&su)
    .await
    .expect("three seconds pass");
    let lapsed: bool = sqlx::query_scalar(
        "SELECT muted_until < now() FROM notification_pref \
          WHERE workspace_id = $1 AND member_id = $2 AND channel_id = $3",
    )
    .bind(a.workspace)
    .bind(a.owner.member)
    .bind(dm_a)
    .fetch_one(&su)
    .await
    .expect("the row is still there");
    assert!(lapsed, "the end is now behind the database clock");

    // A new mention at t0 + 3 s is judged against the clock as it is now.
    let second_a = mention(&su, a.workspace, dm_a, a.peer.member, a.owner.member, 2).await;
    let stats = drain.drain_once(32).await.expect("drain at t0 + 3 s");
    assert_eq!(stats.claimed, 1);
    let sent = relay.take();
    assert_eq!(
        sent.iter()
            .map(|d| d.message_id.clone())
            .collect::<Vec<_>>(),
        vec![second_a.to_string()],
        "after the end the new mention is pushed, once: {sent:?}"
    );
    assert_eq!(sent[0].reason, "mention");
    assert_eq!(sent[0].workspace_id, a.workspace.to_string());
    assert_eq!(dispatch_log_rows(&su, a.workspace, second_a).await, 1);
    assert_eq!(
        dispatch_log_rows(&su, a.workspace, first_a).await,
        0,
        "the mention that came during the mute stays unsent: it is not judged a second time"
    );
}
