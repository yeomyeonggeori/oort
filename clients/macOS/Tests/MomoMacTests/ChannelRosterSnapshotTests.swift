import XCTest
import SwiftUI
import AppKit
import SnapshotTesting
import MomoCore
@testable import MomoMac

// MOMO-357/365/367 change the sidebar hierarchy, capability badges, and unread state. New canonical references are
// intentionally absent in the worker patch; the macOS gate machine records
// them so host-dependent PNGs never become worker-authored baselines.
@MainActor
final class ChannelRosterSnapshotTests: XCTestCase {
    private func fixtureSidebar(
        _ scheme: ColorScheme,
        capabilitiesByHandle: [String: [String]] = [:],
        showsUnread: Bool = false,
        developerMode: Bool = true,
        showsUnreadDirectMessage: Bool = false
    ) async throws -> some View {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo(
            capabilitiesByHandle: capabilitiesByHandle,
            displayNamesByHandle: showsUnreadDirectMessage
                ? ["hermes": "Hermes Direct Message Partner"]
                : [:]
        )
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "snapshot")
        let general = try XCTUnwrap(seed.channels.first, "Demo roster fixture must include #general")

        if showsUnreadDirectMessage {
            let counterpart = try XCTUnwrap(seed.agents.first { $0.handle == "hermes" })
            await viewModel.startDirectMessage(with: counterpart.id)
            let directMessage = try XCTUnwrap(
                viewModel.channels.first { $0.kind == .dm },
                "DM roster fixture must create a direct-message channel"
            )
            await viewModel.selectChannel(general.id)
            for state in try await backend.readStates(workspace: seed.workspace) {
                _ = try await backend.markRead(channel: state.channelId, through: state.latestSeq)
            }
            for index in 1...7 {
                await backend.seedDemoMessage(
                    channel: directMessage.id,
                    author: counterpart.id,
                    body: "DM unread fixture \(index)"
                )
            }
            await viewModel.refreshReadStates()
            XCTAssertEqual(viewModel.readStatesByChannel[directMessage.id]?.unreadCount, 7)
        } else if !showsUnread {
            for state in try await backend.readStates(workspace: seed.workspace) {
                _ = try await backend.markRead(channel: state.channelId, through: state.latestSeq)
            }
            await viewModel.refreshReadStates()
        }
        await viewModel.selectChannel(general.id)

        let activeMembers = viewModel.activeMembers()
        XCTAssertTrue(activeMembers.contains { $0.handle == "hermes" && $0.isAgent })
        XCTAssertFalse(activeMembers.contains { $0.displayName == "빌드봇" })

