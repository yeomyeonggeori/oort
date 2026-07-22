import Foundation
import SwiftUI
import MomoCore

enum MomoAgentOrigin: String, Sendable, Equatable {
    case card
    case local
}

struct MomoAgentRegistration: Sendable, Equatable, Identifiable {
    let id: UUID
    let name: String
    let description: String?
    let url: URL
    let capabilities: JSON
    let securitySchemes: JSON

    var capabilitySummaries: [String] {
        guard let values = capabilities.objectValue else { return [] }
        return values.keys.sorted().compactMap { key in
            switch values[key] {
            case .bool(true): return key
            case .string(let value) where !value.isEmpty: return "\(key): \(value)"
            case .int(let value): return "\(key): \(value)"
            case .double(let value): return "\(key): \(value)"
            default: return nil
            }
        }
    }

    var securitySummaries: [String] {
        guard let schemes = securitySchemes["schemes"]?.objectValue else { return [] }
        return schemes.keys.sorted().map { name in
            guard let definition = schemes[name]?.objectValue else { return name }
            let method = definition["scheme"]?.stringValue
                ?? definition["type"]?.stringValue
                ?? name
            return method.caseInsensitiveCompare(name) == .orderedSame
                ? method
                : "\(name) (\(method))"
        }
    }
}

enum MomoAgentOnboardingState: Sendable, Equatable {
    case entry
    case loading
    case consent(MomoAgentRegistration)
    case confirming(MomoAgentRegistration)
    case failure(MomoAgentOnboardingFailure, registration: MomoAgentRegistration? = nil)
    case completed(MemberID)
}

enum MomoAgentOnboardingFailure: Sendable, Equatable {
    case serverReason(String)
    case offline
    case connection
    case invalidResponse
    case timedOut
    case unavailable
}

protocol MomoAgentOnboardingBackend: Sendable {
    func inspectAgentAddress(_ address: String) async throws -> MomoAgentRegistration
    func confirmAgentRegistration(_ registrationID: UUID) async throws -> MemberID
}

protocol MomoAgentOriginProvidingBackend: Sendable {
    func agentOrigins() async -> [MemberID: MomoAgentOrigin]
}

struct MomoAgentOriginBadge: View {
    let origin: MomoAgentOrigin
    let copy: MomoWorkspaceCopy

    var body: some View {
        // A native Label cannot express compact, noninteractive roster metadata.
        Text(copy.agentOrigin(origin))
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
            .background(.quaternary, in: Capsule())
            .accessibilityLabel(copy.agentOriginAccessibility(origin))
    }
}

struct MomoAgentOnboardingView: View {
    @ObservedObject var viewModel: ChatViewModel
    let copy: MomoWorkspaceCopy
    let onCompleted: (MemberID) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(copy.addAgent)
                    .font(.title3.weight(.semibold))
                Spacer(minLength: 8)
                Button(copy.cancel, role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }

