import { useState } from "react";
import { Check, Loader2, Send, UserPlus } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { Button } from "@/components/ui/button";
import { Collapse, DisclosureChevron } from "@/components/ui/collapse";
import { Input } from "@/components/ui/input";
import { $api, MIN_USER_SEARCH_QUERY_LENGTH } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { useInviteToLobby, type GameLobby } from "@/lib/games/lobby";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { userAvatarName, userLabel } from "@/lib/users";

// Search for someone and drop a `game_invite` notification in their inbox —
// the in-app counterpart to copying the lobby link. Rendered in the waiting
// room for seated players only (the server enforces the same).
export function InvitePlayers({
  lobby,
  meId,
}: {
  lobby: GameLobby;
  meId: number | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [invited, setInvited] = useState<ReadonlySet<number>>(new Set());
  const query = useDebouncedValue(search.trim(), 300);
  const ready = query.length >= MIN_USER_SEARCH_QUERY_LENGTH;
  const { data: results, isLoading } = $api.useQuery(
    "get",
    "/users/search",
    { params: { query: { q: query } } },
    { enabled: open && ready },
  );
  const invite = useInviteToLobby(lobby.id);

  const seated = new Set(lobby.players.map((p) => p.user.id));
  const candidates = (results ?? []).filter(
    (u) => u.id !== meId && !seated.has(u.id),
  );

  // The trigger stays put and the search unfolds beneath it — the same
  // disclosure every other panel in the app uses — rather than the button
  // being swapped out for the panel in one frame.
  return (
    <div className="flex w-full flex-col items-center">
      <Button
        variant="outline"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <UserPlus className="size-4" />
        Invite players
        <DisclosureChevron open={open} className="size-3.5" />
      </Button>
      <Collapse open={open} className="w-full">
        <div className="mt-3 flex w-full flex-col gap-2 rounded-xl border border-border bg-background/40 p-3">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Find someone to invite…"
            aria-label="Search users to invite"
            autoFocus
          />
          {invite.error && (
            <p className="text-xs text-destructive" role="alert">
              {errorMessage(invite.error)}
            </p>
          )}
          {!ready ? (
            <p className="text-xs text-muted-foreground">
              Type at least {MIN_USER_SEARCH_QUERY_LENGTH} characters to search.
            </p>
          ) : isLoading ? (
            <Loader2 className="size-4 animate-spin self-center text-muted-foreground" />
          ) : candidates.length === 0 ? (
            <p className="text-xs text-muted-foreground">No one to invite.</p>
          ) : (
            <ul role="list" className="flex flex-col gap-1">
              {candidates.slice(0, 6).map((user) => {
                const sent = invited.has(user.id);
                const sending =
                  invite.isPending && invite.variables === user.id;
                return (
                  <li key={user.id} className="flex items-center gap-2">
                    <Avatar
                      name={userAvatarName(user)}
                      avatarUrl={user.avatarUrl}
                      avatarVariants={user.avatarVariants}
                      size="sm"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {userLabel(user)}
                    </span>
                    <Button
                      size="sm"
                      variant={sent ? "ghost" : "outline"}
                      disabled={sent || sending}
                      onClick={() =>
                        invite.mutate(user.id, {
                          onSuccess: (id) =>
                            setInvited((prev) => new Set(prev).add(id)),
                        })
                      }
                    >
                      {sent ? (
                        <Check className="size-4 text-emerald-400" />
                      ) : sending ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Send className="size-4" />
                      )}
                      {sent ? "Invited" : "Invite"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Collapse>
    </div>
  );
}
