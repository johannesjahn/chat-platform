import Foundation
import XCTest

/// Game helpers for arranging lobbies through the API — the "other players"
/// in a UI test are plain API calls (and, for relayed frames, a socket).
extension TestAPI {
    typealias JSON = [String: Any]

    func lobby(_ id: Int, as user: TestUser) async throws -> JSON {
        try await request("GET", "/games/lobbies/\(id)", token: user.accessToken) as! JSON
    }

    func lobbies(_ game: String, as user: TestUser) async throws -> [JSON] {
        let list = try await request("GET", "/games/\(game)/lobbies", token: user.accessToken) as! JSON
        return list["lobbies"] as! [JSON]
    }

    @discardableResult
    func createLobby(_ game: String, as user: TestUser) async throws -> Int {
        let lobby = try await request("POST", "/games/\(game)/lobbies", token: user.accessToken) as! JSON
        return lobby["id"] as! Int
    }

    func joinLobby(_ id: Int, as user: TestUser) async throws {
        try await request("POST", "/games/lobbies/\(id)/join", token: user.accessToken)
    }

    func postLobbyChat(_ id: Int, _ text: String, as user: TestUser) async throws {
        try await request("POST", "/games/lobbies/\(id)/chat", body: ["text": text], token: user.accessToken)
    }

    func finishRace(_ id: Int, typed: String, as user: TestUser) async throws {
        try await request("POST", "/games/lobbies/\(id)/finish", body: ["typed": typed, "errors": 0], token: user.accessToken)
    }

    /// A tiny squiggle — a valid drawing (strokes of palette-index colors).
    func submitDrawing(_ id: Int, as user: TestUser) async throws {
        let stroke: JSON = ["color": 0, "brush": "thick", "points": [100, 100, 300, 200, 500, 150, 700, 400]]
        try await request("POST", "/games/lobbies/\(id)/drawing", body: ["strokes": [stroke]], token: user.accessToken)
    }

    func submitBluff(_ id: Int, _ text: String, as user: TestUser) async throws {
        try await request("POST", "/games/lobbies/\(id)/bluff", body: ["text": text], token: user.accessToken)
    }

    func submitVote(_ id: Int, answer: Int, as user: TestUser) async throws {
        try await request("POST", "/games/lobbies/\(id)/vote", body: ["answer": answer], token: user.accessToken)
    }

    /// Opens a realtime socket as `user`, joins a lobby's room and relays one
    /// emoji reaction into it — what another player's tap does.
    func sendReaction(_ reaction: String, in lobbyId: Int, as user: TestUser) async throws {
        let ticket = (try await request("POST", "/realtime/ws-ticket", token: user.accessToken) as! JSON)["ticket"] as! String
        var components = URLComponents(url: baseURL.appending(path: "ws"), resolvingAgainstBaseURL: false)!
        components.scheme = "ws"
        components.queryItems = [URLQueryItem(name: "ticket", value: ticket)]
        let socket = URLSession.shared.webSocketTask(with: components.url!)
        socket.resume()
        defer { socket.cancel(with: .goingAway, reason: nil) }
        try await socket.send(.string(#"{"type":"subscribe_room","room":"game-lobby:\#(lobbyId)"}"#))
        // The server only relays into a room the socket has joined.
        try await Task.sleep(for: .milliseconds(600))
        try await socket.send(.string(#"{"type":"game_reaction","lobbyId":\#(lobbyId),"reaction":"\#(reaction)"}"#))
        try await Task.sleep(for: .milliseconds(300))
    }
}

extension AppTestCase {
    /// Games tab → a game's lobby browser.
    func openGameHub(_ slug: String) {
        selectTab("Games")
        element("games.card.\(slug)").tap()
        element("hub.lobbies")
    }

    /// Waits until `id`'s accessibility value is `value`.
    @discardableResult
    func waitForValue(_ id: String, _ value: String, timeout: TimeInterval = 15) -> Bool {
        let target = app.descendants(matching: .any).matching(identifier: id).firstMatch
        let predicate = NSPredicate(format: "value == %@", value)
        let ok = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: target)], timeout: timeout) == .completed
        if !ok { screenshot("value-\(id)-\(value)") }
        return ok
    }
}
