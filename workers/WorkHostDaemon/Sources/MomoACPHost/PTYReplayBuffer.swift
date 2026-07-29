import Foundation

/// One direct host-to-client PTY attach event.
///
/// A transport must encode `.bytes` as binary PTY data and `.replayEnd` /
/// `.overflow` as control frames, never as terminal text. `connect()` enqueues
/// the retained bytes, then exactly one marker, then live bytes while holding
/// the same lock used by `append`. That ordering is the protocol seam: a byte
/// can be either in replay or live, but cannot be duplicated or fall between
/// them.
public enum PTYReplayEvent: Sendable, Equatable {
    case bytes(Data)
    case replayEnd(byteOffset: UInt64)
    /// MOMO-661: this subscriber fell too far behind and was severed at
    /// `byteOffset`. It is always the last event on the stream. The contract is
    /// deliberately "you have a gap, resynchronize", not "here are some of the
    /// bytes": see `PTYReplayBuffer` for why silent dropping is not an option.
    case overflow(byteOffset: UInt64)
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

/// Terminal counterpart of `PTYReplayEndFrame`. A client that receives it knows
/// its stream ended with an unrecoverable gap at `byteOffset` and that a fresh
/// `connect()` is the resynchronization path.
public struct PTYReplayOverflowFrame: Codable, Sendable, Equatable {
    public let type = "replay_overflow"
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
///
/// MOMO-661: the retained ring was already bounded, but each attached
/// subscriber used to hold an unbounded `AsyncStream` continuation buffer, so a
/// stalled attach client grew daemon memory without limit. Every subscriber now
/// owns an explicitly bounded pending queue, and the stream is produced by
/// `AsyncStream(unfolding:)` so the queue drains only when the consumer
/// actually pulls — which is what makes the accounting exact.
///
/// Overflow severs the subscriber instead of dropping frames. A PTY stream is
/// contiguous bytes with no framing a client can resynchronize on, so dropping
/// the oldest (or newest) frames would feed xterm a silently corrupted byte
/// stream that renders as garbage with no signal that anything was lost.
/// Severing reuses the contract that already exists: the client sees
/// `.overflow`, reconnects, and `connect()` replays the bounded ring and emits
/// a fresh `.replayEnd` offset. No new gap protocol is invented.
public final class PTYReplayBuffer: @unchecked Sendable {
    public static let defaultCapacityBytes = 256 * 1_024

    /// Default per-subscriber queue headroom, as a multiple of the retained
    /// ring. The lower bound matters: `connect()` enqueues the whole retained
    /// ring at once, so a limit below `capacityBytes` would sever every
    /// subscriber on attach.
    public static let defaultSubscriberQueueMultiple = 4

    /// Every field is read and written only while `PTYReplayBuffer.lock` is
    /// held; the reference is shared with the unfolding closure so it must be
    /// nominally Sendable.
    private final class Subscriber: @unchecked Sendable {
        let maxQueuedBytes: Int
        var queue: [PTYReplayEvent] = []
        var queuedBytes = 0
        var waiter: CheckedContinuation<PTYReplayEvent?, Never>?
        /// Set once the subscriber is severed or the buffer finished. Pending
        /// events already queued are still delivered before `nil`.
        var closed = false

        init(maxQueuedBytes: Int) {
            self.maxQueuedBytes = maxQueuedBytes
        }

        func enqueue(_ event: PTYReplayEvent, byteOffset: UInt64) {
            guard !closed else { return }
            let size: Int
            if case .bytes(let data) = event { size = data.count } else { size = 0 }
            guard queuedBytes + size <= maxQueuedBytes else {
                queue.removeAll()
                queuedBytes = 0
                queue.append(.overflow(byteOffset: byteOffset))
                closed = true
                return
            }
            queue.append(event)
            queuedBytes += size
        }

        func dequeue() -> PTYReplayEvent? {
            guard !queue.isEmpty else { return nil }
            let event = queue.removeFirst()
            if case .bytes(let data) = event { queuedBytes -= data.count }
            return event
        }
    }

    private let lock = NSLock()
    private let capacityBytes: Int
    private let subscriberQueueBytes: Int
    private var retained = Data()
    private var totalByteOffset: UInt64 = 0
    private var subscribers: [UUID: Subscriber] = [:]
    private var finished = false

