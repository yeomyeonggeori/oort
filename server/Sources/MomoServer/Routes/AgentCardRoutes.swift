import AsyncHTTPClient
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif
import Foundation
import HTTPTypes
import Hummingbird
import Logging
import PostgresNIO

enum AgentCardFetchError: Error, Equatable, Sendable {
    case invalidURL
    case insecureHTTP
    case privateAddress
    case resolutionFailed
    case redirectMissingLocation
    case tooManyRedirects
    case upstreamStatus(Int)
    case responseTooLarge
    case requestFailed
    case invalidCard(String)
}

struct AgentCardHTTPResponse: Sendable {
    let status: Int
    let location: String?
    let body: Data
}

protocol AgentCardHTTPTransport: Sendable {
    func get(_ url: URL, resolvedAddress: String) async throws -> AgentCardHTTPResponse
}

protocol AgentCardHostResolving: Sendable {
    func resolve(host: String) async throws -> [String]
}

struct SystemAgentCardHostResolver: AgentCardHostResolving {
    func resolve(host: String) async throws -> [String] {
        try await Task.detached(priority: .utility) {
            var hints = addrinfo(
                ai_flags: AI_ADDRCONFIG,
                ai_family: AF_UNSPEC,
                ai_socktype: SOCK_STREAM,
                ai_protocol: IPPROTO_TCP,
                ai_addrlen: 0,
                ai_canonname: nil,
                ai_addr: nil,
                ai_next: nil
            )
            var result: UnsafeMutablePointer<addrinfo>?
            guard getaddrinfo(host, nil, &hints, &result) == 0, let first = result else {
                throw AgentCardFetchError.resolutionFailed
            }
            defer { freeaddrinfo(first) }

            var addresses: Set<String> = []
            var cursor: UnsafeMutablePointer<addrinfo>? = first
            while let current = cursor {
                var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                if getnameinfo(
                    current.pointee.ai_addr,
                    current.pointee.ai_addrlen,
                    &buffer,
                    socklen_t(buffer.count),
                    nil,
                    0,
                    NI_NUMERICHOST
                ) == 0 {
                    let end = buffer.firstIndex(of: 0) ?? buffer.endIndex
                    addresses.insert(String(decoding: buffer[..<end].map(UInt8.init), as: UTF8.self))
                }
                cursor = current.pointee.ai_next
            }
            guard !addresses.isEmpty else { throw AgentCardFetchError.resolutionFailed }
            return addresses.sorted()
        }.value
    }
}

struct AsyncAgentCardHTTPTransport: AgentCardHTTPTransport {
    static let maximumBytes = 256 * 1024

    func get(_ url: URL, resolvedAddress: String) async throws -> AgentCardHTTPResponse {
        guard let host = url.host else { throw AgentCardFetchError.invalidURL }
        var configuration = HTTPClient.Configuration()
        configuration.redirectConfiguration = .disallow
        // Pin the connection to the address that passed the complete DNS answer
        // check. AHC keeps the original hostname for Host, TLS SNI, and certificate
        // validation, closing the resolve/check/connect rebinding window.
        configuration.dnsOverride = [host: resolvedAddress]
        let client = HTTPClient(
            eventLoopGroupProvider: .singleton,
            configuration: configuration
        )
        var request = HTTPClientRequest(url: url.absoluteString)
        request.method = .GET
        request.headers.add(name: "Accept", value: "application/json")
        request.headers.add(name: "User-Agent", value: "momo-agent-card/1")
        let response: HTTPClientResponse
        do {
            response = try await client.execute(request, timeout: .seconds(5))
        } catch {
            try? await client.shutdown()
            throw AgentCardFetchError.requestFailed
        }

        if let contentLength = response.headers.first(name: "Content-Length"),
           let count = Int(contentLength), count > Self.maximumBytes {
            try? await client.shutdown()
            throw AgentCardFetchError.responseTooLarge
        }
        let body: Data
        do {
            var buffer = try await response.body.collect(upTo: Self.maximumBytes)
            body = buffer.readData(length: buffer.readableBytes) ?? Data()
        } catch {
            try? await client.shutdown()
            throw AgentCardFetchError.responseTooLarge
        }
        let result = AgentCardHTTPResponse(
            status: Int(response.status.code),
            location: response.headers.first(name: "Location"),
            body: body
        )
        try? await client.shutdown()
        return result
    }
}

