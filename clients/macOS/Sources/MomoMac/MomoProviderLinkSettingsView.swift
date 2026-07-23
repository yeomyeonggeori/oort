import SwiftUI
import MomoCore

/// Admin "AI 연결" surface (MOMO-574, ADR-0004 증보 1 P-2). Configures the
/// instance LLM provider link: base URL + write-only bearer, a reachability test,
/// and removal. It deliberately separates the LLM provider (this screen) from the
/// code-execution work host (ADR-0114), which registers itself from a local Codex
/// CLI and is never configured here.
@MainActor
struct MomoProviderLinkSettingsView: View {
    private let copy: MomoProviderLinkCopy
    @StateObject private var model: MomoProviderLinkSettingsModel
    @Binding private var navigationLocked: Bool
    /// Bumped by the host when a close/switch is attempted while the pane is
    /// locked, so the pane can raise its own discard confirmation.
    private let discardRequest: Int
    /// Called after the operator confirms discarding the unsaved bearer, so the
    /// host can replay the deferred close/switch.
    private let onConfirmDiscard: () -> Void
    @State private var showsRemoveConfirmation = false
    @State private var showsDiscardConfirmation = false
    @FocusState private var baseURLFocused: Bool

    init(
        language: MomoUILanguage,
        context: MomoInviteAdminContext?,
        navigationLocked: Binding<Bool> = .constant(false),
        discardRequest: Int = 0,
        onConfirmDiscard: @escaping () -> Void = {},
        client: any MomoProviderLinkClient = MomoProviderLinkRESTClient()
    ) {
        self.copy = MomoProviderLinkCopy(language: language)
        _navigationLocked = navigationLocked
        self.discardRequest = discardRequest
        self.onConfirmDiscard = onConfirmDiscard
        _model = StateObject(wrappedValue: MomoProviderLinkSettingsModel(
            context: context,
            client: client
        ))
    }

    // Test-only initializer that injects a prepared context, used by snapshots.
    init(
        language: MomoUILanguage,
        model: MomoProviderLinkSettingsModel,
        navigationLocked: Binding<Bool> = .constant(false),
        discardRequest: Int = 0,
        onConfirmDiscard: @escaping () -> Void = {}
    ) {
        self.copy = MomoProviderLinkCopy(language: language)
        _navigationLocked = navigationLocked
        self.discardRequest = discardRequest
        self.onConfirmDiscard = onConfirmDiscard
        _model = StateObject(wrappedValue: model)
    }

    var body: some View {
        stateContent
            .task {
                await model.loadIfNeeded()
            }
            .onDisappear {
                model.discardDraftSecret()
                navigationLocked = false
            }
            .onChange(of: model.navigationLocked) { _, locked in
                navigationLocked = locked
            }
            .onChange(of: discardRequest) { _, _ in
                // The host deferred a close/switch; confirm the discard only when
                // there is actually an unsaved bearer to lose (an in-flight
                // mutation with no draft resolves on its own).
                guard model.hasUnsavedBearer else { return }
                showsDiscardConfirmation = true
            }
            .confirmationDialog(
                copy.removeConfirmationTitle,
                isPresented: $showsRemoveConfirmation,
                titleVisibility: .visible
            ) {
                Button(copy.removeConnection, role: .destructive) {
                    Task { await model.remove() }
                }
                Button(copy.cancel, role: .cancel) {}
            } message: {
                Text(copy.removeConfirmationMessage)
            }
            .confirmationDialog(
                copy.discardConfirmationTitle,
                isPresented: $showsDiscardConfirmation,
                titleVisibility: .visible
            ) {
                Button(copy.discardAndLeave, role: .destructive) {
                    model.discardDraftSecret()
                    onConfirmDiscard()
                }
                Button(copy.keepEditing, role: .cancel) {}
            } message: {
                Text(copy.discardConfirmationMessage)
            }
            .accessibilityIdentifier("ai-connection-settings")
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
                Text(copy.failureDescription(failure))
            } actions: {
                Button(copy.tryAgain) {
                    Task { await model.load() }
                }
            }

