import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AtSign,
  Bell,
  BellOff,
  CheckCheck,
  Gamepad2,
  Inbox,
  Loader2,
  MessageSquare,
} from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { FilterRail, type FilterRailItem } from "@/components/FilterRail";
import { LoginPrompt } from "@/components/LoginPrompt";
import { NotificationRow } from "@/components/NotificationRow";
import { GradientText } from "@/components/reactbits/GradientText";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
  useOpenNotification,
  type Notification,
  type NotificationType,
} from "@/lib/notifications";
import { staticTitle } from "@/lib/title";

// No count of its own in the title: the root's tab badge (lib/tabBadge.ts)
// already puts the unread total in front of every page's.
export const Route = createFileRoute("/notifications")({
  head: () => staticTitle("Notifications"),
  component: NotificationsPage,
});

// The desktop filter rail's views (issue #554). Filtering is over what's
// loaded so far — "Load more" keeps pulling pages in under any filter.
type NotificationFilter =
  "all" | "mentions" | "comments" | "reactions" | "games";

const FILTER_TYPES: Record<
  Exclude<NotificationFilter, "all">,
  ReadonlyArray<NotificationType>
> = {
  mentions: ["mention"],
  comments: ["comment", "reply"],
  reactions: ["reaction"],
  games: ["game_invite", "game_record"],
};

const FILTERS: ReadonlyArray<FilterRailItem<NotificationFilter>> = [
  { value: "all", label: "All", icon: Inbox },
  { value: "mentions", label: "Mentions", icon: AtSign },
  { value: "comments", label: "Comments", icon: MessageSquare },
  { value: "reactions", label: "Reactions", icon: Bell },
  { value: "games", label: "Game invites", icon: Gamepad2 },
];

function matchesFilter(n: Notification, filter: NotificationFilter): boolean {
  return filter === "all" || FILTER_TYPES[filter].includes(n.type);
}

function NotificationsPage() {
  const session = useSession();
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
  const [filter, setFilter] = useState<NotificationFilter>("all");

  const notifications = data?.pages.flatMap((page) => page.notifications);
  const unread = data?.pages[0]?.unreadCount ?? 0;
  // The rail only exists at `lg`+, so below it `filter` never leaves "all".
  const shown = notifications?.filter((n) => matchesFilter(n, filter));

  return (
    // At `lg` the column gains a filter rail beside it (issue #554); the
    // list itself keeps its readable `max-w-xl`.
    <main className="mx-auto flex w-full max-w-xl gap-8 px-4 py-10 lg:max-w-4xl">
      {session && (
        <FilterRail
          items={FILTERS}
          value={filter}
          onChange={setFilter}
          label="Filter notifications"
          className="top-10"
        />
      )}
      <div className="flex min-w-0 max-w-xl flex-1 flex-col gap-6">
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
            {shown && shown.length > 0 ? (
              <ul role="list" className="flex flex-col gap-2">
                {shown.map((n) => (
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
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {hasNextPage
                  ? "Nothing of this kind among your recent notifications."
                  : "Nothing of this kind yet."}
              </p>
            )}
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
      </div>
    </main>
  );
}
