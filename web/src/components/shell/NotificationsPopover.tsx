import { Link } from "@tanstack/react-router";
import { Bell, BellOff, CheckCheck, Loader2 } from "lucide-react";
import { NavIcon } from "@/components/NavIcon";
import { NotificationRow } from "@/components/NotificationRow";
import { Button } from "@/components/ui/button";
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
} from "@/lib/notifications";
import { usePopover } from "@/lib/popover";
import { cn } from "@/lib/utils";
import { SidebarBadge } from "./SidebarBadge";
import { sidebarItemClassName } from "./sidebarItem";

// How many of the newest notifications the panel lists before "See all".
const POPOVER_LIMIT = 8;

// The desktop bell (issue #554): rather than leaving the page for
// `/notifications`, it opens the newest few in a panel beside the sidebar —
// mark one read by opening it, mark them all, or follow "See all" to the
// full inbox. The phone bar keeps its plain link to the inbox.
export function NotificationsPopover({ unread }: { unread: number }) {
  const {
    open,
    setOpen,
    toggle,
    rootRef,
    triggerRef,
    panelRef,
    panelId,
    mounted,
    exiting,
  } = usePopover();
  const { data, isLoading, error } = useNotifications(open);
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();
  const notifications = data?.pages[0]?.notifications.slice(0, POPOVER_LIMIT);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        ref={triggerRef}
        aria-expanded={open}
        // The panel unmounts once closed, so it's only pointed at while open.
        aria-controls={open ? panelId : undefined}
        onClick={toggle}
        aria-haspopup="dialog"
        aria-label={
          unread > 0 ? `Notifications (${unread} unread)` : "Notifications"
        }
        title="Notifications"
        className={cn(
          sidebarItemClassName,
          "group/nav-icon",
          open && "bg-accent/60 text-foreground",
        )}
      >
        <span className="relative flex">
          <NavIcon icon={Bell} className="size-5" />
          <SidebarBadge count={unread} />
        </span>
        <span className="sr-only xl:not-sr-only">Notifications</span>
      </button>
      {mounted && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="Notifications"
          inert={!open}
          className={cn(
            "absolute left-full top-0 z-40 ml-3 flex max-h-[calc(var(--app-height,100dvh)-2rem)] w-96 origin-top-left flex-col rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl",
            exiting
              ? "motion-safe:animate-pop-close"
              : "motion-safe:animate-pop-open",
          )}
        >
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">Notifications</h2>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-7 px-2 text-xs"
              disabled={unread === 0 || markAll.isPending}
              onClick={() => markAll.mutate()}
            >
              <CheckCheck className="size-3.5" />
              Mark all read
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
            {error ? (
              <p className="px-3 py-6 text-center text-sm text-destructive">
                Could not load notifications.
              </p>
            ) : isLoading || !notifications ? (
              <div className="flex justify-center py-8">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : notifications.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-sm text-muted-foreground">
                <BellOff className="size-5" />
                You&apos;re all caught up.
              </div>
            ) : (
              <ul role="list" className="flex flex-col gap-0.5">
                {notifications.map((n) => (
                  <NotificationRow
                    key={n.id}
                    compact
                    notification={n}
                    // The row is a link — it does the navigating.
                    onOpen={() => {
                      if (!n.read) markRead.mutate(n.id);
                      setOpen(false);
                    }}
                  />
                ))}
              </ul>
            )}
          </div>
          <div className="border-t border-border p-1.5">
            <Link
              to="/notifications"
              className="flex w-full items-center justify-center rounded-xl px-3 py-2 text-sm font-medium text-primary transition-colors hover:bg-accent/50"
            >
              See all notifications
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
