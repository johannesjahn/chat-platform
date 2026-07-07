import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  Loader2,
  Pencil,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { ChatComposer } from "@/components/ChatComposer";
import { LoginPrompt } from "@/components/LoginPrompt";
import { MessageBubble } from "@/components/MessageBubble";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { $api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import {
  MAX_GROUP_PARTICIPANTS,
  chatDetailQueryKey,
  chatDisplayName,
  chatsListQueryKey,
  useChatDetail,
  useChatMessages,
} from "@/lib/chats";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/chats/$id")({
  component: ChatViewPage,
});

function ChatViewPage() {
  const { id } = Route.useParams();
  // Keyed by `id` so every hook (including the message pagination window in
  // `useChatMessages`) starts fresh when navigating between chats, instead
  // of a stale window "leaking" across chats.
  return <ChatView key={id} id={id} />;
}

function ChatView({ id }: { id: string }) {
  const chatId = Number(id);
  const session = useSession();
  const queryClient = useQueryClient();

  const {
    data: chat,
    isLoading: chatLoading,
    error: chatError,
  } = useChatDetail(chatId, !!session);
  const {
    data: messagesData,
    isLoading: messagesLoading,
    refetch: refetchMessages,
    loadEarlier,
  } = useChatMessages(chatId, !!session);

  const sendMessage = $api.useMutation("post", "/chats/{id}/messages");
  const markRead = $api.useMutation("post", "/chats/{id}/read");
  const updateChat = $api.useMutation("put", "/chats/{id}");
  const addParticipants = $api.useMutation("post", "/chats/{id}/participants");

  const { data: allUsers } = $api.useQuery(
    "get",
    "/users",
    {},
    { enabled: !!session },
  );

  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [addingParticipants, setAddingParticipants] = useState(false);
  const [selectedToAdd, setSelectedToAdd] = useState<number[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastMessageIdRef = useRef<number | null>(null);
  const prevScrollHeightRef = useRef<number | null>(null);
  const initializedRef = useRef(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  const messages = messagesData?.messages ?? [];

  const newestMessageId = messages[messages.length - 1]?.id;

  // Auto-scroll to the bottom on first load and whenever the newest message
  // changes — a real new message, not just an earlier page loading in.
  useEffect(() => {
    if (newestMessageId == null) return;
    if (lastMessageIdRef.current !== newestMessageId) {
      lastMessageIdRef.current = newestMessageId;
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: initializedRef.current ? "smooth" : "auto",
      });
      initializedRef.current = true;
    }
  }, [newestMessageId]);

  // Preserve scroll position when older messages are prepended by the
  // infinite-scroll-to-top loader — without this the view would jump to the
  // (now-shifted) top. Uses useLayoutEffect (not useEffect) so the
  // correction lands before the browser paints the prepended content —
  // otherwise the user would see a visible flash at the wrong position.
  useLayoutEffect(() => {
    if (prevScrollHeightRef.current != null && scrollRef.current) {
      const delta =
        scrollRef.current.scrollHeight - prevScrollHeightRef.current;
      scrollRef.current.scrollTop += delta;
      prevScrollHeightRef.current = null;
    }
  }, [messagesData?.offset]);

  // Infinite scroll: reaching near the top of the scroll container loads the
  // previous page of older messages, anchored so scroll position is preserved
  // once they're prepended (see the effect above). The spinner clears when
  // the triggering fetch settles, even on failure.
  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    if (!initializedRef.current || loadingEarlier) return;
    if (!messagesData?.hasEarlier) return;
    const el = e.currentTarget;
    if (el.scrollTop > 120) return;
    prevScrollHeightRef.current = el.scrollHeight;
    setLoadingEarlier(true);
    void loadEarlier().finally(() => setLoadingEarlier(false));
  }

  // Mark everything up to the newest loaded message as read once we know
  // there's something unread — keeps this chat's badge and the nav badge live.
  useEffect(() => {
    if (!session || !chat || chat.unreadCount === 0 || newestMessageId == null)
      return;
    markRead.mutate(
      {
        params: { path: { id: String(chatId) } },
        body: { messageId: newestMessageId },
      },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: chatsListQueryKey });
          void queryClient.invalidateQueries({
            queryKey: chatDetailQueryKey(chatId),
          });
        },
      },
    );
    // Only re-run when the unread count or the newest message actually
    // changes — `markRead` is recreated every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat?.unreadCount, newestMessageId]);

  if (!session) {
    return (
      <main className="mx-auto flex w-full max-w-2xl justify-center px-4 py-10">
        <LoginPrompt
          title="Log in to view this chat"
          description="Conversations are only visible to signed-in users."
        />
      </main>
    );
  }

  if (chatLoading) {
    return (
      <main className="mx-auto w-full max-w-2xl px-4 py-10">
        <Card>
          <CardHeader className="flex flex-row items-center gap-3">
            <Skeleton className="size-9 rounded-full" />
            <Skeleton className="h-4 w-32" />
          </CardHeader>
          <CardContent className="flex h-96 flex-col justify-end gap-3">
            <Skeleton className="h-10 w-2/3 self-start rounded-2xl" />
            <Skeleton className="h-10 w-1/2 self-end rounded-2xl" />
            <Skeleton className="h-10 w-3/5 self-start rounded-2xl" />
          </CardContent>
        </Card>
      </main>
    );
  }

  if (chatError || !chat) {
    return (
      <main className="mx-auto w-full max-w-2xl px-4 py-10">
        <Card>
          <CardHeader>
            <p className="text-lg font-semibold">Chat not found</p>
            <p className="text-sm text-muted-foreground">
              {chatError
                ? errorMessage(chatError)
                : "This conversation may not exist, or you're not part of it."}
            </p>
          </CardHeader>
        </Card>
      </main>
    );
  }

  const name = chatDisplayName(chat, session.user.id);
  const isCreator = chat.createdBy === session.user.id;
  const canAddMore =
    chat.type === "group" && chat.participants.length < MAX_GROUP_PARTICIPANTS;
  const candidatesToAdd = (allUsers ?? []).filter(
    (u) => !chat.participants.some((p) => p.userId === u.id),
  );

  async function handleSend(values: {
    contentType: "text" | "image_url";
    content: string;
  }) {
    await sendMessage.mutateAsync({
      params: { path: { id: String(chatId) } },
      body: values,
    });
    await Promise.all([
      refetchMessages(),
      queryClient.invalidateQueries({ queryKey: chatsListQueryKey }),
    ]);
  }

  async function handleRenameSubmit() {
    const title = titleDraft.trim();
    if (!title) return;
    setActionError(null);
    try {
      await updateChat.mutateAsync({
        params: { path: { id: String(chatId) } },
        body: { title },
      });
      await queryClient.invalidateQueries({
        queryKey: chatDetailQueryKey(chatId),
      });
      await queryClient.invalidateQueries({ queryKey: chatsListQueryKey });
      setRenaming(false);
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function handleAddParticipants() {
    if (selectedToAdd.length === 0) return;
    setActionError(null);
    try {
      await addParticipants.mutateAsync({
        params: { path: { id: String(chatId) } },
        body: { participantIds: selectedToAdd },
      });
      await queryClient.invalidateQueries({
        queryKey: chatDetailQueryKey(chatId),
      });
      setSelectedToAdd([]);
      setAddingParticipants(false);
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10">
      <Card className="overflow-hidden py-0 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
        <CardHeader className="flex flex-row items-center gap-3 border-b border-border py-3">
          <Button
            asChild
            size="icon"
            variant="ghost"
            aria-label="Back to chats"
          >
            <Link to="/chats">
              <ArrowLeft className="size-4" />
            </Link>
          </Button>

          <div
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
              chat.type === "group"
                ? "bg-accent text-accent-foreground"
                : "bg-primary/15 text-primary",
            )}
          >
            {chat.type === "group" ? (
              <Users className="size-4" />
            ) : (
              name.replace("@", "").slice(0, 1).toUpperCase()
            )}
          </div>

          <div className="flex min-w-0 flex-1 flex-col leading-tight">
            {renaming ? (
              <form
                className="flex items-center gap-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleRenameSubmit();
                }}
              >
                <Input
                  autoFocus
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  maxLength={100}
                  className="h-7 py-0"
                />
                <Button
                  size="icon"
                  variant="ghost"
                  type="submit"
                  className="size-7"
                >
                  <Check className="size-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  type="button"
                  className="size-7"
                  onClick={() => setRenaming(false)}
                >
                  <X className="size-3.5" />
                </Button>
              </form>
            ) : (
              <span className="truncate font-semibold">{name}</span>
            )}
            <span className="truncate text-xs text-muted-foreground">
              {chat.type === "group"
                ? `${chat.participants.length} participant${chat.participants.length === 1 ? "" : "s"}`
                : "Direct message"}
            </span>
          </div>

          {chat.type === "group" && isCreator && !renaming && (
            <Button
              size="icon"
              variant="ghost"
              aria-label="Rename chat"
              onClick={() => {
                setTitleDraft(chat.title ?? "");
                setRenaming(true);
              }}
            >
              <Pencil className="size-4" />
            </Button>
          )}
          {chat.type === "group" && isCreator && canAddMore && (
            <Button
              size="icon"
              variant="ghost"
              aria-label="Add participants"
              onClick={() => setAddingParticipants((v) => !v)}
            >
              <UserPlus className="size-4" />
            </Button>
          )}
        </CardHeader>

        {addingParticipants && (
          <div className="flex flex-col gap-2 border-b border-border bg-accent/20 px-4 py-3">
            {actionError && (
              <p className="text-xs text-destructive">{actionError}</p>
            )}
            {candidatesToAdd.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Everyone is already in this chat.
              </p>
            ) : (
              <>
                <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
                  {candidatesToAdd.map((u) => {
                    const isSelected = selectedToAdd.includes(u.id);
                    return (
                      <button
                        key={u.id}
                        type="button"
                        onClick={() =>
                          setSelectedToAdd((prev) =>
                            isSelected
                              ? prev.filter((id) => id !== u.id)
                              : [...prev, u.id],
                          )
                        }
                        className={cn(
                          "rounded-full border px-3 py-1 text-xs transition-colors duration-200",
                          isSelected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-background/60 hover:border-primary/40",
                        )}
                      >
                        @{u.username}
                      </button>
                    );
                  })}
                </div>
                <Button
                  size="sm"
                  className="self-end"
                  disabled={
                    selectedToAdd.length === 0 || addParticipants.isPending
                  }
                  onClick={() => void handleAddParticipants()}
                >
                  {addParticipants.isPending && (
                    <Loader2 className="size-3.5 animate-spin" />
                  )}
                  Add {selectedToAdd.length || ""}
                </Button>
              </>
            )}
          </div>
        )}

        <CardContent className="px-0">
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="flex h-[60vh] flex-col gap-2 overflow-y-auto px-4 py-4"
          >
            {loadingEarlier && (
              <div className="flex justify-center py-1">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            )}

            {messagesLoading ? (
              <div className="flex flex-1 flex-col justify-end gap-3">
                <Skeleton className="h-10 w-2/3 self-start rounded-2xl" />
                <Skeleton className="h-10 w-1/2 self-end rounded-2xl" />
              </div>
            ) : messages.length === 0 ? (
              <p className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                No messages yet — say hi 👋
              </p>
            ) : (
              messages.map((message, i) => {
                const isOwn = message.senderId === session.user.id;
                const sender = chat.participants.find(
                  (p) => p.userId === message.senderId,
                );
                return (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    isOwn={isOwn}
                    isRead={message.readByUserIds.length > 0}
                    senderUsername={
                      chat.type === "group" ? sender?.username : undefined
                    }
                    style={{ animationDelay: `${Math.min(i, 6) * 30}ms` }}
                  />
                );
              })
            )}
          </div>
        </CardContent>

        <ChatComposer onSend={handleSend} />
      </Card>
    </main>
  );
}
