import Crypto
import Foundation
import XCTest
@testable import PushRelay

final class PushRelayTests: XCTestCase {
    func testRegistryParsesRawEd25519PublicKey() throws {
        let config = try RelayConfig.load(environment: Self.stubEnvironment())
        XCTAssertEqual(config.servers.count, 1)
        XCTAssertEqual(config.rateLimitPerMinute, 60)
        XCTAssertEqual(config.port, 28195)
        XCTAssertEqual(config.host, "127.0.0.1")
    }

    /// The relay's worst failure is not a crash — it is a process that boots,
    /// answers 200, and sends nothing. The stub sender is exactly that shape:
    /// it fabricates an apns-id, the notifier settles the candidate as
    /// delivered, and no device ever rings. Reaching it must take an explicit
    /// second variable, the same way the notifier gates unsigned dispatch
    /// behind MOMO_PUSH_RELAY_ALLOW_UNSIGNED.
    ///
    /// Delete the MOMO_APNS_ALLOW_STUB guard in Config.swift and this goes red.
    func testStubSenderWithoutExplicitOptInRefusesToBoot() throws {
        var environment = Self.stubEnvironment()
        environment["MOMO_APNS_ALLOW_STUB"] = nil
        XCTAssertThrowsError(try RelayConfig.load(environment: environment)) { error in
            guard case ConfigError.stubSenderNotAllowed = error else {
                return XCTFail("expected a stub-sender refusal, got \(error)")
            }
            // The message has to tell the operator which variable to set.
            XCTAssertTrue(String(describing: error).contains("MOMO_APNS_ALLOW_STUB"))
        }

        // "0", "true", and "" are not the opt-in. Only "1" is.
        for rejected in ["0", "true", "yes", ""] {
            environment["MOMO_APNS_ALLOW_STUB"] = rejected
            XCTAssertThrowsError(
                try RelayConfig.load(environment: environment),
                "MOMO_APNS_ALLOW_STUB=\(rejected) must not enable the stub")
        }
    }

    /// Live mode is the default, and it demands the whole credential set. A
    /// relay that cannot reach Apple must never be the thing that starts.
    func testLiveModeRefusesToBootWithoutTheFullAPNsCredential() throws {
        var environment = Self.stubEnvironment()
        environment["MOMO_APNS_SENDER"] = nil
        environment["MOMO_APNS_ALLOW_STUB"] = nil

        // No MOMO_APNS_ENV at all.
        XCTAssertThrowsError(try RelayConfig.load(environment: environment, isReadableFile: { _ in true }))

        environment["MOMO_APNS_ENV"] = "sandbox"
        for omitted in ["MOMO_APNS_KEY_PATH", "MOMO_APNS_KEY_ID", "MOMO_APNS_TEAM_ID"] {
            var incomplete = environment
            incomplete["MOMO_APNS_KEY_PATH"] = "/run/secrets/apns.p8"
            incomplete["MOMO_APNS_KEY_ID"] = "ABCD123456"
            incomplete["MOMO_APNS_TEAM_ID"] = "TEAM123456"
            incomplete[omitted] = nil
            XCTAssertThrowsError(
                try RelayConfig.load(environment: incomplete, isReadableFile: { _ in true }),
                "live mode must not boot without \(omitted)")
        }
    }

