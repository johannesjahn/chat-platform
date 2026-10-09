import { useRef, useState, type KeyboardEvent } from "react";
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
  PanelRight,
} from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { FilterRail, type FilterRailItem } from "@/components/FilterRail";
import { LoginPrompt } from "@/components/LoginPrompt";
import { NotificationPreviewPane } from "@/components/NotificationPreviewPane";
import { NotificationRow } from "@/components/NotificationRow";
import { GradientText } from "@/components/reactbits/GradientText";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";
import { useMediaQuery } from "@/lib/media";
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
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

// ↑/↓ through the rows: every row carries `data-notification-row`, in the
// order they're rendered. Returns the index of the row it focused.
function moveRowFocus(container: HTMLElement | null, step: 1 | -1) {
  const rows = Array.from(
    container?.querySelectorAll<HTMLElement>("[data-notification-row]") ?? [],
  );
  if (rows.length === 0) return -1;
  const current = rows.indexOf(document.activeElement as HTMLElement);
  const next =
    current === -1
      ? step === 1
        ? 0
        : rows.length - 1
      : Math.min(rows.length - 1, Math.max(0, current + step));
  rows[next]?.focus();
  return next;
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
  const [filter, setFilter] = useState<NotificationFilter>("all");
  // At `xl` a notification opens in a preview pane beside the list instead
  // of navigating away (issue #564), like a message hit on the search page.
  const canPreview = useMediaQuery("(min-width: 80rem)");
  const [previewId, setPreviewId] = useState<number | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const notifications = data?.pages.flatMap((page) => page.notifications);
  const unread = data?.pages[0]?.unreadCount ?? 0;
  // The rail only exists at `lg`+, so below it `filter` never leaves "all".
  const shown = notifications?.filter((n) => matchesFilter(n, filter));
  // Looked up live, so the pane follows the row (its read flag, a refetch).
  const previewed = canPreview
    ? notifications?.find((n) => n.id === previewId)
    : undefined;

  function preview(n: Notification) {
    if (!n.read) markRead.mutate(n.id);
    setPreviewId(n.id);
  }

  function onListKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = moveRowFocus(
      listRef.current,
      event.key === "ArrowDown" ? 1 : -1,
    );
    const n = shown?.[index];
    if (canPreview && n) preview(n);
  }

  return (
    // At `lg` the column gains a filter rail beside it (issue #554), and at
    // `xl` a preview pane on the right (issue #564); the list itself keeps
    // its readable `max-w-xl`.
    <main className="mx-auto flex w-full max-w-xl gap-8 px-4 py-10 lg:max-w-4xl xl:max-w-7xl">
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
              <ul
                ref={listRef}
                role="list"
                className="flex flex-col gap-2"
                onKeyDown={onListKeyDown}
              >
                {shown.map((n) => (
                  <NotificationRow
                    key={n.id}
                    notification={n}
                    selected={previewed?.id === n.id}
                    onOpen={(e) => {
                      // The row is a link: below `xl`, on Enter (a click
                      // with no pointer, `detail` 0) and on a modified
                      // click it navigates as links do. A plain click at
                      // `xl` previews instead.
                      if (
                        !canPreview ||
                        e.detail === 0 ||
                        e.metaKey ||
                        e.ctrlKey ||
                        e.shiftKey
                      ) {
                        if (!n.read) markRead.mutate(n.id);
                        return;
                      }
                      e.preventDefault();
                      preview(n);
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
      {canPreview &&
        session &&
        notifications &&
        notifications.length > 0 &&
        (previewed ? (
          <NotificationPreviewPane
            notification={previewed}
            onClose={() => setPreviewId(null)}
          />
        ) : (
          <aside
            aria-label="Preview"
            className="sticky top-10 flex h-64 w-[26rem] shrink-0 flex-col items-center justify-center gap-2 self-start rounded-xl border border-dashed border-border/60 px-8 text-center text-sm text-muted-foreground"
          >
            <PanelRight className="size-5" />
            Select a notification to preview it here. ↑/↓ move through the list;
            Enter opens one.
          </aside>
        ))}
    </main>
  );
}
