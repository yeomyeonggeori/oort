import Foundation
import MomoCore

#if canImport(FoundationModels)
import FoundationModels
#endif

public enum LocalContextCopilotRoute: Equatable, Sendable {
    case foundationModels
    case deterministicFallback(FoundationModelsCapabilityFallbackReason)

    public var badgeText: String {
        switch self {
        case .foundationModels:
            return "Local"
        case .deterministicFallback:
            return "Fallback"
        }
    }

    public var detailText: String {
        switch self {
        case .foundationModels:
            return "Foundation Models route selected"
        case .deterministicFallback(let reason):
            return "Deterministic fallback: \(reason.detailText)"
        }
    }
}

public struct LocalContextSourceHint: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let uri: String
    public let citation: String
    public let excerpt: String

    public init(id: String, title: String, uri: String, citation: String? = nil, excerpt: String) {
        self.id = id
        self.title = title
        self.uri = uri
        self.citation = citation ?? "[\(id)]"
        self.excerpt = excerpt
    }
}

public struct LocalContextClassification: Equatable, Sendable {
    public let intent: String
    public let confidence: Double
    public let riskHint: String
    public let tags: [String]

    public init(intent: String, confidence: Double, riskHint: String, tags: [String]) {
        self.intent = intent
        self.confidence = confidence
        self.riskHint = riskHint
        self.tags = tags
    }
}

public struct LocalContextRedactionHint: Identifiable, Equatable, Sendable {
    public let id: String
    public let kind: String
    public let preview: String
    public let sourceId: String

    public init(id: String, kind: String, preview: String, sourceId: String) {
        self.id = id
        self.kind = kind
        self.preview = preview
        self.sourceId = sourceId
    }
}

public struct LocalContextSourceReference: Identifiable, Equatable, Sendable {
    public let id: String
    public let uri: String
    public let citation: String

    public init(id: String, uri: String, citation: String) {
        self.id = id
        self.uri = uri
        self.citation = citation
    }
}

public struct LocalContextCompactionPacket: Equatable, Sendable {
    public let schema: String
    public let packetVersion: Int
    public let summary: String
    public let classification: LocalContextClassification
    public let sources: [LocalContextSourceHint]
    public let redactions: [LocalContextRedactionHint]

    public init(
        schema: String = "momo.context_packet.compaction.v1",
        packetVersion: Int = 1,
        summary: String,
        classification: LocalContextClassification,
        sources: [LocalContextSourceHint],
        redactions: [LocalContextRedactionHint]
    ) {
        self.schema = schema
        self.packetVersion = packetVersion
        self.summary = summary
        self.classification = classification
        self.sources = sources
        self.redactions = redactions
    }

    public var sourceReferences: [LocalContextSourceReference] {
        sources.map { source in
            LocalContextSourceReference(id: source.id, uri: source.uri, citation: source.citation)
        }
    }

    public var compactPreview: String {
        let sourceRefs = sourceReferences
            .map { "\($0.id){citation=\($0.citation),uri=\($0.uri)}" }
            .joined(separator: ",")
        let redactionRefs = redactions
            .map { "\($0.id){kind=\($0.kind),source=\($0.sourceId)}" }
            .joined(separator: ",")
        let tags = classification.tags.joined(separator: ",")
        let summaryPreview = summary
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\"", with: "'")
        return "schema=\(schema);v=\(packetVersion);intent=\(classification.intent);risk=\(classification.riskHint);tags=[\(tags)];sources=[\(sourceRefs)];redactions=[\(redactionRefs)];summary=\"\(summaryPreview)\""
    }

    public var sidebarPreview: String {
        let sourceRefs = sourceReferences
            .map { "\($0.id):\($0.citation)" }
            .joined(separator: ",")
        let redactionRefs = redactions
            .map { "\($0.kind)@\($0.sourceId)" }
            .joined(separator: ",")
        let summaryPreview = summary
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\"", with: "'")
        return "schema=\(schema); intent=\(classification.intent); risk=\(classification.riskHint); sources=[\(sourceRefs)]; redactions=[\(redactionRefs)]; summary=\"\(summaryPreview)\""
    }
}

public struct LocalContextCopilotPreview: Equatable, Sendable {
    public let route: LocalContextCopilotRoute
    public let summary: String
    public let classification: LocalContextClassification
    public let compressedContext: String
    public let redactionHints: [LocalContextRedactionHint]
    public let sourceHints: [LocalContextSourceHint]
    public let contextPacket: LocalContextCompactionPacket

