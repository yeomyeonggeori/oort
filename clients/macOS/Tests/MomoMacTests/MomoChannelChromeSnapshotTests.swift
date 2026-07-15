import XCTest
import SwiftUI
import AppKit
import SnapshotTesting
import MomoCore
@testable import MomoMac

// MOMO-371 canonical light/dark references are recorded by the orchestrator.
// Worker tests still rasterize the header and native settings sheet for review.
@MainActor
final class MomoChannelChromeSnapshotTests: XCTestCase {
    private let size = CGSize(width: 700, height: 640)

    private func fixture(
        _ scheme: ColorScheme,
        contrast: ColorSchemeContrast = .standard,
        dynamicTypeSize: DynamicTypeSize = .large
    ) async throws -> some View {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "snapshot")
        let channel = try XCTUnwrap(seed.channels.first)
        await viewModel.selectChannel(channel.id)

        let presentation = MomoChannelPresentation(
            name: "product-feedback-and-실사용-진단",
            topic: "내부 10인 dogfood에서 발견한 흐름과 English feedback을 함께 정리합니다. 긴 텍스트도 겹치거나 잘리지 않아야 합니다."
        )

        return VStack(spacing: 0) {
            MomoChannelHeaderView(
                channel: channel,
                presentation: presentation,
                memberCount: viewModel.activeMembers(in: channel.id).count,
                realtimeStatus: nil,
                spentMicroUSD: 0,
                showsCosts: true,
                copy: MomoWorkspaceCopy(language: .korean),
                retryRealtime: nil,
                openMemberDirectory: {}
            )

            MomoChannelSettingsSheet(
                copy: MomoWorkspaceCopy(language: .korean),
                channel: channel,
                presentation: presentation,
                viewModel: viewModel,
                onSavePresentation: { _ in }
            )
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .background(Color(nsColor: .windowBackgroundColor))
        .environment(\.colorScheme, scheme)
        .environment(\.momoColorSchemeContrastOverride, contrast)
        .environment(\.dynamicTypeSize, dynamicTypeSize)
        .environment(
            \.sizeCategory,
            dynamicTypeSize == .xxxLarge ? .extraExtraExtraLarge : .large
        )
        .environment(\.locale, Locale(identifier: "ko_KR"))
    }

    private func render(
        _ scheme: ColorScheme,
        increasedContrast: Bool = false,
        dynamicTypeSize: DynamicTypeSize = .large
    ) async throws -> NSImage {
        let rootView = try await fixture(
            scheme,
            contrast: increasedContrast ? .increased : .standard,
            dynamicTypeSize: dynamicTypeSize
        )
        // Accessibility appearances produce corrupt offscreen glyph masks on
        // some CI hosts. The fixture injects the same contrast state through
        // the app's headless-only environment seam instead.
        let appearanceName: NSAppearance.Name = switch scheme {
        case .dark: .darkAqua
        default: .aqua
        }
        let hostingView = NSHostingView(rootView: rootView)
        let appearance = NSAppearance(named: appearanceName)
        hostingView.appearance = appearance
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
        // Native default buttons can still be between appearance frames after
        // an offscreen host switches from Aqua to Dark Aqua. Let AppKit settle,
        // then redraw so design-review evidence never captures that transient.
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
            throw XCTSkip("NSHostingView produced no channel chrome bitmap on this host")
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
            .appendingPathComponent("__Snapshots__/MomoChannelChromeSnapshotTests")
            .appendingPathComponent("\(testName).\(named).png")
        let isRecording = ProcessInfo.processInfo.environment["MOMO_RECORD_SNAPSHOTS"] == "1"
        guard isRecording || FileManager.default.fileExists(atPath: reference.path) else {
            throw XCTSkip(
                "Canonical MOMO-371 snapshot will be recorded by the orchestrator: \(reference.lastPathComponent)"
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
            throw XCTSkip("Rendered channel chrome image could not be encoded as PNG")
        }
        try png.write(to: outputDirectory.appendingPathComponent(name), options: .atomic)
    }

    private func pngData(_ image: NSImage) throws -> Data {
        guard let tiff = image.tiffRepresentation,
              let representation = NSBitmapImageRep(data: tiff),
              let png = representation.representation(using: .png, properties: [:])
        else {
            throw XCTSkip("Rendered channel chrome image could not be encoded as PNG")
        }
        return png
    }

    func testChannelChromeRasterWritesDesignReviewArtifacts() async throws {
        var defaultImages: [ColorScheme: NSImage] = [:]
        for scheme in [ColorScheme.light, .dark] {
            let image = try await render(scheme)
            defaultImages[scheme] = image
            try writeDesignReviewArtifact(
                image,
                named: "momo-371-channel-chrome-\(scheme == .dark ? "dark" : "light").png"
            )
            XCTAssertEqual(image.size, size)
        }

        let increasedContrast = try await render(.light, increasedContrast: true)
        try writeDesignReviewArtifact(increasedContrast, named: "momo-371-channel-chrome-increased-contrast.png")
        XCTAssertEqual(increasedContrast.size, size)
        XCTAssertNotEqual(try pngData(increasedContrast), try pngData(XCTUnwrap(defaultImages[.light])))

        let largeType = try await render(.dark, dynamicTypeSize: .xxxLarge)
        try writeDesignReviewArtifact(largeType, named: "momo-371-channel-chrome-large-type.png")
        XCTAssertEqual(largeType.size, size)
        XCTAssertNotEqual(try pngData(largeType), try pngData(XCTUnwrap(defaultImages[.dark])))
    }

    func testChannelChromeLightSnapshot() async throws {
        try requireCanonicalReference(
            testName: #function.replacingOccurrences(of: "()", with: ""),
            named: "light"
        )
        let image = try await render(.light)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "light"
        )
    }

    func testChannelChromeDarkSnapshot() async throws {
        try requireCanonicalReference(
            testName: #function.replacingOccurrences(of: "()", with: ""),
            named: "dark"
        )
        let image = try await render(.dark)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "dark"
        )
    }
}