struct ParsedAgentCard: Sendable {
    let name: String
    let description: String?
    let agentURL: String
    let capabilities: JSONValue
    let securitySummary: JSONValue
    let rawCard: JSONValue
}

struct SafeAgentCardFetcher<Resolver: AgentCardHostResolving, Transport: AgentCardHTTPTransport>:
    Sendable
{
    static var wellKnownPath: String { "/.well-known/agent-card.json" }
    static var maximumRedirects: Int { 2 }

    let resolver: Resolver
    let transport: Transport
    let allowDevelopmentHTTP: Bool

    func fetch(sourceURL raw: String) async throws -> (cardURL: URL, card: ParsedAgentCard) {
        var current = try Self.cardURL(from: raw, allowDevelopmentHTTP: allowDevelopmentHTTP)
        var redirects = 0
        while true {
            let addresses = try await validateResolvedTarget(current)
            let response = try await transport.get(current, resolvedAddress: addresses[0])
            if (300..<400).contains(response.status) {
                guard redirects < Self.maximumRedirects else {
                    throw AgentCardFetchError.tooManyRedirects
                }
                guard let location = response.location,
                      let target = URL(string: location, relativeTo: current)?.absoluteURL
                else { throw AgentCardFetchError.redirectMissingLocation }
                current = try Self.validatedFetchURL(
                    target, allowDevelopmentHTTP: allowDevelopmentHTTP
                )
                redirects += 1
                continue
            }
            guard response.status == 200 else {
                throw AgentCardFetchError.upstreamStatus(response.status)
            }
            return (current, try Self.parse(response.body, allowDevelopmentHTTP: allowDevelopmentHTTP))
        }
    }

    func validateResolvedTarget(_ url: URL) async throws -> [String] {
        guard let host = url.host?.lowercased(), !host.isEmpty else {
            throw AgentCardFetchError.invalidURL
        }
        if Self.isDeniedAddress(host) { throw AgentCardFetchError.privateAddress }
        let addresses: [String]
        do { addresses = try await resolver.resolve(host: host) }
        catch { throw AgentCardFetchError.resolutionFailed }
        guard !addresses.isEmpty, addresses.allSatisfy({ !Self.isDeniedAddress($0) }) else {
            throw AgentCardFetchError.privateAddress
        }
        return addresses
    }

    static func cardURL(from raw: String, allowDevelopmentHTTP: Bool) throws -> URL {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: value),
              components.query == nil, components.fragment == nil,
              components.user == nil, components.password == nil,
              let original = components.url
        else { throw AgentCardFetchError.invalidURL }
        let path = original.path
        guard path.isEmpty || path == "/" || path == wellKnownPath else {
            throw AgentCardFetchError.invalidURL
        }
        components.path = wellKnownPath
        guard let url = components.url else { throw AgentCardFetchError.invalidURL }
        return try validatedFetchURL(url, allowDevelopmentHTTP: allowDevelopmentHTTP)
    }

    static func validatedFetchURL(_ url: URL, allowDevelopmentHTTP: Bool) throws -> URL {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(),
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil,
              components.fragment == nil
        else { throw AgentCardFetchError.invalidURL }
        if scheme == "http" {
            guard allowDevelopmentHTTP else { throw AgentCardFetchError.insecureHTTP }
        } else if scheme != "https" {
            throw AgentCardFetchError.invalidURL
        }
        return url
    }

    static func parse(_ data: Data, allowDevelopmentHTTP: Bool) throws -> ParsedAgentCard {
        guard !data.isEmpty, data.count <= AsyncAgentCardHTTPTransport.maximumBytes else {
            throw AgentCardFetchError.responseTooLarge
        }
        let raw: JSONValue
        do { raw = try JSONDecoder().decode(JSONValue.self, from: data) }
        catch { throw AgentCardFetchError.invalidCard("card must be valid JSON") }
        guard case .object(let object) = raw else {
            throw AgentCardFetchError.invalidCard("card must be a JSON object")
        }
        try rejectEmbeddedSecrets(raw, path: "card")
        let name = try boundedString(object["name"], field: "name", maximum: 100)
        let description = try optionalBoundedString(
            object["description"], field: "description", maximum: 2_000
        )
        let agentURL = try boundedString(object["url"], field: "url", maximum: 2_048)
        guard let parsedAgentURL = URL(string: agentURL) else {
            throw AgentCardFetchError.invalidCard("url must be an absolute HTTP(S) URL")
        }
        _ = try validatedFetchURL(
            parsedAgentURL, allowDevelopmentHTTP: allowDevelopmentHTTP
        )
        guard let capabilities = object["capabilities"],
              case .object = capabilities else {
            throw AgentCardFetchError.invalidCard("capabilities must be an object")
        }
        let securitySummary = try summarizedSecurity(
            schemes: object["securitySchemes"], requirements: object["security"]
        )
        return ParsedAgentCard(
            name: name,
            description: description,
            agentURL: agentURL,
            capabilities: capabilities,
            securitySummary: securitySummary,
            rawCard: raw
        )
    }

    static func isDeniedAddress(_ raw: String) -> Bool {
        let host = raw.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if host == "localhost" || host.hasSuffix(".localhost") { return true }

        var ipv4 = in_addr()
        if host.withCString({ inet_pton(AF_INET, $0, &ipv4) }) == 1 {
            let value = UInt32(bigEndian: ipv4.s_addr)
            let a = UInt8((value >> 24) & 0xff)
            let b = UInt8((value >> 16) & 0xff)
            let c = UInt8((value >> 8) & 0xff)
            return a == 0 || a == 10 || a == 127 || a >= 224
                || (a == 100 && (64...127).contains(b))
                || (a == 169 && b == 254)
                || (a == 172 && (16...31).contains(b))
                || (a == 192 && b == 168)
                || (a == 192 && b == 0 && c == 0)
                || (a == 192 && b == 0 && c == 2)
                || (a == 198 && (b == 18 || b == 19 || b == 51))
                || (a == 203 && b == 0 && c == 113)
            }

        var ipv6 = in6_addr()
        if host.withCString({ inet_pton(AF_INET6, $0, &ipv6) }) == 1 {
            let bytes = withUnsafeBytes(of: &ipv6) { Array($0) }
            if bytes.allSatisfy({ $0 == 0 }) { return true }
            if bytes.dropLast().allSatisfy({ $0 == 0 }) && bytes.last == 1 { return true }
            if bytes[0] == 0xff || (bytes[0] & 0xfe) == 0xfc { return true }
            if bytes[0] == 0xfe && (bytes[1] & 0xc0) == 0x80 { return true }
            if bytes[0...3].elementsEqual([0x20, 0x01, 0x0d, 0xb8]) { return true }
            if bytes[0..<10].allSatisfy({ $0 == 0 }) && bytes[10] == 0xff && bytes[11] == 0xff {
                return isDeniedAddress("\(bytes[12]).\(bytes[13]).\(bytes[14]).\(bytes[15])")
            }
            return false
        }
        return false
    }

    private static func boundedString(
        _ value: JSONValue?, field: String, maximum: Int
    ) throws -> String {
        guard let raw = value?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty, raw.utf8.count <= maximum else {
            throw AgentCardFetchError.invalidCard("\(field) is required and must be at most \(maximum) bytes")
        }
        return raw
    }

    private static func optionalBoundedString(
        _ value: JSONValue?, field: String, maximum: Int
    ) throws -> String? {
        guard let value else { return nil }
        guard let raw = value.stringValue else {
            throw AgentCardFetchError.invalidCard("\(field) must be a string")
        }
        let normalized = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard normalized.utf8.count <= maximum else {
            throw AgentCardFetchError.invalidCard("\(field) must be at most \(maximum) bytes")
        }
        return normalized.isEmpty ? nil : normalized
    }

    private static func summarizedSecurity(
        schemes: JSONValue?, requirements: JSONValue?
    ) throws -> JSONValue {
        let allowed = Set(["type", "description", "scheme", "bearerFormat", "in", "name"])
        var summaries: [String: JSONValue] = [:]
        if let schemes {
            guard case .object(let definitions) = schemes else {
                throw AgentCardFetchError.invalidCard("securitySchemes must be an object")
            }
            for (key, value) in definitions {
                guard case .object(let definition) = value else {
                    throw AgentCardFetchError.invalidCard("securitySchemes entries must be objects")
                }
                summaries[key] = .object(definition.filter { allowed.contains($0.key) })
            }
        }
        let safeRequirements: JSONValue
        if let requirements {
            guard case .array = requirements else {
                throw AgentCardFetchError.invalidCard("security must be an array")
            }
            safeRequirements = requirements
        } else {
            safeRequirements = .array([])
        }
        return .object(["schemes": .object(summaries), "requirements": safeRequirements])
    }

    private static func rejectEmbeddedSecrets(_ value: JSONValue, path: String) throws {
        let forbidden = [
            "clientsecret", "access_token", "accesstoken", "refresh_token", "refreshtoken",
            "password", "privatekey", "bearertoken", "apikeyvalue", "credential",
        ]
        switch value {
        case .object(let object):
            for (key, child) in object {
                let normalized = key.lowercased().filter { $0.isLetter || $0.isNumber || $0 == "_" }
                if forbidden.contains(where: { normalized.contains($0) }) {
                    throw AgentCardFetchError.invalidCard("credential-shaped field is forbidden at \(path).\(key)")
                }
                try rejectEmbeddedSecrets(child, path: "\(path).\(key)")
            }
        case .array(let values):
            for (index, child) in values.enumerated() {
                try rejectEmbeddedSecrets(child, path: "\(path)[\(index)]")
            }
        default:
            break
        }
    }
}

