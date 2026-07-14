import XCTest
import SwiftUI
import AppKit
import SnapshotTesting
import MomoCore
@testable import MomoMac

// MOMO-372 adds the member directory and DM entry point. Worker runs render
// review artifacts, while canonical host-dependent PNGs remain orchestrator-owned.
@MainActor
final class MemberDirectorySnapshotTests: XCTestCase {
    private func size(for pane: MomoMemberDirectoryCapturePane) -> CGSize {
        switch pane {
        case .list:
            return CGSize(
                width: MomoTheme.MemberDirectory.listMaximumWidth,
                height: MomoTheme.MemberDirectory.minimumHeight
            )
        case .detail:
            return CGSize(
                width: MomoTheme.MemberDirectory.idealWidth - MomoTheme.MemberDirectory.listIdealWidth,
                height: MomoTheme.MemberDirectory.minimumHeight
            )
        }
    }

    private func fixture(
        _ scheme: ColorScheme,
        pane: MomoMemberDirectoryCapturePane
    ) async throws -> some View {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo(
            capabilitiesByHandle: ["hermes": ["code", "terminal", "docs"]],
            displayNamesByHandle: [
                "sangjun": "곽성재 Product Operations and Internal Alpha",
                "hermes": "Hermes 코드 리뷰와 배포 준비 에이전트",
                "buildbot": "빌드봇 Release Verification Assistant",
            ]
        )
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "snapshot")

