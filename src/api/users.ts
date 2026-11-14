import { Multipart } from "effect/http";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { Schema } from "effect";
import { Authentication } from "../Auth.ts";
import { AvatarVariants, isAllowedImageUrl, isMinLength } from "./common.ts";
import {
  Forbidden,
  InvalidBlockRequest,
  InvalidCredentials,
  InvalidPostsRequest,
  NotFound,
  TooManyRequests,
  UsernameTaken,
} from "./errors.ts";
import { PostsPageQuery, UserPostsPage } from "./posts.ts";

// "admin" can edit/delete any post; "user" can only edit/delete their own.
// Registration always creates a "user" — admins are promoted out-of-band.
export const UserRole = Schema.Literals(["user", "admin"]).annotate({
  identifier: "UserRole",
});

export type UserRole = typeof UserRole.Type;

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
  // `effectiveStatus` in users/userViews.ts), so a client never has to
  // separately check whether to still show it.
  statusText: Schema.NullOr(Schema.String),
  statusEmoji: Schema.NullOr(Schema.String),
  statusExpiresAt: Schema.NullOr(Schema.Finite),
}).annotate({ identifier: "User" });

export type User = typeof User.Type;

// A `User` plus the fields only the profile itself shows (issue #322) —
// returned by `getUser` and `updateProfile` rather than folded into `User`,
// so the many list endpoints (search, members, notifications, leaderboards)
// don't carry every bio along. `bio` is null when unset.
export const UserProfile = Schema.Struct({
  ...User.fields,
  bio: Schema.NullOr(Schema.String),
}).annotate({ identifier: "UserProfile" });

export type UserProfile = typeof UserProfile.Type;

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

// Characters a newly registered username may use (issue #493): exactly the
// `@mention` token class (`MENTION_CHARS` in src/notifications.ts and
// web/src/lib/mentions.ts), and not ending in "." or "-" — the mention parser
// hands a trailing run of those back to the surrounding prose — so every new
// account can be @mentioned, and no space, emoji, look-alike or bidi-control
// character can get into a name. Like the length floor, registration only:
// accounts that predate it can still sign in.
export const USERNAME_PATTERN = /^[A-Za-z0-9_.-]*[A-Za-z0-9_]$/u;

export const USERNAME_PATTERN_MESSAGE =
  'Username may only contain letters (A-Z), digits, "_", "." and "-", and must not end in "." or "-"';

const NewUsername = Username.check(
  isMinLength(MIN_USERNAME_LENGTH),
  Schema.isPattern(USERNAME_PATTERN, { message: USERNAME_PATTERN_MESSAGE }),
);

// Mirrors MAX_USERNAME_LENGTH's rationale but roomier, since a display name
// may hold a full "First Last" rather than a single token.
export const MAX_DISPLAY_NAME_LENGTH = 64;

const DisplayName = Schema.Trimmed.check(Schema.isNonEmpty()).check(
  Schema.isMaxLength(MAX_DISPLAY_NAME_LENGTH),
);

// Short like a social-profile bio (issue #322) — a line or two about who
// someone is, not a post.
export const MAX_BIO_LENGTH = 160;

const Bio = Schema.Trimmed.check(Schema.isNonEmpty()).check(
  Schema.isMaxLength(MAX_BIO_LENGTH),
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
const NewPassword = Password.check(isMinLength(MIN_PASSWORD_LENGTH));

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
// `bio` (issue #322) is the one exception to full-replace: omitting it leaves
// the stored bio untouched (null still clears it), so a client built before
// the field existed — e.g. an old tab mid-rollout — can't wipe it on save.
export const UpdateProfileBody = Schema.Struct({
  displayName: Schema.NullOr(DisplayName),
  avatarUrl: Schema.NullOr(AvatarUrl),
  bio: Schema.optional(Schema.NullOr(Bio)),
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

// Raised by `POST /users/me/avatar` (issue #269) for anything wrong with the
// upload other than its size: an unsupported content type, bytes that don't
// decode as an image, a source image smaller than MIN_AVATAR_SOURCE_PX in
// either dimension, or a crop rectangle that doesn't fit within the actual
// decoded image bounds. `message` carries the specific reason (see
// users/profileHandlers.ts) — unlike the generic messages of most API errors,
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
// (api/posts.ts, see CLAUDE.md) — it's inlined into query parameters. No
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

// How many people one `GET /users/contacts` call returns (issue #764). The
// client filters this list itself for 1–2 character queries — below the
// directory search's floor — so it has to hold most of the people someone
// actually talks to, while staying a bounded payload however many chats
// they're in.
export const MAX_CONTACTS = 50;

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
// (api/attachments.ts). `maxFileSize` here is the same coarse in-stream
// backstop `UploadAttachmentBody` uses — set looser than
// MAX_AVATAR_UPLOAD_SIZE_BYTES so an ordinary too-large upload trips the
// handler's precise, typed AvatarTooLarge (413) check instead of a generic 400
// from the multipart parser itself.
export const UploadAvatarBody = Schema.Struct({
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

export const UsersGroup = HttpApiGroup.make("users")
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
    // The caller's own contacts (issue #764): everyone they share an
    // accepted chat with, most recent chat activity first, capped at
    // `MAX_CONTACTS`. Backs the suggestions the New chat picker, `/users`
    // and the palette show before (and, filtered client-side, below) the
    // directory search's `MIN_USER_SEARCH_QUERY_LENGTH` floor — which this
    // doesn't weaken, since it only ever returns people the caller already
    // shares a chat with. Blocks in either direction, and pending message
    // requests on either side (issue #785), are left out — the same set
    // `PresenceAudience` shares presence with. Registered ahead of
    // `getUser` like `/users/by-username`.
    HttpApiEndpoint.get("listContacts", "/users/contacts", {
      success: Schema.Array(User),
    }).middleware(Authentication),
  )
  .add(
    HttpApiEndpoint.get("getUser", "/users/:id", {
      params: { id: Schema.Int },
      success: UserProfile,
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
    // (issue #67), and bio (issue #322). Full-replace like
    // `updatePost`/`updateChat`, except that an omitted `bio` is kept.
    // Username is not editable through this endpoint.
    HttpApiEndpoint.put("updateProfile", "/users/me", {
      payload: UpdateProfileBody,
      success: UserProfile,
    }).middleware(Authentication),
  )
  .add(
    // Uploads and stores a square-cropped avatar (issue #269), overwriting
    // any existing uploaded avatar and clearing `avatarUrl` — the two are
    // mutually exclusive (see users/profileHandlers.ts). `updateProfile` above
    // is the inverse: setting `avatarUrl` (or clearing it) always clears an
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
    // `statusEmoji` to null clears the status entirely. Pushes a
    // `status_changed` realtime event (see Realtime.ts) to the user's
    // contacts, the same audience presence updates go to.
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
