//! DB-backed conformance for ADR-0146 action provenance (goal B2.5).
//!
//! Four reds, each of which goes red if exactly one property is reverted:
//!
//! 1. **round trip + tamper.** A valid signature records; a *tampered* one is
//!    refused and writes nothing. This is the load-bearing one: without it,
//!    `record_provenance` could be a decorated `INSERT`.
//! 2. **RLS.** `action_signature` is cross-tenant invisible to `momo_app`.
//! 3. **append-only.** UPDATE is refused, DELETE is refused, and the tenant
//!    cascade still works.
//! 4. **coexistence.** An unsigned action still works, end to end, and leaves no
//!    provenance row — "무서명 공존" as a test, not a promise.
//!
//! `#[ignore]` — needs a `pgvector/pgvector:pg18` superuser DB plus the runtime
//! `momo_app` role (`infra/e2e/bootstrap_roles.sql`). Run:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-wire --test provenance_pg -- --ignored --nocapture
//! ```
//!
//! The harness mirrors `momo-messaging/tests/conformance_pg.rs` (same migration
//! and bootstrap-role sequence, same superuser/`momo_app` split), because the
//! RLS assertion is only meaningful as the NOBYPASSRLS runtime role.

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use momo_db::sqlx::Row;
use momo_db::{sqlx, with_tenant_tx, DbError, PgPool};
use momo_wire::provenance::{
    record_provenance, EntityRef, MessageContent, Provenance, SignedAction, Signer, ENTITY_MESSAGE,
    ENTITY_WORK_HOST_HEARTBEAT,
};
use momo_wire::signing::{sha256_hex, sign_base64};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// harness (mirrors momo-messaging/tests/conformance_pg.rs)
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

/// The NOBYPASSRLS runtime role — the only role for which an RLS assertion means
/// anything.
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

fn bootstrap_roles_path() -> PathBuf {
    PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../infra/e2e/bootstrap_roles.sql"
    ))
}

fn apply_bootstrap_roles() {
    let status = Command::new(resolve_psql())
        .arg(database_url())
        .args(["-v", "ON_ERROR_STOP=1"])
        .arg("--no-psqlrc")
        .arg("--quiet")
        .arg("--single-transaction")
        .arg("-f")
        .arg(bootstrap_roles_path())
        .status()
        .expect("spawn psql for bootstrap_roles.sql");
    assert!(status.success(), "bootstrap_roles.sql failed to apply");
}

/// Apply the 62 migrations (incl. 060_action_signature) + roles once per process.
fn ensure_schema_and_roles() {
    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().unwrap();
    if *ready {
        return;
    }
    run_migrations(&database_url(), &default_migrations_dir(), SeedMode::None)
        .expect("apply all 62 migrations on a pgvector/pg18 DB");
    apply_bootstrap_roles();
    *ready = true;
}

// ---------------------------------------------------------------------------
// seeds (superuser → bypasses RLS)
// ---------------------------------------------------------------------------

async fn seed_workspace(su: &PgPool, ws: Uuid) {
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(ws)
        .bind(ws.to_string())
        .execute(su)
        .await
        .expect("seed workspace");
}

async fn seed_member(su: &PgPool, ws: Uuid, id: Uuid, kind: &str) {
    sqlx::query(
        "INSERT INTO member (id, workspace_id, kind, display_name, handle) \
         VALUES ($1, $2, $3::member_kind, $4, $4)",
    )
    .bind(id)
    .bind(ws)
    .bind(kind)
    .bind(id.to_string())
    .execute(su)
    .await
    .expect("seed member");
    if kind == "agent" {
        sqlx::query(
            "INSERT INTO agent (member_id, workspace_id, model, base_url) \
             VALUES ($1, $2, 'test-model', 'http://localhost/v1')",
        )
        .bind(id)
        .bind(ws)
        .execute(su)
        .await
        .expect("seed agent child");
    }
}

