import Foundation
import Logging
import PostgresNIO

/// MOMO-622 / ADR-0135 D1 — the provider cascade, worker side.
///
/// MOMO-573 taught this process to resolve ONE provider per turn (the operator's
/// `provider_link`, else env). ADR-0135 D1 makes that a *chain*: position 0 is the
/// same legacy singleton (or env), and `provider_link_chain` (migration 042) adds
/// ordered fallback hops.
///
/// **Fall-over rule — the whole point of the ADR:** only a *provider-side
/// availability* failure advances to the next hop: no response at all, any 5xx, or
/// 429. Every other 4xx is a caller/config error (bad key, bad model, malformed
/// request) and MUST propagate — retrying it on a second provider spends a second
/// budget on the same guaranteed failure and hides the real cause from the operator.
///
/// This file mirrors `server/Sources/MomoServer/Provider/ProviderCascade.swift`.
/// The two packages share no module (exactly as `ProviderLinkCrypto` is mirrored),
/// so the rule is duplicated on purpose and both copies are unit-tested.

// MARK: - Classification

enum ProviderCascadeDecision: Sendable, Equatable {
    /// Provider-side availability failure — try the next hop and record the switch.
    case fallOver(reason: String)
    /// Caller/config error — surface it to the caller, never silently re-spend.
    case propagate(reason: String)

    var reason: String {
        switch self {
        case .fallOver(let reason), .propagate(let reason): return reason
        }
    }

    var isFallOver: Bool {
        if case .fallOver = self { return true }
        return false
    }
}

enum ProviderCascadeClassifier {
    /// Reason label for "the provider never answered" (connect refused, DNS
    /// failure, timeout, TLS error, dropped stream). Matches the server probe's
    /// credential-free vocabulary so probe results and cascade audit rows read
    /// the same.
    static let unreachableReason = "provider_unreachable"
    static let rateLimitedReason = "provider_rate_limited"
    /// The provider answered, but with something we could not parse. It answered,
    /// so it is not "무응답"; and it is not 5xx/429 — it does not fall over.
    static let undecodableReason = "provider_response_undecodable"

    /// `nil` status == no response at all.
    static func decide(status: Int?) -> ProviderCascadeDecision {
        guard let status else { return .fallOver(reason: unreachableReason) }
        if status == 429 { return .fallOver(reason: rateLimitedReason) }
        if (500...599).contains(status) {
            return .fallOver(reason: "provider_status_\(status)")
        }
        return .propagate(reason: "provider_status_\(status)")
    }

    /// Classify a transport failure thrown by `HermesTransport.invoke`.
    ///
    /// `TransportError.httpStatus` is the only case where we know the provider
    /// answered with a status; a decode failure means it answered unparseably;
    /// cancellation is ours, not the provider's; everything else (AsyncHTTPClient
    /// connect/timeout errors, NIO channel errors) is "no response".
    static func decide(error: any Error) -> ProviderCascadeDecision {
        if let transport = error as? HermesTransport.TransportError {
            switch transport {
            case .httpStatus(let code):
                return decide(status: code)
            }
        }
        if error is CancellationError {
            // A cancelled run must not spend a second provider's budget.
            return .propagate(reason: "cancelled")
        }
        if error is DecodingError {
            return .propagate(reason: undecodableReason)
        }
        return .fallOver(reason: unreachableReason)
    }
}

// MARK: - Hops

/// One resolved hop of the cascade, bearer included. Never serialize this type:
/// the bearer must not reach a log, an agent_job payload, an audit row, or the
/// cost ledger (ADR-0004 Rules #2 / #5).
struct ProviderCascadeHop: Sendable, Equatable {
    /// Where this hop's configuration came from — carried into the fallback audit
    /// row so an operator can tell the legacy singleton from a chain row.
    enum Source: String, Sendable {
        /// Position 0, from the `provider_link` singleton (migration 039).
        case providerLink = "provider_link"
        /// Position 0 with no usable DB row — the boot-time HERMES_* env trio.
        case environment
        /// Position >= 1, from `provider_link_chain` (migration 042).
        case chain
    }

    var position: Int
    var source: Source
    var baseURL: String
    var bearer: String