        let defaults = UserDefaults(suiteName: "momo.snapshot.channel-roster")!
        defaults.removePersistentDomain(forName: "momo.snapshot.channel-roster")
        defaults.set(developerMode, forKey: MomoDeveloperModePresentation.developerModeKey)
        return ChannelListView(
            viewModel: viewModel,
            sessionChrome: nil,
            showsWorkspaceHeader: false
        )
            .frame(width: 340, height: 720)
            .environment(\.colorScheme, scheme)
            .defaultAppStorage(defaults)
    }

    private func render(
        _ scheme: ColorScheme,
        capabilitiesByHandle: [String: [String]] = [:],
        showsUnread: Bool = false,
        developerMode: Bool = true,
        showsUnreadDirectMessage: Bool = false
    ) async throws -> NSImage {
        let size = CGSize(width: 340, height: 720)
        let hostingView = NSHostingView(
            rootView: try await fixtureSidebar(
                scheme,
                capabilitiesByHandle: capabilitiesByHandle,
                showsUnread: showsUnread,
                developerMode: developerMode,
                showsUnreadDirectMessage: showsUnreadDirectMessage
            )
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

    private func mentionBadgePixelCount(in image: NSImage) throws -> Int {
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
                if color.redComponent > 0.70,
                   color.greenComponent < 0.48,
                   color.blueComponent < 0.50,
                   color.redComponent - color.greenComponent > 0.30 {
                    count += 1
                }
            }
        }
        return count
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
            throw XCTSkip("Rendered roster image could not be encoded as PNG")
        }
        try png.write(to: outputDirectory.appendingPathComponent(name), options: .atomic)
    }

    private func renderWorkspaceIdentityRecovery() throws -> NSImage {
        let size = CGSize(width: 340, height: 112)
        let copy = MomoWorkspaceCopy(language: .english)
        let presentation = try XCTUnwrap(
            MomoWorkspaceIdentityRecoveryPresentation(
                workspace: nil,
                usesCache: false,
                error: "network unavailable",
                copy: copy
            )
        )
        let hostingView = NSHostingView(
            rootView: ZStack {
                Color(nsColor: .windowBackgroundColor)
                MomoWorkspaceIdentityRecoveryButton(
                    presentation: presentation,
                    retry: {}
                )
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(width: size.width, height: size.height)
            .environment(\.colorScheme, .light)
            .environment(\.dynamicTypeSize, .accessibility2)
        )
        hostingView.frame = CGRect(origin: .zero, size: size)
        hostingView.appearance = NSAppearance(named: .accessibilityHighContrastAqua)
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
            throw XCTSkip("NSHostingView produced no workspace recovery bitmap on this host")
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
            .appendingPathComponent("__Snapshots__/ChannelRosterSnapshotTests")
            .appendingPathComponent("\(testName).\(named).png")
        let isRecording = ProcessInfo.processInfo.environment["MOMO_RECORD_SNAPSHOTS"] == "1"
        guard isRecording || FileManager.default.fileExists(atPath: reference.path) else {
            let ticket = testName.contains("DirectMessage")
                ? "MOMO-372"
                : (testName.contains("Capability")
                    ? "MOMO-365"
                    : (testName.contains("Unread") ? "MOMO-367" : "MOMO-357"))
            throw XCTSkip("Canonical \(ticket) snapshot will be recorded by the orchestrator: \(reference.lastPathComponent)")
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

    func testSidebarUnreadLightSnapshot() async throws {
        try requireCanonicalReference(testName: #function.replacingOccurrences(of: "()", with: ""), named: "light")
        let image = try await render(.light, showsUnread: true)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "light"
        )
    }

    func testSidebarUnreadDarkSnapshot() async throws {
        try requireCanonicalReference(testName: #function.replacingOccurrences(of: "()", with: ""), named: "dark")
        let image = try await render(.dark, showsUnread: true)
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

    func testCapabilitySidebarLightSnapshot() async throws {
        try requireCanonicalReference(
            testName: #function.replacingOccurrences(of: "()", with: ""),
            named: "light"
        )
        let image = try await render(
            .light,
            capabilitiesByHandle: ["hermes": ["code", "terminal", "docs"]]
        )
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "light"
        )
    }

    func testCapabilitySidebarDarkSnapshot() async throws {
        try requireCanonicalReference(
            testName: #function.replacingOccurrences(of: "()", with: ""),
            named: "dark"
        )
        let image = try await render(
            .dark,
            capabilitiesByHandle: ["hermes": ["code", "terminal", "docs"]]
        )
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "dark"
        )
    }

    func testCapabilitySidebarRasterAddsBadgeAccentPixels() async throws {
        for scheme in [ColorScheme.light, .dark] {
            let baseline = try await render(scheme)
            let capabilityRaster = try await render(
                scheme,
                capabilitiesByHandle: ["hermes": ["code", "terminal", "docs"]]
            )
            XCTAssertGreaterThan(
                try agentAccentPixelCount(in: capabilityRaster),
                try agentAccentPixelCount(in: baseline) + 20,
                "Capability chips must remain visible in the sidebar under \(scheme) mode"
            )
        }
    }

    func testSidebarUnreadRasterContainsMentionBadgePixels() async throws {
        for scheme in [ColorScheme.light, .dark] {
            let readImage = try await render(scheme)
            let unreadImage = try await render(scheme, showsUnread: true)
            try writeDesignReviewArtifact(
                unreadImage,
                named: "momo-369-sidebar-unread-\(scheme == .dark ? "dark" : "light").png"
            )
            XCTAssertGreaterThan(
                try mentionBadgePixelCount(in: unreadImage),
                try mentionBadgePixelCount(in: readImage) + 40,
                "Unread roster must add visible mention badge pixels in \(scheme) mode"
            )
        }
    }

    func testStandardSidebarRasterWritesDesignReviewArtifacts() async throws {
        for scheme in [ColorScheme.light, .dark] {
            let image = try await render(scheme, developerMode: false)
            try writeDesignReviewArtifact(
                image,
                named: "momo-370-sidebar-standard-\(scheme == .dark ? "dark" : "light").png"
            )
            XCTAssertEqual(image.size, CGSize(width: 340, height: 720))
        }
    }

    func testNoCacheWorkspaceRecoveryRendersAtIncreasedContrastAndLargeText() throws {
        let image = try renderWorkspaceIdentityRecovery()
        XCTAssertEqual(image.size, CGSize(width: 340, height: 112))
        let representation = try XCTUnwrap(
            image.tiffRepresentation.flatMap(NSBitmapImageRep.init(data:))
        )
        var distinctColors = Set<String>()
        for y in stride(from: 0, to: representation.pixelsHigh, by: 8) {
            for x in stride(from: 0, to: representation.pixelsWide, by: 8) {
                if let color = representation.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) {
                    distinctColors.insert(
                        "\(Int(color.redComponent * 31))-\(Int(color.greenComponent * 31))-\(Int(color.blueComponent * 31))"
                    )
                }
            }
        }
        XCTAssertGreaterThan(distinctColors.count, 8)
        try writeDesignReviewArtifact(
            image,
            named: "momo-383-workspace-no-cache-retry-increased-contrast-large-text.png"
        )
    }

    func testDirectMessageUnreadSidebarLightSnapshot() async throws {
        try requireCanonicalReference(
            testName: #function.replacingOccurrences(of: "()", with: ""),
            named: "light"
        )
        let image = try await render(.light, showsUnreadDirectMessage: true)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "light"
        )
    }

    func testDirectMessageUnreadSidebarDarkSnapshot() async throws {
        try requireCanonicalReference(
            testName: #function.replacingOccurrences(of: "()", with: ""),
            named: "dark"
        )
        let image = try await render(.dark, showsUnreadDirectMessage: true)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "dark"
        )
    }

    func testDirectMessageUnreadRasterContainsCounterpartAndCountBadgePixels() async throws {
        for scheme in [ColorScheme.light, .dark] {
            let baseline = try await render(scheme)
            let directMessageRaster = try await render(
                scheme,
                showsUnreadDirectMessage: true
            )
            try writeDesignReviewArtifact(
                directMessageRaster,
                named: "momo-372-sidebar-dm-unread-\(scheme == .dark ? "dark" : "light").png"
            )
            XCTAssertGreaterThan(
                try mentionBadgePixelCount(in: directMessageRaster),
                try mentionBadgePixelCount(in: baseline) + 40,
                "Unread DM roster must add a visible count badge in \(scheme) mode"
            )
        }
    }
}
