import AppKit
import SwiftUI

struct MomoWindowChromeMetrics: Equatable {
    let topInset: CGFloat

    static let zero = MomoWindowChromeMetrics(topInset: 0)

    static func measure(
        contentViewBounds: CGRect,
        contentLayoutRect: CGRect,
        contentViewIsFlipped: Bool
    ) -> MomoWindowChromeMetrics {
        let topInset = if contentViewIsFlipped {
            contentLayoutRect.minY - contentViewBounds.minY
        } else {
            contentViewBounds.maxY - contentLayoutRect.maxY
        }
        return MomoWindowChromeMetrics(
            topInset: max(0, topInset)
        )
    }
}

enum MomoWindowChromeStyle {
    static let showsSystemTitle = false

    /// momo owns the full window surface, including the titlebar background.
    /// AppKit still owns the traffic lights, but no native toolbar row is kept.
    @MainActor
    static func applyFlatUnifiedChrome(to window: NSWindow) {
        if !window.styleMask.contains(.fullSizeContentView) {
            window.styleMask.insert(.fullSizeContentView)
        }
        if window.titleVisibility != .hidden {
            window.titleVisibility = .hidden
        }
        if !window.titlebarAppearsTransparent {
            window.titlebarAppearsTransparent = true
        }
        if window.titlebarSeparatorStyle != .none {
            window.titlebarSeparatorStyle = .none
        }
        if window.toolbar != nil {
            window.toolbar = nil
        }
        if !window.isMovableByWindowBackground {
            window.isMovableByWindowBackground = true
        }
    }
}

@MainActor
enum MomoWindowChromeDoubleClickHandler {
    static func shouldHandle(
        clickCount: Int,
        locationInWindow: NSPoint,
        window: NSWindow
    ) -> Bool {
        guard clickCount == 2,
              !window.styleMask.contains(.fullScreen),
              let contentView = window.contentView,
              topChromeRect(in: window, contentView: contentView).contains(locationInWindow),
              !isInsideTrafficLight(locationInWindow, window: window),
              !isInteractiveAccessibilityElement(at: locationInWindow, window: window)
        else { return false }

        let locationInContent = contentView.convert(locationInWindow, from: nil)
        return !isInteractive(contentView.hitTest(locationInContent), stoppingAt: contentView)
    }

    static func topChromeRect(in window: NSWindow, contentView: NSView) -> NSRect {
        let contentBoundsInWindow = contentView.convert(contentView.bounds, to: nil)
        let chromeBottom = min(
            max(window.contentLayoutRect.maxY, contentBoundsInWindow.minY),
            contentBoundsInWindow.maxY
        )
        return NSRect(
            x: contentBoundsInWindow.minX,
            y: chromeBottom,
            width: contentBoundsInWindow.width,
            height: contentBoundsInWindow.maxY - chromeBottom
        )
    }

    private static func isInsideTrafficLight(_ point: NSPoint, window: NSWindow) -> Bool {
        let buttonTypes: [NSWindow.ButtonType] = [.closeButton, .miniaturizeButton, .zoomButton]
        return buttonTypes.contains { type in
            guard let button = window.standardWindowButton(type), !button.isHidden else { return false }
            return button.convert(button.bounds, to: nil).contains(point)
        }
    }

    private static func isInteractive(_ hitView: NSView?, stoppingAt contentView: NSView) -> Bool {
        var candidate = hitView
        while let view = candidate {
            if view is NSControl || view is NSTextView {
                return true
            }
            if view === contentView {
                break
            }
            candidate = view.superview
        }
        return false
    }

    private static func isInteractiveAccessibilityElement(
        at point: NSPoint,
        window: NSWindow
    ) -> Bool {
        let screenPoint = window.convertPoint(toScreen: point)
        guard let element = window.accessibilityHitTest(screenPoint) as? NSObject else {
            return false
        }
        let interactiveRoles: Set<NSAccessibility.Role> = [
            .button,
            .checkBox,
            .comboBox,
            .disclosureTriangle,
            .incrementor,
            .link,
            .menuButton,
            .popUpButton,
            .radioButton,
            .slider,
            .textArea,
            .textField,
        ]
        guard let role = element.accessibilityAttributeValue(.role) as? NSAccessibility.Role else {
            return false
        }
        return interactiveRoles.contains(role)
    }
}

public extension Scene {
    /// Window chrome is applied by `MomoWindowChromeMetricsReader`. Returning
    /// the scene unchanged prevents SwiftUI from installing a shared toolbar.
    func momoWindowChromeStyle() -> some Scene {
        self
    }
}

