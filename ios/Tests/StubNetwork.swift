import Foundation
import Synchronization

@testable import ChatPlatform

/// A `URLProtocol` that answers from a per-host handler, so each test gets
/// its own fake backend (`http://<unique>.test`) and tests can run in
/// parallel. No live server is ever involved in a unit test.
final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    struct Reply {
        var status: Int = 200
        var body: Data = Data()
        var headers: [String: String] = ["Content-Type": "application/json"]
        var error: URLError?

        static func json(_ text: String, status: Int = 200) -> Reply {
            Reply(status: status, body: Data(text.utf8))
        }
        static func fail(_ code: URLError.Code) -> Reply { Reply(error: URLError(code)) }
    }

    struct Request: Sendable {
        var method: String
        var path: String
        var query: String
        var authorization: String?
        var body: Data
    }

    typealias Handler = @Sendable (Request) -> Reply

    private static let handlers = Mutex<[String: Handler]>([:])

    static func register(host: String, handler: @escaping Handler) {
        handlers.withLock { $0[host] = handler }
    }

    static func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: config)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url, let host = url.host(),
              let handler = Self.handlers.withLock({ $0[host] })
        else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost))
            return
        }
        var body = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open()
            let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 4096)
            defer { buffer.deallocate(); stream.close() }
            while stream.hasBytesAvailable {
                let count = stream.read(buffer, maxLength: 4096)
                if count <= 0 { break }
                body.append(buffer, count: count)
            }
        }
        let reply = handler(Request(
            method: request.httpMethod ?? "GET",
            path: url.path(percentEncoded: false),
            query: url.query() ?? "",
            authorization: request.value(forHTTPHeaderField: "Authorization"),
            body: body
        ))
        if let error = reply.error {
            client?.urlProtocol(self, didFailWithError: error)
            return
        }
        let response = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// A tiny fake backend: counts calls and lets a test script the answers.
final class FakeBackend: Sendable {
    let host = "t\(UUID().uuidString.prefix(8).lowercased()).test"
    var baseURL: URL { URL(string: "http://\(host)")! }

    private let state = Mutex(State())
    private struct State {
        var requests: [StubURLProtocol.Request] = []
    }

    var requests: [StubURLProtocol.Request] { state.withLock { $0.requests } }
    func count(path: String) -> Int { requests.filter { $0.path == path }.count }

    init(_ handler: @escaping @Sendable (StubURLProtocol.Request) -> StubURLProtocol.Reply) {
        let host = host
        StubURLProtocol.register(host: host) { [weak self] request in
            self?.state.withLock { $0.requests.append(request) }
            return handler(request)
        }
    }
}

/// An access token that looks like the server's (only `exp` matters).
func makeToken(expiresIn seconds: TimeInterval, tag: String = "") -> String {
    func b64(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    let header = b64(Data(#"{"alg":"HS256","typ":"JWT"}"#.utf8))
    let exp = Int(Date().addingTimeInterval(seconds).timeIntervalSince1970)
    let payload = b64(Data(#"{"sub":1,"exp":\#(exp),"jti":"\#(tag)"}"#.utf8))
    return "\(header).\(payload).sig"
}

let profileJSON = """
{"id":1,"username":"ada","displayName":"Ada","avatarUrl":null,"avatarVariants":null,"role":"user",
 "statusText":null,"statusEmoji":null,"statusExpiresAt":null,"bio":null}
"""

let userJSON = """
{"id":1,"username":"ada","displayName":"Ada","avatarUrl":null,"avatarVariants":null,"role":"user",
 "statusText":"Busy","statusEmoji":"🔥","statusExpiresAt":null}
"""
