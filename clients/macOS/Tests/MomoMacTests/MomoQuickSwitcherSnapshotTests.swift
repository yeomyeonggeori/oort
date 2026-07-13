import XCTest
import SwiftUI
import AppKit
import SnapshotTesting
import MomoCore
@testable import MomoMac

// Canonical MOMO-358/367 references are intentionally recorded by the orchestrator
// so the worker does not author host-dependent light/dark PNG baselines.
@MainActor
final class MomoQuickSwitcherSnapshotTests: XCTestCase {
    private let switcherSize = CGSize(width: 640, height: 600)
    private let shortcutsSize = CGSize(width: 520, height: 480)

    private func switcherFixture(
        _ scheme: ColorScheme,
        capabilitiesByHandle: [String: [String]] = [:]
    ) async throws -> some View {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo(capabilitiesByHandle: capabilitiesByHandle)
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "snapshot")
        let featureChannel = try XCTUnwrap(seed.channels.first { $0.name == "feature-pg18" })
        await viewModel.selectChannel(featureChannel.id)

        return ZStack {
            Color(nsColor: .windowBackgroundColor)
            MomoQuickSwitcherView(
                viewModel: viewModel,
                copy: MomoWorkspaceCopy(language: .korean),
                activate: { _ in },
                dismiss: {}
            )
        }
        .frame(width: switcherSize.width, height: switcherSize.height)
        .environment(\.colorScheme, scheme)
    }

    private func shortcutsFixture(_ scheme: ColorScheme) -> some View {
        MomoKeyboardShortcutsView(copy: MomoWorkspaceCopy(language: .korean))
            .frame(width: shortcutsSize.width, height: shortcutsSize.height)
            .background(Color(nsColor: .windowBackgroundColor))
            .environment(\.colorScheme, scheme)
    }

    private func render<Content: View>(
        _ view: Content,
        size: CGSize,
        scheme: ColorScheme
    ) throws -> NSImage {
        let hostingView = NSHostingView(rootView: view)
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
            throw XCTSkip("NSHostingView produced no quick-switcher bitmap on this host")
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
            .appendingPathComponent("__Snapshots__/MomoQuickSwitcherSnapshotTests")
            .appendingPathComponent("\(testName).\(named).png")
        let isRecording = ProcessInfo.processInfo.environment["MOMO_RECORD_SNAPSHOTS"] == "1"
        guard isRecording || FileManager.default.fileExists(atPath: reference.path) else {
            let ticket: String
            if testName.contains("Capability") {
                ticket = "MOMO-365"
            } else if testName.contains("Unread") {
                ticket = "MOMO-367"
            } else {
                ticket = "MOMO-358"
            }
            throw XCTSkip("Canonical \(ticket) snapshot will be recorded by the orchestrator: \(reference.lastPathComponent)")
        }
    }

    func testQuickSwitcherLightSnapshot() async throws {
        try requireCanonicalReference(testName: #function.replacingOccurrences(of: "()", with: ""), named: "light")
        let fixture = try await switcherFixture(.light)
        let image = try render(fixture, size: switcherSize, scheme: .light)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "light"
        )
    }

    func testQuickSwitcherDarkSnapshot() async throws {
        try requireCanonicalReference(testName: #function.replacingOccurrences(of: "()", with: ""), named: "dark")
        let fixture = try await switcherFixture(.dark)
        let image = try render(fixture, size: switcherSize, scheme: .dark)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "dark"
        )
    }

    func testUnreadKeyboardShortcutsLightSnapshot() throws {
        try requireCanonicalReference(testName: #function.replacingOccurrences(of: "()", with: ""), named: "light")
        assertSnapshot(
            of: try render(shortcutsFixture(.light), size: shortcutsSize, scheme: .light),
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "light"
        )
    }

    func testUnreadKeyboardShortcutsDarkSnapshot() throws {
        try requireCanonicalReference(testName: #function.replacingOccurrences(of: "()", with: ""), named: "dark")
        assertSnapshot(
            of: try render(shortcutsFixture(.dark), size: shortcutsSize, scheme: .dark),
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "dark"
        )
    }

    func testCapabilityQuickSwitcherLightSnapshot() async throws {
        try requireCanonicalReference(
            testName: #function.replacingOccurrences(of: "()", with: ""),
            named: "light"
        )
        let fixture = try await switcherFixture(
            .light,
            capabilitiesByHandle: [
                "hermes": ["code", "terminal", "docs"],
                "buildbot": ["code", "terminal"],
            ]
        )
        let image = try render(fixture, size: switcherSize, scheme: .light)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "light"
        )
    }

    func testCapabilityQuickSwitcherDarkSnapshot() async throws {
        try requireCanonicalReference(
            testName: #function.replacingOccurrences(of: "()", with: ""),
            named: "dark"
        )
        let fixture = try await switcherFixture(
            .dark,
            capabilitiesByHandle: [
                "hermes": ["code", "terminal", "docs"],
                "buildbot": ["code", "terminal"],
            ]
        )
        let image = try render(fixture, size: switcherSize, scheme: .dark)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "dark"
        )
    }
}
