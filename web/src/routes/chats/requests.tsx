import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Inbox } from "lucide-react";
import { ChatList } from "@/components/ChatList";
import { LoginPrompt } from "@/components/LoginPrompt";
import { GradientText } from "@/components/reactbits/GradientText";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/auth";
import { staticTitle } from "@/lib/title";

export const Route = createFileRoute("/chats/requests")({
  head: () => staticTitle("Message requests"),
  component: MessageRequestsPage,
});

// Message requests (issue #785): groups someone the viewer has no chat with
// added them to. Each opens as a read-only conversation with Accept /
// Decline in place of the composer (`MessageRequestBar`). The same page on a
// phone and in the desktop layout's right pane.
function MessageRequestsPage() {
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
          <Inbox className="size-5 text-primary" />
          <GradientText>Message requests</GradientText>
        </h1>
      </div>
      <p className="w-full text-sm text-muted-foreground">
        Groups from people you haven&apos;t chatted with. They won&apos;t notify
        you or show as unread until you accept them, and they can&apos;t see
        when you&apos;re online.
      </p>

      {session ? (
        <ChatList session={session} requests />
      ) : (
        <LoginPrompt
          title="Log in to see your message requests"
          description="Conversations are only visible to signed-in users."
        />
      )}
    </main>
  );
}
