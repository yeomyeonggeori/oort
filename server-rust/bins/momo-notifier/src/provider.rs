//! Which adapter answers for a `work_cloud_host.provider` (ADR-0142 D2/D4).
//!
//! The reconciler must resolve the same substrate the API provisioned against,
//! keyed by the row's registry id — never by whatever this process happens to be
//! configured with (the comment the e2e compose spells out at
//! `docker-compose.e2e.yml:483-484`). That resolution is a seam, not a table:
//! this module maps an id to an adapter and knows nothing else about providers.
//!
//! ## What ADR-0156 D4-④ changed here
//!
//! Until D4-④ this resolver served exactly one id (`byoc`) and refused every
//! managed one, because no managed adapter existed that could be pointed at
//! anything real. Now one can be: [`momo_t3::managed_adapters_from_process_env`]
//! builds every managed substrate **the operator configured**, once, at
//! construction.
//!
//! The refusal did not go away — its *reason* moved from the source tree to the
//! environment. A managed id is `Unwired` when this process holds no endpoint
//! for it, which is exactly the deployment where resolving it would aim the
//! reconciler at a host nobody stood up. So the boundary test below still passes
//! for an unconfigured process and now also states the other half: a configured
//! one resolves.

use std::collections::BTreeMap;
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
/// It serves two kinds of adapter and refuses everything else:
///
/// * the degenerate **BYOC** form, always — it needs no configuration, its probe
///   is honestly [`Unknown`](momo_provider::CloudInstancePresence::Unknown) and
///   its destroy is momo releasing its own binding;
/// * every **managed** substrate this process was given an endpoint and a
///   credential for (ADR-0142 D4). The adapters are built once, at construction,
///   because each owns an HTTP client and a per-intent rebuild would discard the
///   connection pool on the hot path.
///
/// Everything else is **refused**, on purpose:
///
/// * a registered managed id with no configuration is `Unwired`. Resolving it
///   would point the reconciler at an endpoint nobody has stood up;
/// * substituting an in-process [`momo_t3::MockProviderAdapter`] for one would be
///   worse than useless: a fresh mock knows no instances, so every probe would
///   answer `Absent` and the reconciler would settle live paid sessions on the
///   word of a substrate that never saw them. That is precisely the silent
///   failure ADR-0142 D3.1 bans, so the refusal is the safe answer, not a gap in
///   the wiring. [`momo_t3::managed_adapters_from_env`] enforces that by never
///   producing one.
///
/// A refusal is logged by name and leaves the durable intent for the next pass,
/// which is what the deadline and the backoff are for.
#[derive(Default, Clone)]
pub struct RegistryAdapterResolver {
    managed: BTreeMap<String, Arc<dyn CloudProviderAdapter>>,
}

/// Hand-written: the adapters themselves are not `Debug` (each holds an operator
/// credential, redacted by its own impl), and what a log line wants here is the
/// *shape* of the wiring anyway — which substrates this process can reach.
impl std::fmt::Debug for RegistryAdapterResolver {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RegistryAdapterResolver")
            .field("wired", &self.wired_provider_ids())
            .finish()
    }
}

impl RegistryAdapterResolver {
    /// Build from the process environment — the production constructor.
    pub fn from_process_env() -> RegistryAdapterResolver {
        RegistryAdapterResolver {
            managed: momo_t3::managed_adapters_from_process_env(),
        }
    }

    /// Build from an explicit environment map (tests, and any caller that must
    /// not read the ambient process env).
    pub fn from_env(env: &BTreeMap<String, String>) -> RegistryAdapterResolver {
        RegistryAdapterResolver {
            managed: momo_t3::managed_adapters_from_env(env),
        }
    }

    /// The registry ids this process can actually speak to. Logged at boot so a
    /// deployment can tell "no managed substrate configured" from "configured
    /// and idle".
    pub fn wired_provider_ids(&self) -> Vec<&str> {
        self.managed.keys().map(String::as_str).collect()
    }
}

