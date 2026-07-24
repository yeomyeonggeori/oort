@preconcurrency import Crypto
import Foundation
import Logging
import PostgresNIO

/// MOMO-588 (W-O3): the workspace agent greets a newly joined member through the
/// canonical write path — `channel_seq` bump + `message` INSERT + `outbox` INSERT
/// in one transaction — never a fabricated client message (봇 래핑 금지 철학).
///
/// The greeting is a deterministic template (no LLM call), idempotent per
/// (workspace, member), and it silently skips when the workspace has no active
/// agent or no public channel. Any failure is swallowed so a greeting problem can
/// never break the join (수용기준: 인사 실패가 join을 깨면 안 됨).
enum OnboardingGreeting {
    /// Fixed namespace for the deterministic greeting `client_msg_id` (RFC 4122 v5).
    /// Bytes spell "momo" + a v5-shaped layout ending in ticket 0x0588.
    private static let namespace = UUID(uuid: (
        0x6d, 0x6f, 0x6d, 0x6f, 0x00, 0x00, 0x50, 0x00,
        0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0x88
    ))

    /// Server-owned props marker recorded on the greeting message. Doubles as a
    /// human-readable idempotency fingerprint the verifier can query.
    static let marker = "onboarding_greeting"
    static let markerVersion = "v1"

    enum Language: Sendable, Equatable {
        case korean
        case english

        /// Pick a language from an `Accept-Language` header. Korean is the product
        /// default; only an explicit English preference switches away from it.
        static func from(acceptLanguage: String?) -> Language {
            guard let raw = acceptLanguage?.lowercased() else { return .korean }
            let firstTag = raw.split(separator: ",").first.map(String.init) ?? raw
            let base = firstTag.split(separator: ";").first.map(String.init) ?? firstTag
            let trimmed = base.trimmingCharacters(in: .whitespaces)
            if trimmed == "en" || trimmed.hasPrefix("en-") { return .english }
            return .korean
        }
    }

    /// Deterministic greeting body. Mentions the new member (`@handle`), names the
    /// agent, lists two concrete capabilities, and ends with a call to mention the
    /// agent. No em dash, no hype, no internal vocabulary, no emoji.
    static func body(
        newMemberHandle: String,
        agentDisplayName: String,
        language: Language
    ) -> String {
        switch language {
        case .korean:
            return "@\(newMemberHandle) 님, 환영해요. 저는 \(agentDisplayName), 이 팀의 에이전트예요. "
                + "채널에서 저를 멘션하면 대화 요약이나 자료 조사를 맡길 수 있어요. 지금 저를 한번 멘션해보세요."
        case .english:
            return "Hi @\(newMemberHandle), welcome. I am \(agentDisplayName), this team's agent. "
                + "Mention me in a channel and I can summarize a conversation or look things up for you. "
                + "Try mentioning me now."
        }
    }

    /// RFC 4122 v5 (SHA-1) UUID derived from (workspace, member): a stable
    /// `client_msg_id` so a re-join dedupes on `message_client_idem_uniq`.
    static func clientMsgID(workspaceID: UUID, newMemberID: UUID) -> UUID {
        let name = "momo.onboarding.greeting:"
            + "\(workspaceID.uuidString.lowercased()):\(newMemberID.uuidString.lowercased())"
        return uuidV5(namespace: namespace, name: name)
    }

    static func uuidV5(namespace: UUID, name: String) -> UUID {
        var input = [UInt8]()
        withUnsafeBytes(of: namespace.uuid) { input.append(contentsOf: $0) }
        input.append(contentsOf: Array(name.utf8))
        var digest = Array(Insecure.SHA1.hash(data: Data(input)).prefix(16))
        digest[6] = (digest[6] & 0x0F) | 0x50 // version 5
        digest[8] = (digest[8] & 0x3F) | 0x80 // RFC 4122 variant
        return UUID(uuid: (
            digest[0], digest[1], digest[2], digest[3],
            digest[4], digest[5], digest[6], digest[7],
            digest[8], digest[9], digest[10], digest[11],
            digest[12], digest[13], digest[14], digest[15]
        ))
    }

