import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Link2Off, Loader2, Users } from "lucide-react";
import type { ReactNode } from "react";
import { Avatar } from "@/components/Avatar";
import { LoginPrompt } from "@/components/LoginPrompt";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { $api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { chatsListQueryKey } from "@/lib/chats";
import { errorMessage } from "@/lib/errors";
import { staticTitle } from "@/lib/title";
import { userAvatarName } from "@/lib/users";

export const Route = createFileRoute("/chats/join/$code")({
  head: () => staticTitle("Chat invite"),
  component: JoinChatByCodePage,
});

// Why a preview failed for good — the link itself is dead (unknown, revoked,
// expired, used up, a block with whoever made it, a full group) — as opposed
// to a failure worth retrying (offline, rate-limited, a 5xx).
const DEAD_LINK_TAGS = new Set([
  "NotFound",
  "InvalidChatRequest",
  "Forbidden",
  "HttpApiDecodeError",
]);

function isDeadLink(err: unknown): boolean {
  const tag = (err as { _tag?: unknown } | null)?._tag;
  return typeof tag === "string" && DEAD_LINK_TAGS.has(tag);
}

// A dedicated confirmation step rather than redeeming automatically on
// load: the invite is single-use-relevant state (it can count against
// `maxUses`), so a page merely being *opened* — a prefetch, a link
// preview bot — shouldn't silently consume it. The preview
// (`GET /chats/invites/{code}`, issue #899) only looks: it shows which group
// this is, or why the link is dead, before anyone clicks Join.
function JoinChatByCodePage() {
  const { code } = Route.useParams();
  const session = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();
  const preview = $api.useQuery(
    "get",
    "/chats/invites/{code}",
    { params: { path: { code } } },
    { enabled: !!session, retry: false },
  );
  const joinChat = $api.useMutation("post", "/chats/invites/{code}/join");

  if (!session) {
    return (
      <main className="mx-auto flex w-full max-w-xl justify-center px-4 py-10">
        <LoginPrompt
          pageHeading
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

  if (preview.isPending) {
    return (
      <InviteCard
        title="Checking your invite…"
        icon={<Users className="size-4 text-primary" />}
      >
        <div
          className="flex items-center gap-4"
          aria-busy="true"
          aria-label="Loading invite"
        >
          <Skeleton className="size-20 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-4 w-1/3" />
          </div>
        </div>
      </InviteCard>
    );
  }

  if (preview.isError) {
    const dead = isDeadLink(preview.error);
    return (
      <InviteCard
        title={dead ? "This invite link doesn't work" : "Couldn't load invite"}
        icon={
          dead ? (
            <Link2Off className="size-4 text-destructive" />
          ) : (
            <Users className="size-4 text-primary" />
          )
        }
        description={errorMessage(preview.error)}
      >
        {!dead && (
          <Button
            type="button"
            className="w-full"
            onClick={() => void preview.refetch()}
          >
            Try again
          </Button>
        )}
        <Button
          asChild
          type="button"
          variant={dead ? "default" : "ghost"}
          className="w-full"
        >
          <Link to="/chats">Back to chats</Link>
        </Button>
      </InviteCard>
    );
  }

  const invite = preview.data;
  const name = invite.title ?? "Group chat";
  return (
    <InviteCard
      title={
        invite.alreadyMember
          ? "You're already in this chat"
          : "You've been invited to a chat"
      }
      icon={<Users className="size-4 text-primary" />}
    >
      <div className="flex items-center gap-4">
        {invite.avatarVariants ? (
          <Avatar
            name={name}
            avatarVariants={invite.avatarVariants}
            size="xl"
          />
        ) : (
          <span className="flex size-20 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground">
            <Users className="size-8" />
          </span>
        )}
        <div className="flex min-w-0 flex-col gap-1">
          <p className="truncate text-lg font-semibold">{name}</p>
          <p className="text-sm text-muted-foreground">
            {invite.memberCount === 1
              ? "1 member"
              : `${invite.memberCount} members`}
          </p>
          {invite.invitedBy && (
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Avatar
                name={userAvatarName(invite.invitedBy)}
                avatarUrl={invite.invitedBy.avatarUrl}
                avatarVariants={invite.invitedBy.avatarVariants}
                size="sm"
              />
              <span className="min-w-0 truncate">
                Invited by {userAvatarName(invite.invitedBy)}
              </span>
            </div>
          )}
        </div>
      </div>
      {joinChat.isError && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {errorMessage(joinChat.error)}
        </p>
      )}
      {invite.alreadyMember ? (
        <Button asChild type="button" className="w-full">
          <Link to="/chats/$id" params={{ id: String(invite.chatId) }}>
            Open chat
          </Link>
        </Button>
      ) : (
        <Button
          type="button"
          className="w-full"
          disabled={joinChat.isPending}
          onClick={() => void handleJoin()}
        >
          {joinChat.isPending && <Loader2 className="size-4 animate-spin" />}
          Join chat
        </Button>
      )}
      <Button asChild type="button" variant="ghost" className="w-full">
        <Link to="/chats">Cancel</Link>
      </Button>
    </InviteCard>
  );
}

function InviteCard({
  title,
  icon,
  description,
  children,
}: {
  title: string;
  icon: ReactNode;
  description?: string;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto w-full max-w-xl px-4 py-10">
      <Card className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
        <CardHeader>
          <CardTitle asChild className="flex items-center gap-2">
            <h1>
              {icon}
              {title}
            </h1>
          </CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">{children}</CardContent>
      </Card>
    </main>
  );
}
