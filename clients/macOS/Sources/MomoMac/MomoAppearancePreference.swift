import SwiftUI

enum MomoAppearancePreference: String, CaseIterable, Identifiable, Sendable {
    case system
    case light
    case dark

    static let appStorageKey = "momo.ui.appearance"

    var id: String { rawValue }

    var colorScheme: ColorScheme? {
        switch self {
        case .system:
            return nil
        case .light:
            return .light
        case .dark:
            return .dark
        }
    }

    var systemImage: String {
        switch self {
        case .system:
            return "circle.lefthalf.filled"
        case .light:
            return "sun.max"
        case .dark:
            return "moon"
        }
    }

    func title(copy: MomoWorkspaceCopy) -> String {
        switch self {
        case .system:
            return copy.appearanceSystem
        case .light:
            return copy.appearanceLight
        case .dark:
            return copy.appearanceDark
        }
    }
}

struct MomoDeveloperModePresentation: Equatable, Sendable {
    static let developerModeKey = "momo.ui.developerMode"
    static let costDisplayKey = "momo.ui.showCosts"

    let isDeveloperModeEnabled: Bool
    let isCostDisplayEnabled: Bool

    static let standard = MomoDeveloperModePresentation(
        isDeveloperModeEnabled: false,
        isCostDisplayEnabled: false
    )

    static func developer(showCosts: Bool) -> MomoDeveloperModePresentation {
        MomoDeveloperModePresentation(
            isDeveloperModeEnabled: true,
            isCostDisplayEnabled: showCosts
        )
    }

    var showsDeveloperDetails: Bool {
        isDeveloperModeEnabled
    }

    var showsCosts: Bool {
        isDeveloperModeEnabled && isCostDisplayEnabled
    }
}
