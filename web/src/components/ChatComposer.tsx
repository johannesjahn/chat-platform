import { type KeyboardEvent, useRef, useState } from "react";
import { ImageIcon, Loader2, SendHorizontal, Type } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { $api } from "@/lib/api";
import { isAllowedImageUrl } from "@/lib/imageHosts";
import { useOnlineStatus } from "@/lib/online";
import { cn } from "@/lib/utils";
import {
  MAX_MESSAGE_CONTENT_LENGTH,
  type MessageContentType,
} from "@/lib/chats";

// How often a `typing` push (see `POST /chats/:id/typing`) goes out while
// the user keeps typing without pausing — comfortably under the client-side
// TYPING_TTL_MS a viewer expires the indicator after (see lib/typing.ts), so
// continuous typing keeps refreshing it before it would lapse, without
// firing a request on every keystroke.
const TYPING_THROTTLE_MS = 2_500;

type ChatComposerProps = {
  chatId: number;
  onSend: (values: {
    contentType: MessageContentType;
    content: string;
  }) => Promise<void>;
};

export function ChatComposer({ chatId, onSend }: ChatComposerProps) {
  const [contentType, setContentType] = useState<MessageContentType>("text");
  const [content, setContent] = useState("");
  const [pending, setPending] = useState(false);
  const lastTypingSentAtRef = useRef(0);
  const sendTyping = $api.useMutation("post", "/chats/{id}/typing");
  const isOnline = useOnlineStatus();

  const trimmed = content.trim();
  const overLimit = trimmed.length > MAX_MESSAGE_CONTENT_LENGTH;
  const nearLimit = trimmed.length > MAX_MESSAGE_CONTENT_LENGTH * 0.9;
  const invalidImageUrl =
    contentType === "image_url" &&
    trimmed.length > 0 &&
    !isAllowedImageUrl(trimmed);
  // Sending while offline is allowed — `onSend` queues the message locally
  // instead of failing (see lib/offlineQueue.ts) — so `isOnline` no longer
  // gates this the way it gates a plain query.
  const canSend =
    trimmed.length > 0 && !overLimit && !invalidImageUrl && !pending;

  function notifyTyping() {
    const now = Date.now();
    if (now - lastTypingSentAtRef.current < TYPING_THROTTLE_MS) return;
    lastTypingSentAtRef.current = now;
    sendTyping.mutate({ params: { path: { id: String(chatId) } } });
  }

  function handleContentChange(value: string) {
    setContent(value);
    if (value.trim().length > 0) notifyTyping();
  }

  async function submit() {
    if (!canSend) return;
    setPending(true);
    try {
      await onSend({ contentType, content: trimmed });
      setContent("");
      setContentType("text");
      lastTypingSentAtRef.current = 0;
    } finally {
      setPending(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <div className="flex flex-col gap-1.5 border-t border-border bg-card/70 px-4 py-3 backdrop-blur">
      <div className="flex items-end gap-2">
        <div className="flex shrink-0 gap-1">
          <Button
            type="button"
            size="icon"
            variant={contentType === "text" ? "secondary" : "ghost"}
            aria-label="Text message"
            aria-pressed={contentType === "text"}
            onClick={() => setContentType("text")}
          >
            <Type className="size-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant={contentType === "image_url" ? "secondary" : "ghost"}
            aria-label="Image message"
            aria-pressed={contentType === "image_url"}
            onClick={() => setContentType("image_url")}
          >
            <ImageIcon className="size-4" />
          </Button>
        </div>

        {contentType === "text" ? (
          <Textarea
            value={content}
            onChange={(e) => handleContentChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Write a message… (Enter to send, Shift+Enter for a new line)"
            rows={1}
            aria-invalid={overLimit}
            className="min-h-9 flex-1 resize-none py-2"
          />
        ) : (
          <Input
            type="url"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder="https://picsum.photos/id/1/600/800"
            aria-invalid={invalidImageUrl}
          />
        )}

        <Button
          type="button"
          size="icon"
          disabled={!canSend}
          onClick={() => void submit()}
          aria-label={
            isOnline ? "Send message" : "Send message (will be queued)"
          }
          title={
            isOnline
              ? undefined
              : "You're offline — this will be queued and sent once you reconnect"
          }
          className="shrink-0"
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <SendHorizontal className="size-4" />
          )}
        </Button>
      </div>
      {invalidImageUrl && (
        <span className="self-end text-xs text-destructive">
          Must be an https:// link from a supported image host (e.g.
          picsum.photos, imgur.com, unsplash.com).
        </span>
      )}
      {!isOnline ? (
        <span className="self-end text-xs text-muted-foreground">
          You&apos;re offline — messages you send will be queued and delivered
          once you&apos;re back online.
        </span>
      ) : (
        (nearLimit || overLimit) && (
          <span
            className={cn(
              "self-end text-xs",
              overLimit ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {trimmed.length}/{MAX_MESSAGE_CONTENT_LENGTH}
          </span>
        )
      )}
    </div>
  );
}
