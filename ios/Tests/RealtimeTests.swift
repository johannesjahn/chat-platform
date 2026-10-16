import Foundation
import Synchronization
import Testing

@testable import ChatPlatform

@Suite struct RealtimeEventTests {
    @Test func decodesTheIdOnlyEvents() {
        #expect(RealtimeEvent.decode(#"{"type":"post_changed","postId":4}"#) == .postChanged(postId: 4))
        #expect(RealtimeEvent.decode(#"{"type":"comment_changed","postId":4,"commentId":9}"#) == .commentChanged(postId: 4, commentId: 9))
        #expect(RealtimeEvent.decode(#"{"type":"chat_updated","chatId":2,"version":7}"#) == .chatUpdated(chatId: 2, version: 7))
        #expect(RealtimeEvent.decode(#"{"type":"chat_deleted","chatId":2}"#) == .chatDeleted(chatId: 2))
        #expect(RealtimeEvent.decode(#"{"type":"notifications_changed"}"#) == .notificationsChanged)
        #expect(RealtimeEvent.decode(#"{"type":"game_lobby_updated","lobbyId":3}"#) == .gameLobbyUpdated(lobbyId: 3))
        #expect(RealtimeEvent.decode(#"{"type":"game_lobbies_changed","game":"typing"}"#) == .gameLobbiesChanged(game: "typing"))
        #expect(RealtimeEvent.decode(#"{"type":"game_chat","lobbyId":3}"#) == .gameChat(lobbyId: 3))
    }

    @Test func decodesTheEventsThatCarryData() {
        #expect(RealtimeEvent.decode(#"{"type":"reaction_changed","targetType":"post","targetId":5,"reactions":[{"emoji":"👍","count":2}]}"#)
            == .reactionChanged(target: .post, targetId: 5, chatId: nil, reactions: [.init(emoji: "👍", count: 2)]))
        #expect(RealtimeEvent.decode(#"{"type":"reaction_changed","targetType":"message","targetId":5,"chatId":8,"reactions":[]}"#)
            == .reactionChanged(target: .message, targetId: 5, chatId: 8, reactions: []))
        #expect(RealtimeEvent.decode(#"{"type":"typing","chatId":1,"userId":2,"username":"ada","displayName":null}"#)
            == .typing(chatId: 1, userId: 2, username: "ada", displayName: nil))
        #expect(RealtimeEvent.decode(#"{"type":"status_changed","userId":2,"statusText":"Busy","statusEmoji":null,"statusExpiresAt":null}"#)
            == .statusChanged(userId: 2, statusText: "Busy", statusEmoji: nil, statusExpiresAt: nil))
        #expect(RealtimeEvent.decode(#"{"type":"presence","userId":2,"online":true}"#) == .presence(userId: 2, online: true))
        #expect(RealtimeEvent.decode(#"{"type":"message_pin_changed","chatId":1,"messageId":3,"pinned":true}"#)
            == .messagePinChanged(chatId: 1, messageId: 3, pinned: true))
        #expect(RealtimeEvent.decode(#"{"type":"game_progress","lobbyId":1,"userId":2,"progress":55}"#)
            == .gameProgress(lobbyId: 1, userId: 2, progress: 55))
        #expect(RealtimeEvent.decode(#"{"type":"game_reaction","lobbyId":1,"userId":2,"reaction":"🔥"}"#)
            == .gameReaction(lobbyId: 1, userId: 2, reaction: "🔥"))
    }

    @Test func unknownAndMalformedFramesAreHarmless() {
        #expect(RealtimeEvent.decode(#"{"type":"something_new","x":1}"#) == .unknown(type: "something_new"))
        #expect(RealtimeEvent.decode("not json") == nil)
        #expect(RealtimeEvent.decode(#"{"type":"post_changed"}"#) == nil) // missing its id
        #expect(RealtimeEvent.decode("ping") == nil)
    }

    @Test func backoffDoublesUpToTheCap() {
        let backoff = Backoff()
        #expect(backoff.delay(afterFailures: 0) == .seconds(1))
        #expect(backoff.delay(afterFailures: 1) == .seconds(2))
        #expect(backoff.delay(afterFailures: 3) == .seconds(8))
        #expect(backoff.delay(afterFailures: 4) == .seconds(15))
        #expect(backoff.delay(afterFailures: 50) == .seconds(15))
    }
}

/// A scripted socket: frames the test pushes, observable sends, closable.
final class FakeConnection: RealtimeConnection {
    private let stream: AsyncThrowingStream<String, any Error>
    private let continuation: AsyncThrowingStream<String, any Error>.Continuation
    private let sentFrames = Mutex<[String]>([])

    init() {
        (stream, continuation) = AsyncThrowingStream.makeStream()
    }

    var sent: [String] { sentFrames.withLock { $0 } }
    func push(_ frame: String) { continuation.yield(frame) }
    func drop() { continuation.finish(throwing: URLError(.networkConnectionLost)) }

    func send(_ text: String) async throws { sentFrames.withLock { $0.append(text) } }
    func receive() async throws -> String {
        var iterator = stream.makeAsyncIterator()
        guard let next = try await iterator.next() else { throw URLError(.networkConnectionLost) }
        return next
    }
    func close() { continuation.finish(throwing: URLError(.cancelled)) }
}

