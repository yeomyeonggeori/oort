import AsyncHTTPClient
import Foundation
import Logging
import NIOCore
import PostgresNIO
import ServiceLifecycle

protocol MemoryEmbeddingProvider: Sendable {
    var kind: String { get }
    func embed(_ text: String) async throws -> [Double]
}

enum WorkerMemoryEmbedding {
    static let dimensions = 384

    static func deterministic(_ text: String) -> [Double] {
        var values = Array(repeating: 0.0, count: dimensions)
        let scalars = Array(text.lowercased().unicodeScalars)
        guard !scalars.isEmpty else { return values }
        for index in scalars.indices {
            var hash: UInt64 = 14_695_981_039_346_656_037
            for scalar in scalars[index..<min(index + 3, scalars.endIndex)] {
                hash ^= UInt64(scalar.value)
                hash = hash &* 1_099_511_628_211
            }
            let slot = Int(hash % UInt64(dimensions))
            values[slot] += (hash & 1) == 0 ? 1 : -1
        }
        let norm = sqrt(values.reduce(0) { $0 + $1 * $1 })
        return norm > 0 ? values.map { $0 / norm } : values
    }

    static func literal(_ values: [Double]) throws -> String {
        guard values.count == dimensions, values.allSatisfy(\.isFinite) else {
            throw MemoryEmbeddingServiceError.invalidDimensions
        }
        return "[" + values.map { String(format: "%.9g", locale: Locale(identifier: "en_US_POSIX"), $0) }
            .joined(separator: ",") + "]"
    }
}

enum MemoryEmbeddingServiceError: Error {
    case invalidDimensions
    case upstreamStatus(Int)
    case malformedResponse
}

struct MockMemoryEmbeddingProvider: MemoryEmbeddingProvider {
    let kind = "mock"
    func embed(_ text: String) async throws -> [Double] {
        WorkerMemoryEmbedding.deterministic(text)
    }
}

/// OpenAI-compatible `/v1/embeddings` over the existing BYOA Hermes boundary.
/// The bearer remains process-local and is never persisted or logged.
struct HermesMemoryEmbeddingProvider: MemoryEmbeddingProvider {
    let kind = "hermes"
    let httpClient: HTTPClient
    let baseURL: String
    let apiKey: String
    let model: String

    private struct RequestBody: Encodable {
        let model: String
        let input: String
        let dimensions: Int
    }
    private struct ResponseBody: Decodable {
        struct Item: Decodable { let embedding: [Double] }
        let data: [Item]
    }

    func embed(_ text: String) async throws -> [Double] {
        var request = HTTPClientRequest(url: "\(baseURL)/embeddings")
        request.method = .POST
        request.headers.add(name: "Content-Type", value: "application/json")
        request.headers.add(name: "Authorization", value: "Bearer \(apiKey)")
        request.body = .bytes(ByteBuffer(data: try JSONEncoder().encode(RequestBody(
            model: model, input: text, dimensions: WorkerMemoryEmbedding.dimensions
        ))))
        let response = try await httpClient.execute(request, timeout: .seconds(30))
        guard response.status == .ok else {
            throw MemoryEmbeddingServiceError.upstreamStatus(Int(response.status.code))
        }
        var buffer = try await response.body.collect(upTo: 2 * 1024 * 1024)
        let data = buffer.readData(length: buffer.readableBytes) ?? Data()
        guard let embedding = try JSONDecoder().decode(ResponseBody.self, from: data).data.first?.embedding,
              embedding.count == WorkerMemoryEmbedding.dimensions,
              embedding.allSatisfy(\.isFinite)
        else { throw MemoryEmbeddingServiceError.malformedResponse }
        return embedding
    }
}

struct MemoryEmbeddingService: Service, Sendable {
    let pg: PostgresClient
    let provider: any MemoryEmbeddingProvider
    let pollInterval: Duration
    let batchSize: Int
    let poisonThreshold: Int
    let logger: Logger
    let sleeper: any MemoryWorkerSleeping

    init(
        pg: PostgresClient,
        provider: any MemoryEmbeddingProvider,
        pollInterval: Duration,
        batchSize: Int,
        poisonThreshold: Int = 5,
        logger: Logger,
        sleeper: any MemoryWorkerSleeping = TaskMemoryWorkerSleeper()
    ) {
        self.pg = pg
        self.provider = provider
        self.pollInterval = pollInterval
        self.batchSize = batchSize
        self.poisonThreshold = poisonThreshold
        self.logger = logger
        self.sleeper = sleeper
    }

    private struct Item: Sendable {
        let id: UUID
        let body: String
    }

    private struct Batch: Sendable {
        let workspaceID: UUID
        let items: [Item]

        var retryKey: [UUID] { items.map(\.id) }
        var auditKey: String { retryKey.map(\.uuidString).joined(separator: ":") }
    }

