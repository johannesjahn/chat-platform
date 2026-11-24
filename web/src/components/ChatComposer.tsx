import {
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  type Ref,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Mic, Plus, Reply, SendHorizontal, X } from "lucide-react";
import { AttachmentUploadField } from "@/components/AttachmentUploadField";
import { MentionTextarea } from "@/components/MentionTextarea";
import { VoiceRecorderField } from "@/components/VoiceRecorderField";
import { Button } from "@/components/ui/button";
import { $api } from "@/lib/api";
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  type Attachment,
} from "@/lib/attachments";
import { isImeComposing } from "@/lib/ime";
import { useIsCoarsePointer } from "@/lib/media";
import { useOnlineStatus } from "@/lib/online";
import { cn } from "@/lib/utils";
import { canRecordVoice } from "@/lib/voice";
import { MAX_MESSAGE_BODY_LENGTH, parentPreviewText } from "@/lib/chats";

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
  body: string;
  hasAttachment: boolean;
};

// What the conversation around the composer can ask of it: a file dropped
// anywhere on the thread (issue #554) goes in as the message's attachment,
// and focus comes back here once an edit started from `↑` is done.
export type ChatComposerHandle = {
  attachFile: (file: File) => void;
  focus: () => void;
};

type ChatComposerProps = {
  ref?: Ref<ChatComposerHandle>;
  chatId: number;
  // Fire-and-forget: the conversation shows the message straight away and
  // sends it in the background (lib/outbox.ts), so the composer clears and
  // takes the next message without waiting on the request.
  onSend: (values: {
    body: string;
    attachmentId?: number;
    // The uploaded file itself, so the "sending" bubble can preview it.
    attachment?: Attachment;
    parentMessageId?: number;
  }) => void;
  // The message being replied to, or null when composing a normal message.
  replyingTo?: ReplyTarget | null;
  onCancelReply?: () => void;
  // `↑` in an empty composer: edit your last message (issue #554).
  onEditLast?: () => void;
  // Put the caret in the message field as soon as the composer mounts — the
  // desktop two-pane view, where opening a chat means you're about to type.
  // Off by default because on a phone it would throw the keyboard up over a
  // conversation you may only have opened to read.
  autoFocus?: boolean;
};

// A voice message is sent as an ordinary attachment (see submit() below); it
// just gets there via VoiceRecorderField's record-and-upload flow instead of
// AttachmentUploadField's pick-a-file flow.
type ComposerMode = "text" | "attachment" | "voice";

// What the attach button says once you're in a mode, since there it backs out
// of that mode instead of opening the file picker.
function cancelLabelFor(mode: ComposerMode): string {
  if (mode === "voice") return "Cancel voice message";
  return "Cancel attachment";
}

