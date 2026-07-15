import { type CSSProperties, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ChevronDown,
  ChevronUp,
  ImageIcon,
  Loader2,
  MessageSquare,
  Pencil,
  Trash2,
  Type,
} from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { CommentsSection, LikeToggle } from "@/components/CommentsSection";
import { Spotlight } from "@/components/reactbits/Spotlight";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { $api } from "@/lib/api";
import { postDetailQueryKeyPrefix, postsFeedQueryKey } from "@/lib/posts";
import { cn } from "@/lib/utils";
import type { Post } from "@/lib/posts";

type PostCardProps = {
  post: Post;
  authorId: number;
  authorUsername: string;
  canModify: boolean;
  onDelete: () => void;
  isDeleting: boolean;
  style?: CSSProperties;
};

// Structural placeholder shown while a page of posts is loading. Mirrors
// PostCard's header/content/footer chrome exactly (same padding, avatar size,
// border) so only the variable-height content area shifts once real posts
// swap in — the same shift you'd see between two real posts of different
// lengths, not a skeleton-to-content pop.
export function PostCardSkeleton() {
  return (
    <Card className="w-full max-w-xl overflow-hidden py-0">
      <CardHeader className="flex flex-row items-center gap-3 border-b border-border py-4">
        <Skeleton className="size-9 shrink-0 rounded-full" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3 w-20" />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5 px-6 py-6">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </CardContent>
      <CardFooter className="border-t border-border py-3">
        <Skeleton className="h-3 w-20" />
      </CardFooter>
    </Card>
  );
}

// Posts longer than this are collapsed behind a "Show more" toggle so a
// single long text post can't dominate the feed.
const COLLAPSE_THRESHOLD = 500;

export function PostCard({
  post,
  authorId,
  authorUsername,
  canModify,
  onDelete,
  isDeleting,
  style,
}: PostCardProps) {
  const wasEdited = post.updatedAt !== post.createdAt;
  const isLongText =
    post.contentType === "text" && post.content.length > COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(!isLongText);
  const [showComments, setShowComments] = useState(false);

  const queryClient = useQueryClient();
  const likePost = $api.useMutation("post", "/posts/{id}/likes");
  const unlikePost = $api.useMutation("delete", "/posts/{id}/likes");
  const likePending = likePost.isPending || unlikePost.isPending;

  const toggleLike = async () => {
    const mutation = post.likedByMe ? unlikePost : likePost;
    await mutation.mutateAsync({ params: { path: { id: String(post.id) } } });
    // The server also broadcasts a `like_changed` event, but invalidate here
    // too so the acting user's own count updates immediately rather than
    // waiting on the socket round-trip.
    await queryClient.invalidateQueries({ queryKey: postsFeedQueryKey });
    await queryClient.invalidateQueries({
      queryKey: postDetailQueryKeyPrefix,
    });
  };

  return (
    <Card
      role="article"
      aria-label={`Post by @${authorUsername}`}
      data-post-id={post.id}
      style={style}
      onMouseMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        e.currentTarget.style.setProperty(
          "--spot-x",
          `${e.clientX - rect.left}px`,
        );
        e.currentTarget.style.setProperty(
          "--spot-y",
          `${e.clientY - rect.top}px`,
        );
      }}
      className={cn(
        "group w-full max-w-xl overflow-hidden py-0 transition-[transform,box-shadow,border-color] duration-400 ease-out hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-xl hover:shadow-primary/5",
        "motion-safe:fill-mode-both motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-4 motion-safe:duration-500",
      )}
    >
      <Spotlight color="oklch(0.62 0.19 277 / 0.16)" size={360} />
      <CardHeader className="flex flex-row items-center gap-3 border-b border-border py-4">
        <Link
          to="/users/$id"
          params={{ id: String(authorId) }}
          className="flex flex-1 items-center gap-3 leading-tight"
        >
          <Avatar
            name={authorUsername}
            className="transition-transform duration-300 ease-out group-hover:scale-105"
          />
          <div className="flex flex-1 flex-col leading-tight">
            <span className="font-medium">@{authorUsername}</span>
            <span className="text-xs text-muted-foreground">
              {new Date(post.createdAt).toLocaleString()}
              {wasEdited && " · edited"}
            </span>
          </div>
        </Link>
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
                "whitespace-pre-wrap break-words text-base leading-relaxed" +
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

      <CardFooter className="flex-col items-stretch gap-0 border-t border-border p-0">
        <div className="flex items-center gap-1 px-3 py-2">
          <LikeToggle
            liked={post.likedByMe}
            likeCount={post.likeCount}
            pending={likePending}
            onToggle={toggleLike}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={showComments}
            onClick={() => setShowComments((prev) => !prev)}
            className="h-8 gap-1.5 px-2 text-muted-foreground"
          >
            <MessageSquare className="size-4" />
            {showComments ? "Hide comments" : "Comments"}
          </Button>
          <span className="ml-auto flex items-center gap-1.5 pr-1 text-xs text-muted-foreground">
            {post.contentType === "image_url" ? (
              <>
                <ImageIcon className="size-3.5" />
                Image
              </>
            ) : (
              <>
                <Type className="size-3.5" />
                Text
              </>
            )}
          </span>
        </div>
      </CardFooter>
      {showComments && <CommentsSection postId={post.id} />}
    </Card>
  );
}
