import Foundation
import Hummingbird
import Logging
import PostgresNIO

/// MOMO-572 / ADR-0004 증보 1 — operator REST for the instance-global provider
/// link (the DB override of the boot-time HERMES_* env trio).
///
/// Authorization (MOMO-583, tightening the MOMO-576 opening): provider_link is
/// instance-global (no workspace_id) — whoever edits it changes provider
/// resolution for EVERY workspace on the instance. The MOMO-576 "any workspace
/// owner/admin" fallback was therefore a cross-tenant control leak the moment
/// ADR-0117 multi-WS opened, and is removed. This surface now requires either:
///   * the `platform:read` cross-tenant scope (MOMO-300 admin-secret login), or
///   * an **instance operator**: a workspace owner/admin whose VERIFIED email is
///     listed in `PLATFORM_ADMIN_EMAILS`, checked at request time against the DB.
/// The allowlist path exists because the macOS app's login cannot send the
/// platform-admin secret (no such field), so a scope-only rule would lock the
/// operator out of the "AI 연결" GUI entirely. The env allowlist is controlled
/// by whoever operates the deployment — exactly the trust boundary intended by
/// ADR-0004 증보1 D3 ("설정 권한 = 서버 운영자"). Other workspaces' owners are
/// not listed and get 403.
///
/// Per-WORKSPACE operator surfaces (e.g. `WorkHostEngineRoutes`, RLS-scoped)
/// still accept any workspace owner/admin via `isOperatorAuthorized` — the split
/// is deliberate: instance-global ⇒ platform scope or listed instance operator,
/// per-workspace ⇒ owner/admin.
///
/// ADR-0004 invariants enforced here:
///   * The bearer is accepted only in the PUT body and stored as AES-GCM
///     ciphertext. It is never echoed, logged, audited, or returned — GET exposes
///     only a boolean + a masked 4-char tail.
///   * The request shape is closed-world, so no `codex_oauth_*` / `openai_*` /
///     raw-provider-key field can ever be introduced through this API.
struct ProviderLinkRoutes: Sendable {
    let db: Database
    let environmentName: String
    let allowLocalLoopback: Bool
    let providerLinkMasterKey: String
    let envProvider: AgentProviderConfig
    let healthProbe: any ProviderHealthProbing
    /// MOMO-583: lowercased instance-operator allowlist (PLATFORM_ADMIN_EMAILS).
    let platformAdminEmails: [String]

    func add(to group: RouterGroup<AppRequestContext>) {
        group.get("/v1/provider/link", use: get)
        group.put("/v1/provider/link", use: put)
        group.delete("/v1/provider/link", use: delete)
        group.post("/v1/provider/link/test", use: test)
        // MOMO-622 / ADR-0135 D1: the cascade chain shares this surface's auth,
        // master key, and operator transaction (see ProviderLinkChainRoutes).
        addChain(to: group)
    }

    // MARK: - GET

    @Sendable
    func get(_ request: Request, context: AppRequestContext) async throws -> Response {
        _ = try await requireOperator(context)
        let stored: StoredProviderLink? = try await db.withProviderLinkReadConnection { conn in
            try await ProviderLinkStore.read(conn: conn, logger: db.logger)
        }
        return try makeResponse(stored: stored)
            .response(from: request, context: context)
    }

    // MARK: - PUT

    @Sendable
    func put(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try await requireOperator(context)
        // provider_link is instance-global (no `:ws` path param); attribute the
        // operator audit entry to the acting principal's home workspace.
        let workspaceID = principal.workspaceID
        let dto = try await request.decode(as: PutProviderLinkRequest.self, context: context)

        let baseURL = try AgentRoutes.validatedBaseURL(
            dto.baseUrl,
            environmentName: environmentName,
            allowLocalLoopback: allowLocalLoopback
        )
        let bearer = dto.bearer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !bearer.isEmpty else {
            throw HTTPError(.badRequest, message: "bearer must not be empty")
        }
        let mode = try Self.resolvedMode(dto.mode)
        let ciphertext = try ProviderLinkCrypto.seal(bearer, masterKey: providerLinkMasterKey)

        let stored: StoredProviderLink = try await db.withProviderLinkTransaction(
            workspaceID: workspaceID
        ) { conn in
            let saved = try await ProviderLinkStore.upsert(
                conn: conn, logger: db.logger,
                baseURL: baseURL, bearerCiphertext: ciphertext,
                mode: mode.rawValue, updatedBy: principal.memberID
            )
            try await Self.writeAudit(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                actorMemberID: principal.memberID, viaTokenID: principal.tokenID,
                action: "provider_link.updated",
                mode: mode.rawValue,
                endpointLabel: AgentProviderConfig.redactedEndpointLabel(baseURL),
                bearerConfigured: true
            )
            return saved
        }
        return try makeResponse(stored: stored)
            .response(from: request, context: context)
    }

