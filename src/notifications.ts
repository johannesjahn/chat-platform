import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { Effect } from "effect";
import {
  MAX_USERNAME_LENGTH,
  MAX_USERNAME_LOOKUP_COUNT,
  type NotificationType,
} from "./Api.ts";
import { recipientsMutingSender } from "./blocks.ts";
import type { DrizzleDb } from "./Db.ts";
import { RealtimeConnections } from "./Realtime.ts";
import { notifications, users } from "./db/schema.ts";

// Write-side helpers for in-app notifications (issue #317). Every handler
// that does something *to* another user's content — comment, reply, react,
// @mention, game invite, leaderboard record — goes through
// `createNotifications` here, so the suppression rules live in one place:
//  - nobody is notified about their own action;
//  - a recipient who has blocked *or* muted the actor hears nothing from
//    them — the same rule chat notifications already follow (see
//    `recipientsMutingSender` in blocks.ts);
//  - one action notifies a given recipient at most once.
// See the `notifications` table in db/schema.ts for what a row holds.

export type NotificationInput = {
  readonly userId: number;
  readonly actorId: number;
  readonly type: NotificationType;
  readonly postId?: number | null;
  readonly commentId?: number | null;
  readonly emoji?: string | null;
  readonly game?: string | null;
  readonly lobbyId?: number | null;
};

// What writing/retracting notifications needs — the handler calling it
// passes its own (see e.g. EngagementHandler.ts's group).
export type NotificationDeps = {
  readonly db: DrizzleDb;
  readonly connections: RealtimeConnections["Service"];
};

// Tells each of `userIds`' open tabs to refetch their inbox/badge.
export const notifyInboxChanged = (
  connections: RealtimeConnections["Service"],
  userIds: Iterable<number>,
) =>
  Effect.gen(function* () {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return;
    yield* connections.notifyUsers(ids, { type: "notifications_changed" });
  });

