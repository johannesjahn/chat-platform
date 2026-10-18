import SwiftUI

/// A game's leaderboard (`GET /games/{game}/leaderboard`), by period. Also
/// where a "you lost your #1 spot" notification lands.
struct LeaderboardView: View {
    let slug: String

    var body: some View {
        if let game = GameDefinition.playable(slug: slug), let id = game.slug {
            LeaderboardContent(game: game, slug: id)
        } else {
            EmptyState(title: "Game not found", systemImage: "trophy", message: "That game isn't in the arcade (yet).", identifier: "leaderboard.unknown")
        }
    }
}

private struct LeaderboardContent: View {
    @Environment(AppEnvironment.self) private var env
    let game: GameDefinition
    let slug: GameSlug
    @State private var period: LeaderboardPeriod = .week
    @State private var failure: String?

    private static let periods: [(LeaderboardPeriod, String)] = [(.day, "Today"), (.week, "This week"), (.all, "All time")]

    var body: some View {
        let board = env.games.leaderboard(slug, period)
        List {
            Section {
                Picker("Period", selection: $period) {
                    ForEach(Self.periods, id: \.0) { Text($0.1).tag($0.0) }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("leaderboard.period")
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }
            if let me = board?.me {
                Section("You") {
                    HStack(spacing: 8) {
                        StatTile(label: "Rank", value: "#\(me.rank)", emphasis: game.theme.accentText)
                        StatTile(label: "Best", value: "\(Int(me.bestScore.rounded()))")
                        StatTile(label: game.raceStats ? "Races" : "Games", value: "\(Int(me.races))")
                        StatTile(label: "Wins", value: "\(Int(me.wins))")
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("leaderboard.me")
                }
            }
            Section(game.scoreLabel) {
                if let board {
                    if board.entries.isEmpty {
                        Text("No results yet — be the first on the board.").foregroundStyle(.secondary)
                            .accessibilityIdentifier("leaderboard.empty")
                    }
                    ForEach(board.entries, id: \.user.id) { entry in
                        EntryRow(entry: entry, game: game, isMe: entry.user.id == env.auth.user?.id)
                    }
                } else if let failure {
                    ErrorBanner(message: failure, retry: { Task { await load() } }, identifier: "leaderboard.error")
                } else {
                    SkeletonRows(count: 3)
                }
            }
        }
        .navigationTitle("\(game.name) leaderboard")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("leaderboard.screen")
        .refreshable { await load() }
        .task(id: period) { await load() }
    }

    private func load() async {
        do {
            try await env.games.loadLeaderboard(slug, period: period)
            failure = nil
        } catch {
            let message = APIError.from(error)
            if !message.isCancelled { failure = message.message }
        }
    }
}

private struct EntryRow: View {
    let entry: LeaderboardEntry
    let game: GameDefinition
    let isMe: Bool

    var body: some View {
        HStack(spacing: 10) {
            if entry.rank <= 3 { PlaceBadge(place: entry.rank, size: 26) } else {
                Text("\(entry.rank)").font(.subheadline.weight(.bold)).monospacedDigit().frame(width: 26)
            }
            AvatarView(userId: entry.user.id, size: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(isMe ? "\(entry.user.shownName) (you)" : entry.user.shownName)
                    .font(.subheadline.weight(.semibold)).lineLimit(1)
                    .foregroundStyle(isMe ? game.theme.accentText : .primary)
                Text("\(Int(entry.races)) \(game.raceStats ? "races" : "games") · \(Int(entry.wins)) wins · \(game.accuracyLabel) \(Int(entry.averageAccuracy.rounded()))%")
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.8)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 0) {
                Text("\(Int(entry.bestScore.rounded()))").font(.headline).monospacedDigit()
                Text(game.scoreUnit).font(.caption2).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("leaderboard.entry.\(entry.user.id)")
    }
}
