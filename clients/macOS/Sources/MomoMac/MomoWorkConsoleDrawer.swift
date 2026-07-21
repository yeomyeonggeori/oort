import AppKit
import SwiftUI

struct MomoWorkConsoleDrawer: View {
    @ObservedObject var controller: MomoWorkConsoleController
    @ObservedObject var preferences: MomoWorkConsolePreferences
    let copy: MomoWorkspaceCopy
    let onClose: () -> Void
    @State private var showsNewSession = false
    @State private var showsSettings = false

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if MomoWorkHostRuntime.isAppSandboxed {
                sandboxNotice
                Divider()
            }
            if showsHostRegistrationNotice {
                hostRegistrationNotice
                Divider()
            }
            if let issue = controller.lastIssue {
                issueBanner(issue)
                Divider()
            }
            GeometryReader { geometry in
                let sessionListWidth = MomoWorkConsoleLayout.sessionListWidth(
                    preferredWidth: preferences.sessionListWidth,
                    availableWidth: geometry.size.width
                )
                HStack(spacing: 0) {
                    sessionList
                        .frame(width: sessionListWidth)
                        .overlay(alignment: .trailing) {
                            MomoWorkConsoleResizeHandle(
                                value: sessionListWidth,
                                direction: .right,
                                onResize: { proposedWidth in
                                    updateLayout {
                                        preferences.setSessionListWidth(proposedWidth)
                                    }
                                },
                                onReset: {
                                    updateLayout {
                                        preferences.resetSessionListWidth()
                                    }
                                },
                                accessibilityLabel: copy.resizeWorkSessionList,
                                accessibilityValue: copy.workSessionListWidthValue(sessionListWidth),
                                resetLabel: copy.resetWorkSessionListSize
                            )
                        }
                    Divider()
                    sessionDetail
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        .momoFlatSurface(.panel)
        .sheet(isPresented: $showsNewSession) {
            MomoNewWorkSessionSheet(controller: controller, copy: copy)
        }
        .onDisappear {
            controller.disconnectRemoteTerminals()
        }
    }

    private var header: some View {
        HStack(spacing: MomoTheme.WorkConsole.standardSpacing) {
            Image(systemName: "terminal")
                .foregroundStyle(MomoTheme.agentAccent)
            VStack(alignment: .leading, spacing: 0) {
                Text(copy.workConsole)
                    .momoTypography(.emphasizedRow)
                Text(copy.workConsoleSubtitle)
                    .momoTypography(.metadata)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            Button {
                Task { await controller.refresh() }
            } label: {
                Label(copy.workConsoleRefresh, systemImage: "arrow.clockwise")
                    .labelStyle(.iconOnly)
            }
            .momoQuickTooltip(copy.workConsoleRefresh)
            .disabled(controller.isLoading)

            Button {
                showsSettings.toggle()
            } label: {
                Label(copy.workConsoleSettings, systemImage: "slider.horizontal.3")
                    .labelStyle(.iconOnly)
            }
            .momoQuickTooltip(copy.workConsoleSettings)
            .popover(isPresented: $showsSettings, arrowEdge: .bottom) {
                MomoWorkConsoleSettingsView(
                    controller: controller,
                    preferences: preferences,
                    copy: copy
                )
            }

            Button {
                Task { await controller.startDefaultShell() }
            } label: {
                Label(copy.newTerminal, systemImage: "plus.rectangle.on.rectangle")
            }
            .buttonStyle(.borderedProminent)
            .disabled(disablesSessionStart)

            Button {
                showsNewSession = true
            } label: {
                Label(copy.newWorkSession, systemImage: "plus")
                    .labelStyle(.iconOnly)
            }
            .momoQuickTooltip(copy.newWorkSession)
            .disabled(disablesSessionStart)

            Button(action: onClose) {
                Label(copy.closeWorkConsole, systemImage: "xmark")
                    .labelStyle(.iconOnly)
            }
            .keyboardShortcut(.cancelAction)
            .momoQuickTooltip(copy.closeWorkConsole)
        }
        .buttonStyle(.plain)
        .padding(.horizontal, MomoTheme.WorkConsole.edgeInset)
        .frame(height: MomoTheme.WorkConsole.headerHeight)
    }

    private var disablesSessionStart: Bool {
        controller.isStarting
            || !controller.supportsWorkConsole
            || !controller.isHostReady
            || MomoWorkHostRuntime.isAppSandboxed
    }

    private func updateLayout(_ update: () -> Void) {
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction, update)
    }

    private var sandboxNotice: some View {
        HStack(spacing: MomoTheme.WorkConsole.standardSpacing) {
            Image(systemName: "lock.app.dashed")
                .foregroundStyle(MomoTheme.costAmber)
            VStack(alignment: .leading, spacing: MomoTheme.WorkConsole.compactSpacing) {
                Text(copy.workConsoleSandboxTitle)
                    .momoTypography(.supporting)
                    .fontWeight(.semibold)
                Text(copy.workConsoleSandboxBody)
                    .momoTypography(.metadata)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, MomoTheme.WorkConsole.edgeInset)
        .padding(.vertical, MomoTheme.WorkConsole.standardSpacing)
        .background(MomoTheme.costAmber.opacity(0.08))
    }

    private var showsHostRegistrationNotice: Bool {
        switch controller.hostRegistrationState {
        case .ready(let host): return !host.online
        case .waitingForSession, .registering, .failed: return true
        }
    }

    @ViewBuilder
    private var hostRegistrationNotice: some View {
        HStack(spacing: MomoTheme.WorkConsole.standardSpacing) {
            switch controller.hostRegistrationState {
            case .waitingForSession, .registering:
                Image(systemName: "ellipsis.circle")
                    .foregroundStyle(.secondary)
                Text(copy.workHostPreparing)
                    .momoTypography(.supporting)
                Spacer(minLength: 0)
            case .failed(let issue):
                Image(systemName: "exclamationmark.shield")
                    .foregroundStyle(MomoTheme.irreversibleRed)
                Text(issue.message(copy: copy))
                    .momoTypography(.supporting)
                Spacer(minLength: 0)
                Button(copy.workHostRetry) {
                    Task { await controller.retryWorkHostRegistration() }
                }
                .buttonStyle(.bordered)
            case .ready:
                Image(systemName: "network.slash")
                    .foregroundStyle(MomoTheme.costAmber)
                Text(copy.workHostOffline)
                    .momoTypography(.supporting)
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, MomoTheme.WorkConsole.edgeInset)
        .padding(.vertical, MomoTheme.WorkConsole.standardSpacing)
        .background(hostRegistrationNoticeColor.opacity(0.06))
    }

    private var hostRegistrationNoticeColor: Color {
        if case .failed = controller.hostRegistrationState {
            return MomoTheme.irreversibleRed
        }
        return MomoTheme.costAmber
    }

    private func issueBanner(_ issue: MomoWorkConsoleError) -> some View {
        HStack(spacing: MomoTheme.WorkConsole.standardSpacing) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(MomoTheme.irreversibleRed)
            Text(issue.message(copy: copy))
                .momoTypography(.supporting)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, MomoTheme.WorkConsole.edgeInset)
        .padding(.vertical, MomoTheme.WorkConsole.standardSpacing)
        .background(MomoTheme.irreversibleRed.opacity(0.06))
    }

    @ViewBuilder
    private var sessionList: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(copy.workSessions)
                .momoTypography(.metadata)
                .fontWeight(.semibold)
                .foregroundStyle(.secondary)
                .padding(.horizontal, MomoTheme.WorkConsole.contentSpacing)
                .padding(.vertical, MomoTheme.WorkConsole.standardSpacing)

            if controller.isLoading && controller.sessions.isEmpty {
                VStack(spacing: MomoTheme.WorkConsole.standardSpacing) {
                    ProgressView()
                    Text(copy.workSessionLoading)
                        .momoTypography(.metadata)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if controller.sessions.isEmpty {
                VStack(spacing: MomoTheme.WorkConsole.standardSpacing) {
                    Image(systemName: "terminal")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                    Text(copy.workSessionEmptyTitle)
                        .momoTypography(.supporting)
                        .fontWeight(.semibold)
                    Text(copy.workSessionEmptyBody)
                        .momoTypography(.metadata)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    Button(copy.newWorkSession) { showsNewSession = true }
                        .disabled(
                            !controller.supportsWorkConsole
                                || !controller.isHostReady
                                || MomoWorkHostRuntime.isAppSandboxed
                        )
                }
                .padding(MomoTheme.WorkConsole.edgeInset)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: MomoTheme.WorkConsole.compactSpacing) {
                        ForEach(controller.sessions) { session in
                            MomoWorkSessionRow(
                                session: session,
                                isSelected: controller.selectedSessionId == session.id,
                                isLocal: controller.localSessions[session.id] != nil,
                                copy: copy
                            ) {
                                controller.selectedSessionId = session.id
                            }
                        }
                    }
                    .padding(.horizontal, MomoTheme.WorkConsole.standardSpacing)
                    .padding(.bottom, MomoTheme.WorkConsole.standardSpacing)
                }
            }
        }
    }

