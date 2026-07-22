import Foundation
import MomoCore
import SwiftUI

enum MomoMemoryGrantGranteeKind: String, Codable, Sendable, Hashable {
    case member
    case agent
}

struct MomoMemoryGrant: Identifiable, Codable, Sendable, Hashable {
    let id: UUID
    let workspaceId: WorkspaceID
    let memoryId: UUID
    let granteeKind: MomoMemoryGrantGranteeKind
    let granteeId: MemberID
    let grantedBy: MemberID
    let createdAtMs: Int64
    let revokedAtMs: Int64?

    var isRevoked: Bool { revokedAtMs != nil }
}

protocol MomoMemoryGrantBackend: Sendable {
    func memoryGrants(workspace: WorkspaceID, memory: UUID) async throws -> [MomoMemoryGrant]
    func grantMemoryAccess(
        workspace: WorkspaceID,
        memory: UUID,
        grantee: MemberID,
        kind: MomoMemoryGrantGranteeKind
    ) async throws -> MomoMemoryGrant
    func revokeMemoryAccess(
        workspace: WorkspaceID,
        memory: UUID,
        grantee: MemberID,
        kind: MomoMemoryGrantGranteeKind
    ) async throws -> MomoMemoryGrant
}

protocol MomoAgentOwnershipProvidingBackend: Sendable {
    func agentOwnerIDs() async -> [MemberID: MemberID]
}

enum MomoMemoryGrantAuthorization {
    static func canManage(
        entry: MemoryEntry,
        currentMemberID: MemberID?,
        canManageWorkspace: Bool,
        agentOwnerIDs: [MemberID: MemberID]
    ) -> Bool {
        if canManageWorkspace { return true }
        guard let currentMemberID else { return false }
        switch entry.scope {
        case .member:
            return entry.subjectMemberId == currentMemberID
        case .agent:
            guard let agentID = entry.agentMemberId else { return false }
            return agentOwnerIDs[agentID] == currentMemberID
        case .workspace, .conversation:
            return false
        }
    }
}

@MainActor
final class MomoMemoryGrantModel: ObservableObject {
    enum LoadState: Equatable {
        case offline
        case loading
        case loaded
        case failed
    }

    @Published private(set) var grants: [MomoMemoryGrant] = []
    @Published private(set) var state: LoadState
    @Published private(set) var mutatingGranteeIDs: Set<MemberID> = []
    @Published private(set) var inlineError: String?

    private let backend: (any MomoMemoryGrantBackend)?
    private let workspace: WorkspaceID?
    private let memory: UUID
    private let copy: MomoWorkspaceCopy

    init(
        backend: (any MomoMemoryGrantBackend)?,
        workspace: WorkspaceID?,
        memory: UUID,
        copy: MomoWorkspaceCopy,
        initialGrants: [MomoMemoryGrant] = []
    ) {
        self.backend = backend
        self.workspace = workspace
        self.memory = memory
        self.copy = copy
        grants = initialGrants
        state = initialGrants.isEmpty
            ? (backend == nil || workspace == nil ? .offline : .loading)
            : .loaded
    }

    var activeGranteeIDs: Set<MemberID> {
        Set(grants.lazy.filter { !$0.isRevoked }.map(\.granteeId))
    }

    var canRetry: Bool { backend != nil && workspace != nil }

    func load() async {
        guard let backend, let workspace else {
            state = .offline
            return
        }
        state = .loading
        inlineError = nil
        do {
            grants = try await backend.memoryGrants(workspace: workspace, memory: memory)
            state = .loaded
        } catch is CancellationError {
            return
        } catch {
            inlineError = MomoMemoryGrantFailure.message(for: error, copy: copy)
            state = MomoMemoryGrantFailure.isOffline(error) ? .offline : .failed
        }
    }

    func grant(to member: Member) async -> Bool {
        guard let backend, let workspace else {
            state = .offline
            return false
        }
        mutatingGranteeIDs.insert(member.id)
        inlineError = nil
        defer { mutatingGranteeIDs.remove(member.id) }
        do {
            let grant = try await backend.grantMemoryAccess(
                workspace: workspace,
                memory: memory,
                grantee: member.id,
                kind: member.isAgent ? .agent : .member
            )
            replace(grant)
            state = .loaded
            return true
        } catch {
            inlineError = MomoMemoryGrantFailure.message(for: error, copy: copy)
            state = MomoMemoryGrantFailure.isOffline(error) ? .offline : .loaded
            return false
        }
    }

