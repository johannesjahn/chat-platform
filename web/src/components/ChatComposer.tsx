import {
  type ChangeEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ImageIcon,
  Loader2,
  Mic,
  Paperclip,
  Reply,
  SendHorizontal,
  X,
} from "lucide-react";
import { AttachmentUploadField } from "@/components/AttachmentUploadField";
import { ComposerAttachMenu } from "@/components/ComposerAttachMenu";
import { MentionTextarea } from "@/components/MentionTextarea";
import { VoiceRecorderField } from "@/components/VoiceRecorderField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { $api } from "@/lib/api";
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  type Attachment,
} from "@/lib/attachments";
import { isAllowedImageUrl } from "@/lib/imageHosts";
import { useOnlineStatus } from "@/lib/online";
import { cn } from "@/lib/utils";
import { canRecordVoice } from "@/lib/voice";
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

// Lines of text the field grows to before it stops growing and scrolls
// instead. Measured in *lines* rather than pixels because the composer's
// text is `text-base` on a phone and `md:text-sm` on a desktop — a pixel
// ceiling would mean a different number of visible lines per breakpoint,
// and the whole point of the rule is that the third line is where scrolling
// starts, everywhere.
const MAX_VISIBLE_LINES = 3;

// The pixel height MAX_VISIBLE_LINES works out to for *this* field, read off
// its own computed style (Tailwind sets an explicit `line-height`, so this
// follows the breakpoint). `box-sizing: border-box` is Tailwind's default,
// so the padding and borders belong in the height.
function maxComposerHeight(textarea: HTMLTextAreaElement): number {
  const styles = getComputedStyle(textarea);
  const lineHeight = parseFloat(styles.lineHeight);
  const line = Number.isFinite(lineHeight)
    ? lineHeight
    : // `line-height: normal` computes to the keyword rather than a length;
      // 1.5em is what the composer's type scale resolves to anyway.
      parseFloat(styles.fontSize) * 1.5;
  const frame =
    parseFloat(styles.paddingTop) +
    parseFloat(styles.paddingBottom) +
    parseFloat(styles.borderTopWidth) +
    parseFloat(styles.borderBottomWidth);
  return line * MAX_VISIBLE_LINES + frame;
}

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

