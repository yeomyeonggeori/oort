import AppKit
import MomoCore
import SwiftUI

enum MomoMemberInspectorAudience: Equatable {
    case channel
    case workspace
}

enum MomoMemberDirectMessageAvailability: Equatable {
    case available
    case currentUser
    case inactive
    case inFlight
}

enum MomoMemberInspectorPolicy {
    struct Groups: Equatable {
        let members: [Member]
        let managers: [Member]
        let agents: [Member]
        let online: [Member]
        let away: [Member]
        let offline: [Member]
    }

    static func filteredMembers(
        _ members: [Member],
        audience: MomoMemberInspectorAudience,
        channelID: ChannelID?,
        query: String,
        scope: MomoMemberDirectoryScope
    ) -> [Member] {
        groups(
            members,
            audience: audience,
            channelID: channelID,
            query: query,
            scope: scope
        ).members
    }

    static func groups(
        _ members: [Member],
        audience: MomoMemberInspectorAudience,
        channelID: ChannelID?,
        query: String,
        scope: MomoMemberDirectoryScope
    ) -> Groups {
        let audienceMembers = members.filter { member in
            guard member.status != .deleted else { return false }
            switch audience {
            case .channel:
                guard let channelID else { return false }
                return member.status == .active && member.channelIds.contains(channelID)
            case .workspace:
                return true
            }
        }

        let filtered = MomoMemberDirectoryPolicy.filteredMembers(
            audienceMembers,
            query: query,
            scope: scope
        )
        .sorted { lhs, rhs in
            if lhs.status == .active, rhs.status != .active { return true }
            if lhs.status != .active, rhs.status == .active { return false }
            if lhs.kind != rhs.kind { return lhs.kind == .human }
            let nameOrder = lhs.displayName.localizedCaseInsensitiveCompare(rhs.displayName)
            if nameOrder != .orderedSame { return nameOrder == .orderedAscending }
            return lhs.handle.localizedCaseInsensitiveCompare(rhs.handle) == .orderedAscending
        }
        let managers = filtered.filter {
            !$0.isAgent && ($0.workspaceRole == .owner || $0.workspaceRole == .admin)
        }
        let managerIDs = Set(managers.map(\.id))
        let agents = filtered.filter(\.isAgent)
        let people = filtered.filter { !$0.isAgent && !managerIDs.contains($0.id) }
        return Groups(
            members: filtered,
            managers: managers,
            agents: agents,
            online: people.filter { $0.status == .active && $0.presence == .online },
            away: people.filter {
                $0.status == .active && ($0.presence == .away || $0.presence == .working)
            },
            offline: people.filter { $0.status != .active || $0.presence == .offline }
        )
    }

    static func directMessageAvailability(
        for member: Member,
        currentMemberID: MemberID?,
        inFlightMemberIDs: Set<MemberID>
    ) -> MomoMemberDirectMessageAvailability {
        if currentMemberID == member.id { return .currentUser }
        if member.status != .active { return .inactive }
        if inFlightMemberIDs.contains(member.id) { return .inFlight }
        return .available
    }
}

struct MomoChannelMemberInspectorView: View {
    private enum FocusTarget: Hashable {
        case search
        case close
    }

    @ObservedObject var viewModel: ChatViewModel
    let audience: MomoMemberInspectorAudience
    let copy: MomoWorkspaceCopy
    let close: () -> Void
    let didOpenDirectMessage: () -> Void
    let presentation: MomoInspectorPresentation

    @State private var query = ""
    @State private var selectedMemberID: MemberID?
    @State private var hoveredMemberID: MemberID?
    @State private var failedDirectMessageMemberID: MemberID?
    @State private var directMessageTasks: [MemberID: Task<Void, Never>] = [:]
    @FocusState private var focusedControl: FocusTarget?

