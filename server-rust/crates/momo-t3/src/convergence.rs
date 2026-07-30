//! ADR-0140 D4's **convergence table**, as code every T3 process compiles.
//!
//! Before T-4 the answer to "what happens when a provider call does not
//! succeed" was written once per call site, and the call sites disagreed. The
//! rules below are the ADR's table verbatim; the reconciliation worker and the
//! REST confirm path decide nothing on their own, so the two cannot drift into
//! two different meanings of the same intermediate state.
//!
//! Direct port of Swift `CloudProviderKit/CloudLifecycleConvergence.swift`
//! (`afterProviderCall` :82-93, `afterDeadline` :98-119), whose unit suite
//! (`CloudLifecycleConvergenceTests.swift`) is ported cell-for-cell below.
//!
//! **This is not a copy of the transition table.** `work_cloud_host_transition`
//! (053:31-44 + 057:137-140) decides whether a state change is *legal*; nothing
//! here consults or restates it. [`CloudLifecyclePhase::confirmed_state`] /
//! [`CloudLifecyclePhase::revert_state`] name where a *converged operation*
//! wants to go, and the trigger still judges the resulting `UPDATE` — reverting
//! 057:137-140 makes the revert path fail loudly rather than silently disagree.

use momo_provider::{CloudInstancePresence, CloudProviderError, CloudProviderOperation};

use crate::lifecycle::CloudHostState;

/// The three `work_cloud_host` states that carry a durable provider intent.
///
/// A strict subset of [`CloudHostState`]: only an intermediate state has an
/// operation in flight, and only an operation in flight can converge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudLifecyclePhase {
    Pausing,
    Resuming,
    DestroyPending,
}

impl CloudLifecyclePhase {
    pub const ALL: [CloudLifecyclePhase; 3] = [
        CloudLifecyclePhase::Pausing,
        CloudLifecyclePhase::Resuming,
        CloudLifecyclePhase::DestroyPending,
    ];

    /// `None` for a state that carries no in-flight operation.
    pub fn from_state(state: CloudHostState) -> Option<CloudLifecyclePhase> {
        Some(match state {
            CloudHostState::Pausing => CloudLifecyclePhase::Pausing,
            CloudHostState::Resuming => CloudLifecyclePhase::Resuming,
            CloudHostState::DestroyPending => CloudLifecyclePhase::DestroyPending,
            _ => return None,
        })
    }

    pub fn from_db_label(label: &str) -> Option<CloudLifecyclePhase> {
        CloudHostState::from_db_label(label).and_then(CloudLifecyclePhase::from_state)
    }

    /// The `work_cloud_host.state` this phase occupies.
    pub fn state(self) -> CloudHostState {
        match self {
            CloudLifecyclePhase::Pausing => CloudHostState::Pausing,
            CloudLifecyclePhase::Resuming => CloudHostState::Resuming,
            CloudLifecyclePhase::DestroyPending => CloudHostState::DestroyPending,
        }
    }

    pub fn as_db_label(self) -> &'static str {
        self.state().as_db_label()
    }

    /// Where a confirmed operation lands.
    pub fn confirmed_state(self) -> CloudHostState {
        match self {
            CloudLifecyclePhase::Pausing => CloudHostState::Paused,
            CloudLifecyclePhase::Resuming => CloudHostState::Running,
            CloudLifecyclePhase::DestroyPending => CloudHostState::Destroyed,
        }
    }

    /// Where an abandoned operation lands. `destroy_pending` has none on
    /// purpose: a paid instance nobody is destroying is the one outcome
    /// ADR-0140 D4 refuses to accept.
    pub fn revert_state(self) -> Option<CloudHostState> {
        Some(match self {
            CloudLifecyclePhase::Pausing => CloudHostState::Running,
            CloudLifecyclePhase::Resuming => CloudHostState::Paused,
            CloudLifecyclePhase::DestroyPending => return None,
        })
    }

    /// The adapter call this phase is waiting on.
    pub fn operation(self) -> CloudProviderOperation {
        match self {
            CloudLifecyclePhase::Pausing => CloudProviderOperation::Pause,
            CloudLifecyclePhase::Resuming => CloudProviderOperation::Resume,
            CloudLifecyclePhase::DestroyPending => CloudProviderOperation::Destroy,
        }
    }
}

