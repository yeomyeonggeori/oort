//! DB-backed conformance for the work-permission push (ADR-0188 D5 · D8, ADR-0206 D5, #5340).
//!
//! 「권한 요청은 항상 푸시」: when a member host relays an ACP permission request
//! (`approval.requested`, recorded as a System message in the session's thread with
//! `props.kind = work_session_event`), the one person who can decide it — the session's
//! owner, who is the host's owner — is pushed, on the existing `approval_request` reason and
//! the `momo.approval.open` category (「열어서 결정」, no lock-screen allow), and **nobody
//! else is**. The envelope carries ids only: the thread is the session's root, the message is
//! the event, and `approval_id` is the request's own id (the host-issued `event_id` the
//! decision route and the owner-only preview read are keyed by). The command, the tool's
//! title and the option names are the owner's to read in the app (ADR-0188 D5 미리보기).
//!
//! Before #5340 the judgment had no arm for this message, so what the owner heard depended
//! on the room by accident: in a public/private channel the owner is the event's author and
//! authors are never recipients (nothing at all); in a DM the `dm` arm pushed every other
//! human a plain DM with a reply button.
//!
//! `#[ignore]` — needs a real Postgres plus the runtime roles (the harness applies every
//! migration and `bootstrap_roles.sql`, then drains as `momo_notifier`):
//!
//! ```text
//! DATABASE_URL=postgres://postgres:postgres@127.0.0.1:26951/w5340 \
//!   cargo test -p momo-notifier --test work_permission_push_conformance_pg \
//!   -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `a_permission_request_pushes_its_session_owner_even_when_the_owner_wrote_the_event` | drop the `work_permission` arm; keep the author out of the recipients; push the peer; put content on the wire |
//! | `a_group_dm_permission_request_pushes_the_owner_only_not_the_dm_peers` | let the arm fall through to `dm`; drop the owner condition |
//! | `the_real_remote_work_shape_an_agent_dm_is_an_approval_push_not_a_dm` | the arm below `dm`; select the requester (the persona that wrote the event) instead of the owner |
//! | `a_permission_request_obeys_the_members_settings` | drop the approval switch, DND or mute from the arm's path; let a switched-off arm fall through to `dm` |
//! | `only_a_live_request_of_a_live_session_on_the_owners_own_host_is_pushed` | drop the author, status, host-owner, host-revoked, option or window predicates |
//! | `other_session_events_do_not_make_the_author_a_recipient` | widen the author exemption from `approval.requested` to every `work_session_event` |
//! | `the_push_window_is_the_requests_own_ttl` | change the window without the request's deadline |

use std::sync::{Arc, Mutex, OnceLock};

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::PgPool;
use momo_notifier::{PushConfig, PushDrain};
use momo_push::{DispatchOutcome, PushDispatch, PushDispatcher, WORK_PERMISSION_PUSH_WINDOW_SECS};
use serde_json::{json, Value};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness (same shape as push_conformance_pg.rs)
// ---------------------------------------------------------------------------

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set DATABASE_URL to a pgvector/pg18 superuser DB")
}

async fn superuser_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url())
        .await
        .expect("connect to conformance DB as superuser")
}

/// The BYPASSRLS notifier credential (`bootstrap_roles.sql`).
async fn momo_notifier_pool() -> PgPool {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    let password = std::env::var("MOMO_NOTIFIER_PASSWORD")
        .unwrap_or_else(|_| "momo_notifier_dev_pw".to_string());
    PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options.username("momo_notifier").password(&password))
        .await
        .expect("connect as momo_notifier (run bootstrap_roles.sql first)")
}

fn resolve_psql() -> std::path::PathBuf {
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
        let path = std::path::PathBuf::from(candidate);
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
    let status = std::process::Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(std::path::PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../infra/rust/sql/bootstrap_roles.sql"
        )))
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
    *ready = true;
}

/// The drain claims globally, so two concurrent tests would eat each other's candidates.
async fn drain_test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

/// Push every candidate this test does not own out of the claim window (only reschedules).
async fn focus_candidates(su: &PgPool, keep_workspace: Uuid) {
    sqlx::query(
        "UPDATE outbox SET available_at = clock_timestamp() + interval '1 hour' \
          WHERE kind = 'push_candidate' AND status = 'pending' AND workspace_id <> $1",
    )
    .bind(keep_workspace)
    .execute(su)
    .await
    .expect("park candidates belonging to other fixtures");
}

