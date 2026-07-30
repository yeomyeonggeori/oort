//! `momo-provider` — the cloud provider adapter contract (invariant #7).
//!
//! Direct port of the already-validated shared boundary in Swift
//! `services/CloudProviderKit/.../CloudProviderAdapter.swift`. Two properties
//! are load-bearing and preserved verbatim:
//!
//! * **Credentials never enter momo (ADR-0004/0144).** [`CloudInstanceSpec`]
//!   carries no provider credential; the operator key stays inside the adapter's
//!   own config and never reaches a workspace row, response, or log.
//! * **Policy code reads capabilities, never a provider identifier.** Every
//!   provider-specific number lives in [`CloudProviderCapabilities`]; the
//!   reconciler/sweep/REST layers branch on capability, not on `providerID`.
//!
//! B0 = trait + types only. Concrete adapters (HTTP/BYOC) and a mock land in B2.

pub mod adapter;
pub mod capability;

pub use adapter::{
    validated_cloud_instance_id, CloudInstanceRef, CloudInstanceSpec, CloudProviderAdapter,
    CloudProviderError,
};
pub use capability::{
    CloudInstancePresence, CloudProviderCapabilities, CloudProviderOperation, CloudResumeSemantics,
};
