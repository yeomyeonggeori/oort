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
//!     `infra/rust/sql/bootstrap_roles.sql`, and seeds fixtures bypassing RLS;
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
//! | `a_device_left_dormant_by_logout_is_reclaimable_by_the_next_member` | refuse every device whose owner differs (the pre-#3978 check) |
//! | `a_device_retired_by_apns_is_reclaimable_too` | tie the takeover to a revoke call instead of to "no active token" |
//! | `a_taken_over_device_shows_the_new_owner_only_their_own_tokens` | drop the `d.member_id = t.member_id` join from the token read |
//! | `a_live_registration_is_not_taken_over_with_another_token` | drop the active-token test (take over unconditionally) |
//! | `a_takeover_never_changes_the_platform` | move the device before the platform check |
//! | `a_takeover_waits_for_the_device_row_lock` | drop `FOR UPDATE` from the device read |
//! | `losing_a_race_for_a_new_device_id_is_retryable` | answer every taken id with the cross-workspace rejection |
//! | `a_device_id_registered_in_another_workspace_is_a_rejection_not_a_500` | go back to `ON CONFLICT (id) DO UPDATE` |
//! | `a_token_registered_in_another_workspace_is_still_a_conflict` | (pins a known limit — see the test) |
//! | `revoking_a_device_nobody_holds_alive_is_a_404_for_anyone_else` | answer 403 for every device someone else holds (the pre-#3978 revoke), or answer 404 for the ones with a live registration too |
//! | `a_previous_owners_late_sign_out_waits_for_a_takeover_in_flight` | read the owner in `revoke_device` without `FOR UPDATE` |

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

use momo_db::migrate::{default_migrations_dir, run_migrations, SeedMode};
use momo_db::PgPool;
use momo_push::{
    list_devices, register_device, revoke_device, DeviceRegistration, DeviceRejection, PushError,
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
            "/../../../infra/rust/sql/bootstrap_roles.sql"
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
        members.push(seed_member(su, workspace_id).await);
    }

    Tenant {
        workspace_id,
        member_a: members[0],
        member_b: members[1],
    }
}

/// One more active human in `workspace_id` (#3978: the takeover race needs a
/// third person).
async fn seed_member(su: &PgPool, workspace_id: Uuid) -> Uuid {
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
    member_id
}

/// A 64-hex APNs token that is unique to `seed` **and to this process**
/// (goal SRV-B6).
///
/// It used to be `format!("{seed:02x}").repeat(32)` — a pure function of a
/// hardcoded byte. `push_token` is `UNIQUE (apns_token, env)` **globally**
/// (`001_init.sql:528`), not per workspace, so although `seed_tenant` makes a
/// fresh workspace every run, the token did not change: the second run against
/// a database that still held the first run's rows failed every case with
/// `RegistrationConflict` before a single assertion executed.
///
/// That made this suite pass exactly once per database — which is how it came
/// to be red in every `cargo test --workspace` while passing when run alone
/// against a freshly created volume.
///
/// The nonce goes at the FRONT because the receipt is the trailing 8 characters
/// (`device.rs:190`, `right(t.apns_token, 8)`): keeping the seed in the tail
/// leaves each token's suffix distinct *within* a run, which is what the
/// suffix assertions actually rest on.
fn hex_token(seed: u8) -> String {
    format!("{}{}", run_nonce(), format!("{seed:02x}").repeat(24))
}

/// 16 hex characters, drawn once per test process.
fn run_nonce() -> &'static str {
    static NONCE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    NONCE.get_or_init(|| Uuid::new_v4().simple().to_string()[..16].to_string())
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

/// #2677 — insert a `session`/`access` row the way `record_session_token`
/// does, already revoked: the state a registration meets when the phone's
/// logout commits between the auth middleware's liveness check and the
/// registration transaction.
async fn seed_ended_session_access(su: &PgPool, tenant: &Tenant) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO token \
           (workspace_id, kind, actor_member_id, token_hash, scopes, label, \
            expires_at, revoked_at) \
         VALUES ($1, 'session', $2, digest($3::text, 'sha256'), \
                 ARRAY['messages:read']::text[], 'access', \
                 now() + interval '15 minutes', now()) \
         RETURNING id",
    )
    .bind(tenant.workspace_id)
    .bind(tenant.member_a)
    .bind(Uuid::new_v4().to_string())
    .fetch_one(su)
    .await
    .expect("seed an ended session access row")
}

