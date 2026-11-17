//! DB-backed conformance for the relay's room-floor judgment — ADR-0177 증보 D17 (#5857).
//!
//! In a 1:1 where one member has a read floor, a room frame about a message below that floor never
//! reaches the room channel: the relay publishes it to the personal channel of each live member
//! who can see the message, with the room's name added. A frame at or above every floor, and every
//! frame of a room without a floor, goes to the room exactly as before. The judgment reads only
//! the outbox row's own workspace.
//!
//! `#[ignore]`: needs a pgvector/pg18 superuser `DATABASE_URL` (same harness as
//! `relay_conformance_pg`). Run:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@127.0.0.1:<port>/momo \
//!   cargo test -p momo-relay --test room_floor_routing_pg -- --ignored --test-threads=1
//! ```
//!
//! Frames come from the real write path (send, edit, delete, reaction, pin, thread reply) where
//! the crate is reachable from here; the remaining room types are put on the outbox in the shape
//! their builders write, marked `synthetic` below.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::sqlx::{self, Executor};
use momo_db::{with_tenant_tx, PgPool};
use momo_messaging::{
    cent_channel, delete_message_in_tx, edit_message_in_tx, open_direct_message_in_tx,
    raise_history_floor_in_tx, read_state_channel, send_message, send_message_with_mentions_in_tx,
    set_pin_in_tx, set_reaction_in_tx, NewMessage, OpenedDirectMessage, PinAction, ReactionAction,
    SendExtras,
};
use momo_outbox::{emit_outbox, OutboxKind};
use momo_relay::audience::{personal_channel, ROOM_CHANNEL_KEY};
use momo_relay::{CentrifugoClient, Relay, RelayConfig};
use serde_json::{json, Value};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness (the relay_conformance_pg contract)
// ---------------------------------------------------------------------------

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

fn role_password(env_key: &str, fallback: &str) -> String {
    std::env::var(env_key).unwrap_or_else(|_| fallback.to_string())
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url())
        .await
        .expect("connect as superuser")
}

async fn role_pool(role: &str, password: String) -> PgPool {
    let options: PgConnectOptions = database_url().parse().expect("DATABASE_URL parses");
    PgPoolOptions::new()
        .max_connections(4)
        .connect_with(options.username(role).password(&password))
        .await
        .unwrap_or_else(|error| panic!("connect as {role}: {error}"))
}

async fn momo_app_pool() -> PgPool {
    role_pool(
        "momo_app",
        role_password("MOMO_APP_PASSWORD", "momo_app_dev_pw"),
    )
    .await
}

async fn momo_relay_pool() -> PgPool {
    role_pool(
        "momo_relay",
        role_password("MOMO_RELAY_PASSWORD", "momo_relay_dev_pw"),
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
    panic!("psql client not found");
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
        .args([
            "-v",
            "ON_ERROR_STOP=1",
            "--no-psqlrc",
            "--quiet",
            "--single-transaction",
            "-f",
        ])
        .arg(PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../infra/rust/sql/bootstrap_roles.sql"
        )))
        .status()
        .expect("spawn psql");
    assert!(status.success(), "bootstrap_roles.sql applies");
    *ready = true;
}

async fn relay_test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

// ---------------------------------------------------------------------------
// mock Centrifugo: publish and broadcast
// ---------------------------------------------------------------------------

/// One delivery: the channel it landed on and the `data` it carried, with the request body.
#[derive(Debug, Clone)]
struct Delivery {
    channel: String,
    data: Value,
    body: Value,
}

#[derive(Clone, Default)]
struct Mock {
    deliveries: Arc<Mutex<Vec<Delivery>>>,
}

impl Mock {
    /// Room frames delivered on `channel`: on a room channel every delivery, on a personal channel
    /// the diverted ones (the ones naming a room). The personal channel's own frames (read state,
    /// followed threads) are not this test's subject.
    fn on(&self, channel: &str) -> Vec<Delivery> {
        self.deliveries
            .lock()
            .unwrap()
            .iter()
            .filter(|d| d.channel == channel)
            .filter(|d| !channel.starts_with("user:") || d.data.get(ROOM_CHANNEL_KEY).is_some())
            .cloned()
            .collect()
    }

    fn clear(&self) {
        self.deliveries.lock().unwrap().clear();
    }
}

async fn publish(State(mock): State<Mock>, Json(body): Json<Value>) -> (StatusCode, Json<Value>) {
    mock.deliveries.lock().unwrap().push(Delivery {
        channel: body["channel"].as_str().unwrap_or_default().to_string(),
        data: body["data"].clone(),
        body: body.clone(),
    });
    (StatusCode::OK, Json(json!({"result": {}})))
}

