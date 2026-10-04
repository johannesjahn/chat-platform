import { Multipart } from "effect/http";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  OpenApi,
} from "effect/http-api";
import { Schema } from "effect";
import packageJson from "../package.json" with { type: "json" };
import { Authentication } from "./Auth.ts";
import {
  REFLEX_DIRECTIONS,
  REFLEX_KINDS,
  REFLEX_ROUNDS,
} from "./games/reflex.ts";

// "admin" can edit/delete any post; "user" can only edit/delete their own.
// Registration always creates a "user" — admins are promoted out-of-band.
export const UserRole = Schema.Literals(["user", "admin"]).annotate({
  identifier: "UserRole",
});
export type UserRole = typeof UserRole.Type;

// Hosting domains an image URL (avatar or post/message `image_url` content)
// is allowed to point at (issue #47): rendered directly as an `<img src>`,
// so without this an author could embed a `javascript:`/`data:` URL, track
// viewers via an arbitrary third-party host, or serve mixed (non-https)
// content. Matches the domain itself or any subdomain, e.g. "i.imgur.com"
// matches "imgur.com".
export const ALLOWED_IMAGE_HOST_DOMAINS = [
  "picsum.photos",
  "imgur.com",
  "unsplash.com",
  "gravatar.com",
  "githubusercontent.com",
  "imgbb.com",
  "ibb.co",
  "cloudinary.com",
  "googleusercontent.com",
  "discordapp.com",
  "discordapp.net",
  "staticflickr.com",
  "wikimedia.org",
  "pexels.com",
  "pixabay.com",
] as const;

const isAllowedImageHost = (hostname: string): boolean => {
  const lower = hostname.toLowerCase();
  return ALLOWED_IMAGE_HOST_DOMAINS.some(
    (domain) => lower === domain || lower.endsWith(`.${domain}`),
  );
};

// A well-formed `https://` URL (rejects `data:`, `javascript:`, plain
// `http:`, and unparseable strings) whose host is on the allowlist above.
export const isAllowedImageUrl = (value: string): boolean => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && isAllowedImageHost(url.hostname);
};

const AVATAR_URL_FILTER_MESSAGE =
  "avatarUrl must be an https:// URL from an allowed image-hosting domain";

// Bounded mainly to keep the request small — no real URL is anywhere close.
const MAX_AVATAR_URL_LENGTH = 2048;

const AvatarUrl = Schema.String.check(
  Schema.isMaxLength(MAX_AVATAR_URL_LENGTH),
  Schema.makeFilter((value) =>
    isAllowedImageUrl(value) ? undefined : AVATAR_URL_FILTER_MESSAGE,
  ),
);

// Self-contained `data:image/webp;base64,...` URLs for the 3 fixed sizes an
// uploaded-and-cropped avatar is stored/served at (issue #269) — see
// `processAvatar`/`AVATAR_VARIANT_PX` in ImageProcessing.ts for how they're
// produced, and the comment on `users.avatarSmall` (db/schema.ts) for why
// they're embedded directly rather than resolved via a presigned URL like
// `Attachment.url`. Mutually exclusive with `avatarUrl` on `User` below —
// exactly one of the two is ever non-null.
const AvatarVariants = Schema.Struct({
  small: Schema.String,
  medium: Schema.String,
  large: Schema.String,
}).annotate({ identifier: "AvatarVariants" });

// Public representation of a user — never exposes the password hash.
// `identifier` annotations surface these as named schemas in the OpenAPI spec.
export const User = Schema.Struct({
  id: Schema.Finite,
  username: Schema.String,
  // Optional profile fields (issue #67) — null when unset. The UI falls back
  // to `username` for display and initials-only for the avatar (see
  // web/src/components/Avatar.tsx).
  displayName: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
  // Set instead of `avatarUrl` when the user has uploaded/cropped an avatar
  // via `POST /users/me/avatar` (issue #269) rather than linked an external
  // image. The frontend picks whichever size variant matches where it's
  // rendering the avatar (see `AVATAR_SIZES` in Avatar.tsx) and otherwise
  // falls back to `avatarUrl`, then initials.
  avatarVariants: Schema.NullOr(AvatarVariants),
  role: UserRole,
  // Custom status (issue #218) — a short message plus an optional emoji, with
  // an optional auto-expiry. Null when unset. `statusExpiresAt` (epoch ms) in
  // the past is already resolved to a fully-null status server-side (see
  // `effectiveStatus` in UsersHandler.ts), so a client never has to separately
  // check whether to still show it.
  statusText: Schema.NullOr(Schema.String),
  statusEmoji: Schema.NullOr(Schema.String),
  statusExpiresAt: Schema.NullOr(Schema.Finite),
}).annotate({ identifier: "User" });
export type User = typeof User.Type;

// Sensible cap on username length (issue #46) — mirrors common site limits
// (Discord uses 32, GitHub 39) and keeps the value small enough to embed in
// JWT claims and UI without an unbounded storage/DoS risk.
export const MAX_USERNAME_LENGTH = 32;

const Username = Schema.Trimmed.check(Schema.isNonEmpty()).check(
  Schema.isMaxLength(MAX_USERNAME_LENGTH),
);

// Floor for newly registered usernames (issue #483) — equal to
// `MIN_USER_SEARCH_QUERY_LENGTH`, so every account can be found through the
// people search, which won't run a narrower query for a non-admin. Like
// `NewPassword` below, only applied at registration: `Username` alone stays
// the login schema, so accounts created before this floor can still sign in.
export const MIN_USERNAME_LENGTH = 3;

const NewUsername = Username.check(Schema.isMinLength(MIN_USERNAME_LENGTH));

// Mirrors MAX_USERNAME_LENGTH's rationale but roomier, since a display name
// may hold a full "First Last" rather than a single token.
export const MAX_DISPLAY_NAME_LENGTH = 64;

const DisplayName = Schema.Trimmed.check(Schema.isNonEmpty()).check(
  Schema.isMaxLength(MAX_DISPLAY_NAME_LENGTH),
);

// A generous ceiling — long enough for any real passphrase, but bounded so a
// multi-megabyte payload can't be pushed through the (deliberately
// expensive) Argon2id hash/verify path.
export const MAX_PASSWORD_LENGTH = 128;

// Floor for newly chosen passwords (issue #45) — rules out trivial
// one-character passwords without imposing composition rules (NIST no
// longer recommends those; length is the stronger lever).
export const MIN_PASSWORD_LENGTH = 8;

const Password = Schema.NonEmptyString.check(
  Schema.isMaxLength(MAX_PASSWORD_LENGTH),
);

// Only applied where a password is being newly *set* (registration, password
// change) — `Password` alone remains the decode schema for login and
// `currentPassword`, so accounts created before this floor existed can still
// authenticate with their existing (possibly shorter) password.
const NewPassword = Password.check(Schema.isMinLength(MIN_PASSWORD_LENGTH));

export const RegisterBody = Schema.Struct({
  username: NewUsername,
  password: NewPassword,
}).annotate({ identifier: "RegisterBody" });

export const LoginBody = Schema.Struct({
  username: Username,
  password: Password,
}).annotate({ identifier: "LoginBody" });

export const LoginResponse = Schema.Struct({
  user: User,
  accessToken: Schema.String,
  refreshToken: Schema.String,
}).annotate({ identifier: "LoginResponse" });
export type LoginResponse = typeof LoginResponse.Type;

// A well-formed token signed by this server is well under this (see
// Jwt.ts) — anything longer is necessarily garbage, not worth spending a
// verify() on.
const MAX_REFRESH_TOKEN_LENGTH = 1024;

const RefreshTokenValue = Schema.String.check(
  Schema.isMaxLength(MAX_REFRESH_TOKEN_LENGTH),
);

export const RefreshBody = Schema.Struct({
  refreshToken: RefreshTokenValue,
}).annotate({ identifier: "RefreshBody" });

// A refresh exchanges a valid refresh token for a new token pair — the
// refresh token is rotated too rather than reused, so a client always holds
// exactly one live refresh token at a time.
export const RefreshResponse = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
}).annotate({ identifier: "RefreshResponse" });

export const LogoutBody = Schema.Struct({
  refreshToken: RefreshTokenValue,
  // When true, revokes every refresh token belonging to the presented
  // token's user (all sessions/devices) instead of just this one.
  allSessions: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "LogoutBody" });

export const ChangePasswordBody = Schema.Struct({
  currentPassword: Password,
  newPassword: NewPassword,
}).annotate({ identifier: "ChangePasswordBody" });

// Full-replace body (mirrors `UpdatePostBody`/`UpdateChatBody`'s convention)
// rather than a partial patch — `displayName`/`avatarUrl` are nullable so a
// caller can explicitly clear either back to "unset". Username is not
// editable here — it's assigned at registration and immutable thereafter.
export const UpdateProfileBody = Schema.Struct({
  displayName: Schema.NullOr(DisplayName),
  avatarUrl: Schema.NullOr(AvatarUrl),
}).annotate({ identifier: "UpdateProfileBody" });

// Deleting an account is irreversible, so — like `changePassword` — it
// requires re-proving the current password rather than trusting the bearer
// token alone.
export const DeleteAccountBody = Schema.Struct({
  password: Password,
}).annotate({ identifier: "DeleteAccountBody" });

export const UpdateUserRoleBody = Schema.Struct({
  role: UserRole,
}).annotate({ identifier: "UpdateUserRoleBody" });

// Bounds a custom status message (issue #218) — short like a Slack/Discord
// status, not a full post.
export const MAX_STATUS_TEXT_LENGTH = 100;

const StatusText = Schema.Trimmed.check(Schema.isNonEmpty()).check(
  Schema.isMaxLength(MAX_STATUS_TEXT_LENGTH),
);

// Generous enough for any real emoji grapheme (including multi-codepoint
// ZWJ/skin-tone sequences) without allowing an arbitrary-length string in
// what's meant to be a single status icon.
export const MAX_STATUS_EMOJI_LENGTH = 8;

const StatusEmoji = Schema.Trimmed.check(Schema.isNonEmpty()).check(
  Schema.isMaxLength(MAX_STATUS_EMOJI_LENGTH),
);

// A status may optionally auto-expire — bounded generously (30 days), the
// same ceiling `CreateChatInviteBody.expiresInHours` uses.
export const MAX_STATUS_EXPIRES_IN_MINUTES = 60 * 24 * 30;

// `expiresInMinutes` only makes sense alongside an actual status — rejecting
// it otherwise avoids a confusing no-op (an expiry timer for a status that
// isn't there).
const requireStatusForExpiry = (body: {
  readonly statusText: string | null;
  readonly statusEmoji: string | null;
  readonly expiresInMinutes?: number | undefined;
}): string | undefined =>
  body.statusText === null &&
  body.statusEmoji === null &&
  body.expiresInMinutes !== undefined
    ? "expiresInMinutes may only be set alongside a status"
    : undefined;

// Full-replace like `UpdateProfileBody` — setting both `statusText` and
// `statusEmoji` to null clears the status entirely (and, per
// `requireStatusForExpiry` above, must leave `expiresInMinutes` unset too).
// Omitting `expiresInMinutes` while setting a status means it never
// auto-expires.
export const UpdateStatusBody = Schema.Struct({
  statusText: Schema.NullOr(StatusText),
  statusEmoji: Schema.NullOr(StatusEmoji),
  expiresInMinutes: Schema.optional(
    Schema.Finite.check(
      Schema.isInt(),
      Schema.isBetween({
        minimum: 1,
        maximum: MAX_STATUS_EXPIRES_IN_MINUTES,
      }),
    ),
  ),
})
  .check(Schema.makeFilter(requireStatusForExpiry))
  .annotate({ identifier: "UpdateStatusBody" });

// Privacy-control relationship kind (issue #219): "block" is the stronger
// action (hides posts, mutes notifications, *and* blocks direct messaging
// both ways), "mute" the softer one (hides posts + mutes notifications only).
// See the comment on `userBlocks` in db/schema.ts.
export const BlockType = Schema.Literals(["block", "mute"]).annotate({
  identifier: "BlockType",
});
export type BlockType = typeof BlockType.Type;

// Body of `PUT /users/:id/block` — sets (or upgrades/downgrades) the caller's
// relationship to the target user. Re-issuing with a different `type` replaces
// the existing relationship rather than creating a second one.
export const BlockUserBody = Schema.Struct({
  type: BlockType,
}).annotate({ identifier: "BlockUserBody" });

// One entry in `GET /users/me/blocks` — the blocked/muted user together with
// which action is in effect and when it was set (epoch ms), newest first.
export const BlockedUser = Schema.Struct({
  user: User,
  type: BlockType,
  createdAt: Schema.Finite,
}).annotate({ identifier: "BlockedUser" });
export type BlockedUser = typeof BlockedUser.Type;

