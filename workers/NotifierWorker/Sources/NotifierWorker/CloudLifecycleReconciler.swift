import AsyncHTTPClient
import CloudProviderKit
import Crypto
import Foundation
import NIOCore
import NIOFoundationCompat
import PostgresNIO

extension NotifierService {
    /// One claimed durable intent, as ADR-0140 D4 ① committed it.
    private struct CloudIntent: Sendable {
        let id: UUID
        let workspaceID: UUID
        let hostID: UUID?
        let sandboxID: String?
        let state: String
        let operationID: UUID?
        let kind: String?
        /// Bumped by the claim. Any provider response quoting an older version
        /// belongs to an attempt that has been superseded.
        let version: Int64
        let attempts: Int
        /// The intent outlived its bound: stop waiting, ask for the fact.
        let deadlineExceeded: Bool
        let displayName: String?
        let providerID: String

        var ref: CloudInstanceRef? {
            guard let sandboxID else { return nil }
            return CloudInstanceRef(providerID: providerID, instanceID: sandboxID)
        }

        var phase: CloudLifecyclePhase? { CloudLifecyclePhase(state: state) }
    }

    /// Converges provider calls which intentionally live outside PostgreSQL.
    ///
    /// The shape is ADR-0140 D4 exactly: a durable intent is claimed (which
    /// bumps its version), the provider is called outside any transaction with
    /// the operation id as its idempotency key, and a second transaction takes
    /// the lock ladder, revalidates `(operation_id, version)` and only then
    /// confirms. A response that fails revalidation is discarded and logged —
    /// it is not an error to retry, it is an answer to a question nobody is
    /// asking any more.
    func reconcileCloudLifecycle() async {
        guard let readyConfig = try? config.cloudProvider.requireReady() else { return }
        do {
            let candidateRows = try await pg.query(
                """
                SELECT id
                  FROM work_cloud_host
                 WHERE (
                   state = 'provisioning' AND provider_sandbox_id IS NULL
                   AND updated_at < clock_timestamp() - interval '5 seconds'
                 ) OR (
                   state IN ('pausing', 'resuming', 'destroy_pending')
                   AND COALESCE(
                         lifecycle_operation_next_attempt_at,
                         lifecycle_operation_started_at + interval '5 seconds'
                       ) <= clock_timestamp()
                 )
                 ORDER BY updated_at, id
                 LIMIT \(config.claimBatchSize)
                """,
                logger: logger
            ).collect()
            let candidateIDs = try candidateRows.map { try $0.decode(UUID.self) }
            var intents: [CloudIntent] = []
            for candidateID in candidateIDs {
                do {
                    if let intent = try await claim(candidateID: candidateID) {
                        intents.append(intent)
                    }
                } catch {
                    logger.warning("cloud lifecycle intent claim failed", metadata: [
                        "provisionID": .string(candidateID.uuidString.lowercased()),
                        "error": .string(String(describing: error)),
                    ])
                }
            }
            for intent in intents {
                do {
                    try await reconcile(intent: intent, readyConfig: readyConfig)
                } catch {
                    logger.warning("cloud lifecycle reconciliation will retry", metadata: [
                        "provisionID": .string(intent.id.uuidString.lowercased()),
                        "state": .string(intent.state),
                        "error": .string(String(describing: error)),
                    ])
                }
            }
        } catch {
            logger.warning("cloud lifecycle intent claim failed", metadata: [
                "error": .string(String(describing: error)),
            ])
        }
    }

