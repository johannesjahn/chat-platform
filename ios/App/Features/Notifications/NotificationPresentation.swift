import ChatAPI
import Foundation

/// How a notification reads and where it leads — the port of
/// `notificationTarget`/`NOTIFICATION_ICONS` (web/src/lib/notifications.ts)
/// and `describe` (web/src/components/NotificationRow.tsx). Pure, so it's
/// unit-tested without a view.
enum NotificationPresentation {
    /// Where tapping the row goes: an invite's lobby (or its game, if the
    /// lobby is unknown), a lost record's leaderboard, else the post it's
    /// about (a comment or reply opens its post). nil when nothing is left
    /// to point at — the row still marks itself read.
    static func route(for n: InboxNotification) -> Route? {
        switch n._type {
        case .gameInvite:
            if let lobbyId = n.lobbyId { return .gameLobby(lobbyId) }
            if let game = n.game { return .game(game.rawValue) }
        case .gameRecord:
            if let game = n.game { return .leaderboard(game.rawValue) }
        default:
            break
        }
        if let postId = n.postId { return .post(postId) }
        return nil
    }

    /// The sentence after the actor's name.
    static func sentence(for n: InboxNotification) -> String {
        let onComment = n.commentId != nil
        switch n._type {
        case .comment: return "commented on your post"
        case .reply: return "replied to your comment"
        case .reaction:
            let emoji = n.emoji.map { "\($0) " } ?? ""
            return "reacted \(emoji)to your \(onComment ? "comment" : "post")"
        case .mention: return "mentioned you in a \(onComment ? "comment" : "post")"
        case .gameInvite: return "invited you to play \(gameName(n.game))"
        case .gameRecord: return "took your #1 spot on the \(gameName(n.game)) leaderboard"
        }
    }

    /// The badge glyph on the actor's avatar (SF Symbols for the web's icons).
    static func symbol(for kind: NotificationKind) -> String {
        switch kind {
        case .comment: "bubble.left.fill"
        case .reply: "arrowshape.turn.up.left.fill"
        case .reaction: "heart.fill"
        case .mention: "at"
        case .gameInvite: "gamecontroller.fill"
        case .gameRecord: "trophy.fill"
        }
    }

    /// A game's display name (the web registry's `name`).
    static func gameName(_ game: Components.Schemas.GameId?) -> String {
        switch game {
        case .typing: "Type Race"
        case .drawing: "Sketchy"
        case .reflex: "Reflex Rush"
        case nil: "a game"
        }
    }

    /// What VoiceOver reads for a whole row.
    static func accessibilityLabel(for n: InboxNotification) -> String {
        var parts = ["\(n.actor.shownName) \(sentence(for: n))"]
        if let excerpt = n.excerpt { parts.append("“\(excerpt)”") }
        parts.append(TimeText.relative(n.createdAt))
        if !n.read { parts.insert("Unread", at: 0) }
        return parts.joined(separator: ", ")
    }
}
