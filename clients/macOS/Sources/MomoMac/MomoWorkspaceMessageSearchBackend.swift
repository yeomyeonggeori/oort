import MomoCore

struct MomoWorkspaceMessageSearchPage: Sendable, Equatable {
    let messages: [Message]
    let nextCursor: String?
}

protocol MomoWorkspaceMessageSearchBackend: Sendable {
    func searchWorkspaceMessages(
        workspace: WorkspaceID,
        query: String,
        cursor: String?,
        limit: Int
    ) async throws -> MomoWorkspaceMessageSearchPage
}