    private func claim(candidateID: UUID) async throws -> CloudIntent? {
        try await pg.withTransaction(logger: logger) { conn in
            try await T3LifecycleLock.acquirePrelude(
                conn: conn,
                logger: logger,
                workspaceID: nil,
                cloudHostID: candidateID
            )
            // A provisioning row has no durable operation yet: its convergence
            // is "finish the create", and the create idempotency key is the
            // provision id itself.
            let provisioningRows = try await conn.query(
                """
                UPDATE work_cloud_host
                   SET updated_at = clock_timestamp()
                 WHERE id = \(candidateID)
                   AND state = 'provisioning'
                   AND provider_sandbox_id IS NULL
                   AND updated_at < clock_timestamp() - interval '5 seconds'
                RETURNING workspace_id, host_id, requested_display_name, provider
                """,
                logger: logger
            ).collect()
            if let row = provisioningRows.first {
                let value = try row.decode((UUID, UUID?, String?, String).self)
                return CloudIntent(
                    id: candidateID, workspaceID: value.0, hostID: value.1,
                    sandboxID: nil, state: "provisioning", operationID: nil,
                    kind: nil, version: 0, attempts: 0, deadlineExceeded: false,
                    displayName: value.2, providerID: value.3
                )
            }
            let rows = try await conn.query(
                """
                SELECT workspace_id, host_id, provider, provider_sandbox_id, state,
                       lifecycle_operation_id, lifecycle_operation_kind,
                       lifecycle_operation_version, lifecycle_operation_attempts,
                       deadline_exceeded, requested_display_name
                  FROM t3_claim_lifecycle_operation(
                    \(candidateID), interval '5 seconds'
                  )
                """,
                logger: logger
            ).collect()
            guard let row = rows.first else { return nil }
            let value = try row.decode(
                (UUID, UUID?, String, String?, String, UUID?, String?, Int64, Int,
                 Bool, String?).self
            )
            return CloudIntent(
                id: candidateID, workspaceID: value.0, hostID: value.1,
                sandboxID: value.3, state: value.4, operationID: value.5,
                kind: value.6, version: value.7, attempts: value.8,
                deadlineExceeded: value.9, displayName: value.10,
                providerID: value.2
            )
        }
    }