    func revoke(_ grant: MomoMemoryGrant) async -> Bool {
        guard let backend, let workspace else {
            state = .offline
            return false
        }
        mutatingGranteeIDs.insert(grant.granteeId)
        inlineError = nil
        defer { mutatingGranteeIDs.remove(grant.granteeId) }
        do {
            let revoked = try await backend.revokeMemoryAccess(
                workspace: workspace,
                memory: memory,
                grantee: grant.granteeId,
                kind: grant.granteeKind
            )
            replace(revoked)
            state = .loaded
            return true
        } catch {
            inlineError = MomoMemoryGrantFailure.message(for: error, copy: copy)
            state = MomoMemoryGrantFailure.isOffline(error) ? .offline : .loaded
            return false
        }
    }

    private func replace(_ grant: MomoMemoryGrant) {
        if let index = grants.firstIndex(where: { $0.id == grant.id }) {
            grants[index] = grant
        } else {
            grants.insert(grant, at: 0)
        }
        grants.sort {
            if $0.isRevoked != $1.isRevoked { return !$0.isRevoked }
            return $0.createdAtMs > $1.createdAtMs
        }
    }
}

enum MomoMemoryGrantFailure {
    static func isOffline(_ error: any Error) -> Bool {
        guard let backendError = error as? BackendError else { return false }
        switch backendError {
        case .notConnected, .realtime, .timedOut:
            return true
        case .problem, .decoding, .budgetExceeded:
            return false
        }
    }

    static func message(for error: any Error, copy: MomoWorkspaceCopy) -> String {
        guard let backendError = error as? BackendError else {
            return copy.memoryGrantGenericError
        }
        switch backendError {
        case .problem(status: 400, title: _, detail: _):
            return copy.memoryGrantInvalidTargetError
        case .problem(status: 401, title: _, detail: _):
            return copy.memoryGrantAuthenticationError
        case .problem(status: 403, title: _, detail: _):
            return copy.memoryGrantPermissionError
        case .problem(status: 404, title: _, detail: _):
            return copy.memoryGrantNotFoundError
        case .problem(status: 429, title: _, detail: _):
            return copy.memoryGrantRateLimitError
        case .problem:
            return copy.memoryGrantServerError
        case .notConnected, .realtime, .timedOut:
            return copy.memoryGrantOffline
        case .decoding:
            return copy.memoryGrantInvalidResponseError
        case .budgetExceeded:
            return copy.memoryGrantGenericError
        }
    }
}

struct MomoMemoryGrantSection: View {
    @StateObject private var model: MomoMemoryGrantModel
    let copy: MomoWorkspaceCopy
    let members: [Member]
    let canManage: Bool
    private let formatDate: (Int64) -> String
    private let loadsOnAppear: Bool

    @State private var showsPicker = false
    @State private var grantToRevoke: MomoMemoryGrant?

    init(
        backend: (any MomoMemoryGrantBackend)?,
        workspace: WorkspaceID?,
        memory: UUID,
        copy: MomoWorkspaceCopy,
        members: [Member],
        canManage: Bool,
        formatDate: @escaping (Int64) -> String = MomoMemoryGrantDateFormatter.string
    ) {
        _model = StateObject(wrappedValue: MomoMemoryGrantModel(backend: backend, workspace: workspace, memory: memory, copy: copy))
        self.copy = copy
        self.members = members
        self.canManage = canManage
        self.formatDate = formatDate
        loadsOnAppear = true
    }

    init(
        model: MomoMemoryGrantModel,
        copy: MomoWorkspaceCopy,
        members: [Member],
        canManage: Bool,
        formatDate: @escaping (Int64) -> String = MomoMemoryGrantDateFormatter.string
    ) {
        _model = StateObject(wrappedValue: model)
        self.copy = copy
        self.members = members
        self.canManage = canManage
        self.formatDate = formatDate
        loadsOnAppear = false
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(copy.memoryGrantTitle)
                    .font(MomoTheme.Typography.sectionHeader)
                Spacer()
                if canManage {
                    Button {
                        showsPicker = true
                    } label: {
                        Label(copy.memoryGrantAdd, systemImage: "person.badge.plus")
                    }
                    .keyboardShortcut("g", modifiers: [.command, .shift])
                    .disabled(model.state == .loading || model.state == .offline)
                }
            }

            if let error = model.inlineError, model.state != .offline {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(MomoTheme.Typography.supporting)
                    .foregroundStyle(MomoTheme.irreversibleRed)
                    .fixedSize(horizontal: false, vertical: true)
            }

