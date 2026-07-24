import XCTest
@testable import MomoMac

// Pure parsing coverage for the momo:// invite deep link (W-O1, MOMO-585):
// malformed links, percent-encoding, and partial parameters.
final class MomoDeepLinkParserTests: XCTestCase {
    private func parse(_ string: String) -> MomoDeepLink? {
        guard let url = URL(string: string) else {
            XCTFail("could not build URL from \(string)")
            return nil
        }
        return MomoDeepLinkParser.parseJoin(url)
    }

    func testParsesServerAndCodeFromCanonicalLink() {
        let link = parse("momo://join?server=http%3A%2F%2Fmacbook.local%3A28180&code=TEAM-7Q2X")
        XCTAssertEqual(link, MomoDeepLink(serverURLString: "http://macbook.local:28180", inviteCode: "TEAM-7Q2X"))
    }

    func testParametersAreOrderIndependent() {
        let link = parse("momo://join?code=TEAM-7Q2X&server=https%3A%2F%2Fmomo.example.com")
        XCTAssertEqual(link, MomoDeepLink(serverURLString: "https://momo.example.com", inviteCode: "TEAM-7Q2X"))
    }

    func testUnknownParametersAreIgnored() {
        let link = parse("momo://join?server=https%3A%2F%2Fmomo.example.com&code=ABC123&ref=email&utm=x")
        XCTAssertEqual(link, MomoDeepLink(serverURLString: "https://momo.example.com", inviteCode: "ABC123"))
    }

    func testSchemeAndActionAreCaseInsensitive() {
        let link = parse("MOMO://JOIN?server=https%3A%2F%2Fmomo.example.com&code=ABC123")
        XCTAssertEqual(link, MomoDeepLink(serverURLString: "https://momo.example.com", inviteCode: "ABC123"))
    }

    func testPercentEncodedServerWithPathAndQuerySurvives() {
        let link = parse("momo://join?server=https%3A%2F%2Fteam.momo.io%2Fapi%3Ftenant%3Dblue&code=X")
        XCTAssertEqual(link?.serverURLString, "https://team.momo.io/api?tenant=blue")
        XCTAssertEqual(link?.inviteCode, "X")
    }

    func testWhitespaceIsTrimmedFromValues() {
        let link = parse("momo://join?server=%20https%3A%2F%2Fmomo.example.com%20&code=%20ABC123%20")
        XCTAssertEqual(link, MomoDeepLink(serverURLString: "https://momo.example.com", inviteCode: "ABC123"))
    }

    func testDuplicateParameterKeepsFirstValue() {
        let link = parse("momo://join?code=FIRST&code=SECOND&server=https%3A%2F%2Fa.example.com")
        XCTAssertEqual(link?.inviteCode, "FIRST")
    }

    func testPlusInValueStaysLiteralNotSpace() {
        let link = parse("momo://join?server=https%3A%2F%2Fa.example.com&code=A%2BB")
        XCTAssertEqual(link?.inviteCode, "A+B")
    }

    func testServerOnlyLinkPrefillsServerWithEmptyCode() {
        let link = parse("momo://join?server=https%3A%2F%2Fmomo.example.com")
        XCTAssertEqual(link, MomoDeepLink(serverURLString: "https://momo.example.com", inviteCode: ""))
    }

    func testCodeOnlyLinkPrefillsCodeWithEmptyServer() {
        let link = parse("momo://join?code=ABC123")
        XCTAssertEqual(link, MomoDeepLink(serverURLString: "", inviteCode: "ABC123"))
    }

    func testEmptyParameterValuesReturnNil() {
        XCTAssertNil(parse("momo://join?server=&code="))
    }

    func testNoParametersReturnNil() {
        XCTAssertNil(parse("momo://join"))
    }

    func testWrongSchemeReturnsNil() {
        XCTAssertNil(parse("https://join?server=https%3A%2F%2Fa.example.com&code=ABC123"))
    }

    func testWrongActionReturnsNil() {
        XCTAssertNil(parse("momo://signin?server=https%3A%2F%2Fa.example.com&code=ABC123"))
    }

    func testEmptyActionReturnsNil() {
        XCTAssertNil(parse("momo://?server=https%3A%2F%2Fa.example.com&code=ABC123"))
    }

    // The percent-decoded server must still satisfy the form's own URL validation.
    func testParsedServerFeedsExistingBaseURLValidation() throws {
        let link = try XCTUnwrap(parse("momo://join?server=http%3A%2F%2Fmacbook.local%3A28180&code=ABC123"))
        let form = MomoServerSessionForm(baseURLString: link.serverURLString)
        let url = try form.validatedBaseURL()
        XCTAssertEqual(url.absoluteString, "http://macbook.local:28180")
    }
}

// Deep link assembly coverage (MOMO-591). The builder is the inverse of the
// parser and must match docs/onboarding-deeplink.md byte for byte.
final class MomoDeepLinkBuilderTests: XCTestCase {
    func testBuildsCanonicalJoinLink() {
        let link = MomoDeepLinkBuilder.buildJoinLink(
            serverURLString: "https://api.example.com",
            inviteCode: "TEAM-7Q2X"
        )
        XCTAssertEqual(link, "momo://join?server=https%3A%2F%2Fapi.example.com&code=TEAM-7Q2X")
    }

