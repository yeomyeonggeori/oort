import SwiftUI
import MomoCore

enum MomoMemberDirectoryScope: String, CaseIterable, Identifiable {
    case all
    case people
    case agents

    var id: String { rawValue }
}

enum MomoMemberDirectoryPolicy {
    static func filteredMembers(
        _ members: [Member],
        query: String,
        scope: MomoMemberDirectoryScope
    ) -> [Member] {
        let normalizedQuery = query
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()

        return members
            .filter { $0.status != .deleted }
            .filter { member in
                switch scope {
                case .all: return true
                case .people: return !member.isAgent
                case .agents: return member.isAgent
                }
            }
            .filter { member in
                normalizedQuery.isEmpty
                    || member.displayName.lowercased().contains(normalizedQuery)
                    || member.handle.lowercased().contains(normalizedQuery)
            }
            .sorted { lhs, rhs in
                if lhs.kind != rhs.kind { return lhs.kind == .human }
                let nameOrder = lhs.displayName.localizedCaseInsensitiveCompare(rhs.displayName)
                if nameOrder != .orderedSame { return nameOrder == .orderedAscending }
                return lhs.handle.localizedCaseInsensitiveCompare(rhs.handle) == .orderedAscending
            }
    }
}

enum MomoMemberDirectoryCapturePane: Equatable {
    case list
    case detail
}

/// Native workspace member directory: searchable roster on the left, calm
/// profile details and the primary DM action on the right.
public struct MemberDirectoryView: View {
    @ObservedObject private var viewModel: ChatViewModel
    @Environment(\.dismiss) private var dismiss
    @AppStorage(MomoUILanguage.appStorageKey) private var languageRaw = MomoUILanguage.preferredDefault.rawValue
    @State private var query = ""
    @State private var scope: MomoMemberDirectoryScope = .all
    @State private var selectedMemberID: MemberID?
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @State private var showsAgentOnboarding = false
    private let capturePane: MomoMemberDirectoryCapturePane?

    public init(viewModel: ChatViewModel) {
        self.viewModel = viewModel
        capturePane = nil
    }

    init(
        viewModel: ChatViewModel,
        initialSelection: MemberID?,
        capturePane: MomoMemberDirectoryCapturePane? = nil
    ) {
        self.viewModel = viewModel
        _selectedMemberID = State(initialValue: initialSelection)
        self.capturePane = capturePane
    }

