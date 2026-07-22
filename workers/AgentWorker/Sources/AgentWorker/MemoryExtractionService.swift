import Foundation
import Logging
import PostgresNIO
import ServiceLifecycle

enum MemoryOperation: String, Codable, Sendable, Equatable {
    case add = "ADD"
    case update = "UPDATE"
    case invalidate = "INVALIDATE"
    case noop = "NOOP"
}

struct MemoryExtractionMessage: Sendable, Equatable {
    let id: UUID
    let seq: Int64
    let authorMemberID: UUID
    let body: String?
}

struct ExistingMemory: Sendable, Equatable {
    let id: UUID
    let kind: String
    let body: String
    let confidence: Double
}

struct MemoryProposal: Sendable, Equatable {
    let operation: MemoryOperation
    let targetMemoryID: UUID?
    let kind: String
    let body: String
    let confidence: Double
    let sourceMessageIDs: [UUID]
}

private func hasValidMemoryTarget(
    operation: MemoryOperation,
    targetMemoryID: UUID?
) -> Bool {
    switch operation {
    case .add:
        return targetMemoryID == nil
    case .update, .invalidate:
        return targetMemoryID != nil
    case .noop:
        return true
    }
}

struct MemoryExtractionBatch: Sendable {
    let workspaceID: UUID
    let channelID: UUID
    let agentMemberID: UUID
    let model: String
    let messages: [MemoryExtractionMessage]
    let existing: [ExistingMemory]
}

protocol MemoryExtracting: Sendable {
    var kind: String { get }
    var version: String { get }
    func extract(_ batch: MemoryExtractionBatch) async throws -> [MemoryProposal]
}

/// Deterministic gate extractor. It persists no raw message text and reacts only
/// to explicit fixture markers, so local development cannot accidentally turn
/// every chat line into durable memory.
///
/// Grammar:
///   [memory:add kind=fact confidence=0.9] bounded body
///   [memory:update id=<uuid> kind=fact confidence=0.8] replacement body
///   [memory:invalidate id=<uuid>] reason
///   [memory:noop] reason
struct MockMemoryExtractor: MemoryExtracting {
    let kind = "mock"
    let version = "momo-memory-mock-v1"

    func extract(_ batch: MemoryExtractionBatch) async throws -> [MemoryProposal] {
        batch.messages.compactMap(Self.parse)
    }

    static func parse(_ message: MemoryExtractionMessage) -> MemoryProposal? {
        guard let raw = message.body?.trimmingCharacters(in: .whitespacesAndNewlines),
              raw.hasPrefix("[memory:"),
              let close = raw.firstIndex(of: "]")
        else { return nil }

        let header = String(raw[raw.index(raw.startIndex, offsetBy: 8)..<close])
        let body = String(raw[raw.index(after: close)...])
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let tokens = header.split(separator: " ").map(String.init)
        guard let op = tokens.first.flatMap({ MemoryOperation(rawValue: $0.uppercased()) }) else {
            return nil
        }
        var values: [String: String] = [:]
        for token in tokens.dropFirst() {
            let pair = token.split(separator: "=", maxSplits: 1).map(String.init)
            if pair.count == 2 { values[pair[0]] = pair[1] }
        }
        let target = values["id"].flatMap(UUID.init(uuidString:))
        guard hasValidMemoryTarget(operation: op, targetMemoryID: target) else { return nil }
        let kind = values["kind"] ?? "fact"
        guard ["profile", "fact", "episode", "procedure"].contains(kind) else { return nil }
        let confidence = values["confidence"].flatMap(Double.init) ?? 0.8
        let boundedBody = body.isEmpty ? "No durable memory change" : String(body.prefix(16_384))
        return MemoryProposal(
            operation: op,
            targetMemoryID: target,
            kind: kind,
            body: boundedBody,
            confidence: min(max(confidence, 0), 1),
            sourceMessageIDs: [message.id]
        )
    }

}

/// Existing AgentWorker Hermes transport reused for the extraction call. The
/// API key stays in this process and is never included in the prompt, database,
/// packet, outbox, or logs.
struct HermesMemoryExtractor: MemoryExtracting {
    let hermes: HermesTransport
    let kind = "hermes"
    let version = "momo-memory-extractor-v1"

