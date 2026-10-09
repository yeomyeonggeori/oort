//! Subscription-agent transition (#3567 T2, ADR-0198 증보 1 D2 변경·D7).
//!
//! Two operator-run transitions, each **dry-run first** and **idempotent**:
//!
//! * [`Transition::Convert`] — the owner's own `owner_only` subscription agent
//!   (`kwak-claude`) becomes a D7 personal agent **in place**: same member id,
//!   same handle, every past message keeps its author. Its hosted connection is
//!   closed (`expired`, the pairing value is nulled), every live credential is
//!   revoked, the device slot is released and `config.execution_mode` leaves
//!   `hosted_dial_in`; only then does P2's [`crate::mark_personal_agent_in_tx`]
//!   mark the row (it refuses while a connection or credential remains — this
//!   is the "revoke before conversion" step P2 left to #3567).
//! * [`Transition::Retire`] — a hosted entry named after a harness with no VM
//!   agent behind it (oort-team `@claude-code`: `workspace` scope, no
//!   `subscription_harness`, never connected) is switched off:
//!   `member.status = 'suspended'` (never `deleted`, so past messages keep
//!   their author), `agent.subscription_retired_at` (the 「이전 구독 에이전트」
//!   marker), the connection `expired`, credentials revoked.
//!
//! ## What this never does
//!
//! * delete a row (member, agent, message, membership, audit, connection);
//! * run as, or need, a `BYPASSRLS` role: every statement runs in a tenant
//!   transaction ([`momo_db::tenant::with_tenant_tx`]) as the caller's role;
//! * touch a connection that ever carried a credential (`active`,
//!   `cleanup_pending`, or one that was confirmed). Those need the provider-side
//!   cleanup manifest of ADR-0162 HAP-E6 (the admin disconnect), which an
//!   operator script must not fake: the verdict is [`Verdict::Refused`] and
//!   nothing is written;
//! * write anything in a dry run. The dry run opens the transaction
//!   `transaction_read_only`, so the database — not this code — refuses a write,
//!   and it takes no row lock.
//!
//! ## Idempotency
//!
//! A second run on an already-converted (or already-retired) agent reports
//! [`Verdict::AlreadyDone`], writes nothing and adds **no** second audit row.
//! One run is one transaction: either every change and its single audit row
//! (`subscription_agent.converted` / `subscription_agent.retired`) commit, or
//! none does.

use momo_db::audit::{write_audit, AuditEntry};
use momo_db::tenant::with_tenant_tx;
use momo_db::{DbError, PgConnection, PgPool};
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::personal::{mark_personal_agent_in_tx, MarkOutcome};
use crate::subscription::{SubscriptionHarness, INVOCATION_SCOPE_OWNER_ONLY};

/// `audit_log.action` of a conversion.
pub const AUDIT_CONVERTED: &str = "subscription_agent.converted";
/// `audit_log.action` of a retirement.
pub const AUDIT_RETIRED: &str = "subscription_agent.retired";
/// The tool's name in the audit detail.
pub const TOOL_NAME: &str = "momo-subscription-migrate";
/// Longest accepted `--note` (an owner-approval citation, not prose).
pub const MAX_NOTE_CHARS: usize = 500;

/// `config.execution_mode` of a hosted dial-in sentinel agent (migration 069).
const EXECUTION_MODE_HOSTED: &str = "hosted_dial_in";
/// What a converted agent's `config.execution_mode` becomes (P2 creates the same).
const EXECUTION_MODE_MEMBER_HOST: &str = "member_host";

/// Which transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transition {
    Convert,
    Retire,
}

impl Transition {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Convert => "convert",
            Self::Retire => "retire",
        }
    }

    pub fn audit_action(self) -> &'static str {
        match self {
            Self::Convert => AUDIT_CONVERTED,
            Self::Retire => AUDIT_RETIRED,
        }
    }
}

/// One hosted connection of the agent, as the verdict needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionFact {
    pub id: Uuid,
    pub status: String,
    /// It was ever confirmed or proved, or still names an active credential:
    /// a real runtime was behind it, so provider-side cleanup is owed.
    pub ever_credentialed: bool,
    /// A doorbell registration hangs off it (cleared with the connection).
    pub has_doorbell: bool,
}

