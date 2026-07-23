import AsyncHTTPClient
import Foundation
import Logging
import NIOCore

/// Outcome of a provider health probe. Carries only a coarse, credential-free
/// reason category (ADR-0004: never print credential material or provider
/// account identifiers in evidence).
struct ProviderHealthResult: Sendable, Equatable {
    var ok: Bool
    var reason: String?
}

/// Abstracts the outbound provider health check so routes stay unit-testable and
/// the live path can be swapped for a mock.
protocol ProviderHealthProbing: Sendable {
    /// Perform a minimal OpenAI-compatible roundtrip against `baseURL` using
    /// `bearer`. Implementations MUST NOT surface the bearer or response bodies.
    func probe(baseURL: String, bearer: String) async -> ProviderHealthResult
}

/// Live probe: a bounded `GET {baseURL}/models` with `Authorization: Bearer …`.
/// `/models` is the lightest OpenAI-compatible reachability + auth signal.
struct HTTPProviderHealthProbe: ProviderHealthProbing {
    let httpClient: HTTPClient
    let timeout: TimeAmount
    let logger: Logger

    init(httpClient: HTTPClient, logger: Logger, timeout: TimeAmount = .seconds(6)) {
        self.httpClient = httpClient
        self.logger = logger
        self.timeout = timeout
    }

    func probe(baseURL: String, bearer: String) async -> ProviderHealthResult {
        let trimmed = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let url = trimmed.hasSuffix("/") ? "\(trimmed)models" : "\(trimmed)/models"
        var request = HTTPClientRequest(url: url)
        request.method = .GET
        request.headers.add(name: "Authorization", value: "Bearer \(bearer)")
        request.headers.add(name: "Accept", value: "application/json")
        do {
            let response = try await httpClient.execute(request, timeout: timeout)
            // Drain (bounded) so the connection can be reused; body is discarded.
            _ = try? await response.body.collect(upTo: 64 * 1024)
            let code = Int(response.status.code)
            switch code {
            case 200...299:
                return ProviderHealthResult(ok: true, reason: nil)
            case 401, 403:
                return ProviderHealthResult(ok: false, reason: "provider_auth_failed")
            default:
                return ProviderHealthResult(ok: false, reason: "provider_status_\(code)")
            }
        } catch {
            // Never include the error's description — it can echo the URL/creds.
            logger.info("provider health probe failed", metadata: [
                "category": .string("provider_unreachable"),
            ])
            return ProviderHealthResult(ok: false, reason: "provider_unreachable")
        }
    }
}
