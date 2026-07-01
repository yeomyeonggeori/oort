import Foundation
import SwiftUI

public enum MomoMacUpdateEngine: String, Equatable, Sendable {
    case sparkle2 = "Sparkle 2"
    case manualDownload = "Manual download"
}

public enum MomoMacUpdateChannel: String, Equatable, Sendable {
    case alpha
    case stable

    public var title: String {
        switch self {
        case .alpha: return "Alpha"
        case .stable: return "Stable"
        }
    }
}

public struct MomoMacUpdateChannelStatus: Equatable, Sendable {
    public var channel: MomoMacUpdateChannel
    public var engine: MomoMacUpdateEngine
    public var feedURL: URL?
    public var publicKeyConfigured: Bool
    public var automaticChecksEnabled: Bool
    public var signingReady: Bool
    public var notarizationReady: Bool
    public var dmgReady: Bool
    public var diagnostics: [String]

    public init(
        channel: MomoMacUpdateChannel = .alpha,
        engine: MomoMacUpdateEngine = .sparkle2,
        feedURL: URL? = nil,
        publicKeyConfigured: Bool = false,
        automaticChecksEnabled: Bool = false,
        signingReady: Bool = false,
        notarizationReady: Bool = false,
        dmgReady: Bool = false,
        diagnostics: [String] = []
    ) {
        self.channel = channel
        self.engine = engine
        self.feedURL = feedURL
        self.publicKeyConfigured = publicKeyConfigured
        self.automaticChecksEnabled = automaticChecksEnabled
        self.signingReady = signingReady
        self.notarizationReady = notarizationReady
        self.dmgReady = dmgReady
        self.diagnostics = diagnostics
    }

    public var canCheckNow: Bool {
        feedURL != nil && publicKeyConfigured
    }

    public var canInstallAutomatically: Bool {
        canCheckNow && signingReady && notarizationReady && dmgReady
    }

    public var surfaceTitle: String {
        if canInstallAutomatically {
            return "Updates ready"
        }
        if canCheckNow {
            return "Update feed ready"
        }
        return "Updates planned"
    }

    public var surfaceDetail: String {
        if canInstallAutomatically {
            return "\(channel.title) \(engine.rawValue) can check signed, notarized DMG appcasts."
        }
        if canCheckNow {
            return "\(channel.title) appcast is configured; signed/notarized artifacts are still required before install."
        }
        return "\(channel.title) update checks are a placeholder until feed URL and EdDSA public key are configured."
    }

    public var missingRequirements: [String] {
        var missing: [String] = []
        if feedURL == nil { missing.append("SUFeedURL") }
        if !publicKeyConfigured { missing.append("SUPublicEDKey") }
        if !signingReady { missing.append("Developer ID signing") }
        if !notarizationReady { missing.append("notarization") }
        if !dmgReady { missing.append("DMG artifact") }
        return missing
    }

    public static func fromEnvironment(_ environment: [String: String] = ProcessInfo.processInfo.environment) -> MomoMacUpdateChannelStatus {
        let rawChannel = environment["MOMO_UPDATE_CHANNEL"]?.lowercased()
        let channel: MomoMacUpdateChannel = rawChannel == "stable" ? .stable : .alpha
        let feedURL = environment["MOMO_UPDATE_FEED_URL"].flatMap(validHTTPURL)
        let publicKey = environment["MOMO_UPDATE_PUBLIC_ED_KEY"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let automatic = bool(environment["MOMO_UPDATE_AUTOMATIC_CHECKS"])
        let signing = bool(environment["MOMO_UPDATE_SIGNING_READY"])
        let notarization = bool(environment["MOMO_UPDATE_NOTARIZATION_READY"])
        let dmg = bool(environment["MOMO_UPDATE_DMG_READY"])
        var diagnostics: [String] = []
        if environment["MOMO_UPDATE_FEED_URL"] != nil, feedURL == nil {
            diagnostics.append("MOMO_UPDATE_FEED_URL is not a valid URL.")
        }
        if let publicKey, publicKey.lowercased().contains("private") {
            diagnostics.append("Only Sparkle EdDSA public keys belong in app/runtime config.")
        }
        return MomoMacUpdateChannelStatus(
            channel: channel,
            engine: .sparkle2,
            feedURL: feedURL,
            publicKeyConfigured: publicKey?.isEmpty == false,
            automaticChecksEnabled: automatic,
            signingReady: signing,
            notarizationReady: notarization,
            dmgReady: dmg,
            diagnostics: diagnostics
        )
    }

    private static func bool(_ value: String?) -> Bool {
        guard let value else { return false }
        switch value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "1", "true", "yes", "on":
            return true
        default:
            return false
        }
    }

    private static func validHTTPURL(_ rawValue: String) -> URL? {
        guard
            let url = URL(string: rawValue.trimmingCharacters(in: .whitespacesAndNewlines)),
            let scheme = url.scheme?.lowercased(),
            ["http", "https"].contains(scheme),
            url.host?.isEmpty == false
        else {
            return nil
        }
        return url
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
                Image(systemName: status.canInstallAutomatically ? "arrow.down.circle.fill" : "arrow.down.circle")
                    .font(.title3)
                    .foregroundStyle(status.canInstallAutomatically ? .green : .secondary)
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
                statusRow("Engine", status.engine.rawValue, icon: "sparkle")
                statusRow("Feed", status.feedURL?.absoluteString ?? "Not configured", icon: "dot.radiowaves.left.and.right")
                statusRow("EdDSA public key", status.publicKeyConfigured ? "Configured" : "Missing", icon: "key")
                statusRow("Automatic checks", status.automaticChecksEnabled ? "Enabled" : "Manual placeholder", icon: "clock.arrow.circlepath")
                statusRow("Artifact trust", artifactTrustLabel, icon: "checkmark.shield")
            }

            if !status.missingRequirements.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Missing before real installs")
                        .font(.caption.bold())
                    ForEach(status.missingRequirements, id: \.self) { requirement in
                        Label(requirement, systemImage: "circle")
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
                    }
                }
            }
        }
        .padding(16)
        .frame(width: 420, alignment: .topLeading)
    }

    private var artifactTrustLabel: String {
        if status.signingReady && status.notarizationReady && status.dmgReady {
            return "Signed, notarized DMG"
        }
        return "signing-unverified"
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
