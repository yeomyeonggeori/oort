//! #4227 / ADR-0177 증보 (D6·D7·D8·D9·D10) — DM closure on a real Postgres.
//!
//! `PUT|DELETE /v1/workspaces/{ws}/channels/{ch}/closure`, the two additions to `GET read-state`
//! (`latest_readable_seq`, the caller's own `closed_at_seq`), and the `last_readable_seq` trigger.
//! The ADR's 수용 기준 (red proof) 1~8, each with its sabotage in the table at the bottom of this
//! header:
//!
//! | # | proof | test |
//! |---|---|---|
//! | 1 | tenant — another workspace's rows are invisible (negative **and** positive assertions) | `a_closure_is_invisible_to_another_workspace` |
//! | 2 | member boundary — A's closure is `null` in B's projection, and B cannot reopen A's | `a_closure_is_only_the_requesters` |
//! | 3 | agent — a bearer carrying every scope is 403 on both verbs (layer 1; layer 2 is `dm_closure_gates.rs`) | `an_agent_bearer_cannot_close_or_reopen_a_dm` |
//! | 4 | 404 — not-a-participant, archived, left, public, private, unknown id, other workspace; PUT and DELETE | `closure_on_anything_but_a_live_dm_of_the_caller_is_404` |
//! | 5 | watermark — a message between projection and PUT is not buried; a late retransmit lowers nothing; a repeat is the same row | `the_watermark_is_the_clients_seen_seq_and_only_moves_forward` |
//! | 6 | trigger — machine shapes raise nothing, readable shapes (incl. no `kind`) do; read from the golden | `the_trigger_follows_the_golden_shape_by_shape` |
//! | 7 | backfill | `dm_closure_backfill_pg.rs` |
//! | 8 | golden — `core` and `trigger` columns | `the_trigger_follows_the_golden_shape_by_shape` + the core vitest + `momo-messaging/tests/dm_readable_golden.rs` |
//!
//! Beyond the ADR's list (each one is a way the first six could be green while the feature is wrong):
//! `machine_messages_do_not_revive_but_readable_ones_do` (the D8 numbers a client compares),
//! `read_state_rows_carry_both_fields_and_the_put_response_does_not` (the wire contract, D10: no
//! outbox row), `the_catalog_registers_dm_closure_as_a_forced_rls_tenant_table`.
//!
//! **Assertions are values, not shapes.** Where a proof says "invisible" there is a control that the
//! row exists; where it says "403" there is a control that the same bearer works elsewhere.
//!
//! `#[ignore]` — needs a real Postgres (pgvector/pg18). Gate PG:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:20252/momo \
//!   cargo test -p momo-server --test dm_closure_conformance_pg \
//!   -- --ignored --test-threads=1 --nocapture
//! ```

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx;
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::{with_tenant_tx, DbError, PgPool};
use momo_messaging::{send_message_in_tx, MessageType, NewMessage};
use momo_server::{build_app, AppState};
use serde_json::{json, Value};
use uuid::Uuid;

/// The same bytes the web vitest reads (`clients/web/.../ambientMessage.golden.test.ts`): one file, no copy.
const GOLDEN: &str = include_str!("../../../../docs/api/dm-readable-message.golden.json");

async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

const TEST_JWT_SECRET: &str = "dm-closure-conformance-signing-secret";
const TEST_PASSWORD: &str = "dm-closure-test-password";
const AGENT_NOT_ALLOWED: &str = "agent bearer is not allowed for this route";

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

fn momo_app_options() -> PgConnectOptions {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    options.username("momo_app").password(&momo_app_password())
}

async fn momo_app_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(momo_app_options())
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
    let mut ready = READY.lock().expect("schema lock");
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all migrations");
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
    *ready = true;
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

struct World {
    su: PgPool,
    app: PgPool,
    base: String,
    http: reqwest::Client,
}

#[derive(Clone)]
struct Person {
    id: Uuid,
    token: String,
}

