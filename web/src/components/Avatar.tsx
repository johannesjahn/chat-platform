import { cn } from "@/lib/utils";

const AVATAR_SIZES = {
  sm: "size-7 text-xs",
  md: "size-9 text-sm",
  lg: "size-11 text-sm",
  xl: "size-20 text-2xl",
} as const;

type AvatarSize = keyof typeof AVATAR_SIZES;

type AvatarProps = {
  name: string;
  // Not sourced from anywhere yet — the `User` schema has no avatar field —
  // but every call site already threads this through so a future image
  // avatar only needs a backend field, not a UI rewrite.
  avatarUrl?: string | null;
  size?: AvatarSize;
  className?: string;
};

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
  size = "md",
  className,
}: AvatarProps) {
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt=""
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
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-primary/15 font-semibold text-primary",
        AVATAR_SIZES[size],
        className,
      )}
    >
      {getInitials(name)}
    </div>
  );
}
