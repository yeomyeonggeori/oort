import Foundation
import MomoCore

/// Optional macOS capability for a backend that can persist the complete
/// message-mutation lifecycle. REST backends must not conform until edit,
/// add/remove reaction, and delete all write through the server SoT.
protocol MomoMessageInteractionBackend: Sendable {
    func reactionSnapshot(channel: ChannelID) async throws -> [MessageID: [String: Set<MemberID>]]
    func removeReaction(_ id: MessageID, emoji: String) async throws
    func deleteMessage(_ id: MessageID) async throws -> Message
}

/// A UI projection of the reaction event stream. The engine remains the source
/// of truth; the macOS client only aggregates member IDs for display and toggle state.
public struct MomoMessageReaction: Identifiable, Sendable, Equatable {
    public var id: String { emoji }
    public let emoji: String
    public let memberIDs: Set<MemberID>
    public let isSelectedByCurrentMember: Bool

    public var count: Int { memberIDs.count }
}

enum MomoMessageInteractionError: Equatable {
    case editFailed
    case deleteFailed
    case reactionFailed
    case replyFailed

    func message(copy: MomoWorkspaceCopy) -> String {
        switch (self, copy.language) {
        case (.editFailed, .korean): return "메시지를 수정하지 못했습니다. 다시 시도해 주세요."
        case (.editFailed, .english): return "The message could not be edited. Try again."
        case (.deleteFailed, .korean): return "메시지를 삭제하지 못했습니다. 다시 시도해 주세요."
        case (.deleteFailed, .english): return "The message could not be deleted. Try again."
        case (.reactionFailed, .korean): return "반응을 저장하지 못했습니다. 연결 상태를 확인해 주세요."
        case (.reactionFailed, .english): return "The reaction could not be saved. Check your connection."
        case (.replyFailed, .korean): return "답글을 보내지 못했습니다. 다시 시도해 주세요."
        case (.replyFailed, .english): return "The reply could not be sent. Try again."
        }
    }
}
