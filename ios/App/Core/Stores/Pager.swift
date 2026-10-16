import Foundation

/// The ids of a cursor-paged list, in order. The API pages with an opaque
/// `nextCursor` (nil on the last page); this tracks how far a screen has got.
struct PageState<ID: Hashable & Sendable>: Sendable, Equatable {
    private(set) var ids: [ID] = []
    private(set) var nextCursor: String?
    private(set) var hasLoadedFirstPage = false

    var hasMore: Bool { nextCursor != nil }

    /// A fresh first page (pull to refresh, first load): replaces everything.
    mutating func replace(ids: [ID], nextCursor: String?) {
        self.ids = ids
        self.nextCursor = nextCursor
        hasLoadedFirstPage = true
    }

    /// The next page: appended, skipping anything already shown (an item can
    /// shift down a page while new ones arrive at the head).
    mutating func append(ids newIDs: [ID], nextCursor: String?) {
        var seen = Set(ids)
        for id in newIDs where seen.insert(id).inserted { ids.append(id) }
        self.nextCursor = nextCursor
    }

    /// A background refetch of page one while the user may have scrolled
    /// deeper: the new head leads, and the already-loaded tail stays below it
    /// (so a refetch never throws away the scroll position).
    mutating func mergeHead(ids head: [ID], nextCursor headCursor: String?) {
        guard hasLoadedFirstPage, ids.count > head.count else {
            replace(ids: head, nextCursor: headCursor)
            return
        }
        let headSet = Set(head)
        ids = head + ids.filter { !headSet.contains($0) }
        // The tail's cursor is still the right "next" — it points past it.
    }

    mutating func remove(_ id: ID) { ids.removeAll { $0 == id } }

    mutating func prepend(_ id: ID) {
        guard !ids.contains(id) else { return }
        ids.insert(id, at: 0)
    }
}
