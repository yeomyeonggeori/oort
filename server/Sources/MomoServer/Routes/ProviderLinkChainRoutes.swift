import Foundation
import Hummingbird
import Logging
import PostgresNIO

/// MOMO-622 / ADR-0135 D1 — operator REST for the provider *cascade chain*.
///
/// This is an `extension` of `ProviderLinkRoutes` on purpose: the chain is the
/// same instance-global operator surface as the singleton link, so it must reuse
/// — not re-derive — the MOMO-583 authorization model (`requireOperator`:
/// `platform:read` scope OR a listed instance operator), the same
/// `PROVIDER_LINK_MASTER_KEY` sealing, and the same `app.provider_link_admin`
/// transaction. A second route struct with its own auth would be exactly the
/// cross-tenant control leak 583 closed.
///
/// Surface:
///   * `GET    /v1/provider/link/chain` — the full cascade **including position 0**
///     (the legacy `provider_link` singleton, or the env fallback). The legacy
///     `GET/PUT /v1/provider/link` keep working unchanged and remain the only way
///     to edit position 0 — this endpoint just makes the singleton visible as the
///     head of the chain (ADR-0135 D1 "이전 경로").
///   * `PUT    /v1/provider/link/chain` — replace the fallback hops (positions >= 1).
///   * `DELETE /v1/provider/link/chain` — drop every fallback hop.
///
/// ADR-0004 invariants (identical to the singleton surface):
///   * Bearers are accepted only in the PUT body, stored as AES-GCM ciphertext,
///     and never echoed / logged / audited — responses carry a masked 4-char tail.
///   * The request shape is closed-world, so no `codex_oauth_*` / `openai_*` /
///     raw-provider-key field can be introduced through this API.
extension ProviderLinkRoutes {
    /// Upper bound on configured fallback hops. A cascade is a availability
    /// safety net, not a load balancer: each extra hop multiplies the worst-case
    /// latency of a failing turn and the number of budgets one prompt can spend.
    static let maxChainEntries = 8

    func addChain(to group: RouterGroup<AppRequestContext>) {
        group.get("/v1/provider/link/chain", use: getChain)
        group.put("/v1/provider/link/chain", use: putChain)
        group.delete("/v1/provider/link/chain", use: deleteChain)
    }

    // MARK: - GET

    @Sendable
    func getChain(_ request: Request, context: AppRequestContext) async throws -> Response {
        _ = try await requireOperator(context)
        let (storedLink, storedChain) = try await readChainState()
        return try chainResponse(storedLink: storedLink, storedChain: storedChain)
            .response(from: request, context: context)
    }

    // MARK: - PUT (replace all fallback hops)

    @Sendable
    func putChain(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try await requireOperator(context)
        // The chain is instance-global (no `:ws` path param); attribute the
        // operator audit entry to the acting principal's home workspace, exactly
        // as the singleton PUT does.
        let workspaceID = principal.workspaceID
        let dto = try await request.decode(as: PutProviderChainRequest.self, context: context)
        let inputs = try validatedChainEntries(dto.entries)

        let masterKey = providerLinkMasterKey
        let (storedLink, storedChain): (StoredProviderLink?, [StoredProviderChainEntry])
        (storedLink, storedChain) = try await db.withProviderLinkTransaction(
            workspaceID: workspaceID
        ) { conn in
            // Existing ciphertexts, keyed by position, so an operator can reorder
            // or toggle a hop without re-typing its write-only bearer.
            let existing = try await ProviderLinkChainStore.read(conn: conn, logger: db.logger)
            let existingByPosition = Dictionary(
                uniqueKeysWithValues: existing.map { ($0.position, $0.bearerCiphertext) }
            )
            var rows:
                [(position: Int, baseURL: String, bearerCiphertext: Data, mode: String, enabled: Bool)] = []
            for input in inputs {
                let ciphertext: Data
                if let bearer = input.bearer {
                    ciphertext = try ProviderLinkCrypto.seal(bearer, masterKey: masterKey)
                } else if let kept = existingByPosition[input.position] {
                    ciphertext = kept
                } else {
                    throw HTTPError(
                        .badRequest,
                        message: "bearer is required for new chain position \(input.position)"
                    )
                }
                rows.append((
                    position: input.position,
                    baseURL: input.baseURL,
                    bearerCiphertext: ciphertext,
                    mode: input.mode.rawValue,
                    enabled: input.enabled
                ))
            }
            let saved = try await ProviderLinkChainStore.replaceAll(
                conn: conn, logger: db.logger, entries: rows, updatedBy: principal.memberID
            )
            try await Self.writeChainAudit(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                actorMemberID: principal.memberID, viaTokenID: principal.tokenID,
                action: "provider_link_chain.updated",
                // Endpoint labels only — never the base_url query/userinfo and
                // never the bearer (ADR-0004 evidence rule).
                positions: saved.map(\.position),
                endpointLabels: saved.map { AgentProviderConfig.redactedEndpointLabel($0.baseURL) }
            )
            let link = try await ProviderLinkStore.read(conn: conn, logger: db.logger)
            return (link, saved)
        }
        return try chainResponse(storedLink: storedLink, storedChain: storedChain)
            .response(from: request, context: context)
    }

