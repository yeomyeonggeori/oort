import Foundation
import SwiftUI

public enum MomoMacUpdateEngine: String, Equatable, Sendable {
    case localManifest = "Local manifest"
    case manualDownload = "Manual download"
}

public enum MomoMacUpdateChannel: String, Codable, Equatable, Sendable {
    case alpha
    case stable

    public var title: String {
        switch self {
        case .alpha: return "Alpha"
        case .stable: return "Stable"
        }
    }
}

public enum MomoMacUpdateState: Equatable, Sendable {
    case notConfigured
    case upToDate
    case updateAvailable
    case failed

    public var title: String {
        switch self {
        case .notConfigured: return "Updates not configured"
        case .upToDate: return "Up to date"
        case .updateAvailable: return "Update available"
        case .failed: return "Update check failed"
        }
    }

    public var systemImage: String {
        switch self {
        case .notConfigured: return "arrow.down.circle"
        case .upToDate: return "checkmark.circle.fill"
        case .updateAvailable: return "arrow.down.circle.fill"
        case .failed: return "exclamationmark.triangle.fill"
        }
    }
}

public enum MomoMacUpdateManifestError: LocalizedError, Equatable, Sendable {
    case unsupportedSource(String)
    case fileNotFound(String)
    case invalidJSON(String)

    public var errorDescription: String? {
        switch self {
        case .unsupportedSource(let value):
            return "Only local paths and file:// update manifests are supported in v0: \(value)"
        case .fileNotFound(let path):
            return "Update manifest file was not found: \(path)"
        case .invalidJSON(let message):
            return "Update manifest JSON is invalid: \(message)"
        }
    }
}

public enum MomoMacUpdateManifestSource: Equatable, Sendable {
    case file(URL)

    public var displayLabel: String {
        switch self {
        case .file(let url):
            if url.isFileURL { return url.path }
            return url.absoluteString
        }
    }

    public static func fromEnvironment(_ environment: [String: String]) throws -> MomoMacUpdateManifestSource? {
        let raw = environment["MOMO_UPDATE_MANIFEST_URL"] ?? environment["MOMO_UPDATE_MANIFEST_PATH"]
        guard let raw, !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return try parse(raw)
    }

    public static func parse(_ rawValue: String) throws -> MomoMacUpdateManifestSource {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if let url = URL(string: trimmed), let scheme = url.scheme?.lowercased() {
            guard scheme == "file" else {
                throw MomoMacUpdateManifestError.unsupportedSource(trimmed)
            }
            return .file(url)
        }
        return .file(URL(fileURLWithPath: trimmed))
    }
}

public struct MomoMacAppVersion: Equatable, Sendable {
    public var version: String
    public var build: String

    public init(version: String, build: String) {
        self.version = version
        self.build = build
    }

    public var displayLabel: String {
        if build.isEmpty || build == version {
            return version
        }
        return "\(version) (\(build))"
    }

    public static func fromEnvironment(
        _ environment: [String: String] = ProcessInfo.processInfo.environment,
        bundle: Bundle = .main
    ) -> MomoMacAppVersion {
        let version = firstNonEmpty(
            environment["MOMO_CURRENT_VERSION"],
            environment["MOMO_APP_VERSION"],
            bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
            fallback: "0.0.0-dev"
        )
        let build = firstNonEmpty(
            environment["MOMO_CURRENT_BUILD"],
            environment["MOMO_APP_BUILD"],
            bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String,
            fallback: "dev"
        )
        return MomoMacAppVersion(version: version, build: build)
    }

    private static func firstNonEmpty(_ values: String?..., fallback: String) -> String {
        for value in values {
            let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !trimmed.isEmpty {
                return trimmed
            }
        }
        return fallback
    }
}

public struct MomoMacUpdateManifest: Codable, Equatable, Sendable {
    public var schemaVersion: Int
    public var channel: MomoMacUpdateChannel
    public var version: String
    public var build: String
    public var releasedAt: String?
    public var minimumMacOS: String?
    public var summary: String
    public var downloadURL: URL?
    public var releaseNotesURL: URL?
    public var restartInstructions: [String]

    public init(
        schemaVersion: Int = 1,
        channel: MomoMacUpdateChannel = .alpha,
        version: String,
        build: String,
        releasedAt: String? = nil,
        minimumMacOS: String? = nil,
        summary: String,
        downloadURL: URL?,
        releaseNotesURL: URL? = nil,
        restartInstructions: [String] = []
    ) {
        self.schemaVersion = schemaVersion
        self.channel = channel
        self.version = version
        self.build = build
        self.releasedAt = releasedAt
        self.minimumMacOS = minimumMacOS
        self.summary = summary
        self.downloadURL = downloadURL
        self.releaseNotesURL = releaseNotesURL
        self.restartInstructions = restartInstructions
    }

    public var availableVersion: MomoMacAppVersion {
        MomoMacAppVersion(version: version, build: build)
    }

