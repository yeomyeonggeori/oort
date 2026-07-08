import Foundation
import SwiftUI
import MomoCore

public protocol MomoSessionSensitiveStateClearing: Sendable {
    func clearSessionSensitiveState() async
}

public enum DogfoodAgentInviteError: Error, LocalizedError {
    case selectChannelFirst
    case unsupportedAlias(String)
    case missingHermesAgent

    public var errorDescription: String? {
        switch self {
        case .selectChannelFirst:
            return "Select a channel before inviting Hermes."
        case .unsupportedAlias(let alias):
            return "Dogfood v0 only supports @hermes. \(alias) needs the server alias API first."
        case .missingHermesAgent:
            return "Hermes runtime member is not available. Start local alpha or run the Hermes gateway setup first."
        }
    }
}

// MARK: - ChatViewModel
//
// The single source of UI state for the macOS demo. Drives ChannelListView,
// MessageListView, MessageBubble, AgentPartialView, CostBreathingRing,
// ApprovalInboxView. Holds a `ChatBackend` + `AgentTransport` (MomoCore §5.3 / §6.1)
// — here `LiveChatBackend` (in-memory stub), later the real REST + SwiftCentrifuge.
// Approval decisions are sent through `ChatBackend` because they are timeline
// writes/audit intents rather than agent-stream transport events.
//
// Threading: @MainActor ObservableObject. Realtime events arrive on the backend's
// AsyncStream and are applied on the main actor. Ordering authority = Message.seq
// (L4 §1.2 #3): the message list is always re-sorted by seq.

@MainActor
public final class ChatViewModel: ObservableObject {
    // Backend contracts (same instance conforms to both, but typed separately).
    private let chat: any ChatBackend
    private let agentTransport: any AgentTransport
    private let onboarding: (any OnboardingInviteBackend)?
    private let localContextCopilot: LocalContextCopilotService

    // Workspace context.
    @Published public private(set) var workspaceId: WorkspaceID?
    @Published public private(set) var members: [Member] = []
    @Published public private(set) var channels: [Channel] = []
    @Published public var selectedChannelId: ChannelID?

    // Per-channel message store (kept seq-sorted on insert).
    @Published public private(set) var messagesByChannel: [ChannelID: [Message]] = [:]

    // Live agent state for the selected channel.
    /// In-flight `agent.partial` buffers, keyed by run, for AgentPartialView (L4 §5.2).
    @Published public private(set) var partials: [RunID: AgentPartial] = [:]
    /// Latest `agent.status` per run, drives CostBreathingRing + presence (L4 §5.2).
    @Published public private(set) var agentStatuses: [RunID: AgentStatus] = [:]
    /// Server-owned cost projection per run. Experience B consumes this instead
    /// of deriving ledger/budget math in the client.
    @Published public private(set) var costSnapshots: [RunID: CostSnapshot] = [:]
    @Published public private(set) var realtimeStatuses: [ChannelID: RealtimeConnectionStatus] = [:]
    @Published public private(set) var agentRuntimeStatus: AgentRuntimeStatus = .localMock
    @Published public var composerDraft: String = ""
    @Published public private(set) var mentionNotice: String?

    // Approval inbox (experience C). Keyed by approval id, newest first in view.
    @Published public private(set) var approvals: [ApprovalID: ApprovalEvent] = [:]
    @Published public private(set) var approvalDecisionsInFlight: Set<ApprovalID> = []
    @Published public private(set) var channelCreateInFlight = false
    @Published public private(set) var channelMemberMutationIds: Set<MemberID> = []

    // Onboarding / invite flow v0. The dev app drives this through LiveChatBackend
    // until the production REST join API lands.
    @Published public private(set) var inviteJoinState: InviteJoinState = .idle

    // macOS-only local model capability. Apple framework calls stay in this target;
    // MomoCore remains Foundation-only.
    @Published public private(set) var foundationModelsCapability: FoundationModelsCapabilityState
    @Published public private(set) var localContextCopilotPreview: LocalContextCopilotPreview?
    @Published public private(set) var isLocalContextCopilotRefreshing = false

