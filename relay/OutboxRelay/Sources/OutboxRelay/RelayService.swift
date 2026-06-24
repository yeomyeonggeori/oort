import AsyncHTTPClient
import Foundation
import Logging
import NIOCore
import PostgresNIO
import ServiceLifecycle

/// The outbox relay loop (L4 §1.1 / §8.1).
///
/// Hot path, per iteration:
///   1. Claim a batch of pending `kind='broadcast'` rows with
///      `SELECT ... FOR UPDATE SKIP LOCKED` and flip them to `processing` in the
///      SAME tx (claim is loss-free: SKIP LOCKED depends only on commit
///      visibility, so an in-flight write tx can never be skipped permanently —
///      a high-water-mark cursor WOULD lose rows, hence forbidden, L4 §3.5).
///   2. For each claimed row, POST Centrifugo `/api/publish` with
///      `version = seq` + `idempotency_key` (Centrifugo dedups → the relay's
///      at-least-once delivery is safe, L4 §4.3).
///   3. On success → `status='done'`, `processed_at=now()`. On transient failure
///      → back to `pending` with exponential backoff (`available_at`); after
///      `maxAttempts` → `status='failed'`.
///
/// Wakeups: a dedicated LISTEN connection on the `outbox` channel (the schema's
/// `outbox_notify_trg` AFTER INSERT trigger fires `pg_notify('outbox', kind)`)
/// gives sub-second latency; a `pollInterval` (300ms, spec) ticker is the
/// fallback so the relay drains even if a NOTIFY is missed (L4 §8.1).
///
/// runtime-unverified (no docker/psql): SQL + request shapes match schema_v0 /
/// Centrifugo v6 but are not exercised against a live DB/broker in this env.
/// `swift build` is the verification gate for this package.
struct RelayService: Service {
    let pg: PostgresClient
    let centrifugo: CentrifugoClient
    let config: Config
    let logger: Logger

    private static let decoder = JSONDecoder()

    func run() async throws {
        // Duration → whole milliseconds for the startup log line.
        let c = config.pollInterval.components
        let pollMs = c.seconds * 1000 + c.attoseconds / 1_000_000_000_000_000
        logger.info("outbox relay starting", metadata: [
            "pollIntervalMs": .stringConvertible(pollMs),
            "claimBatch": .stringConvertible(config.claimBatchSize),
        ])

        // A bounded wake channel coalesces NOTIFY signals + poll ticks into the
        // single drain loop. Buffer of 1 (bufferingNewest) means a burst of wakes
        // collapses to "one drain pending" — and each drain runs to empty, so no
        // row is left behind by the collapse (L4 §8.1 loss-free relay).
        let (wakes, wakeContinuation) = AsyncStream.makeStream(
            of: Void.self, bufferingPolicy: .bufferingNewest(1))

        try await withThrowingTaskGroup(of: Void.self) { group in
            // --- poll fallback ticker (300ms) ---
            group.addTask {
                while !Task.isCancelled {
                    wakeContinuation.yield(())
                    try? await Task.sleep(for: config.pollInterval)
                }
            }

            // --- LISTEN/NOTIFY wakeups (best-effort; poll covers gaps) ---
            group.addTask {
                await listenLoop(wake: wakeContinuation)
            }

            // --- drain loop: the only thing that touches the hot path ---
            group.addTask {
                for await _ in wakes {
                    if Task.isCancelled { break }
                    await drainToEmpty()
                }
            }

            // Cooperate with graceful shutdown: cancel the group on SIGTERM/SIGINT.
            group.addTask {
                try? await gracefulShutdown()
                wakeContinuation.finish()
            }

            try await group.next()
            group.cancelAll()
        }
    }

    // MARK: - LISTEN/NOTIFY

