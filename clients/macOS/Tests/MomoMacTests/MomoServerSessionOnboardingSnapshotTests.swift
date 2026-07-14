import XCTest
import SwiftUI
import AppKit
import SnapshotTesting
@testable import MomoMac

// MOMO-368 canonical references are recorded by the orchestrator so the worker
// never authors host-dependent light/dark PNG baselines.
@MainActor
final class MomoServerSessionOnboardingSnapshotTests: XCTestCase {
    private let defaultSize = CGSize(width: 980, height: 760)
    private let largeSize = CGSize(width: 1_600, height: 1_000)
    private let compactSize = CGSize(width: 700, height: 760)
    private let settingsSize = CGSize(width: 680, height: 560)

    private func fixture(
        scheme: ColorScheme,
        form: MomoServerSessionForm? = nil,
        errorMessage: String? = nil,
        failureKind: MomoSessionFailureKind? = nil,
        initialFocus: MomoSessionField? = nil,
        developerMode: Bool = true
    ) -> some View {
        let suite = "momo.snapshot.onboarding.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.set(MomoUILanguage.korean.rawValue, forKey: MomoUILanguage.appStorageKey)
        defaults.set(developerMode, forKey: MomoDeveloperModePresentation.developerModeKey)
        let store = MomoServerSessionStore(
            defaults: defaults,
            keychain: MomoKeychainPasswordStore(service: suite),
            prefix: "snapshot."
        )
        let controller = MomoServerSessionController(store: store)
        controller.form = form ?? MomoServerSessionForm(
            baseURLString: "https://team.momo.local",
            email: "sungjae@momo.team",
            password: "",
            inviteCode: "",
            savePassword: false
        )

        return MomoServerSessionChooser(
            controller: controller,
            errorMessage: errorMessage,
            failureKind: failureKind,
            initialFocus: initialFocus
        )
            .environment(\.colorScheme, scheme)
            .defaultAppStorage(defaults)
    }

