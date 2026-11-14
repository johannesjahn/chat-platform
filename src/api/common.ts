import { Schema } from "effect";

// Drop-in for `Schema.isMinLength` whose JSON Schema states the bound the
// server actually enforces (issue #761). effect 4.x's own `isMinLength`
// emits `minLength: Math.ceil(n / 2)` for strings: JSON Schema counts code
// points while `string.length` counts UTF-16 code units, and one code point
// can be two units, so effect halves the bound to stay a "safe" (never
// stricter) approximation. That turned every documented floor into half of
// itself (password 8 → 4, username 3 → 2). We'd rather the spec — Swagger at
// /docs, openapi.json and the generated client — advertise the real rule; it
// only differs from the check for strings full of astral characters (emoji),
// which every field it guards either forbids (usernames are ASCII by
// pattern) or never meets in practice. Arrays already get an exact
// `minItems`, and `Schema.isMaxLength` is already exact (a string never has
// more code points than code units), so this is the only length check that
// needs it. `src/openapi.test.ts` holds Api.ts to it.
export const isMinLength = (minLength: number) =>
  Schema.isMinLength(minLength, {
    toJsonSchema: ({ type }) =>
      type === "string"
        ? minLength <= 1
          ? { minLength }
          : [{ minLength }, true]
        : type === "array"
          ? { minItems: minLength }
          : type === undefined
            ? [{ minLength, minItems: minLength }, true]
            : [{}, true],
  });

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

// Self-contained `data:image/webp;base64,...` URLs for the 3 fixed sizes an
// uploaded-and-cropped avatar is stored/served at (issue #269) — see
// `processAvatar`/`AVATAR_VARIANT_PX` in ImageProcessing.ts for how they're
// produced, and the comment on `users.avatarSmall` (db/schema.ts) for why
// they're embedded directly rather than resolved via a presigned URL like
// `Attachment.url`. Mutually exclusive with `avatarUrl` on `User`
// (api/users.ts) — exactly one of the two is ever non-null.
export const AvatarVariants = Schema.Struct({
  small: Schema.String,
  medium: Schema.String,
  large: Schema.String,
}).annotate({ identifier: "AvatarVariants" });

// Comments, replies, and reactions on posts/comments. Kept in its own group
// (rather than folded into `posts`) since it spans two path roots
// (`/posts/:id/...` and `/comments/:id/...`) and its own handler — the group
// name is just an organizational label, it doesn't have to match the path.
export const IdParam = Schema.Struct({ id: Schema.Int });