/// The injected relay: records every dispatch and accepts it.
struct RecordingDispatcher {
    sent: Mutex<Vec<PushDispatch>>,
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

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Shape {
    /// A public channel with the owner and a peer (no DM arm in sight).
    PublicChannel,
    /// A group DM: the owner and a peer human. The persona is not a member.
    GroupDm,
    /// The real remote-work shape (ADR-0188 D4): the owner and their personal agent.
    AgentDm,
}

/// Content that must never reach the relay. Minted per run so a stale row cannot make an
/// assertion pass by accident.
struct Secrets {
    option_name: String,
    session_label: String,
}

impl Secrets {
    fn mint() -> Secrets {
        let tag = Uuid::new_v4().simple().to_string();
        Secrets {
            option_name: format!("PERMOPTSECRET{}", &tag[..12]),
            session_label: format!("PERMLABELSECRET{}", &tag[12..24]),
        }
    }
}

struct Room {
    workspace_id: Uuid,
    channel_id: Uuid,
    /// The session's owner, and the host's. Has a device.
    owner: Uuid,
    owner_device: Uuid,
    /// Another human of the room. Has a device.
    peer: Uuid,
    peer_device: Uuid,
    /// The personal agent. Not human, no device.
    alias: Uuid,
    host_id: Uuid,
    session_id: Uuid,
    root_id: Uuid,
    secrets: Secrets,
}

async fn seed_member(su: &PgPool, workspace: Uuid, kind: &str) -> Uuid {
    let id = Uuid::new_v4();
    let handle = format!("h{}", id.simple());
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, $3::member_kind, $4, $4)",
    )
    .bind(id)
    .bind(workspace)
    .bind(kind)
    .bind(handle)
    .execute(su)
    .await
    .expect("seed member");
    id
}

async fn seed_device(su: &PgPool, workspace: Uuid, member: Uuid) -> Uuid {
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
    device
}

