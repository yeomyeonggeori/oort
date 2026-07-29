import AsyncHTTPClient
import Foundation
import NIOCore
import NIOFoundationCompat

/// Managed-provider adapter over a provider-neutral REST shape.
///
/// ADR-0142 D2: create injects only the one-shot workd registration material
/// and the public momo endpoint. The operator key is a request header and never
/// enters a workspace setting, response, database row, or log.
///
/// Endpoint contract (the mock substrates implement exactly this):
///   POST   {base}/v1/instances                 -> 201 {"instanceId": "..."}
///   POST   {base}/v1/instances/{id}/pause      -> 204
///   POST   {base}/v1/instances/{id}/resume     -> 200|201
///   DELETE {base}/v1/instances/{id}            -> 204 (404/410 also success)
///   GET    {base}/v1/instances/{id}            -> 200 {"state": "..."} | 404
public struct HTTPCloudProviderAdapter: CloudProviderAdapter {
    private struct CreateBody: Encodable {
        let imageRef: String
        let timeoutSeconds: Int
        let metadata: [String: String]
        let env: [String: String]
    }

    private struct ResumeBody: Encodable { let timeoutSeconds: Int }
    private struct CreateResponse: Decodable { let instanceId: String }
    private struct ProbeResponse: Decodable { let state: String }

    private enum RequestMethod { case get, post, delete }

    public let capabilities: CloudProviderCapabilities
    private let endpoint: CloudProviderEndpoint
    private let publicServerURL: String
    private let httpClient: HTTPClient

    public init(
        capabilities: CloudProviderCapabilities,
        endpoint: CloudProviderEndpoint,
        publicServerURL: String,
        httpClient: HTTPClient
    ) {
        self.capabilities = capabilities
        self.endpoint = endpoint
        self.publicServerURL = publicServerURL
        self.httpClient = httpClient
    }

    public func create(
        spec: CloudInstanceSpec,
        idempotencyKey: String
    ) async throws -> CloudInstanceRef {
        guard capabilities.supports(.create) else {
            throw CloudProviderError.unsupported(.create, providerID: capabilities.providerID)
        }
        let body = CreateBody(
            imageRef: endpoint.imageRef,
            timeoutSeconds: endpoint.instanceTimeoutSeconds,
            metadata: [
                "momo_provision_id": spec.provisionID.uuidString.lowercased(),
                "momo_workspace_id": spec.workspaceID.uuidString.lowercased(),
            ],
            env: [
                "MOMO_WORKD_SERVER_URL": spec.serverURL,
                "MOMO_WORKD_WORKSPACE_ID": spec.workspaceID.uuidString.lowercased(),
                "MOMO_WORKD_SCOPE": "workspace",
                "MOMO_WORKD_HOST_TYPE": "cloud",
                "MOMO_WORKD_DISPLAY_NAME": spec.displayName,
                "MOMO_WORKD_REGISTRATION_TOKEN": spec.registrationToken,
            ]
        )
        let response = try await execute(
            method: .post,
            path: "/v1/instances",
            body: try JSONEncoder().encode(body),
            idempotencyKey: idempotencyKey
        )
        guard response.status.code == 201 else {
            throw Self.error(for: Int(response.status.code))
        }
        let data = try await collect(response)
        guard let decoded = try? JSONDecoder().decode(CreateResponse.self, from: data),
              !decoded.instanceId.isEmpty
        else { throw CloudProviderError.invalidResponse }
        return CloudInstanceRef(
            providerID: capabilities.providerID,
            instanceID: try validatedCloudInstanceID(decoded.instanceId)
        )
    }

    public func pause(ref: CloudInstanceRef, idempotencyKey: String) async throws {
        guard capabilities.supports(.pause) else {
            throw CloudProviderError.unsupported(.pause, providerID: capabilities.providerID)
        }
        let response = try await execute(
            method: .post,
            path: "/v1/instances/\(try validatedCloudInstanceID(ref.instanceID))/pause",
            body: nil,
            idempotencyKey: idempotencyKey
        )
        guard response.status.code == 204 else {
            throw Self.error(for: Int(response.status.code))
        }
    }

