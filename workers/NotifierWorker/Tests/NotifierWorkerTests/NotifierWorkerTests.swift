import XCTest
import Crypto
@testable import NotifierWorker

final class NotifierWorkerTests: XCTestCase {
    func testRelaySignerProducesVerifiableEd25519Signature() throws {
        let privateKey = Curve25519.Signing.PrivateKey()
        let signer = try PushRelayRequestSigner(rawSeed: privateKey.rawRepresentation)
        let body = Data("{\"schema\":\"momo.push.dispatch.v2\"}".utf8)
        let signature = try XCTUnwrap(Data(base64Encoded: signer.signatureBase64(for: body)))
        XCTAssertTrue(privateKey.publicKey.isValidSignature(signature, for: body))
    }
    /// ADR-0120 D2 build-time guard: the relay-bound dispatch payload must
    /// carry exactly the id-only routing field set — nothing that could hold
    /// conversation content (body, display name, handle, channel name,
    /// approval summary). Adding a field here requires an ADR-0120 change and
    /// a matching update to scripts/verify_push_notifier.sh assertions.
    func testDispatchPayloadIsIdOnly() throws {
        let dispatch = PushDispatch(
            serverId: "momo-test",
            workspaceId: "00000000-0000-7000-8000-000000000001",
            deviceId: "00000000-0000-7000-8000-00000000d001",
            devicePlatform: "ios",
            apnsToken: String(repeating: "ab", count: 32),
            apnsEnv: "sandbox",
            apnsTopic: "kim.dawn.momo.e2e",
            collapseId: "m:00000000-0000-7000-8000-00000000m001",
            badge: 3,
            reason: "dm",
            threadId: "00000000-0000-7000-8000-000000000201",
            category: "momo.message",
            approvalId: nil,
            channelId: "00000000-0000-7000-8000-000000000201",
            messageId: "00000000-0000-7000-8000-00000000m001"
        )
        let data = try JSONEncoder().encode(dispatch)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any])

        let allowedKeys: Set<String> = [
            "schema", "server_id", "workspace_id", "device_id",
            "device_platform", "apns_token", "apns_env", "apns_topic",
            "collapse_id", "badge", "reason", "thread_id", "category",
            "channel_id", "message_id",
        ]
        XCTAssertEqual(Set(object.keys), allowedKeys)
        XCTAssertEqual(object["schema"] as? String, "momo.push.dispatch.v2")

        // No key may even resemble a content-bearing field.
        let forbiddenFragments = ["body", "text", "name", "handle", "summary", "title"]
        for key in object.keys {
            for fragment in forbiddenFragments {
                XCTAssertFalse(
                    key.lowercased().contains(fragment),
                    "content-shaped key '\(key)' violates the id-only contract")
            }
        }
    }

    func testPayloadCategoriesPreserveJudgmentPrecedence() {
        XCTAssertEqual(
            NotifierService.category(messageType: "text", propsKind: nil, reason: "dm"),
            "momo.message")
        XCTAssertEqual(
            NotifierService.category(messageType: "text", propsKind: nil, reason: "mention"),
            "momo.mention")
        XCTAssertEqual(
            NotifierService.category(
                messageType: "approval_request", propsKind: "work_control_approval",
                reason: "approval_request"),
            "momo.approval")
        XCTAssertEqual(
            NotifierService.category(
                messageType: "system", propsKind: "work_session", reason: "dm"),
            "momo.work")
        XCTAssertEqual(
            NotifierService.category(
                messageType: "approval_request", propsKind: "resume_offer",
                reason: "resume_offer"),
            "momo.work")
    }

    /// The collapse id doubles as the 011 dedupe index key AND the APNs
    /// apns-collapse-id header, which is capped at 64 bytes. It must be
    /// deterministic per message so redelivered candidates dedupe.
    func testCollapseIDIsStableAndWithinAPNsLimit() throws {
        let messageID = try XCTUnwrap(
            UUID(uuidString: "0198f0a2-1234-7abc-8def-0123456789ab"))
        let first = NotifierService.collapseID(for: messageID)
        let second = NotifierService.collapseID(for: messageID)
        XCTAssertEqual(first, second)
        XCTAssertEqual(first, "m:0198f0a2-1234-7abc-8def-0123456789ab")
        XCTAssertLessThanOrEqual(first.utf8.count, 64)
    }
}
