import Foundation

public struct MetricsEndpointConfig: Sendable {
    public let host: String
    public let port: Int

    public init(host: String, port: Int) {
        self.host = host
        self.port = port
    }

    /// Local source runs stay loopback-only. Compose must explicitly set
    /// MOMO_METRICS_HOST=0.0.0.0; the metrics port is never host-published.
    public static func load(defaultPort: Int) -> MetricsEndpointConfig {
        let environment = ProcessInfo.processInfo.environment
        return MetricsEndpointConfig(
            host: environment["MOMO_METRICS_HOST"] ?? "127.0.0.1",
            port: environment["MOMO_METRICS_PORT"].flatMap(Int.init) ?? defaultPort
        )
    }
}
