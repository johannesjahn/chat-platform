import ChatAPI
import Foundation
import Observation

/// Lobbies (cached by id), each game's lobby browser list, lobby chats, the
/// server-corrected clock, and the two transient socket streams — racer
/// positions (`game_progress`) and flung emoji (`game_reaction`), which have
/// no REST resource behind them. Owned by `AppEnvironment`; the lobby and the
/// hub screens read from it, so a refetch anywhere shows everywhere.
///
/// Nothing here decides a game: phases and Sketchy stages come from the
/// server's timestamps on `clock`, scores from the server's answers.
@MainActor
@Observable
final class GameStore {
    private(set) var lobbies: [Int: GameLobby] = [:]
    /// Lobbies the server says are gone (everyone left, or a bad link).
    private(set) var closedLobbies: Set<Int> = []
    private(set) var lists: [GameSlug: LobbyListState] = [:]
    private(set) var chats: [Int: [GameChatMessage]] = [:]
    private(set) var leaderboards: [String: Leaderboard] = [:]
    private(set) var packs: [DrawingPack]?
    private(set) var clock = ServerClock()
    /// Every live position each racer has moved through, per lobby (a Reflex
    /// row needs them all, a race lane only the last).
    private(set) var progressLog: [Int: [Int: [Int]]] = [:]
    private(set) var flying: [FlyingReaction] = []
    /// A Reflex Rush player's own verdicts so far, by lobby and round, so a
    /// trip away from the lobby screen mid-game doesn't lose them.
    var reflexResults: [String: [Reflex.LiveResult?]] = [:]
    var reflexTaps: [String: [ReflexTap?]] = [:]

    struct FlyingReaction: Identifiable, Equatable, Sendable {
        let id: Int
        let lobbyId: Int
        let userId: Int
        let reaction: String
        /// Horizontal lane, 0–1, and a little drift so a burst fans out.
        let x: Double
        let drift: Double
    }

    /// The emoji anyone watching a lobby can fling — exactly the server's
    /// `GAME_REACTIONS` (src/games/reactions.ts), which drops anything else;
    /// shown in this order.
    static let reactions = ["👏", "🔥", "😂", "😮", "😱", "💀", "❤️", "👀"]
    static let reactionFlightSeconds = 2.6
    private static let maxInFlight = 40

    private let api: APIClient
    private let users: UserStore
    private let realtime: RealtimeClient
    // Kept under the server's per-connection budgets (15 progress frames and
    // 4 reactions a second, src/RealtimeSocket.ts), which drop the excess.
    private var progressBudget = RateBudget(max: 12)
    private var reactionBudget = RateBudget(max: 4)
    private var nextReactionKey = 1

    init(api: APIClient, users: UserStore, realtime: RealtimeClient) {
        self.api = api
        self.users = users
        self.realtime = realtime
    }

    func lobby(_ id: Int) -> GameLobby? { lobbies[id] }
    func list(_ game: GameSlug) -> LobbyListState { lists[game] ?? LobbyListState() }
    func serverNow() -> Double { clock.serverNow() }

    // MARK: lobbies

    /// Stores a lobby the server just sent, and feeds its `serverNow` to the
    /// clock (sampled over the request's round trip).
    @discardableResult
    func absorb(_ lobby: GameLobby, sentAt: Double) -> GameLobby {
        clock.note(serverNow: lobby.serverNow, sentAt: sentAt, receivedAt: localNowMs())
        let previous = lobbies[lobby.id]
        lobbies[lobby.id] = lobby
        closedLobbies.remove(lobby.id)
        for player in lobby.players { users.store(player.user) }
        lists[lobby.game, default: LobbyListState()].upsert(lobby)
        // Live positions belong to one round: a rematch (whoever pressed it)
        // wipes the last one's, or the next round's would sit behind them.
        if lobby.phase == .waiting, previous.map({ $0.round != lobby.round || $0.phase != .waiting }) ?? false {
            resetProgress(lobby.id)
        }
        return lobby
    }

    @discardableResult
    func fetchLobby(_ id: Int) async throws -> GameLobby {
        let sent = localNowMs()
        do {
            let lobby = try await api.call { try await $0.games_getGameLobby(path: .init(id: String(id))) }.ok.body.json
            return absorb(lobby, sentAt: sent)
        } catch let error as APIError where error.isNotFound {
            if let gone = lobbies.removeValue(forKey: id) { lists[gone.game]?.remove(id) }
            closedLobbies.insert(id)
            throw error
        }
    }

