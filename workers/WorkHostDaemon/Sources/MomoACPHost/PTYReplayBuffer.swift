import Foundation

/// One direct host-to-client PTY attach event.
///
/// A transport must encode `.bytes` as binary PTY data and `.replayEnd` as a
/// control frame, never as terminal text. `connect()` enqueues the retained
/// bytes, then exactly one marker, then live bytes while holding the same lock
/// used by `append`. That ordering is the protocol seam: a byte can be either
/// in replay or live, but cannot be duplicated or fall between them.
public enum PTYReplayEvent: Sendable, Equatable {
    case bytes(Data)
    case replayEnd(byteOffset: UInt64)
}

/// Exact control payload for transports that carry replay events over a framed
/// socket. PTY bytes remain binary frames; this JSON text frame is consumed by
/// the attach adapter and must never be written into xterm.
public struct PTYReplayEndFrame: Codable, Sendable, Equatable {
    public let type = "replay_end"
    public let byteOffset: UInt64

    public init(byteOffset: UInt64) {
        self.byteOffset = byteOffset
    }

    enum CodingKeys: String, CodingKey {
        case type
        case byteOffset = "byte_offset"
    }
}

/// Host-local bounded scrollback. Nothing in this type has a server persistence
/// path; losing the daemon loses the buffer, as ADR-0139 D2 requires.
public final class PTYReplayBuffer: @unchecked Sendable {
    public static let defaultCapacityBytes = 256 * 1_024

    private let lock = NSLock()
    private let capacityBytes: Int
    private var retained = Data()
    private var totalByteOffset: UInt64 = 0
    private var subscribers: [UUID: AsyncStream<PTYReplayEvent>.Continuation] = [:]
    private var finished = false

    public init(capacityBytes: Int = PTYReplayBuffer.defaultCapacityBytes) {
        self.capacityBytes = max(1, capacityBytes)
    }

    public var retainedByteCount: Int {
        lock.withLock { retained.count }
    }

    public func append(_ data: Data) {
        guard !data.isEmpty else { return }
        lock.withLock {
            guard !finished else { return }
            totalByteOffset &+= UInt64(data.count)
            retained.append(data)
            if retained.count > capacityBytes {
                retained.removeFirst(retained.count - capacityBytes)
            }
            for continuation in subscribers.values {
                continuation.yield(.bytes(data))
            }
        }
    }

    public func connect() -> AsyncStream<PTYReplayEvent> {
        let pair = AsyncStream<PTYReplayEvent>.makeStream()
        let subscriberID = UUID()
        lock.withLock {
            guard !finished else {
                pair.continuation.finish()
                return
            }
            subscribers[subscriberID] = pair.continuation
            if !retained.isEmpty {
                pair.continuation.yield(.bytes(retained))
            }
            pair.continuation.yield(.replayEnd(byteOffset: totalByteOffset))
        }
        pair.continuation.onTermination = { [weak self] _ in
            self?.removeSubscriber(subscriberID)
        }
        return pair.stream
    }

    public func finish() {
        let continuations = lock.withLock { () -> [AsyncStream<PTYReplayEvent>.Continuation] in
            guard !finished else { return [] }
            finished = true
            let continuations = Array(subscribers.values)
            subscribers.removeAll()
            retained.removeAll()
            return continuations
        }
        for continuation in continuations { continuation.finish() }
    }

    private func removeSubscriber(_ id: UUID) {
        lock.withLock { _ = subscribers.removeValue(forKey: id) }
    }
}
