import SwiftUI

enum MomoQuickTooltipCoordinateSpace {
    static let window = "momo.quick-tooltip.window"
}

extension View {
    func momoQuickTooltip(_ text: String, delay: Double = 0.12) -> some View {
        modifier(MomoQuickTooltipModifier(text: text, delay: min(delay, 0.15)))
    }
}

struct MomoQuickTooltipPlacement {
    static func origin(
        anchor: CGRect,
        tooltipSize: CGSize,
        visibleFrame: CGRect,
        gap: CGFloat = MomoTheme.QuickTooltip.anchorGap,
        edgeInset: CGFloat = MomoTheme.QuickTooltip.screenEdgeInset
    ) -> CGPoint {
        let available = visibleFrame.insetBy(dx: edgeInset, dy: edgeInset)
        let centeredX = anchor.midX - tooltipSize.width / 2
        let x = min(
            max(centeredX, available.minX),
            max(available.minX, available.maxX - tooltipSize.width)
        )
        let below = anchor.maxY + gap
        let above = anchor.minY - gap - tooltipSize.height
        let y: CGFloat
        if below + tooltipSize.height <= available.maxY {
            y = below
        } else {
            y = max(above, available.minY)
        }
        return CGPoint(x: x, y: y)
    }
}

struct MomoQuickTooltipItem: Equatable {
    let sourceID: UUID
    let text: String
    let anchor: CGRect
}

enum MomoQuickTooltipMeasurement {
    static func constrainedWidth(for intrinsicWidth: CGFloat) -> CGFloat {
        min(intrinsicWidth, MomoTheme.QuickTooltip.maximumWidth)
    }
}

@MainActor
final class MomoQuickTooltipPresenter: ObservableObject {
    @Published private(set) var item: MomoQuickTooltipItem?

    func show(sourceID: UUID, text: String, anchor: CGRect) {
        guard !text.isEmpty, !anchor.isEmpty else { return }
        item = MomoQuickTooltipItem(sourceID: sourceID, text: text, anchor: anchor)
    }

    func dismiss(sourceID: UUID) {
        guard item?.sourceID == sourceID else { return }
        item = nil
    }
}

private struct MomoQuickTooltipPresenterKey: EnvironmentKey {
    static let defaultValue: MomoQuickTooltipPresenter? = nil
}

extension EnvironmentValues {
    var momoQuickTooltipPresenter: MomoQuickTooltipPresenter? {
        get { self[MomoQuickTooltipPresenterKey.self] }
        set { self[MomoQuickTooltipPresenterKey.self] = newValue }
    }
}

struct MomoQuickTooltipOverlay: View {
    @ObservedObject var presenter: MomoQuickTooltipPresenter
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { geometry in
            if let item = presenter.item {
                MomoQuickTooltipWindowLayout(anchor: item.anchor) {
                    MomoQuickTooltipLabel(text: item.text)
                        .transition(.opacity)
                }
                .frame(width: geometry.size.width, height: geometry.size.height)
            }
        }
        .allowsHitTesting(false)
        .animation(reduceMotion ? nil : MomoTheme.Motion.hover, value: presenter.item)
    }
}

private struct MomoQuickTooltipWindowLayout: Layout {
    let anchor: CGRect

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        guard let tooltip = subviews.first else { return }
        let intrinsicSize = tooltip.sizeThatFits(.unspecified)
        let tooltipProposal = ProposedViewSize(
            width: MomoQuickTooltipMeasurement.constrainedWidth(for: intrinsicSize.width),
            height: nil
        )
        let tooltipSize = tooltip.sizeThatFits(tooltipProposal)
        let origin = MomoQuickTooltipPlacement.origin(
            anchor: anchor,
            tooltipSize: tooltipSize,
            visibleFrame: bounds
        )
        tooltip.place(
            at: origin,
            anchor: .topLeading,
            proposal: ProposedViewSize(width: tooltipSize.width, height: tooltipSize.height)
        )
    }
}

private struct MomoQuickTooltipModifier: ViewModifier {
    let text: String
    let delay: Double
    @Environment(\.momoQuickTooltipPresenter) private var presenter
    @State private var sourceID = UUID()
    @State private var anchorFrame = CGRect.zero
    @State private var isHovering = false
    @State private var presentationTask: Task<Void, Never>?
    @FocusState private var isFocused: Bool

    func body(content: Content) -> some View {
        content
            .help(text)
            .focused($isFocused)
            .background {
                GeometryReader { geometry in
                    let frame = geometry.frame(in: .named(MomoQuickTooltipCoordinateSpace.window))
                    Color.clear
                        .allowsHitTesting(false)
                        .onAppear { anchorFrame = frame }
                        .onChange(of: frame) { _, updatedFrame in
                            anchorFrame = updatedFrame
                            if isHovering || isFocused {
                                presenter?.show(sourceID: sourceID, text: text, anchor: updatedFrame)
                            }
                        }
                }
            }
            .onHover { hovering in
                isHovering = hovering
                updatePresentation()
            }
            .onChange(of: isFocused) { _, _ in
                updatePresentation()
            }
            .onDisappear {
                presentationTask?.cancel()
                presenter?.dismiss(sourceID: sourceID)
            }
    }

    private func updatePresentation() {
        presentationTask?.cancel()
        guard isHovering || isFocused else {
            presenter?.dismiss(sourceID: sourceID)
            return
        }
        presentationTask = Task { @MainActor in
            let duration = max(0, delay)
            if duration > 0 {
                try? await Task.sleep(for: .seconds(duration))
            }
            guard !Task.isCancelled, isHovering || isFocused else { return }
            presenter?.show(sourceID: sourceID, text: text, anchor: anchorFrame)
        }
    }
}

struct MomoQuickTooltipLabel: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.primary)
            .multilineTextAlignment(.leading)
            .lineLimit(3)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, MomoTheme.QuickTooltip.horizontalPadding)
            .padding(.vertical, MomoTheme.QuickTooltip.verticalPadding)
            .frame(maxWidth: MomoTheme.QuickTooltip.maximumWidth)
            .momoSurface(.card, cornerRadius: MomoTheme.cornerSmall)
    }
}
