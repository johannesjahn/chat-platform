import ChatAPI
import Foundation
import Observation

/// One page from `GET /chats/{id}/messages`, oldest first.
struct MessagePage: Sendable, Equatable {
    var messages: [Message]
    var hasEarlier: Bool
    var hasNewer: Bool
    var earliestCursor: String?
    var latestCursor: String?

    init(messages: [Message], hasEarlier: Bool, hasNewer: Bool, earliestCursor: String?, latestCursor: String?) {
        self.messages = messages
        self.hasEarlier = hasEarlier
        self.hasNewer = hasNewer
        self.earliestCursor = earliestCursor
        self.latestCursor = latestCursor
    }

    init(_ page: Components.Schemas.MessagesPage) {
        self.init(messages: page.messages, hasEarlier: page.hasEarlier, hasNewer: page.hasNewer,
                  earliestCursor: page.earliestCursor, latestCursor: page.latestCursor)
    }
}

/// The loaded slice of a conversation, oldest first, with the server's cursors
/// bounding it. It can grow both ways — older pages on scroll-up (`before`),
/// newer ones after a jump back in history (`after`) — and a refetch of the
/// newest page merges over its tail. A pure value, so the rules are unit-tested.
struct MessageList: Sendable, Equatable {
    private(set) var messages: [Message] = []
    private(set) var earliestCursor: String?
    private(set) var latestCursor: String?
    private(set) var hasEarlier = false
    /// True after a jump into history: the newest messages aren't loaded.
    private(set) var hasNewer = false
    private(set) var hasLoaded = false

    var ids: [Int] { messages.map(\.id) }
    var newestId: Int? { messages.last?.id }
    func message(_ id: Int) -> Message? { messages.first { $0.id == id } }
    func contains(_ id: Int) -> Bool { messages.contains { $0.id == id } }

    /// A fresh window (first open, or a re-anchor).
    mutating func replace(with page: MessagePage) {
        messages = Self.sortedUnique(page.messages)
        earliestCursor = page.earliestCursor
        latestCursor = page.latestCursor
        hasEarlier = page.hasEarlier
        hasNewer = page.hasNewer
        hasLoaded = true
    }

    /// An older page (`before`), above what's loaded.
    mutating func prepend(_ page: MessagePage) {
        messages = Self.sortedUnique(page.messages + messages)
        if page.earliestCursor != nil || page.messages.isEmpty { earliestCursor = page.earliestCursor ?? earliestCursor }
        hasEarlier = page.hasEarlier
    }

    /// A newer page (`after`), below what's loaded.
    mutating func append(_ page: MessagePage) {
        messages = Self.sortedUnique(messages + page.messages)
        if let cursor = page.latestCursor { latestCursor = cursor }
        hasNewer = page.hasNewer
    }

    /// The newest page, refetched because something changed. Its range is
    /// authoritative — edits, deletions, reactions and read receipts in it all
    /// land — while anything loaded above it stays put, so the reader keeps
    /// their place. If it doesn't reach what's loaded (more arrived than one
    /// page holds), or it is the whole conversation, it replaces the window.
    mutating func mergeLatest(_ page: MessagePage) {
        guard hasLoaded, !messages.isEmpty, let first = page.messages.first, page.hasEarlier else {
            replace(with: page)
            return
        }
        guard let newest = newestId, newest >= first.id else {
            replace(with: page) // a gap: nothing joins the two
            return
        }
        let kept = messages.filter { $0.id < first.id }
        messages = kept + Self.sortedUnique(page.messages)
        latestCursor = page.latestCursor
        hasNewer = false
        if kept.isEmpty {
            earliestCursor = page.earliestCursor
            hasEarlier = page.hasEarlier
        }
    }

    /// A message the caller just sent (or received in full): added in order,
    /// replacing any copy, unless the window isn't showing the newest end.
    mutating func upsert(_ message: Message) {
        if let index = messages.firstIndex(where: { $0.id == message.id }) {
            messages[index] = message
            return
        }
        guard !hasNewer else { return }
        messages = Self.sortedUnique(messages + [message])
        hasLoaded = true
    }

    mutating func remove(_ id: Int) { messages.removeAll { $0.id == id } }

    mutating func update(_ id: Int, _ change: (inout Message) -> Void) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        change(&messages[index])
    }

    private static func sortedUnique(_ input: [Message]) -> [Message] {
        var byId: [Int: Message] = [:]
        for message in input { byId[message.id] = message } // later copies win
        return byId.values.sorted { $0.id < $1.id }
    }
}