/// What the reconciler must do with a claimed intent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudLifecycleConvergence {
    /// The operation happened. Advance to
    /// [`CloudLifecyclePhase::confirmed_state`].
    Confirm,
    /// It did not happen and will not. Fall back to
    /// [`CloudLifecyclePhase::revert_state`] — billing keeps following the
    /// sandbox's actual condition, not the user's intent.
    Revert,
    /// The instance is gone. `t3_terminate(reason = 'provider_missing')`.
    Terminate,
    /// Try again later with backoff (`t3_lifecycle_backoff`, 057:68). Never
    /// abandoned.
    Retry,
}

impl CloudLifecycleConvergence {
    pub fn as_label(self) -> &'static str {
        match self {
            CloudLifecycleConvergence::Confirm => "confirm",
            CloudLifecycleConvergence::Revert => "revert",
            CloudLifecycleConvergence::Terminate => "terminate",
            CloudLifecycleConvergence::Retry => "retry",
        }
    }
}

/// The adapter answered within the deadline. `error == None` is success.
///
/// A missing instance is terminal for pause as well as resume: keeping a dead
/// sandbox in `running` because the ADR's row for `pausing` says "running 복귀"
/// would bill a workspace for an instance that provably no longer exists, which
/// inverts the rule the row exists to express ("사실에 맞는 쪽"). The fact wins
/// over the fallback.
pub fn after_provider_call(
    phase: CloudLifecyclePhase,
    error: Option<&CloudProviderError>,
) -> CloudLifecycleConvergence {
    let Some(error) = error else {
        return CloudLifecycleConvergence::Confirm;
    };
    // The single intent that never gives up: a leaked paid instance costs money
    // for as long as it exists, so there is no failure mode where stopping is
    // better than retrying (ADR-0140 D4).
    if phase == CloudLifecyclePhase::DestroyPending {
        return CloudLifecycleConvergence::Retry;
    }
    if matches!(error, CloudProviderError::InstanceMissing) {
        return CloudLifecycleConvergence::Terminate;
    }
    CloudLifecycleConvergence::Revert
}

/// The deadline (`lifecycle_operation_deadline_at`, 057:37-40) passed. The
/// provider, not the clock, decides what is true — and `Unknown` is never read
/// as `Absent` (ADR-0142 D3.1), so an unreachable provider falls back to the
/// phase's own abandonment rule.
pub fn after_deadline(
    phase: CloudLifecyclePhase,
    presence: CloudInstancePresence,
) -> CloudLifecycleConvergence {
    match presence {
        // For a destroy, absence *is* the goal.
        CloudInstancePresence::Absent => {
            if phase == CloudLifecyclePhase::DestroyPending {
                CloudLifecycleConvergence::Confirm
            } else {
                CloudLifecycleConvergence::Terminate
            }
        }
        CloudInstancePresence::Present => match phase {
            CloudLifecyclePhase::DestroyPending => CloudLifecycleConvergence::Retry,
            // Presence proves the instance is alive but not whether it is
            // paused, so pause stays with the billable reading.
            CloudLifecyclePhase::Pausing => CloudLifecycleConvergence::Revert,
            // A resume that was asked for and an instance that now answers is
            // the operation having succeeded, late.
            CloudLifecyclePhase::Resuming => CloudLifecycleConvergence::Confirm,
        },
        CloudInstancePresence::Unknown => {
            if phase == CloudLifecyclePhase::DestroyPending {
                CloudLifecycleConvergence::Retry
            } else {
                CloudLifecycleConvergence::Revert
            }
        }
    }
}

