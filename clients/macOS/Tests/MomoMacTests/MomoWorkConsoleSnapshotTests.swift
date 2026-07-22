import AppKit
import MomoACPHost
import MomoCore
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

    func testWorkConsoleSettingsLightSnapshot() async throws {
        try await assertSettingsSnapshot(.light, named: "light", testName: #function)
    }

    func testWorkConsoleSettingsDarkSnapshot() async throws {
        try await assertSettingsSnapshot(.dark, named: "dark", testName: #function)
    }

    func testACPSessionCardLightSnapshot() throws {
        try assertACPCardSnapshot(.light, named: "light", testName: #function)
    }

    func testACPSessionCardDarkSnapshot() throws {
        try assertACPCardSnapshot(.dark, named: "dark", testName: #function)
    }

    func testACPApprovedLightSnapshot() throws {
        try assertACPCardSnapshot(.light, named: "light", testName: #function, state: .approved)
    }

    func testACPApprovedDarkSnapshot() throws {
        try assertACPCardSnapshot(.dark, named: "dark", testName: #function, state: .approved)
    }

    func testACPRejectedLightSnapshot() throws {
        try assertACPCardSnapshot(.light, named: "light", testName: #function, state: .rejected)
    }

    func testACPRejectedDarkSnapshot() throws {
        try assertACPCardSnapshot(.dark, named: "dark", testName: #function, state: .rejected)
    }

    func testACPSessionEndedLightSnapshot() throws {
        try assertACPCardSnapshot(.light, named: "light", testName: #function, state: .ended)
    }

    func testACPSessionEndedDarkSnapshot() throws {
        try assertACPCardSnapshot(.dark, named: "dark", testName: #function, state: .ended)
    }

    func testACPSessionFailedLightSnapshot() throws {
        try assertACPCardSnapshot(.light, named: "light", testName: #function, state: .failed)
    }

    func testACPSessionFailedDarkSnapshot() throws {
        try assertACPCardSnapshot(.dark, named: "dark", testName: #function, state: .failed)
    }

    func testWorkToolProfileEditorLightSnapshot() async throws {
        try await assertToolProfileEditorSnapshot(.light, named: "light", testName: #function)
    }

    func testWorkToolProfileEditorDarkSnapshot() async throws {
        try await assertToolProfileEditorSnapshot(.dark, named: "dark", testName: #function)
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
    ) async throws {
        let canonicalName = testName.replacingOccurrences(of: "()", with: "")
        try requireCanonicalReference(testName: canonicalName, named: named)
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "snapshot-owner")
        let controller = MomoWorkConsoleController(
            viewModel: viewModel,
            initialHostRegistrationState: .registering,
            initialToolProfiles: [snapshotToolProfile()]
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

    private func assertACPCardSnapshot(
        _ scheme: ColorScheme,
        named: String,
        testName: String,
        state: ACPCardSnapshotState = .pending
    ) throws {
        let canonicalName = testName.replacingOccurrences(of: "()", with: "")
        try requireCanonicalReference(testName: canonicalName, named: named)
        let size = CGSize(width: 560, height: 520)
        let content = MomoACPSessionCard(
            session: MomoLocalACPSession(
                previewEvents: snapshotACPEvents(state: state),
                previewIsRunning: state.keepsSessionRunning,
                previewStopReason: state == .ended ? "end_turn" : nil,
                previewErrorLabel: state == .failed ? "acp_session_failed" : nil
            ),
            toolDisplayName: "OpenCode",
            sessionLabel: "결제 모듈 회귀 점검",
            copy: MomoWorkspaceCopy(language: .korean)
        )
        .padding(24)
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .momoFlatSurface(.background)
        let image = try render(content, size: size, scheme: scheme)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: named,
            record: snapshotRecordMode,
            testName: canonicalName
        )
    }

    private func assertToolProfileEditorSnapshot(
        _ scheme: ColorScheme,
        named: String,
        testName: String
    ) async throws {
        let canonicalName = testName.replacingOccurrences(of: "()", with: "")
        try requireCanonicalReference(testName: canonicalName, named: named)
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "snapshot-owner")
        let controller = MomoWorkConsoleController(
            viewModel: viewModel,
            initialToolProfiles: [snapshotToolProfile()]
        )
        let size = CGSize(width: 400, height: 640)
        let content = MomoWorkToolProfileEditor(
            controller: controller,
            profile: snapshotToolProfile(),
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

    private func snapshotToolProfile() -> MomoWorkToolProfile {
        MomoWorkToolProfile(
            id: UUID(uuidString: "00000000-0000-7000-8000-000000000532")!,
            workspaceId: WorkspaceID(uuidString: "00000000-0000-7000-8000-000000000001")!,
            toolKey: "opencode-acp",
            displayName: "OpenCode ACP",
            launchTemplate: MomoWorkToolLaunchTemplate(command: "opencode-acp", arguments: ["--stdio"]),
            tierDefaults: [
                "transport": .string("acp"),
                "permission_policy": .string("confirm"),
                "risk": .string("medium"),
            ],
            enabled: true,
            createdBy: MemberID(uuidString: "00000000-0000-7000-8000-000000000101")!,
            updatedBy: MemberID(uuidString: "00000000-0000-7000-8000-000000000101")!,
            createdAtMs: 1_784_452_700_000,
            updatedAtMs: 1_784_452_800_000
        )
    }

    private func snapshotACPEvents(state: ACPCardSnapshotState) -> [ACPProjectedEvent] {
        let context: [String: ACPValue] = [
            "work_session_id": .string("00000000-0000-7000-8000-000000000532"),
        ]
        var events = [
            ACPProjectedEvent(
                type: "agent.status",
                timestampMs: 1,
                payload: .object(context.merging([
                    "detail": .string("수정 범위와 검증 순서를 정리했습니다."),
                    "plan": .array([
                        .object(["content": .string("관련 코드 확인"), "status": .string("completed")]),
                        .object(["content": .string("변경 적용"), "status": .string("in_progress")]),
                        .object(["content": .string("테스트 실행"), "status": .string("pending")]),
                    ]),
                ]) { _, new in new })
            ),
            ACPProjectedEvent(
                type: "agent.status",
                timestampMs: 2,
                payload: .object(context.merging([
                    "detail": .string("테스트 명령 실행을 준비합니다."),
                    "_meta": .object(["acp": .object([
                        "sessionUpdate": .string("tool_call"),
                        "toolCallId": .string("tool-1"),
                        "title": .string("Swift 테스트 실행"),
                        "kind": .string("execute"),
                        "status": .string("pending"),
                    ])]),
                ]) { _, new in new })
            ),
            ACPProjectedEvent(
                type: "approval.requested",
                timestampMs: 3,
                payload: .object(context.merging([
                    "options": .array([
                        snapshotPermission("allow-once", "이번만 허용", "allow_once"),
                        snapshotPermission("allow-always", "항상 허용", "allow_always"),
                        snapshotPermission("reject-once", "이번만 거부", "reject_once"),
                        snapshotPermission("reject-always", "항상 거부", "reject_always"),
                    ]),
                    "_meta": .object(["acp": .object(["tool_call": .object([
                        "title": .string("Swift 테스트 실행"), "kind": .string("execute"),
                    ])])]),
                ]) { _, new in new })
            ),
        ]
        if state == .approved || state == .rejected {
            events.append(
                ACPProjectedEvent(
                    type: "approval.decided",
                    timestampMs: 4,
                    payload: .object(context.merging([
                        "status": .string(state == .approved ? "approved" : "rejected"),
                        "option_id": .string(state == .approved ? "allow-once" : "reject-once"),
                    ]) { _, new in new })
                )
            )
        }
        if state == .ended {
            return Array(events.prefix(2))
        }
        return events
    }

    private func snapshotPermission(_ id: String, _ name: String, _ kind: String) -> ACPValue {
        .object([
            "option_id": .string(id),
            "name": .string(name),
            "kind": .string(kind),
        ])
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
            throw XCTSkip("NSHostingView produced no Work Console bitmap on this host")
        }
        representation.size = size
        hostingView.cacheDisplay(in: hostingView.bounds, to: representation)
        let image = NSImage(size: size)
        image.addRepresentation(representation)
        return image
    }
}

private enum ACPCardSnapshotState {
    case pending
    case approved
    case rejected
    case ended
    case failed

    var keepsSessionRunning: Bool {
        switch self {
        case .pending, .approved, .rejected: true
        case .ended, .failed: false
        }
    }
}
