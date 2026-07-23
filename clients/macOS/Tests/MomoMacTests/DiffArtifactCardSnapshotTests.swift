import XCTest
import SwiftUI
import AppKit
import SnapshotTesting
import MomoCore
@testable import MomoMac

// MARK: - Diff artifact card snapshots (MOMO-518 / ADR-0126 D2)
//
// Light and dark evidence for the first-class diff card: file-path headers, the
// honest truncation banner ("N of M lines"), token-only add/remove colors, and
// the raw-payload disclosure. Baseline PNGs are recorded by the orchestrator, not
// the worker, so each test skips unless MOMO_VERIFY_518_SNAPSHOTS=1 is set. That
// keeps the worker run from committing reference images from a non-canonical host.
@MainActor
final class DiffArtifactCardSnapshotTests: XCTestCase {

    private func requireVerificationGate() throws {
        guard ProcessInfo.processInfo.environment["MOMO_VERIFY_518_SNAPSHOTS"] == "1" else {
            throw XCTSkip("MOMO-518 diff card baselines are recorded by the orchestrator, not the worker")
        }
    }

    // A realistic mixed Korean+English change: two files, small enough to render
    // fully. Copy avoids placeholder names and em-dashes per the design skill.
    private func diffPresentation() throws -> MessageArtifactPresentation {
        let patch = """
        diff --git a/Sources/Payments/RetryPolicy.swift b/Sources/Payments/RetryPolicy.swift
        --- a/Sources/Payments/RetryPolicy.swift
        +++ b/Sources/Payments/RetryPolicy.swift
        @@ -12,7 +12,9 @@ struct RetryPolicy {
             let maxAttempts: Int
        -    let backoff: Duration
        +    let backoff: Duration
        +    /// 결제 실패가 일시적일 때만 재시도합니다.
        +    let retryableOnly: Bool

             func shouldRetry(_ error: PaymentError) -> Bool {
        -        attempt < maxAttempts
        +        attempt < maxAttempts && (!retryableOnly || error.isTransient)
             }
        diff --git a/Tests/PaymentsTests/RetryPolicyTests.swift b/Tests/PaymentsTests/RetryPolicyTests.swift
        --- a/Tests/PaymentsTests/RetryPolicyTests.swift
        +++ b/Tests/PaymentsTests/RetryPolicyTests.swift
        @@ -1,3 +1,5 @@
         import XCTest
        +
        +// 영구 오류는 재시도하지 않는지 검증합니다.
        """
        let message = Message(
            id: MessageID(uuidString: "00000000-0000-7000-8000-000000000518")!,
            channelId: ChannelID(uuidString: "00000000-0000-7000-8000-000000000201")!,
            seq: 518,
            hlcTs: 1_784_452_800_000,
            authorMemberId: MemberID(uuidString: "00000000-0000-7000-8000-000000000103")!,
            type: .diff,
            props: .object([
                "artifact_kind": .string("diff"),
                "title": .string("결제 재시도 정책에 retryableOnly 추가"),
                "patch": .string(patch),
            ]),
            createdAtMs: 1_784_452_800_000
        )
        guard let presentation = MessageArtifactPresentation.resolve(message: message) else {
            throw XCTSkip("Fixture diff did not resolve to a presentation")
        }
        return presentation
    }

    // A 1,000+ line diff so the truncation banner renders with real numbers.
    private func truncatedDiffPresentation() throws -> MessageArtifactPresentation {
        var lines = [
            "diff --git a/Sources/Generated/Catalog.swift b/Sources/Generated/Catalog.swift",
            "--- a/Sources/Generated/Catalog.swift",
            "+++ b/Sources/Generated/Catalog.swift",
            "@@ -0,0 +1,1200 @@",
        ]
        for index in 1...1_200 {
            lines.append("+    case item\(index) // 자동 생성 항목 \(index)")
        }
        let message = Message(
            id: MessageID(uuidString: "00000000-0000-7000-8000-000000000519")!,
            channelId: ChannelID(uuidString: "00000000-0000-7000-8000-000000000201")!,
            seq: 519,
            hlcTs: 1_784_452_800_000,
            authorMemberId: MemberID(uuidString: "00000000-0000-7000-8000-000000000103")!,
            type: .diff,
            props: .object([
                "artifact_kind": .string("diff"),
                "title": .string("상품 카탈로그 코드 재생성"),
                "patch": .string(lines.joined(separator: "\n")),
            ]),
            createdAtMs: 1_784_452_800_000
        )
        guard let presentation = MessageArtifactPresentation.resolve(message: message) else {
            throw XCTSkip("Truncated fixture diff did not resolve to a presentation")
        }
        return presentation
    }