/// ADR-0142 D3.1 — the last gate before a paid session is terminally settled.
///
/// A substrate that answers `Present` for an instance it just refused to act on
/// contradicts itself, and momo refuses to convert that contradiction into a
/// settlement. `true` here means: do **not** apply the terminate; leave the
/// durable intent claimable and name the contradiction in the log. Retrying is
/// the only move that can neither silently bill nor silently strand the session.
///
/// Ports Swift `CloudLifecycleReconciler.swift:223-238`.
pub fn provider_denies_its_own_absence(
    convergence: CloudLifecycleConvergence,
    probe: CloudInstancePresence,
) -> bool {
    convergence == CloudLifecycleConvergence::Terminate && probe == CloudInstancePresence::Present
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cell-for-cell port of `CloudLifecycleConvergenceTests.swift:9-16`.
    #[test]
    fn success_confirms_every_phase() {
        for phase in CloudLifecyclePhase::ALL {
            assert_eq!(
                after_provider_call(phase, None),
                CloudLifecycleConvergence::Confirm
            );
        }
    }

    /// "pausing 실패/타임아웃 → running 복귀. 과금 계속." Reverting is what keeps
    /// billing running: the active interval was never closed.
    #[test]
    fn failed_pause_falls_back_to_the_billable_reading() {
        for error in [
            CloudProviderError::RequestFailed,
            CloudProviderError::UpstreamStatus(503),
            CloudProviderError::InvalidResponse,
            CloudProviderError::InstancePaused,
        ] {
            assert_eq!(
                after_provider_call(CloudLifecyclePhase::Pausing, Some(&error)),
                CloudLifecycleConvergence::Revert,
                "named regression: a failed pause must return to running"
            );
        }
        assert_eq!(
            CloudLifecyclePhase::Pausing.revert_state(),
            Some(CloudHostState::Running)
        );
    }

    /// "resuming 실패/타임아웃 → paused 복귀. interval 안 엶."
    #[test]
    fn failed_resume_returns_to_paused_and_opens_nothing() {
        for error in [
            CloudProviderError::RequestFailed,
            CloudProviderError::UpstreamStatus(500),
            CloudProviderError::Unsupported {
                operation: CloudProviderOperation::Resume,
                provider_id: "byoc".to_string(),
            },
        ] {
            assert_eq!(
                after_provider_call(CloudLifecyclePhase::Resuming, Some(&error)),
                CloudLifecycleConvergence::Revert
            );
        }
        assert_eq!(
            CloudLifecyclePhase::Resuming.revert_state(),
            Some(CloudHostState::Paused)
        );
    }

    /// "resuming + provider 404/410 → t3_terminate('provider_missing')".
    #[test]
    fn a_provenly_missing_instance_is_terminal() {
        assert_eq!(
            after_provider_call(
                CloudLifecyclePhase::Resuming,
                Some(&CloudProviderError::InstanceMissing)
            ),
            CloudLifecycleConvergence::Terminate
        );
        // A dead sandbox is a fact whichever operation found it.
        assert_eq!(
            after_provider_call(
                CloudLifecyclePhase::Pausing,
                Some(&CloudProviderError::InstanceMissing)
            ),
            CloudLifecycleConvergence::Terminate
        );
    }

    /// "destroy_pending 실패 → 무한 재시도". The one intent with no give-up.
    #[test]
    fn destroy_never_abandons() {
        for error in [
            CloudProviderError::RequestFailed,
            CloudProviderError::UpstreamStatus(500),
            CloudProviderError::InstanceMissing,
            CloudProviderError::InstancePaused,
            CloudProviderError::InvalidResponse,
            CloudProviderError::Unsupported {
                operation: CloudProviderOperation::Destroy,
                provider_id: "byoc".to_string(),
            },
        ] {
            assert_eq!(
                after_provider_call(CloudLifecyclePhase::DestroyPending, Some(&error)),
                CloudLifecycleConvergence::Retry,
                "named regression: destroy must never be abandoned"
            );
        }
        assert_eq!(CloudLifecyclePhase::DestroyPending.revert_state(), None);
    }

    /// "intent deadline 초과 → provider에 상태 조회해 사실 판정."
    #[test]
    fn deadline_converges_on_the_probed_fact() {
        assert_eq!(
            after_deadline(CloudLifecyclePhase::Resuming, CloudInstancePresence::Absent),
            CloudLifecycleConvergence::Terminate
        );
        assert_eq!(
            after_deadline(CloudLifecyclePhase::Pausing, CloudInstancePresence::Absent),
            CloudLifecycleConvergence::Terminate
        );
        // Absence is exactly what a destroy was asking for.
        assert_eq!(
            after_deadline(
                CloudLifecyclePhase::DestroyPending,
                CloudInstancePresence::Absent
            ),
            CloudLifecycleConvergence::Confirm
        );
        // A live instance that was asked to resume has resumed, late.
        assert_eq!(
            after_deadline(
                CloudLifecyclePhase::Resuming,
                CloudInstancePresence::Present
            ),
            CloudLifecycleConvergence::Confirm
        );
        // Presence does not distinguish paused from running, so pause keeps the
        // billable reading rather than guessing in the user's favour.
        assert_eq!(
            after_deadline(CloudLifecyclePhase::Pausing, CloudInstancePresence::Present),
            CloudLifecycleConvergence::Revert
        );
        assert_eq!(
            after_deadline(
                CloudLifecyclePhase::DestroyPending,
                CloudInstancePresence::Present
            ),
            CloudLifecycleConvergence::Retry
        );
    }

    /// "조회 불가면 위 규칙 적용" — and ADR-0142 D3.1: `Unknown` is never read as
    /// `Absent`, so an unreachable provider can never settle a paid session.
    #[test]
    fn unreachable_provider_never_settles() {
        for phase in CloudLifecyclePhase::ALL {
            assert_ne!(
                after_deadline(phase, CloudInstancePresence::Unknown),
                CloudLifecycleConvergence::Terminate,
                "named regression: unknown must not be read as absent"
            );
        }
        assert_eq!(
            after_deadline(CloudLifecyclePhase::Pausing, CloudInstancePresence::Unknown),
            CloudLifecycleConvergence::Revert
        );
        assert_eq!(
            after_deadline(
                CloudLifecyclePhase::Resuming,
                CloudInstancePresence::Unknown
            ),
            CloudLifecycleConvergence::Revert
        );
        assert_eq!(
            after_deadline(
                CloudLifecyclePhase::DestroyPending,
                CloudInstancePresence::Unknown
            ),
            CloudLifecycleConvergence::Retry
        );
    }

    #[test]
    fn confirmed_states_match_the_transition_table() {
        assert_eq!(
            CloudLifecyclePhase::Pausing.confirmed_state(),
            CloudHostState::Paused
        );
        assert_eq!(
            CloudLifecyclePhase::Resuming.confirmed_state(),
            CloudHostState::Running
        );
        assert_eq!(
            CloudLifecyclePhase::DestroyPending.confirmed_state(),
            CloudHostState::Destroyed
        );
        assert_eq!(
            CloudLifecyclePhase::Pausing.operation(),
            CloudProviderOperation::Pause
        );
        assert_eq!(
            CloudLifecyclePhase::Resuming.operation(),
            CloudProviderOperation::Resume
        );
        assert_eq!(
            CloudLifecyclePhase::DestroyPending.operation(),
            CloudProviderOperation::Destroy
        );
    }

    #[test]
    fn only_intermediate_states_carry_a_phase() {
        for state in [
            CloudHostState::Provisioning,
            CloudHostState::Ready,
            CloudHostState::Running,
            CloudHostState::Paused,
            CloudHostState::Destroyed,
            CloudHostState::Failed,
        ] {
            assert_eq!(
                CloudLifecyclePhase::from_state(state),
                None,
                "{} carries no in-flight provider operation",
                state.as_db_label()
            );
        }
        for phase in CloudLifecyclePhase::ALL {
            assert_eq!(
                CloudLifecyclePhase::from_db_label(phase.as_db_label()),
                Some(phase)
            );
        }
    }

    /// The red lever of conformance #1: a substrate that hides a death must not
    /// be able to produce a settlement.
    #[test]
    fn a_self_contradicting_substrate_blocks_the_settlement() {
        assert!(
            provider_denies_its_own_absence(
                CloudLifecycleConvergence::Terminate,
                CloudInstancePresence::Present
            ),
            "named regression: a provider that denies its own missing instance must not settle"
        );
        for probe in [
            CloudInstancePresence::Absent,
            CloudInstancePresence::Unknown,
        ] {
            assert!(!provider_denies_its_own_absence(
                CloudLifecycleConvergence::Terminate,
                probe
            ));
        }
        // Nothing but a terminate is gated on the probe.
        assert!(!provider_denies_its_own_absence(
            CloudLifecycleConvergence::Confirm,
            CloudInstancePresence::Present
        ));
    }
}
