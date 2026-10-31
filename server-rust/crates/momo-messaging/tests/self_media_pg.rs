//! #4820 C2a — the self-media address against a real PG18 (two tenants, a non-bypass `momo_app`).
//!
//! `DATABASE_URL` is a disposable superuser URL; the harness applies every migration and
//! `bootstrap_roles.sql`, then
//!   * mints as `momo_worker` (the agent-worker's own BYPASSRLS role, inside a tenant tx — what
//!     production does), and
//!   * redeems as `momo_app` (`rolsuper=false`, `rolbypassrls=false` — what the api route does).
//!
//! Run: `DATABASE_URL=… cargo test -p momo-messaging --test self_media_pg -- --ignored --test-threads=1`

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

use momo_db::migrate::{run_migrations, SeedMode};
use momo_db::{with_tenant_tx, PgPool};
use momo_messaging::{
    mint_for_run_in_tx, mint_with_ttl_in_tx, redeem_in_tx, token_hash, SELF_MEDIA_MAX_BYTES,
};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use uuid::Uuid;

fn database_url() -> String {
    std::env::var("DATABASE_URL").expect("set disposable PG18 DATABASE_URL")
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
    let mut ready = READY.lock().expect("schema lock");
    if *ready {
        return;
    }
    let migrations = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../server/Migrations"
    ));
    run_migrations(&database_url(), &migrations, SeedMode::None).expect("apply all migrations");
    let roles = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/rust/sql/bootstrap_roles.sql"
    ));
    let status = Command::new(resolve_psql())
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(roles)
        .arg(database_url())
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed");
    *ready = true;
}

struct Pools {
    su: PgPool,
    app: PgPool,
    worker: PgPool,
}

async fn pools() -> Pools {
    ensure_schema_and_roles();
    let url = database_url();
    let su = PgPoolOptions::new()
        .max_connections(8)
        .connect(&url)
        .await
        .expect("superuser pool");
    let as_role = |role: &str, password: String| {
        url.parse::<PgConnectOptions>()
            .expect("postgres URL")
            .username(role)
            .password(&password)
    };
    let app = PgPoolOptions::new()
        .max_connections(16)
        .connect_with(as_role(
            "momo_app",
            std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string()),
        ))
        .await
        .expect("momo_app pool");
    let worker = PgPoolOptions::new()
        .max_connections(4)
        .connect_with(as_role(
            "momo_worker",
            std::env::var("MOMO_WORKER_PASSWORD")
                .unwrap_or_else(|_| "momo_worker_dev_pw".to_string()),
        ))
        .await
        .expect("momo_worker pool");
    Pools { su, app, worker }
}

/// One tenant: a workspace, two people (the requester `alice` and a bystander `bob`), an agent, a
/// public channel all three are in, and — in it — alice's request (a message with one PNG) and a
/// run in flight for it.
struct Tenant {
    ws: Uuid,
    alice: Uuid,
    bob: Uuid,
    agent: Uuid,
    channel: Uuid,
    trigger: Uuid,
    attachment: Uuid,
    drive_file: String,
    run: Uuid,
}

async fn seed_member(su: &PgPool, ws: Uuid, kind: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member(id,workspace_id,kind,status,display_name,handle) \
         VALUES($1,$2,$3::member_kind,'active',$4,$4)",
    )
    .bind(id)
    .bind(ws)
    .bind(kind)
    .bind(id.to_string())
    .execute(su)
    .await
    .expect("member");
    id
}

async fn seed_message(su: &PgPool, ws: Uuid, channel: Uuid, author: Uuid) -> Uuid {
    let seq: i64 = sqlx::query_scalar(
        "UPDATE channel_seq SET last_seq = last_seq + 1 WHERE channel_id = $1 RETURNING last_seq",
    )
    .bind(channel)
    .fetch_one(su)
    .await
    .expect("seq");
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO message (id, workspace_id, channel_id, seq, hlc_ts, hlc_count, \
         author_member_id, type, body) VALUES ($1, $2, $3, $4, 0, 0, $5, 'text', 'x')",
    )
    .bind(id)
    .bind(ws)
    .bind(channel)
    .bind(seq)
    .bind(author)
    .execute(su)
    .await
    .expect("message");
    id
}

