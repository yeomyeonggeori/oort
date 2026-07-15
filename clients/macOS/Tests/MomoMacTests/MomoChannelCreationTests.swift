import AppKit
import MomoCore
import SnapshotTesting
import SwiftUI
import XCTest
@testable import MomoMac

final class MomoChannelCreationTests: XCTestCase {
    func testChannelCreationValidationMatchesServerContract() {
        XCTAssertEqual(
            MomoChannelCreationValidation(name: "", topic: "").nameError,
            .required
        )
        XCTAssertEqual(
            MomoChannelCreationValidation(name: "Product Planning", topic: "").nameError,
            .unsupportedCharacters
        )
        XCTAssertEqual(
            MomoChannelCreationValidation(name: String(repeating: "a", count: 81), topic: "").nameError,
            .tooLong
        )
        XCTAssertEqual(
            MomoChannelCreationValidation(
                name: "product_planning-2",
                topic: String(repeating: "가", count: 281)
            ).topicError,
            .tooLong
        )
        XCTAssertTrue(
            MomoChannelCreationValidation(
                name: "product_planning-2",
                topic: "한국어와 English가 함께 있는 제품 기획"
            ).isValid
        )
        XCTAssertTrue(
            MomoChannelCreationValidation(name: " Product-Planning ", topic: "").isValid
        )
        XCTAssertEqual(
            MomoChannelCreationValidation.normalizedName(" Product-Planning "),
            "product-planning"
        )
    }

    func testChannelCreationCopyIsLocalizedAndActionable() {
        let korean = MomoWorkspaceCopy(language: .korean)
        let english = MomoWorkspaceCopy(language: .english)

        XCTAssertEqual(korean.createChannelAction, "채널 만들기")
        XCTAssertEqual(english.createChannelAction, "Create channel")
        XCTAssertTrue(korean.channelCreateErrorMessage(.duplicateName).contains("다른 이름"))
        XCTAssertTrue(english.channelCreateErrorMessage(.permissionDenied).contains("workspace admin"))
    }

    func testChannelCreationFeedbackClearsWhenAnyInputChanges() {
        for issue in [
            MomoChannelCreateIssue.duplicateName,
            .permissionDenied,
            .connection,
        ] {
            var feedback = MomoChannelCreationFeedback(issue: issue)
            feedback.clearForInputChange()
            XCTAssertNil(feedback.issue)
        }
    }

    func testChannelCreationIssuesClassifyRESTAndConnectionFailures() {
        XCTAssertEqual(
            ChatViewModel.channelCreateIssue(
                for: BackendError.problem(status: 409, title: "Conflict", detail: nil)
            ),
            .duplicateName
        )
        XCTAssertEqual(
            ChatViewModel.channelCreateIssue(
                for: BackendError.problem(status: 403, title: "Forbidden", detail: nil)
            ),
            .permissionDenied
        )
        XCTAssertEqual(
            ChatViewModel.channelCreateIssue(for: BackendError.realtime("offline")),
            .connection
        )
    }

    @MainActor
    func testChannelCreationNormalizesLikeServerAndKeepsFailureLocal() async {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "test")
        viewModel.setChannels(seed.channels)

        let created = await viewModel.createChannel(
            kind: .publicChannel,
            name: " Product-Planning "
        )
        XCTAssertTrue(created)
        XCTAssertEqual(viewModel.selectedChannel?.name, "product-planning")

