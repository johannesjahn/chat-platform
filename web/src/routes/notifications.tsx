import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  AtSign,
  Bell,
  BellOff,
  CheckCheck,
  CornerDownRight,
  Loader2,
  MessageSquare,
  Swords,
  Trophy,
  type LucideIcon,
} from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { EmptyState } from "@/components/EmptyState";
import { LoginPrompt } from "@/components/LoginPrompt";
import { RelativeTime } from "@/components/RelativeTime";
import { GradientText } from "@/components/reactbits/GradientText";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";
import { GAMES } from "@/lib/games/registry";
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
  useUnreadNotificationCount,
  type Notification,
} from "@/lib/notifications";
import { userAvatarName, userHandle, userLabel } from "@/lib/users";
import { cn } from "@/lib/utils";
import { staticTitle, usePageTitle } from "@/lib/title";

export const Route = createFileRoute("/notifications")({
  head: () => staticTitle("Notifications"),
  component: NotificationsPage,
});

function gameName(game: string | null): string {
  return GAMES.find((g) => g.id === game)?.name ?? "a game";
}

// What happened, as the sentence after the actor's name.
function describe(n: Notification): string {
  const onComment = n.commentId !== null;
  switch (n.type) {
    case "comment":
      return "commented on your post";
    case "reply":
      return "replied to your comment";
    case "reaction":
      return `reacted ${n.emoji ?? ""} to your ${onComment ? "comment" : "post"}`;
    case "mention":
      return `mentioned you in a ${onComment ? "comment" : "post"}`;
    case "game_invite":
      return `invited you to play ${gameName(n.game)}`;
    case "game_record":
      return `took your #1 spot on the ${gameName(n.game)} leaderboard`;
  }
}

const ICONS: Record<Notification["type"], LucideIcon> = {
  comment: MessageSquare,
  reply: CornerDownRight,
  reaction: Bell,
  mention: AtSign,
  game_invite: Swords,
  game_record: Trophy,
};

// Where clicking a notification goes: the post it's about, the lobby an
// invite points at, or the game's leaderboard.
function useOpenNotification() {
  const navigate = useNavigate();
  return (n: Notification) => {
    if (n.type === "game_invite" && n.game && n.lobbyId !== null) {
      void navigate({
        to: "/games/$game/$lobbyId",
        params: { game: n.game, lobbyId: String(n.lobbyId) },
      });
    } else if (n.type === "game_record" && n.game) {
      void navigate({ to: "/games/$game", params: { game: n.game } });
    } else if (n.postId !== null) {
      void navigate({ to: "/posts/$id", params: { id: String(n.postId) } });
    }
  };
}

function NotificationsPage() {
  const session = useSession();
  // The same count as the header bell's badge, so the tab says it too.
  const unreadCount = useUnreadNotificationCount(!!session);
  usePageTitle(unreadCount > 0 ? `Notifications (${unreadCount})` : undefined);
  const {
    data,
    isLoading,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useNotifications(!!session);
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();
  const open = useOpenNotification();

  const notifications = data?.pages.flatMap((page) => page.notifications);
  const unread = data?.pages[0]?.unreadCount ?? 0;

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-10">
      <div className="flex w-full items-center gap-2">
        <Bell className="size-5 text-primary" />
        <h1 className="text-2xl font-semibold tracking-tight">
          <GradientText>Notifications</GradientText>
        </h1>
        {session && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            disabled={unread === 0 || markAll.isPending}
            onClick={() => markAll.mutate()}
          >
            <CheckCheck className="size-4" />
            Mark all read
          </Button>
        )}
      </div>

      {!session ? (
        <LoginPrompt
          title="Log in to see your notifications"
          description="Replies, reactions, mentions, and game invites land here."
        />
      ) : error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Could not load notifications: {errorMessage(error)}
        </p>
      ) : isLoading ? (
        <ul role="list" className="flex flex-col gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <li
              key={i}
              className="flex items-center gap-3 rounded-lg border border-border bg-card/60 px-3 py-3"
            >
              <Skeleton className="size-8 rounded-full" />
              <Skeleton className="h-4 w-56" />
            </li>
          ))}
        </ul>
      ) : !notifications || notifications.length === 0 ? (
        <EmptyState
          icon={BellOff}
          title="You're all caught up"
          description="When someone comments, replies, reacts, mentions you, or invites you to a game, it'll show up here."
        >
          <Button asChild variant="outline">
            <Link to="/">Back to the feed</Link>
          </Button>
        </EmptyState>
      ) : (
        <>
          <ul role="list" className="flex flex-col gap-2">
            {notifications.map((n) => (
              <NotificationRow
                key={n.id}
                notification={n}
                onOpen={() => {
                  if (!n.read) markRead.mutate(n.id);
                  open(n);
                }}
              />
            ))}
          </ul>
          {hasNextPage && (
            <Button
              variant="outline"
              className="self-center"
              disabled={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
            >
              {isFetchingNextPage && (
                <Loader2 className="size-4 animate-spin" />
              )}
              Load more
            </Button>
          )}
        </>
      )}
    </main>
  );
}

function NotificationRow({
  notification: n,
  onOpen,
}: {
  notification: Notification;
  onOpen: () => void;
}) {
  const Icon = ICONS[n.type];
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          "flex w-full items-start gap-3 rounded-lg border px-3 py-3 text-left transition-colors hover:bg-accent/40",
          n.read
            ? "border-border bg-card/40"
            : "border-primary/40 bg-primary/5",
        )}
      >
        <span className="relative shrink-0">
          <Avatar
            name={userAvatarName(n.actor)}
            avatarUrl={n.actor.avatarUrl}
            avatarVariants={n.actor.avatarVariants}
            size="sm"
          />
          <span className="absolute -bottom-1 -right-1 flex size-4.5 items-center justify-center rounded-full border border-border bg-card">
            <Icon className="size-2.5 text-primary" />
          </span>
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm">
            <span className="font-medium">{userLabel(n.actor)}</span>{" "}
            {userHandle(n.actor) && (
              <span className="text-muted-foreground">
                {userHandle(n.actor)}{" "}
              </span>
            )}
            <span className="text-muted-foreground">{describe(n)}</span>
          </span>
          {n.excerpt && (
            <span className="truncate text-sm text-foreground/80">
              “{n.excerpt}”
            </span>
          )}
          <RelativeTime
            value={n.createdAt}
            className="text-xs text-muted-foreground"
          />
        </span>
        {!n.read && (
          <span
            aria-label="Unread"
            className="mt-1.5 size-2 shrink-0 rounded-full bg-primary"
          />
        )}
      </button>
    </li>
  );
}
