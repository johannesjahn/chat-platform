import ChatAPI
import Foundation
import Observation

typealias InboxNotification = Components.Schemas.Notification
typealias NotificationKind = Components.Schemas.NotificationType

/// The signed-in user's notification inbox and its unread count — the one
/// copy both the Alerts tab badge and the inbox read. Rows store ids only on
/// the server; what a row says (actor, excerpt) comes back with each page, so
/// an edit or delete shows through on the next refetch.
@MainActor
@Observable
final class NotificationStore {
    private(set) var notifications: [Int: InboxNotification] = [:]
    private(set) var page = PageState<Int>()
    private(set) var phase: LoadPhase = .idle
    private(set) var isLoadingMore = false
    private(set) var unreadCount = 0
    var loadMoreError: String?
    /// The last failed mark-read (after rolling it back), for an alert.
    var actionError: String?

    private let api: APIClient
    private let users: UserStore
    private var generation = 0
    /// Bumped by every write, so a count fetched before it can't land after it.
    private var countVersion = 0
    static let pageSize = 20

    init(api: APIClient, users: UserStore) {
        self.api = api
        self.users = users
    }

    func notification(_ id: Int) -> InboxNotification? { notifications[id] }

    private var ownerId: Int?

    /// A different account than last time starts from an empty inbox.
    func signedIn(as userId: Int) {
        guard ownerId != userId else { return }
        reset()
        ownerId = userId
    }

    /// Signing out (or in as someone else) starts from nothing.
    func reset() {
        notifications = [:]
        page = PageState()
        phase = .idle
        isLoadingMore = false
        unreadCount = 0
        loadMoreError = nil
        actionError = nil
        generation += 1
        countVersion += 1
    }

    // MARK: reads

    /// The badge: `GET /notifications/unread-count`. Runs on launch, on every
    /// `notifications_changed` event and on every socket (re)connect.
    func refreshUnreadCount() async {
        let version = countVersion
        guard let count = try? await api.call({ try await $0.notifications_getUnreadNotificationCount(.init()) }).ok.body.json.count
        else { return }
        if version == countVersion { unreadCount = count }
    }

    /// The inbox's first page (it carries the unread count too). `reset`
    /// replaces the list; otherwise a background refetch keeps loaded pages.
    func load(reset: Bool) async {
        if !page.hasLoadedFirstPage { phase = .loading }
        generation += 1
        let generation = generation
        let version = countVersion
        do {
            let result = try await fetchPage(cursor: nil)
            guard generation == self.generation else { return }
            absorb(result.notifications)
            let ids = result.notifications.map(\.id)
            if reset || !page.hasLoadedFirstPage {
                page.replace(ids: ids, nextCursor: result.nextCursor)
            } else {
                page.mergeHead(ids: ids, nextCursor: result.nextCursor)
            }
            if version == countVersion { unreadCount = result.unreadCount }
            phase = .loaded
        } catch {
            let failure = APIError.from(error)
            if failure.isCancelled { return }
            if !page.hasLoadedFirstPage { phase = .failed(failure.message) }
        }
    }

    func loadMore() async {
        guard page.hasMore, !isLoadingMore, let cursor = page.nextCursor else { return }
        isLoadingMore = true
        loadMoreError = nil
        defer { isLoadingMore = false }
        do {
            let result = try await fetchPage(cursor: cursor)
            absorb(result.notifications)
            page.append(ids: result.notifications.map(\.id), nextCursor: result.nextCursor)
        } catch {
            loadMoreError = APIError.from(error).message
        }
    }

    private func fetchPage(cursor: String?) async throws -> Components.Schemas.NotificationsPage {
        try await api.call {
            try await $0.notifications_listNotifications(query: .init(cursor: cursor, limit: String(Self.pageSize)))
        }.ok.body.json
    }

    private func absorb(_ batch: [InboxNotification]) {
        for item in batch {
            notifications[item.id] = item
            // The actor comes with the row: seed the shared cache so the
            // avatar draws without a request of its own.
            if users.user(item.actor.id) == nil { users.store(item.actor) }
        }
    }

    // MARK: writes (optimistic, rolled back on failure)

    /// Marks one read straight away; the server's answer sets the badge. A
    /// failure puts the row and the count back as they were.
    func markRead(_ id: Int) async {
        guard let item = notifications[id], !item.read else { return }
        countVersion += 1
        notifications[id]?.read = true
        unreadCount = max(0, unreadCount - 1)
        do {
            let count = try await api.call {
                try await $0.notifications_markNotificationRead(path: .init(id: String(id)))
            }.ok.body.json.count
            unreadCount = count
        } catch {
            let failure = APIError.from(error)
            if failure.isNotFound {
                // Gone (its post was deleted): drop it rather than resurrect it.
                notifications[id] = nil
                page.remove(id)
                await refreshUnreadCount()
                return
            }
            notifications[id]?.read = false
            unreadCount += 1
            actionError = failure.message
        }
    }

    func markAllRead() async {
        let unread = notifications.values.filter { !$0.read }.map(\.id)
        let previousCount = unreadCount
        countVersion += 1
        for id in unread { notifications[id]?.read = true }
        unreadCount = 0
        do {
            unreadCount = try await api.call { try await $0.notifications_markAllNotificationsRead(.init()) }.ok.body.json.count
        } catch {
            for id in unread { notifications[id]?.read = false }
            unreadCount = previousCount
            actionError = APIError.from(error).message
        }
    }
}
