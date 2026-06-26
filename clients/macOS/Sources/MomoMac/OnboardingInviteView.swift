import SwiftUI

public struct OnboardingInviteView: View {
    @ObservedObject var viewModel: ChatViewModel
    @State private var inviteCode = "MOMO-012"

    public init(viewModel: ChatViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                TextField("Invite code", text: $inviteCode)
                    .textFieldStyle(.roundedBorder)
                    .disabled(viewModel.inviteJoinState.isWorking)
                    .onSubmit(submit)

                Button(action: submit) {
                    Image(systemName: "arrow.right.circle.fill")
                }
                .buttonStyle(.borderless)
                .disabled(inviteCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                          || viewModel.inviteJoinState.isWorking)
                .help("Join workspace")
            }

            statusRow
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private var statusRow: some View {
        switch viewModel.inviteJoinState {
        case .idle:
            Label("Ready for dev invite", systemImage: "person.badge.plus")
                .foregroundStyle(.secondary)
        case .validating(let code):
            Label("Checking \(code)", systemImage: "clock")
                .foregroundStyle(MomoTheme.costAmber)
        case .joined(let joined):
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Joined \(joined.workspace.name)")
                    Text("\(joined.role) · \(joined.defaultChannelNames.joined(separator: ", "))")
                        .foregroundStyle(.secondary)
                }
            } icon: {
                Image(systemName: "checkmark.circle.fill")
            }
            .foregroundStyle(MomoTheme.reversibleGreen)
        case .failed(let failure):
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text(failure.reason)
                    if let hint = failure.recoveryHint {
                        Text(hint).foregroundStyle(.secondary)
                    }
                }
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill")
            }
            .foregroundStyle(MomoTheme.irreversibleRed)
        }
    }

    private func submit() {
        let code = inviteCode
        Task { await viewModel.submitInviteCode(code) }
    }
}
