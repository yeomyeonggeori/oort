import SwiftUI

extension View {
    func momoQuickTooltip(_ text: String, delay: Double = 0.12) -> some View {
        modifier(MomoQuickTooltipModifier(text: text, delay: delay))
    }
}

private struct MomoQuickTooltipModifier: ViewModifier {
    let text: String
    let delay: Double
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isHovering = false
    @State private var isVisible = false

    func body(content: Content) -> some View {
        content
            .help(text)
            .onHover { hovering in
                isHovering = hovering
                if hovering {
                    DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                        guard isHovering else { return }
                        withAnimation(hoverAnimation) {
                            isVisible = true
                        }
                    }
                } else {
                    withAnimation(hoverAnimation) {
                        isVisible = false
                    }
                }
            }
            .overlay(alignment: .top) {
                if isVisible {
                    Text(text)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.primary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .momoSurface(.card, cornerRadius: MomoTheme.cornerLarge)
                        .fixedSize()
                        .offset(y: -30)
                        .allowsHitTesting(false)
                        .transition(.opacity)
                }
            }
    }

    private var hoverAnimation: Animation? {
        reduceMotion ? nil : MomoTheme.Motion.hover
    }
}
