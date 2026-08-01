import XCTest
@testable import MomoMac

// Pure parsing coverage for the oort:// invite deep link (W-O1, MOMO-585;
// scheme renamed from momo:// in goal B13, which the old-scheme test below pins):
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
        let link = parse("oort://join?server=http%3A%2F%2Fmacbook.local%3A28180&code=TEAM-7Q2X")
        XCTAssertEqual(link, MomoDeepLink(serverURLString: "http://macbook.local:28180", inviteCode: "TEAM-7Q2X"))
    }

    func testParametersAreOrderIndependent() {
        let link = parse("oort://join?code=TEAM-7Q2X&server=https%3A%2F%2Fmomo.example.com")
        XCTAssertEqual(link, MomoDeepLink(serverURLString: "https://momo.example.com", inviteCode: "TEAM-7Q2X"))
    }

    func testUnknownParametersAreIgnored() {
        let link = parse("oort://join?server=https%3A%2F%2Fmomo.example.com&code=ABC123&ref=email&utm=x")
        XCTAssertEqual(link, MomoDeepLink(serverURLString: "https://momo.example.com", inviteCode: "ABC123"))
    }

    func testSchemeAndActionAreCaseInsensitive() {
        let link = parse("MOMO://JOIN?server=https%3A%2F%2Fmomo.example.com&code=ABC123")
        XCTAssertEqual(link, MomoDeepLink(serverURLString: "https://momo.example.com", inviteCode: "ABC123"))
    }

    func testPercentEncodedServerWithPathAndQuerySurvives() {
        let link = parse("oort://join?server=https%3A%2F%2Fteam.momo.io%2Fapi%3Ftenant%3Dblue&code=X")
        XCTAssertEqual(link?.serverURLString, "https://team.momo.io/api?tenant=blue")
        XCTAssertEqual(link?.inviteCode, "X")
    }

    func testWhitespaceIsTrimmedFromValues() {
        let link = parse("oort://join?server=%20https%3A%2F%2Fmomo.example.com%20&code=%20ABC123%20")
        XCTAssertEqual(link, MomoDeepLink(serverURLString: "https://momo.example.com", inviteCode: "ABC123"))
    }

    func testDuplicateParameterKeepsFirstValue() {
        let link = parse("oort://join?code=FIRST&code=SECOND&server=https%3A%2F%2Fa.example.com")
        XCTAssertEqual(link?.inviteCode, "FIRST")
    }

    func testPlusInValueStaysLiteralNotSpace() {
        let link = parse("oort://join?server=https%3A%2F%2Fa.example.com&code=A%2BB")
        XCTAssertEqual(link?.inviteCode, "A+B")
    }

    func testServerOnlyLinkPrefillsServerWithEmptyCode() {
        let link = parse("oort://join?server=https%3A%2F%2Fmomo.example.com")
        XCTAssertEqual(link, MomoDeepLink(serverURLString: "https://momo.example.com", inviteCode: ""))
    }

    func testCodeOnlyLinkPrefillsCodeWithEmptyServer() {
        let link = parse("oort://join?code=ABC123")
        XCTAssertEqual(link, MomoDeepLink(serverURLString: "", inviteCode: "ABC123"))
    }

    func testEmptyParameterValuesReturnNil() {
        XCTAssertNil(parse("oort://join?server=&code="))
    }

    func testNoParametersReturnNil() {
        XCTAssertNil(parse("oort://join"))
    }

    func testWrongSchemeReturnsNil() {
        XCTAssertNil(parse("https://join?server=https%3A%2F%2Fa.example.com&code=ABC123"))
        XCTAssertNil(parse("slack://join?server=https%3A%2F%2Fa.example.com&code=ABC123"))
    }

    /// **The pre-rebrand scheme still opens.**
    ///
    /// goal B13 moved the minted scheme `momo://` -> `oort://`. Dropping the old
    /// one would have broken every invite already sitting in somebody's inbox —
    /// links that were correct when they were sent. Both are registered in
    /// `XcodeHost/Info.plist`, and this is what stops the second entry from
    /// being tidied away later.
    func testLegacyMomoSchemeStillParses() throws {
        let link = try XCTUnwrap(
            parse("momo://join?server=https%3A%2F%2Fa.example.com&code=ABC123")
        )
        XCTAssertEqual(link.serverURLString, "https://a.example.com")
        XCTAssertEqual(link.inviteCode, "ABC123")
        XCTAssertNotNil(parse("momo:join?code=ABC123"))
    }

    /// …while what the builder MINTS is the new one, so nothing keeps making
    /// links that only exist for backward compatibility.
    func testBuilderMintsTheNewScheme() throws {
        let link = try XCTUnwrap(
            MomoDeepLinkBuilder.buildJoinLink(
                serverURLString: "https://api.example.com",
                inviteCode: "ABC123"
            )
        )
        XCTAssertTrue(link.hasPrefix("oort://join?"), link)
        XCTAssertEqual(MomoDeepLinkParser.scheme, "oort")
        XCTAssertTrue(MomoDeepLinkParser.acceptedSchemes.contains("momo"))
    }

    func testWrongActionReturnsNil() {
        XCTAssertNil(parse("oort://signin?server=https%3A%2F%2Fa.example.com&code=ABC123"))
    }

    func testEmptyActionReturnsNil() {
        XCTAssertNil(parse("oort://?server=https%3A%2F%2Fa.example.com&code=ABC123"))
    }

    // The percent-decoded server must still satisfy the form's own URL validation.
    func testParsedServerFeedsExistingBaseURLValidation() throws {
        let link = try XCTUnwrap(parse("oort://join?server=http%3A%2F%2Fmacbook.local%3A28180&code=ABC123"))
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
        XCTAssertEqual(link, "oort://join?server=https%3A%2F%2Fapi.example.com&code=TEAM-7Q2X")
    }

    func testBuildEncodesSchemeColonAndPathSlashes() {
        let link = MomoDeepLinkBuilder.buildJoinLink(
            serverURLString: "http://macbook.local:28180",
            inviteCode: "ABC123"
        )
        XCTAssertEqual(link, "oort://join?server=http%3A%2F%2Fmacbook.local%3A28180&code=ABC123")
    }

    func testBuildTrimsWhitespace() {
        let link = MomoDeepLinkBuilder.buildJoinLink(
            serverURLString: "  https://a.example.com  ",
            inviteCode: "  CODE-1  "
        )
        XCTAssertEqual(link, "oort://join?server=https%3A%2F%2Fa.example.com&code=CODE-1")
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
            URL(string: "oort://join?server=http%3A%2F%2Fmacbook.local%3A28180&code=TEAM-7Q2X")!
        )

        XCTAssertEqual(controller.form.baseURLString, "http://macbook.local:28180")
        XCTAssertEqual(controller.form.inviteCode, "TEAM-7Q2X")
        XCTAssertEqual(controller.onboardingPath, .join)
        XCTAssertEqual(controller.deepLinkPrefillIntent?.path, .join)
    }

    func testRepeatedLinksProduceDistinctPrefillTokens() {
        let controller = makeController()

        controller.handleIncomingURL(URL(string: "oort://join?server=https%3A%2F%2Fa.example.com&code=A")!)
        let firstToken = controller.deepLinkPrefillIntent?.token
        controller.consumeDeepLinkPrefillIntent()
        controller.handleIncomingURL(URL(string: "oort://join?server=https%3A%2F%2Fb.example.com&code=B")!)
        let secondToken = controller.deepLinkPrefillIntent?.token

        XCTAssertNotNil(firstToken)
        XCTAssertNotNil(secondToken)
        XCTAssertNotEqual(firstToken, secondToken)
        XCTAssertEqual(controller.form.baseURLString, "https://b.example.com")
        XCTAssertEqual(controller.form.inviteCode, "B")
    }

    func testConsumingPrefillIntentClearsIt() {
        let controller = makeController()
        controller.handleIncomingURL(URL(string: "oort://join?server=https%3A%2F%2Fa.example.com&code=A")!)

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

        controller.handleIncomingURL(URL(string: "oort://join?code=ONLYCODE")!)

        XCTAssertEqual(controller.form.baseURLString, "https://kept.example.com")
        XCTAssertEqual(controller.form.inviteCode, "ONLYCODE")
        XCTAssertEqual(controller.onboardingPath, .join)
    }
}
