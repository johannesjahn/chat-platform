import { Multipart } from "effect/http";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { Schema } from "effect";
import { Authentication } from "../Auth.ts";
import { NotFound, TooManyRequests } from "./errors.ts";

// Uploaded file metadata (issue #221) — attached to a post/message via
// `attachmentId` in Create/UpdatePostBody/CreateMessageBody/UpdateMessageBody
// (api/posts.ts, api/chats.ts). `url` is a fresh, short-lived presigned (or
// `data:`, in the no-S3-configured dev fallback — see AttachmentStorage.ts)
// link resolved on every read, never stored, so it can't go stale or outlive
// its own access check.
export const Attachment = Schema.Struct({
  id: Schema.Finite,
  filename: Schema.String,
  mimeType: Schema.String,
  size: Schema.Finite,
  url: Schema.String,
  // Set only for image attachments — the dimensions of the scaled-down
  // variant actually stored/served (not the original upload) and a BlurHash
  // string (https://blurha.sh/) the frontend decodes into a low-res
  // placeholder shown while the full image loads (issue #248). Null for
  // non-image attachments and for rows uploaded before this was added.
  width: Schema.NullOr(Schema.Finite),
  height: Schema.NullOr(Schema.Finite),
  blurhash: Schema.NullOr(Schema.String),
  // Set only for audio attachments — a precomputed amplitude level (0..100)
  // per equal slice of the clip, and the clip's length in milliseconds,
  // both measured server-side from the transcoded audio `url` serves (see
  // AudioProcessing.ts). The player draws these levels as its waveform; a
  // reader that gets `null` (a non-audio attachment, or audio uploaded
  // before this was added) falls back to decoding the clip itself.
  waveform: Schema.NullOr(Schema.Array(Schema.Finite)),
  durationMs: Schema.NullOr(Schema.Finite),
}).annotate({ identifier: "Attachment" });

export type Attachment = typeof Attachment.Type;

// Mime types `POST /attachments` accepts — deliberately curated rather than
// "anything" (issue #221 only asks for previews of these families), and
// mainly to avoid ever storing/serving something like `text/html` or
// `image/svg+xml` from the bucket's origin, which could be used for stored
// XSS against whoever opens the presigned/data URL.
//
// PDF uploads are disabled: `application/pdf` intentionally isn't listed
// here. Attachment rows created before this change may still have
// `mimeType: "application/pdf"` and keep rendering fine (see
// attachmentKind/AttachmentPreview) — only new uploads are blocked.
//
// ffmpeg only opens the demuxers and decoders listed in MediaInput.ts: adding a
// video or audio type here means checking its container's demuxer and its usual
// codecs' decoders are listed there. Deliberately not listed, and rejected by
// those lists even under an allowed label: FLAC and raw (ADTS) AAC (issue
// #734).
export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  // Voice messages recorded in-browser via MediaRecorder (see
  // web/src/components/VoiceRecorderField.tsx): Chrome/Firefox default to
  // audio/webm;codecs=opus, Safari to audio/mp4 (AAC). Both decode fine
  // through the same ffmpeg-based processAudio() pipeline as any other
  // uploaded audio file.
  "audio/webm",
  "audio/mp4",
] as const;

// A generous ceiling for chat/post media while still bounding worst-case
// storage and upload time per request.
export const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024;

export class UnsupportedAttachmentType extends Schema.TaggedError<UnsupportedAttachmentType>()(
  "UnsupportedAttachmentType",
  { message: Schema.String },
  { httpApiStatus: 415 },
) {}

export class AttachmentTooLarge extends Schema.TaggedError<AttachmentTooLarge>()(
  "AttachmentTooLarge",
  { message: Schema.String },
  { httpApiStatus: 413 },
) {}

// Raised when an upload would push a user's total stored-attachment bytes
// past ATTACHMENT_QUOTA_MAX_BYTES (see attachments.ts) — bounds total
// storage per user, distinct from AttachmentTooLarge (one file's size) and
// the upload rate limiter (uploads per minute), neither of which caps how
// much a user can accumulate over time (issue #256).
export class AttachmentQuotaExceeded extends Schema.TaggedError<AttachmentQuotaExceeded>()(
  "AttachmentQuotaExceeded",
  { message: Schema.String },
  { httpApiStatus: 413 },
) {}

// Multipart upload payload (issue #221) — a single "file" field, persisted
// to a temp path by the framework (see Multipart.PersistedFile) before the
// handler reads it. `maxFileSize` here is a coarse, in-stream backstop
// against an attacker just sending gigabytes of data — enforced while the
// body is still streaming in, before it ever hits disk. It's deliberately
// looser than `MAX_ATTACHMENT_SIZE_BYTES`'s precise, typed
// `AttachmentTooLarge` check the handler runs afterward on the persisted
// file — set equal to it, an ordinary too-large upload would trip this
// coarse limit first and surface as a generic 400 (rejected by the
// multipart parser itself, before the handler's payload schema even exists
// to attach a typed error to) instead of the typed 413.
const UploadAttachmentBody = Schema.Struct({
  file: Multipart.SingleFileSchema,
}).pipe(
  HttpApiSchema.asMultipart({ maxFileSize: MAX_ATTACHMENT_SIZE_BYTES * 2 }),
);

export const AttachmentsGroup = HttpApiGroup.make("attachments")
  .add(
    HttpApiEndpoint.post("uploadAttachment", "/attachments", {
      payload: UploadAttachmentBody,
      success: Attachment.pipe(HttpApiSchema.status(201)),
      error: [
        UnsupportedAttachmentType,
        AttachmentTooLarge,
        AttachmentQuotaExceeded,
        TooManyRequests,
      ],
    }).middleware(Authentication),
  )
  .add(
    // Scoped to the caller's own uploads (see getOwnedAttachmentOr404 in
    // attachments.ts) — folds "doesn't exist" and "exists but isn't mine"
    // into the same 404 rather than a 403, mirroring that helper. A
    // message/post that already referenced this attachment just loses it
    // (the FK is `set null` on delete — see db/schema.ts), it doesn't block
    // the delete.
    HttpApiEndpoint.delete("deleteAttachment", "/attachments/:id", {
      params: { id: Schema.Int },
      success: HttpApiSchema.NoContent,
      error: NotFound,
    }).middleware(Authentication),
  );
