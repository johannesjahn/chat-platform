import ChatAPI
import Foundation
import Observation

typealias SnippetSegment = Components.Schemas.SearchSnippetSegment
typealias UserSearchResult = Components.Schemas.UserSearchResult
typealias PostSearchResult = Components.Schemas.PostSearchResult
typealias CommentSearchResult = Components.Schemas.CommentSearchResult
typealias MessageSearchResult = Components.Schemas.MessageSearchResult
typealias MessageSearchChat = Components.Schemas.MessageSearchChat

/// Which results the search screen shows: everything (one `GET /search`) or
/// one kind, paged through its own endpoint.
enum SearchScope: String, CaseIterable, Hashable, Sendable {
    case all, users, posts, comments, messages

    var title: String {
        switch self {
        case .all: "All"
        case .users: "People"
        case .posts: "Posts"
        case .comments: "Comments"
        case .messages: "Messages"
        }
    }

    var sectionTitle: String {
        switch self {
        case .all: "All"
        case .users: "People"
        case .posts: "Posts"
        case .comments: "Comments & replies"
        case .messages: "Messages"
        }
    }

    var symbol: String {
        switch self {
        case .all: "square.grid.2x2"
        case .users: "person.2"
        case .posts: "doc.text"
        case .comments: "bubble.left"
        case .messages: "bubble.left.and.bubble.right"
        }
    }
}

/// One result row, whatever its kind. The server decides what matched and
/// sends the highlighted snippet; nothing here re-searches.
enum SearchHit: Identifiable, Hashable, Sendable {
    case user(UserSearchResult)
    case post(PostSearchResult)
    case comment(CommentSearchResult)
    case message(MessageSearchResult)

    var id: String {
        switch self {
        case .user(let r): "user.\(r.user.id)"
        case .post(let r): "post.\(r.id)"
        case .comment(let r): "comment.\(r.id)"
        case .message(let r): "message.\(r.id)"
        }
    }

    /// Where tapping the row goes.
    var route: Route {
        switch self {
        case .user(let r): .profile(r.user.id)
        case .post(let r): .post(r.id)
        case .comment(let r): .post(r.postId)
        case .message(let r): .chat(r.chatId, messageId: r.id)
        }
    }

    var snippet: [SnippetSegment] {
        switch self {
        case .user(let r): r.snippet
        case .post(let r): r.snippet
        case .comment(let r): r.snippet
        case .message(let r): r.snippet
        }
    }
}

/// One kind's results for one query, paged by cursor.
struct SearchList: Sendable, Equatable {
    var page = PageState<String>()
    var hits: [String: SearchHit] = [:]
    var phase: LoadPhase = .idle
    var isLoadingMore = false
    var loadMoreError: String?

    var items: [SearchHit] { page.ids.compactMap { hits[$0] } }

    mutating func absorb(_ batch: [SearchHit]) {
        for hit in batch { hits[hit.id] = hit }
    }
}

/// The search screen's state: the debounced query, the "All" overview and
/// each kind's own paged list. Mirrors web/src/routes/search.tsx — the same
/// minimum length, debounce, preview size and page size.
@MainActor
@Observable
final class SearchModel {
    /// `MIN_SEARCH_QUERY_LENGTH` (src/Api.ts): shorter isn't sent at all.
    static let minQueryLength = 2
    /// `MIN_FRAGMENT_QUERY_LENGTH`: from here a match can sit inside a word.
    static let minFragmentLength = 3
    /// `MIN_USER_SEARCH_QUERY_LENGTH`: below it (non-admins) people are empty.
    static let minPeopleQueryLength = 3
    static let allLimit = 5
    static let pageSize = 20
    static let defaultDebounce: Duration = .milliseconds(180)

    var scope: SearchScope = .all
    /// The query the results on screen belong to (trimmed, debounced).
    private(set) var query = ""
    private(set) var all: Components.Schemas.SearchAllPage?
    private(set) var allPhase: LoadPhase = .idle
    /// True while a newer query's overview is in flight over the old one —
    /// the old results stay, dimmed, instead of collapsing to a spinner.
    private(set) var isRefreshingAll = false
    private(set) var lists: [SearchScope: SearchList] = [:]
    /// The chats message hits belong to (group title / other participant).
    private(set) var chats: [Int: MessageSearchChat] = [:]

    private let api: APIClient
    private let debounce: Duration
    private var allGeneration = 0

    init(api: APIClient, debounce: Duration = SearchModel.defaultDebounce) {
        self.api = api
        self.debounce = debounce
    }

    var isReady: Bool { query.count >= Self.minQueryLength }

    func list(_ scope: SearchScope) -> SearchList { lists[scope] ?? SearchList() }

    static func normalize(_ text: String) -> String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// Called with every keystroke (from a `.task(id:)`, so a newer keystroke
    /// cancels this one mid-wait). Too-short text clears the results without
    /// a request; anything else waits out the debounce, then searches.
    func update(text: String, scope: SearchScope) async {
        let next = Self.normalize(text)
        self.scope = scope
        if next.count < Self.minQueryLength {
            clear()
            return
        }
        if next != query {
            do { try await Task.sleep(for: debounce) } catch { return }
            guard !Task.isCancelled else { return }
            if next != query {
                query = next
                lists = [:]
                chats = [:]
            }
        }
        await load(scope)
    }

