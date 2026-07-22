import MomoACPHost
import SwiftUI

struct MomoACPPlanItem: Equatable, Identifiable {
    let id: Int
    let content: String
    let status: String
}

struct MomoACPToolCallItem: Equatable, Identifiable {
    let id: String
    let title: String
    let kind: String
    let status: String
    let detail: String?
}

struct MomoACPPermissionOptionItem: Equatable, Identifiable {
    let id: String
    let name: String
    let kind: String

    var isAlways: Bool { kind.contains("always") }
    var isAllow: Bool { kind.hasPrefix("allow") }
}

enum MomoACPPermissionPresentation: Equatable {
    case none
    case pending(title: String, kind: String, options: [MomoACPPermissionOptionItem])
    case resolved(status: String, optionID: String?)
}

struct MomoACPSessionPresentation: Equatable {
    let plan: [MomoACPPlanItem]
    let toolCalls: [MomoACPToolCallItem]
    let permission: MomoACPPermissionPresentation
    let statusDetail: String?

    init(events: [ACPProjectedEvent]) {
        plan = Self.latestPlan(in: events)
        toolCalls = Self.toolCalls(in: events)
        permission = Self.permission(in: events)
        statusDetail = events.reversed().compactMap { event -> String? in
            guard event.type == "agent.status" else { return nil }
            return event.payload.objectValue?["detail"]?.stringValue
        }.first
    }

    private static func latestPlan(in events: [ACPProjectedEvent]) -> [MomoACPPlanItem] {
        let rawEntries = events.reversed().compactMap { event -> [ACPValue]? in
            guard event.type == "agent.status" else { return nil }
            return event.payload.objectValue?["plan"]?.arrayValue
        }.first ?? []
        return rawEntries.enumerated().compactMap { index, value in
            guard let item = value.objectValue else { return nil }
            let content = item["content"]?.stringValue
                ?? item["title"]?.stringValue
                ?? item["description"]?.stringValue
            guard let content, !content.isEmpty else { return nil }
            return MomoACPPlanItem(
                id: index,
                content: content,
                status: item["status"]?.stringValue ?? "pending"
            )
        }
    }

    private static func toolCalls(in events: [ACPProjectedEvent]) -> [MomoACPToolCallItem] {
        var orderedIDs: [String] = []
        var items: [String: MomoACPToolCallItem] = [:]
        for (index, event) in events.enumerated() where event.type == "agent.status" {
            guard let payload = event.payload.objectValue,
                  let update = payload["_meta"]?.objectValue?["acp"]?.objectValue,
                  let discriminator = update["sessionUpdate"]?.stringValue,
                  discriminator == "tool_call" || discriminator == "tool_call_update"
            else { continue }
            let id = update["toolCallId"]?.stringValue
                ?? update["tool_call_id"]?.stringValue
                ?? "tool-call-\(index)"
            if items[id] == nil { orderedIDs.append(id) }
            items[id] = MomoACPToolCallItem(
                id: id,
                title: update["title"]?.stringValue
                    ?? payload["tool_call_name"]?.stringValue
                    ?? "ACP",
                kind: update["kind"]?.stringValue ?? "other",
                status: update["status"]?.stringValue ?? payload["run_status"]?.stringValue ?? "in_progress",
                detail: payload["detail"]?.stringValue
            )
        }
        return orderedIDs.compactMap { items[$0] }
    }