// Raised for block/mute domain-rule violations that aren't a 404 — currently
// only an attempt to block or mute yourself.
export class InvalidBlockRequest extends Schema.TaggedError<InvalidBlockRequest>()(
  "InvalidBlockRequest",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  {
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class UsernameTaken extends Schema.TaggedError<UsernameTaken>()(
  "UsernameTaken",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

export class InvalidCredentials extends Schema.TaggedError<InvalidCredentials>()(
  "InvalidCredentials",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

// Raised when a caller has exceeded an endpoint's rate limit (see
// RateLimiter.ts). `message` is deliberately generic across every bucket an
// endpoint checks (e.g. login's per-IP vs. per-account buckets) so it can't
// be used to tell them apart.
export class TooManyRequests extends Schema.TaggedError<TooManyRequests>()(
  "TooManyRequests",
  { message: Schema.String, retryAfterSeconds: Schema.Finite },
  { httpApiStatus: 429 },
) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  {
    message: Schema.String,
  },
  { httpApiStatus: 403 },
) {}

// Raised for chat domain-rule violations that aren't a 404/403 — messaging
// yourself, exceeding the group participant cap, editing a direct chat's
// title, duplicate participants, etc.
export class InvalidChatRequest extends Schema.TaggedError<InvalidChatRequest>()(
  "InvalidChatRequest",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

// Raised for a malformed `listPosts` pagination cursor — mirrors
// `InvalidChatRequest`'s role for `listChats`/`listMessages`.
export class InvalidPostsRequest extends Schema.TaggedError<InvalidPostsRequest>()(
  "InvalidPostsRequest",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

// Raised for comment/reply domain-rule violations that aren't a 404/403 — a
// malformed pagination cursor, or an attempt to reply to a reply (the depth-2
// nesting cap, enforced at create time — see EngagementHandler.ts).
export class InvalidCommentRequest extends Schema.TaggedError<InvalidCommentRequest>()(
  "InvalidCommentRequest",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

// Raised for a malformed full-text-search pagination cursor (issue #224) —
// mirrors `InvalidPostsRequest`'s role for `listPosts`. The search *query*
// text itself never lands here: it's decoded through Postgres'
// `websearch_to_tsquery`, which tolerates any input rather than erroring (see
// SearchHandler.ts), so only the opaque cursor can be malformed.
export class InvalidSearchRequest extends Schema.TaggedError<InvalidSearchRequest>()(
  "InvalidSearchRequest",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

// Uploaded file metadata (issue #221) — attached to a post/message via
// `attachmentId` in Create/UpdatePostBody/CreateMessageBody/UpdateMessageBody
// below. `url` is a fresh, short-lived presigned (or `data:`, in the
// no-S3-configured dev fallback — see AttachmentStorage.ts) link resolved on
// every read, never stored, so it can't go stale or outlive its own access
// check.
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
// past ATTACHMENT_QUOTA_MAX_BYTES (see AttachmentsHandler.ts) — bounds total
// storage per user, distinct from AttachmentTooLarge (one file's size) and
// the upload rate limiter (uploads per minute), neither of which caps how
// much a user can accumulate over time (issue #256).
export class AttachmentQuotaExceeded extends Schema.TaggedError<AttachmentQuotaExceeded>()(
  "AttachmentQuotaExceeded",
  { message: Schema.String },
  { httpApiStatus: 413 },
) {}

// Raised by `POST /users/me/avatar` (issue #269) for anything wrong with the
// upload other than its size: an unsupported content type, bytes that don't
// decode as an image, a source image smaller than MIN_AVATAR_SOURCE_PX in
// either dimension, or a crop rectangle that doesn't fit within the actual
// decoded image bounds. `message` carries the specific reason (see
// UsersHandler.ts) — unlike the generic messages elsewhere in this file,
// there's no enumeration/timing concern here worth flattening it for.
export class InvalidAvatarUpload extends Schema.TaggedError<InvalidAvatarUpload>()(
  "InvalidAvatarUpload",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class AvatarTooLarge extends Schema.TaggedError<AvatarTooLarge>()(
  "AvatarTooLarge",
  { message: Schema.String },
  { httpApiStatus: 413 },
) {}

// Content types a post's body can hold. Extend this union (and the handler's
// per-type validation, if any is ever needed) to support new post kinds.
export const PostContentType = Schema.Literals([
  "text",
  "image_url",
  "attachment",
]).annotate({
  identifier: "PostContentType",
});
export type PostContentType = typeof PostContentType.Type;

// Generous but bounded — prevents unbounded payloads while comfortably
// fitting a long-form text post or an image URL.
const MAX_POST_CONTENT_LENGTH = 10_000;

const PostContent = Schema.Trimmed.check(Schema.isNonEmpty()).check(
  Schema.isMaxLength(MAX_POST_CONTENT_LENGTH),
);

// `content` is rendered directly as an `<img src>` (MessageBubble.tsx,
// PostCard.tsx) when `contentType` is "image_url" — validated against the
// same host allowlist as `avatarUrl` (see `ALLOWED_IMAGE_HOST_DOMAINS`
// above), for the same reasons (issue #47).
const IMAGE_URL_FILTER_MESSAGE =
  "content must be an https:// URL from an allowed image-hosting domain";

// Cross-field check shared by post/message create+update bodies: only
// applies when `contentType` is "image_url" — text content is unaffected.
const requireAllowedImageUrl = (body: {
  readonly contentType: string;
  readonly content: string;
}): string | undefined =>
  body.contentType === "image_url" && !isAllowedImageUrl(body.content)
    ? IMAGE_URL_FILTER_MESSAGE
    : undefined;

// The standard emoji reaction set (issue #215, widening the original binary
// "like" from issue #67). A `Schema.Literal` rather than a plain string so
// the OpenAPI spec documents the exact allowed values and invalid input is
// rejected at decode time rather than reaching the DB — see the `emoji`
// column comment in db/schema.ts for why the DB itself stays unconstrained
// (so a future custom-emoji set doesn't need a migration to loosen it).
export const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "😡"] as const;
export const ReactionEmoji = Schema.Literals(REACTION_EMOJIS).annotate({
  identifier: "ReactionEmoji",
});
export type ReactionEmoji = typeof ReactionEmoji.Type;

// One emoji's aggregate state on a target: how many reactions it has, and
// whether the requesting user is one of them. `Post`/`Comment` each carry an
// array of these — one entry per emoji that has at least one reaction, never
// a zero-filled entry for the rest of the standard set (the frontend's
// "add a reaction" picker already knows the full set independently).
export const ReactionSummary = Schema.Struct({
  emoji: Schema.String,
  count: Schema.Finite,
  reactedByMe: Schema.Boolean,
}).annotate({ identifier: "ReactionSummary" });
export type ReactionSummary = typeof ReactionSummary.Type;

// Cross-field check shared by post/message create+update bodies:
// `attachmentId` must be set exactly when `contentType` is "attachment" —
// never alongside "text"/"image_url", and never missing for "attachment".
const requireAttachmentId = (body: {
  readonly contentType: string;
  readonly attachmentId?: number | undefined;
}): string | undefined => {
  if (body.contentType === "attachment" && body.attachmentId === undefined)
    return `attachmentId is required when contentType is "attachment"`;
  if (body.contentType !== "attachment" && body.attachmentId !== undefined)
    return `attachmentId may only be set when contentType is "attachment"`;
  return undefined;
};

export const Post = Schema.Struct({
  id: Schema.Finite,
  authorId: Schema.Finite,
  contentType: PostContentType,
  content: Schema.String,
  // Set only when contentType is "attachment" — see `Attachment` above.
  attachment: Schema.NullOr(Attachment),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
  // Engagement computed on read (see EngagementHandler.ts / PostsHandler.ts)
  // rather than stored — one entry per emoji this post has at least one
  // reaction from, so the feed can render reaction pills (with the current
  // user's own reactions highlighted) without a second request per post.
  reactions: Schema.Array(ReactionSummary),
  // Total comments (top-level comments *and* replies) on this post, computed
  // on read alongside `reactions` (see PostsHandler.ts) rather than stored, so
  // the feed can surface a "Comments · N" count on each card without having to
  // open the thread (issue #306). Additive/backward-compatible: a client that
  // predates this field simply ignores it.
  commentCount: Schema.Finite,
}).annotate({ identifier: "Post" });
export type Post = typeof Post.Type;

export const CreatePostBody = Schema.Struct({
  contentType: PostContentType,
  content: PostContent,
  // Id of a previously-uploaded attachment (`POST /attachments`) owned by
  // the caller — required exactly when contentType is "attachment".
  attachmentId: Schema.optional(Schema.Finite),
})
  .check(
    Schema.makeFilter(requireAllowedImageUrl),
    Schema.makeFilter(requireAttachmentId),
  )
  .annotate({ identifier: "CreatePostBody" });

export const UpdatePostBody = Schema.Struct({
  contentType: PostContentType,
  content: PostContent,
  attachmentId: Schema.optional(Schema.Finite),
})
  .check(
    Schema.makeFilter(requireAllowedImageUrl),
    Schema.makeFilter(requireAttachmentId),
  )
  .annotate({ identifier: "UpdatePostBody" });

export const DEFAULT_POSTS_LIMIT = 20;
export const MAX_POSTS_LIMIT = 100;

// `limit` (rather than `page`/`pageSize`) so a caller can request
// irregularly-sized batches — e.g. an infinite-scroll feed that loads 5 posts
// up front and 3 at a time thereafter — without the batch size having to stay
// constant across requests.
//
// `posts` is ordered newest-first (`id desc`) and never mutates an existing
// row's position (posts aren't reordered by edits, unlike chats), so a plain
// single-column keyset cursor — "give me the next `limit` posts with
// `id < cursor`" — is enough; no OFFSET, so deep pages don't scan and discard
// skipped rows (issue #50). The cursor is opaque to clients: it's the last
// row's id, base64url-encoded (same encoding `Jwt.ts` uses for its segments),
// and only ever round-tripped from a previous page's `nextCursor` rather than
// constructed by hand.
//
// Left plain-optional (rather than `optionalWith` + `default`) because a
// schema default only fills in on *decode* — an HttpApiClient caller encoding
// a request would otherwise be forced to pass both every time. Defaults are
// instead applied by the handler.
//
// Deliberately left un-`identifier`-annotated: the OpenAPI generator only
// emits individual query-parameter entries when this struct is inlined —
// giving it a named `identifier` turns it into a `$ref` to a component
// schema instead, which it silently ignores when extracting parameters
// (see `processParameters` in `OpenApi.ts`), producing an operation with no
// documented/typed query params at all.
export const PostsPageQuery = Schema.Struct({
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_POSTS_LIMIT }),
    ),
  ),
});

export const PostsPage = Schema.Struct({
  posts: Schema.Array(Post),
  limit: Schema.Finite,
  // Opaque cursor for the next page, or null once the current page reaches
  // the end of the list. Derived from fetching one row past `limit` rather
  // than a separate `COUNT(*)` over the full result set — the feed only ever
  // needs to know whether another page exists (issue #51).
  nextCursor: Schema.NullOr(Schema.String),
}).annotate({ identifier: "PostsPage" });

// Response for `GET /users/:id/posts` (issue #316: the profile page shows a
// recent-activity feed instead of being a dead end). Same shape/pagination as
// `PostsPage`, plus `totalCount` — this endpoint is always scoped to one
// author, so a `COUNT(*) WHERE author_id = :id` (backed by
// `posts_author_id_idx`) is cheap in a way a full-feed count isn't (see
// `PostsPage`'s comment), and it powers the "N posts" stat on the profile
// header.
export const UserPostsPage = Schema.Struct({
  posts: Schema.Array(Post),
  limit: Schema.Finite,
  nextCursor: Schema.NullOr(Schema.String),
  totalCount: Schema.Finite,
}).annotate({ identifier: "UserPostsPage" });

// Shorter than a post's cap — comments are conversational, not long-form.
export const MAX_COMMENT_CONTENT_LENGTH = 2_000;

const CommentContent = Schema.Trimmed.check(Schema.isNonEmpty()).check(
  Schema.isMaxLength(MAX_COMMENT_CONTENT_LENGTH),
);

// A comment on a post, or a reply to a comment (a reply is just a comment
// with `parentCommentId` set — null for a top-level comment). Nesting is
// capped at depth 2, so a reply's parent is always a top-level comment.
// `reactions` mirrors `Post`'s — computed on read, not stored.
export const Comment = Schema.Struct({
  id: Schema.Finite,
  postId: Schema.Finite,
  parentCommentId: Schema.NullOr(Schema.Finite),
  authorId: Schema.Finite,
  content: Schema.String,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
  reactions: Schema.Array(ReactionSummary),
}).annotate({ identifier: "Comment" });
export type Comment = typeof Comment.Type;

export const CreateCommentBody = Schema.Struct({
  content: CommentContent,
}).annotate({ identifier: "CreateCommentBody" });

export const UpdateCommentBody = Schema.Struct({
  content: CommentContent,
}).annotate({ identifier: "UpdateCommentBody" });

// Payload for the add/remove-reaction endpoints (on posts and comments
// alike): which of the standard emojis this reaction is/was.
export const ReactionBody = Schema.Struct({
  emoji: ReactionEmoji,
}).annotate({ identifier: "ReactionBody" });

// Returned by the add/remove-reaction endpoints: the target's full new set of
// per-emoji reaction summaries, so the client can reconcile an optimistic
// toggle without a follow-up read.
export const ReactionState = Schema.Struct({
  reactions: Schema.Array(ReactionSummary),
}).annotate({ identifier: "ReactionState" });
export type ReactionState = typeof ReactionState.Type;

export const DEFAULT_COMMENTS_LIMIT = 20;
export const MAX_COMMENTS_LIMIT = 100;

// Comments (and replies) are ordered oldest-first (`id asc`) within their
// thread and never reorder, so — like `PostsPageQuery` — a single forward
// keyset cursor ("give me the next `limit` with `id > cursor`") is enough.
// Left un-`identifier`-annotated for the same reason as `PostsPageQuery`
// above (see CLAUDE.md) — it's inlined into query parameters.
export const CommentsPageQuery = Schema.Struct({
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_COMMENTS_LIMIT }),
    ),
  ),
});

export const CommentsPage = Schema.Struct({
  comments: Schema.Array(Comment),
  limit: Schema.Finite,
  // Opaque cursor for the next page, or null once the thread is exhausted —
  // same fetch-one-past-`limit` trick as `PostsPage.nextCursor`.
  nextCursor: Schema.NullOr(Schema.String),
}).annotate({ identifier: "CommentsPage" });

// A chat is either a "direct" (exactly two participants, no title — the UI
// derives a name from the other participant) or a "group" chat (2-20
// participants, a title set at creation and changeable by its creator).
export const ChatType = Schema.Literals(["direct", "group"]).annotate({
  identifier: "ChatType",
});
export type ChatType = typeof ChatType.Type;

// Total participants a chat (of either kind) may ever have, creator included.
export const MAX_GROUP_PARTICIPANTS = 20;
const MAX_GROUP_TITLE_LENGTH = 100;

const GroupTitle = Schema.Trimmed.check(Schema.isNonEmpty()).check(
  Schema.isMaxLength(MAX_GROUP_TITLE_LENGTH),
);

// Per-chat role (issue #220) — distinct from `User.role` (site-wide admin).
// Only meaningful for group chats: a direct chat's two participants are
// both always "member". "owner" tracks `Chat.createdBy` 1:1 (see
// db/schema.ts); "admin" is granted by the owner via `updateParticipantRole`
// and, alongside "owner", can rename the group, add/remove participants, and
// delete any message in it.
export const ChatRole = Schema.Literals(["owner", "admin", "member"]).annotate({
  identifier: "ChatRole",
});
export type ChatRole = typeof ChatRole.Type;

export const ChatParticipant = Schema.Struct({
  userId: Schema.Finite,
  username: Schema.String,
  displayName: Schema.NullOr(Schema.String),
  // Same avatar fields as `User` above, mirrored here so a chat's participant
  // list (chat header, member list, chat-list preview) can render the same
  // avatar as everywhere else instead of falling back to initials.
  avatarUrl: Schema.NullOr(Schema.String),
  avatarVariants: Schema.NullOr(AvatarVariants),
  role: ChatRole,
  // Same custom-status fields as `User` above (issue #218), so a chat's
  // participant list (chat header, member list, chat-list preview) can render
  // it without a separate per-user lookup.
  statusText: Schema.NullOr(Schema.String),
  statusEmoji: Schema.NullOr(Schema.String),
  statusExpiresAt: Schema.NullOr(Schema.Finite),
}).annotate({ identifier: "ChatParticipant" });
export type ChatParticipant = typeof ChatParticipant.Type;

// Content types a message's body can hold — mirrors `PostContentType` but
// kept as its own union so messages and posts can diverge later.
export const MessageContentType = Schema.Literals([
  "text",
  "image_url",
  "attachment",
]).annotate({ identifier: "MessageContentType" });
export type MessageContentType = typeof MessageContentType.Type;

// Shorter than a post's cap — chat messages are conversational, not
// long-form content, so a generous-but-bounded limit keeps bubbles sane.
export const MAX_MESSAGE_CONTENT_LENGTH = 4_000;

const MessageContent = Schema.Trimmed.check(Schema.isNonEmpty()).check(
  Schema.isMaxLength(MAX_MESSAGE_CONTENT_LENGTH),
);

// How much of a quoted parent message's content is echoed in a reply's
// `parentMessage` preview (issue #217). Chat bubbles show only a one-line
// snippet of what's being replied to, so the full body (up to
// MAX_MESSAGE_CONTENT_LENGTH) never needs to ride along on every reply — the
// backend truncates to this before sending (see `toParentPreview` in
// ChatsHandler.ts). Kept generous enough to fill a preview line at any
// sensible width.
export const PARENT_MESSAGE_PREVIEW_LENGTH = 120;

// A lightweight quote of the message a reply points at (issue #217) — just
// enough to render "replying to <sender>: <snippet>" above the reply, without
// embedding a full (potentially itself-a-reply) `Message` and recursing.
// `senderName` is the parent sender's resolved display name (displayName ??
// username), joined server-side so the client needn't have that user in hand
// (they might have since left the chat). `content` is truncated to
// PARENT_MESSAGE_PREVIEW_LENGTH; `contentType` lets the client show "Photo"/
// "Attachment" instead of a raw URL/filename for non-text parents.
export const ParentMessagePreview = Schema.Struct({
  id: Schema.Finite,
  senderId: Schema.Finite,
  senderName: Schema.String,
  contentType: MessageContentType,
  content: Schema.String,
}).annotate({ identifier: "ParentMessagePreview" });
export type ParentMessagePreview = typeof ParentMessagePreview.Type;

