import { eq } from "drizzle-orm";
import { Effect } from "effect";
import {} from "../Api.ts";
import { CurrentUser } from "../Auth.ts";
import { deleteAvatarObjects } from "../avatars.ts";
import { users } from "../db/schema.ts";
import { type UsersDeps, type UsersHandlers } from "./handlerKit.ts";
import { toPublicUser, toUserProfile } from "./userViews.ts";
import { dbQuery } from "../Db.ts";
import { storeAvatarUpload } from "../avatarUpload.ts";

export const profileHandlers = ({
  db,
  storage,
  limiter,
  connections,
}: UsersDeps) =>
  ({
    updateProfile: ({ payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;

        // Full-replace (see UpdateProfileBody's comment in Api.ts) also
        // clears any uploaded avatar — `avatarUrl` and the uploaded avatar
        // (legacy base64 columns + the object-storage `*Key` columns) are
        // mutually exclusive, so a caller explicitly setting (or clearing)
        // `avatarUrl` here always means "stop using the uploaded one".
        // `uploadAvatar` below is the inverse. Read the current `*Key` tokens
        // first so their storage objects can be swept once the row is cleared
        // (a `RETURNING` list reflects post-update values, i.e. the nulls).
        const prevRows = yield* dbQuery(() =>
          db
            .select({
              avatarSmallKey: users.avatarSmallKey,
              avatarMediumKey: users.avatarMediumKey,
              avatarLargeKey: users.avatarLargeKey,
            })
            .from(users)
            .where(eq(users.id, currentUser.id))
            .limit(1),
        );
        const prev = prevRows[0];

        const rows = yield* dbQuery(() =>
          db
            .update(users)
            .set({
              displayName: payload.displayName,
              avatarUrl: payload.avatarUrl,
              avatarSmall: null,
              avatarMedium: null,
              avatarLarge: null,
              avatarSmallKey: null,
              avatarMediumKey: null,
              avatarLargeKey: null,
              // Omitted means "keep" (see UpdateProfileBody in Api.ts) —
              // Drizzle leaves an `undefined` column out of the SET list.
              bio: payload.bio,
            })
            .where(eq(users.id, currentUser.id))
            .returning({
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
              bio: users.bio,
            }),
        );
        const updated = rows[0];
        if (!updated)
          return yield* Effect.die(new Error("UPDATE returned no rows"));

        yield* deleteAvatarObjects(storage, [
          prev?.avatarSmallKey ?? null,
          prev?.avatarMediumKey ?? null,
          prev?.avatarLargeKey ?? null,
        ]);
        return toUserProfile(updated);
      }),
    uploadAvatar: ({ payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;

        const keys = yield* storeAvatarUpload(
          limiter,
          storage,
          `avatar-upload:account:${currentUser.id}`,
          payload,
        );

        // The tokens the row points at *before* this upload — their objects
        // become orphans once the row is repointed below, so sweep them
        // afterwards. Read before the UPDATE (its RETURNING would hand back
        // the post-update values, not these).
        const prevRows = yield* dbQuery(() =>
          db
            .select({
              avatarSmallKey: users.avatarSmallKey,
              avatarMediumKey: users.avatarMediumKey,
              avatarLargeKey: users.avatarLargeKey,
            })
            .from(users)
            .where(eq(users.id, currentUser.id))
            .limit(1),
        );
        const prev = prevRows[0];

        // Repoint the row at the freshly stored variants, nulling the legacy
        // base64 columns at the same time so a pre-#289 avatar's bytes stop
        // riding along in the row.
        const rows = yield* dbQuery(() =>
          db
            .update(users)
            .set({
              avatarUrl: null,
              avatarSmall: null,
              avatarMedium: null,
              avatarLarge: null,
              ...keys,
            })
            .where(eq(users.id, currentUser.id))
            .returning({
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
            }),
        );
        const updated = rows[0];
        if (!updated)
          return yield* Effect.die(new Error("UPDATE returned no rows"));

        yield* deleteAvatarObjects(storage, [
          prev?.avatarSmallKey ?? null,
          prev?.avatarMediumKey ?? null,
          prev?.avatarLargeKey ?? null,
        ]);
        return toPublicUser(updated);
      }),
    updateStatus: ({ payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;

        // Omitted entirely means "never expires"; `requireStatusForExpiry`
        // in Api.ts already rejects it alongside a fully-cleared status.
        const statusExpiresAt =
          payload.expiresInMinutes !== undefined
            ? new Date(Date.now() + payload.expiresInMinutes * 60_000)
            : null;

        const rows = yield* dbQuery(() =>
          db
            .update(users)
            .set({
              statusText: payload.statusText,
              statusEmoji: payload.statusEmoji,
              statusExpiresAt,
            })
            .where(eq(users.id, currentUser.id))
            .returning({
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
            }),
        );
        const updated = rows[0];
        if (!updated)
          return yield* Effect.die(new Error("UPDATE returned no rows"));

        const publicUser = toPublicUser(updated);
        yield* connections.notifyContacts(currentUser.id, {
          type: "status_changed",
          userId: currentUser.id,
          statusText: publicUser.statusText,
          statusEmoji: publicUser.statusEmoji,
          statusExpiresAt: publicUser.statusExpiresAt,
        });
        return publicUser;
      }),
  }) satisfies UsersHandlers;