    func extract(_ batch: MemoryExtractionBatch) async throws -> [MemoryProposal] {
        let prompt = try Self.prompt(batch)
        var output = ""
        for try await event in hermes.invoke(
            model: batch.model,
            messages: [
                .init(
                    role: "system",
                    content: "Extract durable, bounded team memory. Return JSON only. Never include credentials, raw transcripts, or unbounded summaries."
                ),
                .init(role: "user", content: prompt),
            ],
            tools: nil,
            maxTokens: 2_000
        ) {
            if case .textDelta(let value) = event { output += value }
        }
        return try Self.decode(output, allowedSources: Set(batch.messages.map(\.id)))
    }

    private struct ProposalJSON: Decodable {
        let operation: MemoryOperation
        let targetMemoryId: UUID?
        let kind: String
        let body: String
        let confidence: Double
        let sourceMessageIds: [UUID]
    }

    static func prompt(_ batch: MemoryExtractionBatch) throws -> String {
        let messages: [[String: Any]] = batch.messages.compactMap { message in
            guard let body = message.body, !body.isEmpty else { return nil }
            return [
                "message_id": message.id.uuidString,
                "seq": message.seq,
                "author_member_id": message.authorMemberID.uuidString,
                "body": String(body.prefix(4_096)),
            ]
        }
        let existing: [[String: Any]] = batch.existing.map {
            [
                "memory_id": $0.id.uuidString,
                "kind": $0.kind,
                "body": String($0.body.prefix(2_048)),
                "confidence": $0.confidence,
            ]
        }
        let object: [String: Any] = [
            "schema": "momo.memory.extract.request.v1",
            "rules": [
                "Return an array with operation ADD, UPDATE, INVALIDATE, or NOOP.",
                "kind must be profile, fact, episode, or procedure.",
                "UPDATE and INVALIDATE require targetMemoryId from existing.",
                "Every proposal requires sourceMessageIds from messages.",
                "Use NOOP for duplicates or non-durable chat.",
            ],
            "messages": messages,
            "existing": existing,
        ]
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        return String(decoding: data, as: UTF8.self)
    }

    static func decode(_ raw: String, allowedSources: Set<UUID>) throws -> [MemoryProposal] {
        var value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasPrefix("```"), let firstNewline = value.firstIndex(of: "\n") {
            value = String(value[value.index(after: firstNewline)...])
            if value.hasSuffix("```") { value.removeLast(3) }
        }
        let decoder = JSONDecoder()
        let decoded = try decoder.decode([ProposalJSON].self, from: Data(value.utf8))
        return decoded.prefix(32).compactMap { proposal in
            let sources = proposal.sourceMessageIds.filter(allowedSources.contains)
            guard hasValidMemoryTarget(
                      operation: proposal.operation,
                      targetMemoryID: proposal.targetMemoryId
                  ),
                  !sources.isEmpty,
                  ["profile", "fact", "episode", "procedure"].contains(proposal.kind),
                  proposal.confidence.isFinite,
                  (0...1).contains(proposal.confidence)
            else { return nil }
            let body = proposal.body.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !body.isEmpty else { return nil }
            return MemoryProposal(
                operation: proposal.operation,
                targetMemoryID: proposal.targetMemoryId,
                kind: proposal.kind,
                body: String(body.prefix(16_384)),
                confidence: proposal.confidence,
                sourceMessageIDs: sources
            )
        }
    }
}

/// Periodic channel-watermark memory pipeline (ADR-0129 D2).
///
/// Claim is a short transaction guarded by a durable lease. The provider call
/// runs without a DB lock. Candidate rows, comparison result, memory mutation,
/// identifier-only source refs, lifecycle/audit, memory.updated outbox, and
/// watermark advancement commit atomically.
struct MemoryExtractionService: Service {
    let pg: PostgresClient
    let extractor: any MemoryExtracting
    let pollInterval: Duration
    let batchSize: Int
    let poisonThreshold: Int
    let logger: Logger
    let sleeper: any MemoryWorkerSleeping

