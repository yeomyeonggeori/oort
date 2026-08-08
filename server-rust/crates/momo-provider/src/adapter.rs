//! The `CloudProviderAdapter` trait + its value types — the single place a
//! provider-specific fact is allowed to exist (ADR-0142 D2).

use async_trait::async_trait;
use uuid::Uuid;

use crate::capability::{CloudInstancePresence, CloudProviderCapabilities, CloudProviderOperation};

/// The surface a T3 execution substrate must implement. Lifecycle rules (durable
/// intent, idempotency key, advisory serialization, transition table) live in
/// ADR-0140 and are provider-general; this trait is the only provider-specific
/// seam. `create`/`destroy` are idempotent on `idempotency_key`.
#[async_trait]
pub trait CloudProviderAdapter: Send + Sync {
    fn capabilities(&self) -> &CloudProviderCapabilities;

    /// Create one instance and inject its one-shot workd bootstrap material.
    /// Re-calling with the same `idempotency_key` must converge on the same
    /// instance rather than creating a second billable one.
    async fn create(
        &self,
        spec: &CloudInstanceSpec,
        idempotency_key: &str,
    ) -> Result<CloudInstanceRef, CloudProviderError>;

    /// Suspend an instance. Adapters that cannot pause declare it in
    /// `capabilities` and return [`CloudProviderError::Unsupported`] — faking a
    /// pause is banned (the ledger would bill a running instance as paused).
    async fn pause(
        &self,
        instance: &CloudInstanceRef,
        idempotency_key: &str,
    ) -> Result<(), CloudProviderError>;

    /// Resume a paused instance. `capabilities.resume_semantics` states whether
    /// process/memory state survives; nothing else may assume it does.
    async fn resume(
        &self,
        instance: &CloudInstanceRef,
        idempotency_key: &str,
    ) -> Result<(), CloudProviderError>;

    /// Idempotent. An already-absent instance is success, not an error: the
    /// intent ("this instance must not exist") is satisfied either way.
    async fn destroy(
        &self,
        instance: &CloudInstanceRef,
        idempotency_key: &str,
    ) -> Result<(), CloudProviderError>;

    /// Fact lookup behind the ADR-0140 D4 convergence rules. Three-valued: "I
    /// could not reach the provider" is [`CloudInstancePresence::Unknown`], never
    /// `Absent`.
    async fn probe(
        &self,
        instance: &CloudInstanceRef,
    ) -> Result<CloudInstancePresence, CloudProviderError>;
}

/// Everything an adapter needs to start one instance. Deliberately carries NO
/// provider credential (ADR-0004): only a one-shot workd registration token
/// (whose digest alone reaches Postgres) and the callback server URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudInstanceSpec {
    pub provision_id: Uuid,
    pub workspace_id: Uuid,
    pub display_name: String,
    /// One-shot workd registration token. Only its digest reaches PostgreSQL.
    pub registration_token: String,
    /// Public momo base URL the workd registers back against.
    pub server_url: String,
}

/// A durable handle to one provider instance. `provider_id` travels with the
/// instance so a workspace that moved providers cannot address the old one.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CloudInstanceRef {
    pub provider_id: String,
    pub instance_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CloudProviderError {
    /// The adapter declares it cannot do this — it did not fake it.
    #[error("provider {provider_id} does not support {operation:?}")]
    Unsupported {
        operation: CloudProviderOperation,
        provider_id: String,
    },
    /// The provider says the instance no longer exists.
    #[error("instance is missing")]
    InstanceMissing,
    /// Honest refusal: the instance is paused and this call needs it running.
    #[error("instance is paused")]
    InstancePaused,
    #[error("upstream returned status {0}")]
    UpstreamStatus(u16),
    #[error("invalid provider response")]
    InvalidResponse,
    #[error("provider request failed")]
    RequestFailed,
    #[error("provider not configured: {0}")]
    NotConfigured(String),
}

/// Instance identifiers are interpolated into provider URLs, so they are
/// constrained to an opaque-token charset before ever reaching a request line
/// (`CloudProviderAdapter.swift:164-169`, regex `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`).
pub fn validated_cloud_instance_id(value: &str) -> Result<&str, CloudProviderError> {
    let mut chars = value.chars();
    let first_ok = matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric());
    let rest_ok = chars
        .clone()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    // total length 1..=128
    let len_ok = (1..=128).contains(&value.chars().count());
    if first_ok && rest_ok && len_ok {
        Ok(value)
    } else {
        Err(CloudProviderError::InvalidResponse)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_instance_id_charset() {
        assert!(validated_cloud_instance_id("i-0abc_DEF-123").is_ok());
        assert!(validated_cloud_instance_id("A").is_ok());
        // empty
        assert!(validated_cloud_instance_id("").is_err());
        // leading non-alnum
        assert!(validated_cloud_instance_id("-abc").is_err());
        // illegal char
        assert!(validated_cloud_instance_id("abc/def").is_err());
        // too long (129)
        assert!(validated_cloud_instance_id(&"a".repeat(129)).is_err());
        // max length (128)
        assert!(validated_cloud_instance_id(&"a".repeat(128)).is_ok());
    }
}
