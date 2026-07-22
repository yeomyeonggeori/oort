import AppKit
import MomoCore
import SnapshotTesting
import SwiftUI
import XCTest
@testable import MomoMac

@MainActor
final class MomoEventSubscriptionSnapshotTests: XCTestCase {
    private let listSize = CGSize(width: 640, height: 440)
    private let secretSize = CGSize(width: 480, height: 420)

    private var recordMode: SnapshotTestingConfiguration.Record? {
        ProcessInfo.processInfo.environment["MOMO_RECORD_SNAPSHOTS"] == "1" ? .all : nil
    }

    func testOutboundSubscriptionsLightSnapshot() async throws {
        try await assertListSnapshot(.light, name: "light", testName: #function)
    }

    func testOutboundSubscriptionsDarkSnapshot() async throws {
        try await assertListSnapshot(.dark, name: "dark", testName: #function)
    }

    func testOneTimeSecretLightSnapshot() async throws {
        try await assertSecretSnapshot(.light, name: "light", testName: #function)
    }

    func testOneTimeSecretDarkSnapshot() async throws {
        try await assertSecretSnapshot(.dark, name: "dark", testName: #function)
    }

    func testOutboundSubscriptionsIncreasedContrastSnapshot() async throws {
        try await assertListSnapshot(
            .light,
            name: "increased-contrast",
            testName: #function,
            contrast: .increased
        )
    }

    func testOutboundSubscriptionsLargeTypeSnapshot() async throws {
        try await assertListSnapshot(
            .dark,
            name: "large-type",
            testName: #function,
            dynamicTypeSize: .xxxLarge
        )
    }

    private func assertListSnapshot(
        _ scheme: ColorScheme,
        name: String,
        testName: String,
        contrast: ColorSchemeContrast = .standard,
        dynamicTypeSize: DynamicTypeSize = .large
    ) async throws {
        let fixture = EventSubscriptionFixture()
        let values = [
            fixture.subscription(
                id: UUID(uuidString: "00000000-0000-7000-8000-000000000604")!,
                enabled: false
            ),
            fixture.subscription(
                id: UUID(uuidString: "00000000-0000-7000-8000-000000000603")!,
                enabled: false,
                reason: .serverFailureThreshold,
                kinds: [.approvalRequest, .workStatusChanged]
            ),
            fixture.subscription(
                id: UUID(uuidString: "00000000-0000-7000-8000-000000000602")!,
                enabled: false,
                reason: .disabledByAdmin,
                kinds: [.approvalRequest]
            ),
            fixture.subscription(
                enabled: true,
                kinds: [.mention, .approvalRequest, .workStatusChanged]
            ),
        ]
        let client = MockEventSubscriptionClient(listed: values, created: fixture.secret)
        let view = MomoEventSubscriptionSettingsView(
            language: .korean,
            workspaceID: fixture.workspace,
            context: fixture.context,
            client: client
        )
        .frame(width: listSize.width, height: listSize.height)
        .background(Color(nsColor: .windowBackgroundColor))
        .environment(\.colorScheme, scheme)
        .environment(\.momoColorSchemeContrastOverride, contrast)
        .environment(\.dynamicTypeSize, dynamicTypeSize)
        .environment(
            \.sizeCategory,
            dynamicTypeSize == .xxxLarge ? .extraExtraExtraLarge : .large
        )
        .environment(\.locale, Locale(identifier: "ko_KR"))

        let image = try await render(AnyView(view), size: listSize, scheme: scheme)
        try writeArtifact(image, named: "momo-551-outbound-\(name).png")
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: name,
            record: recordMode,
            testName: testName.replacingOccurrences(of: "()", with: "")
        )
    }

    private func assertSecretSnapshot(
        _ scheme: ColorScheme,
        name: String,
        testName: String
    ) async throws {
        let fixture = EventSubscriptionFixture()
        let view = MomoEventSubscriptionSecretView(
            copy: .init(language: .korean),
            secret: fixture.secret,
            copied: true,
            onCopy: {},
            onDismiss: {}
        )
        .frame(width: secretSize.width, height: secretSize.height)
        .background(Color(nsColor: .windowBackgroundColor))
        .environment(\.colorScheme, scheme)
        .environment(\.locale, Locale(identifier: "ko_KR"))

        let image = try await render(AnyView(view), size: secretSize, scheme: scheme)
        try writeArtifact(image, named: "momo-551-one-time-secret-\(name).png")
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: name,
            record: recordMode,
            testName: testName.replacingOccurrences(of: "()", with: "")
        )
    }

    private func render(
        _ view: AnyView,
        size: CGSize,
        scheme: ColorScheme
    ) async throws -> NSImage {
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
            throw XCTSkip("Outbound subscription view produced no bitmap")
        }
        representation.size = size
        hostingView.cacheDisplay(in: hostingView.bounds, to: representation)
        let image = NSImage(size: size)
        image.addRepresentation(representation)
        return image
    }

    private func writeArtifact(_ image: NSImage, named name: String) throws {
        guard let rawDirectory = ProcessInfo.processInfo.environment["MOMO_DESIGN_REVIEW_ARTIFACT_DIR"] else {
            return
        }
        let directory = URL(fileURLWithPath: rawDirectory, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let tiff = image.tiffRepresentation,
              let representation = NSBitmapImageRep(data: tiff),
              let png = representation.representation(using: .png, properties: [:])
        else { throw XCTSkip("Outbound subscription snapshot could not be encoded") }
        try png.write(to: directory.appendingPathComponent(name), options: .atomic)
    }
}