    private static func permission(in events: [ACPProjectedEvent]) -> MomoACPPermissionPresentation {
        guard let latest = events.enumerated().reversed().first(where: {
            $0.element.type == "approval.requested" || $0.element.type == "approval.decided"
        })?.element,
        let payload = latest.payload.objectValue else { return .none }

        if latest.type == "approval.decided" {
            return .resolved(
                status: payload["status"]?.stringValue ?? "rejected",
                optionID: payload["option_id"]?.stringValue
            )
        }

        let toolCall = payload["_meta"]?.objectValue?["acp"]?.objectValue?["tool_call"]?.objectValue
        let title = toolCall?["title"]?.stringValue ?? "ACP"
        let kind = toolCall?["kind"]?.stringValue ?? "other"
        let options = payload["options"]?.arrayValue?.compactMap { value -> MomoACPPermissionOptionItem? in
            guard let item = value.objectValue,
                  let id = item["option_id"]?.stringValue,
                  let name = item["name"]?.stringValue
            else { return nil }
            return MomoACPPermissionOptionItem(
                id: id,
                name: name,
                kind: item["kind"]?.stringValue ?? ""
            )
        } ?? []
        return .pending(title: title, kind: kind, options: options)
    }
}

struct MomoACPSessionCard: View {
    @ObservedObject var session: MomoLocalACPSession
    let toolDisplayName: String
    let sessionLabel: String
    let copy: MomoWorkspaceCopy
    @State private var resolvingOptionID: String?

