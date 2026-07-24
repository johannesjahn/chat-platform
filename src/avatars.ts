import { OUTPUT_CONTENT_TYPE } from "./ImageProcessing.ts";

// Uploaded avatars (issue #269) migrated out of inline base64 `users` columns
// and into the S3-compatible object store (issue #289), served through a
// long-cache proxy route rather than presigned links. This module holds the
// glue tying the three representations of a stored variant together:
//
//   token   — the opaque random id persisted in `users.avatar*Key`
//   key     — `avatars/<token>`, the object's key in the bucket
//   url     — `/avatars/<token>`, the path `GET /avatars/:token` serves
//             (see AvatarRoute.ts), returned to clients in `avatarVariants`
//
// A fresh token is minted per upload, so a re-upload changes the key *and*
// the URL — which is what makes the aggressive `immutable` caching on the
// proxy safe (a given URL's bytes never change) without ever serving a stale
// avatar (issue #289).

// All avatar objects live under this prefix in the bucket, mirroring how
// attachments live under `attachments/` — keeps a bucket listing legible and
// lets an ops-side lifecycle rule target avatars distinctly if ever needed.
const AVATAR_STORAGE_PREFIX = "avatars/";

// The content type every stored variant carries: `processAvatar` always
// transcodes to WebP (see ImageProcessing.ts), so the proxy can set this
// without a per-object metadata lookup.
export const AVATAR_CONTENT_TYPE = OUTPUT_CONTENT_TYPE;

// A short, unguessable id — its randomness is what lets the served URL stay
// public (no per-request auth) without exposing "user N's avatar" as a
// guessable URL, and what cache-busts a re-upload.
export const generateAvatarToken = (): string => crypto.randomUUID();

// Bucket key for a token. The proxy route reconstructs this from its `:token`
// path param, and the upload path stores bytes under it.
export const avatarStorageKey = (token: string): string =>
  `${AVATAR_STORAGE_PREFIX}${token}`;

// Public, relative URL a client loads a variant from. Relative (not absolute)
// on purpose: the backend has no reliable notion of its own browser-facing
// origin, and the one frontend that renders these already knows the API base
// (see web/src/components/Avatar.tsx, which prefixes it). Same shape as the
// stored key with a leading slash, so `/avatars/:token` maps straight back to
// `avatars/<token>`.
export const avatarUrlForToken = (token: string): string =>
  `/${avatarStorageKey(token)}`;
