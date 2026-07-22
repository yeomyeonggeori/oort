import XCTest
import SwiftUI
import AppKit
import MomoCore
@testable import MomoMac

final class MomoMacTests: XCTestCase {

    private func unsignedAccessToken(for member: MemberID) -> String {
        let payload = Data(#"{"sub":"\#(member.description)"}"#.utf8)
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return "e30.\(payload).signature"
    }

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

    func testDeveloperModeDefaultsToStandardAndGatesCostsSeparately() {
        XCTAssertFalse(MomoDeveloperModePresentation.standard.showsDeveloperDetails)
        XCTAssertFalse(MomoDeveloperModePresentation.standard.showsCosts)
        XCTAssertTrue(MomoDeveloperModePresentation.developer(showCosts: false).showsDeveloperDetails)
        XCTAssertFalse(MomoDeveloperModePresentation.developer(showCosts: false).showsCosts)
        XCTAssertTrue(MomoDeveloperModePresentation.developer(showCosts: true).showsCosts)
    }

    func testApprovalSummaryQuotesArbitraryServerCopyAsOneSentence() {
        XCTAssertEqual(
            MomoWorkspaceCopy(language: .korean).workApprovalSummary(
                agentName: "Hermes",
                action: "GitHub에 체크리스트를 기록합니다."
            ),
            "Hermes가 ‘GitHub에 체크리스트를 기록합니다’ 작업의 승인을 요청했습니다."
        )
        XCTAssertEqual(
            MomoWorkspaceCopy(language: .english).workApprovalSummary(
                agentName: "Hermes",
                action: "Create a rollout checklist."
            ),
            "Hermes requested approval for ‘Create a rollout checklist’."
        )
    }

    func testKoreanParticlesFollowTheLastHangulSyllableBatchim() {
        XCTAssertEqual(MomoKoreanParticle.attach(.subject, to: "빌드봇"), "빌드봇이")
        XCTAssertEqual(MomoKoreanParticle.attach(.subject, to: "하루"), "하루가")
        XCTAssertEqual(MomoKoreanParticle.attach(.object, to: "빌드봇"), "빌드봇을")
        XCTAssertEqual(MomoKoreanParticle.attach(.object, to: "하루"), "하루를")
        XCTAssertEqual(MomoKoreanParticle.attach(.topic, to: "빌드봇"), "빌드봇은")
        XCTAssertEqual(MomoKoreanParticle.attach(.topic, to: "하루"), "하루는")
        XCTAssertEqual(
            MomoWorkspaceCopy(language: .korean).workApprovalSummary(agentName: "빌드봇", action: nil),
            "빌드봇이 작업 승인을 요청했습니다."
        )
        XCTAssertEqual(
            MomoWorkspaceCopy(language: .korean).agentWorkingTitle("하루"),
            "하루가 작업 중"
        )
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
        XCTAssertEqual(MomoTheme.Sidebar.footerBottomInset, 8)
    }

    @MainActor
    func testSurfaceElevationHasThreeOrderedLevelsInBothSchemes() throws {
        for scheme in [ColorScheme.light, .dark] {
            let background = try brightness(MomoTheme.Surface.style(.background, colorScheme: scheme).fill)
            let panel = try brightness(MomoTheme.Surface.style(.panel, colorScheme: scheme).fill)
            let cardStyle = MomoTheme.Surface.style(.card, colorScheme: scheme)
            let card = try brightness(cardStyle.fill)

            XCTAssertLessThan(background, panel)
            XCTAssertLessThan(panel, card)
            XCTAssertGreaterThan(cardStyle.shadowRadius, 0)
        }
    }

    @MainActor
    private func brightness(_ color: Color) throws -> CGFloat {
        let converted = try XCTUnwrap(NSColor(color).usingColorSpace(.deviceRGB))
        return (converted.redComponent + converted.greenComponent + converted.blueComponent) / 3
    }

    func testSidebarMembershipMutationCopyIsLocalizedAndVerbFirst() {
        let korean = MomoWorkspaceCopy(language: .korean)
        XCTAssertEqual(korean.addToChannel, "채널에 추가")
        XCTAssertEqual(korean.removeFromChannel, "채널에서 제거")

        let english = MomoWorkspaceCopy(language: .english)
        XCTAssertEqual(english.addToChannel, "Add to channel")
        XCTAssertEqual(english.removeFromChannel, "Remove from channel")
    }

    func testMembershipAdministrationCopyIsLocalizedAndUsesLoginSessionLanguage() {
        let korean = MomoWorkspaceCopy(language: .korean)
        let english = MomoWorkspaceCopy(language: .english)

        XCTAssertEqual(korean.workspaceAuditLog, "감사 로그")
        XCTAssertEqual(korean.leaveChannelFailed, "채널에서 나가지 못했습니다. 다시 시도해 주세요.")
        XCTAssertTrue(korean.suspendMemberExplanation("민지").contains("로그인 세션"))
        XCTAssertTrue(english.suspendMemberExplanation("Minji").contains("login sessions"))
        XCTAssertFalse(english.removeMemberExplanation.localizedCaseInsensitiveContains("token"))
        XCTAssertEqual(
            korean.auditActorTarget(actor: "상준", target: "Hermes"),
            "행위자 상준 → 대상 Hermes"
        )
    }

    func testMemberDirectoryFiltersNamesHandlesAndMemberKind() {
        let workspace = WorkspaceID()
        let people = [
            Member(
                id: MemberID(),
                workspaceId: workspace,
                kind: .human,
                displayName: "곽성재 Product",
                handle: "seongjae",
                workspaceRole: .owner
            ),
            Member(
                id: MemberID(),
                workspaceId: workspace,
                kind: .human,
                displayName: "민지 Operations",
                handle: "minji"
            ),
            Member(
                id: MemberID(),
                workspaceId: workspace,
                kind: .agent,
                displayName: "Hermes 코드 리뷰 에이전트",
                handle: "hermes"
            ),
        ]

        XCTAssertEqual(
            MomoMemberDirectoryPolicy.filteredMembers(people, query: "", scope: .people).map(\.kind),
            [.human, .human]
        )
        XCTAssertEqual(
            MomoMemberDirectoryPolicy.filteredMembers(people, query: "HER", scope: .all).map(\.handle),
            ["hermes"]
        )
        XCTAssertEqual(
            MomoMemberDirectoryPolicy.filteredMembers(people, query: "민지", scope: .agents),
            []
        )
    }

    func testMemberDirectoryCopyUsesVerbFirstDMActions() {
        let korean = MomoWorkspaceCopy(language: .korean)
        XCTAssertEqual(korean.sendDirectMessage, "DM 보내기")
        XCTAssertEqual(korean.openingDirectMessage, "DM 여는 중")
        XCTAssertEqual(korean.newDirectMessage, "새 DM 시작")
        XCTAssertEqual(korean.showAllMembers, "전체 멤버 보기")
        XCTAssertEqual(korean.noDirectoryMembersDetail, "워크스페이스에 참여한 멤버가 여기에 표시됩니다")

        let english = MomoWorkspaceCopy(language: .english)
        XCTAssertEqual(english.sendDirectMessage, "Send a DM")
        XCTAssertEqual(english.openingDirectMessage, "Opening DM")
        XCTAssertEqual(english.newDirectMessage, "Start a new DM")
        XCTAssertEqual(english.showAllMembers, "Show all members")
        XCTAssertEqual(english.noDirectoryMembersDetail, "Members appear here after they join the workspace")
    }

    func testMemberInspectorScopesCurrentChannelAndWorkspaceMembers() {
        let workspace = WorkspaceID()
        let channel = ChannelID()
        let otherChannel = ChannelID()
        let activeHuman = Member(
            id: MemberID(),
            workspaceId: workspace,
            kind: .human,
            displayName: "민지 Operations",
            handle: "minji",
            workspaceRole: .admin,
            channelIds: [channel]
        )
        let inactiveHuman = Member(
            id: MemberID(),
            workspaceId: workspace,
            kind: .human,
            status: .suspended,
            displayName: "상준 Finance",
            handle: "sangjun",
            channelIds: [channel]
        )
        let activeAgent = Member(
            id: MemberID(),
            workspaceId: workspace,
            kind: .agent,
            displayName: "Hermes 코드 리뷰",
            handle: "hermes",
            channelIds: [otherChannel],
            capabilities: ["code-review"]
        )

        XCTAssertEqual(
            MomoMemberInspectorPolicy.filteredMembers(
                [activeAgent, inactiveHuman, activeHuman],
                audience: .channel,
                channelID: channel,
                query: "",
                scope: .all
            ).map(\.id),
            [activeHuman.id]
        )
        XCTAssertEqual(
            MomoMemberInspectorPolicy.filteredMembers(
                [activeAgent, inactiveHuman, activeHuman],
                audience: .workspace,
                channelID: channel,
                query: "HER",
                scope: .agents
            ).map(\.id),
            [activeAgent.id]
        )
        XCTAssertEqual(
            MomoMemberInspectorPolicy.filteredMembers(
                [inactiveHuman, activeHuman],
                audience: .workspace,
                channelID: channel,
                query: "",
                scope: .people
            ).map(\.id),
            [activeHuman.id, inactiveHuman.id]
        )
    }

    func testMemberInspectorDirectMessageAvailabilityExplainsSelfInactiveAndInFlight() {
        let workspace = WorkspaceID()
        let current = Member(
            id: MemberID(),
            workspaceId: workspace,
            kind: .human,
            displayName: "성재",
            handle: "seongjae"
        )
        var inactive = Member(
            id: MemberID(),
            workspaceId: workspace,
            kind: .human,
            displayName: "상준",
            handle: "sangjun"
        )
        inactive.status = .suspended
        let agent = Member(
            id: MemberID(),
            workspaceId: workspace,
            kind: .agent,
            displayName: "Hermes",
            handle: "hermes"
        )

        XCTAssertEqual(
            MomoMemberInspectorPolicy.directMessageAvailability(
                for: current,
                currentMemberID: current.id,
                inFlightMemberIDs: []
            ),
            .currentUser
        )
        XCTAssertEqual(
            MomoMemberInspectorPolicy.directMessageAvailability(
                for: inactive,
                currentMemberID: current.id,
                inFlightMemberIDs: []
            ),
            .inactive
        )
        XCTAssertEqual(
            MomoMemberInspectorPolicy.directMessageAvailability(
                for: agent,
                currentMemberID: current.id,
                inFlightMemberIDs: [agent.id]
            ),
            .inFlight
        )
        XCTAssertEqual(
            MomoMemberInspectorPolicy.directMessageAvailability(
                for: agent,
                currentMemberID: current.id,
                inFlightMemberIDs: []
            ),
            .available
        )
    }

    func testMemberInspectorGroupsManagersAgentsAndPeopleByPresence() {
        let workspace = WorkspaceID()
        let channel = ChannelID()
        let owner = Member(
            id: MemberID(), workspaceId: workspace, kind: .human,
            displayName: "Owner", handle: "owner", workspaceRole: .owner,
            channelIds: [channel], presence: .online
        )
        let agent = Member(
            id: MemberID(), workspaceId: workspace, kind: .agent,
            displayName: "Hermes", handle: "hermes", channelIds: [channel],
            presence: .working
        )
        let online = Member(
            id: MemberID(), workspaceId: workspace, kind: .human,
            displayName: "Online", handle: "online", channelIds: [channel],
            presence: .online
        )
        let away = Member(
            id: MemberID(), workspaceId: workspace, kind: .human,
            displayName: "Away", handle: "away", channelIds: [channel],
            presence: .away
        )
        let offline = Member(
            id: MemberID(), workspaceId: workspace, kind: .human,
            displayName: "Offline", handle: "offline", channelIds: [channel]
        )

        let groups = MomoMemberInspectorPolicy.groups(
            [offline, agent, owner, away, online],
            audience: .channel,
            channelID: channel,
            query: "",
            scope: .all
        )

        XCTAssertEqual(groups.managers.map(\.id), [owner.id])
        XCTAssertEqual(groups.agents.map(\.id), [agent.id])
        XCTAssertEqual(groups.online.map(\.id), [online.id])
        XCTAssertEqual(groups.away.map(\.id), [away.id])
        XCTAssertEqual(groups.offline.map(\.id), [offline.id])
    }

    func testMembershipAdministrationPolicyFailsClosedAcrossRoleHierarchy() {
        let workspace = WorkspaceID()
        func member(_ role: MembershipRole, name: String) -> Member {
            Member(
                id: MemberID(), workspaceId: workspace, kind: .human,
                displayName: name, handle: name.lowercased(), workspaceRole: role
            )
        }
        let owner = member(.owner, name: "Owner")
        let peerOwner = member(.owner, name: "PeerOwner")
        let admin = member(.admin, name: "Admin")
        let regular = member(.member, name: "Member")
        let guest = member(.guest, name: "Guest")

        XCTAssertEqual(
            MomoMembershipAdministrationPolicy.assignableRoles(actor: owner, target: admin),
            [.owner, .admin, .member, .guest]
        )
        XCTAssertEqual(
            MomoMembershipAdministrationPolicy.assignableRoles(actor: admin, target: guest),
            [.member, .guest]
        )
        XCTAssertTrue(MomoMembershipAdministrationPolicy.canChangeLifecycle(actor: admin, target: regular))
        XCTAssertFalse(MomoMembershipAdministrationPolicy.canChangeLifecycle(actor: admin, target: owner))
        XCTAssertFalse(MomoMembershipAdministrationPolicy.canChangeLifecycle(actor: regular, target: guest))
        XCTAssertFalse(MomoMembershipAdministrationPolicy.canChangeLifecycle(actor: owner, target: owner))
        XCTAssertTrue(MomoMembershipAdministrationPolicy.assignableRoles(actor: owner, target: peerOwner).isEmpty)
    }

    func testWorkspaceAuditRequestUsesCanonicalFiltersAndLowercaseUUIDs() async throws {
        await MockHTTPURLProtocol.reset()
        let workspace = WorkspaceID()
        let target = MemberID()
        let cursor = UUID()
        let session = URLSession(configuration: .momoMocked)

        await MockHTTPURLProtocol.setHandler { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(
                request.url?.path,
                "/v1/workspaces/\(workspace.description)/audit"
            )
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer audit-token")
            return MockHTTPResponse(json: #"{"events":[],"nextCursor":null}"#)
        }

        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(
                baseURL: URL(string: "https://momo.test")!,
                accessToken: "audit-token",
                workspace: workspace
            ),
            session: session
        )
        try await backend.connect(workspace: workspace, accessToken: "audit-token")
        _ = try await backend.workspaceAudit(
            cursor: cursor,
            limit: 250,
            filter: MomoWorkspaceAuditFilter(
                actionPrefixes: ["member.", "ban."],
                targetMember: target,
                fromMs: 100,
                toMs: 200
            )
        )

        let requests = await MockHTTPURLProtocol.requests()
        let request = try XCTUnwrap(requests.first)
        let components = try XCTUnwrap(
            request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }
        )
        let values = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value) })
        XCTAssertEqual(values["limit"], "100")
        XCTAssertEqual(values["cursor"], cursor.uuidString.lowercased())
        XCTAssertEqual(values["actions"], "member.,ban.")
        XCTAssertEqual(values["target_member_id"], target.description.lowercased())
        XCTAssertEqual(values["from_ms"], "100")
        XCTAssertEqual(values["to_ms"], "200")
    }

    func testDockUnreadBadgeAggregatesAndCapsWithoutOverflow() {
        let first = ChannelID()
        let second = ChannelID()
        let states = [
            first: ChannelReadState(
                channelId: first, lastReadSeq: 0, latestSeq: 4,
                unreadCount: 4, mentionCount: 0
            ),
            second: ChannelReadState(
                channelId: second, lastReadSeq: 0, latestSeq: 120,
                unreadCount: 120, mentionCount: 1
            ),
        ]

        XCTAssertEqual(MomoDockUnreadBadgePolicy.totalUnread(states), 124)
        XCTAssertNil(MomoDockUnreadBadgePolicy.label(totalUnread: 0))
        XCTAssertEqual(MomoDockUnreadBadgePolicy.label(totalUnread: 9), "9")
        XCTAssertEqual(MomoDockUnreadBadgePolicy.label(totalUnread: 124), "99+")

        let overflowStates = [
            first: ChannelReadState(
                channelId: first, lastReadSeq: 0, latestSeq: 0,
                unreadCount: Int64.max, mentionCount: 0
            ),
            second: ChannelReadState(
                channelId: second, lastReadSeq: 0, latestSeq: 0,
                unreadCount: 1, mentionCount: 0
            ),
        ]
        XCTAssertEqual(MomoDockUnreadBadgePolicy.totalUnread(overflowStates), Int64.max)
    }

    func testRightPanelStaysBelowSharedHeaderWithoutBlockingTimeline() {
        XCTAssertEqual(
            MomoRightPanelLayout.headerHeight,
            MomoWindowChromeLayout.integratedHeaderHeight
        )
        XCTAssertFalse(MomoRightPanelLayout.blocksTimelineInteraction)
        XCTAssertEqual(
            MomoRightPanelLayout.width(
                preferredWidth: 440,
                availableWidth: 700
            ),
            340
        )
        XCTAssertEqual(
            MomoRightPanelLayout.width(
                preferredWidth: 440,
                availableWidth: 1_200
            ),
            440
        )
        XCTAssertEqual(
            MomoRightPanelLayout.width(
                preferredWidth: 440,
                availableWidth: 560
            ),
            200
        )
    }

    func testUnreadNavigationWrapsInCanonicalSidebarOrder() {
        let first = ChannelID()
        let second = ChannelID()
        let third = ChannelID()
        let ordered = [first, second, third]
        let unread: Set<ChannelID> = [first, third]

        XCTAssertEqual(
            MomoUnreadNavigation.destination(
                from: first,
                orderedChannels: ordered,
                unreadChannels: unread,
                direction: .next
            ),
            third
        )
        XCTAssertEqual(
            MomoUnreadNavigation.destination(
                from: first,
                orderedChannels: ordered,
                unreadChannels: unread,
                direction: .previous
            ),
            third
        )
        XCTAssertEqual(
            MomoUnreadNavigation.destination(
                from: third,
                orderedChannels: ordered,
                unreadChannels: unread,
                direction: .next
            ),
            first
        )
    }

    func testUnreadNavigationDoesNotReselectOnlyUnreadChannel() {
        let selected = ChannelID()
        XCTAssertNil(
            MomoUnreadNavigation.destination(
                from: selected,
                orderedChannels: [selected],
                unreadChannels: [selected],
                direction: .next
            )
        )
        XCTAssertEqual(MomoUnreadBadge.label(mentionCount: 4), "4")
        XCTAssertEqual(MomoUnreadBadge.label(mentionCount: 100), "99+")
        XCTAssertNil(MomoUnreadBadge.label(mentionCount: 0))
        XCTAssertEqual(MomoUnreadBadge.label(unreadCount: 7), "7")
        XCTAssertEqual(MomoUnreadBadge.label(unreadCount: 100), "99+")
        XCTAssertNil(MomoUnreadBadge.label(unreadCount: 0))
        let copy = MomoWorkspaceCopy(language: .english)
        XCTAssertEqual(
            copy.channelUnreadAccessibilityLabel(
                channelName: "general",
                unreadCount: 0,
                mentionCount: 0
            ),
            "general"
        )
        XCTAssertEqual(MomoUnreadKeyboardShortcut.helpGlyphs, "⌥⇧↑ / ⌥⇧↓")
        XCTAssertTrue(MomoUnreadKeyboardShortcut.modifiers.contains(.option))
        XCTAssertTrue(MomoUnreadKeyboardShortcut.modifiers.contains(.shift))
        XCTAssertFalse(MomoUnreadKeyboardShortcut.modifiers.contains(.command))

        let shortcutItems = MomoKeyboardShortcutCatalog.items(copy: copy)
        XCTAssertTrue(shortcutItems.contains { $0.key == "⇧⌘W" && $0.label == copy.startWork })
        XCTAssertTrue(
            shortcutItems.contains {
                $0.key == MomoUnreadKeyboardShortcut.helpGlyphs
                    && $0.label == copy.unreadChannelNavigation
            }
        )
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

    func testLiveBackendWorkspaceNameRoundTripPersistsForConnectedClient() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        try await backend.connect(workspace: seed.workspace, accessToken: "local-token")

        let initial = try await backend.workspace(id: seed.workspace)
        XCTAssertEqual(initial.name, "momo")
        let updated = try await backend.updateWorkspaceName(
            workspace: seed.workspace,
            name: "  모모 작업실  ",
            expectedUpdatedAtMs: initial.updatedAtMs
        )
        XCTAssertEqual(updated.name, "모모 작업실")
        let reloaded = try await backend.workspace(id: seed.workspace)
        XCTAssertEqual(reloaded.name, "모모 작업실")
        do {
            _ = try await backend.updateWorkspaceName(
                workspace: seed.workspace,
                name: "stale name",
                expectedUpdatedAtMs: initial.updatedAtMs
            )
            XCTFail("stale workspace update should fail")
        } catch {
            // Expected conflict.
        }
        do {
            _ = try await backend.updateWorkspaceName(
                workspace: seed.workspace,
                name: String(repeating: "a", count: 81),
                expectedUpdatedAtMs: reloaded.updatedAtMs
            )
            XCTFail("invalid workspace name should fail")
        } catch {
            // Expected validation failure.
        }
    }

    @MainActor
    func testWorkspaceRenameConflictReloadsBeforeRetry() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(chat: backend, agentTransport: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "local-token")
        let initial = try XCTUnwrap(viewModel.workspace)

        _ = try await backend.updateWorkspaceName(
            workspace: seed.workspace,
            name: "Changed elsewhere",
            expectedUpdatedAtMs: initial.updatedAtMs
        )

        let firstAttempt = await viewModel.updateWorkspaceName("My workspace")
        XCTAssertFalse(firstAttempt)
        XCTAssertEqual(viewModel.workspaceNameUpdateIssue, .conflict)
        XCTAssertEqual(viewModel.workspace?.name, "Changed elsewhere")
        let secondAttempt = await viewModel.updateWorkspaceName("My workspace")
        XCTAssertTrue(secondAttempt)
        XCTAssertEqual(viewModel.workspace?.name, "My workspace")
    }

    @MainActor
    func testWorkspaceRenameAuthenticationFailureRequiresSignInInsteadOfAdminAccess() async throws {
        let base = LiveChatBackend()
        let seed = await base.seedDemo()
        let backend = WorkspaceAuthenticationFailureBackend(base: base)
        let viewModel = ChatViewModel(chat: backend, agentTransport: base)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "expired-token")

        let saved = await viewModel.updateWorkspaceName("Must not save")

        XCTAssertFalse(saved)
        XCTAssertEqual(viewModel.workspaceNameUpdateIssue, .authenticationExpired)
        XCTAssertEqual(viewModel.connectionIssue, .authenticationExpired)
        XCTAssertTrue(
            MomoWorkspaceCopy(language: .english)
                .workspaceNameUpdateMessage(viewModel.workspaceNameUpdateIssue)
                .contains("Sign in again")
        )
        XCTAssertTrue(
            MomoWorkspaceCopy(language: .english)
                .workspaceNameUpdateMessage(.forbidden)
                .contains("owner or admin")
        )
    }

    func testWorkspaceDecodesLegacyCacheWithoutUpdatedTimestamp() throws {
        let workspace = WorkspaceID.demo
        let data = Data(#"{"id":"\#(workspace.description)","slug":"legacy","name":"Legacy Workspace"}"#.utf8)
        let decoded = try JSONDecoder().decode(Workspace.self, from: data)
        XCTAssertEqual(decoded.name, "Legacy Workspace")
        XCTAssertEqual(decoded.updatedAtMs, 0)
    }

    @MainActor
    func testWorkspaceRecoveryPresentationCoversNoCacheFailureAndAccessibilityCopy() {
        let english = MomoWorkspaceCopy(language: .english)
        let recovery = MomoWorkspaceIdentityRecoveryPresentation(
            workspace: nil,
            usesCache: false,
            error: "network unavailable",
            copy: english
        )

        XCTAssertEqual(recovery?.label, "Workspace unavailable · Retry")
        XCTAssertTrue(recovery?.help.contains("Shift-Command-R") == true)
        XCTAssertEqual(
            MomoWorkspaceIdentityRecoveryButton.accessibilityIdentifier,
            "workspace-identity-retry"
        )
        XCTAssertNil(
            MomoWorkspaceIdentityRecoveryPresentation(
                workspace: nil,
                usesCache: false,
                error: nil,
                copy: english
            )
        )
        XCTAssertEqual(
            MomoWorkspaceIdentityRecoveryPresentation(
                workspace: nil,
                usesCache: false,
                error: "오류",
                copy: MomoWorkspaceCopy(language: .korean)
            )?.label,
            "워크스페이스 오류 · 다시 시도"
        )
    }

    func testWorkspaceNameDraftUsesOneNormalizedValueForCountAndValidation() {
        let valid = MomoWorkspaceNameDraft("  Shared Workspace  \n")
        XCTAssertEqual(valid.normalized, "Shared Workspace")
        XCTAssertEqual(valid.characterCount, 16)
        XCTAssertTrue(valid.isValid)

        let whitespace = MomoWorkspaceNameDraft(" \n ")
        XCTAssertEqual(whitespace.characterCount, 0)
        XCTAssertFalse(whitespace.isValid)

        let controlCharacter = MomoWorkspaceNameDraft("valid\u{0007}")
        XCTAssertEqual(controlCharacter.characterCount, 6)
        XCTAssertFalse(controlCharacter.isValid)
    }

    @MainActor
    func testWorkspaceSettingsProjectionIgnoresUnrelatedStreamingStateChanges() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "token")
        let projection = MomoWorkspaceSettingsProjection(viewModel: viewModel)
        let initialUpdates = projection.observableUpdateCount

        viewModel.setChannels(Array(viewModel.channels.reversed()))
        for _ in 0..<10 { await Task.yield() }
        XCTAssertEqual(
            projection.observableUpdateCount,
            initialUpdates,
            "channel/streaming publications must not invalidate the workspace form"
        )

        let updated = await projection.updateWorkspaceName("Projection Workspace")
        XCTAssertTrue(updated)
        XCTAssertGreaterThan(projection.observableUpdateCount, initialUpdates)
        XCTAssertEqual(projection.workspace?.name, "Projection Workspace")
    }

    @MainActor
    func testStaleWorkspaceRefreshCannotOverwriteNewerRename() async throws {
        let defaultsSuite = "momo-workspace-race-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: defaultsSuite))
        defer { defaults.removePersistentDomain(forName: defaultsSuite) }
        let base = LiveChatBackend()
        let seed = await base.seedDemo()
        let backend = ControlledWorkspaceIdentityBackend(base: base, cacheScope: "race.test")
        let viewModel = ChatViewModel(
            chat: backend,
            agentTransport: base,
            workspaceIdentityDefaults: defaults
        )
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "local-token")
        let initial = try XCTUnwrap(viewModel.workspace)
        await backend.blockNextWorkspaceRead()

        let refresh = Task { @MainActor in
            await viewModel.refreshWorkspaceIdentity()
        }
        await backend.waitForWorkspaceReadCount(2)
        let didRename = await viewModel.updateWorkspaceName("Newest Workspace")
        XCTAssertTrue(didRename)
        let renamed = try XCTUnwrap(viewModel.workspace)
        XCTAssertGreaterThan(renamed.updatedAtMs, initial.updatedAtMs)

        await backend.releaseNextWorkspaceRead()
        await refresh.value

        XCTAssertEqual(viewModel.workspace?.name, "Newest Workspace")
        XCTAssertEqual(viewModel.workspace?.updatedAtMs, renamed.updatedAtMs)
        XCTAssertFalse(viewModel.workspaceIdentityUsesCache)
    }

    @MainActor
    func testClearedSessionRejectsLateWorkspaceRefresh() async throws {
        let defaultsSuite = "momo-workspace-session-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: defaultsSuite))
        defer { defaults.removePersistentDomain(forName: defaultsSuite) }
        let base = LiveChatBackend()
        let seed = await base.seedDemo()
        let backend = ControlledWorkspaceIdentityBackend(base: base, cacheScope: "session.test")
        let viewModel = ChatViewModel(
            chat: backend,
            agentTransport: base,
            workspaceIdentityDefaults: defaults
        )
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "local-token")
        await backend.blockNextWorkspaceRead()

        let refresh = Task { @MainActor in
            await viewModel.refreshWorkspaceIdentity()
        }
        await backend.waitForWorkspaceReadCount(2)
        await viewModel.clearSessionSensitiveState()
        await backend.releaseNextWorkspaceRead()
        await refresh.value

        XCTAssertNil(viewModel.workspaceId)
        XCTAssertNil(viewModel.workspace)
        XCTAssertFalse(viewModel.workspaceIdentityUsesCache)
    }

    @MainActor
    func testClearedSessionRejectsLateBootstrapChannelsAndDownstreamState() async throws {
        let defaultsSuite = "momo-bootstrap-session-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: defaultsSuite))
        defer { defaults.removePersistentDomain(forName: defaultsSuite) }
        let base = LiveChatBackend()
        let seed = await base.seedDemo()
        let backend = ControlledWorkspaceIdentityBackend(base: base, cacheScope: "bootstrap.session.test")
        let viewModel = ChatViewModel(
            chat: backend,
            agentTransport: base,
            workspaceIdentityDefaults: defaults
        )
        await backend.blockNextChannelsRead()

        let bootstrap = Task { @MainActor in
            await viewModel.bootstrap(workspace: seed.workspace, accessToken: "local-token")
        }
        await backend.waitForChannelsReadCount(1)
        await viewModel.clearSessionSensitiveState()
        await backend.releaseNextChannelsRead()
        await bootstrap.value

        XCTAssertNil(viewModel.workspaceId)
        XCTAssertNil(viewModel.workspace)
        XCTAssertTrue(viewModel.members.isEmpty)
        XCTAssertTrue(viewModel.channels.isEmpty)
        XCTAssertTrue(viewModel.readStatesByChannel.isEmpty)
        XCTAssertTrue(viewModel.approvals.isEmpty)
        XCTAssertNil(viewModel.selectedChannelId)
        XCTAssertNil(viewModel.connectionError)
    }

    @MainActor
    func testBootstrapStartsChannelsWhileWorkspaceIdentityIsBlocked() async throws {
        let defaultsSuite = "momo-bootstrap-parallel-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: defaultsSuite))
        defer { defaults.removePersistentDomain(forName: defaultsSuite) }
        let base = LiveChatBackend()
        let seed = await base.seedDemo()
        let backend = ControlledWorkspaceIdentityBackend(base: base, cacheScope: "parallel.test")
        let viewModel = ChatViewModel(
            chat: backend,
            agentTransport: base,
            workspaceIdentityDefaults: defaults
        )
        await backend.blockNextWorkspaceRead()

        let bootstrap = Task { @MainActor in
            await viewModel.bootstrap(workspace: seed.workspace, accessToken: "local-token")
        }
        await backend.waitForWorkspaceReadCount(1)
        await backend.waitForChannelsReadCount(1)
        await backend.releaseNextWorkspaceRead()
        await bootstrap.value

        XCTAssertEqual(viewModel.workspace?.id, seed.workspace)
        XCTAssertFalse(viewModel.channels.isEmpty)
    }

    @MainActor
    func testConflictReloadAfterSessionClearDoesNotRestoreErrorState() async throws {
        let defaultsSuite = "momo-conflict-session-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: defaultsSuite))
        defer { defaults.removePersistentDomain(forName: defaultsSuite) }
        let base = LiveChatBackend()
        let seed = await base.seedDemo()
        let backend = ControlledWorkspaceIdentityBackend(base: base, cacheScope: "conflict.session.test")
        let viewModel = ChatViewModel(
            chat: backend,
            agentTransport: base,
            workspaceIdentityDefaults: defaults
        )
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "local-token")
        await backend.failNextWorkspaceUpdateWithConflict()
        await backend.blockNextWorkspaceRead()

        let update = Task { @MainActor in
            await viewModel.updateWorkspaceName("Conflicting Name")
        }
        await backend.waitForWorkspaceReadCount(2)
        await viewModel.clearSessionSensitiveState()
        await backend.releaseNextWorkspaceRead()
        let didUpdate = await update.value
        XCTAssertFalse(didUpdate)

        XCTAssertNil(viewModel.workspaceId)
        XCTAssertNil(viewModel.workspace)
        XCTAssertNil(viewModel.workspaceNameUpdateError)
        XCTAssertNil(viewModel.workspaceNameUpdateIssue)
        XCTAssertNil(viewModel.connectionError)
        XCTAssertNil(viewModel.connectionIssue)
    }

    @MainActor
    func testAuthoritativeWorkspaceDenialDeletesExactCacheBeforeLaterServerFailure() async throws {
        let defaultsSuite = "momo-workspace-denial-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: defaultsSuite))
        defer { defaults.removePersistentDomain(forName: defaultsSuite) }
        let base = LiveChatBackend()
        let seed = await base.seedDemo()
        let backend = ControlledWorkspaceIdentityBackend(base: base, cacheScope: "denial.test")
        let viewModel = ChatViewModel(
            chat: backend,
            agentTransport: base,
            workspaceIdentityDefaults: defaults
        )
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "local-token")
        XCTAssertEqual(
            defaults.dictionaryRepresentation().keys.filter { $0.hasPrefix("momo.workspace.identity.") }.count,
            1
        )

        await backend.failNextWorkspaceRead(with: .backendStatus(403))
        await viewModel.refreshWorkspaceIdentity()
        XCTAssertNil(viewModel.workspace)
        XCTAssertFalse(viewModel.workspaceIdentityUsesCache)
        XCTAssertFalse(
            defaults.dictionaryRepresentation().keys.contains { $0.hasPrefix("momo.workspace.identity.") }
        )

        await backend.failNextWorkspaceRead(with: .backendStatus(503))
        await viewModel.refreshWorkspaceIdentity()
        XCTAssertNil(viewModel.workspace)
        XCTAssertFalse(viewModel.workspaceIdentityUsesCache)
    }

    @MainActor
    func testUnknownWorkspaceReadErrorDoesNotUsePersistentCache() async throws {
        let defaultsSuite = "momo-workspace-unknown-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: defaultsSuite))
        defer { defaults.removePersistentDomain(forName: defaultsSuite) }
        let base = LiveChatBackend()
        let seed = await base.seedDemo()
        let backend = ControlledWorkspaceIdentityBackend(base: base, cacheScope: "unknown.test")
        let viewModel = ChatViewModel(
            chat: backend,
            agentTransport: base,
            workspaceIdentityDefaults: defaults
        )
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "local-token")
        XCTAssertTrue(defaults.dictionaryRepresentation().keys.contains { key in
            key.hasPrefix("momo.workspace.identity.")
        })
        await backend.failNextWorkspaceRead(with: .unknown)

        await viewModel.refreshWorkspaceIdentity()

        XCTAssertNil(viewModel.workspace)
        XCTAssertFalse(viewModel.workspaceIdentityUsesCache)
        XCTAssertNotNil(viewModel.workspaceNameUpdateError)
    }

    @MainActor
    func testCancelledWorkspaceRefreshPreservesCurrentIdentityWithoutCacheFallback() async throws {
        let defaultsSuite = "momo-workspace-cancel-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: defaultsSuite))
        defer { defaults.removePersistentDomain(forName: defaultsSuite) }
        let base = LiveChatBackend()
        let seed = await base.seedDemo()
        let backend = ControlledWorkspaceIdentityBackend(base: base, cacheScope: "cancel.test")
        let viewModel = ChatViewModel(
            chat: backend,
            agentTransport: base,
            workspaceIdentityDefaults: defaults
        )
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "local-token")
        let initial = try XCTUnwrap(viewModel.workspace)
        await backend.failNextWorkspaceRead(with: .cancellation)

        await viewModel.refreshWorkspaceIdentity()

        XCTAssertEqual(viewModel.workspace, initial)
        XCTAssertFalse(viewModel.workspaceIdentityUsesCache)
        XCTAssertNil(viewModel.workspaceNameUpdateError)
    }

    @MainActor
    func testRepeatedLiveDemoBootstrapDoesNotCreateWorkspaceIdentityDefaults() async throws {
        let defaultsSuite = "momo-workspace-demo-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: defaultsSuite))
        defer { defaults.removePersistentDomain(forName: defaultsSuite) }
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(
            chat: backend,
            agentTransport: backend,
            workspaceIdentityDefaults: defaults
        )

        for _ in 0..<3 {
            await viewModel.bootstrap(workspace: seed.workspace, accessToken: "local-token")
        }

        XCTAssertFalse(defaults.dictionaryRepresentation().keys.contains { key in
            key.hasPrefix("momo.workspace.identity.")
        })
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
            XCTAssertFalse(
                message.props["human_summary"]?.stringValue?.isEmpty ?? true,
                "\(type.rawValue) should remain readable in standard mode"
            )
            XCTAssertFalse(
                message.props["human_detail"]?.stringValue?.isEmpty ?? true,
                "\(type.rawValue) should provide a human-language disclosure"
            )
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

    @MainActor
    func testBootstrapLoadsReadStateOnceAndAppliesPersonalRealtimeUpdate() async throws {
        let workspace = WorkspaceID()
        let member = Member(
            id: MemberID(),
            workspaceId: workspace,
            kind: .human,
            displayName: "성재",
            handle: "seongjae"
        )
        let channel = Channel(
            id: ChannelID(),
            workspaceId: workspace,
            kind: .publicChannel,
            name: "ship-room"
        )
        let initial = ChannelReadState(
            channelId: channel.id,
            lastReadSeq: 4,
            latestSeq: 9,
            unreadCount: 5,
            mentionCount: 2
        )
        let crossDevice = ChannelReadState(
            channelId: channel.id,
            lastReadSeq: 8,
            latestSeq: 9,
            unreadCount: 1,
            mentionCount: 0
        )
        let backend = FixtureRealtimeChatBackend(
            workspace: workspace,
            members: [member],
            channels: [channel],
            history: [:],
            events: [],
            readStates: [initial],
            readStateEvents: [crossDevice]
        )
        let viewModel = ChatViewModel(
            chat: backend,
            agentTransport: LiveChatBackend(),
            readStateDebounce: .milliseconds(5)
        )

        await viewModel.bootstrap(workspace: workspace, accessToken: "token")
        try await Task.sleep(for: .milliseconds(30))

        let readStateFetchCount = await backend.readStateFetchCount()
        XCTAssertEqual(readStateFetchCount, 1, "boot must use one bulk read-state call")
        XCTAssertEqual(viewModel.readStatesByChannel[channel.id], crossDevice)
    }

    @MainActor
    func testReadStateRealtimeFailureSurfacesSyncError() async throws {
        let workspace = WorkspaceID()
        let member = Member(
            id: MemberID(),
            workspaceId: workspace,
            kind: .human,
            displayName: "성재",
            handle: "seongjae"
        )
        let channel = Channel(
            id: ChannelID(),
            workspaceId: workspace,
            kind: .publicChannel,
            name: "ship-room"
        )
        let backend = FixtureRealtimeChatBackend(
            workspace: workspace,
            members: [member],
            channels: [channel],
            history: [:],
            events: [],
            readStateSubscriptionFails: true
        )
        let viewModel = ChatViewModel(chat: backend, agentTransport: LiveChatBackend())

        await viewModel.bootstrap(workspace: workspace, accessToken: "token")
        try await Task.sleep(for: .milliseconds(20))

        XCTAssertNotNil(viewModel.readStateSyncError)
    }

    @MainActor
    func testRealtimeNormalTerminationAllowsResubscribe() async throws {
        let workspace = WorkspaceID()
        let member = Member(
            id: MemberID(), workspaceId: workspace, kind: .human,
            displayName: "Human", handle: "human"
        )
        let channel = Channel(
            id: ChannelID(), workspaceId: workspace,
            kind: .publicChannel, name: "general"
        )
        let backend = FixtureRealtimeChatBackend(
            workspace: workspace,
            members: [member],
            channels: [channel],
            history: [:],
            events: []
        )
        let viewModel = ChatViewModel(chat: backend, agentTransport: LiveChatBackend())

        await viewModel.bootstrap(workspace: workspace, accessToken: "token")
        await waitForSubscriptionCleanup(viewModel)
        XCTAssertEqual(viewModel.activeChannelSubscriptionCount, 0)
        await viewModel.retryRealtime()
        for _ in 0..<20 { await Task.yield() }

        let normalCount = await backend.subscriptionCount(channel: channel.id)
        XCTAssertEqual(normalCount, 2)
    }

    @MainActor
    func testRealtimeSubscribeErrorAllowsResubscribe() async throws {
        let workspace = WorkspaceID()
        let member = Member(
            id: MemberID(), workspaceId: workspace, kind: .human,
            displayName: "Human", handle: "human"
        )
        let channel = Channel(
            id: ChannelID(), workspaceId: workspace,
            kind: .publicChannel, name: "general"
        )
        let backend = FixtureRealtimeChatBackend(
            workspace: workspace,
            members: [member],
            channels: [channel],
            history: [:],
            events: [],
            firstRealtimeSubscriptionFails: true
        )
        let viewModel = ChatViewModel(chat: backend, agentTransport: LiveChatBackend())

        await viewModel.bootstrap(workspace: workspace, accessToken: "token")
        await waitForSubscriptionCleanup(viewModel)
        XCTAssertEqual(viewModel.activeChannelSubscriptionCount, 0)
        await viewModel.retryRealtime()
        for _ in 0..<20 { await Task.yield() }

        let errorCount = await backend.subscriptionCount(channel: channel.id)
        XCTAssertEqual(errorCount, 2)
    }

    @MainActor
    private func waitForSubscriptionCleanup(_ viewModel: ChatViewModel) async {
        for _ in 0..<100 where viewModel.activeChannelSubscriptionCount != 0 {
            await Task.yield()
        }
    }

    @MainActor
    func testViewportMarkReadDebouncesAndRetriesWithoutCursorRegression() async throws {
        let workspace = WorkspaceID()
        let member = Member(
            id: MemberID(),
            workspaceId: workspace,
            kind: .human,
            displayName: "성재",
            handle: "seongjae"
        )
        let channel = Channel(
            id: ChannelID(),
            workspaceId: workspace,
            kind: .publicChannel,
            name: "launch"
        )
        let message = Message(
            id: MessageID(),
            channelId: channel.id,
            seq: 3,
            hlcTs: 3,
            authorMemberId: MemberID(),
            body: "배포 준비 상태를 확인했습니다."
        )
        let backend = FixtureRealtimeChatBackend(
            workspace: workspace,
            members: [member],
            channels: [channel],
            history: [channel.id: [message]],
            events: [],
            readStates: [ChannelReadState(
                channelId: channel.id,
                lastReadSeq: 0,
                latestSeq: 3,
                unreadCount: 3,
                mentionCount: 1
            )],
            markReadFailures: 1
        )
        let viewModel = ChatViewModel(
            chat: backend,
            agentTransport: LiveChatBackend(),
            readStateDebounce: .milliseconds(5)
        )
        await viewModel.bootstrap(workspace: workspace, accessToken: "token")
        await viewModel.selectChannel(channel.id)

        viewModel.messageDidRender(message)
        try await Task.sleep(for: .milliseconds(50))

        let markReadAttemptCount = await backend.markReadAttemptCount()
        XCTAssertEqual(markReadAttemptCount, 2)
        XCTAssertEqual(viewModel.readStatesByChannel[channel.id]?.lastReadSeq, 3)
        XCTAssertEqual(viewModel.readStatesByChannel[channel.id]?.unreadCount, 0)
        XCTAssertEqual(viewModel.readStatesByChannel[channel.id]?.mentionCount, 0)
    }

    @MainActor
    func testViewportMarkReadStopsAfterFiveFailuresAndManualRetryResumes() async throws {
        let workspace = WorkspaceID()
        let member = Member(
            id: MemberID(),
            workspaceId: workspace,
            kind: .human,
            displayName: "성재",
            handle: "seongjae"
        )
        let channel = Channel(
            id: ChannelID(),
            workspaceId: workspace,
            kind: .publicChannel,
            name: "release"
        )
        let message = Message(
            id: MessageID(),
            channelId: channel.id,
            seq: 3,
            hlcTs: 3,
            authorMemberId: MemberID(),
            body: "읽음 상태 재시도 상한을 확인합니다."
        )
        let backend = FixtureRealtimeChatBackend(
            workspace: workspace,
            members: [member],
            channels: [channel],
            history: [channel.id: [message]],
            events: [],
            readStates: [ChannelReadState(
                channelId: channel.id,
                lastReadSeq: 0,
                latestSeq: 3,
                unreadCount: 3,
                mentionCount: 0
            )],
            markReadFailures: 5
        )
        let viewModel = ChatViewModel(
            chat: backend,
            agentTransport: LiveChatBackend(),
            readStateDebounce: .milliseconds(1)
        )
        await viewModel.bootstrap(workspace: workspace, accessToken: "token")
        await viewModel.selectChannel(channel.id)

        viewModel.messageDidRender(message)
        try await Task.sleep(for: .milliseconds(80))

        let cappedAttemptCount = await backend.markReadAttemptCount()
        XCTAssertEqual(cappedAttemptCount, 5)
        XCTAssertNotNil(viewModel.readStateSyncError)
        try await Task.sleep(for: .milliseconds(30))
        let stableAttemptCount = await backend.markReadAttemptCount()
        XCTAssertEqual(stableAttemptCount, 5, "retry loop must stop at the cap")

        await viewModel.retryReadStateSync()
        try await Task.sleep(for: .milliseconds(20))

        let resumedAttemptCount = await backend.markReadAttemptCount()
        XCTAssertEqual(resumedAttemptCount, 6)
        XCTAssertEqual(viewModel.readStatesByChannel[channel.id]?.lastReadSeq, 3)
        XCTAssertNil(viewModel.readStateSyncError)
    }

    @MainActor
    func testIncomingMessageLocallyIncrementsUnreadThenSchedulesServerResync() async throws {
        let workspace = WorkspaceID()
        let member = Member(
            id: MemberID(),
            workspaceId: workspace,
            kind: .human,
            displayName: "성재",
            handle: "seongjae"
        )
        let channel = Channel(
            id: ChannelID(),
            workspaceId: workspace,
            kind: .publicChannel,
            name: "release"
        )
        let incoming = Message(
            id: MessageID(),
            channelId: channel.id,
            seq: 4,
            hlcTs: 4,
            authorMemberId: MemberID(),
            body: "Release candidate is ready.",
            props: [
                "mention_member_ids": .array([.string(member.id.description)]),
            ]
        )
        let backend = FixtureRealtimeChatBackend(
            workspace: workspace,
            members: [member],
            channels: [channel],
            history: [:],
            events: [.message(incoming)],
            readStates: [ChannelReadState(
                channelId: channel.id,
                lastReadSeq: 3,
                latestSeq: 3,
                unreadCount: 0,
                mentionCount: 0
            )]
        )
        let viewModel = ChatViewModel(
            chat: backend,
            agentTransport: LiveChatBackend(),
            readStateDebounce: .milliseconds(5)
        )

        await viewModel.bootstrap(workspace: workspace, accessToken: "token")
        try await Task.sleep(for: .milliseconds(30))

        XCTAssertEqual(viewModel.readStatesByChannel[channel.id]?.unreadCount, 1)
        XCTAssertEqual(viewModel.readStatesByChannel[channel.id]?.mentionCount, 1)

        try await Task.sleep(for: .milliseconds(280))
        let readStateFetchCount = await backend.readStateFetchCount()
        XCTAssertEqual(readStateFetchCount, 2, "incoming events must trigger an authoritative bulk resync")
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
                && message.props["mention_handle"]?.stringValue == "hermes"
                && (message.body?.contains("요청 확인했어요") == true)
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

    func testMentionSelectionWrapsAndHandlesEmptyCandidates() {
        let first = MemberID()
        let second = MemberID()
        let third = MemberID()
        let candidates = [first, second, third]

        XCTAssertEqual(
            MomoMentionSelection.moved(current: first, candidates: candidates, offset: -1),
            third
        )
        XCTAssertEqual(
            MomoMentionSelection.moved(current: third, candidates: candidates, offset: 1),
            first
        )
        XCTAssertEqual(
            MomoMentionSelection.moved(current: nil, candidates: candidates, offset: 1),
            first
        )
        XCTAssertEqual(
            MomoMentionSelection.moved(current: nil, candidates: candidates, offset: -1),
            third
        )
        XCTAssertNil(MomoMentionSelection.moved(current: nil, candidates: [], offset: 1))
    }

    @MainActor
    func testWorkAgentCandidatesRequireActiveChannelInviteAndCapability() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo(capabilitiesByHandle: [
            "hermes": [" Code ", "terminal", "code"],
            "buildbot": ["code"],
        ])
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "t")
        let general = try XCTUnwrap(seed.channels.first { $0.name == "general" })
        await viewModel.selectChannel(general.id)

        let hermes = try XCTUnwrap(seed.agents.first { $0.handle == "hermes" })
        let uninvitedBuilder = try XCTUnwrap(seed.agents.first { $0.handle == "buildbot" })
        XCTAssertEqual(viewModel.workAgentCandidates(requiring: "CODE").map(\.id), [hermes.id])
        XCTAssertFalse(viewModel.workAgentCandidates().contains { $0.id == uninvitedBuilder.id })
        XCTAssertEqual(viewModel.workAgentCandidates(requiring: "docs"), [])
        XCTAssertEqual(viewModel.workAgentCandidates(requiring: "   "), [])

        await viewModel.removeMember(hermes.id, from: general.id)
        XCTAssertEqual(viewModel.workAgentCandidates(requiring: "code"), [])

        let suspended = Member(
            id: MemberID(),
            workspaceId: seed.workspace,
            kind: .agent,
            status: .suspended,
            displayName: "배포 도우미",
            handle: "deploy-helper",
            channelIds: [general.id],
            capabilities: ["code"]
        )
        let humanWithCapability = Member(
            id: MemberID(),
            workspaceId: seed.workspace,
            kind: .human,
            displayName: "민지",
            handle: "minji",
            channelIds: [general.id],
            capabilities: ["code"]
        )
        XCTAssertEqual(
            MomoWorkAgentCandidateFilter.candidates(
                from: [suspended, humanWithCapability],
                in: general.id,
                requiredCapability: "code"
            ),
            []
        )
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
    func testRealtimeTypingEventMaintainsCompatibilityState() async throws {
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
    func testComposerDraftPublishesLocalTypingState() async throws {
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
        XCTAssertFalse(snapshot.statuses.contains { $0.detail.contains("db offline") })
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

    func testRESTBackendWorkspaceReadAndRenameUseAuthenticatedContract() async throws {
        await MockHTTPURLProtocol.reset()
        let session = URLSession(configuration: .momoMocked)
        let workspace = WorkspaceID.demo

        await MockHTTPURLProtocol.setHandler { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token-123")
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/v1/workspaces/\(workspace.description)"):
                return MockHTTPResponse(json: """
                {"workspace":{
                  "id":"\(workspace.description)",
                  "slug":"momo-demo",
                  "name":"momo",
                  "updatedAtMs":1800000000000
                }}
                """)
            case ("PATCH", "/v1/workspaces/\(workspace.description)"):
                let data = try XCTUnwrap(request.momoBodyData)
                let body = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                XCTAssertEqual(body?["name"] as? String, "모모 작업실")
                XCTAssertEqual(body?["expectedUpdatedAtMs"] as? Int64, 1_800_000_000_000)
                return MockHTTPResponse(json: """
                {"workspace":{
                  "id":"\(workspace.description)",
                  "slug":"momo-demo",
                  "name":"모모 작업실",
                  "updatedAtMs":1800000001000
                }}
                """)
            default:
                return MockHTTPResponse(statusCode: 404, json: #"{"title":"unexpected"}"#)
            }
        }

        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(
                baseURL: URL(string: "https://momo.test")!,
                accessToken: "token-123",
                workspace: workspace
            ),
            session: session
        )
        try await backend.connect(workspace: workspace, accessToken: "token-123")

        let initial = try await backend.workspace(id: workspace)
        XCTAssertEqual(initial.name, "momo")
        let updated = try await backend.updateWorkspaceName(
            workspace: workspace,
            name: "모모 작업실",
            expectedUpdatedAtMs: initial.updatedAtMs
        )
        XCTAssertEqual(updated.name, "모모 작업실")

        let requests = await MockHTTPURLProtocol.requests()
        XCTAssertEqual(requests.map { $0.httpMethod ?? "" }, ["GET", "PATCH"])
    }

    func testRESTBackendWorkspaceReadPreservesCancellation() async throws {
        await MockHTTPURLProtocol.reset()
        let workspace = WorkspaceID.demo
        await MockHTTPURLProtocol.setHandler { _ in
            throw URLError(.cancelled)
        }
        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(
                baseURL: URL(string: "https://momo.test")!,
                accessToken: "token-123",
                workspace: workspace
            ),
            session: URLSession(configuration: .momoMocked)
        )
        try await backend.connect(workspace: workspace, accessToken: "token-123")

        do {
            _ = try await backend.workspace(id: workspace)
            XCTFail("cancelled request should throw CancellationError")
        } catch is CancellationError {
            // Expected: cancellation remains control flow, not a realtime transport failure.
        } catch {
            XCTFail("expected CancellationError, got \(error)")
        }
        await MockHTTPURLProtocol.reset()
    }

    @MainActor
    func testBootstrapKeepsRosterAndChannelsWhenWorkspaceIdentityUsesCacheFallback() async throws {
        await MockHTTPURLProtocol.reset()
        let session = URLSession(configuration: .momoMocked)
        let workspace = WorkspaceID.demo
        let channel = ChannelID.demoGeneral
        let cacheScope = "https://momo.test|\(MemberID.demoHuman.description)"
        let encodedScope = Data(cacheScope.utf8).base64EncodedString()
        let cacheKey = "momo.workspace.identity.\(encodedScope).\(workspace.description)"
        let cached = Workspace(
            id: workspace,
            slug: "momo-demo",
            name: "Cached Workspace",
            updatedAtMs: 1_800_000_000_000
        )
        UserDefaults.standard.set(try JSONEncoder().encode(cached), forKey: cacheKey)
        defer { UserDefaults.standard.removeObject(forKey: cacheKey) }

        await MockHTTPURLProtocol.setHandler { request in
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/v1/workspaces/\(workspace.description)"):
                return MockHTTPResponse(statusCode: 503, json: #"{"title":"temporarily unavailable"}"#)
            case ("GET", "/v1/workspaces/\(workspace.description)/roster"):
                return MockHTTPResponse(json: """
                {"members":[{
                  "id":"\(MemberID.demoHuman.description)",
                  "workspaceId":"\(workspace.description)",
                  "kind":"human",
                  "status":"active",
                  "displayName":"Demo User",
                  "handle":"demo",
                  "channelIds":["\(channel.description)"]
                }]}
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
                  "archivedAtMs":null,
                  "muted":false
                }]}
                """)
            case ("GET", "/v1/agent-runtime/status"):
                return MockHTTPResponse(json: """
                {"schema":"momo.agent_runtime.status.v0","agentHandle":"hermes","displayName":"Hermes","mode":"gateway","availability":"available","model":"hermes-agent","endpointLabel":"gateway","keyConfigured":true,"diagnostics":[]}
                """)
            case ("GET", "/v1/workspaces/\(workspace.description)/approvals"):
                return MockHTTPResponse(json: #"{"approvals":[]}"#)
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

        XCTAssertEqual(viewModel.workspace?.name, "Cached Workspace")
        XCTAssertEqual(viewModel.members.map(\.id), [.demoHuman])
        XCTAssertEqual(viewModel.channels.map(\.id), [channel])
        XCTAssertEqual(viewModel.selectedChannelId, channel)
        XCTAssertNotNil(viewModel.workspaceNameUpdateError)
        XCTAssertTrue(viewModel.workspaceIdentityUsesCache)
    }

    @MainActor
    func testBootstrapDoesNotExposeCachedWorkspaceIdentityAfterForbiddenResponse() async throws {
        await MockHTTPURLProtocol.reset()
        let workspace = WorkspaceID.demo
        let channel = ChannelID.demoGeneral
        let cacheScope = "https://momo.test|\(MemberID.demoHuman.description)"
        let encodedScope = Data(cacheScope.utf8).base64EncodedString()
        let cacheKey = "momo.workspace.identity.\(encodedScope).\(workspace.description)"
        let cached = Workspace(id: workspace, slug: "private", name: "Must Not Leak", updatedAtMs: 7)
        UserDefaults.standard.set(try JSONEncoder().encode(cached), forKey: cacheKey)
        defer { UserDefaults.standard.removeObject(forKey: cacheKey) }

        await MockHTTPURLProtocol.setHandler { request in
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/v1/workspaces/\(workspace.description)/roster"):
                return MockHTTPResponse(json: """
                {"members":[{"id":"\(MemberID.demoHuman.description)","workspaceId":"\(workspace.description)","kind":"human","status":"active","displayName":"Demo User","handle":"demo","channelIds":["\(channel.description)"]}]}
                """)
            case ("GET", "/v1/workspaces/\(workspace.description)"):
                return MockHTTPResponse(statusCode: 403, json: #"{"title":"forbidden"}"#)
            case ("GET", "/v1/workspaces/\(workspace.description)/channels"):
                return MockHTTPResponse(json: #"{"channels":[]}"#)
            case ("GET", "/v1/workspaces/\(workspace.description)/read-state"):
                return MockHTTPResponse(json: #"{"read_states":[]}"#)
            case ("GET", "/v1/agent-runtime/status"):
                return MockHTTPResponse(json: #"{"schema":"momo.agent_runtime.status.v0","agentHandle":"hermes","displayName":"Hermes","mode":"gateway","availability":"available","model":"hermes-agent","endpointLabel":"gateway","keyConfigured":true,"diagnostics":[]}"#)
            case ("GET", "/v1/workspaces/\(workspace.description)/approvals"):
                return MockHTTPResponse(json: #"{"approvals":[]}"#)
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
            session: URLSession(configuration: .momoMocked)
        )
        let viewModel = ChatViewModel(chat: backend, agentTransport: backend)
        await viewModel.bootstrap(workspace: workspace, accessToken: "token-123")

        XCTAssertNil(viewModel.workspace)
        XCTAssertFalse(viewModel.workspaceIdentityUsesCache)
        XCTAssertNil(UserDefaults.standard.data(forKey: cacheKey))
    }

    func testRESTBackendBulkReadStateAndMarkReadUseADR0109Contract() async throws {
        await MockHTTPURLProtocol.reset()
        let session = URLSession(configuration: .momoMocked)
        let workspace = WorkspaceID.demo
        let channel = ChannelID.demoGeneral

        await MockHTTPURLProtocol.setHandler { request in
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/v1/workspaces/\(workspace.description)/read-state"):
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token-123")
                return MockHTTPResponse(json: """
                {"read_states":[{
                  "channel_id":"\(channel.description)",
                  "last_read_seq":4,
                  "latest_seq":9,
                  "unread_count":5,
                  "mention_count":2
                }]}
                """)
            case ("PUT", "/v1/workspaces/\(workspace.description)/channels/\(channel.description)/read-state"):
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token-123")
                let data = try XCTUnwrap(request.momoBodyData)
                let body = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                XCTAssertEqual(body?["last_read_seq"] as? Int, 9)
                XCTAssertNil(body?["member_id"], "actor identity must come only from the bearer")
                return MockHTTPResponse(json: """
                {
                  "channel_id":"\(channel.description)",
                  "last_read_seq":9,
                  "latest_seq":9,
                  "unread_count":0,
                  "mention_count":0
                }
                """)
            default:
                return MockHTTPResponse(statusCode: 404, json: #"{"title":"unexpected"}"#)
            }
        }

        let realtimeDriver = RecordingRealtimeSubscriptionDriver(events: [])
        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(
                baseURL: URL(string: "https://momo.test")!,
                accessToken: "token-123",
                workspace: workspace,
                defaultChannel: channel
            ),
            session: session,
            realtimeDriver: realtimeDriver
        )
        try await backend.connect(workspace: workspace, accessToken: "token-123")

        let states = try await backend.readStates(workspace: workspace)
        XCTAssertEqual(states.map(\.unreadCount), [5])
        XCTAssertEqual(states.map(\.mentionCount), [2])
        _ = try await backend.subscribe(channel: channel)
        let startingSeqs = await realtimeDriver.startingSeqs()
        XCTAssertEqual(startingSeqs, [9], "bulk channel heads must seed background realtime cursors")

        let marked = try await backend.markRead(channel: channel, through: 9)
        XCTAssertEqual(marked.lastReadSeq, 9)
        XCTAssertEqual(marked.unreadCount, 0)
        XCTAssertEqual(marked.mentionCount, 0)

        let requests = await MockHTTPURLProtocol.requests()
        XCTAssertEqual(requests.map { $0.httpMethod ?? "" }, ["GET", "PUT"])
    }

    func testRESTBackendFiltersPersonalReadStateRealtimeEnvelope() async throws {
        let workspace = WorkspaceID.demo
        let member = MemberID.demoHuman
        let channel = ChannelID.demoGeneral
        let payload = Data(#"{"sub":"\#(member.description)"}"#.utf8)
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let accessToken = "e30.\(payload).signature"
        let matching = RealtimeEnvelope(
            type: "read_state",
            ts: 1_800_000_000_000,
            payload: [
                "workspace_id": .string(workspace.description),
                "member_id": .string(member.description),
                "channel_id": .string(channel.description),
                "last_read_seq": .int(8),
                "latest_seq": .int(10),
                "unread_count": .int(2),
                "mention_count": .int(1),
            ]
        )
        let foreign = RealtimeEnvelope(
            type: "read_state",
            ts: matching.ts,
            payload: [
                "workspace_id": .string(workspace.description),
                "member_id": .string(MemberID().description),
                "channel_id": .string(channel.description),
                "last_read_seq": .int(10),
                "latest_seq": .int(10),
                "unread_count": .int(0),
                "mention_count": .int(0),
            ]
        )
        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(
                baseURL: URL(string: "https://momo.test")!,
                accessToken: accessToken,
                workspace: workspace
            )
        )
        try await backend.connect(workspace: workspace, accessToken: accessToken)
        let authenticatedMemberID = await backend.authenticatedMemberID()
        XCTAssertEqual(authenticatedMemberID, member)
        await backend.setReadStateRealtimeTransport(
            FixtureReadStateRealtimeTransport(envelopes: [foreign, matching])
        )

        let stream = try await backend.subscribeReadStates(member: member)
        var states: [ChannelReadState] = []
        for try await state in stream {
            states.append(state)
        }

        XCTAssertEqual(states.count, 1)
        XCTAssertEqual(states.first?.channelId, channel)
        XCTAssertEqual(states.first?.unreadCount, 2)
        XCTAssertEqual(
            SwiftCentrifugeRealtimeSubscriptionTransport.readStateChannelName(member: member),
            "user:read-state#\(member.description)"
        )
    }

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
                XCTAssertEqual(body?["rootId"] as? String, messageID.description)
                return MockHTTPResponse(statusCode: 201, json: """
                {
                  "id": "00000000-0000-7000-8000-000000001002",
                  "channelId": "\(channel.description)",
                  "rootId": "\(messageID.description)",
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
            DraftMessage(
                channelId: channel,
                type: .text,
                body: "hello REST",
                rootId: messageID
            ),
            clientMsgId: clientMsgId
        )
        XCTAssertEqual(ack.seq, 8)
        XCTAssertEqual(ack.clientMsgId, clientMsgId)
        XCTAssertEqual(ack.rootId, messageID)

        let requests = await MockHTTPURLProtocol.requests()
        XCTAssertEqual(requests.map { $0.httpMethod ?? "" }, ["POST", "GET", "POST"])
    }

    func testRESTBackendColdHistoryDecodesEditedMessageAndDeletedTombstone() async throws {
        await MockHTTPURLProtocol.reset()
        let workspace = WorkspaceID.demo
        let channel = ChannelID.demoGeneral
        let editedID = MessageID(uuidString: "00000000-0000-7000-8000-000000001041")!
        let deletedID = MessageID(uuidString: "00000000-0000-7000-8000-000000001042")!

        await MockHTTPURLProtocol.setHandler { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(
                request.url?.path,
                "/v1/workspaces/\(workspace.description)/channels/\(channel.description)/messages"
            )
            XCTAssertEqual(request.url?.query, "limit=50")
            return MockHTTPResponse(json: """
            {
              "messages": [
                {
                  "id": "\(editedID.description)",
                  "channelId": "\(channel.description)",
                  "rootId": null,
                  "seq": 40,
                  "hlcTs": 1700000001000,
                  "hlcCount": 0,
                  "authorMemberId": "\(MemberID.demoHuman.description)",
                  "type": "text",
                  "body": "수정된 기록",
                  "createdAtMs": 1700000000000,
                  "state": "edited",
                  "editedAtMs": 1700000001000,
                  "deletedAtMs": null
                },
                {
                  "id": "\(deletedID.description)",
                  "channelId": "\(channel.description)",
                  "rootId": null,
                  "seq": 41,
                  "hlcTs": 1700000002000,
                  "hlcCount": 0,
                  "authorMemberId": "\(MemberID.demoHuman.description)",
                  "type": "text",
                  "body": null,
                  "createdAtMs": 1700000000000,
                  "state": "deleted",
                  "editedAtMs": 1700000001000,
                  "deletedAtMs": 1700000002000
                }
              ],
              "nextBefore": 40
            }
            """)
        }

        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(baseURL: URL(string: "https://momo.test")!),
            session: URLSession(configuration: .momoMocked)
        )
        try await backend.connect(workspace: workspace, accessToken: "token-123")

        let history = try await backend.history(channel: channel, after: nil, limit: 50)
        XCTAssertEqual(history.map(\.id), [editedID, deletedID])

        let edited = try XCTUnwrap(history.first)
        XCTAssertEqual(edited.state, .edited)
        XCTAssertEqual(edited.body, "수정된 기록")
        XCTAssertEqual(edited.editedAtMs, 1_700_000_001_000)
        XCTAssertFalse(edited.isDeleted)

        let tombstone = try XCTUnwrap(history.last)
        XCTAssertEqual(tombstone.state, .deleted)
        XCTAssertNil(tombstone.body)
        XCTAssertEqual(tombstone.editedAtMs, 1_700_000_001_000)
        XCTAssertEqual(tombstone.deletedAtMs, 1_700_000_002_000)
        XCTAssertTrue(tombstone.isDeleted)
    }

    func testRESTBackendUploadsBindsProjectsAndDownloadsAttachmentWithoutBearerOnCapabilityURL() async throws {
        await MockHTTPURLProtocol.reset()
        let workspace = WorkspaceID.demo
        let channel = ChannelID.demoGeneral
        let attachmentID = FileID(uuidString: "00000000-0000-7000-8000-000000001060")!
        let messageID = MessageID(uuidString: "00000000-0000-7000-8000-000000001061")!
        let payload = Data("attachment-contract".utf8)
        let tempFolder = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempFolder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempFolder) }
        let source = tempFolder.appendingPathComponent("검수 보고서.txt")
        let destination = tempFolder.appendingPathComponent("downloaded.txt")
        try payload.write(to: source)

        await MockHTTPURLProtocol.setHandler { request in
            let path = request.url?.path ?? ""
            switch (request.httpMethod, request.url?.host, path) {
            case ("POST", "momo.test", let path) where path.hasSuffix("/attachments/uploads"):
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token-123")
                let data = try XCTUnwrap(request.momoBodyData)
                let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
                XCTAssertEqual(body["name"] as? String, "검수 보고서.txt")
                XCTAssertEqual(body["mime"] as? String, "text/plain")
                XCTAssertEqual((body["size"] as? NSNumber)?.intValue, payload.count)
                return MockHTTPResponse(statusCode: 201, json: """
                {
                  "id":"\(attachmentID.description)",
                  "status":"pending",
                  "uploadUrl":"https://upload.test/resumable?token=SECRET_CAPABILITY"
                }
                """)
            case ("PUT", "upload.test", "/resumable"):
                XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
                XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "text/plain")
                XCTAssertEqual(request.momoBodyData, payload)
                return MockHTTPResponse(data: Data())
            case ("POST", "momo.test", let path) where path.hasSuffix("/attachments/\(attachmentID.description)/complete"):
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token-123")
                return MockHTTPResponse(json: """
                {
                  "id":"\(attachmentID.description)",
                  "channelId":"\(channel.description)",
                  "uploaderMemberId":"\(MemberID.demoHuman.description)",
                  "name":"검수 보고서.txt",
                  "mime":"text/plain",
                  "size":\(payload.count),
                  "status":"complete",
                  "createdAtMs":1700000000000
                }
                """)
            case ("POST", "momo.test", let path) where path.hasSuffix("/channels/\(channel.description)/messages"):
                let data = try XCTUnwrap(request.momoBodyData)
                let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
                XCTAssertEqual(body["attachmentIds"] as? [String], [attachmentID.description])
                return MockHTTPResponse(statusCode: 201, json: """
                {
                  "id":"\(messageID.description)",
                  "channelId":"\(channel.description)",
                  "rootId":null,
                  "seq":61,
                  "hlcTs":1700000001000,
                  "hlcCount":0,
                  "authorMemberId":"\(MemberID.demoHuman.description)",
                  "type":"text",
                  "body":"첨부 확인",
                  "clientMsgId":"\((body["clientMsgId"] as? String) ?? UUID().uuidString)",
                  "createdAtMs":1700000001000,
                  "attachments":[{
                    "id":"\(attachmentID.description)",
                    "name":"검수 보고서.txt",
                    "mime":"text/plain",
                    "sizeBytes":\(payload.count)
                  }]
                }
                """)
            case ("GET", "momo.test", let path) where path.hasSuffix("/attachments/\(attachmentID.description)/content"):
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token-123")
                return MockHTTPResponse(
                    data: payload,
                    headers: [
                        "Content-Type": "text/plain",
                        "Content-Length": String(payload.count),
                    ]
                )
            default:
                return MockHTTPResponse(statusCode: 404, json: #"{"title":"unexpected"}"#)
            }
        }

        let session = URLSession(configuration: .momoMocked)
        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(
                baseURL: URL(string: "https://momo.test")!,
                accessToken: "token-123",
                workspace: workspace,
                defaultChannel: channel
            ),
            session: session,
            directUploadSession: session
        )
        try await backend.connect(workspace: workspace, accessToken: "token-123")

        let attachment = try await backend.uploadAttachment(fileURL: source, to: channel)
        XCTAssertEqual(attachment.id, attachmentID)
        XCTAssertEqual(attachment.sizeBytes, Int64(payload.count))

        let clientMessageID = UUID()
        let message = try await backend.sendOptimistic(
            DraftMessage(
                channelId: channel,
                body: "첨부 확인",
                attachmentIds: [attachment.id]
            ),
            clientMsgId: clientMessageID
        )
        XCTAssertEqual(message.attachments, [attachment])

        try await backend.downloadAttachment(attachment, from: channel, to: destination)
        XCTAssertEqual(try Data(contentsOf: destination), payload)
        let requests = await MockHTTPURLProtocol.requests()
        let capabilityRequest = try XCTUnwrap(requests.first { $0.url?.host == "upload.test" })
        XCTAssertNil(capabilityRequest.value(forHTTPHeaderField: "Authorization"))
    }

    func testRESTBackendLoadsThreadRepliesWithExclusiveCursorAndTombstones() async throws {
        await MockHTTPURLProtocol.reset()
        let workspace = WorkspaceID.demo
        let channel = ChannelID.demoGeneral
        let root = MessageID(uuidString: "00000000-0000-7000-8000-000000001050")!
        let firstID = MessageID(uuidString: "00000000-0000-7000-8000-000000001051")!
        let deletedID = MessageID(uuidString: "00000000-0000-7000-8000-000000001052")!
        let lastID = MessageID(uuidString: "00000000-0000-7000-8000-000000001053")!

        await MockHTTPURLProtocol.setHandler { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(
                request.url?.path,
                "/v1/workspaces/\(workspace.description)/channels/\(channel.description)/messages/\(root.description)/replies"
            )
            let queryItems = URLComponents(
                url: try XCTUnwrap(request.url),
                resolvingAgainstBaseURL: false
            )?.queryItems ?? []
            XCTAssertEqual(queryItems.first(where: { $0.name == "limit" })?.value, "2")
            let cursor = queryItems.first(where: { $0.name == "cursor" })?.value
            if cursor == nil {
                return MockHTTPResponse(json: """
                {
                  "messages": [
                    {
                      "id": "\(firstID.description)",
                      "channelId": "\(channel.description)",
                      "rootId": "\(root.description)",
                      "seq": 41,
                      "hlcTs": 1700000001000,
                      "hlcCount": 0,
                      "authorMemberId": "\(MemberID.demoHuman.description)",
                      "type": "text",
                      "body": "첫 답글",
                      "createdAtMs": 1700000001000,
                      "state": "sent"
                    },
                    {
                      "id": "\(deletedID.description)",
                      "channelId": "\(channel.description)",
                      "rootId": "\(root.description)",
                      "seq": 42,
                      "hlcTs": 1700000002000,
                      "hlcCount": 0,
                      "authorMemberId": "\(MemberID.demoHuman.description)",
                      "type": "text",
                      "body": null,
                      "createdAtMs": 1700000002000,
                      "state": "deleted",
                      "deletedAtMs": 1700000003000
                    }
                  ],
                  "nextCursor": 42
                }
                """)
            }
            XCTAssertEqual(cursor, "42")
            return MockHTTPResponse(json: """
            {
              "messages": [{
                "id": "\(lastID.description)",
                "channelId": "\(channel.description)",
                "rootId": "\(root.description)",
                "seq": 43,
                "hlcTs": 1700000004000,
                "hlcCount": 0,
                "authorMemberId": "\(MemberID.demoHuman.description)",
                "type": "text",
                "body": "마지막 답글",
                "createdAtMs": 1700000004000,
                "state": "sent"
              }],
              "nextCursor": null
            }
            """)
        }

        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(baseURL: URL(string: "https://momo.test")!),
            session: URLSession(configuration: .momoMocked)
        )
        try await backend.connect(workspace: workspace, accessToken: "token-123")

        let firstPage = try await backend.threadReplies(
            channel: channel,
            root: root,
            cursor: nil,
            limit: 2
        )
        XCTAssertEqual(firstPage.messages.map(\.id), [firstID, deletedID])
        XCTAssertTrue(try XCTUnwrap(firstPage.messages.last).isDeleted)
        XCTAssertEqual(firstPage.nextCursor, 42)

        let secondPage = try await backend.threadReplies(
            channel: channel,
            root: root,
            cursor: firstPage.nextCursor,
            limit: 2
        )
        XCTAssertEqual(secondPage.messages.map(\.id), [lastID])
        XCTAssertNil(secondPage.nextCursor)
    }

    func testRESTBackendSearchUsesWorkspaceFTSEndpointAndPreservesHitIdentity() async throws {
        await MockHTTPURLProtocol.reset()
        let workspace = WorkspaceID.demo
        let channel = ChannelID.demoGeneral
        let message = MessageID(uuidString: "00000000-0000-7000-8000-000000001090")!
        let author = MemberID.demoHuman
        await MockHTTPURLProtocol.setHandler { request in
            XCTAssertEqual(
                request.url?.path,
                "/v1/workspaces/\(workspace.description)/search/messages"
            )
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token-123")
            let items = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems
            XCTAssertEqual(items?.first(where: { $0.name == "q" })?.value, "배포 % 확인")
            XCTAssertEqual(items?.first(where: { $0.name == "limit" })?.value, "20")
            return MockHTTPResponse(json: """
            {
              "hits": [{
                "channelId": "\(channel.description)",
                "messageId": "\(message.description)",
                "seq": 901,
                "authorMemberId": "\(author.description)",
                "createdAtMs": 1784376000000,
                "snippet": "배포 % 확인 결과입니다",
                "matchOffset": 0
              }],
              "nextCursor": "opaque-next"
            }
            """)
        }
        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(baseURL: URL(string: "https://momo.test")!),
            session: URLSession(configuration: .momoMocked)
        )
        try await backend.connect(workspace: workspace, accessToken: "token-123")

        let results = try await backend.search(workspace: workspace, query: "배포 % 확인")

        XCTAssertEqual(results.map(\.id), [message])
        XCTAssertEqual(results.first?.channelId, channel)
        XCTAssertEqual(results.first?.seq, 901)
        XCTAssertEqual(results.first?.body, "배포 % 확인 결과입니다")
        XCTAssertEqual(results.first?.props["search_match_offset"]?.intValue, 0)
    }

    func testRESTBackendSearchPageForwardsOpaqueCursor() async throws {
        await MockHTTPURLProtocol.reset()
        let workspace = WorkspaceID.demo
        await MockHTTPURLProtocol.setHandler { request in
            let items = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems
            XCTAssertEqual(items?.first(where: { $0.name == "q" })?.value, "release note")
            XCTAssertEqual(items?.first(where: { $0.name == "limit" })?.value, "12")
            XCTAssertEqual(items?.first(where: { $0.name == "cursor" })?.value, "opaque-in")
            return MockHTTPResponse(json: #"{"hits":[],"nextCursor":"opaque-out"}"#)
        }
        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(baseURL: URL(string: "https://momo.test")!),
            session: URLSession(configuration: .momoMocked)
        )
        try await backend.connect(workspace: workspace, accessToken: "token-123")

        let page = try await backend.searchWorkspaceMessages(
            workspace: workspace,
            query: "release note",
            cursor: "opaque-in",
            limit: 12
        )

        XCTAssertTrue(page.messages.isEmpty)
        XCTAssertEqual(page.nextCursor, "opaque-out")
    }

    func testInviteShortLinkRequiresExplicitPublicBaseURL() {
        XCTAssertNil(MomoInviteShortLinkConfiguration.publicBaseURL(environment: [:]))
        XCTAssertNil(MomoInviteShortLinkConfiguration.publicBaseURL(environment: [
            MomoInviteShortLinkConfiguration.publicBaseURLEnvironmentKey: "file:///tmp/invites"
        ]))
        XCTAssertNil(MomoInviteShortLinkConfiguration.publicBaseURL(environment: [
            MomoInviteShortLinkConfiguration.publicBaseURLEnvironmentKey: "http://go.momo.example"
        ]))
        XCTAssertNil(MomoInviteShortLinkConfiguration.publicBaseURL(environment: [
            MomoInviteShortLinkConfiguration.publicBaseURLEnvironmentKey: "https://go.momo.example?token=unsafe"
        ]))
        XCTAssertNotNil(MomoInviteShortLinkConfiguration.publicBaseURL(environment: [
            MomoInviteShortLinkConfiguration.publicBaseURLEnvironmentKey: "http://localhost:28190"
        ]))
        let baseURL = MomoInviteShortLinkConfiguration.publicBaseURL(environment: [
            MomoInviteShortLinkConfiguration.publicBaseURLEnvironmentKey: "https://go.momo.example"
        ])

        XCTAssertEqual(
            MomoInviteShortLinkConfiguration.shortURL(
                code: "momo_raw_232",
                publicBaseURL: baseURL
            )?.absoluteString,
            "https://go.momo.example/i/momo_raw_232"
        )
    }

    @MainActor
    func testInviteShortLinkCopiesOnlyFromCurrentOneTimeCode() {
        var copiedLink: String?
        let model = MomoInviteAdminViewModel(
            context: MomoInviteAdminContext(
                baseURL: URL(string: "https://api.momo.test")!,
                workspace: .demo,
                accessToken: "token"
            ),
            publicShortLinkBaseURL: URL(string: "https://go.momo.test")!,
            copyInviteLink: { copiedLink = $0 },
            language: .korean
        )

        model.copyCreatedShortLink()
        XCTAssertNil(copiedLink)
        XCTAssertEqual(model.errorMessage, "단축 링크를 복사하려면 먼저 초대를 만드세요.")

        model.createdCode = "momo_raw_once"
        model.copyCreatedShortLink()
        XCTAssertEqual(copiedLink, "https://go.momo.test/i/momo_raw_once")
        XCTAssertNil(model.errorMessage)
        XCTAssertEqual(
            model.notice,
            "단축 초대 링크를 복사했습니다. 원본 코드는 이 화면에서만 확인할 수 있습니다."
        )

        model.discardCreatedCode()
        XCTAssertNil(model.createdCode)
        XCTAssertNil(model.createdShortLink)
    }

    func testInviteOneTimeFlowActionsFollowSelectedLanguage() {
        let korean = MomoInviteOneTimeCopy(language: .korean)
        let english = MomoInviteOneTimeCopy(language: .english)

        XCTAssertEqual(korean.copyShortLink, "단축 링크 복사")
        XCTAssertEqual(korean.savedIt, "저장했습니다")
        XCTAssertEqual(korean.inviteCreated(role: .admin), "관리자 초대를 만들었습니다. 지금 원본 코드나 단축 링크를 저장하세요.")
        XCTAssertEqual(english.copyShortLink, "Copy Short Link")
        XCTAssertEqual(english.savedIt, "I Saved It")
        XCTAssertEqual(english.shortLinkUnavailable, "A public invite link domain is not configured. Copy the raw code instead.")
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
                      "archivedAtMs": null,
                      "muted": true
                    },
                    {
                      "id": "\(agentLab.description)",
                      "workspaceId": "\(workspace.description)",
                      "kind": "public",
                      "name": "agent-lab",
                      "topic": "에이전트 실험실",
                      "dmKey": null,
                      "createdBy": "\(MemberID.demoHuman.description)",
                      "archivedAtMs": null,
                      "muted": false
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
        let muteSnapshot = await backend.channelMuteSnapshot(workspace: workspace)
        XCTAssertEqual(muteSnapshot, [.demoGeneral: true, agentLab: false])

        let requests = await MockHTTPURLProtocol.requests()
        XCTAssertEqual(requests.map { $0.httpMethod ?? "" }, ["POST", "GET"])
    }

    func testRESTBackendUpdatesChannelMutePreferenceAndCachesAuthoritativeState() async throws {
        await MockHTTPURLProtocol.reset()
        let session = URLSession(configuration: .momoMocked)
        let workspace = WorkspaceID.demo
        let channel = ChannelID.demoGeneral

        await MockHTTPURLProtocol.setHandler { request in
            XCTAssertEqual(request.httpMethod, "PUT")
            XCTAssertEqual(
                request.url?.path,
                "/v1/workspaces/\(workspace.description)/channels/\(channel.description)/notification-pref"
            )
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token-123")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
            let body = try XCTUnwrap(request.momoBodyData)
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Bool])
            XCTAssertEqual(object, ["muted": true])
            return MockHTTPResponse(json: #"{"muted":true}"#)
        }

        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(baseURL: URL(string: "https://momo.test")!),
            session: session
        )
        try await backend.connect(workspace: workspace, accessToken: "token-123")

        let muted = try await backend.setChannelMuted(channel, muted: true)
        XCTAssertTrue(muted)
        let snapshot = await backend.channelMuteSnapshot(workspace: workspace)
        XCTAssertEqual(snapshot[channel], true)
    }

    func testRESTBackendPersistsCompleteMessageInteractionContract() async throws {
        await MockHTTPURLProtocol.reset()
        let session = URLSession(configuration: .momoMocked)
        let workspace = WorkspaceID.demo
        let channel = ChannelID.demoGeneral
        let message = MessageID(uuidString: "00000000-0000-7000-8000-000000000901")!
        let token = unsignedAccessToken(for: .demoHuman)

        await MockHTTPURLProtocol.setHandler { request in
            let messagePath = "/v1/workspaces/\(workspace.description)/messages/\(message.description)"
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(token)")
            switch (request.httpMethod, request.url?.path) {
            case ("PATCH", messagePath):
                let body = try XCTUnwrap(request.momoBodyData)
                let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
                XCTAssertEqual(object, ["body": "수정된 메시지"])
                return MockHTTPResponse(json: """
                {
                  "id":"\(message.description)",
                  "channelId":"\(channel.description)",
                  "rootId":null,
                  "seq":7,
                  "hlcTs":1700000001000,
                  "hlcCount":0,
                  "authorMemberId":"\(MemberID.demoHuman.description)",
                  "type":"text",
                  "body":"수정된 메시지",
                  "props":null,
                  "runId":null,
                  "clientMsgId":null,
                  "createdAtMs":1700000000000,
                  "state":"edited",
                  "editedAtMs":1700000001000,
                  "deletedAtMs":null
                }
                """)
            case ("PUT", let path?) where path.hasSuffix("/reactions/👍"):
                XCTAssertNil(request.value(forHTTPHeaderField: "Content-Type"))
                XCTAssertNil(request.momoBodyData)
                return MockHTTPResponse(json: """
                {"action":"added","messageId":"\(message.description)","memberId":"\(MemberID.demoHuman.description)","emoji":"👍"}
                """)
            case ("DELETE", let path?) where path.hasSuffix("/reactions/👍"):
                return MockHTTPResponse(json: """
                {"action":"removed","messageId":"\(message.description)","memberId":"\(MemberID.demoHuman.description)","emoji":"👍"}
                """)
            case ("GET", "/v1/workspaces/\(workspace.description)/channels/\(channel.description)/reactions"):
                return MockHTTPResponse(json: """
                {"\(message.description)":{"👍":["\(MemberID.demoHuman.description)"]}}
                """)
            case ("DELETE", messagePath):
                return MockHTTPResponse(json: """
                {
                  "id":"\(message.description)",
                  "channelId":"\(channel.description)",
                  "rootId":null,
                  "seq":7,
                  "hlcTs":1700000002000,
                  "hlcCount":0,
                  "authorMemberId":"\(MemberID.demoHuman.description)",
                  "type":"text",
                  "props":null,
                  "runId":null,
                  "clientMsgId":null,
                  "createdAtMs":1700000000000,
                  "state":"deleted",
                  "editedAtMs":1700000001000,
                  "deletedAtMs":1700000002000
                }
                """)
            default:
                return MockHTTPResponse(statusCode: 404, json: #"{"title":"unexpected interaction request"}"#)
            }
        }

        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(baseURL: URL(string: "https://momo.test")!),
            session: session
        )
        try await backend.connect(workspace: workspace, accessToken: token)

        let edited = try await backend.editMessage(message, body: "수정된 메시지")
        XCTAssertEqual(edited.state, .edited)
        XCTAssertEqual(edited.editedAtMs, 1_700_000_001_000)
        try await backend.addReaction(message, emoji: "👍")
        try await backend.removeReaction(message, emoji: "👍")
        let reactions = try await backend.reactionSnapshot(channel: channel)
        XCTAssertEqual(reactions[message]?["👍"], [.demoHuman])
        let deleted = try await backend.deleteMessage(message)
        XCTAssertEqual(deleted.state, .deleted)
        XCTAssertNil(deleted.body)
        XCTAssertEqual(deleted.deletedAtMs, 1_700_000_002_000)

        let requests = await MockHTTPURLProtocol.requests()
        XCTAssertEqual(requests.map(\.httpMethod), ["PATCH", "PUT", "DELETE", "GET", "DELETE"])
        XCTAssertTrue(requests[1].url?.absoluteString.contains("%F0%9F%91%8D") == true)
    }

    func testRESTBackendEncodesReactionAsOneURLPathSegment() async throws {
        await MockHTTPURLProtocol.reset()
        let session = URLSession(configuration: .momoMocked)
        let workspace = WorkspaceID.demo
        let message = MessageID(uuidString: "00000000-0000-7000-8000-000000000906")!
        let token = unsignedAccessToken(for: .demoHuman)

        await MockHTTPURLProtocol.setHandler { request in
            let url = try XCTUnwrap(request.url)
            XCTAssertTrue(url.absoluteString.hasSuffix("/reactions/a%2Fb"))
            let percentEncodedPath = try XCTUnwrap(
                URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath
            )
            XCTAssertEqual(percentEncodedPath.split(separator: "/").last, "a%2Fb")
            switch request.httpMethod {
            case "PUT":
                return MockHTTPResponse(json: """
                {"action":"added","messageId":"\(message.description)","memberId":"\(MemberID.demoHuman.description)","emoji":"a/b"}
                """)
            case "DELETE":
                return MockHTTPResponse(json: """
                {"action":"removed","messageId":"\(message.description)","memberId":"\(MemberID.demoHuman.description)","emoji":"a/b"}
                """)
            default:
                return MockHTTPResponse(statusCode: 404, json: #"{"title":"unexpected reaction request"}"#)
            }
        }

        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(baseURL: URL(string: "https://momo.test")!),
            session: session
        )
        try await backend.connect(workspace: workspace, accessToken: token)

        try await backend.addReaction(message, emoji: "a/b")
        try await backend.removeReaction(message, emoji: "a/b")

        let requests = await MockHTTPURLProtocol.requests()
        XCTAssertEqual(requests.map(\.httpMethod), ["PUT", "DELETE"])
        XCTAssertTrue(requests.allSatisfy { $0.url?.absoluteString.contains("/reactions/a%2Fb") == true })
    }

    func testRESTBackendDelayedEditCannotCrossReconnectedSession() async throws {
        await MockHTTPURLProtocol.reset()
        let workspaceA = WorkspaceID.demo
        let workspaceB = WorkspaceID(uuidString: "00000000-0000-7000-8000-000000000002")!
        let channel = ChannelID.demoGeneral
        let message = MessageID(uuidString: "00000000-0000-7000-8000-000000000902")!
        let path = "/v1/workspaces/\(workspaceA.description)/messages/\(message.description)"
        let controller = BlockingPathResponseController(
            responses: [
                path: MockHTTPResponse(json: """
                {
                  "id":"\(message.description)",
                  "channelId":"\(channel.description)",
                  "rootId":null,
                  "seq":8,
                  "hlcTs":1700000003000,
                  "hlcCount":0,
                  "authorMemberId":"\(MemberID.demoHuman.description)",
                  "type":"text",
                  "body":"late edit",
                  "createdAtMs":1700000000000,
                  "state":"edited",
                  "editedAtMs":1700000003000
                }
                """)
            ],
            blockedPaths: [path]
        )
        await MockHTTPURLProtocol.setHandler { request in
            controller.response(for: request)
        }
        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(baseURL: URL(string: "https://momo.test")!),
            session: URLSession(configuration: .momoMocked)
        )
        try await backend.connect(workspace: workspaceA, accessToken: "token-a")
        let edit = Task {
            try await backend.editMessage(message, body: "late edit")
        }
        await controller.waitForArrival(path: path)

        try await backend.connect(workspace: workspaceB, accessToken: "token-b")
        controller.release(path: path)

        do {
            _ = try await edit.value
            XCTFail("stale edit response must not cross into the reconnected session")
        } catch is CancellationError {
            // Expected: generation/workspace/token no longer match.
        } catch {
            XCTFail("unexpected error: \(error)")
        }
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
            case ("GET", "/v1/workspaces/\(workspace.description)"):
                return MockHTTPResponse(json: """
                {"workspace":{
                  "id":"\(workspace.description)",
                  "slug":"momo-demo",
                  "name":"momo",
                  "updatedAtMs":1800000000000
                }}
                """)
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
                      "capabilities": ["code", "terminal"],
                      "channelIds": ["\(channel.description)"]
                    },
                    {
                      "id": "\(uninvitedAgent.description)",
                      "workspaceId": "\(workspace.description)",
                      "kind": "agent",
                      "status": "active",
                      "displayName": "김인턴",
                      "handle": "kim-intern",
                      "capabilities": ["code"],
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
                  "archivedAtMs":null,
                  "muted":false
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
        XCTAssertEqual(viewModel.member(invitedAgent)?.normalizedCapabilities, ["code", "terminal"])
        XCTAssertEqual(viewModel.workAgentCandidates(requiring: "terminal").map(\.id), [invitedAgent])
        XCTAssertFalse(viewModel.workAgentCandidates(requiring: "code").contains { $0.id == uninvitedAgent })
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
                    "archivedAtMs": null,
                    "muted": false
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

    func testRESTBackendRejectsCrossWorkspaceChannelCreateResponse() async throws {
        await MockHTTPURLProtocol.reset()
        let workspace = WorkspaceID.demo
        let otherWorkspace = WorkspaceID(uuidString: "00000000-0000-7000-8000-000000000002")!
        let channel = ChannelID(uuidString: "00000000-0000-7000-8000-000000384401")!
        let membership = UUID(uuidString: "00000000-0000-7000-8000-000000384402")!
        await MockHTTPURLProtocol.setHandler { _ in
            MockHTTPResponse(statusCode: 201, json: """
            {
              "channel": {
                "id": "\(channel.description)",
                "workspaceId": "\(otherWorkspace.description)",
                "kind": "public",
                "name": "wrong-scope",
                "topic": null,
                "dmKey": null,
                "createdBy": "\(MemberID.demoHuman.description)",
                "archivedAtMs": null,
                "muted": false
              },
              "creatorMembership": {
                "id": "\(membership.uuidString)",
                "workspaceId": "\(otherWorkspace.description)",
                "channelId": "\(channel.description)",
                "memberId": "\(MemberID.demoHuman.description)",
                "role": "owner",
                "joinedAtMs": 1782864000000,
                "leftAtMs": null
              }
            }
            """)
        }
        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(
                baseURL: URL(string: "https://momo.test")!,
                accessToken: "token-123"
            ),
            session: URLSession(configuration: .momoMocked)
        )
        try await backend.connect(workspace: workspace, accessToken: "token-123")

        do {
            _ = try await backend.createChannel(
                workspace: workspace,
                kind: .publicChannel,
                name: "wrong-scope",
                topic: nil
            )
            XCTFail("cross-workspace create response should be rejected")
        } catch BackendError.decoding(let reason) {
            XCTAssertEqual(reason, "channel create response scope mismatch")
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testRESTBackendOpensIdempotentDirectMessageWithParticipants() async throws {
        await MockHTTPURLProtocol.reset()
        let session = URLSession(configuration: .momoMocked)
        let workspace = WorkspaceID.demo
        let target = MemberID.demoAgent
        let channel = ChannelID(uuidString: "00000000-0000-7000-8000-000000372201")!
        let accessToken = unsignedAccessToken(for: .demoHuman)

        await MockHTTPURLProtocol.setHandler { request in
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/v1/workspaces/\(workspace.description)/dms"):
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(accessToken)")
                let data = try XCTUnwrap(request.momoBodyData)
                let body = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                XCTAssertEqual(body?["memberId"] as? String, target.rawValue.uuidString)
                return MockHTTPResponse(json: """
                {
                  "channel": {
                    "id": "\(channel.description)",
                    "workspaceId": "\(workspace.description)",
                    "kind": "dm",
                    "name": null,
                    "topic": null,
                    "dmKey": "pair-hash",
                    "memberIds": [
                      "\(MemberID.demoHuman.description)",
                      "\(target.description)"
                    ],
                    "createdBy": "\(MemberID.demoHuman.description)",
                    "archivedAtMs": null,
                    "muted": false
                  },
                  "created": false
                }
                """)
            default:
                return MockHTTPResponse(statusCode: 404, json: #"{"title":"unexpected"}"#)
            }
        }

        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(
                baseURL: URL(string: "https://momo.test")!,
                accessToken: accessToken
            ),
            session: session
        )
        try await backend.connect(workspace: workspace, accessToken: accessToken)

        let opened = try await backend.openDirectMessage(workspace: workspace, with: target)

        XCTAssertEqual(opened.id, channel)
        XCTAssertEqual(Set(opened.dmMemberIds), Set([MemberID.demoHuman, target]))
    }

    func testRESTBackendUsesAuthenticatedLoginMemberWhenDirectMessageJWTIsMalformed() async throws {
        await MockHTTPURLProtocol.reset()
        let session = URLSession(configuration: .momoMocked)
        let workspace = WorkspaceID.demo
        let target = MemberID.demoAgent
        let channel = ChannelID(uuidString: "00000000-0000-7000-8000-000000372204")!

        await MockHTTPURLProtocol.setHandler { request in
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/v1/auth/login"):
                return MockHTTPResponse(json: """
                {
                  "accessToken": "malformed-token",
                  "refreshToken": "refresh-token",
                  "realtimeWebSocketUrl": null,
                  "member": {
                    "id": "\(MemberID.demoHuman.description)",
                    "workspaceId": "\(workspace.description)",
                    "kind": "human",
                    "status": "active",
                    "displayName": "상준",
                    "handle": "sangjun",
                    "avatarUrl": null,
                    "role": "owner",
                    "channelIds": [],
                    "capabilities": []
                  }
                }
                """)
            case ("POST", "/v1/workspaces/\(workspace.description)/dms"):
                return MockHTTPResponse(json: """
                {
                  "channel": {
                    "id": "\(channel.description)",
                    "workspaceId": "\(workspace.description)",
                    "kind": "dm",
                    "name": null,
                    "topic": null,
                    "dmKey": "authenticated-member-pair",
                    "memberIds": [
                      "\(MemberID.demoHuman.description)",
                      "\(target.description)"
                    ],
                    "createdBy": "\(MemberID.demoHuman.description)",
                    "archivedAtMs": null,
                    "muted": false
                  },
                  "created": true
                }
                """)
            default:
                return MockHTTPResponse(statusCode: 404, json: #"{"title":"unexpected"}"#)
            }
        }

        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(
                baseURL: URL(string: "https://momo.test")!
            ),
            session: session
        )
        try await backend.connect(workspace: workspace, accessToken: "")

        let opened = try await backend.openDirectMessage(workspace: workspace, with: target)
        let authenticatedMemberID = await backend.authenticatedMemberID()
        XCTAssertEqual(opened.id, channel)
        XCTAssertEqual(authenticatedMemberID, .demoHuman)
    }

    func testRESTBackendRejectsDirectMessageWithoutAuthenticatedMemberOrJWTSubject() async throws {
        await MockHTTPURLProtocol.reset()
        let workspace = WorkspaceID.demo
        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(
                baseURL: URL(string: "https://momo.test")!,
                accessToken: "malformed-token"
            ),
            session: URLSession(configuration: .momoMocked)
        )
        try await backend.connect(workspace: workspace, accessToken: "malformed-token")

        do {
            _ = try await backend.openDirectMessage(workspace: workspace, with: .demoAgent)
            XCTFail("a DM request without a trusted current member must fail closed")
        } catch BackendError.notConnected {
            // Expected before any request is emitted.
        } catch {
            XCTFail("unexpected error: \(error)")
        }
        let requests = await MockHTTPURLProtocol.requests()
        XCTAssertTrue(requests.isEmpty)
    }

    func testRESTBackendRejectsDirectMessageResponseOutsideRequestedPair() async throws {
        await MockHTTPURLProtocol.reset()
        let session = URLSession(configuration: .momoMocked)
        let workspace = WorkspaceID.demo
        let target = MemberID.demoAgent
        let other = MemberID(uuidString: "00000000-0000-7000-8000-000000372299")!
        let channel = ChannelID(uuidString: "00000000-0000-7000-8000-000000372202")!
        let accessToken = unsignedAccessToken(for: .demoHuman)

        await MockHTTPURLProtocol.setHandler { _ in
            MockHTTPResponse(json: """
            {
              "channel": {
                "id": "\(channel.description)",
                "workspaceId": "\(workspace.description)",
                "kind": "dm",
                "name": null,
                "topic": null,
                "dmKey": "wrong-pair",
                "memberIds": [
                  "\(MemberID.demoHuman.description)",
                  "\(other.description)"
                ],
                "createdBy": "\(MemberID.demoHuman.description)",
                "archivedAtMs": null,
                "muted": false
              },
              "created": true
            }
            """)
        }

        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(
                baseURL: URL(string: "https://momo.test")!,
                accessToken: accessToken
            ),
            session: session
        )
        try await backend.connect(workspace: workspace, accessToken: accessToken)

        do {
            _ = try await backend.openDirectMessage(workspace: workspace, with: target)
            XCTFail("a mismatched DM pair must not enter the client cache")
        } catch BackendError.decoding(let reason) {
            XCTAssertEqual(reason, "direct message response scope mismatch")
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testRESTBackendRejectsMalformedDirectMessageParticipantSets() async throws {
        let workspace = WorkspaceID.demo
        let target = MemberID.demoAgent
        let other = MemberID(uuidString: "00000000-0000-7000-8000-000000372298")!
        let channel = ChannelID(uuidString: "00000000-0000-7000-8000-000000372205")!
        let accessToken = unsignedAccessToken(for: .demoHuman)
        let cases: [(String, [String])] = [
            ("extra", [MemberID.demoHuman.description, target.description, other.description]),
            ("duplicate", [MemberID.demoHuman.description, MemberID.demoHuman.description]),
            ("invalid", [MemberID.demoHuman.description, "not-a-member-id"]),
        ]

        for (name, memberIDs) in cases {
            await MockHTTPURLProtocol.reset()
            let memberIDsData = try JSONSerialization.data(withJSONObject: memberIDs)
            let memberIDsJSON = try XCTUnwrap(String(data: memberIDsData, encoding: .utf8))
            await MockHTTPURLProtocol.setHandler { _ in
                MockHTTPResponse(json: """
                {
                  "channel": {
                    "id": "\(channel.description)",
                    "workspaceId": "\(workspace.description)",
                    "kind": "dm",
                    "name": null,
                    "topic": null,
                    "dmKey": "\(name)-pair",
                    "memberIds": \(memberIDsJSON),
                    "createdBy": "\(MemberID.demoHuman.description)",
                    "archivedAtMs": null,
                    "muted": false
                  },
                  "created": true
                }
                """)
            }
            let backend = MomoServerRESTChatBackend(
                config: MomoServerRESTChatBackendConfig(
                    baseURL: URL(string: "https://momo.test")!,
                    accessToken: accessToken
                ),
                session: URLSession(configuration: .momoMocked)
            )
            try await backend.connect(workspace: workspace, accessToken: accessToken)

            do {
                _ = try await backend.openDirectMessage(workspace: workspace, with: target)
                XCTFail("\(name) DM participants must be rejected")
            } catch BackendError.decoding(let reason) {
                XCTAssertEqual(reason, "direct message response scope mismatch")
            } catch {
                XCTFail("unexpected \(name) error: \(error)")
            }
        }
    }

    func testRESTBackendRejectsSelfDirectMessageBeforeRequest() async throws {
        await MockHTTPURLProtocol.reset()
        let workspace = WorkspaceID.demo
        let accessToken = unsignedAccessToken(for: .demoHuman)
        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(
                baseURL: URL(string: "https://momo.test")!,
                accessToken: accessToken
            ),
            session: URLSession(configuration: .momoMocked)
        )
        try await backend.connect(workspace: workspace, accessToken: accessToken)

        do {
            _ = try await backend.openDirectMessage(workspace: workspace, with: .demoHuman)
            XCTFail("self-DM must fail before a request is emitted")
        } catch BackendError.decoding(let reason) {
            XCTAssertEqual(reason, "direct message target must differ from current member")
        } catch {
            XCTFail("unexpected error: \(error)")
        }
        let requests = await MockHTTPURLProtocol.requests()
        XCTAssertTrue(requests.isEmpty)
    }

    func testRESTBackendDiscardsDirectMessageResponseAfterSessionClear() async throws {
        await MockHTTPURLProtocol.reset()
        let session = URLSession(configuration: .momoMocked)
        let workspace = WorkspaceID.demo
        let target = MemberID.demoAgent
        let channel = ChannelID(uuidString: "00000000-0000-7000-8000-000000372203")!
        let path = "/v1/workspaces/\(workspace.description)/dms"
        let accessToken = unsignedAccessToken(for: .demoHuman)
        let controller = BlockingPathResponseController(
            responses: [
                path: MockHTTPResponse(json: """
                {
                  "channel": {
                    "id": "\(channel.description)",
                    "workspaceId": "\(workspace.description)",
                    "kind": "dm",
                    "name": null,
                    "topic": null,
                    "dmKey": "delayed-pair",
                    "memberIds": [
                      "\(MemberID.demoHuman.description)",
                      "\(target.description)"
                    ],
                    "createdBy": "\(MemberID.demoHuman.description)",
                    "archivedAtMs": null,
                    "muted": false
                  },
                  "created": true
                }
                """)
            ],
            blockedPaths: [path]
        )
        await MockHTTPURLProtocol.setHandler { request in
            controller.response(for: request)
        }

        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(
                baseURL: URL(string: "https://momo.test")!,
                accessToken: accessToken
            ),
            session: session
        )
        try await backend.connect(workspace: workspace, accessToken: accessToken)
        let openTask = Task {
            try await backend.openDirectMessage(workspace: workspace, with: target)
        }
        await controller.waitForArrival(path: path)
        await backend.clearSessionSensitiveState()
        controller.release(path: path)

        do {
            _ = try await openTask.value
            XCTFail("a delayed DM response must not survive session clear")
        } catch is CancellationError {
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    @MainActor
    func testViewModelStartsOneIdempotentDirectMessageAndSelectsIt() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "demo")
        let target = try XCTUnwrap(seed.agents.first)

        let firstOpen = await viewModel.startDirectMessage(with: target.id)
        let firstDM = try XCTUnwrap(viewModel.channels.first { $0.kind == .dm })
        XCTAssertEqual(firstOpen, .opened(firstDM.id))
        let repeatedOpen = await viewModel.startDirectMessage(with: target.id)
        XCTAssertEqual(repeatedOpen, .opened(firstDM.id))

        XCTAssertEqual(viewModel.channels.filter { $0.kind == .dm }.count, 1)
        XCTAssertEqual(viewModel.selectedChannelId, firstDM.id)
        XCTAssertEqual(viewModel.directMessageCounterpart(for: firstDM)?.id, target.id)
        XCTAssertTrue(viewModel.member(target.id)?.channelIds.contains(firstDM.id) == true)
        XCTAssertNil(viewModel.directMessageError)
    }

    @MainActor
    func testViewModelRejectsSelfDirectMessageWithoutChangingSelection() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "demo")
        let originalChannel = try XCTUnwrap(viewModel.selectedChannelId)
        let currentMember = try XCTUnwrap(viewModel.authenticatedMember)

        let selfOpen = await viewModel.startDirectMessage(with: currentMember.id)
        XCTAssertEqual(selfOpen, .ignored)
        XCTAssertEqual(viewModel.selectedChannelId, originalChannel)
        XCTAssertTrue(viewModel.channels.allSatisfy { $0.kind != .dm })
        XCTAssertTrue(viewModel.directMessageMutationIds.isEmpty)
        XCTAssertNil(viewModel.directMessageError)
    }

    @MainActor
    func testViewModelKeepsNewestDirectMessageNavigationIntent() async throws {
        let base = LiveChatBackend()
        let seed = await base.seedDemo()
        let backend = ControlledDirectMessageBackend(base: base)
        let viewModel = ChatViewModel(chat: backend, agentTransport: base)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "demo")
        let currentMember = try XCTUnwrap(viewModel.authenticatedMember)
        let targets = viewModel.members.filter { $0.id != currentMember.id && $0.status == .active }
        let targetA = try XCTUnwrap(targets.first)
        let targetB = try XCTUnwrap(targets.dropFirst().first)
        let channelA = Channel(
            id: ChannelID(uuidString: "00000000-0000-7000-8000-000000372211")!,
            workspaceId: seed.workspace,
            kind: .dm,
            dmMemberIds: [currentMember.id, targetA.id]
        )
        let channelB = Channel(
            id: ChannelID(uuidString: "00000000-0000-7000-8000-000000372212")!,
            workspaceId: seed.workspace,
            kind: .dm,
            dmMemberIds: [currentMember.id, targetB.id]
        )
        await backend.setOutcome(.success(channelA), for: targetA.id)
        await backend.setOutcome(.success(channelB), for: targetB.id)

        let openA = Task { await viewModel.startDirectMessage(with: targetA.id) }
        await backend.waitForOpen(with: targetA.id)
        let openB = Task { await viewModel.startDirectMessage(with: targetB.id) }
        await backend.waitForOpen(with: targetB.id)
        await backend.releaseOpen(with: targetB.id)
        let outcomeB = await openB.value
        XCTAssertEqual(outcomeB, .opened(channelB.id))
        await backend.releaseOpen(with: targetA.id)
        let outcomeA = await openA.value
        XCTAssertEqual(outcomeA, .ignored)

        XCTAssertEqual(viewModel.selectedChannelId, channelB.id)
        XCTAssertTrue(viewModel.channels.contains { $0.id == channelA.id })
        XCTAssertTrue(viewModel.channels.contains { $0.id == channelB.id })
        XCTAssertNil(viewModel.directMessageError)
    }

    @MainActor
    func testViewModelManualSelectionInvalidatesDelayedDirectMessageNavigationAndFailure() async throws {
        let base = LiveChatBackend()
        let seed = await base.seedDemo()
        let backend = ControlledDirectMessageBackend(base: base)
        let viewModel = ChatViewModel(chat: backend, agentTransport: base)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "demo")
        let originalChannel = try XCTUnwrap(viewModel.selectedChannelId)
        let currentMember = try XCTUnwrap(viewModel.authenticatedMember)
        let targets = viewModel.members.filter { $0.id != currentMember.id && $0.status == .active }
        let successTarget = try XCTUnwrap(targets.first)
        let failureTarget = try XCTUnwrap(targets.dropFirst().first)
        let delayedChannel = Channel(
            id: ChannelID(uuidString: "00000000-0000-7000-8000-000000372213")!,
            workspaceId: seed.workspace,
            kind: .dm,
            dmMemberIds: [currentMember.id, successTarget.id]
        )
        await backend.setOutcome(.success(delayedChannel), for: successTarget.id)
        await backend.setOutcome(
            .failure(.problem(status: 503, title: "Unavailable", detail: nil)),
            for: failureTarget.id
        )

        let delayedSuccess = Task { await viewModel.startDirectMessage(with: successTarget.id) }
        await backend.waitForOpen(with: successTarget.id)
        await viewModel.selectChannel(originalChannel)
        await backend.releaseOpen(with: successTarget.id)
        let delayedSuccessOutcome = await delayedSuccess.value
        XCTAssertEqual(delayedSuccessOutcome, .ignored)
        XCTAssertEqual(viewModel.selectedChannelId, originalChannel)
        XCTAssertTrue(viewModel.channels.contains { $0.id == delayedChannel.id })

        let delayedFailure = Task { await viewModel.startDirectMessage(with: failureTarget.id) }
        await backend.waitForOpen(with: failureTarget.id)
        await viewModel.selectChannel(originalChannel)
        await backend.releaseOpen(with: failureTarget.id)
        let delayedFailureOutcome = await delayedFailure.value
        XCTAssertEqual(delayedFailureOutcome, .ignored)
        XCTAssertNil(viewModel.directMessageError)

        await backend.setOutcome(
            .failure(.problem(status: 503, title: "Unavailable", detail: nil)),
            for: failureTarget.id
        )
        let currentFailure = Task { await viewModel.startDirectMessage(with: failureTarget.id) }
        await backend.waitForOpen(with: failureTarget.id)
        await backend.releaseOpen(with: failureTarget.id)
        let currentFailureOutcome = await currentFailure.value
        XCTAssertEqual(currentFailureOutcome, .failed)
        XCTAssertNotNil(viewModel.directMessageError)
    }

    @MainActor
    func testViewModelHistoryNavigationInvalidatesDelayedDirectMessageNavigation() async throws {
        let base = LiveChatBackend()
        let seed = await base.seedDemo()
        let backend = ControlledDirectMessageBackend(base: base)
        let viewModel = ChatViewModel(chat: backend, agentTransport: base)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "demo")
        let firstChannel = try XCTUnwrap(viewModel.selectedChannelId)
        let secondChannel = try XCTUnwrap(seed.channels.first { $0.id != firstChannel })
        await viewModel.selectChannel(secondChannel.id)
        let currentMember = try XCTUnwrap(viewModel.authenticatedMember)
        let targets = viewModel.members.filter { $0.id != currentMember.id && $0.status == .active }
        let backTarget = try XCTUnwrap(targets.first)
        let forwardTarget = try XCTUnwrap(targets.dropFirst().first)
        let backDM = Channel(
            id: ChannelID(uuidString: "00000000-0000-7000-8000-000000372214")!,
            workspaceId: seed.workspace,
            kind: .dm,
            dmMemberIds: [currentMember.id, backTarget.id]
        )
        let forwardDM = Channel(
            id: ChannelID(uuidString: "00000000-0000-7000-8000-000000372215")!,
            workspaceId: seed.workspace,
            kind: .dm,
            dmMemberIds: [currentMember.id, forwardTarget.id]
        )
        await backend.setOutcome(.success(backDM), for: backTarget.id)
        await backend.setOutcome(.success(forwardDM), for: forwardTarget.id)

        let pendingBack = Task { await viewModel.startDirectMessage(with: backTarget.id) }
        await backend.waitForOpen(with: backTarget.id)
        await viewModel.navigateChannelHistoryBackward()
        XCTAssertEqual(viewModel.selectedChannelId, firstChannel)
        await backend.releaseOpen(with: backTarget.id)
        let backOutcome = await pendingBack.value
        XCTAssertEqual(backOutcome, .ignored)
        XCTAssertEqual(viewModel.selectedChannelId, firstChannel)

        let pendingForward = Task { await viewModel.startDirectMessage(with: forwardTarget.id) }
        await backend.waitForOpen(with: forwardTarget.id)
        await viewModel.navigateChannelHistoryForward()
        XCTAssertEqual(viewModel.selectedChannelId, secondChannel.id)
        await backend.releaseOpen(with: forwardTarget.id)
        let forwardOutcome = await pendingForward.value
        XCTAssertEqual(forwardOutcome, .ignored)
        XCTAssertEqual(viewModel.selectedChannelId, secondChannel.id)
        XCTAssertNil(viewModel.directMessageError)
    }

    @MainActor
    func testViewModelChannelCreationInvalidatesDelayedDirectMessageNavigation() async throws {
        let base = LiveChatBackend()
        let seed = await base.seedDemo()
        let backend = ControlledDirectMessageBackend(base: base)
        let viewModel = ChatViewModel(chat: backend, agentTransport: base)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "demo")
        let currentMember = try XCTUnwrap(viewModel.authenticatedMember)
        let target = try XCTUnwrap(viewModel.members.first { $0.id != currentMember.id && $0.status == .active })
        let delayedDM = Channel(
            id: ChannelID(uuidString: "00000000-0000-7000-8000-000000372216")!,
            workspaceId: seed.workspace,
            kind: .dm,
            dmMemberIds: [currentMember.id, target.id]
        )
        await backend.setOutcome(.success(delayedDM), for: target.id)

        let pendingDM = Task { await viewModel.startDirectMessage(with: target.id) }
        await backend.waitForOpen(with: target.id)
        let created = await viewModel.createChannel(
            kind: .privateChannel,
            name: "dm-race-created",
            topic: "navigation intent regression"
        )
        XCTAssertTrue(created)
        let createdChannel = try XCTUnwrap(viewModel.channels.first { $0.name == "dm-race-created" })
        XCTAssertEqual(viewModel.selectedChannelId, createdChannel.id)

        await backend.releaseOpen(with: target.id)
        let dmOutcome = await pendingDM.value
        XCTAssertEqual(dmOutcome, .ignored)
        XCTAssertEqual(viewModel.selectedChannelId, createdChannel.id)
        XCTAssertTrue(viewModel.channels.contains { $0.id == delayedDM.id })
        XCTAssertNil(viewModel.directMessageError)
    }

    @MainActor
    func testViewModelCancelledDirectMessageIgnoresCancellationInsensitiveBackendResult() async throws {
        let base = LiveChatBackend()
        let seed = await base.seedDemo()
        let backend = ControlledDirectMessageBackend(base: base)
        let viewModel = ChatViewModel(chat: backend, agentTransport: base)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "demo")
        let originalChannel = try XCTUnwrap(viewModel.selectedChannelId)
        let currentMember = try XCTUnwrap(viewModel.authenticatedMember)
        let target = try XCTUnwrap(viewModel.members.first { $0.id != currentMember.id && $0.status == .active })
        let cancelledDM = Channel(
            id: ChannelID(uuidString: "00000000-0000-7000-8000-000000372217")!,
            workspaceId: seed.workspace,
            kind: .dm,
            dmMemberIds: [currentMember.id, target.id]
        )
        await backend.setOutcome(.success(cancelledDM), for: target.id)

        let pendingDM = Task { await viewModel.startDirectMessage(with: target.id) }
        await backend.waitForOpen(with: target.id)
        pendingDM.cancel()
        await backend.releaseOpen(with: target.id)

        let dmOutcome = await pendingDM.value
        XCTAssertEqual(dmOutcome, .ignored)
        XCTAssertEqual(viewModel.selectedChannelId, originalChannel)
        XCTAssertFalse(viewModel.channels.contains { $0.id == cancelledDM.id })
        XCTAssertNil(viewModel.directMessageError)
        XCTAssertTrue(viewModel.directMessageMutationIds.isEmpty)
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
        let didCreate = await viewModel.createChannel(
            kind: .privateChannel,
            name: "ops-lab",
            topic: "internal test"
        )
        XCTAssertTrue(didCreate)

        let created = try XCTUnwrap(viewModel.channels.first(where: { $0.name == "ops-lab" }))
        XCTAssertEqual(viewModel.selectedChannelId, created.id)
        XCTAssertFalse(viewModel.isMember(agent.id, in: created.id))

        await viewModel.addMember(agent.id, to: created.id)
        XCTAssertTrue(viewModel.isMember(agent.id, in: created.id))

        await viewModel.removeMember(agent.id, from: created.id)
        XCTAssertFalse(viewModel.isMember(agent.id, in: created.id))

        let didCreateDuplicate = await viewModel.createChannel(kind: .publicChannel, name: "ops-lab")
        XCTAssertFalse(didCreateDuplicate)
        XCTAssertEqual(viewModel.channelCreateIssue, .duplicateName)
        XCTAssertNil(viewModel.connectionError)
        XCTAssertNil(viewModel.connectionIssue)
    }

    func testDemoBackendRejectsMembershipMutationForDirectMessages() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        try await backend.connect(workspace: seed.workspace, accessToken: "t")
        let agent = try XCTUnwrap(seed.agents.first)
        let human = seed.human
        let directMessage = try await backend.openDirectMessage(
            workspace: seed.workspace,
            with: agent.id
        )

        do {
            _ = try await backend.addMember(human.id, to: directMessage.id, role: .member)
            XCTFail("DM membership must remain immutable")
        } catch let BackendError.problem(status, _, _) {
            XCTAssertEqual(status, 404)
        }

        do {
            _ = try await backend.removeMember(agent.id, from: directMessage.id)
            XCTFail("DM membership must remain immutable")
        } catch let BackendError.problem(status, _, _) {
            XCTAssertEqual(status, 404)
        }
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
            case ("GET", "/v1/workspaces/\(workspace.description)"):
                return MockHTTPResponse(json: """
                {"workspace":{
                  "id":"\(workspace.description)",
                  "slug":"momo-demo",
                  "name":"momo",
                  "updatedAtMs":1800000000000
                }}
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
        XCTAssertEqual(viewModel.connectionIssue, .loadFailed)
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

    func testRESTBackendMapsNestedServerErrorContractToProblemDetail() async throws {
        await MockHTTPURLProtocol.reset()
        await MockHTTPURLProtocol.setHandler { _ in
            MockHTTPResponse(
                statusCode: 409,
                json: #"{"error":{"code":"reaction_limit","message":"Reaction limit reached"}}"#
            )
        }

        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(
                baseURL: URL(string: "https://momo.test")!,
                accessToken: "token-123"
            ),
            session: URLSession(configuration: .momoMocked)
        )
        try await backend.connect(workspace: .demo, accessToken: "token-123")

        do {
            try await backend.addReaction(MessageID(), emoji: "👍")
            XCTFail("reaction should fail on 409")
        } catch BackendError.problem(let status, let title, let detail) {
            XCTAssertEqual(status, 409)
            XCTAssertEqual(title, "reaction_limit")
            XCTAssertEqual(detail, "Reaction limit reached")
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    @MainActor
    func testViewModelClassifiesUnauthorizedAsExpiredSession() async throws {
        await MockHTTPURLProtocol.reset()
        await MockHTTPURLProtocol.setHandler { _ in
            MockHTTPResponse(
                statusCode: 401,
                json: #"{"title":"internal auth dump","detail":"expired-token-should-not-render"}"#
            )
        }

        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(
                baseURL: URL(string: "https://momo.test")!,
                accessToken: "expired-token"
            ),
            session: URLSession(configuration: .momoMocked)
        )
        let viewModel = ChatViewModel(chat: backend, agentTransport: backend)

        await viewModel.bootstrap(workspace: .demo, accessToken: "expired-token")

        XCTAssertEqual(viewModel.connectionIssue, .authenticationExpired)
        XCTAssertNotNil(viewModel.connectionError, "diagnostic detail remains available outside user chrome")
        XCTAssertEqual(MomoWorkspaceCopy(language: .korean).sessionExpiredDetail, "계속하려면 다시 로그인하세요.")
        let commandCenter = viewModel.alphaCommandCenterSnapshot()
        XCTAssertFalse(commandCenter.statuses.contains { $0.detail.contains("internal auth dump") })
        XCTAssertFalse(commandCenter.statuses.contains { $0.detail.contains("expired-token-should-not-render") })
    }

    @MainActor
    func testFailedAgentMentionUsesSendRecoveryAndRetriesSameIdempotencyKey() async throws {
        let liveBackend = LiveChatBackend()
        let seed = await liveBackend.seedDemo()
        let backend = RetryOnceSendChatBackend(base: liveBackend)
        let viewModel = ChatViewModel(chat: backend, agentTransport: liveBackend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "t")
        let channel = seed.channels[0].id
        await viewModel.selectChannel(channel)
        let agent = try XCTUnwrap(seed.agents.first { $0.handle == "hermes" })

        await viewModel.send(body: "@\(agent.handle) summarize this", to: channel)

        XCTAssertEqual(viewModel.connectionIssue, .sendFailed)
        XCTAssertEqual(viewModel.failedMentionedAgentName, agent.displayName)
        XCTAssertNil(viewModel.mentionNotice)
        XCTAssertEqual(
            MomoWorkspaceCopy(language: .korean).agentCallSendFailedTitle(agent.displayName),
            "\(agent.displayName) 호출을 보내지 못했습니다"
        )
        let firstAttempts = await backend.attemptedClientMessageIDs()
        XCTAssertEqual(firstAttempts.count, 1)

        await viewModel.retryFailedSend()

        XCTAssertNil(viewModel.connectionIssue)
        XCTAssertNil(viewModel.connectionError)
        XCTAssertNil(viewModel.failedMentionedAgentName)
        let allAttempts = await backend.attemptedClientMessageIDs()
        XCTAssertEqual(allAttempts.count, 2)
        XCTAssertEqual(allAttempts[0], allAttempts[1], "retry must preserve the send idempotency key")
        let matchingMessages = viewModel.visibleMessages.filter { $0.clientMsgId == allAttempts[0] }
        XCTAssertEqual(matchingMessages.count, 1)
        XCTAssertNotNil(matchingMessages.first?.seq)
    }

    @MainActor
    func testFailedReplyRetriesSameIdempotencyKeyWithoutLeavingGhost() async throws {
        let liveBackend = LiveChatBackend()
        let seed = await liveBackend.seedDemo()
        let root = await liveBackend.seedDemoMessage(
            channel: seed.channels[0].id,
            author: seed.human.id,
            body: "답글 루트"
        )
        let backend = RetryOnceSendChatBackend(base: liveBackend)
        let viewModel = ChatViewModel(chat: backend, agentTransport: liveBackend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "t")

        XCTAssertFalse(viewModel.supportsMessageInteractions)
        let firstDidSend = await viewModel.sendReply(body: "동일 답글", to: root)
        XCTAssertFalse(firstDidSend)
        let firstAttempts = await backend.attemptedClientMessageIDs()
        XCTAssertEqual(firstAttempts.count, 1)
        XCTAssertEqual(
            viewModel.replies(to: root).filter { $0.clientMsgId == firstAttempts[0] }.first?.state,
            .failed
        )

        await viewModel.retryFailedSend()
        let allAttempts = await backend.attemptedClientMessageIDs()
        XCTAssertEqual(allAttempts.count, 2)
        XCTAssertEqual(allAttempts[0], allAttempts[1])
        let matchingReplies = viewModel.replies(to: root).filter {
            $0.clientMsgId == allAttempts[0]
        }
        XCTAssertEqual(matchingReplies.count, 1)
        XCTAssertNotNil(matchingReplies.first?.seq)
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
            copyInviteCode: { copiedCode = $0 },
            language: .english
        )

        await model.createInvite(role: .admin, maxUsesText: "2", expiresInDaysText: "14")
        XCTAssertEqual(model.operation, .idle)
        XCTAssertEqual(model.createdCode, "momo_raw_232")
        XCTAssertEqual(model.invites.map(\.id), [inviteID])
        XCTAssertEqual(model.notice, "Invite created for admin. Save the raw code or short link now.")
        XCTAssertFalse(model.canRetry)

        model.copyCreatedCode()
        XCTAssertEqual(copiedCode, "momo_raw_232")
        XCTAssertEqual(model.notice, "Invite code copied. Only the masked preview remains after this flow.")
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
            copyInviteCode: { _ in },
            language: .english
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

    func testDevelopmentSessionStoreDefaultsDemoCredentialsWithoutStoredPassword() {
        let suite = "momo-dev-session-defaults-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = MomoServerSessionStore(
            defaults: defaults,
            keychain: MomoKeychainPasswordStore(service: "momo.test.unused.\(suite)"),
            bundleIdentifier: "app.momo.dev.MomoMacDevApp"
        )

        let loaded = store.load()

        XCTAssertEqual(loaded.email, "demo@momo.local")
        XCTAssertEqual(loaded.password, "dev-password")
        XCTAssertFalse(loaded.savePassword)
    }

    func testDevelopmentSessionStorePersistsAndClearsPasswordInDefaults() {
        let suite = "momo-dev-session-roundtrip-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let prefix = "momo.test.session."
        let store = MomoServerSessionStore(
            defaults: defaults,
            keychain: MomoKeychainPasswordStore(service: "momo.test.unused.\(suite)"),
            prefix: prefix,
            bundleIdentifier: "app.momo.dev.MomoMacDevApp"
        )

        store.save(MomoServerSessionForm(
            baseURLString: "https://momo.test",
            email: "demo@momo.local",
            password: "saved-dev-password",
            inviteCode: "",
            savePassword: true
        ))

        XCTAssertEqual(defaults.string(forKey: prefix + "password"), "saved-dev-password")
        XCTAssertEqual(store.load().password, "saved-dev-password")
        XCTAssertTrue(store.load().savePassword)

        store.clearSessionSensitiveState()

        XCTAssertNil(defaults.string(forKey: prefix + "password"))
        XCTAssertEqual(store.load().password, "dev-password")
        XCTAssertFalse(store.load().savePassword)
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

    func testRESTBackendDelayedLoginCannotRestoreSessionAfterClear() async throws {
        await MockHTTPURLProtocol.reset()
        let workspace = WorkspaceID.demo
        let controller = BlockingLoginController(responses: [
            workspace.description: Self.loginResponse(
                token: "late-token",
                workspace: workspace,
                member: .demoHuman
            ),
        ])
        await MockHTTPURLProtocol.setHandler { request in
            try controller.response(for: request)
        }
        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(baseURL: URL(string: "https://momo.test")!),
            session: URLSession(configuration: .momoMocked)
        )

        let login = Task { try await backend.connect(workspace: workspace, accessToken: "") }
        await controller.waitForArrival(workspace: workspace)
        await backend.clearSessionSensitiveState()
        controller.release(workspace: workspace)

        do {
            try await login.value
            XCTFail("invalidated login should cancel")
        } catch is CancellationError {
            // Expected: clear invalidates every post-await session write.
        }
        do {
            _ = try await backend.requireAccessToken()
            XCTFail("cleared backend should not retain the late token")
        } catch BackendError.notConnected {
            // Expected.
        }
    }

    func testRESTBackendOverlappingConnectKeepsNewestSession() async throws {
        await MockHTTPURLProtocol.reset()
        let workspaceA = WorkspaceID.demo
        let workspaceB = WorkspaceID(uuidString: "00000000-0000-7000-8000-000000000002")!
        let memberB = MemberID(uuidString: "00000000-0000-7000-8000-000000000111")!
        let controller = BlockingLoginController(responses: [
            workspaceA.description: Self.loginResponse(
                token: "token-a",
                workspace: workspaceA,
                member: .demoHuman
            ),
            workspaceB.description: Self.loginResponse(
                token: "token-b",
                workspace: workspaceB,
                member: memberB
            ),
        ])
        await MockHTTPURLProtocol.setHandler { request in
            try controller.response(for: request)
        }
        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(baseURL: URL(string: "https://momo.test")!),
            session: URLSession(configuration: .momoMocked)
        )

        let connectA = Task { try await backend.connect(workspace: workspaceA, accessToken: "") }
        await controller.waitForArrival(workspace: workspaceA)
        let connectB = Task { try await backend.connect(workspace: workspaceB, accessToken: "") }
        await controller.waitForArrival(workspace: workspaceB)
        controller.release(workspace: workspaceB)
        try await connectB.value
        controller.release(workspace: workspaceA)

        do {
            try await connectA.value
            XCTFail("older connect should be invalidated")
        } catch is CancellationError {
            // Expected: connect B owns the current generation.
        }
        let currentToken = try await backend.requireAccessToken()
        let currentMember = await backend.authenticatedMemberID()
        XCTAssertEqual(currentToken, "token-b")
        XCTAssertEqual(currentMember, memberB)
    }

    func testRESTBackendDelayedMembersCannotOverwriteReconnectedSessionCache() async throws {
        await MockHTTPURLProtocol.reset()
        let workspaceA = WorkspaceID.demo
        let workspaceB = WorkspaceID(uuidString: "00000000-0000-7000-8000-000000000002")!
        let channelB = ChannelID(uuidString: "00000000-0000-7000-8000-000000000299")!
        let memberB = MemberID(uuidString: "00000000-0000-7000-8000-000000000199")!
        let rosterAPath = "/v1/workspaces/\(workspaceA.description)/roster"
        let rosterBPath = "/v1/workspaces/\(workspaceB.description)/roster"
        let controller = BlockingPathResponseController(
            responses: [
                rosterAPath: MockHTTPResponse(json: """
                {"members":[{
                  "id":"\(MemberID.demoAgent.description)",
                  "workspaceId":"\(workspaceA.description)",
                  "kind":"agent",
                  "status":"active",
                  "displayName":"Stale Agent",
                  "handle":"stale-agent",
                  "channelIds":["\(ChannelID.demoAgentLab.description)"]
                }]}
                """),
                rosterBPath: MockHTTPResponse(json: """
                {"members":[{
                  "id":"\(memberB.description)",
                  "workspaceId":"\(workspaceB.description)",
                  "kind":"human",
                  "status":"active",
                  "displayName":"Current Member",
                  "handle":"current-member",
                  "channelIds":["\(channelB.description)"]
                }]}
                """),
            ],
            blockedPaths: [rosterAPath]
        )
        await MockHTTPURLProtocol.setHandler { request in
            controller.response(for: request)
        }
        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(baseURL: URL(string: "https://momo.test")!),
            session: URLSession(configuration: .momoMocked)
        )

        try await backend.connect(workspace: workspaceA, accessToken: "token-a")
        let staleMembers = Task { try await backend.members(workspace: workspaceA) }
        await controller.waitForArrival(path: rosterAPath)
        try await backend.connect(workspace: workspaceB, accessToken: "token-b")
        let currentMembers = try await backend.members(workspace: workspaceB)
        XCTAssertEqual(currentMembers.map(\.id), [memberB])
        controller.release(path: rosterAPath)

        do {
            _ = try await staleMembers.value
            XCTFail("members from an invalidated connection should cancel")
        } catch is CancellationError {
            // Expected: session A cannot publish data or mutate session B's cache.
        }
        let presence = try await backend.presence(channel: channelB)
        XCTAssertEqual(presence.map(\.memberId), [memberB])
    }

    func testRESTBackendDelayedChannelsCannotOverwriteReconnectedSessionCache() async throws {
        await MockHTTPURLProtocol.reset()
        let workspaceA = WorkspaceID.demo
        let workspaceB = WorkspaceID(uuidString: "00000000-0000-7000-8000-000000000002")!
        let channelA = ChannelID.demoGeneral
        let channelB = ChannelID(uuidString: "00000000-0000-7000-8000-000000000299")!
        let channelsAPath = "/v1/workspaces/\(workspaceA.description)/channels"
        let channelsBPath = "/v1/workspaces/\(workspaceB.description)/channels"
        let searchBPath = "/v1/workspaces/\(workspaceB.description)/search/messages"
        let controller = BlockingPathResponseController(
            responses: [
                channelsAPath: MockHTTPResponse(json: """
                {"channels":[{
                  "id":"\(channelA.description)",
                  "workspaceId":"\(workspaceA.description)",
                  "kind":"public",
                  "name":"stale",
                  "topic":null,
                  "dmKey":null,
                  "createdBy":null,
                  "archivedAtMs":null,
                  "muted":false
                }]}
                """),
                channelsBPath: MockHTTPResponse(json: """
                {"channels":[{
                  "id":"\(channelB.description)",
                  "workspaceId":"\(workspaceB.description)",
                  "kind":"public",
                  "name":"current",
                  "topic":null,
                  "dmKey":null,
                  "createdBy":null,
                  "archivedAtMs":null,
                  "muted":false
                }]}
                """),
                searchBPath: MockHTTPResponse(json: #"{"hits":[],"nextCursor":null}"#),
            ],
            blockedPaths: [channelsAPath]
        )
        await MockHTTPURLProtocol.setHandler { request in
            controller.response(for: request)
        }
        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(baseURL: URL(string: "https://momo.test")!),
            session: URLSession(configuration: .momoMocked)
        )

        try await backend.connect(workspace: workspaceA, accessToken: "token-a")
        let staleChannels = Task { try await backend.channels(workspace: workspaceA) }
        await controller.waitForArrival(path: channelsAPath)
        try await backend.connect(workspace: workspaceB, accessToken: "token-b")
        let currentChannels = try await backend.channels(workspace: workspaceB)
        XCTAssertEqual(currentChannels.map(\.id), [channelB])
        controller.release(path: channelsAPath)

        do {
            _ = try await staleChannels.value
            XCTFail("channels from an invalidated connection should cancel")
        } catch is CancellationError {
            // Expected: session A cannot publish data or mutate session B's cache.
        }
        _ = try await backend.search(workspace: workspaceB, query: "needle")
        let requests = await MockHTTPURLProtocol.requests()
        XCTAssertEqual(requests.filter { $0.url?.path == channelsBPath }.count, 1)
        XCTAssertTrue(requests.contains { $0.url?.path == searchBPath })
    }

    func testRESTBackendDelayedChannelCreateCannotMutateReconnectedSessionCache() async throws {
        await MockHTTPURLProtocol.reset()
        let workspaceA = WorkspaceID.demo
        let workspaceB = WorkspaceID(uuidString: "00000000-0000-7000-8000-000000000002")!
        let staleChannel = ChannelID(uuidString: "00000000-0000-7000-8000-000000384201")!
        let currentChannel = ChannelID(uuidString: "00000000-0000-7000-8000-000000384202")!
        let membership = UUID(uuidString: "00000000-0000-7000-8000-000000384301")!
        let createAPath = "/v1/workspaces/\(workspaceA.description)/channels"
        let channelsBPath = "/v1/workspaces/\(workspaceB.description)/channels"
        let searchBPath = "/v1/workspaces/\(workspaceB.description)/search/messages"
        let controller = BlockingPathResponseController(
            responses: [
                createAPath: MockHTTPResponse(statusCode: 201, json: """
                {
                  "channel": {
                    "id": "\(staleChannel.description)",
                    "workspaceId": "\(workspaceA.description)",
                    "kind": "public",
                    "name": "stale-create",
                    "topic": null,
                    "dmKey": null,
                    "createdBy": "\(MemberID.demoHuman.description)",
                    "archivedAtMs": null,
                    "muted": false
                  },
                  "creatorMembership": {
                    "id": "\(membership.uuidString)",
                    "workspaceId": "\(workspaceA.description)",
                    "channelId": "\(staleChannel.description)",
                    "memberId": "\(MemberID.demoHuman.description)",
                    "role": "owner",
                    "joinedAtMs": 1782864000000,
                    "leftAtMs": null
                  }
                }
                """),
                channelsBPath: MockHTTPResponse(json: """
                {"channels":[{
                  "id":"\(currentChannel.description)",
                  "workspaceId":"\(workspaceB.description)",
                  "kind":"public",
                  "name":"current",
                  "topic":null,
                  "dmKey":null,
                  "createdBy":null,
                  "archivedAtMs":null,
                  "muted":false
                }]}
                """),
                searchBPath: MockHTTPResponse(json: #"{"hits":[],"nextCursor":null}"#),
            ],
            blockedPaths: [createAPath]
        )
        await MockHTTPURLProtocol.setHandler { request in
            controller.response(for: request)
        }
        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(baseURL: URL(string: "https://momo.test")!),
            session: URLSession(configuration: .momoMocked)
        )

        try await backend.connect(workspace: workspaceA, accessToken: "token-a")
        let staleCreate = Task {
            try await backend.createChannel(
                workspace: workspaceA,
                kind: .publicChannel,
                name: "stale-create",
                topic: nil
            )
        }
        await controller.waitForArrival(path: createAPath)
        try await backend.connect(workspace: workspaceB, accessToken: "token-b")
        let currentChannels = try await backend.channels(workspace: workspaceB)
        XCTAssertEqual(currentChannels.map(\.id), [currentChannel])
        controller.release(path: createAPath)

        do {
            _ = try await staleCreate.value
            XCTFail("channel create from an invalidated connection should cancel")
        } catch is CancellationError {
            // Expected: session A cannot mutate session B's channel cache.
        }
        _ = try await backend.search(workspace: workspaceB, query: "needle")
        let requests = await MockHTTPURLProtocol.requests()
        XCTAssertEqual(requests.filter { $0.url?.path == channelsBPath }.count, 1)
        XCTAssertTrue(requests.contains { $0.url?.path == searchBPath })
    }

    func testRESTBackendStaleMalformedChannelCreateResponseCancelsBeforeDecoding() async throws {
        await MockHTTPURLProtocol.reset()
        let workspaceA = WorkspaceID.demo
        let workspaceB = WorkspaceID(uuidString: "00000000-0000-7000-8000-000000000002")!
        let createPath = "/v1/workspaces/\(workspaceA.description)/channels"
        let controller = BlockingPathResponseController(
            responses: [
                createPath: MockHTTPResponse(statusCode: 201, json: #"{"channel":"#),
            ],
            blockedPaths: [createPath]
        )
        await MockHTTPURLProtocol.setHandler { request in
            controller.response(for: request)
        }
        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(baseURL: URL(string: "https://momo.test")!),
            session: URLSession(configuration: .momoMocked)
        )

        try await backend.connect(workspace: workspaceA, accessToken: "token-a")
        let staleCreate = Task {
            try await backend.createChannel(
                workspace: workspaceA,
                kind: .publicChannel,
                name: "stale-malformed",
                topic: nil
            )
        }
        await controller.waitForArrival(path: createPath)
        try await backend.connect(workspace: workspaceB, accessToken: "token-b")
        controller.release(path: createPath)

        do {
            _ = try await staleCreate.value
            XCTFail("stale malformed response should cancel before DTO decoding")
        } catch is CancellationError {
            // Expected: stale scope wins over malformed response diagnostics.
        } catch {
            XCTFail("stale malformed response should normalize to CancellationError: \(error)")
        }
    }

    func testRESTBackendStaleDelayedChannelCreateHTTPErrorNormalizesToCancellation() async throws {
        await MockHTTPURLProtocol.reset()
        let workspaceA = WorkspaceID.demo
        let workspaceB = WorkspaceID(uuidString: "00000000-0000-7000-8000-000000000002")!
        let createPath = "/v1/workspaces/\(workspaceA.description)/channels"
        let controller = BlockingPathResponseController(
            responses: [
                createPath: MockHTTPResponse(
                    statusCode: 503,
                    json: #"{"title":"temporarily unavailable","detail":"retry"}"#
                ),
            ],
            blockedPaths: [createPath]
        )
        await MockHTTPURLProtocol.setHandler { request in
            controller.response(for: request)
        }
        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(baseURL: URL(string: "https://momo.test")!),
            session: URLSession(configuration: .momoMocked)
        )

        try await backend.connect(workspace: workspaceA, accessToken: "token-a")
        let staleCreate = Task {
            try await backend.createChannel(
                workspace: workspaceA,
                kind: .publicChannel,
                name: "stale-error",
                topic: nil
            )
        }
        await controller.waitForArrival(path: createPath)
        try await backend.connect(workspace: workspaceB, accessToken: "token-b")
        controller.release(path: createPath)

        do {
            _ = try await staleCreate.value
            XCTFail("stale HTTP error should cancel")
        } catch is CancellationError {
            // Expected: the invalidated session owns neither errors nor cache writes.
        } catch {
            XCTFail("stale HTTP error should normalize to CancellationError: \(error)")
        }
    }

    private static func loginResponse(
        token: String,
        workspace: WorkspaceID,
        member: MemberID
    ) -> MockHTTPResponse {
        MockHTTPResponse(json: """
        {
          "accessToken": "\(token)",
          "refreshToken": "refresh-\(token)",
          "member": {
            "id": "\(member.description)",
            "workspaceId": "\(workspace.description)",
            "kind": "human",
            "displayName": "Race Tester",
            "handle": "race-tester"
          }
        }
        """)
    }

    func testRESTBackendWorkRunCreateListAndDetailContracts() async throws {
        await MockHTTPURLProtocol.reset()
        let workspace = WorkspaceID.demo
        let channel = ChannelID.demoGeneral
        let agent = MemberID.demoAgent
        let run = RunID(uuidString: "00000000-0000-7000-8000-000000000364")!
        let clientRunId = UUID(uuidString: "00000000-0000-7000-8000-000000003364")!
        let requestCount = SynchronizedCounter()
        let responseJSON = """
        {
          "id":"\(run.description)",
          "workspaceId":"\(workspace.description)",
          "agentMemberId":"\(agent.description)",
          "channelId":"\(channel.description)",
          "triggerMessageId":null,
          "parentRunId":null,
          "status":"queued",
          "stepCount":0,
          "maxSteps":50,
          "depth":0,
          "input":{"type":"work","title":"Work surface","brief":"Build the macOS Work surface.","memory_delivery":{"included_count":3,"injected":true}},
          "output":null,
          "error":null,
          "startedAtMs":null,
          "finishedAtMs":null,
          "createdAtMs":1783910400000,
          "updatedAtMs":1783910400000
        }
        """

        await MockHTTPURLProtocol.setHandler { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer work-token")
            switch requestCount.increment() {
            case 1:
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(
                    request.url?.path,
                    "/v1/workspaces/\(workspace.description)/channels/\(channel.description)/agent-runs"
                )
                let data = try XCTUnwrap(request.momoBodyData)
                let body = try XCTUnwrap(
                    JSONSerialization.jsonObject(with: data) as? [String: Any]
                )
                XCTAssertEqual(body["agentMemberId"] as? String, agent.description)
                XCTAssertEqual(body["clientRunId"] as? String, clientRunId.uuidString)
                let input = try XCTUnwrap(body["input"] as? [String: Any])
                XCTAssertEqual(input["type"] as? String, "work")
                XCTAssertEqual(input["title"] as? String, "Work surface")
                return MockHTTPResponse(statusCode: 201, json: responseJSON)
            case 2:
                XCTAssertEqual(request.httpMethod, "GET")
                let components = try XCTUnwrap(
                    request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }
                )
                XCTAssertTrue(components.queryItems?.contains(URLQueryItem(name: "type", value: "work")) == true)
                XCTAssertTrue(components.queryItems?.contains(URLQueryItem(name: "limit", value: "25")) == true)
                return MockHTTPResponse(json: #"{"runs":[]}"#)
            case 3:
                XCTAssertEqual(request.httpMethod, "GET")
                XCTAssertEqual(
                    request.url?.path,
                    "/v1/workspaces/\(workspace.description)/agent-runs/\(run.description)"
                )
                return MockHTTPResponse(json: responseJSON)
            default:
                return MockHTTPResponse(statusCode: 404, json: #"{"title":"unexpected request"}"#)
            }
        }

        let backend = MomoServerRESTChatBackend(
            config: MomoServerRESTChatBackendConfig(
                baseURL: URL(string: "https://momo.test")!,
                accessToken: "work-token"
            ),
            session: URLSession(configuration: .momoMocked)
        )
        try await backend.connect(workspace: workspace, accessToken: "work-token")

        let created = try await backend.createWorkRun(
            agent: agent,
            channel: channel,
            input: AgentWorkInput(
                title: "Work surface",
                brief: "Build the macOS Work surface."
            ),
            clientRunId: clientRunId
        )
        let listed = try await backend.workRuns(channel: channel, limit: 25)
        let detailed = try await backend.workRun(id: run)

        XCTAssertEqual(created.id, run)
        XCTAssertTrue(listed.isEmpty)
        XCTAssertEqual(detailed.id, run)
        let deliveries = await backend.memoryDeliveries(for: [run])
        XCTAssertEqual(deliveries[run]?.includedCount, 3)
        XCTAssertEqual(deliveries[run]?.injected, true)
        XCTAssertEqual(requestCount.current(), 3)
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

    @MainActor
    func testFocusMessageReportsWhenReloadedSliceNoLongerContainsTarget() async throws {
        let base = LiveChatBackend()
        let seed = await base.seedDemo()
        let channel = try XCTUnwrap(seed.channels.first)
        let members = try await base.members(workspace: seed.workspace)
        let author = try XCTUnwrap(members.first)
        let target = await base.seedDemoMessage(
            channel: channel.id,
            author: author.id,
            body: "검색 뒤 로드 슬라이스에서 사라지는 메시지"
        )
        let backend = OmitFocusedMessageChatBackend(base: base, target: target)
        let viewModel = ChatViewModel(chat: backend, agentTransport: base)

        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "focus-test")
        await viewModel.selectChannel(channel.id)
        XCTAssertTrue(viewModel.visibleMessages.contains(where: { $0.id == target.id }))
        await backend.beginOmittingTarget()

        await viewModel.focusMessage(target.id, in: channel.id)

        XCTAssertNil(viewModel.requestedMessageFocus)
        XCTAssertEqual(viewModel.failedMessageFocus, target.id)
        viewModel.clearFailedMessageFocus()
        XCTAssertNil(viewModel.failedMessageFocus)
    }

    @MainActor
    func testWorkspaceSearchFocusFetchesExactMessageOutsideReloadedSlice() async throws {
        let base = LiveChatBackend()
        let seed = await base.seedDemo()
        let channel = try XCTUnwrap(seed.channels.first)
        let target = await base.seedDemoMessage(
            channel: channel.id,
            author: seed.human.id,
            body: "오래된 서버 검색 결과"
        )
        let backend = OmitFocusedMessageChatBackend(base: base, target: target)
        let viewModel = ChatViewModel(chat: backend, agentTransport: base)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "focus-search-test")
        await backend.beginOmittingTarget(allowTargetedFetch: true)

        let hits = try await viewModel.searchWorkspaceMessages(query: "오래된 서버")
        XCTAssertEqual(hits.map(\.id), [target.id])
        await viewModel.focusMessage(target.id, in: channel.id)

        XCTAssertEqual(viewModel.requestedMessageFocus, target.id)
        XCTAssertNil(viewModel.failedMessageFocus)
        XCTAssertTrue(viewModel.visibleMessages.contains(where: { $0.id == target.id }))
    }
}

private actor OmitFocusedMessageChatBackend: ChatBackend {
    private let base: LiveChatBackend
    private let target: Message
    private var omitsTarget = false
    private var allowsTargetedFetch = false

    init(base: LiveChatBackend, target: Message) {
        self.base = base
        self.target = target
    }

    func beginOmittingTarget(allowTargetedFetch: Bool = false) {
        omitsTarget = true
        allowsTargetedFetch = allowTargetedFetch
    }

    func connect(workspace: WorkspaceID, accessToken: String) async throws {
        try await base.connect(workspace: workspace, accessToken: accessToken)
    }

    func sendOptimistic(_ draft: DraftMessage, clientMsgId: UUID) async throws -> Message {
        try await base.sendOptimistic(draft, clientMsgId: clientMsgId)
    }

    func subscribe(channel: ChannelID) async throws -> AsyncStream<RealtimeEvent> {
        try await base.subscribe(channel: channel)
    }

    func history(channel: ChannelID, after seq: Int64?, limit: Int) async throws -> [Message] {
        if omitsTarget,
           allowsTargetedFetch,
           let targetSequence = target.seq,
           seq == max(targetSequence - 1, 0),
           limit == 1 {
            return [target]
        }
        let messages = try await base.history(channel: channel, after: seq, limit: limit)
        guard omitsTarget else { return messages }
        return messages.filter { $0.id != target.id }
    }

    func presence(channel: ChannelID) async throws -> [PresenceEntry] {
        try await base.presence(channel: channel)
    }

    func members(workspace: WorkspaceID) async throws -> [Member] {
        try await base.members(workspace: workspace)
    }

    func channels(workspace: WorkspaceID) async throws -> [Channel] {
        try await base.channels(workspace: workspace)
    }

    func costSnapshots(channel: ChannelID) async throws -> [CostSnapshot] {
        try await base.costSnapshots(channel: channel)
    }

    func search(workspace: WorkspaceID, query: String) async throws -> [Message] {
        try await base.search(workspace: workspace, query: query)
    }

    func setTyping(channel: ChannelID, isTyping: Bool) async {
        await base.setTyping(channel: channel, isTyping: isTyping)
    }

    func editMessage(_ id: MessageID, body: String) async throws -> Message {
        try await base.editMessage(id, body: body)
    }

    func addReaction(_ id: MessageID, emoji: String) async throws {
        try await base.addReaction(id, emoji: emoji)
    }

    func pendingApprovals(workspace: WorkspaceID, status: ApprovalStatus) async throws -> [Approval] {
        try await base.pendingApprovals(workspace: workspace, status: status)
    }

    func decideApproval(_ request: ApprovalDecisionRequest) async throws -> ApprovalDecisionReceipt {
        try await base.decideApproval(request)
    }
}

private actor RetryOnceSendChatBackend: ChatBackend {
    private let base: LiveChatBackend
    private var shouldFailNextSend = true
    private var clientMessageIDs: [UUID] = []

    init(base: LiveChatBackend) {
        self.base = base
    }

    func attemptedClientMessageIDs() -> [UUID] {
        clientMessageIDs
    }

    func connect(workspace: WorkspaceID, accessToken: String) async throws {
        try await base.connect(workspace: workspace, accessToken: accessToken)
    }

    func sendOptimistic(_ draft: DraftMessage, clientMsgId: UUID) async throws -> Message {
        clientMessageIDs.append(clientMsgId)
        if shouldFailNextSend {
            shouldFailNextSend = false
            throw BackendError.realtime("fixture send failure")
        }
        return try await base.sendOptimistic(draft, clientMsgId: clientMsgId)
    }

    func subscribe(channel: ChannelID) async throws -> AsyncStream<RealtimeEvent> {
        try await base.subscribe(channel: channel)
    }

    func history(channel: ChannelID, after seq: Int64?, limit: Int) async throws -> [Message] {
        try await base.history(channel: channel, after: seq, limit: limit)
    }

    func presence(channel: ChannelID) async throws -> [PresenceEntry] {
        try await base.presence(channel: channel)
    }

    func members(workspace: WorkspaceID) async throws -> [Member] {
        try await base.members(workspace: workspace)
    }

    func channels(workspace: WorkspaceID) async throws -> [Channel] {
        try await base.channels(workspace: workspace)
    }

    func costSnapshots(channel: ChannelID) async throws -> [CostSnapshot] {
        try await base.costSnapshots(channel: channel)
    }

    func search(workspace: WorkspaceID, query: String) async throws -> [Message] {
        try await base.search(workspace: workspace, query: query)
    }

    func setTyping(channel: ChannelID, isTyping: Bool) async {
        await base.setTyping(channel: channel, isTyping: isTyping)
    }

    func editMessage(_ id: MessageID, body: String) async throws -> Message {
        try await base.editMessage(id, body: body)
    }

    func addReaction(_ id: MessageID, emoji: String) async throws {
        try await base.addReaction(id, emoji: emoji)
    }

    func pendingApprovals(workspace: WorkspaceID, status: ApprovalStatus) async throws -> [Approval] {
        try await base.pendingApprovals(workspace: workspace, status: status)
    }

    func decideApproval(_ request: ApprovalDecisionRequest) async throws -> ApprovalDecisionReceipt {
        try await base.decideApproval(request)
    }
}

private actor WorkspaceAuthenticationFailureBackend: ChatBackend, WorkspaceBackend {
    private let base: LiveChatBackend

    init(base: LiveChatBackend) {
        self.base = base
    }

    func workspace(id: WorkspaceID) async throws -> Workspace {
        try await base.workspace(id: id)
    }

    func updateWorkspaceName(
        workspace: WorkspaceID,
        name: String,
        expectedUpdatedAtMs: Int64
    ) async throws -> Workspace {
        throw BackendError.problem(status: 401, title: "unauthorized", detail: "expired")
    }

    func connect(workspace: WorkspaceID, accessToken: String) async throws {
        try await base.connect(workspace: workspace, accessToken: accessToken)
    }

    func sendOptimistic(_ draft: DraftMessage, clientMsgId: UUID) async throws -> Message {
        try await base.sendOptimistic(draft, clientMsgId: clientMsgId)
    }

    func subscribe(channel: ChannelID) async throws -> AsyncStream<RealtimeEvent> {
        try await base.subscribe(channel: channel)
    }

    func history(channel: ChannelID, after seq: Int64?, limit: Int) async throws -> [Message] {
        try await base.history(channel: channel, after: seq, limit: limit)
    }

    func presence(channel: ChannelID) async throws -> [PresenceEntry] {
        try await base.presence(channel: channel)
    }

    func members(workspace: WorkspaceID) async throws -> [Member] {
        try await base.members(workspace: workspace)
    }

    func channels(workspace: WorkspaceID) async throws -> [Channel] {
        try await base.channels(workspace: workspace)
    }

    func costSnapshots(channel: ChannelID) async throws -> [CostSnapshot] {
        try await base.costSnapshots(channel: channel)
    }

    func search(workspace: WorkspaceID, query: String) async throws -> [Message] {
        try await base.search(workspace: workspace, query: query)
    }

    func setTyping(channel: ChannelID, isTyping: Bool) async {
        await base.setTyping(channel: channel, isTyping: isTyping)
    }

    func editMessage(_ id: MessageID, body: String) async throws -> Message {
        try await base.editMessage(id, body: body)
    }

    func addReaction(_ id: MessageID, emoji: String) async throws {
        try await base.addReaction(id, emoji: emoji)
    }

    func pendingApprovals(workspace: WorkspaceID, status: ApprovalStatus) async throws -> [Approval] {
        try await base.pendingApprovals(workspace: workspace, status: status)
    }

    func decideApproval(_ request: ApprovalDecisionRequest) async throws -> ApprovalDecisionReceipt {
        try await base.decideApproval(request)
    }
}

private enum ControlledWorkspaceReadFailure: Sendable {
    case unknown
    case cancellation
    case backendStatus(Int)
}

private struct UnknownWorkspaceReadError: Error, Sendable {}

private actor ControlledWorkspaceIdentityBackend: ChatBackend, WorkspaceBackend, WorkspaceIdentityCacheScopeProviding {
    private struct ReadWaiter {
        let target: Int
        let continuation: CheckedContinuation<Void, Never>
    }

    private let base: LiveChatBackend
    private let cacheScope: String
    private var shouldBlockNextRead = false
    private var nextReadFailure: ControlledWorkspaceReadFailure?
    private var workspaceReadCount = 0
    private var readWaiters: [ReadWaiter] = []
    private var blockedReadReleases: [CheckedContinuation<Void, Never>] = []
    private var shouldBlockNextChannelsRead = false
    private var channelsReadCount = 0
    private var channelsReadWaiters: [ReadWaiter] = []
    private var blockedChannelsReadReleases: [CheckedContinuation<Void, Never>] = []
    private var shouldFailNextWorkspaceUpdateWithConflict = false

    init(base: LiveChatBackend, cacheScope: String) {
        self.base = base
        self.cacheScope = cacheScope
    }

    func blockNextWorkspaceRead() {
        shouldBlockNextRead = true
    }

    func failNextWorkspaceRead(with failure: ControlledWorkspaceReadFailure) {
        nextReadFailure = failure
    }

    func blockNextChannelsRead() {
        shouldBlockNextChannelsRead = true
    }

    func failNextWorkspaceUpdateWithConflict() {
        shouldFailNextWorkspaceUpdateWithConflict = true
    }

    func waitForWorkspaceReadCount(_ target: Int) async {
        guard workspaceReadCount < target else { return }
        await withCheckedContinuation { continuation in
            readWaiters.append(ReadWaiter(target: target, continuation: continuation))
        }
    }

    func releaseNextWorkspaceRead() {
        guard !blockedReadReleases.isEmpty else { return }
        blockedReadReleases.removeFirst().resume()
    }

    func waitForChannelsReadCount(_ target: Int) async {
        guard channelsReadCount < target else { return }
        await withCheckedContinuation { continuation in
            channelsReadWaiters.append(ReadWaiter(target: target, continuation: continuation))
        }
    }

    func releaseNextChannelsRead() {
        guard !blockedChannelsReadReleases.isEmpty else { return }
        blockedChannelsReadReleases.removeFirst().resume()
    }

    func workspaceIdentityCacheServerScope() async -> String {
        cacheScope
    }

    func workspace(id: WorkspaceID) async throws -> Workspace {
        if let failure = nextReadFailure {
            nextReadFailure = nil
            recordWorkspaceRead()
            switch failure {
            case .unknown:
                throw UnknownWorkspaceReadError()
            case .cancellation:
                throw CancellationError()
            case .backendStatus(let status):
                throw BackendError.problem(status: status, title: "controlled failure", detail: nil)
            }
        }

        let shouldBlock = shouldBlockNextRead
        shouldBlockNextRead = false
        let snapshot = try await base.workspace(id: id)
        if shouldBlock {
            await withCheckedContinuation { continuation in
                blockedReadReleases.append(continuation)
                recordWorkspaceRead()
            }
        } else {
            recordWorkspaceRead()
        }
        return snapshot
    }

    func updateWorkspaceName(
        workspace: WorkspaceID,
        name: String,
        expectedUpdatedAtMs: Int64
    ) async throws -> Workspace {
        if shouldFailNextWorkspaceUpdateWithConflict {
            shouldFailNextWorkspaceUpdateWithConflict = false
            throw BackendError.problem(status: 409, title: "workspace changed", detail: nil)
        }
        return try await base.updateWorkspaceName(
            workspace: workspace,
            name: name,
            expectedUpdatedAtMs: expectedUpdatedAtMs
        )
    }

    func connect(workspace: WorkspaceID, accessToken: String) async throws {
        try await base.connect(workspace: workspace, accessToken: accessToken)
    }

    func sendOptimistic(_ draft: DraftMessage, clientMsgId: UUID) async throws -> Message {
        try await base.sendOptimistic(draft, clientMsgId: clientMsgId)
    }

    func subscribe(channel: ChannelID) async throws -> AsyncStream<RealtimeEvent> {
        try await base.subscribe(channel: channel)
    }

    func history(channel: ChannelID, after seq: Int64?, limit: Int) async throws -> [Message] {
        try await base.history(channel: channel, after: seq, limit: limit)
    }

    func presence(channel: ChannelID) async throws -> [PresenceEntry] {
        try await base.presence(channel: channel)
    }

    func members(workspace: WorkspaceID) async throws -> [Member] {
        try await base.members(workspace: workspace)
    }

    func channels(workspace: WorkspaceID) async throws -> [Channel] {
        let shouldBlock = shouldBlockNextChannelsRead
        shouldBlockNextChannelsRead = false
        let snapshot = try await base.channels(workspace: workspace)
        channelsReadCount += 1
        resumeSatisfiedWaiters(&channelsReadWaiters, count: channelsReadCount)
        if shouldBlock {
            await withCheckedContinuation { continuation in
                blockedChannelsReadReleases.append(continuation)
            }
        }
        return snapshot
    }

    func costSnapshots(channel: ChannelID) async throws -> [CostSnapshot] {
        try await base.costSnapshots(channel: channel)
    }

    func search(workspace: WorkspaceID, query: String) async throws -> [Message] {
        try await base.search(workspace: workspace, query: query)
    }

    func setTyping(channel: ChannelID, isTyping: Bool) async {
        await base.setTyping(channel: channel, isTyping: isTyping)
    }

    func editMessage(_ id: MessageID, body: String) async throws -> Message {
        try await base.editMessage(id, body: body)
    }

    func addReaction(_ id: MessageID, emoji: String) async throws {
        try await base.addReaction(id, emoji: emoji)
    }

    func pendingApprovals(workspace: WorkspaceID, status: ApprovalStatus) async throws -> [Approval] {
        try await base.pendingApprovals(workspace: workspace, status: status)
    }

    func decideApproval(_ request: ApprovalDecisionRequest) async throws -> ApprovalDecisionReceipt {
        try await base.decideApproval(request)
    }

    private func recordWorkspaceRead() {
        workspaceReadCount += 1
        var pending: [ReadWaiter] = []
        for waiter in readWaiters {
            if workspaceReadCount >= waiter.target {
                waiter.continuation.resume()
            } else {
                pending.append(waiter)
            }
        }
        readWaiters = pending
    }

    private func resumeSatisfiedWaiters(_ waiters: inout [ReadWaiter], count: Int) {
        var pending: [ReadWaiter] = []
        for waiter in waiters {
            if count >= waiter.target {
                waiter.continuation.resume()
            } else {
                pending.append(waiter)
            }
        }
        waiters = pending
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

private struct FixtureReadStateRealtimeTransport: ReadStateRealtimeEnvelopeSubscriptionTransport {
    let envelopes: [RealtimeEnvelope]

    func readStateEnvelopes(
        member: MemberID
    ) async throws -> AsyncThrowingStream<RealtimeEnvelope, Error> {
        AsyncThrowingStream { continuation in
            for envelope in envelopes {
                continuation.yield(envelope)
            }
            continuation.finish()
        }
    }
}

private actor FixtureRealtimeChatBackend: ChatBackend, ReadStateBackend {
    private let workspace: WorkspaceID
    private let storedMembers: [Member]
    private let storedChannels: [Channel]
    private let storedHistory: [ChannelID: [Message]]
    private let storedEvents: [RealtimeEvent]
    private var storedReadStates: [ChannelID: ChannelReadState]
    private let storedReadStateEvents: [ChannelReadState]
    private let readStateSubscriptionFails: Bool
    private let firstRealtimeSubscriptionFails: Bool
    private var realtimeSubscriptionCounts: [ChannelID: Int] = [:]
    private var remainingMarkReadFailures: Int
    private var readStateFetches = 0
    private var markReadAttempts = 0
    private var storedTypingCalls: [(channel: ChannelID, isTyping: Bool)] = []

    init(
        workspace: WorkspaceID,
        members: [Member],
        channels: [Channel],
        history: [ChannelID: [Message]],
        events: [RealtimeEvent],
        readStates: [ChannelReadState] = [],
        readStateEvents: [ChannelReadState] = [],
        markReadFailures: Int = 0,
        readStateSubscriptionFails: Bool = false,
        firstRealtimeSubscriptionFails: Bool = false
    ) {
        self.workspace = workspace
        self.storedMembers = members
        self.storedChannels = channels
        self.storedHistory = history
        self.storedEvents = events
        self.storedReadStates = Dictionary(uniqueKeysWithValues: readStates.map { ($0.channelId, $0) })
        self.storedReadStateEvents = readStateEvents
        self.readStateSubscriptionFails = readStateSubscriptionFails
        self.firstRealtimeSubscriptionFails = firstRealtimeSubscriptionFails
        self.remainingMarkReadFailures = markReadFailures
    }

    func connect(workspace: WorkspaceID, accessToken: String) async throws {}

    func sendOptimistic(_ draft: DraftMessage, clientMsgId: UUID) async throws -> Message {
        throw BackendError.notConnected
    }

    func subscribe(channel: ChannelID) async throws -> AsyncStream<RealtimeEvent> {
        realtimeSubscriptionCounts[channel, default: 0] += 1
        if firstRealtimeSubscriptionFails, realtimeSubscriptionCounts[channel] == 1 {
            throw BackendError.realtime("fixture subscribe failure")
        }
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

    func subscriptionCount(channel: ChannelID) -> Int {
        realtimeSubscriptionCounts[channel, default: 0]
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

    func readStates(workspace: WorkspaceID) async throws -> [ChannelReadState] {
        readStateFetches += 1
        return storedReadStates.values.sorted { $0.channelId.description < $1.channelId.description }
    }

    func markRead(channel: ChannelID, through sequence: Int64) async throws -> ChannelReadState {
        markReadAttempts += 1
        if remainingMarkReadFailures > 0 {
            remainingMarkReadFailures -= 1
            throw BackendError.realtime("fixture mark-read failure")
        }
        let current = storedReadStates[channel] ?? ChannelReadState(
            channelId: channel,
            lastReadSeq: 0,
            latestSeq: sequence,
            unreadCount: sequence,
            mentionCount: 0
        )
        let effective = min(current.latestSeq, max(current.lastReadSeq, sequence))
        let updated = ChannelReadState(
            channelId: channel,
            lastReadSeq: effective,
            latestSeq: current.latestSeq,
            unreadCount: max(0, current.latestSeq - effective),
            mentionCount: effective == current.latestSeq ? 0 : current.mentionCount
        )
        storedReadStates[channel] = updated
        return updated
    }

    func subscribeReadStates(member: MemberID) async throws -> AsyncThrowingStream<ChannelReadState, Error> {
        let events = storedReadStateEvents
        let fails = readStateSubscriptionFails
        return AsyncThrowingStream { continuation in
            Task {
                if fails {
                    continuation.finish(throwing: BackendError.realtime("fixture read-state failure"))
                    return
                }
                for event in events {
                    continuation.yield(event)
                    try? await Task.sleep(for: .milliseconds(5))
                }
                continuation.finish()
            }
        }
    }

    func readStateFetchCount() -> Int {
        readStateFetches
    }

    func markReadAttemptCount() -> Int {
        markReadAttempts
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
    let data: Data?
    let headers: [String: String]
    let releaseGate: DispatchSemaphore?

    init(
        statusCode: Int = 200,
        json: String,
        headers: [String: String] = ["Content-Type": "application/json"],
        releaseGate: DispatchSemaphore? = nil
    ) {
        self.statusCode = statusCode
        self.json = json
        self.data = nil
        self.headers = headers
        self.releaseGate = releaseGate
    }

    init(
        statusCode: Int = 200,
        data: Data,
        headers: [String: String] = [:],
        releaseGate: DispatchSemaphore? = nil
    ) {
        self.statusCode = statusCode
        self.json = ""
        self.data = data
        self.headers = headers
        self.releaseGate = releaseGate
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

    func current() -> Int {
        lock.withLock { value }
    }
}

private final class BlockingLoginController: @unchecked Sendable {
    private let lock = NSLock()
    private let responses: [String: MockHTTPResponse]
    private var arrivals: Set<String> = []
    private var waiters: [String: [CheckedContinuation<Void, Never>]] = [:]
    private var releases: [String: DispatchSemaphore] = [:]

    init(responses: [String: MockHTTPResponse]) {
        self.responses = responses
        self.releases = responses.reduce(into: [:]) { result, pair in
            result[pair.key] = DispatchSemaphore(value: 0)
        }
    }

    func response(for request: URLRequest) throws -> MockHTTPResponse {
        guard request.url?.path == "/v1/auth/login",
              let data = request.momoBodyData,
              let body = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let workspace = body["workspace"] as? String,
              let response = responses[workspace],
              let release = lock.withLock({ releases[workspace] })
        else {
            return MockHTTPResponse(statusCode: 404, json: #"{"title":"unexpected login"}"#)
        }

        let continuations: [CheckedContinuation<Void, Never>] = lock.withLock {
            arrivals.insert(workspace)
            return waiters.removeValue(forKey: workspace) ?? []
        }
        continuations.forEach { $0.resume() }
        return MockHTTPResponse(
            statusCode: response.statusCode,
            json: response.json,
            releaseGate: release
        )
    }

    func waitForArrival(workspace: WorkspaceID) async {
        let key = workspace.description
        if lock.withLock({ arrivals.contains(key) }) { return }
        await withCheckedContinuation { continuation in
            let shouldResume = lock.withLock {
                if arrivals.contains(key) { return true }
                waiters[key, default: []].append(continuation)
                return false
            }
            if shouldResume { continuation.resume() }
        }
    }

    func release(workspace: WorkspaceID) {
        lock.withLock { releases[workspace.description] }?.signal()
    }
}

private final class BlockingPathResponseController: @unchecked Sendable {
    private let lock = NSLock()
    private let responses: [String: MockHTTPResponse]
    private var arrivals: Set<String> = []
    private var waiters: [String: [CheckedContinuation<Void, Never>]] = [:]
    private var releases: [String: DispatchSemaphore]

    init(responses: [String: MockHTTPResponse], blockedPaths: Set<String>) {
        self.responses = responses
        self.releases = blockedPaths.reduce(into: [:]) { result, path in
            result[path] = DispatchSemaphore(value: 0)
        }
    }

    func response(for request: URLRequest) -> MockHTTPResponse {
        guard let path = request.url?.path, let response = responses[path] else {
            return MockHTTPResponse(statusCode: 404, json: #"{"title":"unexpected request"}"#)
        }
        let state = lock.withLock { () -> ([CheckedContinuation<Void, Never>], DispatchSemaphore?) in
            arrivals.insert(path)
            return (waiters.removeValue(forKey: path) ?? [], releases[path])
        }
        state.0.forEach { $0.resume() }
        return MockHTTPResponse(
            statusCode: response.statusCode,
            json: response.json,
            releaseGate: state.1
        )
    }

    func waitForArrival(path: String) async {
        if lock.withLock({ arrivals.contains(path) }) { return }
        await withCheckedContinuation { continuation in
            let shouldResume = lock.withLock {
                if arrivals.contains(path) { return true }
                waiters[path, default: []].append(continuation)
                return false
            }
            if shouldResume { continuation.resume() }
        }
    }

    func release(path: String) {
        lock.withLock { releases[path] }?.signal()
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
            let deliver: @Sendable () -> Void = { [self] in
                let data = mocked.data ?? Data(mocked.json.utf8)
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: mocked.statusCode,
                    httpVersion: "HTTP/1.1",
                    headerFields: mocked.headers
                )!
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: data)
                client?.urlProtocolDidFinishLoading(self)
            }
            if let releaseGate = mocked.releaseGate {
                DispatchQueue.global().async {
                    releaseGate.wait()
                    deliver()
                }
            } else {
                deliver()
            }
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

private actor ControlledDirectMessageBackend: ChatBackend {
    enum Outcome: Sendable {
        case success(Channel)
        case failure(BackendError)
    }

    private let base: LiveChatBackend
    private var outcomes: [MemberID: Outcome] = [:]
    private var arrivedMembers: Set<MemberID> = []
    private var arrivalWaiters: [MemberID: [CheckedContinuation<Void, Never>]] = [:]
    private var releaseWaiters: [MemberID: CheckedContinuation<Void, Never>] = [:]

    init(base: LiveChatBackend) {
        self.base = base
    }

    func setOutcome(_ outcome: Outcome, for memberID: MemberID) {
        outcomes[memberID] = outcome
        arrivedMembers.remove(memberID)
    }

    func waitForOpen(with memberID: MemberID) async {
        if arrivedMembers.contains(memberID) { return }
        await withCheckedContinuation { continuation in
            arrivalWaiters[memberID, default: []].append(continuation)
        }
    }

    func releaseOpen(with memberID: MemberID) {
        releaseWaiters.removeValue(forKey: memberID)?.resume()
    }

    func connect(workspace: WorkspaceID, accessToken: String) async throws {
        try await base.connect(workspace: workspace, accessToken: accessToken)
    }

    func sendOptimistic(_ draft: DraftMessage, clientMsgId: UUID) async throws -> Message {
        try await base.sendOptimistic(draft, clientMsgId: clientMsgId)
    }

    func subscribe(channel: ChannelID) async throws -> AsyncStream<RealtimeEvent> {
        try await base.subscribe(channel: channel)
    }

    func history(channel: ChannelID, after seq: Int64?, limit: Int) async throws -> [Message] {
        try await base.history(channel: channel, after: seq, limit: limit)
    }

    func presence(channel: ChannelID) async throws -> [PresenceEntry] {
        try await base.presence(channel: channel)
    }

    func members(workspace: WorkspaceID) async throws -> [Member] {
        try await base.members(workspace: workspace)
    }

    func channels(workspace: WorkspaceID) async throws -> [Channel] {
        try await base.channels(workspace: workspace)
    }

    func openDirectMessage(workspace: WorkspaceID, with member: MemberID) async throws -> Channel {
        guard let outcome = outcomes[member] else {
            throw BackendError.problem(status: 500, title: "Missing test outcome", detail: nil)
        }
        arrivedMembers.insert(member)
        let waiters = arrivalWaiters.removeValue(forKey: member) ?? []
        waiters.forEach { $0.resume() }
        await withCheckedContinuation { continuation in
            releaseWaiters[member] = continuation
        }
        switch outcome {
        case .success(let channel):
            return channel
        case .failure(let error):
            throw error
        }
    }

    func createChannel(
        workspace: WorkspaceID,
        kind: ChannelKind,
        name: String,
        topic: String?
    ) async throws -> ChannelCreateResult {
        try await base.createChannel(workspace: workspace, kind: kind, name: name, topic: topic)
    }

    func costSnapshots(channel: ChannelID) async throws -> [CostSnapshot] {
        try await base.costSnapshots(channel: channel)
    }

    func search(workspace: WorkspaceID, query: String) async throws -> [Message] {
        try await base.search(workspace: workspace, query: query)
    }

    func setTyping(channel: ChannelID, isTyping: Bool) async {
        await base.setTyping(channel: channel, isTyping: isTyping)
    }

    func editMessage(_ id: MessageID, body: String) async throws -> Message {
        try await base.editMessage(id, body: body)
    }

    func addReaction(_ id: MessageID, emoji: String) async throws {
        try await base.addReaction(id, emoji: emoji)
    }

    func pendingApprovals(workspace: WorkspaceID, status: ApprovalStatus) async throws -> [Approval] {
        try await base.pendingApprovals(workspace: workspace, status: status)
    }

    func decideApproval(_ request: ApprovalDecisionRequest) async throws -> ApprovalDecisionReceipt {
        try await base.decideApproval(request)
    }
}
