import Hummingbird
import HTTPTypes
import Logging

public struct MetricsRequestContext: RequestContext {
    public var coreContext: CoreRequestContextStorage
    public init(source: Source) {
        coreContext = .init(source: source)
    }
}

public enum MetricsHTTPServer {
    public static func build(
        registry: MetricsRegistry,
        host: String = "0.0.0.0",
        port: Int,
        serviceName: String,
        logger: Logger
    ) -> some ApplicationProtocol {
        let router = Router(context: MetricsRequestContext.self)
        router.get("/metrics") { _, _ -> Response in
            var headers = HTTPFields()
            headers[.contentType] = "text/plain; version=0.0.4; charset=utf-8"
            return Response(
                status: .ok,
                headers: headers,
                body: .init(byteBuffer: .init(string: await registry.render()))
            )
        }
        return Application(
            router: router,
            configuration: .init(
                address: .hostname(host, port: port),
                serverName: "\(serviceName)Metrics"
            ),
            logger: logger
        )
    }
}
