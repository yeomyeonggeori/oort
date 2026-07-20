import AppKit
import SwiftUI

@MainActor
enum MomoMessageComposerTextLayout {
    static let maximumVisibleLines = 5

    static var bodyFont: NSFont {
        NSFont.preferredFont(forTextStyle: .body)
    }

    static var verticalInset: CGFloat {
        MomoTheme.ComposerAction.contentSpacing
    }

    static var minimumHeight: CGFloat {
        max(
            MomoTheme.composerMinimumHeight,
            ceil(bodyFont.ascender - bodyFont.descender + bodyFont.leading) + (verticalInset * 2)
        )
    }

    static func measuredHeight(for textView: NSTextView) -> CGFloat {
        guard let layoutManager = textView.layoutManager,
              let textContainer = textView.textContainer else {
            return minimumHeight
        }
        layoutManager.ensureLayout(for: textContainer)
        let lineHeight = ceil(layoutManager.defaultLineHeight(for: textView.font ?? bodyFont))
        let contentHeight = max(lineHeight, ceil(layoutManager.usedRect(for: textContainer).height))
        let maximumHeight = (lineHeight * CGFloat(maximumVisibleLines)) + (verticalInset * 2)
        return min(max(contentHeight + (verticalInset * 2), minimumHeight), maximumHeight)
    }
}

@MainActor
enum MomoMessageComposerCommand: Equatable {
    case submit
    case insertNewline
    case moveMentionSelection(Int)
    case completeMention
    case dismissMention
    case standard

    static func resolve(
        selector: Selector,
        modifierFlags: NSEvent.ModifierFlags,
        hasMentionCandidates: Bool
    ) -> Self {
        if selector == #selector(NSResponder.insertNewline(_:)) {
            return modifierFlags.contains(.shift) ? .insertNewline : .submit
        }
        if selector == #selector(NSResponder.insertNewlineIgnoringFieldEditor(_:)) {
            return .insertNewline
        }
        guard hasMentionCandidates else { return .standard }
        switch selector {
        case #selector(NSResponder.moveUp(_:)):
            return .moveMentionSelection(-1)
        case #selector(NSResponder.moveDown(_:)):
            return .moveMentionSelection(1)
        case #selector(NSResponder.insertTab(_:)):
            return .completeMention
        case #selector(NSResponder.cancelOperation(_:)):
            return .dismissMention
        default:
            return .standard
        }
    }
}

// SwiftUI TextEditor cannot combine exact 1...5-line sizing with composer-specific Enter handling.
struct MomoMessageComposerTextView: NSViewRepresentable {
    @Binding var text: String
    @Binding var height: CGFloat
    @Binding var isFocused: Bool
    let accessibilityLabel: String
    let hasMentionCandidates: Bool
    let onSubmit: () -> Void
    let onMoveMentionSelection: (Int) -> Void
    let onCompleteMention: () -> Void
    let onDismissMention: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeNSView(context: Context) -> MomoMessageComposerScrollView {
        let scrollView = MomoMessageComposerScrollView()
        scrollView.borderType = .noBorder
        scrollView.drawsBackground = false
        scrollView.hasHorizontalScroller = false
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true

        let textView = MomoMessageComposerNativeTextView(frame: .zero)
        textView.delegate = context.coordinator
        textView.string = text
        textView.font = MomoMessageComposerTextLayout.bodyFont
        textView.textColor = .labelColor
        textView.drawsBackground = false
        textView.isRichText = false
        textView.importsGraphics = false
        textView.allowsUndo = true
        textView.isEditable = true
        textView.isSelectable = true
        textView.isHorizontallyResizable = false
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.textContainerInset = NSSize(
            width: 0,
            height: MomoMessageComposerTextLayout.verticalInset
        )
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.heightTracksTextView = false
        textView.setAccessibilityIdentifier("momo-message-composer")
        textView.setAccessibilityLabel(accessibilityLabel)
        scrollView.documentView = textView
        scrollView.onLayout = { [weak coordinator = context.coordinator, weak scrollView] in
            guard let coordinator, let scrollView else { return }
            coordinator.recalculateHeight(in: scrollView)
        }
        scrollView.onMoveToWindow = { [weak coordinator = context.coordinator, weak scrollView] in
            guard let coordinator,
                  let textView = scrollView?.documentView as? MomoMessageComposerNativeTextView else { return }
            coordinator.synchronizeFocus(in: textView)
        }
        context.coordinator.recalculateHeight(in: scrollView)
        return scrollView
    }

