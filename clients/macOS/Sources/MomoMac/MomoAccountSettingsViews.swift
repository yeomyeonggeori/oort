import SwiftUI
import AppKit
import Combine
import UniformTypeIdentifiers
import MomoCore

// MARK: - Dogfood account/settings surfaces

struct MomoProfileSettingsSurface: View {
    let copy: MomoWorkspaceCopy
    let summary: MomoServerSessionSummary?
    let member: Member?
    let allowsEditing: Bool
    @AppStorage("momo.profile.displayName") private var displayNameDraft = ""
    @AppStorage("momo.profile.avatarPath") private var avatarPath = ""

    var body: some View {
        MomoSettingsScrollView {
            MomoSettingsSection(title: copy.profile, subtitle: copy.profileSettingsSubtitle) {
                HStack(alignment: .top, spacing: 16) {
                    MomoSettingsAvatarMark(
                        text: profileInitials,
                        imagePath: allowsEditing ? avatarPath : "",
                        shape: .circle,
                        size: 74
                    )

                    VStack(alignment: .leading, spacing: 12) {
                        MomoSettingsLabeledField(title: copy.displayName) {
                            TextField(copy.displayName, text: displayNameBinding)
                                .textFieldStyle(.roundedBorder)
                                .font(MomoTheme.Typography.row)
                                .disabled(!allowsEditing)
                        }

                        HStack(spacing: 8) {
                            Button {
                                chooseProfileImage()
                            } label: {
                                Label(copy.chooseImage, systemImage: "photo")
                            }
                            .disabled(!allowsEditing)

                            Button {
                                avatarPath = ""
                            } label: {
                                Label(copy.removeImage, systemImage: "arrow.uturn.backward")
                            }
                            .disabled(avatarPath.isEmpty || !allowsEditing)
                        }
                        .controlSize(.regular)
                    }
                }
            }

            MomoSettingsSection(title: copy.status) {
                MomoSettingsInfoGrid(rows: [
                    (copy.profile, effectiveDisplayName),
                    (copy.email, summary?.email ?? copy.notConfigured),
                    (copy.session, summary?.detail ?? copy.notConfigured),
                ])
            }

            Label(
                allowsEditing ? copy.profileLocalDraftNote : copy.serverManagedProfileNote,
                systemImage: allowsEditing ? "info.circle" : "lock"
            )
                .font(MomoTheme.Typography.supporting)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 4)
        }
    }

    private var displayNameBinding: Binding<String> {
        Binding(
            get: {
                guard allowsEditing else { return fallbackDisplayName }
                let trimmed = displayNameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? fallbackDisplayName : displayNameDraft
            },
            set: { newValue in
                displayNameDraft = newValue
            }
        )
    }

    private var effectiveDisplayName: String {
        guard allowsEditing else { return fallbackDisplayName }
        let trimmed = displayNameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? fallbackDisplayName : trimmed
    }

    private var fallbackDisplayName: String {
        let memberName = (member?.displayName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !memberName.isEmpty { return memberName }
        let summaryName = (summary?.memberDisplayName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return summaryName.isEmpty ? "momo" : summaryName
    }

    private var profileInitials: String {
        guard let first = effectiveDisplayName.first else { return "M" }
        return String(first).uppercased()
    }

    @MainActor
    private func chooseProfileImage() {
        if let path = MomoLocalAssetStore.chooseImage(named: "profile-avatar", title: copy.chooseImage) {
            avatarPath = path
        }
    }
}

struct MomoAppSettingsSurface: View {
    let copy: MomoWorkspaceCopy
    @AppStorage(MomoUILanguage.appStorageKey) private var languageRaw = MomoUILanguage.preferredDefault.rawValue
    @AppStorage(MomoAppearancePreference.appStorageKey) private var appearanceRaw = MomoAppearancePreference.system.rawValue
    @AppStorage(MomoDeveloperModePresentation.developerModeKey) private var developerMode = false
    @AppStorage(MomoDeveloperModePresentation.costDisplayKey) private var showCosts = false

    var body: some View {
        MomoSettingsScrollView {
            MomoSettingsSection(title: copy.general, subtitle: copy.settingsSubtitle) {
                MomoSettingsControlRow(title: copy.languageLabel, systemImage: "globe") {
                    Picker(copy.languageLabel, selection: $languageRaw) {
                        ForEach(MomoUILanguage.allCases) { option in
                            Text(option.displayName).tag(option.rawValue)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .frame(maxWidth: 220)
                }

                MomoSettingsControlRow(title: copy.appearanceLabel, systemImage: currentAppearance.systemImage) {
                    Picker(copy.appearanceLabel, selection: $appearanceRaw) {
                        ForEach(MomoAppearancePreference.allCases) { option in
                            Text(option.title(copy: copy)).tag(option.rawValue)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .frame(maxWidth: 320)
                }
            }

            MomoSettingsSection(title: copy.developerMode, subtitle: copy.developerModeSubtitle) {
                Toggle(isOn: $developerMode) {
                    Label(copy.developerMode, systemImage: "hammer")
                        .font(.body)
                }

                if developerMode {
                    Divider().opacity(0.5)
                    Toggle(isOn: $showCosts) {
                        VStack(alignment: .leading, spacing: 4) {
                            Label(copy.showCosts, systemImage: "dollarsign.circle")
                                .font(.body)
                            Text(copy.showCostsSubtitle)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
    }

    private var currentAppearance: MomoAppearancePreference {
        MomoAppearancePreference(rawValue: appearanceRaw) ?? .system
    }
}

struct MomoWorkspaceNameDraft: Equatable {
    let normalized: String

    init(_ rawValue: String) {
        normalized = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var characterCount: Int { normalized.count }

    var isValid: Bool {
        (1...80).contains(characterCount)
            && !normalized.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
    }
}

@MainActor
final class MomoWorkspaceSettingsProjection: ObservableObject {
    private struct Snapshot: Equatable {
        let workspace: Workspace?
        let canManageWorkspace: Bool
        let updateInFlight: Bool
        let updateIssue: WorkspaceNameUpdateIssue?
    }

    private weak var viewModel: ChatViewModel?
    private var cancellable: AnyCancellable?
    private var refreshScheduled = false
    private var snapshot: Snapshot
    private(set) var observableUpdateCount = 0

    init(viewModel: ChatViewModel) {
        self.viewModel = viewModel
        self.snapshot = Self.snapshot(from: viewModel)
        cancellable = viewModel.objectWillChange.sink { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.scheduleRefresh()
            }
        }
    }

    var workspace: Workspace? { snapshot.workspace }
    var canManageWorkspace: Bool { snapshot.canManageWorkspace }
    var workspaceNameUpdateInFlight: Bool { snapshot.updateInFlight }
    var workspaceNameUpdateIssue: WorkspaceNameUpdateIssue? { snapshot.updateIssue }

    func updateWorkspaceName(_ name: String) async -> Bool {
        guard let viewModel else { return false }
        let result = await viewModel.updateWorkspaceName(name)
        refreshIfNeeded()
        return result
    }

    private func scheduleRefresh() {
        guard !refreshScheduled else { return }
        refreshScheduled = true
        Task { @MainActor [weak self] in
            await Task.yield()
            guard let self else { return }
            self.refreshScheduled = false
            self.refreshIfNeeded()
        }
    }

    private func refreshIfNeeded() {
        guard let viewModel else { return }
        let next = Self.snapshot(from: viewModel)
        guard next != snapshot else { return }
        objectWillChange.send()
        snapshot = next
        observableUpdateCount += 1
    }

    private static func snapshot(from viewModel: ChatViewModel) -> Snapshot {
        Snapshot(
            workspace: viewModel.workspace,
            canManageWorkspace: viewModel.canManageWorkspace,
            updateInFlight: viewModel.workspaceNameUpdateInFlight,
            updateIssue: viewModel.workspaceNameUpdateIssue
        )
    }
}

struct MomoWorkspaceSettingsSurface: View {
    let copy: MomoWorkspaceCopy
    private let viewModel: ChatViewModel
    @StateObject private var projection: MomoWorkspaceSettingsProjection
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @AppStorage("momo.server.iconText") private var serverIconText = "m"
    @AppStorage("momo.server.iconPath") private var serverIconPath = ""
    @AppStorage("momo.server.agentInviteRequiresApproval") private var agentInviteRequiresApproval = true
    @AppStorage("momo.server.memberInvitePolicy") private var memberInvitePolicy = "admins"
    @State private var serverDisplayName: String
    @State private var saveNotice: String?
    @State private var showsLeaveWorkspaceConfirmation = false

    private var workspaceNameDraft: MomoWorkspaceNameDraft {
        MomoWorkspaceNameDraft(serverDisplayName)
    }

    private var workspaceNameIsValid: Bool {
        workspaceNameDraft.isValid
    }

    init(copy: MomoWorkspaceCopy, viewModel: ChatViewModel) {
        self.copy = copy
        self.viewModel = viewModel
        _projection = StateObject(
            wrappedValue: MomoWorkspaceSettingsProjection(viewModel: viewModel)
        )
        _serverDisplayName = State(
            initialValue: viewModel.workspace?.name ?? copy.workspaceLabel
        )
    }

    var body: some View {
        MomoSettingsScrollView {
            MomoSettingsSection(title: copy.workspaceAppearance, subtitle: copy.serverSettingsSubtitle) {
                HStack(alignment: .top, spacing: 16) {
                    MomoSettingsAvatarMark(
                        text: serverIconText,
                        imagePath: serverIconPath,
                        shape: .rounded,
                        size: 64
                    )

                    VStack(alignment: .leading, spacing: 12) {
                        MomoSettingsLabeledField(title: copy.serverName) {
                            TextField(copy.serverName, text: $serverDisplayName)
                                .textFieldStyle(.roundedBorder)
                                .font(MomoTheme.Typography.row)
                                .disabled(!projection.canManageWorkspace || projection.workspaceNameUpdateInFlight)
                        }

                        if projection.canManageWorkspace {
                            Text(copy.workspaceNameLimit(workspaceNameDraft.characterCount))
                                .font(MomoTheme.Typography.supporting)
                                .foregroundStyle(workspaceNameIsValid ? Color.secondary : MomoTheme.irreversibleRed)
                        } else {
                            Label(copy.workspaceEditingRequiresAdmin, systemImage: "lock")
                                .font(MomoTheme.Typography.supporting)
                                .foregroundStyle(.secondary)
                        }

                        HStack(spacing: 8) {
                            Button {
                                Task { await saveWorkspaceName() }
                            } label: {
                                HStack(spacing: 8) {
                                    if projection.workspaceNameUpdateInFlight {
                                        ProgressView()
                                            .controlSize(.small)
                                            .accessibilityHidden(true)
                                    } else {
                                        Image(systemName: "checkmark")
                                    }
                                    Text(copy.saveWorkspaceName)
                                }
                            }
                            .accessibilityLabel(copy.saveWorkspaceName)
                            .disabled(
                                !projection.canManageWorkspace
                                    || projection.workspaceNameUpdateInFlight
                                    || !workspaceNameIsValid
                            )

                            if let saveNotice {
                                Text(saveNotice)
                                    .font(MomoTheme.Typography.supporting)
                                    .foregroundStyle(.secondary)
                            }
                        }

                        HStack(spacing: 8) {
                            Button {
                                chooseServerIcon()
                            } label: {
                                Label(copy.chooseImage, systemImage: "photo")
                            }

                            Button {
                                serverIconPath = ""
                            } label: {
                                Label(copy.removeImage, systemImage: "arrow.uturn.backward")
                            }
                            .disabled(serverIconPath.isEmpty)
                        }
                    }
                }

                Divider().opacity(0.5)

                MomoSettingsControlRow(title: copy.memberInvitePolicy, systemImage: "person.badge.plus") {
                    Picker(copy.memberInvitePolicy, selection: $memberInvitePolicy) {
                        Text(copy.invitePolicyAdmins).tag("admins")
                        Text(copy.invitePolicyMembers).tag("members")
                        Text(copy.invitePolicyLocked).tag("locked")
                    }
                    .pickerStyle(.menu)
                    .frame(
                        minWidth: dynamicTypeSize.isAccessibilitySize ? 240 : nil,
                        maxWidth: dynamicTypeSize.isAccessibilitySize ? 280 : 180
                    )
                }

                Toggle(copy.agentInviteRequiresApproval, isOn: $agentInviteRequiresApproval)
                    .font(MomoTheme.Typography.row.weight(.medium))
            }

            Label(copy.workspaceSettingsPersistenceNote, systemImage: "info.circle")
                .font(MomoTheme.Typography.supporting)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 4)

            MomoSettingsSection(title: copy.workspaceAccess, subtitle: copy.workspaceAccessSubtitle) {
                if viewModel.membershipAdministrationError != nil {
                    Label(copy.membershipUpdateFailed, systemImage: "exclamationmark.triangle")
                        .font(MomoTheme.Typography.supporting)
                        .foregroundStyle(MomoTheme.irreversibleRed)
                }
                Button(copy.leaveWorkspace, role: .destructive) {
                    showsLeaveWorkspaceConfirmation = true
                }
                .accessibilityIdentifier("workspaceSettingsLeave")
            }
        }
        .onChange(of: projection.workspace?.name) { _, value in
            guard let value, !value.isEmpty else { return }
            serverDisplayName = value
        }
        .onChange(of: serverDisplayName) { _, value in
            let persisted = projection.workspace.map { MomoWorkspaceNameDraft($0.name).normalized }
            guard MomoWorkspaceNameDraft(value).normalized != persisted else { return }
            saveNotice = nil
        }
        .confirmationDialog(
            copy.leaveWorkspaceQuestion,
            isPresented: $showsLeaveWorkspaceConfirmation
        ) {
            Button(copy.leaveWorkspace, role: .destructive) {
                Task { await viewModel.leaveCurrentWorkspace() }
            }
            Button(copy.cancel, role: .cancel) {}
        } message: {
            Text(viewModel.authenticatedMember?.workspaceRole == .owner
                 ? copy.lastOwnerLeaveExplanation
                 : copy.leaveWorkspaceExplanation)
        }
    }

    @MainActor
    private func chooseServerIcon() {
        if let path = MomoLocalAssetStore.chooseImage(named: "server-icon", title: copy.chooseImage) {
            serverIconPath = path
            if serverIconText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                serverIconText = "m"
            }
        }
    }

    @MainActor
    private func saveWorkspaceName() async {
        let saved = await projection.updateWorkspaceName(workspaceNameDraft.normalized)
        if saved, let name = projection.workspace?.name {
            serverDisplayName = name
            saveNotice = copy.workspaceNameSaved
        } else {
            saveNotice = copy.workspaceNameUpdateMessage(projection.workspaceNameUpdateIssue)
        }
    }
}

struct MomoMemberProfileSettingsSurface: View {
    let copy: MomoWorkspaceCopy
    let member: Member
    @ObservedObject var viewModel: ChatViewModel
    let onSave: (String, String?, Presence) -> Void
    @State private var displayName: String
    @State private var avatarPath: String
    @State private var presenceRaw: String
    @State private var credentialReveal: MomoAgentCredentialReveal?

    init(
        copy: MomoWorkspaceCopy,
        member: Member,
        viewModel: ChatViewModel,
        onSave: @escaping (String, String?, Presence) -> Void
    ) {
        self.copy = copy
        self.member = member
        self.viewModel = viewModel
        self.onSave = onSave
        let allowsEditing = viewModel.allowsLocalProfileEditing
        _displayName = State(initialValue: allowsEditing
            ? (MomoLocalProfileStore.displayName(for: member) ?? member.displayName)
            : member.displayName)
        _avatarPath = State(initialValue: allowsEditing
            ? (MomoLocalProfileStore.avatarPath(for: member) ?? member.avatarURL?.path ?? "")
            : (member.avatarURL?.path ?? ""))
        _presenceRaw = State(initialValue: (allowsEditing
            ? (MomoLocalProfileStore.presence(for: member) ?? member.presence)
            : member.presence).rawValue)
    }

    var body: some View {
        MomoSettingsScrollView {
            MomoSettingsSection(title: title, subtitle: copy.memberProfileSettingsSubtitle) {
                HStack(alignment: .top, spacing: 16) {
                    MomoSettingsAvatarMark(
                        text: initials,
                        imagePath: avatarPath,
                        shape: .circle,
                        size: 74
                    )
                    .overlay(alignment: .bottomTrailing) {
                        Circle()
                            .fill(previewPresenceColor)
                            .frame(width: 18, height: 18)
                            .overlay {
                                Circle().stroke(.regularMaterial, lineWidth: 3)
                            }
                            .offset(x: 2, y: 2)
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        MomoSettingsLabeledField(title: copy.displayName) {
                            TextField(copy.displayName, text: $displayName)
                                .textFieldStyle(.roundedBorder)
                                .font(.body)
                                .disabled(!viewModel.allowsLocalProfileEditing)
                        }

                        MomoSettingsInfoGrid(rows: [
                            (copy.handleLabel, "@\(member.handle)"),
                            (copy.status, localizedPresence),
                        ])

                        if member.isAgent, !member.normalizedCapabilities.isEmpty {
                            MomoAgentBadgeGroup(
                                capabilities: member.normalizedCapabilities,
                                maximumCapabilities: 3
                            )
                        }

                        HStack(spacing: 8) {
                            Button {
                                chooseProfileImage()
                            } label: {
                                Label(copy.chooseImage, systemImage: "photo")
                            }
                            .disabled(!viewModel.allowsLocalProfileEditing)

                            Button {
                                avatarPath = ""
                            } label: {
                                Label(copy.removeImage, systemImage: "arrow.uturn.backward")
                            }
                            .disabled(avatarPath.isEmpty || !viewModel.allowsLocalProfileEditing)
                        }
                    }
                }

                Divider().opacity(0.5)

                MomoSettingsControlRow(title: copy.status, systemImage: "circle.dashed") {
                    Picker(copy.status, selection: $presenceRaw) {
                        Text(copy.presenceOnline).tag(Presence.online.rawValue)
                        Text(copy.presenceWorking).tag(Presence.working.rawValue)
                        Text(copy.presenceAway).tag(Presence.away.rawValue)
                        Text(copy.presenceOffline).tag(Presence.offline.rawValue)
                    }
                    .pickerStyle(.menu)
                    .frame(maxWidth: 190)
                    .disabled(!viewModel.allowsLocalProfileEditing)
                }

                HStack {
                    Spacer()
                    Button {
                        saveProfileDraft()
                    } label: {
                        Label(copy.saveProfile, systemImage: "checkmark.circle")
                    }
                    .keyboardShortcut(.defaultAction)
                    .disabled(
                        displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            || !viewModel.allowsLocalProfileEditing
                    )
                }
            }

            if member.isAgent {
                MomoAgentCredentialManagementView(
                    copy: copy,
                    agent: member,
                    viewModel: viewModel,
                    presentation: .grouped,
                    onReveal: { credentialReveal = $0 }
                )
            }

            Label(
                viewModel.allowsLocalProfileEditing
                    ? copy.profileLocalDraftNote
                    : copy.serverManagedProfileNote,
                systemImage: viewModel.allowsLocalProfileEditing ? "info.circle" : "lock"
            )
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 4)
        }
        .sheet(item: $credentialReveal) { reveal in
            MomoAgentCredentialRevealSheet(copy: copy, reveal: reveal)
        }
        .onChange(of: member.displayName) { _, value in
            guard !viewModel.allowsLocalProfileEditing else { return }
            displayName = value
        }
        .onChange(of: member.avatarURL) { _, value in
            guard !viewModel.allowsLocalProfileEditing else { return }
            avatarPath = value?.path ?? ""
        }
        .onChange(of: member.presence) { _, value in
            guard !viewModel.allowsLocalProfileEditing else { return }
            presenceRaw = value.rawValue
        }
    }

    private var title: String {
        member.isAgent ? copy.agentProfile : copy.memberProfile
    }

    private var initials: String {
        guard let first = displayName.trimmingCharacters(in: .whitespacesAndNewlines).first else {
            return member.isAgent ? "A" : "M"
        }
        return String(first).uppercased()
    }

    private var presence: Presence {
        Presence(rawValue: presenceRaw) ?? .online
    }

    private var localizedPresence: String {
        copy.presenceTitle(presence)
    }

    private var previewPresenceColor: Color {
        switch presence {
        case .online:
            return MomoTheme.reversibleGreen
        case .working:
            return MomoTheme.costAmber
        case .away, .offline:
            return .secondary
        }
    }

    @MainActor
    private func chooseProfileImage() {
        if let path = MomoLocalAssetStore.chooseImage(named: "member-\(member.id.description)-avatar", title: copy.chooseImage) {
            avatarPath = path
        }
    }

    private func saveProfileDraft() {
        let avatarValue: String? = avatarPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "" : avatarPath
        MomoLocalProfileStore.save(member: member, displayName: displayName, avatarPath: avatarValue, presence: presence)
        onSave(displayName, avatarValue, presence)
    }
}

struct MomoEmptyProfileSelectionView: View {
    let copy: MomoWorkspaceCopy

    var body: some View {
        MomoSettingsScrollView {
            MomoSettingsSection(title: copy.memberProfile, subtitle: copy.memberProfileMissingSubtitle) {
                Label(copy.memberProfileMissingSubtitle, systemImage: "person.crop.circle.badge.questionmark")
                    .font(.callout.weight(.medium))
                    .foregroundStyle(.secondary)
            }
        }
    }
}

enum MomoDownloadsFolderAccess {
    static let pathKey = "momo.downloads.folderPath"
    private static let bookmarkKey = "momo.downloads.folderBookmark"

    static func resolvedURL(storedPath: String) -> URL {
        if let data = UserDefaults.standard.data(forKey: bookmarkKey) {
            var isStale = false
            if let url = try? URL(
                resolvingBookmarkData: data,
                options: .withSecurityScope,
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            ) {
                if isStale {
                    persist(url)
                }
                return url
            }
        }

        if !storedPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return URL(fileURLWithPath: storedPath)
        }
        return FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser
    }

    @discardableResult
    static func persist(_ url: URL) -> Bool {
        guard let bookmark = try? url.bookmarkData(
            options: .withSecurityScope,
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        ) else {
            return false
        }
        UserDefaults.standard.set(bookmark, forKey: bookmarkKey)
        UserDefaults.standard.set(url.path, forKey: pathKey)
        return true
    }

    @MainActor
    static func open(_ url: URL) {
        let didStartAccess = url.startAccessingSecurityScopedResource()
        defer {
            if didStartAccess {
                url.stopAccessingSecurityScopedResource()
            }
        }
        NSWorkspace.shared.open(url)
    }

    static func withAccess<T>(to folder: URL, _ operation: () throws -> T) rethrows -> T {
        let didStartAccess = folder.startAccessingSecurityScopedResource()
        defer {
            if didStartAccess {
                folder.stopAccessingSecurityScopedResource()
            }
        }
        return try operation()
    }
}

struct MomoDownloadHistoryRecord: Codable, Identifiable, Equatable {
    enum Outcome: String, Codable {
        case completed
        case failed
    }

    let id: UUID
    let fileName: String
    let filePath: String
    let recordedAt: Date
    let outcome: Outcome

    init(
        id: UUID = UUID(),
        fileName: String,
        filePath: String,
        recordedAt: Date = Date(),
        outcome: Outcome
    ) {
        self.id = id
        self.fileName = fileName
        self.filePath = filePath
        self.recordedAt = recordedAt
        self.outcome = outcome
    }
}

enum MomoDownloadHistoryStore {
    static let storageKey = "momo.downloads.history.v0"
    static let maximumRecordCount = 50

    static func load(defaults: UserDefaults = .standard) -> [MomoDownloadHistoryRecord] {
        guard let data = defaults.data(forKey: storageKey),
              let records = try? JSONDecoder().decode([MomoDownloadHistoryRecord].self, from: data) else {
            return []
        }
        return Array(records.sorted { $0.recordedAt > $1.recordedAt }.prefix(maximumRecordCount))
    }

    static func record(_ record: MomoDownloadHistoryRecord, defaults: UserDefaults = .standard) {
        var records = load(defaults: defaults).filter { $0.id != record.id }
        records.insert(record, at: 0)
        save(Array(records.prefix(maximumRecordCount)), defaults: defaults)
    }

    static func remove(_ id: UUID, defaults: UserDefaults = .standard) {
        save(load(defaults: defaults).filter { $0.id != id }, defaults: defaults)
    }

    private static func save(_ records: [MomoDownloadHistoryRecord], defaults: UserDefaults) {
        guard let data = try? JSONEncoder().encode(records) else { return }
        defaults.set(data, forKey: storageKey)
    }
}

enum MomoDownloadFileBoundary {
    static func managedFileURL(
        recordPath: String,
        downloadsFolder: URL,
        fileManager: FileManager = .default
    ) -> URL? {
        MomoDownloadsFolderAccess.withAccess(to: downloadsFolder) {
            validatedFileURL(
                recordPath: recordPath,
                downloadsFolder: downloadsFolder,
                fileManager: fileManager
            )
        }
    }

    private static func validatedFileURL(
        recordPath: String,
        downloadsFolder: URL,
        fileManager: FileManager
    ) -> URL? {
        let storedFileURL = URL(fileURLWithPath: recordPath).standardizedFileURL
        let storedFolderURL = downloadsFolder.standardizedFileURL
        let storedFolderPrefix = descendantPrefix(for: storedFolderURL)

        guard storedFileURL.path.hasPrefix(storedFolderPrefix),
              !containsSymlinkBelowRoot(
                  fileURL: storedFileURL,
                  folderURL: storedFolderURL,
                  fileManager: fileManager
              ) else {
            return nil
        }

        let resolvedFileURL = storedFileURL.resolvingSymlinksInPath().standardizedFileURL
        let resolvedFolderURL = storedFolderURL.resolvingSymlinksInPath().standardizedFileURL
        let folderPrefix = resolvedFolderURL.path.hasSuffix("/")
            ? resolvedFolderURL.path
            : resolvedFolderURL.path + "/"

        guard resolvedFileURL.path.hasPrefix(folderPrefix),
              let values = try? resolvedFileURL.resourceValues(
                  forKeys: [.isRegularFileKey, .isSymbolicLinkKey]
              ),
              values.isRegularFile == true,
              values.isSymbolicLink != true else {
            return nil
        }
        return resolvedFileURL
    }

    private static func descendantPrefix(for folderURL: URL) -> String {
        folderURL.path.hasSuffix("/") ? folderURL.path : folderURL.path + "/"
    }

    private static func containsSymlinkBelowRoot(
        fileURL: URL,
        folderURL: URL,
        fileManager: FileManager
    ) -> Bool {
        let folderComponents = folderURL.pathComponents
        let fileComponents = fileURL.pathComponents
        guard fileComponents.count > folderComponents.count else { return true }

        var currentURL = folderURL
        for component in fileComponents.dropFirst(folderComponents.count) {
            currentURL.appendPathComponent(component)
            guard let attributes = try? fileManager.attributesOfItem(atPath: currentURL.path) else {
                return true
            }
            if attributes[.type] as? FileAttributeType == .typeSymbolicLink {
                return true
            }
        }
        return false
    }

    @discardableResult
    static func delete(
        record: MomoDownloadHistoryRecord,
        downloadsFolder: URL,
        defaults: UserDefaults = .standard,
        fileManager: FileManager = .default
    ) -> Bool {
        do {
            try MomoDownloadsFolderAccess.withAccess(to: downloadsFolder) {
                guard let fileURL = validatedFileURL(
                    recordPath: record.filePath,
                    downloadsFolder: downloadsFolder,
                    fileManager: fileManager
                ) else {
                    throw CocoaError(.fileReadNoPermission)
                }
                try fileManager.removeItem(at: fileURL)
            }
        } catch {
            return false
        }

        MomoDownloadHistoryStore.remove(record.id, defaults: defaults)
        return true
    }
}

struct MomoDownloadsSettingsSurface: View {
    let copy: MomoWorkspaceCopy
    @AppStorage(MomoDownloadsFolderAccess.pathKey) private var downloadsFolderPath = ""
    @State private var downloadHistory = MomoDownloadHistoryStore.load()

    var body: some View {
        MomoSettingsScrollView {
            Label(copy.downloadsScopeNote, systemImage: "info.circle")
                .font(MomoTheme.Typography.supporting)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            MomoSettingsSection(title: copy.downloadFolder, subtitle: copy.downloadFolderSubtitle) {
                HStack(spacing: 12) {
                    Image(systemName: "folder")
                        .foregroundStyle(MomoTheme.humanAccent)
                    Text(downloadsFolder.path)
                        .font(MomoTheme.Typography.row.weight(.medium))
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                        .textSelection(.enabled)
                    Spacer(minLength: 8)
                }

                HStack(spacing: 8) {
                    Button {
                        openDownloadsFolder()
                    } label: {
                        Label(copy.openDownloadsFolder, systemImage: "arrow.up.forward.app")
                    }

                    Button {
                        chooseDownloadsFolder()
                    } label: {
                        Label(copy.changeDownloadFolder, systemImage: "folder.badge.gearshape")
                    }
                }
            }

            MomoSettingsSection(title: copy.downloadHistory, subtitle: copy.downloadsSubtitle) {
                if downloadHistory.isEmpty {
                    Label(copy.noDownloadHistory, systemImage: "clock")
                        .font(MomoTheme.Typography.row)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(downloadHistory) { record in
                        MomoDownloadHistoryRowView(
                            record: record,
                            copy: copy,
                            downloadsFolder: downloadsFolder,
                            didDelete: reloadDownloadHistory
                        )
                    }
                }
            }
        }
    }

    private var downloadsFolder: URL {
        MomoDownloadsFolderAccess.resolvedURL(storedPath: downloadsFolderPath)
    }

    @MainActor
    private func openDownloadsFolder() {
        MomoDownloadsFolderAccess.open(downloadsFolder)
    }

    @MainActor
    private func chooseDownloadsFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.title = copy.changeDownloadFolder
        guard panel.runModal() == .OK, let url = panel.url else {
            return
        }
        if MomoDownloadsFolderAccess.persist(url) {
            downloadsFolderPath = url.path
        }
    }

    private func reloadDownloadHistory() {
        downloadHistory = MomoDownloadHistoryStore.load()
    }
}

struct MomoDownloadsPanelView: View {
    let copy: MomoWorkspaceCopy
    let onDismiss: () -> Void
    @AppStorage(MomoDownloadsFolderAccess.pathKey) private var downloadsFolderPath = ""
    @State private var downloadHistory = MomoDownloadHistoryStore.load()

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: MomoTheme.Downloads.standardSpacing) {
                Image(systemName: "arrow.down.circle.fill")
                    .font(.title3)
                    .foregroundStyle(MomoTheme.humanAccent)
                Text(copy.appDownloads)
                    .font(MomoTheme.Typography.sectionHeader)
                Spacer()
                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .frame(
                            width: MomoTheme.ChannelHeader.actionSize,
                            height: MomoTheme.ChannelHeader.actionSize
                        )
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.cancelAction)
                .momoQuickTooltip(copy.dismiss)
                .accessibilityLabel(copy.dismiss)
            }
            .padding(MomoTheme.Downloads.edgeInset)

            Divider()

            VStack(alignment: .leading, spacing: MomoTheme.Downloads.sectionSpacing) {
                VStack(alignment: .leading, spacing: MomoTheme.Downloads.standardSpacing) {
                    Text(copy.downloadFolder)
                        .font(MomoTheme.Typography.supporting.weight(.semibold))
                        .foregroundStyle(.secondary)
                    HStack(spacing: MomoTheme.Downloads.standardSpacing) {
                        Image(systemName: "folder")
                            .foregroundStyle(MomoTheme.humanAccent)
                        Text(downloadsFolder.lastPathComponent)
                            .font(MomoTheme.Typography.row.weight(.medium))
                            .lineLimit(1)
                        Spacer()
                        Button {
                            openDownloadsFolder()
                        } label: {
                            Image(systemName: "arrow.up.forward.app")
                        }
                        .buttonStyle(.plain)
                        .momoQuickTooltip(copy.openDownloadsFolder)
                        .accessibilityLabel(copy.openDownloadsFolder)
                        Button {
                            chooseDownloadsFolder()
                        } label: {
                            Image(systemName: "ellipsis")
                        }
                        .buttonStyle(.plain)
                        .momoQuickTooltip(copy.changeDownloadFolder)
                        .accessibilityLabel(copy.changeDownloadFolder)
                    }
                    .padding(.horizontal, MomoTheme.Downloads.contentSpacing)
                    .frame(minHeight: MomoTheme.Downloads.rowMinimumHeight)
                    .background(
                        MomoTheme.Downloads.hoverBackground,
                        in: RoundedRectangle(cornerRadius: MomoTheme.Downloads.rowCornerRadius)
                    )
                }

                VStack(alignment: .leading, spacing: MomoTheme.Downloads.standardSpacing) {
                    Text(copy.downloadHistory)
                        .font(MomoTheme.Typography.supporting.weight(.semibold))
                        .foregroundStyle(.secondary)
                    if downloadHistory.isEmpty {
                        ContentUnavailableView {
                            Label(copy.noDownloadHistory, systemImage: "tray")
                        } description: {
                            Text(copy.downloadsScopeNote)
                        }
                        .frame(maxWidth: .infinity, minHeight: MomoTheme.Downloads.emptyStateMinimumHeight)
                    } else {
                        ScrollView {
                            LazyVStack(spacing: MomoTheme.Downloads.compactSpacing) {
                                ForEach(downloadHistory) { record in
                                    MomoDownloadHistoryRowView(
                                        record: record,
                                        copy: copy,
                                        downloadsFolder: downloadsFolder,
                                        didDelete: reloadDownloadHistory
                                    )
                                }
                            }
                        }
                        .frame(maxHeight: MomoTheme.Downloads.historyMaximumHeight)
                    }
                }
            }
            .padding(MomoTheme.Downloads.edgeInset)
        }
        .frame(width: MomoTheme.Downloads.popoverWidth)
        .frame(maxHeight: MomoTheme.Downloads.popoverMaximumHeight)
        .momoSurface(.card, cornerRadius: MomoTheme.cornerLarge)
        .onAppear(perform: reloadDownloadHistory)
    }

    private var downloadsFolder: URL {
        MomoDownloadsFolderAccess.resolvedURL(storedPath: downloadsFolderPath)
    }

    @MainActor
    private func openDownloadsFolder() {
        MomoDownloadsFolderAccess.open(downloadsFolder)
    }

    @MainActor
    private func chooseDownloadsFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.title = copy.changeDownloadFolder
        guard panel.runModal() == .OK, let url = panel.url else { return }
        if MomoDownloadsFolderAccess.persist(url) {
            downloadsFolderPath = url.path
        }
    }

    private func reloadDownloadHistory() {
        downloadHistory = MomoDownloadHistoryStore.load()
    }
}

