import ChatAPI
import Foundation

typealias GameSlug = Components.Schemas.GameId
typealias GameLobby = Components.Schemas.GameLobby
typealias GameLobbyPlayer = Components.Schemas.GameLobbyPlayer
typealias GameLobbyPhase = Components.Schemas.GameLobbyPhase
typealias GameChatMessage = Components.Schemas.GameChatMessage
typealias Leaderboard = Components.Schemas.Leaderboard
typealias LeaderboardEntry = Components.Schemas.LeaderboardEntry
typealias LeaderboardPeriod = Components.Schemas.LeaderboardPeriod
typealias DrawingGame = Components.Schemas.DrawingGame
typealias DrawingEntry = Components.Schemas.DrawingEntry
typealias DrawingAnswer = Components.Schemas.DrawingAnswer
typealias DrawingStage = Components.Schemas.DrawingStage
typealias DrawingStroke = Components.Schemas.DrawingStroke
typealias DrawingBrush = Components.Schemas.DrawingBrush
typealias DrawingPack = Components.Schemas.DrawingPack
typealias ReflexRound = Components.Schemas.ReflexRound
typealias ReflexKind = Components.Schemas.ReflexKind
typealias ReflexDirection = Components.Schemas.ReflexDirection
typealias ReflexOutcome = Components.Schemas.ReflexOutcome
typealias ReflexTap = Components.Schemas.ReflexTap

/// Wall-clock milliseconds on this device.
func localNowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

/// The server's clock as seen from here. Every lobby response carries
/// `serverNow`; countdowns, race timers and Sketchy stages render against it
/// (the clock finishes are timed by), not against this device's clock.
///
/// Like the web (`noteServerClock` in web/src/lib/games/lobby.ts), each sample
/// is taken at the midpoint of its request's round trip — that's when the
/// server most likely read its clock — and of the last few samples the one
/// with the shortest round trip wins, since its midpoint guess can be the
/// least wrong and one slow response then can't jolt the clock.
struct ServerClock: Sendable, Equatable {
    struct Sample: Sendable, Equatable {
        var offsetMs: Double
        var roundTripMs: Double
    }

    static let maxSamples = 8
    private(set) var samples: [Sample] = []
    /// Local clock minus server clock.
    private(set) var offsetMs: Double = 0

    mutating func note(serverNow: Int, sentAt: Double, receivedAt: Double) {
        let roundTrip = max(receivedAt - sentAt, 0)
        samples.append(Sample(offsetMs: sentAt + roundTrip / 2 - Double(serverNow), roundTripMs: roundTrip))
        if samples.count > Self.maxSamples { samples.removeFirst() }
        offsetMs = samples.min { $0.roundTripMs < $1.roundTripMs }?.offsetMs ?? 0
    }

    func serverNow(local: Double = localNowMs()) -> Double { local - offsetMs }
}

enum LobbyTiming {
    /// The phase as of `now` on the server's clock — the server derives the
    /// same thing at read time (`lobbyPhase` in src/GamesHandler.ts), but only
    /// when asked; this keeps countdown → racing → finished moving on screen
    /// between fetches. A port of `livePhase` (web/src/lib/games/lobby.ts).
    static func livePhase(_ lobby: GameLobby, now: Double) -> GameLobbyPhase {
        guard lobby.phase != .waiting, let startsAt = lobby.startsAt, let endsAt = lobby.endsAt else { return .waiting }
        if now < Double(startsAt) { return .countdown }
        if now >= Double(endsAt) { return .finished }
        // A Sketchy game's end depends on submissions this client can't see —
        // `endsAt` is only its latest possible end — so past the countdown the
        // server has the final word.
        if lobby.drawing != nil { return lobby.phase == .countdown ? .racing : lobby.phase }
        if !lobby.players.isEmpty, lobby.players.allSatisfy({ $0.durationMs != nil }) { return .finished }
        return .racing
    }

    /// Whole seconds left on a countdown (3, 2, 1), nil once it's over.
    static func countdownSeconds(startsAt: Int?, now: Double) -> Int? {
        guard let startsAt else { return nil }
        let left = Double(startsAt) - now
        guard left > 0 else { return nil }
        return Int((left / 1000).rounded(.up))
    }

    /// Seconds left until `endsAt` (never negative).
    static func secondsLeft(until endsAt: Int, now: Double) -> Int {
        max(0, Int(((Double(endsAt) - now) / 1000).rounded(.up)))
    }

