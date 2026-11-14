import { HttpApi, HttpApiMiddleware, OpenApi } from "effect/http-api";
import { Schema } from "effect";
import packageJson from "../package.json" with { type: "json" };
import { AdminGroup } from "./api/admin.ts";
import { AttachmentsGroup } from "./api/attachments.ts";
import { ChatsGroup } from "./api/chats.ts";
import { GamesGroup } from "./api/games.ts";
import { MetaGroup, RealtimeGroup } from "./api/meta.ts";
import { NotificationsGroup } from "./api/notifications.ts";
import { CommentsGroup, PostsGroup } from "./api/posts.ts";
import { SearchGroup } from "./api/search.ts";
import { UsersGroup } from "./api/users.ts";

// The API's schemas and endpoint groups live per area under src/api/ (issue
// #811); this module re-exports all of them and assembles `ChatApi`, so
// every importer keeps importing from here.
export * from "./api/admin.ts";
export * from "./api/attachments.ts";
export * from "./api/chats.ts";
export * from "./api/common.ts";
export * from "./api/errors.ts";
export * from "./api/games.ts";
export * from "./api/meta.ts";
export * from "./api/notifications.ts";
export * from "./api/posts.ts";
export * from "./api/search.ts";
export * from "./api/users.ts";

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
