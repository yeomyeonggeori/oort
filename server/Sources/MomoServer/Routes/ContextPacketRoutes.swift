import Foundation
import Hummingbird
import PostgresNIO

struct ContextPacketDTO: ResponseEncodable, Codable, Sendable {
    let packetId: String
    let runId: String
    let workspaceId: String
    let createdAtMs: Int64
    let expiresAtMs: Int64
    let expired: Bool
    let content: JSONValue
}

/// Read-only inspection surface for the immutable packet consumed by a run.
/// Access is additionally bound to current membership in the run's channel;
/// RLS alone is not treated as sufficient authorization for packet contents.
struct ContextPacketRoutes: Sendable {
    let db: Database

    func add(to group: RouterGroup<AppRequestContext>) {
        group.get("/v1/workspaces/:ws/context-packets/:packet", use: get)
    }

    @Sendable
    func get(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        guard let workspaceID = UUID(uuidString: try context.parameters.require("ws")),
              let packetID = UUID(uuidString: try context.parameters.require("packet"))
        else { throw HTTPError(.badRequest, message: "invalid context packet path") }
        guard workspaceID == principal.workspaceID else {
            throw HTTPError(.forbidden, message: "workspace scope mismatch")
        }

        let packet: ContextPacketDTO = try await db.withTenantConnection(
            workspaceID: workspaceID
        ) { conn in
            let rows = try await conn.query(
                """
                SELECT cp.packet_id, cp.run_id, cp.created_at, cp.expires_at,
                       cp.content::text
                  FROM context_packet cp
                  JOIN agent_run ar
                    ON ar.workspace_id = cp.workspace_id AND ar.id = cp.run_id
                 WHERE cp.workspace_id = \(workspaceID)
                   AND cp.packet_id = \(packetID)
                   AND EXISTS (
                     SELECT 1 FROM membership ms
                      WHERE ms.workspace_id = cp.workspace_id
                        AND ms.channel_id = ar.channel_id
                        AND ms.member_id = \(principal.memberID)
                        AND ms.left_at IS NULL
                   )
                 LIMIT 1
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw HTTPError(.notFound, message: "context packet not found")
            }
            let (id, runID, createdAt, expiresAt, contentText) = try row.decode(
                (UUID, UUID, Date, Date, String).self
            )
            let content = try JSONDecoder().decode(JSONValue.self, from: Data(contentText.utf8))
            return ContextPacketDTO(
                packetId: id.uuidString, runId: runID.uuidString,
                workspaceId: workspaceID.uuidString,
                createdAtMs: Int64(createdAt.timeIntervalSince1970 * 1_000),
                expiresAtMs: Int64(expiresAt.timeIntervalSince1970 * 1_000),
                expired: expiresAt <= Date(), content: content
            )
        }
        return try packet.response(from: request, context: context)
    }
}