    @Published public private(set) var connectionError: String?

    private var channelSubscription: Task<Void, Never>?
    private var realtimeStatusSubscription: Task<Void, Never>?
    private var pendingFallbackMentionRuns: [ChannelID: Set<RunID>] = [:]

    public init(
        chat: any ChatBackend,
        agentTransport: any AgentTransport,
        onboarding: (any OnboardingInviteBackend)? = nil,
        foundationModelsCapability: FoundationModelsCapabilityState = FoundationModelsCapabilityProbe().currentState(),
        localContextCopilot: LocalContextCopilotService = LocalContextCopilotService()
    ) {
        self.chat = chat
        self.agentTransport = agentTransport
        self.onboarding = onboarding
        self.foundationModelsCapability = foundationModelsCapability
        self.localContextCopilot = localContextCopilot
    }

    /// Convenience initializer when one object conforms to both contracts.
    public convenience init(backend: LiveChatBackend) {
        self.init(chat: backend, agentTransport: backend, onboarding: backend)
    }

    // MARK: Lifecycle

    /// Connect + load workspace roster/channels. Selects the first channel.
    public func bootstrap(workspace: WorkspaceID, accessToken: String) async {
        do {
            try await chat.connect(workspace: workspace, accessToken: accessToken)
            self.workspaceId = workspace
            self.members = try await chat.members(workspace: workspace)
            self.channels = try await chat.channels(workspace: workspace)
            self.members = mergeConfiguredMembershipHints(members)
            await refreshAgentRuntimeStatus()
            await loadPendingApprovals(workspace: workspace)
            if selectedChannelId == nil {
                self.selectedChannelId = channels.first?.id
            }
            self.connectionError = nil
        } catch {
            self.connectionError = String(describing: error)
        }
    }

    public func clearSessionSensitiveState() async {
        channelSubscription?.cancel()
        realtimeStatusSubscription?.cancel()
        channelSubscription = nil
        realtimeStatusSubscription = nil
        if let resettable = chat as? any MomoSessionSensitiveStateClearing {
            await resettable.clearSessionSensitiveState()
        }
        if let resettable = agentTransport as? any MomoSessionSensitiveStateClearing {
            await resettable.clearSessionSensitiveState()
        }
        workspaceId = nil
        members = []
        channels = []
        selectedChannelId = nil
        messagesByChannel = [:]
        partials = [:]
        agentStatuses = [:]
        costSnapshots = [:]
        realtimeStatuses = [:]
        agentRuntimeStatus = .localMock
        composerDraft = ""
        mentionNotice = nil
        approvals = [:]
        approvalDecisionsInFlight = []
        channelCreateInFlight = false
        channelMemberMutationIds = []
        inviteJoinState = .idle
        localContextCopilotPreview = nil
        isLocalContextCopilotRefreshing = false
        connectionError = nil
        pendingFallbackMentionRuns = [:]
    }

    public func refreshAgentRuntimeStatus() async {
        guard let provider = chat as? any AgentRuntimeStatusProviding else {
            agentRuntimeStatus = .localMock
            return
        }

        do {
            agentRuntimeStatus = try await provider.agentRuntimeStatus()
        } catch {
            agentRuntimeStatus = AgentRuntimeStatus(
                availability: .degraded,
                endpointLabel: "status unavailable",
                diagnostics: [String(describing: error)]
            )
        }
    }

    /// Inject channels (stub seeding path; real backend fetches them over REST).
    public func setChannels(_ channels: [Channel]) {
        self.channels = channels
        if selectedChannelId == nil { selectedChannelId = channels.first?.id }
    }

