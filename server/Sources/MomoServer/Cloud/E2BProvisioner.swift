import AsyncHTTPClient
import Foundation
import NIOCore
import NIOFoundationCompat

struct CloudProvisionerConfig: Sendable, Equatable {
    static let defaultAPIBaseURL = "https://api.e2b.app"

    let apiBaseURL: String
    let apiKey: String?
    let templateID: String?
    let publicServerURL: String?
    let sandboxTimeoutSeconds: Int
    let unitRateMicroUSDSecond: Int64

    static func load(environment: [String: String]) -> CloudProvisionerConfig {
        func nonempty(_ key: String) -> String? {
            guard let value = environment[key]?
                .trimmingCharacters(in: .whitespacesAndNewlines),
                  !value.isEmpty
            else { return nil }
            return value
        }
        let timeout = nonempty("E2B_SANDBOX_TIMEOUT_SECONDS").flatMap(Int.init) ?? 3_600
        let rate = nonempty("MOMO_T3_RATE_MICRO_USD_PER_SECOND").flatMap(Int64.init) ?? 25
        return CloudProvisionerConfig(
            apiBaseURL: nonempty("E2B_API_BASE_URL") ?? defaultAPIBaseURL,
            apiKey: nonempty("E2B_API_KEY"),
            templateID: nonempty("E2B_TEMPLATE_ID"),
            publicServerURL: nonempty("MOMO_PUBLIC_BASE_URL"),
            sandboxTimeoutSeconds: min(max(timeout, 60), 86_400),
            unitRateMicroUSDSecond: max(rate, 1)
        )
    }

    func requireReady() throws -> ReadyCloudProvisionerConfig {
        guard let apiKey else { throw CloudProvisionerError.missingAPIKey }
        guard let templateID else { throw CloudProvisionerError.missingTemplate }
        guard let publicServerURL,
              let url = URL(string: publicServerURL),
              url.scheme?.lowercased() == "https",
              url.host != nil
        else { throw CloudProvisionerError.invalidPublicServerURL }
        guard let apiURL = URL(string: apiBaseURL),
              let scheme = apiURL.scheme?.lowercased(),
              scheme == "https" || scheme == "http",
              apiURL.host != nil
        else { throw CloudProvisionerError.invalidAPIBaseURL }
        return ReadyCloudProvisionerConfig(
            apiBaseURL: apiBaseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/")),
            apiKey: apiKey,
            templateID: templateID,
            publicServerURL: publicServerURL.trimmingCharacters(
                in: CharacterSet(charactersIn: "/")
            ),
            sandboxTimeoutSeconds: sandboxTimeoutSeconds,
            unitRateMicroUSDSecond: unitRateMicroUSDSecond
        )
    }
}

struct ReadyCloudProvisionerConfig: Sendable, Equatable {
    let apiBaseURL: String
    let apiKey: String
    let templateID: String
    let publicServerURL: String
    let sandboxTimeoutSeconds: Int
    let unitRateMicroUSDSecond: Int64
}

enum CloudProvisionerError: Error, Sendable, Equatable {
    case missingAPIKey
    case missingTemplate
    case invalidPublicServerURL
    case invalidAPIBaseURL
    case upstreamStatus(Int)
    case invalidResponse
    case requestFailed
}

struct CloudSandbox: Sendable, Equatable {
    let id: String
}

protocol CloudProvisioning: Sendable {
    func create(
        provisionID: UUID,
        workspaceID: UUID,
        registrationToken: String,
        displayName: String
    ) async throws -> CloudSandbox
    func pause(sandboxID: String) async throws
    func resume(sandboxID: String) async throws
    func destroy(sandboxID: String) async throws
}

/// Thin E2B REST adapter. The selected E2B template is an operator-owned image
/// whose entrypoint launches `momo-workd`; create injects only its one-shot
/// registration material and public momo endpoint. The E2B team key never
/// enters a workspace setting, response, database row, or log.
struct E2BProvisioner: CloudProvisioning {
    private struct CreateBody: Encodable {
        let templateID: String
        let timeout: Int
        let autoPause = false
        let secure = true
        let metadata: [String: String]
        let envVars: [String: String]
    }

