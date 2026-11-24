import { and, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import {
  Forbidden,
  InvalidChatRequest,
  MAX_GROUP_PARTICIPANTS,
  NotFound,
} from "../Api.ts";
import { CurrentUser } from "../Auth.ts";
import { type DrizzleDb, dbQuery } from "../Db.ts";
import { serializableTransaction } from "../serializableTransaction.ts";

import { chatParticipants, chats } from "../db/schema.ts";
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
import { recordChatEvents } from "./chatEvents.ts";
import { newestMessageIdIn } from "./unread.ts";
import {
  deleteChatRow,
  departParticipant,
  revokeInvitesBy,
} from "./departure.ts";

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
            await recordChatEvents(
              tx,
              id,
              newIds.map((targetId) => ({
                type: "member_added" as const,
                actorId: currentUser.id,
                targetId,
              })),
            );
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

        const result = yield* departParticipant(
          db,
          storage,
          chatRow,
          userId,
          currentUser.id,
        );
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
              await revokeInvitesBy(tx, id, previousOwnerId);
            }
            if (previousOwnerId !== payload.userId)
              await recordChatEvents(tx, id, [
                {
                  type: "owner_changed",
                  actorId: currentUser.id,
                  targetId: payload.userId,
                },
              ]);
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
          db.transaction(async (tx) => {
            await tx
              .update(chatParticipants)
              .set({ role: payload.role })
              .where(
                and(
                  eq(chatParticipants.chatId, id),
                  eq(chatParticipants.userId, userId),
                ),
              );
            if (payload.role === "member")
              await revokeInvitesBy(tx, id, userId);
            if (payload.role !== targetRole)
              await recordChatEvents(tx, id, [
                {
                  type:
                    payload.role === "admin"
                      ? "admin_granted"
                      : "admin_revoked",
                  actorId: currentUser.id,
                  targetId: userId,
                },
              ]);
          }),
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
