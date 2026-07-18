import SwiftUI
import MomoCore

// MARK: - ApprovalInboxView  (experience C — Approval Inbox, placeholder)
//
// Surfaces every pending approval_request as a batchable 1st-class list (L4
// experiences §C). Each row: which agent / on-behalf-of (actor·subject delegation,
// L4 §7.3) / what action / estimated micro_usd / reversible badge. Supports the
// batch action "Approve all" for the requests currently awaiting review.
//
// This is the v0 PLACEHOLDER per ticket T09: real rows + correct data wiring to
// decideApproval, but dry-run diff expansion + per-row swipe + risk filters are
// follow-up polish.
//
// TODO(T09-followup): filters (agent / risk / cost), card expand → dry-run diff
// (links experience H), iOS swipe actions.

public struct ApprovalInboxView: View {
    @ObservedObject var viewModel: ChatViewModel
    let inspectorPresentation: MomoInspectorPresentation
    let ownsInspectorSurface: Bool
    @AppStorage(MomoUILanguage.appStorageKey) private var languageRaw = MomoUILanguage.preferredDefault.rawValue
    @AppStorage(MomoDeveloperModePresentation.developerModeKey) private var developerMode = false
    @AppStorage(MomoDeveloperModePresentation.costDisplayKey) private var showCosts = false
    @State private var alwaysApproveEnabled = false
    @State private var showApproveAllConfirmation = false

    public init(viewModel: ChatViewModel) {
        self.viewModel = viewModel
        self.inspectorPresentation = .attached
        self.ownsInspectorSurface = true
    }

    init(
        viewModel: ChatViewModel,
        inspectorPresentation: MomoInspectorPresentation
    ) {
        self.viewModel = viewModel
        self.inspectorPresentation = inspectorPresentation
        self.ownsInspectorSurface = false
    }

    private var pending: [ApprovalEvent] { viewModel.pendingApprovals }
    private var copy: MomoWorkspaceCopy {
        MomoWorkspaceCopy(language: MomoUILanguage(rawValue: languageRaw) ?? .preferredDefault)
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            actionStrip
            Divider()
            if pending.isEmpty {
                ContentUnavailableViewCompat(
                    title: copy.noPendingApprovals,
                    systemImage: "checkmark.seal",
                    description: copy.agentApprovalInboxSubtitle
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(pending, id: \.approvalId) { approval in
                    row(approval)
                }
                .listStyle(.plain)
            }
        }
        .modifier(
            MomoApprovalInspectorSurfaceModifier(
                presentation: inspectorPresentation,
                ownsSurface: ownsInspectorSurface
            )
        )
        .confirmationDialog(
            copy.approveAllConfirmationTitle,
            isPresented: $showApproveAllConfirmation,
            titleVisibility: .visible
        ) {
            Button(copy.approveAll) {
                Task { await approveAll() }
            }
            Button(copy.cancel, role: .cancel) {}
        } message: {
            Text(copy.approveAllConfirmationMessage)
        }
        .onAppear(perform: loadAlwaysApprovePreference)
        .onChange(of: viewModel.workspaceId) { _, _ in
            loadAlwaysApprovePreference()
        }
        .onChange(of: alwaysApproveEnabled) { _, isEnabled in
            UserDefaults.standard.set(isEnabled, forKey: alwaysApproveStorageKey)
        }
        .task(id: automaticApprovalIDs) {
            for approvalID in automaticApprovalIDs {
                await viewModel.decideApproval(
                    approvalID,
                    approve: true,
                    reason: "approved automatically by local reversible-action preference"
                )
            }
        }
    }

    private var actionStrip: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                Text(pendingSummary)
                    .font(MomoTheme.Typography.supporting.weight(.medium))
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                Spacer()
                if !alwaysApproveEnabled {
                    Button {
                        if pending.contains(where: MomoAutomaticApprovalPolicy.requiresBatchConfirmation) {
                            showApproveAllConfirmation = true
                        } else {
                            Task { await approveAll() }
                        }
                    } label: {
                        Label(copy.approveAll, systemImage: "checkmark.circle")
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(pending.isEmpty)
                }
                Toggle(copy.alwaysApprove, isOn: $alwaysApproveEnabled)
                    .toggleStyle(.switch)
                    .controlSize(.small)
                    .help(copy.alwaysApproveHelp)
                    .accessibilityHint(copy.alwaysApproveHelp)
            }
            Text(copy.alwaysApproveScope)
                .font(MomoTheme.Typography.metadata)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private var pendingSummary: String {
        copy.language == .korean ? "확인이 필요한 요청 \(pending.count)개" : "\(pending.count) requests need review"
    }

