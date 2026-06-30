import Foundation

public enum RealtimeConnectionState: String, Codable, Sendable, Hashable {
    case disabled
    case connecting
    case connected
    case reconnecting
    case offline
    case error
}

public enum RealtimeSubscriptionState: String, Codable, Sendable, Hashable {
    case disabled
    case subscribing
    case subscribed
    case recovering
    case unsubscribed
    case error
}

public enum RealtimeFallbackState: String, Codable, Sendable, Hashable {
    case none
    case restHistory
}

public struct RealtimeConnectionStatus: Codable, Sendable, Hashable {
    public var channelId: ChannelID
    public var connection: RealtimeConnectionState
    public var subscription: RealtimeSubscriptionState
    public var fallback: RealtimeFallbackState
    public var canRetry: Bool
    public var message: String?
    public var updatedAtMs: Int64

    public init(
        channelId: ChannelID,
        connection: RealtimeConnectionState,
        subscription: RealtimeSubscriptionState,
        fallback: RealtimeFallbackState = .none,
        canRetry: Bool = false,
        message: String? = nil,
        updatedAtMs: Int64 = RealtimeConnectionStatus.nowMs()
    ) {
        self.channelId = channelId
        self.connection = connection
        self.subscription = subscription
        self.fallback = fallback
        self.canRetry = canRetry
        self.message = message
        self.updatedAtMs = updatedAtMs
    }

    public var isLive: Bool {
        connection == .connected && subscription == .subscribed
    }

    public var isFallbackActive: Bool {
        fallback == .restHistory
    }

    public static func idle(channel: ChannelID) -> Self {
        Self(
            channelId: channel,
            connection: .disabled,
            subscription: .disabled,
            fallback: .restHistory,
            canRetry: true,
            message: "Realtime not started; REST history is available."
        )
    }

    public static func restFallback(channel: ChannelID, message: String? = nil) -> Self {
        Self(
            channelId: channel,
            connection: .disabled,
            subscription: .disabled,
            fallback: .restHistory,
            canRetry: true,
            message: message ?? "Realtime is unavailable; using REST history."
        )
    }

    public static func nowMs() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }
}

public typealias RealtimeStatusHandler = @Sendable (RealtimeConnectionStatus) -> Void

public protocol RealtimeStatusProvidingBackend: Sendable {
    func realtimeStatus(channel: ChannelID) async -> AsyncStream<RealtimeConnectionStatus>
    func retryRealtime(channel: ChannelID) async
}

public protocol RealtimeStatusProvidingDriver: Sendable {
    func realtimeStatus(channel: ChannelID) async -> AsyncStream<RealtimeConnectionStatus>
}

public protocol RealtimeStatusReportingEnvelopeSubscriptionTransport: RealtimeEnvelopeSubscriptionTransport {
    func envelopes(
        channel: ChannelID,
        statusHandler: @escaping RealtimeStatusHandler
    ) async throws -> AsyncThrowingStream<RealtimeEnvelope, Error>
}
