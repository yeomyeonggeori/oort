import XCTest
import MomoCore
@testable import MomoMac

final class MomoMacTests: XCTestCase {

    // MARK: seq ordering (L4 §1.2 #3 — ordering authority is Message.seq)

    func testSeqOrderingPutsAckedBeforeOptimistic() {
        let ws = WorkspaceID()
        let ch = ChannelID()
        let author = MemberID()
        func msg(_ seq: Int64?, hlc: Int64) -> Message {
            Message(id: MessageID(), channelId: ch, seq: seq, hlcTs: hlc, hlcCount: 0,
                    authorMemberId: author)
        }
        let acked2 = msg(2, hlc: 200)
        let acked1 = msg(1, hlc: 100)
        let optimistic = msg(nil, hlc: 300)

        let sorted = [optimistic, acked2, acked1].sorted(by: ChatViewModel.seqOrder)
        XCTAssertEqual(sorted.map { $0.seq }, [1, 2, nil])
        _ = ws
    }

    // MARK: CostFormat (experience B, display only)

    func testCostFormatMicroUSD() {
        XCTAssertEqual(CostFormat.usd(280_000), "$0.2800")
        XCTAssertEqual(CostFormat.usdCompact(3_100_000), "$3.10")
    }

    // MARK: in-memory backend round-trip (proves ChatBackend conformance)

    func testBackendSeedAndHistory() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        XCTAssertEqual(seed.channels.count, 2)
        XCTAssertEqual(seed.agents.count, 2)