impl World {
    async fn new() -> World {
        ensure_schema_and_roles();
        let su = superuser_pool().await;
        let app = momo_app_pool().await;
        let router = build_app(AppState::new(
            app.clone(),
            TEST_JWT_SECRET.to_string(),
            "ws://127.0.0.1:8000/connection/websocket".to_string(),
        ));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind momo-server");
        let address: SocketAddr = listener.local_addr().expect("server address");
        tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });
        World {
            su,
            app,
            base: format!("http://{address}"),
            http: reqwest::Client::new(),
        }
    }

    async fn workspace(&self, hint: &str) -> Uuid {
        let workspace = Uuid::new_v4();
        sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
            .bind(workspace)
            .bind(format!("{hint}-{workspace}"))
            .execute(&self.su)
            .await
            .expect("seed workspace");
        workspace
    }

    /// A human who can log in, with a ready bearer.
    async fn human(&self, workspace: Uuid, label: &str) -> Person {
        let id = Uuid::new_v4();
        let handle = format!("{label}-{}", &id.simple().to_string()[..8]);
        let email = format!("{id}@dm-closure.test");
        sqlx::query(
            "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
             VALUES ($1, $2, 'human', $3, $3)",
        )
        .bind(id)
        .bind(workspace)
        .bind(&handle)
        .execute(&self.su)
        .await
        .expect("seed human member");
        sqlx::query(
            "INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash) \
             VALUES ($1, $2, $3, true, momo_password_hash($4))",
        )
        .bind(id)
        .bind(workspace)
        .bind(&email)
        .bind(TEST_PASSWORD)
        .execute(&self.su)
        .await
        .expect("seed human auth");
        sqlx::query(
            "INSERT INTO workspace_membership (workspace_id, member_id, role) \
             VALUES ($1, $2, 'member')",
        )
        .bind(workspace)
        .bind(id)
        .execute(&self.su)
        .await
        .expect("seed workspace membership");
        let response = self
            .http
            .post(format!("{}/v1/auth/login", self.base))
            .json(&json!({
                "email": email,
                "password": TEST_PASSWORD,
                "workspace": workspace.to_string(),
            }))
            .send()
            .await
            .expect("login");
        assert_eq!(response.status(), 200, "seeded human logs in");
        let body: Value = response.json().await.expect("login body");
        let token = body["accessToken"]
            .as_str()
            .expect("login returns an access token")
            .to_string();
        Person { id, token }
    }

    async fn agent(&self, workspace: Uuid, owner: Uuid) -> Uuid {
        let agent = Uuid::new_v4();
        let handle = format!("ag-{}", &agent.simple().to_string()[..8]);
        sqlx::query(
            "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
             VALUES ($1, $2, 'agent', $3, $3)",
        )
        .bind(agent)
        .bind(workspace)
        .bind(&handle)
        .execute(&self.su)
        .await
        .expect("seed agent member");
        sqlx::query(
            "INSERT INTO agent \
               (member_id, workspace_id, model, base_url, max_concurrent_runs, max_run_steps, \
                owner_human_id) \
             VALUES ($1, $2, 'hermes-agent', 'https://gateway.invalid/v1', 2, 50, $3)",
        )
        .bind(agent)
        .bind(workspace)
        .bind(owner)
        .execute(&self.su)
        .await
        .expect("seed agent");
        sqlx::query(
            "INSERT INTO workspace_membership (workspace_id, member_id, role) \
             VALUES ($1, $2, 'member')",
        )
        .bind(workspace)
        .bind(agent)
        .execute(&self.su)
        .await
        .expect("seed agent membership");
        agent
    }

    /// A channel of `kind` with its `channel_seq` row. DMs carry a unique `dm_key`, others a name.
    async fn channel(&self, workspace: Uuid, kind: &str, creator: Uuid, archived: bool) -> Uuid {
        let channel = Uuid::new_v4();
        if kind == "dm" {
            sqlx::query(
                "INSERT INTO channel (id, workspace_id, kind, dm_key, created_by) \
                 VALUES ($1, $2, 'dm', $3, $4)",
            )
            .bind(channel)
            .bind(workspace)
            .bind(format!("t4227-{channel}"))
            .bind(creator)
            .execute(&self.su)
            .await
            .expect("seed dm channel");
        } else {
            sqlx::query(
                "INSERT INTO channel (id, workspace_id, kind, name, topic, created_by) \
                 VALUES ($1, $2, $3::channel_kind, $4, '', $5)",
            )
            .bind(channel)
            .bind(workspace)
            .bind(kind)
            .bind(format!("ch-{}", &channel.simple().to_string()[..8]))
            .bind(creator)
            .execute(&self.su)
            .await
            .expect("seed channel");
        }
        sqlx::query(
            "INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)",
        )
        .bind(channel)
        .bind(workspace)
        .execute(&self.su)
        .await
        .expect("seed channel_seq");
        if archived {
            sqlx::query("UPDATE channel SET archived_at = now() WHERE id = $1")
                .bind(channel)
                .execute(&self.su)
                .await
                .expect("archive channel");
        }
        channel
    }

    async fn join(&self, workspace: Uuid, channel: Uuid, member: Uuid) {
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)",
        )
        .bind(workspace)
        .bind(channel)
        .bind(member)
        .execute(&self.su)
        .await
        .expect("seed membership");
    }

    async fn dm(&self, workspace: Uuid, members: &[Uuid], archived: bool) -> Uuid {
        let channel = self.channel(workspace, "dm", members[0], archived).await;
        for member in members {
            self.join(workspace, channel, *member).await;
        }
        channel
    }

    /// A message through the production send path (`send_message_in_tx`: the seq bump and the INSERT
    /// are one statement, so the trigger fires exactly as it does for a real send), under the
    /// RLS-bound `momo_app` pool.
    async fn send(
        &self,
        workspace: Uuid,
        channel: Uuid,
        author: Uuid,
        message_type: MessageType,
        props: Value,
    ) -> i64 {
        with_tenant_tx(&self.app, workspace, move |conn| {
            Box::pin(async move {
                let mut input = NewMessage::text(channel, author, "골든 모양");
                input.message_type = message_type;
                input.props = props;
                input.client_msg_id = Some(Uuid::new_v4());
                Ok(send_message_in_tx(conn, workspace, input)
                    .await?
                    .message
                    .seq)
            })
        })
        .await
        .expect("send a message")
    }

    async fn say(&self, workspace: Uuid, channel: Uuid, author: Uuid) -> i64 {
        self.send(workspace, channel, author, MessageType::Text, json!({}))
            .await
    }

    fn closure_url(&self, workspace: Uuid, channel: impl std::fmt::Display) -> String {
        format!(
            "{}/v1/workspaces/{workspace}/channels/{channel}/closure",
            self.base
        )
    }

    async fn put_closure(
        &self,
        who: &Person,
        workspace: Uuid,
        channel: impl std::fmt::Display,
        seen_seq: i64,
    ) -> (u16, String) {
        error_status_message(
            self.http
                .put(self.closure_url(workspace, channel))
                .bearer_auth(&who.token)
                .json(&json!({ "seenSeq": seen_seq }))
                .send()
                .await
                .expect("PUT closure"),
        )
        .await
    }

    async fn delete_closure(
        &self,
        who: &Person,
        workspace: Uuid,
        channel: impl std::fmt::Display,
    ) -> (u16, String) {
        error_status_message(
            self.http
                .delete(self.closure_url(workspace, channel))
                .bearer_auth(&who.token)
                .send()
                .await
                .expect("DELETE closure"),
        )
        .await
    }

    /// The caller's `GET read-state` rows.
    async fn rows(&self, who: &Person, workspace: Uuid) -> Vec<Value> {
        let response = self
            .http
            .get(format!(
                "{}/v1/workspaces/{workspace}/read-state",
                self.base
            ))
            .bearer_auth(&who.token)
            .send()
            .await
            .expect("GET read-state");
        assert_eq!(response.status(), 200, "GET read-state is 200");
        let body: Value = response.json().await.expect("read-state body");
        body["read_states"]
            .as_array()
            .expect("read_states is an array")
            .clone()
    }

    async fn row(&self, who: &Person, workspace: Uuid, channel: Uuid) -> Value {
        let id = channel.to_string();
        self.rows(who, workspace)
            .await
            .into_iter()
            .find(|row| row["channel_id"].as_str().map(str::to_lowercase) == Some(id.clone()))
            .unwrap_or_else(|| panic!("no read-state row for channel {channel}"))
    }

    /// Straight from the table, as the superuser: what is actually stored.
    async fn stored(&self, member: Uuid, channel: Uuid) -> Option<(i64, f64)> {
        sqlx::query_as::<_, (i64, f64)>(
            "SELECT closed_at_seq, extract(epoch FROM closed_at)::float8 \
               FROM dm_closure WHERE member_id = $1 AND channel_id = $2",
        )
        .bind(member)
        .bind(channel)
        .fetch_optional(&self.su)
        .await
        .expect("read dm_closure")
    }

    async fn stored_count(&self, member: Uuid) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM dm_closure WHERE member_id = $1")
            .bind(member)
            .fetch_one(&self.su)
            .await
            .expect("count dm_closure")
    }

    async fn readable_head(&self, channel: Uuid) -> i64 {
        sqlx::query_scalar("SELECT last_readable_seq FROM channel_seq WHERE channel_id = $1")
            .bind(channel)
            .fetch_one(&self.su)
            .await
            .expect("read last_readable_seq")
    }

    async fn outbox_rows(&self, workspace: Uuid) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM outbox WHERE workspace_id = $1")
            .bind(workspace)
            .fetch_one(&self.su)
            .await
            .expect("count outbox")
    }
}

