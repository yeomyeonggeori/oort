import AppKit
import MomoCore
import SwiftUI

@MainActor
struct MomoEventSubscriptionSettingsView: View {
    private let copy: MomoEventSubscriptionCopy
    private let context: MomoInviteAdminContext?
    @StateObject private var model: MomoEventSubscriptionSettingsModel
    @Binding private var navigationLocked: Bool
    @State private var showsCreateForm = false
    @State private var draftURL = ""
    @State private var draftKinds = Set(MomoEventSubscriptionKind.allCases)
    @State private var pendingDelete: MomoEventSubscription?
    @FocusState private var urlFieldFocused: Bool

    init(
        language: MomoUILanguage,
        workspaceID: WorkspaceID,
        context: MomoInviteAdminContext?,
        navigationLocked: Binding<Bool> = .constant(false),
        client: any MomoEventSubscriptionClient = MomoEventSubscriptionRESTClient()
    ) {
        self.copy = MomoEventSubscriptionCopy(language: language)
        self.context = context
        _navigationLocked = navigationLocked
        _model = StateObject(wrappedValue: MomoEventSubscriptionSettingsModel(
            context: context,
            workspaceID: workspaceID,
            client: client,
            copySecret: MomoEventSubscriptionPasteboard.copy
        ))
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if showsCreateForm { createForm } else { stateContent }
        }
        .task(id: context) { await model.updateContext(context) }
        .onDisappear {
            model.discardOneTimeSecret()
            navigationLocked = false
        }
        .onChange(of: model.operation) { _, _ in synchronizeNavigationLock() }
        .onChange(of: model.oneTimeSecret?.id) { _, _ in synchronizeNavigationLock() }
        .sheet(item: oneTimeSecretBinding, onDismiss: model.discardOneTimeSecret) { secret in
            MomoEventSubscriptionSecretView(
                copy: copy,
                secret: secret,
                copied: model.copiedSecret,
                onCopy: model.copyOneTimeSecret,
                onDismiss: {
                    model.discardOneTimeSecret()
                    navigationLocked = false
                }
            )
        }
        .confirmationDialog(
            copy.deleteConfirmationTitle,
            isPresented: Binding(
                get: { pendingDelete != nil },
                set: { if !$0 { pendingDelete = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button(copy.deleteSubscription, role: .destructive) {
                guard let subscription = pendingDelete else { return }
                pendingDelete = nil
                Task {
                    _ = await model.delete(subscription)
                    synchronizeNavigationLock()
                }
            }
            Button(copy.cancel, role: .cancel) { pendingDelete = nil }
        } message: {
            Text(copy.deleteConfirmationMessage)
        }
        .accessibilityIdentifier("outbound-event-subscriptions")
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(showsCreateForm ? copy.createSubscription : copy.title)
                    .momoTypography(.sectionHeader)
                Text(showsCreateForm ? copy.createSubtitle : copy.subtitle)
                    .momoTypography(.supporting)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 12)
            if !showsCreateForm {
                if model.loadState == .loading {
                    ProgressView().controlSize(.small).accessibilityLabel(copy.loading)
                }
                Button {
                    Task { await model.load() }
                } label: {
                    Label(copy.refresh, systemImage: "arrow.clockwise").labelStyle(.iconOnly)
                }
                .buttonStyle(.borderless)
                .keyboardShortcut("r", modifiers: [.command])
                .help(copy.refresh)
                .disabled(model.isWorking || model.loadState == .loading)

                Button {
                    beginCreating()
                } label: {
                    Label(copy.createSubscription, systemImage: "plus")
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
                Text(copy.loading).momoTypography(.supporting).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .unavailable:
            unavailableView(copy.unavailableTitle, copy.unavailableDescription, "server.rack", false)
        case .offline:
            unavailableView(copy.offlineTitle, copy.offlineDescription, "wifi.slash", true)
        case .failed(let failure):
            unavailableView(copy.loadFailedTitle, copy.failureDescription(failure), "exclamationmark.triangle", true)
        case .loaded:
            loadedContent
        }
    }

    private func unavailableView(
        _ title: String,
        _ description: String,
        _ icon: String,
        _ retry: Bool
    ) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: icon)
        } description: {
            Text(description)
        } actions: {
            if retry {
                Button(copy.tryAgain) { Task { await model.load() } }
            }
        }
    }

    @ViewBuilder
    private var loadedContent: some View {
        VStack(spacing: 0) {
            if let issue = model.mutationIssue {
                Label(copy.mutationFailure(issue), systemImage: "exclamationmark.triangle")
                    .momoTypography(.supporting)
                    .foregroundStyle(MomoTheme.irreversibleRed)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if model.subscriptions.isEmpty {
                ContentUnavailableView {
                    Label(copy.emptyTitle, systemImage: "arrow.up.right.square")
                } description: {
                    Text(copy.emptyDescription)
                } actions: {
                    Button(copy.createSubscription) { beginCreating() }
                        .keyboardShortcut("n", modifiers: [.command])
                }
            } else {
                List(model.subscriptions) { subscription in
                    subscriptionRow(subscription)
                }
                .listStyle(.inset)
            }
        }
    }

    private func subscriptionRow(_ subscription: MomoEventSubscription) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(copy.eventKinds(subscription.eventKinds))
                    .momoTypography(.emphasizedRow)
                    .lineLimit(2)
                Spacer(minLength: 8)
                if isOperating(subscription) {
                    ProgressView().controlSize(.small).accessibilityLabel(copy.updating)
                }
                statusChip(subscription.status)
                Menu {
                    rowActions(subscription)
                } label: {
                    Label(copy.actions, systemImage: "ellipsis.circle").labelStyle(.iconOnly)
                }
                .menuStyle(.borderlessButton)
                .help(copy.actions)
                .disabled(model.isWorking)
            }

            Text(subscription.url)
                .font(.body.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .truncationMode(.middle)
                .textSelection(.enabled)

            HStack(spacing: 8) {
                if let reason = copy.disabledReason(subscription) {
                    Label(reason, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.primary)
                }
                if subscription.deliveryFailureCount > 0 {
                    Text(copy.deliveryFailures(subscription.deliveryFailureCount))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            }
            .momoTypography(.metadata)
        }
        .padding(.vertical, 8)
        .contextMenu { rowActions(subscription) }
    }

    @ViewBuilder
    private func rowActions(_ subscription: MomoEventSubscription) -> some View {
        if subscription.enabled {
            Button {
                Task { _ = await model.setEnabled(subscription, enabled: false) }
            } label: {
                Label(copy.disableSubscription, systemImage: "pause.circle")
            }
        } else {
            Button {
                Task { _ = await model.setEnabled(subscription, enabled: true) }
            } label: {
                Label(copy.enableSubscription, systemImage: "play.circle")
            }
        }
        Divider()
        Button(role: .destructive) {
            pendingDelete = subscription
        } label: {
            Label(copy.deleteSubscription, systemImage: "trash")
        }
    }

    private func statusChip(_ status: MomoEventSubscriptionStatus) -> some View {
        // macOS has no compact read-only control for a four-state delivery lifecycle.
        Text(copy.status(status))
            .momoTypography(.metadata)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .foregroundStyle(.primary)
            .overlay { Capsule().stroke(statusColor(status), lineWidth: 1) }
            .accessibilityLabel(copy.statusAccessibility(status))
    }

    private func statusColor(_ status: MomoEventSubscriptionStatus) -> Color {
        switch status {
        case .enabled: return MomoTheme.reversibleGreen
        case .disabledByAdmin: return .secondary
        case .disabledAfterFailures: return MomoTheme.costAmber
        case .unavailable: return MomoTheme.irreversibleRed
        }
    }

    private var createForm: some View {
        Form {
            Section(copy.destination) {
                TextField(copy.urlPlaceholder, text: $draftURL)
                    .focused($urlFieldFocused)
                    .textContentType(.URL)
                    .accessibilityIdentifier("event-subscription-url")
                Label(copy.urlSecurityNote, systemImage: "lock.shield")
                    .momoTypography(.supporting)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Section(copy.events) {
                ForEach(MomoEventSubscriptionKind.allCases) { kind in
                    Toggle(copy.eventKind(kind), isOn: kindBinding(kind))
                        .toggleStyle(.checkbox)
                }
                if draftKinds.isEmpty {
                    Label(copy.chooseEvent, systemImage: "exclamationmark.triangle")
                        .momoTypography(.supporting)
                        .foregroundStyle(MomoTheme.irreversibleRed)
                }
            }

            if let issue = model.mutationIssue {
                Section {
                    Label(copy.mutationFailure(issue), systemImage: "exclamationmark.triangle")
                        .momoTypography(.supporting)
                        .foregroundStyle(MomoTheme.irreversibleRed)
                }
            }

            Section {
                HStack(spacing: 8) {
                    Spacer()
                    Button(copy.cancel) { cancelCreating() }.keyboardShortcut(.cancelAction)
                    Button {
                        createSubscription()
                    } label: {
                        if model.operation == .creating {
                            HStack(spacing: 8) {
                                ProgressView().controlSize(.small).accessibilityHidden(true)
                                Text(copy.creating)
                            }
                        } else {
                            Text(copy.createSubscription)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!isDraftValid || model.isWorking)
                }
            }
        }
        .formStyle(.grouped)
        .onAppear { urlFieldFocused = true }
    }

    private func kindBinding(_ kind: MomoEventSubscriptionKind) -> Binding<Bool> {
        Binding(
            get: { draftKinds.contains(kind) },
            set: { selected in
                if selected { draftKinds.insert(kind) } else { draftKinds.remove(kind) }
            }
        )
    }

    private var isDraftValid: Bool {
        MomoEventSubscriptionSettingsModel.normalizedURL(draftURL) != nil && !draftKinds.isEmpty
    }

    private var oneTimeSecretBinding: Binding<MomoEventSubscriptionSecret?> {
        Binding(
            get: { model.oneTimeSecret },
            set: { if $0 == nil { model.discardOneTimeSecret() } }
        )
    }

    private func beginCreating() {
        model.clearIssue()
        showsCreateForm = true
        urlFieldFocused = true
    }

    private func cancelCreating() {
        draftURL = ""
        draftKinds = Set(MomoEventSubscriptionKind.allCases)
        showsCreateForm = false
        model.clearIssue()
    }

    private func createSubscription() {
        let url = draftURL
        let kinds = draftKinds
        Task {
            if await model.create(url: url, eventKinds: kinds) {
                draftURL = ""
                draftKinds = Set(MomoEventSubscriptionKind.allCases)
                showsCreateForm = false
            }
            synchronizeNavigationLock()
        }
    }

    private func synchronizeNavigationLock() {
        navigationLocked = model.isWorking || model.oneTimeSecret != nil
    }

    private func isOperating(_ subscription: MomoEventSubscription) -> Bool {
        switch model.operation {
        case .updating(subscription.id), .deleting(subscription.id): return true
        case .idle, .creating, .updating, .deleting: return false
        }
    }
}

@MainActor
struct MomoEventSubscriptionSecretView: View {
    let copy: MomoEventSubscriptionCopy
    let secret: MomoEventSubscriptionSecret
    let copied: Bool
    let onCopy: () -> Void
    let onDismiss: () -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "key.viewfinder")
                        .font(.title3)
                        .foregroundStyle(Color.accentColor)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(copy.oneTimeTitle).font(.title3.weight(.semibold))
                        Text(copy.oneTimeDescription)
                            .momoTypography(.supporting)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                GroupBox(copy.signingSecret) {
                    Text(secret.secret)
                        .font(.body.monospaced())
                        .textSelection(.enabled)
                        .privacySensitive()
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                }

                GroupBox(copy.signatureDetails) {
                    VStack(alignment: .leading, spacing: 8) {
                        LabeledContent(copy.algorithm) { Text(secret.algorithm) }
                        LabeledContent(copy.signatureVersion) { Text(secret.signatureVersion) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                }

                Button {
                    onCopy()
                } label: {
                    Label(copy.copySecret, systemImage: "doc.on.doc")
                }
                .keyboardShortcut("c", modifiers: [.command, .shift])

                if copied {
                    Label(copy.secretCopied, systemImage: "checkmark.circle")
                        .momoTypography(.supporting)
                        .foregroundStyle(.primary)
                }

                Label(copy.secretSecurityNote, systemImage: "lock.shield")
                    .momoTypography(.supporting)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                HStack {
                    Spacer()
                    Button(copy.savedSecret) {
                        onDismiss()
                        dismiss()
                    }
                    .keyboardShortcut(.defaultAction)
                }
            }
            .padding(24)
        }
        .frame(
            minWidth: MomoTheme.credentialRevealMinimumWidth,
            idealWidth: MomoTheme.credentialRevealIdealWidth,
            maxWidth: MomoTheme.credentialRevealMaximumWidth
        )
        .interactiveDismissDisabled()
        .accessibilityIdentifier("event-subscription-one-time-secret")
    }
}

