import Foundation

extension APIClient {
    /// POSTs a JSON body written as-is and decodes the answer. For the one
    /// request body with required-but-nullable fields (`ReflexTap`): the
    /// generated client's synthesized `Codable` *omits* a nil property, and
    /// the server's schema rejects a missing key (400) where it accepts an
    /// explicit `null`. Same bearer token and refresh-once-on-401 as every
    /// other call.
    func postJSON<T: Decodable & Sendable>(path: String, body: Data, as _: T.Type = T.self) async throws -> T {
        func send(token: String?) async throws -> (Data, HTTPURLResponse) {
            var request = URLRequest(url: baseURL.appending(path: path))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
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
            guard (200..<300).contains(response.statusCode) else { throw APIError.http(status: response.statusCode, body: data) }
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.from(error)
        }
    }
}

extension ReflexTap {
    /// This tap with every field present, nulls included.
    var explicitJSON: [String: Any] {
        [
            "early": early,
            "reactionMs": reactionMs.map { $0 as Any } ?? NSNull(),
            "direction": direction.map { $0.rawValue as Any } ?? NSNull(),
            "x": x.map { $0 as Any } ?? NSNull(),
            "y": y.map { $0 as Any } ?? NSNull(),
        ]
    }

    static func finishBody(_ taps: [ReflexTap]) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["taps": taps.map(\.explicitJSON)])
    }
}
