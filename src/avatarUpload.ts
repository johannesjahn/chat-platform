import { Effect } from "effect";
import {
  ALLOWED_AVATAR_MIME_TYPES,
  AvatarTooLarge,
  InvalidAvatarUpload,
  MAX_AVATAR_UPLOAD_SIZE_BYTES,
  type TooManyRequests,
} from "./Api.ts";
import type { AttachmentStorage } from "./AttachmentStorage.ts";
import { avatarStorageKey, generateAvatarToken } from "./avatars.ts";
import { processAvatar } from "./ImageProcessing.ts";
import { withMediaProcessingPermit } from "./MediaProcessingLimit.ts";
import { enforceRateLimit, type RateLimiter } from "./RateLimiter.ts";

// Avatar uploads involve real image-decoding/resizing work (processAvatar,
// ImageProcessing.ts) and are a rare, deliberate action (changing your
// avatar), not something a normal client ever does in a burst — mirrors
// AttachmentsHandler's enforceUploadLimit's rationale for bounding a
// scripted flood tighter than the global per-IP limiter. The same budget
// applies to a user's own avatar and to a group's (each in its own bucket).
const AVATAR_UPLOAD_MAX_ATTEMPTS_PER_ACCOUNT = 10;

const AVATAR_UPLOAD_WINDOW_SECONDS = 60 * 60;

// The three stored-variant tokens of a fresh upload, named like the
// `avatar*Key` columns on `users` and `chats` so a caller can spread them
// straight into its UPDATE.
export type StoredAvatarKeys = {
  readonly avatarSmallKey: string;
  readonly avatarMediumKey: string;
  readonly avatarLargeKey: string;
};

// The upload pipeline shared by `POST /users/me/avatar` and `POST
// /chats/:id/avatar` (issue #811), up to the point where the caller repoints
// its own row: rate-limit `bucket` (keyed by the uploading account, so
// someone managing several groups shares one budget), check the type and
// size, crop/resize under the media-processing permit, then mint a fresh
// token per variant and store the bytes. Storing before the row is touched
// means an upload that fails partway leaves at most a few unreferenced
// objects (cleaned up like any other orphan) rather than a row pointing at
// bytes that never landed; fresh tokens (never the previous upload's) are
// what make the served URLs cache-bust on re-upload — see avatars.ts. The
// caller sweeps the previous upload's objects (`deleteAvatarObjects`) once
// its row no longer points at them.
export const storeAvatarUpload = (
  limiter: RateLimiter["Service"],
  storage: AttachmentStorage["Service"],
  bucket: string,
  upload: {
    readonly file: { readonly contentType: string; readonly path: string };
    readonly x: number;
    readonly y: number;
    readonly size: number;
  },
): Effect.Effect<
  StoredAvatarKeys,
  TooManyRequests | InvalidAvatarUpload | AvatarTooLarge
> =>
  Effect.gen(function* () {
    yield* enforceRateLimit(
      limiter,
      bucket,
      AVATAR_UPLOAD_MAX_ATTEMPTS_PER_ACCOUNT,
      AVATAR_UPLOAD_WINDOW_SECONDS,
    );

    if (
      !(ALLOWED_AVATAR_MIME_TYPES as ReadonlyArray<string>).includes(
        upload.file.contentType,
      )
    )
      return yield* Effect.fail(
        new InvalidAvatarUpload({
          message: `Unsupported file type: ${upload.file.contentType}`,
        }),
      );

    const bunFile = Bun.file(upload.file.path);
    if (bunFile.size > MAX_AVATAR_UPLOAD_SIZE_BYTES)
      return yield* Effect.fail(
        new AvatarTooLarge({
          message: `File exceeds the maximum size of ${MAX_AVATAR_UPLOAD_SIZE_BYTES} bytes`,
        }),
      );

    const processed = yield* Effect.tryPromise({
      try: async () =>
        processAvatar(await bunFile.bytes(), {
          x: upload.x,
          y: upload.y,
          size: upload.size,
        }),
      catch: (err) =>
        new InvalidAvatarUpload({
          message: err instanceof Error ? err.message : "Invalid avatar image",
        }),
    }).pipe(withMediaProcessingPermit);

    const keys: StoredAvatarKeys = {
      avatarSmallKey: generateAvatarToken(),
      avatarMediumKey: generateAvatarToken(),
      avatarLargeKey: generateAvatarToken(),
    };
    yield* Effect.all(
      [
        storage.upload(
          avatarStorageKey(keys.avatarSmallKey),
          processed.small,
          processed.contentType,
        ),
        storage.upload(
          avatarStorageKey(keys.avatarMediumKey),
          processed.medium,
          processed.contentType,
        ),
        storage.upload(
          avatarStorageKey(keys.avatarLargeKey),
          processed.large,
          processed.contentType,
        ),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.orDie);
    return keys;
  });
