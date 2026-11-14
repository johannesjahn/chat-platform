import { and, count, desc, eq, inArray, lt, or } from "drizzle-orm";
import { Effect } from "effect";
import {
  ALLOWED_AVATAR_MIME_TYPES,
  AvatarTooLarge,
  DEFAULT_CHATS_LIMIT,
  InvalidAvatarUpload,
  InvalidChatRequest,
  MAX_AVATAR_UPLOAD_SIZE_BYTES,
  NotFound,
} from "../Api.ts";
import { CurrentUser } from "../Auth.ts";
import {
  avatarStorageKey,
  generateAvatarToken,
  deleteAvatarObjects,
  toAvatarVariants,
} from "../avatars.ts";
import { processAvatar } from "../ImageProcessing.ts";
import { withMediaProcessingPermit } from "../MediaProcessingLimit.ts";
import { serializableTransaction } from "../serializableTransaction.ts";

import { chatParticipants, chats } from "../db/schema.ts";
import { type ChatsDeps, type ChatsHandlers } from "./handlerKit.ts";
import {
  existingUserIds,
  getChatOr404,
  requireChatManager,
  requireParticipant,
} from "./access.ts";
import {
  buildChat,
  bumpChatVersion,
  getParticipants,
  getParticipantsForChats,
  notifyChatUpdated,
  toMessageRequest,
} from "./chatState.ts";
import { getLastMessagesForChats } from "./messageViews.ts";
import { getUnreadCountsForChats, hasUnreadFor } from "./unread.ts";
import { enforceRateLimit } from "../RateLimiter.ts";
import { dbQuery } from "../Db.ts";

// Mirrors AVATAR_UPLOAD_MAX_ATTEMPTS_PER_ACCOUNT/AVATAR_UPLOAD_WINDOW_SECONDS
// in users/profileHandlers.ts — same rationale (real image-decoding/resizing
// work, a rare deliberate action) applies to a group's avatar.
const CHAT_AVATAR_UPLOAD_MAX_ATTEMPTS_PER_ACCOUNT = 10;

const CHAT_AVATAR_UPLOAD_WINDOW_SECONDS = 60 * 60;

// Keyset cursor for `listChats` over its `updated_at desc, id desc` sort —
// see `ChatsPageQuery` in Api.ts for why this is a cursor rather than an
// offset. Encodes the last row of a page as `<updatedAtMs>:<id>`,
// base64url'd (same encoding `Jwt.ts` uses for its segments) so it survives
// round-tripping through a URL query value.
const encodeChatsCursor = (row: { updatedAt: Date; id: number }): string =>
  Buffer.from(`${row.updatedAt.getTime()}:${row.id}`).toString("base64url");

const decodeChatsCursor = (
  cursor: string,
): { updatedAt: Date; id: number } | null => {
  const decoded = Buffer.from(cursor, "base64url").toString();
  const separator = decoded.indexOf(":");
  if (separator === -1) return null;
  const updatedAtMs = Number(decoded.slice(0, separator));
  const id = Number(decoded.slice(separator + 1));
  if (!Number.isInteger(updatedAtMs) || !Number.isInteger(id)) return null;
  return { updatedAt: new Date(updatedAtMs), id };
};