    init(
        pg: PostgresClient,
        extractor: any MemoryExtracting,
        pollInterval: Duration,
        batchSize: Int,
        poisonThreshold: Int = 5,
        logger: Logger,
        sleeper: any MemoryWorkerSleeping = TaskMemoryWorkerSleeper()
    ) {
        self.pg = pg
        self.extractor = extractor
        self.pollInterval = pollInterval
        self.batchSize = batchSize
        self.poisonThreshold = poisonThreshold
        self.logger = logger
        self.sleeper = sleeper
    }

    private struct Claim: Sendable {
        let leaseToken: UUID
        let workspaceID: UUID
        let channelID: UUID
        let agentMemberID: UUID
        let model: String
        let lastExtractedSeq: Int64
        let toSeq: Int64
        let messages: [MemoryExtractionMessage]
        let existing: [ExistingMemory]

        var retryKey: RetryKey {
            .init(
                workspaceID: workspaceID,
                channelID: channelID,
                fromSeq: lastExtractedSeq,
                toSeq: toSeq
            )
        }
    }

    private struct RetryKey: Hashable, Sendable {
        let workspaceID: UUID
        let channelID: UUID
        let fromSeq: Int64
        let toSeq: Int64
    }

    func run() async throws {
        logger.info("memory extraction worker starting", metadata: [
            "extractor": .string(extractor.kind),
            "extractorVersion": .string(extractor.version),
            "batchSize": .stringConvertible(batchSize),
        ])
        var retry = MemoryBatchRetryState<RetryKey>(
            baseDelay: pollInterval,
            poisonThreshold: poisonThreshold
        )
        while !Task.isCancelled {
            var retryDelay: Duration?
            do {
                while let claim = try await claimOne() {
                    if await process(claim) {
                        retry.recordSuccess(for: claim.retryKey)
                    } else {
                        let decision = retry.recordFailure(for: claim.retryKey)
                        if decision.shouldPoison {
                            do {
                                try await poison(claim, failureCount: decision.failureCount)
                                retry.recordPoisonHandled(for: claim.retryKey)
                            } catch {
                                logger.error("memory extraction poison handling failed", metadata: [
                                    "workspaceId": .string(claim.workspaceID.uuidString),
                                    "channelId": .string(claim.channelID.uuidString),
                                    "error": .string(String(describing: error)),
                                ])
                                try? await release(claim)
                            }
                        } else {
                            try? await release(claim)
                        }
                        retryDelay = decision.delay
                        break
                    }
                    if Task.isCancelled { break }
                }
            } catch {
                logger.error("memory extraction drain failed", metadata: [
                    "error": .string(String(describing: error)),
                ])
            }
            await sleeper.sleep(for: retryDelay ?? pollInterval)
        }
    }

