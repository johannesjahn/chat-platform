import { createFileRoute, Link } from "@tanstack/react-router";
import { MessagesSquare, PlusCircle } from "lucide-react";
import { ChatListItem, ChatListItemSkeleton } from "@/components/ChatListItem";
import { LoginPrompt } from "@/components/LoginPrompt";
import { GradientText } from "@/components/reactbits/GradientText";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/auth";
import { useChatsList } from "@/lib/chats";
import { errorMessage } from "@/lib/errors";

export const Route = createFileRoute("/chats/")({
  component: ChatsListPage,
});

function ChatsListPage() {
  const session = useSession();
  const { data: chats, isLoading, error } = useChatsList(!!session);

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col items-center gap-6 px-4 py-10">
      <div className="flex w-full items-center justify-between">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <MessagesSquare className="size-5 text-primary" />
          <GradientText>Chats</GradientText>
        </h1>
        {session && (
          <Button asChild size="sm">
            <Link to="/chats/new">
              <PlusCircle className="size-4" />
              New chat
            </Link>
          </Button>
        )}
      </div>

      {!session ? (
        <LoginPrompt
          title="Log in to see your chats"
          description="Conversations are only visible to signed-in users."
        />
      ) : isLoading ? (
        <div className="flex w-full flex-col gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <ChatListItemSkeleton key={i} />
          ))}
        </div>
      ) : error ? (
        <p className="w-full rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Could not load chats: {errorMessage(error)}
        </p>
      ) : !chats || chats.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No conversations yet — start one with another user.
        </p>
      ) : (
        <ul role="list" className="flex w-full flex-col gap-2">
          {chats.map((chat, i) => (
            <li key={chat.id}>
              <ChatListItem
                chat={chat}
                currentUserId={session.user.id}
                style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
              />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