/// A message on its way to the server: shown at once as a pending bubble,
/// marked failed (with Retry) if the send doesn't go through. `clientId` is
/// the server's idempotency key, so a retry after a lost response never
/// posts the message twice.
struct PendingMessage: Identifiable, Sendable {
    enum State: Sendable, Equatable { case sending, failed(String) }

    let clientId: String
    let chatId: Int
    var contentType: Components.Schemas.MessageContentType
    var content: String
    var parentMessageId: Int?
    var parentPreview: String?
    /// A file still to upload (kept until the upload succeeds).
    var upload: APIClient.UploadFile?
    var attachmentId: Int?
    var state: State = .sending
    let createdAt: Date

    var id: String { clientId }

    static func makeClientId() -> String { "ios-\(UUID().uuidString.lowercased())" }
}

/// Everything a screen shows about one conversation's messages. Held by the
/// store, not the view, so reopening a chat finds the window — and the place
/// the reader was at — where they left it.
@MainActor
@Observable
final class MessageWindow {
    let chatId: Int
    fileprivate(set) var list = MessageList()
    fileprivate(set) var phase: LoadPhase = .idle
    fileprivate(set) var isLoadingEarlier = false
    fileprivate(set) var isLoadingNewer = false
    var pageError: String?
    fileprivate(set) var pending: [PendingMessage] = []
    fileprivate(set) var pins: [Message] = []
    fileprivate(set) var stars: [Message] = []
    /// Bumped by realtime events for this chat: the open conversation refetches.
    fileprivate(set) var revision = 0
    fileprivate(set) var pinsRevision = 0
    /// The newest message the reader had on screen when they left.
    var lastVisibleMessageId: Int?
    fileprivate var refreshGeneration = 0

    init(chatId: Int) { self.chatId = chatId }
}

/// Every conversation's messages, by chat id.
@MainActor
@Observable
final class MessageStore {
    static let pageSize = 30
    static let refreshSize = 50
    static let jumpMaxPages = 10

    /// Not observed itself — a view asking for a window may create one
    /// mid-render; each window's own properties are what views track.
    @ObservationIgnored private var windows: [Int: MessageWindow] = [:]
    private let api: APIClient
    /// Called with each message confirmed sent (the chat list's preview).
    var onSent: (Message) -> Void = { _ in }

    init(api: APIClient) { self.api = api }

    func window(_ chatId: Int) -> MessageWindow {
        if let window = windows[chatId] { return window }
        let window = MessageWindow(chatId: chatId)
        windows[chatId] = window
        return window
    }

    func existingWindow(_ chatId: Int) -> MessageWindow? { windows[chatId] }

    func drop(_ chatId: Int) { windows[chatId] = nil }

    // MARK: loading

    private func fetch(_ chatId: Int, before: String? = nil, after: String? = nil, limit: Int) async throws -> MessagePage {
        let page = try await api.call {
            try await $0.chats_listMessages(path: .init(id: String(chatId)), query: .init(before: before, after: after, limit: String(limit)))
        }.ok.body.json
        return MessagePage(page)
    }

    /// First open: the newest page. Reopening (or a realtime nudge) refetches
    /// the newest page and merges it over the tail, keeping older pages.
    func refresh(_ chatId: Int) async throws {
        let window = window(chatId)
        if !window.list.hasLoaded { window.phase = .loading }
        // While reading history after a jump, the newest end isn't loaded;
        // it pages in as the reader scrolls down instead.
        guard !window.list.hasNewer else { return }
        window.refreshGeneration += 1
        let generation = window.refreshGeneration
        do {
            let page = try await fetch(chatId, limit: window.list.hasLoaded ? Self.refreshSize : Self.pageSize)
            guard generation == window.refreshGeneration else { return }
            if window.list.hasLoaded { window.list.mergeLatest(page) } else { window.list.replace(with: page) }
            window.phase = .loaded
        } catch {
            let failure = APIError.from(error)
            if failure.isCancelled { return }
            if !window.list.hasLoaded { window.phase = .failed(failure.message) }
            throw failure
        }
    }

    func loadEarlier(_ chatId: Int) async {
        let window = window(chatId)
        guard window.list.hasEarlier, !window.isLoadingEarlier, let cursor = window.list.earliestCursor else { return }
        window.isLoadingEarlier = true
        window.pageError = nil
        defer { window.isLoadingEarlier = false }
        do {
            window.list.prepend(try await fetch(chatId, before: cursor, limit: Self.pageSize))
        } catch {
            let failure = APIError.from(error)
            if !failure.isCancelled { window.pageError = failure.message }
        }
    }