async fn broadcast(State(mock): State<Mock>, Json(body): Json<Value>) -> (StatusCode, Json<Value>) {
    let channels: Vec<String> = body["channels"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|c| c.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let mut responses = Vec::new();
    for channel in channels {
        mock.deliveries.lock().unwrap().push(Delivery {
            channel,
            data: body["data"].clone(),
            body: body.clone(),
        });
        responses.push(json!({"result": {}}));
    }
    (
        StatusCode::OK,
        Json(json!({"result": {"responses": responses}})),
    )
}

async fn start_mock() -> (Mock, String) {
    let mock = Mock::default();
    let app = Router::new()
        .route("/api/publish", post(publish))
        .route("/api/broadcast", post(broadcast))
        .with_state(mock.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock");
    let address: SocketAddr = listener.local_addr().expect("address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (mock, format!("http://{address}/api"))
}

fn relay_for(pool: PgPool, api_url: &str) -> Relay {
    let publisher = CentrifugoClient::new(api_url, "room-floor-key").expect("client");
    let mut config = RelayConfig::for_target(database_url(), api_url, "room-floor-key");
    config.claim_batch_size = 64;
    Relay::new(pool, publisher, config)
}

// ---------------------------------------------------------------------------
// fixtures: a 1:1 between 김도현 (leaves) and 이서연 (stays)
// ---------------------------------------------------------------------------

async fn settle_residual_broadcasts(su: &PgPool) {
    sqlx::query(
        "UPDATE outbox SET status = 'done', processed_at = now() \
          WHERE kind = 'broadcast' AND status IN ('pending', 'processing')",
    )
    .execute(su)
    .await
    .expect("settle residue");
}

async fn seed_workspace(su: &PgPool) -> Uuid {
    let ws = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(ws)
        .bind(ws.to_string())
        .execute(su)
        .await
        .expect("seed workspace");
    ws
}

async fn seed_human(su: &PgPool, ws: Uuid, name: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, 'human', $3, $4)",
    )
    .bind(id)
    .bind(ws)
    .bind(name)
    .bind(format!("h{}", &id.simple().to_string()[..12]))
    .execute(su)
    .await
    .expect("seed member");
    id
}

struct Dm {
    ws: Uuid,
    leaver: Uuid,
    stayer: Uuid,
    channel: Uuid,
    app: PgPool,
}

impl Dm {
    fn room(&self) -> String {
        cent_channel(self.ws, self.channel)
    }
}

async fn dm_fixture(su: &PgPool) -> Dm {
    let app = momo_app_pool().await;
    let ws = seed_workspace(su).await;
    let leaver = seed_human(su, ws, "김도현").await;
    let stayer = seed_human(su, ws, "이서연").await;
    let opened = with_tenant_tx(&app, ws, move |conn| {
        Box::pin(async move { open_direct_message_in_tx(conn, ws, leaver, stayer).await })
    })
    .await
    .expect("open dm");
    let OpenedDirectMessage::Opened { channel, .. } = opened else {
        panic!("dm opens");
    };
    Dm {
        ws,
        leaver,
        stayer,
        channel: channel.id,
        app,
    }
}

async fn say(dm: &Dm, author: Uuid, body: &str) -> (Uuid, i64) {
    let sent = send_message(
        &dm.app,
        dm.ws,
        NewMessage::text(dm.channel, author, body).with_client_msg_id(Uuid::new_v4()),
    )
    .await
    .expect("send");
    (sent.message.id, sent.message.seq)
}

async fn leave(dm: &Dm, floor: i64) {
    let (ws, channel, leaver) = (dm.ws, dm.channel, dm.leaver);
    let stored = with_tenant_tx(&dm.app, ws, move |conn| {
        Box::pin(async move { raise_history_floor_in_tx(conn, ws, channel, leaver, floor).await })
    })
    .await
    .expect("raise floor");
    assert_eq!(stored, floor);
}

async fn emit_frame(dm: &Dm, data: Value) {
    let ws = dm.ws;
    let channel = dm.channel;
    let payload = json!({
        "channel": cent_channel(ws, channel),
        "data": data,
        "idempotency_key": format!("synthetic:{}", Uuid::new_v4()),
    });
    with_tenant_tx(&dm.app, ws, move |conn| {
        Box::pin(async move {
            emit_outbox(
                conn,
                ws,
                OutboxKind::Broadcast,
                "publish",
                &payload,
                Some(channel),
            )
            .await
            .map_err(Into::into)
        })
    })
    .await
    .expect("emit synthetic frame");
}

async fn drain(relay: &Relay) -> momo_relay::DrainStats {
    relay.drain_to_empty().await
}

/// A relay whose database role cannot read `table`: BYPASSRLS like `momo_relay` and able to claim
/// and settle outbox rows, so only the judgment's read of `table` fails. The role is this suite's
/// own (made by the superuser, kept between runs).
async fn relay_that_cannot_read(su: &PgPool, table: &str, api_url: &str) -> Relay {
    let role = format!("relay_fault_no_{table}");
    su.execute(
        format!(
            "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') THEN \
               CREATE ROLE {role} NOLOGIN BYPASSRLS; END IF; END $$"
        )
        .as_str(),
    )
    .await
    .expect("fault role");
    su.execute(
        format!(
            "GRANT USAGE ON SCHEMA public TO {role}; GRANT SELECT, UPDATE ON outbox TO {role};"
        )
        .as_str(),
    )
    .await
    .expect("grant outbox");
    for other in ["membership", "message", "work_session", "approval"] {
        let grant = if other == table {
            "REVOKE ALL ON"
        } else {
            "GRANT SELECT ON"
        };
        let direction = if other == table { "FROM" } else { "TO" };
        su.execute(format!("{grant} {other} {direction} {role}").as_str())
            .await
            .expect("grant judgment reads");
    }
    let set_role = format!("SET ROLE {role}");
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .after_connect(move |conn, _meta| {
            let set_role = set_role.clone();
            Box::pin(async move {
                conn.execute(set_role.as_str()).await?;
                Ok(())
            })
        })
        .connect(&database_url())
        .await
        .expect("connect the fault pool");
    relay_for(pool, api_url)
}

/// `(status, attempts, last_error)` of this workspace's broadcast rows, by status.
async fn rows_of(su: &PgPool, ws: Uuid) -> Vec<(String, i32, Option<String>)> {
    sqlx::query_as(
        "SELECT status::text, attempts, last_error FROM outbox \
          WHERE workspace_id = $1 AND kind = 'broadcast' ORDER BY id",
    )
    .bind(ws)
    .fetch_all(su)
    .await
    .expect("rows")
}

/// Make this workspace's requeued rows due now (the backoff is not this suite's subject).
async fn due_now(su: &PgPool, ws: Uuid) {
    sqlx::query(
        "UPDATE outbox SET available_at = now() \
          WHERE workspace_id = $1 AND kind = 'broadcast' AND status = 'pending'",
    )
    .bind(ws)
    .execute(su)
    .await
    .expect("due now");
}

/// Every delivery the mock holds, room or personal, of one event type.
fn everywhere(mock: &Mock, kind: &str) -> Vec<Delivery> {
    mock.deliveries
        .lock()
        .unwrap()
        .iter()
        .filter(|d| d.data["type"] == json!(kind))
        .cloned()
        .collect()
}

fn types(deliveries: &[Delivery]) -> BTreeMap<String, usize> {
    let mut out = BTreeMap::new();
    for delivery in deliveries {
        let kind = delivery.data["type"].as_str().unwrap_or("?").to_string();
        *out.entry(kind).or_insert(0) += 1;
    }
    out
}

fn counted(pairs: &[(&str, usize)]) -> BTreeMap<String, usize> {
    pairs.iter().map(|(k, n)| (k.to_string(), *n)).collect()
}

// ---------------------------------------------------------------------------
// the judgment
// ---------------------------------------------------------------------------

/// Late events about messages below the leaver's floor reach the stayer's personal channel, once
/// each, and neither the room nor the leaver's personal channel. New messages stay on the room.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn late_events_below_a_floor_reach_only_those_who_can_see_the_target() {
    let _guard = relay_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_broadcasts(&su).await;
    let dm = dm_fixture(&su).await;
    let (mock, api) = start_mock().await;
    let relay = relay_for(momo_relay_pool().await, &api);

    // Before the leave: three of the stayer's messages and one of the leaver's.
    let (old_a, _) = say(&dm, dm.stayer, "지난 글 하나").await;
    let (old_b, _) = say(&dm, dm.stayer, "지난 글 둘").await;
    let (old_c, _) = say(&dm, dm.stayer, "지난 글 셋").await;
    let (leaver_own, last_old_seq) = say(&dm, dm.leaver, "내가 쓴 지난 글").await;
    drain(&relay).await;
    mock.clear();

    leave(&dm, last_old_seq + 1).await;

    // After the leave, the stayer acts on the old messages (real write path).
    let (ws, stayer) = (dm.ws, dm.stayer);
    with_tenant_tx(&dm.app, ws, move |conn| {
        Box::pin(async move {
            edit_message_in_tx(conn, ws, old_a, stayer, "나간 뒤에 고친 지난 글")
                .await?
                .expect("edit");
            set_reaction_in_tx(conn, ws, old_a, stayer, "👍", ReactionAction::Added)
                .await?
                .expect("react");
            set_reaction_in_tx(conn, ws, old_a, stayer, "👍", ReactionAction::Removed)
                .await?
                .expect("unreact");
            set_reaction_in_tx(conn, ws, leaver_own, stayer, "🙂", ReactionAction::Added)
                .await?
                .expect("react on the leaver's own old message");
            set_pin_in_tx(conn, ws, old_b, stayer, PinAction::Pinned)
                .await?
                .expect("pin");
            set_pin_in_tx(conn, ws, old_b, stayer, PinAction::Unpinned)
                .await?
                .expect("unpin");
            delete_message_in_tx(conn, ws, old_c, stayer)
                .await?
                .expect("delete");
            Ok(())
        })
    })
    .await
    .expect("late events");
    // A new reply on an old root, and a new message: both above the floor.
    let channel = dm.channel;
    with_tenant_tx(&dm.app, ws, move |conn| {
        Box::pin(async move {
            let mut reply = NewMessage::text(channel, stayer, "지난 글에 단 새 답글")
                .with_client_msg_id(Uuid::new_v4());
            reply.root_id = Some(old_a);
            send_message_with_mentions_in_tx(conn, ws, reply, SendExtras::default())
                .await?
                .expect("reply");
            Ok(())
        })
    })
    .await
    .expect("thread reply");
    let (fresh, fresh_seq) = say(&dm, dm.stayer, "나간 뒤의 새 글").await;
    assert_eq!(
        fresh_seq,
        last_old_seq + 2,
        "the reply took floor, this one floor + 1"
    );

    let stats = drain(&relay).await;
    assert_eq!(stats.failed, 0);
    assert_eq!(stats.requeued, 0);

    let room = dm.room();
    let stayer_personal = personal_channel(dm.stayer);
    let leaver_personal = personal_channel(dm.leaver);
    assert_eq!(
        stayer_personal,
        read_state_channel(dm.stayer),
        "one personal channel"
    );

    let late = counted(&[
        ("message.edited", 1),
        ("reaction.added", 2),
        ("reaction.removed", 1),
        ("message.pinned", 1),
        ("message.unpinned", 1),
        ("message.deleted", 1),
        ("thread.updated", 1),
    ]);
    assert_eq!(
        types(&mock.on(&stayer_personal)),
        late,
        "every late event reaches the stayer's personal channel once"
    );
    assert_eq!(
        types(&mock.on(&room)),
        counted(&[("message.new", 2)]),
        "the room hears only the two new messages"
    );
    assert!(
        mock.on(&leaver_personal).is_empty(),
        "nothing reaches the leaver's personal channel"
    );

    // The diverted frame is the room frame plus its room, with the row's idempotency key and no
    // version.
    for delivery in mock.on(&stayer_personal) {
        assert_eq!(delivery.data[ROOM_CHANNEL_KEY], json!(room));
        assert!(
            delivery.body.get("version").is_none(),
            "no version on a personal channel"
        );
        assert_eq!(
            delivery.body["skip_history"],
            json!(true),
            "a diverted frame is not kept for recovery"
        );
        assert!(delivery.body["idempotency_key"]
            .as_str()
            .is_some_and(|k| k.starts_with(&room)));
        let mut room_shape = delivery.data.clone();
        room_shape.as_object_mut().unwrap().remove(ROOM_CHANNEL_KEY);
        assert!(room_shape.get("type").is_some() && room_shape.get("payload").is_some());
    }
    for delivery in mock.on(&room) {
        assert!(
            delivery.body.get("skip_history").is_none(),
            "a room frame keeps its history as before"
        );
    }
    // The reply on the old root is a room message (it is above the floor) and carries the root's
    // id only.
    let reply = mock
        .on(&room)
        .into_iter()
        .find(|d| d.data["payload"]["root_id"] == json!(old_a))
        .expect("the reply went to the room");
    assert!(reply.data["payload"].get("root").is_none());
    assert!(mock
        .on(&room)
        .iter()
        .any(|d| d.data["payload"]["id"] == json!(fresh)));

    // Every row settled.
    let open: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id = $1 AND kind = 'broadcast' \
            AND status <> 'done'",
    )
    .bind(dm.ws)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(open, 0);
}