    private func claimOne() async throws -> Claim? {
        let leaseToken = UUID()
        return try await pg.withTransaction(logger: logger) { conn in
            _ = try await conn.query(
                """
                INSERT INTO memory_extraction_cursor (workspace_id, channel_id)
                SELECT c.workspace_id, c.id
                  FROM channel c
                  JOIN channel_seq cs ON cs.channel_id = c.id
                 WHERE c.archived_at IS NULL
                   AND cs.last_seq > 0
                   AND EXISTS (
                     SELECT 1
                       FROM membership ms
                       JOIN member m
                         ON m.workspace_id = ms.workspace_id
                        AND m.id = ms.member_id
                        AND m.kind = 'agent'
                        AND m.status = 'active'
                        AND m.deleted_at IS NULL
                      WHERE ms.workspace_id = c.workspace_id
                        AND ms.channel_id = c.id
                        AND ms.left_at IS NULL
                   )
                ON CONFLICT (workspace_id, channel_id) DO NOTHING
                """,
                logger: logger
            )
            let rows = try await conn.query(
                """
                SELECT mec.workspace_id, mec.channel_id, mec.last_extracted_seq,
                       a.member_id, a.model
                  FROM memory_extraction_cursor mec
                  JOIN channel_seq cs
                    ON cs.workspace_id = mec.workspace_id
                   AND cs.channel_id = mec.channel_id
                  JOIN LATERAL (
                    SELECT ag.member_id, ag.model
                      FROM membership ms
                      JOIN member m
                        ON m.workspace_id = ms.workspace_id
                       AND m.id = ms.member_id
                       AND m.kind = 'agent'
                       AND m.status = 'active'
                       AND m.deleted_at IS NULL
                      JOIN agent ag
                        ON ag.workspace_id = m.workspace_id
                       AND ag.member_id = m.id
                     WHERE ms.workspace_id = mec.workspace_id
                       AND ms.channel_id = mec.channel_id
                       AND ms.left_at IS NULL
                     ORDER BY ag.created_at, ag.member_id
                     LIMIT 1
                  ) a ON true
                 WHERE cs.last_seq > mec.last_extracted_seq
                   AND (mec.leased_until IS NULL OR mec.leased_until < now())
                   AND NOT EXISTS (
                     SELECT 1 FROM workspace_memory_policy p
                      WHERE p.workspace_id = mec.workspace_id AND NOT p.enabled
                   )
                 ORDER BY mec.updated_at, mec.workspace_id, mec.channel_id
                 FOR UPDATE OF mec SKIP LOCKED
                 LIMIT 1
                """,
                logger: logger
            ).collect()
            guard let row = rows.first else { return nil }
            let (workspaceID, channelID, fromSeq, agentMemberID, model) = try row.decode(
                (UUID, UUID, Int64, UUID, String).self
            )
            _ = try await conn.query(
                """
                UPDATE memory_extraction_cursor
                   SET lease_token = \(leaseToken),
                       leased_until = now() + interval '2 minutes',
                       updated_at = clock_timestamp()
                 WHERE workspace_id = \(workspaceID) AND channel_id = \(channelID)
                """,
                logger: logger
            )
            let messageRows = try await conn.query(
                """
                SELECT id, seq, author_member_id, body
                  FROM message
                 WHERE workspace_id = \(workspaceID)
                   AND channel_id = \(channelID)
                   AND seq > \(fromSeq)
                 ORDER BY seq
                 LIMIT \(batchSize)
                """,
                logger: logger
            ).collect()
            guard !messageRows.isEmpty else {
                _ = try await conn.query(
                    """
                    UPDATE memory_extraction_cursor
                       SET lease_token = NULL, leased_until = NULL
                     WHERE workspace_id = \(workspaceID) AND channel_id = \(channelID)
                    """,
                    logger: logger
                )
                return nil
            }
            let messages = try messageRows.map { row -> MemoryExtractionMessage in
                let (id, seq, author, body) = try row.decode((UUID, Int64, UUID, String?).self)
                return .init(id: id, seq: seq, authorMemberID: author, body: body)
            }
            let existingRows = try await conn.query(
                """
                SELECT id, kind, body, confidence
                  FROM memory_item
                 WHERE workspace_id = \(workspaceID)
                   AND scope = 'conversation'
                   AND channel_id = \(channelID)
                   AND invalid_at IS NULL
                 ORDER BY valid_at DESC, id DESC
                 LIMIT 100
                """,
                logger: logger
            ).collect()
            let existing = try existingRows.map { row -> ExistingMemory in
                let value = try row.decode((UUID, String, String, Double).self)
                return .init(id: value.0, kind: value.1, body: value.2, confidence: value.3)
            }
            return Claim(
                leaseToken: leaseToken, workspaceID: workspaceID, channelID: channelID,
                agentMemberID: agentMemberID, model: model, lastExtractedSeq: fromSeq,
                toSeq: messages.last!.seq, messages: messages, existing: existing
            )
        }
    }

    private func process(_ claim: Claim) async -> Bool {
        do {
            let batch = MemoryExtractionBatch(
                workspaceID: claim.workspaceID,
                channelID: claim.channelID,
                agentMemberID: claim.agentMemberID,
                model: claim.model,
                messages: claim.messages,
                existing: claim.existing
            )
            let extracted = try await extractor.extract(batch)
            let compared = Self.compare(extracted, existing: claim.existing)
            try await apply(compared, claim: claim)
            return true
        } catch {
            logger.error("memory extraction batch failed", metadata: [
                "workspaceId": .string(claim.workspaceID.uuidString),
                "channelId": .string(claim.channelID.uuidString),
                "fromSeq": .stringConvertible(claim.lastExtractedSeq),
                "toSeq": .stringConvertible(claim.toSeq),
                "error": .string(String(describing: error)),
            ])
            return false
        }
    }