struct MomoUpdateStatusSurface: View {
    let copy: MomoWorkspaceCopy
    private let status = MomoMacUpdateChannelStatus.fromEnvironment()

    var body: some View {
        MomoSettingsScrollView {
            MomoSettingsSection(title: localizedUpdateTitle(status.state, copy: copy), subtitle: localizedUpdateDetail(status, copy: copy)) {
                HStack(alignment: .center, spacing: 16) {
                    Image(systemName: status.state.systemImage)
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(updateTint)
                        .frame(width: 44, height: 44)
                        .background(updateTint.opacity(0.13), in: RoundedRectangle(cornerRadius: 14, style: .continuous))

                    VStack(alignment: .leading, spacing: 4) {
                        Text(localizedUpdateTitle(status.state, copy: copy))
                            .font(MomoTheme.Typography.screenTitle)
                        Text(copy.updateChannelLabel(status.channel))
                            .font(MomoTheme.Typography.supporting.weight(.medium))
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                }

                MomoSettingsInfoGrid(rows: [
                    (copy.currentVersion, status.currentVersion.displayLabel),
                    (copy.availableVersion, status.availableVersion?.displayLabel ?? copy.noManifest),
                    (copy.manifest, status.manifestSource?.displayLabel ?? copy.notConfigured),
                    (copy.downloads, status.manifest?.downloadURL?.absoluteString ?? copy.notAvailable),
                ])

                if let manifest = status.manifest, status.hasUpdate {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(manifest.summary)
                            .font(MomoTheme.Typography.row)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)

                        HStack(spacing: 8) {
                            if let downloadURL = manifest.downloadURL {
                                Link(destination: downloadURL) {
                                    Label(copy.openDownload, systemImage: "arrow.down.circle.fill")
                                }
                            }
                            if let releaseNotesURL = manifest.releaseNotesURL {
                                Link(destination: releaseNotesURL) {
                                    Label(copy.releaseNotes, systemImage: "doc.plaintext")
                                }
                            }
                        }
                    }
                }
            }

            if !status.diagnostics.isEmpty {
                MomoSettingsSection(title: copy.diagnostics) {
                    ForEach(status.diagnostics, id: \.self) { diagnostic in
                        Label(diagnostic, systemImage: "exclamationmark.triangle")
                            .font(MomoTheme.Typography.supporting)
                            .foregroundStyle(MomoTheme.irreversibleRed)
                            .textSelection(.enabled)
                    }
                }
            }
        }
    }

    private var updateTint: Color {
        switch status.state {
        case .notConfigured:
            return .secondary
        case .upToDate:
            return MomoTheme.reversibleGreen
        case .updateAvailable:
            return MomoTheme.costAmber
        case .failed:
            return MomoTheme.irreversibleRed
        }
    }
}

