import SwiftUI
import MomoCore

// MARK: - ApprovalInboxView  (experience C — Approval Inbox, placeholder)
//
// Surfaces every pending approval_request as a batchable 1st-class list (L4
// experiences §C). Each row: which agent / on-behalf-of (actor·subject delegation,
// L4 §7.3) / what action / estimated micro_usd / reversible badge. Supports the
// money-shot batch action "Approve all reversible" (irreversible auto-excluded).
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

    public init(viewModel: ChatViewModel) {
        self.viewModel = viewModel
        self.inspectorPresentation = .overlay
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
            header
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
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(copy.approvals) (\(pending.count))")
                    .font(MomoTheme.Typography.screenTitle)
                Text(copy.agentApprovalInboxSubtitle)
                    .font(MomoTheme.Typography.supporting)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer()
            if presentation.showsDeveloperDetails {
                // Batch action (experience C money-shot): approve only reversible ones.
                Button {
                    Task { await approveAllReversible() }
                } label: {
                    Label(copy.approveAllReversible, systemImage: "checkmark.circle")
                }
                .disabled(!pending.contains { $0.isReversible == true })
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    @ViewBuilder
    private func row(_ approval: ApprovalEvent) -> some View {
        let isInFlight = viewModel.approvalDecisionsInFlight.contains(approval.approvalId)
        HStack(alignment: .top, spacing: 10) {
            if presentation.showsDeveloperDetails {
                riskBadge(approval.isReversible)
            }
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
        .padding(12)
        .momoSurface(.card)
        .listRowInsets(EdgeInsets(top: 4, leading: 8, bottom: 4, trailing: 8))
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
    }

    @ViewBuilder
    private func riskBadge(_ reversible: Bool?) -> some View {
        let isReversible = reversible ?? false
        Circle()
            .fill(isReversible ? MomoTheme.reversibleGreen : MomoTheme.irreversibleRed)
            .frame(width: 10, height: 10)
            .padding(.top, 5)
            .help(isReversible ? copy.reversible : copy.irreversible)
    }

    private func approveAllReversible() async {
        for approval in pending
            where approval.isReversible == true
                && !viewModel.approvalDecisionsInFlight.contains(approval.approvalId) {
            await viewModel.decideApproval(approval.approvalId, approve: true)
        }
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
