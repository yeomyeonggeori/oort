import Foundation
import Hummingbird
import Logging
import PostgresNIO

/// MOMO-623 / ADR-0135 D2 — provider quota snapshot ingest + read.
///
///   POST /v1/provider/quota-snapshots   (agent bearer, `provider:quota:write`)
///   GET  /v1/provider/quota-snapshots   (any active workspace member)
///
/// ADR-0135 D2-A moves the *probe* to the side that already holds the provider
/// credential (the hermes adapter / provider host). momo therefore never calls a
/// provider quota API; it accepts the resulting numbers and stores the latest
/// snapshot per (provider_ref, window). That keeps ADR-0004 intact: no provider
/// token, OAuth code, or raw header ever enters momo.
///
/// Authorization reuses the existing adapter/gateway credential convention
/// (ADR-0101 phase 1 + AgentGatewayRoutes): the caller presents an **agent
/// bearer** whose credential row carries the dedicated `provider:quota:write`
/// scope. `AuthMiddleware.requiredAgentScope` pins the scope to this exact path,
/// and `TokenStore.authenticateAgentBearer` has already proven the actor is an
/// active `member.kind='agent'` row before the handler runs — so the handler only
/// has to assert the principal kind. `provider:quota:write` is deliberately NOT
/// in `AgentCredentialRoutes.defaultScopes`: it must be granted explicitly, so
/// existing agent credentials do not silently gain the ingest surface.
///
/// Schema policing (the ADR-0004 hard edge). The body is decoded as raw JSON and
/// screened BEFORE any typed conversion:
///   1. closed-world keys — only the five ADR-0135 fields (camelCase, with the
///      ADR's snake_case spellings accepted as aliases) survive; anything else,
///      including any `authorization` / `bearer` / `token` / `apiKey` field, is
///      a 400;
///   2. credential-shaped screening of every key AND string value, reusing
///      `WorkToolProfileRoutes.containsCredentialShape` plus the provider-key
///      prefixes that shape check cannot see (`sk-`, `ghp_`, JWT `eyJ`, the momo
///      agent bearer prefix, long high-entropy blobs);
///   3. type policing — `remainingRatio` must be a JSON number in 0...1 and the
///      two timestamps must be ISO8601; a string, bool, array, or out-of-range
///      value is a 400, never a coerced write.
///
/// The upsert is monotone in `probedAt`: a replayed or out-of-order probe that is
/// older than the stored one leaves the row untouched and answers
/// `applied: false` with the retained (newer) snapshot.
struct ProviderQuotaSnapshotRoutes: Sendable {
    static let ingestScope = "provider:quota:write"
    static let path = "/v1/provider/quota-snapshots"

    /// Accepted `window` vocabulary (ADR-0135: short rolling + weekly gauge).
    static let windows = ["short", "weekly"]
    /// A probe timestamp may lead the server clock by at most this much; beyond
    /// it the sender's clock is wrong and the snapshot age would be meaningless.
    static let maximumClockSkewSeconds: TimeInterval = 300
    /// Probes older than this are rejected outright — a month-old ratio is not a
    /// gauge, and accepting it would silently regress the dashboard.
    static let maximumProbeAgeSeconds: TimeInterval = 30 * 86_400

    let db: Database

    func add(to group: RouterGroup<AppRequestContext>) {
        // RouterPath is a string-literal type; `Self.path` is the same route,
        // single-sourced for the AuthMiddleware scope map (asserted in tests).
        group.post("/v1/provider/quota-snapshots", use: ingest)
        group.get("/v1/provider/quota-snapshots", use: list)
    }

    // MARK: - POST (adapter ingest)

