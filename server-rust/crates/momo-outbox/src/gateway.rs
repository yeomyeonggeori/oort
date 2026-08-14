//! The gateway `agent_job` claim/lease surface (migration 008, MOMO-341).
//!
//! Ports the four outbox statements of Swift `AgentGatewayRoutes` — the claim
//! CTE (:76-118), lease renew (:160-175), lease release (:205-221) and the
//! settle-on-completion update (:1018-1035) — plus the lease authorization read
//! (:1244-1259).
//!
//! It lives in `momo-outbox` for the same reason [`crate::emit`] does: this crate
//! is where `outbox` SQL lives, and a lease is a column set on an `outbox` row.
//! [`crate::relay`] already owns the *broadcast* claim; this is the `agent_job`
//! one, and the two `WHERE` clauses exclude each other by `kind` so neither
//! consumer can drain the other's feed.
//!
//! ## Why the claim is durable rather than advisory
//!
//! A realtime `agent.job` publication is a **wake-up**, not a work item: it can
//! be delivered twice, to two gateway processes, or not at all. Migration 008's
//! header states the consequence — "these columns make that claim durable so
//! overlapping gateway consumers cannot both start provider work, while an
//! expired owner can be taken over after a crash". So the claim is
//! `FOR UPDATE … SKIP LOCKED` (two claimers never see the same row) and the
//! lease has an *expiry* (a crashed claimer's row returns to the pool), and
//! every later callback must present the `lease_owner` it was handed.
//!
//! ## The uuid comparisons are case-folded
//!
//! `outbox.payload` carries ids as **text**, and this server's producers
//! disagree about their case: `momo_agent::mention::mention_job_payload` writes
//! them uppercase (Swift parity for the payload a gateway reads) while the
//! work/resume producers write them lowercase. A raw `=` therefore matched a
//! work job and silently missed every *mention* job — the most common kind —
//! so a lease for one could never be claimed, renewed, released or settled.
//! `lower()` on both sides is the same narrowest fix
//! `retire_pending_agent_jobs_for_run_in_tx` already documents, and a `::uuid`
//! cast is rejected for the same reason it is there: it raises on any row whose
//! payload happens to hold a non-uuid id, turning one malformed job into a
//! failed claim for the whole tenant.
//!
//! ## The lease is the callback's only authority
//!
//! [`gateway_lease_authorized`] is the pure decision behind every gateway
//! callback: an event or a completion is accepted **only** while the presented
//! `lease_id` still owns a pending, unexpired job bound to this run and agent.
//! Without it, anybody who learned a `run_id` could complete someone else's run.

use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

/// Lease duration (Swift `AgentGatewayRoutes.leaseDurationSeconds` :17).
pub const GATEWAY_LEASE_SECONDS: i64 = 30;

/// Bounds on `?limit=` for the pending-jobs claim (Swift :64).
pub const CLAIM_LIMIT_DEFAULT: i64 = 20;
pub const CLAIM_LIMIT_MAX: i64 = 100;

/// `min(max(limit ?? 20, 1), 100)` — Swift :64 verbatim.
pub fn clamp_claim_limit(limit: Option<i64>) -> i64 {
    limit
        .unwrap_or(CLAIM_LIMIT_DEFAULT)
        .clamp(1, CLAIM_LIMIT_MAX)
}

/// What a caller must present to act on a claimed job: the `outbox.id` and the
/// opaque `lease_owner` capability the claim minted (Swift
/// `AgentGatewayLeaseBinding`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GatewayLeaseBinding {
    pub job_id: i64,
    pub lease_id: Uuid,
}

/// One claimed `agent_job` row (Swift `AgentGatewayPendingJobDTO`).
#[derive(Debug, Clone)]
pub struct ClaimedGatewayJob {
    pub id: i64,
    pub payload: Value,
    pub created_at: DateTime<Utc>,
    pub lease_id: Uuid,
    pub lease_expires_at: DateTime<Utc>,
}

impl ClaimedGatewayJob {
    /// `payload.run_id`, or `""` when the payload has none — Swift's
    /// `payload.objectValue?["run_id"]?.stringValue ?? ""` (:131).
    pub fn run_id_field(&self) -> &str {
        self.payload
            .get("run_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
    }
}

/// The state of the outbox row a lease claims to own (Swift
/// `GatewayLeaseSnapshot`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GatewayLeaseSnapshot {
    /// `outbox.status` — `pending` while the job is live, `done` once settled.
    pub status: GatewayJobStatus,
    pub owner: Option<Uuid>,
    /// `lease_expires_at > now()`, computed by the database clock.
    pub active: bool,
}

