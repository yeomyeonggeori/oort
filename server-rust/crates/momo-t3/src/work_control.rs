//! The host-control ledger (ADR-0114 D4/D5 + ADR-0125 D6-A) — every statement
//! against `work_control`, `work_auto_approve`, and the host-candidate read the
//! approval card is drawn from.
//!
//! Ported from Swift `Routes/WorkControlRoutes.swift` (1,305 lines). The route
//! layer composes; this module owns the SQL, the same split
//! [`crate::lifecycle`] keeps for `work_session`.
//!
//! ## What a control is, and what it is never allowed to be
//!
//! A `work_control` row is an **instruction addressed to a host**, recorded
//! before anyone acts on it. Migration `020_work_control.sql` closes the payload
//! shape with a `CHECK` per kind, so the boundary the ADR states in prose — the
//! server records and delivers controls, and never stores host-local paths,
//! environment, process state, or credentials — is a database invariant rather
//! than a code convention. [`validated_payload`] re-states exactly that closed
//! shape at the edge so a caller gets a 400 with a sentence instead of a
//! constraint violation with a 500.
//!
//! ## The status ladder, and the one place a spawn can jump it
//!
//! ```text
//! spawn:      pending_approval ──(human says yes)──► approved ──► dispatched ──► acked | failed
//!                    └──────────(human says no)────► denied
//! spawn(auto):                                       approved ──► dispatched ──► acked | failed
//! input/read/kill:                                   approved ──► dispatched ──► acked | failed
//! ```
//!
//! Every transition below is a **guarded** `UPDATE` (`AND status = '<from>'`)
//! whose `RETURNING` row is the verdict. A read-then-write would let two
//! concurrent decisions both believe they moved the row; the guard makes the
//! loser see zero rows and answer 409. [`apply_spawn_approval_decision_in_tx`]
//! adds a second predicate — the control's `approval_message_id` must be the
//! locked approval's `request_message_id` — so a pending control cannot be
//! dispatched by deciding some *other* approval.
//!
//! ## ADR-0125 D6-A — the host candidates
//!
//! [`spawn_host_candidates_in_tx`] is the server half of the approval card's
//! host picker. Its **selectable** predicate is the same rule the client core
//! already applies in `workSessionResumeTargets`
//! (`packages/momo-core/src/features/work/workSessionModel.ts:679`) — unrevoked,
//! online, and either workspace-scoped or owned by the person who will run the
//! session. Restating it here rather than inventing a second rule is the point:
//! two surfaces that answer "which hosts may this run on" differently is how a
//! picker comes to offer a host the executor then refuses.
//!
//! Candidates that fail the predicate are **listed and marked**, not dropped: a
//! greyed "내 맥 (오프라인)" row is the honest answer to "why can't I pick my
//! laptop", and an empty list is not. [`spawn_host_is_eligible_in_tx`] is the
//! single-host form the executor calls, so the picker and the gate cannot drift.

use momo_db::{sqlx, PgConnection};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::error::T3Error;

// ---------------------------------------------------------------------------
// vocabulary
// ---------------------------------------------------------------------------

/// `work_control.kind` — the closed set `work_control_kind_ck` enforces.
pub const KIND_SPAWN: &str = "spawn";
pub const KIND_INPUT: &str = "input";
pub const KIND_READ: &str = "read";
pub const KIND_KILL: &str = "kill";

pub const STATUS_PENDING_APPROVAL: &str = "pending_approval";
pub const STATUS_APPROVED: &str = "approved";
pub const STATUS_DENIED: &str = "denied";
pub const STATUS_DISPATCHED: &str = "dispatched";
pub const STATUS_ACKED: &str = "acked";
pub const STATUS_FAILED: &str = "failed";

/// `approval.action_type` for a spawn control (Swift `createSpawnApproval`
/// :692). Deliberately **not** `tool_call`: the decision route branches on it to
/// tell a work-control approval apart from the generic agent tool approval, and
/// collapsing the two would send one down the other's resume path.
pub const ACTION_TYPE_WORK_SPAWN: &str = "work.spawn";

/// The `approval.payload.source` marker that says "this approval owns a
/// `work_control` row" (Swift `workControlID(from:)` :536).
pub const APPROVAL_SOURCE_WORK_CONTROL: &str = "work_control";

/// ADR-0136 — momo Cloud (T3) is **off by default** and the spawn picker keeps
/// its slot without offering it.
///
/// This is the whole "T3 자리 예약" of the first stage, written as one constant
/// so the T3 track has exactly one line to flip: a `cloud` host is still listed
/// as a candidate (the picker shows three tiers, not two), but it is never
/// selectable and [`spawn_host_is_eligible_in_tx`] refuses it. Leaving it out of
/// the list entirely would have made "momo Cloud" a feature nobody can see is
/// coming; making it selectable would have promised a host this build cannot
/// settle a ledger for.
pub const T3_SPAWN_ENABLED: bool = false;

/// The reason string a cloud candidate carries while [`T3_SPAWN_ENABLED`] is
/// false.
pub const UNAVAILABLE_T3_DISABLED: &str = "t3_disabled";
/// The host is registered but nothing has heartbeated inside the 90s window.
pub const UNAVAILABLE_OFFLINE: &str = "offline";
/// A member-scoped host belonging to someone other than the session owner.
pub const UNAVAILABLE_OTHER_MEMBER: &str = "other_member_host";
/// The registration was revoked (ADR-0125 D8: revoke stops control consumption
/// immediately).
pub const UNAVAILABLE_REVOKED: &str = "revoked";

/// `work_host.type` → the tier vocabulary the picker speaks (ADR-0125 D6-A:
/// 내 맥 / 팀 VPS / momo Cloud).
pub fn host_tier(host_type: &str) -> &'static str {
    match host_type {
        "app" => "local",
        "workd" => "remote",
        "cloud" => "cloud",
        // A type the registry does not know is not evidence of anything, and
        // guessing "local" would put an unknown machine behind the default.
        _ => "unknown",
    }
}

// ---------------------------------------------------------------------------
// rows
// ---------------------------------------------------------------------------

/// One `work_control` row, in the shape the wire DTO and the events need.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkControlRow {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub channel_id: Uuid,
    pub requester_member_id: Uuid,
    pub target_host_id: Uuid,
    pub session_id: Option<Uuid>,
    pub kind: String,
    pub payload: Value,
    pub status: String,
    pub approval_message_id: Option<Uuid>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

impl WorkControlRow {
    /// The `payload.tool` of a spawn control, or `None` for every other kind.
    pub fn tool(&self) -> Option<&str> {
        self.payload.get("tool").and_then(Value::as_str)
    }

    /// The `payload.label` of a spawn control.
    pub fn label(&self) -> Option<&str> {
        self.payload.get("label").and_then(Value::as_str)
    }
}

/// What a caller must state to record a control.
#[derive(Debug, Clone)]
pub struct NewWorkControl {
    pub channel_id: Uuid,
    pub requester_member_id: Uuid,
    pub target_host_id: Uuid,
    pub session_id: Option<Uuid>,
    pub kind: String,
    pub payload: Value,
    pub status: String,
}

const CONTROL_COLUMNS: &str = "id, \
     workspace_id, \
     channel_id, \
     requester_member_id, \
     target_host_id, \
     session_id, \
     kind, \
     payload, \
     status, \
     approval_message_id, \
     floor(extract(epoch from created_at) * 1000)::bigint AS created_at_ms, \
     floor(extract(epoch from updated_at) * 1000)::bigint AS updated_at_ms";