            stateContent

            if !canManage, model.state == .loaded {
                Label(copy.memoryGrantReadOnly, systemImage: "eye")
                    .font(MomoTheme.Typography.supporting)
                    .foregroundStyle(.secondary)
            }
        }
        .task {
            guard loadsOnAppear else { return }
            await model.load()
        }
        .sheet(isPresented: $showsPicker) {
            MomoMemoryGrantPickerView(
                copy: copy,
                members: grantCandidates,
                isGranting: false,
                errorMessage: model.inlineError,
                onCancel: { showsPicker = false },
                onGrant: { member in
                    let granted = await model.grant(to: member)
                    if granted { showsPicker = false }
                    return granted
                }
            )
        }
        .alert(copy.memoryRevokeTitle, isPresented: revokeConfirmationBinding, presenting: grantToRevoke) { grant in
            Button(copy.cancel, role: .cancel) { grantToRevoke = nil }
            Button(copy.memoryRevokeAction, role: .destructive) {
                Task {
                    _ = await model.revoke(grant)
                    grantToRevoke = nil
                }
            }
        } message: { grant in
            Text(copy.memoryRevokeConfirmation(name: memberName(grant.granteeId)))
        }
    }

    @ViewBuilder
    private var stateContent: some View {
        switch model.state {
        case .loading:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(copy.memoryGrantLoading)
                    .font(MomoTheme.Typography.supporting)
                    .foregroundStyle(.secondary)
            }
        case .offline:
            grantStatus(copy.memoryGrantOffline, systemImage: "wifi.slash")
        case .failed:
            Button {
                Task { await model.load() }
            } label: {
                Label(copy.memoryGrantRetry, systemImage: "arrow.clockwise")
            }
        case .loaded:
            if model.grants.isEmpty {
                grantStatus(copy.memoryGrantEmpty, systemImage: "person.2")
            } else {
                VStack(spacing: 0) {
                    ForEach(model.grants) { grant in
                        MomoMemoryGrantRow(
                            grant: grant,
                            grantee: member(grant.granteeId),
                            granterName: memberName(grant.grantedBy),
                            copy: copy,
                            formatDate: formatDate,
                            isMutating: model.mutatingGranteeIDs.contains(grant.granteeId),
                            canRevoke: canManage && !grant.isRevoked,
                            onRevoke: { grantToRevoke = grant }
                        )
                        if grant.id != model.grants.last?.id { Divider() }
                    }
                }
            }
        }
    }

    private func grantStatus(_ title: String, systemImage: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: systemImage)
            Text(title).fixedSize(horizontal: false, vertical: true)
            Spacer()
            if model.state == .offline, model.canRetry {
                Button(copy.memoryGrantRetry) { Task { await model.load() } }
            }
        }
        .font(MomoTheme.Typography.supporting)
        .foregroundStyle(.secondary)
    }

    private var grantCandidates: [Member] {
        members
            .filter { $0.status == .active && !model.activeGranteeIDs.contains($0.id) }
            .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
    }

    private func member(_ id: MemberID) -> Member? { members.first { $0.id == id } }

    private func memberName(_ id: MemberID) -> String {
        member(id)?.displayName ?? copy.memoryGrantUnknownMember
    }

    private var revokeConfirmationBinding: Binding<Bool> {
        Binding(
            get: { grantToRevoke != nil },
            set: { if !$0 { grantToRevoke = nil } }
        )
    }
}

