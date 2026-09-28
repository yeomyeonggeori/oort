//! ADR-0188 D5 — the permission bridge's ledger (`work_permission_request`,
//! migration 092, #3000).
//!
//! A member host relays an ACP `session/request_permission` as an
//! `approval.requested` session event; the ingestion transaction records one
//! row here, keyed by that event's id (the host-issued one-time nonce D5 binds
//! the request to). The session owner decides it once through
//! `POST …/work-sessions/{session}/permission-decisions`, and the decision
//! reaches the host as a `permission` control
//! ([`crate::work_control::KIND_PERMISSION`]).
//!
//! Every state change here is a conditional `UPDATE … WHERE status =
//! 'pending'`: the first writer wins and every later one finds nothing to move,
//! which is how 「첫 결정이 이긴다」 is a property of the database rather than
//! of a route remembering to check.

use momo_db::sqlx;
use momo_db::PgConnection;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::T3Error;

pub const STATUS_PENDING: &str = "pending";
pub const STATUS_APPROVED: &str = "approved";
pub const STATUS_REJECTED: &str = "rejected";
pub const STATUS_EXPIRED: &str = "expired";
pub const STATUS_CANCELLED: &str = "cancelled";

/// The two option kinds the bridge can choose (ADR-0188 D5: 「이번 한 번」, and
/// R1 폰 = 이번 한 번만). `allow_always` / `reject_always` would write a rule
/// into the agent's settings, which the host never does.
pub const KIND_ALLOW_ONCE: &str = "allow_once";
pub const KIND_REJECT_ONCE: &str = "reject_once";

/// How long a request waits for its owner (ADR-0188 D7 「짧은 TTL」). The host
/// waits a little longer than this (`momo-workd`), so an in-time decision is
/// never discarded by the host's own clock.
pub const PERMISSION_REQUEST_TTL_SECONDS: i64 = 600;

const OPTION_ID_MAX: usize = 128;
const OPTIONS_MAX: usize = 16;

/// Is `kind` one the bridge may choose?
pub fn is_bridgeable_kind(kind: &str) -> bool {
    kind == KIND_ALLOW_ONCE || kind == KIND_REJECT_ONCE
}

/// One option the owner may choose.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionOption {
    pub option_id: String,
    pub kind: String,
}

/// The options of an `approval.requested` payload the bridge can offer:
/// `allow_once` and `reject_once` with a usable id, nothing else. Everything
/// else a host sent (an `allow_always`, a kind this server does not know) is
/// dropped here, so it can never be the option a decision names.
pub fn bridgeable_options(options: &Value) -> Vec<PermissionOption> {
    let Some(items) = options.as_array() else {
        return Vec::new();
    };
    // The same id twice (under any kinds) is ambiguous — the agent decides
    // what an id means — so nothing is decidable (#3000 review M-1).
    let mut seen = std::collections::HashSet::new();
    let unique = items.iter().all(|item| {
        seen.insert(
            item.get("option_id")
                .map(|id| id.to_string())
                .unwrap_or_default(),
        )
    });
    if !unique {
        return Vec::new();
    }
    items
        .iter()
        .take(OPTIONS_MAX)
        .filter_map(|item| {
            let option_id = item.get("option_id")?.as_str()?;
            let kind = item.get("kind")?.as_str()?;
            (!option_id.is_empty()
                && option_id.chars().count() <= OPTION_ID_MAX
                && is_bridgeable_kind(kind))
            .then(|| PermissionOption {
                option_id: option_id.to_string(),
                kind: kind.to_string(),
            })
        })
        .collect()
}

fn options_json(options: &[PermissionOption]) -> Value {
    Value::Array(
        options
            .iter()
            .map(|option| json!({"option_id": option.option_id, "kind": option.kind}))
            .collect(),
    )
}

fn options_from_json(raw: &Value) -> Vec<PermissionOption> {
    bridgeable_options(raw)
}

/// The closed `permission` control payload (092 `work_control_payload_ck`).
pub fn permission_control_payload(request_event_id: Uuid, option_id: &str, kind: &str) -> Value {
    json!({
        "request_event_id": request_event_id.to_string(),
        "option_id": option_id,
        "kind": kind,
    })
}

/// One `work_permission_request` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionRequestRow {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub work_session_id: Uuid,
    pub host_id: Uuid,
    pub channel_id: Uuid,
    pub request_event_id: Uuid,
    pub options: Vec<PermissionOption>,
    pub status: String,
    /// `expires_at` has passed (judged by the database clock).
    pub lapsed: bool,
    pub expires_at_ms: i64,
    pub decided_by: Option<Uuid>,
    pub decided_option_id: Option<String>,
    pub decided_kind: Option<String>,
    pub decided_at_ms: Option<i64>,
    pub control_id: Option<Uuid>,
    pub created_at_ms: i64,
}

