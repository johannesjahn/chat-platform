import { replaceEqualDeep } from "@tanstack/react-query";

// Attachment `url`s are presigned S3 GET links (see `presignGetUrl` in
// src/AttachmentStorage.ts), and the backend mints a fresh one on *every*
// read — same object, new `X-Amz-Date`/`X-Amz-Signature`. Left alone, every
// background refetch (navigating back to a screen, window refocus, a
// realtime invalidation) therefore hands the UI a different `src` for every
// image/video/audio already on screen: the browser can't reuse its cached
// bytes (different URL), `BlurhashImage` falls back to its blur placeholder,
// and a playing voice message restarts — the "page loads, then refreshes a
// moment later" flash from issue #433.
//
// The fix lives here, once, as the QueryClient's `structuralSharing` (see
// query.ts), so it covers every query and every `setQueryData` in the app
// rather than each screen that happens to render an attachment: before
// React Query's usual deep-equal reference sharing runs, any attachment in
// the incoming data whose URL still has a valid, previously seen URL for the
// same attachment id gets that URL back. Nothing else about the response is
// touched, so a refetch that changed nothing now really is a no-op for
// React (same references, no re-render), and one that did change something
// only re-renders what changed.
//
// Keyed by attachment id across *all* queries (not just the query's own
// previous data), so the same attachment reached through another query —
// the feed card and then the post page, a message and then the pinned bar
// — also reuses the URL the browser already has cached.

// Swap to the freshly minted URL once the one we're holding is within this
// long of expiring, so a URL handed to the DOM (the lightbox, a video's
// later range requests) is never one that's about to stop working. The
// backend's TTL is 15 minutes (`PRESIGNED_URL_TTL_SECONDS`), so a URL gets
// reused for ~13 minutes before it's rotated on the next refetch.
const EXPIRY_MARGIN_MS = 2 * 60 * 1000;

type Entry = { url: string; expiresAt: number };

const knownUrls = new Map<number, Entry>();

type AttachmentLike = {
  id: number;
  url: string;
  mimeType: string;
  filename: string;
};

function isAttachmentLike(value: object): value is AttachmentLike {
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "number" &&
    typeof record.url === "string" &&
    typeof record.mimeType === "string" &&
    typeof record.filename === "string"
  );
}

// `X-Amz-Date` is SigV4's compact ISO-8601 (`20260927T162604Z`) and
// `X-Amz-Expires` the validity in seconds from it. Anything else — the
// in-memory storage's `data:` URLs in dev/tests, a URL we can't parse —
// has no known expiry and is never substituted (it's returned as-is).
export function presignedUrlExpiry(url: string): number | null {
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    return null;
  }
  const date = params.get("X-Amz-Date");
  const expires = Number(params.get("X-Amz-Expires"));
  if (!date || !Number.isFinite(expires) || expires <= 0) return null;
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(date);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  return Date.UTC(y!, mo! - 1, d!, h!, mi!, s!) + expires * 1000;
}

function isUsable(entry: Entry, now: number): boolean {
  return entry.expiresAt - EXPIRY_MARGIN_MS > now;
}

// Registers `url` for attachment `id` unless we already hold a usable one,
// and returns whichever URL callers should render.
function stableUrlFor(id: number, url: string, now: number): string {
  const known = knownUrls.get(id);
  if (known && isUsable(known, now)) return known.url;
  const expiresAt = presignedUrlExpiry(url);
  if (expiresAt === null) {
    knownUrls.delete(id);
    return url;
  }
  const entry = { url, expiresAt };
  if (isUsable(entry, now)) knownUrls.set(id, entry);
  else knownUrls.delete(id);
  return url;
}

// API payloads are a handful of levels deep (InfiniteData → page → post →
// attachment); this only guards against walking something pathological.
const MAX_DEPTH = 16;

// Seeds the registry from data that's already rendered (e.g. restored from
// the persisted cache after a reload, which never passes through
// `structuralSharing`) so its URLs win over the ones the first refetch
// brings back.
function registerUrls(value: unknown, now: number, depth = 0): void {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) registerUrls(item, now, depth + 1);
    return;
  }
  if (isAttachmentLike(value)) {
    stableUrlFor(value.id, value.url, now);
    return;
  }
  for (const child of Object.values(value)) registerUrls(child, now, depth + 1);
}

// Returns `value` with every attachment's URL replaced by its stable one,
// copying only along the paths that actually changed — untouched subtrees
// (and the whole value, when nothing changed) keep their references.
function withStableUrls(value: unknown, now: number, depth = 0): unknown {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    let copy: unknown[] | null = null;
    value.forEach((item, index) => {
      const next = withStableUrls(item, now, depth + 1);
      if (next !== item) {
        copy ??= value.slice();
        copy[index] = next;
      }
    });
    return copy ?? value;
  }
  // Only plain JSON objects — never a Date/Map/class instance that happens
  // to be sitting in a cache entry.
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) return value;
  if (isAttachmentLike(value)) {
    const url = stableUrlFor(value.id, value.url, now);
    return url === value.url ? value : { ...value, url };
  }
  let copy: Record<string, unknown> | null = null;
  for (const [key, child] of Object.entries(value)) {
    const next = withStableUrls(child, now, depth + 1);
    if (next !== child) {
      copy ??= { ...(value as Record<string, unknown>) };
      copy[key] = next;
    }
  }
  return copy ?? value;
}

// The QueryClient's `structuralSharing` (query.ts). Must stay a pure
// function of its inputs apart from the URL registry — React Query calls it
// for fetches, `setQueryData`, and `select` results alike.
export function stableAttachmentStructuralSharing(
  oldData: unknown,
  newData: unknown,
): unknown {
  const now = Date.now();
  if (oldData !== undefined) registerUrls(oldData, now);
  return replaceEqualDeep(oldData, withStableUrls(newData, now));
}