    private func render(
        size: CGSize,
        scheme: ColorScheme,
        form: MomoServerSessionForm? = nil,
        errorMessage: String? = nil,
        failureKind: MomoSessionFailureKind? = nil,
        initialFocus: MomoSessionField? = nil,
        developerMode: Bool = true
    ) throws -> NSImage {
        let hostingView = NSHostingView(
            rootView: fixture(
                scheme: scheme,
                form: form,
                errorMessage: errorMessage,
                failureKind: failureKind,
                initialFocus: initialFocus,
                developerMode: developerMode
            )
            .frame(width: size.width, height: size.height)
        )
        let appearanceName: NSAppearance.Name = scheme == .dark ? .darkAqua : .aqua
        let appearance = NSAppearance(named: appearanceName)
        let window = NSWindow(
            contentRect: CGRect(origin: .zero, size: size),
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.appearance = appearance
        hostingView.appearance = appearance
        hostingView.frame = CGRect(origin: .zero, size: size)
        window.contentView = hostingView
        window.layoutIfNeeded()
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
            throw XCTSkip("NSHostingView produced no onboarding bitmap on this host")
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
            .appendingPathComponent("__Snapshots__/MomoServerSessionOnboardingSnapshotTests")
            .appendingPathComponent("\(testName).\(named).png")
        let isRecording = ProcessInfo.processInfo.environment["MOMO_RECORD_SNAPSHOTS"] == "1"
        guard isRecording || FileManager.default.fileExists(atPath: reference.path) else {
            throw XCTSkip(
                "Canonical MOMO-368 snapshot will be recorded by the orchestrator: \(reference.lastPathComponent)"
            )
        }
    }

    private func renderSettings(
        scheme: ColorScheme,
        developerMode: Bool,
        showCosts: Bool
    ) throws -> NSImage {
        let suite = "momo.snapshot.settings.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.set(MomoUILanguage.korean.rawValue, forKey: MomoUILanguage.appStorageKey)
        defaults.set(developerMode, forKey: MomoDeveloperModePresentation.developerModeKey)
        defaults.set(showCosts, forKey: MomoDeveloperModePresentation.costDisplayKey)
        let hostingView = NSHostingView(
            rootView: ZStack {
                Color(nsColor: .windowBackgroundColor)
                    .ignoresSafeArea()
                MomoAppSettingsSurface(copy: MomoWorkspaceCopy(language: .korean))
            }
                .frame(width: settingsSize.width, height: settingsSize.height)
                .environment(\.colorScheme, scheme)
                .defaultAppStorage(defaults)
        )
        let appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
        let window = NSWindow(
            contentRect: CGRect(origin: .zero, size: settingsSize),
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.appearance = appearance
        hostingView.frame = CGRect(origin: .zero, size: settingsSize)
        hostingView.appearance = appearance
        window.contentView = hostingView
        window.layoutIfNeeded()
        hostingView.layoutSubtreeIfNeeded()
        hostingView.displayIfNeeded()

        guard let representation = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: Int(settingsSize.width * 2),
            pixelsHigh: Int(settingsSize.height * 2),
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else {
            throw XCTSkip("NSHostingView produced no settings bitmap on this host")
        }
        representation.size = settingsSize
        hostingView.cacheDisplay(in: hostingView.bounds, to: representation)
        let image = NSImage(size: settingsSize)
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
            throw XCTSkip("Rendered onboarding image could not be encoded as PNG")
        }
        try png.write(to: outputDirectory.appendingPathComponent(name), options: .atomic)
    }

    func testOnboardingDefaultWidthLightSnapshot() throws {
        try requireCanonicalReference(testName: #function.replacingOccurrences(of: "()", with: ""), named: "light")
        assertSnapshot(
            of: try render(size: defaultSize, scheme: .light),
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "light"
        )
    }

    func testOnboardingDefaultWidthDarkSnapshot() throws {
        try requireCanonicalReference(testName: #function.replacingOccurrences(of: "()", with: ""), named: "dark")
        assertSnapshot(
            of: try render(size: defaultSize, scheme: .dark),
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "dark"
        )
    }

    func testOnboardingLargeWidthLightSnapshot() throws {
        try requireCanonicalReference(testName: #function.replacingOccurrences(of: "()", with: ""), named: "light")
        assertSnapshot(
            of: try render(size: largeSize, scheme: .light),
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "light"
        )
    }

    func testOnboardingLargeWidthDarkSnapshot() throws {
        try requireCanonicalReference(testName: #function.replacingOccurrences(of: "()", with: ""), named: "dark")
        assertSnapshot(
            of: try render(size: largeSize, scheme: .dark),
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "dark"
        )
    }

    func testOnboardingDesignReviewRasters() throws {
        typealias Variant = (
            name: String,
            size: CGSize,
            scheme: ColorScheme,
            form: MomoServerSessionForm?,
            errorMessage: String?,
            failureKind: MomoSessionFailureKind?,
            initialFocus: MomoSessionField?
        )
        let credentials = MomoServerSessionForm(
            baseURLString: "https://team.momo.local",
            email: "sungjae@momo.team",
            password: "team-password"
        )
        let invite = MomoServerSessionForm(
            baseURLString: "https://team.momo.local",
            email: "sungjae@momo.team",
            password: "team-password",
            inviteCode: "MOMO-368"
        )
        let variants: [Variant] = [
            ("onboarding-default-light.png", defaultSize, .light, nil, nil, nil, nil),
            ("onboarding-default-dark.png", defaultSize, .dark, nil, nil, nil, nil),
            ("onboarding-large-light.png", largeSize, .light, nil, nil, nil, nil),
            ("onboarding-large-dark.png", largeSize, .dark, nil, nil, nil, nil),
            ("onboarding-compact-light.png", compactSize, .light, nil, nil, nil, nil),
            ("onboarding-focused-field.png", defaultSize, .light, nil, nil, nil, .serverURL),
            ("onboarding-sign-in.png", defaultSize, .light, credentials, nil, nil, nil),
            ("onboarding-invite-enabled.png", defaultSize, .dark, invite, nil, nil, nil),
            (
                "onboarding-offline.png",
                defaultSize,
                .light,
                credentials,
                "The Internet connection appears to be offline.",
                .offline,
                nil
            ),
        ]

        for variant in variants {
            let image = try render(
                size: variant.size,
                scheme: variant.scheme,
                form: variant.form,
                errorMessage: variant.errorMessage,
                failureKind: variant.failureKind,
                initialFocus: variant.initialFocus
            )
            XCTAssertEqual(image.size, variant.size)
            try writeDesignReviewArtifact(image, named: variant.name)
        }
    }

    func testStandardOnboardingHidesLocalAlphaDetailsInDesignReviewRasters() throws {
        for scheme in [ColorScheme.light, .dark] {
            let image = try render(
                size: defaultSize,
                scheme: scheme,
                developerMode: false
            )
            try writeDesignReviewArtifact(
                image,
                named: "momo-370-onboarding-standard-\(scheme == .dark ? "dark" : "light").png"
            )
            XCTAssertEqual(image.size, defaultSize)
        }
    }

    func testDeveloperModeSettingsWriteDesignReviewRasters() throws {
        let modes: [(String, Bool, Bool)] = [
            ("standard", false, false),
            ("developer", true, true),
        ]
        for (mode, developerMode, showCosts) in modes {
            for scheme in [ColorScheme.light, .dark] {
                let image = try renderSettings(
                    scheme: scheme,
                    developerMode: developerMode,
                    showCosts: showCosts
                )
                try writeDesignReviewArtifact(
                    image,
                    named: "momo-370-settings-\(mode)-\(scheme == .dark ? "dark" : "light").png"
                )
                XCTAssertEqual(image.size, settingsSize)
            }
        }
    }
}