        let history = try await backend.history(channel: seed.channels[0].id, after: nil, limit: 50)
        XCTAssertGreaterThan(history.count, 0)
        // Seeded messages must be gapless seq from 1.
        let seqs = history.compactMap { $0.seq }
        XCTAssertEqual(seqs, Array(1...Int64(seqs.count)))
    }

    func testDemoAgentProtocolCardsCarryContextMemoryCapabilityMetadata() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        var messages: [Message] = []
        for channel in seed.channels {
            messages += try await backend.history(channel: channel.id, after: nil, limit: 50)
        }

        for type in [MessageType.toolCall, .toolResult, .artifact, .approvalRequest] {
            guard let message = messages.first(where: { $0.type == type }) else {
                return XCTFail("demo should seed \(type.rawValue)")
            }
            XCTAssertNotNil(message.props["context_packet"], "\(type.rawValue) should cite Context Packet projection")
            XCTAssertGreaterThan(message.props["source_badges"]?.arrayValue?.count ?? 0, 0,
                                 "\(type.rawValue) should show at least one source badge")
        }

        let toolCall = try XCTUnwrap(messages.first(where: { $0.type == .toolCall }))
        XCTAssertEqual(toolCall.props["capability"]?["tool_name"]?.stringValue, "github.search_issues")
        XCTAssertEqual(toolCall.props["memory_citations"]?.arrayValue?.count, 1)
        XCTAssertNotNil(toolCall.props["estimated_micro_usd"]?.intValue)

        let approval = try XCTUnwrap(messages.first(where: { $0.type == .approvalRequest }))
        XCTAssertEqual(approval.props["capability"]?["approval_policy"]?.stringValue, "always")
        XCTAssertEqual(approval.props["memory_citations"]?.arrayValue?.count, 1)

        let result = try XCTUnwrap(messages.first(where: { $0.type == .toolResult }))
        XCTAssertEqual(result.props["artifact_ref"]?["kind"]?.stringValue, "search_results")
        XCTAssertNotNil(result.props["spent_micro_usd"]?.intValue)
    }

    func testOptimisticSendIsIdempotent() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        try await backend.connect(workspace: seed.workspace, accessToken: "t")
        let ch = seed.channels[0].id
        let cid = UUID()
        let draft = DraftMessage(channelId: ch, type: .text, body: "hi")
        let first = try await backend.sendOptimistic(draft, clientMsgId: cid)
        let second = try await backend.sendOptimistic(draft, clientMsgId: cid)
        XCTAssertEqual(first.id, second.id, "same clientMsgId must dedupe (L4 §3.1)")
    }

    func testLiveChatBackendMentionFallbackRespondsToKimInternAliases() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        try await backend.connect(workspace: seed.workspace, accessToken: "t")
        let channel = seed.channels[0].id
        let agent = try XCTUnwrap(seed.agents.first { $0.handle == "kim-intern" })

        _ = try await backend.sendOptimistic(
            DraftMessage(channelId: channel, type: .text, body: "@김인턴 오늘 상태 알려줘"),
            clientMsgId: UUID()
        )
        _ = try await backend.sendOptimistic(
            DraftMessage(channelId: channel, type: .text, body: "@kim-intern summarize the channel"),
            clientMsgId: UUID()
        )

        let history = try await backend.history(channel: channel, after: nil, limit: 50)
        let finals = history.filter { message in
            message.authorMemberId == agent.id
                && message.runId != nil
                && (message.body?.contains("mention 호출을 확인") == true)
        }
        XCTAssertEqual(finals.count, 2)
        XCTAssertTrue(finals.allSatisfy { $0.props["mention_handle"]?.stringValue == "kim-intern" })
        XCTAssertTrue(finals.contains { $0.body?.contains("@김인턴") == true })
        XCTAssertTrue(finals.contains { $0.body?.contains("@kim-intern") == true })
    }

    @MainActor
    func testViewModelInsertsAgentMentionFromRoster() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "t")
        await viewModel.selectChannel(seed.channels[0].id)

        let agent = try XCTUnwrap(seed.agents.first { $0.handle == "kim-intern" })
        XCTAssertTrue(viewModel.canInsertMention(for: agent))
        viewModel.insertMention(for: agent)
        XCTAssertEqual(viewModel.composerDraft, "@김인턴 ")
        XCTAssertEqual(viewModel.mentionNotice, "김인턴 mention inserted.")

        viewModel.insertMention(for: agent, preferDisplayName: false)
        XCTAssertEqual(viewModel.composerDraft, "@김인턴 @kim-intern ")
    }

    @MainActor
    func testViewModelRESTFallbackRefreshesFinalDurableMentionMessage() async throws {
        let workspace = WorkspaceID()
        let channel = ChannelID()
        let human = MemberID()
        let agent = MemberID()
        let backend = AgentMentionFallbackChatBackend(
            workspace: workspace,
            channel: channel,
            human: human,
            agent: agent
        )
        let viewModel = ChatViewModel(chat: backend, agentTransport: FailingDecisionAgentTransport())

        await viewModel.bootstrap(workspace: workspace, accessToken: "token")
        await viewModel.selectChannel(channel)
        XCTAssertEqual(viewModel.selectedRealtimeStatus?.fallback, .restHistory)

        await viewModel.send(body: "@kim-intern check this fallback path", to: channel)

        let messages = viewModel.visibleMessages
        XCTAssertEqual(messages.filter { $0.authorMemberId == human }.count, 1)
        let final = try XCTUnwrap(messages.first { $0.authorMemberId == agent })
        XCTAssertEqual(final.body, "김인턴 final durable response for @kim-intern")
        XCTAssertNotNil(final.runId)
        XCTAssertTrue(viewModel.partials.isEmpty)
    }

    func testInviteJoinStubAcceptsDemoCodeAndRejectsUnknownCode() async throws {
        let backend = LiveChatBackend()
        _ = await backend.seedDemo()

        let joined = await backend.joinWorkspace(inviteCode: "MOMO-012")
        guard case .joined(let workspace) = joined else {
            return XCTFail("MOMO-012 should join the dev workspace")
        }
        XCTAssertEqual(workspace.workspace.name, "Dawn Lab")
        XCTAssertEqual(workspace.role, "member")
        XCTAssertTrue(workspace.defaultChannelNames.contains("general"))

        let failed = await backend.joinWorkspace(inviteCode: "nope")
        guard case .failed(let failure) = failed else {
            return XCTFail("unknown code should expose a failure state")
        }
        XCTAssertEqual(failure.reason, "Invite not found")
        XCTAssertEqual(failure.code, "nope")
    }

    func testFoundationModelsCapabilityStateMapping() {
        let available = FoundationModelsCapabilityProbe.state(from: .available)
        XCTAssertTrue(available.isAvailable)
        XCTAssertEqual(available.badgeText, "Available")
        XCTAssertNil(available.fallbackReason)

        let frameworkFallback = FoundationModelsCapabilityProbe.state(
            from: .unavailable(.frameworkUnavailable)
        )
        XCTAssertFalse(frameworkFallback.isAvailable)
        XCTAssertEqual(frameworkFallback.badgeText, "Fallback")
        XCTAssertEqual(frameworkFallback.titleText, "Server fallback")
        XCTAssertEqual(frameworkFallback.fallbackReason, .frameworkUnavailable)

        let osFallback = FoundationModelsCapabilityProbe.state(from: .unavailable(.unsupportedOS))
        XCTAssertEqual(osFallback.fallbackReason, .unsupportedOS)
        XCTAssertTrue(osFallback.detailText.contains("macOS 26"))

        let intelligenceFallback = FoundationModelsCapabilityProbe.state(
            from: .unavailable(.appleIntelligenceNotEnabled)
        )
        XCTAssertEqual(intelligenceFallback.fallbackReason, .appleIntelligenceNotEnabled)
        XCTAssertTrue(intelligenceFallback.detailText.contains("Apple Intelligence"))

        let modelFallback = FoundationModelsCapabilityProbe.state(from: .unavailable(.modelNotReady))
        XCTAssertEqual(modelFallback.fallbackReason, .modelNotReady)
        XCTAssertTrue(modelFallback.detailText.contains("assets"))

        let deviceFallback = FoundationModelsCapabilityProbe.state(
            from: .unavailable(.deviceNotEligible)
        )
        XCTAssertEqual(deviceFallback.fallbackReason, .deviceNotEligible)
        XCTAssertTrue(deviceFallback.detailText.contains("eligible"))
    }

    func testFoundationModelsCapabilityProbeReturnsStableState() {
        let state = FoundationModelsCapabilityProbe().currentState()
        switch state {
        case .available:
            XCTAssertTrue(state.detailText.contains("Foundation Models"))
        case .fallback(let reason):
            XCTAssertFalse(state.isAvailable)
            XCTAssertEqual(state.fallbackReason, reason)
            XCTAssertFalse(state.detailText.isEmpty)
        }
    }

    func testAlphaUpdateChannelDefaultsToPlaceholderUntilFeedAndPublicKeyExist() {
        let status = MomoMacUpdateChannelStatus.fromEnvironment([:])

        XCTAssertEqual(status.channel, .alpha)
        XCTAssertEqual(status.engine, .sparkle2)
        XCTAssertFalse(status.canCheckNow)
        XCTAssertFalse(status.canInstallAutomatically)
        XCTAssertEqual(status.missingRequirements, [
            "SUFeedURL",
            "SUPublicEDKey",
            "Developer ID signing",
            "notarization",
            "DMG artifact",
        ])
        XCTAssertTrue(status.surfaceDetail.contains("placeholder"))
    }

    func testAlphaUpdateChannelRequiresSignedNotarizedDMGBeforeInstall() {
        let status = MomoMacUpdateChannelStatus.fromEnvironment([
            "MOMO_UPDATE_CHANNEL": "alpha",
            "MOMO_UPDATE_FEED_URL": "https://updates.example.com/momo/alpha/appcast.xml",
            "MOMO_UPDATE_PUBLIC_ED_KEY": "public-key-placeholder",
            "MOMO_UPDATE_AUTOMATIC_CHECKS": "true",
        ])

        XCTAssertTrue(status.canCheckNow)
        XCTAssertFalse(status.canInstallAutomatically)
        XCTAssertEqual(status.missingRequirements, [
            "Developer ID signing",
            "notarization",
            "DMG artifact",
        ])
        XCTAssertTrue(status.surfaceDetail.contains("signed/notarized artifacts"))
    }

    func testAlphaUpdateChannelFlagsPrivateKeyLookingConfig() {
        let status = MomoMacUpdateChannelStatus.fromEnvironment([
            "MOMO_UPDATE_FEED_URL": "not a url",
            "MOMO_UPDATE_PUBLIC_ED_KEY": "PRIVATE KEY SHOULD NOT BE HERE",
        ])

        XCTAssertEqual(status.diagnostics.count, 2)
        XCTAssertTrue(status.diagnostics.contains("MOMO_UPDATE_FEED_URL is not a valid URL."))
        XCTAssertTrue(status.diagnostics.contains("Only Sparkle EdDSA public keys belong in app/runtime config."))
    }

    @MainActor
    func testViewModelSubmitsInviteCodeThroughOnboardingBackend() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "t")
        viewModel.setChannels(seed.channels)

        await viewModel.submitInviteCode("EXPIRED")
        guard case .failed(let failure) = viewModel.inviteJoinState else {
            return XCTFail("EXPIRED should expose a failure state")
        }
        XCTAssertEqual(failure.reason, "Invite expired")

        await viewModel.submitInviteCode("MOMO-DEV")
        guard case .joined(let workspace) = viewModel.inviteJoinState else {
            return XCTFail("MOMO-DEV should expose a success state")
        }
        XCTAssertEqual(workspace.workspace.slug, "dawn-lab")
    }

    @MainActor
    func testDemoRealtimeReplayIsIdempotentAcrossResubscribe() async throws {
        let viewModel = await MomoMacDemo.makeViewModel()
        try await Task.sleep(for: .milliseconds(50))

        guard let general = viewModel.selectedChannelId else {
            return XCTFail("demo should select the first channel")
        }
        guard let other = viewModel.channels.dropFirst().first?.id else {
            return XCTFail("demo should seed at least two channels")
        }
        let initialPartialText = viewModel.partials.values.first?.textDelta
        XCTAssertNotNil(initialPartialText)

        guard let approval = viewModel.pendingApprovals.first else {
            return XCTFail("demo should seed one pending approval")
        }
        await viewModel.decideApproval(approval.approvalId, approve: true)
        XCTAssertEqual(viewModel.approvals[approval.approvalId]?.status, .approved)
        XCTAssertTrue(viewModel.pendingApprovals.isEmpty)

        await viewModel.selectChannel(other)
        await viewModel.selectChannel(general)
        try await Task.sleep(for: .milliseconds(50))

        XCTAssertEqual(viewModel.partials.values.first?.textDelta, initialPartialText)
        XCTAssertEqual(viewModel.approvals[approval.approvalId]?.status, .approved)
        XCTAssertTrue(viewModel.pendingApprovals.isEmpty)
    }

    @MainActor
    func testLiveToolCallPartialReconcilesToFinalToolResultBySeq() async throws {
        let workspace = WorkspaceID(uuidString: "00000000-0000-7000-8000-000000201001")!
        let channel = ChannelID(uuidString: "00000000-0000-7000-8000-000000201002")!
        let human = MemberID(uuidString: "00000000-0000-7000-8000-000000201003")!
        let agent = MemberID(uuidString: "00000000-0000-7000-8000-000000201004")!
        let run = RunID(uuidString: "00000000-0000-7000-8000-000000201005")!
        let finalMessageId = MessageID(uuidString: "00000000-0000-7000-8000-000000201006")!

        let initial = Message(
            id: MessageID(uuidString: "00000000-0000-7000-8000-000000201007")!,
            channelId: channel,
            seq: 40,
            hlcTs: 1_782_864_000_040,
            authorMemberId: human,
            body: "run the search"
        )
        let final = Message(
            id: finalMessageId,
            channelId: channel,
            seq: 41,
            hlcTs: 1_782_864_000_041,
            authorMemberId: agent,
            type: .toolResult,
            body: "Found 2 issues.",
            props: [
                "tool_name": .string("github.search_issues"),
                "call_id": .string("call_momo_201_search"),
                "is_error": .bool(false),
                "output": .object([
                    "matches": .int(2),
                    "query": .string("MOMO-201 live tool-call fixture"),
                ]),
            ],
            runId: run
        )
        let backend = FixtureRealtimeChatBackend(
            workspace: workspace,
            members: [
                Member(id: human, workspaceId: workspace, kind: .human, displayName: "Human", handle: "human"),
                Member(id: agent, workspaceId: workspace, kind: .agent, displayName: "Kim Intern", handle: "kim"),
            ],
            channels: [
                Channel(id: channel, workspaceId: workspace, kind: .publicChannel, name: "agent-lab", createdBy: human),
            ],
            history: [channel: [initial]],
            events: [
                .agentPartial(AgentPartial(
                    runId: run,
                    channelId: channel,
                    messageId: finalMessageId,
                    textDelta: "Searching ",
                    spentMicroUSD: 2_100
                )),
                .agentPartial(AgentPartial(
                    runId: run,
                    channelId: channel,
                    messageId: finalMessageId,
                    textDelta: "issues...",
                    toolCallName: "github.search_issues",
                    toolCallArgs: [
                        "query": .string("MOMO-201 live tool-call fixture"),
                        "limit": .int(2),
                    ],
                    spentMicroUSD: 2_400
                )),
                .message(final),
                .message(final),
                .agentPartial(AgentPartial(
                    runId: run,
                    channelId: channel,
                    messageId: finalMessageId,
                    textDelta: "late duplicate partial"
                )),
            ]
        )
        let viewModel = ChatViewModel(chat: backend, agentTransport: FailingDecisionAgentTransport())

        await viewModel.bootstrap(workspace: workspace, accessToken: "token")
        await viewModel.selectChannel(channel)
        try await Task.sleep(for: .milliseconds(100))

        XCTAssertNil(viewModel.partials[run], "final tool_result message.new should remove the progress card")
        XCTAssertEqual(viewModel.visibleMessages.map(\.seq), [40, 41])
        XCTAssertEqual(viewModel.visibleMessages.filter { $0.id == finalMessageId }.count, 1)
        XCTAssertEqual(viewModel.visibleMessages.last?.type, .toolResult)
        XCTAssertEqual(viewModel.visibleMessages.last?.props["output"]?["matches"]?.intValue, 2)
    }

    @MainActor
    func testApprovalDecisionUsesChatBackendContract() async throws {
        let chat = RecordingDecisionChatBackend()
        let agentTransport = FailingDecisionAgentTransport()
        let viewModel = ChatViewModel(chat: chat, agentTransport: agentTransport)
        let approvalId = ApprovalID()

        await viewModel.decideApproval(approvalId, approve: false, reason: "needs owner")

        let requests = await chat.recordedDecisionRequests()
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.first?.approvalId, approvalId)
        XCTAssertEqual(requests.first?.approve, false)
        XCTAssertEqual(requests.first?.reason, "needs owner")
        let agentDecisionCalls = await agentTransport.decisionCallCount()
        XCTAssertEqual(agentDecisionCalls, 0)
        XCTAssertFalse(viewModel.approvalDecisionsInFlight.contains(approvalId))
    }

    @MainActor
    func testBootstrapLoadsServerOwnedPendingApprovalProjection() async throws {
        let workspace = WorkspaceID()
        let channel = ChannelID()
        let agent = MemberID()
        let approvalId = ApprovalID()
        let chat = RecordingDecisionChatBackend(
            pending: [
                Approval(
                    id: approvalId,
                    workspaceId: workspace,
                    runId: RunID(),
                    channelId: channel,
                    requestedBy: agent,
                    actionType: "github.issue.create",
                    status: .pending,
                    estimatedMicroUSD: 123_000,
                    isReversible: true
                )
            ]
        )
        let agentTransport = FailingDecisionAgentTransport()
        let viewModel = ChatViewModel(chat: chat, agentTransport: agentTransport)

        await viewModel.bootstrap(workspace: workspace, accessToken: "token")

        XCTAssertEqual(viewModel.pendingApprovals.map(\.approvalId), [approvalId])
        XCTAssertEqual(viewModel.pendingApprovals.first?.actionType, "github.issue.create")
        XCTAssertEqual(viewModel.pendingApprovals.first?.estimatedMicroUSD, 123_000)
    }

    func testApprovalDecisionUpdatesTimelineApprovalRequestProps() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        try await backend.connect(workspace: seed.workspace, accessToken: "t")
        let channel = seed.channels[0].id
        let initialHistory = try await backend.history(channel: channel, after: nil, limit: 50)
        let approvalMessage = try XCTUnwrap(initialHistory.first(where: { $0.type == .approvalRequest }))
        let rawApprovalId = try XCTUnwrap(approvalMessage.props["approval_id"]?.stringValue)
        let approvalId = try XCTUnwrap(ApprovalID(rawApprovalId))

        let receipt = try await backend.decideApproval(
            ApprovalDecisionRequest(approvalId: approvalId, approve: false, reason: "needs owner")
        )

        XCTAssertEqual(receipt.status, .rejected)
        let updatedHistory = try await backend.history(channel: channel, after: nil, limit: 50)
        let updatedMessage = try XCTUnwrap(updatedHistory.first(where: { $0.id == approvalMessage.id }))
        XCTAssertEqual(updatedMessage.props["approval_status"]?.stringValue, "rejected")
        XCTAssertEqual(updatedMessage.props["decision_reason"]?.stringValue, "needs owner")
        XCTAssertNotNil(updatedMessage.props["decided_at_ms"]?.intValue)
    }

    func testLocalContextCopilotRoutesFoundationModelsAndFallbackStates() {
        let service = LocalContextCopilotService()

        XCTAssertEqual(service.route(for: .available), .foundationModels)
        XCTAssertEqual(
            service.route(for: .fallback(.unsupportedOS)),
            .deterministicFallback(.unsupportedOS)
        )
    }

    func testLocalContextCopilotDeterministicFallbackPreservesSourceHints() async throws {
        let ws = WorkspaceID()
        let channel = Channel(
            id: ChannelID(),
            workspaceId: ws,
            kind: .publicChannel,
            name: "agent-lab"
        )
        let author = MemberID()
        let messages = [
            Message(
                id: MessageID(),
                channelId: channel.id,
                seq: 1,
                hlcTs: 1,
                authorMemberId: author,
                body: "Please summarize the release notes for owner@example.com"
            ),
            Message(
                id: MessageID(),
                channelId: channel.id,
                seq: 2,
                hlcTs: 2,
                authorMemberId: author,
                body: "Create a GitHub issue only after approval."
            ),
        ]

        let preview = await LocalContextCopilotService().preview(LocalContextCopilotRequest(
            channel: channel,
            messages: messages,
            capability: .fallback(.frameworkUnavailable)
        ))

        XCTAssertEqual(preview.route, .deterministicFallback(.frameworkUnavailable))
        XCTAssertEqual(preview.sourceHints.map(\.id), ["S1", "S2"])
        XCTAssertTrue(preview.sourceHints.allSatisfy { $0.uri.hasPrefix("momo://channels/") })
        XCTAssertEqual(preview.sourceHints.map(\.citation), ["[S1]", "[S2]"])
        XCTAssertTrue(preview.summary.contains("[S1]"))
        XCTAssertEqual(preview.contextPacket.schema, "momo.context_packet.compaction.v1")
        XCTAssertEqual(preview.contextPacket.sourceReferences.map(\.id), ["S1", "S2"])
        XCTAssertTrue(preview.contextPacket.sourceReferences.allSatisfy { $0.uri.hasPrefix("momo://channels/") })
        XCTAssertTrue(preview.compressedContext.contains("S1{citation=[S1],uri=momo://channels/"))
        XCTAssertTrue(preview.contextPacket.sidebarPreview.contains("sources=[S1:[S1],S2:[S2]]"))
        XCTAssertEqual(preview.classification.intent, "approve")
        XCTAssertEqual(preview.classification.riskHint, "approval-required")
        XCTAssertEqual(preview.redactionHints.first?.kind, "email")
        XCTAssertEqual(preview.redactionHints.first?.sourceId, "S1")
    }

    @MainActor
    func testViewModelRefreshesLocalContextCopilotPreviewFromVisibleChannel() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(
            chat: backend,
            agentTransport: backend,
            onboarding: backend,
            foundationModelsCapability: .fallback(.unsupportedOS)
        )
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "t")
        viewModel.setChannels(seed.channels)

        await viewModel.selectChannel(seed.channels[0].id)

        let preview = try XCTUnwrap(viewModel.localContextCopilotPreview)
        XCTAssertEqual(preview.route, .deterministicFallback(.unsupportedOS))
        XCTAssertFalse(preview.summary.isEmpty)
        XCTAssertGreaterThan(preview.sourceHints.count, 0)
        XCTAssertTrue(preview.compressedContext.contains("schema=momo.context_packet.compaction.v1"))
        XCTAssertEqual(preview.contextPacket.sourceReferences.count, preview.sourceHints.count)
    }

    @MainActor
    func testLocalContextCopilotKeepsEmbeddedSourceBadgeHints() async throws {
        let viewModel = await MomoMacDemo.makeViewModel()
        let pg18 = try XCTUnwrap(viewModel.channels.first(where: { $0.name == "feature-pg18" }))

        await viewModel.selectChannel(pg18.id)

        let preview = try XCTUnwrap(viewModel.localContextCopilotPreview)
        let github = try XCTUnwrap(preview.sourceHints.first { hint in
            hint.id == "src_github_migration"
        })
        XCTAssertEqual(github.uri, "https://github.com/Dawn-kim-official/momo/issues/1")
        XCTAssertEqual(github.citation, "[src_github_migration]")
        XCTAssertTrue(preview.contextPacket.sourceReferences.contains { ref in
            ref.id == github.id && ref.uri == github.uri && ref.citation == github.citation
        })

        let pg18Thread = try XCTUnwrap(preview.sourceHints.first { hint in
            hint.id == "src_pg18_thread"
        })
        XCTAssertTrue(pg18Thread.title.contains("migration thread"))
        XCTAssertTrue(preview.compressedContext.contains("src_pg18_thread{citation=[src_pg18_thread]"))
    }

    // MARK: MomoServer REST ChatBackend v0

    func testRESTBackendLoginHistoryAndSendUseMomoServerMessageEndpoints() async throws {
        await MockHTTPURLProtocol.reset()
        let session = URLSession(configuration: .momoMocked)
        let workspace = WorkspaceID.demo
        let channel = ChannelID.demoGeneral
        let messageID = MessageID(uuidString: "00000000-0000-7000-8000-000000001001")!
        let clientMsgId = UUID(uuidString: "00000000-0000-7000-8000-000000001777")!

        await MockHTTPURLProtocol.setHandler { request in
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/v1/auth/login"):
                return MockHTTPResponse(json: """
                {
                  "accessToken": "token-123",
                  "refreshToken": "refresh-123",
                  "member": {
                    "id": "\(MemberID.demoHuman.description)",
                    "workspaceId": "\(workspace.description)",
                    "kind": "human",
                    "displayName": "데모 사용자",
                    "handle": "demo"
                  }
                }
                """)
            case ("GET", "/v1/workspaces/\(workspace.description)/channels/\(channel.description)/messages"):
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token-123")
                XCTAssertEqual(request.url?.query, "limit=200")
                return MockHTTPResponse(json: """
                {
                  "messages": [
                    {
                      "id": "\(messageID.description)",
                      "channelId": "\(channel.description)",
                      "seq": 7,
                      "hlcTs": 1700000000000,
                      "hlcCount": 0,
                      "authorMemberId": "\(MemberID.demoHuman.description)",
                      "type": "text",
                      "body": "from server",
                      "createdAtMs": 1700000000000
                    }
                  ],
                  "nextBefore": 7
                }
                """)
            case ("POST", "/v1/workspaces/\(workspace.description)/channels/\(channel.description)/messages"):
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token-123")
                let data = try XCTUnwrap(request.momoBodyData)
                let body = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                XCTAssertEqual(body?["clientMsgId"] as? String, clientMsgId.uuidString)
                XCTAssertEqual(body?["type"] as? String, "text")
                XCTAssertEqual(body?["body"] as? String, "hello REST")
                return MockHTTPResponse(statusCode: 201, json: """
                {
                  "id": "00000000-0000-7000-8000-000000001002",
                  "channelId": "\(channel.description)",
                  "seq": 8,
                  "hlcTs": 1700000001000,
                  "hlcCount": 0,
                  "authorMemberId": "\(MemberID.demoHuman.description)",
                  "type": "text",
                  "body": "hello REST",
                  "createdAtMs": 1700000001000
                }
                """)
            default:
                return MockHTTPResponse(statusCode: 404, json: #"{"title":"unexpected"}"#)
            }
        }

        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(baseURL: URL(string: "https://momo.test")!),
            session: session
        )
        try await backend.connect(workspace: workspace, accessToken: "")

        let history = try await backend.history(channel: channel, after: nil, limit: 200)
        XCTAssertEqual(history.map(\.id), [messageID])
        XCTAssertEqual(history.first?.body, "from server")
        XCTAssertEqual(history.first?.seq, 7)

        let ack = try await backend.sendOptimistic(
            DraftMessage(channelId: channel, type: .text, body: "hello REST"),
            clientMsgId: clientMsgId
        )
        XCTAssertEqual(ack.seq, 8)
        XCTAssertEqual(ack.clientMsgId, clientMsgId)

        let requests = await MockHTTPURLProtocol.requests()
        XCTAssertEqual(requests.map { $0.httpMethod ?? "" }, ["POST", "GET", "POST"])
    }

    func testRESTBackendLoadsChannelsFromMomoServer() async throws {
        await MockHTTPURLProtocol.reset()
        let session = URLSession(configuration: .momoMocked)
        let workspace = WorkspaceID.demo
        let agentLab = ChannelID.demoAgentLab

        await MockHTTPURLProtocol.setHandler { request in
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/v1/auth/login"):
                return MockHTTPResponse(json: """
                {
                  "accessToken": "token-123",
                  "refreshToken": "refresh-123",
                  "member": {
                    "id": "\(MemberID.demoHuman.description)",
                    "workspaceId": "\(workspace.description)",
                    "kind": "human",
                    "displayName": "데모 사용자",
                    "handle": "demo"
                  }
                }
                """)
            case ("GET", "/v1/workspaces/\(workspace.description)/channels"):
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token-123")
                XCTAssertNil(request.url?.query)
                return MockHTTPResponse(json: """
                {
                  "channels": [
                    {
                      "id": "\(ChannelID.demoGeneral.description)",
                      "workspaceId": "\(workspace.description)",
                      "kind": "public",
                      "name": "general",
                      "topic": "팀 일반 채널",
                      "dmKey": null,
                      "createdBy": "\(MemberID.demoHuman.description)",
                      "archivedAtMs": null
                    },
                    {
                      "id": "\(agentLab.description)",
                      "workspaceId": "\(workspace.description)",
                      "kind": "public",
                      "name": "agent-lab",
                      "topic": "에이전트 실험실",
                      "dmKey": null,
                      "createdBy": "\(MemberID.demoHuman.description)",
                      "archivedAtMs": null
                    }
                  ]
                }
                """)
            default:
                return MockHTTPResponse(statusCode: 404, json: #"{"title":"unexpected"}"#)
            }
        }

        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(baseURL: URL(string: "https://momo.test")!),
            session: session
        )
        try await backend.connect(workspace: workspace, accessToken: "")

        let channels = try await backend.channels(workspace: workspace)
        XCTAssertEqual(channels.map(\.id), [.demoGeneral, agentLab])
        XCTAssertEqual(channels.map(\.name), ["general", "agent-lab"])
        XCTAssertEqual(channels.first?.createdBy, .demoHuman)

        let requests = await MockHTTPURLProtocol.requests()
        XCTAssertEqual(requests.map { $0.httpMethod ?? "" }, ["POST", "GET"])
    }

    func testRESTBackendLoadsKimInternRuntimeStatus() async throws {
        await MockHTTPURLProtocol.reset()
        let session = URLSession(configuration: .momoMocked)

        await MockHTTPURLProtocol.setHandler { request in
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/v1/agent-runtime/status"):
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token-123")
                return MockHTTPResponse(json: """
                {
                  "schema": "momo.agent_runtime.status.v0",
                  "agentHandle": "kim-intern",
                  "displayName": "김인턴",
                  "mode": "external-hermes",
                  "availability": "available",
                  "model": "hermes-agent",
                  "endpointLabel": "https://kim.example.net/v1",
                  "keyConfigured": true,
                  "diagnostics": []
                }
                """)
            default:
                return MockHTTPResponse(statusCode: 404, json: #"{"title":"unexpected"}"#)
            }
        }

        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(
                baseURL: URL(string: "https://momo.test")!,
                accessToken: "token-123"
            ),
            session: session
        )
        try await backend.connect(workspace: .demo, accessToken: "")

        let status = try await backend.agentRuntimeStatus()
        XCTAssertEqual(status.agentHandle, "kim-intern")
        XCTAssertEqual(status.mode, .externalHermes)
        XCTAssertEqual(status.availability, .available)
        XCTAssertEqual(status.endpointLabel, "https://kim.example.net/v1")
        XCTAssertFalse(status.endpointLabel.contains("token"))
    }

    func testRESTBackendCreatesChannelAndMutatesMembership() async throws {
        await MockHTTPURLProtocol.reset()
        let session = URLSession(configuration: .momoMocked)
        let workspace = WorkspaceID.demo
        let channel = ChannelID(uuidString: "00000000-0000-7000-8000-000000218201")!
        let membership = UUID(uuidString: "00000000-0000-7000-8000-000000218301")!

        await MockHTTPURLProtocol.setHandler { request in
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/v1/workspaces/\(workspace.description)/channels"):
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token-123")
                let data = try XCTUnwrap(request.momoBodyData)
                let body = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                XCTAssertEqual(body?["kind"] as? String, "private")
                XCTAssertEqual(body?["name"] as? String, "ops-lab")
                XCTAssertEqual(body?["topic"] as? String, "internal test")
                return MockHTTPResponse(statusCode: 201, json: """
                {
                  "channel": {
                    "id": "\(channel.description)",
                    "workspaceId": "\(workspace.description)",
                    "kind": "private",
                    "name": "ops-lab",
                    "topic": "internal test",
                    "dmKey": null,
                    "createdBy": "\(MemberID.demoHuman.description)",
                    "archivedAtMs": null
                  },
                  "creatorMembership": {
                    "id": "\(membership.uuidString)",
                    "workspaceId": "\(workspace.description)",
                    "channelId": "\(channel.description)",
                    "memberId": "\(MemberID.demoHuman.description)",
                    "role": "owner",
                    "joinedAtMs": 1782864000000,
                    "leftAtMs": null
                  }
                }
                """)
            case ("POST", "/v1/workspaces/\(workspace.description)/channels/\(channel.description)/members"):
                let data = try XCTUnwrap(request.momoBodyData)
                let body = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                XCTAssertEqual(body?["memberId"] as? String, MemberID.demoAgent.rawValue.uuidString)
                XCTAssertEqual(body?["role"] as? String, "member")
                return MockHTTPResponse(json: """
                {
                  "membership": {
                    "id": "\(membership.uuidString)",
                    "workspaceId": "\(workspace.description)",
                    "channelId": "\(channel.description)",
                    "memberId": "\(MemberID.demoAgent.description)",
                    "role": "member",
                    "joinedAtMs": 1782864000100,
                    "leftAtMs": null
                  }
                }
                """)
            case ("DELETE", "/v1/workspaces/\(workspace.description)/channels/\(channel.description)/members/\(MemberID.demoAgent.description)"):
                return MockHTTPResponse(json: """
                {
                  "membership": {
                    "id": "\(membership.uuidString)",
                    "workspaceId": "\(workspace.description)",
                    "channelId": "\(channel.description)",
                    "memberId": "\(MemberID.demoAgent.description)",
                    "role": "member",
                    "joinedAtMs": 1782864000100,
                    "leftAtMs": 1782864000200
                  }
                }
                """)
            default:
                return MockHTTPResponse(statusCode: 404, json: #"{"title":"unexpected"}"#)
            }
        }

        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(
                baseURL: URL(string: "https://momo.test")!,
                accessToken: "token-123"
            ),
            session: session
        )
        try await backend.connect(workspace: workspace, accessToken: "token-123")

        let created = try await backend.createChannel(
            workspace: workspace,
            kind: .privateChannel,
            name: "ops-lab",
            topic: "internal test"
        )
        XCTAssertEqual(created.channel.id, channel)
        XCTAssertEqual(created.creatorMembership.role, .owner)

        let added = try await backend.addMember(.demoAgent, to: channel, role: .member)
        XCTAssertEqual(added.memberId, .demoAgent)
        XCTAssertNil(added.leftAtMs)

        let removed = try await backend.removeMember(.demoAgent, from: channel)
        XCTAssertEqual(removed.memberId, .demoAgent)
        XCTAssertNotNil(removed.leftAtMs)

        let requests = await MockHTTPURLProtocol.requests()
        XCTAssertEqual(requests.map { $0.httpMethod ?? "" }, ["POST", "POST", "DELETE"])
    }

    func testRESTBackendLoadsServerOwnedCostSnapshots() async throws {
        await MockHTTPURLProtocol.reset()
        let session = URLSession(configuration: .momoMocked)
        let workspace = WorkspaceID.demo
        let channel = ChannelID.demoAgentLab
        let run = RunID(uuidString: "00000000-0000-7000-8000-000000000904")!

        await MockHTTPURLProtocol.setHandler { request in
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/v1/workspaces/\(workspace.description)/channels/\(channel.description)/cost-snapshots"):
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token-123")
                return MockHTTPResponse(json: """
                {
                  "schema": "momo.cost_snapshot.channel.v0",
                  "channel_id": "\(channel.description)",
                  "as_of_ms": 1782463260000,
                  "snapshots": [
                    {
                      "run_id": "\(run.description)",
                      "reserved_micro_usd": 0,
                      "spent_micro_usd": 6,
                      "soft_limit_micro_usd": 900000,
                      "hard_limit_micro_usd": 1000000,
                      "is_reconciled": true,
                      "was_estimated": false,
                      "limit_state": "normal"
                    }
                  ]
                }
                """)
            default:
                return MockHTTPResponse(statusCode: 404, json: #"{"title":"unexpected"}"#)
            }
        }

        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(
                baseURL: URL(string: "https://momo.test")!,
                accessToken: "token-123"
            ),
            session: session
        )
        try await backend.connect(workspace: workspace, accessToken: "token-123")

        let snapshots = try await backend.costSnapshots(channel: channel)

        XCTAssertEqual(snapshots.map(\.runId), [run])
        XCTAssertEqual(snapshots.first?.spentMicroUSD, 6)
        XCTAssertEqual(snapshots.first?.isReconciled, true)
        XCTAssertEqual(snapshots.first?.limitState, .normal)

        let requests = await MockHTTPURLProtocol.requests()
        XCTAssertEqual(requests.map { $0.httpMethod ?? "" }, ["GET"])
    }

    @MainActor
    func testViewModelLoadsCostSnapshotsWhenSelectingChannel() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "t")
        viewModel.setChannels(seed.channels)

        let costChannel = try XCTUnwrap(seed.channels.first { $0.name == "feature-pg18" })
        await viewModel.selectChannel(costChannel.id)

        let toolMessage = try XCTUnwrap(viewModel.visibleMessages.first { $0.runId != nil })
        let runId = try XCTUnwrap(toolMessage.runId)
        let snapshot = try XCTUnwrap(viewModel.costSnapshot(for: runId))
        XCTAssertEqual(snapshot.spentMicroUSD, 51_000)
        XCTAssertEqual(snapshot.isReconciled, true)
        XCTAssertEqual(viewModel.liveSpentMicroUSD, 51_000)
    }

    @MainActor
    func testViewModelChannelManagementUpdatesDemoMembershipState() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "t")
        viewModel.setChannels(seed.channels)

        let agent = try XCTUnwrap(seed.agents.first)
        await viewModel.createChannel(kind: .privateChannel, name: "ops-lab", topic: "internal test")

        let created = try XCTUnwrap(viewModel.channels.first(where: { $0.name == "ops-lab" }))
        XCTAssertEqual(viewModel.selectedChannelId, created.id)
        XCTAssertFalse(viewModel.isMember(agent.id, in: created.id))

        await viewModel.addMember(agent.id, to: created.id)
        XCTAssertTrue(viewModel.isMember(agent.id, in: created.id))

        await viewModel.removeMember(agent.id, from: created.id)
        XCTAssertFalse(viewModel.isMember(agent.id, in: created.id))

        await viewModel.createChannel(kind: .publicChannel, name: "ops-lab")
        XCTAssertTrue(viewModel.connectionError?.contains("channel name already exists") == true)
    }

    @MainActor
    func testViewModelBootstrapSurfacesRESTChannelListFailure() async throws {
        await MockHTTPURLProtocol.reset()
        let session = URLSession(configuration: .momoMocked)
        let workspace = WorkspaceID.demo

        await MockHTTPURLProtocol.setHandler { request in
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/v1/auth/login"):
                return MockHTTPResponse(json: """
                {
                  "accessToken": "token-123",
                  "refreshToken": "refresh-123",
                  "member": {
                    "id": "\(MemberID.demoHuman.description)",
                    "workspaceId": "\(workspace.description)",
                    "kind": "human",
                    "displayName": "데모 사용자",
                    "handle": "demo"
                  }
                }
                """)
            case ("GET", "/v1/workspaces/\(workspace.description)/channels"):
                return MockHTTPResponse(statusCode: 503, json: #"{"title":"channels unavailable","detail":"db offline"}"#)
            default:
                return MockHTTPResponse(statusCode: 404, json: #"{"title":"unexpected"}"#)
            }
        }

        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(baseURL: URL(string: "https://momo.test")!),
            session: session
        )
        let viewModel = ChatViewModel(chat: backend, agentTransport: backend)

        await viewModel.bootstrap(workspace: workspace, accessToken: "")

        XCTAssertTrue(viewModel.channels.isEmpty)
        XCTAssertTrue(viewModel.connectionError?.contains("channels unavailable") == true)
    }

    func testRESTBackendMapsUnauthorizedResponseToProblemError() async throws {
        await MockHTTPURLProtocol.reset()
        await MockHTTPURLProtocol.setHandler { _ in
            MockHTTPResponse(statusCode: 401, json: #"{"title":"unauthorized","detail":"bad token"}"#)
        }

        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(
                baseURL: URL(string: "https://momo.test")!,
                accessToken: "expired-token"
            ),
            session: URLSession(configuration: .momoMocked)
        )
        try await backend.connect(workspace: .demo, accessToken: "expired-token")

        do {
            _ = try await backend.history(channel: .demoGeneral, after: nil, limit: 50)
            XCTFail("history should fail on 401")
        } catch BackendError.problem(let status, let title, let detail) {
            XCTAssertEqual(status, 401)
            XCTAssertEqual(title, "unauthorized")
            XCTAssertEqual(detail, "bad token")
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testRESTBackendSubscribeUsesRealtimeDriverStartingAfterKnownHistorySeq() async throws {
        await MockHTTPURLProtocol.reset()
        let session = URLSession(configuration: .momoMocked)
        let workspace = WorkspaceID.demo
        let channel = ChannelID.demoGeneral
        let liveMessage = Message(
            id: MessageID(uuidString: "00000000-0000-7000-8000-000000001008")!,
            channelId: channel,
            seq: 8,
            hlcTs: 1700000001000,
            authorMemberId: .demoHuman,
            body: "live via driver"
        )
        let driver = RecordingRealtimeSubscriptionDriver(events: [.message(liveMessage)])

        await MockHTTPURLProtocol.setHandler { request in
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/v1/workspaces/\(workspace.description)/channels/\(channel.description)/messages"):
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token-123")
                return MockHTTPResponse(json: """
                {
                  "messages": [
                    {
                      "id": "00000000-0000-7000-8000-000000001007",
                      "channelId": "\(channel.description)",
                      "seq": 7,
                      "hlcTs": 1700000000000,
                      "hlcCount": 0,
                      "authorMemberId": "\(MemberID.demoHuman.description)",
                      "type": "text",
                      "body": "history 7",
                      "createdAtMs": 1700000000000
                    }
                  ],
                  "nextBefore": 7
                }
                """)
            default:
                return MockHTTPResponse(statusCode: 404, json: #"{"title":"unexpected"}"#)
            }
        }

        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(
                baseURL: URL(string: "https://momo.test")!,
                accessToken: "token-123"
            ),
            session: session,
            realtimeDriver: driver
        )
        try await backend.connect(workspace: workspace, accessToken: "token-123")

        let history = try await backend.history(channel: channel, after: nil, limit: 200)
        XCTAssertEqual(history.map(\.seq), [7])

        let stream = try await backend.subscribe(channel: channel)
        var received: [RealtimeEvent] = []
        for await event in stream {
            received.append(event)
        }

        let startingSeqs = await driver.startingSeqs()
        XCTAssertEqual(startingSeqs, [7])
        XCTAssertEqual(received.messageSeqs, [8])
    }

    @MainActor
    func testViewModelSurfacesRealtimeReconnectStatusFromDriver() async throws {
        await MockHTTPURLProtocol.reset()
        let session = URLSession(configuration: .momoMocked)
        let workspace = WorkspaceID.demo
        let channel = ChannelID.demoGeneral
        let driver = RecordingRealtimeSubscriptionDriver(
            events: [],
            statuses: [
                RealtimeConnectionStatus(
                    channelId: channel,
                    connection: .reconnecting,
                    subscription: .recovering,
                    fallback: .restHistory,
                    canRetry: false,
                    message: "temporary network loss"
                ),
                RealtimeConnectionStatus(
                    channelId: channel,
                    connection: .connected,
                    subscription: .subscribed,
                    message: "recovered"
                ),
            ]
        )

        await MockHTTPURLProtocol.setHandler { request in
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/v1/workspaces/\(workspace.description)/approvals"):
                return MockHTTPResponse(json: #"{"approvals":[]}"#)
            case ("GET", "/v1/workspaces/\(workspace.description)/channels"):
                return MockHTTPResponse(json: """
                {
                  "channels": [
                    {
                      "id": "\(channel.description)",
                      "workspaceId": "\(workspace.description)",
                      "kind": "public",
                      "name": "general",
                      "topic": "팀 일반 채널",
                      "createdBy": "\(MemberID.demoHuman.description)"
                    }
                  ]
                }
                """)
            case ("GET", "/v1/workspaces/\(workspace.description)/channels/\(channel.description)/messages"):
                return MockHTTPResponse(json: #"{"messages":[],"nextBefore":null}"#)
            default:
                return MockHTTPResponse(statusCode: 404, json: #"{"title":"unexpected"}"#)
            }
        }

        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(
                baseURL: URL(string: "https://momo.test")!,
                accessToken: "token-123"
            ),
            session: session,
            realtimeDriver: driver
        )
        let viewModel = ChatViewModel(chat: backend, agentTransport: backend)

        await viewModel.bootstrap(workspace: workspace, accessToken: "token-123")
        await viewModel.selectChannel(channel)
        try await Task.sleep(for: .milliseconds(50))

        XCTAssertEqual(viewModel.selectedRealtimeStatus?.connection, .connected)
        XCTAssertEqual(viewModel.selectedRealtimeStatus?.subscription, .subscribed)
        XCTAssertEqual(viewModel.selectedRealtimeStatus?.message, "recovered")
        let statusSubscriptionCount = await driver.statusSubscriptionCount()
        XCTAssertEqual(statusSubscriptionCount, 1)
    }

    @MainActor
    func testViewModelKeepsRESTFallbackWhenRealtimeDriverIsUnavailableAndRetryIsManual() async throws {
        await MockHTTPURLProtocol.reset()
        let session = URLSession(configuration: .momoMocked)
        let workspace = WorkspaceID.demo
        let channel = ChannelID.demoGeneral

        await MockHTTPURLProtocol.setHandler { request in
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/v1/workspaces/\(workspace.description)/approvals"):
                return MockHTTPResponse(json: #"{"approvals":[]}"#)
            case ("GET", "/v1/workspaces/\(workspace.description)/channels"):
                return MockHTTPResponse(json: """
                {
                  "channels": [
                    {
                      "id": "\(channel.description)",
                      "workspaceId": "\(workspace.description)",
                      "kind": "public",
                      "name": "general"
                    }
                  ]
                }
                """)
            case ("GET", "/v1/workspaces/\(workspace.description)/channels/\(channel.description)/messages"):
                return MockHTTPResponse(json: #"{"messages":[],"nextBefore":null}"#)
            default:
                return MockHTTPResponse(statusCode: 404, json: #"{"title":"unexpected"}"#)
            }
        }

        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(
                baseURL: URL(string: "https://momo.test")!,
                accessToken: "token-123"
            ),
            session: session
        )
        let viewModel = ChatViewModel(chat: backend, agentTransport: backend)

        await viewModel.bootstrap(workspace: workspace, accessToken: "token-123")
        await viewModel.selectChannel(channel)
        try await Task.sleep(for: .milliseconds(50))

        XCTAssertEqual(viewModel.selectedRealtimeStatus?.fallback, .restHistory)
        XCTAssertEqual(viewModel.selectedRealtimeStatus?.connection, .disabled)
        XCTAssertEqual(viewModel.selectedRealtimeStatus?.subscription, .disabled)
        XCTAssertEqual(viewModel.selectedRealtimeStatus?.canRetry, true)

        await viewModel.retryRealtime()
        try await Task.sleep(for: .milliseconds(50))

        XCTAssertEqual(viewModel.selectedRealtimeStatus?.fallback, .restHistory)
        XCTAssertEqual(viewModel.selectedRealtimeStatus?.connection, .disabled)
        XCTAssertEqual(viewModel.selectedRealtimeStatus?.subscription, .disabled)
    }

    func testRESTBackendLoadsPendingApprovalsAndPreservesDecisionIdempotencyKey() async throws {
        await MockHTTPURLProtocol.reset()
        let session = URLSession(configuration: .momoMocked)
        let workspace = WorkspaceID.demo
        let approvalId = ApprovalID(uuidString: "00000000-0000-7000-8000-000000000901")!
        let clientDecisionId = UUID(uuidString: "00000000-0000-7000-8000-000000203001")!

        await MockHTTPURLProtocol.setHandler { request in
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/v1/workspaces/\(workspace.description)/approvals"):
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token-123")
                XCTAssertEqual(request.url?.query, "status=pending")
                return MockHTTPResponse(json: """
                {
                  "approvals": [
                    {
                      "id": "\(approvalId.description)",
                      "workspace_id": "\(workspace.description)",
                      "run_id": "00000000-0000-7000-8000-000000000801",
                      "channel_id": "\(ChannelID.demoGeneral.description)",
                      "request_message_id": "00000000-0000-7000-8000-000000000701",
                      "requested_by": "\(MemberID.demoAgent.description)",
                      "on_behalf_of": "\(MemberID.demoHuman.description)",
                      "action_type": "github.issue.create",
                      "payload": {"title": "Create rollout checklist issue"},
                      "status": "pending",
                      "estimated_micro_usd": 820000,
                      "is_reversible": true,
                      "decided_by": null,
                      "decided_at_ms": null,
                      "decision_reason": null,
                      "expires_at_ms": 1782463260000
                    }
                  ]
                }
                """)
            case ("POST", "/v1/workspaces/\(workspace.description)/approvals/\(approvalId.description)/decision"):
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token-123")
                let data = try XCTUnwrap(request.momoBodyData)
                let body = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                XCTAssertEqual(body?["approval_id"] as? String, approvalId.description)
                XCTAssertEqual(body?["approve"] as? Bool, true)
                XCTAssertEqual(body?["client_decision_id"] as? String, clientDecisionId.uuidString)
                return MockHTTPResponse(json: """
                {
                  "approval_id": "\(approvalId.description)",
                  "status": "approved",
                  "decided_by": "\(MemberID.demoHuman.description)",
                  "decided_at_ms": 1782463260000,
                  "decision_reason": "safe"
                }
                """)
            default:
                return MockHTTPResponse(statusCode: 404, json: #"{"title":"unexpected"}"#)
            }
        }

        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(
                baseURL: URL(string: "https://momo.test")!,
                accessToken: "token-123"
            ),
            session: session
        )
        try await backend.connect(workspace: workspace, accessToken: "token-123")

        let pending = try await backend.pendingApprovals(workspace: workspace, status: .pending)
        XCTAssertEqual(pending.map(\.id), [approvalId])
        XCTAssertEqual(pending.first?.eventProjection.status, .pending)
        XCTAssertEqual(pending.first?.estimatedMicroUSD, 820_000)
        XCTAssertEqual(pending.first?.isReversible, true)

        let receipt = try await backend.decideApproval(
            ApprovalDecisionRequest(
                approvalId: approvalId,
                approve: true,
                reason: "safe",
                clientDecisionId: clientDecisionId
            )
        )
        XCTAssertEqual(receipt.status, .approved)
    }

    func testRESTBackendConfigFromEnvironmentUsesDevSafeSeedDefaults() throws {
        let config = try XCTUnwrap(MomoServerRESTChatBackendConfig.fromEnvironment([
            "MOMO_SERVER_BASE_URL": "http://127.0.0.1:8080",
            "MOMO_CENTRIFUGO_WS_URL": "ws://127.0.0.1:8000/connection/websocket",
        ]))

        XCTAssertEqual(config.baseURL.absoluteString, "http://127.0.0.1:8080")
        XCTAssertEqual(config.centrifugoWebSocketURL?.absoluteString, "ws://127.0.0.1:8000/connection/websocket")
        XCTAssertEqual(config.workspace, .demo)
        XCTAssertEqual(config.defaultChannel, .demoGeneral)
        XCTAssertEqual(config.channels.map(\.name), ["general", "agent-lab"])
        XCTAssertEqual(config.members.map(\.handle), ["demo", "kim-intern"])
        XCTAssertNil(MomoServerRESTChatBackendConfig.fromEnvironment([:]))
    }

    func testRESTBackendConfigCanDeriveCentrifugoWebSocketURLFromCentPort() throws {
        let config = try XCTUnwrap(MomoServerRESTChatBackendConfig.fromEnvironment([
            "MOMO_SERVER_BASE_URL": "http://127.0.0.1:26670",
            "CENT_PORT": "26671",
        ]))

        XCTAssertEqual(config.centrifugoWebSocketURL?.absoluteString, "ws://127.0.0.1:26671/connection/websocket")
    }

    func testSwiftCentrifugeTransportBuildsWorkspaceQualifiedChannelName() {
        XCTAssertEqual(
            SwiftCentrifugeRealtimeSubscriptionTransport.channelName(workspace: .demo, channel: .demoGeneral),
            "ch:ws00000000-0000-7000-8000-000000000001.00000000-0000-7000-8000-000000000201"
        )
    }

    func testSwiftCentrifugeTransportDecodesPublicationDataAsRealtimeEnvelope() throws {
        let data = """
        {
          "type": "message.new",
          "v": 1,
          "ts": 1700000000000,
          "seq": 9,
          "payload": {
            "id": "00000000-0000-7000-8000-000000001009",
            "channel_id": "00000000-0000-7000-8000-000000000201",
            "seq": 9,
            "hlc_ts": 1700000000000,
            "hlc_count": 0,
            "author_member_id": "00000000-0000-7000-8000-000000000101",
            "type": "text",
            "body": "live via SwiftCentrifuge",
            "created_at_ms": 1700000000000
          }
        }
        """.data(using: .utf8)!

        let envelope = try SwiftCentrifugeRealtimeSubscriptionTransport.decodePublicationData(data)
        XCTAssertEqual(envelope.type, "message.new")
        XCTAssertEqual(envelope.seq, 9)
        guard case .message(let message) = try envelope.decodeEvent() else {
            return XCTFail("publication should decode to message event")
        }
        XCTAssertEqual(message.seq, 9)
        XCTAssertEqual(message.body, "live via SwiftCentrifuge")
    }

    func testRealtimeTokenProviderPostsBearerTokenToServerEndpoint() async throws {
        await MockHTTPURLProtocol.reset()
        await MockHTTPURLProtocol.setHandler { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/v1/auth/realtime-token")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer app-token")
            return MockHTTPResponse(json: """
            {
              "token": "cent-token",
              "tokenType": "Bearer",
              "expiresAtMs": 1700000300000,
              "ttlSeconds": 300,
              "workspaceId": "\(WorkspaceID.demo.description)",
              "memberId": "\(MemberID.demoHuman.description)"
            }
            """)
        }

        let provider = MomoServerRealtimeTokenProvider(
            baseURL: URL(string: "https://momo.test")!,
            session: URLSession(configuration: .momoMocked),
            accessTokenProvider: { "app-token" }
        )

        let token = try await provider.realtimeConnectionToken()
        XCTAssertEqual(token, "cent-token")
    }

    // MARK: Real-server session onboarding

    func testSessionClientLoginReturnsWorkspaceSession() async throws {
        await MockHTTPURLProtocol.reset()
        let workspace = WorkspaceID.demo
        await MockHTTPURLProtocol.setHandler { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/v1/auth/login")
            let data = try XCTUnwrap(request.momoBodyData)
            let body = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            XCTAssertEqual(body?["email"] as? String, "demo@momo.local")
            XCTAssertEqual(body?["password"] as? String, "secret")
            return MockHTTPResponse(json: """
            {
              "accessToken": "access-session",
              "refreshToken": "refresh-session",
              "member": {
                "id": "\(MemberID.demoHuman.description)",
                "workspaceId": "\(workspace.description)",
                "kind": "human",
                "displayName": "Demo User",
                "handle": "demo"
              }
            }
            """)
        }

        let client = MomoServerSessionClient(session: URLSession(configuration: .momoMocked))
        let session = try await client.login(form: MomoServerSessionForm(
            baseURLString: "https://momo.test",
            email: "demo@momo.local",
            password: "secret"
        ))

        XCTAssertEqual(session.baseURL.absoluteString, "https://momo.test")
        XCTAssertEqual(session.workspace, workspace)
        XCTAssertEqual(session.member.id, .demoHuman)
        XCTAssertEqual(session.accessToken, "access-session")
        XCTAssertFalse(session.joinedWithInvite)
    }

    func testSessionClientJoinUsesInviteEndpointAndTokenSession() async throws {
        await MockHTTPURLProtocol.reset()
        let workspace = WorkspaceID.demo
        await MockHTTPURLProtocol.setHandler { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/v1/join")
            let data = try XCTUnwrap(request.momoBodyData)
            let body = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            XCTAssertEqual(body?["code"] as? String, "MOMO-213")
            XCTAssertEqual(body?["email"] as? String, "new.user@momo.local")
            XCTAssertEqual(body?["password"] as? String, "join-secret")
            XCTAssertEqual(body?["displayName"] as? String, "New User")
            return MockHTTPResponse(statusCode: 201, json: """
            {
              "accessToken": "join-access",
              "refreshToken": "join-refresh",
              "workspaceId": "\(workspace.description)",
              "member": {
                "id": "\(MemberID.demoHuman.description)",
                "workspaceId": "\(workspace.description)",
                "kind": "human",
                "displayName": "New User",
                "handle": "new-user"
              },
              "memberships": [],
              "invite": {},
              "redemptionId": "00000000-0000-7000-8000-000000213001",
              "createdMember": true
            }
            """)
        }

        let client = MomoServerSessionClient(session: URLSession(configuration: .momoMocked))
        let session = try await client.join(form: MomoServerSessionForm(
            baseURLString: "https://momo.test",
            email: "new.user@momo.local",
            password: "join-secret",
            inviteCode: "MOMO-213"
        ))

        XCTAssertEqual(session.workspace, workspace)
        XCTAssertEqual(session.accessToken, "join-access")
        XCTAssertTrue(session.joinedWithInvite)
        XCTAssertEqual(session.member.displayName, "New User")
    }

    func testInviteAdminClientCreateMapsServerContractAndRawCode() async throws {
        await MockHTTPURLProtocol.reset()
        let workspace = WorkspaceID.demo
        let inviteID = UUID(uuidString: "00000000-0000-7000-8000-000000226001")!
        let expiresAtMs: Int64 = 1_790_000_000_000
        await MockHTTPURLProtocol.setHandler { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/v1/workspaces/\(workspace.description)/invites")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer admin-token")
            let data = try XCTUnwrap(request.momoBodyData)
            let body = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            XCTAssertEqual(body?["role"] as? String, "admin")
            XCTAssertEqual(body?["maxUses"] as? Int, 3)
            XCTAssertEqual((body?["expiresAtMs"] as? NSNumber)?.int64Value, expiresAtMs)
            XCTAssertEqual((body?["metadata"] as? [String: String])?["source"], "test")
            return MockHTTPResponse(statusCode: 201, json: """
            {
              "invite": {
                "id": "\(inviteID.uuidString)",
                "workspaceId": "\(workspace.description)",
                "codePreview": "ABC123",
                "role": "admin",
                "maxUses": 3,
                "usedCount": 0,
                "expiresAtMs": \(expiresAtMs),
                "revokedAtMs": null,
                "revokedBy": null,
                "revocationReason": null,
                "createdBy": "\(MemberID.demoHuman.description)",
                "createdAtMs": 1782864000000,
                "updatedAtMs": 1782864000000
              },
              "code": "momo_raw_invite_code"
            }
            """)
        }

        let client = MomoInviteAdminClient(session: URLSession(configuration: .momoMocked))
        let created = try await client.createInvite(
            context: MomoInviteAdminContext(
                baseURL: URL(string: "https://momo.test")!,
                workspace: workspace,
                accessToken: "admin-token"
            ),
            request: MomoInviteCreateRequest(
                role: .admin,
                maxUses: 3,
                expiresAtMs: expiresAtMs,
                metadata: ["source": "test"]
            )
        )

        XCTAssertEqual(created.code, "momo_raw_invite_code")
        XCTAssertEqual(created.invite.id, inviteID)
        XCTAssertEqual(created.invite.role, .admin)
        XCTAssertEqual(created.invite.statusLabel, "Active")
    }

    func testInviteAdminClientListAndRevokeReflectRevokedState() async throws {
        await MockHTTPURLProtocol.reset()
        let workspace = WorkspaceID.demo
        let inviteID = UUID(uuidString: "00000000-0000-7000-8000-000000226002")!
        let revokedAtMs: Int64 = 1_782_864_200_000
        await MockHTTPURLProtocol.setHandler { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer admin-token")
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/v1/workspaces/\(workspace.description)/invites"):
                XCTAssertEqual(request.url?.query?.contains("include_revoked=true"), true)
                return MockHTTPResponse(json: """
                {
                  "invites": [
                    {
                      "id": "\(inviteID.uuidString)",
                      "workspaceId": "\(workspace.description)",
                      "codePreview": "XYZ789",
                      "role": "member",
                      "maxUses": 2,
                      "usedCount": 1,
                      "expiresAtMs": 1790000000000,
                      "revokedAtMs": null,
                      "revokedBy": null,
                      "revocationReason": null,
                      "createdBy": "\(MemberID.demoHuman.description)",
                      "createdAtMs": 1782864000000,
                      "updatedAtMs": 1782864000000
                    }
                  ]
                }
                """)
            case ("POST", "/v1/workspaces/\(workspace.description)/invites/\(inviteID.uuidString)/revoke"):
                let data = try XCTUnwrap(request.momoBodyData)
                let body = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                XCTAssertEqual(body?["reason"] as? String, "rotated")
                return MockHTTPResponse(json: """
                {
                  "id": "\(inviteID.uuidString)",
                  "workspaceId": "\(workspace.description)",
                  "codePreview": "XYZ789",
                  "role": "member",
                  "maxUses": 2,
                  "usedCount": 1,
                  "expiresAtMs": 1790000000000,
                  "revokedAtMs": \(revokedAtMs),
                  "revokedBy": "\(MemberID.demoHuman.description)",
                  "revocationReason": "rotated",
                  "createdBy": "\(MemberID.demoHuman.description)",
                  "createdAtMs": 1782864000000,
                  "updatedAtMs": \(revokedAtMs)
                }
                """)
            default:
                XCTFail("unexpected request \(request.httpMethod ?? "?") \(request.url?.absoluteString ?? "?")")
                return MockHTTPResponse(statusCode: 404, json: "{}")
            }
        }

        let context = MomoInviteAdminContext(
            baseURL: URL(string: "https://momo.test")!,
            workspace: workspace,
            accessToken: "admin-token"
        )
        let client = MomoInviteAdminClient(session: URLSession(configuration: .momoMocked))

        let listed = try await client.listInvites(context: context)
        XCTAssertEqual(listed.count, 1)
        XCTAssertEqual(listed[0].usedCount, 1)
        XCTAssertEqual(listed[0].statusLabel, "Active")

        let revoked = try await client.revokeInvite(context: context, inviteID: inviteID, reason: "rotated")
        XCTAssertTrue(revoked.isRevoked)
        XCTAssertEqual(revoked.statusLabel, "Revoked")
        XCTAssertEqual(revoked.revocationReason, "rotated")
    }

    @MainActor
    func testInviteAdminViewModelCreatesRefreshesAndCopiesRawCode() async throws {
        await MockHTTPURLProtocol.reset()
        let workspace = WorkspaceID.demo
        let inviteID = UUID(uuidString: "00000000-0000-7000-8000-000000232001")!
        var copiedCode: String?

        await MockHTTPURLProtocol.setHandler { request in
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/v1/workspaces/\(workspace.description)/invites"):
                return MockHTTPResponse(statusCode: 201, json: """
                {
                  "invite": {
                    "id": "\(inviteID.uuidString)",
                    "workspaceId": "\(workspace.description)",
                    "codePreview": "RAW232",
                    "role": "admin",
                    "maxUses": 2,
                    "usedCount": 0,
                    "expiresAtMs": 1790000000000,
                    "revokedAtMs": null,
                    "revokedBy": null,
                    "revocationReason": null,
                    "createdBy": "\(MemberID.demoHuman.description)",
                    "createdAtMs": 1782864000000,
                    "updatedAtMs": 1782864000000
                  },
                  "code": "momo_raw_232"
                }
                """)
            case ("GET", "/v1/workspaces/\(workspace.description)/invites"):
                return MockHTTPResponse(json: """
                {
                  "invites": [
                    {
                      "id": "\(inviteID.uuidString)",
                      "workspaceId": "\(workspace.description)",
                      "codePreview": "RAW232",
                      "role": "admin",
                      "maxUses": 2,
                      "usedCount": 0,
                      "expiresAtMs": 1790000000000,
                      "revokedAtMs": null,
                      "revokedBy": null,
                      "revocationReason": null,
                      "createdBy": "\(MemberID.demoHuman.description)",
                      "createdAtMs": 1782864000000,
                      "updatedAtMs": 1782864000000
                    }
                  ]
                }
                """)
            default:
                return MockHTTPResponse(statusCode: 404, json: #"{"title":"unexpected"}"#)
            }
        }

        let model = MomoInviteAdminViewModel(
            context: MomoInviteAdminContext(
                baseURL: URL(string: "https://momo.test")!,
                workspace: workspace,
                accessToken: "admin-token"
            ),
            client: MomoInviteAdminClient(session: URLSession(configuration: .momoMocked)),
            copyInviteCode: { copiedCode = $0 }
        )

        await model.createInvite(role: .admin, maxUsesText: "2", expiresInDaysText: "14")
        XCTAssertEqual(model.operation, .idle)
        XCTAssertEqual(model.createdCode, "momo_raw_232")
        XCTAssertEqual(model.invites.map(\.id), [inviteID])
        XCTAssertTrue(model.notice?.contains("Copy the raw code now") == true)
        XCTAssertFalse(model.canRetry)

        model.copyCreatedCode()
        XCTAssertEqual(copiedCode, "momo_raw_232")
        XCTAssertTrue(model.notice?.contains("cannot be recovered") == true)
    }

    @MainActor
    func testInviteAdminViewModelRefreshFailureCanRetry() async throws {
        await MockHTTPURLProtocol.reset()
        let workspace = WorkspaceID.demo
        let inviteID = UUID(uuidString: "00000000-0000-7000-8000-000000232002")!
        let requestCount = SynchronizedCounter()

        await MockHTTPURLProtocol.setHandler { request in
            let count = requestCount.increment()
            XCTAssertEqual(request.url?.path, "/v1/workspaces/\(workspace.description)/invites")
            if count == 1 {
                return MockHTTPResponse(statusCode: 503, json: #"{"title":"invite list unavailable","detail":"db warming"}"#)
            }
            return MockHTTPResponse(json: """
            {
              "invites": [
                {
                  "id": "\(inviteID.uuidString)",
                  "workspaceId": "\(workspace.description)",
                  "codePreview": "RETRY",
                  "role": "member",
                  "maxUses": 1,
                  "usedCount": 0,
                  "expiresAtMs": 1790000000000,
                  "revokedAtMs": null,
                  "revokedBy": null,
                  "revocationReason": null,
                  "createdBy": "\(MemberID.demoHuman.description)",
                  "createdAtMs": 1782864000000,
                  "updatedAtMs": 1782864000000
                }
              ]
            }
            """)
        }

        let model = MomoInviteAdminViewModel(
            context: MomoInviteAdminContext(
                baseURL: URL(string: "https://momo.test")!,
                workspace: workspace,
                accessToken: "admin-token"
            ),
            client: MomoInviteAdminClient(session: URLSession(configuration: .momoMocked)),
            copyInviteCode: { _ in }
        )

        await model.refreshInvites(showNotice: true)
        XCTAssertEqual(model.operation, .idle)
        XCTAssertTrue(model.errorMessage?.contains("invite list unavailable") == true)
        XCTAssertTrue(model.canRetry)

        await model.retryLastFailure()
        XCTAssertEqual(model.invites.map(\.id), [inviteID])
        XCTAssertNil(model.errorMessage)
        XCTAssertEqual(model.notice, "Invite list refreshed.")
        XCTAssertFalse(model.canRetry)
    }

    @MainActor
    func testViewModelSessionSensitiveStateClearRemovesStaleWorkspaceData() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "t")
        viewModel.setChannels(seed.channels)
        await viewModel.selectChannel(seed.channels[0].id)
        await viewModel.submitInviteCode("MOMO-DEV")

        XCTAssertFalse(viewModel.channels.isEmpty)
        XCTAssertFalse(viewModel.members.isEmpty)
        XCTAssertNotNil(viewModel.selectedChannelId)
        XCTAssertFalse(viewModel.visibleMessages.isEmpty)
        guard case .joined = viewModel.inviteJoinState else {
            return XCTFail("invite should be joined before clearing")
        }

        await viewModel.clearSessionSensitiveState()

        XCTAssertNil(viewModel.workspaceId)
        XCTAssertTrue(viewModel.channels.isEmpty)
        XCTAssertTrue(viewModel.members.isEmpty)
        XCTAssertNil(viewModel.selectedChannelId)
        XCTAssertTrue(viewModel.messagesByChannel.isEmpty)
        XCTAssertTrue(viewModel.partials.isEmpty)
        XCTAssertTrue(viewModel.realtimeStatuses.isEmpty)
        XCTAssertEqual(viewModel.agentRuntimeStatus, .localMock)
        XCTAssertEqual(viewModel.inviteJoinState, .idle)
    }

    func testKimInternInternalAlphaProviderSummaryDistinguishesModesAndDiagnostics() {
        let external = AgentRuntimeStatus(
            mode: .externalHermes,
            availability: .available,
            endpointLabel: "https://kim.example.net/v1",
            keyConfigured: true
        )
        XCTAssertEqual(external.internalAlphaProviderSummary, "External Hermes · key ready · https://kim.example.net/v1")
        XCTAssertTrue(external.internalAlphaHelpText.contains("key configured"))

        let degraded = AgentRuntimeStatus(
            mode: .internalHostMock,
            availability: .degraded,
            endpointLabel: "internal mock",
            keyConfigured: false,
            degradedReason: "provider readiness check failed",
            diagnostics: ["provider timeout"]
        )
        XCTAssertEqual(degraded.internalAlphaProviderSummary, "Internal host mock · key missing · provider readiness check failed")
        XCTAssertTrue(degraded.internalAlphaHelpText.contains("key not configured"))
        XCTAssertTrue(degraded.internalAlphaHelpText.contains("degraded=provider readiness check failed"))
        XCTAssertTrue(degraded.internalAlphaHelpText.contains("provider timeout"))
    }

    func testSessionClientSurfacesAuthProblemForBadCredentials() async throws {
        await MockHTTPURLProtocol.reset()
        await MockHTTPURLProtocol.setHandler { _ in
            MockHTTPResponse(statusCode: 401, json: #"{"title":"invalid credentials","detail":"check email"}"#)
        }

        let client = MomoServerSessionClient(session: URLSession(configuration: .momoMocked))
        do {
            _ = try await client.login(form: MomoServerSessionForm(
                baseURLString: "https://momo.test",
                email: "bad@momo.local",
                password: "wrong"
            ))
            XCTFail("login should fail")
        } catch MomoServerSessionError.problem(let status, let title, let detail) {
            XCTAssertEqual(status, 401)
            XCTAssertEqual(title, "invalid credentials")
            XCTAssertEqual(detail, "check email")
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testSessionStorePersistsNonSecretFieldsWithoutPasswordByDefault() {
        let suite = "momo-session-store-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = MomoServerSessionStore(
            defaults: defaults,
            keychain: MomoKeychainPasswordStore(service: "momo.test.\(suite)")
        )

        store.save(MomoServerSessionForm(
            baseURLString: "https://momo.test",
            email: "demo@momo.local",
            password: "do-not-store",
            inviteCode: "MOMO-213",
            savePassword: false
        ))

        let loaded = store.load()
        XCTAssertEqual(loaded.baseURLString, "https://momo.test")
        XCTAssertEqual(loaded.email, "demo@momo.local")
        XCTAssertEqual(loaded.inviteCode, "MOMO-213")
        XCTAssertEqual(loaded.password, "")
        XCTAssertFalse(loaded.savePassword)
    }

    func testRESTBackendClearSessionSensitiveStateDropsTokenAndWorkspace() async throws {
        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(
                baseURL: URL(string: "https://momo.test")!,
                accessToken: "token-123"
            ),
            session: URLSession(configuration: .momoMocked)
        )

        try await backend.connect(workspace: .demo, accessToken: "token-123")
        await backend.clearSessionSensitiveState()

        do {
            _ = try await backend.history(channel: .demoGeneral, after: nil, limit: 50)
            XCTFail("history should require a fresh session after logout")
        } catch BackendError.notConnected {
            // Expected: access token and workspace cache were cleared.
        } catch {
            XCTFail("unexpected error after session clear: \(error)")
        }
    }

    @MainActor
    func testViewModelClearSessionSensitiveStateResetsVisibleWorkspaceState() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "token")
        viewModel.setChannels(seed.channels)
        await viewModel.selectChannel(seed.channels[0].id)

        XCTAssertNotNil(viewModel.workspaceId)
        XCTAssertFalse(viewModel.channels.isEmpty)
        XCTAssertFalse(viewModel.visibleMessages.isEmpty)

        await viewModel.clearSessionSensitiveState()

        XCTAssertNil(viewModel.workspaceId)
        XCTAssertTrue(viewModel.members.isEmpty)
        XCTAssertTrue(viewModel.channels.isEmpty)
        XCTAssertNil(viewModel.selectedChannelId)
        XCTAssertTrue(viewModel.messagesByChannel.isEmpty)
        XCTAssertTrue(viewModel.partials.isEmpty)
        XCTAssertTrue(viewModel.realtimeStatuses.isEmpty)
        XCTAssertEqual(viewModel.composerDraft, "")
    }

    @MainActor
    func testSessionControllerLogoutClearsCurrentSessionAndPasswordFormState() async throws {
        let suite = "momo-session-controller-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = MomoServerSessionStore(
            defaults: defaults,
            keychain: MomoKeychainPasswordStore(service: "momo.test.\(suite)")
        )
        let controller = MomoServerSessionController(store: store)
        controller.form = MomoServerSessionForm(
            baseURLString: "https://momo.test",
            email: "demo@momo.local",
            password: "in-memory-secret",
            savePassword: true
        )

        await controller.openDemo()
        guard case .connected(let viewModel, _, _) = controller.phase else {
            return XCTFail("demo should connect before logout")
        }

        await controller.logout()

        guard case .choosing = controller.phase else {
            return XCTFail("logout should return to chooser")
        }
        XCTAssertNil(viewModel.workspaceId)
        XCTAssertTrue(viewModel.channels.isEmpty)
        XCTAssertEqual(controller.form.password, "")
        XCTAssertFalse(controller.form.savePassword)
        XCTAssertTrue(controller.sessionNotice?.contains("Logged out") == true)
    }
}

