import AsyncHTTPClient
import Foundation
import Logging
import MomoMetrics
import NIOCore
import OutboundHTTPPolicy
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
/// Runtime verification status is tracked in STATUS.md. Keep the hot path
/// aligned with schema_v0.sql: outbox rows carry the Centrifugo publish contract.
struct RelayService: Service {
    let pg: PostgresClient
    let centrifugo: CentrifugoClient
    let webhooks: any WebhookDelivering
    let metrics: MetricsRegistry
    let config: Config
    let logger: Logger

    private static let decoder = JSONDecoder()
    private static let webhookEncoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()

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
                    await refreshOutboxLagGauge()
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
        let kind: String
        let attempts: Int
        let rawPayload: String
        let createdAt: Date
    }

    /// L4 §3.5 / §8.1: claim pending broadcast rows and flip them to `processing`
    /// in a single transaction with `FOR UPDATE SKIP LOCKED`.
    private func claimBatch() async throws -> [ClaimedRow] {
        try await pg.withTransaction(logger: logger) { conn in
            let rows = try await conn.query(
                """
                WITH claimed AS (
                  SELECT id FROM outbox
                   WHERE kind IN ('broadcast', 'webhook_delivery')
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
                 RETURNING o.id, o.kind::text, o.attempts, o.payload::text,
                           o.created_at
                """,
                logger: logger
            ).collect()

            return try rows.map { row in
                let (id, kind, attempts, payload, createdAt) = try row.decode(
                    (Int64, String, Int, String, Date).self
                )
                return ClaimedRow(
                    id: id,
                    kind: kind,
                    attempts: attempts,
                    rawPayload: payload,
                    createdAt: createdAt
                )
            }
        }
    }

    /// Publish one claimed row and settle its terminal/retry status.
    private func processClaimed(_ row: ClaimedRow) async {
        if row.kind == "webhook_delivery" {
            await processWebhook(row)
            return
        }
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
                await metrics.observeHistogram(
                    name: MomoMetricName.outboxPublishLatencySeconds,
                    value: Date().timeIntervalSince(row.createdAt)
                )
                await markDone(row.id)
                logger.debug("published", metadata: [
                    "outboxId": .stringConvertible(row.id),
                    "channel": .string(payload.channel),
                    "version": .stringConvertible(payload.version ?? -1),
                    "idempotencyKey": .string(payload.idempotencyKey ?? ""),
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

    /// D10: refresh the aggregate DB-derived gauge on every poll/NOTIFY wake.
    /// No tenant, row, or content value is projected into the metric.
    private func refreshOutboxLagGauge() async {
        do {
            let age: Double = try await pg.withConnection { conn in
                let rows = try await conn.query(
                    """
                    SELECT COALESCE(
                      EXTRACT(EPOCH FROM (clock_timestamp() - MIN(created_at))),
                      0
                    )::double precision
                      FROM outbox
                     WHERE kind = 'broadcast' AND status = 'pending'
                    """,
                    logger: logger
                ).collect()
                guard let first = rows.first else { return 0 }
                return try first.decode(Double.self)
            }
            await metrics.setGauge(
                name: MomoMetricName.outboxPendingOldestAgeSeconds,
                value: age
            )
        } catch {
            logger.warning("outbox lag gauge refresh failed", metadata: [
                "error": .string(String(describing: error)),
            ])
        }
    }

    private struct WebhookSubscription: Sendable {
        let id: UUID
        let workspaceID: UUID
        let url: URL
        let secretRef: String
        let enabled: Bool
    }

    private func processWebhook(_ row: ClaimedRow) async {
        let payload: WebhookDeliveryPayload
        do {
            payload = try Self.decoder.decode(
                WebhookDeliveryPayload.self, from: Data(row.rawPayload.utf8)
            )
            guard payload.schema == "momo.webhook_delivery.v1" else {
                throw DecodingError.dataCorrupted(
                    .init(codingPath: [], debugDescription: "unsupported webhook schema")
                )
            }
        } catch {
            await markFailed(row.id, reason: "webhook payload decode: \(error)")
            return
        }

        let subscription: WebhookSubscription?
        do { subscription = try await fetchWebhookSubscription(payload.subscriptionID) }
        catch {
            await requeue(row, reason: "subscription lookup failed")
            return
        }
        guard let subscription else {
            await markDone(row.id, reason: "subscription missing")
            return
        }
        guard subscription.enabled else {
            await markDone(row.id, reason: "subscription disabled")
            return
        }
        let eventKind = Self.eventKind(payload.event) ?? "unknown"
        let body: Data
        do { body = try Self.webhookEncoder.encode(payload.event) }
        catch {
            await markFailed(row.id, reason: "webhook event encode: \(error)")
            return
        }
        let secret = SafeWebhookDeliveryClient<SystemOutboundHostResolver, AsyncWebhookHTTPTransport>
            .derivedSecret(
                masterKey: config.webhookSigningMasterKey,
                secretRef: subscription.secretRef
            )
        let result = await webhooks.deliver(
            url: subscription.url,
            deliveryID: String(row.id),
            eventKind: eventKind,
            secret: secret,
            body: body
        )

        // 이슈 #1204 — 나간 사실을 남긴다. 이 한 줄이 없으면 멘션·승인요청의
        // **본문**이 외부 주소로 나가고도 워크스페이스에 아무 흔적이 없다(그것이
        // #1203 이 실측한 상태다). 감사 자체가 두 번째 유출 경로가 되지 않도록,
        // 남는 것은 시각·구독·이벤트 종류·대상 **호스트**뿐이고 본문은 없다 —
        // 그 규율은 `record_event_subscription_delivery` 의 시그니처가 들고 있다
        // (063_event_subscription_delivery_audit.sql). 여기서 넘길 수 있는 것에
        // 본문이 없다는 사실이 곧 그 계약이다.
        await recordWebhookDeliveryAudit(
            row,
            subscription: subscription,
            payload: payload,
            eventKind: eventKind,
            result: result
        )

        switch result {
        case .ok:
            await markWebhookDone(row.id, subscriptionID: subscription.id)
        case .transientServerFailure(let status):
            await recordWebhookServerFailure(
                row, subscription: subscription, status: status
            )
        case .transientFailure(let reason, _):
            await requeue(row, reason: reason)
        case .permanentFailure(let reason, _):
            await markFailed(row.id, reason: reason)
        }
    }

    private func fetchWebhookSubscription(_ id: UUID) async throws -> WebhookSubscription? {
        let rows = try await pg.query(
            """
            SELECT id, workspace_id, url, secret_ref, enabled
              FROM event_subscription
             WHERE id = \(id)
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else { return nil }
        let decoded = try row.decode((UUID, UUID, String, String, Bool).self)
        guard let url = URL(string: decoded.2) else { return nil }
        return WebhookSubscription(
            id: decoded.0, workspaceID: decoded.1, url: url,
            secretRef: decoded.3, enabled: decoded.4
        )
    }

    private static func eventKind(_ event: AnyJSON) -> String? {
        guard case .object(let object) = event,
              case .string(let kind) = object["kind"] else { return nil }
        return kind
    }

    /// The source row this event was projected from (`033`'s `event.id`). It is
    /// an identifier, not content — the audit ledger can name what left without
    /// quoting it, which is the whole shape of the #1204 decision.
    static func eventID(_ event: AnyJSON) -> UUID? {
        guard case .object(let object) = event,
              case .string(let raw) = object["id"] else { return nil }
        return UUID(uuidString: raw)
    }

    // MARK: - Egress audit (#1204)

    /// Write the one durable trace that a webhook payload left this workspace.
    ///
    /// Deliberately **outside** the settlement transactions. The settlement says
    /// what the queue should do next; this says what already happened on the
    /// wire, and the wire call has already returned by the time either runs. If
    /// it shared the settlement transaction, a rollback caused by a queue-side
    /// conflict would erase the record of an egress that really occurred — the
    /// exact inversion of the atomicity argument that puts a *pre*-commit audit
    /// inside its action's transaction. A failure to write it is loud (error
    /// log) and never blocks settlement: the payload is already gone, and
    /// pretending otherwise by retrying the send would be worse than a gap.
    ///
    /// No status = nothing measurably left (SSRF refusal, or a throw before any
    /// answer) → no row. See `WebhookDeliveryResult.deliveredStatus`.
    private func recordWebhookDeliveryAudit(
        _ row: ClaimedRow,
        subscription: WebhookSubscription,
        payload: WebhookDeliveryPayload,
        eventKind: String,
        result: WebhookDeliveryResult
    ) async {
        guard let status = result.deliveredStatus else { return }
        // `URL.host` and nothing more. Path and query can carry a token the
        // subscriber put there, and those belong in the ledger no more than the
        // body does.
        let host = subscription.url.host ?? "unknown"
        let eventID = Self.eventID(payload.event)
        do {
            _ = try await pg.query(
                """
                SELECT record_event_subscription_delivery(
                  \(subscription.workspaceID)::uuid, \(subscription.id)::uuid,
                  \(eventKind)::text, \(eventID)::uuid, \(host)::text,
                  \(row.id)::bigint, \(row.attempts)::integer, \(status)::integer
                )
                """,
                logger: logger
            ).collect()
        } catch {
            logger.error("webhook delivery audit write failed", metadata: [
                "outboxId": .stringConvertible(row.id),
                "subscriptionId": .string(subscription.id.uuidString),
                "error": .string(String(describing: error)),
            ])
        }
    }

    // MARK: - Status transitions

    private func markDone(_ id: Int64, reason: String? = nil) async {
        await runUpdate(
            "UPDATE outbox SET status='done', processed_at=now(), last_error=\(reason) WHERE id=\(id)",
            context: "markDone(\(id))")
    }

    private func markWebhookDone(_ id: Int64, subscriptionID: UUID) async {
        do {
            try await pg.withTransaction(logger: logger) { conn in
                _ = try await conn.query(
                    """
                    UPDATE event_subscription
                       SET delivery_failure_count = 0,
                           updated_at = CASE
                             WHEN delivery_failure_count = 0 THEN updated_at
                             ELSE clock_timestamp()
                           END
                     WHERE id = \(subscriptionID) AND enabled
                    """,
                    logger: logger
                )
                _ = try await conn.query(
                    """
                    UPDATE outbox
                       SET status='done', processed_at=now(), last_error=NULL
                     WHERE id=\(id)
                    """,
                    logger: logger
                )
            }
        } catch {
            logger.error("webhook success settlement failed", metadata: [
                "outboxId": .stringConvertible(id),
                "error": .string(String(describing: error)),
            ])
        }
    }

    private func recordWebhookServerFailure(
        _ row: ClaimedRow,
        subscription: WebhookSubscription,
        status: Int
    ) async {
        let backoffSeconds = min(Int(pow(2.0, Double(row.attempts))), 60)
        let serverError = "HTTP \(status)"
        let disableError = "webhook auto-disabled after HTTP \(status)"
        let maxAttemptsError = "max attempts: HTTP \(status)"
        do {
            try await pg.withTransaction(logger: logger) { conn in
                let rows = try await conn.query(
                    """
                    SELECT delivery_failure_count, enabled
                      FROM event_subscription
                     WHERE id = \(subscription.id)
                     FOR UPDATE
                    """,
                    logger: logger
                ).collect()
                guard let current = rows.first else {
                    _ = try await conn.query(
                        "UPDATE outbox SET status='done', processed_at=now(), last_error='subscription missing' WHERE id=\(row.id)",
                        logger: logger
                    )
                    return
                }
                let (failureCount, enabled) = try current.decode((Int, Bool).self)
                guard enabled else {
                    _ = try await conn.query(
                        "UPDATE outbox SET status='done', processed_at=now(), last_error='subscription disabled' WHERE id=\(row.id)",
                        logger: logger
                    )
                    return
                }
                let next = failureCount + 1
                if next >= config.webhookDisableAfterServerFailures {
                    _ = try await conn.query(
                        """
                        UPDATE event_subscription
                           SET enabled = false,
                               delivery_failure_count = \(next),
                               disabled_at = clock_timestamp(),
                               disabled_reason = 'server_5xx_threshold',
                               updated_at = clock_timestamp()
                         WHERE id = \(subscription.id)
                        """,
                        logger: logger
                    )
                    _ = try await conn.query(
                        """
                        INSERT INTO audit_log
                          (workspace_id, action, target_type, target_id, detail)
                        VALUES
                          (\(subscription.workspaceID), 'event_subscription.auto_disabled',
                           'event_subscription', \(subscription.id),
                           jsonb_build_object(
                             'schema', 'momo.event_subscription.auto_disabled.v1',
                             'failure_count', \(next),
                             'last_status', \(status),
                             'outbox_id', \(row.id)
                           ))
                        """,
                        logger: logger
                    )
                    _ = try await conn.query(
                        """
                        UPDATE outbox
                           SET status='failed', processed_at=now(),
                               last_error=\(disableError)
                         WHERE id=\(row.id)
                        """,
                        logger: logger
                    )
                } else {
                    _ = try await conn.query(
                        """
                        UPDATE event_subscription
                           SET delivery_failure_count = \(next),
                               updated_at = clock_timestamp()
                         WHERE id = \(subscription.id)
                        """,
                        logger: logger
                    )
                    if row.attempts >= config.maxAttempts {
                        _ = try await conn.query(
                            """
                            UPDATE outbox
                               SET status='failed', processed_at=now(),
                                   last_error=\(maxAttemptsError)
                             WHERE id=\(row.id)
                            """,
                            logger: logger
                        )
                    } else {
                        _ = try await conn.query(
                            """
                            UPDATE outbox
                               SET status='pending',
                                   available_at=now() + (\(backoffSeconds) * interval '1 second'),
                                   last_error=\(serverError)
                             WHERE id=\(row.id)
                            """,
                            logger: logger
                        )
                    }
                }
            }
        } catch {
            logger.error("webhook 5xx settlement failed", metadata: [
                "outboxId": .stringConvertible(row.id),
                "error": .string(String(describing: error)),
            ])
        }
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