            // 온보딩은 REST 전용 플로우라 realtime 상태로 프리게이트하지 않는다 —
            // 실제 연결 실패는 from-card 인라인 실패(.offline)가 정직하게 알린다.
            content
        }
        .padding(24)
        .frame(width: MomoTheme.AgentOnboarding.sheetWidth)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("agentAddressOnboarding")
        .onChange(of: viewModel.agentOnboardingState) { _, state in
            if case .completed(let memberID) = state {
                onCompleted(memberID)
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch viewModel.agentOnboardingState {
        case .entry, .completed:
            entryState(error: nil)
        case .loading:
            ProgressView(copy.readingAgentAddress)
                .frame(
                    maxWidth: .infinity,
                    minHeight: MomoTheme.AgentOnboarding.loadingMinimumHeight
                )
        case .consent(let registration):
            MomoAgentConsentSummaryView(
                registration: registration,
                copy: copy,
                isConfirming: false,
                confirm: confirm,
                back: viewModel.resetAgentOnboarding
            )
        case .confirming(let registration):
            MomoAgentConsentSummaryView(
                registration: registration,
                copy: copy,
                isConfirming: true,
                confirm: {},
                back: {}
            )
        case .failure(let failure, let registration):
            if let registration {
                VStack(alignment: .leading, spacing: 12) {
                    inlineFailure(copy.agentOnboardingFailure(failure))
                    MomoAgentConsentSummaryView(
                        registration: registration,
                        copy: copy,
                        isConfirming: false,
                        confirm: {
                            viewModel.retryAgentRegistrationConsent()
                            confirm()
                        },
                        back: viewModel.resetAgentOnboarding
                    )
                }
            } else {
                entryState(error: copy.agentOnboardingFailure(failure))
            }
        }
    }

    private func entryState(error: String?) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(copy.addAgentFromAddressDetail)
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            TextField(copy.agentAddress, text: $address)
                .textFieldStyle(.roundedBorder)
                .textContentType(.URL)
                .onSubmit(inspect)
                .accessibilityLabel(copy.agentAddress)

            if let error {
                inlineFailure(error)
            }

            HStack {
                Spacer()
                Button(action: inspect) {
                    Label(copy.reviewAgent, systemImage: "doc.text.magnifyingglass")
                }
                .keyboardShortcut(.defaultAction)
                .disabled(normalizedAddress.isEmpty)
            }
        }
    }


    private func inlineFailure(_ reason: String) -> some View {
        Label {
            VStack(alignment: .leading, spacing: 4) {
                Text(copy.agentAddressFailed)
                    .font(.callout.weight(.medium))
                Text(reason)
                    .font(.caption)
                    .textSelection(.enabled)
            }
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill")
        }
        .foregroundStyle(MomoTheme.irreversibleRed)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("agentAddressFailure")
    }

    private var normalizedAddress: String {
        address.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func inspect() {
        guard !normalizedAddress.isEmpty else { return }
        Task { await viewModel.inspectAgentAddress(normalizedAddress) }
    }

    private func confirm() {
        Task { _ = await viewModel.confirmAgentRegistration() }
    }
}

struct MomoAgentConsentSummaryView: View {
    let registration: MomoAgentRegistration
    let copy: MomoWorkspaceCopy
    let isConfirming: Bool
    let confirm: () -> Void
    let back: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(registration.name)
                    .font(.title3.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                if let description = registration.description, !description.isEmpty {
                    Text(description)
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text(registration.url.absoluteString)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .lineLimit(2)
            }

            GroupBox(copy.agentCapabilities) {
                summaryRows(
                    registration.capabilitySummaries,
                    emptyText: copy.noAgentCapabilities,
                    systemImage: "bolt"
                )
            }

            GroupBox(copy.agentAuthentication) {
                summaryRows(
                    registration.securitySummaries,
                    emptyText: copy.noAgentAuthentication,
                    systemImage: "lock"
                )
            }

            Label(copy.agentAuthenticationNotice, systemImage: "hand.raised")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 8) {
                Button(copy.editAgentAddress, action: back)
                    .disabled(isConfirming)
                Spacer()
                Button(action: confirm) {
                    HStack(spacing: 8) {
                        if isConfirming {
                            ProgressView()
                                .controlSize(.small)
                                .accessibilityHidden(true)
                        }
                        Text(isConfirming ? copy.addingAgent : copy.addAgentToWorkspace)
                    }
                    .foregroundStyle(Color(nsColor: .alternateSelectedControlTextColor))
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(isConfirming)
            }
        }
        .accessibilityIdentifier("agentConsentSummary")
    }

    private func summaryRows(
        _ values: [String],
        emptyText: String,
        systemImage: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if values.isEmpty {
                Text(emptyText)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(values, id: \.self) { value in
                    Label(value, systemImage: systemImage)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .font(.callout)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 8)
    }
}