export const Message = Schema.Struct({
  id: Schema.Finite,
  chatId: Schema.Finite,
  senderId: Schema.Finite,
  contentType: MessageContentType,
  content: Schema.String,
  // Set only when contentType is "attachment" — see `Attachment` above.
  attachment: Schema.NullOr(Attachment),
  // The message this one is a reply to (issue #217), as a lightweight preview
  // — null for a normal (non-reply) message, or when the quoted message has
  // since been deleted (the FK is `set null`, see db/schema.ts).
  parentMessage: Schema.NullOr(ParentMessagePreview),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
  // Ids of participants (other than the sender) who have read this message —
  // read state is tracked per message/user, not as a single chat-wide flag,
  // so the UI can show WhatsApp/Telegram-style read receipts.
  readByUserIds: Schema.Array(Schema.Finite),
  // Emoji reactions on this message (issue #216) — computed on read (see
  // reactions.ts) rather than stored, same convention as `Post.reactions`/
  // `Comment.reactions`: one entry per emoji with at least one reaction.
  reactions: Schema.Array(ReactionSummary),
  // Pinned and starred flags (issue #223) — computed on read (see
  // pinsStars.ts), not stored on the row. `pinned` is chat-wide: true when
  // this message is currently pinned for every participant to see. `starred`
  // is per-viewer: true when the requesting user has personally bookmarked it
  // (never reflects anyone else's stars). Both default to false.
  pinned: Schema.Boolean,
  starred: Schema.Boolean,
}).annotate({ identifier: "Message" });
export type Message = typeof Message.Type;

export const Chat = Schema.Struct({
  id: Schema.Finite,
  type: ChatType,
  title: Schema.NullOr(Schema.String),
  // Null once the creator's account has been deleted (see db/schema.ts) —
  // the chat and its history survive, but creator-only actions (rename, add
  // participants) become unavailable to everyone.
  createdBy: Schema.NullOr(Schema.Finite),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
  // Monotonically increases on every participant-visible change to this chat
  // (see db/schema.ts). Also carried on the `chat_updated` realtime event, so
  // a client can compare the two to tell whether it's missed an update
  // (issue #55) rather than only refetching whenever the next event happens
  // to arrive.
  version: Schema.Finite,
  participants: Schema.Array(ChatParticipant),
  lastMessage: Schema.NullOr(Message),
  // Messages in this chat sent by someone else that the current user hasn't
  // read yet — computed relative to whoever is making the request.
  unreadCount: Schema.Finite,
  // Uploaded-and-cropped group avatar, set via `POST /chats/:id/avatar` and
  // cleared via `DELETE /chats/:id/avatar` — always null for a direct chat
  // (the UI renders the other participant's own avatar instead, same as
  // `title`). Same nested shape as `User.avatarVariants`/
  // `ChatParticipant.avatarVariants` (see `AvatarVariants` above), but unlike
  // those there's no `avatarUrl` counterpart here: a group avatar only ever
  // comes from an upload, not a linked external image.
  avatarVariants: Schema.NullOr(AvatarVariants),
}).annotate({ identifier: "Chat" });
export type Chat = typeof Chat.Type;

export const CreateDirectChatBody = Schema.Struct({
  userId: Schema.Finite,
}).annotate({ identifier: "CreateDirectChatBody" });

export const CreateGroupChatBody = Schema.Struct({
  title: GroupTitle,
  // The creator is added automatically — this is everyone *else*, hence one
  // short of the overall cap.
  participantIds: Schema.Array(Schema.Finite).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_GROUP_PARTICIPANTS - 1),
  ),
}).annotate({ identifier: "CreateGroupChatBody" });

export const UpdateChatBody = Schema.Struct({
  title: GroupTitle,
}).annotate({ identifier: "UpdateChatBody" });

export const AddParticipantsBody = Schema.Struct({
  // A group can never hold more than MAX_GROUP_PARTICIPANTS total, so a
  // single request can never legitimately add more than that minus the
  // existing creator — mirrors CreateGroupChatBody's cap.
  participantIds: Schema.Array(Schema.Finite).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_GROUP_PARTICIPANTS - 1),
  ),
}).annotate({ identifier: "AddParticipantsBody" });

export const TransferOwnershipBody = Schema.Struct({
  userId: Schema.Finite,
}).annotate({ identifier: "TransferOwnershipBody" });

// "owner" is deliberately excluded — appointing an owner goes through
// `POST /chats/:id/owner` (`TransferOwnershipBody`) instead, since that also
// has to move `Chat.createdBy` and demote the previous owner.
export const UpdateParticipantRoleBody = Schema.Struct({
  role: Schema.Literals(["admin", "member"]),
}).annotate({ identifier: "UpdateParticipantRoleBody" });

// Total invites that may exist (active + expired + revoked) for a single
// chat — bounds the table's per-chat growth from repeated
// create/revoke cycles.
export const MAX_INVITES_PER_CHAT = 50;

export const CreateChatInviteBody = Schema.Struct({
  // Omitted means "never expires".
  expiresInHours: Schema.optional(
    Schema.Finite.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 1, maximum: 24 * 30 }),
    ),
  ),
  // Omitted means "unlimited uses" (still bounded by the chat's own
  // MAX_GROUP_PARTICIPANTS cap at redemption time).
  maxUses: Schema.optional(
    Schema.Finite.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 1, maximum: MAX_GROUP_PARTICIPANTS }),
    ),
  ),
}).annotate({ identifier: "CreateChatInviteBody" });

export const ChatInvite = Schema.Struct({
  id: Schema.Finite,
  chatId: Schema.Finite,
  code: Schema.String,
  createdBy: Schema.Finite,
  createdAt: Schema.Finite,
  expiresAt: Schema.NullOr(Schema.Finite),
  maxUses: Schema.NullOr(Schema.Finite),
  useCount: Schema.Finite,
  revokedAt: Schema.NullOr(Schema.Finite),
}).annotate({ identifier: "ChatInvite" });
export type ChatInvite = typeof ChatInvite.Type;

export const CreateMessageBody = Schema.Struct({
  contentType: MessageContentType,
  content: MessageContent,
  // Id of a previously-uploaded attachment (`POST /attachments`) owned by
  // the caller — required exactly when contentType is "attachment".
  attachmentId: Schema.optional(Schema.Finite),
  // Id of the message this one replies to (issue #217). Omitted for a normal
  // message. Validated server-side to reference a message in this same chat —
  // a parent from another chat (or a nonexistent one) 404s (see
  // ChatsHandler.ts).
  parentMessageId: Schema.optional(Schema.Finite),
})
  .check(
    Schema.makeFilter(requireAllowedImageUrl),
    Schema.makeFilter(requireAttachmentId),
  )
  .annotate({ identifier: "CreateMessageBody" });

export const UpdateMessageBody = Schema.Struct({
  contentType: MessageContentType,
  content: MessageContent,
  attachmentId: Schema.optional(Schema.Finite),
})
  .check(
    Schema.makeFilter(requireAllowedImageUrl),
    Schema.makeFilter(requireAttachmentId),
  )
  .annotate({ identifier: "UpdateMessageBody" });

export const MarkReadBody = Schema.Struct({
  messageId: Schema.Finite,
}).annotate({ identifier: "MarkReadBody" });

// Which message to pin, for `POST /chats/:id/pins` (issue #223). Unpinning
// takes the message id in the path (`DELETE /chats/:id/pins/:messageId`)
// instead, so it needs no body. Validated server-side to reference a message
// in this same chat (see ChatsHandler.ts).
export const PinMessageBody = Schema.Struct({
  messageId: Schema.Finite,
}).annotate({ identifier: "PinMessageBody" });

export const DEFAULT_MESSAGES_LIMIT = 30;
export const MAX_MESSAGES_LIMIT = 100;

// `messages` is ordered oldest-first (`id asc`) within a chat. Unlike
// `PostsPageQuery`'s single forward cursor, the chat view needs to page in
// both directions — backward for "load earlier" (infinite-scroll-to-top) and
// forward to catch up on newly-arrived messages without re-fetching the whole
// window — plus land directly on the newest messages on first open without a
// separate `COUNT(*)` to compute an OFFSET into. So this takes an optional
// `before` *or* `after` cursor instead of `offset`: neither set returns the
// newest page, `before` returns the `limit` messages immediately preceding
// that cursor, and `after` returns the `limit` messages immediately
// following it (issue #50). At most one of `before`/`after` may be set.
// Cursors are opaque to clients — see `PostsPageQuery` above.
export const MessagesPageQuery = Schema.Struct({
  before: Schema.optional(Schema.String),
  after: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_MESSAGES_LIMIT }),
    ),
  ),
});

export const MessagesPage = Schema.Struct({
  messages: Schema.Array(Message),
  limit: Schema.Finite,
  // Whether messages exist before/after the first/last row in this page —
  // derived from fetching one row past `limit` rather than a `COUNT(*)`, same
  // trick as `PostsPage.nextCursor` (issue #51).
  hasEarlier: Schema.Boolean,
  hasNewer: Schema.Boolean,
  // Opaque cursors for the adjacent pages, or null once there's nothing more
  // in that direction to fetch.
  earliestCursor: Schema.NullOr(Schema.String),
  latestCursor: Schema.NullOr(Schema.String),
}).annotate({ identifier: "MessagesPage" });

// Below this, a search isn't narrow enough to be worth running for a regular
// user — keeps the query cost and result size from growing with the user
// base (issue #48). Admins are exempt: they need to be able to browse the
// full directory, not just run narrow searches. The schema below can't see
// the caller's role, so this floor is enforced in UsersHandler.ts instead,
// only against non-admin callers.
export const MIN_USER_SEARCH_QUERY_LENGTH = 3;

// A query longer than the longest possible username can never usefully
// narrow an ILIKE match — bounded mainly to keep the request small.
export const MAX_USER_SEARCH_QUERY_LENGTH = 64;

// Left un-`identifier`-annotated for the same reason as `PostsPageQuery`
// above (see CLAUDE.md) — it's inlined into query parameters. No
// `minLength` here (see `MIN_USER_SEARCH_QUERY_LENGTH` above) — an empty `q`
// is how an admin lists everyone.
export const UserSearchQuery = Schema.Struct({
  q: Schema.Trim.check(Schema.isMaxLength(MAX_USER_SEARCH_QUERY_LENGTH)),
});

// Raised by `searchUsers` when a non-admin caller's query is shorter than
// `MIN_USER_SEARCH_QUERY_LENGTH` — admins never trigger this (see above).
export class InvalidUserSearchRequest extends Schema.TaggedError<InvalidUserSearchRequest>()(
  "InvalidUserSearchRequest",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

// How many usernames one `GET /users/by-username` call may resolve (issue
// #318). Comfortably more distinct `@mentions` than a single post, comment
// or message realistically carries, while keeping the `IN (…)` list — and
// the response — bounded no matter what a client asks for.
export const MAX_USERNAME_LOOKUP_COUNT = 32;

// Cap on the raw comma-separated parameter: `MAX_USERNAME_LOOKUP_COUNT`
// maximum-length usernames plus the commas between them.
export const MAX_USERNAME_LOOKUP_LENGTH =
  MAX_USERNAME_LOOKUP_COUNT * (MAX_USERNAME_LENGTH + 1);

// Comma-separated rather than a repeated query parameter so the whole batch
// stays a single scalar value — one query key on the client, one string to
// bound here. Left un-`identifier`-annotated for the same reason as
// `UserSearchQuery` above (see CLAUDE.md).
export const UsernameLookupQuery = Schema.Struct({
  usernames: Schema.Trim.check(Schema.isMaxLength(MAX_USERNAME_LOOKUP_LENGTH)),
});

// Raised by `lookupUsersByUsername` when a caller asks for more than
// `MAX_USERNAME_LOOKUP_COUNT` usernames at once. Names that don't resolve
// are *not* an error — they're simply absent from the response (see the
// handler), so an `@mention` of someone who doesn't exist renders as plain
// text rather than failing the whole lookup.
export class InvalidUsernameLookupRequest extends Schema.TaggedError<InvalidUsernameLookupRequest>()(
  "InvalidUsernameLookupRequest",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

// Mime types `POST /users/me/avatar` accepts (issue #269) — narrower than
// `ALLOWED_ATTACHMENT_MIME_TYPES`: no GIF (animated avatars are explicitly
// out of scope for the initial cut) and no video/audio.
export const ALLOWED_AVATAR_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

// Avatars don't need anywhere near MAX_ATTACHMENT_SIZE_BYTES's budget — a
// single photo, not arbitrary chat media.
export const MAX_AVATAR_UPLOAD_SIZE_BYTES = 8 * 1024 * 1024;

// Multipart payload: the image file plus the square crop rectangle chosen by
// the frontend's crop UI, in the pixel coordinates of the (EXIF-rotated)
// uploaded image — see `processAvatar` in ImageProcessing.ts, which
// re-validates it against the actual decoded image rather than trusting
// these values. Left un-`identifier`-annotated like `UploadAttachmentBody`
// below. `maxFileSize` here is the same coarse in-stream backstop
// `UploadAttachmentBody` uses — set looser than MAX_AVATAR_UPLOAD_SIZE_BYTES
// so an ordinary too-large upload trips the handler's precise, typed
// AvatarTooLarge (413) check instead of a generic 400 from the multipart
// parser itself.
const UploadAvatarBody = Schema.Struct({
  file: Multipart.SingleFileSchema,
  x: Schema.FiniteFromString.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
  ),
  y: Schema.FiniteFromString.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
  ),
  size: Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThan(0)),
}).pipe(
  HttpApiSchema.asMultipart({ maxFileSize: MAX_AVATAR_UPLOAD_SIZE_BYTES * 2 }),
);