/// The floor is inclusive: a message AT the floor is the leaver's, one below it is not.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_floor_itself_is_visible_and_one_below_is_not() {
    let _guard = relay_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_broadcasts(&su).await;
    let dm = dm_fixture(&su).await;
    let (mock, api) = start_mock().await;
    let relay = relay_for(momo_relay_pool().await, &api);

    let (below, below_seq) = say(&dm, dm.stayer, "하한 바로 아래").await;
    let (at, at_seq) = say(&dm, dm.stayer, "하한 그 자리").await;
    assert_eq!(at_seq, below_seq + 1);
    drain(&relay).await;
    mock.clear();
    leave(&dm, at_seq).await;

    let (ws, stayer) = (dm.ws, dm.stayer);
    with_tenant_tx(&dm.app, ws, move |conn| {
        Box::pin(async move {
            edit_message_in_tx(conn, ws, below, stayer, "아래 글 고침")
                .await?
                .expect("edit");
            edit_message_in_tx(conn, ws, at, stayer, "하한 글 고침")
                .await?
                .expect("edit");
            Ok(())
        })
    })
    .await
    .expect("edits");
    drain(&relay).await;

    let room = mock.on(&dm.room());
    let personal = mock.on(&personal_channel(dm.stayer));
    assert_eq!(room.len(), 1, "{room:?}");
    assert_eq!(
        room[0].data["seq"],
        json!(at_seq),
        "the frame at the floor is the room's"
    );
    assert_eq!(personal.len(), 1, "{personal:?}");
    assert_eq!(
        personal[0].data["seq"],
        json!(below_seq),
        "one below goes to the stayer only"
    );
}