    /// A hop is usable only when URL and bearer both carry real content. A
    /// half-written hop is skipped rather than failing the turn blank (same
    /// fail-safe posture as `DecryptedProviderLink.isUsable`).
    var isUsable: Bool {
        !baseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !bearer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Credential-free endpoint label for logs, audit detail, and the run event.
    ///
    /// Deliberately the SAME helper the server's provider-link surface uses
    /// (`AgentProviderConfig.redactedEndpointLabel`): an operator comparing a
    /// `provider.cascade.fallback` audit row against `POST /v1/provider/link/test`
    /// must see the identical string for the same hop. Strips userinfo / query /
    /// fragment; never contains the bearer.
    var endpointLabel: String {
        AgentProviderValidation.redactedEndpointLabel(baseURL)
    }
}

// MARK: - Storage

/// One stored `provider_link_chain` row (bearer still ciphertext). Positions here
/// are always >= 1; position 0 is the legacy singleton (migration 042 header).
struct StoredProviderChainEntry: Sendable, Equatable {
    var id: UUID
    var position: Int
    var baseURL: String
    var bearerCiphertext: Data
    var mode: String
    var enabled: Bool
    var updatedAtMs: Int64
}

/// A chain entry with its bearer opened, ready to become a cascade hop.
struct DecryptedProviderChainEntry: Sendable, Equatable {
    var position: Int
    var baseURL: String
    var bearer: String
    var mode: AgentProviderMode
    var enabled: Bool
}

/// Read-only data access for the worker. Like `WorkerProviderLinkStore` this sets
/// no `app.provider_link_admin` GUC: the worker connects as the BYPASSRLS
/// `momo_worker` role and bypasses the operator-only RLS policy by design
/// (migration 042 §RLS anticipates exactly this reader).
enum WorkerProviderChainStore {
    static func read(
        pg: PostgresClient,
        logger: Logger
    ) async throws -> [StoredProviderChainEntry] {
        try await pg.withConnection { conn in
            let rows = try await conn.query(
                """
                SELECT id,
                       position,
                       base_url,
                       bearer_ciphertext,
                       mode,
                       enabled,
                       floor(extract(epoch from updated_at) * 1000)::bigint
                  FROM provider_link_chain
                 ORDER BY position ASC
                """,
                logger: logger
            ).collect()
            return try rows.map { row in
                // `bearer_ciphertext` is `bytea` — decode as `Data`, never
                // `[UInt8]` (which routes through PostgresNIO's Array conformance
                // and parses the value as a Postgres array wire format). Same trap
                // as MOMO-577.
                let decoded = try row.decode(
                    (UUID, Int, String, Data, String, Bool, Int64).self
                )
                return StoredProviderChainEntry(
                    id: decoded.0,
                    position: decoded.1,
                    baseURL: decoded.2,
                    bearerCiphertext: decoded.3,
                    mode: decoded.4,
                    enabled: decoded.5,
                    updatedAtMs: decoded.6
                )
            }
        }
    }

    /// Decrypt one stored entry. An entry whose ciphertext cannot be opened (e.g.
    /// the master key was rotated without re-configuring) is treated as absent so
    /// the cascade skips that hop instead of failing the whole chain.
    static func decrypt(
        _ stored: StoredProviderChainEntry,
        masterKey: String
    ) -> DecryptedProviderChainEntry? {
        guard let bearer = try? ProviderLinkCrypto.open(
            stored.bearerCiphertext, masterKey: masterKey
        ) else { return nil }
        return DecryptedProviderChainEntry(
            position: stored.position,
            baseURL: stored.baseURL,
            bearer: bearer,
            mode: AgentProviderMode.parse(stored.mode),
            enabled: stored.enabled
        )
    }
}

// MARK: - Planning

enum ProviderCascade {
    /// Build the hop list a turn should attempt: the already-resolved position-0
    /// head, then the enabled+usable chain entries in ascending position order.
    ///
    /// The head is passed in already resolved (DB-over-env, see
    /// `ProviderLinkResolution`) and is **never filtered out** — dropping it would
    /// change MOMO-573 behavior for every instance that has no chain configured.
    /// Only fallback hops are screened.
    static func plan(
        head: ProviderCascadeHop,
        chain: [DecryptedProviderChainEntry]
    ) -> [ProviderCascadeHop] {
        var hops = [head]
        for entry in chain.sorted(by: { $0.position < $1.position }) where entry.enabled {
            let hop = ProviderCascadeHop(
                position: entry.position,
                source: .chain,
                baseURL: entry.baseURL,
                bearer: entry.bearer
            )
            if hop.isUsable { hops.append(hop) }
        }
        return hops
    }

