import Foundation
import MomoACPHost
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

final class WorkHostAPIClient: @unchecked Sendable, WorkHostAPI {
    private struct RegisterRequest: Encodable {
        let scope: String
        let type: String
        let displayName: String
        let publicKey: String
        let capabilities: [String: Bool]
    }

    private struct RegisteredHost: Decodable {
        let id: UUID
        let workspaceId: UUID
        let type: String
        let publicKey: String
    }

    private struct RegisterResponse: Decodable { let workHost: RegisteredHost }
    private struct HeartbeatRequest: Encodable { let sentAtMs: Int64; let signature: String }
    private struct PendingResponse: Decodable { let workControls: [WorkControl] }
    private struct LiveSessionsResponse: Decodable {
        let workSessions: [WorkHostLiveSession]
    }
    private struct ReconcileRequest: Encodable { let lostSessionIds: [UUID] }
    private struct ReconcileResponse: Decodable { let reportedSessionIds: [UUID] }
    private struct WorkToolProfilesResponse: Decodable {
        let workToolProfiles: [WorkToolProfile]
    }
    private struct SessionResponse: Decodable { let workSession: WorkSession }
    private struct CreateSessionRequest: Encodable {
        let channelId: UUID
        let hostId: UUID
        let tool: String
        let label: String
        let controlId: UUID
    }
    private struct AckRequest: Encodable {
        let ok: Bool
        let sessionId: UUID?
        let errorLabel: String?
    }
    private struct EndSessionRequest: Encodable { let status = "ended"; let exitCode: Int? }
    private struct IdleSessionRequest: Encodable { let status = "idle"; let exitCode: Int }
    private struct RunningSessionRequest: Encodable { let status = "running" }
    private struct ACPEventRequest: Encodable { let event: ACPProjectedEvent }
    private struct BindRemotePTYRequest: Encodable {
        let ptyId: String
        let attachEndpoint: String
    }
    /// `TerminalAttachRoutes` speaks snake_case on this pair alone; the rest of
    /// the work-host surface is camelCase, so the mapping is spelled out here
    /// rather than by switching a global key strategy.
    private struct ValidateTerminalAttachRequest: Encodable {
        let capabilityToken: String

        enum CodingKeys: String, CodingKey {
            case capabilityToken = "capability_token"
        }
    }
    private struct ValidateTerminalAttachResponse: Decodable {
        let workSessionId: String
        let ptyId: String
        let expiresAt: String
        let mode: String

        enum CodingKeys: String, CodingKey {
            case workSessionId = "work_session_id"
            case ptyId = "pty_id"
            case expiresAt = "expires_at"
            case mode
        }
    }

    private let config: WorkdConfig
    private let signer: WorkHostSigner
    private let session: URLSession
    private let encoder: JSONEncoder
    private let decoder = JSONDecoder()

    init(config: WorkdConfig, signer: WorkHostSigner, session: URLSession? = nil) {
        self.config = config
        self.signer = signer
        if let session {
            self.session = session
        } else {
            let sessionConfig = URLSessionConfiguration.ephemeral
            sessionConfig.timeoutIntervalForRequest = 20
            sessionConfig.timeoutIntervalForResource = 30
            self.session = URLSession(configuration: sessionConfig)
        }
        encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
    }

    func register(registrationToken: String) async throws -> UUID {
        let request = RegisterRequest(
            scope: config.scope,
            type: config.hostType,
            displayName: config.displayName,
            publicKey: signer.publicKeyBase64,
            // MOMO-655: `requireRemotePTYCapableHost` gates every attach binding
            // on this flag, so a host that will serve terminals has to declare
            // it at registration. There is no capability-update route: an
            // already-registered host that turns attach on re-registers (see
            // docs/runbooks/workd-terminal-attach.md).
            capabilities: config.terminalAttach == nil ? [:] : ["terminal_attach": true]
        )
        let path = config.hostType == "cloud"
            ? "/v1/workspaces/\(config.workspaceID.uuidString.lowercased())/work-hosts/cloud/register"
            : "/v1/workspaces/\(config.workspaceID.uuidString.lowercased())/work-hosts"
        let authorization = config.hostType == "cloud"
            ? "MomoBootstrap \(registrationToken)"
            : "Bearer \(registrationToken)"
        let response: RegisterResponse = try await send(
            method: "POST",
            path: path,
            body: request,
            authorization: authorization
        )
        guard response.workHost.workspaceId == config.workspaceID,
              response.workHost.type == config.hostType,
              response.workHost.publicKey == signer.publicKeyBase64
        else { throw WorkdFailure.invalidResponse }
        return response.workHost.id
    }