const UsersGroup = HttpApiGroup.make("users")
  .add(
    // Replaces the old unpaginated "list every user" endpoint (issue #48):
    // the full directory isn't exposed to every authenticated user anymore,
    // only search results for a query of at least
    // `MIN_USER_SEARCH_QUERY_LENGTH` characters — except for admins, who can
    // pass a shorter (including empty) `q` to browse the full directory.
    HttpApiEndpoint.get("searchUsers", "/users/search", {
      query: UserSearchQuery,
      success: Schema.Array(User),
      error: InvalidUserSearchRequest,
    }).middleware(Authentication),
  )
  .add(
    // Resolves a batch of `@username` mentions to the users they refer to
    // (issue #318), so the client can link each one to its profile without
    // abusing `searchUsers` (an ILIKE scan, and off-limits below
    // `MIN_USER_SEARCH_QUERY_LENGTH` characters for non-admins — which a
    // short username would trip). Matching is case-insensitive, mirroring
    // the case-insensitive uniqueness of `username` itself (issue #175).
    // Registered ahead of `getUser` so `/users/by-username` isn't first
    // matched against `/users/:id`.
    HttpApiEndpoint.get("lookupUsersByUsername", "/users/by-username", {
      query: UsernameLookupQuery,
      success: Schema.Array(User),
      error: InvalidUsernameLookupRequest,
    }).middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.get("getUser", "/users/:id", {
      params: { id: Schema.Int },
      success: User,
      error: NotFound,
    }).middleware(Authentication),
  )
  .add(
    // Recent posts by this user, newest-first (issue #316) — the data
    // backing the profile page's activity feed. Same keyset pagination as
    // `listPosts`, but pre-filtered to one author instead of the whole feed.
    HttpApiEndpoint.get("listUserPosts", "/users/:id/posts", {
      params: { id: Schema.Int },
      query: PostsPageQuery,
      success: UserPostsPage,
      error: [NotFound, InvalidPostsRequest],
    }).middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.post("register", "/users/register", {
      payload: RegisterBody,
      success: User.pipe(HttpApiSchema.status(201)),
      error: [UsernameTaken, TooManyRequests],
    }),
  )
  .add(
    HttpApiEndpoint.post("login", "/users/login", {
      payload: LoginBody,
      success: LoginResponse,
      error: [InvalidCredentials, TooManyRequests],
    }),
  )
  .add(
    HttpApiEndpoint.post("refresh", "/users/refresh", {
      payload: RefreshBody,
      success: RefreshResponse,
      error: [InvalidCredentials, TooManyRequests],
    }),
  )
  .add(
    // Revokes the presented refresh token (or, with `allSessions`, every
    // refresh token for its user) by deleting its store row. Idempotent and
    // unauthenticated like `refresh` — an already-invalid/expired token has
    // nothing to revoke, so it still succeeds rather than erroring.
    HttpApiEndpoint.post("logout", "/users/logout", {
      payload: LogoutBody,
      success: HttpApiSchema.NoContent,
    }),
  )
  .add(
    // Changes the current user's own password after verifying the current
    // one. Bumps token_version so every other outstanding token (access +
    // refresh, all sessions/devices) is revoked immediately — mirroring
    // `logout`'s `allSessions` option — while reissuing a fresh access +
    // refresh pair for the session making this request, so it isn't logged
    // out by its own password change.
    HttpApiEndpoint.post("changePassword", "/users/me/password", {
      payload: ChangePasswordBody,
      success: RefreshResponse,
      error: [InvalidCredentials, TooManyRequests],
    }).middleware(Authentication),
  )
  .add(
    // Updates the current user's own profile — display name and avatar URL
    // (issue #67). Full-replace like `updatePost`/`updateChat`. Username is
    // not editable through this endpoint.
    HttpApiEndpoint.put("updateProfile", "/users/me", {
      payload: UpdateProfileBody,
      success: User,
    }).middleware(Authentication),
  )
  .add(
    // Uploads and stores a square-cropped avatar (issue #269), overwriting
    // any existing uploaded avatar and clearing `avatarUrl` — the two are
    // mutually exclusive (see UsersHandler.ts). `updateProfile` above is the
    // inverse: setting `avatarUrl` (or clearing it) always clears an
    // uploaded avatar back to unset.
    HttpApiEndpoint.post("uploadAvatar", "/users/me/avatar", {
      payload: UploadAvatarBody,
      success: User,
      error: [InvalidAvatarUpload, AvatarTooLarge, TooManyRequests],
    }).middleware(Authentication),
  )
  .add(
    // Permanently deletes the current user's own account after re-verifying
    // their password (irreversible, so — like `changePassword` — the bearer
    // token alone isn't enough). The `users` row's cascading/`set null` FKs
    // (see db/schema.ts) take care of everything the account owns.
    HttpApiEndpoint.delete("deleteAccount", "/users/me", {
      payload: DeleteAccountBody,
      success: HttpApiSchema.NoContent,
      error: [InvalidCredentials, TooManyRequests],
    }).middleware(Authentication),
  )
  .add(
    // Promotes/demotes another user's role — admin only (issue #67: role
    // changes previously required direct DB access). Bumps the target's
    // token_version so an already-issued token can't keep acting under its
    // old role past this call — mirrors `changePassword`'s reasoning.
    HttpApiEndpoint.patch("updateUserRole", "/users/:id/role", {
      params: { id: Schema.Int },
      payload: UpdateUserRoleBody,
      success: User,
      error: [NotFound, Forbidden],
    }).middleware(Authentication),
  )
  .add(
    // Permanently deletes another user's account — admin only. Distinct from
    // `deleteAccount` (`DELETE /users/me`), which is self-service and
    // re-proves the caller's own password; this is an administrative action
    // authorized purely by the caller's admin role, so it takes no body. The
    // target `users` row's cascading/`set null` FKs (db/schema.ts) clean up
    // everything the account owns, and — like `deleteAccount` — the target's
    // outstanding tokens are invalidated immediately. An admin can't delete
    // their own account here (that goes through `deleteAccount`).
    HttpApiEndpoint.delete("deleteUser", "/users/:id", {
      params: { id: Schema.Int },
      success: HttpApiSchema.NoContent,
      error: [NotFound, Forbidden],
    }).middleware(Authentication),
  )
  .add(
    // Sets or clears the current user's custom status (issue #218) — a short
    // message plus an optional emoji, with an optional auto-expiry.
    // Full-replace like `updateProfile`: setting both `statusText` and
    // `statusEmoji` to null clears the status entirely. Broadcasts a
    // `status_changed` realtime event (see Realtime.ts) to every connected
    // user, mirroring how presence updates propagate.
    HttpApiEndpoint.put("updateStatus", "/users/me/status", {
      payload: UpdateStatusBody,
      success: User,
    }).middleware(Authentication),
  )
  .add(
    // Lists everyone the current user has blocked or muted (issue #219),
    // newest first — the data backing the "Blocked & muted users" settings
    // card. Each entry carries the target user, which action is in effect,
    // and when it was set.
    HttpApiEndpoint.get("listBlocks", "/users/me/blocks", {
      success: Schema.Array(BlockedUser),
    }).middleware(Authentication),
  )
  .add(
    // Blocks or mutes another user (issue #219). Idempotent per (caller,
    // target): re-issuing with a different `type` upgrades/downgrades the
    // existing relationship rather than stacking a second one. Returns the
    // resulting relationship. You can't block/mute yourself (400).
    HttpApiEndpoint.put("setBlock", "/users/:id/block", {
      params: { id: Schema.Int },
      payload: BlockUserBody,
      success: BlockedUser,
      error: [NotFound, InvalidBlockRequest],
    }).middleware(Authentication),
  )
  .add(
    // Removes any block/mute the current user has on the target — the
    // unblock/unmute action. Idempotent: succeeds even if no relationship
    // exists (nothing to remove).
    HttpApiEndpoint.delete("removeBlock", "/users/:id/block", {
      params: { id: Schema.Int },
      success: HttpApiSchema.NoContent,
    }).middleware(Authentication),
  );

const PostsGroup = HttpApiGroup.make("posts")
  .add(
    HttpApiEndpoint.get("getPost", "/posts/:id", {
      params: { id: Schema.Int },
      success: Post,
      error: NotFound,
    }).middleware(Authentication),
  )
  .add(
    // Authenticated, paginated view over all posts.
    HttpApiEndpoint.get("listPosts", "/posts", {
      query: PostsPageQuery,
      success: PostsPage,
      error: InvalidPostsRequest,
    }).middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.post("createPost", "/posts", {
      payload: CreatePostBody,
      success: Post.pipe(HttpApiSchema.status(201)),
      // Raised when `attachmentId` doesn't reference an attachment owned by
      // the caller (see getOwnedAttachmentOr404 in attachments.ts).
      error: NotFound,
    }).middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.put("updatePost", "/posts/:id", {
      params: { id: Schema.Int },
      payload: UpdatePostBody,
      success: Post,
      error: [NotFound, Forbidden],
    }).middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.delete("deletePost", "/posts/:id", {
      params: { id: Schema.Int },
      success: HttpApiSchema.NoContent,
      error: [NotFound, Forbidden],
    }).middleware(Authentication),
  );

// Comments, replies, and reactions on posts/comments. Kept in its own group
// (rather than folded into `posts`) since it spans two path roots
// (`/posts/:id/...` and `/comments/:id/...`) and its own handler — the group
// name is just an organizational label, it doesn't have to match the path.
const IdParam = Schema.Struct({ id: Schema.Int });

const CommentsGroup = HttpApiGroup.make("comments")
  .add(
    // Idempotent add-reaction on a post — reacting with an emoji already
    // reacted with is a no-op, returning the current state. Emits a
    // feed-wide `reaction_changed` realtime event.
    HttpApiEndpoint.post("addPostReaction", "/posts/:id/reactions", {
      params: IdParam,
      payload: ReactionBody,
      success: ReactionState,
      error: [NotFound, TooManyRequests],
    }).middleware(Authentication),
  )
  .add(
    // Removes one specific emoji reaction — a user may have reacted with more
    // than one emoji on the same target, so this only clears the one named in
    // the payload, not every reaction of theirs on it.
    HttpApiEndpoint.delete("removePostReaction", "/posts/:id/reactions", {
      params: IdParam,
      payload: ReactionBody,
      success: ReactionState,
      error: [NotFound, TooManyRequests],
    }).middleware(Authentication),
  )
  .add(
    // Oldest-first page of a post's top-level comments (replies excluded —
    // fetch those per-comment via `listReplies`). Keyset-paginated like
    // `listPosts`.
    HttpApiEndpoint.get("listComments", "/posts/:id/comments", {
      params: IdParam,
      query: CommentsPageQuery,
      success: CommentsPage,
      error: [NotFound, InvalidCommentRequest],
    }).middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.post("createComment", "/posts/:id/comments", {
      params: IdParam,
      payload: CreateCommentBody,
      success: Comment.pipe(HttpApiSchema.status(201)),
      error: [NotFound, TooManyRequests],
    }).middleware(Authentication),
  )
  .add(
    // Oldest-first page of a comment's replies.
    HttpApiEndpoint.get("listReplies", "/comments/:id/replies", {
      params: IdParam,
      query: CommentsPageQuery,
      success: CommentsPage,
      error: [NotFound, InvalidCommentRequest],
    }).middleware(Authentication),
  )
  .add(
    // Creates a reply to a top-level comment. Rejects (400) if the target is
    // itself a reply — the depth-2 nesting cap (see EngagementHandler.ts).
    HttpApiEndpoint.post("createReply", "/comments/:id/replies", {
      params: IdParam,
      payload: CreateCommentBody,
      success: Comment.pipe(HttpApiSchema.status(201)),
      error: [NotFound, InvalidCommentRequest, TooManyRequests],
    }).middleware(Authentication),
  )
  .add(
    // Add-reaction on a comment or reply (both live in `comments`, so one
    // endpoint covers both). Emits a `reaction_changed` event scoped to the
    // post's comment-room subscribers rather than broadcast feed-wide.
    HttpApiEndpoint.post("addCommentReaction", "/comments/:id/reactions", {
      params: IdParam,
      payload: ReactionBody,
      success: ReactionState,
      error: [NotFound, TooManyRequests],
    }).middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.delete("removeCommentReaction", "/comments/:id/reactions", {
      params: IdParam,
      payload: ReactionBody,
      success: ReactionState,
      error: [NotFound, TooManyRequests],
    }).middleware(Authentication),
  )
  .add(
    // Edits a comment/reply's content — the author only (or an admin), same
    // `canModify` rule as posts.
    HttpApiEndpoint.patch("updateComment", "/comments/:id", {
      params: IdParam,
      payload: UpdateCommentBody,
      success: Comment,
      error: [NotFound, Forbidden, TooManyRequests],
    }).middleware(Authentication),
  )
  .add(
    // Deletes a comment/reply — the author only (or an admin). A top-level
    // comment's replies and every like on it cascade via the FKs.
    HttpApiEndpoint.delete("deleteComment", "/comments/:id", {
      params: IdParam,
      success: HttpApiSchema.NoContent,
      error: [NotFound, Forbidden, TooManyRequests],
    }).middleware(Authentication),
  );

const ChatIdPath = Schema.Struct({ id: Schema.Int });

const MessageIdPath = Schema.Struct({
  id: Schema.Int,
  messageId: Schema.Int,
});

const ChatParticipantPath = Schema.Struct({
  id: Schema.Int,
  userId: Schema.Int,
});

const ChatInvitePath = Schema.Struct({
  id: Schema.Int,
  inviteId: Schema.Int,
});

const InviteCodePath = Schema.Struct({
  code: Schema.String,
});

export const DEFAULT_CHATS_LIMIT = 30;
export const MAX_CHATS_LIMIT = 100;

// `listChats` sorts by `updated_at desc, id desc`, and a chat's `updated_at`
// bumps to "now" on every new message — so an OFFSET-based page (like
// PostsPageQuery/MessagesPageQuery) would see rows shift out from under an
// in-flight offset as chats jump to the top mid-scroll, producing skipped or
// duplicated rows across pages. A keyset cursor instead resumes from
// "everything strictly after the last row I saw", which stays correct
// regardless of what changes ahead of it (issue #49). The cursor is opaque
// to clients: it's `<lastRow.updatedAt>:<lastRow.id>`, base64url-encoded, and
// only ever round-tripped from a previous page's `nextCursor` rather than
// constructed by hand.
//
// Left un-`identifier`-annotated for the same reason as `PostsPageQuery`
// above (see CLAUDE.md) — it's inlined into query parameters.
export const ChatsPageQuery = Schema.Struct({
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_CHATS_LIMIT }),
    ),
  ),
});

export const ChatsPage = Schema.Struct({
  chats: Schema.Array(Chat),
  limit: Schema.Finite,
  // Opaque cursor for the next page, or null once the current page reaches
  // the end of the list — mirrors `MessagesPage.hasMore` but carries the
  // resume point instead of a boolean, since the next request needs it.
  nextCursor: Schema.NullOr(Schema.String),
}).annotate({ identifier: "ChatsPage" });

// ---------------------------------------------------------------------------
// Search (issue #224, overhauled)
//
// One unified endpoint (`GET /search`) returns the top matches across all four
// searchable things at once — people, posts, comments/replies, and the
// caller's chat messages — so the results page renders from a single round
// trip instead of one request per section. Four keyset-paginated per-type
// endpoints back the "see all of this kind" tabs, each resuming exactly where
// the unified page left off.
//
// Matching is deliberately *not* whole-word-only: a row matches when either
// its indexed `tsvector` matches the query's tokens as words/prefixes (so
// "run" finds "running" and "jum" finds "jumps" mid-type) *or* every token
// appears as a raw substring anywhere in the text (so "ragmen" finds
// "fragmentary"). Both branches are index-served — a GIN index over the
// generated `tsvector` (migration 0017) and GIN trigram indexes (migration
// 0023) respectively — so neither degrades into a sequential scan as the
// tables grow. See src/search.ts for the query analysis and src/SearchHandler.ts
// for how the two branches are combined (a union of per-branch subqueries, not
// an `OR` — the difference is what keeps both indexes usable).
//
// Content results are ordered newest-match-first (`id desc`) with the same
// opaque single-column cursor as `listPosts`, rather than by relevance rank:
// recency keyset-paginates cleanly and predictably (no OFFSET, no re-ranking
// the whole match set per page), and the highlighted snippet already gives the
// user the relevance context inline. People results are the one exception —
// they're ranked by match quality (exact username, then prefix, then anywhere)
// and then alphabetically, which is what a "find a person" list has to do to
// be useful; their cursor carries that whole sort tuple.
//
// Every result row is a purpose-built projection — the matched text's id, its
// author/chat context, its timestamp and the snippet — not a full
// `Post`/`Comment`/`Message`. A results list renders none of the reactions,
// comment counts, read receipts or quoted parents those carry, and each of
// them costs an extra query per page, so the search response deliberately
// doesn't pay for them.
// ---------------------------------------------------------------------------

// Short enough to still be a useful search (a two-letter prefix is already
// selective once stemmed), but a floor so a single-character `q` can't ask
// Postgres to match half the table. Mirrors MIN_USER_SEARCH_QUERY_LENGTH's
// rationale (issue #48), a touch lower since search is index-served.
export const MIN_SEARCH_QUERY_LENGTH = 2;

