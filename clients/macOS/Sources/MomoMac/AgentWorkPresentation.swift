import Foundation
import MomoCore

struct AgentWorkCommand: Equatable {
    let brief: String
    let draftToRestore: String
}

enum AgentWorkCommandParser {
    static func parse(_ draft: String) -> AgentWorkCommand? {
        let normalized = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard normalized == "/work" || normalized.hasPrefix("/work ") else {
            return nil
        }
        let brief = String(normalized.dropFirst("/work".count))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return AgentWorkCommand(brief: brief, draftToRestore: draft)
    }
}

enum AgentWorkResultTone: Equatable {
    case success
    case neutral
    case failure
}

enum AgentWorkResultPresentation {
    static func tone(for status: RunStatus) -> AgentWorkResultTone {
        switch status {
        case .succeeded:
            return .success
        case .failed, .timedOut:
            return .failure
        case .queued, .running, .awaitingApproval, .paused, .cancelled:
            return .neutral
        }
    }
}

enum AgentWorkTimelineEntry: Identifiable, Equatable {
    case message(MessageTimelineItem)
    case work(runId: RunID, day: Date?, startsDay: Bool)

    var id: String {
        switch self {
        case .message(let item):
            return "message-\(item.id.description)"
        case .work(let runId, _, _):
            return "work-\(runId.description)"
        }
    }
}

enum AgentWorkTimelinePolicy {
    private enum RawEntry {
        case message(Message)
        case work(runId: RunID, timestampMs: Int64)
    }

    /// Replaces the first durable event for each Work run with its compact card.
    /// Message order remains untouched, and grouping restarts across the card.
    /// Runs without an event yet are placed by creation time and fall back to the
    /// end when the surrounding messages do not expose timestamps.
    static func entries(
        messages: [Message],
        runs: [AgentWorkRun]
    ) -> [AgentWorkTimelineEntry] {
        let runsById = Dictionary(uniqueKeysWithValues: runs.map { ($0.id, $0) })
        let anchoredRunIds = Set(messages.compactMap { message in
            message.runId.flatMap { runsById[$0] == nil ? nil : $0 }
        })
        let unanchoredRuns = runs
            .filter { !anchoredRunIds.contains($0.id) }
            .sorted { ($0.createdAtMs, $0.id.description) < ($1.createdAtMs, $1.id.description) }

        var rawEntries: [RawEntry] = []
        var emittedRunIds: Set<RunID> = []
        var unanchoredIndex = 0

        for message in messages {
            if let timestamp = MessageTimelineLayout.timestampMs(for: message) {
                while unanchoredIndex < unanchoredRuns.count,
                      unanchoredRuns[unanchoredIndex].createdAtMs <= timestamp {
                    let runId = unanchoredRuns[unanchoredIndex].id
                    rawEntries.append(
                        .work(
                            runId: runId,
                            timestampMs: unanchoredRuns[unanchoredIndex].createdAtMs
                        )
                    )
                    emittedRunIds.insert(runId)
                    unanchoredIndex += 1
                }
            }

            if let runId = message.runId, runsById[runId] != nil {
                if emittedRunIds.insert(runId).inserted {
                    rawEntries.append(
                        .work(
                            runId: runId,
                            timestampMs: MessageTimelineLayout.timestampMs(for: message)
                                ?? runsById[runId]?.createdAtMs
                                ?? 0
                        )
                    )
                }
                if isStructuredWorkMessage(message) {
                    continue
                }
            }
            rawEntries.append(.message(message))
        }

        while unanchoredIndex < unanchoredRuns.count {
            let run = unanchoredRuns[unanchoredIndex]
            rawEntries.append(.work(runId: run.id, timestampMs: run.createdAtMs))
            unanchoredIndex += 1
        }

        return layout(rawEntries)
    }

    private static func isStructuredWorkMessage(_ message: Message) -> Bool {
        switch message.type {
        case .toolCall, .toolResult, .diff, .approvalRequest, .artifact:
            return true
        case .text, .system:
            return false
        }
    }

    private static func layout(_ rawEntries: [RawEntry]) -> [AgentWorkTimelineEntry] {
        var entries: [AgentWorkTimelineEntry] = []
        var messageSegment: [Message] = []
        var previousDay: Date?
        var hasTimelineEntry = false
        let calendar = Calendar.autoupdatingCurrent

        func flushMessages() {
            let items = MessageTimelineLayout.items(messages: messageSegment, calendar: calendar)
            for (index, item) in items.enumerated() {
                let startsDay = !hasTimelineEntry || item.day != previousDay
                entries.append(
                    .message(
                        MessageTimelineItem(
                            message: item.message,
                            day: item.day,
                            startsDay: startsDay,
                            startsGroup: index == 0 || item.startsGroup
                        )
                    )
                )
                previousDay = item.day
                hasTimelineEntry = true
            }
            messageSegment.removeAll(keepingCapacity: true)
        }

        for entry in rawEntries {
            switch entry {
            case .message(let message):
                messageSegment.append(message)
            case .work(let runId, let timestampMs):
                flushMessages()
                let day = timestampMs > 0
                    ? calendar.startOfDay(
                        for: Date(timeIntervalSince1970: Double(timestampMs) / 1_000)
                    )
                    : nil
                entries.append(
                    .work(
                        runId: runId,
                        day: day,
                        startsDay: !hasTimelineEntry || day != previousDay
                    )
                )
                previousDay = day
                hasTimelineEntry = true
            }
        }
        flushMessages()
        return entries
    }
}

