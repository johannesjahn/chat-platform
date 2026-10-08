import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Settings } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { ChatAvatar } from "@/components/chat/ChatAvatar";
import { GameIcon } from "@/components/games/GameIcon";
import { UserStatusBadge } from "@/components/UserStatusBadge";
import { Button } from "@/components/ui/button";
import type { Session } from "@/lib/api";
import { openDockedChat } from "@/lib/chatDock";
import { chatDisplayName, useChatsList, type Chat } from "@/lib/chats";
import { useGameLobbies } from "@/lib/games/lobby";
import { GAMES, gameThemeStyle, type GameId } from "@/lib/games/registry";
import { useOnlineUserIds } from "@/lib/presence";
import { useUserStatus } from "@/lib/status";
import { userAvatarName, userHandle, userLabel } from "@/lib/users";
import { cn } from "@/lib/utils";

const RECENT_CHATS = 5;
const ONLINE_LIMIT = 8;

/**
 * The feed's right rail at `xl` (issue #554): you, who's around, your recent
 * chats and what's open in the arcade — the things a desktop has room to
 * keep beside the feed. Recent chats open as docked windows, so none of it
 * takes you away from the feed. Mounted only at `xl`, so a phone never pays
 * for its queries.
 */
export function FeedRail({ session }: { session: Session }) {
  const { data } = useChatsList(true);
  const chats = data?.pages.flatMap((page) => page.chats) ?? [];
  const online = useOnlineUserIds();
  const me = session.user.id;

  // The people you have a direct chat with who are online right now.
  const onlineFriends = chats
    .flatMap((chat) =>
      chat.type === "direct"
        ? chat.participants
            .filter((p) => p.userId !== me && online.has(p.userId))
            .map((p) => ({ chat, person: p }))
        : [],
    )
    .slice(0, ONLINE_LIMIT);

  return (
    <aside
      aria-label="At a glance"
      className="sticky top-10 flex w-80 shrink-0 flex-col gap-4 self-start"
    >
      <ProfileCard session={session} />

      <RailSection title="Online now">
        {onlineFriends.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">
            None of your contacts are online.
          </p>
        ) : (
          <ul role="list" className="flex flex-wrap gap-2">
            {onlineFriends.map(({ chat, person }) => (
              <li key={person.userId}>
                <button
                  type="button"
                  onClick={() => openDockedChat(chat.id)}
                  title={`Message ${userLabel(person)}`}
                  aria-label={`Message ${userLabel(person)}`}
                  className="rounded-full outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ChatAvatar chat={chat} currentUserId={me} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </RailSection>

      <RailSection
        title="Recent chats"
        action={
          <Link to="/chats" className="text-xs text-primary hover:underline">
            See all
          </Link>
        }
      >
        {chats.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">
            No conversations yet.
          </p>
        ) : (
          <ul role="list" className="-mx-1 flex flex-col">
            {chats.slice(0, RECENT_CHATS).map((chat) => (
              <li key={chat.id}>
                <RecentChat chat={chat} currentUserId={me} />
              </li>
            ))}
          </ul>
        )}
      </RailSection>

      <RailSection
        title="Open lobbies"
        action={
          <Link to="/games" className="text-xs text-primary hover:underline">
            Arcade
          </Link>
        }
      >
        <ul role="list" className="-mx-1 flex flex-col">
          {GAMES.map((game) =>
            game.status === "live" ? (
              <li key={game.id}>
                <GameLobbiesRow gameId={game.id} />
              </li>
            ) : null,
          )}
        </ul>
      </RailSection>
    </aside>
  );
}

function RailSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5 rounded-xl border border-border/60 bg-card/65 p-4 backdrop-blur-md">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function ProfileCard({ session }: { session: Session }) {
  const user = session.user;
  const status = useUserStatus(user.id, user);
  return (
    <section className="flex items-center gap-3 rounded-xl border border-border/60 bg-card/65 p-4 backdrop-blur-md">
      <Link
        to="/users/$id"
        params={{ id: String(user.id) }}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Avatar
          name={userAvatarName(user)}
          avatarUrl={user.avatarUrl}
          avatarVariants={user.avatarVariants}
          size="lg"
        />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate font-semibold">{userLabel(user)}</span>
          {userHandle(user) && (
            <span className="truncate text-xs text-muted-foreground">
              {userHandle(user)}
            </span>
          )}
          <UserStatusBadge
            status={status}
            className="text-xs text-muted-foreground"
          />
        </span>
      </Link>
      <Button
        asChild
        size="icon"
        variant="ghost"
        aria-label="Settings"
        title="Profile & status settings"
      >
        <Link to="/settings">
          <Settings className="size-4" />
        </Link>
      </Button>
    </section>
  );
}

function RecentChat({
  chat,
  currentUserId,
}: {
  chat: Chat;
  currentUserId: number;
}) {
  const last = chat.lastMessage;
  return (
    <button
      type="button"
      onClick={() => openDockedChat(chat.id)}
      className="flex w-full items-center gap-2.5 rounded-lg px-1 py-1.5 text-left outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/50"
    >
      <ChatAvatar chat={chat} currentUserId={currentUserId} size="sm" />
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span
          className={cn(
            "truncate text-sm",
            chat.unreadCount > 0 ? "font-semibold" : "font-medium",
          )}
        >
          {chatDisplayName(chat, currentUserId)}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {!last
            ? "No messages yet"
            : last.contentType === "text"
              ? last.content
              : last.contentType === "image_url"
                ? "Photo"
                : "Attachment"}
        </span>
      </span>
      {chat.unreadCount > 0 && (
        <span className="flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
          {chat.unreadCount > 99 ? "99+" : chat.unreadCount}
        </span>
      )}
    </button>
  );
}

function GameLobbiesRow({ gameId }: { gameId: GameId }) {
  const game = GAMES.find((g) => g.id === gameId)!;
  const { data: lobbies } = useGameLobbies(gameId, true);
  const waiting = lobbies?.filter((l) => l.phase === "waiting").length ?? 0;
  return (
    <Link
      to="/games/$game"
      params={{ game: gameId }}
      style={gameThemeStyle(game.theme)}
      className="flex items-center gap-2.5 rounded-lg px-1 py-1.5 outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/50"
    >
      <GameIcon game={game} size="sm" />
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-sm font-medium">{game.name}</span>
        <span className="text-xs text-muted-foreground">
          {lobbies === undefined
            ? "…"
            : waiting === 0
              ? "No open lobbies"
              : `${waiting} open lobb${waiting === 1 ? "y" : "ies"}`}
        </span>
      </span>
      <ChevronRight className="size-4 text-muted-foreground" />
    </Link>
  );
}
