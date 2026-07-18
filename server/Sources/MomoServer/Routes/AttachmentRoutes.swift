import Foundation
import Hummingbird
import Logging
import NIOCore
import PostgresNIO

private struct CreateAttachmentUploadRequest: Decodable {
    let name: String
    let mime: String
    let size: Int64
}

private struct AttachmentUploadResponse: ResponseEncodable {
    let id: String
    let status: String
    let uploadUrl: String
}

private struct AttachmentResponse: ResponseEncodable {
    let id: String
    let channelId: String
    let uploaderMemberId: String
    let messageId: String?
    let name: String
    let mime: String
    let size: Int64
    let status: String
    let createdAtMs: Int64
}

/// MOMO-474 Drive workspace archive.
///
/// Attachment bytes bypass MomoServer during upload: this route creates a
/// Google resumable session, while PostgreSQL owns authorization and lifecycle.
struct AttachmentRoutes: Sendable {
    static let maximumSizeBytes: Int64 = 100 * 1024 * 1024

    let db: Database
    let archive: any DriveArchiveClient

    func addProtected(to group: RouterGroup<AppRequestContext>) {
        group.post(
            "/v1/workspaces/:ws/channels/:ch/attachments/uploads",
            use: createUpload
        )
        group.post(
            "/v1/workspaces/:ws/channels/:ch/attachments/:attachment/complete",
            use: complete
        )
        group.get(
            "/v1/workspaces/:ws/channels/:ch/attachments/:attachment/content",
            use: content
        )
    }

    func addStubUpload(to router: Router<AppRequestContext>) {
        router.put("/__momo_stub/drive/uploads/:token", use: stubUpload)
    }