private enum MomoEventSubscriptionPasteboard {
    private static let concealed = NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")
    private static let transient = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")

    @MainActor
    static func copy(_ value: String) {
        let pasteboard = NSPasteboard.general
        pasteboard.declareTypes([.string, concealed, transient], owner: nil)
        pasteboard.setString(value, forType: .string)
        pasteboard.setData(Data(), forType: concealed)
        pasteboard.setData(Data(), forType: transient)
    }
}

struct MomoEventSubscriptionCopy {
    let language: MomoUILanguage
    private var isKorean: Bool { language == .korean }

    var title: String { isKorean ? "발신 이벤트 구독" : "Outbound event subscriptions" }
    var subtitle: String { isKorean ? "워크스페이스 이벤트를 외부 HTTPS 주소로 전송합니다." : "Send workspace events to an external HTTPS destination." }
    var createSubscription: String { isKorean ? "구독 만들기" : "Create subscription" }
    var createSubtitle: String { isKorean ? "받을 주소와 이벤트를 선택하세요. 서명 비밀은 생성 직후 한 번만 표시됩니다." : "Choose a destination and events. The signing secret is shown only once after creation." }
    var loading: String { isKorean ? "구독 불러오는 중" : "Loading subscriptions" }
    var refresh: String { isKorean ? "구독 새로고침" : "Refresh subscriptions" }
    var updating: String { isKorean ? "구독 변경 중" : "Updating subscription" }
    var actions: String { isKorean ? "구독 작업" : "Subscription actions" }
    var unavailableTitle: String { isKorean ? "서버 세션이 필요합니다" : "Server session required" }
    var unavailableDescription: String { isKorean ? "실서버 관리자 세션으로 연결하면 발신 구독을 관리할 수 있습니다." : "Connect with a live server admin session to manage outbound subscriptions." }
    var offlineTitle: String { isKorean ? "서버에 연결할 수 없습니다" : "Server is offline" }
    var offlineDescription: String { isKorean ? "네트워크와 서버 상태를 확인한 뒤 다시 불러오세요." : "Check the network and server, then load the list again." }
    var loadFailedTitle: String { isKorean ? "구독을 불러오지 못했습니다" : "Subscriptions could not be loaded" }
    var tryAgain: String { isKorean ? "다시 불러오기" : "Try again" }
    var emptyTitle: String { isKorean ? "발신 구독이 없습니다" : "No outbound subscriptions" }
    var emptyDescription: String { isKorean ? "구독을 만들어 멘션, 승인 요청, 작업 상태를 외부 서비스로 보내세요." : "Create a subscription to send mentions, approval requests, and work status changes." }
    var destination: String { isKorean ? "전송 주소" : "Destination" }
    var urlPlaceholder: String { "https://hooks.example.com/momo" }
    var urlSecurityNote: String { isKorean ? "운영 서버는 공개 HTTPS 주소만 허용하며 저장 전 안전성을 확인합니다." : "Production accepts public HTTPS destinations and validates them before saving." }
    var events: String { isKorean ? "이벤트 종류" : "Event types" }
    var chooseEvent: String { isKorean ? "이벤트를 하나 이상 선택하세요." : "Select at least one event." }
    var creating: String { isKorean ? "구독 만드는 중" : "Creating subscription" }
    var cancel: String { isKorean ? "만들기 취소" : "Cancel creation" }
    var enableSubscription: String { isKorean ? "구독 사용" : "Enable subscription" }
    var disableSubscription: String { isKorean ? "구독 중지" : "Disable subscription" }
    var deleteSubscription: String { isKorean ? "구독 삭제" : "Delete subscription" }
    var deleteConfirmationTitle: String { isKorean ? "이 구독을 삭제할까요?" : "Delete this subscription?" }
    var deleteConfirmationMessage: String { isKorean ? "외부 전송이 즉시 중단되며 이 작업은 되돌릴 수 없습니다." : "Outbound delivery stops immediately. This action cannot be undone." }
    var oneTimeTitle: String { isKorean ? "서명 비밀을 지금 저장하세요" : "Save the signing secret now" }
    var oneTimeDescription: String { isKorean ? "이 비밀은 다시 조회할 수 없으며 이후 어떤 화면에도 표시되지 않습니다." : "This secret cannot be retrieved again and will not appear on any later screen." }
    var signingSecret: String { isKorean ? "서명 비밀" : "Signing secret" }
    var signatureDetails: String { isKorean ? "서명 방식" : "Signature details" }
    var algorithm: String { isKorean ? "알고리즘" : "Algorithm" }
    var signatureVersion: String { isKorean ? "서명 버전" : "Signature version" }
    var copySecret: String { isKorean ? "서명 비밀 복사" : "Copy signing secret" }
    var secretCopied: String { isKorean ? "서명 비밀을 복사했습니다." : "Signing secret copied." }
    var secretSecurityNote: String { isKorean ? "비밀 관리 도구에 저장한 뒤 이 창을 닫으세요. 목록에는 주소와 상태만 남습니다." : "Store it in a secret manager before closing this window. Only the destination and status remain in the list." }
    var savedSecret: String { isKorean ? "비밀 저장 완료" : "Secret saved" }

