import SwiftUI
import MomoCore

// MARK: - AgentWorkingSignal (MOMO-568)
//
// The single source of truth for "an agent is actively working" across three
// surfaces: the sidebar channel-row badge + elapsed time, the composer rotating
// headline bar, and the timeline turn-liveness mark. buzz-validated pattern: one
// module, three consumers, so a stale "working" state can never diverge between
// surfaces (buzz repro: a run ends but one surface keeps claiming activity).
//
// Data contract (handoff 2026-07-23 §MOMO-568): no new server event. The primary
// source is the existing `agent.status` realtime stream plus the durable Work run
// projection, enriched by `agent.partial`; an agent member's `typing` signal is
// the fallback. A run that reaches a terminal / done / error state produces no
// signal, so every surface clears together within one event cycle.

/// One agent actively working inside one channel. At most one signal per agent per
/// channel; concurrent runs for the same agent are merged (earliest start wins,
/// headlines unioned) so the surfaces never double-count an agent.
public struct AgentWorkingSignal: Identifiable, Sendable, Equatable {
    /// Which realtime source proved the agent is working, in priority order.
    public enum Source: Sendable, Equatable {
        /// A non-terminal durable Work run (ADR-0111 projection).
        case run
        /// A non-terminal `agent.status` stream with no Work run behind it.
        case status
        /// Fallback: the agent member is typing but no run/status is live yet.
        case typing
    }

    public let agentId: MemberID
    public let channelId: ChannelID
    public let agentName: String
    public let runId: RunID?
    /// Reference point for elapsed time. `nil` for a typing-only fallback (no run
    /// clock exists yet), in which case surfaces omit the elapsed readout.
    public let startedAt: Date?
    /// Rotating headline candidates drawn from agent-authored content (Work title,
    /// last streamed line). Empty when the agent has produced no headline yet, in
    /// which case the composer bar stays hidden (no empty rotation).
    public let headlines: [String]
    public let source: Source

    public var id: MemberID { agentId }

    public var hasHeadline: Bool { !headlines.isEmpty }

    public init(
        agentId: MemberID,
        channelId: ChannelID,
        agentName: String,
        runId: RunID?,
        startedAt: Date?,
        headlines: [String],
        source: Source
    ) {
        self.agentId = agentId
        self.channelId = channelId
        self.agentName = agentName
        self.runId = runId
        self.startedAt = startedAt
        self.headlines = headlines
        self.source = source
    }

    /// Seconds the agent has been working, or `nil` when no start clock is known.
    public func elapsed(at now: Date) -> TimeInterval? {
        guard let startedAt else { return nil }
        return max(0, now.timeIntervalSince(startedAt))
    }
}

// MARK: - Resolver (pure)

/// Derives the working signals for one channel from raw realtime state. Pure and
/// synchronous so every surface renders identical results and the removal rule
/// ("no signal once a run is terminal") is unit-testable without a live backend.
public enum AgentWorkingSignalResolver {
    private static let maximumHeadlines = 3
    private static let maximumHeadlineLength = 140

    public static func resolve(
        channel: ChannelID,
        members: [Member],
        statuses: [AgentStatus],
        partials: [RunID: AgentPartial],
        workRuns: [AgentWorkRun],
        typingAgentIDs: Set<MemberID>,
        startTimes: [RunID: Date],
        now: Date
    ) -> [AgentWorkingSignal] {
        let membersByID = Dictionary(members.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })

        func workingMember(_ id: MemberID) -> Member? {
            guard let member = membersByID[id],
                  member.isAgent,
                  member.status == .active,
                  member.channelIds.contains(channel)
            else { return nil }
            return member
        }

        let statusByRun = Dictionary(
            statuses.map { ($0.runId, $0) },
            uniquingKeysWith: { _, latest in latest }
        )

        // Accumulate raw per-run candidates, then merge to one signal per agent.
        var candidatesByAgent: [MemberID: [AgentWorkingSignal]] = [:]
        var coveredRuns: Set<RunID> = []

        func appendCandidate(_ signal: AgentWorkingSignal) {
            candidatesByAgent[signal.agentId, default: []].append(signal)
        }

        // 1a. Primary: durable Work runs (authoritative run state).
        for run in workRuns where run.channelId == channel {
            let status = statusByRun[run.id]
            let effectiveStatus = status?.runStatus ?? run.status
            guard !effectiveStatus.isTerminal else { continue }
            if let phase = status?.phase, phase == .done || phase == .error { continue }
            guard let agent = workingMember(run.agentMemberId) else { continue }
            coveredRuns.insert(run.id)
            appendCandidate(
                AgentWorkingSignal(
                    agentId: agent.id,
                    channelId: channel,
                    agentName: agent.displayName,
                    runId: run.id,
                    startedAt: runStart(run: run, startTimes: startTimes),
                    headlines: headlines(workTitle: run.input.title, partial: partials[run.id]),
                    source: .run
                )
            )
        }