// Bounds the request; no real search phrase approaches this, and a longer
// string can only be noise the tokenizer would discard anyway.
export const MAX_SEARCH_QUERY_LENGTH = 100;

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 50;

// The unified endpoint returns a *preview* of each section — enough rows to
// show what kind of matches exist, with the per-type endpoints taking over
// from there — so its per-section limit is much smaller than a full page's.
export const DEFAULT_SEARCH_ALL_LIMIT = 5;
export const MAX_SEARCH_ALL_LIMIT = 10;

// Left un-`identifier`-annotated for the same reason as `PostsPageQuery`
// above (see CLAUDE.md) — it's inlined into query parameters. `q` is trimmed
// and length-bounded here; its *contents* are never interpreted as SQL — the
// handler only ever passes it (or tokens derived from it) as bound
// parameters.
export const SearchQuery = Schema.Struct({
  q: Schema.Trim.check(
    Schema.isMinLength(MIN_SEARCH_QUERY_LENGTH),
    Schema.isMaxLength(MAX_SEARCH_QUERY_LENGTH),
  ),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_SEARCH_LIMIT }),
    ),
  ),
});

// Same query text, but no cursor: the unified endpoint is always the *first*
// page of every section (pagination is the per-type endpoints' job), and its
// `limit` applies per section rather than to a single list.
export const SearchAllQuery = Schema.Struct({
  q: Schema.Trim.check(
    Schema.isMinLength(MIN_SEARCH_QUERY_LENGTH),
    Schema.isMaxLength(MAX_SEARCH_QUERY_LENGTH),
  ),
  limit: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_SEARCH_ALL_LIMIT }),
    ),
  ),
});

// One run of a matched snippet. The backend splits the matched text into an
// ordered list of runs, each flagged `match` or not (see `buildSnippet` in
// src/search.ts), so the frontend can render the highlight as escaped React
// text (a `<mark>` around matched runs) — never as raw HTML — keeping user
// content that happens to contain markup inert (no stored XSS via the
// snippet).
export const SearchSnippetSegment = Schema.Struct({
  text: Schema.String,
  match: Schema.Boolean,
}).annotate({ identifier: "SearchSnippetSegment" });
export type SearchSnippetSegment = typeof SearchSnippetSegment.Type;

// People. The snippet highlights the matched fragment inside whichever name
// matched (display name if it did, else the username), so a hit in the middle
// of a name is visible rather than leaving the user guessing why the row is
// there.
export const UserSearchResult = Schema.Struct({
  user: User,
  snippet: Schema.Array(SearchSnippetSegment),
}).annotate({ identifier: "UserSearchResult" });

export const UserSearchPage = Schema.Struct({
  results: Schema.Array(UserSearchResult),
  limit: Schema.Finite,
  nextCursor: Schema.NullOr(Schema.String),
}).annotate({ identifier: "UserSearchPage" });

// Posts. `author` is joined in rather than left for the client to resolve —
// a results list always renders the name and avatar, and resolving them
// client-side would mean a second request before the list can paint.
export const PostSearchResult = Schema.Struct({
  id: Schema.Finite,
  author: User,
  createdAt: Schema.Finite,
  snippet: Schema.Array(SearchSnippetSegment),
}).annotate({ identifier: "PostSearchResult" });

export const PostSearchPage = Schema.Struct({
  results: Schema.Array(PostSearchResult),
  limit: Schema.Finite,
  nextCursor: Schema.NullOr(Schema.String),
}).annotate({ identifier: "PostSearchPage" });

// Comments and replies (a reply is a comment with a `parentCommentId` — both
// are searched, and the flag lets the UI label which is which). `postId` is
// carried so the frontend can deep-link to the thread the match lives in
// without a second lookup.
export const CommentSearchResult = Schema.Struct({
  id: Schema.Finite,
  postId: Schema.Finite,
  parentCommentId: Schema.NullOr(Schema.Finite),
  author: User,
  createdAt: Schema.Finite,
  snippet: Schema.Array(SearchSnippetSegment),
}).annotate({ identifier: "CommentSearchResult" });

export const CommentSearchPage = Schema.Struct({
  results: Schema.Array(CommentSearchResult),
  limit: Schema.Finite,
  nextCursor: Schema.NullOr(Schema.String),
}).annotate({ identifier: "CommentSearchPage" });

// Lightweight chat context for a message hit — just enough for the results
// list to render the same name/avatar the chat list does (group title, or the
// other participant of a direct chat) and link through, without paying for a
// full `Chat` (last message, unread count, version) per row. Deduplicated per
// page into `MessageSearchPage.chats`, keyed by `id`.
export const MessageSearchChat = Schema.Struct({
  id: Schema.Finite,
  type: ChatType,
  title: Schema.NullOr(Schema.String),
  participants: Schema.Array(ChatParticipant),
}).annotate({ identifier: "MessageSearchChat" });
export type MessageSearchChat = typeof MessageSearchChat.Type;

export const MessageSearchResult = Schema.Struct({
  id: Schema.Finite,
  // Carries `chatId`; resolve its `MessageSearchChat` from the page's `chats`.
  chatId: Schema.Finite,
  sender: User,
  createdAt: Schema.Finite,
  snippet: Schema.Array(SearchSnippetSegment),
}).annotate({ identifier: "MessageSearchResult" });

export const MessageSearchPage = Schema.Struct({
  results: Schema.Array(MessageSearchResult),
  // Every chat referenced by a result in `results`, deduplicated — only chats
  // the current user still participates in are ever searched (the handler
  // joins on their participant rows), so a hit can never leak a message from a
  // chat they're not in.
  chats: Schema.Array(MessageSearchChat),
  limit: Schema.Finite,
  nextCursor: Schema.NullOr(Schema.String),
}).annotate({ identifier: "MessageSearchPage" });

// The unified response: the first page of every section, each in exactly the
// shape its own endpoint returns — including `nextCursor`, so switching to a
// section's tab continues from here instead of re-fetching what's already on
// screen.
export const SearchAllPage = Schema.Struct({
  users: UserSearchPage,
  posts: PostSearchPage,
  comments: CommentSearchPage,
  messages: MessageSearchPage,
}).annotate({ identifier: "SearchAllPage" });

const SearchGroup = HttpApiGroup.make("search")
  .add(
    // Everything at once: the top matches for people, posts, comments and the
    // caller's messages in a single request. The four queries run
    // concurrently server-side, so the whole thing costs about what its
    // slowest section does.
    HttpApiEndpoint.get("searchAll", "/search", {
      query: SearchAllQuery,
      success: SearchAllPage,
      error: InvalidSearchRequest,
    }).middleware(Authentication),
  )
  .add(
    // People, best match first (see the section comment above). Keeps
    // `GET /users/search`'s own floor (issue #48): a non-admin's query must
    // be at least `MIN_USER_SEARCH_QUERY_LENGTH` characters, or this section
    // comes back empty — empty rather than a 400, so a two-character search
    // still answers normally for every other section.
    HttpApiEndpoint.get("searchUsers", "/search/users", {
      query: SearchQuery,
      success: UserSearchPage,
      error: InvalidSearchRequest,
    }).middleware(Authentication),
  )
  .add(
    // Text posts, newest match first.
    HttpApiEndpoint.get("searchPosts", "/search/posts", {
      query: SearchQuery,
      success: PostSearchPage,
      error: InvalidSearchRequest,
    }).middleware(Authentication),
  )
  .add(
    // Comments and replies, newest match first.
    HttpApiEndpoint.get("searchComments", "/search/comments", {
      query: SearchQuery,
      success: CommentSearchPage,
      error: InvalidSearchRequest,
    }).middleware(Authentication),
  )
  .add(
    // Messages in chats the current user participates in (access-scoped by a
    // join on their participant rows), newest match first.
    HttpApiEndpoint.get("searchMessages", "/search/messages", {
      query: SearchQuery,
      success: MessageSearchPage,
      error: InvalidSearchRequest,
    }).middleware(Authentication),
  );

const ChatsGroup = HttpApiGroup.make("chats")
  .add(
    // All chats the current user participates in, newest-activity-first,
    // each carrying its own unread count and last-message preview so the
    // chat list never needs a request per row. Cursor-paginated (see
    // `ChatsPageQuery`) rather than returning the full set.
    HttpApiEndpoint.get("listChats", "/chats", {
      query: ChatsPageQuery,
      success: ChatsPage,
      error: InvalidChatRequest,
    }).middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.get("getChat", "/chats/:id", {
      params: ChatIdPath,
      success: Chat,
      error: [NotFound, Forbidden],
    }).middleware(Authentication),
  )
  .add(
    // Idempotent: returns the existing direct chat with this user if one
    // already exists rather than creating a duplicate.
    HttpApiEndpoint.post("createDirectChat", "/chats/direct", {
      payload: CreateDirectChatBody,
      success: Chat,
      error: [NotFound, InvalidChatRequest],
    }).middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.post("createGroupChat", "/chats/group", {
      payload: CreateGroupChatBody,
      success: Chat.pipe(HttpApiSchema.status(201)),
      error: [NotFound, InvalidChatRequest],
    }).middleware(Authentication),
  )
  .add(
    // Renames a group chat — the owner or an admin (per-chat role, issue
    // #220; formerly creator-only).
    HttpApiEndpoint.put("updateChat", "/chats/:id", {
      params: ChatIdPath,
      payload: UpdateChatBody,
      success: Chat,
      error: [NotFound, Forbidden, InvalidChatRequest],
    }).middleware(Authentication),
  )
  .add(
    // Uploads and stores a square-cropped group avatar (mirrors
    // `POST /users/me/avatar`) — the owner or an admin. Overwrites any
    // existing group avatar; the old variants are swept from object storage
    // once the row is repointed (see ChatsHandler.ts).
    HttpApiEndpoint.post("uploadChatAvatar", "/chats/:id/avatar", {
      params: ChatIdPath,
      payload: UploadAvatarBody,
      success: Chat,
      error: [
        NotFound,
        Forbidden,
        InvalidChatRequest,
        InvalidAvatarUpload,
        AvatarTooLarge,
        TooManyRequests,
      ],
    }).middleware(Authentication),
  )
  .add(
    // Clears a group chat's avatar back to unset (initials fallback) — the
    // owner or an admin. Counterpart to `uploadChatAvatar`; a no-op (still
    // succeeds) if the chat has no uploaded avatar.
    HttpApiEndpoint.delete("deleteChatAvatar", "/chats/:id/avatar", {
      params: ChatIdPath,
      success: Chat,
      error: [NotFound, Forbidden, InvalidChatRequest],
    }).middleware(Authentication),
  )
  .add(
    // Adds participants to a group chat — the owner or an admin.
    HttpApiEndpoint.post("addParticipants", "/chats/:id/participants", {
      params: ChatIdPath,
      payload: AddParticipantsBody,
      success: Chat,
      error: [NotFound, Forbidden, InvalidChatRequest],
    }).middleware(Authentication),
  )
  .add(
    // Removes a participant from a group chat — the owner or an admin.
    // Counterpart to `addParticipants`. If this empties the chat, it's
    // deleted entirely (see `deleteChat`'s cascade). If the removed
    // participant was the chat's owner, ownership is transferred
    // automatically to the longest-standing remaining participant so the
    // group doesn't become unmanageable (mirrors `leaveChat`).
    HttpApiEndpoint.delete(
      "removeParticipant",
      "/chats/:id/participants/:userId",
      {
        params: ChatParticipantPath,
        success: Chat,
        error: [NotFound, Forbidden, InvalidChatRequest],
      },
    ).middleware(Authentication),
  )
  .add(
    // A participant removes themselves from a group chat. If this empties
    // the chat, it's deleted entirely. If the leaver was the creator,
    // ownership transfers automatically to the longest-standing remaining
    // participant — see `removeParticipant`.
    HttpApiEndpoint.post("leaveChat", "/chats/:id/leave", {
      params: ChatIdPath,
      success: HttpApiSchema.NoContent,
      error: [NotFound, Forbidden, InvalidChatRequest],
    }).middleware(Authentication),
  )
  .add(
    // Deletes a group chat outright — the owner or an admin. The
    // `chats` row's cascading foreign keys (see db/schema.ts) take care of
    // its participants, messages, and read receipts.
    HttpApiEndpoint.delete("deleteChat", "/chats/:id", {
      params: ChatIdPath,
      success: HttpApiSchema.NoContent,
      error: [NotFound, Forbidden, InvalidChatRequest],
    }).middleware(Authentication),
  )
  .add(
    // Reassigns a group chat's `createdBy` to another current participant —
    // the creator or an admin, normally. If the chat has no creator (e.g.
    // the previous creator's account was deleted, see `Chat.createdBy`),
    // any current participant may call this to appoint a new owner, so the
    // group doesn't stay permanently unmanageable.
    HttpApiEndpoint.post("transferOwnership", "/chats/:id/owner", {
      params: ChatIdPath,
      payload: TransferOwnershipBody,
      success: Chat,
      error: [NotFound, Forbidden, InvalidChatRequest],
    }).middleware(Authentication),
  )
  .add(
    // Promotes/demotes a participant between "admin" and "member" — the
    // owner only (an admin can't create or demote other admins). The owner's
    // own role can't be changed here; use `transferOwnership` instead
    // (issue #220).
    HttpApiEndpoint.patch(
      "updateParticipantRole",
      "/chats/:id/participants/:userId/role",
      {
        params: ChatParticipantPath,
        payload: UpdateParticipantRoleBody,
        success: Chat,
        error: [NotFound, Forbidden, InvalidChatRequest],
      },
    ).middleware(Authentication),
  )
  .add(
    // Oldest-first page of a chat's messages — any participant may read.
    HttpApiEndpoint.get("listMessages", "/chats/:id/messages", {
      params: ChatIdPath,
      query: MessagesPageQuery,
      success: MessagesPage,
      error: [NotFound, Forbidden, InvalidChatRequest],
    }).middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.post("createMessage", "/chats/:id/messages", {
      params: ChatIdPath,
      payload: CreateMessageBody,
      success: Message.pipe(HttpApiSchema.status(201)),
      error: [NotFound, Forbidden],
    }).middleware(Authentication),
  )
  .add(
    // Fire-and-forget: pushes a `typing` realtime event (see Realtime.ts) to
    // every other participant of the chat. No request body and no
    // meaningful response — the server tracks no "is typing" state at all,
    // each call is just a transient nudge, and the client-side indicator
    // times itself out (see web/src/lib/typing.ts) rather than waiting for a
    // corresponding "stopped typing" signal.
    HttpApiEndpoint.post("sendTyping", "/chats/:id/typing", {
      params: ChatIdPath,
      success: HttpApiSchema.NoContent,
      error: [NotFound, Forbidden],
    }).middleware(Authentication),
  )
  .add(
    // Marks every unread message up to and including `messageId` as read by
    // the current user; returns the chat with its recalculated unread count.
    HttpApiEndpoint.post("markRead", "/chats/:id/read", {
      params: ChatIdPath,
      payload: MarkReadBody,
      success: Chat,
      error: [NotFound, Forbidden],
    }).middleware(Authentication),
  )
  .add(
    // Edits a message's content — the sender only (or an admin).
    HttpApiEndpoint.put("updateMessage", "/chats/:id/messages/:messageId", {
      params: MessageIdPath,
      payload: UpdateMessageBody,
      success: Message,
      error: [NotFound, Forbidden],
    }).middleware(Authentication),
  )
  .add(
    // Deletes a message — the sender, the chat's owner/admin, or a
    // site-wide admin (issue #220 extended this from sender-only). The
    // `message_reads` rows cascade via the FK, so nothing else to clean up.
    HttpApiEndpoint.delete("deleteMessage", "/chats/:id/messages/:messageId", {
      params: MessageIdPath,
      success: HttpApiSchema.NoContent,
      error: [NotFound, Forbidden],
    }).middleware(Authentication),
  )
  .add(
    // Idempotent add-reaction on a chat message (issue #216) — reacting with
    // an emoji already reacted with is a no-op, returning the current state.
    // Any participant may react, not just the sender (mirrors `addPostReaction`
    // /`addCommentReaction`). Emits a `reaction_changed` event to every
    // participant of the message's chat.
    HttpApiEndpoint.post(
      "addMessageReaction",
      "/chats/:id/messages/:messageId/reactions",
      {
        params: MessageIdPath,
        payload: ReactionBody,
        success: ReactionState,
        error: [NotFound, Forbidden],
      },
    ).middleware(Authentication),
  )
  .add(
    // Removes one specific emoji reaction from a message — a user may have
    // reacted with more than one emoji, so this only clears the one named in
    // the payload.
    HttpApiEndpoint.delete(
      "removeMessageReaction",
      "/chats/:id/messages/:messageId/reactions",
      {
        params: MessageIdPath,
        payload: ReactionBody,
        success: ReactionState,
        error: [NotFound, Forbidden],
      },
    ).middleware(Authentication),
  )
  .add(
    // The chat's currently-pinned messages (issue #223), newest pin first —
    // any participant may read. Returns full `Message`s (each with `pinned`
    // true), so the pinned panel renders exactly like the main thread.
    HttpApiEndpoint.get("listPinnedMessages", "/chats/:id/pins", {
      params: ChatIdPath,
      success: Schema.Array(Message),
      error: [NotFound, Forbidden],
    }).middleware(Authentication),
  )
  .add(
    // Pins a message chat-wide (issue #223) — idempotent (re-pinning an
    // already-pinned message is a no-op returning the current state). Any
    // participant may pin, mirroring reactions. Emits a `message_pin_changed`
    // realtime event to every participant. Returns the affected message.
    HttpApiEndpoint.post("pinMessage", "/chats/:id/pins", {
      params: ChatIdPath,
      payload: PinMessageBody,
      success: Message,
      error: [NotFound, Forbidden],
    }).middleware(Authentication),
  )
  .add(
    // Unpins a message (issue #223) — idempotent, and open to any participant
    // like pinning. Emits a `message_pin_changed` event. Returns the affected
    // message (now with `pinned` false).
    HttpApiEndpoint.delete("unpinMessage", "/chats/:id/pins/:messageId", {
      params: MessageIdPath,
      success: Message,
      error: [NotFound, Forbidden],
    }).middleware(Authentication),
  )
  .add(
    // The current user's own starred messages in this chat (issue #223),
    // newest star first — private, so this only ever returns the caller's
    // bookmarks, never anyone else's.
    HttpApiEndpoint.get("listStarredMessages", "/chats/:id/stars", {
      params: ChatIdPath,
      success: Schema.Array(Message),
      error: [NotFound, Forbidden],
    }).middleware(Authentication),
  )
  .add(
    // Stars a message as a private bookmark (issue #223) — idempotent, never
    // broadcast (a star is visible only to the user who created it), so no
    // realtime event. Returns the affected message (with `starred` true).
    HttpApiEndpoint.post("starMessage", "/chats/:id/messages/:messageId/star", {
      params: MessageIdPath,
      success: Message,
      error: [NotFound, Forbidden],
    }).middleware(Authentication),
  )
  .add(
    // Removes a private star (issue #223) — idempotent, no realtime event.
    // Returns the affected message (with `starred` false).
    HttpApiEndpoint.delete(
      "unstarMessage",
      "/chats/:id/messages/:messageId/star",
      {
        params: MessageIdPath,
        success: Message,
        error: [NotFound, Forbidden],
      },
    ).middleware(Authentication),
  )
  .add(
    // Mints an invite code for a group chat — the owner or an admin
    // (issue #220). Joining via the code (`joinChatViaInvite`) is open to
    // any authenticated user, so this is the access-control gate: only
    // whoever holds a still-valid code (or link built from it) can join.
    HttpApiEndpoint.post("createChatInvite", "/chats/:id/invites", {
      params: ChatIdPath,
      payload: CreateChatInviteBody,
      success: ChatInvite.pipe(HttpApiSchema.status(201)),
      error: [NotFound, Forbidden, InvalidChatRequest],
    }).middleware(Authentication),
  )
  .add(
    // Lists every invite (active, expired, and revoked) ever created for a
    // group chat — the owner or an admin.
    HttpApiEndpoint.get("listChatInvites", "/chats/:id/invites", {
      params: ChatIdPath,
      success: Schema.Array(ChatInvite),
      error: [NotFound, Forbidden],
    }).middleware(Authentication),
  )
  .add(
    // Revokes an invite so its code can no longer be redeemed — the owner
    // or an admin.
    HttpApiEndpoint.delete("revokeChatInvite", "/chats/:id/invites/:inviteId", {
      params: ChatInvitePath,
      success: HttpApiSchema.NoContent,
      error: [NotFound, Forbidden],
    }).middleware(Authentication),
  )
  .add(
    // Redeems an invite code, adding the current user to its chat as a
    // "member" — any authenticated user (not just existing participants).
    // Idempotent for someone already in the chat: returns the chat as-is
    // rather than erroring.
    HttpApiEndpoint.post("joinChatViaInvite", "/chats/invites/:code/join", {
      params: InviteCodePath,
      success: Chat,
      error: [NotFound, InvalidChatRequest],
    }).middleware(Authentication),
  );

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

