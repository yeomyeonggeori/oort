import Foundation

enum WorkTransport: String, Sendable, Equatable {
    case pty
    case acp
}

struct CommandTemplate: Sendable, Equatable {
    let executable: String
    let arguments: [String]
    let transport: WorkTransport

    init(executable: String, arguments: [String], transport: WorkTransport = .pty) {
        self.executable = executable
        self.arguments = arguments
        self.transport = transport
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
            registrationTokenURL: registrationTokenURL,
            registrationToken: registrationToken
        )
    }

    static func commandTemplates(
        profiles: [WorkToolProfile],
        localOverrides: [String: LocalCommandOverride]
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
            if let override = localOverrides[profile.toolKey] {
                templates[profile.toolKey] = CommandTemplate(
                    executable: override.executable,
                    arguments: override.arguments ?? profile.launchTemplate.arguments,
                    transport: transport
                )
            } else {
                templates[profile.toolKey] = CommandTemplate(
                    executable: "/usr/bin/env",
                    arguments: [profile.launchTemplate.command] + profile.launchTemplate.arguments,
                    transport: transport
                )
            }
        }
        return templates
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