    func loadNewer(_ chatId: Int) async {
        let window = window(chatId)
        guard window.list.hasNewer, !window.isLoadingNewer, let cursor = window.list.latestCursor else { return }
        window.isLoadingNewer = true
        window.pageError = nil
        defer { window.isLoadingNewer = false }
        do {
            window.list.append(try await fetch(chatId, after: cursor, limit: Self.pageSize))
        } catch {
            let failure = APIError.from(error)
            if !failure.isCancelled { window.pageError = failure.message }
        }
    }

    /// Pages back until `messageId` is loaded (like the web, a bounded number
    /// of pages). Returns whether it's in the window now.
    @discardableResult
    func loadUntil(_ chatId: Int, contains messageId: Int) async -> Bool {
        let window = window(chatId)
        for _ in 0..<Self.jumpMaxPages {
            if window.list.contains(messageId) { return true }
            if let first = window.list.messages.first?.id, messageId < first, window.list.hasEarlier {
                await loadEarlier(chatId)
            } else if let last = window.list.newestId, messageId > last, window.list.hasNewer {
                await loadNewer(chatId)
            } else {
                break
            }
        }
        return window.list.contains(messageId)
    }

    // MARK: realtime

    /// Something in the chat changed: an open conversation refetches.
    func invalidate(_ chatId: Int) { windows[chatId]?.revision += 1 }

    /// After a reconnect: every open conversation refetches what it missed.
    func invalidateAll() {
        for window in windows.values {
            window.revision += 1
            window.pinsRevision += 1
        }
    }

    func applyReactionCounts(_ counts: [RealtimeEvent.ReactionCount], to messageId: Int, in chatId: Int) {
        guard let window = windows[chatId] else { return }
        window.list.update(messageId) { $0.reactions = PostStore.mergeReactionCounts($0.reactions, counts) }
    }

    func setPinned(_ pinned: Bool, messageId: Int, in chatId: Int) {
        guard let window = windows[chatId] else { return }
        window.list.update(messageId) { $0.pinned = pinned }
        if !pinned { window.pins.removeAll { $0.id == messageId } }
        window.pinsRevision += 1
    }

    // MARK: sending

    /// Queues a message and sends it. The pending bubble shows straight away.
    func send(_ pending: PendingMessage) async {
        let window = window(pending.chatId)
        window.pending.append(pending)
        await deliver(pending.clientId, in: pending.chatId)
    }

    func retry(_ clientId: String, in chatId: Int) async {
        guard let window = windows[chatId], let index = window.pending.firstIndex(where: { $0.clientId == clientId }) else { return }
        window.pending[index].state = .sending
        await deliver(clientId, in: chatId)
    }

    func discard(_ clientId: String, in chatId: Int) {
        windows[chatId]?.pending.removeAll { $0.clientId == clientId }
    }

    /// Retries every failed send (after a reconnect). Safe: each is keyed by
    /// its `clientId`, so one that did land isn't posted twice.
    func retryFailed() async {
        for window in windows.values {
            for pending in window.pending where pending.state != .sending {
                await retry(pending.clientId, in: window.chatId)
            }
        }
    }

    private func deliver(_ clientId: String, in chatId: Int) async {
        let window = window(chatId)
        guard var item = window.pending.first(where: { $0.clientId == clientId }) else { return }
        do {
            if let upload = item.upload, item.attachmentId == nil {
                let attachment: Attachment = try await api.upload(path: "attachments", file: upload)
                item.attachmentId = attachment.id
                item.upload = nil
                setPending(item, in: window)
            }
            let body = Components.Schemas.CreateMessageBody(
                contentType: item.contentType, content: item.content, attachmentId: item.attachmentId,
                parentMessageId: item.parentMessageId, clientId: item.clientId
            )
            let created = try await api.call { try await $0.chats_createMessage(path: .init(id: String(chatId)), body: .json(body)) }.created.body.json
            let message: Message = try reshape(created)
            // Reading history after a jump: come back to the newest end first.
            if window.list.hasNewer { try? await reanchor(chatId) }
            window.list.upsert(message)
            window.pending.removeAll { $0.clientId == clientId }
            onSent(message)
        } catch {
            let failure = APIError.from(error)
            guard let index = window.pending.firstIndex(where: { $0.clientId == clientId }) else { return }
            window.pending[index].state = .failed(failure.kind == .offline ? "Not sent — you're offline." : failure.message)
        }
    }

    private func setPending(_ item: PendingMessage, in window: MessageWindow) {
        if let index = window.pending.firstIndex(where: { $0.clientId == item.clientId }) { window.pending[index] = item }
    }

