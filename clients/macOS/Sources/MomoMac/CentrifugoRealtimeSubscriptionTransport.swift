import Foundation
import MomoCore
import SwiftCentrifuge

// MARK: - Realtime token provider

public protocol RealtimeConnectionTokenProvider: Sendable {
    func realtimeConnectionToken() async throws -> String
}

public protocol AgentRealtimeEnvelopeSubscriptionTransport: Sendable {
    func envelopes(
        agent: MemberID,
        channel: ChannelID
    ) async throws -> AsyncThrowingStream<RealtimeEnvelope, Error>
}

public protocol ReadStateRealtimeEnvelopeSubscriptionTransport: Sendable {
    func readStateEnvelopes(
        member: MemberID
    ) async throws -> AsyncThrowingStream<RealtimeEnvelope, Error>
}

public actor MomoServerRealtimeTokenProvider: RealtimeConnectionTokenProvider {
    private let baseURL: URL
    private let session: URLSession
    private let accessTokenProvider: @Sendable () async throws -> String
    private let decoder: JSONDecoder

    public init(
        baseURL: URL,
        session: URLSession = .shared,
        accessTokenProvider: @escaping @Sendable () async throws -> String
    ) {
        self.baseURL = baseURL
        self.session = session
        self.accessTokenProvider = accessTokenProvider
        self.decoder = JSONDecoder()
    }

    public func realtimeConnectionToken() async throws -> String {
        let appAccessToken = try await accessTokenProvider()
        var request = URLRequest(url: baseURL.appendingPathComponent("/v1/auth/realtime-token"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(appAccessToken)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw BackendError.realtime("non-HTTP realtime-token response")
        }
        guard (200..<300).contains(http.statusCode) else {
            if let problem = try? decoder.decode(RealtimeProblemResponse.self, from: data) {
                throw BackendError.problem(status: http.statusCode, title: problem.title, detail: problem.detail ?? problem.message)
            }
            throw BackendError.problem(status: http.statusCode, title: HTTPURLResponse.localizedString(forStatusCode: http.statusCode), detail: nil)
        }

        let token = try decoder.decode(RealtimeTokenResponse.self, from: data)
        return token.token
    }
}

// MARK: - SwiftCentrifuge transport

public final class SwiftCentrifugeRealtimeSubscriptionTransport: RealtimeEnvelopeSubscriptionTransport, RealtimeStatusReportingEnvelopeSubscriptionTransport, AgentRealtimeEnvelopeSubscriptionTransport, ReadStateRealtimeEnvelopeSubscriptionTransport {
    public let endpoint: URL
    public let workspace: WorkspaceID

    private let tokenProvider: any RealtimeConnectionTokenProvider
    private let debug: Bool

    public init(
        endpoint: URL,
        workspace: WorkspaceID,
        tokenProvider: any RealtimeConnectionTokenProvider,
        debug: Bool = false
    ) {
        self.endpoint = endpoint
        self.workspace = workspace
        self.tokenProvider = tokenProvider
        self.debug = debug
    }

    public func envelopes(channel: ChannelID) async throws -> AsyncThrowingStream<RealtimeEnvelope, Error> {
        try await envelopes(channel: channel) { _ in }
    }

    public func envelopes(
        channel: ChannelID,
        statusHandler: @escaping RealtimeStatusHandler
    ) async throws -> AsyncThrowingStream<RealtimeEnvelope, Error> {
        let channelName = Self.channelName(workspace: workspace, channel: channel)
        return try await envelopes(
            named: channelName,
            logicalChannel: channel,
            statusHandler: statusHandler
        )
    }

    public func envelopes(
        agent: MemberID,
        channel: ChannelID
    ) async throws -> AsyncThrowingStream<RealtimeEnvelope, Error> {
        try await envelopes(
            named: Self.agentChannelName(
                workspace: workspace,
                channel: channel,
                agent: agent
            ),
            logicalChannel: channel,
            statusHandler: { _ in }
        )
    }

    public func readStateEnvelopes(
        member: MemberID
    ) async throws -> AsyncThrowingStream<RealtimeEnvelope, Error> {
        // The status callback is intentionally ignored for the personal stream;
        // channel-level status continues to drive the existing offline banner.
        try await envelopes(
            named: Self.readStateChannelName(member: member),
            logicalChannel: ChannelID(member.rawValue),
            statusHandler: { _ in }
        )
    }

    private func envelopes(
        named channelName: String,
        logicalChannel channel: ChannelID,
        statusHandler: @escaping RealtimeStatusHandler
    ) async throws -> AsyncThrowingStream<RealtimeEnvelope, Error> {
        let tokenProvider = self.tokenProvider
        let endpoint = endpoint.absoluteString
        let debug = debug

        return AsyncThrowingStream { continuation in
            let delegate = CentrifugoEnvelopeDelegate(
                channelId: channel,
                channel: channelName,
                continuation: continuation,
                statusHandler: statusHandler
            )
            let config = CentrifugeClientConfig(
                name: "momo-macos",
                tokenGetter: { _, completion in
                    let completion = RealtimeTokenCompletion(completion)
                    Task {
                        do {
                            completion.succeed(try await tokenProvider.realtimeConnectionToken())
                        } catch {
                            completion.fail(error)
                        }
                    }
                },
                logger: debug ? CentrifugoPrintLogger() : nil
            )
            let client = CentrifugeClient(endpoint: endpoint, config: config, delegate: delegate)

            do {
                let subscription = try client.newSubscription(channel: channelName, delegate: delegate)
                let lifetime = CentrifugoSubscriptionLifetime(client: client, subscription: subscription, delegate: delegate)
                delegate.lifetime = lifetime
                continuation.onTermination = { _ in
                    lifetime.close()
                }
                statusHandler(RealtimeConnectionStatus(
                    channelId: channel,
                    connection: .connecting,
                    subscription: .subscribing,
                    canRetry: false,
                    message: "Connecting to realtime."
                ))
                client.connect()
                subscription.subscribe()
            } catch {
                statusHandler(RealtimeConnectionStatus(
                    channelId: channel,
                    connection: .error,
                    subscription: .error,
                    fallback: .restHistory,
                    canRetry: true,
                    message: String(describing: error)
                ))
                continuation.finish(throwing: error)
            }
        }
    }

    public static func channelName(workspace: WorkspaceID, channel: ChannelID) -> String {
        "ch:ws\(workspace.description).\(channel.description)"
    }

    public static func agentChannelName(
        workspace: WorkspaceID,
        channel: ChannelID,
        agent: MemberID
    ) -> String {
        "agent:ws\(workspace.description).\(channel.description).\(agent.description)"
    }

    public static func readStateChannelName(member: MemberID) -> String {
        "user:read-state#\(member.description)"
    }

    public static func decodePublicationData(_ data: Data) throws -> RealtimeEnvelope {
        try JSONDecoder.momo.decode(RealtimeEnvelope.self, from: data)
    }
}

private final class CentrifugoSubscriptionLifetime: @unchecked Sendable {
    private let lock = NSLock()
    private var client: CentrifugeClient?
    private var subscription: CentrifugeSubscription?
    private var delegate: CentrifugoEnvelopeDelegate?

    init(
        client: CentrifugeClient,
        subscription: CentrifugeSubscription,
        delegate: CentrifugoEnvelopeDelegate
    ) {
        self.client = client
        self.subscription = subscription
        self.delegate = delegate
    }

    func close() {
        let retained = lock.withLock {
            let retained = (client, subscription, delegate)
            subscription = nil
            client = nil
            delegate = nil
            return retained
        }
        retained.1?.unsubscribe()
        retained.0?.disconnect()
    }
}

private struct RealtimeTokenCompletion: @unchecked Sendable {
    private let complete: (Result<String, Error>) -> Void

    init(_ complete: @escaping (Result<String, Error>) -> Void) {
        self.complete = complete
    }

    func succeed(_ token: String) {
        complete(.success(token))
    }

    func fail(_ error: Error) {
        complete(.failure(error))
    }
}

private final class CentrifugoEnvelopeDelegate: CentrifugeClientDelegate, CentrifugeSubscriptionDelegate, @unchecked Sendable {
    let channelId: ChannelID
    let channel: String
    weak var lifetime: CentrifugoSubscriptionLifetime?

    private let continuation: AsyncThrowingStream<RealtimeEnvelope, Error>.Continuation
    private let statusHandler: RealtimeStatusHandler

    init(
        channelId: ChannelID,
        channel: String,
        continuation: AsyncThrowingStream<RealtimeEnvelope, Error>.Continuation,
        statusHandler: @escaping RealtimeStatusHandler
    ) {
        self.channelId = channelId
        self.channel = channel
        self.continuation = continuation
        self.statusHandler = statusHandler
    }

    func onConnecting(_ client: CentrifugeClient, _ event: CentrifugeConnectingEvent) {
        statusHandler(RealtimeConnectionStatus(
            channelId: channelId,
            connection: .reconnecting,
            subscription: .recovering,
            fallback: .restHistory,
            canRetry: false,
            message: event.reason
        ))
    }

    func onConnected(_ client: CentrifugeClient, _ event: CentrifugeConnectedEvent) {
        statusHandler(RealtimeConnectionStatus(
            channelId: channelId,
            connection: .connected,
            subscription: .subscribing,
            canRetry: false,
            message: "Realtime connection established."
        ))
    }

    func onDisconnected(_ client: CentrifugeClient, _ event: CentrifugeDisconnectedEvent) {
        statusHandler(RealtimeConnectionStatus(
            channelId: channelId,
            connection: .offline,
            subscription: .unsubscribed,
            fallback: .restHistory,
            canRetry: true,
            message: event.reason
        ))
    }

    func onSubscribing(_ sub: CentrifugeSubscription, _ event: CentrifugeSubscribingEvent) {
        statusHandler(RealtimeConnectionStatus(
            channelId: channelId,
            connection: .connected,
            subscription: .recovering,
            fallback: .restHistory,
            canRetry: false,
            message: event.reason
        ))
    }

    func onSubscribed(_ sub: CentrifugeSubscription, _ event: CentrifugeSubscribedEvent) {
        statusHandler(RealtimeConnectionStatus(
            channelId: channelId,
            connection: .connected,
            subscription: .subscribed,
            canRetry: false,
            message: event.recovered ? "Realtime recovered missed publications." : "Realtime subscribed."
        ))
    }

    func onPublication(_ sub: CentrifugeSubscription, _ event: CentrifugePublicationEvent) {
        do {
            continuation.yield(try SwiftCentrifugeRealtimeSubscriptionTransport.decodePublicationData(event.data))
        } catch {
            continuation.finish(throwing: error)
            lifetime?.close()
        }
    }

    func onError(_ sub: CentrifugeSubscription, _ event: CentrifugeSubscriptionErrorEvent) {
        statusHandler(RealtimeConnectionStatus(
            channelId: channelId,
            connection: .error,
            subscription: .error,
            fallback: .restHistory,
            canRetry: true,
            message: String(describing: event.error)
        ))
        continuation.finish(throwing: event.error)
        lifetime?.close()
    }

    func onUnsubscribed(_ sub: CentrifugeSubscription, _ event: CentrifugeUnsubscribedEvent) {
        statusHandler(RealtimeConnectionStatus(
            channelId: channelId,
            connection: .offline,
            subscription: .unsubscribed,
            fallback: .restHistory,
            canRetry: true,
            message: event.reason
        ))
        continuation.finish()
        lifetime?.close()
    }

    func onError(_ client: CentrifugeClient, _ event: CentrifugeErrorEvent) {
        statusHandler(RealtimeConnectionStatus(
            channelId: channelId,
            connection: .error,
            subscription: .error,
            fallback: .restHistory,
            canRetry: true,
            message: String(describing: event.error)
        ))
        continuation.finish(throwing: event.error)
        lifetime?.close()
    }
}

private struct RealtimeTokenResponse: Decodable {
    let token: String
}

private struct RealtimeProblemResponse: Decodable {
    let title: String?
    let detail: String?
    let message: String?
}

private final class CentrifugoPrintLogger: CentrifugeLogger, @unchecked Sendable {
    func log(
        level: CentrifugeLoggerLevel,
        message: @autoclosure () -> String,
        file: StaticString,
        function: StaticString,
        line: UInt
    ) {
        print("[SwiftCentrifuge:\(level)] \(message())")
    }
}
