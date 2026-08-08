import Foundation
import Hummingbird

struct WebhookRenderedMessage: Equatable, Sendable {
    let body: String
    let clientProps: [String: String]
}

/// Strict native JSON and Mattermost-compatible Slack legacy transformation.
enum WebhookPayload {
    static let maximumBodyBytes = 256 * 1024
    static let maximumMessageCharacters = 40_000
    static let maximumAttachments = 20
    static let maximumFieldsPerAttachment = 20

    /// Native payload v1: `{ "text": "...", "event_type"?: "...",
    /// "metadata"?: {"key":"value"} }`. Unknown keys fail closed.
    static func native(data: Data) throws -> WebhookRenderedMessage {
        let object = try jsonObject(data)
        try requireOnlyKeys(object, allowed: ["text", "event_type", "metadata"], label: "native")
        guard let text = object["text"] as? String else {
            throw HTTPError(.badRequest, message: "native webhook payload requires text")
        }
        let body = try boundedText(text, label: "native webhook text")
        var props: [String: String] = [:]
        if let eventType = object["event_type"] {
            guard let eventType = eventType as? String,
                  !eventType.isEmpty, eventType.count <= 120
            else {
                throw HTTPError(.badRequest, message: "native event_type must contain 1...120 characters")
            }
            props["event_type"] = eventType
        }
        if let rawMetadata = object["metadata"] {
            guard let metadata = rawMetadata as? [String: Any], metadata.count <= 32 else {
                throw HTTPError(.badRequest, message: "native metadata must be an object with at most 32 entries")
            }
            for (key, rawValue) in metadata {
                guard key.wholeMatch(of: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/) != nil,
                      let value = rawValue as? String,
                      value.count <= 1_000
                else {
                    throw HTTPError(.badRequest, message: "native metadata must contain bounded string keys and values")
                }
                props["metadata.\(key)"] = value
            }
        }
        return .init(body: body, clientProps: props)
    }

    /// Slack-compatible v0 follows the Mattermost compatibility subset:
    /// top-level `text` plus legacy `attachments`. Block Kit, channel IDs,
    /// mrkdwn/parse/link_names, and Slack-only identity overrides are rejected.
    static func slackCompatible(data: Data) throws -> WebhookRenderedMessage {
        let root = try jsonObject(data)
        if root.keys.contains("blocks") {
            throw HTTPError(
                .badRequest,
                message: "Slack-compatible blocks are not supported in v0; use text and legacy attachments"
            )
        }
        // Review #443 H1: Mattermost's 12-year Slack-compat contract IGNORES
        // unsupported top-level fields (username, icon_emoji, channel,
        // link_names, mrkdwn, unfurl_links, ...) rather than rejecting — that
        // is what lets GitHub/Jenkins/Grafana/Alertmanager work by swapping
        // only the URL. We read text/attachments and drop the rest. Dropping
        // identity overrides (username/icon_*) also keeps author non-spoofable.
        // Only `blocks` is a hard 400 (handled above).

        var sections: [String] = []
        if let rawText = root["text"] {
            guard let text = rawText as? String else {
                throw HTTPError(.badRequest, message: "Slack-compatible text must be a string")
            }
            let translated = try translateSlackMarkup(text)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !translated.isEmpty { sections.append(translated) }
        }

        if let rawAttachments = root["attachments"] {
            guard let attachments = rawAttachments as? [Any],
                  attachments.count <= maximumAttachments
            else {
                throw HTTPError(.badRequest, message: "Slack-compatible attachments must contain at most 20 items")
            }
            for rawAttachment in attachments {
                guard let attachment = rawAttachment as? [String: Any] else {
                    throw HTTPError(.badRequest, message: "Slack-compatible attachment must be an object")
                }
                if let rendered = try renderAttachment(attachment) { sections.append(rendered) }
            }
        }

        let body = sections.joined(separator: "\n\n")
        guard !body.isEmpty else {
            throw HTTPError(.badRequest, message: "Slack-compatible payload requires non-empty text or attachments")
        }
        return .init(
            body: try boundedText(body, label: "Slack-compatible rendered message"),
            clientProps: ["slack_compatible": "true"]
        )
    }

