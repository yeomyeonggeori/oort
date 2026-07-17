import Foundation

/// Per-registered-server sliding 60-second window (ADR-0120 D5 / Zulip model).
actor ServerRateLimiter {
    private let limit: Int
    private let window: TimeInterval
    private var acceptedAt: [String: [Date]] = [:]

    init(limit: Int, window: TimeInterval = 60) {
        self.limit = limit
        self.window = window
    }

    func allow(serverID: String, now: Date = Date()) -> Bool {
        let cutoff = now.addingTimeInterval(-window)
        var timestamps = (acceptedAt[serverID] ?? []).filter { $0 > cutoff }
        guard timestamps.count < limit else {
            acceptedAt[serverID] = timestamps
            return false
        }
        timestamps.append(now)
        acceptedAt[serverID] = timestamps
        return true
    }
}
