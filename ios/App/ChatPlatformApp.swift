import SwiftUI

@main
struct ChatPlatformApp: App {
    @State private var environment: AppEnvironment?

    init() {
        // Hosting the unit tests shouldn't boot the UI (or touch the Keychain).
        if !LaunchOptions.isRunningUnitTests {
            _environment = State(initialValue: AppEnvironment())
        }
    }

    private static var scheme: ColorScheme? {
        switch LaunchOptions.resolve().appearance {
        case "dark": .dark
        case "light": .light
        default: nil
        }
    }

    var body: some Scene {
        WindowGroup {
            if let environment {
                // The `-uiAppearance` test flag wins over the user's choice.
                RootView(environment: environment)
                    .preferredColorScheme(Self.scheme ?? environment.theme.preference.colorScheme)
            }
        }
    }
}
