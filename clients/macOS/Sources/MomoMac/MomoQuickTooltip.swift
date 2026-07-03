import SwiftUI

extension View {
    func momoQuickTooltip(_ text: String, delay: Double = 0.12) -> some View {
        modifier(MomoQuickTooltipModifier(text: text, delay: delay))
    }
}

private struct MomoQuickTooltipModifier: ViewModifier {
    let text: String
    let delay: Double
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
                        withAnimation(.easeOut(duration: 0.08)) {
                            isVisible = true
                        }
                    }
                } else {
                    withAnimation(.easeOut(duration: 0.06)) {
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
                        .padding(.vertical, 5)
                        .background(.regularMaterial, in: Capsule())
                        .overlay {
                            Capsule()
                                .stroke(.white.opacity(0.12), lineWidth: 1)
                        }
                        .shadow(color: .black.opacity(0.18), radius: 8, x: 0, y: 4)
                        .fixedSize()
                        .offset(y: -30)
                        .allowsHitTesting(false)
                        .transition(.opacity.combined(with: .scale(scale: 0.96)))
                }
            }
    }
}
