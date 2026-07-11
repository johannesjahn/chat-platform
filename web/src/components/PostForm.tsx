import { type ReactNode, useState } from "react";
import { ImageIcon, Loader2, Type } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/errors";
import { isAllowedImageUrl } from "@/lib/imageHosts";
import { useOnlineStatus } from "@/lib/online";
import { MAX_POST_CONTENT_LENGTH, type PostContentType } from "@/lib/posts";

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
  initialContentType?: PostContentType;
  initialContent?: string;
  onSubmit: (values: {
    contentType: PostContentType;
    content: string;
  }) => Promise<void>;
  footer?: ReactNode;
};

export function PostForm({
  title,
  description,
  submitLabel,
  initialContentType = "text",
  initialContent = "",
  onSubmit,
  footer,
}: PostFormProps) {
  const [contentType, setContentType] =
    useState<PostContentType>(initialContentType);
  const [content, setContent] = useState(initialContent);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const isOnline = useOnlineStatus();

  const trimmed = content.trim();
  const overLimit = trimmed.length > MAX_POST_CONTENT_LENGTH;
  const invalidImageUrl =
    contentType === "image_url" &&
    trimmed.length > 0 &&
    !isAllowedImageUrl(trimmed);
  const canSubmit =
    trimmed.length > 0 &&
    !overLimit &&
    !invalidImageUrl &&
    !pending &&
    isOnline;

  return (
    <main className="mx-auto w-full max-w-xl px-4 py-10">
      <Card className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
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
                await onSubmit({ contentType, content: trimmed });
              } catch (err) {
                setError(errorMessage(err));
              } finally {
                setPending(false);
              }
            }}
          >
            <div className="flex flex-col gap-2">
              <Label>Post type</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={contentType === "text" ? "default" : "outline"}
                  onClick={() => setContentType("text")}
                  className="flex-1"
                >
                  <Type className="size-4" />
                  Text
                </Button>
                <Button
                  type="button"
                  variant={contentType === "image_url" ? "default" : "outline"}
                  onClick={() => setContentType("image_url")}
                  className="flex-1"
                >
                  <ImageIcon className="size-4" />
                  Image URL
                </Button>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="content">
                {contentType === "text" ? "Text" : "Image URL"}
              </Label>
              {contentType === "text" ? (
                <Textarea
                  id="content"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="What's on your mind?"
                  rows={6}
                  required
                  aria-invalid={overLimit}
                />
              ) : (
                <Input
                  id="content"
                  type="url"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="https://picsum.photos/id/1/600/800"
                  required
                  aria-invalid={invalidImageUrl}
                />
              )}
              {invalidImageUrl && (
                <p className="text-xs text-destructive">
                  Image URLs must be https:// links from a supported image host
                  (e.g. picsum.photos, imgur.com, unsplash.com).
                </p>
              )}
              <span
                className={
                  overLimit
                    ? "self-end text-xs text-destructive"
                    : "self-end text-xs text-muted-foreground"
                }
              >
                {trimmed.length}/{MAX_POST_CONTENT_LENGTH}
              </span>
              {contentType === "image_url" &&
                trimmed &&
                !overLimit &&
                !invalidImageUrl && (
                  <img
                    // Re-parsed rather than passed through raw: `invalidImageUrl`
                    // already proved `trimmed` is an https:// URL on the
                    // allowlist (see isAllowedImageUrl), but `.href` also
                    // canonicalizes/percent-encodes it so the DOM never sees
                    // the user's original unescaped input verbatim.
                    src={new URL(trimmed).href}
                    alt="Preview"
                    className="aspect-4/5 w-full rounded-md border border-border bg-muted object-cover"
                  />
                )}
            </div>

            <Button type="submit" className="mt-1 w-full" disabled={!canSubmit}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              {!isOnline
                ? "You're offline"
                : pending
                  ? "Please wait…"
                  : submitLabel}
            </Button>
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