    func heartbeat(hostID: UUID) async throws {
        let sentAtMs = Self.nowMs()
        let signature = try signer.signatureBase64(
            for: signer.heartbeatPayload(
                workspaceID: config.workspaceID,
                hostID: hostID,
                sentAtMs: sentAtMs
            )
        )
        let _: RegisterResponse = try await send(
            method: "POST",
            path: "/v1/workspaces/\(config.workspaceID.uuidString.lowercased())/work-hosts/\(hostID.uuidString.lowercased())/heartbeat",
            body: HeartbeatRequest(sentAtMs: sentAtMs, signature: signature)
        )
    }

    func pendingControls(hostID: UUID) async throws -> [WorkControl] {
        let path = "/v1/workspaces/\(config.workspaceID.uuidString.lowercased())/work-hosts/\(hostID.uuidString.lowercased())/pending-controls"
        let response: PendingResponse = try await sendSigned(
            method: "GET",
            path: path,
            hostID: hostID,
            body: Optional<String>.none
        )
        return response.workControls
    }

    func liveSessions(hostID: UUID) async throws -> [WorkHostLiveSession] {
        let path = "/v1/workspaces/\(config.workspaceID.uuidString.lowercased())/work-hosts/\(hostID.uuidString.lowercased())/live-sessions"
        let response: LiveSessionsResponse = try await sendSigned(
            method: "GET",
            path: path,
            hostID: hostID,
            body: Optional<String>.none
        )
        return response.workSessions
    }

    func reportLostSessions(
        hostID: UUID,
        sessionIDs: [UUID]
    ) async throws -> [UUID] {
        guard !sessionIDs.isEmpty else { return [] }
        let path = "/v1/workspaces/\(config.workspaceID.uuidString.lowercased())/work-hosts/\(hostID.uuidString.lowercased())/reconcile"
        let response: ReconcileResponse = try await sendSigned(
            method: "POST",
            path: path,
            hostID: hostID,
            body: ReconcileRequest(lostSessionIds: sessionIDs)
        )
        return response.reportedSessionIds
    }

    func workToolProfiles(hostID: UUID) async throws -> [WorkToolProfile] {
        let path = "/v1/workspaces/\(config.workspaceID.uuidString.lowercased())/work-tool-profiles"
        let response: WorkToolProfilesResponse = try await sendSigned(
            method: "GET",
            path: path,
            hostID: hostID,
            body: Optional<String>.none
        )
        guard response.workToolProfiles.allSatisfy({
            $0.workspaceId == config.workspaceID && $0.enabled
        }) else {
            throw WorkdFailure.invalidResponse
        }
        return response.workToolProfiles
    }

    func createSession(hostID: UUID, control: WorkControl) async throws -> WorkSession {
        guard control.targetHostId == hostID,
              control.kind == "spawn",
              control.status == "dispatched",
              let object = control.payload.objectValue,
              let tool = object["tool"]?.stringValue,
              let label = object["label"]?.stringValue
        else { throw WorkdFailure.invalidResponse }
        let response: SessionResponse = try await sendSigned(
            method: "POST",
            path: "/v1/workspaces/\(config.workspaceID.uuidString.lowercased())/work-sessions",
            hostID: hostID,
            body: CreateSessionRequest(
                channelId: control.channelId,
                hostId: hostID,
                tool: tool,
                label: label,
                controlId: control.id
            )
        )
        return response.workSession
    }

    func acknowledge(
        hostID: UUID,
        controlID: UUID,
        ok: Bool,
        sessionID: UUID?,
        errorLabel: String?
    ) async throws {
        let _: JSONValue = try await sendSigned(
            method: "POST",
            path: "/v1/workspaces/\(config.workspaceID.uuidString.lowercased())/work-controls/\(controlID.uuidString.lowercased())/ack",
            hostID: hostID,
            body: AckRequest(ok: ok, sessionId: sessionID, errorLabel: errorLabel)
        )
    }

    func endSession(hostID: UUID, sessionID: UUID, exitCode: Int?) async throws {
        let _: SessionResponse = try await sendSigned(
            method: "PATCH",
            path: "/v1/workspaces/\(config.workspaceID.uuidString.lowercased())/work-sessions/\(sessionID.uuidString.lowercased())",
            hostID: hostID,
            body: EndSessionRequest(exitCode: exitCode)
        )
    }

    func reportSessionIdle(hostID: UUID, sessionID: UUID, exitCode: Int) async throws {
        let _: SessionResponse = try await sendSigned(
            method: "PATCH",
            path: "/v1/workspaces/\(config.workspaceID.uuidString.lowercased())/work-sessions/\(sessionID.uuidString.lowercased())",
            hostID: hostID,
            body: IdleSessionRequest(exitCode: exitCode)
        )
    }

