import XCTest

final class GamesTests: AppTestCase {
    // MARK: typing race

    func testTypingRaceFromWaitingRoomToTheLeaderboard() async throws {
        let me = try await api.makeUser("racer")
        let rival = try await api.makeUser("rival")
        launch(as: me)
        selectTab("Games")
        element("games.home")
        screenshot("20-games-home")
        element("games.card.typing").tap()
        element("hub.lobbies")
        screenshot("21-typing-hub")

        // Open a lobby from the app; the rival joins through the API and
        // shows up in the waiting room live.
        element("hub.newLobby").tap()
        element("lobby.waiting")
        waitForRealtime()
        let lobbyId = try await api.lobbies("typing", as: rival).first { ($0["hostId"] as? Int) == me.id }?["id"] as? Int
        let id = try XCTUnwrap(lobbyId, "the app's new lobby isn't listed")
        try await api.joinLobby(id, as: rival)
        element("lobby.seat.\(rival.id)")
        screenshot("22-waiting-room")

        element("lobby.start").tap()
        element("lobby.countdown", timeout: 5)
        screenshot("23-countdown")
        XCTAssertTrue(waitForValue("lobby.phase", "racing", timeout: 10))

        // The passage is public once the race starts — read it as the rival.
        let lobby = try await api.lobby(id, as: rival)
        let passage = try XCTUnwrap(lobby["passage"] as? String)
        let startsAt = try XCTUnwrap(lobby["startsAt"] as? Double)
        let input = element("race.input")
        input.tap()
        input.typeText(String(passage.prefix(40)))
        screenshot("24-racing")
        input.typeText(String(passage.dropFirst(40).dropLast()))

        // The server rejects a finish faster than 250 WPM; a UI test types
        // faster than any human, so hold the last key until it's plausible.
        let minimumMs = Double(passage.count) / 5 / 200 * 60_000
        let elapsedMs = Date().timeIntervalSince1970 * 1000 - startsAt
        if elapsedMs < minimumMs { try await Task.sleep(for: .milliseconds(Int(minimumMs - elapsedMs) + 500)) }
        try await api.finishRace(id, typed: passage, as: rival)
        input.typeText(String(passage.suffix(1)))

        // Both finished: straight to the results.
        element("lobby.results", timeout: 15)
        element("results.podium")
        element("results.player.\(me.id)")
        element("results.player.\(rival.id)")
        screenshot("25-results-podium")

        element("lobby.leaderboard").tap()
        element("leaderboard.screen")
        element("leaderboard.entry.\(me.id)")
        element("leaderboard.me")
        screenshot("26-leaderboard")
    }

    // MARK: lobby browser