const COLUMNS: &str = "id, workspace_id, work_session_id, host_id, channel_id, \
     request_event_id, options, status, \
     (expires_at <= clock_timestamp()) AS lapsed, \
     floor(extract(epoch from expires_at) * 1000)::bigint AS expires_at_ms, \
     decided_by, decided_option_id, decided_kind, \
     floor(extract(epoch from decided_at) * 1000)::bigint AS decided_at_ms, \
     control_id, \
     floor(extract(epoch from created_at) * 1000)::bigint AS created_at_ms";

fn decode(row: &sqlx::postgres::PgRow) -> Result<PermissionRequestRow, sqlx::Error> {
    use sqlx::Row as _;
    let options: Value = row.try_get("options")?;
    Ok(PermissionRequestRow {
        id: row.try_get("id")?,
        workspace_id: row.try_get("workspace_id")?,
        work_session_id: row.try_get("work_session_id")?,
        host_id: row.try_get("host_id")?,
        channel_id: row.try_get("channel_id")?,
        request_event_id: row.try_get("request_event_id")?,
        options: options_from_json(&options),
        status: row.try_get("status")?,
        lapsed: row.try_get("lapsed")?,
        expires_at_ms: row.try_get("expires_at_ms")?,
        decided_by: row.try_get("decided_by")?,
        decided_option_id: row.try_get("decided_option_id")?,
        decided_kind: row.try_get("decided_kind")?,
        decided_at_ms: row.try_get("decided_at_ms")?,
        control_id: row.try_get("control_id")?,
        created_at_ms: row.try_get("created_at_ms")?,
    })
}

/// What an ingested `approval.requested` event records.
#[derive(Debug, Clone)]
pub struct NewPermissionRequest {
    pub work_session_id: Uuid,
    pub host_id: Uuid,
    pub channel_id: Uuid,
    pub request_event_id: Uuid,
    pub options: Vec<PermissionOption>,
}

/// Record a relayed request. A retried event (same id) records nothing new.
/// Returns whether a row was written.
pub async fn insert_permission_request_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    new: &NewPermissionRequest,
) -> Result<bool, T3Error> {
    let result = sqlx::query(
        "INSERT INTO work_permission_request \
           (workspace_id, work_session_id, host_id, channel_id, request_event_id, \
            options, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, \
                 clock_timestamp() + make_interval(secs => $7)) \
         ON CONFLICT (workspace_id, work_session_id, request_event_id) DO NOTHING",
    )
    .bind(workspace_id)
    .bind(new.work_session_id)
    .bind(new.host_id)
    .bind(new.channel_id)
    .bind(new.request_event_id)
    .bind(options_json(&new.options))
    .bind(PERMISSION_REQUEST_TTL_SECONDS as f64)
    .execute(&mut *conn)
    .await?;
    Ok(result.rows_affected() == 1)
}

/// Lock one request of one session (`FOR UPDATE`). The caller holds the
/// session row first (session → request, the order ingestion uses).
pub async fn lock_permission_request_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    work_session_id: Uuid,
    request_event_id: Uuid,
) -> Result<Option<PermissionRequestRow>, T3Error> {
    let sql = format!(
        "SELECT {COLUMNS} FROM work_permission_request \
          WHERE workspace_id = $1 AND work_session_id = $2 AND request_event_id = $3 \
          FOR UPDATE"
    );
    let row = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(work_session_id)
        .bind(request_event_id)
        .fetch_optional(&mut *conn)
        .await?;
    row.as_ref().map(decode).transpose().map_err(Into::into)
}

/// `pending → expired | cancelled`. `None` when the row was no longer pending.
pub async fn close_permission_request_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    id: Uuid,
    status: &str,
) -> Result<Option<PermissionRequestRow>, T3Error> {
    if status != STATUS_EXPIRED && status != STATUS_CANCELLED {
        return Err(T3Error::IllegalTransition(format!(
            "permission request cannot close as {status}"
        )));
    }
    let sql = format!(
        "UPDATE work_permission_request \
            SET status = $3, updated_at = now() \
          WHERE workspace_id = $1 AND id = $2 AND status = '{STATUS_PENDING}' \
          RETURNING {COLUMNS}"
    );
    let row = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(id)
        .bind(status)
        .fetch_optional(&mut *conn)
        .await?;
    row.as_ref().map(decode).transpose().map_err(Into::into)
}

/// The owner's decision: `pending → approved | rejected`, only while it has not
/// lapsed. `None` when another decision (or a close) got there first.
pub async fn decide_permission_request_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    id: Uuid,
    decided_by: Uuid,
    option: &PermissionOption,
) -> Result<Option<PermissionRequestRow>, T3Error> {
    let status = match option.kind.as_str() {
        KIND_ALLOW_ONCE => STATUS_APPROVED,
        KIND_REJECT_ONCE => STATUS_REJECTED,
        other => {
            return Err(T3Error::IllegalTransition(format!(
                "permission option kind {other} is not decidable"
            )))
        }
    };
    let sql = format!(
        "UPDATE work_permission_request \
            SET status = $3, decided_by = $4, decided_option_id = $5, \
                decided_kind = $6, decided_at = clock_timestamp(), updated_at = now() \
          WHERE workspace_id = $1 AND id = $2 AND status = '{STATUS_PENDING}' \
            AND expires_at > clock_timestamp() \
          RETURNING {COLUMNS}"
    );
    let row = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(id)
        .bind(status)
        .bind(decided_by)
        .bind(&option.option_id)
        .bind(&option.kind)
        .fetch_optional(&mut *conn)
        .await?;
    row.as_ref().map(decode).transpose().map_err(Into::into)
}

