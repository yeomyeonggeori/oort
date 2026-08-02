//! DB-backed conformance for the ADR-0120 D4 device registration lifecycle
//! (batch P2).
//!
//! Swift parity source: `server/Sources/MomoServer/Routes/DeviceRoutes.swift`.
//! Each test names the Swift contract it holds and goes red when that contract
//! is reverted. `#[ignore]` because they need a `pgvector/pgvector:pg18`
//! database plus the runtime roles:
//!
//! ```text
//! DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
//!   cargo test -p momo-push --test device_conformance_pg -- --ignored --nocapture
//! ```
//!
//! Harness contract:
//!   * `DATABASE_URL` connects as a **superuser** — applies every migration plus
//!     `infra/e2e/bootstrap_roles.sql`, and seeds fixtures bypassing RLS;
//!   * the registration paths run as **`momo_app`** (NOBYPASSRLS), the runtime
//!     role, so FORCE RLS genuinely applies to everything under test.
//!
//! | test | revert that makes it red |
//! |---|---|
//! | `re_registration_is_idempotent_and_rotates_the_token` | drop the sibling invalidation before the upsert |
//! | `registration_never_deletes_a_token_row` | turn revocation into a DELETE |
//! | `another_members_device_is_refused` | drop the actor-binding check |
//! | `an_active_token_owned_by_another_member_is_refused` | drop the token actor-binding check |
//! | `an_invalidated_token_is_reclaimable_after_logout` | reject invalidated rows too |
//! | `a_device_platform_cannot_change` | allow the platform to be updated |
//! | `revocation_is_idempotent` | count already-invalidated rows again |
//! | `one_member_cannot_list_another_members_devices` | drop the member_id predicate from the list |
//! | `the_raw_apns_token_never_leaves_the_database` | select `apns_token` instead of `right(...)` |

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::PgPool;
use momo_push::{
    list_devices, register_device, revoke_device, DeviceRegistration, DeviceRejection,
};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::Row;
use uuid::Uuid;

const TOPIC: &str = "kim.dawn.momo.e2e";

// ---------------------------------------------------------------------------
// harness
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

/// The runtime API role: NOBYPASSRLS, so the RLS policies actually apply.
async fn momo_app_pool() -> PgPool {
    let options: PgConnectOptions = database_url()
        .parse()
        .expect("DATABASE_URL parses as a postgres connect string");
    let password =
        std::env::var("MOMO_APP_PASSWORD").unwrap_or_else(|_| "momo_app_dev_pw".to_string());
    let options = options.username("momo_app").password(&password);
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
// fixtures
// ---------------------------------------------------------------------------

struct Tenant {
    workspace_id: Uuid,
    member_a: Uuid,
    member_b: Uuid,
}

async fn seed_tenant(su: &PgPool) -> Tenant {
    let workspace_id = Uuid::new_v4();
    sqlx::query("INSERT INTO workspace (id, slug, name) VALUES ($1, $2, $2)")
        .bind(workspace_id)
        .bind(workspace_id.to_string())
        .execute(su)
        .await
        .expect("seed workspace");

    let mut members = Vec::new();
    for _ in 0..2 {
        let member_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO member (id, workspace_id, kind, status, display_name, handle) \
             VALUES ($1, $2, 'human'::member_kind, 'active', $3, $3)",
        )
        .bind(member_id)
        .bind(workspace_id)
        .bind(member_id.to_string())
        .execute(su)
        .await
        .expect("seed member");
        // `active_workspace_role` reads workspace_membership, which is the
        // repo-wide definition of "active member of this workspace".
        sqlx::query(
            "INSERT INTO workspace_membership (workspace_id, member_id, role) \
             VALUES ($1, $2, 'member'::membership_role)",
        )
        .bind(workspace_id)
        .bind(member_id)
        .execute(su)
        .await
        .expect("seed workspace membership");
        members.push(member_id);
    }

    Tenant {
        workspace_id,
        member_a: members[0],
        member_b: members[1],
    }
}

fn hex_token(seed: u8) -> String {
    format!("{seed:02x}").repeat(32)
}