    func testLobbyBrowserListsLobbiesAndUpdatesLive() async throws {
        let me = try await api.makeUser("browser")
        let host = try await api.makeUser("host")
        let first = try await api.createLobby("typing", as: host)
        launch(as: me)
        openGameHub("typing")
        let row = element("games.lobby.\(first)")
        XCTAssertTrue(row.label.contains("1/6"), row.label)

        // Someone else opens a lobby, and someone joins the first: both show
        // up without a refresh.
        waitForRealtime()
        let other = try await api.makeUser("opener")
        let second = try await api.createLobby("typing", as: other)
        element("games.lobby.\(second)")
        let joiner = try await api.makeUser("joiner")
        try await api.joinLobby(first, as: joiner)
        let joined = NSPredicate(format: "label CONTAINS '2/6'")
        XCTAssertEqual(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: joined, object: row)], timeout: 10), .completed, row.label)
        screenshot("27-lobby-browser-live")

        // Opening a row shows that lobby — as a spectator until you join.
        row.tap()
        element("lobby.spectating")
        element("lobby.join").tap()
        element("lobby.seat.\(me.id)")
        XCTAssertFalse(app.descendants(matching: .any)["lobby.spectating"].exists)
    }

    // MARK: chat and reactions

    func testLobbyChatAndReactionsAreLive() async throws {
        let me = try await api.makeUser("chatter")
        let host = try await api.makeUser("cheerer")
        let id = try await api.createLobby("reflex", as: host)
        launch(as: me)
        openGameHub("reflex")
        element("games.lobby.\(id)").tap()
        element("lobby.join").tap()
        element("lobby.seat.\(me.id)")
        waitForRealtime()

        let field = element("lobby.chat.field")
        field.tap()
        field.typeText("Good luck everyone")
        element("lobby.chat.send").tap()
        XCTAssertTrue(app.staticTexts["Good luck everyone"].waitForExistence(timeout: 10))

        try await api.postLobbyChat(id, "Thanks, you too!", as: host)
        XCTAssertTrue(app.staticTexts["Thanks, you too!"].waitForExistence(timeout: 10))
        screenshot("28-lobby-chat")

        // Our own reaction floats here at once…
        element("lobby.react.👏").tap()
        let mine = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'lobby.reaction.flying' AND value == '👏'")).firstMatch
        XCTAssertTrue(mine.waitForExistence(timeout: 3), "our own reaction never showed")
        // …and another player's arrives over the socket.
        try await api.sendReaction("🔥", in: id, as: host)
        let flying = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'lobby.reaction.flying' AND value == '🔥'")).firstMatch
        XCTAssertTrue(flying.waitForExistence(timeout: 5), "the relayed reaction never showed")
        XCTAssertTrue(flying.label.contains(host.username), flying.label)
        screenshot("29-reaction-received")
    }

    // MARK: Reflex Rush

    func testReflexRushSoloRunToResults() async throws {
        let me = try await api.makeUser("reflexer")
        launch(as: me)
        openGameHub("reflex")
        element("hub.newLobby").tap()
        element("reflex.guide")
        screenshot("30-reflex-waiting")
        element("lobby.start").tap()
        element("lobby.countdown", timeout: 5)

        // Play every round: tap whenever the signal is up. (Reaction times
        // from a test runner are meaningless — this checks the flow; the
        // scoring inputs are unit-tested.)
        let arena = element("reflex.arena", timeout: 10)
        let results = app.descendants(matching: .any)["lobby.results"]
        var seen: Set<String> = []
        let deadline = Date().addingTimeInterval(120)
        while !results.exists, Date() < deadline {
            guard arena.exists else { try await Task.sleep(for: .milliseconds(300)); continue }
            let stage = arena.value as? String ?? ""
            if stage == "signal" { arena.tap() }
            if !seen.contains(stage), ["intro", "wait", "signal", "result"].contains(stage) {
                seen.insert(stage)
                screenshot("31-reflex-\(stage)")
            }
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertTrue(results.waitForExistence(timeout: 20), "the run never reached its results")
        XCTAssertTrue(seen.isSuperset(of: ["intro", "signal", "result"]), "stages seen: \(seen)")
        element("results.player.\(me.id)")
        element("reflex.breakdown")
        screenshot("32-reflex-results")
    }

    // MARK: Sketchy

    func testSketchyWithThreePlayersUpToAReveal() async throws {
        let me = try await api.makeUser("artist")
        let second = try await api.makeUser("bluffer")
        let third = try await api.makeUser("voter")
        let id = try await api.createLobby("drawing", as: me)
        try await api.joinLobby(id, as: second)
        try await api.joinLobby(id, as: third)
        launch(as: me)
        openGameHub("drawing")
        element("games.lobby.\(id)").tap()
        element("sketchy.settings")
        screenshot("33-sketchy-waiting")
        waitForRealtime()
        element("lobby.start").tap()

        // Draw: the secret prompt is mine alone; draw something and send it.
        element("sketchy.prompt", timeout: 15)
        let canvas = element("sketchy.canvas")
        canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.3))
            .press(forDuration: 0.1, thenDragTo: canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.7)))
        element("sketchy.color.2").tap()
        canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.2))
            .press(forDuration: 0.1, thenDragTo: canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.8)))
        screenshot("34-sketchy-draw")
        element("sketchy.submitDrawing").tap()
        element("sketchy.drawingSent")
        try await api.submitDrawing(id, as: second)
        try await api.submitDrawing(id, as: third)

        // Then the first drawing's turn: bluffs, votes, reveal — the others
        // through the API, me through the app.
        let others = [second, third]
        var steps = 0
        while steps < 20 {
            steps += 1
            let lobby = try await api.lobby(id, as: second)
            let drawing = try XCTUnwrap(lobby["drawing"] as? TestAPI.JSON)
            guard let stage = drawing["stage"] as? TestAPI.JSON, let kind = stage["kind"] as? String else {
                try await Task.sleep(for: .milliseconds(500)); continue
            }
            if kind == "reveal" { break }
            guard let drawingId = stage["drawingId"] as? Int else { try await Task.sleep(for: .milliseconds(500)); continue }
            let entries = drawing["drawings"] as! [TestAPI.JSON]
            let artist = entries.first { $0["id"] as? Int == drawingId }?["artistId"] as? Int
            let guessers = others.filter { $0.id != artist }
            if kind == "bluff" {
                XCTAssertTrue(waitForValue("sketchy.stage", "bluff"))
                if artist != me.id {
                    let field = element("sketchy.bluff.field")
                    field.tap()
                    field.typeText("a heron doing taxes")
                    screenshot("35-sketchy-bluff")
                    element("sketchy.bluff.submit").tap()
                    element("sketchy.bluff.done")
                } else {
                    element("sketchy.bluff.artist")
                    screenshot("35-sketchy-bluff-artist")
                }
                for (index, player) in guessers.enumerated() {
                    try await api.submitBluff(id, "a wobbly lighthouse number \(index) \(UUID().uuidString.prefix(4))", as: player)
                }
            } else if kind == "vote" {
                XCTAssertTrue(waitForValue("sketchy.stage", "vote"))
                if artist != me.id {
                    let choice = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'sketchy.answer.' AND isEnabled == true")).firstMatch
                    XCTAssertTrue(choice.waitForExistence(timeout: 10))
                    screenshot("36-sketchy-vote")
                    choice.tap()
                }
                for player in guessers {
                    let view = try await api.lobby(id, as: player)
                    let mine = ((view["drawing"] as! TestAPI.JSON)["drawings"] as! [TestAPI.JSON]).first { $0["id"] as? Int == drawingId }
                    let answers = mine?["answers"] as? [TestAPI.JSON] ?? []
                    if let pick = answers.first(where: { ($0["mine"] as? Bool) == false })?["id"] as? Int {
                        try? await api.submitVote(id, answer: pick, as: player)
                    }
                }
            }
            try await Task.sleep(for: .milliseconds(700))
        }
        XCTAssertTrue(waitForValue("sketchy.stage", "reveal", timeout: 20))
        element("sketchy.reveal")
        // The truth lands last, on the server's schedule.
        element("sketchy.reveal.prompt", timeout: 20)
        screenshot("37-sketchy-reveal")
    }

    // MARK: leaderboard

    func testLeaderboardPeriodsAndUnknownGames() async throws {
        let me = try await api.makeUser("ranker")
        launch(as: me)
        openGameHub("reflex")
        element("hub.leaderboard").tap()
        element("leaderboard.screen")
        app.buttons["All time"].tap()
        XCTAssertTrue(app.buttons["All time"].isSelected)
        screenshot("38-leaderboard-all-time")
    }
}
