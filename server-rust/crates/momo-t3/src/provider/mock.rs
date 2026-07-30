//! In-process mock substrates `mock-a` / `mock-b` (ADR-0142 D3, MOMO-670).
//!
//! These are the Rust counterpart of `scripts/mock_provider.py`, which speaks
//! the same provider-neutral REST shape to the Swift HTTP adapter. Honesty is
//! the point, not realism:
//!
//! * **A paused instance refuses every call that needs it running, by name.**
//!   The first adversarial review of this area went green because a mock
//!   pretended a paused sandbox was live (ADR-0140 D5). Here a second `pause`
//!   answers [`CloudProviderError::InstancePaused`] instead of a cheerful `Ok`.
//! * **A dead instance says so.** [`MockProviderAdapter::kill_all_instances`]
//!   makes `probe` answer `Absent` and every lifecycle call answer
//!   `InstanceMissing`, which is what ADR-0140 D4 converges on as
//!   `provider_missing`. Silent failure is banned (ADR-0142 D3.1).
//! * **"I could not ask" is never "it is gone".**
//!   [`MockProviderAdapter::set_probe_unavailable`] answers
//!   [`CloudInstancePresence::Unknown`] — settling a live paid session on an
//!   outage is the failure this three-valued answer exists to prevent.
//! * **A refusal does not move the instance.** `fail_pause`/`fail_resume`/
//!   `fail_destroy` return an upstream status and leave the state alone, so a
//!   convergence a verifier observes is a convergence on the real condition.
//! * **[`MockProviderAdapter::set_dishonest_probe`] is the red lever**, not a
//!   feature: a substrate that reports `Present` after dying contradicts itself,
//!   and momo must not settle on its word.
//!
//! `mock-a` supports pause and restores memory; `mock-b` refuses pause outright
//! and cold-boots, so a cross-provider continuity proof cannot lean on either
//! one's conveniences.

use std::collections::BTreeMap;
use std::sync::Mutex;

use async_trait::async_trait;
use momo_provider::{
    validated_cloud_instance_id, CloudInstancePresence, CloudInstanceRef, CloudInstanceSpec,
    CloudProviderAdapter, CloudProviderCapabilities, CloudProviderError, CloudProviderOperation,
};

use crate::provider::registry::{capabilities_for, MOCK_A_PROVIDER_ID, MOCK_B_PROVIDER_ID};

/// What the substrate believes about one instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MockInstanceState {
    Running,
    Paused,
    /// Dead or destroyed. The substrate answers 404-equivalents from here on.
    Absent,
}

/// One recorded adapter call, for verifier inspection. Deliberately carries no
/// bootstrap token and no credential — see [`MockProviderAdapter::created_specs`]
/// for the (in-memory only) spec record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MockCall {
    pub operation: CloudProviderOperation,
    pub instance_id: Option<String>,
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum FailureMode {
    #[default]
    Healthy,
    /// Answer an upstream 503 and change nothing.
    Refuse,
}

#[derive(Debug, Default)]
struct MockState {
    instances: BTreeMap<String, MockInstanceState>,
    create_keys: BTreeMap<String, String>,
    calls: Vec<MockCall>,
    created_specs: Vec<CloudInstanceSpec>,
    pause_mode: FailureMode,
    resume_mode: FailureMode,
    destroy_mode: FailureMode,
    probe_unavailable: bool,
    dishonest_probe: bool,
}

/// A credential-free mock substrate.
#[derive(Debug)]
pub struct MockProviderAdapter {
    capabilities: CloudProviderCapabilities,
    state: Mutex<MockState>,
}

impl MockProviderAdapter {
    /// `mock-a`: manages lifetime, supports pause, resume restores memory.
    pub fn mock_a() -> Self {
        Self::with_capabilities(
            capabilities_for(MOCK_A_PROVIDER_ID).expect("mock-a is a registered provider id"),
        )
    }

    /// `mock-b`: manages lifetime, refuses pause, cold boots.
    pub fn mock_b() -> Self {
        Self::with_capabilities(
            capabilities_for(MOCK_B_PROVIDER_ID).expect("mock-b is a registered provider id"),
        )
    }

    pub fn with_capabilities(capabilities: CloudProviderCapabilities) -> Self {
        MockProviderAdapter {
            capabilities,
            state: Mutex::new(MockState::default()),
        }
    }

    // ---- controls (verifier levers) --------------------------------------

    /// Every live instance dies where it stands, and nothing tells momo — the
    /// condition ADR-0140 D4 converges to `provider_missing`.
    pub fn kill_all_instances(&self) {
        let mut state = self.lock();
        for value in state.instances.values_mut() {
            *value = MockInstanceState::Absent;
        }
    }

