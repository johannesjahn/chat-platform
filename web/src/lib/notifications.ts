import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { fetchClient } from "./api";
import type { components } from "./api-types";

// In-app notifications (issue #317): the header bell's badge and the
// `/notifications` inbox. Both refetch on the id-less
// `notifications_changed` realtime event (see realtimeSocket.ts) — the
// server pushes one whenever a notification lands for this user or they
// read some from another tab.

export type Notification = components["schemas"]["Notification"];
export type NotificationType = components["schemas"]["NotificationType"];

// Plain keys so the realtime handler can invalidate the whole family at once.
export const notificationsQueryKeyRoot = ["notifications"] as const;
export const unreadNotificationCountQueryKey = [
  "notifications",
  "unread-count",
] as const;
export const notificationsListQueryKey = ["notifications", "list"] as const;

export function useUnreadNotificationCount(enabled: boolean): number {
  const { data } = useQuery({
    queryKey: unreadNotificationCountQueryKey,
    enabled,
    queryFn: async ({ signal }) => {
      const { data, error } = await fetchClient.GET(
        "/notifications/unread-count",
        { signal },
      );
      if (error) throw error;
      return data.count;
    },
  });
  return enabled ? (data ?? 0) : 0;
}

export function useNotifications(enabled: boolean) {
  const queryClient = useQueryClient();
  return useInfiniteQuery({
    queryKey: notificationsListQueryKey,
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const { data, error } = await fetchClient.GET("/notifications", {
        params: { query: pageParam ? { cursor: pageParam } : {} },
        signal,
      });
      if (error) throw error;
      // The page carries the unread count too — keep the badge in step.
      queryClient.setQueryData(
        unreadNotificationCountQueryKey,
        data.unreadCount,
      );
      return data;
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

// Flips `read` on the cached inbox rows (all of them, or one) so the list
// updates immediately rather than after the refetch.
function markCachedRead(queryClient: QueryClient, id?: number): void {
  queryClient.setQueryData(
    notificationsListQueryKey,
    (old: { pages: { notifications: Notification[] }[] } | undefined) =>
      old && {
        ...old,
        pages: old.pages.map((page) => ({
          ...page,
          notifications: page.notifications.map((n) =>
            id === undefined || n.id === id ? { ...n, read: true } : n,
          ),
        })),
      },
  );
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const { data, error } = await fetchClient.POST(
        "/notifications/{id}/read",
        { params: { path: { id: String(id) } } },
      );
      if (error) throw error;
      return data.count;
    },
    onMutate: (id) => markCachedRead(queryClient, id),
    onSuccess: (count) =>
      queryClient.setQueryData(unreadNotificationCountQueryKey, count),
  });
}

export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await fetchClient.POST("/notifications/read-all");
      if (error) throw error;
      return data.count;
    },
    onMutate: () => markCachedRead(queryClient),
    onSuccess: (count) =>
      queryClient.setQueryData(unreadNotificationCountQueryKey, count),
  });
}

// Where clicking a notification goes: the post it's about, the lobby an
// invite points at, or the game's leaderboard.
export function useOpenNotification() {
  const navigate = useNavigate();
  return (n: Notification) => {
    if (n.type === "game_invite" && n.game && n.lobbyId !== null) {
      void navigate({
        to: "/games/$game/$lobbyId",
        params: { game: n.game, lobbyId: String(n.lobbyId) },
      });
    } else if (n.type === "game_record" && n.game) {
      void navigate({ to: "/games/$game", params: { game: n.game } });
    } else if (n.postId !== null) {
      void navigate({ to: "/posts/$id", params: { id: String(n.postId) } });
    }
  };
}
