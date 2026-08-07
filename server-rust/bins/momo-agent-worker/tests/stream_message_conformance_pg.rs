//! #1130 전제① — the **producer** side of the growing body, against a real DB.
//!
//! `stream_edit_conformance_pg.rs` (momo-server) proves the wire contract from
//! the outside, with a human's bearer. This file proves the thing that file
//! cannot: that [`momo_agent_worker::stream::MessageStream`] — the sequence
//! every streaming provider performs — grows a message authored by an **agent**
//! member through the identical statements, with no `member_kind` branch
//! anywhere (하드 불변식 「에이전트=member」).
//!
//! It also proves the one rule that only a producer can get wrong: a turn whose
//! job is re-claimed mid-answer must resume the revision it left behind. Restart
//! that counter and every remaining slice is refused as stale — the answer stops
//! growing with no error raised anywhere, which is the worst shape a bug can
//! take and the reason it is pinned here.
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-agent-worker --test stream_message_conformance_pg -- --ignored --nocapture
//! ```
//!
//! Harness contract is the sibling files': `DATABASE_URL` is a **superuser**
//! (migrations + `infra/e2e/bootstrap_roles.sql`, fixture seeding bypasses RLS)
//! while every assertion about the domain runs as the runtime **`momo_app`**
//! role (`NOBYPASSRLS`).

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_agent_worker::stream::{MessageStream, StreamError};
use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::PgPool;
use momo_messaging::InteractionRefused;
use serde_json::Value;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

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
    let opts: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    let opts = opts.username("momo_app").password(&momo_app_password());
    PgPoolOptions::new()
        .max_connections(16)
        .connect_with(opts)
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
        .expect("apply every migration on the conformance DB");
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../infra/e2e/bootstrap_roles.sql"
        )))
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
    *ready = true;
}

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

struct Tenant {
    workspace_id: Uuid,
    human_id: Uuid,
    agent_id: Uuid,
    channel_id: Uuid,
}

async fn seed_tenant(su: &PgPool) -> Tenant {
    let workspace_id = Uuid::new_v4();
    let human_id = Uuid::new_v4();
    let agent_id = Uuid::new_v4();
    let channel_id = Uuid::new_v4();

    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace_id)
        .bind(workspace_id.to_string())
        .execute(su)
        .await
        .expect("seed workspace");

    for (id, kind) in [(human_id, "human"), (agent_id, "agent")] {
        sqlx::query(
            "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
             VALUES ($1, $2, $3::member_kind, $4, $4)",
        )
        .bind(id)
        .bind(workspace_id)
        .bind(kind)
        .bind(id.to_string())
        .execute(su)
        .await
        .expect("seed member");
    }
    sqlx::query(
        "INSERT INTO agent (member_id, workspace_id, model, base_url) \
         VALUES ($1, $2, 'test-model', 'https://gateway.invalid/v1')",
    )
    .bind(agent_id)
    .bind(workspace_id)
    .execute(su)
    .await
    .expect("seed agent");

    sqlx::query("INSERT INTO channel (id, workspace_id, kind, name) VALUES ($1, $2, 'public', $3)")
        .bind(channel_id)
        .bind(workspace_id)
        .bind(format!("stream-{}", &channel_id.simple().to_string()[..8]))
        .execute(su)
        .await
        .expect("seed channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel_id)
        .bind(workspace_id)
        .execute(su)
        .await
        .expect("seed channel_seq");
    for member_id in [human_id, agent_id] {
        sqlx::query(
            "INSERT INTO membership (workspace_id, channel_id, member_id) VALUES ($1, $2, $3)",
        )
        .bind(workspace_id)
        .bind(channel_id)
        .bind(member_id)
        .execute(su)
        .await
        .expect("seed membership");
    }

    Tenant {
        workspace_id,
        human_id,
        agent_id,
        channel_id,
    }
}

/// A real `agent_run` row, because `message.run_id` has a foreign key to it —
/// which is the schema saying an agent's message must name a run that happened.
/// Faking the id would prove the contract against a shape production cannot
/// produce.
async fn seed_run(app: &PgPool, tenant: &Tenant) -> Uuid {
    let workspace_id = tenant.workspace_id;
    let channel_id = tenant.channel_id;
    let agent_member_id = tenant.agent_id;
    momo_db::with_tenant_tx(app, workspace_id, move |conn| {
        Box::pin(async move {
            let created = momo_agent::create_agent_run_in_tx(
                conn,
                workspace_id,
                momo_agent::NewAgentRun {
                    channel_id,
                    trigger: momo_agent::RunTrigger::Work {
                        channel_id,
                        actor_member_id: agent_member_id,
                        agent_member_id,
                        client_run_id: Uuid::new_v4(),
                    },
                    parent_run_id: None,
                    max_steps: 50,
                    depth: 0,
                    input: serde_json::json!({}),
                },
            )
            .await?;
            Ok::<_, momo_db::DbError>(created.id)
        })
    })
    .await
    .expect("seed an agent run")
}

