import XCTest
import Foundation
@testable import MomoMac

// MOMO-593: pure-logic coverage for the sidebar update pill. The version
// comparison is reused from MOMO-244 (`MomoMacUpdateChannelStatus.isUpdateAvailable`);
// these tests pin the pill-visibility and session-dismiss rules that sit on top
// of it, plus the model that drives them.
final class MomoUpdatePillTests: XCTestCase {

    private func version(_ semver: String, build: String) -> MomoMacAppVersion {
        MomoMacAppVersion(version: semver, build: build)
    }

    private func manifest(version: String, build: String) -> MomoMacUpdateManifest {
        MomoMacUpdateManifest(
            version: version,
            build: build,
            summary: "새 알파 빌드 · Alpha refresh",
            downloadURL: URL(string: "file:///tmp/momo-alpha.zip")
        )
    }

    private func availableStatus(
        current: (String, String) = ("1.2.0", "40"),
        available: (String, String) = ("1.3.0", "42")
    ) -> MomoMacUpdateChannelStatus {
        MomoMacUpdateChannelStatus(
            currentVersion: version(current.0, build: current.1),
            manifest: manifest(version: available.0, build: available.1),
            state: .updateAvailable
        )
    }

    // MARK: - Version comparison (reused engine, pinned for the pill)

    func testUpdateAvailableWhenSemverIsNewer() {
        XCTAssertTrue(MomoMacUpdateChannelStatus.isUpdateAvailable(
            current: version("1.2.0", build: "40"),
            available: version("1.3.0", build: "5")
        ))
    }

    func testUpdateNotAvailableWhenSameVersionAndBuild() {
        XCTAssertFalse(MomoMacUpdateChannelStatus.isUpdateAvailable(
            current: version("1.3.0", build: "42"),
            available: version("1.3.0", build: "42")
        ))
    }

    func testUpdateAvailableWhenBuildIsNewerAtSameVersion() {
        XCTAssertTrue(MomoMacUpdateChannelStatus.isUpdateAvailable(
            current: version("1.3.0", build: "41"),
            available: version("1.3.0", build: "42")
        ))
    }

    func testOlderAvailableVersionIsNotAnUpdate() {
        XCTAssertFalse(MomoMacUpdateChannelStatus.isUpdateAvailable(
            current: version("1.3.0", build: "42"),
            available: version("1.2.9", build: "99")
        ))
    }

    // MARK: - Pill decision (silence rules)

    func testDecisionHiddenWhenNotConfigured() {
        let decision = MomoUpdatePillDecision(
            status: MomoMacUpdateChannelStatus(state: .notConfigured),
            dismissedVersion: nil
        )
        XCTAssertFalse(decision.isVisible)
        XCTAssertNil(decision.availableVersion)
    }

    func testDecisionHiddenWhenUpToDate() {
        let status = MomoMacUpdateChannelStatus(
            currentVersion: version("1.3.0", build: "42"),
            manifest: manifest(version: "1.3.0", build: "42"),
            state: .upToDate
        )
        let decision = MomoUpdatePillDecision(status: status, dismissedVersion: nil)
        XCTAssertFalse(decision.isVisible)
    }

    func testDecisionHiddenWhenCheckFailed() {
        // A failed/offline check is completely silent: no pill, no version.
        let status = MomoMacUpdateChannelStatus(
            currentVersion: version("1.2.0", build: "40"),
            state: .failed,
            diagnostics: ["Update manifest file was not found: /tmp/missing.json"]
        )
        let decision = MomoUpdatePillDecision(status: status, dismissedVersion: nil)
        XCTAssertFalse(decision.isVisible)
        XCTAssertNil(decision.availableVersion)
    }

    func testDecisionVisibleWhenUpdateAvailableAndNotDismissed() {
        let decision = MomoUpdatePillDecision(status: availableStatus(), dismissedVersion: nil)
        XCTAssertTrue(decision.isVisible)
        XCTAssertEqual(decision.availableVersion, version("1.3.0", build: "42"))
    }

    // MARK: - Session dismiss

    func testDismissHidesTheSameVersion() {
        let status = availableStatus()
        let decision = MomoUpdatePillDecision(
            status: status,
            dismissedVersion: version("1.3.0", build: "42")
        )
        XCTAssertFalse(decision.isVisible)
        XCTAssertNil(decision.availableVersion)
    }

    func testNewerVersionReappearsAfterDismiss() {
        // Dismissing 1.3.0 must not suppress a later 1.4.0.
        let status = availableStatus(available: ("1.4.0", "50"))
        let decision = MomoUpdatePillDecision(
            status: status,
            dismissedVersion: version("1.3.0", build: "42")
        )
        XCTAssertTrue(decision.isVisible)
        XCTAssertEqual(decision.availableVersion, version("1.4.0", build: "50"))
    }

    func testEqualBuildAfterDismissStaysHidden() {
        let status = availableStatus(available: ("1.3.0", "42"))
        let decision = MomoUpdatePillDecision(
            status: status,
            dismissedVersion: version("1.3.0", build: "42")
        )
        XCTAssertFalse(decision.isVisible)
    }

    // MARK: - Model

    @MainActor
    func testModelStartsSilentBeforeFirstCheck() {
        let model = MomoUpdatePillModel(interval: 3_600, check: { availableStatusForTest() })
        XCTAssertFalse(model.decision.isVisible)
    }

    @MainActor
    func testModelRefreshSurfacesUpdate() async {
        let model = MomoUpdatePillModel(interval: 3_600, check: { availableStatusForTest() })
        await model.refresh()
        XCTAssertTrue(model.decision.isVisible)
        XCTAssertEqual(model.decision.availableVersion, MomoMacAppVersion(version: "1.3.0", build: "42"))
    }

    @MainActor
    func testModelDismissHidesCurrentVersionForSession() async {
        let model = MomoUpdatePillModel(interval: 3_600, check: { availableStatusForTest() })
        await model.refresh()
        XCTAssertTrue(model.decision.isVisible)

        model.dismiss()
        XCTAssertEqual(model.dismissedVersion, MomoMacAppVersion(version: "1.3.0", build: "42"))
        XCTAssertFalse(model.decision.isVisible)
    }
}

// A file-scope Sendable fixture so the model's `@Sendable` check closure can
// capture it without crossing actor boundaries.
private func availableStatusForTest() -> MomoMacUpdateChannelStatus {
    MomoMacUpdateChannelStatus(
        currentVersion: MomoMacAppVersion(version: "1.2.0", build: "40"),
        manifest: MomoMacUpdateManifest(
            version: "1.3.0",
            build: "42",
            summary: "새 알파 빌드 · Alpha refresh",
            downloadURL: URL(string: "file:///tmp/momo-alpha.zip")
        ),
        state: .updateAvailable
    )
}
