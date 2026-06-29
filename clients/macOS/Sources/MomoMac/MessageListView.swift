import SwiftUI
import MomoCore

// MARK: - MessageListView  (seq-ordered)
//
// The channel timeline. Ordering authority is Message.seq (L4 §1.2 #3) — the
// ViewModel keeps messages seq-sorted, this view just renders them oldest→newest
// and pins live agent partials at the bottom (AgentPartialView). Includes a small
// composer wired to optimistic send.

public struct MessageListView: View {
    @ObservedObject var viewModel: ChatViewModel
    @State private var draft: String = ""

    public init(viewModel: ChatViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
            if let error = viewModel.connectionError {
                connectionBanner(error)
                Divider()
            }
            Divider()
            timeline
            Divider()
            composer
        }
    }

    // MARK: Header (cost chip — experience B social signal)

    private var header: some View {
        HStack {
            if let id = viewModel.selectedChannelId,
               let channel = viewModel.channels.first(where: { $0.id == id }) {
                Image(systemName: channel.kind == .dm ? "person.2.fill" : "number")
                Text(channel.name ?? "DM").font(.headline)
                if let topic = channel.topic {
                    Text(topic).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                }
            } else {
                Text("Select a channel").foregroundStyle(.secondary)
            }
            Spacer()
            // Social cost chip (experience B): today's live spend.
            if viewModel.liveSpentMicroUSD > 0 {
                Label(CostFormat.usdCompact(viewModel.liveSpentMicroUSD), systemImage: "dollarsign.circle")
                    .font(.caption)
                    .foregroundStyle(MomoTheme.costAmber)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    private func connectionBanner(_ error: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "wifi.exclamationmark")
                .foregroundStyle(.orange)
            Text(error)
                .font(.caption)
                .lineLimit(2)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(.orange.opacity(0.08))
    }

    // MARK: Timeline (seq order)

    private var timeline: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    ForEach(viewModel.visibleMessages) { message in
                        MessageBubble(
                            message: message,
                            author: viewModel.member(message.authorMemberId),
                            cost: costSnapshot(for: message),
                            approvalStatus: viewModel.approvalStatus(for: message),
                            isApprovalDecisionInFlight: viewModel.isApprovalDecisionInFlight(for: message),
                            onApprovalDecision: { approvalId, approve in
                                Task { await viewModel.decideApproval(approvalId, approve: approve) }
                            }
                        )
                        .id(message.id)
                    }

                    // Live agent partials for the selected channel, pinned at the bottom.
                    ForEach(livePartials, id: \.runId) { partial in
                        AgentPartialView(
                            partial: partial,
                            author: nil,
                            status: viewModel.agentStatuses[partial.runId]
                        )
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .onChange(of: viewModel.visibleMessages.count) { _, _ in
                if let last = viewModel.visibleMessages.last {
                    withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
        }
    }

    // MARK: Composer (optimistic send)

    private var composer: some View {
        HStack(spacing: 8) {
            TextField("Message…", text: $draft, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...5)
                .onSubmit(submit)
            Button(action: submit) {
                Image(systemName: "paperplane.fill")
            }
            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                      || viewModel.selectedChannelId == nil)
        }
        .padding(12)
    }

    private func submit() {
        guard let channel = viewModel.selectedChannelId else { return }
        let body = draft
        draft = ""
        Task { await viewModel.send(body: body, to: channel) }
    }

    // MARK: Derived

    /// Partials whose channel matches the selected channel.
    private var livePartials: [AgentPartial] {
        guard let id = viewModel.selectedChannelId else { return [] }
        return viewModel.partials.values
            .filter { $0.channelId == id }
            .sorted { $0.runId.description < $1.runId.description }
    }

    /// Build a CostSnapshot from the run's latest agent.status (experience B).
    private func costSnapshot(for message: Message) -> CostSnapshot? {
        guard let runId = message.runId, let status = viewModel.agentStatuses[runId] else { return nil }
        return CostSnapshot(
            runId: runId,
            reservedMicroUSD: status.reservedMicroUSD ?? 0,
            spentMicroUSD: status.spentMicroUSD ?? 0
        )
    }
}
