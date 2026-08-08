//! T3 provider adapters and the registry that owns every provider-specific fact
//! (ADR-0142).
//!
//! The trait itself lives in `momo-provider` (B0). This module supplies the
//! concrete adapters B2.1 needs: the degenerate BYOC base form and the two
//! verification substrates whose disagreement about pause is what makes the
//! continuity contract provable.
//!
//! ADR-0156 D4-③ adds the first **managed** one — [`cubesandbox`], a self-hosted
//! substrate momo really can create and destroy instances on.
//!
//! ## The two factories (ADR-0156 D4-④)
//!
//! [`managed_adapters_from_env`] and [`provisioner_from_env`] are the **only**
//! places in the workspace where a registry id is turned into a live adapter, and
//! they live inside `provider/` for the reason that directory exists: the match
//! arm below names a substrate, and ADR-0142 D2 allows exactly this module and
//! the registry to do so. Every consumer — the notifier's resolver, the
//! provisioning route — receives `Arc<dyn CloudProviderAdapter>` or a
//! [`crate::provision::CloudProvisioner`] and can name nothing.
//!
//! Both are **fail-closed by absence**: an id with no HTTP implementation, or one
//! whose operator supplied no endpoint, simply is not in the result. There is no
//! fallback adapter, because both possible fallbacks are catastrophic — a
//! degenerate one would refuse every reconciliation of a live paid host, and a
//! fresh in-process mock would answer `Absent` for instances it never saw and
//! settle them (ADR-0142 D3.1).

use std::collections::BTreeMap;
use std::sync::Arc;

use momo_provider::CloudProviderAdapter;

use crate::provision::{BootstrapDerivationSecret, CloudProvisioner};

pub mod byoc;
pub mod cubesandbox;
pub mod mock;
pub mod registry;

pub use byoc::ByocProviderAdapter;
pub use cubesandbox::{
    create_body, momo_metadata, presence_for_status, refusal_needs_reprobe,
    CubeSandboxProviderAdapter, CubeSandboxTuning, DEFAULT_RENEWAL_SECONDS,
    LEASE_RENEWALS_PER_LEASE, METADATA_KEY_PREFIX, METADATA_PROVISION_KEY, METADATA_WORKSPACE_KEY,
    ON_TIMEOUT_KILL,
};
pub use mock::{MockCall, MockInstanceState, MockProviderAdapter};
pub use registry::{
    capabilities_for, cubesandbox_max_concurrent_instances, environment_keys,
    environment_namespace, is_registered, load_endpoints, load_endpoints_from_process_env,
    registered_provider_ids, T3ProviderEndpoint, BYOC_PROVIDER_ID,
    CUBESANDBOX_DEFAULT_LEASE_SECONDS, CUBESANDBOX_DEFAULT_MAX_CONCURRENT_INSTANCES,
    CUBESANDBOX_PAUSE_SECONDS_PER_GIB, CUBESANDBOX_PROVIDER_ID, FALLBACK_PROVIDER_ID,
    MOCK_A_PROVIDER_ID, MOCK_B_PROVIDER_ID,
};

/// The adapter for one registry id, or `None` when this build has no client for
/// it or the operator configured none.
///
/// The match arm is the entire list of substrates momo can *speak to over the
/// wire*, which is a strictly smaller set than [`registered_provider_ids`]:
///
/// * `byoc` is absent on purpose — it is degenerate, needs no configuration, and
///   is served directly by the one consumer that wants it (the notifier's
///   resolver). Putting it here would let the provisioning route acquire a
///   "managed" adapter that refuses to create.
/// * `mock-a`/`mock-b` are absent because they are **in-process** substrates. An
///   instance of either knows only the instances it was itself asked to make, so
///   handing one to a process that did not create them would answer `Absent` for
///   live paid hosts. ADR-0142 D3.1 calls that the silent failure; the refusal is
///   the safe answer.
fn wire_adapter_for(
    provider_id: &str,
    env: &BTreeMap<String, String>,
) -> Option<Arc<dyn CloudProviderAdapter>> {
    match provider_id {
        registry::CUBESANDBOX_PROVIDER_ID => cubesandbox::CubeSandboxProviderAdapter::from_env(env)
            .ok()
            .map(|adapter| Arc::new(adapter) as Arc<dyn CloudProviderAdapter>),
        _ => None,
    }
}

/// Every managed adapter this process is configured to speak to, by registry id.
pub fn managed_adapters_from_env(
    env: &BTreeMap<String, String>,
) -> BTreeMap<String, Arc<dyn CloudProviderAdapter>> {
    registry::registered_provider_ids()
        .into_iter()
        .filter_map(|provider_id| {
            Some((provider_id.to_string(), wire_adapter_for(provider_id, env)?))
        })
        .collect()
}

