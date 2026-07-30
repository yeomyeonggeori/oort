//! Cloud-host acquisition: BYOC enrollment and the one-shot bootstrap
//! registration (ADR-0142 D1, B2.2).
//!
//! B2.1 built the *lifecycle* half of `work_cloud_host` ([`crate::lifecycle`]:
//! bind, transition, terminate). This module adds the half that comes before it
//! — how a row is created and how its bootstrap token is spent — because a REST
//! surface cannot open a T3 session against a host that does not exist yet.
//!
//! Ports Swift `Routes/CloudProvisionerRoutes.swift`:
//! `enroll` :288-423 (BYOC) and the token-claim step of `register` :450-472.
//! The bind that follows the claim is already
//! [`crate::lifecycle::bind_cloud_host_in_tx`] (:488-498) and is deliberately
//! **not** duplicated here.
//!
//! Three properties are worth stating because they are the reason this module is
//! shaped the way it is:
//!
//! * **The raw bootstrap token never enters PostgreSQL.** [`mint_bootstrap_token`]
//!   returns the token and its SHA-256 digest together, and only the digest is
//!   ever bound to a statement (045:87-88, `bootstrap_token_digest`). The token
//!   is shown to the operator exactly once; a replayed `idempotencyRef` cannot
//!   re-reveal it, because momo did not keep it.
//! * **BYOC calls no provider API.** ADR-0142 D1: momo never gained the right to
//!   boot or kill the owner's machine, so the enrollment *is* the instance and
//!   `provider_sandbox_id` is derived from the provision id
//!   (`CloudProvisionerRoutes.swift:364-366`). No credential is read here.
//! * **Admission is [`crate::billing::reserve_provisioning_slot_in_tx`].** It is
//!   called by the route between the ladder rungs, not from inside this module,
//!   so the "who may start a paid host" rule keeps exactly one implementation.

use momo_db::{PgConnection, PgPool};
use sqlx::Row;
use uuid::Uuid;

use crate::error::T3Error;

/// `CloudProvisionerRoutes.bootstrapTTLSeconds` (:60) — 15 minutes.
pub const BOOTSTRAP_TTL_SECONDS: i64 = 15 * 60;

/// A freshly minted one-shot bootstrap credential.
///
/// `raw` is shown to the operator once and then dropped; `digest` is the only
/// part that may be persisted. `Debug` is hand-written so a `{:?}` in a log line
/// can never print the token itself.
#[derive(Clone, PartialEq, Eq)]
pub struct BootstrapToken {
    raw: String,
    digest: String,
}

impl BootstrapToken {
    pub fn raw(&self) -> &str {
        &self.raw
    }

    /// Lowercase hex SHA-256 — the shape `work_cloud_host_digest_ck`
    /// (`^[0-9a-f]{64}$`, 045:106-107) requires.
    pub fn digest(&self) -> &str {
        &self.digest
    }
}

impl std::fmt::Debug for BootstrapToken {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BootstrapToken")
            .field("raw", &"<redacted>")
            .field("digest", &self.digest)
            .finish()
    }
}

/// Mint a one-shot bootstrap token and its digest.
///
/// Entropy comes from two v4 UUIDs (244 random bits from the OS CSPRNG),
/// rendered as opaque hex. Swift renders 32 random bytes as base64url
/// (`randomToken` :1220-1230); the *format* is not part of any contract — the
/// token is an opaque bearer string the workd echoes back — but the properties
/// that are (unguessable, single-use, digest-only at rest) are preserved.
pub fn mint_bootstrap_token() -> BootstrapToken {
    let raw = format!(
        "{}{}",
        Uuid::new_v4().as_simple(),
        Uuid::new_v4().as_simple()
    );
    let digest = momo_wire::sha256_hex(raw.as_bytes());
    BootstrapToken { raw, digest }
}

/// Digest of a token presented by a workd (`tokenDigest` :1216-1218).
pub fn bootstrap_token_digest(raw_token: &str) -> String {
    momo_wire::sha256_hex(raw_token.as_bytes())
}

