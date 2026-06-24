import Foundation

/// Errors surfaced by `ChatBackend` / `AgentTransport` implementations.
/// REST errors follow RFC 9457 problem+json (L4 §5.1); `.problem` carries it.
public enum BackendError: Error, Sendable, Hashable {
    /// Not connected / auth not established.
    case notConnected
    /// HTTP-level failure with an RFC 9457 problem document, if parseable.
    case problem(status: Int, title: String?, detail: String?)
    /// Realtime transport (Centrifugo) failure.
    case realtime(String)
    /// Decoding of a wire payload failed.
    case decoding(String)
    /// The cost circuit breaker tripped (L4 §3.3 G5 / §8.5).
    case budgetExceeded(reservedMicroUSD: Int64, limitMicroUSD: Int64)
    /// Operation timed out.
    case timedOut
}
