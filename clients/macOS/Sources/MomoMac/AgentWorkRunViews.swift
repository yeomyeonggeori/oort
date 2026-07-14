import SwiftUI
import MomoCore

struct AgentWorkRunCard: View {
    let run: AgentWorkRun
    let agent: Member?
    let status: RunStatus
    let partial: AgentPartial?
    let approval: ApprovalEvent?
    let messages: [Message]
    let isApprovalInFlight: Bool
    let copy: MomoWorkspaceCopy
    var presentation: MomoDeveloperModePresentation = .standard
    let onApprovalDecision: (ApprovalID, Bool) -> Void
    let onOpenDetail: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isLogExpanded = false

    private var result: AgentWorkResultSummary {
        AgentWorkResultSummary(run: run, messages: messages, partial: partial)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header

            if presentation.showsDeveloperDetails || approval == nil {
                Text(cardSummary)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(presentation.showsDeveloperDetails ? 3 : nil)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if presentation.showsDeveloperDetails, result.tailText != nil {
                logTail
            }

            if approval != nil || status == .awaitingApproval {
                AgentWorkApprovalSection(
                    approval: approval,
                    isInFlight: isApprovalInFlight,
                    copy: copy,
                    agentName: agent?.displayName ?? copy.agent,
                    presentation: presentation,
                    onDecision: onApprovalDecision
                )
            }

            if presentation.showsDeveloperDetails, result.hasResult || status.isTerminal {
                AgentWorkResultSection(
                    result: result,
                    status: status,
                    error: runErrorText,
                    copy: copy,
                    isCompact: true
                )
            }

            HStack {
                Spacer()
                Button(action: onOpenDetail) {
                    Label(copy.openWorkDetails, systemImage: "sidebar.right")
                }
                .buttonStyle(.link)
            }
        }
        .padding(12)
        .frame(maxWidth: MomoTheme.Work.cardMaximumWidth, alignment: .leading)
        .background(
            MomoTheme.agentAccent.opacity(0.05),
            in: RoundedRectangle(cornerRadius: MomoTheme.bubbleCorner, style: .continuous)
        )
        .momoSurface(.card)
        .overlay {
            RoundedRectangle(cornerRadius: MomoTheme.bubbleCorner, style: .continuous)
                .stroke(MomoTheme.agentAccent.opacity(0.20), lineWidth: 1)
        }
        .accessibilityElement(children: .contain)
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "hammer")
                .font(.body.weight(.semibold))
                .foregroundStyle(MomoTheme.agentAccent)
                .frame(
                    width: MomoTheme.Work.statusIconSize,
                    height: MomoTheme.Work.statusIconSize
                )