protocol AgentCardFetching: Sendable {
    func fetch(sourceURL: String) async throws -> (cardURL: URL, card: ParsedAgentCard)
}

extension SafeAgentCardFetcher: AgentCardFetching {}

struct AgentCardRoutes: Sendable {
    let db: Database
    let fetcher: any AgentCardFetching

    func add(to group: RouterGroup<AppRequestContext>) {
        group.post("/v1/workspaces/:ws/agents/from-card", use: register)
        group.post("/v1/workspaces/:ws/agents/from-card/:registration/confirm", use: confirm)
    }

    @Sendable
    func register(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try requireHumanPrincipal(context)
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        try await ChannelRoutes.requireWorkspaceAdmin(
            db: db, workspaceID: workspaceID, principal: principal
        )
        let input = try await request.decode(as: RegisterAgentCardRequest.self, context: context)
        let fetched: (cardURL: URL, card: ParsedAgentCard)
        do { fetched = try await fetcher.fetch(sourceURL: input.url) }
        catch let error as AgentCardFetchError { throw Self.httpError(for: error) }
        catch { throw HTTPError(.badRequest, message: "agent card fetch failed") }

        let capabilitiesJSON = try jsonString(fetched.card.capabilities)
        let securityJSON = try jsonString(fetched.card.securitySummary)
        let rawJSON = try jsonString(fetched.card.rawCard)
        let sourceURL = input.url.trimmingCharacters(in: .whitespacesAndNewlines)
        let rows = try await db.withTenantTransaction(workspaceID: workspaceID) { conn in
            let role = try await WorkspaceAuthorization.activeRole(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                memberID: principal.memberID
            )
            guard role?.isAdmin == true else {
                throw HTTPError(.forbidden, message: "workspace admin required")
            }
            return try await conn.query(
                """
                INSERT INTO agent_card_registration
                  (workspace_id, source_url, card_url, name, description, agent_url,
                   capabilities, security_schemes, raw_card, created_by)
                VALUES
                  (\(workspaceID), \(sourceURL), \(fetched.cardURL.absoluteString),
                   \(fetched.card.name), \(fetched.card.description), \(fetched.card.agentURL),
                   \(capabilitiesJSON)::jsonb, \(securityJSON)::jsonb, \(rawJSON)::jsonb,
                   \(principal.memberID))
                RETURNING id, created_at
                """,
                logger: db.logger
            ).collect()
        }
        guard let row = rows.first else {
            throw HTTPError(.internalServerError, message: "agent card registration failed")
        }
        let (id, createdAt) = try row.decode((UUID, Date).self)
        var response = try AgentCardRegistrationResponse(registration: .init(
            id: id, status: "pending_consent", name: fetched.card.name,
            description: fetched.card.description, url: fetched.card.agentURL,
            capabilities: fetched.card.capabilities,
            securitySchemes: fetched.card.securitySummary,
            agentMemberId: nil,
            createdAtMs: Int64(createdAt.timeIntervalSince1970 * 1_000),
            confirmedAtMs: nil
        )).response(from: request, context: context)
        response.status = .created
        return response
    }

