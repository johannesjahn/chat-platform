import ChatAPI
import Foundation

typealias User = Components.Schemas.User

/// The signed-in account: who, plus the token pair that proves it. Stored in
/// the Keychain as one JSON blob.
struct Session: Codable, Sendable, Equatable {
    var user: User
    var accessToken: String
    var refreshToken: String
}

struct TokenPair: Sendable, Equatable {
    var accessToken: String
    var refreshToken: String
}

enum RefreshFailure: Error {
    /// The server rejected the refresh token — the session is over.
    case rejected
}

protocol TokenRefreshing: Sendable {
    /// Throws `RefreshFailure.rejected` when the server says the token is no
    /// good; any other error (offline, timeout) means "try again later".
    func refresh(refreshToken: String) async throws -> TokenPair
}

/// Calls `POST /users/refresh` directly (not through the generated client,
/// whose middleware would recurse back into the refresher).
struct URLSessionRefresher: TokenRefreshing {
    let baseURL: URL
    let session: URLSession

    func refresh(refreshToken: String) async throws -> TokenPair {
        var request = URLRequest(url: baseURL.appending(path: "users/refresh"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["refreshToken": refreshToken])
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        if http.statusCode == 401 || http.statusCode == 400 { throw RefreshFailure.rejected }
        guard (200..<300).contains(http.statusCode) else { throw URLError(.badServerResponse) }
        struct Body: Decodable { var accessToken: String; var refreshToken: String }
        let body = try JSONDecoder().decode(Body.self, from: data)
        return TokenPair(accessToken: body.accessToken, refreshToken: body.refreshToken)
    }
}

/// The one owner of the session. Being an actor is what makes "only one
/// refresh in flight" true: a refresh token is rotated on use, so a second
/// concurrent call with the old one would fail and sign the user out.
actor SessionManager {
    /// Refresh this long before the access token's own expiry.
    static let refreshSkew: TimeInterval = 30

    private let storage: any SecretStorage
    private let refresher: any TokenRefreshing
    private let now: @Sendable () -> Date
    private var session: Session?
    private var inFlight: Task<Session?, Never>?
    private var observer: (@Sendable (Session?) -> Void)?

    init(storage: any SecretStorage, refresher: any TokenRefreshing, now: @escaping @Sendable () -> Date = { Date() }) {
        self.storage = storage
        self.refresher = refresher
        self.now = now
        if let data = storage.read(), let stored = try? JSONDecoder().decode(Session.self, from: data) {
            session = stored
        } else if storage.read() != nil {
            // Unreadable (an old format) reads as signed out, and is dropped.
            storage.delete()
        }
    }

    func setObserver(_ observer: @escaping @Sendable (Session?) -> Void) {
        self.observer = observer
    }

    func current() -> Session? { session }

    func start(_ new: Session) {
        session = new
        persist()
        observer?(new)
    }

    func clear() {
        inFlight?.cancel()
        inFlight = nil
        session = nil
        storage.delete()
        observer?(nil)
    }

    func updateUser(_ user: User) {
        guard var current = session, current.user != user else { return }
        current.user = user
        session = current
        persist()
        observer?(current)
    }

    /// The token to put on the next request, refreshed first when it's about
    /// to expire.
    func accessToken() async -> String? {
        guard let current = session else { return nil }
        if let expiry = JWT.expiry(of: current.accessToken),
           expiry.timeIntervalSince(now()) < Self.refreshSkew {
            let refreshed = await refresh()
            return refreshed?.accessToken ?? session?.accessToken
        }
        return current.accessToken
    }

    /// Called after a 401 with `failed`. Returns a token worth retrying with,
    /// or nil when the retry would be pointless (refresh failed or the user was
    /// signed out). A request that lost a race to another refresh just picks
    /// up the already-rotated token without a second network call.
    func recover(from failed: String) async -> String? {
        guard let current = session else { return nil }
        if current.accessToken != failed { return current.accessToken }
        guard let refreshed = await refresh(), refreshed.accessToken != failed else { return nil }
        return refreshed.accessToken
    }

    private func refresh() async -> Session? {
        if let inFlight { return await inFlight.value }
        guard let old = session else { return nil }
        let task = Task { await self.performRefresh(old) }
        inFlight = task
        let result = await task.value
        inFlight = nil
        return result
    }

    private func performRefresh(_ old: Session) async -> Session? {
        do {
            let pair = try await refresher.refresh(refreshToken: old.refreshToken)
            // Signed out, or signed in as someone else, while we waited.
            guard session?.refreshToken == old.refreshToken else { return session }
            var next = old
            next.accessToken = pair.accessToken
            next.refreshToken = pair.refreshToken
            session = next
            persist()
            observer?(next)
            return next
        } catch RefreshFailure.rejected {
            if session?.refreshToken == old.refreshToken { clear() }
            return nil
        } catch {
            // Offline or a server hiccup: keep the session, the next request tries again.
            return session
        }
    }

    private func persist() {
        guard let session, let data = try? JSONEncoder().encode(session) else { return }
        storage.write(data)
    }
}