private struct MomoWindowChromeTopInsetKey: EnvironmentKey {
    static let defaultValue: CGFloat = 0
}

private struct MomoCenterHeaderLeadingInsetKey: EnvironmentKey {
    static let defaultValue: CGFloat = 0
}

extension EnvironmentValues {
    var momoWindowChromeTopInset: CGFloat {
        get { self[MomoWindowChromeTopInsetKey.self] }
        set { self[MomoWindowChromeTopInsetKey.self] = newValue }
    }

    var momoCenterHeaderLeadingInset: CGFloat {
        get { self[MomoCenterHeaderLeadingInsetKey.self] }
        set { self[MomoCenterHeaderLeadingInsetKey.self] = newValue }
    }
}

struct MomoWindowChromeMetricsReader: NSViewRepresentable {
    let onChange: (MomoWindowChromeMetrics) -> Void

    func makeNSView(context: Context) -> MomoWindowChromeMetricsView {
        let view = MomoWindowChromeMetricsView()
        view.onChange = onChange
        return view
    }

    func updateNSView(_ nsView: MomoWindowChromeMetricsView, context: Context) {
        nsView.onChange = onChange
        nsView.publishMetricsIfNeeded()
    }

    static func dismantleNSView(_ nsView: MomoWindowChromeMetricsView, coordinator: Void) {
        nsView.stopObservingWindow()
    }
}

final class MomoWindowChromeMetricsView: NSView {
    var onChange: ((MomoWindowChromeMetrics) -> Void)?

    private weak var observedWindow: NSWindow?
    private var lastMetrics: MomoWindowChromeMetrics?
    private var mouseDownMonitor: Any?

    override func viewWillMove(toWindow newWindow: NSWindow?) {
        if observedWindow !== newWindow {
            removeWindowObservers()
        }
        super.viewWillMove(toWindow: newWindow)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        observeCurrentWindow()
        publishMetricsIfNeeded()
    }

    override func layout() {
        super.layout()
        publishMetricsIfNeeded()
    }

    func publishMetricsIfNeeded() {
        guard let window, let contentView = window.contentView else { return }
        MomoWindowChromeStyle.applyFlatUnifiedChrome(to: window)
        // NavigationSplitView columns report a zero SwiftUI top safe area in
        // full-size unified windows. NSWindow's contentLayoutRect is the
        // AppKit-owned boundary that also follows fullscreen toolbar changes.
        let layoutRect = contentView.convert(window.contentLayoutRect, from: nil)
        let metrics = MomoWindowChromeMetrics.measure(
            contentViewBounds: contentView.bounds,
            contentLayoutRect: layoutRect,
            contentViewIsFlipped: contentView.isFlipped
        )
        guard metrics != lastMetrics else { return }
        lastMetrics = metrics
        onChange?(metrics)
    }

    private func observeCurrentWindow() {
        guard observedWindow !== window else { return }
        removeWindowObservers()
        observedWindow = window
        guard let window else { return }

        mouseDownMonitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self, weak window] event in
            guard self != nil, let window, event.window === window else { return event }
            guard MomoWindowChromeDoubleClickHandler.shouldHandle(
                clickCount: event.clickCount,
                locationInWindow: event.locationInWindow,
                window: window
            ) else { return event }
            window.performZoom(nil)
            return nil
        }

        // SwiftUI can install window chrome one run-loop turn after the
        // representable enters the window. Reapply once after attachment.
        DispatchQueue.main.async { [weak self, weak window] in
            guard let self, let window, self.window === window else { return }
            MomoWindowChromeStyle.applyFlatUnifiedChrome(to: window)
        }

        let names: [Notification.Name] = [
            NSWindow.didResizeNotification,
            NSWindow.didEndLiveResizeNotification,
            NSWindow.didEnterFullScreenNotification,
            NSWindow.didExitFullScreenNotification,
            NSWindow.didChangeScreenNotification,
        ]
        for name in names {
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(windowMetricsDidChange(_:)),
                name: name,
                object: window
            )
        }
    }

    func stopObservingWindow() {
        removeWindowObservers()
    }

    private func removeWindowObservers() {
        if let mouseDownMonitor {
            NSEvent.removeMonitor(mouseDownMonitor)
            self.mouseDownMonitor = nil
        }
        if let observedWindow {
            NotificationCenter.default.removeObserver(
                self,
                name: nil,
                object: observedWindow
            )
        }
        observedWindow = nil
    }

    @objc private func windowMetricsDidChange(_ notification: Notification) {
        publishMetricsIfNeeded()
    }
}