fn decode_control(row: &sqlx::postgres::PgRow) -> Result<WorkControlRow, sqlx::Error> {
    use sqlx::Row as _;
    Ok(WorkControlRow {
        id: row.try_get("id")?,
        workspace_id: row.try_get("workspace_id")?,
        channel_id: row.try_get("channel_id")?,
        requester_member_id: row.try_get("requester_member_id")?,
        target_host_id: row.try_get("target_host_id")?,
        session_id: row.try_get("session_id")?,
        kind: row.try_get("kind")?,
        payload: row.try_get("payload")?,
        status: row.try_get("status")?,
        approval_message_id: row.try_get("approval_message_id")?,
        created_at_ms: row.try_get("created_at_ms")?,
        updated_at_ms: row.try_get("updated_at_ms")?,
    })
}

// ---------------------------------------------------------------------------
// payload validation (Swift `validatedPayload` :558-613)
// ---------------------------------------------------------------------------

/// Why a payload was refused, with the sentence Swift answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PayloadRejection(pub &'static str);

/// Normalize and close the payload for one kind, exactly as
/// `work_control_payload_ck` will.
///
/// The validator exists **in front of** the constraint rather than instead of
/// it: the constraint is the invariant, and this is the sentence. A payload that
/// reached the database malformed would answer 500 with a Postgres error string,
/// which tells a client nothing it can act on.
///
/// Normalization matters as much as rejection: the returned object is rebuilt
/// from the fields that survived, so an accepted control stores exactly the keys
/// the constraint names and nothing a caller smuggled alongside them.
pub fn validated_payload(raw: &Value, kind: &str) -> Result<Value, PayloadRejection> {
    let Some(object) = raw.as_object() else {
        return Err(PayloadRejection("payload must be an object"));
    };
    let keys: Vec<&str> = object.keys().map(String::as_str).collect();
    let mut normalized = Map::new();

    match kind {
        KIND_SPAWN => {
            if keys.len() != 2 || !object.contains_key("tool") || !object.contains_key("label") {
                return Err(PayloadRejection("payload contains unsupported fields"));
            }
            let (Some(tool), Some(label)) = (
                object.get("tool").and_then(Value::as_str),
                object.get("label").and_then(Value::as_str),
            ) else {
                return Err(PayloadRejection(
                    "spawn payload requires tool and label strings",
                ));
            };
            let tool = validated_tool_key(tool)?;
            let label = validated_label(label)?;
            normalized.insert("tool".into(), json!(tool));
            normalized.insert("label".into(), json!(label));
        }
        KIND_INPUT => {
            if keys != ["text"] {
                return Err(PayloadRejection("payload contains unsupported fields"));
            }
            let Some(text) = object.get("text").and_then(Value::as_str) else {
                return Err(PayloadRejection(
                    "input text must contain 1...32768 characters",
                ));
            };
            if text.is_empty() || text.chars().count() > 32_768 {
                return Err(PayloadRejection(
                    "input text must contain 1...32768 characters",
                ));
            }
            normalized.insert("text".into(), json!(text));
        }
        KIND_READ => {
            if !keys.iter().all(|key| *key == "tail_lines") {
                return Err(PayloadRejection("read payload only accepts tail_lines"));
            }
            if let Some(value) = object.get("tail_lines") {
                let Some(lines) = value.as_i64() else {
                    return Err(PayloadRejection(
                        "tail_lines must be an integer from 1 through 9999",
                    ));
                };
                if !(1..=9_999).contains(&lines) || !value.is_i64() {
                    return Err(PayloadRejection(
                        "tail_lines must be an integer from 1 through 9999",
                    ));
                }
                normalized.insert("tail_lines".into(), json!(lines));
            }
        }
        KIND_KILL => {
            if !keys.is_empty() {
                return Err(PayloadRejection("payload contains unsupported fields"));
            }
        }
        _ => return Err(PayloadRejection("kind must be spawn, input, read, or kill")),
    }
    Ok(Value::Object(normalized))
}

/// `WorkToolProfileRoutes.validatedToolKey` (:247-253) —
/// `^[a-z0-9][a-z0-9._-]{1,63}$`, lowercased and trimmed.
///
/// Shared with [`crate::lifecycle`]'s work-session surface through the route
/// layer so a tool key that names a session and a tool key that names a spawn
/// are the same string.
pub fn validated_tool_key(raw: &str) -> Result<String, PayloadRejection> {
    let value = raw.trim().to_lowercase();
    let mut characters = value.chars();
    let first_ok = characters
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    let rest: Vec<char> = characters.collect();
    let rest_ok = (1..=63).contains(&rest.len())
        && rest
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "._-".contains(*c));
    if first_ok && rest_ok {
        Ok(value)
    } else {
        Err(PayloadRejection("invalid work tool key"))
    }
}

/// `validatedLabel` (:2099-2105) — 1…120 characters after trimming.
pub fn validated_label(raw: &str) -> Result<String, PayloadRejection> {
    let value = raw.trim().to_string();
    let length = value.chars().count();
    if (1..=120).contains(&length) {
        Ok(value)
    } else {
        Err(PayloadRejection(
            "spawn label must contain 1...120 characters",
        ))
    }
}

/// Swift `validateSessionShape` (:1214-1221): a spawn opens without a session
/// and every other kind addresses one.
pub fn validated_session_shape(kind: &str, session_id: Option<Uuid>) -> Result<(), &'static str> {
    if kind == KIND_SPAWN && session_id.is_some() {
        return Err("spawn must not provide sessionId");
    }
    if kind != KIND_SPAWN && session_id.is_none() {
        return Err("non-spawn controls require sessionId");
    }
    Ok(())
}

/// Swift `validatedErrorLabel` (:1223-1230).
pub fn validated_error_label(raw: Option<&str>) -> Result<Option<String>, &'static str> {
    let Some(raw) = raw else { return Ok(None) };
    let label = raw.trim().to_string();
    let length = label.chars().count();
    if (1..=120).contains(&length) {
        Ok(Some(label))
    } else {
        Err("errorLabel must contain 1...120 characters")
    }
}

// ---------------------------------------------------------------------------
// ledger writes
// ---------------------------------------------------------------------------

/// Record one control. The caller has already validated kind, payload, session
/// shape, run lineage and target host.
pub async fn insert_work_control_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    new: NewWorkControl,
) -> Result<WorkControlRow, T3Error> {
    let sql = format!(
        "INSERT INTO work_control \
           (workspace_id, channel_id, requester_member_id, target_host_id, \
            session_id, kind, payload, status) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
         RETURNING {CONTROL_COLUMNS}"
    );
    let row = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(new.channel_id)
        .bind(new.requester_member_id)
        .bind(new.target_host_id)
        .bind(new.session_id)
        .bind(&new.kind)
        .bind(&new.payload)
        .bind(&new.status)
        .fetch_one(&mut *conn)
        .await?;
    Ok(decode_control(&row)?)
}

/// Read one control without locking it.
pub async fn fetch_work_control_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    control_id: Uuid,
) -> Result<Option<WorkControlRow>, T3Error> {
    let sql =
        format!("SELECT {CONTROL_COLUMNS} FROM work_control WHERE id = $1 AND workspace_id = $2");
    let row = sqlx::query(&sql)
        .bind(control_id)
        .bind(workspace_id)
        .fetch_optional(&mut *conn)
        .await?;
    row.as_ref()
        .map(decode_control)
        .transpose()
        .map_err(Into::into)
}

