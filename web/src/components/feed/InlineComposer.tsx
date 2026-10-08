import {
  type ClipboardEvent,
  type DragEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { Loader2, Paperclip, SendHorizontal } from "lucide-react";
import { AttachmentUploadField } from "@/components/AttachmentUploadField";
import { Avatar } from "@/components/Avatar";
import { MentionTextarea } from "@/components/MentionTextarea";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import type { Session } from "@/lib/api";
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  type Attachment,
} from "@/lib/attachments";
import { useCreatePost } from "@/lib/createPost";
import { errorMessage } from "@/lib/errors";
import { useOnlineStatus } from "@/lib/online";
import { MAX_POST_CONTENT_LENGTH } from "@/lib/posts";
import { userAvatarName } from "@/lib/users";
import { cn } from "@/lib/utils";

/**
 * The feed's inline composer (issue #554), desktop only: a one-line "What's
 * on your mind?" at the top of the feed that expands in place on focus, so
 * posting doesn't mean leaving for `/posts/new`. Text with an optional file
 * — picked, pasted from the clipboard, or dropped anywhere on the composer.
 * Image-link posts stay on the full form.
 */
export function InlineComposer({ session }: { session: Session }) {
  const createPost = useCreatePost();
  const isOnline = useOnlineStatus();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const trimmed = text.trim();
  const hasFile = file !== null || attachment !== null;
  const overLimit = trimmed.length > MAX_POST_CONTENT_LENGTH;
  // A file post needs its upload finished (and so a connection); a text
  // post can be queued offline.
  const canPost = hasFile
    ? attachment !== null && isOnline && !pending
    : trimmed.length > 0 && !overLimit && !pending;

  // Collapses again when focus and the pointer leave an untouched composer.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      if (trimmed === "" && !hasFile && !pending) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, trimmed, hasFile, pending]);

  function attach(next: File) {
    setAttachment(null);
    setFile(next);
    setFileKey((key) => key + 1);
    setOpen(true);
  }

  function clearFile() {
    setFile(null);
    setAttachment(null);
  }

  function reset() {
    setText("");
    clearFile();
    setError(null);
    setOpen(false);
  }

  async function submit() {
    if (!canPost) return;
    setPending(true);
    setError(null);
    try {
      // A file post's text isn't sent — posts are one kind each (text, an
      // image link, or a file), so with a file attached it's the file.
      await createPost(
        attachment
          ? {
              contentType: "attachment",
              content: attachment.filename,
              attachmentId: attachment.id,
            }
          : { contentType: "text", content: trimmed },
      );
      reset();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = event.clipboardData.files[0];
    if (!pasted) return;
    event.preventDefault();
    attach(pasted);
  }

  const draggingFiles = (event: DragEvent) =>
    event.dataTransfer.types.includes("Files");

  return (
    <div
      ref={rootRef}
      className={cn(
        "relative hidden w-full rounded-xl border border-border/60 bg-card/65 p-4 shadow-sm backdrop-blur-md transition-colors lg:block",
        open && "border-primary/30",
        dragging && "border-primary border-dashed",
      )}
      onDragOver={(e) => {
        if (!draggingFiles(e)) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!rootRef.current?.contains(e.relatedTarget as Node | null)) {
          setDragging(false);
        }
      }}
      onDrop={(e) => {
        if (!draggingFiles(e)) return;
        e.preventDefault();
        setDragging(false);
        const dropped = e.dataTransfer.files[0];
        if (dropped) attach(dropped);
      }}
    >
      <div className="flex items-start gap-3">
        <Avatar
          name={userAvatarName(session.user)}
          avatarUrl={session.user.avatarUrl}
          avatarVariants={session.user.avatarVariants}
        />
        <MentionTextarea
          ref={textareaRef}
          value={text}
          onValueChange={setText}
          onFocus={() => setOpen(true)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape" && trimmed === "" && !hasFile) {
              e.currentTarget.blur();
              setOpen(false);
            }
          }}
          placeholder="What's on your mind?"
          aria-label="Write a post"
          rows={open ? 3 : 1}
          aria-invalid={overLimit}
          containerClassName="min-w-0 flex-1"
          className="min-h-9 w-full resize-none border-0 bg-transparent px-0 py-1.5 text-base shadow-none focus-visible:ring-0"
        />
      </div>
      <Collapse open={open}>
        <div className="flex flex-col gap-3 pt-3">
          {hasFile && trimmed !== "" && (
            <p className="text-xs text-muted-foreground">
              A post is one thing — with a file attached, the file is what gets
              posted. Remove it to post your text instead.
            </p>
          )}
          {hasFile && (
            <AttachmentUploadField
              key={fileKey}
              attachment={attachment}
              pendingFile={file}
              onUploaded={setAttachment}
              onClear={clearFile}
              disabled={pending}
            />
          )}
          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex items-center gap-2 border-t border-border pt-3">
            <input
              ref={fileInputRef}
              type="file"
              accept={ALLOWED_ATTACHMENT_MIME_TYPES.join(",")}
              className="hidden"
              onChange={(e) => {
                const picked = e.target.files?.[0];
                e.target.value = "";
                if (picked) attach(picked);
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip className="size-4" />
              Attach
            </Button>
            <span className="text-xs text-muted-foreground">
              or paste / drop a file
            </span>
            <span
              className={cn(
                "ml-auto text-xs tabular-nums",
                overLimit ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {trimmed.length > MAX_POST_CONTENT_LENGTH * 0.8 &&
                `${trimmed.length}/${MAX_POST_CONTENT_LENGTH}`}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={reset}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!canPost}
              onClick={() => void submit()}
              title="Ctrl/⌘+Enter"
            >
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <SendHorizontal className="size-4" />
              )}
              {!isOnline && !hasFile ? "Queue post" : "Post"}
            </Button>
          </div>
        </div>
      </Collapse>
    </div>
  );
}