/// A running session of `owner` on their own host, speaking as the owner, or as `alias` when
/// `persona` (the session was called through the personal agent, ADR-0188 D4).
async fn seed_room(su: &PgPool, shape: Shape, persona: bool) -> Room {
    let secrets = Secrets::mint();
    let workspace_id = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace_id)
        .bind(workspace_id.to_string())
        .execute(su)
        .await
        .expect("seed workspace");
    let owner = seed_member(su, workspace_id, "human").await;
    let peer = seed_member(su, workspace_id, "human").await;
    let alias = seed_member(su, workspace_id, "agent").await;

    let channel_id = Uuid::new_v4();
    if shape == Shape::PublicChannel {
        sqlx::query(
            "INSERT INTO channel (id, workspace_id, kind, name) VALUES ($1, $2, 'public', $3)",
        )
        .bind(channel_id)
        .bind(workspace_id)
        .bind(format!("room-{}", &channel_id.simple().to_string()[..8]))
        .execute(su)
        .await
        .expect("seed public channel");
    } else {
        sqlx::query(
            "INSERT INTO channel (id, workspace_id, kind, name, dm_key) \
             VALUES ($1, $2, 'dm', 'dm', $3)",
        )
        .bind(channel_id)
        .bind(workspace_id)
        .bind(channel_id.simple().to_string())
        .execute(su)
        .await
        .expect("seed dm channel");
    }
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel_id)
        .bind(workspace_id)
        .execute(su)
        .await
        .expect("seed channel_seq");
    let members: &[Uuid] = if shape == Shape::AgentDm {
        &[owner, alias]
    } else {
        &[owner, peer]
    };
    for member in members {
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)",
        )
        .bind(workspace_id)
        .bind(channel_id)
        .bind(member)
        .execute(su)
        .await
        .expect("seed membership");
    }
    let owner_device = seed_device(su, workspace_id, owner).await;
    let peer_device = seed_device(su, workspace_id, peer).await;

    let host_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO work_host (id, workspace_id, scope, owner_member_id, type, display_name, \
                                public_key, capabilities, last_seen_at) \
         VALUES ($1, $2, 'member', $3, 'workd', 'mac', $4, '{}'::jsonb, clock_timestamp())",
    )
    .bind(host_id)
    .bind(workspace_id)
    .bind(owner)
    .bind("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
    .execute(su)
    .await
    .expect("seed work host");
    let root_id: Uuid = sqlx::query_scalar(
        "INSERT INTO message \
           (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, props) \
         VALUES ($1, $2, 1, 1, 0, $3, 'system', '{\"kind\":\"work.session\"}'::jsonb) RETURNING id",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(owner)
    .fetch_one(su)
    .await
    .expect("seed session root card");
    let session_id: Uuid = sqlx::query_scalar(
        "INSERT INTO work_session \
           (workspace_id, channel_id, member_id, host_id, root_message_id, tool, label, \
            persona_member_id) \
         VALUES ($1, $2, $3, $4, $5, 'claude', $6, $7) RETURNING id",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(owner)
    .bind(host_id)
    .bind(root_id)
    .bind(&secrets.session_label)
    .bind(persona.then_some(alias))
    .fetch_one(su)
    .await
    .expect("seed work session");
    Room {
        workspace_id,
        channel_id,
        owner,
        owner_device,
        peer,
        peer_device,
        alias,
        host_id,
        session_id,
        root_id,
        secrets,
    }
}

/// The payload of an `approval.requested`, as `validated_acp_event` keeps it (the preview is
/// stored aside, never in the thread).
fn requested_payload(room: &Room, options: Value) -> Value {
    json!({
        "run_id": room.session_id,
        "work_session_id": room.session_id,
        "channel_id": room.channel_id,
        "action": "requested",
        "action_type": "tool_call",
        "status": "pending",
        "options": options,
    })
}

fn one_time_options(room: &Room) -> Value {
    json!([
        {"option_id": "allow-once", "kind": "allow_once", "name": room.secrets.option_name},
        {"option_id": "reject-once", "kind": "reject_once", "name": "Reject"}
    ])
}

/// Insert one ACP event exactly as `publish_session_event_in_tx` shapes it: a System message
/// under the session's root, `client_msg_id = event_id`, no run. Fires the 011 trigger.
#[allow(clippy::too_many_arguments)]
async fn acp_event(
    su: &PgPool,
    room: &Room,
    seq: i64,
    author: Uuid,
    event_type: &str,
    event_id: Uuid,
    payload: Value,
) -> Uuid {
    let props = json!({
        "kind": "work_session_event",
        "schema": "momo.work_session.acp_event.v1",
        "source": "acp",
        "event_id": event_id.to_string(),
        "event_type": event_type,
        "event_ts": 1_800_000_000_000_i64,
        "event": payload,
    });
    sqlx::query_scalar(
        "INSERT INTO message \
           (workspace_id, channel_id, seq, hlc_ts, hlc_count, author_member_id, type, body, \
            root_id, client_msg_id, props) \
         VALUES ($1, $2, $3, $3, 0, $4, 'system', $5, $6, $7, $8) RETURNING id",
    )
    .bind(room.workspace_id)
    .bind(room.channel_id)
    .bind(seq)
    .bind(author)
    .bind("Approval requested")
    .bind(room.root_id)
    .bind(event_id)
    .bind(props)
    .fetch_one(su)
    .await
    .expect("insert ACP event (fires push_candidate_enqueue_trg)")
}

async fn permission_request(su: &PgPool, room: &Room, seq: i64, author: Uuid) -> (Uuid, Uuid) {
    let event_id = Uuid::new_v4();
    let message = acp_event(
        su,
        room,
        seq,
        author,
        "approval.requested",
        event_id,
        requested_payload(room, one_time_options(room)),
    )
    .await;
    (message, event_id)
}

/// Drain this workspace's candidates and return what was dispatched for `message`.
async fn dispatched_for(su: &PgPool, room: &Room, message: Uuid) -> Vec<PushDispatch> {
    focus_candidates(su, room.workspace_id).await;
    let relay = Arc::new(RecordingDispatcher {
        sent: Mutex::new(Vec::new()),
    });
    let pool = momo_notifier_pool().await;
    PushDrain::new(pool, PushConfig::for_target(), relay.clone())
        .drain_once(64)
        .await
        .expect("drain");
    let sent = relay.sent.lock().unwrap().clone();
    sent.into_iter()
        .filter(|dispatch| dispatch.message_id == message.to_string())
        .collect()
}

fn to_device(sent: &[PushDispatch], device: Uuid) -> Vec<&PushDispatch> {
    sent.iter()
        .filter(|dispatch| dispatch.device_id == device.to_string())
        .collect()
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

/// The owner is the event's author (no persona): authors are never recipients, so before
/// #5340 the owner heard nothing at all. Now the owner — and only the owner — is pushed, on
/// the approval reason and the open-in-app category, with ids only.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_permission_request_pushes_its_session_owner_even_when_the_owner_wrote_the_event() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_room(&su, Shape::PublicChannel, false).await;
    let (message, event_id) = permission_request(&su, &room, 2, room.owner).await;

    let sent = dispatched_for(&su, &room, message).await;
    assert_eq!(
        sent.len(),
        1,
        "exactly the owner's one device is pushed: {sent:?}"
    );
    assert!(
        to_device(&sent, room.peer_device).is_empty(),
        "a peer of the room is not asked to decide: {sent:?}"
    );
    let push = to_device(&sent, room.owner_device);
    assert_eq!(push.len(), 1, "the owner's device: {sent:?}");
    let push = push[0];
    assert_eq!(push.reason, "approval_request", "{push:?}");
    assert_eq!(
        push.category, "momo.approval.open",
        "ADR-0188 D5: no lock-screen allow, 「열어서 결정」: {push:?}"
    );
    assert_eq!(
        push.approval_id.as_deref(),
        Some(event_id.to_string().as_str()),
        "the request is named by the host-issued event id the decision route takes: {push:?}"
    );
    assert_eq!(
        push.thread_id,
        room.root_id.to_string(),
        "a tap goes to the session's thread: {push:?}"
    );
    assert_eq!(push.channel_id, room.channel_id.to_string());

    // The real relay's closed vocabulary accepts exactly this reason × category × approval id
    // (an old relay, an old app and the NSE all know them: no new vocabulary, #5340).
    momo_push_relay::PushDispatch::decode_closed(&serde_json::to_vec(push).expect("render"))
        .expect("the relay accepts the dispatch as it is");

    // Ids only: not the option names, not the session's label, not the event's body.
    let rendered = serde_json::to_string(push).expect("render");
    for content in [
        room.secrets.option_name.as_str(),
        room.secrets.session_label.as_str(),
        "Approval requested",
        "allow_once",
    ] {
        assert!(
            !rendered.contains(content),
            "`{content}` must stay off the wire (ADR-0188 D5: 미리보기는 소유자 전용): {rendered}"
        );
    }
}

/// A group DM: the `dm` arm used to push every other human of the room a plain DM for the
/// event (and a non-owner must not even hear that a request exists). The persona wrote the
/// event; the owner is the one who decides.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_group_dm_permission_request_pushes_the_owner_only_not_the_dm_peers() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_room(&su, Shape::GroupDm, true).await;
    let (message, _) = permission_request(&su, &room, 2, room.alias).await;

    let sent = dispatched_for(&su, &room, message).await;
    assert_eq!(
        sent.len(),
        1,
        "only the owner's device — not a DM push for the peer: {sent:?}"
    );
    assert!(to_device(&sent, room.peer_device).is_empty(), "{sent:?}");
    assert_eq!(sent[0].device_id, room.owner_device.to_string(), "{sent:?}");
    assert_eq!(sent[0].reason, "approval_request", "{sent:?}");
    assert_eq!(sent[0].category, "momo.approval.open", "{sent:?}");
}

/// The shape of the real I-8 path: the owner DMs their personal agent, so the agent is the
/// session's persona and the author. A push already reached the owner by accident — as a
/// plain `dm` with a reply button. It is now the approval push.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn the_real_remote_work_shape_an_agent_dm_is_an_approval_push_not_a_dm() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_room(&su, Shape::AgentDm, true).await;
    let (message, event_id) = permission_request(&su, &room, 2, room.alias).await;

    let sent = dispatched_for(&su, &room, message).await;
    assert_eq!(sent.len(), 1, "the owner's device only: {sent:?}");
    assert_eq!(sent[0].device_id, room.owner_device.to_string(), "{sent:?}");
    assert_eq!(
        (sent[0].reason, sent[0].category),
        ("approval_request", "momo.approval.open"),
        "not a `dm` / `momo.message` with a reply button: {sent:?}"
    );
    assert_eq!(
        sent[0].approval_id.as_deref(),
        Some(event_id.to_string().as_str())
    );
    assert_eq!(sent[0].thread_id, room.root_id.to_string());
}

