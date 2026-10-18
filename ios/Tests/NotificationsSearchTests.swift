import ChatAPI
import Foundation
import SwiftUI
import Synchronization
import Testing

@testable import ChatPlatform

private let actorJSON = #"{"id":2,"username":"bob","displayName":"Bob","avatarUrl":null,"avatarVariants":null,"role":"user","statusText":null,"statusEmoji":null,"statusExpiresAt":null}"#

private func notificationJSON(
    _ id: Int, type: String = "comment", postId: Int? = 5, commentId: Int? = nil, emoji: String? = nil,
    game: String? = nil, lobbyId: Int? = nil, read: Bool = false
) -> String {
    func json(_ value: Int?) -> String { value.map(String.init) ?? "null" }
    func json(_ value: String?) -> String { value.map { "\"\($0)\"" } ?? "null" }
    return #"{"id":\#(id),"type":"\#(type)","actor":\#(actorJSON),"postId":\#(json(postId)),"commentId":\#(json(commentId)),"emoji":\#(json(emoji)),"game":\#(json(game)),"lobbyId":\#(json(lobbyId)),"excerpt":"nice post","read":\#(read),"createdAt":1000}"#
}

private func decodeNotification(_ json: String) throws -> InboxNotification {
    try JSONDecoder().decode(InboxNotification.self, from: Data(json.utf8))
}

@Suite struct NotificationPresentationTests {
    @Test func postAndCommentNotificationsOpenThePost() throws {
        #expect(NotificationPresentation.route(for: try decodeNotification(notificationJSON(1, type: "comment", postId: 5, commentId: 9))) == .post(5))
        #expect(NotificationPresentation.route(for: try decodeNotification(notificationJSON(1, type: "reply", postId: 6, commentId: 9))) == .post(6))
        #expect(NotificationPresentation.route(for: try decodeNotification(notificationJSON(1, type: "reaction", postId: 7, emoji: "👍"))) == .post(7))
        #expect(NotificationPresentation.route(for: try decodeNotification(notificationJSON(1, type: "mention", postId: 8))) == .post(8))
    }

    @Test func gameNotificationsOpenTheLobbyTheGameOrTheLeaderboard() throws {
        #expect(NotificationPresentation.route(for: try decodeNotification(notificationJSON(1, type: "game_invite", postId: nil, game: "typing", lobbyId: 42))) == .gameLobby(42))
        #expect(NotificationPresentation.route(for: try decodeNotification(notificationJSON(1, type: "game_invite", postId: nil, game: "reflex"))) == .game("reflex"))
        #expect(NotificationPresentation.route(for: try decodeNotification(notificationJSON(1, type: "game_record", postId: nil, game: "drawing"))) == .leaderboard("drawing"))
    }

    @Test func nothingLeftToPointAtHasNoRoute() throws {
        #expect(NotificationPresentation.route(for: try decodeNotification(notificationJSON(1, type: "game_record", postId: nil))) == nil)
    }

    @Test func sentencesMatchTheWeb() throws {
        func sentence(_ json: String) throws -> String { NotificationPresentation.sentence(for: try decodeNotification(json)) }
        #expect(try sentence(notificationJSON(1, type: "comment")) == "commented on your post")
        #expect(try sentence(notificationJSON(1, type: "reply", commentId: 3)) == "replied to your comment")
        #expect(try sentence(notificationJSON(1, type: "reaction", commentId: 3, emoji: "🔥")) == "reacted 🔥 to your comment")
        #expect(try sentence(notificationJSON(1, type: "reaction", emoji: "👍")) == "reacted 👍 to your post")
        #expect(try sentence(notificationJSON(1, type: "mention", commentId: 3)) == "mentioned you in a comment")
        #expect(try sentence(notificationJSON(1, type: "game_invite", game: "typing", lobbyId: 1)) == "invited you to play Type Race")
        #expect(try sentence(notificationJSON(1, type: "game_record", game: "reflex")) == "took your #1 spot on the Reflex Rush leaderboard")
    }
}

@MainActor
private func makeAPI(_ backend: FakeBackend) -> (APIClient, UserStore) {
    let urlSession = StubURLProtocol.session()
    let sessions = SessionManager(storage: InMemoryStorage(), refresher: URLSessionRefresher(baseURL: backend.baseURL, session: urlSession))
    let api = APIClient(baseURL: backend.baseURL, sessions: sessions, urlSession: urlSession)
    return (api, UserStore(api: api))
}

