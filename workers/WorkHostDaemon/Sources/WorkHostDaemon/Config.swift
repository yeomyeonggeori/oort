import Foundation

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
    let displayName: String
    let pollInterval: Duration
    let heartbeatInterval: Duration
    let localCommandOverrides: [String: LocalCommandOverride]
    let childEnvironmentPolicy: ChildEnvironmentPolicy
    let allowProfileLegacyEnvironment: Bool
    let registrationTokenURL: URL?
    var registrationToken: String?

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
        let localCommandOverrides = try localCommandOverrides(environment: environment)
        let childEnvironmentPolicy = try childEnvironmentPolicy(environment: environment)
        let allowProfileLegacyEnvironment = environment["MOMO_WORKD_ALLOW_PROFILE_LEGACY_ENV"] == "1"

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

        return WorkdConfig(
            serverURL: serverURL,
            workspaceID: workspaceID,
            keyURL: keyURL,
            hostIDURL: hostIDURL,
            outputDirectory: outputDirectory,
            scope: scope,
            displayName: displayName,
            pollInterval: .milliseconds(pollMs),
            heartbeatInterval: .milliseconds(heartbeatMs),
            localCommandOverrides: localCommandOverrides,
            childEnvironmentPolicy: childEnvironmentPolicy,
            allowProfileLegacyEnvironment: allowProfileLegacyEnvironment,
            registrationTokenURL: registrationTokenURL,
            registrationToken: registrationToken
        )
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