    init(
        viewModel: ChatViewModel,
        audience: MomoMemberInspectorAudience,
        copy: MomoWorkspaceCopy,
        initialMemberID: MemberID? = nil,
        close: @escaping () -> Void,
        didOpenDirectMessage: @escaping () -> Void,
        presentation: MomoInspectorPresentation
    ) {
        self.viewModel = viewModel
        self.audience = audience
        self.copy = copy
        self.close = close
        self.didOpenDirectMessage = didOpenDirectMessage
        self.presentation = presentation
        _selectedMemberID = State(initialValue: initialMemberID)
    }

    var body: some View {
        inspectorPresentation
    }

    private var inspectorPresentation: some View {
        let groups = memberGroups
        return VStack(spacing: 0) {
            header(memberCount: groups.members.count)
            Divider()
            filters
            stateContent(groups: groups)
        }
        .momoInspectorSurface(presentation)
        .task {
            if viewModel.members.isEmpty {
                await viewModel.refreshMemberDirectory()
            }
            await Task.yield()
            focusedControl = .search
        }
        .onDisappear {
            directMessageTasks.values.forEach { $0.cancel() }
            directMessageTasks = [:]
        }
        .onChange(of: viewModel.selectedChannelId) { _, _ in
            selectedMemberID = nil
            failedDirectMessageMemberID = nil
            if audience == .channel {
                query = ""
            }
        }
        .onChange(of: audience) { _, _ in
            selectedMemberID = nil
            failedDirectMessageMemberID = nil
            query = ""
        }
    }

    private var memberGroups: MomoMemberInspectorPolicy.Groups {
        MomoMemberInspectorPolicy.groups(
            viewModel.members,
            audience: audience,
            channelID: viewModel.selectedChannelId,
            query: query,
            scope: .all
        )
    }

    private var title: String {
        audience == .channel ? copy.currentChannelMembers : copy.workspaceMembers
    }

