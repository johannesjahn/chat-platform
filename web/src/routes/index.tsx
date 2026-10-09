import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  Navigate,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { Loader2, PlusCircle, Sparkles } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { FeedRail } from "@/components/feed/FeedRail";
import { InlineComposer } from "@/components/feed/InlineComposer";
import { PostOverlay } from "@/components/feed/PostOverlay";
import { LoginPrompt } from "@/components/LoginPrompt";
import { PendingPostCard } from "@/components/PendingPostCard";
import { PostCard, PostCardSkeleton } from "@/components/PostCard";
import { GradientText } from "@/components/reactbits/GradientText";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { $api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";
import { useIsDesktop, useMediaQuery } from "@/lib/media";
import {
  dismissQueuedItem,
  replayQueue,
  retryQueuedItem,
  usePendingPosts,
} from "@/lib/offlineQueue";
import { useOnlineStatus } from "@/lib/online";
import { postsFeedQueryKey, usePostsFeed } from "@/lib/posts";
import { useUserSummariesById, userHandle, userLabel } from "@/lib/users";
import { staticTitle } from "@/lib/title";

type FeedSearch = {
  // The post open in the desktop overlay (issue #561). Only ever reached
  // through a masked link, so the address bar shows `/posts/$id` instead.
  post?: number;
};

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): FeedSearch => {
    const post = Number(search.post);
    return Number.isInteger(post) && post > 0 ? { post } : {};
  },
  head: () => staticTitle("Feed"),
  component: PostsFeedPage,
});

function PostsFeedPage() {
  const session = useSession();
  const queryClient = useQueryClient();
  const isOnline = useOnlineStatus();
  // Tailwind's `xl` — where the right rail fits beside the feed column.
  const showRail = useMediaQuery("(min-width: 80rem)");
  const isDesktop = useIsDesktop();
  const { post: openPostId } = Route.useSearch();
  const router = useRouter();
  const navigate = useNavigate();
  const overlayIsMasked = useRouterState({
    select: (state) => state.location.maskedLocation !== undefined,
  });
  // Opening the overlay pushed a history entry, so closing it is Back —
  // which is also what the browser's own Back does. An unmasked `?post=`
  // (typed in by hand) has no entry of ours behind it; that one is replaced.
  const closePost = () => {
    if (overlayIsMasked) router.history.back();
    else
      void navigate({
        to: "/",
        search: (prev) => ({ ...prev, post: undefined }),
        replace: true,
        resetScroll: false,
      });
  };

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
  const handleFor = (authorId: number) => {
    const author = authorById.get(authorId);
    return author ? userHandle(author) : undefined;
  };

  const deletePost = $api.useMutation("delete", "/posts/{id}");
  const confirm = useConfirm();
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
    if (
      !(await confirm({
        title: "Delete this post?",
        description:
          "It's removed for everyone, along with its comments and reactions. This can't be undone.",
        confirmLabel: "Delete post",
      }))
    )
      return;
    setDeletingId(id);
    try {
      await deletePost.mutateAsync({ params: { path: { id: String(id) } } });
      await queryClient.invalidateQueries({ queryKey: postsFeedQueryKey });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    // The feed column keeps its readable `max-w-xl` at every width; at `xl`
    // a right rail joins it (issue #554).
    <main className="mx-auto flex w-full max-w-xl justify-center gap-8 px-4 py-10 xl:max-w-[60rem]">
      <div className="flex min-w-0 max-w-xl flex-1 flex-col items-center gap-6">
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

        {session && <InlineComposer session={session} />}

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
          <EmptyState
            icon={Sparkles}
            title="No posts yet"
            description="Be the first to share something with the community."
          >
            <Button asChild>
              <Link to="/posts/new">
                <PlusCircle className="size-4" />
                Create a post
              </Link>
            </Button>
          </EmptyState>
        ) : (
          <ul role="list" className="flex w-full flex-col items-center gap-6">
            {posts.map((post, i) => (
              <li key={post.id} className="flex w-full justify-center">
                <PostCard
                  post={post}
                  authorId={post.authorId}
                  authorLabel={authorLabelFor(post.authorId)}
                  authorHandle={handleFor(post.authorId)}
                  authorAvatarUrl={authorById.get(post.authorId)?.avatarUrl}
                  authorAvatarVariants={
                    authorById.get(post.authorId)?.avatarVariants
                  }
                  canModify={
                    session.user.id === post.authorId ||
                    session.user.role === "admin"
                  }
                  onDelete={() => handleDelete(post.id)}
                  isDeleting={deletingId === post.id}
                  openPost={isDesktop ? "overlay" : "page"}
                  // The row's place in the cascade; `stagger-in` turns it
                  // into the delay (see styles.css), capped so a long page
                  // doesn't animate its tail in half a second late.
                  style={{ "--stagger-index": Math.min(i, 6) } as CSSProperties}
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
      </div>
      {showRail && session && <FeedRail session={session} />}
      {/* Below `lg` a post opens as its own page, as it always has — an
          overlay URL that lands there (a resize past the breakpoint) is
          turned into that page. */}
      {isDesktop ? (
        <PostOverlay postId={openPostId} onClose={closePost} />
      ) : (
        openPostId !== undefined && (
          <Navigate
            to="/posts/$id"
            params={{ id: String(openPostId) }}
            replace
          />
        )
      )}
    </main>
  );
}