/// Room types that are not about one message stay on the room; an unclassified type, and a
/// target that cannot be read, reach only the members without a floor; the session-card and
/// approval-card targets are read from their rows.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn targets_are_read_per_type_and_an_unknown_one_is_closed() {
    let _guard = relay_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_broadcasts(&su).await;
    let dm = dm_fixture(&su).await;
    let (mock, api) = start_mock().await;
    let relay = relay_for(momo_relay_pool().await, &api);

    let (card, card_seq) = say(&dm, dm.stayer, "작업 카드").await;
    let (approval_card, approval_seq) = say(&dm, dm.stayer, "승인 카드").await;
    drain(&relay).await;
    mock.clear();
    leave(&dm, approval_seq + 1).await;

    // Rows the lookups read. Foreign keys are not this test's subject: the session's host and the
    // approval's run are left unseeded (replica role for the two inserts only).
    let session = Uuid::new_v4();
    let approval = Uuid::new_v4();
    let mut tx = su.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO work_session (id, workspace_id, channel_id, member_id, host_id, \
                                   root_message_id, tool, label, workstream_id) \
         VALUES ($1, $2, $3, $4, $5, $6, 'codex', '작업', $7)",
    )
    .bind(session)
    .bind(dm.ws)
    .bind(dm.channel)
    .bind(dm.stayer)
    .bind(Uuid::new_v4())
    .bind(card)
    .bind(Uuid::new_v4())
    .execute(&mut *tx)
    .await
    .expect("seed work_session");
    sqlx::query(
        "INSERT INTO approval (id, workspace_id, run_id, channel_id, request_message_id, \
                               requested_by, action_type) \
         VALUES ($1, $2, $3, $4, $5, $6, 'tool_call')",
    )
    .bind(approval)
    .bind(dm.ws)
    .bind(Uuid::new_v4())
    .bind(dm.channel)
    .bind(approval_card)
    .bind(dm.stayer)
    .execute(&mut *tx)
    .await
    .expect("seed approval");
    tx.commit().await.unwrap();

    let frame = |kind: &str, extra: Value| {
        let mut data = json!({"type": kind, "v": 1, "ts": 1});
        for (key, value) in extra.as_object().unwrap() {
            data[key] = value.clone();
        }
        data
    };
    // synthetic: the shapes of `momo-unfurl` (private builders), `momo-t3`, `momo-agent` and
    // `presence`.
    emit_frame(
        &dm,
        frame(
            "message.unfurl",
            json!({"seq": card_seq, "payload": {"message_id": card}}),
        ),
    )
    .await;
    emit_frame(
        &dm,
        frame(
            "message.unfurl.removed",
            json!({"seq": card_seq, "payload": {"message_id": card}}),
        ),
    )
    .await;
    emit_frame(
        &dm,
        frame(
            "work.session.observer",
            json!({"payload": {"session_id": session.to_string(), "observer_count": 1}}),
        ),
    )
    .await;
    emit_frame(
        &dm,
        frame(
            "work.control.acked",
            json!({"payload": {"session_id": null, "control_id": Uuid::new_v4().to_string()}}),
        ),
    )
    .await;
    emit_frame(
        &dm,
        frame(
            "approval.decided",
            json!({"payload": {"approval_id": approval.to_string(), "status": "cancelled"}}),
        ),
    )
    .await;
    emit_frame(
        &dm,
        frame(
            "approval.decided",
            json!({"seq": approval_seq + 1, "payload": {"message_id": Uuid::new_v4().to_string()}}),
        ),
    )
    .await;
    emit_frame(
        &dm,
        frame(
            "presence",
            json!({"payload": {"member_id": dm.stayer.to_string().to_uppercase()}}),
        ),
    )
    .await;
    emit_frame(
        &dm,
        frame(
            "message.translated",
            json!({"seq": approval_seq + 5, "payload": {}}),
        ),
    )
    .await;
    emit_frame(
        &dm,
        frame(
            "work.session.share_changed",
            json!({"payload": {"session_id": Uuid::new_v4().to_string()}}),
        ),
    )
    .await;

    let stats = drain(&relay).await;
    assert_eq!(stats.failed, 0);

    let room = types(&mock.on(&dm.room()));
    let stayer = types(&mock.on(&personal_channel(dm.stayer)));
    assert!(mock.on(&personal_channel(dm.leaver)).is_empty());
    assert_eq!(
        room,
        counted(&[
            ("work.control.acked", 1),
            ("approval.decided", 1),
            ("presence", 1),
        ]),
        "a session-less control, an approval frame above the floor and presence stay on the room"
    );
    assert_eq!(
        stayer,
        counted(&[
            ("message.unfurl", 1),
            ("message.unfurl.removed", 1),
            ("work.session.observer", 1),
            ("approval.decided", 1),
            ("message.translated", 1),
            ("work.session.share_changed", 1),
        ]),
        "below-floor targets, an unclassified type and an unreadable target reach only the stayer"
    );
}

