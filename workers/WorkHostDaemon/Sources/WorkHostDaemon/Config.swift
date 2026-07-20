import Foundation

struct CommandTemplate: Sendable, Equatable {
    let executable: String
    let arguments: [String]
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
    let commandTemplates: [String: CommandTemplate]
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
        var templates: [String: CommandTemplate] = [:]
        for tool in ["claude", "codex", "opencode", "shell"] {
            templates[tool] = try commandTemplate(tool: tool, environment: environment)
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
            commandTemplates: templates,
            registrationTokenURL: registrationTokenURL,
            registrationToken: registrationToken
        )
    }

    private static func commandTemplate(
        tool: String,
        environment: [String: String]
    ) throws -> CommandTemplate {
        let prefix = "MOMO_WORKD_PROFILE_\(tool.uppercased())"
        let fallback: CommandTemplate = tool == "shell"
            ? CommandTemplate(executable: "/bin/sh", arguments: [])
            : CommandTemplate(executable: "/usr/bin/env", arguments: [tool])
        let executable = nonempty(environment["\(prefix)_EXECUTABLE"])
            ?? fallback.executable
        guard executable.hasPrefix("/"), executable.count <= 4_096 else {
            throw WorkdFailure.configuration
        }
        guard let rawArguments = environment["\(prefix)_ARGUMENTS_JSON"] else {
            return CommandTemplate(executable: executable, arguments: fallback.arguments)
        }
        guard let data = rawArguments.data(using: .utf8),
              let arguments = try? JSONDecoder().decode([String].self, from: data),
              arguments.count <= 64,
              arguments.allSatisfy({ $0.count <= 4_096 })
        else { throw WorkdFailure.configuration }
        return CommandTemplate(executable: executable, arguments: arguments)
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
