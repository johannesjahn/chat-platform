import { type ReactNode, useState } from "react";
import { Loader2, Paperclip, Type } from "lucide-react";
import { AttachmentUploadField } from "@/components/AttachmentUploadField";
import { MentionTextarea } from "@/components/MentionTextarea";
import { BackButton } from "@/components/BackButton";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import type { Attachment } from "@/lib/attachments";
import { errorMessage } from "@/lib/errors";
import { useOnlineStatus } from "@/lib/online";
import { MAX_POST_BODY_LENGTH } from "@/lib/posts";

// Structural placeholder shown while an existing post is being fetched for
// editing — mirrors PostForm's card/field layout so the form doesn't pop into
// existence once the post data arrives.
export function PostFormSkeleton() {
  return (
    <main className="mx-auto w-full max-w-xl px-4 py-10">
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-4 w-64" />
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-20" />
              <div className="flex gap-2">
                <Skeleton className="h-9 flex-1" />
                <Skeleton className="h-9 flex-1" />
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-24 w-full" />
            </div>
            <Skeleton className="h-9 w-full" />
          </div>
        </CardContent>
      </Card>
    </main>
  );
}

type PostFormProps = {
  title: string;
  description: string;
  submitLabel: string;
  initialBody?: string;
  initialAttachment?: Attachment | null;
  onSubmit: (values: { body: string; attachmentId?: number }) => Promise<void>;
  footer?: ReactNode;
  // Where "Back" goes when there's no in-app page to return to (a direct
  // load): a `<Link>` with an arrow and its label. See `BackButton`.
  backFallback: ReactNode;
  // Lets `onSubmit` be attempted while offline instead of being blocked —
  // set by callers that queue the mutation locally when offline (see
  // lib/offlineQueue.ts) rather than requiring a live connection. Off by
  // default: editing an existing post has no offline-queueing support (only
  // creation does, see routes/posts/new.tsx), so it keeps the original
  // "blocked while offline" behavior.
  allowOfflineQueue?: boolean;
};

export function PostForm({
  title,
  description,
  submitLabel,
  initialBody = "",
  initialAttachment = null,
  onSubmit,
  footer,
  backFallback,
  allowOfflineQueue = false,
}: PostFormProps) {
  const [withFile, setWithFile] = useState(initialAttachment !== null);
  const [body, setBody] = useState(initialBody);
  const [attachment, setAttachment] = useState<Attachment | null>(
    initialAttachment,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const isOnline = useOnlineStatus();

  const trimmed = body.trim();
  const overLimit = trimmed.length > MAX_POST_BODY_LENGTH;
  // An attachment post can't be offline-queued (see PostForm's caller,
  // routes/posts/new.tsx) — it needs an already-completed upload, which
  // needs a live connection — so it always requires being online.
  const canSubmit =
    !overLimit &&
    !pending &&
    (withFile
      ? attachment !== null && isOnline
      : trimmed.length > 0 && (isOnline || allowOfflineQueue));

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-10">
      {/* The way out on a phone, where there may be no browser back button
          (issue #907). */}
      <BackButton fallback={backFallback} />
      <Card className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
        <CardHeader>
          <CardTitle asChild>
            <h1>{title}</h1>
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <form
            className="flex flex-col gap-4"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!canSubmit) return;
              setError(null);
              setPending(true);
              try {
                await onSubmit({
                  body: trimmed,
                  attachmentId: withFile ? attachment?.id : undefined,
                });
              } catch (err) {
                setError(errorMessage(err));
              } finally {
                setPending(false);
              }
            }}
          >
            <div className="flex flex-col gap-2">
              <Label>Post type</Label>
              <div role="group" aria-label="Post type" className="flex gap-2">
                <Button
                  type="button"
                  variant={!withFile ? "default" : "outline"}
                  aria-pressed={!withFile}
                  onClick={() => setWithFile(false)}
                  className="flex-1"
                >
                  <Type className="size-4" />
                  Text
                </Button>
                <Button
                  type="button"
                  variant={withFile ? "default" : "outline"}
                  aria-pressed={withFile}
                  onClick={() => setWithFile(true)}
                  className="flex-1"
                >
                  <Paperclip className="size-4" />
                  File
                </Button>
              </div>
            </div>

            {withFile && (
              <div className="flex flex-col gap-2">
                <Label>File</Label>
                <AttachmentUploadField
                  attachment={attachment}
                  onUploaded={setAttachment}
                  onClear={() => setAttachment(null)}
                  disabled={pending}
                />
                {!isOnline && (
                  <p className="text-xs text-muted-foreground">
                    You&apos;re offline — file attachments need a live
                    connection to upload and send.
                  </p>
                )}
              </div>
            )}
            <div className="flex flex-col gap-2">
              <Label htmlFor="content">
                {withFile ? "Caption (optional)" : "Text"}
              </Label>
              <MentionTextarea
                id="content"
                value={body}
                onValueChange={setBody}
                placeholder={
                  withFile ? "Say something about it…" : "What's on your mind?"
                }
                rows={withFile ? 3 : 6}
                required={!withFile}
                aria-invalid={overLimit}
              />
              <span
                className={
                  overLimit
                    ? "self-end text-xs text-destructive"
                    : "self-end text-xs text-muted-foreground"
                }
              >
                {trimmed.length}/{MAX_POST_BODY_LENGTH}
              </span>
            </div>

            <Button type="submit" className="mt-1 w-full" disabled={!canSubmit}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              {!isOnline
                ? allowOfflineQueue && !withFile
                  ? "Queue for sending"
                  : "You're offline"
                : pending
                  ? "Please wait…"
                  : submitLabel}
            </Button>
            {!isOnline && allowOfflineQueue && !withFile && (
              <p className="-mt-2 self-end text-xs text-muted-foreground">
                You&apos;re offline — this will be queued and posted once
                you&apos;re back online.
              </p>
            )}
          </form>
        </CardContent>
        {footer && (
          <CardFooter>
            <p className="text-sm text-muted-foreground">{footer}</p>
          </CardFooter>
        )}
      </Card>
    </main>
  );
}
