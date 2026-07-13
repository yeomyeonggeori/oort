import XCTest
import SwiftUI
import AppKit
import SnapshotTesting
import MomoCore
@testable import MomoMac

// MOMO-357 changes the full sidebar hierarchy. New canonical references are
// intentionally absent in the worker patch; the macOS gate machine records
// them so host-dependent PNGs never become worker-authored baselines.
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
        let size = CGSize(width: 340, height: 720)
        let hostingView = NSHostingView(rootView: try await fixtureSidebar(scheme))
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
            throw XCTSkip("NSHostingView produced no bitmap on this host")
        }
        representation.size = size
        hostingView.cacheDisplay(in: hostingView.bounds, to: representation)

        let image = NSImage(size: size)
        image.addRepresentation(representation)
        return image
    }

    private func agentAccentPixelCount(in image: NSImage) throws -> Int {
        guard let tiff = image.tiffRepresentation,
              let representation = NSBitmapImageRep(data: tiff)
        else {
            throw XCTSkip("Rendered roster image has no readable bitmap")
        }

        var count = 0
        for y in 0..<representation.pixelsHigh {
            for x in 0..<representation.pixelsWide {
                guard let color = representation.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else {
                    continue
                }
                if color.blueComponent > 0.68,
                   color.redComponent > 0.30,
                   color.redComponent < 0.66,
                   color.greenComponent < 0.58,
                   color.blueComponent - color.greenComponent > 0.18 {
                    count += 1
                }
            }
        }
        return count
    }

    private func requireCanonicalReference(testName: String, named: String) throws {
        let testDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let reference = testDirectory
            .appendingPathComponent("__Snapshots__/ChannelRosterSnapshotTests")
            .appendingPathComponent("\(testName).\(named).png")
        let isRecording = ProcessInfo.processInfo.environment["MOMO_RECORD_SNAPSHOTS"] == "1"
        guard isRecording || FileManager.default.fileExists(atPath: reference.path) else {
            throw XCTSkip("Canonical MOMO-357 snapshot will be recorded by the orchestrator: \(reference.lastPathComponent)")
        }
    }

    func testSidebarShellLightSnapshot() async throws {
        try requireCanonicalReference(testName: #function.replacingOccurrences(of: "()", with: ""), named: "light")
        let image = try await render(.light)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "light"
        )
    }

    func testSidebarShellDarkSnapshot() async throws {
        try requireCanonicalReference(testName: #function.replacingOccurrences(of: "()", with: ""), named: "dark")
        let image = try await render(.dark)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "dark"
        )
    }

    func testChannelRosterRasterContainsAgentBadgePixels() async throws {
        for scheme in [ColorScheme.light, .dark] {
            let image = try await render(scheme)
            XCTAssertEqual(image.size, CGSize(width: 340, height: 720))
            XCTAssertGreaterThan(
                try agentAccentPixelCount(in: image),
                100,
                "Roster raster must include Hermes member-row and AGENT badge accent pixels in \(scheme) mode"
            )
        }
    }
}
