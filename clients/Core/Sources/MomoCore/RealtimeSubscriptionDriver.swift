import Foundation

public typealias RealtimeBackfill = @Sendable (_ after: Int64, _ limit: Int) async throws -> [Message]

/// Raw realtime transport boundary. A SwiftCentrifuge adapter should implement
/// this protocol and only hand decoded momo envelopes to the shared driver.
public protocol RealtimeEnvelopeSubscriptionTransport: Sendable {
    func envelopes(channel: ChannelID) async throws -> AsyncThrowingStream<RealtimeEnvelope, Error>
}

/// ChatBackend-facing realtime driver. It owns transport subscribe/recovery and
/// emits only events that passed `message.seq` replay/gap checks.
public protocol RealtimeSubscriptionDriver: Sendable {
    func subscribe(
        channel: ChannelID,
        startingAfter lastAppliedSeq: Int64,
        backfill: @escaping RealtimeBackfill
    ) async throws -> AsyncStream<RealtimeEvent>
}

public actor DefaultRealtimeSubscriptionDriver: RealtimeSubscriptionDriver {
    private let transport: any RealtimeEnvelopeSubscriptionTransport
    private let backfillLimit: Int
    private let maxBackfillPages: Int

    public init(
        transport: any RealtimeEnvelopeSubscriptionTransport,
        backfillLimit: Int = 200,
        maxBackfillPages: Int = 3
    ) {
        self.transport = transport
        self.backfillLimit = backfillLimit
        self.maxBackfillPages = maxBackfillPages
    }

    public func subscribe(
        channel: ChannelID,
        startingAfter lastAppliedSeq: Int64,
        backfill: @escaping RealtimeBackfill
    ) async throws -> AsyncStream<RealtimeEvent> {
        let envelopes = try await transport.envelopes(channel: channel)
        let controller = RealtimeReplayController(
            channel: channel,
            lastAppliedSeq: lastAppliedSeq,
            backfillLimit: backfillLimit,
            maxBackfillPages: maxBackfillPages
        )

        return AsyncStream { continuation in
            let task = Task {
                do {
                    for try await envelope in envelopes {
                        let events = try await controller.process(envelope, backfill: backfill)
                        for event in events {
                            continuation.yield(event)
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish()
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

public struct RealtimeReplaySnapshot: Sendable, Hashable {
    public var channel: ChannelID
    public var lastAppliedSeq: Int64
    public var pendingSeqs: [Int64]
    public var seenMessageIDs: Set<MessageID>
}

/// Deterministic replay/gap controller for MOMO-179/MOMO-193.
///
/// Ordering authority is `Message.seq`; Centrifugo offset/recovery metadata is
/// intentionally absent here. The controller is transport-agnostic so tests can
/// exercise duplicate, gap, and REST backfill behavior without a live server.
public actor RealtimeReplayController {
    private let channel: ChannelID
    private let backfillLimit: Int
    private let maxBackfillPages: Int
    private var lastAppliedSeq: Int64
    private var pendingBySeq: [Int64: RealtimeEnvelope] = [:]
    private var seenMessageIDs: Set<MessageID> = []

    public init(
        channel: ChannelID,
        lastAppliedSeq: Int64 = 0,
        backfillLimit: Int = 200,
        maxBackfillPages: Int = 3,
        seenMessageIDs: Set<MessageID> = []
    ) {
        self.channel = channel
        self.lastAppliedSeq = lastAppliedSeq
        self.backfillLimit = backfillLimit
        self.maxBackfillPages = maxBackfillPages
        self.seenMessageIDs = seenMessageIDs
    }

    public func snapshot() -> RealtimeReplaySnapshot {
        RealtimeReplaySnapshot(
            channel: channel,
            lastAppliedSeq: lastAppliedSeq,
            pendingSeqs: pendingBySeq.keys.sorted(),
            seenMessageIDs: seenMessageIDs
        )
    }

    public func process(
        _ envelope: RealtimeEnvelope,
        backfill: RealtimeBackfill
    ) async throws -> [RealtimeEvent] {
        guard let seq = envelope.seq else {
            return try nonSequencedEvents(from: envelope)
        }

        if seq <= lastAppliedSeq {
            pendingBySeq.removeValue(forKey: seq)
            return []
        }

        if seq == lastAppliedSeq + 1 {
            var emitted = try apply(envelope, seq: seq)
            emitted += try await drainPending(backfill: backfill)
            return emitted
        }

        pendingBySeq[seq] = envelope
        var emitted = try await fillGap(targetSeq: seq, backfill: backfill)
        emitted += try await drainPending(backfill: backfill)
        return emitted
    }

    public func backfillFromCurrent(_ backfill: RealtimeBackfill) async throws -> [RealtimeEvent] {
        try await fillGap(targetSeq: Int64.max, backfill: backfill)
    }

    private func nonSequencedEvents(from envelope: RealtimeEnvelope) throws -> [RealtimeEvent] {
        let event = try envelope.decodeEvent()
        switch event {
        case .agentPartial, .agentStatus, .typing, .presence:
            return [event]
        case .message, .messageEdited, .messageDeleted, .reaction, .approval:
            return []
        }
    }

    private func fillGap(targetSeq: Int64, backfill: RealtimeBackfill) async throws -> [RealtimeEvent] {
        var emitted: [RealtimeEvent] = []
        var pages = 0

        while lastAppliedSeq < targetSeq && pages < maxBackfillPages {
            let after = lastAppliedSeq
            let page = try await backfill(after, backfillLimit)
                .compactMap { message -> Message? in
                    guard message.channelId == channel, message.seq != nil else { return nil }
                    return message
                }
                .sorted { ($0.seq ?? 0) < ($1.seq ?? 0) }

            if page.isEmpty {
                break
            }

            var advanced = false
            for message in page {
                guard let seq = message.seq else { continue }
                if seq <= lastAppliedSeq {
                    continue
                }
                guard seq == lastAppliedSeq + 1 else {
                    break
                }
                lastAppliedSeq = seq
                advanced = true
                pendingBySeq.removeValue(forKey: seq)
                if seenMessageIDs.insert(message.id).inserted {
                    emitted.append(.message(message))
                }
            }

            pages += 1
            removeObsoletePending()
            if !advanced || page.count < backfillLimit {
                break
            }
        }

        return emitted
    }

    private func drainPending(backfill: RealtimeBackfill) async throws -> [RealtimeEvent] {
        var emitted: [RealtimeEvent] = []
        removeObsoletePending()

        while let envelope = pendingBySeq[lastAppliedSeq + 1],
              let seq = envelope.seq {
            pendingBySeq.removeValue(forKey: seq)
            emitted += try apply(envelope, seq: seq)
        }

        if let nextSeq = pendingBySeq.keys.min(), nextSeq > lastAppliedSeq + 1 {
            emitted += try await fillGap(targetSeq: nextSeq, backfill: backfill)
            if pendingBySeq[lastAppliedSeq + 1] != nil {
                emitted += try await drainPending(backfill: backfill)
            }
        }

        return emitted
    }

    private func apply(_ envelope: RealtimeEnvelope, seq: Int64) throws -> [RealtimeEvent] {
        let event = try envelope.decodeEvent()
        lastAppliedSeq = seq

        switch event {
        case .message(let message):
            guard seenMessageIDs.insert(message.id).inserted else {
                return []
            }
            return [event]
        case .messageEdited(let message):
            seenMessageIDs.insert(message.id)
            return [event]
        case .messageDeleted, .reaction, .approval:
            return [event]
        case .agentPartial, .agentStatus, .typing, .presence:
            return [event]
        }
    }

    private func removeObsoletePending() {
        for seq in pendingBySeq.keys where seq <= lastAppliedSeq {
            pendingBySeq.removeValue(forKey: seq)
        }
    }
}
