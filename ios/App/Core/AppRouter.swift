import Foundation
import Observation

enum AppTab: Hashable, Sendable { case feed, chats, games, notifications, more }

/// Where a navigation push can go. Each case is a full screen in the tab's
/// `NavigationStack`; `RouteView` maps cases to views.
enum Route: Hashable, Sendable {
    case post(Int)
    case profile(Int)
    /// A conversation, optionally scrolled to (and highlighting) one message.
    case chat(Int, messageId: Int?)
    /// A game's lobby browser, by game slug (`GameId` raw value).
    case game(String)
    case gameLobby(Int)
    case leaderboard(String)
    case users
    case settings
    case admin
}

/// The selected tab and each tab's stack, held outside the views so a link
/// (an `@mention`, a notification) can push onto whichever tab is showing.
@MainActor
@Observable
final class AppRouter {
    var selectedTab: AppTab = .feed
    private var paths: [AppTab: [Route]] = [:]

    func path(for tab: AppTab) -> [Route] { paths[tab] ?? [] }
    func setPath(_ path: [Route], for tab: AppTab) { paths[tab] = path }

    func push(_ route: Route) {
        paths[selectedTab, default: []].append(route)
    }

    func reset() {
        selectedTab = .feed
        paths = [:]
    }
}
