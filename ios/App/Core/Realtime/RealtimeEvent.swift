import Foundation

/// Everything the server pushes over `/ws` (src/Realtime.ts, mirrored by
/// web/src/lib/realtimeSocket.ts). Most events are id-only — "something about
/// X changed, go look" — so handlers refetch rather than patch.
enum RealtimeEvent: Sendable, Equatable {
    struct ReactionCount: Sendable, Equatable, Decodable {
        var emoji: String
        var count: Int
    }
    enum ReactionTarget: String, Sendable, Equatable, Decodable { case post, comment, message }

    case chatUpdated(chatId: Int, version: Int)
    case chatDeleted(chatId: Int)
    case postChanged(postId: Int)
    case commentChanged(postId: Int, commentId: Int)
    case reactionChanged(target: ReactionTarget, targetId: Int, chatId: Int?, reactions: [ReactionCount])
    case messagePinChanged(chatId: Int, messageId: Int, pinned: Bool)
    case presence(userId: Int, online: Bool)
    case typing(chatId: Int, userId: Int, username: String, displayName: String?)
    case statusChanged(userId: Int, statusText: String?, statusEmoji: String?, statusExpiresAt: Int?)
    case gameLobbyUpdated(lobbyId: Int)
    case gameLobbiesChanged(game: String)
    case gameProgress(lobbyId: Int, userId: Int, progress: Int)
    case gameChat(lobbyId: Int)
    case gameReaction(lobbyId: Int, userId: Int, reaction: String)
    case notificationsChanged
    /// A type this build doesn't know — ignored, never an error.
    case unknown(type: String)

    /// Decodes one frame; nil for anything that isn't a JSON object with a `type`.
    static func decode(_ text: String) -> RealtimeEvent? {
        guard let data = text.data(using: .utf8),
              let raw = try? JSONDecoder().decode(Wire.self, from: data)
        else { return nil }
        return raw.event
    }

    private struct Wire: Decodable {
        var type: String
        var chatId: Int?
        var version: Int?
        var postId: Int?
        var commentId: Int?
        var targetType: ReactionTarget?
        var targetId: Int?
        var reactions: [ReactionCount]?
        var messageId: Int?
        var pinned: Bool?
        var userId: Int?
        var online: Bool?
        var username: String?
        var displayName: String?
        var statusText: String?
        var statusEmoji: String?
        var statusExpiresAt: Int?
        var lobbyId: Int?
        var game: String?
        var progress: Int?
        var reaction: String?

        var event: RealtimeEvent? {
            switch type {
            case "chat_updated":
                guard let chatId, let version else { return nil }
                return .chatUpdated(chatId: chatId, version: version)
            case "chat_deleted":
                guard let chatId else { return nil }
                return .chatDeleted(chatId: chatId)
            case "post_changed":
                guard let postId else { return nil }
                return .postChanged(postId: postId)
            case "comment_changed":
                guard let postId, let commentId else { return nil }
                return .commentChanged(postId: postId, commentId: commentId)
            case "reaction_changed":
                guard let targetType, let targetId else { return nil }
                return .reactionChanged(target: targetType, targetId: targetId, chatId: chatId, reactions: reactions ?? [])
            case "message_pin_changed":
                guard let chatId, let messageId, let pinned else { return nil }
                return .messagePinChanged(chatId: chatId, messageId: messageId, pinned: pinned)
            case "presence":
                guard let userId, let online else { return nil }
                return .presence(userId: userId, online: online)
            case "typing":
                guard let chatId, let userId, let username else { return nil }
                return .typing(chatId: chatId, userId: userId, username: username, displayName: displayName)
            case "status_changed":
                guard let userId else { return nil }
                return .statusChanged(userId: userId, statusText: statusText, statusEmoji: statusEmoji, statusExpiresAt: statusExpiresAt)
            case "game_lobby_updated":
                guard let lobbyId else { return nil }
                return .gameLobbyUpdated(lobbyId: lobbyId)
            case "game_lobbies_changed":
                guard let game else { return nil }
                return .gameLobbiesChanged(game: game)
            case "game_progress":
                guard let lobbyId, let userId, let progress else { return nil }
                return .gameProgress(lobbyId: lobbyId, userId: userId, progress: progress)
            case "game_chat":
                guard let lobbyId else { return nil }
                return .gameChat(lobbyId: lobbyId)
            case "game_reaction":
                guard let lobbyId, let userId, let reaction else { return nil }
                return .gameReaction(lobbyId: lobbyId, userId: userId, reaction: reaction)
            case "notifications_changed":
                return .notificationsChanged
            default:
                return .unknown(type: type)
            }
        }
    }
}
