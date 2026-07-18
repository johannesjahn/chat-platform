import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Loader2, Users } from "lucide-react";
import { LoginPrompt } from "@/components/LoginPrompt";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { $api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { chatsListQueryKey } from "@/lib/chats";
import { errorMessage } from "@/lib/errors";

export const Route = createFileRoute("/chats/join/$code")({
  component: JoinChatByCodePage,
});

// A dedicated confirmation step rather than redeeming automatically on
// load: the invite is single-use-relevant state (it can count against
// `maxUses`), so a page merely being *opened* — a prefetch, a link
// preview bot — shouldn't silently consume it.
function JoinChatByCodePage() {
  const { code } = Route.useParams();
  const session = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();
  const joinChat = $api.useMutation("post", "/chats/invites/{code}/join");

  if (!session) {
    return (
      <main className="mx-auto flex w-full max-w-xl justify-center px-4 py-10">
        <LoginPrompt
          title="Log in to join this chat"
          description="You need an account to redeem an invite link."
        />
      </main>
    );
  }

  async function handleJoin() {
    try {
      const chat = await joinChat.mutateAsync({ params: { path: { code } } });
      await queryClient.invalidateQueries({ queryKey: chatsListQueryKey });
      await router.navigate({
        to: "/chats/$id",
        params: { id: String(chat.id) },
      });
    } catch {
      // Error is surfaced below via joinChat.error — nothing else to do.
    }
  }

  return (
    <main className="mx-auto w-full max-w-xl px-4 py-10">
      <Card className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="size-4 text-primary" />
            You&apos;ve been invited to a chat
          </CardTitle>
          <CardDescription>
            Join to see the conversation and start messaging.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {joinChat.isError && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {errorMessage(joinChat.error)}
            </p>
          )}
          <Button
            type="button"
            className="w-full"
            disabled={joinChat.isPending}
            onClick={() => void handleJoin()}
          >
            {joinChat.isPending && <Loader2 className="size-4 animate-spin" />}
            Join chat
          </Button>
          <Button asChild type="button" variant="ghost" className="w-full">
            <Link to="/chats">Cancel</Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