extension MomoWorkspaceCopy {
    var addAgent: String { language == .korean ? "에이전트 추가" : "Add agent" }
    var agentAddress: String { language == .korean ? "에이전트 주소" : "Agent address" }
    var addAgentFromAddressDetail: String {
        language == .korean
            ? "에이전트 주소를 입력하면 공개된 이름, 설명, 능력과 인증 방식을 먼저 확인합니다."
            : "Enter an agent address to review its public name, description, capabilities, and authentication method."
    }
    var reviewAgent: String { language == .korean ? "에이전트 정보 확인" : "Review agent" }
    var readingAgentAddress: String { language == .korean ? "에이전트 정보 불러오는 중" : "Loading agent information" }
    var agentAddressFailed: String { language == .korean ? "에이전트 정보를 불러오지 못했습니다" : "Agent information could not be loaded" }
    var agentAddressOfflineTitle: String { language == .korean ? "오프라인 상태입니다" : "You are offline" }
    var agentAddressOfflineDetail: String {
        language == .korean
            ? "에이전트 정보를 확인하려면 서버 연결이 필요합니다. 연결한 뒤 다시 시도하세요."
            : "A server connection is required to review an agent. Reconnect and try again."
    }
    var agentCapabilities: String { language == .korean ? "할 수 있는 일" : "Capabilities" }
    var noAgentCapabilities: String { language == .korean ? "표시된 능력이 없습니다" : "No capabilities listed" }
    var agentAuthentication: String { language == .korean ? "인증 방식" : "Authentication" }
    var noAgentAuthentication: String { language == .korean ? "별도 인증 방식이 표시되지 않았습니다" : "No authentication method listed" }
    var agentAuthenticationNotice: String {
        language == .korean
            ? "인증 방식은 확인용 요약입니다. 이 화면에서는 비밀 정보나 인증 값을 입력하지 않습니다."
            : "Authentication is shown for review only. This screen never asks for secrets or credentials."
    }
    var editAgentAddress: String { language == .korean ? "주소 다시 입력" : "Edit address" }
    var addAgentToWorkspace: String { language == .korean ? "워크스페이스에 추가" : "Add to workspace" }
    var addingAgent: String { language == .korean ? "에이전트 추가 중" : "Adding agent" }
    func agentOrigin(_ origin: MomoAgentOrigin) -> String {
        switch (language, origin) {
        case (.korean, .card): "주소로 추가"
        case (.korean, .local): "직접 생성"
        case (.english, .card): "From address"
        case (.english, .local): "Created here"
        }
    }
    func agentOriginAccessibility(_ origin: MomoAgentOrigin) -> String {
        language == .korean
            ? "에이전트 출처, \(agentOrigin(origin))"
            : "Agent origin, \(agentOrigin(origin))"
    }
    func agentOnboardingFailure(_ failure: MomoAgentOnboardingFailure) -> String {
        switch (language, failure) {
        case (_, .serverReason(let reason)): reason
        case (.korean, .offline): "서버에 연결되어 있지 않습니다. 연결한 뒤 다시 시도하세요."
        case (.english, .offline): "You are not connected to the server. Reconnect and try again."
        case (.korean, .connection): "서버에 연결하지 못했습니다. 연결을 확인하고 다시 시도하세요."
        case (.english, .connection): "Could not connect to the server. Check your connection and try again."
        case (.korean, .invalidResponse): "에이전트 정보를 읽지 못했습니다. 주소 제공자에게 문의하거나 다른 주소를 사용하세요."
        case (.english, .invalidResponse): "Agent information could not be read. Contact the address provider or use another address."
        case (.korean, .timedOut): "응답 시간이 초과되었습니다. 잠시 후 다시 시도하세요."
        case (.english, .timedOut): "The request timed out. Try again in a moment."
        case (.korean, .unavailable): "요청을 완료하지 못했습니다. 다시 시도하세요."
        case (.english, .unavailable): "The request could not be completed. Try again."
        }
    }
}