/// A room without a floor is untouched: the frames go to the room as before.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_room_without_a_floor_publishes_as_before() {
    let _guard = relay_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_broadcasts(&su).await;
    let dm = dm_fixture(&su).await;
    let (mock, api) = start_mock().await;
    let relay = relay_for(momo_relay_pool().await, &api);

    let (old, _) = say(&dm, dm.stayer, "하한 없는 방").await;
    let (ws, stayer) = (dm.ws, dm.stayer);
    with_tenant_tx(&dm.app, ws, move |conn| {
        Box::pin(async move {
            edit_message_in_tx(conn, ws, old, stayer, "고침")
                .await?
                .expect("edit");
            set_pin_in_tx(conn, ws, old, stayer, PinAction::Pinned)
                .await?
                .expect("pin");
            Ok(())
        })
    })
    .await
    .unwrap();
    let stats = drain(&relay).await;
    assert_eq!(stats.diverted, 0);
    assert_eq!(
        types(&mock.on(&dm.room())),
        counted(&[
            ("message.new", 1),
            ("message.edited", 1),
            ("message.pinned", 1)
        ])
    );
    assert!(mock.on(&personal_channel(dm.stayer)).is_empty());
    let room_frame = &mock.on(&dm.room())[0];
    assert!(
        room_frame.data.get(ROOM_CHANNEL_KEY).is_none(),
        "the room path is unchanged"
    );
}