    private func header(memberCount: Int) -> some View {
        HStack(spacing: MomoTheme.MemberInspector.standardSpacing) {
            VStack(alignment: .leading, spacing: MomoTheme.MemberInspector.compactSpacing) {
                Text(title)
                    .font(.headline)
                    .lineLimit(1)
                    .minimumScaleFactor(0.82)
                Text(copy.channelMemberCount(memberCount))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            Spacer(minLength: MomoTheme.MemberInspector.standardSpacing)
            Button(action: close) {
                Label(copy.closeMemberInspector, systemImage: "xmark")
                    .labelStyle(.iconOnly)
                    .frame(
                        width: MomoTheme.ChannelHeader.actionSize,
                        height: MomoTheme.ChannelHeader.actionSize
                    )
            }
            .buttonStyle(.borderless)
            .help(copy.closeMemberInspector)
            .momoQuickTooltip(copy.closeMemberInspector)
            .keyboardShortcut(.cancelAction)
            .focused($focusedControl, equals: .close)
            .accessibilityLabel(copy.closeMemberInspector)
        }
        .padding(.horizontal, MomoTheme.MemberInspector.edgeInset)
        .frame(minHeight: MomoTheme.ChannelHeader.minimumHeight)
    }

    private var filters: some View {
        VStack(spacing: MomoTheme.MemberInspector.standardSpacing) {
            HStack(spacing: MomoTheme.MemberInspector.standardSpacing) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField(copy.searchMembers, text: $query)
                    .textFieldStyle(.plain)
                    .focused($focusedControl, equals: .search)
                if !query.isEmpty {
                    Button {
                        query = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel(copy.clearMemberSearch)
                }
            }
            .padding(.horizontal, MomoTheme.MemberInspector.standardSpacing)
            .frame(height: 32)
            .background(
                MomoTheme.MemberInspector.hoverBackground,
                in: RoundedRectangle(cornerRadius: MomoTheme.MemberInspector.rowCornerRadius)
            )
            .overlay {
                RoundedRectangle(cornerRadius: MomoTheme.MemberInspector.rowCornerRadius)
                    .strokeBorder(Color.primary.opacity(0.1))
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(copy.searchMembers)
            .accessibilityIdentifier("momo-member-inspector-search")

            if viewModel.selectedRealtimeStatus?.isFallbackActive == true {
                Label(copy.memberDirectoryOffline, systemImage: "wifi.slash")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if viewModel.memberDirectoryError != nil, !viewModel.members.isEmpty {
                HStack(alignment: .firstTextBaseline, spacing: MomoTheme.MemberInspector.standardSpacing) {
                    Label(copy.memberLoadFailed, systemImage: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: MomoTheme.MemberInspector.compactSpacing)
                    Button(copy.retry) {
                        Task { await viewModel.refreshMemberDirectory() }
                    }
                    .controlSize(.small)
                }
            }
        }
        .padding(MomoTheme.MemberInspector.contentSpacing)
    }

    @ViewBuilder
    private func stateContent(groups: MomoMemberInspectorPolicy.Groups) -> some View {
        if viewModel.memberDirectoryIsRefreshing && viewModel.members.isEmpty {
            ProgressView(copy.loadingMembers)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if viewModel.memberDirectoryError != nil && viewModel.members.isEmpty {
            ContentUnavailableView {
                Label(copy.memberLoadFailed, systemImage: "exclamationmark.triangle")
            } description: {
                Text(copy.messageLoadFailedDetail)
            } actions: {
                Button(copy.retry) {
                    Task { await viewModel.refreshMemberDirectory() }
                }
            }
        } else if groups.members.isEmpty {
            ContentUnavailableView {
                Label(
                    query.isEmpty ? copy.noDirectoryMembers : copy.noMemberSearchResults,
                    systemImage: query.isEmpty ? "person.2" : "magnifyingglass"
                )
            } description: {
                Text(query.isEmpty ? copy.noDirectoryMembersDetail : query)
            } actions: {
                if !query.isEmpty {
                    Button(copy.clearMemberSearch) { query = "" }
                } else {
                    Button(copy.retry) {
                        Task { await viewModel.refreshMemberDirectory() }
                    }
                }
            }
        } else {
            memberList(groups: groups)
        }
    }

    private func memberList(groups: MomoMemberInspectorPolicy.Groups) -> some View {
        List {
            if !groups.managers.isEmpty {
                Section("\(copy.workspaceManagers) · \(groups.managers.count)") {
                    ForEach(groups.managers) { member in
                        memberRow(member)
                    }
                }
            }
            if !groups.agents.isEmpty {
                Section("\(copy.agents) · \(groups.agents.count)") {
                    ForEach(groups.agents) { member in
                        memberRow(member)
                    }
                }
            }
            if !groups.online.isEmpty {
                Section("\(copy.presenceOnline) · \(groups.online.count)") {
                    ForEach(groups.online) { member in
                        memberRow(member)
                    }
                }
            }
            if !groups.away.isEmpty {
                Section("\(copy.presenceAway) · \(groups.away.count)") {
                    ForEach(groups.away) { member in
                        memberRow(member)
                    }
                }
            }
            if !groups.offline.isEmpty {
                Section("\(copy.presenceOffline) · \(groups.offline.count)") {
                    ForEach(groups.offline) { member in
                        memberRow(member)
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .scrollContentBackground(.hidden)
    }

    private func memberRow(_ member: Member) -> some View {
        // A native Label cannot carry avatar presence, role, and capability metadata in one roster row.
        Button {
            selectedMemberID = member.id
            failedDirectMessageMemberID = nil
        } label: {
            HStack(spacing: MomoTheme.MemberInspector.standardSpacing) {
                memberAvatar(member, size: MomoTheme.MemberInspector.avatarSize)
                VStack(alignment: .leading, spacing: MomoTheme.MemberInspector.compactSpacing) {
                    HStack(spacing: MomoTheme.MemberInspector.compactSpacing) {
                        Text(member.displayName)
                            .font(.body.weight(.medium))
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                        if member.isAgent {
                            MomoAgentBadgeGroup(capabilities: [], maximumCapabilities: 0)
                        }
                    }
                    HStack(spacing: MomoTheme.MemberInspector.compactSpacing) {
                        Text("@\(member.handle)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        if member.isAgent, !member.normalizedCapabilities.isEmpty {
                            MomoAgentBadgeGroup(
                                capabilities: member.normalizedCapabilities,
                                maximumCapabilities: 1,
                                showsAgentIdentity: false
                            )
                        }
                    }
                }
                Spacer(minLength: MomoTheme.MemberInspector.compactSpacing)
            }
            .padding(.horizontal, MomoTheme.MemberInspector.standardSpacing)
            .padding(.vertical, MomoTheme.MemberInspector.compactSpacing)
            .frame(maxWidth: .infinity, minHeight: MomoTheme.MemberInspector.rowMinimumHeight, alignment: .leading)
            .contentShape(Rectangle())
            .background(
                hoveredMemberID == member.id ? MomoTheme.MemberInspector.hoverBackground : .clear,
                in: RoundedRectangle(
                    cornerRadius: MomoTheme.MemberInspector.rowCornerRadius,
                    style: .continuous
                )
            )
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            hoveredMemberID = hovering ? member.id : nil
        }
        .popover(isPresented: profileBinding(for: member.id), arrowEdge: .trailing) {
            profilePopoverContent(member)
        }
        .contextMenu {
            memberActions(member, includesProfileAction: true)
        }
        .accessibilityLabel(memberAccessibilityLabel(member))
        .accessibilityHint(copy.memberProfile)
        .accessibilityActions {
            if directMessageAvailability(for: member) == .available {
                Button(copy.sendDirectMessage) {
                    openDirectMessage(member)
                }
            }
            if viewModel.canInsertMention(for: member) {
                Button(copy.mentionMember) {
                    viewModel.insertMention(for: member)
                }
            }
            Button(copy.copyMemberHandle) {
                copyHandle(member)
            }
        }
    }

    private func profileBinding(for memberID: MemberID) -> Binding<Bool> {
        Binding(
            get: { selectedMemberID == memberID },
            set: { isPresented in
                if !isPresented, selectedMemberID == memberID {
                    selectedMemberID = nil
                }
            }
        )
    }

    private func profilePopoverContent(_ member: Member) -> some View {
        MomoMemberProfilePopoverView(
            viewModel: viewModel,
            member: member,
            copy: copy,
            showsDirectMessageFailure: failedDirectMessageMemberID == member.id,
            copyHandle: { copyHandle(member) },
            mention: {
                viewModel.insertMention(for: member)
                selectedMemberID = nil
            },
            openDirectMessage: { openDirectMessage(member) }
        )
    }

    @ViewBuilder
    private func memberActions(_ member: Member, includesProfileAction: Bool) -> some View {
        if includesProfileAction {
            Button {
                selectedMemberID = member.id
            } label: {
                Label(copy.memberProfile, systemImage: "person.text.rectangle")
            }
        }
        Button {
            openDirectMessage(member)
        } label: {
            Label(copy.sendDirectMessage, systemImage: "bubble.left")
        }
        .disabled(directMessageAvailability(for: member) != .available)

        Button {
            viewModel.insertMention(for: member)
        } label: {
            Label(copy.mentionMember, systemImage: "at")
        }
        .disabled(!viewModel.canInsertMention(for: member))

        Button {
            copyHandle(member)
        } label: {
            Label(copy.copyMemberHandle, systemImage: "doc.on.doc")
        }
    }

    private func directMessageAvailability(for member: Member) -> MomoMemberDirectMessageAvailability {
        MomoMemberInspectorPolicy.directMessageAvailability(
            for: member,
            currentMemberID: viewModel.currentNavigationMemberID,
            inFlightMemberIDs: viewModel.directMessageMutationIds
        )
    }

    private func openDirectMessage(_ member: Member) {
        guard directMessageAvailability(for: member) == .available else { return }
        failedDirectMessageMemberID = nil
        let memberID = member.id
        let task = Task { @MainActor in
            let outcome = await viewModel.startDirectMessage(with: memberID)
            guard !Task.isCancelled else { return }
            directMessageTasks.removeValue(forKey: memberID)
            switch outcome {
            case .opened:
                selectedMemberID = nil
                didOpenDirectMessage()
            case .ignored:
                break
            case .failed:
                failedDirectMessageMemberID = member.id
            }
        }
        directMessageTasks[memberID] = task
    }

    private func copyHandle(_ member: Member) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString("@\(member.handle)", forType: .string)
    }

    private func memberAccessibilityLabel(_ member: Member) -> String {
        [
            member.displayName,
            "@\(member.handle)",
            member.isAgent ? copy.agent : copy.human,
            copy.workspaceRoleTitle(member.workspaceRole),
            copy.presenceTitle(effectivePresence(for: member)),
        ].joined(separator: ", ")
    }

    private func memberAvatar(_ member: Member, size: CGFloat) -> some View {
        MomoMemberAvatarView(viewModel: viewModel, member: member, size: size)
    }

    private func effectivePresence(for member: Member) -> Presence {
        if member.status != .active { return .offline }
        if member.isAgent, viewModel.isAgentWorking(member) { return .working }
        return member.presence
    }

}

struct MomoMemberProfilePopoverView: View {
    @ObservedObject var viewModel: ChatViewModel
    let member: Member
    let copy: MomoWorkspaceCopy
    let showsDirectMessageFailure: Bool
    let copyHandle: () -> Void
    let mention: () -> Void
    let openDirectMessage: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: MomoTheme.MemberInspector.sectionSpacing) {
            HStack(alignment: .top, spacing: MomoTheme.MemberInspector.contentSpacing) {
                MomoMemberAvatarView(
                    viewModel: viewModel,
                    member: member,
                    size: MomoTheme.MemberInspector.profileIconSize
                )
                VStack(alignment: .leading, spacing: MomoTheme.MemberInspector.compactSpacing) {
                    HStack(spacing: MomoTheme.MemberInspector.standardSpacing) {
                        Text(member.displayName)
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(.primary)
                            .fixedSize(horizontal: false, vertical: true)
                        if member.isAgent {
                            MomoAgentBadgeGroup(capabilities: [], maximumCapabilities: 0)
                        }
                    }
                    Text("@\(member.handle)")
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                    Text(copy.presenceTitle(effectivePresence))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            GroupBox(copy.memberProfile) {
                VStack(alignment: .leading, spacing: MomoTheme.MemberInspector.standardSpacing) {
                    LabeledContent(copy.memberType) {
                        Text(member.isAgent ? copy.agent : copy.human)
                    }
                    LabeledContent(copy.memberRole) {
                        Text(copy.workspaceRoleTitle(member.workspaceRole))
                    }
                    LabeledContent(copy.status) {
                        Text(copy.memberStatusTitle(member.status))
                    }
                    if member.isAgent, !member.normalizedCapabilities.isEmpty {
                        MomoAgentBadgeGroup(
                            capabilities: member.normalizedCapabilities,
                            maximumCapabilities: 2,
                            showsAgentIdentity: false
                        )
                    }
                }
                .padding(.top, MomoTheme.MemberInspector.standardSpacing)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            availabilityMessage

            HStack(spacing: MomoTheme.MemberInspector.standardSpacing) {
                Button(action: copyHandle) {
                    Label(copy.copyMemberHandle, systemImage: "doc.on.doc")
                        .labelStyle(.iconOnly)
                }
                .help(copy.copyMemberHandle)
                .accessibilityLabel(copy.copyMemberHandle)

                Button(action: mention) {
                    Label(copy.mentionMember, systemImage: "at")
                        .labelStyle(.iconOnly)
                }
                .disabled(!viewModel.canInsertMention(for: member))
                .help(copy.mentionMember)
                .accessibilityLabel(copy.mentionMember)

                Spacer(minLength: MomoTheme.MemberInspector.compactSpacing)

                Button(action: openDirectMessage) {
                    HStack(spacing: MomoTheme.MemberInspector.standardSpacing) {
                        Label(copy.sendDirectMessage, systemImage: "bubble.left")
                        if directMessageAvailability == .inFlight {
                            ProgressView()
                                .controlSize(.small)
                                .accessibilityHidden(true)
                        }
                    }
                    .fixedSize(horizontal: true, vertical: true)
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(directMessageAvailability != .available)
                .accessibilityLabel(copy.sendDirectMessage)
                .accessibilityValue(directMessageAccessibilityValue)
            }
            .controlSize(.small)
        }
        .padding(MomoTheme.MemberInspector.edgeInset)
        .frame(width: MomoTheme.MemberInspector.profileWidth, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(copy.memberProfile)
    }

    @ViewBuilder
    private var availabilityMessage: some View {
        if showsDirectMessageFailure {
            Label(copy.directMessageFailed, systemImage: "exclamationmark.triangle.fill")
                .font(.callout)
                .foregroundStyle(MomoTheme.irreversibleRed)
                .fixedSize(horizontal: false, vertical: true)
        } else if directMessageAvailability == .currentUser {
            Text(copy.directMessageSelfUnavailable)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        } else if directMessageAvailability == .inactive {
            Text(copy.directMessageInactiveUnavailable)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var directMessageAvailability: MomoMemberDirectMessageAvailability {
        MomoMemberInspectorPolicy.directMessageAvailability(
            for: member,
            currentMemberID: viewModel.currentNavigationMemberID,
            inFlightMemberIDs: viewModel.directMessageMutationIds
        )
    }

    private var directMessageAccessibilityValue: String {
        directMessageAvailability == .inFlight ? copy.openingDirectMessage : ""
    }

    private var effectivePresence: Presence {
        if member.status != .active { return .offline }
        if member.isAgent, viewModel.isAgentWorking(member) { return .working }
        return member.presence
    }

}

private struct MomoMemberAvatarView: View {
    @ObservedObject var viewModel: ChatViewModel
    let member: Member
    let size: CGFloat

    var body: some View {
        ZStack {
            Circle()
                .fill(member.isAgent ? MomoTheme.agentAccent.opacity(0.16) : Color.primary.opacity(0.08))
            if let avatarURL = member.avatarURL {
                AsyncImage(url: avatarURL) { phase in
                    if case .success(let image) = phase {
                        image.resizable().scaledToFill()
                    } else {
                        avatarFallback
                    }
                }
                .clipShape(Circle())
            } else {
                avatarFallback
            }
        }
        .frame(
            width: size,
            height: size
        )
        .overlay(alignment: .bottomTrailing) {
            Circle()
                .fill(presenceColor)
                .frame(
                    width: MomoTheme.MemberInspector.presenceSize,
                    height: MomoTheme.MemberInspector.presenceSize
                )
                .overlay {
                    Circle()
                        .stroke(Color(nsColor: .windowBackgroundColor), lineWidth: 2)
                }
        }
        .accessibilityHidden(true)
    }

    private var avatarFallback: some View {
        Text(memberInitials)
            .font(.caption.weight(.semibold))
            .foregroundStyle(member.isAgent ? MomoTheme.agentAccent : .primary)
            .minimumScaleFactor(0.7)
            .lineLimit(1)
    }

    private var memberInitials: String {
        let words = member.displayName.split(whereSeparator: \.isWhitespace)
        let initials = words.prefix(2).compactMap(\.first).map(String.init).joined()
        return initials.isEmpty ? String(member.handle.prefix(2)).uppercased() : initials
    }

    private var presenceColor: Color {
        switch effectivePresence {
        case .online:
            return MomoTheme.reversibleGreen
        case .working, .away:
            return MomoTheme.costAmber
        case .offline:
            return .secondary
        }
    }

    private var effectivePresence: Presence {
        if member.status != .active { return .offline }
        if member.isAgent, viewModel.isAgentWorking(member) { return .working }
        return member.presence
    }
}
