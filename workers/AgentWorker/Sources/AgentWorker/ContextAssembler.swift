import Foundation

/// MOMO-302 — assemble a single trigger message plus its same-channel history
/// window into an OpenAI-compatible chat array.
///
/// Session boundary = (workspace, agent, channel). The server guarantees the
/// `recent_messages` window is same-channel only; this assembler never mixes
/// channels — it maps whatever the payload hands it.
///
/// Role mapping (L4 §6.1):
///   - the trigger agent's own past turns  → `assistant`
///   - humans and *other* agents           → `user`, prefixed with "[display] "
///     so the model can attribute each speaker inside one `user` stream.
///
/// Budget: a character-count approximation. When the window exceeds
/// `maxChars`, the oldest non-trigger messages are dropped first; the trigger
/// message is always retained even if it alone exceeds the budget.
///
/// The whole type is pure/deterministic so role mapping, truncation, and the
/// legacy single-message fallback are unit-testable without a live provider.
enum ContextAssembler {
    struct Result: Equatable {
        let messages: [HermesTransport.ChatMessage]
        let droppedCount: Int
        let memoryIncludedCount: Int
        let memoryInjected: Bool
    }

    private struct Turn {
        let role: String
        let content: String
        let isTrigger: Bool
    }

    /// Build the chat array. When `recentMessages` is empty (legacy/back-compat
    /// payloads) the amnesiac single-message path is preserved: an optional
    /// system prompt followed by one `user` turn carrying `fallbackPrompt`.
    static func assemble(
        recentMessages: [RecentMessage],
        agentMemberID: UUID,
        triggerMessageID: UUID?,
        fallbackPrompt: String,
        systemPrompt: String?,
        memoryRefs: [JSONValue]? = nil,
        maxChars: Int
    ) -> Result {
        var head: [HermesTransport.ChatMessage] = []
        if let systemPrompt,
           !systemPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            head.append(HermesTransport.ChatMessage(role: "system", content: systemPrompt))
        }

        let memoryIncludedCount = memoryRefs?.count ?? 0
        var memoryBlock = memoryContextBlock(memoryRefs)

        var turns: [Turn]
        if recentMessages.isEmpty {
            turns = [Turn(role: "user", content: fallbackPrompt, isTrigger: true)]
        } else {
            turns = recentMessages.map { message in
                let isSelf = message.authorMemberID != nil && message.authorMemberID == agentMemberID
                let body = message.body ?? ""
                let isTrigger = triggerMessageID != nil && message.messageID == triggerMessageID
                if isSelf {
                    return Turn(role: "assistant", content: body, isTrigger: isTrigger)
                }
                let display = message.authorDisplay?.trimmingCharacters(in: .whitespacesAndNewlines)
                let content = (display?.isEmpty == false) ? "[\(display!)] \(body)" : body
                return Turn(role: "user", content: content, isTrigger: isTrigger)
            }
        }

        // MOMO-302 (review high): drop non-trigger turns whose content is
        // empty/whitespace so we never emit a `{role, content:""}` chat message
        // (some OpenAI-compatible endpoints reject empty content). The server
        // already summarizes structured types (diff/artifact/approval_request);
        // this is defense-in-depth for any residual empty body. The trigger is
        // always kept (it is the mention text and never empty in practice).
        turns = turns.filter { $0.isTrigger || !$0.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

        // If the server never tagged a trigger (defensive), treat the newest
        // (last, since the window is ASC by seq) turn as always-keep so budget
        // trimming can never erase the current turn.
        if !turns.contains(where: { $0.isTrigger }), let last = turns.indices.last {
            turns[last] = Turn(role: turns[last].role, content: turns[last].content, isTrigger: true)
        }

        var total = turns.reduce(memoryBlock?.count ?? 0) { $0 + $1.content.count }
        var dropped = 0
        // Drop oldest-first; never drop the trigger, never drop the last survivor.
        while total > maxChars, turns.count > 1, !turns[0].isTrigger {
            total -= turns[0].content.count
            turns.removeFirst()
            dropped += 1
        }

        // The current trigger is the hard keep. If history trimming is not
        // enough, discard the lower-priority memory block before the trigger.
        if total > maxChars, memoryBlock != nil {
            memoryBlock = nil
        }

        let tail = turns.map { HermesTransport.ChatMessage(role: $0.role, content: $0.content) }
        let memoryHead = memoryBlock.map {
            [HermesTransport.ChatMessage(role: "system", content: $0)]
        } ?? []
        return Result(
            messages: head + memoryHead + tail,
            droppedCount: dropped,
            memoryIncludedCount: memoryIncludedCount,
            memoryInjected: memoryBlock != nil
        )
    }

    private static func memoryContextBlock(_ refs: [JSONValue]?) -> String? {
        guard let refs, !refs.isEmpty else { return nil }
        let rows = refs.compactMap { ref -> String? in
            guard let excerpt = ref["excerpt"]?.stringValue?
                .trimmingCharacters(in: .whitespacesAndNewlines),
                !excerpt.isEmpty
            else { return nil }
            let kind = ref["kind"]?.stringValue ?? "unknown"
            let scope = ref["scope"]?.stringValue ?? "unknown"
            let sourceIDs = ref["source_ids"]?.jsonString() ?? "[]"
            let indentedExcerpt = excerpt.replacingOccurrences(of: "\n", with: "\n    ")
            return """
            - kind: \(kind)
              scope: \(scope)
              excerpt: |
                \(indentedExcerpt)
              source_ids: \(sourceIDs)
            """
        }
        guard !rows.isEmpty else { return nil }
        return "워크스페이스 메모리\n" + rows.joined(separator: "\n")
    }
}
