import ChatAPI
import Foundation
import Observation

/// Everything the screens share, built once at launch.
@MainActor
final class AppEnvironment {
    let config: AppConfig
    let api: APIClient
    let sessions: SessionManager
    let auth: AuthModel
    let server: ServerStatusModel

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