/// The `outbox_status` labels this module distinguishes. Anything that is
/// neither `pending` nor `done` (`failed`, `dead`) can never authorize a
/// callback, so it collapses into [`GatewayJobStatus::Other`] rather than
/// growing a variant that some `match` arm might accidentally accept.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GatewayJobStatus {
    Pending,
    Done,
    Other,
}

impl GatewayJobStatus {
    pub fn from_db_label(label: &str) -> Self {
        match label {
            "pending" => GatewayJobStatus::Pending,
            "done" => GatewayJobStatus::Done,
            _ => GatewayJobStatus::Other,
        }
    }
}

/// May the presented lease act on this job? Swift `gatewayLeaseAuthorized`
/// (:1271-1279), extracted so the rule is unit-testable without a database.
///
/// `allow_settled` is the retry window: once a run is terminal its job row has
/// already been marked `done`, and a gateway that never saw the 200 must be able
/// to replay its completion and get the same answer. Ownership is still
/// required — `allow_settled` widens *which status* is acceptable, never *who*.
pub fn gateway_lease_authorized(
    snapshot: Option<GatewayLeaseSnapshot>,
    presented_lease_id: Uuid,
    allow_settled: bool,
) -> bool {
    let Some(snapshot) = snapshot else {
        return false;
    };
    if snapshot.owner != Some(presented_lease_id) {
        return false;
    }
    (snapshot.status == GatewayJobStatus::Pending && snapshot.active)
        || (snapshot.status == GatewayJobStatus::Done && allow_settled)
}

/// Claim up to `limit` pending gateway jobs for one agent, minting a lease on
/// each. Ports the Swift CTE (:76-118) statement-for-statement.
///
/// Three predicates carry weight beyond "find some rows":
///   * `FOR UPDATE OF o SKIP LOCKED` — two concurrent claimers get disjoint sets
///     instead of blocking or double-starting provider work;
///   * `lease_expires_at IS NULL OR <= now()` — a crashed owner's job becomes
///     takeover-eligible on its own, with no reaper;
///   * the `EXISTS` on `member`/`agent` — a deactivated agent's queue stops
///     draining, so revoking an agent stops its work even if a credential leaked.
pub async fn claim_gateway_jobs_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    limit: i64,
) -> Result<Vec<ClaimedGatewayJob>, sqlx::Error> {
    claim_gateway_jobs(conn, workspace_id, agent_member_id, limit, None).await
}

/// The **hosted** half of the same claim (ADR-0162 / HAP-E5).
///
/// **The human's exact-channel grant is re-checked here, at claim time.** A
/// hosted connection is confirmed for a named set of channels (HAP-E3), and the
/// job payload names the channel the work came from — so a job from a channel
/// outside `approved_channel_ids` is simply not a candidate. Two properties
/// follow, and both are the reason this lives in the claim rather than only in
/// the producer:
///
/// * an unapproved-channel job is **never leased**. It stays `pending` and
///   invisible instead of being handed over and withheld, so its prompt and
///   recent messages never cross the wire;
/// * the check reads the connection row **live, in the claiming transaction**,
///   so narrowing the approval after a job was created stops the next claim —
///   a producer-side check alone could only ever describe the past.
///
/// The comparison unnests the approved array and folds case rather than casting
/// the payload text to `uuid`, for the same reason the other id comparisons do:
/// a cast raises, and one malformed row must not fail the tenant's whole claim.
///
/// One further predicate the managed branch does not carry: the payload's
/// `run_id` must be uuid-shaped. A hosted caller acts on work through a sealed handle that
/// *contains* the run, so a row without a usable run id could be claimed and
/// leased but never renewed, released or completed — and because a claim mints
/// a fresh lease every cycle, it would be re-leased forever while being
/// silently withheld. Refusing to claim it is what stops that loop; the row
/// stays `pending` and visible to an operator rather than churning. The shape
/// test is a case-insensitive regex rather than a `::uuid` cast for the reason
/// the case-folding note above gives: a cast raises, and one malformed row must
/// not fail the whole tenant's claim.
///
/// A hosted agent reaches its work through the Agent Port, never over the REST
/// callback surface, so [`claim_gateway_jobs_in_tx`] deliberately excludes every
/// agent that has a `hosted_agent_connection` row at all (HAP-E3's fail-closed
/// posture). This is the door that replaces it — and it is the *same statement*,
/// not a second one: `claim_gateway_jobs` builds one CTE and only the hosted
/// eligibility predicate differs, so the lease columns, `SKIP LOCKED`, takeover
/// window and per-agent binding cannot drift between the two callers.
///
/// The extra predicate is the whole hosted authority: the connection named by
/// the caller's credential must be **this** agent's, `active`, proved, and still
/// carry a live `agent:jobs:read` bearer bound to the Agent Port audience. An
/// expired, revoked or downgraded connection therefore claims nothing rather
/// than falling back to the managed feed.
pub async fn claim_hosted_gateway_jobs_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    connection_id: Uuid,
    limit: i64,
) -> Result<Vec<ClaimedGatewayJob>, sqlx::Error> {
    claim_gateway_jobs(
        conn,
        workspace_id,
        agent_member_id,
        limit,
        Some(connection_id),
    )
    .await
}

