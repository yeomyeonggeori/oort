import SwiftUI
import MomoCore

// MARK: - ChannelListView
//
// Sidebar listing the workspace's channels + an agent roster with live presence.
// Selecting a channel drives the message list (L4 §9.3 macOS-first surface).

public struct ChannelListView: View {
    @ObservedObject var viewModel: ChatViewModel
    @State private var isCreatingChannel = false
    @State private var newChannelName = ""
    @State private var newChannelTopic = ""
    @State private var newChannelKind: ChannelKind = .publicChannel

    public init(viewModel: ChatViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        List(selection: Binding(
            get: { viewModel.selectedChannelId },
            set: { newValue in
                if let id = newValue {
                    Task { await viewModel.selectChannel(id) }
                }
            }
        )) {
            Section("Workspace") {
                OnboardingInviteView(viewModel: viewModel)
            }

            Section("Local AI") {
                KimInternAvailabilityView(status: viewModel.agentRuntimeStatus) {
                    Task { await viewModel.refreshAgentRuntimeStatus() }
                }
                FoundationModelsCapabilityView(state: viewModel.foundationModelsCapability)
                LocalContextCopilotView(viewModel: viewModel)
            }

            if let error = viewModel.connectionError {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .lineLimit(3)
                }
            }

            Section {
                if isCreatingChannel {
                    channelCreateForm
                }
                if viewModel.channels.isEmpty {
                    Label("No channels available", systemImage: "tray")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(viewModel.channels) { channel in
                        channelRow(channel).tag(channel.id)
                    }
                }
            } header: {
                HStack {
                    Text("Channels")
                    Spacer()
                    Button {
                        isCreatingChannel.toggle()
                    } label: {
                        Image(systemName: isCreatingChannel ? "xmark.circle" : "plus.circle")
                    }
                    .buttonStyle(.plain)
                    .help(isCreatingChannel ? "Cancel" : "New Channel")
                }
            }

            // Approval inbox pin (experience C): a global entry point.
            Section {
                Label {
                    HStack {
                        Text("Approvals")
                        Spacer()
                        if !viewModel.pendingApprovals.isEmpty {
                            Text("\(viewModel.pendingApprovals.count)")
                                .font(.caption.bold())
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(MomoTheme.irreversibleRed, in: Capsule())
                                .foregroundStyle(.white)
                        }
                    }
                } icon: {
                    Image(systemName: "checkmark.seal")
                }
            }

            Section {
                ForEach(viewModel.members) { member in
                    memberRow(member)
                }
            } header: {
                HStack {
                    Text("Members")
                    Spacer()
                    if let selected = viewModel.selectedChannel {
                        Text(channelTitle(selected))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
        }
        .listStyle(.sidebar)
    }

    @ViewBuilder
    private func channelRow(_ channel: Channel) -> some View {
        HStack(spacing: 6) {
            Image(systemName: channelIcon(channel.kind))
                .foregroundStyle(.secondary)
            Text(channel.name ?? "DM")
                .lineLimit(1)
        }
    }

    @ViewBuilder
    private func memberRow(_ member: Member) -> some View {
        if member.isAgent {
            Button {
                viewModel.insertMention(for: member)
            } label: {
                memberRowContent(member)
            }
            .buttonStyle(.plain)
            .disabled(!viewModel.canInsertMention(for: member))
            .contextMenu {
                Button {
                    viewModel.insertMention(for: member)
                } label: {
                    Label("Mention @\(member.displayName)", systemImage: "at")
                }
                .disabled(!viewModel.canInsertMention(for: member))

                Button {
                    viewModel.insertMention(for: member, preferDisplayName: false)
                } label: {
                    Label("Mention @\(member.handle)", systemImage: "number")
                }
                .disabled(!viewModel.canInsertMention(for: member))
            }
            .help(viewModel.mentionUnavailableReason(for: member) ?? "Mention @\(member.handle)")
        } else {
            memberRowContent(member)
        }
    }

    private func memberRowContent(_ member: Member) -> some View {
        HStack(spacing: 8) {
            Circle()
                .fill(member.presence.dotColor)
                .frame(width: 8, height: 8)
            Text(member.displayName).lineLimit(1)
            if member.isAgent {
                Image(systemName: "at")
                    .font(.caption)
                    .foregroundStyle(MomoTheme.agentAccent)
                Text("AGENT")
                    .font(.system(size: 8, weight: .bold))
                    .padding(.horizontal, 4).padding(.vertical, 1)
                    .background(MomoTheme.agentAccent.opacity(0.18), in: Capsule())
                    .foregroundStyle(MomoTheme.agentAccent)
            }
            Spacer()
            if viewModel.selectedChannelId != nil {
                memberMutationButton(member)
            }
        }
    }

    private var channelCreateForm: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker("Kind", selection: $newChannelKind) {
                Label("Public", systemImage: "number").tag(ChannelKind.publicChannel)
                Label("Private", systemImage: "lock").tag(ChannelKind.privateChannel)
            }
            .pickerStyle(.segmented)

            TextField("name", text: $newChannelName)
                .textFieldStyle(.roundedBorder)
            TextField("topic", text: $newChannelTopic)
                .textFieldStyle(.roundedBorder)

            HStack {
                Spacer()
                Button {
                    Task {
                        await viewModel.createChannel(
                            kind: newChannelKind,
                            name: newChannelName,
                            topic: newChannelTopic
                        )
                        if viewModel.connectionError == nil {
                            newChannelName = ""
                            newChannelTopic = ""
                            newChannelKind = .publicChannel
                            isCreatingChannel = false
                        }
                    }
                } label: {
                    Label("Create", systemImage: "checkmark.circle")
                }
                .disabled(viewModel.channelCreateInFlight || newChannelName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(.vertical, 4)
    }

    private func memberMutationButton(_ member: Member) -> some View {
        let inChannel = viewModel.isMember(member.id)
        let isWorking = viewModel.channelMemberMutationIds.contains(member.id)
        return Button {
            Task {
                if inChannel {
                    await viewModel.removeMember(member.id)
                } else {
                    await viewModel.addMember(member.id)
                }
            }
        } label: {
            Image(systemName: inChannel ? "minus.circle" : "plus.circle")
        }
        .buttonStyle(.plain)
        .disabled(isWorking)
        .help(inChannel ? "Remove" : "Add")
    }

    private func channelIcon(_ kind: ChannelKind) -> String {
        switch kind {
        case .publicChannel:
            return "number"
        case .privateChannel:
            return "lock"
        case .dm:
            return "person.2.fill"
        }
    }

    private func channelTitle(_ channel: Channel) -> String {
        switch channel.kind {
        case .dm:
            return "DM"
        case .publicChannel, .privateChannel:
            return channel.name ?? "channel"
        }
    }
}

private struct KimInternAvailabilityView: View {
    let status: AgentRuntimeStatus
    let refresh: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: iconName)
                .foregroundStyle(tint)
                .frame(width: 16, height: 16)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(status.displayName)
                        .font(.caption.weight(.semibold))
                        .lineLimit(1)
                    Text(status.availability.label)
                        .font(.system(size: 9, weight: .bold))
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(tint.opacity(0.16), in: Capsule())
                        .foregroundStyle(tint)
                }
                Text(status.mode.rawValue)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            Button(action: refresh) {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.plain)
            .help("Refresh Kim Intern status")
        }
        .help(helpText)
    }

    private var iconName: String {
        switch status.availability {
        case .available:
            return "checkmark.circle.fill"
        case .degraded:
            return "exclamationmark.triangle.fill"
        case .mock:
            return "testtube.2"
        case .unknown:
            return "questionmark.circle"
        }
    }

    private var tint: Color {
        switch status.availability {
        case .available:
            return MomoTheme.reversibleGreen
        case .degraded:
            return MomoTheme.irreversibleRed
        case .mock:
            return MomoTheme.costAmber
        case .unknown:
            return .secondary
        }
    }

    private var helpText: String {
        var parts = [
            "\(status.displayName): \(status.availability.label)",
            "mode=\(status.mode.rawValue)",
            "endpoint=\(status.endpointLabel)",
        ]
        if !status.diagnostics.isEmpty {
            parts.append(status.diagnostics.joined(separator: "; "))
        }
        return parts.joined(separator: " | ")
    }
}

private extension AgentAvailability {
    var label: String {
        switch self {
        case .available:
            return "Available"
        case .degraded:
            return "Degraded"
        case .mock:
            return "Mock"
        case .unknown:
            return "Unknown"
        }
    }
}
