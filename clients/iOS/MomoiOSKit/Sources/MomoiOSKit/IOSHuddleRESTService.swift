import Foundation
import MomoCore

public actor IOSHuddleRESTService: IOSHuddleService {
    private struct HuddleResponse: Decodable { var huddle: IOSHuddle }
    private struct ActiveResponse: Decodable { var huddle: IOSHuddle? }
    private struct JoinResponse: Decodable {
        var huddle: IOSHuddle
        var livekitUrl: String
        var token: String
        var expiresAtMs: Int64
    }
    private struct ProblemResponse: Decodable {
        var title: String?
        var detail: String?
        var message: String?
    }
    private struct EmptyBody: Encodable {}

    private let authenticated: IOSSession
    private let session: URLSession

    public init(authenticated: IOSSession, session: URLSession = .shared) {
        self.authenticated = authenticated
        self.session = session
    }

    public func active(workspace: WorkspaceID, channel: ChannelID) async throws -> IOSHuddle? {
        try requireWorkspace(workspace)
        return try await get(
            "/v1/workspaces/\(workspace.description)/channels/\(channel.description)/huddles/active",
            response: ActiveResponse.self
        ).huddle
    }

    public func join(workspace: WorkspaceID, huddle: UUID) async throws -> IOSHuddleJoin {
        try requireWorkspace(workspace)
        let response = try await post(
            "/v1/workspaces/\(workspace.description)/huddles/\(huddle.uuidString)/join",
            response: JoinResponse.self
        )
        guard let url = URL(string: response.livekitUrl), url.scheme != nil else {
            throw IOSHuddleClientError.invalidResponse
        }
        return IOSHuddleJoin(
            huddle: response.huddle,
            liveKitURL: url,
            token: response.token,
            expiresAt: Date(timeIntervalSince1970: TimeInterval(response.expiresAtMs) / 1_000)
        )
    }

    public func leave(workspace: WorkspaceID, huddle: UUID) async throws {
        try requireWorkspace(workspace)
        _ = try await post(
            "/v1/workspaces/\(workspace.description)/huddles/\(huddle.uuidString)/leave",
            response: HuddleResponse.self
        )
    }

    private func requireWorkspace(_ workspace: WorkspaceID) throws {
        guard workspace == authenticated.workspaceID else {
            throw IOSHuddleClientError.invalidResponse
        }
    }

    private func get<T: Decodable>(_ path: String, response: T.Type) async throws -> T {
        var request = URLRequest(url: authenticated.baseURL.appendingPathComponent(path))
        request.httpMethod = "GET"
        request.setValue("Bearer \(authenticated.accessToken)", forHTTPHeaderField: "Authorization")
        return try await execute(request, response: response)
    }

    private func post<T: Decodable>(_ path: String, response: T.Type) async throws -> T {
        var request = URLRequest(url: authenticated.baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(EmptyBody())
        request.setValue("Bearer \(authenticated.accessToken)", forHTTPHeaderField: "Authorization")
        return try await execute(request, response: response)
    }

    private func execute<T: Decodable>(_ request: URLRequest, response: T.Type) async throws -> T {
        do {
            let (data, urlResponse) = try await session.data(for: request)
            guard let http = urlResponse as? HTTPURLResponse else {
                throw IOSHuddleClientError.invalidResponse
            }
            guard (200..<300).contains(http.statusCode) else {
                let problem = try? JSONDecoder().decode(ProblemResponse.self, from: data)
                throw IOSHuddleClientError.http(
                    http.statusCode,
                    problem?.detail ?? problem?.message ?? problem?.title
                        ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
                )
            }
            return try JSONDecoder().decode(T.self, from: data)
        } catch let error as IOSHuddleClientError {
            throw error
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw SessionError.transport("Could not reach the huddle server. Check your connection and try again.")
        }
    }
}