const filterRecipients = async (
  db: DrizzleDb,
  inputs: ReadonlyArray<NotificationInput>,
): Promise<NotificationInput[]> => {
  const seen = new Set<string>();
  const candidates = inputs.filter((input) => {
    if (input.userId === input.actorId) return false;
    // "One action notifies a recipient once" — keyed on everything that
    // identifies the action, so a caller passing overlapping lists (e.g. the
    // post's author is also @mentioned) can't double up the same type.
    const key = `${input.userId}:${input.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const byActor = new Map<number, NotificationInput[]>();
  for (const input of candidates) {
    const list = byActor.get(input.actorId) ?? [];
    list.push(input);
    byActor.set(input.actorId, list);
  }
  const kept: NotificationInput[] = [];
  for (const [actorId, list] of byActor) {
    const muting = await recipientsMutingSender(
      db,
      actorId,
      list.map((input) => input.userId),
    );
    kept.push(...list.filter((input) => !muting.has(input.userId)));
  }
  return kept;
};

// Best-effort, like the realtime push it triggers: the comment/reaction/
// invite that caused a notification has already been written, and failing
// that request because its side-notification couldn't be recorded would be
// worse than a missing inbox entry. Failures are logged, never raised.
export const createNotifications = (
  { db, connections }: NotificationDeps,
  inputs: ReadonlyArray<NotificationInput>,
) =>
  Effect.gen(function* () {
    if (inputs.length === 0) return;
    const kept = yield* Effect.tryPromise(() => filterRecipients(db, inputs));
    if (kept.length === 0) return;
    const now = new Date();
    yield* Effect.tryPromise(() =>
      db.insert(notifications).values(
        kept.map((input) => ({
          userId: input.userId,
          actorId: input.actorId,
          type: input.type,
          postId: input.postId ?? null,
          commentId: input.commentId ?? null,
          emoji: input.emoji ?? null,
          game: input.game ?? null,
          lobbyId: input.lobbyId ?? null,
          createdAt: now,
        })),
      ),
    );
    yield* notifyInboxChanged(
      connections,
      kept.map((input) => input.userId),
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("notifications: failed to record notifications").pipe(
        Effect.annotateLogs({ cause: String(cause) }),
      ),
    ),
  );

// Undoing a reaction takes its notification back out of the recipient's
// inbox (read or not), so toggling an emoji on and off doesn't leave a
// trail — and a re-add later notifies afresh. Best-effort, as above.
export const retractReactionNotification = (
  { db, connections }: NotificationDeps,
  target: {
    readonly actorId: number;
    readonly emoji: string;
    readonly postId?: number;
    readonly commentId?: number;
  },
) =>
  Effect.gen(function* () {
    const deleted = yield* Effect.tryPromise(() =>
      db
        .delete(notifications)
        .where(
          and(
            eq(notifications.type, "reaction"),
            eq(notifications.actorId, target.actorId),
            eq(notifications.emoji, target.emoji),
            target.commentId !== undefined
              ? eq(notifications.commentId, target.commentId)
              : and(
                  eq(notifications.postId, target.postId ?? -1),
                  isNull(notifications.commentId),
                ),
          ),
        )
        .returning({ userId: notifications.userId }),
    );
    yield* notifyInboxChanged(
      connections,
      deleted.map((row) => row.userId),
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(
        "notifications: failed to retract reaction notification",
      ).pipe(Effect.annotateLogs({ cause: String(cause) })),
    ),
  );

// `@username` mentions, parsed exactly the way the frontend renders them
// (see web/src/lib/mentions.ts — the token class, the "not preceded by a
// mention character" rule, and the trailing-punctuation trim all mirror it),
// so the server only ever notifies for a mention the reader sees as a link.
const MENTION_CHARS = "A-Za-z0-9_.-";
const MENTION_RE = new RegExp(
  `(?<![${MENTION_CHARS}])@([${MENTION_CHARS}]{1,${MAX_USERNAME_LENGTH}})`,
  "g",
);

// Distinct, lowercased usernames mentioned in `text`, capped at
// `MAX_USERNAME_LOOKUP_COUNT` exactly the way the client's
// `mentionedUsernames` caps its lookup — sorted, then sliced — so content
// naming more users than that notifies the very names that render as links,
// not merely the first ones to appear (issue #470).
export const extractMentionedUsernames = (text: string): string[] => {
  const names = new Set<string>();
  for (const match of text.matchAll(MENTION_RE)) {
    const username = match[1]!.replace(/[.-]+$/, "").toLowerCase();
    if (username.length === 0) continue;
    names.add(username);
  }
  return [...names].sort().slice(0, MAX_USERNAME_LOOKUP_COUNT);
};

const resolveMentionedUserIds = async (
  db: DrizzleDb,
  text: string,
): Promise<number[]> => {
  const names = extractMentionedUsernames(text);
  if (names.length === 0) return [];
  const rows = await db
    .select({ id: users.id })
    .from(users)
    // Same case-insensitive, index-backed match as `lookupUsersByUsername`.
    .where(inArray(sql`lower(${users.username})`, names));
  return rows.map((row) => row.id);
};

// Notifies everyone @mentioned in `content` — minus anyone already mentioned
// in `previousContent` (an edit only pings the newly added names) and anyone
// in `exclude` (e.g. the post author, who already gets a "comment"
// notification for the very same comment).
export const notifyMentions = (
  deps: NotificationDeps,
  args: {
    readonly actorId: number;
    readonly content: string;
    readonly previousContent?: string;
    readonly postId: number;
    readonly commentId?: number;
    readonly exclude?: ReadonlyArray<number>;
  },
) =>
  Effect.gen(function* () {
    const { db } = deps;
    const mentioned = yield* Effect.tryPromise(() =>
      resolveMentionedUserIds(db, args.content),
    );
    if (mentioned.length === 0) return;
    const skip = new Set(args.exclude ?? []);
    if (args.previousContent !== undefined) {
      const before = yield* Effect.tryPromise(() =>
        resolveMentionedUserIds(db, args.previousContent!),
      );
      for (const id of before) skip.add(id);
    }
    yield* createNotifications(
      deps,
      mentioned
        .filter((userId) => !skip.has(userId))
        .map((userId) => ({
          userId,
          actorId: args.actorId,
          type: "mention" as const,
          postId: args.postId,
          commentId: args.commentId ?? null,
        })),
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("notifications: failed to resolve mentions").pipe(
        Effect.annotateLogs({ cause: String(cause) }),
      ),
    ),
  );
