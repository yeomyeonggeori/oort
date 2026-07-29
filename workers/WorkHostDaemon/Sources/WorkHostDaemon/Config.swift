import Foundation
import MomoACPHost

#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

enum WorkTransport: String, Sendable, Equatable {
    case pty
    case acp
}

enum ChildEnvironmentMode: String, Sendable, Equatable {
    case allowlist
    case legacy
}

struct ChildEnvironmentPolicy: Sendable, Equatable {
    static let safeDefault = ChildEnvironmentPolicy(mode: .allowlist, passthrough: [])

    let mode: ChildEnvironmentMode
    let passthrough: Set<String>

    func filtered(_ environment: [String: String]) -> [String: String] {
        environment.filter { key, _ in
            guard !key.hasPrefix("MOMO_WORKD_") else { return false }
            if mode == .legacy { return true }
            return Self.baseAllowlist.contains(key)
                || key.hasPrefix("LC_")
                || passthrough.contains(key)
        }
    }

    private static let baseAllowlist: Set<String> = [
        "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM",
        "COLORTERM", "TMPDIR",
    ]
}

struct CommandTemplate: Sendable, Equatable {
    let executable: String
    let arguments: [String]
    let transport: WorkTransport
    let environmentPolicy: ChildEnvironmentPolicy

    init(
        executable: String,
        arguments: [String],
        transport: WorkTransport = .pty,
        environmentPolicy: ChildEnvironmentPolicy = .safeDefault
    ) {
        self.executable = executable
        self.arguments = arguments
        self.transport = transport
        self.environmentPolicy = environmentPolicy
    }
}

struct LocalCommandOverride: Sendable, Equatable {
    let executable: String
    let arguments: [String]?
}

struct WorkdConfig: Sendable {
    let serverURL: URL
    let workspaceID: UUID
    let keyURL: URL
    let hostIDURL: URL
    let outputDirectory: URL
    let scope: String
    let hostType: String
    let displayName: String
    let pollInterval: Duration
    let heartbeatInterval: Duration
    let ringBufferBytes: Int
    /// MOMO-661 per-attach-subscriber pending-queue bound. A stalled attach
    /// client is severed with `.overflow` once it exceeds this; it never grows
    /// daemon memory beyond it. Clamped to at least `ringBufferBytes` by
    /// `PTYReplayBuffer` so the attach replay always fits.
    let subscriberQueueBytes: Int
    let localCommandOverrides: [String: LocalCommandOverride]
    let childEnvironmentPolicy: ChildEnvironmentPolicy
    let allowProfileLegacyEnvironment: Bool
    let registrationTokenURL: URL?
    var registrationToken: String?
    /// MOMO-655. Nil means this host serves no direct terminal attach: no
    /// listener is bound, no `attach_endpoint` is published, and every session
    /// it starts reports `remote_attach_available: false` exactly as before.
    /// Attach is opt-in because it is the one thing a work host does that a
    /// browser on someone else's machine dials directly.
    let terminalAttach: TerminalAttachConfig?
    /// WH-1 (ADR-0114 증보1 B): the sidecar-driven engine this host launches.
    /// Boot default is opencode; a DB-backed server setting (migration 040) wins
    /// over env at dispatch time via `resolveEngine`.
    let engine: WorkEngine