/// What a BYOC enrollment states. Everything provider-specific is one field
/// (`provider`), a registry id — never a vendor name a policy may test (054).
#[derive(Debug, Clone)]
pub struct NewByocEnrollment {
    pub provision_id: Uuid,
    pub requester_member_id: Uuid,
    pub provider: String,
    pub bootstrap_token_digest: String,
    pub unit_rate_micro_usd_second: i64,
    pub idempotency_key: Uuid,
    pub requested_display_name: String,
}

/// An enrollment row as the REST surface reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudHostEnrollment {
    pub provision_id: Uuid,
    pub state: String,
    pub provider: String,
    pub bootstrap_expires_at_ms: i64,
    /// `true` when this `idempotencyRef` had already produced an enrollment.
    pub replayed: bool,
}

/// The bootstrap row a presented token unlocks (Swift `register` :450-466).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClaimedBootstrap {
    pub provision_id: Uuid,
    /// Owner of the enrollment: the registered host is attributed to them, never
    /// to identity the host supplies.
    pub requester_member_id: Uuid,
    /// Whether the provider has already named an instance. Drives the
    /// `provisioning → ready` step inside
    /// [`crate::lifecycle::bind_cloud_host_in_tx`].
    pub sandbox_known: bool,
}

/// A `work_cloud_host` row in the shape `CloudHostDTO` needs
/// (`CloudProvisionerRoutes.swift:38-44`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudHostRecord {
    pub provision_id: Uuid,
    pub host_id: Option<Uuid>,
    pub state: String,
    pub provider: String,
    pub created_at_ms: i64,
}

/// Allocate a v7 UUID **from the database**, like every Swift route that needs
/// an id before its row exists (`SELECT uuidv7()`).
///
/// Using the DB function rather than a Rust-side generator keeps one source of
/// ordering: `uuidv7()` is what the column defaults to, so an id minted here
/// sorts identically to one the default produced.
pub async fn allocate_uuid_v7(conn: &mut PgConnection) -> Result<Uuid, T3Error> {
    let id: Uuid = sqlx::query_scalar("SELECT uuidv7()")
        .fetch_one(&mut *conn)
        .await?;
    Ok(id)
}

/// Serialize concurrent enrollments that share an `idempotencyRef`
/// (Swift :329-339). *"A row lock cannot order a key which does not exist yet"* —
/// so the ordering is an advisory over `(workspace, key)`.
pub async fn lock_enrollment_key_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    idempotency_key: Uuid,
) -> Result<(), T3Error> {
    sqlx::query(
        "SELECT pg_advisory_xact_lock( \
           hashtextextended(lower($1::text) || ':' || lower($2::text), 0))",
    )
    .bind(workspace_id)
    .bind(idempotency_key)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// The enrollment this `idempotencyRef` already made, under `FOR UPDATE`
/// (Swift :340-353).
///
/// Checked **before** admission on purpose: a replay must not consume a slot,
/// and Swift orders it the same way (`existingRows` at :340, then
/// `reserveProvisioningSlot` at :354).
pub async fn find_enrollment_by_idempotency_key_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    idempotency_key: Uuid,
) -> Result<Option<CloudHostEnrollment>, T3Error> {
    let row = sqlx::query(
        "SELECT id, provider, state, \
                floor(extract(epoch from bootstrap_expires_at) * 1000)::bigint AS expires_ms \
           FROM work_cloud_host \
          WHERE workspace_id = $1 AND create_idempotency_key = $2 \
          FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(idempotency_key)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some(CloudHostEnrollment {
        provision_id: row.try_get("id")?,
        state: row.try_get("state")?,
        provider: row.try_get("provider")?,
        bootstrap_expires_at_ms: row.try_get("expires_ms")?,
        replayed: true,
    }))
}