// MARK: - Channel settings

struct MomoChannelPresentation: Equatable {
    static let maximumNameLength = 80
    static let maximumTopicLength = 280

    var name: String
    var topic: String?

    init(channel: Channel) {
        name = channel.name ?? "DM"
        topic = channel.topic
    }

    init(name: String, topic: String?) {
        self.name = name
        self.topic = topic
    }

    var normalized: MomoChannelPresentation? {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty, trimmedName.count <= Self.maximumNameLength else {
            return nil
        }
        let trimmedTopic = topic?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard trimmedTopic.count <= Self.maximumTopicLength else {
            return nil
        }
        return MomoChannelPresentation(
            name: trimmedName,
            topic: trimmedTopic.isEmpty ? nil : trimmedTopic
        )
    }
}

enum MomoLocalChannelPresentationStore {
    static let didChangeNotification = Notification.Name("momo.channelPresentation.didChange")

    static func presentation(for channel: Channel) -> MomoChannelPresentation {
        guard channel.kind != .dm else {
            return MomoChannelPresentation(channel: channel)
        }
        let defaults = UserDefaults.standard
        let storedName = defaults.string(forKey: nameKey(channel.id))
        let storedTopic = defaults.string(forKey: topicKey(channel.id))
        let resolvedName: String
        if let storedName, !storedName.isEmpty {
            resolvedName = storedName
        } else {
            resolvedName = channel.name ?? "channel"
        }
        return MomoChannelPresentation(
            name: resolvedName,
            topic: storedTopic ?? channel.topic
        )
    }