/// #2677 — a registration whose session ended before this transaction could
/// lock it must not commit. Logout invalidates the registrations it can see; a
/// row committed after that would outlive the session and keep the signed-out
/// phone receiving pushes.
///
/// Drop the session check from `register_device` and this goes red.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn a_registration_under_an_ended_session_is_refused() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su).await;
    let token_id = seed_ended_session_access(&su, &tenant).await;
    let device_id = Uuid::new_v4();

    let outcome = register_device(
        &app,
        tenant.workspace_id,
        tenant.member_a,
        Some(token_id),
        &registration(device_id, &hex_token(0x77)),
    )
    .await
    .expect("the registration transaction itself does not fail");
    assert_eq!(
        outcome.err(),
        Some(DeviceRejection::SessionEnded),
        "a registration made under an ended session must be refused"
    );

    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM push_token WHERE device_id = $1")
        .bind(device_id)
        .fetch_one(&su)
        .await
        .expect("count tokens");
    assert_eq!(rows, 0, "nothing was written for the refused registration");
}

// ---------------------------------------------------------------------------
// #3978 — the second member signing in on the same phone
// ---------------------------------------------------------------------------

/// Who owns the device row (superuser view, RLS bypassed).
async fn device_owner(su: &PgPool, device_id: Uuid) -> Uuid {
    sqlx::query_scalar("SELECT member_id FROM device WHERE id = $1")
        .bind(device_id)
        .fetch_one(su)
        .await
        .expect("the device row exists")
}

/// The members holding a live (`invalidated_at IS NULL`) token on the device.
async fn live_token_owners(su: &PgPool, device_id: Uuid) -> Vec<Uuid> {
    sqlx::query_scalar(
        "SELECT member_id FROM push_token \
          WHERE device_id = $1 AND invalidated_at IS NULL ORDER BY created_at",
    )
    .bind(device_id)
    .fetch_all(su)
    .await
    .expect("read live tokens")
}

async fn token_rows(su: &PgPool, device_id: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM push_token WHERE device_id = $1")
        .bind(device_id)
        .fetch_one(su)
        .await
        .expect("count token rows")
}

/// The `device.registered` audit detail written by `actor`'s registration of
/// the device.
async fn registration_audit(
    su: &PgPool,
    workspace_id: Uuid,
    device_id: Uuid,
    actor: Uuid,
) -> serde_json::Value {
    sqlx::query_scalar(
        "SELECT detail FROM audit_log \
          WHERE workspace_id = $1 AND action = 'device.registered' \
            AND target_id = $2 AND actor_member_id = $3",
    )
    .bind(workspace_id)
    .bind(device_id)
    .bind(actor)
    .fetch_one(su)
    .await
    .expect("read the registration audit row")
}