    func loadLobbies(_ game: GameSlug) async throws {
        let sent = localNowMs()
        let fetched = try await api.call { try await $0.games_listGameLobbies(path: .init(game: game)) }.ok.body.json.lobbies
        if let first = fetched.first { clock.note(serverNow: first.serverNow, sentAt: sent, receivedAt: localNowMs()) }
        for lobby in fetched { for player in lobby.players { users.store(player.user) } }
        lists[game, default: LobbyListState()].replace(with: fetched)
    }

    func createLobby(_ game: GameSlug) async throws -> GameLobby {
        let sent = localNowMs()
        let created = try await api.call { try await $0.games_createGameLobby(path: .init(game: game)) }.created.body.json
        return absorb(try reshape(created, as: GameLobby.self), sentAt: sent)
    }

    func quickPlay(_ game: GameSlug) async throws -> GameLobby {
        let sent = localNowMs()
        return absorb(try await api.call { try await $0.games_quickPlay(path: .init(game: game)) }.ok.body.json, sentAt: sent)
    }

    func join(_ id: Int) async throws {
        let sent = localNowMs()
        absorb(try await api.call { try await $0.games_joinGameLobby(path: .init(id: String(id))) }.ok.body.json, sentAt: sent)
    }

    func start(_ id: Int) async throws {
        let sent = localNowMs()
        absorb(try await api.call { try await $0.games_startGameLobby(path: .init(id: String(id))) }.ok.body.json, sentAt: sent)
    }

    func rematch(_ id: Int) async throws {
        let sent = localNowMs()
        resetProgress(id)
        absorb(try await api.call { try await $0.games_rematchGameLobby(path: .init(id: String(id))) }.ok.body.json, sentAt: sent)
    }

    func leave(_ id: Int) async throws {
        _ = try await api.call { try await $0.games_leaveGameLobby(path: .init(id: String(id))) }.noContent
        // Whether the lobby survives (someone else is still in it) is the
        // server's call; the next listing says.
        if let game = lobbies[id]?.game { try? await loadLobbies(game) }
        _ = try? await fetchLobby(id)
    }

    func invite(_ userId: Int, to id: Int) async throws {
        _ = try await api.call { try await $0.games_inviteToGameLobby(path: .init(id: String(id)), body: .json(.init(userId: userId))) }.noContent
    }

    func searchUsers(_ query: String) async throws -> [User] {
        try await api.call { try await $0.users_searchUsers(query: .init(q: query)) }.ok.body.json
    }

    // MARK: playing

    /// Submits a finished race — the typed text and the wrong-keystroke
    /// count. The server checks the text, times it on its own clock and
    /// scores it.
    func finishRace(_ id: Int, typed: String, errors: Int) async throws {
        let sent = localNowMs()
        let lobby = try await api.call {
            try await $0.games_finishRace(path: .init(id: String(id)), body: .json(.init(typed: typed, errors: errors)))
        }.ok.body.json
        absorb(lobby, sentAt: sent)
        leaderboards = leaderboards.filter { !$0.key.hasPrefix("\(lobby.game.rawValue):") }
    }

    /// Submits a played Reflex Rush game, one tap per round.
    func finishReflex(_ id: Int, taps: [ReflexTap]) async throws {
        let sent = localNowMs()
        let lobby = try await api.call {
            try await $0.games_finishReflex(path: .init(id: String(id)), body: .json(.init(taps: taps)))
        }.ok.body.json
        absorb(lobby, sentAt: sent)
        leaderboards = leaderboards.filter { !$0.key.hasPrefix("reflex:") }
    }

    func updateDrawingSettings(_ id: Int, packs: [String], rounds: Int) async throws {
        let sent = localNowMs()
        absorb(try await api.call {
            try await $0.games_updateDrawingSettings(path: .init(id: String(id)), body: .json(.init(packs: packs, rounds: rounds)))
        }.ok.body.json, sentAt: sent)
    }

    func submitDrawing(_ id: Int, strokes: [DrawingStroke]) async throws {
        let sent = localNowMs()
        absorb(try await api.call {
            try await $0.games_submitDrawing(path: .init(id: String(id)), body: .json(.init(strokes: strokes)))
        }.ok.body.json, sentAt: sent)
    }

    func submitBluff(_ id: Int, text: String) async throws {
        let sent = localNowMs()
        absorb(try await api.call {
            try await $0.games_submitBluff(path: .init(id: String(id)), body: .json(.init(text: text)))
        }.ok.body.json, sentAt: sent)
    }

    func submitVote(_ id: Int, answer: Int) async throws {
        let sent = localNowMs()
        absorb(try await api.call {
            try await $0.games_submitVote(path: .init(id: String(id)), body: .json(.init(answer: answer)))
        }.ok.body.json, sentAt: sent)
    }

