import Foundation

#if canImport(FoundationModels)
import FoundationModels
#endif

public enum FoundationModelsCapabilityFallbackReason: String, Equatable, Sendable {
    case frameworkUnavailable
    case unsupportedOS
    case deviceNotEligible
    case appleIntelligenceNotEnabled
    case modelNotReady
    case unknown

    public var detailText: String {
        switch self {
        case .frameworkUnavailable:
            return "FoundationModels framework is not present in this toolchain."
        case .unsupportedOS:
            return "Requires macOS 26 or newer."
        case .deviceNotEligible:
            return "This Mac is not eligible for the system model."
        case .appleIntelligenceNotEnabled:
            return "Apple Intelligence is not enabled."
        case .modelNotReady:
            return "System model assets are not ready yet."
        case .unknown:
            return "Foundation Models reported an unavailable state."
        }
    }
}

public enum FoundationModelsCapabilityState: Equatable, Sendable {
    case available
    case fallback(FoundationModelsCapabilityFallbackReason)

    public var isAvailable: Bool {
        self == .available
    }

    public var badgeText: String {
        isAvailable ? "Available" : "Fallback"
    }

    public var titleText: String {
        isAvailable ? "On-device model" : "Server fallback"
    }

    public var detailText: String {
        switch self {
        case .available:
            return "Foundation Models is ready for local context work."
        case .fallback(let reason):
            return reason.detailText
        }
    }

    public var fallbackReason: FoundationModelsCapabilityFallbackReason? {
        guard case .fallback(let reason) = self else { return nil }
        return reason
    }
}

enum FoundationModelsCapabilityProbeResult: Equatable, Sendable {
    case available
    case unavailable(FoundationModelsCapabilityFallbackReason)
}

public struct FoundationModelsCapabilityProbe: Sendable {
    public init() {}

    public func currentState() -> FoundationModelsCapabilityState {
        Self.state(from: currentProbeResult())
    }

    func currentProbeResult() -> FoundationModelsCapabilityProbeResult {
        #if canImport(FoundationModels)
        if #available(macOS 26.0, *) {
            return Self.result(from: SystemLanguageModel.default.availability)
        } else {
            return .unavailable(.unsupportedOS)
        }
        #else
        return .unavailable(.frameworkUnavailable)
        #endif
    }

    static func state(from result: FoundationModelsCapabilityProbeResult) -> FoundationModelsCapabilityState {
        switch result {
        case .available:
            return .available
        case .unavailable(let reason):
            return .fallback(reason)
        }
    }

    #if canImport(FoundationModels)
    @available(macOS 26.0, *)
    private static func result(
        from availability: SystemLanguageModel.Availability
    ) -> FoundationModelsCapabilityProbeResult {
        switch availability {
        case .available:
            return .available
        case .unavailable(let reason):
            return .unavailable(fallbackReason(from: reason))
        @unknown default:
            return .unavailable(.unknown)
        }
    }

    @available(macOS 26.0, *)
    private static func fallbackReason(
        from reason: SystemLanguageModel.Availability.UnavailableReason
    ) -> FoundationModelsCapabilityFallbackReason {
        switch reason {
        case .deviceNotEligible:
            return .deviceNotEligible
        case .appleIntelligenceNotEnabled:
            return .appleIntelligenceNotEnabled
        case .modelNotReady:
            return .modelNotReady
        @unknown default:
            return .unknown
        }
    }
    #endif
}