    func eventKind(_ kind: MomoEventSubscriptionKind) -> String {
        switch (language, kind) {
        case (.korean, .mention): return "멘션"
        case (.korean, .approvalRequest): return "승인 요청"
        case (.korean, .workStatusChanged): return "작업 상태 변경"
        case (.english, .mention): return "Mention"
        case (.english, .approvalRequest): return "Approval request"
        case (.english, .workStatusChanged): return "Work status change"
        }
    }

    func eventKinds(_ kinds: [MomoEventSubscriptionKind]) -> String {
        kinds.map(eventKind).joined(separator: isKorean ? " · " : " · ")
    }

    func status(_ status: MomoEventSubscriptionStatus) -> String {
        switch (language, status) {
        case (.korean, .enabled): return "사용 중"
        case (.korean, .disabledByAdmin): return "관리자 중지"
        case (.korean, .disabledAfterFailures): return "자동 중지"
        case (.korean, .unavailable): return "상태 확인 필요"
        case (.english, .enabled): return "Enabled"
        case (.english, .disabledByAdmin): return "Disabled by admin"
        case (.english, .disabledAfterFailures): return "Auto-disabled"
        case (.english, .unavailable): return "Needs review"
        }
    }

    func statusAccessibility(_ status: MomoEventSubscriptionStatus) -> String {
        isKorean ? "구독 상태: \(self.status(status))" : "Subscription status: \(self.status(status))"
    }

