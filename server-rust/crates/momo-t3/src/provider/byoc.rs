//! ADR-0142 D1 — bring-your-own-cloud, the base form.
//!
//! The owner installs `momo-workd` on their own machine and spends a one-shot
//! enrollment token; momo never gained the right to boot or kill that machine,
//! so `create` refuses instead of pretending. `destroy` is the one asymmetry:
//! the durable intent it serves is "momo must stop treating this host as
//! available", which momo *can* satisfy (it revokes the host row), so it
//! succeeds idempotently rather than trapping the lifecycle in a state no retry
//! could ever leave (ADR-0140 D4: destroy never gives up).
//!
//! Direct port of Swift `CloudProviderKit/BYOCProviderAdapter.swift`.

use async_trait::async_trait;
use momo_provider::{
    CloudInstancePresence, CloudInstanceRef, CloudInstanceSpec, CloudProviderAdapter,
    CloudProviderCapabilities, CloudProviderError, CloudProviderOperation,
};

use crate::provider::registry::{capabilities_for, BYOC_PROVIDER_ID};

#[derive(Debug, Clone)]
pub struct ByocProviderAdapter {
    capabilities: CloudProviderCapabilities,
}

impl ByocProviderAdapter {
    /// The registered `byoc` descriptor.
    pub fn new() -> Self {
        ByocProviderAdapter {
            capabilities: capabilities_for(BYOC_PROVIDER_ID)
                .expect("byoc is a registered provider id"),
        }
    }

    /// A degenerate adapter for some other registry id (a self-hosted substrate
    /// momo observes but does not manage).
    pub fn with_capabilities(capabilities: CloudProviderCapabilities) -> Self {
        ByocProviderAdapter { capabilities }
    }
}

impl Default for ByocProviderAdapter {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl CloudProviderAdapter for ByocProviderAdapter {
    fn capabilities(&self) -> &CloudProviderCapabilities {
        &self.capabilities
    }

    async fn create(
        &self,
        _spec: &CloudInstanceSpec,
        _idempotency_key: &str,
    ) -> Result<CloudInstanceRef, CloudProviderError> {
        Err(CloudProviderError::Unsupported {
            operation: CloudProviderOperation::Create,
            provider_id: self.capabilities.provider_id.clone(),
        })
    }

    async fn pause(
        &self,
        _instance: &CloudInstanceRef,
        _idempotency_key: &str,
    ) -> Result<(), CloudProviderError> {
        Err(CloudProviderError::Unsupported {
            operation: CloudProviderOperation::Pause,
            provider_id: self.capabilities.provider_id.clone(),
        })
    }

    async fn resume(
        &self,
        _instance: &CloudInstanceRef,
        _idempotency_key: &str,
    ) -> Result<(), CloudProviderError> {
        Err(CloudProviderError::Unsupported {
            operation: CloudProviderOperation::Resume,
            provider_id: self.capabilities.provider_id.clone(),
        })
    }

    /// Releasing momo's own binding is always possible and always idempotent.
    /// The owner's machine keeps running; that is the documented contract, and
    /// so is the residual-snapshot notice in the self-host guide (ADR-0142 D3).
    async fn destroy(
        &self,
        _instance: &CloudInstanceRef,
        _idempotency_key: &str,
    ) -> Result<(), CloudProviderError> {
        Ok(())
    }

    /// momo has no provider API to ask. Reporting `Absent` here would be the
    /// silent failure ADR-0142 D3.1 bans (it would settle a live paid session),
    /// and reporting `Present` would be a lie. Host liveness is already carried
    /// by the workd heartbeat and the existing offline sweep.
    async fn probe(
        &self,
        _instance: &CloudInstanceRef,
    ) -> Result<CloudInstancePresence, CloudProviderError> {
        Ok(CloudInstancePresence::Unknown)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn instance() -> CloudInstanceRef {
        CloudInstanceRef {
            provider_id: BYOC_PROVIDER_ID.to_string(),
            instance_id: "owner-vm-1".to_string(),
        }
    }

    fn spec() -> CloudInstanceSpec {
        CloudInstanceSpec {
            provision_id: Uuid::new_v4(),
            workspace_id: Uuid::new_v4(),
            display_name: "owner vm".to_string(),
            registration_token: "one-shot".to_string(),
            server_url: "https://momo.invalid".to_string(),
        }
    }

    #[tokio::test]
    async fn byoc_refuses_what_it_does_not_own() {
        let adapter = ByocProviderAdapter::new();
        assert!(matches!(
            adapter.create(&spec(), "k").await,
            Err(CloudProviderError::Unsupported {
                operation: CloudProviderOperation::Create,
                ..
            })
        ));
        assert!(matches!(
            adapter.pause(&instance(), "k").await,
            Err(CloudProviderError::Unsupported {
                operation: CloudProviderOperation::Pause,
                ..
            })
        ));
        assert!(matches!(
            adapter.resume(&instance(), "k").await,
            Err(CloudProviderError::Unsupported {
                operation: CloudProviderOperation::Resume,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn byoc_destroy_is_idempotent_and_probe_is_unknown() {
        let adapter = ByocProviderAdapter::new();
        adapter.destroy(&instance(), "k").await.expect("first");
        adapter.destroy(&instance(), "k").await.expect("second");
        assert_eq!(
            adapter.probe(&instance()).await.unwrap(),
            CloudInstancePresence::Unknown,
            "an unanswerable question must never be reported as `Absent`"
        );
    }
}