    pub fn fail_pause(&self) {
        self.lock().pause_mode = FailureMode::Refuse;
    }

    pub fn fail_resume(&self) {
        self.lock().resume_mode = FailureMode::Refuse;
    }

    /// A destroy that does not happen leaves a paid instance running; ADR-0140
    /// D4 says momo keeps asking, forever.
    pub fn fail_destroy(&self) {
        self.lock().destroy_mode = FailureMode::Refuse;
    }

    /// The control plane cannot answer. `probe` must read `Unknown`.
    pub fn set_probe_unavailable(&self, unavailable: bool) {
        self.lock().probe_unavailable = unavailable;
    }

    /// The lie under test: a dead substrate reporting `Present`.
    pub fn set_dishonest_probe(&self, dishonest: bool) {
        self.lock().dishonest_probe = dishonest;
    }

    pub fn heal(&self) {
        let mut state = self.lock();
        state.pause_mode = FailureMode::Healthy;
        state.resume_mode = FailureMode::Healthy;
        state.destroy_mode = FailureMode::Healthy;
        state.probe_unavailable = false;
    }

    // ---- inspection ------------------------------------------------------

    pub fn instance_state(&self, instance_id: &str) -> Option<MockInstanceState> {
        self.lock().instances.get(instance_id).copied()
    }

    pub fn calls(&self) -> Vec<MockCall> {
        self.lock().calls.clone()
    }

    /// The specs this substrate was asked to create. Held in memory for the
    /// verifier and never logged: a spec carries a one-shot workd registration
    /// token, whose digest alone is allowed to reach PostgreSQL (045 header).
    pub fn created_specs(&self) -> Vec<CloudInstanceSpec> {
        self.lock().created_specs.clone()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, MockState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn unsupported(&self, operation: CloudProviderOperation) -> CloudProviderError {
        CloudProviderError::Unsupported {
            operation,
            provider_id: self.capabilities.provider_id.clone(),
        }
    }
}

#[async_trait]
impl CloudProviderAdapter for MockProviderAdapter {
    fn capabilities(&self) -> &CloudProviderCapabilities {
        &self.capabilities
    }

    async fn create(
        &self,
        spec: &CloudInstanceSpec,
        idempotency_key: &str,
    ) -> Result<CloudInstanceRef, CloudProviderError> {
        if !self.capabilities.supports(CloudProviderOperation::Create) {
            return Err(self.unsupported(CloudProviderOperation::Create));
        }
        let mut state = self.lock();
        // Same key -> same instance, so a lost create response cannot bill twice.
        let instance_id = match state.create_keys.get(idempotency_key) {
            Some(existing) => existing.clone(),
            None => {
                let next = format!(
                    "{}-{}",
                    self.capabilities.provider_id,
                    state.create_keys.len() + 1
                );
                state
                    .create_keys
                    .insert(idempotency_key.to_string(), next.clone());
                state
                    .instances
                    .insert(next.clone(), MockInstanceState::Running);
                next
            }
        };
        state.created_specs.push(spec.clone());
        state.calls.push(MockCall {
            operation: CloudProviderOperation::Create,
            instance_id: Some(instance_id.clone()),
            idempotency_key: Some(idempotency_key.to_string()),
        });
        drop(state);

        Ok(CloudInstanceRef {
            provider_id: self.capabilities.provider_id.clone(),
            instance_id: validated_cloud_instance_id(&instance_id)?.to_string(),
        })
    }

    async fn pause(
        &self,
        instance: &CloudInstanceRef,
        idempotency_key: &str,
    ) -> Result<(), CloudProviderError> {
        if !self.capabilities.supports(CloudProviderOperation::Pause) {
            // Declared unsupported in the registry. Say so instead of no-op'ing
            // a success that would let the ledger bill a running instance as
            // paused.
            return Err(self.unsupported(CloudProviderOperation::Pause));
        }
        let mut state = self.lock();
        state.calls.push(MockCall {
            operation: CloudProviderOperation::Pause,
            instance_id: Some(instance.instance_id.clone()),
            idempotency_key: Some(idempotency_key.to_string()),
        });
        if state.pause_mode == FailureMode::Refuse {
            return Err(CloudProviderError::UpstreamStatus(503));
        }
        match state.instances.get(&instance.instance_id).copied() {
            None | Some(MockInstanceState::Absent) => Err(CloudProviderError::InstanceMissing),
            Some(MockInstanceState::Paused) => Err(CloudProviderError::InstancePaused),
            Some(MockInstanceState::Running) => {
                state
                    .instances
                    .insert(instance.instance_id.clone(), MockInstanceState::Paused);
                Ok(())
            }
        }
    }

