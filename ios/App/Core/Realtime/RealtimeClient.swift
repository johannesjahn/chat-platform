import ChatAPI
import Foundation
import Observation
import OSLog
import Synchronization

/// One live socket frame source. The production one wraps
/// `URLSessionWebSocketTask`; tests script their own.
protocol RealtimeConnection: Sendable {
    func send(_ text: String) async throws
    func receive() async throws -> String
    func close()
}

protocol RealtimeTransport: Sendable {
    /// Mints a ticket and opens the socket. Throws when either step fails.
    func open() async throws -> any RealtimeConnection
}

/// Reconnect delay: 1s, doubling, capped at 15s — the web client's schedule.
struct Backoff: Sendable, Equatable {
    var base: Duration = .seconds(1)
    var cap: Duration = .seconds(15)

    func delay(afterFailures failures: Int) -> Duration {
        let factor = 1 << min(max(failures, 0), 10)
        return min(base * factor, cap)
    }
}

/// The app's single `/ws` connection. It reconnects with backoff, replays the
/// rooms views asked for, and tells the app to refetch everything on every
/// (re)connect, because events are best-effort and a dropped one would
/// otherwise go unnoticed.
@MainActor
@Observable
final class RealtimeClient {
    enum State: Equatable { case stopped, connecting, connected, waiting }

    private(set) var state: State = .stopped

    /// Called for every decoded event.
    var onEvent: (RealtimeEvent) -> Void = { _ in }
    /// Called each time a connection opens (including the first) — refetch
    /// everything event-driven here.
    var onConnect: () -> Void = {}

    private static let log = Logger(subsystem: "dev.chatplatform.ios", category: "realtime")
    static let pingInterval: Duration = .seconds(30)

    private let transport: any RealtimeTransport
    private let backoff: Backoff
    private let sleep: @Sendable (Duration) async throws -> Void
    private var runTask: Task<Void, Never>?
    private var connection: (any RealtimeConnection)?
    private var postRooms: [Int: Int] = [:]
    private var namedRooms: [String: Int] = [:]

    init(
        transport: any RealtimeTransport,
        backoff: Backoff = Backoff(),
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.transport = transport
        self.backoff = backoff
        self.sleep = sleep
    }

    func start() {
        guard runTask == nil else { return }
        runTask = Task { [weak self] in await self?.run() }
    }

    /// Closes the socket and stops reconnecting (signing out, backgrounding).
    func stop() {
        runTask?.cancel()
        runTask = nil
        connection?.close()
        connection = nil
        state = .stopped
    }

    // MARK: rooms

    /// Joins a post's comment room until the returned token is cancelled
    /// (ref-counted: two views on one post share one subscription).
    func joinPostRoom(_ postId: Int) -> RoomToken {
        postRooms[postId, default: 0] += 1
        if postRooms[postId] == 1 { send(["type": "subscribe_post_comments", "postId": postId]) }
        return RoomToken { [weak self] in
            guard let self else { return }
            let remaining = (postRooms[postId] ?? 1) - 1
            if remaining <= 0 {
                postRooms[postId] = nil
                send(["type": "unsubscribe_post_comments", "postId": postId])
            } else {
                postRooms[postId] = remaining
            }
        }
    }

    /// Joins a named room (`game-hub:<game>`, `game-lobby:<id>`).
    func joinRoom(_ room: String) -> RoomToken {
        namedRooms[room, default: 0] += 1
        if namedRooms[room] == 1 { send(["type": "subscribe_room", "room": room]) }
        return RoomToken { [weak self] in
            guard let self else { return }
            let remaining = (namedRooms[room] ?? 1) - 1
            if remaining <= 0 {
                namedRooms[room] = nil
                send(["type": "unsubscribe_room", "room": room])
            } else {
                namedRooms[room] = remaining
            }
        }
    }

    /// A frame for the server to relay (game progress/reactions).
    func send(_ message: [String: Any]) {
        guard let connection,
              let data = try? JSONSerialization.data(withJSONObject: message, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8)
        else { return }
        Task { try? await connection.send(text) }
    }

