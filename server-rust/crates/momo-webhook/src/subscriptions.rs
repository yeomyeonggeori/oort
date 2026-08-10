//! `event_subscription` — every statement, in one place.
//!
//! Ports Swift `Routes/EventSubscriptionRoutes.swift` (the four management
//! operations) and the subscription half of `relay/OutboxRelay/.../RelayService.swift`
//! (the delivery-time read, the failure ledger, the auto-disable).
//!
//! ## The three boundaries migration 033 draws, restated here so a caller cannot miss them
//!
//! 1. **Scope is the workspace.** `enqueue_event_subscription_delivery` selects
//!    `WHERE s.workspace_id = event_workspace_id` with no channel predicate, so
//!    a subscription cannot be narrowed to one channel. Nothing in this module
//!    accepts a channel; a parameter that could not be honoured would be a lie.
//! 2. **The payload leaves the workspace.** The mention and approval projections
//!    carry `body` — the message text — to a third-party address. That is
//!    ADR-0150 / #1204 territory and the reason [`record_delivery_audit`] exists.
//! 3. **The signing secret is answered once.** The row stores `secret_ref`,
//!    which is derivation material and not a secret; the secret itself is
//!    computed on demand and never selected, stored or logged. No function here
//!    returns `secret_ref` to a route — [`load_delivery_target`] hands it only
//!    to the sender, which needs it to sign.

use chrono::{DateTime, Utc};
use momo_db::DbError;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

/// The closed set `event_subscription_event_kinds_ck` accepts, in the order the
/// panel offers them.
pub const EVENT_KINDS: [&str; 3] = ["mention", "approval_request", "work.status_changed"];

/// One accepted event kind. A newtype over the wire token rather than an enum
/// with a `From<&str>`, because the DB constraint — not this crate — is the
/// authority, and a value that survived [`EventKind::parse`] is one the
/// constraint will also accept.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct EventKind(String);