fn registration(device_id: Uuid, token: &str) -> DeviceRegistration {
    DeviceRegistration::parse(
        &device_id.to_string(),
        "ios",
        Some("42"),
        token,
        "sandbox",
        TOPIC,
    )
    .expect("fixture registration is valid")
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

/// Re-registering a client-stable `deviceId` refreshes liveness and rotates the
/// token. The 010 partial unique index allows exactly one active token per
/// `(device, env)`, so the previous one must be invalidated **in the same
/// transaction and before the upsert**.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn re_registration_is_idempotent_and_rotates_the_token() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su).await;
    let device_id = Uuid::new_v4();

    let first = register_device(
        &app,
        tenant.workspace_id,
        tenant.member_a,
        None,
        &registration(device_id, &hex_token(0xa1)),
    )
    .await
    .expect("first registration succeeds")
    .expect("first registration is not rejected");
    assert!(
        first.created,
        "a new device reports created (the route's 201)"
    );
    assert_eq!(first.device.push_tokens.len(), 1);

    let second = register_device(
        &app,
        tenant.workspace_id,
        tenant.member_a,
        None,
        &registration(device_id, &hex_token(0xb2)),
    )
    .await
    .expect("re-registration succeeds")
    .expect("re-registration is not rejected");
    assert!(
        !second.created,
        "re-registering the same device is an update (the route's 200)"
    );

    let active: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM push_token WHERE device_id = $1 AND invalidated_at IS NULL",
    )
    .bind(device_id)
    .fetch_one(&su)
    .await
    .expect("count active tokens");
    assert_eq!(
        active, 1,
        "exactly one active token per (device, env) — the 010 index invariant"
    );

    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM push_token WHERE device_id = $1")
        .bind(device_id)
        .fetch_one(&su)
        .await
        .expect("count all tokens");
    assert_eq!(
        total, 2,
        "the rotated-out token is kept, not deleted — push_dispatch_log references it"
    );
}

/// Revocation is `invalidated_at`, never `DELETE`: `push_dispatch_log
/// .push_token_id` must keep resolving (ADR-0120 D4), and APNs 410/400 handling
/// writes the same column.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn registration_never_deletes_a_token_row() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su).await;
    let device_id = Uuid::new_v4();

    register_device(
        &app,
        tenant.workspace_id,
        tenant.member_a,
        None,
        &registration(device_id, &hex_token(0xc3)),
    )
    .await
    .expect("register")
    .expect("not rejected");

    let outcome = revoke_device(&app, tenant.workspace_id, tenant.member_a, None, device_id)
        .await
        .expect("revoke")
        .expect("not rejected");
    assert_eq!(outcome.invalidated, 1, "one live token was revoked");

    let row = sqlx::query("SELECT invalidated_at FROM push_token WHERE device_id = $1")
        .bind(device_id)
        .fetch_one(&su)
        .await
        .expect("the token row still exists after revocation");
    assert!(
        row.get::<Option<chrono::DateTime<chrono::Utc>>, _>("invalidated_at")
            .is_some(),
        "revocation sets invalidated_at rather than removing the row"
    );
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn revocation_is_idempotent() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su).await;
    let device_id = Uuid::new_v4();

    register_device(
        &app,
        tenant.workspace_id,
        tenant.member_a,
        None,
        &registration(device_id, &hex_token(0xd4)),
    )
    .await
    .expect("register")
    .expect("not rejected");

    let first = revoke_device(&app, tenant.workspace_id, tenant.member_a, None, device_id)
        .await
        .expect("first revoke")
        .expect("not rejected");
    let second = revoke_device(&app, tenant.workspace_id, tenant.member_a, None, device_id)
        .await
        .expect("second revoke")
        .expect("not rejected");

    assert_eq!(first.invalidated, 1);
    assert_eq!(
        second.invalidated, 0,
        "an already-revoked device reports 0, not an error"
    );
}

/// Actor binding: `deviceId` is client-generated, so a colliding id must not let
/// one member seize another's device row.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn another_members_device_is_refused() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su).await;
    let device_id = Uuid::new_v4();

    register_device(
        &app,
        tenant.workspace_id,
        tenant.member_a,
        None,
        &registration(device_id, &hex_token(0xe5)),
    )
    .await
    .expect("member A registers")
    .expect("not rejected");

    let rejection = register_device(
        &app,
        tenant.workspace_id,
        tenant.member_b,
        None,
        &registration(device_id, &hex_token(0xf6)),
    )
    .await
    .expect("the call itself succeeds")
    .expect_err("member B must not take over member A's device");
    assert_eq!(rejection, DeviceRejection::DeviceOwnedByAnotherMember);

    let revoke_rejection =
        revoke_device(&app, tenant.workspace_id, tenant.member_b, None, device_id)
            .await
            .expect("the call itself succeeds")
            .expect_err("member B must not revoke member A's device");
    assert_eq!(
        revoke_rejection,
        DeviceRejection::DeviceOwnedByAnotherMember
    );
}

/// A live token belonging to someone else is a hard stop — otherwise one account
/// could redirect another's notifications to its own device.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn an_active_token_owned_by_another_member_is_refused() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su).await;
    let shared_token = hex_token(0x17);

    register_device(
        &app,
        tenant.workspace_id,
        tenant.member_a,
        None,
        &registration(Uuid::new_v4(), &shared_token),
    )
    .await
    .expect("member A registers")
    .expect("not rejected");

    let rejection = register_device(
        &app,
        tenant.workspace_id,
        tenant.member_b,
        None,
        &registration(Uuid::new_v4(), &shared_token),
    )
    .await
    .expect("the call itself succeeds")
    .expect_err("an active token may not move to another member");
    assert_eq!(rejection, DeviceRejection::TokenOwnedByAnotherMember);
}

