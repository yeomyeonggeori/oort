import Foundation
import Hummingbird
import XCTest
@testable import MomoServer

/// MOMO-622 / ADR-0135 D1 — provider cascade chain, server side.
///
/// Covers the operator contract that can be pinned without a database: the
/// fall-over classification (which MUST match the worker's mirror copy), the
/// position-0 back-compat projection, the replace-all validation matrix, the
/// closed-world request shape (ADR-0004), and the per-hop probe dispositions
/// returned by `POST /v1/provider/link/test`.
///
/// The RLS posture, the bytea store+decrypt roundtrip, the real cascade at run
/// time, and the fallback audit row are measured end to end by
/// `scripts/verify_provider_cascade.sh` (docker).
final class ProviderCascadeTests: XCTestCase {
    private let masterKey = "operator-provider-link-master-key-0622"

    // MARK: - Classification: only no-response / 5xx / 429 fall over

    func testStatusClassificationMatrix() {
        XCTAssertEqual(
            ProviderCascadeClassifier.decide(status: nil),
            .fallOver(reason: "provider_unreachable")
        )
        XCTAssertEqual(
            ProviderCascadeClassifier.decide(status: 429),
            .fallOver(reason: "provider_rate_limited")
        )
        for code in [500, 502, 503, 504, 599] {
            XCTAssertTrue(
                ProviderCascadeClassifier.decide(status: code).isFallOver,
                "\(code) must fall over"
            )
        }
        // A 4xx is a caller/config error: it fails identically on the next
        // provider, so falling over would spend a second budget for nothing.
        for code in [400, 401, 403, 404, 409, 422] {
            XCTAssertFalse(
                ProviderCascadeClassifier.decide(status: code).isFallOver,
                "\(code) must propagate"
            )
        }
    }

    func testProbeReasonClassification() {
        XCTAssertTrue(
            ProviderCascadeClassifier.decide(probeReason: "provider_unreachable").isFallOver
        )
        XCTAssertTrue(
            ProviderCascadeClassifier.decide(probeReason: "provider_rate_limited").isFallOver
        )
        XCTAssertTrue(
            ProviderCascadeClassifier.decide(probeReason: "provider_status_503").isFallOver
        )
        // 401/403 arrive from the probe as provider_auth_failed.
        XCTAssertFalse(
            ProviderCascadeClassifier.decide(probeReason: "provider_auth_failed").isFallOver
        )
        XCTAssertFalse(
            ProviderCascadeClassifier.decide(probeReason: "provider_status_404").isFallOver
        )
        XCTAssertFalse(
            ProviderCascadeClassifier.decide(probeReason: "not_external_provider").isFallOver
        )
        XCTAssertFalse(ProviderCascadeClassifier.decide(probeReason: nil).isFallOver)
    }

    /// The server and the worker carry independent copies of the rule (separate
    /// packages, exactly like `ProviderLinkCrypto`). Drift between them would mean
    /// the operator's `/test` preview disagrees with what a real turn does, so the
    /// rule is pinned here in the shape both copies must satisfy.
    func testFallOverVocabularyIsPinned() {
        XCTAssertEqual(ProviderCascadeClassifier.unreachableReason, "provider_unreachable")
        XCTAssertEqual(ProviderCascadeClassifier.rateLimitedReason, "provider_rate_limited")
        XCTAssertEqual(
            ProviderCascadeClassifier.decide(status: 503).reason, "provider_status_503"
        )
    }

    // MARK: - plan(): position 0 is the legacy singleton / env

