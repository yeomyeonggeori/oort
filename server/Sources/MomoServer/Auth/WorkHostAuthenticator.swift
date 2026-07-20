@preconcurrency import Crypto
import Foundation
import HTTPTypes
import Hummingbird

struct WorkHostIdentity: Sendable, Equatable {
    let hostID: UUID
    let workspaceID: UUID
    let ownerMemberID: UUID
}

/// Authenticates the narrow REST surface used by ADR-0125 D2 execution hosts.
///
/// The host has no durable bearer. It presents its registry id through the
/// `MomoHost` authorization scheme and signs method/path/tenant/host/timestamp
/// bytes with the Ed25519 key registered in `work_host`. TLS protects the body;
/// the signed path and strict allowlist prevent a captured signature from being
/// moved to another API surface. Revocation is checked on every request.
struct WorkHostAuthenticator: Sendable {
    static let sentAtHeader = HTTPField.Name("X-Momo-Work-Host-Sent-At")!
    static let signatureHeader = HTTPField.Name("X-Momo-Work-Host-Signature")!

    let db: Database

    func authenticate(
        authorization: String,
        request: Request
    ) async throws -> WorkHostIdentity {
        guard Self.isAllowed(method: request.method.rawValue, path: request.uri.path),
              let hostID = Self.hostID(fromAuthorization: authorization),
              let workspaceID = Self.workspaceID(fromPath: request.uri.path),
              let sentAtText = request.headers[Self.sentAtHeader],
              let sentAtMs = Int64(sentAtText),
              let signature = request.headers[Self.signatureHeader]
        else {
            throw Self.unauthorized()
        }
        try Self.validateTimestamp(sentAtMs)

        if let pathHostID = Self.pendingControlsHostID(fromPath: request.uri.path),
           pathHostID != hostID
        {
            throw Self.unauthorized()
        }

        let identity: WorkHostIdentity? = try await db.withTenantConnection(
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
                method: request.method.rawValue,
                path: request.uri.path,
                workspaceID: workspaceID,
                hostID: hostID,
                sentAtMs: sentAtMs
            ) else { return nil }
            return WorkHostIdentity(
                hostID: hostID,
                workspaceID: workspaceID,
                ownerMemberID: ownerMemberID
            )
        }
        guard let identity else { throw Self.unauthorized() }
        return identity
    }

    static func requestSigningPayload(
        method: String,
        path: String,
        workspaceID: UUID,
        hostID: UUID,
        sentAtMs: Int64
    ) -> Data {
        Data(
            "momo.work_host.request.v1\n"
                .appending(method.uppercased())
                .appending("\n")
                .appending(path)
                .appending("\n")
                .appending(workspaceID.uuidString.lowercased())
                .appending("\n")
                .appending(hostID.uuidString.lowercased())
                .appending("\n")
                .appending(String(sentAtMs))
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
        sentAtMs: Int64
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
                sentAtMs: sentAtMs
            )
        )
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

    static func pendingControlsHostID(fromPath path: String) -> UUID? {
        let segments = path.split(separator: "/")
        guard segments.count == 6,
              segments[3] == "work-hosts",
              segments[5] == "pending-controls"
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