    func disabledReason(_ subscription: MomoEventSubscription) -> String? {
        switch subscription.status {
        case .enabled: return nil
        case .disabledByAdmin: return isKorean ? "관리자가 전송을 중지했습니다." : "An administrator stopped delivery."
        case .disabledAfterFailures: return isKorean ? "서버 오류가 반복되어 자동으로 중지했습니다." : "Delivery was stopped after repeated server errors."
        case .unavailable: return isKorean ? "중지 사유를 확인할 수 없습니다. 다시 사용하거나 삭제하세요." : "The disable reason is unavailable. Enable or delete this subscription."
        }
    }

    func deliveryFailures(_ count: Int) -> String {
        isKorean ? "최근 전송 실패 \(count)회" : "\(count) recent delivery failures"
    }

    func failureDescription(_ failure: MomoEventSubscriptionFailure) -> String {
        switch (language, failure) {
        case (.korean, .invalidURL): return "http 또는 https 주소를 정확히 입력하세요."
        case (.korean, .noEvents): return "이벤트를 하나 이상 선택하세요."
        case (.korean, .unauthorized): return "관리자 세션이 만료되었습니다. 다시 로그인한 뒤 시도하세요."
        case (.korean, .forbidden): return "발신 구독을 관리할 권한이 없습니다. 워크스페이스 관리자에게 문의하세요."
        case (.korean, .notFound): return "구독이 이미 변경되거나 삭제되었습니다. 목록을 다시 불러오세요."
        case (.korean, .invalidResponse): return "서버 응답을 확인하지 못했습니다. 목록을 다시 불러오세요."
        case (.korean, .offline): return "서버에 연결할 수 없습니다. 연결을 확인하고 다시 시도하세요."
        case (.korean, .other): return "요청을 완료하지 못했습니다. 주소와 서버 상태를 확인하고 다시 시도하세요."
        case (.english, .invalidURL): return "Enter a valid http or https destination."
        case (.english, .noEvents): return "Select at least one event."
        case (.english, .unauthorized): return "Your admin session expired. Sign in again, then retry."
        case (.english, .forbidden): return "You do not have permission to manage outbound subscriptions. Contact a workspace admin."
        case (.english, .notFound): return "The subscription changed or was deleted. Reload the list."
        case (.english, .invalidResponse): return "The server response could not be verified. Reload the list."
        case (.english, .offline): return "The server could not be reached. Check the connection and retry."
        case (.english, .other): return "The request could not be completed. Check the destination and server, then retry."
        }
    }

    func mutationFailure(_ issue: MomoEventSubscriptionIssue) -> String {
        let action: String
        switch (language, issue.mutation) {
        case (.korean, .create): action = "구독을 만들지 못했습니다."
        case (.korean, .enable): action = "구독을 사용하지 못했습니다."
        case (.korean, .disable): action = "구독을 중지하지 못했습니다."
        case (.korean, .delete): action = "구독을 삭제하지 못했습니다."
        case (.english, .create): action = "The subscription was not created."
        case (.english, .enable): action = "The subscription was not enabled."
        case (.english, .disable): action = "The subscription was not disabled."
        case (.english, .delete): action = "The subscription was not deleted."
        }
        return "\(action) \(failureDescription(issue.failure))"
    }
}