export function ChatComposer({
  ref,
  chatId,
  onSend,
  replyingTo,
  onCancelReply,
  onEditLast,
  autoFocus = false,
}: ChatComposerProps) {
  const [mode, setMode] = useState<ComposerMode>("text");
  const [body, setBody] = useState("");
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  // The file chosen through the attach button's own hidden `<input>`, so
  // the upload field is handed a file that's already been chosen rather than
  // rendering a drop zone for one.
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  // Bumped per handed-in file, remounting the upload field so a new file
  // replaces the old one outright instead of racing its upload.
  const [pickedFileKey, setPickedFileKey] = useState(0);
  // Set for the length of the send button's one-shot "plane takes off"
  // animation and cleared by its own `animationend` — a class that never
  // leaves the element can't be replayed on the next send.
  const [flying, setFlying] = useState(false);
  const lastTypingSentAtRef = useRef(0);
  const sendTyping = $api.useMutation("post", "/chats/{id}/typing");
  const isOnline = useOnlineStatus();
  // On a touch device the on-screen keyboard has no Shift+Enter, so a return
  // that sent would leave no way to write a second line (issue #760): there
  // Enter is a newline, like in every mobile chat app, and the send button
  // sends. Ctrl/⌘+Enter still sends, for a tablet with a keyboard attached.
  const enterInsertsNewline = useIsCoarsePointer();

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Grow the textarea to fit what's been typed, up to MAX_VISIBLE_LINES —
  // the message field, or an attachment's caption field.
  useEffect(() => {
    if (mode !== "text" && mode !== "attachment") return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    // An *empty* textarea still reports its wrapped placeholder's height in
    // `scrollHeight`, so measuring here sized the box to the hint text rather
    // than to the message: the composer sat two lines tall on desktop and
    // ~86px (five lines) tall on a 390px-wide phone before a single character
    // was typed. Clearing the inline height hands sizing back to the CSS
    // floor (`rows={1}` + `min-h-9`) until there's something real to measure.
    if (body === "") {
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
  }, [body, mode]);

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
    // Only on mount: it's "focus when the chat opens", not "keep focus".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Starting a reply (from a bubble's Reply action) drops focus into the
  // composer so the user can start typing the reply straight away.
  useEffect(() => {
    if (replyingTo && mode === "text") textareaRef.current?.focus();
  }, [replyingTo, mode]);

  // Backing out of a mode leaves the caret back in the message field.
  // The field being focused only exists after the render that switched the
  // mode, so the switch flags what to focus and this picks it up afterwards.
  // A flag set by an interaction (rather than an effect keyed on the mode) is
  // also what keeps the composer from grabbing focus — and on a phone,
  // opening the keyboard — just because a chat was opened.
  const focusAfterRenderRef = useRef(false);
  useEffect(() => {
    if (!focusAfterRenderRef.current) return;
    focusAfterRenderRef.current = false;
    textareaRef.current?.focus();
  });

  const trimmed = body.trim();
  const overLimit = trimmed.length > MAX_MESSAGE_BODY_LENGTH;
  const nearLimit = trimmed.length > MAX_MESSAGE_BODY_LENGTH * 0.9;
  // Both "attachment" and "voice" send as an uploaded attachment: they share
  // the same `attachment` state and the same send gating below.
  const usesAttachment = mode !== "text";
  // Sending while offline is allowed for text — `onSend` queues the
  // message locally instead of failing (see lib/offlineQueue.ts). An
  // attachment message can't be queued the same way (it needs a completed
  // upload, which needs a live connection), so it requires being online. A
  // file's caption (issue #765) is held to the same length as a message.
  const canSend = usesAttachment
    ? attachment !== null && isOnline && !overLimit
    : trimmed.length > 0 && !overLimit;

  // With nothing typed there's nothing to send, so the trailing button is a
  // microphone instead — the arrangement every chat app has settled on, and
  // the reason voice isn't behind the attach button. It needs a live
  // connection (a clip uploads the moment it stops recording, and an
  // attachment can't be queued offline) and a browser that can record.
  const showMic =
    mode === "text" && trimmed.length === 0 && isOnline && canRecordVoice();

  function notifyTyping() {
    const now = Date.now();
    if (now - lastTypingSentAtRef.current < TYPING_THROTTLE_MS) return;
    lastTypingSentAtRef.current = now;
    sendTyping.mutate({ params: { path: { id: String(chatId) } } });
  }

  function handleBodyChange(value: string) {
    setBody(value);
    if (value.trim().length > 0) notifyTyping();
  }

  // Back to a plain text message, dropping whatever the abandoned mode had
  // in flight but keeping the text.
  function resetToText() {
    focusAfterRenderRef.current = true;
    setMode("text");
    setAttachment(null);
    setPickedFile(null);
  }

  // Hands a file to the upload field the same way the attach button's picker
  // does — from a paste, or a drop anywhere on the conversation. A recording
  // is never thrown away by a stray drop.
  function attachFile(file: File) {
    if (mode === "voice") return;
    setAttachment(null);
    setPickedFile(file);
    setPickedFileKey((key) => key + 1);
    setMode("attachment");
  }

  useImperativeHandle(ref, () => ({
    attachFile,
    focus: () => textareaRef.current?.focus(),
  }));

  function handleFilePicked(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    // Clearing the input means picking the *same* file again still fires a
    // change event later on.
    event.target.value = "";
    if (!file) return;
    attachFile(file);
  }

  // A pasted image or file (a screenshot straight from the clipboard,
  // issue #554) becomes the attachment; pasted text stays text.
  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const file = event.clipboardData.files[0];
    if (!file) return;
    event.preventDefault();
    attachFile(file);
  }

  function submit() {
    if (!canSend) return;
    // Arm the send button's take-off — it plays right away, as the message
    // drops into the thread.
    setFlying(true);
    // A reply quotes the message the parent passed as `replyingTo` — thread
    // its id through as `parentMessageId` so the send records the link.
    const parentMessageId = replyingTo?.id;
    onSend({
      body: mode === "voice" ? "" : trimmed,
      ...(usesAttachment
        ? { attachmentId: attachment!.id, attachment: attachment! }
        : {}),
      parentMessageId,
    });
    setBody("");
    setAttachment(null);
    setPickedFile(null);
    setMode("text");
    lastTypingSentAtRef.current = 0;
    onCancelReply?.();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Mid-composition keys (Enter confirming an IME's text, …) are the
    // IME's, not ours (issue #759).
    if (isImeComposing(event)) return;
    if (event.key === "Enter" && !event.shiftKey) {
      if (enterInsertsNewline && !event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      submit();
    } else if (event.key === "Escape" && replyingTo) {
      event.preventDefault();
      onCancelReply?.();
    } else if (
      event.key === "ArrowUp" &&
      body === "" &&
      !replyingTo &&
      !event.shiftKey &&
      !event.altKey &&
      onEditLast
    ) {
      event.preventDefault();
      onEditLast();
    }
  }

  // The rounded field the text sits in — one surface the whole row is built
  // around, which is what makes a chat composer read as a composer rather than
  // as a form control with buttons either side of it.
  const fieldClassName = cn(
    "flex min-w-0 flex-1 items-end rounded-3xl border border-input bg-background px-3 py-1 shadow-sm transition-[border-color,box-shadow] duration-200",
    "focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
    overLimit &&
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
              {parentPreviewText(replyingTo)}
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
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={mode === "text" ? "Attach" : cancelLabelFor(mode)}
          onClick={() => {
            if (mode === "text") fileInputRef.current?.click();
            else resetToText();
          }}
          className="size-10 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
        >
          <Plus
            // In a mode, the plus turns into a close cross: one glyph, two
            // meanings, and the rotation is what tells you which.
            className={cn(
              "size-5 transition-transform duration-300 ease-spring",
              mode !== "text" && "rotate-45",
            )}
          />
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept={ALLOWED_ATTACHMENT_MIME_TYPES.join(",")}
          className="hidden"
          onChange={handleFilePicked}
        />

        {mode === "text" ? (
          <div className={fieldClassName}>
            <MentionTextarea
              ref={textareaRef}
              value={body}
              onValueChange={handleBodyChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
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
              // On a touch device it describes what return does there instead
              // (issue #760), and the keyboard's return key reads accordingly.
              aria-label={
                enterInsertsNewline
                  ? "Write a message (Enter for a new line)"
                  : "Write a message (Enter to send, Shift+Enter for a new line)"
              }
              title={
                enterInsertsNewline
                  ? undefined
                  : "Enter to send, Shift+Enter for a new line"
              }
              enterKeyHint={enterInsertsNewline ? "enter" : "send"}
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
        ) : mode === "attachment" ? (
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <AttachmentUploadField
              key={pickedFileKey}
              attachment={attachment}
              pendingFile={pickedFile}
              onUploaded={setAttachment}
              // Dropping the file drops the mode with it — there's nothing
              // left to send as an attachment, so the composer goes back to
              // text (keeping the caption as the message) rather than sitting
              // on an empty drop zone.
              onClear={resetToText}
              // The rounder corners the rest of the row now has — the
              // field's own `rounded-lg` would read as a different surface
              // sitting in the same row as the message pill.
              className="rounded-2xl"
            />
            {/* The message field carries on as the file's caption (issue
                #765): what was typed before attaching stays, and is sent
                with it. */}
            <div className={fieldClassName}>
              <MentionTextarea
                ref={textareaRef}
                value={body}
                onValueChange={handleBodyChange}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder="Add a caption…"
                aria-label="Caption"
                enterKeyHint={enterInsertsNewline ? "enter" : "send"}
                rows={1}
                aria-invalid={overLimit}
                containerClassName="min-w-0 flex-1"
                className="min-h-9 w-full resize-none overflow-hidden border-0 bg-transparent px-0 py-1.5 shadow-none transition-[height] duration-150 ease-smooth focus-visible:ring-0"
              />
            </div>
          </div>
        ) : (
          <VoiceRecorderField
            attachment={attachment}
            // The mic button *is* the "start recording" tap; making the user
            // tap a second target inside the composer would be one too many.
            autoStart
            onUploaded={setAttachment}
            onCancel={resetToText}
            className="min-w-0 flex-1 rounded-2xl"
          />
        )}

        {showMic ? (
          <Button
            type="button"
            size="icon"
            aria-label="Record a voice message"
            onClick={() => setMode("voice")}
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
            onClick={submit}
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
            </span>
          </Button>
        )}
      </div>
      {!isOnline && usesAttachment ? (
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
            {trimmed.length}/{MAX_MESSAGE_BODY_LENGTH}
          </span>
        )
      )}
    </div>
  );
}
