import SwiftUI
import AppKit
import UniformTypeIdentifiers
import MomoCore

// MARK: - Dogfood account/settings surfaces

struct MomoProfileSettingsSurface: View {
    let copy: MomoWorkspaceCopy
    let summary: MomoServerSessionSummary?
    @AppStorage("momo.profile.displayName") private var displayNameDraft = ""
    @AppStorage("momo.profile.avatarPath") private var avatarPath = ""

    var body: some View {
        MomoSettingsScrollView {
            MomoSettingsSection(title: copy.profile, subtitle: copy.profileSettingsSubtitle) {
                HStack(alignment: .top, spacing: 16) {
                    MomoSettingsAvatarMark(
                        text: profileInitials,
                        imagePath: avatarPath,
                        shape: .circle,
                        size: 74
                    )

                    VStack(alignment: .leading, spacing: 12) {
                        MomoSettingsLabeledField(title: copy.displayName) {
                            TextField(copy.displayName, text: displayNameBinding)
                                .textFieldStyle(.roundedBorder)
                                .font(MomoTheme.Typography.row)
                        }

                        HStack(spacing: 8) {
                            Button {
                                chooseProfileImage()
                            } label: {
                                Label(copy.chooseImage, systemImage: "photo")
                            }

                            Button {
                                avatarPath = ""
                            } label: {
                                Label(copy.removeImage, systemImage: "arrow.uturn.backward")
                            }
                            .disabled(avatarPath.isEmpty)
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

            Label(copy.profileLocalDraftNote, systemImage: "info.circle")
                .font(MomoTheme.Typography.supporting)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 4)
        }
    }

    private var displayNameBinding: Binding<String> {
        Binding(
            get: {
                let trimmed = displayNameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? fallbackDisplayName : displayNameDraft
            },
            set: { newValue in
                displayNameDraft = newValue
            }
        )
    }

    private var effectiveDisplayName: String {
        let trimmed = displayNameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? fallbackDisplayName : trimmed
    }

    private var fallbackDisplayName: String {
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

struct MomoWorkspaceSettingsSurface: View {
    let copy: MomoWorkspaceCopy
    @AppStorage("momo.server.displayName") private var serverDisplayName = "momo"
    @AppStorage("momo.server.iconText") private var serverIconText = "m"
    @AppStorage("momo.server.iconPath") private var serverIconPath = ""
    @AppStorage("momo.server.agentInviteRequiresApproval") private var agentInviteRequiresApproval = true
    @AppStorage("momo.server.memberInvitePolicy") private var memberInvitePolicy = "admins"

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
                    .frame(maxWidth: 180)
                }

                Toggle(copy.agentInviteRequiresApproval, isOn: $agentInviteRequiresApproval)
                    .font(MomoTheme.Typography.row.weight(.medium))
            }

            Label(copy.serverSettingsLocalDraftNote, systemImage: "info.circle")
                .font(MomoTheme.Typography.supporting)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 4)
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
        _displayName = State(initialValue: MomoLocalProfileStore.displayName(for: member) ?? member.displayName)
        _avatarPath = State(initialValue: MomoLocalProfileStore.avatarPath(for: member) ?? member.avatarURL?.path ?? "")
        _presenceRaw = State(initialValue: (MomoLocalProfileStore.presence(for: member) ?? member.presence).rawValue)
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

                            Button {
                                avatarPath = ""
                            } label: {
                                Label(copy.removeImage, systemImage: "arrow.uturn.backward")
                            }
                            .disabled(avatarPath.isEmpty)
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
                }

                HStack {
                    Spacer()
                    Button {
                        saveProfileDraft()
                    } label: {
                        Label(copy.saveProfile, systemImage: "checkmark.circle")
                    }
                    .keyboardShortcut(.defaultAction)
                    .disabled(displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
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

            Label(copy.profileLocalDraftNote, systemImage: "info.circle")
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 4)
        }
        .sheet(item: $credentialReveal) { reveal in
            MomoAgentCredentialRevealSheet(copy: copy, reveal: reveal)
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

struct MomoDownloadsSettingsSurface: View {
    let copy: MomoWorkspaceCopy
    @AppStorage("momo.downloads.folderPath") private var downloadsFolderPath = ""
    private let updateStatus = MomoMacUpdateChannelStatus.fromEnvironment()

    var body: some View {
        MomoSettingsScrollView {
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
                let rows = downloadHistoryRows
                if rows.isEmpty {
                    Label(copy.noDownloadHistory, systemImage: "clock")
                        .font(MomoTheme.Typography.row)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(rows) { row in
                        MomoDownloadHistoryRowView(row: row)
                    }
                }
            }
        }
    }

    private var downloadsFolder: URL {
        if !downloadsFolderPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return URL(fileURLWithPath: downloadsFolderPath)
        }
        return FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser
    }

    private var downloadHistoryRows: [MomoDownloadHistoryRow] {
        var rows: [MomoDownloadHistoryRow] = [
            MomoDownloadHistoryRow(
                title: copy.updates,
                detail: localizedUpdateDetail(updateStatus, copy: copy),
                state: updateStatus.state == .failed ? copy.downloadCheckFailed : copy.downloadCheckSucceeded,
                systemImage: updateStatus.state == .failed ? "exclamationmark.triangle.fill" : "checkmark.circle.fill",
                tint: updateStatus.state == .failed ? MomoTheme.irreversibleRed : MomoTheme.reversibleGreen
            )
        ]

        if let manifest = updateStatus.manifest, let downloadURL = manifest.downloadURL {
            rows.append(
                MomoDownloadHistoryRow(
                    title: manifest.availableVersion.displayLabel,
                    detail: downloadURL.absoluteString,
                    state: updateStatus.canOpenDownload ? copy.downloadReady : copy.downloadUnavailable,
                    systemImage: updateStatus.canOpenDownload ? "tray.and.arrow.down.fill" : "tray",
                    tint: updateStatus.canOpenDownload ? MomoTheme.costAmber : .secondary
                )
            )
        } else if updateStatus.state != .notConfigured {
            rows.append(
                MomoDownloadHistoryRow(
                    title: copy.availableVersion,
                    detail: copy.notAvailable,
                    state: copy.downloadUnavailable,
                    systemImage: "tray",
                    tint: .secondary
                )
            )
        }

        return rows
    }

    @MainActor
    private func openDownloadsFolder() {
        NSWorkspace.shared.open(downloadsFolder)
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
        downloadsFolderPath = url.path
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

private enum MomoChannelSettingsTab: String, CaseIterable, Identifiable {
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
    @State private var selectedTab: MomoChannelSettingsTab = .general
    @State private var channelName: String
    @State private var channelTopic: String
    @State private var savedLocally = false

    init(
        copy: MomoWorkspaceCopy,
        channel: Channel,
        presentation: MomoChannelPresentation,
        viewModel: ChatViewModel,
        onSavePresentation: @escaping (MomoChannelPresentation) -> Void
    ) {
        self.copy = copy
        self.channel = channel
        self.viewModel = viewModel
        self.onSavePresentation = onSavePresentation
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
            }
            .padding(MomoTheme.ChannelHeader.edgeInset)

            Divider()

            VStack(spacing: MomoTheme.ChannelHeader.standardSpacing) {
                Picker(copy.channelSettings, selection: $selectedTab) {
                    Text(copy.general).tag(MomoChannelSettingsTab.general)
                    Text(copy.members).tag(MomoChannelSettingsTab.members)
                    Text(copy.integrations).tag(MomoChannelSettingsTab.integrations)
                }
                .pickerStyle(.segmented)
                .labelsHidden()

                Group {
                    switch selectedTab {
                    case .general:
                        generalSettings
                    case .members:
                        memberSettings
                    case .integrations:
                        integrationSettings
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
        Form {
            Section(copy.webhooks) {
                LabeledContent(copy.inboundWebhook) {
                    Text(copy.notConfigured)
                        .foregroundStyle(.secondary)
                }
                Text(copy.webhookPlaceholderDetail)
                    .momoTypography(.supporting)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .formStyle(.grouped)
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

private struct MomoDownloadHistoryRow: Identifiable {
    let id = UUID()
    let title: String
    let detail: String
    let state: String
    let systemImage: String
    let tint: Color
}

private struct MomoDownloadHistoryRowView: View {
    let row: MomoDownloadHistoryRow

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: row.systemImage)
                .font(MomoTheme.Typography.row.weight(.semibold))
                .foregroundStyle(row.tint)
                .frame(width: 24, height: 24)

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(row.title)
                        .font(MomoTheme.Typography.row.weight(.semibold))
                    Text(row.state)
                        .font(MomoTheme.Typography.metadata.weight(.bold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .foregroundStyle(row.tint)
                        .background(row.tint.opacity(0.13), in: Capsule())
                }
                Text(row.detail)
                    .font(MomoTheme.Typography.supporting.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                    .textSelection(.enabled)
            }
            Spacer(minLength: 8)
        }
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
