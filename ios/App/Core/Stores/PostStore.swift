import ChatAPI
import Foundation
import Observation

/// Posts, cached by id, plus the paged lists (the feed, a profile's posts)
/// that reference them. Screens read `post(_:)`, so a reaction or an edit
/// shows up in the feed, the detail page and a profile at once.
@MainActor
@Observable
final class PostStore {
    private(set) var posts: [Int: Post] = [:]
    let feed: PostList

    private let api: APIClient
    private let users: UserStore
    static let pageSize = 20

    init(api: APIClient, users: UserStore) {
        self.api = api
        self.users = users
        feed = PostList()
    }

    func post(_ id: Int) -> Post? { posts[id] }

    func store(_ post: Post) { posts[post.id] = post }

    func remove(_ id: Int) {
        posts[id] = nil
        feed.page.remove(id)
    }

    // MARK: lists

    /// A list of posts from `/posts` (the feed) or `/users/{id}/posts`.
    @MainActor
    @Observable
    final class PostList {
        fileprivate(set) var page = PageState<Int>()
        fileprivate(set) var phase: LoadPhase = .idle
        fileprivate(set) var isLoadingMore = false
        fileprivate(set) var totalCount: Int?
        var loadMoreError: String?
        fileprivate var generation = 0
    }

    /// Loads the first page. `reset` (pull to refresh) replaces the list;
    /// otherwise a background refetch merges, keeping already-loaded pages.
    func load(_ list: PostList, source: PostSource, reset: Bool) async {
        if !list.page.hasLoadedFirstPage { list.phase = .loading }
        list.generation += 1
        let generation = list.generation
        do {
            let result = try await fetchPage(source: source, cursor: nil)
            guard generation == list.generation else { return }
            absorb(result.posts)
            let ids = result.posts.map(\.id)
            if reset || !list.page.hasLoadedFirstPage {
                list.page.replace(ids: ids, nextCursor: result.nextCursor)
            } else {
                list.page.mergeHead(ids: ids, nextCursor: result.nextCursor)
            }
            list.totalCount = result.totalCount
            list.phase = .loaded
        } catch {
            let message = APIError.from(error)
            if message.isCancelled { return }
            // A failed *refetch* of a list already on screen keeps what's there.
            if !list.page.hasLoadedFirstPage { list.phase = .failed(message.message) }
        }
    }

    func loadMore(_ list: PostList, source: PostSource) async {
        guard list.page.hasMore, !list.isLoadingMore, let cursor = list.page.nextCursor else { return }
        list.isLoadingMore = true
        list.loadMoreError = nil
        defer { list.isLoadingMore = false }
        do {
            let result = try await fetchPage(source: source, cursor: cursor)
            absorb(result.posts)
            list.page.append(ids: result.posts.map(\.id), nextCursor: result.nextCursor)
        } catch {
            list.loadMoreError = APIError.from(error).message
        }
    }

    struct PageResult {
        var posts: [Post]
        var nextCursor: String?
        var totalCount: Int?
    }

    private func fetchPage(source: PostSource, cursor: String?) async throws -> PageResult {
        let limit = String(Self.pageSize)
        switch source {
        case .feed:
            let page = try await api.call { try await $0.posts_listPosts(query: .init(cursor: cursor, limit: limit)) }.ok.body.json
            return PageResult(posts: page.posts, nextCursor: page.nextCursor, totalCount: nil)
        case .user(let id):
            let page = try await api.call {
                try await $0.users_listUserPosts(path: .init(id: String(id)), query: .init(cursor: cursor, limit: limit))
            }.ok.body.json
            return PageResult(posts: page.posts, nextCursor: page.nextCursor, totalCount: page.totalCount)
        }
    }

    private func absorb(_ batch: [Post]) {
        for post in batch { posts[post.id] = post }
        Task { await users.ensure(batch.map(\.authorId)) }
    }

    // MARK: single post

    /// Fetches one post (the detail page, a notification target). A 404 drops
    /// it from every list.
    @discardableResult
    func fetch(_ id: Int) async throws -> Post {
        do {
            let post = try await api.call { try await $0.posts_getPost(path: .init(id: String(id))) }.ok.body.json
            absorb([post])
            return post
        } catch let error as APIError where error.isNotFound {
            remove(id)
            throw error
        }
    }

    // MARK: writes

    func create(contentType: Components.Schemas.PostContentType, content: String, attachmentId: Int? = nil) async throws -> Post {
        let created = try await api.call {
            try await $0.posts_createPost(body: .json(.init(contentType: contentType, content: content, attachmentId: attachmentId)))
        }.created.body.json
        let post: Post = try reshape(created)
        posts[post.id] = post
        feed.page.prepend(post.id)
        return post
    }

    func update(_ id: Int, contentType: Components.Schemas.PostContentType, content: String, attachmentId: Int? = nil) async throws {
        let updated = try await api.call {
            try await $0.posts_updatePost(path: .init(id: String(id)), body: .json(.init(contentType: contentType, content: content, attachmentId: attachmentId)))
        }.ok.body.json
        posts[id] = updated
    }

    func delete(_ id: Int) async throws {
        _ = try await api.call { try await $0.posts_deletePost(path: .init(id: String(id))) }
        remove(id)
    }

    /// Adds or removes the caller's reaction, applying the server's answer.
    func toggleReaction(_ emoji: ReactionEmoji, on id: Int) async throws {
        guard let post = posts[id] else { return }
        let mine = post.reactions.first { $0.emoji == emoji.rawValue }?.reactedByMe ?? false
        let state = mine
            ? try await api.call { try await $0.comments_removePostReaction(path: .init(id: String(id)), body: .json(.init(emoji: emoji))) }.ok.body.json
            : try await api.call { try await $0.comments_addPostReaction(path: .init(id: String(id)), body: .json(.init(emoji: emoji))) }.ok.body.json
        posts[id]?.reactions = state.reactions
    }

    // MARK: realtime

    /// `reaction_changed` counts for a post: keeps each emoji's `reactedByMe`
    /// (an event never carries it) and drops emoji nobody uses.
    func applyReactionCounts(_ counts: [RealtimeEvent.ReactionCount], to id: Int) {
        guard let post = posts[id] else { return }
        posts[id]?.reactions = Self.mergeReactionCounts(post.reactions, counts)
    }

    nonisolated static func mergeReactionCounts(_ previous: [ReactionSummary], _ counts: [RealtimeEvent.ReactionCount]) -> [ReactionSummary] {
        counts.filter { $0.count > 0 }.map { count in
            ReactionSummary(
                emoji: count.emoji, count: count.count,
                reactedByMe: previous.first { $0.emoji == count.emoji }?.reactedByMe ?? false
            )
        }
    }
}

enum PostSource: Hashable, Sendable {
    case feed
    case user(Int)
}