/// The issue as reported (#3978). A phone keeps ONE `deviceId` and ONE APNs
/// token per install. Member A signs in, registers and signs out; member B signs
/// in on the same install and presents the very same ids. Before #3978 the device
/// row refused B with `DeviceOwnedByAnotherMember` although nothing on it was
/// alive — only a *token* was reclaimable, and B never got that far.
///
/// The takeover is also checked from the other side: it moves the row, writes
/// the handover to the audit trail, hands B (and only B) the management of the
/// device, and flips back when B signs out and A signs in again.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn a_device_left_dormant_by_logout_is_reclaimable_by_the_next_member() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su).await;
    let device_id = Uuid::new_v4();
    let token = hex_token(0x81);

    register_device(
        &app,
        tenant.workspace_id,
        tenant.member_a,
        None,
        &registration(device_id, &token),
    )
    .await
    .expect("member A registers")
    .expect("not rejected");
    revoke_device(&app, tenant.workspace_id, tenant.member_a, None, device_id)
        .await
        .expect("member A signs out")
        .expect("not rejected");

    let taken = register_device(
        &app,
        tenant.workspace_id,
        tenant.member_b,
        None,
        &registration(device_id, &token),
    )
    .await
    .expect("member B registers the same install")
    .expect("a device with no live registration is reclaimable");
    assert!(
        !taken.created,
        "the server already knew this device id: a 200, not a 201"
    );
    assert_eq!(taken.device.member_id, tenant.member_b);
    assert_eq!(taken.device.push_tokens.len(), 1);
    assert!(
        taken.device.push_tokens[0].invalidated_at.is_none(),
        "B's registration is live"
    );

    assert_eq!(device_owner(&su, device_id).await, tenant.member_b);
    assert_eq!(
        live_token_owners(&su, device_id).await,
        vec![tenant.member_b],
        "exactly one live token on the device, and it is B's"
    );
    assert_eq!(
        token_rows(&su, device_id).await,
        1,
        "the dead row was reclaimed in place — nothing was deleted"
    );

    // The row moved: A no longer has this device, B does.
    let a_devices = list_devices(&app, tenant.workspace_id, tenant.member_a)
        .await
        .expect("list A")
        .expect("not rejected");
    assert!(a_devices.is_empty(), "the device left A's list");
    let b_devices = list_devices(&app, tenant.workspace_id, tenant.member_b)
        .await
        .expect("list B")
        .expect("not rejected");
    assert_eq!(b_devices.len(), 1);
    assert_eq!(b_devices[0].id, device_id);

    // The handover is on the record; A's own first registration was not one.
    let handover = registration_audit(&su, tenant.workspace_id, device_id, tenant.member_b).await;
    assert_eq!(handover["device_transferred"], serde_json::json!(true));
    assert_eq!(
        handover["previous_member_id"],
        serde_json::json!(tenant.member_a.to_string())
    );
    let first = registration_audit(&su, tenant.workspace_id, device_id, tenant.member_a).await;
    assert_eq!(first["device_transferred"], serde_json::json!(false));
    assert_eq!(first["previous_member_id"], serde_json::Value::Null);

    // B manages the device now; A cannot touch it while B's registration lives.
    let a_revoke = revoke_device(&app, tenant.workspace_id, tenant.member_a, None, device_id)
        .await
        .expect("the call itself succeeds")
        .expect_err("A must not revoke the device B now holds");
    assert_eq!(a_revoke, DeviceRejection::DeviceOwnedByAnotherMember);

    // And it flips back: B signs out, A signs in on the same phone again.
    revoke_device(&app, tenant.workspace_id, tenant.member_b, None, device_id)
        .await
        .expect("member B signs out")
        .expect("not rejected");
    let back = register_device(
        &app,
        tenant.workspace_id,
        tenant.member_a,
        None,
        &registration(device_id, &token),
    )
    .await
    .expect("member A signs back in")
    .expect("the device is dormant again");
    assert_eq!(back.device.member_id, tenant.member_a);
    assert_eq!(
        live_token_owners(&su, device_id).await,
        vec![tenant.member_a],
        "the live registration is A's again"
    );
}

/// "Dormant" is a state, not an event: a token the notifier retires on an APNs
/// 410/400 (`invalidated_at`, written by the BYPASSRLS notifier — here by the
/// superuser) frees the device just as a logout does. Tying the takeover to a
/// revoke *call* would leave this phone stuck.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn a_device_retired_by_apns_is_reclaimable_too() {
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
        &registration(device_id, &hex_token(0x82)),
    )
    .await
    .expect("member A registers")
    .expect("not rejected");
    sqlx::query(
        "UPDATE push_token SET invalidated_at = now(), updated_at = now() WHERE device_id = $1",
    )
    .bind(device_id)
    .execute(&su)
    .await
    .expect("the notifier retires the token (APNs 410)");

    let taken = register_device(
        &app,
        tenant.workspace_id,
        tenant.member_b,
        None,
        &registration(device_id, &hex_token(0x83)),
    )
    .await
    .expect("member B registers")
    .expect("a retired registration frees the device");
    assert_eq!(taken.device.member_id, tenant.member_b);
    assert_eq!(
        live_token_owners(&su, device_id).await,
        vec![tenant.member_b]
    );
}