    // MARK: - DELETE (drop all fallback hops)

    @Sendable
    func deleteChain(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try await requireOperator(context)
        let workspaceID = principal.workspaceID

        let storedLink: StoredProviderLink? = try await db.withProviderLinkTransaction(
            workspaceID: workspaceID
        ) { conn in
            let removed = try await ProviderLinkChainStore.deleteAll(conn: conn, logger: db.logger)
            if removed > 0 {
                try await Self.writeChainAudit(
                    conn: conn, logger: db.logger, workspaceID: workspaceID,
                    actorMemberID: principal.memberID, viaTokenID: principal.tokenID,
                    action: "provider_link_chain.cleared",
                    positions: [], endpointLabels: []
                )
            }
            return try await ProviderLinkStore.read(conn: conn, logger: db.logger)
        }
        // After the clear the cascade is position 0 alone.
        return try chainResponse(storedLink: storedLink, storedChain: [])
            .response(from: request, context: context)
    }

    // MARK: - Shared read + projection

    /// Read the singleton head and the fallback hops in one operator transaction
    /// so the projected chain is internally consistent.
    func readChainState() async throws -> (StoredProviderLink?, [StoredProviderChainEntry]) {
        try await db.withProviderLinkReadConnection { conn in
            let link = try await ProviderLinkStore.read(conn: conn, logger: db.logger)
            let chain = try await ProviderLinkChainStore.read(conn: conn, logger: db.logger)
            return (link, chain)
        }
    }

    /// Resolve the effective cascade (position 0 + fallback hops) with bearers
    /// opened. Returned hops carry plaintext bearers and must never be serialized
    /// directly — project them through `ProviderChainEntryDTO`.
    func resolvedCascade(
        storedLink: StoredProviderLink?,
        storedChain: [StoredProviderChainEntry]
    ) -> (
        head: ResolvedProviderConfig,
        hops: [ProviderCascadeHop],
        decryptedHead: DecryptedProviderLink?,
        decryptedChain: [DecryptedProviderChainEntry]
    ) {
        let decryptedHead = storedLink.flatMap {
            ProviderLinkStore.decrypt($0, masterKey: providerLinkMasterKey)
        }
        let head = ProviderLinkResolver.resolve(env: envProvider, link: decryptedHead)
        var decryptedChain: [DecryptedProviderChainEntry] = []
        for stored in storedChain {
            if let decrypted = ProviderLinkChainStore.decrypt(stored, masterKey: providerLinkMasterKey) {
                decryptedChain.append(decrypted)
            } else {
                // Never silently erase an undecryptable configured hop from the
                // operator's view: a later replace-all PUT must preserve it.
                db.logger.error("provider_link_chain hop cannot be decrypted", metadata: [
                    "position": .stringConvertible(stored.position),
                ])
            }
        }
        return (head, ProviderCascade.plan(head: head, chain: decryptedChain), decryptedHead, decryptedChain)
    }

