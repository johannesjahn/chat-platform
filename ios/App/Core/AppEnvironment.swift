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
    let chats: ChatStore
    let messages: MessageStore
    let typing = TypingStore()
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
        chats = ChatStore(api: api)
        messages = MessageStore(api: api)
        realtime = RealtimeClient(transport: URLSessionRealtimeTransport(api: api))
        images = ImageLoader(session: urlSession, baseURL: config.apiBaseURL)
        realtime.onConnect = { [weak self] in self?.handleConnect() }
        realtime.onEvent = { [weak self] event in self?.handle(event) }
        // A sent message moves its chat to the top of the list with a new preview.
        messages.onSent = { [weak self] _ in self?.invalidations.invalidate(.chats) }
    }

    /// Events are best-effort, so every (re)connect refetches everything
    /// event-driven — a missed event heals itself.
    private func handleConnect() {
        users.resetPresence()
        invalidations.invalidateAll()
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
