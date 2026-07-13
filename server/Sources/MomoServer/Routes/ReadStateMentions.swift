import Foundation
import Logging
import PostgresNIO

/// Stores the server's mention decision at message-insert time.
///
/// The parsed member ids live in `message.props.mention_member_ids`, so later
/// read-state calculations are stable even when a member changes handle or
/// display name. The existing `read_state.mention_count` projection is updated
/// in the same transaction; no schema extension is required for ADR-0109 v0.
enum ReadStateMentions {
    private struct Candidate {
        let id: UUID
        let handle: String
        let displayName: String
    }

    static func record(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        channelID: UUID,
        messageID: UUID,
        messageSeq: Int64,
        authorMemberID: UUID,
        body: String?
    ) async throws -> [UUID] {
        guard let body, !body.isEmpty else { return [] }

        let rows = try await conn.query(
            """
            SELECT m.id, m.handle, m.display_name
              FROM membership ms
              JOIN member m
                ON m.id = ms.member_id
               AND m.workspace_id = \(workspaceID)
               AND m.status = 'active'
               AND m.deleted_at IS NULL
             WHERE ms.channel_id = \(channelID)
               AND ms.left_at IS NULL
               AND m.id <> \(authorMemberID)
             ORDER BY m.id
            """,
            logger: logger
        ).collect()
        let candidates = try rows.map { row in
            let (id, handle, displayName) = try row.decode((UUID, String, String).self)
            return Candidate(id: id, handle: handle, displayName: displayName)
        }
        let recipientIDs = candidates.compactMap { candidate in
            containsMention(
                body,
                handle: candidate.handle,
                displayName: candidate.displayName,
                memberID: candidate.id
            ) ? candidate.id : nil
        }
        guard !recipientIDs.isEmpty else { return [] }

        let recipientStrings = recipientIDs.map(\.uuidString)
        _ = try await conn.query(
            """
            UPDATE message
               SET props = jsonb_set(
                     COALESCE(props, '{}'::jsonb),
                     '{mention_member_ids}',
                     to_jsonb(\(recipientStrings)::text[]),
                     true
                   )
             WHERE id = \(messageID)
               AND workspace_id = \(workspaceID)
               AND channel_id = \(channelID)
            """,
            logger: logger
        )

        _ = try await conn.query(
            """
            INSERT INTO read_state
              (workspace_id, channel_id, member_id, last_read_seq,
               last_read_at, mention_count, updated_at)
            SELECT \(workspaceID), \(channelID), mentioned.member_id, 0,
                   now(), 1, now()
              FROM unnest(\(recipientIDs)::uuid[]) AS mentioned(member_id)
            ON CONFLICT (channel_id, member_id)
            DO UPDATE
               SET mention_count = read_state.mention_count
                     + CASE WHEN read_state.last_read_seq < \(messageSeq) THEN 1 ELSE 0 END,
                   updated_at = CASE
                     WHEN read_state.last_read_seq < \(messageSeq) THEN now()
                     ELSE read_state.updated_at
                   END
            """,
            logger: logger
        )
        return recipientIDs
    }

    static func containsMention(
        _ text: String,
        handle: String,
        displayName: String,
        memberID: UUID
    ) -> Bool {
        let trimmedHandle = handle.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedName = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        let id = memberID.uuidString.lowercased()

        if !trimmedHandle.isEmpty,
           containsMentionToken(text, marker: "@\(trimmedHandle)", caseInsensitive: true)
            || containsMentionToken(text, marker: "<@\(trimmedHandle)>", caseInsensitive: true)
        {
            return true
        }
        if !trimmedName.isEmpty,
           containsMentionToken(text, marker: "@\(trimmedName)", caseInsensitive: false)
            || containsMentionToken(text, marker: "<@\(trimmedName)>", caseInsensitive: false)
        {
            return true
        }
        return containsMentionToken(text, marker: "<@\(id)>", caseInsensitive: true)
            || containsMentionToken(text, marker: "@\(id)", caseInsensitive: true)
    }

    private static func containsMentionToken(
        _ text: String,
        marker: String,
        caseInsensitive: Bool
    ) -> Bool {
        let haystack = caseInsensitive ? text.lowercased() : text
        let needle = caseInsensitive ? marker.lowercased() : marker
        guard !needle.isEmpty else { return false }

        var searchStart = haystack.startIndex
        while let range = haystack.range(of: needle, range: searchStart..<haystack.endIndex) {
            if range.upperBound == haystack.endIndex
                || isMentionBoundary(haystack[range.upperBound])
            {
                return true
            }
            searchStart = range.upperBound
        }
        return false
    }

    private static func isMentionBoundary(_ char: Character) -> Bool {
        char.unicodeScalars.allSatisfy { scalar in
            !(CharacterSet.alphanumerics.contains(scalar) || scalar == "_" || scalar == "-")
        }
    }
}