    @Sendable
    func ingest(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        // AuthMiddleware pinned `provider:quota:write` to this path and TokenStore
        // proved the actor is an active agent member; anything else (human JWT,
        // work host) must not reach the instance-global ingest.
        guard principal.kind == .agent else {
            throw HTTPError(
                .forbidden,
                message: "agent bearer with the provider:quota:write scope required"
            )
        }

        let body = try await request.decode(as: JSONValue.self, context: context)
        let snapshot = try Self.validated(body: body, now: Date())

        let stored: (row: StoredQuotaSnapshot, applied: Bool) = try await db
            .withProviderQuotaIngestTransaction(workspaceID: principal.workspaceID) { conn in
                let stored = try await Self.upsert(conn: conn, logger: db.logger, snapshot: snapshot)
                try await Self.writeIngestAudit(
                    conn: conn,
                    logger: db.logger,
                    workspaceID: principal.workspaceID,
                    actorMemberID: principal.memberID,
                    viaTokenID: principal.tokenID,
                    snapshot: snapshot,
                    applied: stored.applied
                )
                return stored
            }

        let response = ProviderQuotaSnapshotIngestResponse(
            schema: "momo.provider_quota_snapshot.v0",
            applied: stored.applied,
            snapshot: Self.projection(stored.row, now: Date())
        )
        return try response.response(from: request, context: context)
    }

    // MARK: - GET (workspace member read)

    @Sendable
    func list(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let workspaceID = principal.workspaceID

        // usage/summary convention (MOMO-615): any ACTIVE workspace member may
        // read the usage surface. The gauge is instance-global telemetry with no
        // secret in it, but membership is still required — a revoked/removed
        // member must not keep reading the operator's provider state.
        let result: (isMember: Bool, rows: [StoredQuotaSnapshot]) = try await db
            .withTenantConnection(workspaceID: workspaceID) { conn in
                let role = try await WorkspaceAuthorization.activeRole(
                    conn: conn,
                    logger: db.logger,
                    workspaceID: workspaceID,
                    memberID: principal.memberID
                )
                guard role != nil else { return (false, []) }
                return (true, try await Self.readAll(conn: conn, logger: db.logger))
            }
        guard result.isMember else {
            throw HTTPError(.forbidden, message: "not a workspace member")
        }

        let now = Date()
        let response = ProviderQuotaSnapshotListResponse(
            schema: "momo.provider_quota_snapshots.v0",
            observedAt: Self.iso8601(now),
            snapshots: result.rows.map { Self.projection($0, now: now) }
        )
        return try response.response(from: request, context: context)
    }

    // MARK: - Validation (closed-world + credential screening + type policing)

    struct ValidatedSnapshot: Equatable, Sendable {
        let providerRef: String
        let window: String
        let remainingRatio: Double
        let resetsAt: Date?
        let probedAt: Date
    }

    /// Canonical field -> accepted spellings. ADR-0135 writes the contract in
    /// snake_case while every other momo route is camelCase, so both spellings
    /// are accepted for the same five fields and nothing else.
    static let fieldAliases: [String: Set<String>] = [
        "providerRef": ["providerRef", "provider_ref"],
        "window": ["window"],
        "remainingRatio": ["remainingRatio", "remaining_ratio"],
        "resetsAt": ["resetsAt", "resets_at"],
        "probedAt": ["probedAt", "probed_at"],
    ]

    /// Provider-key shapes that `containsCredentialShape` cannot see: they carry
    /// none of the words "token"/"secret"/"bearer", they are just high-entropy
    /// prefixed blobs.
    static let credentialPrefixes = [
        "sk-", "sk_", "pk-", "pk_", "rk-", "ghp_", "gho_", "ghu_", "ghs_",
        "github_pat_", "xoxb-", "xoxp-", "xapp-", "akia", "eyj",
        "momo_agent_v1", "basic ", "bearer ",
    ]

