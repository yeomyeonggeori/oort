import SwiftUI
import MomoCore

struct MomoQuickSwitcherPresentationState: Equatable {
    private(set) var isPresented = false

    mutating func toggle() {
        isPresented.toggle()
    }

    mutating func dismiss() {
        isPresented = false
    }
}

enum MomoQuickSwitcherKeyEvent {
    case moveUp
    case moveDown
    case confirm
    case cancel
}

enum MomoQuickSwitcherKeyOutcome: Equatable {
    case none
    case activate(MomoQuickSwitcherDestination)
    case dismiss
}

struct MomoQuickSwitcherKeyboardState: Equatable {
    var selectedID: MomoQuickSwitcherDestination?

    mutating func reset(items: [MomoQuickSwitcherItem]) {
        selectedID = items.first?.id
    }

    mutating func handle(
        _ event: MomoQuickSwitcherKeyEvent,
        items: [MomoQuickSwitcherItem]
    ) -> MomoQuickSwitcherKeyOutcome {
        switch event {
        case .moveUp:
            moveSelection(by: -1, items: items)
            return .none
        case .moveDown:
            moveSelection(by: 1, items: items)
            return .none
        case .confirm:
            if selectedID == nil { reset(items: items) }
            guard let selectedID else { return .none }
            return .activate(selectedID)
        case .cancel:
            return .dismiss
        }
    }

    private mutating func moveSelection(by offset: Int, items: [MomoQuickSwitcherItem]) {
        guard !items.isEmpty else {
            selectedID = nil
            return
        }
        guard let selectedID,
              let currentIndex = items.firstIndex(where: { $0.id == selectedID })
        else {
            self.selectedID = items.first?.id
            return
        }
        self.selectedID = items[(currentIndex + offset + items.count) % items.count].id
    }
}

// A custom in-window panel keeps search focus in the active conversation window,
// which a separate system sheet cannot guarantee for the first Cmd+K keystroke.
struct MomoQuickSwitcherView: View {
    @ObservedObject var viewModel: ChatViewModel
    var copy: MomoWorkspaceCopy
    var activate: (MomoQuickSwitcherDestination) -> Void
    var dismiss: () -> Void

    @State private var query = ""
    @State private var keyboardState = MomoQuickSwitcherKeyboardState()
    @State private var hoveredItemID: MomoQuickSwitcherDestination?
    @FocusState private var searchIsFocused: Bool
    @AccessibilityFocusState private var accessibilityFocusedItemID: MomoQuickSwitcherDestination?

    private var sections: [MomoQuickSwitcherSection] {
        viewModel.quickSwitcherSections(query: query)
    }

    private var items: [MomoQuickSwitcherItem] {
        sections.flatMap(\.items)
    }

