import ChatAPI
import Foundation

/// Turns every non-2xx response into a thrown `APIError`, so call sites only
/// ever see success bodies. Sits outside `AuthMiddleware`, which must see the
/// raw 401 to retry it.
struct ErrorMappingMiddleware: ClientMiddleware {
    func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String,
        next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
    ) async throws -> (HTTPResponse, HTTPBody?) {
        let (response, responseBody) = try await next(request, body, baseURL)
        guard response.status.code >= 400 else { return (response, responseBody) }
        var data = Data()
        if let responseBody { data = (try? await Data(collecting: responseBody, upTo: 1 << 20)) ?? Data() }
        throw APIError.http(status: response.status.code, body: data)
    }
}

/// Adds the bearer token, and on a 401 refreshes once and retries.
struct AuthMiddleware: ClientMiddleware {
    let sessions: SessionManager

    /// Calls that never carry (or recover) a session.
    static let unauthenticated: Set<String> = [
        "users.login", "users.register", "users.refresh", "users.logout", "meta.getVersion",
    ]

    func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String,
        next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
    ) async throws -> (HTTPResponse, HTTPBody?) {
        // Buffered so the retry can send it again.
        let payload: Data? = if let body { try await Data(collecting: body, upTo: 64 << 20) } else { nil }

        @Sendable func send(token: String?) async throws -> (HTTPResponse, HTTPBody?) {
            var outgoing = request
            if let token { outgoing.headerFields[.authorization] = "Bearer \(token)" }
            return try await next(outgoing, payload.map { HTTPBody($0) }, baseURL)
        }

        if Self.unauthenticated.contains(operationID) { return try await send(token: nil) }
        guard let token = await sessions.accessToken() else { return try await send(token: nil) }
        let first = try await send(token: token)
        guard first.0.status == .unauthorized,
              let fresh = await sessions.recover(from: token)
        else { return first }
        return try await send(token: fresh)
    }
}
