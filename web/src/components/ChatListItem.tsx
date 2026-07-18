import type { CSSProperties } from "react";
import { Link } from "@tanstack/react-router";
import { ImageIcon, Users } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { PresenceDot } from "@/components/PresenceDot";
import { Skeleton } from "@/components/ui/skeleton";
import { chatDisplayName, formatChatTimestamp, type Chat } from "@/lib/chats";
import { useIsOnline } from "@/lib/presence";
import { userAvatarName } from "@/lib/users";
import { cn } from "@/lib/utils";

function messagePreview(chat: Chat): string {
  if (!chat.lastMessage) return "No messages yet";
  return chat.lastMessage.contentType === "image_url"
    ? "Photo"
    : chat.lastMessage.content;
}

export function ChatListItemSkeleton() {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-background/40 px-3 py-3">
      <Skeleton className="size-11 shrink-0 rounded-full" />
      <div className="flex flex-1 flex-col gap-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-48" />
      </div>
      <Skeleton className="h-3 w-10" />
    </div>
  );
}

type ChatListItemProps = {
  chat: Chat;
  currentUserId: number;
  style?: CSSProperties;
};

export function ChatListItem({
  chat,
  currentUserId,
  style,
}: ChatListItemProps) {
  const name = chatDisplayName(chat, currentUserId);
  const hasUnread = chat.unreadCount > 0;
  const lastMessage = chat.lastMessage;
  const isOwnLastMessage = lastMessage?.senderId === currentUserId;
  const otherParticipant =
    chat.type === "direct"
      ? chat.participants.find((p) => p.userId !== currentUserId)
      : undefined;
  const otherParticipantOnline = useIsOnline(otherParticipant?.userId);

  return (
    <div
      style={style}
      className={cn(
        "group flex items-center gap-3 rounded-lg border border-border bg-background/40 px-3 py-3 transition-[transform,border-color,background-color] duration-400 ease-out hover:-translate-y-px hover:border-primary/40 hover:bg-background/70",
        "motion-safe:fill-mode-both motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500",
      )}
    >
      {chat.type === "direct" && otherParticipant ? (
        <Link
          to="/users/$id"
          params={{ id: String(otherParticipant.userId) }}
          aria-label={`View ${userAvatarName(otherParticipant)}'s profile`}
          className="relative shrink-0"
        >
          <Avatar name={name} size="lg" />
          <PresenceDot
            online={otherParticipantOnline}
            className="absolute -bottom-0.5 -right-0.5"
          />
        </Link>
      ) : (
        <div className="relative shrink-0">
          <div className="flex size-11 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-foreground">
            <Users className="size-4.5" />
          </div>
        </div>
      )}

      <Link
        to="/chats/$id"
        params={{ id: String(chat.id) }}
        className="flex min-w-0 flex-1 flex-col"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-medium">{name}</span>
          {lastMessage && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatChatTimestamp(lastMessage.createdAt)}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span
            className={cn(
              "flex min-w-0 items-center gap-1 truncate text-sm",
              hasUnread
                ? "font-medium text-foreground"
                : "text-muted-foreground",
            )}
          >
            {isOwnLastMessage && <span className="shrink-0">You:</span>}
            {lastMessage?.contentType === "image_url" && (
              <ImageIcon className="size-3.5 shrink-0" />
            )}
            <span className="truncate">{messagePreview(chat)}</span>
          </span>
          {hasUnread && (
            <span
              data-testid="unread-badge"
              className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground motion-safe:animate-in motion-safe:zoom-in-50 motion-safe:duration-300"
            >
              {chat.unreadCount > 99 ? "99+" : chat.unreadCount}
            </span>
          )}
        </div>
      </Link>
    </div>
  );
}
