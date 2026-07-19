import { HttpApiBuilder } from "@effect/platform";
import type { BunFile } from "bun";
import { Effect, Metric, MetricLabel } from "effect";
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  AttachmentTooLarge,
  ChatApi,
  MAX_ATTACHMENT_SIZE_BYTES,
  TooManyRequests,
  UnsupportedAttachmentType,
} from "./Api.ts";
import { AttachmentStorage } from "./AttachmentStorage.ts";
import { toApiAttachment } from "./attachments.ts";
import { CurrentUser } from "./Auth.ts";
import { Db } from "./Db.ts";
import { processImage } from "./ImageProcessing.ts";
import { contentCreatedTotal, rateLimitRejectionsTotal } from "./Metrics.ts";
import { RateLimiter } from "./RateLimiter.ts";
import { attachments } from "./db/schema.ts";

// Uploads are heavier than a typical write (disk I/O, a bucket round trip),
// so — like EngagementHandler's write limiter — this bounds a scripted flood
// separately from (and more tightly than) the global per-IP limiter.
const UPLOAD_MAX_PER_USER = 20;
const UPLOAD_WINDOW_SECONDS = 60;

const enforceUploadLimit = (userId: number) =>
  Effect.gen(function* () {
    const limiter = yield* RateLimiter;
    const result = yield* limiter.consume(
      `attachments:upload:user:${userId}`,
      UPLOAD_MAX_PER_USER,
      UPLOAD_WINDOW_SECONDS,
    );
    if (!result.allowed) {
      yield* Metric.update(
        Metric.taggedWithLabels(rateLimitRejectionsTotal, [
          MetricLabel.make("limiter", "attachments"),
        ]),
        1,
      );
      return yield* Effect.fail(
        new TooManyRequests({
          message: "Too many uploads. Please try again later.",
          retryAfterSeconds: result.retryAfterSeconds,
        }),
      );
    }
  });

export const AttachmentsHandlerLive = HttpApiBuilder.group(
  ChatApi,
  "attachments",
  (handlers) =>
    handlers.handle("uploadAttachment", ({ payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        yield* enforceUploadLimit(currentUser.id);

        const db = yield* Db;
        const storage = yield* AttachmentStorage;
        const file = payload.file;

        if (
          !(ALLOWED_ATTACHMENT_MIME_TYPES as ReadonlyArray<string>).includes(
            file.contentType,
          )
        )
          return yield* Effect.fail(
            new UnsupportedAttachmentType({
              message: `Unsupported file type: ${file.contentType}`,
            }),
          );

        const bunFile = Bun.file(file.path);
        const originalSize = bunFile.size;
        if (originalSize > MAX_ATTACHMENT_SIZE_BYTES)
          return yield* Effect.fail(
            new AttachmentTooLarge({
              message: `File exceeds the maximum size of ${MAX_ATTACHMENT_SIZE_BYTES} bytes`,
            }),
          );

        // Images get scaled down and re-encoded (and a BlurHash placeholder
        // generated) before being stored — see ImageProcessing.ts and issue
        // #248. Other allowed types (video/audio/pdf) upload unprocessed, as
        // before.
        let uploadData: BunFile | Uint8Array = bunFile;
        let uploadContentType = file.contentType;
        let size = originalSize;
        let width: number | null = null;
        let height: number | null = null;
        let blurhash: string | null = null;

        if (file.contentType.startsWith("image/")) {
          const processed = yield* Effect.tryPromise({
            try: async () =>
              processImage(await bunFile.bytes(), file.contentType),
            catch: () =>
              new UnsupportedAttachmentType({
                message: "Uploaded file is not a valid image",
              }),
          });
          uploadData = processed.data;
          uploadContentType = processed.contentType;
          size = processed.data.length;
          width = processed.width;
          height = processed.height;
          blurhash = processed.blurhash;
        }

        const storageKey = `attachments/${crypto.randomUUID()}`;
        yield* storage
          .upload(storageKey, uploadData, uploadContentType)
          .pipe(Effect.orDie);

        const rows = yield* Effect.tryPromise(() =>
          db
            .insert(attachments)
            .values({
              uploaderId: currentUser.id,
              filename: file.name,
              mimeType: uploadContentType,
              size,
              storageKey,
              width,
              height,
              blurhash,
            })
            .returning(),
        ).pipe(Effect.orDie);
        const row = rows[0];
        if (!row)
          return yield* Effect.die(new Error("INSERT returned no rows"));

        yield* Metric.update(
          Metric.taggedWithLabels(contentCreatedTotal, [
            MetricLabel.make("type", "attachment"),
          ]),
          1,
        );

        return toApiAttachment(row, storage.presignGetUrl(row.storageKey));
      }),
    ),
);
