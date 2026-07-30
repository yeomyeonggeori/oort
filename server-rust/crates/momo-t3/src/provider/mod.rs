//! T3 provider adapters and the registry that owns every provider-specific fact
//! (ADR-0142).
//!
//! The trait itself lives in `momo-provider` (B0). This module supplies the
//! concrete adapters B2.1 needs: the degenerate BYOC base form and the two
//! verification substrates whose disagreement about pause is what makes the
//! continuity contract provable.

pub mod byoc;
pub mod mock;
pub mod registry;

pub use byoc::ByocProviderAdapter;
pub use mock::{MockCall, MockInstanceState, MockProviderAdapter};
pub use registry::{
    capabilities_for, environment_keys, environment_namespace, is_registered, load_endpoints,
    load_endpoints_from_process_env, registered_provider_ids, T3ProviderEndpoint, BYOC_PROVIDER_ID,
    FALLBACK_PROVIDER_ID, MOCK_A_PROVIDER_ID, MOCK_B_PROVIDER_ID,
};
