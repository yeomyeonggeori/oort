import AppKit
import SwiftUI
import XCTest
@testable import MomoMac

@MainActor
final class MomoMessageComposerTextViewTests: XCTestCase {
    func testCommandResolverPreservesComposerKeyboardContract() {
        XCTAssertEqual(
            MomoMessageComposerCommand.resolve(
                selector: #selector(NSResponder.insertNewline(_:)),
                modifierFlags: [],
                hasMentionCandidates: false
            ),
            .submit
        )
        XCTAssertEqual(
            MomoMessageComposerCommand.resolve(
                selector: #selector(NSResponder.insertNewline(_:)),
                modifierFlags: [.shift],
                hasMentionCandidates: true
            ),
            .insertNewline
        )
        XCTAssertEqual(
            MomoMessageComposerCommand.resolve(
                selector: #selector(NSResponder.insertNewlineIgnoringFieldEditor(_:)),
                modifierFlags: [],
                hasMentionCandidates: true
            ),
            .insertNewline
        )
        XCTAssertEqual(
            MomoMessageComposerCommand.resolve(
                selector: #selector(NSResponder.moveUp(_:)),
                modifierFlags: [],
                hasMentionCandidates: true
            ),
            .moveMentionSelection(-1)
        )
        XCTAssertEqual(
            MomoMessageComposerCommand.resolve(
                selector: #selector(NSResponder.moveDown(_:)),
                modifierFlags: [],
                hasMentionCandidates: true
            ),
            .moveMentionSelection(1)
        )
        XCTAssertEqual(
            MomoMessageComposerCommand.resolve(
                selector: #selector(NSResponder.insertTab(_:)),
                modifierFlags: [],
                hasMentionCandidates: true
            ),
            .completeMention
        )
        XCTAssertEqual(
            MomoMessageComposerCommand.resolve(
                selector: #selector(NSResponder.cancelOperation(_:)),
                modifierFlags: [],
                hasMentionCandidates: true
            ),
            .dismissMention
        )
        XCTAssertEqual(
            MomoMessageComposerCommand.resolve(
                selector: #selector(NSResponder.moveUp(_:)),
                modifierFlags: [],
                hasMentionCandidates: false
            ),
            .standard
        )
    }

    func testNativeEditorOwnsSelectionAndRejectsWindowDragging() {
        let scrollView = MomoMessageComposerScrollView()
        let textView = makeTextView()
        scrollView.documentView = textView
        textView.string = "drag this Korean+English 단어"

        textView.selectAll(nil)

        XCTAssertTrue(textView.isEditable)
        XCTAssertTrue(textView.isSelectable)
        XCTAssertEqual(textView.selectedRange(), NSRange(location: 0, length: (textView.string as NSString).length))
        XCTAssertFalse(textView.mouseDownCanMoveWindow)
        XCTAssertFalse(scrollView.mouseDownCanMoveWindow)
    }

    func testEditorHeightStopsGrowingAfterFiveVisibleLines() {
        let textView = makeTextView()
        textView.string = "한 줄"
        let oneLineHeight = MomoMessageComposerTextLayout.measuredHeight(for: textView)
        textView.string = "하나\n둘\n셋\nfour\nfive"
        let fiveLineHeight = MomoMessageComposerTextLayout.measuredHeight(for: textView)
        textView.string = "하나\n둘\n셋\nfour\nfive\nsix"
        let sixLineHeight = MomoMessageComposerTextLayout.measuredHeight(for: textView)

        XCTAssertEqual(oneLineHeight, MomoMessageComposerTextLayout.minimumHeight)
        XCTAssertGreaterThan(fiveLineHeight, oneLineHeight)
        XCTAssertEqual(sixLineHeight, fiveLineHeight)
    }

    func testCoordinatorRoutesMentionCommandsWithoutReplacingStandardEditing() {
        var draft = "@he"
        var height = MomoMessageComposerTextLayout.minimumHeight
        var isFocused = false
        var submitted = false
        var movement: [Int] = []
        var completed = false
        var dismissed = false
        let editor = MomoMessageComposerTextView(
            text: Binding(get: { draft }, set: { draft = $0 }),
            height: Binding(get: { height }, set: { height = $0 }),
            isFocused: Binding(get: { isFocused }, set: { isFocused = $0 }),
            accessibilityLabel: "메시지 보내기",
            hasMentionCandidates: true,
            onSubmit: { submitted = true },
            onMoveMentionSelection: { movement.append($0) },
            onCompleteMention: { completed = true },
            onDismissMention: { dismissed = true }
        )
        let coordinator = editor.makeCoordinator()
        let textView = makeTextView()

        XCTAssertTrue(coordinator.textView(textView, doCommandBy: #selector(NSResponder.moveDown(_:))))
        XCTAssertTrue(coordinator.textView(textView, doCommandBy: #selector(NSResponder.insertTab(_:))))
        XCTAssertTrue(coordinator.textView(textView, doCommandBy: #selector(NSResponder.cancelOperation(_:))))
        XCTAssertFalse(coordinator.textView(textView, doCommandBy: #selector(NSTextView.copy(_:))))
        XCTAssertTrue(coordinator.textView(textView, doCommandBy: #selector(NSResponder.insertNewline(_:))))

        XCTAssertEqual(movement, [1])
        XCTAssertTrue(completed)
        XCTAssertTrue(dismissed)
        XCTAssertTrue(submitted)
    }

    private func makeTextView() -> MomoMessageComposerNativeTextView {
        let textView = MomoMessageComposerNativeTextView(
            frame: NSRect(x: 0, y: 0, width: 320, height: 240)
        )
        textView.font = MomoMessageComposerTextLayout.bodyFont
        textView.isRichText = false
        textView.isEditable = true
        textView.isSelectable = true
        textView.textContainerInset = NSSize(
            width: 0,
            height: MomoMessageComposerTextLayout.verticalInset
        )
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainer?.widthTracksTextView = true
        return textView
    }
}