async fn error_status_message(response: reqwest::Response) -> (u16, String) {
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or_else(|_| json!({}));
    let message = body["error"]["message"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    (status, message)
}

// ---------------------------------------------------------------------------
// 1. tenant
// ---------------------------------------------------------------------------

/// Count `dm_closure` rows matching `predicate` as the RLS-bound app role inside `workspace`'s
/// tenant transaction.
async fn count_in_tenant(app: &PgPool, workspace: Uuid, predicate: &str, other: Uuid) -> i64 {
    let sql = format!("SELECT count(*) FROM dm_closure WHERE {predicate}");
    with_tenant_tx(app, workspace, move |conn| {
        Box::pin(async move {
            let n: i64 = sqlx::query_scalar(&sql)
                .bind(other)
                .fetch_one(&mut *conn)
                .await
                .map_err(DbError::from)?;
            Ok(n)
        })
    })
    .await
    .expect("count in tenant tx")
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_closure_is_invisible_to_another_workspace() {
    let _guard = test_lock().await;
    let w = World::new().await;
    let ws_a = w.workspace("tenant-a").await;
    let ws_b = w.workspace("tenant-b").await;
    let a1 = w.human(ws_a, "a1").await;
    let a2 = w.human(ws_a, "a2").await;
    let b1 = w.human(ws_b, "b1").await;
    let b2 = w.human(ws_b, "b2").await;
    let dm_a = w.dm(ws_a, &[a1.id, a2.id], false).await;
    let dm_b = w.dm(ws_b, &[b1.id, b2.id], false).await;
    w.say(ws_a, dm_a, a2.id).await;
    w.say(ws_b, dm_b, b2.id).await;
    assert_eq!(w.put_closure(&a1, ws_a, dm_a, 1).await.0, 204);
    assert_eq!(w.put_closure(&b1, ws_b, dm_b, 1).await.0, 204);

    // Positive: inside its own tenant transaction each workspace sees its own row...
    assert_eq!(
        count_in_tenant(&w.app, ws_a, "workspace_id = $1", ws_a).await,
        1,
        "A sees A's closure"
    );
    assert_eq!(
        count_in_tenant(&w.app, ws_b, "workspace_id = $1", ws_b).await,
        1,
        "B sees B's closure"
    );
    // ...negative: and none of the other's. Same predicate shape, the other workspace's id.
    assert_eq!(
        count_in_tenant(&w.app, ws_a, "workspace_id = $1", ws_b).await,
        0,
        "A must not see B's closure"
    );
    assert_eq!(
        count_in_tenant(&w.app, ws_b, "workspace_id = $1", ws_a).await,
        0,
        "B must not see A's closure"
    );
    // Not filtering by workspace at all is still only the own rows: the policy, not the predicate,
    // is what separates the tenants.
    assert_eq!(
        count_in_tenant(&w.app, ws_a, "$1::uuid IS NOT NULL", ws_a).await,
        1,
        "an unfiltered read in A's transaction returns only A's row"
    );

    // No tenant GUC at all (a fresh connection that never SET one) sees nothing: the policy compares
    // against NULL.
    let mut bare = <momo_db::sqlx::postgres::PgConnection as sqlx::Connection>::connect_with(
        &momo_app_options(),
    )
    .await
    .expect("connect as momo_app");
    let bare_count: i64 = sqlx::query_scalar("SELECT count(*) FROM dm_closure")
        .fetch_one(&mut bare)
        .await
        .expect("count without a tenant");
    assert_eq!(bare_count, 0, "no tenant, no rows");

    // Writes: A's transaction cannot plant a row in B's workspace (WITH CHECK) and cannot delete B's.
    let plant = with_tenant_tx(&w.app, ws_a, move |conn| {
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO dm_closure (workspace_id, member_id, channel_id, closed_at_seq) \
                 VALUES ($1, $2, $3, 0)",
            )
            .bind(ws_b)
            .bind(b2.id)
            .bind(dm_b)
            .execute(&mut *conn)
            .await
            .map_err(DbError::from)?;
            Ok(())
        })
    })
    .await;
    assert!(
        plant.is_err(),
        "WITH CHECK refuses a row for another workspace"
    );
    let deleted = with_tenant_tx(&w.app, ws_a, move |conn| {
        Box::pin(async move {
            let done = sqlx::query("DELETE FROM dm_closure WHERE workspace_id = $1")
                .bind(ws_b)
                .execute(&mut *conn)
                .await
                .map_err(DbError::from)?;
            Ok(done.rows_affected())
        })
    })
    .await
    .expect("delete in tenant tx");
    assert_eq!(deleted, 0, "A's transaction deletes none of B's rows");
    assert!(
        w.stored(b1.id, dm_b).await.is_some(),
        "control: B's row is still there after A's attempts"
    );
}

