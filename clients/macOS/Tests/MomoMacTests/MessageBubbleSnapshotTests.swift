import XCTest
import SwiftUI
import SnapshotTesting
import MomoCore
@testable import MomoMac

// MARK: - MessageBubble snapshot tests (MOMO-318)
//
// Deterministic light/dark image snapshots of the representative message surface.
// We rasterize off-screen with SwiftUI `ImageRenderer` (no window / no
// NSHostingView-in-window flakiness in a headless/background gate), pinning the
// drawing appearance so both SwiftUI-semantic colors (via `\.colorScheme`) and any
// AppKit dynamic colors (via `NSAppearance.performAsCurrentDrawingAppearance`)
// resolve to the intended scheme. SnapshotTesting then does the PNG diff.
//
// `perceptualPrecision: 0.98` tolerates sub-pixel font-rendering differences across
// macOS point releases; `precision: 0.98` tolerates a small fraction of stray pixels.
// Reference PNGs live in `__Snapshots__/MessageBubbleSnapshotTests/` and are
// committed. Snapshot comparison is macOS-local evidence only (this repo phase runs
// no CI), so the references are recorded once and then compared on re-run.
@MainActor
final class MessageBubbleSnapshotTests: XCTestCase {

    /// Fixed fixture: a realistic Korean+English mixed human message. Follows SKILL
    /// §2 copy rules — no placeholder "테스트 메시지 1", no em-dash. The explicit `seq`
    /// makes the header render "#128" instead of the non-deterministic "sending…".
    private func fixtureBubble(_ scheme: ColorScheme) -> some View {
        let workspace = WorkspaceID()
        let author = Member(
            id: MemberID(),
            workspaceId: workspace,
            kind: .human,
            displayName: "김지현",
            handle: "jihyun"
        )
        let message = Message(
            id: MessageID(),
            channelId: ChannelID(),
            seq: 128,
            hlcTs: 1_720_000_000_000,
            authorMemberId: author.id,
            type: .text,
            body: "staging smoke 로컬에서 green 확인했어요. RLS migration만 더블체크하면 배포 준비 끝입니다."
        )
        return MessageBubble(message: message, author: author)
            .frame(width: 480, alignment: .leading)
            .padding(16)
            .background(Color(nsColor: .textBackgroundColor))
            .environment(\.colorScheme, scheme)
    }

    private func render(_ scheme: ColorScheme) throws -> NSImage {
        let renderer = ImageRenderer(content: fixtureBubble(scheme))
        renderer.proposedSize = ProposedViewSize(width: 480, height: 200)
        renderer.scale = 2

        let appearanceName: NSAppearance.Name = (scheme == .dark) ? .darkAqua : .aqua
        var image: NSImage?
        if let appearance = NSAppearance(named: appearanceName) {
            appearance.performAsCurrentDrawingAppearance {
                image = renderer.nsImage
            }
        } else {
            image = renderer.nsImage
        }
        guard let image else {
            throw XCTSkip("ImageRenderer produced no NSImage on this host")
        }
        return image
    }

    private func editedAndDeletedFixture(_ scheme: ColorScheme) -> some View {
        let workspace = WorkspaceID()
        let channel = ChannelID()
        let author = Member(
            id: MemberID(),
            workspaceId: workspace,
            kind: .human,
            displayName: "상준",
            handle: "sangjun"
        )
        let edited = Message(
            id: MessageID(),
            channelId: channel,
            seq: 128,
            hlcTs: 1_720_000_000_000,
            authorMemberId: author.id,
            state: .edited,
            body: "배포 체크리스트를 최신 내용으로 수정했어요.",
            createdAtMs: 1_720_000_000_000,
            editedAtMs: 1_720_000_001_000
        )
        let deletedAfterEdit = Message(
            id: MessageID(),
            channelId: channel,
            seq: 129,
            hlcTs: 1_720_000_002_000,
            authorMemberId: author.id,
            state: .deleted,
            body: nil,
            createdAtMs: 1_720_000_000_000,
            editedAtMs: 1_720_000_001_000,
            deletedAtMs: 1_720_000_002_000
        )
        let copy = MomoWorkspaceCopy(language: .korean)

        return VStack(alignment: .leading, spacing: 8) {
            MessageBubble(
                message: edited,
                author: author,
                groupingStyle: .standalone,
                timelineCopy: copy
            )
            Divider()
            MessageBubble(
                message: deletedAfterEdit,
                author: author,
                replyCount: 3,
                onOpenThread: {},
                groupingStyle: .standalone,
                timelineCopy: copy
            )
        }
        .frame(width: 480, alignment: .leading)
        .padding(16)
        .background(Color(nsColor: .textBackgroundColor))
        .environment(\.colorScheme, scheme)
    }

