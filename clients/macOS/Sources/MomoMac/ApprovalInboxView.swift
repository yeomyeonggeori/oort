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

    public init(viewModel: ChatViewModel) {
        self.viewModel = viewModel
    }

    private var pending: [ApprovalEvent] { viewModel.pendingApprovals }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            if pending.isEmpty {
                ContentUnavailableViewCompat(
                    title: "No pending approvals",
                    systemImage: "checkmark.seal",
                    description: "Agent actions that need a human decision will queue here."
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(pending, id: \.approvalId) { approval in
                    row(approval)
                }
                .listStyle(.inset)
            }
        }
    }

    private var header: some View {
        HStack {
            Text("Approvals (\(pending.count))").font(.headline)
            Spacer()
            // Batch action (experience C money-shot): approve only reversible ones.
            Button {
                Task { await approveAllReversible() }
            } label: {
                Label("Approve all reversible", systemImage: "checkmark.circle")
            }
            .disabled(!pending.contains { $0.isReversible == true })
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    @ViewBuilder
    private func row(_ approval: ApprovalEvent) -> some View {
        HStack(alignment: .top, spacing: 10) {
            // Reversibility risk badge.
            riskBadge(approval.isReversible)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(agentName(approval.requestedBy)).font(.subheadline.bold())
                    if let subject = approval.onBehalfOf {
                        Text("· \(delegationLabel(subject))")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                Text(approval.actionType).font(.callout.monospaced())
                if let cost = approval.estimatedMicroUSD {
                    Text("est. \(CostFormat.usd(cost))")
                        .font(.caption).foregroundStyle(MomoTheme.costAmber)
                }
            }
            Spacer()
            VStack(spacing: 6) {
                Button("승인") { Task { await viewModel.decideApproval(approval.approvalId, approve: true) } }
                    .buttonStyle(.borderedProminent).controlSize(.small)
                Button("거부") { Task { await viewModel.decideApproval(approval.approvalId, approve: false) } }
                    .buttonStyle(.bordered).controlSize(.small)
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func riskBadge(_ reversible: Bool?) -> some View {
        let isReversible = reversible ?? false
        Circle()
            .fill(isReversible ? MomoTheme.reversibleGreen : MomoTheme.irreversibleRed)
            .frame(width: 10, height: 10)
            .padding(.top, 5)
            .help(isReversible ? "reversible" : "irreversible")
    }

    private func approveAllReversible() async {
        for approval in pending where approval.isReversible == true {
            await viewModel.decideApproval(approval.approvalId, approve: true)
        }
    }

    private func agentName(_ id: MemberID) -> String {
        viewModel.member(id)?.displayName ?? "agent"
    }

    private func delegationLabel(_ subject: MemberID) -> String {
        "as \(viewModel.member(subject)?.displayName ?? "someone")"
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