impl ConnectionFact {
    /// `pairing_pending` / `detected`: a pairing value exists but no credential
    /// was ever issued, so closing it loses nothing and needs no cleanup.
    fn closable_by_tool(&self) -> bool {
        !self.ever_credentialed && matches!(self.status.as_str(), "pairing_pending" | "detected")
    }

    /// `expired` / `disconnected`: already closed.
    fn closed(&self) -> bool {
        matches!(self.status.as_str(), "expired" | "disconnected")
    }
}

/// What the agent looks like right now (the plan's input).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Inspection {
    pub agent_member_id: Uuid,
    pub handle: String,
    pub display_name: String,
    pub member_status: String,
    pub member_deleted: bool,
    pub invocation_scope: String,
    pub harness: Option<SubscriptionHarness>,
    pub owner: Option<(Uuid, String)>,
    pub personal_agent: bool,
    pub retired: bool,
    pub uses_owner_key: bool,
    pub execution_mode: String,
    pub connections: Vec<ConnectionFact>,
    /// Credentials with `revoked_at IS NULL` that act as, or hang off a
    /// connection of, this agent.
    pub live_tokens: i64,
    /// Runs in `queued`/`running`/`awaiting_approval`/`paused`.
    pub live_runs: i64,
    /// Messages this member authored — all of them stay.
    pub messages_authored: i64,
    /// The owner already has a *different* live personal agent for this harness
    /// (the partial unique index would refuse a second one).
    pub owner_has_other_personal: bool,
}

impl Inspection {
    fn live_connection(&self) -> bool {
        self.connections.iter().any(|c| !c.closed())
    }
}

/// The verdict on an [`Inspection`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// This run would (dry-run) or did (execute) change the agent.
    Proceed,
    /// Already in the target state with nothing left to close: no write, no audit.
    AlreadyDone,
    /// Not a shape this tool may touch, or a state it must not fake. Nothing is
    /// written. `code` is stable; `reason` is for the operator.
    Refused { code: &'static str, reason: String },
}

fn refuse(code: &'static str, reason: impl Into<String>) -> Verdict {
    Verdict::Refused {
        code,
        reason: reason.into(),
    }
}

/// The pure decision. Everything the database says is already in `i`.
pub fn decide(transition: Transition, i: &Inspection) -> Verdict {
    if i.member_deleted || i.member_status == "deleted" {
        return refuse("member_deleted", "the member is deleted");
    }
    let credentialed: Vec<&ConnectionFact> = i
        .connections
        .iter()
        .filter(|c| c.ever_credentialed || matches!(c.status.as_str(), "active" | "cleanup_pending"))
        .collect();
    match transition {
        Transition::Convert => {
            if i.personal_agent {
                return if i.live_tokens == 0 && !i.live_connection() {
                    Verdict::AlreadyDone
                } else {
                    refuse(
                        "personal_agent_has_live_attachments",
                        "already a personal agent, but a connection or credential is still live",
                    )
                };
            }
            if i.retired {
                return refuse("already_retired", "this agent was retired, not converted");
            }
            if i.invocation_scope != INVOCATION_SCOPE_OWNER_ONLY
                || i.harness.is_none()
                || i.uses_owner_key
            {
                return refuse(
                    "not_a_subscription_agent",
                    "only an owner_only subscription agent (a harness, not a personal API key) converts",
                );
            }
            let Some(_owner) = &i.owner else {
                return refuse("no_owner", "the agent has no owner");
            };
            if i.member_status != "active" {
                return refuse(
                    "member_not_active",
                    format!("the member is {}; an administrator's suspension is not this tool's to undo", i.member_status),
                );
            }
            if i.owner_has_other_personal {
                return refuse(
                    "personal_agent_exists",
                    "the owner already has another personal agent for this harness (one per harness)",
                );
            }
        }
        Transition::Retire => {
            if i.retired {
                return if i.live_tokens == 0 && !i.live_connection() {
                    Verdict::AlreadyDone
                } else {
                    refuse(
                        "retired_but_credentials_remain",
                        "already retired, but a connection or credential is still live",
                    )
                };
            }
            if i.personal_agent {
                return refuse(
                    "is_personal_agent",
                    "a personal agent is switched off by its owner, not retired",
                );
            }
            if i.invocation_scope != crate::subscription::INVOCATION_SCOPE_WORKSPACE
                || i.harness.is_some()
            {
                return refuse(
                    "not_a_hosted_workspace_agent",
                    "retire only takes a workspace-scope hosted entry with no subscription harness; \
                     an owner_only subscription agent is converted instead",
                );
            }
            if i.execution_mode != EXECUTION_MODE_HOSTED {
                return refuse(
                    "not_a_hosted_dial_in_agent",
                    "retire only takes a hosted dial-in entry (config.execution_mode = hosted_dial_in)",
                );
            }
        }
    }
    if !credentialed.is_empty() {
        return refuse(
            "connection_needs_admin_disconnect",
            "a connection of this agent was credentialed (active, cleanup_pending or confirmed): \
             run the administrator disconnect and resolve its cleanup manifest first (ADR-0162 HAP-E6), then re-run",
        );
    }
    if i.live_runs > 0 {
        return refuse(
            "live_runs",
            format!("{} run(s) are still queued or running", i.live_runs),
        );
    }
    Verdict::Proceed
}