async fn set_rule(su: &PgPool, room: &Room, dnd: bool, kinds: Option<Value>) {
    sqlx::query(
        "INSERT INTO notification_rule (workspace_id, member_id, dnd, kinds) \
         VALUES ($1, $2, $3, $4) \
         ON CONFLICT (workspace_id, member_id) DO UPDATE SET dnd = $3, kinds = $4",
    )
    .bind(room.workspace_id)
    .bind(room.owner)
    .bind(dnd)
    .bind(kinds)
    .execute(su)
    .await
    .expect("set the owner's rule");
}

/// ADR-0188 D8 「항상」 means: not held back by the foreground / presence windows the work
/// completion pushes have. It is not a way past the member's own switches (ADR-0206 D5, ADR-0124):
/// an `approval` switch that is off suppresses it — and in a DM it must not come back as a `dm`
/// push of the same event — DND silences it, and so does a channel mute.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn a_permission_request_obeys_the_members_settings() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_room(&su, Shape::AgentDm, true).await;

    // Control: with no rule row the owner hears it.
    let (message, _) = permission_request(&su, &room, 2, room.alias).await;
    assert_eq!(
        dispatched_for(&su, &room, message).await.len(),
        1,
        "no rule row is today's behaviour: the owner is pushed"
    );

    // The approval switch off: suppressed, and not a `dm` in its place.
    set_rule(
        &su,
        &room,
        false,
        Some(json!({"approval": {"phone": false}})),
    )
    .await;
    let (message, _) = permission_request(&su, &room, 3, room.alias).await;
    let sent = dispatched_for(&su, &room, message).await;
    assert!(
        sent.is_empty(),
        "approval.phone=false silences it — it must not fall through to `dm`: {sent:?}"
    );

    // DND over an otherwise-on rule.
    set_rule(&su, &room, true, None).await;
    let (message, _) = permission_request(&su, &room, 4, room.alias).await;
    let sent = dispatched_for(&su, &room, message).await;
    assert!(sent.is_empty(), "DND suppresses every reason: {sent:?}");

    // A channel mute with DND off.
    set_rule(&su, &room, false, None).await;
    sqlx::query(
        "INSERT INTO notification_pref (workspace_id, channel_id, member_id, muted_until) \
         VALUES ($1, $2, $3, now() + interval '1 day')",
    )
    .bind(room.workspace_id)
    .bind(room.channel_id)
    .bind(room.owner)
    .execute(&su)
    .await
    .expect("mute the channel for the owner");
    let (message, _) = permission_request(&su, &room, 5, room.alias).await;
    let sent = dispatched_for(&su, &room, message).await;
    assert!(
        sent.is_empty(),
        "a channel mute suppresses every reason, approvals included (ADR-0124): {sent:?}"
    );
}

