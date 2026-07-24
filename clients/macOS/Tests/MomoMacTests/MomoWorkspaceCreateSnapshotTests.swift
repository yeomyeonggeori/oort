import AppKit
import MomoCore
import SnapshotTesting
import SwiftUI
import XCTest
@testable import MomoMac

// MOMO-590 canonical light/dark references are recorded by the orchestrator
// (MOMO_RECORD_SNAPSHOTS=1). Worker runs rasterize the workspace-create states for
// design review and skip the pixel assertion when no baseline exists.
@MainActor
final class MomoWorkspaceCreateSnapshotTests: XCTestCase {
    private let size = CGSize(width: 560, height: 640)

    private enum CreateSnapshotState {
        case form
        case filled
        case slugConflict
        case offline
        case success
        case unavailable
    }

    func testFormLightSnapshot() async throws {
        try await assertState(.form, scheme: .light, language: .korean, name: "light", testName: #function)
    }

    func testFormDarkSnapshot() async throws {
        try await assertState(.form, scheme: .dark, language: .korean, name: "dark", testName: #function)
    }

    func testFilledLightSnapshot() async throws {
        try await assertState(.filled, scheme: .light, language: .korean, name: "light", testName: #function)
    }

    func testSlugConflictLightSnapshot() async throws {
        try await assertState(.slugConflict, scheme: .light, language: .korean, name: "light", testName: #function)
    }

    func testOfflineDarkSnapshot() async throws {
        try await assertState(.offline, scheme: .dark, language: .korean, name: "dark", testName: #function)
    }

    func testSuccessLightSnapshot() async throws {
        try await assertState(.success, scheme: .light, language: .korean, name: "light", testName: #function)
    }

    func testSuccessEnglishLightSnapshot() async throws {
        try await assertState(.success, scheme: .light, language: .english, name: "light", testName: #function)
    }

    func testUnavailableLightSnapshot() async throws {
        try await assertState(.unavailable, scheme: .light, language: .korean, name: "light", testName: #function)
    }

    // MARK: - Harness

    private func assertState(
        _ state: CreateSnapshotState,
        scheme: ColorScheme,
        language: MomoUILanguage,
        name: String,
        testName: String
    ) async throws {
        let view = makeView(state, language: language)

        let styled = view
            .frame(width: size.width, height: size.height, alignment: .topLeading)
            .background(Color(nsColor: .windowBackgroundColor))
            .environment(\.colorScheme, scheme)
            .environment(\.locale, Locale(identifier: language == .korean ? "ko_KR" : "en_US"))

        let image = try await render(AnyView(styled), scheme: scheme)
        try writeDesignReviewArtifact(image, named: "momo-590-\(functionSlug(testName))-\(name).png")

        try requireCanonicalReference(testName: testName, named: name)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: name,
            record: snapshotRecordMode,
            testName: functionSlug(testName)
        )
    }

    // Render the pure content view with explicit state so every state rasterizes
    // deterministically (no dependence on @StateObject publish timing).
    private func makeView(
        _ state: CreateSnapshotState,
        language: MomoUILanguage
    ) -> WorkspaceCreateSnapshotHost {
        let copy = MomoWorkspaceCreateCopy(language: language)
        let created = MomoCreatedWorkspace(
            workspaceId: WorkspaceID(uuidString: "00000000-0000-7000-8000-0000000007a1")!,
            slug: "momo-core-team",
            name: language == .korean ? "모모 코어팀" : "Momo Core Team"
        )
        switch state {
        case .form:
            return WorkspaceCreateSnapshotHost(copy: copy, name: "", slug: "")
        case .filled:
            return WorkspaceCreateSnapshotHost(
                copy: copy, name: "Momo Core Team", slug: "momo-core-team", canCreate: true
            )
        case .slugConflict:
            return WorkspaceCreateSnapshotHost(
                copy: copy, name: "Momo Core Team", slug: "momo-core-team",
                attemptedSubmission: true, failure: .slugConflict
            )
        case .offline:
            return WorkspaceCreateSnapshotHost(
                copy: copy, name: "Momo Core Team", slug: "momo-core-team",
                attemptedSubmission: true, failure: .offline, canCreate: true
            )
        case .success:
            return WorkspaceCreateSnapshotHost(
                copy: copy, name: created.name, slug: created.slug, created: created
            )
        case .unavailable:
            return WorkspaceCreateSnapshotHost(copy: copy, name: "", slug: "", isAuthorized: false)
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
            throw XCTSkip("NSHostingView produced no workspace-create bitmap on this host")
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
            .appendingPathComponent("__Snapshots__/MomoWorkspaceCreateSnapshotTests")
            .appendingPathComponent("\(functionSlug(testName)).\(named).png")
        let isRecording = ProcessInfo.processInfo.environment["MOMO_RECORD_SNAPSHOTS"] == "1"
        guard isRecording || FileManager.default.fileExists(atPath: reference.path) else {
            throw XCTSkip(
                "Canonical MOMO-590 snapshot will be recorded by the orchestrator: \(reference.lastPathComponent)"
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
            throw XCTSkip("Rendered workspace-create image could not be encoded as PNG")
        }
        try png.write(to: outputDirectory.appendingPathComponent(name), options: .atomic)
    }

    private func functionSlug(_ testName: String) -> String {
        testName.replacingOccurrences(of: "()", with: "")
    }
}

/// Owns the @FocusState the content view requires and renders the pure content
/// with the exact state under test.
struct WorkspaceCreateSnapshotHost: View {
    let copy: MomoWorkspaceCreateCopy
    @State var name: String
    @State var slug: String
    var isAuthorized: Bool = true
    var slugManuallyEdited: Bool = false
    var attemptedSubmission: Bool = false
    var failure: MomoWorkspaceCreateFailure?
    var isCreating: Bool = false
    var canCreate: Bool = false
    var created: MomoCreatedWorkspace?
    @FocusState private var focus: MomoWorkspaceCreateField?

    var body: some View {
        MomoWorkspaceCreateSheetContent(
            copy: copy,
            name: $name,
            slug: $slug,
            isAuthorized: isAuthorized,
            nameIsValid: MomoWorkspaceName.isValid(name),
            slugIsValid: MomoWorkspaceSlug.isValid(slug),
            slugManuallyEdited: slugManuallyEdited,
            attemptedSubmission: attemptedSubmission,
            failure: failure,
            isCreating: isCreating,
            canCreate: canCreate,
            created: created,
            focusedField: $focus,
            cancel: {},
            create: {},
            resetSlug: {},
            switchToWorkspace: { _ in }
        )
    }
}
