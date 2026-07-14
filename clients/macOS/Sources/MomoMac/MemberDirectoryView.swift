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

    public init(viewModel: ChatViewModel) {
        self.viewModel = viewModel
    }

    init(viewModel: ChatViewModel, initialSelection: MemberID?) {
        self.viewModel = viewModel
        _selectedMemberID = State(initialValue: initialSelection)
    }

    public var body: some View {
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
        .navigationTitle(copy.memberDirectory)
        .momoSurface(.background, cornerRadius: 0)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button(copy.dismiss) {
                    dismiss()
                }
                .keyboardShortcut(.cancelAction)
            }
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
                        query.isEmpty ? copy.noWorkspaceMembers : copy.noMemberSearchResults,
                        systemImage: query.isEmpty ? "person.2" : "magnifyingglass"
                    )
                } description: {
                    Text(query.isEmpty ? copy.browseMembers : query)
                } actions: {
                    if !query.isEmpty {
                        Button(copy.clearMemberSearch) {
                            query = ""
                        }
                    } else if scope != .all {
                        Button(copy.showAllMembers) {
                            scope = .all
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
        .searchable(text: $query, prompt: copy.searchMembers)
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
                                Label(copy.sendDirectMessage, systemImage: "bubble.left")
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
            await viewModel.startDirectMessage(with: member.id)
            if viewModel.directMessageError == nil {
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
