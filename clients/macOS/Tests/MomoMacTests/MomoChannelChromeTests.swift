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

    func testDetailPaneRedirectPreservesClosedPresentation() {
        var state = MomoDetailPanePresentationState()

        state.present(.alpha)
        state.close()
        state.redirect(to: .approvals)

        XCTAssertFalse(state.isPresented)
        XCTAssertEqual(state.pane, .approvals)
    }

    func testSafeDetailViewportAndInspectorRespectTheirTopBoundaries() {
        XCTAssertEqual(MomoWindowChromeLayout.contentTopInset(windowChromeTopInset: 52), 52)
        XCTAssertEqual(MomoWindowChromeLayout.contentTopInset(windowChromeTopInset: -1), 0)
        XCTAssertEqual(
            MomoWindowChromeLayout.inspectorTopInset(
                channelHeaderHeight: 84
            ),
            84
        )
        XCTAssertEqual(
            MomoWindowChromeLayout.inspectorTopInset(
                channelHeaderHeight: -1
            ),
            0
        )
    }

    func testToolbarOwnedSidebarConsumesTopSafeAreaOnlyWhenItsHeaderIsHidden() {
        XCTAssertEqual(
            MomoWindowChromeLayout.sidebarTopInset(
                windowChromeTopInset: 52,
                showsWorkspaceHeader: false
            ),
            52
        )
        XCTAssertEqual(
            MomoWindowChromeLayout.sidebarTopInset(
                windowChromeTopInset: 52,
                showsWorkspaceHeader: true
            ),
            0
        )
    }

    func testWindowChromeMetricsMeasureContentLayoutBandInContentViewCoordinates() {
        XCTAssertEqual(
            MomoWindowChromeMetrics.measure(
                contentViewBounds: CGRect(x: 0, y: 0, width: 1_180, height: 760),
                contentLayoutRect: CGRect(x: 0, y: 0, width: 1_180, height: 694),
                contentViewIsFlipped: false
            ).topInset,
            66
        )
        XCTAssertEqual(
            MomoWindowChromeMetrics.measure(
                contentViewBounds: CGRect(x: 0, y: 0, width: 1_180, height: 726),
                contentLayoutRect: CGRect(x: 0, y: 0, width: 1_180, height: 726),
                contentViewIsFlipped: false
            ).topInset,
            0
        )
        XCTAssertEqual(
            MomoWindowChromeMetrics.measure(
                contentViewBounds: CGRect(x: 0, y: 0, width: 1_180, height: 760),
                contentLayoutRect: CGRect(x: 0, y: 52, width: 1_180, height: 708),
                contentViewIsFlipped: true
            ).topInset,
            52
        )
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

    func testMemberDirectoryNavigationUsesProductionSheetFallback() {
        var presentationCount = 0
        let action = MomoMemberDirectoryNavigation.action(
            override: nil,
            presentDirectory: {
                presentationCount += 1
            }
        )

        action()

        XCTAssertEqual(presentationCount, 1)
    }

    func testMemberDirectoryNavigationPreservesInjectedOverride() {
        var overrideCount = 0
        var presentationCount = 0
        let action = MomoMemberDirectoryNavigation.action(
            override: {
                overrideCount += 1
            },
            presentDirectory: {
                presentationCount += 1
            }
        )

        action()

        XCTAssertEqual(overrideCount, 1)
        XCTAssertEqual(presentationCount, 0)
    }

    func testLocalChannelPresentationDrivesSharedDisplayResolvers() throws {
        let channelID = ChannelID()
        let channel = Channel(
            id: channelID,
            workspaceId: WorkspaceID(),
            kind: .publicChannel,
            name: "canonical-name",
            topic: "Canonical topic"
        )
        let nameKey = "momo.channel.\(channelID.description).displayName"
        let topicKey = "momo.channel.\(channelID.description).topic"
        defer {
            UserDefaults.standard.removeObject(forKey: nameKey)
            UserDefaults.standard.removeObject(forKey: topicKey)
        }

        MomoLocalChannelPresentationStore.save(
            MomoChannelPresentation(name: "renamed-channel", topic: "Local topic"),
            for: channel
        )

        XCTAssertEqual(MomoLocalChannelPresentationStore.displayName(for: channel), "renamed-channel")
        XCTAssertEqual(
            MomoChannelDisplayPolicy.name(
                for: channel,
                members: [],
                currentMemberID: nil
            ),
            "renamed-channel"
        )
        let item = try XCTUnwrap(
            MomoQuickSwitcherSearch.sections(
                orderedChannels: [channel],
                members: [],
                searchableMembers: [],
                currentMemberID: nil,
                recentChannelIds: [],
                query: "renamed"
            )
            .flatMap(\.items)
            .first
        )
        XCTAssertEqual(item.title, "#renamed-channel")
        XCTAssertEqual(item.subtitle, "Local topic")
    }
}
