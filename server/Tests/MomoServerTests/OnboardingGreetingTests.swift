import Foundation
import XCTest
@testable import MomoServer

/// MOMO-588 (W-O3) — pure-unit coverage for the deterministic onboarding greeting:
/// template content contract, Accept-Language selection, and the RFC 4122 v5
/// `client_msg_id` derivation that makes a re-join idempotent.
///
/// The live write-path roundtrip (join -> greeting message exists + idempotent +
/// authored by an agent + mentions the member + outbox row) needs Postgres and is
/// orchestrator-owned via `scripts/verify_onboarding_greeting.sh`.
final class OnboardingGreetingTests: XCTestCase {
    // MARK: - Template content contract

    func testKoreanBodyMeetsContentContract() {
        let body = OnboardingGreeting.body(
            newMemberHandle: "seongjae",
            agentDisplayName: "Hermes",
            language: .korean
        )
        // Mentions the new member with a parseable token, names the agent.
        XCTAssertTrue(body.contains("@seongjae"), "must mention the new member")
        XCTAssertTrue(body.contains("Hermes"), "must name the greeting agent")
        // Welcome + two concrete capabilities + call to mention the agent.
        XCTAssertTrue(body.contains("환영"), "must welcome the member")
        XCTAssertTrue(body.contains("대화 요약"), "must list capability 1")
        XCTAssertTrue(body.contains("자료 조사"), "must list capability 2")
        XCTAssertTrue(body.contains("저를 한번 멘션해보세요"), "must ask to mention the agent")
    }

    func testEnglishBodyMeetsContentContract() {
        let body = OnboardingGreeting.body(
            newMemberHandle: "seongjae",
            agentDisplayName: "Hermes",
            language: .english
        )
        XCTAssertTrue(body.contains("@seongjae"))
        XCTAssertTrue(body.contains("Hermes"))
        XCTAssertTrue(body.lowercased().contains("welcome"))
        XCTAssertTrue(body.contains("summarize a conversation"))
        XCTAssertTrue(body.contains("look things up"))
        XCTAssertTrue(body.contains("Try mentioning me now"))
    }

    func testBodyContainsNoEmDashOrEnDash() {
        for language in [OnboardingGreeting.Language.korean, .english] {
            let body = OnboardingGreeting.body(
                newMemberHandle: "seongjae",
                agentDisplayName: "Hermes",
                language: language
            )
            XCTAssertFalse(body.contains("\u{2014}"), "em dash banned in user-facing copy")
            XCTAssertFalse(body.contains("\u{2013}"), "en dash banned in user-facing copy")
        }
    }

    func testBodyContainsNoEmojiOrInternalVocabulary() {
        for language in [OnboardingGreeting.Language.korean, .english] {
            let body = OnboardingGreeting.body(
                newMemberHandle: "seongjae",
                agentDisplayName: "Hermes",
                language: language
            )
            let hasEmoji = body.unicodeScalars.contains { $0.properties.isEmojiPresentation }
            XCTAssertFalse(hasEmoji, "greeting must not use emoji")
            // Internal vocabulary must not leak into user-facing copy.
            XCTAssertFalse(body.contains("Context Packet"))
            XCTAssertFalse(body.contains("outbox"))
            XCTAssertFalse(body.contains("agent_run"))
        }
    }

    func testBodyMentionTokenIsBoundaryTerminated() {
        // The handle token must be followed by a mention boundary so the server's
        // own mention parser registers it (ReadStateMentions.containsMention).
        for language in [OnboardingGreeting.Language.korean, .english] {
            let body = OnboardingGreeting.body(
                newMemberHandle: "seongjae",
                agentDisplayName: "Hermes",
                language: language
            )
            XCTAssertTrue(
                ReadStateMentions.containsMention(
                    body,
                    handle: "seongjae",
                    displayName: "Seongjae Kwak",
                    memberID: UUID()
                ),
                "\(language) body must register a mention of the new member"
            )
        }
    }

