import SwiftUI
import MomoCore

/// Admin "코드 실행 호스트" surface (WH-2, #706, ADR-0114 증보 1). It does two
/// things in one settings shell, kept visibly distinct from the LLM provider link
/// ("AI 연결", MOMO-574):
///   1. Shows this Mac's work-host pairing status (consumes the registration state
///      that `MomoWorkHostIdentityStore` backs).
///   2. Selects the instance execution engine (opencode default, goose, codex-local)
///      via the operator work-host-engine contract.
@MainActor
struct MomoWorkHostEngineSettingsView: View {
    private let copy: MomoWorkHostEngineCopy
    @StateObject private var model: MomoWorkHostEngineSettingsModel
    private let pairing: MomoWorkHostPairing
    private let onRetryPairing: () -> Void

    init(
        language: MomoUILanguage,
        context: MomoInviteAdminContext?,
        pairing: MomoWorkHostPairing = .waitingForSession,
        onRetryPairing: @escaping () -> Void = {},
        client: any MomoWorkHostEngineClient = MomoWorkHostEngineRESTClient()
    ) {
        self.copy = MomoWorkHostEngineCopy(language: language)
        self.pairing = pairing
        self.onRetryPairing = onRetryPairing
        _model = StateObject(wrappedValue: MomoWorkHostEngineSettingsModel(
            context: context,
            client: client
        ))
    }

    // Test-only initializer that injects a prepared model, used by snapshots.
    init(
        language: MomoUILanguage,
        model: MomoWorkHostEngineSettingsModel,
        pairing: MomoWorkHostPairing = .waitingForSession,
        onRetryPairing: @escaping () -> Void = {}
    ) {
        self.copy = MomoWorkHostEngineCopy(language: language)
        self.pairing = pairing
        self.onRetryPairing = onRetryPairing
        _model = StateObject(wrappedValue: model)
    }

    var body: some View {
        // Pairing (this Mac's registration) is locally known and independent of the
        // engine REST load, so it renders unconditionally. Only the engine section
        // reflects loadState, and it does so inline — a REST failure never hides the
        // pairing status, which is a primary purpose of this surface (WH-2 review).
        Form {
            pairingSection
            engineStateSection
            providerDistinctionSection
        }
        .formStyle(.grouped)
        .task {
            await model.loadIfNeeded()
        }
        .accessibilityIdentifier("work-host-settings")
    }

    // MARK: - Pairing status (this Mac as a work host)