private actor AgentMentionFallbackChatBackend: ChatBackend {
    private let workspace: WorkspaceID
    private let channel: ChannelID
    private let human: MemberID
    private let agent: MemberID
    private var messages: [Message] = []
    private var seq: Int64 = 0

    init(workspace: WorkspaceID, channel: ChannelID, human: MemberID, agent: MemberID) {
        self.workspace = workspace
        self.channel = channel
        self.human = human
        self.agent = agent
    }

    func connect(workspace: WorkspaceID, accessToken: String) async throws {}

    func sendOptimistic(_ draft: DraftMessage, clientMsgId: UUID) async throws -> Message {
        seq += 1
        let ack = Message(
            id: MessageID(),
            channelId: draft.channelId,
            seq: seq,
            hlcTs: seq,
            authorMemberId: human,
            type: .text,
            body: draft.body,
            clientMsgId: clientMsgId
        )
        messages.append(ack)

        if draft.body?.contains("@kim-intern") == true || draft.body?.contains("@김인턴") == true {
            seq += 1
            messages.append(Message(
                id: MessageID(),
                channelId: draft.channelId,
                seq: seq,
                hlcTs: seq,
                authorMemberId: agent,
                type: .text,
                body: "김인턴 final durable response for @kim-intern",
                props: .object(["mention_handle": .string("kim-intern")]),
                runId: RunID()
            ))
        }

        return ack
    }

    func subscribe(channel: ChannelID) async throws -> AsyncStream<RealtimeEvent> {
        AsyncStream { continuation in continuation.finish() }
    }

    func history(channel: ChannelID, after seq: Int64?, limit: Int) async throws -> [Message] {
        let filtered = messages.filter { message in
            guard let seq else { return true }
            return (message.seq ?? 0) > seq
        }
        return Array(filtered.prefix(limit))
    }

    func presence(channel: ChannelID) async throws -> [PresenceEntry] { [] }

    func members(workspace: WorkspaceID) async throws -> [Member] {
        [
            Member(id: human, workspaceId: workspace, kind: .human, displayName: "Human", handle: "human"),
            Member(id: agent, workspaceId: workspace, kind: .agent, displayName: "김인턴", handle: "kim-intern"),
        ]
    }

    func channels(workspace: WorkspaceID) async throws -> [Channel] {
        [
            Channel(id: channel, workspaceId: workspace, kind: .publicChannel, name: "agent-lab", createdBy: human),
        ]
    }

    func costSnapshots(channel: ChannelID) async throws -> [CostSnapshot] { [] }

    func search(workspace: WorkspaceID, query: String) async throws -> [Message] {
        messages.filter { $0.body?.contains(query) == true }
    }

    func setTyping(channel: ChannelID, isTyping: Bool) async {}

    func editMessage(_ id: MessageID, body: String) async throws -> Message {
        throw BackendError.notConnected
    }

    func addReaction(_ id: MessageID, emoji: String) async throws {}

    func pendingApprovals(workspace: WorkspaceID, status: ApprovalStatus) async throws -> [Approval] { [] }

    func decideApproval(_ request: ApprovalDecisionRequest) async throws -> ApprovalDecisionReceipt {
        throw BackendError.notConnected
    }
}

