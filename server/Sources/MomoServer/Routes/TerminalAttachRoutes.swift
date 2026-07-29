import Foundation
import Hummingbird
import Logging
import PostgresNIO

struct RemotePTYBinding: Sendable, Equatable {
    let ptyID: String
    let attachEndpoint: String

    /// Host-side semantic contract (ADR-0125 D10):
    ///
    /// - `create` starts the tool inside a PTY and returns this stable binding.
    /// - `connect(ptyID)` attaches without spawning another tool process.
    /// - `send_stdin`, `resize`, and `kill` target the same `ptyID`.
    /// - stdout/stderr bytes flow only between the client and this endpoint.
    ///
    /// MomoServer persists and authorizes the binding; it never implements any
    /// byte-stream operation. Real workd/provisioner PTY adapters are follow-up.
    static func validated(ptyID: String?, attachEndpoint: String?) throws -> Self? {
        guard ptyID != nil || attachEndpoint != nil else { return nil }
        guard let ptyID, let attachEndpoint else {
            throw HTTPError(
                .badRequest,
                message: "ptyId and attachEndpoint must be provided together"
            )
        }
        guard ptyID.wholeMatch(of: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/) != nil else {
            throw HTTPError(.badRequest, message: "ptyId is invalid")
        }
        guard attachEndpoint.count <= 2_048,
              !attachEndpoint.contains("\0"),
              let components = URLComponents(string: attachEndpoint),
              let scheme = components.scheme?.lowercased(),
              scheme == "https" || scheme == "wss",
              // Foundation reports an empty string, not nil, for "wss:///path".
              let host = components.host, !host.isEmpty,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil
        else {
            throw HTTPError(
                .badRequest,
                message: "attachEndpoint must be a credential-free HTTPS or WSS URL"
            )
        }
        return Self(ptyID: ptyID, attachEndpoint: attachEndpoint)
    }
}

struct TerminalAttachCapabilityResponse: ResponseEncodable, Codable, Sendable, Equatable {
    let attachEndpoint: String
    let capabilityToken: String
    let ptyID: String

    enum CodingKeys: String, CodingKey {
        case attachEndpoint = "attach_endpoint"
        case capabilityToken = "capability_token"
        case ptyID = "pty_id"
    }
}

enum TerminalAttachMode: String, Codable, Sendable, CaseIterable {
    case controller
    case observer
}

struct IssueTerminalAttachRequest: Decodable, Sendable {
    let mode: TerminalAttachMode?
}

struct ValidateTerminalAttachRequest: Decodable, Sendable {
    let capabilityToken: String
    /// MOMO-674: this call is the host RE-checking a stream it already accepted,
    /// not a client dialling in.
    ///
    /// The only clause it changes is expiry, and the reason is what the TTL is
    /// FOR: 60 seconds bounds the window between minting a bearer and dialling
    /// with it, because that is when the token is in a clipboard, a URL bar, a
    /// proxy log. Once this host has accepted a socket on that token — after a
    /// full, TTL-enforcing validation — the dial window is closed and the token
    /// has no further job. What still has to be true every 30 seconds is the
    /// AUTHORIZATION, and every other clause in the join below is exactly that:
    /// the session is still running or idle, the host is not revoked, the
    /// grantee is still an active human, an observer's channel membership and
    /// the session's open observation still hold.
    ///
    /// It is not a wider door. Only a MomoHost signature reaches this route, and
    /// a host only sets this for a socket it is already serving, so nothing a
    /// stolen token can do with it that serving the stream would not already do.
    let stream: Bool?

    enum CodingKeys: String, CodingKey {
        case capabilityToken = "capability_token"
        case stream
    }
}

struct TerminalAttachValidationResponse: ResponseEncodable, Codable, Sendable, Equatable {
    let workSessionID: String
    let ptyID: String
    let expiresAt: String
    let mode: TerminalAttachMode

    enum CodingKeys: String, CodingKey {
        case workSessionID = "work_session_id"
        case ptyID = "pty_id"
        case expiresAt = "expires_at"
        case mode
    }
}

