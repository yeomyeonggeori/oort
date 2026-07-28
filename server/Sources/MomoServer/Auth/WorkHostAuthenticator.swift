@preconcurrency import Crypto
import Foundation
import HTTPTypes
import Hummingbird
import NIOCore

struct WorkHostIdentity: Sendable, Equatable {
    let hostID: UUID
    let workspaceID: UUID
    let ownerMemberID: UUID
}

/// Authenticates the narrow REST surface used by ADR-0125 D2 execution hosts.
///
/// The host has no durable bearer. It presents its registry id through the
/// `MomoHost` authorization scheme and signs method/path/tenant/host/timestamp,
/// the raw body SHA-256, and a one-time request UUID with the Ed25519 key
/// registered in `work_host`. Revocation and atomic request-id consumption are
/// checked on every request.
struct WorkHostAuthenticator: Sendable {
    static let sentAtHeader = HTTPField.Name("X-Momo-Work-Host-Sent-At")!
    static let signatureHeader = HTTPField.Name("X-Momo-Work-Host-Signature")!
    static let requestIDHeader = HTTPField.Name("X-Momo-Work-Host-Request-ID")!
    static let maximumSignedBodyBytes = 1_048_576

    let db: Database

    func authenticate(
        authorization: String,
        request: Request
    ) async throws -> (identity: WorkHostIdentity, request: Request) {
        var request = request
        let bodyDigest: String
        do {
            let buffer = try await request.collectBody(upTo: Self.maximumSignedBodyBytes)
            bodyDigest = Self.sha256Hex(Data(buffer.readableBytesView))
        } catch {
            throw Self.unauthorized()
        }
        let method = request.method.rawValue
        let path = request.uri.path

        guard Self.isAllowed(method: method, path: path),
              let hostID = Self.hostID(fromAuthorization: authorization),
              let workspaceID = Self.workspaceID(fromPath: path),
              let sentAtText = request.headers[Self.sentAtHeader],
              let sentAtMs = Int64(sentAtText),
              let signature = request.headers[Self.signatureHeader],
              let requestIDText = request.headers[Self.requestIDHeader],
              let requestID = UUID(uuidString: requestIDText)
        else {
            throw Self.unauthorized()
        }
        try Self.validateTimestamp(sentAtMs)

        if let pathHostID = Self.scopedHostID(fromPath: path),
           pathHostID != hostID
        {
            throw Self.unauthorized()
        }

        let identity: WorkHostIdentity? = try await db.withTenantTransaction(
            workspaceID: workspaceID
        ) { conn in
            let rows = try await conn.query(
                """
                SELECT h.public_key, h.owner_member_id
                  FROM work_host h
                  JOIN member owner
                    ON owner.id = h.owner_member_id
                   AND owner.workspace_id = h.workspace_id
                   AND owner.kind = 'human'
                   AND owner.status = 'active'
                   AND owner.deleted_at IS NULL
                 WHERE h.id = \(hostID)
                   AND h.workspace_id = \(workspaceID)
                   AND h.revoked_at IS NULL
                 LIMIT 1
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else { return nil }
            let (publicKey, ownerMemberID) = try row.decode((String, UUID).self)
            guard Self.verifySignature(
                publicKey: publicKey,
                signature: signature,
                method: method,
                path: path,
                workspaceID: workspaceID,
                hostID: hostID,
                sentAtMs: sentAtMs,
                bodyDigest: bodyDigest,
                requestID: requestID
            ) else { return nil }

            _ = try await conn.query(
                """
                DELETE FROM work_host_request
                 WHERE workspace_id = \(workspaceID)
                   AND expires_at <= clock_timestamp()
                """,
                logger: db.logger
            )
            let consumed = try await conn.query(
                """
                INSERT INTO work_host_request
                  (workspace_id, request_id, host_id, expires_at)
                VALUES
                  (\(workspaceID), \(requestID), \(hostID),
                   clock_timestamp() + interval '10 minutes')
                ON CONFLICT (workspace_id, request_id) DO NOTHING
                RETURNING request_id
                """,
                logger: db.logger
            ).collect()
            guard consumed.count == 1 else { return nil }

            return WorkHostIdentity(
                hostID: hostID,
                workspaceID: workspaceID,
                ownerMemberID: ownerMemberID
            )
        }
        guard let identity else { throw Self.unauthorized() }
        return (identity, request)
    }

    static func requestSigningPayload(
        method: String,
        path: String,
        workspaceID: UUID,
        hostID: UUID,
        sentAtMs: Int64,
        bodyDigest: String,
        requestID: UUID
    ) -> Data {
        Data(
            "momo.work_host.request.v2\n"
                .appending(method.uppercased())
                .appending("\n")
                .appending(path)
                .appending("\n")
                .appending(workspaceID.uuidString.lowercased())
                .appending("\n")
                .appending(hostID.uuidString.lowercased())
                .appending("\n")
                .appending(String(sentAtMs))
                .appending("\n")
                .appending(bodyDigest)
                .appending("\n")
                .appending(requestID.uuidString.lowercased())
                .utf8
        )
    }

    static func verifySignature(
        publicKey: String,
        signature: String,
        method: String,
        path: String,
        workspaceID: UUID,
        hostID: UUID,
        sentAtMs: Int64,
        bodyDigest: String,
        requestID: UUID
    ) -> Bool {
        guard let keyBytes = Data(base64Encoded: publicKey), keyBytes.count == 32,
              let signatureBytes = Data(base64Encoded: signature), signatureBytes.count == 64,
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: keyBytes)
        else { return false }
        return key.isValidSignature(
            signatureBytes,
            for: requestSigningPayload(
                method: method,
                path: path,
                workspaceID: workspaceID,
                hostID: hostID,
                sentAtMs: sentAtMs,
                bodyDigest: bodyDigest,
                requestID: requestID
            )
        )
    }

    static func sha256Hex(_ body: Data) -> String {
        SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()
    }

    static func isAllowed(method: String, path: String) -> Bool {
        let method = method.uppercased()
        let segments = path.split(separator: "/").map(String.init)
        if method == "GET",
           segments.count == 6,
           segments[0] == "v1",
           segments[1] == "workspaces",
           segments[3] == "work-hosts",
           segments[5] == "pending-controls"
        {
            return true
        }
        if method == "GET",
           segments.count == 4,
           segments[0] == "v1",
           segments[1] == "workspaces",
           segments[3] == "work-tool-profiles"
        {
            return true
        }
        if method == "POST",
           segments.count == 7,
           segments[0] == "v1",
           segments[1] == "workspaces",
           segments[3] == "work-hosts",
           segments[5] == "terminal-attach",
           segments[6] == "validate"
        {
            return true
        }
        if method == "POST",
           segments.count == 4,
           segments[0] == "v1",
           segments[1] == "workspaces",
           segments[3] == "work-sessions"
        {
            return true
        }
        if method == "PATCH",
           segments.count == 5,
           segments[0] == "v1",
           segments[1] == "workspaces",
           segments[3] == "work-sessions"
        {
            return true
        }
        if method == "POST",
           segments.count == 6,
           segments[0] == "v1",
           segments[1] == "workspaces",
           segments[3] == "work-controls",
           segments[5] == "ack"
        {
            return true
        }
        return false
    }

    static func hostID(fromAuthorization raw: String) -> UUID? {
        let parts = raw.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
        guard parts.count == 2, parts[0].lowercased() == "momohost" else { return nil }
        return UUID(uuidString: String(parts[1]))
    }

    static func workspaceID(fromPath path: String) -> UUID? {
        let segments = path.split(separator: "/")
        guard segments.count >= 3,
              segments[0] == "v1",
              segments[1] == "workspaces"
        else { return nil }
        return UUID(uuidString: String(segments[2]))
    }

    static func scopedHostID(fromPath path: String) -> UUID? {
        let segments = path.split(separator: "/")
        guard segments.count >= 5,
              segments[3] == "work-hosts"
        else { return nil }
        return UUID(uuidString: String(segments[4]))
    }

    static func validateTimestamp(_ sentAtMs: Int64, now: Date = Date()) throws {
        let nowMs = now.timeIntervalSince1970 * 1_000
        guard sentAtMs >= 0,
              abs(Double(sentAtMs) - nowMs) <= Double(WorkHostRoutes.heartbeatClockSkewMs)
        else {
            throw unauthorized()
        }
    }

    static func unauthorized() -> HTTPError {
        HTTPError(.unauthorized, message: "invalid work host request signature")
    }
}
