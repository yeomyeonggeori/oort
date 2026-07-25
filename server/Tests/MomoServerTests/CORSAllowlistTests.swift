import Foundation
import HTTPTypes
import Hummingbird
import XCTest
@testable import MomoServer

/// MOMO-605 / ADR-0133 P2 — server CORS origin allowlist.
///
/// Everything here is pure-unit: the env parse (`CORSConfig`) and the gate
/// decision (`OriginAllowlistCORSMiddleware.matchedOrigin`). The live wire
/// behaviour (OPTIONS preflight 204 + `Access-Control-Allow-Origin` echo +
/// header-free responses when the knob is unset) is asserted against a booted
/// server by `scripts/verify_cors_allowlist.sh`.
final class CORSAllowlistTests: XCTestCase {
    // MARK: - Default = complete no-change

    func testUnsetEnvironmentDisablesTheSurface() {
        let config = CORSConfig.load(environment: [:])
        XCTAssertFalse(config.isEnabled)
        XCTAssertEqual(config.allowedOrigins, [])
        XCTAssertEqual(config.rejectedEntries, [])
    }

    func testEmptyAndWhitespaceOnlyValuesDisableTheSurface() {
        for raw in ["", "   ", ",", " , ,\t,\n"] {
            let config = CORSConfig.load(environment: [CORSConfig.environmentKey: raw])
            XCTAssertFalse(config.isEnabled, "'\(raw)' must leave CORS off")
            XCTAssertEqual(config.allowedOrigins, [])
            // Blank slots are the documented "off" spelling, never an operator
            // error — they must not produce a boot warning.
            XCTAssertEqual(config.rejectedEntries, [], "'\(raw)' must not be reported as invalid")
        }
    }

    func testEnvironmentKeyIsTheDocumentedName() {
        // The two env templates, both compose files, and the runbooks all spell
        // this exact name; drift here silently disables the desktop client.
        XCTAssertEqual(CORSConfig.environmentKey, "MOMO_CORS_ALLOWED_ORIGINS")
    }

    // MARK: - Parsing the documented Tauri origins

    func testParsesTheDocumentedTauriAndViteOrigins() {
        let config = CORSConfig.parse("tauri://localhost, http://localhost:5173")
        XCTAssertTrue(config.isEnabled)
        XCTAssertEqual(config.allowedOrigins, ["tauri://localhost", "http://localhost:5173"])
        XCTAssertEqual(config.rejectedEntries, [])
    }

    func testAcceptsTheWindowsAndroidTauriOrigin() {
        // Tauri v2 serves the packaged frontend from http://tauri.localhost on
        // Windows/Android and tauri://localhost elsewhere.
        let config = CORSConfig.parse("http://tauri.localhost")
        XCTAssertEqual(config.allowedOrigins, ["http://tauri.localhost"])
    }

    func testNormalizesCaseAndSurroundingWhitespaceAndDeduplicates() {
        let config = CORSConfig.parse("  TAURI://LocalHost  ,\ttauri://localhost , https://App.Example.COM ")
        XCTAssertEqual(config.allowedOrigins, ["tauri://localhost", "https://app.example.com"])
        XCTAssertEqual(config.rejectedEntries, [])
    }

    func testPreservesExplicitPorts() {
        let config = CORSConfig.parse("https://app.example.com:8443,http://127.0.0.1:1420,http://[::1]:5173")
        XCTAssertEqual(
            config.allowedOrigins,
            ["https://app.example.com:8443", "http://127.0.0.1:1420", "http://[::1]:5173"]
        )
    }

    // MARK: - Wildcards and other unsafe entries are refused

    func testWildcardEntriesAreRejected() {
        for wildcard in ["*", "https://*", "https://*.example.com", "*://localhost", "https://ex*mple.com"] {
            let config = CORSConfig.parse(wildcard)
            XCTAssertFalse(config.isEnabled, "wildcard '\(wildcard)' must not enable CORS")
            XCTAssertEqual(config.allowedOrigins, [])
            XCTAssertEqual(config.rejectedEntries, [wildcard])
        }
    }

    func testNullOriginIsRejected() {
        // `Origin: null` is what sandboxed iframes and file:// documents send —
        // allowlisting it would hand any hostile page a valid origin.
        for entry in ["null", "NULL", " null "] {
            let config = CORSConfig.parse(entry)
            XCTAssertFalse(config.isEnabled, "'\(entry)' must not enable CORS")
        }
    }