#[allow(clippy::too_many_arguments)]
async fn seed_attachment(
    su: &PgPool,
    ws: Uuid,
    channel: Uuid,
    uploader: Uuid,
    message: Uuid,
    mime: &str,
    size: i64,
    status: &str,
) -> (Uuid, String) {
    let id = Uuid::new_v4();
    let drive_file = format!("drive-file-{id}");
    sqlx::query(
        "INSERT INTO attachment (id, workspace_id, channel_id, uploader_member_id, message_id, \
         drive_file_id, name, mime, size_bytes, status) \
         VALUES ($1, $2, $3, $4, $5, $6, 'photo', $7, $8, $9)",
    )
    .bind(id)
    .bind(ws)
    .bind(channel)
    .bind(uploader)
    .bind(message)
    .bind(&drive_file)
    .bind(mime)
    .bind(size)
    .bind(status)
    .execute(su)
    .await
    .expect("attachment");
    (id, drive_file)
}

async fn seed_run(su: &PgPool, ws: Uuid, channel: Uuid, agent: Uuid, trigger: Uuid) -> Uuid {
    let run = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_run (id, workspace_id, agent_member_id, channel_id, trigger_message_id, \
         status, idempotency_key) VALUES ($1, $2, $3, $4, $5, 'running'::run_status, $6)",
    )
    .bind(run)
    .bind(ws)
    .bind(agent)
    .bind(channel)
    .bind(trigger)
    .bind(format!("self-media:{run}"))
    .execute(su)
    .await
    .expect("run");
    run
}

async fn seed_tenant(su: &PgPool) -> Tenant {
    let ws = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace(id,slug,name) VALUES($1,$2,$2)")
        .bind(ws)
        .bind(ws.to_string())
        .execute(su)
        .await
        .expect("workspace");
    let alice = seed_member(su, ws, "human").await;
    let bob = seed_member(su, ws, "human").await;
    let agent = seed_member(su, ws, "agent").await;
    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channel (id, workspace_id, kind, name, created_by) \
         VALUES ($1, $2, 'public', 'general', $3)",
    )
    .bind(channel)
    .bind(ws)
    .bind(alice)
    .execute(su)
    .await
    .expect("channel");
    sqlx::query("INSERT INTO channel_seq (channel_id, workspace_id, last_seq) VALUES ($1, $2, 0)")
        .bind(channel)
        .bind(ws)
        .execute(su)
        .await
        .expect("channel_seq");
    for member in [alice, bob, agent] {
        sqlx::query("INSERT INTO membership(workspace_id,channel_id,member_id) VALUES($1,$2,$3)")
            .bind(ws)
            .bind(channel)
            .bind(member)
            .execute(su)
            .await
            .expect("membership");
    }
    let trigger = seed_message(su, ws, channel, alice).await;
    let (attachment, drive_file) = seed_attachment(
        su,
        ws,
        channel,
        alice,
        trigger,
        "image/png",
        4096,
        "complete",
    )
    .await;
    let run = seed_run(su, ws, channel, agent, trigger).await;
    Tenant {
        ws,
        alice,
        bob,
        agent,
        channel,
        trigger,
        attachment,
        drive_file,
        run,
    }
}

async fn mint(pools: &Pools, tenant: &Tenant, ttl_secs: i64) -> Option<String> {
    let (ws, run, agent) = (tenant.ws, tenant.run, tenant.agent);
    with_tenant_tx(&pools.worker, ws, move |conn| {
        Box::pin(async move { mint_with_ttl_in_tx(conn, ws, run, agent, ttl_secs).await })
    })
    .await
    .expect("mint transaction")
    .map(|grant| grant.token)
}

async fn redeem(pools: &Pools, ws: Uuid, token: &str) -> Option<momo_messaging::SelfMediaSource> {
    let token = token.to_string();
    with_tenant_tx(&pools.app, ws, move |conn| {
        Box::pin(async move { redeem_in_tx(conn, ws, &token).await })
    })
    .await
    .expect("redeem transaction")
}

