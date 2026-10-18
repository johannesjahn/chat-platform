import ChatAPI
import Foundation
import Observation

typealias Chat = Components.Schemas.Chat
typealias ChatParticipant = Components.Schemas.ChatParticipant
typealias ChatInvite = Components.Schemas.ChatInvite
typealias Message = Components.Schemas.Message

/// The highest `version` seen per chat, from a REST fetch or a `chat_updated`
/// event — web/src/lib/chatVersions.ts. It lets a redelivered event be told
/// apart from a real change, and a missed one be noticed.
struct ChatVersions: Sendable, Equatable {
    enum Classification: Sendable, Equatable {
        /// At or behind what's known: a redelivery, nothing to fetch.
        case stale
        /// More than one ahead: at least one update was missed.
        case gap
        /// The next version, or the first one seen for that chat.
        case sequential
    }

    private var known: [Int: Int] = [:]

    func version(of chatId: Int) -> Int? { known[chatId] }

    /// Only ever moves a chat's version forward.
    mutating func record(_ chatId: Int, _ version: Int) {
        if let current = known[chatId], current >= version { return }
        known[chatId] = version
    }

    mutating func forget(_ chatId: Int) { known[chatId] = nil }

    func classify(_ chatId: Int, _ version: Int) -> Classification {
        guard let current = known[chatId] else { return .sequential }
        if version <= current { return .stale }
        if version > current + 1 { return .gap }
        return .sequential
    }
}

/// The signed-in user's chats: the paged list (newest activity first, each
/// with its unread count and last message) and every chat fetched by id.
/// Screens read `chat(_:)`, so a rename, a new member or a read receipt shows
/// in the list, the conversation header and the info screen at once.
@MainActor
@Observable
final class ChatStore {
    static let maxGroupParticipants = 20
    static let maxForwardTargets = 10
    static let maxMessageLength = 4000

    private(set) var chats: [Int: Chat] = [:]
    private(set) var list = PageState<Int>()
    private(set) var phase: LoadPhase = .idle
    private(set) var isLoadingMore = false
    var loadMoreError: String?
    /// Chats the server said we can't see (404/403) or that were deleted.
    private(set) var missing: Set<Int> = []
    private(set) var versions = ChatVersions()
    private var generation = 0

    private let api: APIClient

    init(api: APIClient) { self.api = api }

    func chat(_ id: Int) -> Chat? { chats[id] }

    /// The badge on the Chats tab: unread messages across every chat loaded.
    var totalUnread: Int { list.ids.reduce(0) { $0 + (chats[$1]?.unreadCount ?? 0) } }

    func store(_ chat: Chat) {
        chats[chat.id] = chat
        missing.remove(chat.id)
        versions.record(chat.id, Int(chat.version))
    }

    // MARK: list

    /// Loads the first page. `reset` (pull to refresh) replaces the list;
    /// a background refetch keeps pages already loaded below the new head.
    func loadList(reset: Bool) async {
        if !list.hasLoadedFirstPage { phase = .loading }
        generation += 1
        let generation = generation
        do {
            let page = try await api.call { try await $0.chats_listChats(query: .init()) }.ok.body.json
            guard generation == self.generation else { return }
            for chat in page.chats { store(chat) }
            let ids = page.chats.map(\.id)
            if reset || !list.hasLoadedFirstPage {
                list.replace(ids: ids, nextCursor: page.nextCursor)
            } else {
                list.mergeHead(ids: ids, nextCursor: page.nextCursor)
            }
            phase = .loaded
        } catch {
            let failure = APIError.from(error)
            if failure.isCancelled { return }
            if !list.hasLoadedFirstPage { phase = .failed(failure.message) }
        }
    }

    func loadMore() async {
        guard list.hasMore, !isLoadingMore, let cursor = list.nextCursor else { return }
        isLoadingMore = true
        loadMoreError = nil
        defer { isLoadingMore = false }
        do {
            let page = try await api.call { try await $0.chats_listChats(query: .init(cursor: cursor)) }.ok.body.json
            for chat in page.chats { store(chat) }
            list.append(ids: page.chats.map(\.id), nextCursor: page.nextCursor)
        } catch {
            loadMoreError = APIError.from(error).message
        }
    }