/// What an executed run changed (all zero for a dry run, all zero on a no-op).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Changes {
    pub connections_closed: i64,
    pub doorbells_cleared: i64,
    pub tokens_revoked: i64,
    pub device_slot_released: bool,
    pub member_suspended: bool,
    pub execution_mode_changed: bool,
    pub marked: bool,
    pub profile_paused: bool,
    pub audit_id: Option<Uuid>,
}

/// The whole outcome of one run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransitionReport {
    pub transition: Transition,
    /// `true` only when the run was allowed to write (`--execute`).
    pub execute: bool,
    pub inspection: Inspection,
    pub verdict: Verdict,
    pub changes: Changes,
}

impl TransitionReport {
    /// The operator-facing text (stable `key: value` lines, Korean sentences).
    pub fn render(&self) -> String {
        let i = &self.inspection;
        let mode = if self.execute { "EXECUTE" } else { "DRY-RUN (아무것도 쓰지 않았어요)" };
        let mut out = vec![
            format!("transition: {}", self.transition.as_str()),
            format!("mode: {mode}"),
            format!("agent: @{} ({})", i.handle, i.agent_member_id),
            format!("display_name: {}", i.display_name),
            format!(
                "owner: {}",
                i.owner
                    .as_ref()
                    .map(|(id, name)| format!("{name} ({id})"))
                    .unwrap_or_else(|| "-".into())
            ),
            format!(
                "shape: scope={} harness={} personal={} retired={} member_status={} execution_mode={}",
                i.invocation_scope,
                i.harness.map(|h| h.as_str()).unwrap_or("-"),
                i.personal_agent,
                i.retired,
                i.member_status,
                i.execution_mode,
            ),
            format!("messages_authored(그대로 남아요): {}", i.messages_authored),
            format!("live_tokens: {}", i.live_tokens),
            format!("live_runs: {}", i.live_runs),
        ];
        if i.connections.is_empty() {
            out.push("connections: (없어요)".into());
        }
        for c in &i.connections {
            out.push(format!(
                "connection: {} status={} credentialed={} doorbell={}",
                c.id, c.status, c.ever_credentialed, c.has_doorbell
            ));
        }
        match &self.verdict {
            Verdict::Proceed => {
                let verb = if self.execute { "적용했어요" } else { "적용할 거예요" };
                out.push(format!("verdict: PROCEED ({verb})"));
                let c = &self.changes;
                if self.execute {
                    out.push(format!(
                        "changes: connections_closed={} doorbells_cleared={} tokens_revoked={} device_slot_released={} member_suspended={} execution_mode_changed={} marked={} profile_paused={} audit_id={}",
                        c.connections_closed,
                        c.doorbells_cleared,
                        c.tokens_revoked,
                        c.device_slot_released,
                        c.member_suspended,
                        c.execution_mode_changed,
                        c.marked,
                        c.profile_paused,
                        c.audit_id.map(|id| id.to_string()).unwrap_or_else(|| "-".into()),
                    ));
                } else {
                    let closable = i.connections.iter().filter(|c| c.closable_by_tool()).count();
                    let doorbells = i
                        .connections
                        .iter()
                        .filter(|c| c.closable_by_tool() && c.has_doorbell)
                        .count();
                    out.push(format!(
                        "plan: connections_to_close={closable} doorbells_to_clear={doorbells} tokens_to_revoke={} audit={}",
                        i.live_tokens,
                        self.transition.audit_action(),
                    ));
                }
            }
            Verdict::AlreadyDone => out.push("verdict: ALREADY_DONE (바꿀 게 없어요, 감사 행도 더하지 않아요)".into()),
            Verdict::Refused { code, reason } => {
                out.push(format!("verdict: REFUSED {code}: {reason}"));
            }
        }
        out.join("\n")
    }
}

