import Foundation
import Logging
import XCTest
@testable import AgentWorker

/// MOMO-573 / ADR-0004 증보 1 P-1b — job-time provider_link resolution in the
/// worker: crypto interop with the server, DB-over-env precedence, and the
/// short-TTL cache (fresh reuse, decrypt-skip-on-unchanged, next-job reflection of
/// a change, and fail-safe fallback).
final class ProviderLinkResolutionTests: XCTestCase {
    private let logger = Logger(label: "test")

    // MARK: - Crypto (must interop with the server copy)

    func testCryptoRoundTrip() throws {
        let key = "master-key-under-test"
        let cipher = try ProviderLinkCrypto.seal("sk-live-abcd1234", masterKey: key)
        XCTAssertEqual(cipher.first, ProviderLinkCrypto.version)
        XCTAssertEqual(try ProviderLinkCrypto.open(cipher, masterKey: key), "sk-live-abcd1234")
    }

    func testCryptoTrimsAndRejectsEmpty() throws {
        let key = "k"
        let cipher = try ProviderLinkCrypto.seal("  padded-secret-value  ", masterKey: key)
        XCTAssertEqual(try ProviderLinkCrypto.open(cipher, masterKey: key), "padded-secret-value")
        XCTAssertThrowsError(try ProviderLinkCrypto.seal("   ", masterKey: key)) { error in
            XCTAssertEqual(error as? ProviderLinkCrypto.CryptoError, .emptyPlaintext)
        }
    }

    func testCryptoWrongKeyFails() throws {
        let cipher = try ProviderLinkCrypto.seal("sk-live-secret-12345678", masterKey: "key-a")
        XCTAssertThrowsError(try ProviderLinkCrypto.open(cipher, masterKey: "key-b"))
    }

    func testCryptoBadVersionRejected() {
        let bogus = Data([0x02, 0x00, 0x01, 0x02])
        XCTAssertThrowsError(try ProviderLinkCrypto.open(bogus, masterKey: "k")) { error in
            XCTAssertEqual(error as? ProviderLinkCrypto.CryptoError, .badVersion)
        }
    }

    /// Golden cross-implementation vector: this ciphertext was sealed OUTSIDE Swift
    /// (Python AES-256-GCM) using the exact ADR-0004 key derivation
    /// (`SHA256("momo.provider_link.key.v1\n" || masterKey)`) and framing
    /// (`0x01 || nonce(12) || ct || tag(16)`). If the worker's key derivation,
    /// version byte, or framing ever drifts from that contract — the same contract
    /// the server's `ProviderLinkCrypto` implements — GCM authentication fails and
    /// this test breaks. That is the guard that keeps the two independent copies
    /// (server + worker) able to decrypt each other's bearers.
    func testGoldenInteropVector() throws {
        let hex =
            "01000102030405060708090a0bf9342d112983521d00ae010fd29ce841c5f1c7c9e1e490012f3494213fe1ac175ca8f2e55d029a0762e8"
        let data = Data(hexEncoded: hex)!
        let recovered = try ProviderLinkCrypto.open(data, masterKey: "test-master-key-vector-0004")
        XCTAssertEqual(recovered, "sk-live-golden-vector-0573")
    }

    // MARK: - Precedence (pure)

    func testTransportOverridePrefersUsableLink() {
        let link = DecryptedProviderLink(
            baseURL: "https://provider.example/v1", bearer: "sk-xyz", mode: .externalHermes,
            updatedAtMs: 1)
        let override = ProviderLinkResolution.transportOverride(link: link)
        XCTAssertEqual(override?.baseURL, "https://provider.example/v1")
        XCTAssertEqual(override?.bearer, "sk-xyz")
    }

    func testTransportOverrideFallsBackWhenNilOrUnusable() {
        XCTAssertNil(ProviderLinkResolution.transportOverride(link: nil))
        let blankURL = DecryptedProviderLink(
            baseURL: "   ", bearer: "sk-xyz", mode: .externalHermes, updatedAtMs: 1)
        XCTAssertNil(ProviderLinkResolution.transportOverride(link: blankURL))
        let blankBearer = DecryptedProviderLink(
            baseURL: "https://p/v1", bearer: "", mode: .externalHermes, updatedAtMs: 1)
        XCTAssertNil(ProviderLinkResolution.transportOverride(link: blankBearer))
    }

