import AppKit
import SwiftUI

enum MomoWorkConsoleResizeDirection {
    case left
    case right
    case up

    var isHorizontal: Bool {
        switch self {
        case .left, .right: true
        case .up: false
        }
    }

    func value(from origin: CGFloat, translation: CGSize) -> CGFloat {
        switch self {
        case .left: origin - translation.width
        case .right: origin + translation.width
        case .up: origin - translation.height
        }
    }

    func value(from origin: CGFloat, physicalAdjustment: CGFloat) -> CGFloat {
        switch self {
        case .left, .up: origin - physicalAdjustment
        case .right: origin + physicalAdjustment
        }
    }
}

/// SwiftUI has no split handle that can resize these nested custom panes without rebuilding the window shell.
struct MomoWorkConsoleResizeHandle: View {
    let value: CGFloat
    let direction: MomoWorkConsoleResizeDirection
    let onResize: (CGFloat) -> Void
    let onReset: () -> Void
    let accessibilityLabel: String
    let accessibilityValue: String
    let resetLabel: String

    @State private var dragOrigin: CGFloat?
    @FocusState private var isFocused: Bool

    var body: some View {
        Color.clear
            .frame(
                width: direction.isHorizontal ? MomoTheme.WorkConsole.resizeHandleExtent : nil,
                height: direction.isHorizontal ? nil : MomoTheme.WorkConsole.resizeHandleExtent
            )
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { drag in
                        let origin = dragOrigin ?? value
                        if dragOrigin == nil { dragOrigin = origin }
                        onResize(direction.value(from: origin, translation: drag.translation))
                    }
                    .onEnded { drag in
                        let origin = dragOrigin ?? value
                        onResize(direction.value(from: origin, translation: drag.translation))
                        dragOrigin = nil
                    }
            )
            .simultaneousGesture(
                TapGesture(count: 2)
                    .onEnded {
                        dragOrigin = nil
                        onReset()
                    }
            )
            .onHover { isHovered in
                if isHovered {
                    direction.isHorizontal ? NSCursor.resizeLeftRight.set() : NSCursor.resizeUpDown.set()
                } else {
                    NSCursor.arrow.set()
                }
            }
            .focusable()
            .focused($isFocused)
            .onMoveCommand { movement in
                switch movement {
                case .left where direction.isHorizontal:
                    adjust(physicalAdjustment: -MomoTheme.WorkConsole.resizeAdjustmentStep)
                case .right where direction.isHorizontal:
                    adjust(physicalAdjustment: MomoTheme.WorkConsole.resizeAdjustmentStep)
                case .up where !direction.isHorizontal:
                    adjust(physicalAdjustment: -MomoTheme.WorkConsole.resizeAdjustmentStep)
                case .down where !direction.isHorizontal:
                    adjust(physicalAdjustment: MomoTheme.WorkConsole.resizeAdjustmentStep)
                default:
                    break
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityLabel)
            .accessibilityValue(accessibilityValue)
            .accessibilityAdjustableAction { adjustment in
                switch adjustment {
                case .increment:
                    adjustValue(by: MomoTheme.WorkConsole.resizeAdjustmentStep)
                case .decrement:
                    adjustValue(by: -MomoTheme.WorkConsole.resizeAdjustmentStep)
                @unknown default:
                    break
                }
            }
            .accessibilityAction(named: Text(resetLabel), onReset)
            .help(accessibilityLabel)
    }

    private func adjust(physicalAdjustment: CGFloat) {
        onResize(direction.value(from: value, physicalAdjustment: physicalAdjustment))
    }

    private func adjustValue(by adjustment: CGFloat) {
        onResize(value + adjustment)
    }
}
