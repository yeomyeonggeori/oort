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
    private struct SourceState {
        var text: String
        var anchor: CGRect
        var isHovering: Bool
        var isFocused: Bool
        var isReady: Bool
        var activationOrder: UInt64

        var isActive: Bool { isHovering || isFocused }
    }

    @Published private(set) var item: MomoQuickTooltipItem?
    private var sources: [UUID: SourceState] = [:]
    private var activationCounter: UInt64 = 0

    func update(
        sourceID: UUID,
        text: String,
        anchor: CGRect,
        isHovering: Bool,
        isFocused: Bool
    ) {
        guard !text.isEmpty, !anchor.isEmpty else {
            remove(sourceID: sourceID)
            return
        }
        let wasActive = sources[sourceID]?.isActive == true
        let remainsActive = isHovering || isFocused
        guard remainsActive else {
            remove(sourceID: sourceID)
            return
        }
        var source = sources[sourceID] ?? SourceState(
            text: text,
            anchor: anchor,
            isHovering: false,
            isFocused: false,
            isReady: false,
            activationOrder: 0
        )
        source.text = text
        source.anchor = anchor
        source.isHovering = isHovering
        source.isFocused = isFocused
        if !wasActive {
            source.isReady = false
        }
        sources[sourceID] = source
        refreshItem()
    }

    func present(sourceID: UUID) {
        guard var source = sources[sourceID], source.isActive else { return }
        activationCounter &+= 1
        source.isReady = true
        source.activationOrder = activationCounter
        sources[sourceID] = source
        refreshItem()
    }

    func remove(sourceID: UUID) {
        sources[sourceID] = nil
        refreshItem()
    }

    private func refreshItem() {
        let visible = sources
            .filter { $0.value.isReady && $0.value.isActive }
            .max { lhs, rhs in
                let lhsHoverPriority = lhs.value.isHovering ? 1 : 0
                let rhsHoverPriority = rhs.value.isHovering ? 1 : 0
                if lhsHoverPriority != rhsHoverPriority {
                    return lhsHoverPriority < rhsHoverPriority
                }
                return lhs.value.activationOrder < rhs.value.activationOrder
            }
        item = visible.map { entry in
            MomoQuickTooltipItem(
                sourceID: entry.key,
                text: entry.value.text,
                anchor: entry.value.anchor
            )
        }
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
        .accessibilityHidden(true)
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
            .modifier(
                MomoNativeHelpFallback(
                    text: text,
                    isEnabled: presenter == nil
                )
            )
            .focused($isFocused)
            .accessibilityHint(Text(text))
            .background {
                GeometryReader { geometry in
                    let frame = geometry.frame(in: .named(MomoQuickTooltipCoordinateSpace.window))
                    Color.clear
                        .allowsHitTesting(false)
                        .onAppear {
                            anchorFrame = frame
                            synchronizePresenter()
                        }
                        .onChange(of: frame) { _, updatedFrame in
                            anchorFrame = updatedFrame
                            synchronizePresenter()
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
            .onChange(of: text) { _, _ in
                synchronizePresenter()
            }
            .onDisappear {
                presentationTask?.cancel()
                presenter?.remove(sourceID: sourceID)
            }
    }

    private func updatePresentation() {
        presentationTask?.cancel()
        synchronizePresenter()
        guard isHovering || isFocused else {
            return
        }
        presentationTask = Task { @MainActor in
            let duration = max(0, delay)
            if duration > 0 {
                try? await Task.sleep(for: .seconds(duration))
            }
            guard !Task.isCancelled, isHovering || isFocused else { return }
            presenter?.present(sourceID: sourceID)
        }
    }

    private func synchronizePresenter() {
        presenter?.update(
            sourceID: sourceID,
            text: text,
            anchor: anchorFrame,
            isHovering: isHovering,
            isFocused: isFocused
        )
    }
}

private struct MomoNativeHelpFallback: ViewModifier {
    let text: String
    let isEnabled: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if isEnabled {
            content.help(text)
        } else {
            content
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
            .accessibilityHidden(true)
    }
}