/// Count the provenance rows for one entity, as superuser (RLS-bypassing) so a
/// count of zero means "no row", never "no visibility".
async fn provenance_count(su: &PgPool, ws: Uuid, entity_type: &str, entity_id: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM action_signature \
          WHERE workspace_id = $1 AND entity_type = $2 AND entity_id = $3",
    )
    .bind(ws)
    .bind(entity_type)
    .bind(entity_id)
    .fetch_one(su)
    .await
    .expect("count action_signature")
}

/// A deterministic, throwaway keypair. Not a credential — 32 fixed bytes.
fn keypair(seed_byte: u8) -> ([u8; 32], String) {
    let seed = [seed_byte; 32];
    let public = ed25519_dalek::SigningKey::from_bytes(&seed)
        .verifying_key()
        .to_bytes();
    let public_b64 = base64_encode(&public);
    (seed, public_b64)
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Fixture message content — a free function so every call site rebuilds the
/// same borrowed struct without holding it across an await.
const PROPS: &str = r#"{"k":"v"}"#;
const BODY: &str = "signed hello";
const TAMPERED_BODY: &str = "signed hello, tampered";

fn message_content(
    workspace_id: Uuid,
    channel_id: Uuid,
    author_member_id: Uuid,
    client_msg_id: Uuid,
    body: &'static str,
) -> MessageContent<'static> {
    MessageContent {
        workspace_id,
        channel_id,
        author_member_id,
        client_msg_id,
        message_type: "text",
        body: Some(body),
        props_json: PROPS,
    }
}

// ---------------------------------------------------------------------------
// ① round trip: a valid signature records; a tampered one is refused (RED)
// ---------------------------------------------------------------------------

