import { toAvatarVariants } from "../avatars.ts";
import { users } from "../db/schema.ts";

// Columns every "return a User" query below selects, and the shape
// `toPublicUser` transforms them from — `avatarSmallKey`/`avatarMediumKey`/
// `avatarLargeKey` (three flat DB columns holding object-storage tokens since
// issue #289) fold into the API's single nested `avatarVariants` field of
// proxy URLs, present only when all three are set (they're always
// written/cleared together — see updateProfile/uploadAvatar below).
type UserRow = {
  id: number;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  avatarSmallKey: string | null;
  avatarMediumKey: string | null;
  avatarLargeKey: string | null;
  role: "user" | "admin";
  statusText: string | null;
  statusEmoji: string | null;
  statusExpiresAt: Date | null;
};

// A status past its `statusExpiresAt` is treated as fully unset wherever a
// user is read, rather than needing a background sweep to null the columns
// out — mirrors `toAvatarVariants`'s role of folding raw DB columns into the
// API shape. Shared with src/chats/ for the same reason `toAvatarVariants`
// is.
export const effectiveStatus = (row: {
  statusText: string | null;
  statusEmoji: string | null;
  statusExpiresAt: Date | null;
}): {
  statusText: string | null;
  statusEmoji: string | null;
  statusExpiresAt: number | null;
} => {
  if (row.statusExpiresAt && row.statusExpiresAt.getTime() <= Date.now()) {
    return { statusText: null, statusEmoji: null, statusExpiresAt: null };
  }
  return {
    statusText: row.statusText,
    statusEmoji: row.statusEmoji,
    statusExpiresAt: row.statusExpiresAt ? row.statusExpiresAt.getTime() : null,
  };
};

export const toPublicUser = (row: UserRow) => ({
  id: row.id,
  username: row.username,
  displayName: row.displayName,
  avatarUrl: row.avatarUrl,
  avatarVariants: toAvatarVariants(row),
  role: row.role,
  ...effectiveStatus(row),
});

// `getUser`/`updateProfile` return the profile view (issue #322): the public
// user plus its bio.
export const toUserProfile = (row: UserRow & { bio: string | null }) => ({
  ...toPublicUser(row),
  bio: row.bio,
});

// The `users` columns every "return a public User" query selects, folded into
// the API shape by `toPublicUser`. Named so the block/mute handlers below (and
// GamesHandler.ts) can select the same set off a join against `users` without
// re-listing it (the older handlers above still inline it, matching their
// original style).
export const publicUserColumns = {
  id: users.id,
  username: users.username,
  displayName: users.displayName,
  avatarUrl: users.avatarUrl,
  avatarSmallKey: users.avatarSmallKey,
  avatarMediumKey: users.avatarMediumKey,
  avatarLargeKey: users.avatarLargeKey,
  role: users.role,
  statusText: users.statusText,
  statusEmoji: users.statusEmoji,
  statusExpiresAt: users.statusExpiresAt,
} as const;
