import AppKit
import SwiftUI
import MomoCore

struct MomoAgentCredentialManagementView: View {
    let copy: MomoWorkspaceCopy
    let agent: Member
    @ObservedObject var viewModel: ChatViewModel
    let onReveal: (MomoAgentCredentialReveal) -> Void

    @State private var actionInFlight = false
    @State private var notice: String?
    @State private var errorMessage: String?
    @State private var pendingRevoke: MomoAgentCredential?

    var body: some View {
        MomoAgentCredentialManagementContent(
            copy: copy,
            credentials: viewModel.agentCredentials(for: agent.id),
            isLoading: viewModel.isLoadingAgentCredentials(for: agent.id),
            actionInFlight: actionInFlight,
            notice: notice,
            errorMessage: errorMessage,
            issueOrRotate: issueOrRotate,
            retry: refresh,
            requestRevoke: { pendingRevoke = $0 }
        )
        .task(id: agent.id) {
            await refresh()
        }
        .confirmationDialog(
            copy.revokeAgentCredentialTitle,
            isPresented: Binding(
                get: { pendingRevoke != nil },
                set: { if !$0 { pendingRevoke = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button(copy.revokeAgentCredential, role: .destructive) {
                guard let credential = pendingRevoke else { return }
                pendingRevoke = nil
                revoke(credential)
            }
            Button(copy.cancel, role: .cancel) {
                pendingRevoke = nil
            }
        } message: {
            Text(copy.revokeAgentCredentialConfirmation)
        }
    }

    private func refresh() {
        Task { await refresh() }
    }

    @MainActor
    private func refresh() async {
        errorMessage = nil
        do {
            try await viewModel.refreshAgentCredentials(for: agent.id)
        } catch {
            errorMessage = copy.agentCredentialErrorMessage(error)
        }
    }

    private func issueOrRotate() {
        guard !actionInFlight else { return }
        actionInFlight = true
        notice = nil
        errorMessage = nil
        Task {
            defer { actionInFlight = false }
            do {
                let reveal = try await viewModel.issueAgentCredential(for: agent.id)
                onReveal(reveal)
            } catch {
                errorMessage = copy.agentCredentialErrorMessage(error)
            }
        }
    }

    private func revoke(_ credential: MomoAgentCredential) {
        guard !actionInFlight else { return }
        actionInFlight = true
        notice = nil
        errorMessage = nil
        Task {
            defer { actionInFlight = false }
            do {
                try await viewModel.revokeAgentCredential(credential.id, for: agent.id)
                notice = copy.agentCredentialRevokedRecovery
            } catch {
                errorMessage = copy.agentCredentialErrorMessage(error)
            }
        }
    }
}

struct MomoAgentCredentialManagementContent: View {
    let copy: MomoWorkspaceCopy
    let credentials: [MomoAgentCredential]
    let isLoading: Bool
    let actionInFlight: Bool
    let notice: String?
    let errorMessage: String?
    let issueOrRotate: () -> Void
    let retry: () -> Void
    let requestRevoke: (MomoAgentCredential) -> Void

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 12) {
                Text(copy.agentCredentialSectionSubtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                if isLoading && credentials.isEmpty {
                    Label(copy.agentCredentialLoading, systemImage: "arrow.triangle.2.circlepath")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                } else if credentials.isEmpty {
                    Label(copy.noAgentCredentials, systemImage: "key.slash")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                } else {
                    credentialRows
                }

                if let notice {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: "checkmark.circle")
                            .foregroundStyle(MomoTheme.reversibleGreen)
                        Text(notice)
                            .foregroundStyle(.primary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .font(.caption)
                }

                if let errorMessage {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Image(systemName: "exclamationmark.triangle")
                                .foregroundStyle(MomoTheme.irreversibleRed)
                            Text(errorMessage)
                                .foregroundStyle(.primary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .font(.caption)
                        Button(copy.retry, action: retry)
                            .controlSize(.small)
                    }
                }

                Divider()

                Text(copy.agentCredentialRotationHint)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                HStack {
                    Spacer()
                    Button(action: issueOrRotate) {
                        Label(primaryActionTitle, systemImage: "arrow.triangle.2.circlepath.key")
                    }
                    .keyboardShortcut("r", modifiers: [.command, .shift])
                    .disabled(actionInFlight || isLoading)
                }

                Label(copy.agentCredential401Recovery, systemImage: "lifepreserver")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(4)
        } label: {
            Label(copy.agentCredentialSectionTitle, systemImage: "key.horizontal")
                .font(.subheadline.weight(.semibold))
        }
    }

    private var primaryActionTitle: String {
        credentials.contains { $0.displayStatus() != .revoked }
            ? copy.rotateAgentCredential
            : copy.issueAgentCredential
    }

    private var credentialRows: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(credentials.enumerated()), id: \.element.id) { index, credential in
                if index > 0 {
                    Divider()
                }
                credentialRow(credential)
            }
        }
    }

    private func credentialRow(_ credential: MomoAgentCredential) -> some View {
        let status = credential.displayStatus()
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(credential.label ?? copy.agentCredentialDefaultLabel)
                        .font(.body.weight(.semibold))
                        .lineLimit(1)
                    Text(copy.agentCredentialCreated(credential.createdAtMs))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                statusChip(status)
                Menu {
                    Button(role: .destructive) {
                        requestRevoke(credential)
                    } label: {
                        Label(copy.revokeAgentCredential, systemImage: "key.slash")
                    }
                    .disabled(status == .revoked || actionInFlight)
                } label: {
                    Label(copy.agentCredentialActions, systemImage: "ellipsis.circle")
                        .labelStyle(.iconOnly)
                }
                .menuStyle(.borderlessButton)
                .help(copy.agentCredentialActions)
            }

            HStack(spacing: 12) {
                Label(
                    credential.lastUsedAtMs.map(copy.agentCredentialLastUsed) ?? copy.agentCredentialNeverUsed,
                    systemImage: "clock"
                )
                if let expiresAtMs = credential.expiresAtMs {
                    Label(copy.agentCredentialExpires(expiresAtMs), systemImage: "calendar.badge.clock")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .contextMenu {
            Button(role: .destructive) {
                requestRevoke(credential)
            } label: {
                Label(copy.revokeAgentCredential, systemImage: "key.slash")
            }
            .disabled(status == .revoked || actionInFlight)
        }
    }

    private func statusChip(_ status: MomoAgentCredentialDisplayStatus) -> some View {
        // macOS has no compact lifecycle status control that can express these
        // text-first configured/active/expiring/revoked states.
        Text(copy.agentCredentialStatus(status))
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .foregroundStyle(.primary)
            .background(status.tint.opacity(0.12), in: Capsule())
            .overlay {
                Capsule()
                    .stroke(status.tint.opacity(0.5), lineWidth: 1)
            }
            .accessibilityLabel(copy.agentCredentialStatusAccessibility(status))
    }
}