// ---------------------------------------------------------------------------
// 2. member boundary
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_closure_is_only_the_requesters() {
    let _guard = test_lock().await;
    let w = World::new().await;
    let ws = w.workspace("member-boundary").await;
    let a = w.human(ws, "a").await;
    let b = w.human(ws, "b").await;
    let public = w.channel(ws, "public", a.id, false).await;
    w.join(ws, public, a.id).await;
    w.join(ws, public, b.id).await;
    let dm = w.dm(ws, &[a.id, b.id], false).await;
    for _ in 0..3 {
        w.say(ws, dm, b.id).await;
    }

    assert_eq!(w.put_closure(&a, ws, dm, 3).await.0, 204);
    let seen_by_a = w.row(&a, ws, dm).await;
    let seen_by_b = w.row(&b, ws, dm).await;
    assert_eq!(seen_by_a["closed_at_seq"], 3, "A sees A's own closure");
    assert!(
        seen_by_b.get("closed_at_seq").is_some(),
        "the key is present for B, not omitted: {seen_by_b}"
    );
    assert!(
        seen_by_b["closed_at_seq"].is_null(),
        "A's closure must be null in B's projection: {seen_by_b}"
    );

    // B closes at a different watermark: each projection carries only its own.
    assert_eq!(w.put_closure(&b, ws, dm, 2).await.0, 204);
    assert_eq!(w.row(&a, ws, dm).await["closed_at_seq"], 3);
    assert_eq!(w.row(&b, ws, dm).await["closed_at_seq"], 2);
    assert_eq!(
        w.rows(&b, ws)
            .await
            .iter()
            .filter(|row| row["channel_id"].as_str().map(str::to_lowercase) == Some(dm.to_string()))
            .count(),
        1,
        "two closers must not duplicate the row in a projection"
    );
    assert!(
        w.stored(a.id, dm).await.is_some() && w.stored(b.id, dm).await.is_some(),
        "two separate rows"
    );

    // A reopening drops only A's row.
    assert_eq!(w.delete_closure(&a, ws, dm).await.0, 204);
    assert!(w.row(&a, ws, dm).await["closed_at_seq"].is_null());
    assert_eq!(
        w.row(&b, ws, dm).await["closed_at_seq"],
        2,
        "B's closure survives A's reopen"
    );
    assert!(
        w.stored(b.id, dm).await.is_some(),
        "B's row is still stored after A's DELETE"
    );

    // A channel that is not a DM never carries a closure for anyone.
    assert!(w.row(&a, ws, public).await["closed_at_seq"].is_null());
    assert!(w.row(&b, ws, public).await["closed_at_seq"].is_null());
}

// ---------------------------------------------------------------------------
// 3. agents (layer one: the route-shape gate, with a real bearer)
// ---------------------------------------------------------------------------