    static func validated(body: JSONValue, now: Date) throws -> ValidatedSnapshot {
        guard let object = body.objectValue else {
            throw HTTPError(.badRequest, message: "body must be a JSON object")
        }

        // (1) closed-world keys. Every unknown key is a 400 — including, by
        // construction, any credential field an adapter might try to "helpfully"
        // attach (ADR-0004: 자격증명 비유입).
        var canonical: [String: JSONValue] = [:]
        for (rawKey, value) in object {
            guard let field = fieldAliases.first(where: { $0.value.contains(rawKey) })?.key else {
                throw HTTPError(
                    .badRequest,
                    message: "unknown quota snapshot field: only providerRef, window, "
                        + "remainingRatio, resetsAt, probedAt are accepted"
                )
            }
            guard canonical.updateValue(value, forKey: field) == nil else {
                throw HTTPError(
                    .badRequest,
                    message: "duplicate quota snapshot field: \(field)"
                )
            }
        }

        // (2) credential-shaped screening of keys AND string values.
        guard !WorkToolProfileRoutes.containsCredentialShape(body),
              !containsProviderKeyShape(body)
        else {
            throw HTTPError(
                .badRequest,
                message: "quota snapshot cannot contain credential-shaped data"
            )
        }

        // (3) type + range policing. Numbers and timestamps only.
        let providerRef = try validatedProviderRef(canonical["providerRef"])
        let window = try validatedWindow(canonical["window"])
        let remainingRatio = try validatedRatio(canonical["remainingRatio"])
        let probedAt = try validatedProbedAt(canonical["probedAt"], now: now)
        let resetsAt = try validatedResetsAt(canonical["resetsAt"])

        return ValidatedSnapshot(
            providerRef: providerRef,
            window: window,
            remainingRatio: remainingRatio,
            resetsAt: resetsAt,
            probedAt: probedAt
        )
    }

    static func validatedProviderRef(_ value: JSONValue?) throws -> String {
        guard let raw = value?.stringValue else {
            throw HTTPError(.badRequest, message: "providerRef must be a string")
        }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        // Same slug shape the 043 CHECK constraint enforces: a label, never a
        // pasted credential or a URL.
        guard trimmed.wholeMatch(of: /^[a-z0-9][a-z0-9._-]{0,63}$/) != nil else {
            throw HTTPError(
                .badRequest,
                message: "providerRef must be a 1...64 char slug of a-z0-9._-"
            )
        }
        return trimmed
    }

    static func validatedWindow(_ value: JSONValue?) throws -> String {
        guard let raw = value?.stringValue else {
            throw HTTPError(.badRequest, message: "window must be a string")
        }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard windows.contains(trimmed) else {
            throw HTTPError(.badRequest, message: "window must be short or weekly")
        }
        return trimmed
    }

    static func validatedRatio(_ value: JSONValue?) throws -> Double {
        guard let value, let number = numberValue(value) else {
            throw HTTPError(.badRequest, message: "remainingRatio must be a JSON number")
        }
        guard number.isFinite, number >= 0, number <= 1 else {
            throw HTTPError(.badRequest, message: "remainingRatio must be between 0 and 1")
        }
        return number
    }

    static func validatedProbedAt(_ value: JSONValue?, now: Date) throws -> Date {
        guard let raw = value?.stringValue else {
            throw HTTPError(.badRequest, message: "probedAt must be an ISO8601 timestamp")
        }
        guard let probedAt = try UsageSummaryRoutes.parseTimestamp(raw, label: "probedAt") else {
            throw HTTPError(.badRequest, message: "probedAt must be an ISO8601 timestamp")
        }
        guard probedAt.timeIntervalSince(now) <= maximumClockSkewSeconds else {
            throw HTTPError(.badRequest, message: "probedAt must not be in the future")
        }
        guard now.timeIntervalSince(probedAt) <= maximumProbeAgeSeconds else {
            throw HTTPError(.badRequest, message: "probedAt is too old to be a quota gauge")
        }
        return probedAt
    }

    static func validatedResetsAt(_ value: JSONValue?) throws -> Date? {
        guard let value, value != .null else { return nil }
        guard let raw = value.stringValue else {
            throw HTTPError(.badRequest, message: "resetsAt must be an ISO8601 timestamp")
        }
        return try UsageSummaryRoutes.parseTimestamp(raw, label: "resetsAt")
    }

    /// High-entropy provider key shapes, checked on keys and string values alike.
    static func containsProviderKeyShape(_ value: JSONValue) -> Bool {
        switch value {
        case .object(let object):
            return object.contains { key, child in
                isProviderKeyShaped(key) || containsProviderKeyShape(child)
            }
        case .array(let array):
            return array.contains(where: containsProviderKeyShape)
        case .string(let string):
            return isProviderKeyShaped(string)
        case .int, .double, .bool, .null:
            return false
        }
    }

