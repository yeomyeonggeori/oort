import Foundation
import MomoCore

/// Consumes the operator work-host-engine surface (MOMO-582):
/// GET/PUT `/v1/provider/work-host-engine`. Calls carry the operator App JWT as a
/// bearer. Requests use an ephemeral, no-store session so the operator token never
/// lands in a URL cache or credential store. Transport failures are reported with
/// the shared `MomoProviderLinkClientError` vocabulary so both admin panes classify
/// errors identically.
actor MomoWorkHostEngineRESTClient: MomoWorkHostEngineClient {
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

    func get(context: MomoInviteAdminContext) async throws -> MomoWorkHostEngineStatus {
        var request = request(url: engineURL(context: context), method: "GET", context: context)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return try await execute(request, response: MomoWorkHostEngineStatus.self)
    }

    func put(
        context: MomoInviteAdminContext,
        request body: MomoWorkHostEnginePutRequest
    ) async throws -> MomoWorkHostEngineStatus {
        var request = request(url: engineURL(context: context), method: "PUT", context: context)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(body)
        return try await execute(request, response: MomoWorkHostEngineStatus.self)
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

    private func engineURL(context: MomoInviteAdminContext) -> URL {
        var url = context.baseURL
        for component in ["v1", "provider", "work-host-engine"] {
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
