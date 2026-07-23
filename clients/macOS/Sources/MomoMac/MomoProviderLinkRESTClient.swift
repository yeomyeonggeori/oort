import Foundation
import MomoCore

/// Consumes the operator provider-link surface (docs/api/openapi.operator.yaml):
/// GET/PUT/DELETE `/v1/provider/link` and POST `/v1/provider/link/test`. All calls
/// carry the operator App JWT (`platform:read`) as a bearer. Requests use an
/// ephemeral, no-store session so the operator token and the write-only provider
/// bearer never land in a URL cache or credential store.
actor MomoProviderLinkRESTClient: MomoProviderLinkClient {
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

    func get(context: MomoInviteAdminContext) async throws -> MomoProviderLinkStatus {
        var request = request(url: linkURL(context: context), method: "GET", context: context)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return try await execute(request, response: MomoProviderLinkStatus.self)
    }

    func put(
        context: MomoInviteAdminContext,
        request body: MomoProviderLinkPutRequest
    ) async throws -> MomoProviderLinkStatus {
        try await send(
            body,
            url: linkURL(context: context),
            method: "PUT",
            context: context,
            response: MomoProviderLinkStatus.self
        )
    }

    func delete(context: MomoInviteAdminContext) async throws -> MomoProviderLinkStatus {
        var request = request(url: linkURL(context: context), method: "DELETE", context: context)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return try await execute(request, response: MomoProviderLinkStatus.self)
    }

    func test(context: MomoInviteAdminContext) async throws -> MomoProviderLinkTestResult {
        var request = request(
            url: linkURL(context: context, action: "test"),
            method: "POST",
            context: context
        )
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return try await execute(request, response: MomoProviderLinkTestResult.self)
    }

    private func send<Body: Encodable, Response: Decodable>(
        _ body: Body,
        url: URL,
        method: String,
        context: MomoInviteAdminContext,
        response: Response.Type
    ) async throws -> Response {
        var request = request(url: url, method: method, context: context)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(body)
        return try await execute(request, response: response)
    }

    private func request(
        url: URL,
        method: String,
        context: MomoInviteAdminContext
    ) -> URLRequest {
        var request = URLRequest(
            url: url,
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: 30
        )
        request.httpMethod = method
        request.setValue("Bearer \(context.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.setValue("no-cache", forHTTPHeaderField: "Pragma")
        return request
    }

    private func linkURL(context: MomoInviteAdminContext, action: String? = nil) -> URL {
        var url = context.baseURL
        for component in ["v1", "provider", "link"] {
            url.appendPathComponent(component)
        }
        if let action {
            url.appendPathComponent(action)
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
                throw MomoProviderLinkClientError.invalidResponse
            }
            guard (200..<300).contains(http.statusCode) else {
                throw problemError(status: http.statusCode, data: data)
            }
            do {
                return try decoder.decode(Response.self, from: data)
            } catch {
                throw MomoProviderLinkClientError.invalidResponse
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch let error as URLError {
            if Self.offlineCodes.contains(error.code) {
                throw MomoProviderLinkClientError.offline
            }
            throw MomoProviderLinkClientError.transport
        } catch let error as MomoProviderLinkClientError {
            throw error
        } catch {
            throw MomoProviderLinkClientError.transport
        }
    }

    private func problemError(status: Int, data: Data) -> MomoProviderLinkClientError {
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