    static func isProviderKeyShaped(_ raw: String) -> Bool {
        let normalized = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalized.isEmpty else { return false }
        if credentialPrefixes.contains(where: normalized.hasPrefix) { return true }
        // Long opaque blob. Length alone would flag a legitimately descriptive
        // label ("hermes-primary-eu-west-1-fallback"), so the signal is an
        // unbroken alphanumeric RUN — words are short and separated, secrets are
        // not. 24 is comfortably above any real word and below every real key.
        guard normalized.count >= 24 else { return false }
        var run = 0
        var longestRun = 0
        var sawDigit = false
        var sawLetter = false
        for character in normalized where true {
            if character.isLetter || character.isNumber {
                run += 1
                longestRun = max(longestRun, run)
                if character.isNumber { sawDigit = true } else { sawLetter = true }
            } else {
                run = 0
            }
        }
        return longestRun >= 24 && sawDigit && sawLetter
    }

    static func numberValue(_ value: JSONValue) -> Double? {
        switch value {
        case .int(let int): return Double(int)
        case .double(let double): return double
        // A quoted number is a schema violation, not a value to coerce.
        case .string, .bool, .object, .array, .null: return nil
        }
    }

    // MARK: - Storage

    struct StoredQuotaSnapshot: Equatable, Sendable {
        let providerRef: String
        let window: String
        let remainingRatio: Double
        let resetsAt: Date?
        let probedAt: Date
        let ingestedAt: Date
    }

    /// Latest-only upsert (ADR-0135 D2: "저장은 최신 스냅샷만").
    ///
    /// The `WHERE quota_snapshot.probed_at <= EXCLUDED.probed_at` guard makes the
    /// write monotone: a replayed or out-of-order probe cannot regress a newer
    /// gauge. When the guard suppresses the update, `RETURNING` yields nothing and
    /// the retained row is read back so the caller still sees the truth.
    static func upsert(
        conn: PostgresConnection,
        logger: Logger,
        snapshot: ValidatedSnapshot
    ) async throws -> (row: StoredQuotaSnapshot, applied: Bool) {
        let rows = try await conn.query(
            """
            INSERT INTO quota_snapshot
              (provider_ref, quota_window, remaining_ratio, resets_at, probed_at)
            VALUES
              (\(snapshot.providerRef), \(snapshot.window), \(snapshot.remainingRatio),
               \(snapshot.resetsAt), \(snapshot.probedAt))
            ON CONFLICT (provider_ref, quota_window) DO UPDATE
               SET remaining_ratio = EXCLUDED.remaining_ratio,
                   resets_at = EXCLUDED.resets_at,
                   probed_at = EXCLUDED.probed_at,
                   ingested_at = now()
             WHERE quota_snapshot.probed_at <= EXCLUDED.probed_at
            RETURNING provider_ref, quota_window, remaining_ratio,
                      resets_at, probed_at, ingested_at
            """,
            logger: logger
        ).collect()
        if let row = rows.first {
            return (try decode(row), true)
        }
        // Suppressed by the monotonicity guard — report the retained snapshot.
        let retained = try await conn.query(
            """
            SELECT provider_ref, quota_window, remaining_ratio,
                   resets_at, probed_at, ingested_at
              FROM quota_snapshot
             WHERE provider_ref = \(snapshot.providerRef)
               AND quota_window = \(snapshot.window)
            """,
            logger: logger
        ).collect()
        guard let row = retained.first else {
            throw HTTPError(.internalServerError, message: "quota snapshot upsert lost its row")
        }
        return (try decode(row), false)
    }

    static func readAll(
        conn: PostgresConnection,
        logger: Logger
    ) async throws -> [StoredQuotaSnapshot] {
        let rows = try await conn.query(
            """
            SELECT provider_ref, quota_window, remaining_ratio,
                   resets_at, probed_at, ingested_at
              FROM quota_snapshot
             ORDER BY provider_ref ASC,
                      CASE quota_window WHEN 'short' THEN 0 ELSE 1 END ASC
            """,
            logger: logger
        ).collect()
        return try rows.map(decode)
    }