    public init(
        route: LocalContextCopilotRoute,
        summary: String,
        classification: LocalContextClassification,
        compressedContext: String,
        redactionHints: [LocalContextRedactionHint],
        sourceHints: [LocalContextSourceHint],
        contextPacket: LocalContextCompactionPacket? = nil
    ) {
        self.route = route
        self.summary = summary
        self.classification = classification
        self.redactionHints = redactionHints
        self.sourceHints = sourceHints
        self.contextPacket = contextPacket ?? LocalContextCompactionPacket(
            summary: summary,
            classification: classification,
            sources: sourceHints,
            redactions: redactionHints
        )
        self.compressedContext = compressedContext
    }
}

public struct LocalContextCopilotRequest: Sendable {
    public let channel: Channel?
    public let messages: [Message]
    public let capability: FoundationModelsCapabilityState

    public init(
        channel: Channel?,
        messages: [Message],
        capability: FoundationModelsCapabilityState
    ) {
        self.channel = channel
        self.messages = messages
        self.capability = capability
    }
}

public struct LocalContextCopilotService: Sendable {
    public init() {}

    public func preview(_ request: LocalContextCopilotRequest) async -> LocalContextCopilotPreview {
        let selectedRoute = route(for: request.capability)
        let deterministic = DeterministicLocalContextCopilot().preview(request, route: selectedRoute)
        guard case .foundationModels = selectedRoute,
              let local = await FoundationModelsLocalContextCompactor().compact(seed: deterministic)
        else {
            return deterministic
        }
        return local
    }

    public func route(for capability: FoundationModelsCapabilityState) -> LocalContextCopilotRoute {
        switch capability {
        case .available:
            return .foundationModels
        case .fallback(let reason):
            return .deterministicFallback(reason)
        }
    }
}

struct DeterministicLocalContextCopilot: Sendable {
    func preview(
        _ request: LocalContextCopilotRequest,
        route: LocalContextCopilotRoute
    ) -> LocalContextCopilotPreview {
        let sourceHints = sourceHints(from: request.messages, channel: request.channel)
        let summary = summary(from: sourceHints)
        let classification = classification(from: sourceHints)
        let redactions = redactionHints(from: sourceHints)
        let packet = LocalContextCompactionPacket(
            summary: summary,
            classification: classification,
            sources: sourceHints,
            redactions: redactions
        )

        return LocalContextCopilotPreview(
            route: route,
            summary: summary,
            classification: classification,
            compressedContext: packet.compactPreview,
            redactionHints: redactions,
            sourceHints: sourceHints,
            contextPacket: packet
        )
    }

    private func sourceHints(from messages: [Message], channel: Channel?) -> [LocalContextSourceHint] {
        let visible = messages
            .filter { !$0.isDeleted }
            .compactMap { message -> (Message, String)? in
                let text = extractedText(from: message)
                guard !text.isEmpty else { return nil }
                return (message, text)
            }
            .suffix(6)

        var hints: [LocalContextSourceHint] = []
        for (index, item) in visible.enumerated() {
            let sourceId = "S\(index + 1)"
            let seqText = item.0.seq.map { "#\($0)" } ?? "pending"
            let channelName = channel?.name.map { "#\($0)" } ?? "channel"
            hints.append(LocalContextSourceHint(
                id: sourceId,
                title: "\(channelName) \(seqText)",
                uri: "momo://channels/\(item.0.channelId.description)/messages/\(item.0.id.description)",
                citation: "[\(sourceId)]",
                excerpt: truncate(clean(item.1), maxCharacters: 160)
            ))
            hints.append(contentsOf: citedSourceHints(from: item.0, parentSourceId: sourceId))
        }
        return uniqued(hints)
    }

    private func extractedText(from message: Message) -> String {
        if let body = message.body?.trimmingCharacters(in: .whitespacesAndNewlines),
           !body.isEmpty {
            return body
        }

        let preferredKeys = ["summary", "title", "action_type", "name", "tool_name"]
        let object = message.props.objectValue ?? [:]
        let parts = preferredKeys.compactMap { object[$0]?.stringValue }
        if !parts.isEmpty {
            return parts.joined(separator: " ")
        }

        if let output = object["output"]?.objectValue {
            return output.values.compactMap(\.stringValue).joined(separator: " ")
        }
        return ""
    }

