import ChatAPI
import Foundation
import Testing

@testable import ChatPlatform

/// Token refresh and retry, end to end through the real generated client and
/// middleware, against a stubbed network.
@Suite struct SessionTests {
    private func makeEnvironment(
        backend: FakeBackend,
        access: String,
        refresh: String = "refresh-1",
        storage: InMemoryStorage = InMemoryStorage()
    ) async -> (api: APIClient, sessions: SessionManager, storage: InMemoryStorage) {
        let urlSession = StubURLProtocol.session()
        let sessions = SessionManager(
            storage: storage,
            refresher: URLSessionRefresher(baseURL: backend.baseURL, session: urlSession)
        )
        if let user = try? JSONDecoder().decode(User.self, from: Data(userJSON.utf8)) {
            await sessions.start(Session(user: user, accessToken: access, refreshToken: refresh))
        }
        return (APIClient(baseURL: backend.baseURL, sessions: sessions, urlSession: urlSession), sessions, storage)
    }

    private func getProfile(_ api: APIClient) async throws -> String {
        try await api.call { try await $0.users_getUser(path: .init(id: "1")) }.ok.body.json.username
    }

    @Test func sendsTheBearerToken() async throws {
        let access = makeToken(expiresIn: 900)
        let backend = FakeBackend { _ in .json(profileJSON) }
        let (api, _, _) = await makeEnvironment(backend: backend, access: access)
        #expect(try await getProfile(api) == "ada")
        #expect(backend.requests.first?.authorization == "Bearer \(access)")
    }

    @Test func nullableFieldsSurviveTheGeneratedModels() async throws {
        // Regression: the generator drops `anyOf: [X, null]` properties unless
        // scripts/prepare-openapi.ts rewrites them.
        let user = try JSONDecoder().decode(User.self, from: Data(userJSON.utf8))
        #expect(user.displayName == "Ada")
        #expect(user.statusText == "Busy")
        #expect(user.statusEmoji == "🔥")
        #expect(user.id == 1)
    }