/// The one that must never be allowed to pass vacuously: if `record_provenance`
/// ever stopped verifying, the last third of this test would record a row for a
/// signature that proves nothing — and it asserts that the table stays empty.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB with bootstrap roles"]
async fn a_valid_signature_records_and_a_tampered_one_is_refused() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let ws = Uuid::new_v4();
    let agent = Uuid::new_v4();
    seed_workspace(&su, ws).await;
    seed_member(&su, ws, agent, "agent").await;

    let (seed, public_b64) = keypair(0x21);
    let message_id = Uuid::new_v4();
    let channel_id = Uuid::new_v4();
    let client_msg_id = Uuid::new_v4();

    // Rebuilt at each call site rather than held across awaits: `MessageContent`
    // borrows its body/props, and the point of the test is that the *bytes* are
    // reproducible from the same inputs anyway.
    let content = |body: &'static str| MessageContent {
        workspace_id: ws,
        channel_id,
        author_member_id: agent,
        client_msg_id,
        message_type: "text",
        body: Some(body),
        props_json: PROPS,
    };
    let signature =
        sign_base64(&seed, &SignedAction::Message(content(BODY)).signed_bytes()).expect("sign");

    // --- valid: records, with the digest of the bytes the signature covers ---
    let recorded = with_tenant_tx(&app, ws, {
        let signature = signature.clone();
        let public_b64 = public_b64.clone();
        move |conn| {
            Box::pin(async move {
                let action = SignedAction::Message(message_content(
                    ws,
                    channel_id,
                    agent,
                    client_msg_id,
                    BODY,
                ));
                Ok::<_, DbError>(
                    record_provenance(
                        conn,
                        ws,
                        &EntityRef::new(ENTITY_MESSAGE, message_id),
                        &Signer::member(&public_b64, agent),
                        &signature,
                        &action,
                    )
                    .await
                    .expect("a valid signature must record"),
                )
            })
        }
    })
    .await
    .expect("tenant tx");
    assert!(
        matches!(recorded, Provenance::Recorded(_)),
        "the first presentation is a new row"
    );

    let row = sqlx::query(
        "SELECT signer_member_id, signer_pubkey, signature, signed_payload_digest \
           FROM action_signature WHERE id = $1",
    )
    .bind(recorded.id())
    .fetch_one(&su)
    .await
    .expect("the recorded row exists");
    assert_eq!(
        row.try_get::<String, _>("signed_payload_digest").unwrap(),
        sha256_hex(&SignedAction::Message(content(BODY)).signed_bytes()),
        "the stored digest must be of the SIGNED bytes, or an auditor cannot re-verify"
    );
    assert_eq!(
        row.try_get::<Option<Uuid>, _>("signer_member_id").unwrap(),
        Some(agent),
        "a member signer is attributed to the member"
    );
    assert_eq!(
        row.try_get::<String, _>("signer_pubkey").unwrap(),
        public_b64
    );

    // --- idempotence: the same signature re-presented does not duplicate ------
    let again = with_tenant_tx(&app, ws, {
        let signature = signature.clone();
        let public_b64 = public_b64.clone();
        move |conn| {
            Box::pin(async move {
                let action = SignedAction::Message(message_content(
                    ws,
                    channel_id,
                    agent,
                    client_msg_id,
                    BODY,
                ));
                Ok::<_, DbError>(
                    record_provenance(
                        conn,
                        ws,
                        &EntityRef::new(ENTITY_MESSAGE, message_id),
                        &Signer::member(&public_b64, agent),
                        &signature,
                        &action,
                    )
                    .await
                    .expect("re-presentation is not an error"),
                )
            })
        }
    })
    .await
    .expect("tenant tx");
    assert_eq!(
        again,
        Provenance::AlreadyRecorded(recorded.id()),
        "action_signature_signature_uniq must absorb a replay, not duplicate it"
    );
    assert_eq!(
        provenance_count(&su, ws, ENTITY_MESSAGE, message_id).await,
        1
    );

    // --- RED: a tampered signature is refused and writes NOTHING -------------
    let tampered_id = Uuid::new_v4();
    let error = with_tenant_tx(&app, ws, {
        let public_b64 = public_b64.clone();
        move |conn| {
            Box::pin(async move {
                // Same key, same signature — but the bytes claim a different body.
                let action = SignedAction::Message(message_content(
                    ws,
                    channel_id,
                    agent,
                    client_msg_id,
                    TAMPERED_BODY,
                ));
                let outcome = record_provenance(
                    conn,
                    ws,
                    &EntityRef::new(ENTITY_MESSAGE, tampered_id),
                    &Signer::member(&public_b64, agent),
                    &signature,
                    &action,
                )
                .await;
                Ok::<_, DbError>(match outcome {
                    Ok(_) => None,
                    Err(error) => Some(error.to_string()),
                })
            })
        }
    })
    .await
    .expect("tenant tx");
    let error = error.expect(
        "a tampered signature MUST be refused — if this is None, record_provenance \
         has stopped verifying and the provenance log is forgeable",
    );
    assert!(
        error.contains("does not verify"),
        "expected a ProvenanceError::SignatureRejected, got: {error}"
    );
    assert_eq!(
        provenance_count(&su, ws, ENTITY_MESSAGE, tampered_id).await,
        0,
        "a refused signature must leave no row behind"
    );
}