/// A device that changed hands keeps the previous owner's dead token rows —
/// revocation is never a DELETE — but they are not the new owner's to see: a
/// token receipt is a suffix of someone's hardware token plus when it was
/// registered and retired. Here A's token rotated once and A then signed out; B
/// signs in with a third token and must be shown that one only.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn a_taken_over_device_shows_the_new_owner_only_their_own_tokens() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su).await;
    let device_id = Uuid::new_v4();
    let (first, second, third) = (hex_token(0x84), hex_token(0x85), hex_token(0x86));

    for token in [&first, &second] {
        register_device(
            &app,
            tenant.workspace_id,
            tenant.member_a,
            None,
            &registration(device_id, token),
        )
        .await
        .expect("member A registers (the second call rotates the token)")
        .expect("not rejected");
    }
    revoke_device(&app, tenant.workspace_id, tenant.member_a, None, device_id)
        .await
        .expect("member A signs out")
        .expect("not rejected");

    let taken = register_device(
        &app,
        tenant.workspace_id,
        tenant.member_b,
        None,
        &registration(device_id, &third),
    )
    .await
    .expect("member B registers")
    .expect("not rejected");

    assert_eq!(
        token_rows(&su, device_id).await,
        3,
        "A's two dead rows are kept, next to B's live one"
    );
    let shown: Vec<&str> = taken
        .device
        .push_tokens
        .iter()
        .map(|t| t.apns_token_suffix.as_str())
        .collect();
    assert_eq!(
        shown,
        vec![&third[third.len() - 8..]],
        "B is shown B's token only"
    );
    let listed = list_devices(&app, tenant.workspace_id, tenant.member_b)
        .await
        .expect("list B")
        .expect("not rejected");
    assert_eq!(listed[0].push_tokens.len(), 1, "the list agrees");
}

/// The hijack boundary. A is signed in on the phone and her registration is
/// live; B presents A's `deviceId`. Dormancy is "no active token", so B is
/// refused — with another token (the device check decides) and with A's own
/// (the token check would also). Nothing moves, nothing is written for B. If
/// this ever passes with B in, one member can switch off another's push by
/// guessing nothing but an id.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn a_live_registration_is_not_taken_over_with_another_token() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su).await;
    let device_id = Uuid::new_v4();
    let token_a = hex_token(0x87);
    let token_b = hex_token(0x88);

    register_device(
        &app,
        tenant.workspace_id,
        tenant.member_a,
        None,
        &registration(device_id, &token_a),
    )
    .await
    .expect("member A registers")
    .expect("not rejected");

    for token in [&token_b, &token_a] {
        let rejection = register_device(
            &app,
            tenant.workspace_id,
            tenant.member_b,
            None,
            &registration(device_id, token),
        )
        .await
        .expect("the call itself succeeds")
        .expect_err("a live registration is not taken over");
        assert_eq!(rejection, DeviceRejection::DeviceOwnedByAnotherMember);
    }

    assert_eq!(device_owner(&su, device_id).await, tenant.member_a);
    assert_eq!(
        live_token_owners(&su, device_id).await,
        vec![tenant.member_a],
        "A's registration is untouched"
    );
    assert_eq!(
        token_rows(&su, device_id).await,
        1,
        "nothing was written for B"
    );
}

/// Taking over a dormant device still obeys the platform's immutability: the
/// check runs before the row moves, so a refused registration leaves the device
/// with its previous owner.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn a_takeover_never_changes_the_platform() {
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
        &registration(device_id, &hex_token(0x89)),
    )
    .await
    .expect("member A registers as ios")
    .expect("not rejected");
    revoke_device(&app, tenant.workspace_id, tenant.member_a, None, device_id)
        .await
        .expect("member A signs out")
        .expect("not rejected");

    let macos = DeviceRegistration::parse(
        &device_id.to_string(),
        "macos",
        None,
        &hex_token(0x8a),
        "sandbox",
        TOPIC,
    )
    .expect("valid input");
    let rejection = register_device(&app, tenant.workspace_id, tenant.member_b, None, &macos)
        .await
        .expect("the call itself succeeds")
        .expect_err("the platform of a device is immutable, takeover or not");
    assert_eq!(rejection, DeviceRejection::PlatformImmutable);
    assert_eq!(
        device_owner(&su, device_id).await,
        tenant.member_a,
        "the refused registration did not move the device"
    );
    assert!(live_token_owners(&su, device_id).await.is_empty());
}

