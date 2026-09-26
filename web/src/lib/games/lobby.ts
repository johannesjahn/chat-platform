import { useEffect, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { fetchClient } from "@/lib/api";
import type { components } from "@/lib/api-types";
import type { GameId } from "./registry";
import { resetGameProgress } from "./rooms";

export type GameLobby = components["schemas"]["GameLobby"];
export type GameLobbyPlayer = components["schemas"]["GameLobbyPlayer"];
export type GameLobbyPhase = components["schemas"]["GameLobbyPhase"];
export type Leaderboard = components["schemas"]["Leaderboard"];
export type LeaderboardEntry = components["schemas"]["LeaderboardEntry"];
export type LeaderboardPeriod = components["schemas"]["LeaderboardPeriod"];

// Plain keys (not openapi-react-query's `[method, path, init]`) so the
// realtime handler can invalidate exactly one lobby, or one game's list,
// from an id-only event — same approach as lib/chats.ts.
export const gamesQueryKeyRoot = ["games"] as const;
export const gameLobbyQueryKey = (lobbyId: number) =>
  ["games", "lobby", lobbyId] as const;
export const gameLobbiesQueryKey = (game: string) =>
  ["games", game, "lobbies"] as const;
export const leaderboardQueryKey = (
  game: string,
  period?: LeaderboardPeriod,
) =>
  period
    ? (["games", game, "leaderboard", period] as const)
    : (["games", game, "leaderboard"] as const);

// Client clock minus server clock, as last observed. Every lobby response
// carries `serverNow`, so countdowns and race timers render against the
// server's idea of "now" — the one finishes are timed by — rather than
// whatever this device's clock says.
let clockOffsetMs = 0;
export const serverNow = () => Date.now() - clockOffsetMs;

function noteServerClock(lobby: GameLobby, receivedAt: number): void {
  clockOffsetMs = receivedAt - lobby.serverNow;
}

function unwrap<T>(result: { data?: T; error?: unknown }): T {
  if (result.error !== undefined || result.data === undefined) {
    throw result.error ?? new Error("Empty response");
  }
  return result.data;
}

// Seeds the lobby's detail cache from any mutation that returns it, so the
// page updates without waiting for the realtime echo.
function primeLobby(queryClient: QueryClient, lobby: GameLobby): GameLobby {
  noteServerClock(lobby, Date.now());
  queryClient.setQueryData(gameLobbyQueryKey(lobby.id), lobby);
  return lobby;
}

export function useGameLobby(lobbyId: number, enabled: boolean) {
  return useQuery({
    queryKey: gameLobbyQueryKey(lobbyId),
    enabled,
    queryFn: async () => {
      const lobby = unwrap(
        await fetchClient.GET("/games/lobbies/{id}", {
          params: { path: { id: String(lobbyId) } },
        }),
      );
      noteServerClock(lobby, Date.now());
      return lobby;
    },
  });
}

export function useGameLobbies(game: GameId, enabled: boolean) {
  return useQuery({
    queryKey: gameLobbiesQueryKey(game),
    enabled,
    queryFn: async () =>
      unwrap(
        await fetchClient.GET("/games/{game}/lobbies", {
          params: { path: { game } },
        }),
      ).lobbies,
  });
}

export function useLeaderboard(
  game: GameId,
  period: LeaderboardPeriod,
  enabled: boolean,
) {
  return useQuery({
    queryKey: leaderboardQueryKey(game, period),
    enabled,
    queryFn: async () =>
      unwrap(
        await fetchClient.GET("/games/{game}/leaderboard", {
          params: { path: { game }, query: { period } },
        }),
      ),
  });
}

export function useCreateLobby(game: GameId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      primeLobby(
        queryClient,
        unwrap(
          await fetchClient.POST("/games/{game}/lobbies", {
            params: { path: { game } },
          }),
        ),
      ),
  });
}

export function useQuickPlay(game: GameId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      primeLobby(
        queryClient,
        unwrap(
          await fetchClient.POST("/games/{game}/quick-play", {
            params: { path: { game } },
          }),
        ),
      ),
  });
}

type LobbyAction = "join" | "start" | "rematch";

export function useLobbyAction(lobbyId: number, action: LobbyAction) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const params = { params: { path: { id: String(lobbyId) } } };
      const result =
        action === "join"
          ? await fetchClient.POST("/games/lobbies/{id}/join", params)
          : action === "start"
            ? await fetchClient.POST("/games/lobbies/{id}/start", params)
            : await fetchClient.POST("/games/lobbies/{id}/rematch", params);
      if (action === "rematch") resetGameProgress(lobbyId);
      return primeLobby(queryClient, unwrap(result));
    },
  });
}

export function useLeaveLobby(lobbyId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { error } = await fetchClient.POST("/games/lobbies/{id}/leave", {
        params: { path: { id: String(lobbyId) } },
      });
      if (error !== undefined) throw error;
      void queryClient.invalidateQueries({ queryKey: gamesQueryKeyRoot });
    },
  });
}

export function useFinishRace(lobbyId: number, game: GameId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { typed: string; errors: number }) => {
      const lobby = primeLobby(
        queryClient,
        unwrap(
          await fetchClient.POST("/games/lobbies/{id}/finish", {
            params: { path: { id: String(lobbyId) } },
            body,
          }),
        ),
      );
      void queryClient.invalidateQueries({
        queryKey: leaderboardQueryKey(game),
      });
      return lobby;
    },
  });
}

// The phase as of right now on the server's clock. The server derives the
// same thing at read time (see `lobbyPhase` in src/GamesHandler.ts) but only
// when asked — this keeps countdown → racing → finished moving on screen
// between fetches.
export function livePhase(lobby: GameLobby, now: number): GameLobbyPhase {
  if (lobby.phase === "waiting" || !lobby.startsAt || !lobby.endsAt) {
    return "waiting";
  }
  if (now < lobby.startsAt) return "countdown";
  if (now >= lobby.endsAt) return "finished";
  if (
    lobby.players.length > 0 &&
    lobby.players.every((player) => player.durationMs !== null)
  ) {
    return "finished";
  }
  return "racing";
}

// A re-rendering clock on the server's time base, ticking every
// `intervalMs` while `active` (frame-rate for a countdown, slower for a race
// timer, stopped otherwise).
export function useServerClock(intervalMs: number, active: boolean): number {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(serverNow());
    // Catch up straight away (the clock may have been paused), then tick.
    const kick = setTimeout(tick, 0);
    const timer = setInterval(tick, intervalMs);
    return () => {
      clearTimeout(kick);
      clearInterval(timer);
    };
  }, [intervalMs, active]);
  return now;
}

export const formatDuration = (ms: number): string => {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

export const ordinal = (place: number): string => {
  const mod100 = place % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${place}th`;
  return `${place}${{ 1: "st", 2: "nd", 3: "rd" }[place % 10] ?? "th"}`;
};
