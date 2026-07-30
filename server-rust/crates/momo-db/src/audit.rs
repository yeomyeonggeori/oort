//! `audit_log` write helper — the real implementation (B2.4).
//!
//! The audit row is workspace-scoped and therefore written inside the SAME
//! tenant transaction as the action it records, so it inherits the RLS GUC, is
//! attributable, and rolls back with the action if the action rolls back. That
//! atomicity is the whole point: an audit row that survived a rolled-back write
//! would be a false record, and a write that survived a failed audit would be an
//! unrecorded one. Ports the Swift convention of writing the row inside the same
//! `withTenantTransaction` block as the change (e.g. the `audited` CTE in
//! `TerminalAttachRoutes.swift:234-250`).
//!
//! ## Measured column mapping (`001_init.sql:360-374`)
//!
//! ```text
//! workspace_id      uuid NOT NULL REFERENCES workspace(id)
//! actor_member_id   uuid REFERENCES member(id)   -- nullable: system events
//! subject_member_id uuid REFERENCES member(id)
//! action            text NOT NULL
//! target_type       text
//! target_id         uuid
//! via_token_id      uuid REFERENCES token(id)    -- delegation provenance
//! run_id            uuid REFERENCES agent_run(id)
//! detail            jsonb NOT NULL DEFAULT '{}'
//! ip_addr           inet
//! created_at        timestamptz NOT NULL DEFAULT now()
//! ```
//!
//! `ip_addr` is deliberately **not** in [`AuditEntry`]: no route in this server
//! resolves a client address (there is no proxy-header trust policy yet), and a
//! column that could only ever be NULL is better absent from the API than
//! present and always ignored.
//!
//! ## The two conventions the Swift server established, ported verbatim
//!
//! 1. **`via_token_id` is a `token.id`, never a host id.** A work-host principal
//!    signs with Ed25519 and carries the HOST id in its `tokenID` slot; that id
//!    is not a `token` row, so writing it here is a foreign-key violation — a
//!    500 the Swift server hit live and fixed by writing NULL
//!    (`WorkSessionRoutes.swift:1013-1017`: "No token was used, so NULL is the
//!    true statement"). Callers pass `None` for a host-signed action; the acting
//!    host belongs in `detail`.
//! 2. **`detail` carries a `schema` key.** Every Swift audit detail object opens
//!    with `"schema": "momo.<area>.<event>.v1"` so a reader can version the
//!    payload without inferring it from `action`. [`AuditEntry::with_schema`]
//!    makes that the cheap path.
//!
//! Returning the new row's id is not a convenience: migrations 013/014 declare
//! `installed_audit_id` / `created_audit_id` / `revoked_audit_id` as `NOT NULL
//! REFERENCES audit_log(id)`, so a caller in those areas must be able to name
//! the row it just wrote.

use serde_json::{Map, Value};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::error::DbError;

/// One audit entry to persist, field-for-field with the `audit_log` columns a
/// route can legitimately supply.
///
/// Construct with [`AuditEntry::new`] and add only what the action actually
/// knows — every optional column stays NULL otherwise, which is the honest
/// record rather than a guessed one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditEntry {
    pub workspace_id: Uuid,
    /// Who did it. `None` = a system event with no member behind it.
    pub actor_member_id: Option<Uuid>,
    /// Who/what it affected. Swift repeats the actor here for a self-directed
    /// action (`work.terminal_attach.issued`, `work.session.idle`).
    pub subject_member_id: Option<Uuid>,
    /// `'auth.logout'`, `'work.terminal_attach.issued'`, …
    pub action: String,
    /// `'work_session'`, `'message'`, `'token'`, …
    pub target_type: Option<String>,
    pub target_id: Option<Uuid>,
    /// The `token.id` that authorized this, when a token did. **NULL for a
    /// host-signed action** — see the module docs.
    pub via_token_id: Option<Uuid>,
    pub run_id: Option<Uuid>,
    /// Free-form provenance. Defaults to `{}`, matching the column default.
    pub detail: Value,
}

impl AuditEntry {
    /// The minimum a row needs: a tenant and an action.
    pub fn new(workspace_id: Uuid, action: impl Into<String>) -> Self {
        AuditEntry {
            workspace_id,
            actor_member_id: None,
            subject_member_id: None,
            action: action.into(),
            target_type: None,
            target_id: None,
            via_token_id: None,
            run_id: None,
            detail: Value::Object(Map::new()),
        }
    }

    /// The acting member, also recorded as the subject — Swift's shape for a
    /// self-directed action (`actor_member_id` == `subject_member_id`).
    pub fn by(mut self, member_id: Uuid) -> Self {
        self.actor_member_id = Some(member_id);
        self.subject_member_id = Some(member_id);
        self
    }

    /// Split actor and subject when the action is directed at someone else.
    pub fn about(mut self, subject_member_id: Uuid) -> Self {
        self.subject_member_id = Some(subject_member_id);
        self
    }

    /// Both halves of the target, together — a `target_type` without a
    /// `target_id` names nothing.
    pub fn target(mut self, target_type: impl Into<String>, target_id: Uuid) -> Self {
        self.target_type = Some(target_type.into());
        self.target_id = Some(target_id);
        self
    }

    /// Delegation provenance. Pass `None` for a host-signed action: the host id
    /// is not a `token.id` and the FK would reject it (module docs, rule 1).
    pub fn via_token(mut self, via_token_id: Option<Uuid>) -> Self {
        self.via_token_id = via_token_id;
        self
    }

