import AsyncHTTPClient
import Foundation

/// Process-level T3 configuration, shared by MomoServer and NotifierWorker so
/// the two agree on which adapters are installed.
///
/// ADR-0142 D4: there is no provider-named setting any more. `MOMO_T3_PROVIDER`
/// names the adapter used for *new* managed hosts, and every managed provider
/// reads its own `MOMO_T3_PROVIDER_<ID>_*` namespace. Endpoints are loaded for
/// every registered adapter, not just the default one: `work_cloud_host.provider`
/// is a registry key, so an already-registered host must stay actionable even
/// after the operator points new provisioning somewhere else.
public struct CloudProviderSettings: Sendable, Equatable {
    /// Default when `MOMO_T3_PROVIDER` is unset. BYOC is ADR-0142 D1's base
    /// form: it needs no operator credential at all.
    public static let fallbackProviderID = CloudProviderRegistry.byocProviderID

    public let enabled: Bool
    /// Adapter used for newly provisioned managed hosts.
    public let defaultProviderID: String
    /// Connection material per registered managed provider.
    public let endpoints: [String: CloudProviderEndpoint]
    public let publicServerURL: String?
    public let unitRateMicroUSDSecond: Int64

    public init(
        enabled: Bool,
        defaultProviderID: String,
        endpoints: [String: CloudProviderEndpoint],
        publicServerURL: String?,
        unitRateMicroUSDSecond: Int64
    ) {
        self.enabled = enabled
        self.defaultProviderID = defaultProviderID
        self.endpoints = endpoints
        self.publicServerURL = publicServerURL
        self.unitRateMicroUSDSecond = unitRateMicroUSDSecond
    }

    /// `mock-a` → `MOMO_T3_PROVIDER_MOCK_A_API_KEY`. Every non-alphanumeric
    /// character folds to `_` so a registry id is always a legal env prefix.
    public static func environmentNamespace(for providerID: String) -> String {
        let folded = providerID.uppercased().map { character -> Character in
            character.isLetter || character.isNumber ? character : "_"
        }
        return "MOMO_T3_PROVIDER_" + String(folded)
    }

    public static func load(environment: [String: String]) -> CloudProviderSettings {
        func nonempty(_ key: String) -> String? {
            guard let value = environment[key]?
                .trimmingCharacters(in: .whitespacesAndNewlines),
                  !value.isEmpty
            else { return nil }
            return value
        }
        let rate = nonempty("MOMO_T3_RATE_MICRO_USD_PER_SECOND").flatMap(Int64.init) ?? 25
        var endpoints: [String: CloudProviderEndpoint] = [:]
        for providerID in CloudProviderRegistry.registeredProviderIDs {
            let namespace = environmentNamespace(for: providerID)
            guard let apiBaseURL = nonempty("\(namespace)_API_BASE_URL"),
                  let apiKey = nonempty("\(namespace)_API_KEY")
            else { continue }
            let timeout = nonempty("\(namespace)_INSTANCE_TIMEOUT_SECONDS")
                .flatMap(Int.init) ?? 3_600
            endpoints[providerID] = CloudProviderEndpoint(
                apiBaseURL: apiBaseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/")),
                apiKey: apiKey,
                imageRef: nonempty("\(namespace)_IMAGE_REF") ?? "momo-workd",
                instanceTimeoutSeconds: min(max(timeout, 60), 86_400)
            )
        }
        return CloudProviderSettings(
            enabled: nonempty("MOMO_T3_ENABLED") == "1",
            defaultProviderID: (nonempty("MOMO_T3_PROVIDER") ?? fallbackProviderID)
                .lowercased(),
            endpoints: endpoints,
            publicServerURL: nonempty("MOMO_PUBLIC_BASE_URL"),
            unitRateMicroUSDSecond: max(rate, 1)
        )
    }

