import SwiftUI

struct MainTabView: View {
    enum Tab: Hashable { case feed, chats, games, notifications, more }

    let environment: AppEnvironment
    let user: User
    @State private var selection: Tab = .feed

    var body: some View {
        TabView(selection: $selection) {
            SwiftUI.Tab("Feed", systemImage: "text.bubble", value: Tab.feed) {
                PlaceholderTab(title: "Feed", systemImage: "text.bubble", identifier: "feed")
            }
            SwiftUI.Tab("Chats", systemImage: "message", value: Tab.chats) {
                PlaceholderTab(title: "Chats", systemImage: "message", identifier: "chats")
            }
            SwiftUI.Tab("Games", systemImage: "gamecontroller", value: Tab.games) {
                PlaceholderTab(title: "Games", systemImage: "gamecontroller", identifier: "games")
            }
            SwiftUI.Tab("Alerts", systemImage: "bell", value: Tab.notifications) {
                PlaceholderTab(title: "Notifications", systemImage: "bell", identifier: "notifications")
            }
            SwiftUI.Tab("More", systemImage: "ellipsis.circle", value: Tab.more) {
                MoreView(environment: environment, user: user)
            }
        }
        .accessibilityIdentifier("main.tabs")
    }
}

/// Stands in for a tab whose feature hasn't landed yet.
private struct PlaceholderTab: View {
    let title: String
    let systemImage: String
    let identifier: String

    var body: some View {
        NavigationStack {
            EmptyState(title: title, systemImage: systemImage, message: "Coming soon.", identifier: "\(identifier).placeholder")
                .navigationTitle(title)
        }
    }
}