    private func reconcile(
        intent: CloudIntent,
        readyConfig: ReadyCloudProviderSettings
    ) async throws {
        let adapter = try readyConfig.adapter(
            for: intent.providerID, httpClient: httpClient
        )
        if intent.state == "provisioning" {
            try await reconcileProvision(
                intent: intent, readyConfig: readyConfig, adapter: adapter
            )
            return
        }
        guard let phase = intent.phase,
              let ref = intent.ref,
              let operationID = intent.operationID,
              let hostID = intent.hostID
        else { return }

        // ADR-0140 D4 ② — outside any transaction, keyed by the durable
        // operation so a retry cannot double-act on the provider.
        let idempotencyKey = operationID.uuidString.lowercased()
        let convergence: CloudLifecycleConvergence
        var probeAnswer = CloudInstancePresence.unknown
        if intent.deadlineExceeded {
            // Past the bound the question is no longer "did our call work" but
            // "what is actually true", and only the provider can answer that.
            probeAnswer = (try? await adapter.probe(ref: ref)) ?? .unknown
            convergence = CloudLifecycleRules.afterDeadline(
                phase: phase, presence: probeAnswer
            )
            logger.info("cloud lifecycle deadline exceeded", metadata: [
                "provisionID": .string(intent.id.uuidString.lowercased()),
                "state": .string(intent.state),
                "probe": .string(probeAnswer.rawValue),
                "convergence": .string(convergence.rawValue),
                "attempts": .stringConvertible(intent.attempts),
            ])
        } else {
            var adapterError: CloudProviderError?
            do {
                switch phase {
                case .pausing:
                    try await adapter.pause(ref: ref, idempotencyKey: idempotencyKey)
                case .resuming:
                    try await adapter.resume(ref: ref, idempotencyKey: idempotencyKey)
                case .destroyPending:
                    try await adapter.destroy(ref: ref, idempotencyKey: idempotencyKey)
                }
            } catch let error as CloudProviderError {
                adapterError = error
            } catch {
                adapterError = .requestFailed
            }
            convergence = CloudLifecycleRules.afterProviderCall(
                phase: phase, error: adapterError
            )
        }

        if convergence == .terminate {
            // ADR-0142 D3.1: before terminally settling a paid session, ask the
            // adapter for the fact. A provider that hides a death (answers
            // `present` for an instance it just refused to act on) contradicts
            // itself, and momo refuses to convert that contradiction into a
            // settlement — the intent stays claimable and named in the log.
            if !intent.deadlineExceeded {
                probeAnswer = (try? await adapter.probe(ref: ref)) ?? .unknown
            }
            if probeAnswer == .present {
                logger.warning("provider denied its own missing instance", metadata: [
                    "provisionID": .string(intent.id.uuidString.lowercased()),
                    "provider": .string(intent.providerID),
                    "probe": .string(probeAnswer.rawValue),
                ])
                // Throwing leaves the durable intent claimable rather than
                // downgrading it to a non-terminal path: the contradiction is
                // the operator's to resolve, and retrying is the only move that
                // cannot silently bill or silently strand the session.
                throw CloudReconcileError.dishonestProvider
            }
        }

        if convergence == .retry {
            // The claim already recorded the attempt and pushed the next one
            // out by `t3_lifecycle_backoff`. Nothing else to write: the durable
            // intent *is* the retry.
            logger.info("cloud lifecycle intent will retry", metadata: [
                "provisionID": .string(intent.id.uuidString.lowercased()),
                "state": .string(intent.state),
                "attempts": .stringConvertible(intent.attempts),
            ])
            return
        }

        try await pg.withTransaction(logger: logger) { conn in
            // ADR-0140 D4 ③ — ladder first, then revalidate, then confirm. The
            // guard holds the row lock for the rest of this transaction, so the
            // writes below key on identity alone and still cannot race.
            try await T3LifecycleLock.acquirePrelude(
                conn: conn,
                logger: logger,
                workspaceID: intent.workspaceID,
                cloudHostID: intent.id,
                lockWorkspaceCredit: convergence == .terminate
            )
            guard try await T3LifecycleIntent.isCurrent(
                conn: conn,
                logger: logger,
                cloudHostID: intent.id,
                operationID: operationID,
                version: intent.version,
                expectedState: intent.state
            ) else {
                logger.warning("discarded stale provider response", metadata: [
                    "provisionID": .string(intent.id.uuidString.lowercased()),
                    "state": .string(intent.state),
                    "operationID": .string(operationID.uuidString.lowercased()),
                    "version": .stringConvertible(intent.version),
                    "convergence": .string(convergence.rawValue),
                ])
                return
            }

            switch convergence {
            case .terminate:
                try await self.terminate(
                    conn: conn, intent: intent, hostID: hostID,
                    probeAnswer: probeAnswer
                )
            case .revert:
                guard let revertState = phase.revertState else { return }
                // Nothing in the ledger moves. A pause that never happened left
                // the active interval open, so billing simply never stopped —
                // the outcome ADR-0140 D4 asks for, reached by doing nothing
                // rather than by compensating.
                _ = try await conn.query(
                    """
                    UPDATE work_cloud_host
                       SET state = \(revertState),
                           lifecycle_operation_next_attempt_at = NULL,
                           updated_at = clock_timestamp()
                     WHERE id = \(intent.id)
                    """,
                    logger: self.logger
                )
                self.logger.info("cloud lifecycle intent abandoned", metadata: [
                    "provisionID": .string(intent.id.uuidString.lowercased()),
                    "from": .string(intent.state),
                    "to": .string(revertState),
                ])
            case .confirm:
                try await self.confirm(
                    conn: conn, intent: intent, phase: phase, hostID: hostID
                )
            case .retry:
                return
            }
        }
    }

