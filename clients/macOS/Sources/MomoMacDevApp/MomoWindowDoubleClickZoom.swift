import AppKit

/// Restores the standard macOS title-bar double-click zoom behavior for the
/// full-size-content window used by the development app.
@MainActor
enum MomoWindowDoubleClickZoom {
    private static var monitor: Any?

    static func install() {
        guard monitor == nil else { return }

        monitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { event in
            guard event.clickCount == 2,
                  let window = event.window,
                  window.styleMask.contains(.resizable),
                  !window.styleMask.contains(.fullScreen),
                  isTitlebarBackground(event, in: window)
            else {
                return event
            }

            window.performZoom(nil)
            return nil
        }
    }

    private static func isTitlebarBackground(_ event: NSEvent, in window: NSWindow) -> Bool {
        let location = event.locationInWindow

        guard location.y >= window.contentLayoutRect.maxY else { return false }
        guard let contentView = window.contentView else { return true }

        let point = contentView.convert(location, from: nil)
        var hitView: NSView? = contentView.hitTest(point)

        while let view = hitView {
            if view is NSControl {
                return false
            }
            hitView = view.superview
        }

        return true
    }
}
