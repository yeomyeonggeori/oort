import XCTest
import MomoCore
@testable import MomoMac

final class MomoChannelChromeTests: XCTestCase {
    func testDetailPanePresentationClosesAfterSwitchingPane() {
        var state = MomoDetailPanePresentationState()

        state.present(.settings)
        XCTAssertTrue(state.isPresented)
        XCTAssertEqual(state.pane, .settings)

        state.present(.memberProfile)
        XCTAssertTrue(state.isPresented)
        XCTAssertEqual(state.pane, .memberProfile)

        state.close()
        XCTAssertFalse(state.isPresented)
        XCTAssertEqual(state.pane, .memberProfile)
    }

    func testChannelPresentationNormalizesNameAndOptionalTopic() throws {
        let presentation = try XCTUnwrap(
            MomoChannelPresentation(name: "  design-system  ", topic: "  하나의 타임라인, two densities  ").normalized
        )

        XCTAssertEqual(presentation.name, "design-system")
        XCTAssertEqual(presentation.topic, "하나의 타임라인, two densities")
        XCTAssertNil(MomoChannelPresentation(name: "   ", topic: nil).normalized)
        XCTAssertNil(
            MomoChannelPresentation(
                name: String(repeating: "a", count: MomoChannelPresentation.maximumNameLength + 1),
                topic: nil
            ).normalized
        )
        XCTAssertNil(
            MomoChannelPresentation(
                name: "general",
                topic: String(repeating: "가", count: MomoChannelPresentation.maximumTopicLength + 1)
            ).normalized
        )
    }

    func testMemberDirectoryHookDispatchesExactlyOnce() {
        var invocationCount = 0
        let hook: MomoMemberDirectoryHook = {
            invocationCount += 1
        }

        hook()

        XCTAssertEqual(invocationCount, 1)
    }
}
