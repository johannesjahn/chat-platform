import { useEffect, useRef } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Link2, Loader2, MessagesSquare, PlusCircle } from "lucide-react";
import { ChatListItem, ChatListItemSkeleton } from "@/components/ChatListItem";
import { LoginPrompt } from "@/components/LoginPrompt";
import { GradientText } from "@/components/reactbits/GradientText";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/auth";
import { useChatsList } from "@/lib/chats";
import { errorMessage } from "@/lib/errors";
import { useOnlineStatus } from "@/lib/online";

export const Route = createFileRoute("/chats/")({
  component: ChatsListPage,
});

function ChatsListPage() {
  const session = useSession();
  const isOnline = useOnlineStatus();
  const {
    data,
    isLoading,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useChatsList(!!session);
  const chats = data?.pages.flatMap((page) => page.chats) ?? [];

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

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col items-center gap-6 px-4 py-10">
      <div className="flex w-full items-center justify-between">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <MessagesSquare className="size-5 text-primary" />
          <GradientText>Chats</GradientText>
        </h1>
        {session && (
          <div className="flex items-center gap-2">
            <Button asChild size="sm" variant="outline">
              <Link to="/chats/join">
                <Link2 className="size-4" />
                Join via invite
              </Link>
            </Button>
            <Button asChild size="sm">
              <Link to="/chats/new">
                <PlusCircle className="size-4" />
                New chat
              </Link>
            </Button>
          </div>
        )}
      </div>

      {!session ? (
        <LoginPrompt
          title="Log in to see your chats"
          description="Conversations are only visible to signed-in users."
        />
      ) : isLoading ? (
        <div className="flex w-full flex-col gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <ChatListItemSkeleton key={i} />
          ))}
        </div>
      ) : chats.length === 0 && error && !(error instanceof Error) ? (
        // A decoded API error body (not a raw `Error`) only happens for a
        // real server-side failure — a network-level failure (offline,
        // unreachable server) throws a plain Error instead and is handled
        // by the offline branch below, not here (see errorMessage.ts's own
        // instanceof check for the same distinction).
        <p className="w-full rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Could not load chats: {errorMessage(error)}
        </p>
      ) : chats.length === 0 && (!isOnline || error) ? (
        // Already-loaded chats (persisted across reloads — see query.ts)
        // stay on screen even if a background refresh just failed; this is
        // only reached when there's truly nothing cached yet.
        <p className="text-sm text-muted-foreground">
          You&apos;re offline, and your chats haven&apos;t been loaded on this
          device yet.
        </p>
      ) : chats.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No conversations yet — start one with another user.
        </p>
      ) : (
        <ul role="list" className="flex w-full flex-col gap-2">
          {chats.map((chat, i) => (
            <li key={chat.id}>
              <ChatListItem
                chat={chat}
                currentUserId={session.user.id}
                style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
              />
            </li>
          ))}
        </ul>
      )}

      {session && (
        <div
          ref={sentinelRef}
          data-testid="chats-sentinel"
          className="h-1 w-full"
        />
      )}
      {isFetchingNextPage && (
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      )}
    </main>
  );
}
