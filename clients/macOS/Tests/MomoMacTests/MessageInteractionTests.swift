import XCTest
import MomoCore
@testable import MomoMac

@MainActor
final class MessageInteractionTests: XCTestCase {
    private func fixture() async throws -> (ChatViewModel, Message, Message) {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let message = await backend.seedDemoMessage(
            channel: seed.channels[0].id,
            author: seed.human.id,
            body: "작성자 메시지"
        )
        let otherMessage = await backend.seedDemoMessage(
            channel: seed.channels[0].id,
            author: seed.agents[0].id,
            body: "다른 작성자 메시지"
        )
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "local-token")
        return (viewModel, message, otherMessage)
    }

    func testReactionToggleMaintainsMemberCountAndSelection() async throws {
        let (viewModel, message, _) = try await fixture()

        await viewModel.toggleReaction("👍", on: message)
        XCTAssertEqual(viewModel.reactions(for: message).first?.count, 1)
        XCTAssertEqual(viewModel.reactions(for: message).first?.isSelectedByCurrentMember, true)

        await viewModel.toggleReaction("👍", on: message)
        XCTAssertTrue(viewModel.reactions(for: message).isEmpty)
    }

    func testReplyIsKeptOutOfRootAndDiscoverableByThread() async throws {
        let (viewModel, root, _) = try await fixture()

        let didSend = await viewModel.sendReply(body: "스레드 답글", to: root)
        XCTAssertTrue(didSend)

        let replies = viewModel.replies(to: root)
        XCTAssertEqual(replies.last?.body, "스레드 답글")
        XCTAssertEqual(replies.last?.rootId, root.id)
        XCTAssertFalse(viewModel.visibleMessages.filter { $0.rootId == nil }.contains { $0.body == "스레드 답글" })
    }

    func testAuthorCanEditAndDeleteThroughCompleteBackendCapability() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let message = await backend.seedDemoMessage(
            channel: seed.channels[0].id,
            author: seed.human.id,
            body: "작성자 메시지"
        )
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "local-token")

        XCTAssertTrue(viewModel.supportsMessageInteractions)
        let didEdit = await viewModel.editMessage(message, body: "수정한 메시지")
        XCTAssertTrue(didEdit)
        let edited = try XCTUnwrap(viewModel.visibleMessages.first { $0.id == message.id })
        XCTAssertEqual(edited.body, "수정한 메시지")
        XCTAssertEqual(edited.state, .edited)

        let didDelete = await viewModel.deleteMessage(edited)
        XCTAssertTrue(didDelete)
        XCTAssertTrue(try XCTUnwrap(viewModel.visibleMessages.first { $0.id == message.id }).isDeleted)
        let persistedHistory = try await backend.history(
            channel: message.channelId,
            after: nil,
            limit: 100
        )
        XCTAssertTrue(try XCTUnwrap(persistedHistory.first { $0.id == message.id }).isDeleted)
    }

    func testNonAuthorCannotEditOrDelete() async throws {
        let (viewModel, _, otherMessage) = try await fixture()

        let didEdit = await viewModel.editMessage(otherMessage, body: "허용되지 않음")
        XCTAssertFalse(didEdit)
        let didDelete = await viewModel.deleteMessage(otherMessage)
        XCTAssertFalse(didDelete)
        XCTAssertFalse(otherMessage.isDeleted)
    }

    func testSessionClearRemovesReactionAndInteractionErrorSidecars() async throws {
        let (viewModel, message, _) = try await fixture()
        await viewModel.toggleReaction("👍", on: message)
        XCTAssertFalse(viewModel.reactions(for: message).isEmpty)

        await viewModel.clearSessionSensitiveState()

        XCTAssertTrue(viewModel.reactions(for: message).isEmpty)
        XCTAssertTrue(viewModel.messageInteractionErrors.isEmpty)
    }

    func testReactionSnapshotRestoresFromDemoBackendSourceOfTruth() async throws {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let message = await backend.seedDemoMessage(
            channel: seed.channels[0].id,
            author: seed.human.id,
            body: "반응 복구 메시지"
        )
        let firstViewModel = ChatViewModel(backend: backend)
        await firstViewModel.bootstrap(workspace: seed.workspace, accessToken: "local-token")
        await firstViewModel.toggleReaction("👍", on: message)
        XCTAssertEqual(firstViewModel.reactions(for: message).first?.count, 1)

        let restoredViewModel = ChatViewModel(backend: backend)
        await restoredViewModel.bootstrap(workspace: seed.workspace, accessToken: "local-token")
        await restoredViewModel.selectChannel(message.channelId)
        XCTAssertEqual(restoredViewModel.reactions(for: message).first?.count, 1)
        XCTAssertTrue(restoredViewModel.reactions(for: message).first?.isSelectedByCurrentMember == true)
    }
}
