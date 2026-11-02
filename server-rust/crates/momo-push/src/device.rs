//! Device / push-token registration lifecycle (ADR-0120 D4).
//!
//! Port of `server/Sources/MomoServer/Routes/DeviceRoutes.swift`. The route
//! layer owns HTTP; every statement lives here.
//!
//! The four contracts the Swift original establishes, all preserved:
//!
//! 1. **Actor binding** — a member may only touch their own device and their
//!    own active token. Another member's *active* token is a hard 403, and so is
//!    another member's device **while it still holds a live registration** (an
//!    active token on it). A registration that is dead — signed out, revoked, or
//!    retired by APNs — frees what it held: an *invalidated* token is
//!    reclaimable, and so is a device whose tokens are all invalidated (#3978).
//!    That is the account-switch-on-the-same-phone path, and it needs both: the
//!    phone keeps one `deviceId` and one APNs token per install, so the second
//!    member presents the very ids the first one left behind.
//! 2. **Idempotent upsert** — re-registering a client-stable `deviceId`
//!    refreshes liveness and rotates the token. Every other still-active token
//!    on the same `(device, env)` is invalidated **in the same transaction and
//!    before the upsert**, so the 010 partial unique index
//!    (`push_token_device_env_active_uniq`) always holds.
//! 3. **Revocation is `invalidated_at`, never `DELETE`** —
//!    `push_dispatch_log.push_token_id` must keep resolving, and APNs 410/400
//!    handling writes the same column.
//! 4. **The raw `apns_token` never leaves PostgreSQL** — responses and audit
//!    rows carry only the trailing 8 characters, computed by `right()` in SQL.
//!
//! And one this server adds (#2677):
//!
//! 5. **A registration lives as long as the session that made it.** Each token
//!    row records the lineage (`token.session_id`) of the session it was
//!    registered under. Ending that session — logout, a linked-device
//!    disconnect — invalidates the rows of that lineage
//!    ([`invalidate_session_push_tokens_in_tx`]); ending every session of a
//!    member — password change or reset, suspension, removal, leaving —
//!    invalidates all of the member's ([`invalidate_member_push_tokens_in_tx`]).
//!    Rotating a session ends nothing. The judgment SQL is untouched: it already
//!    skips invalidated rows, and the notifier gains no access to `token`.
//!
//! And one more from #3978:
//!
//! 6. **A handed-over device is the new owner's alone.** Taking over a dormant
//!    device (contract 1) moves the `device` row. The previous owner's dead
//!    token rows stay theirs — kept, never deleted (contract 3); only a token
//!    the new owner presents again is reclaimed, as ever — and the new owner is
//!    not shown them ([`load_tokens_in_tx`] reads a device's tokens only where
//!    the token's member is the device's member). The device row is locked
//!    *before* the dormancy test, so two sign-ins racing for one dormant device
//!    take turns and the second sees the first's live token. A device id taken
//!    by a row in **another workspace** cannot be moved from here — row-level
//!    security hides that row from this transaction, and the id is a global
//!    primary key — so it is a deliberate rejection
//!    ([`DeviceRejection::DeviceInAnotherWorkspace`]), never an RLS error.
//!    [`revoke_device`] takes the same row lock before it reads the owner, so a
//!    previous owner's late sign-out waits behind a takeover instead of hitting
//!    the new owner's registration, and it answers 404 — not 403 — for a device
//!    that someone else holds without a live registration: nobody's to revoke,
//!    and no hint to a caller who merely knows the id that such a device exists.
//!
//! And one from #5091 (ADR-0206 증보 4 G1):
//!
//! 7. **A member keeps at most [`MEMBER_MAX_ACTIVE_TOKENS`] live registrations.**
//!    Every push a member is owed is one relay call per live token, and a phone
//!    makes a new `deviceId` (and so a new live registration) with every install,
//!    so the number of live tokens is the requester's to choose. A registration
//!    that leaves a member above the cap invalidates the **stalest** live tokens
//!    (`updated_at`, the order [`crate::system_targets`] uses) — never the one just
//!    registered, never a row delete (contract 3), never a rejection: the phone
//!    that is being set up always works, and nothing about the response or its
//!    errors changes. It runs on **every** successful registration, so a member
//!    who was above the cap before this rule converges at the next one.
//!    A member's registrations take a transaction-scoped advisory lock **before
//!    any row lock** ([`MEMBER_REGISTRATION_LOCK_SQL`]), so the count each one
//!    trims against includes everything an earlier one committed: without it K
//!    concurrent registrations each trim a snapshot that excludes the others and
//!    leave `cap + K - 1` live tokens, which only the member's next registration
//!    would undo. Nothing else takes that lock and it is always the first one
//!    taken, so it cannot be part of a lock cycle.
//!    The wait is **bounded**: a registration waits at most
//!    [`REGISTRATION_LOCK_WAIT_SECS`] for any lock (`lock_timeout`, local to the
//!    transaction), and losing a lock race — `55P03` or a deadlock `40P01` — is the
//!    409 the phone already retries ([`PushError::RegistrationConflict`]), nothing
//!    committed. A queued request holds its pool connection while it waits, and one
//!    member's burst is the requester's to size, so without the bound it would hold
//!    the pool every other request shares (#5091 review M-1).

