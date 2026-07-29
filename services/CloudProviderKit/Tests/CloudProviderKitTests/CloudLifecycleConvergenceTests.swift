import XCTest
@testable import CloudProviderKit

/// ADR-0140 D4's convergence table, asserted row by row. These are unit tests
/// on purpose: the runtime gate proves the rules are *wired up*, and this file
/// proves the rules *are the ADR's*, which is the half a docker gate cannot
/// show without one scenario per cell.
final class CloudLifecycleConvergenceTests: XCTestCase {
    func testSuccessConfirmsEveryPhase() {
        for phase in CloudLifecyclePhase.allCases {
            XCTAssertEqual(
                CloudLifecycleRules.afterProviderCall(phase: phase, error: nil),
                .confirm
            )
        }
    }

    /// "pausing 실패/타임아웃 → running 복귀. 과금 계속." Reverting is what keeps
    /// billing running: the active interval was never closed.
    func testFailedPauseFallsBackToTheBillableReading() {
        for error in [CloudProviderError.requestFailed, .upstreamStatus(503),
                      .invalidResponse, .instancePaused] {
            XCTAssertEqual(
                CloudLifecycleRules.afterProviderCall(phase: .pausing, error: error),
                .revert,
                "named regression: a failed pause must return to running"
            )
        }
        XCTAssertEqual(CloudLifecyclePhase.pausing.revertState, "running")
    }

    /// "resuming 실패/타임아웃 → paused 복귀. interval 안 엶."
    func testFailedResumeReturnsToPausedAndOpensNothing() {
        for error in [CloudProviderError.requestFailed, .upstreamStatus(500),
                      .unsupported(.resume, providerID: "byoc")] {
            XCTAssertEqual(
                CloudLifecycleRules.afterProviderCall(phase: .resuming, error: error),
                .revert
            )
        }
        XCTAssertEqual(CloudLifecyclePhase.resuming.revertState, "paused")
    }

    /// "resuming + provider 404/410 → t3_terminate('provider_missing')".
    func testAProvenlyMissingInstanceIsTerminal() {
        XCTAssertEqual(
            CloudLifecycleRules.afterProviderCall(
                phase: .resuming, error: .instanceMissing
            ),
            .terminate
        )
        // A dead sandbox is a fact whichever operation found it. Leaving a
        // pause's host in `running` because the ADR's fallback says so would
        // bill a workspace for an instance that provably no longer exists.
        XCTAssertEqual(
            CloudLifecycleRules.afterProviderCall(
                phase: .pausing, error: .instanceMissing
            ),
            .terminate
        )
    }

    /// "destroy_pending 실패 → 무한 재시도". The one intent with no give-up.
    func testDestroyNeverAbandons() {
        for error in [CloudProviderError.requestFailed, .upstreamStatus(500),
                      .instanceMissing, .instancePaused, .invalidResponse,
                      .unsupported(.destroy, providerID: "byoc")] {
            XCTAssertEqual(
                CloudLifecycleRules.afterProviderCall(
                    phase: .destroyPending, error: error
                ),
                .retry,
                "named regression: destroy must never be abandoned"
            )
        }
        XCTAssertNil(CloudLifecyclePhase.destroyPending.revertState)
    }

    /// "intent deadline 초과 → provider에 상태 조회해 사실 판정."
    func testDeadlineConvergesOnTheProbedFact() {
        XCTAssertEqual(
            CloudLifecycleRules.afterDeadline(phase: .resuming, presence: .absent),
            .terminate
        )
        XCTAssertEqual(
            CloudLifecycleRules.afterDeadline(phase: .pausing, presence: .absent),
            .terminate
        )
        // Absence is exactly what a destroy was asking for.
        XCTAssertEqual(
            CloudLifecycleRules.afterDeadline(phase: .destroyPending, presence: .absent),
            .confirm
        )
        // A live instance that was asked to resume has resumed, late.
        XCTAssertEqual(
            CloudLifecycleRules.afterDeadline(phase: .resuming, presence: .present),
            .confirm
        )
        // Presence does not distinguish paused from running, so pause keeps the
        // billable reading rather than guessing in the user's favour.
        XCTAssertEqual(
            CloudLifecycleRules.afterDeadline(phase: .pausing, presence: .present),
            .revert
        )
        XCTAssertEqual(
            CloudLifecycleRules.afterDeadline(phase: .destroyPending, presence: .present),
            .retry
        )
    }

    /// "조회 불가면 위 규칙 적용" — and ADR-0142 D3.1: `unknown` is never read
    /// as `absent`, so an unreachable provider can never settle a paid session.
    func testUnreachableProviderNeverSettles() {
        for phase in CloudLifecyclePhase.allCases {
            XCTAssertNotEqual(
                CloudLifecycleRules.afterDeadline(phase: phase, presence: .unknown),
                .terminate,
                "named regression: unknown must not be read as absent"
            )
        }
        XCTAssertEqual(
            CloudLifecycleRules.afterDeadline(phase: .pausing, presence: .unknown),
            .revert
        )
        XCTAssertEqual(
            CloudLifecycleRules.afterDeadline(phase: .resuming, presence: .unknown),
            .revert
        )
        XCTAssertEqual(
            CloudLifecycleRules.afterDeadline(phase: .destroyPending, presence: .unknown),
            .retry
        )
    }

    func testConfirmedStatesMatchTheTransitionTable() {
        XCTAssertEqual(CloudLifecyclePhase.pausing.confirmedState, "paused")
        XCTAssertEqual(CloudLifecyclePhase.resuming.confirmedState, "running")
        XCTAssertEqual(CloudLifecyclePhase.destroyPending.confirmedState, "destroyed")
        XCTAssertEqual(CloudLifecyclePhase.pausing.operation, .pause)
        XCTAssertEqual(CloudLifecyclePhase.resuming.operation, .resume)
        XCTAssertEqual(CloudLifecyclePhase.destroyPending.operation, .destroy)
    }
}