    @Sendable
    func confirm(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try requireHumanPrincipal(context)
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let registrationID = try registrationID(context)
        let rawToken = AgentBearerToken.mint(workspaceID: workspaceID)
        let label = "A2A card onboarding"
        let scopes = AgentCredentialRoutes.defaultScopes
        let now = Date()

        let result: ConfirmedAgentCard = try await db.withTenantTransaction(
            workspaceID: workspaceID
        ) { conn in
            let role = try await WorkspaceAuthorization.activeRole(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                memberID: principal.memberID
            )
            guard role?.isAdmin == true else {
                throw HTTPError(.forbidden, message: "workspace admin required")
            }
            let registrations = try await conn.query(
                """
                SELECT name, description::text, agent_url, capabilities::text, status
                  FROM agent_card_registration
                 WHERE id = \(registrationID)
                   AND workspace_id = \(workspaceID)
                 FOR UPDATE
                """,
                logger: db.logger
            ).collect()
            guard let registration = registrations.first else {
                throw HTTPError(.notFound, message: "agent card registration not found")
            }
            let (name, description, agentURL, capabilitiesJSON, status) = try registration.decode(
                (String, String?, String, String, String).self
            )
            guard status == "pending_consent" else {
                throw HTTPError(.conflict, message: "agent card registration already confirmed")
            }
            let handle = "card-" + registrationID.uuidString.lowercased().replacingOccurrences(
                of: "-", with: ""
            ).prefix(12)
            let configJSON = try jsonString(.object(["capabilities": try JSONDecoder().decode(
                JSONValue.self, from: Data(capabilitiesJSON.utf8)
            )]))
            let auditExtraJSON = try jsonString(.object([
                "origin": .string("card"),
                "registration_id": .string(registrationID.uuidString.lowercased()),
            ]))
            let creation = try await AgentRoutes.createAgentIdentity(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                actorMemberID: principal.memberID, viaTokenID: principal.tokenID,
                displayName: name, handle: String(handle), model: "a2a-remote",
                baseURL: agentURL, systemPrompt: description, configJSON: configJSON,
                ownerHumanID: principal.memberID, auditExtraJSON: auditExtraJSON
            )
            let agent: AgentMemberDTO
            switch creation {
            case .created(let value): agent = value
            case .duplicateHandle:
                throw HTTPError(.conflict, message: "agent card handle already exists")
            case .invalidOwner:
                throw HTTPError(.badRequest, message: "agent owner is no longer active")
            case .forbidden:
                throw HTTPError(.forbidden, message: "workspace admin required")
            }
            let agentID = agent.id
            let issuance = try await AgentCredentialRoutes.issueCredential(
                conn: conn, logger: db.logger, workspaceID: workspaceID, agentID: agentID,
                createdBy: principal.memberID, viaTokenID: principal.tokenID,
                rawToken: rawToken, scopes: scopes, label: label, expiresAt: nil,
                graceDeadline: now, graceSeconds: 0
            )
            let confirmedRows = try await conn.query(
                """
                UPDATE agent_card_registration
                   SET status = 'confirmed', agent_member_id = \(agentID), confirmed_at = now()
                 WHERE id = \(registrationID) AND workspace_id = \(workspaceID)
                RETURNING confirmed_at
                """,
                logger: db.logger
            ).collect()
            guard let confirmedRow = confirmedRows.first else {
                throw HTTPError(.internalServerError, message: "agent card confirmation failed")
            }
            let confirmedAt = try confirmedRow.decode(Date.self)
            _ = try await conn.query(
                """
                INSERT INTO audit_log
                  (workspace_id, actor_member_id, subject_member_id, action,
                   target_type, target_id, via_token_id, detail)
                VALUES
                  (\(workspaceID), \(principal.memberID), \(agentID),
                   'agent.card.confirmed', 'agent_card_registration', \(registrationID),
                   \(principal.tokenID),
                   jsonb_build_object(
                     'schema', 'momo.agent_card.confirmed.v1',
                     'registration_id', \(registrationID)::text,
                     'credential_id', \(issuance.credential.id)::text
                   ))
                """,
                logger: db.logger
            )
            return ConfirmedAgentCard(
                agent: agent,
                credential: issuance.credential,
                confirmedAt: confirmedAt
            )
        }

        var response = try ConfirmAgentCardResponse(
            registrationId: registrationID,
            status: "confirmed",
            agent: result.agent,
            credential: result.credential,
            token: rawToken,
            tokenType: "Bearer",
            confirmedAtMs: Int64(result.confirmedAt.timeIntervalSince1970 * 1_000)
        ).response(from: request, context: context)
        response.status = .created
        response.headers[.cacheControl] = "no-store"
        response.headers[HTTPField.Name("Pragma")!] = "no-cache"
        return response
    }

