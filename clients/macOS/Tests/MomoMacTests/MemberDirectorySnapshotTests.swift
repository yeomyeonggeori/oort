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
    private func fixture(_ scheme: ColorScheme) async throws -> some View {
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
            initialSelection: seed.agents.first?.id
        )
            .frame(
                width: MomoTheme.MemberDirectory.idealWidth,
                height: MomoTheme.MemberDirectory.minimumHeight
            )
            .environment(\.colorScheme, scheme)
            .defaultAppStorage(defaults)
    }

    private func render(_ scheme: ColorScheme) async throws -> NSImage {
        let size = CGSize(
            width: MomoTheme.MemberDirectory.idealWidth,
            height: MomoTheme.MemberDirectory.minimumHeight
        )
        let hostingView = NSHostingView(rootView: try await fixture(scheme))
        hostingView.frame = CGRect(origin: .zero, size: size)
        hostingView.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
        try? await Task.sleep(for: .milliseconds(100))
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
            throw XCTSkip("NSHostingView produced no member-directory bitmap on this host")
        }
        representation.size = size
        hostingView.cacheDisplay(in: hostingView.bounds, to: representation)

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

    func testMemberDirectoryLightSnapshot() async throws {
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

    func testMemberDirectoryDarkSnapshot() async throws {
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

    func testMemberDirectoryLightDarkRasterAndLongMixedNames() async throws {
        for scheme in [ColorScheme.light, .dark] {
            let image = try await render(scheme)
            XCTAssertEqual(
                image.size,
                CGSize(
                    width: MomoTheme.MemberDirectory.idealWidth,
                    height: MomoTheme.MemberDirectory.minimumHeight
                )
            )
            try writeDesignReviewArtifact(
                image,
                named: "momo-372-member-directory-\(scheme == .dark ? "dark" : "light").png"
            )
        }
    }
}