    pub fn run(mut self, run_id: Uuid) -> Self {
        self.run_id = Some(run_id);
        self
    }

    /// Set `detail`, inserting the `schema` key Swift's readers version on.
    ///
    /// An explicit `schema` already in `detail` wins, so a caller that spells it
    /// inline is never silently overwritten.
    pub fn with_schema(mut self, schema: &str, detail: Value) -> Self {
        self.detail = match detail {
            Value::Object(mut map) => {
                map.entry("schema".to_string())
                    .or_insert_with(|| Value::String(schema.to_string()));
                Value::Object(map)
            }
            // A non-object detail cannot carry a key; wrap rather than drop it.
            other => {
                let mut map = Map::new();
                map.insert("schema".to_string(), Value::String(schema.to_string()));
                map.insert("value".to_string(), other);
                Value::Object(map)
            }
        };
        self
    }
}

/// Write an audit entry within an already tenant-scoped transaction, returning
/// the new `audit_log.id`.
///
/// One statement, no reads, no side effects: the caller's transaction decides
/// whether this record stands. The `workspace_id` bound here must be the one the
/// transaction's GUC was opened with — RLS FORCE rejects any other, which is the
/// backstop that keeps an audit row inside the tenant it describes.
pub async fn write_audit(conn: &mut PgConnection, entry: &AuditEntry) -> Result<Uuid, DbError> {
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO audit_log \
           (workspace_id, actor_member_id, subject_member_id, action, \
            target_type, target_id, via_token_id, run_id, detail) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) \
         RETURNING id",
    )
    .bind(entry.workspace_id)
    .bind(entry.actor_member_id)
    .bind(entry.subject_member_id)
    .bind(&entry.action)
    .bind(entry.target_type.as_deref())
    .bind(entry.target_id)
    .bind(entry.via_token_id)
    .bind(entry.run_id)
    .bind(&entry.detail)
    .fetch_one(&mut *conn)
    .await?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bare_entry_leaves_every_optional_column_null() {
        let entry = AuditEntry::new(Uuid::from_u128(1), "auth.logout");
        assert_eq!(entry.action, "auth.logout");
        assert!(entry.actor_member_id.is_none());
        assert!(entry.subject_member_id.is_none());
        assert!(entry.target_type.is_none());
        assert!(entry.target_id.is_none());
        assert!(entry.via_token_id.is_none());
        assert!(entry.run_id.is_none());
        assert_eq!(entry.detail, Value::Object(Map::new()));
    }

    #[test]
    fn by_records_the_actor_as_its_own_subject() {
        let member = Uuid::from_u128(7);
        let entry = AuditEntry::new(Uuid::from_u128(1), "work.terminal_attach.issued").by(member);
        assert_eq!(entry.actor_member_id, Some(member));
        assert_eq!(
            entry.subject_member_id,
            Some(member),
            "Swift writes actor == subject for a self-directed action"
        );
        // …until the action is directed at someone else.
        let other = Uuid::from_u128(8);
        let redirected = entry.about(other);
        assert_eq!(redirected.actor_member_id, Some(member));
        assert_eq!(redirected.subject_member_id, Some(other));
    }

    /// The FK rule that cost the Swift server a live 500: a host-signed action
    /// carries no `token.id`, so the column must stay NULL.
    #[test]
    fn via_token_accepts_absence_because_a_host_signature_has_no_token_row() {
        let entry = AuditEntry::new(Uuid::from_u128(1), "work.session.idle").via_token(None);
        assert!(entry.via_token_id.is_none());
        let token = Uuid::from_u128(9);
        assert_eq!(
            AuditEntry::new(Uuid::from_u128(1), "auth.logout")
                .via_token(Some(token))
                .via_token_id,
            Some(token)
        );
    }

    #[test]
    fn with_schema_adds_the_version_key_without_clobbering_an_explicit_one() {
        let entry = AuditEntry::new(Uuid::from_u128(1), "x").with_schema(
            "momo.work.terminal_attach.issued.v1",
            serde_json::json!({"mode": "observer"}),
        );
        assert_eq!(
            entry.detail["schema"],
            serde_json::json!("momo.work.terminal_attach.issued.v1")
        );
        assert_eq!(entry.detail["mode"], serde_json::json!("observer"));

        let explicit = AuditEntry::new(Uuid::from_u128(1), "x")
            .with_schema("momo.default.v1", serde_json::json!({"schema": "momo.v2"}));
        assert_eq!(
            explicit.detail["schema"],
            serde_json::json!("momo.v2"),
            "a caller that spelled the schema inline must not be overwritten"
        );

        let wrapped =
            AuditEntry::new(Uuid::from_u128(1), "x").with_schema("s.v1", serde_json::json!(42));
        assert_eq!(wrapped.detail["schema"], serde_json::json!("s.v1"));
        assert_eq!(
            wrapped.detail["value"],
            serde_json::json!(42),
            "a non-object detail is wrapped, never dropped"
        );
    }

    #[test]
    fn target_sets_both_halves_together() {
        let session = Uuid::from_u128(5);
        let entry = AuditEntry::new(Uuid::from_u128(1), "x").target("work_session", session);
        assert_eq!(entry.target_type.as_deref(), Some("work_session"));
        assert_eq!(entry.target_id, Some(session));
    }
}
