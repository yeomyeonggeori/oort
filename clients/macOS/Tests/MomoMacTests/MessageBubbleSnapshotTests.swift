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
}