    static func load(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) throws -> WorkdConfig {
        guard let rawServerURL = nonempty(environment["MOMO_WORKD_SERVER_URL"]),
              let serverURL = URL(string: rawServerURL),
              let scheme = serverURL.scheme?.lowercased(),
              (scheme == "https" || scheme == "http"),
              serverURL.host != nil
        else { throw WorkdFailure.configuration }
        if scheme == "http" {
            guard environment["MOMO_WORKD_ALLOW_INSECURE_HTTP"] == "1",
                  isLoopback(serverURL.host ?? "")
            else { throw WorkdFailure.configuration }
        }
        guard let workspaceID = UUID(
            uuidString: nonempty(environment["MOMO_WORKD_WORKSPACE_ID"]) ?? ""
        ) else { throw WorkdFailure.configuration }

        let home = FileManager.default.homeDirectoryForCurrentUser
        let defaultRoot = home.appendingPathComponent(".momo", isDirectory: true)
        let keyURL = URL(fileURLWithPath: environment["MOMO_WORKD_KEY_PATH"]
            ?? defaultRoot.appendingPathComponent("workd.key").path)
        let hostIDURL = URL(fileURLWithPath: environment["MOMO_WORKD_HOST_ID_PATH"]
            ?? defaultRoot.appendingPathComponent("workd.host-id").path)
        let outputDirectory = URL(fileURLWithPath: environment["MOMO_WORKD_OUTPUT_DIR"]
            ?? defaultRoot.appendingPathComponent("workd-output", isDirectory: true).path)
        let scope = (environment["MOMO_WORKD_SCOPE"] ?? "member").lowercased()
        guard scope == "member" || scope == "workspace" else {
            throw WorkdFailure.configuration
        }
        let hostType = (environment["MOMO_WORKD_HOST_TYPE"] ?? "workd").lowercased()
        guard hostType == "workd" || hostType == "cloud" else {
            throw WorkdFailure.configuration
        }
        guard hostType != "cloud" || scope == "workspace" else {
            throw WorkdFailure.configuration
        }
        let displayName = nonempty(environment["MOMO_WORKD_DISPLAY_NAME"])
            ?? ProcessInfo.processInfo.hostName
        guard displayName.count <= 80 else { throw WorkdFailure.configuration }

        let pollMs = try boundedMilliseconds(
            environment["MOMO_WORKD_POLL_INTERVAL_MS"],
            defaultValue: 1_000,
            range: 100...60_000
        )
        let heartbeatMs = try boundedMilliseconds(
            environment["MOMO_WORKD_HEARTBEAT_INTERVAL_MS"],
            defaultValue: 30_000,
            range: 1_000...90_000
        )
        let ringBufferBytes = try boundedInteger(
            environment["MOMO_WORKD_PTY_RING_BYTES"],
            defaultValue: PTYReplayBuffer.defaultCapacityBytes,
            range: 4_096...(16 * 1_024 * 1_024)
        )
        let subscriberQueueBytes = try boundedInteger(
            environment["MOMO_WORKD_PTY_SUBSCRIBER_QUEUE_BYTES"],
            defaultValue: ringBufferBytes
                * PTYReplayBuffer.defaultSubscriberQueueMultiple,
            range: 4_096...(64 * 1_024 * 1_024)
        )
        let localCommandOverrides = try localCommandOverrides(environment: environment)
        let childEnvironmentPolicy = try childEnvironmentPolicy(environment: environment)
        let allowProfileLegacyEnvironment = environment["MOMO_WORKD_ALLOW_PROFILE_LEGACY_ENV"] == "1"
        // A set-but-invalid engine is a configuration error (fail closed); unset
        // falls back to the WH-1 default (opencode).
        let engine: WorkEngine
        if let raw = nonempty(environment["MOMO_WORKD_ENGINE"]) {
            guard let parsed = WorkEngine(rawValue: raw) else { throw WorkdFailure.configuration }
            engine = parsed
        } else {
            engine = .default
        }

        let directRegistrationToken = nonempty(environment["MOMO_WORKD_REGISTRATION_TOKEN"])
        let registrationTokenURL = nonempty(
            environment["MOMO_WORKD_REGISTRATION_TOKEN_FILE"]
        ).map(URL.init(fileURLWithPath:))
        guard directRegistrationToken == nil || registrationTokenURL == nil else {
            throw WorkdFailure.configuration
        }
        let registrationToken = try registrationTokenURL.map {
            try SecureLocalStore.readOptionalSecret(at: $0)
        } ?? directRegistrationToken

        let terminalAttach = try terminalAttachConfig(environment: environment)

        return WorkdConfig(
            serverURL: serverURL,
            workspaceID: workspaceID,
            keyURL: keyURL,
            hostIDURL: hostIDURL,
            outputDirectory: outputDirectory,
            scope: scope,
            hostType: hostType,
            displayName: displayName,
            pollInterval: .milliseconds(pollMs),
            heartbeatInterval: .milliseconds(heartbeatMs),
            ringBufferBytes: ringBufferBytes,
            subscriberQueueBytes: subscriberQueueBytes,
            localCommandOverrides: localCommandOverrides,
            childEnvironmentPolicy: childEnvironmentPolicy,
            allowProfileLegacyEnvironment: allowProfileLegacyEnvironment,
            registrationTokenURL: registrationTokenURL,
            registrationToken: registrationToken,
            terminalAttach: terminalAttach,
            engine: engine
        )
    }