impl EventKind {
    pub fn parse(raw: &str) -> Option<EventKind> {
        EVENT_KINDS
            .iter()
            .find(|kind| **kind == raw)
            .map(|kind| EventKind((*kind).to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Validate a caller's `eventKinds`: de-duplicated, sorted, non-empty, and every
/// member known.
///
/// Sorting is Swift's (`Array(Set(raw)).sorted()`) and is kept because the list
/// is echoed back on every read: an unsorted round-trip would make two identical
/// subscriptions look different in the panel.
pub fn validated_kinds(raw: &[String]) -> Option<Vec<String>> {
    let mut kinds: Vec<String> = raw
        .iter()
        .map(|value| EventKind::parse(value).map(|kind| kind.0))
        .collect::<Option<Vec<_>>>()?;
    kinds.sort();
    kinds.dedup();
    if kinds.is_empty() || kinds.len() > EVENT_KINDS.len() {
        return None;
    }
    Some(kinds)
}

/// One subscription as every read returns it. **There is no `secret_ref` field**:
/// a struct that cannot hold derivation material is one fewer place it can be
/// serialized from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubscriptionRow {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub url: String,
    pub event_kinds: Vec<String>,
    pub enabled: bool,
    pub delivery_failure_count: i32,
    pub disabled_at: Option<DateTime<Utc>>,
    pub disabled_reason: Option<String>,
    pub created_by: Uuid,
    pub updated_by: Uuid,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// The column list every statement below returns, spelled once.
const PROJECTION: &str = "id, workspace_id, url, event_kinds, enabled, \
     delivery_failure_count, disabled_at, disabled_reason, \
     created_by, updated_by, created_at, updated_at";

fn decode(row: &sqlx::postgres::PgRow) -> Result<SubscriptionRow, sqlx::Error> {
    Ok(SubscriptionRow {
        id: row.try_get("id")?,
        workspace_id: row.try_get("workspace_id")?,
        url: row.try_get("url")?,
        event_kinds: row.try_get("event_kinds")?,
        enabled: row.try_get("enabled")?,
        delivery_failure_count: row.try_get("delivery_failure_count")?,
        disabled_at: row.try_get("disabled_at")?,
        disabled_reason: row.try_get("disabled_reason")?,
        created_by: row.try_get("created_by")?,
        updated_by: row.try_get("updated_by")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

/// Newest first — the ordering Swift promises and the panel renders.
pub async fn list_subscriptions(
    conn: &mut PgConnection,
    workspace_id: Uuid,
) -> Result<Vec<SubscriptionRow>, DbError> {
    let rows = sqlx::query(&format!(
        "SELECT {PROJECTION} FROM event_subscription \
          WHERE workspace_id = $1 \
          ORDER BY created_at DESC, id DESC"
    ))
    .bind(workspace_id)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(decode)
        .collect::<Result<_, _>>()
        .map_err(DbError::from)
}

/// Insert one subscription. `secret_ref` is supplied by the caller (which also
/// derives the one-time secret from it) rather than generated here, so the
/// value that goes into the row and the value the response is built from are
/// provably the same one.
///
/// A subscription created disabled records `disabled_at`/`disabled_reason` in
/// the same insert, because `event_subscription_disable_ck` allows a disabled
/// row with no reason but the panel would then have nothing to show.
#[allow(clippy::too_many_arguments)]
pub async fn create_subscription(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    url: &str,
    secret_ref: &str,
    event_kinds: &[String],
    enabled: bool,
    actor_member_id: Uuid,
) -> Result<SubscriptionRow, DbError> {
    let row = sqlx::query(&format!(
        "INSERT INTO event_subscription \
           (workspace_id, url, secret_ref, event_kinds, enabled, \
            disabled_at, disabled_reason, created_by, updated_by) \
         VALUES ($1, $2, $3, $4, $5, \
                 CASE WHEN $5 THEN NULL ELSE clock_timestamp() END, \
                 CASE WHEN $5 THEN NULL ELSE 'disabled_by_admin' END, \
                 $6, $6) \
         RETURNING {PROJECTION}"
    ))
    .bind(workspace_id)
    .bind(url)
    .bind(secret_ref)
    .bind(event_kinds)
    .bind(enabled)
    .bind(actor_member_id)
    .fetch_one(&mut *conn)
    .await?;
    decode(&row).map_err(DbError::from)
}

/// Partial update. `None` means "leave alone" for all three fields, which is why
/// every clause is a `COALESCE`/`CASE` over the parameter rather than a branch
/// in Rust: one statement means one round trip and no read-modify-write window.
///
/// **Re-enabling clears the failure ledger** (`delivery_failure_count = 0`,
/// `disabled_at`/`disabled_reason` NULL). That is Swift's behaviour and it is
/// the only way a subscription auto-disabled by the 5xx threshold can come back
/// — without it the very next failure would trip the threshold again.
///
/// Returns `Ok(None)` when no row in this workspace has that id (a 404, not a
/// 500).
pub async fn update_subscription(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    subscription_id: Uuid,
    url: Option<&str>,
    event_kinds: Option<&[String]>,
    enabled: Option<bool>,
    actor_member_id: Uuid,
) -> Result<Option<SubscriptionRow>, DbError> {
    let row = sqlx::query(&format!(
        "UPDATE event_subscription \
            SET url = COALESCE($3, url), \
                event_kinds = COALESCE($4, event_kinds), \
                enabled = COALESCE($5, enabled), \
                delivery_failure_count = CASE \
                  WHEN $5 IS TRUE THEN 0 ELSE delivery_failure_count END, \
                disabled_at = CASE \
                  WHEN $5 IS TRUE THEN NULL \
                  WHEN $5 IS FALSE THEN COALESCE(disabled_at, clock_timestamp()) \
                  ELSE disabled_at END, \
                disabled_reason = CASE \
                  WHEN $5 IS TRUE THEN NULL \
                  WHEN $5 IS FALSE THEN 'disabled_by_admin' \
                  ELSE disabled_reason END, \
                updated_by = $6, \
                updated_at = clock_timestamp() \
          WHERE workspace_id = $1 AND id = $2 \
        RETURNING {PROJECTION}"
    ))
    .bind(workspace_id)
    .bind(subscription_id)
    .bind(url)
    .bind(event_kinds)
    .bind(enabled)
    .bind(actor_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    row.as_ref().map(decode).transpose().map_err(DbError::from)
}

/// Delete, returning the snapshot the response and the audit row both describe.
///
/// Deleting does **not** cancel already-enqueued `webhook_delivery` rows. The
/// sender settles those as `done` with `subscription missing` rather than
/// sending them, which is the property that makes the delete safe to answer
/// immediately: the queue drains itself into nothing instead of into the address
/// an admin just removed.
pub async fn delete_subscription(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    subscription_id: Uuid,
) -> Result<Option<SubscriptionRow>, DbError> {
    let row = sqlx::query(&format!(
        "DELETE FROM event_subscription \
          WHERE workspace_id = $1 AND id = $2 \
        RETURNING {PROJECTION}"
    ))
    .bind(workspace_id)
    .bind(subscription_id)
    .fetch_optional(&mut *conn)
    .await?;
    row.as_ref().map(decode).transpose().map_err(DbError::from)
}

// ---------------------------------------------------------------------------
// The sender's half
//
// These three run under the BYPASSRLS sender role with an explicit
// workspace_id, exactly like the relay's — the drain crosses every tenant by
// design, and the id is carried in the payload rather than inferred.
// ---------------------------------------------------------------------------

/// What the sender needs to deliver one payload, and nothing else.
///
/// `secret_ref` is here because signing requires it. It is deliberately absent
/// from [`SubscriptionRow`], which is what the *routes* return: the two shapes
/// differ by exactly the one field that must never reach a response body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeliveryTarget {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub url: String,
    pub secret_ref: String,
    pub enabled: bool,
}

/// Read the destination for a claimed `webhook_delivery` row.
///
/// `Ok(None)` = the subscription was deleted between enqueue and drain, which is
/// a settled row and not an error.
pub async fn load_delivery_target(
    conn: &mut PgConnection,
    subscription_id: Uuid,
) -> Result<Option<DeliveryTarget>, DbError> {
    let row = sqlx::query(
        "SELECT id, workspace_id, url, secret_ref, enabled \
           FROM event_subscription WHERE id = $1",
    )
    .bind(subscription_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some(DeliveryTarget {
        id: row.try_get("id").map_err(DbError::from)?,
        workspace_id: row.try_get("workspace_id").map_err(DbError::from)?,
        url: row.try_get("url").map_err(DbError::from)?,
        secret_ref: row.try_get("secret_ref").map_err(DbError::from)?,
        enabled: row.try_get("enabled").map_err(DbError::from)?,
    }))
}

/// A success settles the failure ledger back to zero.
///
/// `updated_at` only moves when the count actually changed, so a healthy
/// subscription's timestamp does not tick on every delivery — Swift's
/// `markWebhookDone` shape, kept because the panel shows that column.
pub async fn reset_delivery_failures(
    conn: &mut PgConnection,
    subscription_id: Uuid,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE event_subscription \
            SET delivery_failure_count = 0, \
                updated_at = CASE WHEN delivery_failure_count = 0 \
                                  THEN updated_at ELSE clock_timestamp() END \
          WHERE id = $1 AND enabled",
    )
    .bind(subscription_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// What [`register_delivery_failure`] decided.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegisteredFailure {
    /// The subscription is gone; the queued row has nowhere to go.
    Missing,
    /// The subscription is already off; the queued row is stale.
    Disabled,
    /// Counted. `failure_count` is the new total.
    Counted { failure_count: i32 },
    /// Counted, and the threshold tripped: the subscription is now off and an
    /// `event_subscription.auto_disabled` audit row names why.
    AutoDisabled { failure_count: i32 },
}

/// Count one destination-side 5xx against the subscription, disabling it once
/// `disable_after` consecutive failures have accumulated.
///
/// Takes `FOR UPDATE` on the row: two sender workers draining two events for the
/// same subscription must not both read `4` and both write `5`, because the
/// threshold would then be crossed twice and never observed once.
///
/// Call this inside the caller's transaction together with the outbox
/// settlement, so "the subscription was disabled" and "this row was failed"
/// commit as one fact.
pub async fn register_delivery_failure(
    conn: &mut PgConnection,
    subscription_id: Uuid,
    http_status: i32,
    outbox_id: i64,
    disable_after: i32,
) -> Result<RegisteredFailure, DbError> {
    let current = sqlx::query(
        "SELECT workspace_id, delivery_failure_count, enabled \
           FROM event_subscription WHERE id = $1 FOR UPDATE",
    )
    .bind(subscription_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(current) = current else {
        return Ok(RegisteredFailure::Missing);
    };
    let workspace_id: Uuid = current.try_get("workspace_id").map_err(DbError::from)?;
    let failure_count: i32 = current
        .try_get("delivery_failure_count")
        .map_err(DbError::from)?;
    let enabled: bool = current.try_get("enabled").map_err(DbError::from)?;
    if !enabled {
        return Ok(RegisteredFailure::Disabled);
    }

    let next = failure_count.saturating_add(1);
    if next >= disable_after {
        sqlx::query(
            "UPDATE event_subscription \
                SET enabled = false, \
                    delivery_failure_count = $2, \
                    disabled_at = clock_timestamp(), \
                    disabled_reason = 'server_5xx_threshold', \
                    updated_at = clock_timestamp() \
              WHERE id = $1",
        )
        .bind(subscription_id)
        .bind(next)
        .execute(&mut *conn)
        .await?;
        // Not `write_audit`: this row has no actor, and the shape is Swift's
        // (`RelayService.recordWebhookServerFailure`). It is the only durable
        // trace that oort — not a person — turned a destination off.
        let entry =
            momo_db::audit::AuditEntry::new(workspace_id, "event_subscription.auto_disabled")
                .target("event_subscription", subscription_id)
                .with_schema(
                    "momo.event_subscription.auto_disabled.v1",
                    serde_json::json!({
                        "failure_count": next,
                        "last_status": http_status,
                        "outbox_id": outbox_id,
                    }),
                );
        momo_db::audit::write_audit(conn, &entry).await?;
        return Ok(RegisteredFailure::AutoDisabled {
            failure_count: next,
        });
    }

    sqlx::query(
        "UPDATE event_subscription \
            SET delivery_failure_count = $2, updated_at = clock_timestamp() \
          WHERE id = $1",
    )
    .bind(subscription_id)
    .bind(next)
    .execute(&mut *conn)
    .await?;
    Ok(RegisteredFailure::Counted {
        failure_count: next,
    })
}

/// Record that one payload left this workspace for an external host (#1204,
/// ADR-0150 D3 symmetry).
///
/// **This function takes no body and cannot be given one**, because the SQL
/// function it calls has no such parameter (063). That is the contract, not an
/// oversight: `audit_log` is read at workspace-admin level while a message is
/// read at channel level, so an audit row carrying the body would be a second
/// copy of the conversation behind a *wider* permission. What is recorded is
/// when, which subscription, which kind, which host — and `target_host` is the
/// host alone, because a path or query can carry a token the subscriber put
/// there.
///
/// Call it **outside** the settlement transaction. The settlement says what the
/// queue does next; this says what already happened on the wire, and a rollback
/// caused by a queue-side conflict must not erase the record of an egress that
/// really occurred.
#[allow(clippy::too_many_arguments)]
pub async fn record_delivery_audit(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    subscription_id: Uuid,
    event_kind: &str,
    event_id: Option<Uuid>,
    target_host: &str,
    outbox_id: i64,
    attempt: i32,
    http_status: i32,
) -> Result<Uuid, DbError> {
    let id: Uuid = sqlx::query_scalar(
        "SELECT record_event_subscription_delivery($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(workspace_id)
    .bind(subscription_id)
    .bind(event_kind)
    .bind(event_id)
    .bind(target_host)
    .bind(outbox_id)
    .bind(attempt)
    .bind(http_status)
    .fetch_one(&mut *conn)
    .await?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_are_deduplicated_sorted_and_closed() {
        assert_eq!(
            validated_kinds(&[
                "work.status_changed".into(),
                "mention".into(),
                "mention".into()
            ]),
            Some(vec![
                "mention".to_string(),
                "work.status_changed".to_string()
            ])
        );
        assert_eq!(validated_kinds(&[]), None);
        assert_eq!(validated_kinds(&["nope".into()]), None);
        assert_eq!(
            validated_kinds(&["mention".into(), "MENTION".into()]),
            None,
            "the DB constraint is case sensitive; accepting a variant here would be a 500 later"
        );
    }

    /// The one field that separates what a route may return from what the sender
    /// needs. If `SubscriptionRow` ever grows a `secret_ref`, this stops compiling
    /// only if someone also writes the field — so the assertion is spelled out.
    #[test]
    fn the_route_projection_names_no_derivation_material() {
        assert!(
            !PROJECTION.contains("secret_ref"),
            "no management response may select secret_ref: it is answered once, at create, \
             and recomputed nowhere else"
        );
    }
}
