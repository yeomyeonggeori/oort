import XCTest
import MomoCore
@testable import MomoMac

final class MomoWorkspaceSearchTests: XCTestCase {
    func testSearchFindsChannelsMembersMessagesAndAttachmentNames() {
        let workspaceID = WorkspaceID()
        let channel = Channel(
            id: ChannelID(),
            workspaceId: workspaceID,
            kind: .publicChannel,
            name: "launch"
        )
        let member = Member(
            id: MemberID(),
            workspaceId: workspaceID,
            kind: .agent,
            displayName: "Hermes",
            handle: "hermes"
        )
        let message = Message(
            id: MessageID(),
            channelId: channel.id,
            seq: 1,
            hlcTs: 1,
            authorMemberId: member.id,
            body: "The rollout checklist is ready.",
            props: [
                "attachments": [
                    ["filename": "rollout-plan.pdf"]
                ]
            ]
        )

        let channelResults = MomoWorkspaceSearchIndex.results(
            query: "launch",
            channels: [channel],
            members: [member],
            currentMemberID: nil,
            messagesByChannel: [channel.id: [message]]
        )
        XCTAssertEqual(channelResults[.channel]?.map(\.title), ["#launch"])

        let memberResults = MomoWorkspaceSearchIndex.results(
            query: "HERMES",
            channels: [channel],
            members: [member],
            currentMemberID: nil,
            messagesByChannel: [channel.id: [message]]
        )
        XCTAssertEqual(memberResults[.member]?.map(\.title), ["Hermes"])

        let messageResults = MomoWorkspaceSearchIndex.results(
            query: "checklist",
            channels: [channel],
            members: [member],
            currentMemberID: nil,
            messagesByChannel: [channel.id: [message]]
        )
        XCTAssertEqual(messageResults[.message]?.map(\.title), ["The rollout checklist is ready."])

        let fileResults = MomoWorkspaceSearchIndex.results(
            query: "rollout-plan",
            channels: [channel],
            members: [member],
            currentMemberID: nil,
            messagesByChannel: [channel.id: [message]]
        )
        XCTAssertEqual(fileResults[.file]?.map(\.title), ["rollout-plan.pdf"])
    }

    func testSearchExcludesSuspendedMembersAndDeletedMessages() {
        let workspaceID = WorkspaceID()
        let channel = Channel(
            id: ChannelID(),
            workspaceId: workspaceID,
            kind: .publicChannel,
            name: "general"
        )
        let member = Member(
            id: MemberID(),
            workspaceId: workspaceID,
            kind: .human,
            status: .suspended,
            displayName: "Archived Person",
            handle: "archived"
        )
        let deleted = Message(
            id: MessageID(),
            channelId: channel.id,
            seq: 1,
            hlcTs: 1,
            authorMemberId: member.id,
            state: .deleted,
            body: "Hidden content"
        )

        let results = MomoWorkspaceSearchIndex.results(
            query: "hidden",
            channels: [channel],
            members: [member],
            currentMemberID: nil,
            messagesByChannel: [channel.id: [deleted]]
        )
        XCTAssertNil(results[MomoWorkspaceSearchItem.Kind.member])
        XCTAssertNil(results[MomoWorkspaceSearchItem.Kind.message])
    }

    func testSearchExcludesCachedMessagesOutsideVisibleChannels() {
        let workspaceID = WorkspaceID()
        let visible = Channel(id: ChannelID(), workspaceId: workspaceID, kind: .publicChannel, name: "general")
        let staleChannelID = ChannelID()
        let member = Member(id: MemberID(), workspaceId: workspaceID, kind: .human, displayName: "Demo", handle: "demo")
        let stale = Message(
            id: MessageID(), channelId: staleChannelID, seq: 1, hlcTs: 1,
            authorMemberId: member.id, body: "private cached phrase"
        )

        let results = MomoWorkspaceSearchIndex.results(
            query: "private cached", channels: [visible], members: [member],
            currentMemberID: member.id, messagesByChannel: [staleChannelID: [stale]]
        )
        XCTAssertNil(results[.message])
    }

    func testSearchDoesNotTreatToolMetadataAsAttachmentNames() {
        let workspaceID = WorkspaceID()
        let channel = Channel(id: ChannelID(), workspaceId: workspaceID, kind: .publicChannel, name: "general")
        let member = Member(id: MemberID(), workspaceId: workspaceID, kind: .agent, displayName: "Hermes", handle: "hermes")
        let message = Message(
            id: MessageID(), channelId: channel.id, seq: 1, hlcTs: 1,
            authorMemberId: member.id,
            props: ["tool_call": ["name": "secret-export.csv", "path": "/tmp/secret-export.csv"]]
        )

        let results = MomoWorkspaceSearchIndex.results(
            query: "secret-export", channels: [channel], members: [member],
            currentMemberID: nil, messagesByChannel: [channel.id: [message]]
        )
        XCTAssertNil(results[.file])
    }