/// The account-switch path: after logout revokes a token, the same physical
/// device may register it to a different member. An invalidated row is
/// reclaimable — refusing it would brick the hardware for the second account.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn an_invalidated_token_is_reclaimable_after_logout() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su).await;
    let shared_token = hex_token(0x28);
    let device_a = Uuid::new_v4();

    register_device(
        &app,
        tenant.workspace_id,
        tenant.member_a,
        None,
        &registration(device_a, &shared_token),
    )
    .await
    .expect("member A registers")
    .expect("not rejected");
    revoke_device(&app, tenant.workspace_id, tenant.member_a, None, device_a)
        .await
        .expect("logout revokes")
        .expect("not rejected");

    let reclaimed = register_device(
        &app,
        tenant.workspace_id,
        tenant.member_b,
        None,
        &registration(Uuid::new_v4(), &shared_token),
    )
    .await
    .expect("member B registers the same hardware token")
    .expect("an invalidated token is reclaimable");
    assert_eq!(reclaimed.device.member_id, tenant.member_b);
}

#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn a_device_platform_cannot_change() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su).await;
    let device_id = Uuid::new_v4();

    register_device(
        &app,
        tenant.workspace_id,
        tenant.member_a,
        None,
        &registration(device_id, &hex_token(0x39)),
    )
    .await
    .expect("register as ios")
    .expect("not rejected");

    let macos = DeviceRegistration::parse(
        &device_id.to_string(),
        "macos",
        None,
        &hex_token(0x4a),
        "sandbox",
        TOPIC,
    )
    .expect("valid input");

    let rejection = register_device(&app, tenant.workspace_id, tenant.member_a, None, &macos)
        .await
        .expect("the call itself succeeds")
        .expect_err("a device's platform is immutable");
    assert_eq!(rejection, DeviceRejection::PlatformImmutable);
}

/// Listing filters to the caller. RLS keeps tenants apart; this predicate keeps
/// members apart inside one tenant.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn one_member_cannot_list_another_members_devices() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su).await;
    let device_a = Uuid::new_v4();

    register_device(
        &app,
        tenant.workspace_id,
        tenant.member_a,
        None,
        &registration(device_a, &hex_token(0x5b)),
    )
    .await
    .expect("member A registers")
    .expect("not rejected");

    let a_devices = list_devices(&app, tenant.workspace_id, tenant.member_a)
        .await
        .expect("list A")
        .expect("not rejected");
    assert_eq!(a_devices.len(), 1);
    assert_eq!(a_devices[0].id, device_a);

    let b_devices = list_devices(&app, tenant.workspace_id, tenant.member_b)
        .await
        .expect("list B")
        .expect("not rejected");
    assert!(
        b_devices.is_empty(),
        "member B must not see member A's devices"
    );
}

/// A device in another tenant is invisible, even though the caller is a valid
/// member of their own. This is the FORCE RLS backstop under `momo_app`.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn devices_do_not_cross_the_tenant_boundary() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant_one = seed_tenant(&su).await;
    let tenant_two = seed_tenant(&su).await;
    let device = Uuid::new_v4();

    register_device(
        &app,
        tenant_one.workspace_id,
        tenant_one.member_a,
        None,
        &registration(device, &hex_token(0x6c)),
    )
    .await
    .expect("tenant one registers")
    .expect("not rejected");

    // A member of tenant two asking for that device id sees nothing.
    let rejection = revoke_device(
        &app,
        tenant_two.workspace_id,
        tenant_two.member_a,
        None,
        device,
    )
    .await
    .expect("the call itself succeeds")
    .expect_err("another tenant's device must not be reachable");
    assert_eq!(
        rejection,
        DeviceRejection::DeviceNotFound,
        "RLS hides the row entirely — it is not found, not merely forbidden"
    );
}

/// The registration receipt is a suffix, never the token. A raw APNs token in a
/// response or an audit row would hand a notification-forging primitive to
/// anyone who can read either.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn the_raw_apns_token_never_leaves_the_database() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su).await;
    let device_id = Uuid::new_v4();
    let token = hex_token(0x7d);

    let outcome = register_device(
        &app,
        tenant.workspace_id,
        tenant.member_a,
        None,
        &registration(device_id, &token),
    )
    .await
    .expect("register")
    .expect("not rejected");

    let receipt = &outcome.device.push_tokens[0];
    assert_eq!(
        receipt.apns_token_suffix,
        token[token.len() - 8..],
        "the receipt is the trailing 8 characters"
    );
    assert_ne!(
        receipt.apns_token_suffix, token,
        "the receipt must not be the whole token"
    );

    // The audit row records the same suffix and nothing more.
    let detail: serde_json::Value = sqlx::query_scalar(
        "SELECT detail FROM audit_log \
          WHERE workspace_id = $1 AND action = 'device.registered' AND target_id = $2",
    )
    .bind(tenant.workspace_id)
    .bind(device_id)
    .fetch_one(&su)
    .await
    .expect("read the audit row");
    let rendered = detail.to_string();
    assert!(
        !rendered.contains(&token),
        "the raw APNs token reached an audit_log row: {rendered}"
    );
    assert_eq!(
        detail["apns_token_suffix"],
        serde_json::json!(&token[token.len() - 8..])
    );
}
