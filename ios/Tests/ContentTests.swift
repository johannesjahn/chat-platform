import ChatAPI
import Foundation
import Synchronization
import Testing

@testable import ChatPlatform

@Suite struct MentionTests {
    private func mentions(_ text: String) -> [String] {
        Mentions.parse(text).compactMap { if case .mention(_, let name) = $0 { name } else { nil } }
    }

    @Test func findsMentionsInProse() {
        #expect(mentions("hi @alice and @bob_2!") == ["alice", "bob_2"])
        #expect(mentions("@alice") == ["alice"])
    }

    @Test func trailingPunctuationBelongsToTheSentence() {
        #expect(mentions("ask @alice.") == ["alice"])
        #expect(mentions("thanks @bob-") == ["bob"])
        #expect(mentions("see @a.b, ok") == ["a.b"])
    }

    @Test func emailsAndMidWordAtSignsAreNotMentions() {
        #expect(mentions("mail someone@example.com") == [])
        #expect(mentions("a@b") == [])
    }

    @Test func segmentsReassembleTheOriginalText() {
        let text = "héllo @alice, 😀 meet @bob.\nbye"
        let rebuilt = Mentions.parse(text).map { segment in
            switch segment {
            case .text(let plain): plain
            case .mention(let shown, _): shown
            }
        }.joined()
        #expect(rebuilt == text)
    }

    @Test func lookupListIsDistinctAndCapped() {
        #expect(Mentions.usernames(in: "@a @A @b @a") == ["a", "b"])
        let many = (0..<40).map { "@user\($0)" }.joined(separator: " ")
        #expect(Mentions.usernames(in: many).count == Mentions.maxLookupCount)
    }
}

@Suite struct PagingTests {
    @Test func appendSkipsWhatIsAlreadyShown() {
        var page = PageState<Int>()
        page.replace(ids: [5, 4, 3], nextCursor: "c1")
        #expect(page.hasMore)
        // A new item arrived at the head, so the next page repeats the old tail.
        page.append(ids: [3, 2, 1], nextCursor: nil)
        #expect(page.ids == [5, 4, 3, 2, 1])
        #expect(!page.hasMore)
    }

    @Test func aBackgroundRefetchKeepsTheLoadedTail() {
        var page = PageState<Int>()
        page.replace(ids: [5, 4, 3], nextCursor: "c1")
        page.append(ids: [2, 1], nextCursor: "c2")
        page.mergeHead(ids: [6, 5, 4], nextCursor: "other")
        #expect(page.ids == [6, 5, 4, 3, 2, 1])
        #expect(page.nextCursor == "c2")
    }

    @Test func aFirstLoadOrAShortListJustReplaces() {
        var page = PageState<Int>()
        page.mergeHead(ids: [3, 2], nextCursor: "n")
        #expect(page.ids == [3, 2] && page.hasLoadedFirstPage)
        page.mergeHead(ids: [4, 3, 2], nextCursor: nil)
        #expect(page.ids == [4, 3, 2] && !page.hasMore)
    }

    @Test func prependAndRemove() {
        var page = PageState<Int>()
        page.replace(ids: [2, 1], nextCursor: nil)
        page.prepend(3); page.prepend(3)
        #expect(page.ids == [3, 2, 1])
        page.remove(2)
        #expect(page.ids == [3, 1])
    }

    @Test func reactionCountsKeepMyReactionAndDropEmptyOnes() {
        let previous = [ReactionSummary(emoji: "👍", count: 1, reactedByMe: true), ReactionSummary(emoji: "😂", count: 1, reactedByMe: false)]
        let merged = PostStore.mergeReactionCounts(previous, [.init(emoji: "👍", count: 3), .init(emoji: "😮", count: 1), .init(emoji: "😂", count: 0)])
        #expect(merged == [ReactionSummary(emoji: "👍", count: 3, reactedByMe: true), ReactionSummary(emoji: "😮", count: 1, reactedByMe: false)])
    }
}

func postJSON(_ id: Int) -> String {
    #"{"id":\#(id),"authorId":1,"contentType":"text","content":"post \#(id)","attachment":null,"createdAt":1000,"updatedAt":1000,"reactions":[],"commentCount":0}"#
}

@MainActor
@Suite struct PostStoreTests {
    private func makeStore(_ backend: FakeBackend) async -> (PostStore, UserStore) {
        let urlSession = StubURLProtocol.session()
        let sessions = SessionManager(storage: InMemoryStorage(), refresher: URLSessionRefresher(baseURL: backend.baseURL, session: urlSession))
        let api = APIClient(baseURL: backend.baseURL, sessions: sessions, urlSession: urlSession)
        let users = UserStore(api: api)
        return (PostStore(api: api, users: users), users)
    }

    @Test func pagesTheFeedByCursorAndFetchesAuthorsOnce() async {
        let backend = FakeBackend { request in
            if request.path == "/users/1" { return .json(profileJSON) }
            let hasCursor = request.query.contains("cursor=c1")
            return .json(hasCursor
                ? #"{"posts":[\#(postJSON(1))],"limit":20,"nextCursor":null}"#
                : #"{"posts":[\#(postJSON(3)),\#(postJSON(2))],"limit":20,"nextCursor":"c1"}"#)
        }
        let (store, users) = await makeStore(backend)
        await store.load(store.feed, source: .feed, reset: true)
        #expect(store.feed.page.ids == [3, 2])
        #expect(store.feed.phase == .loaded)
        await store.loadMore(store.feed, source: .feed)
        #expect(store.feed.page.ids == [3, 2, 1])
        #expect(!store.feed.page.hasMore)
        // Loading more with nothing left is a no-op.
        await store.loadMore(store.feed, source: .feed)
        #expect(backend.count(path: "/posts") == 2)
        try? await Task.sleep(for: .milliseconds(100))
        #expect(users.user(1)?.username == "ada")
        #expect(backend.count(path: "/users/1") == 1)
    }

    @Test func aFailedFirstLoadShowsAnErrorAndARetryRecovers() async {
        let failing = Mutex(true)
        let backend = FakeBackend { request in
            if request.path == "/users/1" { return .json(profileJSON) }
            return failing.withLock { $0 }
                ? .json(#"{"_tag":"X","message":"The server is having a moment"}"#, status: 500)
                : .json(#"{"posts":[\#(postJSON(1))],"limit":20,"nextCursor":null}"#)
        }
        let (store, _) = await makeStore(backend)
        await store.load(store.feed, source: .feed, reset: false)
        #expect(store.feed.phase == .failed("The server is having a moment"))
        failing.withLock { $0 = false }
        await store.load(store.feed, source: .feed, reset: true)
        #expect(store.feed.phase == .loaded)
        #expect(store.feed.page.ids == [1])
    }

    @Test func aFailedRefetchKeepsWhatIsOnScreen() async {
        let failing = Mutex(false)
        let backend = FakeBackend { request in
            if request.path == "/users/1" { return .json(profileJSON) }
            return failing.withLock { $0 } ? .json("{}", status: 500) : .json(#"{"posts":[\#(postJSON(1))],"limit":20,"nextCursor":null}"#)
        }
        let (store, _) = await makeStore(backend)
        await store.load(store.feed, source: .feed, reset: true)
        failing.withLock { $0 = true }
        await store.load(store.feed, source: .feed, reset: false)
        #expect(store.feed.phase == .loaded)
        #expect(store.feed.page.ids == [1])
    }
}