    /// Quota rows are instance-global, but each ingest is still attributable to
    /// the agent bearer that submitted it. The audit records no bearer and no
    /// provider response body — only the accepted gauge identity and outcome.
    static func writeIngestAudit(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        actorMemberID: UUID,
        viaTokenID: UUID,
        snapshot: ValidatedSnapshot,
        applied: Bool
    ) async throws {
        let detail = auditDetail([
            "schema": "momo.provider_quota_snapshot.ingested.v1",
            "provider_ref": snapshot.providerRef,
            "window": snapshot.window,
            "applied": applied,
        ])
        _ = try await conn.query(
            """
            INSERT INTO audit_log
              (workspace_id, actor_member_id, action, target_type, target_id,
               via_token_id, detail)
            VALUES
              (\(workspaceID), \(actorMemberID), 'provider_quota_snapshot.ingested',
               'quota_snapshot', NULL, \(viaTokenID), \(detail)::jsonb)
            """,
            logger: logger
        )
    }

    static func auditDetail(_ object: [String: Any]) -> String {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              let value = String(data: data, encoding: .utf8)
        else { return "{}" }
        return value
    }

    private static func decode(_ row: PostgresRow) throws -> StoredQuotaSnapshot {
        let (ref, window, ratio, resetsAt, probedAt, ingestedAt) = try row.decode(
            (String, String, Double, Date?, Date, Date).self
        )
        return StoredQuotaSnapshot(
            providerRef: ref,
            window: window,
            remainingRatio: ratio,
            resetsAt: resetsAt,
            probedAt: probedAt,
            ingestedAt: ingestedAt
        )
    }

    // MARK: - Projection

    static func projection(_ row: StoredQuotaSnapshot, now: Date) -> ProviderQuotaSnapshotDTO {
        ProviderQuotaSnapshotDTO(
            providerRef: row.providerRef,
            window: row.window,
            remainingRatio: row.remainingRatio,
            resetsAt: row.resetsAt.map(iso8601),
            probedAt: iso8601(row.probedAt),
            ingestedAt: iso8601(row.ingestedAt),
            // ADR-0135 D2: the dashboard shows snapshot age and falls back to
            // "마지막 확인값" when it is stale.
            ageSeconds: Int64(max(0, now.timeIntervalSince(row.probedAt).rounded()))
        )
    }

    static func iso8601(_ date: Date) -> String {
        UsageSummaryRoutes.iso8601(date)
    }
}

// MARK: - Wire DTOs

struct ProviderQuotaSnapshotDTO: Codable, Sendable, Equatable {
    let providerRef: String
    /// ADR-0135 wire name; stored as `quota_snapshot.quota_window` (reserved word).
    let window: String
    let remainingRatio: Double
    let resetsAt: String?
    let probedAt: String
    let ingestedAt: String
    let ageSeconds: Int64

    private enum CodingKeys: String, CodingKey {
        case providerRef, window, remainingRatio, resetsAt, probedAt, ingestedAt, ageSeconds
    }

    /// `resetsAt` is contractually `string | null`, so the key must survive
    /// encoding when the provider reported no reset instant.
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(providerRef, forKey: .providerRef)
        try container.encode(window, forKey: .window)
        try container.encode(remainingRatio, forKey: .remainingRatio)
        try container.encode(resetsAt, forKey: .resetsAt)
        try container.encode(probedAt, forKey: .probedAt)
        try container.encode(ingestedAt, forKey: .ingestedAt)
        try container.encode(ageSeconds, forKey: .ageSeconds)
    }
}

struct ProviderQuotaSnapshotIngestResponse: ResponseEncodable, Encodable, Sendable {
    let schema: String
    /// false when the monotonicity guard retained a newer stored probe.
    let applied: Bool
    let snapshot: ProviderQuotaSnapshotDTO
}

struct ProviderQuotaSnapshotListResponse: ResponseEncodable, Encodable, Sendable {
    let schema: String
    let observedAt: String
    let snapshots: [ProviderQuotaSnapshotDTO]
}