    private func requireHumanPrincipal(_ context: AppRequestContext) throws -> AuthPrincipal {
        let principal = try context.requirePrincipal()
        guard principal.kind == .human else {
            throw HTTPError(.forbidden, message: "human workspace admin required")
        }
        return principal
    }

    private func registrationID(_ context: AppRequestContext) throws -> UUID {
        let raw = try context.parameters.require("registration")
        guard let id = UUID(uuidString: raw) else {
            throw HTTPError(.badRequest, message: "invalid agent card registration id")
        }
        return id
    }

    private func jsonString(_ value: JSONValue) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(value)
        guard let string = String(data: data, encoding: .utf8) else {
            throw HTTPError(.badRequest, message: "agent card JSON encoding failed")
        }
        return string
    }

    private static func httpError(for error: AgentCardFetchError) -> HTTPError {
        switch error {
        case .invalidURL:
            HTTPError(.badRequest, message: "url must be an absolute agent origin or /.well-known/agent-card.json URL")
        case .insecureHTTP:
            HTTPError(.badRequest, message: "agent card URL must use HTTPS")
        case .privateAddress:
            HTTPError(.badRequest, message: "agent card URL resolves to a private or non-public address")
        case .resolutionFailed:
            HTTPError(.badRequest, message: "agent card host could not be resolved")
        case .redirectMissingLocation:
            HTTPError(.badRequest, message: "agent card redirect is missing Location")
        case .tooManyRedirects:
            HTTPError(.badRequest, message: "agent card redirect limit exceeded")
        case .upstreamStatus(let status):
            HTTPError(.badRequest, message: "agent card fetch returned HTTP \(status)")
        case .responseTooLarge:
            HTTPError(.badRequest, message: "agent card response exceeds 256KB")
        case .requestFailed:
            HTTPError(.badRequest, message: "agent card fetch failed")
        case .invalidCard(let reason):
            HTTPError(.badRequest, message: "invalid agent card: \(reason)")
        }
    }
}

