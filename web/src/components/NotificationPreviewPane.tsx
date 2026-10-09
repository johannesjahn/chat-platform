import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, ExternalLink, X } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { CommentThreadPreview } from "@/components/CommentsSection";
import { GameIcon } from "@/components/games/GameIcon";
import { LobbyCard } from "@/components/games/LobbyCard";
import { PlaceBadge } from "@/components/games/PlaceBadge";
import { PostCard, PostCardSkeleton } from "@/components/PostCard";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { $api } from "@/lib/api";
import { errorMessage, isNotFoundError } from "@/lib/errors";
import {
  useGameLobby,
  useLeaderboard,
  useServerClock,
} from "@/lib/games/lobby";
import {
  GAMES,
  gameThemeStyle,
  type GameDefinition,
  type GameId,
} from "@/lib/games/registry";
import { gameLobbyRoom, useGameRoom } from "@/lib/games/rooms";
import {
  NOTIFICATION_ICONS,
  notificationTarget,
  type Notification,
} from "@/lib/notifications";
import {
  useUserSummariesById,
  userAvatarName,
  userHandle,
  userLabel,
} from "@/lib/users";

// The `xl` preview of a notification on `/notifications` (issue #564): what
// it points at, beside the inbox, so triaging several doesn't mean leaving
// the list for each one — the search page's message preview, for the inbox.
// A post (with the comment in its thread, highlighted), an invite's lobby,
// or a record's leaderboard; "Open"/"Join" still goes to the real page.
export function NotificationPreviewPane({
  notification: n,
  onClose,
}: {
  notification: Notification;
  onClose: () => void;
}) {
  const Icon = NOTIFICATION_ICONS[n.type];
  const target = notificationTarget(n);
  const game = GAMES.find((g) => g.id === n.game && g.status === "live");
  const title =
    n.type === "game_invite"
      ? `${game?.name ?? "Game"} lobby`
      : n.type === "game_record"
        ? `${game?.name ?? "Game"} leaderboard`
        : n.commentId !== null
          ? "Comment"
          : "Post";

  return (
    <aside
      aria-label={`Preview: ${title}`}
      className="sticky top-10 flex max-h-[calc(var(--app-height,100dvh)-8rem)] w-[26rem] shrink-0 flex-col self-start overflow-hidden rounded-xl border border-border/60 bg-card/65 backdrop-blur-md motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-right-2 motion-safe:duration-300"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border pl-4 pr-1">
        <Icon className="size-4 text-primary" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
          {title}
        </span>
        {target && (
          <Button asChild variant="ghost" size="sm" className="h-8">
            <Link {...target}>
              {n.type === "game_invite" && n.lobbyId !== null ? (
                <>
                  Join
                  <ArrowRight className="size-3.5" />
                </>
              ) : (
                <>
                  <ExternalLink className="size-3.5" />
                  Open
                </>
              )}
            </Link>
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label="Close preview"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>
      {/* Keyed per notification so scroll position and any half-open state
        never carry over from the previous one. */}
      <div key={n.id} className="min-h-0 flex-1 overflow-y-auto">
        {(n.type === "game_invite" || n.type === "game_record") && game ? (
          <div
            style={gameThemeStyle(game.theme)}
            className="flex flex-col gap-4 p-4"
          >
            <div className="flex items-center gap-3">
              <GameIcon game={game} size="sm" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-semibold">{game.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {game.tagline}
                </span>
              </span>
            </div>
            {n.type === "game_invite" && n.lobbyId !== null ? (
              <LobbyPreview gameId={game.id as GameId} lobbyId={n.lobbyId} />
            ) : (
              <LeaderboardPreview game={game} />
            )}
          </div>
        ) : n.postId !== null ? (
          <PostPreview postId={n.postId} commentId={n.commentId} />
        ) : (
          <p className="p-4 text-sm text-muted-foreground">
            There&apos;s nothing left to preview for this notification.
          </p>
        )}
      </div>
    </aside>
  );
}

function PaneMessage({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function PostPreview({
  postId,
  commentId,
}: {
  postId: number;
  commentId: number | null;
}) {
  const {
    data: post,
    isLoading,
    error,
  } = $api.useQuery("get", "/posts/{id}", {
    params: { path: { id: String(postId) } },
  });
  const authorById = useUserSummariesById(post ? [post.authorId] : [], true);
  const author = post ? authorById.get(post.authorId) : undefined;

  return (
    <div className="flex flex-col gap-4 p-3">
      {isLoading ? (
        <PostCardSkeleton />
      ) : !post ? (
        <PaneMessage>
          {isNotFoundError(error)
            ? "This post has been deleted."
            : error
              ? `Could not load the post: ${errorMessage(error)}`
              : "You're offline, and this post hasn't been loaded on this device yet."}
        </PaneMessage>
      ) : (
        <>
          <PostCard
            post={post}
            authorId={post.authorId}
            authorLabel={author ? userLabel(author) : `user #${post.authorId}`}
            authorHandle={author ? userHandle(author) : undefined}
            authorAvatarUrl={author?.avatarUrl}
            authorAvatarVariants={author?.avatarVariants}
            // Editing and deleting stay on the post's own page.
            canModify={false}
            onDelete={() => {}}
            isDeleting={false}
          />
          {commentId !== null && (
            <div className="px-1">
              <CommentThreadPreview postId={postId} commentId={commentId} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function LobbyPreview({
  gameId,
  lobbyId,
}: {
  gameId: GameId;
  lobbyId: number;
}) {
  // Live, so a seat filling up or the race starting shows while it's open.
  useGameRoom(gameLobbyRoom(lobbyId));
  const lobby = useGameLobby(lobbyId, true);
  const now = useServerClock(1000, true);

  if (lobby.isLoading) return <Skeleton className="h-16 w-full rounded-xl" />;
  if (!lobby.data)
    return (
      <PaneMessage>
        {isNotFoundError(lobby.error)
          ? "This lobby has closed."
          : `Could not load the lobby: ${errorMessage(lobby.error)}`}
      </PaneMessage>
    );
  return <LobbyCard lobby={lobby.data} gamePath={gameId} now={now} />;
}

// The all-time board's top few — the one a record notification is about.
const LEADERBOARD_PREVIEW_SIZE = 5;

function LeaderboardPreview({ game }: { game: GameDefinition }) {
  const leaderboard = useLeaderboard(game.id as GameId, "all", true);

  if (leaderboard.isLoading)
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-11 w-full rounded-xl" />
        ))}
      </div>
    );
  if (!leaderboard.data)
    return (
      <PaneMessage>
        Could not load the leaderboard: {errorMessage(leaderboard.error)}
      </PaneMessage>
    );
  const { entries, me } = leaderboard.data;
  const shown = entries.slice(0, LEADERBOARD_PREVIEW_SIZE);
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        All-time top {shown.length}
      </h3>
      <ol className="flex flex-col gap-1">
        {shown.map((entry) => (
          <li
            key={entry.user.id}
            className="flex items-center gap-3 rounded-xl px-2 py-1.5"
          >
            <PlaceBadge place={entry.rank} size="sm" />
            <Avatar
              name={userAvatarName(entry.user)}
              avatarUrl={entry.user.avatarUrl}
              avatarVariants={entry.user.avatarVariants}
              size="sm"
            />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {userLabel(entry.user)}
              {entry.user.id === me?.user.id && (
                <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--game-from)]">
                  You
                </span>
              )}
            </span>
            <span className="text-sm font-bold tabular-nums">
              {Math.round(entry.bestScore)}
              <span className="ml-1 text-[10px] font-normal uppercase text-muted-foreground">
                {game.scoreUnit}
              </span>
            </span>
          </li>
        ))}
      </ol>
      {me && !shown.some((e) => e.user.id === me.user.id) && (
        <p className="text-sm text-muted-foreground">
          You&apos;re #{me.rank} with {Math.round(me.bestScore)}{" "}
          {game.scoreUnit}.
        </p>
      )}
    </div>
  );
}
