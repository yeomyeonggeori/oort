import XCTest
import SwiftUI
import AppKit
import SnapshotTesting
import MomoCore
@testable import MomoMac

// Canonical MOMO-364 references are intentionally recorded by the orchestrator.
// Worker runs rasterize the complete status, log, approval, and result surface.
@MainActor
final class AgentWorkSurfaceSnapshotTests: XCTestCase {
    private let size = CGSize(width: 720, height: 680)
    private let approvalInboxSize = CGSize(width: 440, height: 560)

    private func fixture(
        _ scheme: ColorScheme,
        presentation: MomoDeveloperModePresentation = .developer(showCosts: true)
    ) -> some View {
        let workspace = WorkspaceID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let channel = ChannelID(uuidString: "00000000-0000-7000-8000-000000000202")!
        let agent = Member(
            id: MemberID(uuidString: "00000000-0000-7000-8000-000000000103")!,
            workspaceId: workspace,
            kind: .agent,
            displayName: "빌드봇",
            handle: "buildbot"
        )
        let waiting = AgentWorkRun(
            id: RunID(uuidString: "00000000-0000-7000-8000-000000000364")!,
            workspaceId: workspace,
            agentMemberId: agent.id,
            channelId: channel,
            status: .awaitingApproval,
            input: AgentWorkInput(
                title: "macOS Work surface 마무리",
                brief: "기존 MessageListView 그루핑을 유지하고, 승인 후 Swift 테스트를 실행하세요."
            ),
            createdAtMs: 1_783_910_400_000,
            updatedAtMs: 1_783_910_460_000
        )
        let approval = ApprovalEvent(
            action: .requested,
            approvalId: ApprovalID(uuidString: "00000000-0000-7000-8000-000000000964")!,
            runId: waiting.id,
            channelId: channel,
            requestedBy: agent.id,
            actionType: "workspace_write",
            status: .pending,
            payload: .object([
                "title": .string("Swift 소스 6개를 수정하고 단위 테스트를 실행합니다."),
                "tier": .string("workspace_write"),
            ])
        )
        let partial = AgentPartial(
            runId: waiting.id,
            channelId: channel,
            textDelta: "MessageListView 구조를 확인했습니다.\nWork 카드와 상세 pane을 연결할 준비가 됐습니다."
        )
        let completed = AgentWorkRun(
            id: RunID(uuidString: "00000000-0000-7000-8000-000000000365")!,
            workspaceId: workspace,
            agentMemberId: agent.id,
            channelId: channel,
            status: .succeeded,
            input: AgentWorkInput(
                title: "승인 결과 반영",
                brief: "검증 결과와 PR 링크를 Work 카드에 남기세요."
            ),
            output: .object([
                "summary": .string("Core와 macOS build가 통과했습니다."),
                "diff_summary": .string("Work 컴포저, 카드, 상세 pane을 추가했습니다."),
                "changed_file_count": .int(8),
                "exit_code": .int(0),
                "pr_url": .string("https://github.com/Dawn-kim-official/momo/pull/364"),
                "transcript": .array([.string("swift build 완료")]),
            ]),
            finishedAtMs: 1_783_910_520_000,
            createdAtMs: 1_783_910_400_000,
            updatedAtMs: 1_783_910_520_000
        )

        return ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                AgentWorkRunCard(
                    run: waiting,
                    agent: agent,
                    status: .awaitingApproval,
                    partial: partial,
                    approval: approval,
                    messages: [],
                    isApprovalInFlight: false,
                    copy: MomoWorkspaceCopy(language: .korean),
                    presentation: presentation,
                    onApprovalDecision: { _, _ in },
                    onOpenDetail: {}
                )
                AgentWorkRunCard(
                    run: completed,
                    agent: agent,
                    status: .succeeded,
                    partial: nil,
                    approval: nil,
                    messages: [],
                    isApprovalInFlight: false,
                    copy: MomoWorkspaceCopy(language: .korean),
                    presentation: presentation,
                    onApprovalDecision: { _, _ in },
                    onOpenDetail: {}
                )
            }
            .padding(16)
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .background(Color(nsColor: .textBackgroundColor))
        .environment(\.colorScheme, scheme)
        .environment(\.locale, Locale(identifier: "ko_KR"))
    }

    private func render(
        _ scheme: ColorScheme,
        presentation: MomoDeveloperModePresentation = .developer(showCosts: true)
    ) throws -> NSImage {
        let hostingView = NSHostingView(
            rootView: fixture(scheme, presentation: presentation)
        )
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
        ) else {
            throw XCTSkip("NSHostingView produced no Work surface bitmap on this host")
        }
        representation.size = size
        hostingView.cacheDisplay(in: hostingView.bounds, to: representation)
        let image = NSImage(size: size)
        image.addRepresentation(representation)
        return image
    }

    private func requireCanonicalReference(testName: String, named: String) throws {
        let testDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let reference = testDirectory
            .appendingPathComponent("__Snapshots__/AgentWorkSurfaceSnapshotTests")
            .appendingPathComponent("\(testName).\(named).png")
        let isRecording = ProcessInfo.processInfo.environment["MOMO_RECORD_SNAPSHOTS"] == "1"
        guard isRecording || FileManager.default.fileExists(atPath: reference.path) else {
            throw XCTSkip(
                "Canonical MOMO-364 snapshot will be recorded by the orchestrator: \(reference.lastPathComponent)"
            )
        }
    }

    private func writeDesignReviewArtifact(_ image: NSImage, named name: String) throws {
        guard let directory = ProcessInfo.processInfo.environment["MOMO_DESIGN_REVIEW_ARTIFACT_DIR"] else {
            return
        }
        let outputDirectory = URL(fileURLWithPath: directory, isDirectory: true)
        try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
        guard let tiff = image.tiffRepresentation,
              let representation = NSBitmapImageRep(data: tiff),
              let png = representation.representation(using: .png, properties: [:])
        else {
            throw XCTSkip("Rendered Work surface image could not be encoded as PNG")
        }
        try png.write(to: outputDirectory.appendingPathComponent(name), options: .atomic)
    }

    private func renderStandardApprovalInbox() async throws -> NSImage {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "approval-inbox-snapshot")
        XCTAssertEqual(viewModel.pendingApprovals.count, 1)

        let suiteName = "momo.snapshot.approval-inbox-standard"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defaults.set(false, forKey: MomoDeveloperModePresentation.developerModeKey)
        defaults.set(true, forKey: MomoDeveloperModePresentation.costDisplayKey)
        defaults.set(MomoUILanguage.korean.rawValue, forKey: MomoUILanguage.appStorageKey)

        let hostingView = NSHostingView(
            rootView: ApprovalInboxView(viewModel: viewModel)
                .frame(width: approvalInboxSize.width, height: approvalInboxSize.height)
                .background(Color(nsColor: .textBackgroundColor))
                .environment(\.colorScheme, .light)
                .environment(\.locale, Locale(identifier: "ko_KR"))
                .defaultAppStorage(defaults)
        )
        let appearance = NSAppearance(named: .aqua)
        let window = NSWindow(
            contentRect: CGRect(origin: .zero, size: approvalInboxSize),
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.appearance = appearance
        hostingView.frame = CGRect(origin: .zero, size: approvalInboxSize)
        hostingView.appearance = appearance
        window.contentView = hostingView
        window.layoutIfNeeded()
        hostingView.layoutSubtreeIfNeeded()
        hostingView.displayIfNeeded()

        guard let representation = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: Int(approvalInboxSize.width * 2),
            pixelsHigh: Int(approvalInboxSize.height * 2),
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else {
            throw XCTSkip("NSHostingView produced no standard approval inbox bitmap on this host")
        }
        representation.size = approvalInboxSize
        hostingView.cacheDisplay(in: hostingView.bounds, to: representation)
        let image = NSImage(size: approvalInboxSize)
        image.addRepresentation(representation)
        return image
    }

    func testWorkSurfaceRasterWritesDesignReviewArtifacts() throws {
        for scheme in [ColorScheme.light, .dark] {
            let image = try render(scheme)
            try writeDesignReviewArtifact(
                image,
                named: "momo-369-work-\(scheme == .dark ? "dark" : "light").png"
            )
            XCTAssertEqual(image.size, size)
        }
    }

    func testDualDensityWorkSurfaceWritesDesignReviewArtifacts() throws {
        let modes: [(String, MomoDeveloperModePresentation)] = [
            ("standard", .standard),
            ("developer", .developer(showCosts: true)),
        ]
        for (mode, presentation) in modes {
            for scheme in [ColorScheme.light, .dark] {
                let image = try render(scheme, presentation: presentation)
                try writeDesignReviewArtifact(
                    image,
                    named: "momo-370-work-\(mode)-\(scheme == .dark ? "dark" : "light").png"
                )
                XCTAssertEqual(image.size, size)
            }
        }
    }

    func testApprovalInboxStandardRasterWritesDesignReviewArtifact() async throws {
        let image = try await renderStandardApprovalInbox()
        try writeDesignReviewArtifact(
            image,
            named: "momo-370-approval-inbox-standard-light.png"
        )
        XCTAssertEqual(image.size, approvalInboxSize)
    }

    func testWorkSurfaceLightSnapshot() throws {
        try requireCanonicalReference(
            testName: #function.replacingOccurrences(of: "()", with: ""),
            named: "light"
        )
        assertSnapshot(
            of: try render(.light),
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "light"
        )
    }

    func testWorkSurfaceDarkSnapshot() throws {
        try requireCanonicalReference(
            testName: #function.replacingOccurrences(of: "()", with: ""),
            named: "dark"
        )
        assertSnapshot(
            of: try render(.dark),
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "dark"
        )
    }
}