    /// Advance the ledger and the host to the state the operation promised.
    private func confirm(
        conn: PostgresConnection,
        intent: CloudIntent,
        phase: CloudLifecyclePhase,
        hostID: UUID
    ) async throws {
        if phase == .pausing || phase == .resuming {
            let expectedInterval = phase == .pausing ? "active" : "paused"
            let nextInterval = phase == .pausing ? "paused" : "active"
            _ = try await conn.query(
                """
                WITH usage AS (
                  SELECT id, session_id, workspace_id
                    FROM work_host_usage
                   WHERE workspace_id = \(intent.workspaceID)
                     AND host_id = \(hostID)
                     AND settled_at IS NULL
                   FOR UPDATE
                ), closed AS (
                  UPDATE work_host_usage_interval i
                     SET ended_at = clock_timestamp()
                    FROM usage u
                   WHERE i.usage_id = u.id
                     AND i.state = \(expectedInterval)
                     AND i.ended_at IS NULL
                  RETURNING i.usage_id
                ), opened AS (
                  INSERT INTO work_host_usage_interval
                    (usage_id, workspace_id, state)
                  SELECT c.usage_id, \(intent.workspaceID), \(nextInterval)
                    FROM closed c
                  RETURNING usage_id
                )
                UPDATE work_session ws
                   SET status = \(phase == .pausing ? "idle" : "running"),
                       idle_at = CASE
                         WHEN \(phase == .pausing) THEN clock_timestamp()
                         ELSE NULL
                       END
                  FROM usage u, opened o
                 WHERE ws.id = u.session_id
                   AND o.usage_id = u.id
                """,
                logger: logger
            )
        }
        _ = try await conn.query(
            """
            UPDATE work_cloud_host
               SET state = \(phase.confirmedState),
                   lifecycle_operation_next_attempt_at = NULL,
                   updated_at = clock_timestamp()
             WHERE id = \(intent.id)
            """,
            logger: logger
        )
        if phase == .destroyPending {
            _ = try await conn.query(
                """
                UPDATE work_host
                   SET revoked_at = COALESCE(revoked_at, clock_timestamp())
                 WHERE workspace_id = \(intent.workspaceID)
                   AND id = \(hostID)
                """,
                logger: logger
            )
        }
    }

    /// The instance is provably gone. Settle through the single statement, then
    /// take the host out of service.
    private func terminate(
        conn: PostgresConnection,
        intent: CloudIntent,
        hostID: UUID,
        probeAnswer: CloudInstancePresence
    ) async throws {
        let usageRows = try await conn.query(
            """
            SELECT session_id
              FROM work_host_usage
             WHERE workspace_id = \(intent.workspaceID)
               AND host_id = \(hostID)
               AND settled_at IS NULL
             FOR UPDATE
            """,
            logger: logger
        ).collect()
        var terminalSession: (id: UUID, memberID: UUID)?
        if let usageRow = usageRows.first {
            let sessionID = try usageRow.decode(UUID.self)
            let sessionRows = try await conn.query(
                """
                SELECT member_id
                  FROM work_session
                 WHERE workspace_id = \(intent.workspaceID)
                   AND id = \(sessionID)
                 FOR UPDATE
                """,
                logger: logger
            ).collect()
            guard let memberID = try sessionRows.first?.decode(UUID.self) else {
                throw CloudReconcileError.staleIntent
            }
            terminalSession = (sessionID, memberID)
            _ = try await conn.query(
                """
                SELECT t3_terminate(
                  \(intent.workspaceID), \(sessionID), 'provider_missing'
                )
                """,
                logger: logger
            ).collect()
        } else {
            _ = try await conn.query(
                """
                UPDATE work_cloud_host
                   SET state = 'destroy_pending',
                       lifecycle_operation_kind = 'destroy',
                       lifecycle_operation_version =
                         lifecycle_operation_version + 1,
                       updated_at = clock_timestamp()
                 WHERE id = \(intent.id)
                   AND workspace_id = \(intent.workspaceID)
                   AND state <> 'destroy_pending'
                """,
                logger: logger
            )
        }
        let terminalRows = try await conn.query(
            """
            UPDATE work_cloud_host
               SET state = 'destroyed',
                   lifecycle_operation_next_attempt_at = NULL,
                   updated_at = clock_timestamp()
             WHERE id = \(intent.id)
               AND workspace_id = \(intent.workspaceID)
               AND state = 'destroy_pending'
            RETURNING id
            """,
            logger: logger
        ).collect()
        guard terminalRows.count == 1 else {
            throw CloudReconcileError.staleIntent
        }
        _ = try await conn.query(
            """
            UPDATE work_host
               SET revoked_at = COALESCE(revoked_at, clock_timestamp()),
                   last_seen_at = clock_timestamp() - interval '100 years'
             WHERE workspace_id = \(intent.workspaceID)
               AND id = \(hostID)
            """,
            logger: logger
        )
        if let terminalSession {
            _ = try await conn.query(
                """
                INSERT INTO audit_log
                  (workspace_id, actor_member_id, subject_member_id,
                   action, target_type, target_id, via_token_id, detail)
                VALUES
                  (\(intent.workspaceID), \(terminalSession.memberID),
                   \(terminalSession.memberID),
                   'work.cloud.resume_failed', 'work_host', \(hostID), NULL,
                   jsonb_build_object(
                     'schema', 'momo.work_cloud.resume_failed.v1',
                     'host_id', lower(\(hostID)::text),
                     'session_id', lower(\(terminalSession.id)::text),
                     'provider', \(intent.providerID),
                     'reason', 'sandbox_missing',
                     'provider_probe', \(probeAnswer.rawValue),
                     'intent_state', \(intent.state),
                     'orphan_transition', 'host_offline_sweep',
                     'source', 'lifecycle_reconciler'
                   ))
                """,
                logger: logger
            )
        }
    }