/// The judgment reads the outbox row's own workspace. A row of another workspace that names this
/// room is not judged against this room's members and never reaches their personal channels.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_row_of_another_workspace_is_never_judged_against_this_room() {
    let _guard = relay_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_broadcasts(&su).await;
    let dm = dm_fixture(&su).await;
    let other = dm_fixture(&su).await;
    let (mock, api) = start_mock().await;
    let relay = relay_for(momo_relay_pool().await, &api);

    let (_, seq) = say(&dm, dm.stayer, "지난 글").await;
    drain(&relay).await;
    mock.clear();
    leave(&dm, seq + 1).await;

    // A row written in the other workspace's transaction, naming this room's channel id under the
    // other workspace.
    let forged_room = cent_channel(other.ws, dm.channel);
    let payload = json!({
        "channel": forged_room,
        "data": {"type": "message.edited", "v": 1, "ts": 1, "seq": seq, "payload": {}},
        "idempotency_key": format!("forged:{}", Uuid::new_v4()),
    });
    let other_ws = other.ws;
    let room_id = dm.channel;
    with_tenant_tx(&other.app, other_ws, move |conn| {
        Box::pin(async move {
            emit_outbox(
                conn,
                other_ws,
                OutboxKind::Broadcast,
                "publish",
                &payload,
                Some(room_id),
            )
            .await
            .map_err(Into::into)
        })
    })
    .await
    .expect("emit");

    let stats = drain(&relay).await;
    assert_eq!(
        stats.diverted, 0,
        "not judged against another workspace's room"
    );
    assert_eq!(
        mock.on(&forged_room).len(),
        1,
        "published where it was addressed"
    );
    assert!(mock.on(&personal_channel(dm.stayer)).is_empty());
    assert!(mock.on(&personal_channel(dm.leaver)).is_empty());
}

/// 닫힘으로 실패 (ADR-0177 증보 D17): when the batch's floor check cannot be answered, nothing of the
/// batch is sent — not to the room, not to anyone — and no row is lost: every row goes back to
/// pending, and once the check answers again each frame is sent once, to the right place.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_unanswered_floor_check_sends_nothing_and_loses_nothing() {
    let _guard = relay_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_broadcasts(&su).await;
    let dm = dm_fixture(&su).await;
    let (mock, api) = start_mock().await;
    let relay = relay_for(momo_relay_pool().await, &api);

    let (old, old_seq) = say(&dm, dm.stayer, "지난 글").await;
    drain(&relay).await;
    mock.clear();
    leave(&dm, old_seq + 1).await;
    let (ws, stayer) = (dm.ws, dm.stayer);
    with_tenant_tx(&dm.app, ws, move |conn| {
        Box::pin(async move {
            edit_message_in_tx(conn, ws, old, stayer, "나간 뒤에 고친 지난 글")
                .await?
                .expect("edit");
            Ok(())
        })
    })
    .await
    .expect("late edit");
    let (_, fresh_seq) = say(&dm, dm.stayer, "나간 뒤의 새 글").await;
    assert!(fresh_seq > old_seq);

    let blind = relay_that_cannot_read(&su, "membership", &api).await;
    let stats = drain(&blind).await;
    assert_eq!(stats.claimed, 3, "the claim itself works: {stats:?}");
    assert_eq!(stats.published, 0, "{stats:?}");
    assert_eq!(stats.requeued, stats.claimed, "{stats:?}");
    assert!(
        mock.deliveries.lock().unwrap().is_empty(),
        "nothing is sent while the floor check cannot answer"
    );
    let rows = rows_of(&su, dm.ws).await;
    let waiting: Vec<_> = rows.iter().filter(|r| r.0 == "pending").collect();
    assert_eq!(
        waiting.len(),
        stats.claimed,
        "every claimed row waits (the leave's own frame, the edit, the new message): {rows:?}"
    );
    for (_, attempts, error) in &waiting {
        assert_eq!(*attempts, 1);
        assert!(error
            .as_deref()
            .is_some_and(|e| e.starts_with("room floor check")));
    }

    due_now(&su, dm.ws).await;
    let stats = drain(&relay).await;
    assert_eq!((stats.published, stats.failed), (3, 0), "{stats:?}");
    assert_eq!(
        types(&mock.on(&personal_channel(dm.stayer))),
        counted(&[("message.edited", 1)])
    );
    assert_eq!(types(&mock.on(&dm.room())), counted(&[("message.new", 1)]));
    assert!(mock.on(&personal_channel(dm.leaver)).is_empty());
    assert!(rows_of(&su, dm.ws).await.iter().all(|r| r.0 == "done"));
}

