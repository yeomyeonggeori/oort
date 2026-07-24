import XCTest
import SwiftUI
import AppKit
import SnapshotTesting
import MomoCore
@testable import MomoMac

// MOMO-593 sidebar update pill. Canonical light/dark references are recorded by
// the orchestrator (baseline env = orchestrator); worker runs render and, absent
// a baseline, skip rather than record. The fixture uses a realistic Korean +
// English alpha version label so the pill never truncates the version or the
// dismiss control.
@MainActor
final class UpdatePillSnapshotTests: XCTestCase {
    private let size = CGSize(width: 280, height: 64)

    private func fixture(_ scheme: ColorScheme, model: MomoUpdatePillModel) -> some View {
        MomoUpdatePillView(language: .korean, openUpdates: {}, model: model)
            .frame(width: size.width, height: size.height, alignment: .bottom)
            .background(Color(nsColor: .textBackgroundColor))
            .environment(\.colorScheme, scheme)
            .environment(\.locale, Locale(identifier: "ko_KR"))
    }

    private func render(_ scheme: ColorScheme) async throws -> NSImage {
        let model = MomoUpdatePillModel(interval: 3_600, check: { updatePillSnapshotStatus() })
        await model.refresh()

        let hostingView = NSHostingView(rootView: fixture(scheme, model: model))
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
            throw XCTSkip("NSHostingView produced no update pill bitmap on this host")
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
            .appendingPathComponent("__Snapshots__/UpdatePillSnapshotTests")
            .appendingPathComponent("\(testName).\(named).png")
        let isRecording = ProcessInfo.processInfo.environment["MOMO_RECORD_SNAPSHOTS"] == "1"
        guard isRecording || FileManager.default.fileExists(atPath: reference.path) else {
            throw XCTSkip(
                "Canonical MOMO-593 snapshot will be recorded by the orchestrator: \(reference.lastPathComponent)"
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
            throw XCTSkip("Rendered update pill image could not be encoded as PNG")
        }
        try png.write(to: outputDirectory.appendingPathComponent(name), options: .atomic)
    }

    func testUpdatePillWritesDesignReviewArtifacts() async throws {
        for scheme in [ColorScheme.light, .dark] {
            let suffix = scheme == .dark ? "dark" : "light"
            let image = try await render(scheme)
            try writeDesignReviewArtifact(image, named: "momo-593-update-pill-\(suffix).png")
            XCTAssertEqual(image.size, size)
        }
    }

    func testUpdatePillLightSnapshot() async throws {
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

    func testUpdatePillDarkSnapshot() async throws {
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

private func updatePillSnapshotStatus() -> MomoMacUpdateChannelStatus {
    MomoMacUpdateChannelStatus(
        currentVersion: MomoMacAppVersion(version: "0.9.0", build: "128"),
        manifest: MomoMacUpdateManifest(
            version: "0.9.1",
            build: "131",
            summary: "알파 채널 새 빌드 · Alpha refresh",
            downloadURL: URL(string: "file:///tmp/momo-alpha.zip")
        ),
        state: .updateAvailable
    )
}