    /// MOMO-655 attach listener configuration.
    ///
    /// `MOMO_WORKD_ATTACH_PUBLIC_URL` is the switch: without it there is no
    /// listener at all. It is the address CLIENTS dial, which on any real
    /// deployment is a TLS reverse proxy and not this socket — which is why the
    /// bind address defaults to loopback. Setting a non-loopback bind is
    /// allowed (a proxy in another container needs it) but it is the operator
    /// saying so, not a default.
    static func terminalAttachConfig(
        environment: [String: String]
    ) throws -> TerminalAttachConfig? {
        guard let rawEndpoint = nonempty(environment["MOMO_WORKD_ATTACH_PUBLIC_URL"]) else {
            return nil
        }
        guard let publicEndpoint = TerminalAttachConfig.validatedPublicEndpoint(rawEndpoint) else {
            throw WorkdFailure.configuration
        }
        let bindAddress = nonempty(environment["MOMO_WORKD_ATTACH_BIND"])
            ?? TerminalAttachConfig.defaultBindAddress
        var parsedAddress = in_addr()
        guard inet_pton(AF_INET, bindAddress, &parsedAddress) == 1 else {
            throw WorkdFailure.configuration
        }
        let port = try boundedInteger(
            environment["MOMO_WORKD_ATTACH_PORT"],
            defaultValue: Int(TerminalAttachConfig.defaultPort),
            range: 1...65_535
        )
        let maxConnections = try boundedInteger(
            environment["MOMO_WORKD_ATTACH_MAX_CONNECTIONS"],
            defaultValue: TerminalAttachConfig.defaultMaxConnections,
            range: 1...512
        )
        // MOMO-674 stream lifetime policy, deliberately independent of the
        // server's 60 second capability TTL: that TTL bounds mint→dial, this
        // bounds how stale an authorization an OPEN terminal may run on. The
        // floor is one second because the call is a signed round trip, and the
        // ceiling is an hour because past that "we re-check" stops being true.
        let revalidateMs = try boundedInteger(
            environment["MOMO_WORKD_ATTACH_REVALIDATE_INTERVAL_MS"],
            defaultValue: Int(
                TerminalAttachConfig.defaultRevalidateInterval
                    .components.seconds * 1_000
            ),
            range: 1_000...3_600_000
        )
        return TerminalAttachConfig(
            bindAddress: bindAddress,
            port: UInt16(port),
            publicEndpoint: publicEndpoint,
            maxConnections: maxConnections,
            revalidateInterval: .milliseconds(revalidateMs)
        )
    }