/// ADR-0125 D10 capability control plane.
///
/// MomoServer issues an opaque, short-lived bearer to an authorized human.
/// The direct PTY host validates that bearer through its existing MomoHost
/// signature before accepting a client connection, and re-validates it on a
/// timer for as long as the stream is open (`stream: true`). Validation joins
/// the live work_host and active (running or idle) work_session on every call,
/// making expiry, session end, and host revocation immediately authoritative.
/// There is intentionally no stream, websocket, stdin, stdout, resize, or relay
/// route in this server.
struct TerminalAttachRoutes: Sendable {
    static let capabilityTTLSeconds: Int64 = 60
    static let capabilityPrefix = "momo_terminal_attach_v1"

    /// How long a spent observer row is kept before the next issue on the same
    /// session sweeps it (MOMO-674).
    ///
    /// This used to be zero — expired meant collectable. That was safe only
    /// while a capability was checked once: now a host re-validates the SAME row
    /// for the life of the stream, so deleting it the moment its dial window
    /// closes would make one teammate pressing 관전 시작 cut every other observer
    /// off the session within a revalidation period. Nothing user-visible reads
    /// these rows — the 관전 권한 badge counts `expires_at > clock_timestamp()`
    /// itself, so a row lingering past its expiry is invisible to it — which is
    /// why the window can be widened without touching what any client says.
    static let observerCapabilityRetention = "1 hour"

    let db: Database

    func add(to group: RouterGroup<AppRequestContext>) {
        group.post(
            "/v1/workspaces/:ws/work-sessions/:session/terminal-attach",
            use: issue
        )
        group.post(
            "/v1/workspaces/:ws/work-hosts/:host/terminal-attach/validate",
            use: validate
        )
    }

