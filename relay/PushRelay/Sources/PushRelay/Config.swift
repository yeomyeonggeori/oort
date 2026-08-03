// Linux swift-crypto lags CryptoKit's Sendable conformances (Curve25519 keys);
// preconcurrency keeps the strict-concurrency build identical on both OSes.
@preconcurrency import Crypto
import Foundation

enum APNSEnvironment: String, Codable, Sendable {
    case sandbox
    case production

    var endpoint: String {
        switch self {
        case .sandbox: "https://api.sandbox.push.apple.com"
        case .production: "https://api.push.apple.com"
        }
    }
}

enum APNSSenderMode: String, Sendable {
    case live
    case stub
}

enum ConfigError: Error, CustomStringConvertible {
    case missing(String)
    case invalid(String)
    case stubSenderNotAllowed
    case unreadableAPNSKey(String)

    var description: String {
        switch self {
        case .missing(let name): "missing required environment variable: \(name)"
        case .invalid(let detail): "invalid configuration: \(detail)"
        case .stubSenderNotAllowed:
            """
            MOMO_APNS_SENDER=stub never contacts Apple. It answers every dispatch \
            200 with a fabricated apns-id, so the notifier settles the push \
            candidate as delivered and no device is ever woken — a deployment \
            that reports healthy while sending nothing. Set MOMO_APNS_ALLOW_STUB=1 \
            to run the repo verifier deliberately, or leave MOMO_APNS_SENDER=live \
            and supply the APNs key.
            """
        case .unreadableAPNSKey(let path):
            """
            cannot read the APNs signing key at MOMO_APNS_KEY_PATH=\(path). The \
            relay is the only component that holds a .p8 (ADR-0120 D1-A), so a key \
            it cannot open is a relay that cannot deliver. Check the mount path and \
            that the file is readable by the container user.
            """
        }
    }
}

struct RelayConfig: Sendable {
    let host: String
    let port: Int
    let servers: [String: Curve25519.Signing.PublicKey]
    let rateLimitPerMinute: Int
    let senderMode: APNSSenderMode
    let stubCapturePath: String?
    let stubStatus: Int
    let stubReason: String?
    let apnsEnvironment: APNSEnvironment?
    let apnsKeyPath: String?
    let apnsKeyID: String?
    let apnsTeamID: String?

    /// Boot configuration, decided once and entirely from the environment.
    ///
    /// Every path out of this function is either a usable relay or a thrown
    /// error — there is deliberately no third outcome where the process starts
    /// and quietly cannot deliver. Push is the failure mode that hides best: a
    /// relay that accepts dispatches and drops them looks identical, from the
    /// server and from the metrics, to one that works. Both known ways to reach
    /// that state (the stub sender, an unreadable `.p8`) are refusals here.
    ///
    /// `isReadableFile` is injected so the key preflight can be tested without
    /// a real credential on disk.
    static func load(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        isReadableFile: (String) -> Bool = { FileManager.default.isReadableFile(atPath: $0) }
    ) throws -> RelayConfig {
        guard let registryJSON = environment["MOMO_RELAY_SERVERS"], !registryJSON.isEmpty else {
            throw ConfigError.missing("MOMO_RELAY_SERVERS")
        }
        let registry = try decodeRegistry(registryJSON)
        let modeRaw = environment["MOMO_APNS_SENDER"] ?? "live"
        guard let senderMode = APNSSenderMode(rawValue: modeRaw) else {
            throw ConfigError.invalid("MOMO_APNS_SENDER must be live or stub")
        }
        // The stub is a verifier tool, not a deployment mode. Reaching it takes
        // an explicit second variable, mirroring the notifier's
        // MOMO_PUSH_RELAY_ALLOW_UNSIGNED escape hatch (momo-notifier config.rs).
        if senderMode == .stub, environment["MOMO_APNS_ALLOW_STUB"] != "1" {
            throw ConfigError.stubSenderNotAllowed
        }
        let port = try positiveInt(environment["MOMO_PUSH_RELAY_PORT"] ?? "28195", name: "MOMO_PUSH_RELAY_PORT")
        let rate = try positiveInt(environment["MOMO_PUSH_RELAY_RATE_LIMIT_PER_MINUTE"] ?? "60", name: "MOMO_PUSH_RELAY_RATE_LIMIT_PER_MINUTE")
        let stubStatus = try positiveInt(environment["MOMO_APNS_STUB_STATUS"] ?? "200", name: "MOMO_APNS_STUB_STATUS")

        var apnsEnvironment: APNSEnvironment?
        var keyPath: String?
        var keyID: String?
        var teamID: String?
        if senderMode == .live {
            guard let envRaw = environment["MOMO_APNS_ENV"], let parsed = APNSEnvironment(rawValue: envRaw) else {
                throw ConfigError.invalid("MOMO_APNS_ENV must be sandbox or production")
            }
            apnsEnvironment = parsed
            let path = try required("MOMO_APNS_KEY_PATH", environment)
            // Preflight the credential at boot rather than at the first push.
            // LiveAPNSSender would also throw here, but only after the HTTP
            // client exists and with a bare Foundation message; an operator
            // reading `docker logs` needs the variable name.
            guard isReadableFile(path) else { throw ConfigError.unreadableAPNSKey(path) }
            keyPath = path
            keyID = try required("MOMO_APNS_KEY_ID", environment)
            teamID = try required("MOMO_APNS_TEAM_ID", environment)
        }

        return RelayConfig(
            host: environment["MOMO_PUSH_RELAY_HOST"] ?? "127.0.0.1",
            port: port,
            servers: registry,
            rateLimitPerMinute: rate,
            senderMode: senderMode,
            stubCapturePath: environment["MOMO_APNS_STUB_CAPTURE_PATH"],
            stubStatus: stubStatus,
            stubReason: environment["MOMO_APNS_STUB_REASON"],
            apnsEnvironment: apnsEnvironment,
            apnsKeyPath: keyPath,
            apnsKeyID: keyID,
            apnsTeamID: teamID
        )
    }

    private static func decodeRegistry(_ json: String) throws -> [String: Curve25519.Signing.PublicKey] {
        let raw: [String: String]
        do {
            raw = try JSONDecoder().decode([String: String].self, from: Data(json.utf8))
        } catch {
            throw ConfigError.invalid("MOMO_RELAY_SERVERS must be a JSON object of server_id to base64 public key")
        }
        guard !raw.isEmpty else { throw ConfigError.invalid("MOMO_RELAY_SERVERS must not be empty") }
        var result: [String: Curve25519.Signing.PublicKey] = [:]
        for (serverID, encoded) in raw {
            guard !serverID.isEmpty, serverID.count <= 200 else {
                throw ConfigError.invalid("server_id must contain 1...200 characters")
            }
            guard let bytes = Data(base64Encoded: encoded), bytes.count == 32 else {
                throw ConfigError.invalid("public key for \(serverID) must be 32-byte Ed25519 raw key in base64")
            }
            do {
                result[serverID] = try Curve25519.Signing.PublicKey(rawRepresentation: bytes)
            } catch {
                throw ConfigError.invalid("public key for \(serverID) is not valid Ed25519 material")
            }
        }
        return result
    }

    private static func required(_ name: String, _ environment: [String: String]) throws -> String {
        guard let value = environment[name], !value.isEmpty else { throw ConfigError.missing(name) }
        return value
    }

    private static func positiveInt(_ raw: String, name: String) throws -> Int {
        guard let value = Int(raw), value > 0 else { throw ConfigError.invalid("\(name) must be a positive integer") }
        return value
    }
}