/// Two sign-ins racing for one dormant device take turns, and the second sees
/// the first one's live token.
///
/// The race, made deterministic: a transaction holds the device row lock — it is
/// "member C, already mid-registration" — and while B's registration waits on
/// it, C commits the takeover (device moved, live token written). B must then
/// see an owner with a live token and be refused. With no row lock in B's read
/// B would not wait at the read: it would judge the device dormant from the
/// committed state, queue up behind C only at its UPDATE, and then take the
/// device back from C — the mixed-owner pair this suite exists to prevent.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn a_takeover_waits_for_the_device_row_lock() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su).await;
    let member_c = seed_member(&su, tenant.workspace_id).await;
    let device_id = Uuid::new_v4();

    register_device(
        &app,
        tenant.workspace_id,
        tenant.member_a,
        None,
        &registration(device_id, &hex_token(0x8b)),
    )
    .await
    .expect("member A registers")
    .expect("not rejected");
    revoke_device(&app, tenant.workspace_id, tenant.member_a, None, device_id)
        .await
        .expect("member A signs out")
        .expect("not rejected");

    // C is mid-registration: holds the device row.
    let mut holder = su.begin().await.expect("open C's transaction");
    sqlx::query("SELECT 1 FROM device WHERE id = $1 FOR UPDATE")
        .bind(device_id)
        .fetch_one(&mut *holder)
        .await
        .expect("C locks the device row");

    let b = tokio::spawn({
        let app = app.clone();
        let workspace_id = tenant.workspace_id;
        let member_b = tenant.member_b;
        let registration = registration(device_id, &hex_token(0x8c));
        async move { register_device(&app, workspace_id, member_b, None, &registration).await }
    });
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert!(
        !b.is_finished(),
        "B's registration must be waiting for C, not deciding on its own"
    );

    // C finishes: the device is C's and C's registration is live.
    sqlx::query("UPDATE device SET member_id = $2 WHERE id = $1")
        .bind(device_id)
        .bind(member_c)
        .execute(&mut *holder)
        .await
        .expect("C takes the device");
    sqlx::query(
        "INSERT INTO push_token (workspace_id, device_id, member_id, apns_token, env, topic) \
         VALUES ($1, $2, $3, $4, 'sandbox'::push_env, $5)",
    )
    .bind(tenant.workspace_id)
    .bind(device_id)
    .bind(member_c)
    .bind(hex_token(0x8d))
    .bind(TOPIC)
    .execute(&mut *holder)
    .await
    .expect("C's token goes live");
    holder.commit().await.expect("C commits");

    let outcome = b
        .await
        .expect("B's task finishes")
        .expect("the call itself succeeds");
    assert_eq!(
        outcome.err(),
        Some(DeviceRejection::DeviceOwnedByAnotherMember),
        "B arrived after C's live registration committed and must not take it"
    );
    assert_eq!(device_owner(&su, device_id).await, member_c);
    assert_eq!(live_token_owners(&su, device_id).await, vec![member_c]);
}

/// Losing a race for a *new* device id is retryable, not a verdict. The same
/// kind of lock holder, but the row it is inserting does not exist yet: B's
/// first look finds nothing, B's insert waits on the unique key, and when the
/// other registration commits the id is taken by a row B can now see. That is
/// `RegistrationConflict` (409 — the phone retries, and the retry goes through
/// the ordinary path). Answering it with the cross-workspace rejection would be
/// a terminal 403 for a registration that merely lost a coin toss.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn losing_a_race_for_a_new_device_id_is_retryable() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su).await;
    let member_c = seed_member(&su, tenant.workspace_id).await;
    let device_id = Uuid::new_v4();

    // C is mid-registration of a device id nobody has registered yet.
    let mut holder = su.begin().await.expect("open C's transaction");
    sqlx::query(
        "INSERT INTO device (id, workspace_id, member_id, platform) \
         VALUES ($1, $2, $3, 'ios'::device_platform)",
    )
    .bind(device_id)
    .bind(tenant.workspace_id)
    .bind(member_c)
    .execute(&mut *holder)
    .await
    .expect("C inserts the device row (uncommitted)");

    let b = tokio::spawn({
        let app = app.clone();
        let workspace_id = tenant.workspace_id;
        let member_b = tenant.member_b;
        let registration = registration(device_id, &hex_token(0x8e));
        async move { register_device(&app, workspace_id, member_b, None, &registration).await }
    });
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert!(
        !b.is_finished(),
        "B's insert must be waiting on C's uncommitted row"
    );
    holder.commit().await.expect("C commits");

    let outcome = b.await.expect("B's task finishes");
    assert!(
        matches!(outcome, Err(PushError::RegistrationConflict)),
        "the loser of the race is told to retry, got {outcome:?}"
    );
    assert_eq!(device_owner(&su, device_id).await, member_c);
    assert_eq!(
        token_rows(&su, device_id).await,
        0,
        "nothing was written for the loser"
    );
}