    // MARK: one chat

    /// Fetches one chat. A 404/403 (not a participant, or deleted) marks it
    /// missing and drops it from the list.
    @discardableResult
    func fetch(_ id: Int) async throws -> Chat {
        do {
            let chat = try await api.call { try await $0.chats_getChat(path: .init(id: String(id))) }.ok.body.json
            store(chat)
            return chat
        } catch let error as APIError where error.isNotFound || error.status == 403 {
            markMissing(id)
            throw error
        }
    }

    func markMissing(_ id: Int) {
        missing.insert(id)
        chats[id] = nil
        list.remove(id)
        versions.forget(id)
    }

    // MARK: realtime

    /// A `chat_updated` event: stale redeliveries are ignored; anything else
    /// is recorded and means "refetch". Returns whether to refetch.
    func noteUpdate(_ chatId: Int, version: Int) -> Bool {
        let classification = versions.classify(chatId, version)
        if classification == .stale { return false }
        versions.record(chatId, version)
        return true
    }

    func noteDeleted(_ chatId: Int) { markMissing(chatId) }

    // MARK: writes

    func createDirect(with userId: Int) async throws -> Chat {
        let chat = try await api.call { try await $0.chats_createDirectChat(body: .json(.init(userId: userId))) }.ok.body.json
        store(chat)
        list.prepend(chat.id)
        return chat
    }

    func createGroup(title: String, participantIds: [Int]) async throws -> Chat {
        let created = try await api.call {
            try await $0.chats_createGroupChat(body: .json(.init(title: title, participantIds: participantIds)))
        }.created.body.json
        let chat: Chat = try reshape(created)
        store(chat)
        list.prepend(chat.id)
        return chat
    }

    /// Marks everything up to `messageId` read and takes the server's
    /// recalculated unread count.
    func markRead(_ chatId: Int, upTo messageId: Int) async throws {
        let chat = try await api.call { try await $0.chats_markRead(path: .init(id: String(chatId)), body: .json(.init(messageId: messageId))) }.ok.body.json
        store(chat)
    }

    func rename(_ chatId: Int, to title: String) async throws {
        store(try await api.call { try await $0.chats_updateChat(path: .init(id: String(chatId)), body: .json(.init(title: title))) }.ok.body.json)
    }

    func addParticipants(_ chatId: Int, _ ids: [Int]) async throws {
        store(try await api.call { try await $0.chats_addParticipants(path: .init(id: String(chatId)), body: .json(.init(participantIds: ids))) }.ok.body.json)
    }

    func removeParticipant(_ chatId: Int, _ userId: Int) async throws {
        store(try await api.call { try await $0.chats_removeParticipant(path: .init(id: String(chatId), userId: String(userId))) }.ok.body.json)
    }

    func setRole(_ chatId: Int, _ userId: Int, admin: Bool) async throws {
        store(try await api.call {
            try await $0.chats_updateParticipantRole(path: .init(id: String(chatId), userId: String(userId)), body: .json(.init(role: admin ? .admin : .member)))
        }.ok.body.json)
    }

    func transferOwnership(_ chatId: Int, to userId: Int) async throws {
        store(try await api.call { try await $0.chats_transferOwnership(path: .init(id: String(chatId)), body: .json(.init(userId: userId))) }.ok.body.json)
    }

    func uploadAvatar(_ chatId: Int, file: APIClient.UploadFile, cropSide: Int) async throws {
        // The server crops a square of `size` at (x, y); the image is already square.
        let chat: Chat = try await api.upload(path: "chats/\(chatId)/avatar", file: file, fields: ["x": "0", "y": "0", "size": String(cropSide)])
        store(chat)
    }

    func removeAvatar(_ chatId: Int) async throws {
        store(try await api.call { try await $0.chats_deleteChatAvatar(path: .init(id: String(chatId))) }.ok.body.json)
    }

