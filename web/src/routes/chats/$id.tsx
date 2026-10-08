import { createFileRoute } from "@tanstack/react-router";
import { ChatConversation } from "@/components/chat/ChatConversation";
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
