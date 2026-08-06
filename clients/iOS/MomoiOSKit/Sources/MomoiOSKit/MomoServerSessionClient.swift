import Foundation
import MomoCore

public protocol SessionBackend: Sendable {
    func authenticate(form: SessionForm) async throws -> IOSSession
    func bootstrap(session: IOSSession) async throws -> WorkspaceBootstrap
}

/// MomoMac에서 복제, ADR-0123 D1 복제 후 수렴.
/// The copy is intentionally local to MomoiOSKit; MomoCore and MomoMac stay untouched.
public actor MomoServerSessionClient: SessionBackend {
    private let session: URLSession
    private let store: SessionStore
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(session: URLSession = .shared, store: SessionStore = .shared) {
        self.session = session
        self.store = store
    }

    public func authenticate(form: SessionForm) async throws -> IOSSession {
        let validated = try form.validated()
        if validated.inviteCode.isEmpty {
            return try await login(validated)
        }
        return try await join(validated)
    }

    public func bootstrap(session authenticated: IOSSession) async throws -> WorkspaceBootstrap {
        let workspacePath = "/v1/workspaces/\(authenticated.workspaceID.description)"
        let channelsPath = workspacePath + "/channels"
        let executor = IOSAuthenticatedRequestExecutor(
            authenticated: authenticated,
            store: store,
            urlSession: session
        )
        async let workspaceData = get(
            authenticated.baseURL.appendingPathComponent(workspacePath), executor: executor
        )
        async let channelsData = get(
            authenticated.baseURL.appendingPathComponent(channelsPath), executor: executor
        )
        return try Self.mapBootstrap(
            workspaceData: try await workspaceData,
            channelsData: try await channelsData,
            decoder: decoder
        )
    }

    static func mapBootstrap(
        workspaceData: Data,
        channelsData: Data,
        decoder: JSONDecoder = JSONDecoder()
    ) throws -> WorkspaceBootstrap {
        do {
            let workspace = try decoder.decode(WorkspaceResponse.self, from: workspaceData).workspace.value
            let channels = try decoder.decode(ChannelsResponse.self, from: channelsData).channels.map { try $0.value() }
            return WorkspaceBootstrap(workspace: workspace, channels: channels)
        } catch let error as SessionError {
            throw error
        } catch {
            throw SessionError.decoding("The server returned bootstrap data this app could not read.")
        }
    }

    private func login(_ form: ValidatedSessionForm) async throws -> IOSSession {
        let response: LoginResponse = try await post(
            LoginRequest(email: form.email, password: form.password, workspace: nil),
            to: form.baseURL.appendingPathComponent("/v1/auth/login")
        )
        return try response.session(baseURL: form.baseURL, email: form.email)
    }

    private func join(_ form: ValidatedSessionForm) async throws -> IOSSession {
        let response: JoinResponse = try await post(
            JoinRequest(
                code: form.inviteCode,
                email: form.email,
                displayName: Self.displayName(from: form.email),
                handle: Self.handle(from: form.email),
                password: form.password,
                timeZone: TimeZone.current.identifier
            ),
            to: form.baseURL.appendingPathComponent("/v1/join")
        )
        return try response.session(baseURL: form.baseURL, email: form.email)
    }

    private func post<Body: Encodable, Response: Decodable>(
        _ body: Body,
        to url: URL
    ) async throws -> Response {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(body)
        return try await execute(request)
    }

    private func get(_ url: URL, executor: IOSAuthenticatedRequestExecutor) async throws -> Data {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        return try await executor.data(for: request)
    }

    private func execute<Response: Decodable>(_ request: URLRequest) async throws -> Response {
        let data = try await executeData(request)
        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw SessionError.decoding("The server returned login data this app could not read.")
        }
    }

    private func executeData(_ request: URLRequest) async throws -> Data {
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw SessionError.transport("The server did not return an HTTP response.")
            }
            guard (200..<300).contains(http.statusCode) else {
                let problem = try? decoder.decode(ProblemResponse.self, from: data)
                let message = problem?.detail ?? problem?.message ?? problem?.title
                    ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
                throw SessionError.server(status: http.statusCode, message: message)
            }
            return data
        } catch let error as SessionError {
            throw error
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw SessionError.transport("Could not reach the oort server. Check the URL and try again.")
        }
    }

    private static func displayName(from email: String) -> String {
        let local = email.split(separator: "@").first.map(String.init) ?? email
        return local.split(separator: ".").map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }

    private static func handle(from email: String) -> String {
        let local = email.split(separator: "@").first.map(String.init) ?? email
        let mapped = local.lowercased().map { character in
            character.isLetter || character.isNumber || character == "-" ? character : "-"
        }
        let handle = String(mapped).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        return handle.isEmpty ? "momo-user" : handle
    }
}