    /// What to do after a hop failed. Pure, so the whole fall-over rule is
    /// unit-testable without a network, a database, or a running worker.
    static func step(
        failure: any Error,
        emittedContent: Bool,
        hasNextHop: Bool
    ) -> ProviderCascadeStep {
        let decision = ProviderCascadeClassifier.decide(error: failure)
        guard decision.isFallOver else {
            // 4xx / cancelled / unparseable — the second provider would fail the
            // same way, or the failure is ours. Surface it.
            return .surface(reason: decision.reason)
        }
        guard !emittedContent else {
            // The run has already published partial output from this hop. Re-running
            // the prompt elsewhere would duplicate it in the timeline, so an
            // availability failure mid-stream is surfaced instead of retried.
            return .surface(reason: "content_already_emitted")
        }
        guard hasNextHop else {
            // Last hop: nowhere to fall over to.
            return .surface(reason: decision.reason)
        }
        return .fallOver(reason: decision.reason)
    }
}

/// Outcome of `ProviderCascade.step`.
enum ProviderCascadeStep: Sendable, Equatable {
    /// Record the transition and attempt the next hop.
    case fallOver(reason: String)
    /// Surface the failure to the run; no further hop is attempted.
    case surface(reason: String)
}

/// The typed boundary between the cascade and `WorkerService`.
///
/// A cascade decision is a safety decision, not merely a log message: collapsing
/// it into `String(describing: error)` made a bad credential indistinguishable
/// from every provider being unavailable, and the worker retried both. Keep the
/// original error for diagnostics (notably the HTTP status), while carrying the
/// terminal disposition that the worker must obey.
struct ProviderCascadeFailure: Error, @unchecked Sendable, CustomStringConvertible {
    enum Disposition: String, Sendable, Equatable {
        /// 4xx, cancellation, or an undecodable response: do not retry this job.
        case propagate
        /// A hop emitted durable-looking content before failing: do not replay it.
        case contentAlreadyEmitted = "content_already_emitted"
        /// Every usable hop was unavailable: this is the sole retryable outcome.
        case availabilityExhausted = "availability_exhausted"
        /// The chain exhausted its turn-wide wall-clock allowance.
        case totalBudgetExceeded = "total_budget_exceeded"
    }

    let reason: String
    let disposition: Disposition
    /// Kept intact so run diagnostics retain the original HTTP status/error.
    let underlying: (any Error)?

    var description: String {
        let cause = underlying.map { ": \(String(describing: $0))" } ?? ""
        return "provider cascade \(disposition.rawValue) (\(reason))\(cause)"
    }
}

/// The worker's terminal rule is deliberately pure and testable without a
/// database: only a fully exhausted availability cascade may be requeued.
enum ProviderCascadeJobDisposition: Sendable, Equatable {
    case markFailed
    case requeue

    static func resolve(_ failure: (any Error)?) -> ProviderCascadeJobDisposition {
        guard let cascade = failure as? ProviderCascadeFailure,
              cascade.disposition == .availabilityExhausted
        else { return .markFailed }
        return .requeue
    }
}

/// Drives a turn across the cascade. Kept free of `WorkerService`'s Postgres /
/// Centrifugo dependencies so the fall-over behavior can be measured against real
/// HTTP providers in unit tests; `WorkerService.cascadingInvoke` supplies the
/// transport factory and the audit/outbox recorder.
enum ProviderCascadeRunner {
    typealias TransportFactory = @Sendable (ProviderCascadeHop) -> HermesTransport
    /// Called with (from, to, reason) before the next hop is attempted. Must not
    /// throw: bookkeeping failure may not fail a turn the next provider will serve.
    typealias FallbackRecorder =
        @Sendable (ProviderCascadeHop, ProviderCascadeHop, String) async -> Void

