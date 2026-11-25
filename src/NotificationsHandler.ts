import { HttpApiBuilder } from "effect/http-api";
import { alias } from "drizzle-orm/pg-core";
import {
  and,
  count,
  desc,
  eq,
  isNull,
  lt,
  notInArray,
  sql,
  type SQL,
} from "drizzle-orm";
import { Effect } from "effect";
import {
  ChatApi,
  DEFAULT_NOTIFICATIONS_LIMIT,
  InvalidNotificationRequest,
  NotFound,
  type GameId,
  type Notification,
  NotificationType,
  type NotificationPreferences,
} from "./Api.ts";
import { CurrentUser } from "./Auth.ts";
import { hiddenAuthorIds, type Viewer } from "./blocks.ts";
import { Db, type DrizzleDb, dbQuery } from "./Db.ts";
import {
  comments,
  notificationPreferences,
  notifications,
  posts,
  users,
} from "./db/schema.ts";
import { notifyInboxChanged } from "./notifications.ts";
import { RealtimeConnections } from "./Realtime.ts";

import { publicUserColumns, toPublicUser } from "./users/userViews.ts";

// Read side of the notification inbox (issue #317). Rows are written by the
// handlers whose actions cause them — see src/notifications.ts.

// Long enough to recognize which comment/post it was, short enough for one
// line in the inbox.
const EXCERPT_LENGTH = 140;

const toExcerpt = (text: string | null): string | null => {
  if (text === null) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return null;
  return flat.length > EXCERPT_LENGTH
    ? `${flat.slice(0, EXCERPT_LENGTH - 1).trimEnd()}…`
    : flat;
};

const encodeCursor = (id: number): string =>
  Buffer.from(String(id)).toString("base64url");

const decodeCursor = (cursor: string): number | null => {
  const id = Number(Buffer.from(cursor, "base64url").toString());
  return Number.isInteger(id) ? id : null;
};

// Everything the caller should see: their own rows, minus any from someone
// they've since blocked or muted, or who blocked them — a block made *after* a notification
// landed hides it too, rather than leaving that person's name in the inbox.
const visibleTo = async (db: DrizzleDb, viewer: Viewer): Promise<SQL> => {
  const hidden = await hiddenAuthorIds(db, viewer);
  const own = eq(notifications.userId, viewer.id);
  return hidden.length > 0
    ? and(own, notInArray(notifications.actorId, hidden))!
    : own;
};

const unreadCount = (db: DrizzleDb, viewer: Viewer) =>
  dbQuery(async () => {
    const [row] = await db
      .select({ total: count() })
      .from(notifications)
      .where(and(await visibleTo(db, viewer), isNull(notifications.readAt)));
    return Number(row?.total ?? 0);
  });

const preferencesOf = (
  db: DrizzleDb,
  userId: number,
): Effect.Effect<NotificationPreferences> =>
  dbQuery(() =>
    db
      .select({
        type: notificationPreferences.type,
        enabled: notificationPreferences.enabled,
      })
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, userId)),
  ).pipe(
    Effect.map((rows) => {
      const stored = new Map(rows.map((row) => [row.type, row.enabled]));
      const on = (type: NotificationType) => stored.get(type) ?? true;
      return {
        comment: on("comment"),
        reply: on("reply"),
        reaction: on("reaction"),
        mention: on("mention"),
        game_invite: on("game_invite"),
        game_record: on("game_record"),
      };
    }),
  );

const actors = alias(users, "actor");

