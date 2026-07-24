import Foundation
import MomoCore

/// Consumes `POST /v1/workspaces` (MOMO-589 self-serve create). The call carries
/// the registered-operator App JWT as a bearer and uses an ephemeral, no-store
/// session so the operator token never lands in a URL cache or credential store,
/// matching the provider-link client (574).
actor MomoWorkspaceCreateRESTClient: MomoWorkspaceCreateClient {
    private struct ProblemResponse: Decodable {
        let title: String?
        let detail: String?
        let message: String?
    }

    private let session: URLSession
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(session: URLSession? = nil) {
        self.session = session ?? Self.makeEphemeralSession()
    }

    func create(
        context: MomoInviteAdminContext,
        request body: MomoWorkspaceCreateRequest
    ) async throws -> MomoCreatedWorkspace {
        var request = URLRequest(
            url: workspacesURL(context: context),
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: 30
        )
        request.httpMethod = "POST"
        request.setValue("Bearer \(context.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.setValue("no-cache", forHTTPHeaderField: "Pragma")
        request.httpBody = try encoder.encode(body)

        let decoded = try await execute(request, response: MomoWorkspaceCreateResponse.self)
        guard let workspaceID = WorkspaceID(uuidString: decoded.workspaceId) else {
            throw MomoWorkspaceCreateClientError.invalidResponse
        }
        return MomoCreatedWorkspace(
            workspaceId: workspaceID,
            slug: body.slug,
            name: body.name
        )
    }

    private func workspacesURL(context: MomoInviteAdminContext) -> URL {
        var url = context.baseURL
        for component in ["v1", "workspaces"] {
            url.appendPathComponent(component)
        }
        return url
    }

    private func execute<Response: Decodable>(
        _ request: URLRequest,
        response: Response.Type
    ) async throws -> Response {
        do {
            let (data, urlResponse) = try await session.data(for: request)
            guard let http = urlResponse as? HTTPURLResponse else {
                throw MomoWorkspaceCreateClientError.invalidResponse
            }
            guard (200..<300).contains(http.statusCode) else {
                throw problemError(status: http.statusCode, data: data)
            }
            do {
                return try decoder.decode(Response.self, from: data)
            } catch {
                throw MomoWorkspaceCreateClientError.invalidResponse
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch let error as URLError {
            if Self.offlineCodes.contains(error.code) {
                throw MomoWorkspaceCreateClientError.offline
            }
            throw MomoWorkspaceCreateClientError.transport
        } catch let error as MomoWorkspaceCreateClientError {
            throw error
        } catch {
            throw MomoWorkspaceCreateClientError.transport
        }
    }

    private func problemError(status: Int, data: Data) -> MomoWorkspaceCreateClientError {
        let problem = try? decoder.decode(ProblemResponse.self, from: data)
        let message = [problem?.title, problem?.detail ?? problem?.message]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: ": ")
        return .http(
            status: status,
            message: message.isEmpty
                ? HTTPURLResponse.localizedString(forStatusCode: status)
                : message
        )
    }

    private static func makeEphemeralSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        return URLSession(configuration: configuration)
    }

    private static let offlineCodes: Set<URLError.Code> = [
        .cannotConnectToHost,
        .cannotFindHost,
        .dnsLookupFailed,
        .networkConnectionLost,
        .notConnectedToInternet,
        .timedOut,
    ]
}
