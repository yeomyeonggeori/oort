import XCTest
@testable import MomoMac

final class MomoServerSessionOnboardingTests: XCTestCase {
    func testResponsiveLayoutUsesCompactStackedAndSplitBands() {
        XCTAssertEqual(MomoOnboardingLayout.resolve(width: 699), .compact)
        XCTAssertEqual(MomoOnboardingLayout.resolve(width: 700), .compact)
        XCTAssertEqual(MomoOnboardingLayout.resolve(width: 759), .compact)
        XCTAssertEqual(MomoOnboardingLayout.resolve(width: 760), .stacked)
        XCTAssertEqual(MomoOnboardingLayout.resolve(width: 980), .stacked)
        XCTAssertEqual(MomoOnboardingLayout.resolve(width: 1_119), .stacked)
        XCTAssertEqual(MomoOnboardingLayout.resolve(width: 1_120), .split)
        XCTAssertEqual(MomoOnboardingLayout.resolve(width: 1_600), .split)
        XCTAssertLessThan(MomoTheme.Onboarding.minimumWindowWidth, MomoTheme.Onboarding.compactBreakpoint)
        XCTAssertEqual(MomoTheme.Onboarding.connectedMinimumWindowWidth, 980)
    }

    @MainActor
    func testControllerTracksChosenPathForRecovery() {
        let controller = MomoServerSessionController()

        controller.beginOnboarding(.operatorSetup)

        XCTAssertEqual(controller.onboardingPath, .operatorSetup)
    }

    @MainActor
    func testExplicitLocalDemoBuildsOfflineWorkspace() async {
        let viewModel = await MomoMacDemo.makeLocalDemoViewModel()

        XCTAssertNil(viewModel.connectionError)
        XCTAssertFalse(viewModel.channels.isEmpty)
        XCTAssertNotNil(viewModel.selectedChannelId)
    }

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