const AttachmentsGroup = HttpApiGroup.make("attachments")
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

export const VersionResponse = Schema.Struct({
  version: Schema.String,
}).annotate({ identifier: "VersionResponse" });
export type VersionResponse = typeof VersionResponse.Type;

const MetaGroup = HttpApiGroup.make("meta").add(
  // Unauthenticated on purpose — the frontend displays this in its footer
  // before (and regardless of) login.
  HttpApiEndpoint.get("getVersion", "/version", {
    success: VersionResponse,
  }),
);

export const WsTicketResponse = Schema.Struct({
  ticket: Schema.String,
}).annotate({ identifier: "WsTicketResponse" });
export type WsTicketResponse = typeof WsTicketResponse.Type;

const RealtimeGroup = HttpApiGroup.make("realtime").add(
  // Mints a short-lived, single-use ticket (see WsTicket.ts) for the raw
  // `/ws` route to redeem on upgrade — the browser `WebSocket` handshake
  // can't carry the normal `Authorization: Bearer` header, so this lets it
  // authenticate without putting the long-lived access token itself in a URL
  // (see issue #26).
  HttpApiEndpoint.post("createWsTicket", "/realtime/ws-ticket", {
    success: WsTicketResponse.pipe(HttpApiSchema.status(201)),
  }).middleware(Authentication),
);

// ---------------------------------------------------------------------------
// Admin dashboard — aggregated, admin-only operational statistics
//
// A single read-only endpoint backing the operator dashboard at `/admin` in
// the frontend. Everything it returns is an *aggregate* — a count, a sum, a
// latency, a per-day bucket. It deliberately exposes no per-user breakdown
// (no "most active users" panel, no per-user activity series), matching the
// same GDPR-driven scoping constraint the `active_users` gauge and the rest
// of the domain metrics in Metrics.ts already follow: an admin can already
// browse the user directory, but nothing here turns individual behaviour
// into a ranked, at-a-glance surface.
// ---------------------------------------------------------------------------

// Lifetime row counts — the "how big is this deployment" half of the
// dashboard, as opposed to `AdminActivityWindow` below (which is windowed).
export const AdminTotals = Schema.Struct({
  users: Schema.Finite,
  admins: Schema.Finite,
  posts: Schema.Finite,
  comments: Schema.Finite,
  chats: Schema.Finite,
  messages: Schema.Finite,
  reactions: Schema.Finite,
  attachments: Schema.Finite,
  // Summed `attachments.size`, i.e. bytes held in the object store for
  // attachments still referenced by a row (see AttachmentCleanup.ts).
  attachmentBytes: Schema.Finite,
}).annotate({ identifier: "AdminTotals" });
export type AdminTotals = typeof AdminTotals.Type;

export const AdminActivityWindowLabel = Schema.Literals([
  "1d",
  "7d",
  "30d",
]).annotate({ identifier: "AdminActivityWindowLabel" });
export type AdminActivityWindowLabel = typeof AdminActivityWindowLabel.Type;

// One trailing window's worth of activity. `activeUsers` is the same
// definition the `active_users{window}` gauge uses (see
// ActiveUsersMetrics.ts): distinct users who created a post, comment,
// reaction, or message inside the window — computed fresh per request here
// rather than read off the gauge, which only refreshes hourly.
export const AdminActivityWindow = Schema.Struct({
  window: AdminActivityWindowLabel,
  activeUsers: Schema.Finite,
  newUsers: Schema.Finite,
  newPosts: Schema.Finite,
  newComments: Schema.Finite,
  newMessages: Schema.Finite,
  newReactions: Schema.Finite,
}).annotate({ identifier: "AdminActivityWindow" });
export type AdminActivityWindow = typeof AdminActivityWindow.Type;

// One UTC day of the trailing timeline, for the dashboard's bar chart. Days
// with no activity are still present (zero-filled server-side) so the chart
// can render a continuous axis without reconstructing the calendar itself.
export const AdminTimelinePoint = Schema.Struct({
  // `YYYY-MM-DD`, UTC — the day boundary matches `date_trunc('day', ...)`
  // over the naive-UTC `created_at` columns (see db/schema.ts).
  date: Schema.String,
  signups: Schema.Finite,
  posts: Schema.Finite,
  comments: Schema.Finite,
  messages: Schema.Finite,
}).annotate({ identifier: "AdminTimelinePoint" });
export type AdminTimelinePoint = typeof AdminTimelinePoint.Type;

// A dependency `/ready` (see Health.ts) also checks, but reported with its
// measured round-trip and which implementation is actually wired up, so the
// dashboard can distinguish "healthy single-process dev box" from "healthy
// Postgres + Redis deployment" without a second endpoint.
export const AdminDependencyHealth = Schema.Struct({
  name: Schema.Literals(["database", "pubsub"]),
  reachable: Schema.Boolean,
  // Null when the check failed — there's no meaningful latency for a probe
  // that never came back.
  latencyMs: Schema.NullOr(Schema.Finite),
  // "pglite"/"postgres" for the database, "memory"/"redis" for pubsub.
  backend: Schema.String,
}).annotate({ identifier: "AdminDependencyHealth" });
export type AdminDependencyHealth = typeof AdminDependencyHealth.Type;

// Process-local runtime counters, read straight off the same `effect/Metric`
// registry `/metrics` renders (see Metrics.ts). Emphatically *this
// instance's* numbers since process start — with more than one replica the
// dashboard shows whichever one served the request, which is why the
// deployment-wide view still belongs in Prometheus/Grafana. Surfaced anyway
// because the single-instance case is the common one and it answers
// "is anything on fire right now?" without leaving the app.
export const AdminRuntimeHealth = Schema.Struct({
  // "ok" unless a dependency probe failed — the dashboard's headline badge.
  status: Schema.Literals(["ok", "degraded"]),
  version: Schema.String,
  uptimeSeconds: Schema.Finite,
  dependencies: Schema.Array(AdminDependencyHealth),
  websocketConnections: Schema.Finite,
  requestsTotal: Schema.Finite,
  // Requests answered with a 5xx, and the share of `requestsTotal` they
  // make up (0..1). Precomputed server-side so every client renders the
  // same number rather than each dividing it differently.
  serverErrorsTotal: Schema.Finite,
  errorRate: Schema.Finite,
  rateLimitRejectionsTotal: Schema.Finite,
  dbQueryErrorsTotal: Schema.Finite,
}).annotate({ identifier: "AdminRuntimeHealth" });
export type AdminRuntimeHealth = typeof AdminRuntimeHealth.Type;

export const AdminStats = Schema.Struct({
  // Epoch ms the snapshot was taken — nothing here is cached, but the
  // dashboard refetches on an interval and shows how fresh what's on screen
  // is.
  generatedAt: Schema.Finite,
  totals: AdminTotals,
  activity: Schema.Array(AdminActivityWindow),
  timeline: Schema.Array(AdminTimelinePoint),
  health: AdminRuntimeHealth,
}).annotate({ identifier: "AdminStats" });
export type AdminStats = typeof AdminStats.Type;

export const DEFAULT_ADMIN_TIMELINE_DAYS = 14;
// Bounds the timeline's per-day grouping (and the JSON it produces) — a
// quarter of history is more than an at-a-glance dashboard needs, and
// anything longer belongs in the Prometheus-backed dashboards instead.
export const MAX_ADMIN_TIMELINE_DAYS = 90;

// Left un-`identifier`-annotated for the same reason as `PostsPageQuery`
// above (see CLAUDE.md): it's inlined into query parameters, and a named
// `$ref` would silently drop them from the generated spec.
export const AdminStatsQuery = Schema.Struct({
  days: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_ADMIN_TIMELINE_DAYS }),
    ),
  ),
});

const AdminGroup = HttpApiGroup.make("admin").add(
  // Admin-only: a non-admin caller gets a 403 rather than a filtered-down
  // payload, since every field here is deployment-wide operational data.
  HttpApiEndpoint.get("getAdminStats", "/admin/stats", {
    query: AdminStatsQuery,
    success: AdminStats,
    error: Forbidden,
  }).middleware(Authentication),
);

// --- Games (see GamesHandler.ts) -------------------------------------------
//
// The games feature is built to hold more than one game: lobbies, seats,
// realtime rooms, results, and the leaderboard are all keyed by a game slug,
// and only the rules of play (for the typing race: the passage bank and how
// a finish is scored — see src/games/typing.ts) are game-specific. Adding a
// game means adding its slug here plus its rules module; the lobby plumbing
// and the frontend's game-shell components (web/src/components/games) are
// shared.
//  - "typing":  Type Race — everyone races to type the same passage.
//  - "drawing": Sketchy — a Drawful-style party game: everyone draws a
//               secret prompt, bluffs fake titles for each other's drawings,
//               and votes for the real one (see src/games/drawing/).
//  - "reflex":  Reflex Rush — rounds of reaction tests (wait for green, dodge
//               the decoys, match the symbol, the arrow, the target), solo
//               or head to head (see src/games/reflex.ts).
export const GameId = Schema.Literals(["typing", "drawing", "reflex"]).annotate(
  {
    identifier: "GameId",
  },
);
export type GameId = typeof GameId.Type;

// Seats per typing lobby. Small on purpose: every racer's lane is on screen
// at once, and every progress frame fans out to the whole room. Each game
// sets its own bounds (see `GameRules` in src/games/rules.ts); a lobby
// reports them as `minPlayers`/`maxPlayers`.
export const MAX_GAME_LOBBY_PLAYERS = 6;

// The phase a lobby is in *right now*, derived at read time from what the
// host did and the clock (see `lobbyPhase` in GamesHandler.ts):
//  - "waiting":   gathering players; the host can start.
//  - "countdown": started, `startsAt` still in the future — the passage is
//                 revealed so racers can read ahead, but typing is locked.
//  - "racing":    between `startsAt` and `endsAt`, and someone hasn't
//                 finished yet.
//  - "finished":  everyone finished or `endsAt` passed; the host can rematch.
export const GameLobbyPhase = Schema.Literals([
  "waiting",
  "countdown",
  "racing",
  "finished",
]).annotate({ identifier: "GameLobbyPhase" });
export type GameLobbyPhase = typeof GameLobbyPhase.Type;