    public var body: some View {
        presentation
            .navigationTitle(copy.memberDirectory)
            .momoSurface(.background, cornerRadius: 0)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(copy.dismiss) {
                        dismiss()
                    }
                    .keyboardShortcut(.cancelAction)
                }
                if viewModel.canManageWorkspace && viewModel.supportsAgentAddressOnboarding {
                    ToolbarItem(placement: .primaryAction) {
                        Button {
                            viewModel.resetAgentOnboarding()
                            showsAgentOnboarding = true
                        } label: {
                            Label(copy.addAgent, systemImage: "person.fill.badge.plus")
                        }
                        .keyboardShortcut("a", modifiers: [.command, .shift])
                        .help(copy.addAgent)
                    }
                }
            }
            .sheet(isPresented: $showsAgentOnboarding) {
                MomoAgentOnboardingView(
                    viewModel: viewModel,
                    copy: copy,
                    onCompleted: { memberID in
                        selectedMemberID = memberID
                        scope = .agents
                        showsAgentOnboarding = false
                    }
                )
            }
            .task {
                if viewModel.members.isEmpty {
                    await viewModel.refreshMemberDirectory()
                }
                selectFirstVisibleMemberIfNeeded()
            }
            .onChange(of: filteredMembers.map(\.id)) { _, _ in
                selectFirstVisibleMemberIfNeeded()
            }
    }

    @ViewBuilder
    private var presentation: some View {
        if capturePane == .list {
            VStack(spacing: 0) {
                captureToolbar(showsSearch: true)
                directoryListContent
            }
            .momoSurface(.panel, cornerRadius: 0)
        } else if capturePane == .detail {
            VStack(spacing: 0) {
                captureToolbar(showsSearch: false)
                profileDetail
            }
            .momoSurface(.background, cornerRadius: 0)
        } else {
            NavigationSplitView(columnVisibility: $columnVisibility) {
                directoryList
                    .momoSurface(.panel, cornerRadius: 0)
                    .navigationSplitViewColumnWidth(
                        min: MomoTheme.MemberDirectory.listMinimumWidth,
                        ideal: MomoTheme.MemberDirectory.listIdealWidth,
                        max: MomoTheme.MemberDirectory.listMaximumWidth
                    )
            } detail: {
                profileDetail
                    .momoSurface(.background, cornerRadius: 0)
            }
            .frame(
                minWidth: MomoTheme.MemberDirectory.minimumWidth,
                idealWidth: MomoTheme.MemberDirectory.idealWidth,
                minHeight: MomoTheme.MemberDirectory.minimumHeight
            )
        }
    }

    private var language: MomoUILanguage {
        MomoUILanguage(rawValue: languageRaw) ?? .preferredDefault
    }

    private var copy: MomoWorkspaceCopy {
        MomoWorkspaceCopy(language: language)
    }

    private var filteredMembers: [Member] {
        MomoMemberDirectoryPolicy.filteredMembers(
            viewModel.members,
            query: query,
            scope: scope
        )
    }

    @ViewBuilder
    private var directoryList: some View {
        directoryListContent
            .searchable(text: $query, prompt: copy.searchMembers)
    }

    @ViewBuilder
    private var directoryListContent: some View {
        VStack(spacing: 0) {
            Picker(copy.memberType, selection: $scope) {
                Text(copy.allMembers).tag(MomoMemberDirectoryScope.all)
                Text(copy.people).tag(MomoMemberDirectoryScope.people)
                Text(copy.agents).tag(MomoMemberDirectoryScope.agents)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, MomoTheme.MemberDirectory.contentSpacing)
            .padding(.vertical, MomoTheme.MemberDirectory.standardSpacing)

            if viewModel.selectedRealtimeStatus?.isFallbackActive == true {
                Label(copy.memberDirectoryOffline, systemImage: "wifi.slash")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, MomoTheme.MemberDirectory.contentSpacing)
                    .padding(.bottom, MomoTheme.MemberDirectory.standardSpacing)
            }

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
            } else if filteredMembers.isEmpty {
                ContentUnavailableView {
                    Label(
                        query.isEmpty ? copy.noDirectoryMembers : copy.noMemberSearchResults,
                        systemImage: query.isEmpty ? "person.2" : "magnifyingglass"
                    )
                } description: {
                    Text(query.isEmpty ? copy.noDirectoryMembersDetail : query)
                } actions: {
                    if !query.isEmpty {
                        Button(copy.clearMemberSearch) {
                            query = ""
                        }
                    } else if scope != .all {
                        Button(copy.showAllMembers) {
                            scope = .all
                        }
                    } else {
                        Button(copy.retry) {
                            Task { await viewModel.refreshMemberDirectory() }
                        }
                    }
                }
            } else {
                List(filteredMembers, selection: $selectedMemberID) { member in
                    directoryRow(member)
                        .tag(member.id)
                        .contextMenu {
                            Button {
                                openDirectMessage(with: member)
                            } label: {
                                Label(copy.sendDirectMessage, systemImage: "bubble.left")
                            }
                            .disabled(!canDirectMessage(member))
                        }
                }
                .listStyle(.sidebar)
            }
        }
    }

    private func captureToolbar(showsSearch: Bool) -> some View {
        // The system toolbar's vibrancy does not rasterize offscreen, so snapshot-only
        // capture panes mirror its native Button/TextField bindings in a flat host.
        HStack(spacing: MomoTheme.MemberDirectory.contentSpacing) {
            Button(copy.dismiss) {
                dismiss()
            }
            .keyboardShortcut(.cancelAction)

            Spacer(minLength: MomoTheme.MemberDirectory.standardSpacing)

            if showsSearch {
                HStack(spacing: MomoTheme.MemberDirectory.standardSpacing) {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                    TextField(copy.searchMembers, text: $query)
                        .textFieldStyle(.plain)
                        .accessibilityLabel(copy.searchMembers)
                }
                .padding(.horizontal, MomoTheme.MemberDirectory.contentSpacing)
                .padding(.vertical, MomoTheme.MemberDirectory.standardSpacing)
                .frame(maxWidth: MomoTheme.MemberDirectory.listIdealWidth)
                .background(
                    Color(nsColor: .controlBackgroundColor),
                    in: RoundedRectangle(
                        cornerRadius: MomoTheme.MemberDirectory.standardSpacing,
                        style: .continuous
                    )
                )
            }
        }
        .padding(.horizontal, MomoTheme.MemberDirectory.contentSpacing)
        .frame(minHeight: MomoTheme.MemberDirectory.captureToolbarMinimumHeight)
        .background(Color(nsColor: .windowBackgroundColor))
        .overlay(alignment: .bottom) { Divider() }
    }

    private func directoryRow(_ member: Member) -> some View {
        HStack(alignment: .top, spacing: MomoTheme.MemberDirectory.standardSpacing) {
            Image(systemName: member.isAgent ? "cpu" : "person.crop.circle")
                .foregroundStyle(member.isAgent ? MomoTheme.agentAccent : .secondary)
                .frame(
                    width: MomoTheme.Sidebar.avatarSize,
                    height: MomoTheme.Sidebar.avatarSize
                )
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: MomoTheme.MemberDirectory.compactSpacing) {
                HStack(alignment: .firstTextBaseline, spacing: MomoTheme.MemberDirectory.compactSpacing) {
                    Text(member.displayName)
                        .font(.body.weight(.medium))
                        .fixedSize(horizontal: false, vertical: true)
                    if member.isAgent {
                        MomoAgentBadgeGroup(capabilities: [], maximumCapabilities: 0)
                        if let origin = viewModel.agentOrigin(for: member) {
                            MomoAgentOriginBadge(origin: origin, copy: copy)
                        }
                    }
                }
                Text("@\(member.handle)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, MomoTheme.MemberDirectory.compactSpacing)
        .accessibilityElement(children: .combine)
        .accessibilityHint(copy.memberProfile)
        .accessibilityActions {
            if canDirectMessage(member) {
                Button(copy.sendDirectMessage) {
                    openDirectMessage(with: member)
                }
            }
        }
    }

    @ViewBuilder
    private var profileDetail: some View {
        if let member = selectedMemberID.flatMap(viewModel.member) {
            ScrollView {
                VStack(alignment: .leading, spacing: MomoTheme.MemberDirectory.sectionSpacing) {
                    HStack(alignment: .top, spacing: MomoTheme.MemberDirectory.contentSpacing) {
                        Image(systemName: member.isAgent ? "cpu" : "person.crop.circle")
                            .font(.title)
                            .foregroundStyle(member.isAgent ? MomoTheme.agentAccent : .secondary)
                            .frame(
                                width: MomoTheme.MemberDirectory.profileIconSize,
                                height: MomoTheme.MemberDirectory.profileIconSize
                            )
                            .accessibilityHidden(true)

                        VStack(alignment: .leading, spacing: MomoTheme.MemberDirectory.compactSpacing) {
                            HStack(alignment: .firstTextBaseline, spacing: MomoTheme.MemberDirectory.standardSpacing) {
                                Text(member.displayName)
                                    .font(.title3.weight(.semibold))
                                    .fixedSize(horizontal: false, vertical: true)
                                if member.isAgent {
                                    MomoAgentBadgeGroup(capabilities: [], maximumCapabilities: 0)
                                    if let origin = viewModel.agentOrigin(for: member) {
                                        MomoAgentOriginBadge(origin: origin, copy: copy)
                                    }
                                }
                            }
                            Text("@\(member.handle)")
                                .font(.body)
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }

                    GroupBox(copy.memberProfile) {
                        VStack(alignment: .leading, spacing: MomoTheme.MemberDirectory.contentSpacing) {
                            LabeledContent(copy.memberType) {
                                Text(member.isAgent ? copy.agent : copy.human)
                            }
                            LabeledContent(copy.memberRole) {
                                Text(copy.workspaceRoleTitle(member.workspaceRole))
                            }
                            LabeledContent(copy.memberHandle) {
                                Text("@\(member.handle)")
                                    .textSelection(.enabled)
                            }
                            LabeledContent(copy.status) {
                                Text(copy.memberStatusTitle(member.status))
                            }
                            if member.isAgent, let ownerPresentation = viewModel.agentOwner(for: member) {
                                MomoAgentManagedByView(
                                    viewModel: viewModel,
                                    presentation: ownerPresentation,
                                    copy: copy
                                )
                            }
                        }
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, MomoTheme.MemberDirectory.standardSpacing)
                    }

                    if member.isAgent, !member.normalizedCapabilities.isEmpty {
                        MomoAgentBadgeGroup(
                            capabilities: member.normalizedCapabilities,
                            maximumCapabilities: 2,
                            showsAgentIdentity: false
                        )
                    }

                    if viewModel.directMessageError != nil {
                        Label(copy.directMessageFailed, systemImage: "exclamationmark.triangle.fill")
                            .font(.callout)
                            .foregroundStyle(MomoTheme.irreversibleRed)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    HStack {
                        Spacer()
                        Button {
                            openDirectMessage(with: member)
                        } label: {
                            if viewModel.directMessageMutationIds.contains(member.id) {
                                ProgressView()
                                    .controlSize(.small)
                                Text(copy.sendDirectMessage)
                            } else {
                                HStack(spacing: MomoTheme.MemberDirectory.standardSpacing) {
                                    Image(systemName: "bubble.left")
                                    Text(copy.sendDirectMessage)
                                }
                                .foregroundStyle(Color(nsColor: .alternateSelectedControlTextColor))
                                .fixedSize(horizontal: true, vertical: true)
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .keyboardShortcut(.defaultAction)
                        .fixedSize(horizontal: true, vertical: true)
                        .disabled(!canDirectMessage(member))
                    }
                }
                .padding(MomoTheme.MemberDirectory.edgeInset)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else {
            ContentUnavailableView {
                Label(copy.memberProfile, systemImage: "person.crop.circle")
            } description: {
                Text(copy.selectMemberProfile)
            }
        }
    }

    private func canDirectMessage(_ member: Member) -> Bool {
        member.status == .active
            && !viewModel.isCurrentUser(member.id)
            && !viewModel.directMessageMutationIds.contains(member.id)
    }

    private func openDirectMessage(with member: Member) {
        guard canDirectMessage(member) else { return }
        Task {
            if case .opened = await viewModel.startDirectMessage(with: member.id) {
                dismiss()
            }
        }
    }

    private func selectFirstVisibleMemberIfNeeded() {
        if let selectedMemberID,
           filteredMembers.contains(where: { $0.id == selectedMemberID }) {
            return
        }
        selectedMemberID = filteredMembers.first?.id
    }
}
