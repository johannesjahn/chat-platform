import { HttpRouter, HttpServerResponse } from "effect/http";
import { Effect } from "effect";
import { AttachmentStorage } from "./AttachmentStorage.ts";
import { AVATAR_CONTENT_TYPE, avatarStorageKey } from "./avatars.ts";

// Uploaded avatars (issue #269) are stored in object storage and served
// through this raw route instead of being inlined as base64 or handed out as
// short-lived presigned links (issue #289). A token is minted per upload and
// never reused, so a given `/avatars/:token` URL's bytes never change — that's
// what makes this cache both aggressively (a year) and `immutable` (browsers
// skip even a revalidation request), while a re-upload still shows through
// immediately because it produces a brand-new token/URL. `public` lets shared
// caches/CDNs in front of the API hold a copy too — avatars aren't per-viewer
// secret.
const AVATAR_CACHE_CONTROL = "public, max-age=31536000, immutable";

// Serves the bytes for one stored avatar variant, or 404 if the token doesn't
// resolve to a stored object (an avatar cleared/replaced since the URL was
// minted, or a made-up token). Unauthenticated on purpose: it's rendered in
// plain `<img>` tags, which can't attach an `Authorization` header, and an
// avatar isn't sensitive — the random, unguessable token is the only thing
// gating access, the same property a presigned URL relies on.
const avatarHandler = Effect.gen(function* () {
  const { token } = yield* HttpRouter.params;
  const storage = yield* AttachmentStorage;

  // A defensive guard: `token` is a single path segment so it can't contain a
  // slash, but an empty value would still map to the bare `avatars/` prefix.
  if (!token) {
    return HttpServerResponse.text("Not found", { status: 404 });
  }

  const bytes = yield* storage.get(avatarStorageKey(token)).pipe(Effect.orDie);
  if (!bytes) {
    return HttpServerResponse.text("Not found", { status: 404 });
  }

  return HttpServerResponse.uint8Array(bytes, {
    contentType: AVATAR_CONTENT_TYPE,
    headers: { "cache-control": AVATAR_CACHE_CONTROL },
  });
});

// Attached to the same shared router as `ChatApi` (see main.ts), the same way
// `/ws` and `/health` are. `AttachmentStorage` stays a requirement of the
// route, satisfied wherever main.ts provides the server's layers.
export const AvatarRouteLive = HttpRouter.add(
  "GET",
  "/avatars/:token",
  avatarHandler,
);
