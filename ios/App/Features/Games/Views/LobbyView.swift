import SwiftUI

/// One lobby (the web's `/games/$game/$lobbyId`), for any game: the waiting
/// room, the countdown, the game's own play area, and the results — with
/// the lobby chat and reactions throughout. Which of those shows is the
/// lobby's phase on the server-corrected clock; while it's on screen the
/// screen sits in the `game-lobby:<id>` room.
struct LobbyView: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let lobbyId: Int

    @State private var now: Double = 0
    @State private var room: RoomToken?
    @State private var failure: String?
    @State private var actionError: String?
    @State private var busy = false
    @State private var inviting = false
    @State private var lastRefetch: Double = 0

    var body: some View {
        Group {
            if let lobby = env.games.lobby(lobbyId) {
                content(lobby)
            } else if env.games.closedLobbies.contains(lobbyId) {
                EmptyState(title: "This lobby has closed", systemImage: "door.left.hand.closed",
                           message: "Everyone left, or the link is wrong. Find another game in the lobby browser.",
                           identifier: "lobby.closed",
                           action: (title: "Back to the arcade", run: { dismiss() }))
            } else if let failure {
                EmptyState(title: "Couldn't load the lobby", systemImage: "wifi.exclamationmark", message: failure,
                           identifier: "lobby.error", action: (title: "Try again", run: { Task { await load() } }))
            } else {
                ProgressView().accessibilityIdentifier("lobby.loading")
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let lobby = env.games.lobby(lobbyId), lobby.player(env.auth.user?.id) != nil {
                ToolbarItem(placement: .primaryAction) {
                    Button("Leave", role: .destructive) { Task { await leave() } }
                        .disabled(busy)
                        .accessibilityIdentifier("lobby.leave")
                }
            }
        }
        .onAppear {
            if room == nil { room = env.realtime.joinRoom("game-lobby:\(lobbyId)") }
            now = env.games.serverNow()
        }
        .onDisappear { room?.cancel(); room = nil }
        .task(id: env.invalidations.token(.games)) { await load() }
        .task(id: tickInterval) { await tick() }
        .sheet(isPresented: $inviting) {
            if let lobby = env.games.lobby(lobbyId) { InviteSheet(lobby: lobby, meId: env.auth.user?.id) }
        }
    }

    private var title: String {
        guard let lobby = env.games.lobby(lobbyId) else { return "Lobby" }
        return lobby.host.map { "\($0.user.shownName)'s lobby" } ?? "Lobby #\(lobby.id)"
    }

    /// A fast clock through the countdown (so the numbers land on the beat),
    /// a steadier one while playing, none while waiting or done.
    private var tickInterval: Int? {
        guard let lobby = env.games.lobby(lobbyId) else { return nil }
        switch lobby.phase {
        case .countdown: return 50
        case .racing: return 100
        case .waiting, .finished: return nil
        }
    }

    private func tick() async {
        now = env.games.serverNow()
        guard let interval = tickInterval else { return }
        while !Task.isCancelled {
            now = env.games.serverNow()
            // Stages and races end on the clock as often as on a submission,
            // and only a submission sends an event — so once the clock says
            // the server's state should have moved on, ask (and keep asking).
            if let lobby = env.games.lobby(lobbyId), LobbyTiming.isOverdue(lobby, now: now), now - lastRefetch > 700 {
                lastRefetch = now
                Task { _ = try? await env.games.fetchLobby(lobbyId) }
            }
            try? await Task.sleep(for: .milliseconds(interval))
        }
    }

    private func load() async {
        do {
            try await env.games.fetchLobby(lobbyId)
            failure = nil
        } catch {
            let message = APIError.from(error)
            if !message.isCancelled, !message.isNotFound { failure = message.message }
        }
        now = env.games.serverNow()
    }

    @ViewBuilder
    private func content(_ lobby: GameLobby) -> some View {
        let game = GameDefinition.playable(lobby.game)
        let meId = env.auth.user?.id
        let me = lobby.player(meId)
        let phase = LobbyTiming.livePhase(lobby, now: now)
        ScrollView {
            VStack(spacing: 16) {
                header(lobby, game: game, phase: phase, seated: me != nil)
                if let actionError { ErrorBanner(message: actionError, identifier: "lobby.actionError") }
                switch phase {
                case .waiting:
                    waitingRoom(lobby, game: game, meId: meId, seated: me != nil)
                case .countdown, .racing:
                    playArea(lobby, game: game, meId: meId)
                case .finished:
                    results(lobby, game: game, meId: meId)
                }
                if let meId { LobbyChatPanel(lobby: lobby, game: game, meId: meId) }
            }
            .padding()
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Color(.systemGroupedBackground))
        .overlay { ReactionStream(lobbyId: lobby.id) }
        .accessibilityIdentifier("lobby.screen")
    }

    private func header(_ lobby: GameLobby, game: GameDefinition, phase: GameLobbyPhase, seated: Bool) -> some View {
        HStack(spacing: 10) {
            GameIcon(game: game, size: 36)
            VStack(alignment: .leading, spacing: 4) {
                Text(game.name).font(.headline)
                HStack(spacing: 8) {
                    PhaseBadge(phase: phase)
                    Label("\(lobby.players.count)/\(lobby.maxPlayers)", systemImage: "person.2")
                        .font(.caption).monospacedDigit().foregroundStyle(.secondary)
                        .accessibilityLabel("\(lobby.players.count) of \(lobby.maxPlayers) players")
                    if lobby.round > 1 { Text("Round \(lobby.round)").font(.caption).foregroundStyle(.secondary) }
                    if !seated {
                        Label("Spectating", systemImage: "eye").font(.caption).foregroundStyle(.secondary)
                            .accessibilityIdentifier("lobby.spectating")
                    }
                }
            }
            Spacer()
        }
    }

    // MARK: waiting room

    @ViewBuilder
    private func waitingRoom(_ lobby: GameLobby, game: GameDefinition, meId: Int?, seated: Bool) -> some View {
        let isHost = lobby.hostId == meId
        let full = lobby.players.count >= lobby.maxPlayers
        let missing = max(0, lobby.minPlayers - lobby.players.count)
        GamePanel(title: "Waiting room", systemImage: "person.3", identifier: "lobby.waiting") {
            LobbySeats(lobby: lobby, meId: meId)
            if seated, !full {
                Button { inviting = true } label: { Label("Invite players", systemImage: "person.badge.plus") }
                    .buttonStyle(.bordered)
                    .frame(maxWidth: .infinity)
                    .accessibilityIdentifier("lobby.invite")
            }
            VStack(spacing: 8) {
                if isHost {
                    Button { Task { await act { try await env.games.start(lobby.id) } } } label: {
                        Label(lobby.players.count == 1 ? game.startSoloVerb : game.startVerb, systemImage: "play.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(GameButtonStyle(theme: game.theme))
                    .disabled(busy || missing > 0)
                    .accessibilityIdentifier("lobby.start")
                    if missing > 0 {
                        Text("Waiting for \(missing) more \(missing == 1 ? "player" : "players") — this game needs \(lobby.minPlayers)")
                            .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                            .accessibilityIdentifier("lobby.needsPlayers")
                    }
                } else if seated {
                    Label("Waiting for \(lobby.host?.user.shownName ?? "the host") to start", systemImage: "hourglass")
                        .font(.subheadline).foregroundStyle(.secondary)
                        .accessibilityIdentifier("lobby.waitingForHost")
                } else {
                    Button { Task { await act { try await env.games.join(lobby.id) } } } label: {
                        Label(full ? "Lobby full" : game.joinVerb, systemImage: "figure.run").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(GameButtonStyle(theme: game.theme))
                    .disabled(busy || full)
                    .accessibilityIdentifier("lobby.join")
                }
            }
            .frame(maxWidth: .infinity)
        }
        switch lobby.game {
        case .drawing: SketchySettings(lobby: lobby, game: game, isHost: isHost)
        case .reflex: ReflexGuide(game: game)
        case .typing: EmptyView()
        }
    }

    // MARK: play

    @ViewBuilder
    private func playArea(_ lobby: GameLobby, game: GameDefinition, meId: Int?) -> some View {
        switch lobby.game {
        case .typing: TypingRaceView(lobby: lobby, game: game, meId: meId, now: now)
        case .reflex: ReflexPlayView(lobby: lobby, game: game, meId: meId, now: now)
        case .drawing: SketchyPlayView(lobby: lobby, game: game, meId: meId, now: now)
        }
    }

    // MARK: results

    @ViewBuilder
    private func results(_ lobby: GameLobby, game: GameDefinition, meId: Int?) -> some View {
        let isHost = lobby.hostId == meId
        GamePanel(title: "Results", systemImage: "trophy.fill", identifier: "lobby.results") {
            ResultsPodium(lobby: lobby, game: game, meId: meId)
            if isHost {
                Button { Task { await act { try await env.games.rematch(lobby.id) } } } label: {
                    Label("Rematch", systemImage: "arrow.counterclockwise").frame(maxWidth: .infinity)
                }
                .buttonStyle(GameButtonStyle(theme: game.theme))
                .disabled(busy)
                .accessibilityIdentifier("lobby.rematch")
            } else if lobby.player(meId) != nil {
                Label("Waiting for a rematch", systemImage: "hourglass").font(.footnote).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
            }
            Button { env.router.push(.leaderboard(lobby.game.rawValue)) } label: {
                Label("See the leaderboard", systemImage: "trophy").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("lobby.leaderboard")
        }
        switch lobby.game {
        case .drawing: SketchyGallery(lobby: lobby)
        case .reflex: ReflexBreakdown(lobby: lobby, game: game, meId: meId)
        case .typing: EmptyView()
        }
    }

    // MARK: actions

    private func act(_ action: () async throws -> Void) async {
        busy = true
        defer { busy = false }
        do {
            try await action()
            actionError = nil
            now = env.games.serverNow()
        } catch {
            actionError = APIError.from(error).message
        }
    }

    private func leave() async {
        busy = true
        defer { busy = false }
        do {
            try await env.games.leave(lobbyId)
            dismiss()
        } catch {
            actionError = APIError.from(error).message
        }
    }
}
