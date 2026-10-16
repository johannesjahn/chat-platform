import ChatAPI
import Foundation

/// A thin wrapper over the generated `Client`: a configurable base URL, the
/// auth/error middleware, and one place that normalizes thrown errors.
///
/// ```swift
/// let page = try await api.call { try await $0.posts_listPosts(.init()) }.ok.body.json
/// ```
final class APIClient: Sendable {
    let baseURL: URL
    let sessions: SessionManager
    let urlSession: URLSession
    private let client: Client

    init(baseURL: URL, sessions: SessionManager, urlSession: URLSession = .shared) {
        self.baseURL = baseURL
        self.sessions = sessions
        self.urlSession = urlSession
        client = Client(
            serverURL: baseURL,
            transport: URLSessionTransport(configuration: .init(session: urlSession)),
            middlewares: [ErrorMappingMiddleware(), AuthMiddleware(sessions: sessions)]
        )
    }

    /// Runs a generated-client call, rethrowing anything it throws as `APIError`.
    func call<T: Sendable>(_ operation: @Sendable (Client) async throws -> T) async throws -> T {
        do {
            return try await operation(client)
        } catch {
            throw APIError.from(error)
        }
    }

    /// A `URLRequest` with the current bearer token — for the few things the
    /// generated client can't do (websocket handshakes, image loading).
    func authorizedRequest(for url: URL) async -> URLRequest {
        var request = URLRequest(url: url)
        if let token = await sessions.accessToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }
}
