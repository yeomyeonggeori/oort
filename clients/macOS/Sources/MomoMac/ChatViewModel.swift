import Foundation
import SwiftUI
import MomoCore

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

    // Approval inbox (experience C). Keyed by approval id, newest first in view.
    @Published public private(set) var approvals: [ApprovalID: ApprovalEvent] = [:]
    @Published public private(set) var approvalDecisionsInFlight: Set<ApprovalID> = []

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
            // Channel list is provided by the seed for the stub; real backend would
            // expose a channels() call (REST GET .../channels) — TODO(T09-followup).
            self.connectionError = nil
        } catch {
            self.connectionError = String(describing: error)
        }
    }

    /// Inject channels (stub seeding path; real backend fetches them over REST).
    public func setChannels(_ channels: [Channel]) {
        self.channels = channels
        if selectedChannelId == nil { selectedChannelId = channels.first?.id }
    }

    /// Select a channel: load history + (re)subscribe to its realtime stream.
    public func selectChannel(_ id: ChannelID) async {
        selectedChannelId = id
        await loadHistory(channel: id)
        subscribe(channel: id)
        await refreshLocalContextCopilotPreview()
    }

    private func loadHistory(channel: ChannelID) async {
        do {
            let history = try await chat.history(channel: channel, after: nil, limit: 200)
            messagesByChannel[channel] = history.sorted(by: Self.seqOrder)
        } catch {
            connectionError = String(describing: error)
        }
    }

    private func subscribe(channel: ChannelID) {
        channelSubscription?.cancel()
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

    // MARK: Sending

    /// Optimistic send: local echo with nil seq, reconciled by the returned message.
    public func send(body: String, to channel: ChannelID) async {
        let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let clientMsgId = UUID()
        let draft = DraftMessage(channelId: channel, type: .text, body: trimmed)
        do {
            let acked = try await chat.sendOptimistic(draft, clientMsgId: clientMsgId)
            // Reconcile (the stub already emits the real message via subscribe, but the
            // returned ack is authoritative — upsert by id).
            upsert(acked, channel: channel)
        } catch {
            connectionError = String(describing: error)
        }
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

    /// Total reserved/spent micro_usd across live runs (cost chip in headers).
    public var liveSpentMicroUSD: Int64 {
        agentStatuses.values.compactMap { $0.spentMicroUSD }.reduce(0, +)
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
}
