import AsyncHTTPClient
import Foundation
import Logging
import NIOCore
import NIOHTTP1
import NIOPosix
import XCTest
@testable import AgentWorker

/// MOMO-622 / ADR-0135 D1 — the provider cascade, worker side.
///
/// The fall-over rule is the whole ADR, so it is measured two ways:
///   1. **Pure**: the classifier + `ProviderCascade.step` matrix (no I/O).
///   2. **Over a real socket**: `MockProvider` is an in-process HTTP/1.1 server;
///      the tests build a 2-hop chain out of real endpoints and drive the real
///      `HermesTransport` through `ProviderCascadeRunner`. That is what makes
///      "무응답 → 2차 성공" and "401 → 전파" measurements rather than assertions
///      about a stub.
final class ProviderCascadeTests: XCTestCase {
    private let logger = Logger(label: "test")
    private static let key = "cascade-master-key-0622"

    // MARK: - Classifier: only no-response / 5xx / 429 fall over

    func testStatusClassificationMatrix() {
        // No response at all.
        XCTAssertEqual(
            ProviderCascadeClassifier.decide(status: nil),
            .fallOver(reason: "provider_unreachable")
        )
        // 429 + every 5xx fall over.
        XCTAssertEqual(
            ProviderCascadeClassifier.decide(status: 429),
            .fallOver(reason: "provider_rate_limited")
        )
        for code in [500, 502, 503, 504, 599] {
            XCTAssertTrue(
                ProviderCascadeClassifier.decide(status: code).isFallOver,
                "\(code) must fall over"
            )
        }
        // Every other 4xx propagates — a bad key/model/request fails identically
        // on the next provider and would silently spend a second budget.
        for code in [400, 401, 403, 404, 409, 422, 451] {
            XCTAssertFalse(
                ProviderCascadeClassifier.decide(status: code).isFallOver,
                "\(code) must propagate, not fall over"
            )
            XCTAssertEqual(
                ProviderCascadeClassifier.decide(status: code).reason,
                "provider_status_\(code)"
            )
        }
    }

    func testErrorClassification() {
        XCTAssertTrue(
            ProviderCascadeClassifier.decide(
                error: HermesTransport.TransportError.httpStatus(503)
            ).isFallOver
        )
        XCTAssertTrue(
            ProviderCascadeClassifier.decide(
                error: HermesTransport.TransportError.httpStatus(429)
            ).isFallOver
        )
        XCTAssertFalse(
            ProviderCascadeClassifier.decide(
                error: HermesTransport.TransportError.httpStatus(401)
            ).isFallOver
        )
        // A cancelled run must not spend a second provider's budget.
        XCTAssertEqual(
            ProviderCascadeClassifier.decide(error: CancellationError()),
            .propagate(reason: "cancelled")
        )
        // The provider answered — unparseably. Answered ⇒ not "무응답".
        let decodeError = DecodingError.dataCorrupted(
            .init(codingPath: [], debugDescription: "bad")
        )
        XCTAssertEqual(
            ProviderCascadeClassifier.decide(error: decodeError),
            .propagate(reason: "provider_response_undecodable")
        )
        // Anything else (connect refused, DNS, timeout, TLS, dropped stream).
        XCTAssertEqual(
            ProviderCascadeClassifier.decide(error: OpaqueTransportError()),
            .fallOver(reason: "provider_unreachable")
        )
    }

    // MARK: - step(): fall-over needs a fall-over failure AND a clean slate AND a next hop

    func testStepFallsOverOnlyWhenAllThreeConditionsHold() {
        let availability = HermesTransport.TransportError.httpStatus(503)
        XCTAssertEqual(
            ProviderCascade.step(failure: availability, emittedContent: false, hasNextHop: true),
            .fallOver(reason: "provider_status_503")
        )
        // Already streamed output → re-running elsewhere would duplicate it.
        XCTAssertEqual(
            ProviderCascade.step(failure: availability, emittedContent: true, hasNextHop: true),
            .surface(reason: "content_already_emitted")
        )
        // Nowhere left to go.
        XCTAssertEqual(
            ProviderCascade.step(failure: availability, emittedContent: false, hasNextHop: false),
            .surface(reason: "provider_status_503")
        )
        // 4xx never falls over, even with a clean slate and a spare hop.
        XCTAssertEqual(
            ProviderCascade.step(
                failure: HermesTransport.TransportError.httpStatus(401),
                emittedContent: false, hasNextHop: true
            ),
            .surface(reason: "provider_status_401")
        )
    }

