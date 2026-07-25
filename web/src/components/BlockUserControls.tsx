import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Ban, BellOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { $api, blocksQueryKey } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { postsFeedQueryKey } from "@/lib/posts";

type BlockUserControlsProps = {
  // The user these controls act on.
  userId: number;
  // Surfaced to the caller so it can render the failure where it makes sense.
  onError?: (message: string) => void;
};

// Block / mute / unblock controls for another user (issue #219). Reads the
// current user's block list to know the existing relationship, then offers the
// relevant actions:
//   - none        → "Mute" and "Block"
//   - muted       → "Block" (upgrade) and "Unmute"
//   - blocked     → "Unblock"
// Blocking is the stronger action (hides posts, mutes notifications, and stops
// direct messaging both ways); muting only hides posts and notifications. After
// any change the block list and the post feed are invalidated so the UI (and
// the now-hidden/-shown posts) reflect it. Rendered on the user profile page.
export function BlockUserControls({ userId, onError }: BlockUserControlsProps) {
  const queryClient = useQueryClient();
  const { data: blocks, isLoading } = $api.useQuery("get", "/users/me/blocks");
  const setBlock = $api.useMutation("put", "/users/{id}/block");
  const removeBlock = $api.useMutation("delete", "/users/{id}/block");
  const [pending, setPending] = useState(false);

  const current = blocks?.find((b) => b.user.id === userId)?.type ?? null;

  async function apply(action: "block" | "mute" | "clear") {
    setPending(true);
    try {
      if (action === "clear") {
        await removeBlock.mutateAsync({
          params: { path: { id: String(userId) } },
        });
      } else {
        await setBlock.mutateAsync({
          params: { path: { id: String(userId) } },
          body: { type: action },
        });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: blocksQueryKey }),
        // A block/mute hides the target's posts from the feed (and unblocking
        // brings them back), so the cached feed is now stale either way.
        queryClient.invalidateQueries({ queryKey: postsFeedQueryKey }),
      ]);
    } catch (err) {
      onError?.(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  if (isLoading) {
    return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  }

  const spinner = pending && <Loader2 className="size-4 animate-spin" />;

  if (current === "block") {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => void apply("clear")}
      >
        {spinner}
        <Ban className="size-4" />
        Unblock
      </Button>
    );
  }

  if (current === "mute") {
    return (
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => void apply("clear")}
        >
          {spinner}
          <BellOff className="size-4" />
          Unmute
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="text-destructive hover:text-destructive"
          disabled={pending}
          onClick={() => void apply("block")}
        >
          <Ban className="size-4" />
          Block
        </Button>
      </div>
    );
  }

  return (
    <div className="flex gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => void apply("mute")}
      >
        {spinner}
        <BellOff className="size-4" />
        Mute
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="text-destructive hover:text-destructive"
        disabled={pending}
        onClick={() => void apply("block")}
      >
        <Ban className="size-4" />
        Block
      </Button>
    </div>
  );
}
