import Foundation
import XCTest
@testable import MomoServer

final class EventSubscriptionRoutesTests: XCTestCase {
    func testOutboundSecretUsesOpaqueReferenceAndMasterKey() {
        let reference = WebhookCrypto.randomReference()
        let first = WebhookCrypto.outboundSecret(masterKey: "master-a", secretRef: reference)
        XCTAssertTrue(first.hasPrefix("momo_evtsec_v1."))
        XCTAssertEqual(
            first,
            WebhookCrypto.outboundSecret(masterKey: "master-a", secretRef: reference)
        )
        XCTAssertNotEqual(
            first,
            WebhookCrypto.outboundSecret(masterKey: "master-b", secretRef: reference)
        )
        XCTAssertEqual(
            WebhookCrypto.outboundSecret(
                masterKey: "master-a",
                secretRef: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
            ),
            "momo_evtsec_v1.hhyEiheI7KYo-LwDA6i8aJPBdd1t_K5xCx48KcLm8eo"
        )
    }

    func testProjectionDoesNotExposeSecretReferenceOrSecret() throws {
        let dto = EventSubscriptionDTO(
            id: UUID().uuidString,
            workspaceId: UUID().uuidString,
            url: "https://hooks.example/events",
            eventKinds: ["mention"],
            enabled: true,
            deliveryFailureCount: 0,
            disabledAtMs: nil,
            disabledReason: nil,
            createdBy: UUID().uuidString,
            updatedBy: UUID().uuidString,
            createdAtMs: 1,
            updatedAtMs: 1
        )
        let json = String(decoding: try JSONEncoder().encode(dto), as: UTF8.self)
        XCTAssertFalse(json.contains("secret"))
        XCTAssertFalse(json.contains("secretRef"))
    }

    func testMigrationDefinesRLSOutboxEventsAndAutoDisableLedger() throws {
        let serverRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let sql = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Migrations/033_event_subscription.sql"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(sql.contains("ALTER TYPE outbox_kind ADD VALUE 'webhook_delivery'"))
        XCTAssertTrue(sql.contains("CREATE TABLE event_subscription"))
        XCTAssertTrue(sql.contains("ENABLE ROW LEVEL SECURITY"))
        XCTAssertTrue(sql.contains("FORCE ROW LEVEL SECURITY"))
        XCTAssertTrue(sql.contains("CREATE POLICY ws_isolation ON event_subscription"))
        XCTAssertTrue(sql.contains("'mention'"))
        XCTAssertTrue(sql.contains("'approval_request'"))
        XCTAssertTrue(sql.contains("'work.status_changed'"))
        XCTAssertTrue(sql.contains("delivery_failure_count"))
        XCTAssertFalse(sql.lowercased().contains("secret_plaintext"))
    }
}