export const GameLobbyPlayer = Schema.Struct({
  user: User,
  joinedAt: Schema.Finite,
  // The four result fields are null until this player finishes the current
  // round. `score` is the game's headline number — words per minute for the
  // typing race, points for Sketchy (where `accuracy` is the share of this
  // player's votes that found the real title, and `durationMs` the length of
  // the whole game).
  durationMs: Schema.NullOr(Schema.Finite),
  score: Schema.NullOr(Schema.Finite),
  accuracy: Schema.NullOr(Schema.Finite),
  place: Schema.NullOr(Schema.Finite),
}).annotate({ identifier: "GameLobbyPlayer" });
export type GameLobbyPlayer = typeof GameLobbyPlayer.Type;

// --- Sketchy (the "drawing" game — see src/games/drawing/) -----------------
//
// Drawings are submitted as vector strokes on a fixed virtual canvas rather
// than as images: a few kilobytes of JSON, validated server-side, rendered
// (and replayed stroke by stroke) by the client at any size.
export const DRAWING_WIDTH = 800;
export const DRAWING_HEIGHT = 600;
// Colors are indexes into the client's fixed palette (`DRAWING_PALETTE` in
// web/src/lib/games/drawing.ts, which must stay this long) — the server only
// needs to know they're in range.
export const DRAWING_PALETTE_SIZE = 10;
// Hard caps on one drawing. A real 75-second sketch, with the client's point
// thinning, lands far below both.
export const MAX_DRAWING_STROKES = 400;
export const MAX_DRAWING_POINTS = 6000;
export const MAX_BLUFF_LENGTH = 60;
export const MIN_DRAWING_ROUNDS = 1;
export const MAX_DRAWING_ROUNDS = 3;

export const DrawingBrush = Schema.Literals(["thin", "thick"]).annotate({
  identifier: "DrawingBrush",
});

// One pen-down-to-pen-up line. `points` is flat — [x0, y0, x1, y1, …] — in
// whole canvas units; the pairing (even length, y within DRAWING_HEIGHT) and
// the drawing-wide point budget are checked by the handler, since a schema
// can only bound each number on its own.
export const DrawingStroke = Schema.Struct({
  color: Schema.Finite.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 0, maximum: DRAWING_PALETTE_SIZE - 1 }),
  ),
  brush: DrawingBrush,
  points: Schema.Array(
    Schema.Finite.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 0, maximum: DRAWING_WIDTH }),
    ),
  ).check(Schema.isMinLength(2), Schema.isMaxLength(MAX_DRAWING_POINTS * 2)),
}).annotate({ identifier: "DrawingStroke" });
export type DrawingStroke = typeof DrawingStroke.Type;

export const DrawingStrokes = Schema.Array(DrawingStroke).check(
  Schema.isMaxLength(MAX_DRAWING_STROKES),
);

// A theme pack, as the pack picker shows it. Deliberately *not* the prompt
// list — with it, a voter could look the real title up (see
// src/games/drawing/packs/).
export const DrawingPack = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  // A single emoji.
  icon: Schema.String,
  description: Schema.String,
  samples: Schema.Array(Schema.String),
  promptCount: Schema.Finite,
}).annotate({ identifier: "DrawingPack" });
export type DrawingPack = typeof DrawingPack.Type;

export const DrawingPackList = Schema.Struct({
  packs: Schema.Array(DrawingPack),
}).annotate({ identifier: "DrawingPackList" });

// Where a Sketchy game is inside the "racing" phase. Each round opens with a
// "draw" stage (everyone at once), then every drawing of that round takes a
// "bluff" → "vote" → "reveal" turn in the spotlight. Derived from the clock
// and the submissions at read time, exactly like `GameLobbyPhase`.
export const DrawingStageKind = Schema.Literals([
  "draw",
  "bluff",
  "vote",
  "reveal",
]).annotate({ identifier: "DrawingStageKind" });
export type DrawingStageKind = typeof DrawingStageKind.Type;

export const DrawingStage = Schema.Struct({
  kind: DrawingStageKind,
  // 1-based round within this game (see `rounds`).
  turn: Schema.Finite,
  // The drawing in the spotlight; null during "draw".
  drawingId: Schema.NullOr(Schema.Finite),
  // Epoch ms. `endsAt` can move *earlier* (everyone submitted) but never
  // later.
  startedAt: Schema.Finite,
  endsAt: Schema.Finite,
}).annotate({ identifier: "DrawingStage" });
export type DrawingStage = typeof DrawingStage.Type;

// One title on the vote ballot. Until the drawing's reveal, only `id`,
// `text` and `mine` are filled in — nothing in a pre-reveal answer tells the
// real title from a bluff.
export const DrawingAnswer = Schema.Struct({
  // Ballot position — what a vote submits.
  id: Schema.Finite,
  text: Schema.String,
  // The viewer can't vote for this one: it's their own bluff (or, for the
  // artist, their own prompt).
  mine: Schema.Boolean,
  real: Schema.NullOr(Schema.Boolean),
  // Who wrote this bluff; null for the real title.
  authorId: Schema.NullOr(Schema.Finite),
  voterIds: Schema.NullOr(Schema.Array(Schema.Finite)),
  // What this answer earned its author (the artist, for the real one).
  points: Schema.NullOr(Schema.Finite),
  // Epoch ms at which the live reveal turns this answer over — every client
  // plays the same sequence off the server's clock, the truth landing last.
  // Null for a bluff nobody picked (it isn't given a beat), and once the
  // game is over.
  revealAt: Schema.NullOr(Schema.Finite),
}).annotate({ identifier: "DrawingAnswer" });
export type DrawingAnswer = typeof DrawingAnswer.Type;

// One player's drawing, filtered for the viewer: strokes appear once the
// drawing reaches its bluff stage (the artist always sees their own), the
// prompt only at its reveal (the artist always knows theirs), the ballot
// from its vote stage on.
export const DrawingEntry = Schema.Struct({
  id: Schema.Finite,
  turn: Schema.Finite,
  // Order within the round's bluff/vote/reveal turns.
  position: Schema.Finite,
  artistId: Schema.Finite,
  submitted: Schema.Boolean,
  strokes: Schema.NullOr(DrawingStrokes),
  prompt: Schema.NullOr(Schema.String),
  revealed: Schema.Boolean,
  // How many bluffs/votes are in — the "3 of 5" progress, never who or what.
  bluffCount: Schema.Finite,
  voteCount: Schema.Finite,
  myBluff: Schema.NullOr(Schema.String),
  myVote: Schema.NullOr(Schema.Finite),
  answers: Schema.NullOr(Schema.Array(DrawingAnswer)),
}).annotate({ identifier: "DrawingEntry" });
export type DrawingEntry = typeof DrawingEntry.Type;

export const DrawingScore = Schema.Struct({
  userId: Schema.Finite,
  score: Schema.Finite,
}).annotate({ identifier: "DrawingScore" });

export const DrawingGame = Schema.Struct({
  // The host's picks (see `updateDrawingSettings`).
  packs: Schema.Array(Schema.String),
  rounds: Schema.Finite,
  // Null while waiting, counting down, or finished.
  stage: Schema.NullOr(DrawingStage),
  // The viewer's own secret prompt for the current round's draw stage.
  myPrompt: Schema.NullOr(Schema.String),
  // Everyone dealt into this game — fixed at the start, so a player who
  // leaves mid-game still has their drawing played out.
  participantIds: Schema.Array(Schema.Finite),
  drawings: Schema.Array(DrawingEntry),
  // Running totals over every drawing revealed so far, highest first.
  scores: Schema.Array(DrawingScore),
}).annotate({ identifier: "DrawingGame" });
export type DrawingGame = typeof DrawingGame.Type;

// --- Reflex Rush (the "reflex" game — see src/games/reflex.ts) -------------
//
// A game is a fixed schedule of rounds, laid out server-side from a secret
// seed when the host starts it. Every client plays the same schedule off
// the (server-corrected) clock, so everyone in a lobby gets each signal at
// the same instant.
export const ReflexKind = Schema.Literals(REFLEX_KINDS).annotate({
  identifier: "ReflexKind",
});
export type ReflexKind = typeof ReflexKind.Type;

export const ReflexDirection = Schema.Literals(REFLEX_DIRECTIONS).annotate({
  identifier: "ReflexDirection",
});

// Something shown before a round's signal: a decoy flash ("decoy", whose
// `variant` picks its look) or a wrong symbol ("match", whose `variant` is
// the symbol).
export const ReflexCue = Schema.Struct({
  at: Schema.Finite,
  variant: Schema.Finite,
}).annotate({ identifier: "ReflexCue" });

// One round. All times are epoch ms: the title card shows from `armAt`,
// presses count as false starts from `armAt + introMs` until `signalAt`,
// and the round is decided at `closeAt`.
export const ReflexRound = Schema.Struct({
  kind: ReflexKind,
  armAt: Schema.Finite,
  signalAt: Schema.Finite,
  closeAt: Schema.Finite,
  cues: Schema.Array(ReflexCue),
  // "match" only: the symbol to hit on.
  symbol: Schema.NullOr(Schema.Finite),
  // "arrow" only: the direction to press.
  direction: Schema.NullOr(ReflexDirection),
  // "target" only: its center, as fractions of the arena's width/height.
  target: Schema.NullOr(Schema.Struct({ x: Schema.Finite, y: Schema.Finite })),
}).annotate({ identifier: "ReflexRound" });
export type ReflexRound = typeof ReflexRound.Type;

//  - "hit":   reacted in time (and, for an arrow or a target, correctly).
//  - "early": a false start — pressed before the signal (a decoy, a wrong
//             symbol), or within ANTICIPATION_MS of it.
//  - "miss":  never reacted within the window.
//  - "wrong": reacted in time, but with the wrong arrow or off the target.
export const ReflexOutcome = Schema.Literals([
  "hit",
  "early",
  "miss",
  "wrong",
]).annotate({ identifier: "ReflexOutcome" });

export const ReflexRoundResult = Schema.Struct({
  outcome: ReflexOutcome,
  reactionMs: Schema.NullOr(Schema.Finite),
  // Negative for a false start.
  points: Schema.Finite,
}).annotate({ identifier: "ReflexRoundResult" });
export type ReflexRoundResult = typeof ReflexRoundResult.Type;

export const ReflexPlayerResult = Schema.Struct({
  userId: Schema.Finite,
  rounds: Schema.Array(ReflexRoundResult),
}).annotate({ identifier: "ReflexPlayerResult" });

export const ReflexGame = Schema.Struct({
  // The title card's length before each round is armed.
  introMs: Schema.Finite,
  // Empty while waiting (the schedule is secret until the start).
  rounds: Schema.Array(ReflexRound),
  // The server-scored breakdown of everyone who has submitted their game.
  results: Schema.Array(ReflexPlayerResult),
}).annotate({ identifier: "ReflexGame" });
export type ReflexGame = typeof ReflexGame.Type;

export const GameLobby = Schema.Struct({
  id: Schema.Finite,
  game: GameId,
  hostId: Schema.Finite,
  phase: GameLobbyPhase,
  round: Schema.Finite,
  // Null while "waiting" — the text is only revealed once a race starts, so
  // nobody can rehearse it while the lobby fills. Always null in the lobby
  // browser listing.
  passage: Schema.NullOr(Schema.String),
  // Epoch ms; null while "waiting".
  startsAt: Schema.NullOr(Schema.Finite),
  endsAt: Schema.NullOr(Schema.Finite),
  // The server's clock when this response was built, so a client can correct
  // for its own clock skew when it renders the countdown and race timer.
  serverNow: Schema.Finite,
  // The host can't start with fewer seated players than this.
  minPlayers: Schema.Finite,
  maxPlayers: Schema.Finite,
  // Seated players, in join order.
  players: Schema.Array(GameLobbyPlayer),
  // Sketchy's state, filtered for the caller (see DrawingGame); null for
  // every other game. The lobby browser only ever gets the settings.
  drawing: Schema.NullOr(DrawingGame),
  // Reflex Rush's schedule and results (see ReflexGame); null for every
  // other game, and in the lobby browser.
  reflex: Schema.NullOr(ReflexGame),
  // Whether the lobby chat takes messages right now. Always open for the
  // typing race; closed while a Sketchy game is in play, since a chat line
  // is the easiest way to leak a secret prompt (reactions stay on).
  chatOpen: Schema.Boolean,
  createdAt: Schema.Finite,
}).annotate({ identifier: "GameLobby" });
export type GameLobby = typeof GameLobby.Type;

export const GameLobbyList = Schema.Struct({
  lobbies: Schema.Array(GameLobby),
}).annotate({ identifier: "GameLobbyList" });

// --- Lobby chat -------------------------------------------------------------
//
// A lobby's own little chat room — players and spectators alike. Lives and
// dies with the lobby (see `gameLobbyMessages` in db/schema.ts), and arrives
// live as an id-less `game_chat` event on the lobby's realtime room.
export const MAX_GAME_CHAT_LENGTH = 280;
// The chat shows (at most) this many of a lobby's newest messages.
export const GAME_CHAT_PAGE_SIZE = 50;

export const GameChatMessage = Schema.Struct({
  id: Schema.Finite,
  lobbyId: Schema.Finite,
  user: User,
  text: Schema.String,
  createdAt: Schema.Finite,
}).annotate({ identifier: "GameChatMessage" });
export type GameChatMessage = typeof GameChatMessage.Type;

export const GameChat = Schema.Struct({
  // Oldest first, ending with the newest. Leaves out anyone the caller has
  // blocked or muted.
  messages: Schema.Array(GameChatMessage),
}).annotate({ identifier: "GameChat" });

export const GameChatBody = Schema.Struct({
  text: Schema.Trim.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_GAME_CHAT_LENGTH),
  ),
}).annotate({ identifier: "GameChatBody" });

// A finished race's submission. The server never takes a score from the
// client: it checks `typed` against the passage and times the finish off its
// own clock, and only `errors` (wrong keystrokes along the way, which it
// can't observe) is taken on trust — and it can only ever *lower* accuracy.
export const MAX_TYPED_LENGTH = 2000;
export const FinishRaceBody = Schema.Struct({
  typed: Schema.String.check(Schema.isMaxLength(MAX_TYPED_LENGTH)),
  errors: Schema.Finite.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 0, maximum: 100_000 }),
  ),
}).annotate({ identifier: "FinishRaceBody" });

// A played Reflex Rush game, one entry per round in order. What's measured
// on the client — the reaction time — is judged, not trusted: under
// ANTICIPATION_MS it's a false start, an arrow must match the round's, a
// hit must land on the target. `early` is taken on trust, since it can only
// cost points.
export const ReflexTap = Schema.Struct({
  early: Schema.Boolean,
  reactionMs: Schema.NullOr(
    Schema.Finite.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 0, maximum: 10_000 }),
    ),
  ),
  direction: Schema.NullOr(ReflexDirection),
  x: Schema.NullOr(
    Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  ),
  y: Schema.NullOr(
    Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  ),
}).annotate({ identifier: "ReflexTap" });

export const FinishReflexBody = Schema.Struct({
  taps: Schema.Array(ReflexTap).check(Schema.isMaxLength(REFLEX_ROUNDS)),
}).annotate({ identifier: "FinishReflexBody" });

export const LeaderboardPeriod = Schema.Literals([
  "day",
  "week",
  "all",
]).annotate({ identifier: "LeaderboardPeriod" });
export type LeaderboardPeriod = typeof LeaderboardPeriod.Type;

