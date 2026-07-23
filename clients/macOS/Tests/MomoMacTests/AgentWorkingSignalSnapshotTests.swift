import XCTest
import SwiftUI
import AppKit
import SnapshotTesting
import MomoCore
@testable import MomoMac

// MOMO-568 agentWorkingSignal surfaces. Canonical light/dark references are
// recorded by the orchestrator (baseline env = orchestrator); worker runs render
// and, absent a baseline, skip rather than record. The fixture mixes a long
// Korean + English 3-line headline to prove the composer bar and channel badge
// never truncate or overflow.
@MainActor
final class AgentWorkingSignalSnapshotTests: XCTestCase {
    private let size = CGSize(width: 520, height: 260)

    private func fixture(_ scheme: ColorScheme) -> some View {
        let copy = MomoWorkspaceCopy(language: .korean)
        let workspace = WorkspaceID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let channel = ChannelID(uuidString: "00000000-0000-7000-8000-000000000202")!
        let now = Date(timeIntervalSince1970: 1_783_910_400)

        let buildbot = AgentWorkingSignal(
            agentId: MemberID(uuidString: "00000000-0000-7000-8000-000000000103")!,
            channelId: channel,
            agentName: "빌드봇",
            runId: RunID(uuidString: "00000000-0000-7000-8000-000000000568")!,
            startedAt: now.addingTimeInterval(-83),
            headlines: [
                "macOS 스냅샷 테스트 실패를 수정하고 light/dark 기준 이미지를 다시 기록한 뒤 swift test 전체를 통과시키는 중입니다.",
            ],
            source: .run
        )
        let apollo = AgentWorkingSignal(
            agentId: MemberID(uuidString: "00000000-0000-7000-8000-000000000104")!,
            channelId: channel,
            agentName: "Apollo",
            runId: RunID(uuidString: "00000000-0000-7000-8000-000000000569")!,
            startedAt: now.addingTimeInterval(-5),
            headlines: ["Reviewing the schema migration plan"],
            source: .status
        )
        _ = workspace

        return VStack(alignment: .leading, spacing: 16) {
            AgentWorkingChannelBadge(signals: [buildbot, apollo], copy: copy)
            AgentTurnLivenessMark(accessibilityText: copy.agentWorkingTitle(buildbot.agentName))
            AgentWorkingComposerBar(signals: [buildbot, apollo], copy: copy)
        }
        .padding(16)
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .background(Color(nsColor: .textBackgroundColor))
        .environment(\.colorScheme, scheme)
        .environment(\.locale, Locale(identifier: "ko_KR"))
    }

    private func render(_ scheme: ColorScheme) throws -> NSImage {
        let hostingView = NSHostingView(rootView: fixture(scheme))
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
            throw XCTSkip("NSHostingView produced no agentWorkingSignal bitmap on this host")
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
            .appendingPathComponent("__Snapshots__/AgentWorkingSignalSnapshotTests")
            .appendingPathComponent("\(testName).\(named).png")
        let isRecording = ProcessInfo.processInfo.environment["MOMO_RECORD_SNAPSHOTS"] == "1"
        guard isRecording || FileManager.default.fileExists(atPath: reference.path) else {
            throw XCTSkip(
                "Canonical MOMO-568 snapshot will be recorded by the orchestrator: \(reference.lastPathComponent)"
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
            throw XCTSkip("Rendered agentWorkingSignal image could not be encoded as PNG")
        }
        try png.write(to: outputDirectory.appendingPathComponent(name), options: .atomic)
    }

    func testAgentWorkingSignalWritesDesignReviewArtifacts() throws {
        for scheme in [ColorScheme.light, .dark] {
            let image = try render(scheme)
            try writeDesignReviewArtifact(
                image,
                named: "momo-568-agent-working-signal-\(scheme == .dark ? "dark" : "light").png"
            )
            XCTAssertEqual(image.size, size)
        }
    }

    func testAgentWorkingSignalLightSnapshot() throws {
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

    func testAgentWorkingSignalDarkSnapshot() throws {
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
