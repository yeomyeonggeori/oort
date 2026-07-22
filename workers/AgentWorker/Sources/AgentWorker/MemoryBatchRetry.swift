import Foundation

struct MemoryBatchRetryDecision: Equatable, Sendable {
    let delay: Duration
    let failureCount: Int
    let shouldPoison: Bool
}

/// Shared retry discipline for memory extraction and embedding batches.
/// Backoff spans consecutive worker failures, while poison counting is scoped
/// to one stable batch key. Only a successful batch resets the backoff.
struct MemoryBatchRetryState<BatchKey: Hashable & Sendable>: Sendable {
    let baseDelay: Duration
    let maximumDelay: Duration
    let poisonThreshold: Int

    private(set) var nextDelay: Duration
    private(set) var batchFailureCounts: [BatchKey: Int] = [:]

    init(
        baseDelay: Duration,
        maximumDelay: Duration = .seconds(300),
        poisonThreshold: Int = 5
    ) {
        precondition(baseDelay > .zero)
        precondition(poisonThreshold > 0)
        let boundedBaseDelay = min(baseDelay, maximumDelay)
        self.baseDelay = boundedBaseDelay
        self.maximumDelay = maximumDelay
        self.poisonThreshold = poisonThreshold
        self.nextDelay = boundedBaseDelay
    }

    mutating func recordFailure(for batchKey: BatchKey) -> MemoryBatchRetryDecision {
        let batchFailureCount = batchFailureCounts[batchKey, default: 0] + 1
        batchFailureCounts[batchKey] = batchFailureCount
        let decision = MemoryBatchRetryDecision(
            delay: nextDelay,
            failureCount: batchFailureCount,
            shouldPoison: batchFailureCount >= poisonThreshold
        )
        nextDelay = min(maximumDelay, nextDelay * 2)
        return decision
    }

    mutating func recordSuccess(for batchKey: BatchKey) {
        nextDelay = baseDelay
        batchFailureCounts[batchKey] = nil
    }

    mutating func recordPoisonHandled(for batchKey: BatchKey) {
        batchFailureCounts[batchKey] = nil
    }
}

protocol MemoryWorkerSleeping: Sendable {
    func sleep(for duration: Duration) async
}

struct TaskMemoryWorkerSleeper: MemoryWorkerSleeping {
    func sleep(for duration: Duration) async {
        try? await Task.sleep(for: duration)
    }
}