/// Every `dispatched` control this host still has to act on, oldest first
/// (Swift `WorkHostRoutes.pendingControls` :281-322).
///
/// This is the **only** way a daemon learns what to run: the dispatch broadcast
/// is a courtesy for the room, not a delivery guarantee, and a host that was
/// asleep when the outbox drained would otherwise never hear about the spawn a
/// person approved. The ledger, not the relay, is what the host reconciles
/// against — the same reason `work.control.acked` exists as a fact in the table
/// before it exists as an envelope.
///
/// The `JOIN work_host … revoked_at IS NULL` is Swift's and it is not redundant
/// with the authenticator: authentication proves the *caller* is unrevoked at
/// the moment it asks, and this join proves the **target** of each control still
/// is. They are the same host here, and keeping the join means a revoked host
/// polling with a signature minted before the revoke reads an empty list rather
/// than its old backlog (ADR-0125 D8 — revoke stops consumption immediately).
///
/// `LIMIT 100` is Swift's bound. A host with more than 100 pending controls has
/// a bigger problem than pagination, and an unbounded read here would let one
/// stuck daemon pull an arbitrary slice of the ledger into memory per poll.
pub async fn pending_controls_for_host_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    host_id: Uuid,
) -> Result<Vec<WorkControlRow>, T3Error> {
    // Swift writes the host predicate as a JOIN; here it is an `EXISTS` for a
    // mechanical reason — `work_control` and `work_host` share `id`,
    // `workspace_id`, `created_at` and `updated_at`, so a join would make every
    // name in `CONTROL_COLUMNS` ambiguous and force a second, alias-qualified
    // copy of that list. One column list is worth more than one join keyword;
    // the host row is reached by primary key either way, so the rows are the
    // same rows.
    let sql = format!(
        "SELECT {CONTROL_COLUMNS} \
           FROM work_control \
          WHERE workspace_id = $1 \
            AND target_host_id = $2 \
            AND status = '{STATUS_DISPATCHED}' \
            AND EXISTS ( \
              SELECT 1 FROM work_host h \
               WHERE h.id = work_control.target_host_id \
                 AND h.workspace_id = work_control.workspace_id \
                 AND h.revoked_at IS NULL \
            ) \
          ORDER BY created_at, id \
          LIMIT 100"
    );
    let rows = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(host_id)
        .fetch_all(&mut *conn)
        .await?;
    rows.iter()
        .map(decode_control)
        .collect::<Result<Vec<_>, _>>()
        .map_err(Into::into)
}

/// Lock one control for a state transition (Swift `lockControl` :1173-1190).
pub async fn lock_work_control_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    control_id: Uuid,
) -> Result<Option<WorkControlRow>, T3Error> {
    let sql = format!(
        "SELECT {CONTROL_COLUMNS} FROM work_control \
          WHERE id = $1 AND workspace_id = $2 FOR UPDATE"
    );
    let row = sqlx::query(&sql)
        .bind(control_id)
        .bind(workspace_id)
        .fetch_optional(&mut *conn)
        .await?;
    row.as_ref()
        .map(decode_control)
        .transpose()
        .map_err(Into::into)
}

/// Bind the approval card that gates a pending spawn (Swift :746-753).
pub async fn bind_control_approval_message_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    control_id: Uuid,
    message_id: Uuid,
) -> Result<Option<WorkControlRow>, T3Error> {
    let sql = format!(
        "UPDATE work_control \
            SET approval_message_id = $3, updated_at = clock_timestamp() \
          WHERE id = $1 AND workspace_id = $2 \
        RETURNING {CONTROL_COLUMNS}"
    );
    let row = sqlx::query(&sql)
        .bind(control_id)
        .bind(workspace_id)
        .bind(message_id)
        .fetch_optional(&mut *conn)
        .await?;
    row.as_ref()
        .map(decode_control)
        .transpose()
        .map_err(Into::into)
}

/// The human's verdict, applied to the control the decided approval owns
/// (Swift `applySpawnApprovalDecision` :489-533).
///
/// The `approval` join is the security property, not a convenience: a control
/// only moves when the approval being decided is **the** approval bound to it,
/// so deciding an unrelated approval cannot dispatch a spawn nobody looked at.
/// A `None` return is the caller's 409.
pub async fn apply_spawn_approval_decision_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    approval_id: Uuid,
    control_id: Uuid,
    approved: bool,
) -> Result<Option<WorkControlRow>, T3Error> {
    // A scalar subquery rather than a `FROM approval` join, for one reason: the
    // join form makes every returned column need a `wc.` prefix, and a
    // prefixed copy of `CONTROL_COLUMNS` is a second column list that can drift
    // from the first. The predicate is identical — and it still fails closed,
    // because an approval with no `request_message_id` yields NULL and
    // `approval_message_id = NULL` is never true.
    let sql = format!(
        "UPDATE work_control \
            SET status = $4, updated_at = clock_timestamp() \
          WHERE id = $1 \
            AND workspace_id = $2 \
            AND status = '{STATUS_PENDING_APPROVAL}' \
            AND approval_message_id = ( \
                  SELECT request_message_id FROM approval \
                   WHERE id = $3 AND workspace_id = $2 \
                ) \
        RETURNING {CONTROL_COLUMNS}"
    );
    let row = sqlx::query(&sql)
        .bind(control_id)
        .bind(workspace_id)
        .bind(approval_id)
        .bind(if approved {
            STATUS_APPROVED
        } else {
            STATUS_DENIED
        })
        .fetch_optional(&mut *conn)
        .await?;
    row.as_ref()
        .map(decode_control)
        .transpose()
        .map_err(Into::into)
}

/// `approved` → `dispatched` (Swift `enqueueDispatch` :841-856). The caller puts
/// the `work.control.dispatched` envelope on the outbox in the same transaction.
pub async fn mark_control_dispatched_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    control_id: Uuid,
) -> Result<Option<WorkControlRow>, T3Error> {
    transition_control(
        conn,
        workspace_id,
        control_id,
        STATUS_APPROVED,
        STATUS_DISPATCHED,
    )
    .await
}

/// `approved` → `failed` for a host that was revoked between approval and
/// dispatch (Swift `failDispatchForRevokedHost` :871-910).
pub async fn fail_approved_control_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    control_id: Uuid,
) -> Result<Option<WorkControlRow>, T3Error> {
    transition_control(
        conn,
        workspace_id,
        control_id,
        STATUS_APPROVED,
        STATUS_FAILED,
    )
    .await
}

async fn transition_control(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    control_id: Uuid,
    from: &str,
    to: &str,
) -> Result<Option<WorkControlRow>, T3Error> {
    let sql = format!(
        "UPDATE work_control \
            SET status = $4, updated_at = clock_timestamp() \
          WHERE id = $1 AND workspace_id = $2 AND status = $3 \
        RETURNING {CONTROL_COLUMNS}"
    );
    let row = sqlx::query(&sql)
        .bind(control_id)
        .bind(workspace_id)
        .bind(from)
        .bind(to)
        .fetch_optional(&mut *conn)
        .await?;
    row.as_ref()
        .map(decode_control)
        .transpose()
        .map_err(Into::into)
}

/// `dispatched` → `acked`/`failed`, binding the session a successful spawn
/// produced (Swift `acknowledge` :318-335).
pub async fn settle_control_ack_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    control_id: Uuid,
    ok: bool,
    session_id: Option<Uuid>,
) -> Result<Option<WorkControlRow>, T3Error> {
    let sql = format!(
        "UPDATE work_control \
            SET status = $3, \
                session_id = COALESCE($4, session_id), \
                updated_at = clock_timestamp() \
          WHERE id = $1 AND workspace_id = $2 AND status = '{STATUS_DISPATCHED}' \
        RETURNING {CONTROL_COLUMNS}"
    );
    let row = sqlx::query(&sql)
        .bind(control_id)
        .bind(workspace_id)
        .bind(if ok { STATUS_ACKED } else { STATUS_FAILED })
        .bind(session_id)
        .fetch_optional(&mut *conn)
        .await?;
    row.as_ref()
        .map(decode_control)
        .transpose()
        .map_err(Into::into)
}

/// Send an already-approved control to a different host — ADR-0125 D6-A's write
/// half.
///
/// The approval card offers a picker, so the human's answer can be "yes, but on
/// my laptop". Retargeting is confined to a control that is **still
/// `approved`**: a dispatched control has already been broadcast to its host,
/// and moving its target afterwards would leave one daemon acting on an
/// instruction the ledger says belongs to another.
pub async fn retarget_control_host_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    control_id: Uuid,
    host_id: Uuid,
) -> Result<Option<WorkControlRow>, T3Error> {
    let sql = format!(
        "UPDATE work_control \
            SET target_host_id = $3, updated_at = clock_timestamp() \
          WHERE id = $1 AND workspace_id = $2 AND status = '{STATUS_APPROVED}' \
        RETURNING {CONTROL_COLUMNS}"
    );
    let row = sqlx::query(&sql)
        .bind(control_id)
        .bind(workspace_id)
        .bind(host_id)
        .fetch_optional(&mut *conn)
        .await?;
    row.as_ref()
        .map(decode_control)
        .transpose()
        .map_err(Into::into)
}

