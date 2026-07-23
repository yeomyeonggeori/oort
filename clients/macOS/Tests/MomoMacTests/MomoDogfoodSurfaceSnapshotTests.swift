import XCTest
import SwiftUI
import AppKit
import SnapshotTesting
import MomoCore
@testable import MomoMac

@MainActor
final class MomoDogfoodSurfaceSnapshotTests: XCTestCase {
    private enum MessageFocusScenario: Equatable {
        case focused
        case unavailable
    }

    private struct MessageFocusHarness: View {
        @ObservedObject var viewModel: ChatViewModel
        let channelID: ChannelID
        let targetMessageID: MessageID
        let scenario: MessageFocusScenario

        var body: some View {
            MessageListView(viewModel: viewModel)
                .task {
                    try? await Task.sleep(for: .milliseconds(20))
                    let messageID = scenario == .focused ? targetMessageID : MessageID()
                    await viewModel.focusMessage(messageID, in: channelID)
                }
        }
    }

    private let searchSize = CGSize(width: 680, height: 560)
    private let directMessageSize = CGSize(width: 700, height: 560)
    private let launcherSize = CGSize(width: 400, height: 360)
    private let approvalCropSize = CGSize(width: 360, height: 240)
    private let messageFocusSize = CGSize(width: 800, height: 640)