    public var installSteps: [String] {
        if restartInstructions.isEmpty {
            return [
                "Open the download from the alpha operator.",
                "Replace or move the new momo app into place.",
                "Quit and relaunch momo, then reopen Updates.",
            ]
        }
        return restartInstructions
    }

    public func validationDiagnostics() -> [String] {
        var diagnostics: [String] = []
        if schemaVersion != 1 {
            diagnostics.append("Unsupported update manifest schema_version: \(schemaVersion).")
        }
        if version.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            diagnostics.append("Manifest version is required.")
        }
        if build.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            diagnostics.append("Manifest build is required.")
        }
        if summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            diagnostics.append("Manifest summary is required.")
        }
        if downloadURL == nil {
            diagnostics.append("Manifest download_url is required for operator-assisted install.")
        }
        return diagnostics
    }

    public static func load(from source: MomoMacUpdateManifestSource) throws -> MomoMacUpdateManifest {
        switch source {
        case .file(let url):
            let path = url.path
            guard FileManager.default.fileExists(atPath: path) else {
                throw MomoMacUpdateManifestError.fileNotFound(path)
            }
            do {
                let data = try Data(contentsOf: url)
                return try JSONDecoder().decode(MomoMacUpdateManifest.self, from: data)
            } catch let error as DecodingError {
                throw MomoMacUpdateManifestError.invalidJSON(Self.describe(error))
            } catch {
                throw MomoMacUpdateManifestError.invalidJSON(error.localizedDescription)
            }
        }
    }

    private static func describe(_ error: DecodingError) -> String {
        switch error {
        case .dataCorrupted(let context), .keyNotFound(_, let context),
             .typeMismatch(_, let context), .valueNotFound(_, let context):
            let path = context.codingPath.map(\.stringValue).joined(separator: ".")
            if path.isEmpty {
                return context.debugDescription
            }
            return "\(path): \(context.debugDescription)"
        @unknown default:
            return String(describing: error)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case channel
        case version
        case build
        case releasedAt = "released_at"
        case minimumMacOS = "minimum_macos"
        case summary
        case downloadURL = "download_url"
        case releaseNotesURL = "release_notes_url"
        case restartInstructions = "restart_instructions"
    }
}

public struct MomoMacUpdateChannelStatus: Equatable, Sendable {
    public var channel: MomoMacUpdateChannel
    public var engine: MomoMacUpdateEngine
    public var currentVersion: MomoMacAppVersion
    public var manifestSource: MomoMacUpdateManifestSource?
    public var manifest: MomoMacUpdateManifest?
    public var state: MomoMacUpdateState
    public var diagnostics: [String]

    public init(
        channel: MomoMacUpdateChannel = .alpha,
        engine: MomoMacUpdateEngine = .localManifest,
        currentVersion: MomoMacAppVersion = .fromEnvironment(),
        manifestSource: MomoMacUpdateManifestSource? = nil,
        manifest: MomoMacUpdateManifest? = nil,
        state: MomoMacUpdateState = .notConfigured,
        diagnostics: [String] = []
    ) {
        self.channel = channel
        self.engine = engine
        self.currentVersion = currentVersion
        self.manifestSource = manifestSource
        self.manifest = manifest
        self.state = state
        self.diagnostics = diagnostics
    }

    public var availableVersion: MomoMacAppVersion? {
        manifest?.availableVersion
    }

    public var hasUpdate: Bool {
        state == .updateAvailable
    }

    public var canOpenDownload: Bool {
        hasUpdate && manifest?.downloadURL != nil
    }

    public var surfaceTitle: String {
        state.title
    }

    public var surfaceDetail: String {
        switch state {
        case .notConfigured:
            return "Set MOMO_UPDATE_MANIFEST_URL or MOMO_UPDATE_MANIFEST_PATH to a local alpha manifest."
        case .upToDate:
            return "This build matches the latest version in the \(channel.title) manifest."
        case .updateAvailable:
            let version = availableVersion?.displayLabel ?? "a newer build"
            return "\(version) is available for operator-assisted install and relaunch."
        case .failed:
            return "The \(channel.title) update manifest could not be used."
        }
    }