/// The token is minted by the worker's role and redeemed by the non-bypass role: the full round
/// trip names exactly the file the trigger message carried, and the table never holds the token.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_token_round_trips_under_a_non_bypass_role_and_is_stored_as_a_hash_only() {
    let pools = pools().await;
    let flags: (bool, bool) =
        sqlx::query_as("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'momo_app'")
            .fetch_one(&pools.su)
            .await
            .unwrap();
    assert_eq!(
        flags,
        (false, false),
        "redeem must run as a non-bypass role"
    );
    let tenant = seed_tenant(&pools.su).await;

    let token = mint(&pools, &tenant, 300).await.expect("a token");
    assert_eq!(token.len(), 43);
    let stored: Vec<(Vec<u8>, String)> = sqlx::query_as(
        "SELECT token_hash, to_jsonb(t)::text FROM self_media_token t WHERE workspace_id = $1",
    )
    .bind(tenant.ws)
    .fetch_all(&pools.su)
    .await
    .unwrap();
    assert_eq!(stored.len(), 1);
    assert_eq!(
        stored[0].0,
        token_hash(&token).to_vec(),
        "the hash of the token"
    );
    assert!(
        !stored[0].1.contains(&token),
        "no column may hold the token itself: {}",
        stored[0].1
    );
    assert!(
        !stored[0].1.contains(&tenant.drive_file),
        "no Drive id in the token row"
    );

    let source = redeem(&pools, tenant.ws, &token).await.expect("redeemed");
    assert_eq!(source.drive_file_id, tenant.drive_file);
    assert_eq!(
        (source.size_bytes, source.mime.as_str()),
        (4096, "image/png")
    );
    let used: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT used_at FROM self_media_token WHERE workspace_id = $1")
            .bind(tenant.ws)
            .fetch_one(&pools.su)
            .await
            .unwrap();
    assert!(used.is_some(), "the redeem is recorded on the row");
    let bound: (Uuid, Uuid, Uuid, Uuid, Uuid) = sqlx::query_as(
        "SELECT run_id, agent_member_id, requester_member_id, channel_id, attachment_id \
           FROM self_media_token WHERE workspace_id = $1",
    )
    .bind(tenant.ws)
    .fetch_one(&pools.su)
    .await
    .unwrap();
    assert_eq!(
        bound,
        (
            tenant.run,
            tenant.agent,
            tenant.alice,
            tenant.channel,
            tenant.attachment
        ),
        "bound to the run, the agent, the requester, the conversation and the one attachment"
    );
}

/// The four refusals the contract names — expired, reused, somebody else's file, an id that does not
/// exist — and the rest of the ways a binding can stop holding, are one and the same `None`.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn every_refusal_is_the_same_none_and_a_refused_token_stays_refused() {
    let pools = pools().await;

    // 1. expired: a one-second token redeemed after its second is over.
    let tenant = seed_tenant(&pools.su).await;
    let token = mint(&pools, &tenant, 1).await.expect("a token");
    tokio::time::sleep(Duration::from_millis(1300)).await;
    assert!(redeem(&pools, tenant.ws, &token).await.is_none(), "expired");

    // 2. reused: the second redeem of a spent token.
    let tenant = seed_tenant(&pools.su).await;
    let token = mint(&pools, &tenant, 300).await.expect("a token");
    assert!(redeem(&pools, tenant.ws, &token).await.is_some());
    assert!(redeem(&pools, tenant.ws, &token).await.is_none(), "reused");

    // 3. somebody else's file: a row whose attachment sits on bob's message while the token names
    //    alice as the requester (what a bug or a hand-written row could produce). The ownership
    //    rule is proved again at redeem time and refuses it.
    let tenant = seed_tenant(&pools.su).await;
    let bobs_message = seed_message(&pools.su, tenant.ws, tenant.channel, tenant.bob).await;
    let (bobs_file, _) = seed_attachment(
        &pools.su,
        tenant.ws,
        tenant.channel,
        tenant.bob,
        bobs_message,
        "image/png",
        4096,
        "complete",
    )
    .await;
    let forged = "F".repeat(43);
    sqlx::query(
        "INSERT INTO self_media_token (workspace_id, token_hash, run_id, agent_member_id, \
         requester_member_id, channel_id, attachment_id, expires_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7, clock_timestamp() + interval '5 minutes')",
    )
    .bind(tenant.ws)
    .bind(token_hash(&forged).to_vec())
    .bind(tenant.run)
    .bind(tenant.agent)
    .bind(tenant.alice)
    .bind(tenant.channel)
    .bind(bobs_file)
    .execute(&pools.su)
    .await
    .unwrap();
    assert!(
        redeem(&pools, tenant.ws, &forged).await.is_none(),
        "somebody else's attachment"
    );

    // 4. an id that does not exist, and strings that are not tokens at all.
    assert!(
        redeem(&pools, tenant.ws, &"N".repeat(43)).await.is_none(),
        "unknown"
    );
    for bad in [
        "",
        "x",
        &"N".repeat(42),
        &"N".repeat(44),
        "../../etc/passwd",
        &"%".repeat(43),
    ] {
        assert!(redeem(&pools, tenant.ws, bad).await.is_none(), "{bad:?}");
    }

    // 5. the binding stopped holding after the mint.
    //    (a) the run is over
    let tenant = seed_tenant(&pools.su).await;
    let token = mint(&pools, &tenant, 300).await.expect("a token");
    sqlx::query("UPDATE agent_run SET status = 'succeeded'::run_status WHERE id = $1")
        .bind(tenant.run)
        .execute(&pools.su)
        .await
        .unwrap();
    assert!(
        redeem(&pools, tenant.ws, &token).await.is_none(),
        "run over"
    );
    //    (b) the request message was deleted
    let tenant = seed_tenant(&pools.su).await;
    let token = mint(&pools, &tenant, 300).await.expect("a token");
    sqlx::query(
        "UPDATE message SET state = 'deleted'::message_state, deleted_at = now() WHERE id = $1",
    )
    .bind(tenant.trigger)
    .execute(&pools.su)
    .await
    .unwrap();
    assert!(
        redeem(&pools, tenant.ws, &token).await.is_none(),
        "message deleted"
    );
    //    (c) the requester left the conversation
    let tenant = seed_tenant(&pools.su).await;
    let token = mint(&pools, &tenant, 300).await.expect("a token");
    sqlx::query("UPDATE membership SET left_at = now() WHERE channel_id = $1 AND member_id = $2")
        .bind(tenant.channel)
        .bind(tenant.alice)
        .execute(&pools.su)
        .await
        .unwrap();
    assert!(
        redeem(&pools, tenant.ws, &token).await.is_none(),
        "requester left"
    );
}

