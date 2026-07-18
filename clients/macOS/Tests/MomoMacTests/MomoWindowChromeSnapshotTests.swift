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
        let initialDetailPane: MomoMacDetailPane?
        let initialPrimaryDestination: MomoMacPrimaryDestination

        init(
            name: String,
            size: CGSize,
            scheme: ColorScheme,
            initialDetailPane: MomoMacDetailPane?,
            initialPrimaryDestination: MomoMacPrimaryDestination = .channel
        ) {
            self.name = name
            self.size = size
            self.scheme = scheme
            self.initialDetailPane = initialDetailPane
            self.initialPrimaryDestination = initialPrimaryDestination
        }
    }

    private let standardLight = Scenario(
        name: "standard-light",
        size: CGSize(width: 1_180, height: 760),
        scheme: .light,
        initialDetailPane: .approvals
    )
    private let narrowDark = Scenario(
        name: "narrow-dark",
        size: CGSize(width: 980, height: 620),
        scheme: .dark,
        initialDetailPane: .approvals
    )
    private let attachedLight = Scenario(
        name: "attached-light",
        size: CGSize(width: 1_800, height: 900),
        scheme: .light,
        initialDetailPane: .approvals
    )
    private let attachedDark = Scenario(
        name: "attached-dark",
        size: CGSize(width: 1_800, height: 900),
        scheme: .dark,
        initialDetailPane: .approvals
    )
    private let memberInspectorStandardLight = Scenario(
        name: "member-inspector-standard-light",
        size: CGSize(width: 1_180, height: 760),
        scheme: .light,
        initialDetailPane: nil
    )
    private let memberInspectorStandardDark = Scenario(
        name: "member-inspector-standard-dark",
        size: CGSize(width: 1_180, height: 760),
        scheme: .dark,
        initialDetailPane: nil
    )
    private let memberInspectorNarrowLight = Scenario(
        name: "member-inspector-narrow-light",
        size: CGSize(width: 980, height: 620),
        scheme: .light,
        initialDetailPane: nil
    )
    private let memberInspectorNarrowDark = Scenario(
        name: "member-inspector-narrow-dark",
        size: CGSize(width: 980, height: 620),
        scheme: .dark,
        initialDetailPane: nil
    )
    private let pluginMarketplaceStandardLight = Scenario(
        name: "plugin-marketplace-standard-light",
        size: CGSize(width: 1_180, height: 760),
        scheme: .light,
        initialDetailPane: nil,
        initialPrimaryDestination: .plugins
    )

    private func rootView(for scenario: Scenario) async throws -> some View {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo(baseTimestampMs: 1_752_572_700_000)
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
        defaults.set("상준", forKey: "momo.profile.displayName")

        return MomoMacRootView(
            existingViewModel: viewModel,
            sessionChrome: nil,
            initialDetailPane: scenario.initialDetailPane,
            initialSplitViewVisibility: .all,
            initialPrimaryDestination: scenario.initialPrimaryDestination
        )
        .frame(width: scenario.size.width, height: scenario.size.height)
        .environment(\.colorScheme, scenario.scheme)
        .environment(\.locale, Locale(identifier: "ko_KR"))
        .defaultAppStorage(defaults)
    }

    private func render(
        _ scenario: Scenario,
        requiresWindowServer: Bool = false
    ) async throws -> NSImage {
        // Appearance is pinned on the window and hosting view below. Mutating
        // NSApplication.shared.appearance propagates asynchronously and bleeds
        // into later offscreen snapshot renders (MOMO-472 full-suite flake).
        let appearance = NSAppearance(named: scenario.scheme == .dark ? .darkAqua : .aqua)

        let hostingController = NSHostingController(rootView: try await rootView(for: scenario))
        let hostingView = hostingController.view
        let window = NSWindow(
            contentRect: CGRect(origin: .zero, size: scenario.size),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.appearance = appearance
        window.isReleasedWhenClosed = false
        window.title = "momo"
        window.contentViewController = hostingController
        MomoWindowChromeStyle.applyFlatUnifiedChrome(to: window)
        XCTAssertNil(window.toolbar)
        hostingView.appearance = appearance

        let usesWindowServer = !NSScreen.screens.isEmpty
        if usesWindowServer {
            window.makeKeyAndOrderFront(nil)
        } else if requiresWindowServer {
            throw XCTSkip(
                "Canonical MOMO-379 chrome requires a WindowServer compositor; headless cacheDisplay is not recordable"
            )
        }
        hostingController.sizingOptions = []
        // NSHostingController initially proposes the root's fitting size as
        // content below the titlebar. Reassert the requested *window frame* so
        // the canonical includes, rather than adds, the unified titlebar.
        window.setFrame(
            CGRect(origin: window.frame.origin, size: scenario.size),
            display: false
        )
        defer {
            window.close()
        }

        window.layoutIfNeeded()
        hostingView.layoutSubtreeIfNeeded()
        hostingView.displayIfNeeded()
        try await Task.sleep(for: .milliseconds(300))
        window.layoutIfNeeded()
        hostingView.layoutSubtreeIfNeeded()
        hostingView.displayIfNeeded()

        let contentLayoutRect = hostingView.convert(window.contentLayoutRect, from: nil)
        let metrics = MomoWindowChromeMetrics.measure(
            contentViewBounds: hostingView.bounds,
            contentLayoutRect: contentLayoutRect,
            contentViewIsFlipped: hostingView.isFlipped
        )
        XCTAssertTrue(window.styleMask.contains(.fullSizeContentView))
        XCTAssertGreaterThan(metrics.topInset, 0, "canonical host must reproduce the unified titlebar band")

        if usesWindowServer {
            guard let cgImage = CGWindowListCreateImage(
                .null,
                .optionIncludingWindow,
                CGWindowID(window.windowNumber),
                [.boundsIgnoreFraming, .bestResolution]
            ) else {
                throw XCTSkip("WindowServer could not capture the MOMO-379 production window")
            }
            let scale = window.backingScaleFactor
            let expectedPixelSize = CGSize(
                width: scenario.size.width * scale,
                height: scenario.size.height * scale
            )
            let captureRect = CGRect(
                x: (CGFloat(cgImage.width) - expectedPixelSize.width) / 2,
                y: (CGFloat(cgImage.height) - expectedPixelSize.height) / 2,
                width: expectedPixelSize.width,
                height: expectedPixelSize.height
            ).integral
            guard captureRect.minX >= 0,
                  captureRect.minY >= 0,
                  captureRect.maxX <= CGFloat(cgImage.width),
                  captureRect.maxY <= CGFloat(cgImage.height),
                  let normalizedCapture = cgImage.cropping(to: captureRect)
            else {
                throw XCTSkip("WindowServer capture was smaller than the requested MOMO chrome frame")
            }
            return NSImage(cgImage: normalizedCapture, size: scenario.size)
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

    private var snapshotRecordMode: SnapshotTestingConfiguration.Record? {
        ProcessInfo.processInfo.environment["MOMO_RECORD_SNAPSHOTS"] == "1" ? .all : nil
    }

    func testWindowChromeRasterWritesDesignReviewArtifacts() async throws {
        let scenarios = if NSScreen.screens.isEmpty {
            // cacheDisplay does not composite dark NavigationSplitView
            // materials. Never emit those white-slab artifacts as evidence.
            [standardLight, attachedLight]
        } else {
            [standardLight, narrowDark, attachedLight, attachedDark]
        }
        for scenario in scenarios {
            let image = try await render(scenario)
            try writeDesignReviewArtifact(
                image,
                named: "momo-379-window-chrome-\(scenario.name).png"
            )
            XCTAssertEqual(image.size.width, scenario.size.width)
            XCTAssertEqual(image.size.height, scenario.size.height)
        }
    }

    func testMemberInspectorWritesStandardNarrowLightDarkRealWindowArtifacts() async throws {
        let scenarios = [
            memberInspectorStandardLight,
            memberInspectorStandardDark,
            memberInspectorNarrowLight,
            memberInspectorNarrowDark,
        ]
        for scenario in scenarios {
            let image = try await render(scenario, requiresWindowServer: true)
            try writeDesignReviewArtifact(
                image,
                named: "momo-385-\(scenario.name).png"
            )
            XCTAssertEqual(image.size.width, scenario.size.width)
            XCTAssertEqual(image.size.height, scenario.size.height)
        }
    }

    func testChannelNavigationWritesStandardAndNarrowRealWindowArtifacts() async throws {
        let scenarios = [memberInspectorNarrowDark, memberInspectorStandardLight]
        for scenario in scenarios {
            let image = try await render(scenario, requiresWindowServer: true)
            try writeDesignReviewArtifact(
                image,
                named: "momo-392-channel-navigation-\(scenario.name).png"
            )
            XCTAssertEqual(image.size.width, scenario.size.width)
            XCTAssertEqual(image.size.height, scenario.size.height)
        }
    }

    func testPluginMarketplaceWritesRealWindowArtifact() async throws {
        let image = try await render(pluginMarketplaceStandardLight, requiresWindowServer: true)
        try writeDesignReviewArtifact(
            image,
            named: "momo-464-plugin-marketplace-standard-light.png"
        )
        XCTAssertEqual(image.size.width, pluginMarketplaceStandardLight.size.width)
        XCTAssertEqual(image.size.height, pluginMarketplaceStandardLight.size.height)
    }

    func testWindowChromeOverlayLightSnapshot() async throws {
        try requireCanonicalReference(
            testName: #function.replacingOccurrences(of: "()", with: ""),
            named: "light"
        )
        // Light mode is stable through the offscreen NSWindow fallback used by
        // the artifact test above, so workers can refresh copy-sensitive canonicals.
        let image = try await render(standardLight)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "light",
            record: snapshotRecordMode
        )
    }

    func testWindowChromeAttachedDarkSnapshot() async throws {
        try requireCanonicalReference(
            testName: #function.replacingOccurrences(of: "()", with: ""),
            named: "dark"
        )
        let image = try await render(attachedDark, requiresWindowServer: true)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "dark",
            record: snapshotRecordMode
        )
    }

    func testWindowChromeNarrowDarkSnapshot() async throws {
        try requireCanonicalReference(
            testName: #function.replacingOccurrences(of: "()", with: ""),
            named: "dark"
        )
        let image = try await render(narrowDark, requiresWindowServer: true)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "dark",
            record: snapshotRecordMode
        )
    }
}