private struct MomoMemoryGrantRow: View {
    let grant: MomoMemoryGrant
    let grantee: Member?
    let granterName: String
    let copy: MomoWorkspaceCopy
    let formatDate: (Int64) -> String
    let isMutating: Bool
    let canRevoke: Bool
    let onRevoke: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: grant.granteeKind == .agent ? "cpu" : "person")
                .foregroundStyle(grant.granteeKind == .agent ? MomoTheme.agentAccent : .secondary)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(grantee?.displayName ?? copy.memoryGrantUnknownMember)
                        .font(MomoTheme.Typography.row.weight(.semibold))
                        .foregroundStyle(grant.isRevoked ? .secondary : .primary)
                    Text(copy.memoryGrantBadge(grant.granteeKind))
                        .font(MomoTheme.Typography.supporting.weight(.semibold))
                        .foregroundStyle(grant.granteeKind == .agent ? MomoTheme.agentAccent : .secondary)
                    if grant.isRevoked {
                        Text(copy.memoryGrantRevoked)
                            .font(MomoTheme.Typography.supporting.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                }
                Text(copy.memoryGrantedBy(granterName, date: formatDate(grant.createdAtMs)))
                    .font(MomoTheme.Typography.supporting)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                if let revokedAtMs = grant.revokedAtMs {
                    Text(copy.memoryRevokedAt(formatDate(revokedAtMs)))
                        .font(MomoTheme.Typography.supporting)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            }
            Spacer()
            if isMutating {
                ProgressView().controlSize(.small)
            } else if canRevoke {
                Menu {
                    Button(copy.memoryRevokeAction, role: .destructive, action: onRevoke)
                } label: {
                    Image(systemName: "ellipsis")
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .accessibilityLabel(copy.memoryGrantActions)
            }
        }
        .padding(.vertical, 8)
        .contextMenu {
            if canRevoke {
                Button(copy.memoryRevokeAction, role: .destructive, action: onRevoke)
            }
        }
    }

}

enum MomoMemoryGrantDateFormatter {
    static func string(_ milliseconds: Int64) -> String {
        Date(timeIntervalSince1970: Double(milliseconds) / 1_000)
            .formatted(date: .abbreviated, time: .shortened)
    }
}

struct MomoMemoryGrantPickerView: View {
    private enum Layout {
        static let width: CGFloat = 480
        static let height: CGFloat = 520
    }

    let copy: MomoWorkspaceCopy
    let members: [Member]
    let isGranting: Bool
    let errorMessage: String?
    let onCancel: () -> Void
    let onGrant: (Member) async -> Bool

    @State private var query = ""
    @State private var selectedID: MemberID?
    @State private var submitting = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(copy.memoryGrantPickerTitle)
                    .font(MomoTheme.Typography.screenTitle)
                Text(copy.memoryGrantPickerDetail)
                    .font(MomoTheme.Typography.supporting)
                    .foregroundStyle(.secondary)
            }

            TextField(copy.memoryGrantSearchPlaceholder, text: $query)
                .textFieldStyle(.roundedBorder)

            if filteredMembers.isEmpty {
                ContentUnavailableView(
                    copy.memoryGrantNoCandidates,
                    systemImage: "person.2.slash",
                    description: Text(copy.memoryGrantNoCandidatesDetail)
                )
            } else {
                List(filteredMembers, selection: $selectedID) { member in
                    HStack(spacing: 12) {
                        Image(systemName: member.isAgent ? "cpu" : "person")
                            .foregroundStyle(member.isAgent ? MomoTheme.agentAccent : .secondary)
                            .frame(width: 16)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(member.displayName)
                                .font(MomoTheme.Typography.row.weight(.semibold))
                            Text("@\(member.handle)")
                                .font(MomoTheme.Typography.supporting)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(copy.memoryGrantBadge(member.isAgent ? .agent : .member))
                            .font(MomoTheme.Typography.supporting.weight(.semibold))
                            .foregroundStyle(member.isAgent ? MomoTheme.agentAccent : .secondary)
                    }
                    .tag(member.id)
                }
                .listStyle(.inset)
            }

            if let errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.triangle")
                    .font(MomoTheme.Typography.supporting)
                    .foregroundStyle(MomoTheme.irreversibleRed)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack {
                Spacer()
                Button(copy.cancel, action: onCancel)
                    .keyboardShortcut(.cancelAction)
                Button(copy.memoryGrantConfirm) {
                    guard let selected else { return }
                    submitting = true
                    Task {
                        _ = await onGrant(selected)
                        submitting = false
                    }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(selected == nil || submitting || isGranting)
            }
        }
        .padding(24)
        .frame(width: Layout.width, height: Layout.height)
        .momoFlatSurface(.background)
    }

    private var filteredMembers: [Member] {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return members }
        return members.filter {
            $0.displayName.localizedCaseInsensitiveContains(normalized)
                || $0.handle.localizedCaseInsensitiveContains(normalized)
        }
    }

    private var selected: Member? { members.first { $0.id == selectedID } }
}

struct MomoMemoryGrantRequestDTO: Encodable {
    let granteeKind: MomoMemoryGrantGranteeKind
    let granteeId: MemberID
}

struct MomoMemoryGrantResponseDTO: Decodable {
    let grant: MomoMemoryGrant
}

struct MomoMemoryGrantPageResponseDTO: Decodable {
    let grants: [MomoMemoryGrant]
}
