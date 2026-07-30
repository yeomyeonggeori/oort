//! `audit_log` write helper — signature stub only (B0).
//!
//! The audit row is workspace-scoped and therefore written inside the SAME
//! tenant transaction as the action it records (so it inherits the RLS GUC and
//! is attributable). The concrete column mapping lands with the domain crates
//! in B1; B0 fixes only the shape so callers can be written against it.

use sqlx::PgConnection;
use uuid::Uuid;

use crate::error::DbError;

/// One audit entry to persist. Field set is intentionally minimal for B0 and
/// will grow with the domain schema in B1.
#[derive(Debug, Clone)]
pub struct AuditEntry {
    pub workspace_id: Uuid,
    pub actor_member_id: Uuid,
    pub action: String,
    pub target: Option<String>,
}

/// Write an audit entry within an already tenant-scoped transaction.
///
/// STUB (B0): unimplemented until the `audit_log` write path is ported in B1.
/// Kept as `unimplemented!()` rather than a silent no-op so a premature caller
/// fails loudly instead of dropping an audit record.
pub async fn write_audit(_conn: &mut PgConnection, _entry: &AuditEntry) -> Result<(), DbError> {
    unimplemented!("audit_log write is ported in B1 (domain crates)")
}
