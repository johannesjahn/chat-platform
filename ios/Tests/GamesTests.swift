import Foundation
import Testing

@testable import ChatPlatform

// MARK: fixtures

private func player(_ id: Int, durationMs: Double? = nil, place: Int? = nil) -> String {
    """
    {"user":{"id":\(id),"username":"p\(id)","displayName":null,"avatarUrl":null,"avatarVariants":null,"role":"user","statusText":null,"statusEmoji":null,"statusExpiresAt":null},
     "joinedAt":1,"durationMs":\(durationMs.map { "\($0)" } ?? "null"),"score":null,"accuracy":null,"place":\(place.map(String.init) ?? "null")}
    """
}

private func lobbyJSON(
    id: Int = 1, game: String = "typing", phase: String = "waiting", startsAt: Int? = nil, endsAt: Int? = nil,
    serverNow: Int = 1_000_000, players: [String] = [player(1)], drawing: String = "null", round: Int = 1
) -> String {
    """
    {"id":\(id),"game":"\(game)","hostId":1,"phase":"\(phase)","round":\(round),"passage":null,
     "startsAt":\(startsAt.map(String.init) ?? "null"),"endsAt":\(endsAt.map(String.init) ?? "null"),
     "serverNow":\(serverNow),"minPlayers":1,"maxPlayers":6,"players":[\(players.joined(separator: ","))],
     "drawing":\(drawing),"reflex":null,"chatOpen":true,"createdAt":1}
    """
}

private func lobby(_ json: String) throws -> GameLobby {
    try JSONDecoder().decode(GameLobby.self, from: Data(json.utf8))
}

/// Reads a file of this repo (the simulator can see the host's disk), so the
/// mirrored constants are compared with their real source, not a copy.
private func repoSource(_ path: String) throws -> String {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: root.appending(path: path), encoding: .utf8)
}

/// The string literals in `export const NAME = [ … ]`.
private func stringArray(named name: String, in source: String) -> [String] {
    guard let start = source.range(of: "export const \(name)") else { return [] }
    let rest = source[start.upperBound...]
    guard let open = rest.firstIndex(of: "["), let close = rest[open...].firstIndex(of: "]") else { return [] }
    return rest[open...close].matches(of: /"([^"]*)"/).map { String($0.output.1) }
}

private func number(named name: String, in source: String) -> Double? {
    guard let match = source.firstMatch(of: try! Regex("\(name)\\s*=\\s*([0-9_./ ]+);")) else { return nil }
    let raw = String(match.output[1].substring ?? "").replacingOccurrences(of: "_", with: "").trimmingCharacters(in: .whitespaces)
    if raw.contains("/") {
        let parts = raw.split(separator: "/").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        return parts.count == 2 ? parts[0] / parts[1] : nil
    }
    return Double(raw)
}

// MARK: clock and phases

@Suite struct ServerClockTests {
    @Test func samplesAtTheMidpointOfTheRoundTrip() {
        var clock = ServerClock()
        // Sent at 1000, answered at 1100: the server read its clock (5000) around 1050.
        clock.note(serverNow: 5000, sentAt: 1000, receivedAt: 1100)
        #expect(clock.offsetMs == -3950)
        #expect(clock.serverNow(local: 1200) == 5150)
    }

    @Test func theShortestRoundTripWins() {
        var clock = ServerClock()
        clock.note(serverNow: 5000, sentAt: 1000, receivedAt: 1400) // slow: offset -3800
        clock.note(serverNow: 6000, sentAt: 2000, receivedAt: 2020) // fast: offset -3990
        clock.note(serverNow: 7000, sentAt: 3000, receivedAt: 3300) // slow again
        #expect(clock.offsetMs == -3990)
    }

