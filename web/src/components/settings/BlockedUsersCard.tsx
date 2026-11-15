import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Ban, BellOff, Loader2 } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { $api, blocksQueryKey } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { userHandle, userLabel } from "@/lib/users";

// Lists everyone the current user has blocked or muted (issue #219) with a
// control to lift each relationship. Blocking hides a user's posts, mutes
// their chat notifications, and stops direct messaging both ways; muting only
// hides posts and mutes notifications. New blocks/mutes are added from a
// user's profile page (see BlockUserControls), so this card is management-only.
export function BlockedUsersCard() {
  const queryClient = useQueryClient();
  const { data: blocks, isLoading } = $api.useQuery("get", "/users/me/blocks");
  const removeBlock = $api.useMutation("delete", "/users/{id}/block");
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<number | null>(null);

  async function lift(userId: number) {
    setError(null);
    setPendingId(userId);
    try {
      await removeBlock.mutateAsync({
        params: { path: { id: String(userId) } },
      });
      await queryClient.invalidateQueries({ queryKey: blocksQueryKey });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <Card className="w-full motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
      <CardHeader>
        <CardTitle>Blocked &amp; muted users</CardTitle>
        <CardDescription>
          Blocking hides someone&apos;s posts, silences their chat
          notifications, and stops direct messages both ways. Muting just hides
          their posts and notifications. Add new ones from a user&apos;s
          profile.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error && (
          <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading…
          </div>
        ) : !blocks || blocks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            You haven&apos;t blocked or muted anyone.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {blocks.map((block) => (
              <li
                key={block.user.id}
                className="flex items-center justify-between gap-3"
              >
                <Link
                  to="/users/$id"
                  params={{ id: String(block.user.id) }}
                  className="flex min-w-0 items-center gap-3"
                >
                  <Avatar
                    name={block.user.displayName || block.user.username}
                    avatarUrl={block.user.avatarUrl}
                    avatarVariants={block.user.avatarVariants}
                    size="sm"
                  />
                  <div className="flex min-w-0 flex-col leading-tight">
                    <span className="truncate text-sm font-medium">
                      {userLabel(block.user)}
                      {userHandle(block.user) && (
                        <span className="ml-1.5 font-normal text-muted-foreground">
                          {userHandle(block.user)}
                        </span>
                      )}
                    </span>
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      {block.type === "block" ? (
                        <Ban className="size-3" />
                      ) : (
                        <BellOff className="size-3" />
                      )}
                      {block.type === "block" ? "Blocked" : "Muted"}
                    </span>
                  </div>
                </Link>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pendingId === block.user.id}
                  onClick={() => void lift(block.user.id)}
                >
                  {pendingId === block.user.id && (
                    <Loader2 className="size-4 animate-spin" />
                  )}
                  {block.type === "block" ? "Unblock" : "Unmute"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
