import AppKit
import MomoCore
import SnapshotTesting
import SwiftUI
import XCTest
@testable import MomoMac

// MOMO-574 canonical light/dark references are recorded by the orchestrator
// (MOMO_RECORD_SNAPSHOTS=1). Worker runs rasterize the four provider-link states
// for design review and skip the pixel assertion when no baseline exists.
@MainActor
final class MomoProviderLinkSnapshotTests: XCTestCase {
    private let size = CGSize(width: 640, height: 760)

    private enum ProviderSnapshotState {
        case connected
        case notConfigured
        case testing
        case failed
    }

    func testConnectedLightSnapshot() async throws {
        try await assertState(.connected, scheme: .light, language: .korean, name: "light", testName: #function)
    }

    func testConnectedDarkSnapshot() async throws {
        try await assertState(.connected, scheme: .dark, language: .korean, name: "dark", testName: #function)
    }

    func testNotConfiguredLightSnapshot() async throws {
        try await assertState(.notConfigured, scheme: .light, language: .korean, name: "light", testName: #function)
    }

    func testTestingLightSnapshot() async throws {
        try await assertState(.testing, scheme: .light, language: .korean, name: "light", testName: #function)
    }

    func testFailedDarkSnapshot() async throws {
        try await assertState(.failed, scheme: .dark, language: .korean, name: "dark", testName: #function)
    }

    func testConnectedEnglishLightSnapshot() async throws {
        try await assertState(.connected, scheme: .light, language: .english, name: "light", testName: #function)
    }

    // MARK: - Harness

    private func assertState(
        _ state: ProviderSnapshotState,
        scheme: ColorScheme,
        language: MomoUILanguage,
        name: String,
        testName: String
    ) async throws {
        let (view, ongoing) = try await makeView(state, language: language)
        defer { ongoing?.cancel() }

        let styled = view
            .frame(width: size.width, height: size.height, alignment: .topLeading)
            .background(Color(nsColor: .windowBackgroundColor))
            .environment(\.colorScheme, scheme)
            .environment(\.locale, Locale(identifier: language == .korean ? "ko_KR" : "en_US"))

        let image = try await render(AnyView(styled), scheme: scheme)
        try writeDesignReviewArtifact(image, named: "momo-574-\(functionSlug(testName))-\(name).png")

        try requireCanonicalReference(testName: testName, named: name)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: name,
            record: snapshotRecordMode,
            testName: functionSlug(testName)
        )
    }

    private func makeView(
        _ state: ProviderSnapshotState,
        language: MomoUILanguage
    ) async throws -> (MomoProviderLinkSettingsView, Task<Void, Never>?) {
        let fixture = ProviderLinkFixture()
        switch state {
        case .connected:
            let client = MockProviderLinkClient(status: fixture.databaseStatus)
            let model = fixture.model(client: client)
            await model.load()
            return (MomoProviderLinkSettingsView(language: language, model: model), nil)

        case .notConfigured:
            let client = MockProviderLinkClient(status: fixture.environmentStatus)
            let model = fixture.model(client: client)
            await model.load()
            return (MomoProviderLinkSettingsView(language: language, model: model), nil)

        case .testing:
            let client = MockProviderLinkClient(
                status: fixture.databaseStatus,
                testResult: fixture.successfulTest,
                testDelayNanoseconds: 3_000_000_000
            )
            let model = fixture.model(client: client)
            await model.load()
            let task = Task { _ = await model.test() }
            await Task.yield()
            return (MomoProviderLinkSettingsView(language: language, model: model), task)

        case .failed:
            let client = MockProviderLinkClient(status: fixture.databaseStatus, testResult: fixture.failedTest)
            let model = fixture.model(client: client)
            await model.load()
            await model.test()
            return (MomoProviderLinkSettingsView(language: language, model: model), nil)
        }
    }

    private func render(_ view: AnyView, scheme: ColorScheme) async throws -> NSImage {
        let appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
        let hostingView = NSHostingView(rootView: view)
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

        try await Task.sleep(for: .milliseconds(180))
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
            throw XCTSkip("NSHostingView produced no provider-link bitmap on this host")
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
            .appendingPathComponent("__Snapshots__/MomoProviderLinkSnapshotTests")
            .appendingPathComponent("\(functionSlug(testName)).\(named).png")
        let isRecording = ProcessInfo.processInfo.environment["MOMO_RECORD_SNAPSHOTS"] == "1"
        guard isRecording || FileManager.default.fileExists(atPath: reference.path) else {
            throw XCTSkip(
                "Canonical MOMO-574 snapshot will be recorded by the orchestrator: \(reference.lastPathComponent)"
            )
        }
    }

    private var snapshotRecordMode: SnapshotTestingConfiguration.Record? {
        ProcessInfo.processInfo.environment["MOMO_RECORD_SNAPSHOTS"] == "1" ? .all : nil
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
            throw XCTSkip("Rendered provider-link image could not be encoded as PNG")
        }
        try png.write(to: outputDirectory.appendingPathComponent(name), options: .atomic)
    }

    private func functionSlug(_ testName: String) -> String {
        testName.replacingOccurrences(of: "()", with: "")
    }
}
