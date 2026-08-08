//! Capability declaration types. Every provider-specific fact policy code used
//! to hard-code (pause cost per GiB, continuous-runtime ceiling, concurrency
//! limit) lives here so policy never learns a provider's identity.

/// The five adapter operations, so capability refusals can name themselves
/// (`CloudProviderAdapter.swift:42-48`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudProviderOperation {
    Create,
    Pause,
    Resume,
    Destroy,
    Probe,
}

/// What survives a pause/resume round trip.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudResumeSemantics {
    /// Process and memory state are restored from a snapshot on resume.
    Memory,
    /// Only durable storage survives; the instance boots again from cold.
    ColdBoot,
}

/// Whether the provider believes an instance still exists. Three-valued on
/// purpose: `Unknown` ("could not reach the provider") must never be collapsed
/// to `Absent` (ADR-0142 D3.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudInstancePresence {
    Present,
    Absent,
    Unknown,
}

/// ADR-0142 D2 capability declaration. `provider_id` is data carried *here*, not
/// something policy branches on.
#[derive(Debug, Clone, PartialEq)]
pub struct CloudProviderCapabilities {
    pub provider_id: String,
    /// momo can create and destroy instances on this provider. `false` for BYOC:
    /// the host's lifetime belongs to its owner and momo only observes it.
    pub manages_instance_lifetime: bool,
    pub supports_pause: bool,
    pub resume_semantics: CloudResumeSemantics,
    /// Longest single uninterrupted run the provider allows, if any.
    pub continuous_runtime_limit_seconds: Option<i64>,
    /// Wall-clock cost of a pause per GiB of instance memory, if declared.
    pub pause_seconds_per_gib: Option<f64>,
    /// Provider-side ceiling on simultaneously running instances, if declared.
    pub max_concurrent_instances: Option<i64>,
}

impl CloudProviderCapabilities {
    /// Whether the provider supports an operation (`capabilities.supports` in
    /// Swift): create/destroy require lifetime management, pause/resume require
    /// pause support, probe is always available.
    pub fn supports(&self, operation: CloudProviderOperation) -> bool {
        match operation {
            CloudProviderOperation::Create | CloudProviderOperation::Destroy => {
                self.manages_instance_lifetime
            }
            CloudProviderOperation::Pause | CloudProviderOperation::Resume => self.supports_pause,
            CloudProviderOperation::Probe => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn byoc() -> CloudProviderCapabilities {
        CloudProviderCapabilities {
            provider_id: "byoc".to_string(),
            manages_instance_lifetime: false,
            supports_pause: false,
            resume_semantics: CloudResumeSemantics::ColdBoot,
            continuous_runtime_limit_seconds: None,
            pause_seconds_per_gib: None,
            max_concurrent_instances: None,
        }
    }

    #[test]
    fn byoc_cannot_manage_lifetime_but_can_probe() {
        let caps = byoc();
        assert!(!caps.supports(CloudProviderOperation::Create));
        assert!(!caps.supports(CloudProviderOperation::Destroy));
        assert!(!caps.supports(CloudProviderOperation::Pause));
        assert!(caps.supports(CloudProviderOperation::Probe));
    }

    #[test]
    fn full_managed_provider_supports_all() {
        let caps = CloudProviderCapabilities {
            provider_id: "acme".to_string(),
            manages_instance_lifetime: true,
            supports_pause: true,
            resume_semantics: CloudResumeSemantics::Memory,
            continuous_runtime_limit_seconds: Some(86_400),
            pause_seconds_per_gib: Some(0.5),
            max_concurrent_instances: Some(10),
        };
        for op in [
            CloudProviderOperation::Create,
            CloudProviderOperation::Pause,
            CloudProviderOperation::Resume,
            CloudProviderOperation::Destroy,
            CloudProviderOperation::Probe,
        ] {
            assert!(caps.supports(op), "expected support for {op:?}");
        }
    }
}
