import AppKit
import MomoCore
import SnapshotTesting
import SwiftUI
import XCTest
@testable import MomoMac

// WH-2 (#706) canonical light/dark references are recorded by the orchestrator in
// its own environment. Worker runs rasterize the code-execution-host states for
// design review and skip the pixel assertion unless MOMO_VERIFY_706_SNAPSHOTS=1
// (verify against an existing baseline) or MOMO_RECORD_SNAPSHOTS=1 (record).
@MainActor
final class MomoWorkHostEngineSnapshotTests: XCTestCase {
    private let size = CGSize(width: 640, height: 760)

    private enum WorkHostSnapshotState {
        case pairedDefault
        case pairedDatabase
        case pairingOffline
        case loadFailed
    }

    func testPairedDefaultLightSnapshot() async throws {
        try await assertState(.pairedDefault, scheme: .light, language: .korean, name: "light", testName: #function)
    }

    func testPairedDefaultDarkSnapshot() async throws {
        try await assertState(.pairedDefault, scheme: .dark, language: .korean, name: "dark", testName: #function)
    }

    func testPairedDatabaseEnglishLightSnapshot() async throws {
        try await assertState(.pairedDatabase, scheme: .light, language: .english, name: "light", testName: #function)
    }

    func testPairingOfflineLightSnapshot() async throws {
        try await assertState(.pairingOffline, scheme: .light, language: .korean, name: "light", testName: #function)
    }

    func testLoadFailedDarkSnapshot() async throws {
        try await assertState(.loadFailed, scheme: .dark, language: .korean, name: "dark", testName: #function)
    }

    // MARK: - Harness

    private func assertState(
        _ state: WorkHostSnapshotState,
        scheme: ColorScheme,
        language: MomoUILanguage,
        name: String,
        testName: String
    ) async throws {
        let view = try await makeView(state, language: language)

        let styled = view
            .frame(width: size.width, height: size.height, alignment: .topLeading)
            .background(Color(nsColor: .windowBackgroundColor))
            .environment(\.colorScheme, scheme)
            .environment(\.locale, Locale(identifier: language == .korean ? "ko_KR" : "en_US"))

        let image = try await render(AnyView(styled), scheme: scheme)
        try writeDesignReviewArtifact(image, named: "momo-706-\(functionSlug(testName))-\(name).png")

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
        _ state: WorkHostSnapshotState,
        language: MomoUILanguage
    ) async throws -> MomoWorkHostEngineSettingsView {
        let fixture = WorkHostEngineFixture()
        switch state {
        case .pairedDefault:
            let client = MockWorkHostEngineClient(status: fixture.opencodeDefaultStatus)
            let model = fixture.model(client: client)
            await model.load()
            let host = WorkHostEngineFixture.host(displayName: "Momo on Seongjae MacBook Pro", online: true)
            return MomoWorkHostEngineSettingsView(
                language: language,
                model: model,
                pairing: MomoWorkHostPairing(state: .ready(host), heartbeatIssue: nil)
            )

        case .pairedDatabase:
            let client = MockWorkHostEngineClient(status: fixture.gooseDatabaseStatus)
            let model = fixture.model(client: client)
            await model.load()
            let host = WorkHostEngineFixture.host(displayName: "Momo on 인턴 iMac", online: true)
            return MomoWorkHostEngineSettingsView(
                language: language,
                model: model,
                pairing: MomoWorkHostPairing(state: .ready(host), heartbeatIssue: nil)
            )

        case .pairingOffline:
            let client = MockWorkHostEngineClient(status: fixture.codexLocalDatabaseStatus)
            let model = fixture.model(client: client)
            await model.load()
            let host = WorkHostEngineFixture.host(displayName: "Momo on Seongjae MacBook Pro", online: false)
            return MomoWorkHostEngineSettingsView(
                language: language,
                model: model,
                pairing: MomoWorkHostPairing(state: .ready(host), heartbeatIssue: .hostHeartbeatFailed)
            )

        case .loadFailed:
            let client = MockWorkHostEngineClient(
                status: fixture.opencodeDefaultStatus,
                getError: MomoProviderLinkClientError.http(status: 403, message: "forbidden")
            )
            let model = fixture.model(client: client)
            await model.load()
            return MomoWorkHostEngineSettingsView(
                language: language,
                model: model,
                pairing: MomoWorkHostPairing(state: .failed(.hostRegistrationFailed), heartbeatIssue: nil)
            )
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
            throw XCTSkip("NSHostingView produced no work-host bitmap on this host")
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
            .appendingPathComponent("__Snapshots__/MomoWorkHostEngineSnapshotTests")
            .appendingPathComponent("\(functionSlug(testName)).\(named).png")
        let environment = ProcessInfo.processInfo.environment
        let isRecording = environment["MOMO_RECORD_SNAPSHOTS"] == "1"
        let isVerifying = environment["MOMO_VERIFY_706_SNAPSHOTS"] == "1"
        guard isRecording || (isVerifying && FileManager.default.fileExists(atPath: reference.path)) else {
            throw XCTSkip(
                "Canonical WH-2 snapshot is recorded by the orchestrator: \(reference.lastPathComponent)"
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
            throw XCTSkip("Rendered work-host image could not be encoded as PNG")
        }
        try png.write(to: outputDirectory.appendingPathComponent(name), options: .atomic)
    }

    private func functionSlug(_ testName: String) -> String {
        testName.replacingOccurrences(of: "()", with: "")
    }
}