            VStack(alignment: .leading, spacing: 4) {
                Text(run.input.title)
                    .font(MomoTheme.Typography.emphasizedRow)
                    .fixedSize(horizontal: false, vertical: true)
                Text(agent.map { "\($0.displayName)  @\($0.handle)" } ?? copy.agent)
                    .font(MomoTheme.Typography.supporting)
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 8)
            AgentWorkStatusChip(status: status, copy: copy)
        }
    }

    private var logTail: some View {
        VStack(alignment: .leading, spacing: 8) {
            // DisclosureGroup cannot keep the latest log tail visible while its
            // full content is collapsed, so a native button owns this two-state row.
            Button {
                if reduceMotion {
                    isLogExpanded.toggle()
                } else {
                    withAnimation(MomoTheme.Motion.stateChange) {
                        isLogExpanded.toggle()
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: isLogExpanded ? "chevron.down" : "chevron.right")
                    Text(copy.workLiveLog)
                        .font(MomoTheme.Typography.supporting.weight(.semibold))
                    Spacer()
                    Text(isLogExpanded ? copy.collapseWorkLog : copy.expandWorkLog)
                        .font(MomoTheme.Typography.supporting)
                        .foregroundStyle(.secondary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isLogExpanded ? copy.collapseWorkLog : copy.expandWorkLog)

            AgentTranscriptText(
                text: isLogExpanded ? result.transcript.joined(separator: "\n\n") : (result.tailText ?? ""),
                isStreaming: status == .running && partial != nil,
                lineLimit: isLogExpanded ? 12 : 2
            )
        }
        .padding(8)
        .momoSurface(.panel)
    }

    private var runErrorText: String? {
        run.error?["message"]?.stringValue
            ?? run.error?["detail"]?.stringValue
            ?? run.error?.stringValue
    }

    private var cardSummary: String {
        result.summary
            ?? partial?.textDelta
            ?? run.input.brief
    }
}

struct AgentWorkRunDetailView: View {
    @ObservedObject var viewModel: ChatViewModel
    let runId: RunID
    let copy: MomoWorkspaceCopy
    @AppStorage(MomoDeveloperModePresentation.developerModeKey) private var developerMode = false
    @AppStorage(MomoDeveloperModePresentation.costDisplayKey) private var showCosts = false

    var body: some View {
        Group {
            if let run = viewModel.workRun(runId) {
                detail(run)
            } else if viewModel.workRunDetailLoadingIds.contains(runId) {
                ProgressView(copy.workDetailsLoading)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                missingState
            }
        }
        .task {
            await viewModel.refreshWorkRun(runId)
        }
    }

    private func detail(_ run: AgentWorkRun) -> some View {
        let status = viewModel.effectiveWorkStatus(for: run)
        let approval = viewModel.workApproval(for: run.id)
        let partial = viewModel.partials[run.id]
        let result = AgentWorkResultSummary(
            run: run,
            messages: viewModel.workMessages(for: run.id),
            partial: partial
        )

        return ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 8) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(run.input.title)
                            .font(MomoTheme.Typography.screenTitle)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(run.input.brief)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 8)
                    AgentWorkStatusChip(status: status, copy: copy)
                }

                if presentation.showsDeveloperDetails {
                    GroupBox {
                        VStack(alignment: .leading, spacing: 8) {
                            LabeledContent(copy.workAgent) {
                                Text(viewModel.member(run.agentMemberId)?.displayName ?? copy.agent)
                            }
                            if let repo = run.input.repo {
                                LabeledContent(copy.workRepository) {
                                    Text(repo).font(.callout.monospaced())
                                }
                            }
                            if let branch = run.input.branch {
                                LabeledContent(copy.workBranch) {
                                    Text(branch).font(.callout.monospaced())
                                }
                            }
                            LabeledContent(copy.workCreatedAt) {
                                Text(
                                    Date(timeIntervalSince1970: Double(run.createdAtMs) / 1_000),
                                    format: .dateTime.year().month().day().hour().minute()
                                )
                                .monospacedDigit()
                            }
                        }
                    }
                } else {
                    Label(
                        viewModel.member(run.agentMemberId)?.displayName ?? copy.agent,
                        systemImage: "person.crop.circle"
                    )
                    .font(.callout)
                    .foregroundStyle(.secondary)
                }

                if approval != nil || status == .awaitingApproval {
                    AgentWorkApprovalSection(
                        approval: approval,
                        isInFlight: approval.map {
                            viewModel.approvalDecisionsInFlight.contains($0.approvalId)
                        } ?? false,
                        copy: copy,
                        agentName: viewModel.member(run.agentMemberId)?.displayName ?? copy.agent,
                        presentation: presentation,
                        onDecision: { approvalId, approve in
                            Task { await viewModel.decideApproval(approvalId, approve: approve) }
                        }
                    )
                }

                if presentation.showsDeveloperDetails {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(copy.workTranscript)
                            .font(MomoTheme.Typography.sectionHeader)
                        if result.transcript.isEmpty {
                            Text(copy.workTranscriptEmpty)
                                .font(.callout)
                                .foregroundStyle(.secondary)
                        } else {
                            AgentTranscriptText(
                                text: result.transcript.joined(separator: "\n\n"),
                                isStreaming: status == .running && partial != nil
                            )
                            .frame(
                                minHeight: MomoTheme.Work.transcriptMinimumHeight,
                                alignment: .topLeading
                            )
                        }
                    }
                }

                if result.hasResult || status.isTerminal {
                    if presentation.showsDeveloperDetails {
                        AgentWorkResultSection(
                            result: result,
                            status: status,
                            error: run.error?["message"]?.stringValue
                                ?? run.error?["detail"]?.stringValue
                                ?? run.error?.stringValue,
                            copy: copy,
                            isCompact: false
                        )
                    } else {
                        Text(result.summary ?? run.input.brief)
                            .font(.body)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                HStack {
                    Spacer()
                    Button {
                        Task { await viewModel.refreshWorkRun(run.id) }
                    } label: {
                        Label(copy.refreshWorkDetails, systemImage: "arrow.clockwise")
                    }
                    .disabled(viewModel.workRunDetailLoadingIds.contains(run.id))
                }
            }
            .padding(16)
        }
    }

    private var missingState: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(copy.workUnavailableTitle, systemImage: "exclamationmark.triangle")
                .font(.body.weight(.semibold))
            Text(
                viewModel.workDetailError(for: runId).map(copy.workError)
                    ?? copy.workUnavailableBody
            )
                .font(.callout)
                .foregroundStyle(.secondary)
            Button {
                Task { await viewModel.refreshWorkRun(runId) }
            } label: {
                Label(copy.refreshWorkDetails, systemImage: "arrow.clockwise")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(16)
    }

    private var presentation: MomoDeveloperModePresentation {
        MomoDeveloperModePresentation(
            isDeveloperModeEnabled: developerMode,
            isCostDisplayEnabled: showCosts
        )
    }
}