    static func save(_ presentation: MomoChannelPresentation, for channel: Channel) {
        guard channel.kind != .dm, let normalized = presentation.normalized else { return }
        let defaults = UserDefaults.standard
        defaults.set(normalized.name, forKey: nameKey(channel.id))
        if let topic = normalized.topic {
            defaults.set(topic, forKey: topicKey(channel.id))
        } else {
            defaults.removeObject(forKey: topicKey(channel.id))
        }
        NotificationCenter.default.post(name: didChangeNotification, object: channel.id.description)
    }

    static func displayName(for channel: Channel) -> String {
        presentation(for: channel).name
    }

    private static func nameKey(_ channel: ChannelID) -> String {
        "momo.channel.\(channel.description).displayName"
    }

    private static func topicKey(_ channel: ChannelID) -> String {
        "momo.channel.\(channel.description).topic"
    }
}

enum MomoChannelSettingsTab: String, CaseIterable, Identifiable {
    case general
    case members
    case integrations

    var id: String { rawValue }
}

struct MomoChannelSettingsSheet: View {
    let copy: MomoWorkspaceCopy
    let channel: Channel
    @ObservedObject var viewModel: ChatViewModel
    let onSavePresentation: (MomoChannelPresentation) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.momoWebhookContext) private var webhookContext
    @State private var selectedTab: MomoChannelSettingsTab = .general
    @State private var channelName: String
    @State private var channelTopic: String
    @State private var savedLocally = false
    @State private var integrationNavigationLocked = false
    private let canManageMembers: Bool
    private let canManageIntegrations: Bool

    init(
        copy: MomoWorkspaceCopy,
        channel: Channel,
        presentation: MomoChannelPresentation,
        viewModel: ChatViewModel,
        initialTab: MomoChannelSettingsTab = .general,
        onSavePresentation: @escaping (MomoChannelPresentation) -> Void
    ) {
        self.copy = copy
        self.channel = channel
        self.viewModel = viewModel
        self.onSavePresentation = onSavePresentation
        let canManageMembers = MomoChannelActionPolicy.canManageMembers(
            in: channel,
            canManageWorkspace: viewModel.canManageWorkspace
        )
        self.canManageMembers = canManageMembers
        let canManageIntegrations = viewModel.canManageWorkspace
        self.canManageIntegrations = canManageIntegrations
        let resolvedInitialTab: MomoChannelSettingsTab
        if initialTab == .members && !canManageMembers
            || initialTab == .integrations && !canManageIntegrations {
            resolvedInitialTab = .general
        } else {
            resolvedInitialTab = initialTab
        }
        _selectedTab = State(initialValue: resolvedInitialTab)
        _channelName = State(initialValue: presentation.name)
        _channelTopic = State(initialValue: presentation.topic ?? "")
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: MomoTheme.ChannelHeader.contentSpacing) {
                Image(systemName: channel.kind == .dm ? "person.2.fill" : "number")
                    .momoTypography(.screenTitle)
                    .foregroundStyle(.secondary)
                    .frame(
                        width: MomoTheme.ChannelHeader.actionSize,
                        height: MomoTheme.ChannelHeader.actionSize
                    )

                VStack(alignment: .leading, spacing: MomoTheme.ChannelHeader.compactSpacing) {
                    Text(copy.channelSettings)
                        .momoTypography(.screenTitle)
                    Text(copy.channelSettingsSubtitle)
                        .momoTypography(.supporting)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: MomoTheme.ChannelHeader.standardSpacing)

                Button(copy.dismiss) {
                    dismiss()
                }
                .keyboardShortcut(.cancelAction)
                .disabled(integrationNavigationLocked)
            }
            .padding(MomoTheme.ChannelHeader.edgeInset)

            Divider()

            VStack(spacing: MomoTheme.ChannelHeader.standardSpacing) {
                Picker(copy.channelSettings, selection: $selectedTab) {
                    Text(copy.general).tag(MomoChannelSettingsTab.general)
                    if canManageMembers {
                        Text(copy.members).tag(MomoChannelSettingsTab.members)
                    }
                    if canManageIntegrations {
                        Text(copy.integrations).tag(MomoChannelSettingsTab.integrations)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .disabled(integrationNavigationLocked)

                Group {
                    switch selectedTab {
                    case .general:
                        generalSettings
                    case .members:
                        if canManageMembers {
                            memberSettings
                        } else {
                            generalSettings
                        }
                    case .integrations:
                        if canManageIntegrations {
                            integrationSettings
                        } else {
                            generalSettings
                        }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .padding(MomoTheme.ChannelHeader.standardSpacing)
        }
        .frame(
            width: MomoTheme.ChannelHeader.settingsSheetWidth,
            height: MomoTheme.ChannelHeader.settingsSheetHeight
        )
        .interactiveDismissDisabled(integrationNavigationLocked)
    }

    private var generalSettings: some View {
        Form {
            Section(copy.channelIdentity) {
                TextField(copy.channelNamePlaceholder, text: channelNameBinding)
                    .momoTypography(.row)
                    .disabled(channel.kind == .dm)

                TextField(copy.channelTopicPlaceholder, text: channelTopicBinding, axis: .vertical)
                    .momoTypography(.row)
                    .lineLimit(2...4)
                    .disabled(channel.kind == .dm)

                LabeledContent(copy.characterCount) {
                    Text("\(channelTopic.count)/\(MomoChannelPresentation.maximumTopicLength)")
                        .momoTypography(.metadata)
                        .foregroundStyle(channelTopic.count > MomoChannelPresentation.maximumTopicLength ? MomoTheme.irreversibleRed : .secondary)
                        .monospacedDigit()
                }
            }

            if viewModel.supportsChannelNotificationSettings, !channel.isArchived {
                Section(copy.channelNotifications) {
                    Toggle(isOn: channelMuteBinding) {
                        VStack(alignment: .leading, spacing: MomoTheme.ChannelHeader.compactSpacing) {
                            Text(copy.muteChannel)
                                .momoTypography(.row)
                            Text(copy.channelMuteDescription)
                                .momoTypography(.supporting)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .disabled(viewModel.channelMuteMutationIds.contains(channel.id))

                    if viewModel.channelMuteMutationIds.contains(channel.id) {
                        HStack(spacing: MomoTheme.ChannelHeader.compactSpacing) {
                            ProgressView()
                                .controlSize(.small)
                            Text(copy.updatingChannelNotifications)
                                .momoTypography(.supporting)
                                .foregroundStyle(.secondary)
                        }
                    }

                    if let error = viewModel.channelNotificationErrors[channel.id] {
                        Label(error.message(copy: copy), systemImage: "exclamationmark.triangle")
                            .momoTypography(.supporting)
                            .foregroundStyle(MomoTheme.costAmber)
                    }
                }
            }

            Section {
                Label(copy.channelLocalDraftNote, systemImage: "info.circle")
                    .momoTypography(.supporting)
                    .foregroundStyle(.secondary)

                if savedLocally {
                    Label(copy.channelSettingsSavedLocally, systemImage: "checkmark.circle.fill")
                        .momoTypography(.supportingEmphasized)
                        .foregroundStyle(MomoTheme.reversibleGreen)
                }

                HStack {
                    Spacer()
                    Button(copy.saveChannelSettings) {
                        savePresentation()
                    }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(channel.kind == .dm || draftPresentation.normalized == nil)
                }
            }
        }
        .formStyle(.grouped)
    }

    private var memberSettings: some View {
        VStack(alignment: .leading, spacing: MomoTheme.ChannelHeader.standardSpacing) {
            VStack(alignment: .leading, spacing: MomoTheme.ChannelHeader.compactSpacing) {
                Text(copy.channelMemberManagement)
                    .momoTypography(.sectionHeader)
                Text(copy.channelMemberManagementSubtitle)
                    .momoTypography(.supporting)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, MomoTheme.ChannelHeader.standardSpacing)

            if activeWorkspaceMembers.isEmpty {
                Label(copy.noWorkspaceMembers, systemImage: "person.2.slash")
                    .momoTypography(.row)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(activeWorkspaceMembers) { member in
                    Toggle(isOn: membershipBinding(for: member)) {
                        HStack(spacing: MomoTheme.ChannelHeader.standardSpacing) {
                            Image(systemName: member.isAgent ? "cpu" : "person")
                                .foregroundStyle(member.isAgent ? MomoTheme.agentAccent : .secondary)
                                .frame(width: MomoTheme.ChannelHeader.iconSize)
                            VStack(alignment: .leading, spacing: MomoTheme.ChannelHeader.compactSpacing) {
                                Text(member.displayName)
                                    .momoTypography(.emphasizedRow)
                                Text("@\(member.handle)")
                                    .momoTypography(.supporting)
                                    .foregroundStyle(.secondary)
                            }
                            if viewModel.channelMemberMutationIds.contains(member.id) {
                                Spacer()
                                ProgressView()
                                    .controlSize(.small)
                            }
                        }
                    }
                    .toggleStyle(.checkbox)
                    .disabled(viewModel.channelMemberMutationIds.contains(member.id))
                }
                .listStyle(.inset)
            }

            if viewModel.connectionIssue != nil {
                Label(copy.channelMembershipUnavailable, systemImage: "wifi.exclamationmark")
                    .momoTypography(.supporting)
                    .foregroundStyle(MomoTheme.costAmber)
                    .padding(.horizontal, MomoTheme.ChannelHeader.standardSpacing)
            }
        }
        .padding(.vertical, MomoTheme.ChannelHeader.standardSpacing)
    }

    private var integrationSettings: some View {
        MomoWebhookSettingsView(
            language: copy.language,
            channel: channel,
            context: webhookContext,
            navigationLocked: $integrationNavigationLocked
        )
    }

    private var draftPresentation: MomoChannelPresentation {
        MomoChannelPresentation(name: channelName, topic: channelTopic)
    }

    private var channelNameBinding: Binding<String> {
        Binding(
            get: { channelName },
            set: { newValue in
                channelName = newValue
                savedLocally = false
            }
        )
    }

    private var channelTopicBinding: Binding<String> {
        Binding(
            get: { channelTopic },
            set: { newValue in
                channelTopic = newValue
                savedLocally = false
            }
        )
    }

    private var channelMuteBinding: Binding<Bool> {
        Binding(
            get: { viewModel.isChannelMuted(channel.id) },
            set: { muted in
                Task { await viewModel.setChannelMuted(channel.id, muted: muted) }
            }
        )
    }

    private var activeWorkspaceMembers: [Member] {
        viewModel.members
            .filter { $0.status == .active }
            .sorted { lhs, rhs in
                lhs.displayName.localizedCaseInsensitiveCompare(rhs.displayName) == .orderedAscending
            }
    }

    private func membershipBinding(for member: Member) -> Binding<Bool> {
        Binding(
            get: { viewModel.isMember(member.id, in: channel.id) },
            set: { shouldBeMember in
                Task {
                    if shouldBeMember {
                        await viewModel.addMember(member.id, to: channel.id)
                    } else {
                        await viewModel.removeMember(member.id, from: channel.id)
                    }
                }
            }
        )
    }

    private func savePresentation() {
        guard let normalized = draftPresentation.normalized else { return }
        MomoLocalChannelPresentationStore.save(normalized, for: channel)
        channelName = normalized.name
        channelTopic = normalized.topic ?? ""
        savedLocally = true
        onSavePresentation(normalized)
    }
}

// MARK: - Shared settings components

private struct MomoSettingsScrollView<Content: View>: View {
    @ViewBuilder var content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                content
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct MomoSettingsSection<Content: View>: View {
    let title: String
    var subtitle: String?
    @ViewBuilder var content: Content

    init(title: String, subtitle: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.subtitle = subtitle
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(MomoTheme.Typography.screenTitle)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(MomoTheme.Typography.supporting.weight(.medium))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            VStack(alignment: .leading, spacing: 12) {
                content
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
    }
}

private struct MomoSettingsLabeledField<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    init(title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(MomoTheme.Typography.supporting.weight(.semibold))
                .foregroundStyle(.secondary)
            content
        }
    }
}

private struct MomoSettingsControlRow<Content: View>: View {
    let title: String
    let systemImage: String
    @ViewBuilder var content: Content

    init(title: String, systemImage: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.systemImage = systemImage
        self.content = content()
    }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Label(title, systemImage: systemImage)
                .font(MomoTheme.Typography.row.weight(.medium))
            Spacer(minLength: 12)
            content
        }
    }
}

private struct MomoSettingsInfoGrid: View {
    let rows: [(String, String)]

    var body: some View {
        Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 8) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                GridRow {
                    Text(row.0)
                        .font(MomoTheme.Typography.supporting.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(row.1)
                        .font(MomoTheme.Typography.supporting.weight(.medium))
                        .foregroundStyle(.primary)
                        .textSelection(.enabled)
                        .lineLimit(3)
                }
            }
        }
    }
}

