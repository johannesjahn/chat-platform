import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { $api } from "./api";
import { openDockedChat } from "./chatDock";
import { chatsListQueryKey } from "./chats";
import { useIsDesktop } from "./media";

/**
 * "Message" from a profile or the users list: finds (or starts) the direct
 * chat with `userId` and opens it — as a docked window on a desktop, so you
 * stay on the page you were on (issue #554), and as the full conversation
 * page below `lg`, where there is no dock.
 */
export function useStartDirectChat() {
  const createDirectChat = $api.useMutation("post", "/chats/direct");
  const queryClient = useQueryClient();
  const router = useRouter();
  const isDesktop = useIsDesktop();

  async function start(userId: number) {
    const chat = await createDirectChat.mutateAsync({ body: { userId } });
    await queryClient.invalidateQueries({ queryKey: chatsListQueryKey });
    if (isDesktop) {
      openDockedChat(chat.id);
    } else {
      await router.navigate({
        to: "/chats/$id",
        params: { id: String(chat.id) },
      });
    }
  }

  return { start, isPending: createDirectChat.isPending };
}
