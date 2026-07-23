import AppKit
import MomoCore
import SnapshotTesting
import SwiftUI
import XCTest
@testable import MomoMac

// MOMO-570: the empty-channel intro offers agent creation at equal footing with
// people invitation. Snapshot baselines are intentionally left for orchestrator
// recording (MOMO_VERIFY_570_SNAPSHOTS=1); logic and journey assertions run in the
// default suite.
@MainActor
final class MomoEmptyChannelOnboardingTests: XCTestCase {

    // MARK: Placement policy

    func testAdminSeesInviteAndCreateAtEqualFooting() {
        let actions = MomoEmptyChannelOnboardingPolicy.actions(
            canManageChannelMembers: true,
            invitePeopleAvailable: true,
            createAgentAvailable: true
        )
        XCTAssertTrue(actions.canInvitePeople)
        XCTAssertTrue(actions.canCreateAgent)
        XCTAssertTrue(actions.showsManagementActions)
        XCTAssertFalse(actions.showsRequestGuidance)
    }

    func testNonAdminKeepsSurfaceAndShowsRequestGuidance() {
        // A non-admin gets neither hook wired, so both actions are absent, but the
        // surface must stay visible and point at the request path.
        let actions = MomoEmptyChannelOnboardingPolicy.actions(
            canManageChannelMembers: false,
            invitePeopleAvailable: false,
            createAgentAvailable: false
        )
        XCTAssertFalse(actions.canInvitePeople)
        XCTAssertFalse(actions.canCreateAgent)
        XCTAssertFalse(actions.showsManagementActions)
        XCTAssertTrue(actions.showsRequestGuidance)
    }

    func testInviteRequiresChannelMemberManagement() {
        // A channel where members cannot be managed hides invite while workspace
        // level agent creation stays available.
        let actions = MomoEmptyChannelOnboardingPolicy.actions(
            canManageChannelMembers: false,
            invitePeopleAvailable: true,
            createAgentAvailable: true
        )
        XCTAssertFalse(actions.canInvitePeople)
        XCTAssertTrue(actions.canCreateAgent)
        XCTAssertTrue(actions.showsManagementActions)
    }

    // MARK: Journey budget (empty channel to first mention)

    func testCreateToFirstMentionStaysWithinFourClicks() {
        XCTAssertEqual(MomoEmptyChannelAgentJourney.clickCount, 4)
        XCTAssertLessThanOrEqual(MomoEmptyChannelAgentJourney.clickCount, 4)
        // The channel auto-invite runs on creation completion, so it must not cost
        // a click; otherwise the budget would be five.
        XCTAssertTrue(MomoEmptyChannelAgentJourney.steps.contains(.autoInviteToChannel))
        XCTAssertFalse(MomoEmptyChannelAgentJourney.Step.autoInviteToChannel.requiresClick)
        XCTAssertEqual(
            MomoEmptyChannelAgentJourney.steps.first,
            .openCreateAgent
        )
        XCTAssertEqual(
            MomoEmptyChannelAgentJourney.steps.last,
            .mentionAgent
        )
    }

    // MARK: Auto-invite wiring (the step the host runs on completion)

