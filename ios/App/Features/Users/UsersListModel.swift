import ChatAPI
import Foundation
import Observation

/// `GET /users/search` for the people screen. Not paged — the server caps the
/// result list — so this is just the latest answer for the latest query; a
/// slower answer to an older query never overwrites a newer one.
@MainActor
@Observable
final class UsersListModel {
    enum State: Equatable {
        /// Too short to search (non-admins need `UserLimits.minSearchQuery`).
        case needsQuery
        case loading
        case loaded([Int])
        case failed(String)
    }

    var query = ""
    private(set) var state: State = .needsQuery
    /// The query the shown results answer.
    private(set) var resultsQuery = ""

    private let api: APIClient
    private let users: UserStore
    private var generation = 0

    init(api: APIClient, users: UserStore) {
        self.api = api
        self.users = users
    }

    func search(isAdmin: Bool) async {
        let q = query.trimmed
        generation += 1
        let generation = generation
        guard UserSearchPolicy.isReady(query: q, isAdmin: isAdmin) else {
            state = .needsQuery
            return
        }
        // Results already on screen stay while the next query loads.
        if case .loaded = state {} else { state = .loading }
        do {
            let found = try await api.call { try await $0.users_searchUsers(query: .init(q: q)) }.ok.body.json
            guard generation == self.generation else { return }
            for user in found { users.store(user) }
            resultsQuery = q
            state = .loaded(found.map(\.id))
        } catch {
            let error = APIError.from(error)
            guard generation == self.generation, !error.isCancelled else { return }
            state = .failed(error.message)
        }
    }

    /// Drops a deleted account from the results.
    func remove(_ id: Int) {
        if case .loaded(let ids) = state { state = .loaded(ids.filter { $0 != id }) }
    }
}
