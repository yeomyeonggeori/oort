import Foundation

actor MomoEventSubscriptionRESTClient: MomoEventSubscriptionClient {
    private struct ListResponse: Decodable {
        let eventSubscriptions: [MomoEventSubscription]
    }

    private struct ItemResponse: Decodable {
        let eventSubscription: MomoEventSubscription
    }

    private let session: URLSession
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(session: URLSession? = nil) {
        self.session = session ?? Self.ephemeralSession()
    }

    func list(context: MomoInviteAdminContext) async throws -> [MomoEventSubscription] {
        let request = request(url: managementURL(context: context), method: "GET", context: context)
        return try await execute(request, as: ListResponse.self).eventSubscriptions
    }

    func create(
        context: MomoInviteAdminContext,
        url: String,
        eventKinds: [MomoEventSubscriptionKind]
    ) async throws -> MomoEventSubscriptionSecret {
        try await send(
            MomoEventSubscriptionCreateRequest(url: url, eventKinds: eventKinds, enabled: true),
            url: managementURL(context: context),
            method: "POST",
            context: context,
            as: MomoEventSubscriptionSecret.self
        )
    }

    func setEnabled(
        context: MomoInviteAdminContext,
        subscription: UUID,
        enabled: Bool
    ) async throws -> MomoEventSubscription {
        try await send(
            MomoEventSubscriptionUpdateRequest(enabled: enabled),
            url: managementURL(context: context, subscription: subscription),
            method: "PUT",
            context: context,
            as: ItemResponse.self
        ).eventSubscription
    }

    func delete(
        context: MomoInviteAdminContext,
        subscription: UUID
    ) async throws -> MomoEventSubscription {
        let request = request(
            url: managementURL(context: context, subscription: subscription),
            method: "DELETE",
            context: context
        )
        return try await execute(request, as: ItemResponse.self).eventSubscription
    }

    private func send<Body: Encodable, Response: Decodable>(
        _ body: Body,
        url: URL,
        method: String,
        context: MomoInviteAdminContext,
        as response: Response.Type
    ) async throws -> Response {
        var request = request(url: url, method: method, context: context)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(body)
        return try await execute(request, as: response)
    }

    private func request(url: URL, method: String, context: MomoInviteAdminContext) -> URLRequest {
        var request = URLRequest(
            url: url,
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: 30
        )
        request.httpMethod = method
        request.setValue("Bearer \(context.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.setValue("no-cache", forHTTPHeaderField: "Pragma")
        return request
    }

    private func managementURL(
        context: MomoInviteAdminContext,
        subscription: UUID? = nil
    ) -> URL {
        var url = context.baseURL
        for component in [
            "v1", "workspaces", context.workspace.description, "event-subscriptions",
        ] { url.appendPathComponent(component) }
        if let subscription { url.appendPathComponent(subscription.uuidString.lowercased()) }
        return url
    }

    private func execute<Response: Decodable>(
        _ request: URLRequest,
        as response: Response.Type
    ) async throws -> Response {
        do {
            let (data, rawResponse) = try await session.data(for: request)
            guard let http = rawResponse as? HTTPURLResponse else {
                throw MomoEventSubscriptionClientError.invalidResponse
            }
            guard (200..<300).contains(http.statusCode) else {
                throw MomoEventSubscriptionClientError.http(http.statusCode)
            }
            do { return try decoder.decode(Response.self, from: data) }
            catch { throw MomoEventSubscriptionClientError.invalidResponse }
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch let error as URLError {
            if Self.offlineCodes.contains(error.code) {
                throw MomoEventSubscriptionClientError.offline
            }
            throw MomoEventSubscriptionClientError.transport
        } catch let error as MomoEventSubscriptionClientError {
            throw error
        } catch {
            throw MomoEventSubscriptionClientError.transport
        }
    }

    private static func ephemeralSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        return URLSession(configuration: configuration)
    }

    private static let offlineCodes: Set<URLError.Code> = [
        .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed,
        .networkConnectionLost, .notConnectedToInternet, .timedOut,
    ]
}