    func testMessageResultShowsTheMatchingLineInsteadOfUnrelatedFirstLine() {
        let workspaceID = WorkspaceID()
        let channel = Channel(id: ChannelID(), workspaceId: workspaceID, kind: .publicChannel, name: "general")
        let member = Member(id: MemberID(), workspaceId: workspaceID, kind: .human, displayName: "Demo", handle: "demo")
        let message = Message(
            id: MessageID(), channelId: channel.id, seq: 1, hlcTs: 1,
            authorMemberId: member.id,
            body: "Unrelated introduction\nThe deployment checklist is ready for review."
        )

        let results = MomoWorkspaceSearchIndex.results(
            query: "checklist", channels: [channel], members: [member],
            currentMemberID: member.id, messagesByChannel: [channel.id: [message]]
        )

        XCTAssertEqual(results[.message]?.first?.title, "The deployment checklist is ready for review.")
    }

    func testMemberResultsPreserveHumanAndAgentPresentation() {
        let workspaceID = WorkspaceID()
        let human = Member(id: MemberID(), workspaceId: workspaceID, kind: .human, displayName: "Alex", handle: "alex")
        let agent = Member(id: MemberID(), workspaceId: workspaceID, kind: .agent, displayName: "Agent Alex", handle: "agent-alex")

        let results = MomoWorkspaceSearchIndex.results(
            query: "alex", channels: [], members: [human, agent],
            currentMemberID: human.id, messagesByChannel: [:]
        )

        XCTAssertEqual(results[.member]?.map(\.isAgent), [false, true])
    }

    func testServerMessagesReplaceLoadedMessageSourceWhileFilesStayLocal() throws {
        let workspaceID = WorkspaceID()
        let channel = Channel(
            id: ChannelID(), workspaceId: workspaceID,
            kind: .publicChannel, name: "release"
        )
        let member = Member(
            id: MemberID(), workspaceId: workspaceID,
            kind: .human, displayName: "상준", handle: "sangjun"
        )
        let cached = Message(
            id: MessageID(), channelId: channel.id, seq: 1, hlcTs: 1,
            authorMemberId: member.id, body: "old local checklist",
            props: ["attachments": [["filename": "checklist.pdf"]]]
        )
        let serverHit = Message(
            id: MessageID(), channelId: channel.id, seq: 500, hlcTs: 500,
            authorMemberId: member.id, body: "server checklist result"
        )

        let results = MomoWorkspaceSearchIndex.results(
            query: "checklist",
            channels: [channel],
            members: [member],
            currentMemberID: member.id,
            messagesByChannel: [channel.id: [cached]],
            serverMessages: [serverHit]
        )

        XCTAssertEqual(results[.message]?.map(\.title), ["server checklist result"])
        XCTAssertEqual(results[.file]?.map(\.title), ["checklist.pdf"])
        XCTAssertEqual(
            try XCTUnwrap(results[.message]?.first?.destination),
            .message(channelID: channel.id, messageID: serverHit.id)
        )
    }

    func testServerMessageOrderIsPreservedAcrossChannels() {
        let workspaceID = WorkspaceID()
        let firstChannel = Channel(
            id: ChannelID(), workspaceId: workspaceID,
            kind: .publicChannel, name: "general"
        )
        let secondChannel = Channel(
            id: ChannelID(), workspaceId: workspaceID,
            kind: .publicChannel, name: "release"
        )
        let member = Member(
            id: MemberID(), workspaceId: workspaceID,
            kind: .human, displayName: "상준", handle: "sangjun"
        )
        let newest = Message(
            id: MessageID(), channelId: secondChannel.id, seq: 2, hlcTs: 2,
            authorMemberId: member.id, body: "deploy newest"
        )
        let older = Message(
            id: MessageID(), channelId: firstChannel.id, seq: 80, hlcTs: 1,
            authorMemberId: member.id, body: "deploy older"
        )

        let results = MomoWorkspaceSearchIndex.results(
            query: "deploy",
            channels: [firstChannel, secondChannel],
            members: [member],
            currentMemberID: member.id,
            messagesByChannel: [:],
            serverMessages: [newest, older]
        )

        XCTAssertEqual(
            results[.message]?.map(\.destination),
            [
                .message(channelID: secondChannel.id, messageID: newest.id),
                .message(channelID: firstChannel.id, messageID: older.id),
            ]
        )
    }

    func testExplicitEmptyServerPageDoesNotFallBackToLoadedMessages() {
        let workspaceID = WorkspaceID()
        let channel = Channel(
            id: ChannelID(), workspaceId: workspaceID,
            kind: .publicChannel, name: "general"
        )
        let member = Member(
            id: MemberID(), workspaceId: workspaceID,
            kind: .human, displayName: "상준", handle: "sangjun"
        )
        let cached = Message(
            id: MessageID(), channelId: channel.id, seq: 1, hlcTs: 1,
            authorMemberId: member.id, body: "loaded only"
        )

        let results = MomoWorkspaceSearchIndex.results(
            query: "loaded",
            channels: [channel],
            members: [member],
            currentMemberID: member.id,
            messagesByChannel: [channel.id: [cached]],
            serverMessages: []
        )

        XCTAssertNil(results[.message])
    }
}
