import { userLabel, useUserSummariesById, type UserSummary } from "@/lib/users";
import type { GameLobby } from "./lobby";

export type Cast = ReadonlyMap<number, UserSummary>;

// Everyone dealt into the game, by id — the seated players straight from
// the lobby, plus anyone who has since left (their drawing still plays
// out), looked up separately.
export function useCast(lobby: GameLobby): Cast {
  const participants = lobby.drawing?.participantIds ?? [];
  const seated = new Map(
    lobby.players.map((player) => [player.user.id, player.user] as const),
  );
  const departed = participants.filter((id) => !seated.has(id));
  const looked = useUserSummariesById(departed, departed.length > 0);
  return new Map<number, UserSummary>([...looked, ...seated]);
}

export function castLabel(cast: Cast, userId: number): string {
  const user = cast.get(userId);
  return user ? userLabel(user) : "A player who left";
}
