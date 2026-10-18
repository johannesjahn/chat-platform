import SwiftUI

/// Maps a `Route` to its screen. Every tab's stack uses this.
struct RouteView: View {
    let route: Route

    var body: some View {
        switch route {
        case .post(let id): PostDetailView(postId: id)
        case .profile(let id): ProfileView(userId: id)
        case .search: SearchView()
        case .game(let slug): GameHubView(slug: slug)
        case .gameLobby(let id): LobbyView(lobbyId: id)
        case .leaderboard(let slug): LeaderboardView(slug: slug)
        // Each feature replaces its own placeholder case(s) below.
        case .chat, .users, .settings, .admin:
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