    private var presentation: MomoACPSessionPresentation {
        MomoACPSessionPresentation(events: session.events)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: MomoTheme.WorkConsole.sectionSpacing) {
            HStack(spacing: MomoTheme.WorkConsole.standardSpacing) {
                Image(systemName: "point.3.connected.trianglepath.dotted")
                    .foregroundStyle(MomoTheme.agentAccent)
                Text(copy.acpCardTitle(toolDisplayName: toolDisplayName, sessionLabel: sessionLabel))
                    .momoTypography(.emphasizedRow)
                Spacer(minLength: 0)
                Text(session.errorLabel == nil
                    ? (session.isRunning ? copy.workSessionRunning : copy.workSessionEnded)
                    : copy.acpSessionFailedStatus)
                    .momoTypography(.metadata)
                    .foregroundStyle(.secondary)
            }

            if !presentation.plan.isEmpty {
                section(copy.acpPlan) {
                    ForEach(presentation.plan) { item in
                        HStack(alignment: .firstTextBaseline, spacing: MomoTheme.WorkConsole.standardSpacing) {
                            Image(systemName: planSymbol(item.status))
                                .foregroundStyle(item.status == "completed" ? MomoTheme.reversibleGreen : .secondary)
                                .accessibilityLabel(copy.acpPlanStatus(item.status))
                            Text(item.content)
                                .momoTypography(.supporting)
                                .foregroundStyle(item.status == "completed" ? .secondary : .primary)
                            Spacer(minLength: 0)
                        }
                    }
                }
            }

            if !presentation.toolCalls.isEmpty {
                section(copy.acpProgress) {
                    ForEach(presentation.toolCalls) { item in
                        HStack(alignment: .top, spacing: MomoTheme.WorkConsole.standardSpacing) {
                            Image(systemName: toolSymbol(item.kind))
                                .foregroundStyle(.secondary)
                                .frame(width: 18)
                            VStack(alignment: .leading, spacing: MomoTheme.WorkConsole.compactSpacing) {
                                Text(item.title)
                                    .momoTypography(.supporting)
                                if let detail = item.detail, detail != item.title {
                                    Text(detail)
                                        .momoTypography(.metadata)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(2)
                                }
                            }
                            Spacer(minLength: 0)
                            Text(copy.acpToolStatus(item.status))
                                .momoTypography(.metadata)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }

            permissionContent

            sessionStatus
        }
        .padding(MomoTheme.WorkConsole.contentSpacing)
        .momoSurface(.card)
        .onChange(of: session.events.count) {
            if case .pending = presentation.permission { return }
            resolvingOptionID = nil
        }
    }

    @ViewBuilder
    private var sessionStatus: some View {
        if let errorLabel = session.errorLabel {
            Label(copy.acpSessionFailed(errorLabel), systemImage: "exclamationmark.triangle.fill")
                .momoTypography(.metadata)
                .foregroundStyle(MomoTheme.irreversibleRed)
                .fixedSize(horizontal: false, vertical: true)
        } else if session.isRunning {
            Text(presentation.statusDetail ?? copy.acpWaiting)
                .momoTypography(.metadata)
                .foregroundStyle(.secondary)
        } else if let stopReason = session.stopReason {
            Text(copy.acpSessionStopped(stopReason))
                .momoTypography(.metadata)
                .foregroundStyle(.secondary)
        } else {
            Text(copy.workSessionEnded)
                .momoTypography(.metadata)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var permissionContent: some View {
        switch presentation.permission {
        case .none:
            EmptyView()
        case .resolved(let status, let optionID):
            HStack(spacing: MomoTheme.WorkConsole.standardSpacing) {
                Image(systemName: status == "approved" ? "checkmark.circle.fill" : "xmark.circle.fill")
                    .foregroundStyle(status == "approved" ? MomoTheme.reversibleGreen : MomoTheme.irreversibleRed)
                Text(copy.acpPermissionResult(status: status, optionID: optionID))
                    .momoTypography(.supporting)
                Spacer(minLength: 0)
                Text(copy.acpPermissionResolved)
                    .momoTypography(.metadata)
                    .foregroundStyle(.secondary)
            }
            .padding(MomoTheme.WorkConsole.standardSpacing)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: MomoTheme.cornerSmall))
        case .pending(let title, let kind, let options):
            section(copy.acpPermission) {
                HStack(alignment: .top, spacing: MomoTheme.WorkConsole.standardSpacing) {
                    Image(systemName: toolSymbol(kind))
                        .foregroundStyle(MomoTheme.costAmber)
                    Text(title)
                        .momoTypography(.supporting)
                    Spacer(minLength: 0)
                }
                permissionButtons(options)
                if !session.isRunning {
                    Label(copy.acpDecisionUnavailable, systemImage: "info.circle")
                        .momoTypography(.metadata)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func section<Content: View>(
        _ title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: MomoTheme.WorkConsole.standardSpacing) {
            Text(title)
                .momoTypography(.metadata)
                .foregroundStyle(.secondary)
            content()
        }
        .padding(MomoTheme.WorkConsole.standardSpacing)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: MomoTheme.cornerSmall))
    }

    private func permissionButtons(_ options: [MomoACPPermissionOptionItem]) -> some View {
        let once = options.filter { !$0.isAlways }
        let always = options.filter(\.isAlways)
        return VStack(alignment: .leading, spacing: MomoTheme.WorkConsole.compactSpacing) {
            HStack(spacing: MomoTheme.WorkConsole.standardSpacing) {
                ForEach(once) { option in permissionButton(option, primary: option.isAllow) }
            }
            HStack(spacing: MomoTheme.WorkConsole.standardSpacing) {
                ForEach(always) { option in permissionButton(option, primary: false) }
            }
        }
    }

    @ViewBuilder
    private func permissionButton(_ option: MomoACPPermissionOptionItem, primary: Bool) -> some View {
        let button = Button(copy.acpPermissionOption(kind: option.kind, fallback: option.name)) {
            resolvingOptionID = option.id
            session.resolvePermission(optionID: option.id)
        }
        .disabled(resolvingOptionID != nil || !session.isRunning || session.errorLabel != nil)
        if primary {
            button.buttonStyle(.borderedProminent)
        } else {
            button.buttonStyle(.bordered)
        }
    }

    private func planSymbol(_ status: String) -> String {
        switch status {
        case "completed": "checkmark.circle.fill"
        case "in_progress": "circle.dotted"
        default: "circle"
        }
    }

    private func toolSymbol(_ kind: String) -> String {
        switch kind {
        case "read": "doc.text.magnifyingglass"
        case "edit": "pencil"
        case "delete": "trash"
        case "move": "arrowshape.turn.up.right"
        case "search": "magnifyingglass"
        case "execute": "terminal"
        case "think": "brain"
        case "fetch": "arrow.down.circle"
        default: "wrench.and.screwdriver"
        }
    }
}