private struct LoginRequest: Encodable {
    let email: String
    let password: String
    let workspace: String?
}

private struct JoinRequest: Encodable {
    let code: String
    let email: String
    let displayName: String
    let handle: String
    let password: String
    let timeZone: String
}

private struct LoginResponse: Decodable {
    let accessToken: String
    let refreshToken: String
    let member: MemberDTO
    let realtimeWebSocketUrl: String?

    func session(baseURL: URL, email: String) throws -> IOSSession {
        let mappedMember = try member.value()
        return IOSSession(
            baseURL: baseURL,
            workspaceID: mappedMember.workspaceId,
            member: mappedMember,
            accessToken: accessToken,
            refreshToken: refreshToken,
            realtimeWebSocketURL: realtimeWebSocketUrl.flatMap(URL.init(string:)),
            email: email
        )
    }
}

private struct JoinResponse: Decodable {
    let accessToken: String
    let refreshToken: String
    let workspaceId: String
    let member: MemberDTO
    let realtimeWebSocketUrl: String?

    func session(baseURL: URL, email: String) throws -> IOSSession {
        guard let workspaceID = WorkspaceID(uuidString: workspaceId) else {
            throw SessionError.decoding("The server returned an invalid workspace identity.")
        }
        return IOSSession(
            baseURL: baseURL,
            workspaceID: workspaceID,
            member: try member.value(),
            accessToken: accessToken,
            refreshToken: refreshToken,
            realtimeWebSocketURL: realtimeWebSocketUrl.flatMap(URL.init(string:)),
            email: email
        )
    }
}

private struct MemberDTO: Decodable {
    let id: String
    let workspaceId: String
    let kind: String
    let displayName: String
    let handle: String

    func value() throws -> Member {
        guard let memberID = MemberID(uuidString: id),
              let workspaceID = WorkspaceID(uuidString: workspaceId)
        else {
            throw SessionError.decoding("The server returned an invalid member identity.")
        }
        return Member(
            id: memberID,
            workspaceId: workspaceID,
            kind: MemberKind(rawValue: kind) ?? .human,
            displayName: displayName,
            handle: handle,
            presence: .online
        )
    }
}

private struct WorkspaceResponse: Decodable {
    let workspace: WorkspaceDTO
}

private struct WorkspaceDTO: Decodable {
    let id: WorkspaceID
    let slug: String
    let name: String
    let updatedAtMs: Int64

    var value: Workspace { Workspace(id: id, slug: slug, name: name, updatedAtMs: updatedAtMs) }
}

private struct ChannelsResponse: Decodable {
    let channels: [ChannelDTO]
}

private struct ChannelDTO: Decodable {
    let id: String
    let workspaceId: String
    let kind: String
    let name: String?
    let topic: String?
    let dmKey: String?
    let memberIds: [String]?
    let createdBy: String?
    let archivedAtMs: Int64?

    func value() throws -> Channel {
        guard let channelID = ChannelID(uuidString: id),
              let workspaceID = WorkspaceID(uuidString: workspaceId),
              let channelKind = ChannelKind(rawValue: kind)
        else {
            throw SessionError.decoding("The server returned an invalid channel.")
        }
        return Channel(
            id: channelID,
            workspaceId: workspaceID,
            kind: channelKind,
            name: name,
            topic: topic,
            dmKey: dmKey,
            dmMemberIds: (memberIds ?? []).compactMap { MemberID(uuidString: $0) },
            createdBy: createdBy.flatMap { MemberID(uuidString: $0) },
            archivedAtMs: archivedAtMs
        )
    }
}

private struct ProblemResponse: Decodable {
    let title: String?
    let detail: String?
    let message: String?
}