/// The arm claims only a request a person can still act on: written by the session's owner or
/// its persona, in a session that is still running, on a host that is the owner's own and not
/// revoked, offering an option a person can choose, and recent enough that its 10-minute
/// deadline has not passed. Anything else selects NO reason — it must not fall through to
/// `dm` either (a DM room keeps the cases below honest).
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn only_a_live_request_of_a_live_session_on_the_owners_own_host_is_pushed() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;

    // Control: the same shape, nothing wrong.
    let room = seed_room(&su, Shape::GroupDm, true).await;
    let (message, _) = permission_request(&su, &room, 2, room.alias).await;
    assert_eq!(dispatched_for(&su, &room, message).await.len(), 1);

    // A forgery: the peer writes the event (neither the owner nor the session's persona).
    let room = seed_room(&su, Shape::GroupDm, true).await;
    let (message, _) = permission_request(&su, &room, 2, room.peer).await;
    let sent = dispatched_for(&su, &room, message).await;
    assert!(sent.is_empty(), "a forged author pushes nobody: {sent:?}");

    // A session that is over.
    let room = seed_room(&su, Shape::GroupDm, true).await;
    sqlx::query("UPDATE work_session SET status = 'ended', ended_at = now() WHERE id = $1")
        .bind(room.session_id)
        .execute(&su)
        .await
        .expect("end the session");
    let (message, _) = permission_request(&su, &room, 2, room.alias).await;
    let sent = dispatched_for(&su, &room, message).await;
    assert!(
        sent.is_empty(),
        "nobody is waiting on an ended session: {sent:?}"
    );

    // A revoked host: nothing can be answered.
    let room = seed_room(&su, Shape::GroupDm, true).await;
    sqlx::query("UPDATE work_host SET revoked_at = now() WHERE id = $1")
        .bind(room.host_id)
        .execute(&su)
        .await
        .expect("revoke the host");
    let (message, _) = permission_request(&su, &room, 2, room.alias).await;
    let sent = dispatched_for(&su, &room, message).await;
    assert!(sent.is_empty(), "a revoked host is not asked: {sent:?}");

    // A host registered by somebody else: the decision route refuses the session's owner
    // (`only the host owner can decide`), so nobody could act on a push.
    let room = seed_room(&su, Shape::GroupDm, true).await;
    sqlx::query("UPDATE work_host SET owner_member_id = $2 WHERE id = $1")
        .bind(room.host_id)
        .bind(room.peer)
        .execute(&su)
        .await
        .expect("hand the host to the peer");
    let (message, _) = permission_request(&su, &room, 2, room.alias).await;
    let sent = dispatched_for(&su, &room, message).await;
    assert!(
        sent.is_empty(),
        "the decider is the session's owner AND the host's owner (ADR-0188 D3): {sent:?}"
    );

    // Nothing a person can choose: `allow_always` is never a bridged option.
    let room = seed_room(&su, Shape::GroupDm, true).await;
    let message = acp_event(
        &su,
        &room,
        2,
        room.alias,
        "approval.requested",
        Uuid::new_v4(),
        requested_payload(
            &room,
            json!([{"option_id": "always", "kind": "allow_always", "name": "Always"}]),
        ),
    )
    .await;
    let sent = dispatched_for(&su, &room, message).await;
    assert!(
        sent.is_empty(),
        "a request with no `allow_once`/`reject_once` records nothing to decide: {sent:?}"
    );

    // Older than its deadline: a notifier that was down for a quarter of an hour must not
    // wake the owner for a request the host has already refused.
    let room = seed_room(&su, Shape::GroupDm, true).await;
    let (message, _) = permission_request(&su, &room, 2, room.alias).await;
    sqlx::query("UPDATE message SET created_at = created_at - interval '11 minutes' WHERE id = $1")
        .bind(message)
        .execute(&su)
        .await
        .expect("age the request past its deadline");
    let sent = dispatched_for(&su, &room, message).await;
    assert!(
        sent.is_empty(),
        "a request past its 10-minute deadline is not pushed: {sent:?}"
    );
}