// What the trigger that opened a mode says once you're in it, since there it
// backs out of that mode instead of opening the sheet.
function cancelLabelFor(mode: ComposerMode): string {
  if (mode === "image_url") return "Cancel photo link";
  if (mode === "voice") return "Cancel voice message";
  return "Cancel attachment";
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
  // The file chosen through the attach sheet's own hidden `<input>` — the
  // sheet opens the OS picker itself (that's the second of the two taps), so
  // the upload field is handed a file that's already been chosen rather than
  // rendering a drop zone for one.
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const [pending, setPending] = useState(false);
  // Set for the length of the send button's one-shot "plane takes off"
  // animation and cleared by its own `animationend` — a class that never
  // leaves the element can't be replayed on the next send.
  const [flying, setFlying] = useState(false);
  const lastTypingSentAtRef = useRef(0);
  const sendTyping = $api.useMutation("post", "/chats/{id}/typing");
  const isOnline = useOnlineStatus();

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Grow the textarea to fit what's been typed, up to MAX_VISIBLE_LINES.
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
      textarea.style.overflowY = "hidden";
      return;
    }
    textarea.style.height = "auto";
    const max = maxComposerHeight(textarea);
    textarea.style.height = `${Math.min(textarea.scrollHeight, max)}px`;
    // A scrollbar only belongs on a field that has actually hit the ceiling.
    // Below it the box is exactly as tall as its content, and `overflow-y:
    // auto` would still reserve — and on some platforms paint — a gutter for
    // a bar that can never scroll: the scrollbar on the one-line composer
    // that prompted this redesign. A pixel of tolerance, because the measured
    // content height of an exactly-full field can land a hair over the
    // computed ceiling through subpixel rounding.
    textarea.style.overflowY =
      textarea.scrollHeight > max + 1 ? "auto" : "hidden";
  }, [content, contentType]);

  // Starting a reply (from a bubble's Reply action) drops focus into the
  // composer so the user can start typing the reply straight away.
  useEffect(() => {
    if (replyingTo && contentType === "text") textareaRef.current?.focus();
  }, [replyingTo, contentType]);

  // Switching modes moves focus to whatever the new mode is asking for, so
  // picking "Photo" out of the attach sheet leaves the caret in the link
  // field and backing out of a mode leaves it back in the message field.
  // The field being focused only exists after the render that switched the
  // mode, so the switch flags what to focus and this picks it up afterwards.
  // A flag set by an interaction (rather than an effect keyed on the mode) is
  // also what keeps the composer from grabbing focus — and on a phone,
  // opening the keyboard — just because a chat was opened.
  // A message typed but not sent, parked while the photo-link field has
  // `content` (the two share it), so backing out of a photo link doesn't
  // throw the draft away.
  const textDraftRef = useRef("");
  const focusAfterRenderRef = useRef<"message" | "link" | null>(null);
  useEffect(() => {
    const target = focusAfterRenderRef.current;
    if (!target) return;
    focusAfterRenderRef.current = null;
    if (target === "message") textareaRef.current?.focus();
    else urlInputRef.current?.focus();
  });

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

  // With nothing typed there's nothing to send, so the trailing button is a
  // microphone instead — the arrangement every chat app has settled on, and
  // the reason voice isn't a row in the attach sheet. It needs a live
  // connection (a clip uploads the moment it stops recording, and an
  // attachment can't be queued offline) and a browser that can record.
  const showMic =
    contentType === "text" &&
    trimmed.length === 0 &&
    !pending &&
    isOnline &&
    canRecordVoice();

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

  // Back to a plain text message, dropping whatever the abandoned mode had
  // in flight and handing back the half-written message the photo-link field
  // was borrowing `content` from.
  function resetToText() {
    focusAfterRenderRef.current = "message";
    if (contentType === "image_url") {
      setContent(textDraftRef.current);
      textDraftRef.current = "";
    }
    setContentType("text");
    setAttachment(null);
    setPickedFile(null);
  }

  function handleFilePicked(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    // Clearing the input means picking the *same* file again still fires a
    // change event later on.
    event.target.value = "";
    if (!file) return;
    setPickedFile(file);
    setContentType("attachment");
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
      textDraftRef.current = "";
      setAttachment(null);
      setPickedFile(null);
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

  // The rounded field the text (or the photo URL) sits in — one surface the
  // whole row is built around, which is what makes a chat composer read as a
  // composer rather than as a form control with buttons either side of it.
  const fieldClassName = cn(
    "flex min-w-0 flex-1 items-end rounded-3xl border border-input bg-background px-3 py-1 shadow-sm transition-[border-color,box-shadow] duration-200",
    "focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
    (overLimit || invalidImageUrl) &&
      "border-destructive focus-within:border-destructive focus-within:ring-destructive/30",
  );

  return (
    // `pb-[calc(...)]` rather than `py-3`: with `viewport-fit=cover` the page
    // extends under the home indicator on a Home Screen install, and the
    // composer is the bottom-most thing in the layout — without the inset it
    // sits under the indicator, and since it's translucent
    // (`bg-card/70 backdrop-blur`) the messages it covers show *through* it
    // rather than being cleanly clipped. Resolves to `0.75rem` where `env()`
    // is 0, i.e. everywhere but a notched iOS device.
    <div className="flex flex-col gap-1.5 border-t border-border bg-card/70 px-3 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur sm:px-4">
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
      <div className="flex items-end gap-1.5">
        <ComposerAttachMenu
          disabled={pending}
          active={contentType !== "text"}
          activeLabel={cancelLabelFor(contentType)}
          onCancel={resetToText}
          actions={[
            {
              key: "photo",
              label: "Photo",
              description: "Share a link to an image",
              icon: <ImageIcon className="size-4" />,
              onSelect: () => {
                textDraftRef.current = content;
                setContent("");
                focusAfterRenderRef.current = "link";
                setContentType("image_url");
              },
            },
            {
              key: "file",
              label: "File",
              description: "Image, video or audio",
              // Straight to the OS picker: opening it here is what keeps a
              // file upload at two taps.
              icon: <Paperclip className="size-4" />,
              onSelect: () => fileInputRef.current?.click(),
            },
          ]}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept={ALLOWED_ATTACHMENT_MIME_TYPES.join(",")}
          className="hidden"
          onChange={handleFilePicked}
        />

        {contentType === "text" ? (
          <div className={fieldClassName}>
            <MentionTextarea
              ref={textareaRef}
              value={content}
              onValueChange={handleContentChange}
              onKeyDown={handleKeyDown}
              // One collapsed attach button and one send button leave the
              // field the rest of a 390px-wide phone, but "Write a message…"
              // still wrapped in it — and a one-row textarea just clips the
              // second line, so it read as "Write a ". This fits on one line
              // at that width.
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
              containerClassName="min-w-0 flex-1"
              // The field's frame lives on the wrapper above, so the textarea
              // itself is a bare, transparent text surface inside it.
              // `overflow` is the starting point only — the auto-grow effect
              // above switches it to `auto` inline once the text passes
              // MAX_VISIBLE_LINES.
              className="min-h-9 w-full resize-none overflow-hidden border-0 bg-transparent px-0 py-1.5 shadow-none transition-[height] duration-150 ease-smooth focus-visible:ring-0"
            />
          </div>
        ) : contentType === "image_url" ? (
          <div className={fieldClassName}>
            <ImageIcon className="mb-2.5 size-4 shrink-0 text-muted-foreground" />
            <Input
              ref={urlInputRef}
              type="url"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                }
                if (e.key === "Escape") resetToText();
              }}
              placeholder="https://picsum.photos/id/1/600/800"
              aria-label="Image link"
              aria-invalid={invalidImageUrl}
              className="h-9 min-w-0 flex-1 border-0 bg-transparent px-2 shadow-none focus-visible:ring-0"
            />
          </div>
        ) : contentType === "attachment" ? (
          <AttachmentUploadField
            attachment={attachment}
            pendingFile={pickedFile}
            onUploaded={setAttachment}
            // Dropping the file drops the mode with it — there's nothing left
            // to send as an attachment, so the composer goes back to text
            // rather than sitting on an empty drop zone.
            onClear={resetToText}
            disabled={pending}
            // The rounder corners the rest of the row now has — the field's
            // own `rounded-lg` would read as a different surface sitting in
            // the same row as the message pill.
            className="min-w-0 flex-1 rounded-2xl"
          />
        ) : (
          <VoiceRecorderField
            attachment={attachment}
            // The mic button *is* the "start recording" tap; making the user
            // tap a second target inside the composer would be one too many.
            autoStart
            onUploaded={setAttachment}
            onClear={resetToText}
            onCancel={resetToText}
            disabled={pending}
            className="min-w-0 flex-1 rounded-2xl"
          />
        )}

        {showMic ? (
          <Button
            type="button"
            size="icon"
            aria-label="Record a voice message"
            onClick={() => setContentType("voice")}
            className="size-10 shrink-0 rounded-full transition-all duration-300 ease-spring active:scale-95"
          >
            {/* Keyed so the swap between the two trailing actions plays the
                spring entrance rather than silently exchanging glyphs. */}
            <span
              key="mic"
              className="inline-flex motion-safe:animate-pop-open"
            >
              <Mic className="size-4" />
            </span>
          </Button>
        ) : (
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
            className="group/send size-10 shrink-0 rounded-full transition-all duration-300 ease-spring active:scale-95"
          >
            <span
              key="send"
              className="inline-flex motion-safe:animate-pop-open"
            >
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <SendHorizontal
                  // The plane flies up and out on send, and the next one drops
                  // in from the lower left (see `animate-send-off`). `flying`
                  // is cleared on `animationEnd` so every later send replays
                  // it.
                  onAnimationEnd={() => setFlying(false)}
                  className={cn(
                    "size-4 transition-transform duration-300 ease-spring group-hover/send:translate-x-0.5 group-hover/send:-translate-y-0.25 group-hover/send:scale-105",
                    flying && "motion-safe:animate-send-off",
                  )}
                />
              )}
            </span>
          </Button>
        )}
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