    func testPlanProjectsSingletonAsPositionZero() {
        let head = ProviderLinkResolver.resolve(
            env: envConfig(),
            link: DecryptedProviderLink(
                baseURL: "https://db-head.example/v1", bearer: "sk-db-head",
                mode: .externalHermes, updatedByMemberID: nil, updatedAtMs: 7
            )
        )
        let hops = ProviderCascade.plan(head: head, chain: [
            chainEntry(position: 2, host: "second"),
            chainEntry(position: 1, host: "first"),
        ])
        XCTAssertEqual(hops.map(\.position), [0, 1, 2])
        XCTAssertEqual(hops[0].source, .providerLink)
        XCTAssertEqual(hops[0].baseURL, "https://db-head.example/v1")
        XCTAssertEqual(hops[1].source, .chain)
        XCTAssertEqual(hops[1].baseURL, "https://first.example/v1")
    }

    func testPlanTagsEnvironmentHeadWhenNoSingletonRowExists() {
        let head = ProviderLinkResolver.resolve(env: envConfig(), link: nil)
        let hops = ProviderCascade.plan(head: head, chain: [])
        XCTAssertEqual(hops.count, 1)
        XCTAssertEqual(hops[0].source, .environment)
        XCTAssertEqual(hops[0].position, 0)
    }

    func testAttemptableSkipsDisabledAndUnusableHops() {
        let head = ProviderLinkResolver.resolve(env: envConfig(), link: nil)
        let hops = ProviderCascade.plan(head: head, chain: [
            chainEntry(position: 1, host: "parked", enabled: false),
            chainEntry(position: 2, host: "blank", bearer: "   "),
            chainEntry(position: 3, host: "good"),
        ])
        // The projection keeps every configured hop (the operator must see the
        // parked one)…
        XCTAssertEqual(hops.map(\.position), [0, 1, 2, 3])
        // …but only these would actually be attempted.
        XCTAssertEqual(ProviderCascade.attemptable(hops).map(\.position), [0, 3])
    }

    // MARK: - Replace-all validation

    func testValidEntriesAreNormalizedAndSortedByPosition() throws {
        let entries = try validate([
            .init(position: 2, baseUrl: "https://second.example/v1", bearer: "sk-2",
                  mode: nil, enabled: nil),
            .init(position: 1, baseUrl: "https://first.example/v1", bearer: "  sk-1  ",
                  mode: "external-hermes", enabled: false),
        ])
        XCTAssertEqual(entries.map(\.position), [1, 2])
        XCTAssertEqual(entries[0].bearer, "sk-1", "bearer must be trimmed")
        XCTAssertFalse(entries[0].enabled)
        XCTAssertTrue(entries[1].enabled, "enabled defaults to true")
        XCTAssertEqual(entries[1].mode, .externalHermes, "mode defaults to external-hermes")
    }

    /// Position 0 is the singleton's slot. Accepting it here would create a second
    /// store for the same hop and let this endpoint overwrite the 583-gated
    /// `provider_link` behind the operator's back.
    func testPositionZeroIsRejected() {
        XCTAssertThrowsError(try validate([
            .init(position: 0, baseUrl: "https://head.example/v1", bearer: "sk-0",
                  mode: nil, enabled: nil),
        ])) { XCTAssertEqual(($0 as? HTTPError)?.status, .badRequest) }
    }

    func testDuplicatePositionsAreRejected() {
        XCTAssertThrowsError(try validate([
            .init(position: 1, baseUrl: "https://a.example/v1", bearer: "sk-a",
                  mode: nil, enabled: nil),
            .init(position: 1, baseUrl: "https://b.example/v1", bearer: "sk-b",
                  mode: nil, enabled: nil),
        ])) { XCTAssertEqual(($0 as? HTTPError)?.status, .badRequest) }
    }

    func testChainLengthIsBounded() {
        let tooMany = (1...(ProviderLinkRoutes.maxChainEntries + 1)).map {
            PutProviderChainRequest.Entry(
                position: $0, baseUrl: "https://hop\($0).example/v1",
                bearer: "sk-\($0)", mode: nil, enabled: nil
            )
        }
        XCTAssertThrowsError(try validate(tooMany)) {
            XCTAssertEqual(($0 as? HTTPError)?.status, .badRequest)
        }
    }