    async fn resume(
        &self,
        instance: &CloudInstanceRef,
        idempotency_key: &str,
    ) -> Result<(), CloudProviderError> {
        if !self.capabilities.supports(CloudProviderOperation::Resume) {
            return Err(self.unsupported(CloudProviderOperation::Resume));
        }
        let mut state = self.lock();
        state.calls.push(MockCall {
            operation: CloudProviderOperation::Resume,
            instance_id: Some(instance.instance_id.clone()),
            idempotency_key: Some(idempotency_key.to_string()),
        });
        if state.resume_mode == FailureMode::Refuse {
            return Err(CloudProviderError::UpstreamStatus(503));
        }
        match state.instances.get(&instance.instance_id).copied() {
            None | Some(MockInstanceState::Absent) => Err(CloudProviderError::InstanceMissing),
            Some(_) => {
                state
                    .instances
                    .insert(instance.instance_id.clone(), MockInstanceState::Running);
                Ok(())
            }
        }
    }

    async fn destroy(
        &self,
        instance: &CloudInstanceRef,
        idempotency_key: &str,
    ) -> Result<(), CloudProviderError> {
        if !self.capabilities.supports(CloudProviderOperation::Destroy) {
            return Err(self.unsupported(CloudProviderOperation::Destroy));
        }
        let mut state = self.lock();
        state.calls.push(MockCall {
            operation: CloudProviderOperation::Destroy,
            instance_id: Some(instance.instance_id.clone()),
            idempotency_key: Some(idempotency_key.to_string()),
        });
        if state.destroy_mode == FailureMode::Refuse {
            return Err(CloudProviderError::UpstreamStatus(503));
        }
        // An instance the substrate never knew already satisfies the intent.
        state
            .instances
            .insert(instance.instance_id.clone(), MockInstanceState::Absent);
        Ok(())
    }

