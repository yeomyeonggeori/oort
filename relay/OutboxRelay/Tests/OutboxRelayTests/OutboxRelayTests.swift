import XCTest
@testable import OutboxRelay

final class OutboxRelayTests: XCTestCase {
    func testSmoke() {
        XCTAssertEqual("OutboxRelay", "OutboxRelay")
    }

    func testReadStatePersonalBroadcastRoundTripsWithoutMessageVersion() throws {
        let memberID = "00000000-0000-7000-8000-000000000101"
        let raw = """
        {
          "channel": "user:read-state#\(memberID)",
          "data": {
            "type": "read_state",
            "v": 1,
            "ts": 1783917600000,
            "payload": {
              "member_id": "\(memberID)",
              "channel_id": "00000000-0000-7000-8000-000000000202",
              "last_read_seq": 9,
              "latest_seq": 11,
              "unread_count": 2,
              "mention_count": 1
            }
          },
          "idempotency_key": "read-state-contract"
        }
        """
        let payload = try JSONDecoder().decode(BroadcastPayload.self, from: Data(raw.utf8))
        XCTAssertEqual(payload.channel, "user:read-state#\(memberID)")
        XCTAssertNil(payload.version)
        XCTAssertEqual(payload.idempotencyKey, "read-state-contract")
        guard case .object(let data) = payload.data,
              case .string(let type) = data["type"]
        else {
            return XCTFail("read-state data envelope did not round-trip")
        }
        XCTAssertEqual(type, "read_state")
    }
}
