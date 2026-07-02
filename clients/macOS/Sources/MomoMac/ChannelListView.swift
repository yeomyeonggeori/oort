import SwiftUI
import MomoCore

// MARK: - ChannelListView
//
// Sidebar listing channels and the selected channel's first-class members.
// Agents live beside humans here; runtime diagnostics stay hidden in dev tools.

public struct ChannelListView: View {
    @ObservedObject var viewModel: ChatViewModel
    @State private var isCreatingChannel = false
    @State private var showDiagnostics = false
    @State private var showSessionDetails = false
    @State private var showInvites = false
    @State private var showUpdates = false
    @State private var showProfileMenu = false
    @State private var showMemberInvite = false
    @State private var showServerSettings = false
    @State private var newChannelName = ""
    @State private var newChannelTopic = ""
    @State private var newChannelKind: ChannelKind = .publicChannel
    @State private var inviteMode: MomoInviteMode = .human
    @State private var agentAlias = "@hermes"
    @State private var agentEndpoint = "http://127.0.0.1:28088/v1"
    @AppStorage(MomoUILanguage.appStorageKey) private var languageRaw = MomoUILanguage.preferredDefault.rawValue
    @AppStorage("momo.server.displayName") private var serverDisplayName = "momo"
    @AppStorage("momo.server.iconText") private var serverIconText = "m"
    @AppStorage("momo.server.agentInviteRequiresApproval") private var agentInviteRequiresApproval = true
    @AppStorage("momo.server.memberInvitePolicy") private var memberInvitePolicy = "admins"
    private let sessionChrome: MomoSessionChrome?
    private let openCommandCenter: (() -> Void)?
    private let openApprovals: (() -> Void)?

    public init(viewModel: ChatViewModel) {
        self.viewModel = viewModel
        self.sessionChrome = nil
        self.openCommandCenter = nil
        self.openApprovals = nil
    }

    init(
        viewModel: ChatViewModel,
        sessionChrome: MomoSessionChrome?,
        openCommandCenter: (() -> Void)? = nil,
        openApprovals: (() -> Void)? = nil
    ) {
        self.viewModel = viewModel
        self.sessionChrome = sessionChrome
        self.openCommandCenter = openCommandCenter
        self.openApprovals = openApprovals
    }

    public var body: some View {
        let copy = MomoWorkspaceCopy(language: language)

        VStack(spacing: 0) {
            sidebarHeader(copy: copy)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if let error = viewModel.connectionError {
                        connectionErrorRow(error, copy: copy)
                    }

                    workQueueSection(copy: copy)
                    channelsSection(copy: copy)
                    membersSection(copy: copy)
                    developerToolsSection(copy: copy)
                }
                .padding(.horizontal, 14)
                .padding(.top, 4)
                .padding(.bottom, 14)
            }
            .scrollIndicators(.hidden)

