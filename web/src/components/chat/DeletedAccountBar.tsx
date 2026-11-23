import { UserX } from "lucide-react";

/**
 * Stands in for the composer in a direct chat whose other half deleted
 * their account (issue #895): the history stays readable, but there's
 * nobody left to send to, and the server rejects new messages.
 */
export function DeletedAccountBar() {
  return (
    <section
      aria-label="Account deleted"
      className="flex shrink-0 items-center gap-2 border-t border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
    >
      <UserX className="size-4 shrink-0" aria-hidden />
      <p>
        This account was deleted. You can still read the conversation, but you
        can&apos;t send new messages.
      </p>
    </section>
  );
}
