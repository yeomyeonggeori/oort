import Foundation
import MomoCore
import SwiftCentrifuge

// MARK: - Realtime token provider

public protocol RealtimeConnectionTokenProvider: Sendable {
    func realtimeConnectionToken() async throws -> String
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

public final class SwiftCentrifugeRealtimeSubscriptionTransport: RealtimeEnvelopeSubscriptionTransport {
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
        let channelName = Self.channelName(workspace: workspace, channel: channel)
        let tokenProvider = self.tokenProvider
        let endpoint = endpoint.absoluteString
        let debug = debug

        return AsyncThrowingStream { continuation in
            let delegate = CentrifugoEnvelopeDelegate(
                channel: channelName,
                continuation: continuation
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
                client.connect()
                subscription.subscribe()
            } catch {
                continuation.finish(throwing: error)
            }
        }
    }

    public static func channelName(workspace: WorkspaceID, channel: ChannelID) -> String {
        "ch:ws\(workspace.description).\(channel.description)"
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
    let channel: String
    weak var lifetime: CentrifugoSubscriptionLifetime?

    private let continuation: AsyncThrowingStream<RealtimeEnvelope, Error>.Continuation

    init(
        channel: String,
        continuation: AsyncThrowingStream<RealtimeEnvelope, Error>.Continuation
    ) {
        self.channel = channel
        self.continuation = continuation
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
        continuation.finish(throwing: event.error)
        lifetime?.close()
    }

    func onUnsubscribed(_ sub: CentrifugeSubscription, _ event: CentrifugeUnsubscribedEvent) {
        continuation.finish()
        lifetime?.close()
    }

    func onError(_ client: CentrifugeClient, _ event: CentrifugeErrorEvent) {
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