    private var resultsViewportHeight: CGFloat {
        let rowHeight = CGFloat(items.count) * MomoTheme.QuickSwitcher.rowMinimumHeight
        let headerHeight = CGFloat(sections.count) * MomoTheme.QuickSwitcher.sectionHeaderHeight
        let contentHeight = rowHeight + headerHeight + MomoTheme.QuickSwitcher.standardSpacing
        return min(
            MomoTheme.QuickSwitcher.resultsMaximumHeight,
            max(MomoTheme.QuickSwitcher.resultsMinimumHeight, contentHeight)
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            searchField
            Divider()
            results
            Divider()
            footer
        }
        .frame(width: MomoTheme.QuickSwitcher.panelWidth)
        .background(
            .regularMaterial,
            in: RoundedRectangle(
                cornerRadius: MomoTheme.QuickSwitcher.panelCornerRadius,
                style: .continuous
            )
        )
        .overlay {
            RoundedRectangle(
                cornerRadius: MomoTheme.QuickSwitcher.panelCornerRadius,
                style: .continuous
            )
            .stroke(MomoTheme.subtleBorder, lineWidth: 1)
        }
        .shadow(color: MomoTheme.floatingPanelShadow, radius: 24, y: 12)
        .onAppear {
            keyboardState.reset(items: items)
            searchIsFocused = true
        }
        .onChange(of: items.map(\.id)) { _, _ in
            guard items.contains(where: { $0.id == keyboardState.selectedID }) else {
                keyboardState.reset(items: items)
                return
            }
        }
        .onMoveCommand { direction in
            switch direction {
            case .up: handle(.moveUp)
            case .down: handle(.moveDown)
            default: break
            }
        }
        .onExitCommand {
            handle(.cancel)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(copy.quickSwitcherTitle)
    }

    private var searchField: some View {
        HStack(spacing: MomoTheme.QuickSwitcher.standardSpacing) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
            TextField(copy.quickSwitcherPlaceholder, text: $query)
                .textFieldStyle(.plain)
                .font(.title3)
                .focused($searchIsFocused)
                .onSubmit {
                    handle(.confirm)
                }
                .onKeyPress(.upArrow) {
                    handle(.moveUp)
                    return .handled
                }
                .onKeyPress(.downArrow) {
                    handle(.moveDown)
                    return .handled
                }
                .onKeyPress(.escape) {
                    handle(.cancel)
                    return .handled
                }

            if !query.isEmpty {
                Button {
                    query = ""
                } label: {
                    Label(copy.quickSwitcherClearSearch, systemImage: "xmark.circle.fill")
                        .labelStyle(.iconOnly)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help(copy.quickSwitcherClearSearch)
            }
        }
        .padding(MomoTheme.QuickSwitcher.edgeInset)
    }

    @ViewBuilder
    private var results: some View {
        if viewModel.workspaceId == nil && viewModel.channels.isEmpty {
            VStack(spacing: MomoTheme.QuickSwitcher.standardSpacing) {
                ProgressView()
                Text(copy.quickSwitcherLoading)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, minHeight: MomoTheme.QuickSwitcher.resultsMinimumHeight)
        } else if items.isEmpty {
            VStack(spacing: MomoTheme.QuickSwitcher.standardSpacing) {
                Text(query.isEmpty ? copy.quickSwitcherEmpty : copy.quickSwitcherNoResults)
                    .font(.body.weight(.semibold))
                Button(query.isEmpty ? copy.quickSwitcherClose : copy.quickSwitcherClearSearch) {
                    if query.isEmpty {
                        dismiss()
                    } else {
                        query = ""
                    }
                }
            }
            .frame(maxWidth: .infinity, minHeight: MomoTheme.QuickSwitcher.resultsMinimumHeight)
        } else {
            // List does not reliably render inside an unattached NSHostingView and
            // cannot keep TextField focus while exposing deterministic arrow selection.
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: MomoTheme.QuickSwitcher.sectionSpacing) {
                        ForEach(sections) { section in
                            VStack(alignment: .leading, spacing: MomoTheme.QuickSwitcher.compactSpacing) {
                                Text(section.title(copy: copy))
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                    .padding(.horizontal, MomoTheme.QuickSwitcher.standardSpacing)

                                ForEach(section.items) { item in
                                    resultRow(item)
                                        .id(item.id)
                                }
                            }
                        }
                    }
                    .padding(MomoTheme.QuickSwitcher.standardSpacing)
                }
                .onChange(of: keyboardState.selectedID) { _, selectedID in
                    guard let selectedID else { return }
                    proxy.scrollTo(selectedID, anchor: .center)
                }
            }
            .frame(height: resultsViewportHeight)
        }
    }

    private func resultRow(_ item: MomoQuickSwitcherItem) -> some View {
        Button {
            activate(item.destination)
        } label: {
            HStack(spacing: MomoTheme.QuickSwitcher.standardSpacing) {
                Image(systemName: item.systemImage)
                    .foregroundStyle(iconColor(for: item))
                    .frame(
                        width: MomoTheme.QuickSwitcher.iconSize,
                        height: MomoTheme.QuickSwitcher.iconSize
                    )

                VStack(alignment: .leading, spacing: MomoTheme.QuickSwitcher.compactSpacing) {
                    Text(item.title)
                        .font(.body.weight(.medium))
                        .lineLimit(1)
                    if let subtitle = item.subtitle, !subtitle.isEmpty {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }

                if case .member(let isAgent) = item.kind, isAgent {
                    Text("AGENT")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, MomoTheme.QuickSwitcher.compactSpacing)
                        .background(MomoTheme.agentAccent.opacity(0.18), in: Capsule())
                        .foregroundStyle(MomoTheme.agentAccent)
                }

                Spacer(minLength: MomoTheme.QuickSwitcher.standardSpacing)

                if let shortcutNumber = item.shortcutNumber {
                    Text("⌘\(shortcutNumber)")
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, MomoTheme.QuickSwitcher.standardSpacing)
            .padding(.vertical, MomoTheme.QuickSwitcher.compactSpacing)
            .frame(maxWidth: .infinity, minHeight: MomoTheme.QuickSwitcher.rowMinimumHeight)
            .contentShape(Rectangle())
            .background(
                rowBackground(for: item),
                in: RoundedRectangle(
                    cornerRadius: MomoTheme.QuickSwitcher.rowCornerRadius,
                    style: .continuous
                )
            )
        }
        .buttonStyle(.plain)
        .onHover { isHovering in
            hoveredItemID = isHovering ? item.id : nil
            if isHovering { keyboardState.selectedID = item.id }
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint(copy.quickSwitcherOpenResult)
        .accessibilityAddTraits(keyboardState.selectedID == item.id ? .isSelected : [])
        .accessibilityFocused($accessibilityFocusedItemID, equals: item.id)
    }

    @ViewBuilder
    private var footer: some View {
        VStack(spacing: MomoTheme.QuickSwitcher.compactSpacing) {
            if let connectionError = viewModel.connectionError {
                HStack(spacing: MomoTheme.QuickSwitcher.standardSpacing) {
                    Label(copy.quickSwitcherSearchError, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(MomoTheme.irreversibleRed)
                    Text(connectionError)
                        .lineLimit(1)
                        .foregroundStyle(.secondary)
                    Spacer()
                    if viewModel.selectedChannelId != nil {
                        Button(copy.retry) {
                            Task { await viewModel.retrySelectedChannelLoad() }
                        }
                        .controlSize(.small)
                    } else {
                        Button(copy.dismiss) {
                            viewModel.clearConnectionError()
                        }
                        .controlSize(.small)
                    }
                }
            } else if viewModel.selectedRealtimeStatus?.isFallbackActive == true {
                Label(copy.quickSwitcherOfflineNote, systemImage: "wifi.slash")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            HStack(spacing: MomoTheme.QuickSwitcher.sectionSpacing) {
                shortcutHint("↑↓", label: copy.quickSwitcherMoveSelection)
                shortcutHint("↩", label: copy.quickSwitcherOpenResult)
                shortcutHint("esc", label: copy.quickSwitcherClose)
                Spacer()
            }
            .foregroundStyle(.secondary)
        }
        .font(.caption)
        .padding(.horizontal, MomoTheme.QuickSwitcher.edgeInset)
        .padding(.vertical, MomoTheme.QuickSwitcher.standardSpacing)
    }

    private func shortcutHint(_ key: String, label: String) -> some View {
        HStack(spacing: MomoTheme.QuickSwitcher.compactSpacing) {
            Text(key)
                .font(.caption.monospaced())
            Text(label)
        }
    }

    private func rowBackground(for item: MomoQuickSwitcherItem) -> Color {
        if keyboardState.selectedID == item.id {
            return MomoTheme.QuickSwitcher.selectionBackground
        }
        if hoveredItemID == item.id {
            return MomoTheme.QuickSwitcher.hoverBackground
        }
        return .clear
    }

    private func iconColor(for item: MomoQuickSwitcherItem) -> Color {
        if case .member(let isAgent) = item.kind, isAgent {
            return MomoTheme.agentAccent
        }
        return .secondary
    }

    private func handle(_ event: MomoQuickSwitcherKeyEvent) {
        let outcome = keyboardState.handle(event, items: items)
        switch event {
        case .moveUp, .moveDown:
            accessibilityFocusedItemID = keyboardState.selectedID
        case .confirm, .cancel:
            break
        }
        switch outcome {
        case .none:
            break
        case .activate(let destination):
            activate(destination)
        case .dismiss:
            dismiss()
        }
    }
}