    // MARK: - DELETE

    @Sendable
    func delete(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try await requireOperator(context)
        // Instance-global row; audit attributed to the acting principal's workspace.
        let workspaceID = principal.workspaceID

        try await db.withProviderLinkTransaction(workspaceID: workspaceID) { conn in
            let existed = try await ProviderLinkStore.delete(conn: conn, logger: db.logger)
            if existed {
                try await Self.writeAudit(
                    conn: conn, logger: db.logger, workspaceID: workspaceID,
                    actorMemberID: principal.memberID, viaTokenID: principal.tokenID,
                    action: "provider_link.deleted",
                    mode: nil, endpointLabel: nil, bearerConfigured: false
                )
            }
        }
        // After deletion the effective config is the env fallback.
        return try makeResponse(stored: nil)
            .response(from: request, context: context)
    }

    // MARK: - POST test

    /// MOMO-622 / ADR-0135 D1 — the probe now covers the WHOLE cascade.
    ///
    /// Backward compatibility is strict: every field the MOMO-572 response
    /// carried (`schema` included) keeps its exact old meaning and describes
    /// **position 0**, so the existing macOS "AI 연결" panel is unaffected. The
    /// chain adds only new keys — `entries[]` (per-hop results in attempt order)
    /// and `cascadeOk` (would any attemptable hop serve a turn right now).
    @Sendable
    func test(_ request: Request, context: AppRequestContext) async throws -> Response {
        _ = try await requireOperator(context)
        let (storedLink, storedChain) = try await readChainState()
        let resolved = resolvedCascade(storedLink: storedLink, storedChain: storedChain)
        let checkedAtMs = Int64(Date().timeIntervalSince1970 * 1000)

        // Probe hops concurrently: sequential probing would multiply the live
        // probe timeout by the chain length on one operator request.
        let probe = healthProbe
        let hops = resolved.hops
        var results = [ProviderChainProbeOutcome?](repeating: nil, count: hops.count)
        await withTaskGroup(of: (Int, ProviderChainProbeOutcome).self) { group in
            for (index, hop) in hops.enumerated() {
                group.addTask {
                    (index, await Self.probeHop(hop, using: probe))
                }
            }
            for await (index, outcome) in group {
                results[index] = outcome
            }
        }

        let entries = zip(hops, results).map { hop, outcome -> ProviderChainProbeDTO in
            let outcome = outcome ?? ProviderChainProbeOutcome(
                result: ProviderHealthResult(ok: false, reason: "probe_not_run"),
                disposition: .propagate
            )
            return ProviderChainProbeDTO(
                position: hop.position,
                source: hop.source.rawValue,
                mode: hop.mode.rawValue,
                endpointLabel: hop.endpointLabel,
                enabled: hop.enabled,
                ok: outcome.result.ok,
                reason: outcome.result.reason,
                disposition: outcome.disposition.rawValue
            )
        }

        // Position 0 drives the legacy top-level fields.
        let head = entries.first
        let response = ProviderLinkTestResponse(
            schema: "momo.provider_link.test.v0",
            ok: head?.ok ?? false,
            reason: head?.reason,
            source: resolved.head.source.rawValue,
            mode: resolved.head.config.mode.rawValue,
            endpointLabel: resolved.head.config.endpointLabel,
            checkedAtMs: checkedAtMs,
            cascadeOk: entries.contains { $0.ok },
            entries: entries
        )
        return try response.response(from: request, context: context)
    }

