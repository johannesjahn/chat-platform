import Observation
import SwiftUI

/// Light, dark, or whatever the device prefers (the web's `lib/theme.ts`).
/// A per-device choice, so it lives in `UserDefaults`, not the account.
enum ThemePreference: String, CaseIterable, Identifiable, Sendable {
    case system, light, dark

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

@MainActor
@Observable
final class ThemeStore {
    static let defaultsKey = "theme"

    var preference: ThemePreference {
        didSet { defaults.set(preference.rawValue, forKey: Self.defaultsKey) }
    }

    @ObservationIgnored private let defaults: UserDefaults

    /// `reset` (UI tests) starts from "system" whatever an earlier run chose.
    init(defaults: UserDefaults = .standard, reset: Bool = false) {
        self.defaults = defaults
        if reset { defaults.removeObject(forKey: Self.defaultsKey) }
        preference = defaults.string(forKey: Self.defaultsKey).flatMap(ThemePreference.init(rawValue:)) ?? .system
    }
}