    // MARK: loop

    private func run() async {
        var failures = 0
        while !Task.isCancelled {
            state = .connecting
            do {
                let opened = try await transport.open()
                connection = opened
                Self.log.notice("connected")
                state = .connected
                failures = 0
                replayRooms()
                onConnect()
                let pinger = Task { [weak self] in
                    while !Task.isCancelled {
                        try? await Task.sleep(for: Self.pingInterval)
                        // Anything at all resets the server's idle timeout.
                        try? await self?.connection?.send("ping")
                    }
                }
                defer { pinger.cancel() }
                while !Task.isCancelled {
                    let frame = try await opened.receive()
                    let event = RealtimeEvent.decode(frame)
                    Self.log.notice("frame \(frame, privacy: .public) decoded=\(event != nil)")
                    if let event { onEvent(event) }
                }
            } catch {
                // Fall through to backoff.
                Self.log.notice("connection ended: \(String(describing: error), privacy: .public)")
            }
            connection?.close()
            connection = nil
            guard !Task.isCancelled else { break }
            state = .waiting
            let delay = backoff.delay(afterFailures: failures)
            failures += 1
            do { try await sleep(delay) } catch { break }
        }
    }

    private func replayRooms() {
        // The previous socket's server-side membership died with it.
        for postId in postRooms.keys { send(["type": "subscribe_post_comments", "postId": postId]) }
        for room in namedRooms.keys { send(["type": "subscribe_room", "room": room]) }
    }
}

/// Leaves a room when cancelled. Views cancel it when they disappear.
@MainActor
final class RoomToken {
    private var leave: (() -> Void)?
    init(leave: @escaping () -> Void) { self.leave = leave }
    func cancel() {
        leave?()
        leave = nil
    }
}

/// The real transport: a ticket from `POST /realtime/ws-ticket`, then
/// `GET /ws?ticket=…` upgraded by URLSession.
struct URLSessionRealtimeTransport: RealtimeTransport {
    let api: APIClient

    func open() async throws -> any RealtimeConnection {
        let ticket = try await api.call { try await $0.realtime_createWsTicket() }.created.body.json.ticket
        var components = URLComponents(url: api.baseURL.appending(path: "ws"), resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.queryItems = [URLQueryItem(name: "ticket", value: ticket)]
        let task = api.urlSession.webSocketTask(with: components.url!)
        // The delegate has to be set before the task starts.
        let connection = WebSocketConnection(task: task)
        task.resume()
        try await connection.awaitOpen()
        return connection
    }
}

final class WebSocketConnection: NSObject, RealtimeConnection, URLSessionWebSocketDelegate, @unchecked Sendable {
    private let task: URLSessionWebSocketTask
    private let state = Mutex<(opened: Bool, failure: (any Error)?, waiter: CheckedContinuation<Void, any Error>?)>((false, nil, nil))

    init(task: URLSessionWebSocketTask) {
        self.task = task
        super.init()
        task.delegate = self
    }

    /// Resolves once the HTTP upgrade has succeeded; throws if it fails.
    func awaitOpen() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            let outcome: Result<Void, any Error>? = state.withLock { state in
                if state.opened { return .success(()) }
                if let failure = state.failure { return .failure(failure) }
                state.waiter = continuation
                return nil
            }
            if let outcome { continuation.resume(with: outcome) }
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        let waiter = state.withLock { state in
            state.opened = true
            defer { state.waiter = nil }
            return state.waiter
        }
        waiter?.resume()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        let failure = error ?? URLError(.networkConnectionLost)
        let waiter = state.withLock { state in
            state.failure = failure
            defer { state.waiter = nil }
            return state.waiter
        }
        waiter?.resume(throwing: failure)
    }

    func send(_ text: String) async throws { try await task.send(.string(text)) }

    func receive() async throws -> String {
        switch try await task.receive() {
        case .string(let text): return text
        case .data(let data): return String(decoding: data, as: UTF8.self)
        @unknown default: return ""
        }
    }

    func close() { task.cancel(with: .goingAway, reason: nil) }
}