    public func createChannel(kind: ChannelKind, name: String, topic: String? = nil) async {
        guard let workspaceId, !channelCreateInFlight else { return }
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else {
            connectionError = "Channel name is required."
            return
        }
        let trimmedTopic = topic?.trimmingCharacters(in: .whitespacesAndNewlines)
        channelCreateInFlight = true
        defer { channelCreateInFlight = false }

        do {
            let result = try await chat.createChannel(
                workspace: workspaceId,
                kind: kind,
                name: trimmedName,
                topic: trimmedTopic?.isEmpty == true ? nil : trimmedTopic
            )
            if !channels.contains(where: { $0.id == result.channel.id }) {
                channels.append(result.channel)
                channels.sort(by: Self.channelOrder)
            }
            apply(result.creatorMembership)
            connectionError = nil
            await selectChannel(result.channel.id)
        } catch {
            connectionError = String(describing: error)
        }
    }

    public func addMember(_ member: MemberID, to channel: ChannelID? = nil) async {
        await mutateMember(member, channel: channel, adding: true)
    }

    public func removeMember(_ member: MemberID, from channel: ChannelID? = nil) async {
        await mutateMember(member, channel: channel, adding: false)
    }

    /// Select a channel: load history + (re)subscribe to its realtime stream.
    public func selectChannel(_ id: ChannelID) async {
        selectedChannelId = id
        await loadHistory(channel: id)
        await refreshCostSnapshots(channel: id)
        subscribe(channel: id)
        await refreshLocalContextCopilotPreview()
    }

    private func loadHistory(channel: ChannelID) async {
        do {
            let history = try await chat.history(channel: channel, after: nil, limit: 200)
            messagesByChannel[channel] = history.sorted(by: Self.seqOrder)
            for message in history {
                hydrateSidecars(from: message)
            }
        } catch {
            connectionError = String(describing: error)
        }
    }

    private func loadPendingApprovals(workspace: WorkspaceID) async {
        do {
            let pending = try await chat.pendingApprovals(workspace: workspace, status: .pending)
            approvals = Dictionary(
                uniqueKeysWithValues: pending.map { ($0.id, $0.eventProjection) }
            )
        } catch {
            connectionError = String(describing: error)
        }
    }

    private func subscribe(channel: ChannelID) {
        channelSubscription?.cancel()
        realtimeStatusSubscription?.cancel()
        subscribeRealtimeStatus(channel: channel)
        channelSubscription = Task { [weak self] in
            guard let self else { return }
            do {
                let events = try await self.chat.subscribe(channel: channel)
                for await event in events {
                    self.apply(event, channel: channel)
                }
            } catch {
                self.connectionError = String(describing: error)
            }
        }
    }

    private func subscribeRealtimeStatus(channel: ChannelID) {
        guard let statusProvider = chat as? any RealtimeStatusProvidingBackend else {
            realtimeStatuses[channel] = .restFallback(channel: channel)
            return
        }

        realtimeStatusSubscription = Task { [weak self] in
            guard let self else { return }
            let statuses = await statusProvider.realtimeStatus(channel: channel)
            for await status in statuses {
                self.realtimeStatuses[status.channelId] = status
            }
        }
    }

    public func retryRealtime() async {
        guard let channel = selectedChannelId else { return }
        realtimeStatuses[channel] = RealtimeConnectionStatus(
            channelId: channel,
            connection: .reconnecting,
            subscription: .recovering,
            fallback: .restHistory,
            canRetry: false,
            message: "Retrying realtime; REST history remains available."
        )
        await loadHistory(channel: channel)
        if let statusProvider = chat as? any RealtimeStatusProvidingBackend {
            await statusProvider.retryRealtime(channel: channel)
        }
        subscribe(channel: channel)
    }

    public func retrySelectedChannelLoad() async {
        guard let channel = selectedChannelId else {
            connectionError = nil
            return
        }
        connectionError = nil
        await selectChannel(channel)
    }

    public func clearConnectionError() {
        connectionError = nil
    }

    // MARK: Sending

