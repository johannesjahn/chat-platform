import ChatAPI
import Foundation
import Observation

/// Whether anyone is signed in, mirrored from the `SessionManager` so views
/// can observe it. Tokens never leave the manager; views only see the user.
@MainActor
@Observable
final class AuthModel {
    enum Phase: Equatable {
        case launching
        case signedOut
        case signedIn(User)
    }

    private(set) var phase: Phase = .launching

    var user: User? {
        if case .signedIn(let user) = phase { return user }
        return nil
    }

    /// Called with the account about to be shown as signed in, before the
    /// phase changes (also on token refreshes and profile updates).
    var willSignIn: (User) -> Void = { _ in }

    private let api: APIClient
    private let sessions: SessionManager

    init(api: APIClient, sessions: SessionManager) {
        self.api = api
        self.sessions = sessions
        Task { [weak self] in
            await sessions.setObserver { session in
                Task { @MainActor in self?.apply(session) }
            }
            let session = await sessions.current()
            self?.apply(session)
            // The stored user may be stale (a role change, a new avatar).
            if let session { await self?.refreshProfile(id: session.user.id) }
        }
    }

    private func apply(_ session: Session?) {
        if let session {
            willSignIn(session.user)
            phase = .signedIn(session.user)
        } else {
            phase = .signedOut
        }
    }

    private func refreshProfile(id: Int) async {
        guard let profile = try? await api.call({ try await $0.users_getUser(path: .init(id: String(id))) }).ok.body.json
        else { return }
        await sessions.updateUser(profile.asUser)
    }

    func login(username: String, password: String) async throws {
        let response = try await api.call {
            try await $0.users_login(body: .json(.init(username: username, password: password)))
        }.ok.body.json
        await sessions.start(Session(user: response.user, accessToken: response.accessToken, refreshToken: response.refreshToken))
    }

    func register(username: String, password: String) async throws {
        _ = try await api.call {
            try await $0.users_register(body: .json(.init(username: username, password: password)))
        }
        try await login(username: username, password: password)
    }

    /// Revokes the refresh token server-side (best effort — a network failure
    /// must not keep someone signed in on this device), then clears the session.
    func logout() async {
        if let session = await sessions.current() {
            _ = try? await api.call { try await $0.users_logout(body: .json(.init(refreshToken: session.refreshToken))) }
        }
        await sessions.clear()
    }
}

/// `GET /version`: whether the server is reachable, and what it's running.
@MainActor
@Observable
final class ServerStatusModel {
    enum State: Equatable {
        case checking
        case online(version: String)
        case unreachable
    }

    private(set) var state: State = .checking
    private let api: APIClient

    init(api: APIClient) {
        self.api = api
        Task { [weak self] in await self?.check() }
    }

    func check() async {
        state = .checking
        do {
            let body = try await api.call { try await $0.meta_getVersion() }.ok.body.json
            state = .online(version: body.version)
        } catch {
            state = .unreachable
        }
    }

    var version: String? {
        if case .online(let version) = state { return version }
        return nil
    }
}