        // 1b. Primary: `agent.status` runs without a durable Work run yet.
        for status in statuses where status.channelId == channel {
            guard !coveredRuns.contains(status.runId) else { continue }
            guard !status.runStatus.isTerminal, status.phase != .done, status.phase != .error else { continue }
            guard let agent = workingMember(status.agentMemberId) else { continue }
            coveredRuns.insert(status.runId)
            appendCandidate(
                AgentWorkingSignal(
                    agentId: agent.id,
                    channelId: channel,
                    agentName: agent.displayName,
                    runId: status.runId,
                    startedAt: startTimes[status.runId],
                    headlines: headlines(workTitle: nil, partial: partials[status.runId]),
                    source: .status
                )
            )
        }

        // 2. Fallback: an agent member typing with no live run/status behind it.
        for agentID in typingAgentIDs where candidatesByAgent[agentID] == nil {
            guard let agent = workingMember(agentID) else { continue }
            appendCandidate(
                AgentWorkingSignal(
                    agentId: agent.id,
                    channelId: channel,
                    agentName: agent.displayName,
                    runId: nil,
                    startedAt: nil,
                    headlines: [],
                    source: .typing
                )
            )
        }

        return candidatesByAgent.values
            .compactMap(merge)
            .sorted { $0.agentName.localizedCaseInsensitiveCompare($1.agentName) == .orderedAscending }
    }

    /// Collapse an agent's concurrent-run candidates into one signal: earliest
    /// start clock, unioned headlines, strongest source.
    private static func merge(_ candidates: [AgentWorkingSignal]) -> AgentWorkingSignal? {
        guard let first = candidates.first else { return nil }
        guard candidates.count > 1 else { return first }

        let starts = candidates.compactMap(\.startedAt)
        let earliest = starts.min()
        // Prefer the run that owns the earliest clock so runId and startedAt agree.
        let anchor = candidates.first { $0.startedAt == earliest } ?? first

        var mergedHeadlines: [String] = []
        for candidate in candidates {
            for headline in candidate.headlines where !mergedHeadlines.contains(headline) {
                mergedHeadlines.append(headline)
            }
        }

        let source: AgentWorkingSignal.Source = candidates.contains { $0.source == .run }
            ? .run
            : (candidates.contains { $0.source == .status } ? .status : .typing)

        return AgentWorkingSignal(
            agentId: anchor.agentId,
            channelId: anchor.channelId,
            agentName: anchor.agentName,
            runId: anchor.runId,
            startedAt: earliest,
            headlines: Array(mergedHeadlines.prefix(maximumHeadlines)),
            source: source
        )
    }

    private static func runStart(run: AgentWorkRun, startTimes: [RunID: Date]) -> Date? {
        if let started = run.startedAtMs {
            return Date(timeIntervalSince1970: Double(started) / 1_000)
        }
        if let tracked = startTimes[run.id] {
            return tracked
        }
        return Date(timeIntervalSince1970: Double(run.createdAtMs) / 1_000)
    }

    static func headlines(workTitle: String?, partial: AgentPartial?) -> [String] {
        var result: [String] = []
        if let title = clean(workTitle) {
            result.append(title)
        }
        if let line = lastMeaningfulLine(partial?.textDelta) {
            result.append(line)
        }
        var deduped: [String] = []
        for headline in result where !deduped.contains(headline) {
            deduped.append(headline)
        }
        return Array(deduped.prefix(maximumHeadlines))
    }

    private static func lastMeaningfulLine(_ text: String?) -> String? {
        guard let text else { return nil }
        let cleaned = AgentTranscriptText.removingCursorArtifact(from: text)
        let line = cleaned
            .split(whereSeparator: \.isNewline)
            .last
            .map(String.init)
        return clean(line)
    }

    private static func clean(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if trimmed.count <= maximumHeadlineLength {
            return trimmed
        }
        let clipped = String(trimmed.prefix(maximumHeadlineLength)).trimmingCharacters(in: .whitespaces)
        return clipped + "\u{2026}"
    }
}

// MARK: - Elapsed formatting

enum AgentWorkingElapsedFormat {
    /// Language-neutral clock string (digits only) for a `.monospacedDigit()` label.
    static func string(_ interval: TimeInterval) -> String {
        let total = max(0, Int(interval))
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let seconds = total % 60
        if hours > 0 {
            return String(format: "%d:%02d:%02d", hours, minutes, seconds)
        }
        return String(format: "%d:%02d", minutes, seconds)
    }
}

// MARK: - Surface 3: turn-liveness mark (distinct from typing)

