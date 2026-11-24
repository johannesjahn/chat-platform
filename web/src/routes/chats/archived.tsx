import { createFileRoute, Link } from "@tanstack/react-router";
import { Archive, ArrowLeft } from "lucide-react";
import { ChatList } from "@/components/ChatList";
import { LoginPrompt } from "@/components/LoginPrompt";
import { GradientText } from "@/components/reactbits/GradientText";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/auth";
import { staticTitle } from "@/lib/title";

export const Route = createFileRoute("/chats/archived")({
  head: () => staticTitle("Archived chats"),
  component: ArchivedChatsPage,
});

// Chats the viewer has archived (issue #900), until a new message brings them
// back. The same page on a phone and in the desktop layout's right pane.
function ArchivedChatsPage() {
  const session = useSession();

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col items-center gap-6 px-4 py-10">
      <div className="flex w-full items-center gap-2">
        <Button asChild size="icon" variant="ghost" aria-label="Back to chats">
          <Link to="/chats">
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Archive className="size-5 text-primary" />
          <GradientText>Archived chats</GradientText>
        </h1>
      </div>
      <p className="w-full text-sm text-muted-foreground">
        They stay out of your chats and unread count until someone sends a new
        message.
      </p>

      {session ? (
        <ChatList session={session} archived />
      ) : (
        <LoginPrompt
          title="Log in to see your archived chats"
          description="Conversations are only visible to signed-in users."
        />
      )}
    </main>
  );
}
