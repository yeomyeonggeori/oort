import Foundation
import HTTPTypes
import Hummingbird
import Logging
import NIOCore
import PostgresNIO

// =============================================================================
// MOMO-300 rate limiting — per-member + per-IP, in-memory sliding window.
//
// v0 contract (documented):
//   * Single-node, in-process state. Counters reset on restart and are NOT
//     shared across API replicas. Good enough for the v0 single-host topology
//     (L4 §1.1); replace with a shared store before scaling out.
//   * Sliding-window log: each key keeps its request timestamps inside the
//     window. Memory is bounded by (active keys × limit).
//   * Excluded paths: `/health` (liveness must never 429) and
//     `/v1/centrifugo/subscribe` (internal Centrifugo callbacks funnel through
//     one IP and carry their own shared-secret auth).
//   * On limit: 429 + `Retry-After`. Only MEMBER-axis violations write the
//     `audit_log` row (`rate_limit.exceeded`, one per key per burst). Per-IP
//     violations are NEVER audit-persisted — regardless of whether the caller
//     is authenticated — because this middleware runs globally BEFORE
//     AuthMiddleware, so no principal/tenant exists at that point
//     (audit_log.workspace_id is NOT NULL by schema). They surface in the
//     server log only.
//   * Entirely independent from the cost circuit breaker (budget_window):
//     rate limits shed request floods; the cost breaker caps model spend.
// =============================================================================

/// Sliding-window request limiter. One instance is shared by the per-IP and
/// per-member middlewares (keys are namespaced `ip:`/`member:`).
actor SlidingWindowRateLimiter {
    struct Verdict: Sendable {
        let allowed: Bool
        /// Seconds until the oldest counted request leaves the window.
        let retryAfterSeconds: Int
        /// True for the first rejection of this key in the current burst —
        /// callers use it to write exactly one audit row per overload burst.
        let shouldAudit: Bool
    }

    private struct Bucket {
        var timestamps: [Date] = []
        var audited = false
    }

    private var buckets: [String: Bucket] = [:]
    private var callsSinceSweep = 0

    func check(key: String, limit: Int, windowSeconds: Int, now: Date = Date()) -> Verdict {
        guard limit > 0 else {
            return Verdict(allowed: true, retryAfterSeconds: 0, shouldAudit: false)
        }
        sweepIfNeeded(now: now, windowSeconds: windowSeconds)

        var bucket = buckets[key] ?? Bucket()
        let cutoff = now.addingTimeInterval(-TimeInterval(windowSeconds))
        bucket.timestamps.removeAll { $0 <= cutoff }

        if bucket.timestamps.count >= limit {
            let oldest = bucket.timestamps.first ?? now
            let retryAfter = max(1, Int(oldest.timeIntervalSince(cutoff).rounded(.up)))
            let shouldAudit = !bucket.audited
            bucket.audited = true
            buckets[key] = bucket
            return Verdict(allowed: false, retryAfterSeconds: retryAfter, shouldAudit: shouldAudit)
        }

        bucket.timestamps.append(now)
        bucket.audited = false
        buckets[key] = bucket
        return Verdict(allowed: true, retryAfterSeconds: 0, shouldAudit: false)
    }

    /// Drop buckets whose entries all fell out of the window (memory bound).
    private func sweepIfNeeded(now: Date, windowSeconds: Int) {
        callsSinceSweep += 1
        guard callsSinceSweep >= 4096 else { return }
        callsSinceSweep = 0
        let cutoff = now.addingTimeInterval(-TimeInterval(windowSeconds))
        buckets = buckets.filter { _, bucket in
            bucket.timestamps.contains { $0 > cutoff }
        }
    }
}

enum RateLimitSupport {
    /// Paths never rate limited (see file header).
    static let excludedPaths: Set<String> = ["/health", "/v1/centrifugo/subscribe"]

    static let xForwardedFor = HTTPField.Name("X-Forwarded-For")!
    static let retryAfter = HTTPField.Name("Retry-After")!

    /// Client IP for limiting: first `X-Forwarded-For` hop when present
    /// (Caddy/reverse-proxy deploys), else the socket peer address.
    /// v0 caveat (documented): a direct-exposed API trusts the header as-is.
    static func clientIP(request: Request, context: AppRequestContext) -> String? {
        if let forwarded = request.headers[xForwardedFor] {
            let first = forwarded.split(separator: ",").first.map {
                $0.trimmingCharacters(in: .whitespaces)
            }
            if let first, !first.isEmpty { return first }
        }
        return context.remoteAddress?.ipAddress
    }

