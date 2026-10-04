import { memo, useEffect, useRef, useState, type FormEvent } from "react";
import { Lock, MessageSquare, Send } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/errors";
import {
  MAX_GAME_CHAT_LENGTH,
  useLobbyChat,
  usePostLobbyChat,
} from "@/lib/games/chat";
import type { GameLobby } from "@/lib/games/lobby";
import { cn } from "@/lib/utils";
import { userAvatarName, userHandle, userLabel } from "@/lib/users";
import { GamePanel } from "./GamePanel";
import { ReactionBar } from "./ReactionBar";

// How close to the bottom (px) the list must be for a new line to pull it
// down — anyone scrolled up reading back is left where they are.
const STICK_TO_BOTTOM_PX = 48;

// The lobby's chat and reaction bar, shared by every game and shown in every
// phase. When the game closes its chat mid-play (Sketchy — see `chatOpen`),
// the history folds away and only the reactions stay.
export const LobbyChat = memo(function LobbyChat({
  lobby,
  meId,
}: {
  lobby: GameLobby;
  meId: number;
}) {
  const { data: messages = [], isLoading } = useLobbyChat(lobby.id, true);
  const post = usePostLobbyChat(lobby.id);
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLOListElement>(null);
  const stuckRef = useRef(true);
  const seated = new Set(lobby.players.map((p) => p.user.id));

  const lastId = messages.at(-1)?.id;
  useEffect(() => {
    const list = listRef.current;
    if (list && stuckRef.current) list.scrollTop = list.scrollHeight;
  }, [lastId, lobby.chatOpen]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || post.isPending) return;
    stuckRef.current = true;
    post.mutate(text, { onSuccess: () => setDraft("") });
  };

  return (
    <GamePanel
      title="Lobby chat"
      icon={MessageSquare}
      className="gap-3"
      actions={<ReactionBar lobbyId={lobby.id} meId={meId} />}
    >
      {lobby.chatOpen ? (
        <>
          <ol
            ref={listRef}
            aria-label="Lobby messages"
            aria-live="polite"
            onScroll={(event) => {
              const el = event.currentTarget;
              stuckRef.current =
                el.scrollHeight - el.scrollTop - el.clientHeight <
                STICK_TO_BOTTOM_PX;
            }}
            className="flex max-h-64 min-h-24 flex-col gap-2.5 overflow-y-auto pr-1"
          >
            {!isLoading && messages.length === 0 && (
              <li className="m-auto text-center text-sm text-muted-foreground">
                No messages yet — say hi to the lobby 👋
              </li>
            )}
            {messages.map((message) => {
              const mine = message.user.id === meId;
              return (
                <li
                  key={message.id}
                  className="flex items-start gap-2 motion-safe:animate-bubble-in"
                >
                  <Avatar
                    name={userAvatarName(message.user)}
                    avatarUrl={message.user.avatarUrl}
                    avatarVariants={message.user.avatarVariants}
                    size="sm"
                  />
                  <div className="flex min-w-0 flex-col">
                    <span
                      className={cn(
                        "text-xs font-semibold",
                        mine
                          ? "text-[var(--game-from)]"
                          : "text-muted-foreground",
                      )}
                    >
                      {mine ? "You" : userLabel(message.user)}
                      {!mine && userHandle(message.user) && (
                        <span className="ml-1 font-normal">
                          {userHandle(message.user)}
                        </span>
                      )}
                      {message.user.id === lobby.hostId && (
                        <span className="ml-1 font-normal text-[var(--game-gold)]">
                          · host
                        </span>
                      )}
                      {!seated.has(message.user.id) && (
                        <span className="ml-1 font-normal">· watching</span>
                      )}
                    </span>
                    <p className="whitespace-pre-wrap break-words text-sm">
                      {message.text}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
          <form onSubmit={submit} className="flex items-center gap-2">
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={MAX_GAME_CHAT_LENGTH}
              placeholder="Message the lobby…"
              aria-label="Message the lobby"
            />
            <Button
              type="submit"
              size="icon"
              aria-label="Send"
              disabled={!draft.trim() || post.isPending}
              className="game-gradient shrink-0 border-0 text-white"
            >
              <Send className="size-4" />
            </Button>
          </form>
          {post.error && (
            <p className="text-xs text-destructive" role="alert">
              {errorMessage(post.error)}
            </p>
          )}
        </>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Lock className="size-4 shrink-0" />
          Chat is paused while the game is on — no spoilers. Cheer with
          reactions instead!
        </p>
      )}
    </GamePanel>
  );
});
