#if os(iOS)
import MomoCore
import SwiftUI

@MainActor
struct IOSWorkView: View {
    @Bindable var model: IOSWorkListModel
    let channelIDs: [ChannelID]
    let isActive: Bool
    @Binding var developerModeEnabled: Bool

    var body: some View {
        List {
            if let message = model.inlineFailureMessage {
                Section {
                    Label(message, systemImage: "wifi.exclamationmark")
                        .foregroundStyle(.secondary)
                    Button("Retry") { Task { await model.retry() } }
                }
                .accessibilityIdentifier("workInlineFailure")
            }

            switch model.phase {
            case .loading:
                Section { ProgressView("Loading Work sessions") }
            case .failed(let failure):
                Section { failureView(failure) }
            case .loaded:
                if developerModeEnabled {
                    if let pool = model.pool {
                        Section { IOSWorkPoolRow(pool: pool) }
                    }
                    developerSessionContent
                } else {
                    Section {
                        IOSWorkSummaryCard(summary: model.summary)
                    } header: {
                        Text("Background work")
                    } footer: {
                        Text("Turn on Developer Mode in Profile to inspect individual sessions.")
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Work")
        .refreshable { await model.retry() }
        .task(id: isActive) {
            guard isActive else { return }
            await model.start(channelIDs: channelIDs)
        }
    }

    @ViewBuilder
    private var developerSessionContent: some View {
        Section {
            Picker("Session filter", selection: $model.filter) {
                Text("All").tag(IOSWorkFilter.all)
                Text("Running").tag(IOSWorkFilter.running)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("workFilter")
        }

        if model.visibleSessions.isEmpty {
            Section {
                ContentUnavailableView {
                    Label(
                        model.filter == .running ? "No running sessions" : "No work sessions",
                        systemImage: "terminal"
                    )
                } description: {
                    Text("Sessions started on a connected host will appear here.")
                }
                .accessibilityIdentifier("workEmpty")
            }
        } else {
            Section("Sessions") {
                ForEach(model.visibleSessions) { session in
                    IOSWorkSessionRow(session: session, host: model.host(for: session))
                        .accessibilityIdentifier("workSession.\(session.id.description.lowercased())")
                }
            }
        }
    }

    private func failureView(_ failure: IOSWorkListModel.Failure) -> some View {
        ContentUnavailableView {
            Label(
                failure.isOffline ? "Work unavailable offline" : "Could not load Work",
                systemImage: failure.isOffline ? "wifi.slash" : "exclamationmark.triangle"
            )
        } description: {
            Text(failure.message)
        } actions: {
            Button("Retry loading Work") { Task { await model.retry() } }
        }
        .accessibilityIdentifier("workFailure")
    }
}

private struct IOSWorkPoolRow: View {
    let pool: IOSWorkPool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("Work pool", systemImage: "square.stack.3d.up")
                    .font(.headline)
                Spacer()
                Text("\(pool.activeSessions) / \(pool.maxActive) slots")
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            ProgressView(
                value: Double(min(pool.activeSessions, pool.maxActive)),
                total: Double(max(pool.maxActive, 1))
            )
            Text("Your active sessions: \(pool.memberActiveSessions) of \(pool.perMemberSoftLimit)")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("workPool")
    }
}

private struct IOSWorkSummaryCard: View {
    let summary: IOSWorkSummary

    var body: some View {
        HStack(spacing: 12) {
            summaryMetric(
                value: summary.runningCount,
                label: "Running",
                systemImage: "play.circle.fill",
                color: .accentColor
            )
            Divider()
            summaryMetric(
                value: summary.completedCount,
                label: "Completed",
                systemImage: "checkmark.circle.fill",
                color: .secondary
            )
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("workSummary")
    }

    private func summaryMetric(
        value: Int,
        label: String,
        systemImage: String,
        color: Color
    ) -> some View {
        HStack(spacing: 10) {
            Image(systemName: systemImage)
                .foregroundStyle(color)
            VStack(alignment: .leading, spacing: 2) {
                Text(value, format: .number)
                    .font(.title2.weight(.semibold).monospacedDigit())
                Text(label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity)
    }
}

private struct IOSWorkSessionRow: View {
    let session: IOSWorkSession
    let host: WorkHost?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            toolIcon
            VStack(alignment: .leading, spacing: 7) {
                Text(session.label)
                    .font(.headline)
                    .lineLimit(2)
                HStack(spacing: 8) {
                    statusChip
                    hostLabel
                }
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 6) {
                        startedLabel
                        Text("·").foregroundStyle(.tertiary)
                        elapsedLabel
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        startedLabel
                        elapsedLabel
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    private var toolIcon: some View {
        Image(systemName: session.tool.systemImage)
            .font(.body.weight(.semibold))
            .frame(width: 38, height: 38)
            .foregroundStyle(.primary)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .accessibilityHidden(true)
    }

    private var statusChip: some View {
        Text(session.status.label)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(session.status.tint)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(session.status.tint.opacity(0.12), in: Capsule())
    }

    private var hostLabel: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(host?.online == true ? Color.green : Color.secondary)
                .frame(width: 7, height: 7)
            Text(host?.displayName ?? "Unknown host")
                .lineLimit(1)
            Text(host?.online == true ? "Connected" : "Offline")
                .foregroundStyle(.tertiary)
        }
        .font(.caption)
    }

    private var startedLabel: some View {
        Text("Started \(startedDate.formatted(date: .abbreviated, time: .shortened))")
    }

    @ViewBuilder
    private var elapsedLabel: some View {
        if session.isRunning {
            TimelineView(.periodic(from: .now, by: 60)) { context in
                Text(session.elapsedDescription(now: context.date))
                    .monospacedDigit()
            }
        } else {
            Text(session.elapsedDescription())
                .monospacedDigit()
        }
    }

    private var startedDate: Date {
        Date(timeIntervalSince1970: TimeInterval(session.startedAtMs) / 1_000)
    }
}

private extension IOSWorkSessionTool {
    var systemImage: String {
        switch self {
        case .claude: "sparkles"
        case .codex: "terminal"
        case .opencode: "chevron.left.forwardslash.chevron.right"
        case .shell: "apple.terminal"
        }
    }
}

private extension IOSWorkSessionStatus {
    var label: String {
        switch self {
        case .running: "Running"
        case .orphaned: "Needs host"
        case .ended: "Ended"
        }
    }

    var tint: Color {
        switch self {
        case .running: .accentColor
        case .orphaned: .orange
        case .ended: .secondary
        }
    }
}
#endif