/// Bind a control to the session it produced, for the in-process spawn path.
///
/// The REST ledger binds the session at **ack** time, because the daemon is what
/// learns the session id. The `work.session.spawn` tool has no daemon in the
/// loop for this step: it creates the session itself (same domain calls the REST
/// route makes), so the binding happens at creation — which is also what Swift's
/// `resume` does when it pre-allocates the session before writing the spawn
/// control (`WorkSessionRoutes.swift:1940-1959`).
pub async fn bind_control_session_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    control_id: Uuid,
    session_id: Uuid,
) -> Result<Option<WorkControlRow>, T3Error> {
    let sql = format!(
        "UPDATE work_control \
            SET session_id = $3, updated_at = clock_timestamp() \
          WHERE id = $1 AND workspace_id = $2 \
        RETURNING {CONTROL_COLUMNS}"
    );
    let row = sqlx::query(&sql)
        .bind(control_id)
        .bind(workspace_id)
        .bind(session_id)
        .fetch_optional(&mut *conn)
        .await?;
    row.as_ref()
        .map(decode_control)
        .transpose()
        .map_err(Into::into)
}

// ---------------------------------------------------------------------------
// lineage + host reads
// ---------------------------------------------------------------------------

/// The run a control claims to belong to, reduced to the fact the ledger needs:
/// **who the session will belong to**.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ControlRunBinding {
    /// `agent.owner_human_id` — the human the agent acts for, and therefore the
    /// member a spawned session is owned by and the member whose auto-approve
    /// setting applies.
    pub owner_human_id: Uuid,
}

/// Swift `requireRunBinding` (:912-957): the run must be this agent's, in this
/// channel, still open, and the agent must still be a member of the room.
pub async fn control_run_binding_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    run_id: Uuid,
    agent_member_id: Uuid,
) -> Result<Option<ControlRunBinding>, T3Error> {
    let owner: Option<Uuid> = sqlx::query_scalar(
        "SELECT a.owner_human_id \
           FROM agent_run r \
           JOIN member m \
             ON m.id = r.agent_member_id \
            AND m.workspace_id = r.workspace_id \
            AND m.kind = 'agent' \
            AND m.status = 'active' \
            AND m.deleted_at IS NULL \
           JOIN agent a \
             ON a.member_id = m.id \
            AND a.workspace_id = m.workspace_id \
           JOIN membership ms \
             ON ms.workspace_id = r.workspace_id \
            AND ms.channel_id = r.channel_id \
            AND ms.member_id = r.agent_member_id \
            AND ms.left_at IS NULL \
           JOIN member owner \
             ON owner.id = a.owner_human_id \
            AND owner.workspace_id = r.workspace_id \
            AND owner.kind = 'human' \
            AND owner.status = 'active' \
            AND owner.deleted_at IS NULL \
          WHERE r.id = $3 \
            AND r.workspace_id = $1 \
            AND r.channel_id = $2 \
            AND r.agent_member_id = $4 \
            AND r.status IN ('queued','running') \
          LIMIT 1",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(run_id)
    .bind(agent_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(owner.map(|owner_human_id| ControlRunBinding { owner_human_id }))
}

/// The human an agent acts for, without a run in hand.
///
/// The worker's tool path knows the agent member but not a `work_control` run
/// binding, and the session a spawn creates must still belong to the owner human
/// rather than to the agent — invariant #5 says an agent is a member, not that
/// it owns work sessions.
pub async fn agent_owner_human_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
) -> Result<Option<Uuid>, T3Error> {
    let owner: Option<Uuid> = sqlx::query_scalar(
        "SELECT a.owner_human_id \
           FROM agent a \
           JOIN member owner \
             ON owner.id = a.owner_human_id \
            AND owner.workspace_id = a.workspace_id \
            AND owner.kind = 'human' \
            AND owner.status = 'active' \
            AND owner.deleted_at IS NULL \
          WHERE a.workspace_id = $1 AND a.member_id = $2 \
          LIMIT 1",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(owner)
}

/// Registration facts about a control's target host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetWorkHost {
    pub scope: String,
    pub owner_member_id: Uuid,
    pub host_type: String,
    pub display_name: String,
    pub online: bool,
}

/// Swift `requireTargetWorkHost` (:959-988) — the row must exist, be unrevoked,
/// and be in this workspace. Missing, revoked and cross-workspace deliberately
/// collapse to the same `None` so the answer discloses nothing.
pub async fn target_work_host_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    host_id: Uuid,
) -> Result<Option<TargetWorkHost>, T3Error> {
    use sqlx::Row as _;
    let row = sqlx::query(
        "SELECT scope, owner_member_id, type AS host_type, display_name, \
                COALESCE(last_seen_at >= clock_timestamp() - make_interval(secs => 90), false) \
                  AS online \
           FROM work_host \
          WHERE id = $2 AND workspace_id = $1 AND revoked_at IS NULL \
          FOR SHARE",
    )
    .bind(workspace_id)
    .bind(host_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some(TargetWorkHost {
        scope: row.try_get("scope")?,
        owner_member_id: row.try_get("owner_member_id")?,
        host_type: row.try_get("host_type")?,
        display_name: row.try_get("display_name")?,
        online: row.try_get("online")?,
    }))
}

/// Swift `validateTargetHostScope` (:990-1005): a workspace-scoped host serves
/// everyone; a member-scoped host serves only its owner.
pub fn target_host_scope_allows(host: &TargetWorkHost, session_owner_member_id: Uuid) -> bool {
    match host.scope.as_str() {
        "workspace" => true,
        "member" => host.owner_member_id == session_owner_member_id,
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// resume target (#1139) — Swift `WorkSessionRoutes.requireResumeTarget`
// ---------------------------------------------------------------------------

/// Why an orphaned lineage may not be taken over onto this host.
///
/// Every variant is a **refusal of the target**, which is why they live together
/// rather than as four booleans a caller could forget to read. The status each
/// one answers with belongs to the route (see `routes::work_sessions::resume`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumeTargetRejection {
    /// No such host in this workspace, or its registration was revoked. Missing,
    /// revoked and cross-workspace collapse into one non-disclosing answer, the
    /// same way [`target_work_host_in_tx`] collapses them.
    HostUnavailable,
    /// A member-scoped host belonging to somebody else.
    OtherMemberHost,
    /// `work_tier_policy.mode = 'auto'` with `auto_target = 'cloud'`, and this
    /// host is not a cloud host.
    AutoPolicyRequiresCloud,
    /// `mode = 'auto'` naming one specific host, and this is not that host.
    OutsideAutoPolicy,
    /// The target is the host the source session died on.
    SameAsSourceHost,
}

/// Swift `requireResumeTarget` (:2518-2555) plus the `target != source`
/// comparison Swift never made — the four checks that were missing from the Rust
/// port entirely (#1139), which is why the client core's `takeoverTargets`
/// filter was until now the only place the question was asked at all.
///
/// It is asked **inside the resume transaction**, after the source session is
/// locked and before the first write, because every input can change underneath
/// a card that was drawn minutes ago: a host is revoked, a policy is narrowed,
/// an owner leaves. A client-side filter cannot fail closed here; this can.
///
/// ## Why `target != source` is here even though Swift has no such line
///
/// The core has excluded the dead source host from the offered targets since it
/// was written (`workSessionResumeTargets`, `workSessionModel.ts:679`), so the
/// only caller that can reach this case is one that bypassed the picker. Letting
/// it through would settle the source's ledger as `orphaned` and immediately
/// re-open a successor on the same host that just lost the session — a
/// transition that reads as a handoff in the audit trail and is not one. The
/// server refusing it is what makes the client's filter a convenience rather
/// than the load-bearing check.
pub async fn resume_target_rejection_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    target_host_id: Uuid,
    source_host_id: Uuid,
    policy_mode: &str,
    policy_auto_target: Option<&str>,
) -> Result<Option<ResumeTargetRejection>, T3Error> {
    let Some(host) = target_work_host_in_tx(conn, workspace_id, target_host_id).await? else {
        return Ok(Some(ResumeTargetRejection::HostUnavailable));
    };
    if !target_host_scope_allows(&host, member_id) {
        return Ok(Some(ResumeTargetRejection::OtherMemberHost));
    }
    if policy_mode == "auto" {
        if let Some(auto_target) = policy_auto_target {
            if auto_target == "cloud" {
                if host_tier(&host.host_type) != "cloud" {
                    return Ok(Some(ResumeTargetRejection::AutoPolicyRequiresCloud));
                }
            } else if Uuid::parse_str(auto_target) != Ok(target_host_id) {
                return Ok(Some(ResumeTargetRejection::OutsideAutoPolicy));
            }
        }
    }
    if target_host_id == source_host_id {
        return Ok(Some(ResumeTargetRejection::SameAsSourceHost));
    }
    Ok(None)
}

