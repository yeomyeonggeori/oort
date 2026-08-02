//! Device / push-token registration lifecycle (ADR-0120 D4).
//!
//! Port of `server/Sources/MomoServer/Routes/DeviceRoutes.swift`. The route
//! layer owns HTTP; every statement lives here.
//!
//! The four contracts the Swift original establishes, all preserved:
//!
//! 1. **Actor binding** — a member may only touch their own device and their
//!    own active token. Another member's device, or another member's *active*
//!    token, is a hard 403. An *invalidated* token is reclaimable, which is the
//!    account-switch-on-the-same-phone path.
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

use chrono::{DateTime, Utc};
use momo_db::{with_tenant_tx_prelude, DbError, PgPool};
use momo_messaging::active_workspace_role;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::error::{classify_registration_write, DeviceInputError, DeviceRejection, PushError};

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
    let rows = sqlx::query(
        "SELECT t.id, t.device_id, t.env::text AS env, t.topic, \
                right(t.apns_token, 8) AS apns_token_suffix, \
                t.invalidated_at, t.created_at, t.updated_at \
           FROM push_token t \
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
            if let Err(rejection) = require_active_member(conn, workspace_id, member_id).await? {
                return Ok(Err(rejection));
            }

            // 1) Actor binding on the device row. `deviceId` is client-stable,
            //    so an existing row must already belong to the caller.
            let existing = sqlx::query(
                "SELECT member_id, platform::text AS platform FROM device WHERE id = $1",
            )
            .bind(registration.device_id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(DbError::from)?;

            if let Some(row) = existing {
                let owner: Uuid = row.get("member_id");
                let platform: String = row.get("platform");
                if owner != member_id {
                    return Ok(Err(DeviceRejection::DeviceOwnedByAnotherMember));
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
            // returned in the Ok channel.

            // 2) Idempotent device upsert. `xmax = 0` distinguishes a fresh
            //    insert from an update, which is what drives 201 vs 200.
            let upsert = sqlx::query(
                "INSERT INTO device (id, workspace_id, member_id, platform, app_build) \
                 VALUES ($1, $2, $3, $4::device_platform, $5) \
                 ON CONFLICT (id) DO UPDATE \
                    SET app_build = EXCLUDED.app_build, \
                        last_seen_at = now() \
                 RETURNING (xmax = 0) AS created, member_id",
            )
            .bind(registration.device_id)
            .bind(workspace_id)
            .bind(member_id)
            .bind(&registration.platform)
            .bind(&registration.app_build)
            .fetch_one(&mut *conn)
            .await
            .map_err(classify_registration_write)?;

            let created: bool = upsert.get("created");
            let owner_after: Uuid = upsert.get("member_id");
            // The pre-check above races a concurrent first registration.
            // Re-verify ownership on the row the upsert actually touched, so a
            // mixed-owner device/token pair can never commit (review #422 M1).
            if owner_after != member_id {
                return Err(PushError::RegistrationConflict);
            }

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
            match existing_token_id {
                Some(token_id) => {
                    sqlx::query(
                        "UPDATE push_token \
                            SET device_id = $1, \
                                member_id = $2, \
                                topic = $3, \
                                invalidated_at = NULL, \
                                updated_at = now() \
                          WHERE id = $4",
                    )
                    .bind(registration.device_id)
                    .bind(member_id)
                    .bind(&registration.topic)
                    .bind(token_id)
                    .execute(&mut *conn)
                    .await
                    .map_err(classify_registration_write)?;
                }
                None => {
                    // ON CONFLICT DO NOTHING: a conflicting row that RLS hides
                    // (the same apns_token registered under another tenant)
                    // must surface as a conflict, never a 500.
                    let inserted = sqlx::query(
                        "INSERT INTO push_token \
                           (workspace_id, device_id, member_id, apns_token, env, topic) \
                         VALUES ($1, $2, $3, $4, $5::push_env, $6) \
                         ON CONFLICT (apns_token, env) DO NOTHING \
                         RETURNING id",
                    )
                    .bind(workspace_id)
                    .bind(registration.device_id)
                    .bind(member_id)
                    .bind(&registration.apns_token)
                    .bind(&registration.env)
                    .bind(&registration.topic)
                    .fetch_optional(&mut *conn)
                    .await
                    .map_err(classify_registration_write)?;
                    if inserted.is_none() {
                        return Err(PushError::RegistrationConflict);
                    }
                }
            }

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
                     'tokens_rotated', $10::bigint \
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
}

// ---------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------

/// Revoke a device: invalidate every still-active token on it.
///
/// Never `DELETE` — `push_dispatch_log.push_token_id` must keep resolving
/// (ADR-0120 D4). Idempotent: revoking twice reports `0` the second time.
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

            let owner = sqlx::query_scalar::<_, Uuid>("SELECT member_id FROM device WHERE id = $1")
                .bind(device_id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(DbError::from)?;

            let Some(owner) = owner else {
                return Ok(Err(DeviceRejection::DeviceNotFound));
            };
            if owner != member_id {
                return Ok(Err(DeviceRejection::DeviceOwnedByAnotherMember));
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