    /// A `.p8` the process cannot open is the same non-delivery as no `.p8`,
    /// and it is the likeliest deployment mistake: a wrong mount path, or a key
    /// the non-root container user cannot read.
    func testLiveModeRefusesToBootWhenTheAPNsKeyIsUnreadable() throws {
        var environment = Self.stubEnvironment()
        environment["MOMO_APNS_SENDER"] = "live"
        environment["MOMO_APNS_ALLOW_STUB"] = nil
        environment["MOMO_APNS_ENV"] = "sandbox"
        environment["MOMO_APNS_KEY_PATH"] = "/run/secrets/apns.p8"
        environment["MOMO_APNS_KEY_ID"] = "ABCD123456"
        environment["MOMO_APNS_TEAM_ID"] = "TEAM123456"

        XCTAssertThrowsError(
            try RelayConfig.load(environment: environment, isReadableFile: { _ in false })
        ) { error in
            guard case ConfigError.unreadableAPNSKey(let path) = error else {
                return XCTFail("expected an unreadable-key refusal, got \(error)")
            }
            XCTAssertEqual(path, "/run/secrets/apns.p8")
            XCTAssertTrue(String(describing: error).contains("MOMO_APNS_KEY_PATH"))
        }

        let config = try RelayConfig.load(environment: environment, isReadableFile: { _ in true })
        XCTAssertEqual(config.senderMode, .live)
        XCTAssertEqual(config.apnsEnvironment, .sandbox)
        XCTAssertEqual(config.apnsKeyPath, "/run/secrets/apns.p8")
    }

    /// The stub opt-in is not a bypass of anything else: an empty or malformed
    /// server registry is still a refusal.
    func testAnEmptyServerRegistryRefusesToBoot() throws {
        var environment = Self.stubEnvironment()
        environment["MOMO_RELAY_SERVERS"] = nil
        XCTAssertThrowsError(try RelayConfig.load(environment: environment))

        environment["MOMO_RELAY_SERVERS"] = "{}"
        XCTAssertThrowsError(try RelayConfig.load(environment: environment))

        environment["MOMO_RELAY_SERVERS"] = #"{"server-a":"not-base64"}"#
        XCTAssertThrowsError(try RelayConfig.load(environment: environment))
    }

    private static func stubEnvironment() -> [String: String] {
        let key = Curve25519.Signing.PrivateKey()
        let registry = #"{"server-a":"\#(key.publicKey.rawRepresentation.base64EncodedString())"}"#
        return [
            "MOMO_RELAY_SERVERS": registry,
            "MOMO_APNS_SENDER": "stub",
            "MOMO_APNS_ALLOW_STUB": "1",
        ]
    }

