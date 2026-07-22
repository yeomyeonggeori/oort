#if os(iOS)
import MomoCore
import SwiftUI

@MainActor
struct IOSMemberManagementView: View {
    let session: IOSSession
    let channelListModel: IOSChannelListModel
    let model: IOSMembershipAdministrationModel
    private let copy = IOSWorkspaceCopy.current

    private var actor: Member {
        channelListModel.membersByID[session.member.id] ?? session.member
    }

    private var members: [Member] {
        channelListModel.membersByID.values
            .filter { $0.status != .deleted }
            .sorted {
                if $0.status == .active, $1.status != .active { return true }
                if $0.status != .active, $1.status == .active { return false }
                return $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
            }
    }

    var body: some View {
        List {
            if let error = model.errorMessage {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                    Button(copy.dismiss) { model.clearError() }
                }
            }

            Section {
                NavigationLink {
                    IOSWorkspaceAuditView(model: model, members: channelListModel.membersByID)
                } label: {
                    Label(copy.auditLog, systemImage: "list.bullet.clipboard")
                }
                .accessibilityIdentifier("memberManagementAudit")
            }

            Section(copy.members) {
                ForEach(members) { member in
                    NavigationLink {
                        IOSMemberAdministrationDetail(
                            member: member,
                            actor: actor,
                            model: model,
                            refresh: { await channelListModel.refresh() }
                        )
                    } label: {
                        HStack(spacing: 12) {
                            IOSMemberInitialsAvatar(member: member)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(member.displayName)
                                    .font(.body.weight(.medium))
                                Text("@\(member.handle)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            VStack(alignment: .trailing, spacing: 2) {
                                Text(copy.roleTitle(member.workspaceRole))
                                if member.status != .active {
                                    Text(copy.statusTitle(member.status))
                                        .foregroundStyle(.orange)
                                }
                            }
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                    }
                    .accessibilityIdentifier("memberRow.\(member.id.description.lowercased())")
                }
            }
        }
        .navigationTitle(copy.members)
        .refreshable { await channelListModel.refresh() }
        .accessibilityIdentifier("memberManagementView")
    }
}

@MainActor
private struct IOSMemberAdministrationDetail: View {
    let member: Member
    let actor: Member
    let model: IOSMembershipAdministrationModel
    let refresh: @MainActor () async -> Void
    @State private var selectedRole: MembershipRole
    @State private var showsLifecycleConfirmation = false
    @State private var showsRemoval = false
    private let copy = IOSWorkspaceCopy.current

    init(
        member: Member,
        actor: Member,
        model: IOSMembershipAdministrationModel,
        refresh: @escaping @MainActor () async -> Void
    ) {
        self.member = member
        self.actor = actor
        self.model = model
        self.refresh = refresh
        _selectedRole = State(initialValue: member.workspaceRole ?? .member)
    }

    private var roles: [MembershipRole] { model.assignableRoles(actor: actor, target: member) }
    private var canManageLifecycle: Bool { model.canChangeLifecycle(actor: actor, target: member) }
    private var isWorking: Bool { model.mutationMemberIDs.contains(member.id) }