    @Test func keepsOnlyTheLastFewSamples() {
        var clock = ServerClock()
        clock.note(serverNow: 0, sentAt: 0, receivedAt: 0) // a perfect sample…
        for index in 1...ServerClock.maxSamples {
            clock.note(serverNow: 100, sentAt: Double(index * 1000), receivedAt: Double(index * 1000 + 50))
        }
        // …ages out, and the best of the rest wins.
        #expect(clock.samples.count == ServerClock.maxSamples)
        #expect(clock.offsetMs == 1000 + 25 - 100)
    }
}

@Suite struct LobbyTimingTests {
    @Test func phaseFollowsTheServersTimestamps() throws {
        let waiting = try lobby(lobbyJSON())
        #expect(LobbyTiming.livePhase(waiting, now: 5000) == .waiting)

        let started = try lobby(lobbyJSON(phase: "countdown", startsAt: 10_000, endsAt: 190_000))
        #expect(LobbyTiming.livePhase(started, now: 9_999) == .countdown)
        #expect(LobbyTiming.livePhase(started, now: 10_000) == .racing)
        #expect(LobbyTiming.livePhase(started, now: 190_000) == .finished)
    }

    @Test func aRaceIsOverOnceEveryoneFinished() throws {
        let done = try lobby(lobbyJSON(phase: "racing", startsAt: 0, endsAt: 100_000, players: [player(1, durationMs: 30_000, place: 1), player(2, durationMs: 40_000, place: 2)]))
        #expect(LobbyTiming.livePhase(done, now: 50_000) == .finished)
        let half = try lobby(lobbyJSON(phase: "racing", startsAt: 0, endsAt: 100_000, players: [player(1, durationMs: 30_000, place: 1), player(2)]))
        #expect(LobbyTiming.livePhase(half, now: 50_000) == .racing)
    }

    @Test func sketchyDefersToTheServerPastTheCountdown() throws {
        let drawing = #"{"packs":["classics"],"rounds":1,"stage":null,"myPrompt":null,"participantIds":[1,2,3],"drawings":[],"scores":[]}"#
        let game = try lobby(lobbyJSON(game: "drawing", phase: "countdown", startsAt: 10_000, endsAt: 900_000, players: [player(1), player(2), player(3)], drawing: drawing))
        #expect(LobbyTiming.livePhase(game, now: 5_000) == .countdown)
        #expect(LobbyTiming.livePhase(game, now: 20_000) == .racing)
        // Every artist "finished" means nothing for Sketchy — the server says when it's over.
        let racing = try lobby(lobbyJSON(game: "drawing", phase: "racing", startsAt: 10_000, endsAt: 900_000, players: [player(1, durationMs: 1)], drawing: drawing))
        #expect(LobbyTiming.livePhase(racing, now: 20_000) == .racing)
    }

    @Test func countdownAndOverdue() throws {
        #expect(LobbyTiming.countdownSeconds(startsAt: 10_000, now: 6_500) == 4)
        #expect(LobbyTiming.countdownSeconds(startsAt: 10_000, now: 9_001) == 1)
        #expect(LobbyTiming.countdownSeconds(startsAt: 10_000, now: 10_000) == nil)
        #expect(LobbyTiming.countdownSeconds(startsAt: nil, now: 0) == nil)

        let counting = try lobby(lobbyJSON(phase: "countdown", startsAt: 10_000, endsAt: 190_000))
        #expect(!LobbyTiming.isOverdue(counting, now: 9_000))
        #expect(LobbyTiming.isOverdue(counting, now: 10_001)) // the server's "racing" hasn't arrived yet

        let stage = #"{"kind":"bluff","turn":1,"drawingId":4,"startedAt":0,"endsAt":50000}"#
        let drawing = #"{"packs":["classics"],"rounds":1,"stage":\#(stage),"myPrompt":null,"participantIds":[1],"drawings":[],"scores":[]}"#
        let sketchy = try lobby(lobbyJSON(game: "drawing", phase: "racing", startsAt: 0, endsAt: 900_000, drawing: drawing))
        #expect(!LobbyTiming.isOverdue(sketchy, now: 49_999))
        #expect(LobbyTiming.isOverdue(sketchy, now: 50_000))
    }
}