    public func resume(ref: CloudInstanceRef, idempotencyKey: String) async throws {
        guard capabilities.supports(.resume) else {
            throw CloudProviderError.unsupported(.resume, providerID: capabilities.providerID)
        }
        let response = try await execute(
            method: .post,
            path: "/v1/instances/\(try validatedCloudInstanceID(ref.instanceID))/resume",
            body: try JSONEncoder().encode(
                ResumeBody(timeoutSeconds: endpoint.instanceTimeoutSeconds)
            ),
            idempotencyKey: idempotencyKey
        )
        guard response.status.code == 200 || response.status.code == 201 else {
            throw Self.error(for: Int(response.status.code))
        }
    }

    /// Idempotent: an instance the provider no longer knows about already
    /// satisfies the intent, so 404/410 is success, not a retry forever.
    public func destroy(ref: CloudInstanceRef, idempotencyKey: String) async throws {
        guard capabilities.supports(.destroy) else {
            throw CloudProviderError.unsupported(.destroy, providerID: capabilities.providerID)
        }
        let response = try await execute(
            method: .delete,
            path: "/v1/instances/\(try validatedCloudInstanceID(ref.instanceID))",
            body: nil,
            idempotencyKey: idempotencyKey
        )
        let status = Int(response.status.code)
        guard status == 204 || status == 200 || status == 404 || status == 410 else {
            throw Self.error(for: status)
        }
    }

    /// Never converts "I could not ask" into "it is gone": a transport failure
    /// or an unexpected status answers `.unknown` so no caller can settle a
    /// paid session on an unanswered question.
    public func probe(ref: CloudInstanceRef) async throws -> CloudInstancePresence {
        let path = "/v1/instances/\(try validatedCloudInstanceID(ref.instanceID))"
        let response: HTTPClientResponse
        do {
            response = try await execute(
                method: .get, path: path, body: nil, idempotencyKey: nil
            )
        } catch {
            return .unknown
        }
        let status = Int(response.status.code)
        if status == 404 || status == 410 { return .absent }
        guard status == 200 else { return .unknown }
        guard let data = try? await collect(response),
              let decoded = try? JSONDecoder().decode(ProbeResponse.self, from: data)
        else { return .unknown }
        switch decoded.state {
        case "running", "paused", "starting": return .present
        case "absent", "destroyed", "dead": return .absent
        default: return .unknown
        }
    }

    private static func error(for status: Int) -> CloudProviderError {
        switch status {
        case 404, 410: return .instanceMissing
        case 409: return .instancePaused
        default: return .upstreamStatus(status)
        }
    }

    private func execute(
        method: RequestMethod,
        path: String,
        body: Data?,
        idempotencyKey: String?
    ) async throws -> HTTPClientResponse {
        var request = HTTPClientRequest(url: endpoint.apiBaseURL + path)
        switch method {
        case .get: request.method = .GET
        case .post: request.method = .POST
        case .delete: request.method = .DELETE
        }
        request.headers.add(name: "X-Momo-Provider-Key", value: endpoint.apiKey)
        request.headers.add(name: "Accept", value: "application/json")
        if let idempotencyKey {
            request.headers.add(name: "Idempotency-Key", value: idempotencyKey)
        }
        if let body {
            request.headers.add(name: "Content-Type", value: "application/json")
            request.body = .bytes(ByteBuffer(data: body))
        }
        do {
            return try await httpClient.execute(request, timeout: .seconds(30))
        } catch {
            throw CloudProviderError.requestFailed
        }
    }

    private func collect(_ response: HTTPClientResponse) async throws -> Data {
        do {
            var buffer = try await response.body.collect(upTo: 64 * 1024)
            return buffer.readData(length: buffer.readableBytes) ?? Data()
        } catch {
            throw CloudProviderError.invalidResponse
        }
    }
}
