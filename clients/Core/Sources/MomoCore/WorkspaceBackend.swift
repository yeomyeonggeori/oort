import Foundation

/// Workspace identity reads and owner/admin-managed updates.
///
/// Implementations must scope every operation to the authenticated tenant. A
/// client-supplied workspace identifier is never sufficient authorization.
public protocol WorkspaceBackend: Sendable {
    func workspace(id: WorkspaceID) async throws -> Workspace

    func updateWorkspaceName(
        workspace: WorkspaceID,
        name: String,
        expectedUpdatedAtMs: Int64
    ) async throws -> Workspace
}
