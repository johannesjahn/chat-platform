import {
  AtSign,
  Bell,
  CornerDownRight,
  MessageSquare,
  Swords,
  Trophy,
  type LucideIcon,
} from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { RelativeTime } from "@/components/RelativeTime";
import { GAMES } from "@/lib/games/registry";
import type { Notification } from "@/lib/notifications";
import { userAvatarName, userHandle, userLabel } from "@/lib/users";
import { cn } from "@/lib/utils";

// One notification, as both the `/notifications` inbox and the desktop bell's
// popover (issue #554) render it — so the two never word or link the same
// notification differently.

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

const NOTIFICATION_ICONS: Record<Notification["type"], LucideIcon> = {
  comment: MessageSquare,
  reply: CornerDownRight,
  reaction: Bell,
  mention: AtSign,
  game_invite: Swords,
  game_record: Trophy,
};

export function NotificationRow({
  notification: n,
  onOpen,
  compact = false,
}: {
  notification: Notification;
  onOpen: () => void;
  // The popover's denser variant: no card border per row, so a list of them
  // reads as one panel rather than a stack of cards.
  compact?: boolean;
}) {
  const Icon = NOTIFICATION_ICONS[n.type];
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          "flex w-full items-start gap-3 text-left transition-colors hover:bg-accent/40",
          compact
            ? cn("rounded-xl px-2.5 py-2.5", !n.read && "bg-primary/5")
            : cn(
                "rounded-lg border px-3 py-3",
                n.read
                  ? "border-border bg-card/40"
                  : "border-primary/40 bg-primary/5",
              ),
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
