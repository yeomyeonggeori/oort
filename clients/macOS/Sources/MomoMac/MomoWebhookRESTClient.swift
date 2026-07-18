import Foundation
import MomoCore

actor MomoWebhookRESTClient: MomoWebhookClient {
    private struct InstallationListResponse: Decodable {
        let installations: [MomoWebhookInstallation]
    }

    private struct RevokeResponse: Decodable {
        let installation: MomoWebhookInstallation
        let revoked: Bool
    }

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

    func list(context: MomoInviteAdminContext) async throws -> [MomoWebhookInstallation] {
        var request = request(
            url: managementURL(context: context),
            method: "GET",
            context: context
        )
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return try await execute(request, response: InstallationListResponse.self).installations
    }

    func create(
        context: MomoInviteAdminContext,
        channel: ChannelID,
        mode: MomoWebhookMode,
        label: String
    ) async throws -> MomoWebhookOneTimeCredential {
        try await send(
            MomoWebhookCreateRequest(
                channelId: channel.description,
                mode: mode,
                label: label
            ),
            url: managementURL(context: context),
            method: "POST",
            context: context,
            response: MomoWebhookOneTimeCredential.self
        )
    }

    func rotate(
        context: MomoInviteAdminContext,
        installation: UUID,
        overlapSeconds: Int
    ) async throws -> MomoWebhookOneTimeCredential {
        try await send(
            MomoWebhookRotateRequest(overlapSeconds: overlapSeconds),
            url: managementURL(
                context: context,
                installation: installation,
                action: "rotate"
            ),
            method: "POST",
            context: context,
            response: MomoWebhookOneTimeCredential.self
        )
    }

    func revoke(
        context: MomoInviteAdminContext,
        installation: UUID
    ) async throws -> MomoWebhookInstallation {
        let request = request(
            url: managementURL(context: context, installation: installation),
            method: "DELETE",
            context: context
        )
        let response = try await execute(request, response: RevokeResponse.self)
        guard response.revoked else { throw MomoWebhookClientError.invalidResponse }
        return response.installation
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

    private func managementURL(
        context: MomoInviteAdminContext,
        installation: UUID? = nil,
        action: String? = nil
    ) -> URL {
        var url = context.baseURL
        for component in [
            "v1",
            "workspaces",
            context.workspace.description,
            "webhooks",
        ] {
            url.appendPathComponent(component)
        }
        if let installation {
            url.appendPathComponent(installation.uuidString.lowercased())
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
                throw MomoWebhookClientError.invalidResponse
            }
            guard (200..<300).contains(http.statusCode) else {
                throw problemError(status: http.statusCode, data: data)
            }
            do {
                return try decoder.decode(Response.self, from: data)
            } catch {
                throw MomoWebhookClientError.invalidResponse
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch let error as URLError {
            if Self.offlineCodes.contains(error.code) {
                throw MomoWebhookClientError.offline
            }
            throw MomoWebhookClientError.transport
        } catch let error as MomoWebhookClientError {
            throw error
        } catch {
            throw MomoWebhookClientError.transport
        }
    }

    private func problemError(status: Int, data: Data) -> MomoWebhookClientError {
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