    func testEmptyBearerIsRejectedButOmittedBearerIsAllowed() throws {
        XCTAssertThrowsError(try validate([
            .init(position: 1, baseUrl: "https://a.example/v1", bearer: "   ",
                  mode: nil, enabled: nil),
        ]))
        // Omitted ⇒ "keep the stored ciphertext"; the route rejects it later if no
        // row exists at that position.
        let kept = try validate([
            .init(position: 1, baseUrl: "https://a.example/v1", bearer: nil,
                  mode: nil, enabled: nil),
        ])
        XCTAssertNil(kept[0].bearer)
    }

    func testBaseURLValidationIsTheSameGuardAsTheSingleton() {
        // Non-loopback http is rejected (must be https).
        XCTAssertThrowsError(try validate([
            .init(position: 1, baseUrl: "http://plain.example/v1", bearer: "sk",
                  mode: nil, enabled: nil),
        ]))
        // Loopback without the local opt-in is rejected.
        XCTAssertThrowsError(try validate([
            .init(position: 1, baseUrl: "http://127.0.0.1:9000/v1", bearer: "sk",
                  mode: nil, enabled: nil),
        ]))
        // Credentials in the URL are rejected.
        XCTAssertThrowsError(try validate([
            .init(position: 1, baseUrl: "https://user:pw@a.example/v1", bearer: "sk",
                  mode: nil, enabled: nil),
        ]))
    }

    func testUnknownModeIsRejected() {
        XCTAssertThrowsError(try validate([
            .init(position: 1, baseUrl: "https://a.example/v1", bearer: "sk",
                  mode: "codex-oauth", enabled: nil),
        ]))
    }

    // MARK: - ADR-0004: closed-world request shape

