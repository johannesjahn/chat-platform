import Foundation
import Observation

/// What a realtime event can make stale. Views that show server state attach
/// `.task(id: invalidations.token(.posts))`, so an event (or a reconnect)
/// refetches every screen showing that resource.
enum InvalidationTopic: Hashable, Sendable, CaseIterable {
    case posts, comments, chats, notifications, games, users
}

@MainActor
@Observable
final class Invalidations {
    private var counters: [InvalidationTopic: Int] = [:]

    func token(_ topic: InvalidationTopic) -> Int { counters[topic, default: 0] }

    func invalidate(_ topics: InvalidationTopic...) {
        for topic in topics { counters[topic, default: 0] += 1 }
    }

    func invalidateAll() {
        for topic in InvalidationTopic.allCases { counters[topic, default: 0] += 1 }
    }
}