// ---------------------------------------------------------------------------
// ② RLS: action_signature is cross-tenant invisible (RED)
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB with bootstrap roles"]
async fn action_signature_is_cross_tenant_invisible() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let ws_a = Uuid::new_v4();
    let ws_b = Uuid::new_v4();
    let host = Uuid::new_v4();
    seed_workspace(&su, ws_a).await;
    seed_workspace(&su, ws_b).await;

    // A host-signed heartbeat provenance row in tenant A.
    let (seed, public_b64) = keypair(0x22);
    let sent_at_ms = 1_730_000_000_000;
    let action = SignedAction::WorkHostHeartbeat {
        workspace_id: ws_a,
        host_id: host,
        sent_at_ms,
    };
    let signature = sign_base64(&seed, &action.signed_bytes()).expect("sign");
    with_tenant_tx(&app, ws_a, {
        let signature = signature.clone();
        let public_b64 = public_b64.clone();
        move |conn| {
            Box::pin(async move {
                let action = SignedAction::WorkHostHeartbeat {
                    workspace_id: ws_a,
                    host_id: host,
                    sent_at_ms,
                };
                record_provenance(
                    conn,
                    ws_a,
                    &EntityRef::new(ENTITY_WORK_HOST_HEARTBEAT, host),
                    &Signer::work_host(&public_b64),
                    &signature,
                    &action,
                )
                .await
                .expect("record");
                Ok::<_, DbError>(())
            })
        }
    })
    .await
    .expect("tenant tx");

    // Superuser sees it; that is the control, so a zero below cannot be a typo.
    assert_eq!(
        provenance_count(&su, ws_a, ENTITY_WORK_HOST_HEARTBEAT, host).await,
        1
    );

    // As momo_app scoped to tenant B, the row does not exist.
    let visible: i64 = with_tenant_tx(&app, ws_b, move |conn| {
        Box::pin(async move {
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM action_signature")
                .fetch_one(&mut *conn)
                .await?;
            Ok::<_, DbError>(count)
        })
    })
    .await
    .expect("tenant tx");
    assert_eq!(
        visible, 0,
        "ws_isolation must hide tenant A's signatures from tenant B"
    );

    // And a signature cannot be planted into a tenant the GUC does not name:
    // RLS FORCE rejects the INSERT rather than silently mis-filing it.
    let planted = with_tenant_tx(&app, ws_b, {
        let public_b64 = public_b64.clone();
        move |conn| {
            Box::pin(async move {
                let action = SignedAction::WorkHostHeartbeat {
                    workspace_id: ws_a,
                    host_id: host,
                    sent_at_ms,
                };
                let signature = sign_base64(&[0x22; 32], &action.signed_bytes()).expect("sign");
                let outcome = record_provenance(
                    conn,
                    // ws_a, while the transaction's GUC says ws_b.
                    ws_a,
                    &EntityRef::new(ENTITY_WORK_HOST_HEARTBEAT, host),
                    &Signer::work_host(&public_b64),
                    &signature,
                    &action,
                )
                .await;
                Ok::<_, DbError>(outcome.is_err())
            })
        }
    })
    .await;
    // Either the closure reports the rejection, or the transaction itself failed
    // — both are the policy refusing. What must NOT happen is a silent success.
    if let Ok(rejected) = planted {
        assert!(
            rejected,
            "writing a foreign workspace_id must be refused by RLS FORCE"
        );
    }
}