    // MARK: - plan(): head is never dropped; hops are ordered and screened

    func testPlanKeepsHeadAndOrdersEnabledUsableChainEntries() {
        let head = ProviderCascadeHop(
            position: 0, source: .providerLink,
            baseURL: "https://head.example/v1", bearer: "sk-head"
        )
        let hops = ProviderCascade.plan(head: head, chain: [
            entry(position: 3, host: "third"),
            entry(position: 1, host: "first"),
            entry(position: 2, host: "parked", enabled: false),
            entry(position: 4, host: "blank", bearer: "  "),
        ])
        XCTAssertEqual(hops.map(\.position), [0, 1, 3],
                       "disabled and unusable hops must not be attempted")
        XCTAssertEqual(hops.map(\.source), [.providerLink, .chain, .chain])
        XCTAssertEqual(hops[1].baseURL, "https://first.example/v1")
    }

    func testPlanWithNoChainIsExactlyTheLegacySingleHop() {
        let head = ProviderCascadeHop(
            position: 0, source: .environment,
            baseURL: "https://env.example/v1", bearer: "env-bearer"
        )
        XCTAssertEqual(ProviderCascade.plan(head: head, chain: []), [head])
    }

    /// Must produce byte-identical output to the server's copy (same helper), so an
    /// operator can line a `provider.cascade.fallback` audit row up against a
    /// `POST /v1/provider/link/test` entry for the same hop.
    func testEndpointLabelStripsCredentialsAndNeverLeaksTheBearer() {
        let hop = ProviderCascadeHop(
            position: 1, source: .chain,
            baseURL: "https://user:pw@provider.example.net:8443/v1?token=leak#frag",
            bearer: "sk-should-never-appear"
        )
        XCTAssertEqual(hop.endpointLabel, "https://provider.example.net:8443/v1")
        XCTAssertFalse(hop.endpointLabel.contains("pw"))
        XCTAssertFalse(hop.endpointLabel.contains("leak"))
        XCTAssertFalse(hop.endpointLabel.contains("sk-should-never-appear"))
    }

    // MARK: - Chain cache

    func testChainCacheServesTTLThenSkipsDecryptWhenUnchanged() async throws {
        let rows = [try storedEntry(position: 1, bearer: "sk-hop-one")]
        let reader = FakeChainReader([.success(rows), .success(rows)])
        let cache = ProviderChainCache()
        let t0 = ContinuousClock.now

        let first = await cache.resolve(
            masterKey: Self.key, ttl: .milliseconds(1000), now: t0,
            logger: logger, read: { try await reader.next() })
        // Inside the TTL: no read at all.
        let cached = await cache.resolve(
            masterKey: Self.key, ttl: .milliseconds(1000),
            now: t0.advanced(by: .milliseconds(200)),
            logger: logger, read: { try await reader.next() })
        // After the TTL: one read, unchanged fingerprint ⇒ same plan.
        let refreshed = await cache.resolve(
            masterKey: Self.key, ttl: .milliseconds(1000),
            now: t0.advanced(by: .milliseconds(1500)),
            logger: logger, read: { try await reader.next() })

        XCTAssertEqual(first.map(\.bearer), ["sk-hop-one"])
        XCTAssertEqual(cached.map(\.bearer), ["sk-hop-one"])
        XCTAssertEqual(refreshed.map(\.bearer), ["sk-hop-one"])
        let calls = await reader.callCount()
        XCTAssertEqual(calls, 2, "the in-TTL resolve must not touch the DB")
    }

    func testChainCacheReflectsAnOperatorEditAfterTheTTL() async throws {
        let before = [try storedEntry(position: 1, bearer: "sk-old", updatedAtMs: 100)]
        let after = [try storedEntry(position: 1, bearer: "sk-new", updatedAtMs: 200)]
        let reader = FakeChainReader([.success(before), .success(after)])
        let cache = ProviderChainCache()
        let t0 = ContinuousClock.now

        _ = await cache.resolve(
            masterKey: Self.key, ttl: .milliseconds(500), now: t0,
            logger: logger, read: { try await reader.next() })
        let updated = await cache.resolve(
            masterKey: Self.key, ttl: .milliseconds(500),
            now: t0.advanced(by: .milliseconds(900)),
            logger: logger, read: { try await reader.next() })
        XCTAssertEqual(updated.map(\.bearer), ["sk-new"])
    }

