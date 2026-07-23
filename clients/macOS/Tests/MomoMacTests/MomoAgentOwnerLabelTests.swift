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

    /// The four managed-by owner states, in the display order the review checks.
    private enum OwnerState: String, CaseIterable {
        case active
        case inactive
        case departed
        case none
    }

    private func presentation(for state: OwnerState) -> MomoAgentOwnerPresentation {
        switch state {
        case .active:
            let owner = makeMember(kind: .human, displayName: "박서준", handle: "seojun", role: .admin)
            return MomoAgentOwnerPresentation(owner: .active(owner), isExternalRuntime: false)
        case .inactive:
            let owner = makeMember(
                kind: .human,
                status: .suspended,
                displayName: "이하은",
                handle: "haeun",
                role: .member
            )
            return MomoAgentOwnerPresentation(owner: .inactive(owner), isExternalRuntime: false)
        case .departed:
            return MomoAgentOwnerPresentation(owner: .departed, isExternalRuntime: false)
        case .none:
            // A card agent with no recorded owner: only the external-runtime row.
            return MomoAgentOwnerPresentation(owner: .none, isExternalRuntime: true)
        }
    }

    /// Baseline images are intentionally NOT recorded in this worktree — the
    /// orchestrator records them. This test only proves each state renders a real
    /// bitmap (the earlier version fatal-errored on a 0x0 fitting size). It skips
    /// unless MOMO_VERIFY_569_SNAPSHOTS=1 so `swift test` stays green without
    /// baselines, and only records when MOMO_RECORD_SNAPSHOTS=1.
    @MainActor
    func testManagedByOwnerStatesRenderForSnapshot() async throws {
        guard ProcessInfo.processInfo.environment["MOMO_VERIFY_569_SNAPSHOTS"] == "1" else {
            throw XCTSkip("MOMO-569 managed-by snapshot baselines are recorded by the orchestrator")
        }
        guard !NSScreen.screens.isEmpty else {
            throw XCTSkip("MOMO-569 managed-by evidence requires a WindowServer compositor")
        }

        for state in OwnerState.allCases {
            for scheme in [ColorScheme.light, .dark] {
                let image = try await render(state: state, scheme: scheme)
                // Prove the offscreen host produced pixels, not a 0x0 surface.
                XCTAssertGreaterThan(image.size.width, 0, "\(state.rawValue)/\(scheme) width")
                XCTAssertGreaterThan(image.size.height, 0, "\(state.rawValue)/\(scheme) height")
                assertSnapshot(
                    of: image,
                    as: .image(precision: 0.98, perceptualPrecision: 0.98),
                    named: "\(state.rawValue)-\(scheme == .dark ? "dark" : "light")",
                    record: snapshotRecordMode
                )
            }
        }
    }

    private var snapshotRecordMode: SnapshotTestingConfiguration.Record? {
        ProcessInfo.processInfo.environment["MOMO_RECORD_SNAPSHOTS"] == "1" ? .all : nil
    }

    /// Hosts the managed-by view in an offscreen window and captures a real
    /// bitmap. `NSHostingController.fittingSize` is 0x0 until the view is in a
    /// window and laid out; the canonical snapshot suites host it like this so
    /// AppKit-backed controls (the owner button/disclosure) appear in the pixels.
    @MainActor
    private func render(state: OwnerState, scheme: ColorScheme) async throws -> NSImage {
        let backend = LiveChatBackend()
        let viewModel = ChatViewModel(backend: backend)
        let copy = MomoWorkspaceCopy(language: scheme == .dark ? .english : .korean)

        let content = GroupBox(copy.memberProfile) {
            MomoAgentManagedByView(
                viewModel: viewModel,
                presentation: presentation(for: state),
                copy: copy
            )
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, MomoTheme.MemberInspector.standardSpacing)
        }
        .frame(width: MomoTheme.MemberInspector.profileWidth, alignment: .leading)
        .padding(MomoTheme.MemberInspector.edgeInset)
        .background(Color(nsColor: .windowBackgroundColor))
        .environment(\.colorScheme, scheme)

        let appearanceName: NSAppearance.Name = scheme == .dark ? .darkAqua : .aqua
        let appearance = NSAppearance(named: appearanceName)
        let hostingView = NSHostingView(rootView: content)
        hostingView.appearance = appearance
        let fitting = hostingView.fittingSize
        let size = CGSize(
            width: MomoTheme.MemberInspector.profileWidth + MomoTheme.MemberInspector.edgeInset * 2,
            height: max(fitting.height, 1)
        )
        hostingView.frame = CGRect(origin: .zero, size: size)
        let window = NSWindow(
            contentRect: CGRect(origin: .zero, size: size),
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.appearance = appearance
        window.isReleasedWhenClosed = false
        window.contentView = hostingView
        window.orderBack(nil)
        window.makeKey()
        defer { window.close() }
        hostingView.layoutSubtreeIfNeeded()
        hostingView.displayIfNeeded()
        // Native controls can be mid-appearance-transition on an offscreen host;
        // let AppKit settle before capturing.
        try await Task.sleep(for: .milliseconds(100))
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
        ) else {
            throw XCTSkip("NSHostingView produced no managed-by bitmap on this host")
        }
        representation.size = size
        hostingView.cacheDisplay(in: hostingView.bounds, to: representation)
        let image = NSImage(size: size)
        image.addRepresentation(representation)
        return image
    }
}