    private func viewModel() async -> ChatViewModel {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo(baseTimestampMs: 1_752_572_700_000)
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "dogfood-snapshot")
        if let channel = seed.channels.first {
            await viewModel.selectChannel(channel.id)
        }
        return viewModel
    }

    private func snapshotDefaults() -> UserDefaults {
        let suite = "momo.snapshot.dogfood-surfaces"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.set(MomoUILanguage.korean.rawValue, forKey: MomoUILanguage.appStorageKey)
        defaults.set(false, forKey: MomoDeveloperModePresentation.developerModeKey)
        defaults.set(false, forKey: MomoDeveloperModePresentation.costDisplayKey)
        defaults.set(false, forKey: "momo.workspace.showQuickStart")
        return defaults
    }

    private func searchFixture(_ scheme: ColorScheme) async -> some View {
        MomoWorkspaceSearchView(
            viewModel: await viewModel(),
            copy: MomoWorkspaceCopy(language: .korean),
            activate: { _ in },
            dismiss: {}
        )
        .frame(width: searchSize.width, height: searchSize.height)
        .background(Color(nsColor: .windowBackgroundColor))
        .environment(\.colorScheme, scheme)
    }

    private func directMessageFixture(_ scheme: ColorScheme) async -> some View {
        MomoDirectMessagePicker(
            viewModel: await viewModel(),
            copy: MomoWorkspaceCopy(language: .korean),
            dismiss: {}
        )
        .frame(width: directMessageSize.width, height: directMessageSize.height)
        .background(Color(nsColor: .windowBackgroundColor))
        .environment(\.colorScheme, scheme)
    }

    private func launcherFixture(_ scheme: ColorScheme) -> some View {
        MomoComposerActionLauncher(
            copy: MomoComposerActionCopy(language: .korean),
            onSelect: { _ in }
        )
        .frame(width: launcherSize.width, height: launcherSize.height)
        .background(Color(nsColor: .windowBackgroundColor))
        .environment(\.colorScheme, scheme)
    }

    private func approvalCropFixture(_ scheme: ColorScheme) async -> some View {
        ApprovalInboxView(viewModel: await viewModel())
            .frame(width: approvalCropSize.width, height: approvalCropSize.height)
            .clipped()
            .background(Color(nsColor: .windowBackgroundColor))
            .environment(\.colorScheme, scheme)
            .defaultAppStorage(snapshotDefaults())
    }

    private func messageFocusFixture(
        _ scheme: ColorScheme,
        scenario: MessageFocusScenario
    ) async -> some View {
        let viewModel = await viewModel()
        let channelID = viewModel.selectedChannelId!
        let targetMessageID = viewModel.visibleMessages.first!.id
        return MessageFocusHarness(
            viewModel: viewModel,
            channelID: channelID,
            targetMessageID: targetMessageID,
            scenario: scenario
        )
        .frame(width: messageFocusSize.width, height: messageFocusSize.height)
        .background(Color(nsColor: .windowBackgroundColor))
        .environment(\.colorScheme, scheme)
        // Freeze the agentWorkingSignal elapsed clock so the turn-liveness row's
        // readout is deterministic instead of ticking off wall-clock now. The seed
        // stamps working-start at test-run wall time, so a fixed pre-seed instant
        // pins the readout rather than leaking the host clock into the snapshot.
        .environment(\.agentWorkingClock, Date(timeIntervalSince1970: 1_752_572_700))
        .defaultAppStorage(snapshotDefaults())
    }

    private func render<Content: View>(
        _ view: Content,
        size: CGSize,
        scheme: ColorScheme
    ) async throws -> NSImage {
        let appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
        let window = NSWindow(
            contentRect: CGRect(origin: .zero, size: size),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.appearance = appearance
        window.backgroundColor = .windowBackgroundColor
        let hostingController = NSHostingController(rootView: view)
        hostingController.view.appearance = appearance
        window.contentViewController = hostingController
        window.setContentSize(size)
        window.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(150))
        window.layoutIfNeeded()
        guard let hostingView = window.contentView else {
            throw XCTSkip("NSWindow produced no dogfood surface frame on this host")
        }
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
            throw XCTSkip("NSHostingView produced no dogfood surface bitmap on this host")
        }
        representation.size = size
        hostingView.cacheDisplay(in: hostingView.bounds, to: representation)

        let image = NSImage(size: size)
        image.addRepresentation(representation)
        return image
    }

    private func assertSurface<Content: View>(
        _ view: Content,
        size: CGSize,
        scheme: ColorScheme,
        named name: String,
        testName: String
    ) async throws {
        let image = try await render(view, size: size, scheme: scheme)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: name,
            testName: testName
        )
    }

    func testWorkspaceSearchLightSnapshot() async throws {
        try await assertSurface(await searchFixture(.light), size: searchSize, scheme: .light, named: "light", testName: #function)
    }

    func testWorkspaceSearchDarkSnapshot() async throws {
        try await assertSurface(await searchFixture(.dark), size: searchSize, scheme: .dark, named: "dark", testName: #function)
    }

    func testDirectMessagePickerLightSnapshot() async throws {
        try await assertSurface(await directMessageFixture(.light), size: directMessageSize, scheme: .light, named: "light", testName: #function)
    }

    func testDirectMessagePickerDarkSnapshot() async throws {
        try await assertSurface(await directMessageFixture(.dark), size: directMessageSize, scheme: .dark, named: "dark", testName: #function)
    }

    func testComposerLauncherLightSnapshot() async throws {
        try await assertSurface(launcherFixture(.light), size: launcherSize, scheme: .light, named: "light", testName: #function)
    }

    func testComposerLauncherDarkSnapshot() async throws {
        try await assertSurface(launcherFixture(.dark), size: launcherSize, scheme: .dark, named: "dark", testName: #function)
    }

    func testApprovalInboxCloseCropLightSnapshot() async throws {
        try await assertSurface(
            await approvalCropFixture(.light),
            size: approvalCropSize,
            scheme: .light,
            named: "light",
            testName: #function
        )
    }

    func testMessageFocusHighlightLightSnapshot() async throws {
        try await assertSurface(
            await messageFocusFixture(.light, scenario: .focused),
            size: messageFocusSize,
            scheme: .light,
            named: "light",
            testName: #function
        )
    }

    func testMessageFocusHighlightDarkSnapshot() async throws {
        try await assertSurface(
            await messageFocusFixture(.dark, scenario: .focused),
            size: messageFocusSize,
            scheme: .dark,
            named: "dark",
            testName: #function
        )
    }

    func testMessageFocusFailureLightSnapshot() async throws {
        try await assertSurface(
            await messageFocusFixture(.light, scenario: .unavailable),
            size: messageFocusSize,
            scheme: .light,
            named: "light",
            testName: #function
        )
    }

    func testMessageFocusFailureDarkSnapshot() async throws {
        try await assertSurface(
            await messageFocusFixture(.dark, scenario: .unavailable),
            size: messageFocusSize,
            scheme: .dark,
            named: "dark",
            testName: #function
        )
    }
}