/// A note is an approval citation: non-empty, bounded, one line.
pub fn validate_note(note: &str) -> Result<&str, &'static str> {
    let trimmed = note.trim();
    if trimmed.is_empty() {
        return Err("note is required with --execute (cite the owner's approval)");
    }
    if trimmed.chars().count() > MAX_NOTE_CHARS {
        return Err("note is longer than 500 characters");
    }
    if trimmed.chars().any(char::is_control) {
        return Err("note must be one line without control characters");
    }
    Ok(trimmed)
}

fn protocol(message: &str) -> DbError {
    DbError::Sqlx(sqlx::Error::Protocol(message.to_string()))
}

/// Read the agent. With `lock`, takes the HAP-E4 lock order (connection →
/// token rows are updated later → member → agent) so a concurrent hosted tool
/// call serializes instead of interleaving. Returns `None` when no agent of
/// this workspace has the handle.
async fn inspect(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    handle: &str,
    lock: bool,
) -> Result<Option<Inspection>, DbError> {
    let id: Option<Uuid> = sqlx::query_scalar(
        "SELECT m.id FROM member m \
           JOIN agent a ON a.workspace_id = m.workspace_id AND a.member_id = m.id \
          WHERE m.workspace_id = $1 AND m.handle = $2 AND m.kind = 'agent'",
    )
    .bind(workspace_id)
    .bind(handle)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(agent_id) = id else {
        return Ok(None);
    };

    let lock_sql = if lock { " FOR UPDATE OF hc" } else { "" };
    let connection_rows = sqlx::query(&format!(
        "SELECT hc.id, hc.status::text AS status, \
                (hc.confirmed_at IS NOT NULL OR hc.proved_at IS NOT NULL \
                  OR hc.active_token_id IS NOT NULL) AS ever_credentialed, \
                EXISTS (SELECT 1 FROM hosted_agent_doorbell d \
                         WHERE d.workspace_id = hc.workspace_id AND d.connection_id = hc.id) \
                  AS has_doorbell \
           FROM hosted_agent_connection hc \
          WHERE hc.workspace_id = $1 AND hc.agent_member_id = $2 \
          ORDER BY hc.created_at, hc.id{lock_sql}"
    ))
    .bind(workspace_id)
    .bind(agent_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut connections = Vec::with_capacity(connection_rows.len());
    for row in &connection_rows {
        connections.push(ConnectionFact {
            id: row.try_get("id")?,
            status: row.try_get("status")?,
            ever_credentialed: row.try_get("ever_credentialed")?,
            has_doorbell: row.try_get("has_doorbell")?,
        });
    }

    let member_lock = if lock { " FOR UPDATE OF m, a" } else { "" };
    let row = sqlx::query(&format!(
        "SELECT m.handle, m.display_name, m.status::text AS status, \
                (m.deleted_at IS NOT NULL) AS deleted, \
                a.invocation_scope, a.subscription_harness, a.owner_human_id, \
                a.personal_agent, (a.subscription_retired_at IS NOT NULL) AS retired, \
                a.uses_owner_key, COALESCE(a.config->>'execution_mode', '') AS execution_mode, \
                (SELECT o.display_name FROM member o \
                  WHERE o.workspace_id = m.workspace_id AND o.id = a.owner_human_id) \
                  AS owner_display_name \
           FROM member m \
           JOIN agent a ON a.workspace_id = m.workspace_id AND a.member_id = m.id \
          WHERE m.workspace_id = $1 AND m.id = $2{member_lock}"
    ))
    .bind(workspace_id)
    .bind(agent_id)
    .fetch_one(&mut *conn)
    .await?;
    let owner_id: Option<Uuid> = row.try_get("owner_human_id")?;
    let owner_name: Option<String> = row.try_get("owner_display_name")?;
    let harness = row
        .try_get::<Option<String>, _>("subscription_harness")?
        .as_deref()
        .and_then(SubscriptionHarness::parse);

    let connection_ids: Vec<Uuid> = connections.iter().map(|c| c.id).collect();
    let live_tokens: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM token \
          WHERE workspace_id = $1 AND revoked_at IS NULL \
            AND (actor_member_id = $2 OR hosted_connection_id = ANY($3))",
    )
    .bind(workspace_id)
    .bind(agent_id)
    .bind(&connection_ids)
    .fetch_one(&mut *conn)
    .await?;
    let live_runs: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM agent_run \
          WHERE workspace_id = $1 AND agent_member_id = $2 \
            AND status::text IN ('queued', 'running', 'awaiting_approval', 'paused')",
    )
    .bind(workspace_id)
    .bind(agent_id)
    .fetch_one(&mut *conn)
    .await?;
    let messages_authored: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM message WHERE workspace_id = $1 AND author_member_id = $2",
    )
    .bind(workspace_id)
    .bind(agent_id)
    .fetch_one(&mut *conn)
    .await?;
    let owner_has_other_personal: bool = match (owner_id, &harness) {
        (Some(owner), Some(harness)) => {
            sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM agent a2 \
                                  JOIN member m2 ON m2.workspace_id = a2.workspace_id \
                                               AND m2.id = a2.member_id \
                                 WHERE a2.workspace_id = $1 AND a2.owner_human_id = $2 \
                                   AND a2.personal_agent AND a2.subscription_harness = $3 \
                                   AND a2.member_id <> $4 \
                                   AND m2.deleted_at IS NULL AND m2.status::text <> 'deleted')",
            )
            .bind(workspace_id)
            .bind(owner)
            .bind(harness.as_str())
            .bind(agent_id)
            .fetch_one(&mut *conn)
            .await?
        }
        _ => false,
    };

    Ok(Some(Inspection {
        agent_member_id: agent_id,
        handle: row.try_get("handle")?,
        display_name: row.try_get("display_name")?,
        member_status: row.try_get("status")?,
        member_deleted: row.try_get("deleted")?,
        invocation_scope: row.try_get("invocation_scope")?,
        harness,
        owner: match (owner_id, owner_name) {
            (Some(id), Some(name)) => Some((id, name)),
            _ => None,
        },
        personal_agent: row.try_get("personal_agent")?,
        retired: row.try_get("retired")?,
        uses_owner_key: row.try_get("uses_owner_key")?,
        execution_mode: row.try_get("execution_mode")?,
        connections,
        live_tokens,
        live_runs,
        messages_authored,
        owner_has_other_personal,
    }))
}