/// Create the BYOC enrollment (Swift :360-381).
///
/// The caller must already hold [`lock_enrollment_key_in_tx`], must have found
/// no prior enrollment ([`find_enrollment_by_idempotency_key_in_tx`]) and must
/// have passed admission ([`crate::billing::reserve_provisioning_slot_in_tx`]) —
/// all three are the route's job precisely because the route is where the
/// ADR-0140 D2 ladder is opened.
pub async fn enroll_byoc_cloud_host_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    new: &NewByocEnrollment,
) -> Result<CloudHostEnrollment, T3Error> {
    // The degenerate adapter's instance handle is the enrollment itself: there
    // is no provider-side object to name (Swift :364-366). Writing it here is
    // also what makes the host reach `ready` on registration instead of waiting
    // for a provider callback that BYOC will never send.
    let row = sqlx::query(
        "INSERT INTO work_cloud_host \
           (id, workspace_id, requester_member_id, provider, provider_sandbox_id, \
            bootstrap_token_digest, bootstrap_expires_at, unit_rate_micro_usd_second, \
            create_idempotency_key, requested_display_name) \
         VALUES ($1, $2, $3, $4, 'byoc-' || lower($1::text), $5, \
                 clock_timestamp() + make_interval(secs => $6), $7, $8, $9) \
         RETURNING state, \
                   floor(extract(epoch from bootstrap_expires_at) * 1000)::bigint AS expires_ms",
    )
    .bind(new.provision_id)
    .bind(workspace_id)
    .bind(new.requester_member_id)
    .bind(&new.provider)
    .bind(&new.bootstrap_token_digest)
    .bind(BOOTSTRAP_TTL_SECONDS as f64)
    .bind(new.unit_rate_micro_usd_second)
    .bind(new.idempotency_key)
    .bind(&new.requested_display_name)
    .fetch_one(&mut *conn)
    .await?;

    Ok(CloudHostEnrollment {
        provision_id: new.provision_id,
        state: row.try_get("state")?,
        provider: new.provider.clone(),
        bootstrap_expires_at_ms: row.try_get("expires_ms")?,
        replayed: false,
    })
}

/// Resolve the provision a presented bootstrap token belongs to, with no lock —
/// the id is only needed to *choose* the advisory the lifecycle transaction will
/// take (same reasoning as [`crate::lifecycle::resolve_cloud_host_id`], and the
/// same re-validation afterwards: [`claim_bootstrap_in_tx`] re-reads under
/// `FOR UPDATE` and the route compares).
pub async fn cloud_host_id_for_bootstrap_digest(
    pool: &PgPool,
    workspace_id: Uuid,
    digest: &str,
) -> Result<Option<Uuid>, T3Error> {
    let digest = digest.to_string();
    momo_db::with_tenant_tx(pool, workspace_id, move |conn| {
        Box::pin(async move {
            sqlx::query_scalar(
                "SELECT id FROM work_cloud_host \
                  WHERE workspace_id = $1 AND bootstrap_token_digest = $2",
            )
            .bind(workspace_id)
            .bind(digest)
            .fetch_optional(&mut *conn)
            .await
            .map_err(momo_db::DbError::from)
        })
    })
    .await
    .map_err(T3Error::from)
}

/// Take the bootstrap row under `FOR UPDATE`, enforcing every spend condition in
/// SQL (Swift :450-462): unconsumed, unexpired, still `provisioning`.
///
/// `None` is an invalid *or* expired *or* already-spent token — one indistinct
/// answer on purpose, so the 401 leaks nothing about which.
pub async fn claim_bootstrap_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    digest: &str,
) -> Result<Option<ClaimedBootstrap>, T3Error> {
    let row = sqlx::query(
        "SELECT id, requester_member_id, provider_sandbox_id IS NOT NULL AS sandbox_known \
           FROM work_cloud_host \
          WHERE workspace_id = $1 \
            AND bootstrap_token_digest = $2 \
            AND bootstrap_consumed_at IS NULL \
            AND bootstrap_expires_at > clock_timestamp() \
            AND state = 'provisioning' \
          FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(digest)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some(ClaimedBootstrap {
        provision_id: row.try_get("id")?,
        requester_member_id: row.try_get("requester_member_id")?,
        sandbox_known: row.try_get("sandbox_known")?,
    }))
}

