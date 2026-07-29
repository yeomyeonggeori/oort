import Foundation

/// ADR-0140 D4 — the convergence table, as code both processes compile.
///
/// Before T-4 the answer to "what happens when a provider call does not
/// succeed" was written once per call site, and the call sites disagreed. The
/// rules below are the ADR's table verbatim; the reconciler and the REST
/// confirm path decide nothing on their own, so the two cannot drift into two
/// different meanings of the same intermediate state.
public enum CloudLifecyclePhase: String, Sendable, Equatable, CaseIterable {
    case pausing
    case resuming
    case destroyPending

    public init?(state: String) {
        switch state {
        case "pausing": self = .pausing
        case "resuming": self = .resuming
        case "destroy_pending": self = .destroyPending
        default: return nil
        }
    }

    /// The `work_cloud_host.state` this phase occupies.
    public var state: String {
        switch self {
        case .pausing: return "pausing"
        case .resuming: return "resuming"
        case .destroyPending: return "destroy_pending"
        }
    }

    /// Where a confirmed operation lands.
    public var confirmedState: String {
        switch self {
        case .pausing: return "paused"
        case .resuming: return "running"
        case .destroyPending: return "destroyed"
        }
    }

    /// Where an abandoned operation lands. `destroy_pending` has none on
    /// purpose: a paid instance nobody is destroying is the one outcome
    /// ADR-0140 D4 refuses to accept.
    public var revertState: String? {
        switch self {
        case .pausing: return "running"
        case .resuming: return "paused"
        case .destroyPending: return nil
        }
    }

    public var operation: CloudProviderOperation {
        switch self {
        case .pausing: return .pause
        case .resuming: return .resume
        case .destroyPending: return .destroy
        }
    }
}

public enum CloudLifecycleConvergence: String, Sendable, Equatable {
    /// The operation happened. Advance to `confirmedState`.
    case confirm
    /// It did not happen and will not. Fall back to `revertState` — billing
    /// keeps following the sandbox's actual condition, not the user's intent.
    case revert
    /// The instance is gone. `t3_terminate(reason='provider_missing')`.
    case terminate
    /// Try again later with backoff. Never abandoned.
    case retry
}

public enum CloudLifecycleRules {
    /// The adapter answered within the deadline. `error == nil` is success.
    ///
    /// A missing instance is terminal for pause as well as resume: keeping a
    /// dead sandbox in `running` because the ADR's row for `pausing` says
    /// "running 복귀" would bill a workspace for an instance that provably no
    /// longer exists, which inverts the rule the row exists to express
    /// ("사실에 맞는 쪽"). The fact wins over the fallback.
    public static func afterProviderCall(
        phase: CloudLifecyclePhase,
        error: CloudProviderError?
    ) -> CloudLifecycleConvergence {
        guard let error else { return .confirm }
        // The single intent that never gives up: a leaked paid instance costs
        // money for as long as it exists, so there is no failure mode where
        // stopping is better than retrying (ADR-0140 D4).
        if phase == .destroyPending { return .retry }
        if error == .instanceMissing { return .terminate }
        return .revert
    }

    /// The deadline passed. The provider, not the clock, decides what is true —
    /// and `unknown` is never read as `absent` (ADR-0142 D3.1), so an
    /// unreachable provider falls back to the phase's own abandonment rule.
    public static func afterDeadline(
        phase: CloudLifecyclePhase,
        presence: CloudInstancePresence
    ) -> CloudLifecycleConvergence {
        switch presence {
        case .absent:
            // For a destroy, absence *is* the goal.
            return phase == .destroyPending ? .confirm : .terminate
        case .present:
            switch phase {
            case .destroyPending: return .retry
            // Presence proves the instance is alive but not whether it is
            // paused, so pause stays with the billable reading.
            case .pausing: return .revert
            // A resume that was asked for and an instance that now answers is
            // the operation having succeeded, late.
            case .resuming: return .confirm
            }
        case .unknown:
            return phase == .destroyPending ? .retry : .revert
        }
    }
}