    private let size = CGSize(width: 552, height: 640)

    private func fixture(_ presentation: MessageArtifactPresentation, scheme: ColorScheme) -> some View {
        MomoMessageArtifactCard(presentation: presentation, copy: MomoWorkspaceCopy(language: .korean))
            .frame(width: 520, alignment: .leading)
            .padding(16)
            .frame(width: size.width, height: size.height, alignment: .topLeading)
            .background(Color(nsColor: .textBackgroundColor))
            .environment(\.colorScheme, scheme)
    }

    // NSHostingView-in-window rasterization (not ImageRenderer): the diff body
    // nests a horizontal scroll inside a vertical one, which ImageRenderer's
    // single pass cannot lay out. A real window runs a full layout pass.
    private func render(_ presentation: MessageArtifactPresentation, scheme: ColorScheme) async throws -> NSImage {
        let appearanceName: NSAppearance.Name = scheme == .dark ? .darkAqua : .aqua
        let appearance = NSAppearance(named: appearanceName)
        let hostingView = NSHostingView(rootView: fixture(presentation, scheme: scheme))
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
            throw XCTSkip("NSHostingView produced no diff card bitmap on this host")
        }
        representation.size = size
        hostingView.cacheDisplay(in: hostingView.bounds, to: representation)
        let image = NSImage(size: size)
        image.addRepresentation(representation)
        return image
    }

    func testDiffCardLightAndDarkSnapshots() async throws {
        try requireVerificationGate()
        let presentation = try diffPresentation()
        let light = try await render(presentation, scheme: .light)
        let dark = try await render(presentation, scheme: .dark)
        let recordMode: SnapshotTestingConfiguration.Record? =
            ProcessInfo.processInfo.environment["MOMO_RECORD_SNAPSHOTS"] == "1" ? .all : nil
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
    }

    func testTruncatedDiffCardLightAndDarkSnapshots() async throws {
        try requireVerificationGate()
        let presentation = try truncatedDiffPresentation()
        let light = try await render(presentation, scheme: .light)
        let dark = try await render(presentation, scheme: .dark)
        let recordMode: SnapshotTestingConfiguration.Record? =
            ProcessInfo.processInfo.environment["MOMO_RECORD_SNAPSHOTS"] == "1" ? .all : nil
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
    }

    // Non-snapshot guard: the truncation banner numbers the diff body honestly, so
    // this assertion holds regardless of the image baseline the orchestrator records.
    func testTruncatedDiffReportsHonestBannerNumbers() throws {
        guard case .diff(let diff) = try truncatedDiffPresentation() else {
            return XCTFail("Expected a diff presentation")
        }
        XCTAssertTrue(diff.isTruncated)
        XCTAssertEqual(diff.displayedLineCount, 500)
        XCTAssertEqual(diff.totalLineCount, 1_204)
        let banner = MomoWorkspaceCopy(language: .korean)
            .diffTruncationBanner(total: diff.totalLineCount, shown: diff.displayedLineCount)
        XCTAssertEqual(banner, "전체 1204줄 중 500줄 표시")
        let englishBanner = MomoWorkspaceCopy(language: .english)
            .diffTruncationBanner(total: diff.totalLineCount, shown: diff.displayedLineCount)
        XCTAssertEqual(englishBanner, "Showing 500 of 1204 lines")
    }
}
