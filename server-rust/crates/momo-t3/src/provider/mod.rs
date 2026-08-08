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

pub mod byoc;
pub mod cubesandbox;
pub mod mock;
pub mod registry;

pub use byoc::ByocProviderAdapter;
pub use cubesandbox::{
    create_body, presence_for_status, CubeSandboxProviderAdapter, CubeSandboxTuning,
    DEFAULT_SWEEP_SECONDS, IDLE_TIMEOUT_SWEEP_MULTIPLE, METADATA_PROVISION_KEY,
    METADATA_WORKSPACE_KEY, ON_TIMEOUT_KILL,
};
pub use mock::{MockCall, MockInstanceState, MockProviderAdapter};
pub use registry::{
    capabilities_for, cubesandbox_max_concurrent_instances, environment_keys,
    environment_namespace, is_registered, load_endpoints, load_endpoints_from_process_env,
    registered_provider_ids, T3ProviderEndpoint, BYOC_PROVIDER_ID,
    CUBESANDBOX_DEFAULT_MAX_CONCURRENT_INSTANCES, CUBESANDBOX_PAUSE_SECONDS_PER_GIB,
    CUBESANDBOX_PROVIDER_ID, FALLBACK_PROVIDER_ID, MOCK_A_PROVIDER_ID, MOCK_B_PROVIDER_ID,
};
