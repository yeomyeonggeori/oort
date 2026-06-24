import SwiftUI
import MomoCore

// MARK: - ChannelListView
//
// Sidebar listing the workspace's channels + an agent roster with live presence.
// Selecting a channel drives the message list (L4 §9.3 macOS-first surface).

public struct ChannelListView: View {
    @ObservedObject var viewModel: ChatViewModel

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
            Section("Channels") {
                ForEach(viewModel.channels) { channel in
                    channelRow(channel).tag(channel.id)
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

            Section("Members") {
                ForEach(viewModel.members) { member in
                    memberRow(member)
                }
            }
        }
        .listStyle(.sidebar)
    }

    @ViewBuilder
    private func channelRow(_ channel: Channel) -> some View {
        HStack(spacing: 6) {
            Image(systemName: channel.kind == .dm ? "person.2.fill" : "number")
                .foregroundStyle(.secondary)
            Text(channel.name ?? "DM")
                .lineLimit(1)
        }
    }

    @ViewBuilder
    private func memberRow(_ member: Member) -> some View {
        HStack(spacing: 8) {
            Circle()
                .fill(member.presence.dotColor)
                .frame(width: 8, height: 8)
            Text(member.displayName).lineLimit(1)
            if member.isAgent {
                Text("AGENT")
                    .font(.system(size: 8, weight: .bold))
                    .padding(.horizontal, 4).padding(.vertical, 1)
                    .background(MomoTheme.agentAccent.opacity(0.18), in: Capsule())
                    .foregroundStyle(MomoTheme.agentAccent)
            }
            Spacer()
        }
    }
}