    private func clear() {
        allGeneration += 1
        query = ""
        all = nil
        allPhase = .idle
        isRefreshingAll = false
        lists = [:]
        chats = [:]
    }

    /// Loads what `scope` shows for the current query, unless it's there.
    func load(_ scope: SearchScope, force: Bool = false) async {
        guard isReady else { return }
        if scope == .all {
            await loadAll(force: force)
        } else if force || !list(scope).page.hasLoadedFirstPage {
            await loadFirstPage(scope)
        }
    }

    private func loadAll(force: Bool) async {
        let q = query
        if !force, allPhase == .loaded, allQuery == q { return }
        allGeneration += 1
        let generation = allGeneration
        if all == nil { allPhase = .loading } else { isRefreshingAll = true }
        defer { if generation == allGeneration { isRefreshingAll = false } }
        do {
            let page = try await api.call {
                try await $0.search_searchAll(query: .init(q: q, limit: String(Self.allLimit)))
            }.ok.body.json
            guard generation == allGeneration else { return }
            all = page
            allQuery = q
            for chat in page.messages.chats { chats[chat.id] = chat }
            allPhase = .loaded
        } catch {
            let failure = APIError.from(error)
            guard generation == allGeneration, !failure.isCancelled else { return }
            all = nil
            allPhase = .failed(failure.message)
        }
    }

    private var allQuery: String?

    private func loadFirstPage(_ scope: SearchScope) async {
        let q = query
        var list = SearchList()
        list.phase = .loading
        lists[scope] = list
        do {
            let (hits, next) = try await fetch(scope, query: q, cursor: nil)
            guard q == query else { return }
            list.absorb(hits)
            list.page.replace(ids: hits.map(\.id), nextCursor: next)
            list.phase = .loaded
            lists[scope] = list
        } catch {
            let failure = APIError.from(error)
            guard q == query, !failure.isCancelled else {
                if q == query { lists[scope] = nil }
                return
            }
            list.phase = .failed(failure.message)
            lists[scope] = list
        }
    }

    func loadMore(_ scope: SearchScope) async {
        guard var list = lists[scope], list.page.hasMore, !list.isLoadingMore, let cursor = list.page.nextCursor else { return }
        let q = query
        list.isLoadingMore = true
        list.loadMoreError = nil
        lists[scope] = list
        do {
            let (hits, next) = try await fetch(scope, query: q, cursor: cursor)
            guard q == query, var current = lists[scope] else { return }
            current.absorb(hits)
            current.page.append(ids: hits.map(\.id), nextCursor: next)
            current.isLoadingMore = false
            lists[scope] = current
        } catch {
            guard q == query, var current = lists[scope] else { return }
            current.isLoadingMore = false
            current.loadMoreError = APIError.from(error).message
            lists[scope] = current
        }
    }

    private func fetch(_ scope: SearchScope, query q: String, cursor: String?) async throws -> ([SearchHit], String?) {
        let limit = String(Self.pageSize)
        switch scope {
        case .all:
            return ([], nil)
        case .users:
            let page = try await api.call { try await $0.search_searchUsers(query: .init(q: q, cursor: cursor, limit: limit)) }.ok.body.json
            return (page.results.map(SearchHit.user), page.nextCursor)
        case .posts:
            let page = try await api.call { try await $0.search_searchPosts(query: .init(q: q, cursor: cursor, limit: limit)) }.ok.body.json
            return (page.results.map(SearchHit.post), page.nextCursor)
        case .comments:
            let page = try await api.call { try await $0.search_searchComments(query: .init(q: q, cursor: cursor, limit: limit)) }.ok.body.json
            return (page.results.map(SearchHit.comment), page.nextCursor)
        case .messages:
            let page = try await api.call { try await $0.search_searchMessages(query: .init(q: q, cursor: cursor, limit: limit)) }.ok.body.json
            for chat in page.chats { chats[chat.id] = chat }
            return (page.results.map(SearchHit.message), page.nextCursor)
        }
    }

    // MARK: the overview

    /// One section of the "All" overview: its preview rows, and whether its
    /// own tab holds more than the preview.
    func overview(_ scope: SearchScope) -> (hits: [SearchHit], hasMore: Bool) {
        guard let all else { return ([], false) }
        switch scope {
        case .all: return ([], false)
        case .users: return (all.users.results.map(SearchHit.user), all.users.nextCursor != nil)
        case .posts: return (all.posts.results.map(SearchHit.post), all.posts.nextCursor != nil)
        case .comments: return (all.comments.results.map(SearchHit.comment), all.comments.nextCursor != nil)
        case .messages: return (all.messages.results.map(SearchHit.message), all.messages.nextCursor != nil)
        }
    }

    var overviewIsEmpty: Bool {
        guard let all else { return false }
        return all.users.results.isEmpty && all.posts.results.isEmpty && all.comments.results.isEmpty && all.messages.results.isEmpty
    }

    /// A message hit's chat, named as the web names it: the group's title,
    /// else the other person in a direct chat.
    func chatName(_ chatId: Int, viewer: Int?) -> String {
        guard let chat = chats[chatId] else { return "Chat" }
        if chat._type == .group { return chat.title ?? "Group chat" }
        guard let other = chat.participants.first(where: { $0.userId != viewer }) else { return "Direct chat" }
        return other.displayName?.isEmpty == false ? other.displayName! : "@\(other.username)"
    }
}