private struct MomoDownloadHistoryRowView: View {
    let record: MomoDownloadHistoryRecord
    let copy: MomoWorkspaceCopy
    let downloadsFolder: URL
    let didDelete: () -> Void
    @State private var showsDeleteFailure = false

    var body: some View {
        let availableFileURL = managedFileURL

        HStack(alignment: .top, spacing: 12) {
            Image(systemName: record.outcome == .completed ? "doc.fill" : "exclamationmark.triangle.fill")
                .font(MomoTheme.Typography.row.weight(.semibold))
                .foregroundStyle(record.outcome == .completed ? MomoTheme.reversibleGreen : MomoTheme.irreversibleRed)
                .frame(width: 24, height: 24)

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(record.fileName)
                        .font(MomoTheme.Typography.row.weight(.semibold))
                        .lineLimit(1)
                    Text(record.outcome == .completed ? copy.downloadCompleted : copy.downloadFailed)
                        .font(MomoTheme.Typography.metadata.weight(.bold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .foregroundStyle(record.outcome == .completed ? MomoTheme.reversibleGreen : MomoTheme.irreversibleRed)
                        .background(
                            (record.outcome == .completed ? MomoTheme.reversibleGreen : MomoTheme.irreversibleRed).opacity(0.13),
                            in: Capsule()
                        )
                }
                Text(record.recordedAt.formatted(date: .abbreviated, time: .shortened))
                    .font(MomoTheme.Typography.supporting.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Menu {
                Button(copy.openDownload) {
                    openRecord()
                }
                .disabled(availableFileURL == nil)

                Button(copy.showInFinder) {
                    revealRecord()
                }
                .disabled(availableFileURL == nil)

                Divider()

                Button(copy.deleteDownload, role: .destructive) {
                    deleteRecord()
                }
                .disabled(availableFileURL == nil)
            } label: {
                Image(systemName: "ellipsis")
                    .frame(width: MomoTheme.ChannelHeader.actionSize, height: MomoTheme.ChannelHeader.actionSize)
            }
            .menuStyle(.borderlessButton)
            .help(copy.downloadActions)
            .accessibilityLabel(copy.downloadActions)
        }
        .padding(.horizontal, MomoTheme.Downloads.contentSpacing)
        .frame(minHeight: MomoTheme.Downloads.rowMinimumHeight)
        .background(
            MomoTheme.Downloads.hoverBackground,
            in: RoundedRectangle(cornerRadius: MomoTheme.Downloads.rowCornerRadius)
        )
        .alert(copy.downloadDeleteFailedTitle, isPresented: $showsDeleteFailure) {
            Button(copy.done, role: .cancel) {}
        } message: {
            Text(copy.downloadDeleteFailedMessage)
        }
    }

    @MainActor
    private func openRecord() {
        guard let fileURL = managedFileURL else { return }
        _ = MomoDownloadsFolderAccess.withAccess(to: downloadsFolder) {
            NSWorkspace.shared.open(fileURL)
        }
    }

    @MainActor
    private func revealRecord() {
        guard let fileURL = managedFileURL else { return }
        MomoDownloadsFolderAccess.withAccess(to: downloadsFolder) {
            NSWorkspace.shared.activateFileViewerSelecting([fileURL])
        }
    }

    private func deleteRecord() {
        if MomoDownloadFileBoundary.delete(
            record: record,
            downloadsFolder: downloadsFolder
        ) {
            didDelete()
        } else {
            showsDeleteFailure = true
        }
    }

    private var managedFileURL: URL? {
        MomoDownloadFileBoundary.managedFileURL(
            recordPath: record.filePath,
            downloadsFolder: downloadsFolder
        )
    }
}

private struct MomoSettingsAvatarMark: View {
    enum ShapeStyle {
        case circle
        case rounded
    }

    let text: String
    let imagePath: String
    let shape: ShapeStyle
    let size: CGFloat

    var body: some View {
        switch shape {
        case .circle:
            avatarContent
                .clipShape(Circle())
                .overlay {
                    Circle()
                        .stroke(MomoTheme.subtleBorder, lineWidth: 1)
                }
        case .rounded:
            avatarContent
                .clipShape(RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                        .stroke(MomoTheme.subtleBorder, lineWidth: 1)
                }
        }
    }

    @ViewBuilder
    private var avatarContent: some View {
        if let image = avatarImage {
            Image(nsImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: size, height: size)
        } else {
            Text(visibleText)
                .font(.largeTitle.weight(.bold))
                .foregroundStyle(MomoTheme.onAccent)
                .frame(width: size, height: size)
                .background(MomoTheme.humanAccent)
        }
    }

    private var visibleText: String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = trimmed.first else { return "m" }
        return String(first).lowercased()
    }

    private var avatarImage: NSImage? {
        guard !imagePath.isEmpty else { return nil }
        return MomoAvatarImageCache.image(atPath: imagePath)
    }
}

private enum MomoLocalAssetStore {
    @MainActor
    static func chooseImage(named name: String, title: String) -> String? {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.title = title

        guard panel.runModal() == .OK, let source = panel.url else {
            return nil
        }

        do {
            let directory = try appSupportAvatarDirectory()
            let destination = directory.appendingPathComponent("\(name)-\(UUID().uuidString).png")
            if let png = normalizedPNGData(from: source) {
                try png.write(to: destination, options: .atomic)
                if let image = NSImage(data: png) {
                    MomoAvatarImageCache.store(image, atPath: destination.path)
                }
            } else {
                try FileManager.default.copyItem(at: source, to: destination)
            }
            return destination.path
        } catch {
            NSSound.beep()
            return nil
        }
    }

