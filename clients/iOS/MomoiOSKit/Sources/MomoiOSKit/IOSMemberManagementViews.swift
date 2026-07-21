#if os(iOS)
import MomoCore
import SwiftUI

@MainActor
struct IOSMemberManagementView: View {
    let session: IOSSession
    let channelListModel: IOSChannelListModel
    let model: IOSMembershipAdministrationModel

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
                    Button("Dismiss") { model.clearError() }
                }
            }

            Section {
                NavigationLink {
                    IOSWorkspaceAuditView(model: model, members: channelListModel.membersByID)
                } label: {
                    Label("Audit log", systemImage: "list.bullet.clipboard")
                }
                .accessibilityIdentifier("memberManagementAudit")
            }

            Section("Members") {
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
                                Text(roleTitle(member.workspaceRole))
                                if member.status != .active {
                                    Text(statusTitle(member.status))
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
        .navigationTitle("Members")
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
                LabeledContent("Handle", value: "@\(member.handle)")
                LabeledContent("Type", value: member.isAgent ? "Agent" : "Person")
                LabeledContent("Status", value: statusTitle(member.status))
                LabeledContent("Role", value: roleTitle(member.workspaceRole))
            } header: {
                Label(member.displayName, systemImage: member.isAgent ? "sparkles" : "person")
            }

            if !roles.isEmpty {
                Section("Access") {
                    Picker("Workspace role", selection: $selectedRole) {
                        ForEach(roles, id: \.self) { Text(roleTitle($0)).tag($0) }
                    }
                    Button("Save role") {
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
                    Button(member.status == .suspended ? "Reinstate member" : "Suspend member") {
                        showsLifecycleConfirmation = true
                    }
                    .disabled(isWorking)

                    Button("Remove member", role: .destructive) { showsRemoval = true }
                        .disabled(isWorking)
                } footer: {
                    if member.isAgent {
                        Text("Reinstating or recreating this agent requires a new credential. Revoked credentials cannot be restored.")
                    }
                }
            }
        }
        .navigationTitle(member.displayName)
        .confirmationDialog(
            member.status == .suspended ? "Reinstate this member?" : "Suspend this member?",
            isPresented: $showsLifecycleConfirmation,
            titleVisibility: .visible
        ) {
            Button(member.status == .suspended ? "Reinstate" : "Suspend", role: member.status == .suspended ? nil : .destructive) {
                Task {
                    if await model.setSuspended(member.status != .suspended, member: member, actor: actor) {
                        await refresh()
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(member.status == .suspended
                 ? "The member can sign in again, but revoked tokens stay revoked."
                 : "Access ends immediately and active tokens are revoked.")
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

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Reason (optional)", text: $reason, axis: .vertical)
                        .lineLimit(2...5)
                    Toggle("Block @\(member.handle) from rejoining", isOn: $ban)
                } footer: {
                    Text("Removing access revokes active tokens and records the action in the audit log.")
                }
            }
            .navigationTitle("Remove \(member.displayName)")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Remove", role: .destructive) {
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

    var body: some View {
        List {
            Section("Filters") {
                Picker("Action", selection: $actionFilter) {
                    ForEach(IOSAuditActionFilter.allCases) { filter in
                        Text(filter.title).tag(filter)
                    }
                }
                Picker("Member", selection: $targetMember) {
                    Text("All members").tag(nil as MemberID?)
                    ForEach(sortedMembers) { member in
                        Text(member.displayName).tag(Optional(member.id))
                    }
                }
                Picker("Time", selection: $period) {
                    ForEach(IOSAuditPeriod.allCases) { period in
                        Text(period.title).tag(period)
                    }
                }
                Button("Apply filters") { Task { await applyFilters() } }
                    .disabled(model.auditIsLoading)
            }

            if let error = model.errorMessage {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.secondary)
                    Button("Dismiss") { model.clearError() }
                }
            }

            Section("Events") {
                if model.auditIsLoading && model.auditEvents.isEmpty {
                    HStack {
                        Spacer()
                        ProgressView("Loading audit log")
                        Spacer()
                    }
                } else if model.auditEvents.isEmpty {
                    ContentUnavailableView("No audit events", systemImage: "list.bullet.clipboard")
                } else {
                    ForEach(model.auditEvents) { event in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(event.action.replacingOccurrences(of: ".", with: " ").capitalized)
                                .font(.body.weight(.medium))
                            HStack(spacing: 8) {
                                Text(Date(timeIntervalSince1970: TimeInterval(event.createdAtMs) / 1_000), style: .date)
                                if let id = event.subjectMemberId {
                                    Text(members[id]?.displayName ?? id.description)
                                        .lineLimit(1)
                                }
                            }
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                    }
                    if model.auditNextCursor != nil {
                        Button("Load more") { Task { await model.loadAudit() } }
                            .disabled(model.auditIsLoading)
                    }
                }
            }
        }
        .navigationTitle("Audit log")
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
}

private enum IOSAuditActionFilter: String, CaseIterable, Identifiable {
    case all
    case member
    case ban

    var id: String { rawValue }
    var title: String {
        switch self { case .all: "All actions"; case .member: "Member lifecycle"; case .ban: "Bans" }
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
    var title: String {
        switch self { case .all: "All time"; case .day: "24 hours"; case .week: "7 days"; case .month: "30 days" }
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

private func roleTitle(_ role: MembershipRole?) -> String {
    switch role { case .owner: "Owner"; case .admin: "Admin"; case .guest: "Guest"; default: "Member" }
}

private func statusTitle(_ status: MemberStatus) -> String {
    switch status { case .active: "Active"; case .invited: "Invited"; case .suspended: "Suspended"; case .deleted: "Removed" }
}
#endif