    private func reanchor(_ chatId: Int) async throws {
        window(chatId).list.replace(with: try await fetch(chatId, limit: Self.pageSize))
    }

    // MARK: edits

    func edit(_ messageId: Int, in chatId: Int, to content: String) async throws {
        let message = window(chatId).list.message(messageId)
        let updated = try await api.call {
            try await $0.chats_updateMessage(
                path: .init(id: String(chatId), messageId: String(messageId)),
                body: .json(.init(contentType: message?.contentType ?? .text, content: content, attachmentId: message?.attachment?.id))
            )
        }.ok.body.json
        window(chatId).list.upsert(updated)
    }

    func delete(_ messageId: Int, in chatId: Int) async throws {
        _ = try await api.call { try await $0.chats_deleteMessage(path: .init(id: String(chatId), messageId: String(messageId))) }.noContent
        let window = window(chatId)
        window.list.remove(messageId)
        window.pins.removeAll { $0.id == messageId }
        window.stars.removeAll { $0.id == messageId }
    }

    func toggleReaction(_ emoji: ReactionEmoji, on messageId: Int, in chatId: Int) async throws {
        let window = window(chatId)
        let mine = window.list.message(messageId)?.reactions.first { $0.emoji == emoji.rawValue }?.reactedByMe ?? false
        let path = Operations.Chats_addMessageReaction.Input.Path(id: String(chatId), messageId: String(messageId))
        let state = mine
            ? try await api.call { try await $0.chats_removeMessageReaction(path: .init(id: path.id, messageId: path.messageId), body: .json(.init(emoji: emoji))) }.ok.body.json
            : try await api.call { try await $0.chats_addMessageReaction(path: path, body: .json(.init(emoji: emoji))) }.ok.body.json
        window.list.update(messageId) { $0.reactions = state.reactions }
    }

    // MARK: pins & stars

    func loadPins(_ chatId: Int) async throws {
        window(chatId).pins = try await api.call { try await $0.chats_listPinnedMessages(path: .init(id: String(chatId))) }.ok.body.json
    }

    func loadStars(_ chatId: Int) async throws {
        window(chatId).stars = try await api.call { try await $0.chats_listStarredMessages(path: .init(id: String(chatId))) }.ok.body.json
    }

    func setPin(_ pinned: Bool, messageId: Int, in chatId: Int) async throws {
        let message = pinned
            ? try await api.call { try await $0.chats_pinMessage(path: .init(id: String(chatId)), body: .json(.init(messageId: messageId))) }.ok.body.json
            : try await api.call { try await $0.chats_unpinMessage(path: .init(id: String(chatId), messageId: String(messageId))) }.ok.body.json
        let window = window(chatId)
        window.list.update(messageId) { $0.pinned = message.pinned }
        window.pins.removeAll { $0.id == messageId }
        if message.pinned { window.pins.insert(message, at: 0) }
    }

    func setStar(_ starred: Bool, messageId: Int, in chatId: Int) async throws {
        let message = starred
            ? try await api.call { try await $0.chats_starMessage(path: .init(id: String(chatId), messageId: String(messageId))) }.ok.body.json
            : try await api.call { try await $0.chats_unstarMessage(path: .init(id: String(chatId), messageId: String(messageId))) }.ok.body.json
        let window = window(chatId)
        window.list.update(messageId) { $0.starred = message.starred }
        window.stars.removeAll { $0.id == messageId }
        if message.starred { window.stars.insert(message, at: 0) }
    }

    // MARK: forwarding

    struct ForwardOutcome: Identifiable, Sendable, Equatable {
        var chatId: Int
        var messageId: Int?
        var error: String?
        var id: Int { chatId }
    }

    /// Copies a message into up to `ChatStore.maxForwardTargets` chats. Each
    /// target succeeds or fails on its own; `clientId` makes a retry fill in
    /// only the targets that are missing.
    func forward(_ messageId: Int, from chatId: Int, to targets: [Int], clientId: String) async throws -> [ForwardOutcome] {
        let result = try await api.call {
            try await $0.chats_forwardMessage(
                path: .init(id: String(chatId), messageId: String(messageId)),
                body: .json(.init(targetChatIds: targets, clientId: clientId))
            )
        }.ok.body.json
        for outcome in result.results {
            if let message = outcome.message { windows[outcome.chatId]?.list.upsert(message) }
        }
        return result.results.map { ForwardOutcome(chatId: $0.chatId, messageId: $0.message?.id, error: $0.error?.message) }
    }
}
