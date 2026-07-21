import AsyncHTTPClient
import Foundation
import NIOCore

protocol MemoryQueryEmbedding: Sendable {
    func embed(_ text: String) async throws -> [Double]
}

enum MemoryEmbedding {
    static let dimensions = 384

    /// Deterministic feature-hash embedder for local/dev gates. It is deliberately
    /// credential-free and is also used by the mock worker backfill path.
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

    static func vectorLiteral(_ values: [Double]) throws -> String {
        guard values.count == dimensions, values.allSatisfy(\.isFinite) else {
            throw MemoryEmbeddingError.invalidDimensions
        }
        return "[" + values.map { String(format: "%.9g", locale: Locale(identifier: "en_US_POSIX"), $0) }
            .joined(separator: ",") + "]"
    }
}

enum MemoryEmbeddingError: Error {
    case invalidDimensions
    case upstreamStatus(Int)
    case malformedResponse
}

struct MockMemoryQueryEmbedding: MemoryQueryEmbedding {
    func embed(_ text: String) async throws -> [Double] {
        MemoryEmbedding.deterministic(text)
    }
}

struct HermesMemoryQueryEmbedding: MemoryQueryEmbedding {
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
            model: model, input: text, dimensions: MemoryEmbedding.dimensions
        ))))
        let response = try await httpClient.execute(request, timeout: .seconds(30))
        guard response.status == .ok else {
            throw MemoryEmbeddingError.upstreamStatus(Int(response.status.code))
        }
        var buffer = try await response.body.collect(upTo: 2 * 1024 * 1024)
        let data = buffer.readData(length: buffer.readableBytes) ?? Data()
        guard let embedding = try JSONDecoder().decode(ResponseBody.self, from: data).data.first?.embedding,
              embedding.count == MemoryEmbedding.dimensions,
              embedding.allSatisfy(\.isFinite)
        else { throw MemoryEmbeddingError.malformedResponse }
        return embedding
    }
}