    // MARK: - Accept-Language selection

    func testLanguageDefaultsToKorean() {
        XCTAssertEqual(OnboardingGreeting.Language.from(acceptLanguage: nil), .korean)
        XCTAssertEqual(OnboardingGreeting.Language.from(acceptLanguage: ""), .korean)
        XCTAssertEqual(OnboardingGreeting.Language.from(acceptLanguage: "ko"), .korean)
        XCTAssertEqual(OnboardingGreeting.Language.from(acceptLanguage: "ko-KR"), .korean)
        // First tag wins: Korean preferred over a lower-priority English fallback.
        XCTAssertEqual(OnboardingGreeting.Language.from(acceptLanguage: "ko,en;q=0.8"), .korean)
        // A non-English first tag falls back to the Korean default.
        XCTAssertEqual(OnboardingGreeting.Language.from(acceptLanguage: "fr-FR"), .korean)
    }

    func testLanguageSwitchesToEnglishOnExplicitPreference() {
        XCTAssertEqual(OnboardingGreeting.Language.from(acceptLanguage: "en"), .english)
        XCTAssertEqual(OnboardingGreeting.Language.from(acceptLanguage: "en-US"), .english)
        XCTAssertEqual(OnboardingGreeting.Language.from(acceptLanguage: "EN-us"), .english)
        XCTAssertEqual(OnboardingGreeting.Language.from(acceptLanguage: "en-GB,ko;q=0.5"), .english)
        XCTAssertEqual(OnboardingGreeting.Language.from(acceptLanguage: " en ; q=1.0"), .english)
    }

    // MARK: - Deterministic client_msg_id (RFC 4122 v5)

    func testClientMsgIDIsDeterministicAndMemberScoped() {
        let workspace = UUID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let memberA = UUID(uuidString: "00000000-0000-7000-8000-0000000000aa")!
        let memberB = UUID(uuidString: "00000000-0000-7000-8000-0000000000bb")!

        let first = OnboardingGreeting.clientMsgID(workspaceID: workspace, newMemberID: memberA)
        let second = OnboardingGreeting.clientMsgID(workspaceID: workspace, newMemberID: memberA)
        XCTAssertEqual(first, second, "same (workspace, member) must map to one client_msg_id")

        let other = OnboardingGreeting.clientMsgID(workspaceID: workspace, newMemberID: memberB)
        XCTAssertNotEqual(first, other, "different members must not collide")

        let otherWorkspace = UUID(uuidString: "00000000-0000-7000-8000-000000000002")!
        let crossWorkspace = OnboardingGreeting.clientMsgID(
            workspaceID: otherWorkspace, newMemberID: memberA
        )
        XCTAssertNotEqual(first, crossWorkspace, "different workspaces must not collide")
    }

    func testUUIDV5MatchesRFC4122Vector() {
        // RFC 4122 §A / widely-cited vector: uuid5(NAMESPACE_DNS, "www.example.com").
        let dnsNamespace = UUID(uuidString: "6ba7b810-9dad-11d1-80b4-00c04fd430c8")!
        let derived = OnboardingGreeting.uuidV5(namespace: dnsNamespace, name: "www.example.com")
        XCTAssertEqual(
            derived.uuidString.lowercased(),
            "2ed6657d-e927-568b-95e1-2665a8aea6a2"
        )
    }

    func testClientMsgIDHasVersion5AndRFCVariant() {
        let workspace = UUID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let member = UUID(uuidString: "00000000-0000-7000-8000-0000000000aa")!
        let id = OnboardingGreeting.clientMsgID(workspaceID: workspace, newMemberID: member)
        // Byte 6 high nibble = version 5; byte 8 top bits = 10 (RFC 4122 variant).
        XCTAssertEqual(id.uuid.6 & 0xF0, 0x50, "version nibble must be 5")
        XCTAssertEqual(id.uuid.8 & 0xC0, 0x80, "variant bits must be RFC 4122")
    }
}