/// Another workspace sees nothing: a token redeemed under the wrong tenant is refused and — because
/// the row is invisible there — stays unspent for its own tenant; no tenant can read another's rows.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn another_workspace_neither_redeems_nor_sees_a_token() {
    let pools = pools().await;
    let one = seed_tenant(&pools.su).await;
    let two = seed_tenant(&pools.su).await;
    let token_one = mint(&pools, &one, 300).await.expect("token one");
    let token_two = mint(&pools, &two, 300).await.expect("token two");

    assert!(
        redeem(&pools, two.ws, &token_one).await.is_none(),
        "wrong tenant"
    );
    assert!(
        redeem(&pools, one.ws, &token_two).await.is_none(),
        "wrong tenant"
    );
    let spent: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM self_media_token WHERE used_at IS NOT NULL AND workspace_id = ANY($1)",
    )
    .bind(vec![one.ws, two.ws])
    .fetch_one(&pools.su)
    .await
    .unwrap();
    assert_eq!(spent, 0, "a wrong-tenant attempt spends nothing");
    assert!(
        redeem(&pools, one.ws, &token_one).await.is_some(),
        "its own tenant still redeems"
    );
    assert!(redeem(&pools, two.ws, &token_two).await.is_some());

    // RLS: under tenant two's binding the non-bypass role sees only tenant two's row, and cannot
    // write a row for tenant one (WITH CHECK).
    let (ws_two, ws_one, run_one, agent_one, alice_one, channel_one, attachment_one) = (
        two.ws,
        one.ws,
        one.run,
        one.agent,
        one.alice,
        one.channel,
        one.attachment,
    );
    let (visible, foreign_insert_refused) = with_tenant_tx(&pools.app, ws_two, move |conn| {
        Box::pin(async move {
            let visible: Vec<Uuid> =
                sqlx::query_scalar("SELECT DISTINCT workspace_id FROM self_media_token")
                    .fetch_all(&mut *conn)
                    .await?;
            sqlx::query("SAVEPOINT probe").execute(&mut *conn).await?;
            let attempt = sqlx::query(
                "INSERT INTO self_media_token (workspace_id, token_hash, run_id, agent_member_id, \
                 requester_member_id, channel_id, attachment_id, expires_at) \
                 VALUES ($1,$2,$3,$4,$5,$6,$7, clock_timestamp() + interval '5 minutes')",
            )
            .bind(ws_one)
            .bind(token_hash(&"R".repeat(43)).to_vec())
            .bind(run_one)
            .bind(agent_one)
            .bind(alice_one)
            .bind(channel_one)
            .bind(attachment_one)
            .execute(&mut *conn)
            .await;
            sqlx::query("ROLLBACK TO SAVEPOINT probe")
                .execute(&mut *conn)
                .await?;
            Ok((visible, attempt.is_err()))
        })
    })
    .await
    .expect("rls probe");
    assert_eq!(
        visible,
        vec![two.ws],
        "only the bound tenant's rows are visible"
    );
    assert!(
        foreign_insert_refused,
        "WITH CHECK refuses a row for another tenant"
    );
}