/// Same, over the process environment.
pub fn managed_adapters_from_process_env() -> BTreeMap<String, Arc<dyn CloudProviderAdapter>> {
    managed_adapters_from_env(&std::env::vars().collect())
}

/// The provisioner for a registry id, or `None` when that substrate cannot be
/// provisioned against from this process.
///
/// The bootstrap derivation secret is computed here — the one point in the
/// workspace that both holds an operator credential and is allowed to — and what
/// leaves is a one-way function of it (see
/// [`crate::provision::BootstrapDerivationSecret`]). The endpoint itself does
/// not escape.
pub fn provisioner_from_env(
    provider_id: &str,
    env: &BTreeMap<String, String>,
) -> Option<CloudProvisioner> {
    let adapter = wire_adapter_for(provider_id, env)?;
    let endpoint = registry::load_endpoints(env).remove(provider_id)?;
    Some(CloudProvisioner::new(
        provider_id,
        adapter,
        BootstrapDerivationSecret::from_operator_credential(endpoint.api_key()),
    ))
}

/// Same, over the process environment (`MOMO_T3_PROVIDER_*` only; opens no file).
pub fn provisioner_from_process_env(provider_id: &str) -> Option<CloudProvisioner> {
    provisioner_from_env(provider_id, &std::env::vars().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use momo_provider::CloudProviderOperation;

    fn configured_env() -> BTreeMap<String, String> {
        BTreeMap::from([
            (
                "MOMO_T3_PROVIDER_CUBESANDBOX_API_BASE_URL".to_string(),
                "http://cube.invalid:3000".to_string(),
            ),
            (
                "MOMO_T3_PROVIDER_CUBESANDBOX_API_KEY".to_string(),
                "operator-issued-key".to_string(),
            ),
            (
                "MOMO_T3_PROVIDER_CUBESANDBOX_IMAGE_REF".to_string(),
                "tpl-oort-workd".to_string(),
            ),
        ])
    }

    /// A configured managed substrate produces an adapter; an unconfigured one
    /// produces nothing at all (ADR-0142 D4 fail-closed).
    #[test]
    fn only_a_configured_substrate_becomes_an_adapter() {
        let built = managed_adapters_from_env(&configured_env());
        assert!(built.contains_key(CUBESANDBOX_PROVIDER_ID));
        assert!(
            managed_adapters_from_env(&BTreeMap::new()).is_empty(),
            "an operator who configured nothing must get no adapter, not a guessed one"
        );
    }

    /// The in-process substrates and the degenerate one are **not** managed
    /// adapters, and that absence is the contract.
    #[test]
    fn the_factory_never_hands_out_an_in_process_or_degenerate_substrate() {
        let mut env = configured_env();
        // Even if an operator writes endpoints for them, there is no client.
        for provider_id in [BYOC_PROVIDER_ID, MOCK_A_PROVIDER_ID, MOCK_B_PROVIDER_ID] {
            let namespace = environment_namespace(provider_id);
            env.insert(format!("{namespace}_API_BASE_URL"), "http://x".to_string());
            env.insert(format!("{namespace}_API_KEY"), "k".to_string());
        }
        let built = managed_adapters_from_env(&env);
        assert_eq!(
            built.keys().collect::<Vec<_>>(),
            vec![CUBESANDBOX_PROVIDER_ID],
            "named regression: a fresh in-process mock knows no instances, so every probe would \
             answer `absent` and ADR-0140 D4 would settle live paid sessions (ADR-0142 D3.1)"
        );
        assert!(provisioner_from_env(BYOC_PROVIDER_ID, &env).is_none());
        assert!(provisioner_from_env(MOCK_A_PROVIDER_ID, &env).is_none());
    }

    #[test]
    fn a_provisioner_reports_capabilities_and_never_its_endpoint() {
        let provisioner =
            provisioner_from_env(CUBESANDBOX_PROVIDER_ID, &configured_env()).expect("configured");
        assert_eq!(provisioner.provider_id(), CUBESANDBOX_PROVIDER_ID);
        assert!(provisioner
            .capabilities()
            .supports(CloudProviderOperation::Create));

        let rendered = format!("{provisioner:?}");
        assert!(
            !rendered.contains("operator-issued-key") && !rendered.contains("cube.invalid"),
            "a provisioner must not render the operator's endpoint or key: {rendered}"
        );
    }

    /// A retired id resolves to nothing here as well as in the registry.
    #[test]
    fn a_retired_provider_id_produces_no_adapter() {
        assert!(provisioner_from_env("e2b", &configured_env()).is_none());
        assert!(!managed_adapters_from_env(&configured_env()).contains_key("e2b"));
    }
}
