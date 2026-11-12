import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Ban, Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { $api, blocksQueryKey } from "@/lib/api";
import { chatDetailQueryKey, chatsListQueryKey, type Chat } from "@/lib/chats";
import { errorMessage } from "@/lib/errors";
import { userLabel, userLabelWithHandle } from "@/lib/users";

type Action = "accept" | "decline" | "block";

/**
 * Stands in for the composer while a group is a message request for the
 * viewer (issue #785): someone they share no chat with put them in it. They
 * can read it, but it stays out of their chat list and unread badge until
 * they accept; declining leaves the group, and can block whoever added them.
 */
export function MessageRequestBar({ chat }: { chat: Chat }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const accept = $api.useMutation("post", "/chats/{id}/accept");
  const leave = $api.useMutation("post", "/chats/{id}/leave");
  const setBlock = $api.useMutation("put", "/users/{id}/block");
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);

  const addedBy = chat.messageRequest?.addedBy ?? null;
  const adder = chat.participants.find((p) => p.userId === addedBy);
  const adderName = adder ? userLabel(adder) : null;
  const adderNamed = adder ? userLabelWithHandle(adder) : null;
  const path = { path: { id: String(chat.id) } };

  async function run(action: Action) {
    setPending(action);
    setError(null);
    try {
      if (action === "accept") {
        const accepted = await accept.mutateAsync({ params: path });
        queryClient.setQueryData(chatDetailQueryKey(chat.id), accepted);
        await queryClient.invalidateQueries({ queryKey: chatsListQueryKey });
        return;
      }
      await leave.mutateAsync({ params: path });
      if (action === "block" && addedBy !== null) {
        await setBlock.mutateAsync({
          params: { path: { id: String(addedBy) } },
          body: { type: "block" },
        });
        await queryClient.invalidateQueries({ queryKey: blocksQueryKey });
      }
      await queryClient.invalidateQueries({ queryKey: chatsListQueryKey });
      await router.navigate({ to: "/chats/requests" });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(null);
    }
  }

  const spinner = (action: Action) =>
    pending === action && <Loader2 className="size-4 animate-spin" />;

  return (
    <section
      aria-label="Message request"
      className="flex shrink-0 flex-col gap-3 border-t border-border bg-muted/40 px-4 py-3"
    >
      <p className="text-sm">
        <span className="font-medium">
          {adderNamed ?? "Someone"} added you to this group.
        </span>{" "}
        <span className="text-muted-foreground">
          You don&apos;t have a chat with them yet — accept to see it in your
          chats and get its messages, or decline to leave.
        </span>
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={pending !== null}
          onClick={() => void run("accept")}
        >
          {spinner("accept") || <Check className="size-4" />}
          Accept
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending !== null}
          onClick={() => void run("decline")}
        >
          {spinner("decline") || <X className="size-4" />}
          Decline
        </Button>
        {addedBy !== null && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending !== null}
            onClick={() => void run("block")}
          >
            {spinner("block") || <Ban className="size-4" />}
            Decline and block {adderName ?? "them"}
          </Button>
        )}
      </div>
    </section>
  );
}
