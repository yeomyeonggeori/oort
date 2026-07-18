import Foundation
import XCTest
import MomoCore
@testable import MomoMac

final class MomoPluginMarketplaceTests: XCTestCase {
    override func tearDown() async throws {
        PluginMarketplaceURLProtocol.reset()
        try await super.tearDown()
    }

    func testRESTServiceUsesAuthenticatedListDetailAndMutationContracts() async throws {
        PluginMarketplaceURLProtocol.reset()
        let context = testContext

        PluginMarketplaceURLProtocol.setHandler { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer app-access-token")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/json")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Cache-Control"), "no-store")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Pragma"), "no-cache")
            XCTAssertEqual(request.cachePolicy, .reloadIgnoringLocalCacheData)

            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/v1/workspaces/\(context.workspace.description)/plugins"):
                return .init(json: Self.catalogJSON(installed: true, granted: true))
            case ("GET", "/v1/workspaces/\(context.workspace.description)/plugins/com.momo.plugins.drive"):
                return .init(json: Self.detailJSON(scopes: ["drive:read"]))
            case ("POST", "/v1/workspaces/\(context.workspace.description)/plugins/com.momo.plugins.drive/install"):
                XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
                let body = try XCTUnwrap(request.pluginMarketplaceBodyData)
                let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
                XCTAssertEqual(object.keys.sorted(), ["enabled"])
                XCTAssertEqual(object["enabled"] as? Bool, true)
                return .init(statusCode: 201, json: Self.mutationJSON(status: "enabled", scope: nil))
            case ("POST", "/v1/workspaces/\(context.workspace.description)/plugins/com.momo.plugins.drive/grants"):
                let body = try XCTUnwrap(request.pluginMarketplaceBodyData)
                let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
                XCTAssertEqual(object.keys.sorted(), ["scope"])
                XCTAssertEqual(object["scope"] as? String, "drive:read")
                return .init(statusCode: 201, json: Self.mutationJSON(status: "active", scope: "drive:read"))
            case ("DELETE", "/v1/workspaces/\(context.workspace.description)/plugins/com.momo.plugins.drive/grants/drive:read"):
                XCTAssertNil(request.httpBody)
                return .init(json: Self.mutationJSON(status: "revoked", scope: "drive:read"))
            case ("DELETE", "/v1/workspaces/\(context.workspace.description)/plugins/com.momo.plugins.drive/install"):
                XCTAssertNil(request.httpBody)
                return .init(json: Self.mutationJSON(status: "revoked", scope: nil))
            default:
                return .init(statusCode: 404, json: #"{"title":"unexpected request"}"#)
            }
        }

        let service = MomoPluginMarketplaceRESTService(session: mockedSession)
        let snapshot = try await service.fetchCatalog(context: context)
        XCTAssertEqual(snapshot.plugins.map(\.pluginId), ["com.momo.plugins.drive"])
        XCTAssertTrue(snapshot.plugins[0].recommended)
        XCTAssertEqual(snapshot.grantedPluginIDs, ["com.momo.plugins.drive"])

        let detail = try await service.fetchDetail(
            pluginID: "com.momo.plugins.drive",
            context: context
        )
        XCTAssertEqual(detail.singleDeclaredScope, "drive:read")

        _ = try await service.install(pluginID: detail.pluginId, context: context)
        _ = try await service.grant(pluginID: detail.pluginId, scope: "drive:read", context: context)
        _ = try await service.revokeGrant(pluginID: detail.pluginId, scope: "drive:read", context: context)
        _ = try await service.revokeInstall(pluginID: detail.pluginId, context: context)

        XCTAssertEqual(
            PluginMarketplaceURLProtocol.requests().map { $0.httpMethod ?? "" },
            ["GET", "GET", "POST", "POST", "DELETE", "DELETE"]
        )
    }

    func testRESTServiceDefaultSessionDisablesSharedAuthStateAndCaching() {
        let configuration = MomoPluginMarketplaceRESTService.makeEphemeralConfiguration()

        XCTAssertEqual(configuration.requestCachePolicy, .reloadIgnoringLocalCacheData)
        XCTAssertNil(configuration.urlCache)
        XCTAssertFalse(configuration.httpShouldSetCookies)
        XCTAssertNil(configuration.httpCookieStorage)
        XCTAssertNil(configuration.urlCredentialStorage)
    }

    func testNarrowCenterPaneSelectsCompactTwoRowCatalogControls() {
        let narrowCenterWidth: CGFloat = 436
        let contentWidth = narrowCenterWidth - (MomoTheme.PluginMarketplace.edgeInset * 2)

        XCTAssertLessThan(
            contentWidth,
            MomoPluginMarketplaceControlLayout.wideMinimumContentWidth,
            "The single-row candidate must not compress its search field in the narrow center pane."
        )
        XCTAssertGreaterThanOrEqual(
            contentWidth,
            MomoPluginMarketplaceControlLayout.compactMinimumContentWidth,
            "The two-row candidate must preserve the search field and refresh hit target."
        )
        XCTAssertGreaterThanOrEqual(
            MomoPluginMarketplaceControlLayout.refreshMinimumSize,
            MomoTheme.MessageInteraction.actionMinimumSize
        )
    }

    func testRESTServicePreservesHTTPStatusAndSafeProblemDetail() async throws {
        PluginMarketplaceURLProtocol.reset()
        PluginMarketplaceURLProtocol.setHandler { _ in
            .init(
                statusCode: 403,
                json: #"{"error":{"message":"workspace role cannot install this plugin"}}"#
            )
        }
        let service = MomoPluginMarketplaceRESTService(session: mockedSession)

        do {
            _ = try await service.install(
                pluginID: "com.momo.plugins.drive",
                context: testContext
            )
            XCTFail("Expected the server error to be preserved")
        } catch let error as MomoPluginMarketplaceError {
            XCTAssertEqual(
                error,
                .http(status: 403, message: "workspace role cannot install this plugin")
            )
        }
    }

    @MainActor
    func testStoreLoadsServerRecommendationAndRoundTripsOneScopeGrant() async throws {
        let service = FakePluginMarketplaceService(
            installed: true,
            granted: false,
            scopes: ["drive:read"]
        )
        let store = MomoPluginMarketplaceStore(service: service, context: testContext)

        await store.load()
        XCTAssertEqual(store.phase, .loaded)
        let plugin = try XCTUnwrap(store.plugins.first)
        XCTAssertTrue(plugin.recommended)
        XCTAssertTrue(store.grantedPluginIDs.isEmpty)

        await store.loadDetail(for: plugin)
        XCTAssertEqual(store.details[plugin.id]?.singleDeclaredScope, "drive:read")

        await store.toggleGrant(for: plugin)
        XCTAssertEqual(store.grantedPluginIDs, [plugin.id])
        let grantedScopes = await service.grantedScopes()
        XCTAssertEqual(grantedScopes, ["drive:read"])

        await store.toggleGrant(for: plugin)
        XCTAssertTrue(store.grantedPluginIDs.isEmpty)
        let revokedScopes = await service.revokedScopes()
        XCTAssertEqual(revokedScopes, ["drive:read"])

        await store.revokeInstall(plugin)
        XCTAssertFalse(try XCTUnwrap(store.plugins.first).installed)
        let revokedPluginIDs = await service.revokedInstallPluginIDs()
        XCTAssertEqual(revokedPluginIDs, [plugin.id])
    }

    @MainActor
    func testStoreFailsClosedWhenManifestDeclaresMoreThanOneScope() async throws {
        let service = FakePluginMarketplaceService(
            installed: true,
            granted: false,
            scopes: ["drive:read", "drive:write"]
        )
        let store = MomoPluginMarketplaceStore(service: service, context: testContext)
        await store.load()
        let plugin = try XCTUnwrap(store.plugins.first)

        await store.toggleGrant(for: plugin)

        XCTAssertEqual(
            store.actionFailure,
            .unsupportedScope(pluginName: "Google Drive", declaredCount: 2)
        )
        let grantedScopes = await service.grantedScopes()
        XCTAssertTrue(grantedScopes.isEmpty)
    }

    @MainActor
    func testStoreSurfacesOfflineStateAndDoesNotMutateChannelIntegration() async throws {
        let offlineService = FakePluginMarketplaceService(
            installed: false,
            granted: false,
            scopes: ["drive:read"],
            catalogError: .transport(
                code: URLError.notConnectedToInternet.rawValue,
                message: "The Internet connection appears to be offline."
            )
        )
        let offlineStore = MomoPluginMarketplaceStore(service: offlineService, context: testContext)
        await offlineStore.load()
        XCTAssertEqual(offlineStore.phase, .offline)

        let service = FakePluginMarketplaceService(
            installed: false,
            granted: false,
            scopes: ["webhook:receive"]
        )
        let store = MomoPluginMarketplaceStore(service: service, context: testContext)
        let webhook = Self.plugin(
            id: "external_webhook",
            name: "Incoming Webhook",
            recommended: true,
            installed: false,
            enabled: false
        )
        XCTAssertTrue(webhook.isChannelIntegration)

        await store.install(webhook)

        XCTAssertEqual(store.actionFailure, .channelIntegrationRequired)
        let installedPluginIDs = await service.installedPluginIDs()
        XCTAssertTrue(installedPluginIDs.isEmpty)
    }

    @MainActor
    func testStoreClearsServerScopedStateWhenWorkspaceOrTokenChanges() async throws {
        let service = ContextAwarePluginMarketplaceService()
        let contextA = MomoInviteAdminContext(
            baseURL: URL(string: "https://momo.example")!,
            workspace: WorkspaceID(uuidString: "00000000-0000-7000-8000-000000000001")!,
            accessToken: "app-token-a"
        )
        let contextB = MomoInviteAdminContext(
            baseURL: URL(string: "https://momo.example")!,
            workspace: WorkspaceID(uuidString: "00000000-0000-7000-8000-000000000002")!,
            accessToken: "app-token-b"
        )
        let contextC = MomoInviteAdminContext(
            baseURL: URL(string: "https://momo.example")!,
            workspace: contextB.workspace,
            accessToken: "app-token-c"
        )
        let store = MomoPluginMarketplaceStore(service: service, context: contextA)

        await store.load()
        let pluginA = try XCTUnwrap(store.plugins.first)
        XCTAssertEqual(pluginA.id, "plugin.a")
        XCTAssertEqual(store.grantedPluginIDs, ["plugin.a"])
        await store.loadDetail(for: pluginA)
        XCTAssertEqual(store.details[pluginA.id]?.singleDeclaredScope, "resource-a:read")

        let firstDetailRevision = store.detailRevision
        await store.retry()
        XCTAssertGreaterThan(store.detailRevision, firstDetailRevision)
        XCTAssertTrue(store.details.isEmpty)

        let webhook = Self.plugin(
            id: "external_webhook",
            name: "Incoming Webhook",
            recommended: true,
            installed: false,
            enabled: false
        )
        await store.install(webhook)
        XCTAssertEqual(store.actionFailure, .channelIntegrationRequired)

        await store.updateContext(contextB)
        XCTAssertEqual(store.phase, .loaded)
        XCTAssertEqual(store.plugins.map(\.id), ["plugin.b"])
        XCTAssertTrue(store.grantedPluginIDs.isEmpty)
        XCTAssertTrue(store.details.isEmpty)
        XCTAssertTrue(store.detailFailures.isEmpty)
        XCTAssertTrue(store.detailLoadingPluginIDs.isEmpty)
        XCTAssertTrue(store.mutatingPluginIDs.isEmpty)
        XCTAssertNil(store.actionFailure)

        await store.updateContext(contextC)
        XCTAssertEqual(store.plugins.map(\.id), ["plugin.c"])

        await store.updateContext(nil)
        XCTAssertEqual(store.phase, .unavailable)
        XCTAssertTrue(store.plugins.isEmpty)
        XCTAssertTrue(store.grantedPluginIDs.isEmpty)
        XCTAssertTrue(store.details.isEmpty)
        XCTAssertNil(store.actionFailure)

        let catalogTokensBeforeRetry = await service.catalogTokens()
        await store.retry()
        XCTAssertEqual(store.phase, .unavailable)
        let catalogTokensAfterRetry = await service.catalogTokens()
        XCTAssertEqual(catalogTokensAfterRetry, catalogTokensBeforeRetry)
        XCTAssertEqual(catalogTokensAfterRetry, ["app-token-a", "app-token-a", "app-token-b", "app-token-c"])
    }

    private var testContext: MomoInviteAdminContext {
        MomoInviteAdminContext(
            baseURL: URL(string: "https://momo.example")!,
            workspace: .demo,
            accessToken: "app-access-token"
        )
    }

    private var mockedSession: URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PluginMarketplaceURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    private static func plugin(
        id: String = "com.momo.plugins.drive",
        name: String = "Google Drive",
        recommended: Bool = true,
        installed: Bool,
        enabled: Bool
    ) -> MomoPluginCatalogEntry {
        MomoPluginCatalogEntry(
            pluginId: id,
            name: name,
            version: "1.0.0",
            description: "Official read-only shared drive integration",
            official: true,
            recommended: recommended,
            egressDomains: ["www.googleapis.com"],
            recommendedFor: ["shared-drive-search"],
            installed: installed,
            enabled: enabled
        )
    }

    fileprivate static func detail(scopes: [String]) -> MomoPluginDetail {
        MomoPluginDetail(
            pluginId: "com.momo.plugins.drive",
            name: "Google Drive",
            version: "1.0.0",
            description: "Official read-only shared drive integration",
            official: true,
            egressDomains: ["www.googleapis.com"],
            recommendedFor: ["shared-drive-search"],
            installed: true,
            enabled: true,
            manifest: MomoPluginManifest(
                mcp: MomoPluginManifestMCP(tools: [
                    MomoPluginManifestTool(
                        name: "drive.search_files",
                        description: "Search shared drive files",
                        scopes: scopes,
                        risk: "read",
                        approvalPolicy: "none"
                    ),
                ]),
                momo: MomoPluginManifestPolicy(
                    risk: "low",
                    egressDomains: ["www.googleapis.com"],
                    recommendedFor: ["shared-drive-search"],
                    serverPolicy: MomoPluginServerPolicy(
                        installAllowed: true,
                        enabledByDefault: false,
                        allowedRoles: ["owner", "admin"]
                    )
                )
            )
        )
    }

    fileprivate static func snapshot(installed: Bool, granted: Bool) -> MomoPluginCatalogSnapshot {
        let descriptor = MomoPluginPolicyDescriptor(
            pluginId: "com.momo.plugins.drive",
            mcp: MomoPluginPolicyMCP(url: "/v1/mcp/drive", transport: "streamable_http"),
            egressDomains: ["www.googleapis.com"],
            tools: [
                MomoPluginPolicyTool(
                    name: "drive.search_files",
                    risk: "read",
                    approvalTier: "read_only"
                ),
            ]
        )
        return MomoPluginCatalogSnapshot(
            plugins: [plugin(installed: installed, enabled: installed)],
            toolPolicy: MomoPluginToolPolicy(plugins: granted ? [descriptor] : [])
        )
    }

    private static func catalogJSON(installed: Bool, granted: Bool) -> String {
        let policy = granted
            ? #"[{"pluginId":"com.momo.plugins.drive","mcp":{"url":"/v1/mcp/drive","transport":"streamable_http"},"egressDomains":["www.googleapis.com"],"tools":[{"name":"drive.search_files","risk":"read","approvalTier":"read_only"}]}]"#
            : "[]"
        return """
        {
          "plugins":[{
            "pluginId":"com.momo.plugins.drive",
            "name":"Google Drive",
            "version":"1.0.0",
            "description":"Official read-only shared drive integration",
            "official":true,
            "recommended":true,
            "egressDomains":["www.googleapis.com"],
            "recommendedFor":["shared-drive-search"],
            "installed":\(installed),
            "enabled":\(installed)
          }],
          "toolPolicy":{"plugins":\(policy)}
        }
        """
    }

    private static func detailJSON(scopes: [String]) -> String {
        let scopeJSON = scopes.map { "\"\($0)\"" }.joined(separator: ",")
        return """
        {"plugin":{
          "pluginId":"com.momo.plugins.drive",
          "name":"Google Drive",
          "version":"1.0.0",
          "description":"Official read-only shared drive integration",
          "official":true,
          "egressDomains":["www.googleapis.com"],
          "recommendedFor":["shared-drive-search"],
          "installed":true,
          "enabled":true,
          "manifest":{
            "mcp":{"tools":[{
              "name":"drive.search_files",
              "description":"Search shared drive files",
              "scopes":[\(scopeJSON)],
              "risk":"read",
              "approvalPolicy":"none"
            }]},
            "momo":{
              "risk":"low",
              "egressDomains":["www.googleapis.com"],
              "recommendedFor":["shared-drive-search"],
              "serverPolicy":{"installAllowed":true,"enabledByDefault":false,"allowedRoles":["owner","admin"]}
            }
          }
        }}
        """
    }

    private static func mutationJSON(status: String, scope: String?) -> String {
        let encodedScope = scope.map { "\"\($0)\"" } ?? "null"
        return """
        {
          "pluginId":"com.momo.plugins.drive",
          "memberId":null,
          "scope":\(encodedScope),
          "status":"\(status)",
          "enabled":\(status != "revoked"),
          "auditRef":"2F6B9A4E-10DC-44AD-8CC0-984A943EE267",
          "capabilities":[]
        }
        """
    }
}