impl ProviderAdapterResolver for RegistryAdapterResolver {
    fn adapter_for(
        &self,
        provider_id: &str,
    ) -> Result<Arc<dyn CloudProviderAdapter>, AdapterError> {
        if provider_id == BYOC_PROVIDER_ID {
            return Ok(Arc::new(ByocProviderAdapter::new()));
        }
        if let Some(adapter) = self.managed.get(provider_id) {
            return Ok(Arc::clone(adapter));
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
    use momo_t3::provider::registry::{
        environment_namespace, CUBESANDBOX_PROVIDER_ID, MOCK_A_PROVIDER_ID, MOCK_B_PROVIDER_ID,
    };

    fn configured_env() -> BTreeMap<String, String> {
        let namespace = environment_namespace(CUBESANDBOX_PROVIDER_ID);
        BTreeMap::from([
            (
                format!("{namespace}_API_BASE_URL"),
                "http://cube.invalid:3000".to_string(),
            ),
            (
                format!("{namespace}_API_KEY"),
                "operator-issued-key".to_string(),
            ),
        ])
    }

    #[test]
    fn byoc_resolves_to_the_degenerate_adapter() {
        let resolver = RegistryAdapterResolver::default();
        let adapter = resolver
            .adapter_for(BYOC_PROVIDER_ID)
            .expect("byoc is served");
        assert!(!adapter
            .capabilities()
            .supports(CloudProviderOperation::Create));
        assert_eq!(adapter.capabilities().provider_id, BYOC_PROVIDER_ID);
    }

    /// ADR-0156 D4-④ — the wiring #1179 named as a boundary.
    ///
    /// The reconciler resolves the managed substrate the API provisioned
    /// against, so pause/resume/destroy/probe reach the same host the create
    /// went to. Without this, every managed intent would sit `Unwired` forever
    /// and a paid instance could be paused in the ledger and running on the box.
    #[test]
    fn a_configured_managed_provider_resolves_to_its_own_adapter() {
        let resolver = RegistryAdapterResolver::from_env(&configured_env());
        let adapter = resolver
            .adapter_for(CUBESANDBOX_PROVIDER_ID)
            .expect("a configured managed substrate is served");
        assert_eq!(
            adapter.capabilities().provider_id,
            CUBESANDBOX_PROVIDER_ID,
            "the adapter must answer for the row's provider, not for whatever this process \
             prefers"
        );
        for operation in [
            CloudProviderOperation::Pause,
            CloudProviderOperation::Resume,
            CloudProviderOperation::Destroy,
            CloudProviderOperation::Probe,
        ] {
            assert!(adapter.capabilities().supports(operation));
        }
        assert_eq!(
            resolver.wired_provider_ids(),
            vec![CUBESANDBOX_PROVIDER_ID],
            "only the substrate the operator configured is wired"
        );
    }

    /// The refusal that survives D4-④, with its reason moved to the environment.
    ///
    /// `mock-a`/`mock-b` are in-process substrates and can never be served here.
    /// A managed id is served only where an operator supplied an endpoint — so on
    /// a deployment that configured none, resolving it would aim the reconciler
    /// at a host nobody stood up, and the refusal is still the correct answer.
    #[test]
    fn a_managed_provider_with_no_adapter_is_refused_not_guessed() {
        let unconfigured = RegistryAdapterResolver::default();
        assert!(unconfigured.wired_provider_ids().is_empty());
        for provider_id in [
            MOCK_A_PROVIDER_ID,
            MOCK_B_PROVIDER_ID,
            CUBESANDBOX_PROVIDER_ID,
        ] {
            assert_eq!(
                unconfigured.adapter_for(provider_id).err(),
                Some(AdapterError::Unwired(provider_id.to_string())),
                "named regression: a substrate the notifier cannot ask must never be \
                 answered by an empty in-process mock (its probe would read `absent`)"
            );
        }

        // …and configuring the managed one does not make the in-process pair
        // resolvable either.
        let configured = RegistryAdapterResolver::from_env(&configured_env());
        for provider_id in [MOCK_A_PROVIDER_ID, MOCK_B_PROVIDER_ID] {
            assert_eq!(
                configured.adapter_for(provider_id).err(),
                Some(AdapterError::Unwired(provider_id.to_string()))
            );
        }
    }

    #[test]
    fn an_unregistered_provider_fails_closed() {
        for resolver in [
            RegistryAdapterResolver::default(),
            RegistryAdapterResolver::from_env(&configured_env()),
        ] {
            assert_eq!(
                resolver.adapter_for("e2b").err(),
                Some(AdapterError::Unknown("e2b".to_string())),
                "named regression: wiring a managed substrate must not resurrect the retired id"
            );
        }
    }
}
