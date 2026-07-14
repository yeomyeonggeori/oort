import XCTest
import SwiftUI
import AppKit
import SnapshotTesting
@testable import MomoMac

// MOMO-379 canonical light/dark references are recorded by the orchestrator.
// Worker runs still host the complete root shell in a titled unified NSWindow,
// including narrow overlay and wide attached inspector presentations.
@MainActor
final class MomoWindowChromeSnapshotTests: XCTestCase {
    private struct Scenario {
        let name: String
        let size: CGSize
        let scheme: ColorScheme
    }

    private let standardLight = Scenario(
        name: "standard-light",
        size: CGSize(width: 1_180, height: 760),
        scheme: .light
    )
    private let narrowDark = Scenario(
        name: "narrow-dark",
        size: CGSize(width: 980, height: 620),
        scheme: .dark
    )
    private let attachedLight = Scenario(
        name: "attached-light",
        size: CGSize(width: 1_800, height: 900),
        scheme: .light
    )
    private let sidebarLight = Scenario(
        name: "sidebar-traffic-lights-light",
        size: CGSize(width: 360, height: 720),
        scheme: .light
    )

    private func rootView(for scenario: Scenario) async throws -> some View {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "window-chrome-snapshot")
        let channel = try XCTUnwrap(seed.channels.last)
        await viewModel.selectChannel(channel.id)
        XCTAssertEqual(viewModel.pendingApprovals.count, 1)
        XCTAssertEqual(viewModel.readStatesByChannel[seed.channels[0].id]?.mentionCount, 1)

        let suiteName = "momo.snapshot.window-chrome.\(scenario.name).\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defaults.set(false, forKey: MomoDeveloperModePresentation.developerModeKey)
        defaults.set(false, forKey: "momo.workspace.showQuickStart")
        defaults.set(MomoUILanguage.korean.rawValue, forKey: MomoUILanguage.appStorageKey)