    func testCreatedAgentIsAutoInvitedToCurrentChannel() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let general = try XCTUnwrap(seed.channels.first { $0.name == "general" })
        // buildbot is seeded only into feature-pg18, so general is a clean target
        // that stands in for a freshly created agent joining an empty channel.
        let joining = try XCTUnwrap(seed.agents.first { !$0.channelIds.contains(general.id) })
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "test")
        await viewModel.selectChannel(general.id)

        XCTAssertFalse(
            viewModel.members.first { $0.id == joining.id }?.channelIds.contains(general.id) ?? true,
            "precondition: agent should not yet be in the target channel"
        )

        await viewModel.addMember(joining.id, to: general.id)

        XCTAssertTrue(
            viewModel.members.first { $0.id == joining.id }?.channelIds.contains(general.id) ?? false,
            "the created agent must land in the channel it was created from"
        )
    }

    // MARK: Snapshots (baselines recorded by the orchestrator)

    func testAdminEmptyChannelKoreanLightSnapshot() throws {
        try requireOrchestratorBaseline()
        try assertEmptyStateSnapshot(.adminBoth, scheme: .light, named: "admin-korean-light", testName: #function)
    }

    func testAdminEmptyChannelKoreanDarkSnapshot() throws {
        try requireOrchestratorBaseline()
        try assertEmptyStateSnapshot(.adminBoth, scheme: .dark, named: "admin-korean-dark", testName: #function)
    }

    func testNonAdminEmptyChannelKoreanLightSnapshot() throws {
        try requireOrchestratorBaseline()
        try assertEmptyStateSnapshot(.nonAdmin, scheme: .light, named: "nonadmin-korean-light", testName: #function)
    }

    func testNarrowEmptyChannelKoreanWrapsWithoutTruncation() throws {
        try requireOrchestratorBaseline()
        // Narrow width proves the Korean plus English mixed copy wraps to multiple
        // lines instead of truncating.
        try assertEmptyStateSnapshot(
            .adminBoth,
            scheme: .light,
            named: "admin-korean-narrow",
            testName: #function,
            width: 320
        )
    }

    // MARK: Helpers

    private enum EmptyStateFixture {
        case adminBoth
        case nonAdmin

        var actions: MomoEmptyChannelOnboardingPolicy.Actions {
            switch self {
            case .adminBoth:
                return MomoEmptyChannelOnboardingPolicy.actions(
                    canManageChannelMembers: true,
                    invitePeopleAvailable: true,
                    createAgentAvailable: true
                )
            case .nonAdmin:
                return MomoEmptyChannelOnboardingPolicy.actions(
                    canManageChannelMembers: false,
                    invitePeopleAvailable: false,
                    createAgentAvailable: false
                )
            }
        }
    }

    private func requireOrchestratorBaseline() throws {
        guard ProcessInfo.processInfo.environment["MOMO_VERIFY_570_SNAPSHOTS"] == "1" else {
            throw XCTSkip("MOMO-570 baselines are intentionally left for orchestrator recording")
        }
    }

    private func assertEmptyStateSnapshot(
        _ fixture: EmptyStateFixture,
        scheme: ColorScheme,
        named: String,
        testName: String,
        width: CGFloat = 520
    ) throws {
        let size = CGSize(width: width, height: 360)
        let content = TimelineEmptyState(
            copy: MomoWorkspaceCopy(language: .korean),
            actions: fixture.actions,
            focusComposer: {},
            invitePeople: {},
            createAgent: {}
        )
        .frame(width: size.width, height: size.height, alignment: .center)
        .background(Color(nsColor: .windowBackgroundColor))

        let image = try render(content, size: size, scheme: scheme)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: named,
            record: ProcessInfo.processInfo.environment["MOMO_RECORD_SNAPSHOTS"] == "1" ? .all : nil,
            testName: testName.replacingOccurrences(of: "()", with: "")
        )
    }

    private func render<Content: View>(
        _ content: Content,
        size: CGSize,
        scheme: ColorScheme
    ) throws -> NSImage {
        let hostingView = NSHostingView(rootView: content.environment(\.colorScheme, scheme))
        hostingView.frame = CGRect(origin: .zero, size: size)
        hostingView.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
        hostingView.layoutSubtreeIfNeeded()
        hostingView.displayIfNeeded()
        guard let representation = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: Int(size.width * 2),
            pixelsHigh: Int(size.height * 2),
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else { throw XCTSkip("NSHostingView produced no empty-channel bitmap on this host") }
        representation.size = size
        hostingView.cacheDisplay(in: hostingView.bounds, to: representation)
        let image = NSImage(size: size)
        image.addRepresentation(representation)
        return image
    }
}
