import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  ChevronDown,
  ChevronUp,
  ImageIcon,
  Loader2,
  Pencil,
  Trash2,
  Type,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import type { Post } from "@/lib/posts";

type PostCardProps = {
  post: Post;
  authorUsername: string;
  canModify: boolean;
  onDelete: () => void;
  isDeleting: boolean;
};

// Posts longer than this are collapsed behind a "Show more" toggle so a
// single long text post can't dominate the feed.
const COLLAPSE_THRESHOLD = 500;

export function PostCard({
  post,
  authorUsername,
  canModify,
  onDelete,
  isDeleting,
}: PostCardProps) {
  const wasEdited = post.updatedAt !== post.createdAt;
  const isLongText =
    post.contentType === "text" && post.content.length > COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(!isLongText);

  return (
    <Card
      role="article"
      aria-label={`Post by @${authorUsername}`}
      data-post-id={post.id}
      className="w-full max-w-xl overflow-hidden py-0"
    >
      <CardHeader className="flex flex-row items-center gap-3 border-b border-border py-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
          {authorUsername.slice(0, 1).toUpperCase()}
        </div>
        <div className="flex flex-1 flex-col leading-tight">
          <span className="font-medium">@{authorUsername}</span>
          <span className="text-xs text-muted-foreground">
            {new Date(post.createdAt).toLocaleString()}
            {wasEdited && " · edited"}
          </span>
        </div>
        {canModify && (
          <div className="flex items-center gap-1">
            <Button asChild size="icon" variant="ghost" aria-label="Edit post">
              <Link to="/posts/$id/edit" params={{ id: String(post.id) }}>
                <Pencil className="size-4" />
              </Link>
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Delete post"
              disabled={isDeleting}
              onClick={onDelete}
              className="text-destructive hover:text-destructive"
            >
              {isDeleting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
            </Button>
          </div>
        )}
      </CardHeader>

      <CardContent className="px-0">
        {post.contentType === "image_url" ? (
          <img
            src={post.content}
            alt=""
            loading="lazy"
            className="aspect-4/5 w-full bg-muted object-cover"
          />
        ) : (
          <div className="px-6 py-6">
            <p
              className={
                "whitespace-pre-wrap text-base leading-relaxed" +
                (!expanded ? " line-clamp-6" : "")
              }
            >
              {post.content}
            </p>
            {isLongText && (
              <Button
                variant="link"
                size="sm"
                className="mt-2 h-auto p-0"
                onClick={() => setExpanded((prev) => !prev)}
              >
                {expanded ? (
                  <>
                    <ChevronUp className="size-4" />
                    Show less
                  </>
                ) : (
                  <>
                    <ChevronDown className="size-4" />
                    Show more
                  </>
                )}
              </Button>
            )}
          </div>
        )}
      </CardContent>

      <CardFooter className="border-t border-border py-3 text-xs text-muted-foreground">
        {post.contentType === "image_url" ? (
          <span className="flex items-center gap-1.5">
            <ImageIcon className="size-3.5" />
            Image post
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            <Type className="size-3.5" />
            Text post
          </span>
        )}
      </CardFooter>
    </Card>
  );
}