    func chainResponse(
        storedLink: StoredProviderLink?,
        storedChain: [StoredProviderChainEntry]
    ) -> ProviderChainResponse {
        let resolved = resolvedCascade(storedLink: storedLink, storedChain: storedChain)
        let decryptedByPosition = Dictionary(
            uniqueKeysWithValues: resolved.decryptedChain.map { ($0.position, $0) }
        )
        let headFromDatabase = resolved.head.source == .database
        let headEntry = ProviderChainEntryDTO(
            position: 0,
            source: resolved.head.source.rawValue,
            mode: resolved.head.config.mode.rawValue,
            baseUrl: resolved.head.config.baseURL,
            endpointLabel: AgentProviderConfig.redactedEndpointLabel(resolved.head.config.baseURL),
            enabled: true,
            bearerConfigured: resolved.head.config.keyConfigured,
            bearerUnavailable: headFromDatabase && resolved.decryptedHead == nil,
            bearerLast4: headFromDatabase
                ? resolved.decryptedHead.flatMap { ProviderLinkCrypto.maskedTail($0.bearer) }
                : nil,
            updatedAtMs: headFromDatabase ? storedLink?.updatedAtMs : nil,
            updatedBy: headFromDatabase ? storedLink?.updatedByMemberID?.uuidString : nil
        )
        let fallbackEntries = storedChain.map { stored -> ProviderChainEntryDTO in
            let decrypted = decryptedByPosition[stored.position]
            return ProviderChainEntryDTO(
                position: stored.position,
                source: ProviderCascadeHop.Source.chain.rawValue,
                mode: stored.mode,
                baseUrl: stored.baseURL,
                endpointLabel: AgentProviderConfig.redactedEndpointLabel(stored.baseURL),
                enabled: stored.enabled,
                bearerConfigured: decrypted != nil,
                bearerUnavailable: decrypted == nil,
                bearerLast4: decrypted.flatMap { ProviderLinkCrypto.maskedTail($0.bearer) },
                updatedAtMs: stored.updatedAtMs,
                updatedBy: stored.updatedByMemberID?.uuidString
            )
        }
        let entries = [headEntry] + fallbackEntries
        return ProviderChainResponse(
            schema: "momo.provider_link.chain.v0",
            entries: entries,
            fallbackCount: entries.count - 1,
            // The hops a real turn would actually attempt, in order — the single
            // number that answers "does this instance have a fallback at all?".
            attemptableCount: ProviderCascade.attemptable(resolved.hops).count
        )
    }

    // MARK: - Validation

    /// Pure validation of the replace-all body. Unit-tested without a DB.
    static func validatedChainEntries(
        _ raw: [PutProviderChainRequest.Entry],
        environmentName: String,
        allowLocalLoopback: Bool
    ) throws -> [ProviderChainEntryInput] {
        guard raw.count <= maxChainEntries else {
            throw HTTPError(
                .badRequest,
                message: "chain may hold at most \(maxChainEntries) fallback entries"
            )
        }
        var seen = Set<Int>()
        var result: [ProviderChainEntryInput] = []
        for entry in raw {
            // Position 0 is the legacy singleton (edited through
            // GET/PUT /v1/provider/link). Accepting it here would create two
            // stores for the same hop and let this endpoint silently overwrite
            // the 583-gated singleton.
            guard entry.position >= 1 else {
                throw HTTPError(
                    .badRequest,
                    message: "position must be >= 1 (position 0 is the provider link singleton)"
                )
            }
            guard seen.insert(entry.position).inserted else {
                throw HTTPError(.badRequest, message: "duplicate chain position \(entry.position)")
            }
            let baseURL = try AgentRoutes.validatedBaseURL(
                entry.baseUrl,
                environmentName: environmentName,
                allowLocalLoopback: allowLocalLoopback
            )
            var bearer: String?
            if let raw = entry.bearer {
                let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else {
                    throw HTTPError(
                        .badRequest,
                        message: "bearer must not be empty at position \(entry.position)"
                    )
                }
                bearer = trimmed
            }
            result.append(ProviderChainEntryInput(
                position: entry.position,
                baseURL: baseURL,
                bearer: bearer,
                mode: try resolvedMode(entry.mode),
                enabled: entry.enabled ?? true
            ))
        }
        return result.sorted { $0.position < $1.position }
    }

    func validatedChainEntries(
        _ raw: [PutProviderChainRequest.Entry]
    ) throws -> [ProviderChainEntryInput] {
        try Self.validatedChainEntries(
            raw,
            environmentName: environmentName,
            allowLocalLoopback: allowLocalLoopback
        )
    }

    // MARK: - Audit

    static func writeChainAudit(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        actorMemberID: UUID,
        viaTokenID: UUID,
        action: String,
        positions: [Int],
        endpointLabels: [String]
    ) async throws {
        let detail = ProviderChainAuditDetail(
            schema: "momo.provider_link_chain.audit.v1",
            positions: positions,
            endpointLabels: endpointLabels
        )
        let json = String(
            decoding: try JSONEncoder().encode(detail), as: UTF8.self
        )
        _ = try await conn.query(
            """
            INSERT INTO audit_log
              (workspace_id, actor_member_id, action, target_type, target_id,
               via_token_id, detail)
            VALUES
              (\(workspaceID), \(actorMemberID), \(action), 'provider_link_chain', NULL,
               \(viaTokenID), \(json)::jsonb)
            """,
            logger: logger
        )
    }
}

