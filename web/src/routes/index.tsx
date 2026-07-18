import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Loader2, PlusCircle } from "lucide-react";
import { LoginPrompt } from "@/components/LoginPrompt";
import { PendingPostCard } from "@/components/PendingPostCard";
import { PostCard, PostCardSkeleton } from "@/components/PostCard";
import { GradientText } from "@/components/reactbits/GradientText";
import { Button } from "@/components/ui/button";
import { $api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";
import {
  dismissQueuedItem,
  replayQueue,
  retryQueuedItem,
  usePendingPosts,
} from "@/lib/offlineQueue";
import { useOnlineStatus } from "@/lib/online";
import { postsFeedQueryKey, usePostsFeed } from "@/lib/posts";
import { useUserSummariesById, userLabel } from "@/lib/users";

export const Route = createFileRoute("/")({
  component: PostsFeedPage,
});

function PostsFeedPage() {
  const session = useSession();
  const queryClient = useQueryClient();
  const isOnline = useOnlineStatus();

  const {
    data,
    isLoading,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = usePostsFeed(!!session);

  const posts = data?.pages.flatMap((page) => page.posts) ?? [];
  const pendingPosts = usePendingPosts();

  // Resolves `authorId` -> a display label on each card, one request per
  // distinct author currently loaded (see `useUserSummariesById`).
  const authorById = useUserSummariesById(
    posts.map((post) => post.authorId),
    !!session,
  );
  const authorLabelFor = (authorId: number) => {
    const author = authorById.get(authorId);
    return author ? userLabel(author) : `user #${authorId}`;
  };

  const deletePost = $api.useMutation("delete", "/posts/{id}");
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { rootMargin: "400px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  async function handleDelete(id: number) {
    if (!window.confirm("Delete this post? This can't be undone.")) return;
    setDeletingId(id);
    try {
      await deletePost.mutateAsync({ params: { path: { id: String(id) } } });
      await queryClient.invalidateQueries({ queryKey: postsFeedQueryKey });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col items-center gap-6 px-4 py-10">
      <div className="flex w-full items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">
          <GradientText>Feed</GradientText>
        </h1>
        {session && (
          <Button asChild size="sm">
            <Link to="/posts/new">
              <PlusCircle className="size-4" />
              New post
            </Link>
          </Button>
        )}
      </div>

      {session && pendingPosts.length > 0 && (
        <ul role="list" className="flex w-full flex-col items-center gap-6">
          {pendingPosts.map((item) => (
            <li key={item.clientId} className="flex w-full justify-center">
              <PendingPostCard
                item={item}
                onRetry={() => {
                  retryQueuedItem(item.clientId);
                  void replayQueue(queryClient);
                }}
                onDismiss={() => dismissQueuedItem(item.clientId)}
              />
            </li>
          ))}
        </ul>
      )}

      {!session ? (
        <LoginPrompt
          title="Log in to see the feed"
          description="Posts are only visible to signed-in users."
        />
      ) : isLoading ? (
        <div className="flex w-full flex-col items-center gap-6">
          {Array.from({ length: 3 }).map((_, i) => (
            <PostCardSkeleton key={i} />
          ))}
        </div>
      ) : posts.length === 0 && error && !(error instanceof Error) ? (
        // A decoded API error body (not a raw `Error`) only happens for a
        // real server-side failure — a network-level failure (offline,
        // unreachable server) throws a plain Error instead and is handled
        // by the offline branch below, not here (see errorMessage.ts's own
        // instanceof check for the same distinction).
        <p className="w-full rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Could not load posts: {errorMessage(error)}
        </p>
      ) : posts.length === 0 && (!isOnline || error) ? (
        // Already-loaded posts (persisted across reloads — see query.ts)
        // stay on screen even if a background refresh just failed; this is
        // only reached when there's truly nothing cached yet.
        <p className="text-sm text-muted-foreground">
          You&apos;re offline, and the feed hasn&apos;t been loaded on this
          device yet.
        </p>
      ) : posts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No posts yet — be the first to share something.
        </p>
      ) : (
        <ul role="list" className="flex w-full flex-col items-center gap-6">
          {posts.map((post, i) => (
            <li key={post.id} className="flex w-full justify-center">
              <PostCard
                post={post}
                authorId={post.authorId}
                authorLabel={authorLabelFor(post.authorId)}
                canModify={
                  session.user.id === post.authorId ||
                  session.user.role === "admin"
                }
                onDelete={() => handleDelete(post.id)}
                isDeleting={deletingId === post.id}
                style={{ animationDelay: `${Math.min(i, 6) * 60}ms` }}
              />
            </li>
          ))}
        </ul>
      )}

      {session && (
        <div
          ref={sentinelRef}
          data-testid="feed-sentinel"
          className="h-1 w-full"
        />
      )}
      {isFetchingNextPage && (
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      )}
      {session && !hasNextPage && posts.length > 0 && (
        <p className="text-xs text-muted-foreground">
          You&apos;re all caught up.
        </p>
      )}
    </main>
  );
}