    private static func appSupportAvatarDirectory() throws -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support", isDirectory: true)
        let directory = base.appendingPathComponent("momo/avatars", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    @MainActor
    private static func normalizedPNGData(from source: URL, maxPixelSize: CGFloat = 512) -> Data? {
        guard let image = NSImage(contentsOf: source) else { return nil }
        let sourceSize = image.size
        guard sourceSize.width > 0, sourceSize.height > 0 else { return nil }
        let scale = min(1, maxPixelSize / max(sourceSize.width, sourceSize.height))
        let targetSize = NSSize(width: max(1, sourceSize.width * scale), height: max(1, sourceSize.height * scale))
        guard let bitmap = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: Int(targetSize.width.rounded(.up)),
            pixelsHigh: Int(targetSize.height.rounded(.up)),
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else {
            return nil
        }
        bitmap.size = targetSize
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        image.draw(
            in: NSRect(origin: .zero, size: targetSize),
            from: NSRect(origin: .zero, size: sourceSize),
            operation: .copy,
            fraction: 1
        )
        NSGraphicsContext.restoreGraphicsState()
        return bitmap.representation(using: .png, properties: [:])
    }
}

enum MomoLocalProfileStore {
    static func displayName(for member: Member) -> String? {
        value(for: displayNameKey(member), fallback: member.isAgent && isHermes(member) ? "momo.dogfood.hermes.displayName" : nil)
    }