/// The mint refuses everything that is not "the requester's own complete image on the trigger
/// message": no token, so no address in the hosted request.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn the_mint_hands_out_only_the_requesters_own_complete_image_on_the_trigger_message() {
    let pools = pools().await;
    let su = &pools.su;

    // no image on the trigger message at all (a text-only request)
    let tenant = seed_tenant(su).await;
    let text_only = seed_message(su, tenant.ws, tenant.channel, tenant.alice).await;
    let run = seed_run(su, tenant.ws, tenant.channel, tenant.agent, text_only).await;
    let none = Tenant {
        run,
        trigger: text_only,
        ..tenant
    };
    assert!(mint(&pools, &none, 300).await.is_none(), "no picture");

    // a picture from somebody else in the same conversation is not the requester's request
    let tenant = seed_tenant(su).await;
    let bobs = seed_message(su, tenant.ws, tenant.channel, tenant.bob).await;
    seed_attachment(
        su,
        tenant.ws,
        tenant.channel,
        tenant.bob,
        bobs,
        "image/png",
        10,
        "complete",
    )
    .await;
    let alice_text = seed_message(su, tenant.ws, tenant.channel, tenant.alice).await;
    let run = seed_run(su, tenant.ws, tenant.channel, tenant.agent, alice_text).await;
    let other = Tenant {
        run,
        trigger: alice_text,
        ..tenant
    };
    assert!(
        mint(&pools, &other, 300).await.is_none(),
        "bob's picture is not alice's"
    );

    // a trigger message written by the agent, a deleted request, a pending upload, a type outside
    // png/jpeg/webp, a file over the ceiling, an archived conversation: each is no token
    for (label, mime, size, status) in [
        ("gif", "image/gif", 100_i64, "complete"),
        ("pdf", "application/pdf", 100, "complete"),
        ("pending", "image/png", 100, "pending"),
        (
            "over the ceiling",
            "image/png",
            SELF_MEDIA_MAX_BYTES + 1,
            "complete",
        ),
    ] {
        let tenant = seed_tenant(su).await;
        sqlx::query("DELETE FROM attachment WHERE id = $1")
            .bind(tenant.attachment)
            .execute(su)
            .await
            .unwrap();
        seed_attachment(
            su,
            tenant.ws,
            tenant.channel,
            tenant.alice,
            tenant.trigger,
            mime,
            size,
            status,
        )
        .await;
        assert!(mint(&pools, &tenant, 300).await.is_none(), "{label}");
    }
    let tenant = seed_tenant(su).await;
    sqlx::query(
        "UPDATE message SET state = 'deleted'::message_state, deleted_at = now() WHERE id = $1",
    )
    .bind(tenant.trigger)
    .execute(su)
    .await
    .unwrap();
    assert!(
        mint(&pools, &tenant, 300).await.is_none(),
        "deleted request"
    );

    let tenant = seed_tenant(su).await;
    let agent_message = seed_message(su, tenant.ws, tenant.channel, tenant.agent).await;
    seed_attachment(
        su,
        tenant.ws,
        tenant.channel,
        tenant.agent,
        agent_message,
        "image/png",
        10,
        "complete",
    )
    .await;
    let run = seed_run(su, tenant.ws, tenant.channel, tenant.agent, agent_message).await;
    let by_agent = Tenant {
        run,
        trigger: agent_message,
        ..tenant
    };
    assert!(
        mint(&pools, &by_agent, 300).await.is_none(),
        "an agent's own message has no requester"
    );

    let tenant = seed_tenant(su).await;
    sqlx::query("UPDATE channel SET archived_at = now() WHERE id = $1")
        .bind(tenant.channel)
        .execute(su)
        .await
        .unwrap();
    assert!(
        mint(&pools, &tenant, 300).await.is_none(),
        "archived conversation"
    );

    // a run that belongs to another agent never mints for this one
    let tenant = seed_tenant(su).await;
    let (ws, run, other_agent) = (tenant.ws, tenant.run, tenant.bob);
    let foreign = with_tenant_tx(&pools.worker, ws, move |conn| {
        Box::pin(async move { mint_for_run_in_tx(conn, ws, run, other_agent).await })
    })
    .await
    .unwrap();
    assert!(foreign.is_none(), "not this run's agent");

    // and the happy case still mints, so the refusals above are not a dead path
    let tenant = seed_tenant(su).await;
    assert!(mint(&pools, &tenant, 300).await.is_some());
}