    static func compare(
        _ proposals: [MemoryProposal], existing: [ExistingMemory]
    ) -> [MemoryProposal] {
        let byID = Dictionary(uniqueKeysWithValues: existing.map { ($0.id, $0) })
        return proposals.prefix(32).map { proposal in
            switch proposal.operation {
            case .add:
                if let duplicate = existing.first(where: {
                    $0.kind == proposal.kind
                        && $0.body.caseInsensitiveCompare(proposal.body) == .orderedSame
                }) {
                    return MemoryProposal(
                        operation: .noop, targetMemoryID: duplicate.id,
                        kind: proposal.kind, body: proposal.body,
                        confidence: proposal.confidence,
                        sourceMessageIDs: proposal.sourceMessageIDs
                    )
                }
                return proposal
            case .update, .invalidate:
                guard let target = proposal.targetMemoryID, byID[target] != nil else {
                    return MemoryProposal(
                        operation: .noop, targetMemoryID: proposal.targetMemoryID,
                        kind: proposal.kind, body: proposal.body,
                        confidence: proposal.confidence,
                        sourceMessageIDs: proposal.sourceMessageIDs
                    )
                }
                return proposal
            case .noop:
                return proposal
            }
        }
    }

    private func apply(_ proposals: [MemoryProposal], claim: Claim) async throws {
        try await pg.withTransaction(logger: logger) { conn in
            let leaseRows = try await conn.query(
                """
                SELECT 1
                  FROM memory_extraction_cursor
                 WHERE workspace_id = \(claim.workspaceID)
                   AND channel_id = \(claim.channelID)
                   AND lease_token = \(claim.leaseToken)
                   AND last_extracted_seq = \(claim.lastExtractedSeq)
                   AND NOT EXISTS (
                     SELECT 1 FROM workspace_memory_policy p
                      WHERE p.workspace_id = \(claim.workspaceID) AND NOT p.enabled
                   )
                 FOR UPDATE
                """,
                logger: logger
            ).collect()
            guard !leaseRows.isEmpty else { throw MemoryExtractionError.lostLease }

            for proposal in proposals {
                try await apply(proposal, claim: claim, conn: conn)
            }
            _ = try await conn.query(
                """
                UPDATE memory_extraction_cursor
                   SET last_extracted_seq = \(claim.toSeq),
                       lease_token = NULL,
                       leased_until = NULL,
                       updated_at = clock_timestamp()
                 WHERE workspace_id = \(claim.workspaceID)
                   AND channel_id = \(claim.channelID)
                   AND lease_token = \(claim.leaseToken)
                """,
                logger: logger
            )
        }
    }