/// Another workspace's device id is a rejection, not a crash. A phone that
/// signs out of workspace one and into workspace two presents the same
/// `deviceId`; `device.id` is a global primary key and row-level security hides
/// workspace one's row from workspace two's transaction, so it can be neither
/// moved nor overwritten from there (and `BYPASSRLS` is not an option on the
/// write path). Before #3978 that surfaced as `Db(42501)`, a 500 the phone does
/// not retry and nobody can read; now it is a 403 with its own message.
///
/// Dormancy does not matter across the boundary: A has signed out here, and the
/// device is still out of reach.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn a_device_id_registered_in_another_workspace_is_a_rejection_not_a_500() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let one = seed_tenant(&su).await;
    let two = seed_tenant(&su).await;
    let device_id = Uuid::new_v4();
    let token = hex_token(0x8f);

    register_device(
        &app,
        one.workspace_id,
        one.member_a,
        None,
        &registration(device_id, &token),
    )
    .await
    .expect("workspace one registers")
    .expect("not rejected");
    revoke_device(&app, one.workspace_id, one.member_a, None, device_id)
        .await
        .expect("workspace one signs out")
        .expect("not rejected");

    for presented in [&token, &hex_token(0x90)] {
        let rejection = register_device(
            &app,
            two.workspace_id,
            two.member_a,
            None,
            &registration(device_id, presented),
        )
        .await
        .expect("the call itself succeeds — it used to be Err(Db(42501)), a 500")
        .expect_err("another workspace's device id is out of reach");
        assert_eq!(rejection, DeviceRejection::DeviceInAnotherWorkspace);
    }

    let device_rows_in_two: i64 =
        sqlx::query_scalar("SELECT count(*) FROM device WHERE workspace_id = $1")
            .bind(two.workspace_id)
            .fetch_one(&su)
            .await
            .expect("count devices in workspace two");
    let token_rows_in_two: i64 =
        sqlx::query_scalar("SELECT count(*) FROM push_token WHERE workspace_id = $1")
            .bind(two.workspace_id)
            .fetch_one(&su)
            .await
            .expect("count tokens in workspace two");
    assert_eq!(
        (device_rows_in_two, token_rows_in_two),
        (0, 0),
        "nothing was written in the workspace that was refused"
    );
    assert_eq!(
        device_owner(&su, device_id).await,
        one.member_a,
        "workspace one's device is where it was"
    );
    assert!(live_token_owners(&su, device_id).await.is_empty());
}

/// KNOWN LIMIT, pinned on purpose (#3978, decision pending). `push_token
/// (apns_token, env)` is UNIQUE across *all* workspaces (schema_v0
/// `push_token_uniq`), and row-level security hides the other workspace's row,
/// so a phone that moves to another workspace cannot register its APNs token
/// there even under a fresh `deviceId`: the insert finds the token taken and the
/// outcome is the retryable conflict — forever. Fixing it means relaxing that
/// constraint for invalidated rows, which is a database-contract change and not
/// this issue's to make. When someone does, this test is what they update.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn a_token_registered_in_another_workspace_is_still_a_conflict() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let one = seed_tenant(&su).await;
    let two = seed_tenant(&su).await;
    let token = hex_token(0x92);

    let first = Uuid::new_v4();
    register_device(
        &app,
        one.workspace_id,
        one.member_a,
        None,
        &registration(first, &token),
    )
    .await
    .expect("workspace one registers")
    .expect("not rejected");
    revoke_device(&app, one.workspace_id, one.member_a, None, first)
        .await
        .expect("workspace one signs out")
        .expect("not rejected");

    let outcome = register_device(
        &app,
        two.workspace_id,
        two.member_a,
        None,
        &registration(Uuid::new_v4(), &token),
    )
    .await;
    assert!(
        matches!(outcome, Err(PushError::RegistrationConflict)),
        "the same APNs token in another workspace is a conflict, got {outcome:?}"
    );
}

