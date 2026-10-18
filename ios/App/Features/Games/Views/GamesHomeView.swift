import SwiftUI

/// The Games tab's root: the arcade's games, each opening its lobby browser.
struct GamesHomeView: View {
    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                Text("Play live with everyone here — race, draw, react.")
                    .font(.subheadline).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                ForEach(GameDefinition.all) { game in
                    if let slug = game.slug {
                        NavigationLink(value: Route.game(slug.rawValue)) { GameCard(game: game) }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("games.card.\(slug.rawValue)")
                    } else {
                        GameCard(game: game)
                            .opacity(0.6)
                            .accessibilityIdentifier("games.card.\(game.id)")
                    }
                }
            }
            .padding()
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("Games")
        .accessibilityIdentifier("games.home")
    }
}

private struct GameCard: View {
    let game: GameDefinition

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            GameIcon(game: game, size: 52)
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(game.name).font(.headline)
                    Spacer()
                    if !game.isPlayable {
                        Text("Soon").font(.caption.weight(.bold))
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .background(Color(.tertiarySystemFill), in: Capsule())
                    } else {
                        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                    }
                }
                Text(game.tagline).font(.subheadline.weight(.semibold)).foregroundStyle(game.theme.accentText)
                Text(game.description).font(.footnote).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Label(game.players, systemImage: "person.2").font(.caption).foregroundStyle(.secondary)
                    .padding(.top, 2)
            }
        }
        .padding(16)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
        .overlay(alignment: .top) {
            UnevenRoundedRectangle(topLeadingRadius: 18, topTrailingRadius: 18).fill(game.theme.gradient).frame(height: 4)
        }
        .contentShape(RoundedRectangle(cornerRadius: 18))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(game.name). \(game.tagline). \(game.players)\(game.isPlayable ? "" : ". Coming soon")")
    }
}