    @Sendable
    func createUpload(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let (workspaceID, channelID) = try Self.scopeIDs(context, principal: principal)
        let dto = try await request.decode(as: CreateAttachmentUploadRequest.self, context: context)
        let name = try Self.validatedName(dto.name)
        let mime = try Self.validatedMime(dto.mime)
        guard (0...Self.maximumSizeBytes).contains(dto.size) else {
            throw HTTPError(.contentTooLarge, message: "attachment size must be at most 100 MB")
        }

        try await withTenantConnectionUnwrapped(workspaceID: workspaceID) { conn in
            try await Self.requireChannelMember(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                channelID: channelID, principal: principal
            )
        }
        let session: DriveArchiveUploadSession
        do {
            session = try await archive.createResumableUpload(
                channelID: channelID, name: name, mime: mime, sizeBytes: dto.size
            )
        } catch let error as DriveArchiveError {
            throw Self.httpError(error)
        }
        let attachmentID = try await withTenantTransactionUnwrapped(
            workspaceID: workspaceID
        ) { conn in
            // Membership can change while Google creates the session. Recheck
            // before committing the pending row and its audit record.
            try await Self.requireChannelMember(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                channelID: channelID, principal: principal
            )
            let rows = try await conn.query(
                """
                INSERT INTO attachment
                  (workspace_id, channel_id, uploader_member_id, drive_file_id,
                   name, mime, size_bytes, status)
                VALUES
                  (\(workspaceID), \(channelID), \(principal.memberID),
                   \(session.driveFileID), \(name), \(mime), \(dto.size), 'pending')
                RETURNING id
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw HTTPError(.internalServerError, message: "attachment row was not created")
            }
            let attachmentID = try row.decode(UUID.self)
            try await Self.insertAudit(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                principal: principal, action: "attachment.upload_started",
                attachmentID: attachmentID, channelID: channelID,
                detail: ["name": name, "mime": mime, "size_bytes": String(dto.size)]
            )
            return attachmentID
        }

        var response = try AttachmentUploadResponse(
            id: attachmentID.uuidString,
            status: "pending",
            uploadUrl: session.uploadURL
        ).response(from: request, context: context)
        response.status = .created
        return response
    }

    @Sendable
    func complete(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let (workspaceID, channelID) = try Self.scopeIDs(context, principal: principal)
        let attachmentID = try Self.attachmentID(context)

        let pending = try await withTenantConnectionUnwrapped(workspaceID: workspaceID) { conn in
            try await Self.requireChannelMember(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                channelID: channelID, principal: principal
            )
            return try await Self.loadAttachment(
                conn: conn, logger: db.logger, attachmentID: attachmentID,
                channelID: channelID, uploaderMemberID: principal.memberID
            )
        }
        guard let pending else { throw HTTPError(.notFound, message: "attachment not found") }
        if pending.status == "complete" {
            return try pending.response.response(from: request, context: context)
        }
        guard pending.status == "pending", let driveFileID = pending.driveFileID else {
            throw HTTPError(.conflict, message: "attachment upload cannot be completed")
        }

        let metadata: DriveArchiveFile
        do {
            metadata = try await archive.fileMetadata(fileID: driveFileID)
        } catch let error as DriveArchiveError {
            throw Self.httpError(error)
        }
        let matches = metadata.sizeBytes == pending.size
            && metadata.mime == pending.mime
            && metadata.driveFileID == driveFileID

        let completed = try await withTenantTransactionUnwrapped(workspaceID: workspaceID) { conn in
            try await Self.requireChannelMember(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                channelID: channelID, principal: principal
            )
            let locked = try await Self.loadAttachment(
                conn: conn, logger: db.logger, attachmentID: attachmentID,
                channelID: channelID, uploaderMemberID: principal.memberID,
                forUpdate: true
            )
            guard let locked else { throw HTTPError(.notFound, message: "attachment not found") }
            if locked.status == "complete" { return locked.response }
            guard locked.status == "pending", locked.driveFileID == driveFileID else {
                throw HTTPError(.conflict, message: "attachment upload state changed")
            }
            let nextStatus = matches ? "complete" : "failed"
            _ = try await conn.query(
                "UPDATE attachment SET status = \(nextStatus) WHERE id = \(attachmentID)",
                logger: db.logger
            )
            try await Self.insertAudit(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                principal: principal,
                action: matches ? "attachment.upload_completed" : "attachment.upload_failed",
                attachmentID: attachmentID, channelID: channelID,
                detail: [
                    "expected_mime": locked.mime,
                    "actual_mime": metadata.mime,
                    "expected_size_bytes": String(locked.size),
                    "actual_size_bytes": String(metadata.sizeBytes),
                ]
            )
            return AttachmentResponse(
                id: locked.id.uuidString,
                channelId: locked.channelID.uuidString,
                uploaderMemberId: locked.uploaderMemberID.uuidString,
                messageId: locked.messageID?.uuidString,
                name: locked.name,
                mime: locked.mime,
                size: locked.size,
                status: nextStatus,
                createdAtMs: Int64(locked.createdAt.timeIntervalSince1970 * 1000)
            )
        }
        guard matches else {
            throw HTTPError(.conflict, message: "uploaded file size or mime does not match")
        }
        return try completed.response(from: request, context: context)
    }

    @Sendable
    func content(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let (workspaceID, channelID) = try Self.scopeIDs(context, principal: principal)
        let attachmentID = try Self.attachmentID(context)
        let attachment = try await withTenantConnectionUnwrapped(workspaceID: workspaceID) { conn in
            try await Self.requireChannelMember(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                channelID: channelID, principal: principal
            )
            return try await Self.loadAttachment(
                conn: conn, logger: db.logger, attachmentID: attachmentID,
                channelID: channelID, uploaderMemberID: nil
            )
        }
        guard let attachment, attachment.status == "complete",
              let driveFileID = attachment.driveFileID
        else { throw HTTPError(.notFound, message: "completed attachment not found") }
        let archived: DriveArchiveContent
        do {
            archived = try await archive.fileContent(
                fileID: driveFileID, maxBytes: Int(Self.maximumSizeBytes)
            )
        } catch let error as DriveArchiveError {
            throw Self.httpError(error)
        }
        var headers = HTTPFields()
        headers[.contentType] = archived.mime
        headers[.contentLength] = String(archived.sizeBytes)
        return Response(
            status: .ok,
            headers: headers,
            body: archived.body
        )
    }

    @Sendable
    func stubUpload(_ request: Request, context: AppRequestContext) async throws -> Response {
        let token = try context.parameters.require("token")
        guard token.wholeMatch(of: /^[a-f0-9-]{36}$/) != nil else {
            throw HTTPError(.notFound, message: "stub upload session not found")
        }
        let data: Data
        do {
            var buffer = try await request.body.collect(upTo: Int(Self.maximumSizeBytes))
            data = buffer.readData(length: buffer.readableBytes) ?? Data()
        } catch {
            throw HTTPError(.contentTooLarge, message: "attachment size must be at most 100 MB")
        }
        do {
            try await archive.acceptStubUpload(
                token: token,
                mime: request.headers[.contentType],
                bytes: data
            )
        } catch let error as DriveArchiveError {
            throw Self.httpError(error)
        }
        return Response(status: .ok)
    }

    private struct LoadedAttachment: Sendable {
        let id: UUID
        let channelID: UUID
        let uploaderMemberID: UUID
        let messageID: UUID?
        let driveFileID: String?
        let name: String
        let mime: String
        let size: Int64
        let status: String
        let createdAt: Date

        var response: AttachmentResponse {
            AttachmentResponse(
                id: id.uuidString, channelId: channelID.uuidString,
                uploaderMemberId: uploaderMemberID.uuidString,
                messageId: messageID?.uuidString, name: name, mime: mime,
                size: size, status: status,
                createdAtMs: Int64(createdAt.timeIntervalSince1970 * 1000)
            )
        }
    }

    private static func loadAttachment(
        conn: PostgresConnection,
        logger: Logger,
        attachmentID: UUID,
        channelID: UUID,
        uploaderMemberID: UUID?,
        forUpdate: Bool = false
    ) async throws -> LoadedAttachment? {
        let rows: [PostgresRow]
        if let uploaderMemberID {
            rows = try await conn.query(
                """
                SELECT id, channel_id, uploader_member_id, message_id, drive_file_id,
                       name, mime, size_bytes, status, created_at
                  FROM attachment
                 WHERE id = \(attachmentID) AND channel_id = \(channelID)
                   AND uploader_member_id = \(uploaderMemberID)
                \(unescaped: forUpdate ? "FOR UPDATE" : "")
                """,
                logger: logger
            ).collect()
        } else {
            rows = try await conn.query(
                """
                SELECT id, channel_id, uploader_member_id, message_id, drive_file_id,
                       name, mime, size_bytes, status, created_at
                  FROM attachment
                 WHERE id = \(attachmentID) AND channel_id = \(channelID)
                \(unescaped: forUpdate ? "FOR UPDATE" : "")
                """,
                logger: logger
            ).collect()
        }
        guard let row = rows.first else { return nil }
        let values = try row.decode(
            (UUID, UUID, UUID, UUID?, String?, String, String, Int64, String, Date).self
        )
        return LoadedAttachment(
            id: values.0, channelID: values.1, uploaderMemberID: values.2,
            messageID: values.3, driveFileID: values.4, name: values.5,
            mime: values.6, size: values.7, status: values.8, createdAt: values.9
        )
    }

    private func withTenantTransactionUnwrapped<Result: Sendable>(
        workspaceID: UUID,
        _ body: @Sendable (PostgresConnection) async throws -> Result
    ) async throws -> Result {
        do { return try await db.withTenantTransaction(workspaceID: workspaceID, body) }
        catch let error as PostgresTransactionError {
            if let http = error.closureError as? HTTPError { throw http }
            throw error
        }
    }

    private func withTenantConnectionUnwrapped<Result: Sendable>(
        workspaceID: UUID,
        _ body: @Sendable (PostgresConnection) async throws -> Result
    ) async throws -> Result {
        do { return try await db.withTenantConnection(workspaceID: workspaceID, body) }
        catch let error as PostgresTransactionError {
            if let http = error.closureError as? HTTPError { throw http }
            throw error
        }
    }

    private static func requireChannelMember(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        channelID: UUID,
        principal: AuthPrincipal
    ) async throws {
        let rows = try await conn.query(
            """
            SELECT 1
              FROM channel c
              JOIN membership ms ON ms.channel_id = c.id
                                AND ms.member_id = \(principal.memberID)
                                AND ms.left_at IS NULL
              JOIN member m ON m.id = ms.member_id
                           AND m.workspace_id = c.workspace_id
                           AND m.status = 'active'
                           AND m.deleted_at IS NULL
             WHERE c.id = \(channelID)
               AND c.workspace_id = \(workspaceID)
               AND c.archived_at IS NULL
            """,
            logger: logger
        ).collect()
        guard rows.first != nil else {
            throw HTTPError(.forbidden, message: "active channel membership required")
        }
    }

    private static func insertAudit(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        principal: AuthPrincipal,
        action: String,
        attachmentID: UUID,
        channelID: UUID,
        detail: [String: String]
    ) async throws {
        var object: [String: String] = detail
        object["schema"] = "momo.\(action).v1"
        object["channel_id"] = channelID.uuidString.lowercased()
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        guard let json = String(data: data, encoding: .utf8) else {
            throw HTTPError(.internalServerError, message: "attachment audit encoding failed")
        }
        _ = try await conn.query(
            """
            INSERT INTO audit_log
              (workspace_id, actor_member_id, action, target_type,
               target_id, via_token_id, detail)
            VALUES
              (\(workspaceID), \(principal.memberID), \(action), 'attachment',
               \(attachmentID), \(principal.tokenID), \(json)::jsonb)
            """,
            logger: logger
        )
    }

    private static func scopeIDs(
        _ context: AppRequestContext,
        principal: AuthPrincipal
    ) throws -> (UUID, UUID) {
        let workspace = try context.parameters.require("ws")
        let channel = try context.parameters.require("ch")
        guard let workspaceID = UUID(uuidString: workspace),
              let channelID = UUID(uuidString: channel)
        else { throw HTTPError(.badRequest, message: "invalid workspace or channel id") }
        guard workspaceID == principal.workspaceID else {
            throw HTTPError(.forbidden, message: "workspace scope mismatch")
        }
        return (workspaceID, channelID)
    }

    private static func attachmentID(_ context: AppRequestContext) throws -> UUID {
        let raw = try context.parameters.require("attachment")
        guard let id = UUID(uuidString: raw) else {
            throw HTTPError(.badRequest, message: "invalid attachment id")
        }
        return id
    }

    private static func validatedName(_ raw: String) throws -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value.count <= 255,
              !value.contains("/"), !value.contains("\\"),
              !value.contains("\0")
        else { throw HTTPError(.badRequest, message: "attachment name is invalid") }
        return value
    }

    private static func validatedMime(_ raw: String) throws -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !value.isEmpty, value.count <= 255,
              value.wholeMatch(of: /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/) != nil
        else { throw HTTPError(.badRequest, message: "attachment mime is invalid") }
        return value
    }

    private static func httpError(_ error: DriveArchiveError) -> HTTPError {
        switch error {
        case .unavailable: HTTPError(.serviceUnavailable, message: error.safeMessage)
        case .invalidArguments: HTTPError(.badRequest, message: error.safeMessage)
        case .accessDenied: HTTPError(.badGateway, message: error.safeMessage)
        case .fileNotFound: HTTPError(.notFound, message: error.safeMessage)
        case .contentTooLarge: HTTPError(.contentTooLarge, message: error.safeMessage)
        case .upstreamFailure: HTTPError(.badGateway, message: error.safeMessage)
        }
    }
}