/// Revoking a device that is not yours. With a live registration on it the
/// answer is the 403 it always was. With none (its owner has signed out) it is
/// the 404 an id the server never saw gets (#3978): there is nothing there to
/// switch off, the next register of that id would take the device, and a 403
/// would tell a caller who merely knows an id that such a device exists — the
/// non-disclosure #4233 asks of attachments. The phone reads that 404 as
/// "already off" (`revokeOwnDevice` → `gone`), which is true. Nothing is written
/// either way.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn revoking_a_device_nobody_holds_alive_is_a_404_for_anyone_else() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su).await;
    let device_id = Uuid::new_v4();
    let token = hex_token(0x93);

    register_device(
        &app,
        tenant.workspace_id,
        tenant.member_a,
        None,
        &registration(device_id, &token),
    )
    .await
    .expect("member A registers")
    .expect("not rejected");

    // A is signed in: the device is live, and B is told it is not his.
    let live = revoke_device(&app, tenant.workspace_id, tenant.member_b, None, device_id)
        .await
        .expect("the call itself succeeds")
        .expect_err("B must not revoke A's live device");
    assert_eq!(live, DeviceRejection::DeviceOwnedByAnotherMember);

    revoke_device(&app, tenant.workspace_id, tenant.member_a, None, device_id)
        .await
        .expect("member A signs out")
        .expect("not rejected");

    let dormant = revoke_device(&app, tenant.workspace_id, tenant.member_b, None, device_id)
        .await
        .expect("the call itself succeeds")
        .expect_err("nothing of A's is live: not B's to revoke");
    let unknown = revoke_device(
        &app,
        tenant.workspace_id,
        tenant.member_b,
        None,
        Uuid::new_v4(),
    )
    .await
    .expect("the call itself succeeds")
    .expect_err("an id the server never saw");
    assert_eq!(dormant, DeviceRejection::DeviceNotFound);
    assert_eq!(
        dormant, unknown,
        "B cannot tell a dormant device from an id the server never saw"
    );

    // Nothing moved and nothing was written for B.
    assert_eq!(device_owner(&su, device_id).await, tenant.member_a);
    assert_eq!(token_rows(&su, device_id).await, 1);
    let revokes_by_b: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log \
          WHERE workspace_id = $1 AND action = 'device.revoked' AND actor_member_id = $2",
    )
    .bind(tenant.workspace_id)
    .bind(tenant.member_b)
    .fetch_one(&su)
    .await
    .expect("count B's revoke audit rows");
    assert_eq!(revokes_by_b, 0, "a refused revoke leaves no audit row");

    // The refusal follows liveness, not history: once B holds the device with a
    // registration of his own, A — its former owner — is the one told no.
    register_device(
        &app,
        tenant.workspace_id,
        tenant.member_b,
        None,
        &registration(device_id, &token),
    )
    .await
    .expect("member B registers the same install")
    .expect("a device with no live registration is reclaimable");
    let former_owner = revoke_device(&app, tenant.workspace_id, tenant.member_a, None, device_id)
        .await
        .expect("the call itself succeeds")
        .expect_err("A must not revoke the device B now holds alive");
    assert_eq!(former_owner, DeviceRejection::DeviceOwnedByAnotherMember);
}