            Divider()
                .opacity(0.35)
            profileFooter(copy: copy)
        }
        .background(MomoSidebarGlassBackground())
    }

    private var language: MomoUILanguage {
        MomoUILanguage(rawValue: languageRaw) ?? .preferredDefault
    }

    private var visibleChannelMembers: [Member] {
        viewModel.members.filter { viewModel.isMember($0.id) }
    }

    private func sidebarHeader(copy: MomoWorkspaceCopy) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 11) {
                MomoSidebarLogoMark(text: serverIconText)
                VStack(alignment: .leading, spacing: 2) {
                    Text(serverDisplayName)
                        .font(.system(size: 16, weight: .semibold))
                    Text(sessionChrome?.summary.mode.title ?? copy.workspace)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
            }

            if let selected = viewModel.selectedChannel {
                VStack(alignment: .leading, spacing: 5) {
                    Text(channelTitle(selected))
                        .font(.system(size: 18, weight: .semibold))
                        .lineLimit(1)
                    if let topic = selected.topic, !topic.isEmpty {
                        Text(topic)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    } else {
                        Text(copy.readyToChat)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            } else {
                Text(copy.selectChannel)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.top, 22)
        .padding(.horizontal, 18)
        .padding(.bottom, 14)
    }

    private func sidebarSectionHeader(
        title: String,
        actionTitle: String,
        systemImage: String,
        action: @escaping () -> Void
    ) -> some View {
        HStack {
            Text(title)
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            Spacer()
            Button(action: action) {
                Image(systemName: systemImage)
                    .font(.system(size: 14, weight: .bold))
                    .frame(width: 26, height: 26)
                    .background(.primary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            .buttonStyle(.plain)
            .help(actionTitle)
        }
    }

    private func sidebarPlainHeader(_ title: String) -> some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
    }

    private func connectionErrorRow(_ error: String, copy: MomoWorkspaceCopy) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(copy.recoverableError, systemImage: "exclamationmark.triangle.fill")
                .font(.callout.weight(.semibold))
                .foregroundStyle(.orange)
            Text(error)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(3)
            HStack(spacing: 8) {
                Button {
                    Task { await viewModel.retrySelectedChannelLoad() }
                } label: {
                    Label(copy.retry, systemImage: "arrow.clockwise")
                }
                .controlSize(.small)
                Button {
                    viewModel.clearConnectionError()
                } label: {
                    Label(copy.dismiss, systemImage: "xmark.circle")
                }
                .controlSize(.small)
            }
        }
        .padding(.vertical, 6)
    }

    private func workQueueSection(copy: MomoWorkspaceCopy) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            sidebarPlainHeader(copy.workQueue)
            sidebarActionRow(
                title: copy.approvalRequests,
                subtitle: approvalSummary(copy: copy),
                systemImage: "checkmark.seal",
                tint: MomoTheme.costAmber,
                badge: viewModel.pendingApprovals.isEmpty ? nil : "\(viewModel.pendingApprovals.count)"
            ) {
                openApprovals?()
            }
        }
    }

    private func channelsSection(copy: MomoWorkspaceCopy) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            sidebarSectionHeader(
                title: copy.channels,
                actionTitle: isCreatingChannel ? copy.cancel : copy.newChannel,
                systemImage: isCreatingChannel ? "xmark" : "plus"
            ) {
                isCreatingChannel.toggle()
            }

            if isCreatingChannel {
                channelCreateForm(copy: copy)
            }

            if viewModel.channels.isEmpty {
                sidebarEmptyRow(copy.noChannels, systemImage: "tray")
            } else {
                ForEach(viewModel.channels) { channel in
                    channelRow(channel)
                }
            }
        }
    }

    private func membersSection(copy: MomoWorkspaceCopy) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            sidebarSectionHeader(
                title: copy.members,
                actionTitle: copy.inviteMembers,
                systemImage: "plus"
            ) {
                withAnimation(.easeInOut(duration: 0.16)) {
                    inviteMode = .human
                    showMemberInvite = true
                }
            }

            if visibleChannelMembers.isEmpty {
                sidebarEmptyRow(copy.noMembersInChannel, systemImage: "person.2")
            } else {
                ForEach(visibleChannelMembers) { member in
                    memberRow(member)
                }
            }
        }
    }

    private func developerToolsSection(copy: MomoWorkspaceCopy) -> some View {
        DisclosureGroup(isExpanded: $showDiagnostics) {
            VStack(alignment: .leading, spacing: 10) {
                OnboardingInviteView(viewModel: viewModel)
                    .padding(10)
                    .background(.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                KimInternAvailabilityView(status: viewModel.agentRuntimeStatus) {
                    Task { await viewModel.refreshAgentRuntimeStatus() }
                }
                .padding(10)
                .background(.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                FoundationModelsCapabilityView(state: viewModel.foundationModelsCapability)
                    .padding(10)
                    .background(.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                LocalContextCopilotView(viewModel: viewModel)
                    .padding(10)
                    .background(.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .padding(.top, 8)
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "wrench.and.screwdriver")
                    .font(.system(size: 15, weight: .semibold))
                    .frame(width: 22, height: 22)
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(copy.developerTools)
                        .font(.system(size: 14, weight: .semibold))
                    Text(copy.developerToolsSubtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .padding(.vertical, 6)
        }
    }

    @ViewBuilder
    private func channelRow(_ channel: Channel) -> some View {
        Button {
            Task { await viewModel.selectChannel(channel.id) }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: channelIcon(channel.kind))
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(isSelected(channel) ? MomoTheme.humanAccent : .secondary)
                    .frame(width: 24)
                Text(channel.name ?? "DM")
                    .font(.system(size: 15, weight: isSelected(channel) ? .semibold : .medium))
                    .lineLimit(1)
                Spacer(minLength: 8)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
            .background(
                isSelected(channel) ? Color.primary.opacity(0.13) : Color.clear,
                in: RoundedRectangle(cornerRadius: 10, style: .continuous)
            )
        }
        .buttonStyle(.plain)
    }

    private func sidebarActionRow(
        title: String,
        subtitle: String,
        systemImage: String,
        tint: Color,
        badge: String? = nil,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack {
                Image(systemName: systemImage)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(tint)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.system(size: 15, weight: .semibold))
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                if let badge {
                    Text(badge)
                        .font(.system(size: 11, weight: .bold))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .foregroundStyle(.white)
                        .background(MomoTheme.irreversibleRed, in: Capsule())
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(.primary.opacity(0.055), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
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
        HStack(spacing: 10) {
            Circle()
                .fill(member.presence.dotColor)
                .frame(width: 10, height: 10)
            Text(member.displayName)
                .font(.system(size: 15, weight: .semibold))
                .lineLimit(1)
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
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(.primary.opacity(member.isAgent ? 0.055 : 0.0), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func channelCreateForm(copy: MomoWorkspaceCopy) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker("Kind", selection: $newChannelKind) {
                Label(copy.publicChannel, systemImage: "number").tag(ChannelKind.publicChannel)
                Label(copy.privateChannel, systemImage: "lock").tag(ChannelKind.privateChannel)
            }
            .pickerStyle(.segmented)

            TextField(copy.channelNamePlaceholder, text: $newChannelName)
                .textFieldStyle(.roundedBorder)
            TextField(copy.channelTopicPlaceholder, text: $newChannelTopic)
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
                    Label(copy.create, systemImage: "checkmark.circle")
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
            Image(systemName: inChannel ? "minus" : "plus")
                .font(.system(size: 12, weight: .bold))
                .frame(width: 24, height: 24)
                .foregroundStyle(inChannel ? .secondary : MomoTheme.humanAccent)
                .background(.primary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(isWorking)
        .help(inChannel ? "Remove" : "Add")
    }

    private func profileFooter(copy: MomoWorkspaceCopy) -> some View {
        Button {
            withAnimation(.easeInOut(duration: 0.16)) {
                showProfileMenu.toggle()
            }
        } label: {
            HStack(spacing: 10) {
                Text(profileInitials)
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 34, height: 34)
                    .background(MomoTheme.agentAccent, in: Circle())

                VStack(alignment: .leading, spacing: 2) {
                    Text(profileDisplayName)
                        .font(.system(size: 14, weight: .semibold))
                        .lineLimit(1)
                    Text(profileDetail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer()

                Image(systemName: "chevron.up")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
            .padding(.horizontal, 12)
            .padding(.vertical, 11)
            .background(.primary.opacity(0.075), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
        }
        .buttonStyle(.plain)
        .popover(isPresented: $showProfileMenu, arrowEdge: .bottom) {
            profilePopover(copy: copy)
                .frame(width: 292)
                .padding(10)
        }
        .popover(isPresented: $showMemberInvite, arrowEdge: .bottom) {
            memberInvitePopover(copy: copy)
                .frame(width: 340)
                .padding(10)
        }
        .popover(isPresented: $showSessionDetails) {
            if let chrome = sessionChrome {
                SessionDetailPopover(
                    summary: chrome.summary,
                    realtimeStatus: viewModel.selectedRealtimeStatus,
                    agentStatus: viewModel.agentRuntimeStatus
                )
            }
        }
        .popover(isPresented: $showInvites) {
            if let context = sessionChrome?.inviteAdminContext {
                InviteAdminPopover(context: context)
            }
        }
        .popover(isPresented: $showUpdates) {
            MomoMacUpdateChannelView()
        }
        .sheet(isPresented: $showServerSettings) {
            serverSettingsSheet(copy: copy)
        }
        .animation(.easeInOut(duration: 0.16), value: showProfileMenu)
        .animation(.easeInOut(duration: 0.16), value: showMemberInvite)
    }

    private func memberInvitePopover(copy: MomoWorkspaceCopy) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Image(systemName: "plus.circle")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(MomoTheme.humanAccent)
                VStack(alignment: .leading, spacing: 2) {
                    Text(copy.inviteMembers)
                        .font(.system(size: 16, weight: .semibold))
                    Text(copy.inviteMembersSubtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }

            Picker(copy.inviteType, selection: $inviteMode) {
                ForEach(MomoInviteMode.allCases) { mode in
                    Text(mode.title(copy: copy)).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            switch inviteMode {
            case .human:
                VStack(alignment: .leading, spacing: 10) {
                    Label(copy.humanInviteTitle, systemImage: "person.crop.circle.badge.plus")
                        .font(.system(size: 14, weight: .semibold))
                    Text(copy.humanInviteBody)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Button {
                        showMemberInvite = false
                        if sessionChrome?.inviteAdminContext != nil {
                            showInvites = true
                        } else {
                            openCommandCenter?()
                        }
                    } label: {
                        Label(copy.openInviteCodes, systemImage: "key.horizontal")
                    }
                    .controlSize(.regular)
                }
                .padding(12)
                .background(.primary.opacity(0.055), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            case .agent:
                VStack(alignment: .leading, spacing: 10) {
                    Label(copy.agentInviteTitle, systemImage: "point.3.connected.trianglepath.dotted")
                        .font(.system(size: 14, weight: .semibold))
                    Text(copy.agentInviteBody)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    TextField(copy.agentAlias, text: $agentAlias)
                        .textFieldStyle(.roundedBorder)
                    TextField(copy.providerEndpoint, text: $agentEndpoint)
                        .textFieldStyle(.roundedBorder)
                    Label(copy.agentInviteNetworkNote, systemImage: "network")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Button {
                        showMemberInvite = false
                        openCommandCenter?()
                    } label: {
                        Label(copy.prepareAgentInvite, systemImage: "terminal")
                    }
                    .controlSize(.regular)
                }
                .padding(12)
                .background(MomoTheme.agentAccent.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        }
        .padding(8)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func serverSettingsSheet(copy: MomoWorkspaceCopy) -> some View {
        MomoServerSettingsDraftSheet(
            copy: copy,
            displayName: $serverDisplayName,
            iconText: $serverIconText,
            memberInvitePolicy: $memberInvitePolicy,
            agentInviteRequiresApproval: $agentInviteRequiresApproval
        )
    }

    private func profilePopover(copy: MomoWorkspaceCopy) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Text(profileInitials)
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 42, height: 42)
                    .background(MomoTheme.agentAccent, in: Circle())
                VStack(alignment: .leading, spacing: 3) {
                    Text(profileDisplayName)
                        .font(.system(size: 15, weight: .semibold))
                    Text(profileDetail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 4)

            Divider()

            profileMenuButton(copy.profile, systemImage: "person.crop.circle") {
                showProfileMenu = false
                showSessionDetails = true
            }

            profileMenuButton(copy.serverSettings, systemImage: "server.rack") {
                showProfileMenu = false
                showServerSettings = true
            }

            VStack(alignment: .leading, spacing: 7) {
                Label(copy.languageLabel, systemImage: "globe")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.secondary)
                Picker(copy.languageLabel, selection: $languageRaw) {
                    ForEach(MomoUILanguage.allCases) { option in
                        Text(option.displayName).tag(option.rawValue)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(.primary.opacity(0.055), in: RoundedRectangle(cornerRadius: 10, style: .continuous))

            profileMenuButton(copy.updates, systemImage: "arrow.down.circle") {
                showProfileMenu = false
                showUpdates = true
            }

            profileMenuButton(copy.inviteMembers, systemImage: "person.badge.plus") {
                showProfileMenu = false
                inviteMode = .human
                showMemberInvite = true
            }

            Divider()

            if let chrome = sessionChrome {
                profileMenuButton(copy.switchSession, systemImage: "arrow.left.arrow.right", action: chrome.switchSession)
                profileMenuButton(copy.logout, systemImage: "rectangle.portrait.and.arrow.right", role: .destructive, action: chrome.logout)
            }
        }
        .padding(6)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func profileMenuButton(
        _ title: String,
        systemImage: String,
        role: ButtonRole? = nil,
        action: @escaping () -> Void
    ) -> some View {
        Button(role: role, action: action) {
            HStack(spacing: 10) {
                Image(systemName: systemImage)
                    .font(.system(size: 14, weight: .semibold))
                    .frame(width: 22)
                Text(title)
                    .font(.system(size: 14, weight: .medium))
                Spacer()
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var profileDisplayName: String {
        if let name = sessionChrome?.summary.memberDisplayName, !name.isEmpty {
            return name
        }
        if let human = viewModel.members.first(where: { !$0.isAgent }) {
            return human.displayName
        }
        return "momo"
    }

    private var profileDetail: String {
        if let email = sessionChrome?.summary.email, !email.isEmpty {
            return email
        }
        if let server = sessionChrome?.summary.serverURLString, !server.isEmpty {
            return server
        }
        return sessionChrome?.summary.mode.title ?? "Local demo"
    }

    private var profileInitials: String {
        let source = profileDisplayName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = source.first else { return "M" }
        return String(first).uppercased()
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

    private func isSelected(_ channel: Channel) -> Bool {
        viewModel.selectedChannelId == channel.id
    }

    private func approvalSummary(copy: MomoWorkspaceCopy) -> String {
        let count = viewModel.pendingApprovals.count
        return count == 0 ? copy.noPendingApprovals : "\(count) \(copy.pendingApprovals)"
    }

    private func sidebarEmptyRow(_ title: String, systemImage: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: systemImage)
                .frame(width: 24)
                .foregroundStyle(.secondary)
            Text(title)
                .font(.callout)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
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

private enum MomoInviteMode: String, CaseIterable, Identifiable {
    case human
    case agent

    var id: String { rawValue }

    func title(copy: MomoWorkspaceCopy) -> String {
        switch self {
        case .human:
            return copy.human
        case .agent:
            return copy.agent
        }
    }
}

private struct MomoServerSettingsDraftSheet: View {
    let copy: MomoWorkspaceCopy
    @Binding var displayName: String
    @Binding var iconText: String
    @Binding var memberInvitePolicy: String
    @Binding var agentInviteRequiresApproval: Bool
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 12) {
                MomoSidebarLogoMark(text: iconText)
                VStack(alignment: .leading, spacing: 3) {
                    Text(copy.serverSettings)
                        .font(.system(size: 19, weight: .semibold))
                    Text(copy.serverSettingsSubtitle)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 12, weight: .bold))
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .help(copy.dismiss)
            }

            VStack(alignment: .leading, spacing: 12) {
                TextField(copy.serverName, text: $displayName)
                    .textFieldStyle(.roundedBorder)
                TextField(copy.serverIconText, text: $iconText)
                    .textFieldStyle(.roundedBorder)
                Picker(copy.memberInvitePolicy, selection: $memberInvitePolicy) {
                    Text(copy.invitePolicyAdmins).tag("admins")
                    Text(copy.invitePolicyMembers).tag("members")
                    Text(copy.invitePolicyLocked).tag("locked")
                }
                .pickerStyle(.menu)
                Toggle(copy.agentInviteRequiresApproval, isOn: $agentInviteRequiresApproval)
            }
            .padding(14)
            .background(.primary.opacity(0.055), in: RoundedRectangle(cornerRadius: 14, style: .continuous))

            Label(copy.serverSettingsLocalDraftNote, systemImage: "info.circle")
                .font(.caption)
                .foregroundStyle(.secondary)

            HStack {
                Spacer()
                Button(copy.done) {
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(22)
        .frame(width: 460)
        .background(.regularMaterial)
    }
}

private struct MomoSidebarLogoMark: View {
    var text: String = "m"

    private var visibleText: String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = trimmed.first else { return "m" }
        return String(first).lowercased()
    }

    var body: some View {
        Text(visibleText)
            .font(.system(size: 15, weight: .heavy, design: .rounded))
            .foregroundStyle(.white)
            .frame(width: 30, height: 30)
            .background(
                LinearGradient(
                    colors: [MomoTheme.agentAccent, MomoTheme.costAmber],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                ),
                in: RoundedRectangle(cornerRadius: 9, style: .continuous)
            )
    }
}

private struct MomoSidebarGlassBackground: View {
    var body: some View {
        ZStack {
            Rectangle()
                .fill(.ultraThinMaterial)
            LinearGradient(
                colors: [
                    MomoTheme.humanAccent.opacity(0.10),
                    MomoTheme.reversibleGreen.opacity(0.08),
                    Color.clear,
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            Rectangle()
                .fill(Color.black.opacity(0.08))
        }
        .ignoresSafeArea()
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
                Text(status.internalAlphaProviderSummary)
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
        status.internalAlphaHelpText
    }
}

extension AgentRuntimeStatus {
    var internalAlphaProviderSummary: String {
        var parts = [
            mode.internalAlphaLabel,
            keyConfigured ? "key ready" : "key missing",
        ]
        if availability == .degraded {
            if let degradedReason, !degradedReason.isEmpty {
                parts.append(degradedReason)
            } else if let diagnostic = diagnostics.first, !diagnostic.isEmpty {
                parts.append(diagnostic)
            }
        } else if !endpointLabel.isEmpty {
            parts.append(endpointLabel)
        }
        return parts.joined(separator: " · ")
    }

    var internalAlphaHelpText: String {
        var parts = [
            "\(displayName): \(availability.label)",
            "mode=\(mode.internalAlphaLabel)",
            "endpoint=\(endpointLabel)",
            keyConfigured ? "key configured" : "key not configured",
        ]
        if let degradedReason, !degradedReason.isEmpty {
            parts.append("degraded=\(degradedReason)")
        }
        if !diagnostics.isEmpty {
            parts.append(diagnostics.joined(separator: "; "))
        }
        return parts.joined(separator: " | ")
    }
}

extension AgentProviderMode {
    var internalAlphaLabel: String {
        switch self {
        case .localMock:
            return "Local mock"
        case .internalHostMock:
            return "Internal host mock"
        case .externalHermes:
            return "External Hermes"
        }
    }
}

extension AgentAvailability {
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
