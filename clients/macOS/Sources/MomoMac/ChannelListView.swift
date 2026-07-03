import SwiftUI
import AppKit
import UniformTypeIdentifiers
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
    @State private var showDownloads = false
    @State private var showProfilePanel = false
    @State private var showMemberInvite = false
    @State private var showServerSettings = false
    @State private var newChannelName = ""
    @State private var newChannelTopic = ""
    @State private var newChannelKind: ChannelKind = .publicChannel
    @State private var inviteMode: MomoInviteMode = .human
    @State private var agentAlias = "@hermes"
    @State private var agentEndpoint = "http://127.0.0.1:28088/v1"
    @AppStorage(MomoUILanguage.appStorageKey) private var languageRaw = MomoUILanguage.preferredDefault.rawValue
    @AppStorage(MomoAppearancePreference.appStorageKey) private var appearanceRaw = MomoAppearancePreference.system.rawValue
    @AppStorage("momo.server.displayName") private var serverDisplayName = "momo"
    @AppStorage("momo.server.iconText") private var serverIconText = "m"
    @AppStorage("momo.server.iconPath") private var serverIconPath = ""
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

        ZStack(alignment: .bottom) {
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

            if showProfilePanel {
                Color.black.opacity(0.001)
                    .ignoresSafeArea()
                    .onTapGesture {
                        withAnimation(sidebarPanelAnimation) {
                            showProfilePanel = false
                        }
                    }
                    .zIndex(1)

                profilePanel(copy: copy)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 10)
                    .padding(.bottom, 76)
                    .transition(.asymmetric(
                        insertion: .move(edge: .bottom).combined(with: .opacity),
                        removal: .opacity
                    ))
                    .zIndex(2)
            }
        }
        .background(MomoSidebarGlassBackground())
        .animation(sidebarPanelAnimation, value: showProfilePanel)
    }

    private var language: MomoUILanguage {
        MomoUILanguage(rawValue: languageRaw) ?? .preferredDefault
    }

    private var visibleChannelMembers: [Member] {
        viewModel.members.filter { member in
            viewModel.isMember(member.id) && !isHiddenDogfoodAgent(member)
        }
    }

    private func sidebarHeader(copy: MomoWorkspaceCopy) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 11) {
                MomoSidebarLogoMark(text: serverIconText, imagePath: serverIconPath)
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
        .padding(.bottom, 16)
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
                    .font(.system(size: 16, weight: .bold))
                    .frame(width: 30, height: 30)
                    .background(.primary.opacity(0.10), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
            .buttonStyle(.plain)
            .help(actionTitle)
            .momoQuickTooltip(actionTitle)
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
                title: copy.agentApprovalInbox,
                subtitle: approvalSummary(copy: copy),
                systemImage: "checkmark.seal",
                tint: MomoTheme.costAmber,
                badge: viewModel.pendingApprovals.isEmpty ? nil : "\(viewModel.pendingApprovals.count)",
                isQuiet: viewModel.pendingApprovals.isEmpty
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
        isQuiet: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack {
                Image(systemName: systemImage)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(isQuiet ? .secondary : tint)
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
            .background(.primary.opacity(isQuiet ? 0.030 : 0.065), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
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
                .font(.system(size: 13, weight: .bold))
                .frame(width: 28, height: 28)
                .foregroundStyle(inChannel ? .secondary : MomoTheme.humanAccent)
                .background(.primary.opacity(0.10), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(isWorking)
        .help(inChannel ? "Remove" : "Add")
        .momoQuickTooltip(inChannel ? "Remove" : "Add")
    }

    private func profileFooter(copy: MomoWorkspaceCopy) -> some View {
        Button {
            withAnimation(sidebarPanelAnimation) {
                showProfilePanel.toggle()
            }
        } label: {
            HStack(spacing: 10) {
                MomoProfileAvatar(initials: profileInitials, status: .online)

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
                    .rotationEffect(.degrees(showProfilePanel ? 180 : 0))
            }
            .contentShape(Rectangle())
            .padding(.horizontal, 12)
            .padding(.vertical, 11)
            .background(.primary.opacity(0.075), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
        }
        .buttonStyle(.plain)
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
        .sheet(isPresented: $showDownloads) {
            MomoDownloadsSheet(copy: copy)
        }
        .sheet(isPresented: $showServerSettings) {
            serverSettingsSheet(copy: copy)
        }
        .animation(.timingCurve(0.22, 0.0, 0.0, 1.0, duration: 0.18), value: showMemberInvite)
    }

    private func profilePanel(copy: MomoWorkspaceCopy) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                MomoProfileAvatar(initials: profileInitials, status: .online, size: 42)
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

            Divider()

            profileAction(copy.profile, systemImage: "person.crop.circle") {
                showProfilePanel = false
                showSessionDetails = true
            }
            profileAction(copy.serverSettings, systemImage: "server.rack") {
                showProfilePanel = false
                showServerSettings = true
            }
            profileAction(copy.commandCenter, systemImage: "list.bullet.clipboard") {
                showProfilePanel = false
                openCommandCenter?()
            }
            profileAction(copy.agentApprovalInbox, systemImage: "checkmark.seal") {
                showProfilePanel = false
                openApprovals?()
            }

            Divider()

            VStack(alignment: .leading, spacing: 8) {
                Label(copy.languageLabel, systemImage: "globe")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                HStack(spacing: 6) {
                    ForEach(MomoUILanguage.allCases) { option in
                        profilePill(
                            option.displayName,
                            selected: language == option,
                            systemImage: language == option ? "checkmark" : nil
                        ) {
                            languageRaw = option.rawValue
                        }
                    }
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                Label(copy.appearanceLabel, systemImage: currentAppearance.systemImage)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                HStack(spacing: 6) {
                    ForEach(MomoAppearancePreference.allCases) { option in
                        profilePill(
                            option.title(copy: copy),
                            selected: currentAppearance == option,
                            systemImage: currentAppearance == option ? "checkmark" : option.systemImage
                        ) {
                            appearanceRaw = option.rawValue
                        }
                    }
                }
            }

            Divider()

            profileAction(copy.downloads, systemImage: "tray.and.arrow.down") {
                showProfilePanel = false
                showDownloads = true
            }
            profileAction(copy.updates, systemImage: "arrow.down.circle") {
                showProfilePanel = false
                showUpdates = true
            }
            profileAction(copy.inviteMembers, systemImage: "person.badge.plus") {
                showProfilePanel = false
                inviteMode = .human
                showMemberInvite = true
            }

            Divider()

            if let chrome = sessionChrome {
                profileAction(copy.switchSession, systemImage: "arrow.left.arrow.right", action: chrome.switchSession)
                profileAction(copy.logout, systemImage: "rectangle.portrait.and.arrow.right", role: .destructive, action: chrome.logout)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(.white.opacity(0.12), lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.26), radius: 22, x: 0, y: 12)
    }

    private func profileAction(
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

    private func profilePill(
        _ title: String,
        selected: Bool,
        systemImage: String?,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: 10, weight: .bold))
                }
                Text(title)
                    .font(.system(size: 11, weight: .semibold))
                    .lineLimit(1)
            }
            .padding(.horizontal, 7)
            .frame(height: 26)
            .background(selected ? MomoTheme.humanAccent : Color.primary.opacity(0.08), in: Capsule())
            .foregroundStyle(selected ? .white : .primary)
        }
        .buttonStyle(.plain)
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
            iconPath: $serverIconPath,
            memberInvitePolicy: $memberInvitePolicy,
            agentInviteRequiresApproval: $agentInviteRequiresApproval
        )
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
        return count == 0 ? copy.noPendingAgentApprovals : "\(count) \(copy.pendingApprovals)"
    }

    private var currentAppearance: MomoAppearancePreference {
        MomoAppearancePreference(rawValue: appearanceRaw) ?? .system
    }

    private var sidebarPanelAnimation: Animation {
        .timingCurve(0.22, 0.0, 0.0, 1.0, duration: 0.18)
    }

    private func isHiddenDogfoodAgent(_ member: Member) -> Bool {
        guard member.isAgent else { return false }
        let identity = "\(member.displayName) \(member.handle)".lowercased()
        return identity.contains("김인턴") || identity.contains("kim") || identity.contains("intern")
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

private struct MomoDownloadsSheet: View {
    let copy: MomoWorkspaceCopy
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                Image(systemName: "tray.and.arrow.down")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(MomoTheme.humanAccent)
                    .frame(width: 34, height: 34)
                    .background(.primary.opacity(0.08), in: RoundedRectangle(cornerRadius: 11, style: .continuous))

                VStack(alignment: .leading, spacing: 3) {
                    Text(copy.downloads)
                        .font(.system(size: 19, weight: .semibold))
                    Text(copy.downloadsSubtitle)
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

            MomoMacUpdateChannelView()
                .background(.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 16, style: .continuous))

            HStack {
                Button {
                    openDownloadsFolder()
                } label: {
                    Label(copy.openDownloadsFolder, systemImage: "folder")
                }
                Spacer()
                Button(copy.done) {
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(22)
        .frame(width: 560)
        .background(.regularMaterial)
    }

    private func openDownloadsFolder() {
        let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser
        NSWorkspace.shared.open(folder)
    }
}

private struct MomoServerSettingsDraftSheet: View {
    let copy: MomoWorkspaceCopy
    @Binding var displayName: String
    @Binding var iconText: String
    @Binding var iconPath: String
    @Binding var memberInvitePolicy: String
    @Binding var agentInviteRequiresApproval: Bool
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 12) {
                MomoSidebarLogoMark(text: iconText, imagePath: iconPath, size: 40)
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
                VStack(alignment: .leading, spacing: 5) {
                    Text(copy.serverName)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    TextField(copy.serverName, text: $displayName)
                        .textFieldStyle(.roundedBorder)
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text(copy.serverIconImage)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    HStack(spacing: 10) {
                        MomoSidebarLogoMark(text: iconText, imagePath: iconPath, size: 44)
                        VStack(alignment: .leading, spacing: 6) {
                            TextField(copy.serverIconText, text: $iconText)
                                .textFieldStyle(.roundedBorder)
                            HStack(spacing: 8) {
                                Button {
                                    chooseServerIcon()
                                } label: {
                                    Label(copy.chooseImage, systemImage: "photo")
                                }
                                .controlSize(.small)

                                Button {
                                    iconPath = ""
                                } label: {
                                    Label(copy.removeImage, systemImage: "arrow.uturn.backward")
                                }
                                .controlSize(.small)
                                .disabled(iconPath.isEmpty)
                            }
                        }
                    }
                }

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

    private func chooseServerIcon() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.title = copy.chooseImage

        guard panel.runModal() == .OK, let source = panel.url else {
            return
        }

        do {
            let directory = try appSupportAvatarDirectory()
            let ext = source.pathExtension.isEmpty ? "png" : source.pathExtension
            let destination = directory.appendingPathComponent("server-icon.\(ext)")
            if FileManager.default.fileExists(atPath: destination.path) {
                try FileManager.default.removeItem(at: destination)
            }
            try FileManager.default.copyItem(at: source, to: destination)
            iconPath = destination.path
        } catch {
            NSSound.beep()
        }
    }

    private func appSupportAvatarDirectory() throws -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support", isDirectory: true)
        let directory = base.appendingPathComponent("momo/avatars", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }
}

private struct MomoSidebarLogoMark: View {
    var text: String = "m"
    var imagePath: String = ""
    var size: CGFloat = 30

    private var visibleText: String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = trimmed.first else { return "m" }
        return String(first).lowercased()
    }

    var body: some View {
        ZStack {
            if let image = serverIcon {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: size, height: size)
                    .clipShape(RoundedRectangle(cornerRadius: size * 0.30, style: .continuous))
            } else {
                Text(visibleText)
                    .font(.system(size: size * 0.50, weight: .heavy, design: .rounded))
                    .foregroundStyle(.white)
                    .frame(width: size, height: size)
                    .background(
                        LinearGradient(
                            colors: [MomoTheme.agentAccent, MomoTheme.costAmber],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ),
                        in: RoundedRectangle(cornerRadius: size * 0.30, style: .continuous)
                    )
            }
        }
        .frame(width: size, height: size)
        .overlay {
            RoundedRectangle(cornerRadius: size * 0.30, style: .continuous)
                .stroke(.white.opacity(0.16), lineWidth: 1)
        }
    }

    private var serverIcon: NSImage? {
        guard !imagePath.isEmpty else { return nil }
        return NSImage(contentsOfFile: imagePath)
    }
}