    private func apply(
        _ proposal: MemoryProposal,
        claim: Claim,
        conn: PostgresConnection
    ) async throws {
        let targetID = proposal.targetMemoryID
        let candidateRows = try await conn.query(
            """
            INSERT INTO memory_candidate
              (workspace_id, channel_id, operation, target_memory_id, scope,
               kind, body, confidence, extractor_kind, extractor_version)
            VALUES
              (\(claim.workspaceID), \(claim.channelID), \(proposal.operation.rawValue),
               \(targetID)::uuid, 'conversation', \(proposal.kind), \(proposal.body),
               \(proposal.confidence), \(extractor.kind), \(extractor.version))
            RETURNING id
            """,
            logger: logger
        ).collect()
        guard let candidateID = try candidateRows.first?.decode(UUID.self) else {
            throw MemoryExtractionError.candidateInsertFailed
        }
        try await lifecycle(
            conn: conn, claim: claim, candidateID: candidateID, memoryID: targetID,
            action: "candidate_created", detail: ["operation": proposal.operation.rawValue]
        )

        let memoryID: UUID?
        switch proposal.operation {
        case .add:
            let rows = try await conn.query(
                """
                INSERT INTO memory_item
                  (workspace_id, scope, channel_id, kind, body, confidence,
                   created_by_kind, created_by_member_id)
                VALUES
                  (\(claim.workspaceID), 'conversation', \(claim.channelID),
                   \(proposal.kind), \(proposal.body), \(proposal.confidence),
                   'worker', \(claim.agentMemberID))
                RETURNING id
                """,
                logger: logger
            ).collect()
            memoryID = try rows.first?.decode(UUID.self)
        case .update:
            let rows = try await conn.query(
                """
                UPDATE memory_item
                   SET body = \(proposal.body), confidence = \(proposal.confidence),
                       embedding = NULL,
                       updated_at = clock_timestamp()
                 WHERE workspace_id = \(claim.workspaceID)
                   AND id = \(targetID)::uuid
                   AND invalid_at IS NULL
                RETURNING id
                """,
                logger: logger
            ).collect()
            memoryID = try rows.first?.decode(UUID.self)
        case .invalidate:
            let rows = try await conn.query(
                """
                UPDATE memory_item
                   SET invalid_at = coalesce(invalid_at, clock_timestamp()),
                       updated_at = clock_timestamp()
                 WHERE workspace_id = \(claim.workspaceID)
                   AND id = \(targetID)::uuid
                RETURNING id
                """,
                logger: logger
            ).collect()
            memoryID = try rows.first?.decode(UUID.self)
        case .noop:
            memoryID = targetID
        }

        if proposal.operation != .noop, memoryID == nil {
            throw MemoryExtractionError.memoryMutationFailed
        }

        if proposal.operation != .noop, let memoryID {
            let allowedSources = Set(claim.messages.map(\.id))
            let selected = proposal.sourceMessageIDs.filter(allowedSources.contains)
            for sourceID in selected {
                guard let source = claim.messages.first(where: { $0.id == sourceID }) else { continue }
                _ = try await conn.query(
                    """
                    INSERT INTO memory_source_ref
                      (workspace_id, memory_id, message_id, channel_id)
                    VALUES
                      (\(claim.workspaceID), \(memoryID), \(source.id), \(claim.channelID))
                    ON CONFLICT (memory_id, message_id) DO NOTHING
                    """,
                    logger: logger
                )
            }
            let lifecycleAction = proposal.operation == .add ? "created"
                : proposal.operation == .update ? "updated" : "invalidated"
            try await lifecycle(
                conn: conn, claim: claim, candidateID: candidateID, memoryID: memoryID,
                action: lifecycleAction,
                detail: ["extractor": extractor.kind]
            )
            try await auditAndBroadcast(
                conn: conn, claim: claim, memoryID: memoryID,
                action: lifecycleAction
            )
        } else {
            try await lifecycle(
                conn: conn, claim: claim, candidateID: candidateID, memoryID: memoryID,
                action: "noop", detail: ["reason": "comparison_no_change"]
            )
        }
        _ = try await conn.query(
            """
            UPDATE memory_candidate
               SET status = 'applied', applied_at = clock_timestamp()
             WHERE workspace_id = \(claim.workspaceID) AND id = \(candidateID)
            """,
            logger: logger
        )
        try await lifecycle(
            conn: conn, claim: claim, candidateID: candidateID, memoryID: memoryID,
            action: "candidate_applied", detail: ["operation": proposal.operation.rawValue]
        )
    }

    private func lifecycle(
        conn: PostgresConnection,
        claim: Claim,
        candidateID: UUID,
        memoryID: UUID?,
        action: String,
        detail: [String: Any]
    ) async throws {
        let json = Self.jsonString(detail)
        _ = try await conn.query(
            """
            INSERT INTO memory_lifecycle_event
              (workspace_id, memory_id, candidate_id, action, actor_member_id, detail)
            VALUES
              (\(claim.workspaceID), \(memoryID)::uuid, \(candidateID), \(action),
               \(claim.agentMemberID), \(json)::jsonb)
            """,
            logger: logger
        )
    }

