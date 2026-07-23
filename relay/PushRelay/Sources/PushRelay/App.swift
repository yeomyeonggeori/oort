import Crypto
import Foundation
import Hummingbird
import HTTPTypes
import Logging
import MomoMetrics

struct RelayRequestContext: RequestContext {
    var coreContext: CoreRequestContextStorage
    init(source: Source) { self.coreContext = .init(source: source) }
}

struct HealthResponse: ResponseEncodable {
    let ok = true
    let service = "PushRelay"
}

struct PushReceipt: ResponseEncodable {
    let apnsStatus: Int
    let apnsReason: String?
    let apnsId: String?

    enum CodingKeys: String, CodingKey {
        case apnsStatus = "apns_status"
        case apnsReason = "apns_reason"
        case apnsId = "apns_id"
    }
}

enum PushRelayApp {
    private static let serverIDHeader = HTTPField.Name("X-Momo-Server-Id")!
    private static let signatureHeader = HTTPField.Name("X-Momo-Push-Signature")!

    static func build(
        config: RelayConfig,
        sender: any APNSSender,
        metrics: MetricsRegistry,
        logger: Logger
    ) -> some ApplicationProtocol {
        let router = Router(context: RelayRequestContext.self)
        let limiter = ServerRateLimiter(limit: config.rateLimitPerMinute)

        router.get("/health") { _, _ in HealthResponse() }
        router.post("/v1/push") { request, _ -> PushReceipt in
            guard let serverID = request.headers[Self.serverIDHeader],
                  let signatureText = request.headers[Self.signatureHeader],
                  let publicKey = config.servers[serverID],
                  let signature = Data(base64Encoded: signatureText)
            else { throw HTTPError(.forbidden, message: "unregistered or invalid server signature") }

            var mutableRequest = request
            let rawBody: Data
            do {
                let buffer = try await mutableRequest.collectBody(upTo: 64 * 1024)
                rawBody = Data(buffer.readableBytesView)
            } catch {
                throw HTTPError(.contentTooLarge, message: "dispatch body exceeds 65536 bytes")
            }
            guard publicKey.isValidSignature(signature, for: rawBody) else {
                throw HTTPError(.forbidden, message: "unregistered or invalid server signature")
            }
            guard await limiter.allow(serverID: serverID) else {
                throw HTTPError(.tooManyRequests, message: "server push rate limit exceeded")
            }

            let dispatch: PushDispatch
            do {
                dispatch = try PushDispatch.decodeClosed(rawBody)
            } catch {
                throw HTTPError(.badRequest, message: "invalid momo.push.dispatch.v2 payload")
            }
            guard dispatch.serverId == serverID else {
                throw HTTPError(.forbidden, message: "signed server_id does not match request header")
            }
            if let configuredEnvironment = config.apnsEnvironment,
               dispatch.apnsEnv != configuredEnvironment.rawValue
            {
                throw HTTPError(.badRequest, message: "dispatch APNs environment does not match relay")
            }

            do {
                let result = try await sender.send(dispatch)
                if let codeClass = APNSFailureCodeClass.classify(status: result.status) {
                    await metrics.incrementLabeledCounter(
                        name: MomoMetricName.apnsFailuresTotal,
                        labelValue: codeClass.rawValue
                    )
                }
                return PushReceipt(
                    apnsStatus: result.status,
                    apnsReason: result.reason,
                    apnsId: result.apnsID
                )
            } catch {
                await metrics.incrementLabeledCounter(
                    name: MomoMetricName.apnsFailuresTotal,
                    labelValue: APNSFailureCodeClass.transportError.rawValue
                )
                logger.error("APNs dispatch failed", metadata: [
                    "serverId": .string(serverID),
                    "messageId": .string(dispatch.messageId),
                    "error": .string(String(describing: error)),
                ])
                throw HTTPError(.badGateway, message: "APNs transport failed")
            }
        }

        var app = Application(
            router: router,
            configuration: .init(
                address: .hostname(config.host, port: config.port),
                serverName: "PushRelay"
            ),
            logger: logger
        )
        let metricsEndpoint = MetricsEndpointConfig.load(defaultPort: 9093)
        app.addServices(MetricsHTTPServer.build(
            registry: metrics,
            host: metricsEndpoint.host,
            port: metricsEndpoint.port,
            serviceName: "PushRelay",
            logger: logger
        ))
        return app
    }
}