async fn row(su: &PgPool, message_id: Uuid) -> (Option<String>, String, Option<i64>, Value) {
    let row: (
        Option<String>,
        String,
        Option<chrono::DateTime<chrono::Utc>>,
        Value,
    ) = sqlx::query_as("SELECT body, state::text, edited_at, props FROM message WHERE id = $1")
        .bind(message_id)
        .fetch_one(su)
        .await
        .expect("read the message row");
    (row.0, row.1, row.2.map(|at| at.timestamp_millis()), row.3)
}

async fn channel_last_seq(su: &PgPool, channel_id: Uuid) -> i64 {
    sqlx::query_scalar("SELECT last_seq FROM channel_seq WHERE channel_id = $1")
        .bind(channel_id)
        .fetch_one(su)
        .await
        .expect("read channel_seq")
}

async fn message_count(su: &PgPool, channel_id: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM message WHERE channel_id = $1")
        .bind(channel_id)
        .fetch_one(su)
        .await
        .expect("count messages")
}

async fn broadcast_types(su: &PgPool, channel_id: Uuid) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT payload->'data'->>'type' FROM outbox \
          WHERE partition_key = $1 AND kind::text = 'broadcast' ORDER BY id",
    )
    .bind(channel_id)
    .fetch_all(su)
    .await
    .expect("read broadcast types")
}

// ---------------------------------------------------------------------------
// #1 — an agent grows its own message, through the same statements a human uses
// ---------------------------------------------------------------------------

/// The producer's closed loop: 17 deltas, one message, one seq.
///
/// The author is an **agent** member and nothing about that is special —
/// `MessageStream` names a `member.id` and never asks what kind it is. Add a
/// `member_kind` predicate anywhere on this path and the invariant that agents
/// are first-class members stops being true; this test is where that would
/// surface.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn an_agent_grows_one_message_across_seventeen_deltas() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su).await;
    let run_id = seed_run(&app, &tenant).await;

    let mut stream = MessageStream::new(
        app.clone(),
        tenant.workspace_id,
        tenant.channel_id,
        tenant.agent_id,
        run_id,
        None,
    );

    let mut expected = String::new();
    for n in 1..=17 {
        let delta = format!("{n}번째 조각. ");
        expected.push_str(&delta);
        stream.push(&delta, false).await.expect("a delta lands");
    }
    let message_id = stream
        .finish()
        .await
        .expect("finish")
        .expect("the turn said something");

    assert_eq!(
        message_count(&su, tenant.channel_id).await,
        1,
        "17 deltas are one message, not 17"
    );
    assert_eq!(
        channel_last_seq(&su, tenant.channel_id).await,
        1,
        "…and one seq"
    );

    let (body, state, edited_at_ms, props) = row(&su, message_id).await;
    assert_eq!(body.as_deref(), Some(expected.as_str()));
    assert_eq!(state, "sent");
    assert_eq!(
        edited_at_ms, None,
        "an agent assembling an answer never claims a human revised it"
    );
    assert_eq!(props["momo.stream"]["streaming"], Value::Bool(false));

    let types = broadcast_types(&su, tenant.channel_id).await;
    assert_eq!(types[0], "message.new");
    assert!(
        types[1..].iter().all(|t| t == "message.edited"),
        "every slice after the first is an edit of the same message: {types:?}"
    );

    // `client_msg_id = run_id` is what makes the whole thing exactly-once.
    let client_msg_id: Option<Uuid> =
        sqlx::query_scalar("SELECT client_msg_id FROM message WHERE id = $1")
            .bind(message_id)
            .fetch_one(&su)
            .await
            .expect("read client_msg_id");
    assert_eq!(client_msg_id, Some(run_id));
}

// ---------------------------------------------------------------------------
// #2 — RED: a re-claimed turn resumes its revision
// ---------------------------------------------------------------------------

