import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  BellOff,
  Pin,
  PinOff,
  SlidersHorizontal,
} from "lucide-react";
import { DetailsSection } from "@/components/chat/DetailsSection";
import { Button } from "@/components/ui/button";
import { fetchClient } from "@/lib/api";
import type { components } from "@/lib/api-types";
import { isChatMuted, MUTED_FOREVER_MS } from "@/lib/chatMute";
import { chatDetailQueryKey, chatsListQueryKey, type Chat } from "@/lib/chats";
import { errorMessage } from "@/lib/errors";

type Changes = components["schemas"]["UpdateChatPreferencesBody"];

const MUTE_OPTIONS = [
  { value: "8h", label: "8 hours" },
  { value: "1w", label: "1 week" },
  { value: "always", label: "Always" },
] as const;

function mutedLabel(mutedUntil: number): string {
  if (mutedUntil >= MUTED_FOREVER_MS) return "Muted";
  const until = new Date(mutedUntil).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `Muted until ${until}`;
}

/**
 * The viewer's own settings for a chat (issue #900): pin, archive and mute.
 * In the chat details of every layout, for groups and direct chats alike.
 */
export function ChatPreferencesSection({ chat }: { chat: Chat }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { mutate, isPending } = useMutation({
    mutationFn: async (body: Changes) => {
      const { data, error: failure } = await fetchClient.PATCH(
        "/chats/{id}/preferences",
        { params: { path: { id: String(chat.id) } }, body },
      );
      if (failure) throw failure;
      return data;
    },
    onMutate: () => setError(null),
    onSuccess: (updated) => {
      queryClient.setQueryData<Chat>(chatDetailQueryKey(chat.id), updated);
      // Which list it's in, where, and the unread total under the same key.
      return queryClient.invalidateQueries({ queryKey: chatsListQueryKey });
    },
    onError: (failure) => setError(errorMessage(failure)),
  });
  // One at a time, without disabling the button: that would drop keyboard
  // focus on every press.
  const save = (changes: Changes) => {
    if (!isPending) mutate(changes);
  };
  const muted = isChatMuted(chat);

  return (
    <DetailsSection
      index={0}
      icon={<SlidersHorizontal className="size-4" />}
      title="Your settings"
      description="Only for you. A muted chat doesn't notify you or count as unread; an archived one comes back with its next message."
    >
      {error && (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => save({ pinned: !chat.pinned })}
        >
          {chat.pinned ? (
            <PinOff className="size-4" />
          ) : (
            <Pin className="size-4" />
          )}
          {chat.pinned ? "Unpin chat" : "Pin chat"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => save({ archived: !chat.archived })}
        >
          {chat.archived ? (
            <ArchiveRestore className="size-4" />
          ) : (
            <Archive className="size-4" />
          )}
          {chat.archived ? "Unarchive chat" : "Archive chat"}
        </Button>
      </div>
      <div
        role="group"
        aria-label="Mute chat"
        className="flex flex-wrap items-center gap-2"
      >
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <BellOff className="size-4 shrink-0" />
          {muted ? mutedLabel(chat.mutedUntil!) : "Mute for"}
        </span>
        {muted ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => save({ mute: null })}
          >
            Unmute chat
          </Button>
        ) : (
          MUTE_OPTIONS.map(({ value, label }) => (
            <Button
              key={value}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => save({ mute: value })}
            >
              {label}
            </Button>
          ))
        )}
      </div>
    </DetailsSection>
  );
}
