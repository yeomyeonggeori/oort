import SwiftUI
import MomoCore

struct MomoMessageThreadPanel: View {
    @ObservedObject var viewModel: ChatViewModel
    let root: Message
    let copy: MomoWorkspaceCopy
    let presentation: MomoDeveloperModePresentation
    let onClose: () -> Void

    @State private var replyDraft = ""
    @State private var isSending = false
    @FocusState private var isComposerFocused: Bool

    private var replies: [Message] { viewModel.replies(to: root) }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    threadMessage(root, isRoot: true)
                    Divider()
                        .padding(.vertical, 4)

                    if viewModel.isSelectedChannelHistoryLoading && replies.isEmpty {
                        ProgressView(copy.timelineLoading)
                            .frame(maxWidth: .infinity, minHeight: 120)
                    } else if replies.isEmpty {
                        VStack(spacing: MomoTheme.MessageInteraction.standardSpacing) {
                            Text(copy.threadEmpty)
                                .font(MomoTheme.Typography.supporting)
                                .foregroundStyle(.secondary)
                            Button(copy.threadEmptyAction) { isComposerFocused = true }
                                .buttonStyle(.borderless)
                        }
                        .frame(maxWidth: .infinity, minHeight: MomoTheme.MessageInteraction.threadComposerMaximumHeight)
                    } else {
                        ForEach(replies) { reply in
                            threadMessage(reply, isRoot: false)
                        }
                    }
                }
                .padding(12)
            }

            if viewModel.connectionIssue != nil {
                Label(
                    copy.language == .korean ? "연결이 복구되면 답글을 다시 보낼 수 있습니다." : "Replies can be retried when the connection recovers.",
                    systemImage: "wifi.exclamationmark"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
            }

            Divider()
            composer
        }
        .frame(
            minWidth: 0,
            idealWidth: MomoTheme.MessageInteraction.threadIdealWidth,
            maxWidth: MomoTheme.MessageInteraction.threadMaximumWidth,
            maxHeight: .infinity
        )
        .momoSurface(.panel, cornerRadius: 0)
    }

    private var header: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(copy.threadTitle)
                    .font(MomoTheme.Typography.emphasizedRow)
                Text(viewModel.selectedChannel?.name ?? "")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button(action: onClose) {
                Image(systemName: "xmark")
            }
            .buttonStyle(.borderless)
            .momoQuickTooltip(copy.closeThread)
            .accessibilityLabel(copy.closeThread)
            .keyboardShortcut(.escape, modifiers: [])
        }
        .padding(.horizontal, MomoTheme.MessageInteraction.edgeInset)
        .frame(height: MomoWindowChromeLayout.integratedHeaderHeight)
    }

    private func threadMessage(_ message: Message, isRoot: Bool) -> some View {
        MessageBubble(
            message: message,
            author: viewModel.member(message.authorMemberId),
            reactions: viewModel.reactions(for: message),
            canModify: viewModel.supportsMessageInteractions
                && viewModel.isCurrentMemberMessage(message),
            interactionError: viewModel.messageInteractionErrors[message.id],
            onToggleReaction: viewModel.supportsMessageInteractions
                ? { emoji in
                    Task { await viewModel.toggleReaction(emoji, on: message) }
                }
                : nil,
            onEdit: viewModel.supportsMessageInteractions
                ? { body in
                    await viewModel.editMessage(message, body: body)
                }
                : nil,
            onDelete: viewModel.supportsMessageInteractions
                ? {
                    Task {
                        let didDelete = await viewModel.deleteMessage(message)
                        if didDelete, isRoot { onClose() }
                    }
                }
                : nil,
            onDismissInteractionError: {
                viewModel.clearMessageInteractionError(message.id)
            },
            groupingStyle: .groupStart,
            timelineCopy: copy,
            presentation: presentation
        )
    }

    private var composer: some View {
        VStack(alignment: .trailing, spacing: 8) {
            ZStack(alignment: .topLeading) {
                TextEditor(text: $replyDraft)
                    .font(.body)
                    .frame(
                        minHeight: MomoTheme.MessageInteraction.editorMinimumHeight,
                        maxHeight: MomoTheme.MessageInteraction.threadComposerMaximumHeight
                    )
                    .padding(MomoTheme.MessageInteraction.standardSpacing)
                    .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: MomoTheme.cornerMedium))
                    .overlay(RoundedRectangle(cornerRadius: MomoTheme.cornerMedium).strokeBorder(.separator, lineWidth: 1))
                    .focused($isComposerFocused)
                    .accessibilityLabel(copy.replyPlaceholder)

                if replyDraft.isEmpty {
                    Text(copy.replyPlaceholder)
                        .font(.body)
                        .foregroundStyle(.tertiary)
                        .padding(.leading, MomoTheme.MessageInteraction.edgeInset)
                        .padding(.top, MomoTheme.MessageInteraction.edgeInset)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
            .disabled(viewModel.connectionIssue != nil)

            Button {
                sendReply()
            } label: {
                if isSending {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Label(copy.sendMessage, systemImage: "paperplane.fill")
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(
                isSending
                    || viewModel.connectionIssue != nil
                    || replyDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            )
            .keyboardShortcut(.return, modifiers: .command)
        }
        .padding(12)
    }

    private func sendReply() {
        let body = replyDraft
        guard !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        isSending = true
        Task {
            let didSend = await viewModel.sendReply(
                body: body,
                to: root,
                replyingTo: replies.last(where: { $0.state != .failed })
            )
            if didSend {
                replyDraft = ""
            }
            isSending = false
            isComposerFocused = true
        }
    }
}
