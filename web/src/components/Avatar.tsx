import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { API_URL } from "@/lib/api";
import type { components } from "@/lib/api-types";

const AVATAR_SIZES = {
  sm: "size-7 text-xs",
  md: "size-9 text-sm",
  lg: "size-11 text-sm",
  xl: "size-20 text-2xl",
} as const;

type AvatarSize = keyof typeof AVATAR_SIZES;

export type AvatarVariants = components["schemas"]["AvatarVariants"];

// Maps each CSS size this component renders at to the fixed-size variant
// (issue #269, see AVATAR_VARIANT_PX in src/ImageProcessing.ts) closest
// above it, so an uploaded avatar is never served at a resolution smaller
// than it's displayed.
const VARIANT_FOR_SIZE: Record<AvatarSize, keyof AvatarVariants> = {
  sm: "small",
  md: "small",
  lg: "medium",
  xl: "large",
};

type AvatarProps = {
  name: string;
  avatarUrl?: string | null;
  avatarVariants?: AvatarVariants | null;
  size?: AvatarSize;
  className?: string;
  /**
   * Inline styles for the rendered avatar. Every branch below forwards this,
   * which is what lets a caller name the avatar for a view transition
   * (`viewTransitionName`) without having to know whether it ended up as an
   * uploaded image, a remote URL, or the initials fallback — see
   * `chatViewTransitionNames` in lib/chats.ts.
   */
  style?: CSSProperties;
};

// The backend validates `avatarUrl` against an https:// + host allowlist at
// write time (see `isAllowedImageUrl` in src/Api.ts), but this component
// can't assume that held true for every value it's ever handed — re-checking
// the scheme here keeps a non-`https:` URL (e.g. `javascript:`) from ever
// reaching the `<img src>` sink, regardless of where the value came from.
function isSafeAvatarUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

// Uploaded avatar variants are served by the backend's long-cache proxy
// route (`GET /avatars/:token`, see src/AvatarRoute.ts / issue #289) and come
// back from the API as a root-relative path (`/avatars/<token>`) rather than a
// self-contained `data:` URL. Resolve it against the API base the rest of the
// client already talks to, so the `<img>` loads from the backend regardless of
// where the SPA itself is hosted. A value that's already absolute (defensive —
// the backend only ever sends the relative form today) is used as-is.
function resolveVariantSrc(value: string): string {
  return value.startsWith("/") ? `${API_URL}${value}` : value;
}

// Usernames are single tokens today (no separate display name), so the
// "initials" are just its first letter for now; splitting on whitespace
// keeps this correct if a multi-word display name is ever introduced.
function getInitials(name: string): string {
  const parts = name.replace(/^@/, "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 1).toUpperCase();
  return (parts[0]!.slice(0, 1) + parts[1]!.slice(0, 1)).toUpperCase();
}

export function Avatar({
  name,
  avatarUrl,
  avatarVariants,
  size = "md",
  className,
  style,
}: AvatarProps) {
  // Uploaded avatars (issue #269) take priority over `avatarUrl` — the two
  // are mutually exclusive server-side (see UsersHandler.ts), but preferring
  // the variant here means a stale/cached client that still sent both
  // renders the right one regardless. `avatarVariants` values are URLs served
  // by our own backend proxy (issue #289, resolved against the API base
  // below), not user-supplied external links, so they don't need the https://
  // host-allowlist check `avatarUrl` does below.
  const variantSrc = avatarVariants?.[VARIANT_FOR_SIZE[size]];
  if (variantSrc) {
    return (
      <img
        src={resolveVariantSrc(variantSrc)}
        alt=""
        style={style}
        className={cn(
          "shrink-0 rounded-full object-cover",
          AVATAR_SIZES[size],
          className,
        )}
      />
    );
  }

  if (avatarUrl && isSafeAvatarUrl(avatarUrl)) {
    return (
      <img
        src={avatarUrl}
        alt=""
        style={style}
        className={cn(
          "shrink-0 rounded-full object-cover",
          AVATAR_SIZES[size],
          className,
        )}
      />
    );
  }

  return (
    <div
      style={style}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary/30 to-primary/10 font-semibold text-primary ring-1 ring-inset ring-primary/20",
        AVATAR_SIZES[size],
        className,
      )}
    >
      {getInitials(name)}
    </div>
  );
}