final class FakeTransport: RealtimeTransport {
    /// What each successive `open()` does: a connection, or a failure.
    private let script = Mutex<[Result<FakeConnection, URLError>]>([])
    private let opened = Mutex<Int>(0)

    func enqueue(_ result: Result<FakeConnection, URLError>) { script.withLock { $0.append(result) } }
    var openCount: Int { opened.withLock { $0 } }

    func open() async throws -> any RealtimeConnection {
        opened.withLock { $0 += 1 }
        let next: Result<FakeConnection, URLError>? = script.withLock { $0.isEmpty ? nil : $0.removeFirst() }
        switch next {
        case .success(let connection)?: return connection
        case .failure(let error)?: throw error
        case nil: try await Task.sleep(for: .seconds(3600)); throw URLError(.timedOut)
        }
    }
}

@MainActor
@Suite struct RealtimeClientTests {
    private func waitUntil(_ condition: @MainActor () -> Bool, timeout: Duration = .seconds(5)) async -> Bool {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return condition()
    }

    @Test func deliversEventsAndRefetchesOnEveryConnect() async {
        let transport = FakeTransport()
        let first = FakeConnection(), second = FakeConnection()
        transport.enqueue(.success(first))
        transport.enqueue(.success(second))
        var connects = 0
        var events: [RealtimeEvent] = []
        let client = RealtimeClient(transport: transport, backoff: Backoff(base: .milliseconds(1), cap: .milliseconds(2)))
        client.onConnect = { connects += 1 }
        client.onEvent = { events.append($0) }
        client.start()

        #expect(await waitUntil { connects == 1 })
        first.push(#"{"type":"post_changed","postId":1}"#)
        #expect(await waitUntil { events == [.postChanged(postId: 1)] })

        // The connection drops: the client reconnects and refetches again.
        first.drop()
        #expect(await waitUntil { connects == 2 })
        second.push(#"{"type":"notifications_changed"}"#)
        #expect(await waitUntil { events.last == .notificationsChanged })
        client.stop()
        #expect(client.state == .stopped)
    }

    @Test func retriesWithBackoffAfterFailedConnects() async {
        let transport = FakeTransport()
        transport.enqueue(.failure(URLError(.cannotConnectToHost)))
        transport.enqueue(.failure(URLError(.cannotConnectToHost)))
        let good = FakeConnection()
        transport.enqueue(.success(good))
        let delays = Mutex<[Duration]>([])
        var connects = 0
        let client = RealtimeClient(transport: transport, backoff: Backoff(base: .seconds(1), cap: .seconds(15))) { delay in
            delays.withLock { $0.append(delay) }
        }
        client.onConnect = { connects += 1 }
        client.start()
        #expect(await waitUntil { connects == 1 })
        #expect(delays.withLock { $0 } == [.seconds(1), .seconds(2)])
        #expect(transport.openCount == 3)
        client.stop()
    }

    @Test func replaysJoinedRoomsOnReconnectAndRefCountsThem() async {
        let transport = FakeTransport()
        let first = FakeConnection(), second = FakeConnection()
        transport.enqueue(.success(first))
        transport.enqueue(.success(second))
        var connects = 0
        let client = RealtimeClient(transport: transport, backoff: Backoff(base: .milliseconds(1), cap: .milliseconds(2)))
        client.onConnect = { connects += 1 }
        client.start()
        #expect(await waitUntil { connects == 1 })

        let a = client.joinPostRoom(7)
        let b = client.joinPostRoom(7) // a second view on the same post
        #expect(await waitUntil { first.sent.count == 1 })
        #expect(first.sent == [#"{"postId":7,"type":"subscribe_post_comments"}"#])
        a.cancel()
        #expect(first.sent.count == 1) // still wanted by `b`
        let lobby = client.joinRoom("game-lobby:3")
        #expect(await waitUntil { first.sent.count == 2 })

        first.drop()
        #expect(await waitUntil { connects == 2 })
        #expect(await waitUntil { second.sent.count == 2 })
        #expect(Set(second.sent) == [#"{"postId":7,"type":"subscribe_post_comments"}"#, #"{"room":"game-lobby:3","type":"subscribe_room"}"#])

        b.cancel()
        lobby.cancel()
        #expect(await waitUntil { second.sent.count == 4 })
        #expect(second.sent.suffix(2).allSatisfy { $0.contains("unsubscribe") })
        client.stop()
    }

    @Test func stoppingClosesTheSocketAndStopsReconnecting() async {
        let transport = FakeTransport()
        let connection = FakeConnection()
        transport.enqueue(.success(connection))
        var connects = 0
        let client = RealtimeClient(transport: transport, backoff: Backoff(base: .milliseconds(1), cap: .milliseconds(2)))
        client.onConnect = { connects += 1 }
        client.start()
        #expect(await waitUntil { connects == 1 })
        client.stop()
        try? await Task.sleep(for: .milliseconds(100))
        #expect(transport.openCount == 1)
        #expect(client.state == .stopped)
    }
}