use chrono::{DateTime, Utc};
use momo_auth::{lock_session_for_registration, RegistrationSession};
use momo_db::{with_tenant_tx_prelude, DbError, PgPool};
use momo_messaging::active_workspace_role;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::error::{
    classify_registration_write, lock_race_is_a_conflict, DeviceInputError, DeviceRejection,
    PushError,
};

// ---------------------------------------------------------------------------
// Validated input
// ---------------------------------------------------------------------------

/// A registration request whose fields have all passed the Swift validators.
///
/// Constructing this is the only way to reach [`register_device`], so an
/// unvalidated token cannot reach the database.
#[derive(Debug, Clone)]
pub struct DeviceRegistration {
    pub device_id: Uuid,
    pub platform: String,
    pub app_build: Option<String>,
    pub apns_token: String,
    pub env: String,
    pub topic: String,
}

impl DeviceRegistration {
    /// Validate and normalize a raw request body.
    ///
    /// Parity: `DeviceRoutes.swift:384-439`.
    pub fn parse(
        device_id: &str,
        platform: &str,
        app_build: Option<&str>,
        apns_token: &str,
        env: &str,
        topic: &str,
    ) -> Result<Self, DeviceInputError> {
        Ok(DeviceRegistration {
            device_id: parse_device_id(device_id)?,
            platform: normalized_platform(platform)?,
            app_build: validated_app_build(app_build)?,
            apns_token: normalized_apns_token(apns_token)?,
            env: normalized_env(env)?,
            topic: normalized_topic(topic)?,
        })
    }
}

fn parse_device_id(raw: &str) -> Result<Uuid, DeviceInputError> {
    Uuid::parse_str(raw.trim()).map_err(|_| DeviceInputError::DeviceId)
}

fn normalized_platform(raw: &str) -> Result<String, DeviceInputError> {
    let value = raw.trim().to_ascii_lowercase();
    match value.as_str() {
        "ios" | "macos" => Ok(value),
        _ => Err(DeviceInputError::Platform),
    }
}

fn normalized_env(raw: &str) -> Result<String, DeviceInputError> {
    let value = raw.trim().to_ascii_lowercase();
    match value.as_str() {
        "sandbox" | "production" => Ok(value),
        _ => Err(DeviceInputError::Env),
    }
}

/// APNs device tokens are hex — 64 chars today, but Apple documents the length
/// as variable, so a generous range is allowed. Lowercased so the
/// `UNIQUE (apns_token, env)` arbitration is case-stable.
fn normalized_apns_token(raw: &str) -> Result<String, DeviceInputError> {
    let value = raw.trim().to_ascii_lowercase();
    let length_ok = (16..=512).contains(&value.chars().count());
    let hex_ok = value.chars().all(|c| c.is_ascii_hexdigit());
    if length_ok && hex_ok {
        Ok(value)
    } else {
        Err(DeviceInputError::ApnsToken)
    }
}

fn normalized_topic(raw: &str) -> Result<String, DeviceInputError> {
    let value = raw.trim().to_string();
    let clean = value
        .chars()
        .all(|c| !c.is_whitespace() && (c as u32) >= 0x20 && (c as u32) != 0x7F);
    if !value.is_empty() && value.chars().count() <= 256 && clean {
        Ok(value)
    } else {
        Err(DeviceInputError::Topic)
    }
}

fn validated_app_build(raw: Option<&str>) -> Result<Option<String>, DeviceInputError> {
    let Some(raw) = raw else { return Ok(None) };
    let value = raw.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.chars().count() > 64 {
        return Err(DeviceInputError::AppBuild);
    }
    Ok(Some(value.to_string()))
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/// One registered push token, as it may be shown to its owner.
///
/// There is no `apns_token` field — only [`Self::apns_token_suffix`]. The raw
/// token is never selected out of PostgreSQL, so it is not merely omitted from
/// the wire DTO: it is unrepresentable this far out.
#[derive(Debug, Clone)]
pub struct PushTokenRecord {
    pub id: Uuid,
    pub device_id: Uuid,
    pub env: String,
    pub topic: String,
    pub apns_token_suffix: String,
    pub invalidated_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct DeviceRecord {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub member_id: Uuid,
    pub platform: String,
    pub app_build: Option<String>,
    pub last_seen_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub push_tokens: Vec<PushTokenRecord>,
}

/// Outcome of a registration: `created` drives `201` vs `200`.
#[derive(Debug, Clone)]
pub struct RegisterOutcome {
    pub device: DeviceRecord,
    pub created: bool,
}

/// Outcome of a revocation. `invalidated` is how many tokens **this call**
/// flipped — `0` on an idempotent repeat. Rows are never deleted.
#[derive(Debug, Clone)]
pub struct RevokeOutcome {
    pub device: DeviceRecord,
    pub invalidated: u64,
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async fn load_tokens_in_tx(
    conn: &mut PgConnection,
    device_ids: &[Uuid],
) -> Result<Vec<PushTokenRecord>, DbError> {
    // `right(apns_token, 8)` is the only projection of the token column that
    // ever leaves the database.
    //
    // The join to `device` on the token's member is #3978 contract 6: a device
    // that changed hands keeps the previous owner's dead rows (never deleted),
    // and those are not the new owner's to see.
    let rows = sqlx::query(
        "SELECT t.id, t.device_id, t.env::text AS env, t.topic, \
                right(t.apns_token, 8) AS apns_token_suffix, \
                t.invalidated_at, t.created_at, t.updated_at \
           FROM push_token t \
           JOIN device d ON d.id = t.device_id AND d.member_id = t.member_id \
          WHERE t.device_id = ANY($1) \
          ORDER BY t.created_at, t.id",
    )
    .bind(device_ids)
    .fetch_all(&mut *conn)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| PushTokenRecord {
            id: row.get("id"),
            device_id: row.get("device_id"),
            env: row.get("env"),
            topic: row.get("topic"),
            apns_token_suffix: row.get("apns_token_suffix"),
            invalidated_at: row.get("invalidated_at"),
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
        })
        .collect())
}

async fn assemble_devices(
    conn: &mut PgConnection,
    rows: Vec<sqlx::postgres::PgRow>,
) -> Result<Vec<DeviceRecord>, DbError> {
    let ids: Vec<Uuid> = rows.iter().map(|row| row.get::<Uuid, _>("id")).collect();
    let tokens = load_tokens_in_tx(conn, &ids).await?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let id: Uuid = row.get("id");
            DeviceRecord {
                id,
                workspace_id: row.get("workspace_id"),
                member_id: row.get("member_id"),
                platform: row.get("platform"),
                app_build: row.get("app_build"),
                last_seen_at: row.get("last_seen_at"),
                created_at: row.get("created_at"),
                push_tokens: tokens
                    .iter()
                    .filter(|token| token.device_id == id)
                    .cloned()
                    .collect(),
            }
        })
        .collect())
}