// MARK: mirrors of the server and the web

@Suite struct GameMirrorTests {
    @Test func reactionSetIsExactlyTheServers() throws {
        let server = stringArray(named: "GAME_REACTIONS", in: try repoSource("src/games/reactions.ts"))
        let web = stringArray(named: "GAME_REACTIONS", in: try repoSource("web/src/lib/games/reactions.ts"))
        #expect(server.count == 8)
        #expect(GameStore.reactions == server)
        #expect(GameStore.reactions == web)
    }

    @Test func drawingPaletteIsExactlyTheWebsInOrder() throws {
        let web = try repoSource("web/src/lib/games/drawing.ts")
        let entries = web.matches(of: /\{ name: "(\w+)", value: "(#[0-9a-fA-F]{6})" \}/).map { (String($0.output.1), String($0.output.2)) }
        let size = number(named: "DRAWING_PALETTE_SIZE", in: try repoSource("src/Api.ts"))
        #expect(size == 10)
        #expect(Sketch.palette.count == Int(size ?? -1))
        #expect(entries.count == Sketch.palette.count)
        for (index, entry) in Sketch.palette.enumerated() where index < entries.count {
            #expect(entry.name == entries[index].0)
            #expect(entry.hex.lowercased() == entries[index].1.lowercased())
        }
    }

    @Test func canvasLimitsMatchTheServer() throws {
        let api = try repoSource("src/Api.ts")
        #expect(number(named: "DRAWING_WIDTH", in: api) == Double(Sketch.width))
        #expect(number(named: "DRAWING_HEIGHT", in: api) == Double(Sketch.height))
        #expect(number(named: "MAX_DRAWING_STROKES", in: api) == Double(Sketch.maxStrokes))
        #expect(number(named: "MAX_DRAWING_POINTS", in: api) == Double(Sketch.maxPoints))
        #expect(number(named: "MAX_BLUFF_LENGTH", in: api) == Double(Sketch.maxBluffLength))
        #expect(number(named: "MAX_GAME_CHAT_LENGTH", in: api) == Double(LobbyChatPanel.maxLength))
    }

    @Test func reflexScoringConstantsTrackTheServer() throws {
        let server = try repoSource("src/games/reflex.ts")
        #expect(number(named: "ANTICIPATION_MS", in: server) == Reflex.anticipationMs)
        #expect(number(named: "FALSE_START_PENALTY", in: server) == Double(Reflex.falseStartPenalty))
        #expect(number(named: "MAX_ROUND_POINTS", in: server) == Double(Reflex.maxRoundPoints))
        #expect(number(named: "MIN_ROUND_POINTS", in: server) == Double(Reflex.minRoundPoints))
        #expect(number(named: "POINTS_PER_MS", in: server) == Reflex.pointsPerMs)
        #expect(number(named: "COMBO_STEP", in: server) == Reflex.comboStep)
        #expect(number(named: "MAX_COMBO_STEPS", in: server) == Double(Reflex.maxComboSteps))
        #expect(number(named: "REFLEX_TARGET_RADIUS", in: server) == Reflex.targetRadius)
        #expect(number(named: "REFLEX_ARENA_ASPECT", in: server) == Reflex.arenaAspect)
        #expect(number(named: "REFLEX_DECOY_FLASH_MS", in: server) == Reflex.decoyFlashMs)
        #expect(number(named: "REFLEX_SYMBOLS", in: server) == Double(Reflex.symbols.count))
        #expect(number(named: "REFLEX_DECOY_VARIANTS", in: server) == Double(Reflex.decoys.count))
        guard let parStart = server.range(of: "const PAR_MS") else { Issue.record("PAR_MS not found"); return }
        let block = server[parStart.upperBound...].prefix { $0 != "}" }
        for match in block.matches(of: /(\w+): (\d+)/) {
            let kind = try #require(ReflexKind(rawValue: String(match.output.1)))
            #expect(Reflex.parMs[kind] == Double(match.output.2))
        }
        #expect(stringArray(named: "REFLEX_SYMBOLS", in: try repoSource("web/src/lib/games/reflex.ts")) == Reflex.symbols)
    }
}

