//! Which adapter answers for a `work_cloud_host.provider` (ADR-0142 D2/D4).
//!
//! The reconciler must resolve the same substrate the API provisioned against,
//! keyed by the row's registry id — never by whatever this process happens to be
//! configured with (the comment the e2e compose spells out at
//! `docker-compose.e2e.yml:483-484`). That resolution is a seam, not a table:
//! this module maps an id to an adapter and knows nothing else about providers.

use std::sync::Arc;

use momo_provider::CloudProviderAdapter;
use momo_t3::provider::registry::{is_registered, BYOC_PROVIDER_ID};
use momo_t3::ByocProviderAdapter;

/// Why a provider id produced no adapter. Both variants are *refusals*: the
/// caller leaves the durable intent claimable rather than guessing, which is the
/// only move that neither bills nor strands a paid session.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AdapterError {
    /// Not in the ADR-0142 registry — fail closed (054 header).
    #[error("unknown t3 provider: {0}")]
    Unknown(String),
    /// Registered, but this process has no adapter that can speak to it.
    #[error("no adapter is wired for t3 provider {0} in the notifier")]
    Unwired(String),
}

/// The seam the reconciler resolves through.
pub trait ProviderAdapterResolver: Send + Sync {
    fn adapter_for(&self, provider_id: &str)
        -> Result<Arc<dyn CloudProviderAdapter>, AdapterError>;
}

/// The production resolver.
///
/// Today it serves exactly one adapter — the degenerate BYOC form, whose probe
/// is honestly [`Unknown`](momo_provider::CloudInstancePresence::Unknown) and
/// whose destroy is momo releasing its own binding. Every other registered id is
/// **refused**, on purpose:
///
/// * the managed HTTP adapter (Swift `HTTPCloudProviderAdapter`) is not ported
///   yet — B2.1 shipped BYOC plus the in-process verification substrates;
/// * substituting an in-process [`momo_t3::MockProviderAdapter`] here would be
///   worse than useless: a fresh mock knows no instances, so every probe would
///   answer `Absent` and the reconciler would settle live paid sessions on the
///   word of a substrate that never saw them. That is precisely the silent
///   failure ADR-0142 D3.1 bans, so the refusal is the safe answer, not a gap in
///   the wiring.
///
/// A refusal is logged by name and leaves the durable intent for the next pass,
/// which is what the deadline and the backoff are for.
#[derive(Debug, Default, Clone, Copy)]
pub struct RegistryAdapterResolver;

impl ProviderAdapterResolver for RegistryAdapterResolver {
    fn adapter_for(
        &self,
        provider_id: &str,
    ) -> Result<Arc<dyn CloudProviderAdapter>, AdapterError> {
        if provider_id == BYOC_PROVIDER_ID {
            return Ok(Arc::new(ByocProviderAdapter::new()));
        }
        if is_registered(provider_id) {
            return Err(AdapterError::Unwired(provider_id.to_string()));
        }
        Err(AdapterError::Unknown(provider_id.to_string()))
    }
}

/// A resolver that answers every id with one adapter. Exists for the conformance
/// harness, which stages a substrate's death and must have the reconciler ask
/// *that* substrate.
pub struct FixedAdapterResolver(Arc<dyn CloudProviderAdapter>);

impl FixedAdapterResolver {
    pub fn new(adapter: Arc<dyn CloudProviderAdapter>) -> Self {
        FixedAdapterResolver(adapter)
    }
}

impl ProviderAdapterResolver for FixedAdapterResolver {
    fn adapter_for(
        &self,
        _provider_id: &str,
    ) -> Result<Arc<dyn CloudProviderAdapter>, AdapterError> {
        Ok(Arc::clone(&self.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use momo_provider::CloudProviderOperation;
    use momo_t3::provider::registry::{MOCK_A_PROVIDER_ID, MOCK_B_PROVIDER_ID};

    #[test]
    fn byoc_resolves_to_the_degenerate_adapter() {
        let adapter = RegistryAdapterResolver
            .adapter_for(BYOC_PROVIDER_ID)
            .expect("byoc is served");
        assert!(!adapter
            .capabilities()
            .supports(CloudProviderOperation::Create));
        assert_eq!(adapter.capabilities().provider_id, BYOC_PROVIDER_ID);
    }

    #[test]
    fn a_managed_provider_with_no_adapter_is_refused_not_guessed() {
        for provider_id in [MOCK_A_PROVIDER_ID, MOCK_B_PROVIDER_ID] {
            assert_eq!(
                RegistryAdapterResolver.adapter_for(provider_id).err(),
                Some(AdapterError::Unwired(provider_id.to_string())),
                "named regression: a substrate the notifier cannot ask must never be \
                 answered by an empty in-process mock (its probe would read `absent`)"
            );
        }
    }

    #[test]
    fn an_unregistered_provider_fails_closed() {
        assert_eq!(
            RegistryAdapterResolver.adapter_for("e2b").err(),
            Some(AdapterError::Unknown("e2b".to_string()))
        );
    }
}
