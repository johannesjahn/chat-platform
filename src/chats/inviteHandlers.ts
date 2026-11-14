import { and, count, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { Effect } from "effect";
import {
  InvalidChatRequest,
  MAX_GROUP_PARTICIPANTS,
  MAX_INVITES_PER_CHAT,
  NotFound,
  type ChatInvite,
} from "../Api.ts";
import { CurrentUser } from "../Auth.ts";
import { serializableTransaction } from "../serializableTransaction.ts";
import {
  chatInvites,
  chatParticipants,
  type DbChatInvite,
} from "../db/schema.ts";
import { type ChatsDeps, type ChatsHandlers } from "./handlerKit.ts";
import {
  getChatOr404,
  isParticipant,
  requireChatManager,
  requireNoBlockWith,
} from "./access.ts";
import {
  buildChat,
  bumpChatVersion,
  getParticipants,
  notifyChatUpdated,
} from "./chatState.ts";
import { newestMessageIdIn } from "./unread.ts";
import { dbQuery } from "../Db.ts";

const toApiChatInvite = (row: DbChatInvite): ChatInvite => ({
  id: row.id,
  chatId: row.chatId,
  code: row.code,
  createdBy: row.createdBy,
  createdAt: row.createdAt.getTime(),
  expiresAt: row.expiresAt ? row.expiresAt.getTime() : null,
  maxUses: row.maxUses,
  useCount: row.useCount,
  revokedAt: row.revokedAt ? row.revokedAt.getTime() : null,
});

export const inviteHandlers = ({ db, storage, connections }: ChatsDeps) =>
  ({
    createChatInvite: ({ params: { id }, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        const chatRow = yield* getChatOr404(db, id);
        if (chatRow.type !== "group")
          return yield* Effect.fail(
            new InvalidChatRequest({
              message: "Only group chats support invite links",
            }),
          );
        yield* requireChatManager(db, currentUser, chatRow);

        const now = new Date();
        // Only still-active invites (not revoked, not expired) count
        // toward the cap — a revoked or expired one no longer occupies a
        // "slot" a caller could ever redeem, so it shouldn't keep this
        // chat permanently stuck at the limit (matches the "revoke an old
        // one first" wording below: revoking must actually free a slot).
        const existingCount = yield* dbQuery(() =>
          db
            .select({ total: count() })
            .from(chatInvites)
            .where(
              and(
                eq(chatInvites.chatId, id),
                isNull(chatInvites.revokedAt),
                or(
                  isNull(chatInvites.expiresAt),
                  gt(chatInvites.expiresAt, now),
                ),
              ),
            ),
        ).pipe(Effect.map((rows) => rows[0]?.total ?? 0));
        if (existingCount >= MAX_INVITES_PER_CHAT)
          return yield* Effect.fail(
            new InvalidChatRequest({
              message: `This chat has reached its limit of ${MAX_INVITES_PER_CHAT} active invites — revoke an old one first`,
            }),
          );
        const created = yield* dbQuery(() =>
          db
            .insert(chatInvites)
            .values({
              chatId: id,
              code: crypto.randomUUID().replaceAll("-", ""),
              createdBy: currentUser.id,
              createdAt: now,
              expiresAt:
                payload.expiresInHours !== undefined
                  ? new Date(now.getTime() + payload.expiresInHours * 3_600_000)
                  : null,
              maxUses: payload.maxUses ?? null,
            })
            .returning(),
        );
        const row = created[0];
        if (!row)
          return yield* Effect.die(new Error("INSERT returned no rows"));
        return toApiChatInvite(row);
      }),
    listChatInvites: ({ params: { id } }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        const chatRow = yield* getChatOr404(db, id);
        yield* requireChatManager(db, currentUser, chatRow);

        const rows = yield* dbQuery(() =>
          db
            .select()
            .from(chatInvites)
            .where(eq(chatInvites.chatId, id))
            .orderBy(desc(chatInvites.createdAt)),
        );
        return rows.map(toApiChatInvite);
      }),
    revokeChatInvite: ({ params: { id, inviteId } }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        const chatRow = yield* getChatOr404(db, id);
        yield* requireChatManager(db, currentUser, chatRow);

        // Only matches a still-active invite (`revokedAt IS NULL`) — an
        // already-revoked one 404s on a second call rather than silently
        // no-op'ing, so a caller can tell "I revoked it" from "someone
        // else already had".
        const updated = yield* dbQuery(() =>
          db
            .update(chatInvites)
            .set({ revokedAt: new Date() })
            .where(
              and(
                eq(chatInvites.id, inviteId),
                eq(chatInvites.chatId, id),
                isNull(chatInvites.revokedAt),
              ),
            )
            .returning({ id: chatInvites.id }),
        );
        if (updated.length === 0)
          return yield* Effect.fail(
            new NotFound({
              message: `Invite ${inviteId} not found (or already revoked) in chat ${id}`,
            }),
          );
      }),
    joinChatViaInvite: ({ params: { code } }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;

        const rows = yield* dbQuery(() =>
          db
            .select()
            .from(chatInvites)
            .where(eq(chatInvites.code, code))
            .limit(1),
        );
        const invite = rows[0];
        if (!invite)
          return yield* Effect.fail(
            new NotFound({ message: "Invite not found" }),
          );
        if (invite.revokedAt !== null)
          return yield* Effect.fail(
            new InvalidChatRequest({
              message: "This invite has been revoked",
            }),
          );
        if (
          invite.expiresAt !== null &&
          invite.expiresAt.getTime() <= Date.now()
        )
          return yield* Effect.fail(
            new InvalidChatRequest({ message: "This invite has expired" }),
          );
        // The plain read above is just a fast-path rejection for an
        // already-obviously-exhausted invite — the authoritative check is
        // the guarded UPDATE inside the transaction below, which is immune
        // to the TOCTOU race two concurrent redemptions of a
        // `maxUses`-limited invite would otherwise hit if this were the
        // only check.
        if (invite.maxUses !== null && invite.useCount >= invite.maxUses)
          return yield* Effect.fail(
            new InvalidChatRequest({
              message: "This invite has reached its use limit",
            }),
          );

        const chatRow = yield* getChatOr404(db, invite.chatId);
        const alreadyIn = yield* isParticipant(db, chatRow.id, currentUser.id);
        if (alreadyIn)
          return yield* buildChat(db, storage, chatRow, currentUser.id);
        // An invite is its creator asking you in — not honoured across a
        // block, either way round (issue #757).
        yield* requireNoBlockWith(
          db,
          currentUser.id,
          [invite.createdBy],
          "You can't join this chat because of a block",
        );

        // Participant cap, `useCount` bump, and the join itself all run
        // inside one `serializable` transaction, same reasoning as
        // `addParticipants` for the cap. The `useCount` bump is additionally
        // guarded by a conditional `WHERE useCount < maxUses` (skipped
        // entirely when unlimited) rather than just re-reading `useCount` —
        // two concurrent redemptions of a `maxUses: 1` invite could
        // otherwise both read "0 < 1" and both proceed. Ordered cap-check
        // first, then the guarded bump, then the insert, so a request that
        // fails either check never mutates `chatInvites` or
        // `chatParticipants`.
        //
        // `alreadyIn` above is only a fast path: two concurrent joins by
        // the same user (a double-tap) both pass it, and when the loser is
        // aborted and retried its rerun must see the winner's row — or it
        // would bump `useCount` again and then trip the participant
        // unique constraint. So membership is re-checked in here too.
        const result = yield* serializableTransaction(db, async (tx) => {
          const currentParticipants = await tx
            .select({ userId: chatParticipants.userId })
            .from(chatParticipants)
            .where(eq(chatParticipants.chatId, chatRow.id));
          if (currentParticipants.some((p) => p.userId === currentUser.id))
            return { ok: true as const, joined: false };
          if (currentParticipants.length >= MAX_GROUP_PARTICIPANTS)
            return { ok: false as const, reason: "cap" as const };

          const useCountGuard =
            invite.maxUses !== null
              ? and(
                  eq(chatInvites.id, invite.id),
                  lt(chatInvites.useCount, invite.maxUses),
                )
              : eq(chatInvites.id, invite.id);
          const bumped = await tx
            .update(chatInvites)
            .set({ useCount: sql`${chatInvites.useCount} + 1` })
            .where(useCountGuard)
            .returning({ id: chatInvites.id });
          if (bumped.length === 0)
            return { ok: false as const, reason: "maxUses" as const };

          await tx.insert(chatParticipants).values({
            chatId: chatRow.id,
            userId: currentUser.id,
            joinedAt: new Date(),
            role: "member",
            lastReadMessageId: newestMessageIdIn(chatRow.id),
          });
          return { ok: true as const, joined: true };
        });
        if (!result.ok)
          return yield* Effect.fail(
            new InvalidChatRequest({
              message:
                result.reason === "maxUses"
                  ? "This invite has reached its use limit"
                  : `Group chats can have at most ${MAX_GROUP_PARTICIPANTS} participants`,
            }),
          );
        if (!result.joined)
          return yield* buildChat(db, storage, chatRow, currentUser.id);

        const version = yield* bumpChatVersion(db, chatRow.id);
        const participants = yield* getParticipants(db, chatRow.id);
        const participantIds = participants.map((p) => p.userId);
        yield* notifyChatUpdated(
          connections,
          chatRow.id,
          version,
          participantIds,
        );
        yield* connections.introduceContacts([currentUser.id], participantIds);
        return yield* buildChat(
          db,
          storage,
          { ...chatRow, version },
          currentUser.id,
          participants,
        );
      }),
  }) satisfies ChatsHandlers;
