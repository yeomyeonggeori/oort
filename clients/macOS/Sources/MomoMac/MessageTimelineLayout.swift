import Foundation
import MomoCore

/// Display-only grouping metadata for the already seq-ordered channel timeline.
/// This layer deliberately preserves input order; Message.seq remains authoritative.
struct MessageTimelineItem: Identifiable, Equatable {
    var id: MessageID { message.id }
    let message: Message
    let day: Date?
    let startsDay: Bool
    let startsGroup: Bool
}

enum MessageTimelineLayout {
    static let groupingIntervalMs: Int64 = 5 * 60 * 1_000

    static func items(
        messages: [Message],
        calendar: Calendar = .autoupdatingCurrent
    ) -> [MessageTimelineItem] {
        var previous: Message?
        var previousDay: Date?

        return messages.map { message in
            let day = day(for: message, calendar: calendar)
            let startsDay = previous == nil || day != previousDay
            let startsGroup = startsDay || !canGroup(previous, with: message, calendar: calendar)
            defer {
                previous = message
                previousDay = day
            }
            return MessageTimelineItem(
                message: message,
                day: day,
                startsDay: startsDay,
                startsGroup: startsGroup
            )
        }
    }

    static func timestampMs(for message: Message) -> Int64? {
        if let createdAtMs = message.createdAtMs {
            return createdAtMs
        }
        return message.hlcTs > 0 ? message.hlcTs : nil
    }

    private static func day(for message: Message, calendar: Calendar) -> Date? {
        guard let timestampMs = timestampMs(for: message) else { return nil }
        return calendar.startOfDay(for: Date(timeIntervalSince1970: Double(timestampMs) / 1_000))
    }

    private static func canGroup(
        _ previous: Message?,
        with message: Message,
        calendar: Calendar
    ) -> Bool {
        guard let previous,
              previous.authorMemberId == message.authorMemberId,
              let previousTimestamp = timestampMs(for: previous),
              let timestamp = timestampMs(for: message),
              timestamp >= previousTimestamp,
              timestamp - previousTimestamp <= groupingIntervalMs
        else {
            return false
        }

        let previousDate = Date(timeIntervalSince1970: Double(previousTimestamp) / 1_000)
        let date = Date(timeIntervalSince1970: Double(timestamp) / 1_000)
        return calendar.isDate(previousDate, inSameDayAs: date)
    }
}

enum MessageTimelineScrollPolicy {
    /// Follow new content when the reader was already at the bottom. An own
    /// send always follows so the local composer action never lands offscreen.
    static func shouldFollowNewContent(wasAtBottom: Bool, isOwnSend: Bool = false) -> Bool {
        wasAtBottom || isOwnSend
    }
}