/// Close the pairing-stage connections and revoke every live credential.
/// Returns `(connections closed, doorbells cleared, tokens revoked)`.
async fn close_connections_and_revoke_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    i: &Inspection,
) -> Result<(i64, i64, i64), DbError> {
    let mut closed = 0_i64;
    let mut doorbells = 0_i64;
    for c in i.connections.iter().filter(|c| c.closable_by_tool()) {
        doorbells += sqlx::query(
            "DELETE FROM hosted_agent_doorbell WHERE workspace_id = $1 AND connection_id = $2",
        )
        .bind(workspace_id)
        .bind(c.id)
        .execute(&mut *conn)
        .await?
        .rows_affected() as i64;
        // `expired` rather than `disconnected`: migration 072 reaches
        // `disconnected` only from `cleanup_pending` with a resolved provider
        // manifest, and a connection that never carried a credential has none to
        // resolve. The pairing value is nulled so it cannot be presented, and
        // migration 125's guard keeps the row from being re-armed.
        closed += sqlx::query(
            "UPDATE hosted_agent_connection \
                SET status = 'expired', pairing_challenge_hash = NULL, pairing_expires_at = NULL, \
                    active_token_id = NULL, updated_at = now() \
              WHERE workspace_id = $1 AND id = $2 AND status IN ('pairing_pending', 'detected')",
        )
        .bind(workspace_id)
        .bind(c.id)
        .execute(&mut *conn)
        .await?
        .rows_affected() as i64;
    }
    let connection_ids: Vec<Uuid> = i.connections.iter().map(|c| c.id).collect();
    let revoked = sqlx::query(
        "UPDATE token SET revoked_at = now() \
          WHERE workspace_id = $1 AND revoked_at IS NULL \
            AND (actor_member_id = $2 OR hosted_connection_id = ANY($3))",
    )
    .bind(workspace_id)
    .bind(i.agent_member_id)
    .bind(&connection_ids)
    .execute(&mut *conn)
    .await?
    .rows_affected() as i64;
    Ok((closed, doorbells, revoked))
}