    /// Optimistic send: local echo with nil seq, reconciled by the returned message.
    public func send(body: String, to channel: ChannelID) async {
        let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let clientMsgId = UUID()
        let draft = DraftMessage(channelId: channel, type: .text, body: trimmed)
        let mentionedAgent = mentionedAgent(in: trimmed)
        let optimistic = optimisticMessage(body: trimmed, channel: channel, clientMsgId: clientMsgId)
        upsert(optimistic, channel: channel)
        if let mentionedAgent, isRESTFallback(channel: channel) {
            showFallbackMentionProgress(agent: mentionedAgent, channel: channel)
        }
        do {
            let acked = try await chat.sendOptimistic(draft, clientMsgId: clientMsgId)
            // Reconcile (the stub already emits the real message via subscribe, but the
            // returned ack is authoritative — upsert by id).
            upsert(acked, channel: channel)
            if let mentionedAgent {
                await refreshAfterMentionSend(channel: channel, agent: mentionedAgent, triggerSeq: acked.seq)
            }
        } catch {
            connectionError = String(describing: error)
        }
    }

    public func insertMention(for member: Member, preferDisplayName: Bool = false) {
        guard member.isAgent else { return }
        guard selectedChannelId != nil else {
            mentionNotice = "Select a channel before mentioning \(member.displayName)."
            return
        }
        guard member.status == .active else {
            mentionNotice = "\(member.displayName) is not active in this workspace."
            return
        }

        let token = preferDisplayName ? "@\(member.displayName)" : "@\(member.handle)"
        let needsSeparator = composerDraft.last.map { !$0.isWhitespace && !$0.isNewline } ?? false
        composerDraft += "\(needsSeparator ? " " : "")\(token) "
        mentionNotice = "\(member.displayName) mention inserted."
    }

    public func canInsertMention(for member: Member) -> Bool {
        member.isAgent && member.status == .active && selectedChannelId != nil
    }

    public func mentionUnavailableReason(for member: Member) -> String? {
        guard member.isAgent else { return nil }
        if selectedChannelId == nil {
            return "Select a channel first."
        }
        if member.status != .active {
            return "\(member.displayName) is not active."
        }
        return nil
    }

    @discardableResult
    public func inviteDogfoodAgent(
        displayName rawDisplayName: String,
        handle rawHandle: String,
        avatarPath: String? = nil
    ) async throws -> Member {
        let normalizedHandle = Self.normalizedAgentHandle(rawHandle)
        guard normalizedHandle == "hermes" else {
            throw DogfoodAgentInviteError.unsupportedAlias("@\(normalizedHandle)")
        }
        guard let channel = selectedChannelId else {
            throw DogfoodAgentInviteError.selectChannelFirst
        }
        let displayName = rawDisplayName.trimmingCharacters(in: .whitespacesAndNewlines)
        let effectiveDisplayName = displayName.isEmpty ? normalizedHandle.capitalized : displayName
        let existingIndex = members.firstIndex { member in
            member.isAgent
                && member.handle.caseInsensitiveCompare(normalizedHandle) == .orderedSame
        }
        guard let existingIndex else {
            throw DogfoodAgentInviteError.missingHermesAgent
        }
        var agent = members[existingIndex]

        agent.displayName = effectiveDisplayName
        agent.handle = normalizedHandle
        if let avatarPath, !avatarPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            agent.avatarURL = URL(fileURLWithPath: avatarPath)
        }
        if agent.presence == Presence.offline {
            agent.presence = Presence.online
        }

        if !agent.channelIds.contains(channel) {
            do {
                let membership = try await chat.addMember(agent.id, to: channel, role: .member)
                apply(membership)
                agent.channelIds = member(agent.id)?.channelIds ?? agent.channelIds
                connectionError = nil
            } catch {
                connectionError = "Hermes invite failed: \(error)"
                throw error
            }
        }

