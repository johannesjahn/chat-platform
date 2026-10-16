import ChatAPI
import Foundation
import Observation

/// The one place users are cached. Posts and chats carry only ids, so every
/// avatar and name on screen reads through here — and so a realtime status
/// change or presence flip updates every row showing that person.
@MainActor
@Observable
final class UserStore {
    struct Status: Equatable {
        var text: String?
        var emoji: String?
        var expiresAt: Int?
    }

    private(set) var users: [Int: User] = [:]
    private(set) var online: Set<Int> = []
    private var statuses: [Int: Status] = [:]
    private var missing: Set<Int> = []
    private var byUsername: [String: Int] = [:]
    private var inFlight: [Int: Task<Void, Never>] = [:]

    private let api: APIClient

    init(api: APIClient) { self.api = api }

    func user(_ id: Int) -> User? { users[id] }

    func isOnline(_ id: Int) -> Bool { online.contains(id) }

    /// The user's status with any realtime override applied, nil once expired.
    func status(of id: Int, now: Date = Date()) -> Status? {
        let status = statuses[id] ?? users[id].map { Status(text: $0.statusText, emoji: $0.statusEmoji, expiresAt: $0.statusExpiresAt) }
        guard let status, status.text != nil || status.emoji != nil else { return nil }
        if let expires = status.expiresAt, Date(timeIntervalSince1970: TimeInterval(expires) / 1000) < now { return nil }
        return status
    }

    func store(_ user: User) {
        users[user.id] = user
        byUsername[user.username.lowercased()] = user.id
        missing.remove(user.id)
        statuses[user.id] = nil
    }

    func store(_ profile: UserProfile) { store(profile.asUser) }

    /// Fetches whichever of `ids` aren't cached yet (once each, even if many
    /// rows ask at the same moment). A 404 — a deleted account — is
    /// remembered so it isn't asked for again.
    func ensure(_ ids: some Sequence<Int>) async {
        let wanted = Set(ids).filter { users[$0] == nil && !missing.contains($0) }
        await withTaskGroup(of: Void.self) { group in
            for id in wanted {
                let task = inFlight[id] ?? Task { await self.fetch(id) }
                inFlight[id] = task
                group.addTask { await task.value }
            }
        }
    }

    /// Re-reads a user even if cached (after a profile edit or status change).
    func refresh(_ id: Int) async {
        await fetch(id)
    }

    private func fetch(_ id: Int) async {
        defer { inFlight[id] = nil }
        do {
            let profile = try await api.call { try await $0.users_getUser(path: .init(id: String(id))) }.ok.body.json
            store(profile)
        } catch let error as APIError where error.isNotFound {
            missing.insert(id)
        } catch {
            // Offline or a hiccup: leave it uncached so a later view retries.
        }
    }

    /// `@mention` lookup: usernames → accounts that exist (lowercased keys).
    func resolve(usernames: [String]) async -> [String: User] {
        var result: [String: User] = [:]
        var toFetch: [String] = []
        for name in usernames {
            let key = name.lowercased()
            if let id = byUsername[key], let user = users[id] { result[key] = user } else { toFetch.append(name) }
        }
        if !toFetch.isEmpty {
            let query = toFetch.prefix(Mentions.maxLookupCount).joined(separator: ",")
            if let found = try? await api.call({ try await $0.users_lookupUsersByUsername(query: .init(usernames: query)) }).ok.body.json {
                for user in found {
                    store(user)
                    result[user.username.lowercased()] = user
                }
            }
        }
        return result
    }

    // MARK: realtime

    func setOnline(_ id: Int, _ isOnline: Bool) {
        if isOnline { online.insert(id) } else { online.remove(id) }
    }

    func resetPresence() { online = [] }

    func setStatus(_ id: Int, text: String?, emoji: String?, expiresAt: Int?) {
        statuses[id] = Status(text: text, emoji: emoji, expiresAt: expiresAt)
    }
}