    static func invoke(
        hops: [ProviderCascadeHop],
        model: String,
        messages: [HermesTransport.ChatMessage],
        tools: JSONValue?,
        maxTokens: Int?,
        /// A turn-wide deadline, not a per-hop timeout. A new hop only receives
        /// the remaining allowance, so a long chain cannot multiply occupancy.
        totalTimeout: Duration = .seconds(60),
        makeTransport: @escaping TransportFactory,
        onFallback: @escaping FallbackRecorder
    ) -> AsyncThrowingStream<AgentEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                let clock = ContinuousClock()
                let startedAt = clock.now
                var index = 0
                while index < hops.count {
                    let elapsed = startedAt.duration(to: clock.now)
                    guard elapsed < totalTimeout else {
                        continuation.finish(throwing: ProviderCascadeFailure(
                            reason: "provider_cascade_total_timeout",
                            disposition: .totalBudgetExceeded,
                            underlying: nil
                        ))
                        return
                    }
                    let hop = hops[index]
                    // A transport-authored `.error` is held back: if this hop turns
                    // out to be a fall-over, that error is superseded by the next
                    // attempt and must never reach the run.
                    var heldError: String?
                    var emittedContent = false
                    var failure: (any Error)?

                    do {
                        let remaining = totalTimeout - elapsed
                        let stream = makeTransport(hop).invoke(
                            model: model, messages: messages,
                            tools: tools, maxTokens: maxTokens,
                            timeout: remaining
                        )
                        for try await event in stream {
                            switch event {
                            case .error(let message):
                                heldError = message
                            case .textDelta, .toolCall, .usage, .finished:
                                emittedContent = true
                                continuation.yield(event)
                            case .status:
                                continuation.yield(event)
                            }
                        }
                    } catch {
                        failure = error
                    }

                    guard let failure else {
                        // Hop completed. Surface any trailing transport error it
                        // reported without throwing, then finish.
                        if let heldError { continuation.yield(.error(heldError)) }
                        continuation.finish()
                        return
                    }

                    // The in-flight request is given only the remaining allowance,
                    // but it may report its timeout as a generic transport error.
                    // Preserve the stricter turn-wide semantic at this boundary.
                    guard startedAt.duration(to: clock.now) < totalTimeout else {
                        continuation.finish(throwing: ProviderCascadeFailure(
                            reason: "provider_cascade_total_timeout",
                            disposition: .totalBudgetExceeded,
                            underlying: failure
                        ))
                        return
                    }

                    let next = index + 1
                    switch ProviderCascade.step(
                        failure: failure,
                        emittedContent: emittedContent,
                        hasNextHop: next < hops.count
                    ) {
                    case .fallOver(let reason):
                        await onFallback(hop, hops[next], reason)
                        index = next
                    case .surface(let reason):
                        if let heldError { continuation.yield(.error(heldError)) }
                        let decision = ProviderCascadeClassifier.decide(error: failure)
                        let disposition: ProviderCascadeFailure.Disposition
                        if emittedContent {
                            disposition = .contentAlreadyEmitted
                        } else if decision.isFallOver {
                            disposition = .availabilityExhausted
                        } else {
                            disposition = .propagate
                        }
                        continuation.finish(throwing: ProviderCascadeFailure(
                            reason: reason,
                            disposition: disposition,
                            underlying: failure
                        ))
                        return
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

// MARK: - Cache

/// Short-TTL cache in front of the per-job `provider_link_chain` read + decrypt,
/// mirroring `ProviderLinkCache`.
///
/// Reading and (especially) AES-GCM-decrypting every hop on *every* job would add
/// load to a hot path, so this actor serves a cached plan for a short TTL, and
/// after the TTL re-reads but skips the decrypt entirely when the chain's
/// fingerprint (positions + enabled flags + updated_at) is unchanged. An operator
/// edit is therefore picked up on the first job after the TTL window, never
/// requiring a worker restart. On a transient DB error the last-known chain is
/// retained (fail safe, not fail blank).
actor ProviderChainCache {
    typealias Reader = @Sendable () async throws -> [StoredProviderChainEntry]

    private struct Entry {
        var chain: [DecryptedProviderChainEntry]
        var fingerprint: String
        var fetchedAt: ContinuousClock.Instant
    }

    private var entry: Entry?

    /// Cheap change key: any add/remove/reorder/park/edit moves `updated_at` or the
    /// position set, so this catches every operator edit without a decrypt.
    private static func fingerprint(_ rows: [StoredProviderChainEntry]) -> String {
        rows
            .map { "\($0.id.uuidString.lowercased()):\($0.position):\($0.enabled):\($0.updatedAtMs)" }
            .joined(separator: "|")
    }

    func resolve(
        masterKey: String,
        ttl: Duration,
        now: ContinuousClock.Instant = ContinuousClock.now,
        logger: Logger,
        read: Reader
    ) async -> [DecryptedProviderChainEntry] {
        if let cached = entry, now - cached.fetchedAt < ttl {
            return cached.chain
        }

        let rows: [StoredProviderChainEntry]
        do {
            rows = try await read()
        } catch {
            // Transient DB error → keep serving the last-known chain (throttled to
            // the TTL cadence so we don't hammer a struggling DB), else no chain.
            logger.warning("provider_link_chain read failed; retaining last-known", metadata: [
                "error": .string(String(describing: error)),
            ])
            if entry != nil {
                entry?.fetchedAt = now
                return entry?.chain ?? []
            }
            return []
        }

        let fingerprint = Self.fingerprint(rows)
        if let cached = entry, cached.fingerprint == fingerprint {
            entry?.fetchedAt = now
            return cached.chain
        }

        var decrypted: [DecryptedProviderChainEntry] = []
        for row in rows {
            guard let opened = WorkerProviderChainStore.decrypt(row, masterKey: masterKey) else {
                logger.warning(
                    "provider_link_chain entry could not be decrypted (PROVIDER_LINK_MASTER_KEY mismatch?); skipping hop",
                    metadata: ["position": .stringConvertible(row.position)]
                )
                continue
            }
            decrypted.append(opened)
        }
        entry = Entry(chain: decrypted, fingerprint: fingerprint, fetchedAt: now)
        return decrypted
    }

    /// Test hook: drop cached state.
    func reset() {
        entry = nil
    }
}
