import AppKit
import Foundation
import MomoCore
import SnapshotTesting
import SwiftUI
import XCTest
@testable import MomoMac

final class MomoAgentOwnerLabelTests: XCTestCase {
    private let workspace = WorkspaceID(UUID())

    private func makeMember(
        kind: MemberKind,
        status: MemberStatus = .active,
        displayName: String,
        handle: String,
        role: MembershipRole? = nil
    ) -> Member {
        Member(
            id: MemberID(UUID()),
            workspaceId: workspace,
            kind: kind,
            status: status,
            displayName: displayName,
            handle: handle,
            workspaceRole: role
        )
    }

    // MARK: - resolve()

    func testHumanReturnsNoPresentation() {
        let human = makeMember(kind: .human, displayName: "김성재", handle: "sungjae")
        XCTAssertNil(
            MomoAgentOwnerPresentation.resolve(
                agent: human,
                ownerID: MemberID(UUID()),
                ownerMember: nil,
                origin: .local
            )
        )
    }

    func testActiveOwnerResolvesUnmuted() throws {
        let owner = makeMember(kind: .human, displayName: "박서준", handle: "seojun", role: .admin)
        let agent = makeMember(kind: .agent, displayName: "김인턴", handle: "intern")

        let presentation = try XCTUnwrap(
            MomoAgentOwnerPresentation.resolve(
                agent: agent,
                ownerID: owner.id,
                ownerMember: owner,
                origin: .local
            )
        )
        guard case .active(let resolved) = presentation.owner else {
            return XCTFail("expected an active owner")
        }
        XCTAssertEqual(resolved.id, owner.id)
        XCTAssertFalse(presentation.isMuted)
        XCTAssertFalse(presentation.isExternalRuntime)
        XCTAssertEqual(presentation.resolvedOwner?.id, owner.id)
    }

    func testSuspendedOwnerIsInactiveAndMuted() throws {
        let owner = makeMember(kind: .human, status: .suspended, displayName: "이하은", handle: "haeun")
        let agent = makeMember(kind: .agent, displayName: "hermes", handle: "hermes")

        let presentation = try XCTUnwrap(
            MomoAgentOwnerPresentation.resolve(
                agent: agent,
                ownerID: owner.id,
                ownerMember: owner,
                origin: .local
            )
        )
        guard case .inactive = presentation.owner else {
            return XCTFail("expected an inactive owner")
        }
        XCTAssertTrue(presentation.isMuted)
        XCTAssertFalse(presentation.isDeparted)
    }

    func testOwnerMissingFromRosterIsDeparted() throws {
        let agent = makeMember(kind: .agent, displayName: "리서치 봇", handle: "research")

        let presentation = try XCTUnwrap(
            MomoAgentOwnerPresentation.resolve(
                agent: agent,
                ownerID: MemberID(UUID()),
                ownerMember: nil,
                origin: .local
            )
        )
        XCTAssertEqual(presentation.owner, .departed)
        XCTAssertTrue(presentation.isMuted)
        XCTAssertTrue(presentation.isDeparted)
        XCTAssertNil(presentation.resolvedOwner)
    }

    func testMismatchedOwnerMemberIsDeparted() throws {
        // A stale/wrong roster lookup (id mismatch) must not masquerade as the owner.
        let stranger = makeMember(kind: .human, displayName: "다른 사람", handle: "stranger")
        let agent = makeMember(kind: .agent, displayName: "봇", handle: "bot")

        let presentation = try XCTUnwrap(
            MomoAgentOwnerPresentation.resolve(
                agent: agent,
                ownerID: MemberID(UUID()),
                ownerMember: stranger,
                origin: .local
            )
        )
        XCTAssertEqual(presentation.owner, .departed)
    }

    func testLocalAgentWithoutOwnerHasNoPresentation() {
        let agent = makeMember(kind: .agent, displayName: "봇", handle: "bot")
        XCTAssertNil(
            MomoAgentOwnerPresentation.resolve(
                agent: agent,
                ownerID: nil,
                ownerMember: nil,
                origin: .local
            )
        )
    }

    func testCardAgentWithoutOwnerShowsExternalRuntimeOnly() throws {
        let agent = makeMember(kind: .agent, displayName: "외부 에이전트", handle: "external")
        let presentation = try XCTUnwrap(
            MomoAgentOwnerPresentation.resolve(
                agent: agent,
                ownerID: nil,
                ownerMember: nil,
                origin: .card
            )
        )
        XCTAssertTrue(presentation.isExternalRuntime)
        XCTAssertEqual(presentation.owner, .none)
        XCTAssertTrue(presentation.hasContent)
    }

    func testCardAgentWithActiveOwnerFlagsExternalRuntime() throws {
        let owner = makeMember(kind: .human, displayName: "성재", handle: "sj")
        let agent = makeMember(kind: .agent, displayName: "외부 에이전트", handle: "external")

        let presentation = try XCTUnwrap(
            MomoAgentOwnerPresentation.resolve(
                agent: agent,
                ownerID: owner.id,
                ownerMember: owner,
                origin: .card
            )
        )
        XCTAssertTrue(presentation.isExternalRuntime)
        guard case .active = presentation.owner else {
            return XCTFail("expected an active owner alongside external runtime")
        }
    }

    // MARK: - Snapshot evidence (gated; baselines recorded by the orchestrator)

    /// Baseline images are intentionally NOT recorded in this worktree. The
    /// orchestrator environment is the snapshot reference; this test skips unless
    /// MOMO_VERIFY_569_SNAPSHOTS=1 so `swift test` stays green without baselines.
    @MainActor
    func testManagedByPopoverSnapshotIsGated() throws {
        guard ProcessInfo.processInfo.environment["MOMO_VERIFY_569_SNAPSHOTS"] == "1" else {
            throw XCTSkip("MOMO-569 owner popover snapshot baselines are recorded by the orchestrator")
        }
        guard !NSScreen.screens.isEmpty else {
            throw XCTSkip("MOMO-569 owner popover evidence requires a WindowServer compositor")
        }

        let backend = LiveChatBackend()
        let viewModel = ChatViewModel(backend: backend)
        let owner = makeMember(kind: .human, displayName: "박서준", handle: "seojun", role: .admin)

        for scheme in [ColorScheme.light, .dark] {
            let popover = MomoAgentOwnerPopover(
                viewModel: viewModel,
                owner: owner,
                presentation: MomoAgentOwnerPresentation(owner: .active(owner), isExternalRuntime: true),
                copy: MomoWorkspaceCopy(language: scheme == .dark ? .english : .korean)
            )
            .environment(\.colorScheme, scheme)
            .frame(width: MomoTheme.MemberInspector.profileWidth)

            let hosting = NSHostingController(rootView: popover)
            hosting.view.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
            let image = NSImage(size: hosting.view.fittingSize)
            assertSnapshot(
                of: hosting,
                as: .image(precision: 0.98, perceptualPrecision: 0.98),
                named: scheme == .dark ? "owner-popover-dark" : "owner-popover-light"
            )
            _ = image
        }
    }
}