async fn claim_gateway_jobs(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    limit: i64,
    hosted_connection_id: Option<Uuid>,
) -> Result<Vec<ClaimedGatewayJob>, sqlx::Error> {
    // `$5 IS NULL` selects the managed branch, so both callers execute one
    // prepared statement whose only difference is which hosted predicate is
    // live. Two SQL literals would be two things to keep in step.
    let rows = sqlx::query(
        "WITH candidate AS ( \
           SELECT o.id \
             FROM outbox o \
            WHERE o.workspace_id = $1 \
              AND o.kind = 'agent_job' \
              AND o.method = 'gateway' \
              AND o.status = 'pending' \
              AND o.available_at <= now() \
              AND o.partition_key = $2 \
              AND lower(o.payload->>'agent_member_id') = lower($2::text) \
              AND (o.lease_expires_at IS NULL OR o.lease_expires_at <= now()) \
              AND EXISTS ( \
                SELECT 1 \
                  FROM member m \
                  JOIN agent a \
                    ON a.member_id = m.id \
                   AND a.workspace_id = m.workspace_id \
                 WHERE m.id = $2 \
                   AND m.workspace_id = $1 \
                   AND m.kind = 'agent' \
                   AND m.status = 'active' \
                   AND m.deleted_at IS NULL \
              ) \
              AND ( \
                $5::uuid IS NULL \
                OR o.payload->>'run_id' ~* \
                   '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' \
              ) \
              AND ( \
                ($5::uuid IS NULL AND NOT EXISTS ( \
                  SELECT 1 FROM hosted_agent_connection hc \
                   WHERE hc.workspace_id = $1 AND hc.agent_member_id = $2 \
                )) \
                OR ($5::uuid IS NOT NULL AND EXISTS ( \
                  SELECT 1 FROM hosted_agent_connection hc \
                    JOIN token t ON t.workspace_id = hc.workspace_id \
                                AND t.id = hc.active_token_id \
                   WHERE hc.workspace_id = $1 AND hc.agent_member_id = $2 \
                     AND hc.id = $5 AND hc.status = 'active' \
                     AND hc.proved_at IS NOT NULL \
                     AND 'agent:jobs:read' = ANY(hc.approved_scopes) \
                     AND t.kind = 'agent_bearer' \
                     AND t.credential_class = 'hosted_active' \
                     AND t.revoked_at IS NULL \
                     AND (t.expires_at IS NULL OR t.expires_at > now()) \
                     AND t.hosted_connection_id = hc.id \
                     AND t.actor_member_id = hc.agent_member_id \
                     AND t.audience = '/v1/mcp/agent-port' \
                     AND 'agent:jobs:read' = ANY(t.scopes) \
                     AND EXISTS ( \
                       SELECT 1 FROM unnest(hc.approved_channel_ids) AS approved(channel_id) \
                        WHERE lower(approved.channel_id::text) \
                              = lower(o.payload->>'channel_id') \
                     ) \
                )) \
              ) \
            ORDER BY o.id ASC \
            FOR UPDATE OF o SKIP LOCKED \
            LIMIT $3 \
         ), claimed AS ( \
           UPDATE outbox o \
              SET lease_owner = uuidv7(), \
                  lease_acquired_at = now(), \
                  lease_expires_at = now() + make_interval(secs => $4) \
             FROM candidate c \
            WHERE o.id = c.id \
           RETURNING o.id, o.payload, o.created_at, o.lease_owner, o.lease_expires_at \
         ) \
         SELECT id, payload, created_at, lease_owner, lease_expires_at \
           FROM claimed \
          ORDER BY id ASC",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .bind(limit)
    .bind(GATEWAY_LEASE_SECONDS as f64)
    .bind(hosted_connection_id)
    .fetch_all(&mut *conn)
    .await?;

    rows.iter()
        .map(|row| {
            Ok(ClaimedGatewayJob {
                id: row.try_get("id")?,
                payload: row.try_get("payload")?,
                created_at: row.try_get("created_at")?,
                lease_id: row.try_get("lease_owner")?,
                lease_expires_at: row.try_get("lease_expires_at")?,
            })
        })
        .collect()
}

/// Extend a live lease, returning the new expiry (Swift :160-175). `None` means
/// the job is gone, settled, or owned by someone else — all of which the route
/// answers with the same 409, so a loser cannot probe which.
pub async fn renew_gateway_lease_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    lease: GatewayLeaseBinding,
) -> Result<Option<DateTime<Utc>>, sqlx::Error> {
    sqlx::query_scalar(
        "UPDATE outbox \
            SET lease_expires_at = now() + make_interval(secs => $5) \
          WHERE id = $3 \
            AND workspace_id = $1 \
            AND kind = 'agent_job' \
            AND method = 'gateway' \
            AND status = 'pending' \
            AND partition_key = $2 \
            AND lower(payload->>'agent_member_id') = lower($2::text) \
            AND lease_owner = $4 \
            AND lease_expires_at > now() \
        RETURNING lease_expires_at",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .bind(lease.job_id)
    .bind(lease.lease_id)
    .bind(GATEWAY_LEASE_SECONDS as f64)
    .fetch_optional(&mut *conn)
    .await
}

/// Hand a claimed job back to the pool (Swift :205-221). Returns whether this
/// call released it; the row stays `pending`, so another consumer picks it up
/// immediately rather than after the lease expires.
pub async fn release_gateway_lease_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    lease: GatewayLeaseBinding,
) -> Result<bool, sqlx::Error> {
    let released: Option<i64> = sqlx::query_scalar(
        "UPDATE outbox \
            SET lease_owner = NULL, \
                lease_acquired_at = NULL, \
                lease_expires_at = NULL \
          WHERE id = $3 \
            AND workspace_id = $1 \
            AND kind = 'agent_job' \
            AND method = 'gateway' \
            AND status = 'pending' \
            AND partition_key = $2 \
            AND lower(payload->>'agent_member_id') = lower($2::text) \
            AND lease_owner = $4 \
            AND lease_expires_at > now() \
        RETURNING id",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .bind(lease.job_id)
    .bind(lease.lease_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(released.is_some())
}

/// Lock and read the job row a lease claims, for [`gateway_lease_authorized`]
/// (Swift :1244-1259).
///
/// `FOR UPDATE` is what serializes two callbacks racing on one run: the second
/// waits for the first to commit and then re-reads a row whose status it can
/// judge, instead of both passing the check against the same stale snapshot.
///
/// The `payload->>'run_id'`/`agent_member_id` predicates bind the lease to *this*
/// run: a valid lease for job A can never authorize a callback about run B.
pub async fn lock_gateway_lease_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    agent_member_id: Uuid,
    lease: GatewayLeaseBinding,
) -> Result<Option<GatewayLeaseSnapshot>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT status::text AS status, lease_owner, \
                COALESCE(lease_expires_at > now(), false) AS active \
           FROM outbox \
          WHERE id = $4 \
            AND workspace_id = $1 \
            AND kind = 'agent_job' \
            AND method = 'gateway' \
            AND partition_key = $3 \
            AND lower(payload->>'agent_member_id') = lower($3::text) \
            AND lower(payload->>'run_id') = lower($2::text) \
          FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(run_id)
    .bind(agent_member_id)
    .bind(lease.job_id)
    .fetch_optional(&mut *conn)
    .await?;

    let Some(row) = row else { return Ok(None) };
    let status: String = row.try_get("status")?;
    Ok(Some(GatewayLeaseSnapshot {
        status: GatewayJobStatus::from_db_label(&status),
        owner: row.try_get("lease_owner")?,
        active: row.try_get("active")?,
    }))
}