    async fn probe(
        &self,
        instance: &CloudInstanceRef,
    ) -> Result<CloudInstancePresence, CloudProviderError> {
        let mut state = self.lock();
        state.calls.push(MockCall {
            operation: CloudProviderOperation::Probe,
            instance_id: Some(instance.instance_id.clone()),
            idempotency_key: None,
        });
        if state.probe_unavailable {
            // "I could not ask" — the third value. Answering `Absent` here would
            // let momo settle a live paid session on an outage.
            return Ok(CloudInstancePresence::Unknown);
        }
        Ok(match state.instances.get(&instance.instance_id).copied() {
            Some(MockInstanceState::Running) | Some(MockInstanceState::Paused) => {
                CloudInstancePresence::Present
            }
            Some(MockInstanceState::Absent) if state.dishonest_probe => {
                CloudInstancePresence::Present
            }
            Some(MockInstanceState::Absent) | None => CloudInstancePresence::Absent,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn spec() -> CloudInstanceSpec {
        CloudInstanceSpec {
            provision_id: Uuid::new_v4(),
            workspace_id: Uuid::new_v4(),
            display_name: "verifier".to_string(),
            registration_token: "one-shot-workd-token".to_string(),
            server_url: "https://momo.invalid".to_string(),
        }
    }

    #[tokio::test]
    async fn mock_a_runs_a_full_honest_lifecycle() {
        let adapter = MockProviderAdapter::mock_a();
        let instance = adapter.create(&spec(), "prov-1").await.expect("create");
        assert_eq!(instance.provider_id, MOCK_A_PROVIDER_ID);
        assert_eq!(
            adapter.probe(&instance).await.unwrap(),
            CloudInstancePresence::Present
        );

        adapter.pause(&instance, "op-1").await.expect("pause");
        assert_eq!(
            adapter.instance_state(&instance.instance_id),
            Some(MockInstanceState::Paused)
        );

        adapter.resume(&instance, "op-2").await.expect("resume");
        assert_eq!(
            adapter.instance_state(&instance.instance_id),
            Some(MockInstanceState::Running)
        );

        adapter.destroy(&instance, "op-3").await.expect("destroy");
        adapter
            .destroy(&instance, "op-3")
            .await
            .expect("destroy is idempotent");
        assert_eq!(
            adapter.probe(&instance).await.unwrap(),
            CloudInstancePresence::Absent
        );
    }

    #[tokio::test]
    async fn create_is_idempotent_on_the_key() {
        let adapter = MockProviderAdapter::mock_a();
        let first = adapter.create(&spec(), "prov-1").await.unwrap();
        let replay = adapter.create(&spec(), "prov-1").await.unwrap();
        let other = adapter.create(&spec(), "prov-2").await.unwrap();
        assert_eq!(
            first.instance_id, replay.instance_id,
            "a replayed create must converge on the same instance, not a second billable one"
        );
        assert_ne!(first.instance_id, other.instance_id);
    }

    #[tokio::test]
    async fn a_paused_instance_refuses_by_name() {
        let adapter = MockProviderAdapter::mock_a();
        let instance = adapter.create(&spec(), "prov-1").await.unwrap();
        adapter.pause(&instance, "op-1").await.unwrap();

        // ADR-0140 D5: the mock must not answer success for work it did not do.
        assert!(
            matches!(
                adapter.pause(&instance, "op-2").await,
                Err(CloudProviderError::InstancePaused)
            ),
            "a paused instance must refuse a second pause instead of pretending"
        );
        assert_eq!(
            adapter.instance_state(&instance.instance_id),
            Some(MockInstanceState::Paused),
            "a refusal must not move the instance"
        );
    }

    #[tokio::test]
    async fn mock_b_declares_no_pause_and_refuses_it() {
        let adapter = MockProviderAdapter::mock_b();
        let instance = adapter.create(&spec(), "prov-1").await.unwrap();
        assert!(matches!(
            adapter.pause(&instance, "op-1").await,
            Err(CloudProviderError::Unsupported {
                operation: CloudProviderOperation::Pause,
                ..
            })
        ));
        assert!(matches!(
            adapter.resume(&instance, "op-1").await,
            Err(CloudProviderError::Unsupported {
                operation: CloudProviderOperation::Resume,
                ..
            })
        ));
        assert_eq!(
            adapter.instance_state(&instance.instance_id),
            Some(MockInstanceState::Running),
            "an unsupported pause must leave the instance exactly as it was"
        );
    }

    #[tokio::test]
    async fn a_dead_instance_is_reported_honestly() {
        let adapter = MockProviderAdapter::mock_a();
        let instance = adapter.create(&spec(), "prov-1").await.unwrap();
        adapter.kill_all_instances();

        assert_eq!(
            adapter.probe(&instance).await.unwrap(),
            CloudInstancePresence::Absent,
            "a dead substrate must say so — silent failure is banned (ADR-0142 D3.1)"
        );
        assert!(matches!(
            adapter.pause(&instance, "op-1").await,
            Err(CloudProviderError::InstanceMissing)
        ));
        assert!(matches!(
            adapter.resume(&instance, "op-1").await,
            Err(CloudProviderError::InstanceMissing)
        ));
    }

    #[tokio::test]
    async fn an_unreachable_control_plane_is_unknown_not_absent() {
        let adapter = MockProviderAdapter::mock_a();
        let instance = adapter.create(&spec(), "prov-1").await.unwrap();
        adapter.set_probe_unavailable(true);
        assert_eq!(
            adapter.probe(&instance).await.unwrap(),
            CloudInstancePresence::Unknown,
            "`could not ask` must never collapse to `it is gone`"
        );
    }

    #[tokio::test]
    async fn refusals_do_not_move_the_instance() {
        let adapter = MockProviderAdapter::mock_a();
        let instance = adapter.create(&spec(), "prov-1").await.unwrap();

        adapter.fail_pause();
        assert!(matches!(
            adapter.pause(&instance, "op-1").await,
            Err(CloudProviderError::UpstreamStatus(503))
        ));
        assert_eq!(
            adapter.instance_state(&instance.instance_id),
            Some(MockInstanceState::Running),
            "a refused pause must leave a running instance running (it is still billing)"
        );

        adapter.fail_destroy();
        assert!(matches!(
            adapter.destroy(&instance, "op-2").await,
            Err(CloudProviderError::UpstreamStatus(503))
        ));
        assert_eq!(
            adapter.instance_state(&instance.instance_id),
            Some(MockInstanceState::Running),
            "a destroy that did not happen must leave the paid instance visible"
        );

        adapter.heal();
        adapter
            .pause(&instance, "op-3")
            .await
            .expect("healed pause");
    }

    #[tokio::test]
    async fn the_dishonest_probe_lever_is_available_for_the_red_proof() {
        let adapter = MockProviderAdapter::mock_a();
        let instance = adapter.create(&spec(), "prov-1").await.unwrap();
        adapter.kill_all_instances();
        adapter.set_dishonest_probe(true);
        assert_eq!(
            adapter.probe(&instance).await.unwrap(),
            CloudInstancePresence::Present,
            "the lever must be able to produce a self-contradicting substrate"
        );
    }

    #[tokio::test]
    async fn recorded_calls_carry_no_bootstrap_token() {
        let adapter = MockProviderAdapter::mock_a();
        let spec = spec();
        let instance = adapter.create(&spec, "prov-1").await.unwrap();
        adapter.pause(&instance, "op-1").await.unwrap();
        let rendered = format!("{:?}", adapter.calls());
        assert!(
            !rendered.contains(&spec.registration_token),
            "the call log must not carry one-shot registration material: {rendered}"
        );
    }
}