    private struct ConnectBody: Encodable { let timeout: Int }
    private struct CreateResponse: Decodable { let sandboxID: String }
    private enum RequestMethod { case post, delete }

    let httpClient: HTTPClient
    let config: ReadyCloudProvisionerConfig

    func create(
        provisionID: UUID,
        workspaceID: UUID,
        registrationToken: String,
        displayName: String
    ) async throws -> CloudSandbox {
        let body = CreateBody(
            templateID: config.templateID,
            timeout: config.sandboxTimeoutSeconds,
            metadata: [
                "momo_provision_id": provisionID.uuidString.lowercased(),
                "momo_workspace_id": workspaceID.uuidString.lowercased(),
            ],
            envVars: [
                "MOMO_WORKD_SERVER_URL": config.publicServerURL,
                "MOMO_WORKD_WORKSPACE_ID": workspaceID.uuidString.lowercased(),
                "MOMO_WORKD_SCOPE": "workspace",
                "MOMO_WORKD_HOST_TYPE": "cloud",
                "MOMO_WORKD_DISPLAY_NAME": displayName,
                "MOMO_WORKD_REGISTRATION_TOKEN": registrationToken,
            ]
        )
        let data = try JSONEncoder().encode(body)
        let response = try await execute(method: .post, path: "/sandboxes", body: data)
        guard response.status.code == 201 else {
            throw CloudProvisionerError.upstreamStatus(Int(response.status.code))
        }
        let responseData = try await collect(response)
        guard let decoded = try? JSONDecoder().decode(CreateResponse.self, from: responseData),
              !decoded.sandboxID.isEmpty
        else { throw CloudProvisionerError.invalidResponse }
        return CloudSandbox(id: decoded.sandboxID)
    }

    func pause(sandboxID: String) async throws {
        let response = try await execute(
            method: .post, path: "/sandboxes/\(try safeID(sandboxID))/pause", body: nil
        )
        guard response.status.code == 204 else {
            throw CloudProvisionerError.upstreamStatus(Int(response.status.code))
        }
    }

    func resume(sandboxID: String) async throws {
        let data = try JSONEncoder().encode(
            ConnectBody(timeout: config.sandboxTimeoutSeconds)
        )
        let response = try await execute(
            method: .post, path: "/sandboxes/\(try safeID(sandboxID))/connect", body: data
        )
        guard response.status.code == 200 || response.status.code == 201 else {
            throw CloudProvisionerError.upstreamStatus(Int(response.status.code))
        }
    }

    func destroy(sandboxID: String) async throws {
        let response = try await execute(
            method: .delete, path: "/sandboxes/\(try safeID(sandboxID))", body: nil
        )
        guard response.status.code == 204 else {
            throw CloudProvisionerError.upstreamStatus(Int(response.status.code))
        }
    }

    private func execute(
        method: RequestMethod,
        path: String,
        body: Data?
    ) async throws -> HTTPClientResponse {
        var request = HTTPClientRequest(url: config.apiBaseURL + path)
        switch method {
        case .post: request.method = .POST
        case .delete: request.method = .DELETE
        }
        request.headers.add(name: "X-API-Key", value: config.apiKey)
        request.headers.add(name: "Accept", value: "application/json")
        if let body {
            request.headers.add(name: "Content-Type", value: "application/json")
            request.body = .bytes(ByteBuffer(data: body))
        }
        do {
            return try await httpClient.execute(request, timeout: .seconds(30))
        } catch {
            throw CloudProvisionerError.requestFailed
        }
    }

    private func collect(_ response: HTTPClientResponse) async throws -> Data {
        do {
            var buffer = try await response.body.collect(upTo: 64 * 1024)
            return buffer.readData(length: buffer.readableBytes) ?? Data()
        } catch {
            throw CloudProvisionerError.invalidResponse
        }
    }

    private func safeID(_ value: String) throws -> String {
        guard value.wholeMatch(of: /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/) != nil else {
            throw CloudProvisionerError.invalidResponse
        }
        return value
    }
}
