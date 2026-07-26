import Foundation
import MomoCore
import MomoiOSKit
import Testing

/// Opt-in live boundary for `scripts/verify_ios_wire.sh`.
///
/// Normal SwiftPM unit runs intentionally have no server credentials, so this
/// test returns without network activity unless the verifier supplies its
/// disposable fixture environment. The verifier creates that fixture itself;
/// this test never discovers or guesses an existing account.
@Suite("MomoiOS message live wire")
struct IOSMessageLiveWireTests {
    @Test("a MomoiOSKit message send survives the closed-world server decoder")
    func sendHistoryAndIdempotency() async throws {
        guard let configuration = IOSMessageLiveWireConfiguration.fromEnvironment() else {
            return
        }

        // This is deliberately the public iOS login path, not a hand-written
        // auth request. The subsequent send therefore reaches the server as
        // bytes encoded by IOSSendMessageRequest.
        let authenticated = try await MomoServerSessionClient().authenticate(
            form: SessionForm(
                serverURL: configuration.baseURL.absoluteString,
                email: configuration.email,
                password: configuration.password
            )
        )
        let client = MomoServerConversationClient(authenticated: authenticated)
        let clientMsgID = UUID()
        let draft = DraftMessage(
            channelId: configuration.channelID,
            body: "MOMO-631 iOS live wire \(clientMsgID.uuidString)"
        )

        let first = try await client.send(draft, clientMsgId: clientMsgID)
        let firstSequence = try #require(first.seq)
        #expect(first.clientMsgId == clientMsgID)

        // History is the server's persisted projection, so it proves the
        // client_msg_id was accepted by the write path rather than merely
        // copied onto the optimistic return value by the client.
        let firstHistory = try await client.history(
            channel: configuration.channelID,
            after: max(0, firstSequence - 1),
            limit: 20
        )
        let persisted = try #require(firstHistory.first { $0.clientMsgId == clientMsgID })
        #expect(persisted.seq == firstSequence)

        let replay = try await client.send(draft, clientMsgId: clientMsgID)
        #expect(replay.id == first.id)
        #expect(replay.seq == firstSequence)

        let replayHistory = try await client.history(
            channel: configuration.channelID,
            after: max(0, firstSequence - 1),
            limit: 20
        )
        #expect(replayHistory.filter { $0.clientMsgId == clientMsgID }.count == 1)
    }
}

private struct IOSMessageLiveWireConfiguration {
    let baseURL: URL
    let email: String
    let password: String
    let channelID: ChannelID

    static func fromEnvironment(
        _ environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> Self? {
        guard let rawBaseURL = nonEmpty(environment["MOMO_IOS_WIRE_BASE_URL"]),
              let baseURL = URL(string: rawBaseURL),
              let email = nonEmpty(environment["MOMO_IOS_WIRE_EMAIL"]),
              let password = nonEmpty(environment["MOMO_IOS_WIRE_PASSWORD"]),
              let rawChannelID = nonEmpty(environment["MOMO_IOS_WIRE_CHANNEL_ID"]),
              let channelID = ChannelID(uuidString: rawChannelID)
        else {
            return nil
        }
        return Self(baseURL: baseURL, email: email, password: password, channelID: channelID)
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }
}
