import ChatAPI
import Foundation
import Observation

/// Who the signed-in user has blocked or muted (`GET /users/me/blocks`),
/// shared by the profile's controls and the settings list.
@MainActor
@Observable
final class BlockStore {
    private(set) var entries: [BlockedUser] = []
    private(set) var phase: LoadPhase = .idle
    /// Whose list `entries` is — a different account starts from scratch.
    private var owner: Int?

    private let api: APIClient
    private let users: UserStore
    /// Called after a block, mute or unblock (the environment invalidates `.posts`).
    @ObservationIgnored var onChange: (@MainActor () -> Void)?

    init(api: APIClient, users: UserStore) {
        self.api = api
        self.users = users
    }

    func type(of userId: Int) -> BlockType? {
        entries.first { $0.user.id == userId }?._type
    }

    func load(for me: Int) async {
        if owner != me {
            owner = me
            entries = []
            phase = .idle
        }
        if phase != .loaded { phase = .loading }
        do {
            let list = try await api.call { try await $0.users_listBlocks() }.ok.body.json
            guard owner == me else { return }
            entries = list
            for entry in list { users.store(entry.user) }
            phase = .loaded
        } catch {
            let error = APIError.from(error)
            if error.isCancelled { return }
            // A failed refetch keeps a list that's already on screen.
            if phase != .loaded { phase = .failed(error.message) }
        }
    }

    func set(_ type: BlockType, for userId: Int) async throws {
        let entry = try await api.call {
            try await $0.users_setBlock(path: .init(id: String(userId)), body: .json(.init(_type: type)))
        }.ok.body.json
        entries.removeAll { $0.user.id == userId }
        entries.insert(entry, at: 0)
        onChange?()
    }

    func remove(_ userId: Int) async throws {
        _ = try await api.call { try await $0.users_removeBlock(path: .init(id: String(userId))) }
        entries.removeAll { $0.user.id == userId }
        onChange?()
    }
}
