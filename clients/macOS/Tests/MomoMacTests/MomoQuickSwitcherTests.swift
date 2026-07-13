import XCTest
import MomoCore
@testable import MomoMac

@MainActor
final class MomoQuickSwitcherTests: XCTestCase {
    func testQuickSwitcherUsesOnlyActiveMembersInSelectedChannel() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "test")
        let general = try XCTUnwrap(seed.channels.first)
        await viewModel.selectChannel(general.id)

        let visibleMemberIDs = Set(
            viewModel.quickSwitcherSections(query: "")
                .flatMap(\.items)
                .compactMap { item -> MemberID? in
                    guard case .member(let id) = item.destination else { return nil }
                    return id
                }
        )
        let hermes = try XCTUnwrap(seed.agents.first { $0.handle == "hermes" })
        let uninvitedBuilder = try XCTUnwrap(seed.agents.first { $0.handle == "buildbot" })
        XCTAssertTrue(visibleMemberIDs.contains(hermes.id))
        XCTAssertFalse(visibleMemberIDs.contains(uninvitedBuilder.id))

        await viewModel.removeMember(hermes.id, from: general.id)
        let afterRemoval = viewModel.quickSwitcherSections(query: "hermes").flatMap(\.items)
        XCTAssertFalse(afterRemoval.contains { $0.destination == .member(hermes.id) })
    }

    func testQuickSwitcherFuzzySearchAndRecentChannelOrdering() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "test")
        let general = try XCTUnwrap(seed.channels.first { $0.name == "general" })
        let pg18 = try XCTUnwrap(seed.channels.first { $0.name == "feature-pg18" })

        await viewModel.selectChannel(general.id)
        await viewModel.selectChannel(pg18.id)

        let recent = try XCTUnwrap(
            viewModel.quickSwitcherSections(query: "")
                .first { $0.kind == .recentChannels }
        )
        XCTAssertEqual(recent.items.map(\.destination), [.channel(pg18.id), .channel(general.id)])

        let fuzzyResults = viewModel.quickSwitcherSections(query: "fpg18").flatMap(\.items)
        XCTAssertEqual(fuzzyResults.first?.destination, .channel(pg18.id))
    }

    func testKeyboardReducerHandlesArrowsEnterAndEscape() {
        let firstChannel = ChannelID()
        let member = MemberID()
        let items = [
            MomoQuickSwitcherItem(
                destination: .channel(firstChannel),
                kind: .channel(.publicChannel),
                title: "#general",
                subtitle: nil,
                shortcutNumber: 1,
                isRecent: true,
                score: 0
            ),
            MomoQuickSwitcherItem(
                destination: .member(member),
                kind: .member(isAgent: true),
                title: "Hermes",
                subtitle: "@hermes",
                shortcutNumber: nil,
                isRecent: false,
                score: 0
            ),
        ]
        var state = MomoQuickSwitcherKeyboardState()
        state.reset(items: items)
        XCTAssertEqual(state.selectedID, .channel(firstChannel))

        XCTAssertEqual(state.handle(.moveDown, items: items), .none)
        XCTAssertEqual(state.selectedID, .member(member))
        XCTAssertEqual(state.handle(.moveUp, items: items), .none)
        XCTAssertEqual(state.selectedID, .channel(firstChannel))
        XCTAssertEqual(state.handle(.moveUp, items: items), .none, "up arrow wraps to the final result")
        XCTAssertEqual(state.handle(.confirm, items: items), .activate(.member(member)))
        XCTAssertEqual(state.handle(.cancel, items: items), .dismiss)
    }

    func testChannelNumberAndHistoryNavigation() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "test")
        let general = try XCTUnwrap(seed.channels.first { $0.name == "general" })
        let pg18 = try XCTUnwrap(seed.channels.first { $0.name == "feature-pg18" })
        let archived = Channel(
            id: ChannelID(),
            workspaceId: seed.workspace,
            kind: .publicChannel,
            name: "archived",
            archivedAtMs: 1
        )
        viewModel.setChannels([archived] + seed.channels)

        await viewModel.selectChannel(general.id)
        await viewModel.selectChannel(pg18.id)
        XCTAssertTrue(viewModel.canNavigateChannelHistoryBackward)

        await viewModel.navigateChannelHistoryBackward()
        XCTAssertEqual(viewModel.selectedChannelId, general.id)
        XCTAssertTrue(viewModel.canNavigateChannelHistoryForward)

        await viewModel.navigateChannelHistoryForward()
        XCTAssertEqual(viewModel.selectedChannelId, pg18.id)

        let selectedFirstShortcut = await viewModel.selectChannel(shortcutNumber: 1)
        XCTAssertTrue(selectedFirstShortcut)
        XCTAssertEqual(viewModel.selectedChannelId, general.id)
        let firstNumberedResult = viewModel.quickSwitcherSections(query: "")
            .flatMap(\.items)
            .first { $0.shortcutNumber == 1 }
        XCTAssertEqual(firstNumberedResult?.destination, .channel(general.id))
        XCTAssertFalse(viewModel.quickSwitcherSections(query: "archived").flatMap(\.items).contains {
            $0.destination == .channel(archived.id)
        })
        let selectedNinthShortcut = await viewModel.selectChannel(shortcutNumber: 9)
        XCTAssertFalse(selectedNinthShortcut)
    }
}
