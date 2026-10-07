import { createFileRoute, Link } from "@tanstack/react-router";
import { Link2, MessagesSquare, PlusCircle } from "lucide-react";
import { ChatList } from "@/components/ChatList";
import { EmptyState } from "@/components/EmptyState";
import { LoginPrompt } from "@/components/LoginPrompt";
import { GradientText } from "@/components/reactbits/GradientText";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/auth";
import { useChatsTwoPane } from "@/lib/chats";
import { modKeyLabel } from "@/lib/shell";
import { staticTitle } from "@/lib/title";

export const Route = createFileRoute("/chats/")({
  head: () => staticTitle("Chats"),
  component: ChatsIndexPage,
});

function ChatsIndexPage() {
  // At `lg`+ the list is already the layout's left pane (see route.tsx), so
  // the right pane just invites a pick.
  return useChatsTwoPane() ? <SelectConversation /> : <ChatsListPage />;
}

function SelectConversation() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center p-8">
      <EmptyState
        pageHeading
        icon={MessagesSquare}
        title="Select a conversation"
        description={`Pick a chat from the list, or press ${modKeyLabel()}+K to jump to one.`}
      >
        <Button asChild>
          <Link to="/chats/new">
            <PlusCircle className="size-4" />
            New chat
          </Link>
        </Button>
      </EmptyState>
    </main>
  );
}

function ChatsListPage() {
  const session = useSession();

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col items-center gap-6 px-4 py-10">
      <div className="flex w-full items-center justify-between">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <MessagesSquare className="size-5 text-primary" />
          <GradientText>Chats</GradientText>
        </h1>
        {session && (
          <div className="flex items-center gap-2">
            <Button asChild size="sm" variant="outline">
              <Link to="/chats/join">
                <Link2 className="size-4" />
                Join via invite
              </Link>
            </Button>
            <Button asChild size="sm">
              <Link to="/chats/new">
                <PlusCircle className="size-4" />
                New chat
              </Link>
            </Button>
          </div>
        )}
      </div>

      {session ? (
        <ChatList session={session} />
      ) : (
        <LoginPrompt
          title="Log in to see your chats"
          description="Conversations are only visible to signed-in users."
        />
      )}
    </main>
  );
}
