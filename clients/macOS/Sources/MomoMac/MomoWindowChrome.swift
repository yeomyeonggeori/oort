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
    static let appKitToolbarStyle: NSWindow.ToolbarStyle = .unifiedCompact
}

public extension Scene {
    /// Keeps every macOS host on the same unified-toolbar title policy.
    func momoWindowChromeStyle() -> some Scene {
        windowToolbarStyle(
            .unifiedCompact(showsTitle: MomoWindowChromeStyle.showsSystemTitle)
        )
    }
}

private struct MomoWindowChromeTopInsetKey: EnvironmentKey {
    static let defaultValue: CGFloat = 0
}

extension EnvironmentValues {
    var momoWindowChromeTopInset: CGFloat {
        get { self[MomoWindowChromeTopInsetKey.self] }
        set { self[MomoWindowChromeTopInsetKey.self] = newValue }
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
}

final class MomoWindowChromeMetricsView: NSView {
    var onChange: ((MomoWindowChromeMetrics) -> Void)?

    private weak var observedWindow: NSWindow?
    private var lastMetrics: MomoWindowChromeMetrics?

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

    private func removeWindowObservers() {
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
