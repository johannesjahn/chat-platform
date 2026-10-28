import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Forward, Loader2, Search, X } from "lucide-react";
import { ChatAvatar } from "@/components/chat/ChatAvatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { $api } from "@/lib/api";
import type { components } from "@/lib/api-types";
import { useSession } from "@/lib/auth";
import {
  appendSentMessage,
  chatDisplayName,
  chatsListQueryKey,
  messagePreview,
  useChatsList,
  type Chat,
  type ChatMessage,
} from "@/lib/chats";
import { errorMessage } from "@/lib/errors";
import { useIsDesktop } from "@/lib/media";
import { useTransitionState } from "@/lib/motion";
import { makeClientId } from "@/lib/offlineQueue";
import { useOnlineStatus } from "@/lib/online";
import { cn } from "@/lib/utils";

export type ForwardTargetResult = components["schemas"]["ForwardTargetResult"];

// Mirrors `MAX_FORWARD_TARGETS` in src/Api.ts.
export const MAX_FORWARD_TARGETS = 10;

export type ForwardOutcome = {
  results: ReadonlyArray<ForwardTargetResult>;
  // Display names of the chats picked, so the caller can say where it went
  // (and where it didn't).
  chatNames: ReadonlyMap<number, string>;
};

// Picks the chats to forward a message into (issue #601): search by name,
// multi-select up to MAX_FORWARD_TARGETS, then one request posts a copy into
// each. A full-screen sheet on a phone, a dialog from `lg` up.
//
// The whole forward carries one idempotency key, kept for as long as the
// dialog is open: retrying after a failed request reuses it, so chats that
// already got their copy aren't sent a second one (the server keys each
// target's copy off it).
export function ForwardDialog({
  open,
  message,
  onClose,
  onExited,
  onForwarded,
}: {
  open: boolean;
  message: ChatMessage;
  onClose: () => void;
  onExited: () => void;
  onForwarded: (outcome: ForwardOutcome) => void;
}) {
  const session = useSession();
  const currentUserId = session?.user.id ?? -1;
  const queryClient = useQueryClient();
  const isDesktop = useIsDesktop();
  const online = useOnlineStatus();
  const titleId = useId();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const {
    ref: panelRef,
    phase,
    mounted,
  } = useTransitionState<HTMLDivElement>(open);

  const chatsList = useChatsList(true);
  const chats = useMemo(
    () => chatsList.data?.pages.flatMap((page) => page.chats) ?? [],
    [chatsList.data],
  );
  // Your own blocks are the ones the client can know about: a direct chat
  // with someone you blocked can't take a message, so it's shown disabled.
  // (A block *they* placed only shows up as that target failing.)
  const { data: blocks } = $api.useQuery("get", "/users/me/blocks");
  const blockedIds = useMemo(
    () =>
      new Set(
        (blocks ?? []).filter((b) => b.type === "block").map((b) => b.user.id),
      ),
    [blocks],
  );

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlyArray<number>>([]);
  const [clientId] = useState(makeClientId);
  const [error, setError] = useState<string | null>(null);
  const forward = $api.useMutation(
    "post",
    "/chats/{id}/messages/{messageId}/forward",
  );

  useEffect(() => {
    if (!mounted) onExited();
  }, [mounted, onExited]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    searchRef.current?.focus();
    return () => previouslyFocused?.focus?.();
  }, [open]);

  // Escape closes and Tab stays inside, as in ConfirmDialog — captured and
  // stopped on `window` so a docked chat window behind this doesn't also
  // close on the same key.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled])",
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose, panelRef]);

  const blockedReason = (chat: Chat): string | null => {
    if (chat.type !== "direct") return null;
    const other = chat.participants.find((p) => p.userId !== currentUserId);
    return other && blockedIds.has(other.userId) ? "You blocked them" : null;
  };

  const needle = query.trim().toLowerCase();
  const visible = chats.filter(
    (chat) =>
      needle === "" ||
      chatDisplayName(chat, currentUserId).toLowerCase().includes(needle),
  );
  const atCap = selected.length >= MAX_FORWARD_TARGETS;

  const toggle = (chatId: number) =>
    setSelected((prev) =>
      prev.includes(chatId)
        ? prev.filter((id) => id !== chatId)
        : prev.length >= MAX_FORWARD_TARGETS
          ? prev
          : [...prev, chatId],
    );

  async function send() {
    if (selected.length === 0 || forward.isPending) return;
    setError(null);
    try {
      const { results } = await forward.mutateAsync({
        params: {
          path: {
            id: String(message.chatId),
            messageId: String(message.id),
          },
        },
        body: { targetChatIds: [...selected], clientId },
      });
      // Each copy is already the canonical row — show it in any open
      // conversation now rather than after the realtime round trip.
      for (const result of results) {
        if (result.message)
          appendSentMessage(queryClient, result.chatId, result.message);
      }
      void queryClient.invalidateQueries({ queryKey: chatsListQueryKey });
      const chatNames = new Map(
        chats
          .filter((chat) => selected.includes(chat.id))
          .map((chat) => [chat.id, chatDisplayName(chat, currentUserId)]),
      );
      onForwarded({ results, chatNames });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (!mounted) return null;
  const exiting = phase === "exiting";

  return (
    <div
      className={cn(
        "overlay-viewport z-50 flex justify-center",
        isDesktop ? "items-center p-4" : "items-stretch",
      )}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      inert={!open}
    >
      <div
        className={cn(
          "absolute inset-0 bg-background/70 backdrop-blur-sm",
          exiting
            ? "motion-safe:animate-backdrop-fade-out"
            : "motion-safe:animate-backdrop-blur-in",
        )}
        onClick={onClose}
      />
      <div
        ref={panelRef}
        className={cn(
          "relative flex w-full flex-col bg-card shadow-2xl",
          isDesktop
            ? "max-h-[min(36rem,100%)] max-w-md rounded-3xl border border-border"
            : // Full-screen on a phone: the panel itself keeps its header and
              // footer clear of the status bar and home indicator.
              "h-full pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]",
          exiting
            ? "motion-safe:animate-pop-close"
            : "motion-safe:animate-dialog-in",
        )}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Forward className="size-4 text-primary" aria-hidden />
          <h2 id={titleId} className="flex-1 text-base font-semibold">
            Forward message
          </h2>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Close"
            className="size-8"
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </div>

        <div className="flex flex-col gap-3 px-4 pt-3">
          <p className="line-clamp-2 rounded-lg border-l-2 border-primary/50 bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
            {messagePreview(message)}
          </p>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search chats"
              aria-label="Search chats"
              className="pl-8"
            />
          </div>
        </div>

        <ul
          className="mt-2 flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2"
          aria-label="Chats"
        >
          {chatsList.isLoading && (
            <li className="flex justify-center py-6">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </li>
          )}
          {!chatsList.isLoading && visible.length === 0 && (
            <li className="py-6 text-center text-sm text-muted-foreground">
              {needle ? "No chats match" : "No chats yet"}
            </li>
          )}
          {visible.map((chat) => {
            const name = chatDisplayName(chat, currentUserId);
            const isSelected = selected.includes(chat.id);
            const reason = blockedReason(chat);
            const disabled = reason !== null || (!isSelected && atCap);
            return (
              <li key={chat.id}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={isSelected}
                  disabled={disabled}
                  onClick={() => toggle(chat.id)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors",
                    "hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
                    isSelected && "bg-primary/10 hover:bg-primary/15",
                  )}
                >
                  <ChatAvatar
                    chat={chat}
                    currentUserId={currentUserId}
                    size="sm"
                    showPresence={false}
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{name}</span>
                    {reason && (
                      <span className="text-xs text-muted-foreground">
                        {reason}
                      </span>
                    )}
                  </span>
                  <span
                    aria-hidden
                    className={cn(
                      "flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors",
                      isSelected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border",
                    )}
                  >
                    {isSelected && <Check className="size-3.5" />}
                  </span>
                </button>
              </li>
            );
          })}
          {chatsList.hasNextPage && (
            <li className="flex justify-center py-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={chatsList.isFetchingNextPage}
                onClick={() => void chatsList.fetchNextPage()}
              >
                {chatsList.isFetchingNextPage && (
                  <Loader2 className="size-3.5 animate-spin" />
                )}
                Load more chats
              </Button>
            </li>
          )}
        </ul>

        <div className="flex flex-col gap-2 border-t border-border px-4 py-3">
          {error && <p className="text-xs text-destructive">{error}</p>}
          {!online && (
            <p className="text-xs text-muted-foreground">
              You&apos;re offline — forwarding needs a connection.
            </p>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {selected.length === 0
                ? `Pick up to ${MAX_FORWARD_TARGETS} chats`
                : `${selected.length} of ${MAX_FORWARD_TARGETS} selected`}
            </span>
            <Button
              type="button"
              disabled={selected.length === 0 || forward.isPending || !online}
              onClick={() => void send()}
            >
              {forward.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Forward className="size-4" />
              )}
              Forward
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
