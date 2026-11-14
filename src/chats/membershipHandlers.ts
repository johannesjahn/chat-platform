import { and, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import {
  Forbidden,
  InvalidChatRequest,
  MAX_GROUP_PARTICIPANTS,
  NotFound,
  type ChatParticipant,
} from "../Api.ts";
import { AttachmentStorage } from "../AttachmentStorage.ts";
import { CurrentUser } from "../Auth.ts";
import { type DrizzleDb, dbQuery } from "../Db.ts";
import { serializableTransaction } from "../serializableTransaction.ts";

import { chatParticipants, chats, type DbChat } from "../db/schema.ts";
import { type ChatsDeps, type ChatsHandlers } from "./handlerKit.ts";
import {
  existingUserIds,
  getChatOr404,
  getParticipantRole,
  isAcceptedParticipant,
  requireChatOwner,
  requireNoBlockWith,
  loadChatAs,
  requireGroupChat,
  loadGroupChatAs,
} from "./access.ts";
import {
  buildChat,
  getParticipants,
  notifyChatUpdated,
  publishChatChange,
} from "./chatState.ts";
import { newestMessageIdIn } from "./unread.ts";
import { deleteAvatarObjects } from "../avatars.ts";

// Message requests (issue #785). A participant added to a group by someone
// they share no chat with — one they're in for real, not another pending
// request, or a spammer's second group would vouch for their first — lands
// in the "request" state (`chat_participants.request_pending`). Returns the
// subset of `userIds` that applies to when `actorId` adds them; invite-link
// joins never ask, since joining through a link is the joiner's own doing.
const peer = alias(chatParticipants, "peer");

const strangersTo = (
  db: DrizzleDb,
  actorId: number,
  userIds: ReadonlyArray<number>,
): Effect.Effect<Set<number>> =>
  userIds.length === 0
    ? Effect.succeed(new Set())
    : dbQuery(() =>
        db
          .selectDistinct({ userId: chatParticipants.userId })
          .from(chatParticipants)
          .innerJoin(
            peer,
            and(
              eq(peer.chatId, chatParticipants.chatId),
              eq(peer.userId, actorId),
            ),
          )
          .where(
            and(
              inArray(chatParticipants.userId, [...userIds]),
              eq(chatParticipants.requestPending, false),
            ),
          ),
      ).pipe(
        Effect.map((rows) => {
          const known = new Set(rows.map((row) => row.userId));
          return new Set(userIds.filter((id) => !known.has(id)));
        }),
      );

// Deletes a chat row (its cascading FKs, see db/schema.ts, take care of the
// rest of the database) and then, best-effort, its group avatar's objects —
// nothing else would ever sweep them once the row stops pointing at them
// (issue #652), and `GET /avatars/:token` serves them publicly. The tokens
// come from the deleted row itself, so an avatar swapped in after the caller
// read the chat is still the one removed. Takes `db` so it runs inside a
// caller's transaction; the returned effect sweeps the objects, to run once
// that has committed.
const deleteChatRow = async (
  db: Pick<DrizzleDb, "delete">,
  storage: AttachmentStorage["Service"],
  chatId: number,
): Promise<Effect.Effect<void>> => {
  const deleted = await db.delete(chats).where(eq(chats.id, chatId)).returning({
    avatarSmallKey: chats.avatarSmallKey,
    avatarMediumKey: chats.avatarMediumKey,
    avatarLargeKey: chats.avatarLargeKey,
  });
  return Effect.forEach(
    deleted,
    (row) =>
      deleteAvatarObjects(storage, [
        row.avatarSmallKey,
        row.avatarMediumKey,
        row.avatarLargeKey,
      ]),
    { discard: true },
  );
};

// Shared by `leaveChat` and `removeParticipant`: removes `departingUserId`
// from `chatRow`, then either deletes the chat outright (if that emptied it
// — `chats`'s cascading FKs, see db/schema.ts, take care of the rest) or, if
// the departing user was the creator, reassigns `createdBy` to the
// longest-standing remaining participant so the group doesn't become
// unmanageable (issue #66) — before bumping the version either way. All in
// one transaction so a concurrent departure/removal can't see a
// half-updated state.
const departParticipant = (
  db: DrizzleDb,
  storage: AttachmentStorage["Service"],
  chatRow: DbChat,
  departingUserId: number,
): Effect.Effect<
  | { readonly deleted: true }
  | {
      readonly deleted: false;
      readonly chat: DbChat;
      readonly participants: ReadonlyArray<ChatParticipant>;
    }
> =>
  Effect.gen(function* () {
    const result = yield* dbQuery(() =>
      db.transaction(async (tx) => {
        await tx
          .delete(chatParticipants)
          .where(
            and(
              eq(chatParticipants.chatId, chatRow.id),
              eq(chatParticipants.userId, departingUserId),
            ),
          );

        const remaining = await tx
          .select({
            userId: chatParticipants.userId,
            joinedAt: chatParticipants.joinedAt,
            requestPending: chatParticipants.requestPending,
          })
          .from(chatParticipants)
          .where(eq(chatParticipants.chatId, chatRow.id));

        if (remaining.length === 0) {
          const sweepAvatar = await deleteChatRow(tx, storage, chatRow.id);
          return { deleted: true as const, sweepAvatar };
        }

        if (chatRow.createdBy === departingUserId) {
          // Someone who hasn't accepted the group yet (issue #785) only
          // inherits it if nobody else is left.
          const newOwner = [...remaining].sort(
            (a, b) =>
              Number(a.requestPending) - Number(b.requestPending) ||
              a.joinedAt.getTime() - b.joinedAt.getTime() ||
              a.userId - b.userId,
          )[0]!;
          await tx
            .update(chats)
            .set({ createdBy: newOwner.userId })
            .where(eq(chats.id, chatRow.id));
          // Keep the per-chat role in sync with `createdBy` — see the "role"
          // column comment in db/schema.ts.
          await tx
            .update(chatParticipants)
            .set({ role: "owner" })
            .where(
              and(
                eq(chatParticipants.chatId, chatRow.id),
                eq(chatParticipants.userId, newOwner.userId),
              ),
            );
        }

        const updated = await tx
          .update(chats)
          .set({ version: sql`${chats.version} + 1` })
          .where(eq(chats.id, chatRow.id))
          .returning();

        return { deleted: false as const, chat: updated[0]! };
      }),
    );

    if (result.deleted) {
      yield* result.sweepAvatar;
      return { deleted: true as const };
    }
    const participants = yield* getParticipants(db, chatRow.id);
    return { deleted: false as const, chat: result.chat, participants };
  });

export const membershipHandlers = ({ db, storage, connections }: ChatsDeps) =>
  ({
    createGroupChat: ({ payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;

        const uniqueIds = new Set(payload.participantIds);
        if (uniqueIds.size !== payload.participantIds.length)
          return yield* Effect.fail(
            new InvalidChatRequest({
              message: "Participant list contains duplicates",
            }),
          );
        if (uniqueIds.has(currentUser.id))
          return yield* Effect.fail(
            new InvalidChatRequest({
              message: "You're added to the chat automatically",
            }),
          );
        if (uniqueIds.size + 1 > MAX_GROUP_PARTICIPANTS)
          return yield* Effect.fail(
            new InvalidChatRequest({
              message: `Group chats can have at most ${MAX_GROUP_PARTICIPANTS} participants`,
            }),
          );

        const found = yield* existingUserIds(db, [...uniqueIds]);
        const missing = [...uniqueIds].filter((id) => !found.has(id));
        if (missing.length > 0)
          return yield* Effect.fail(
            new NotFound({
              message: `User${missing.length > 1 ? "s" : ""} ${missing.join(", ")} not found`,
            }),
          );
        yield* requireNoBlockWith(
          db,
          currentUser.id,
          [...uniqueIds],
          "You can't add someone to a group because of a block",
        );

        const strangers = yield* strangersTo(db, currentUser.id, [
          ...uniqueIds,
        ]);
        const now = new Date();
        const created = yield* dbQuery(() =>
          db
            .insert(chats)
            .values({
              type: "group",
              title: payload.title,
              createdBy: currentUser.id,
              createdAt: now,
              updatedAt: now,
            })
            .returning(),
        );
        const chatRow = created[0];
        if (!chatRow)
          return yield* Effect.die(new Error("INSERT returned no rows"));

        yield* dbQuery(() =>
          db.insert(chatParticipants).values(
            [currentUser.id, ...uniqueIds].map((userId) => ({
              chatId: chatRow.id,
              userId,
              joinedAt: now,
              role:
                userId === currentUser.id
                  ? ("owner" as const)
                  : ("member" as const),
              requestPending: strangers.has(userId),
              addedBy: userId === currentUser.id ? null : currentUser.id,
            })),
          ),
        );

        const participants = yield* getParticipants(db, chatRow.id);
        const participantIds = participants.map((p) => p.userId);
        yield* notifyChatUpdated(
          connections,
          chatRow.id,
          chatRow.version,
          participantIds,
        );
        // Everyone in a new group is new to it.
        yield* connections.introduceContacts(participantIds, participantIds);
        return yield* buildChat(
          db,
          storage,
          chatRow,
          currentUser.id,
          participants,
        );
      }),
    addParticipants: ({ params: { id }, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        const existing = yield* loadGroupChatAs(
          db,
          id,
          currentUser,
          "manager",
          "Only group chats can have participants added",
        );

        // Existence-check the requested users up front — unrelated to the
        // cap race below, so it doesn't need to be inside the transaction.
        const requestedIds = [...new Set(payload.participantIds)];
        const found = yield* existingUserIds(db, requestedIds);
        const missing = requestedIds.filter((userId) => !found.has(userId));
        if (missing.length > 0)
          return yield* Effect.fail(
            new NotFound({
              message: `User${missing.length > 1 ? "s" : ""} ${missing.join(", ")} not found`,
            }),
          );
        // Checked against everyone requested, including anyone already in
        // the group — re-adding them would be a no-op either way.
        yield* requireNoBlockWith(
          db,
          currentUser.id,
          requestedIds,
          "You can't add someone to a group because of a block",
        );
        const strangers = yield* strangersTo(db, currentUser.id, requestedIds);

        // Recomputing who's already a participant and enforcing the group
        // cap has to happen in the same `serializable` transaction as the
        // insert — otherwise two concurrent addParticipants calls could
        // each read the same (still-under-cap) participant count before
        // either insert commits, and together push the group over
        // MAX_GROUP_PARTICIPANTS. `onConflictDoNothing` also guards
        // against re-adding someone a concurrent call just added.
        const result = yield* serializableTransaction(db, async (tx) => {
          const currentParticipants = await tx
            .select({ userId: chatParticipants.userId })
            .from(chatParticipants)
            .where(eq(chatParticipants.chatId, id));
          const currentIds = new Set(currentParticipants.map((p) => p.userId));
          const newIds = requestedIds.filter(
            (userId) => !currentIds.has(userId),
          );

          if (currentIds.size + newIds.length > MAX_GROUP_PARTICIPANTS)
            return { ok: false as const };

          if (newIds.length > 0) {
            const now = new Date();
            await tx
              .insert(chatParticipants)
              .values(
                newIds.map((userId) => ({
                  chatId: id,
                  userId,
                  joinedAt: now,
                  lastReadMessageId: newestMessageIdIn(id),
                  requestPending: strangers.has(userId),
                  addedBy: currentUser.id,
                })),
              )
              .onConflictDoNothing();
          }
          return { ok: true as const, newIds };
        });

        if (!result.ok)
          return yield* Effect.fail(
            new InvalidChatRequest({
              message: `Group chats can have at most ${MAX_GROUP_PARTICIPANTS} participants`,
            }),
          );

        const { version, participants } = yield* publishChatChange(
          db,
          connections,
          id,
        );
        const participantIds = participants.map((p) => p.userId);
        yield* connections.introduceContacts(result.newIds, participantIds);
        return yield* buildChat(
          db,
          storage,
          { ...existing, version },
          currentUser.id,
          participants,
        );
      }),
    removeParticipant: ({ params: { id, userId } }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        const chatRow = yield* loadGroupChatAs(
          db,
          id,
          currentUser,
          "manager",
          "Only group chats can have participants removed",
        );
        if (userId === currentUser.id)
          return yield* Effect.fail(
            new InvalidChatRequest({
              message: "Use POST /chats/:id/leave to remove yourself",
            }),
          );

        const existingParticipants = yield* getParticipants(db, id);
        const target = existingParticipants.find((p) => p.userId === userId);
        if (!target)
          return yield* Effect.fail(
            new NotFound({
              message: `User ${userId} is not a participant of chat ${id}`,
            }),
          );
        if (existingParticipants.length <= 1)
          return yield* Effect.fail(
            new InvalidChatRequest({
              message:
                "Cannot remove the last participant — delete the chat instead",
            }),
          );
        // A chat-level admin can remove other members/admins but not the
        // owner — otherwise an admin could force the automatic
        // reassignment in `departParticipant` to hand ownership to
        // whoever's next in line, effectively deposing the owner. Only a
        // site-wide admin (already past `requireChatManager` here) may.
        if (target.role === "owner" && currentUser.role !== "admin")
          return yield* Effect.fail(
            new Forbidden({
              message:
                "The chat owner can't be removed — transfer ownership first",
            }),
          );

        const result = yield* departParticipant(db, storage, chatRow, userId);
        if (result.deleted)
          return yield* Effect.die(
            new Error("Chat unexpectedly emptied by removeParticipant"),
          );

        yield* notifyChatUpdated(connections, id, result.chat.version, [
          userId,
          ...result.participants.map((p) => p.userId),
        ]);
        return yield* buildChat(
          db,
          storage,
          result.chat,
          currentUser.id,
          result.participants,
        );
      }),
    acceptChatRequest: ({ params: { id } }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        const row = yield* loadChatAs(db, id, currentUser, "participant");
        const accepted = yield* dbQuery(() =>
          db
            .update(chatParticipants)
            .set({ requestPending: false })
            .where(
              and(
                eq(chatParticipants.chatId, id),
                eq(chatParticipants.userId, currentUser.id),
                eq(chatParticipants.requestPending, true),
              ),
            )
            .returning({ id: chatParticipants.id }),
        );
        if (accepted.length === 0)
          return yield* buildChat(db, storage, row, currentUser.id);

        const { version, participants } = yield* publishChatChange(
          db,
          connections,
          id,
        );
        const participantIds = participants.map((p) => p.userId);
        // Presence was held back while the request was pending.
        yield* connections.introduceContacts([currentUser.id], participantIds);
        return yield* buildChat(
          db,
          storage,
          { ...row, version },
          currentUser.id,
          participants,
        );
      }),
    leaveChat: ({ params: { id } }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        const chatRow = yield* loadGroupChatAs(
          db,
          id,
          currentUser,
          "participant",
          "Only group chats can be left",
        );

        const result = yield* departParticipant(
          db,
          storage,
          chatRow,
          currentUser.id,
        );
        if (result.deleted) {
          yield* connections.notifyUsers([currentUser.id], {
            type: "chat_deleted",
            chatId: id,
          });
          return;
        }

        yield* notifyChatUpdated(connections, id, result.chat.version, [
          currentUser.id,
          ...result.participants.map((p) => p.userId),
        ]);
      }),
    deleteChat: ({ params: { id } }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        yield* loadGroupChatAs(
          db,
          id,
          currentUser,
          "manager",
          "Only group chats can be deleted",
        );

        const participants = yield* getParticipants(db, id);
        const sweepAvatar = yield* dbQuery(() =>
          deleteChatRow(db, storage, id),
        );

        yield* connections.notifyUsers(
          participants.map((p) => p.userId),
          { type: "chat_deleted", chatId: id },
        );
        yield* sweepAvatar;
      }),
    transferOwnership: ({ params: { id }, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        const chatRow = yield* getChatOr404(db, id);
        yield* requireGroupChat(
          chatRow,
          "Only group chats have an owner to transfer",
        );

        // Normally owner/site-admin-only, but an ownerless chat (createdBy
        // null — see Chat.createdBy in Api.ts) can be claimed by any
        // current participant, so it doesn't stay permanently
        // unmanageable once its creator's account is gone (issue #66).
        // Not by someone the chat is still a request for (issue #808).
        const canClaim =
          chatRow.createdBy === null &&
          (yield* isAcceptedParticipant(db, id, currentUser.id));
        if (!canClaim) yield* requireChatOwner(db, currentUser, chatRow);

        const participants = yield* getParticipants(db, id);
        if (!participants.some((p) => p.userId === payload.userId))
          return yield* Effect.fail(
            new NotFound({
              message: `User ${payload.userId} is not a participant of chat ${id}`,
            }),
          );

        const previousOwnerId = chatRow.createdBy;
        const row = yield* dbQuery(() =>
          db.transaction(async (tx) => {
            const updated = await tx
              .update(chats)
              .set({
                createdBy: payload.userId,
                version: sql`${chats.version} + 1`,
              })
              .where(eq(chats.id, id))
              .returning();
            // Keep per-chat roles in sync with `createdBy`: the new owner
            // is promoted, and the previous owner (if they're still a
            // participant and aren't the same person, e.g. re-claiming) is
            // demoted all the way to "member" — an explicit transfer hands
            // off every management right, same as the old creator-only
            // behavior this replaces (issue #220), rather than leaving
            // them as an "admin" who could still act on the chat.
            await tx
              .update(chatParticipants)
              .set({ role: "owner" })
              .where(
                and(
                  eq(chatParticipants.chatId, id),
                  eq(chatParticipants.userId, payload.userId),
                ),
              );
            if (
              previousOwnerId !== null &&
              previousOwnerId !== payload.userId
            ) {
              await tx
                .update(chatParticipants)
                .set({ role: "member" })
                .where(
                  and(
                    eq(chatParticipants.chatId, id),
                    eq(chatParticipants.userId, previousOwnerId),
                  ),
                );
            }
            return updated[0];
          }),
        );
        if (!row)
          return yield* Effect.die(new Error("UPDATE returned no rows"));

        // Refetch rather than reusing `participants` — the transaction
        // above just changed the new/previous owner's roles, and the
        // response should reflect that.
        const refreshedParticipants = yield* getParticipants(db, id);
        yield* notifyChatUpdated(
          connections,
          id,
          row.version,
          refreshedParticipants.map((p) => p.userId),
        );
        return yield* buildChat(
          db,
          storage,
          row,
          currentUser.id,
          refreshedParticipants,
        );
      }),
    updateParticipantRole: ({ params: { id, userId }, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        const chatRow = yield* loadGroupChatAs(
          db,
          id,
          currentUser,
          "owner",
          "Only group chats have participant roles",
        );

        if (userId === chatRow.createdBy)
          return yield* Effect.fail(
            new InvalidChatRequest({
              message: "Use POST /chats/:id/owner to change the owner's role",
            }),
          );

        const targetRole = yield* getParticipantRole(db, id, userId);
        if (targetRole === null)
          return yield* Effect.fail(
            new NotFound({
              message: `User ${userId} is not a participant of chat ${id}`,
            }),
          );

        yield* dbQuery(() =>
          db
            .update(chatParticipants)
            .set({ role: payload.role })
            .where(
              and(
                eq(chatParticipants.chatId, id),
                eq(chatParticipants.userId, userId),
              ),
            ),
        );

        const { version, participants } = yield* publishChatChange(
          db,
          connections,
          id,
        );
        return yield* buildChat(
          db,
          storage,
          { ...chatRow, version },
          currentUser.id,
          participants,
        );
      }),
  }) satisfies ChatsHandlers;
