import { eq } from "drizzle-orm";
import { Effect } from "effect";
import {
  ALLOWED_AVATAR_MIME_TYPES,
  AvatarTooLarge,
  InvalidAvatarUpload,
  MAX_AVATAR_UPLOAD_SIZE_BYTES,
} from "../Api.ts";
import { CurrentUser } from "../Auth.ts";
import {
  avatarStorageKey,
  deleteAvatarObjects,
  generateAvatarToken,
} from "../avatars.ts";
import { processAvatar } from "../ImageProcessing.ts";
import { withMediaProcessingPermit } from "../MediaProcessingLimit.ts";
import { users } from "../db/schema.ts";
import { type UsersDeps, type UsersHandlers } from "./handlerKit.ts";
import { enforceRateLimit } from "../RateLimiter.ts";
import { toPublicUser, toUserProfile } from "./userViews.ts";

// Avatar uploads involve real image-decoding/resizing work (processAvatar,
// ImageProcessing.ts) and are a rare, deliberate action (changing your
// avatar), not something a normal client ever does in a burst — mirrors
// AttachmentsHandler's enforceUploadLimit's rationale for bounding a
// scripted flood tighter than the global per-IP limiter.
const AVATAR_UPLOAD_MAX_ATTEMPTS_PER_ACCOUNT = 10;

const AVATAR_UPLOAD_WINDOW_SECONDS = 60 * 60;

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
        const prevRows = yield* Effect.tryPromise(() =>
          db
            .select({
              avatarSmallKey: users.avatarSmallKey,
              avatarMediumKey: users.avatarMediumKey,
              avatarLargeKey: users.avatarLargeKey,
            })
            .from(users)
            .where(eq(users.id, currentUser.id))
            .limit(1),
        ).pipe(Effect.orDie);
        const prev = prevRows[0];

        const rows = yield* Effect.tryPromise(() =>
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
        ).pipe(Effect.orDie);
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

        yield* enforceRateLimit(
          limiter,
          `avatar-upload:account:${currentUser.id}`,
          AVATAR_UPLOAD_MAX_ATTEMPTS_PER_ACCOUNT,
          AVATAR_UPLOAD_WINDOW_SECONDS,
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

        // The tokens the row points at *before* this upload — their objects
        // become orphans once the row is repointed below, so sweep them
        // afterwards. Read up front (an UPDATE ... RETURNING would hand back
        // the post-update values, not these).
        const prevRows = yield* Effect.tryPromise(() =>
          db
            .select({
              avatarSmallKey: users.avatarSmallKey,
              avatarMediumKey: users.avatarMediumKey,
              avatarLargeKey: users.avatarLargeKey,
            })
            .from(users)
            .where(eq(users.id, currentUser.id))
            .limit(1),
        ).pipe(Effect.orDie);
        const prev = prevRows[0];

        // Mint a fresh token per variant and push the processed bytes to
        // object storage before touching the row — an upload that fails
        // partway leaves at most a few unreferenced objects (cleaned up like
        // any other orphan) rather than a row pointing at bytes that never
        // landed. Fresh tokens (never the previous upload's) are what make
        // the served URLs cache-bust on re-upload — see avatars.ts.
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

        // Repoint the row at the freshly stored variants, nulling the legacy
        // base64 columns at the same time so a pre-#289 avatar's bytes stop
        // riding along in the row.
        const rows = yield* Effect.tryPromise(() =>
          db
            .update(users)
            .set({
              avatarUrl: null,
              avatarSmall: null,
              avatarMedium: null,
              avatarLarge: null,
              avatarSmallKey: smallToken,
              avatarMediumKey: mediumToken,
              avatarLargeKey: largeToken,
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
        ).pipe(Effect.orDie);
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

        const rows = yield* Effect.tryPromise(() =>
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
        ).pipe(Effect.orDie);
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