    private func renderEditedAndDeletedFixture(_ scheme: ColorScheme) throws -> NSImage {
        let renderer = ImageRenderer(content: editedAndDeletedFixture(scheme))
        renderer.proposedSize = ProposedViewSize(width: 480, height: 240)
        renderer.scale = 2

        let appearanceName: NSAppearance.Name = (scheme == .dark) ? .darkAqua : .aqua
        var image: NSImage?
        if let appearance = NSAppearance(named: appearanceName) {
            appearance.performAsCurrentDrawingAppearance {
                image = renderer.nsImage
            }
        } else {
            image = renderer.nsImage
        }
        guard let image else {
            throw XCTSkip("ImageRenderer produced no NSImage on this host")
        }
        return image
    }

    private func attachmentFixture(
        _ scheme: ColorScheme,
        contrast: ColorSchemeContrast = .standard,
        dynamicTypeSize: DynamicTypeSize = .large
    ) -> some View {
        let workspace = WorkspaceID()
        let author = Member(
            id: MemberID(),
            workspaceId: workspace,
            kind: .human,
            displayName: "상준",
            handle: "sangjun"
        )
        let attachment = MessageAttachment(
            id: FileID(uuidString: "00000000-0000-7000-8000-000000001060")!,
            name: "2026년 7월 배포 검수 체크리스트 최종본.pdf",
            mime: "application/pdf",
            sizeBytes: 2_482_176
        )
        let message = Message(
            id: MessageID(),
            channelId: ChannelID(),
            seq: 130,
            hlcTs: 1_720_000_000_000,
            authorMemberId: author.id,
            attachments: [attachment],
            createdAtMs: 1_720_000_000_000
        )
        return MessageBubble(
            message: message,
            author: author,
            attachmentDownloadStates: [:],
            onDownloadAttachment: { _ in },
            onOpenAttachment: { _ in },
            groupingStyle: .standalone,
            timelineCopy: MomoWorkspaceCopy(language: .korean)
        )
        .frame(width: 480, alignment: .leading)
        .padding(16)
        .background(Color(nsColor: .textBackgroundColor))
        .environment(\.colorScheme, scheme)
        .environment(\.momoColorSchemeContrastOverride, contrast)
        .environment(\.dynamicTypeSize, dynamicTypeSize)
    }

    private func renderAttachmentFixture(
        _ scheme: ColorScheme,
        contrast: ColorSchemeContrast = .standard,
        dynamicTypeSize: DynamicTypeSize = .large
    ) throws -> NSImage {
        let renderer = ImageRenderer(content: attachmentFixture(
            scheme,
            contrast: contrast,
            dynamicTypeSize: dynamicTypeSize
        ))
        renderer.proposedSize = ProposedViewSize(
            width: dynamicTypeSize.isAccessibilitySize ? 560 : 480,
            height: dynamicTypeSize.isAccessibilitySize ? 360 : 240
        )
        renderer.scale = 2

        let appearanceName: NSAppearance.Name = (scheme == .dark) ? .darkAqua : .aqua
        var image: NSImage?
        if let appearance = NSAppearance(named: appearanceName) {
            appearance.performAsCurrentDrawingAppearance {
                image = renderer.nsImage
            }
        } else {
            image = renderer.nsImage
        }
        guard let image else {
            throw XCTSkip("ImageRenderer produced no NSImage on this host")
        }
        return image
    }

