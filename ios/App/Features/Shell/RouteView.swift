import SwiftUI

/// Maps a `Route` to its screen. Every tab's stack uses this.
struct RouteView: View {
    let route: Route

    var body: some View {
        switch route {
        case .post(let id): PostDetailView(postId: id)
        case .profile(let id): ProfileView(userId: id)
        case .users: UsersListView()
        case .settings: SettingsView()
        case .admin: AdminDashboardView()
        // Each feature replaces its own placeholder case(s) below.
        case .chat, .game, .gameLobby, .leaderboard:
            EmptyState(title: "Coming soon", systemImage: "hammer", identifier: "route.placeholder")
        }
    }
}

/// A tab's `NavigationStack`, bound to the router so links can push onto it.
struct TabStack<Root: View>: View {
    @Environment(AppEnvironment.self) private var env
    let tab: AppTab
    @ViewBuilder let root: Root

    var body: some View {
        NavigationStack(path: Binding(get: { env.router.path(for: tab) }, set: { env.router.setPath($0, for: tab) })) {
            root.navigationDestination(for: Route.self) { RouteView(route: $0) }
        }
    }
}