    func testChainCacheRetainsLastKnownOnTransientDBError() async throws {
        let rows = [try storedEntry(position: 1, bearer: "sk-known")]
        let reader = FakeChainReader([.success(rows), .failure(FakeChainDBError())])
        let cache = ProviderChainCache()
        let t0 = ContinuousClock.now

        _ = await cache.resolve(
            masterKey: Self.key, ttl: .milliseconds(500), now: t0,
            logger: logger, read: { try await reader.next() })
        let retained = await cache.resolve(
            masterKey: Self.key, ttl: .milliseconds(500),
            now: t0.advanced(by: .milliseconds(900)),
            logger: logger, read: { try await reader.next() })
        XCTAssertEqual(retained.map(\.bearer), ["sk-known"],
                       "a transient DB error must retain the last-known chain, not blank it")
    }

    func testChainCacheSkipsUndecryptableEntriesInsteadOfFailingTheChain() async throws {
        var poisoned = try storedEntry(position: 1, bearer: "sk-poisoned")
        poisoned.bearerCiphertext[poisoned.bearerCiphertext.count - 1] ^= 0xFF
        let healthy = try storedEntry(position: 2, bearer: "sk-healthy")
        let reader = FakeChainReader([.success([poisoned, healthy])])
        let cache = ProviderChainCache()

        let chain = await cache.resolve(
            masterKey: Self.key, ttl: .milliseconds(500),
            logger: logger, read: { try await reader.next() })
        XCTAssertEqual(chain.map(\.position), [2],
                       "an undecryptable hop is skipped; the rest of the chain still resolves")
    }

    // MARK: - Real 2-hop cascade over real sockets

    /// 무응답 → 2차 성공. Hop 1 accepts the request and hangs up without answering;
    /// hop 2 is a real SSE provider. The turn must complete with hop 2's text and
    /// record exactly one transition.
    ///
    /// The fixture hangs up rather than refusing the connection on purpose. A
    /// *refused* connection classifies identically (`provider_unreachable`) but
    /// AsyncHTTPClient retries connection establishment with backoff, so that
    /// variant takes ~30s to fall over — an upstream retry policy, not our
    /// contract, and not something a unit test should sit through.
    func testUnreachableFirstHopFallsOverToSecondHopAndCompletes() async throws {
        let silent = try MockProvider(behavior: .hangUp)
        let live = try MockProvider(behavior: .streamText("second provider answered"))
        defer { silent.shutdown(); live.shutdown() }

        let hops = [
            ProviderCascadeHop(position: 0, source: .providerLink,
                               baseURL: silent.baseURL, bearer: "sk-a"),
            ProviderCascadeHop(position: 1, source: .chain,
                               baseURL: live.baseURL, bearer: "sk-b"),
        ]
        let outcome = try await runCascade(hops: hops)

        XCTAssertEqual(outcome.text, "second provider answered")
        XCTAssertNil(outcome.thrownError, "the cascade must succeed on the second hop")
        XCTAssertEqual(outcome.fallbacks.count, 1)
        XCTAssertEqual(outcome.fallbacks.first?.from, 0)
        XCTAssertEqual(outcome.fallbacks.first?.to, 1)
        XCTAssertEqual(outcome.fallbacks.first?.reason, "provider_unreachable")
    }

    /// 5xx and 429 are the other two fall-over triggers; both must reach hop 2.
    func testServerErrorAndRateLimitFallOver() async throws {
        for (status, expectedReason) in [(503, "provider_status_503"), (429, "provider_rate_limited")] {
            let failing = try MockProvider(behavior: .status(status))
            let live = try MockProvider(behavior: .streamText("ok from hop 2"))
            defer { failing.shutdown(); live.shutdown() }

            let outcome = try await runCascade(hops: [
                ProviderCascadeHop(position: 0, source: .providerLink,
                                   baseURL: failing.baseURL, bearer: "sk-a"),
                ProviderCascadeHop(position: 1, source: .chain,
                                   baseURL: live.baseURL, bearer: "sk-b"),
            ])
            XCTAssertEqual(outcome.text, "ok from hop 2", "status \(status) must fall over")
            XCTAssertEqual(outcome.fallbacks.first?.reason, expectedReason)
        }
    }

