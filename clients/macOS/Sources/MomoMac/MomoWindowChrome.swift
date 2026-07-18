import AppKit
import SwiftUI

struct MomoWindowChromeMetrics: Equatable {
    let topInset: CGFloat
    let trafficLightTrailingX: CGFloat
    let trafficLightCenterYFromTop: CGFloat

    static let zero = MomoWindowChromeMetrics(
        topInset: 0,
        trafficLightTrailingX: 0,
        trafficLightCenterYFromTop: 0
    )

    static func measure(
        contentViewBounds: CGRect,
        contentLayoutRect: CGRect,
        contentViewIsFlipped: Bool,
        trafficLightFrames: [CGRect] = []
    ) -> MomoWindowChromeMetrics {
        let topInset = if contentViewIsFlipped {
            contentLayoutRect.minY - contentViewBounds.minY
        } else {
            contentViewBounds.maxY - contentLayoutRect.maxY
        }
        let trafficLightTrailingX = trafficLightFrames.map(\.maxX).max() ?? 0
        let trafficLightCenterY = trafficLightFrames.map(\.midY).reduce(0, +)
            / CGFloat(max(1, trafficLightFrames.count))
        let trafficLightCenterYFromTop = if trafficLightFrames.isEmpty {
            CGFloat(0)
        } else if contentViewIsFlipped {
            trafficLightCenterY - contentViewBounds.minY
        } else {
            contentViewBounds.maxY - trafficLightCenterY
        }
        return MomoWindowChromeMetrics(
            topInset: max(0, topInset),
            trafficLightTrailingX: max(0, trafficLightTrailingX),
            trafficLightCenterYFromTop: max(0, trafficLightCenterYFromTop)
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

    @MainActor
    static func alignTrafficLights(toHeaderBandHeight headerHeight: CGFloat, in window: NSWindow) {
        // AppKit titlebar controls are only stable after the window is ordered.
        // Offscreen snapshot hosts intentionally never enter that lifecycle.
        guard window.isVisible, let contentView = window.contentView else { return }
        let layoutRect = contentView.convert(window.contentLayoutRect, from: nil)
        let metrics = MomoWindowChromeMetrics.measure(
            contentViewBounds: contentView.bounds,
            contentLayoutRect: layoutRect,
            contentViewIsFlipped: contentView.isFlipped
        )
        let desiredCenterFromTop = trafficLightTargetCenterYFromTop(
            windowChromeTopInset: metrics.topInset,
            headerBandHeight: headerHeight
        )
        let buttons = [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton]
            .compactMap { window.standardWindowButton($0) }
            .filter { !$0.isHidden }
        let frames = buttons.map { $0.convert($0.bounds, to: contentView) }
        guard !frames.isEmpty else { return }
        let currentCenterY = frames.map(\.midY).reduce(0, +) / CGFloat(frames.count)
        let currentCenterFromTop = contentView.isFlipped
            ? currentCenterY - contentView.bounds.minY
            : contentView.bounds.maxY - currentCenterY
        let deltaFromTop = desiredCenterFromTop - currentCenterFromTop

        for button in buttons {
            guard let container = button.superview else { continue }
            let deltaY = container.isFlipped ? deltaFromTop : -deltaFromTop
            button.setFrameOrigin(
                NSPoint(
                    x: button.frame.origin.x,
                    y: button.frame.origin.y + deltaY
                )
            )
        }
    }

    static func trafficLightTargetCenterYFromTop(
        windowChromeTopInset: CGFloat,
        headerBandHeight: CGFloat
    ) -> CGFloat {
        (max(0, windowChromeTopInset) + max(0, headerBandHeight)) / 2
    }

    @MainActor
    static func repairFlatUnifiedChromeAcrossLifecycle(
        to window: NSWindow,
        scheduleDeferredRepair: (@escaping @MainActor () -> Void) -> Void
    ) {
        applyFlatUnifiedChrome(to: window)
        scheduleDeferredRepair { [weak window] in
            guard let window else { return }
            applyFlatUnifiedChrome(to: window)
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
    /// Ask SwiftUI to keep the titlebar hidden across scene activation cycles.
    /// `MomoWindowChromeMetricsReader` owns the macOS 14 AppKit repair path.
    func momoWindowChromeStyle() -> some Scene {
        windowStyle(.hiddenTitleBar)
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
        MomoWindowChromeStyle.alignTrafficLights(
            toHeaderBandHeight: MomoWindowChromeLayout.integratedHeaderHeight,
            in: window
        )
        // NavigationSplitView columns report a zero SwiftUI top safe area in
        // full-size unified windows. NSWindow's contentLayoutRect is the
        // AppKit-owned boundary that also follows fullscreen toolbar changes.
        let layoutRect = contentView.convert(window.contentLayoutRect, from: nil)
        let trafficLightFrames = [
            NSWindow.ButtonType.closeButton,
            .miniaturizeButton,
            .zoomButton,
        ].compactMap { type -> CGRect? in
            guard let button = window.standardWindowButton(type), !button.isHidden else {
                return nil
            }
            return button.convert(button.bounds, to: contentView)
        }
        let metrics = MomoWindowChromeMetrics.measure(
            contentViewBounds: contentView.bounds,
            contentLayoutRect: layoutRect,
            contentViewIsFlipped: contentView.isFlipped,
            trafficLightFrames: trafficLightFrames
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

        repairChromeAfterLifecycleTransition()

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

        let activationNames: [Notification.Name] = [
            NSWindow.didBecomeKeyNotification,
            NSWindow.didBecomeMainNotification,
            NSWindow.didChangeOcclusionStateNotification,
        ]
        for name in activationNames {
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(windowActivationDidChange(_:)),
                name: name,
                object: window
            )
        }
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(windowActivationDidChange(_:)),
            name: NSApplication.didBecomeActiveNotification,
            object: NSApplication.shared
        )
    }

    func stopObservingWindow() {
        removeWindowObservers()
    }

    private func removeWindowObservers() {
        if let mouseDownMonitor {
            NSEvent.removeMonitor(mouseDownMonitor)
            self.mouseDownMonitor = nil
        }
        NotificationCenter.default.removeObserver(self)
        observedWindow = nil
    }

    @objc private func windowMetricsDidChange(_ notification: Notification) {
        publishMetricsIfNeeded()
    }

    @objc private func windowActivationDidChange(_ notification: Notification) {
        repairChromeAfterLifecycleTransition()
    }

    func repairChromeAfterLifecycleTransition() {
        guard let window, observedWindow === window else { return }
        MomoWindowChromeStyle.repairFlatUnifiedChromeAcrossLifecycle(to: window) { [weak self, weak window] repair in
            // SwiftUI may restore its scene chrome after the AppKit activation
            // notification has already fired. Reassert the contract on the
            // next main-run-loop turn so returning from another app or Space
            // cannot expose a native titlebar band.
            DispatchQueue.main.async { [weak self, weak window] in
                guard let self, let window, self.window === window else { return }
                repair()
                self.publishMetricsIfNeeded()
            }
        }
    }
}