export const NotificationsHandlerLive = HttpApiBuilder.group(
  ChatApi,
  "notifications",
  Effect.fn(function* (handlers) {
    const connections = yield* RealtimeConnections;
    const db = yield* Db;
    return handlers
      .handle("listNotifications", ({ query: urlParams }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;
          const limit = urlParams.limit ?? DEFAULT_NOTIFICATIONS_LIMIT;

          let before: number | null = null;
          if (urlParams.cursor !== undefined) {
            before = decodeCursor(urlParams.cursor);
            if (before === null)
              return yield* Effect.fail(
                new InvalidNotificationRequest({ message: "Invalid cursor" }),
              );
          }

          // One past `limit` to derive `nextCursor` without a COUNT, same
          // trick as the other keyset-paginated lists.
          const fetched = yield* dbQuery(async () => {
            const visible = await visibleTo(db, currentUser);
            return db
              .select({
                id: notifications.id,
                type: notifications.type,
                postId: notifications.postId,
                commentId: notifications.commentId,
                emoji: notifications.emoji,
                game: notifications.game,
                lobbyId: notifications.lobbyId,
                readAt: notifications.readAt,
                createdAt: notifications.createdAt,
                postBody: posts.body,
                commentContent: comments.content,
                actor: {
                  id: actors.id,
                  username: actors.username,
                  displayName: actors.displayName,
                  avatarUrl: actors.avatarUrl,
                  avatarSmallKey: actors.avatarSmallKey,
                  avatarMediumKey: actors.avatarMediumKey,
                  avatarLargeKey: actors.avatarLargeKey,
                  role: actors.role,
                  statusText: actors.statusText,
                  statusEmoji: actors.statusEmoji,
                  statusExpiresAt: actors.statusExpiresAt,
                } satisfies Record<keyof typeof publicUserColumns, unknown>,
              })
              .from(notifications)
              .innerJoin(actors, eq(actors.id, notifications.actorId))
              .leftJoin(posts, eq(posts.id, notifications.postId))
              .leftJoin(comments, eq(comments.id, notifications.commentId))
              .where(
                before !== null
                  ? and(visible, lt(notifications.id, before))
                  : visible,
              )
              .orderBy(desc(notifications.id))
              .limit(limit + 1);
          });

          const hasMore = fetched.length > limit;
          const rows = fetched.slice(0, limit);
          const lastRow = rows[rows.length - 1];

          return {
            notifications: rows.map((row): Notification => ({
              id: row.id,
              type: row.type as NotificationType,
              actor: toPublicUser(row.actor),
              postId: row.postId,
              commentId: row.commentId,
              emoji: row.emoji,
              game: row.game as GameId | null,
              lobbyId: row.lobbyId,
              excerpt: toExcerpt(
                row.commentId !== null ? row.commentContent : row.postBody,
              ),
              read: row.readAt !== null,
              createdAt: row.createdAt.getTime(),
            })),
            limit,
            nextCursor: hasMore && lastRow ? encodeCursor(lastRow.id) : null,
            unreadCount: yield* unreadCount(db, currentUser),
          };
        }),
      )
      .handle("getUnreadNotificationCount", () =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;
          return { count: yield* unreadCount(db, currentUser) };
        }),
      )
      .handle("getNotificationPreferences", () =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;
          return yield* preferencesOf(db, currentUser.id);
        }),
      )
      .handle("updateNotificationPreferences", ({ payload }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;
          const rows = NotificationType.literals.flatMap((type) => {
            const enabled = payload[type];
            return enabled === undefined
              ? []
              : [{ userId: currentUser.id, type, enabled }];
          });
          if (rows.length > 0) {
            yield* dbQuery(() =>
              db
                .insert(notificationPreferences)
                .values(rows)
                .onConflictDoUpdate({
                  target: [
                    notificationPreferences.userId,
                    notificationPreferences.type,
                  ],
                  set: { enabled: sql`excluded.enabled` },
                }),
            );
            // The caller's other tabs refetch their settings too.
            yield* notifyInboxChanged(connections, [currentUser.id]);
          }
          return yield* preferencesOf(db, currentUser.id);
        }),
      )
      .handle("markAllNotificationsRead", () =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;
          const updated = yield* dbQuery(() =>
            db
              .update(notifications)
              .set({ readAt: new Date() })
              .where(
                and(
                  eq(notifications.userId, currentUser.id),
                  isNull(notifications.readAt),
                ),
              )
              .returning({ id: notifications.id }),
          );
          // The caller's other tabs clear their badge too.
          if (updated.length > 0)
            yield* notifyInboxChanged(connections, [currentUser.id]);
          return { count: yield* unreadCount(db, currentUser) };
        }),
      )
      .handle("markNotificationRead", ({ params: { id } }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;
          const existing = yield* dbQuery(() =>
            db
              .select({ readAt: notifications.readAt })
              .from(notifications)
              .where(
                and(
                  eq(notifications.id, id),
                  eq(notifications.userId, currentUser.id),
                ),
              )
              .limit(1),
          );
          if (!existing[0])
            return yield* Effect.fail(
              new NotFound({ message: `Notification ${id} not found` }),
            );
          if (existing[0].readAt === null) {
            yield* dbQuery(() =>
              db
                .update(notifications)
                .set({ readAt: new Date() })
                .where(eq(notifications.id, id)),
            );
            yield* notifyInboxChanged(connections, [currentUser.id]);
          }
          return { count: yield* unreadCount(db, currentUser) };
        }),
      );
  }),
);
