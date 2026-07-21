import Foundation

enum ConfigError: Error, Equatable {
    case missingTargetBaseURL
    case invalidPort(String)
}

struct Config: Sendable, Equatable {
    static let defaultPort = 28_190
    static let defaultHost = "127.0.0.1"

    let targetBaseURL: String
    let host: String
    let port: Int

    static func load(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) throws -> Config {
        guard let rawTarget = environment["MOMO_LINKSHORT_TARGET_BASE_URL"]?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !rawTarget.isEmpty
        else {
            throw ConfigError.missingTargetBaseURL
        }

        var target = rawTarget
        while target.last == "/" {
            target.removeLast()
        }
        guard !target.isEmpty else {
            throw ConfigError.missingTargetBaseURL
        }
        let port: Int
        if let rawPort = environment["MOMO_LINKSHORT_PORT"] {
            guard let parsed = Int(rawPort), (1...65_535).contains(parsed) else {
                throw ConfigError.invalidPort(rawPort)
            }
            port = parsed
        } else {
            port = defaultPort
        }

        let host = environment["MOMO_LINKSHORT_HOST"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return Config(
            targetBaseURL: target,
            host: host.flatMap { $0.isEmpty ? nil : $0 } ?? defaultHost,
            port: port
        )
    }
}