    private func auditAndBroadcast(
        conn: PostgresConnection,
        claim: Claim,
        memoryID: UUID,
        action: String
    ) async throws {
        _ = try await conn.query(
            """
            INSERT INTO audit_log
              (workspace_id, actor_member_id, action, target_type, target_id, detail)
            VALUES
              (\(claim.workspaceID), \(claim.agentMemberID), 'memory.' || \(action),
               'memory', \(memoryID),
               jsonb_build_object('extractor_kind', \(extractor.kind),
                                  'extractor_version', \(extractor.version)))
            """,
            logger: logger
        )
        let payload = Self.broadcastPayload(
            workspaceID: claim.workspaceID,
            channelID: claim.channelID,
            memoryID: memoryID,
            action: action
        )
        _ = try await conn.query(
            """
            INSERT INTO outbox
              (workspace_id, kind, method, payload, partition_key)
            VALUES
              (\(claim.workspaceID), 'broadcast', 'publish', \(payload)::jsonb,
               \(claim.channelID))
            """,
            logger: logger
        )
    }

    private func release(_ claim: Claim) async throws {
        try await pg.withTransaction(logger: logger) { conn in
            _ = try await conn.query(
                """
                UPDATE memory_extraction_cursor
                   SET lease_token = NULL, leased_until = NULL,
                       updated_at = clock_timestamp()
                 WHERE workspace_id = \(claim.workspaceID)
                   AND channel_id = \(claim.channelID)
                   AND lease_token = \(claim.leaseToken)
                """,
                logger: logger
            )
        }
    }

    /// Atomically consumes a poison batch and records exactly one audit event.
    /// The lease and expected watermark protect the existing two-phase apply
    /// contract from racing another extraction worker.
    private func poison(_ claim: Claim, failureCount: Int) async throws {
        try await pg.withTransaction(logger: logger) { conn in
            let rows = try await conn.query(
                """
                UPDATE memory_extraction_cursor
                   SET last_extracted_seq = \(claim.toSeq),
                       lease_token = NULL,
                       leased_until = NULL,
                       updated_at = clock_timestamp()
                 WHERE workspace_id = \(claim.workspaceID)
                   AND channel_id = \(claim.channelID)
                   AND lease_token = \(claim.leaseToken)
                   AND last_extracted_seq = \(claim.lastExtractedSeq)
                RETURNING channel_id
                """,
                logger: logger
            ).collect()
            guard !rows.isEmpty else { throw MemoryExtractionError.lostLease }
            _ = try await conn.query(
                """
                INSERT INTO audit_log
                  (workspace_id, actor_member_id, action, target_type, target_id, detail)
                VALUES
                  (\(claim.workspaceID), \(claim.agentMemberID),
                   'memory.extraction.poisoned', 'channel', \(claim.channelID),
                   jsonb_build_object(
                     'from_seq', \(claim.lastExtractedSeq),
                     'to_seq', \(claim.toSeq),
                     'failure_count', \(failureCount),
                     'extractor_kind', \(extractor.kind),
                     'extractor_version', \(extractor.version)))
                """,
                logger: logger
            )
        }
        logger.warning("memory extraction poison batch skipped", metadata: [
            "workspaceId": .string(claim.workspaceID.uuidString),
            "channelId": .string(claim.channelID.uuidString),
            "fromSeq": .stringConvertible(claim.lastExtractedSeq),
            "toSeq": .stringConvertible(claim.toSeq),
            "failureCount": .stringConvertible(failureCount),
        ])
    }

    static func broadcastPayload(
        workspaceID: UUID,
        channelID: UUID,
        memoryID: UUID,
        action: String,
        timestampMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
    ) -> String {
        let channel = "ch:ws\(workspaceID.uuidString).\(channelID.uuidString)"
        return jsonString([
            "channel": channel,
            "data": [
                "type": "memory.updated", "v": 1, "ts": timestampMs,
                "payload": [
                    "workspace_id": workspaceID.uuidString,
                    "channel_id": channelID.uuidString,
                    "memory_id": memoryID.uuidString,
                    "action": action,
                ],
            ],
            "idempotency_key": "\(channel):memory.updated:\(memoryID.uuidString):\(action):\(timestampMs)",
        ])
    }

    private static func jsonString(_ object: [String: Any]) -> String {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }
}

enum MemoryExtractionError: Error, Equatable {
    case lostLease
    case candidateInsertFailed
    case memoryMutationFailed
}
