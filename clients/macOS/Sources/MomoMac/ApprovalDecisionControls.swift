import SwiftUI
import MomoCore

/// Shared approval controls for the durable approval message and the composite
/// Work card. The server still owns the decision audit and run resume semantics.
struct ApprovalDecisionControls: View {
    let approvalId: ApprovalID?
    let status: ApprovalStatus
    let isInFlight: Bool
    let copy: MomoWorkspaceCopy
    let onDecision: ((ApprovalID, Bool) -> Void)?

    var body: some View {
        if status == .pending, let approvalId, let onDecision {
            HStack(spacing: 8) {
                Button {
                    onDecision(approvalId, true)
                } label: {
                    Label(copy.approve, systemImage: "checkmark.circle.fill")
                }
                .buttonStyle(.borderedProminent)

                Button {
                    onDecision(approvalId, false)
                } label: {
                    Label(copy.reject, systemImage: "xmark.circle")
                }
                .buttonStyle(.bordered)

                if isInFlight {
                    ProgressView()
                        .controlSize(.small)
                        .help(copy.workApprovalRecording)
                }
            }
            .controlSize(.small)
            .disabled(isInFlight)
            .padding(.top, 4)
        } else if status != .pending {
            Label(copy.approvalDecision(status), systemImage: decidedIcon)
                .font(.caption.weight(.semibold))
                .foregroundStyle(decidedColor)
                .padding(.top, 4)
        }
    }

    private var decidedColor: Color {
        status == .approved ? MomoTheme.reversibleGreen : MomoTheme.irreversibleRed
    }

    private var decidedIcon: String {
        switch status {
        case .approved:
            return "checkmark.circle.fill"
        case .rejected:
            return "xmark.circle.fill"
        case .expired:
            return "clock.badge.exclamationmark"
        case .cancelled:
            return "minus.circle.fill"
        case .pending:
            return "hourglass"
        }
    }
}
