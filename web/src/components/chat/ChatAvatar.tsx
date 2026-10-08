import { Users } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { PresenceDot } from "@/components/PresenceDot";
import { chatDisplayName, type Chat } from "@/lib/chats";
import { useIsOnline } from "@/lib/presence";
import { userAvatarName } from "@/lib/users";
import { cn } from "@/lib/utils";

const GLYPH_SIZES = {
  sm: "size-7 [&_svg]:size-3.5",
  md: "size-9 [&_svg]:size-4",
} as const;

// A chat's picture at a glance, for the compact places that list chats
// without the full row (the messaging dock, its windows, the command
// palette): the other person's avatar and presence for a direct chat, the
// group's own picture — or a people glyph — for a group.
export function ChatAvatar({
  chat,
  currentUserId,
  size = "md",
  showPresence = true,
}: {
  chat: Chat;
  currentUserId: number;
  size?: "sm" | "md";
  showPresence?: boolean;
}) {
  const other =
    chat.type === "direct"
      ? chat.participants.find((p) => p.userId !== currentUserId)
      : undefined;
  const online = useIsOnline(other?.userId);

  if (other) {
    return (
      <span className="relative inline-flex shrink-0">
        <Avatar
          name={userAvatarName(other)}
          avatarUrl={other.avatarUrl}
          avatarVariants={other.avatarVariants}
          size={size}
        />
        {showPresence && (
          <PresenceDot
            online={online}
            className="absolute -bottom-0.5 -right-0.5"
          />
        )}
      </span>
    );
  }
  if (chat.avatarVariants) {
    return (
      <Avatar
        name={chatDisplayName(chat, currentUserId)}
        avatarVariants={chat.avatarVariants}
        size={size}
        className="shrink-0"
      />
    );
  }
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground",
        GLYPH_SIZES[size],
      )}
    >
      <Users />
    </span>
  );
}