/// Is the host still registered and unrevoked? (Swift `enqueueDispatch`'s
/// `FOR SHARE` liveness probe, :821-839.)
pub async fn work_host_is_active_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    host_id: Uuid,
) -> Result<bool, T3Error> {
    let found: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM work_host \
          WHERE id = $2 AND workspace_id = $1 AND revoked_at IS NULL \
          FOR SHARE",
    )
    .bind(workspace_id)
    .bind(host_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(found.is_some())
}

/// The registered owner of an unrevoked host (Swift `activeHostOwner`
/// :1007-1025) — who may acknowledge its controls.
pub async fn active_host_owner_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    host_id: Uuid,
) -> Result<Option<Uuid>, T3Error> {
    let owner: Option<Uuid> = sqlx::query_scalar(
        "SELECT owner_member_id FROM work_host \
          WHERE id = $2 AND workspace_id = $1 AND revoked_at IS NULL \
          FOR SHARE",
    )
    .bind(workspace_id)
    .bind(host_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(owner)
}

/// Swift `requireSessionControlLineage` (:1027-1064): an `input`/`read`/`kill`
/// may only address a session whose **own** spawn control this requester got
/// acked on this host. Returns the session status so the caller can demand
/// `running` for input/kill.
pub async fn session_control_lineage_status_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    session_id: Uuid,
    target_host_id: Uuid,
    requester_member_id: Uuid,
) -> Result<Option<String>, T3Error> {
    let status: Option<String> = sqlx::query_scalar(
        "SELECT ws.status \
           FROM work_session ws \
           JOIN work_control root \
             ON root.workspace_id = ws.workspace_id \
            AND root.channel_id = ws.channel_id \
            AND root.session_id = ws.id \
            AND root.kind = 'spawn' \
            AND root.status = 'acked' \
          WHERE ws.id = $3 \
            AND ws.workspace_id = $1 \
            AND ws.channel_id = $2 \
            AND ws.host_id = $4 \
            AND root.target_host_id = $4 \
            AND root.requester_member_id = $5 \
          ORDER BY root.created_at ASC \
          LIMIT 1",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(session_id)
    .bind(target_host_id)
    .bind(requester_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(status)
}

/// Swift `requireSpawnAckSession` (:1066-1107): a successful spawn ack must bind
/// a **running** session on the same channel and host, owned by the requesting
/// agent's human owner (or, for a human-requested resume, by the requester).
pub async fn spawn_ack_session_matches_in_tx(
    conn: &mut PgConnection,
    control: &WorkControlRow,
    session_id: Uuid,
) -> Result<bool, T3Error> {
    let found: Option<i32> = sqlx::query_scalar(
        "SELECT 1 \
           FROM work_session ws \
           JOIN member requester \
             ON requester.id = $5 \
            AND requester.workspace_id = ws.workspace_id \
            AND requester.kind IN ('agent', 'human') \
            AND requester.status = 'active' \
            AND requester.deleted_at IS NULL \
           LEFT JOIN agent a \
             ON a.member_id = requester.id \
            AND a.workspace_id = requester.workspace_id \
          WHERE ws.id = $3 \
            AND ws.workspace_id = $1 \
            AND ws.channel_id = $2 \
            AND ws.host_id = $4 \
            AND ws.status = 'running' \
            AND ($6::uuid IS NULL OR ws.id = $6::uuid) \
            AND ( \
              (requester.kind = 'agent' AND ws.member_id = a.owner_human_id) \
              OR ( \
                requester.kind = 'human' \
                AND ws.member_id = requester.id \
                AND ws.resumed_from_session_id IS NOT NULL \
              ) \
            ) \
          LIMIT 1",
    )
    .bind(control.workspace_id)
    .bind(control.channel_id)
    .bind(session_id)
    .bind(control.target_host_id)
    .bind(control.requester_member_id)
    .bind(control.session_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(found.is_some())
}

// ---------------------------------------------------------------------------
// auto-approve (ADR-0114 D5)
// ---------------------------------------------------------------------------

/// Swift `isAutoApproved` (:1109-1133).
///
/// The `work_tool_profile` join is the half that is easy to drop and expensive
/// to lose: a tool an operator has since **disabled** must not stay
/// auto-approved because a member ticked it last month. Turning the tool off has
/// to turn its automation off with it, or "disabled" means nothing.
pub async fn spawn_is_auto_approved_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    owner_human_id: Uuid,
    tool: &str,
) -> Result<bool, T3Error> {
    let found: Option<i32> = sqlx::query_scalar(
        "SELECT 1 \
           FROM work_auto_approve waa \
           JOIN work_tool_profile wtp \
             ON wtp.workspace_id = waa.workspace_id \
            AND wtp.tool_key = waa.tool \
            AND wtp.enabled \
          WHERE waa.workspace_id = $1 \
            AND waa.host_owner_member_id = $2 \
            AND waa.tool = $3 \
          LIMIT 1",
    )
    .bind(workspace_id)
    .bind(owner_human_id)
    .bind(tool)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(found.is_some())
}

/// Swift `listAutoApprovals` (:369-405) — the caller's own enabled tools, sorted.
pub async fn list_auto_approvals_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    owner_member_id: Uuid,
) -> Result<Vec<String>, T3Error> {
    let tools: Vec<String> = sqlx::query_scalar(
        "SELECT waa.tool \
           FROM work_auto_approve waa \
           JOIN work_tool_profile wtp \
             ON wtp.workspace_id = waa.workspace_id \
            AND wtp.tool_key = waa.tool \
            AND wtp.enabled \
          WHERE waa.workspace_id = $1 \
            AND waa.host_owner_member_id = $2 \
          ORDER BY waa.tool ASC",
    )
    .bind(workspace_id)
    .bind(owner_member_id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(tools)
}

/// Turn one tool's spawn auto-approval on. `false` = the row already existed, so
/// nothing changed and the caller writes no audit row (Swift :437-459).
pub async fn enable_auto_approve_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    owner_member_id: Uuid,
    tool: &str,
) -> Result<bool, T3Error> {
    let changed: Option<String> = sqlx::query_scalar(
        "INSERT INTO work_auto_approve (workspace_id, host_owner_member_id, tool) \
         VALUES ($1, $2, $3) \
         ON CONFLICT DO NOTHING \
         RETURNING tool",
    )
    .bind(workspace_id)
    .bind(owner_member_id)
    .bind(tool)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(changed.is_some())
}

/// Turn it off. `false` = there was nothing to remove.
pub async fn disable_auto_approve_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    owner_member_id: Uuid,
    tool: &str,
) -> Result<bool, T3Error> {
    let changed: Option<String> = sqlx::query_scalar(
        "DELETE FROM work_auto_approve \
          WHERE workspace_id = $1 AND host_owner_member_id = $2 AND tool = $3 \
        RETURNING tool",
    )
    .bind(workspace_id)
    .bind(owner_member_id)
    .bind(tool)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(changed.is_some())
}

