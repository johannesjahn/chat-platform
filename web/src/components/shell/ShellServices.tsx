import { useSession } from "@/lib/auth";
import { useBrowserNotifications } from "@/lib/browserNotifications";
import { useChatsList } from "@/lib/chats";
import { useUnreadNotificationCount } from "@/lib/notifications";
import { useOfflineQueueSync } from "@/lib/offlineQueue";
import { useRealtimeSocket } from "@/lib/realtimeSocket";

// The shell's background work, none of which draws anything (issue #754):
// the realtime socket (and with it every cache patcher it drives — chats,
// posts, comments, games, presence, typing), system notifications, and the
// offline queue's replay. Kept out of the entry chunk so a cold load doesn't
// download and run all of that before hydrating; the root starts fetching
// this chunk as soon as its module runs, so it usually lands alongside
// hydration and the socket still opens right after the first render.
//
// The unread counts it reads are the same queries the nav's badges use, so
// this adds no requests.
export function ShellServices() {
  const session = useSession();
  useRealtimeSocket(!!session);
  useOfflineQueueSync();
  const unreadNotifications = useUnreadNotificationCount(!!session);
  const { data: chatsData } = useChatsList(!!session);
  useBrowserNotifications({
    currentUserId: session?.user.id,
    chats: chatsData?.pages.flatMap((page) => page.chats) ?? [],
    unreadNotifications,
  });
  return null;
}