private struct AgentWorkApprovalSection: View {
    let approval: ApprovalEvent?
    let isInFlight: Bool
    let copy: MomoWorkspaceCopy
    let agentName: String
    let presentation: MomoDeveloperModePresentation
    let onDecision: (ApprovalID, Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if presentation.showsDeveloperDetails {
                Label(copy.workApprovalTitle, systemImage: "exclamationmark.shield")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(MomoTheme.costAmber)
                if let summary = approval?.payload["summary"]?.stringValue
                    ?? approval?.payload["title"]?.stringValue {
                    Text(summary)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                Text(copy.workApprovalSummary(
                    agentName: agentName,
                    action: approval?.payload["summary"]?.stringValue
                        ?? approval?.payload["title"]?.stringValue
                ))
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)
            }
            if let approval {
                ApprovalDecisionControls(
                    approvalId: approval.approvalId,
                    status: approval.status,
                    isInFlight: isInFlight,
                    copy: copy,
                    onDecision: onDecision
                )
            } else {
                HStack(spacing: 8) {
                    ProgressView()
                        .controlSize(.small)
                    Text(copy.workApprovalPendingSync)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            MomoTheme.costAmber.opacity(0.07),
            in: RoundedRectangle(cornerRadius: MomoTheme.bubbleCorner)
        )
        .momoSurface(.panel)
    }
}

private struct AgentWorkResultSection: View {
    let result: AgentWorkResultSummary
    let status: RunStatus
    let error: String?
    let copy: MomoWorkspaceCopy
    let isCompact: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(copy.workResult, systemImage: resultIcon)
                .font(.callout.weight(.semibold))
                .foregroundStyle(resultColor)

            Text(result.summary ?? fallbackSummary)
                .font(.callout)
                .lineLimit(isCompact ? 3 : nil)
                .fixedSize(horizontal: false, vertical: true)

            if let diffSummary = result.diffSummary {
                LabeledContent(copy.workDiffSummary) {
                    Text(diffSummary)
                        .font(.caption)
                        .lineLimit(isCompact ? 2 : nil)
                }
            }

            HStack(spacing: 12) {
                if let changedFileCount = result.changedFileCount {
                    Label(copy.workChangedFiles(changedFileCount), systemImage: "doc.on.doc")
                }
                if let exitCode = result.exitCode {
                    Label("\(copy.workExitCode) \(exitCode)", systemImage: "terminal")
                        .monospacedDigit()
                }
                Spacer(minLength: 0)
                if let pullRequestURL = result.pullRequestURL {
                    Link(destination: pullRequestURL) {
                        Label(copy.workPullRequest, systemImage: "arrow.up.right.square")
                    }
                }
            }
            .font(.caption)
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            resultColor.opacity(0.06),
            in: RoundedRectangle(cornerRadius: MomoTheme.bubbleCorner)
        )
        .momoSurface(.panel)
    }

    private var fallbackSummary: String {
        if status == .cancelled {
            return copy.workCancelledWithoutSummary
        }
        if let error, !error.isEmpty {
            return error
        }
        return status == .succeeded ? copy.workCompletedWithoutSummary : copy.workFailedWithoutSummary
    }

    private var resultColor: Color {
        switch AgentWorkResultPresentation.tone(for: status) {
        case .success:
            return MomoTheme.reversibleGreen
        case .neutral:
            return .secondary
        case .failure:
            return MomoTheme.irreversibleRed
        }
    }

    private var resultIcon: String {
        switch AgentWorkResultPresentation.tone(for: status) {
        case .success:
            return "checkmark.circle"
        case .neutral:
            return "minus.circle"
        case .failure:
            return "exclamationmark.triangle"
        }
    }
}

private struct AgentWorkStatusChip: View {
    let status: RunStatus
    let copy: MomoWorkspaceCopy

    var body: some View {
        Label(copy.workStatus(status), systemImage: systemImage)
            .font(.caption.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(color.opacity(0.10), in: Capsule())
            .fixedSize()
    }

    private var color: Color {
        switch status {
        case .queued, .cancelled:
            return .secondary
        case .running:
            return MomoTheme.agentAccent
        case .awaitingApproval, .paused:
            return MomoTheme.costAmber
        case .succeeded:
            return MomoTheme.reversibleGreen
        case .failed, .timedOut:
            return MomoTheme.irreversibleRed
        }
    }

    private var systemImage: String {
        switch status {
        case .queued:
            return "clock"
        case .running:
            return "play.circle"
        case .awaitingApproval:
            return "exclamationmark.shield"
        case .paused:
            return "pause.circle"
        case .succeeded:
            return "checkmark.circle"
        case .failed:
            return "xmark.circle"
        case .cancelled:
            return "minus.circle"
        case .timedOut:
            return "clock.badge.exclamationmark"
        }
    }
}
