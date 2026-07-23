import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Loader2, MessageCircle, Search, Users } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { $api, MIN_USER_SEARCH_QUERY_LENGTH } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { MAX_GROUP_PARTICIPANTS, chatsListQueryKey } from "@/lib/chats";
import { errorMessage } from "@/lib/errors";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { userAvatarName, userLabel } from "@/lib/users";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/chats/new")({
  component: NewChatPage,
});

function NewChatPage() {
  const session = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"direct" | "group">("direct");
  const [search, setSearch] = useState("");
  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pendingUserId, setPendingUserId] = useState<number | null>(null);

  const query = useDebouncedValue(search.trim(), 300);
  const searchReady = query.length >= MIN_USER_SEARCH_QUERY_LENGTH;
  const { data: users, isLoading } = $api.useQuery(
    "get",
    "/users/search",
    { params: { query: { q: query } } },
    { enabled: !!session && searchReady },
  );
  const createDirectChat = $api.useMutation("post", "/chats/direct");
  const createGroupChat = $api.useMutation("post", "/chats/group");

  if (!session) {
    return (
      <main className="mx-auto flex w-full max-w-xl justify-center px-4 py-10">
        <LoginPrompt
          title="Log in to start a chat"
          description="You need an account to message people."
        />
      </main>
    );
  }

  const filtered = (users ?? []).filter((u) => u.id !== session.user.id);

  async function startDirectChat(userId: number) {
    setError(null);
    setPendingUserId(userId);
    try {
      const chat = await createDirectChat.mutateAsync({
        body: { userId },
      });
      await queryClient.invalidateQueries({ queryKey: chatsListQueryKey });
      await router.navigate({
        to: "/chats/$id",
        params: { id: String(chat.id) },
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPendingUserId(null);
    }
  }

  async function createGroup() {
    setError(null);
    try {
      const chat = await createGroupChat.mutateAsync({
        body: { title: title.trim(), participantIds: selected },
      });
      await queryClient.invalidateQueries({ queryKey: chatsListQueryKey });
      await router.navigate({
        to: "/chats/$id",
        params: { id: String(chat.id) },
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const canCreateGroup =
    title.trim().length > 0 &&
    selected.length > 0 &&
    selected.length <= MAX_GROUP_PARTICIPANTS - 1;

  return (
    <main className="mx-auto w-full max-w-xl px-4 py-10">
      <Card className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
        <CardHeader>
          <CardTitle>New chat</CardTitle>
          <CardDescription>
            Message someone directly, or start a group with up to{" "}
            {MAX_GROUP_PARTICIPANTS} people.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <Button
              type="button"
              variant={mode === "direct" ? "default" : "outline"}
              className="flex-1"
              onClick={() => setMode("direct")}
            >
              <MessageCircle className="size-4" />
              Direct message
            </Button>
            <Button
              type="button"
              variant={mode === "group" ? "default" : "outline"}
              className="flex-1"
              onClick={() => setMode("group")}
            >
              <Users className="size-4" />
              Group chat
            </Button>
          </div>

          {mode === "group" && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="group-title">Group name</Label>
              <Input
                id="group-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Weekend trip 🏔️"
                maxLength={100}
              />
            </div>
          )}

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="user-search">
                {mode === "direct" ? "Message" : "Add people"}
              </Label>
              {mode === "group" && (
                <span className="text-xs text-muted-foreground">
                  {selected.length}/{MAX_GROUP_PARTICIPANTS - 1} selected
                </span>
              )}
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="user-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search users…"
                className="pl-8"
              />
            </div>

            {!searchReady ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                Type at least {MIN_USER_SEARCH_QUERY_LENGTH} characters to
                search.
              </p>
            ) : isLoading ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                Searching users…
              </p>
            ) : filtered.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                No matching users.
              </p>
            ) : (
              <ul
                role="list"
                className="flex max-h-72 flex-col gap-1 overflow-y-auto"
              >
                {filtered.map((user) => {
                  const isSelected = selected.includes(user.id);
                  return (
                    <li key={user.id}>
                      <button
                        type="button"
                        disabled={
                          mode === "direct" && pendingUserId === user.id
                        }
                        onClick={() => {
                          if (mode === "direct") {
                            void startDirectChat(user.id);
                          } else {
                            setSelected((prev) =>
                              isSelected
                                ? prev.filter((id) => id !== user.id)
                                : prev.length < MAX_GROUP_PARTICIPANTS - 1
                                  ? [...prev, user.id]
                                  : prev,
                            );
                          }
                        }}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-lg border border-transparent px-3 py-2 text-left text-sm transition-colors duration-200 hover:border-primary/40 hover:bg-accent/60",
                          isSelected && "border-primary/60 bg-accent/60",
                        )}
                      >
                        <Avatar
                          name={userAvatarName(user)}
                          avatarUrl={user.avatarUrl}
                          avatarVariants={user.avatarVariants}
                          size="sm"
                        />
                        <span className="flex-1 font-medium">
                          {userLabel(user)}
                        </span>
                        {mode === "direct" && pendingUserId === user.id && (
                          <Loader2 className="size-4 animate-spin text-muted-foreground" />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {mode === "group" && (
            <Button
              type="button"
              className="w-full"
              disabled={!canCreateGroup || createGroupChat.isPending}
              onClick={() => void createGroup()}
            >
              {createGroupChat.isPending && (
                <Loader2 className="size-4 animate-spin" />
              )}
              Create group
            </Button>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