private actor FakePluginMarketplaceService: MomoPluginMarketplaceService {
    private var installed: Bool
    private var granted: Bool
    private let scopes: [String]
    private let catalogError: MomoPluginMarketplaceError?
    private var installCalls: [String] = []
    private var revokeInstallCalls: [String] = []
    private var grantCalls: [String] = []
    private var revokeGrantCalls: [String] = []

    init(
        installed: Bool,
        granted: Bool,
        scopes: [String],
        catalogError: MomoPluginMarketplaceError? = nil
    ) {
        self.installed = installed
        self.granted = granted
        self.scopes = scopes
        self.catalogError = catalogError
    }

    func fetchCatalog(context: MomoInviteAdminContext) async throws -> MomoPluginCatalogSnapshot {
        if let catalogError { throw catalogError }
        return MomoPluginMarketplaceTests.snapshot(installed: installed, granted: granted)
    }

    func fetchDetail(
        pluginID: String,
        context: MomoInviteAdminContext
    ) async throws -> MomoPluginDetail {
        MomoPluginMarketplaceTests.detail(scopes: scopes)
    }

    func install(
        pluginID: String,
        context: MomoInviteAdminContext
    ) async throws -> MomoPluginMutationReceipt {
        installCalls.append(pluginID)
        installed = true
        return receipt(pluginID: pluginID, scope: nil, status: "enabled")
    }

    func revokeInstall(
        pluginID: String,
        context: MomoInviteAdminContext
    ) async throws -> MomoPluginMutationReceipt {
        revokeInstallCalls.append(pluginID)
        installed = false
        granted = false
        return receipt(pluginID: pluginID, scope: nil, status: "revoked")
    }

    func grant(
        pluginID: String,
        scope: String,
        context: MomoInviteAdminContext
    ) async throws -> MomoPluginMutationReceipt {
        grantCalls.append(scope)
        granted = true
        return receipt(pluginID: pluginID, scope: scope, status: "active")
    }

    func revokeGrant(
        pluginID: String,
        scope: String,
        context: MomoInviteAdminContext
    ) async throws -> MomoPluginMutationReceipt {
        revokeGrantCalls.append(scope)
        granted = false
        return receipt(pluginID: pluginID, scope: scope, status: "revoked")
    }

    func installedPluginIDs() -> [String] { installCalls }
    func revokedInstallPluginIDs() -> [String] { revokeInstallCalls }
    func grantedScopes() -> [String] { grantCalls }
    func revokedScopes() -> [String] { revokeGrantCalls }

    private func receipt(pluginID: String, scope: String?, status: String) -> MomoPluginMutationReceipt {
        MomoPluginMutationReceipt(
            pluginId: pluginID,
            memberId: nil,
            scope: scope,
            status: status,
            enabled: status != "revoked",
            auditRef: nil,
            capabilities: []
        )
    }
}

