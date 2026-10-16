import SwiftUI

/// Signed out → the auth screens; signed in → the tab shell.
struct RootView: View {
    let environment: AppEnvironment
    @Environment(\.scenePhase) private var scenePhase

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
        .environment(environment)
        // The socket lives while someone is signed in and the app is in the
        // foreground; backgrounding drops it and coming back reconnects (and
        // refetches everything, since events were missed meanwhile).
        .task(id: SocketWanted(signedIn: environment.auth.user != nil, active: scenePhase == .active)) {
            if environment.auth.user != nil, scenePhase == .active { environment.realtime.start() }
            else { environment.realtime.stop() }
        }
    }
}

private struct SocketWanted: Equatable {
    var signedIn: Bool
    var active: Bool
}
