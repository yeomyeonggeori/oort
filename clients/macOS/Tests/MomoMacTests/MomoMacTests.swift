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

    // MARK: sidebar shell policy (MOMO-357)

    func testSidebarSeparatesDirectMessagesFromChannels() {
        let workspace = WorkspaceID()
        let general = Channel(id: ChannelID(), workspaceId: workspace, kind: .publicChannel, name: "general")
        let launch = Channel(id: ChannelID(), workspaceId: workspace, kind: .privateChannel, name: "launch")
        let directMessage = Channel(id: ChannelID(), workspaceId: workspace, kind: .dm)
        let archived = Channel(
            id: ChannelID(),
            workspaceId: workspace,
            kind: .publicChannel,
            name: "archive",
            archivedAtMs: 1
        )
        let channelOrder = MomoSidebarPolicy.channelOrder(from: [directMessage, archived, general, launch])

        XCTAssertEqual(channelOrder.standardChannels.map(\.id), [general.id, launch.id])
        XCTAssertEqual(channelOrder.directMessages.map(\.id), [directMessage.id])
        XCTAssertEqual(
            channelOrder.orderedChannels.map(\.id),
            [general.id, launch.id, directMessage.id]
        )
        XCTAssertFalse(channelOrder.orderedChannels.contains { $0.id == archived.id })
    }

    func testServerRosterPresenceRemainsHiddenUntilRealtimePresenceExists() {
        XCTAssertFalse(
            MomoSidebarPolicy.showsRosterPresence(
                usesServerRosterSourceOfTruth: true,
                isActivelyWorking: false
            )
        )
        XCTAssertTrue(
            MomoSidebarPolicy.showsRosterPresence(
                usesServerRosterSourceOfTruth: true,
                isActivelyWorking: true
            )
        )
        XCTAssertTrue(
            MomoSidebarPolicy.showsRosterPresence(
                usesServerRosterSourceOfTruth: false,
                isActivelyWorking: false
            )
        )
    }

    func testSidebarWidthTokensHaveStableResizeOrder() {
        XCTAssertLessThan(MomoTheme.Sidebar.minimumWidth, MomoTheme.Sidebar.idealWidth)
        XCTAssertLessThan(MomoTheme.Sidebar.idealWidth, MomoTheme.Sidebar.maximumWidth)
    }

    func testSidebarMembershipMutationCopyIsLocalizedAndVerbFirst() {
        let korean = MomoWorkspaceCopy(language: .korean)
        XCTAssertEqual(korean.addToChannel, "채널에 추가")
        XCTAssertEqual(korean.removeFromChannel, "채널에서 제거")

        let english = MomoWorkspaceCopy(language: .english)
        XCTAssertEqual(english.addToChannel, "Add to channel")
        XCTAssertEqual(english.removeFromChannel, "Remove from channel")
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

    func testLiveChatBackendMentionFallbackRespondsToHermesAlias() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        try await backend.connect(workspace: seed.workspace, accessToken: "t")
        let channel = seed.channels[0].id
        let agent = try XCTUnwrap(seed.agents.first { $0.handle == "hermes" })

        _ = try await backend.sendOptimistic(
            DraftMessage(channelId: channel, type: .text, body: "@Hermes 오늘 상태 알려줘"),
            clientMsgId: UUID()
        )
        _ = try await backend.sendOptimistic(
            DraftMessage(channelId: channel, type: .text, body: "@hermes summarize the channel"),
            clientMsgId: UUID()
        )

        let history = try await backend.history(channel: channel, after: nil, limit: 50)
        let finals = history.filter { message in
            message.authorMemberId == agent.id
                && message.runId != nil
                && (message.body?.contains("mention received") == true)
        }
        XCTAssertEqual(finals.count, 2)
        XCTAssertTrue(finals.allSatisfy { $0.props["mention_handle"]?.stringValue == "hermes" })
        XCTAssertTrue(finals.contains { $0.body?.contains("@Hermes") == true })
        XCTAssertTrue(finals.contains { $0.body?.contains("@hermes") == true })
    }

    @MainActor
    func testViewModelInsertsAgentMentionFromRoster() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "t")
        await viewModel.selectChannel(seed.channels[0].id)

        let agent = try XCTUnwrap(seed.agents.first { $0.handle == "hermes" })
        XCTAssertTrue(viewModel.canInsertMention(for: agent))
        viewModel.insertMention(for: agent)
        XCTAssertEqual(viewModel.composerDraft, "@hermes ")
        XCTAssertEqual(viewModel.mentionNotice, "Hermes mention inserted.")

        viewModel.insertMention(for: agent, preferDisplayName: true)
        XCTAssertEqual(viewModel.composerDraft, "@hermes @Hermes ")
    }

    @MainActor
    func testDogfoodHermesInviteRevealsAgentForMention() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "t")
        let channel = seed.channels[0].id
        await viewModel.selectChannel(channel)

        let agent = try XCTUnwrap(seed.agents.first { $0.handle == "hermes" })
        await viewModel.removeMember(agent.id, from: channel)
        XCTAssertFalse(viewModel.isMember(agent.id, in: channel))

        let invited = try await viewModel.inviteDogfoodAgent(
            displayName: "Hermes Local",
            handle: "@hermes",
            avatarPath: nil
        )

        XCTAssertTrue(invited.isAgent)
        XCTAssertEqual(viewModel.member(invited.id)?.displayName, "Hermes Local")
        XCTAssertTrue(viewModel.isMember(invited.id, in: channel))
        XCTAssertTrue(viewModel.canInsertMention(for: invited))

        viewModel.insertMention(for: invited)
        XCTAssertEqual(viewModel.composerDraft, "@hermes ")
    }

    @MainActor
    func testLocalProfileDraftUpdatesRosterAndMentionCandidates() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "t")
        let channel = seed.channels[0].id
        await viewModel.selectChannel(channel)

        let agent = try XCTUnwrap(seed.agents.first { $0.handle == "hermes" })
        viewModel.applyLocalProfile(
            member: agent.id,
            displayName: "Hermes Local",
            avatarPath: "",
            presence: .working
        )

        let updated = try XCTUnwrap(viewModel.member(agent.id))
        XCTAssertEqual(updated.displayName, "Hermes Local")
        XCTAssertEqual(updated.presence, .working)

        viewModel.composerDraft = "@local"
        XCTAssertEqual(viewModel.mentionAutocompleteCandidates().first?.displayName, "Hermes Local")
    }

    @MainActor
    func testMentionAutocompleteUsesOnlyInvitedChannelMembers() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "t")
        let channel = seed.channels[0].id
        await viewModel.selectChannel(channel)

        let agent = try XCTUnwrap(seed.agents.first { $0.handle == "hermes" })
        await viewModel.removeMember(agent.id, from: channel)
        viewModel.composerDraft = "@he"
        XCTAssertFalse(viewModel.mentionAutocompleteCandidates().contains { $0.id == agent.id })

        let invited = try await viewModel.inviteDogfoodAgent(
            displayName: "Hermes Local",
            handle: "@hermes",
            avatarPath: nil
        )
        viewModel.composerDraft = "@he"

        let candidates = viewModel.mentionAutocompleteCandidates()
        XCTAssertEqual(candidates.first?.id, invited.id)

        viewModel.completeMentionAutocomplete(with: invited)
        XCTAssertEqual(viewModel.composerDraft, "@hermes ")
        XCTAssertEqual(viewModel.mentionNotice, "Hermes Local mention inserted.")
    }

    @MainActor
    func testManualAgentMentionRequiresChannelMembership() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "t")
        let channel = seed.channels[0].id
        await viewModel.selectChannel(channel)

        let agent = try XCTUnwrap(seed.agents.first { $0.handle == "hermes" })
        await viewModel.removeMember(agent.id, from: channel)
        XCTAssertFalse(viewModel.isMember(agent.id, in: channel))

        await viewModel.send(body: "@hermes hi before invite", to: channel)

        XCTAssertFalse(viewModel.isAgentWorking(agent, in: channel))
        XCTAssertFalse(viewModel.visibleWorkingAgents.contains { $0.id == agent.id })
        XCTAssertFalse(viewModel.visibleMessages.contains { message in
            message.authorMemberId == agent.id && (message.body?.contains("mock reply") == true)
        })
    }

    @MainActor
    func testAgentStatusAndFinalMessageDriveWorkingIndicator() async throws {
        let workspace = WorkspaceID()
        let channel = ChannelID()
        let human = MemberID()
        let agent = MemberID()
        let run = RunID()
        let statusOnlyBackend = FixtureRealtimeChatBackend(
            workspace: workspace,
            members: [
                Member(id: human, workspaceId: workspace, kind: .human, displayName: "Human", handle: "human", channelIds: [channel]),
                Member(id: agent, workspaceId: workspace, kind: .agent, displayName: "Hermes", handle: "hermes", channelIds: [channel]),
            ],
            channels: [
                Channel(id: channel, workspaceId: workspace, kind: .publicChannel, name: "general", createdBy: human),
            ],
            history: [channel: []],
            events: [
                .agentStatus(AgentStatus(
                    runId: run,
                    agentMemberId: agent,
                    channelId: channel,
                    phase: .thinking,
                    runStatus: .running
                )),
                .agentPartial(AgentPartial(
                    runId: run,
                    channelId: channel,
                    textDelta: "gateway streaming preview"
                )),
            ]
        )
        let viewModel = ChatViewModel(chat: statusOnlyBackend, agentTransport: FailingDecisionAgentTransport())

        await viewModel.bootstrap(workspace: workspace, accessToken: "token")
        await viewModel.selectChannel(channel)
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertTrue(viewModel.isAgentWorking(try XCTUnwrap(viewModel.member(agent))))
        XCTAssertEqual(
            viewModel.partials[run]?.textDelta,
            "gateway streaming preview",
            "AgentPartialView source state must receive the gateway delta"
        )

        let final = Message(
            id: MessageID(),
            channelId: channel,
            seq: 2,
            hlcTs: 2,
            authorMemberId: agent,
            type: .text,
            body: "Hermes response",
            runId: run
        )
        let finalBackend = FixtureRealtimeChatBackend(
            workspace: workspace,
            members: [
                Member(id: human, workspaceId: workspace, kind: .human, displayName: "Human", handle: "human", channelIds: [channel]),
                Member(id: agent, workspaceId: workspace, kind: .agent, displayName: "Hermes", handle: "hermes", channelIds: [channel]),
            ],
            channels: [
                Channel(id: channel, workspaceId: workspace, kind: .publicChannel, name: "general", createdBy: human),
            ],
            history: [channel: []],
            events: [
                .agentStatus(AgentStatus(
                    runId: run,
                    agentMemberId: agent,
                    channelId: channel,
                    phase: .thinking,
                    runStatus: .running
                )),
                .message(final),
            ]
        )
        let finalViewModel = ChatViewModel(chat: finalBackend, agentTransport: FailingDecisionAgentTransport())
        await finalViewModel.bootstrap(workspace: workspace, accessToken: "token")
        await finalViewModel.selectChannel(channel)
        try await Task.sleep(for: .milliseconds(80))
        XCTAssertFalse(finalViewModel.isAgentWorking(try XCTUnwrap(finalViewModel.member(agent))))
        XCTAssertTrue(finalViewModel.visibleWorkingAgents.isEmpty)
    }

    @MainActor
    func testApprovalRequestDoesNotClearAgentWorkingIndicator() async throws {
        let workspace = WorkspaceID()
        let channel = ChannelID()
        let human = MemberID()
        let agent = MemberID()
        let run = RunID()
        let approval = Message(
            id: MessageID(),
            channelId: channel,
            seq: 2,
            hlcTs: 2,
            authorMemberId: agent,
            type: .approvalRequest,
            body: "Approve GitHub issue creation?",
            props: .object(["approval_id": .string(ApprovalID().description)]),
            runId: run
        )
        let backend = FixtureRealtimeChatBackend(
            workspace: workspace,
            members: [
                Member(id: human, workspaceId: workspace, kind: .human, displayName: "Human", handle: "human", channelIds: [channel]),
                Member(id: agent, workspaceId: workspace, kind: .agent, displayName: "Hermes", handle: "hermes", channelIds: [channel]),
            ],
            channels: [
                Channel(id: channel, workspaceId: workspace, kind: .publicChannel, name: "general", createdBy: human),
            ],
            history: [channel: []],
            events: [
                .agentStatus(AgentStatus(
                    runId: run,
                    agentMemberId: agent,
                    channelId: channel,
                    phase: .thinking,
                    runStatus: .running
                )),
                .message(approval),
            ]
        )
        let viewModel = ChatViewModel(chat: backend, agentTransport: FailingDecisionAgentTransport())

        await viewModel.bootstrap(workspace: workspace, accessToken: "token")
        await viewModel.selectChannel(channel)
        try await Task.sleep(for: .milliseconds(80))

        XCTAssertTrue(viewModel.isAgentWorking(try XCTUnwrap(viewModel.member(agent))))
        XCTAssertEqual(viewModel.agentStatuses[run]?.runStatus, .awaitingApproval)
    }

    @MainActor
    func testRealtimeTypingEventDrivesVisibleTypingIndicator() async throws {
        let workspace = WorkspaceID()
        let channel = ChannelID()
        let human = MemberID()
        let teammate = MemberID()
        let backend = FixtureRealtimeChatBackend(
            workspace: workspace,
            members: [
                Member(id: human, workspaceId: workspace, kind: .human, displayName: "Human", handle: "human", channelIds: [channel]),
                Member(id: teammate, workspaceId: workspace, kind: .human, displayName: "Dana", handle: "dana", channelIds: [channel]),
            ],
            channels: [
                Channel(id: channel, workspaceId: workspace, kind: .publicChannel, name: "general", createdBy: human),
            ],
            history: [channel: []],
            events: [
                .typing(TypingDelta(channelId: channel, memberId: teammate, isTyping: true)),
            ]
        )
        let viewModel = ChatViewModel(chat: backend, agentTransport: FailingDecisionAgentTransport())

        await viewModel.bootstrap(workspace: workspace, accessToken: "token")
        await viewModel.selectChannel(channel)
        try await Task.sleep(for: .milliseconds(40))

        XCTAssertEqual(viewModel.visibleTypingMembers.map(\.displayName), ["Dana"])
    }

    @MainActor
    func testComposerDraftPublishesLocalTypingIndicator() async throws {
        let workspace = WorkspaceID()
        let channel = ChannelID()
        let human = MemberID()
        let backend = FixtureRealtimeChatBackend(
            workspace: workspace,
            members: [
                Member(id: human, workspaceId: workspace, kind: .human, displayName: "Human", handle: "human", channelIds: [channel]),
            ],
            channels: [
                Channel(id: channel, workspaceId: workspace, kind: .publicChannel, name: "general", createdBy: human),
            ],
            history: [channel: []],
            events: []
        )
        let viewModel = ChatViewModel(chat: backend, agentTransport: FailingDecisionAgentTransport())

        await viewModel.bootstrap(workspace: workspace, accessToken: "token")
        await viewModel.selectChannel(channel)
        viewModel.composerDraft = "hello"
        viewModel.composerDraftDidChange(viewModel.composerDraft)
        try await Task.sleep(for: .milliseconds(20))

        XCTAssertEqual(viewModel.visibleTypingMembers.map(\.id), [human])
        let startedTypingCalls = await backend.typingCalls()
        XCTAssertEqual(startedTypingCalls.map { $0.isTyping }, [true])

        viewModel.composerDraft = ""
        viewModel.composerDraftDidChange(viewModel.composerDraft)
        try await Task.sleep(for: .milliseconds(20))

        XCTAssertTrue(viewModel.visibleTypingMembers.isEmpty)
        let finishedTypingCalls = await backend.typingCalls()
        XCTAssertEqual(finishedTypingCalls.map { $0.isTyping }, [true, false])
    }

    @MainActor
    func testLocalTypingTimeoutsAreScopedPerChannel() async throws {
        let workspace = WorkspaceID()
        let firstChannel = ChannelID()
        let secondChannel = ChannelID()
        let human = MemberID()
        let backend = FixtureRealtimeChatBackend(
            workspace: workspace,
            members: [
                Member(
                    id: human,
                    workspaceId: workspace,
                    kind: .human,
                    displayName: "Human",
                    handle: "human",
                    channelIds: [firstChannel, secondChannel]
                ),
            ],
            channels: [
                Channel(id: firstChannel, workspaceId: workspace, kind: .publicChannel, name: "general", createdBy: human),
                Channel(id: secondChannel, workspaceId: workspace, kind: .publicChannel, name: "agent-lab", createdBy: human),
            ],
            history: [firstChannel: [], secondChannel: []],
            events: []
        )
        let viewModel = ChatViewModel(chat: backend, agentTransport: FailingDecisionAgentTransport())

        await viewModel.bootstrap(workspace: workspace, accessToken: "token")
        await viewModel.selectChannel(firstChannel)
        viewModel.composerDraft = "first"
        viewModel.composerDraftDidChange(viewModel.composerDraft)
        await viewModel.selectChannel(secondChannel)
        viewModel.composerDraft = "second"
        viewModel.composerDraftDidChange(viewModel.composerDraft)

        try await Task.sleep(for: .milliseconds(2_250))

        let calls = await backend.typingCalls()
        XCTAssertTrue(calls.contains { $0.channel == firstChannel && $0.isTyping })
        XCTAssertTrue(calls.contains { $0.channel == secondChannel && $0.isTyping })
        XCTAssertTrue(calls.contains { $0.channel == firstChannel && !$0.isTyping })
        XCTAssertTrue(calls.contains { $0.channel == secondChannel && !$0.isTyping })
        XCTAssertTrue(viewModel.visibleTypingMembers.isEmpty)
    }

    @MainActor
    func testDogfoodHermesInviteRejectsAliasBeforeServerAliasSupport() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "t")
        await viewModel.selectChannel(seed.channels[0].id)

        do {
            _ = try await viewModel.inviteDogfoodAgent(
                displayName: "Hermes",
                handle: "@helper",
                avatarPath: nil
            )
            XCTFail("Expected non-hermes alias to be rejected in dogfood v0")
        } catch let error as DogfoodAgentInviteError {
            guard case .unsupportedAlias = error else {
                return XCTFail("Unexpected dogfood invite error: \(error)")
            }
        }
    }

    func testAgentPairingManifestExcludesProviderSecrets() throws {
        let workspace = WorkspaceID()
        let channel = ChannelID()
        let manifest = MomoAgentPairingManifest.make(
            displayName: "Hermes",
            handle: "@hermes",
            endpoint: "http://127.0.0.1:28188/v1",
            modelLabel: "gpt-oauth-provider",
            permissionScope: .channelReadReplyApprovalTools,
            workspaceID: workspace,
            channelID: channel,
            apiURL: "http://127.0.0.1:28180",
            generatedAtMs: 123
        )

        let json = manifest.prettyJSONString
        XCTAssertTrue(json.contains("\"schema\" : \"momo.agent_pairing_manifest.v0\""))
        XCTAssertTrue(json.contains("\"handle\" : \"hermes\""))
        XCTAssertTrue(json.contains("MOMO_AGENT_TOKEN"))
        XCTAssertFalse(json.contains("MOMO_AGENT_GATEWAY_SECRET"))
        XCTAssertFalse(json.contains("MOMO_AGENT_TOKEN="))
        XCTAssertFalse(json.localizedCaseInsensitiveContains("oauth_token"))
        XCTAssertFalse(json.localizedCaseInsensitiveContains("refresh_token"))
        XCTAssertFalse(json.localizedCaseInsensitiveContains("openai_api_key"))
        XCTAssertFalse(json.contains("OPENAI_API_KEY"))
        XCTAssertFalse(json.contains("HERMES_API_KEY"))
        XCTAssertTrue(manifest.inviteCode.hasPrefix("momo-agent-"))
    }

    func testAgentCredentialDisplayStatusUsesOnlyConfiguredActiveExpiringRevoked() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let agent = MemberID()
        let base = MomoAgentCredential(
            id: UUID(),
            agentMemberId: agent,
            serverStatus: "active",
            scopes: ["messages:write"],
            label: "Hermes gateway",
            lastUsedAtMs: nil,
            expiresAtMs: nil,
            revokedAtMs: nil,
            createdAtMs: 1_700_000_000_000
        )

        XCTAssertEqual(base.displayStatus(now: now), .configured)

        var active = base
        active.lastUsedAtMs = 1_799_000_000_000
        XCTAssertEqual(active.displayStatus(now: now), .active)

        var expiring = active
        expiring.expiresAtMs = Int64(now.addingTimeInterval(24 * 60 * 60).timeIntervalSince1970 * 1_000)
        XCTAssertEqual(expiring.displayStatus(now: now), .expiring)

        var revoked = active
        revoked.serverStatus = "revoked"
        revoked.revokedAtMs = Int64(now.timeIntervalSince1970 * 1_000)
        XCTAssertEqual(revoked.displayStatus(now: now), .revoked)
    }

    @MainActor
    func testMockBackendAgentCredentialIssueRotateAndRevokeFlow() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "t")
        await viewModel.selectChannel(seed.channels[0].id)
        let agent = try XCTUnwrap(seed.agents.first { $0.handle == "hermes" })

        let first = try await viewModel.issueAgentCredential(for: agent.id)
        XCTAssertFalse(first.token.isEmpty)
        XCTAssertEqual(first.rotatedCredentialCount, 0)
        XCTAssertEqual(viewModel.agentCredentials(for: agent.id).map { $0.displayStatus() }, [.configured])

        let second = try await viewModel.issueAgentCredential(for: agent.id)
        XCTAssertFalse(second.token.isEmpty)
        XCTAssertNotEqual(first.token, second.token)
        XCTAssertEqual(second.rotatedCredentialCount, 1)
        XCTAssertNotNil(second.rotationGraceEndsAtMs)

        let afterRotation = viewModel.agentCredentials(for: agent.id)
        XCTAssertEqual(afterRotation.count, 2)
        XCTAssertEqual(afterRotation.first(where: { $0.id == first.credential.id })?.displayStatus(), .expiring)
        XCTAssertEqual(afterRotation.first(where: { $0.id == second.credential.id })?.displayStatus(), .configured)

        try await viewModel.revokeAgentCredential(second.credential.id, for: agent.id)
        XCTAssertEqual(
            viewModel.agentCredentials(for: agent.id)
                .first(where: { $0.id == second.credential.id })?
                .displayStatus(),
            .revoked
        )
    }

    @MainActor
    func testAgentCredentialIssueRefreshesAfterAnOlderListRequest() async throws {
        let workspace = WorkspaceID()
        let agent = MemberID()
        let backend = ControlledCredentialRefreshBackend(agent: agent)
        let viewModel = ChatViewModel(chat: backend, agentTransport: backend)
        await viewModel.bootstrap(workspace: workspace, accessToken: "fixture-access")

        let olderRefresh = Task {
            try await viewModel.refreshAgentCredentials(for: agent)
        }
        await backend.waitForListCallCount(1)

        let issue = Task {
            try await viewModel.issueAgentCredential(for: agent)
        }
        await backend.waitForIssueCallCount(1)

        await backend.releaseNextListCall()
        await backend.waitForListCallCount(2)
        await backend.releaseNextListCall()

        try await olderRefresh.value
        let reveal = try await issue.value
        let listCallCount = await backend.listCallCount()
        XCTAssertEqual(listCallCount, 2)
        XCTAssertEqual(viewModel.agentCredentials(for: agent).map(\.id), [reveal.credential.id])
        XCTAssertFalse(viewModel.isLoadingAgentCredentials(for: agent))
    }

    @MainActor
    func testChannelHistoryLoadingStateCoversAwaitedHistoryRequest() async {
        let workspace = WorkspaceID()
        let channel = ChannelID()
        let member = MemberID()
        let backend = ControlledCredentialRefreshBackend(agent: member)
        let viewModel = ChatViewModel(chat: backend, agentTransport: backend)
        viewModel.setChannels([
            Channel(
                id: channel,
                workspaceId: workspace,
                kind: .publicChannel,
                name: "release-room",
                createdBy: member
            ),
        ])

        let selection = Task { await viewModel.selectChannel(channel) }
        await backend.waitForHistoryCallCount(1)

        XCTAssertTrue(viewModel.isSelectedChannelHistoryLoading)
        await backend.releaseNextHistoryCall()
        await selection.value
        XCTAssertFalse(viewModel.isSelectedChannelHistoryLoading)
    }

    func testAgentPairingEndpointPolicyFailsClosedForNonLoopbackHTTP() {
        let blocked = MomoAgentPairingSecurity.endpointPolicy(
            "http://192.168.0.2:28188/v1",
            allowNonLoopbackHTTP: false
        )
        XCTAssertFalse(blocked.isAllowed)
        XCTAssertTrue(blocked.requiresExplicitOptIn)

        let optedIn = MomoAgentPairingSecurity.endpointPolicy(
            "http://192.168.0.2:28188/v1",
            allowNonLoopbackHTTP: true
        )
        XCTAssertTrue(optedIn.isAllowed)
        XCTAssertFalse(optedIn.isLoopback)

        let loopback = MomoAgentPairingSecurity.endpointPolicy(
            "http://localhost:28188/v1",
            allowNonLoopbackHTTP: false
        )
        XCTAssertTrue(loopback.isAllowed)
        XCTAssertTrue(loopback.isLoopback)
    }

    func testAgentPairingEndpointPolicyRejectsCredentialBearingURLs() {
        let userInfo = MomoAgentPairingSecurity.endpointPolicy(
            "https://token@example.com/v1",
            allowNonLoopbackHTTP: true
        )
        XCTAssertFalse(userInfo.isAllowed)
        XCTAssertNil(userInfo.sanitizedEndpoint)

        let querySecret = MomoAgentPairingSecurity.endpointPolicy(
            "http://127.0.0.1:28188/v1?api_key=secret#token",
            allowNonLoopbackHTTP: false
        )
        XCTAssertFalse(querySecret.isAllowed)
        XCTAssertNil(querySecret.sanitizedEndpoint)

        let manifest = MomoAgentPairingManifest.make(
            displayName: "Hermes",
            handle: "@hermes",
            endpoint: "https://token@example.com/v1?api_key=secret",
            modelLabel: "gpt-oauth-provider",
            permissionScope: .channelReadReply,
            workspaceID: WorkspaceID(),
            channelID: ChannelID(),
            apiURL: "http://127.0.0.1:28180",
            generatedAtMs: 123
        )
        let json = manifest.prettyJSONString
        XCTAssertFalse(json.contains("token@example.com"))
        XCTAssertFalse(json.contains("api_key=secret"))
        XCTAssertEqual(manifest.runtime.endpoint, "invalid-endpoint")
    }

    func testAgentPairingInviteCodeIsStableAcrossGenerationTime() {
        let workspace = WorkspaceID()
        let channel = ChannelID()
        let first = MomoAgentPairingManifest.make(
            displayName: "Hermes",
            handle: "@hermes",
            endpoint: "http://127.0.0.1:28188/v1",
            modelLabel: "gpt-oauth-provider",
            permissionScope: .channelReadReply,
            workspaceID: workspace,
            channelID: channel,
            apiURL: "http://127.0.0.1:28180",
            generatedAtMs: 123
        )
        let second = MomoAgentPairingManifest.make(
            displayName: "Hermes",
            handle: "@hermes",
            endpoint: "http://127.0.0.1:28188/v1",
            modelLabel: "gpt-oauth-provider",
            permissionScope: .channelReadReply,
            workspaceID: workspace,
            channelID: channel,
            apiURL: "http://127.0.0.1:28180",
            generatedAtMs: 456
        )
        XCTAssertEqual(first.inviteCode, second.inviteCode)
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
        XCTAssertFalse(viewModel.isAgentWorking(try XCTUnwrap(viewModel.member(agent)), in: channel))
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

    func testAlphaUpdateChannelDefaultsToNotConfiguredUntilManifestExists() {
        let status = MomoMacUpdateChannelStatus.fromEnvironment([:])

        XCTAssertEqual(status.channel, .alpha)
        XCTAssertEqual(status.engine, .localManifest)
        XCTAssertEqual(status.state, .notConfigured)
        XCTAssertFalse(status.hasUpdate)
        XCTAssertTrue(status.surfaceDetail.contains("MOMO_UPDATE_MANIFEST"))
    }

    func testAlphaUpdateChannelReadsLocalManifestAndShowsAvailableUpdate() throws {
        let fixture = updateManifestFixturePath()
        let status = MomoMacUpdateChannelStatus.fromEnvironment([
            "MOMO_UPDATE_CHANNEL": "alpha",
            "MOMO_CURRENT_VERSION": "0.4.4-alpha.1",
            "MOMO_CURRENT_BUILD": "230",
            "MOMO_UPDATE_MANIFEST_PATH": fixture,
        ])

        XCTAssertEqual(status.state, .updateAvailable)
        XCTAssertTrue(status.hasUpdate)
        XCTAssertTrue(status.canOpenDownload)
        XCTAssertEqual(status.availableVersion?.version, "0.4.5-alpha.2")
        XCTAssertEqual(status.availableVersion?.build, "244")
        XCTAssertEqual(status.manifest?.installSteps.count, 3)
        XCTAssertTrue(try XCTUnwrap(status.manifestSource?.displayLabel).hasSuffix("update-manifest-alpha-v0.json"))
    }

    func testAlphaUpdateChannelTreatsMatchingFileURLManifestAsUpToDate() throws {
        let fixtureURL = URL(fileURLWithPath: updateManifestFixturePath())
        let status = MomoMacUpdateChannelStatus.fromEnvironment([
            "MOMO_CURRENT_VERSION": "0.4.5-alpha.2",
            "MOMO_CURRENT_BUILD": "244",
            "MOMO_UPDATE_MANIFEST_URL": fixtureURL.absoluteString,
        ])

        XCTAssertEqual(status.state, .upToDate)
        XCTAssertFalse(status.hasUpdate)
        XCTAssertEqual(status.availableVersion?.displayLabel, "0.4.5-alpha.2 (244)")
    }

    func testAlphaUpdateChannelFlagsUnsupportedManifestSourceAndPrivateKeyLookingConfig() {
        let status = MomoMacUpdateChannelStatus.fromEnvironment([
            "MOMO_UPDATE_MANIFEST_URL": "https://updates.example.com/momo/alpha/update.json",
            "MOMO_UPDATE_PUBLIC_ED_KEY": "PRIVATE KEY SHOULD NOT BE HERE",
        ])

        XCTAssertEqual(status.state, .failed)
        XCTAssertEqual(status.diagnostics.count, 2)
        XCTAssertTrue(status.diagnostics.contains("Only Sparkle EdDSA public keys belong in app/runtime config."))
        XCTAssertTrue(status.diagnostics.contains { $0.contains("Only local paths and file:// update manifests") })
    }

    private func updateManifestFixturePath() -> String {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/update-manifest-alpha-v0.json")
            .path
    }

    @MainActor
    func testAlphaCommandCenterSnapshotCoversInternalAlphaSurfaces() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "t")
        await viewModel.selectChannel(seed.channels[0].id)

        let snapshot = viewModel.alphaCommandCenterSnapshot(updateStatus: .fromEnvironment([:]))
        let areas = Set(snapshot.statuses.map(\.area))

        XCTAssertEqual(areas, Set(AlphaCommandCenterArea.allCases))
        XCTAssertEqual(snapshot.statuses.first { $0.area == .server }?.health, .ready)
        XCTAssertEqual(snapshot.statuses.first { $0.area == .agentRuntime }?.health, .ready)
        XCTAssertEqual(snapshot.statuses.first { $0.area == .providerSetup }?.health, .working)
        XCTAssertEqual(snapshot.statuses.first { $0.area == .diagnostics }?.health, .ready)
        XCTAssertEqual(snapshot.statuses.first { $0.area == .updates }?.health, .planned)
        XCTAssertTrue(snapshot.checklist.contains { $0.id == "mention-hermes" && $0.state == .ready })
        XCTAssertTrue(snapshot.checklist.contains { $0.id == "credentialed-hermes" && $0.state == .ready })
        XCTAssertTrue(snapshot.capabilities.contains { $0.id == "diagnostics" && $0.isAvailable })
        XCTAssertTrue(snapshot.capabilities.contains { $0.id == "credential-boundary" && $0.isAvailable })
        XCTAssertTrue(snapshot.limitations.contains { $0.contains("Automatic update install") })
    }

    func testAlphaCommandCenterSnapshotExplainsDegradedStates() {
        let workspace = WorkspaceID.demo
        let channel = Channel(
            id: .demoAgentLab,
            workspaceId: workspace,
            kind: .publicChannel,
            name: "agent-lab",
            createdBy: .demoHuman
        )
        let snapshot = AlphaCommandCenterSnapshot.make(
            workspaceId: workspace,
            channels: [channel],
            selectedChannel: channel,
            selectedRealtimeStatus: RealtimeConnectionStatus(
                channelId: channel.id,
                connection: .error,
                subscription: .error,
                fallback: .restHistory,
                canRetry: true,
                message: "websocket refused"
            ),
            agentRuntimeStatus: AgentRuntimeStatus(
                mode: .externalHermes,
                availability: .degraded,
                endpointLabel: "https://kim.example.net/v1",
                keyConfigured: false,
                diagnostics: ["HERMES_API_KEY missing"]
            ),
            inviteJoinState: .failed(InviteJoinFailure(
                code: "EXPIRED",
                reason: "Invite expired",
                recoveryHint: "Ask an owner for a fresh code."
            )),
            connectionError: "db offline",
            visibleMessageCount: 0,
            pendingApprovalCount: 0,
            liveSpentMicroUSD: 0,
            updateStatus: MomoMacUpdateChannelStatus.fromEnvironment([
                "MOMO_UPDATE_FEED_URL": "not a url",
                "MOMO_UPDATE_PUBLIC_ED_KEY": "PRIVATE KEY SHOULD NOT BE HERE",
            ])
        )

        XCTAssertEqual(snapshot.statuses.first { $0.area == .server }?.health, .degraded)
        XCTAssertEqual(snapshot.statuses.first { $0.area == .realtime }?.health, .degraded)
        XCTAssertEqual(snapshot.statuses.first { $0.area == .agentRuntime }?.health, .degraded)
        XCTAssertEqual(snapshot.statuses.first { $0.area == .providerSetup }?.health, .degraded)
        XCTAssertEqual(snapshot.statuses.first { $0.area == .invites }?.health, .degraded)
        XCTAssertEqual(snapshot.statuses.first { $0.area == .updates }?.health, .degraded)
        XCTAssertGreaterThanOrEqual(snapshot.attentionCount, 5)
        XCTAssertTrue(snapshot.statuses.first { $0.area == .realtime }?.recovery?.contains("Retry") == true)
        XCTAssertTrue(snapshot.statuses.first { $0.area == .invites }?.recovery?.contains("fresh code") == true)
        XCTAssertTrue(snapshot.capabilities.first { $0.id == "agent-runtime" }?.isAvailable == false)
        XCTAssertEqual(snapshot.checklist.first { $0.id == "credentialed-hermes" }?.state, .blocked)
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
                  "realtimeWebSocketUrl": "wss://rt.momo.test/connection/websocket",
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
        let realtimeWebSocketURL = await backend.realtimeWebSocketURL
        XCTAssertEqual(
            realtimeWebSocketURL?.absoluteString,
            "wss://rt.momo.test/connection/websocket"
        )

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
            case ("GET", "/v1/workspaces/\(workspace.description)/roster"):
                return MockHTTPResponse(json: """
                {"members":[{
                  "id":"\(MemberID.demoHuman.description)",
                  "workspaceId":"\(workspace.description)",
                  "kind":"human",
                  "status":"active",
                  "displayName":"데모 사용자",
                  "handle":"demo",
                  "channelIds":["\(ChannelID.demoGeneral.description)"]
                }]}
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

    @MainActor
    func testRealServerRosterDrivesChannelMembersMentionsAndMessageAuthors() async throws {
        await MockHTTPURLProtocol.reset()
        let session = URLSession(configuration: .momoMocked)
        let workspace = WorkspaceID.demo
        let channel = ChannelID.demoGeneral
        let invitedAgent = MemberID(uuidString: "00000000-0000-7000-8000-000000000103")!
        let uninvitedAgent = MemberID.demoAgent
        let messageID = MessageID(uuidString: "00000000-0000-7000-8000-000000354001")!

        await MockHTTPURLProtocol.setHandler { request in
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/v1/workspaces/\(workspace.description)/roster"):
                return MockHTTPResponse(json: """
                {
                  "members": [
                    {
                      "id": "\(MemberID.demoHuman.description)",
                      "workspaceId": "\(workspace.description)",
                      "kind": "human",
                      "status": "active",
                      "displayName": "성재",
                      "handle": "seongjae",
                      "channelIds": ["\(channel.description)"]
                    },
                    {
                      "id": "\(invitedAgent.description)",
                      "workspaceId": "\(workspace.description)",
                      "kind": "agent",
                      "status": "active",
                      "displayName": "Hermes",
                      "handle": "hermes",
                      "channelIds": ["\(channel.description)"]
                    },
                    {
                      "id": "\(uninvitedAgent.description)",
                      "workspaceId": "\(workspace.description)",
                      "kind": "agent",
                      "status": "active",
                      "displayName": "김인턴",
                      "handle": "kim-intern",
                      "channelIds": ["\(ChannelID.demoAgentLab.description)"]
                    }
                  ]
                }
                """)
            case ("GET", "/v1/workspaces/\(workspace.description)/channels"):
                return MockHTTPResponse(json: """
                {"channels":[{
                  "id":"\(channel.description)",
                  "workspaceId":"\(workspace.description)",
                  "kind":"public",
                  "name":"general",
                  "topic":"dogfood",
                  "dmKey":null,
                  "createdBy":"\(MemberID.demoHuman.description)",
                  "archivedAtMs":null
                }]}
                """)
            case ("GET", "/v1/agent-runtime/status"):
                return MockHTTPResponse(json: """
                {"schema":"momo.agent_runtime.status.v0","agentHandle":"hermes","displayName":"Hermes","mode":"gateway","availability":"available","model":"hermes-agent","endpointLabel":"gateway","keyConfigured":true,"diagnostics":[]}
                """)
            case ("GET", "/v1/workspaces/\(workspace.description)/approvals"):
                return MockHTTPResponse(json: #"{"approvals":[]}"#)
            case ("GET", "/v1/workspaces/\(workspace.description)/channels/\(channel.description)/messages"):
                return MockHTTPResponse(json: """
                {"messages":[{
                  "id":"\(messageID.description)",
                  "channelId":"\(channel.description)",
                  "seq":1,
                  "hlcTs":1800000000000,
                  "hlcCount":0,
                  "authorMemberId":"\(invitedAgent.description)",
                  "type":"text",
                  "body":"server roster author",
                  "createdAtMs":1800000000000
                }],"nextBefore":null}
                """)
            case ("GET", "/v1/workspaces/\(workspace.description)/channels/\(channel.description)/cost-snapshots"):
                return MockHTTPResponse(json: """
                {"schema":"momo.cost_snapshot.channel.v0","channel_id":"\(channel.description)","as_of_ms":1800000000000,"snapshots":[]}
                """)
            default:
                return MockHTTPResponse(statusCode: 404, json: #"{"title":"unexpected"}"#)
            }
        }

        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(
                baseURL: URL(string: "https://momo.test")!,
                accessToken: "token-123",
                workspace: workspace,
                defaultChannel: channel
            ),
            session: session
        )
        let viewModel = ChatViewModel(chat: backend, agentTransport: backend)
        await viewModel.bootstrap(workspace: workspace, accessToken: "token-123")
        await viewModel.selectChannel(channel)

        XCTAssertEqual(Set(viewModel.activeMembers().map(\.id)), [MemberID.demoHuman, invitedAgent])
        viewModel.composerDraft = "@"
        XCTAssertTrue(viewModel.mentionAutocompleteCandidates().contains { $0.id == invitedAgent })
        XCTAssertFalse(viewModel.mentionAutocompleteCandidates().contains { $0.id == uninvitedAgent })
        let message = try XCTUnwrap(viewModel.visibleMessages.first)
        XCTAssertEqual(viewModel.member(message.authorMemberId)?.displayName, "Hermes")

        XCTAssertFalse(viewModel.allowsLocalProfileEditing)
        let serverPresence = try XCTUnwrap(viewModel.member(invitedAgent)?.presence)
        viewModel.applyLocalProfile(
            member: invitedAgent,
            displayName: "로컬 Hermes",
            avatarPath: "",
            presence: .away
        )
        XCTAssertEqual(viewModel.member(invitedAgent)?.displayName, "Hermes")
        XCTAssertEqual(viewModel.member(invitedAgent)?.presence, serverPresence)

        let requests = await MockHTTPURLProtocol.requests()
        XCTAssertTrue(requests.contains { $0.url?.path == "/v1/workspaces/\(workspace.description)/roster" })
        XCTAssertFalse(requests.contains { $0.url?.path.hasSuffix("/members") == true })
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
                  "agentHandle": "hermes",
                  "displayName": "Hermes",
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
        XCTAssertEqual(status.agentHandle, "hermes")
        XCTAssertEqual(status.mode, .externalHermes)
        XCTAssertEqual(status.availability, .available)
        XCTAssertEqual(status.endpointLabel, "https://kim.example.net/v1")
        XCTAssertFalse(status.endpointLabel.contains("token"))
    }

    func testRESTBackendLoadsGatewayRuntimeStatus() async throws {
        await MockHTTPURLProtocol.reset()
        let session = URLSession(configuration: .momoMocked)

        await MockHTTPURLProtocol.setHandler { request in
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/v1/agent-runtime/status"):
                return MockHTTPResponse(json: """
                {
                  "schema": "momo.agent_runtime.status.v0",
                  "agentHandle": "hermes",
                  "displayName": "Hermes",
                  "mode": "gateway",
                  "availability": "available",
                  "model": "hermes-agent",
                  "endpointLabel": "Hermes gateway platform adapter",
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
        XCTAssertEqual(status.mode, .gateway)
        XCTAssertEqual(status.availability, .available)
        XCTAssertEqual(status.endpointLabel, "Hermes gateway platform adapter")
        XCTAssertTrue(status.keyConfigured)
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
            case ("GET", "/v1/workspaces/\(workspace.description)/roster"):
                return MockHTTPResponse(json: """
                {"members":[{
                  "id":"\(MemberID.demoHuman.description)",
                  "workspaceId":"\(workspace.description)",
                  "kind":"human",
                  "status":"active",
                  "displayName":"데모 사용자",
                  "handle":"demo",
                  "channelIds":["\(ChannelID.demoGeneral.description)"]
                }]}
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
        XCTAssertEqual(
            SwiftCentrifugeRealtimeSubscriptionTransport.agentChannelName(
                workspace: .demo,
                channel: .demoAgentLab,
                agent: .demoAgent
            ),
            "agent:ws00000000-0000-7000-8000-000000000001.00000000-0000-7000-8000-000000000202.00000000-0000-7000-8000-000000000102"
        )
    }

    func testRESTBackendMapsGatewayAgentNamespaceProgressIntoRealtimeEvents() async throws {
        await MockHTTPURLProtocol.reset()
        await MockHTTPURLProtocol.setHandler { request in
            guard request.url?.path == "/v1/workspaces/\(WorkspaceID.demo.description)/roster" else {
                return MockHTTPResponse(statusCode: 404, json: #"{"title":"unexpected"}"#)
            }
            return MockHTTPResponse(json: """
            {"members":[{
              "id":"\(MemberID.demoAgent.description)",
              "workspaceId":"\(WorkspaceID.demo.description)",
              "kind":"agent",
              "status":"active",
              "displayName":"Hermes",
              "handle":"hermes",
              "channelIds":["\(ChannelID.demoAgentLab.description)"]
            }]}
            """)
        }
        let run = RunID(uuidString: "00000000-0000-7350-8000-000000350001")!
        let transport = FixtureAgentRealtimeTransport(envelopes: [
            RealtimeEnvelope(
                type: "agent.status",
                ts: 1,
                payload: [
                    "run_id": .string(run.description),
                    "agent_member_id": .string(MemberID.demoAgent.description),
                    "channel_id": .string(ChannelID.demoAgentLab.description),
                    "phase": "thinking",
                    "run_status": "running",
                ]
            ),
            RealtimeEnvelope(
                type: "agent.partial",
                ts: 2,
                payload: [
                    "run_id": .string(run.description),
                    "agent_member_id": .string(MemberID.demoAgent.description),
                    "channel_id": .string(ChannelID.demoAgentLab.description),
                    "text_delta": "gateway delta",
                ]
            ),
        ])
        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(
                baseURL: URL(string: "https://momo.test")!,
                accessToken: "token-123"
            ),
            session: URLSession(configuration: .momoMocked)
        )
        try await backend.connect(workspace: .demo, accessToken: "token-123")
        _ = try await backend.members(workspace: .demo)
        await backend.setAgentRealtimeTransport(transport)

        let stream = try await backend.subscribe(channel: .demoAgentLab)
        var events: [RealtimeEvent] = []
        for await event in stream {
            events.append(event)
        }

        guard events.count == 2 else {
            return XCTFail("active roster agent should produce status and partial events")
        }
        guard case .agentStatus(let status) = events[0] else {
            return XCTFail("gateway status must reach the existing realtime model")
        }
        XCTAssertEqual(status.phase, .thinking)
        guard case .agentPartial(let partial) = events[1] else {
            return XCTFail("gateway partial must reach the existing streaming renderer state")
        }
        XCTAssertEqual(partial.textDelta, "gateway delta")
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

    func testRESTBackendAgentCredentialCreateListAndRevokeContracts() async throws {
        await MockHTTPURLProtocol.reset()
        let workspace = WorkspaceID.demo
        let agent = MemberID.demoAgent
        let credentialID = UUID(uuidString: "00000000-0000-7000-8000-000000339001")!
        let requestCount = SynchronizedCounter()

        await MockHTTPURLProtocol.setHandler { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer admin-token")
            let call = requestCount.increment()
            switch call {
            case 1:
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(request.cachePolicy, .reloadIgnoringLocalCacheData)
                XCTAssertEqual(
                    request.url?.path,
                    "/v1/workspaces/\(workspace.description)/agents/\(agent.description)/credentials"
                )
                let data = try XCTUnwrap(request.momoBodyData)
                let body = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                XCTAssertEqual(body?["label"] as? String, "Hermes gateway")
                XCTAssertEqual(body?["rotationGraceSeconds"] as? Int, 86_400)
                return MockHTTPResponse(statusCode: 201, json: """
                {
                  "credential": {
                    "id": "\(credentialID.uuidString)",
                    "agentMemberId": "\(agent.description)",
                    "status": "active",
                    "scopes": ["agent:jobs:read", "messages:write"],
                    "label": "Hermes gateway",
                    "lastUsedAtMs": null,
                    "expiresAtMs": null,
                    "revokedAtMs": null,
                    "createdAtMs": 1800000000000
                  },
                  "token": "one-time-value",
                  "tokenType": "Bearer",
                  "rotatedCredentialCount": 0,
                  "rotationGraceEndsAtMs": null
                }
                """)
            case 2:
                XCTAssertEqual(request.httpMethod, "GET")
                return MockHTTPResponse(json: """
                {
                  "credentials": [{
                    "id": "\(credentialID.uuidString)",
                    "agentMemberId": "\(agent.description)",
                    "status": "active",
                    "scopes": ["agent:jobs:read", "messages:write"],
                    "label": "Hermes gateway",
                    "lastUsedAtMs": null,
                    "expiresAtMs": null,
                    "revokedAtMs": null,
                    "createdAtMs": 1800000000000
                  }]
                }
                """)
            case 3:
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(
                    request.url?.path,
                    "/v1/workspaces/\(workspace.description)/agents/\(agent.description)/credentials/\(credentialID.uuidString)/revoke"
                )
                return MockHTTPResponse(json: """
                {
                  "credential": {
                    "id": "\(credentialID.uuidString)",
                    "agentMemberId": "\(agent.description)",
                    "status": "revoked",
                    "scopes": ["agent:jobs:read", "messages:write"],
                    "label": "Hermes gateway",
                    "lastUsedAtMs": null,
                    "expiresAtMs": null,
                    "revokedAtMs": 1800000001000,
                    "createdAtMs": 1800000000000
                  },
                  "revokedNow": true,
                  "alreadyRevoked": false
                }
                """)
            default:
                XCTFail("unexpected credential request")
                return MockHTTPResponse(statusCode: 404, json: "{}")
            }
        }

        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(
                baseURL: URL(string: "https://momo.test")!,
                accessToken: "admin-token"
            ),
            session: URLSession(configuration: .momoMocked)
        )
        try await backend.connect(workspace: workspace, accessToken: "admin-token")

        let reveal = try await backend.issueAgentCredential(workspace: workspace, agent: agent)
        XCTAssertEqual(reveal.token, "one-time-value")
        XCTAssertEqual(reveal.credential.displayStatus(), .configured)

        let listed = try await backend.agentCredentials(workspace: workspace, agent: agent)
        XCTAssertEqual(listed.map { $0.id }, [credentialID])

        let revoked = try await backend.revokeAgentCredential(
            credentialID,
            workspace: workspace,
            agent: agent
        )
        XCTAssertEqual(revoked.displayStatus(), .revoked)
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
              "realtimeWebSocketUrl": "wss://rt.momo.test/connection/websocket",
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

        let client = MomoServerSessionClient(
            session: URLSession(configuration: .momoMocked),
            environment: ["MOMO_CENTRIFUGO_WS_URL": "ws://env.test/connection/websocket"]
        )
        let session = try await client.login(form: MomoServerSessionForm(
            baseURLString: "https://momo.test",
            email: "demo@momo.local",
            password: "secret"
        ))

        XCTAssertEqual(session.baseURL.absoluteString, "https://momo.test")
        XCTAssertEqual(session.workspace, workspace)
        XCTAssertEqual(session.member.id, .demoHuman)
        XCTAssertEqual(session.accessToken, "access-session")
        XCTAssertEqual(
            session.centrifugoWebSocketURL?.absoluteString,
            "wss://rt.momo.test/connection/websocket"
        )
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
              "realtimeWebSocketUrl": "wss://rt.join.momo.test/connection/websocket",
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
        XCTAssertEqual(
            session.centrifugoWebSocketURL?.absoluteString,
            "wss://rt.join.momo.test/connection/websocket"
        )
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

private actor ControlledCredentialRefreshBackend: ChatBackend, AgentTransport, MomoAgentCredentialBackend {
    private struct CallWaiter {
        let target: Int
        let continuation: CheckedContinuation<Void, Never>
    }

    private let agent: MemberID
    private var storedCredentials: [MomoAgentCredential] = []
    private var listCalls = 0
    private var issueCalls = 0
    private var listCallWaiters: [CallWaiter] = []
    private var issueCallWaiters: [CallWaiter] = []
    private var listCallReleases: [CheckedContinuation<Void, Never>] = []
    private var historyCalls = 0
    private var historyCallWaiters: [CallWaiter] = []
    private var historyCallReleases: [CheckedContinuation<Void, Never>] = []

    init(agent: MemberID) {
        self.agent = agent
    }

    func waitForListCallCount(_ target: Int) async {
        guard listCalls < target else { return }
        await withCheckedContinuation { continuation in
            listCallWaiters.append(CallWaiter(target: target, continuation: continuation))
        }
    }

    func waitForIssueCallCount(_ target: Int) async {
        guard issueCalls < target else { return }
        await withCheckedContinuation { continuation in
            issueCallWaiters.append(CallWaiter(target: target, continuation: continuation))
        }
    }

    func waitForHistoryCallCount(_ target: Int) async {
        guard historyCalls < target else { return }
        await withCheckedContinuation { continuation in
            historyCallWaiters.append(CallWaiter(target: target, continuation: continuation))
        }
    }

    func releaseNextListCall() {
        listCallReleases.removeFirst().resume()
    }

    func releaseNextHistoryCall() {
        historyCallReleases.removeFirst().resume()
    }

    func listCallCount() -> Int {
        listCalls
    }

    func agentCredentials(
        workspace: WorkspaceID,
        agent: MemberID
    ) async throws -> [MomoAgentCredential] {
        let snapshot = storedCredentials
        listCalls += 1
        resumeSatisfiedWaiters(&listCallWaiters, count: listCalls)
        await withCheckedContinuation { continuation in
            listCallReleases.append(continuation)
        }
        return snapshot
    }

    func issueAgentCredential(
        workspace: WorkspaceID,
        agent: MemberID,
        rotationGraceSeconds: Int
    ) async throws -> MomoAgentCredentialReveal {
        let credential = MomoAgentCredential(
            id: UUID(),
            agentMemberId: self.agent,
            serverStatus: "active",
            scopes: ["agent:jobs:read", "messages:write"],
            label: "Hermes gateway",
            lastUsedAtMs: nil,
            expiresAtMs: nil,
            revokedAtMs: nil,
            createdAtMs: 1_800_000_000_000
        )
        storedCredentials = [credential]
        issueCalls += 1
        resumeSatisfiedWaiters(&issueCallWaiters, count: issueCalls)
        return MomoAgentCredentialReveal(
            credential: credential,
            token: "not-a-real-token",
            tokenType: "Bearer",
            rotatedCredentialCount: 0,
            rotationGraceEndsAtMs: nil
        )
    }

    func revokeAgentCredential(
        _ credential: UUID,
        workspace: WorkspaceID,
        agent: MemberID
    ) async throws -> MomoAgentCredential {
        throw BackendError.notConnected
    }

    private func resumeSatisfiedWaiters(_ waiters: inout [CallWaiter], count: Int) {
        var remaining: [CallWaiter] = []
        for waiter in waiters {
            if count >= waiter.target {
                waiter.continuation.resume()
            } else {
                remaining.append(waiter)
            }
        }
        waiters = remaining
    }

    func connect(workspace: WorkspaceID, accessToken: String) async throws {}
    func sendOptimistic(_ draft: DraftMessage, clientMsgId: UUID) async throws -> Message {
        throw BackendError.notConnected
    }
    func subscribe(channel: ChannelID) async throws -> AsyncStream<RealtimeEvent> {
        AsyncStream { $0.finish() }
    }
    func history(channel: ChannelID, after seq: Int64?, limit: Int) async throws -> [Message] {
        historyCalls += 1
        resumeSatisfiedWaiters(&historyCallWaiters, count: historyCalls)
        await withCheckedContinuation { continuation in
            historyCallReleases.append(continuation)
        }
        return []
    }
    func presence(channel: ChannelID) async throws -> [PresenceEntry] { [] }
    func members(workspace: WorkspaceID) async throws -> [Member] { [] }
    func channels(workspace: WorkspaceID) async throws -> [Channel] { [] }
    func costSnapshots(channel: ChannelID) async throws -> [CostSnapshot] { [] }
    func search(workspace: WorkspaceID, query: String) async throws -> [Message] { [] }
    func setTyping(channel: ChannelID, isTyping: Bool) async {}
    func editMessage(_ id: MessageID, body: String) async throws -> Message {
        throw BackendError.notConnected
    }
    func addReaction(_ id: MessageID, emoji: String) async throws {}
    func pendingApprovals(workspace: WorkspaceID, status: ApprovalStatus) async throws -> [Approval] { [] }
    func decideApproval(_ request: ApprovalDecisionRequest) async throws -> ApprovalDecisionReceipt {
        throw BackendError.notConnected
    }
    func observe(agent: MemberID, channel: ChannelID) async throws -> AsyncStream<AgentEvent> {
        AsyncStream { $0.finish() }
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
        throw BackendError.notConnected
    }
    func cancelRun(_ id: RunID) async throws {}
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
            Member(id: human, workspaceId: workspace, kind: .human, displayName: "Human", handle: "human", channelIds: [channel]),
            Member(id: agent, workspaceId: workspace, kind: .agent, displayName: "김인턴", handle: "kim-intern", channelIds: [channel]),
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

private struct FixtureAgentRealtimeTransport: AgentRealtimeEnvelopeSubscriptionTransport {
    let storedEnvelopes: [RealtimeEnvelope]

    init(envelopes: [RealtimeEnvelope]) {
        storedEnvelopes = envelopes
    }

    func envelopes(
        agent: MemberID,
        channel: ChannelID
    ) async throws -> AsyncThrowingStream<RealtimeEnvelope, Error> {
        AsyncThrowingStream { continuation in
            for envelope in storedEnvelopes {
                continuation.yield(envelope)
            }
            continuation.finish()
        }
    }
}

private actor FixtureRealtimeChatBackend: ChatBackend {
    private let workspace: WorkspaceID
    private let storedMembers: [Member]
    private let storedChannels: [Channel]
    private let storedHistory: [ChannelID: [Message]]
    private let storedEvents: [RealtimeEvent]
    private var storedTypingCalls: [(channel: ChannelID, isTyping: Bool)] = []

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

    func setTyping(channel: ChannelID, isTyping: Bool) async {
        storedTypingCalls.append((channel: channel, isTyping: isTyping))
    }

    func typingCalls() -> [(channel: ChannelID, isTyping: Bool)] {
        storedTypingCalls
    }

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