private actor ContextAwarePluginMarketplaceService: MomoPluginMarketplaceService {
    private var seenCatalogTokens: [String] = []

    func fetchCatalog(context: MomoInviteAdminContext) async throws -> MomoPluginCatalogSnapshot {
        seenCatalogTokens.append(context.accessToken)
        let suffix = String(context.accessToken.suffix(1))
        let pluginID = "plugin.\(suffix)"
        let plugin = MomoPluginCatalogEntry(
            pluginId: pluginID,
            name: "Plugin \(suffix.uppercased())",
            version: "1.0.0",
            description: "Context-bound fixture",
            official: true,
            recommended: suffix == "a",
            egressDomains: [],
            recommendedFor: [],
            installed: true,
            enabled: true
        )
        let policy = MomoPluginPolicyDescriptor(
            pluginId: pluginID,
            mcp: MomoPluginPolicyMCP(url: "/mcp/\(suffix)", transport: "streamable_http"),
            egressDomains: [],
            tools: [
                MomoPluginPolicyTool(name: "fixture.read", risk: "read", approvalTier: "read_only"),
            ]
        )
        return MomoPluginCatalogSnapshot(
            plugins: [plugin],
            toolPolicy: MomoPluginToolPolicy(plugins: suffix == "a" ? [policy] : [])
        )
    }

    func fetchDetail(
        pluginID: String,
        context: MomoInviteAdminContext
    ) async throws -> MomoPluginDetail {
        let suffix = String(context.accessToken.suffix(1))
        return MomoPluginDetail(
            pluginId: pluginID,
            name: "Plugin \(suffix.uppercased())",
            version: "1.0.0",
            description: "Context-bound fixture",
            official: true,
            egressDomains: [],
            recommendedFor: [],
            installed: true,
            enabled: true,
            manifest: MomoPluginManifest(
                mcp: MomoPluginManifestMCP(tools: [
                    MomoPluginManifestTool(
                        name: "fixture.read",
                        description: "Read the fixture",
                        scopes: ["resource-\(suffix):read"],
                        risk: "read",
                        approvalPolicy: "none"
                    ),
                ]),
                momo: MomoPluginManifestPolicy(
                    risk: "low",
                    egressDomains: [],
                    recommendedFor: [],
                    serverPolicy: MomoPluginServerPolicy(
                        installAllowed: true,
                        enabledByDefault: true,
                        allowedRoles: ["owner", "admin"]
                    )
                )
            )
        )
    }

    func install(
        pluginID: String,
        context: MomoInviteAdminContext
    ) async throws -> MomoPluginMutationReceipt {
        receipt(pluginID: pluginID, scope: nil, status: "enabled")
    }

    func revokeInstall(
        pluginID: String,
        context: MomoInviteAdminContext
    ) async throws -> MomoPluginMutationReceipt {
        receipt(pluginID: pluginID, scope: nil, status: "revoked")
    }

    func grant(
        pluginID: String,
        scope: String,
        context: MomoInviteAdminContext
    ) async throws -> MomoPluginMutationReceipt {
        receipt(pluginID: pluginID, scope: scope, status: "active")
    }

    func revokeGrant(
        pluginID: String,
        scope: String,
        context: MomoInviteAdminContext
    ) async throws -> MomoPluginMutationReceipt {
        receipt(pluginID: pluginID, scope: scope, status: "revoked")
    }

    func catalogTokens() -> [String] { seenCatalogTokens }

    private func receipt(pluginID: String, scope: String?, status: String) -> MomoPluginMutationReceipt {
        MomoPluginMutationReceipt(
            pluginId: pluginID,
            memberId: nil,
            scope: scope,
            status: status,
            enabled: status != "revoked",
            auditRef: nil,
            capabilities: []
        )
    }
}