    func testUnknownFieldsAreRejectedSoNoOAuthFieldCanBeIntroduced() throws {
        let decoder = JSONDecoder()
        let valid = Data(#"{"entries":[{"position":1,"baseUrl":"https://a.example/v1","bearer":"sk"}]}"#.utf8)
        XCTAssertNoThrow(try decoder.decode(PutProviderChainRequest.self, from: valid))

        // An OAuth/raw-provider-key field must not be silently ignored — it must
        // fail the request (ADR-0004 Rules #1-#2).
        let smuggled = Data(#"""
        {"entries":[{"position":1,"baseUrl":"https://a.example/v1","bearer":"sk","codexOauthToken":"leak"}]}
        """#.utf8)
        XCTAssertThrowsError(try decoder.decode(PutProviderChainRequest.self, from: smuggled))

        let smuggledTop = Data(#"""
        {"entries":[],"openaiApiKey":"leak"}
        """#.utf8)
        XCTAssertThrowsError(try decoder.decode(PutProviderChainRequest.self, from: smuggledTop))
    }

    // MARK: - Per-hop probe dispositions (POST /v1/provider/link/test)

    func testProbeHopDispositionsMatchTheRuntimeRule() async {
        let hop = ProviderCascadeHop(
            position: 1, source: .chain, baseURL: "https://a.example/v1",
            bearer: "sk-a", mode: .externalHermes, enabled: true
        )
        let ok = await ProviderLinkRoutes.probeHop(
            hop, using: StubProbe(.init(ok: true, reason: nil)))
        XCTAssertTrue(ok.result.ok)
        XCTAssertEqual(ok.disposition, .ok)

        let unreachable = await ProviderLinkRoutes.probeHop(
            hop, using: StubProbe(.init(ok: false, reason: "provider_unreachable")))
        XCTAssertEqual(unreachable.disposition, .fallOver)

        let rateLimited = await ProviderLinkRoutes.probeHop(
            hop, using: StubProbe(.init(ok: false, reason: "provider_rate_limited")))
        XCTAssertEqual(rateLimited.disposition, .fallOver)

        let serverError = await ProviderLinkRoutes.probeHop(
            hop, using: StubProbe(.init(ok: false, reason: "provider_status_502")))
        XCTAssertEqual(serverError.disposition, .fallOver)

        let authFailed = await ProviderLinkRoutes.probeHop(
            hop, using: StubProbe(.init(ok: false, reason: "provider_auth_failed")))
        XCTAssertEqual(authFailed.disposition, .propagate,
                       "a bad key must not advertise a fall-over")
    }

    func testDisabledHopIsSkippedAndNeverProbed() async {
        let parked = ProviderCascadeHop(
            position: 1, source: .chain, baseURL: "https://a.example/v1",
            bearer: "sk-a", mode: .externalHermes, enabled: false
        )
        let probe = StubProbe(.init(ok: true, reason: nil))
        let outcome = await ProviderLinkRoutes.probeHop(parked, using: probe)
        XCTAssertEqual(outcome.disposition, .skipped)
        XCTAssertEqual(outcome.result.reason, "hop_disabled")
        XCTAssertEqual(probe.calls.withLock { $0 }, 0, "a parked hop must not be probed")
    }

    func testMockModeAndBlankBearerReportConfigurationRatherThanFallOver() async {
        let mockMode = ProviderCascadeHop(
            position: 0, source: .environment, baseURL: "https://a.example/v1",
            bearer: "sk-a", mode: .localMock, enabled: true
        )
        let mockOutcome = await ProviderLinkRoutes.probeHop(
            mockMode, using: StubProbe(.init(ok: true, reason: nil)))
        XCTAssertEqual(mockOutcome.result.reason, "not_external_provider")
        XCTAssertEqual(mockOutcome.disposition, .propagate)

        let blank = ProviderCascadeHop(
            position: 1, source: .chain, baseURL: "https://a.example/v1",
            bearer: "   ", mode: .externalHermes, enabled: true
        )
        let blankOutcome = await ProviderLinkRoutes.probeHop(
            blank, using: StubProbe(.init(ok: true, reason: nil)))
        XCTAssertEqual(blankOutcome.result.reason, "provider_not_configured")
        XCTAssertEqual(blankOutcome.disposition, .propagate)
    }

    // MARK: - ADR-0004: the projection never carries a bearer

    /// The hop label reuses the MOMO-572 `redactedEndpointLabel` contract:
    /// userinfo / query / fragment are stripped, the path is kept, and the bearer
    /// never appears. The worker's mirror copy must produce the identical string
    /// so an audit row and a `/test` entry are comparable for the same hop.
    func testHopEndpointLabelStripsCredentialsAndNeverCarriesTheBearer() {
        let hop = ProviderCascadeHop(
            position: 1, source: .chain,
            baseURL: "https://user:pw@provider.example.net:8443/v1?token=leak#frag",
            bearer: "sk-must-never-appear", mode: .externalHermes, enabled: true
        )
        XCTAssertEqual(hop.endpointLabel, "https://provider.example.net:8443/v1")
        XCTAssertFalse(hop.endpointLabel.contains("pw"))
        XCTAssertFalse(hop.endpointLabel.contains("leak"))
        XCTAssertFalse(hop.endpointLabel.contains("sk-must-never-appear"))
    }

    func testChainEntryDTOExposesOnlyAMaskedTail() throws {
        let dto = ProviderChainEntryDTO(
            position: 1, source: "chain", mode: "external-hermes",
            baseUrl: "https://a.example/v1", endpointLabel: "a.example",
            enabled: true, bearerConfigured: true, bearerUnavailable: false,
            bearerLast4: ProviderLinkCrypto.maskedTail("sk-live-abcdWXYZ"),
            updatedAtMs: 1, updatedBy: nil
        )
        let json = String(decoding: try JSONEncoder().encode(dto), as: UTF8.self)
        XCTAssertTrue(json.contains("WXYZ"))
        XCTAssertFalse(json.contains("sk-live-abcdWXYZ"))
    }

    // MARK: - Helpers

    private func validate(
        _ entries: [PutProviderChainRequest.Entry]
    ) throws -> [ProviderChainEntryInput] {
        try ProviderLinkRoutes.validatedChainEntries(
            entries, environmentName: "local", allowLocalLoopback: false
        )
    }

    private func chainEntry(
        position: Int,
        host: String,
        bearer: String = "sk-chain",
        enabled: Bool = true
    ) -> DecryptedProviderChainEntry {
        DecryptedProviderChainEntry(
            id: UUID(),
            position: position,
            baseURL: "https://\(host).example/v1",
            bearer: bearer,
            mode: .externalHermes,
            enabled: enabled,
            updatedByMemberID: nil,
            updatedAtMs: 1
        )
    }

    private func envConfig() -> AgentProviderConfig {
        AgentProviderConfig(
            mode: .externalHermes,
            hermesBaseURL: "https://env-provider.example.net/v1",
            hermesAPIKey: "env-bearer-abcdef123456",
            model: "env-model",
            agentHandle: "hermes",
            displayName: "Hermes",
            allowLocalLoopback: false
        )
    }
}

/// Records whether it was called, so "a parked hop is never probed" is a
/// measurement rather than an inference.
private final class StubProbe: ProviderHealthProbing, @unchecked Sendable {
    let result: ProviderHealthResult
    let calls = NSLock_Box()

    init(_ result: ProviderHealthResult) { self.result = result }

    func probe(baseURL: String, bearer: String) async -> ProviderHealthResult {
        calls.withLock { $0 += 1 }
        return result
    }
}

/// Tiny lock box so the stub stays Sendable without importing a concurrency helper.
private final class NSLock_Box: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    func withLock<T>(_ body: (inout Int) -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body(&value)
    }
}

// MARK: - MOMO-633 H-1: 인스턴스 전역 스코프의 발급 경계

final class AgentCredentialScopeBoundaryTests: XCTestCase {
    /// `provider:quota:write`는 워크스페이스가 없는 전역 게이지를 덮어쓸 수 있어
    /// provider link와 같은 운영자 경계를 요구한다.
    func testQuotaIngestScopeRequiresInstanceOperator() {
        XCTAssertTrue(
            AgentCredentialRoutes.requiresInstanceOperator(
                scopes: [ProviderQuotaSnapshotRoutes.ingestScope]
            )
        )
        XCTAssertTrue(
            AgentCredentialRoutes.requiresInstanceOperator(
                scopes: ["realtime:subscribe", ProviderQuotaSnapshotRoutes.ingestScope]
            ),
            "다른 스코프와 섞여 들어와도 경계는 걸려야 한다"
        )
    }

    /// 이 단정이 이 파일에서 가장 중요하다. 경계를 스코프가 아니라 **발급 경로
    /// 전체**에 걸면 워크스페이스 admin으로 자격증명을 발급하는 검증기 다섯 개가
    /// 한꺼번에 깨진다. 그 회귀를 DB 없이 잡는다.
    func testOrdinaryScopesStayWorkspaceAdmin() {
        XCTAssertFalse(AgentCredentialRoutes.requiresInstanceOperator(scopes: []))
        XCTAssertFalse(
            AgentCredentialRoutes.requiresInstanceOperator(
                scopes: AgentCredentialRoutes.defaultScopes
            ),
            "기본 스코프는 운영자를 요구하지 않는다"
        )
        XCTAssertFalse(
            AgentCredentialRoutes.requiresInstanceOperator(scopes: ["realtime:subscribe"])
        )
    }

    /// 기본 스코프에 ingest가 섞여 들어오면 모든 발급이 운영자를 요구하게 된다.
    func testIngestScopeIsGrantableButNotDefault() {
        XCTAssertFalse(
            AgentCredentialRoutes.defaultScopes.contains(ProviderQuotaSnapshotRoutes.ingestScope)
        )
        XCTAssertTrue(
            AgentCredentialRoutes.grantableScopes.contains(ProviderQuotaSnapshotRoutes.ingestScope)
        )
    }
}
