import { isStatusVisible, type UserStatus } from "@/lib/status";
import { cn } from "@/lib/utils";

type UserStatusBadgeProps = {
  status: UserStatus | null | undefined;
  className?: string;
};

// A user's custom status (issue #218) — an emoji and/or short message,
// rendered next to their name in the chat sidebar, participant lists, and
// profile cards. Renders nothing once `status` is unset or its
// `statusExpiresAt` has passed (see `isStatusVisible`), so callers can render
// this unconditionally rather than checking first.
export function UserStatusBadge({ status, className }: UserStatusBadgeProps) {
  if (!isStatusVisible(status)) return null;
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1", className)}>
      {status.statusEmoji && (
        <span aria-hidden="true">{status.statusEmoji}</span>
      )}
      {status.statusText && (
        <span className="truncate">{status.statusText}</span>
      )}
    </span>
  );
}