async fn release_device_slot_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
) -> Result<bool, DbError> {
    // Cleared so the register-after-login endpoint (D15) can never match this
    // row by device and hand it a fresh pairing value.
    Ok(sqlx::query(
        "UPDATE agent SET subscription_device_id = NULL, updated_at = now() \
          WHERE workspace_id = $1 AND member_id = $2 AND subscription_device_id IS NOT NULL",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .execute(&mut *conn)
    .await?
    .rows_affected()
        == 1)
}

async fn apply_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    transition: Transition,
    i: &Inspection,
    note: &str,
) -> Result<Changes, DbError> {
    let mut changes = Changes::default();
    let (closed, doorbells, revoked) =
        close_connections_and_revoke_in_tx(conn, workspace_id, i).await?;
    changes.connections_closed = closed;
    changes.doorbells_cleared = doorbells;
    changes.tokens_revoked = revoked;
    changes.device_slot_released = release_device_slot_in_tx(conn, workspace_id, i.agent_member_id).await?;

    match transition {
        Transition::Convert => {
            let (owner_id, _) = i
                .owner
                .as_ref()
                .ok_or_else(|| protocol("convert verdict without an owner"))?;
            let harness = i
                .harness
                .ok_or_else(|| protocol("convert verdict without a harness"))?;
            // The hosted-dial-in marker leaves the row: it is the owner's
            // member-host agent now, exactly the shape P2 creates.
            changes.execution_mode_changed = sqlx::query(
                "UPDATE agent SET config = jsonb_set(config, '{execution_mode}', to_jsonb($3::text)), \
                                  updated_at = now() \
                  WHERE workspace_id = $1 AND member_id = $2 \
                    AND COALESCE(config->>'execution_mode', '') <> $3",
            )
            .bind(workspace_id)
            .bind(i.agent_member_id)
            .bind(EXECUTION_MODE_MEMBER_HOST)
            .execute(&mut *conn)
            .await?
            .rows_affected()
                == 1;
            match mark_personal_agent_in_tx(conn, workspace_id, *owner_id, i.agent_member_id, harness)
                .await?
            {
                MarkOutcome::Marked => changes.marked = true,
                MarkOutcome::ConnectionsRemain => {
                    return Err(protocol(
                        "a connection or credential remained after revoking; rolled back",
                    ))
                }
                MarkOutcome::NotConvertible => {
                    return Err(protocol("agent stopped being convertible mid-run; rolled back"))
                }
            }
        }
        Transition::Retire => {
            changes.member_suspended = sqlx::query(
                "UPDATE member SET status = 'suspended', updated_at = now() \
                  WHERE workspace_id = $1 AND id = $2 AND kind = 'agent' \
                    AND status = 'active' AND deleted_at IS NULL",
            )
            .bind(workspace_id)
            .bind(i.agent_member_id)
            .execute(&mut *conn)
            .await?
            .rows_affected()
                == 1;
            changes.marked = sqlx::query(
                "UPDATE agent SET subscription_retired_at = now(), updated_at = now() \
                  WHERE workspace_id = $1 AND member_id = $2 \
                    AND subscription_retired_at IS NULL AND NOT personal_agent",
            )
            .bind(workspace_id)
            .bind(i.agent_member_id)
            .execute(&mut *conn)
            .await?
            .rows_affected()
                == 1;
            if !changes.marked {
                return Err(protocol("agent could not be marked retired; rolled back"));
            }
            changes.profile_paused = sqlx::query(
                "UPDATE agent_profile SET paused = true, version = version + 1, updated_at = now() \
                  WHERE workspace_id = $1 AND agent_member_id = $2 AND NOT paused",
            )
            .bind(workspace_id)
            .bind(i.agent_member_id)
            .execute(&mut *conn)
            .await?
            .rows_affected()
                == 1;
        }
    }

    let audit_id = write_audit(
        conn,
        &AuditEntry::new(workspace_id, transition.audit_action())
            .about(i.agent_member_id)
            .target("member", i.agent_member_id)
            .with_schema(
                &format!("momo.{}.v1", transition.audit_action()),
                json!({
                    "tool": TOOL_NAME,
                    "handle": i.handle,
                    "harness": i.harness.map(|h| h.as_str()),
                    "owner_member_id": i.owner.as_ref().map(|(id, _)| id.to_string()),
                    "connections_closed": changes.connections_closed,
                    "tokens_revoked": changes.tokens_revoked,
                    "messages_kept": i.messages_authored,
                    "note": note,
                }),
            ),
    )
    .await?;
    changes.audit_id = Some(audit_id);
    Ok(changes)
}

