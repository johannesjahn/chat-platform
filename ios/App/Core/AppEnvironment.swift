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
    let users: UserStore
    let posts: PostStore
    let notifications: NotificationStore
    let blocks: BlockStore
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
        let users = UserStore(api: api)
        self.users = users
        posts = PostStore(api: api, users: users)
        notifications = NotificationStore(api: api, users: users)
        blocks = BlockStore(api: api, users: users)
        theme = ThemeStore(reset: options.uiTesting)
        realtime = RealtimeClient(transport: URLSessionRealtimeTransport(api: api))
        images = ImageLoader(session: urlSession, baseURL: config.apiBaseURL)
        realtime.onConnect = { [weak self] in self?.handleConnect() }
        realtime.onEvent = { [weak self] event in self?.handle(event) }
        // A block or mute hides (or brings back) that person's posts.
        blocks.onChange = { [weak self] in self?.invalidations.invalidate(.posts) }
    }

    /// Events are best-effort, so every (re)connect refetches everything
    /// event-driven — a missed event heals itself.
    private func handleConnect() {
        users.resetPresence()
        invalidations.invalidateAll()
    }

    func handle(_ event: RealtimeEvent) {
        switch event {
        case .chatUpdated, .chatDeleted, .messagePinChanged:
            invalidations.invalidate(.chats)
        case .postChanged:
            invalidations.invalidate(.posts)
        case .commentChanged:
            invalidations.invalidate(.comments, .posts)
        case .reactionChanged(let target, let targetId, _, let reactions):
            switch target {
            case .post: posts.applyReactionCounts(reactions, to: targetId)
            case .comment: invalidations.invalidate(.comments)
            case .message: invalidations.invalidate(.chats)
            }
        case .presence(let userId, let online):
            users.setOnline(userId, online)
        case .statusChanged(let userId, let text, let emoji, let expiresAt):
            users.setStatus(userId, text: text, emoji: emoji, expiresAt: expiresAt)
        case .typing:
            break
        case .gameLobbyUpdated, .gameLobbiesChanged, .gameChat:
            invalidations.invalidate(.games)
        case .gameProgress, .gameReaction:
            break
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
