import { type KeyboardEvent, useState } from "react";
import { ImageIcon, Loader2, SendHorizontal, Type } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  MAX_MESSAGE_CONTENT_LENGTH,
  type MessageContentType,
} from "@/lib/chats";

type ChatComposerProps = {
  onSend: (values: {
    contentType: MessageContentType;
    content: string;
  }) => Promise<void>;
};

export function ChatComposer({ onSend }: ChatComposerProps) {
  const [contentType, setContentType] = useState<MessageContentType>("text");
  const [content, setContent] = useState("");
  const [pending, setPending] = useState(false);

  const trimmed = content.trim();
  const overLimit = trimmed.length > MAX_MESSAGE_CONTENT_LENGTH;
  const nearLimit = trimmed.length > MAX_MESSAGE_CONTENT_LENGTH * 0.9;
  const canSend = trimmed.length > 0 && !overLimit && !pending;

  async function submit() {
    if (!canSend) return;
    setPending(true);
    try {
      await onSend({ contentType, content: trimmed });
      setContent("");
      setContentType("text");
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
            onChange={(e) => setContent(e.target.value)}
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
            placeholder="https://example.com/photo.jpg"
            aria-invalid={overLimit}
          />
        )}

        <Button
          type="button"
          size="icon"
          disabled={!canSend}
          onClick={() => void submit()}
          aria-label="Send message"
          className="shrink-0"
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <SendHorizontal className="size-4" />
          )}
        </Button>
      </div>
      {(nearLimit || overLimit) && (
        <span
          className={cn(
            "self-end text-xs",
            overLimit ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {trimmed.length}/{MAX_MESSAGE_CONTENT_LENGTH}
        </span>
      )}
    </div>
  );
}
