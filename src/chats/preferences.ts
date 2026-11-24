import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { MUTED_FOREVER_MS, type ChatMuteDuration } from "../Api.ts";
import { chatParticipants, chats } from "../db/schema.ts";

// A participant's own settings for a chat (issue #900): muted, archived and
// pinned. Private to them, and shared by the list, the unread total and the
// `Chat` view.

const HOUR_MS = 60 * 60 * 1000;

const MUTE_MS: Record<Exclude<ChatMuteDuration, "always">, number> = {
  "8h": 8 * HOUR_MS,
  "1w": 7 * 24 * HOUR_MS,
};

export const muteUntil = (duration: ChatMuteDuration, now: Date): Date =>
  new Date(
    duration === "always"
      ? MUTED_FOREVER_MS
      : now.getTime() + MUTE_MS[duration],
  );

// When archiving a chat whose newest activity is `updatedAt`: strictly after
// it, whatever this replica's clock says, or it wouldn't count as archived.
export const archiveAt = (updatedAt: Date, now: Date): Date =>
  new Date(Math.max(now.getTime(), updatedAt.getTime() + 1));

// A new message un-archives the chat. That's derived rather than written by
// the send path: a chat is archived only while nothing has happened in it
// since, and only a message moves `chats.updated_at`. So a send writes to no
// participant row, and one through an old replica un-archives just the same.
// `coalesce`d so it can be negated.
export const isArchived = sql<boolean>`coalesce(${chatParticipants.archivedAt} > ${chats.updatedAt}, false)`;

export const isPinned = sql<boolean>`(${chatParticipants.pinnedAt} IS NOT NULL)`;

// Not muted right now; a mute that has run out counts as none.
const notMuted = (now: Date) =>
  or(
    isNull(chatParticipants.mutedUntil),
    lte(chatParticipants.mutedUntil, now),
  );

// What the unread total counts: accepted chats (message requests stay out of
// the badge, issue #785) that are neither muted nor archived.
export const countsTowardUnreadTotal = (now: Date) =>
  and(
    eq(chatParticipants.requestPending, false),
    notMuted(now),
    eq(isArchived, false),
  );

export const unpinnedOnly = isNull(chatParticipants.pinnedAt);

// The `Chat` view's fields for a participant row.
export const toChatPreferences = (
  row: {
    readonly mutedUntil: Date | null;
    readonly archivedAt: Date | null;
    readonly pinnedAt: Date | null;
  },
  updatedAt: Date,
) => ({
  mutedUntil:
    row.mutedUntil && row.mutedUntil.getTime() > Date.now()
      ? row.mutedUntil.getTime()
      : null,
  archived:
    row.archivedAt !== null && row.archivedAt.getTime() > updatedAt.getTime(),
  pinned: row.pinnedAt !== null,
});
