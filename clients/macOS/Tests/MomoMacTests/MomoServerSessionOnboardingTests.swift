import XCTest
@testable import MomoMac

final class MomoServerSessionOnboardingTests: XCTestCase {
    func testEmptyPasswordKeepsDemoAsPrimaryAction() {
        let form = MomoServerSessionForm(
            baseURLString: "https://momo.team",
            email: "sungjae@momo.team",
            password: ""
        )

        XCTAssertEqual(form.onboardingPrimaryAction, .demo)
        XCTAssertFalse(form.canJoinWithInvite)
    }

    func testCredentialInputPromotesSignInToPrimaryAction() {
        let form = MomoServerSessionForm(
            baseURLString: "https://momo.team",
            email: "sungjae@momo.team",
            password: "team-password"
        )

        XCTAssertEqual(form.onboardingPrimaryAction, .signIn)
    }

    func testInviteJoinRequiresCredentialsAndInviteCode() {
        var form = MomoServerSessionForm(
            baseURLString: "https://momo.team",
            email: "sungjae@momo.team",
            password: "team-password"
        )

        XCTAssertFalse(form.canJoinWithInvite)

        form.inviteCode = "MOMO-368"
        XCTAssertTrue(form.canJoinWithInvite)

        form.password = ""
        XCTAssertFalse(form.canJoinWithInvite)
    }

    func testWhitespaceCredentialsDoNotDisplaceDemoPrimaryAction() {
        let form = MomoServerSessionForm(
            baseURLString: "   ",
            email: "  ",
            password: "team-password",
            inviteCode: "MOMO-368"
        )

        XCTAssertEqual(form.onboardingPrimaryAction, .demo)
        XCTAssertFalse(form.canJoinWithInvite)
    }

    func testTransportFailureUsesOfflineRecovery() {
        XCTAssertEqual(
            MomoServerSessionError.transport("offline").onboardingFailureKind,
            .offline
        )
    }

    func testUnauthorizedProblemUsesAuthenticationRecovery() {
        XCTAssertEqual(
            MomoServerSessionError.problem(status: 401, title: nil, detail: nil).onboardingFailureKind,
            .authentication
        )
        XCTAssertEqual(
            MomoServerSessionError.problem(status: 403, title: nil, detail: nil).onboardingFailureKind,
            .authentication
        )
    }
}