    /// Probe one hop and classify what a real cascade would do with the outcome.
    /// Mirrors the runtime rule exactly: only no-response / 5xx / 429 advance.
    static func probeHop(
        _ hop: ProviderCascadeHop,
        using probe: any ProviderHealthProbing
    ) async -> ProviderChainProbeOutcome {
        guard hop.enabled else {
            // A parked hop is never attempted, so it can neither serve nor fall
            // over — it is simply skipped.
            return ProviderChainProbeOutcome(
                result: ProviderHealthResult(ok: false, reason: "hop_disabled"),
                disposition: .skipped
            )
        }
        if hop.mode != .externalHermes {
            // Mock modes have no real provider to reach; report as not-external so
            // the operator knows a real base_url/bearer must be configured first.
            return ProviderChainProbeOutcome(
                result: ProviderHealthResult(ok: false, reason: "not_external_provider"),
                disposition: .propagate
            )
        }
        guard hop.isUsable else {
            return ProviderChainProbeOutcome(
                result: ProviderHealthResult(ok: false, reason: "provider_not_configured"),
                disposition: .propagate
            )
        }
        let result = await probe.probe(baseURL: hop.baseURL, bearer: hop.bearer)
        if result.ok {
            return ProviderChainProbeOutcome(result: result, disposition: .ok)
        }
        let decision = ProviderCascadeClassifier.decide(probeReason: result.reason)
        return ProviderChainProbeOutcome(
            result: result,
            disposition: decision.isFallOver ? .fallOver : .propagate
        )
    }

    // MARK: - Resolution + response

    private func makeResponse(stored: StoredProviderLink?) -> ProviderLinkResponse {
        let decrypted = stored.flatMap {
            ProviderLinkStore.decrypt($0, masterKey: providerLinkMasterKey)
        }
        let resolved = ProviderLinkResolver.resolve(env: envProvider, link: decrypted)
        let config = resolved.config
        let strict = AgentProviderConfig.requiresStrictExternalProvider(environmentName)
        let diagnostics = config.validationErrors(
            strictEnvironment: strict || config.mode == .externalHermes
        )
        let fromDatabase = resolved.source == .database
        let last4 = fromDatabase ? decrypted.flatMap { ProviderLinkCrypto.maskedTail($0.bearer) } : nil
        return ProviderLinkResponse(
            schema: "momo.provider_link.v0",
            configured: fromDatabase,
            source: resolved.source.rawValue,
            mode: config.mode.rawValue,
            baseUrl: config.hermesBaseURL,
            endpointLabel: config.endpointLabel,
            bearerConfigured: config.keyConfigured,
            bearerLast4: last4,
            availability: config.availability,
            keyConfigured: config.keyConfigured,
            updatedAtMs: fromDatabase ? stored?.updatedAtMs : nil,
            updatedBy: fromDatabase ? stored?.updatedByMemberID?.uuidString : nil,
            diagnostics: diagnostics
        )
    }

    // MARK: - Helpers

    /// Pure authorization decision for PER-WORKSPACE operator surfaces
    /// (`WorkHostEngineRoutes` and siblings whose data is RLS-scoped to one
    /// workspace): a human that either carries the `platform:read` cross-tenant
    /// scope or is an owner/admin of its own workspace.
    ///
    /// NOT used by provider_link itself since MOMO-583 — that surface is
    /// instance-global and requires the platform scope
    /// (`isProviderLinkOperatorAuthorized`). Kept here so the operator matrix
    /// stays single-sourced for the per-workspace consumers.
    static func isOperatorAuthorized(
        kind: AuthPrincipalKind,
        scopes: [String],
        workspaceRole: WorkspaceRole?
    ) -> Bool {
        guard kind == .human else { return false }
        if scopes.contains("platform:read") { return true }
        return workspaceRole?.isAdmin ?? false
    }