/// Is some backend queued behind `holder_pid` on a lock? Polled for up to ten
/// seconds, so that "the request is waiting" is *observed* in `pg_stat_activity`
/// and not guessed from a sleep.
async fn a_backend_waits_for(su: &PgPool, holder_pid: i32) -> bool {
    for _ in 0..100 {
        let waiting: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))",
        )
        .bind(holder_pid)
        .fetch_one(su)
        .await
        .expect("read pg_stat_activity");
        if waiting > 0 {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

/// Ownership can move now, and a sign-out is a *read* of the owner followed by a
/// *write* to the tokens. The previous owner's sign-out request arriving late
/// (the phone's `DELETE` is best-effort and retried) must not run that write on
/// the registration of the member who took the device in between.
///
/// Made deterministic: a transaction holds the device row lock — "member C,
/// mid-takeover" — and A's late sign-out is sent while C holds it. As far as the
/// committed rows go the device is still A's. A's sign-out must queue behind C
/// (checked in `pg_stat_activity`, not by a sleep) and, once C's takeover
/// commits, read the owner again: C, with a live registration, so A is refused
/// and C's registration is untouched. Without the row lock A's owner check
/// passes at once, its token `UPDATE` runs on a snapshot taken after C
/// commits, and it invalidates C's live token while answering with C's device.
#[tokio::test]
#[ignore = "needs DATABASE_URL to a pgvector/pg18 DB + momo_app role"]
async fn a_previous_owners_late_sign_out_waits_for_a_takeover_in_flight() {
    ensure_schema_and_roles();
    let su = superuser_pool().await;
    let app = momo_app_pool().await;
    let tenant = seed_tenant(&su).await;
    let member_c = seed_member(&su, tenant.workspace_id).await;
    let device_id = Uuid::new_v4();

    register_device(
        &app,
        tenant.workspace_id,
        tenant.member_a,
        None,
        &registration(device_id, &hex_token(0x94)),
    )
    .await
    .expect("member A registers")
    .expect("not rejected");
    revoke_device(&app, tenant.workspace_id, tenant.member_a, None, device_id)
        .await
        .expect("member A signs out")
        .expect("not rejected");

    // C is mid-takeover: holds the device row.
    let mut holder = su.begin().await.expect("open C's transaction");
    let holder_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *holder)
        .await
        .expect("read C's backend pid");
    sqlx::query("SELECT 1 FROM device WHERE id = $1 FOR UPDATE")
        .bind(device_id)
        .fetch_one(&mut *holder)
        .await
        .expect("C locks the device row");

    // A's sign-out arrives late.
    let a = tokio::spawn({
        let app = app.clone();
        let workspace_id = tenant.workspace_id;
        let member_a = tenant.member_a;
        async move { revoke_device(&app, workspace_id, member_a, None, device_id).await }
    });
    assert!(
        a_backend_waits_for(&su, holder_pid).await,
        "A's sign-out must queue behind C's row lock, not read an owner that is about to change"
    );
    assert!(!a.is_finished(), "and it has not decided anything yet");

    // C finishes: the device is C's and C's registration is live.
    sqlx::query("UPDATE device SET member_id = $2 WHERE id = $1")
        .bind(device_id)
        .bind(member_c)
        .execute(&mut *holder)
        .await
        .expect("C takes the device");
    sqlx::query(
        "INSERT INTO push_token (workspace_id, device_id, member_id, apns_token, env, topic) \
         VALUES ($1, $2, $3, $4, 'sandbox'::push_env, $5)",
    )
    .bind(tenant.workspace_id)
    .bind(device_id)
    .bind(member_c)
    .bind(hex_token(0x95))
    .bind(TOPIC)
    .execute(&mut *holder)
    .await
    .expect("C's token goes live");
    holder.commit().await.expect("C commits");

    let outcome = a
        .await
        .expect("A's task finishes")
        .expect("the call itself succeeds");
    assert_eq!(
        outcome.err(),
        Some(DeviceRejection::DeviceOwnedByAnotherMember),
        "A arrived after C's live registration committed and must not touch it"
    );
    assert_eq!(
        live_token_owners(&su, device_id).await,
        vec![member_c],
        "C's registration survived A's late sign-out"
    );
    assert_eq!(device_owner(&su, device_id).await, member_c);
    let revokes_by_a: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log \
          WHERE workspace_id = $1 AND action = 'device.revoked' \
            AND target_id = $2 AND actor_member_id = $3",
    )
    .bind(tenant.workspace_id)
    .bind(device_id)
    .bind(tenant.member_a)
    .fetch_one(&su)
    .await
    .expect("count A's revoke audit rows");
    assert_eq!(
        revokes_by_a, 1,
        "only A's real sign-out is on the record; the late one wrote nothing"
    );
}