// MARK: Reflex Rush

@Suite struct ReflexLogicTests {
    private func round(_ kind: String, arm: Int, signal: Int, close: Int, cues: String = "[]", symbol: String = "null", direction: String = "null", target: String = "null") throws -> ReflexRound {
        try JSONDecoder().decode(ReflexRound.self, from: Data("""
        {"kind":"\(kind)","armAt":\(arm),"signalAt":\(signal),"closeAt":\(close),"cues":\(cues),"symbol":\(symbol),"direction":\(direction),"target":\(target)}
        """.utf8))
    }

    @Test func liveResultsPackIntoOneGrowingNumber() {
        // The web's encodeLiveResult: (round + 1) * 1000 + code.
        #expect(Reflex.encodeLiveResult(index: 0, .init(outcome: .hit, reactionMs: 245)) == 1123)
        #expect(Reflex.encodeLiveResult(index: 2, .init(outcome: .early, reactionMs: nil)) == 3990)
        #expect(Reflex.encodeLiveResult(index: 3, .init(outcome: .miss, reactionMs: nil)) == 4991)
        #expect(Reflex.encodeLiveResult(index: 7, .init(outcome: .wrong, reactionMs: nil)) == 8992)
        // A very slow hit is capped below the miss codes.
        #expect(Reflex.encodeLiveResult(index: 0, .init(outcome: .hit, reactionMs: 5000)) == 1989)
        #expect(Reflex.decodeLiveResult(1123)?.result == .init(outcome: .hit, reactionMs: 246))
        #expect(Reflex.decodeLiveResult(3990)?.index == 2)
        #expect(Reflex.decodeLiveResult(4991)?.result.outcome == .miss)
        #expect(Reflex.decodeLiveResult(8992)?.result.outcome == .wrong)
        #expect(Reflex.decodeLiveResult(42) == nil)
        // Eight rounds stay inside the server's MAX_GAME_PROGRESS.
        #expect(Reflex.encodeLiveResult(index: 7, .init(outcome: .wrong, reactionMs: nil)) <= 10_000)
    }

    @Test func scoresLikeTheServer() throws {
        let rounds = [
            try round("go", arm: 0, signal: 2000, close: 3200),
            try round("go", arm: 5000, signal: 7000, close: 8200),
            try round("arrow", arm: 10000, signal: 12000, close: 13500),
            try round("go", arm: 15000, signal: 17000, close: 18200),
        ]
        #expect(Reflex.basePoints(.go, reactionMs: 150) == 1000)
        #expect(Reflex.basePoints(.go, reactionMs: 250) == 800)
        #expect(Reflex.basePoints(.target, reactionMs: 2000) == 100)
        let results: [Reflex.LiveResult?] = [
            .init(outcome: .hit, reactionMs: 250), // 800
            .init(outcome: .hit, reactionMs: 250), // 800 × 1.1 = 880
            .init(outcome: .early, reactionMs: nil), // −200, streak resets
            .init(outcome: .hit, reactionMs: 150), // 1000
        ]
        let scored = Reflex.score(rounds, results)
        #expect(scored.points == [800, 880, -200, 1000])
        #expect(scored.total == 2480)
        #expect(Reflex.score(rounds, [.init(outcome: .early, reactionMs: nil)]).total == 0) // never negative
        #expect(Reflex.streak(before: 2, in: results) == 2)
        #expect(Reflex.streak(before: 3, in: results) == 0)
    }

