import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { Schema } from "effect";
import { Authentication } from "../Auth.ts";
import { NotFound } from "./errors.ts";
import { GameId } from "./games.ts";
import { User } from "./users.ts";

// --- Notifications (issue #317, see NotificationsHandler.ts) ----------------
//
// What happened to the caller's content or to them directly:
//  - "comment":     `actor` commented on the caller's post.
//  - "reply":       `actor` replied to the caller's comment.
//  - "reaction":    `actor` reacted with `emoji` to the caller's post (only
//                   `postId` set) or comment (`commentId` set too).
//  - "mention":     `actor` @mentioned the caller in a post (only `postId`)
//                   or a comment/reply (`commentId` set too).
//  - "game_invite": `actor` invited the caller into lobby `lobbyId` of
//                   `game`.
//  - "game_record": `actor` took the caller's #1 spot on `game`'s all-time
//                   leaderboard.
export const NotificationType = Schema.Literals([
  "comment",
  "reply",
  "reaction",
  "mention",
  "game_invite",
  "game_record",
]).annotate({ identifier: "NotificationType" });

export type NotificationType = typeof NotificationType.Type;

export const Notification = Schema.Struct({
  id: Schema.Finite,
  type: NotificationType,
  actor: User,
  postId: Schema.NullOr(Schema.Finite),
  commentId: Schema.NullOr(Schema.Finite),
  emoji: Schema.NullOr(Schema.String),
  game: Schema.NullOr(GameId),
  lobbyId: Schema.NullOr(Schema.Finite),
  // A short plain-text slice of the comment (when `commentId` is set) or
  // post the notification is about, read live at request time — so it
  // reflects edits. Null for game notifications and non-text posts.
  excerpt: Schema.NullOr(Schema.String),
  read: Schema.Boolean,
  createdAt: Schema.Finite,
}).annotate({ identifier: "Notification" });

export type Notification = typeof Notification.Type;

export const DEFAULT_NOTIFICATIONS_LIMIT = 20;

export const MAX_NOTIFICATIONS_LIMIT = 50;

// Newest first, keyset on id. Anonymous for the reason in CLAUDE.md.
export const NotificationsPageQuery = Schema.Struct({
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_NOTIFICATIONS_LIMIT }),
    ),
  ),
});

export const NotificationsPage = Schema.Struct({
  notifications: Schema.Array(Notification),
  limit: Schema.Finite,
  nextCursor: Schema.NullOr(Schema.String),
  // Same number `GET /notifications/unread-count` returns, bundled so the
  // inbox and its badge never disagree after one fetch.
  unreadCount: Schema.Finite,
}).annotate({ identifier: "NotificationsPage" });

export const UnreadNotificationCount = Schema.Struct({
  count: Schema.Finite,
}).annotate({ identifier: "UnreadNotificationCount" });

export class InvalidNotificationRequest extends Schema.TaggedError<InvalidNotificationRequest>()(
  "InvalidNotificationRequest",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

const NotificationIdPath = Schema.Struct({ id: Schema.Int });

export const NotificationsGroup = HttpApiGroup.make("notifications")
  .add(
    HttpApiEndpoint.get("listNotifications", "/notifications", {
      query: NotificationsPageQuery,
      success: NotificationsPage,
      error: InvalidNotificationRequest,
    }).middleware(Authentication),
  )
  .add(
    // The header bell's badge — cheap enough to fetch on every page load.
    HttpApiEndpoint.get(
      "getUnreadNotificationCount",
      "/notifications/unread-count",
      {
        success: UnreadNotificationCount,
      },
    ).middleware(Authentication),
  )
  .add(
    // Registered ahead of `/notifications/:id/read` for the same reason as
    // `/users/by-username` vs `/users/:id`.
    HttpApiEndpoint.post(
      "markAllNotificationsRead",
      "/notifications/read-all",
      {
        success: UnreadNotificationCount,
      },
    ).middleware(Authentication),
  )
  .add(
    // Idempotent. Someone else's notification is a 404, not a 403, so ids
    // can't be probed.
    HttpApiEndpoint.post("markNotificationRead", "/notifications/:id/read", {
      params: NotificationIdPath,
      success: UnreadNotificationCount,
      error: NotFound,
    }).middleware(Authentication),
  );