// MARK: - DTOs

struct ProviderChainResponse: ResponseEncodable, Encodable, Sendable {
    let schema: String
    /// The whole cascade in attempt order, position 0 first.
    let entries: [ProviderChainEntryDTO]
    /// Configured fallback hops (entries beyond position 0).
    let fallbackCount: Int
    /// Hops a real turn would actually attempt (enabled AND usable).
    let attemptableCount: Int
}

/// One projected cascade hop. Carries a masked bearer tail only — never the
/// bearer itself (ADR-0004).
struct ProviderChainEntryDTO: Encodable, Sendable {
    let position: Int
    let source: String
    let mode: String
    let baseUrl: String
    let endpointLabel: String
    let enabled: Bool
    let bearerConfigured: Bool
    /// The row exists but its ciphertext cannot be opened with the configured
    /// master key. It remains visible so a replace-all PUT cannot erase it.
    let bearerUnavailable: Bool
    let bearerLast4: String?
    let updatedAtMs: Int64?
    let updatedBy: String?
}

private struct ProviderChainAuditDetail: Encodable {
    let schema: String
    let positions: [Int]
    let endpointLabels: [String]

    private enum CodingKeys: String, CodingKey {
        case schema
        case positions
        case endpointLabels = "endpoint_labels"
    }
}

/// Closed-world replace-all body. Only `entries[]` with
/// position / baseUrl / bearer / mode / enabled are accepted; any other key
/// (including any Codex/OpenAI OAuth or raw-provider-key field) is rejected,
/// upholding ADR-0004 Rules #1-#2.
struct PutProviderChainRequest: Decodable, Sendable {
    let entries: [Entry]

    struct Entry: Decodable, Sendable {
        let position: Int
        let baseUrl: String
        /// Write-only. Absent means "keep the bearer already stored at this
        /// position" — the operator can reorder or park a hop without re-typing
        /// a secret the API can never show them again.
        let bearer: String?
        let mode: String?
        let enabled: Bool?

        private enum CodingKeys: String, CodingKey, CaseIterable {
            case position
            case baseUrl
            case bearer
            case mode
            case enabled
        }

        init(from decoder: Decoder) throws {
            let dynamic = try decoder.container(keyedBy: ProviderChainCodingKey.self)
            let allowed = Set(CodingKeys.allCases.map(\.rawValue))
            let unknown = dynamic.allKeys.map(\.stringValue).filter { !allowed.contains($0) }
            guard unknown.isEmpty else {
                throw DecodingError.dataCorruptedError(
                    forKey: unknown.sorted().first.map(ProviderChainCodingKey.init)!,
                    in: dynamic,
                    debugDescription: "unknown provider-chain field"
                )
            }
            let values = try decoder.container(keyedBy: CodingKeys.self)
            position = try values.decode(Int.self, forKey: .position)
            baseUrl = try values.decode(String.self, forKey: .baseUrl)
            bearer = try values.decodeIfPresent(String.self, forKey: .bearer)
            mode = try values.decodeIfPresent(String.self, forKey: .mode)
            enabled = try values.decodeIfPresent(Bool.self, forKey: .enabled)
        }

        /// Test/documentation initializer — the wire path always goes through
        /// the closed-world `init(from:)` above.
        init(position: Int, baseUrl: String, bearer: String?, mode: String?, enabled: Bool?) {
            self.position = position
            self.baseUrl = baseUrl
            self.bearer = bearer
            self.mode = mode
            self.enabled = enabled
        }
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case entries
    }

    init(from decoder: Decoder) throws {
        let dynamic = try decoder.container(keyedBy: ProviderChainCodingKey.self)
        let allowed = Set(CodingKeys.allCases.map(\.rawValue))
        let unknown = dynamic.allKeys.map(\.stringValue).filter { !allowed.contains($0) }
        guard unknown.isEmpty else {
            throw DecodingError.dataCorruptedError(
                forKey: unknown.sorted().first.map(ProviderChainCodingKey.init)!,
                in: dynamic,
                debugDescription: "unknown provider-chain field"
            )
        }
        let values = try decoder.container(keyedBy: CodingKeys.self)
        entries = try values.decode([Entry].self, forKey: .entries)
    }
}

private struct ProviderChainCodingKey: CodingKey, Hashable {
    let stringValue: String
    let intValue: Int? = nil

    init(_ stringValue: String) { self.stringValue = stringValue }
    init?(stringValue: String) { self.init(stringValue) }
    init?(intValue: Int) { self.stringValue = String(intValue) }
}
