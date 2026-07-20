import AppKit
import SnapshotTesting
import SwiftUI
import XCTest
@testable import MomoMac

@MainActor
final class MomoWorkConsoleSnapshotTests: XCTestCase {
    private var snapshotRecordMode: SnapshotTestingConfiguration.Record? {
        ProcessInfo.processInfo.environment["MOMO_RECORD_SNAPSHOTS"] == "1" ? .all : nil
    }

    private func requireCanonicalReference(testName: String, named: String) throws {
        let testDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let reference = testDirectory
            .appendingPathComponent("__Snapshots__/MomoWorkConsoleSnapshotTests")
            .appendingPathComponent("\(testName).\(named).png")
        let isRecording = ProcessInfo.processInfo.environment["MOMO_RECORD_SNAPSHOTS"] == "1"
        guard isRecording || FileManager.default.fileExists(atPath: reference.path) else {
            throw XCTSkip(
                "Canonical MOMO-495 snapshot will be recorded by the orchestrator: \(reference.lastPathComponent)"
            )
        }
    }

    func testTerminalDarkPresetSnapshot() throws {
        try assertTerminalSnapshot(.dark, named: "dark", testName: #function)
    }

    func testTerminalLightPresetSnapshot() throws {
        try assertTerminalSnapshot(.light, named: "light", testName: #function)
    }

    func testTerminalHighContrastPresetSnapshot() throws {
        try assertTerminalSnapshot(.highContrast, named: "high-contrast", testName: #function)
    }

    func testTerminalColorBlindSafePresetSnapshot() throws {
        try assertTerminalSnapshot(
            .colorBlindSafe,
            named: "color-vision-friendly",
            testName: #function
        )
    }

    func testWorkConsoleSettingsLightSnapshot() throws {
        try assertSettingsSnapshot(.light, named: "light", testName: #function)
    }

    func testWorkConsoleSettingsDarkSnapshot() throws {
        try assertSettingsSnapshot(.dark, named: "dark", testName: #function)
    }

    private func assertTerminalSnapshot(
        _ preset: MomoTerminalThemePreset,
        named: String,
        testName: String
    ) throws {
        let canonicalName = testName.replacingOccurrences(of: "()", with: "")
        try requireCanonicalReference(testName: canonicalName, named: named)
        let size = CGSize(width: 720, height: 360)
        let content = MomoTerminalThemePreview(preset: preset)
            .frame(width: size.width, height: size.height)
        let image = try render(content, size: size, scheme: .light)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: named,
            record: snapshotRecordMode,
            testName: canonicalName
        )
    }

    private func assertSettingsSnapshot(
        _ scheme: ColorScheme,
        named: String,
        testName: String
    ) throws {
        let canonicalName = testName.replacingOccurrences(of: "()", with: "")
        try requireCanonicalReference(testName: canonicalName, named: named)
        let controller = MomoWorkConsoleController(
            viewModel: ChatViewModel(backend: LiveChatBackend()),
            initialHostRegistrationState: .registering
        )
        let defaults = UserDefaults(
            suiteName: "MomoWorkConsoleSnapshotTests-\(scheme)-\(UUID())"
        )!
        let preferences = MomoWorkConsolePreferences(defaults: defaults)
        preferences.setTerminalTheme(scheme == .dark ? .dark : .light)
        let size = CGSize(width: 400, height: 640)
        let content = MomoWorkConsoleSettingsView(
            controller: controller,
            preferences: preferences,
            copy: MomoWorkspaceCopy(language: .korean)
        )
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .background(Color(nsColor: .windowBackgroundColor))
        let image = try render(content, size: size, scheme: scheme)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: named,
            record: snapshotRecordMode,
            testName: canonicalName
        )
    }

    private func render<Content: View>(
        _ content: Content,
        size: CGSize,
        scheme: ColorScheme
    ) throws -> NSImage {
        let hostingView = NSHostingView(
            rootView: content.environment(\.colorScheme, scheme)
        )
        hostingView.frame = CGRect(origin: .zero, size: size)
        hostingView.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
        hostingView.layoutSubtreeIfNeeded()
        hostingView.displayIfNeeded()
        guard let representation = hostingView.bitmapImageRepForCachingDisplay(in: hostingView.bounds) else {
            throw XCTSkip("NSHostingView produced no Work Console bitmap on this host")
        }
        hostingView.cacheDisplay(in: hostingView.bounds, to: representation)
        let image = NSImage(size: size)
        image.addRepresentation(representation)
        return image
    }
}