const DEVICE_COLUMNS: &str = "d.id, d.workspace_id, d.member_id, d.platform::text AS platform, \
                              d.app_build, d.last_seen_at, d.created_at";

async fn load_device_in_tx(
    conn: &mut PgConnection,
    device_id: Uuid,
) -> Result<Option<DeviceRecord>, DbError> {
    let rows = sqlx::query(&format!(
        "SELECT {DEVICE_COLUMNS} FROM device d WHERE d.id = $1"
    ))
    .bind(device_id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(assemble_devices(conn, rows).await?.into_iter().next())
}

/// List the caller's **own** devices. The `member_id` predicate is what keeps
/// one member from enumerating another's hardware, on top of RLS keeping one
/// tenant out of another's.
pub async fn list_devices(
    pool: &PgPool,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<Result<Vec<DeviceRecord>, DeviceRejection>, PushError> {
    tenant_tx(pool, workspace_id, move |conn| {
        Box::pin(async move {
            if let Err(rejection) = require_active_member(conn, workspace_id, member_id).await? {
                return Ok(Err(rejection));
            }
            let rows = sqlx::query(&format!(
                "SELECT {DEVICE_COLUMNS} FROM device d \
                  WHERE d.member_id = $1 \
                  ORDER BY d.created_at, d.id"
            ))
            .bind(member_id)
            .fetch_all(&mut *conn)
            .await
            .map_err(DbError::from)?;
            Ok(Ok(assemble_devices(conn, rows).await?))
        })
    })
    .await
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

/// The most live (`invalidated_at IS NULL`) push tokens one member keeps — contract 7 above,
/// ADR-0206 증보 4 G1.
///
/// Ten is room for a person's phones, tablet and Macs with a development and a store build among
/// them, plus the dead registrations a reinstall leaves behind until APNs says 410; it is above
/// [`crate::SYSTEM_PUSH_MAX_TARGETS`] on purpose (a test push still reaches the five freshest).
/// Past it, the stalest registrations are invalidated by the registration that crossed the line.
pub const MEMBER_MAX_ACTIVE_TOKENS: i64 = 10;

/// How long one registration waits for a lock — the member's registration lock, a device row, a
/// token row, the session row — before it gives up as a retryable 409 (ADR-0206 증보 4 G1, #5091
/// review M-1). The bound is `lock_timeout`, set local to the registration's transaction; the same
/// three seconds a scheduled-message request waits on the scheduler's locks.
pub const REGISTRATION_LOCK_WAIT_SECS: u64 = 3;

/// The statement every registration runs first: it queues a member's registrations behind one
/// another until the transaction that holds the lock ends. Bound with
/// [`member_registration_lock_key`]. `pub` (and hidden) only so a conformance test can hold the
/// very same lock from a second connection and watch a registration wait on it.
#[doc(hidden)]
pub const MEMBER_REGISTRATION_LOCK_SQL: &str =
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))";

/// The text [`MEMBER_REGISTRATION_LOCK_SQL`] hashes: one (workspace, member), nothing else — a
/// lock keyed by the device would let two devices of one member each trim a stale count.
#[doc(hidden)]
pub fn member_registration_lock_key(workspace_id: Uuid, member_id: Uuid) -> String {
    format!("momo.push_token.member:{workspace_id}:{member_id}")
}

/// Keep a member at [`MEMBER_MAX_ACTIVE_TOKENS`] live tokens by invalidating the stalest ones,
/// sparing the token this registration just wrote. Binds: `$1` workspace, `$2` member, `$3` the
/// token just written, `$4` the cap; the rows affected are the tokens it invalidated.
///
/// The order is `updated_at DESC, id DESC` — the one [`crate::system_targets`] picks the freshest
/// devices by — so what a test push does not reach is what goes first. The registering token is
/// ranked first **explicitly**: `updated_at` is the transaction's start time, and a registration
/// that began earlier but committed later than another one would otherwise be ranked below it and
/// could invalidate the very phone being set up. Rows are kept (contract 3). The tenant and the
/// member are both named: the member predicate is what keeps one member's registration off
/// another member's tokens, and the cap is per member.
const EVICT_STALEST_SQL: &str = "UPDATE push_token \
        SET invalidated_at = now(), updated_at = now() \
      WHERE id IN ( \
        SELECT id FROM push_token \
         WHERE workspace_id = $1 \
           AND member_id = $2 \
           AND invalidated_at IS NULL \
         ORDER BY (id = $3) DESC, updated_at DESC, id DESC \
        OFFSET $4)";

/// Register (or re-register) a device and rotate its push token.
///
/// The whole sequence is one tenant transaction, which is what makes the
/// rotation safe: siblings are invalidated *before* the incoming token is
/// upserted, so the 010 partial unique index is never transiently violated.
pub async fn register_device(
    pool: &PgPool,
    workspace_id: Uuid,
    member_id: Uuid,
    via_token_id: Option<Uuid>,
    registration: &DeviceRegistration,
) -> Result<Result<RegisterOutcome, DeviceRejection>, PushError> {
    let registration = registration.clone();
    tenant_tx(pool, workspace_id, move |conn| {
        Box::pin(async move {
            // `lock_timeout` first, so that every lock this transaction waits for — the member's
            // registration lock below, the session, device and token rows after it — is a bounded
            // wait (contract 7). Local to the transaction: it ends with it.
            sqlx::query("SELECT set_config('lock_timeout', $1, true)")
                .bind(format!("{REGISTRATION_LOCK_WAIT_SECS}s"))
                .execute(&mut *conn)
                .await
                .map_err(DbError::from)?;

            if let Err(rejection) = require_active_member(conn, workspace_id, member_id).await? {
                return Ok(Err(rejection));
            }

            // 0a) #5091 — this member's registrations take turns, from here to the commit, so the
            //     cap step at the end trims a count that includes every earlier registration
            //     (contract 7). It is the first lock this transaction takes and nothing else ever
            //     takes it, so it cannot sit in a cycle with the session, device or token locks.
            sqlx::query(MEMBER_REGISTRATION_LOCK_SQL)
                .bind(member_registration_lock_key(workspace_id, member_id))
                .execute(&mut *conn)
                .await
                .map_err(DbError::from)?;

            // 0) #2677 — which session is this registration made under? The
            //    row is share-locked until commit, so a logout of that session
            //    either waits for this registration (and then invalidates it)
            //    or has already committed (and we refuse here, before any
            //    write). No credential without a session row (an agent bearer)
            //    binds nothing, and neither does a pre-088 session.
            let session_id = match via_token_id {
                None => None,
                Some(token_id) => {
                    match lock_session_for_registration(conn, workspace_id, member_id, token_id)
                        .await
                        .map_err(DbError::from)?
                    {
                        RegistrationSession::Live(lineage) => lineage,
                        RegistrationSession::NotASession => None,
                        RegistrationSession::Ended => {
                            return Ok(Err(DeviceRejection::SessionEnded));
                        }
                    }
                }
            };

            // 1) Actor binding on the device row. `deviceId` is client-stable,
            //    so an existing row must already belong to the caller — or be
            //    dormant (#3978, contract 1): a phone that one member signed
            //    out of keeps its `deviceId`, and the next member signing in on
            //    it presents that same id. Dormant means no active token on it;
            //    a live registration is never taken, only a dead one.
            //
            //    The row is LOCKED here, not just read, and the dormancy test
            //    below is a separate statement. Both matter: two sign-ins racing
            //    for one dormant device must take turns, and the second must
            //    then see the first one's token — which a snapshot taken before
            //    the wait would not (READ COMMITTED takes one per statement).
            let existing = sqlx::query(
                "SELECT member_id, platform::text AS platform \
                   FROM device WHERE id = $1 FOR UPDATE",
            )
            .bind(registration.device_id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(DbError::from)?;

            let device_visible = existing.is_some();
            let mut previous_owner: Option<Uuid> = None;
            if let Some(row) = existing {
                let owner: Uuid = row.get("member_id");
                let platform: String = row.get("platform");
                if owner != member_id {
                    if device_has_live_token(conn, registration.device_id).await? {
                        return Ok(Err(DeviceRejection::DeviceOwnedByAnotherMember));
                    }
                    previous_owner = Some(owner);
                }
                if platform != registration.platform {
                    return Ok(Err(DeviceRejection::PlatformImmutable));
                }
            }

            // 3) Actor binding on the token, checked BEFORE the first write so
            //    it can still be an Ok-rejection. An active token owned by
            //    someone else is a hard stop; an invalidated one is reclaimable.
            let token_row = sqlx::query(
                "SELECT id, member_id, invalidated_at IS NULL AS active \
                   FROM push_token \
                  WHERE apns_token = $1 AND env = $2::push_env",
            )
            .bind(&registration.apns_token)
            .bind(&registration.env)
            .fetch_optional(&mut *conn)
            .await
            .map_err(DbError::from)?;

            let mut existing_token_id: Option<Uuid> = None;
            if let Some(row) = token_row {
                let owner: Uuid = row.get("member_id");
                let active: bool = row.get("active");
                if active && owner != member_id {
                    return Ok(Err(DeviceRejection::TokenOwnedByAnotherMember));
                }
                existing_token_id = Some(row.get("id"));
            }

            // ---- first write ----------------------------------------------
            // Past this line every failure rolls back; no rejection may be
            // returned in the Ok channel. The one exception is the insert just
            // below finding its id taken: `DO NOTHING` has written nothing, so
            // the transaction is still clean and that outcome may still commit
            // as a rejection.

            // 2) The device row. 201 vs 200 is "this id was new to the server".
            let created = if device_visible {
                // The row is locked above, and it is the caller's or dormant and
                // being taken over — nothing can have made a token live on it
                // since: a token insert needs a key-share lock on this very row
                // (the FK), and every registration of this id starts at the lock.
                // That is what keeps a mixed-owner device/token pair from ever
                // committing (review #422 M1), now that ownership can move.
                sqlx::query(
                    "UPDATE device \
                        SET member_id = $2, app_build = $3, last_seen_at = now() \
                      WHERE id = $1",
                )
                .bind(registration.device_id)
                .bind(member_id)
                .bind(&registration.app_build)
                .execute(&mut *conn)
                .await
                .map_err(classify_registration_write)?;
                false
            } else {
                // `DO NOTHING`, not `DO UPDATE`: the id is a global primary key,
                // and `DO UPDATE` over a row that row-level security hides from
                // this tenant is a 42501 — a 500 for the caller. `DO NOTHING`
                // reports the clash as an empty result instead.
                let inserted = sqlx::query(
                    "INSERT INTO device (id, workspace_id, member_id, platform, app_build) \
                     VALUES ($1, $2, $3, $4::device_platform, $5) \
                     ON CONFLICT (id) DO NOTHING \
                     RETURNING id",
                )
                .bind(registration.device_id)
                .bind(workspace_id)
                .bind(member_id)
                .bind(&registration.platform)
                .bind(&registration.app_build)
                .fetch_optional(&mut *conn)
                .await
                .map_err(classify_registration_write)?;
                if inserted.is_none() {
                    // Taken by a row the first look did not see. Look again, with
                    // a fresh snapshot: if it is visible now, a concurrent
                    // registration of this id in this workspace committed in
                    // between — retry and the normal path decides. If not, the
                    // row is in another workspace (#3978 contract 6).
                    let in_this_workspace = sqlx::query_scalar::<_, bool>(
                        "SELECT EXISTS (SELECT 1 FROM device WHERE id = $1)",
                    )
                    .bind(registration.device_id)
                    .fetch_one(&mut *conn)
                    .await
                    .map_err(DbError::from)?;
                    return if in_this_workspace {
                        Err(PushError::RegistrationConflict)
                    } else {
                        Ok(Err(DeviceRejection::DeviceInAnotherWorkspace))
                    };
                }
                true
            };

            // 4) Rotate: invalidate every other still-active token on this
            //    (device, env) BEFORE upserting the incoming one. Rows are kept
            //    forever — push_dispatch_log references them.
            let rotated = sqlx::query(
                "UPDATE push_token \
                    SET invalidated_at = now(), updated_at = now() \
                  WHERE device_id = $1 \
                    AND env = $2::push_env \
                    AND invalidated_at IS NULL \
                    AND apns_token <> $3",
            )
            .bind(registration.device_id)
            .bind(&registration.env)
            .bind(&registration.apns_token)
            .execute(&mut *conn)
            .await
            .map_err(classify_registration_write)?
            .rows_affected();

            // 5) Upsert the incoming token.
            let incoming_token_id: Uuid = match existing_token_id {
                Some(token_id) => {
                    // `session_id` is rewritten, never kept: a phone signing
                    // back in re-sends the same token, and the row must now
                    // belong to the NEW session — left on the old lineage it
                    // would outlive this one's logout (#2677).
                    sqlx::query(
                        "UPDATE push_token \
                            SET device_id = $1, \
                                member_id = $2, \
                                topic = $3, \
                                session_id = $5, \
                                invalidated_at = NULL, \
                                updated_at = now() \
                          WHERE id = $4",
                    )
                    .bind(registration.device_id)
                    .bind(member_id)
                    .bind(&registration.topic)
                    .bind(token_id)
                    .bind(session_id)
                    .execute(&mut *conn)
                    .await
                    .map_err(classify_registration_write)?;
                    token_id
                }
                None => {
                    // ON CONFLICT DO NOTHING: a conflicting row that RLS hides
                    // (the same apns_token registered under another tenant)
                    // must surface as a conflict, never a 500.
                    let inserted = sqlx::query(
                        "INSERT INTO push_token \
                           (workspace_id, device_id, member_id, apns_token, env, topic, \
                            session_id) \
                         VALUES ($1, $2, $3, $4, $5::push_env, $6, $7) \
                         ON CONFLICT (apns_token, env) DO NOTHING \
                         RETURNING id",
                    )
                    .bind(workspace_id)
                    .bind(registration.device_id)
                    .bind(member_id)
                    .bind(&registration.apns_token)
                    .bind(&registration.env)
                    .bind(&registration.topic)
                    .bind(session_id)
                    .fetch_optional(&mut *conn)
                    .await
                    .map_err(classify_registration_write)?;
                    let Some(inserted) = inserted else {
                        return Err(PushError::RegistrationConflict);
                    };
                    inserted.get("id")
                }
            };

            // 5b) #5091 — contract 7: leave the member at no more than the cap, stalest first,
            //     never the token written just above.
            let evicted = sqlx::query(EVICT_STALEST_SQL)
                .bind(workspace_id)
                .bind(member_id)
                .bind(incoming_token_id)
                .bind(MEMBER_MAX_ACTIVE_TOKENS)
                .execute(&mut *conn)
                .await
                .map_err(DbError::from)?
                .rows_affected();

            // 6) Audit, same transaction. `right(..., 8)` keeps the raw token
            //    out of the audit row exactly as it stays out of the response.
            sqlx::query(
                "INSERT INTO audit_log \
                   (workspace_id, actor_member_id, action, target_type, \
                    target_id, via_token_id, detail) \
                 VALUES ($1, $2, 'device.registered', 'device', $3, $4, \
                   jsonb_build_object( \
                     'schema', 'momo.device.registered.v1', \
                     'platform', $5::text, \
                     'env', $6::text, \
                     'topic', $7::text, \
                     'apns_token_suffix', right($8::text, 8), \
                     'device_created', $9::boolean, \
                     'tokens_rotated', $10::bigint, \
                     'device_transferred', $11::boolean, \
                     'previous_member_id', $12::uuid, \
                     'tokens_evicted', $13::bigint \
                   ))",
            )
            .bind(workspace_id)
            .bind(member_id)
            .bind(registration.device_id)
            .bind(via_token_id)
            .bind(&registration.platform)
            .bind(&registration.env)
            .bind(&registration.topic)
            .bind(&registration.apns_token)
            .bind(created)
            .bind(rotated as i64)
            .bind(previous_owner.is_some())
            .bind(previous_owner)
            .bind(evicted as i64)
            .execute(&mut *conn)
            .await
            .map_err(DbError::from)?;

            let device = load_device_in_tx(conn, registration.device_id)
                .await?
                .ok_or(PushError::RegistrationConflict)?;

            Ok(Ok(RegisterOutcome { device, created }))
        })
    })
    .await
    // A lock race (the bounded wait ran out, or the deadlock detector chose this transaction) is
    // the retryable 409, not a 500: nothing was committed (#5091 review M-1).
    .map_err(lock_race_is_a_conflict)
}

// ---------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------

/// Revoke a device: invalidate every still-active token on it.
///
/// Never `DELETE` — `push_dispatch_log.push_token_id` must keep resolving
/// (ADR-0120 D4). Idempotent: revoking twice reports `0` the second time.
///
/// Since #3978 a device can change hands, so this is also where the previous
/// owner's late sign-out must not reach the next owner's registration:
///
/// * the row is **locked** while ownership is read, the same lock a takeover
///   takes first ([`register_device`]). A sign-out that read "mine" and then
///   waited behind a takeover would otherwise run its token `UPDATE` on a fresh
///   snapshot and invalidate the new owner's live registration (and return the
///   new owner's device record). Behind the lock it reads the new owner instead.
/// * a device someone else holds **without a live registration** answers as if
///   the server had never seen the id (404), not 403: it is nobody's to revoke,
///   the first register of that id would take it, and a 403 would tell a
///   caller that merely knows an id that a device exists (the same
///   non-disclosure as #4233). A device with a live registration is still 403.
pub async fn revoke_device(
    pool: &PgPool,
    workspace_id: Uuid,
    member_id: Uuid,
    via_token_id: Option<Uuid>,
    device_id: Uuid,
) -> Result<Result<RevokeOutcome, DeviceRejection>, PushError> {
    tenant_tx(pool, workspace_id, move |conn| {
        Box::pin(async move {
            if let Err(rejection) = require_active_member(conn, workspace_id, member_id).await? {
                return Ok(Err(rejection));
            }

            let owner = sqlx::query_scalar::<_, Uuid>(
                "SELECT member_id FROM device WHERE id = $1 FOR UPDATE",
            )
            .bind(device_id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(DbError::from)?;

            let Some(owner) = owner else {
                return Ok(Err(DeviceRejection::DeviceNotFound));
            };
            if owner != member_id {
                // The liveness test is its own statement, after the lock (see
                // `device_has_live_token`). Nothing is written on either answer.
                return Ok(Err(if device_has_live_token(conn, device_id).await? {
                    DeviceRejection::DeviceOwnedByAnotherMember
                } else {
                    DeviceRejection::DeviceNotFound
                }));
            }

            let invalidated = sqlx::query(
                "UPDATE push_token \
                    SET invalidated_at = now(), updated_at = now() \
                  WHERE device_id = $1 \
                    AND invalidated_at IS NULL",
            )
            .bind(device_id)
            .execute(&mut *conn)
            .await
            .map_err(DbError::from)?
            .rows_affected();

            sqlx::query(
                "INSERT INTO audit_log \
                   (workspace_id, actor_member_id, action, target_type, \
                    target_id, via_token_id, detail) \
                 VALUES ($1, $2, 'device.revoked', 'device', $3, $4, \
                   jsonb_build_object( \
                     'schema', 'momo.device.revoked.v1', \
                     'tokens_invalidated', $5::bigint \
                   ))",
            )
            .bind(workspace_id)
            .bind(member_id)
            .bind(device_id)
            .bind(via_token_id)
            .bind(invalidated as i64)
            .execute(&mut *conn)
            .await
            .map_err(DbError::from)?;

            let device = load_device_in_tx(conn, device_id)
                .await?
                .ok_or(DbError::Sqlx(sqlx::Error::RowNotFound))?;

            Ok(Ok(RevokeOutcome {
                device,
                invalidated,
            }))
        })
    })
    .await
}

// ---------------------------------------------------------------------------
// Session end (#2677)
// ---------------------------------------------------------------------------

/// One session ended: its lineage's live registrations end with it.
///
/// The member predicate is belt-and-braces — a lineage never spans members —
/// and `invalidated_at IS NULL` keeps a repeated logout a no-op that reports 0.
/// Never `DELETE` (contract 3).
const INVALIDATE_SESSION_SQL: &str = "UPDATE push_token \
        SET invalidated_at = now(), updated_at = now() \
      WHERE workspace_id = $1 \
        AND member_id = $2 \
        AND session_id = $3 \
        AND invalidated_at IS NULL";

/// Every session of the member ended: all of the member's live registrations
/// end, lineage or not — including pre-088 rows no single session can claim.
const INVALIDATE_MEMBER_SQL: &str = "UPDATE push_token \
        SET invalidated_at = now(), updated_at = now() \
      WHERE workspace_id = $1 \
        AND member_id = $2 \
        AND invalidated_at IS NULL";

/// Invalidate the registrations made under one session lineage — the push
/// half of logout and of the linked-device disconnect (ADR-0120 D4, ADR-0180
/// D5). Runs inside the caller's tenant transaction, next to the token
/// revocation, so the session and its registrations end in one commit.
/// Returns how many rows this call flipped.
pub async fn invalidate_session_push_tokens_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    session_id: Uuid,
) -> Result<u64, DbError> {
    Ok(sqlx::query(INVALIDATE_SESSION_SQL)
        .bind(workspace_id)
        .bind(member_id)
        .bind(session_id)
        .execute(&mut *conn)
        .await?
        .rows_affected())
}

/// Invalidate every registration of one member — the push half of any path
/// that revokes all of the member's sessions at once (password change or reset,
/// suspension, removal, leaving the workspace). Same transaction rule as
/// [`invalidate_session_push_tokens_in_tx`].
pub async fn invalidate_member_push_tokens_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<u64, DbError> {
    Ok(sqlx::query(INVALIDATE_MEMBER_SQL)
        .bind(workspace_id)
        .bind(member_id)
        .execute(&mut *conn)
        .await?
        .rows_affected())
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/// `with_tenant_tx_prelude` with empty preludes.
///
/// The generic error type is the point: [`PushError::RegistrationConflict`]
/// must be able to roll back, which the fixed-`DbError` [`momo_db::with_tenant_tx`]
/// cannot express.
async fn tenant_tx<T, F>(pool: &PgPool, workspace_id: Uuid, body: F) -> Result<T, PushError>
where
    T: Send,
    F: for<'c> FnOnce(
            &'c mut PgConnection,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<T, PushError>> + Send + 'c>,
        > + Send,
{
    with_tenant_tx_prelude(
        pool,
        workspace_id,
        |_conn| Box::pin(async { Ok(()) }),
        |_conn| Box::pin(async { Ok(()) }),
        body,
    )
    .await
}

/// Does any registration on this device still count — an active
/// (`invalidated_at IS NULL`) token, whoever's it is?
///
/// A statement of its own, after the row lock, on purpose: under READ COMMITTED
/// each statement takes a fresh snapshot, so a registration that committed while
/// this transaction waited for the lock is visible here (#3978).
async fn device_has_live_token(conn: &mut PgConnection, device_id: Uuid) -> Result<bool, DbError> {
    Ok(sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM push_token \
                         WHERE device_id = $1 AND invalidated_at IS NULL)",
    )
    .bind(device_id)
    .fetch_one(&mut *conn)
    .await?)
}

/// The workspace-membership gate every device handler runs first.
///
/// Uses the same helper as every other Rust route (`read_state`, `channels`,
/// `roster`) rather than Swift's bare `member.status` read, so "active member
/// of this workspace" has one definition in this server.
async fn require_active_member(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<Result<(), DeviceRejection>, PushError> {
    let role = active_workspace_role(conn, workspace_id, member_id).await?;
    if role.is_none() {
        return Ok(Err(DeviceRejection::NotActiveMember));
    }
    Ok(Ok(()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_accepts_only_ios_and_macos() {
        assert_eq!(normalized_platform(" IOS ").unwrap(), "ios");
        assert_eq!(normalized_platform("macOS").unwrap(), "macos");
        assert_eq!(
            normalized_platform("android"),
            Err(DeviceInputError::Platform)
        );
        assert_eq!(normalized_platform(""), Err(DeviceInputError::Platform));
    }

    #[test]
    fn env_accepts_only_sandbox_and_production() {
        assert_eq!(normalized_env("Sandbox").unwrap(), "sandbox");
        assert_eq!(normalized_env(" production").unwrap(), "production");
        assert_eq!(normalized_env("prod"), Err(DeviceInputError::Env));
    }

    /// Case normalization is not cosmetic: `UNIQUE (apns_token, env)` is the
    /// arbitration that stops one physical device holding two active tokens, and
    /// it is case-sensitive in PostgreSQL.
    #[test]
    fn apns_token_is_lowercased_and_must_be_hex() {
        let upper = "AB".repeat(32);
        assert_eq!(normalized_apns_token(&upper).unwrap(), "ab".repeat(32));
        assert_eq!(
            normalized_apns_token("zz"),
            Err(DeviceInputError::ApnsToken),
            "non-hex is rejected"
        );
        assert_eq!(
            normalized_apns_token(&"a".repeat(15)),
            Err(DeviceInputError::ApnsToken),
            "shorter than 16 is rejected"
        );
        assert_eq!(
            normalized_apns_token(&"a".repeat(513)),
            Err(DeviceInputError::ApnsToken),
            "longer than 512 is rejected"
        );
        assert!(normalized_apns_token(&"a".repeat(16)).is_ok());
        assert!(normalized_apns_token(&"a".repeat(512)).is_ok());
    }

    #[test]
    fn topic_rejects_whitespace_and_control_characters() {
        assert_eq!(
            normalized_topic(" kim.dawn.momo ").unwrap(),
            "kim.dawn.momo"
        );
        assert_eq!(normalized_topic("kim dawn"), Err(DeviceInputError::Topic));
        assert_eq!(normalized_topic(""), Err(DeviceInputError::Topic));
        assert_eq!(normalized_topic("a\u{7F}b"), Err(DeviceInputError::Topic));
        assert_eq!(
            normalized_topic(&"a".repeat(257)),
            Err(DeviceInputError::Topic)
        );
    }

    #[test]
    fn blank_app_build_is_none_not_empty_string() {
        assert_eq!(validated_app_build(None).unwrap(), None);
        assert_eq!(validated_app_build(Some("   ")).unwrap(), None);
        assert_eq!(
            validated_app_build(Some(" 42 ")).unwrap(),
            Some("42".to_string())
        );
        assert_eq!(
            validated_app_build(Some(&"9".repeat(65))),
            Err(DeviceInputError::AppBuild)
        );
    }

    /// ADR-0206 증보 4 G1 — the number the ADR states, and the lock's key: one (workspace, member),
    /// the same text for the same pair and a different one for another member or workspace, with
    /// no device in it (two devices of one member must queue on the same lock). The eviction never
    /// deletes: a token row is kept so `push_dispatch_log` keeps resolving (contract 3).
    #[test]
    fn the_member_cap_is_ten_and_its_lock_names_one_member_and_the_eviction_never_deletes() {
        assert_eq!(MEMBER_MAX_ACTIVE_TOKENS, 10, "the ADR's number");
        assert_eq!(
            REGISTRATION_LOCK_WAIT_SECS, 3,
            "the ADR's bound, the scheduler's number"
        );
        let (workspace, member) = (Uuid::from_u128(1), Uuid::from_u128(2));
        let key = member_registration_lock_key(workspace, member);
        assert_eq!(key, member_registration_lock_key(workspace, member));
        assert_ne!(
            key,
            member_registration_lock_key(workspace, Uuid::from_u128(3))
        );
        assert_ne!(
            key,
            member_registration_lock_key(Uuid::from_u128(4), member)
        );
        assert!(key.contains(&workspace.to_string()) && key.contains(&member.to_string()));
        assert!(!EVICT_STALEST_SQL.contains("DELETE"));
    }

    /// #2677 — ending a session must reach only that session's registrations,
    /// and ending a member only that member's. Drop `session_id = $3` and one
    /// phone's logout silences every other phone of the person; drop the
    /// `invalidated_at IS NULL` guard and a repeated logout reports rows it did
    /// not flip. Neither may ever delete (contract 3).
    #[test]
    fn session_end_invalidation_is_scoped_and_never_deletes() {
        for needle in [
            "workspace_id = $1",
            "member_id = $2",
            "session_id = $3",
            "invalidated_at IS NULL",
            "SET invalidated_at = now()",
        ] {
            assert!(
                INVALIDATE_SESSION_SQL.contains(needle),
                "the per-session invalidation lost `{needle}`"
            );
        }
        for needle in [
            "workspace_id = $1",
            "member_id = $2",
            "invalidated_at IS NULL",
            "SET invalidated_at = now()",
        ] {
            assert!(
                INVALIDATE_MEMBER_SQL.contains(needle),
                "the per-member invalidation lost `{needle}`"
            );
        }
        for sql in [INVALIDATE_SESSION_SQL, INVALIDATE_MEMBER_SQL] {
            assert!(
                !sql.contains("DELETE"),
                "revocation is invalidated_at, never DELETE"
            );
        }
    }

    /// The raw APNs token must never be *selected* out of PostgreSQL. Grepping
    /// the statements this module issues is a cheap, honest proof: the only
    /// projection of that column in a read path is `right(apns_token, 8)`.
    ///
    /// Revert the `right(...)` to a bare `t.apns_token` and this goes red.
    #[test]
    fn no_read_path_selects_the_raw_apns_token() {
        // Scan production source only — the assertions below name the very
        // patterns they forbid, so including this module would match itself.
        let source = include_str!("device.rs");
        let production = source
            .split("#[cfg(test)]")
            .next()
            .expect("source has a production half");

        assert!(
            production.contains("right(t.apns_token, 8) AS apns_token_suffix"),
            "the token-suffix projection disappeared from the read path"
        );

        // The column may be *written* and *compared* — registration needs both,
        // and those use the unqualified name inside WHERE clauses. What must
        // never happen is projecting the qualified column out of a row: every
        // `t.apns_token` has to be wrapped in `right(...)`.
        let projected = production.matches("t.apns_token").count();
        let wrapped = production.matches("right(t.apns_token, 8)").count();
        assert_eq!(
            projected, wrapped,
            "a read path projects the raw apns_token — responses and audit rows \
             may carry the trailing 8 characters only (ADR-0120 D4)"
        );

        assert!(
            !production.contains("SELECT apns_token"),
            "the raw apns_token must never head a SELECT list"
        );
    }
}