    /// Post the greeting. Never throws: on any error, or when the workspace lacks
    /// an active agent or a public channel, it logs and returns so the join stays
    /// successful.
    static func post(
        db: Database,
        logger: Logger,
        workspaceID: UUID,
        newMember: MemberDTO,
        language: Language
    ) async {
        guard let newMemberID = UUID(uuidString: newMember.id) else { return }
        do {
            try await db.withTenantTransaction(workspaceID: workspaceID) { conn in
                // 1) Target channel: #general first, else the oldest public channel.
                guard let channelID = try await targetChannel(
                    conn: conn, logger: logger, workspaceID: workspaceID
                ) else { return }
                // 2) Greeting author: handle-sorted first active agent member.
                guard let agent = try await greetingAgent(
                    conn: conn, logger: logger, workspaceID: workspaceID
                ) else { return }

                let clientMessageID = clientMsgID(
                    workspaceID: workspaceID, newMemberID: newMemberID
                )
                let messageBody = body(
                    newMemberHandle: newMember.handle,
                    agentDisplayName: agent.displayName,
                    language: language
                )
                let hlcTs = Int64(Date().timeIntervalSince1970 * 1000)
                let props = "{\"\(marker)\":\"\(markerVersion)\"}"

                // 3) Canonical write path: seq bump + idempotent message INSERT.
                //    NOT EXISTS guards a prior greeting authored by a different
                //    agent (author changed between joins); ON CONFLICT guards the
                //    same-author retry. Either way no seq is minted on a skip.
                let insertRows = try await conn.query(
                    """
                    WITH bumped AS (
                      UPDATE channel_seq
                         SET last_seq = last_seq + 1
                       WHERE channel_id = \(channelID)
                         AND workspace_id = \(workspaceID)
                         AND NOT EXISTS (
                           SELECT 1 FROM message
                            WHERE channel_id = \(channelID)
                              AND client_msg_id = \(clientMessageID)
                         )
                      RETURNING last_seq AS seq
                    )
                    INSERT INTO message
                      (workspace_id, channel_id, seq, hlc_ts, hlc_count,
                       author_member_id, type, body, props, client_msg_id)
                    SELECT \(workspaceID), \(channelID), b.seq, \(hlcTs), 0,
                           \(agent.memberID), 'text'::message_type, \(messageBody),
                           \(props)::jsonb, \(clientMessageID)
                      FROM bumped b
                    ON CONFLICT (channel_id, author_member_id, client_msg_id) DO NOTHING
                    RETURNING id, seq
                    """,
                    logger: logger
                ).collect()
                // No row -> already greeted (idempotent) or channel not provisioned.
                guard let row = insertRows.first else { return }
                let (messageID, seq) = try row.decode((UUID, Int64).self)

                // 4) Mention bookkeeping mirrors MessageRoutes.send so the new
                //    member gets a mention badge and props.mention_member_ids.
                let mentionIDs = try await ReadStateMentions.record(
                    conn: conn, logger: logger,
                    workspaceID: workspaceID, channelID: channelID,
                    messageID: messageID, messageSeq: seq,
                    authorMemberID: agent.memberID, body: messageBody
                )

                // 5) Outbox INSERT in the SAME tx (transactional outbox invariant):
                //    OutboxRelay publishes the message.new frame to Centrifugo.
                var broadcastProps: [String: Any] = [marker: markerVersion]
                if !mentionIDs.isEmpty {
                    broadcastProps["mention_member_ids"] = mentionIDs.map(\.uuidString)
                }
                let centChannel = "ch:ws\(workspaceID.uuidString).\(channelID.uuidString)"
                let payload = MessageRoutes.broadcastPayload(
                    centChannel: centChannel, messageID: messageID, channelID: channelID,
                    seq: seq, type: "text", body: messageBody,
                    authorMemberID: agent.memberID, hlcTs: hlcTs, hlcCount: 0,
                    rootID: nil, props: broadcastProps
                )
                _ = try await conn.query(
                    """
                    INSERT INTO outbox
                      (workspace_id, kind, method, payload, partition_key)
                    VALUES
                      (\(workspaceID), 'broadcast', 'publish', \(payload)::jsonb, \(channelID))
                    """,
                    logger: logger
                )
            }
        } catch {
            // Greeting is best-effort; a failure must never fail the join.
            logger.warning("onboarding greeting skipped", metadata: [
                "workspace_id": .string(workspaceID.uuidString),
                "member_id": .string(newMemberID.uuidString),
                "error": .string("\(error)"),
            ])
        }
    }

    private struct GreetingAgent {
        let memberID: UUID
        let handle: String
        let displayName: String
    }

    /// #general first (case-insensitive), then the oldest public non-archived
    /// channel — a deterministic default target.
    private static func targetChannel(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID
    ) async throws -> UUID? {
        let rows = try await conn.query(
            """
            SELECT id
              FROM channel
             WHERE workspace_id = \(workspaceID)
               AND kind = 'public'
               AND archived_at IS NULL
               AND name IS NOT NULL
             ORDER BY (lower(name) = 'general') DESC, created_at ASC, id ASC
             LIMIT 1
            """,
            logger: logger
        ).collect()
        return try rows.first?.decode(UUID.self)
    }

    /// The deterministic greeting author: the workspace's active agent member with
    /// the alphabetically first handle.
    private static func greetingAgent(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID
    ) async throws -> GreetingAgent? {
        let rows = try await conn.query(
            """
            SELECT m.id, m.handle, m.display_name
              FROM member m
              JOIN agent a ON a.member_id = m.id
             WHERE m.workspace_id = \(workspaceID)
               AND m.kind = 'agent'
               AND m.status = 'active'
               AND m.deleted_at IS NULL
             ORDER BY m.handle ASC, m.id ASC
             LIMIT 1
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else { return nil }
        let (id, handle, displayName) = try row.decode((UUID, String, String).self)
        return GreetingAgent(memberID: id, handle: handle, displayName: displayName)
    }
}