/// 닫힘으로 실패: a frame whose target cannot be read is not sent to the room (nor to anyone) and
/// its row waits; the rest of the batch goes out as usual.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn an_unreadable_target_sends_nothing_and_loses_nothing() {
    let _guard = relay_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_broadcasts(&su).await;
    let dm = dm_fixture(&su).await;
    let (mock, api) = start_mock().await;
    let relay = relay_for(momo_relay_pool().await, &api);

    let (old_root, old_seq) = say(&dm, dm.stayer, "지난 스레드").await;
    drain(&relay).await;
    mock.clear();
    leave(&dm, old_seq + 1).await;
    // A new reply on the old root: `message.new` (above the floor, the room) and `thread.updated`
    // (its target is the root, read from `message`).
    let (ws, stayer, channel) = (dm.ws, dm.stayer, dm.channel);
    with_tenant_tx(&dm.app, ws, move |conn| {
        Box::pin(async move {
            let mut reply = NewMessage::text(channel, stayer, "지난 글에 단 새 답글")
                .with_client_msg_id(Uuid::new_v4());
            reply.root_id = Some(old_root);
            send_message_with_mentions_in_tx(conn, ws, reply, SendExtras::default())
                .await?
                .expect("reply");
            Ok(())
        })
    })
    .await
    .expect("reply");

    let blind = relay_that_cannot_read(&su, "message", &api).await;
    let stats = drain(&blind).await;
    // The leave's own frame, the reply's `message.new` and the root's `thread.updated`.
    assert_eq!(stats.claimed, 3, "{stats:?}");
    assert_eq!((stats.published, stats.requeued), (2, 1), "{stats:?}");
    assert!(
        everywhere(&mock, "thread.updated").is_empty(),
        "the unjudged frame is sent nowhere"
    );
    assert_eq!(types(&mock.on(&dm.room())), counted(&[("message.new", 1)]));
    let rows = rows_of(&su, dm.ws).await;
    let waiting: Vec<_> = rows.iter().filter(|r| r.0 == "pending").collect();
    assert_eq!(waiting.len(), 1, "{rows:?}");
    assert!(waiting[0]
        .2
        .as_deref()
        .is_some_and(|e| e.starts_with("room audience")));

    due_now(&su, dm.ws).await;
    let stats = drain(&relay).await;
    assert_eq!((stats.published, stats.failed), (1, 0), "{stats:?}");
    let sent = everywhere(&mock, "thread.updated");
    assert_eq!(sent.len(), 1, "once, after the read answers: {sent:?}");
    assert_eq!(sent[0].channel, personal_channel(dm.stayer));
    assert!(rows_of(&su, dm.ws).await.iter().all(|r| r.0 == "done"));
}

/// When both members have a floor: a frame below both floors goes to nobody (not the room), one
/// between the floors only to the member whose floor is at or below it, one above both to the room.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_frame_nobody_can_see_goes_nowhere() {
    let _guard = relay_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_broadcasts(&su).await;
    let dm = dm_fixture(&su).await;
    let (mock, api) = start_mock().await;
    let relay = relay_for(momo_relay_pool().await, &api);

    let mut seqs = Vec::new();
    for n in 0..6 {
        seqs.push(say(&dm, dm.stayer, &format!("글 {n}")).await.1);
    }
    drain(&relay).await;
    mock.clear();
    // 김도현 sees from seqs[2], 이서연 from seqs[4].
    leave(&dm, seqs[2]).await;
    let (ws, channel, stayer) = (dm.ws, dm.channel, dm.stayer);
    let floor = seqs[4];
    with_tenant_tx(&dm.app, ws, move |conn| {
        Box::pin(async move { raise_history_floor_in_tx(conn, ws, channel, stayer, floor).await })
    })
    .await
    .expect("the other leaves too");

    for (seq, tag) in [
        (seqs[1], "below both"),
        (seqs[3], "between"),
        (seqs[5], "above both"),
    ] {
        emit_frame(
            &dm,
            json!({"type": "message.edited", "v": 1, "ts": 1, "seq": seq, "payload": {"tag": tag}}),
        )
        .await;
    }
    let stats = drain(&relay).await;
    assert_eq!(stats.failed, 0, "{stats:?}");

    let tags = |deliveries: Vec<Delivery>| -> Vec<String> {
        deliveries
            .iter()
            .map(|d| d.data["payload"]["tag"].as_str().unwrap_or("?").to_string())
            .collect()
    };
    assert_eq!(tags(mock.on(&dm.room())), vec!["above both"]);
    assert_eq!(
        tags(mock.on(&personal_channel(dm.leaver))),
        vec!["between"],
        "only the member whose floor is at or below the target"
    );
    assert!(mock.on(&personal_channel(dm.stayer)).is_empty());
    let mut sent = tags(everywhere(&mock, "message.edited"));
    sent.sort();
    assert_eq!(
        sent,
        vec!["above both", "between"],
        "the frame nobody can see is sent nowhere"
    );
    let done_without_audience: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM outbox WHERE workspace_id = $1 AND kind = 'broadcast' \
            AND status = 'done' AND last_error = 'no audience'",
    )
    .bind(dm.ws)
    .fetch_one(&su)
    .await
    .unwrap();
    assert_eq!(done_without_audience, 1);
}

