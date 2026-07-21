import Foundation

/// The closed artifact vocabulary from ADR-0126 D2. Keeping this model in
/// MomoCore gives every client the same props and fallback rules without adding
/// a new artifact store or transport.
public enum MessageArtifactKind: String, Sendable, Hashable {
    case diff
    case commit
    case pr
}

public enum MessageArtifactPresentation: Sendable, Hashable {
    case diff(UnifiedDiffPresentation)
    case link(ArtifactLinkPresentation)

    /// Resolves explicit `artifact_kind` props first, then the legacy typed
    /// message shape, and finally a conservatively detected unified diff.
    /// Malformed and oversized values return nil so callers keep their normal
    /// message/code rendering.
    public static func resolve(message: Message) -> MessageArtifactPresentation? {
        MessageArtifactParser.resolve(message: message)
    }
}

public struct UnifiedDiffPresentation: Sendable, Hashable {
    public let title: String
    public let files: [UnifiedDiffFile]
    public let additions: Int
    public let deletions: Int

    public init(title: String, files: [UnifiedDiffFile], additions: Int, deletions: Int) {
        self.title = title
        self.files = files
        self.additions = additions
        self.deletions = deletions
    }
}

public struct UnifiedDiffFile: Identifiable, Sendable, Hashable {
    public let id: Int
    public let path: String
    public let additions: Int
    public let deletions: Int
    public let lines: [UnifiedDiffLine]

    public init(id: Int, path: String, additions: Int, deletions: Int, lines: [UnifiedDiffLine]) {
        self.id = id
        self.path = path
        self.additions = additions
        self.deletions = deletions
        self.lines = lines
    }
}

public struct UnifiedDiffLine: Identifiable, Sendable, Hashable {
    public enum Kind: Sendable, Hashable {
        case metadata
        case hunk
        case context
        case addition
        case deletion
    }

    public let id: Int
    public let kind: Kind
    public let text: String

    public init(id: Int, kind: Kind, text: String) {
        self.id = id
        self.kind = kind
        self.text = text
    }
}

public struct ArtifactLinkPresentation: Sendable, Hashable {
    public let kind: MessageArtifactKind
    public let title: String
    public let branch: String?
    public let status: String?
    public let repository: String?
    /// Only HTTPS URLs without credential-like query keys survive resolution.
    public let url: URL?

    public init(
        kind: MessageArtifactKind,
        title: String,
        branch: String?,
        status: String?,
        repository: String?,
        url: URL?
    ) {
        self.kind = kind
        self.title = title
        self.branch = branch
        self.status = status
        self.repository = repository
        self.url = url
    }
}

private enum MessageArtifactParser {
    private static let maximumSourceBytes = 200_000
    private static let maximumLineCount = 2_000
    private static let maximumFileCount = 100

    private struct FileAccumulator {
        var oldPath: String?
        var newPath: String?
        var additions = 0
        var deletions = 0
        var lines: [UnifiedDiffLine] = []

        var displayPath: String {
            let candidate = newPath == "/dev/null" ? oldPath : (newPath ?? oldPath)
            return normalizedDisplayPath(candidate) ?? "Changed file"
        }
    }

    static func resolve(message: Message) -> MessageArtifactPresentation? {
        let explicitKind = artifactKind(in: message)

        switch explicitKind {
        case .commit, .pr:
            guard let explicitKind else { return nil }
            return .link(linkPresentation(kind: explicitKind, props: message.props))
        case .diff:
            guard let source = diffSource(in: message),
                  let presentation = parseDiff(source, title: string(message.props, "title") ?? "Code changes") else {
                return nil
            }
            return .diff(presentation)
        case nil:
            guard let body = message.body,
                  looksLikeUnifiedDiff(body),
                  let presentation = parseDiff(body, title: string(message.props, "title") ?? "Code changes") else {
                return nil
            }
            return .diff(presentation)
        }
    }

    private static func artifactKind(in message: Message) -> MessageArtifactKind? {
        if let raw = string(message.props, "artifact_kind")?.lowercased(),
           let kind = MessageArtifactKind(rawValue: raw) {
            return kind
        }

        // Legacy artifact cards used `kind`; keep the fallback closed to the
        // three ADR values and only for the structured artifact message type.
        if message.type == .artifact,
           let raw = string(message.props, "kind")?.lowercased(),
           let kind = MessageArtifactKind(rawValue: raw) {
            return kind
        }

        return message.type == .diff ? .diff : nil
    }

    private static func diffSource(in message: Message) -> String? {
        string(message.props, "patch") ?? message.body
    }

    private static func linkPresentation(kind: MessageArtifactKind, props: JSON) -> ArtifactLinkPresentation {
        let fallbackTitle = kind == .commit ? "Commit" : "Pull request"
        let rawURL = string(props, "url") ?? string(props, "uri")
        return ArtifactLinkPresentation(
            kind: kind,
            title: bounded(string(props, "title"), maximum: 200) ?? fallbackTitle,
            branch: bounded(string(props, "branch"), maximum: 120),
            status: bounded(string(props, "status"), maximum: 80),
            repository: bounded(string(props, "repository"), maximum: 160),
            url: rawURL.flatMap(safeHTTPSURL)
        )
    }