    func testMalformedOriginsAreRejected() {
        let malformed = [
            "example.com",                        // no scheme
            "https://",                           // no host
            "https://app.example.com/",           // trailing slash (common typo)
            "https://app.example.com/v1",         // path
            "https://app.example.com?x=1",        // query
            "https://app.example.com#frag",       // fragment
            "https://user@app.example.com",       // userinfo
            "https://app.example.com:0",          // port out of range
            "https://app.example.com:99999",      // port out of range
            "https://app.example.com:",           // empty port
            "https://app.example.com:+80",        // non-digit port
            "https://app.example.com:80:81",      // two ports
            "https://.example.com",               // empty label
            "https://app..example.com",           // empty label
            "https://app example.com",            // whitespace inside
            "1https://example.com",               // scheme must start with a letter
            "https:/example.com",                 // malformed separator
        ]
        for entry in malformed {
            let config = CORSConfig.parse(entry)
            XCTAssertFalse(config.isEnabled, "'\(entry)' must not enable CORS")
            XCTAssertEqual(config.rejectedEntries, [entry], "'\(entry)' must be reported to the operator")
        }
    }

    func testOneBadEntryDoesNotDropTheGoodOnes() {
        let config = CORSConfig.parse("tauri://localhost, https://*.example.com, http://localhost:5173")
        XCTAssertEqual(config.allowedOrigins, ["tauri://localhost", "http://localhost:5173"])
        XCTAssertEqual(config.rejectedEntries, ["https://*.example.com"])
    }

    func testNormalizedOriginNeverReturnsAWildcard() {
        // Belt and braces: whatever survives normalization is a concrete origin,
        // so `Access-Control-Allow-Origin: *` is unrepresentable.
        let config = CORSConfig.parse("tauri://localhost,https://app.example.com,*")
        XCTAssertFalse(config.allowedOrigins.contains("*"))
        XCTAssertTrue(config.allowedOrigins.allSatisfy { !$0.contains("*") })
    }

    // MARK: - Gate decision (middleware no-op vs CORS)

    private static let allowlist: Set<String> = ["tauri://localhost", "http://localhost:5173"]

    func testRequestWithoutOriginIsAlwaysANoOp() {
        // Native macOS/iOS clients, curl, the work host, and the Centrifugo
        // subscribe proxy never send Origin — their behaviour must not change.
        XCTAssertNil(OriginAllowlistCORSMiddleware.matchedOrigin(
            originHeader: nil, allowedOrigins: Self.allowlist
        ))
    }

    func testAllowlistedOriginMatches() {
        XCTAssertEqual(
            OriginAllowlistCORSMiddleware.matchedOrigin(
                originHeader: "tauri://localhost", allowedOrigins: Self.allowlist
            ),
            "tauri://localhost"
        )
        XCTAssertEqual(
            OriginAllowlistCORSMiddleware.matchedOrigin(
                originHeader: "http://localhost:5173", allowedOrigins: Self.allowlist
            ),
            "http://localhost:5173"
        )
    }

    func testUnknownOriginsDoNotMatch() {
        for origin in [
            "https://evil.example.com",
            "tauri://localhost.evil.com",
            "http://localhost:5174",
            "http://localhost",              // port is part of the origin
            "https://localhost:5173",        // scheme is part of the origin
            "null",
            "*",
            "",
        ] {
            XCTAssertNil(
                OriginAllowlistCORSMiddleware.matchedOrigin(
                    originHeader: origin, allowedOrigins: Self.allowlist
                ),
                "'\(origin)' must not be treated as allowlisted"
            )
        }
    }

    func testCaseInsensitiveOriginHeaderStillMatches() {
        // Browsers send lowercase, but matching must not hinge on that.
        XCTAssertEqual(
            OriginAllowlistCORSMiddleware.matchedOrigin(
                originHeader: "TAURI://LOCALHOST", allowedOrigins: Self.allowlist
            ),
            "tauri://localhost"
        )
    }

    func testEmptyAllowlistNeverMatches() {
        XCTAssertNil(OriginAllowlistCORSMiddleware.matchedOrigin(
            originHeader: "tauri://localhost", allowedOrigins: []
        ))
    }

    // MARK: - Header policy constants

    func testPreflightPolicyCoversTheRestSurfaceWithoutCredentials() {
        let methods = OriginAllowlistCORSMiddleware.allowedMethods.map(\.rawValue)
        for method in ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] {
            XCTAssertTrue(methods.contains(method), "preflight must advertise \(method)")
        }
        let headers = OriginAllowlistCORSMiddleware.allowedRequestHeaders.map(\.canonicalName)
        XCTAssertTrue(headers.contains("authorization"), "bearer auth needs the Authorization header")
        XCTAssertTrue(headers.contains("content-type"), "JSON bodies need Content-Type")
        // Retry-After is unreadable by the browser on a 429 unless exposed.
        XCTAssertEqual(OriginAllowlistCORSMiddleware.exposedResponseHeaders, ["Retry-After"])
        XCTAssertGreaterThan(OriginAllowlistCORSMiddleware.preflightMaxAgeSeconds, 0)
    }
}