    private var pairingSection: some View {
        Section {
            LabeledContent(copy.pairingStatusLabel) {
                pairingChip
            }
            if case .paired(let displayName, _, let lastSeenAtMs) = pairing {
                LabeledContent(copy.hostNameLabel) {
                    Text(displayName)
                        .momoTypography(.row)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                if let lastSeenAtMs {
                    LabeledContent(copy.lastSeenLabel) {
                        Text(copy.timestamp(lastSeenAtMs))
                            .momoTypography(.row)
                            .monospacedDigit()
                    }
                }
            }
            if case .failed(let error) = pairing {
                Label(error.message(copy: MomoWorkspaceCopy(language: copy.language)), systemImage: "exclamationmark.triangle")
                    .momoTypography(.supporting)
                    .foregroundStyle(MomoTheme.irreversibleRed)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    Spacer()
                    Button {
                        onRetryPairing()
                    } label: {
                        Label(copy.retryPairing, systemImage: "arrow.clockwise")
                    }
                }
            }
        } header: {
            Text(copy.pairingSectionHeader)
        } footer: {
            Text(copy.pairingSectionFooter)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // §1 custom-control justification: mirrors the provider-link status pill. AppKit
    // has no native semantic-tint status token, and a bordered Button would imply an
    // action while a plain Text loses the at-a-glance state. Read-only Capsule outline.
    private var pairingChip: some View {
        let connection = pairing.connection
        return Text(copy.pairingConnectionValue(connection))
            .momoTypography(.metadata)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .foregroundStyle(pairingColor(connection))
            .overlay {
                Capsule()
                    .stroke(pairingColor(connection), lineWidth: 1)
            }
            .accessibilityLabel(copy.pairingConnectionAccessibility(connection))
    }

    // MARK: - Execution engine selection

    // The engine concern loads over REST and can fail independently. It renders its
    // own state INLINE (loading/unavailable/offline/failed/loaded) inside this one
    // section so a failure degrades only the engine controls, never the whole surface.
    @ViewBuilder
    private var engineStateSection: some View {
        Section {
            switch model.loadState {
            case .idle, .loading:
                HStack(spacing: 12) {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityHidden(true)
                    Text(copy.loading)
                        .momoTypography(.supporting)
                        .foregroundStyle(.secondary)
                }

            case .unavailable:
                engineNotice(
                    icon: "server.rack",
                    title: copy.unavailableTitle,
                    description: copy.unavailableDescription,
                    showRetry: false
                )

            case .offline:
                engineNotice(
                    icon: "wifi.slash",
                    title: copy.offlineTitle,
                    description: copy.offlineDescription,
                    showRetry: true
                )

            case .failed(let failure):
                engineNotice(
                    icon: "exclamationmark.triangle",
                    title: copy.loadFailedTitle,
                    description: copy.failureDescription(failure),
                    showRetry: true
                )

            case .loaded:
                engineLoadedContent
            }
        } header: {
            engineSectionHeaderView
        } footer: {
            Text(copy.engineSectionFooter)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var engineSectionHeaderView: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Label(copy.engineSectionHeader, systemImage: "cpu")
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
    }

    @ViewBuilder
    private func engineNotice(
        icon: String,
        title: String,
        description: String,
        showRetry: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: icon)
                .momoTypography(.row)
            Text(description)
                .momoTypography(.supporting)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if showRetry {
                HStack(spacing: 8) {
                    Spacer()
                    Button(copy.tryAgain) {
                        Task { await model.load() }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var engineLoadedContent: some View {
        if let status = model.status {
            LabeledContent(copy.currentEngineLabel) {
                Text(copy.engineName(status.engine))
                    .momoTypography(.row)
            }
            LabeledContent(copy.sourceLabel) {
                Text(copy.sourceValue(status.source))
                    .momoTypography(.row)
            }
            if let updatedAtMs = status.updatedAtMs {
                LabeledContent(copy.updatedLabel) {
                    Text(copy.timestamp(updatedAtMs))
                        .momoTypography(.row)
                        .monospacedDigit()
                }
            }
        }

        Picker(selection: $model.engineDraft) {
                ForEach(MomoWorkHostEngine.allCases) { engine in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(copy.engineName(engine))
                            .momoTypography(.row)
                        Text(copy.engineSummary(engine))
                            .momoTypography(.metadata)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .tag(engine)
                }
            } label: {
                Text(copy.engineLabel)
            }
            .pickerStyle(.inline)
            .labelsHidden()
            .accessibilityIdentifier("work-host-engine-picker")

            // codex-local runs on THIS Mac; surface the coherence gap when the
            // selected engine needs a host that is currently offline / not paired.
            if model.engineDraft == .codexLocal, pairing.connection.isUnreachable {
                Label(copy.codexLocalUnreachableNote, systemImage: "exclamationmark.triangle")
                    .momoTypography(.supporting)
                    .foregroundStyle(MomoTheme.costAmber)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let issue = model.mutationIssue, issue.action == .save {
                feedbackLabel(copy.saveFailure(issue))
            }

            if model.notice == .saved {
                Label(copy.savedNotice, systemImage: "checkmark.circle")
                    .momoTypography(.supporting)
                    .foregroundStyle(MomoTheme.reversibleGreen)
            }

            HStack(spacing: 8) {
                Spacer()
                Button {
                    Task { await model.save() }
                } label: {
                    if model.operation == .saving {
                        HStack(spacing: 8) {
                            ProgressView()
                                .controlSize(.small)
                                .accessibilityHidden(true)
                            Text(copy.savingEngine)
                        }
                    } else {
                        Text(copy.saveEngine)
                    }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut("s", modifiers: [.command])
                .disabled(!model.canSave)
                .accessibilityLabel(
                    model.operation == .saving ? copy.savingEngine : copy.saveEngine
                )
            }
    }

    // MARK: - LLM provider distinction

    private var providerDistinctionSection: some View {
        Section {
            Label(copy.providerDistinction, systemImage: "brain")
                .momoTypography(.supporting)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        } header: {
            Text(copy.providerDistinctionHeader)
        }
    }

    private func feedbackLabel(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .momoTypography(.supporting)
            .foregroundStyle(MomoTheme.irreversibleRed)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func pairingColor(_ connection: MomoWorkHostPairingConnection) -> Color {
        switch connection {
        case .connected: return MomoTheme.reversibleGreen
        case .offline: return MomoTheme.costAmber
        case .pairing, .waiting: return .secondary
        case .notPaired: return MomoTheme.irreversibleRed
        }
    }
}

/// The pairing state of this Mac as a work host, projected from the work console's
/// registration state so the settings surface never re-implements registration.
enum MomoWorkHostPairing: Equatable {
    case waitingForSession
    case pairing
    case paired(displayName: String, online: Bool, lastSeenAtMs: Int64?)
    case failed(MomoWorkConsoleError)

    init(state: MomoWorkHostRegistrationState, heartbeatIssue: MomoWorkConsoleError?) {
        switch state {
        case .waitingForSession:
            self = .waitingForSession
        case .registering:
            self = .pairing
        case .ready(let host):
            // A heartbeat failure downgrades a ready host to offline even before the
            // registrar rewrites `online`, so the chip never over-reports liveness.
            self = .paired(
                displayName: host.displayName,
                online: host.online && heartbeatIssue == nil,
                lastSeenAtMs: host.lastSeenAtMs
            )
        case .failed(let error):
            self = .failed(error)
        }
    }

    var connection: MomoWorkHostPairingConnection {
        switch self {
        case .waitingForSession: return .waiting
        case .pairing: return .pairing
        case .paired(_, let online, _): return online ? .connected : .offline
        case .failed: return .notPaired
        }
    }
}

/// The at-a-glance pairing state the header chip reports.
enum MomoWorkHostPairingConnection: Equatable {
    case connected
    case offline
    case pairing
    case waiting
    case notPaired

    /// The host cannot currently run a host-local engine (codex-local): it is either
    /// offline or has never paired. `pairing`/`waiting` are transient and not flagged.
    var isUnreachable: Bool {
        self == .offline || self == .notPaired
    }
}

struct MomoWorkHostEngineCopy {
    let language: MomoUILanguage

    private var isKorean: Bool { language == .korean }

    // Pairing status
    var pairingSectionHeader: String { isKorean ? "페어링" : "Pairing" }
    var pairingSectionFooter: String {
        isKorean
            ? "이 Mac은 운영자 세션이 준비되면 코드 실행 호스트로 자동 등록됩니다. 실행 자격증명은 이 기기에 남습니다."
            : "This Mac registers itself as a code execution host once the operator session is ready. Execution credentials stay on this device."
    }
    var pairingStatusLabel: String { isKorean ? "상태" : "Status" }
    func pairingConnectionValue(_ connection: MomoWorkHostPairingConnection) -> String {
        switch (language, connection) {
        case (.korean, .connected): return "연결됨"
        case (.korean, .offline): return "오프라인"
        case (.korean, .pairing): return "페어링 중"
        case (.korean, .waiting): return "세션 대기"
        case (.korean, .notPaired): return "연결 안 됨"
        case (.english, .connected): return "Connected"
        case (.english, .offline): return "Offline"
        case (.english, .pairing): return "Pairing"
        case (.english, .waiting): return "Waiting for session"
        case (.english, .notPaired): return "Not paired"
        }
    }
    func pairingConnectionAccessibility(_ connection: MomoWorkHostPairingConnection) -> String {
        isKorean
            ? "코드 실행 호스트 상태: \(pairingConnectionValue(connection))"
            : "Code execution host status: \(pairingConnectionValue(connection))"
    }
    var hostNameLabel: String { isKorean ? "호스트 이름" : "Host name" }
    var lastSeenLabel: String { isKorean ? "마지막 확인" : "Last seen" }
    var retryPairing: String { isKorean ? "다시 페어링" : "Pair again" }

    // Engine selection
    var engineSectionHeader: String { isKorean ? "실행 엔진" : "Execution engine" }
    var engineSectionFooter: String {
        isKorean
            ? "선택한 엔진이 이 인스턴스의 모든 코드 실행에 적용됩니다."
            : "The selected engine applies to all code execution on this instance."
    }
    var engineLabel: String { isKorean ? "실행 엔진" : "Execution engine" }
    var currentEngineLabel: String { isKorean ? "현재 엔진" : "Current engine" }
    var sourceLabel: String { isKorean ? "설정 위치" : "Configured in" }
    func sourceValue(_ source: MomoWorkHostEngineSource) -> String {
        switch (language, source) {
        case (.korean, .database): return "앱에서 설정"
        case (.korean, .default): return "기본값"
        case (.english, .database): return "App settings"
        case (.english, .default): return "Default"
        }
    }
    var updatedLabel: String { isKorean ? "마지막 변경" : "Last updated" }
    func engineName(_ engine: MomoWorkHostEngine) -> String {
        // Engine identifiers are product names, kept verbatim in both languages.
        switch engine {
        case .opencode: return "opencode"
        case .goose: return "goose"
        case .codexLocal: return "codex-local"
        }
    }
    func engineSummary(_ engine: MomoWorkHostEngine) -> String {
        switch (language, engine) {
        case (.korean, .opencode):
            return "momo와 함께 배포되는 기본 엔진입니다. 별도 설치가 필요 없습니다."
        case (.korean, .goose):
            return "momo와 함께 배포되는 엔진입니다. 별도 설치가 필요 없습니다."
        case (.korean, .codexLocal):
            return "이 Mac에 설치된 Codex CLI에 연결합니다. 실행은 사용자 호스트에서 이뤄집니다."
        case (.english, .opencode):
            return "The default engine that ships with momo. No separate install is needed."
        case (.english, .goose):
            return "An engine that ships with momo. No separate install is needed."
        case (.english, .codexLocal):
            return "Connects to the Codex CLI installed on this Mac. Work runs on your own host."
        }
    }
    var saveEngine: String { isKorean ? "엔진 저장" : "Save engine" }
    var savingEngine: String { isKorean ? "저장 중" : "Saving" }
    var savedNotice: String { isKorean ? "실행 엔진을 저장했습니다." : "Execution engine saved." }
    var codexLocalUnreachableNote: String {
        isKorean
            ? "codex-local은 이 Mac에서 실행됩니다. 지금 이 Mac이 코드 실행 호스트로 연결돼 있지 않아 실행되지 않을 수 있어요."
            : "codex-local runs on this Mac. This Mac is not connected as a code execution host right now, so it may not run."
    }

    // Provider distinction
    var providerDistinctionHeader: String { isKorean ? "AI 연결과의 차이" : "How this differs from AI connection" }
    var providerDistinction: String {
        isKorean
            ? "LLM provider(AI 연결)와 별개 설정입니다. AI 연결은 에이전트 응답을 만드는 모델을, 코드 실행 호스트는 명령을 실행하는 엔진을 정합니다."
            : "This is separate from the LLM provider (AI connection). AI connection sets the model that writes agent replies; the code execution host sets the engine that runs commands."
    }

    // Shared / states
    var refresh: String { isKorean ? "상태 새로고침" : "Refresh status" }
    var loading: String { isKorean ? "코드 실행 호스트 불러오는 중" : "Loading code execution host" }
    var tryAgain: String { isKorean ? "다시 불러오기" : "Try again" }
    var unavailableTitle: String { isKorean ? "운영자 세션이 필요합니다" : "Operator session required" }
    var unavailableDescription: String {
        isKorean
            ? "실서버 운영자 세션으로 다시 로그인한 뒤 이 화면을 열면 코드 실행 호스트를 관리할 수 있어요."
            : "Sign back in with a live server operator session, then reopen this screen to manage the code execution host."
    }
    var offlineTitle: String { isKorean ? "서버에 연결할 수 없습니다" : "Server is offline" }
    var offlineDescription: String {
        isKorean
            ? "네트워크와 서버 상태를 확인한 뒤 다시 불러오세요."
            : "Check the network and server, then load the settings again."
    }
    var loadFailedTitle: String { isKorean ? "코드 실행 호스트를 불러오지 못했습니다" : "Code execution host could not be loaded" }

    func saveFailure(_ issue: MomoProviderLinkMutationIssue) -> String {
        if issue.failure == .invalidInput {
            return isKorean
                ? "선택한 엔진을 저장할 수 없습니다. 지원되는 엔진인지 확인하세요."
                : "The selected engine could not be saved. Check that it is a supported engine."
        }
        let action = isKorean ? "실행 엔진을 저장하지 못했습니다" : "The execution engine was not saved"
        return "\(action). \(failureDescription(issue.failure))"
    }

    func failureDescription(_ failure: MomoProviderLinkUserFailure) -> String {
        switch (language, failure) {
        case (.korean, .invalidInput):
            return "입력을 확인하고 다시 시도하세요."
        case (.korean, .unauthorized):
            return "운영자 세션이 만료되었습니다. 다시 로그인한 뒤 시도하세요."
        case (.korean, .forbidden):
            return "코드 실행 호스트를 관리할 권한이 없습니다. 서버 운영자에게 문의하세요."
        case (.korean, .conflict):
            return "서버의 설정이 변경되었습니다. 상태를 새로고침한 뒤 시도하세요."
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
            return "You do not have permission to manage the code execution host. Contact a server operator."
        case (.english, .conflict):
            return "The settings changed on the server. Refresh the status, then retry."
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