    @ViewBuilder
    private func row(_ approval: ApprovalEvent) -> some View {
        let isInFlight = viewModel.approvalDecisionsInFlight.contains(approval.approvalId)
        let didFail = viewModel.approvalDecisionFailedIds.contains(approval.approvalId)
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 3) {
                if presentation.showsDeveloperDetails {
                    HStack(spacing: 6) {
                        Text(agentName(approval.requestedBy)).font(MomoTheme.Typography.emphasizedRow)
                        if let subject = approval.onBehalfOf {
                            Text("· \(delegationLabel(subject))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Text(approval.actionType).font(.callout.monospaced())
                    if presentation.showsCosts, let cost = approval.estimatedMicroUSD {
                        Text(copy.estimatedCost(CostFormat.usd(cost)))
                            .font(MomoTheme.Typography.supporting).foregroundStyle(MomoTheme.costAmber)
                    }
                } else {
                    Text(copy.workApprovalSummary(
                        agentName: agentName(approval.requestedBy),
                        action: approval.payload["summary"]?.stringValue
                            ?? approval.payload["title"]?.stringValue
                    ))
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)
                }
                    riskLabel(approval.isReversible)
                }
                Spacer()
                VStack(spacing: 6) {
                    Button(copy.approve) { Task { await viewModel.decideApproval(approval.approvalId, approve: true) } }
                        .buttonStyle(.borderedProminent).controlSize(.small)
                    Button(copy.reject) { Task { await viewModel.decideApproval(approval.approvalId, approve: false) } }
                        .buttonStyle(.bordered).controlSize(.small)
                    if isInFlight {
                        ProgressView().controlSize(.small)
                    }
                }
                .disabled(isInFlight)
            }
            if didFail {
                Label(
                    copy.language == .korean ? "처리하지 못했습니다. 다시 시도해 주세요." : "Could not complete. Try again.",
                    systemImage: "exclamationmark.circle"
                )
                .font(MomoTheme.Typography.metadata)
                .foregroundStyle(MomoTheme.irreversibleRed)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel(copy.language == .korean ? "승인 처리 실패" : "Approval failed")
            }
        }
        .padding(.vertical, 8)
        .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
        .listRowSeparator(.visible)
    }

    private func riskLabel(_ reversible: Bool?) -> some View {
        let isReversible = reversible ?? false
        return Label(
            isReversible ? copy.reversible : copy.irreversible,
            systemImage: isReversible ? "arrow.uturn.backward.circle" : "exclamationmark.shield"
        )
            .font(MomoTheme.Typography.metadata.weight(.medium))
            .foregroundStyle(isReversible ? MomoTheme.reversibleGreen : MomoTheme.irreversibleRed)
            .help(isReversible ? copy.reversible : copy.irreversible)
    }

    private func approveAll() async {
        for approval in pending
            where !viewModel.approvalDecisionsInFlight.contains(approval.approvalId) {
            await viewModel.decideApproval(approval.approvalId, approve: true)
        }
    }

    private var automaticApprovalIDs: [ApprovalID] {
        guard alwaysApproveEnabled else { return [] }
        return pending
            .filter(MomoAutomaticApprovalPolicy.isEligibleForAutomaticApproval)
            .map(\.approvalId)
    }

    private var alwaysApproveStorageKey: String {
        let workspaceScope = viewModel.workspaceId?.description ?? "local"
        return "momo.approvals.auto-approve-reversible.\(workspaceScope)"
    }

    private func loadAlwaysApprovePreference() {
        alwaysApproveEnabled = UserDefaults.standard.bool(forKey: alwaysApproveStorageKey)
    }

    private func agentName(_ id: MemberID) -> String {
        viewModel.member(id)?.displayName ?? "agent"
    }

    private func delegationLabel(_ subject: MemberID) -> String {
        copy.approvalDelegationLabel(viewModel.member(subject)?.displayName ?? "someone")
    }

    private var presentation: MomoDeveloperModePresentation {
        MomoDeveloperModePresentation(
            isDeveloperModeEnabled: developerMode,
            isCostDisplayEnabled: showCosts
        )
    }
}

enum MomoAutomaticApprovalPolicy {
    static func isEligibleForAutomaticApproval(_ approval: ApprovalEvent) -> Bool {
        approval.isReversible == true
    }

    static func requiresBatchConfirmation(_ approval: ApprovalEvent) -> Bool {
        approval.isReversible != true
    }
}

private struct MomoApprovalInspectorSurfaceModifier: ViewModifier {
    let presentation: MomoInspectorPresentation
    let ownsSurface: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if ownsSurface {
            content.momoInspectorSurface(presentation)
        } else {
            content
        }
    }
}

// A tiny back-compat empty-state so the package builds on macOS 14 (where
// ContentUnavailableView already exists, but we keep this trivial + dependency-free).
struct ContentUnavailableViewCompat: View {
    let title: String
    let systemImage: String
    let description: String

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: systemImage)
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text(title).font(.headline)
            Text(description)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
    }
}