    @ViewBuilder
    private var sessionDetail: some View {
        if let session = controller.selectedSession {
            MomoWorkSessionDetail(
                controller: controller,
                session: session,
                terminalTheme: preferences.terminalTheme,
                copy: copy
            )
                .id(session.id)
        } else {
            VStack(spacing: MomoTheme.WorkConsole.standardSpacing) {
                Image(systemName: "rectangle.and.hand.point.up.left")
                    .font(.title2)
                    .foregroundStyle(.secondary)
                Text(copy.workSessionEmptyTitle)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

private struct MomoWorkSessionRow: View {
    let session: MomoWorkSession
    let isSelected: Bool
    let isLocal: Bool
    let copy: MomoWorkspaceCopy
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: MomoTheme.WorkConsole.standardSpacing) {
                Image(systemName: session.tool.systemImage)
                    .frame(width: 20)
                    .foregroundStyle(session.isRunning ? MomoTheme.agentAccent : .secondary)
                VStack(alignment: .leading, spacing: MomoTheme.WorkConsole.compactSpacing) {
                    Text(session.label)
                        .momoTypography(.supporting)
                        .fontWeight(.medium)
                        .lineLimit(1)
                    HStack(spacing: MomoTheme.WorkConsole.compactSpacing) {
                        Text(copy.workToolTitle(session.tool))
                        Text("•")
                        Text(session.isRunning ? copy.workSessionRunning : copy.workSessionEnded)
                        if isLocal {
                            Image(systemName: "macbook")
                                .accessibilityLabel(copy.workSessionLocalOnly)
                        }
                    }
                    .momoTypography(.metadata)
                    .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, MomoTheme.WorkConsole.standardSpacing)
            .frame(minHeight: MomoTheme.WorkConsole.rowMinimumHeight)
            .contentShape(Rectangle())
            .background(
                isSelected ? MomoTheme.selectionBackground : .clear,
                in: RoundedRectangle(cornerRadius: MomoTheme.cornerSmall)
            )
        }
        .buttonStyle(.plain)
    }
}

private struct MomoWorkSessionDetail: View {
    @ObservedObject var controller: MomoWorkConsoleController
    let session: MomoWorkSession
    let terminalTheme: MomoTerminalThemePreset
    let copy: MomoWorkspaceCopy
    @State private var excerptDraft: MomoWorkExcerptDraft?

    var body: some View {
        VStack(spacing: 0) {
            detailHeader
            Divider()
            if let request = controller.pendingReads[session.id] {
                readRequest(request)
                Divider()
            }
            if let local = controller.localSessions[session.id] {
                MomoSwiftTermView(session: local, theme: terminalTheme)
                    .overlay(alignment: .bottomLeading) {
                        Text(copy.workSessionLocalOnly)
                            .momoTypography(.metadata)
                            .foregroundStyle(.secondary)
                            .padding(MomoTheme.WorkConsole.standardSpacing)
                            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: MomoTheme.cornerSmall))
                            .padding(MomoTheme.WorkConsole.standardSpacing)
                            .allowsHitTesting(false)
                    }
            } else if let remote = controller.remoteSessions[session.id] {
                MomoRemoteWorkTerminalDetail(
                    session: remote,
                    terminalTheme: terminalTheme,
                    copy: copy
                )
            } else {
                detachedState
            }
        }
        .sheet(item: $excerptDraft) { draft in
            MomoWorkExcerptSheet(
                draft: draft,
                copy: copy,
                onShare: { text in
                    if let request = draft.readRequest {
                        return await controller.sharePendingRead(request, excerpt: text)
                    }
                    return await controller.shareExcerpt(text, for: draft.session)
                }
            )
        }
    }