private actor RecordingDecisionChatBackend: ChatBackend {
    private var decisions: [ApprovalDecisionRequest] = []
    private var pending: [Approval]

    init(pending: [Approval] = []) {
        self.pending = pending
    }

    func recordedDecisionRequests() -> [ApprovalDecisionRequest] {
        decisions
    }

    func connect(workspace: WorkspaceID, accessToken: String) async throws {}

    func sendOptimistic(_ draft: DraftMessage, clientMsgId: UUID) async throws -> Message {
        throw BackendError.notConnected
    }

    func subscribe(channel: ChannelID) async throws -> AsyncStream<RealtimeEvent> {
        AsyncStream { continuation in continuation.finish() }
    }

    func history(channel: ChannelID, after seq: Int64?, limit: Int) async throws -> [Message] {
        []
    }

    func presence(channel: ChannelID) async throws -> [PresenceEntry] {
        []
    }

    func members(workspace: WorkspaceID) async throws -> [Member] {
        []
    }

    func channels(workspace: WorkspaceID) async throws -> [Channel] {
        []
    }

    func costSnapshots(channel: ChannelID) async throws -> [CostSnapshot] {
        []
    }

    func search(workspace: WorkspaceID, query: String) async throws -> [Message] {
        []
    }

    func setTyping(channel: ChannelID, isTyping: Bool) async {}

    func editMessage(_ id: MessageID, body: String) async throws -> Message {
        throw BackendError.notConnected
    }

    func addReaction(_ id: MessageID, emoji: String) async throws {}

    func pendingApprovals(workspace: WorkspaceID, status: ApprovalStatus) async throws -> [Approval] {
        pending.filter { $0.workspaceId == workspace && $0.status == status }
    }

    func decideApproval(_ request: ApprovalDecisionRequest) async throws -> ApprovalDecisionReceipt {
        decisions.append(request)
        return ApprovalDecisionReceipt(
            approvalId: request.approvalId,
            status: request.status,
            decisionReason: request.reason
        )
    }
}