struct AgentWorkResultSummary: Equatable {
    let summary: String?
    let diffSummary: String?
    let changedFileCount: Int?
    let exitCode: Int?
    let pullRequestURL: URL?
    let transcript: [String]

    var hasResult: Bool {
        summary != nil
            || diffSummary != nil
            || changedFileCount != nil
            || exitCode != nil
            || pullRequestURL != nil
    }

    var tailText: String? {
        let tail = transcript.suffix(3)
        return tail.isEmpty ? nil : tail.joined(separator: "\n")
    }

    init(run: AgentWorkRun, messages: [Message], partial: AgentPartial?) {
        let output = run.output
        let result = output?["result"] ?? output
        var messageResult: JSON?
        for message in messages.reversed() {
            let candidate = message.props["result"] ?? message.props["output"] ?? message.props
            if candidate["summary"] != nil
                || candidate["diff_summary"] != nil
                || candidate["exit_code"] != nil
                || candidate["pr_url"] != nil
                || candidate["pull_request_url"] != nil {
                messageResult = candidate
                break
            }
        }

        summary = Self.firstString(
            result?["summary"],
            result?["last_message"],
            output?["summary"],
            messageResult?["summary"],
            messages.lazy.compactMap { $0.props["summary"] }.first
        )

        diffSummary = Self.firstString(
            result?["diff_summary"],
            result?["diff"]?["summary"],
            output?["diff_summary"],
            messageResult?["diff_summary"],
            messageResult?["diff"]?["summary"],
            messages.lazy
                .filter { $0.type == .diff }
                .compactMap { $0.props["summary"] ?? $0.props["path"] }
                .first
        )

        changedFileCount = Self.firstInt(
            result?["changed_file_count"],
            result?["changed_files_count"],
            output?["changed_file_count"],
            messageResult?["changed_file_count"],
            messageResult?["changed_files_count"]
        ) ?? result?["changed_files"]?.arrayValue?.count
            ?? messageResult?["changed_files"]?.arrayValue?.count

        exitCode = Self.firstInt(
            result?["exit_code"],
            output?["exit_code"],
            messageResult?["exit_code"],
            messages.lazy.compactMap { $0.props["exit_code"] }.first
        )

        let pullRequest = Self.firstString(
            result?["pr_url"],
            result?["pull_request_url"],
            result?["links"]?["pr"],
            output?["pr_url"],
            messageResult?["pr_url"],
            messageResult?["pull_request_url"],
            messageResult?["links"]?["pr"],
            messages.lazy.compactMap { $0.props["pr_url"] }.first
        )
        pullRequestURL = pullRequest.flatMap(URL.init(string:))

        var lines: [String] = []
        lines.append(contentsOf: Self.transcriptLines(output?["transcript"] ?? result?["transcript"]))
        for message in messages {
            if let body = Self.normalized(message.body) {
                lines.append(body)
            }
            if let log = Self.firstString(
                message.props["log"],
                message.props["text"],
                message.props["output"]
            ) {
                lines.append(log)
            }
        }
        if let liveText = Self.normalized(partial?.textDelta) {
            lines.append(liveText)
        }
        transcript = Self.uniqued(lines)
    }

    private static func firstString(_ values: JSON?...) -> String? {
        values.lazy.compactMap(string(from:)).first
    }

    private static func string(from value: JSON?) -> String? {
        guard let value else { return nil }
        if let string = value.stringValue {
            return normalized(string)
        }
        guard let object = value.objectValue else { return nil }
        for key in ["summary", "message", "text", "content", "result"] {
            if let string = normalized(object[key]?.stringValue) {
                return string
            }
        }
        return nil
    }

    private static func firstInt(_ values: JSON?...) -> Int? {
        values.lazy.compactMap { $0?.intValue }.first.map(Int.init)
    }

    private static func transcriptLines(_ value: JSON?) -> [String] {
        guard let value else { return [] }
        if let string = normalized(value.stringValue) {
            return [string]
        }
        return (value.arrayValue ?? []).compactMap(string(from:))
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized.isEmpty ? nil : normalized
    }

    private static func uniqued(_ lines: [String]) -> [String] {
        var seen: Set<String> = []
        return lines.filter { seen.insert($0).inserted }
    }
}
