import SwiftUI

struct MainTabView: View {
    let environment: AppEnvironment
    let user: User

    var body: some View {
        @Bindable var router = environment.router
        TabView(selection: $router.selectedTab) {
            SwiftUI.Tab("Feed", systemImage: "text.bubble", value: AppTab.feed) {
                TabStack(tab: .feed) { FeedView() }
            }
            SwiftUI.Tab("Chats", systemImage: "message", value: AppTab.chats) {
                PlaceholderTab(title: "Chats", systemImage: "message", identifier: "chats")
            }
            SwiftUI.Tab("Games", systemImage: "gamecontroller", value: AppTab.games) {
                PlaceholderTab(title: "Games", systemImage: "gamecontroller", identifier: "games")
            }
            SwiftUI.Tab("Alerts", systemImage: "bell", value: AppTab.notifications) {
                PlaceholderTab(title: "Notifications", systemImage: "bell", identifier: "notifications")
            }
            SwiftUI.Tab("More", systemImage: "ellipsis.circle", value: AppTab.more) {
                TabStack(tab: .more) { MoreView(environment: environment, user: user) }
            }
        }
        .accessibilityIdentifier("main.tabs")
        .overlay(alignment: .topLeading) {
            // UI tests wait for the socket before relying on live updates.
            if LaunchOptions.resolve().uiTesting {
                Color.clear.frame(width: 1, height: 1)
                    .accessibilityElement()
                    .accessibilityLabel(String(describing: environment.realtime.state))
                    .accessibilityIdentifier("realtime.state")
            }
        }
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
