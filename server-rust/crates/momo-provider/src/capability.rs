//! Capability declaration types. Every provider-specific fact policy code used
//! to hard-code (pause cost per GiB, continuous-runtime ceiling, concurrency
//! limit) lives here so policy never learns a provider's identity.

/// The adapter operations, so capability refusals can name themselves
/// (`CloudProviderAdapter.swift:42-48`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudProviderOperation {
    Create,
    Pause,
    Resume,
    Destroy,
    Probe,
    /// Push out the instance's expiry. Only substrates that declare
    /// [`CloudProviderCapabilities::instance_lease_seconds`] have one.
    RenewLease,
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
    /// **How long an instance survives without being renewed**, if this
    /// substrate expires instances at all.
    ///
    /// `None` — the default and the shape every substrate before CubeSandbox
    /// had — means an instance lives until momo destroys it.
    ///
    /// `Some(n)` is a promise in *both* directions and neither half is
    /// optional:
    ///
    /// * the substrate will delete the instance `n` seconds after its lease was
    ///   last set, whatever the instance is doing;
    /// * momo must therefore call [`CloudProviderOperation::RenewLease`] more
    ///   often than that, or its own healthy sessions die on the substrate's
    ///   clock.
    ///
    /// It is expressed as a capability rather than adapter-local knowledge for
    /// exactly the ADR-0142 D2 reason: the renewal loop has to know *that* a
    /// deadline exists and *how soon* without being allowed to know which
    /// substrate has one.
    pub instance_lease_seconds: Option<i64>,
}

impl CloudProviderCapabilities {
    /// Whether the provider supports an operation (`capabilities.supports` in
    /// Swift): create/destroy require lifetime management, pause/resume require
    /// pause support, probe is always available, and renewal exists only where a
    /// lease does.
    pub fn supports(&self, operation: CloudProviderOperation) -> bool {
        match operation {
            CloudProviderOperation::Create | CloudProviderOperation::Destroy => {
                self.manages_instance_lifetime
            }
            CloudProviderOperation::Pause | CloudProviderOperation::Resume => self.supports_pause,
            CloudProviderOperation::Probe => true,
            CloudProviderOperation::RenewLease => self.instance_lease_seconds.is_some(),
        }
    }

    /// How often the lease must be renewed, or `None` when there is no lease.
    ///
    /// A quarter of the lease, so **four consecutive renewal failures** are
    /// survivable before the substrate reaps a live instance. That multiple is
    /// ADR-0156 D6②'s "×4", re-read on the D4-② measurement: the thing being
    /// multiplied is the renewal period, because `timeout` turned out to be an
    /// absolute TTL from creation that no amount of ordinary traffic resets
    /// (`research/2026-08-09-cubesandbox-d42-spike.md` §4).
    pub fn lease_renewal_period_seconds(&self) -> Option<i64> {
        self.instance_lease_seconds.map(|lease| (lease / 4).max(1))
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
            instance_lease_seconds: None,
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
            instance_lease_seconds: Some(360),
        };
        for op in [
            CloudProviderOperation::Create,
            CloudProviderOperation::Pause,
            CloudProviderOperation::Resume,
            CloudProviderOperation::Destroy,
            CloudProviderOperation::Probe,
            CloudProviderOperation::RenewLease,
        ] {
            assert!(caps.supports(op), "expected support for {op:?}");
        }
    }

    /// A substrate with no lease must never be asked to renew one — and the
    /// renewal loop reads exactly this, never a provider id.
    #[test]
    fn renewal_exists_only_where_a_lease_does() {
        let caps = byoc();
        assert!(!caps.supports(CloudProviderOperation::RenewLease));
        assert_eq!(caps.lease_renewal_period_seconds(), None);
    }

    /// ADR-0156 D6② re-read on the D4-② measurement: four renewal periods to a
    /// lease, so four consecutive failures are survivable.
    #[test]
    fn the_renewal_period_leaves_four_attempts_inside_one_lease() {
        let mut caps = byoc();
        caps.instance_lease_seconds = Some(360);
        assert_eq!(caps.lease_renewal_period_seconds(), Some(90));
        assert!(
            caps.lease_renewal_period_seconds().unwrap() * 4
                <= caps.instance_lease_seconds.unwrap(),
            "named regression: a renewal period that does not divide four times into the lease \
             gives a live instance fewer than four chances to survive a flaky substrate"
        );
        // Never zero: a zero period would make the renewal loop spin.
        caps.instance_lease_seconds = Some(1);
        assert_eq!(caps.lease_renewal_period_seconds(), Some(1));
    }
}