    func loadPacks() async throws -> [DrawingPack] {
        if let packs { return packs }
        let loaded = try await api.call { try await $0.games_listDrawingPacks() }.ok.body.json.packs
        packs = loaded
        return loaded
    }

    // MARK: chat

    func loadChat(_ id: Int) async throws {
        let messages = try await api.call { try await $0.games_listGameChat(path: .init(id: String(id))) }.ok.body.json.messages
        chats[id] = messages
    }

    /// Says something in the lobby chat and shows it straight away; the
    /// realtime echo's refetch confirms it.
    func postChat(_ id: Int, text: String) async throws {
        let created = try await api.call {
            try await $0.games_postGameChat(path: .init(id: String(id)), body: .json(.init(text: text)))
        }.created.body.json
        let message = try reshape(created, as: GameChatMessage.self)
        if !(chats[id] ?? []).contains(where: { $0.id == message.id }) { chats[id, default: []].append(message) }
    }

    // MARK: leaderboard

    static func leaderboardKey(_ game: GameSlug, _ period: LeaderboardPeriod) -> String { "\(game.rawValue):\(period.rawValue)" }

    func leaderboard(_ game: GameSlug, _ period: LeaderboardPeriod) -> Leaderboard? {
        leaderboards[Self.leaderboardKey(game, period)]
    }

    func loadLeaderboard(_ game: GameSlug, period: LeaderboardPeriod) async throws {
        let board = try await api.call { try await $0.games_getLeaderboard(path: .init(game: game), query: .init(period: period)) }.ok.body.json
        for entry in board.entries { users.store(entry.user) }
        leaderboards[Self.leaderboardKey(game, period)] = board
    }

    // MARK: live positions (game_progress)

    /// This client's position, out to everyone in the lobby room (the server
    /// stamps who sent it). Over budget, a frame is dropped; the next one
    /// carries the latest position anyway.
    func sendProgress(_ lobbyId: Int, _ value: Int, me: Int?) {
        if let me { noteProgress(lobbyId, userId: me, value) }
        guard progressBudget.allow(at: localNowMs()) else { return }
        realtime.send(["type": "game_progress", "lobbyId": lobbyId, "progress": value])
    }

    func noteProgress(_ lobbyId: Int, userId: Int, _ value: Int) {
        let log = progressLog[lobbyId]?[userId] ?? []
        // Frames can overtake one another; a lane never slides back.
        if let last = log.last, last >= value { return }
        progressLog[lobbyId, default: [:]][userId] = log + [value]
    }

    func progress(_ lobbyId: Int, userId: Int) -> Int { progressLog[lobbyId]?[userId]?.last ?? 0 }
    func progressHistory(_ lobbyId: Int, userId: Int) -> [Int] { progressLog[lobbyId]?[userId] ?? [] }

    func resetProgress(_ lobbyId: Int) { progressLog[lobbyId] = nil }

    // MARK: reactions (game_reaction)

    /// Flings `reaction` for everyone in the lobby: drawn here straight away
    /// (the server's echo of our own is then skipped). False when it's not
    /// one of the fixed set or the per-second budget is spent.
    @discardableResult
    func fling(_ reaction: String, in lobbyId: Int, me: Int) -> Bool {
        guard Self.reactions.contains(reaction), reactionBudget.allow(at: localNowMs()) else { return false }
        noteReaction(reaction, in: lobbyId, from: me)
        realtime.send(["type": "game_reaction", "lobbyId": lobbyId, "reaction": reaction])
        return true
    }

    func noteReaction(_ reaction: String, in lobbyId: Int, from userId: Int) {
        let entry = FlyingReaction(
            id: nextReactionKey, lobbyId: lobbyId, userId: userId, reaction: reaction,
            x: Double.random(in: 0.1...0.9), drift: Double.random(in: -1...1)
        )
        nextReactionKey += 1
        flying = Array((flying + [entry]).suffix(Self.maxInFlight))
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.reactionFlightSeconds))
            self?.flying.removeAll { $0.id == entry.id }
        }
    }

    // MARK: realtime

    /// The transient streams; id-only lobby events are invalidations, handled
    /// by `AppEnvironment.handle(_:)`.
    func handle(_ event: RealtimeEvent, me: Int?) {
        switch event {
        case .gameProgress(let lobbyId, let userId, let progress):
            // Our own frames are already noted locally.
            if userId != me { noteProgress(lobbyId, userId: userId, progress) }
        case .gameReaction(let lobbyId, let userId, let reaction):
            if userId != me, Self.reactions.contains(reaction) { noteReaction(reaction, in: lobbyId, from: userId) }
        default:
            break
        }
    }
}