    /// Pure authorization decision for the INSTANCE-GLOBAL provider-link surface
    /// (MOMO-583): human AND (`platform:read` scope OR listed instance operator).
    /// A listed instance operator is a workspace owner/admin whose VERIFIED email
    /// appears in `PLATFORM_ADMIN_EMAILS` — an arbitrary workspace owner/admin
    /// (the MOMO-576 fallback) no longer qualifies.
    ///
    /// `verifiedEmail` must be nil unless `human.email_verified` is true; it is
    /// compared lowercased against the (already-lowercased) configured list.
    static func isProviderLinkOperatorAuthorized(
        kind: AuthPrincipalKind,
        scopes: [String],
        workspaceRole: WorkspaceRole?,
        verifiedEmail: String?,
        platformAdminEmails: [String]
    ) -> Bool {
        guard kind == .human else { return false }
        if scopes.contains("platform:read") { return true }
        guard workspaceRole?.isAdmin ?? false else { return false }
        guard let verifiedEmail else { return false }
        return platformAdminEmails.contains(verifiedEmail.lowercased())
    }

    /// Authorizes the provider-link operator surface (see the type doc comment).
    ///
    /// The allowlist lookup runs in its own tenant transaction — `app.workspace_id`
    /// is set but `app.provider_link_admin` is NOT — so the authorization decision
    /// fully completes with provider_link still RLS-locked. Only after this
    /// returns does a caller open `withProviderLinkTransaction`.
    func requireOperator(_ context: AppRequestContext) async throws -> AuthPrincipal {
        try await Self.requireOperator(
            db: db, platformAdminEmails: platformAdminEmails, context: context
        )
    }

    /// Shared instance-global authorization boundary. Keep credential minting
    /// on this exact path: a workspace admin must not mint an adapter bearer
    /// that can overwrite every workspace's provider quota gauge.
    static func requireOperator(
        db: Database,
        platformAdminEmails: [String],
        context: AppRequestContext
    ) async throws -> AuthPrincipal {
        let principal = try context.requirePrincipal()
        guard principal.kind == .human else {
            throw HTTPError(.forbidden, message: "human operator required")
        }
        // Platform scope authorizes without any DB lookup.
        if principal.scopes.contains("platform:read") { return principal }
        // Listed-instance-operator path: role + verified email, both RLS-scoped.
        let (role, verifiedEmail) = try await db.withTenantConnection(
            workspaceID: principal.workspaceID
        ) { conn in
            let role = try await WorkspaceAuthorization.activeRole(
                conn: conn,
                logger: db.logger,
                workspaceID: principal.workspaceID,
                memberID: principal.memberID
            )
            var email: String?
            let rows = try await conn.query(
                """
                SELECT email FROM human
                WHERE member_id = \(principal.memberID)
                  AND workspace_id = \(principal.workspaceID)
                  AND email_verified = true
                """,
                logger: db.logger
            )
            for try await row in rows {
                email = try row.decode(String.self)
            }
            return (role, email)
        }
        guard Self.isProviderLinkOperatorAuthorized(
            kind: principal.kind,
            scopes: principal.scopes,
            workspaceRole: role,
            verifiedEmail: verifiedEmail,
            platformAdminEmails: platformAdminEmails
        ) else {
            throw HTTPError(
                .forbidden,
                message: "platform:read scope or listed instance operator required"
            )
        }
        return principal
    }

    static func resolvedMode(_ raw: String?) throws -> AgentProviderMode {
        guard let raw, !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            // Configuring a provider link implies the external-hermes boundary.
            return .externalHermes
        }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard let mode = AgentProviderMode(rawValue: trimmed) else {
            throw HTTPError(
                .badRequest,
                message: "mode must be one of local-mock, internal-host-mock, external-hermes"
            )
        }
        return mode
    }

    static func writeAudit(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        actorMemberID: UUID,
        viaTokenID: UUID,
        action: String,
        mode: String?,
        endpointLabel: String?,
        bearerConfigured: Bool
    ) async throws {
        _ = try await conn.query(
            """
            INSERT INTO audit_log
              (workspace_id, actor_member_id, action, target_type, target_id,
               via_token_id, detail)
            VALUES
              (\(workspaceID), \(actorMemberID), \(action), 'provider_link', NULL,
               \(viaTokenID),
               jsonb_build_object(
                 'schema', 'momo.provider_link.audit.v1',
                 'mode', \(mode)::text,
                 'endpoint_label', \(endpointLabel)::text,
                 'bearer_configured', \(bearerConfigured)
               ))
            """,
            logger: logger
        )
    }
}