    var body: some View {
        Form {
            Section {
                LabeledContent(copy.handle, value: "@\(member.handle)")
                LabeledContent(copy.type, value: member.isAgent ? copy.agent : copy.person)
                LabeledContent(copy.status, value: copy.statusTitle(member.status))
                LabeledContent(copy.role, value: copy.roleTitle(member.workspaceRole))
            } header: {
                Label(member.displayName, systemImage: member.isAgent ? "sparkles" : "person")
            }

            if !roles.isEmpty {
                Section(copy.access) {
                    Picker(copy.workspaceRole, selection: $selectedRole) {
                        ForEach(roles, id: \.self) { Text(copy.roleTitle($0)).tag($0) }
                    }
                    Button(copy.saveRole) {
                        Task {
                            if await model.changeRole(member: member, actor: actor, role: selectedRole) {
                                await refresh()
                            }
                        }
                    }
                    .disabled(isWorking || selectedRole == member.workspaceRole)
                }
            }

            if canManageLifecycle {
                Section {
                    Button(member.status == .suspended ? copy.reinstateMember : copy.suspendMember) {
                        showsLifecycleConfirmation = true
                    }
                    .disabled(isWorking)

                    Button(copy.removeMember, role: .destructive) { showsRemoval = true }
                        .disabled(isWorking)
                } footer: {
                    if member.isAgent {
                        Text(copy.agentCredentialAfterRemoval)
                    }
                }
            }
        }
        .navigationTitle(member.displayName)
        .confirmationDialog(
            member.status == .suspended ? copy.reinstateQuestion : copy.suspendQuestion,
            isPresented: $showsLifecycleConfirmation,
            titleVisibility: .visible
        ) {
            Button(member.status == .suspended ? copy.reinstate : copy.suspend, role: member.status == .suspended ? nil : .destructive) {
                Task {
                    if await model.setSuspended(member.status != .suspended, member: member, actor: actor) {
                        await refresh()
                    }
                }
            }
            Button(copy.cancel, role: .cancel) {}
        } message: {
            Text(member.status == .suspended ? copy.reinstateExplanation : copy.suspendExplanation)
        }
        .sheet(isPresented: $showsRemoval) {
            IOSMemberRemovalView(member: member, actor: actor, model: model) {
                await refresh()
            }
        }
    }
}

@MainActor
private struct IOSMemberRemovalView: View {
    let member: Member
    let actor: Member
    let model: IOSMembershipAdministrationModel
    let refresh: @MainActor () async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var reason = ""
    @State private var ban = false
    private let copy = IOSWorkspaceCopy.current

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(copy.reasonOptional, text: $reason, axis: .vertical)
                        .lineLimit(2...5)
                    Toggle(copy.blockFromRejoining(member.handle), isOn: $ban)
                } footer: {
                    Text(copy.removeExplanation)
                }
                if model.errorMessage != nil {
                    Section {
                        Label(copy.membershipUpdateFailed, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                            .accessibilityIdentifier("memberRemovalError")
                    }
                }
            }
            .navigationTitle(copy.removeTitle(member.displayName))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(copy.cancel) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(copy.remove, role: .destructive) {
                        Task {
                            if await model.remove(member: member, actor: actor, ban: ban, reason: reason) {
                                await refresh()
                                dismiss()
                            }
                        }
                    }
                    .disabled(model.mutationMemberIDs.contains(member.id))
                }
            }
        }
        .presentationDetents([.medium])
        .onAppear { model.clearError() }
        .accessibilityIdentifier("memberRemovalSheet")
    }
}

@MainActor
private struct IOSWorkspaceAuditView: View {
    let model: IOSMembershipAdministrationModel
    let members: [MemberID: Member]
    @State private var actionFilter = IOSAuditActionFilter.all
    @State private var targetMember: MemberID?
    @State private var period = IOSAuditPeriod.all
    private let copy = IOSWorkspaceCopy.current

    var body: some View {
        List {
            Section(copy.filters) {
                Picker(copy.action, selection: $actionFilter) {
                    ForEach(IOSAuditActionFilter.allCases) { filter in
                        Text(filter.title(copy: copy)).tag(filter)
                    }
                }
                Picker(copy.member, selection: $targetMember) {
                    Text(copy.allMembers).tag(nil as MemberID?)
                    ForEach(sortedMembers) { member in
                        Text(member.displayName).tag(Optional(member.id))
                    }
                }
                Picker(copy.time, selection: $period) {
                    ForEach(IOSAuditPeriod.allCases) { period in
                        Text(period.title(copy: copy)).tag(period)
                    }
                }
                Button(copy.applyFilters) { Task { await applyFilters() } }
                    .disabled(model.auditIsLoading)
            }

            if let error = model.errorMessage {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.secondary)
                    Button(copy.dismiss) { model.clearError() }
                }
            }

