import SwiftUI

/// Signed out → the auth screens; signed in → the tab shell.
struct RootView: View {
    let environment: AppEnvironment

    var body: some View {
        Group {
            switch environment.auth.phase {
            case .launching:
                ProgressView().accessibilityIdentifier("root.launching")
            case .signedOut:
                AuthView(auth: environment.auth, server: environment.server, baseURL: environment.config.apiBaseURL)
            case .signedIn(let user):
                MainTabView(environment: environment, user: user)
            }
        }
        .animation(.default, value: environment.auth.phase)
    }
}