        members[existingIndex] = agent
        mentionNotice = "\(agent.displayName) invited. Mention @\(agent.handle) in this channel."
        return agent
    }

    // MARK: Onboarding invite flow

    public func submitInviteCode(_ code: String) async {
        guard !inviteJoinState.isWorking else { return }
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            inviteJoinState = .failed(InviteJoinFailure(
                code: "",
                reason: "Invite code required",
                recoveryHint: "Enter MOMO-012 for the dev fixture."
            ))
            return
        }

        guard let onboarding else {
            inviteJoinState = .failed(InviteJoinFailure(
                code: trimmed,
                reason: "Invite service unavailable",
                recoveryHint: "Use LiveChatBackend in the dev app."
            ))
            return
        }

        inviteJoinState = .validating(code: trimmed)
        inviteJoinState = await onboarding.joinWorkspace(inviteCode: trimmed)
    }

    // MARK: Realtime application (ordering authority = seq, L4 §1.2 #3)

    private func apply(_ event: RealtimeEvent, channel: ChannelID) {
        switch event {
        case .message(let m), .messageEdited(let m):
            upsert(m, channel: channel)
        case .messageDeleted(let id):
            if var msgs = messagesByChannel[channel],
               let idx = msgs.firstIndex(where: { $0.id == id }) {
                msgs[idx].state = .deleted
                messagesByChannel[channel] = msgs
            }
        case .agentStatus(let status):
            agentStatuses[status.runId] = status
            mergeCostSnapshot(from: status)
        case .agentPartial(let partial):
            coalesce(partial)
        case .approval(let ev):
            approvals[ev.approvalId] = ev
        case .reaction, .typing, .presence:
            // Rendered elsewhere / not material to the v0 demo surfaces.
            break
        }
    }

    private func upsert(_ message: Message, channel: ChannelID) {
        var msgs = messagesByChannel[channel] ?? []
        if let idx = msgs.firstIndex(where: { $0.id == message.id })
            ?? (message.clientMsgId.flatMap { cid in msgs.firstIndex(where: { $0.clientMsgId == cid }) }) {
            msgs[idx] = message
        } else {
            msgs.append(message)
        }
        messagesByChannel[channel] = msgs.sorted(by: Self.seqOrder)
        hydrateSidecars(from: message)
        reconcileFinalMessage(message)
    }

    private func hydrateSidecars(from message: Message) {
        guard let runId = message.runId else { return }
        let reserved = Self.microUSD(from: message.props["reserved_micro_usd"])
            ?? Self.microUSD(from: message.props["estimated_micro_usd"])
        let spent = Self.microUSD(from: message.props["spent_micro_usd"])
        if reserved != nil || spent != nil {
            agentStatuses[runId] = AgentStatus(
                runId: runId,
                agentMemberId: message.authorMemberId,
                channelId: message.channelId,
                phase: spent == nil ? .thinking : .streaming,
                runStatus: message.type == .approvalRequest ? .awaitingApproval : .running,
                reservedMicroUSD: reserved,
                spentMicroUSD: spent
            )
        }

        guard message.type == .approvalRequest,
              let approvalId = approvalId(for: message) else {
            return
        }
        approvals[approvalId] = ApprovalEvent(
            action: .requested,
            approvalId: approvalId,
            runId: runId,
            channelId: message.channelId,
            requestedBy: message.authorMemberId,
            actionType: message.props["action_type"]?.stringValue
                ?? message.props["tool_name"]?.stringValue
                ?? "tool_call",
            status: approvalStatus(for: message) ?? .pending,
            payload: message.props,
            estimatedMicroUSD: Self.microUSD(from: message.props["estimated_micro_usd"]),
            isReversible: Self.bool(from: message.props["is_reversible"])
        )
    }

    // MARK: Local Context Copilot

    public func refreshLocalContextCopilotPreview() async {
        guard !isLocalContextCopilotRefreshing else { return }
        isLocalContextCopilotRefreshing = true
        defer { isLocalContextCopilotRefreshing = false }

        let channel = selectedChannelId.flatMap { selected in
            channels.first(where: { $0.id == selected })
        }
        let request = LocalContextCopilotRequest(
            channel: channel,
            messages: visibleMessages,
            capability: foundationModelsCapability
        )
        localContextCopilotPreview = await localContextCopilot.preview(request)
    }

    /// Coalesce `agent.partial` deltas into one growing buffer per run (L4 §5.2).
    private func coalesce(_ partial: AgentPartial) {
        guard !hasFinalMessage(for: partial) else {
            partials[partial.runId] = nil
            return
        }
        if var existing = partials[partial.runId] {
            if let delta = partial.textDelta {
                existing.textDelta = (existing.textDelta ?? "") + delta
            }
            if let name = partial.toolCallName { existing.toolCallName = name }
            if let args = partial.toolCallArgs { existing.toolCallArgs = args }
            if let spent = partial.spentMicroUSD { existing.spentMicroUSD = spent }
            if let mid = partial.messageId { existing.messageId = mid }
            partials[partial.runId] = existing
        } else {
            partials[partial.runId] = partial
        }
    }

    private func reconcileFinalMessage(_ message: Message) {
        guard let runId = message.runId else { return }
        guard let partial = partials[runId] else { return }
        if partial.messageId == message.id || message.type == .toolResult {
            partials[runId] = nil
        }
    }

    private func clearFallbackMentionProgress(channel: ChannelID, agent: Member, after triggerSeq: Int64?) {
        guard let runs = pendingFallbackMentionRuns[channel], !runs.isEmpty else { return }
        let messages = messagesByChannel[channel] ?? []
        let hasFinal = messages.contains { message in
            guard message.authorMemberId == agent.id else { return false }
            guard let triggerSeq, let seq = message.seq else { return message.runId != nil }
            return seq > triggerSeq
        }
        guard hasFinal else { return }
        for run in runs {
            partials[run] = nil
            if var status = agentStatuses[run] {
                status.phase = .done
                status.runStatus = .succeeded
                agentStatuses[run] = status
            }
        }
        pendingFallbackMentionRuns[channel] = nil
    }

    private func hasFinalMessage(for partial: AgentPartial) -> Bool {
        let messages = messagesByChannel[partial.channelId] ?? []
        return messages.contains { message in
            guard message.runId == partial.runId else { return false }
            if partial.messageId == message.id { return true }
            return message.type == .toolResult && message.seq != nil
        }
    }

    // MARK: Approval inbox actions (experience C)

    public func decideApproval(_ id: ApprovalID, approve: Bool, reason: String? = nil) async {
        guard !approvalDecisionsInFlight.contains(id) else { return }
        approvalDecisionsInFlight.insert(id)
        defer { approvalDecisionsInFlight.remove(id) }

        do {
            let receipt = try await chat.decideApproval(
                ApprovalDecisionRequest(approvalId: id, approve: approve, reason: reason)
            )
            // Optimistically reflect the decision; real `approval.decided` will confirm.
            if var ev = approvals[id] {
                ev.status = receipt.status
                ev.action = .decided
                ev.decidedBy = receipt.decidedBy
                ev.decisionReason = receipt.decisionReason
                approvals[id] = ev
            }
        } catch {
            connectionError = String(describing: error)
        }
    }

    // MARK: Derived views

    /// seq-sorted messages for the currently selected channel (MessageListView).
    public var visibleMessages: [Message] {
        guard let id = selectedChannelId else { return [] }
        return messagesByChannel[id] ?? []
    }

    public var selectedRealtimeStatus: RealtimeConnectionStatus? {
        guard let id = selectedChannelId else { return nil }
        return realtimeStatuses[id]
    }

    /// Pending approvals, newest-first (ApprovalInboxView).
    public var pendingApprovals: [ApprovalEvent] {
        approvals.values
            .filter { $0.status == .pending }
            .sorted { $0.approvalId.description > $1.approvalId.description }
    }

    public func approvalId(for message: Message) -> ApprovalID? {
        guard message.type == .approvalRequest,
              let raw = message.props["approval_id"]?.stringValue else {
            return nil
        }
        return ApprovalID(raw)
    }

    public func approvalStatus(for message: Message) -> ApprovalStatus? {
        guard let id = approvalId(for: message) else {
            return nil
        }
        if let eventStatus = approvals[id]?.status {
            return eventStatus
        }
        if let raw = message.props["approval_status"]?.stringValue {
            return ApprovalStatus(rawValue: raw)
        }
        return .pending
    }

    public func isApprovalDecisionInFlight(for message: Message) -> Bool {
        guard let id = approvalId(for: message) else {
            return false
        }
        return approvalDecisionsInFlight.contains(id)
    }

    public func member(_ id: MemberID) -> Member? {
        members.first(where: { $0.id == id })
    }

    public var selectedChannel: Channel? {
        guard let selectedChannelId else { return nil }
        return channels.first(where: { $0.id == selectedChannelId })
    }

    public func isMember(_ member: MemberID, in channel: ChannelID? = nil) -> Bool {
        guard let channel = channel ?? selectedChannelId else { return false }
        return members.first(where: { $0.id == member })?.channelIds.contains(channel) == true
    }

    /// Total reserved/spent micro_usd across live runs (cost chip in headers).
    public var liveSpentMicroUSD: Int64 {
        costSnapshots.values.map(\.spentMicroUSD).reduce(0, +)
    }

    public func costSnapshot(for runId: RunID) -> CostSnapshot? {
        costSnapshots[runId]
    }

    private func refreshCostSnapshots(channel: ChannelID) async {
        do {
            let snapshots = try await chat.costSnapshots(channel: channel)
            for snapshot in snapshots {
                costSnapshots[snapshot.runId] = snapshot
            }
            connectionError = nil
        } catch {
            connectionError = String(describing: error)
        }
    }

    private func mergeCostSnapshot(from status: AgentStatus) {
        guard status.reservedMicroUSD != nil || status.spentMicroUSD != nil else {
            return
        }
        let existing = costSnapshots[status.runId]
        costSnapshots[status.runId] = CostSnapshot(
            runId: status.runId,
            reservedMicroUSD: status.reservedMicroUSD ?? existing?.reservedMicroUSD ?? 0,
            spentMicroUSD: status.spentMicroUSD ?? existing?.spentMicroUSD ?? 0,
            softLimitMicroUSD: existing?.softLimitMicroUSD,
            hardLimitMicroUSD: existing?.hardLimitMicroUSD,
            isReconciled: existing?.isReconciled ?? status.runStatus.isTerminal,
            wasEstimated: existing?.wasEstimated ?? false,
            limitState: existing?.limitState ?? .normal
        )
    }

    private func optimisticMessage(body: String, channel: ChannelID, clientMsgId: UUID) -> Message {
        Message(
            id: MessageID(),
            channelId: channel,
            seq: nil,
            hlcTs: Int64(Date().timeIntervalSince1970 * 1000),
            authorMemberId: members.first(where: { $0.kind == .human })?.id ?? MemberID(),
            type: .text,
            state: .sent,
            body: body,
            clientMsgId: clientMsgId,
            createdAtMs: Int64(Date().timeIntervalSince1970 * 1000)
        )
    }

    private func mentionedAgent(in body: String) -> Member? {
        members.first { member in
            member.isAgent && Self.body(body, mentions: member)
        }
    }

    private func isRESTFallback(channel: ChannelID) -> Bool {
        guard let status = realtimeStatuses[channel] else { return false }
        return status.fallback == .restHistory && !status.isLive
    }

    private func showFallbackMentionProgress(agent: Member, channel: ChannelID) {
        let run = RunID()
        pendingFallbackMentionRuns[channel, default: []].insert(run)
        agentStatuses[run] = AgentStatus(
            runId: run,
            agentMemberId: agent.id,
            channelId: channel,
            phase: .thinking,
            runStatus: .running
        )
        partials[run] = AgentPartial(
            runId: run,
            channelId: channel,
            textDelta: "\(agent.displayName) is working from the mention. Waiting for the final channel message..."
        )
    }

    private func refreshAfterMentionSend(channel: ChannelID, agent: Member, triggerSeq: Int64?) async {
        guard isRESTFallback(channel: channel) else { return }
        for delay in [350_000_000, 900_000_000, 1_600_000_000] as [UInt64] {
            try? await Task.sleep(nanoseconds: delay)
            await loadHistory(channel: channel)
            await refreshCostSnapshots(channel: channel)
            clearFallbackMentionProgress(channel: channel, agent: agent, after: triggerSeq)
            if pendingFallbackMentionRuns[channel]?.isEmpty != false {
                return
            }
        }
    }

    // Stable ordering: seq first (nil = optimistic, sort last), then hlc, then id.
    nonisolated static func seqOrder(_ a: Message, _ b: Message) -> Bool {
        switch (a.seq, b.seq) {
        case let (.some(x), .some(y)) where x != y: return x < y
        case (.some, .none): return true     // acked before optimistic
        case (.none, .some): return false
        default: break
        }
        if a.hlcTs != b.hlcTs { return a.hlcTs < b.hlcTs }
        if a.hlcCount != b.hlcCount { return a.hlcCount < b.hlcCount }
        return a.id.description < b.id.description
    }

    nonisolated private static func channelOrder(_ a: Channel, _ b: Channel) -> Bool {
        let kindRank: (ChannelKind) -> Int = { kind in
            switch kind {
            case .publicChannel: return 0
            case .privateChannel: return 1
            case .dm: return 2
            }
        }
        let lhs = kindRank(a.kind)
        let rhs = kindRank(b.kind)
        if lhs != rhs { return lhs < rhs }
        return (a.name ?? "").localizedCaseInsensitiveCompare(b.name ?? "") == .orderedAscending
    }

    private func mutateMember(_ member: MemberID, channel: ChannelID?, adding: Bool) async {
        guard let channel = channel ?? selectedChannelId else {
            connectionError = "Select a channel first."
            return
        }
        guard !channelMemberMutationIds.contains(member) else { return }
        channelMemberMutationIds.insert(member)
        defer { channelMemberMutationIds.remove(member) }

        do {
            let membership = adding
                ? try await chat.addMember(member, to: channel, role: .member)
                : try await chat.removeMember(member, from: channel)
            apply(membership)
            connectionError = nil
        } catch {
            connectionError = String(describing: error)
        }
    }

    private func apply(_ membership: ChannelMembership) {
        guard let index = members.firstIndex(where: { $0.id == membership.memberId }) else {
            return
        }
        if membership.isActive {
            if !members[index].channelIds.contains(membership.channelId) {
                members[index].channelIds.append(membership.channelId)
            }
        } else {
            members[index].channelIds.removeAll { $0 == membership.channelId }
        }
    }

    private func mergeConfiguredMembershipHints(_ loaded: [Member]) -> [Member] {
        loaded.map { member in
            guard member.channelIds.isEmpty,
                  let configured = members.first(where: { $0.id == member.id }),
                  !configured.channelIds.isEmpty else {
                return member
            }
            var copy = member
            copy.channelIds = configured.channelIds
            return copy
        }
    }

    nonisolated private static func microUSD(from value: JSON?) -> Int64? {
        guard let value else { return nil }
        if let int = value.intValue { return int }
        if let string = value.stringValue { return Int64(string) }
        return nil
    }

    nonisolated private static func bool(from value: JSON?) -> Bool? {
        guard let value else { return nil }
        if let bool = value.boolValue { return bool }
        switch value.stringValue?.lowercased() {
        case "true", "yes", "1": return true
        case "false", "no", "0": return false
        default: return nil
        }
    }

    nonisolated private static func body(_ body: String, mentions member: Member) -> Bool {
        let needles = ["@\(member.handle)", "@\(member.displayName)"]
        return needles.contains { token in
            body.range(of: token, options: [.caseInsensitive, .diacriticInsensitive]) != nil
        }
    }

    nonisolated private static func normalizedAgentHandle(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let withoutAt = trimmed.hasPrefix("@") ? String(trimmed.dropFirst()) : trimmed
        let normalized = withoutAt.lowercased().filter { character in
            character.isLetter || character.isNumber || character == "-" || character == "_"
        }
        return normalized.isEmpty ? "hermes" : normalized
    }
}