export const chatHandlers = ({
  db,
  storage,
  limiter,
  connections,
}: ChatsDeps) =>
  ({
    listChats: ({ query: urlParams }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        const limit = urlParams.limit ?? DEFAULT_CHATS_LIMIT;

        let after: { updatedAt: Date; id: number } | null = null;
        if (urlParams.cursor !== undefined) {
          after = decodeChatsCursor(urlParams.cursor);
          if (!after)
            return yield* Effect.fail(
              new InvalidChatRequest({ message: "Invalid cursor" }),
            );
        }

        // Fetch one row past `limit` to derive `nextCursor` without a
        // separate `COUNT(*)` — same trick as `MessagesPage.hasMore`.
        const fetched = yield* dbQuery(() =>
          db
            .select({
              id: chats.id,
              type: chats.type,
              title: chats.title,
              createdBy: chats.createdBy,
              createdAt: chats.createdAt,
              updatedAt: chats.updatedAt,
              version: chats.version,
              avatarSmallKey: chats.avatarSmallKey,
              avatarMediumKey: chats.avatarMediumKey,
              avatarLargeKey: chats.avatarLargeKey,
              requestPending: chatParticipants.requestPending,
              addedBy: chatParticipants.addedBy,
            })
            .from(chats)
            .innerJoin(
              chatParticipants,
              and(
                eq(chatParticipants.chatId, chats.id),
                eq(chatParticipants.userId, currentUser.id),
              ),
            )
            .where(
              and(
                // Message requests (issue #785) are their own list.
                eq(
                  chatParticipants.requestPending,
                  urlParams.requests === "true",
                ),
                after
                  ? or(
                      lt(chats.updatedAt, after.updatedAt),
                      and(
                        eq(chats.updatedAt, after.updatedAt),
                        lt(chats.id, after.id),
                      ),
                    )
                  : undefined,
                urlParams.unread === "true"
                  ? hasUnreadFor(currentUser.id)
                  : undefined,
              ),
            )
            .orderBy(desc(chats.updatedAt), desc(chats.id))
            .limit(limit + 1),
        );
        const hasMore = fetched.length > limit;
        const rows = fetched.slice(0, limit);
        const lastRow = rows[rows.length - 1];
        const nextCursor =
          hasMore && lastRow ? encodeChatsCursor(lastRow) : null;

        const chatIds = rows.map((row) => row.id);
        const [participantsByChat, lastMessageByChat, unreadByChat] =
          yield* Effect.all([
            getParticipantsForChats(db, chatIds),
            getLastMessagesForChats(db, storage, chatIds, currentUser.id),
            getUnreadCountsForChats(db, chatIds, currentUser.id),
          ]);

        return {
          chats: rows.map((row) => ({
            id: row.id,
            type: row.type,
            title: row.title,
            createdBy: row.createdBy,
            createdAt: row.createdAt.getTime(),
            updatedAt: row.updatedAt.getTime(),
            version: row.version,
            participants: participantsByChat.get(row.id) ?? [],
            lastMessage: lastMessageByChat.get(row.id) ?? null,
            unreadCount: unreadByChat.get(row.id) ?? 0,
            avatarVariants: toAvatarVariants(row),
            messageRequest: toMessageRequest(row),
          })),
          limit,
          nextCursor,
        };
      }),
    getChat: ({ params: { id } }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        const row = yield* getChatOr404(db, id);
        yield* requireParticipant(db, id, currentUser.id);
        return yield* buildChat(db, storage, row, currentUser.id);
      }),
    createDirectChat: ({ payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;

        if (payload.userId === currentUser.id)
          return yield* Effect.fail(
            new InvalidChatRequest({
              message: "You can't start a chat with yourself",
            }),
          );

        const otherExists = yield* existingUserIds(db, [payload.userId]);
        if (!otherExists.has(payload.userId))
          return yield* Effect.fail(
            new NotFound({ message: `User ${payload.userId} not found` }),
          );

        // The "does a direct chat for this pair already exist" check and
        // the "create one if not" insert run inside a single `serializable`
        // transaction. Two concurrent requests for the same pair would
        // otherwise both see "no existing chat" and both create one; under
        // `serializable` isolation Postgres instead aborts one of them, and
        // `serializableTransaction` retries it — so the loser re-runs the
        // check, finds the winner's chat and returns it.
        const result = yield* serializableTransaction(db, async (tx) => {
          // A direct chat always has exactly the two participants it
          // was created with, so matching on "both ids are
          // participants of some direct chat, and it has exactly two
          // participants" uniquely identifies the (at most one)
          // existing chat for this pair.
          const existing = await tx
            .select({ chatId: chatParticipants.chatId })
            .from(chatParticipants)
            .innerJoin(chats, eq(chats.id, chatParticipants.chatId))
            .where(
              and(
                eq(chats.type, "direct"),
                inArray(chatParticipants.userId, [
                  currentUser.id,
                  payload.userId,
                ]),
              ),
            )
            .groupBy(chatParticipants.chatId)
            .having(eq(count(chatParticipants.userId), 2));

          if (existing[0]) {
            const rows = await tx
              .select()
              .from(chats)
              .where(eq(chats.id, existing[0].chatId));
            const row = rows[0];
            if (!row) throw new Error("Existing chat vanished mid-transaction");
            return { row, created: false };
          }

          const now = new Date();
          const created = await tx
            .insert(chats)
            .values({
              type: "direct",
              title: null,
              createdBy: currentUser.id,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
          const newRow = created[0];
          if (!newRow) throw new Error("INSERT returned no rows");

          await tx.insert(chatParticipants).values([
            {
              chatId: newRow.id,
              userId: currentUser.id,
              joinedAt: now,
            },
            {
              chatId: newRow.id,
              userId: payload.userId,
              joinedAt: now,
            },
          ]);

          return { row: newRow, created: true };
        });
        const chatRow = result.row;

        const participants = yield* getParticipants(db, chatRow.id);
        // A freshly created chat's row already carries its initial
        // version — nothing to bump, every participant is seeing it for
        // the first time.
        yield* notifyChatUpdated(
          connections,
          chatRow.id,
          chatRow.version,
          participants.map((p) => p.userId),
        );
        if (result.created) {
          yield* connections.introduceContacts(
            [payload.userId],
            [currentUser.id, payload.userId],
          );
        }
        return yield* buildChat(
          db,
          storage,
          chatRow,
          currentUser.id,
          participants,
        );
      }),
    updateChat: ({ params: { id }, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        const existing = yield* getChatOr404(db, id);
        if (existing.type !== "group")
          return yield* Effect.fail(
            new InvalidChatRequest({
              message: "Only group chats can be renamed",
            }),
          );
        yield* requireChatManager(db, currentUser, existing);

        const updated = yield* dbQuery(() =>
          db
            .update(chats)
            .set({ title: payload.title })
            .where(eq(chats.id, id))
            .returning(),
        );
        const row = updated[0];
        if (!row)
          return yield* Effect.die(new Error("UPDATE returned no rows"));
        const version = yield* bumpChatVersion(db, id);
        const participants = yield* getParticipants(db, id);
        yield* notifyChatUpdated(
          connections,
          id,
          version,
          participants.map((p) => p.userId),
        );
        return yield* buildChat(
          db,
          storage,
          { ...row, version },
          currentUser.id,
          participants,
        );
      }),
    uploadChatAvatar: ({ params: { id }, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        const existing = yield* getChatOr404(db, id);
        if (existing.type !== "group")
          return yield* Effect.fail(
            new InvalidChatRequest({
              message: "Only group chats can have an avatar",
            }),
          );
        yield* requireChatManager(db, currentUser, existing);

        // Bucketed by the uploading account rather than the chat, mirroring
        // `uploadAvatar` in users/profileHandlers.ts — a caller who manages
        // several groups shares one budget across all of them instead of
        // getting a fresh one per chat.
        yield* enforceRateLimit(
          limiter,
          `chat-avatar-upload:account:${currentUser.id}`,
          CHAT_AVATAR_UPLOAD_MAX_ATTEMPTS_PER_ACCOUNT,
          CHAT_AVATAR_UPLOAD_WINDOW_SECONDS,
        );

        if (
          !(ALLOWED_AVATAR_MIME_TYPES as ReadonlyArray<string>).includes(
            payload.file.contentType,
          )
        )
          return yield* Effect.fail(
            new InvalidAvatarUpload({
              message: `Unsupported file type: ${payload.file.contentType}`,
            }),
          );

        const bunFile = Bun.file(payload.file.path);
        if (bunFile.size > MAX_AVATAR_UPLOAD_SIZE_BYTES)
          return yield* Effect.fail(
            new AvatarTooLarge({
              message: `File exceeds the maximum size of ${MAX_AVATAR_UPLOAD_SIZE_BYTES} bytes`,
            }),
          );

        const processed = yield* Effect.tryPromise({
          try: async () =>
            processAvatar(await bunFile.bytes(), {
              x: payload.x,
              y: payload.y,
              size: payload.size,
            }),
          catch: (err) =>
            new InvalidAvatarUpload({
              message:
                err instanceof Error ? err.message : "Invalid avatar image",
            }),
        }).pipe(withMediaProcessingPermit);

        // Mint a fresh token per variant and push the processed bytes to
        // object storage before touching the row — same ordering rationale
        // as `uploadAvatar` in users/profileHandlers.ts (a failed upload leaves
        // at most a few orphaned objects rather than a row pointing at bytes
        // that never landed).
        const smallToken = generateAvatarToken();
        const mediumToken = generateAvatarToken();
        const largeToken = generateAvatarToken();
        yield* Effect.all(
          [
            storage.upload(
              avatarStorageKey(smallToken),
              processed.small,
              processed.contentType,
            ),
            storage.upload(
              avatarStorageKey(mediumToken),
              processed.medium,
              processed.contentType,
            ),
            storage.upload(
              avatarStorageKey(largeToken),
              processed.large,
              processed.contentType,
            ),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.orDie);

        const updated = yield* dbQuery(() =>
          db
            .update(chats)
            .set({
              avatarSmallKey: smallToken,
              avatarMediumKey: mediumToken,
              avatarLargeKey: largeToken,
            })
            .where(eq(chats.id, id))
            .returning(),
        );
        const row = updated[0];
        if (!row)
          return yield* Effect.die(new Error("UPDATE returned no rows"));
        const version = yield* bumpChatVersion(db, id);
        const participants = yield* getParticipants(db, id);
        yield* notifyChatUpdated(
          connections,
          id,
          version,
          participants.map((p) => p.userId),
        );

        yield* deleteAvatarObjects(storage, [
          existing.avatarSmallKey,
          existing.avatarMediumKey,
          existing.avatarLargeKey,
        ]);

        return yield* buildChat(
          db,
          storage,
          { ...row, version },
          currentUser.id,
          participants,
        );
      }),
    deleteChatAvatar: ({ params: { id } }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        const existing = yield* getChatOr404(db, id);
        if (existing.type !== "group")
          return yield* Effect.fail(
            new InvalidChatRequest({
              message: "Only group chats can have an avatar",
            }),
          );
        yield* requireChatManager(db, currentUser, existing);

        const updated = yield* dbQuery(() =>
          db
            .update(chats)
            .set({
              avatarSmallKey: null,
              avatarMediumKey: null,
              avatarLargeKey: null,
            })
            .where(eq(chats.id, id))
            .returning(),
        );
        const row = updated[0];
        if (!row)
          return yield* Effect.die(new Error("UPDATE returned no rows"));
        const version = yield* bumpChatVersion(db, id);
        const participants = yield* getParticipants(db, id);
        yield* notifyChatUpdated(
          connections,
          id,
          version,
          participants.map((p) => p.userId),
        );

        yield* deleteAvatarObjects(storage, [
          existing.avatarSmallKey,
          existing.avatarMediumKey,
          existing.avatarLargeKey,
        ]);

        return yield* buildChat(
          db,
          storage,
          { ...row, version },
          currentUser.id,
          participants,
        );
      }),
  }) satisfies ChatsHandlers;