private actor FailingDecisionAgentTransport: AgentTransport {
    private var decisionCalls = 0

    func decisionCallCount() -> Int {
        decisionCalls
    }

    func observe(agent: MemberID, channel: ChannelID) async throws -> AsyncStream<AgentEvent> {
        AsyncStream { continuation in continuation.finish() }
    }

    func invoke(
        agent: MemberID,
        channel: ChannelID,
        prompt: String,
        idempotencyKey: UUID
    ) async throws -> RunID {
        throw BackendError.notConnected
    }

    func decideApproval(_ id: ApprovalID, approve: Bool, reason: String?) async throws {
        decisionCalls += 1
        throw BackendError.problem(status: 500, title: "unexpected agent decision path", detail: nil)
    }

    func cancelRun(_ id: RunID) async throws {}
}

private actor FixtureRealtimeChatBackend: ChatBackend {
    private let workspace: WorkspaceID
    private let storedMembers: [Member]
    private let storedChannels: [Channel]
    private let storedHistory: [ChannelID: [Message]]
    private let storedEvents: [RealtimeEvent]

    init(
        workspace: WorkspaceID,
        members: [Member],
        channels: [Channel],
        history: [ChannelID: [Message]],
        events: [RealtimeEvent]
    ) {
        self.workspace = workspace
        self.storedMembers = members
        self.storedChannels = channels
        self.storedHistory = history
        self.storedEvents = events
    }

    func connect(workspace: WorkspaceID, accessToken: String) async throws {}

    func sendOptimistic(_ draft: DraftMessage, clientMsgId: UUID) async throws -> Message {
        throw BackendError.notConnected
    }

    func subscribe(channel: ChannelID) async throws -> AsyncStream<RealtimeEvent> {
        let events = storedEvents
        return AsyncStream { continuation in
            Task {
                for event in events {
                    continuation.yield(event)
                    try? await Task.sleep(for: .milliseconds(5))
                }
                continuation.finish()
            }
        }
    }

    func history(channel: ChannelID, after seq: Int64?, limit: Int) async throws -> [Message] {
        let messages = (storedHistory[channel] ?? []).filter { message in
            guard let seq else { return true }
            return (message.seq ?? 0) > seq
        }
        return Array(messages.prefix(limit))
    }

    func presence(channel: ChannelID) async throws -> [PresenceEntry] { [] }

    func members(workspace: WorkspaceID) async throws -> [Member] {
        storedMembers.filter { $0.workspaceId == workspace }
    }

    func channels(workspace: WorkspaceID) async throws -> [Channel] {
        storedChannels.filter { $0.workspaceId == workspace }
    }

    func costSnapshots(channel: ChannelID) async throws -> [CostSnapshot] { [] }

    func search(workspace: WorkspaceID, query: String) async throws -> [Message] {
        storedHistory.values.flatMap { $0 }.filter { $0.body?.contains(query) == true }
    }

    func setTyping(channel: ChannelID, isTyping: Bool) async {}

    func editMessage(_ id: MessageID, body: String) async throws -> Message {
        throw BackendError.notConnected
    }

    func addReaction(_ id: MessageID, emoji: String) async throws {}

    func pendingApprovals(workspace: WorkspaceID, status: ApprovalStatus) async throws -> [Approval] { [] }

    func decideApproval(_ request: ApprovalDecisionRequest) async throws -> ApprovalDecisionReceipt {
        throw BackendError.notConnected
    }
}

