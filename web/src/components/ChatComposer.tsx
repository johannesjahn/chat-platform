import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import {
  ImageIcon,
  Loader2,
  Mic,
  Paperclip,
  Reply,
  SendHorizontal,
  Type,
  X,
} from "lucide-react";
import { AttachmentUploadField } from "@/components/AttachmentUploadField";
import { MentionTextarea } from "@/components/MentionTextarea";
import { VoiceRecorderField } from "@/components/VoiceRecorderField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

// Ceiling the auto-growing textarea stops at and starts scrolling instead —
// matches the `max-h-40` on the element itself, which is what actually clamps
// it visually; this keeps the measured height from overshooting that.
const MAX_TEXTAREA_HEIGHT_PX = 160;

// The message the composer is quoting a reply to (issue #217) — just what the
// reply banner needs to render; the id is threaded through to the send as
// `parentMessageId`.
export type ReplyTarget = {
  id: number;
  senderName: string;
  contentType: MessageContentType;
  content: string;
};

type ChatComposerProps = {
  chatId: number;
  onSend: (values: {
    contentType: MessageContentType;
    content: string;
    attachmentId?: number;
    parentMessageId?: number;
  }) => Promise<void>;
  // The message being replied to, or null when composing a normal message.
  replyingTo?: ReplyTarget | null;
  onCancelReply?: () => void;
};

function replyPreviewText(target: ReplyTarget): string {
  if (target.contentType === "image_url") return "📷 Photo";
  if (target.contentType === "attachment") return "📎 Attachment";
  return target.content;
}

// UI-level mode the composer is in — a superset of the backend's
// `MessageContentType`. "voice" has no backend counterpart: a voice message
// is sent as an ordinary `attachment`-type message (see submit() below), it
// just gets there via VoiceRecorderField's record-and-upload flow instead
// of AttachmentUploadField's pick-a-file flow.
type ComposerMode = MessageContentType | "voice";

// Both "attachment" and "voice" send as an uploaded-attachment message —
// they share the same `attachment` state and the same send gating below.
function usesAttachment(mode: ComposerMode): mode is "attachment" | "voice" {
  return mode === "attachment" || mode === "voice";
}

