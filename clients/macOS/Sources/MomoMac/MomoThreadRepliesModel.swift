import Foundation
import MomoCore

/// One oldest-first page from the engine-owned thread replies projection.
struct MomoThreadRepliesPage: Sendable, Equatable {
    let messages: [Message]
    let nextCursor: Int64?
}

/// Optional macOS capability for loading a complete thread independently from
/// the bounded channel history window.
protocol MomoThreadRepliesBackend: Sendable {
    func threadReplies(
        channel: ChannelID,
        root: MessageID,
        cursor: Int64?,
        limit: Int
    ) async throws -> MomoThreadRepliesPage
}