private actor RecordingRealtimeSubscriptionDriver: RealtimeSubscriptionDriver, RealtimeStatusProvidingDriver {
    private let events: [RealtimeEvent]
    private let statuses: [RealtimeConnectionStatus]
    private var starts: [Int64] = []
    private var statusSubscriptions = 0

    init(events: [RealtimeEvent], statuses: [RealtimeConnectionStatus] = []) {
        self.events = events
        self.statuses = statuses
    }

    func subscribe(
        channel: ChannelID,
        startingAfter lastAppliedSeq: Int64,
        backfill: @escaping RealtimeBackfill
    ) async throws -> AsyncStream<RealtimeEvent> {
        starts.append(lastAppliedSeq)
        return AsyncStream { continuation in
            for event in events {
                continuation.yield(event)
            }
            continuation.finish()
        }
    }

    func startingSeqs() -> [Int64] {
        starts
    }

    func realtimeStatus(channel: ChannelID) async -> AsyncStream<RealtimeConnectionStatus> {
        statusSubscriptions += 1
        let selectedStatuses = statuses.filter { $0.channelId == channel }
        return AsyncStream { continuation in
            for status in selectedStatuses {
                continuation.yield(status)
            }
            continuation.finish()
        }
    }

    func statusSubscriptionCount() -> Int {
        statusSubscriptions
    }
}