    /// Hold a dedicated connection LISTENing on `outbox`; each notification nudges
    /// the drain loop. Reconnects with a short backoff if the connection drops so
    /// a transient DB blip degrades to poll-only, never crashes the relay.
    private func listenLoop(wake: AsyncStream<Void>.Continuation) async {
        while !Task.isCancelled {
            do {
                try await pg.withConnection { conn in
                    try await conn.listen(on: "outbox") { notifications in
                        for try await note in notifications {
                            logger.debug("outbox NOTIFY", metadata: [
                                "kind": .string(note.payload),
                            ])
                            wake.yield(())
                            if Task.isCancelled { break }
                        }
                    }
                }
            } catch {
                if Task.isCancelled { return }
                logger.warning("LISTEN connection lost; relying on poll fallback", metadata: [
                    "error": .string(String(describing: error)),
                ])
                // Back off before re-establishing LISTEN. Poll still drains rows.
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    // MARK: - Drain

    /// Claim + publish until a claim returns 0 rows (the outbox is drained for now).
    private func drainToEmpty() async {
        while !Task.isCancelled {
            do {
                let claimed = try await claimBatch()
                if claimed.isEmpty { return }
                for row in claimed {
                    await processClaimed(row)
                }
                // If we filled the batch there may be more — loop again immediately.
                if claimed.count < config.claimBatchSize { return }
            } catch {
                logger.error("relay drain iteration failed", metadata: [
                    "error": .string(String(describing: error)),
                ])
                return   // next poll tick retries
            }
        }
    }

    /// A claimed outbox row ready to publish.
    private struct ClaimedRow: Sendable {
        let id: Int64
        let attempts: Int
        let rawPayload: String
    }

    /// L4 §3.5 / §8.1: claim pending broadcast rows and flip them to `processing`
    /// in a single transaction with `FOR UPDATE SKIP LOCKED`.
    private func claimBatch() async throws -> [ClaimedRow] {
        try await pg.withTransaction(logger: logger) { conn in
            let rows = try await conn.query(
                """
                WITH claimed AS (
                  SELECT id FROM outbox
                   WHERE kind = 'broadcast'
                     AND status = 'pending'
                     AND available_at <= now()
                   ORDER BY id
                   FOR UPDATE SKIP LOCKED
                   LIMIT \(config.claimBatchSize)
                )
                UPDATE outbox o
                   SET status = 'processing', attempts = o.attempts + 1
                  FROM claimed c
                 WHERE o.id = c.id
                 RETURNING o.id, o.attempts, o.payload::text
                """,
                logger: logger
            ).collect()

            return try rows.map { row in
                let (id, attempts, payload) = try row.decode((Int64, Int, String).self)
                return ClaimedRow(id: id, attempts: attempts, rawPayload: payload)
            }
        }
    }

    /// Publish one claimed row and settle its terminal/retry status.
    private func processClaimed(_ row: ClaimedRow) async {
        let payload: BroadcastPayload
        do {
            payload = try Self.decoder.decode(
                BroadcastPayload.self,
                from: Data(row.rawPayload.utf8))
        } catch {
            // Malformed payload can never succeed → fail it permanently (no poison
            // loop). Keeps the row for postmortem rather than silently dropping.
            logger.error("outbox payload decode failed; marking failed", metadata: [
                "outboxId": .stringConvertible(row.id),
                "error": .string(String(describing: error)),
            ])
            await markFailed(row.id, reason: "payload decode: \(error)")
            return
        }

        do {
            let result = try await centrifugo.publish(payload)
            switch result {
            case .ok:
                await markDone(row.id)
                logger.debug("published", metadata: [
                    "outboxId": .stringConvertible(row.id),
                    "channel": .string(payload.channel),
                    "seq": .stringConvertible(payload.version ?? -1),
                ])
            case .permanentFailure(let reason):
                logger.error("permanent publish failure; marking failed", metadata: [
                    "outboxId": .stringConvertible(row.id), "reason": .string(reason),
                ])
                await markFailed(row.id, reason: reason)
            case .transientFailure(let reason):
                await requeue(row, reason: reason)
            }
        } catch {
            // Network/timeout = transient → requeue with backoff.
            await requeue(row, reason: "publish threw: \(error)")
        }
    }

    // MARK: - Status transitions

    private func markDone(_ id: Int64) async {
        await runUpdate(
            "UPDATE outbox SET status='done', processed_at=now(), last_error=NULL WHERE id=\(id)",
            context: "markDone(\(id))")
    }

    private func markFailed(_ id: Int64, reason: String) async {
        await runUpdate(
            "UPDATE outbox SET status='failed', last_error=\(reason), processed_at=now() WHERE id=\(id)",
            context: "markFailed(\(id))")
    }

    /// Transient failure: either retry with exponential backoff, or give up after
    /// `maxAttempts` (deterministic — `attempts` was already incremented on claim).
    private func requeue(_ row: ClaimedRow, reason: String) async {
        if row.attempts >= config.maxAttempts {
            logger.error("max attempts reached; marking failed", metadata: [
                "outboxId": .stringConvertible(row.id),
                "attempts": .stringConvertible(row.attempts),
                "reason": .string(reason),
            ])
            await markFailed(row.id, reason: "max attempts: \(reason)")
            return
        }
        // Exponential backoff capped at 60s: 1,2,4,8,...s from now().
        let backoffSeconds = min(Int(pow(2.0, Double(row.attempts))), 60)
        logger.warning("transient publish failure; requeueing", metadata: [
            "outboxId": .stringConvertible(row.id),
            "attempts": .stringConvertible(row.attempts),
            "backoffSeconds": .stringConvertible(backoffSeconds),
            "reason": .string(reason),
        ])
        await runUpdate(
            """
            UPDATE outbox
               SET status='pending',
                   available_at = now() + (\(backoffSeconds) * interval '1 second'),
                   last_error = \(reason)
             WHERE id = \(row.id)
            """,
            context: "requeue(\(row.id))")
    }

    /// Run a fire-and-log status update. A status-write failure is logged but not
    /// fatal: a stuck `processing` row is reclaimable by a sweeper, and the
    /// idempotency_key makes a re-publish harmless (at-least-once, L4 §4.3).
    private func runUpdate(_ query: PostgresQuery, context: String) async {
        do {
            _ = try await pg.query(query, logger: logger)
        } catch {
            logger.error("outbox status update failed", metadata: [
                "op": .string(context),
                "error": .string(String(describing: error)),
            ])
        }
    }
}