/// Mark a claimed gateway job finished (Swift :1018-1035).
///
/// `last_error` is `NULL` on success and the sanitized failure text otherwise —
/// the same column the relay uses, so an operator reads one place to learn why a
/// job stopped. The `status = 'pending'` predicate is deliberately **absent**
/// here (Swift's completion update omits it too): a replayed completion of an
/// already-`done` job must be a no-op, not an error.
pub async fn settle_gateway_job_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    lease: GatewayLeaseBinding,
    last_error: Option<&str>,
) -> Result<bool, sqlx::Error> {
    let settled = sqlx::query(
        "UPDATE outbox \
            SET status = 'done', \
                processed_at = now(), \
                last_error = $5 \
          WHERE workspace_id = $1 \
            AND id = $3 \
            AND kind = 'agent_job' \
            AND method = 'gateway' \
            AND lease_owner = $4 \
            AND lower(payload->>'run_id') = lower($2::text)",
    )
    .bind(workspace_id)
    .bind(run_id)
    .bind(lease.job_id)
    .bind(lease.lease_id)
    .bind(last_error)
    .execute(&mut *conn)
    .await?;
    Ok(settled.rows_affected() > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(
        status: GatewayJobStatus,
        owner: Option<Uuid>,
        active: bool,
    ) -> Option<GatewayLeaseSnapshot> {
        Some(GatewayLeaseSnapshot {
            status,
            owner,
            active,
        })
    }

    #[test]
    fn the_limit_is_clamped_to_the_swift_bounds() {
        assert_eq!(clamp_claim_limit(None), 20);
        assert_eq!(clamp_claim_limit(Some(0)), 1);
        assert_eq!(clamp_claim_limit(Some(-5)), 1);
        assert_eq!(clamp_claim_limit(Some(7)), 7);
        assert_eq!(clamp_claim_limit(Some(1_000)), 100);
    }

    /// The rule an attacker who learned a `run_id` runs into.
    #[test]
    fn a_callback_needs_the_lease_it_was_handed() {
        let mine = Uuid::from_u128(1);
        let theirs = Uuid::from_u128(2);
        assert!(gateway_lease_authorized(
            snapshot(GatewayJobStatus::Pending, Some(mine), true),
            mine,
            false
        ));
        assert!(
            !gateway_lease_authorized(
                snapshot(GatewayJobStatus::Pending, Some(theirs), true),
                mine,
                false
            ),
            "another consumer's live lease must not authorize this caller"
        );
        assert!(
            !gateway_lease_authorized(snapshot(GatewayJobStatus::Pending, None, true), mine, false),
            "an unclaimed job authorizes nobody"
        );
        assert!(
            !gateway_lease_authorized(None, mine, true),
            "a job that does not exist (or is bound to another run/agent) authorizes nobody"
        );
    }

    /// An expired lease is exactly what a takeover consumed, so the crashed owner
    /// coming back must NOT be able to keep writing.
    #[test]
    fn an_expired_lease_stops_authorizing() {
        let mine = Uuid::from_u128(1);
        assert!(!gateway_lease_authorized(
            snapshot(GatewayJobStatus::Pending, Some(mine), false),
            mine,
            false
        ));
        assert!(
            !gateway_lease_authorized(
                snapshot(GatewayJobStatus::Pending, Some(mine), false),
                mine,
                true
            ),
            "allow_settled widens the accepted status, never the expiry"
        );
    }

    /// The completion-replay window: a settled job still answers its own owner.
    #[test]
    fn a_settled_job_answers_only_a_replay() {
        let mine = Uuid::from_u128(1);
        assert!(gateway_lease_authorized(
            snapshot(GatewayJobStatus::Done, Some(mine), false),
            mine,
            true
        ));
        assert!(
            !gateway_lease_authorized(
                snapshot(GatewayJobStatus::Done, Some(mine), false),
                mine,
                false
            ),
            "a settled job must not accept a fresh (non-replay) write"
        );
        assert!(
            !gateway_lease_authorized(
                snapshot(GatewayJobStatus::Other, Some(mine), true),
                mine,
                true
            ),
            "failed/dead jobs authorize nothing at all"
        );
    }

    #[test]
    fn only_pending_and_done_are_named_statuses() {
        assert_eq!(
            GatewayJobStatus::from_db_label("pending"),
            GatewayJobStatus::Pending
        );
        assert_eq!(
            GatewayJobStatus::from_db_label("done"),
            GatewayJobStatus::Done
        );
        for other in ["failed", "dead", ""] {
            assert_eq!(
                GatewayJobStatus::from_db_label(other),
                GatewayJobStatus::Other
            );
        }
    }

    #[test]
    fn a_payload_without_a_run_id_reads_as_empty_like_swift() {
        let job = ClaimedGatewayJob {
            id: 1,
            payload: serde_json::json!({"agent_member_id": "x"}),
            created_at: Utc::now(),
            lease_id: Uuid::from_u128(1),
            lease_expires_at: Utc::now(),
        };
        assert_eq!(job.run_id_field(), "");
        let with_run = ClaimedGatewayJob {
            payload: serde_json::json!({"run_id": "abc"}),
            ..job
        };
        assert_eq!(with_run.run_id_field(), "abc");
    }
}
