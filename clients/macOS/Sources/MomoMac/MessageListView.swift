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
    @AppStorage(MomoUILanguage.appStorageKey) private var languageRaw = MomoUILanguage.preferredDefault.rawValue
    @AppStorage("momo.workspace.showQuickStart") private var showQuickStart = true

    public init(viewModel: ChatViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        let copy = MomoWorkspaceCopy(language: language)

        VStack(spacing: 0) {
            header(copy: copy)
            if showQuickStart {
                quickStartCard(copy: copy)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 12)
            }
            if let status = viewModel.selectedRealtimeStatus {
                realtimeStatusBanner(status, copy: copy)
                Divider()
            } else if let error = viewModel.connectionError {
                connectionBanner(error, copy: copy)
                Divider()
            }
            if let notice = viewModel.mentionNotice {
                mentionNoticeBanner(notice)
                Divider()
            }
            Divider()
            timeline(copy: copy)
            Divider()
            composer(copy: copy)
        }
    }

    // MARK: Header (cost chip — experience B social signal)

    private var language: MomoUILanguage {
        MomoUILanguage(rawValue: languageRaw) ?? .preferredDefault
    }

    private func header(copy: MomoWorkspaceCopy) -> some View {
        HStack {
            if let id = viewModel.selectedChannelId,
               let channel = viewModel.channels.first(where: { $0.id == id }) {
                Image(systemName: channel.kind == .dm ? "person.2.fill" : "number")
                    .foregroundStyle(.secondary)
                Text(channel.name ?? "DM")
                    .font(.system(size: 18, weight: .semibold))
                if let topic = channel.topic {
                    Text(topic)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            } else {
                Text(copy.selectChannel)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            // Social cost chip (experience B): today's live spend.
            if viewModel.liveSpentMicroUSD > 0 {
                Label(CostFormat.usdCompact(viewModel.liveSpentMicroUSD), systemImage: "dollarsign.circle")
                    .font(.caption)
                    .foregroundStyle(MomoTheme.costAmber)
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 15)
    }

    private func quickStartCard(copy: MomoWorkspaceCopy) -> some View {
        HStack(alignment: .top, spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .fill(MomoTheme.agentAccent.opacity(0.18))
                Image(systemName: "sparkles")
                    .foregroundStyle(MomoTheme.agentAccent)
                    .font(.system(size: 17, weight: .bold))
            }
            .frame(width: 36, height: 36)

            VStack(alignment: .leading, spacing: 8) {
                Text(copy.quickStartTitle)
                    .font(.system(size: 15, weight: .semibold))
                Text(copy.quickStartSubtitle)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 8) {
                    MomoGuideStepPill(index: 1, title: copy.guideStepChannel)
                    MomoGuideStepPill(index: 2, title: copy.guideStepAgent)
                    MomoGuideStepPill(index: 3, title: copy.guideStepApproval)
                }

                HStack(spacing: 8) {
                    Button {
                        insertPreferredAgentMention()
                    } label: {
                        Label(copy.insertAgentMention, systemImage: "at")
                    }
                    .controlSize(.small)
                    .disabled(preferredAgent == nil)

                    Button {
                        viewModel.composerDraft = copy.guideSummaryPromptText
                    } label: {
                        Label(copy.draftSummaryPrompt, systemImage: "text.badge.plus")
                    }
                    .controlSize(.small)
                    .disabled(viewModel.selectedChannelId == nil)
                }
            }

            Spacer(minLength: 0)

            Button {
                showQuickStart = false
            } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .help(copy.dismissGuide)
        }
        .padding(14)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(.white.opacity(0.10), lineWidth: 1)
        }
    }

    private func realtimeStatusBanner(_ status: RealtimeConnectionStatus, copy: MomoWorkspaceCopy) -> some View {
        HStack(spacing: 8) {
            Image(systemName: statusIcon(status))
                .foregroundStyle(statusColor(status))
            VStack(alignment: .leading, spacing: 1) {
                Text(statusTitle(status, copy: copy))
                    .font(.caption.weight(.semibold))
                if let message = status.message, !message.isEmpty, !status.isLive {
                    Text(message)
                        .font(.caption2)
                        .lineLimit(1)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            if status.canRetry {
                Button {
                    Task { await viewModel.retryRealtime() }
                } label: {
                    Label(copy.retry, systemImage: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .font(.caption)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(statusColor(status).opacity(0.08))
    }

    private func connectionBanner(_ error: String, copy: MomoWorkspaceCopy) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "wifi.exclamationmark")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 1) {
                Text(copy.recoverableError)
                    .font(.caption.weight(.semibold))
                Text(error)
                    .font(.caption2)
                    .lineLimit(2)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                Task { await viewModel.retrySelectedChannelLoad() }
            } label: {
                Label(copy.retry, systemImage: "arrow.clockwise")
            }
            .buttonStyle(.borderless)
            .font(.caption)
            Button {
                viewModel.clearConnectionError()
            } label: {
                Image(systemName: "xmark.circle")
            }
            .buttonStyle(.borderless)
            .help(copy.dismiss)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(.orange.opacity(0.08))
    }

    private func mentionNoticeBanner(_ notice: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "at")
                .foregroundStyle(MomoTheme.agentAccent)
            Text(notice)
                .font(.caption)
                .lineLimit(1)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(MomoTheme.agentAccent.opacity(0.08))
    }

    private func statusTitle(_ status: RealtimeConnectionStatus, copy: MomoWorkspaceCopy) -> String {
        if status.isLive {
            return copy.live
        }
        switch (status.connection, status.subscription, status.fallback) {
        case (.disabled, .disabled, .restHistory):
            return copy.restFallback
        case (.connecting, _, _), (.connected, .subscribing, _):
            return copy.connectingLive
        case (.reconnecting, _, _), (_, .recovering, _):
            return copy.reconnecting
        case (.offline, _, .restHistory), (_, .unsubscribed, .restHistory):
            return copy.offlineRestFallback
        case (.error, _, .restHistory), (_, .error, .restHistory):
            return copy.liveErrorRestFallback
        default:
            return "Realtime \(status.connection.rawValue)"
        }
    }

    private func statusIcon(_ status: RealtimeConnectionStatus) -> String {
        if status.isLive { return "dot.radiowaves.left.and.right" }
        switch status.connection {
        case .connecting, .reconnecting:
            return "arrow.triangle.2.circlepath"
        case .offline, .disabled:
            return "clock.arrow.circlepath"
        case .error:
            return "wifi.exclamationmark"
        case .connected:
            return status.subscription == .subscribed ? "dot.radiowaves.left.and.right" : "antenna.radiowaves.left.and.right"
        }
    }

    private func statusColor(_ status: RealtimeConnectionStatus) -> Color {
        if status.isLive { return .green }
        switch status.connection {
        case .connecting, .reconnecting:
            return .blue
        case .error:
            return .orange
        case .offline, .disabled:
            return .secondary
        case .connected:
            return status.subscription == .error ? .orange : .blue
        }
    }

    // MARK: Timeline (seq order)

    private func timeline(copy: MomoWorkspaceCopy) -> some View {
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
                            author: partialAuthor(for: partial),
                            status: viewModel.agentStatuses[partial.runId]
                        )
                    }

                    ForEach(viewModel.visibleWorkingAgents) { agent in
                        AgentWorkingTimelineRow(agent: agent, copy: copy)
                            .id("working-\(agent.id.description)")
                    }

                    Color.clear
                        .frame(height: 1)
                        .id("timeline-bottom")
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .onChange(of: viewModel.visibleMessages.count) { _, _ in
                if let last = viewModel.visibleMessages.last {
                    withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
            .onChange(of: viewModel.visibleWorkingAgents.map(\.id)) { _, ids in
                guard !ids.isEmpty else { return }
                withAnimation { proxy.scrollTo("timeline-bottom", anchor: .bottom) }
            }
        }
    }

    // MARK: Composer (optimistic send)

    private func composer(copy: MomoWorkspaceCopy) -> some View {
        let candidates = viewModel.mentionAutocompleteCandidates()
        return VStack(alignment: .leading, spacing: 8) {
            if !candidates.isEmpty {
                mentionAutocomplete(candidates: Array(candidates.prefix(6)), copy: copy)
            }

            HStack(spacing: 8) {
                TextField(copy.messagePlaceholder, text: $viewModel.composerDraft, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...5)
                    .font(.body)
                    .onSubmit(submit)
                Button(action: submit) {
                    Image(systemName: "paperplane.fill")
                }
                .disabled(viewModel.composerDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                          || viewModel.selectedChannelId == nil)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    private func mentionAutocomplete(candidates: [Member], copy: MomoWorkspaceCopy) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(copy.mentionAutocompleteTitle)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8)
            ForEach(candidates) { member in
                Button {
                    viewModel.completeMentionAutocomplete(with: member)
                } label: {
                    HStack(spacing: 10) {
                        MentionCandidateAvatar(member: member, isWorking: viewModel.isAgentWorking(member))
                        VStack(alignment: .leading, spacing: 1) {
                            Text(member.displayName)
                                .font(.callout.weight(.semibold))
                            Text("@\(member.handle) · \(member.isAgent ? copy.agent : copy.human)")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if member.isAgent {
                            Text("AGENT")
                                .font(.caption2.weight(.bold))
                                .padding(.horizontal, 5)
                                .padding(.vertical, 2)
                                .background(MomoTheme.agentAccent.opacity(0.18), in: Capsule())
                                .foregroundStyle(MomoTheme.agentAccent)
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(6)
        .frame(width: 300, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(.white.opacity(0.10), lineWidth: 1)
        }
    }

    private var preferredAgent: Member? {
        viewModel.members.first { $0.isAgent && viewModel.canInsertMention(for: $0) }
    }

    private func insertPreferredAgentMention() {
        guard let agent = preferredAgent else { return }
        viewModel.insertMention(for: agent)
    }

    private func submit() {
        guard let channel = viewModel.selectedChannelId else { return }
        let body = viewModel.composerDraft
        viewModel.composerDraft = ""
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

    /// Read the server-owned CostSnapshot projection for the message's run.
    private func costSnapshot(for message: Message) -> CostSnapshot? {
        guard let runId = message.runId else { return nil }
        return viewModel.costSnapshot(for: runId)
    }

    private func partialAuthor(for partial: AgentPartial) -> Member? {
        guard let agent = viewModel.agentStatuses[partial.runId]?.agentMemberId else {
            return nil
        }
        return viewModel.member(agent)
    }
}

private struct MomoGuideStepPill: View {
    var index: Int
    var title: String

    var body: some View {
        HStack(spacing: 5) {
            Text("\(index)")
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 16, height: 16)
                .background(MomoTheme.humanAccent, in: Circle())
            Text(title)
                .font(.caption2.weight(.semibold))
                .lineLimit(1)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 4)
        .background(.thinMaterial, in: Capsule())
    }
}

private struct AgentWorkingTimelineRow: View {
    var agent: Member
    var copy: MomoWorkspaceCopy

    var body: some View {
        HStack(spacing: 10) {
            ProgressView()
                .controlSize(.small)
            VStack(alignment: .leading, spacing: 2) {
                Text(copy.agentWorkingTitle(agent.displayName))
                    .font(.callout.weight(.semibold))
                Text(copy.agentWorkingSubtitle)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(MomoTheme.agentAccent.opacity(0.09), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(MomoTheme.agentAccent.opacity(0.16), lineWidth: 1)
        }
    }
}

private struct MentionCandidateAvatar: View {
    var member: Member
    var isWorking: Bool

    private var initials: String {
        guard let first = member.displayName.trimmingCharacters(in: .whitespacesAndNewlines).first else {
            return member.isAgent ? "A" : "M"
        }
        return String(first).uppercased()
    }

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Text(initials)
                .font(.caption.weight(.bold))
                .foregroundStyle(.white)
                .frame(width: 28, height: 28)
                .background(member.isAgent ? MomoTheme.agentAccent : MomoTheme.humanAccent, in: Circle())
            Circle()
                .fill(isWorking ? MomoTheme.costAmber : .green)
                .frame(width: 8, height: 8)
                .overlay(Circle().stroke(.black.opacity(0.35), lineWidth: 1))
        }
    }
}
