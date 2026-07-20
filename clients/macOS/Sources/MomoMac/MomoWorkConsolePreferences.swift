import Combine
import CoreGraphics
import Foundation

@MainActor
final class MomoWorkConsolePreferences: ObservableObject {
    static let drawerHeightKey = "momo.workConsole.drawer.height"
    static let sessionListWidthKey = "momo.workConsole.sessionList.width"
    static let rightPanelWidthKey = "momo.workConsole.rightPanel.width"

    @Published private(set) var drawerHeight: CGFloat
    @Published private(set) var sessionListWidth: CGFloat
    @Published private(set) var rightPanelWidth: CGFloat
    @Published private(set) var terminalTheme: MomoTerminalThemePreset

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        drawerHeight = Self.loadDimension(
            key: Self.drawerHeightKey,
            defaultValue: MomoTheme.WorkConsole.drawerHeight,
            minimum: MomoTheme.WorkConsole.drawerMinimumHeight,
            maximum: MomoTheme.WorkConsole.drawerMaximumHeight,
            defaults: defaults
        )
        sessionListWidth = Self.loadDimension(
            key: Self.sessionListWidthKey,
            defaultValue: MomoTheme.WorkConsole.sessionListWidth,
            minimum: MomoTheme.WorkConsole.sessionListMinimumWidth,
            maximum: MomoTheme.WorkConsole.sessionListMaximumWidth,
            defaults: defaults
        )
        rightPanelWidth = Self.loadDimension(
            key: Self.rightPanelWidthKey,
            defaultValue: MomoTheme.WorkConsole.rightPanelWidth,
            minimum: MomoTheme.WorkConsole.rightPanelMinimumWidth,
            maximum: MomoTheme.WorkConsole.rightPanelMaximumWidth,
            defaults: defaults
        )
        terminalTheme = defaults.string(forKey: MomoTerminalThemePreset.storageKey)
            .flatMap(MomoTerminalThemePreset.init(rawValue:))
            ?? .defaultPreset
    }

    func setDrawerHeight(_ value: CGFloat) {
        drawerHeight = persistDimension(
            value,
            key: Self.drawerHeightKey,
            minimum: MomoTheme.WorkConsole.drawerMinimumHeight,
            maximum: MomoTheme.WorkConsole.drawerMaximumHeight
        )
    }

    func resetDrawerHeight() {
        setDrawerHeight(MomoTheme.WorkConsole.drawerHeight)
    }

    func setSessionListWidth(_ value: CGFloat) {
        sessionListWidth = persistDimension(
            value,
            key: Self.sessionListWidthKey,
            minimum: MomoTheme.WorkConsole.sessionListMinimumWidth,
            maximum: MomoTheme.WorkConsole.sessionListMaximumWidth
        )
    }

    func resetSessionListWidth() {
        setSessionListWidth(MomoTheme.WorkConsole.sessionListWidth)
    }

    func setRightPanelWidth(_ value: CGFloat) {
        rightPanelWidth = persistDimension(
            value,
            key: Self.rightPanelWidthKey,
            minimum: MomoTheme.WorkConsole.rightPanelMinimumWidth,
            maximum: MomoTheme.WorkConsole.rightPanelMaximumWidth
        )
    }

    func resetRightPanelWidth() {
        setRightPanelWidth(MomoTheme.WorkConsole.rightPanelWidth)
    }

    func setTerminalTheme(_ preset: MomoTerminalThemePreset) {
        terminalTheme = preset
        defaults.set(preset.rawValue, forKey: MomoTerminalThemePreset.storageKey)
    }

    private func persistDimension(
        _ value: CGFloat,
        key: String,
        minimum: CGFloat,
        maximum: CGFloat
    ) -> CGFloat {
        let clamped = min(maximum, max(minimum, value))
        defaults.set(Double(clamped), forKey: key)
        return clamped
    }

    private static func loadDimension(
        key: String,
        defaultValue: CGFloat,
        minimum: CGFloat,
        maximum: CGFloat,
        defaults: UserDefaults
    ) -> CGFloat {
        guard defaults.object(forKey: key) != nil else { return defaultValue }
        return min(maximum, max(minimum, CGFloat(defaults.double(forKey: key))))
    }
}

enum MomoWorkConsoleLayout {
    static func drawerHeight(preferredHeight: CGFloat, availableHeight: CGFloat) -> CGFloat {
        let availableMaximum = max(
            0,
            availableHeight - MomoTheme.WorkConsole.primaryContentMinimumHeight
        )
        let maximum = min(MomoTheme.WorkConsole.drawerMaximumHeight, availableMaximum)
        return min(maximum, max(MomoTheme.WorkConsole.drawerMinimumHeight, preferredHeight))
    }

    static func sessionListWidth(preferredWidth: CGFloat, availableWidth: CGFloat) -> CGFloat {
        let availableMaximum = max(
            0,
            availableWidth - MomoTheme.WorkConsole.terminalMinimumWidth
        )
        let maximum = min(MomoTheme.WorkConsole.sessionListMaximumWidth, availableMaximum)
        return min(maximum, max(MomoTheme.WorkConsole.sessionListMinimumWidth, preferredWidth))
    }
}
