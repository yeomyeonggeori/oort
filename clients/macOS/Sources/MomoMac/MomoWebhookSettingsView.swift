import AppKit
import SwiftUI
import MomoCore

private struct MomoWebhookContextKey: EnvironmentKey {
    static let defaultValue: MomoInviteAdminContext? = nil
}

extension EnvironmentValues {
    var momoWebhookContext: MomoInviteAdminContext? {
        get { self[MomoWebhookContextKey.self] }
        set { self[MomoWebhookContextKey.self] = newValue }
    }
}

@MainActor
struct MomoWebhookSettingsView: View {
    private static let rotationOverlapSeconds = 24 * 60 * 60

    let channel: Channel
    let context: MomoInviteAdminContext?
    private let copy: MomoWebhookCopy
    @StateObject private var model: MomoWebhookSettingsModel
    @Binding private var navigationLocked: Bool
    @State private var showsCreateForm = false
    @State private var draftLabel = ""
    @State private var draftMode = MomoWebhookMode.native
    @State private var pendingRotate: MomoWebhookInstallation?
    @State private var pendingRevoke: MomoWebhookInstallation?
    @FocusState private var labelFieldFocused: Bool

    init(
        language: MomoUILanguage,
        channel: Channel,
        context: MomoInviteAdminContext?,
        navigationLocked: Binding<Bool> = .constant(false),
        client: any MomoWebhookClient = MomoWebhookRESTClient()
    ) {
        self.channel = channel
        self.context = context
        self.copy = MomoWebhookCopy(language: language)
        _navigationLocked = navigationLocked
        _model = StateObject(wrappedValue: MomoWebhookSettingsModel(
            context: context,
            channelID: channel.id,
            workspaceID: channel.workspaceId,
            client: client,
            copyValue: MomoWebhookPasteboard.copy
        ))
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if showsCreateForm {
                createForm
            } else {
                stateContent
            }
        }
        .task(id: context) {
            await model.updateContext(context)
        }
        .onDisappear {
            model.discardOneTimeCredential()
            navigationLocked = false
        }
        .onChange(of: model.operation) { _, _ in
            synchronizeNavigationLock()
        }
        .onChange(of: model.oneTimeCredential?.id) { _, _ in
            synchronizeNavigationLock()
        }
        .sheet(
            item: oneTimeCredentialBinding,
            onDismiss: model.discardOneTimeCredential
        ) { credential in
            MomoWebhookCredentialRevealSheet(
                copy: copy,
                credential: credential,
                receiveURL: model.oneTimeReceiveURL,
                onCopyReceiveURL: model.copyOneTimeReceiveURL,
                onCopySigningSecret: model.copyOneTimeSigningSecret,
                onDismiss: model.discardOneTimeCredential
            )
        }
        .confirmationDialog(
            copy.rotateConfirmationTitle,
            isPresented: Binding(
                get: { pendingRotate != nil },
                set: { if !$0 { pendingRotate = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button(copy.rotateCredential) {
                guard let installation = pendingRotate else { return }
                pendingRotate = nil
                navigationLocked = true
                Task {
                    _ = await model.rotate(
                        installation,
                        overlapSeconds: Self.rotationOverlapSeconds
                    )
                    synchronizeNavigationLock()
                }
            }
            Button(copy.cancel, role: .cancel) {
                pendingRotate = nil
            }
        } message: {
            Text(copy.rotateConfirmationMessage)
        }
        .confirmationDialog(
            copy.revokeConfirmationTitle,
            isPresented: Binding(
                get: { pendingRevoke != nil },
                set: { if !$0 { pendingRevoke = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button(copy.revokeWebhook, role: .destructive) {
                guard let installation = pendingRevoke else { return }
                pendingRevoke = nil
                navigationLocked = true
                Task {
                    _ = await model.revoke(installation)
                    synchronizeNavigationLock()
                }
            }
            Button(copy.cancel, role: .cancel) {
                pendingRevoke = nil
            }
        } message: {
            Text(copy.revokeConfirmationMessage)
        }
        .accessibilityIdentifier("channel-webhook-settings")
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(showsCreateForm ? copy.createWebhook : copy.title)
                    .momoTypography(.sectionHeader)
                Text(showsCreateForm ? copy.createSubtitle : copy.subtitle(channelName))
                    .momoTypography(.supporting)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 12)

            if !showsCreateForm {
                if model.loadState == .loading {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityLabel(copy.loading)
                }

                Button {
                    Task { await model.load() }
                } label: {
                    Label(copy.refresh, systemImage: "arrow.clockwise")
                        .labelStyle(.iconOnly)
                }
                .buttonStyle(.borderless)
                .keyboardShortcut("r", modifiers: [.command])
                .disabled(model.isWorking || model.loadState == .loading)
                .help(copy.refresh)

                Button {
                    beginCreating()
                } label: {
                    Label(copy.createWebhook, systemImage: "plus")
                }
                .keyboardShortcut("n", modifiers: [.command])
                .disabled(model.isWorking || model.loadState != .loaded)
            }
        }
        .padding(16)
    }

    @ViewBuilder
    private var stateContent: some View {
        switch model.loadState {
        case .idle, .loading:
            VStack(spacing: 12) {
                ProgressView()
                Text(copy.loading)
                    .momoTypography(.supporting)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .unavailable:
            ContentUnavailableView {
                Label(copy.unavailableTitle, systemImage: "server.rack")
            } description: {
                Text(copy.unavailableDescription)
            }

        case .offline:
            ContentUnavailableView {
                Label(copy.offlineTitle, systemImage: "wifi.slash")
            } description: {
                Text(copy.offlineDescription)
            } actions: {
                Button(copy.tryAgain) {
                    Task { await model.load() }
                }
            }

        case .failed(let failure):
            ContentUnavailableView {
                Label(copy.loadFailedTitle, systemImage: "exclamationmark.triangle")
            } description: {
                Text(copy.loadFailedDescription(failure))
            } actions: {
                Button(copy.tryAgain) {
                    Task { await model.load() }
                }
            }

        case .loaded:
            loadedContent
        }
    }

    @ViewBuilder
    private var loadedContent: some View {
        if model.currentChannelInstallations.isEmpty {
            VStack(spacing: 0) {
                feedbackRows
                ContentUnavailableView {
                    Label(copy.emptyTitle, systemImage: "link.badge.plus")
                } description: {
                    Text(copy.emptyDescription)
                } actions: {
                    Button(copy.createWebhook) {
                        beginCreating()
                    }
                    .keyboardShortcut("n", modifiers: [.command])
                }
            }
        } else {
            VStack(spacing: 0) {
                feedbackRows
                List(model.currentChannelInstallations) { installation in
                    webhookRow(installation)
                }
                .listStyle(.inset)
            }
        }
    }

    private var createForm: some View {
        Form {
            Section(copy.webhookDetails) {
                TextField(copy.label, text: $draftLabel)
                    .focused($labelFieldFocused)
                    .momoTypography(.row)
                    .accessibilityIdentifier("webhook-label-field")

                LabeledContent(copy.characterCount) {
                    characterCountLabel
                }

                Picker(copy.mode, selection: $draftMode) {
                    Text(copy.nativeMode).tag(MomoWebhookMode.native)
                    Text(copy.slackCompatibleMode).tag(MomoWebhookMode.slackCompatible)
                }
                .pickerStyle(.radioGroup)

                Label(copy.modeDescription(draftMode), systemImage: "lock.shield")
                    .momoTypography(.supporting)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let issue = model.mutationIssue {
                Section {
                    feedbackLabel(copy.mutationFailure(issue))
                }
            }

            Section {
                HStack(spacing: 8) {
                    Spacer()
                    Button(copy.cancel) {
                        cancelCreating()
                    }
                    .keyboardShortcut(.cancelAction)

                    Button {
                        createWebhook()
                    } label: {
                        if model.operation == .creating {
                            HStack(spacing: 8) {
                                ProgressView()
                                    .controlSize(.small)
                                    .accessibilityHidden(true)
                                Text(copy.creatingWebhook)
                            }
                        } else {
                            Text(copy.createWebhook)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!isDraftLabelValid || model.isWorking)
                    .accessibilityLabel(
                        model.operation == .creating ? copy.creatingWebhook : copy.createWebhook
                    )
                }
            }
        }
        .formStyle(.grouped)
        .onAppear {
            labelFieldFocused = true
        }
    }

    private var feedbackRows: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let issue = model.mutationIssue {
                feedbackLabel(copy.mutationFailure(issue))
                Button(copy.reloadList) {
                    Task { await model.load() }
                }
                .controlSize(.small)
            }
            if let notice = model.notice {
                Label(copy.notice(notice), systemImage: "checkmark.circle")
                    .momoTypography(.supporting)
                    .foregroundStyle(MomoTheme.reversibleGreen)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, model.mutationIssue == nil && model.notice == nil ? 0 : 12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func webhookRow(_ installation: MomoWebhookInstallation) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(installation.label)
                        .momoTypography(.emphasizedRow)
                        .lineLimit(2)
                    Text(copy.created(installation.createdAtMs))
                        .momoTypography(.metadata)
                        .foregroundStyle(.secondary)
                }

                Spacer(minLength: 8)

                if isOperating(on: installation) {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityLabel(copy.working)
                }

                statusChip(installation.status)

                if installation.isActive {
                    Menu {
                        rowActions(installation)
                    } label: {
                        Label(copy.actions, systemImage: "ellipsis.circle")
                            .labelStyle(.iconOnly)
                    }
                    .menuStyle(.borderlessButton)
                    .help(copy.actions)
                    .disabled(model.isWorking)
                }
            }

            Label(copy.modeName(installation.mode), systemImage: copy.modeIcon(installation.mode))
                .momoTypography(.supporting)
                .foregroundStyle(.secondary)

            if installation.mode == .slackCompatible, installation.isActive {
                Text(copy.slackURLRecoveryHint)
                    .momoTypography(.metadata)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 8)
        .contextMenu {
            if installation.isActive {
                rowActions(installation)
            }
        }
    }

    @ViewBuilder
    private func rowActions(_ installation: MomoWebhookInstallation) -> some View {
        if installation.mode == .native {
            Button {
                _ = model.copyReceiveURL(for: installation)
            } label: {
                Label(copy.copyReceiveURL, systemImage: "doc.on.doc")
            }
        }

        Button {
            pendingRotate = installation
        } label: {
            Label(copy.rotateCredential, systemImage: "arrow.triangle.2.circlepath")
        }

        Divider()

        Button(role: .destructive) {
            pendingRevoke = installation
        } label: {
            Label(copy.revokeWebhook, systemImage: "link.badge.minus")
        }
    }

    private func statusChip(_ status: MomoWebhookStatus) -> some View {
        // macOS has no compact lifecycle control for active and revoked integration status.
        Text(copy.status(status))
            .momoTypography(.metadata)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .foregroundStyle(status == .active ? MomoTheme.reversibleGreen : MomoTheme.irreversibleRed)
            .overlay {
                Capsule()
                    .stroke(
                        status == .active ? MomoTheme.reversibleGreen : MomoTheme.irreversibleRed,
                        lineWidth: 1
                    )
            }
            .accessibilityLabel(copy.statusAccessibility(status))
    }

    private func feedbackLabel(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .momoTypography(.supporting)
            .foregroundStyle(MomoTheme.irreversibleRed)
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private var characterCountLabel: some View {
        if isDraftLabelValid {
            Text("\(normalizedDraftLabel.count)/80")
                .momoTypography(.metadata)
                .monospacedDigit()
                .foregroundStyle(.secondary)
        } else {
            Text("\(normalizedDraftLabel.count)/80")
                .momoTypography(.metadata)
                .monospacedDigit()
                .foregroundStyle(MomoTheme.irreversibleRed)
        }
    }

    private var normalizedDraftLabel: String {
        draftLabel.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var isDraftLabelValid: Bool {
        (1...80).contains(normalizedDraftLabel.count)
            && !normalizedDraftLabel.unicodeScalars.contains(
                where: CharacterSet.controlCharacters.contains
            )
    }

    private var channelName: String {
        if channel.kind == .dm {
            return copy.directMessage
        }
        return "#\(MomoLocalChannelPresentationStore.displayName(for: channel))"
    }

    private var oneTimeCredentialBinding: Binding<MomoWebhookOneTimeCredential?> {
        Binding(
            get: { model.oneTimeCredential },
            set: { value in
                if value == nil {
                    model.discardOneTimeCredential()
                }
            }
        )
    }

    private func beginCreating() {
        model.clearFeedback()
        showsCreateForm = true
        labelFieldFocused = true
    }

    private func cancelCreating() {
        draftLabel = ""
        draftMode = .native
        showsCreateForm = false
        model.clearFeedback()
    }

    private func createWebhook() {
        guard isDraftLabelValid, !model.isWorking else { return }
        let label = normalizedDraftLabel
        let mode = draftMode
        navigationLocked = true
        Task {
            if await model.create(label: label, mode: mode) {
                draftLabel = ""
                draftMode = .native
                showsCreateForm = false
            }
            synchronizeNavigationLock()
        }
    }

    private func synchronizeNavigationLock() {
        navigationLocked = model.isWorking || model.oneTimeCredential != nil
    }

    private func isOperating(on installation: MomoWebhookInstallation) -> Bool {
        switch model.operation {
        case .rotating(let id) where id == installation.id:
            return true
        case .revoking(let id) where id == installation.id:
            return true
        case .idle, .creating, .rotating, .revoking:
            return false
        }
    }
}

@MainActor
private struct MomoWebhookCredentialRevealSheet: View {
    let copy: MomoWebhookCopy
    let credential: MomoWebhookOneTimeCredential
    let receiveURL: URL?
    let onCopyReceiveURL: () -> Bool
    let onCopySigningSecret: () -> Bool
    let onDismiss: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var copiedMessage: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "key.viewfinder")
                        .font(.title3)
                        .foregroundStyle(Color.accentColor)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(copy.oneTimeTitle)
                            .font(.title3.weight(.semibold))
                        Text(copy.oneTimeSubtitle(credential.installation.mode))
                            .momoTypography(.supporting)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                GroupBox(copy.receiveURL) {
                    Text(receiveURL?.absoluteString ?? copy.invalidReceiveURL)
                        .font(.body.monospaced())
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                        .privacySensitive()
                }

                if let secret = credential.secret {
                    GroupBox(copy.signingSecret) {
                        Text(secret)
                            .font(.body.monospaced())
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(8)
                            .privacySensitive()
                    }
                }

                GroupBox(copy.signatureDetails) {
                    VStack(alignment: .leading, spacing: 8) {
                        LabeledContent(copy.keyID) {
                            Text(credential.keyId.uuidString.lowercased())
                                .font(.body.monospaced())
                                .textSelection(.enabled)
                        }
                        if let algorithm = credential.algorithm {
                            LabeledContent(copy.algorithm) {
                                Text(algorithm)
                            }
                        }
                        if let version = credential.signatureVersion {
                            LabeledContent(copy.signatureVersion) {
                                Text(version)
                            }
                        }
                        if let overlapSeconds = credential.overlapSeconds {
                            LabeledContent(copy.previousCredential) {
                                Text(copy.overlapDuration(overlapSeconds))
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                }

                HStack(spacing: 8) {
                    Button {
                        if onCopyReceiveURL() {
                            copiedMessage = copy.receiveURLCopied
                        }
                    } label: {
                        Label(copy.copyReceiveURL, systemImage: "doc.on.doc")
                    }
                    .keyboardShortcut("u", modifiers: [.command, .shift])
                    .disabled(receiveURL == nil)

                    if credential.secret != nil {
                        Button {
                            if onCopySigningSecret() {
                                copiedMessage = copy.signingSecretCopied
                            }
                        } label: {
                            Label(copy.copySigningSecret, systemImage: "key")
                        }
                        .keyboardShortcut("c", modifiers: [.command, .shift])
                    }
                }

                if let copiedMessage {
                    Label(copiedMessage, systemImage: "checkmark.circle")
                        .momoTypography(.supporting)
                        .foregroundStyle(MomoTheme.reversibleGreen)
                }

                Label(copy.securityNote, systemImage: "lock.shield")
                    .momoTypography(.supporting)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                HStack {
                    Spacer()
                    Button(copy.savedCredential) {
                        onDismiss()
                        dismiss()
                    }
                    .keyboardShortcut(.defaultAction)
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(
            minWidth: MomoTheme.credentialRevealMinimumWidth,
            idealWidth: MomoTheme.credentialRevealIdealWidth,
            maxWidth: MomoTheme.credentialRevealMaximumWidth
        )
        .interactiveDismissDisabled()
        .accessibilityIdentifier("webhook-one-time-credential")
    }
}

private enum MomoWebhookPasteboard {
    private static let concealedType = NSPasteboard.PasteboardType(
        "org.nspasteboard.ConcealedType"
    )
    private static let transientType = NSPasteboard.PasteboardType(
        "org.nspasteboard.TransientType"
    )

    @MainActor
    static func copy(_ value: String, sensitivity: MomoWebhookClipboardSensitivity) {
        let pasteboard = NSPasteboard.general
        var types: [NSPasteboard.PasteboardType] = [.string]
        if sensitivity == .secret {
            types.append(contentsOf: [concealedType, transientType])
        }
        pasteboard.declareTypes(types, owner: nil)
        pasteboard.setString(value, forType: .string)
        if sensitivity == .secret {
            pasteboard.setData(Data(), forType: concealedType)
            pasteboard.setData(Data(), forType: transientType)
        }
    }
}

struct MomoWebhookCopy {
    let language: MomoUILanguage

    private var isKorean: Bool { language == .korean }

    var title: String { isKorean ? "인바운드 웹훅" : "Incoming webhooks" }
    var createWebhook: String { isKorean ? "웹훅 만들기" : "Create webhook" }
    var createSubtitle: String {
        isKorean
            ? "수신 방식과 이름을 정한 뒤 비밀값을 한 번만 저장하세요."
            : "Choose a receive mode and label, then save the credential shown once."
    }
    func subtitle(_ channel: String) -> String {
        isKorean
            ? "\(channel) 채널로 외부 서비스 알림을 받습니다."
            : "Receive external service updates in \(channel)."
    }
    var loading: String { isKorean ? "웹훅 불러오는 중" : "Loading webhooks" }
    var refresh: String { isKorean ? "웹훅 새로고침" : "Refresh webhooks" }
    var unavailableTitle: String { isKorean ? "서버 세션이 필요합니다" : "Server session required" }
    var unavailableDescription: String {
        isKorean
            ? "실서버 관리자 세션으로 연결하면 이 채널의 웹훅을 관리할 수 있습니다."
            : "Connect with a live server admin session to manage this channel's webhooks."
    }
    var offlineTitle: String { isKorean ? "서버에 연결할 수 없습니다" : "Server is offline" }
    var offlineDescription: String {
        isKorean
            ? "네트워크와 서버 상태를 확인한 뒤 다시 불러오세요."
            : "Check the network and server, then load the webhook list again."
    }
    var loadFailedTitle: String { isKorean ? "웹훅을 불러오지 못했습니다" : "Webhooks could not be loaded" }
    func loadFailedDescription(_ failure: MomoWebhookUserFailure) -> String {
        failureDescription(failure)
    }
    var tryAgain: String { isKorean ? "다시 불러오기" : "Try again" }
    var emptyTitle: String { isKorean ? "이 채널에 웹훅이 없습니다" : "No webhooks in this channel" }
    var emptyDescription: String {
        isKorean
            ? "웹훅을 만들어 배포, 모니터링, 업무 도구의 알림을 받으세요."
            : "Create a webhook to receive deployment, monitoring, or work tool updates."
    }
    var webhookDetails: String { isKorean ? "웹훅 정보" : "Webhook details" }
    var label: String { isKorean ? "이름" : "Label" }
    var characterCount: String { isKorean ? "글자 수" : "Character count" }
    var mode: String { isKorean ? "수신 방식" : "Receive mode" }
    var nativeMode: String { isKorean ? "oort 서명" : "oort signed" }
    var slackCompatibleMode: String { isKorean ? "Slack 호환" : "Slack compatible" }
    func modeDescription(_ mode: MomoWebhookMode) -> String {
        switch (language, mode) {
        case (.korean, .native):
            return "HMAC-SHA256 서명 비밀을 한 번만 표시합니다. 수신 URL은 나중에도 복사할 수 있습니다."
        case (.korean, .slackCompatible):
            return "URL 자체가 비밀값입니다. URL은 지금 한 번만 표시되며 목록에서 다시 볼 수 없습니다."
        case (.english, .native):
            return "The HMAC-SHA256 signing secret is shown once. The receive URL remains copyable later."
        case (.english, .slackCompatible):
            return "The URL is the secret. It is shown once now and cannot be recovered from the list."
        }
    }
    func modeName(_ mode: MomoWebhookMode) -> String {
        mode == .native ? nativeMode : slackCompatibleMode
    }
    func modeIcon(_ mode: MomoWebhookMode) -> String {
        mode == .native ? "signature" : "link"
    }
    var cancel: String { isKorean ? "취소" : "Cancel" }
    var directMessage: String { isKorean ? "다이렉트 메시지" : "Direct message" }
    var creatingWebhook: String { isKorean ? "웹훅 만드는 중" : "Creating webhook" }
    var working: String { isKorean ? "웹훅 변경 중" : "Updating webhook" }
    var actions: String { isKorean ? "웹훅 작업" : "Webhook actions" }
    var copyReceiveURL: String { isKorean ? "수신 URL 복사" : "Copy receive URL" }
    var rotateCredential: String { isKorean ? "비밀값 회전" : "Rotate credential" }
    var revokeWebhook: String { isKorean ? "웹훅 폐기" : "Revoke webhook" }
    var reloadList: String { isKorean ? "목록 다시 불러오기" : "Reload list" }
    var slackURLRecoveryHint: String {
        isKorean
            ? "Slack 호환 수신 URL은 저장되지 않습니다. 새 URL이 필요하면 비밀값을 회전하세요."
            : "Slack-compatible receive URLs are not stored. Rotate the credential to reveal a new URL."
    }
    func created(_ milliseconds: Int64) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(milliseconds) / 1_000)
        let formatted = date.formatted(date: .abbreviated, time: .shortened)
        return isKorean ? "생성 \(formatted)" : "Created \(formatted)"
    }
    func status(_ status: MomoWebhookStatus) -> String {
        switch (language, status) {
        case (.korean, .active): return "활성"
        case (.korean, .revoked): return "폐기됨"
        case (.english, .active): return "Active"
        case (.english, .revoked): return "Revoked"
        }
    }
    func statusAccessibility(_ status: MomoWebhookStatus) -> String {
        isKorean ? "웹훅 상태: \(self.status(status))" : "Webhook status: \(self.status(status))"
    }
    var rotateConfirmationTitle: String { isKorean ? "비밀값을 회전할까요?" : "Rotate this credential?" }
    var rotateConfirmationMessage: String {
        isKorean
            ? "새 비밀값은 한 번만 표시됩니다. 이전 비밀값은 24시간 동안 유효합니다."
            : "The new credential is shown once. The previous credential remains valid for 24 hours."
    }
    var revokeConfirmationTitle: String { isKorean ? "웹훅을 폐기할까요?" : "Revoke this webhook?" }
    var revokeConfirmationMessage: String {
        isKorean
            ? "이 웹훅의 모든 비밀값이 즉시 무효화되며 되돌릴 수 없습니다."
            : "Every credential for this webhook becomes invalid immediately. This cannot be undone."
    }
    func mutationFailure(_ issue: MomoWebhookMutationIssue) -> String {
        if issue.failure == .invalidLabel {
            return isKorean
                ? "이름을 1자에서 80자로 입력하세요. 제어 문자는 사용할 수 없습니다."
                : "Enter a label from 1 to 80 characters without control characters."
        }
        let action: String
        switch (language, issue.action) {
        case (.korean, .create): action = "웹훅을 만들지 못했습니다"
        case (.korean, .rotate): action = "비밀값을 회전하지 못했습니다"
        case (.korean, .revoke): action = "웹훅을 폐기하지 못했습니다"
        case (.english, .create): action = "The webhook was not created"
        case (.english, .rotate): action = "The credential was not rotated"
        case (.english, .revoke): action = "The webhook was not revoked"
        }
        return "\(action). \(failureDescription(issue.failure))"
    }
    func failureDescription(_ failure: MomoWebhookUserFailure) -> String {
        switch (language, failure) {
        case (.korean, .invalidLabel):
            return "이름을 확인하고 다시 시도하세요."
        case (.korean, .unauthorized):
            return "관리자 세션이 만료되었습니다. 다시 로그인한 뒤 시도하세요."
        case (.korean, .forbidden):
            return "이 채널의 웹훅을 관리할 권한이 없습니다. 워크스페이스 관리자에게 문의하세요."
        case (.korean, .conflict):
            return "서버의 웹훅 상태가 변경되었습니다. 목록을 다시 불러온 뒤 시도하세요."
        case (.korean, .invalidResponse):
            return "서버 응답을 확인할 수 없습니다. 목록을 다시 불러오거나 잠시 후 시도하세요."
        case (.korean, .offline):
            return "서버에 연결할 수 없습니다. 연결을 복구한 뒤 목록을 다시 불러오세요."
        case (.korean, .other):
            return "요청을 완료할 수 없습니다. 잠시 후 다시 시도하세요."
        case (.english, .invalidLabel):
            return "Check the label and try again."
        case (.english, .unauthorized):
            return "Your admin session has expired. Sign in again, then retry."
        case (.english, .forbidden):
            return "You do not have permission to manage webhooks in this channel. Contact a workspace admin."
        case (.english, .conflict):
            return "The webhook changed on the server. Reload the list, then retry."
        case (.english, .invalidResponse):
            return "The server response could not be verified. Reload the list or try again later."
        case (.english, .offline):
            return "The server could not be reached. Restore the connection, then reload the list."
        case (.english, .other):
            return "The request could not be completed. Try again later."
        }
    }
    func notice(_ notice: MomoWebhookNotice) -> String {
        switch (language, notice) {
        case (.korean, .receiveURLCopied): return "수신 URL을 복사했습니다."
        case (.korean, .signingSecretCopied): return "서명 비밀을 복사했습니다."
        case (.korean, .revoked): return "웹훅과 모든 비밀값을 폐기했습니다."
        case (.english, .receiveURLCopied): return "Receive URL copied."
        case (.english, .signingSecretCopied): return "Signing secret copied."
        case (.english, .revoked): return "Webhook and all credentials revoked."
        }
    }
    var oneTimeTitle: String { isKorean ? "지금 비밀값을 저장하세요" : "Save this credential now" }
    func oneTimeSubtitle(_ mode: MomoWebhookMode) -> String {
        switch (language, mode) {
        case (.korean, .native):
            return "이 창을 닫으면 서명 비밀을 다시 볼 수 없습니다."
        case (.korean, .slackCompatible):
            return "이 창을 닫으면 비밀값이 포함된 수신 URL을 다시 볼 수 없습니다."
        case (.english, .native):
            return "The signing secret cannot be viewed again after this window closes."
        case (.english, .slackCompatible):
            return "The secret-bearing receive URL cannot be viewed again after this window closes."
        }
    }
    var receiveURL: String { isKorean ? "수신 URL" : "Receive URL" }
    var signingSecret: String { isKorean ? "서명 비밀" : "Signing secret" }
    var signatureDetails: String { isKorean ? "서명 정보" : "Signature details" }
    var keyID: String { isKorean ? "키 ID" : "Key ID" }
    var algorithm: String { isKorean ? "알고리즘" : "Algorithm" }
    var signatureVersion: String { isKorean ? "서명 버전" : "Signature version" }
    var previousCredential: String { isKorean ? "이전 비밀값" : "Previous credential" }
    func overlapDuration(_ seconds: Int) -> String {
        if seconds == 0 {
            return isKorean ? "즉시 만료" : "Expires immediately"
        }
        let hours = seconds / 3_600
        return isKorean ? "\(hours)시간 후 만료" : "Expires after \(hours) hours"
    }
    var invalidReceiveURL: String {
        isKorean
            ? "서버가 유효한 수신 URL을 반환하지 않았습니다."
            : "The server did not return a valid receive URL."
    }
    var copySigningSecret: String { isKorean ? "서명 비밀 복사" : "Copy signing secret" }
    var receiveURLCopied: String { isKorean ? "수신 URL을 복사했습니다." : "Receive URL copied." }
    var signingSecretCopied: String { isKorean ? "서명 비밀을 복사했습니다." : "Signing secret copied." }
    var securityNote: String {
        isKorean
            ? "비밀값은 이 창의 메모리에만 있으며 저장되지 않습니다. 비밀값 복사는 기록 방지 표시와 함께 클립보드에 전달됩니다."
            : "The credential exists only in this window's memory and is not saved. Secret copies are marked to discourage clipboard history."
    }
    var savedCredential: String { isKorean ? "비밀값 저장 완료" : "I saved the credential" }
}
