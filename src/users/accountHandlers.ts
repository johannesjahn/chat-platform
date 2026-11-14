import { eq, sql } from "drizzle-orm";
import { Cache, Effect } from "effect";
import { Forbidden, InvalidCredentials, NotFound } from "../Api.ts";
import { AttachmentStorage } from "../AttachmentStorage.ts";
import { CurrentUser } from "../Auth.ts";
import { type DrizzleDb, dbQuery } from "../Db.ts";
import { attachments, users } from "../db/schema.ts";
import { type UsersDeps, type UsersHandlers } from "./handlerKit.ts";
import { deleteAvatarObjects } from "../avatars.ts";
import { enforceRateLimit } from "../RateLimiter.ts";
import { verifyPassword } from "./credentials.ts";
import { toPublicUser } from "./userViews.ts";

// Deleting an account re-verifies the password, same brute-force exposure as
// changePassword — mirrors its limit/window.
const DELETE_ACCOUNT_MAX_ATTEMPTS_PER_ACCOUNT = 5;

const DELETE_ACCOUNT_WINDOW_SECONDS = 15 * 60;

// How many attachment objects `deleteUserAndObjects` removes from the bucket
// at once — an account can have thousands, and one at a time would hold the
// delete request open for as many S3 round trips.
const ACCOUNT_OBJECT_DELETE_CONCURRENCY = 8;

// Deletes a `users` row — whose cascading/`set null` FKs (db/schema.ts) take
// care of everything else the account owns in the database — and then,
// best-effort, the storage objects that cascade would otherwise orphan for
// good: the avatar variants (`avatarTokens`, read by the caller) and every
// attachment the account uploaded (issue #652). Neither is reachable by
// AttachmentCleanup.ts's sweep, which walks `attachments` rows, so once the
// rows are gone nothing else would ever find the objects. The attachment rows
// are deleted explicitly, in the same transaction as the user, so the keys
// swept are exactly the rows removed.
const deleteUserAndObjects = (
  db: DrizzleDb,
  storage: AttachmentStorage["Service"],
  userId: number,
  avatarTokens: ReadonlyArray<string | null>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const storageKeys = yield* dbQuery(() =>
      db.transaction(async (tx) => {
        const removed = await tx
          .delete(attachments)
          .where(eq(attachments.uploaderId, userId))
          .returning({ storageKey: attachments.storageKey });
        await tx.delete(users).where(eq(users.id, userId));
        return removed.map((row) => row.storageKey);
      }),
    );

    yield* deleteAvatarObjects(storage, avatarTokens);
    yield* Effect.forEach(
      storageKeys,
      (key) => storage.delete(key).pipe(Effect.ignore),
      { discard: true, concurrency: ACCOUNT_OBJECT_DELETE_CONCURRENCY },
    );
  });

export const accountHandlers = ({
  db,
  storage,
  limiter,
  connections,
  pubsub,
  tokenVersionCache,
}: UsersDeps) =>
  ({
    deleteAccount: ({ payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;

        yield* enforceRateLimit(
          limiter,
          `delete-account:account:${currentUser.id}`,
          DELETE_ACCOUNT_MAX_ATTEMPTS_PER_ACCOUNT,
          DELETE_ACCOUNT_WINDOW_SECONDS,
        );

        // Also pull the avatar tokens, for `deleteUserAndObjects` to sweep
        // from the bucket once the row is gone.
        const rows = yield* dbQuery(() =>
          db
            .select({
              passwordHash: users.passwordHash,
              avatarSmallKey: users.avatarSmallKey,
              avatarMediumKey: users.avatarMediumKey,
              avatarLargeKey: users.avatarLargeKey,
            })
            .from(users)
            .where(eq(users.id, currentUser.id))
            .limit(1),
        );
        const dbUser = rows[0];
        const valid =
          dbUser &&
          (yield* verifyPassword(payload.password, dbUser.passwordHash));
        if (!valid)
          return yield* Effect.fail(
            new InvalidCredentials({ message: "Incorrect password" }),
          );

        yield* deleteUserAndObjects(db, storage, currentUser.id, [
          dbUser.avatarSmallKey,
          dbUser.avatarMediumKey,
          dbUser.avatarLargeKey,
        ]);

        yield* Cache.invalidate(tokenVersionCache, currentUser.id);
        yield* pubsub
          .publish("auth:invalidation", String(currentUser.id))
          .pipe(Effect.ignore);
        yield* connections.disconnectUser(currentUser.id);
      }),
    updateUserRole: ({ params: { id }, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;

        if (currentUser.role !== "admin")
          return yield* Effect.fail(
            new Forbidden({ message: "Only admins can change user roles" }),
          );

        // Bumps token_version so an access token already issued to the
        // target user can't keep acting under its old role for the rest of
        // its TTL — mirrors `changePassword`'s reasoning, since `role` is
        // embedded in the token's claims.
        const rows = yield* dbQuery(() =>
          db
            .update(users)
            .set({
              role: payload.role,
              tokenVersion: sql`${users.tokenVersion} + 1`,
            })
            .where(eq(users.id, id))
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
          return yield* Effect.fail(
            new NotFound({ message: `User ${id} not found` }),
          );

        yield* Cache.invalidate(tokenVersionCache, id);
        yield* pubsub
          .publish("auth:invalidation", String(id))
          .pipe(Effect.ignore);
        yield* connections.disconnectUser(id);

        return toPublicUser(updated);
      }),
    deleteUser: ({ params: { id } }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;

        if (currentUser.role !== "admin")
          return yield* Effect.fail(
            new Forbidden({ message: "Only admins can delete users" }),
          );

        // Deleting your own account goes through `deleteAccount` (which
        // re-proves the password), not this admin endpoint — this rules out
        // an admin wiping their own account with a single unconfirmed click
        // and mirrors the frontend's role-management guard (see the
        // `!isSelf` check in web/src/routes/users/$id.tsx).
        if (currentUser.id === id)
          return yield* Effect.fail(
            new Forbidden({
              message:
                "Admins can't delete their own account here — use account settings",
            }),
          );

        // Pull the avatar tokens first, for `deleteUserAndObjects` to sweep
        // — same as `deleteAccount` above.
        const rows = yield* dbQuery(() =>
          db
            .select({
              avatarSmallKey: users.avatarSmallKey,
              avatarMediumKey: users.avatarMediumKey,
              avatarLargeKey: users.avatarLargeKey,
            })
            .from(users)
            .where(eq(users.id, id))
            .limit(1),
        );
        const dbUser = rows[0];
        if (!dbUser)
          return yield* Effect.fail(
            new NotFound({ message: `User ${id} not found` }),
          );

        yield* deleteUserAndObjects(db, storage, id, [
          dbUser.avatarSmallKey,
          dbUser.avatarMediumKey,
          dbUser.avatarLargeKey,
        ]);

        // Cut off the deleted user's outstanding access/refresh tokens
        // immediately rather than letting them live out their TTL — mirrors
        // `deleteAccount`.
        yield* Cache.invalidate(tokenVersionCache, id);
        yield* pubsub
          .publish("auth:invalidation", String(id))
          .pipe(Effect.ignore);
        yield* connections.disconnectUser(id);
      }),
  }) satisfies UsersHandlers;