    private func attachmentDraftFixture(
        _ scheme: ColorScheme,
        contrast: ColorSchemeContrast = .standard,
        dynamicTypeSize: DynamicTypeSize = .large
    ) -> some View {
        let fixtureHeight: CGFloat = dynamicTypeSize.isAccessibilitySize ? 560 : 160
        let uploaded = MessageAttachment(
            id: FileID(uuidString: "00000000-0000-7000-8000-000000001062")!,
            name: "완료.pdf",
            mime: "application/pdf",
            sizeBytes: 2_482_176
        )
        let drafts = [
            MomoAttachmentDraft(
                url: URL(fileURLWithPath: "/tmp/2026년 7월 배포 검수 체크리스트 최종본.pdf"),
                state: .uploaded(uploaded)
            ),
            MomoAttachmentDraft(
                url: URL(fileURLWithPath: "/tmp/demo-recording.mov"),
                state: .uploading
            ),
            MomoAttachmentDraft(
                url: URL(fileURLWithPath: "/tmp/archive.zip"),
                state: .failed(.unavailable)
            ),
        ]
        return MomoAttachmentDraftStrip(
            drafts: drafts,
            copy: MomoComposerActionCopy(language: .korean),
            onRemove: { _ in },
            onRetry: { _ in },
            onClear: {}
        )
        .padding(16)
        .frame(width: 900, height: fixtureHeight, alignment: .topLeading)
        .background(Color(nsColor: .textBackgroundColor))
        .environment(\.colorScheme, scheme)
        .environment(\.momoColorSchemeContrastOverride, contrast)
        .environment(\.dynamicTypeSize, dynamicTypeSize)
        .environment(
            \.sizeCategory,
            dynamicTypeSize.isAccessibilitySize ? .accessibilityExtraExtraLarge : .large
        )
    }

    private func renderAttachmentDraftFixture(
        _ scheme: ColorScheme,
        contrast: ColorSchemeContrast = .standard,
        dynamicTypeSize: DynamicTypeSize = .large
    ) async throws -> NSImage {
        let size = CGSize(
            width: 900,
            height: dynamicTypeSize.isAccessibilitySize ? 560 : 160
        )
        let rootView = attachmentDraftFixture(
            scheme,
            contrast: contrast,
            dynamicTypeSize: dynamicTypeSize
        )
        let appearanceName: NSAppearance.Name = (scheme == .dark) ? .darkAqua : .aqua
        let appearance = NSAppearance(named: appearanceName)
        let hostingView = NSHostingView(rootView: rootView)
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
        hostingView.layoutSubtreeIfNeeded()
        hostingView.displayIfNeeded()
        try await Task.sleep(for: .milliseconds(100))
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
            throw XCTSkip("NSHostingView produced no attachment draft bitmap on this host")
        }
        representation.size = size
        hostingView.cacheDisplay(in: hostingView.bounds, to: representation)
        let image = NSImage(size: size)
        image.addRepresentation(representation)
        return image
    }

    func testMessageBubbleLightSnapshot() throws {
        assertSnapshot(
            of: try render(.light),
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "light"
        )
    }

    func testMessageBubbleDarkSnapshot() throws {
        assertSnapshot(
            of: try render(.dark),
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "dark"
        )
    }

    func testEditedAndDeletedTombstoneSnapshot() throws {
        let recordMode: SnapshotTestingConfiguration.Record? =
            ProcessInfo.processInfo.environment["MOMO_RECORD_SNAPSHOTS"] == "1" ? .all : nil
        assertSnapshot(
            of: try renderEditedAndDeletedFixture(.light),
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "light",
            record: recordMode
        )
        assertSnapshot(
            of: try renderEditedAndDeletedFixture(.dark),
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "dark",
            record: recordMode
        )
    }

    func testAttachmentCardLightAndDarkSnapshots() throws {
        let recordMode: SnapshotTestingConfiguration.Record? =
            ProcessInfo.processInfo.environment["MOMO_RECORD_SNAPSHOTS"] == "1" ? .all : nil
        assertSnapshot(
            of: try renderAttachmentFixture(.light),
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "light",
            record: recordMode
        )
        assertSnapshot(
            of: try renderAttachmentFixture(.dark),
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "dark",
            record: recordMode
        )
        assertSnapshot(
            of: try renderAttachmentFixture(
                .light,
                contrast: .increased,
                dynamicTypeSize: .accessibility2
            ),
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "increased-contrast-large-text",
            record: recordMode
        )
    }

    func testAttachmentDraftStatesLightDarkAndAccessibilitySnapshots() async throws {
        let recordMode: SnapshotTestingConfiguration.Record? =
            ProcessInfo.processInfo.environment["MOMO_RECORD_SNAPSHOTS"] == "1" ? .all : nil
        let light = try await renderAttachmentDraftFixture(.light)
        let dark = try await renderAttachmentDraftFixture(.dark)
        let accessible = try await renderAttachmentDraftFixture(
            .light,
            contrast: .increased,
            dynamicTypeSize: .accessibility2
        )
        assertSnapshot(
            of: light,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "light",
            record: recordMode
        )
        assertSnapshot(
            of: dark,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "dark",
            record: recordMode
        )
        assertSnapshot(
            of: accessible,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "increased-contrast-large-text",
            record: recordMode
        )
    }
}
