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

    // MARK: multipart uploads

    struct UploadFile: Sendable {
        var data: Data
        var filename: String
        var mimeType: String
    }

    /// `multipart/form-data` upload (attachments, avatars). The generated
    /// client can't set a part's own `Content-Type`, which the server reads as
    /// the file's type, so this builds the body itself — with the same bearer
    /// token and refresh-once-on-401 behaviour as every other call.
    func upload<T: Decodable & Sendable>(
        path: String, file: UploadFile, fields: [String: String] = [:], as _: T.Type = T.self
    ) async throws -> T {
        let boundary = "chatplatform-\(UUID().uuidString)"
        var body = Data()
        func append(_ text: String) { body.append(Data(text.utf8)) }
        for (name, value) in fields.sorted(by: { $0.key < $1.key }) {
            append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n")
        }
        append("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(file.filename.replacingOccurrences(of: "\"", with: "_"))\"\r\nContent-Type: \(file.mimeType)\r\n\r\n")
        body.append(file.data)
        append("\r\n--\(boundary)--\r\n")

        func send(token: String?) async throws -> (Data, HTTPURLResponse) {
            var request = URLRequest(url: baseURL.appending(path: path))
            request.httpMethod = "POST"
            request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
            if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
            let (data, response) = try await urlSession.upload(for: request, from: body)
            guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
            return (data, http)
        }

        do {
            let token = await sessions.accessToken()
            var (data, response) = try await send(token: token)
            if response.statusCode == 401, let token, let fresh = await sessions.recover(from: token) {
                (data, response) = try await send(token: fresh)
            }
            guard (200..<300).contains(response.statusCode) else {
                throw APIError.http(status: response.statusCode, body: data)
            }
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.from(error)
        }
    }
}
