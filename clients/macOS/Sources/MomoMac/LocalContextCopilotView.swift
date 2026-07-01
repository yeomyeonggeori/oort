import SwiftUI

struct LocalContextCopilotView: View {
    @ObservedObject var viewModel: ChatViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "text.magnifyingglass")
                    .foregroundStyle(MomoTheme.agentAccent)
                    .frame(width: 16)

                Text("Context Copilot")
                    .font(.subheadline)
                    .lineLimit(1)

                Spacer(minLength: 8)

                Button {
                    Task { await viewModel.refreshLocalContextCopilotPreview() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .help("Refresh context preview")
                .disabled(viewModel.isLocalContextCopilotRefreshing)
            }

            if viewModel.isLocalContextCopilotRefreshing {
                ProgressView()
                    .controlSize(.small)
            } else if let preview = viewModel.localContextCopilotPreview {
                previewBody(preview)
            } else {
                Text("No preview")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 3)
        .task(id: viewModel.selectedChannelId) {
            await viewModel.refreshLocalContextCopilotPreview()
        }
    }

    private func previewBody(_ preview: LocalContextCopilotPreview) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(preview.route.badgeText)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(routeTint(preview.route))
                Text(preview.classification.intent)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 4)
                Text(preview.classification.riskHint)
                    .font(.caption2)
                    .foregroundStyle(preview.classification.riskHint == "approval-required" ? MomoTheme.costAmber : .secondary)
            }

            Text(preview.summary)
                .font(.caption)
                .foregroundStyle(.primary)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)

            Text(preview.contextPacket.sidebarPreview)
                .font(.caption2.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(4)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)

            if !preview.redactionHints.isEmpty {
                Label("\(preview.redactionHints.count) redaction hint", systemImage: "eye.slash")
                    .font(.caption2)
                    .foregroundStyle(MomoTheme.costAmber)
            }

            if !preview.sourceHints.isEmpty {
                sourceRow(preview.sourceHints)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func sourceRow(_ sources: [LocalContextSourceHint]) -> some View {
        HStack(alignment: .top, spacing: 4) {
            Image(systemName: "quote.bubble")
                .foregroundStyle(.secondary)
            Text(sources.prefix(4).map { "\($0.citation) \($0.id)" }.joined(separator: " · "))
                .font(.caption2.weight(.semibold))
                .foregroundStyle(MomoTheme.agentAccent)
                .lineLimit(2)
                .truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func routeTint(_ route: LocalContextCopilotRoute) -> Color {
        switch route {
        case .foundationModels:
            return MomoTheme.agentAccent
        case .deterministicFallback:
            return .orange
        }
    }
}
