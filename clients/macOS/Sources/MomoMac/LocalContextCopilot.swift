import Foundation
import MomoCore

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
    public let excerpt: String

    public init(id: String, title: String, uri: String, excerpt: String) {
        self.id = id
        self.title = title
        self.uri = uri
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

public struct LocalContextCopilotPreview: Equatable, Sendable {
    public let route: LocalContextCopilotRoute
    public let summary: String
    public let classification: LocalContextClassification
    public let compressedContext: String
    public let redactionHints: [LocalContextRedactionHint]
    public let sourceHints: [LocalContextSourceHint]

    public init(
        route: LocalContextCopilotRoute,
        summary: String,
        classification: LocalContextClassification,
        compressedContext: String,
        redactionHints: [LocalContextRedactionHint],
        sourceHints: [LocalContextSourceHint]
    ) {
        self.route = route
        self.summary = summary
        self.classification = classification
        self.compressedContext = compressedContext
        self.redactionHints = redactionHints
        self.sourceHints = sourceHints
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
        DeterministicLocalContextCopilot().preview(request, route: route(for: request.capability))
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
        let compressedContext = compressedContext(from: sourceHints, classification: classification)
        let redactions = redactionHints(from: sourceHints)

        return LocalContextCopilotPreview(
            route: route,
            summary: summary,
            classification: classification,
            compressedContext: compressedContext,
            redactionHints: redactions,
            sourceHints: sourceHints
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
                excerpt: truncate(clean(item.1), maxCharacters: 160)
            ))
            hints.append(contentsOf: citedSourceHints(from: item.0, parentSourceId: sourceId))
        }
        return hints
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
            return LocalContextSourceHint(
                id: "C\(index + 1)-\(rawId)",
                title: title,
                uri: uri,
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

    private func compressedContext(
        from sources: [LocalContextSourceHint],
        classification: LocalContextClassification
    ) -> String {
        guard !sources.isEmpty else {
            return "intent=none; sources=[]; notes=[]"
        }
        let sourceIds = sources.map(\.id).joined(separator: ",")
        let notes = sources.prefix(4).map { "\($0.id):\(truncate($0.excerpt, maxCharacters: 72))" }
            .joined(separator: " | ")
        return "intent=\(classification.intent); risk=\(classification.riskHint); sources=[\(sourceIds)]; notes=\(notes)"
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
}