    private func reconcileProvision(
        intent: CloudIntent,
        readyConfig: ReadyCloudProviderSettings,
        adapter: any CloudProviderAdapter
    ) async throws {
        // A degenerate adapter never had a create to converge: a BYOC row's
        // instance handle exists from enrollment onward.
        guard adapter.capabilities.supports(.create),
              let secret = readyConfig.bootstrapSecret(for: intent.providerID),
              let displayName = intent.displayName
        else { return }
        let token = bootstrapToken(provisionID: intent.id, secret: secret)
        let instance = try await adapter.create(
            spec: CloudInstanceSpec(
                provisionID: intent.id,
                workspaceID: intent.workspaceID,
                displayName: displayName,
                registrationToken: token,
                serverURL: readyConfig.publicServerURL
            ),
            idempotencyKey: intent.id.uuidString.lowercased()
        )
        let sandboxID = instance.instanceID
        let updated = try await pg.withTransaction(logger: logger) { conn in
            try await T3LifecycleLock.acquirePrelude(
                conn: conn,
                logger: logger,
                workspaceID: intent.workspaceID,
                cloudHostID: intent.id
            )
            return try await conn.query(
                """
                UPDATE work_cloud_host
                   SET provider_sandbox_id = \(sandboxID),
                       state = CASE
                         WHEN host_id IS NULL THEN 'provisioning'
                         ELSE 'ready'
                       END,
                       updated_at = clock_timestamp()
                 WHERE id = \(intent.id)
                   AND state = 'provisioning'
                   AND provider_sandbox_id IS NULL
                RETURNING id
                """,
                logger: logger
            ).collect()
        }
        if updated.first == nil {
            try await adapter.destroy(
                ref: instance,
                idempotencyKey: "cleanup-\(intent.id.uuidString.lowercased())"
            )
        }
    }

    private func bootstrapToken(provisionID: UUID, secret: String) -> String {
        let key = SymmetricKey(data: Data(secret.utf8))
        let payload = Data(
            "momo.cloud.bootstrap.v1:\(provisionID.uuidString.lowercased())".utf8
        )
        return Data(HMAC<SHA256>.authenticationCode(for: payload, using: key))
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

private enum CloudReconcileError: Error {
    case dishonestProvider
    case staleIntent
}
