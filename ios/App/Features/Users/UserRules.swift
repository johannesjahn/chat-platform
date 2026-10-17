import ChatAPI
import Foundation

typealias BlockType = Components.Schemas.BlockType
typealias BlockedUser = Components.Schemas.BlockedUser

/// Limits the server enforces, mirrored so a form can say what's wrong before
/// a round trip (the server still decides). Sources: `web/src/lib/api.ts`,
/// `web/src/lib/avatar.ts` and `src/Api.ts`. Lengths are JavaScript string
/// lengths — UTF-16 code units — because that's what the server counts.
enum UserLimits {
    /// `MIN_USER_SEARCH_QUERY_LENGTH`: shorter queries are admin-only.
    static let minSearchQuery = 3
    static let minPassword = 8
    static let maxDisplayName = 64
    static let maxBio = 160
    static let maxStatusText = 100
    static let maxStatusEmoji = 8
    /// `MIN_AVATAR_SOURCE_PX`: the source image's shorter side.
    static let minAvatarSourcePx = 256
    static let maxAvatarBytes = 8 * 1024 * 1024
}

extension String {
    /// The length the server measures (a JavaScript string's `length`).
    var jsLength: Int { utf16.count }

    /// Cuts the string to at most `max` UTF-16 units without splitting a
    /// character (an emoji stays whole or goes).
    func clamped(toJSLength max: Int) -> String {
        guard jsLength > max else { return self }
        var result = ""
        for character in self {
            if result.jsLength + String(character).jsLength > max { break }
            result.append(character)
        }
        return result
    }

    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}

/// Who may search with what (`searchUsers` in src/UsersHandler.ts): admins
/// can browse everyone with any query, including an empty one; everyone else
/// needs `minSearchQuery` characters.
enum UserSearchPolicy {
    static func isReady(query: String, isAdmin: Bool) -> Bool {
        isAdmin || query.trimmed.count >= UserLimits.minSearchQuery
    }
}

extension User {
    /// The handle shown beside a display name; nil when the name already is it.
    var handle: String? { displayName?.isEmpty == false ? "@\(username)" : nil }
    /// The name, or the handle when there's no display name (the web's `userLabel`).
    var label: String { displayName?.isEmpty == false ? displayName! : "@\(username)" }
}

extension UserProfile {
    var label: String { displayName?.isEmpty == false ? displayName! : "@\(username)" }
}