/// Bind the `permission` control a decision created to its request.
pub async fn attach_permission_control_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    id: Uuid,
    control_id: Uuid,
) -> Result<Option<PermissionRequestRow>, T3Error> {
    let sql = format!(
        "UPDATE work_permission_request \
            SET control_id = $3, updated_at = now() \
          WHERE workspace_id = $1 AND id = $2 \
          RETURNING {COLUMNS}"
    );
    let row = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(id)
        .bind(control_id)
        .fetch_optional(&mut *conn)
        .await?;
    row.as_ref().map(decode).transpose().map_err(Into::into)
}

/// ADR-0188 D5 「재시작·세션 종료·revoke 때는 대기 중인 승인을 취소한다」 —
/// every pending request of one session. Returns how many were cancelled.
pub async fn cancel_pending_for_session_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    work_session_id: Uuid,
) -> Result<u64, T3Error> {
    let result = sqlx::query(
        "UPDATE work_permission_request \
            SET status = 'cancelled', updated_at = now() \
          WHERE workspace_id = $1 AND work_session_id = $2 AND status = 'pending'",
    )
    .bind(workspace_id)
    .bind(work_session_id)
    .execute(&mut *conn)
    .await?;
    Ok(result.rows_affected())
}

/// The same for every session of one host (revoke). Speaks `DbError`: the
/// revoke route's transaction does.
pub async fn cancel_pending_for_host_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    host_id: Uuid,
) -> Result<u64, momo_db::DbError> {
    let result = sqlx::query(
        "UPDATE work_permission_request \
            SET status = 'cancelled', updated_at = now() \
          WHERE workspace_id = $1 AND host_id = $2 AND status = 'pending'",
    )
    .bind(workspace_id)
    .bind(host_id)
    .execute(&mut *conn)
    .await?;
    Ok(result.rows_affected())
}

/// A host withdrew one request (it answered the agent itself: its wait ran
/// out, or the turn was cancelled). Only a pending row moves.
pub async fn withdraw_permission_request_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    work_session_id: Uuid,
    request_event_id: Uuid,
) -> Result<bool, T3Error> {
    let result = sqlx::query(
        "UPDATE work_permission_request \
            SET status = 'cancelled', updated_at = now() \
          WHERE workspace_id = $1 AND work_session_id = $2 \
            AND request_event_id = $3 AND status = 'pending'",
    )
    .bind(workspace_id)
    .bind(work_session_id)
    .bind(request_event_id)
    .execute(&mut *conn)
    .await?;
    Ok(result.rows_affected() == 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_two_once_kinds_are_bridgeable() {
        let options = json!([
            {"option_id": "allow-always", "name": "Always", "kind": "allow_always"},
            {"option_id": "allow-once", "name": "Allow", "kind": "allow_once"},
            {"option_id": "reject-once", "name": "Reject", "kind": "reject_once"},
            {"option_id": "reject-always", "name": "Never", "kind": "reject_always"},
            {"option_id": "", "name": "Empty", "kind": "allow_once"},
            {"option_id": "x".repeat(129), "name": "Long", "kind": "reject_once"},
            {"option_id": "no-kind", "name": "No kind"},
            {"option_id": "odd", "name": "Odd", "kind": "Allow_Once"}
        ]);
        assert_eq!(
            bridgeable_options(&options),
            vec![
                PermissionOption {
                    option_id: "allow-once".into(),
                    kind: "allow_once".into()
                },
                PermissionOption {
                    option_id: "reject-once".into(),
                    kind: "reject_once".into()
                },
            ]
        );
        assert!(bridgeable_options(&json!({})).is_empty());
        // One id under two kinds: nothing is decidable (review M-1).
        assert!(bridgeable_options(&json!([
            {"option_id": "a", "name": "Always", "kind": "allow_always"},
            {"option_id": "a", "name": "Once", "kind": "allow_once"},
            {"option_id": "r", "name": "Reject", "kind": "reject_once"}
        ]))
        .is_empty());
        assert!(!is_bridgeable_kind("allow_always"));
        assert!(!is_bridgeable_kind("reject_always"));
    }

    #[test]
    fn the_control_payload_is_the_closed_three_keys() {
        let id = Uuid::from_u128(9);
        let payload = permission_control_payload(id, "allow-once", KIND_ALLOW_ONCE);
        let mut keys: Vec<&str> = payload
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, ["kind", "option_id", "request_event_id"]);
        assert_eq!(payload["request_event_id"], id.to_string());
    }
}