    // MARK: - Store decrypt

    func testStoreDecryptRoundTripAndFailureIsNil() throws {
        let key = "master-key"
        let cipher = try ProviderLinkCrypto.seal("sk-store-9999", masterKey: key)
        let stored = StoredProviderLink(
            baseURL: "https://p/v1", bearerCiphertext: cipher, mode: "external-hermes",
            updatedAtMs: 42)
        let good = WorkerProviderLinkStore.decrypt(stored, masterKey: key)
        XCTAssertEqual(good?.bearer, "sk-store-9999")
        XCTAssertEqual(good?.mode, .externalHermes)
        XCTAssertEqual(good?.updatedAtMs, 42)
        // Wrong key ⇒ nil (fall back to env, never crash).
        XCTAssertNil(WorkerProviderLinkStore.decrypt(stored, masterKey: "other-key"))
    }

    // MARK: - Cache behavior (injected reader + clock)

    private func stored(_ bearer: String, url: String = "https://p/v1", updatedAtMs: Int64) throws
        -> StoredProviderLink
    {
        StoredProviderLink(
            baseURL: url,
            bearerCiphertext: try ProviderLinkCrypto.seal(bearer, masterKey: Self.key),
            mode: "external-hermes",
            updatedAtMs: updatedAtMs)
    }

    private static let key = "cache-master-key"

    func testCacheServesFreshWithinTTLWithoutRereading() async throws {
        let reader = FakeLinkReader([.success(try stored("sk-1", updatedAtMs: 100))])
        let cache = ProviderLinkCache()
        let t0 = ContinuousClock.now
        let l1 = await cache.resolve(
            masterKey: Self.key, ttl: .milliseconds(1000), now: t0, logger: logger,
            read: { try await reader.next() })
        let l2 = await cache.resolve(
            masterKey: Self.key, ttl: .milliseconds(1000),
            now: t0.advanced(by: .milliseconds(500)), logger: logger,
            read: { try await reader.next() })
        XCTAssertEqual(l1?.bearer, "sk-1")
        XCTAssertEqual(l2?.bearer, "sk-1")
        let calls = await reader.callCount()
        XCTAssertEqual(calls, 1, "within TTL must not re-read the DB")
    }

    func testCacheReflectsChangeOnNextJobAfterTTL() async throws {
        let reader = FakeLinkReader([
            .success(try stored("sk-old", url: "https://old/v1", updatedAtMs: 100)),
            .success(try stored("sk-new", url: "https://new/v1", updatedAtMs: 200)),
        ])
        let cache = ProviderLinkCache()
        let t0 = ContinuousClock.now
        let l1 = await cache.resolve(
            masterKey: Self.key, ttl: .milliseconds(1000), now: t0, logger: logger,
            read: { try await reader.next() })
        let l2 = await cache.resolve(
            masterKey: Self.key, ttl: .milliseconds(1000),
            now: t0.advanced(by: .milliseconds(1500)), logger: logger,
            read: { try await reader.next() })
        XCTAssertEqual(l1?.bearer, "sk-old")
        XCTAssertEqual(l2?.bearer, "sk-new")
        XCTAssertEqual(l2?.baseURL, "https://new/v1")
        let calls = await reader.callCount()
        XCTAssertEqual(calls, 2)
    }

    func testCacheReusesWhenUnchangedAfterTTL() async throws {
        let reader = FakeLinkReader([
            .success(try stored("sk-same", updatedAtMs: 100)),
            .success(try stored("sk-same", updatedAtMs: 100)),
        ])
        let cache = ProviderLinkCache()
        let t0 = ContinuousClock.now
        let l1 = await cache.resolve(
            masterKey: Self.key, ttl: .milliseconds(1000), now: t0, logger: logger,
            read: { try await reader.next() })
        let l2 = await cache.resolve(
            masterKey: Self.key, ttl: .milliseconds(1000),
            now: t0.advanced(by: .milliseconds(1500)), logger: logger,
            read: { try await reader.next() })
        XCTAssertEqual(l1?.bearer, "sk-same")
        XCTAssertEqual(l2?.bearer, "sk-same")
        let calls = await reader.callCount()
        XCTAssertEqual(calls, 2, "TTL expiry re-reads (but decrypt is skipped)")
    }