struct MomoAgentCredentialRevealSheet: View {
    let copy: MomoWorkspaceCopy
    let reveal: MomoAgentCredentialReveal
    @Environment(\.dismiss) private var dismiss
    @State private var copiedMessage: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "key.viewfinder")
                        .font(.title3)
                        .foregroundStyle(MomoTheme.agentAccent)

                    VStack(alignment: .leading, spacing: 4) {
                        Text(copy.agentCredentialOneTimeTitle)
                            .font(.title3.weight(.semibold))
                        Text(copy.agentCredentialOneTimeSubtitle)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                GroupBox(copy.agentCredentialTokenLabel) {
                    Text(reveal.token)
                        .font(.callout.monospaced())
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                        .accessibilityLabel(copy.agentCredentialTokenAccessibility)
                }

                HStack(spacing: 8) {
                    Button {
                        copyToPasteboard(reveal.token)
                        copiedMessage = copy.agentCredentialTokenCopied
                    } label: {
                        Label(copy.copyAgentCredentialToken, systemImage: "doc.on.doc")
                    }
                    .keyboardShortcut("c", modifiers: [.command, .shift])

                    Button {
                        copyToPasteboard(reveal.environmentLine)
                        copiedMessage = copy.agentCredentialEnvironmentLineCopied
                    } label: {
                        Label(copy.copyAgentCredentialEnvironmentLine, systemImage: "terminal")
                    }
                }

                GroupBox {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("~/.momo/hermes-gateway.env")
                            .font(.callout.monospaced())
                            .textSelection(.enabled)
                        Text(copy.agentCredentialEnvironmentInstructions)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                } label: {
                    Label(copy.agentCredentialEnvironmentTitle, systemImage: "folder.badge.gearshape")
                }

                if let graceEndsAtMs = reveal.rotationGraceEndsAtMs {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: "clock.arrow.2.circlepath")
                            .foregroundStyle(MomoTheme.costAmber)
                        Text(copy.agentCredentialGraceMessage(graceEndsAtMs))
                            .foregroundStyle(.primary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .font(.caption)
                }

                if let copiedMessage {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: "checkmark.circle")
                            .foregroundStyle(MomoTheme.reversibleGreen)
                        Text(copiedMessage)
                            .foregroundStyle(.primary)
                    }
                    .font(.caption)
                }

                Label(copy.agentCredentialRevealSecurityNote, systemImage: "lock.shield")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                HStack {
                    Spacer()
                    Button(copy.done) {
                        dismiss()
                    }
                    .keyboardShortcut(.defaultAction)
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(
            minWidth: MomoTheme.credentialRevealMinimumWidth,
            idealWidth: MomoTheme.credentialRevealIdealWidth,
            maxWidth: MomoTheme.credentialRevealMaximumWidth
        )
    }

    private func copyToPasteboard(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

private extension MomoAgentCredentialDisplayStatus {
    var tint: Color {
        switch self {
        case .configured:
            return MomoTheme.agentAccent
        case .active:
            return MomoTheme.reversibleGreen
        case .expiring:
            return MomoTheme.costAmber
        case .revoked:
            return MomoTheme.irreversibleRed
        }
    }
}