    public static func fromEnvironment(
        _ environment: [String: String] = ProcessInfo.processInfo.environment,
        bundle: Bundle = .main
    ) -> MomoMacUpdateChannelStatus {
        let rawChannel = environment["MOMO_UPDATE_CHANNEL"]?.lowercased()
        let environmentChannel: MomoMacUpdateChannel = rawChannel == "stable" ? .stable : .alpha
        let current = MomoMacAppVersion.fromEnvironment(environment, bundle: bundle)
        var diagnostics: [String] = []

        if let publicKey = environment["MOMO_UPDATE_PUBLIC_ED_KEY"],
           publicKey.lowercased().contains("private") {
            diagnostics.append("Only Sparkle EdDSA public keys belong in app/runtime config.")
        }

        let source: MomoMacUpdateManifestSource?
        do {
            source = try MomoMacUpdateManifestSource.fromEnvironment(environment)
        } catch {
            diagnostics.append(error.localizedDescription)
            return MomoMacUpdateChannelStatus(
                channel: environmentChannel,
                currentVersion: current,
                state: .failed,
                diagnostics: diagnostics
            )
        }

        guard let source else {
            return MomoMacUpdateChannelStatus(
                channel: environmentChannel,
                currentVersion: current,
                state: diagnostics.isEmpty ? .notConfigured : .failed,
                diagnostics: diagnostics
            )
        }

        do {
            let manifest = try MomoMacUpdateManifest.load(from: source)
            diagnostics += manifest.validationDiagnostics()
            let state: MomoMacUpdateState
            if !diagnostics.isEmpty {
                state = .failed
            } else if Self.isUpdateAvailable(current: current, available: manifest.availableVersion) {
                state = .updateAvailable
            } else {
                state = .upToDate
            }
            return MomoMacUpdateChannelStatus(
                channel: manifest.channel,
                currentVersion: current,
                manifestSource: source,
                manifest: manifest,
                state: state,
                diagnostics: diagnostics
            )
        } catch {
            diagnostics.append(error.localizedDescription)
            return MomoMacUpdateChannelStatus(
                channel: environmentChannel,
                currentVersion: current,
                manifestSource: source,
                state: .failed,
                diagnostics: diagnostics
            )
        }
    }

    public static func isUpdateAvailable(current: MomoMacAppVersion, available: MomoMacAppVersion) -> Bool {
        let versionComparison = compareVersionStrings(available.version, current.version)
        if versionComparison != .orderedSame {
            return versionComparison == .orderedDescending
        }

        if let availableBuild = Int(available.build), let currentBuild = Int(current.build) {
            return availableBuild > currentBuild
        }
        return available.build.localizedStandardCompare(current.build) == .orderedDescending
    }

    private static func compareVersionStrings(_ lhs: String, _ rhs: String) -> ComparisonResult {
        let lhsParts = numericParts(lhs)
        let rhsParts = numericParts(rhs)
        let count = max(lhsParts.count, rhsParts.count)
        for index in 0..<count {
            let left = index < lhsParts.count ? lhsParts[index] : 0
            let right = index < rhsParts.count ? rhsParts[index] : 0
            if left < right { return .orderedAscending }
            if left > right { return .orderedDescending }
        }
        return lhs.localizedStandardCompare(rhs)
    }

    private static func numericParts(_ value: String) -> [Int] {
        value.split { !$0.isNumber }.compactMap { Int($0) }
    }
}

public struct MomoMacUpdateChannelView: View {
    public var status: MomoMacUpdateChannelStatus

    public init(status: MomoMacUpdateChannelStatus = .fromEnvironment()) {
        self.status = status
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 8) {
                Image(systemName: status.state.systemImage)
                    .font(.title3)
                    .foregroundStyle(stateTint)
                VStack(alignment: .leading, spacing: 2) {
                    Text(status.surfaceTitle)
                        .font(.headline)
                    Text("\(status.channel.title) channel")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Text(status.surfaceDetail)
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 8) {
                statusRow("Engine", status.engine.rawValue, icon: "shippingbox")
                statusRow("Current", status.currentVersion.displayLabel, icon: "app.badge")
                statusRow("Available", status.availableVersion?.displayLabel ?? "No manifest", icon: "arrow.down.doc")
                statusRow("Manifest", status.manifestSource?.displayLabel ?? "Not configured", icon: "doc.text")
                statusRow("Download", status.manifest?.downloadURL?.absoluteString ?? "Not available", icon: "tray.and.arrow.down")
            }

            if let manifest = status.manifest, status.hasUpdate {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Operator-assisted install")
                        .font(.caption.bold())
                    if let downloadURL = manifest.downloadURL {
                        Link(destination: downloadURL) {
                            Label("Open Download", systemImage: "arrow.down.circle.fill")
                        }
                    }
                    if let releaseNotesURL = manifest.releaseNotesURL {
                        Link(destination: releaseNotesURL) {
                            Label("Release Notes", systemImage: "doc.plaintext")
                        }
                    }
                    ForEach(manifest.installSteps, id: \.self) { step in
                        Label(step, systemImage: "arrow.turn.down.right")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if !status.diagnostics.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Diagnostics")
                        .font(.caption.bold())
                    ForEach(status.diagnostics, id: \.self) { diagnostic in
                        Label(diagnostic, systemImage: "exclamationmark.triangle")
                            .font(.caption)
                            .foregroundStyle(MomoTheme.irreversibleRed)
                            .textSelection(.enabled)
                    }
                }
            }
        }
        .padding(16)
        .frame(width: 460, alignment: .topLeading)
    }

    private var stateTint: Color {
        switch status.state {
        case .notConfigured: return .secondary
        case .upToDate: return .green
        case .updateAvailable: return MomoTheme.costAmber
        case .failed: return MomoTheme.irreversibleRed
        }
    }

    private func statusRow(_ title: String, _ value: String, icon: String) -> some View {
        GridRow {
            Label(title, systemImage: icon)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.caption)
                .textSelection(.enabled)
        }
    }
}
