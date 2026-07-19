import XCTest
import SwiftUI
import AppKit
import SnapshotTesting
import MomoCore
@testable import MomoMac

@MainActor
final class MessageThreadPanelSnapshotTests: XCTestCase {
    private let size = CGSize(width: 420, height: 620)

    private func fixture() async throws -> (ChatViewModel, Message) {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo(baseTimestampMs: 1_783_910_400_000)
        let root = await backend.seedDemoMessage(
            channel: seed.channels[0].id,
            author: seed.human.id,
            body: "배포 전 체크리스트에서 알림 설정만 한 번 더 확인해 주세요.",
            createdAtMs: 1_783_911_000_000
        )
        _ = await backend.seedDemoMessage(
            channel: root.channelId,
            author: seed.agents[0].id,
            body: "음소거 채널에서도 읽지 않음 수는 그대로 유지되는 것 확인했습니다.",
            rootId: root.id,
            createdAtMs: 1_783_911_060_000
        )
        _ = await backend.seedDemoMessage(
            channel: root.channelId,
            author: seed.human.id,
            body: "좋아요. 이 내용으로 검수 기록 남길게요.",
            rootId: root.id,
            createdAtMs: 1_783_911_120_000
        )

        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "thread-panel-snapshot")
        await viewModel.selectChannel(root.channelId)
        let loadedRoot = try XCTUnwrap(viewModel.visibleMessages.first { $0.id == root.id })
        await viewModel.loadThreadReplies(for: loadedRoot)
        XCTAssertEqual(viewModel.replies(to: loadedRoot).count, 2)
        return (viewModel, loadedRoot)
    }

    private func render(
        _ scheme: ColorScheme,
        viewModel: ChatViewModel,
        root: Message
    ) throws -> NSImage {
        let panel = MomoMessageThreadPanel(
            viewModel: viewModel,
            root: root,
            copy: MomoWorkspaceCopy(language: .korean),
            presentation: .standard,
            onClose: {}
        )
        .frame(width: size.width, height: size.height)
        .background(Color(nsColor: .textBackgroundColor))
        .environment(\.colorScheme, scheme)
        .environment(\.locale, Locale(identifier: "ko_KR"))

        let hostingView = NSHostingView(rootView: panel)
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
            throw XCTSkip("Thread panel could not be rendered on this host")
        }
        representation.size = size
        hostingView.cacheDisplay(in: hostingView.bounds, to: representation)
        let image = NSImage(size: size)
        image.addRepresentation(representation)
        return image
    }

    func testThreadPanelLightAndDarkSnapshots() async throws {
        let (viewModel, root) = try await fixture()
        let recordMode: SnapshotTestingConfiguration.Record? =
            ProcessInfo.processInfo.environment["MOMO_RECORD_SNAPSHOTS"] == "1" ? .all : nil

        assertSnapshot(
            of: try render(.light, viewModel: viewModel, root: root),
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "light",
            record: recordMode
        )
        assertSnapshot(
            of: try render(.dark, viewModel: viewModel, root: root),
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "dark",
            record: recordMode
        )
    }
}