    /// 401 → 전파. The second provider is healthy and MUST NOT be touched: a bad
    /// key fails identically there, and falling over would spend a second budget
    /// and hide the real cause.
    func testAuthFailureOnFirstHopPropagatesAndNeverTouchesSecondHop() async throws {
        let unauthorized = try MockProvider(behavior: .status(401))
        let live = try MockProvider(behavior: .streamText("must never be reached"))
        defer { unauthorized.shutdown(); live.shutdown() }

        let outcome = try await runCascade(hops: [
            ProviderCascadeHop(position: 0, source: .providerLink,
                               baseURL: unauthorized.baseURL, bearer: "sk-bad"),
            ProviderCascadeHop(position: 1, source: .chain,
                               baseURL: live.baseURL, bearer: "sk-good"),
        ])

        XCTAssertNotNil(outcome.thrownError, "a 401 must surface, not be swallowed")
        XCTAssertEqual(outcome.text, "")
        XCTAssertTrue(outcome.fallbacks.isEmpty, "a 4xx must not record a transition")
        let secondHopRequests = await live.requestCount()
        XCTAssertEqual(secondHopRequests, 0, "the second provider must never be spent on a 4xx")
    }

    /// With no chain configured the cascade is a single hop and a 5xx surfaces —
    /// identical to pre-MOMO-622 behavior.
    func testSingleHopChainSurfacesAvailabilityFailureWithoutFallback() async throws {
        let failing = try MockProvider(behavior: .status(503))
        defer { failing.shutdown() }

        let outcome = try await runCascade(hops: [
            ProviderCascadeHop(position: 0, source: .environment,
                               baseURL: failing.baseURL, bearer: "sk-only"),
        ])
        XCTAssertNotNil(outcome.thrownError)
        XCTAssertTrue(outcome.fallbacks.isEmpty)
    }

    // MARK: - Cascade driver

    private struct CascadeOutcome {
        var text: String
        var fallbacks: [FallbackRecord]
        var thrownError: (any Error)?
    }

    private func runCascade(hops: [ProviderCascadeHop]) async throws -> CascadeOutcome {
        let httpClient = HTTPClient(eventLoopGroupProvider: .singleton)
        let logger = self.logger
        let recorder = FallbackCollector()

        let stream = ProviderCascadeRunner.invoke(
            hops: hops,
            model: "test-model",
            messages: [HermesTransport.ChatMessage(role: "user", content: "hi")],
            tools: nil,
            maxTokens: 64,
            makeTransport: { hop in
                HermesTransport(
                    httpClient: httpClient, baseURL: hop.baseURL,
                    apiKey: hop.bearer, logger: logger
                )
            },
            onFallback: { from, to, reason in
                await recorder.record(
                    FallbackRecord(from: from.position, to: to.position, reason: reason)
                )
            }
        )

        var text = ""
        var thrown: (any Error)?
        do {
            for try await event in stream {
                if case .textDelta(let delta) = event { text += delta }
            }
        } catch {
            thrown = error
        }
        try? await httpClient.shutdown()
        return CascadeOutcome(
            text: text, fallbacks: await recorder.all(), thrownError: thrown
        )
    }

    // MARK: - Fixtures

    private func entry(
        position: Int,
        host: String,
        bearer: String = "sk-chain",
        enabled: Bool = true
    ) -> DecryptedProviderChainEntry {
        DecryptedProviderChainEntry(
            position: position,
            baseURL: "https://\(host).example/v1",
            bearer: bearer,
            mode: .externalHermes,
            enabled: enabled
        )
    }

    private func storedEntry(
        position: Int,
        bearer: String,
        enabled: Bool = true,
        updatedAtMs: Int64 = 1
    ) throws -> StoredProviderChainEntry {
        StoredProviderChainEntry(
            id: UUID(),
            position: position,
            baseURL: "https://hop\(position).example/v1",
            bearerCiphertext: try ProviderLinkCrypto.seal(bearer, masterKey: Self.key),
            mode: "external-hermes",
            enabled: enabled,
            updatedAtMs: updatedAtMs
        )
    }

}

private struct OpaqueTransportError: Error {}
private struct FakeChainDBError: Error {}

/// One recorded cascade transition (the unit test stand-in for the audit row +
/// outbox event `WorkerService.recordCascadeFallback` writes in production).
struct FallbackRecord: Sendable, Equatable {
    let from: Int
    let to: Int
    let reason: String
}

private actor FallbackCollector {
    private var records: [FallbackRecord] = []
    func record(_ value: FallbackRecord) { records.append(value) }
    func all() -> [FallbackRecord] { records }
}

// MARK: - In-process mock provider