// MARK: - DTOs

struct ProviderLinkResponse: ResponseEncodable, Encodable, Sendable {
    let schema: String
    let configured: Bool
    let source: String
    let mode: String
    let baseUrl: String
    let endpointLabel: String
    let bearerConfigured: Bool
    let bearerLast4: String?
    let availability: String
    let keyConfigured: Bool
    let updatedAtMs: Int64?
    let updatedBy: String?
    let diagnostics: [String]
}

/// MOMO-572 shape + the MOMO-622 chain extension. The first seven fields are
/// byte-identical to the v0 contract and describe position 0; `cascadeOk` and
/// `entries` are additive (unknown keys are ignored by the existing clients'
/// `Decodable`), so the schema string deliberately stays `…test.v0`.
struct ProviderLinkTestResponse: ResponseEncodable, Encodable, Sendable {
    let schema: String
    let ok: Bool
    let reason: String?
    let source: String
    let mode: String
    let endpointLabel: String
    let checkedAtMs: Int64
    /// True when at least one hop in the cascade could serve a turn right now.
    let cascadeOk: Bool
    /// Per-hop probe results in attempt order (position 0 first).
    let entries: [ProviderChainProbeDTO]
}

/// What a real cascade would do with a probe outcome — the operator-visible
/// projection of `ProviderCascadeDecision`.
enum ProviderChainProbeDisposition: String, Sendable {
    /// The hop answered; a turn would be served here.
    case ok
    /// No response / 5xx / 429 — a turn would advance to the next hop.
    case fallOver = "fall_over"
    /// Caller/config error (4xx, unconfigured, mock mode) — a turn would surface
    /// this instead of re-spending on another provider.
    case propagate
    /// Hop parked by the operator (`enabled = false`); never attempted.
    case skipped
}

struct ProviderChainProbeOutcome: Sendable {
    let result: ProviderHealthResult
    let disposition: ProviderChainProbeDisposition
}

struct ProviderChainProbeDTO: Encodable, Sendable {
    let position: Int
    let source: String
    let mode: String
    let endpointLabel: String
    let enabled: Bool
    let ok: Bool
    let reason: String?
    let disposition: String
}

/// Closed-world PUT body. Only baseUrl / bearer / mode are accepted; any other
/// key (including any Codex/OpenAI OAuth or raw-provider-key field) is rejected,
/// upholding ADR-0004 Rules #1-#2.
struct PutProviderLinkRequest: Decodable, Sendable {
    let baseUrl: String
    let bearer: String
    let mode: String?

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case baseUrl
        case bearer
        case mode
    }

    init(from decoder: Decoder) throws {
        let dynamic = try decoder.container(keyedBy: ProviderLinkCodingKey.self)
        let allowed = Set(CodingKeys.allCases.map(\.rawValue))
        let unknown = dynamic.allKeys.map(\.stringValue).filter { !allowed.contains($0) }
        guard unknown.isEmpty else {
            throw DecodingError.dataCorruptedError(
                forKey: unknown.sorted().first.map(ProviderLinkCodingKey.init)!,
                in: dynamic,
                debugDescription: "unknown provider-link field"
            )
        }
        let values = try decoder.container(keyedBy: CodingKeys.self)
        baseUrl = try values.decode(String.self, forKey: .baseUrl)
        bearer = try values.decode(String.self, forKey: .bearer)
        mode = try values.decodeIfPresent(String.self, forKey: .mode)
    }
}

private struct ProviderLinkCodingKey: CodingKey, Hashable {
    let stringValue: String
    let intValue: Int? = nil

    init(_ stringValue: String) { self.stringValue = stringValue }
    init?(stringValue: String) { self.init(stringValue) }
    init?(intValue: Int) { self.stringValue = String(intValue) }
}
