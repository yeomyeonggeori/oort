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
    let logger: Logger

    func run() async throws {
        logger.info("memory embedding worker starting", metadata: [
            "provider": .string(provider.kind),
            "dimensions": .stringConvertible(WorkerMemoryEmbedding.dimensions),
            "batchSize": .stringConvertible(batchSize),
        ])
        while !Task.isCancelled {
            do {
                _ = try await backfillOnce()
            } catch {
                logger.error("memory embedding backfill failed", metadata: [
                    "errorType": .string(String(describing: type(of: error))),
                ])
            }
            try? await Task.sleep(for: pollInterval)
        }
    }

    @discardableResult
    func backfillOnce() async throws -> Int {
        let rows = try await pg.query(
            """
            SELECT id, body
              FROM memory_item
             WHERE invalid_at IS NULL AND embedding IS NULL
             ORDER BY updated_at, id
             LIMIT \(batchSize)
            """,
            logger: logger
        ).collect()
        var updated = 0
        for row in rows {
            if Task.isCancelled { break }
            let (memoryID, body) = try row.decode((UUID, String).self)
            let vector = try WorkerMemoryEmbedding.literal(try await provider.embed(body))
            let result = try await pg.query(
                """
                UPDATE memory_item
                   SET embedding = \(vector)::vector(384)
                 WHERE id = \(memoryID) AND invalid_at IS NULL AND embedding IS NULL
                RETURNING id
                """,
                logger: logger
            ).collect()
            if !result.isEmpty { updated += 1 }
        }
        return updated
    }
}