/// Run one transition inside the caller's tenant transaction.
///
/// `execute = false` is the dry run: the transaction is made read-only first
/// (the database refuses any write) and no row is locked. `note` is only read
/// when `execute` is true (validate it with [`validate_note`]).
pub async fn run_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    transition: Transition,
    handle: &str,
    execute: bool,
    note: &str,
) -> Result<Option<TransitionReport>, DbError> {
    if !execute {
        sqlx::query("SET LOCAL transaction_read_only = on")
            .execute(&mut *conn)
            .await?;
    }
    let Some(inspection) = inspect(conn, workspace_id, handle, execute).await? else {
        return Ok(None);
    };
    let verdict = decide(transition, &inspection);
    let changes = if execute && verdict == Verdict::Proceed {
        apply_in_tx(conn, workspace_id, transition, &inspection, note).await?
    } else {
        Changes::default()
    };
    Ok(Some(TransitionReport {
        transition,
        execute,
        inspection,
        verdict,
        changes,
    }))
}

/// One transition in its own tenant transaction. `Ok(None)` = no agent of this
/// workspace has that handle (the handle is also unique across humans, so a
/// human's handle is "no agent" as well).
pub async fn run_transition(
    pool: &PgPool,
    workspace_id: Uuid,
    transition: Transition,
    handle: &str,
    execute: bool,
    note: &str,
) -> Result<Option<TransitionReport>, DbError> {
    let handle = handle.to_string();
    let note = note.to_string();
    with_tenant_tx(pool, workspace_id, move |conn| {
        Box::pin(async move {
            run_in_tx(conn, workspace_id, transition, &handle, execute, &note).await
        })
    })
    .await
}

