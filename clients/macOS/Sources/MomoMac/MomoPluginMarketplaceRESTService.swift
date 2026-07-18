import Foundation

protocol MomoPluginMarketplaceService: Sendable {
    func fetchCatalog(context: MomoInviteAdminContext) async throws -> MomoPluginCatalogSnapshot
    func fetchDetail(pluginID: String, context: MomoInviteAdminContext) async throws -> MomoPluginDetail
    func install(pluginID: String, context: MomoInviteAdminContext) async throws -> MomoPluginMutationReceipt
    func revokeInstall(pluginID: String, context: MomoInviteAdminContext) async throws -> MomoPluginMutationReceipt
    func grant(pluginID: String, scope: String, context: MomoInviteAdminContext) async throws -> MomoPluginMutationReceipt
    func revokeGrant(pluginID: String, scope: String, context: MomoInviteAdminContext) async throws -> MomoPluginMutationReceipt
}

actor MomoPluginMarketplaceRESTService: MomoPluginMarketplaceService {
    private struct ProblemResponse: Decodable {
        struct ErrorBody: Decodable {
            let message: String
        }

        let title: String?
        let detail: String?
        let message: String?
        let error: ErrorBody?
    }

    private let session: URLSession
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(session: URLSession? = nil) {
        self.session = session ?? Self.makeEphemeralSession()
    }

    func fetchCatalog(context: MomoInviteAdminContext) async throws -> MomoPluginCatalogSnapshot {
        try await send(
            method: "GET",
            pluginID: nil,
            suffix: [],
            context: context,
            response: MomoPluginCatalogSnapshot.self
        )
    }

    func fetchDetail(
        pluginID: String,
        context: MomoInviteAdminContext
    ) async throws -> MomoPluginDetail {
        try await send(
            method: "GET",
            pluginID: pluginID,
            suffix: [],
            context: context,
            response: MomoPluginDetailEnvelope.self
        ).plugin
    }

    func install(
        pluginID: String,
        context: MomoInviteAdminContext
    ) async throws -> MomoPluginMutationReceipt {
        // The server manifest defaults are disabled for the current official set.
        // A-1 always opts into enabled installation so a following grant can succeed.
        try await send(
            method: "POST",
            pluginID: pluginID,
            suffix: ["install"],
            context: context,
            body: MomoInstallPluginRequest(enabled: true),
            response: MomoPluginMutationReceipt.self
        )
    }

    func revokeInstall(
        pluginID: String,
        context: MomoInviteAdminContext
    ) async throws -> MomoPluginMutationReceipt {
        try await send(
            method: "DELETE",
            pluginID: pluginID,
            suffix: ["install"],
            context: context,
            response: MomoPluginMutationReceipt.self
        )
    }

    func grant(
        pluginID: String,
        scope: String,
        context: MomoInviteAdminContext
    ) async throws -> MomoPluginMutationReceipt {
        try await send(
            method: "POST",
            pluginID: pluginID,
            suffix: ["grants"],
            context: context,
            body: MomoGrantPluginRequest(scope: scope),
            response: MomoPluginMutationReceipt.self
        )
    }

    func revokeGrant(
        pluginID: String,
        scope: String,
        context: MomoInviteAdminContext
    ) async throws -> MomoPluginMutationReceipt {
        try await send(
            method: "DELETE",
            pluginID: pluginID,
            suffix: ["grants", scope],
            context: context,
            response: MomoPluginMutationReceipt.self
        )
    }

    private func send<Response: Decodable>(
        method: String,
        pluginID: String?,
        suffix: [String],
        context: MomoInviteAdminContext,
        response: Response.Type
    ) async throws -> Response {
        try await send(
            method: method,
            pluginID: pluginID,
            suffix: suffix,
            context: context,
            bodyData: nil,
            response: response
        )
    }

    private func send<Body: Encodable, Response: Decodable>(
        method: String,
        pluginID: String?,
        suffix: [String],
        context: MomoInviteAdminContext,
        body: Body,
        response: Response.Type
    ) async throws -> Response {
        let bodyData: Data
        do {
            bodyData = try encoder.encode(body)
        } catch {
            throw MomoPluginMarketplaceError.decoding(String(describing: error))
        }
        return try await send(
            method: method,
            pluginID: pluginID,
            suffix: suffix,
            context: context,
            bodyData: bodyData,
            response: response
        )
    }

    private func send<Response: Decodable>(
        method: String,
        pluginID: String?,
        suffix: [String],
        context: MomoInviteAdminContext,
        bodyData: Data?,
        response: Response.Type
    ) async throws -> Response {
        let url = endpoint(pluginID: pluginID, suffix: suffix, context: context)
        var request = URLRequest(
            url: url,
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: 30
        )
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(context.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.setValue("no-cache", forHTTPHeaderField: "Pragma")
        if let bodyData {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = bodyData
        }

        do {
            let (data, urlResponse) = try await session.data(for: request)
            guard let http = urlResponse as? HTTPURLResponse else {
                throw MomoPluginMarketplaceError.transport(
                    code: URLError.badServerResponse.rawValue,
                    message: "The server did not return an HTTP response."
                )
            }
            guard (200..<300).contains(http.statusCode) else {
                throw httpError(status: http.statusCode, data: data)
            }
            do {
                return try decoder.decode(Response.self, from: data)
            } catch {
                throw MomoPluginMarketplaceError.decoding(String(describing: error))
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as MomoPluginMarketplaceError {
            throw error
        } catch let error as URLError {
            if error.code == .cancelled { throw CancellationError() }
            throw MomoPluginMarketplaceError.transport(
                code: error.code.rawValue,
                message: error.localizedDescription
            )
        } catch {
            throw MomoPluginMarketplaceError.transport(
                code: URLError.unknown.rawValue,
                message: error.localizedDescription
            )
        }
    }

    private func endpoint(
        pluginID: String?,
        suffix: [String],
        context: MomoInviteAdminContext
    ) -> URL {
        var url = context.baseURL
        for component in ["v1", "workspaces", context.workspace.description, "plugins"] {
            url.appendPathComponent(component)
        }
        if let pluginID {
            url.appendPathComponent(pluginID)
        }
        for component in suffix {
            url.appendPathComponent(component)
        }
        return url
    }

    private func httpError(status: Int, data: Data) -> MomoPluginMarketplaceError {
        let problem = try? decoder.decode(ProblemResponse.self, from: data)
        let message = problem?.detail ?? problem?.message ?? problem?.error?.message ?? problem?.title
            ?? HTTPURLResponse.localizedString(forStatusCode: status)
        return .http(status: status, message: message)
    }

    static func makeEphemeralConfiguration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        return configuration
    }

    private static func makeEphemeralSession() -> URLSession {
        URLSession(configuration: makeEphemeralConfiguration())
    }
}