/// A spent token is spent exactly once even when eight requests race for it.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn eight_racing_requests_spend_a_token_exactly_once() {
    let pools = pools().await;
    let tenant = seed_tenant(&pools.su).await;
    let token = mint(&pools, &tenant, 300).await.expect("a token");
    let mut tasks = Vec::new();
    for _ in 0..8 {
        let (app, ws, token) = (pools.app.clone(), tenant.ws, token.clone());
        tasks.push(tokio::spawn(async move {
            with_tenant_tx(&app, ws, move |conn| {
                Box::pin(async move { redeem_in_tx(conn, ws, &token).await })
            })
            .await
        }));
    }
    let mut winners = 0;
    for task in tasks {
        if matches!(task.await.unwrap(), Ok(Some(_))) {
            winners += 1;
        }
    }
    assert_eq!(winners, 1, "exactly one request wins the token");
}

/// What the table itself refuses, whoever writes: a lifetime over ten minutes, an un-spend, and a
/// rewrite of the binding. And it is a tenant table: RLS enabled and FORCEd with the workspace policy.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn the_table_itself_refuses_a_long_lifetime_an_unspend_and_a_rebinding() {
    let pools = pools().await;
    let tenant = seed_tenant(&pools.su).await;
    let token = mint(&pools, &tenant, 300).await.expect("a token");
    let hash = token_hash(&token).to_vec();

    let long = sqlx::query(
        "INSERT INTO self_media_token (workspace_id, token_hash, run_id, agent_member_id, \
         requester_member_id, channel_id, attachment_id, expires_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7, clock_timestamp() + interval '11 minutes')",
    )
    .bind(tenant.ws)
    .bind(token_hash(&"L".repeat(43)).to_vec())
    .bind(tenant.run)
    .bind(tenant.agent)
    .bind(tenant.alice)
    .bind(tenant.channel)
    .bind(tenant.attachment)
    .execute(&pools.su)
    .await;
    assert!(
        long.is_err(),
        "an eleven-minute token must not be insertable"
    );
    let short_hash = sqlx::query(
        "INSERT INTO self_media_token (workspace_id, token_hash, run_id, agent_member_id, \
         requester_member_id, channel_id, attachment_id, expires_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7, clock_timestamp() + interval '1 minute')",
    )
    .bind(tenant.ws)
    .bind(vec![1u8; 31])
    .bind(tenant.run)
    .bind(tenant.agent)
    .bind(tenant.alice)
    .bind(tenant.channel)
    .bind(tenant.attachment)
    .execute(&pools.su)
    .await;
    assert!(
        short_hash.is_err(),
        "a hash that is not 32 bytes must not be insertable"
    );

    assert!(redeem(&pools, tenant.ws, &token).await.is_some());
    let unspend = sqlx::query("UPDATE self_media_token SET used_at = NULL WHERE token_hash = $1")
        .bind(&hash)
        .execute(&pools.su)
        .await;
    assert!(unspend.is_err(), "a spent token cannot be un-spent");
    let relife = sqlx::query(
        "UPDATE self_media_token SET expires_at = expires_at + interval '1 minute' WHERE token_hash = $1",
    )
    .bind(&hash)
    .execute(&pools.su)
    .await;
    assert!(relife.is_err(), "the lifetime is immutable");
    let rebind =
        sqlx::query("UPDATE self_media_token SET requester_member_id = $2 WHERE token_hash = $1")
            .bind(&hash)
            .bind(tenant.bob)
            .execute(&pools.su)
            .await;
    assert!(rebind.is_err(), "the binding is immutable");

    let (enabled, forced, policies): (bool, bool, i64) = sqlx::query_as(
        "SELECT c.relrowsecurity, c.relforcerowsecurity, \
                (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'ws_isolation') \
           FROM pg_class c WHERE c.relname = 'self_media_token' AND c.relkind = 'r'",
    )
    .fetch_one(&pools.su)
    .await
    .unwrap();
    assert!(enabled && forced, "RLS must be enabled and FORCEd");
    assert_eq!(policies, 1, "the ws_isolation policy");
}