    func testBuildEncodesSchemeColonAndPathSlashes() {
        let link = MomoDeepLinkBuilder.buildJoinLink(
            serverURLString: "http://macbook.local:28180",
            inviteCode: "ABC123"
        )
        XCTAssertEqual(link, "momo://join?server=http%3A%2F%2Fmacbook.local%3A28180&code=ABC123")
    }

    func testBuildTrimsWhitespace() {
        let link = MomoDeepLinkBuilder.buildJoinLink(
            serverURLString: "  https://a.example.com  ",
            inviteCode: "  CODE-1  "
        )
        XCTAssertEqual(link, "momo://join?server=https%3A%2F%2Fa.example.com&code=CODE-1")
    }

    func testBuildReturnsNilWhenServerBlank() {
        XCTAssertNil(MomoDeepLinkBuilder.buildJoinLink(serverURLString: "   ", inviteCode: "CODE"))
    }

    func testBuildReturnsNilWhenCodeBlank() {
        XCTAssertNil(MomoDeepLinkBuilder.buildJoinLink(serverURLString: "https://a.example.com", inviteCode: ""))
    }

    // The generated link must parse back to the same server and code so the two
    // MOMO-584/585 halves of the contract stay in lockstep.
    func testBuiltLinkRoundTripsThroughParser() throws {
        let string = try XCTUnwrap(MomoDeepLinkBuilder.buildJoinLink(
            serverURLString: "https://team.momo.io/api",
            inviteCode: "aB3-_xyz"
        ))
        let url = try XCTUnwrap(URL(string: string))
        let parsed = try XCTUnwrap(MomoDeepLinkParser.parseJoin(url))
        XCTAssertEqual(parsed, MomoDeepLink(serverURLString: "https://team.momo.io/api", inviteCode: "aB3-_xyz"))
    }
}

@MainActor
final class MomoDeepLinkRoutingTests: XCTestCase {
    private func makeController() -> MomoServerSessionController {
        // Non-development store so defaults stay empty and no keychain is touched.
        let suite = "momo.deeplink.routing.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let store = MomoServerSessionStore(
            defaults: defaults,
            keychain: MomoKeychainPasswordStore(service: "momo.test.\(suite)"),
            bundleIdentifier: "app.momo.host"
        )
        return MomoServerSessionController(store: store)
    }

    func testIncomingJoinLinkPrefillsFormAndSelectsJoinPath() {
        let controller = makeController()

        controller.handleIncomingURL(
            URL(string: "momo://join?server=http%3A%2F%2Fmacbook.local%3A28180&code=TEAM-7Q2X")!
        )

        XCTAssertEqual(controller.form.baseURLString, "http://macbook.local:28180")
        XCTAssertEqual(controller.form.inviteCode, "TEAM-7Q2X")
        XCTAssertEqual(controller.onboardingPath, .join)
        XCTAssertEqual(controller.deepLinkPrefillIntent?.path, .join)
    }

    func testRepeatedLinksProduceDistinctPrefillTokens() {
        let controller = makeController()

        controller.handleIncomingURL(URL(string: "momo://join?server=https%3A%2F%2Fa.example.com&code=A")!)
        let firstToken = controller.deepLinkPrefillIntent?.token
        controller.consumeDeepLinkPrefillIntent()
        controller.handleIncomingURL(URL(string: "momo://join?server=https%3A%2F%2Fb.example.com&code=B")!)
        let secondToken = controller.deepLinkPrefillIntent?.token

        XCTAssertNotNil(firstToken)
        XCTAssertNotNil(secondToken)
        XCTAssertNotEqual(firstToken, secondToken)
        XCTAssertEqual(controller.form.baseURLString, "https://b.example.com")
        XCTAssertEqual(controller.form.inviteCode, "B")
    }

    func testConsumingPrefillIntentClearsIt() {
        let controller = makeController()
        controller.handleIncomingURL(URL(string: "momo://join?server=https%3A%2F%2Fa.example.com&code=A")!)

        controller.consumeDeepLinkPrefillIntent()

        XCTAssertNil(controller.deepLinkPrefillIntent)
    }

    func testNonMomoURLIsIgnored() {
        let controller = makeController()

        controller.handleIncomingURL(URL(string: "https://example.com/welcome")!)

        XCTAssertTrue(controller.form.baseURLString.isEmpty)
        XCTAssertTrue(controller.form.inviteCode.isEmpty)
        XCTAssertNil(controller.onboardingPath)
        XCTAssertNil(controller.deepLinkPrefillIntent)
    }

    func testCodeOnlyLinkKeepsExistingServerAndFillsCode() {
        let controller = makeController()
        controller.form.baseURLString = "https://kept.example.com"

        controller.handleIncomingURL(URL(string: "momo://join?code=ONLYCODE")!)

        XCTAssertEqual(controller.form.baseURLString, "https://kept.example.com")
        XCTAssertEqual(controller.form.inviteCode, "ONLYCODE")
        XCTAssertEqual(controller.onboardingPath, .join)
    }
}