        case .loaded:
            loadedForm
        }
    }

    private var loadedForm: some View {
        Form {
            providerStatusSection
            connectSection
            testSection
            if model.canRemove {
                removeSection
            }
            workHostSection
        }
        .formStyle(.grouped)
    }

    // MARK: - LLM provider status

    private var providerStatusSection: some View {
        Section {
            LabeledContent(copy.connectionLabel) {
                connectionChip
            }
            if let status = model.status {
                LabeledContent(copy.sourceLabel) {
                    Text(copy.sourceValue(status.source))
                        .momoTypography(.row)
                }
                LabeledContent(copy.endpointLabel) {
                    Text(status.endpointLabel)
                        .momoTypography(.row)
                        .textSelection(.enabled)
                        .lineLimit(2)
                        .multilineTextAlignment(.trailing)
                }
                LabeledContent(copy.bearerLabel) {
                    bearerStatusLabel(status)
                }
                LabeledContent(copy.modeLabel) {
                    Text(copy.modeName(status.mode))
                        .momoTypography(.row)
                }
                LabeledContent(copy.availabilityLabel) {
                    Text(copy.availabilityValue(status.availability))
                        .momoTypography(.row)
                        .foregroundStyle(availabilityColor(status.availability))
                }
                if let updatedAtMs = status.updatedAtMs {
                    LabeledContent(copy.updatedLabel) {
                        Text(copy.timestamp(updatedAtMs))
                            .momoTypography(.row)
                            .monospacedDigit()
                    }
                }
                if let diagnostic = status.diagnostics.first {
                    Label(diagnostic, systemImage: "info.circle")
                        .momoTypography(.supporting)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        } header: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Label(copy.providerSectionHeader, systemImage: "brain")
                Spacer(minLength: 8)
                Button {
                    Task { await model.load() }
                } label: {
                    Label(copy.refresh, systemImage: "arrow.clockwise")
                        .labelStyle(.iconOnly)
                }
                .buttonStyle(.borderless)
                .keyboardShortcut("r", modifiers: [.command])
                .disabled(model.isWorking)
                .help(copy.refresh)
            }
        } footer: {
            Text(copy.providerSectionFooter)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // §1 custom-control justification: AppKit has no native "status pill" that
    // carries a semantic tint outline; a bordered Button would imply an action and
    // a plain Text loses the at-a-glance state. This is a read-only status token,
    // so a Capsule-outlined label is the least-surprising native-feeling shape.
    private var connectionChip: some View {
        let connection = ProviderConnectionState(status: model.status)
        return Text(copy.connectionValue(connection))
            .momoTypography(.metadata)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .foregroundStyle(connectionColor(connection))
            .overlay {
                Capsule()
                    .stroke(connectionColor(connection), lineWidth: 1)
            }
            .accessibilityLabel(copy.connectionAccessibility(connection))
    }

    @ViewBuilder
    private func bearerStatusLabel(_ status: MomoProviderLinkStatus) -> some View {
        if status.bearerConfigured {
            HStack(spacing: 8) {
                Text(copy.bearerConfigured)
                    .momoTypography(.row)
                if let last4 = status.bearerLast4, !last4.isEmpty {
                    Text(verbatim: "\u{2022}\u{2022}\u{2022}\u{2022}\(last4)")
                        .momoTypography(.row)
                        .monospaced()
                        .foregroundStyle(.secondary)
                        .privacySensitive()
                }
            }
        } else {
            Text(copy.bearerMissing)
                .momoTypography(.row)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Connect (write path)

    private var connectSection: some View {
        Section {
            TextField(copy.baseURLPlaceholder, text: $model.baseURLDraft)
                .momoTypography(.row)
                .textContentType(.URL)
                .focused($baseURLFocused)
                .accessibilityIdentifier("ai-connection-base-url")

            SecureField(copy.bearerPlaceholder, text: $model.bearerDraft)
                .momoTypography(.row)
                .textContentType(.password)
                .privacySensitive()
                .accessibilityIdentifier("ai-connection-bearer")

            Picker(copy.modeLabel, selection: $model.modeDraft) {
                ForEach(MomoProviderLinkMode.allCases) { mode in
                    Text(copy.modeName(mode)).tag(mode)
                }
            }

            if let issue = model.mutationIssue, issue.action == .save {
                feedbackLabel(copy.mutationFailure(issue))
            }

            if model.notice == .saved {
                Label(copy.savedNotice, systemImage: "checkmark.circle")
                    .momoTypography(.supporting)
                    .foregroundStyle(MomoTheme.reversibleGreen)
            }

            if model.hasUnsavedBearer {
                Label(copy.unsavedBearerHint, systemImage: "lock")
                    .momoTypography(.supporting)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: 8) {
                Spacer()
                Button {
                    save()
                } label: {
                    if model.operation == .saving {
                        HStack(spacing: 8) {
                            ProgressView()
                                .controlSize(.small)
                                .accessibilityHidden(true)
                            Text(copy.savingConnection)
                        }
                    } else {
                        Text(copy.saveConnection)
                    }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut("s", modifiers: [.command])
                .disabled(!model.canSave)
                .accessibilityLabel(
                    model.operation == .saving ? copy.savingConnection : copy.saveConnection
                )
            }
        } header: {
            Text(copy.connectSectionHeader)
        } footer: {
            Text(copy.connectSectionFooter)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - Reachability test

    private var testSection: some View {
        Section {
            HStack(spacing: 8) {
                Button {
                    Task { await model.test() }
                } label: {
                    if model.operation == .testing {
                        HStack(spacing: 8) {
                            ProgressView()
                                .controlSize(.small)
                                .accessibilityHidden(true)
                            Text(copy.testingConnection)
                        }
                    } else {
                        Label(copy.testConnection, systemImage: "bolt.horizontal")
                    }
                }
                .keyboardShortcut("t", modifiers: [.command, .shift])
                .disabled(!model.canTest)
                .accessibilityLabel(
                    model.operation == .testing ? copy.testingConnection : copy.testConnection
                )
                Spacer()
            }

            if let issue = model.mutationIssue, issue.action == .test {
                feedbackLabel(copy.mutationFailure(issue))
            } else if let result = model.testResult {
                testResultLabel(result)
            } else if let status = model.status, status.mode != .externalHermes {
                Label(copy.testUnavailableForMode, systemImage: "info.circle")
                    .momoTypography(.supporting)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } header: {
            Text(copy.testSectionHeader)
        } footer: {
            Text(copy.testSectionFooter)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private func testResultLabel(_ result: MomoProviderLinkTestResult) -> some View {
        if result.ok {
            Label(copy.testSucceeded, systemImage: "checkmark.circle")
                .momoTypography(.supporting)
                .foregroundStyle(MomoTheme.reversibleGreen)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            Label(copy.testFailed(result.reason), systemImage: "xmark.octagon")
                .momoTypography(.supporting)
                .foregroundStyle(MomoTheme.irreversibleRed)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - Remove

    private var removeSection: some View {
        Section {
            if let issue = model.mutationIssue, issue.action == .remove {
                feedbackLabel(copy.mutationFailure(issue))
            }
            if model.notice == .removed {
                Label(copy.removedNotice, systemImage: "checkmark.circle")
                    .momoTypography(.supporting)
                    .foregroundStyle(MomoTheme.reversibleGreen)
            }
            HStack(spacing: 8) {
                Spacer()
                Button(role: .destructive) {
                    showsRemoveConfirmation = true
                } label: {
                    if model.operation == .removing {
                        HStack(spacing: 8) {
                            ProgressView()
                                .controlSize(.small)
                                .accessibilityHidden(true)
                            Text(copy.removingConnection)
                        }
                    } else {
                        Label(copy.removeConnection, systemImage: "link.badge.minus")
                    }
                }
                .disabled(model.isWorking)
            }
        } header: {
            Text(copy.removeSectionHeader)
        } footer: {
            Text(copy.removeSectionFooter)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - Work host (ADR-0114) distinction

    private var workHostSection: some View {
        Section {
            LabeledContent(copy.workHostStatusLabel) {
                Text(copy.workHostStatusValue)
                    .momoTypography(.row)
                    .foregroundStyle(.secondary)
            }
            Label(copy.workHostGuidance, systemImage: "terminal")
                .momoTypography(.supporting)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        } header: {
            Text(copy.workHostSectionHeader)
        } footer: {
            Text(copy.workHostSectionFooter)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func feedbackLabel(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .momoTypography(.supporting)
            .foregroundStyle(MomoTheme.irreversibleRed)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func save() {
        baseURLFocused = false
        Task { await model.save() }
    }

    private func connectionColor(_ state: ProviderConnectionState) -> Color {
        switch state {
        case .connected: return MomoTheme.reversibleGreen
        case .degraded: return MomoTheme.costAmber
        case .notConfigured: return .secondary
        }
    }

    private func availabilityColor(_ availability: MomoProviderLinkAvailability) -> Color {
        switch availability {
        case .available: return MomoTheme.reversibleGreen
        case .degraded: return MomoTheme.costAmber
        case .mock: return .secondary
        }
    }
}

/// The binary-ish connection state the header chip reports (연결됨 / 저하됨 / 미설정).
enum ProviderConnectionState: Equatable {
    case connected
    case degraded
    case notConfigured

    init(status: MomoProviderLinkStatus?) {
        guard let status else {
            self = .notConfigured
            return
        }
        switch status.availability {
        case .available:
            self = .connected
        case .degraded:
            self = .degraded
        case .mock:
            self = .notConfigured
        }
    }
}

struct MomoProviderLinkCopy {
    let language: MomoUILanguage

    private var isKorean: Bool { language == .korean }

    // Provider status
    var providerSectionHeader: String { isKorean ? "AI 연결 (LLM provider)" : "AI connection (LLM provider)" }
    var providerSectionFooter: String {
        isKorean
            ? "momo가 에이전트 응답을 받는 OpenAI 호환 provider입니다. base URL과 게이트웨이 bearer만 저장합니다."
            : "The OpenAI-compatible provider momo uses for agent replies. Only the base URL and gateway bearer are stored."
    }
    var connectionLabel: String { isKorean ? "연결 상태" : "Connection" }
    func connectionValue(_ state: ProviderConnectionState) -> String {
        switch (language, state) {
        case (.korean, .connected): return "연결됨"
        case (.korean, .degraded): return "저하됨"
        case (.korean, .notConfigured): return "미설정"
        case (.english, .connected): return "Connected"
        case (.english, .degraded): return "Degraded"
        case (.english, .notConfigured): return "Not configured"
        }
    }
    func connectionAccessibility(_ state: ProviderConnectionState) -> String {
        isKorean ? "AI 연결 상태: \(connectionValue(state))" : "AI connection status: \(connectionValue(state))"
    }
    var sourceLabel: String { isKorean ? "설정 위치" : "Configured in" }
    func sourceValue(_ source: MomoProviderLinkSource) -> String {
        switch (language, source) {
        case (.korean, .database): return "앱에서 설정"
        case (.korean, .environment): return "서버 환경 변수"
        case (.english, .database): return "App settings"
        case (.english, .environment): return "Server environment"
        }
    }
    var endpointLabel: String { isKorean ? "엔드포인트" : "Endpoint" }
    var bearerLabel: String { isKorean ? "Bearer" : "Bearer" }
    var bearerConfigured: String { isKorean ? "설정됨" : "Configured" }
    var bearerMissing: String { isKorean ? "미설정" : "Not set" }
    var modeLabel: String { isKorean ? "모드" : "Mode" }
    var availabilityLabel: String { isKorean ? "가용성" : "Availability" }
    func availabilityValue(_ availability: MomoProviderLinkAvailability) -> String {
        switch (language, availability) {
        case (.korean, .available): return "사용 가능"
        case (.korean, .degraded): return "저하됨"
        case (.korean, .mock): return "모의(mock)"
        case (.english, .available): return "Available"
        case (.english, .degraded): return "Degraded"
        case (.english, .mock): return "Mock"
        }
    }
    var updatedLabel: String { isKorean ? "마지막 변경" : "Last updated" }
    func modeName(_ mode: MomoProviderLinkMode) -> String {
        switch (language, mode) {
        case (.korean, .externalHermes): return "외부 Hermes"
        case (.korean, .internalHostMock): return "내부 호스트 모의"
        case (.korean, .localMock): return "로컬 모의"
        case (.english, .externalHermes): return "External Hermes"
        case (.english, .internalHostMock): return "Internal host mock"
        case (.english, .localMock): return "Local mock"
        }
    }

    // Connect (write path)
    var connectSectionHeader: String { isKorean ? "연결 설정" : "Set connection" }
    var connectSectionFooter: String {
        isKorean
            ? "예: https://provider.example/v1. bearer는 저장 후 다시 표시되지 않습니다. 교체하려면 새 값을 입력하고 저장하세요. Codex/OpenAI OAuth 토큰이나 원본 API 키가 아닌, 게이트웨이 접근용 bearer만 입력하세요."
            : "Example: https://provider.example/v1. The bearer is not shown again after saving. Enter a new value and save to replace it. Use only the gateway bearer, never a Codex/OpenAI OAuth token or a raw API key."
    }
    var baseURLPlaceholder: String { "Base URL" }
    var bearerPlaceholder: String { "Bearer" }
    var saveConnection: String { isKorean ? "연결 저장" : "Save connection" }
    var savingConnection: String { isKorean ? "저장 중" : "Saving" }
    var savedNotice: String { isKorean ? "연결을 저장했습니다." : "Connection saved." }
    var unsavedBearerHint: String {
        isKorean
            ? "저장하지 않은 bearer가 있어요. 저장하거나, 나갈 때 입력을 지울 수 있어요."
            : "You have an unsaved bearer. Save it, or discard it when you leave."
    }

    // Discard confirmation (raised when leaving with an unsaved bearer)
    var discardConfirmationTitle: String {
        isKorean ? "저장하지 않은 bearer를 지울까요?" : "Discard the unsaved bearer?"
    }
    var discardConfirmationMessage: String {
        isKorean
            ? "입력한 bearer를 저장하지 않고 나가면 지워집니다. 계속 입력하려면 취소하세요."
            : "Leaving without saving discards the bearer you entered. Cancel to keep editing."
    }
    var discardAndLeave: String { isKorean ? "저장 안 하고 나가기" : "Discard and leave" }
    var keepEditing: String { isKorean ? "계속 입력하기" : "Keep editing" }

    // Test
    var testSectionHeader: String { isKorean ? "연결 테스트" : "Test connection" }
    var testSectionFooter: String {
        isKorean
            ? "저장된 base URL과 bearer로 provider에 최소 요청을 보내 도달 가능 여부를 확인합니다."
            : "Sends a minimal request to the provider using the stored base URL and bearer to check reachability."
    }
    var testConnection: String { isKorean ? "연결 테스트" : "Test connection" }
    var testingConnection: String { isKorean ? "테스트 중" : "Testing" }
    var testUnavailableForMode: String {
        isKorean
            ? "외부 Hermes 모드에서만 연결을 테스트할 수 있어요. 먼저 모드를 외부 Hermes로 저장하세요."
            : "Connection tests run only in external Hermes mode. Save the mode as external Hermes first."
    }
    var testSucceeded: String { isKorean ? "연결에 성공했습니다." : "Connection succeeded." }
    func testFailed(_ reason: String?) -> String {
        let detail = reasonDescription(reason)
        return isKorean ? "연결에 실패했습니다. \(detail)" : "Connection failed. \(detail)"
    }
    private func reasonDescription(_ reason: String?) -> String {
        guard let reason, !reason.isEmpty else {
            return isKorean ? "잠시 후 다시 시도하세요." : "Try again shortly."
        }
        switch reason {
        case "provider_auth_failed":
            return isKorean
                ? "provider가 bearer를 거부했습니다. 값을 다시 입력하고 저장하세요."
                : "The provider rejected the bearer. Re-enter the value and save."
        case "provider_unreachable":
            return isKorean
                ? "provider에 도달할 수 없습니다. base URL과 네트워크를 확인하세요."
                : "The provider could not be reached. Check the base URL and network."
        case "not_external_provider":
            return isKorean
                ? "현재 모드에서는 테스트할 수 없습니다. 외부 Hermes 모드로 설정하세요."
                : "The current mode cannot be tested. Set the mode to external Hermes."
        case "provider_not_configured":
            return isKorean
                ? "연결이 설정되지 않았습니다. base URL과 bearer를 먼저 저장하세요."
                : "No connection is configured. Save a base URL and bearer first."
        default:
            if reason.hasPrefix("provider_status_") {
                let code = reason.replacingOccurrences(of: "provider_status_", with: "")
                return isKorean
                    ? "provider가 상태 코드 \(code)로 응답했습니다."
                    : "The provider responded with status \(code)."
            }
            return isKorean ? "사유: \(reason)" : "Reason: \(reason)"
        }
    }

    // Remove
    var removeSectionHeader: String { isKorean ? "연결 해제" : "Remove connection" }
    var removeSectionFooter: String {
        isKorean
            ? "앱에서 저장한 연결을 지우고 서버 환경 변수 설정으로 되돌립니다."
            : "Clears the connection saved in the app and reverts to the server environment configuration."
    }
    var removeConnection: String { isKorean ? "연결 해제" : "Remove connection" }
    var removingConnection: String { isKorean ? "해제 중" : "Removing" }
    var removedNotice: String { isKorean ? "연결을 해제했습니다." : "Connection removed." }
    var removeConfirmationTitle: String { isKorean ? "연결을 해제할까요?" : "Remove this connection?" }
    var removeConfirmationMessage: String {
        isKorean
            ? "저장된 bearer가 삭제되고 서버 환경 변수 설정으로 되돌아갑니다."
            : "The stored bearer is deleted and the server environment configuration takes over."
    }

    // Work host (ADR-0114)
    var workHostSectionHeader: String { isKorean ? "코드 실행 호스트 (work host)" : "Code execution host (work host)" }
    var workHostSectionFooter: String {
        isKorean
            ? "LLM provider와 별개 경로입니다. work host는 로컬 Codex CLI가 자체 등록하며, 그 자격증명은 해당 호스트에 남고 이 화면에서 설정하지 않습니다."
            : "A separate path from the LLM provider. The work host registers itself from a local Codex CLI; its credentials stay on that host and are not configured here."
    }
    var workHostStatusLabel: String { isKorean ? "상태" : "Status" }
    var workHostStatusValue: String { isKorean ? "이 화면에서 설정하지 않음" : "Not configured here" }
    var workHostGuidance: String {
        isKorean
            ? "work host 연결은 업무 콘솔의 로컬 CLI 페어링 흐름에서 설정합니다."
            : "Set up a work host from the local CLI pairing flow in the work console."
    }

    // Shared / states
    var cancel: String { isKorean ? "취소" : "Cancel" }
    var refresh: String { isKorean ? "상태 새로고침" : "Refresh status" }
    var loading: String { isKorean ? "AI 연결 불러오는 중" : "Loading AI connection" }
    var tryAgain: String { isKorean ? "다시 불러오기" : "Try again" }
    var unavailableTitle: String { isKorean ? "운영자 세션이 필요합니다" : "Operator session required" }
    var unavailableDescription: String {
        isKorean
            ? "실서버 운영자 세션으로 다시 로그인한 뒤 이 화면을 열면 AI provider 연결을 관리할 수 있어요."
            : "Sign back in with a live server operator session, then reopen this screen to manage the AI provider connection."
    }
    var offlineTitle: String { isKorean ? "서버에 연결할 수 없습니다" : "Server is offline" }
    var offlineDescription: String {
        isKorean
            ? "네트워크와 서버 상태를 확인한 뒤 다시 불러오세요."
            : "Check the network and server, then load the connection again."
    }
    var loadFailedTitle: String { isKorean ? "AI 연결을 불러오지 못했습니다" : "AI connection could not be loaded" }

    func mutationFailure(_ issue: MomoProviderLinkMutationIssue) -> String {
        if issue.failure == .invalidInput {
            switch (language, issue.action) {
            case (.korean, .save):
                return "base URL과 bearer를 확인하세요. base URL은 userinfo/쿼리/프래그먼트 없는 http(s) 주소여야 합니다."
            case (.english, .save):
                return "Check the base URL and bearer. The base URL must be an http(s) address without userinfo, query, or fragment."
            case (.korean, _):
                return "입력을 확인하고 다시 시도하세요."
            case (.english, _):
                return "Check the input and try again."
            }
        }
        let action: String
        switch (language, issue.action) {
        case (.korean, .save): action = "연결을 저장하지 못했습니다"
        case (.korean, .test): action = "연결을 테스트하지 못했습니다"
        case (.korean, .remove): action = "연결을 해제하지 못했습니다"
        case (.english, .save): action = "The connection was not saved"
        case (.english, .test): action = "The connection could not be tested"
        case (.english, .remove): action = "The connection was not removed"
        }
        return "\(action). \(failureDescription(issue.failure))"
    }

    func failureDescription(_ failure: MomoProviderLinkUserFailure) -> String {
        switch (language, failure) {
        case (.korean, .invalidInput):
            return "입력을 확인하고 다시 시도하세요."
        case (.korean, .unauthorized):
            return "운영자 세션이 만료되었습니다. 다시 로그인한 뒤 시도하세요."
        case (.korean, .forbidden):
            return "AI 연결을 관리할 권한이 없습니다. 서버 운영자에게 문의하세요."
        case (.korean, .conflict):
            return "서버의 연결 상태가 변경되었습니다. 상태를 새로고침한 뒤 시도하세요."
        case (.korean, .invalidResponse):
            return "서버 응답을 확인할 수 없습니다. 상태를 새로고침하거나 잠시 후 시도하세요."
        case (.korean, .offline):
            return "서버에 연결할 수 없습니다. 연결을 복구한 뒤 다시 시도하세요."
        case (.korean, .other):
            return "요청을 완료할 수 없습니다. 잠시 후 다시 시도하세요."
        case (.english, .invalidInput):
            return "Check the input and try again."
        case (.english, .unauthorized):
            return "Your operator session has expired. Sign in again, then retry."
        case (.english, .forbidden):
            return "You do not have permission to manage the AI connection. Contact a server operator."
        case (.english, .conflict):
            return "The connection changed on the server. Refresh the status, then retry."
        case (.english, .invalidResponse):
            return "The server response could not be verified. Refresh the status or try again later."
        case (.english, .offline):
            return "The server could not be reached. Restore the connection, then retry."
        case (.english, .other):
            return "The request could not be completed. Try again later."
        }
    }

    func timestamp(_ milliseconds: Int64) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(milliseconds) / 1_000)
        let locale = Locale(identifier: isKorean ? "ko_KR" : "en_US")
        return date.formatted(
            Date.FormatStyle(date: .abbreviated, time: .shortened).locale(locale)
        )
    }
}
