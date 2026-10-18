import SwiftUI

/// One game's lobby browser (the web's `/games/$game`): quick play, a new
/// lobby, every open lobby — kept live through the `game-hub:<game>` room —
/// and the way to its leaderboard.
struct GameHubView: View {
    let slug: String

    var body: some View {
        if let game = GameDefinition.playable(slug: slug), let id = game.slug {
            GameHubContent(game: game, slug: id)
        } else {
            EmptyState(title: "Game not found", systemImage: "gamecontroller", message: "That game isn't in the arcade (yet).", identifier: "hub.unknown")
        }
    }
}

private struct GameHubContent: View {
    @Environment(AppEnvironment.self) private var env
    let game: GameDefinition
    let slug: GameSlug
    @State private var failure: String?
    @State private var actionError: String?
    @State private var busy = false
    @State private var room: RoomToken?

    var body: some View {
        let list = env.games.list(slug)
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                if let actionError { ErrorBanner(message: actionError, identifier: "hub.actionError") }
                HStack(spacing: 10) {
                    Button { Task { await open { try await env.games.quickPlay(slug) } } } label: {
                        Label("Quick play", systemImage: "bolt.fill").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(GameButtonStyle(theme: game.theme))
                    .accessibilityIdentifier("hub.quickPlay")
                    Button { Task { await open { try await env.games.createLobby(slug) } } } label: {
                        Label("New lobby", systemImage: "plus").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered).controlSize(.large)
                    .accessibilityIdentifier("hub.newLobby")
                }
                .disabled(busy)

                steps

                GamePanel(title: "Open lobbies", systemImage: "door.left.hand.open", identifier: "hub.lobbies") {
                    if !list.hasLoaded {
                        if let failure {
                            ErrorBanner(message: failure, retry: { Task { await load() } }, identifier: "hub.error")
                        } else {
                            ForEach(0..<3, id: \.self) { _ in
                                RoundedRectangle(cornerRadius: 12).fill(Color(.tertiarySystemFill)).frame(height: 56)
                            }
                            .accessibilityIdentifier("hub.loading")
                        }
                    } else if list.lobbies.isEmpty {
                        VStack(spacing: 6) {
                            Image(systemName: "flag").font(.title2).foregroundStyle(.secondary)
                            Text("No open lobbies").font(.subheadline.weight(.semibold))
                            Text("Be the first — open a lobby and invite friends, or hit Quick play.")
                                .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity).padding(.vertical, 12)
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("hub.lobbies.empty")
                    } else {
                        ForEach(list.lobbies, id: \.id) { lobby in
                            NavigationLink(value: Route.gameLobby(lobby.id)) { LobbyRow(lobby: lobby, game: game) }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("games.lobby.\(lobby.id)")
                        }
                    }
                }

                NavigationLink(value: Route.leaderboard(slug.rawValue)) {
                    HStack {
                        Label("Leaderboard", systemImage: "trophy.fill").font(.headline)
                        Spacer()
                        Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                    }
                    .padding(16)
                    .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("hub.leaderboard")
            }
            .padding()
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle(game.name)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task(id: env.invalidations.token(.games)) { await load() }
        .onAppear { if room == nil { room = env.realtime.joinRoom("game-hub:\(slug.rawValue)") } }
        .onDisappear { room?.cancel(); room = nil }
    }

    private var header: some View {
        HStack(spacing: 14) {
            GameIcon(game: game, size: 56)
            VStack(alignment: .leading, spacing: 3) {
                Text(game.tagline).font(.title3.weight(.bold)).foregroundStyle(game.theme.accentText)
                Text(game.description).font(.footnote).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var steps: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(game.steps.enumerated()), id: \.offset) { index, step in
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: step.systemImage)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(game.theme.onGradient)
                        .frame(width: 30, height: 30)
                        .background(game.theme.gradient, in: RoundedRectangle(cornerRadius: 8))
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(index + 1). \(step.title)").font(.subheadline.weight(.semibold))
                        Text(step.text).font(.footnote).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    private func load() async {
        do {
            try await env.games.loadLobbies(slug)
            failure = nil
        } catch {
            let message = APIError.from(error)
            if !message.isCancelled { failure = message.message }
        }
    }

    private func open(_ make: @escaping () async throws -> GameLobby) async {
        busy = true
        defer { busy = false }
        do {
            let lobby = try await make()
            actionError = nil
            env.router.push(.gameLobby(lobby.id))
        } catch {
            actionError = APIError.from(error).message
        }
    }
}

private struct LobbyRow: View {
    @Environment(AppEnvironment.self) private var env
    let lobby: GameLobby
    let game: GameDefinition

    var body: some View {
        let phase = LobbyTiming.livePhase(lobby, now: env.games.serverNow())
        HStack(spacing: 12) {
            AvatarView(userId: lobby.hostId, size: 38)
            VStack(alignment: .leading, spacing: 3) {
                Text(lobby.host.map { "\($0.user.shownName)'s lobby" } ?? "Lobby #\(lobby.id)")
                    .font(.subheadline.weight(.semibold)).lineLimit(1)
                HStack(spacing: 8) {
                    PhaseBadge(phase: phase)
                    Label("\(lobby.players.count)/\(lobby.maxPlayers)", systemImage: "person.2")
                        .font(.caption).monospacedDigit().foregroundStyle(.secondary)
                }
            }
            Spacer()
            Text(phase == .waiting && lobby.players.count < lobby.maxPlayers ? "Join" : "Watch")
                .font(.footnote.weight(.semibold)).foregroundStyle(game.theme.accentText)
        }
        .padding(10)
        .background(Color(.tertiarySystemFill).opacity(0.5), in: RoundedRectangle(cornerRadius: 12))
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