    static func translateSlackMarkup(_ source: String) throws -> String {
        // Review #443 H1: `*bold*` is left as-is (rendered literally) — MM does
        // the same. Rejecting it 400s Grafana's default `*Alerting*` templates.
        let sourceRange = NSRange(source.startIndex..<source.endIndex, in: source)
        let pattern = #"<([^<>]+)>"#
        let regex = try NSRegularExpression(pattern: pattern)
        var output = source
        for match in regex.matches(in: source, range: sourceRange).reversed() {
            guard let tokenRange = Range(match.range(at: 1), in: source),
                  let wholeRange = Range(match.range(at: 0), in: output)
            else { continue }
            let token = String(source[tokenRange])
            let replacement: String
            if token == "!channel" {
                replacement = "@channel"
            } else if token == "!everyone" || token == "!here" {
                // H1: render as plain text; oort doesn't interpret Slack broadcasts.
                replacement = "@\(token.dropFirst())"
            } else if token.hasPrefix("!subteam^") {
                replacement = "@team"
            } else if token.hasPrefix("#") {
                // Slack channel-ID mention: render the label after `|`, else drop.
                let parts = token.split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false)
                replacement = parts.count == 2 ? "#\(parts[1])" : ""
            } else if token.hasPrefix("@") {
                // `<@U123>` or legacy `<@U123|label>` — prefer the label.
                let inner = String(token.dropFirst())
                let parts = inner.split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false)
                if parts.count == 2, !parts[1].isEmpty {
                    replacement = "@\(parts[1])"
                } else if inner.wholeMatch(of: /^[A-Za-z0-9._-]{1,80}$/) != nil {
                    replacement = "@\(inner)"
                } else {
                    replacement = "@\(inner)"  // literal fallback; never 400 a mention
                }
            } else {
                let parts = token.split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false)
                let target = String(parts[0])
                if let url = URL(string: target),
                   ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") {
                    replacement = (parts.count == 2 && !parts[1].isEmpty)
                        ? "[\(parts[1])](\(target))" : target
                } else {
                    // H1: unknown angle-bracket token rendered literally, not 400.
                    replacement = (parts.count == 2 && !parts[1].isEmpty)
                        ? String(parts[1]) : target
                }
            }
            output.replaceSubrange(wholeRange, with: replacement)
        }
        return output
    }

    private static func renderAttachment(_ object: [String: Any]) throws -> String? {
        let allowed: Set<String> = [
            "fallback", "color", "pretext", "author_name", "author_link", "author_icon",
            "title", "title_link", "text", "fields", "image_url", "thumb_url",
            "footer", "footer_icon",
        ]
        // Review #443 H1: unknown attachment keys (ts, mrkdwn_in, actions, ...)
        // are ignored, not rejected — MM parity, so Alertmanager/Grafana
        // attachments render instead of 400ing on first delivery.
        _ = allowed
        var lines: [String] = []

        func translated(_ key: String) throws -> String? {
            guard let raw = object[key] else { return nil }
            guard let rawValue = raw as? String else {
                throw HTTPError(.badRequest, message: "Slack attachment \(key) must be a string")
            }
            let value = try translateSlackMarkup(rawValue).trimmingCharacters(in: .whitespacesAndNewlines)
            return value.isEmpty ? nil : value
        }

        if let pretext = try translated("pretext") { lines.append(pretext) }
        if let author = try translated("author_name") {
            if let link = try validatedURLString(object["author_link"], label: "author_link") {
                lines.append("[\(author)](\(link))")
            } else {
                lines.append(author)
            }
        }
        if let title = try translated("title") {
            if let link = try validatedURLString(object["title_link"], label: "title_link") {
                lines.append("[\(title)](\(link))")
            } else {
                lines.append(title)
            }
        }
        if let text = try translated("text") { lines.append(text) }

        if let rawFields = object["fields"] {
            guard let fields = rawFields as? [Any], fields.count <= maximumFieldsPerAttachment else {
                throw HTTPError(.badRequest, message: "Slack attachment fields must contain at most 20 items")
            }
            for rawField in fields {
                guard let field = rawField as? [String: Any] else {
                    throw HTTPError(.badRequest, message: "Slack attachment field must be an object")
                }
                // H1: unknown field keys ignored (MM parity).
                if let short = field["short"], !(short is Bool) {
                    throw HTTPError(.badRequest, message: "Slack attachment field short must be boolean")
                }
                guard let rawValue = field["value"] as? String else {
                    throw HTTPError(.badRequest, message: "Slack attachment field requires a string value")
                }
                let value = try translateSlackMarkup(rawValue)
                if let rawTitle = field["title"] {
                    guard let title = rawTitle as? String else {
                        throw HTTPError(.badRequest, message: "Slack attachment field title must be a string")
                    }
                    lines.append("\(try translateSlackMarkup(title)): \(value)")
                } else {
                    lines.append(value)
                }
            }
        }

        if let image = try validatedURLString(object["image_url"], label: "image_url") {
            lines.append(image)
        }
        if let thumb = try validatedURLString(object["thumb_url"], label: "thumb_url") {
            lines.append(thumb)
        }
        if let footer = try translated("footer") { lines.append(footer) }

        // color/author_icon/footer_icon are accepted Mattermost compatibility
        // metadata but have no trusted text rendering in oort v0.
        _ = try validatedOptionalString(object["fallback"], label: "fallback")
        _ = try validatedOptionalString(object["color"], label: "color")
        _ = try validatedURLString(object["author_icon"], label: "author_icon")
        _ = try validatedURLString(object["footer_icon"], label: "footer_icon")

        if lines.isEmpty, let fallback = try translated("fallback") { lines.append(fallback) }
        let rendered = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return rendered.isEmpty ? nil : rendered
    }

    private static func jsonObject(_ data: Data) throws -> [String: Any] {
        guard !data.isEmpty, data.count <= maximumBodyBytes else {
            throw HTTPError(.badRequest, message: "webhook body must contain 1...262144 bytes")
        }
        do {
            let json = try JSONSerialization.jsonObject(with: data)
            guard let object = json as? [String: Any] else {
                throw HTTPError(.badRequest, message: "webhook body must be a JSON object")
            }
            return object
        } catch let error as HTTPError {
            throw error
        } catch {
            throw HTTPError(.badRequest, message: "webhook body must be valid JSON")
        }
    }

    private static func requireOnlyKeys(
        _ object: [String: Any], allowed: Set<String>, label: String
    ) throws {
        let unsupported = Set(object.keys).subtracting(allowed).sorted()
        guard unsupported.isEmpty else {
            throw HTTPError(.badRequest, message: "unsupported \(label) field(s): \(unsupported.joined(separator: ", "))")
        }
    }

    private static func boundedText(_ text: String, label: String) throws -> String {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value.count <= maximumMessageCharacters else {
            throw HTTPError(.badRequest, message: "\(label) must contain 1...40000 characters")
        }
        return value
    }

    private static func validatedOptionalString(_ raw: Any?, label: String) throws -> String? {
        guard let raw else { return nil }
        guard let value = raw as? String, value.count <= 2_000 else {
            throw HTTPError(.badRequest, message: "Slack attachment \(label) must be a bounded string")
        }
        return value
    }

    private static func validatedURLString(_ raw: Any?, label: String) throws -> String? {
        guard let value = try validatedOptionalString(raw, label: label) else { return nil }
        guard let url = URL(string: value), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else {
            throw HTTPError(.badRequest, message: "Slack attachment \(label) must be an HTTP(S) URL")
        }
        return value
    }
}
