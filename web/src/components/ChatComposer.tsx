import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import {
  ImageIcon,
  Loader2,
  Paperclip,
  SendHorizontal,
  Type,
} from "lucide-react";
import { AttachmentUploadField } from "@/components/AttachmentUploadField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { $api } from "@/lib/api";
import type { Attachment } from "@/lib/attachments";
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
    attachmentId?: number;
  }) => Promise<void>;
};

export function ChatComposer({ chatId, onSend }: ChatComposerProps) {
  const [contentType, setContentType] = useState<MessageContentType>("text");
  const [content, setContent] = useState("");
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [pending, setPending] = useState(false);
  const lastTypingSentAtRef = useRef(0);
  const sendTyping = $api.useMutation("post", "/chats/{id}/typing");
  const isOnline = useOnlineStatus();

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (contentType !== "text") return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const newHeight = Math.min(textarea.scrollHeight, 160);
    textarea.style.height = `${newHeight}px`;
  }, [content, contentType]);

  const trimmed = content.trim();
  const overLimit = trimmed.length > MAX_MESSAGE_CONTENT_LENGTH;
  const nearLimit = trimmed.length > MAX_MESSAGE_CONTENT_LENGTH * 0.9;
  const invalidImageUrl =
    contentType === "image_url" &&
    trimmed.length > 0 &&
    !isAllowedImageUrl(trimmed);
  // Sending while offline is allowed for text/image_url — `onSend` queues the
  // message locally instead of failing (see lib/offlineQueue.ts). An
  // attachment message can't be queued the same way (it needs a completed
  // upload, which needs a live connection), so it requires being online.
  const canSend =
    contentType === "attachment"
      ? attachment !== null && !pending && isOnline
      : trimmed.length > 0 && !overLimit && !invalidImageUrl && !pending;

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
      await onSend(
        contentType === "attachment"
          ? {
              contentType,
              content: attachment!.filename,
              attachmentId: attachment!.id,
            }
          : { contentType, content: trimmed },
      );
      setContent("");
      setAttachment(null);
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
          <Button
            type="button"
            size="icon"
            variant={contentType === "attachment" ? "secondary" : "ghost"}
            aria-label="Attach a file"
            aria-pressed={contentType === "attachment"}
            onClick={() => setContentType("attachment")}
          >
            <Paperclip className="size-4" />
          </Button>
        </div>

        {contentType === "text" ? (
          <Textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => handleContentChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Write a message… (Enter to send, Shift+Enter for a new line)"
            rows={1}
            aria-invalid={overLimit}
            className="min-h-9 max-h-40 flex-1 resize-none py-2 transition-[height] duration-150 ease-smooth overflow-y-auto"
          />
        ) : contentType === "image_url" ? (
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
        ) : (
          <AttachmentUploadField
            attachment={attachment}
            onUploaded={setAttachment}
            onClear={() => setAttachment(null)}
            disabled={pending}
            className="flex-1"
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
          className="group/send shrink-0 transition-all duration-300 ease-spring active:scale-95"
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <SendHorizontal className="size-4 transition-transform duration-300 ease-spring group-hover/send:translate-x-0.5 group-hover/send:-translate-y-0.25 group-hover/send:scale-105" />
          )}
        </Button>
      </div>
      {invalidImageUrl && (
        <span className="self-end text-xs text-destructive">
          Must be an https:// link from a supported image host (e.g.
          picsum.photos, imgur.com, unsplash.com).
        </span>
      )}
      {!isOnline && contentType === "attachment" ? (
        <span className="self-end text-xs text-muted-foreground">
          You&apos;re offline — file attachments can&apos;t be queued and need a
          live connection to send.
        </span>
      ) : !isOnline ? (
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
