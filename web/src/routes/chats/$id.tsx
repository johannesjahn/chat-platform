import { createFileRoute } from "@tanstack/react-router";
import { ChatConversation } from "@/components/chat/ChatConversation";
import { chatDetailQueryOptions, warmChatMessages } from "@/lib/chats";
import { queryClient } from "@/lib/query";
import { warmed, warmRoute } from "@/lib/routeLoader";
import { staticTitle } from "@/lib/title";

// `?message=<id>` opens the chat scrolled to (and highlighting) that message
// instead of the newest one — how a message search result lands on the
// message it matched rather than just the bottom of its conversation.
type ChatSearch = { message?: number };

export const Route = createFileRoute("/chats/$id")({
  head: () => staticTitle("Chat"),
  validateSearch: (search: Record<string, unknown>): ChatSearch => {
    const message = Number(search.message);
    return Number.isInteger(message) && message > 0 ? { message } : {};
  },
  // The chat itself and its newest messages — the window
  // `useChatMessages` then adopts rather than fetching again.
  loader: ({ params }) => {
    const chatId = Number(params.id);
    if (!Number.isInteger(chatId)) return;
    const detail = chatDetailQueryOptions(chatId);
    return warmRoute(() => [
      warmed(detail.queryKey, queryClient.ensureQueryData(detail)),
      warmChatMessages(queryClient, chatId),
    ]);
  },
  component: ChatViewPage,
});

function ChatViewPage() {
  const { id } = Route.useParams();
  const { message } = Route.useSearch();
  // Keyed by `id` so every hook (including the message pagination window in
  // `useChatMessages`) starts fresh when navigating between chats, instead
  // of a stale window "leaking" across chats.
  return (
    <ChatConversation key={id} chatId={Number(id)} targetMessageId={message} />
  );
}
