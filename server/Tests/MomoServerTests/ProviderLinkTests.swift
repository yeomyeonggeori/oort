import Foundation
import XCTest
@testable import MomoServer

/// MOMO-572 / ADR-0004 증보 1 — provider_link crypto, masking, DB>env mode
/// override precedence, and fail-closed resolution. All pure-unit (no DB).
final class ProviderLinkTests: XCTestCase {
    private let masterKey = "operator-provider-link-master-key-01"

    // MARK: - Crypto roundtrip

    func testSealOpenRoundtrip() throws {
        let bearer = "sk-live-9f3a2b7c1d8e4f60aa11"
        let ciphertext = try ProviderLinkCrypto.seal(bearer, masterKey: masterKey)
        // Versioned envelope, and the plaintext must not appear in the bytes.
        XCTAssertEqual(ciphertext.first, ProviderLinkCrypto.version)
        XCTAssertFalse(
            ciphertext.range(of: Data(bearer.utf8)) != nil,
            "plaintext bearer must never appear in the ciphertext"
        )
        let recovered = try ProviderLinkCrypto.open(ciphertext, masterKey: masterKey)
        XCTAssertEqual(recovered, bearer)
    }

    func testSealTrimsAndRejectsEmpty() throws {
        let ciphertext = try ProviderLinkCrypto.seal("  padded-secret-value  ", masterKey: masterKey)
        XCTAssertEqual(try ProviderLinkCrypto.open(ciphertext, masterKey: masterKey), "padded-secret-value")
        XCTAssertThrowsError(try ProviderLinkCrypto.seal("   ", masterKey: masterKey)) { error in
            XCTAssertEqual(error as? ProviderLinkCrypto.CryptoError, .emptyPlaintext)
        }
    }

    func testOpenWithWrongKeyFails() throws {
        let ciphertext = try ProviderLinkCrypto.seal("sk-live-secret-12345678", masterKey: masterKey)
        XCTAssertThrowsError(try ProviderLinkCrypto.open(ciphertext, masterKey: "a-different-master-key"))
    }

    func testOpenRejectsTamperedCiphertext() throws {
        var ciphertext = try ProviderLinkCrypto.seal("sk-live-secret-12345678", masterKey: masterKey)
        // Flip a byte in the AES-GCM body — the tag check must fail.
        let flipIndex = ciphertext.count - 1
        ciphertext[flipIndex] ^= 0xFF
        XCTAssertThrowsError(try ProviderLinkCrypto.open(ciphertext, masterKey: masterKey))
    }

    func testOpenRejectsBadVersion() {
        let bogus = Data([0x99, 0x00, 0x01, 0x02])
        XCTAssertThrowsError(try ProviderLinkCrypto.open(bogus, masterKey: masterKey)) { error in
            XCTAssertEqual(error as? ProviderLinkCrypto.CryptoError, .badVersion)
        }
    }

    // MARK: - Masking

    func testMaskedTailOnlyExposesLastFour() {
        XCTAssertEqual(ProviderLinkCrypto.maskedTail("sk-live-abcdWXYZ"), "WXYZ")
        // Short secrets are fully masked (never leak a whole short token).
        XCTAssertNil(ProviderLinkCrypto.maskedTail("short"))
        XCTAssertNil(ProviderLinkCrypto.maskedTail(""))
    }

    // MARK: - DB > env resolution

    private func envConfig(
        mode: AgentProviderMode = .externalHermes,
        baseURL: String = "https://env-provider.example.net/v1",
        key: String = "env-bearer-abcdef123456"
    ) -> AgentProviderConfig {
        AgentProviderConfig(
            mode: mode,
            hermesBaseURL: baseURL,
            hermesAPIKey: key,
            model: "env-model",
            agentHandle: "hermes",
            displayName: "Hermes",
            allowLocalLoopback: false
        )
    }

    func testDatabaseLinkOverridesEnvWhenUsable() {
        let env = envConfig()
        let link = DecryptedProviderLink(
            baseURL: "https://db-provider.example.com/v1",
            bearer: "db-bearer-zzz99988877766",
            mode: .externalHermes,
            updatedByMemberID: nil,
            updatedAtMs: 1
        )
        let resolved = ProviderLinkResolver.resolve(env: env, link: link)
        XCTAssertEqual(resolved.source, .database)
        XCTAssertEqual(resolved.config.hermesBaseURL, "https://db-provider.example.com/v1")
        XCTAssertEqual(resolved.config.hermesAPIKey, "db-bearer-zzz99988877766")
        // Env still supplies model/handle/display-name.
        XCTAssertEqual(resolved.config.model, "env-model")
        XCTAssertEqual(resolved.config.displayName, "Hermes")
    }