private struct PluginMarketplaceMockResponse: Sendable {
    let statusCode: Int
    let json: String

    init(statusCode: Int = 200, json: String) {
        self.statusCode = statusCode
        self.json = json
    }
}

private final class PluginMarketplaceURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) throws -> PluginMarketplaceMockResponse

    nonisolated(unsafe) private static var handler: Handler?
    nonisolated(unsafe) private static var seenRequests: [URLRequest] = []
    private static let lock = NSLock()

    static func reset() {
        lock.withLock {
            handler = nil
            seenRequests = []
        }
    }

    static func setHandler(_ newHandler: @escaping Handler) {
        lock.withLock { handler = newHandler }
    }

    static func requests() -> [URLRequest] {
        lock.withLock { seenRequests }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let currentHandler = Self.lock.withLock { () -> Handler? in
            Self.seenRequests.append(request)
            return Self.handler
        }
        guard let currentHandler else {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }

        do {
            let mocked = try currentHandler(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: mocked.statusCode,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(mocked.json.utf8))
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private extension URLRequest {
    var pluginMarketplaceBodyData: Data? {
        if let httpBody { return httpBody }
        guard let httpBodyStream else { return nil }
        httpBodyStream.open()
        defer { httpBodyStream.close() }

        var data = Data()
        let bufferSize = 1_024
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer { buffer.deallocate() }
        while httpBodyStream.hasBytesAvailable {
            let count = httpBodyStream.read(buffer, maxLength: bufferSize)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data
    }
}