/// The author exemption is exactly the permission request's. If it covered every session
/// event, an owner who writes their own progress lines in a DM would be pushed for them by the
/// `dm` arm.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_notifier role"]
async fn other_session_events_do_not_make_the_author_a_recipient() {
    let _guard = drain_test_lock().await;
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let room = seed_room(&su, Shape::GroupDm, false).await;
    let partial = acp_event(
        &su,
        &room,
        2,
        room.owner,
        "agent.partial",
        Uuid::new_v4(),
        json!({
            "run_id": room.session_id,
            "work_session_id": room.session_id,
            "channel_id": room.channel_id,
            "text_delta": "working on it",
        }),
    )
    .await;
    let sent = dispatched_for(&su, &room, partial).await;
    assert!(
        to_device(&sent, room.owner_device).is_empty(),
        "the author of a progress line is not its recipient: {sent:?}"
    );
}

/// The judgment's window is the request's own deadline (`PERMISSION_REQUEST_TTL_SECONDS`).
#[test]
fn the_push_window_is_the_requests_own_ttl() {
    assert_eq!(
        WORK_PERMISSION_PUSH_WINDOW_SECS,
        momo_t3::work_permission::PERMISSION_REQUEST_TTL_SECONDS,
        "a request that has lapsed is not pushed; a request that has not is"
    );
}