/// A participation that has left the room (`left_at`) is not part of a diverted frame's audience.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_member_who_left_the_room_is_not_in_the_audience() {
    let _guard = relay_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_broadcasts(&su).await;
    let dm = dm_fixture(&su).await;
    let (mock, api) = start_mock().await;
    let relay = relay_for(momo_relay_pool().await, &api);

    // A third participation that has left (only the predicate is this test's subject: inserted
    // with the replica role so the room's own rules do not stop it).
    let gone = seed_human(&su, dm.ws, "박지우").await;
    let mut tx = su.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO membership (workspace_id, channel_id, member_id, left_at) \
         VALUES ($1, $2, $3, now())",
    )
    .bind(dm.ws)
    .bind(dm.channel)
    .bind(gone)
    .execute(&mut *tx)
    .await
    .expect("seed a left participation");
    tx.commit().await.unwrap();

    let (_, seq) = say(&dm, dm.stayer, "지난 글").await;
    drain(&relay).await;
    mock.clear();
    leave(&dm, seq + 1).await;
    emit_frame(
        &dm,
        json!({"type": "message.edited", "v": 1, "ts": 1, "seq": seq, "payload": {}}),
    )
    .await;
    let stats = drain(&relay).await;
    assert_eq!((stats.diverted, stats.failed), (1, 0), "{stats:?}");
    assert_eq!(mock.on(&personal_channel(dm.stayer)).len(), 1);
    assert!(
        mock.on(&personal_channel(gone)).is_empty(),
        "a participation that left hears nothing"
    );
    assert!(mock.on(&dm.room()).is_empty());
}

/// A row whose room channel spells another workspace than the row's own is not sent (closed),
/// whatever that room's floors are.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn a_row_naming_another_workspaces_room_is_not_sent() {
    let _guard = relay_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    settle_residual_broadcasts(&su).await;
    let dm = dm_fixture(&su).await;
    let other = dm_fixture(&su).await;
    let (mock, api) = start_mock().await;
    let relay = relay_for(momo_relay_pool().await, &api);

    let (_, seq) = say(&dm, dm.stayer, "지난 글").await;
    drain(&relay).await;
    mock.clear();
    leave(&dm, seq + 1).await;

    // Written in the other workspace's transaction, naming this workspace's floored room.
    let payload = json!({
        "channel": dm.room(),
        "data": {"type": "message.edited", "v": 1, "ts": 1, "seq": seq, "payload": {}},
        "idempotency_key": format!("mismatch:{}", Uuid::new_v4()),
    });
    let other_ws = other.ws;
    let room_id = dm.channel;
    with_tenant_tx(&other.app, other_ws, move |conn| {
        Box::pin(async move {
            emit_outbox(
                conn,
                other_ws,
                OutboxKind::Broadcast,
                "publish",
                &payload,
                Some(room_id),
            )
            .await
            .map_err(Into::into)
        })
    })
    .await
    .expect("emit");

    let stats = drain(&relay).await;
    assert_eq!((stats.published, stats.failed), (0, 1), "{stats:?}");
    assert!(mock.deliveries.lock().unwrap().is_empty(), "sent nowhere");
    let rows = rows_of(&su, other.ws).await;
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].0, "failed");
}

/// The two partial indexes the floor reads stand on (migrations 181, 182) are exactly what the
/// migrations make: only the rows with a floor, by member and by channel.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 superuser DB + bootstrap_roles.sql"]
async fn the_floor_indexes_are_the_ones_the_migrations_make() {
    let _guard = relay_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    for (name, definition) in [
        (
            "membership_history_floor_member_idx",
            "CREATE INDEX membership_history_floor_member_idx ON public.membership USING btree (member_id) WHERE (history_from_seq IS NOT NULL)",
        ),
        (
            "membership_history_floor_channel_idx",
            "CREATE INDEX membership_history_floor_channel_idx ON public.membership USING btree (channel_id) WHERE (history_from_seq IS NOT NULL)",
        ),
    ] {
        let found: Option<String> =
            sqlx::query_scalar("SELECT indexdef FROM pg_indexes WHERE indexname = $1")
                .bind(name)
                .fetch_optional(&su)
                .await
                .unwrap();
        assert_eq!(found.as_deref(), Some(definition), "{name}");
    }
}