    func updateNSView(_ scrollView: MomoMessageComposerScrollView, context: Context) {
        context.coordinator.parent = self
        guard let textView = scrollView.documentView as? MomoMessageComposerNativeTextView else { return }
        textView.font = MomoMessageComposerTextLayout.bodyFont
        textView.setAccessibilityLabel(accessibilityLabel)
        context.coordinator.replaceTextIfNeeded(in: textView)
        context.coordinator.recalculateHeight(in: scrollView)
        context.coordinator.synchronizeFocus(in: textView)
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: MomoMessageComposerTextView

        init(parent: MomoMessageComposerTextView) {
            self.parent = parent
        }

        func textDidBeginEditing(_ notification: Notification) {
            if !parent.isFocused {
                parent.isFocused = true
            }
        }

        func textDidEndEditing(_ notification: Notification) {
            if parent.isFocused {
                parent.isFocused = false
            }
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            if parent.text != textView.string {
                parent.text = textView.string
            }
            if let scrollView = textView.enclosingScrollView as? MomoMessageComposerScrollView {
                recalculateHeight(in: scrollView)
            }
            textView.scrollRangeToVisible(textView.selectedRange())
        }

        func textView(_ textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
            let command = MomoMessageComposerCommand.resolve(
                selector: commandSelector,
                modifierFlags: NSApplication.shared.currentEvent?.modifierFlags ?? [],
                hasMentionCandidates: parent.hasMentionCandidates
            )
            switch command {
            case .submit:
                parent.onSubmit()
            case .insertNewline:
                textView.insertNewlineIgnoringFieldEditor(nil)
            case .moveMentionSelection(let offset):
                parent.onMoveMentionSelection(offset)
            case .completeMention:
                parent.onCompleteMention()
            case .dismissMention:
                parent.onDismissMention()
            case .standard:
                return false
            }
            return true
        }

        func replaceTextIfNeeded(in textView: NSTextView) {
            guard textView.string != parent.text else { return }
            let previousLength = (textView.string as NSString).length
            let previousSelection = textView.selectedRange()
            let selectionWasAtEnd = NSMaxRange(previousSelection) == previousLength
            textView.string = parent.text
            let updatedLength = (parent.text as NSString).length
            if selectionWasAtEnd {
                textView.setSelectedRange(NSRange(location: updatedLength, length: 0))
            } else {
                let location = min(previousSelection.location, updatedLength)
                let length = min(previousSelection.length, updatedLength - location)
                textView.setSelectedRange(NSRange(location: location, length: length))
            }
        }

        func recalculateHeight(in scrollView: MomoMessageComposerScrollView) {
            guard let textView = scrollView.documentView as? MomoMessageComposerNativeTextView,
                  let layoutManager = textView.layoutManager,
                  let textContainer = textView.textContainer else { return }
            let availableWidth = max(0, scrollView.contentSize.width)
            if textView.frame.width != availableWidth {
                textView.setFrameSize(NSSize(width: availableWidth, height: textView.frame.height))
            }
            let measuredHeight = MomoMessageComposerTextLayout.measuredHeight(for: textView)
            let documentHeight = max(
                scrollView.contentSize.height,
                ceil(layoutManager.usedRect(for: textContainer).height)
                    + (MomoMessageComposerTextLayout.verticalInset * 2)
            )
            if textView.frame.height != documentHeight {
                textView.setFrameSize(NSSize(width: availableWidth, height: documentHeight))
            }
            if abs(parent.height - measuredHeight) > 0.5 {
                DispatchQueue.main.async { [weak self] in
                    guard let self, abs(self.parent.height - measuredHeight) > 0.5 else { return }
                    self.parent.height = measuredHeight
                }
            }
        }

        func synchronizeFocus(in textView: NSTextView) {
            guard let window = textView.window else { return }
            if parent.isFocused, window.firstResponder !== textView {
                DispatchQueue.main.async { [weak self, weak textView, weak window] in
                    guard let self,
                          self.parent.isFocused,
                          let textView,
                          let window,
                          textView.window === window else { return }
                    window.makeFirstResponder(textView)
                }
            } else if !parent.isFocused, window.firstResponder === textView {
                window.makeFirstResponder(nil)
            }
        }
    }
}

final class MomoMessageComposerScrollView: NSScrollView {
    var onLayout: (() -> Void)?
    var onMoveToWindow: (() -> Void)?

    override var mouseDownCanMoveWindow: Bool { false }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        onMoveToWindow?()
    }

    override func layout() {
        super.layout()
        onLayout?()
    }
}

final class MomoMessageComposerNativeTextView: NSTextView {
    override var mouseDownCanMoveWindow: Bool { false }
}
