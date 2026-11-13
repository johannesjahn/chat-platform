import {
  type CSSProperties,
  Suspense,
  useEffect,
  useRef,
  useState,
} from "react";
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
import { Avatar } from "@/components/Avatar";
import { FeedRail } from "@/components/feed/FeedRail";
import { LoginPrompt } from "@/components/LoginPrompt";
import { PendingPostCard } from "@/components/PendingPostCard";
import { PostCard, PostCardSkeleton } from "@/components/PostCard";
import { SessionPlaceholder } from "@/components/SessionPlaceholder";
import { GradientText } from "@/components/reactbits/GradientText";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { $api, type Session } from "@/lib/api";
import { useSession, useSessionPending } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";
import { lazyNamed } from "@/lib/lazy";
import { DESKTOP_MEDIA_QUERY, useIsDesktop, useMediaQuery } from "@/lib/media";
import {
  dismissQueuedItem,
  replayQueue,
  retryQueuedItem,
  usePendingPosts,
} from "@/lib/offlineQueue";
import { useOnlineStatus } from "@/lib/online";
import {
  postsFeedQueryKey,
  postsFeedQueryOptions,
  usePostsFeed,
} from "@/lib/posts";
import { queryClient } from "@/lib/query";
import { warmed, warmRoute } from "@/lib/routeLoader";
import { staticTitle } from "@/lib/title";
import { userAvatarName } from "@/lib/users";

// The feed's desktop-only pieces are lazy chunks (issue #754): the inline
// composer (with the mention picker and the upload field) and the post
// overlay (the whole post view). A phone never renders either, and on a
// desktop the feed itself doesn't wait on them — the composer holds its
// place with a look-alike until it lands, and the overlay renders nothing
// until a post is opened.
const InlineComposer = lazyNamed(
  () => import("@/components/feed/InlineComposer"),
  "InlineComposer",
);
const PostOverlay = lazyNamed(
  () => import("@/components/feed/PostOverlay"),
  "PostOverlay",
);

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
  // The feed's first page. Each post embeds its author (issue #750), so
  // there's no second, per-author round of requests to chain after it.
  loader: () =>
    warmRoute(() => {
      // The desktop pieces start loading beside the feed's own chunk and
      // first page, not after them (signed in only, like the rest of this).
      if (window.matchMedia(DESKTOP_MEDIA_QUERY).matches) {
        InlineComposer.preload().catch(() => {});
        PostOverlay.preload().catch(() => {});
      }
      const feed = postsFeedQueryOptions();
      return [warmed(feed.queryKey, queryClient.ensureInfiniteQueryData(feed))];
    }),
  component: PostsFeedPage,
});

function PostsFeedPage() {
  const session = useSession();
  const sessionPending = useSessionPending();
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

        {session && isDesktop && (
          <Suspense fallback={<InlineComposerPlaceholder session={session} />}>
            <InlineComposer session={session} />
          </Suspense>
        )}

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

        {sessionPending ? (
          // Rendered during hydration, before the session can be read
          // (issue #603): a signed-in reader sees the loading cards, not
          // the login prompt.
          <SessionPlaceholder
            signedIn={<FeedSkeleton />}
            signedOut={
              <LoginPrompt
                title="Log in to see the feed"
                description="Posts are only visible to signed-in users."
              />
            }
          />
        ) : !session ? (
          <LoginPrompt
            title="Log in to see the feed"
            description="Posts are only visible to signed-in users."
          />
        ) : isLoading ? (
          <FeedSkeleton />
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
        <Suspense fallback={null}>
          <PostOverlay postId={openPostId} onClose={closePost} />
        </Suspense>
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

// The inline composer as it first renders — collapsed, empty — while its
// chunk loads, so the feed below doesn't shift when it arrives.
function InlineComposerPlaceholder({ session }: { session: Session }) {
  return (
    <div
      aria-hidden
      className="w-full rounded-xl border border-border/60 bg-card/65 p-4 shadow-sm backdrop-blur-md"
    >
      <div className="flex items-start gap-3">
        <Avatar
          name={userAvatarName(session.user)}
          avatarUrl={session.user.avatarUrl}
          avatarVariants={session.user.avatarVariants}
        />
        <p className="min-h-9 flex-1 py-1.5 text-base text-muted-foreground">
          What&apos;s on your mind?
        </p>
      </div>
    </div>
  );
}

function FeedSkeleton() {
  return (
    <div className="flex w-full flex-col items-center gap-6">
      {Array.from({ length: 3 }).map((_, i) => (
        <PostCardSkeleton key={i} />
      ))}
    </div>
  );
}