    private static func parseDiff(_ rawSource: String, title: String) -> UnifiedDiffPresentation? {
        let source = stripSingleDiffFence(rawSource)
        guard source.utf8.count <= maximumSourceBytes else { return nil }

        let rawLines = source.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        guard rawLines.count <= maximumLineCount else { return nil }

        var files: [UnifiedDiffFile] = []
        var current: FileAccumulator?
        var sawDiffMarker = false
        var sawHunk = false

        func appendCurrent() {
            guard let value = current, !value.lines.isEmpty, files.count < maximumFileCount else { return }
            files.append(
                UnifiedDiffFile(
                    id: files.count,
                    path: value.displayPath,
                    additions: value.additions,
                    deletions: value.deletions,
                    lines: value.lines
                )
            )
        }

        for (lineIndex, line) in rawLines.enumerated() {
            if line.hasPrefix("diff --git ") {
                appendCurrent()
                guard files.count < maximumFileCount else { return nil }
                let paths = diffGitPaths(line)
                current = FileAccumulator(oldPath: paths?.0, newPath: paths?.1)
                sawDiffMarker = true
                current?.lines.append(.init(id: lineIndex, kind: .metadata, text: line))
                continue
            }

            if line.hasPrefix("--- ") {
                if current == nil { current = FileAccumulator() }
                current?.oldPath = headerPath(line, prefix: "--- ")
                current?.lines.append(.init(id: lineIndex, kind: .metadata, text: line))
                continue
            }

            if line.hasPrefix("+++ ") {
                if current == nil { current = FileAccumulator() }
                current?.newPath = headerPath(line, prefix: "+++ ")
                current?.lines.append(.init(id: lineIndex, kind: .metadata, text: line))
                continue
            }

            guard current != nil else { continue }
            let kind: UnifiedDiffLine.Kind
            if line.hasPrefix("@@") {
                kind = .hunk
                sawHunk = true
            } else if line.hasPrefix("+") {
                kind = .addition
                current?.additions += 1
            } else if line.hasPrefix("-") {
                kind = .deletion
                current?.deletions += 1
            } else if line.hasPrefix(" ") || line.isEmpty {
                kind = .context
            } else {
                kind = .metadata
            }
            current?.lines.append(.init(id: lineIndex, kind: kind, text: line))
        }

        appendCurrent()
        guard !files.isEmpty, sawHunk || sawDiffMarker else { return nil }

        return UnifiedDiffPresentation(
            title: bounded(title, maximum: 200) ?? "Code changes",
            files: files,
            additions: files.reduce(0) { $0 + $1.additions },
            deletions: files.reduce(0) { $0 + $1.deletions }
        )
    }

    private static func looksLikeUnifiedDiff(_ rawSource: String) -> Bool {
        let trimmedSource = rawSource.trimmingCharacters(in: .whitespacesAndNewlines)
        let source = stripSingleDiffFence(trimmedSource)
        guard source.utf8.count <= maximumSourceBytes else { return false }
        let lines = source.split(separator: "\n", omittingEmptySubsequences: false)
        guard let firstContentLine = lines.first(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }),
              source != trimmedSource
                || firstContentLine.hasPrefix("diff --git ")
                || firstContentLine.hasPrefix("--- ") else {
            return false
        }
        let hasHunk = lines.contains(where: { $0.hasPrefix("@@") })
        let hasGitMarker = lines.contains(where: { $0.hasPrefix("diff --git ") })
        let hasHeaders = lines.contains(where: { $0.hasPrefix("--- ") })
            && lines.contains(where: { $0.hasPrefix("+++ ") })
        return hasGitMarker && (hasHunk || hasHeaders) || (hasHeaders && hasHunk)
    }

    private static func stripSingleDiffFence(_ source: String) -> String {
        let lines = source.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        guard lines.count >= 3 else { return source }
        let opening = lines[0].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard opening == "```diff" || opening == "```patch",
              lines[lines.count - 1].trimmingCharacters(in: .whitespacesAndNewlines) == "```" else {
            return source
        }
        return lines.dropFirst().dropLast().joined(separator: "\n")
    }

    private static func diffGitPaths(_ line: String) -> (String, String)? {
        let payload = line.dropFirst("diff --git ".count)
        let pieces = payload.split(separator: " ", maxSplits: 1).map(String.init)
        guard pieces.count == 2 else { return nil }
        return (pieces[0], pieces[1])
    }

    private static func headerPath(_ line: String, prefix: String) -> String {
        let payload = String(line.dropFirst(prefix.count))
        return payload.split(separator: "\t", maxSplits: 1).first.map(String.init) ?? payload
    }

    private static func normalizedDisplayPath(_ rawPath: String?) -> String? {
        guard var path = rawPath?.trimmingCharacters(in: .whitespacesAndNewlines), !path.isEmpty else {
            return nil
        }
        if path.hasPrefix("\"") && path.hasSuffix("\"") && path.count >= 2 {
            path.removeFirst()
            path.removeLast()
        }
        if path.hasPrefix("a/") || path.hasPrefix("b/") {
            path.removeFirst(2)
        }
        if path.hasPrefix("/"), path != "/dev/null" {
            path = path.split(separator: "/").last.map(String.init) ?? "Changed file"
        }
        return path == "/dev/null" ? nil : path
    }

    private static func string(_ props: JSON, _ key: String) -> String? {
        guard let value = props[key]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else {
            return nil
        }
        return value
    }

    private static func bounded(_ value: String?, maximum: Int) -> String? {
        guard let value, value.count <= maximum else { return nil }
        return value
    }

    private static func safeHTTPSURL(_ rawValue: String) -> URL? {
        guard var components = URLComponents(string: rawValue),
              components.scheme?.lowercased() == "https",
              components.host?.isEmpty == false,
              components.user == nil,
              components.password == nil else {
            return nil
        }

        let sensitiveFragments = ["token", "capability", "authorization", "signature", "secret", "api_key", "apikey"]
        if components.queryItems?.contains(where: { item in
            let name = item.name.lowercased()
            return sensitiveFragments.contains(where: name.contains)
        }) == true {
            return nil
        }
        components.fragment = nil
        return components.url
    }
}
