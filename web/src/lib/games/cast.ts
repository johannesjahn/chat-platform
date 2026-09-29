import { useMemo } from "react";
import { userLabel, useUserSummariesById, type UserSummary } from "@/lib/users";
import type { GameLobby } from "./lobby";

export type Cast = ReadonlyMap<number, UserSummary>;

// Everyone dealt into the game, by id — the seated players straight from
// the lobby, plus anyone who has since left (their drawing still plays
// out), looked up separately.
//
// Memoized: the lobby page re-renders on every tick of the game clock, and
// a fresh Map each time would defeat the memoized components it's passed to.
export function useCast(lobby: GameLobby): Cast {
  const players = lobby.players;
  const participantIds = lobby.drawing?.participantIds;
  const departed = useMemo(() => {
    const seated = new Set(players.map((player) => player.user.id));
    return (participantIds ?? []).filter((id) => !seated.has(id));
  }, [players, participantIds]);
  const looked = useUserSummariesById(departed, departed.length > 0);
  // `looked` is a new Map on every render; only what's in it matters.
  const lookedKey = [...looked.keys()].join(",");
  return useMemo(
    () =>
      new Map<number, UserSummary>([
        ...looked,
        ...players.map((player) => [player.user.id, player.user] as const),
      ]),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on lookedKey
    [players, lookedKey],
  );
}

export function castLabel(cast: Cast, userId: number): string {
  const user = cast.get(userId);
  return user ? userLabel(user) : "A player who left";
}