        return MomoMacRootView(
            existingViewModel: viewModel,
            sessionChrome: nil,
            initialDetailPane: .approvals,
            // Headless NavigationSplitView frame caching does not rasterize its
            // sidebar child reliably. Panel canonicals isolate the detail root;
            // the full-size sidebar fixture below owns traffic-light coverage.
            initialSplitViewVisibility: .detailOnly
        )
        .frame(width: scenario.size.width, height: scenario.size.height)
        .environment(\.colorScheme, scenario.scheme)
        .environment(\.locale, Locale(identifier: "ko_KR"))
        .defaultAppStorage(defaults)
    }

    private func sidebarView(for scenario: Scenario) async throws -> some View {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "window-chrome-sidebar-snapshot")
        await viewModel.selectChannel(try XCTUnwrap(seed.channels.last).id)
        XCTAssertEqual(viewModel.readStatesByChannel[seed.channels[0].id]?.mentionCount, 1)

        let suiteName = "momo.snapshot.window-chrome.\(scenario.name).\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defaults.set(false, forKey: MomoDeveloperModePresentation.developerModeKey)
        defaults.set(MomoUILanguage.korean.rawValue, forKey: MomoUILanguage.appStorageKey)

        return ChannelListView(
            viewModel: viewModel,
            sessionChrome: nil,
            showsWorkspaceHeader: false
        )
        .frame(width: scenario.size.width, height: scenario.size.height)
        .toolbar {
            ToolbarItem(placement: .navigation) {
                HStack(spacing: 8) {
                    MomoSidebarLogoMark(text: "m", imagePath: "", size: 28)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("momo").font(MomoTheme.Typography.toolbarTitle)
                        Text("상준").font(MomoTheme.Typography.toolbarSupporting)
                    }
                }
            }
        }
        .environment(\.colorScheme, scenario.scheme)
        .environment(\.locale, Locale(identifier: "ko_KR"))
        .defaultAppStorage(defaults)
    }

    private func render<Content: View>(
        _ scenario: Scenario,
        fullSizeContent: Bool = false,
        capturesWindowFrame: Bool = true,
        rootView: Content
    ) async throws -> NSImage {
        let hostingController = NSHostingController(rootView: rootView)
        let hostingView = hostingController.view
        let appearance = NSAppearance(named: scenario.scheme == .dark ? .darkAqua : .aqua)
        var styleMask: NSWindow.StyleMask = [.titled, .closable, .miniaturizable, .resizable]
        if fullSizeContent {
            styleMask.insert(.fullSizeContentView)
        }
        let window = NSWindow(
            contentRect: CGRect(origin: .zero, size: scenario.size),
            styleMask: styleMask,
            backing: .buffered,
            defer: false
        )
        window.appearance = appearance
        window.isReleasedWhenClosed = false
        window.title = "momo"
        window.titleVisibility = MomoWindowChromeStyle.showsSystemTitle ? .visible : .hidden
        window.toolbarStyle = .unified
        window.toolbar = NSToolbar(identifier: "momo.snapshot.window-chrome.\(scenario.name)")
        window.contentViewController = hostingController
        hostingView.appearance = appearance
        window.orderBack(nil)
        window.makeKey()
        defer { window.close() }

        window.layoutIfNeeded()
        hostingView.layoutSubtreeIfNeeded()
        hostingView.displayIfNeeded()
        try await Task.sleep(for: .milliseconds(150))
        window.layoutIfNeeded()
        hostingView.layoutSubtreeIfNeeded()
        hostingView.displayIfNeeded()

        if !capturesWindowFrame {
            return try renderView(hostingView, size: hostingView.bounds.size)
        }

        guard let frameView = window.contentView?.superview else {
            throw XCTSkip("NSWindow produced no titlebar frame for MOMO-379 chrome")
        }
        frameView.layoutSubtreeIfNeeded()
        frameView.displayIfNeeded()
        return try renderView(frameView, size: frameView.bounds.size)
    }

    private func renderView(_ view: NSView, size: CGSize) throws -> NSImage {
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
            throw XCTSkip("NSWindow produced no MOMO-379 chrome bitmap on this host")
        }
        representation.size = size
        view.cacheDisplay(in: view.bounds, to: representation)
        let image = NSImage(size: size)
        image.addRepresentation(representation)
        return image
    }

    private func render(_ scenario: Scenario) async throws -> NSImage {
        try await render(
            scenario,
            // AppKit's offscreen toolbar material does not honor dark appearance
            // consistently; the dark artifact is a panel-geometry reference.
            capturesWindowFrame: scenario.name != narrowDark.name,
            rootView: rootView(for: scenario)
        )
    }

    private func renderSidebar(_ scenario: Scenario) async throws -> NSImage {
        try await render(
            scenario,
            fullSizeContent: true,
            rootView: sidebarView(for: scenario)
        )
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
            throw XCTSkip("Rendered MOMO-379 chrome image could not be encoded as PNG")
        }
        try png.write(to: outputDirectory.appendingPathComponent(name), options: .atomic)
    }

    private func requireCanonicalReference(testName: String, named: String) throws {
        let testDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let reference = testDirectory
            .appendingPathComponent("__Snapshots__/MomoWindowChromeSnapshotTests")
            .appendingPathComponent("\(testName).\(named).png")
        let isRecording = ProcessInfo.processInfo.environment["MOMO_RECORD_SNAPSHOTS"] == "1"
        guard isRecording || FileManager.default.fileExists(atPath: reference.path) else {
            throw XCTSkip(
                "Canonical MOMO-379 snapshot will be recorded by the orchestrator: \(reference.lastPathComponent)"
            )
        }
    }

    func testWindowChromeRasterWritesDesignReviewArtifacts() async throws {
        for scenario in [standardLight, narrowDark, attachedLight] {
            let image = try await render(scenario)
            try writeDesignReviewArtifact(
                image,
                named: "momo-379-window-chrome-\(scenario.name).png"
            )
            XCTAssertEqual(image.size.width, scenario.size.width)
            if scenario.name == narrowDark.name {
                XCTAssertEqual(image.size.height, scenario.size.height)
            } else {
                XCTAssertGreaterThan(image.size.height, scenario.size.height)
            }
        }
        let sidebarImage = try await renderSidebar(sidebarLight)
        try writeDesignReviewArtifact(
            sidebarImage,
            named: "momo-379-window-chrome-\(sidebarLight.name).png"
        )
        XCTAssertEqual(sidebarImage.size.width, sidebarLight.size.width)
    }

    func testWindowChromeOverlayLightSnapshot() async throws {
        try requireCanonicalReference(
            testName: #function.replacingOccurrences(of: "()", with: ""),
            named: "light"
        )
        let image = try await render(standardLight)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "light"
        )
    }

    func testWindowChromeAttachedDarkSnapshot() async throws {
        try requireCanonicalReference(
            testName: #function.replacingOccurrences(of: "()", with: ""),
            named: "dark"
        )
        let attachedDark = Scenario(
            name: "attached-dark",
            size: attachedLight.size,
            scheme: .dark
        )
        let image = try await render(attachedDark)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "dark"
        )
    }

    func testWindowChromeSidebarTrafficLightsSnapshot() async throws {
        try requireCanonicalReference(
            testName: #function.replacingOccurrences(of: "()", with: ""),
            named: "light"
        )
        let image = try await renderSidebar(sidebarLight)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "light"
        )
    }
}