        let duplicate = await viewModel.createChannel(kind: .publicChannel, name: " GENERAL ")
        XCTAssertFalse(duplicate)
        XCTAssertEqual(viewModel.channelCreateIssue, .duplicateName)
        XCTAssertTrue(viewModel.channelCreateDiagnostic?.contains("channel name already exists") == true)
        XCTAssertNil(viewModel.connectionError)
        XCTAssertNil(viewModel.connectionIssue)
    }

    func testQuickTooltipPlacementStaysInsideWindowScreenAndPrefersBelow() {
        let visible = CGRect(x: 0, y: 0, width: 1_200, height: 800)
        let tooltip = CGSize(width: 240, height: 40)
        let nearRightPaneBoundary = CGRect(x: 1_170, y: 620, width: 24, height: 24)
        let origin = MomoQuickTooltipPlacement.origin(
            anchor: nearRightPaneBoundary,
            tooltipSize: tooltip,
            visibleFrame: visible
        )

        XCTAssertLessThanOrEqual(origin.x + tooltip.width, visible.maxX - 8)
        XCTAssertEqual(origin.y, nearRightPaneBoundary.maxY + 8)

        let nearBottom = CGRect(x: 12, y: 770, width: 24, height: 24)
        let fallback = MomoQuickTooltipPlacement.origin(
            anchor: nearBottom,
            tooltipSize: tooltip,
            visibleFrame: visible
        )
        XCTAssertGreaterThanOrEqual(fallback.x, visible.minX + 8)
        XCTAssertLessThan(fallback.y, nearBottom.minY)
    }

    func testQuickTooltipPlacementUsesTheSameRootCoordinatesAcrossWindowSizes() {
        let tooltip = CGSize(width: 280, height: 64)
        for windowSize in [
            CGSize(width: 980, height: 620),
            CGSize(width: 1_180, height: 760),
            CGSize(width: 1_980, height: 1_270),
        ] {
            let visible = CGRect(origin: .zero, size: windowSize)
            let anchor = CGRect(x: 260, y: 120, width: 24, height: 24)
            let origin = MomoQuickTooltipPlacement.origin(
                anchor: anchor,
                tooltipSize: tooltip,
                visibleFrame: visible
            )
            XCTAssertGreaterThanOrEqual(origin.x, 8)
            XCTAssertGreaterThanOrEqual(origin.y, 8)
            XCTAssertLessThanOrEqual(origin.x + tooltip.width, windowSize.width - 8)
            XCTAssertLessThanOrEqual(origin.y + tooltip.height, windowSize.height - 8)
            XCTAssertEqual(origin.y, anchor.maxY + 8)
        }
    }

    @MainActor
    func testQuickTooltipPresenterIgnoresStaleDismissAfterRapidControlChange() {
        let presenter = MomoQuickTooltipPresenter()
        let first = UUID()
        let second = UUID()
        presenter.show(sourceID: first, text: "새 채널", anchor: CGRect(x: 10, y: 10, width: 24, height: 24))
        presenter.show(sourceID: second, text: "멤버 초대", anchor: CGRect(x: 40, y: 10, width: 24, height: 24))

        presenter.dismiss(sourceID: first)
        XCTAssertEqual(presenter.item?.sourceID, second)
        XCTAssertEqual(presenter.item?.text, "멤버 초대")

        presenter.dismiss(sourceID: second)
        XCTAssertNil(presenter.item)
    }

    @MainActor
    func testShortTooltipUsesCompactIntrinsicWidth() {
        let hostingView = NSHostingView(
            rootView: MomoQuickTooltipLabel(text: "새 채널")
        )
        hostingView.layoutSubtreeIfNeeded()
        let intrinsicSize = hostingView.fittingSize

        XCTAssertLessThan(intrinsicSize.width, 120)
        XCTAssertEqual(
            MomoQuickTooltipMeasurement.constrainedWidth(for: intrinsicSize.width),
            intrinsicSize.width
        )
        XCTAssertEqual(
            MomoQuickTooltipMeasurement.constrainedWidth(for: 640),
            MomoTheme.QuickTooltip.maximumWidth
        )
    }

    @MainActor
    func testLongMixedLanguageTooltipWrapsWithoutVerticalClipping() {
        let hostingView = NSHostingView(
            rootView: MomoQuickTooltipLabel(
                text: "전체 멤버 디렉터리를 열고 한국어와 English가 함께 있는 긴 설명을 세 줄 안에서 확인합니다"
            )
            .frame(width: MomoTheme.QuickTooltip.maximumWidth)
        )
        hostingView.layoutSubtreeIfNeeded()
        let size = hostingView.fittingSize

        XCTAssertLessThanOrEqual(size.width, MomoTheme.QuickTooltip.maximumWidth)
        XCTAssertGreaterThan(size.height, 32)
    }
}

@MainActor
final class MomoChannelCreationSnapshotTests: XCTestCase {
    override nonisolated func invokeTest() {
        if ProcessInfo.processInfo.environment["MOMO_RECORD_SNAPSHOTS"] == "1" {
            withSnapshotTesting(record: .all) {
                super.invokeTest()
            }
        } else {
            super.invokeTest()
        }
    }

    private func render(
        language: MomoUILanguage,
        scheme: ColorScheme,
        increasedContrast: Bool = false,
        dynamicTypeSize: DynamicTypeSize = .large,
        size: CGSize = CGSize(width: 560, height: 480)
    ) async throws -> NSImage {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "snapshot")
        viewModel.setChannels(seed.channels)

        let hostingView = NSHostingView(
            rootView: MomoChannelCreationSheet(
                viewModel: viewModel,
                copy: MomoWorkspaceCopy(language: language),
                dismiss: {}
            )
            .frame(width: size.width, height: size.height)
            .environment(\.colorScheme, scheme)
            .environment(\.dynamicTypeSize, dynamicTypeSize)
        )
        hostingView.frame = CGRect(origin: .zero, size: size)
        let appearanceName: NSAppearance.Name
        if increasedContrast {
            appearanceName = scheme == .dark ? .accessibilityHighContrastDarkAqua : .accessibilityHighContrastAqua
        } else {
            appearanceName = scheme == .dark ? .darkAqua : .aqua
        }
        hostingView.appearance = NSAppearance(named: appearanceName)
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
            throw XCTSkip("NSHostingView produced no channel creation bitmap")
        }
        representation.size = size
        hostingView.cacheDisplay(in: hostingView.bounds, to: representation)
        let image = NSImage(size: size)
        image.addRepresentation(representation)
        return image
    }

    func testChannelCreationSheetKoreanLightSnapshot() async throws {
        let image = try await render(language: .korean, scheme: .light)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "korean-light"
        )
    }

    func testChannelCreationSheetEnglishDarkSnapshot() async throws {
        let image = try await render(language: .english, scheme: .dark)
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "english-dark"
        )
    }

    func testChannelCreationSheetKoreanIncreasedContrastSnapshot() async throws {
        let image = try await render(
            language: .korean,
            scheme: .light,
            increasedContrast: true
        )
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "korean-increased-contrast"
        )
    }

    func testChannelCreationSheetEnglishLargeTextSnapshot() async throws {
        let image = try await render(
            language: .english,
            scheme: .dark,
            dynamicTypeSize: .accessibility2,
            size: CGSize(width: 680, height: 600)
        )
        assertSnapshot(
            of: image,
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "english-large-text"
        )
    }
}
