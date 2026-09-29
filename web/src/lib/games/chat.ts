import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchClient } from "@/lib/api";
import type { components } from "@/lib/api-types";
import { unwrap } from "./lobby";

export type GameChatMessage = components["schemas"]["GameChatMessage"];

// Must match MAX_GAME_CHAT_LENGTH in src/Api.ts (the server enforces it).
export const MAX_GAME_CHAT_LENGTH = 280;

// A plain key so the realtime handler can invalidate one lobby's chat from
// its id-only `game_chat` event (see lib/realtimeSocket.ts).
export const gameChatQueryKey = (lobbyId: number) =>
  ["games", "lobby", lobbyId, "chat"] as const;

// The lobby chat's newest messages, oldest first. Kept live by `game_chat`
// events rather than polling, so it only needs the lobby's room joined.
export function useLobbyChat(lobbyId: number, enabled: boolean) {
  return useQuery({
    queryKey: gameChatQueryKey(lobbyId),
    enabled,
    queryFn: async () =>
      unwrap(
        await fetchClient.GET("/games/lobbies/{id}/chat", {
          params: { path: { id: String(lobbyId) } },
        }),
      ).messages,
  });
}

export function usePostLobbyChat(lobbyId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (text: string) =>
      unwrap(
        await fetchClient.POST("/games/lobbies/{id}/chat", {
          params: { path: { id: String(lobbyId) } },
          body: { text },
        }),
      ),
    // Show the line straight away; the realtime echo's refetch confirms it.
    onSuccess: (message) => {
      queryClient.setQueryData<GameChatMessage[]>(
        gameChatQueryKey(lobbyId),
        (messages = []) =>
          messages.some((m) => m.id === message.id)
            ? messages
            : [...messages, message],
      );
    },
  });
}
