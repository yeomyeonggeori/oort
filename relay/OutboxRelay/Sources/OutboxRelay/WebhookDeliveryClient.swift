import AsyncHTTPClient
@preconcurrency import Crypto
import Foundation
import NIOCore
import NIOFoundationCompat
import OutboundHTTPPolicy

enum WebhookDeliveryResult: Equatable, Sendable {
    case ok(Int)
    case transientServerFailure(Int)
    case transientFailure(String, status: Int?)
    case permanentFailure(String, status: Int?)

    /// The HTTP status the destination answered with, or `nil` when the bytes
    /// never reached it (이슈 #1204).
    ///
    /// This is the discriminator the delivery audit rests on. A status exists
    /// exactly when `transport.post` returned — that is, when the payload
    /// (message body included, ADR-0150 territory) was actually handed to the
    /// external host. `nil` means the SSRF guard refused the destination or the
    /// request threw before an answer; recording either as a delivery would put
    /// a false line in the ledger, and both already live in `outbox.last_error`.
    var deliveredStatus: Int? {
        switch self {
        case .ok(let status): return status
        case .transientServerFailure(let status): return status
        case .permanentFailure(_, let status): return status
        // 408/429 also reached the host and therefore carry a status; only a
        // throw before an answer leaves this `nil`.
        case .transientFailure(_, let status): return status
        }
    }
}

struct WebhookHTTPRequest: Sendable {
    let url: URL
    let resolvedAddress: String
    let headers: [(String, String)]
    let body: Data
}

protocol WebhookHTTPTransport: Sendable {
    func post(_ request: WebhookHTTPRequest) async throws -> Int
}

struct AsyncWebhookHTTPTransport: WebhookHTTPTransport {
    func post(_ outbound: WebhookHTTPRequest) async throws -> Int {
        guard let host = outbound.url.host else { throw OutboundURLPolicyError.invalidURL }
        var configuration = HTTPClient.Configuration()
        configuration.redirectConfiguration = .disallow
        configuration.dnsOverride = [host: outbound.resolvedAddress]
        let client = HTTPClient(
            eventLoopGroupProvider: .singleton,
            configuration: configuration
        )
        var request = HTTPClientRequest(url: outbound.url.absoluteString)
        request.method = .POST
        for (name, value) in outbound.headers {
            request.headers.add(name: name, value: value)
        }
        request.body = .bytes(ByteBuffer(data: outbound.body))
        do {
            let response = try await client.execute(request, timeout: .seconds(5))
            _ = try await response.body.collect(upTo: 64 * 1024)
            try? await client.shutdown()
            return Int(response.status.code)
        } catch {
            try? await client.shutdown()
            throw error
        }
    }
}

protocol WebhookDelivering: Sendable {
    func deliver(
        url: URL,
        deliveryID: String,
        eventKind: String,
        secret: String,
        body: Data
    ) async -> WebhookDeliveryResult
}

struct SafeWebhookDeliveryClient<Resolver: OutboundHostResolving, Transport: WebhookHTTPTransport>:
    WebhookDelivering
{
    let resolver: Resolver
    let transport: Transport
    let allowDevelopmentHTTP: Bool

    func deliver(
        url: URL,
        deliveryID: String,
        eventKind: String,
        secret: String,
        body: Data
    ) async -> WebhookDeliveryResult {
        let checkedURL: URL
        let addresses: [String]
        do {
            checkedURL = try OutboundURLPolicy.validatedURL(
                url, allowDevelopmentHTTP: allowDevelopmentHTTP
            )
            addresses = try await OutboundURLPolicy.validatedResolvedAddresses(
                for: checkedURL, resolver: resolver
            )
        } catch {
            // Nothing left the process: no status, and therefore no delivery
            // audit row (#1204). `outbox.last_error` is where this lives.
            return .permanentFailure("SSRF guard rejected destination", status: nil)
        }

        let timestamp = String(Int64(Date().timeIntervalSince1970))
        let signature = Self.signature(secret: secret, timestamp: timestamp, body: body)
        do {
            let status = try await transport.post(
                WebhookHTTPRequest(
                    url: checkedURL,
                    resolvedAddress: addresses[0],
                    headers: [
                        ("Content-Type", "application/json"),
                        ("User-Agent", "momo-outbound-webhook/1"),
                        ("X-Momo-Delivery", deliveryID),
                        ("X-Momo-Event", eventKind),
                        ("X-Momo-Timestamp", timestamp),
                        ("X-Momo-Signature", "v1=\(signature)"),
                    ],
                    body: body
                )
            )
            if (200..<300).contains(status) { return .ok(status) }
            if status >= 500 { return .transientServerFailure(status) }
            if status == 408 || status == 429 {
                return .transientFailure("HTTP \(status)", status: status)
            }
            // Redirects are intentionally not followed. Following a POST redirect
            // would require revalidating and repinning every hop; v0 fails closed.
            return .permanentFailure("HTTP \(status)", status: status)
        } catch {
            // The request may or may not have reached the host — an audit row
            // either way would be a guess. `outbox.last_error` records it.
            return .transientFailure("request failed", status: nil)
        }
    }

    static func signature(secret: String, timestamp: String, body: Data) -> String {
        let key = SymmetricKey(data: Data(secret.utf8))
        var base = Data("\(timestamp).".utf8)
        base.append(body)
        return HMAC<SHA256>.authenticationCode(for: base, using: key)
            .map { String(format: "%02x", $0) }
            .joined()
    }

    static func derivedSecret(masterKey: String, secretRef: String) -> String {
        let key = SymmetricKey(data: Data(masterKey.utf8))
        let material = Data("momo.webhook.outbound.v1\n\(secretRef)".utf8)
        let code = HMAC<SHA256>.authenticationCode(for: material, using: key)
        return "momo_evtsec_v1.\(base64URL(Data(code)))"
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