    /// Whether the client's view of the lobby is behind the clock: the
    /// countdown, a Sketchy stage or the whole game should have moved on, but
    /// the server's word on it hasn't arrived (no event marks a stage ending
    /// on its timer) — time to refetch.
    static func isOverdue(_ lobby: GameLobby, now: Double) -> Bool {
        if lobby.phase == .countdown, let startsAt = lobby.startsAt, now >= Double(startsAt) { return true }
        if let stage = lobby.drawing?.stage, now >= Double(stage.endsAt) { return true }
        if lobby.phase != .finished, lobby.phase != .waiting, livePhase(lobby, now: now) == .finished { return true }
        return false
    }
}

/// A sliding one-second budget, like the server's per-connection one in
/// src/RealtimeSocket.ts: `allow` records `now` and says yes while under
/// `max` events in the last second, no once it's spent.
struct RateBudget: Sendable, Equatable {
    let max: Int
    let windowMs: Double
    private(set) var stamps: [Double] = []

    init(max: Int, windowMs: Double = 1000) {
        self.max = max
        self.windowMs = windowMs
    }

    mutating func allow(at now: Double) -> Bool {
        stamps.removeAll { now - $0 >= windowMs }
        guard stamps.count < max else { return false }
        stamps.append(now)
        return true
    }
}

/// When a typing race streams its position: at most every `intervalMs`, plus
/// straight away on a word boundary or the finish (so a lane moves in
/// word-sized steps), and never the same value twice. A port of the throttle
/// in `useTypingRace` (web/src/lib/games/typing.ts).
struct ProgressThrottle: Sendable, Equatable {
    var intervalMs: Double = 150
    private(set) var lastSentAt: Double = -.infinity
    private(set) var lastSent: Int = -1

    mutating func shouldSend(_ value: Int, at now: Double, force: Bool) -> Bool {
        guard value != lastSent else { return false }
        guard force || now - lastSentAt >= intervalMs else { return false }
        lastSentAt = now
        lastSent = value
        return true
    }

    /// The trailing flush: a typist who stops just after a throttled
    /// keystroke still has their exact position shown.
    mutating func flush(_ value: Int, at now: Double) -> Bool {
        shouldSend(value, at: now, force: true)
    }

    mutating func reset() {
        lastSentAt = -.infinity
        lastSent = -1
    }
}

/// The lobby browser's list for one game.
struct LobbyListState: Sendable, Equatable {
    private(set) var lobbies: [GameLobby] = []
    private(set) var hasLoaded = false

    /// A fresh listing replaces everything (the server already left out
    /// finished, stale and abandoned lobbies, newest first).
    mutating func replace(with fetched: [GameLobby]) {
        lobbies = fetched.filter { $0.phase != .finished }
        hasLoaded = true
    }

    /// A lobby this client just created, joined or saw change: updated in
    /// place, added at the top when new, dropped once it's finished (the
    /// browser only lists lobbies still gathering or mid-game).
    mutating func upsert(_ lobby: GameLobby) {
        if lobby.phase == .finished {
            remove(lobby.id)
            return
        }
        var listed = lobby
        // The browser never shows a passage or a game's secrets.
        listed.passage = nil
        if let index = lobbies.firstIndex(where: { $0.id == lobby.id }) {
            lobbies[index] = listed
        } else {
            lobbies.insert(listed, at: 0)
        }
    }

    mutating func remove(_ id: Int) { lobbies.removeAll { $0.id == id } }
}

enum GameFormat {
    static func duration(_ ms: Double) -> String {
        let seconds = ms / 1000
        if seconds < 60 { return String(format: "%.1fs", seconds) }
        let minutes = Int(seconds / 60)
        return String(format: "%d:%02d", minutes, Int(seconds.truncatingRemainder(dividingBy: 60)))
    }

    static func ordinal(_ place: Int) -> String {
        let mod100 = place % 100
        if (11...13).contains(mod100) { return "\(place)th" }
        switch place % 10 {
        case 1: return "\(place)st"
        case 2: return "\(place)nd"
        case 3: return "\(place)rd"
        default: return "\(place)th"
        }
    }
}

extension GameLobby {
    func player(_ userId: Int?) -> GameLobbyPlayer? {
        guard let userId else { return nil }
        return players.first { $0.user.id == userId }
    }

    var host: GameLobbyPlayer? { players.first { $0.user.id == hostId } }
}