private extension Array where Element == RealtimeEvent {
    var messageSeqs: [Int64] {
        compactMap { event in
            guard case .message(let message) = event else { return nil }
            return message.seq
        }
    }
}

private struct MockHTTPResponse {
    let statusCode: Int
    let json: String

    init(statusCode: Int = 200, json: String) {
        self.statusCode = statusCode
        self.json = json
    }
}

private final class SynchronizedCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    func increment() -> Int {
        lock.withLock {
            value += 1
            return value
        }
    }
}

private final class MockHTTPURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) throws -> MockHTTPResponse

    nonisolated(unsafe) private static var handler: Handler?
    nonisolated(unsafe) private static var seenRequests: [URLRequest] = []
    nonisolated(unsafe) private static var lock = NSLock()

    static func reset() async {
        lock.withLock {
            handler = nil
            seenRequests = []
        }
    }

    static func setHandler(_ newHandler: @escaping Handler) async {
        lock.withLock {
            handler = newHandler
        }
    }

    static func requests() async -> [URLRequest] {
        lock.withLock { seenRequests }
    }

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        let currentHandler: Handler? = Self.lock.withLock {
            Self.seenRequests.append(request)
            return Self.handler
        }
        guard let currentHandler else {
            client?.urlProtocol(self, didFailWithError: BackendError.notConnected)
            return
        }

        do {
            let mocked = try currentHandler(request)
            let data = Data(mocked.json.utf8)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: mocked.statusCode,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private extension URLSessionConfiguration {
    static var momoMocked: URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockHTTPURLProtocol.self]
        return configuration
    }
}

private extension URLRequest {
    var momoBodyData: Data? {
        if let httpBody {
            return httpBody
        }
        guard let httpBodyStream else {
            return nil
        }
        httpBodyStream.open()
        defer { httpBodyStream.close() }

        var data = Data()
        let bufferSize = 1024
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer { buffer.deallocate() }
        while httpBodyStream.hasBytesAvailable {
            let count = httpBodyStream.read(buffer, maxLength: bufferSize)
            guard count > 0 else {
                break
            }
            data.append(buffer, count: count)
        }
        return data
    }
}
