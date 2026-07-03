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