export const LeaderboardEntry = Schema.Struct({
  rank: Schema.Finite,
  user: User,
  bestScore: Schema.Finite,
  averageScore: Schema.Finite,
  averageAccuracy: Schema.Finite,
  races: Schema.Finite,
  // First places in races against at least one opponent.
  wins: Schema.Finite,
}).annotate({ identifier: "LeaderboardEntry" });
export type LeaderboardEntry = typeof LeaderboardEntry.Type;

export const Leaderboard = Schema.Struct({
  game: GameId,
  period: LeaderboardPeriod,
  entries: Schema.Array(LeaderboardEntry),
  // The caller's own standing, even when it falls outside `entries` — null
  // when they have no results in the period.
  me: Schema.NullOr(LeaderboardEntry),
}).annotate({ identifier: "Leaderboard" });
export type Leaderboard = typeof Leaderboard.Type;

export const LEADERBOARD_SIZE = 25;

export class InvalidGameRequest extends Schema.TaggedError<InvalidGameRequest>()(
  "InvalidGameRequest",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

// Anonymous (no `identifier`) for the reason in CLAUDE.md — a named path or
// query struct silently loses its parameters in the generated spec.
const GamePath = Schema.Struct({ game: GameId });
const GameLobbyIdPath = Schema.Struct({ id: Schema.Int });
export const LeaderboardQuery = Schema.Struct({
  period: Schema.optional(LeaderboardPeriod),
});

export const GameInviteBody = Schema.Struct({
  userId: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0)),
}).annotate({ identifier: "GameInviteBody" });

export const DrawingSettingsBody = Schema.Struct({
  // Pack slugs (see `listDrawingPacks`); unknown ones are rejected.
  packs: Schema.Array(Schema.String.check(Schema.isMaxLength(40))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(20),
  ),
  rounds: Schema.Finite.check(
    Schema.isInt(),
    Schema.isBetween({
      minimum: MIN_DRAWING_ROUNDS,
      maximum: MAX_DRAWING_ROUNDS,
    }),
  ),
}).annotate({ identifier: "DrawingSettingsBody" });

export const SubmitDrawingBody = Schema.Struct({
  strokes: DrawingStrokes,
}).annotate({ identifier: "SubmitDrawingBody" });

export const SubmitBluffBody = Schema.Struct({
  text: Schema.Trim.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_BLUFF_LENGTH),
  ),
}).annotate({ identifier: "SubmitBluffBody" });

export const SubmitVoteBody = Schema.Struct({
  // A `DrawingAnswer.id` from the current ballot.
  answer: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
}).annotate({ identifier: "SubmitVoteBody" });

const GamesGroup = HttpApiGroup.make("games")
  .add(
    // Lobbies worth showing in the lobby browser: every lobby still
    // gathering players or mid-race, newest first. Abandoned ones (nobody
    // touched them in a while) are left out.
    HttpApiEndpoint.get("listGameLobbies", "/games/:game/lobbies", {
      params: GamePath,
      success: GameLobbyList,
    }).middleware(Authentication),
  )
  .add(
    // Opens a new lobby with the caller as host and only player. Leaves any
    // other lobby the caller was seated in first.
    HttpApiEndpoint.post("createGameLobby", "/games/:game/lobbies", {
      params: GamePath,
      success: GameLobby.pipe(HttpApiSchema.status(201)),
    }).middleware(Authentication),
  )
  .add(
    // Seats the caller in the fullest open lobby that still has room, or
    // opens a new one if there isn't any — the one-click "just let me race".
    HttpApiEndpoint.post("quickPlay", "/games/:game/quick-play", {
      params: GamePath,
      success: GameLobby,
    }).middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.get("getGameLobby", "/games/lobbies/:id", {
      params: GameLobbyIdPath,
      success: GameLobby,
      error: NotFound,
    }).middleware(Authentication),
  )
  .add(
    // Idempotent for a player already seated. Only while "waiting" and not
    // full.
    HttpApiEndpoint.post("joinGameLobby", "/games/lobbies/:id/join", {
      params: GameLobbyIdPath,
      success: GameLobby,
      error: [NotFound, InvalidGameRequest],
    }).middleware(Authentication),
  )
  .add(
    // Allowed in any phase. The last player out closes the lobby; a leaving
    // host hands the lobby to whoever joined next.
    HttpApiEndpoint.post("leaveGameLobby", "/games/lobbies/:id/leave", {
      params: GameLobbyIdPath,
      success: HttpApiSchema.NoContent,
      error: NotFound,
    }).middleware(Authentication),
  )
  .add(
    // Host-only, from "waiting": picks the passage and schedules the race a
    // short countdown from now.
    HttpApiEndpoint.post("startGameLobby", "/games/lobbies/:id/start", {
      params: GameLobbyIdPath,
      success: GameLobby,
      error: [NotFound, Forbidden, InvalidGameRequest],
    }).middleware(Authentication),
  )
  .add(
    // Submits the caller's finished race — see FinishRaceBody for what is
    // (and isn't) trusted. Records the result for the leaderboard.
    HttpApiEndpoint.post("finishRace", "/games/lobbies/:id/finish", {
      params: GameLobbyIdPath,
      payload: FinishRaceBody,
      success: GameLobby,
      error: [NotFound, Forbidden, InvalidGameRequest],
    }).middleware(Authentication),
  )
  .add(
    // Reflex Rush: submits the caller's whole game once its last round has
    // closed — see FinishReflexBody for what is (and isn't) trusted. Places
    // and leaderboard results are settled once everyone is in (or time's
    // up).
    HttpApiEndpoint.post("finishReflex", "/games/lobbies/:id/reflex", {
      params: GameLobbyIdPath,
      payload: FinishReflexBody,
      success: GameLobby,
      error: [NotFound, Forbidden, InvalidGameRequest],
    }).middleware(Authentication),
  )
  .add(
    // Host-only, from "finished": resets the lobby to "waiting" for another
    // round with the same players.
    HttpApiEndpoint.post("rematchGameLobby", "/games/lobbies/:id/rematch", {
      params: GameLobbyIdPath,
      success: GameLobby,
      error: [NotFound, Forbidden, InvalidGameRequest],
    }).middleware(Authentication),
  )
  .add(
    // Seated-players-only: invites another user into the caller's lobby. The
    // invitee gets a `game_invite` notification linking to it — nothing is
    // reserved for them, so a lobby that fills up or starts in the meantime
    // is simply not joinable when they arrive. Only while "waiting".
    HttpApiEndpoint.post("inviteToGameLobby", "/games/lobbies/:id/invite", {
      params: GameLobbyIdPath,
      payload: GameInviteBody,
      success: HttpApiSchema.NoContent,
      error: [NotFound, Forbidden, InvalidGameRequest, TooManyRequests],
    }).middleware(Authentication),
  )
  .add(
    // The lobby chat's newest messages (see GameChat).
    HttpApiEndpoint.get("listGameChat", "/games/lobbies/:id/chat", {
      params: GameLobbyIdPath,
      success: GameChat,
      error: NotFound,
    }).middleware(Authentication),
  )
  .add(
    // Says something in the lobby chat — anyone looking at the lobby may,
    // seated or spectating, while `chatOpen`. Rate-limited per user.
    HttpApiEndpoint.post("postGameChat", "/games/lobbies/:id/chat", {
      params: GameLobbyIdPath,
      payload: GameChatBody,
      success: GameChatMessage.pipe(HttpApiSchema.status(201)),
      error: [NotFound, InvalidGameRequest, TooManyRequests],
    }).middleware(Authentication),
  )
  .add(
    // Sketchy's theme packs, for the host's pack picker — never the prompts
    // themselves (see DrawingPack).
    HttpApiEndpoint.get("listDrawingPacks", "/games/drawing/packs", {
      success: DrawingPackList,
    }).middleware(Authentication),
  )
  .add(
    // Host-only, while "waiting", Sketchy only: picks the theme packs and
    // round count. Everyone in the lobby sees the change live.
    HttpApiEndpoint.put(
      "updateDrawingSettings",
      "/games/lobbies/:id/settings",
      {
        params: GameLobbyIdPath,
        payload: DrawingSettingsBody,
        success: GameLobby,
        error: [NotFound, Forbidden, InvalidGameRequest],
      },
    ).middleware(Authentication),
  )
  .add(
    // Sketchy, "draw" stage: submits the caller's drawing for this round.
    // Once per drawing; a submission landing a moment after the timer is
    // still accepted, since the client sends whatever is on the canvas when
    // time runs out.
    HttpApiEndpoint.post("submitDrawing", "/games/lobbies/:id/drawing", {
      params: GameLobbyIdPath,
      payload: SubmitDrawingBody,
      success: GameLobby,
      error: [NotFound, Forbidden, InvalidGameRequest],
    }).middleware(Authentication),
  )
  .add(
    // Sketchy, "bluff" stage: a fake title for the drawing in the spotlight.
    // Not for its artist; rejected if it's too close to the real prompt or
    // repeats another player's bluff.
    HttpApiEndpoint.post("submitBluff", "/games/lobbies/:id/bluff", {
      params: GameLobbyIdPath,
      payload: SubmitBluffBody,
      success: GameLobby,
      error: [NotFound, Forbidden, InvalidGameRequest],
    }).middleware(Authentication),
  )
  .add(
    // Sketchy, "vote" stage: the caller's pick for the real title. Not for
    // the artist, and never for your own bluff.
    HttpApiEndpoint.post("submitVote", "/games/lobbies/:id/vote", {
      params: GameLobbyIdPath,
      payload: SubmitVoteBody,
      success: GameLobby,
      error: [NotFound, Forbidden, InvalidGameRequest],
    }).middleware(Authentication),
  )
  .add(
    // Ranked by each player's best score in the period (default: all time).
    HttpApiEndpoint.get("getLeaderboard", "/games/:game/leaderboard", {
      params: GamePath,
      query: LeaderboardQuery,
      success: Leaderboard,
    }).middleware(Authentication),
  );

// --- Notifications (issue #317, see NotificationsHandler.ts) ----------------
//
// What happened to the caller's content or to them directly:
//  - "comment":     `actor` commented on the caller's post.
//  - "reply":       `actor` replied to the caller's comment.
//  - "reaction":    `actor` reacted with `emoji` to the caller's post (only
//                   `postId` set) or comment (`commentId` set too).
//  - "mention":     `actor` @mentioned the caller in a post (only `postId`)
//                   or a comment/reply (`commentId` set too).
//  - "game_invite": `actor` invited the caller into lobby `lobbyId` of
//                   `game`.
//  - "game_record": `actor` took the caller's #1 spot on `game`'s all-time
//                   leaderboard.
export const NotificationType = Schema.Literals([
  "comment",
  "reply",
  "reaction",
  "mention",
  "game_invite",
  "game_record",
]).annotate({ identifier: "NotificationType" });
export type NotificationType = typeof NotificationType.Type;

export const Notification = Schema.Struct({
  id: Schema.Finite,
  type: NotificationType,
  actor: User,
  postId: Schema.NullOr(Schema.Finite),
  commentId: Schema.NullOr(Schema.Finite),
  emoji: Schema.NullOr(Schema.String),
  game: Schema.NullOr(GameId),
  lobbyId: Schema.NullOr(Schema.Finite),
  // A short plain-text slice of the comment (when `commentId` is set) or
  // post the notification is about, read live at request time — so it
  // reflects edits. Null for game notifications and non-text posts.
  excerpt: Schema.NullOr(Schema.String),
  read: Schema.Boolean,
  createdAt: Schema.Finite,
}).annotate({ identifier: "Notification" });
export type Notification = typeof Notification.Type;

export const DEFAULT_NOTIFICATIONS_LIMIT = 20;
export const MAX_NOTIFICATIONS_LIMIT = 50;

// Newest first, keyset on id. Anonymous for the reason in CLAUDE.md.
export const NotificationsPageQuery = Schema.Struct({
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_NOTIFICATIONS_LIMIT }),
    ),
  ),
});

export const NotificationsPage = Schema.Struct({
  notifications: Schema.Array(Notification),
  limit: Schema.Finite,
  nextCursor: Schema.NullOr(Schema.String),
  // Same number `GET /notifications/unread-count` returns, bundled so the
  // inbox and its badge never disagree after one fetch.
  unreadCount: Schema.Finite,
}).annotate({ identifier: "NotificationsPage" });

export const UnreadNotificationCount = Schema.Struct({
  count: Schema.Finite,
}).annotate({ identifier: "UnreadNotificationCount" });

export class InvalidNotificationRequest extends Schema.TaggedError<InvalidNotificationRequest>()(
  "InvalidNotificationRequest",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

const NotificationIdPath = Schema.Struct({ id: Schema.Int });

const NotificationsGroup = HttpApiGroup.make("notifications")
  .add(
    HttpApiEndpoint.get("listNotifications", "/notifications", {
      query: NotificationsPageQuery,
      success: NotificationsPage,
      error: InvalidNotificationRequest,
    }).middleware(Authentication),
  )
  .add(
    // The header bell's badge — cheap enough to fetch on every page load.
    HttpApiEndpoint.get(
      "getUnreadNotificationCount",
      "/notifications/unread-count",
      {
        success: UnreadNotificationCount,
      },
    ).middleware(Authentication),
  )
  .add(
    // Registered ahead of `/notifications/:id/read` for the same reason as
    // `/users/by-username` vs `/users/:id`.
    HttpApiEndpoint.post(
      "markAllNotificationsRead",
      "/notifications/read-all",
      {
        success: UnreadNotificationCount,
      },
    ).middleware(Authentication),
  )
  .add(
    // Idempotent. Someone else's notification is a 404, not a 403, so ids
    // can't be probed.
    HttpApiEndpoint.post("markNotificationRead", "/notifications/:id/read", {
      params: NotificationIdPath,
      success: UnreadNotificationCount,
      error: NotFound,
    }).middleware(Authentication),
  );

// One failed node of a request decode, as `HttpApiDecodeError` reports it.
// `_tag` is "Refinement" when a check supplied its own hand-authored message
// (kept verbatim) and "Type" otherwise (message replaced with a generic one)
// — see DecodeErrorSanitizer.ts.
const DecodeIssue = Schema.Struct({
  _tag: Schema.Literals(["Refinement", "Type"]),
  path: Schema.Array(Schema.Union([Schema.String, Schema.Finite])),
  message: Schema.String,
}).annotate({ identifier: "Issue" });

// The 400 body for a path/query/header/payload that fails to decode. Kept
// wire-compatible with effect v3's `HttpApiDecodeError` (which v4 dropped in
// favour of an empty 400): `web/src/lib/errors.ts` reads `issues` from it.
export class HttpApiDecodeError extends Schema.TaggedError<HttpApiDecodeError>()(
  "HttpApiDecodeError",
  { issues: Schema.Array(DecodeIssue), message: Schema.String },
  { httpApiStatus: 400 },
) {}

// Turns every request decode failure into a sanitized HttpApiDecodeError —
// implemented in DecodeErrorSanitizer.ts.
export class SanitizeDecodeErrors extends HttpApiMiddleware.Service<SanitizeDecodeErrors>()(
  "SanitizeDecodeErrors",
  { error: HttpApiDecodeError },
) {}

export class ChatApi extends HttpApi.make("chat-platform")
  .add(UsersGroup)
  .add(PostsGroup)
  .add(CommentsGroup)
  .add(ChatsGroup)
  .add(SearchGroup)
  .add(AttachmentsGroup)
  .add(MetaGroup)
  .add(RealtimeGroup)
  .add(AdminGroup)
  .add(GamesGroup)
  .add(NotificationsGroup)
  .middleware(SanitizeDecodeErrors)
  .annotate(OpenApi.Version, packageJson.version) {}