    /// Fail closed before any durable intent is written. Degenerate providers
    /// (BYOC) legitimately have no endpoint; managed ones must have a complete
    /// one or T3 stays shut.
    public func requireReady() throws -> ReadyCloudProviderSettings {
        guard enabled else { throw CloudProviderConfigError.disabled }
        let capabilities = try CloudProviderRegistry.capabilities(for: defaultProviderID)
        guard let publicServerURL,
              let url = URL(string: publicServerURL),
              url.scheme?.lowercased() == "https",
              url.host != nil
        else { throw CloudProviderConfigError.invalidPublicServerURL }
        var validated: [String: CloudProviderEndpoint] = [:]
        for (providerID, endpoint) in endpoints {
            guard let apiURL = URL(string: endpoint.apiBaseURL),
                  let scheme = apiURL.scheme?.lowercased(),
                  scheme == "https" || scheme == "http",
                  apiURL.host != nil
            else { throw CloudProviderConfigError.invalidAPIBaseURL }
            validated[providerID] = endpoint
        }
        if capabilities.managesInstanceLifetime, validated[defaultProviderID] == nil {
            throw CloudProviderConfigError.missingEndpoint(defaultProviderID)
        }
        return ReadyCloudProviderSettings(
            defaultCapabilities: capabilities,
            endpoints: validated,
            publicServerURL: publicServerURL.trimmingCharacters(
                in: CharacterSet(charactersIn: "/")
            ),
            unitRateMicroUSDSecond: unitRateMicroUSDSecond
        )
    }
}

/// Connection material for a managed provider. The API key is process-only.
public struct CloudProviderEndpoint: Sendable, Equatable {
    public let apiBaseURL: String
    public let apiKey: String
    /// Operator-owned image whose entrypoint launches `momo-workd`.
    public let imageRef: String
    public let instanceTimeoutSeconds: Int

    public init(
        apiBaseURL: String,
        apiKey: String,
        imageRef: String,
        instanceTimeoutSeconds: Int
    ) {
        self.apiBaseURL = apiBaseURL
        self.apiKey = apiKey
        self.imageRef = imageRef
        self.instanceTimeoutSeconds = instanceTimeoutSeconds
    }
}

public struct ReadyCloudProviderSettings: Sendable, Equatable {
    /// Capabilities of the adapter that will own newly provisioned hosts.
    public let defaultCapabilities: CloudProviderCapabilities
    public let endpoints: [String: CloudProviderEndpoint]
    public let publicServerURL: String
    public let unitRateMicroUSDSecond: Int64

    public var defaultProviderID: String { defaultCapabilities.providerID }

    public init(
        defaultCapabilities: CloudProviderCapabilities,
        endpoints: [String: CloudProviderEndpoint],
        publicServerURL: String,
        unitRateMicroUSDSecond: Int64
    ) {
        self.defaultCapabilities = defaultCapabilities
        self.endpoints = endpoints
        self.publicServerURL = publicServerURL
        self.unitRateMicroUSDSecond = unitRateMicroUSDSecond
    }

    public func capabilities(
        for providerID: String
    ) throws -> CloudProviderCapabilities {
        try CloudProviderRegistry.capabilities(for: providerID)
    }

    /// Build the adapter that owns an *existing* host, addressed by the
    /// `work_cloud_host.provider` registry key rather than by whatever the
    /// process happens to provision with today.
    public func adapter(
        for providerID: String,
        httpClient: HTTPClient
    ) throws -> any CloudProviderAdapter {
        let capabilities = try CloudProviderRegistry.capabilities(for: providerID)
        guard capabilities.managesInstanceLifetime else {
            return BYOCProviderAdapter(capabilities: capabilities)
        }
        guard let endpoint = endpoints[providerID] else {
            throw CloudProviderConfigError.missingEndpoint(providerID)
        }
        return HTTPCloudProviderAdapter(
            capabilities: capabilities,
            endpoint: endpoint,
            publicServerURL: publicServerURL,
            httpClient: httpClient
        )
    }

    public func defaultAdapter(
        httpClient: HTTPClient
    ) throws -> any CloudProviderAdapter {
        try adapter(for: defaultProviderID, httpClient: httpClient)
    }

    /// Deterministic one-shot bootstrap secret source for a managed provider.
    /// A lost create response must be able to replay the same token instead of
    /// minting a second one; degenerate providers have no such response to
    /// lose and use a random enrollment token instead.
    public func bootstrapSecret(for providerID: String) -> String? {
        endpoints[providerID]?.apiKey
    }
}

public enum CloudProviderConfigError: Error, Sendable, Equatable {
    case disabled
    case unknownProvider(String)
    case missingEndpoint(String)
    case invalidPublicServerURL
    case invalidAPIBaseURL
}
