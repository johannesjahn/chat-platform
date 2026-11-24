import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { CurrentUser } from "../Auth.ts";
import { dbQuery } from "../Db.ts";
import { chatParticipants } from "../db/schema.ts";
import { loadChatAs } from "./access.ts";
import { buildChat } from "./chatState.ts";
import { type ChatsDeps, type ChatsHandlers } from "./handlerKit.ts";
import { archiveAt, muteUntil } from "./preferences.ts";

export const preferenceHandlers = ({ db, storage, connections }: ChatsDeps) =>
  ({
    updateChatPreferences: ({ params: { id }, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        const row = yield* loadChatAs(db, id, currentUser, "accepted");

        const now = new Date();
        const changes: Partial<typeof chatParticipants.$inferInsert> = {};
        if (payload.mute !== undefined)
          changes.mutedUntil =
            payload.mute === null ? null : muteUntil(payload.mute, now);
        // Pinning and archiving undo each other: a chat can't be both at the
        // top of the list and out of it.
        if (payload.archived !== undefined) {
          changes.archivedAt = payload.archived
            ? archiveAt(row.updatedAt, now)
            : null;
          if (payload.archived) changes.pinnedAt = null;
        }
        if (payload.pinned !== undefined) {
          if (!payload.pinned) changes.pinnedAt = null;
          else if (payload.archived !== true) {
            changes.pinnedAt = now;
            changes.archivedAt = null;
          }
        }

        if (Object.keys(changes).length > 0) {
          yield* dbQuery(() =>
            db
              .update(chatParticipants)
              .set(changes)
              .where(
                and(
                  eq(chatParticipants.chatId, id),
                  eq(chatParticipants.userId, currentUser.id),
                ),
              ),
          );
          // Only the caller's own tabs and devices. Not a `chat_updated`:
          // nothing the others see changed, so there's no version to bump.
          yield* connections.notifyUsers([currentUser.id], {
            type: "chat_preferences_changed",
            chatId: id,
          });
        }
        return yield* buildChat(db, storage, row, currentUser.id);
      }),
  }) satisfies ChatsHandlers;
