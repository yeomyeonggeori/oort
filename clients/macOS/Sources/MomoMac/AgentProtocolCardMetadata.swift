import SwiftUI
import MomoCore

// MARK: - AgentProtocolMetadataStrip
//
// Shared timeline metadata for agent protocol cards. This stays presentation-only:
// the authoritative records remain Context Packet, Memory Plane, Capability Cache,
// usage ledger, and message props produced by the backend/runtime.

struct AgentProtocolMetadataStrip: View {
    let props: JSON
    let showsCosts: Bool

    var body: some View {
        let badges = Self.badges(from: props, showsCosts: showsCosts)
        if !badges.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(badges.prefix(7))) { badge in
                    AgentProtocolBadgeView(badge: badge)
                }
            }
            .padding(.top, 2)
        }
    }

    private static func badges(from props: JSON, showsCosts: Bool) -> [AgentProtocolBadge] {
        guard let object = props.objectValue else { return [] }
        var badges: [AgentProtocolBadge] = []

        if let context = object["context_packet"]?.objectValue {
            let scope = context["scope"]?.stringValue ?? "context"
            var parts: [String] = [scope]
            if let sourceCount = context["source_count"]?.intValue {
                parts.append("\(sourceCount) src")
            }
            if let memoryCount = context["memory_count"]?.intValue {
                parts.append("\(memoryCount) mem")
            }
            if let packet = context["packet_id"]?.stringValue {
                parts.append(short(packet))
            }
            badges.append(AgentProtocolBadge(
                id: "context",
                title: "context",
                detail: parts.joined(separator: " / "),
                systemImage: "shippingbox",
                tone: .context
            ))
        }

        if let capability = object["capability"]?.objectValue {
            let provider = capability["provider"]?.stringValue ?? "tool"
            let tool = capability["tool_name"]?.stringValue
                ?? object["name"]?.stringValue
                ?? object["tool_name"]?.stringValue
                ?? "capability"
            var parts = [tool]
            if let risk = capability["risk"]?.stringValue { parts.append(risk) }
            if let policy = capability["approval_policy"]?.stringValue { parts.append(policy) }
            if let scope = capability["resource_scope_summary"]?.stringValue { parts.append(scope) }
            badges.append(AgentProtocolBadge(
                id: "capability",
                title: provider,
                detail: parts.joined(separator: " / "),
                systemImage: "puzzlepiece.extension",
                tone: .capability
            ))
        }

        if showsCosts, let cost = costSummary(from: object) {
            badges.append(AgentProtocolBadge(
                id: "cost",
                title: "cost",
                detail: cost,
                systemImage: "dollarsign.circle",
                tone: .cost
            ))
        }

        for (index, sourceJSON) in (object["source_badges"]?.arrayValue ?? []).prefix(2).enumerated() {
            guard let source = sourceJSON.objectValue else { continue }
            let kind = source["kind"]?.stringValue ?? "source"
            let title = source["title"]?.stringValue
                ?? source["uri"]?.stringValue
                ?? source["source_id"]?.stringValue
                ?? "source"
            badges.append(AgentProtocolBadge(
                id: "source-\(index)-\(kind)-\(title)",
                title: kind,
                detail: title,
                systemImage: "link",
                tone: .source
            ))
        }

        for (index, memoryJSON) in (object["memory_citations"]?.arrayValue ?? []).prefix(2).enumerated() {
            guard let memory = memoryJSON.objectValue else { continue }
            let type = memory["type"]?.stringValue ?? "memory"
            let label = memory["label"]?.stringValue
                ?? memory["excerpt"]?.stringValue
                ?? memory["memory_id"].flatMap { $0.stringValue.map(short) }
                ?? "memory"
            badges.append(AgentProtocolBadge(
                id: "memory-\(index)-\(type)-\(label)",
                title: type,
                detail: label,
                systemImage: "brain.head.profile",
                tone: .memory
            ))
        }

        return badges
    }

    private static func costSummary(from object: [String: JSON]) -> String? {
        let cost = object["cost"]?.objectValue
        let estimated = cost?["estimated_micro_usd"]?.intValue ?? object["estimated_micro_usd"]?.intValue
        let reserved = cost?["reserved_micro_usd"]?.intValue ?? object["reserved_micro_usd"]?.intValue
        let spent = cost?["spent_micro_usd"]?.intValue ?? object["spent_micro_usd"]?.intValue

        var parts: [String] = []
        if let estimated { parts.append("est \(CostFormat.usdCompact(estimated))") }
        if let reserved { parts.append("reserved \(CostFormat.usdCompact(reserved))") }
        if let spent { parts.append("spent \(CostFormat.usdCompact(spent))") }
        return parts.isEmpty ? nil : parts.joined(separator: " / ")
    }

    private static func short(_ value: String) -> String {
        guard value.count > 12 else { return value }
        return String(value.prefix(8))
    }
}

private struct AgentProtocolBadge: Identifiable {
    let id: String
    let title: String
    let detail: String
    let systemImage: String
    let tone: AgentProtocolBadgeTone
}

private enum AgentProtocolBadgeTone {
    case context
    case capability
    case source
    case memory
    case cost

    var color: Color {
        switch self {
        case .context:
            return MomoTheme.humanAccent
        case .capability:
            return MomoTheme.agentAccent
        case .source:
            return .secondary
        case .memory:
            return MomoTheme.reversibleGreen
        case .cost:
            return MomoTheme.costAmber
        }
    }
}

private struct AgentProtocolBadgeView: View {
    let badge: AgentProtocolBadge

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: badge.systemImage)
                .font(.system(size: 10, weight: .semibold))
                .frame(width: 12)
            Text(badge.title.uppercased())
                .font(.system(size: 8, weight: .bold))
            Text(badge.detail)
                .font(.caption2)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .foregroundStyle(badge.tone.color)
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(badge.tone.color.opacity(0.08), in: Capsule())
        .overlay(
            Capsule().strokeBorder(badge.tone.color.opacity(0.22), lineWidth: 1)
        )
    }
}
