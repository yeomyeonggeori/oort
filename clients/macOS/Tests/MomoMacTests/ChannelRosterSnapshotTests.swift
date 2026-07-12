import XCTest
import SwiftUI
import SnapshotTesting
import MomoCore
@testable import MomoMac

// References are intentionally absent in the worker patch for MOMO-354. The
// canonical macOS gate machine records them; until then these tests compile and
// skip instead of creating host-dependent PNGs in a worker sandbox.
@MainActor
final class ChannelRosterSnapshotTests: XCTestCase {
    private func fixtureSidebar(_ scheme: ColorScheme) async throws -> some View {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "snapshot")
        let general = try XCTUnwrap(seed.channels.first, "Demo roster fixture must include #general")
        await viewModel.selectChannel(general.id)

        let activeMembers = viewModel.activeMembers()
        XCTAssertTrue(activeMembers.contains { $0.displayName == "Hermes" && $0.isAgent })
        XCTAssertFalse(activeMembers.contains { $0.displayName == "빌드봇" })

        let defaults = UserDefaults(suiteName: "momo.snapshot.channel-roster")!
        defaults.removePersistentDomain(forName: "momo.snapshot.channel-roster")
        return ChannelListView(viewModel: viewModel)
            .frame(width: 340, height: 720)
            .environment(\.colorScheme, scheme)
            .defaultAppStorage(defaults)
    }

    private func render(_ scheme: ColorScheme) async throws -> NSImage {
        let renderer = ImageRenderer(content: try await fixtureSidebar(scheme))
        renderer.proposedSize = ProposedViewSize(width: 340, height: 720)
        renderer.scale = 2

        let appearanceName: NSAppearance.Name = scheme == .dark ? .darkAqua : .aqua
        var image: NSImage?
        if let appearance = NSAppearance(named: appearanceName) {
            appearance.performAsCurrentDrawingAppearance {
                image = renderer.nsImage
            }
        } else {
            image = renderer.nsImage
        }
        guard let image else {
            throw XCTSkip("ImageRenderer produced no NSImage on this host")
        }
        return image
    }

    private func requireCanonicalReference(testName: String, named: String) throws {
        let testDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let reference = testDirectory
            .appendingPathComponent("__Snapshots__/ChannelRosterSnapshotTests")
            .appendingPathComponent("\(testName).\(named).png")
        let isRecording = ProcessInfo.processInfo.environment["MOMO_RECORD_SNAPSHOTS"] == "1"
        guard isRecording || FileManager.default.fileExists(atPath: reference.path) else {
            throw XCTSkip("Canonical MOMO-354 snapshot will be recorded by the orchestrator: \(reference.lastPathComponent)")
        }
    }

    func testChannelRosterLightSnapshot() async throws {
        try requireCanonicalReference(testName: #function.replacingOccurrences(of: "()", with: ""), named: "light")
        let image = try await render(.light)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "light"
        )
    }

    func testChannelRosterDarkSnapshot() async throws {
        try requireCanonicalReference(testName: #function.replacingOccurrences(of: "()", with: ""), named: "dark")
        let image = try await render(.dark)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "dark"
        )
    }
}
