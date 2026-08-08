import HTTPTypes
import Hummingbird
import NIOCore

// =============================================================================
// MOMO-605 / ADR-0133 P2 — CORS origin allowlist.
//
// The web client is served same-origin (Caddy serves the SPA and proxies
// `/v1/*` on the one APP_DOMAIN site — ADR-0119 D1-A), so it never needed CORS.
// A packaged Tauri desktop build cannot use that trick: its frontend is loaded
// from a webview-owned origin (`tauri://localhost`, or `http://tauri.localhost`
// on Windows/Android) while the API lives on a real host, so every `/v1/*` call
// is cross-origin and the webview enforces CORS exactly like a browser.
//
// Contract:
//   * OFF BY DEFAULT. `Config.cors.isEnabled` is false unless
//     `MOMO_CORS_ALLOWED_ORIGINS` names at least one valid origin, and
//     `AppBuilder` then never mounts this middleware. An unconfigured server is
//     byte-for-byte the pre-MOMO-605 server: no `Access-Control-*`, no `Vary`,
//     no OPTIONS short-circuit.
//   * EXACT MATCH ONLY. The inbound `Origin` is normalized (RFC 6454 §6.1
//     serialization, ASCII-lowercased) and must equal an allowlist entry.
//     `CORSConfig` refuses wildcard and `null` entries at parse time, so
//     `Access-Control-Allow-Origin: *` can never be produced.
//   * NO CREDENTIALS. oort carries its session in the `Authorization` bearer
//     header and sets no cookies, so `Access-Control-Allow-Credentials` is never
//     sent — clients must use `credentials: "omit"` (the fetch default) and
//     attach the token header themselves. This keeps the dangerous
//     `Allow-Origin: *` + `Allow-Credentials: true` pair unrepresentable, and
//     means a hostile page cannot ride ambient credentials even if an operator
//     allowlists a wrong origin.
//   * UNKNOWN ORIGINS ARE PASSED THROUGH UNCHANGED, not rejected with a 403.
//     The response simply carries no CORS headers, so the browser blocks it
//     while non-browser callers (macOS/iOS clients, curl, the work host, the
//     Centrifugo subscribe proxy) keep their existing behaviour — none of them
//     send `Origin`.
//
// Mount order (see `AppBuilder`): request log → CORS → per-IP rate limit. CORS
// sits OUTSIDE the limiter so a 429 still carries `Access-Control-Allow-Origin`
// (otherwise the browser reports an opaque network error instead of the real
// rate-limit response), and an allowlisted preflight short-circuits before it
// spends limiter budget.
// =============================================================================

/// Wraps Hummingbird's `CORSMiddleware` with an exact-match origin allowlist.
///
/// Hummingbird's own `.originBased` mode echoes *any* origin, and its
/// `.oneOf(_:)` allowlist is variadic-only so it cannot be built from a runtime
/// env value. This type supplies the allowlist decision and delegates the header
/// mechanics (preflight 204, `Vary`, error-path headers via `EditedHTTPError`)
/// to the upstream implementation, which is only ever reached for an origin we
/// already accepted.
struct OriginAllowlistCORSMiddleware: RouterMiddleware {
    typealias Context = AppRequestContext

    /// Normalized origins allowed to make cross-origin calls (never empty when
    /// mounted, never containing a wildcard).
    let allowedOrigins: Set<String>

    private let inner: CORSMiddleware<AppRequestContext>

    /// Headers a browser may send on an allowlisted cross-origin request.
    /// Fixed on purpose — reflecting `Access-Control-Request-Headers` back would
    /// make the allowance unbounded.
    static let allowedRequestHeaders: [HTTPField.Name] = [
        .accept, .authorization, .contentType, .origin,
    ]

    /// Methods the oort REST surface actually routes.
    static let allowedMethods: [HTTPRequest.Method] = [
        .get, .post, .put, .patch, .delete, .options,
    ]

    /// Response headers a browser may read. `Retry-After` accompanies the
    /// MOMO-300 429 and is useless to the client unless exposed.
    static let exposedResponseHeaders = ["Retry-After"]

    /// Preflight cache lifetime. Short enough that an allowlist change takes
    /// effect within one restart cycle of operator patience.
    static let preflightMaxAgeSeconds: Int64 = 600

    init(allowedOrigins: [String]) {
        self.allowedOrigins = Set(allowedOrigins)
        self.inner = CORSMiddleware(
            allowOrigin: .originBased,
            allowHeaders: Self.allowedRequestHeaders,
            allowMethods: Self.allowedMethods,
            allowCredentials: false,
            exposedHeaders: Self.exposedResponseHeaders,
            maxAge: .seconds(Self.preflightMaxAgeSeconds)
        )
    }

    /// The single gate decision, split out so it is unit-testable without a
    /// live `Channel`/`RequestContext`: returns the normalized origin when the
    /// request must receive CORS headers, nil when the middleware has to be a
    /// no-op. `nil` covers "no Origin header" (every native oort client) and
    /// "origin not on the allowlist" alike.
    static func matchedOrigin(
        originHeader: String?,
        allowedOrigins: Set<String>
    ) -> String? {
        guard !allowedOrigins.isEmpty,
              let originHeader,
              let origin = CORSConfig.normalizedOrigin(originHeader),
              allowedOrigins.contains(origin)
        else { return nil }
        return origin
    }

    func handle(
        _ request: Request,
        context: Context,
        next: (Request, Context) async throws -> Response
    ) async throws -> Response {
        guard Self.matchedOrigin(
            originHeader: request.headers[.origin],
            allowedOrigins: allowedOrigins
        ) != nil else {
            // No Origin (every native oort client), or an origin we do not
            // trust: behave exactly as if this middleware were absent.
            return try await next(request, context)
        }
        return try await inner.handle(request, context: context, next: next)
    }
}
