import { Schema } from "effect";

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
