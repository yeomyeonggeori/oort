//! Agent-action provenance — ADR-0146 API skeleton (**Proposed**, not yet
//! Accepted by 성재).
//!
//! ADR-0145 selectively borrows buzz's strength: every agent-origin action can
//! carry an Ed25519 signature as verifiable provenance metadata — *additive*,
//! never authority. The single write path and RLS are untouched (D2 cross-check:
//! the server stays the sole author; the signature only proves authenticity, not
//! order/isolation/write-path).
//!
//! **B0 is API skeleton ONLY.** Because ADR-0146 is still Proposed, we do NOT:
//!   * create the `action_signature` table or any migration (schema change is
//!     gated on Accept), or
//!   * commit to a final signing-payload byte format.
//!
//! We fix only the call shape so B1 can wire it once the ADR lands. Both
//! functions are `unimplemented!()` on purpose.

use uuid::Uuid;

/// Provisional schema tag for the provenance signing payload. The concrete
/// byte format is deferred to ADR-0146 Accept (kept a placeholder so no
/// unapproved format is baked into the wire contract).
pub const PROVENANCE_SCHEMA_V0_PLACEHOLDER: &str = "momo.agent_action.provenance.v0";

/// What a provenance signature is bound to (e.g. a message, a work-control
/// decision). Finalized in ADR-0146.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntityRef {
    /// Entity kind (e.g. `"message"`, `"approval_decision"`).
    pub kind: String,
    /// Entity id.
    pub id: Uuid,
}

#[derive(Debug, thiserror::Error)]
pub enum ProvenanceError {
    /// ADR-0146 not yet Accepted — the write path/table does not exist.
    #[error("provenance recording is not implemented until ADR-0146 is Accepted")]
    NotImplemented,
}

/// Build the provenance signing payload for `entity_ref`.
///
/// SKELETON: byte format is finalized in ADR-0146. `unimplemented!()` until then.
pub fn provenance_signing_payload(_entity_ref: &EntityRef) -> Vec<u8> {
    unimplemented!(
        "provenance signing-payload format is defined by ADR-0146 (Proposed); \
         placeholder schema = {PROVENANCE_SCHEMA_V0_PLACEHOLDER}"
    )
}

/// Record a provenance signature for an entity, within the caller's tenant
/// transaction.
///
/// SKELETON: the DB target (`action_signature`) does not exist yet (no migration
/// until ADR-0146 Accept). The executor is left generic and unbounded so this
/// crate does not take a `sqlx` dependency for a stub; B1 will bind
/// `E: sqlx::PgExecutor<'_>` and add the insert once the table lands.
pub async fn record_provenance<E>(
    _executor: E,
    _entity_ref: &EntityRef,
    _signer_pubkey_b64: &str,
    _signature_b64: &str,
) -> Result<(), ProvenanceError> {
    unimplemented!(
        "record_provenance is an ADR-0146 (Proposed) skeleton — no action_signature \
         table exists until the ADR is Accepted"
    )
}