/// Refuse a role that can bypass row-level security. The tool is meant to run
/// as the application's own `NOBYPASSRLS` role under a tenant transaction; a
/// superuser or `BYPASSRLS` role would make the tenant GUC decorative.
pub async fn assert_least_privilege_role(pool: &PgPool) -> Result<String, String> {
    let row: (String, bool, bool) = sqlx::query_as(
        "SELECT current_user::text, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    )
    .fetch_one(pool)
    .await
    .map_err(|error| format!("cannot read the connecting role: {error}"))?;
    let (role, superuser, bypass) = row;
    if superuser || bypass {
        return Err(format!(
            "refusing to run as role {role} (superuser={superuser}, bypassrls={bypass}); \
             connect as the application role (momo_app), which runs under row-level security"
        ));
    }
    Ok(role)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Inspection {
        Inspection {
            agent_member_id: Uuid::nil(),
            handle: "kwak-claude".into(),
            display_name: "kwak-claude".into(),
            member_status: "active".into(),
            member_deleted: false,
            invocation_scope: INVOCATION_SCOPE_OWNER_ONLY.into(),
            harness: Some(SubscriptionHarness::ClaudeCode),
            owner: Some((Uuid::from_u128(1), "kwak".into())),
            personal_agent: false,
            retired: false,
            uses_owner_key: false,
            execution_mode: EXECUTION_MODE_HOSTED.into(),
            connections: vec![ConnectionFact {
                id: Uuid::from_u128(2),
                status: "pairing_pending".into(),
                ever_credentialed: false,
                has_doorbell: false,
            }],
            live_tokens: 0,
            live_runs: 0,
            messages_authored: 3,
            owner_has_other_personal: false,
        }
    }

    fn hosted_entry() -> Inspection {
        Inspection {
            handle: "claude-code".into(),
            invocation_scope: crate::subscription::INVOCATION_SCOPE_WORKSPACE.into(),
            harness: None,
            owner: Some((Uuid::from_u128(1), "kwak".into())),
            ..base()
        }
    }

    #[test]
    fn a_never_connected_owner_only_subscription_agent_converts() {
        assert_eq!(decide(Transition::Convert, &base()), Verdict::Proceed);
    }

    #[test]
    fn convert_refuses_every_other_shape_and_names_why() {
        let code = |i: Inspection| match decide(Transition::Convert, &i) {
            Verdict::Refused { code, .. } => code,
            other => panic!("expected a refusal, got {other:?}"),
        };
        assert_eq!(code(hosted_entry()), "not_a_subscription_agent");
        assert_eq!(
            code(Inspection { uses_owner_key: true, ..base() }),
            "not_a_subscription_agent"
        );
        assert_eq!(code(Inspection { owner: None, ..base() }), "no_owner");
        assert_eq!(
            code(Inspection { member_status: "suspended".into(), ..base() }),
            "member_not_active"
        );
        assert_eq!(
            code(Inspection { member_deleted: true, ..base() }),
            "member_deleted"
        );
        assert_eq!(
            code(Inspection { retired: true, ..base() }),
            "already_retired"
        );
        assert_eq!(
            code(Inspection { owner_has_other_personal: true, ..base() }),
            "personal_agent_exists"
        );
        assert_eq!(code(Inspection { live_runs: 1, ..base() }), "live_runs");
    }

    #[test]
    fn a_credentialed_connection_is_never_faked_closed() {
        for status in ["active", "cleanup_pending"] {
            let mut i = base();
            i.connections[0].status = status.into();
            assert!(
                matches!(decide(Transition::Convert, &i), Verdict::Refused { code: "connection_needs_admin_disconnect", .. }),
                "{status}"
            );
        }
        let mut confirmed = base();
        confirmed.connections[0].status = "expired".into();
        confirmed.connections[0].ever_credentialed = true;
        assert!(matches!(
            decide(Transition::Convert, &confirmed),
            Verdict::Refused { code: "connection_needs_admin_disconnect", .. }
        ));
    }

    #[test]
    fn an_already_closed_connection_and_no_connection_both_convert() {
        let mut closed = base();
        closed.connections[0].status = "expired".into();
        assert_eq!(decide(Transition::Convert, &closed), Verdict::Proceed);
        let mut none = base();
        none.connections.clear();
        assert_eq!(decide(Transition::Convert, &none), Verdict::Proceed);
    }

    #[test]
    fn a_converted_agent_is_a_noop_unless_something_live_remains() {
        let mut done = base();
        done.personal_agent = true;
        done.execution_mode = EXECUTION_MODE_MEMBER_HOST.into();
        done.connections[0].status = "expired".into();
        assert_eq!(decide(Transition::Convert, &done), Verdict::AlreadyDone);
        done.live_tokens = 1;
        assert!(matches!(
            decide(Transition::Convert, &done),
            Verdict::Refused { code: "personal_agent_has_live_attachments", .. }
        ));
    }

    #[test]
    fn retire_takes_only_a_hosted_workspace_entry() {
        assert_eq!(decide(Transition::Retire, &hosted_entry()), Verdict::Proceed);
        let code = |i: Inspection| match decide(Transition::Retire, &i) {
            Verdict::Refused { code, .. } => code,
            other => panic!("expected a refusal, got {other:?}"),
        };
        // kwak-claude is converted, never retired.
        assert_eq!(code(base()), "not_a_hosted_workspace_agent");
        assert_eq!(
            code(Inspection { execution_mode: "member_host".into(), ..hosted_entry() }),
            "not_a_hosted_dial_in_agent"
        );
        assert_eq!(
            code(Inspection { personal_agent: true, ..hosted_entry() }),
            "is_personal_agent"
        );
    }

    #[test]
    fn a_retired_entry_is_a_noop() {
        let mut done = hosted_entry();
        done.retired = true;
        done.member_status = "suspended".into();
        done.connections[0].status = "expired".into();
        assert_eq!(decide(Transition::Retire, &done), Verdict::AlreadyDone);
    }

    #[test]
    fn the_note_is_a_bounded_single_line() {
        assert!(validate_note("  ").is_err());
        assert!(validate_note("a\nb").is_err());
        assert!(validate_note(&"x".repeat(501)).is_err());
        assert_eq!(validate_note(" 성재 승인 2026-10-10 ").unwrap(), "성재 승인 2026-10-10");
    }

    #[test]
    fn the_report_says_dry_run_wrote_nothing() {
        let report = TransitionReport {
            transition: Transition::Convert,
            execute: false,
            inspection: base(),
            verdict: Verdict::Proceed,
            changes: Changes::default(),
        };
        let text = report.render();
        assert!(text.contains("DRY-RUN"));
        assert!(text.contains("connections_to_close=1"));
        assert!(text.contains("messages_authored"));
    }
}