/// A minimal OpenAI-compatible provider on a real socket.
///
/// The cascade's whole contract is "what does the transport do when the provider
/// misbehaves", so the tests exercise the real `HermesTransport` against a real
/// HTTP server rather than stubbing the transport out. Behaviors cover the three
/// fall-over triggers (5xx, 429, no response — the last one via a closed port)
/// and the propagate trigger (401).
final class MockProvider: @unchecked Sendable {
    enum Behavior: Sendable {
        /// Answer `POST /v1/chat/completions` with an SSE stream ending in [DONE].
        case streamText(String)
        /// Answer every request with this status and an empty JSON body.
        case status(Int)
        /// Accept the request and close the connection without answering — the
        /// "무응답" case, deterministic and immediate.
        case hangUp
    }

    private let group: MultiThreadedEventLoopGroup
    private let channel: any Channel
    private let counter = RequestCounter()
    let baseURL: String

    init(behavior: Behavior) throws {
        let group = MultiThreadedEventLoopGroup(numberOfThreads: 1)
        self.group = group
        let counter = self.counter
        channel = try ServerBootstrap(group: group)
            .serverChannelOption(ChannelOptions.backlog, value: 16)
            .serverChannelOption(ChannelOptions.socketOption(.so_reuseaddr), value: 1)
            .childChannelInitializer { channel in
                channel.pipeline.configureHTTPServerPipeline().flatMap {
                    channel.pipeline.addHandler(
                        MockProviderHandler(behavior: behavior, counter: counter)
                    )
                }
            }
            .bind(host: "127.0.0.1", port: 0)
            .wait()
        baseURL = "http://127.0.0.1:\(channel.localAddress?.port ?? 0)/v1"
    }

    func requestCount() async -> Int { await counter.value() }

    func shutdown() {
        try? channel.close().wait()
        try? group.syncShutdownGracefully()
    }
}

private actor RequestCounter {
    private var count = 0
    func increment() { count += 1 }
    func value() -> Int { count }
}

/// Confined to a single event loop by NIO's pipeline contract, so the unchecked
/// conformance the `childChannelInitializer` closure requires is safe here.
private final class MockProviderHandler: ChannelInboundHandler, @unchecked Sendable {
    typealias InboundIn = HTTPServerRequestPart
    typealias OutboundOut = HTTPServerResponsePart

    private let behavior: MockProvider.Behavior
    private let counter: RequestCounter

    init(behavior: MockProvider.Behavior, counter: RequestCounter) {
        self.behavior = behavior
        self.counter = counter
    }

    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        guard case .end = unwrapInboundIn(data) else { return }
        let counter = self.counter
        // Detached so the actor hop never blocks the event loop.
        Task.detached { await counter.increment() }

        switch behavior {
        case .hangUp:
            context.close(promise: nil)

        case .status(let code):
            let head = HTTPResponseHead(
                version: .http1_1,
                status: HTTPResponseStatus(statusCode: code),
                headers: ["Content-Type": "application/json", "Content-Length": "2"]
            )
            context.write(wrapOutboundOut(.head(head)), promise: nil)
            var body = context.channel.allocator.buffer(capacity: 2)
            body.writeString("{}")
            context.write(wrapOutboundOut(.body(.byteBuffer(body))), promise: nil)
            context.writeAndFlush(wrapOutboundOut(.end(nil)), promise: nil)

        case .streamText(let text):
            let chunk = """
            {"id":"c","object":"chat.completion.chunk","choices":\
            [{"delta":{"content":"\(text)"},"finish_reason":null}]}
            """
            let payload = "data: \(chunk)\n\ndata: [DONE]\n\n"
            let head = HTTPResponseHead(
                version: .http1_1,
                status: .ok,
                headers: [
                    "Content-Type": "text/event-stream",
                    "Content-Length": "\(payload.utf8.count)",
                ]
            )
            context.write(wrapOutboundOut(.head(head)), promise: nil)
            var body = context.channel.allocator.buffer(capacity: payload.utf8.count)
            body.writeString(payload)
            context.write(wrapOutboundOut(.body(.byteBuffer(body))), promise: nil)
            context.writeAndFlush(wrapOutboundOut(.end(nil)), promise: nil)
        }
    }
}

/// Sendable stub reader returning a queued sequence of results (repeating the
/// last), recording how many times it was called. Mirrors `FakeLinkReader`.
private actor FakeChainReader {
    private let responses: [Result<[StoredProviderChainEntry], any Error>]
    private var calls = 0
    init(_ responses: [Result<[StoredProviderChainEntry], any Error>]) {
        self.responses = responses
    }
    func next() throws -> [StoredProviderChainEntry] {
        calls += 1
        return try responses[min(calls - 1, responses.count - 1)].get()
    }
    func callCount() -> Int { calls }
}
