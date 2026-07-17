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

    /// SwiftUI on macOS 14 has no scene-level API for removing the native
    /// toolbar baseline. Keep this narrow AppKit policy here so the sidebar
    /// surface can continue through the titlebar without a second horizontal
    /// divider or an elevated toolbar material.
    @MainActor
    static func applyFlatUnifiedChrome(to window: NSWindow) {
        // SwiftUI's scene toolbar style alone leaves the content view below a
        // separate native titlebar band. Extending the content view lets each
        // shell column paint behind the traffic lights while AppKit continues
        // to own their safe interaction region.
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
        if window.toolbarStyle != appKitToolbarStyle {
            window.toolbarStyle = appKitToolbarStyle
        }
        if window.toolbar?.showsBaselineSeparator == true {
            window.toolbar?.showsBaselineSeparator = false
        }
    }
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

        // SwiftUI can install or replace its toolbar one run-loop turn after
        // the representable enters the window. Reapply once after attachment
        // so the native baseline cannot reappear between titlebar and sidebar.
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
