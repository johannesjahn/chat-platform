import ChatAPI
import Foundation
import Observation

/// A post's comment tree: top-level comments paged by cursor, replies loaded
/// per parent when expanded.
@MainActor
@Observable
final class CommentsModel {
    let postId: Int
    private let api: APIClient
    private let users: UserStore

    private(set) var comments: [Int: Comment] = [:]
    private(set) var top = PageState<Int>()
    private(set) var replies: [Int: PageState<Int>] = [:]
    private(set) var expanded: Set<Int> = []
    private(set) var phase: LoadPhase = .idle
    private(set) var isLoadingMore = false
    private(set) var loadingReplies: Set<Int> = []
    static let pageSize = 20

    init(postId: Int, api: APIClient, users: UserStore) {
        self.postId = postId
        self.api = api
        self.users = users
    }

    func children(of id: Int?) -> [Int] { id.map { replies[$0]?.ids ?? [] } ?? top.ids }
    func hasMoreChildren(of id: Int?) -> Bool { id.map { replies[$0]?.hasMore ?? false } ?? top.hasMore }

    /// Loads (or refreshes) the top level and every expanded thread.
    func reload(reset: Bool = false) async {
        if !top.hasLoadedFirstPage { phase = .loading }
        do {
            let page = try await fetch(parent: nil, cursor: nil)
            if reset || !top.hasLoadedFirstPage {
                top.replace(ids: page.comments.map(\.id), nextCursor: page.nextCursor)
            } else {
                top.mergeHead(ids: page.comments.map(\.id), nextCursor: page.nextCursor)
            }
            phase = .loaded
            for parent in expanded { await loadReplies(of: parent, merging: true) }
            // Drop comments that vanished (deleted elsewhere) from expanded threads.
        } catch {
            let failure = APIError.from(error)
            if failure.isCancelled { return }
            if !top.hasLoadedFirstPage { phase = .failed(failure.message) }
        }
    }

    func loadMore(parent: Int?) async {
        guard hasMoreChildren(of: parent), !isLoadingMore else { return }
        let cursor = parent.map { replies[$0]?.nextCursor } ?? top.nextCursor
        guard let cursor else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        guard let page = try? await fetch(parent: parent, cursor: cursor) else { return }
        if let parent { replies[parent, default: PageState()].append(ids: page.comments.map(\.id), nextCursor: page.nextCursor) }
        else { top.append(ids: page.comments.map(\.id), nextCursor: page.nextCursor) }
    }

    func toggleReplies(of id: Int) async {
        if expanded.contains(id) { expanded.remove(id); return }
        expanded.insert(id)
        await loadReplies(of: id, merging: false)
    }

    func loadReplies(of id: Int, merging: Bool) async {
        loadingReplies.insert(id)
        defer { loadingReplies.remove(id) }
        guard let page = try? await fetch(parent: id, cursor: nil) else { return }
        var state = replies[id] ?? PageState()
        if merging, state.hasLoadedFirstPage { state.mergeHead(ids: page.comments.map(\.id), nextCursor: page.nextCursor) }
        else { state.replace(ids: page.comments.map(\.id), nextCursor: page.nextCursor) }
        replies[id] = state
    }

    private func fetch(parent: Int?, cursor: String?) async throws -> Components.Schemas.CommentsPage {
        let limit = String(Self.pageSize)
        let page: Components.Schemas.CommentsPage
        if let parent {
            page = try await api.call { try await $0.comments_listReplies(path: .init(id: String(parent)), query: .init(cursor: cursor, limit: limit)) }.ok.body.json
        } else {
            page = try await api.call { try await $0.comments_listComments(path: .init(id: String(self.postId)), query: .init(cursor: cursor, limit: limit)) }.ok.body.json
        }
        for comment in page.comments { comments[comment.id] = comment }
        await users.ensure(page.comments.map(\.authorId))
        return page
    }

    // MARK: writes

    /// Posts a comment (top level) or a reply, and shows it straight away.
    func add(_ content: String, replyingTo parent: Int?) async throws {
        let created: Comment
        if let parent {
            created = try reshape(try await api.call { try await $0.comments_createReply(path: .init(id: String(parent)), body: .json(.init(content: content))) }.created.body.json)
            expanded.insert(parent)
            comments[created.id] = created
            if var state = replies[parent] { state.append(ids: [created.id], nextCursor: state.nextCursor); replies[parent] = state }
            else { await loadReplies(of: parent, merging: false) }
            comments[parent]?.replyCount += 1
        } else {
            created = try reshape(try await api.call { try await $0.comments_createComment(path: .init(id: String(postId)), body: .json(.init(content: content))) }.created.body.json)
            comments[created.id] = created
            top.append(ids: [created.id], nextCursor: top.nextCursor)
        }
    }

    func edit(_ id: Int, to content: String) async throws {
        comments[id] = try await api.call { try await $0.comments_updateComment(path: .init(id: String(id)), body: .json(.init(content: content))) }.ok.body.json
    }

    func delete(_ id: Int) async throws {
        _ = try await api.call { try await $0.comments_deleteComment(path: .init(id: String(id))) }
        let parent = comments[id]?.parentCommentId
        top.remove(id)
        if let parent { replies[parent]?.remove(id); comments[parent]?.replyCount -= 1 }
        comments[id] = nil
    }

    func toggleReaction(_ emoji: ReactionEmoji, on id: Int) async throws {
        guard let comment = comments[id] else { return }
        let mine = comment.reactions.first { $0.emoji == emoji.rawValue }?.reactedByMe ?? false
        let state = mine
            ? try await api.call { try await $0.comments_removeCommentReaction(path: .init(id: String(id)), body: .json(.init(emoji: emoji))) }.ok.body.json
            : try await api.call { try await $0.comments_addCommentReaction(path: .init(id: String(id)), body: .json(.init(emoji: emoji))) }.ok.body.json
        comments[id]?.reactions = state.reactions
    }
}