/// Spent and expired rows stay a day as the record, then the next mint in that workspace drops
/// them; another workspace's old rows are not touched by it.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_mint_clears_only_its_own_workspaces_rows_older_than_a_day() {
    let pools = pools().await;
    let one = seed_tenant(&pools.su).await;
    let two = seed_tenant(&pools.su).await;
    for tenant in [&one, &two] {
        for (label, age) in [("old", "2 days"), ("recent", "2 hours")] {
            // created_at = now - age, expired five minutes after (the CHECK allows it)
            sqlx::query(
                "INSERT INTO self_media_token (workspace_id, token_hash, run_id, agent_member_id, \
                 requester_member_id, channel_id, attachment_id, created_at, expires_at) \
                 VALUES ($1,$2,$3,$4,$5,$6,$7, clock_timestamp() - $8::interval, \
                         clock_timestamp() - $8::interval + interval '5 minutes')",
            )
            .bind(tenant.ws)
            .bind(token_hash(&format!("{label}{}", tenant.ws.simple())).to_vec())
            .bind(tenant.run)
            .bind(tenant.agent)
            .bind(tenant.alice)
            .bind(tenant.channel)
            .bind(tenant.attachment)
            .bind(age)
            .execute(&pools.su)
            .await
            .unwrap();
        }
    }
    mint(&pools, &one, 300).await.expect("a token");
    let count = |ws: Uuid| {
        let su = pools.su.clone();
        async move {
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM self_media_token WHERE workspace_id = $1",
            )
            .bind(ws)
            .fetch_one(&su)
            .await
            .unwrap()
        }
    };
    assert_eq!(
        count(one.ws).await,
        2,
        "the old row went, the recent one and the new one stay"
    );
    assert_eq!(
        count(two.ws).await,
        2,
        "another workspace's rows are not touched"
    );
}

/// A pool as one of the runtime roles the production processes use (the development passwords the
/// bootstrap file sets), for the privilege tests below.
async fn pool_as(role: &str, password_env: &str, fallback: &str) -> PgPool {
    let options: PgConnectOptions = database_url().parse().expect("postgres URL");
    let password = std::env::var(password_env).unwrap_or_else(|_| fallback.to_string());
    PgPoolOptions::new()
        .max_connections(2)
        .connect_with(options.username(role).password(&password))
        .await
        .unwrap_or_else(|error| panic!("{role} pool: {error}"))
}

/// Run one statement as a role and say whether the **privilege** let it through. `permission denied
/// for table` is the privilege missing; anything else that stops the statement later (a NOT NULL
/// constraint on an INSERT of `DEFAULT VALUES`, a row-level-security check for the non-bypass role,
/// whose SQLSTATE is also 42501) means the privilege check had already passed.
async fn privilege_probe(pool: &PgPool, sql: &str) -> &'static str {
    match sqlx::query(sql).execute(pool).await {
        Ok(_) => "allowed",
        Err(sqlx::Error::Database(error))
            if error.code().as_deref() == Some("42501")
                && error.message().starts_with("permission denied for table") =>
        {
            "denied"
        }
        Err(sqlx::Error::Database(error))
            if error.code().as_deref() == Some("23502")
                || error.message().contains("row-level security") =>
        {
            "allowed"
        }
        Err(other) => panic!("`{sql}` failed for a reason other than privilege: {other}"),
    }
}