/// The cloud host bound to a `work_host`, without a lock — the `t3CloudHostID`
/// pre-resolve (`WorkSessionRoutes.swift:624-640`).
pub async fn cloud_host_id_for_host(
    pool: &PgPool,
    workspace_id: Uuid,
    host_id: Uuid,
) -> Result<Option<Uuid>, T3Error> {
    momo_db::with_tenant_tx(pool, workspace_id, move |conn| {
        Box::pin(async move {
            sqlx::query_scalar(
                "SELECT id FROM work_cloud_host WHERE workspace_id = $1 AND host_id = $2",
            )
            .bind(workspace_id)
            .bind(host_id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(momo_db::DbError::from)
        })
    })
    .await
    .map_err(T3Error::from)
}

/// Same lookup inside an open transaction — the re-validation half of the
/// pre-resolve (`revalidateT3CloudHost`, :669-691). The route compares the two
/// answers and returns 409 when they differ, so a host that gained or lost its
/// cloud binding between the two reads cannot be operated on under the wrong
/// advisory.
pub async fn cloud_host_id_for_host_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    host_id: Uuid,
) -> Result<Option<Uuid>, T3Error> {
    let id: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM work_cloud_host WHERE workspace_id = $1 AND host_id = $2",
    )
    .bind(workspace_id)
    .bind(host_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(id)
}

/// The cloud host that owns a session's host, inside an open transaction
/// (`revalidateT3CloudHost`, :642-667). `Ok(None)` covers both "no such session"
/// and "T1/T2 session" — the caller already knows which from its own read.
pub async fn cloud_host_id_for_session_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_id: Uuid,
) -> Result<Option<Uuid>, T3Error> {
    let id: Option<Uuid> = sqlx::query_scalar(
        "SELECT ch.id \
           FROM work_session ws \
           LEFT JOIN work_cloud_host ch \
             ON ch.workspace_id = ws.workspace_id \
            AND ch.host_id = ws.host_id \
          WHERE ws.workspace_id = $1 AND ws.id = $2",
    )
    .bind(workspace_id)
    .bind(session_id)
    .fetch_optional(&mut *conn)
    .await?
    .flatten();
    Ok(id)
}

/// Read one enrollment for display (`CloudProvisionerRoutes.get` :527-554).
pub async fn load_cloud_host_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    provision_id: Uuid,
) -> Result<Option<CloudHostRecord>, T3Error> {
    let row = sqlx::query(
        "SELECT id, host_id, state, provider, \
                floor(extract(epoch from created_at) * 1000)::bigint AS created_ms \
           FROM work_cloud_host \
          WHERE workspace_id = $1 AND id = $2",
    )
    .bind(workspace_id)
    .bind(provision_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some(CloudHostRecord {
        provision_id: row.try_get("id")?,
        host_id: row.try_get("host_id")?,
        state: row.try_get("state")?,
        provider: row.try_get("provider")?,
        created_at_ms: row.try_get("created_ms")?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_minted_token_is_unguessable_and_only_its_digest_is_storable() {
        let first = mint_bootstrap_token();
        let second = mint_bootstrap_token();
        assert_ne!(first.raw(), second.raw(), "tokens must not repeat");
        assert_eq!(first.raw().len(), 64);
        assert_eq!(
            first.digest(),
            bootstrap_token_digest(first.raw()),
            "the digest a workd's token hashes to must be the stored one"
        );
        // work_cloud_host_digest_ck: ^[0-9a-f]{64}$
        assert_eq!(first.digest().len(), 64);
        assert!(first
            .digest()
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
    }

    #[test]
    fn debug_never_renders_the_raw_bootstrap_token() {
        let token = mint_bootstrap_token();
        let rendered = format!("{token:?}");
        assert!(
            !rendered.contains(token.raw()),
            "a one-shot credential must never reach a log line: {rendered}"
        );
        assert!(rendered.contains("<redacted>"));
    }

    #[test]
    fn bootstrap_ttl_matches_the_swift_constant() {
        assert_eq!(BOOTSTRAP_TTL_SECONDS, 15 * 60);
    }
}