    private func citedSourceHints(from message: Message, parentSourceId: String) -> [LocalContextSourceHint] {
        guard let badges = message.props["source_badges"]?.arrayValue else {
            return []
        }
        return badges.enumerated().compactMap { index, badge in
            guard let object = badge.objectValue else { return nil }
            let rawId = object["source_id"]?.stringValue ?? "\(parentSourceId)-citation-\(index + 1)"
            let title = object["title"]?.stringValue ?? rawId
            let uri = object["uri"]?.stringValue
                ?? "momo://channels/\(message.channelId.description)/messages/\(message.id.description)"
            let citation = object["citation"]?.stringValue ?? "[\(rawId)]"
            return LocalContextSourceHint(
                id: rawId,
                title: title,
                uri: uri,
                citation: citation,
                excerpt: "cited by \(parentSourceId)"
            )
        }
    }

    private func summary(from sources: [LocalContextSourceHint]) -> String {
        guard !sources.isEmpty else {
            return "No visible channel context yet."
        }
        let first = sources.prefix(3).map { "[\($0.id)] \($0.excerpt)" }
        return first.joined(separator: " ")
    }

    private func classification(from sources: [LocalContextSourceHint]) -> LocalContextClassification {
        let corpus = sources.map(\.excerpt).joined(separator: " ").lowercased()
        let intent: String
        if corpus.contains("approve") || corpus.contains("approval") || corpus.contains("승인") {
            intent = "approve"
        } else if corpus.contains("issue") || corpus.contains("ticket") || corpus.contains("create") {
            intent = "create_ticket"
        } else if corpus.contains("?") || corpus.contains("ask") || corpus.contains("질문") {
            intent = "ask"
        } else if corpus.contains("summary") || corpus.contains("summar") || corpus.contains("요약") {
            intent = "summarize"
        } else {
            intent = "classify"
        }

        let riskHint: String
        if corpus.contains("legal") || corpus.contains("finance") || corpus.contains("write") || corpus.contains("create") {
            riskHint = "approval-required"
        } else {
            riskHint = "read-only"
        }

        var tags = ["visible-context"]
        if !sources.isEmpty { tags.append("source-cited") }
        if riskHint == "approval-required" { tags.append("needs-approval") }
        if containsPII(in: corpus) { tags.append("redaction-preview") }

        return LocalContextClassification(
            intent: intent,
            confidence: sources.isEmpty ? 0.0 : 0.72,
            riskHint: riskHint,
            tags: tags
        )
    }

    private func redactionHints(from sources: [LocalContextSourceHint]) -> [LocalContextRedactionHint] {
        var hints: [LocalContextRedactionHint] = []
        for source in sources {
            if source.excerpt.range(of: #"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}"#,
                                    options: [.regularExpression, .caseInsensitive]) != nil {
                hints.append(LocalContextRedactionHint(
                    id: "\(source.id)-email",
                    kind: "email",
                    preview: "[redacted-email]",
                    sourceId: source.id
                ))
            }
            if source.excerpt.range(of: #"(api[_-]?key|token|secret)\s*[:=]"#,
                                    options: [.regularExpression, .caseInsensitive]) != nil {
                hints.append(LocalContextRedactionHint(
                    id: "\(source.id)-secret",
                    kind: "secret",
                    preview: "[redacted-secret]",
                    sourceId: source.id
                ))
            }
        }
        return hints
    }

    private func containsPII(in text: String) -> Bool {
        text.range(of: #"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}"#,
                   options: [.regularExpression, .caseInsensitive]) != nil
            || text.range(of: #"(api[_-]?key|token|secret)\s*[:=]"#,
                          options: [.regularExpression, .caseInsensitive]) != nil
    }

    private func clean(_ text: String) -> String {
        text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    private func truncate(_ text: String, maxCharacters: Int) -> String {
        guard text.count > maxCharacters else { return text }
        let end = text.index(text.startIndex, offsetBy: maxCharacters)
        return String(text[..<end]).trimmingCharacters(in: .whitespacesAndNewlines) + "..."
    }

    private func uniqued(_ sources: [LocalContextSourceHint]) -> [LocalContextSourceHint] {
        var seen = Set<String>()
        var output: [LocalContextSourceHint] = []
        for source in sources where !seen.contains(source.id) {
            seen.insert(source.id)
            output.append(source)
        }
        return output
    }
}

private struct FoundationModelsLocalContextCompactor: Sendable {
    func compact(seed: LocalContextCopilotPreview) async -> LocalContextCopilotPreview? {
        #if canImport(FoundationModels)
        if #available(macOS 26.0, *) {
            return await FoundationModelsLocalContextCompactorRuntime().compact(seed: seed)
        }
        #endif
        return nil
    }
}

