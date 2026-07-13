import SwiftUI

public struct OnboardingInviteView: View {
    @ObservedObject var viewModel: ChatViewModel
    @State private var inviteCode = ""

    public init(viewModel: ChatViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: MomoTheme.Onboarding.standardSpacing) {
            HStack(spacing: MomoTheme.Onboarding.standardSpacing) {
                TextField("Invite code", text: $inviteCode)
                    .textFieldStyle(.roundedBorder)
                    .disabled(viewModel.inviteJoinState.isWorking)
                    .onSubmit(submit)

                Button(action: submit) {
                    Label("Join workspace", systemImage: "person.badge.plus")
                }
                .buttonStyle(.borderedProminent)
                .disabled(inviteCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                          || viewModel.inviteJoinState.isWorking)
            }

            statusRow
        }
        .padding(.vertical, 4)
        .tint(MomoTheme.humanAccent)
    }

    @ViewBuilder
    private var statusRow: some View {
        switch viewModel.inviteJoinState {
        case .idle:
            Label("Enter an invite code to join a workspace.", systemImage: "ticket")
                .foregroundStyle(.secondary)
        case .validating(let code):
            HStack(spacing: MomoTheme.Onboarding.standardSpacing) {
                ProgressView()
                    .controlSize(.small)
                Text("Checking \(code)")
            }
            .foregroundStyle(.secondary)
        case .joined(let joined):
            Label {
                VStack(alignment: .leading, spacing: MomoTheme.Onboarding.compactSpacing) {
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
                VStack(alignment: .leading, spacing: MomoTheme.Onboarding.compactSpacing) {
                    Text(failure.reason)
                    Text(failure.recoveryHint ?? "Check the invite code and try joining again.")
                        .foregroundStyle(.secondary)
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