async fn agent_bearer(su: &PgPool, workspace: Uuid, agent: Uuid, scopes: &[&str]) -> String {
    let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token = format!("momo_agent_v1.{workspace}.{secret}");
    let scopes: Vec<String> = scopes.iter().map(|s| s.to_string()).collect();
    sqlx::query(
        "INSERT INTO token (workspace_id, kind, actor_member_id, subject_member_id, \
                            token_hash, scopes, label) \
         VALUES ($1, 'agent_bearer', $2, NULL, digest($3::text, 'sha256'), $4::text[], \
                 'dm-closure-conformance')",
    )
    .bind(workspace)
    .bind(agent)
    .bind(&token)
    .bind(&scopes)
    .execute(su)
    .await
    .expect("seed agent bearer");
    token
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_agent_bearer_cannot_close_or_reopen_a_dm() {
    let _guard = test_lock().await;
    let w = World::new().await;
    let ws = w.workspace("agent-gate").await;
    let owner = w.human(ws, "owner").await;
    let agent = w.agent(ws, owner.id).await;
    // The agent is a live participant of this DM: were the gate missing, the write would succeed.
    let dm = w.dm(ws, &[owner.id, agent], false).await;
    w.say(ws, dm, owner.id).await;

    // The widest set of agent scopes the table names. No scope opens the closure path.
    let every_scope = [
        "messages:write",
        "messages:read",
        "agent:jobs:read",
        "agent:runs:callback",
        "work:control",
    ];
    let bearer = agent_bearer(&w.su, ws, agent, &every_scope).await;
    let unknown = format!(
        "momo_agent_v1.{ws}.{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    );

    for (label, token) in [("a real bearer", &bearer), ("an unknown one", &unknown)] {
        let put = error_status_message(
            w.http
                .put(w.closure_url(ws, dm))
                .bearer_auth(token)
                .json(&json!({"seenSeq": 1}))
                .send()
                .await
                .expect("agent PUT"),
        )
        .await;
        assert_eq!(put.0, 403, "{label} PUT: {}", put.1);
        assert_eq!(
            put.1, AGENT_NOT_ALLOWED,
            "{label} PUT: refused for the route"
        );
        let delete = error_status_message(
            w.http
                .delete(w.closure_url(ws, dm))
                .bearer_auth(token)
                .send()
                .await
                .expect("agent DELETE"),
        )
        .await;
        assert_eq!(delete.0, 403, "{label} DELETE: {}", delete.1);
        assert_eq!(
            delete.1, AGENT_NOT_ALLOWED,
            "{label} DELETE: refused for the route"
        );
    }
    assert_eq!(
        w.stored_count(agent).await,
        0,
        "a refused agent wrote nothing"
    );
    assert_eq!(w.stored_count(owner.id).await, 0);

    // Control: the same bearer is valid — it posts a message in that DM (an open route) — so the
    // refusals above are the route's, not a bad credential's.
    let posted = w
        .http
        .post(format!(
            "{}/v1/workspaces/{ws}/channels/{dm}/messages",
            w.base
        ))
        .bearer_auth(&bearer)
        .json(&json!({"clientMsgId": Uuid::new_v4(), "body": "에이전트의 보통 답"}))
        .send()
        .await
        .expect("agent POST message");
    assert_eq!(posted.status(), 201, "the bearer works on an open route");
    // ...and that readable agent message is exactly the kind D9 counts (an agent's ordinary reply).
    assert!(
        w.readable_head(dm).await >= 2,
        "an agent's ordinary reply raises last_readable_seq"
    );
}

// ---------------------------------------------------------------------------
// 4. 404
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn closure_on_anything_but_a_live_dm_of_the_caller_is_404() {
    let _guard = test_lock().await;
    let w = World::new().await;
    let ws = w.workspace("not-found").await;
    let other_ws = w.workspace("not-found-other").await;
    let a = w.human(ws, "a").await;
    let b = w.human(ws, "b").await;
    let c = w.human(ws, "c").await;
    let stranger = w.human(other_ws, "stranger").await;

    let live = w.dm(ws, &[a.id, b.id], false).await;
    w.say(ws, live, b.id).await;

    let outsider = w.dm(ws, &[b.id, c.id], false).await; // A is not a participant
    let archived = w.dm(ws, &[a.id, c.id], true).await; // A is, but it is archived
    let left = w.dm(ws, &[a.id, c.id], false).await; // A left it
    sqlx::query("UPDATE membership SET left_at = now() WHERE channel_id = $1 AND member_id = $2")
        .bind(left)
        .bind(a.id)
        .execute(&w.su)
        .await
        .expect("A leaves");
    let public = w.channel(ws, "public", a.id, false).await; // a channel A is in
    w.join(ws, public, a.id).await;
    let private = w.channel(ws, "private", a.id, false).await;
    w.join(ws, private, a.id).await;
    let elsewhere = w.dm(other_ws, &[stranger.id], false).await; // another workspace's DM
    let ghost = Uuid::new_v4(); // names nothing

    // A pre-existing row on the archived DM: the route must refuse before it touches it.
    sqlx::query(
        "INSERT INTO dm_closure (workspace_id, member_id, channel_id, closed_at_seq) \
         VALUES ($1, $2, $3, 0)",
    )
    .bind(ws)
    .bind(a.id)
    .bind(archived)
    .execute(&w.su)
    .await
    .expect("seed a row on the archived DM");

    let cases = [
        ("a DM A is not part of", outsider),
        ("an archived DM A is part of", archived),
        ("a DM A has left", left),
        ("a public channel A is in", public),
        ("a private channel A is in", private),
        ("another workspace's DM", elsewhere),
        ("an id that names nothing", ghost),
    ];
    for (label, channel) in cases {
        let put = w.put_closure(&a, ws, channel, 1).await;
        assert_eq!(put.0, 404, "PUT on {label}: {}", put.1);
        assert_eq!(
            put.1, "dm not found",
            "PUT on {label}: one answer for all of them"
        );
        let delete = w.delete_closure(&a, ws, channel).await;
        assert_eq!(delete.0, 404, "DELETE on {label}: {}", delete.1);
        assert_eq!(delete.1, "dm not found", "DELETE on {label}");
    }
    assert_eq!(
        w.stored_count(a.id).await,
        1,
        "only the pre-seeded row exists: no refused PUT wrote anything and no refused DELETE removed it"
    );
    assert!(w.stored(a.id, archived).await.is_some());

    // Control: the same caller, same verbs, on the one live DM — so the 404s are about the channel.
    assert_eq!(w.put_closure(&a, ws, live, 1).await.0, 204, "control PUT");
    assert!(w.stored(a.id, live).await.is_some());
    assert_eq!(
        w.delete_closure(&a, ws, live).await.0,
        204,
        "control DELETE"
    );
    assert!(w.stored(a.id, live).await.is_none());
    // DELETE of a DM that was never closed is 204 as well (the end state is what was asked for).
    assert_eq!(
        w.delete_closure(&a, ws, live).await.0,
        204,
        "idempotent DELETE"
    );
}

// ---------------------------------------------------------------------------
// 5. watermark
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_watermark_is_the_clients_seen_seq_and_only_moves_forward() {
    let _guard = test_lock().await;
    let w = World::new().await;
    let ws = w.workspace("watermark").await;
    let a = w.human(ws, "a").await;
    let b = w.human(ws, "b").await;
    let dm = w.dm(ws, &[a.id, b.id], false).await;
    for _ in 0..3 {
        w.say(ws, dm, b.id).await;
    }

    // A looks at the projection: the head it saw is 3.
    let projection = w.row(&a, ws, dm).await;
    let seen = projection["latest_seq"].as_i64().expect("latest_seq");
    assert_eq!(seen, 3);

    // A message arrives between the projection and A's PUT. It is above `seenSeq`, so it must not
    // be buried: the stored watermark is what A *saw* (3), not the head at PUT time (4).
    assert_eq!(w.say(ws, dm, b.id).await, 4);
    assert_eq!(w.put_closure(&a, ws, dm, seen).await.0, 204);
    assert_eq!(
        w.stored(a.id, dm).await.expect("row").0,
        3,
        "watermark = what A saw"
    );
    let after = w.row(&a, ws, dm).await;
    assert_eq!(after["closed_at_seq"], 3);
    assert_eq!(after["latest_readable_seq"], 4);
    assert!(
        after["latest_readable_seq"].as_i64() > after["closed_at_seq"].as_i64(),
        "the message that landed between projection and PUT is still ahead of the watermark"
    );

    // A late retransmit of the same seenSeq, after more traffic, erases nothing.
    assert_eq!(w.say(ws, dm, b.id).await, 5);
    let before_retransmit = w.stored(a.id, dm).await.expect("row");
    assert_eq!(w.put_closure(&a, ws, dm, seen).await.0, 204);
    let after_retransmit = w.stored(a.id, dm).await.expect("row");
    assert_eq!(
        after_retransmit.0, 3,
        "a retransmit does not jump to the head"
    );
    assert_eq!(
        after_retransmit.1, before_retransmit.1,
        "an identical PUT leaves the row (including closed_at) untouched"
    );
    assert!(
        w.row(&a, ws, dm).await["latest_readable_seq"].as_i64()
            > w.row(&a, ws, dm).await["closed_at_seq"].as_i64(),
        "messages 4 and 5 are still ahead"
    );

    // Moving forward works, moves closed_at, and an OLDER retransmit then lowers nothing.
    assert_eq!(w.put_closure(&a, ws, dm, 5).await.0, 204);
    let advanced = w.stored(a.id, dm).await.expect("row");
    assert_eq!(advanced.0, 5);
    assert!(
        advanced.1 > after_retransmit.1,
        "closed_at moves when the watermark does"
    );
    assert_eq!(w.put_closure(&a, ws, dm, 3).await.0, 204);
    assert_eq!(
        w.stored(a.id, dm).await.expect("row").0,
        5,
        "an older retransmit must not lower the watermark"
    );

    // The same PUT twice: same response, same row.
    let first = w.put_closure(&a, ws, dm, 5).await;
    let second = w.put_closure(&a, ws, dm, 5).await;
    assert_eq!(first, second, "the same PUT gets the same answer");
    assert_eq!(w.stored(a.id, dm).await.expect("row").0, 5);

    // A watermark past the head is clamped to the head: it must not hide the next message.
    assert_eq!(w.put_closure(&a, ws, dm, 1_000_000).await.0, 204);
    assert_eq!(
        w.stored(a.id, dm).await.expect("row").0,
        5,
        "seenSeq above last_seq is clamped to last_seq"
    );
    assert_eq!(w.say(ws, dm, b.id).await, 6);
    let next = w.row(&a, ws, dm).await;
    assert!(
        next["latest_readable_seq"].as_i64() > next["closed_at_seq"].as_i64(),
        "the next message is ahead of the clamped watermark: {next}"
    );

    // seenSeq = 0 is a legal watermark on a DM nothing has been seen in.
    let fresh = w.dm(ws, &[a.id, b.id], false).await;
    assert_eq!(w.put_closure(&a, ws, fresh, 0).await.0, 204);
    assert_eq!(w.stored(a.id, fresh).await.expect("row").0, 0);

    // The table refuses a negative watermark even if a route bug let one through.
    let negative = sqlx::query(
        "INSERT INTO dm_closure (workspace_id, member_id, channel_id, closed_at_seq) \
         VALUES ($1, $2, $3, -1) ON CONFLICT (member_id, channel_id) DO UPDATE SET closed_at_seq = -1",
    )
    .bind(ws)
    .bind(b.id)
    .bind(dm)
    .execute(&w.su)
    .await;
    assert!(negative.is_err(), "CHECK (closed_at_seq >= 0)");
}

// ---------------------------------------------------------------------------
// 6 + 8. the trigger, shape by shape, from the golden
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_trigger_follows_the_golden_shape_by_shape() {
    let _guard = test_lock().await;
    let w = World::new().await;
    let ws = w.workspace("trigger").await;
    let a = w.human(ws, "a").await;
    let b = w.human(ws, "b").await;
    let dm = w.dm(ws, &[a.id, b.id], false).await;
    assert_eq!(w.readable_head(dm).await, 0, "a fresh channel reads 0");

    // First, the real REST send spine with an ordinary message that has no props at all — the
    // shape most messages have, and the one a `<>` comparison silently drops.
    let response = w
        .http
        .post(format!(
            "{}/v1/workspaces/{ws}/channels/{dm}/messages",
            w.base
        ))
        .bearer_auth(&b.token)
        .json(&json!({"clientMsgId": Uuid::new_v4(), "body": "보통 메시지"}))
        .send()
        .await
        .expect("REST send");
    assert_eq!(response.status(), 201);
    let sent: Value = response.json().await.expect("send body");
    let rest_seq = sent["seq"].as_i64().expect("the send response carries seq");
    assert_eq!(
        w.readable_head(dm).await,
        rest_seq,
        "an ordinary REST send raises last_readable_seq to its own seq"
    );

    let golden: Value = serde_json::from_str(GOLDEN).expect("the golden file is JSON");
    let shapes = golden["shapes"].as_array().expect("shapes");
    let mut checked = 0;
    for shape in shapes {
        let name = shape["name"].as_str().expect("name");
        let expected = shape["trigger"].as_str().expect("trigger");
        if expected == "n/a(insert-time)" {
            continue;
        }
        let message_type = MessageType::from_db_label(shape["type"].as_str().expect("type"))
            .unwrap_or_else(|| panic!("{name}: unknown message type"));
        let before = w.readable_head(dm).await;
        let seq = w
            .send(ws, dm, b.id, message_type, shape["props"].clone())
            .await;
        let after = w.readable_head(dm).await;
        match expected {
            "readable" => assert_eq!(
                after, seq,
                "{name}: a readable shape raises last_readable_seq to its seq"
            ),
            "ambient" => assert_eq!(
                after, before,
                "{name}: a machine shape raises nothing (seq {seq} is a machine message)"
            ),
            other => panic!("{name}: unknown trigger expectation {other}"),
        }
        checked += 1;
    }
    assert!(checked >= 10, "the golden lost shapes: {checked}");

    // The head counts everything, the readable head only the readable. End on machine lines (the
    // loop above ends on a readable shape, where the two heads coincide) and compare the projection.
    let readable_before_noise = w.readable_head(dm).await;
    w.send(ws, dm, b.id, MessageType::ToolCall, json!({})).await;
    w.send(ws, dm, b.id, MessageType::System, json!({})).await;
    let row = w.row(&a, ws, dm).await;
    assert_eq!(
        row["latest_readable_seq"], readable_before_noise,
        "machine lines left the readable head where it was: {row}"
    );
    assert_eq!(
        row["latest_seq"].as_i64().expect("latest_seq"),
        readable_before_noise + 2,
        "latest_seq counts the two machine messages, latest_readable_seq does not: {row}"
    );

    // An agent's ordinary text counts the same: authorship is not part of the rule.
    let owner_ws = w.workspace("trigger-agent").await;
    let owner = w.human(owner_ws, "owner").await;
    let agent = w.agent(owner_ws, owner.id).await;
    let agent_dm = w.dm(owner_ws, &[owner.id, agent], false).await;
    let agent_seq = w.say(owner_ws, agent_dm, agent).await;
    assert_eq!(w.readable_head(agent_dm).await, agent_seq);

    // The known difference (golden: `deleted-text` is `n/a(insert-time)`): the core reads a deleted
    // message as machine, the trigger cannot see a delete and never lowers the value.
    let head = w.readable_head(dm).await;
    sqlx::query("UPDATE message SET state = 'deleted', deleted_at = now() WHERE channel_id = $1 AND seq = $2")
        .bind(dm)
        .bind(head)
        .execute(&w.su)
        .await
        .expect("delete the newest readable message");
    assert_eq!(
        w.readable_head(dm).await,
        head,
        "a later delete does not lower last_readable_seq (monotone; wrong only toward 'visible')"
    );
}

// ---------------------------------------------------------------------------
// D9 「단조 증가예요」: the readable head only moves forward
// ---------------------------------------------------------------------------

/// The send path hands out seqs in order, so a lower seq never arrives through it. Anything that
/// fills a hole out of order (a repair, an import, a manual fix) does arrive that way, and the
/// trigger's `GREATEST(last_readable_seq, NEW.seq)` is the only thing standing between that and a
/// readable head that moves backwards — which would hide a message the member has not read from a
/// DM they closed. Punch a hole at seq 2, fill it again, and the head must stay at 3.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_readable_head_never_moves_backwards() {
    let _guard = test_lock().await;
    let w = World::new().await;
    let ws = w.workspace("monotone").await;
    let a = w.human(ws, "a").await;
    let b = w.human(ws, "b").await;
    let dm = w.dm(ws, &[a.id, b.id], false).await;
    for _ in 0..3 {
        w.say(ws, dm, b.id).await;
    }
    assert_eq!(w.readable_head(dm).await, 3);

    sqlx::query("DELETE FROM message WHERE channel_id = $1 AND seq = 2")
        .bind(dm)
        .execute(&w.su)
        .await
        .expect("punch a hole at seq 2");
    assert_eq!(
        w.readable_head(dm).await,
        3,
        "removing a row does not lower the head either"
    );

    sqlx::query(
        "INSERT INTO message (workspace_id, channel_id, seq, hlc_ts, author_member_id, type, props) \
         VALUES ($1, $2, 2, 2, $3, 'text', '{}')",
    )
    .bind(ws)
    .bind(dm)
    .bind(b.id)
    .execute(&w.su)
    .await
    .expect("fill the hole out of order");
    assert_eq!(
        w.readable_head(dm).await,
        3,
        "a readable message below the head must not lower last_readable_seq (GREATEST)"
    );

    // Control: the same insert at a seq ABOVE the head still raises it, so the assertion above is
    // about the GREATEST and not about the trigger having stopped firing.
    sqlx::query("UPDATE channel_seq SET last_seq = 4 WHERE channel_id = $1")
        .bind(dm)
        .execute(&w.su)
        .await
        .expect("advance the head");
    sqlx::query(
        "INSERT INTO message (workspace_id, channel_id, seq, hlc_ts, author_member_id, type, props) \
         VALUES ($1, $2, 4, 4, $3, 'text', '{}')",
    )
    .bind(ws)
    .bind(dm)
    .bind(b.id)
    .execute(&w.su)
    .await
    .expect("insert above the head");
    assert_eq!(
        w.readable_head(dm).await,
        4,
        "control: the trigger still raises it"
    );
}

// ---------------------------------------------------------------------------
// the numbers a client compares (D8), and what revives a closed DM
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn machine_messages_do_not_revive_but_readable_ones_do() {
    let _guard = test_lock().await;
    let w = World::new().await;
    let ws = w.workspace("revival").await;
    let owner = w.human(ws, "owner").await;
    let agent = w.agent(ws, owner.id).await;
    let dm = w.dm(ws, &[owner.id, agent], false).await;
    w.say(ws, dm, agent).await;
    w.say(ws, dm, agent).await;

    let head = w.row(&owner, ws, dm).await["latest_seq"]
        .as_i64()
        .expect("head");
    assert_eq!(w.put_closure(&owner, ws, dm, head).await.0, 204);
    let closed = w.row(&owner, ws, dm).await;
    assert_eq!(
        closed["latest_readable_seq"], closed["closed_at_seq"],
        "closed with everything read: the watermark meets the readable head"
    );

    // An agent's work-state noise piles up after the close...
    w.send(ws, dm, agent, MessageType::ToolCall, json!({}))
        .await;
    w.send(
        ws,
        dm,
        agent,
        MessageType::Text,
        json!({"kind": "work_session"}),
    )
    .await;
    w.send(ws, dm, agent, MessageType::System, json!({})).await;
    let noisy = w.row(&owner, ws, dm).await;
    assert!(
        noisy["latest_seq"].as_i64() > closed["latest_seq"].as_i64(),
        "the head moved: {noisy}"
    );
    assert_eq!(
        noisy["latest_readable_seq"], closed["closed_at_seq"],
        "...and none of it moves the readable head past the watermark: the DM stays closed"
    );

    // ...until something readable arrives: that is the revival.
    let reply = w.say(ws, dm, agent).await;
    let revived = w.row(&owner, ws, dm).await;
    assert_eq!(revived["latest_readable_seq"], reply);
    assert!(
        revived["latest_readable_seq"].as_i64() > revived["closed_at_seq"].as_i64(),
        "a readable message past the watermark revives the DM: {revived}"
    );
    assert_eq!(
        revived["closed_at_seq"], closed["closed_at_seq"],
        "reviving writes nothing — the stored row is untouched (D8)"
    );
}

// ---------------------------------------------------------------------------
// the wire contract, D10, the catalog
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn read_state_rows_carry_both_fields_and_the_put_response_does_not() {
    let _guard = test_lock().await;
    let w = World::new().await;
    let ws = w.workspace("wire").await;
    let a = w.human(ws, "a").await;
    let b = w.human(ws, "b").await;
    let public = w.channel(ws, "public", a.id, false).await;
    w.join(ws, public, a.id).await;
    let dm = w.dm(ws, &[a.id, b.id], false).await;
    w.say(ws, public, b.id).await;
    w.say(ws, dm, b.id).await;

    // Every GET row has both keys, number and explicit null, snake_case.
    for row in w.rows(&a, ws).await {
        assert!(row["latest_readable_seq"].is_i64(), "{row}");
        assert!(row.get("closed_at_seq").is_some(), "{row}");
        assert!(
            row["closed_at_seq"].is_null(),
            "nothing is closed yet: {row}"
        );
        assert!(row.get("closedAtSeq").is_none(), "{row}");
    }
    assert_eq!(w.row(&a, ws, public).await["latest_readable_seq"], 1);

    // D10: closing and reopening emit no outbox row, no event.
    let outbox_before = w.outbox_rows(ws).await;
    for _ in 0..2 {
        assert_eq!(w.put_closure(&a, ws, dm, 1).await.0, 204);
        assert_eq!(w.delete_closure(&a, ws, dm).await.0, 204);
    }
    assert_eq!(
        w.outbox_rows(ws).await,
        outbox_before,
        "ADR-0177 D10: closure writes produce no outbox event"
    );

    // The PUT read-state response keeps its old shape: it does not say anything about closure.
    let put = w
        .http
        .put(format!(
            "{}/v1/workspaces/{ws}/channels/{dm}/read-state",
            w.base
        ))
        .bearer_auth(&a.token)
        .json(&json!({"last_read_seq": 1}))
        .send()
        .await
        .expect("PUT read-state");
    assert_eq!(put.status(), 200);
    let body: Value = put.json().await.expect("PUT read-state body");
    assert!(body.get("latest_readable_seq").is_none(), "{body}");
    assert!(body.get("closed_at_seq").is_none(), "{body}");
    assert_eq!(
        body["latest_seq"], 1,
        "the rest of the response is unchanged"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_catalog_registers_dm_closure_as_a_forced_rls_tenant_table() {
    let _guard = test_lock().await;
    let w = World::new().await;

    let (rls, forced): (bool, bool) = sqlx::query_as(
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class \
          WHERE oid = 'public.dm_closure'::regclass",
    )
    .fetch_one(&w.su)
    .await
    .expect("dm_closure in the catalog");
    assert!(
        rls && forced,
        "dm_closure is ENABLE + FORCE row level security"
    );

    let policy: (String, String) = sqlx::query_as(
        "SELECT pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid) \
           FROM pg_policy WHERE polrelid = 'public.dm_closure'::regclass AND polname = 'ws_isolation'",
    )
    .fetch_one(&w.su)
    .await
    .expect("ws_isolation policy");
    assert!(
        policy.0.contains("app.workspace_id") && policy.1.contains("app.workspace_id"),
        "the policy reads the tenant GUC in USING and WITH CHECK: {policy:?}"
    );

    // The trigger: AFTER INSERT ON message, row-level, a SECURITY INVOKER function pinned to a
    // schema-safe search_path.
    let definition: String = sqlx::query_scalar(
        "SELECT pg_get_triggerdef(oid) FROM pg_trigger \
          WHERE tgname = 'message_last_readable_seq_trg' AND NOT tgisinternal",
    )
    .fetch_one(&w.su)
    .await
    .expect("the trigger exists");
    assert!(
        definition.contains("AFTER INSERT ON public.message")
            && definition.contains("FOR EACH ROW"),
        "{definition}"
    );
    let (definer, config): (bool, Vec<String>) = sqlx::query_as(
        "SELECT prosecdef, COALESCE(proconfig, ARRAY[]::text[]) FROM pg_proc \
          WHERE proname = 'channel_seq_track_last_readable'",
    )
    .fetch_one(&w.su)
    .await
    .expect("the trigger function exists");
    assert!(
        !definer,
        "the trigger function is SECURITY INVOKER, never DEFINER"
    );
    assert!(
        config
            .iter()
            .any(|setting| setting.starts_with("search_path=")),
        "the trigger function pins its search_path: {config:?}"
    );

    let (nullable, default): (String, Option<String>) = sqlx::query_as(
        "SELECT is_nullable, column_default FROM information_schema.columns \
          WHERE table_name = 'channel_seq' AND column_name = 'last_readable_seq'",
    )
    .fetch_one(&w.su)
    .await
    .expect("last_readable_seq column");
    assert_eq!(nullable, "NO");
    assert_eq!(default.as_deref(), Some("0"));
}
