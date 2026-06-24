import Foundation
import MomoCore

// MARK: - LiveChatBackend
//
// A concrete `ChatBackend` + `AgentTransport` (MomoCore §5.3 / §6.1) used by the
// macOS demo ViewModel. It is an IN-MEMORY stub: the real REST + SwiftCentrifuge
// transport lands in the .app follow-up ticket (T09 STATUS). Everything here is
// shaped to the actual MomoCore contracts so the views render against real model
// types and the swap to the live transport is a drop-in.
//
// Invariants kept honest even in the stub (L4 §1.2):
//   - Ordering authority = Message.seq (monotonic, gapless per channel).
//   - sendOptimistic is idempotent on clientMsgId.
//   - history(after:) is a seq cursor backfill.
//
// TODO(T09-followup): replace the in-memory store with:
//   - REST send/history/auth (AsyncHTTPClient) → POST /v1/.../messages etc.
//   - SwiftCentrifuge subscribe on ch:/agent: namespaces feeding RealtimeEvent/AgentEvent.

public actor LiveChatBackend: ChatBackend, AgentTransport {
    // In-memory SoT surrogate.
    private var workspace: WorkspaceID?
    private var connected = false
    private var members: [Member] = []
    private var channels: [Channel] = []
    private var messagesByChannel: [ChannelID: [Message]] = [:]
    private var seqByChannel: [ChannelID: Int64] = [:]
    private var sentClientMsgIds: [ChannelID: Set<UUID>] = [:]

    // Realtime fan-out continuations, keyed by channel.
    private var channelStreams: [ChannelID: [UUID: AsyncStream<RealtimeEvent>.Continuation]] = [:]
    private var agentStreams: [ChannelID: [UUID: AsyncStream<AgentEvent>.Continuation]] = [:]

    public init() {}

    // MARK: Seeding (demo fixtures)

    /// Seed the in-memory store with a demo workspace so the UI has content offline.
    /// Returns the seeded workspace + first channel for convenience.
    public func seedDemo() -> DemoSeed {
        let ws = WorkspaceID()
        workspace = ws

        let human = Member(id: MemberID(), workspaceId: ws, kind: .human,
                           displayName: "상준", handle: "sangjun", presence: .online)
        let researcher = Member(id: MemberID(), workspaceId: ws, kind: .agent,
                                displayName: "리서처", handle: "researcher", presence: .working)
        let builder = Member(id: MemberID(), workspaceId: ws, kind: .agent,
                             displayName: "빌드봇", handle: "buildbot", presence: .online)
        members = [human, researcher, builder]

        let general = Channel(id: ChannelID(), workspaceId: ws, kind: .publicChannel,
                              name: "general", topic: "팀 일반 채널", createdBy: human.id)
        let pg18 = Channel(id: ChannelID(), workspaceId: ws, kind: .publicChannel,
                           name: "feature-pg18", topic: "PG18 마이그레이션", createdBy: human.id)
        channels = [general, pg18]
        for ch in channels {
            messagesByChannel[ch.id] = []
            seqByChannel[ch.id] = 0
            sentClientMsgIds[ch.id] = []
        }

        // A few seed messages incl. a first-class tool_call (demo D placeholder content).
        _ = appendServerMessage(channel: general.id, author: human.id, type: .text,
                                body: "안녕하세요 팀!")
        _ = appendServerMessage(channel: general.id, author: researcher.id, type: .text,
                                body: "리서처 합류했습니다.", runId: RunID())
        let toolRun = RunID()
        _ = appendServerMessage(
            channel: pg18.id, author: researcher.id, type: .toolCall,
            body: nil,
            props: .object([
                "name": .string("search_repo"),
                "arguments": .object(["query": .string("migration")]),
                "call_id": .string("call_1"),
            ]),
            runId: toolRun)

        return DemoSeed(workspace: ws, human: human, agents: [researcher, builder],
                        channels: channels)
    }

    // MARK: ChatBackend

    public func connect(workspace: WorkspaceID, accessToken: String) async throws {
        // TODO(T09-followup): REST auth → realtime-token → SwiftCentrifuge connect.
        self.workspace = workspace
        self.connected = true
    }

    public func sendOptimistic(_ draft: DraftMessage, clientMsgId: UUID) async throws -> Message {
        guard connected else { throw BackendError.notConnected }
        let ch = draft.channelId

        // Idempotency on clientMsgId (L4 §3.1 ON CONFLICT DO NOTHING semantics).
        if sentClientMsgIds[ch]?.contains(clientMsgId) == true,
           let existing = messagesByChannel[ch]?.first(where: { $0.clientMsgId == clientMsgId }) {
            return existing
        }

        let author = members.first(where: { $0.kind == .human })?.id ?? MemberID()
        let msg = appendServerMessage(
            channel: ch, author: author, type: draft.type, body: draft.body,
            props: draft.props, clientMsgId: clientMsgId,
            rootId: draft.rootId, replyToId: draft.replyToId)
        sentClientMsgIds[ch, default: []].insert(clientMsgId)
        return msg
    }

    public func subscribe(channel: ChannelID) async throws -> AsyncStream<RealtimeEvent> {
        guard connected else { throw BackendError.notConnected }
        let token = UUID()
        return AsyncStream { continuation in
            Task { await self.registerChannel(channel, token: token, continuation: continuation) }
            continuation.onTermination = { _ in
                Task { await self.unregisterChannel(channel, token: token) }
            }
        }
    }

    public func history(channel: ChannelID, after seq: Int64?, limit: Int) async throws -> [Message] {
        let all = (messagesByChannel[channel] ?? []).sorted { ($0.seq ?? 0) < ($1.seq ?? 0) }
        let filtered = seq.map { cur in all.filter { ($0.seq ?? 0) > cur } } ?? all
        return Array(filtered.suffix(limit))
    }

    public func presence(channel: ChannelID) async throws -> [PresenceEntry] {
        members.map {
            PresenceEntry(memberId: $0.id, channelId: channel, presence: $0.presence)
        }
    }

    public func members(workspace: WorkspaceID) async throws -> [Member] { members }

    public func search(workspace: WorkspaceID, query: String) async throws -> [Message] {
        messagesByChannel.values.flatMap { $0 }.filter {
            ($0.body ?? "").localizedCaseInsensitiveContains(query)
        }
    }

    public func setTyping(channel: ChannelID, isTyping: Bool) async {
        // TODO(T09-followup): publish typing.start/stop via REST → relay.
    }

    public func editMessage(_ id: MessageID, body: String) async throws -> Message {
        for (ch, msgs) in messagesByChannel {
            if let idx = msgs.firstIndex(where: { $0.id == id }) {
                var m = msgs[idx]
                m.body = body
                m.state = .edited
                messagesByChannel[ch]?[idx] = m
                emit(.messageEdited(m), to: ch)
                return m
            }
        }
        throw BackendError.problem(status: 404, title: "not found", detail: "message \(id)")
    }

    public func addReaction(_ id: MessageID, emoji: String) async throws {
        for ch in messagesByChannel.keys where messagesByChannel[ch]?.contains(where: { $0.id == id }) == true {
            let author = members.first(where: { $0.kind == .human })?.id ?? MemberID()
            emit(.reaction(ReactionDelta(action: .added, messageId: id, memberId: author, emoji: emoji)), to: ch)
            return
        }
    }

    // MARK: AgentTransport

    public func observe(agent: MemberID, channel: ChannelID) async throws -> AsyncStream<AgentEvent> {
        let token = UUID()
        return AsyncStream { continuation in
            Task { await self.registerAgent(channel, token: token, continuation: continuation) }
            continuation.onTermination = { _ in
                Task { await self.unregisterAgent(channel, token: token) }
            }
        }
    }

    public func invoke(agent: MemberID, channel: ChannelID, prompt: String,
                       idempotencyKey: UUID) async throws -> RunID {
        // TODO(T09-followup): REST POST .../agents/{agent}/invoke. Here we simulate a run.
        let run = RunID()
        emitAgent(.status(run, .running), to: channel)
        return run
    }

    public func decideApproval(_ id: ApprovalID, approve: Bool, reason: String?) async throws {
        // TODO(T09-followup): REST POST .../approvals/{id}/decide.
    }

    public func cancelRun(_ id: RunID) async throws {
        // TODO(T09-followup): REST cancelRun.
    }

    // MARK: - Internal helpers

    private func appendServerMessage(
        channel: ChannelID, author: MemberID, type: MessageType, body: String?,
        props: JSON = .object([:]), clientMsgId: UUID? = nil,
        rootId: MessageID? = nil, replyToId: MessageID? = nil, runId: RunID? = nil
    ) -> Message {
        let next = (seqByChannel[channel] ?? 0) + 1
        seqByChannel[channel] = next
        let msg = Message(
            id: MessageID(), channelId: channel, seq: next,
            hlcTs: Int64(Date().timeIntervalSince1970 * 1000), hlcCount: 0,
            authorMemberId: author, type: type, state: .sent, body: body, props: props,
            rootId: rootId, replyToId: replyToId, runId: runId, clientMsgId: clientMsgId,
            createdAtMs: Int64(Date().timeIntervalSince1970 * 1000))
        messagesByChannel[channel, default: []].append(msg)
        emit(.message(msg), to: channel)
        return msg
    }

    private func emit(_ event: RealtimeEvent, to channel: ChannelID) {
        for cont in (channelStreams[channel] ?? [:]).values { cont.yield(event) }
    }

    private func emitAgent(_ event: AgentEvent, to channel: ChannelID) {
        for cont in (agentStreams[channel] ?? [:]).values { cont.yield(event) }
    }

    // `async` so the cross-actor hop from the nonisolated AsyncStream closure is a
    // genuine await (avoids "no async operations occur within await" warnings).
    private func registerChannel(_ channel: ChannelID, token: UUID,
                                 continuation: AsyncStream<RealtimeEvent>.Continuation) async {
        channelStreams[channel, default: [:]][token] = continuation
    }
    private func unregisterChannel(_ channel: ChannelID, token: UUID) async {
        channelStreams[channel]?[token] = nil
    }
    private func registerAgent(_ channel: ChannelID, token: UUID,
                               continuation: AsyncStream<AgentEvent>.Continuation) async {
        agentStreams[channel, default: [:]][token] = continuation
    }
    private func unregisterAgent(_ channel: ChannelID, token: UUID) async {
        agentStreams[channel]?[token] = nil
    }
}

/// Convenience bundle returned from `seedDemo()`.
public struct DemoSeed: Sendable {
    public let workspace: WorkspaceID
    public let human: Member
    public let agents: [Member]
    public let channels: [Channel]
}