/// The table holds exactly what the flow uses, role by role (security review L6,
/// `self-media-token-lockdown`): the worker mints and sweeps, the api spends, and the other two
/// BYPASSRLS roles — which skip RLS, so their table privileges are the only door — touch nothing, so
/// a role that has no business writing a row cannot forge one. Both the catalog and a real statement
/// as each role are checked: the catalog says what is granted, the statement says it is not a
/// privilege some other grant path still supplies.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn the_runtime_roles_hold_exactly_the_privileges_the_flow_uses() {
    let pools = pools().await;
    const VERBS: [&str; 7] = [
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
        "TRUNCATE",
        "REFERENCES",
        "TRIGGER",
    ];
    let expected = |role: &str| -> &'static [&'static str] {
        match role {
            "momo_app" => &["SELECT", "UPDATE"],
            "momo_worker" => &["SELECT", "INSERT", "DELETE"],
            _ => &[],
        }
    };
    let mut drift: Vec<String> = Vec::new();
    for role in [
        "momo_app",
        "momo_relay",
        "momo_worker",
        "momo_notifier",
        "public",
    ] {
        for verb in VERBS {
            let held: bool =
                sqlx::query_scalar("SELECT has_table_privilege($1, 'public.self_media_token', $2)")
                    .bind(role)
                    .bind(verb)
                    .fetch_one(&pools.su)
                    .await
                    .unwrap();
            let want = expected(role).contains(&verb);
            if held != want {
                drift.push(format!("{role}:{verb} held={held} want={want}"));
            }
        }
    }
    assert!(
        drift.is_empty(),
        "the table's privileges drifted from the lockdown: {drift:?}"
    );

    // the same, as real statements run by the real roles
    let statements = [
        ("SELECT", "SELECT count(*) FROM self_media_token"),
        ("INSERT", "INSERT INTO self_media_token DEFAULT VALUES"),
        (
            "UPDATE",
            "UPDATE self_media_token SET used_at = used_at WHERE false",
        ),
        ("DELETE", "DELETE FROM self_media_token WHERE false"),
    ];
    let relay = pool_as("momo_relay", "MOMO_RELAY_PASSWORD", "momo_relay_dev_pw").await;
    let notifier = pool_as(
        "momo_notifier",
        "MOMO_NOTIFIER_PASSWORD",
        "momo_notifier_dev_pw",
    )
    .await;
    let mut wrong: Vec<String> = Vec::new();
    for (role, pool) in [
        ("momo_app", &pools.app),
        ("momo_relay", &relay),
        ("momo_worker", &pools.worker),
        ("momo_notifier", &notifier),
    ] {
        for (verb, sql) in statements {
            let got = privilege_probe(pool, sql).await;
            let want = if expected(role).contains(&verb) {
                "allowed"
            } else {
                "denied"
            };
            if got != want {
                wrong.push(format!("{role} {verb}: {got}, want {want}"));
            }
        }
    }
    assert!(
        wrong.is_empty(),
        "a statement ran (or was refused) against the lockdown: {wrong:?}"
    );
}

/// Taking the deleting roles' DELETE away from the table must not leave rows behind when a parent
/// goes: a foreign-key cascade runs as the table's owner, so the api (which deletes attachments) and
/// the notifier (whose reclaim does) still clear a picture's tokens with them.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a disposable PG18"]
async fn a_parent_delete_still_clears_the_tokens_though_the_deleting_role_holds_no_delete_on_them()
{
    let pools = pools().await;
    let notifier = pool_as(
        "momo_notifier",
        "MOMO_NOTIFIER_PASSWORD",
        "momo_notifier_dev_pw",
    )
    .await;
    let rows = |ws: Uuid| {
        let su = pools.su.clone();
        async move {
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM self_media_token WHERE workspace_id = $1",
            )
            .bind(ws)
            .fetch_one(&su)
            .await
            .unwrap()
        }
    };

    // as the api's role (RLS-bound, no DELETE on the token table)
    let by_api = seed_tenant(&pools.su).await;
    mint(&pools, &by_api, 300).await.expect("a token");
    assert_eq!(rows(by_api.ws).await, 1);
    let (ws, attachment) = (by_api.ws, by_api.attachment);
    with_tenant_tx(&pools.app, ws, move |conn| {
        Box::pin(async move {
            sqlx::query("DELETE FROM attachment WHERE workspace_id = $1 AND id = $2")
                .bind(ws)
                .bind(attachment)
                .execute(&mut *conn)
                .await?;
            Ok::<(), momo_db::DbError>(())
        })
    })
    .await
    .expect("momo_app deletes the attachment");
    assert_eq!(rows(by_api.ws).await, 0, "the cascade cleared the token");

    // as the notifier (BYPASSRLS, no privilege of any kind on the token table)
    let by_notifier = seed_tenant(&pools.su).await;
    mint(&pools, &by_notifier, 300).await.expect("a token");
    assert_eq!(rows(by_notifier.ws).await, 1);
    sqlx::query("DELETE FROM attachment WHERE id = $1")
        .bind(by_notifier.attachment)
        .execute(&notifier)
        .await
        .expect("momo_notifier deletes the attachment");
    assert_eq!(
        rows(by_notifier.ws).await,
        0,
        "the cascade cleared the token"
    );
}
