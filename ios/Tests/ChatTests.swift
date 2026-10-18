import Foundation
import Synchronization
import Testing

@testable import ChatPlatform

// MARK: - fixtures

func messageJSON(_ id: Int, chat: Int = 1, sender: Int = 2, content: String? = nil, updatedAt: Int? = nil,
                 reads: [Int] = [], reactions: String = "[]", pinned: Bool = false) -> String {
    #"{"id":\#(id),"chatId":\#(chat),"senderId":\#(sender),"contentType":"text","content":"\#(content ?? "message \(id)")","attachment":null,"parentMessage":null,"createdAt":\#(id * 1000),"updatedAt":\#(updatedAt ?? id * 1000),"readByUserIds":\#(reads),"reactions":\#(reactions),"pinned":\#(pinned),"starred":false,"forwardedFrom":null}"#
}

func makeMessage(_ id: Int, content: String? = nil, sender: Int = 2, createdAt: Int? = nil) -> Message {
    var json = messageJSON(id, sender: sender, content: content)
    if let createdAt { json = json.replacingOccurrences(of: #""createdAt":\#(id * 1000)"#, with: #""createdAt":\#(createdAt)"#) }
    return try! JSONDecoder().decode(Message.self, from: Data(json.utf8))
}

func pageJSON(_ ids: [Int], hasEarlier: Bool, hasNewer: Bool = false, chat: Int = 1, content: (Int) -> String? = { _ in nil }) -> String {
    let messages = ids.map { messageJSON($0, chat: chat, content: content($0)) }.joined(separator: ",")
    let earliest = ids.first.map { #""e\#($0)""# } ?? "null"
    let latest = ids.last.map { #""l\#($0)""# } ?? "null"
    return #"{"messages":[\#(messages)],"limit":30,"hasEarlier":\#(hasEarlier),"hasNewer":\#(hasNewer),"earliestCursor":\#(earliest),"latestCursor":\#(latest)}"#
}

func page(_ ids: [Int], hasEarlier: Bool, hasNewer: Bool = false, content: (Int) -> String? = { _ in nil }) -> MessagePage {
    MessagePage(messages: ids.map { makeMessage($0, content: content($0)) }, hasEarlier: hasEarlier, hasNewer: hasNewer,
                earliestCursor: ids.first.map { "e\($0)" }, latestCursor: ids.last.map { "l\($0)" })
}

func chatJSON(_ id: Int, version: Int = 1, unread: Int = 0, type: String = "direct", title: String? = nil) -> String {
    let title = title.map { #""\#($0)""# } ?? "null"
    return #"{"id":\#(id),"type":"\#(type)","title":\#(title),"createdBy":1,"createdAt":1000,"updatedAt":1000,"version":\#(version),"participants":[{"userId":1,"username":"ada","displayName":"Ada","avatarUrl":null,"avatarVariants":null,"role":"owner","statusText":null,"statusEmoji":null,"statusExpiresAt":null},{"userId":2,"username":"bo","displayName":null,"avatarUrl":null,"avatarVariants":null,"role":"member","statusText":null,"statusEmoji":null,"statusExpiresAt":null}],"lastMessage":null,"unreadCount":\#(unread),"avatarVariants":null}"#
}

@MainActor
private func makeAPI(_ backend: FakeBackend) -> APIClient {
    let urlSession = StubURLProtocol.session()
    let sessions = SessionManager(storage: InMemoryStorage(), refresher: URLSessionRefresher(baseURL: backend.baseURL, session: urlSession))
    return APIClient(baseURL: backend.baseURL, sessions: sessions, urlSession: urlSession)
}

// MARK: - pure rules

@Suite struct ChatVersionTests {
    @Test func classifiesAgainstTheHighestVersionSeen() {
        var versions = ChatVersions()
        #expect(versions.classify(1, 5) == .sequential) // nothing known yet
        versions.record(1, 5)
        #expect(versions.classify(1, 5) == .stale)
        #expect(versions.classify(1, 4) == .stale)
        #expect(versions.classify(1, 6) == .sequential)
        #expect(versions.classify(1, 8) == .gap)
        versions.record(1, 3) // never moves backwards
        #expect(versions.version(of: 1) == 5)
        versions.forget(1)
        #expect(versions.classify(1, 2) == .sequential)
    }
}

@Suite struct MessageListTests {
    @Test func pagesBackwardAndForwardWithoutDuplicates() {
        var list = MessageList()
        list.replace(with: page([10, 11, 12], hasEarlier: true))
        list.prepend(page([8, 9, 10], hasEarlier: false)) // overlaps by one
        #expect(list.ids == [8, 9, 10, 11, 12])
        #expect(!list.hasEarlier)
        #expect(list.earliestCursor == "e8")

        var history = MessageList()
        history.replace(with: page([1, 2], hasEarlier: false, hasNewer: true))
        history.append(page([2, 3, 4], hasEarlier: true, hasNewer: false))
        #expect(history.ids == [1, 2, 3, 4])
        #expect(!history.hasNewer)
        #expect(history.latestCursor == "l4")
    }

    @Test func aRefetchedNewestPageMergesOverTheTailAndKeepsOlderPages() {
        var list = MessageList()
        list.replace(with: page([20, 21, 22, 23], hasEarlier: true))
        list.prepend(page([18, 19], hasEarlier: true))
        // 21 was edited, 22 deleted, 24 arrived.
        list.mergeLatest(page([21, 23, 24], hasEarlier: true) { $0 == 21 ? "edited" : nil })
        #expect(list.ids == [18, 19, 20, 21, 23, 24])
        #expect(list.message(21)?.content == "edited")
        #expect(list.earliestCursor == "e18") // older pages untouched
        #expect(list.latestCursor == "l24")
        #expect(list.hasEarlier)
    }

    @Test func aRefetchThatDoesNotReachWhatIsLoadedReanchors() {
        var list = MessageList()
        list.replace(with: page([1, 2, 3], hasEarlier: false))
        list.mergeLatest(page([50, 51], hasEarlier: true)) // a gap after 3
        #expect(list.ids == [50, 51])
        #expect(list.hasEarlier)
        #expect(list.earliestCursor == "e50")
    }

    @Test func aRefetchOfTheWholeConversationReplaces() {
        var list = MessageList()
        list.replace(with: page([1, 2, 3], hasEarlier: false))
        list.mergeLatest(page([2, 3], hasEarlier: false)) // 1 was deleted
        #expect(list.ids == [2, 3])
        list.mergeLatest(page([], hasEarlier: false)) // everything deleted
        #expect(list.ids.isEmpty)
    }

    @Test func upsertReplacesOrAppendsButNotIntoAHistoryWindow() {
        var list = MessageList()
        list.replace(with: page([1, 2], hasEarlier: false))
        list.upsert(makeMessage(3))
        list.upsert(makeMessage(3)) // a second copy (the realtime refetch) is a no-op
        list.upsert(makeMessage(2, content: "changed"))
        #expect(list.ids == [1, 2, 3])
        #expect(list.message(2)?.content == "changed")

        var history = MessageList()
        history.replace(with: page([1, 2], hasEarlier: false, hasNewer: true))
        history.upsert(makeMessage(99))
        #expect(history.ids == [1, 2]) // would leave a hole otherwise
    }
}

@MainActor
@Suite struct TypingStoreTests {
    final class Clock { var now = Date(timeIntervalSince1970: 1_000) }

    @Test func entriesLapseAfterTheTTLUnlessRenewed() {
        let clock = Clock()
        let typing = TypingStore(now: { clock.now }, schedulesExpiry: false)
        typing.note(chatId: 1, userId: 7, name: "Ada")
        #expect(typing.typists(in: 1).map(\.name) == ["Ada"])
        #expect(typing.typists(in: 2).isEmpty)

        clock.now += 3
        typing.note(chatId: 1, userId: 7, name: "Ada") // renewed
        clock.now += 3
        #expect(typing.typists(in: 1).count == 1) // 3s after the renewal
        clock.now += 1.5
        #expect(typing.typists(in: 1).isEmpty) // 4.5s after it
        typing.prune()
        #expect(typing.typists(in: 1).isEmpty)
    }

    @Test func aMessageFromThemClearsItAtOnce() {
        let typing = TypingStore(schedulesExpiry: false)
        typing.note(chatId: 1, userId: 7, name: "Ada")
        typing.note(chatId: 1, userId: 8, name: "Bo")
        #expect(TypingStore.sentence(for: typing.typists(in: 1)) == "Ada and Bo are typing…")
        typing.clear(chatId: 1, userId: 7)
        #expect(TypingStore.sentence(for: typing.typists(in: 1)) == "Bo is typing…")
        typing.clear(chatId: 1, userId: 8)
        #expect(TypingStore.sentence(for: typing.typists(in: 1)) == nil)
    }

    @Test func expiresByItselfWithTheRealClock() async {
        let typing = TypingStore()
        typing.note(chatId: 3, userId: 1, name: "Ada")
        #expect(!typing.typists(in: 3).isEmpty)
        try? await Task.sleep(for: .seconds(TypingStore.ttl + 0.3))
        #expect(typing.typists(in: 3).isEmpty)
    }
}

@Suite struct ChatPresentationTests {
    @Test func threadRowsBreakOnDaysSendersAndPauses() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let day = 86_400_000
        let messages = [
            makeMessage(1, sender: 2, createdAt: day * 100),
            makeMessage(2, sender: 2, createdAt: day * 100 + 60_000), // same run
            makeMessage(3, sender: 3, createdAt: day * 100 + 120_000), // another sender
            makeMessage(4, sender: 3, createdAt: day * 100 + 120_000 + ThreadRow.runGap + 1), // a pause
            makeMessage(5, sender: 3, createdAt: day * 101), // the next day
        ]
        let rows = ThreadRow.rows(messages, isGroup: true, me: 3, now: Date(timeIntervalSince1970: 0), calendar: calendar)
        #expect(rows.map { $0.daySeparator != nil } == [true, false, false, false, true])
        #expect(rows.map(\.startsRun) == [true, false, true, true, true])
        // Names show for others' runs in a group, never for my own messages.
        #expect(rows.map(\.showsSender) == [true, false, false, false, false])
        #expect(ThreadRow.rows(messages, isGroup: false, me: 3, calendar: calendar).allSatisfy { !$0.showsSender })
    }

    @Test func inviteCodesComeFromCodesOrLinks() {
        #expect(JoinChatView.code(from: "  abc123 ") == "abc123")
        #expect(JoinChatView.code(from: "https://chat.example.com/chats/join/Xy-9_z") == "Xy-9_z")
        #expect(JoinChatView.code(from: "https://chat.example.com/chats") == nil)
        #expect(JoinChatView.code(from: "not a code!") == nil)
        #expect(JoinChatView.code(from: "") == nil)
    }

    @Test func permissionsFollowTheGroupRoles() throws {
        let group = try JSONDecoder().decode(Chat.self, from: Data(chatJSON(1, type: "group", title: "G").utf8))
        let owner = try JSONDecoder().decode(User.self, from: Data(userJSON.utf8)) // id 1, the owner
        let ownerRights = ChatPermissions(chat: group, me: owner)
        #expect(ownerRights.canManage && ownerRights.canManageRoles && !ownerRights.canClaimOwnership)
        #expect(ownerRights.canRemove(group.participants[1], in: group, me: owner))
        #expect(!ownerRights.canRemove(group.participants[0], in: group, me: owner)) // not yourself

        var member = owner
        member.id = 2
        let memberRights = ChatPermissions(chat: group, me: member)
        #expect(!memberRights.canManage && !memberRights.canManageRoles)
        #expect(!memberRights.canRemove(group.participants[0], in: group, me: member))

        let direct = try JSONDecoder().decode(Chat.self, from: Data(chatJSON(2).utf8))
        #expect(!ChatPermissions(chat: direct, me: owner).canManage) // nothing to manage in a direct chat
        #expect(direct.displayName(me: 1) == "bo")
    }
}

// MARK: - stores against a fake backend

@MainActor
@Suite struct MessageStoreTests {
    @Test func opensOnTheNewestPageAndPagesBackByCursor() async throws {
        let backend = FakeBackend { request in
            if request.query.contains("before=e40") { return .json(pageJSON(Array(10...39), hasEarlier: true)) }
            if request.query.contains("before=e10") { return .json(pageJSON(Array(1...9), hasEarlier: false)) }
            return .json(pageJSON(Array(40...69), hasEarlier: true))
        }
        let store = MessageStore(api: makeAPI(backend))
        try await store.refresh(1)
        let window = store.window(1)
        #expect(window.list.ids == Array(40...69))
        #expect(backend.requests.last?.query.contains("limit=30") == true)
        await store.loadEarlier(1)
        await store.loadEarlier(1)
        #expect(window.list.ids == Array(1...69))
        #expect(!window.list.hasEarlier)
        await store.loadEarlier(1) // nothing left: no request
        #expect(backend.requests.count == 3)
    }

    @Test func reopeningKeepsLoadedHistoryAndMergesTheNewestPage() async throws {
        let reopened = Mutex(false)
        let backend = FakeBackend { request in
            if request.query.contains("before=") { return .json(pageJSON([1, 2], hasEarlier: false)) }
            if reopened.withLock({ $0 }) { return .json(pageJSON([3, 4, 5], hasEarlier: true) { $0 == 4 ? "edited" : nil }) }
            return .json(pageJSON([3, 4], hasEarlier: true))
        }
        let store = MessageStore(api: makeAPI(backend))
        try await store.refresh(1)
        await store.loadEarlier(1)
        reopened.withLock { $0 = true }
        try await store.refresh(1) // a realtime nudge, or opening the chat again
        #expect(store.window(1).list.ids == [1, 2, 3, 4, 5])
        #expect(store.window(1).list.message(4)?.content == "edited")
    }

    @Test func aSendShowsPendingThenTheServerCopy() async throws {
        let backend = FakeBackend { request in
            if request.method == "POST" { return .json(messageJSON(9, sender: 1, content: "hi"), status: 201) }
            return .json(pageJSON([7, 8], hasEarlier: false))
        }
        let store = MessageStore(api: makeAPI(backend))
        var sent: [Int] = []
        store.onSent = { sent.append($0.id) }
        try await store.refresh(1)
        let pending = PendingMessage(clientId: "c-1", chatId: 1, contentType: .text, content: "hi", createdAt: Date())
        await store.send(pending)
        let window = store.window(1)
        #expect(window.pending.isEmpty)
        #expect(window.list.ids == [7, 8, 9])
        #expect(sent == [9])
        let body = try #require(backend.requests.first { $0.method == "POST" }?.body)
        let json = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        #expect(json?["clientId"] as? String == "c-1")
    }

    @Test func aFailedSendStaysWithRetryAndRetriesWithTheSameClientId() async throws {
        let online = Mutex(false)
        let backend = FakeBackend { request in
            guard request.method == "POST" else { return .json(pageJSON([], hasEarlier: false)) }
            if !online.withLock({ $0 }) { return .fail(.notConnectedToInternet) }
            return .json(messageJSON(5, sender: 1, content: "later"), status: 201)
        }
        let store = MessageStore(api: makeAPI(backend))
        try await store.refresh(1)
        await store.send(PendingMessage(clientId: "c-2", chatId: 1, contentType: .text, content: "later", createdAt: Date()))
        let window = store.window(1)
        #expect(window.pending.count == 1)
        #expect(window.pending.first?.state == .failed("Not sent — you're offline."))

        online.withLock { $0 = true }
        await store.retryFailed() // what a reconnect does
        #expect(window.pending.isEmpty)
        #expect(window.list.ids == [5])
        let clientIds = backend.requests.filter { $0.method == "POST" }.compactMap {
            (try? JSONSerialization.jsonObject(with: $0.body) as? [String: Any])?["clientId"] as? String
        }
        #expect(clientIds == ["c-2", "c-2"])
    }

    @Test func jumpingToAnOldMessagePagesBackUntilItIsLoaded() async {
        let backend = FakeBackend { request in
            if request.query.contains("before=e20") { return .json(pageJSON(Array(10...19), hasEarlier: true)) }
            if request.query.contains("before=e10") { return .json(pageJSON(Array(1...9), hasEarlier: false)) }
            return .json(pageJSON(Array(20...29), hasEarlier: true))
        }
        let store = MessageStore(api: makeAPI(backend))
        try? await store.refresh(1)
        #expect(await store.loadUntil(1, contains: 4))
        #expect(!(await store.loadUntil(1, contains: 999)))
    }
}

@MainActor
@Suite struct ChatRealtimeTests {
    private func makeEnvironment(_ backend: FakeBackend) -> AppEnvironment {
        AppEnvironment(
            config: AppConfig(apiBaseURL: backend.baseURL),
            options: LaunchOptions(uiTesting: false, injectedSession: nil, appearance: nil),
            storage: InMemoryStorage(),
            urlSession: StubURLProtocol.session()
        )
    }

    @Test func chatUpdatesSkipStaleVersionsAndNudgeTheOpenConversation() async throws {
        let backend = FakeBackend { request in
            if request.path == "/chats/1" { return .json(chatJSON(1, version: 4)) }
            return .json(pageJSON([1], hasEarlier: false))
        }
        let env = makeEnvironment(backend)
        _ = try await env.chats.fetch(1) // version 4 known
        let window = env.messages.window(1)
        let chatsToken = env.invalidations.token(.chats)

        env.handle(.chatUpdated(chatId: 1, version: 4)) // a redelivery
        #expect(window.revision == 0)
        #expect(env.invalidations.token(.chats) == chatsToken)

        env.handle(.chatUpdated(chatId: 1, version: 7)) // a gap still refetches
        #expect(window.revision == 1)
        #expect(env.invalidations.token(.chats) == chatsToken + 1)
        env.handle(.chatUpdated(chatId: 1, version: 7))
        #expect(window.revision == 1)
    }

    @Test func anotherAccountSigningInGetsFreshStores() async throws {
        let backend = FakeBackend { request in
            if request.path == "/chats/1" { return .json(chatJSON(1)) }
            return .json(pageJSON([1], hasEarlier: false))
        }
        let env = makeEnvironment(backend)
        let ada = try JSONDecoder().decode(User.self, from: Data(userJSON.utf8))
        var bob = ada
        bob.id = 2
        env.accountWillSignIn(ada)
        _ = try await env.chats.fetch(1)
        let messages = env.messages
        env.router.push(.chat(1, messageId: nil))

        // The same account again (a token refresh, signing back in) keeps them.
        env.accountWillSignIn(ada)
        #expect(env.chats.chats[1] != nil)
        #expect(env.messages === messages)

        env.accountWillSignIn(bob)
        #expect(env.chats.chats.isEmpty)
        #expect(env.messages !== messages)
        #expect(env.router.path(for: .feed).isEmpty)
        // The new stores are wired like the launch ones.
        let chatsToken = env.invalidations.token(.chats)
        env.messages.onSent(try JSONDecoder().decode(Message.self, from: Data(messageJSON(1).utf8)))
        #expect(env.invalidations.token(.chats) == chatsToken + 1)
    }

    @Test func deletionTypingReactionsAndPinsLandInTheStores() async throws {
        let backend = FakeBackend { _ in
            .json(pageJSON([5], hasEarlier: false))
        }
        let env = makeEnvironment(backend)
        try await env.messages.refresh(1)

        env.handle(.typing(chatId: 1, userId: 2, username: "bo", displayName: nil))
        #expect(env.typing.typists(in: 1).map(\.name) == ["bo"])

        env.handle(.reactionChanged(target: .message, targetId: 5, chatId: 1, reactions: [.init(emoji: "👍", count: 2)]))
        #expect(env.messages.window(1).list.message(5)?.reactions.first?.count == 2)

        env.handle(.messagePinChanged(chatId: 1, messageId: 5, pinned: true))
        #expect(env.messages.window(1).list.message(5)?.pinned == true)
        #expect(env.messages.window(1).pinsRevision == 1)

        env.handle(.chatDeleted(chatId: 1))
        #expect(env.chats.missing.contains(1))
        #expect(env.messages.existingWindow(1) == nil)
    }

    @Test func theUnreadBadgeSumsTheList() async {
        let backend = FakeBackend { _ in
            .json(#"{"chats":[\#(chatJSON(1, unread: 2)),\#(chatJSON(2, unread: 0)),\#(chatJSON(3, unread: 5))],"limit":20,"nextCursor":null}"#)
        }
        let store = ChatStore(api: makeAPI(backend))
        await store.loadList(reset: true)
        #expect(store.totalUnread == 7)
        #expect(store.list.ids == [1, 2, 3])
    }
}