#if canImport(FoundationModels)
@available(macOS 26.0, *)
private struct FoundationModelsLocalContextCompactorRuntime: Sendable {
    func compact(seed: LocalContextCopilotPreview) async -> LocalContextCopilotPreview? {
        do {
            let session = LanguageModelSession(instructions: instructions)
            let response = try await session.respond(to: prompt(for: seed))
            return FoundationModelsCompactionPatch(response.content).applying(to: seed)
        } catch {
            return nil
        }
    }

    private var instructions: String {
        """
        You compact momo channel context for a sidebar preview. Return exactly four lines:
        summary: <one concise sentence>
        intent: <one of classify, ask, summarize, create_ticket, approve>
        risk: <read-only or approval-required>
        tags: <comma-separated lowercase tags>

        Preserve the supplied source ids by reference. Do not invent new source ids, URIs, or citations.
        """
    }

    private func prompt(for seed: LocalContextCopilotPreview) -> String {
        let sources = seed.contextPacket.sources.map { source in
            "- \(source.id) citation=\(source.citation) uri=\(source.uri) excerpt=\(source.excerpt)"
        }
        .joined(separator: "\n")
        return """
        Compact these source-preserving Context Packet inputs.

        Existing deterministic summary:
        \(seed.summary)

        Existing classification:
        intent=\(seed.classification.intent)
        risk=\(seed.classification.riskHint)
        tags=\(seed.classification.tags.joined(separator: ","))

        Sources:
        \(sources)
        """
    }
}
#endif

private struct FoundationModelsCompactionPatch: Sendable {
    private let summary: String?
    private let intent: String?
    private let risk: String?
    private let tags: [String]?

    init(_ raw: String) {
        var summary: String?
        var intent: String?
        var risk: String?
        var tags: [String]?

        for line in raw.split(whereSeparator: \.isNewline) {
            let parts = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
            guard parts.count == 2 else { continue }
            let key = parts[0].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let value = parts[1].trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty else { continue }
            switch key {
            case "summary":
                summary = value
            case "intent":
                intent = value
            case "risk":
                risk = value
            case "tags":
                tags = value
                    .split(separator: ",")
                    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
                    .filter { !$0.isEmpty }
            default:
                continue
            }
        }

        self.summary = summary
        self.intent = intent
        self.risk = risk
        self.tags = tags
    }

    func applying(to seed: LocalContextCopilotPreview) -> LocalContextCopilotPreview? {
        guard let summary else { return nil }
        let classification = LocalContextClassification(
            intent: stableIntent(intent ?? seed.classification.intent, fallback: seed.classification.intent),
            confidence: min(0.93, max(seed.classification.confidence, 0.80)),
            riskHint: stableRisk(risk ?? seed.classification.riskHint, fallback: seed.classification.riskHint),
            tags: stableTags(tags ?? seed.classification.tags, fallback: seed.classification.tags)
        )
        let packet = LocalContextCompactionPacket(
            summary: summary,
            classification: classification,
            sources: seed.contextPacket.sources,
            redactions: seed.contextPacket.redactions
        )
        return LocalContextCopilotPreview(
            route: seed.route,
            summary: summary,
            classification: classification,
            compressedContext: packet.compactPreview,
            redactionHints: seed.redactionHints,
            sourceHints: seed.sourceHints,
            contextPacket: packet
        )
    }

    private func stableIntent(_ proposed: String, fallback: String) -> String {
        let allowed = ["classify", "ask", "summarize", "create_ticket", "approve"]
        let normalized = proposed.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return allowed.contains(normalized) ? normalized : fallback
    }

    private func stableRisk(_ proposed: String, fallback: String) -> String {
        let normalized = proposed.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return ["read-only", "approval-required"].contains(normalized) ? normalized : fallback
    }

    private func stableTags(_ proposed: [String], fallback: [String]) -> [String] {
        let normalized = proposed
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
            .filter { !$0.isEmpty }
        let required = ["visible-context", "source-cited"]
        var output: [String] = []
        for tag in required + normalized + fallback where !output.contains(tag) {
            output.append(tag)
        }
        return output
    }
}
