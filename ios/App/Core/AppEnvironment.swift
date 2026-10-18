import ChatAPI
import Foundation
import Observation

/// Everything the screens share, built once at launch.
@MainActor
@Observable
final class AppEnvironment {
    let config: AppConfig
    let api: APIClient
    let sessions: SessionManager
    let auth: AuthModel
    let server: ServerStatusModel
    let invalidations = Invalidations()
    // Everything below up to `theme` is one account's data — rebuilt as a set
    // whenever a different account signs in (see `accountWillSignIn`).
    private(set) var users: UserStore
    private(set) var posts: PostStore
    private(set) var notifications: NotificationStore
    private(set) var blocks: BlockStore
    private(set) var chats: ChatStore
    private(set) var messages: MessageStore
    private(set) var typing = TypingStore()
    private(set) var games: GameStore
    /// Whose data the stores above hold; nil until the first sign-in.
    private var storesOwner: Int?
    let theme: ThemeStore
    let realtime: RealtimeClient
    let router = AppRouter()
    let images: ImageLoader

    init(
        config: AppConfig = .resolve(),
        options: LaunchOptions = .resolve(),
        storage: any SecretStorage = KeychainStorage(),
        urlSession: URLSession = .shared
    ) {
        if options.uiTesting {
            // Every UI test starts from a known state: signed out, or signed
            // in as exactly the account the test injected.
            storage.delete()
            if let injected = options.injectedSession { storage.write(injected) }
        }
        self.config = config
        let sessions = SessionManager(
            storage: storage,
            refresher: URLSessionRefresher(baseURL: config.apiBaseURL, session: urlSession)
        )
        self.sessions = sessions
        let api = APIClient(baseURL: config.apiBaseURL, sessions: sessions, urlSession: urlSession)
        self.api = api
        auth = AuthModel(api: api, sessions: sessions)
        server = ServerStatusModel(api: api)
        theme = ThemeStore(reset: options.uiTesting)
        let realtime = RealtimeClient(transport: URLSessionRealtimeTransport(api: api))
        self.realtime = realtime
        let users = UserStore(api: api)
        self.users = users
        posts = PostStore(api: api, users: users)
        notifications = NotificationStore(api: api, users: users)
        blocks = BlockStore(api: api, users: users)
        chats = ChatStore(api: api)
        messages = MessageStore(api: api)
        games = GameStore(api: api, users: users, realtime: realtime)
        images = ImageLoader(session: urlSession, baseURL: config.apiBaseURL)
        realtime.onConnect = { [weak self] in self?.handleConnect() }
        realtime.onEvent = { [weak self] event in self?.handle(event) }
        auth.willSignIn = { [weak self] user in self?.accountWillSignIn(user) }
        wireStores()
    }

    private func wireStores() {
        // A block or mute hides (or brings back) that person's posts.
        blocks.onChange = { [weak self] in self?.invalidations.invalidate(.posts) }
        // A sent message moves its chat to the top of the list with a new preview.
        messages.onSent = { [weak self] _ in self?.invalidations.invalidate(.chats) }
    }

    /// Runs before the signed-in shell appears. When the account isn't the one
    /// the stores were filled for, they're replaced wholesale — otherwise the
    /// next person would inherit the last one's chats, cached posts, block
    /// list, and (via `retryFailed` on connect) send their unsent messages.
    /// Replacing beats clearing in place: a late response to the previous
    /// account's request lands in a store nothing reads anymore. Every account
    /// change passes through `.signedOut`, which tears down the views holding
    /// the old stores.
    func accountWillSignIn(_ user: User) {
        guard storesOwner != user.id else { return }
        defer { storesOwner = user.id }
        // The ones built at launch are still empty.
        guard storesOwner != nil else { return }
        let users = UserStore(api: api)
        self.users = users
        posts = PostStore(api: api, users: users)
        notifications = NotificationStore(api: api, users: users)
        blocks = BlockStore(api: api, users: users)
        chats = ChatStore(api: api)
        messages = MessageStore(api: api)
        typing = TypingStore()
        games = GameStore(api: api, users: users, realtime: realtime)
        wireStores()
        router.reset()
    }

    /// Events are best-effort, so every (re)connect refetches everything
    /// event-driven — a missed event heals itself.
    private func handleConnect() {
        users.resetPresence()
        invalidations.invalidateAll()
        messages.invalidateAll()
        Task { await messages.retryFailed() }
    }

    func handle(_ event: RealtimeEvent) {
        switch event {
        case .chatUpdated(let chatId, let version):
            // A redelivery of a version already seen changes nothing.
            guard chats.noteUpdate(chatId, version: version) else { return }
            messages.invalidate(chatId)
            invalidations.invalidate(.chats)
        case .chatDeleted(let chatId):
            chats.noteDeleted(chatId)
            messages.drop(chatId)
            invalidations.invalidate(.chats)
        case .messagePinChanged(let chatId, let messageId, let pinned):
            messages.setPinned(pinned, messageId: messageId, in: chatId)
        case .postChanged:
            invalidations.invalidate(.posts)
        case .commentChanged:
            invalidations.invalidate(.comments, .posts)
        case .reactionChanged(let target, let targetId, let chatId, let reactions):
            switch target {
            case .post: posts.applyReactionCounts(reactions, to: targetId)
            case .comment: invalidations.invalidate(.comments)
            case .message:
                if let chatId { messages.applyReactionCounts(reactions, to: targetId, in: chatId) }
            }
        case .presence(let userId, let online):
            users.setOnline(userId, online)
        case .statusChanged(let userId, let text, let emoji, let expiresAt):
            users.setStatus(userId, text: text, emoji: emoji, expiresAt: expiresAt)
        case .typing(let chatId, let userId, let username, let displayName):
            guard userId != auth.user?.id else { return }
            typing.note(chatId: chatId, userId: userId, name: displayName?.isEmpty == false ? displayName! : username)
        case .gameLobbyUpdated, .gameLobbiesChanged, .gameChat:
            invalidations.invalidate(.games)
        case .gameProgress, .gameReaction:
            games.handle(event, me: auth.user?.id)
        case .notificationsChanged:
            invalidations.invalidate(.notifications)
        case .unknown:
            break
        }
    }
}

extension Components.Schemas.UserProfile {
    /// The part of a profile that is also a plain `User`.
    var asUser: User {
        User(
            id: id, username: username, displayName: displayName, avatarUrl: avatarUrl,
            avatarVariants: avatarVariants, role: role, statusText: statusText,
            statusEmoji: statusEmoji, statusExpiresAt: statusExpiresAt
        )
    }
}
