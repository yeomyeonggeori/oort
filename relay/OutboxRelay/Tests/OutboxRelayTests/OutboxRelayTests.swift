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
        XCTAssertEqual(result, .ok(204))
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
        XCTAssertEqual(redirected, .permanentFailure("HTTP 302", status: 302))

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
        XCTAssertEqual(denied, .permanentFailure("SSRF guard rejected destination", status: nil))
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

    // MARK: - 이슈 #1204 — 나간 사실만, 본문은 아니다

    /// 감사 행이 서는 조건 = **목적지가 답했는가**.
    ///
    /// 이 구별이 이 티켓의 전부다. 상태가 있다는 것은 서명된 페이로드(= 멘션
    /// 본문)가 실제로 그 호스트에 도달했다는 뜻이고, 그것이 ADR-0150 이 말하는
    /// egress 다. 상태가 없는 둘은 **나갔는지 알 수 없거나 안 나간 것**이라
    /// 감사에 적으면 거짓 기록이 된다 — 그 둘은 `outbox.last_error` 몫이다.
    func testOnlyAnAnsweredDeliveryCarriesAnAuditableStatus() {
        XCTAssertEqual(WebhookDeliveryResult.ok(204).deliveredStatus, 204)
        XCTAssertEqual(WebhookDeliveryResult.transientServerFailure(503).deliveredStatus, 503)
        XCTAssertEqual(
            WebhookDeliveryResult.permanentFailure("HTTP 410", status: 410).deliveredStatus,
            410
        )
        // 429/408 도 호스트가 답한 것이다 — 재시도 대상일 뿐 egress 는 일어났다.
        XCTAssertEqual(
            WebhookDeliveryResult.transientFailure("HTTP 429", status: 429).deliveredStatus,
            429
        )

        XCTAssertNil(
            WebhookDeliveryResult
                .permanentFailure("SSRF guard rejected destination", status: nil)
                .deliveredStatus,
            "아무것도 나가지 않았는데 전송 감사를 남기면 원장이 거짓말을 한다"
        )
        XCTAssertNil(
            WebhookDeliveryResult.transientFailure("request failed", status: nil).deliveredStatus,
            "나갔는지 알 수 없는 것을 나갔다고 적을 수는 없다"
        )
    }

    /// 감사가 이름으로 부를 수 있는 것은 **식별자**뿐이다.
    ///
    /// `event.id` 는 원본 메시지를 가리키는 참조이지 인용이 아니다. 본문은
    /// `event.data.body` 에 있고, 그 자리를 읽는 코드는 감사 경로에 없다 —
    /// 감사가 두 번째 유출 경로가 되지 않는다는 말의 실제 모습이다.
    func testDeliveryAuditNamesTheEventWithoutQuotingIt() throws {
        let messageID = "0199dddd-0000-7000-8000-000000000042"
        let secretBody = "이 문장은 감사에 실리면 안 된다"
        let raw = """
        {
          "schema": "momo.webhook_delivery.v1",
          "subscription_id": "0199cccc-0000-7000-8000-000000000001",
          "event": {
            "schema": "momo.event.v0",
            "id": "\(messageID)",
            "kind": "mention",
            "workspace_id": "00000000-0000-7000-8000-000000000001",
            "occurred_at": "2026-08-09T09:10:00Z",
            "data": { "body": "\(secretBody)", "message_id": "\(messageID)" }
          }
        }
        """
        let payload = try JSONDecoder().decode(
            WebhookDeliveryPayload.self, from: Data(raw.utf8)
        )
        XCTAssertEqual(RelayService.eventID(payload.event), UUID(uuidString: messageID))

        // 감사 함수가 받는 인자 전부(063 의 시그니처). 본문이 낄 자리가 없다는
        // 것을 여기서 세어 둔다 — 그 시그니처가 body 를 받게 되는 날 먼저 운다.
        let auditedFacts = [
            "workspace_id", "subscription_id", "event_kind", "event_id",
            "target_host", "outbox_id", "attempt", "http_status",
        ]
        XCTAssertEqual(auditedFacts.count, 8)
        XCTAssertFalse(
            auditedFacts.contains(where: { $0.contains("body") || $0.contains("payload") }),
            "감사 인자에 본문이 들어오면 감사가 두 번째 유출 경로가 된다"
        )
        XCTAssertFalse(
            auditedFacts.contains(where: { secretBody.contains($0) }),
            "본문이 감사 인자 이름을 통해서라도 새면 안 된다"
        )
    }

    /// 대상 주소는 **호스트까지**다. 경로·쿼리에는 구독자가 심어 둔 토큰이 있을
    /// 수 있고, 그것은 본문과 같은 이유로 원장에 적을 것이 아니다.
    func testAuditTargetIsTheHostNotTheWholeURL() throws {
        let url = try XCTUnwrap(
            URL(string: "https://hooks.example.com/services/T0/B1/xoxb-not-a-real-token")
        )
        XCTAssertEqual(url.host, "hooks.example.com")
        XCTAssertFalse(
            (url.host ?? "").contains("xoxb"),
            "감사에 실리는 값이 구독자의 비밀을 옮기면 안 된다"
        )
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
