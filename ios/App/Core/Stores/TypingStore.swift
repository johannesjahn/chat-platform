import Foundation
import Observation

/// Who's typing where. The server pushes a `typing` event per burst of
/// keystrokes and never a "stopped" one, so each entry lapses on its own
/// after `ttl` unless a fresh event renews it — web/src/lib/typing.ts. A
/// message from that person clears it at once.
@MainActor
@Observable
final class TypingStore {
    struct Typist: Equatable, Sendable {
        var userId: Int
        var name: String
    }

    static let ttl: TimeInterval = 4

    private var entries: [Int: [Int: (name: String, expiresAt: Date)]] = [:]
    private let now: () -> Date
    private let schedulesExpiry: Bool

    /// `now` and `schedulesExpiry` are for tests, which drive the clock.
    init(now: @escaping () -> Date = Date.init, schedulesExpiry: Bool = true) {
        self.now = now
        self.schedulesExpiry = schedulesExpiry
    }

    func note(chatId: Int, userId: Int, name: String) {
        let expiresAt = now().addingTimeInterval(Self.ttl)
        entries[chatId, default: [:]][userId] = (name, expiresAt)
        guard schedulesExpiry else { return }
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.ttl) + .milliseconds(50))
            self?.prune()
        }
    }

    func clear(chatId: Int, userId: Int) {
        guard entries[chatId]?[userId] != nil else { return }
        entries[chatId]?[userId] = nil
        if entries[chatId]?.isEmpty == true { entries[chatId] = nil }
    }

    /// Drops every entry whose time is up.
    func prune() {
        let current = now()
        for (chatId, typists) in entries {
            let alive = typists.filter { $0.value.expiresAt > current }
            if alive.count != typists.count { entries[chatId] = alive.isEmpty ? nil : alive }
        }
    }

    /// Who's typing in a chat right now, by name, in a stable order.
    func typists(in chatId: Int) -> [Typist] {
        let current = now()
        return (entries[chatId] ?? [:])
            .filter { $0.value.expiresAt > current }
            .map { Typist(userId: $0.key, name: $0.value.name) }
            .sorted { $0.userId < $1.userId }
    }

    /// "Ada is typing…", "Ada and Bo are typing…", "3 people are typing…".
    static func sentence(for typists: [Typist]) -> String? {
        switch typists.count {
        case 0: return nil
        case 1: return "\(typists[0].name) is typing…"
        case 2: return "\(typists[0].name) and \(typists[1].name) are typing…"
        default: return "\(typists.count) people are typing…"
        }
    }
}