    /// Effective engine precedence (ADR-0114 증보1 B, provider_link 패턴):
    /// DB-backed server setting > `MOMO_WORKD_ENGINE` > default (opencode).
    /// An unparseable value at any tier is ignored in favor of the next tier so a
    /// stale/garbage setting never blocks dispatch.
    static func resolveEngine(
        databaseSetting: String?,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> WorkEngine {
        if let raw = nonempty(databaseSetting), let engine = WorkEngine(rawValue: raw) {
            return engine
        }
        if let raw = nonempty(environment["MOMO_WORKD_ENGINE"]), let engine = WorkEngine(rawValue: raw) {
            return engine
        }
        return .default
    }

    static func commandTemplates(
        profiles: [WorkToolProfile],
        localOverrides: [String: LocalCommandOverride],
        hostEnvironmentPolicy: ChildEnvironmentPolicy = .safeDefault,
        allowProfileLegacyEnvironment: Bool = false
    ) throws -> [String: CommandTemplate] {
        var templates: [String: CommandTemplate] = [:]
        for profile in profiles where profile.enabled {
            guard profile.toolKey.wholeMatch(of: /^[a-z0-9][a-z0-9._-]{1,63}$/) != nil,
                  profile.launchTemplate.command.wholeMatch(of: /^[a-z0-9][a-z0-9._-]{0,63}$/) != nil,
                  profile.launchTemplate.arguments.count <= 64,
                  profile.launchTemplate.arguments.allSatisfy({ $0.count <= 4_096 })
            else { throw WorkdFailure.invalidResponse }
            let transport: WorkTransport
            if let rawTransport = profile.tierDefaults.objectValue?["transport"]?.stringValue {
                guard let parsed = WorkTransport(rawValue: rawTransport) else {
                    throw WorkdFailure.invalidResponse
                }
                transport = parsed
            } else {
                transport = .pty
            }
            let profileEnvironmentPolicy = try environmentPolicy(
                profile.envPolicy,
                hostPolicy: hostEnvironmentPolicy,
                allowLegacy: allowProfileLegacyEnvironment
            )
            if let override = localOverrides[profile.toolKey] {
                templates[profile.toolKey] = CommandTemplate(
                    executable: override.executable,
                    arguments: override.arguments ?? profile.launchTemplate.arguments,
                    transport: transport,
                    environmentPolicy: profileEnvironmentPolicy
                )
            } else {
                templates[profile.toolKey] = CommandTemplate(
                    executable: "/usr/bin/env",
                    arguments: [profile.launchTemplate.command] + profile.launchTemplate.arguments,
                    transport: transport,
                    environmentPolicy: profileEnvironmentPolicy
                )
            }
        }
        return templates
    }

    static func childEnvironmentPolicy(
        environment: [String: String]
    ) throws -> ChildEnvironmentPolicy {
        let rawMode = nonempty(environment["MOMO_WORKD_CHILD_ENV_MODE"]) ?? "allowlist"
        guard let mode = ChildEnvironmentMode(rawValue: rawMode.lowercased()) else {
            throw WorkdFailure.configuration
        }
        let passthrough = try environmentKeys(
            nonempty(environment["MOMO_WORKD_ENV_PASSTHROUGH"])?
                .split(separator: ",", omittingEmptySubsequences: false)
                .map(String.init) ?? [],
            failure: .configuration
        )
        return ChildEnvironmentPolicy(mode: mode, passthrough: passthrough)
    }

    private static func environmentPolicy(
        _ raw: JSONValue,
        hostPolicy: ChildEnvironmentPolicy,
        allowLegacy: Bool
    ) throws -> ChildEnvironmentPolicy {
        guard let object = raw.objectValue,
              Set(object.keys).isSubset(of: ["mode", "passthrough"])
        else { throw WorkdFailure.invalidResponse }
        let requestedMode: ChildEnvironmentMode
        if let value = object["mode"] {
            guard let rawMode = value.stringValue,
                  let mode = ChildEnvironmentMode(rawValue: rawMode)
            else { throw WorkdFailure.invalidResponse }
            requestedMode = mode
        } else {
            requestedMode = .allowlist
        }
        let profileKeys: Set<String>?
        if let value = object["passthrough"] {
            guard let values = value.arrayValue else { throw WorkdFailure.invalidResponse }
            let strings = try values.map { value -> String in
                guard let string = value.stringValue else { throw WorkdFailure.invalidResponse }
                return string
            }
            profileKeys = try environmentKeys(strings, failure: .invalidResponse)
        } else {
            profileKeys = nil
        }
        let mode: ChildEnvironmentMode = hostPolicy.mode == .legacy
            || (requestedMode == .legacy && allowLegacy) ? .legacy : .allowlist
        return ChildEnvironmentPolicy(
            mode: mode,
            passthrough: profileKeys.map(hostPolicy.passthrough.intersection)
                ?? hostPolicy.passthrough
        )
    }

    private static func environmentKeys(
        _ rawKeys: [String],
        failure: WorkdFailure
    ) throws -> Set<String> {
        guard rawKeys.count <= 64 else { throw failure }
        var keys = Set<String>()
        for rawKey in rawKeys {
            let key = rawKey.trimmingCharacters(in: .whitespacesAndNewlines)
            guard key.wholeMatch(of: /^[A-Za-z_][A-Za-z0-9_]{0,127}$/) != nil,
                  !key.hasPrefix("MOMO_WORKD_")
            else { throw failure }
            keys.insert(key)
        }
        return keys
    }

    static func localCommandOverrides(
        environment: [String: String]
    ) throws -> [String: LocalCommandOverride] {
        let prefix = "MOMO_WORKD_PROFILE_"
        let executableSuffix = "_EXECUTABLE"
        let argumentSuffix = "_ARGUMENTS_JSON"
        var toolNames = Set<String>()
        for key in environment.keys where key.hasPrefix(prefix) {
            let suffix: String
            if key.hasSuffix(executableSuffix) {
                suffix = executableSuffix
            } else if key.hasSuffix(argumentSuffix) {
                suffix = argumentSuffix
            } else {
                continue
            }
            let start = key.index(key.startIndex, offsetBy: prefix.count)
            let end = key.index(key.endIndex, offsetBy: -suffix.count)
            let tool = key[start..<end].lowercased().replacingOccurrences(of: "_", with: "-")
            guard tool.wholeMatch(of: /^[a-z0-9][a-z0-9._-]{1,63}$/) != nil else {
                throw WorkdFailure.configuration
            }
            toolNames.insert(tool)
        }

        var overrides: [String: LocalCommandOverride] = [:]
        for tool in toolNames {
            let environmentKey = tool.uppercased().replacingOccurrences(of: "-", with: "_")
            let executableKey = "\(prefix)\(environmentKey)\(executableSuffix)"
            guard let executable = nonempty(environment[executableKey]),
                  executable.hasPrefix("/"), executable.count <= 4_096
            else { throw WorkdFailure.configuration }
            let argumentsKey = "\(prefix)\(environmentKey)\(argumentSuffix)"
            let arguments: [String]?
            if let rawArguments = environment[argumentsKey] {
                guard let data = rawArguments.data(using: .utf8),
                      let decoded = try? JSONDecoder().decode([String].self, from: data),
                      decoded.count <= 64,
                      decoded.allSatisfy({ $0.count <= 4_096 })
                else { throw WorkdFailure.configuration }
                arguments = decoded
            } else {
                arguments = nil
            }
            overrides[tool] = LocalCommandOverride(
                executable: executable,
                arguments: arguments
            )
        }
        return overrides
    }

    private static func boundedMilliseconds(
        _ raw: String?,
        defaultValue: Int,
        range: ClosedRange<Int>
    ) throws -> Int {
        let value = raw.flatMap(Int.init) ?? defaultValue
        guard range.contains(value) else { throw WorkdFailure.configuration }
        return value
    }

    private static func boundedInteger(
        _ raw: String?,
        defaultValue: Int,
        range: ClosedRange<Int>
    ) throws -> Int {
        guard let raw = nonempty(raw) else { return defaultValue }
        guard let value = Int(raw), range.contains(value) else {
            throw WorkdFailure.configuration
        }
        return value
    }

    private static func nonempty(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func isLoopback(_ host: String) -> Bool {
        let normalized = host.lowercased()
        return normalized == "localhost" || normalized == "127.0.0.1" || normalized == "::1"
    }
}