        let defaults = UserDefaults(suiteName: "momo.snapshot.member-directory")!
        defaults.removePersistentDomain(forName: "momo.snapshot.member-directory")
        return MemberDirectoryView(
            viewModel: viewModel,
            initialSelection: seed.agents.first?.id,
            capturePane: pane
        )
            .frame(width: size(for: pane).width, height: size(for: pane).height)
            .environment(\.colorScheme, scheme)
            .environment(\.controlActiveState, .active)
            .defaultAppStorage(defaults)
    }

    private func render(
        _ scheme: ColorScheme,
        pane: MomoMemberDirectoryCapturePane
    ) async throws -> NSImage {
        let contentSize = size(for: pane)
        let window = NSWindow(
            contentRect: CGRect(origin: .zero, size: contentSize),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        let appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
        window.appearance = appearance
        window.backgroundColor = .windowBackgroundColor
        let hostingController = NSHostingController(
            rootView: try await fixture(scheme, pane: pane)
        )
        hostingController.view.appearance = appearance
        window.contentViewController = hostingController
        window.setContentSize(contentSize)
        window.layoutIfNeeded()
        try? await Task.sleep(for: .milliseconds(100))
        window.layoutIfNeeded()

        guard let captureView = window.contentView else {
            throw XCTSkip("NSWindow produced no member-directory pane frame on this host")
        }
        captureView.appearance = appearance
        captureView.layoutSubtreeIfNeeded()
        captureView.displayIfNeeded()
        let size = captureView.bounds.size

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
            throw XCTSkip("NSWindow produced no member-directory-pane bitmap on this host")
        }
        representation.size = size
        captureView.cacheDisplay(in: captureView.bounds, to: representation)

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
            throw XCTSkip("Member-directory raster could not be encoded as PNG")
        }
        try png.write(to: outputDirectory.appendingPathComponent(name), options: .atomic)
    }

    private func pixelCount(
        in image: NSImage,
        topLeftRect: CGRect,
        matching predicate: (NSColor) -> Bool
    ) throws -> Int {
        guard let tiff = image.tiffRepresentation,
              let representation = NSBitmapImageRep(data: tiff)
        else {
            throw XCTSkip("Member-directory raster has no readable bitmap")
        }

        let scaleX = CGFloat(representation.pixelsWide) / image.size.width
        let scaleY = CGFloat(representation.pixelsHigh) / image.size.height
        let minimumX = max(0, Int(topLeftRect.minX * scaleX))
        let maximumX = min(representation.pixelsWide, Int(topLeftRect.maxX * scaleX))
        let minimumY = max(0, Int(topLeftRect.minY * scaleY))
        let maximumY = min(representation.pixelsHigh, Int(topLeftRect.maxY * scaleY))

        var count = 0
        for y in minimumY..<maximumY {
            for x in minimumX..<maximumX {
                guard let color = representation.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else {
                    continue
                }
                if predicate(color) { count += 1 }
            }
        }
        return count
    }

    private func foregroundPixelCount(
        in image: NSImage,
        topLeftRect: CGRect,
        scheme: ColorScheme
    ) throws -> Int {
        try pixelCount(in: image, topLeftRect: topLeftRect) { color in
            let luminance = 0.2126 * color.redComponent
                + 0.7152 * color.greenComponent
                + 0.0722 * color.blueComponent
            return scheme == .dark ? luminance > 0.62 : luminance < 0.48
        }
    }

    private func agentAccentPixelCount(in image: NSImage, topLeftRect: CGRect) throws -> Int {
        try pixelCount(in: image, topLeftRect: topLeftRect) { color in
            color.blueComponent > 0.62
                && color.redComponent > 0.28
                && color.blueComponent - color.greenComponent > 0.16
        }
    }

    private func brightButtonLabelSegmentCounts(in image: NSImage) throws -> [Int] {
        let textOnlySegments = [
            CGRect(x: 384, y: 316, width: 20, height: 16),
            CGRect(x: 404, y: 316, width: 20, height: 16),
            CGRect(x: 424, y: 316, width: 28, height: 16),
        ]
        return try textOnlySegments.map { segment in
            try pixelCount(in: image, topLeftRect: segment) { color in
                let luminance = 0.2126 * color.redComponent
                    + 0.7152 * color.greenComponent
                    + 0.0722 * color.blueComponent
                return luminance > 0.78
            }
        }
    }

    private func requireCanonicalReference(testName: String, named: String) throws {
        let testDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let reference = testDirectory
            .appendingPathComponent("__Snapshots__/MemberDirectorySnapshotTests")
            .appendingPathComponent("\(testName).\(named).png")
        let isRecording = ProcessInfo.processInfo.environment["MOMO_RECORD_SNAPSHOTS"] == "1"
        guard isRecording || FileManager.default.fileExists(atPath: reference.path) else {
            throw XCTSkip(
                "Canonical MOMO-372 snapshot will be recorded by the orchestrator: \(reference.lastPathComponent)"
            )
        }
    }

    func testMemberDirectoryListLightSnapshot() async throws {
        try requireCanonicalReference(
            testName: #function.replacingOccurrences(of: "()", with: ""),
            named: "light"
        )
        let image = try await render(.light, pane: .list)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "light"
        )
    }

    func testMemberDirectoryListDarkSnapshot() async throws {
        try requireCanonicalReference(
            testName: #function.replacingOccurrences(of: "()", with: ""),
            named: "dark"
        )
        let image = try await render(.dark, pane: .list)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "dark"
        )
    }

    func testMemberDirectoryDetailLightSnapshot() async throws {
        try requireCanonicalReference(
            testName: #function.replacingOccurrences(of: "()", with: ""),
            named: "light"
        )
        let image = try await render(.light, pane: .detail)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "light"
        )
    }

    func testMemberDirectoryDetailDarkSnapshot() async throws {
        try requireCanonicalReference(
            testName: #function.replacingOccurrences(of: "()", with: ""),
            named: "dark"
        )
        let image = try await render(.dark, pane: .detail)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "dark"
        )
    }

    func testMemberDirectoryPaneRastersContainDirectoryControlsAndLongMixedNames() async throws {
        for scheme in [ColorScheme.light, .dark] {
            let listImage = try await render(scheme, pane: .list)
            let detailImage = try await render(scheme, pane: .detail)
            XCTAssertEqual(listImage.size, size(for: .list))
            XCTAssertEqual(detailImage.size, size(for: .detail))
            XCTAssertGreaterThan(
                try foregroundPixelCount(
                    in: listImage,
                    topLeftRect: CGRect(x: 90, y: 4, width: 260, height: 64),
                    scheme: scheme
                ),
                120,
                "Member-directory search field must contain rasterized icon and prompt pixels in \(scheme) mode"
            )
            XCTAssertGreaterThan(
                try foregroundPixelCount(
                    in: listImage,
                    topLeftRect: CGRect(x: 12, y: 4, width: 80, height: 64),
                    scheme: scheme
                ),
                40,
                "Member-directory close control must contain rasterized label pixels in \(scheme) mode"
            )
            XCTAssertGreaterThan(
                try agentAccentPixelCount(
                    in: listImage,
                    topLeftRect: CGRect(x: 16, y: 96, width: 330, height: 180)
                ),
                100,
                "Member-directory list must contain rasterized agent rows in \(scheme) mode"
            )
            let titleSegmentCounts = try brightButtonLabelSegmentCounts(in: detailImage)
            XCTAssertTrue(
                titleSegmentCounts.allSatisfy { $0 > 16 },
                "Member-directory DM button must rasterize title pixels across its full width in \(scheme) mode; segments=\(titleSegmentCounts)"
            )
            try writeDesignReviewArtifact(
                listImage,
                named: "momo-372-member-directory-list-\(scheme == .dark ? "dark" : "light").png"
            )
            try writeDesignReviewArtifact(
                detailImage,
                named: "momo-372-member-directory-detail-\(scheme == .dark ? "dark" : "light").png"
            )
        }
    }
}
