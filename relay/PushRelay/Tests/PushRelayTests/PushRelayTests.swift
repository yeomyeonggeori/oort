import Crypto
import Foundation
import XCTest
@testable import PushRelay

final class PushRelayTests: XCTestCase {
    func testRegistryParsesRawEd25519PublicKey() throws {
        let key = Curve25519.Signing.PrivateKey()
        let registry = try JSONSerialization.data(withJSONObject: [
            "server-a": key.publicKey.rawRepresentation.base64EncodedString(),
        ])
        let config = try RelayConfig.load(environment: [
            "MOMO_RELAY_SERVERS": String(decoding: registry, as: UTF8.self),
            "MOMO_APNS_SENDER": "stub",
        ])
        XCTAssertEqual(config.servers.count, 1)
        XCTAssertEqual(config.rateLimitPerMinute, 60)
        XCTAssertEqual(config.port, 28195)
    }

    func testClosedDispatchAndAPNSPayloadUseOnlyStaticPlaceholderContent() throws {
        let data = Data(Self.dispatchJSON.utf8)
        let dispatch = try PushDispatch.decodeClosed(data)
        let encoded = try JSONEncoder().encode(APNSPayload(dispatch: dispatch))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["aps", "momo"])
        let aps = try XCTUnwrap(object["aps"] as? [String: Any])
        XCTAssertEqual(Set(aps.keys), ["alert", "badge", "mutable-content", "content-available"])
        let alert = try XCTUnwrap(aps["alert"] as? [String: Any])
        XCTAssertEqual(Set(alert.keys), ["title", "body"])
        XCTAssertEqual(alert["title"] as? String, "momo")
        XCTAssertEqual(alert["body"] as? String, "새 알림")
        let momo = try XCTUnwrap(object["momo"] as? [String: Any])
        XCTAssertEqual(Set(momo.keys), [
            "schema", "server_id", "workspace_id", "channel_id", "message_id", "collapse_id", "reason",
        ])
        let text = String(decoding: encoded, as: UTF8.self)
        for forbidden in ["message_body", "display_name", "handle", "channel_name", "apns_token"] {
            XCTAssertFalse(text.contains(forbidden))
        }
    }

    func testClosedDispatchRejectsExtraBodyField() throws {
        let widened = Self.dispatchJSON.dropLast() + ",\"body\":\"secret\"}"
        XCTAssertThrowsError(try PushDispatch.decodeClosed(Data(widened.utf8)))
    }

    func testSlidingWindowIsPerServer() async {
        let limiter = ServerRateLimiter(limit: 2)
        let now = Date(timeIntervalSince1970: 1_000)
        let first = await limiter.allow(serverID: "a", now: now)
        let second = await limiter.allow(serverID: "a", now: now)
        let blocked = await limiter.allow(serverID: "a", now: now)
        let otherServer = await limiter.allow(serverID: "b", now: now)
        let expired = await limiter.allow(serverID: "a", now: now.addingTimeInterval(61))
        XCTAssertTrue(first)
        XCTAssertTrue(second)
        XCTAssertFalse(blocked)
        XCTAssertTrue(otherServer)
        XCTAssertTrue(expired)
    }

    private static let dispatchJSON = """
    {"schema":"momo.push.dispatch.v1","server_id":"server-a","workspace_id":"11111111-1111-1111-1111-111111111111","device_id":"22222222-2222-2222-2222-222222222222","device_platform":"ios","apns_token":"deadbeefdeadbeef","apns_env":"sandbox","apns_topic":"com.momo.app","collapse_id":"msg-1","badge":1,"reason":"mention","channel_id":"33333333-3333-3333-3333-333333333333","message_id":"44444444-4444-4444-4444-444444444444"}
    """
}