/// A one-shot gate a stub handler can wait on (from URLProtocol's thread).
private final class Gate: Sendable {
    private let semaphore = DispatchSemaphore(value: 0)
    func wait() { _ = semaphore.wait(timeout: .now() + 5) }
    func open() { semaphore.signal() }
}

@MainActor
@Suite struct NotificationStoreTests {
    private func page(_ items: [String], unread: Int, next: String? = nil) -> String {
        #"{"notifications":[\#(items.joined(separator: ","))],"limit":20,"nextCursor":\#(next.map { "\"\($0)\"" } ?? "null"),"unreadCount":\#(unread)}"#
    }

    @Test func loadingTheInboxPagesAndSetsTheBadge() async {
        let backend = FakeBackend { request in
            switch request.path {
            case "/notifications":
                return request.query.contains("cursor=c1")
                    ? .json(#"{"notifications":[\#(notificationJSON(1, read: true))],"limit":20,"nextCursor":null,"unreadCount":2}"#)
                    : .json(#"{"notifications":[\#(notificationJSON(3)),\#(notificationJSON(2))],"limit":20,"nextCursor":"c1","unreadCount":2}"#)
            case "/notifications/unread-count": return .json(#"{"count":7}"#)
            default: return .json("{}", status: 404)
            }
        }
        let (api, users) = makeAPI(backend)
        let store = NotificationStore(api: api, users: users)
        await store.load(reset: true)
        #expect(store.page.ids == [3, 2])
        #expect(store.unreadCount == 2)
        #expect(store.phase == .loaded)
        #expect(users.user(2)?.username == "bob") // the actor seeds the cache
        await store.loadMore()
        #expect(store.page.ids == [3, 2, 1])
        #expect(!store.page.hasMore)
        await store.refreshUnreadCount()
        #expect(store.unreadCount == 7)
    }

    @Test func aDifferentAccountStartsFromAnEmptyInbox() async {
        let backend = FakeBackend { _ in .json(#"{"notifications":[\#(notificationJSON(1))],"limit":20,"nextCursor":null,"unreadCount":1}"#) }
        let (api, users) = makeAPI(backend)
        let store = NotificationStore(api: api, users: users)
        store.signedIn(as: 1)
        await store.load(reset: true)
        store.signedIn(as: 1)
        #expect(store.unreadCount == 1 && store.page.ids == [1])
        store.signedIn(as: 9)
        #expect(store.unreadCount == 0 && store.page.ids.isEmpty && store.phase == .idle)
    }

    @Test func markReadIsOptimisticThenTakesTheServersCount() async {
        let gate = Gate()
        let backend = FakeBackend { request in
            if request.path == "/notifications/1/read" {
                gate.wait()
                return .json(#"{"count":0}"#)
            }
            return .json(#"{"notifications":[\#(notificationJSON(1)),\#(notificationJSON(2, read: true))],"limit":20,"nextCursor":null,"unreadCount":3}"#)
        }
        let (api, users) = makeAPI(backend)
        let store = NotificationStore(api: api, users: users)
        await store.load(reset: true)
        let task = Task { await store.markRead(1) }
        // Before the server answers, the row already reads as read.
        while store.notification(1)?.read != true { await Task.yield() }
        #expect(store.unreadCount == 2)
        gate.open()
        await task.value
        #expect(store.unreadCount == 0)
        #expect(store.notification(1)?.read == true)
        // Already read: no second request.
        await store.markRead(1)
        await store.markRead(2)
        #expect(backend.count(path: "/notifications/1/read") == 1)
        #expect(backend.count(path: "/notifications/2/read") == 0)
    }

    @Test func aFailedMarkReadRollsBack() async {
        let backend = FakeBackend { request in
            if request.path == "/notifications/1/read" { return .json(#"{"_tag":"X","message":"Nope"}"#, status: 500) }
            return .json(#"{"notifications":[\#(notificationJSON(1))],"limit":20,"nextCursor":null,"unreadCount":1}"#)
        }
        let (api, users) = makeAPI(backend)
        let store = NotificationStore(api: api, users: users)
        await store.load(reset: true)
        await store.markRead(1)
        #expect(store.notification(1)?.read == false)
        #expect(store.unreadCount == 1)
        #expect(store.actionError == "Nope")
    }

    @Test func aVanishedNotificationIsDroppedNotResurrected() async {
        let backend = FakeBackend { request in
            switch request.path {
            case "/notifications/1/read": return .json(#"{"_tag":"NotFound","message":"Not found"}"#, status: 404)
            case "/notifications/unread-count": return .json(#"{"count":0}"#)
            default: return .json(#"{"notifications":[\#(notificationJSON(1))],"limit":20,"nextCursor":null,"unreadCount":1}"#)
            }
        }
        let (api, users) = makeAPI(backend)
        let store = NotificationStore(api: api, users: users)
        await store.load(reset: true)
        await store.markRead(1)
        #expect(store.page.ids.isEmpty)
        #expect(store.unreadCount == 0)
        #expect(store.actionError == nil)
    }

    @Test func markAllReadClearsAndRollsBackOnFailure() async {
        let failing = Mutex(true)
        let backend = FakeBackend { request in
            if request.path == "/notifications/read-all" {
                return failing.withLock { $0 } ? .fail(.notConnectedToInternet) : .json(#"{"count":0}"#)
            }
            return .json(#"{"notifications":[\#(notificationJSON(1)),\#(notificationJSON(2)),\#(notificationJSON(3, read: true))],"limit":20,"nextCursor":null,"unreadCount":2}"#)
        }
        let (api, users) = makeAPI(backend)
        let store = NotificationStore(api: api, users: users)
        await store.load(reset: true)
        await store.markAllRead()
        #expect(store.unreadCount == 2)
        #expect(store.notification(1)?.read == false && store.notification(2)?.read == false && store.notification(3)?.read == true)
        #expect(store.actionError != nil)
        failing.withLock { $0 = false }
        await store.markAllRead()
        #expect(store.unreadCount == 0)
        #expect([1, 2, 3].allSatisfy { store.notification($0)?.read == true })
    }

    @Test func realtimeEventsInvalidateTheNotificationsTopic() {
        let env = AppEnvironment(config: AppConfig(apiBaseURL: URL(string: "http://env.test")!), options: LaunchOptions(uiTesting: false, injectedSession: nil, appearance: nil), storage: InMemoryStorage(), urlSession: StubURLProtocol.session())
        let before = env.invalidations.token(.notifications)
        env.handle(.notificationsChanged)
        #expect(env.invalidations.token(.notifications) == before + 1)
    }
}

@Suite struct SearchHighlightTests {
    @Test func matchedRunsAreMarkedAndTheTextIsKept() {
        let segments = [SnippetSegment(text: "say ", match: false), SnippetSegment(text: "hello", match: true), SnippetSegment(text: " <b>world</b>", match: false)]
        let attributed = SearchHighlight.attributed(segments)
        #expect(String(attributed.characters) == "say hello <b>world</b>")
        let runs = attributed.runs.map { (String(attributed[$0.range].characters), $0.inlinePresentationIntent) }
        #expect(runs.count == 3)
        #expect(runs[1].0 == "hello" && runs[1].1 == .stronglyEmphasized)
        #expect(runs[0].1 == nil && runs[2].1 == nil)
        #expect(SearchHighlight.matches(segments) == ["hello"])
    }

    @Test func anEmptySnippetIsEmpty() {
        #expect(SearchHighlight.attributed([]).characters.isEmpty)
    }
}

private let userResultJSON = #"{"user":\#(actorJSON),"snippet":[{"text":"Bo","match":true},{"text":"b","match":false}]}"#
private func postResultJSON(_ id: Int) -> String {
    #"{"id":\#(id),"author":\#(actorJSON),"createdAt":1000,"snippet":[{"text":"word","match":true}]}"#
}
private let emptyPage = #"{"results":[],"limit":5,"nextCursor":null}"#
private let emptyMessages = #"{"results":[],"chats":[],"limit":5,"nextCursor":null}"#

@MainActor
@Suite struct SearchModelTests {
    private func makeModel(_ backend: FakeBackend) -> SearchModel {
        SearchModel(api: makeAPI(backend).0, debounce: .milliseconds(40))
    }

    @Test func tooShortQueriesNeverReachTheServer() async {
        let backend = FakeBackend { _ in .json("{}") }
        let model = makeModel(backend)
        await model.update(text: " a ", scope: .all)
        await model.update(text: "", scope: .posts)
        #expect(!model.isReady)
        #expect(backend.requests.isEmpty)
    }

    @Test func aBurstOfTypingSendsOneSearch() async {
        let backend = FakeBackend { _ in
            .json(#"{"users":\#(emptyPage),"posts":{"results":[\#(postResultJSON(1))],"limit":5,"nextCursor":"more"},"comments":\#(emptyPage),"messages":\#(emptyMessages)}"#)
        }
        let model = makeModel(backend)
        let first = Task { await model.update(text: "wo", scope: .all) }
        first.cancel() // the next keystroke landed inside the debounce
        let second = Task { await model.update(text: "wor", scope: .all) }
        second.cancel()
        await model.update(text: "  word ", scope: .all)
        await first.value
        await second.value
        #expect(backend.count(path: "/search") == 1)
        #expect(backend.requests.first?.query.contains("q=word") == true)
        #expect(backend.requests.first?.query.contains("limit=5") == true)
        #expect(model.query == "word")
        #expect(model.allPhase == .loaded)
        let posts = model.overview(.posts)
        #expect(posts.hits.map(\.id) == ["post.1"] && posts.hasMore)
        #expect(!model.overviewIsEmpty)
        // The same text again (e.g. a tab bounce) doesn't refetch.
        await model.update(text: "word", scope: .all)
        #expect(backend.count(path: "/search") == 1)
    }

    @Test func eachKindPagesThroughItsOwnEndpoint() async {
        let backend = FakeBackend { request in
            switch request.path {
            case "/search/posts":
                return request.query.contains("cursor=p2")
                    ? .json(#"{"results":[\#(postResultJSON(1))],"limit":20,"nextCursor":null}"#)
                    : .json(#"{"results":[\#(postResultJSON(3)),\#(postResultJSON(2))],"limit":20,"nextCursor":"p2"}"#)
            case "/search/users":
                return .json(#"{"results":[\#(userResultJSON)],"limit":20,"nextCursor":null}"#)
            case "/search/messages":
                return .json(#"{"results":[{"id":11,"chatId":4,"sender":\#(actorJSON),"createdAt":1000,"snippet":[{"text":"hey","match":true}]}],"chats":[{"id":4,"type":"direct","title":null,"participants":[{"userId":1,"username":"ada","displayName":null,"avatarUrl":null,"avatarVariants":null,"role":"member","statusText":null,"statusEmoji":null,"statusExpiresAt":null},{"userId":2,"username":"bob","displayName":"Bob","avatarUrl":null,"avatarVariants":null,"role":"member","statusText":null,"statusEmoji":null,"statusExpiresAt":null}]}],"limit":20,"nextCursor":null}"#)
            default:
                return .json("{}", status: 500)
            }
        }
        let model = makeModel(backend)
        await model.update(text: "word", scope: .posts)
        #expect(model.list(.posts).items.map(\.id) == ["post.3", "post.2"])
        #expect(backend.requests.first?.query.contains("limit=20") == true)
        await model.loadMore(.posts)
        #expect(model.list(.posts).items.map(\.id) == ["post.3", "post.2", "post.1"])
        #expect(!model.list(.posts).page.hasMore)
        await model.loadMore(.posts) // nothing left
        #expect(backend.count(path: "/search/posts") == 2)

        // Switching tab with the same text loads at once, without the debounce.
        await model.update(text: "word", scope: .users)
        #expect(model.list(.users).items.first?.route == .profile(2))
        await model.update(text: "word", scope: .messages)
        let message = model.list(.messages).items.first
        #expect(message?.route == .chat(4, messageId: 11))
        #expect(model.chatName(4, viewer: 1) == "Bob")

        // Going back to a loaded tab doesn't refetch; a new query starts over.
        await model.update(text: "word", scope: .posts)
        #expect(backend.count(path: "/search/posts") == 2)
        await model.update(text: "other", scope: .posts)
        #expect(backend.count(path: "/search/posts") == 3)
        #expect(model.list(.users).page.hasLoadedFirstPage == false)
    }

    @Test func aFailedSearchShowsAnErrorAndRetryRecovers() async {
        let failing = Mutex(true)
        let backend = FakeBackend { _ in
            failing.withLock { $0 }
                ? .json(#"{"_tag":"X","message":"Search is down"}"#, status: 500)
                : .json(#"{"users":\#(emptyPage),"posts":\#(emptyPage),"comments":\#(emptyPage),"messages":\#(emptyMessages)}"#)
        }
        let model = makeModel(backend)
        await model.update(text: "word", scope: .all)
        #expect(model.allPhase == .failed("Search is down"))
        failing.withLock { $0 = false }
        await model.load(.all, force: true)
        #expect(model.allPhase == .loaded)
        #expect(model.overviewIsEmpty)
    }

    @Test func commentHitsOpenTheirPost() {
        let comment = try! JSONDecoder().decode(CommentSearchResult.self, from: Data(#"{"id":9,"postId":4,"parentCommentId":2,"author":\#(actorJSON),"createdAt":1,"snippet":[]}"#.utf8))
        #expect(SearchHit.comment(comment).route == .post(4))
        #expect(SearchHit.comment(comment).id == "comment.9")
    }
}