    func testClosedDispatchAndAPNSPayloadUseOnlyStaticPlaceholderContent() throws {
        let data = Data(Self.dispatchJSON.utf8)
        let dispatch = try PushDispatch.decodeClosed(data)
        let encoded = try JSONEncoder().encode(APNSPayload(dispatch: dispatch))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["aps", "momo"])
        let aps = try XCTUnwrap(object["aps"] as? [String: Any])
        XCTAssertEqual(Set(aps.keys), [
            "alert", "badge", "thread-id", "category", "mutable-content", "content-available",
        ])
        XCTAssertEqual(aps["thread-id"] as? String, "33333333-3333-3333-3333-333333333333")
        XCTAssertEqual(aps["category"] as? String, "momo.mention")
        let alert = try XCTUnwrap(aps["alert"] as? [String: Any])
        XCTAssertEqual(Set(alert.keys), ["title", "body"])
        XCTAssertEqual(alert["title"] as? String, "momo")
        XCTAssertEqual(alert["body"] as? String, "새 알림")
        let momo = try XCTUnwrap(object["momo"] as? [String: Any])
        XCTAssertEqual(Set(momo.keys), [
            "schema", "server_id", "workspace_id", "channel_id", "message_id",
            "collapse_id", "reason",
        ])
        XCTAssertEqual(momo["schema"] as? String, "momo.push.notification.v2")
        XCTAssertNil(momo["approval_id"])
        let text = String(decoding: encoded, as: UTF8.self)
        for forbidden in ["message_body", "display_name", "handle", "channel_name", "apns_token"] {
            XCTAssertFalse(text.contains(forbidden))
        }
    }

    func testClosedDispatchRejectsExtraBodyField() throws {
        let widened = Self.dispatchJSON.dropLast() + ",\"body\":\"secret\"}"
        XCTAssertThrowsError(try PushDispatch.decodeClosed(Data(widened.utf8)))
    }

    func testApprovalPayloadCarriesApprovalIDOnlyForApprovalCategory() throws {
        let approvalID = "55555555-5555-5555-5555-555555555555"
        let json = Self.dispatchJSON
            .replacingOccurrences(of: "\"category\":\"momo.mention\"", with: "\"category\":\"momo.approval\"")
            .replacingOccurrences(of: "\"channel_id\"", with: "\"approval_id\":\"\(approvalID)\",\"channel_id\"")
        let dispatch = try PushDispatch.decodeClosed(Data(json.utf8))
        let encoded = try JSONEncoder().encode(APNSPayload(dispatch: dispatch))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        let momo = try XCTUnwrap(object["momo"] as? [String: Any])
        XCTAssertEqual(momo["approval_id"] as? String, approvalID)

        let invalid = Self.dispatchJSON.replacingOccurrences(
            of: "\"channel_id\"", with: "\"approval_id\":\"\(approvalID)\",\"channel_id\"")
        XCTAssertThrowsError(try PushDispatch.decodeClosed(Data(invalid.utf8)))
    }

    func testResumeOfferIsAnAllowedWorkDispatch() throws {
        let json = Self.dispatchJSON
            .replacingOccurrences(of: "\"reason\":\"mention\"", with: "\"reason\":\"resume_offer\"")
            .replacingOccurrences(of: "\"category\":\"momo.mention\"", with: "\"category\":\"momo.work\"")
        XCTAssertNoThrow(try PushDispatch.decodeClosed(Data(json.utf8)))
    }

    /// Pins the divergence recorded in **ADR-0120 부록 A (미결)**.
    ///
    /// Judgment can label a dispatch `work_session_idle`
    /// (`server-rust/crates/momo-push/src/judgment.rs`, and the Swift
    /// `NotifierService.swift` arm it was ported from), but this validator takes
    /// only the other four reasons. Such a dispatch is answered a bare 400
    /// (`App.swift`), classified as a **permanent** failure
    /// (`momo-notifier/src/push_relay.rs`), settled into `push_dispatch_log`
    /// and never retried — the notification is silently lost.
    ///
    /// The category here is `momo.work`, which this validator **does** accept,
    /// so the rejection is attributable to the reason guard alone. That matters:
    /// the change under consideration is about the reason vocabulary only.
    ///
    /// This asserts today's behaviour, not the desired one. Widening the
    /// vocabulary is an ADR-0120 wire change and must turn this red together
    /// with `momo-push`'s
    /// `dispatch::tests::work_session_idle_is_not_deliverable_through_the_relay`
    /// and `scripts/tests/test_push_relay_vocabulary_contract.py`.
    func testWorkSessionIdleIsRejectedEvenThoughItsCategoryIsAllowed() throws {
        let json = Self.dispatchJSON
            .replacingOccurrences(
                of: "\"reason\":\"mention\"", with: "\"reason\":\"work_session_idle\"")
            .replacingOccurrences(of: "\"category\":\"momo.mention\"", with: "\"category\":\"momo.work\"")
        XCTAssertThrowsError(try PushDispatch.decodeClosed(Data(json.utf8))) { error in
            guard case DispatchValidationError.reason = error else {
                XCTFail("expected DispatchValidationError.reason, got \(error)")
                return
            }
        }
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
    {"schema":"momo.push.dispatch.v2","server_id":"server-a","workspace_id":"11111111-1111-1111-1111-111111111111","device_id":"22222222-2222-2222-2222-222222222222","device_platform":"ios","apns_token":"deadbeefdeadbeef","apns_env":"sandbox","apns_topic":"com.momo.app","collapse_id":"msg-1","badge":1,"reason":"mention","thread_id":"33333333-3333-3333-3333-333333333333","category":"momo.mention","channel_id":"33333333-3333-3333-3333-333333333333","message_id":"44444444-4444-4444-4444-444444444444"}
    """
}