    static func avatarPath(for member: Member) -> String? {
        value(for: avatarPathKey(member), fallback: member.isAgent && isHermes(member) ? "momo.dogfood.hermes.avatarPath" : nil)
    }

    static func presence(for member: Member) -> Presence? {
        value(for: presenceKey(member), fallback: nil).flatMap(Presence.init(rawValue:))
    }

    static func save(member: Member, displayName: String, avatarPath: String?, presence: Presence) {
        let defaults = UserDefaults.standard
        let trimmedName = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        defaults.set(trimmedName, forKey: displayNameKey(member))
        if member.isAgent && isHermes(member) {
            defaults.set(trimmedName, forKey: "momo.dogfood.hermes.displayName")
        }

        let trimmedPath = avatarPath?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if trimmedPath.isEmpty {
            defaults.removeObject(forKey: avatarPathKey(member))
            if member.isAgent && isHermes(member) {
                defaults.removeObject(forKey: "momo.dogfood.hermes.avatarPath")
            }
        } else {
            defaults.set(trimmedPath, forKey: avatarPathKey(member))
            if member.isAgent && isHermes(member) {
                defaults.set(trimmedPath, forKey: "momo.dogfood.hermes.avatarPath")
            }
        }
        defaults.set(presence.rawValue, forKey: presenceKey(member))
    }