/// **RED proof.** A worker crashes mid-answer; the job is re-claimed and a new
/// `MessageStream` picks the same turn up. The opening `send` dedupes on
/// `client_msg_id`, and the resumed stream must continue from the revision
/// already on the row.
///
/// Make `open` reset `rev` to 0 on a deduped send and this goes red: every
/// remaining slice is refused as stale, the body freezes at whatever the first
/// worker managed, and **no error is raised anywhere** — the answer simply stops
/// growing. That silence is why this is a conformance test and not a comment.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn a_reclaimed_turn_resumes_the_revision_it_left_behind() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su).await;
    let run_id = seed_run(&app, &tenant).await;

    let mut first = MessageStream::new(
        app.clone(),
        tenant.workspace_id,
        tenant.channel_id,
        tenant.agent_id,
        run_id,
        None,
    );
    for delta in ["앞부분 ", "중간 ", "조금 더 "] {
        first.push(delta, false).await.expect("first worker writes");
    }
    let message_id = first.message_id().expect("opened");
    let rev_before = first.rev();
    assert!(
        rev_before >= 2,
        "the first worker got somewhere: {rev_before}"
    );
    drop(first); // the crash

    // The re-claim: a brand new stream for the same run.
    let mut resumed = MessageStream::new(
        app.clone(),
        tenant.workspace_id,
        tenant.channel_id,
        tenant.agent_id,
        run_id,
        None,
    );
    resumed
        .push("앞부분 중간 조금 더 그리고 끝.", false)
        .await
        .expect("the resumed worker writes");
    assert_eq!(
        resumed.message_id(),
        Some(message_id),
        "the deduped open resumed the same message"
    );
    assert!(
        resumed.rev() > rev_before,
        "the resumed stream continued the counter ({} must exceed {rev_before})",
        resumed.rev()
    );

    let finished = resumed.finish().await.expect("finish").expect("message id");
    assert_eq!(finished, message_id);

    assert_eq!(
        message_count(&su, tenant.channel_id).await,
        1,
        "a re-claim must not open a second message"
    );
    let (body, _, _, props) = row(&su, message_id).await;
    assert_eq!(
        body.as_deref(),
        Some("앞부분 중간 조금 더 그리고 끝."),
        "the resumed worker's text actually landed — this is what freezes silently \
         if the revision restarts"
    );
    assert_eq!(props["momo.stream"]["streaming"], Value::Bool(false));
}

// ---------------------------------------------------------------------------
// #3 — RED: an agent cannot grow a human's message
// ---------------------------------------------------------------------------

/// **RED proof.** Agent = member means the agent gets a member's *powers*, not
/// more of them. Streaming into a message it did not author is refused by the
/// same authorship rule that refuses a human, and the refusal names itself.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn an_agent_cannot_stream_into_a_humans_message() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su).await;
    let agent_run = seed_run(&app, &tenant).await;

    // An ordinary human message — no run, no stream marker. Written through the
    // spine so it is the row a person actually produces.
    let human_message = {
        let workspace_id = tenant.workspace_id;
        let channel_id = tenant.channel_id;
        let human_id = tenant.human_id;
        momo_db::with_tenant_tx(&app, workspace_id, move |conn| {
            Box::pin(async move {
                let sent = momo_messaging::send_message_in_tx(
                    conn,
                    workspace_id,
                    momo_messaging::NewMessage::text(channel_id, human_id, "사람이 쓴 글"),
                )
                .await?;
                Ok::<_, momo_db::DbError>(sent.message.id)
            })
        })
        .await
        .expect("a human's message")
    };

    // The agent tries to keep writing it, with the message id in hand.
    let mut agent = MessageStream::new(
        app.clone(),
        tenant.workspace_id,
        tenant.channel_id,
        tenant.agent_id,
        agent_run,
        None,
    );
    agent
        .push("에이전트가 자기 걸 쓴다", false)
        .await
        .expect("the agent opens its own message");

    let refused = momo_db::with_tenant_tx(&app, tenant.workspace_id, move |conn| {
        let workspace_id = tenant.workspace_id;
        let agent_id = tenant.agent_id;
        Box::pin(async move {
            momo_messaging::stream_message_body_in_tx(
                conn,
                workspace_id,
                human_message,
                agent_id,
                "에이전트가 남의 글을 고쳐쓴다",
                momo_messaging::StreamEdit {
                    rev: 1,
                    is_final: false,
                },
            )
            .await
        })
    })
    .await
    .expect("the statement ran")
    .expect_err("an agent may not rewrite a human's words");
    assert_eq!(refused, InteractionRefused::NotAuthorForEdit);
    assert_eq!(
        StreamError::Refused(refused).to_string(),
        "only the message author may edit",
        "the refusal carries its own sentence out to the caller"
    );

    let (body, state, edited_at_ms, props) = row(&su, human_message).await;
    assert_eq!(body.as_deref(), Some("사람이 쓴 글"));
    assert_eq!(state, "sent");
    assert_eq!(edited_at_ms, None);
    assert_eq!(
        props.get("momo.stream"),
        None,
        "a refused slice leaves no revision behind — otherwise the author's own \
         next slice would be refused as stale by a number a stranger set"
    );
    assert_eq!(
        message_count(&su, tenant.channel_id).await,
        2,
        "the agent's own message exists; the human's is untouched"
    );
}
