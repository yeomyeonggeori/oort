import XCTest
import Foundation
import OutboundHTTPPolicy
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

    func testWebhookSignatureCoversTimestampAndExactBody() {
        let body = Data(#"{"kind":"mention"}"#.utf8)
        let signature = TestWebhookClient.signature(
            secret: "secret", timestamp: "1784700000", body: body
        )
        XCTAssertEqual(
            signature,
            "f3d6dab1d01614782badc9192a12f5b6f954905d18602f5065c20df16bd4044c"
        )
        XCTAssertNotEqual(
            signature,
            TestWebhookClient.signature(
                secret: "secret", timestamp: "1784700001", body: body
            )
        )
        XCTAssertNotEqual(
            signature,
            TestWebhookClient.signature(
                secret: "secret", timestamp: "1784700000", body: Data("{}".utf8)
            )
        )
    }

    func testWebhookDerivedSecretMatchesServerContractVector() {
        XCTAssertEqual(
            TestWebhookClient.derivedSecret(
                masterKey: "master-a",
                secretRef: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
            ),
            "momo_evtsec_v1.hhyEiheI7KYo-LwDA6i8aJPBdd1t_K5xCx48KcLm8eo"
        )
    }

    func testWebhookDeliveryPinsValidatedAddressAndSignsRequest() async throws {
        let transport = RecordingWebhookTransport(status: 204)
        let client = TestWebhookClient(
            resolver: WebhookStubResolver(addresses: ["93.184.216.34"]),
            transport: transport,
            allowDevelopmentHTTP: false
        )
        let body = Data(#"{"kind":"mention"}"#.utf8)
        let result = await client.deliver(
            url: URL(string: "https://hooks.example/events")!,
            deliveryID: "42",
            eventKind: "mention",
            secret: "test-secret",
            body: body
        )
        XCTAssertEqual(result, .ok)
        let recordedRequest = await transport.lastRequest()
        let request = try XCTUnwrap(recordedRequest)
        XCTAssertEqual(request.resolvedAddress, "93.184.216.34")
        XCTAssertEqual(request.body, body)
        let headers = Dictionary(uniqueKeysWithValues: request.headers)
        XCTAssertEqual(headers["X-Momo-Delivery"], "42")
        XCTAssertEqual(headers["X-Momo-Event"], "mention")
        let timestamp = try XCTUnwrap(headers["X-Momo-Timestamp"])
        XCTAssertEqual(
            headers["X-Momo-Signature"],
            "v1=\(TestWebhookClient.signature(secret: "test-secret", timestamp: timestamp, body: body))"
        )
    }

    func testWebhookRedirectAndPrivateDestinationFailClosed() async throws {
        let redirectTransport = RecordingWebhookTransport(status: 302)
        let publicClient = TestWebhookClient(
            resolver: WebhookStubResolver(addresses: ["93.184.216.34"]),
            transport: redirectTransport,
            allowDevelopmentHTTP: false
        )
        let redirected = await publicClient.deliver(
            url: URL(string: "https://hooks.example/events")!,
            deliveryID: "1", eventKind: "mention", secret: "secret", body: Data("{}".utf8)
        )
        XCTAssertEqual(redirected, .permanentFailure("HTTP 302"))

        let privateTransport = RecordingWebhookTransport(status: 200)
        let privateClient = TestWebhookClient(
            resolver: WebhookStubResolver(addresses: ["127.0.0.1"]),
            transport: privateTransport,
            allowDevelopmentHTTP: true
        )
        let denied = await privateClient.deliver(
            url: URL(string: "http://hooks.example/events")!,
            deliveryID: "2", eventKind: "mention", secret: "secret", body: Data("{}".utf8)
        )
        XCTAssertEqual(denied, .permanentFailure("SSRF guard rejected destination"))
        let privateRequest = await privateTransport.lastRequest()
        XCTAssertNil(privateRequest)
    }

    func testWebhook5xxIsClassifiedForAccumulatedDisable() async {
        let client = TestWebhookClient(
            resolver: WebhookStubResolver(addresses: ["93.184.216.34"]),
            transport: RecordingWebhookTransport(status: 503),
            allowDevelopmentHTTP: false
        )
        let result = await client.deliver(
            url: URL(string: "https://hooks.example/events")!,
            deliveryID: "9", eventKind: "work.status_changed",
            secret: "secret", body: Data("{}".utf8)
        )
        XCTAssertEqual(result, .transientServerFailure(503))
    }
}

private typealias TestWebhookClient = SafeWebhookDeliveryClient<
    WebhookStubResolver, RecordingWebhookTransport
>

private struct WebhookStubResolver: OutboundHostResolving {
    let addresses: [String]
    func resolve(host: String) async throws -> [String] { addresses }
}

private actor RecordingWebhookTransport: WebhookHTTPTransport {
    let status: Int
    private var request: WebhookHTTPRequest?

    init(status: Int) { self.status = status }

    func post(_ request: WebhookHTTPRequest) async throws -> Int {
        self.request = request
        return status
    }

    func lastRequest() -> WebhookHTTPRequest? { request }
}