// ---------------------------------------------------------------------------
// ③ append-only (RED)
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB with bootstrap roles"]
async fn action_signature_is_append_only() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let ws = Uuid::new_v4();
    let host = Uuid::new_v4();
    seed_workspace(&su, ws).await;

    let (seed, public_b64) = keypair(0x23);
    let sent_at_ms = 1_730_000_000_001;
    let action = SignedAction::WorkHostHeartbeat {
        workspace_id: ws,
        host_id: host,
        sent_at_ms,
    };
    let signature = sign_base64(&seed, &action.signed_bytes()).expect("sign");
    let id = with_tenant_tx(&app, ws, {
        let signature = signature.clone();
        let public_b64 = public_b64.clone();
        move |conn| {
            Box::pin(async move {
                let action = SignedAction::WorkHostHeartbeat {
                    workspace_id: ws,
                    host_id: host,
                    sent_at_ms,
                };
                let recorded = record_provenance(
                    conn,
                    ws,
                    &EntityRef::new(ENTITY_WORK_HOST_HEARTBEAT, host),
                    &Signer::work_host(&public_b64),
                    &signature,
                    &action,
                )
                .await
                .expect("record");
                Ok::<_, DbError>(recorded.id())
            })
        }
    })
    .await
    .expect("tenant tx");

    // UPDATE — refused. Rewriting a signature is exactly the forgery the sidecar
    // exists to make impossible, so it must fail for the *owner* too, not only
    // for momo_app: assert as superuser.
    let update = sqlx::query("UPDATE action_signature SET signature = $1 WHERE id = $2")
        .bind("A".repeat(86) + "==")
        .bind(id)
        .execute(&su)
        .await;
    let error = update.expect_err("UPDATE on action_signature must be refused");
    assert!(
        error.to_string().contains("append-only"),
        "expected the append-only trigger, got: {error}"
    );

    // DELETE — refused for the same reason, and by the same sentence.
    let delete = sqlx::query("DELETE FROM action_signature WHERE id = $1")
        .bind(id)
        .execute(&su)
        .await;
    let error = delete.expect_err("DELETE on action_signature must be refused");
    assert!(
        error.to_string().contains("append-only"),
        "expected the append-only trigger, got: {error}"
    );
    assert_eq!(
        provenance_count(&su, ws, ENTITY_WORK_HOST_HEARTBEAT, host).await,
        1,
        "the row survives both attempts"
    );

    // …but erasing the tenant still erases its signatures. An append-only table
    // that cannot be dropped with its workspace would make workspace deletion
    // impossible, which is why the trigger exempts the cascade.
    sqlx::query("DELETE FROM workspace WHERE id = $1")
        .bind(ws)
        .execute(&su)
        .await
        .expect("a workspace must remain deletable despite the append-only trigger");
    assert_eq!(
        provenance_count(&su, ws, ENTITY_WORK_HOST_HEARTBEAT, host).await,
        0
    );
}

// ---------------------------------------------------------------------------
// ④ unsigned actions coexist (RED)
// ---------------------------------------------------------------------------

/// ADR-0146 phases the actor types (agents/workd now, humans after device keys),
/// so unsigned rows are permanent, not transitional. This asserts the unsigned
/// path is untouched: it still writes, and it writes **no** provenance row.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB with bootstrap roles"]
async fn unsigned_actions_still_work_and_record_nothing() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;

    let ws = Uuid::new_v4();
    let host = Uuid::new_v4();
    seed_workspace(&su, ws).await;

    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM action_signature")
        .fetch_one(&su)
        .await
        .expect("count");

    // A domain write with no signature at all: a work_host row, the same shape
    // the heartbeat surface stamps. Nothing calls record_provenance.
    let (_, public_b64) = keypair(0x24);
    let owner = Uuid::new_v4();
    seed_member(&su, ws, owner, "human").await;
    with_tenant_tx(&app, ws, {
        let public_b64 = public_b64.clone();
        move |conn| {
            Box::pin(async move {
                sqlx::query(
                    "INSERT INTO work_host \
                       (id, workspace_id, scope, owner_member_id, type, display_name, \
                        public_key, capabilities) \
                     VALUES ($1, $2, 'workspace', $3, 'workd', 'unsigned host', $4, '{}'::jsonb)",
                )
                .bind(host)
                .bind(ws)
                .bind(owner)
                .bind(&public_b64)
                .execute(&mut *conn)
                .await?;
                Ok::<_, DbError>(())
            })
        }
    })
    .await
    .expect("an unsigned domain write must still succeed");

    let host_exists: i64 = sqlx::query_scalar("SELECT count(*) FROM work_host WHERE id = $1")
        .bind(host)
        .fetch_one(&su)
        .await
        .expect("count");
    assert_eq!(host_exists, 1, "the unsigned write path is unchanged");

    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM action_signature")
        .fetch_one(&su)
        .await
        .expect("count");
    assert_eq!(
        after, before,
        "an unsigned action must not manufacture a provenance row"
    );
    assert_eq!(
        provenance_count(&su, ws, ENTITY_WORK_HOST_HEARTBEAT, host).await,
        0
    );
}