private enum MomoPresenceBadge {
    case online
    case working
    case away
    case error

    var color: Color {
        switch self {
        case .online:
            return MomoTheme.reversibleGreen
        case .working:
            return MomoTheme.costAmber
        case .away:
            return .secondary
        case .error:
            return MomoTheme.irreversibleRed
        }
    }
}

private struct MomoProfileAvatar: View {
    let initials: String
    let status: MomoPresenceBadge
    var size: CGFloat = 34

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Text(initials)
                .font(.system(size: size * 0.36, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: size, height: size)
                .background(MomoTheme.agentAccent, in: Circle())
            Circle()
                .fill(status.color)
                .frame(width: size * 0.24, height: size * 0.24)
                .overlay {
                    Circle()
                        .stroke(.regularMaterial, lineWidth: 2)
                }
                .offset(x: 1, y: 1)
        }
    }
}

private struct MomoSidebarGlassBackground: View {
    var body: some View {
        ZStack {
            Rectangle()
                .fill(.thinMaterial)
            LinearGradient(
                colors: [
                    MomoTheme.humanAccent.opacity(0.12),
                    MomoTheme.reversibleGreen.opacity(0.10),
                    Color.clear,
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            Rectangle()
                .fill(Color.black.opacity(0.025))
            HStack {
                Spacer()
                Rectangle()
                    .fill(.white.opacity(0.08))
                    .frame(width: 1)
            }
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
            .help("Refresh Hermes status")
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