    public init(
        capacityBytes: Int = PTYReplayBuffer.defaultCapacityBytes,
        subscriberQueueBytes: Int? = nil
    ) {
        let capacity = max(1, capacityBytes)
        self.capacityBytes = capacity
        // Never below the ring: the attach replay must always fit.
        self.subscriberQueueBytes = max(
            capacity,
            subscriberQueueBytes ?? capacity * Self.defaultSubscriberQueueMultiple
        )
    }

    public var retainedByteCount: Int {
        lock.withLock { retained.count }
    }

    /// Test/diagnostic view of live subscribers and their pending bytes. A
    /// severed subscriber is gone from this map once its terminal event is
    /// consumed, so an unbounded-growth regression shows up here directly.
    public var subscriberQueuedByteCounts: [Int] {
        lock.withLock { subscribers.values.map(\.queuedBytes).sorted() }
    }

    public func append(_ data: Data) {
        guard !data.isEmpty else { return }
        var wakeups: [(CheckedContinuation<PTYReplayEvent?, Never>, PTYReplayEvent?)] = []
        lock.withLock {
            guard !finished else { return }
            totalByteOffset &+= UInt64(data.count)
            retained.append(data)
            if retained.count > capacityBytes {
                retained.removeFirst(retained.count - capacityBytes)
            }
            for subscriber in subscribers.values {
                subscriber.enqueue(.bytes(data), byteOffset: totalByteOffset)
                guard let waiter = subscriber.waiter else { continue }
                if let event = subscriber.dequeue() {
                    subscriber.waiter = nil
                    wakeups.append((waiter, event))
                } else if subscriber.closed {
                    subscriber.waiter = nil
                    wakeups.append((waiter, nil))
                }
            }
        }
        // Continuations are resumed outside the lock so a consumer that calls
        // straight back into the buffer cannot deadlock against `append`.
        for (continuation, event) in wakeups { continuation.resume(returning: event) }
    }

    public func connect() -> AsyncStream<PTYReplayEvent> {
        let subscriber = Subscriber(maxQueuedBytes: subscriberQueueBytes)
        let subscriberID = UUID()
        lock.withLock {
            guard !finished else {
                subscriber.closed = true
                return
            }
            if !retained.isEmpty {
                subscriber.enqueue(
                    .bytes(retained),
                    byteOffset: totalByteOffset
                )
            }
            subscriber.enqueue(
                .replayEnd(byteOffset: totalByteOffset),
                byteOffset: totalByteOffset
            )
            subscribers[subscriberID] = subscriber
        }
        return AsyncStream(
            unfolding: { [weak self] in
                await self?.next(subscriberID, subscriber) ?? nil
            },
            onCancel: { [weak self] in
                self?.removeSubscriber(subscriberID)
            }
        )
    }

    public func finish() {
        var wakeups: [CheckedContinuation<PTYReplayEvent?, Never>] = []
        lock.withLock {
            guard !finished else { return }
            finished = true
            for subscriber in subscribers.values {
                subscriber.closed = true
                subscriber.queue.removeAll()
                subscriber.queuedBytes = 0
                if let waiter = subscriber.waiter {
                    subscriber.waiter = nil
                    wakeups.append(waiter)
                }
            }
            subscribers.removeAll()
            retained.removeAll()
        }
        for continuation in wakeups { continuation.resume(returning: nil) }
    }

    private func next(
        _ subscriberID: UUID,
        _ subscriber: Subscriber
    ) async -> PTYReplayEvent? {
        await withCheckedContinuation { continuation in
            lock.lock()
            if let event = subscriber.dequeue() {
                lock.unlock()
                continuation.resume(returning: event)
                return
            }
            if subscriber.closed {
                subscribers.removeValue(forKey: subscriberID)
                lock.unlock()
                continuation.resume(returning: nil)
                return
            }
            subscriber.waiter = continuation
            lock.unlock()
        }
    }

    private func removeSubscriber(_ id: UUID) {
        var waiter: CheckedContinuation<PTYReplayEvent?, Never>?
        lock.withLock {
            guard let subscriber = subscribers.removeValue(forKey: id) else { return }
            subscriber.closed = true
            waiter = subscriber.waiter
            subscriber.waiter = nil
        }
        waiter?.resume(returning: nil)
    }
}