export function ChatComposer({
  chatId,
  onSend,
  replyingTo,
  onCancelReply,
}: ChatComposerProps) {
  const [contentType, setContentType] = useState<ComposerMode>("text");
  const [content, setContent] = useState("");
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [pending, setPending] = useState(false);
  // Set for the length of the send button's one-shot "plane takes off"
  // animation and cleared by its own `animationend` — a class that never
  // leaves the element can't be replayed on the next send.
  const [flying, setFlying] = useState(false);
  const lastTypingSentAtRef = useRef(0);
  const sendTyping = $api.useMutation("post", "/chats/{id}/typing");
  const isOnline = useOnlineStatus();

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Grow the textarea to fit what's been typed, up to MAX_TEXTAREA_HEIGHT_PX.
  useEffect(() => {
    if (contentType !== "text") return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    // An *empty* textarea still reports its wrapped placeholder's height in
    // `scrollHeight`, so measuring here sized the box to the hint text rather
    // than to the message: the composer sat two lines tall on desktop and
    // ~86px (five lines) tall on a 390px-wide phone before a single character
    // was typed. Clearing the inline height hands sizing back to the CSS
    // floor (`rows={1}` + `min-h-9`) until there's something real to measure.
    if (content === "") {
      textarea.style.height = "";
      return;
    }
    textarea.style.height = "auto";
    const newHeight = Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT_PX);
    textarea.style.height = `${newHeight}px`;
  }, [content, contentType]);

  // Starting a reply (from a bubble's Reply action) drops focus into the
  // composer so the user can start typing the reply straight away.
  useEffect(() => {
    if (replyingTo && contentType === "text") textareaRef.current?.focus();
  }, [replyingTo, contentType]);

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
  const canSend = usesAttachment(contentType)
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
    // Arm the send button's take-off. The plane is swapped for a spinner
    // while the request is in flight, so this plays the moment the button
    // comes back — which is exactly when there's a sent message to celebrate,
    // and is immediate for a send that never had to wait (a queued one).
    setFlying(true);
    setPending(true);
    try {
      // A reply quotes the message the parent passed as `replyingTo` — thread
      // its id through as `parentMessageId` so the send records the link.
      const parentMessageId = replyingTo?.id;
      await onSend(
        usesAttachment(contentType)
          ? {
              contentType: "attachment",
              content: attachment!.filename,
              attachmentId: attachment!.id,
              parentMessageId,
            }
          : { contentType, content: trimmed, parentMessageId },
      );
      setContent("");
      setAttachment(null);
      setContentType("text");
      lastTypingSentAtRef.current = 0;
      onCancelReply?.();
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
    // `pb-[calc(...)]` rather than `py-3`: with `viewport-fit=cover` the page
    // extends under the home indicator on a Home Screen install, and the
    // composer is the bottom-most thing in the layout — without the inset it
    // sits under the indicator, and since it's translucent
    // (`bg-card/70 backdrop-blur`) the messages it covers show *through* it
    // rather than being cleanly clipped. Resolves to `0.75rem` where `env()`
    // is 0, i.e. everywhere but a notched iOS device.
    <div className="flex flex-col gap-1.5 border-t border-border bg-card/70 px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur">
      {replyingTo && (
        <div className="flex items-center gap-2 rounded-md border-l-2 border-primary bg-muted/60 py-1.5 pl-2 pr-1 text-xs motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-200">
          <Reply className="size-3.5 shrink-0 text-primary" />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="font-semibold text-primary">
              Replying to {replyingTo.senderName}
            </span>
            <span className="truncate text-muted-foreground">
              {replyPreviewText(replyingTo)}
            </span>
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Cancel reply"
            className="size-6 shrink-0"
            onClick={onCancelReply}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      )}
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
          <Button
            type="button"
            size="icon"
            variant={contentType === "voice" ? "secondary" : "ghost"}
            aria-label="Voice message"
            aria-pressed={contentType === "voice"}
            onClick={() => setContentType("voice")}
          >
            <Mic className="size-4" />
          </Button>
        </div>

        {contentType === "text" ? (
          <MentionTextarea
            ref={textareaRef}
            value={content}
            onValueChange={handleContentChange}
            onKeyDown={handleKeyDown}
            // Four mode buttons and the send button leave the textarea about
            // 150px on a 390px-wide phone, which "Write a message…" wraps in
            // — and a one-row textarea just clips the second line, so it read
            // as "Write a ". This fits on one line at that width.
            placeholder="Message…"
            // The send/newline hint used to live in the placeholder, where a
            // narrow viewport clipped it to about "Write a mess…" anyway —
            // and it describes a physical keyboard, so it's desktop-only
            // advice to begin with. Keeping it as the accessible name
            // preserves exactly what a screen reader announced before (a
            // placeholder names an otherwise-unlabelled field), and `title`
            // surfaces it on hover where the keys actually exist.
            aria-label="Write a message (Enter to send, Shift+Enter for a new line)"
            title="Enter to send, Shift+Enter for a new line"
            rows={1}
            aria-invalid={overLimit}
            // `flex-1` moves to the wrapper the mention popup is positioned
            // against; the textarea itself fills it.
            containerClassName="flex-1"
            className="min-h-9 max-h-40 w-full resize-none py-2 transition-[height] duration-150 ease-smooth overflow-y-auto"
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
        ) : contentType === "attachment" ? (
          <AttachmentUploadField
            attachment={attachment}
            onUploaded={setAttachment}
            onClear={() => setAttachment(null)}
            disabled={pending}
            className="flex-1"
          />
        ) : (
          <VoiceRecorderField
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
            <SendHorizontal
              // The plane flies up and out on send, and the next one drops in
              // from the lower left (see `animate-send-off`). `flying` is
              // cleared on `animationEnd` so every later send replays it.
              onAnimationEnd={() => setFlying(false)}
              className={cn(
                "size-4 transition-transform duration-300 ease-spring group-hover/send:translate-x-0.5 group-hover/send:-translate-y-0.25 group-hover/send:scale-105",
                flying && "motion-safe:animate-send-off",
              )}
            />
          )}
        </Button>
      </div>
      {invalidImageUrl && (
        <span className="self-end text-xs text-destructive">
          Must be an https:// link from a supported image host (e.g.
          picsum.photos, imgur.com, unsplash.com).
        </span>
      )}
      {!isOnline && usesAttachment(contentType) ? (
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