struct RegisterAgentCardRequest: Decodable, Sendable {
    let url: String

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case url
    }

    init(from decoder: Decoder) throws {
        let dynamic = try decoder.container(keyedBy: AgentCardRequestCodingKey.self)
        let allowed = Set(CodingKeys.allCases.map(\.rawValue))
        let unknown = dynamic.allKeys.map(\.stringValue).filter { !allowed.contains($0) }
        guard unknown.isEmpty else {
            throw DecodingError.dataCorruptedError(
                forKey: AgentCardRequestCodingKey(unknown.sorted()[0]),
                in: dynamic,
                debugDescription: "unknown agent-card registration field"
            )
        }

        let values = try decoder.container(keyedBy: CodingKeys.self)
        url = try values.decode(String.self, forKey: .url)
    }
}

private struct AgentCardRequestCodingKey: CodingKey, Hashable {
    let stringValue: String
    let intValue: Int? = nil

    init(_ stringValue: String) {
        self.stringValue = stringValue
    }

    init?(intValue: Int) {
        return nil
    }

    init?(stringValue: String) {
        self.init(stringValue)
    }
}

struct AgentCardRegistrationDTO: ResponseEncodable, Codable, Sendable {
    let id: UUID
    let status: String
    let name: String
    let description: String?
    let url: String
    let capabilities: JSONValue
    let securitySchemes: JSONValue
    let agentMemberId: UUID?
    let createdAtMs: Int64
    let confirmedAtMs: Int64?
}

struct AgentCardRegistrationResponse: ResponseEncodable, Codable, Sendable {
    let registration: AgentCardRegistrationDTO
}

struct ConfirmAgentCardResponse: ResponseEncodable, Codable, Sendable {
    let registrationId: UUID
    let status: String
    let agent: AgentMemberDTO
    let credential: AgentCredentialDTO
    let token: String
    let tokenType: String
    let confirmedAtMs: Int64
}

private struct ConfirmedAgentCard: Sendable {
    let agent: AgentMemberDTO
    let credential: AgentCredentialDTO
    let confirmedAt: Date
}
