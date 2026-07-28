import Foundation
import MomoACPHost

enum WorkdFailure: Error, Sendable {
    case configuration
    case keyStore
    case registrationRequired
    case authentication
    case transport
    case invalidResponse
    case processStart
    case stdinUnavailable
    case processTerminate

    var errorLabel: String {
        switch self {
        case .configuration: "configuration_invalid"
        case .keyStore: "key_store_failed"
        case .registrationRequired: "registration_required"
        case .authentication: "host_auth_failed"
        case .transport: "transport_failed"
        case .invalidResponse: "invalid_response"
        case .processStart: "process_start_failed"
        case .stdinUnavailable: "stdin_unavailable"
        case .processTerminate: "process_terminate_failed"
        }
    }
}

enum JSONValue: Codable, Sendable, Equatable {
    case object([String: JSONValue])
    case array([JSONValue])
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode([String: JSONValue].self) { self = .object(value) }
        else if let value = try? container.decode([JSONValue].self) { self = .array(value) }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Int.self) { self = .int(value) }
        else if let value = try? container.decode(Double.self) { self = .double(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if container.decodeNil() { self = .null }
        else { throw WorkdFailure.invalidResponse }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .int(let value): try container.encode(value)
        case .double(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    var objectValue: [String: JSONValue]? {
        guard case .object(let value) = self else { return nil }
        return value
    }

    var stringValue: String? {
        guard case .string(let value) = self else { return nil }
        return value
    }

    var arrayValue: [JSONValue]? {
        guard case .array(let value) = self else { return nil }
        return value
    }
}

struct WorkControl: Codable, Sendable, Equatable {
    let id: UUID
    let workspaceId: UUID
    let channelId: UUID
    let requesterMemberId: UUID
    let targetHostId: UUID
    let sessionId: UUID?
    let kind: String
    let payload: JSONValue
    let status: String
    let approvalMessageId: UUID?
    let createdAtMs: Int64
    let updatedAtMs: Int64
}

struct WorkSession: Codable, Sendable, Equatable {
    let id: UUID
    let workspaceId: UUID
    let channelId: UUID
    let memberId: UUID
    let hostId: UUID
    let rootMessageId: UUID
    let tool: String
    let label: String
    let status: String
    let startedAtMs: Int64
    let endedAtMs: Int64?
    let exitCode: Int?
    let endReason: String?
    let resumedFromSessionId: UUID?
}

struct WorkToolLaunchTemplate: Codable, Sendable, Equatable {
    let command: String
    let arguments: [String]
}

struct WorkToolProfile: Codable, Sendable, Equatable {
    let id: UUID
    let workspaceId: UUID
    let toolKey: String
    let displayName: String
    let launchTemplate: WorkToolLaunchTemplate
    let tierDefaults: JSONValue
    let envPolicy: JSONValue
    let enabled: Bool
    let createdBy: UUID
    let updatedBy: UUID
    let createdAtMs: Int64
    let updatedAtMs: Int64
}

protocol WorkHostAPI: Sendable {
    func heartbeat(hostID: UUID) async throws
    func workToolProfiles(hostID: UUID) async throws -> [WorkToolProfile]
    func pendingControls(hostID: UUID) async throws -> [WorkControl]
    func createSession(hostID: UUID, control: WorkControl) async throws -> WorkSession
    func acknowledge(
        hostID: UUID,
        controlID: UUID,
        ok: Bool,
        sessionID: UUID?,
        errorLabel: String?
    ) async throws
    func endSession(hostID: UUID, sessionID: UUID, exitCode: Int?) async throws
    func reportSessionIdle(hostID: UUID, sessionID: UUID, exitCode: Int) async throws
    func reportSessionRunning(hostID: UUID, sessionID: UUID) async throws
    func relayACPEvent(
        hostID: UUID,
        sessionID: UUID,
        event: ACPProjectedEvent
    ) async throws
}