    func testUnusableDatabaseLinkFallsBackToEnv() {
        let env = envConfig()
        let emptyBearer = DecryptedProviderLink(
            baseURL: "https://db-provider.example.com/v1",
            bearer: "   ",
            mode: .externalHermes,
            updatedByMemberID: nil,
            updatedAtMs: 1
        )
        let resolved = ProviderLinkResolver.resolve(env: env, link: emptyBearer)
        XCTAssertEqual(resolved.source, .environment)
        XCTAssertEqual(resolved.config.hermesBaseURL, env.hermesBaseURL)
        XCTAssertEqual(resolved.config.hermesAPIKey, env.hermesAPIKey)
    }

    func testNilLinkUsesEnv() {
        let env = envConfig()
        let resolved = ProviderLinkResolver.resolve(env: env, link: nil)
        XCTAssertEqual(resolved.source, .environment)
    }

    // MARK: - Fail-closed

    func testResolvedConfigStaysFailClosedWhenBothInvalidInStrictEnv() {
        // Env is misconfigured (empty URL) and there is no usable DB link.
        let env = envConfig(baseURL: "", key: "")
        let resolved = ProviderLinkResolver.resolve(env: env, link: nil)
        XCTAssertEqual(resolved.source, .environment)
        let errors = resolved.config.validationErrors(strictEnvironment: true)
        XCTAssertFalse(errors.isEmpty, "invalid provider config must surface fail-closed diagnostics")
    }

    func testValidDatabaseLinkClearsDiagnostics() {
        let env = envConfig(baseURL: "", key: "")   // env alone would be invalid
        let link = DecryptedProviderLink(
            baseURL: "https://db-provider.example.com/v1",
            bearer: "db-bearer-zzz99988877766",
            mode: .externalHermes,
            updatedByMemberID: nil,
            updatedAtMs: 1
        )
        let resolved = ProviderLinkResolver.resolve(env: env, link: link)
        XCTAssertEqual(resolved.source, .database)
        XCTAssertTrue(
            resolved.config.validationErrors(strictEnvironment: true).isEmpty,
            "a valid DB link must satisfy strict validation even when env is empty"
        )
    }

    // MARK: - Closed-world PUT body (ADR-0004 Rules #1-#2)

    func testPutRequestRejectsUnknownAndOAuthShapedFields() {
        let decoder = JSONDecoder()
        let codexField = #"{"baseUrl":"https://p.example.com/v1","bearer":"x","codex_oauth_token":"leak"}"#
        XCTAssertThrowsError(
            try decoder.decode(PutProviderLinkRequest.self, from: Data(codexField.utf8))
        )
        let apiKeyField = #"{"baseUrl":"https://p.example.com/v1","bearer":"x","openai_api_key":"leak"}"#
        XCTAssertThrowsError(
            try decoder.decode(PutProviderLinkRequest.self, from: Data(apiKeyField.utf8))
        )
    }

    func testPutRequestAcceptsAllowedFields() throws {
        let decoder = JSONDecoder()
        let body = #"{"baseUrl":"https://p.example.com/v1","bearer":"sk-live-x","mode":"external-hermes"}"#
        let dto = try decoder.decode(PutProviderLinkRequest.self, from: Data(body.utf8))
        XCTAssertEqual(dto.baseUrl, "https://p.example.com/v1")
        XCTAssertEqual(dto.mode, "external-hermes")
    }

    // MARK: - mode parsing

    func testResolvedModeDefaultsToExternalAndRejectsGarbage() throws {
        XCTAssertEqual(try ProviderLinkRoutes.resolvedMode(nil), .externalHermes)
        XCTAssertEqual(try ProviderLinkRoutes.resolvedMode("  "), .externalHermes)
        XCTAssertEqual(try ProviderLinkRoutes.resolvedMode("external-hermes"), .externalHermes)
        XCTAssertEqual(try ProviderLinkRoutes.resolvedMode("local-mock"), .localMock)
        XCTAssertThrowsError(try ProviderLinkRoutes.resolvedMode("nonsense"))
    }
}
