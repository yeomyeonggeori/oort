import Foundation
import Hummingbird
import Logging
import PostgresNIO

/// Workspace message search v0. This is a read-only surface: tenant-scoped
/// PostgreSQL is the source of truth and no audit/outbox rows are produced.
struct SearchRoutes: Sendable {
    static let requestLimit = 30
    static let windowSeconds = 60

    let db: Database
    let limiter: SlidingWindowRateLimiter

    func add(to group: RouterGroup<AppRequestContext>) {
        group.get("/v1/workspaces/:ws/search/messages", use: messages)
    }

    @Sendable
    func messages(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let parameters = request.uri.queryParameters
        let query = try Self.normalizedQuery(parameters["q"].map(String.init))
        let limit = min(max(parameters["limit"].flatMap { Int($0) } ?? 20, 1), 50)
        let cursor = try parameters["cursor"].map { try Self.decodeCursor(String($0)) }

        let verdict = await limiter.check(
            key: "search:member:\(principal.memberID.uuidString)",
            limit: Self.requestLimit,
            windowSeconds: Self.windowSeconds
        )
        guard verdict.allowed else {
            return RateLimitSupport.tooManyRequests(
                retryAfterSeconds: verdict.retryAfterSeconds
            )
        }

        let pattern = Self.literalLikePattern(query)
        let rows: [PostgresRow] = try await withTenantTransactionUnwrapped(
            workspaceID: workspaceID
        ) { conn in
            if let cursor {
                return try await conn.query(
                    """
                    SELECT m.channel_id,
                           m.id,
                           m.seq,
                           m.author_member_id,
                           round(extract(epoch FROM m.created_at) * 1000000)::bigint,
                           substring(
                             m.body FROM greatest(strpos(lower(m.body), lower(\(query))) - 80, 1)
                                    FOR char_length(\(query)) + 160
                           ),
                           strpos(lower(m.body), lower(\(query)))
                             - greatest(strpos(lower(m.body), lower(\(query))) - 80, 1)
                      FROM message m
                      JOIN membership ms
                        ON ms.workspace_id = m.workspace_id
                       AND ms.channel_id = m.channel_id
                       AND ms.member_id = \(principal.memberID)
                       AND ms.left_at IS NULL
                      JOIN member caller
                        ON caller.id = ms.member_id
                       AND caller.workspace_id = m.workspace_id
                       AND caller.status = 'active'
                       AND caller.deleted_at IS NULL
                     WHERE m.workspace_id = \(workspaceID)
                       AND m.deleted_at IS NULL
                       AND m.body IS NOT NULL
                       AND m.body ILIKE \(pattern)
                       AND (m.created_at, m.seq, m.id) < (
                             to_timestamp(\(cursor.createdAtMicros)::double precision / 1000000.0),
                             \(cursor.seq),
                             \(cursor.messageID)
                           )
                     ORDER BY m.created_at DESC, m.seq DESC, m.id DESC
                     LIMIT \(limit + 1)
                    """,
                    logger: db.logger
                ).collect()
            }
            return try await conn.query(
                """
                SELECT m.channel_id,
                       m.id,
                       m.seq,
                       m.author_member_id,
                       round(extract(epoch FROM m.created_at) * 1000000)::bigint,
                       substring(
                         m.body FROM greatest(strpos(lower(m.body), lower(\(query))) - 80, 1)
                                FOR char_length(\(query)) + 160
                       ),
                       strpos(lower(m.body), lower(\(query)))
                         - greatest(strpos(lower(m.body), lower(\(query))) - 80, 1)
                  FROM message m
                  JOIN membership ms
                    ON ms.workspace_id = m.workspace_id
                   AND ms.channel_id = m.channel_id
                   AND ms.member_id = \(principal.memberID)
                   AND ms.left_at IS NULL
                  JOIN member caller
                    ON caller.id = ms.member_id
                   AND caller.workspace_id = m.workspace_id
                   AND caller.status = 'active'
                   AND caller.deleted_at IS NULL
                 WHERE m.workspace_id = \(workspaceID)
                   AND m.deleted_at IS NULL
                   AND m.body IS NOT NULL
                   AND m.body ILIKE \(pattern)
                 ORDER BY m.created_at DESC, m.seq DESC, m.id DESC
                 LIMIT \(limit + 1)
                """,
                logger: db.logger
            ).collect()
        }

        let decoded = try rows.map(Self.decodeHit)
        let hasMore = decoded.count > limit
        let pageHits = Array(decoded.prefix(limit))
        let nextCursor = hasMore ? pageHits.last.map { Self.encodeCursor($0.cursor) } : nil
        let response = WorkspaceMessageSearchResponse(
            hits: pageHits.map { $0.dto },
            nextCursor: nextCursor
        )
        return try response.response(from: request, context: context)
    }

    static func normalizedQuery(_ raw: String?) throws -> String {
        let query = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard query.count >= 2 else {
            throw HTTPError(.badRequest, message: "q must contain at least 2 characters")
        }
        return query
    }

    /// Treat `%`, `_`, and `\\` as literal search text rather than LIKE syntax.
    static func literalLikePattern(_ query: String) -> String {
        let escaped = query
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "%", with: "\\%")
            .replacingOccurrences(of: "_", with: "\\_")
        return "%\(escaped)%"
    }

    private func withTenantTransactionUnwrapped<Result: Sendable>(
        workspaceID: UUID,
        _ body: @Sendable (PostgresConnection) async throws -> Result
    ) async throws -> Result {
        do {
            return try await db.withTenantTransaction(workspaceID: workspaceID, body)
        } catch let error as PostgresTransactionError {
            if let http = error.closureError as? HTTPError { throw http }
            throw error
        }
    }

    struct Cursor: Codable, Equatable, Sendable {
        let createdAtMicros: Int64
        let seq: Int64
        let messageID: UUID
    }

    private struct DecodedHit: Sendable {
        let dto: WorkspaceMessageSearchHitDTO
        let cursor: Cursor
    }

    private static func decodeHit(_ row: PostgresRow) throws -> DecodedHit {
        let (channelID, messageID, seq, authorID, createdAtMicros, snippet, matchOffset) =
            try row.decode((UUID, UUID, Int64, UUID, Int64, String, Int).self)
        return DecodedHit(
            dto: WorkspaceMessageSearchHitDTO(
                channelId: channelID.uuidString,
                messageId: messageID.uuidString,
                seq: seq,
                authorMemberId: authorID.uuidString,
                createdAtMs: createdAtMicros / 1000,
                snippet: snippet,
                matchOffset: matchOffset
            ),
            cursor: Cursor(
                createdAtMicros: createdAtMicros,
                seq: seq,
                messageID: messageID
            )
        )
    }

    static func encodeCursor(_ cursor: Cursor) -> String {
        let data = try! JSONEncoder().encode(cursor)
        return data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func decodeCursor(_ encoded: String) throws -> Cursor {
        var base64 = encoded
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let data = Data(base64Encoded: base64),
              let cursor = try? JSONDecoder().decode(Cursor.self, from: data),
              cursor.createdAtMicros >= 0,
              cursor.seq >= 0
        else {
            throw HTTPError(.badRequest, message: "invalid cursor")
        }
        return cursor
    }
}
