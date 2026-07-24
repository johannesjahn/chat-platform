import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { $api, usersQueryKey } from "@/lib/api";
import { errorMessage } from "@/lib/errors";

type DeleteUserButtonProps = {
  userId: number;
  // Shown in the confirmation prompt so an admin knows exactly who they're
  // about to remove.
  label: string;
  // "icon" is the compact trash button used inline in the users list;
  // "full" is the labelled destructive button used on the profile page.
  variant?: "icon" | "full";
  // Called after the user has been deleted — the list just relies on query
  // invalidation to drop the row, while the profile page navigates away.
  onDeleted?: () => void;
  // Surfaced to the caller so it can render the failure where it makes sense
  // (the list has no dedicated error slot; the profile page does).
  onError?: (message: string) => void;
};

// Admin-only control that permanently deletes another user via
// `DELETE /users/:id` (see UsersHandler.ts). Confirms first with
// `window.confirm` — the same pattern used for every other destructive
// action in the app (post/comment/message/chat deletion) — then invalidates
// the cached user search + profile queries so the UI reflects the removal.
export function DeleteUserButton({
  userId,
  label,
  variant = "full",
  onDeleted,
  onError,
}: DeleteUserButtonProps) {
  const queryClient = useQueryClient();
  const deleteUser = $api.useMutation("delete", "/users/{id}");
  const [pending, setPending] = useState(false);

  async function handleDelete() {
    if (
      !window.confirm(
        `Permanently delete ${label}? This removes their account, posts, comments, and messages, and can't be undone.`,
      )
    ) {
      return;
    }
    setPending(true);
    try {
      await deleteUser.mutateAsync({
        params: { path: { id: String(userId) } },
      });
      // Drop the deleted user from every cached search result and from any
      // cached individual profile.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: usersQueryKey }),
        queryClient.invalidateQueries({ queryKey: ["get", "/users/{id}"] }),
      ]);
      onDeleted?.();
    } catch (err) {
      onError?.(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  if (variant === "icon") {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 text-muted-foreground hover:text-destructive"
        aria-label={`Delete ${label}`}
        title={`Delete ${label}`}
        disabled={pending}
        onClick={(e) => {
          // The row is a link — don't navigate into the profile when the
          // admin clicks the delete button sitting on top of it.
          e.preventDefault();
          e.stopPropagation();
          void handleDelete();
        }}
      >
        {pending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Trash2 className="size-4" />
        )}
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant="destructive"
      size="sm"
      disabled={pending}
      onClick={() => void handleDelete()}
    >
      {pending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Trash2 className="size-4" />
      )}
      Delete user
    </Button>
  );
}
