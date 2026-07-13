import XCTest
import MomoCore
@testable import MomoMac

final class MessageTimelineLayoutTests: XCTestCase {
    private let channel = ChannelID()
    private let firstAuthor = MemberID()
    private let secondAuthor = MemberID()

    func testGroupingPreservesInputSequenceOrder() {
        let base = timestamp(year: 2026, month: 7, day: 13, hour: 9)
        let messages = [
            message(seq: 30, author: firstAuthor, timestamp: base),
            message(seq: 10, author: firstAuthor, timestamp: base + 60_000),
            message(seq: 20, author: firstAuthor, timestamp: base + 120_000),
        ]

        let items = MessageTimelineLayout.items(messages: messages, calendar: calendar)

        XCTAssertEqual(items.map(\.message.seq), [30, 10, 20], "Display grouping must never reorder Message.seq input")
        XCTAssertEqual(items.map(\.startsGroup), [true, false, false])
        XCTAssertEqual(items.map(\.startsDay), [true, false, false])
    }

    func testGroupingBreaksForAuthorGapAndDayBoundary() {
        let base = timestamp(year: 2026, month: 7, day: 13, hour: 23, minute: 54)
        let messages = [
            message(seq: 1, author: firstAuthor, timestamp: base),
            message(seq: 2, author: secondAuthor, timestamp: base + 60_000),
            message(seq: 3, author: secondAuthor, timestamp: base + 7 * 60_000),
            message(seq: 4, author: secondAuthor, timestamp: base + 8 * 60_000),
        ]

        let items = MessageTimelineLayout.items(messages: messages, calendar: calendar)

        XCTAssertEqual(items.map(\.startsGroup), [true, true, true, false])
        XCTAssertEqual(items.map(\.startsDay), [true, false, true, false])
        XCTAssertNotEqual(items[0].day, items[2].day)
    }

    func testGroupingUsesHLCWhenCreatedAtIsUnavailable() {
        let base = timestamp(year: 2026, month: 7, day: 13, hour: 9)
        var first = message(seq: 1, author: firstAuthor, timestamp: base)
        var second = message(seq: 2, author: firstAuthor, timestamp: base + 60_000)
        first.createdAtMs = nil
        second.createdAtMs = nil

        let items = MessageTimelineLayout.items(messages: [first, second], calendar: calendar)

        XCTAssertEqual(items.map(\.startsGroup), [true, false])
        XCTAssertNotNil(items.first?.day)
    }

    func testGroupingIntervalIsInclusiveAtFiveMinutes() {
        let base = timestamp(year: 2026, month: 7, day: 13, hour: 9)
        let messages = [
            message(seq: 1, author: firstAuthor, timestamp: base),
            message(seq: 2, author: firstAuthor, timestamp: base + 5 * 60_000),
            message(seq: 3, author: firstAuthor, timestamp: base + 10 * 60_000 + 1),
        ]

        let items = MessageTimelineLayout.items(messages: messages, calendar: calendar)

        XCTAssertEqual(items.map(\.startsGroup), [true, false, true])
    }

    func testScrollPolicyFollowsOnlyWhenAlreadyAtBottom() {
        XCTAssertTrue(MessageTimelineScrollPolicy.shouldFollowNewContent(wasAtBottom: true))
        XCTAssertFalse(MessageTimelineScrollPolicy.shouldFollowNewContent(wasAtBottom: false))
        XCTAssertTrue(
            MessageTimelineScrollPolicy.shouldFollowNewContent(
                wasAtBottom: false,
                isOwnSend: true
            ),
            "own sends must always remain visible even after reading older history"
        )
    }

    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar
    }

    private func timestamp(
        year: Int,
        month: Int,
        day: Int,
        hour: Int,
        minute: Int = 0
    ) -> Int64 {
        let date = calendar.date(from: DateComponents(
            year: year,
            month: month,
            day: day,
            hour: hour,
            minute: minute
        ))!
        return Int64(date.timeIntervalSince1970 * 1_000)
    }

    private func message(seq: Int64, author: MemberID, timestamp: Int64) -> Message {
        Message(
            id: MessageID(),
            channelId: channel,
            seq: seq,
            hlcTs: timestamp,
            authorMemberId: author,
            body: "내부 팀 메시지 \(seq)",
            createdAtMs: timestamp
        )
    }
}