    @Test func a401RefreshesOnceAndRetriesWithTheNewToken() async throws {
        let stale = makeToken(expiresIn: 900, tag: "stale")
        let fresh = makeToken(expiresIn: 900, tag: "fresh")
        let backend = FakeBackend { request in
            switch request.path {
            case "/users/refresh":
                return .json(#"{"accessToken":"\#(fresh)","refreshToken":"refresh-2"}"#)
            default:
                return request.authorization == "Bearer \(fresh)"
                    ? .json(profileJSON)
                    : .json(#"{"_tag":"Unauthorized","message":"nope"}"#, status: 401)
            }
        }
        let (api, sessions, storage) = await makeEnvironment(backend: backend, access: stale)
        #expect(try await getProfile(api) == "ada")
        #expect(backend.count(path: "/users/refresh") == 1)
        #expect(backend.count(path: "/users/1") == 2)
        let stored = await sessions.current()
        #expect(stored?.accessToken == fresh)
        #expect(stored?.refreshToken == "refresh-2")
        // The rotated pair is persisted, not just held in memory.
        let persisted = try storage.read().map { try JSONDecoder().decode(Session.self, from: $0) }
        #expect(persisted?.refreshToken == "refresh-2")
    }

    @Test func concurrent401sShareOneRefresh() async throws {
        let stale = makeToken(expiresIn: 900, tag: "stale")
        let fresh = makeToken(expiresIn: 900, tag: "fresh")
        let backend = FakeBackend { request in
            if request.path == "/users/refresh" {
                Thread.sleep(forTimeInterval: 0.15) // keep the refresh in flight while the others pile up
                return .json(#"{"accessToken":"\#(fresh)","refreshToken":"refresh-2"}"#)
            }
            return request.authorization == "Bearer \(fresh)" ? .json(profileJSON) : .json(#"{"message":"no"}"#, status: 401)
        }
        let (api, _, _) = await makeEnvironment(backend: backend, access: stale)
        let names = try await withThrowingTaskGroup(of: String.self) { group in
            for _ in 0..<6 { group.addTask { try await getProfile(api) } }
            return try await group.reduce(into: []) { $0.append($1) }
        }
        #expect(names.count == 6)
        #expect(backend.count(path: "/users/refresh") == 1)
    }

    @Test func aRejectedRefreshSignsOut() async throws {
        let backend = FakeBackend { request in
            request.path == "/users/refresh"
                ? .json(#"{"_tag":"InvalidCredentials","message":"Invalid refresh token"}"#, status: 401)
                : .json(#"{"_tag":"Unauthorized","message":"Unauthorized"}"#, status: 401)
        }
        let (api, sessions, storage) = await makeEnvironment(backend: backend, access: makeToken(expiresIn: 900))
        let error = await #expect(throws: APIError.self) { try await getProfile(api) }
        #expect(error?.isUnauthorized == true)
        #expect(await sessions.current() == nil)
        #expect(storage.read() == nil)
        #expect(backend.count(path: "/users/refresh") == 1)
    }

    @Test func aRefreshThatCantReachTheServerKeepsTheSession() async throws {
        let backend = FakeBackend { request in
            request.path == "/users/refresh" ? .fail(.notConnectedToInternet) : .json(#"{"message":"no"}"#, status: 401)
        }
        let (api, sessions, _) = await makeEnvironment(backend: backend, access: makeToken(expiresIn: 900))
        await #expect(throws: APIError.self) { try await getProfile(api) }
        #expect(await sessions.current() != nil)
    }

    @Test func anExpiringTokenIsRefreshedBeforeTheRequest() async throws {
        let fresh = makeToken(expiresIn: 900, tag: "fresh")
        let backend = FakeBackend { request in
            request.path == "/users/refresh"
                ? .json(#"{"accessToken":"\#(fresh)","refreshToken":"refresh-2"}"#)
                : .json(profileJSON)
        }
        let (api, _, _) = await makeEnvironment(backend: backend, access: makeToken(expiresIn: 5))
        #expect(try await getProfile(api) == "ada")
        // One refresh, and the request went out once, already with the new token.
        #expect(backend.count(path: "/users/refresh") == 1)
        #expect(backend.requests.last?.authorization == "Bearer \(fresh)")
        #expect(backend.count(path: "/users/1") == 1)
    }

    @Test func loginDoesNotTryToRefreshAWrongPassword() async throws {
        let backend = FakeBackend { request in
            request.path == "/users/login"
                ? .json(#"{"_tag":"InvalidCredentials","message":"Invalid username or password"}"#, status: 401)
                : .json(profileJSON) // the launch-time profile refresh
        }
        let (api, sessions, _) = await makeEnvironment(backend: backend, access: makeToken(expiresIn: 900))
        let auth = await AuthModel(api: api, sessions: sessions)
        let error = await #expect(throws: APIError.self) { try await auth.login(username: "ada", password: "bad") }
        #expect(error?.message == "Invalid username or password")
        #expect(error?.tag == "InvalidCredentials")
        #expect(backend.count(path: "/users/refresh") == 0)
        #expect(await sessions.current() != nil)
    }

    @Test func errorBodiesBecomeMessages() async throws {
        let backend = FakeBackend { _ in .json(#"{"_tag":"UsernameTaken","message":"That username is taken"}"#, status: 409) }
        let (api, _, _) = await makeEnvironment(backend: backend, access: makeToken(expiresIn: 900))
        let error = await #expect(throws: APIError.self) {
            _ = try await api.call { try await $0.users_register(body: .json(.init(username: "ada", password: "password1"))) }
        }
        #expect(error?.status == 409)
        #expect(error?.message == "That username is taken")
    }

    @Test func offlineIsReportedAsOffline() async throws {
        let backend = FakeBackend { _ in .fail(.notConnectedToInternet) }
        let (api, _, _) = await makeEnvironment(backend: backend, access: makeToken(expiresIn: 900))
        let error = await #expect(throws: APIError.self) { try await getProfile(api) }
        #expect(error?.kind == .offline)
    }
}

@Suite struct CoreTests {
    @Test func jwtExpiryIsReadWithoutVerifying() {
        let token = makeToken(expiresIn: 600)
        let expiry = JWT.expiry(of: token)
        #expect(expiry != nil)
        #expect(abs((expiry?.timeIntervalSinceNow ?? 0) - 600) < 5)
        #expect(JWT.expiry(of: "garbage") == nil)
    }

    @Test func configPrefersTheLaunchArgumentThenThePlistThenLocalhost() {
        let plist: [String: Any] = ["APIBaseURL": "https://plist.example.com/"]
        #expect(AppConfig.resolve(arguments: ["app", "-apiBaseURL", "http://localhost:4000"], infoDictionary: plist).apiBaseURL.absoluteString == "http://localhost:4000")
        #expect(AppConfig.resolve(arguments: ["app"], infoDictionary: plist).apiBaseURL.absoluteString == "https://plist.example.com")
        #expect(AppConfig.resolve(arguments: ["app"], infoDictionary: ["APIBaseURL": ""]).apiBaseURL == AppConfig.fallbackBaseURL)
        #expect(AppConfig.resolve(arguments: ["app", "-apiBaseURL", "not a url"], infoDictionary: nil).apiBaseURL == AppConfig.fallbackBaseURL)
        #expect(AppConfig.resolve(arguments: ["app", "-apiBaseURL", "ftp://x.test"], infoDictionary: nil).apiBaseURL == AppConfig.fallbackBaseURL)
    }

    @Test func keychainRoundTrips() {
        let storage = KeychainStorage(service: "dev.chatplatform.ios.tests", account: UUID().uuidString)
        defer { storage.delete() }
        #expect(storage.read() == nil)
        storage.write(Data("one".utf8))
        storage.write(Data("two".utf8))
        #expect(storage.read() == Data("two".utf8))
        storage.delete()
        #expect(storage.read() == nil)
    }

    @Test func anUnreadableStoredSessionReadsAsSignedOut() async {
        let storage = InMemoryStorage(Data("not json".utf8))
        let backend = FakeBackend { _ in .json("{}") }
        let sessions = SessionManager(storage: storage, refresher: URLSessionRefresher(baseURL: backend.baseURL, session: StubURLProtocol.session()))
        #expect(await sessions.current() == nil)
        #expect(storage.read() == nil)
    }

    @Test func apiErrorFallsBackWhenTheBodyIsntJSON() {
        let error = APIError.http(status: 502, body: Data("<html>".utf8))
        #expect(error.status == 502)
        #expect(error.message.contains("502"))
    }
}