            Section(copy.events) {
                if model.auditIsLoading && model.auditEvents.isEmpty {
                    HStack {
                        Spacer()
                        ProgressView(copy.loadingAuditLog)
                        Spacer()
                    }
                } else if model.auditEvents.isEmpty {
                    ContentUnavailableView(copy.noAuditEvents, systemImage: "list.bullet.clipboard")
                } else {
                    ForEach(model.auditEvents) { event in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(copy.auditActionTitle(event.action))
                                .font(.body.weight(.medium))
                            HStack(spacing: 8) {
                                Text(Date(timeIntervalSince1970: TimeInterval(event.createdAtMs) / 1_000), style: .date)
                                Text(Date(timeIntervalSince1970: TimeInterval(event.createdAtMs) / 1_000), style: .time)
                                Text(copy.actorTarget(
                                    actor: memberName(event.actorMemberId),
                                    target: event.subjectMemberId.map { memberName($0) }
                                ))
                                .lineLimit(1)
                            }
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                    }
                    if model.auditNextCursor != nil {
                        Button(copy.loadMore) { Task { await model.loadAudit() } }
                            .disabled(model.auditIsLoading)
                    }
                }
            }
        }
        .navigationTitle(copy.auditLog)
        .task { await model.loadAudit(reset: true) }
        .refreshable { await model.loadAudit(reset: true) }
    }

    private var sortedMembers: [Member] {
        members.values.filter { $0.status != .deleted }.sorted {
            $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
        }
    }

    private func applyFilters() async {
        await model.loadAudit(
            reset: true,
            filter: IOSWorkspaceAuditFilter(
                actionPrefixes: actionFilter.prefix.map { [$0] } ?? [],
                targetMember: targetMember,
                fromMs: period.fromMs,
                toMs: nil
            )
        )
    }

    private func memberName(_ id: MemberID?) -> String {
        guard let id else { return copy.unknownAuditActor }
        return members[id]?.displayName ?? id.description
    }
}

private enum IOSAuditActionFilter: String, CaseIterable, Identifiable {
    case all
    case member
    case ban

    var id: String { rawValue }
    func title(copy: IOSWorkspaceCopy) -> String {
        switch self { case .all: copy.allActions; case .member: copy.memberLifecycle; case .ban: copy.bans }
    }
    var prefix: String? {
        switch self { case .all: nil; case .member: "member."; case .ban: "ban." }
    }
}

private enum IOSAuditPeriod: String, CaseIterable, Identifiable {
    case all
    case day
    case week
    case month

    var id: String { rawValue }
    func title(copy: IOSWorkspaceCopy) -> String {
        switch self { case .all: copy.allTime; case .day: copy.hours24; case .week: copy.days7; case .month: copy.days30 }
    }
    var fromMs: Int64? {
        let seconds: TimeInterval
        switch self {
        case .all: return nil
        case .day: seconds = 86_400
        case .week: seconds = 604_800
        case .month: seconds = 2_592_000
        }
        return Int64(Date().addingTimeInterval(-seconds).timeIntervalSince1970 * 1_000)
    }
}

private struct IOSMemberInitialsAvatar: View {
    let member: Member

    var body: some View {
        Circle()
            .fill(member.isAgent ? Color.accentColor.opacity(0.16) : Color.secondary.opacity(0.14))
            .overlay {
                Text(initials)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(member.isAgent ? Color.accentColor : .primary)
            }
            .frame(width: 36, height: 36)
            .accessibilityHidden(true)
    }

    private var initials: String {
        let value = member.displayName.split(whereSeparator: \.isWhitespace)
            .prefix(2).compactMap(\.first).map(String.init).joined()
        return value.isEmpty ? String(member.handle.prefix(2)).uppercased() : value
    }
}

#endif