    func reportSessionRunning(hostID: UUID, sessionID: UUID) async throws {
        let _: SessionResponse = try await sendSigned(
            method: "PATCH",
            path: "/v1/workspaces/\(config.workspaceID.uuidString.lowercased())/work-sessions/\(sessionID.uuidString.lowercased())",
            hostID: hostID,
            body: RunningSessionRequest()
        )
    }

    func relayACPEvent(
        hostID: UUID,
        sessionID: UUID,
        event: ACPProjectedEvent
    ) async throws {
        let _: SessionResponse = try await sendSigned(
            method: "PATCH",
            path: "/v1/workspaces/\(config.workspaceID.uuidString.lowercased())/work-sessions/\(sessionID.uuidString.lowercased())",
            hostID: hostID,
            body: ACPEventRequest(event: event)
        )
    }

    func bindRemotePTY(
        hostID: UUID,
        sessionID: UUID,
        ptyID: String,
        attachEndpoint: String
    ) async throws {
        let _: SessionResponse = try await sendSigned(
            method: "PATCH",
            path: "/v1/workspaces/\(config.workspaceID.uuidString.lowercased())/work-sessions/\(sessionID.uuidString.lowercased())",
            hostID: hostID,
            body: BindRemotePTYRequest(ptyId: ptyID, attachEndpoint: attachEndpoint)
        )
    }

    func validateTerminalAttach(
        hostID: UUID,
        capabilityToken: String
    ) async throws -> TerminalAttachGrant {
        guard TerminalAttachHandshake.isValidCapabilityToken(capabilityToken) else {
            throw WorkdFailure.authentication
        }
        let response: ValidateTerminalAttachResponse = try await sendSigned(
            method: "POST",
            path: "/v1/workspaces/\(config.workspaceID.uuidString.lowercased())/work-hosts/\(hostID.uuidString.lowercased())/terminal-attach/validate",
            hostID: hostID,
            body: ValidateTerminalAttachRequest(capabilityToken: capabilityToken)
        )
        guard let sessionID = UUID(uuidString: response.workSessionId),
              let mode = ProcessManager.AttachMode(serverValue: response.mode)
        else { throw WorkdFailure.invalidResponse }
        return TerminalAttachGrant(
            workSessionID: sessionID,
            ptyID: response.ptyId,
            mode: mode
        )
    }

    private func sendSigned<Response: Decodable, Body: Encodable>(
        method: String,
        path: String,
        hostID: UUID,
        body: Body?
    ) async throws -> Response {
        let sentAtMs = Self.nowMs()
        let requestID = UUID()
        let encodedBody = try body.map { try encoder.encode($0) }
        let bodyDigest = WorkHostSigner.sha256Hex(encodedBody ?? Data())
        let signature = try signer.signatureBase64(
            for: signer.requestPayload(
                method: method,
                path: path,
                workspaceID: config.workspaceID,
                hostID: hostID,
                sentAtMs: sentAtMs,
                bodyDigest: bodyDigest,
                requestID: requestID
            )
        )
        return try await sendEncoded(
            method: method,
            path: path,
            body: encodedBody,
            authorization: "MomoHost \(hostID.uuidString.lowercased())",
            extraHeaders: [
                "X-Momo-Work-Host-Sent-At": String(sentAtMs),
                "X-Momo-Work-Host-Signature": signature,
                "X-Momo-Work-Host-Request-ID": requestID.uuidString.lowercased(),
            ]
        )
    }

    private func send<Response: Decodable, Body: Encodable>(
        method: String,
        path: String,
        body: Body?,
        authorization: String? = nil,
        extraHeaders: [String: String] = [:]
    ) async throws -> Response {
        try await sendEncoded(
            method: method,
            path: path,
            body: try body.map { try encoder.encode($0) },
            authorization: authorization,
            extraHeaders: extraHeaders
        )
    }

    private func sendEncoded<Response: Decodable>(
        method: String,
        path: String,
        body: Data?,
        authorization: String? = nil,
        extraHeaders: [String: String] = [:]
    ) async throws -> Response {
        guard let url = URL(string: config.serverURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path) else {
            throw WorkdFailure.configuration
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let authorization { request.setValue(authorization, forHTTPHeaderField: "Authorization") }
        for (name, value) in extraHeaders { request.setValue(value, forHTTPHeaderField: name) }
        request.httpBody = body

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw WorkdFailure.transport
        }
        guard let http = response as? HTTPURLResponse else { throw WorkdFailure.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 || http.statusCode == 403 {
                throw WorkdFailure.authentication
            }
            throw WorkdFailure.transport
        }
        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw WorkdFailure.invalidResponse
        }
    }

    private static func nowMs() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1_000)
    }
}
