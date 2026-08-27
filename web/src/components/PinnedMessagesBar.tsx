import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Loader2, Pin, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { $api } from "@/lib/api";
import {
  chatPinnedQueryKey,
  patchCachedMessage,
  usePinnedMessages,
  type ChatMessage,
  type ChatParticipant,
} from "@/lib/chats";
import { errorMessage } from "@/lib/errors";
import { userLabel } from "@/lib/users";
import { cn } from "@/lib/utils";

// One-line preview of what a pinned message holds — its text, or a stand-in
// for non-text content (mirrors `parentPreviewText` in MessageBubble).
function messagePreview(message: ChatMessage): string {
  if (message.contentType === "image_url") return "📷 Photo";
  if (message.contentType === "attachment") return "📎 Attachment";
  return message.content;
}

// A collapsible banner above the message thread listing the chat's pinned
// messages (issue #223) — chat-wide, so every participant sees the same set.
// Renders nothing when the chat has no pins. Clicking a row scrolls the thread
// to that message if it's in the currently-loaded window (`onJump`); the
// unpin button removes the pin for everyone.
export function PinnedMessagesBar({
  chatId,
  participants,
  enabled,
  onJump,
}: {
  chatId: number;
  participants: ReadonlyArray<ChatParticipant>;
  enabled: boolean;
  onJump: (messageId: number) => void;
}) {
  const queryClient = useQueryClient();
  const { data: pinned } = usePinnedMessages(chatId, enabled);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unpin = $api.useMutation("delete", "/chats/{id}/pins/{messageId}");

  if (!pinned || pinned.length === 0) return null;

  const senderName = (senderId: number): string => {
    const p = participants.find(
      (participant) => participant.userId === senderId,
    );
    return p ? userLabel(p) : "Someone";
  };

  async function handleUnpin(messageId: number) {
    setError(null);
    try {
      const result = await unpin.mutateAsync({
        params: { path: { id: String(chatId), messageId: String(messageId) } },
      });
      patchCachedMessage(queryClient, chatId, messageId, (m) => ({
        ...m,
        pinned: result.pinned,
      }));
      void queryClient.invalidateQueries({
        queryKey: chatPinnedQueryKey(chatId),
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="border-b border-border bg-muted/40">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm transition-colors hover:bg-muted/60"
        aria-expanded={expanded}
      >
        <Pin className="size-3.5 shrink-0 fill-current text-primary" />
        <span className="font-medium">
          {pinned.length} pinned message{pinned.length === 1 ? "" : "s"}
        </span>
        {!expanded && (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {messagePreview(pinned[0]!)}
          </span>
        )}
        <ChevronDown
          className={cn(
            "ml-auto size-4 shrink-0 text-muted-foreground transition-transform duration-300 ease-spring",
            expanded && "rotate-180",
          )}
        />
      </button>

      {/* The list height-animates open rather than appearing at full size:
          the wrapper is a one-row grid whose track goes 0fr → 1fr, which
          (unlike `height: auto`) actually interpolates. The `<ul>` has to be
          `min-h-0` or the grid refuses to squeeze it. See
          `animate-collapse-in`. */}
      {expanded && (
        <div className="motion-safe:animate-collapse-in">
          <ul className="flex max-h-56 min-h-0 flex-col gap-1 overflow-y-auto px-2 pb-2">
            {pinned.map((message) => (
              <li key={message.id}>
                <div className="group/pin flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/70">
                  <button
                    type="button"
                    onClick={() => onJump(message.id)}
                    className="flex min-w-0 flex-1 flex-col items-start text-left"
                  >
                    <span className="text-xs font-semibold text-primary">
                      {senderName(message.senderId)}
                    </span>
                    <span className="line-clamp-1 w-full break-words text-xs text-muted-foreground">
                      {messagePreview(message)}
                    </span>
                  </button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label="Unpin message"
                    disabled={unpin.isPending}
                    onClick={() => void handleUnpin(message.id)}
                    className="size-6 shrink-0 opacity-0 transition-opacity group-hover/pin:opacity-100"
                  >
                    {unpin.isPending ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <X className="size-3.5" />
                    )}
                  </Button>
                </div>
              </li>
            ))}
            {error && <p className="px-2 text-xs text-destructive">{error}</p>}
          </ul>
        </div>
      )}
    </div>
  );
}
