import ChatAPI
import Foundation

typealias Post = Components.Schemas.Post
typealias Comment = Components.Schemas.Comment
typealias Attachment = Components.Schemas.Attachment
typealias ReactionSummary = Components.Schemas.ReactionSummary
typealias ReactionEmoji = Components.Schemas.ReactionEmoji
typealias UserProfile = Components.Schemas.UserProfile

extension ReactionEmoji {
    /// The fixed set the server accepts, in picker order
    /// (REACTION_EMOJIS in src/Api.ts).
    static let picker: [ReactionEmoji] = Array(allCases)
}

/// The API names a few structurally identical schemas twice (`Post` and
/// `Post_1`, one per response); this re-encodes one as the other.
func reshape<From: Encodable, To: Decodable>(_ value: From, as _: To.Type = To.self) throws -> To {
    try JSONDecoder().decode(To.self, from: JSONEncoder().encode(value))
}

extension User {
    /// What to call someone: their display name, else their username.
    var shownName: String { displayName?.isEmpty == false ? displayName! : username }
}
