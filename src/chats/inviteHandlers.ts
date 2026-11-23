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
import { loadAuthors } from "../authors.ts";
import { toAvatarVariants } from "../avatars.ts";
import { enforceRateLimit } from "../RateLimiter.ts";
import { serializableTransaction } from "../serializableTransaction.ts";
import {
  chatInvites,
  chatParticipants,
  users,
  type DbChatInvite,
} from "../db/schema.ts";
import { type ChatsDeps, type ChatsHandlers } from "./handlerKit.ts";
import {
  getChatOr404,
  isParticipant,
  requireNoBlockWith,
  loadChatAs,
  loadGroupChatAs,
} from "./access.ts";
import { buildChat, publishChatChange } from "./chatState.ts";
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

// Whether an invite's creator may still invite people into its chat: an
// owner/admin of it, or a site admin (issue #894). Leaving, removal and
// demotion revoke a creator's links outright (`revokeInvitesBy` in
// membershipHandlers.ts); this covers rows that predate that.
const creatorStillManages = (
  db: ChatsDeps["db"],
  invite: DbChatInvite,
): Effect.Effect<boolean> =>
  dbQuery(() =>
    db
      .select({ siteRole: users.role, chatRole: chatParticipants.role })
      .from(users)
      .leftJoin(
        chatParticipants,
        and(
          eq(chatParticipants.userId, users.id),
          eq(chatParticipants.chatId, invite.chatId),
        ),
      )
      .where(eq(users.id, invite.createdBy))
      .limit(1),
  ).pipe(
    Effect.map(
      ([row]) =>
        row !== undefined &&
        (row.siteRole === "admin" ||
          row.chatRole === "owner" ||
          row.chatRole === "admin"),
    ),
  );

const BLOCKED_MESSAGE = "You can't join this chat because of a block";
const FULL_MESSAGE = `Group chats can have at most ${MAX_GROUP_PARTICIPANTS} participants`;

// Invite previews per account per window (issue #899). The 128-bit random
// codes are what keep a group private; this caps how fast one account can
// probe them, with room for a page that refetches.
const INVITE_PREVIEW_MAX_PER_ACCOUNT = 60;
const INVITE_PREVIEW_WINDOW_SECONDS = 60;

// The code's invite, if it can still be redeemed — the checks both
// `previewChatInvite` and `joinChatViaInvite` start with, so a preview
// fails exactly the way the join would. The join re-checks revocation and
// the use count inside its transaction; these are the fast path.
const loadRedeemableInvite = (
  db: ChatsDeps["db"],
  code: string,
): Effect.Effect<DbChatInvite, NotFound | InvalidChatRequest> =>
  Effect.gen(function* () {
    const rows = yield* dbQuery(() =>
      db.select().from(chatInvites).where(eq(chatInvites.code, code)).limit(1),
    );
    const invite = rows[0];
    if (!invite)
      return yield* Effect.fail(new NotFound({ message: "Invite not found" }));
    if (invite.revokedAt !== null || !(yield* creatorStillManages(db, invite)))
      return yield* Effect.fail(
        new InvalidChatRequest({ message: "This invite has been revoked" }),
      );
    if (invite.expiresAt !== null && invite.expiresAt.getTime() <= Date.now())
      return yield* Effect.fail(
        new InvalidChatRequest({ message: "This invite has expired" }),
      );
    if (invite.maxUses !== null && invite.useCount >= invite.maxUses)
      return yield* Effect.fail(
        new InvalidChatRequest({
          message: "This invite has reached its use limit",
        }),
      );
    return invite;
  });

export const inviteHandlers = ({
  db,
  storage,
  limiter,
  connections,
}: ChatsDeps) =>
  ({
    createChatInvite: ({ params: { id }, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        yield* loadGroupChatAs(
          db,
          id,
          currentUser,
          "manager",
          "Only group chats support invite links",
        );

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
        yield* loadChatAs(db, id, currentUser, "manager");

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
        yield* loadChatAs(db, id, currentUser, "manager");

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
    previewChatInvite: ({ params: { code } }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        yield* enforceRateLimit(
          limiter,
          `chat-invite-preview:account:${currentUser.id}`,
          INVITE_PREVIEW_MAX_PER_ACCOUNT,
          INVITE_PREVIEW_WINDOW_SECONDS,
        );

        const invite = yield* loadRedeemableInvite(db, code);
        const chatRow = yield* getChatOr404(db, invite.chatId);
        const alreadyMember = yield* isParticipant(
          db,
          chatRow.id,
          currentUser.id,
        );
        const memberCount = yield* dbQuery(() =>
          db
            .select({ total: count() })
            .from(chatParticipants)
            .where(eq(chatParticipants.chatId, chatRow.id)),
        ).pipe(Effect.map((rows) => rows[0]?.total ?? 0));
        // The rest of the join's checks, in its order: a member is let
        // straight back in, so only a newcomer is turned away by a block or
        // a full group.
        if (!alreadyMember) {
          yield* requireNoBlockWith(
            db,
            currentUser.id,
            [invite.createdBy],
            BLOCKED_MESSAGE,
          );
          if (memberCount >= MAX_GROUP_PARTICIPANTS)
            return yield* Effect.fail(
              new InvalidChatRequest({ message: FULL_MESSAGE }),
            );
        }

        const authors = yield* loadAuthors(db, [invite.createdBy]);
        return {
          chatId: chatRow.id,
          title: chatRow.title,
          avatarVariants: toAvatarVariants(chatRow),
          memberCount,
          alreadyMember,
          invitedBy: authors.get(invite.createdBy) ?? null,
        };
      }),
    joinChatViaInvite: ({ params: { code } }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;

        const invite = yield* loadRedeemableInvite(db, code);
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
          BLOCKED_MESSAGE,
        );

        // Participant cap, `useCount` bump, and the join itself all run
        // inside one `serializable` transaction, same reasoning as
        // `addParticipants` for the cap. The `useCount` bump is additionally
        // guarded by a conditional `WHERE useCount < maxUses` (skipped
        // entirely when unlimited) rather than just re-reading `useCount` —
        // two concurrent redemptions of a `maxUses: 1` invite could
        // otherwise both read "0 < 1" and both proceed. Ordered cap-check
        // first, then the revocation re-check and the guarded bump, then the
        // insert, so a request that fails a check never mutates
        // `chatInvites` or `chatParticipants`.
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

          // Revoked since the read above — say by its creator leaving the
          // group (issue #894). A revoke that commits after this read
          // updates the same row the bump below does, so this transaction
          // is aborted and retried rather than joining through it.
          const [current] = await tx
            .select({ revokedAt: chatInvites.revokedAt })
            .from(chatInvites)
            .where(eq(chatInvites.id, invite.id));
          if (!current || current.revokedAt !== null)
            return { ok: false as const, reason: "revoked" as const };

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
                result.reason === "revoked"
                  ? "This invite has been revoked"
                  : result.reason === "maxUses"
                    ? "This invite has reached its use limit"
                    : FULL_MESSAGE,
            }),
          );
        if (!result.joined)
          return yield* buildChat(db, storage, chatRow, currentUser.id);

        const { version, participants } = yield* publishChatChange(
          db,
          connections,
          chatRow.id,
        );
        const participantIds = participants.map((p) => p.userId);
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
