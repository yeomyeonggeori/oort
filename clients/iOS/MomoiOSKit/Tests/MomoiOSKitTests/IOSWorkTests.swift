import Foundation
import MomoCore
@testable import MomoiOSKit
import Testing

@Suite("MomoiOSKit Work")
struct IOSWorkTests {
    @Test("REST projections decode sessions hosts and pool without private terminal material")
    func workProjectionMapping() throws {
        let sessions = Data(#"{"workSessions":[{"id":"00000000-0000-7000-8000-000000000505","workspaceId":"00000000-0000-7000-8000-000000000001","channelId":"00000000-0000-7000-8000-000000000010","memberId":"00000000-0000-7000-8000-000000000002","hostId":"00000000-0000-7000-8000-000000000020","rootMessageId":"00000000-0000-7000-8000-000000000030","tool":"codex","label":"Ship the mobile Work tab","status":"running","observation":"open","observerGrantCount":0,"remoteAttachAvailable":true,"startedAtMs":1784632000000}]}"#.utf8)
        let hosts = Data(#"{"workHosts":[{"id":"00000000-0000-7000-8000-000000000020","workspaceId":"00000000-0000-7000-8000-000000000001","scope":"member","ownerMemberId":"00000000-0000-7000-8000-000000000002","type":"app","displayName":"Sungjae Mac","publicKey":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","capabilities":{"codex":true},"lastSeenAtMs":1784632000000,"revokedAtMs":null,"createdAtMs":1784631000000,"online":true}]}"#.utf8)
        let pool = Data(#"{"workPool":{"workspaceId":"00000000-0000-7000-8000-000000000001","maxActive":4,"includedActiveHours":20,"perMemberSoftLimit":2,"activeSessions":1,"memberActiveSessions":1}}"#.utf8)

        let snapshot = try MomoServerConversationClient.mapWorkSnapshot(
            sessionsData: sessions,
            hostsData: hosts,
            poolData: pool
        )

        #expect(snapshot.sessions.count == 1)
        #expect(snapshot.sessions[0].tool == .codex)
        #expect(snapshot.sessions[0].remoteAttachAvailable)
        #expect(snapshot.hosts[0].displayName == "Sungjae Mac")
        #expect(snapshot.hosts[0].online)
        #expect(snapshot.pool.activeSessions == 1)
        #expect(snapshot.pool.maxActive == 4)
        let encoded = String(decoding: sessions, as: UTF8.self)
        #expect(!encoded.contains("capability_token"))
        #expect(!encoded.contains("attach_endpoint"))
        #expect(!encoded.contains("cwd"))
    }

    @Test("thread message projection preserves root identity and credential-free attachment metadata")
    func threadMessageProjection() throws {
        let data = Data(#"{"id":"00000000-0000-7000-b000-000000000001","channelId":"00000000-0000-7000-8000-000000000010","seq":2,"hlcTs":2,"hlcCount":0,"authorMemberId":"00000000-0000-7000-8000-000000000002","type":"text","body":"result","rootId":"00000000-0000-7000-9000-000000000001","attachments":[{"id":"00000000-0000-7000-e000-000000000001","name":"result.txt","mime":"text/plain","sizeBytes":42}],"createdAtMs":2}"#.utf8)

        let message = try JSONDecoder().decode(IOSMessageDTO.self, from: data).value()

        #expect(message.rootId == MessageID(uuidString: "00000000-0000-7000-9000-000000000001"))
        #expect(message.attachments?.first?.name == "result.txt")
        #expect(message.attachments?.first?.sizeBytes == 42)
    }

    @MainActor
    @Test("Work model sorts active sessions and exposes developer summary and filter")
    func workListPresentation() async throws {
        let running = workSession(status: .running, startedAtMs: 2_000, suffix: 1)
        let ended = workSession(status: .ended, startedAtMs: 3_000, endedAtMs: 9_000, suffix: 2)
        let backend = SequenceWorkBackend(snapshots: [workSnapshot(sessions: [ended, running])])
        let model = IOSWorkListModel(backend: backend)

        await model.retry()

        #expect(model.phase == .loaded)
        #expect(model.sessions.map(\.id) == [running.id, ended.id])
        #expect(model.summary.runningCount == 1)
        #expect(model.summary.completedCount == 1)
        model.filter = .running
        #expect(model.visibleSessions.map(\.id) == [running.id])
        #expect(ended.elapsedDescription(now: Date(timeIntervalSince1970: 20)) == "< 1 min")
    }

    @MainActor
    @Test("work session realtime hint reloads the authoritative REST projection")
    func realtimeRefreshesProjection() async throws {
        let running = workSession(status: .running, startedAtMs: 2_000, suffix: 3)
        let ended = workSession(status: .ended, startedAtMs: 2_000, endedAtMs: 62_000, suffix: 3)
        let backend = SequenceWorkBackend(snapshots: [
            workSnapshot(sessions: [running]),
            workSnapshot(sessions: [ended]),
        ])
        let model = IOSWorkListModel(backend: backend)
        await model.retry()

        await model.receive(WorkSessionDelta(
            action: .ended,
            sessionId: running.id,
            channelId: running.channelId,
            rootMessageId: running.rootMessageId,
            memberId: running.memberId,
            hostId: running.hostId,
            tool: .codex,
            label: running.label,
            endedAtMs: 62_000,
            exitCode: 0
        ))

        #expect(model.sessions.first?.status == .ended)
        #expect(model.sessions.first?.exitCode == 0)
        #expect(await backend.snapshotCallCount == 2)
    }

    @MainActor
    @Test("Work detail pages the root thread and sends input and read requests through the public thread")
    func workDetailThreadAndIntervention() async throws {
        let session = workSession(status: .running, startedAtMs: 2_000, suffix: 506)
        let agent = workAgent()
        let firstReply = workReply(sequence: 2, root: session.rootMessageId)
        let secondReply = workReply(sequence: 3, root: session.rootMessageId)
        let backend = WorkDetailBackend(replyPages: [
            IOSThreadRepliesPage(messages: [firstReply], nextCursor: 2),
            IOSThreadRepliesPage(messages: [secondReply], nextCursor: nil),
        ])
        let model = IOSTimelineModel(
            channel: session.channelId,
            currentMemberID: workMemberID,
            backend: backend,
            threadRoot: session.rootMessageId,
            workAgentMemberID: agent.id,
            workAgentHandle: agent.handle,
            workSessionID: session.id
        )

        await model.load()
        #expect(model.messages.map(\.id) == [firstReply.id, secondReply.id])
        #expect(await backend.replyRequestCount == 2)

        model.composerDraft = "검증 로그에서 실패한 단계만 다시 실행해줘."
        await model.sendComposerDraft()
        await model.requestCurrentWorkOutput()

        let drafts = await backend.sentDrafts
        #expect(drafts.count == 2)
        #expect(drafts[0].rootId == session.rootMessageId)
        #expect(drafts[0].replyToId == session.rootMessageId)
        #expect(drafts[0].body?.contains("@hermes work_input") == true)
        #expect(drafts[0].body?.contains(session.id.description.lowercased()) == true)
        #expect(drafts[1].body?.contains("@hermes work_read") == true)
        #expect(drafts[1].body?.contains(session.id.description.lowercased()) == true)
        model.stop()
    }

    @MainActor
    @Test("AgentPartial is redacted, scoped to the selected agent run, and replaced by a durable thread message")
    func workDetailAgentPartialProjection() async throws {
        let session = workSession(status: .running, startedAtMs: 2_000, suffix: 507)
        let agent = workAgent()
        let backend = WorkDetailBackend()
        let model = IOSTimelineModel(
            channel: session.channelId,
            currentMemberID: workMemberID,
            backend: backend,
            threadRoot: session.rootMessageId,
            workAgentMemberID: agent.id,
            workAgentHandle: agent.handle,
            workSessionID: session.id
        )
        let runID = RunID(uuidString: "00000000-0000-7000-A000-000000000506")!
        let partial = AgentPartial(
            runId: runID,
            channelId: session.channelId,
            textDelta: "테스트를 실행 중입니다.",
            toolCallName: "shell",
            toolCallArgs: ["secret": "must-not-project"],
            spentMicroUSD: 42
        )

        await model.load()
        await model.consumeRealtimeEvent(.agentPartial(partial))
        #expect(model.agentPartials.isEmpty)

        await model.consumeRealtimeEvent(.agentStatus(AgentStatus(
            runId: runID,
            agentMemberId: agent.id,
            channelId: session.channelId,
            phase: .streaming,
            runStatus: .running
        )))
        await model.consumeRealtimeEvent(.agentPartial(partial))
        let projection = try #require(model.agentPartials.first)
        #expect(projection.text == "테스트를 실행 중입니다.")
        #expect(projection.toolCallName == "shell")
        #expect(projection.spentMicroUSD == 42)

        await model.consumeRealtimeEvent(.message(workReply(
            sequence: 4,
            root: session.rootMessageId,
            author: agent.id,
            runID: runID
        )))
        #expect(model.agentPartials.isEmpty)
        model.stop()
    }

    @MainActor
    @Test("Auto-approve uses the server snapshot and never presents an unknown value as disabled")
    func workAutoApprovalSnapshot() async {
        let backend = WorkDetailBackend(autoApprovalTools: [.codex])
        let model = IOSWorkAutoApprovalModel(backend: backend)
        await model.load()

        #expect(model.hasLoadedSnapshot)
        #expect(model.enabledTools == [.codex])
        await model.set(.codex, enabled: false)
        #expect(model.enabledTools.isEmpty)
        #expect(await backend.autoApprovalMutations == [.init(tool: .codex, enabled: false)])

        let failingModel = IOSWorkAutoApprovalModel(
            backend: WorkDetailBackend(failsAutoApprovalLoad: true)
        )
        await failingModel.load()
        #expect(!failingModel.hasLoadedSnapshot)
        #expect(failingModel.inlineFailureMessage != nil)
    }

    @MainActor
    @Test("Work approval inbox keeps only pending Work controls and removes an approved request")
    func workApprovalInboxProjection() async throws {
        let pending = workApproval(kind: "work_control_approval", status: .pending, suffix: 1)
        let unrelated = workApproval(kind: "github.issue.create", status: .pending, suffix: 2)
        let decided = workApproval(kind: "work_control_approval", status: .approved, suffix: 3)
        let backend = WorkDetailBackend(history: [unrelated, decided, pending])
        let model = IOSWorkApprovalInboxModel(backend: backend)

        await model.refresh(channelIDs: [workChannelID])
        #expect(model.messages.map(\.id) == [pending.id])
        await model.decide(pending, approve: true)
        #expect(model.messages.isEmpty)
        #expect(await backend.approvalDecisionCount == 1)
    }
}

private actor SequenceWorkBackend: IOSWorkBackend {
    private let snapshots: [IOSWorkSnapshot]
    private(set) var snapshotCallCount = 0

    init(snapshots: [IOSWorkSnapshot]) {
        self.snapshots = snapshots
    }

    func workSnapshot() async throws -> IOSWorkSnapshot {
        let index = min(snapshotCallCount, snapshots.count - 1)
        snapshotCallCount += 1
        return snapshots[index]
    }

    func workEvents(channel: ChannelID) async throws -> AsyncStream<WorkSessionDelta> {
        AsyncStream { $0.finish() }
    }
}

private actor WorkDetailBackend: IOSConversationBackend, IOSWorkPreferencesBackend {
    struct AutoApprovalMutation: Sendable, Equatable {
        let tool: IOSWorkSessionTool
        let enabled: Bool
    }

    private let replyPages: [IOSThreadRepliesPage]
    private let historyValue: [Message]
    private let failsAutoApprovalLoad: Bool
    private var autoApprovalToolsValue: Set<IOSWorkSessionTool>
    private(set) var replyRequestCount = 0
    private(set) var sentDrafts: [DraftMessage] = []
    private(set) var autoApprovalMutations: [AutoApprovalMutation] = []
    private(set) var approvalDecisionCount = 0

    init(
        replyPages: [IOSThreadRepliesPage] = [],
        history: [Message] = [],
        autoApprovalTools: Set<IOSWorkSessionTool> = [],
        failsAutoApprovalLoad: Bool = false
    ) {
        self.replyPages = replyPages
        self.historyValue = history
        self.autoApprovalToolsValue = autoApprovalTools
        self.failsAutoApprovalLoad = failsAutoApprovalLoad
    }

    func snapshot() async throws -> IOSConversationSnapshot {
        IOSConversationSnapshot(
            channels: [Channel(id: workChannelID, workspaceId: workWorkspaceID, kind: .publicChannel, name: "general")],
            members: [workAgent()],
            readStates: []
        )
    }

    func history(channel: ChannelID, after sequence: Int64?, limit: Int) async throws -> [Message] {
        historyValue
    }

    func threadReplies(
        channel: ChannelID,
        root: MessageID,
        cursor: Int64?,
        limit: Int
    ) async throws -> IOSThreadRepliesPage {
        let index = replyRequestCount
        replyRequestCount += 1
        guard index < replyPages.count else {
            return IOSThreadRepliesPage(messages: [], nextCursor: nil)
        }
        return replyPages[index]
    }

    func markRead(channel: ChannelID, through sequence: Int64) async throws -> ChannelReadState {
        ChannelReadState(
            channelId: channel,
            lastReadSeq: sequence,
            latestSeq: sequence,
            unreadCount: 0,
            mentionCount: 0
        )
    }

    func setChannelMuted(_ channel: ChannelID, muted: Bool) async throws -> Bool { muted }
    func subscribe(channel: ChannelID) async throws -> AsyncStream<RealtimeEvent> {
        AsyncStream { $0.finish() }
    }
    func realtimeStatus(channel: ChannelID) async -> AsyncStream<RealtimeConnectionStatus> {
        AsyncStream { $0.finish() }
    }

    func send(_ draft: DraftMessage, clientMsgId: UUID) async throws -> Message {
        sentDrafts.append(draft)
        return Message(
            id: MessageID(),
            channelId: draft.channelId,
            seq: Int64(100 + sentDrafts.count),
            hlcTs: Int64(100 + sentDrafts.count),
            authorMemberId: workMemberID,
            type: draft.type,
            body: draft.body,
            props: draft.props,
            rootId: draft.rootId,
            replyToId: draft.replyToId,
            clientMsgId: clientMsgId
        )
    }

    func decideApproval(_ request: ApprovalDecisionRequest) async throws -> ApprovalDecisionReceipt {
        approvalDecisionCount += 1
        return ApprovalDecisionReceipt(approvalId: request.approvalId, status: request.status)
    }

    func workAutoApprovalTools() async throws -> Set<IOSWorkSessionTool> {
        if failsAutoApprovalLoad { throw SessionError.transport("offline") }
        return autoApprovalToolsValue
    }

    func setWorkAutoApproval(tool: IOSWorkSessionTool, enabled: Bool) async throws -> Bool {
        autoApprovalMutations.append(.init(tool: tool, enabled: enabled))
        if enabled { autoApprovalToolsValue.insert(tool) } else { autoApprovalToolsValue.remove(tool) }
        return enabled
    }
}

private let workWorkspaceID = WorkspaceID(uuidString: "00000000-0000-7000-8000-000000000001")!
private let workChannelID = ChannelID(uuidString: "00000000-0000-7000-8000-000000000010")!
private let workMemberID = MemberID(uuidString: "00000000-0000-7000-8000-000000000002")!
private let workHostID = WorkHostID(uuidString: "00000000-0000-7000-8000-000000000020")!
private let workAgentID = MemberID(uuidString: "00000000-0000-7000-8000-000000000099")!

private func workAgent() -> Member {
    Member(
        id: workAgentID,
        workspaceId: workWorkspaceID,
        kind: .agent,
        displayName: "Hermes",
        handle: "hermes"
    )
}

private func workReply(
    sequence: Int64,
    root: MessageID,
    author: MemberID = workMemberID,
    runID: RunID? = nil
) -> Message {
    Message(
        id: MessageID(uuidString: String(format: "00000000-0000-7000-B000-%012lld", sequence))!,
        channelId: workChannelID,
        seq: sequence,
        hlcTs: sequence,
        authorMemberId: author,
        body: "Work thread reply \(sequence)",
        rootId: root,
        replyToId: root,
        runId: runID,
        createdAtMs: sequence
    )
}

private func workApproval(
    kind: String,
    status: ApprovalStatus,
    suffix: Int
) -> Message {
    Message(
        id: MessageID(uuidString: String(format: "00000000-0000-7000-C000-%012d", suffix))!,
        channelId: workChannelID,
        seq: Int64(suffix),
        hlcTs: Int64(suffix),
        authorMemberId: workAgentID,
        type: .approvalRequest,
        body: "Approve Work control",
        props: [
            "approval_id": .string(String(format: "00000000-0000-7000-D000-%012d", suffix)),
            "approval_status": .string(status.rawValue),
            "kind": .string(kind),
        ],
        createdAtMs: Int64(suffix)
    )
}

private func workSession(
    status: IOSWorkSessionStatus,
    startedAtMs: Int64,
    endedAtMs: Int64? = nil,
    suffix: Int
) -> IOSWorkSession {
    IOSWorkSession(
        id: WorkSessionID(uuidString: String(format: "00000000-0000-7000-8000-%012d", suffix))!,
        workspaceId: workWorkspaceID,
        channelId: workChannelID,
        memberId: workMemberID,
        hostId: workHostID,
        rootMessageId: MessageID(uuidString: String(format: "00000000-0000-7000-9000-%012d", suffix))!,
        tool: .codex,
        label: "Session \(suffix)",
        status: status,
        startedAtMs: startedAtMs,
        endedAtMs: endedAtMs,
        exitCode: status == .ended ? 0 : nil
    )
}

private func workSnapshot(sessions: [IOSWorkSession]) -> IOSWorkSnapshot {
    IOSWorkSnapshot(
        sessions: sessions,
        hosts: [
            WorkHost(
                id: workHostID,
                workspaceId: workWorkspaceID,
                scope: .member,
                ownerMemberId: workMemberID,
                type: .app,
                displayName: "Sungjae Mac",
                publicKey: "test-public-key",
                createdAtMs: 1,
                online: true
            ),
        ],
        pool: IOSWorkPool(
            workspaceId: workWorkspaceID,
            maxActive: 4,
            perMemberSoftLimit: 2,
            activeSessions: sessions.count(where: \.isRunning),
            memberActiveSessions: sessions.count(where: \.isRunning)
        )
    )
}
