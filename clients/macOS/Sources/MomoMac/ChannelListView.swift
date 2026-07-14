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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isCreatingChannel = false
    @State private var showDiagnostics = false
    @State private var showInvites = false
    @State private var showProfilePanel = false
    @State private var showMemberInvite = false
    @State private var hoveredChannelID: ChannelID?
    @State private var hoveredMemberID: MemberID?
    @State private var isWorkspaceHeaderHovered = false
    @State private var hoveredUtility: MomoSidebarUtility?
    @State private var newChannelName = ""
    @State private var newChannelTopic = ""
    @State private var newChannelKind: ChannelKind = .publicChannel
    @State private var inviteMode: MomoInviteMode = .human
    @State private var agentInviteInFlight = false
    @State private var agentInviteError: String?
    @State private var agentInviteNotice: String?
    @State private var agentCredentialReveal: MomoAgentCredentialReveal?
    @State private var hermesInvited = false
    @AppStorage(MomoUILanguage.appStorageKey) private var languageRaw = MomoUILanguage.preferredDefault.rawValue
    @AppStorage(MomoAppearancePreference.appStorageKey) private var appearanceRaw = MomoAppearancePreference.system.rawValue
    @AppStorage(MomoDeveloperModePresentation.developerModeKey) private var developerMode = false
    @AppStorage("momo.server.displayName") private var serverDisplayName = "momo"
    @AppStorage("momo.server.iconText") private var serverIconText = "m"
    @AppStorage("momo.server.iconPath") private var serverIconPath = ""
    @AppStorage("momo.server.agentInviteRequiresApproval") private var agentInviteRequiresApproval = true
    @AppStorage("momo.server.memberInvitePolicy") private var memberInvitePolicy = "admins"
    @AppStorage("momo.profile.displayName") private var profileDisplayNameDraft = ""
    @AppStorage("momo.profile.avatarPath") private var profileAvatarPath = ""
    @AppStorage("momo.dogfood.hermes.displayName") private var hermesDisplayName = "Hermes"
    @AppStorage("momo.dogfood.hermes.alias") private var hermesAlias = "@hermes"
    @AppStorage("momo.dogfood.hermes.endpoint") private var storedHermesEndpoint = "http://127.0.0.1:28188/v1"
    @AppStorage("momo.dogfood.hermes.modelLabel") private var hermesModelLabel = "gpt-oauth-provider"
    @AppStorage("momo.dogfood.hermes.permissionScope") private var hermesPermissionScopeRaw = MomoAgentPairingPermissionScope.channelReadReply.rawValue
    @AppStorage("momo.dogfood.hermes.allowNonLoopbackHTTP") private var allowNonLoopbackHTTP = false
    @AppStorage("momo.dogfood.hermes.avatarPath") private var hermesAvatarPath = ""
    @State private var hermesEndpointDraft = ""
    private static let dogfoodHermesAlias = "@hermes"
    private let sessionChrome: MomoSessionChrome?
    private let openCommandCenter: (() -> Void)?
    private let openApprovals: (() -> Void)?
    private let openProfile: (() -> Void)?
    private let openMemberProfile: ((MemberID) -> Void)?
    private let openWorkspaceSettings: (() -> Void)?
    private let openSettings: (() -> Void)?
    private let openDownloads: (() -> Void)?
    private let openUpdates: (() -> Void)?

    public init(viewModel: ChatViewModel) {
        self.viewModel = viewModel
        self.sessionChrome = nil
        self.openCommandCenter = nil
        self.openApprovals = nil
        self.openProfile = nil
        self.openMemberProfile = nil
        self.openWorkspaceSettings = nil
        self.openSettings = nil
        self.openDownloads = nil
        self.openUpdates = nil
    }

    init(
        viewModel: ChatViewModel,
        sessionChrome: MomoSessionChrome?,
        openCommandCenter: (() -> Void)? = nil,
        openApprovals: (() -> Void)? = nil,
        openProfile: (() -> Void)? = nil,
        openMemberProfile: ((MemberID) -> Void)? = nil,
        openWorkspaceSettings: (() -> Void)? = nil,
        openSettings: (() -> Void)? = nil,
        openDownloads: (() -> Void)? = nil,
        openUpdates: (() -> Void)? = nil
    ) {
        self.viewModel = viewModel
        self.sessionChrome = sessionChrome
        self.openCommandCenter = openCommandCenter
        self.openApprovals = openApprovals
        self.openProfile = openProfile
        self.openMemberProfile = openMemberProfile
        self.openWorkspaceSettings = openWorkspaceSettings
        self.openSettings = openSettings
        self.openDownloads = openDownloads
        self.openUpdates = openUpdates
    }

    public var body: some View {
        let copy = MomoWorkspaceCopy(language: language)

        ZStack(alignment: .bottom) {
            VStack(spacing: 0) {
                sidebarHeader(copy: copy)

                Divider()
                    .opacity(0.35)

                ScrollView {
                    LazyVStack(alignment: .leading, spacing: MomoTheme.Sidebar.sectionSpacing) {
                        if viewModel.readStateSyncError != nil {
                            readStateErrorRow(copy: copy)
                        }

                        channelsSection(copy: copy)
                        directMessagesSection(copy: copy)
                        membersSection(copy: copy)
                    }
                    .padding(MomoTheme.Sidebar.edgeInset)
                }
                .scrollIndicators(.hidden)

                Divider()
                    .opacity(0.35)
                utilityFooter(copy: copy)
                Divider()
                    .opacity(0.35)
                profileFooter(copy: copy)
            }

            if showProfilePanel {
                Color.primary.opacity(0.001)
                    .ignoresSafeArea()
                    .onTapGesture {
                        withAnimation(sidebarPanelAnimation) {
                            showProfilePanel = false
                        }
                    }
                    .zIndex(1)

                profilePanel(copy: copy)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, MomoTheme.Sidebar.standardSpacing)
                    .padding(.bottom, 76)
                    .transition(.asymmetric(
                        insertion: .move(edge: .bottom).combined(with: .opacity),
                        removal: .opacity
                    ))
                    .zIndex(2)
            }
        }
        .momoSurface(.panel, cornerRadius: 0, extent: .windowChrome)
        .animation(sidebarPanelAnimation, value: showProfilePanel)
        .onAppear {
            refreshHermesEndpointDraftIfNeeded()
            hermesAlias = Self.dogfoodHermesAlias
            refreshHermesInviteState()
        }
        .onChange(of: hermesInviteScopeKey) { _, _ in
            refreshHermesInviteState()
        }
        .onChange(of: developerMode) { _, isEnabled in
            if !isEnabled {
                showDiagnostics = false
            }
        }
        .sheet(item: $agentCredentialReveal) { reveal in
            MomoAgentCredentialRevealSheet(copy: copy, reveal: reveal)
        }
    }

    private var language: MomoUILanguage {
        MomoUILanguage(rawValue: languageRaw) ?? .preferredDefault
    }

    private var visibleChannelMembers: [Member] {
        viewModel.activeMembers()
    }

    private var standardChannels: [Channel] {
        viewModel.sidebarChannelOrder.standardChannels
    }

    private var directMessageChannels: [Channel] {
        viewModel.sidebarChannelOrder.directMessages
    }

    private func sidebarHeader(copy: MomoWorkspaceCopy) -> some View {
        HStack(spacing: MomoTheme.Sidebar.standardSpacing) {
            MomoSidebarLogoMark(
                text: serverIconText,
                imagePath: serverIconPath,
                size: MomoTheme.Sidebar.logoSize
            )
            VStack(alignment: .leading, spacing: MomoTheme.Sidebar.compactSpacing) {
                Text(serverDisplayName)
                    .font(MomoTheme.Sidebar.workspaceFont)
                    .lineLimit(1)
                Text(sessionChrome?.summary.memberDisplayName ?? profileDisplayName)
                    .font(MomoTheme.Sidebar.workspaceDetailFont)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: MomoTheme.Sidebar.compactSpacing)
            Button {
                openWorkspaceSettings?()
            } label: {
                Image(systemName: "gearshape")
                    .frame(
                        width: MomoTheme.Sidebar.actionSize,
                        height: MomoTheme.Sidebar.actionSize
                    )
            }
            .buttonStyle(.plain)
            .opacity(isWorkspaceHeaderHovered ? 1 : 0)
            .allowsHitTesting(isWorkspaceHeaderHovered)
            .accessibilityHidden(!isWorkspaceHeaderHovered)
            .help(copy.serverSettings)
            .momoQuickTooltip(copy.serverSettings)
        }
        .padding(.horizontal, MomoTheme.Sidebar.contentSpacing)
        .frame(minHeight: MomoTheme.Sidebar.headerMinimumHeight)
        .contentShape(Rectangle())
        .onHover { isWorkspaceHeaderHovered = $0 }
    }

    private func sidebarSectionHeader(
        title: String,
        actionTitle: String,
        systemImage: String,
        action: @escaping () -> Void
    ) -> some View {
        HStack {
            Text(title)
                .font(MomoTheme.Sidebar.sectionHeaderFont)
                .foregroundStyle(.secondary)
            Spacer()
            Button(action: action) {
                Image(systemName: systemImage)
                    .frame(
                        width: MomoTheme.Sidebar.actionSize,
                        height: MomoTheme.Sidebar.actionSize
                    )
            }
            .buttonStyle(.plain)
            .help(actionTitle)
            .momoQuickTooltip(actionTitle)
        }
    }

    private func sidebarPlainHeader(_ title: String) -> some View {
        Text(title)
            .font(MomoTheme.Sidebar.sectionHeaderFont)
            .foregroundStyle(.secondary)
    }

    private func readStateErrorRow(copy: MomoWorkspaceCopy) -> some View {
        VStack(alignment: .leading, spacing: MomoTheme.Sidebar.standardSpacing) {
            Label(copy.unreadSyncUnavailable, systemImage: "exclamationmark.triangle.fill")
                .font(.callout.weight(.semibold))
                .foregroundStyle(MomoTheme.irreversibleRed)
            Text(copy.unreadSyncUnavailableDetail)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: MomoTheme.Sidebar.standardSpacing) {
                Button {
                    Task { await viewModel.retryReadStateSync() }
                } label: {
                    Label(copy.retry, systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .accessibilityLabel(copy.retry)
            }
        }
        .padding(.vertical, MomoTheme.Sidebar.standardSpacing)
    }

    private func channelsSection(copy: MomoWorkspaceCopy) -> some View {
        VStack(alignment: .leading, spacing: MomoTheme.Sidebar.itemSpacing) {
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

            if standardChannels.isEmpty {
                sidebarEmptyRow(copy.noChannels, systemImage: "tray")
            } else {
                ForEach(standardChannels) { channel in
                    channelRow(channel)
                }
            }
        }
    }

    private func directMessagesSection(copy: MomoWorkspaceCopy) -> some View {
        VStack(alignment: .leading, spacing: MomoTheme.Sidebar.itemSpacing) {
            sidebarPlainHeader(copy.directMessages)

            if directMessageChannels.isEmpty {
                sidebarEmptyRow(copy.noDirectMessages, systemImage: "bubble.left.and.bubble.right")
            } else {
                ForEach(directMessageChannels) { channel in
                    channelRow(channel)
                }
            }
        }
    }

    private func membersSection(copy: MomoWorkspaceCopy) -> some View {
        VStack(alignment: .leading, spacing: MomoTheme.Sidebar.itemSpacing) {
            sidebarSectionHeader(
                title: copy.members,
                actionTitle: copy.inviteMembers,
                systemImage: "plus"
            ) {
                withAnimation(sidebarPanelAnimation) {
                    inviteMode = .human
                    showMemberInvite = true
                }
            }

            if visibleChannelMembers.isEmpty {
                sidebarEmptyRow(copy.noMembersInChannel, systemImage: "person.2")
            } else {
                ForEach(visibleChannelMembers) { member in
                    memberRow(displayMember(member))
                }
            }
        }
    }

    private func developerToolsPopover(copy: MomoWorkspaceCopy) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: MomoTheme.Sidebar.sectionSpacing) {
                VStack(alignment: .leading, spacing: MomoTheme.Sidebar.compactSpacing) {
                    Text(copy.developerTools)
                        .font(.headline)
                    Text(copy.developerToolsSubtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Divider()
                OnboardingInviteView(viewModel: viewModel)
                Divider()
                KimInternAvailabilityView(status: viewModel.agentRuntimeStatus) {
                    Task { await viewModel.refreshAgentRuntimeStatus() }
                }
                Divider()
                FoundationModelsCapabilityView(state: viewModel.foundationModelsCapability)
                Divider()
                LocalContextCopilotView(viewModel: viewModel)
            }
            .padding(MomoTheme.Sidebar.sectionSpacing)
        }
        .frame(
            width: MomoTheme.Sidebar.utilityPopoverWidth
        )
        .frame(maxHeight: MomoTheme.Sidebar.utilityPopoverMaximumHeight)
        .momoSurface(.card, cornerRadius: MomoTheme.cornerLarge)
    }

    @ViewBuilder
    // List cannot host the inline create form and stable hover-action columns
    // without changing the existing selection model, so this remains a flat custom row.
    private func channelRow(_ channel: Channel) -> some View {
        let copy = MomoWorkspaceCopy(language: language)
        let readState = viewModel.readStatesByChannel[channel.id]
        let showsUnreadWeight = isSelected(channel) || readState?.hasUnread == true
        let mentionLabel = MomoUnreadBadge.label(mentionCount: readState?.mentionCount ?? 0)
        Button {
            Task { await viewModel.selectChannel(channel.id) }
        } label: {
            HStack(spacing: MomoTheme.Sidebar.standardSpacing) {
                Image(systemName: channelIcon(channel.kind))
                    .foregroundStyle(isSelected(channel) ? .primary : .secondary)
                    .frame(width: MomoTheme.Sidebar.avatarSize)
                Text(channel.name ?? "DM")
                    .font(showsUnreadWeight ? MomoTheme.Sidebar.selectedRowFont : MomoTheme.Sidebar.rowFont)
                    .lineLimit(1)
                Spacer(minLength: MomoTheme.Sidebar.compactSpacing)
                if let mentionLabel {
                    Text(mentionLabel)
                        .font(MomoTheme.Sidebar.badgeFont)
                        .monospacedDigit()
                        .padding(.horizontal, MomoTheme.Sidebar.compactSpacing)
                        .foregroundStyle(MomoTheme.Sidebar.mentionBadgeForeground)
                        .background(MomoTheme.Sidebar.mentionBadgeBackground, in: Capsule())
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, MomoTheme.Sidebar.rowHorizontalPadding)
            .padding(.vertical, MomoTheme.Sidebar.rowVerticalPadding)
            .frame(minHeight: MomoTheme.Sidebar.rowMinimumHeight)
            .contentShape(Rectangle())
            .background(
                channelRowBackground(channel),
                in: RoundedRectangle(cornerRadius: MomoTheme.Sidebar.rowCornerRadius, style: .continuous)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(copy.channelUnreadAccessibilityLabel(
            channelName: channel.name ?? "DM",
            unreadCount: readState?.unreadCount ?? 0,
            mentionCount: readState?.mentionCount ?? 0
        ))
        .onHover { isHovering in
            hoveredChannelID = isHovering ? channel.id : nil
        }
    }

    private func channelRowBackground(_ channel: Channel) -> Color {
        if isSelected(channel) {
            return MomoTheme.Sidebar.selectionBackground
        }
        if hoveredChannelID == channel.id {
            return MomoTheme.Sidebar.hoverBackground
        }
        return .clear
    }

    private func utilityFooter(copy: MomoWorkspaceCopy) -> some View {
        HStack(spacing: MomoTheme.Sidebar.itemSpacing) {
            utilityButton(
                utility: .approvals,
                title: copy.approvals,
                systemImage: "checkmark.seal",
                badge: viewModel.pendingApprovals.isEmpty ? nil : "\(viewModel.pendingApprovals.count)"
            ) {
                openApprovals?()
            }

            if developerMode {
                utilityButton(
                    utility: .developerTools,
                    title: copy.developerTools,
                    systemImage: "wrench.and.screwdriver",
                    badge: nil
                ) {
                    showDiagnostics.toggle()
                }
                .popover(isPresented: $showDiagnostics, arrowEdge: .bottom) {
                    developerToolsPopover(copy: copy)
                }
            }
        }
        .padding(.horizontal, MomoTheme.Sidebar.edgeInset)
        .frame(minHeight: MomoTheme.Sidebar.footerMinimumHeight)
    }

    // The utility strip is pinned below the scrolling roster, which a toolbar
    // item cannot express inside a resizable NavigationSplitView column.
    private func utilityButton(
        utility: MomoSidebarUtility,
        title: String,
        systemImage: String,
        badge: String? = nil,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: MomoTheme.Sidebar.compactSpacing) {
                Image(systemName: systemImage)
                    .foregroundStyle(.secondary)
                Text(title)
                    .font(MomoTheme.Sidebar.rowDetailFont)
                    .lineLimit(1)
                Spacer(minLength: MomoTheme.Sidebar.compactSpacing)
                if let badge {
                    Text(badge)
                        .font(MomoTheme.Sidebar.badgeFont)
                        .monospacedDigit()
                        .padding(.horizontal, MomoTheme.Sidebar.compactSpacing)
                        .foregroundStyle(MomoTheme.onAccent)
                        .background(MomoTheme.irreversibleRed, in: Capsule())
                }
            }
            .padding(.horizontal, MomoTheme.Sidebar.standardSpacing)
            .frame(maxWidth: .infinity, minHeight: MomoTheme.Sidebar.rowMinimumHeight)
            .background(
                hoveredUtility == utility
                    ? MomoTheme.Sidebar.hoverBackground
                    : MomoTheme.Sidebar.utilityBackground,
                in: RoundedRectangle(cornerRadius: MomoTheme.Sidebar.rowCornerRadius, style: .continuous)
            )
        }
        .buttonStyle(.plain)
        .onHover { isHovering in
            hoveredUtility = isHovering ? utility : nil
        }
    }

    @ViewBuilder
    private func memberRow(_ member: Member) -> some View {
        let copy = MomoWorkspaceCopy(language: language)
        let inChannel = viewModel.isMember(member.id)
        let isWorking = viewModel.channelMemberMutationIds.contains(member.id)
        memberRowContent(member)
            .focusable()
            .contextMenu {
                if member.isAgent {
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

                Button {
                    openMemberProfile?(member.id)
                } label: {
                    if viewModel.allowsLocalProfileEditing {
                        Label(copy.editProfile, systemImage: "person.text.rectangle")
                    } else {
                        Label(copy.serverManagedProfileNote, systemImage: "lock")
                    }
                }
                .disabled(!viewModel.allowsLocalProfileEditing)

                if viewModel.selectedChannelId != nil {
                    Divider()
                    Button(role: inChannel ? .destructive : nil) {
                        performMemberMutation(member, isMember: inChannel)
                    } label: {
                        Label(
                            inChannel ? copy.removeFromChannel : copy.addToChannel,
                            systemImage: inChannel ? "minus.circle" : "plus.circle"
                        )
                    }
                    .disabled(isWorking)
                }
            }
            .accessibilityActions {
                if viewModel.selectedChannelId != nil {
                    Button(inChannel ? copy.removeFromChannel : copy.addToChannel) {
                        performMemberMutation(member, isMember: inChannel)
                    }
                    .disabled(isWorking)
                }
            }
    }

    private func memberRowContent(_ member: Member) -> some View {
        // A custom row keeps agent identity and contextual actions aligned while
        // preserving the roster SoT's existing member-level context menu.
        let copy = MomoWorkspaceCopy(language: language)
        let isHovering = hoveredMemberID == member.id
        return HStack(spacing: MomoTheme.Sidebar.standardSpacing) {
            MomoProfileAvatar(
                initials: memberInitials(member),
                status: presenceBadge(for: member),
                imagePath: avatarPath(for: member),
                size: MomoTheme.Sidebar.avatarSize
            )
            VStack(alignment: .leading, spacing: MomoTheme.Sidebar.compactSpacing) {
                HStack(spacing: MomoTheme.Sidebar.compactSpacing) {
                    Text(member.displayName)
                        .font(MomoTheme.Sidebar.rowFont)
                        .lineLimit(1)
                    if member.isAgent {
                        MomoAgentBadgeGroup(
                            capabilities: [],
                            maximumCapabilities: 0
                        )
                    }
                }
                if member.isAgent, !member.normalizedCapabilities.isEmpty {
                    MomoAgentBadgeGroup(
                        capabilities: member.normalizedCapabilities,
                        maximumCapabilities: 1,
                        showsAgentIdentity: false
                    )
                }
            }
            if member.isAgent {
                if viewModel.isAgentWorking(member) {
                    Label(copy.presenceWorking, systemImage: "ellipsis.bubble.fill")
                        .labelStyle(.iconOnly)
                        .font(.caption2.weight(.bold))
                        .frame(
                            width: MomoTheme.Sidebar.actionSize,
                            height: MomoTheme.Sidebar.actionSize
                        )
                        .background(MomoTheme.costAmber.opacity(0.18), in: Circle())
                        .foregroundStyle(MomoTheme.costAmber)
                        .help(copy.agentWorkingTitle(member.displayName))
                        .momoQuickTooltip(copy.agentWorkingTitle(member.displayName))
                }
            }
            Spacer(minLength: MomoTheme.Sidebar.compactSpacing)
            if member.isAgent {
                memberHoverAction(
                    systemImage: "at",
                    tint: MomoTheme.agentAccent,
                    isVisible: isHovering,
                    isDisabled: !viewModel.canInsertMention(for: member),
                    helpText: viewModel.mentionUnavailableReason(for: member) ?? "Mention @\(member.handle)"
                ) {
                    viewModel.insertMention(for: member)
                }
            }
            if viewModel.allowsLocalProfileEditing {
                memberHoverAction(
                    systemImage: "person.text.rectangle",
                    tint: .secondary,
                    isVisible: isHovering,
                    isDisabled: false,
                    helpText: copy.editProfile
                ) {
                    openMemberProfile?(member.id)
                }
            }
            if viewModel.selectedChannelId != nil {
                memberMutationButton(member, isVisible: isHovering)
            }
        }
        .padding(.horizontal, MomoTheme.Sidebar.rowHorizontalPadding)
        .padding(.vertical, MomoTheme.Sidebar.rowVerticalPadding)
        .frame(minHeight: MomoTheme.Sidebar.rowMinimumHeight)
        .contentShape(Rectangle())
        .background(
            isHovering ? MomoTheme.Sidebar.hoverBackground : .clear,
            in: RoundedRectangle(cornerRadius: MomoTheme.Sidebar.rowCornerRadius, style: .continuous)
        )
        .onHover { hovering in
            hoveredMemberID = hovering ? member.id : nil
        }
    }

    private func channelCreateForm(copy: MomoWorkspaceCopy) -> some View {
        VStack(alignment: .leading, spacing: MomoTheme.Sidebar.standardSpacing) {
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
        .padding(.vertical, MomoTheme.Sidebar.compactSpacing)
    }

    private func memberHoverAction(
        systemImage: String,
        tint: Color,
        isVisible: Bool,
        isDisabled: Bool,
        helpText: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .frame(
                    width: MomoTheme.Sidebar.actionSize,
                    height: MomoTheme.Sidebar.actionSize
                )
                .foregroundStyle(tint)
                .background(
                    MomoTheme.Sidebar.utilityBackground,
                    in: RoundedRectangle(cornerRadius: MomoTheme.Sidebar.rowCornerRadius, style: .continuous)
                )
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .opacity(isVisible ? 1 : 0)
        .allowsHitTesting(isVisible)
        .accessibilityHidden(!isVisible)
        .help(helpText)
        .momoQuickTooltip(helpText)
    }

    private func memberMutationButton(_ member: Member, isVisible: Bool) -> some View {
        let copy = MomoWorkspaceCopy(language: language)
        let inChannel = viewModel.isMember(member.id)
        let isWorking = viewModel.channelMemberMutationIds.contains(member.id)
        return Button {
            performMemberMutation(member, isMember: inChannel)
        } label: {
            Image(systemName: inChannel ? "minus" : "plus")
                .frame(
                    width: MomoTheme.Sidebar.actionSize,
                    height: MomoTheme.Sidebar.actionSize
                )
                .foregroundStyle(inChannel ? .secondary : MomoTheme.humanAccent)
                .background(
                    MomoTheme.Sidebar.utilityBackground,
                    in: RoundedRectangle(cornerRadius: MomoTheme.Sidebar.rowCornerRadius, style: .continuous)
                )
        }
        .buttonStyle(.plain)
        .disabled(isWorking)
        .opacity(isVisible ? 1 : 0)
        .allowsHitTesting(isVisible)
        .accessibilityHidden(!isVisible)
        .help(inChannel ? copy.removeFromChannel : copy.addToChannel)
        .momoQuickTooltip(inChannel ? copy.removeFromChannel : copy.addToChannel)
    }

    private func performMemberMutation(_ member: Member, isMember: Bool) {
        Task {
            if isMember {
                await viewModel.removeMember(member.id)
            } else {
                await viewModel.addMember(member.id)
            }
        }
    }

    private func profileFooter(copy: MomoWorkspaceCopy) -> some View {
        Button {
            withAnimation(sidebarPanelAnimation) {
                showProfilePanel.toggle()
            }
        } label: {
            HStack(spacing: MomoTheme.Sidebar.standardSpacing) {
                MomoProfileAvatar(
                    initials: profileInitials,
                    status: profilePresenceBadge,
                    imagePath: profileAvatarPath,
                    size: MomoTheme.Sidebar.avatarSize
                )

                VStack(alignment: .leading, spacing: MomoTheme.Sidebar.compactSpacing) {
                    Text(profileDisplayName)
                        .font(MomoTheme.Sidebar.workspaceFont)
                        .lineLimit(1)
                    Text(profileDetail)
                        .font(MomoTheme.Sidebar.workspaceDetailFont)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer()

                Image(systemName: "chevron.up")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .rotationEffect(.degrees(showProfilePanel ? 180 : 0))
            }
            .contentShape(Rectangle())
            .padding(.horizontal, MomoTheme.Sidebar.rowHorizontalPadding)
            .frame(minHeight: MomoTheme.Sidebar.footerMinimumHeight)
            .background(
                showProfilePanel ? MomoTheme.Sidebar.hoverBackground : .clear,
                in: RoundedRectangle(cornerRadius: MomoTheme.Sidebar.rowCornerRadius, style: .continuous)
            )
            .padding(.horizontal, MomoTheme.Sidebar.edgeInset)
        }
        .buttonStyle(.plain)
        .popover(isPresented: $showMemberInvite, arrowEdge: .bottom) {
            memberInvitePopover(copy: copy)
                .frame(width: MomoTheme.memberInvitePopoverWidth)
        }
        .popover(isPresented: $showInvites) {
            if let context = sessionChrome?.inviteAdminContext {
                InviteAdminPopover(context: context)
            }
        }
        .animation(sidebarPanelAnimation, value: showMemberInvite)
    }

    private func profilePanel(copy: MomoWorkspaceCopy) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                MomoProfileAvatar(initials: profileInitials, status: profilePresenceBadge, imagePath: profileAvatarPath, size: 42)
                VStack(alignment: .leading, spacing: 3) {
                    Text(profileDisplayName)
                        .font(.headline)
                    Text(profileDetail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
            }

            Divider()

            profileAction(
                copy.profile,
                systemImage: "person.crop.circle",
                isDisabled: !viewModel.allowsLocalProfileEditing,
                helpText: viewModel.allowsLocalProfileEditing ? copy.profile : copy.serverManagedProfileNote
            ) {
                showProfilePanel = false
                openProfile?()
            }
            if !viewModel.allowsLocalProfileEditing {
                Label(copy.serverManagedProfileNote, systemImage: "lock")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 8)
            }
            profileAction(copy.settings, systemImage: "gearshape") {
                showProfilePanel = false
                openSettings?()
            }
            profileAction(copy.downloads, systemImage: "tray.and.arrow.down") {
                showProfilePanel = false
                openDownloads?()
            }
            profileAction(copy.updates, systemImage: "arrow.down.circle") {
                showProfilePanel = false
                openUpdates?()
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
        .momoSurface(.card, cornerRadius: MomoTheme.cornerLarge)
    }

    private func profileAction(
        _ title: String,
        systemImage: String,
        role: ButtonRole? = nil,
        isDisabled: Bool = false,
        helpText: String? = nil,
        action: @escaping () -> Void
    ) -> some View {
        Button(role: role, action: action) {
            HStack(spacing: 10) {
                Image(systemName: systemImage)
                    .font(.body.weight(.semibold))
                    .frame(width: 22)
                Text(title)
                    .font(.body)
                Spacer()
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 9)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .help(helpText ?? title)
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
                        .font(.caption2.weight(.bold))
                }
                Text(title)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
            }
            .padding(.horizontal, 7)
            .frame(height: 26)
            .background(selected ? MomoTheme.humanAccent : Color.primary.opacity(0.08), in: Capsule())
            .foregroundStyle(selected ? MomoTheme.onAccent : .primary)
        }
        .buttonStyle(.plain)
    }

    private func memberInvitePopover(copy: MomoWorkspaceCopy) -> some View {
        ScrollView {
            memberInvitePopoverContent(copy: copy)
                .padding(24)
        }
        .frame(maxHeight: MomoTheme.memberInvitePopoverMaximumHeight)
    }

    private func memberInvitePopoverContent(copy: MomoWorkspaceCopy) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 8) {
                Image(systemName: "plus.circle")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(MomoTheme.humanAccent)
                VStack(alignment: .leading, spacing: 4) {
                    Text(copy.inviteMembers)
                        .font(.headline)
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
                VStack(alignment: .leading, spacing: 12) {
                    Label(copy.humanInviteTitle, systemImage: "person.crop.circle.badge.plus")
                        .font(.subheadline.weight(.semibold))
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
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 12) {
                        MomoProfileAvatar(
                            initials: hermesInitials,
                            status: nil,
                            imagePath: hermesAvatarPath,
                            size: 38
                        )
                        Label(copy.agentInviteTitle, systemImage: "point.3.connected.trianglepath.dotted")
                            .font(.subheadline.weight(.semibold))
                    }
                    Text(copy.agentInviteBody)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    TextField(copy.agentDisplayName, text: $hermesDisplayName)
                        .textFieldStyle(.roundedBorder)
                    TextField(copy.agentAlias, text: .constant(Self.dogfoodHermesAlias))
                        .textFieldStyle(.roundedBorder)
                        .disabled(true)
                    TextField(copy.providerEndpoint, text: $hermesEndpointDraft)
                        .textFieldStyle(.roundedBorder)
                    TextField(copy.modelLabel, text: $hermesModelLabel)
                        .textFieldStyle(.roundedBorder)
                    Picker(copy.permissionScope, selection: $hermesPermissionScopeRaw) {
                        ForEach(MomoAgentPairingPermissionScope.allCases) { scope in
                            Text(copy.pairingScopeTitle(scope)).tag(scope.rawValue)
                        }
                    }
                    .pickerStyle(.menu)
                    Text(copy.pairingScopeDetail(selectedPairingScope))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if agentEndpointPolicy.requiresExplicitOptIn {
                        Toggle(copy.nonLoopbackHTTPOptIn, isOn: $allowNonLoopbackHTTP)
                            .font(.caption.weight(.semibold))
                    }
                    HStack(spacing: 8) {
                        Button {
                            chooseHermesAvatar()
                        } label: {
                            Label(copy.chooseImage, systemImage: "photo")
                        }
                        .controlSize(.small)

                        Button {
                            hermesAvatarPath = ""
                        } label: {
                            Label(copy.removeImage, systemImage: "arrow.uturn.backward")
                        }
                        .controlSize(.small)
                        .disabled(hermesAvatarPath.isEmpty)
                    }
                    Label(copy.agentInviteNetworkNote, systemImage: "network")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Label(agentEndpointPolicy.isAllowed ? agentEndpointPolicy.reason : "\(copy.pairingEndpointBlocked) \(agentEndpointPolicy.reason)", systemImage: agentEndpointPolicy.isAllowed ? "checkmark.shield" : "lock.trianglebadge.exclamationmark")
                        .font(.caption)
                        .foregroundStyle(agentEndpointPolicy.isAllowed ? MomoTheme.reversibleGreen : MomoTheme.irreversibleRed)
                    Label(agentPairingStatusText(copy: copy), systemImage: agentPairingStatusIcon)
                        .font(.caption)
                        .foregroundStyle(agentPairingStatusTint)
                    agentPairingChecklist(copy: copy)
                    pairingManifestBox(copy: copy)
                    if hermesInvited, let agent = hermesAgent {
                        MomoAgentCredentialManagementView(
                            copy: copy,
                            agent: agent,
                            viewModel: viewModel,
                            presentation: .popover,
                            onReveal: { agentCredentialReveal = $0 }
                        )
                    }
                    if let agentInviteNotice {
                        Label(agentInviteNotice, systemImage: "checkmark.circle")
                            .font(.caption)
                            .foregroundStyle(MomoTheme.reversibleGreen)
                    }
                    if let agentInviteError {
                        Label(agentInviteError, systemImage: "exclamationmark.triangle")
                            .font(.caption)
                            .foregroundStyle(MomoTheme.irreversibleRed)
                    }
                    Button {
                        Task { await completeAgentInvite() }
                    } label: {
                        Label(hermesInvited ? copy.updateAgentProfile : copy.completeAgentInvite, systemImage: "checkmark.circle")
                    }
                    .controlSize(.regular)
                    .disabled(agentInviteInFlight || !agentEndpointPolicy.isAllowed)
                }
            }
        }
    }

    private var hermesInitials: String {
        let name = hermesDisplayName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = name.first else { return "H" }
        return String(first).uppercased()
    }

    private var agentPairingStatusIcon: String {
        hermesInvited ? "checkmark.circle.fill" : "clock"
    }

    private var agentPairingStatusTint: Color {
        hermesInvited ? MomoTheme.reversibleGreen : .secondary
    }

    private func agentPairingStatusText(copy: MomoWorkspaceCopy) -> String {
        if hermesInvited {
            return copy.agentInvitedStatus(alias: displayAgentAlias)
        }
        return copy.agentNotInvitedStatus
    }

    private var displayAgentAlias: String {
        Self.dogfoodHermesAlias
    }

    private var hermesAgent: Member? {
        viewModel.members.first { member in
            member.isAgent
                && member.handle.caseInsensitiveCompare("hermes") == .orderedSame
        }
    }

    private var selectedPairingScope: MomoAgentPairingPermissionScope {
        MomoAgentPairingPermissionScope(rawValue: hermesPermissionScopeRaw) ?? .channelReadReply
    }

    private var agentEndpointPolicy: MomoAgentPairingEndpointPolicy {
        MomoAgentPairingSecurity.endpointPolicy(hermesEndpointDraft, allowNonLoopbackHTTP: allowNonLoopbackHTTP)
    }

    private var currentPairingManifest: MomoAgentPairingManifest {
        MomoAgentPairingManifest.make(
            displayName: hermesDisplayName,
            handle: displayAgentAlias,
            endpoint: agentEndpointPolicy.sanitizedEndpoint ?? hermesEndpointDraft,
            modelLabel: hermesModelLabel,
            permissionScope: selectedPairingScope,
            workspaceID: viewModel.workspaceId,
            channelID: viewModel.selectedChannelId,
            apiURL: sessionChrome?.summary.serverURLString
        )
    }

    private func agentPairingChecklist(copy: MomoWorkspaceCopy) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(copy.agentPairingChecklist)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            pairingStep(1, copy.pairingStepProvider, isDone: true)
            pairingStep(2, copy.pairingStepOAuth, isDone: false)
            pairingStep(3, copy.pairingStepValues, isDone: agentEndpointPolicy.isAllowed)
            pairingStep(4, copy.pairingStepSmoke, isDone: hermesInvited)
            Text(copy.runbookReference)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(10)
        .background(.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
    }

    private func pairingStep(_ index: Int, _ title: String, isDone: Bool) -> some View {
        HStack(spacing: 8) {
            Image(systemName: isDone ? "checkmark.circle.fill" : "\(index).circle")
                .foregroundStyle(isDone ? MomoTheme.reversibleGreen : .secondary)
            Text(title)
                .font(.caption)
            Spacer()
        }
    }

    private func pairingManifestBox(copy: MomoWorkspaceCopy) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label(copy.pairingManifest, systemImage: "doc.text")
                    .font(.caption.weight(.semibold))
                Spacer()
                Text(currentPairingManifest.inviteCode)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            HStack(spacing: 8) {
                Button {
                    copyToPasteboard(currentPairingManifest.inviteCode)
                    agentInviteNotice = copy.inviteCodeCopied
                    agentInviteError = nil
                } label: {
                    Label(copy.copyInviteCode, systemImage: "number.square")
                }
                .controlSize(.small)
                .disabled(!agentEndpointPolicy.isAllowed)
                Button {
                    copyToPasteboard(currentPairingManifest.prettyJSONString)
                    agentInviteNotice = copy.manifestCopied
                    agentInviteError = nil
                } label: {
                    Label(copy.copyManifest, systemImage: "doc.on.doc")
                }
                .controlSize(.small)
                .disabled(!agentEndpointPolicy.isAllowed)
                Button {
                    exportPairingManifest(copy: copy)
                } label: {
                    Label(copy.exportManifest, systemImage: "square.and.arrow.down")
                }
                .controlSize(.small)
                .disabled(!agentEndpointPolicy.isAllowed)
            }
        }
        .padding(10)
        .background(.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
    }

    private func copyToPasteboard(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    @MainActor
    private func exportPairingManifest(copy: MomoWorkspaceCopy) {
        guard agentEndpointPolicy.isAllowed else {
            agentInviteNotice = nil
            agentInviteError = agentEndpointPolicy.reason
            return
        }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.json]
        panel.canCreateDirectories = true
        panel.nameFieldStringValue = "momo-agent-\(normalizedAgentAlias(displayAgentAlias))-pairing.json"
        panel.title = copy.exportManifest
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            try currentPairingManifest.prettyJSONString.write(to: url, atomically: true, encoding: .utf8)
            agentInviteNotice = copy.manifestCopied
            agentInviteError = nil
        } catch {
            agentInviteNotice = nil
            agentInviteError = error.localizedDescription
        }
    }

    @MainActor
    private func completeAgentInvite() async {
        guard !agentInviteInFlight else { return }
        guard agentEndpointPolicy.isAllowed else {
            agentInviteNotice = nil
            agentInviteError = agentEndpointPolicy.reason
            return
        }
        agentInviteInFlight = true
        agentInviteError = nil
        agentInviteNotice = nil
        defer { agentInviteInFlight = false }

        if hermesDisplayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            hermesDisplayName = "Hermes"
        }

        if let sanitizedEndpoint = agentEndpointPolicy.sanitizedEndpoint {
            storedHermesEndpoint = sanitizedEndpoint
            hermesEndpointDraft = sanitizedEndpoint
        }
        hermesAlias = Self.dogfoodHermesAlias

        let agent: Member
        do {
            agent = try await viewModel.inviteDogfoodAgent(
                displayName: hermesDisplayName,
                handle: displayAgentAlias,
                avatarPath: hermesAvatarPath
            )
            setHermesInvited(true)
        } catch {
            setHermesInvited(false)
            agentInviteError = error.localizedDescription
            return
        }

        do {
            let reveal = try await viewModel.issueAgentCredential(for: agent.id)
            withAnimation(sidebarPanelAnimation) {
                showMemberInvite = false
            }
            agentCredentialReveal = reveal
        } catch {
            agentInviteError = MomoWorkspaceCopy(language: language).agentCredentialErrorMessage(error)
        }
    }

    @MainActor
    private func chooseHermesAvatar() {
        if let path = chooseLocalImage(named: "hermes-agent-avatar") {
            hermesAvatarPath = path
        }
    }

    @MainActor
    private func chooseLocalImage(named name: String) -> String? {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.title = MomoWorkspaceCopy(language: language).chooseImage

        guard panel.runModal() == .OK, let source = panel.url else {
            return nil
        }

        do {
            let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support", isDirectory: true)
            let directory = base.appendingPathComponent("momo/avatars", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let ext = source.pathExtension.isEmpty ? "png" : source.pathExtension
            let destination = directory.appendingPathComponent("\(name)-\(UUID().uuidString).\(ext)")
            try FileManager.default.copyItem(at: source, to: destination)
            return destination.path
        } catch {
            NSSound.beep()
            return nil
        }
    }

    private var profileDisplayName: String {
        let draft = profileDisplayNameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        if !draft.isEmpty {
            return draft
        }
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

    private var profilePresenceBadge: MomoPresenceBadge? {
        guard !viewModel.usesServerRosterSourceOfTruth,
              let member = viewModel.members.first(where: { !$0.isAgent })
        else {
            return nil
        }
        return presenceBadge(for: member)
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

    private var currentAppearance: MomoAppearancePreference {
        MomoAppearancePreference(rawValue: appearanceRaw) ?? .system
    }

    private var sidebarPanelAnimation: Animation? {
        reduceMotion ? nil : MomoTheme.Motion.stateChange
    }

    private func isDogfoodHermesAgent(_ member: Member) -> Bool {
        guard member.isAgent else { return false }
        let identity = "\(member.displayName) \(member.handle)".lowercased()
        return identity.contains("hermes") || identity.contains("에르메스")
    }

    private var hermesInviteScopeKey: String {
        guard let workspace = viewModel.workspaceId,
              let channel = viewModel.selectedChannelId
        else {
            return "none"
        }
        return "\(workspace.description).\(channel.description)"
    }

    private var hermesInviteDefaultsKey: String {
        "momo.dogfood.hermes.invited.\(hermesInviteScopeKey)"
    }

    private func refreshHermesEndpointDraftIfNeeded() {
        guard hermesEndpointDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        hermesEndpointDraft = storedHermesEndpoint
    }

    private func refreshHermesInviteState() {
        guard hermesInviteScopeKey != "none" else {
            hermesInvited = false
            return
        }
        let persisted = UserDefaults.standard.bool(forKey: hermesInviteDefaultsKey)
        let hasChannelMember = viewModel.members.contains { member in
            isDogfoodHermesAgent(member) && viewModel.isMember(member.id)
        }
        hermesInvited = persisted && hasChannelMember
    }

    private func setHermesInvited(_ value: Bool) {
        guard hermesInviteScopeKey != "none" else {
            hermesInvited = false
            return
        }
        UserDefaults.standard.set(value, forKey: hermesInviteDefaultsKey)
        hermesInvited = value
    }

    private func normalizedAgentAlias(_ rawValue: String) -> String {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let withoutAt = trimmed.hasPrefix("@") ? String(trimmed.dropFirst()) : trimmed
        return withoutAt.lowercased().filter { character in
            character.isLetter || character.isNumber || character == "-" || character == "_"
        }
    }

    private func displayMember(_ member: Member) -> Member {
        guard !viewModel.usesServerRosterSourceOfTruth else { return member }
        var copy = member
        if let localName = MomoLocalProfileStore.displayName(for: member) {
            copy.displayName = localName
        } else if isDogfoodHermesAgent(member) {
            let displayName = hermesDisplayName.trimmingCharacters(in: .whitespacesAndNewlines)
            if !displayName.isEmpty {
                copy.displayName = displayName
            }
        }
        if isDogfoodHermesAgent(member) {
            copy.handle = normalizedAgentAlias(Self.dogfoodHermesAlias)
        }
        if let localAvatarPath = MomoLocalProfileStore.avatarPath(for: member) {
            copy.avatarURL = URL(fileURLWithPath: localAvatarPath)
        } else if isDogfoodHermesAgent(member), !hermesAvatarPath.isEmpty {
            copy.avatarURL = URL(fileURLWithPath: hermesAvatarPath)
        }
        if let localPresence = MomoLocalProfileStore.presence(for: member) {
            copy.presence = localPresence
        } else if isDogfoodHermesAgent(member), copy.presence == .offline {
            copy.presence = .online
        }
        return copy
    }

    private func avatarPath(for member: Member) -> String {
        if viewModel.usesServerRosterSourceOfTruth {
            return member.avatarURL?.isFileURL == true ? member.avatarURL?.path ?? "" : ""
        }
        if let local = MomoLocalProfileStore.avatarPath(for: member) {
            return local
        }
        if isDogfoodHermesAgent(member) {
            return hermesAvatarPath
        }
        if member.id == viewModel.members.first(where: { !$0.isAgent })?.id {
            return profileAvatarPath
        }
        return member.avatarURL?.isFileURL == true ? member.avatarURL?.path ?? "" : ""
    }

    private func memberInitials(_ member: Member) -> String {
        guard let first = member.displayName.trimmingCharacters(in: .whitespacesAndNewlines).first else {
            return member.isAgent ? "A" : "M"
        }
        return String(first).uppercased()
    }

    private func presenceBadge(for member: Member) -> MomoPresenceBadge? {
        let isActivelyWorking = viewModel.isAgentWorking(member)
        guard MomoSidebarPolicy.showsRosterPresence(
            usesServerRosterSourceOfTruth: viewModel.usesServerRosterSourceOfTruth,
            isActivelyWorking: isActivelyWorking
        ) else {
            return nil
        }
        if isActivelyWorking {
            return .working
        }
        if member.status != .active {
            return .error
        }
        let presence = MomoLocalProfileStore.presence(for: member) ?? member.presence
        switch presence {
        case .online:
            return .online
        case .working:
            return .working
        case .away:
            return .away
        case .offline:
            return .away
        }
    }

    private func sidebarEmptyRow(_ title: String, systemImage: String) -> some View {
        HStack(spacing: MomoTheme.Sidebar.standardSpacing) {
            Image(systemName: systemImage)
                .frame(width: MomoTheme.Sidebar.avatarSize)
                .foregroundStyle(.secondary)
            Text(title)
                .font(MomoTheme.Sidebar.rowDetailFont)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.horizontal, MomoTheme.Sidebar.rowHorizontalPadding)
        .padding(.vertical, MomoTheme.Sidebar.rowVerticalPadding)
        .frame(minHeight: MomoTheme.Sidebar.rowMinimumHeight)
    }

}

private enum MomoSidebarUtility {
    case approvals
    case developerTools
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
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(MomoTheme.humanAccent)
                    .frame(width: 34, height: 34)
                    .background(.primary.opacity(0.08), in: RoundedRectangle(cornerRadius: 11, style: .continuous))

                VStack(alignment: .leading, spacing: 3) {
                    Text(copy.downloads)
                        .font(.title3.weight(.semibold))
                    Text(copy.downloadsSubtitle)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.bold))
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
                        .font(.title3.weight(.semibold))
                    Text(copy.serverSettingsSubtitle)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.bold))
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
                    .font(.title3.weight(.heavy))
                    .foregroundStyle(MomoTheme.onAccent)
                    .frame(width: size, height: size)
                    .background(MomoTheme.humanAccent, in: RoundedRectangle(cornerRadius: size * 0.30, style: .continuous))
            }
        }
        .frame(width: size, height: size)
        .overlay {
            RoundedRectangle(cornerRadius: size * 0.30, style: .continuous)
                .stroke(MomoTheme.subtleBorder, lineWidth: 1)
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
    let status: MomoPresenceBadge?
    var imagePath: String = ""
    var size: CGFloat = 34

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            if let image = avatarImage {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: size, height: size)
                    .clipShape(Circle())
            } else {
                Text(initials)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(MomoTheme.onAccent)
                    .frame(width: size, height: size)
                    .background(MomoTheme.agentAccent, in: Circle())
            }
            if let status {
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

    private var avatarImage: NSImage? {
        guard !imagePath.isEmpty else { return nil }
        return MomoAvatarImageCache.image(atPath: imagePath)
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
                        .font(.caption2.weight(.bold))
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
        case .gateway:
            return "Hermes gateway"
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
