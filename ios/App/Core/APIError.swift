import ChatAPI
import Foundation

/// What every failed request turns into. The server answers errors with
/// `{ "_tag": "...", "message": "..." }`, so that message is what people see.
struct APIError: Error, Sendable, Equatable, LocalizedError {
    enum Kind: Sendable, Equatable {
        case http(Int)
        case offline
        case cancelled
        case unknown
    }

    var kind: Kind
    var tag: String?
    var message: String

    var errorDescription: String? { message }

    var status: Int? {
        if case .http(let status) = kind { return status }
        return nil
    }

    var isUnauthorized: Bool { status == 401 }
    var isNotFound: Bool { status == 404 }
    var isCancelled: Bool { kind == .cancelled }

    /// Parses an error response body.
    static func http(status: Int, body: Data) -> APIError {
        struct Body: Decodable {
            var _tag: String?
            var message: String?
        }
        let parsed = try? JSONDecoder().decode(Body.self, from: body)
        let message = parsed?.message.flatMap { $0.isEmpty ? nil : $0 }
            ?? "Something went wrong (\(status))."
        return APIError(kind: .http(status), tag: parsed?._tag, message: message)
    }

    /// Normalizes anything thrown while calling the API.
    static func from(_ error: any Error) -> APIError {
        if let api = error as? APIError { return api }
        if let client = error as? ClientError { return from(client.underlyingError) }
        if error is CancellationError { return APIError(kind: .cancelled, tag: nil, message: "Cancelled.") }
        if let url = error as? URLError {
            switch url.code {
            case .cancelled:
                return APIError(kind: .cancelled, tag: nil, message: "Cancelled.")
            case .notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost,
                 .cannotFindHost, .timedOut, .dnsLookupFailed, .dataNotAllowed, .secureConnectionFailed:
                return APIError(kind: .offline, tag: nil, message: "Can't reach the server. Check your connection and try again.")
            default:
                break
            }
        }
        return APIError(kind: .unknown, tag: nil, message: "Something went wrong. Please try again.")
    }
}
