import XCTest
@testable import MomoMac

/// A browser stand-in that records lifecycle calls and lets a test push events
/// synchronously, so the discovery model can be exercised without a live network.
final class MockMomoServerBrowser: MomoServerBrowsing {
    private(set) var startCount = 0
    private(set) var cancelCount = 0
    private var handler: (@Sendable @MainActor (MomoServerDiscoveryEvent) -> Void)?

    func start(onEvent: @escaping @Sendable @MainActor (MomoServerDiscoveryEvent) -> Void) {
        startCount += 1
        handler = onEvent
    }

    func cancel() {
        cancelCount += 1
    }

    @MainActor
    func emit(_ event: MomoServerDiscoveryEvent) {
        handler?(event)
    }
}

final class MomoServerDiscoveryTests: XCTestCase {

    // MARK: - Pure decision layer

    func testValidBaseURLBecomesOfferedServerWithHostAndPort() {
        let servers = MomoServerDiscovery.servers(from: [
            MomoServerDiscoveryResult(serviceName: "성재의 MacBook Pro", baseURLString: "http://MacBook-Pro-2.local:28000")
        ])

        XCTAssertEqual(servers.count, 1)
        XCTAssertEqual(servers.first?.baseURLString, "http://MacBook-Pro-2.local:28000")
        XCTAssertEqual(servers.first?.displayHost, "MacBook-Pro-2.local:28000")
    }

    func testDefaultPortIsOmittedFromDisplayHost() {
        let servers = MomoServerDiscovery.servers(from: [
            MomoServerDiscoveryResult(serviceName: "team", baseURLString: "https://team.momo.local")
        ])

        XCTAssertEqual(servers.first?.displayHost, "team.momo.local")
    }

    func testResultsWithoutUsableBaseURLAreDropped() {
        let servers = MomoServerDiscovery.servers(from: [
            MomoServerDiscoveryResult(serviceName: "no-txt", baseURLString: nil),
            MomoServerDiscoveryResult(serviceName: "blank", baseURLString: "   "),
            MomoServerDiscoveryResult(serviceName: "no-scheme", baseURLString: "MacBook-Pro-2.local:28000"),
            MomoServerDiscoveryResult(serviceName: "no-host", baseURLString: "http://"),
            MomoServerDiscoveryResult(serviceName: "wrong-scheme", baseURLString: "ftp://host.local"),
        ])

        XCTAssertTrue(servers.isEmpty)
    }

    func testDuplicateBaseURLsAreDedupedPreservingOrder() {
        let servers = MomoServerDiscovery.servers(from: [
            MomoServerDiscoveryResult(serviceName: "first", baseURLString: "http://alpha.local:28000"),
            MomoServerDiscoveryResult(serviceName: "second", baseURLString: "http://beta.local:28000"),
            MomoServerDiscoveryResult(serviceName: "first-again", baseURLString: "http://alpha.local:28000"),
        ])

        XCTAssertEqual(servers.map(\.baseURLString), ["http://alpha.local:28000", "http://beta.local:28000"])
    }

    func testEmptyResultsProduceNoServers() {
        XCTAssertTrue(MomoServerDiscovery.servers(from: []).isEmpty)
    }

    func testOfferedBaseURLPassesSessionFormValidation() throws {
        let servers = MomoServerDiscovery.servers(from: [
            MomoServerDiscoveryResult(serviceName: "team", baseURLString: "http://MacBook-Pro-2.local:28000")
        ])
        let baseURLString = try XCTUnwrap(servers.first?.baseURLString)
        let form = MomoServerSessionForm(baseURLString: baseURLString)

        // The prefilled address must satisfy the same rule the sign-in path enforces.
        XCTAssertNoThrow(try form.validatedBaseURL())
    }

    // MARK: - Observable lifecycle (mock browser)

    @MainActor
    func testResultsEventPublishesOfferedServers() {
        let mock = MockMomoServerBrowser()
        let model = MomoServerDiscoveryModel(browseTimeout: .seconds(60), makeBrowser: { mock })

        model.start()
        XCTAssertEqual(mock.startCount, 1)
        XCTAssertTrue(model.servers.isEmpty)

        mock.emit(.results([
            MomoServerDiscoveryResult(serviceName: "team", baseURLString: "http://MacBook-Pro-2.local:28000")
        ]))

        XCTAssertEqual(model.servers.map(\.displayHost), ["MacBook-Pro-2.local:28000"])
    }

    @MainActor
    func testFailureStaysSilentAndStopsBrowsing() {
        let mock = MockMomoServerBrowser()
        let model = MomoServerDiscoveryModel(browseTimeout: .seconds(60), makeBrowser: { mock })

        model.start()
        mock.emit(.failed)

        XCTAssertTrue(model.servers.isEmpty)
        XCTAssertEqual(mock.cancelCount, 1)
    }

    @MainActor
    func testEmptyResultsKeepChooserSilent() {
        let mock = MockMomoServerBrowser()
        let model = MomoServerDiscoveryModel(browseTimeout: .seconds(60), makeBrowser: { mock })

        model.start()
        mock.emit(.results([]))

        XCTAssertTrue(model.servers.isEmpty)
    }

    @MainActor
    func testStartIsIdempotent() {
        let mock = MockMomoServerBrowser()
        let model = MomoServerDiscoveryModel(browseTimeout: .seconds(60), makeBrowser: { mock })

        model.start()
        model.start()

        XCTAssertEqual(mock.startCount, 1)
    }

    @MainActor
    func testStopCancelsBrowsing() {
        let mock = MockMomoServerBrowser()
        let model = MomoServerDiscoveryModel(browseTimeout: .seconds(60), makeBrowser: { mock })

        model.start()
        model.stop()

        XCTAssertEqual(mock.cancelCount, 1)
    }

    @MainActor
    func testTimeoutStopsBrowsing() async {
        let mock = MockMomoServerBrowser()
        let model = MomoServerDiscoveryModel(browseTimeout: .milliseconds(20), makeBrowser: { mock })

        model.start()
        XCTAssertEqual(mock.cancelCount, 0)

        try? await Task.sleep(for: .milliseconds(200))

        XCTAssertEqual(mock.cancelCount, 1)
    }

    @MainActor
    func testSeededModelOffersServersWithoutBrowsing() {
        let model = MomoServerDiscoveryModel(
            seeded: [MomoDiscoveredServer(baseURLString: "http://team.local:28000", displayHost: "team.local:28000")]
        )

        XCTAssertEqual(model.servers.count, 1)
    }
}
