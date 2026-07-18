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

public actor LiveChatBackend: ChatBackend, WorkspaceBackend, AgentTransport, AgentWorkRunBackend, ReadStateBackend, AuthenticatedMemberIDProvidingBackend, OnboardingInviteBackend, MomoAgentCredentialBackend, RealtimeStatusProvidingBackend, MomoSessionSensitiveStateClearing, MomoMessageInteractionBackend {
    // In-memory SoT surrogate.
    private var workspace: WorkspaceID?
    private var workspaceProfile: Workspace?
    private var connected = false
    private var members: [Member] = []
    private var channels: [Channel] = []
    private var messagesByChannel: [ChannelID: [Message]] = [:]
    private var reactionsByMessage: [MessageID: [String: Set<MemberID>]] = [:]
    private var seqByChannel: [ChannelID: Int64] = [:]
    private var sentClientMsgIds: [ChannelID: Set<UUID>] = [:]
    private var readCursorsByMember: [MemberID: [ChannelID: Int64]] = [:]
    private var approvalsById: [ApprovalID: Approval] = [:]
    private var workRunsById: [RunID: AgentWorkRun] = [:]
    private var workRunIdsByClientId: [UUID: RunID] = [:]
    private var inviteJoinState: InviteJoinState = .idle
    private var credentialsByAgent: [MemberID: [MomoAgentCredential]] = [:]

    // Realtime fan-out continuations, keyed by channel.
    private var channelStreams: [ChannelID: [UUID: AsyncStream<RealtimeEvent>.Continuation]] = [:]
    private var agentStreams: [ChannelID: [UUID: AsyncStream<AgentEvent>.Continuation]] = [:]
    private var demoRealtimeByChannel: [ChannelID: [RealtimeEvent]] = [:]
    private var demoCostSnapshotsByChannel: [ChannelID: [CostSnapshot]] = [:]
    private var replayedDemoDeltaChannels: Set<ChannelID> = []
    private var realtimeStatusByChannel: [ChannelID: RealtimeConnectionStatus] = [:]
    private var realtimeStatusStreams: [ChannelID: [UUID: AsyncStream<RealtimeConnectionStatus>.Continuation]] = [:]
    private var readStateStreams: [MemberID: [UUID: AsyncThrowingStream<ChannelReadState, Error>.Continuation]] = [:]
    private var demoSeedBaseTimestampMs: Int64?

    public init() {}

    // MARK: Seeding (demo fixtures)

    /// Seed the in-memory store with a demo workspace so the UI has content offline.
    /// Returns the seeded workspace + first channel for convenience.
    public func seedDemo(
        capabilitiesByHandle: [String: [String]] = [:],
        displayNamesByHandle: [String: String] = [:],
        baseTimestampMs: Int64? = nil
    ) -> DemoSeed {
        demoSeedBaseTimestampMs = baseTimestampMs
        defer { demoSeedBaseTimestampMs = nil }
        let ws = WorkspaceID()
        workspace = ws
        workspaceProfile = Workspace(id: ws, slug: "momo-demo", name: "momo")
        inviteJoinState = .idle
        demoRealtimeByChannel = [:]
        demoCostSnapshotsByChannel = [:]
        replayedDemoDeltaChannels = []
        approvalsById = [:]
        workRunsById = [:]
        workRunIdsByClientId = [:]
        credentialsByAgent = [:]
        readCursorsByMember = [:]

        var human = Member(id: MemberID(), workspaceId: ws, kind: .human,
                           displayName: displayNamesByHandle["sangjun"] ?? "상준",
                           handle: "sangjun", workspaceRole: .owner,
                           presence: .online)
        var researcher = Member(id: MemberID(), workspaceId: ws, kind: .agent,
                                displayName: displayNamesByHandle["hermes"] ?? "Hermes",
                                handle: "hermes",
                                workspaceRole: .member,
                                capabilities: capabilitiesByHandle["hermes"] ?? [],
                                presence: .working)
        var builder = Member(id: MemberID(), workspaceId: ws, kind: .agent,
                             displayName: displayNamesByHandle["buildbot"] ?? "빌드봇",
                             handle: "buildbot",
                             workspaceRole: .member,
                             capabilities: capabilitiesByHandle["buildbot"] ?? [],
                             presence: .online)

        let general = Channel(id: ChannelID(), workspaceId: ws, kind: .publicChannel,
                              name: "general", topic: "팀 일반 채널", createdBy: human.id)
        let pg18 = Channel(id: ChannelID(), workspaceId: ws, kind: .publicChannel,
                           name: "feature-pg18", topic: "PG18 마이그레이션", createdBy: human.id)
        channels = [general, pg18]
        human.channelIds = channels.map(\.id)
        researcher.channelIds = channels.map(\.id)
        builder.channelIds = [pg18.id]
        members = [human, researcher, builder]
        for ch in channels {
            messagesByChannel[ch.id] = []
            seqByChannel[ch.id] = 0
            sentClientMsgIds[ch.id] = []
        }

        // The first channel reads like a real team conversation in standard mode.
        // Structured protocol fixtures remain available behind developer mode.
        _ = appendServerMessage(channel: general.id, author: human.id, type: .text,
                                body: "오늘 3시 내부 알파 배포 전에 체크리스트만 한 번 더 맞춰볼게요.")
        _ = appendServerMessage(
            channel: general.id,
            author: researcher.id,
            type: .text,
            body: "좋아요. 제가 migration, smoke evidence, 공지 초안을 확인하고 빠진 항목만 정리할게요.",
            props: .object([
                "mention_member_ids": .array([.string(human.id.description)]),
            ]),
            runId: RunID()
        )
        let toolRun = RunID()
        _ = appendServerMessage(
            channel: pg18.id, author: researcher.id, type: .toolCall,
            body: nil,
            props: .object([
                "human_summary": .string("Hermes가 PG18 관련 이슈를 확인하고 있습니다."),
                "human_detail": .string("배포 체크리스트에 반영할 최근 migration 검증 기록을 GitHub에서 찾습니다."),
                "name": .string("github.search_issues"),
                "arguments": .object([
                    "query": .string("repo:Dawn-kim-official/momo PG18 migration"),
                    "limit": .int(5),
                ]),
                "call_id": .string("call_pg18_search_001"),
                "requires_approval": .bool(false),
                "context_packet": .object([
                    "packet_id": .string("10000000-0000-7000-8000-000000000170"),
                    "scope": .string("#feature-pg18"),
                    "source_count": .int(2),
                    "memory_count": .int(1),
                ]),
                "capability": .object([
                    "provider": .string("github"),
                    "tool_name": .string("github.search_issues"),
                    "risk": .string("read"),
                    "approval_policy": .string("none"),
                    "input_schema_ref": .string("momo://capability-cache/github.search_issues/schemas/input/sha256:demo"),
                    "resource_scope_summary": .string("repo:Dawn-kim-official/momo"),
                    "capability_version": .string("github-plugin@0.3.0"),
                    "policy_version": .string("capability-policy@2026-06-26"),
                ]),
                "source_badges": .array([
                    .object([
                        "source_id": .string("src_pg18_thread"),
                        "kind": .string("thread"),
                        "title": .string("#feature-pg18 migration thread"),
                        "uri": .string("momo://channels/feature-pg18/messages/1"),
                        "permission_snapshot": .string("actor:read channel:member"),
                    ]),
                    .object([
                        "source_id": .string("src_github_migration"),
                        "kind": .string("github"),
                        "title": .string("M1 runtime migration issue"),
                        "uri": .string("https://github.com/Dawn-kim-official/momo/issues/1"),
                        "permission_snapshot": .string("provider:read repo:momo"),
                    ]),
                ]),
                "memory_citations": .array([
                    .object([
                        "memory_id": .string("20000000-0000-7000-8000-000000000170"),
                        "type": .string("decision"),
                        "label": .string("PG18 remains the system of record"),
                        "source_ids": .array([.string("src_pg18_thread")]),
                        "permission_snapshot": .string("actor:read channel:member"),
                    ]),
                ]),
                "estimated_micro_usd": .int(120_000),
            ]),
            runId: toolRun)

        _ = appendServerMessage(
            channel: pg18.id,
            author: researcher.id,
            type: .toolResult,
            body: nil,
            props: .object([
                "human_summary": .string("Hermes가 최근 검증 기록 2건을 찾았습니다."),
                "human_detail": .string("migrate idempotency와 runtime gate가 모두 통과한 기록을 확인했습니다."),
                "tool_name": .string("github.search_issues"),
                "call_id": .string("call_pg18_search_001"),
                "is_error": .bool(false),
                "output": .object([
                    "matches": .int(2),
                    "top_result": .string("MOMO-001 Runtime Gate verified migrate idempotency"),
                ]),
                "artifact_ref": .object([
                    "artifact_id": .string("artifact_pg18_search_results"),
                    "kind": .string("search_results"),
                    "uri": .string("momo://artifacts/pg18-search-results"),
                ]),
                "context_packet": .object([
                    "packet_id": .string("10000000-0000-7000-8000-000000000170"),
                    "scope": .string("#feature-pg18"),
                    "source_count": .int(2),
                    "memory_count": .int(1),
                ]),
                "source_badges": .array([
                    .object([
                        "source_id": .string("src_github_migration"),
                        "kind": .string("github"),
                        "title": .string("MOMO-001 Runtime Gate"),
                        "uri": .string("https://github.com/Dawn-kim-official/momo/issues/1"),
                        "permission_snapshot": .string("provider:read repo:momo"),
                    ]),
                ]),
                "spent_micro_usd": .int(51_000),
            ]),
            runId: toolRun
        )
        demoCostSnapshotsByChannel[pg18.id] = [
            CostSnapshot(
                runId: toolRun,
                reservedMicroUSD: 0,
                spentMicroUSD: 51_000,
                softLimitMicroUSD: 750_000,
                hardLimitMicroUSD: 1_000_000,
                isReconciled: true,
                wasEstimated: false,
                limitState: .normal
            )
        ]

        _ = appendServerMessage(
            channel: pg18.id,
            author: researcher.id,
            type: .artifact,
            body: nil,
            props: .object([
                "human_summary": .string("Hermes가 PG18 배포 런북 초안을 첨부했습니다."),
                "human_detail": .string("확인된 runtime gate를 인용한 migration 순서와 롤백 절차가 들어 있습니다."),
                "artifact_id": .string("artifact_pg18_runbook_patch"),
                "kind": .string("runbook_draft"),
                "title": .string("PG18 migration runbook patch"),
                "uri": .string("momo://artifacts/pg18-runbook-patch"),
                "context_packet": .object([
                    "packet_id": .string("10000000-0000-7000-8000-000000000170"),
                    "scope": .string("#feature-pg18"),
                    "source_count": .int(2),
                    "memory_count": .int(1),
                ]),
                "memory_citations": .array([
                    .object([
                        "memory_id": .string("20000000-0000-7000-8000-000000000171"),
                        "type": .string("artifact_ref"),
                        "label": .string("Migration runbook should cite verified runtime gates"),
                        "source_ids": .array([.string("src_github_migration")]),
                        "permission_snapshot": .string("actor:read channel:member"),
                    ]),
                ]),
                "source_badges": .array([
                    .object([
                        "source_id": .string("src_pg18_thread"),
                        "kind": .string("thread"),
                        "title": .string("#feature-pg18 migration thread"),
                        "uri": .string("momo://channels/feature-pg18/messages/1"),
                        "permission_snapshot": .string("actor:read channel:member"),
                    ]),
                ]),
            ]),
            runId: toolRun
        )

        let approvalRun = RunID()
        let approvalId = ApprovalID()
        let approvalMessage = appendServerMessage(
            channel: general.id,
            author: researcher.id,
            type: .approvalRequest,
            body: nil,
            props: .object([
                "approval_id": .string(approvalId.description),
                "approval_status": .string(ApprovalStatus.pending.rawValue),
                "action_type": .string("github.issue.create"),
                "title": .string("내부 알파 배포 체크리스트 이슈 만들기"),
                "summary": .string("GitHub에 체크리스트 이슈를 만든 뒤 배포 준비 항목을 기록합니다."),
                "human_summary": .string("Hermes가 GitHub에 내부 알파 배포 체크리스트 이슈를 만들려고 합니다."),
                "human_detail": .string("승인하면 Dawn-kim-official/momo 저장소에 추적용 이슈 하나를 만듭니다."),
                "requires_approval": .bool(true),
                "context_packet": .object([
                    "packet_id": .string("10000000-0000-7000-8000-000000000171"),
                    "scope": .string("#general"),
                    "source_count": .int(1),
                    "memory_count": .int(1),
                ]),
                "capability": .object([
                    "provider": .string("github"),
                    "tool_name": .string("github.create_issue"),
                    "risk": .string("write"),
                    "approval_policy": .string("always"),
                    "input_schema_ref": .string("momo://capability-cache/github.create_issue/schemas/input/sha256:demo"),
                    "resource_scope_summary": .string("repo:Dawn-kim-official/momo"),
                    "capability_version": .string("github-plugin@0.3.0"),
                    "policy_version": .string("capability-policy@2026-06-26"),
                ]),
                "source_badges": .array([
                    .object([
                        "source_id": .string("src_general_rollout"),
                        "kind": .string("message"),
                        "title": .string("rollout checklist request"),
                        "uri": .string("momo://channels/general/messages/3"),
                        "permission_snapshot": .string("actor:read channel:member"),
                    ]),
                ]),
                "memory_citations": .array([
                    .object([
                        "memory_id": .string("20000000-0000-7000-8000-000000000172"),
                        "type": .string("preference"),
                        "label": .string("External writes require explicit approval"),
                        "source_ids": .array([.string("src_general_rollout")]),
                        "permission_snapshot": .string("actor:read channel:member"),
                    ]),
                ]),
                "estimated_micro_usd": .int(820_000),
            ]),
            runId: approvalRun
        )
        approvalsById[approvalId] = Approval(
            id: approvalId,
            workspaceId: ws,
            runId: approvalRun,
            channelId: general.id,
            requestMessageId: approvalMessage.id,
            requestedBy: researcher.id,
            onBehalfOf: human.id,
            actionType: "github.issue.create",
            payload: .object([
                "repo": .string("Dawn-kim-official/momo"),
                "title": .string("내부 알파 배포 체크리스트 이슈 만들기"),
                "estimated_micro_usd": .int(820_000),
                "is_reversible": .bool(true),
            ]),
            status: .pending,
            estimatedMicroUSD: 820_000,
            isReversible: true
        )
        demoRealtimeByChannel[general.id] = [
            .agentStatus(AgentStatus(
                runId: approvalRun,
                agentMemberId: researcher.id,
                channelId: general.id,
                phase: .streaming,
                runStatus: .awaitingApproval,
                reservedMicroUSD: 820_000,
                spentMicroUSD: 340_000
            )),
            .agentPartial(AgentPartial(
                runId: approvalRun,
                channelId: general.id,
                textDelta: "체크리스트 초안을 정리했습니다. GitHub 이슈를 만들기 전에 승인을 기다리고 있어요.",
                toolCallName: "github.issue.create",
                toolCallArgs: .object([
                    "repo": .string("Dawn-kim-official/momo"),
                    "labels": .array([.string("status:ready"), .string("area:macos")]),
                ]),
                spentMicroUSD: 340_000
            )),
            .approval(ApprovalEvent(
                action: .requested,
                approvalId: approvalId,
                runId: approvalRun,
                channelId: general.id,
                requestedBy: researcher.id,
                onBehalfOf: human.id,
                actionType: "github.issue.create",
                status: .pending,
                payload: .object([
                    "repo": .string("Dawn-kim-official/momo"),
                    "title": .string("내부 알파 배포 체크리스트 이슈 만들기"),
                ]),
                estimatedMicroUSD: 820_000,
                isReversible: true
            )),
        ]
        demoCostSnapshotsByChannel[general.id] = [
            CostSnapshot(
                runId: approvalRun,
                reservedMicroUSD: 820_000,
                spentMicroUSD: 340_000,
                softLimitMicroUSD: 900_000,
                hardLimitMicroUSD: 1_000_000,
                isReconciled: false,
                wasEstimated: true,
                limitState: .softLimit
            )
        ]

        return DemoSeed(workspace: ws, human: human, agents: [researcher, builder],
                        channels: channels)
    }

    func seedDemoWorkRun(_ run: AgentWorkRun) {
        workRunsById[run.id] = run
    }

    @discardableResult
    func seedDemoMessage(channel: ChannelID, author: MemberID, body: String) -> Message {
        appendServerMessage(channel: channel, author: author, type: .text, body: body)
    }

    // MARK: OnboardingInviteBackend

    public func currentInviteJoinState() async -> InviteJoinState {
        inviteJoinState
    }

    public func joinWorkspace(inviteCode: String) async -> InviteJoinState {
        let trimmed = inviteCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            inviteJoinState = .failed(InviteJoinFailure(
                code: "",
                reason: "Invite code required",
                recoveryHint: "Enter MOMO-012 for the dev fixture."
            ))
            return inviteJoinState
        }

        inviteJoinState = .validating(code: trimmed)
        try? await Task.sleep(for: .milliseconds(250))

        switch trimmed.uppercased() {
        case "MOMO-012", "MOMO-DEV", "DAWN-LAB":
            let ws = workspace ?? WorkspaceID()
            let joined = JoinedWorkspace(
                workspace: Workspace(id: ws, slug: "dawn-lab", name: "Dawn Lab"),
                role: "member",
                defaultChannelNames: channels.compactMap(\.name),
                joinedMemberCount: members.filter { $0.kind == .human }.count + 1
            )
            inviteJoinState = .joined(joined)
        case "EXPIRED":
            inviteJoinState = .failed(InviteJoinFailure(
                code: trimmed,
                reason: "Invite expired",
                recoveryHint: "Ask an owner for a fresh code."
            ))
        case "USED-UP":
            inviteJoinState = .failed(InviteJoinFailure(
                code: trimmed,
                reason: "Invite already used",
                recoveryHint: "Use MOMO-012 to see the success path."
            ))
        default:
            inviteJoinState = .failed(InviteJoinFailure(
                code: trimmed,
                reason: "Invite not found",
                recoveryHint: "Try MOMO-012, EXPIRED, or USED-UP in the dev app."
            ))
        }

        return inviteJoinState
    }

    // MARK: ChatBackend

    public func connect(workspace: WorkspaceID, accessToken: String) async throws {
        // TODO(T09-followup): REST auth → realtime-token → SwiftCentrifuge connect.
        self.workspace = workspace
        self.connected = true
    }

    func authenticatedMemberID() async -> MemberID? {
        members.first { $0.kind == .human && $0.status == .active }?.id
    }

    public func clearSessionSensitiveState() async {
        workspace = nil
        workspaceProfile = nil
        connected = false
        for continuations in channelStreams.values {
            for continuation in continuations.values {
                continuation.finish()
            }
        }
        for continuations in agentStreams.values {
            for continuation in continuations.values {
                continuation.finish()
            }
        }
        for continuations in realtimeStatusStreams.values {
            for continuation in continuations.values {
                continuation.finish()
            }
        }
        for continuations in readStateStreams.values {
            for continuation in continuations.values {
                continuation.finish()
            }
        }
        channelStreams = [:]
        agentStreams = [:]
        realtimeStatusStreams = [:]
        realtimeStatusByChannel = [:]
        readStateStreams = [:]
        credentialsByAgent = [:]
        workRunsById = [:]
        workRunIdsByClientId = [:]
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
        if draft.type == .text,
           let body = draft.body,
           let agent = mentionedAgent(in: body, channel: ch) {
            appendDemoMentionResponse(agent: agent, channel: ch, trigger: msg, prompt: body)
        }
        return msg
    }

    public func subscribe(channel: ChannelID) async throws -> AsyncStream<RealtimeEvent> {
        guard connected else { throw BackendError.notConnected }
        emitRealtimeStatus(RealtimeConnectionStatus(
            channelId: channel,
            connection: .connected,
            subscription: .subscribed,
            message: "Demo realtime connected."
        ))
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

    public func channels(workspace: WorkspaceID) async throws -> [Channel] {
        channels.filter { $0.workspaceId == workspace }
    }

    public func workspace(id: WorkspaceID) async throws -> Workspace {
        guard connected, workspace == id else { throw BackendError.notConnected }
        if let workspaceProfile, workspaceProfile.id == id {
            return workspaceProfile
        }
        let profile = Workspace(id: id, slug: "momo-demo", name: "momo")
        workspaceProfile = profile
        return profile
    }

    public func updateWorkspaceName(
        workspace: WorkspaceID,
        name: String,
        expectedUpdatedAtMs: Int64
    ) async throws -> Workspace {
        guard connected, self.workspace == workspace else { throw BackendError.notConnected }
        var profile = workspaceProfile ?? Workspace(id: workspace, slug: "momo-demo", name: "momo")
        guard profile.updatedAtMs == expectedUpdatedAtMs else {
            throw BackendError.problem(status: 409, title: "workspace changed", detail: "Reload and try again.")
        }
        let normalized = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...80).contains(normalized.count),
              !normalized.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else {
            throw BackendError.problem(status: 400, title: "invalid workspace name", detail: nil)
        }
        profile.name = normalized
        profile.updatedAtMs += 1
        workspaceProfile = profile
        return profile
    }

    public func openDirectMessage(
        workspace: WorkspaceID,
        with member: MemberID
    ) async throws -> Channel {
        guard connected, self.workspace == workspace else { throw BackendError.notConnected }
        guard let actor = members.first(where: { $0.kind == .human && $0.status == .active }) else {
            throw BackendError.problem(status: 403, title: "active member required", detail: nil)
        }
        guard actor.id != member else {
            throw BackendError.problem(status: 400, title: "direct message target must be another member", detail: nil)
        }
        guard members.contains(where: {
            $0.id == member && $0.workspaceId == workspace && $0.status == .active
        }) else {
            throw BackendError.problem(status: 404, title: "active workspace member not found", detail: nil)
        }

        let participantIDs = [actor.id, member].sorted { $0.description < $1.description }
        if let existing = channels.first(where: {
            $0.kind == .dm && Set($0.dmMemberIds) == Set(participantIDs)
        }) {
            return existing
        }

        let channel = Channel(
            id: ChannelID(),
            workspaceId: workspace,
            kind: .dm,
            dmKey: "demo:\(participantIDs.map(\.description).joined(separator: ":"))",
            dmMemberIds: participantIDs,
            createdBy: actor.id
        )
        channels.append(channel)
        messagesByChannel[channel.id] = []
        seqByChannel[channel.id] = 0
        sentClientMsgIds[channel.id] = []
        for index in members.indices where participantIDs.contains(members[index].id) {
            if !members[index].channelIds.contains(channel.id) {
                members[index].channelIds.append(channel.id)
            }
        }
        return channel
    }

    // MARK: AgentWorkRunBackend

    public func createWorkRun(
        agent: MemberID,
        channel: ChannelID,
        input: AgentWorkInput,
        clientRunId: UUID
    ) async throws -> AgentWorkRun {
        guard connected, let workspace else { throw BackendError.notConnected }
        guard members.contains(where: {
            $0.id == agent
                && $0.workspaceId == workspace
                && $0.isAgent
                && $0.status == .active
                && $0.channelIds.contains(channel)
        }) else {
            throw BackendError.problem(
                status: 404,
                title: "active channel agent not found",
                detail: nil
            )
        }
        if let existingId = workRunIdsByClientId[clientRunId],
           let existing = workRunsById[existingId] {
            guard existing.channelId == channel,
                  existing.agentMemberId == agent,
                  existing.input == input else {
                throw BackendError.problem(
                    status: 409,
                    title: "client_run_id idempotency conflict",
                    detail: nil
                )
            }
            return existing
        }

        let timestamp = nowMs()
        let run = AgentWorkRun(
            id: RunID(),
            workspaceId: workspace,
            agentMemberId: agent,
            channelId: channel,
            status: .queued,
            input: input,
            createdAtMs: timestamp,
            updatedAtMs: timestamp
        )
        workRunsById[run.id] = run
        workRunIdsByClientId[clientRunId] = run.id
        return run
    }

    public func workRuns(channel: ChannelID, limit: Int = 50) async throws -> [AgentWorkRun] {
        guard connected else { throw BackendError.notConnected }
        return Array(
            workRunsById.values
                .filter { $0.channelId == channel }
                .sorted { ($0.createdAtMs, $0.id.description) > ($1.createdAtMs, $1.id.description) }
                .prefix(min(max(limit, 1), 200))
        )
    }

    public func workRun(id: RunID) async throws -> AgentWorkRun {
        guard connected else { throw BackendError.notConnected }
        guard let run = workRunsById[id] else {
            throw BackendError.problem(status: 404, title: "work run not found", detail: nil)
        }
        return run
    }

    // MARK: ReadStateBackend

    public func readStates(workspace: WorkspaceID) async throws -> [ChannelReadState] {
        guard connected, self.workspace == workspace else { throw BackendError.notConnected }
        guard let member = members.first(where: { $0.kind == .human && $0.status == .active }) else {
            return []
        }
        return channels
            .filter { $0.workspaceId == workspace && !$0.isArchived }
            .map { readState(channel: $0.id, member: member.id) }
    }

    public func markRead(
        channel: ChannelID,
        through sequence: Int64
    ) async throws -> ChannelReadState {
        guard connected,
              let member = members.first(where: { $0.kind == .human && $0.status == .active }),
              channels.contains(where: { $0.id == channel && !$0.isArchived })
        else {
            throw BackendError.notConnected
        }
        let latest = seqByChannel[channel] ?? 0
        let current = readCursorsByMember[member.id]?[channel] ?? 0
        let effective = min(latest, max(current, sequence))
        readCursorsByMember[member.id, default: [:]][channel] = effective
        let state = readState(channel: channel, member: member.id)
        emitReadState(state, member: member.id)
        return state
    }

    public func subscribeReadStates(member: MemberID) async throws -> AsyncThrowingStream<ChannelReadState, Error> {
        guard connected else { throw BackendError.notConnected }
        let token = UUID()
        return AsyncThrowingStream { continuation in
            Task { await self.registerReadState(member: member, token: token, continuation: continuation) }
            continuation.onTermination = { _ in
                Task { await self.unregisterReadState(member: member, token: token) }
            }
        }
    }

    public func createChannel(
        workspace: WorkspaceID,
        kind: ChannelKind,
        name: String,
        topic: String?
    ) async throws -> ChannelCreateResult {
        guard connected else { throw BackendError.notConnected }
        guard kind == .publicChannel || kind == .privateChannel else {
            throw BackendError.problem(status: 400, title: "bad request", detail: "demo can only create public/private channels")
        }
        let normalized = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalized.isEmpty else {
            throw BackendError.problem(status: 400, title: "bad request", detail: "channel name is required")
        }
        guard !channels.contains(where: { $0.workspaceId == workspace && $0.name?.lowercased() == normalized }) else {
            throw BackendError.problem(status: 409, title: "channel name already exists", detail: normalized)
        }

        let creator = members.first(where: { $0.kind == .human })?.id ?? MemberID()
        let channel = Channel(
            id: ChannelID(),
            workspaceId: workspace,
            kind: kind,
            name: normalized,
            topic: topic,
            createdBy: creator
        )
        channels.append(channel)
        messagesByChannel[channel.id] = []
        seqByChannel[channel.id] = 0
        sentClientMsgIds[channel.id] = []

        let membership = ChannelMembership(
            workspaceId: workspace,
            channelId: channel.id,
            memberId: creator,
            role: .owner,
            joinedAtMs: nowMs()
        )
        apply(membership)
        return ChannelCreateResult(channel: channel, creatorMembership: membership)
    }

    public func addMember(
        _ member: MemberID,
        to channel: ChannelID,
        role: MembershipRole = .member
    ) async throws -> ChannelMembership {
        guard connected else { throw BackendError.notConnected }
        guard let targetChannel = channels.first(where: {
            $0.id == channel
                && !$0.isArchived
                && ($0.kind == .publicChannel || $0.kind == .privateChannel)
        }) else {
            throw BackendError.problem(status: 404, title: "channel or member not found", detail: "channel \(channel)")
        }
        let workspace = targetChannel.workspaceId
        guard members.contains(where: { $0.id == member && $0.workspaceId == workspace && $0.status == .active }) else {
            throw BackendError.problem(status: 404, title: "channel or member not found", detail: "member \(member)")
        }
        let membership = ChannelMembership(
            workspaceId: workspace,
            channelId: channel,
            memberId: member,
            role: role,
            joinedAtMs: nowMs()
        )
        apply(membership)
        return membership
    }

    public func removeMember(_ member: MemberID, from channel: ChannelID) async throws -> ChannelMembership {
        guard connected else { throw BackendError.notConnected }
        guard let workspace = channels.first(where: {
            $0.id == channel
                && !$0.isArchived
                && ($0.kind == .publicChannel || $0.kind == .privateChannel)
        })?.workspaceId,
              let stored = members.first(where: { $0.id == member && $0.channelIds.contains(channel) }) else {
            throw BackendError.problem(status: 404, title: "active channel membership not found", detail: nil)
        }
        let membership = ChannelMembership(
            workspaceId: workspace,
            channelId: channel,
            memberId: stored.id,
            role: .member,
            joinedAtMs: nowMs(),
            leftAtMs: nowMs()
        )
        apply(membership)
        return membership
    }

    func agentCredentials(
        workspace: WorkspaceID,
        agent: MemberID
    ) async throws -> [MomoAgentCredential] {
        guard connected, self.workspace == workspace else { throw BackendError.notConnected }
        return (credentialsByAgent[agent] ?? []).sorted { $0.createdAtMs > $1.createdAtMs }
    }

    func issueAgentCredential(
        workspace: WorkspaceID,
        agent: MemberID,
        rotationGraceSeconds: Int = 24 * 60 * 60
    ) async throws -> MomoAgentCredentialReveal {
        guard connected, self.workspace == workspace else { throw BackendError.notConnected }
        guard members.contains(where: { $0.id == agent && $0.isAgent && $0.status == .active }) else {
            throw BackendError.problem(status: 404, title: "active agent not found", detail: nil)
        }

        let now = Date()
        let graceDeadline = now.addingTimeInterval(TimeInterval(rotationGraceSeconds))
        var stored = credentialsByAgent[agent] ?? []
        var rotatedCount = 0
        for index in stored.indices where stored[index].displayStatus(now: now) != .revoked {
            let currentExpiry = stored[index].expiresAtMs.map {
                Date(timeIntervalSince1970: TimeInterval($0) / 1_000)
            }
            if currentExpiry == nil || currentExpiry! > graceDeadline {
                stored[index].expiresAtMs = Int64(graceDeadline.timeIntervalSince1970 * 1_000)
            }
            rotatedCount += 1
        }

        let issued = MomoAgentCredential(
            id: UUID(),
            agentMemberId: agent,
            serverStatus: "active",
            scopes: [
                "agent:jobs:read",
                "agent:runs:callback",
                "messages:write",
                "realtime:subscribe",
            ],
            label: "Hermes gateway",
            lastUsedAtMs: nil,
            expiresAtMs: nil,
            revokedAtMs: nil,
            createdAtMs: Int64(now.timeIntervalSince1970 * 1_000)
        )
        stored.append(issued)
        credentialsByAgent[agent] = stored

        return MomoAgentCredentialReveal(
            credential: issued,
            token: "momo_agent_demo_\(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased())",
            tokenType: "Bearer",
            rotatedCredentialCount: rotatedCount,
            rotationGraceEndsAtMs: rotatedCount > 0
                ? Int64(graceDeadline.timeIntervalSince1970 * 1_000)
                : nil
        )
    }

    func revokeAgentCredential(
        _ credential: UUID,
        workspace: WorkspaceID,
        agent: MemberID
    ) async throws -> MomoAgentCredential {
        guard connected, self.workspace == workspace else { throw BackendError.notConnected }
        guard var stored = credentialsByAgent[agent],
              let index = stored.firstIndex(where: { $0.id == credential })
        else {
            throw BackendError.problem(status: 404, title: "agent credential not found", detail: nil)
        }
        stored[index].serverStatus = "revoked"
        stored[index].revokedAtMs = Int64(Date().timeIntervalSince1970 * 1_000)
        credentialsByAgent[agent] = stored
        return stored[index]
    }

    public func costSnapshots(channel: ChannelID) async throws -> [CostSnapshot] {
        demoCostSnapshotsByChannel[channel] ?? []
    }

    public func search(workspace: WorkspaceID, query: String) async throws -> [Message] {
        messagesByChannel.values.flatMap { $0 }.filter {
            ($0.body ?? "").localizedCaseInsensitiveContains(query)
        }
    }

    public func setTyping(channel: ChannelID, isTyping: Bool) async {
        // TODO(T09-followup): publish typing.start/stop via REST → relay.
    }

    public func realtimeStatus(channel: ChannelID) async -> AsyncStream<RealtimeConnectionStatus> {
        AsyncStream { continuation in
            let token = UUID()
            continuation.yield(realtimeStatusByChannel[channel] ?? .idle(channel: channel))
            realtimeStatusStreams[channel, default: [:]][token] = continuation
            continuation.onTermination = { _ in
                Task { await self.unregisterRealtimeStatus(channel: channel, token: token) }
            }
        }
    }

    public func retryRealtime(channel: ChannelID) async {
        emitRealtimeStatus(RealtimeConnectionStatus(
            channelId: channel,
            connection: connected ? .connected : .offline,
            subscription: connected ? .subscribed : .unsubscribed,
            fallback: connected ? .none : .restHistory,
            canRetry: !connected,
            message: connected ? "Demo realtime connected." : "Demo backend is offline."
        ))
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
            reactionsByMessage[id, default: [:]][emoji, default: []].insert(author)
            emit(.reaction(ReactionDelta(action: .added, messageId: id, memberId: author, emoji: emoji)), to: ch)
            return
        }
        throw BackendError.problem(status: 404, title: "not found", detail: "message \(id)")
    }

    func reactionSnapshot(channel: ChannelID) async throws -> [MessageID: [String: Set<MemberID>]] {
        let messageIDs = Set((messagesByChannel[channel] ?? []).map(\.id))
        return reactionsByMessage.filter { messageIDs.contains($0.key) }
    }

    func removeReaction(_ id: MessageID, emoji: String) async throws {
        for ch in messagesByChannel.keys where messagesByChannel[ch]?.contains(where: { $0.id == id }) == true {
            let author = members.first(where: { $0.kind == .human })?.id ?? MemberID()
            reactionsByMessage[id]?[emoji]?.remove(author)
            if reactionsByMessage[id]?[emoji]?.isEmpty == true {
                reactionsByMessage[id]?[emoji] = nil
            }
            if reactionsByMessage[id]?.isEmpty == true {
                reactionsByMessage[id] = nil
            }
            emit(.reaction(ReactionDelta(action: .removed, messageId: id, memberId: author, emoji: emoji)), to: ch)
            return
        }
        throw BackendError.problem(status: 404, title: "not found", detail: "message \(id)")
    }

    func deleteMessage(_ id: MessageID) async throws -> Message {
        for (channel, messages) in messagesByChannel {
            guard let index = messages.firstIndex(where: { $0.id == id }) else { continue }
            var tombstone = messages[index]
            tombstone.state = .deleted
            tombstone.deletedAtMs = Int64(Date().timeIntervalSince1970 * 1_000)
            messagesByChannel[channel]?[index] = tombstone
            reactionsByMessage[id] = nil
            emit(.messageDeleted(id), to: channel)
            return tombstone
        }
        throw BackendError.problem(status: 404, title: "not found", detail: "message \(id)")
    }

    public func pendingApprovals(workspace: WorkspaceID, status: ApprovalStatus) async throws -> [Approval] {
        approvalsById.values
            .filter { $0.workspaceId == workspace && $0.status == status }
            .sorted { ($0.expiresAtMs ?? Int64.max, $0.id.description) < ($1.expiresAtMs ?? Int64.max, $1.id.description) }
    }

    public func decideApproval(_ request: ApprovalDecisionRequest) async throws -> ApprovalDecisionReceipt {
        // TODO(T09-followup): REST POST .../approvals/{id}/decide.
        for channel in demoRealtimeByChannel.keys {
            guard let events = demoRealtimeByChannel[channel],
                  let idx = events.firstIndex(where: { event in
                      if case .approval(let approval) = event {
                          return approval.approvalId == request.approvalId
                      }
                      return false
                  }) else { continue }

            var updatedEvents = events
            guard case .approval(var approval) = updatedEvents[idx] else {
                continue
            }

            if approval.status == .pending {
                approval.action = .decided
                approval.status = request.status
                approval.decidedBy = members.first(where: { $0.kind == .human })?.id
                approval.decisionReason = request.reason
                updatedEvents[idx] = .approval(approval)
                if var stored = approvalsById[approval.approvalId] {
                    stored.status = request.status
                    stored.decidedBy = approval.decidedBy
                    stored.decidedAtMs = nowMs()
                    stored.decisionReason = request.reason
                    approvalsById[approval.approvalId] = stored
                }

                for eventIndex in updatedEvents.indices {
                    if case .agentStatus(var status) = updatedEvents[eventIndex],
                       status.runId == approval.runId {
                        status.phase = .done
                        status.runStatus = request.approve ? .succeeded : .cancelled
                        status.reservedMicroUSD = 0
                        updatedEvents[eventIndex] = .agentStatus(status)
                        emit(.agentStatus(status), to: channel)
                    }
                }

                demoRealtimeByChannel[channel] = updatedEvents
                emit(.approval(approval), to: channel)
            }

            let receipt = ApprovalDecisionReceipt(
                approvalId: approval.approvalId,
                status: approval.status,
                decidedBy: approval.decidedBy,
                decidedAtMs: nowMs(),
                decisionReason: approval.decisionReason
            )
            markApprovalRequestMessage(with: receipt, in: channel)
            return receipt
        }

        throw BackendError.problem(
            status: 404,
            title: "approval not found",
            detail: "approval \(request.approvalId)"
        )
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
        _ = try await decideApproval(
            ApprovalDecisionRequest(approvalId: id, approve: approve, reason: reason)
        )
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
        let timestamp = demoSeedBaseTimestampMs.map { $0 + (next * 60_000) }
            ?? Int64(Date().timeIntervalSince1970 * 1000)
        let msg = Message(
            id: MessageID(), channelId: channel, seq: next,
            hlcTs: timestamp, hlcCount: 0,
            authorMemberId: author, type: type, state: .sent, body: body, props: props,
            rootId: rootId, replyToId: replyToId, runId: runId, clientMsgId: clientMsgId,
            createdAtMs: timestamp)
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

    private func readState(channel: ChannelID, member: MemberID) -> ChannelReadState {
        let lastReadSeq = readCursorsByMember[member]?[channel] ?? 0
        let latestSeq = seqByChannel[channel] ?? 0
        let mentionCount = (messagesByChannel[channel] ?? []).reduce(into: 0) { count, message in
            guard (message.seq ?? 0) > lastReadSeq,
                  messageMentions(message, member: member) else { return }
            count += 1
        }
        return ChannelReadState(
            channelId: channel,
            lastReadSeq: lastReadSeq,
            latestSeq: latestSeq,
            unreadCount: max(0, latestSeq - lastReadSeq),
            mentionCount: mentionCount
        )
    }

    private func messageMentions(_ message: Message, member: MemberID) -> Bool {
        message.props["mention_member_ids"]?.arrayValue?.contains { value in
            value.stringValue?.lowercased() == member.description.lowercased()
        } == true
    }

    private func emitReadState(_ state: ChannelReadState, member: MemberID) {
        for continuation in (readStateStreams[member] ?? [:]).values {
            continuation.yield(state)
        }
    }

    private func markApprovalRequestMessage(with receipt: ApprovalDecisionReceipt, in channel: ChannelID) {
        guard var messages = messagesByChannel[channel] else {
            return
        }
        for index in messages.indices {
            guard messages[index].type == .approvalRequest,
                  messages[index].props["approval_id"]?.stringValue == receipt.approvalId.description else {
                continue
            }

            var message = messages[index]
            var props = message.props.objectValue ?? [:]
            props["approval_status"] = .string(receipt.status.rawValue)
            if let decidedBy = receipt.decidedBy {
                props["decided_by"] = .string(decidedBy.description)
            }
            if let decidedAtMs = receipt.decidedAtMs {
                props["decided_at_ms"] = .int(decidedAtMs)
            }
            if let decisionReason = receipt.decisionReason {
                props["decision_reason"] = .string(decisionReason)
            }
            message.props = .object(props)
            message.editedAtMs = receipt.decidedAtMs
            messages[index] = message
            messagesByChannel[channel] = messages
            emit(.messageEdited(message), to: channel)
            return
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

    private func nowMs() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }

    private func mentionedAgent(in body: String, channel: ChannelID) -> Member? {
        members.first { member in
            guard member.isAgent,
                  member.status == .active,
                  member.channelIds.contains(channel) else { return false }
            return body.range(of: "@\(member.handle)", options: [.caseInsensitive, .diacriticInsensitive]) != nil
                || body.range(of: "@\(member.displayName)", options: [.caseInsensitive, .diacriticInsensitive]) != nil
        }
    }

    private func appendDemoMentionResponse(agent: Member, channel: ChannelID, trigger: Message, prompt: String) {
        let run = RunID()
        emit(.agentStatus(AgentStatus(
            runId: run,
            agentMemberId: agent.id,
            channelId: channel,
            phase: .thinking,
            runStatus: .running,
            reservedMicroUSD: 90_000,
            spentMicroUSD: 12_000
        )), to: channel)
        emit(.agentPartial(AgentPartial(
            runId: run,
            channelId: channel,
            textDelta: "\(MomoKoreanParticle.attach(.subject, to: agent.displayName)) 요청을 읽고 답변을 준비하고 있습니다.",
            toolCallName: "momo.context.read",
            toolCallArgs: .object([
                "trigger_message_id": .string(trigger.id.description),
                "mention": .string("@\(agent.handle)"),
            ]),
            spentMicroUSD: 12_000
        )), to: channel)

        _ = appendServerMessage(
            channel: channel,
            author: agent.id,
            type: .text,
            body: "요청 확인했어요. \(prompt) 내용을 기준으로 팀이 바로 확인할 수 있게 정리할게요.",
            props: .object([
                "trigger_message_id": .string(trigger.id.description),
                "mention_handle": .string(agent.handle),
                "mention_display_name": .string(agent.displayName),
                "spent_micro_usd": .int(32_000),
            ]),
            runId: run
        )
        demoCostSnapshotsByChannel[channel, default: []].append(CostSnapshot(
            runId: run,
            reservedMicroUSD: 0,
            spentMicroUSD: 32_000,
            softLimitMicroUSD: 900_000,
            hardLimitMicroUSD: 1_000_000,
            isReconciled: true,
            wasEstimated: false,
            limitState: .normal
        ))
        emit(.agentStatus(AgentStatus(
            runId: run,
            agentMemberId: agent.id,
            channelId: channel,
            phase: .done,
            runStatus: .succeeded,
            reservedMicroUSD: 0,
            spentMicroUSD: 32_000
        )), to: channel)
    }

    // `async` so the cross-actor hop from the nonisolated AsyncStream closure is a
    // genuine await (avoids "no async operations occur within await" warnings).
    private func registerChannel(_ channel: ChannelID, token: UUID,
                                 continuation: AsyncStream<RealtimeEvent>.Continuation) async {
        channelStreams[channel, default: [:]][token] = continuation
        for event in demoReplayEvents(for: channel) {
            continuation.yield(event)
        }
    }
    private func unregisterChannel(_ channel: ChannelID, token: UUID) async {
        channelStreams[channel]?[token] = nil
    }
    private func unregisterRealtimeStatus(channel: ChannelID, token: UUID) async {
        realtimeStatusStreams[channel]?[token] = nil
    }
    private func registerReadState(
        member: MemberID,
        token: UUID,
        continuation: AsyncThrowingStream<ChannelReadState, Error>.Continuation
    ) async {
        readStateStreams[member, default: [:]][token] = continuation
    }
    private func unregisterReadState(member: MemberID, token: UUID) async {
        readStateStreams[member]?[token] = nil
    }
    private func emitRealtimeStatus(_ status: RealtimeConnectionStatus) {
        realtimeStatusByChannel[status.channelId] = status
        guard let continuations = realtimeStatusStreams[status.channelId]?.values else {
            return
        }
        for continuation in continuations {
            continuation.yield(status)
        }
    }
    private func registerAgent(_ channel: ChannelID, token: UUID,
                               continuation: AsyncStream<AgentEvent>.Continuation) async {
        agentStreams[channel, default: [:]][token] = continuation
    }
    private func unregisterAgent(_ channel: ChannelID, token: UUID) async {
        agentStreams[channel]?[token] = nil
    }

    private func demoReplayEvents(for channel: ChannelID) -> [RealtimeEvent] {
        let events = demoRealtimeByChannel[channel] ?? []
        guard replayedDemoDeltaChannels.insert(channel).inserted else {
            return events.filter { event in
                if case .agentPartial = event { return false }
                return true
            }
        }
        return events
    }
}

/// Convenience bundle returned from `seedDemo()`.
public struct DemoSeed: Sendable {
    public let workspace: WorkspaceID
    public let human: Member
    public let agents: [Member]
    public let channels: [Channel]
}