    @Test func followsTheScheduleOnTheClock() throws {
        let rounds = [
            try round("decoy", arm: 1000, signal: 5000, close: 6200, cues: #"[{"at":3000,"variant":1}]"#),
            try round("match", arm: 8000, signal: 11000, close: 12300, cues: #"[{"at":9500,"variant":2},{"at":10200,"variant":4}]"#, symbol: "0"),
        ]
        let intro = 1200.0
        #expect(Reflex.view(rounds, introMs: intro, now: 500) == .init(index: 0, stage: .before, cue: nil))
        #expect(Reflex.view(rounds, introMs: intro, now: 1500).stage == .intro)
        #expect(Reflex.view(rounds, introMs: intro, now: 2500) == .init(index: 0, stage: .wait, cue: nil))
        #expect(Reflex.view(rounds, introMs: intro, now: 3100) == .init(index: 0, stage: .wait, cue: 0)) // the decoy flash
        #expect(Reflex.view(rounds, introMs: intro, now: 3500) == .init(index: 0, stage: .wait, cue: nil)) // …is over
        #expect(Reflex.view(rounds, introMs: intro, now: 5000).stage == .signal)
        #expect(Reflex.view(rounds, introMs: intro, now: 6200).stage == .result)
        #expect(Reflex.view(rounds, introMs: intro, now: 10_000) == .init(index: 1, stage: .wait, cue: 0)) // a wrong symbol stays up
        #expect(Reflex.view(rounds, introMs: intro, now: 10_500).cue == 1)
        #expect(Reflex.view(rounds, introMs: intro, now: 12_300 + 1000).stage == .result)
        #expect(Reflex.view(rounds, introMs: intro, now: 12_300 + Reflex.finalResultMs).stage == .done)
    }

    @Test func judgesPressesTheWayTheServerWill() throws {
        let arrow = try round("arrow", arm: 0, signal: 1000, close: 2500, direction: #""left""#)
        #expect(Reflex.judge(arrow, reactionMs: 80, direction: .left, x: nil, y: nil).result.outcome == .early)
        #expect(Reflex.judge(arrow, reactionMs: 80, direction: .left, x: nil, y: nil).tap.early)
        #expect(Reflex.judge(arrow, reactionMs: 300.4, direction: .right, x: nil, y: nil).result.outcome == .wrong)
        let hit = Reflex.judge(arrow, reactionMs: 300.6, direction: .left, x: nil, y: nil)
        #expect(hit.result == .init(outcome: .hit, reactionMs: 301))
        #expect(hit.tap.reactionMs == 301)
        #expect(Reflex.direction(atX: 0.05, y: 0.5) == .left)
        #expect(Reflex.direction(atX: 0.95, y: 0.5) == .right)
        #expect(Reflex.direction(atX: 0.5, y: 0.02) == .up)
        #expect(Reflex.direction(atX: 0.5, y: 0.98) == .down)

        let target = try round("target", arm: 0, signal: 1000, close: 2800, target: #"{"x":0.5,"y":0.5}"#)
        #expect(Reflex.isOnTarget(target, x: 0.55, y: 0.5))
        #expect(!Reflex.isOnTarget(target, x: 0.6, y: 0.5))
        // Height counts for less (the arena is wider than tall).
        #expect(Reflex.isOnTarget(target, x: 0.5, y: 0.6))
    }
}

// MARK: typing, throttling, lists

@Suite struct TypingEngineTests {
    @Test func countsEveryWrongKeystrokeAndTracksThePosition() {
        var engine = TypingEngine(passage: "the cat")
        engine.input("th")
        #expect(engine.correct == 2 && engine.errors == 0)
        engine.input("thx")
        #expect(engine.correct == 2 && engine.errors == 1)
        engine.input("th") // fixed — but the mistake still counts
        engine.input("the ")
        #expect(engine.errors == 1)
        #expect(engine.atWordBoundary)
        engine.input("the cat")
        #expect(engine.done)
        #expect(engine.accuracy == 7.0 / 8.0 * 100)
        // Once done, nothing more registers.
        let after = engine.input("the cats")
        #expect(after == "the cat")
    }

    @Test func capsARunawayMistakeAndDropsLineBreaks() {
        var engine = TypingEngine(passage: "abcdefghijklmnop")
        let shown = engine.input("abXXXXXXXXXXXX")
        #expect(shown == "abXXXXXX") // two right + MAX_ERROR_RUN
        #expect(engine.errors == 6)
        var other = TypingEngine(passage: "ab")
        let joined = other.input("a\nb")
        #expect(joined == "ab")
        #expect(other.done)
    }

    @Test func wordsPerMinute() {
        #expect(TypingEngine.wordsPerMinute(chars: 50, elapsedMs: 500) == 0) // too early to mean anything
        #expect(TypingEngine.wordsPerMinute(chars: 50, elapsedMs: 6000) == 100)
    }
}

@Suite struct ThrottleTests {
    @Test func progressGoesOutAtMostEveryIntervalUnlessForced() {
        var throttle = ProgressThrottle()
        var sent: [Bool] = []
        sent.append(throttle.shouldSend(1, at: 0, force: false))
        sent.append(throttle.shouldSend(2, at: 100, force: false))
        sent.append(throttle.shouldSend(3, at: 120, force: true)) // a word boundary
        sent.append(throttle.shouldSend(3, at: 1000, force: true)) // never the same value twice
        sent.append(throttle.shouldSend(4, at: 280, force: false))
        sent.append(throttle.flush(5, at: 300))
        sent.append(throttle.flush(5, at: 600))
        #expect(sent == [true, false, true, false, true, true, false])
    }

    @Test func rateBudgetSlidesOverOneSecond() {
        var budget = RateBudget(max: 4)
        var allowed: [Bool] = []
        for index in 0..<6 { allowed.append(budget.allow(at: Double(index) * 100)) }
        #expect(allowed == [true, true, true, true, false, false])
        let later = [budget.allow(at: 1000), budget.allow(at: 1050)]
        #expect(later == [true, false]) // the first one aged out, then the budget's spent again
    }
}

@Suite struct LobbyListTests {
    @Test func mergesFetchesAndLocalChanges() throws {
        var list = LobbyListState()
        list.replace(with: [try lobby(lobbyJSON(id: 2, phase: "racing", startsAt: 0, endsAt: 1)), try lobby(lobbyJSON(id: 1)), try lobby(lobbyJSON(id: 9, phase: "finished"))])
        #expect(list.lobbies.map(\.id) == [2, 1]) // finished games aren't browsable
        #expect(list.hasLoaded)

        // One just created lands on top; an update stays in place.
        var created = try lobby(lobbyJSON(id: 5))
        created.passage = "secret"
        list.upsert(created)
        #expect(list.lobbies.map(\.id) == [5, 2, 1])
        #expect(list.lobbies[0].passage == nil)
        list.upsert(try lobby(lobbyJSON(id: 1, players: [player(1), player(2)])))
        #expect(list.lobbies.map(\.id) == [5, 2, 1])
        #expect(list.lobbies[2].players.count == 2)

        // A lobby that finished drops out; a fresh listing wins.
        list.upsert(try lobby(lobbyJSON(id: 2, phase: "finished")))
        #expect(list.lobbies.map(\.id) == [5, 1])
        list.replace(with: [try lobby(lobbyJSON(id: 1))])
        #expect(list.lobbies.map(\.id) == [1])
    }

    @Test func formats() {
        #expect(GameFormat.ordinal(1) == "1st")
        #expect(GameFormat.ordinal(2) == "2nd")
        #expect(GameFormat.ordinal(3) == "3rd")
        #expect(GameFormat.ordinal(11) == "11th")
        #expect(GameFormat.ordinal(22) == "22nd")
        #expect(GameFormat.duration(12_345) == "12.3s")
        #expect(GameFormat.duration(75_000) == "1:15")
    }
}

// MARK: drawing

@Suite struct SketchTests {
    @Test func pointsAreThinnedAndClamped() {
        var points: [Int] = []
        let kept = [Sketch.append((10, 10), to: &points), Sketch.append((11, 11), to: &points), Sketch.append((14, 10), to: &points)]
        #expect(kept == [true, false, true]) // the second is closer than MIN_POINT_GAP
        #expect(points == [10, 10, 14, 10])
        let size = CGSize(width: 400, height: 300)
        #expect(Sketch.canvasPoint(CGPoint(x: 200, y: 150), in: size) == (400, 300))
        #expect(Sketch.canvasPoint(CGPoint(x: -5, y: 900), in: size) == (0, 600))
    }
}

// MARK: the store

@MainActor
@Suite struct GameStoreTests {
    private func makeStore(_ backend: FakeBackend) -> GameStore {
        let urlSession = StubURLProtocol.session()
        let sessions = SessionManager(storage: InMemoryStorage(), refresher: URLSessionRefresher(baseURL: backend.baseURL, session: urlSession))
        let api = APIClient(baseURL: backend.baseURL, sessions: sessions, urlSession: urlSession)
        return GameStore(api: api, users: UserStore(api: api), realtime: RealtimeClient(transport: FakeTransport()))
    }

    @Test func fetchingALobbyCachesItAndSyncsTheClock() async throws {
        let serverNow = Int(localNowMs()) + 60_000 // the server runs a minute ahead
        let backend = FakeBackend { request in
            request.path == "/games/lobbies/7" ? .json(lobbyJSON(id: 7, serverNow: serverNow)) : .json("{}", status: 404)
        }
        let store = makeStore(backend)
        let fetched = try await store.fetchLobby(7)
        #expect(fetched.id == 7)
        #expect(store.lobby(7)?.id == 7)
        #expect(store.list(.typing).lobbies.map(\.id) == [7])
        #expect(abs(store.serverNow() - localNowMs() - 60_000) < 2_000)
    }

    @Test func aMissingLobbyIsRememberedAsClosed() async throws {
        let backend = FakeBackend { _ in .json(#"{"_tag":"NotFound","message":"Lobby not found"}"#, status: 404) }
        let store = makeStore(backend)
        await #expect(throws: APIError.self) { try await store.fetchLobby(3) }
        #expect(store.closedLobbies.contains(3))
    }

    @Test func liveProgressOnlyMovesForwardAndOwnEchoesAreSkipped() {
        let store = makeStore(FakeBackend { _ in .json("{}") })
        store.handle(.gameProgress(lobbyId: 1, userId: 2, progress: 10), me: 1)
        store.handle(.gameProgress(lobbyId: 1, userId: 2, progress: 8), me: 1) // overtaken frame
        store.handle(.gameProgress(lobbyId: 1, userId: 2, progress: 14), me: 1)
        #expect(store.progressHistory(1, userId: 2) == [10, 14])
        store.handle(.gameProgress(lobbyId: 1, userId: 1, progress: 99), me: 1) // our own echo
        #expect(store.progress(1, userId: 1) == 0)

        store.handle(.gameReaction(lobbyId: 1, userId: 2, reaction: "🔥"), me: 1)
        store.handle(.gameReaction(lobbyId: 1, userId: 1, reaction: "🔥"), me: 1) // echo: drawn when flung
        store.handle(.gameReaction(lobbyId: 1, userId: 2, reaction: "🍕"), me: 1) // not in the set
        #expect(store.flying.map(\.reaction) == ["🔥"])
        store.resetProgress(1)
        #expect(store.progress(1, userId: 2) == 0)
    }

    @Test func flingingIsThrottledToTheServersBudget() {
        let store = makeStore(FakeBackend { _ in .json("{}") })
        let sent = (0..<6).map { _ in store.fling("👏", in: 1, me: 1) }
        #expect(sent == [true, true, true, true, false, false])
        #expect(!store.fling("🍕", in: 1, me: 1))
    }
}