// ---------------------------------------------------------------------------
// ADR-0125 D6-A — the host picker's raw material
// ---------------------------------------------------------------------------

/// One row of the approval card's host picker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnHostCandidate {
    pub id: Uuid,
    pub display_name: String,
    pub host_type: String,
    pub scope: String,
    pub owner_member_id: Uuid,
    pub online: bool,
    /// `local` | `remote` | `cloud` — [`host_tier`].
    pub tier: &'static str,
    /// May a human actually choose this one right now?
    pub selectable: bool,
    /// Why not, when `selectable` is false. `None` on a selectable candidate.
    pub unavailable_reason: Option<&'static str>,
}

impl SpawnHostCandidate {
    /// The candidate as the approval payload and card props carry it.
    ///
    /// snake_case inside, like every other key in `approval.payload` and
    /// `message.props`. The DTO layer's camelCase rule governs response bodies;
    /// these two columns are jsonb whose neighbours (`tool_call`, `call_id`,
    /// `approval_reason`) are all snake_case, and mixing the two conventions in
    /// one object is how a client ends up reading `hostId` on one card and
    /// `host_id` on the next.
    pub fn to_json(&self) -> Value {
        json!({
            "host_id": self.id.to_string(),
            "display_name": self.display_name,
            "host_type": self.host_type,
            "tier": self.tier,
            "scope": self.scope,
            "online": self.online,
            "selectable": self.selectable,
            "unavailable_reason": self.unavailable_reason,
        })
    }
}

/// Every host in the workspace this session owner could be shown, judged.
///
/// The **selectable** predicate is `workSessionResumeTargets`' filter minus its
/// source-host exclusion (a spawn has no source): unrevoked, online, and
/// workspace-scoped or owned by `session_owner_member_id` — plus the ADR-0136
/// T3 reservation ([`T3_SPAWN_ENABLED`]).
///
/// Ordering is display name then id — deterministic, so the same workspace
/// always produces the same card. The **presentation** order is the client's:
/// `workSessionResumeTargets` sorts under the Korean collation
/// (`localeCompare(…, "ko")`), and asking Postgres for `COLLATE "ko-KR-x-icu"`
/// would make the card depend on whether the instance's Postgres was built with
/// ICU. What differs from the core is that unselectable hosts are **kept** and
/// labelled; see the module docs.
pub async fn spawn_host_candidates_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    session_owner_member_id: Uuid,
) -> Result<Vec<SpawnHostCandidate>, T3Error> {
    use sqlx::Row as _;
    let rows = sqlx::query(
        "SELECT id, display_name, type AS host_type, scope, owner_member_id, \
                revoked_at IS NOT NULL AS revoked, \
                (revoked_at IS NULL \
                 AND COALESCE(last_seen_at >= clock_timestamp() \
                                - make_interval(secs => 90), false)) AS online \
           FROM work_host \
          WHERE workspace_id = $1 \
            AND revoked_at IS NULL \
            AND (scope = 'workspace' OR owner_member_id = $2) \
          ORDER BY display_name, id",
    )
    .bind(workspace_id)
    .bind(session_owner_member_id)
    .fetch_all(&mut *conn)
    .await?;

    let mut candidates = Vec::with_capacity(rows.len());
    for row in &rows {
        let host_type: String = row.try_get("host_type")?;
        let online: bool = row.try_get("online")?;
        let revoked: bool = row.try_get("revoked")?;
        let tier = host_tier(&host_type);
        let unavailable_reason = if revoked {
            Some(UNAVAILABLE_REVOKED)
        } else if tier == "cloud" && !T3_SPAWN_ENABLED {
            Some(UNAVAILABLE_T3_DISABLED)
        } else if !online {
            Some(UNAVAILABLE_OFFLINE)
        } else {
            None
        };
        candidates.push(SpawnHostCandidate {
            id: row.try_get("id")?,
            display_name: row.try_get("display_name")?,
            host_type,
            scope: row.try_get("scope")?,
            owner_member_id: row.try_get("owner_member_id")?,
            online,
            tier,
            selectable: unavailable_reason.is_none(),
            unavailable_reason,
        });
    }
    Ok(candidates)
}

/// ADR-0125 D6-A's default, both halves: **마지막 사용** when that host is still
/// offerable, otherwise **로컬 온라인 우선**, then remote, and never cloud while
/// [`T3_SPAWN_ENABLED`] is false.
///
/// The order is the ADR's and it is the whole point of migration 061: a person
/// who moved to the team VPS last week should not be handed their laptop again
/// every morning because the laptop happens to sort first by tier. The tier rule
/// stays underneath as the answer for someone who has never chosen — a new
/// member's first card cannot read a preference nobody expressed.
///
/// `last_used` is filtered through the **same candidate list the card shows**,
/// never trusted on its own: a host that was revoked, went offline, or changed
/// hands since is not a default, it is a greyed row. That filter is why this is
/// a pure function taking the already-judged candidates rather than a second
/// query — the default and the picker cannot disagree about what is offerable.
pub fn default_spawn_host(
    candidates: &[SpawnHostCandidate],
    last_used: Option<Uuid>,
) -> Option<Uuid> {
    if let Some(last_used) = last_used {
        if candidates
            .iter()
            .any(|candidate| candidate.selectable && candidate.id == last_used)
        {
            return Some(last_used);
        }
    }
    candidates
        .iter()
        .filter(|candidate| candidate.selectable)
        .min_by_key(|candidate| match candidate.tier {
            "local" => 0,
            "remote" => 1,
            _ => 2,
        })
        .map(|candidate| candidate.id)
}