    func testCacheRowAbsentFallsBackToEnv() async throws {
        let reader = FakeLinkReader([.success(nil)])
        let cache = ProviderLinkCache()
        let link = await cache.resolve(
            masterKey: Self.key, ttl: .milliseconds(1000), now: ContinuousClock.now,
            logger: logger, read: { try await reader.next() })
        XCTAssertNil(link)
    }

    func testCacheUnusableRowFallsBackToEnv() async throws {
        let reader = FakeLinkReader([.success(try stored("sk-x", url: "   ", updatedAtMs: 100))])
        let cache = ProviderLinkCache()
        let link = await cache.resolve(
            masterKey: Self.key, ttl: .milliseconds(1000), now: ContinuousClock.now,
            logger: logger, read: { try await reader.next() })
        XCTAssertNil(link, "blank base_url ⇒ unusable ⇒ env fallback")
    }

    func testCacheUndecryptableRowFallsBackToEnv() async throws {
        // Sealed with a different key than resolve uses ⇒ open fails ⇒ env.
        let cipher = try ProviderLinkCrypto.seal("sk-secret", masterKey: "sealing-key")
        let row = StoredProviderLink(
            baseURL: "https://p/v1", bearerCiphertext: cipher, mode: "external-hermes",
            updatedAtMs: 100)
        let reader = FakeLinkReader([.success(row)])
        let cache = ProviderLinkCache()
        let link = await cache.resolve(
            masterKey: "resolving-key", ttl: .milliseconds(1000), now: ContinuousClock.now,
            logger: logger, read: { try await reader.next() })
        XCTAssertNil(link)
    }

    func testCacheDBErrorRetainsLastKnown() async throws {
        let reader = FakeLinkReader([
            .success(try stored("sk-known", updatedAtMs: 100)),
            .failure(FakeDBError()),
        ])
        let cache = ProviderLinkCache()
        let t0 = ContinuousClock.now
        let l1 = await cache.resolve(
            masterKey: Self.key, ttl: .milliseconds(1000), now: t0, logger: logger,
            read: { try await reader.next() })
        let l2 = await cache.resolve(
            masterKey: Self.key, ttl: .milliseconds(1000),
            now: t0.advanced(by: .milliseconds(1500)), logger: logger,
            read: { try await reader.next() })
        XCTAssertEqual(l1?.bearer, "sk-known")
        XCTAssertEqual(l2?.bearer, "sk-known", "transient DB error must retain last-known, not blank")
        let calls = await reader.callCount()
        XCTAssertEqual(calls, 2)
    }

    // MARK: - Wiring guard

    /// Locks the invoke site to the job-time-resolved transport so a future refactor
    /// cannot silently revert to the boot-time env transport (the bug this closes).
    func testWorkerServiceUsesResolvedTransportAtInvokeSite() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/AgentWorker/WorkerService.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        XCTAssertTrue(source.contains("resolveTransport()"))
        XCTAssertTrue(source.contains("effectiveHermes.invoke("))
        XCTAssertFalse(
            source.contains("let stream = hermes.invoke("),
            "the turn must use the job-time-resolved transport, not the boot env transport")
    }
}

private struct FakeDBError: Error {}

/// Sendable stub reader that returns a queued sequence of results (repeating the
/// last one) and records how many times it was called.
private actor FakeLinkReader {
    private let responses: [Result<StoredProviderLink?, Error>]
    private var calls = 0
    init(_ responses: [Result<StoredProviderLink?, Error>]) { self.responses = responses }
    func next() throws -> StoredProviderLink? {
        calls += 1
        let idx = min(calls - 1, responses.count - 1)
        return try responses[idx].get()
    }
    func callCount() -> Int { calls }
}

extension Data {
    fileprivate init?(hexEncoded hex: String) {
        guard hex.count % 2 == 0 else { return nil }
        var out = Data(capacity: hex.count / 2)
        var idx = hex.startIndex
        while idx < hex.endIndex {
            let next = hex.index(idx, offsetBy: 2)
            guard let byte = UInt8(hex[idx..<next], radix: 16) else { return nil }
            out.append(byte)
            idx = next
        }
        self = out
    }
}