    private var detailHeader: some View {
        HStack(spacing: MomoTheme.WorkConsole.standardSpacing) {
            Image(systemName: session.tool.systemImage)
                .foregroundStyle(MomoTheme.agentAccent)
            VStack(alignment: .leading, spacing: 0) {
                Text(session.label)
                    .momoTypography(.emphasizedRow)
                    .lineLimit(1)
                    .truncationMode(.tail)
                HStack(spacing: MomoTheme.WorkConsole.compactSpacing) {
                    Text(copy.workToolTitle(session.tool))
                    Text("•")
                    Text(session.isRunning ? copy.workSessionRunning : copy.workSessionEnded)
                    if let exitCode = session.exitCode {
                        Text("•")
                        Text(copy.workSessionExit(exitCode))
                    }
                }
                .momoTypography(.metadata)
                .foregroundStyle(.secondary)
            }
            if session.isRemotePTYBound,
               let hostName = controller.hostDisplayName(for: session) {
                Text(hostName)
                    .momoTypography(.metadata)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: 160)
                    .padding(.horizontal, MomoTheme.WorkConsole.standardSpacing)
                    .padding(.vertical, MomoTheme.WorkConsole.compactSpacing)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: MomoTheme.cornerSmall))
            }
            Spacer(minLength: 0)
            if let local = controller.localSessions[session.id] {
                Button {
                    local.focus()
                } label: {
                    Label(copy.workSessionFocusTerminal, systemImage: "cursorarrow.click")
                        .labelStyle(.iconOnly)
                }
                .momoQuickTooltip(copy.workSessionFocusTerminal)
                Button {
                    excerptDraft = MomoWorkExcerptDraft(
                        session: session,
                        readRequest: nil,
                        text: local.tail(lineCount: 80)
                    )
                } label: {
                    Label(copy.workSessionShareExcerpt, systemImage: "quote.bubble")
                }
            }
            Button {
                Task { await controller.openThread(session) }
            } label: {
                Label(copy.workSessionOpenThread, systemImage: "arrowshape.turn.up.left")
            }
            if session.isRunning && controller.owns(session) {
                Button(role: .destructive) {
                    Task { await controller.endSession(session) }
                } label: {
                    Label(copy.workSessionEnd, systemImage: "stop.circle")
                }
            }
        }
        .buttonStyle(.plain)
        .padding(.horizontal, MomoTheme.WorkConsole.contentSpacing)
        .frame(height: MomoTheme.WorkConsole.headerHeight)
    }

    private func readRequest(_ request: MomoPendingWorkRead) -> some View {
        HStack(spacing: MomoTheme.WorkConsole.standardSpacing) {
            Image(systemName: "eye.trianglebadge.exclamationmark")
                .foregroundStyle(MomoTheme.costAmber)
            VStack(alignment: .leading, spacing: MomoTheme.WorkConsole.compactSpacing) {
                Text(copy.workReadRequestTitle)
                    .momoTypography(.supporting)
                    .fontWeight(.semibold)
                Text(copy.workReadRequestBody(lines: request.lineCount))
                    .momoTypography(.metadata)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            Button(copy.workReadDecline) {
                Task { await controller.declinePendingRead(request) }
            }
            Button(copy.workReadReview) {
                excerptDraft = MomoWorkExcerptDraft(
                    session: session,
                    readRequest: request,
                    text: controller.localSessions[session.id]?.tail(lineCount: request.lineCount) ?? ""
                )
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(.horizontal, MomoTheme.WorkConsole.contentSpacing)
        .padding(.vertical, MomoTheme.WorkConsole.standardSpacing)
        .background(MomoTheme.costAmber.opacity(0.08))
    }

    private var detachedState: some View {
        VStack(spacing: MomoTheme.WorkConsole.standardSpacing) {
            Image(systemName: "rectangle.slash")
                .font(.title2)
                .foregroundStyle(.secondary)
            Text(copy.workSessionDetachedTitle)
                .momoTypography(.emphasizedRow)
            Text(copy.workSessionDetachedBody)
                .momoTypography(.supporting)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
            if controller.canOpenRemoteTerminal(session) {
                Button(copy.workSessionOpenRemoteTerminal) {
                    Task { await controller.openRemoteTerminal(session) }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.return, modifiers: [])
            }
            Button(copy.workSessionOpenThread) {
                Task { await controller.openThread(session) }
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(MomoTheme.WorkConsole.edgeInset)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct MomoRemoteWorkTerminalDetail: View {
    @ObservedObject var session: MomoRemoteTerminalSession
    let terminalTheme: MomoTerminalThemePreset
    let copy: MomoWorkspaceCopy

    var body: some View {
        VStack(spacing: 0) {
            if let presentation = bannerPresentation {
                HStack(spacing: MomoTheme.WorkConsole.standardSpacing) {
                    Image(systemName: presentation.systemImage)
                        .foregroundStyle(presentation.isFailure ? MomoTheme.irreversibleRed : .secondary)
                    Text(presentation.message)
                        .momoTypography(.supporting)
                    Spacer(minLength: 0)
                    if presentation.canRetry {
                        Button(copy.workSessionRemoteRetry) {
                            Task { await session.retry() }
                        }
                        .buttonStyle(.bordered)
                    }
                }
                .padding(.horizontal, MomoTheme.WorkConsole.contentSpacing)
                .padding(.vertical, MomoTheme.WorkConsole.standardSpacing)
                .background(
                    (presentation.isFailure ? MomoTheme.irreversibleRed : Color.secondary).opacity(0.06)
                )
                Divider()
            }
            MomoRemoteSwiftTermView(session: session, theme: terminalTheme)
        }
    }

    private var bannerPresentation: MomoRemoteTerminalBannerPresentation? {
        switch session.state {
        case .idle:
            return .init(message: copy.workSessionRemoteDisconnected, systemImage: "network.slash", canRetry: true, isFailure: true)
        case .issuingGrant:
            return .init(message: copy.workSessionRemoteGrantLoading, systemImage: "ellipsis.circle", canRetry: false, isFailure: false)
        case .connecting:
            return .init(message: copy.workSessionRemoteConnecting, systemImage: "network", canRetry: false, isFailure: false)
        case .connected:
            return nil
        case .failed(let error):
            return .init(message: copy.remoteTerminalError(error), systemImage: "exclamationmark.triangle", canRetry: true, isFailure: true)
        case .ended:
            return .init(message: copy.workSessionRemoteEnded, systemImage: "stop.circle", canRetry: false, isFailure: false)
        }
    }
}

private struct MomoRemoteTerminalBannerPresentation {
    let message: String
    let systemImage: String
    let canRetry: Bool
    let isFailure: Bool
}

private struct MomoWorkExcerptDraft: Identifiable {
    let id = UUID()
    let session: MomoWorkSession
    let readRequest: MomoPendingWorkRead?
    let text: String
}

private struct MomoWorkExcerptSheet: View {
    let draft: MomoWorkExcerptDraft
    let copy: MomoWorkspaceCopy
    let onShare: (String) async -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var text: String
    @State private var isSharing = false

    init(
        draft: MomoWorkExcerptDraft,
        copy: MomoWorkspaceCopy,
        onShare: @escaping (String) async -> Bool
    ) {
        self.draft = draft
        self.copy = copy
        self.onShare = onShare
        _text = State(initialValue: draft.text)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: MomoTheme.WorkConsole.sectionSpacing) {
            VStack(alignment: .leading, spacing: MomoTheme.WorkConsole.compactSpacing) {
                Text(copy.workExcerptTitle)
                    .font(.title3.weight(.semibold))
                Label(copy.workExcerptWarning, systemImage: "exclamationmark.shield")
                    .momoTypography(.supporting)
                    .foregroundStyle(MomoTheme.costAmber)
            }
            TextEditor(text: $text)
                .font(.system(.body, design: .monospaced))
                .padding(MomoTheme.WorkConsole.standardSpacing)
                .background(Color(nsColor: .textBackgroundColor))
                .overlay(
                    RoundedRectangle(cornerRadius: MomoTheme.cornerSmall)
                        .strokeBorder(MomoTheme.subtleBorder, lineWidth: 1)
                )
            HStack {
                Spacer(minLength: 0)
                Button(copy.cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(copy.workExcerptSend) {
                    isSharing = true
                    Task {
                        let didShare = await onShare(text)
                        isSharing = false
                        if didShare { dismiss() }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(isSharing || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(MomoTheme.WorkConsole.edgeInset)
        .frame(
            width: MomoTheme.WorkConsole.excerptWidth,
            height: MomoTheme.WorkConsole.excerptHeight
        )
    }
}

private struct MomoNewWorkSessionSheet: View {
    @ObservedObject var controller: MomoWorkConsoleController
    let copy: MomoWorkspaceCopy
    @Environment(\.dismiss) private var dismiss
    @State private var tool = MomoWorkTool.codex
    @State private var label = ""
    @State private var folderURL: URL?

    var body: some View {
        VStack(alignment: .leading, spacing: MomoTheme.WorkConsole.sectionSpacing) {
            VStack(alignment: .leading, spacing: MomoTheme.WorkConsole.compactSpacing) {
                Text(copy.newWorkSession)
                    .font(.title3.weight(.semibold))
                Text(copy.workSessionLocalOnly)
                    .momoTypography(.supporting)
                    .foregroundStyle(.secondary)
            }

            Picker(copy.workSessionProfile, selection: $tool) {
                ForEach(MomoWorkTool.allCases) { tool in
                    Label(copy.workToolTitle(tool), systemImage: tool.systemImage)
                        .tag(tool)
                }
            }

            VStack(alignment: .leading, spacing: MomoTheme.WorkConsole.compactSpacing) {
                Text(copy.workSessionLabel)
                    .momoTypography(.supporting)
                    .fontWeight(.medium)
                TextField(copy.workSessionLabelPlaceholder, text: $label)
            }

            VStack(alignment: .leading, spacing: MomoTheme.WorkConsole.compactSpacing) {
                Text(copy.workSessionFolder)
                    .momoTypography(.supporting)
                    .fontWeight(.medium)
                HStack {
                    Text(folderURL?.lastPathComponent ?? copy.workSessionDefaultFolder)
                        .lineLimit(1)
                        .foregroundStyle(folderURL == nil ? .secondary : .primary)
                    Spacer(minLength: 0)
                    Button(copy.workSessionChooseFolder, action: chooseFolder)
                }
                Text(copy.workSessionFolderPrivacy)
                    .momoTypography(.metadata)
                    .foregroundStyle(.secondary)
            }

            HStack {
                Spacer(minLength: 0)
                Button(copy.cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(copy.startWorkSession) {
                    Task {
                        if await controller.startSession(
                            tool: tool,
                            label: label,
                            directory: folderURL
                        ) {
                            dismiss()
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(controller.isStarting || !controller.isHostReady)
            }
        }
        .padding(MomoTheme.WorkConsole.edgeInset)
        .frame(width: MomoTheme.WorkConsole.newSessionWidth)
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = copy.workSessionChooseFolder
        if panel.runModal() == .OK {
            folderURL = panel.url
        }
    }
}

struct MomoWorkConsoleSettingsView: View {
    @ObservedObject var controller: MomoWorkConsoleController
    @ObservedObject var preferences: MomoWorkConsolePreferences
    let copy: MomoWorkspaceCopy

    var body: some View {
        VStack(alignment: .leading, spacing: MomoTheme.WorkConsole.sectionSpacing) {
            Text(copy.workConsoleSettings)
                .font(.headline)
            VStack(alignment: .leading, spacing: MomoTheme.WorkConsole.standardSpacing) {
                Text(copy.terminalTheme)
                    .momoTypography(.supporting)
                    .fontWeight(.medium)
                Picker(
                    copy.terminalTheme,
                    selection: Binding(
                        get: { preferences.terminalTheme },
                        set: { preferences.setTerminalTheme($0) }
                    )
                ) {
                    ForEach(MomoTerminalThemePreset.allCases) { preset in
                        Text(copy.terminalThemeTitle(preset))
                            .tag(preset)
                    }
                }
                .labelsHidden()
                Text(copy.terminalThemeHelp)
                    .momoTypography(.metadata)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Divider()
            VStack(alignment: .leading, spacing: MomoTheme.WorkConsole.compactSpacing) {
                Text(copy.workHostIdentifier)
                    .momoTypography(.supporting)
                    .fontWeight(.medium)
                switch controller.hostRegistrationState {
                case .waitingForSession, .registering:
                    HStack(spacing: MomoTheme.WorkConsole.standardSpacing) {
                        Image(systemName: "ellipsis.circle")
                            .foregroundStyle(.secondary)
                        Text(copy.workHostPreparing)
                            .momoTypography(.metadata)
                            .foregroundStyle(.secondary)
                    }
                case .failed(let issue):
                    VStack(alignment: .leading, spacing: MomoTheme.WorkConsole.standardSpacing) {
                        HStack(alignment: .firstTextBaseline, spacing: MomoTheme.WorkConsole.standardSpacing) {
                            Image(systemName: "exclamationmark.shield")
                                .foregroundStyle(MomoTheme.irreversibleRed)
                            Text(issue.message(copy: copy))
                                .momoTypography(.metadata)
                                .foregroundStyle(.primary)
                        }
                        Button(copy.workHostRetry) {
                            Task { await controller.retryWorkHostRegistration() }
                        }
                        .buttonStyle(.bordered)
                    }
                case .ready(let host):
                    HStack(spacing: MomoTheme.WorkConsole.compactSpacing) {
                        Circle()
                            .fill(host.online ? MomoTheme.reversibleGreen : Color.secondary)
                            .frame(width: 8, height: 8)
                        Text(host.online ? copy.workHostOnline : copy.workHostRegistered)
                            .momoTypography(.metadata)
                            .foregroundStyle(.secondary)
                    }
                    HStack(spacing: MomoTheme.WorkConsole.standardSpacing) {
                        Text(host.id.description)
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                        Button {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(host.id.description, forType: .string)
                        } label: {
                            Label(copy.copyWorkHostIdentifier, systemImage: "doc.on.doc")
                                .labelStyle(.iconOnly)
                        }
                        .momoQuickTooltip(copy.copyWorkHostIdentifier)
                    }
                    Text(copy.workHostAgentWorkerHelp)
                        .momoTypography(.metadata)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(copy.workHostPrivateKeyHelp)
                        .momoTypography(.metadata)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Divider()
            VStack(alignment: .leading, spacing: MomoTheme.WorkConsole.standardSpacing) {
                Text(copy.workAutoApprove)
                    .momoTypography(.supporting)
                    .fontWeight(.medium)
                Text(copy.workAutoApproveUnknown)
                    .momoTypography(.metadata)
                    .foregroundStyle(.secondary)
                ForEach(MomoWorkTool.allCases) { tool in
                    HStack(spacing: MomoTheme.WorkConsole.standardSpacing) {
                        Label(copy.workToolTitle(tool), systemImage: tool.systemImage)
                        Spacer(minLength: 0)
                        Menu(autoApproveLabel(for: tool)) {
                            Button(copy.workAutoApproveEnable) {
                                Task { await controller.setAutoApprove(true, for: tool) }
                            }
                            Button(copy.workAutoApproveDisable) {
                                Task { await controller.setAutoApprove(false, for: tool) }
                            }
                        }
                        .disabled(controller.autoApproveStates[tool] == .updating)
                    }
                }
            }
        }
        .padding(MomoTheme.WorkConsole.edgeInset)
        .frame(width: MomoTheme.WorkConsole.settingsWidth)
    }

    private func autoApproveLabel(for tool: MomoWorkTool) -> String {
        switch controller.autoApproveStates[tool] ?? .unknown {
        case .unknown: return copy.workAutoApproveDisable
        case .updating: return copy.workAutoApproveUpdating
        case .enabled: return copy.workAutoApproveEnabled
        case .disabled: return copy.workAutoApproveDisabled
        case .failed: return copy.workAutoApproveFailed
        }
    }
}