/// The host this member last actually sent work to, or `None` for someone who
/// has never chosen (migration 061).
///
/// Deliberately **not** derived from `work_session`: see the migration's header.
/// The answer is one row by primary key, so the picker pays one index lookup for
/// the half of D6-A that makes the card feel like it remembers.
pub async fn last_used_spawn_host_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<Option<Uuid>, T3Error> {
    let host_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT host_id FROM work_host_last_used \
          WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(workspace_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(host_id)
}

/// Record that this member's work went to this host (migration 061).
///
/// Called from the three places a human's host choice actually takes effect —
/// the auto-approved dispatch, the approval decision's dispatch, and a resume's
/// target — and from nowhere else. In particular it is **not** called when a
/// control is merely *requested*: a spawn that sits in `pending_approval` and is
/// then denied expressed the model's preference, not the person's, and letting
/// it move the default would let an agent steer tomorrow's card by asking for a
/// host it is never allowed to use.
///
/// The write is an upsert in the caller's transaction, so a dispatch that rolls
/// back never leaves a preference behind. `used_at` moves on every call because
/// "last" is the only question this table answers.
pub async fn record_host_last_used_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    host_id: Uuid,
) -> Result<(), T3Error> {
    sqlx::query(
        "INSERT INTO work_host_last_used (workspace_id, member_id, host_id) \
              VALUES ($1, $2, $3) \
         ON CONFLICT (workspace_id, member_id) \
         DO UPDATE SET host_id = EXCLUDED.host_id, used_at = clock_timestamp()",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(host_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// The `execution` object a spawn approval carries — ADR-0125 D6-A's card in
/// data form (#1114).
///
/// Built here rather than in either caller because there are **two** producers
/// of a spawn approval — the REST control ledger and the `work.session.spawn`
/// tool — and a picker whose rows are shaped differently depending on which one
/// asked is a picker the client has to special-case.
pub fn spawn_execution_object(
    tool: &str,
    label: &str,
    requested_host_id: Option<Uuid>,
    default_host_id: Option<Uuid>,
    candidates: &[SpawnHostCandidate],
) -> Value {
    json!({
        "kind": "work_session_spawn",
        "tool": tool,
        "label": label,
        "requested_host_id": requested_host_id.map(|id| id.to_string()),
        "default_host_id": default_host_id.map(|id| id.to_string()),
        "host_candidates": candidates
            .iter()
            .map(SpawnHostCandidate::to_json)
            .collect::<Vec<_>>(),
    })
}

/// Why one host cannot run this spawn, or `None` when it can.
///
/// The single-host form of [`spawn_host_candidates_in_tx`]'s predicate, and the
/// one the executor calls **inside its own transaction** — the picker's answer
/// was computed when the card was drawn and a host can be revoked, go offline,
/// or change hands in between.
pub async fn spawn_host_ineligible_reason_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    host_id: Uuid,
    session_owner_member_id: Uuid,
) -> Result<Option<&'static str>, T3Error> {
    let Some(host) = target_work_host_in_tx(conn, workspace_id, host_id).await? else {
        return Ok(Some(UNAVAILABLE_REVOKED));
    };
    if !target_host_scope_allows(&host, session_owner_member_id) {
        return Ok(Some(UNAVAILABLE_OTHER_MEMBER));
    }
    if host_tier(&host.host_type) == "cloud" && !T3_SPAWN_ENABLED {
        return Ok(Some(UNAVAILABLE_T3_DISABLED));
    }
    if !host.online {
        return Ok(Some(UNAVAILABLE_OFFLINE));
    }
    Ok(None)
}

/// The `work_control` an approval owns, or `None` when the approval is an
/// ordinary agent tool call (Swift `workControlID(from:)` :535-545).
///
/// A payload that claims `source: "work_control"` but carries no parseable id is
/// **not** treated as "no control": that shape means the binding was written
/// wrong, and answering `None` would send a spawn approval down the generic
/// resume path where nothing would ever dispatch it. The caller gets the error.
pub fn work_control_id(payload: &Value) -> Result<Option<Uuid>, &'static str> {
    if payload.get("source").and_then(Value::as_str) != Some(APPROVAL_SOURCE_WORK_CONTROL) {
        return Ok(None);
    }
    payload
        .get("work_control_id")
        .and_then(Value::as_str)
        .and_then(|raw| Uuid::parse_str(raw).ok())
        .map(Some)
        .ok_or("work control approval binding is malformed")
}

// ---------------------------------------------------------------------------
// realtime envelopes
// ---------------------------------------------------------------------------