    func leave(_ chatId: Int) async throws {
        _ = try await api.call { try await $0.chats_leaveChat(path: .init(id: String(chatId))) }.noContent
        markMissing(chatId)
    }

    func delete(_ chatId: Int) async throws {
        _ = try await api.call { try await $0.chats_deleteChat(path: .init(id: String(chatId))) }.noContent
        markMissing(chatId)
    }

    // MARK: invites

    func invites(_ chatId: Int) async throws -> [ChatInvite] {
        let raw = try await api.call { try await $0.chats_listChatInvites(path: .init(id: String(chatId))) }.ok.body.json
        return try raw.map { try reshape($0) }
    }

    func createInvite(_ chatId: Int, expiresInHours: Int? = nil, maxUses: Int? = nil) async throws -> ChatInvite {
        try await api.call {
            try await $0.chats_createChatInvite(path: .init(id: String(chatId)), body: .json(.init(expiresInHours: expiresInHours, maxUses: maxUses)))
        }.created.body.json
    }

    func revokeInvite(_ chatId: Int, _ inviteId: Int) async throws {
        _ = try await api.call { try await $0.chats_revokeChatInvite(path: .init(id: String(chatId), inviteId: String(inviteId))) }.noContent
    }

    func join(code: String) async throws -> Chat {
        let chat = try await api.call { try await $0.chats_joinChatViaInvite(path: .init(code: code)) }.ok.body.json
        store(chat)
        list.prepend(chat.id)
        return chat
    }
}

// MARK: - presentation helpers

extension ChatParticipant {
    var shownName: String { displayName?.isEmpty == false ? displayName! : username }
}

extension Chat {
    var isGroup: Bool { _type == .group }

    func other(than me: Int?) -> ChatParticipant? {
        participants.first { $0.userId != me }
    }

    /// The group's title, or the other person's name in a direct chat.
    func displayName(me: Int?) -> String {
        if isGroup { return title ?? "Group chat" }
        return other(than: me)?.shownName ?? "Direct chat"
    }

    func participant(_ userId: Int?) -> ChatParticipant? {
        participants.first { $0.userId == userId }
    }

    /// The owner's user id (`createdBy`; nil if their account is gone).
    var ownerId: Int? { createdBy.map { Int($0) } }
}

/// What a viewer may do in a chat — the same rules as the web's group
/// dialog; the server enforces them regardless.
struct ChatPermissions: Equatable {
    var canManage: Bool
    var canManageRoles: Bool
    var canClaimOwnership: Bool

    init(chat: Chat, me: User?) {
        let myRole = chat.participant(me?.id)?.role
        let siteAdmin = me?.role == .admin
        canManage = chat.isGroup && (myRole == .owner || myRole == .admin || siteAdmin)
        canManageRoles = chat.isGroup && (myRole == .owner || siteAdmin)
        canClaimOwnership = chat.isGroup && chat.createdBy == nil
    }

    /// Removing someone: managers may, but only the owner (or a site admin)
    /// may remove the owner, and nobody removes themselves (that's "leave").
    func canRemove(_ participant: ChatParticipant, in chat: Chat, me: User?) -> Bool {
        guard canManage, participant.userId != me?.id else { return false }
        let isOwner = chat.ownerId == participant.userId
        return !isOwner || chat.participant(me?.id)?.role == .owner || me?.role == .admin
    }
}

extension Message {
    var isEdited: Bool { updatedAt > createdAt + 1000 }

    /// A one-line stand-in for the message (pins, replies, the chat list).
    var preview: String {
        switch contentType {
        case .imageUrl: return "📷 Photo"
        case .attachment:
            if let attachment, attachment.mimeType.hasPrefix("image/") { return "📷 Photo" }
            if let attachment, attachment.mimeType.hasPrefix("audio/") { return "🎤 Voice message" }
            return "📎 \(attachment?.filename ?? content)"
        case .text: return content
        }
    }
}

extension Message: @retroactive Identifiable {}
extension Chat: @retroactive Identifiable {}