    static func tooManyRequests(retryAfterSeconds: Int) -> Response {
        var headers = HTTPFields()
        headers[.contentType] = "application/json"
        headers[retryAfter] = String(retryAfterSeconds)
        let body = #"{"error":{"message":"rate limit exceeded"}}"#
        return Response(
            status: .tooManyRequests,
            headers: headers,
            body: .init(byteBuffer: ByteBuffer(string: body))
        )
    }

    /// One audit row per key per overload burst (`shouldAudit`), tenant-scoped.
    static func writeAuditRow(
        db: Database,
        workspaceID: UUID,
        memberID: UUID?,
        scope: String,
        key: String,
        limit: Int,
        windowSeconds: Int,
        path: String,
        ip: String?,
        logger: Logger
    ) async {
        // Keep the detail JSON injection-proof: the path is the only free-form
        // field; strip characters that could break the JSON literal.
        let safePath = path.filter { $0 != "\"" && $0 != "\\" }
        let detail = """
        {"scope":"\(scope)","limit":\(limit),"window_seconds":\(windowSeconds),\
        "path":"\(safePath)"}
        """
        do {
            try await db.withTenantConnection(workspaceID: workspaceID) { conn in
                _ = try await conn.query(
                    """
                    INSERT INTO audit_log
                      (workspace_id, actor_member_id, action, target_type, detail, ip_addr)
                    VALUES
                      (\(workspaceID), \(memberID), 'rate_limit.exceeded', 'request',
                       \(detail)::jsonb, \(ip)::inet)
                    """,
                    logger: logger
                )
            }
        } catch {
            // Auditing must never turn a 429 into a 500.
            logger.error("rate limit audit_log write failed: \(error)")
        }
    }
}

/// Per-IP limiter — mounted on the root router (public + protected routes).
struct IPRateLimitMiddleware: RouterMiddleware {
    typealias Context = AppRequestContext

    let limiter: SlidingWindowRateLimiter
    let config: RateLimitConfig
    let logger: Logger

    func handle(
        _ request: Request,
        context: Context,
        next: (Request, Context) async throws -> Response
    ) async throws -> Response {
        let path = request.uri.path
        guard config.perIPLimit > 0, !RateLimitSupport.excludedPaths.contains(path) else {
            return try await next(request, context)
        }
        guard let ip = RateLimitSupport.clientIP(request: request, context: context) else {
            // No resolvable peer (unix socket/tests) — do not block.
            return try await next(request, context)
        }
        let verdict = await limiter.check(
            key: "ip:\(ip)", limit: config.perIPLimit, windowSeconds: config.windowSeconds
        )
        guard verdict.allowed else {
            if verdict.shouldAudit {
                // Per-IP axis runs before AuthMiddleware → no principal/tenant
                // even for authenticated callers → server log only (see header).
                let loggedPath = SecretRedactingRequestLogMiddleware<AppRequestContext>
                    .redactedPath(path)
                logger.warning(
                    "rate limit exceeded (per-ip)",
                    metadata: ["ip": .string(ip), "path": .string(loggedPath),
                               "limit": .stringConvertible(config.perIPLimit)]
                )
            }
            return RateLimitSupport.tooManyRequests(retryAfterSeconds: verdict.retryAfterSeconds)
        }
        return try await next(request, context)
    }
}

/// Per-member limiter — mounted AFTER `AuthMiddleware` on the protected group,
/// so `context.principal` (member + workspace for audit_log) is available.
struct MemberRateLimitMiddleware: RouterMiddleware {
    typealias Context = AppRequestContext

    let limiter: SlidingWindowRateLimiter
    let config: RateLimitConfig
    let db: Database
    let logger: Logger

    func handle(
        _ request: Request,
        context: Context,
        next: (Request, Context) async throws -> Response
    ) async throws -> Response {
        let path = request.uri.path
        guard config.perMemberLimit > 0,
              !RateLimitSupport.excludedPaths.contains(path),
              let principal = context.principal
        else {
            return try await next(request, context)
        }
        let verdict = await limiter.check(
            key: "member:\(principal.memberID.uuidString)",
            limit: config.perMemberLimit,
            windowSeconds: config.windowSeconds
        )
        guard verdict.allowed else {
            if verdict.shouldAudit {
                await RateLimitSupport.writeAuditRow(
                    db: db,
                    workspaceID: principal.workspaceID,
                    memberID: principal.memberID,
                    scope: "member",
                    key: principal.memberID.uuidString,
                    limit: config.perMemberLimit,
                    windowSeconds: config.windowSeconds,
                    path: SecretRedactingRequestLogMiddleware<AppRequestContext>
                        .redactedPath(path),
                    ip: RateLimitSupport.clientIP(request: request, context: context),
                    logger: logger
                )
            }
            return RateLimitSupport.tooManyRequests(retryAfterSeconds: verdict.retryAfterSeconds)
        }
        return try await next(request, context)
    }
}