/// The `work.control.dispatched` / `work.control.acked` envelope (Swift
/// `dispatchPayload` :615-630, `ackPayload` :632-656).
///
/// The `idempotency_key` is per **event and control**, not per control: a
/// dispatch and its ack are two facts about one row, and collapsing them onto
/// one key would make the relay stale-skip whichever arrived second — the
/// daemon would be told to start a tool and the room would never be told it did.
pub fn control_event_payload(
    cent_channel: &str,
    event_type: &str,
    control: &WorkControlRow,
    ok: Option<bool>,
    error_label: Option<&str>,
) -> Value {
    let mut body = Map::new();
    body.insert("control_id".into(), json!(control.id.to_string()));
    body.insert("channel_id".into(), json!(control.channel_id.to_string()));
    body.insert(
        "requester_member_id".into(),
        json!(control.requester_member_id.to_string()),
    );
    body.insert(
        "target_host_id".into(),
        json!(control.target_host_id.to_string()),
    );
    body.insert(
        "session_id".into(),
        match control.session_id {
            Some(id) => json!(id.to_string()),
            None => Value::Null,
        },
    );
    body.insert("kind".into(), json!(control.kind));
    body.insert("payload".into(), control.payload.clone());
    if let Some(ok) = ok {
        body.insert("ok".into(), json!(ok));
        body.insert("status".into(), json!(control.status));
    }
    if let Some(error_label) = error_label {
        body.insert("error_label".into(), json!(error_label));
    }

    json!({
        "channel": cent_channel,
        "data": {
            "type": event_type,
            "v": 1,
            "ts": control.updated_at_ms,
            "payload": Value::Object(body),
        },
        "idempotency_key": format!("{cent_channel}:{event_type}:{}", control.id),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn control() -> WorkControlRow {
        WorkControlRow {
            id: Uuid::from_u128(1),
            workspace_id: Uuid::from_u128(2),
            channel_id: Uuid::from_u128(3),
            requester_member_id: Uuid::from_u128(4),
            target_host_id: Uuid::from_u128(5),
            session_id: None,
            kind: KIND_SPAWN.into(),
            payload: json!({"tool": "codex", "label": "run"}),
            status: STATUS_DISPATCHED.into(),
            approval_message_id: None,
            created_at_ms: 1_700_000_000_000,
            updated_at_ms: 1_700_000_001_000,
        }
    }

    /// Dispatch and ack must not collapse onto one relay key.
    #[test]
    fn the_two_control_events_carry_different_idempotency_keys() {
        let control = control();
        let dispatched =
            control_event_payload("ch:test", "work.control.dispatched", &control, None, None);
        let acked =
            control_event_payload("ch:test", "work.control.acked", &control, Some(true), None);
        assert_ne!(dispatched["idempotency_key"], acked["idempotency_key"]);
        assert_eq!(dispatched["data"]["type"], "work.control.dispatched");
        assert_eq!(dispatched["data"]["ts"], 1_700_000_001_000i64);
        assert!(
            dispatched["data"]["payload"].get("ok").is_none(),
            "a dispatch has no outcome yet"
        );
        assert_eq!(acked["data"]["payload"]["ok"], json!(true));
        assert_eq!(acked["data"]["payload"]["status"], STATUS_DISPATCHED);

        let failed = control_event_payload(
            "ch:test",
            "work.control.acked",
            &control,
            Some(false),
            Some(UNAVAILABLE_REVOKED),
        );
        assert_eq!(
            failed["data"]["payload"]["error_label"],
            UNAVAILABLE_REVOKED
        );
    }

    /// The envelope carries the control, never anything host-local — the
    /// payload it echoes is the one `work_control_payload_ck` already closed.
    #[test]
    fn the_control_envelope_echoes_only_the_closed_payload() {
        let event =
            control_event_payload("ch:test", "work.control.dispatched", &control(), None, None);
        let body = event["data"]["payload"].as_object().expect("object");
        let mut keys: Vec<&str> = body.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "channel_id",
                "control_id",
                "kind",
                "payload",
                "requester_member_id",
                "session_id",
                "target_host_id"
            ]
        );
        assert_eq!(body["payload"], json!({"tool": "codex", "label": "run"}));
    }

    fn candidate(
        id: u128,
        name: &str,
        host_type: &str,
        online: bool,
        selectable: bool,
    ) -> SpawnHostCandidate {
        SpawnHostCandidate {
            id: Uuid::from_u128(id),
            display_name: name.to_string(),
            host_type: host_type.to_string(),
            scope: "member".into(),
            owner_member_id: Uuid::from_u128(99),
            online,
            tier: host_tier(host_type),
            selectable,
            unavailable_reason: if selectable {
                None
            } else {
                Some(UNAVAILABLE_OFFLINE)
            },
        }
    }

    /// The closed payload shape, in both directions. Reverting any arm lets a
    /// caller store a field `work_control_payload_ck` will then reject with a
    /// 500 — or worse, a field the constraint tolerates and nobody reads.
    #[test]
    fn the_payload_is_closed_per_kind() {
        let spawn = validated_payload(&json!({"tool": " Codex ", "label": "  run  "}), KIND_SPAWN)
            .expect("spawn");
        assert_eq!(spawn, json!({"tool": "codex", "label": "run"}));
        assert!(validated_payload(&json!({"tool": "codex"}), KIND_SPAWN).is_err());
        assert!(
            validated_payload(
                &json!({"tool": "codex", "label": "x", "cwd": "/etc"}),
                KIND_SPAWN
            )
            .is_err(),
            "a host-local path is exactly the field this boundary exists to refuse"
        );
        assert!(validated_payload(&json!({"tool": "codex", "label": ""}), KIND_SPAWN).is_err());

        assert_eq!(
            validated_payload(&json!({"text": "hi"}), KIND_INPUT).expect("input"),
            json!({"text": "hi"})
        );
        assert!(validated_payload(&json!({"text": ""}), KIND_INPUT).is_err());
        assert!(validated_payload(&json!({"text": "hi", "env": {}}), KIND_INPUT).is_err());

        assert_eq!(
            validated_payload(&json!({}), KIND_READ).expect("read"),
            json!({})
        );
        assert_eq!(
            validated_payload(&json!({"tail_lines": 40}), KIND_READ).expect("read"),
            json!({"tail_lines": 40})
        );
        assert!(validated_payload(&json!({"tail_lines": 0}), KIND_READ).is_err());
        assert!(validated_payload(&json!({"tail_lines": 10_000}), KIND_READ).is_err());

        assert_eq!(
            validated_payload(&json!({}), KIND_KILL).expect("kill"),
            json!({})
        );
        assert!(validated_payload(&json!({"signal": "TERM"}), KIND_KILL).is_err());
        assert!(validated_payload(&json!({}), "restart").is_err());
        assert!(validated_payload(&json!("nope"), KIND_SPAWN).is_err());
    }

    #[test]
    fn a_spawn_opens_without_a_session_and_nothing_else_does() {
        assert!(validated_session_shape(KIND_SPAWN, None).is_ok());
        assert!(validated_session_shape(KIND_SPAWN, Some(Uuid::nil())).is_err());
        assert!(validated_session_shape(KIND_INPUT, Some(Uuid::nil())).is_ok());
        assert!(validated_session_shape(KIND_KILL, None).is_err());
    }

    #[test]
    fn scope_decides_whose_host_a_control_may_address() {
        let owner = Uuid::from_u128(1);
        let other = Uuid::from_u128(2);
        let mut host = TargetWorkHost {
            scope: "member".into(),
            owner_member_id: owner,
            host_type: "app".into(),
            display_name: "내 맥".into(),
            online: true,
        };
        assert!(target_host_scope_allows(&host, owner));
        assert!(!target_host_scope_allows(&host, other));
        host.scope = "workspace".into();
        assert!(target_host_scope_allows(&host, other));
        host.scope = "everyone".into();
        assert!(
            !target_host_scope_allows(&host, owner),
            "an unknown scope fails closed rather than defaulting to permissive"
        );
    }

    /// ADR-0125 D6-A's default, and the ADR-0136 reservation that shapes it.
    #[test]
    fn the_default_host_is_the_online_local_one_and_never_the_cloud_slot() {
        let hosts = vec![
            candidate(1, "팀 VPS", "workd", true, true),
            candidate(2, "내 맥", "app", true, true),
            candidate(3, "낡은 맥", "app", false, false),
        ];
        assert_eq!(default_spawn_host(&hosts, None), Some(Uuid::from_u128(2)));

        // Local offline → the remote host takes the default rather than a
        // disabled row.
        let hosts = vec![
            candidate(1, "팀 VPS", "workd", true, true),
            candidate(2, "내 맥", "app", false, false),
        ];
        assert_eq!(default_spawn_host(&hosts, None), Some(Uuid::from_u128(1)));

        // The T3 slot is visible and never chosen while the constant is false.
        let mut cloud = candidate(4, "momo Cloud", "cloud", true, false);
        cloud.unavailable_reason = Some(UNAVAILABLE_T3_DISABLED);
        const { assert!(!T3_SPAWN_ENABLED, "ADR-0136: T3 is off by default") };
        assert_eq!(default_spawn_host(&[cloud], None), None);
        assert_eq!(default_spawn_host(&[], None), None);
    }

    /// D6-A's second clause (migration 061): the remembered host wins over the
    /// tier order — but only while it is still a host the card would offer.
    #[test]
    fn the_last_used_host_outranks_the_tier_order_until_it_stops_being_offerable() {
        let laptop = Uuid::from_u128(2);
        let vps = Uuid::from_u128(1);
        let hosts = vec![
            candidate(1, "팀 VPS", "workd", true, true),
            candidate(2, "내 맥", "app", true, true),
        ];
        // No preference yet → tier order (the local host).
        assert_eq!(default_spawn_host(&hosts, None), Some(laptop));
        // Preference recorded → it wins, even though it sorts second by tier.
        assert_eq!(default_spawn_host(&hosts, Some(vps)), Some(vps));
        // …and stating the obvious the other way: a preference for the host the
        // tier rule would have picked anyway changes nothing.
        assert_eq!(default_spawn_host(&hosts, Some(laptop)), Some(laptop));

        // The remembered host went offline: the default falls back to the tier
        // rule rather than pre-selecting a greyed row.
        let hosts = vec![
            candidate(1, "팀 VPS", "workd", true, true),
            candidate(2, "내 맥", "app", false, false),
        ];
        assert_eq!(default_spawn_host(&hosts, Some(laptop)), Some(vps));
        // A remembered host that is not in this workspace's list at all (revoked
        // and filtered out, or someone else's) is likewise not a default.
        assert_eq!(
            default_spawn_host(&hosts, Some(Uuid::from_u128(99))),
            Some(vps)
        );
        // And a preference cannot conjure a default when nothing is selectable.
        assert_eq!(
            default_spawn_host(&[candidate(2, "내 맥", "app", false, false)], Some(laptop)),
            None
        );
    }

    #[test]
    fn the_tier_vocabulary_is_the_pickers_three_slots() {
        assert_eq!(host_tier("app"), "local");
        assert_eq!(host_tier("workd"), "remote");
        assert_eq!(host_tier("cloud"), "cloud");
        assert_eq!(host_tier("laptop"), "unknown");
    }

    /// The card is broadcast to the whole channel, so its rows carry identity
    /// and liveness — never a key, an endpoint, or a path.
    #[test]
    fn a_candidate_row_carries_no_host_local_material() {
        let json = candidate(1, "내 맥", "app", true, true).to_json();
        let mut keys: Vec<&str> = json
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "display_name",
                "host_id",
                "host_type",
                "online",
                "scope",
                "selectable",
                "tier",
                "unavailable_reason"
            ]
        );
    }

    /// The binding is either absent or well formed — never "absent because it
    /// was written wrong".
    #[test]
    fn a_malformed_work_control_binding_is_an_error_not_an_absence() {
        assert_eq!(work_control_id(&json!({})).unwrap(), None);
        assert_eq!(
            work_control_id(&json!({"source": "hermes_gateway"})).unwrap(),
            None
        );
        let id = Uuid::from_u128(9);
        assert_eq!(
            work_control_id(&json!({
                "source": APPROVAL_SOURCE_WORK_CONTROL,
                "work_control_id": id.to_string(),
            }))
            .unwrap(),
            Some(id)
        );
        assert!(work_control_id(&json!({"source": APPROVAL_SOURCE_WORK_CONTROL})).is_err());
        assert!(work_control_id(&json!({
            "source": APPROVAL_SOURCE_WORK_CONTROL,
            "work_control_id": "not-a-uuid",
        }))
        .is_err());
    }

    #[test]
    fn error_labels_are_bounded() {
        assert_eq!(validated_error_label(None).unwrap(), None);
        assert_eq!(
            validated_error_label(Some("  spawn failed ")).unwrap(),
            Some("spawn failed".to_string())
        );
        assert!(validated_error_label(Some("   ")).is_err());
        assert!(validated_error_label(Some(&"x".repeat(121))).is_err());
    }
}
