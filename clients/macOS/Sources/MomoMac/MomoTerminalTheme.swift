import AppKit
import SwiftTerm
import SwiftUI

enum MomoTerminalThemePreset: String, CaseIterable, Identifiable, Sendable {
    case dark
    case light
    case highContrast
    case colorBlindSafe

    static let storageKey = "momo.workConsole.terminal.theme"
    static let defaultPreset = MomoTerminalThemePreset.dark

    var id: String { rawValue }

    var theme: MomoTerminalTheme {
        switch self {
        case .dark:
            MomoTerminalTheme(
                foreground: .hex(0xE6EDF3),
                background: .hex(0x0D1117),
                cursor: .hex(0x58A6FF),
                ansi16: [
                    .hex(0x484F58), .hex(0xFF7B72), .hex(0x3FB950), .hex(0xD29922),
                    .hex(0x58A6FF), .hex(0xBC8CFF), .hex(0x39C5CF), .hex(0xB1BAC4),
                    .hex(0x6E7681), .hex(0xFFA198), .hex(0x56D364), .hex(0xE3B341),
                    .hex(0x79C0FF), .hex(0xD2A8FF), .hex(0x56D4DD), .hex(0xF0F6FC),
                ]
            )
        case .light:
            MomoTerminalTheme(
                foreground: .hex(0x24292F),
                background: .hex(0xF6F8FA),
                cursor: .hex(0x0550AE),
                ansi16: [
                    .hex(0x24292F), .hex(0xA40E26), .hex(0x116329), .hex(0x6E5700),
                    .hex(0x0550AE), .hex(0x8250DF), .hex(0x006A6A), .hex(0x4B5563),
                    .hex(0x57606A), .hex(0xB42318), .hex(0x1A7F37), .hex(0x7D5F00),
                    .hex(0x0969DA), .hex(0x6F42C1), .hex(0x007C7C), .hex(0x24292F),
                ]
            )
        case .highContrast:
            MomoTerminalTheme(
                foreground: .hex(0xFFFFFF),
                background: .hex(0x000000),
                cursor: .hex(0xFFE66D),
                ansi16: [
                    .hex(0xB3B3B3), .hex(0xFF6B6B), .hex(0x5CFF85), .hex(0xFFE66D),
                    .hex(0x78A9FF), .hex(0xFF85E1), .hex(0x66E3FF), .hex(0xFFFFFF),
                    .hex(0xD9D9D9), .hex(0xFF9A9A), .hex(0x8AFFA5), .hex(0xFFF09A),
                    .hex(0xA6C8FF), .hex(0xFFB3EC), .hex(0xA3EEFF), .hex(0xFFFFFF),
                ]
            )
        case .colorBlindSafe:
            MomoTerminalTheme(
                foreground: .hex(0xF5F5F5),
                background: .hex(0x16161D),
                cursor: .hex(0xF0E442),
                ansi16: [
                    .hex(0xA0A0A0), .hex(0xE69F00), .hex(0x009E73), .hex(0xF0E442),
                    .hex(0x56B4E9), .hex(0xCC79A7), .hex(0x0072B2), .hex(0xE5E5E5),
                    .hex(0xBDBDBD), .hex(0xFFB000), .hex(0x00C08B), .hex(0xFFE75A),
                    .hex(0x72C7F0), .hex(0xE39BC1), .hex(0x2A91C9), .hex(0xFFFFFF),
                ]
            )
        }
    }
}

struct MomoTerminalTheme: Sendable {
    let foreground: MomoTerminalColor
    let background: MomoTerminalColor
    let cursor: MomoTerminalColor
    let ansi16: [MomoTerminalColor]

    var foregroundBackgroundContrast: Double {
        foreground.contrastRatio(with: background)
    }

    @MainActor
    func apply(to terminalView: TerminalView) {
        terminalView.nativeForegroundColor = foreground.nsColor
        terminalView.nativeBackgroundColor = background.nsColor
        terminalView.caretColor = cursor.nsColor
        terminalView.caretTextColor = background.nsColor
        terminalView.selectedTextBackgroundColor = cursor.nsColor.withAlphaComponent(0.35)
        terminalView.installColors(ansi16.map(\.swiftTermColor))
        terminalView.layer?.backgroundColor = background.nsColor.cgColor
        terminalView.needsDisplay = true
    }
}

struct MomoTerminalColor: Equatable, Sendable {
    let red: UInt8
    let green: UInt8
    let blue: UInt8

    static func hex(_ value: UInt32) -> MomoTerminalColor {
        MomoTerminalColor(
            red: UInt8((value >> 16) & 0xff),
            green: UInt8((value >> 8) & 0xff),
            blue: UInt8(value & 0xff)
        )
    }

    var nsColor: NSColor {
        NSColor(
            srgbRed: CGFloat(red) / 255,
            green: CGFloat(green) / 255,
            blue: CGFloat(blue) / 255,
            alpha: 1
        )
    }

    var swiftTermColor: SwiftTerm.Color {
        SwiftTerm.Color(
            red: UInt16(red) * 257,
            green: UInt16(green) * 257,
            blue: UInt16(blue) * 257
        )
    }

    func contrastRatio(with other: MomoTerminalColor) -> Double {
        let lighter = max(relativeLuminance, other.relativeLuminance)
        let darker = min(relativeLuminance, other.relativeLuminance)
        return (lighter + 0.05) / (darker + 0.05)
    }

    private var relativeLuminance: Double {
        func linear(_ component: UInt8) -> Double {
            let value = Double(component) / 255
            return value <= 0.04045
                ? value / 12.92
                : pow((value + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
    }
}

/// SwiftTerm is the system-like terminal control; this wrapper provides deterministic theme evidence.
struct MomoTerminalThemePreview: NSViewRepresentable {
    let preset: MomoTerminalThemePreset

    func makeNSView(context: Context) -> TerminalView {
        let terminalView = TerminalView(frame: .zero)
        terminalView.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        preset.theme.apply(to: terminalView)
        terminalView.feed(text: Self.fixture)
        return terminalView
    }

    func updateNSView(_ terminalView: TerminalView, context: Context) {
        preset.theme.apply(to: terminalView)
    }

    private static let fixture = """
        $ swift test
        \u{1B}[34mBuilding MomoMac\u{1B}[0m
        \u{1B}[32m빌드 완료: 128 tests passed\u{1B}[0m
        \u{1B}[33mwarning: snapshot reference pending\u{1B}[0m
        \u{1B}[31merror sample\u{1B}[0m  \u{1B}[36m~/projects/momo\u{1B}[0m
        $
        """
}