    private static func value(for key: String, fallback: String?) -> String? {
        let primary = UserDefaults.standard.string(forKey: key)?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let primary, !primary.isEmpty {
            return primary
        }
        if let fallback {
            let secondary = UserDefaults.standard.string(forKey: fallback)?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let secondary, !secondary.isEmpty {
                return secondary
            }
        }
        return nil
    }

    private static func displayNameKey(_ member: Member) -> String {
        "momo.member.\(member.id.description).displayName"
    }

    private static func avatarPathKey(_ member: Member) -> String {
        "momo.member.\(member.id.description).avatarPath"
    }

    private static func presenceKey(_ member: Member) -> String {
        "momo.member.\(member.id.description).presence"
    }

    private static func isHermes(_ member: Member) -> Bool {
        let identity = "\(member.displayName) \(member.handle)".lowercased()
        return identity.contains("hermes") || identity.contains("에르메스")
    }
}

private func localizedUpdateTitle(_ state: MomoMacUpdateState, copy: MomoWorkspaceCopy) -> String {
    switch state {
    case .notConfigured:
        return copy.updatesNotConfigured
    case .upToDate:
        return copy.latestVersion
    case .updateAvailable:
        return copy.updateAvailable
    case .failed:
        return copy.updateCheckFailed
    }
}

private func localizedUpdateDetail(_ status: MomoMacUpdateChannelStatus, copy: MomoWorkspaceCopy) -> String {
    switch status.state {
    case .notConfigured:
        return copy.updateStatusNotConfiguredDetail
    case .upToDate:
        return copy.updateStatusUpToDateDetail
    case .updateAvailable:
        if let available = status.availableVersion?.displayLabel {
            return "\(available) · \(copy.updateStatusAvailableDetail)"
        }
        return copy.updateStatusAvailableDetail
    case .failed:
        if let first = status.diagnostics.first {
            return "\(copy.updateStatusFailedDetail) \(first)"
        }
        return copy.updateStatusFailedDetail
    }
}