    func run() async throws {
        logger.info("memory embedding worker starting", metadata: [
            "provider": .string(provider.kind),
            "dimensions": .stringConvertible(WorkerMemoryEmbedding.dimensions),
            "batchSize": .stringConvertible(batchSize),
        ])
        var retry = MemoryBatchRetryState<[UUID]>(
            baseDelay: pollInterval,
            poisonThreshold: poisonThreshold
        )
        while !Task.isCancelled {
            var delay = pollInterval
            do {
                if let batch = try await loadBatch() {
                    do {
                        _ = try await backfill(batch)
                        retry.recordSuccess(for: batch.retryKey)
                    } catch {
                        let decision = retry.recordFailure(for: batch.retryKey)
                        delay = decision.delay
                        logger.error("memory embedding backfill failed", metadata: [
                            "workspaceId": .string(batch.workspaceID.uuidString),
                            "failureCount": .stringConvertible(decision.failureCount),
                            "errorType": .string(String(describing: type(of: error))),
                        ])
                        if decision.shouldPoison {
                            try await poison(batch, failureCount: decision.failureCount)
                            retry.recordPoisonHandled(for: batch.retryKey)
                        }
                    }
                }
            } catch {
                logger.error("memory embedding drain failed", metadata: [
                    "errorType": .string(String(describing: type(of: error))),
                ])
            }
            await sleeper.sleep(for: delay)
        }
    }

    @discardableResult
    func backfillOnce() async throws -> Int {
        guard let batch = try await loadBatch() else { return 0 }
        return try await backfill(batch)
    }

    private func loadBatch() async throws -> Batch? {
        let rows = try await pg.query(
            """
            WITH target_workspace AS (
              SELECT mi.workspace_id
                FROM memory_item mi
               WHERE mi.invalid_at IS NULL
                 AND mi.embedding IS NULL
                 AND NOT EXISTS (
                   SELECT 1
                     FROM audit_log poisoned
                    WHERE poisoned.workspace_id = mi.workspace_id
                      AND poisoned.action = 'memory.embedding.poisoned'
                      AND poisoned.target_type = 'memory_embedding_batch'
                      AND (poisoned.detail->'memory_ids') ? mi.id::text
                 )
               ORDER BY mi.updated_at, mi.id
               LIMIT 1
            )
            SELECT mi.workspace_id, mi.id, mi.body
              FROM memory_item mi
              JOIN target_workspace tw ON tw.workspace_id = mi.workspace_id
             WHERE mi.invalid_at IS NULL
               AND mi.embedding IS NULL
               AND NOT EXISTS (
                 SELECT 1
                   FROM audit_log poisoned
                  WHERE poisoned.workspace_id = mi.workspace_id
                    AND poisoned.action = 'memory.embedding.poisoned'
                    AND poisoned.target_type = 'memory_embedding_batch'
                    AND (poisoned.detail->'memory_ids') ? mi.id::text
               )
             ORDER BY mi.updated_at, mi.id
             LIMIT \(batchSize)
            """,
            logger: logger
        ).collect()
        guard let first = rows.first else { return nil }
        let workspaceID = try first.decode((UUID, UUID, String).self).0
        let items = try rows.map { row -> Item in
            let (_, id, body) = try row.decode((UUID, UUID, String).self)
            return .init(id: id, body: body)
        }
        return .init(workspaceID: workspaceID, items: items)
    }

    private func backfill(_ batch: Batch) async throws -> Int {
        var vectors: [(UUID, String)] = []
        for item in batch.items {
            if Task.isCancelled { break }
            let vector = try WorkerMemoryEmbedding.literal(try await provider.embed(item.body))
            vectors.append((item.id, vector))
        }
        return try await pg.withTransaction(logger: logger) { conn in
            var updated = 0
            for (memoryID, vector) in vectors {
                let result = try await conn.query(
                    """
                    UPDATE memory_item
                       SET embedding = \(vector)::vector(384)
                     WHERE workspace_id = \(batch.workspaceID)
                       AND id = \(memoryID)
                       AND invalid_at IS NULL
                       AND embedding IS NULL
                    RETURNING id
                    """,
                    logger: logger
                ).collect()
                if !result.isEmpty { updated += 1 }
            }
            return updated
        }
    }

    /// audit_log is the durable poison marker: loadBatch excludes every ID in
    /// this one event, which advances the embedding worker without a schema change.
    private func poison(_ batch: Batch, failureCount: Int) async throws {
        let memoryIDs = Self.jsonString(batch.retryKey.map(\.uuidString))
        try await pg.withTransaction(logger: logger) { conn in
            _ = try await conn.query(
                "SELECT pg_advisory_xact_lock(hashtextextended(\(batch.auditKey), 0))",
                logger: logger
            )
            _ = try await conn.query(
                """
                INSERT INTO audit_log
                  (workspace_id, actor_member_id, action, target_type, target_id, detail)
                SELECT \(batch.workspaceID), NULL::uuid, 'memory.embedding.poisoned',
                       'memory_embedding_batch', \(batch.items[0].id),
                       jsonb_build_object(
                         'batch_key', \(batch.auditKey),
                         'memory_ids', \(memoryIDs)::jsonb,
                         'failure_count', \(failureCount),
                         'provider_kind', \(provider.kind))
                 WHERE NOT EXISTS (
                   SELECT 1 FROM audit_log
                    WHERE workspace_id = \(batch.workspaceID)
                      AND action = 'memory.embedding.poisoned'
                      AND detail->>'batch_key' = \(batch.auditKey)
                 )
                """,
                logger: logger
            )
        }
        logger.warning("memory embedding poison batch skipped", metadata: [
            "workspaceId": .string(batch.workspaceID.uuidString),
            "failureCount": .stringConvertible(failureCount),
            "itemCount": .stringConvertible(batch.items.count),
        ])
    }

    private static func jsonString(_ value: [String]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return "[]" }
        return String(decoding: data, as: UTF8.self)
    }
}