/// The turn-liveness glyph. Deliberately a single static accent `sparkle` so it
/// never reads as the animated three-dot "typing" affordance humans get; agent
/// aliveness is carried by the ticking elapsed clock and rotating headline, which
/// are data feedback rather than decorative motion (design-taste §2 Motion).
struct AgentTurnLivenessMark: View {
    var accessibilityText: String

    var body: some View {
        Image(systemName: "sparkle")
            .imageScale(.small)
            .font(.caption.weight(.semibold))
            .foregroundStyle(MomoTheme.agentAccent)
            .accessibilityLabel(accessibilityText)
    }
}

/// A `.monospacedDigit()` elapsed clock that refreshes every second via
/// `TimelineView` (data cadence, not animation, so `reduceMotion` is irrelevant).
struct AgentWorkingElapsedLabel: View {
    var startedAt: Date
    var copy: MomoWorkspaceCopy

    var body: some View {
        TimelineView(.periodic(from: startedAt, by: 1)) { context in
            let text = AgentWorkingElapsedFormat.string(context.date.timeIntervalSince(startedAt))
            Text(text)
                .font(.caption2.weight(.medium))
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .accessibilityLabel(copy.agentWorkingElapsed(text))
        }
    }
}

// MARK: - Surface 1: sidebar channel-row badge

/// Compact working badge for a sidebar channel row: turn-liveness mark plus the
/// elapsed clock of the longest-running agent, and an agent count when more than
/// one agent is working the channel at once.
struct AgentWorkingChannelBadge: View {
    var signals: [AgentWorkingSignal]
    var copy: MomoWorkspaceCopy

    private var earliestStart: Date? {
        signals.compactMap(\.startedAt).min()
    }

    var body: some View {
        if !signals.isEmpty {
            HStack(spacing: 4) {
                AgentTurnLivenessMark(accessibilityText: accessibilityText)
                if signals.count > 1 {
                    Text("\(signals.count)")
                        .font(.caption2.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(MomoTheme.agentAccent)
                }
                if let earliestStart {
                    AgentWorkingElapsedLabel(startedAt: earliestStart, copy: copy)
                }
            }
            .padding(.horizontal, 4)
            .frame(minHeight: MomoTheme.Sidebar.actionSize)
            .background(MomoTheme.agentAccent.opacity(0.14), in: Capsule())
            .accessibilityElement(children: .combine)
            .accessibilityLabel(accessibilityText)
            .help(accessibilityText)
        }
    }

    private var accessibilityText: String {
        if signals.count == 1, let signal = signals.first {
            return copy.agentWorkingTitle(signal.agentName)
        }
        return copy.agentsWorkingCount(signals.count)
    }
}

// MARK: - Surface 2: composer rotating headline bar

/// Composer footer bar that rotates through "{agent}: {headline}" every 2.2s. Only
/// shows when at least one agent has produced a headline (no empty rotation). With
/// `reduceMotion` the headline swaps statically (no slide/fade transition).
struct AgentWorkingComposerBar: View {
    var signals: [AgentWorkingSignal]
    var copy: MomoWorkspaceCopy

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var index = 0
    private let rotation = Timer.publish(every: 2.2, on: .main, in: .common).autoconnect()

    private struct Item: Equatable {
        let agentName: String
        let headline: String
    }

    private var items: [Item] {
        signals.flatMap { signal in
            signal.headlines.map { Item(agentName: signal.agentName, headline: $0) }
        }
    }

    var body: some View {
        let items = items
        if let item = current(in: items) {
            HStack(spacing: 8) {
                AgentTurnLivenessMark(accessibilityText: copy.agentWorkingTitle(item.agentName))
                Text(headlineText(item))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .id(reduceMotion ? nil : headlineText(item))
                    .transition(reduceMotion ? .identity : .opacity)
                Spacer(minLength: 0)
                if items.count > 1 {
                    Text("\(safeIndex(in: items) + 1)/\(items.count)")
                        .font(.caption2)
                        .monospacedDigit()
                        .foregroundStyle(.tertiary)
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(MomoTheme.agentAccent.opacity(0.08), in: RoundedRectangle(cornerRadius: MomoTheme.cornerSmall, style: .continuous))
            .animation(reduceMotion ? nil : .snappy(duration: 0.2), value: index)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(headlineText(item))
            .onReceive(rotation) { _ in
                guard items.count > 1 else { return }
                index = (index + 1) % items.count
            }
            .onChange(of: items) { _, newItems in
                if index >= newItems.count {
                    index = 0
                }
            }
        }
    }

    private func headlineText(_ item: Item) -> String {
        "\(item.agentName): \(item.headline)"
    }

    private func safeIndex(in items: [Item]) -> Int {
        guard !items.isEmpty else { return 0 }
        return index % items.count
    }

    private func current(in items: [Item]) -> Item? {
        guard !items.isEmpty else { return nil }
        return items[safeIndex(in: items)]
    }
}
