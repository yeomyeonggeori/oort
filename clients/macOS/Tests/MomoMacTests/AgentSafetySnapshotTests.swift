import AppKit
import SnapshotTesting
import SwiftUI
import XCTest
import MomoCore
@testable import MomoMac

@MainActor
final class AgentSafetySnapshotTests: XCTestCase {
    func testStopPauseSafetySurfaceLightSnapshot() async throws {
        try requireOrchestratorBaseline()
        let image = try await render(.light)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "light"
        )
    }

    func testStopPauseSafetySurfaceDarkSnapshot() async throws {
        try requireOrchestratorBaseline()
        let image = try await render(.dark)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "dark"
        )
    }

    private func requireOrchestratorBaseline() throws {
        guard ProcessInfo.processInfo.environment["MOMO_VERIFY_558_SNAPSHOTS"] == "1" else {
            throw XCTSkip("MOMO-558 baselines are intentionally left for orchestrator recording")
        }
    }

    private func render(_ scheme: ColorScheme) async throws -> NSImage {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let channel = try XCTUnwrap(seed.channels.first)
        let agent = try XCTUnwrap(seed.agents.first { $0.channelIds.contains(channel.id) })
        try await backend.connect(workspace: seed.workspace, accessToken: "snapshot-human")
        let run = try await backend.createWorkRun(
            agent: agent.id,
            channel: channel.id,
            input: AgentWorkInput(
                title: "배포 전에 worker loop 확인",
                brief: "Korean + English 로그를 확인하고 필요하면 즉시 중지합니다."
            ),
            clientRunId: UUID()
        )
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "snapshot-human")
        await viewModel.selectChannel(channel.id)
        await viewModel.refreshAgentPauseState(agent.id)
        let copy = MomoWorkspaceCopy(language: .korean)
        let cancelled = safetyMessage(
            channel: channel.id,
            author: seed.human.id,
            kind: "agent_run_cancelled",
            run: run.id,
            sequence: 301
        )
        let paused = safetyMessage(
            channel: channel.id,
            author: agent.id,
            kind: "agent_paused",
            run: nil,
            sequence: 302
        )

        let content = VStack(alignment: .leading, spacing: 12) {
            AgentWorkRunCard(
                run: run,
                agent: agent,
                status: .running,
                partial: AgentPartial(
                    runId: run.id,
                    channelId: channel.id,
                    textDelta: "runtime gate 로그를 확인하고 있습니다."
                ),
                approval: nil,
                messages: [],
                isApprovalInFlight: false,
                copy: copy,
                onStop: {},
                onApprovalDecision: { _, _ in },
                onOpenDetail: {}
            )
            MomoAgentPauseControl(viewModel: viewModel, agent: agent, copy: copy)
            Divider()
            MessageBubble(
                message: cancelled,
                author: seed.human,
                groupingStyle: .standalone,
                timelineCopy: copy
            )
            MessageBubble(
                message: paused,
                author: agent,
                groupingStyle: .standalone,
                timelineCopy: copy
            )
        }
        .frame(width: 520, alignment: .leading)
        .padding(16)
        .background(Color(nsColor: .textBackgroundColor))
        .environment(\.colorScheme, scheme)

        // ImageRenderer drops AppKit-backed controls (buttons, toggles) from
        // the pixels, which are exactly this surface's primary controls. Host
        // the view in an offscreen window like the other canonical snapshot
        // suites so the baseline contains the real widgets.
        let appearanceName: NSAppearance.Name = scheme == .dark ? .darkAqua : .aqua
        let appearance = NSAppearance(named: appearanceName)
        let hostingView = NSHostingView(rootView: content)
        hostingView.appearance = appearance
        let size = CGSize(width: 552, height: hostingView.fittingSize.height)
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
        // Native controls can be mid-appearance-transition on an offscreen
        // host; let AppKit settle before capturing.
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
            throw XCTSkip("NSHostingView produced no agent safety bitmap on this host")
        }
        representation.size = size
        hostingView.cacheDisplay(in: hostingView.bounds, to: representation)
        let image = NSImage(size: size)
        image.addRepresentation(representation)
        return image
    }

    private func safetyMessage(
        channel: ChannelID,
        author: MemberID,
        kind: String,
        run: RunID?,
        sequence: Int64
    ) -> Message {
        Message(
            id: MessageID(),
            channelId: channel,
            seq: sequence,
            hlcTs: 1_783_910_400_000 + sequence,
            authorMemberId: author,
            type: .system,
            body: "서버 원문은 시스템 라인 표시에서 사용하지 않습니다.",
            props: .object(["kind": .string(kind)]),
            runId: run
        )
    }
}