    @Sendable
    func issue(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        guard principal.kind == .human else {
            throw HTTPError(.forbidden, message: "terminal attach requires a human bearer")
        }
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let sessionID = try Self.sessionID(context)
        let mode = try await Self.issueMode(request, context: context)
        let token = Self.mintCapabilityToken()

        let binding: RemotePTYBinding = try await withTenantTransactionUnwrapped(
            workspaceID: workspaceID
        ) { conn in
            try await InviteRoutes.requireWorkspaceMember(
                conn: conn,
                logger: db.logger,
                principal: principal
            )
            let rows = try await conn.query(
                """
                SELECT ws.member_id, ws.host_id, ws.channel_id, ws.pty_id,
                       ws.attach_endpoint, ws.status, ws.observation, h.revoked_at
                  FROM work_session ws
                  JOIN work_host h
                    ON h.id = ws.host_id
                   AND h.workspace_id = ws.workspace_id
                 WHERE ws.id = \(sessionID)
                 FOR UPDATE OF ws, h
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw HTTPError(.notFound, message: "work session not found")
            }
            let (ownerMemberID, hostID, channelID, ptyID, attachEndpoint,
                 status, observation, revokedAt) = try row.decode(
                    (UUID, UUID, UUID, String?, String?, String, String, Date?).self
                 )
            switch mode {
            case .controller:
                guard ownerMemberID == principal.memberID else {
                    throw HTTPError(.forbidden, message: "only the session owner can attach as controller")
                }
            case .observer:
                guard observation == WorkSessionObservation.open.rawValue else {
                    throw HTTPError(.forbidden, message: "session observation is owner-only")
                }
                try await WorkSessionRoutes.requireChannelMember(
                    conn: conn,
                    logger: db.logger,
                    workspaceID: workspaceID,
                    channelID: channelID,
                    memberID: principal.memberID
                )
            }
            guard (status == "running" || status == "idle"), revokedAt == nil,
                  let binding = try RemotePTYBinding.validated(
                    ptyID: ptyID,
                    attachEndpoint: attachEndpoint
                  )
            else {
                throw HTTPError(.conflict, message: "terminal attach is unavailable")
            }

            _ = try await conn.query(
                "DELETE FROM terminal_attach_capability WHERE work_session_id = \(sessionID) AND mode = 'observer' AND expires_at <= clock_timestamp() - interval '\(unescaped: Self.observerCapabilityRetention)'",
                logger: db.logger
            )
            let issuedRows = try await conn.query(
                """
                WITH issued AS (
                  INSERT INTO terminal_attach_capability
                    (workspace_id, work_session_id, host_id, owner_member_id,
                     token_hash, expires_at, mode)
                  VALUES
                    (\(workspaceID), \(sessionID), \(hostID), \(principal.memberID),
                     digest(\(token), 'sha256'),
                     clock_timestamp() + interval '\(unescaped: String(Self.capabilityTTLSeconds)) seconds',
                     \(mode.rawValue))
                  RETURNING id, issued_at, expires_at
                ), audited AS (
                  INSERT INTO audit_log
                    (workspace_id, actor_member_id, subject_member_id, action,
                     target_type, target_id, via_token_id, detail)
                  SELECT \(workspaceID), \(principal.memberID), \(principal.memberID),
                         'work.terminal_attach.issued', 'work_session', \(sessionID),
                         \(principal.tokenID),
                         jsonb_build_object(
                           'schema', 'momo.work.terminal_attach.issued.v1',
                           'owner_member_id', \(ownerMemberID),
                           'mode', \(mode.rawValue),
                           'issued_at', issued_at,
                           'expires_at', expires_at
                         )
                    FROM issued
                  RETURNING id
                )
                SELECT issued.id, issued.issued_at, issued.expires_at, audited.id
                  FROM issued CROSS JOIN audited
                """,
                logger: db.logger
            ).collect()
            guard let issuedRow = issuedRows.first else {
                throw HTTPError(
                    .internalServerError,
                    message: "terminal attach capability was not issued"
                )
            }
            let grantID = try issuedRow.decode((UUID, Date, Date, UUID).self).0
            if mode == .observer {
                let countRows = try await conn.query(
                    """
                    SELECT count(*)
                      FROM terminal_attach_capability
                     WHERE work_session_id = \(sessionID)
                       AND mode = 'observer'
                       AND expires_at > clock_timestamp()
                    """,
                    logger: db.logger
                ).collect()
                let observerCount = try countRows.first?.decode(Int64.self) ?? 0
                let payload = Self.observerPayload(
                    workspaceID: workspaceID,
                    channelID: channelID,
                    sessionID: sessionID,
                    observerCount: observerCount,
                    grantID: grantID
                )
                _ = try await conn.query(
                    """
                    INSERT INTO outbox
                      (workspace_id, kind, method, payload, partition_key)
                    VALUES
                      (\(workspaceID), 'broadcast', 'publish',
                       \(payload)::jsonb, \(channelID))
                    """,
                    logger: db.logger
                )
            }
            return binding
        }

        return try TerminalAttachCapabilityResponse(
            attachEndpoint: binding.attachEndpoint,
            capabilityToken: token,
            ptyID: binding.ptyID
        ).response(from: request, context: context)
    }

    @Sendable
    func validate(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        guard principal.kind == .workHost else {
            throw HTTPError(.forbidden, message: "terminal attach validation requires work host signature")
        }
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let hostID = try Self.hostID(context)
        guard hostID == principal.tokenID else { throw Self.invalidCapability() }
        let requestDTO = try await request.decode(
            as: ValidateTerminalAttachRequest.self,
            context: context
        )
        let token = try Self.validatedCapabilityToken(requestDTO.capabilityToken)
        let revalidating = requestDTO.stream ?? false

        let validated: TerminalAttachValidationResponse? = try await db.withTenantConnection(
            workspaceID: workspaceID
        ) { conn in
            let rows = try await conn.query(
                """
                SELECT c.work_session_id, ws.pty_id, c.expires_at, c.mode
                  FROM terminal_attach_capability c
                  JOIN work_session ws
                    ON ws.id = c.work_session_id
                   AND ws.workspace_id = c.workspace_id
                   AND ws.host_id = c.host_id
                  JOIN work_host h
                    ON h.id = c.host_id
                   AND h.workspace_id = c.workspace_id
                  JOIN member grantee
                    ON grantee.id = c.owner_member_id
                   AND grantee.workspace_id = c.workspace_id
                   AND grantee.kind = 'human'
                   AND grantee.status = 'active'
                   AND grantee.deleted_at IS NULL
                 WHERE c.workspace_id = \(workspaceID)
                   AND c.host_id = \(hostID)
                   AND c.token_hash = digest(\(token), 'sha256')
                   AND (\(revalidating) OR c.expires_at > clock_timestamp())
                   AND ws.status IN ('running', 'idle')
                   AND ws.pty_id IS NOT NULL
                   AND ws.attach_endpoint IS NOT NULL
                   AND h.revoked_at IS NULL
                   AND (
                     (c.mode = 'controller' AND c.owner_member_id = ws.member_id)
                     OR (
                       c.mode = 'observer'
                       AND ws.observation = 'open'
                       AND EXISTS (
                         SELECT 1
                           FROM membership ms
                          WHERE ms.workspace_id = c.workspace_id
                            AND ms.channel_id = ws.channel_id
                            AND ms.member_id = c.owner_member_id
                            AND ms.left_at IS NULL
                       )
                     )
                   )
                 LIMIT 1
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else { return nil }
            let (workSessionID, ptyID, expiresAt, modeRaw) = try row.decode(
                (UUID, String, Date, String).self
            )
            guard let mode = TerminalAttachMode(rawValue: modeRaw) else { return nil }
            return TerminalAttachValidationResponse(
                workSessionID: workSessionID.uuidString,
                ptyID: ptyID,
                expiresAt: Self.iso8601(expiresAt),
                mode: mode
            )
        }
        guard let validated else { throw Self.invalidCapability() }
        return try validated.response(from: request, context: context)
    }

    static func mintCapabilityToken() -> String {
        "\(capabilityPrefix).\(WebhookCrypto.randomReference())"
    }

    static func validatedCapabilityToken(_ raw: String) throws -> String {
        let parts = raw.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 2,
              parts[0] == Substring(capabilityPrefix),
              parts[1].wholeMatch(of: /^[A-Za-z0-9_-]{43}$/) != nil
        else { throw invalidCapability() }
        return raw
    }

    static func observerPayload(
        workspaceID: UUID,
        channelID: UUID,
        sessionID: UUID,
        observerCount: Int64,
        grantID: UUID,
        timestampMs: Int64 = Int64(Date().timeIntervalSince1970 * 1_000)
    ) -> String {
        let channel = "ch:ws\(workspaceID.uuidString).\(channelID.uuidString)"
        return jsonString([
            "channel": channel,
            "data": [
                "type": "work.session.observer",
                "v": 1,
                "ts": timestampMs,
                "payload": [
                    "session_id": sessionID.uuidString,
                    "observer_count": observerCount,
                ],
            ],
            "idempotency_key": "\(channel):work.session.observer:\(grantID.uuidString)",
        ])
    }

    private static func issueMode(
        _ request: Request,
        context _: AppRequestContext
    ) async throws -> TerminalAttachMode {
        var buffer = try await request.body.collect(upTo: 128)
        guard buffer.readableBytes > 0 else { return .controller }
        let data = buffer.readData(length: buffer.readableBytes) ?? Data()
        do {
            return try JSONDecoder().decode(IssueTerminalAttachRequest.self, from: data).mode
                ?? .controller
        } catch {
            throw HTTPError(.badRequest, message: "mode must be controller or observer")
        }
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

    private static func sessionID(_ context: AppRequestContext) throws -> UUID {
        let raw = try context.parameters.require("session")
        guard let id = UUID(uuidString: raw) else {
            throw HTTPError(.badRequest, message: "invalid work session id")
        }
        return id
    }

    private static func hostID(_ context: AppRequestContext) throws -> UUID {
        let raw = try context.parameters.require("host")
        guard let id = UUID(uuidString: raw) else { throw invalidCapability() }
        return id
    }

    private static func invalidCapability() -> HTTPError {
        HTTPError(.unauthorized, message: "invalid terminal attach capability")
    }

    private static func iso8601(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private static func jsonString(_ object: Any) -> String {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(
                withJSONObject: object,
                options: [.sortedKeys]
              ),
              let json = String(data: data, encoding: .utf8)
        else { return "{}" }
        return json
    }
}
