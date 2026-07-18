import { useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { fetchClient } from "./api";
import { getSession, useSession } from "./auth";
import {
  appendSentMessage,
  chatDetailQueryKey,
  chatsListQueryKey,
} from "./chats";
import type { MessageContentType } from "./chats";
import { errorMessage } from "./errors";
import { useOnlineStatus } from "./online";
import { postsFeedQueryKey } from "./posts";
import type { PostContentType } from "./posts";

// Client-side queue for write mutations attempted while offline (issue
// #177) — read-only offline support (persisted query cache) already exists,
// see query.ts. A message send or post creation attempted with no network
// connection is appended here instead of failing, shown in the UI with a
// "Pending" indicator, and replayed in FIFO order (oldest first) once
// `useOnlineStatus`/`onlineManager` reports connectivity again — preserving
// the order the user created them in, per the issue's requirement.
type QueuedItemStatus = "pending" | "failed";

// Stamped from `getSession()` at enqueue time, not just at replay time — a
// browser can have a different user logged in by the time connectivity
// returns (log out, someone else logs in), and a queued item must never be
// sent, or even shown, under a different account's session than the one
// that created it. `null` only if something was queued with no session at
// all (shouldn't happen — every caller of enqueue* is only reachable while
// logged in — kept as a safe "never matches, never replays" fallback rather
// than assuming it can't occur).
type Owned = { ownerId: number | null };

export type QueuedMessage = Owned & {
  kind: "message";
  clientId: string;
  chatId: number;
  contentType: MessageContentType;
  content: string;
  createdAt: number;
  status: QueuedItemStatus;
  error?: string;
};

export type QueuedPost = Owned & {
  kind: "post";
  clientId: string;
  contentType: PostContentType;
  content: string;
  createdAt: number;
  status: QueuedItemStatus;
  error?: string;
};

type QueuedItem = QueuedMessage | QueuedPost;

const STORAGE_KEY = "chat-platform-offline-mutation-queue";
const EMPTY_QUEUE: QueuedItem[] = [];

function parseQueue(raw: string): QueuedItem[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QueuedItem[]) : [];
  } catch {
    return [];
  }
}

// Read fresh from localStorage on every call rather than trusting an
// in-memory copy — mirrors `getSession` in auth.ts. That's what makes this
// store correct across multiple tabs: a write in one tab (`writeQueue`
// below) is visible to another tab's very next read, whether that read is
// triggered by this tab's own `notify()` (same tab, no native `storage`
// event fires for that) or the browser's `storage` event (other tabs, see
// `subscribe`). Caching by the raw string, not re-parsing unconditionally,
// keeps the return value referentially stable across renders when nothing
// changed — required for `useSyncExternalStore` to not loop.
let cache: { raw: string | null; value: QueuedItem[] } = {
  raw: null,
  value: EMPTY_QUEUE,
};

function readQueue(): QueuedItem[] {
  if (typeof window === "undefined") return EMPTY_QUEUE;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw !== cache.raw) {
    cache = { raw, value: raw ? parseQueue(raw) : [] };
  }
  return cache.value;
}

function writeQueue(next: QueuedItem[]): void {
  if (typeof window !== "undefined") {
    const raw = JSON.stringify(next);
    window.localStorage.setItem(STORAGE_KEY, raw);
    cache = { raw, value: next };
  } else {
    cache = { raw: null, value: next };
  }
  notify();
}

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

// Same shape as auth.ts's `subscribe`: the native `storage` event only
// fires in *other* tabs/documents when localStorage changes, never in the
// tab that made the write (that tab already knows via `notify()` inside
// `writeQueue`) — registering it here is what makes another tab's queue
// mutation show up here without a reload.
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function getServerSnapshot(): QueuedItem[] {
  return EMPTY_QUEUE;
}

function makeClientId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `offline-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function currentUserId(): number | null {
  return getSession()?.user.id ?? null;
}

export function enqueueMessage(
  chatId: number,
  values: { contentType: MessageContentType; content: string },
): void {
  writeQueue([
    ...readQueue(),
    {
      kind: "message",
      clientId: makeClientId(),
      ownerId: currentUserId(),
      chatId,
      contentType: values.contentType,
      content: values.content,
      createdAt: Date.now(),
      status: "pending",
    },
  ]);
}

export function enqueuePost(values: {
  contentType: PostContentType;
  content: string;
}): void {
  writeQueue([
    ...readQueue(),
    {
      kind: "post",
      clientId: makeClientId(),
      ownerId: currentUserId(),
      contentType: values.contentType,
      content: values.content,
      createdAt: Date.now(),
      status: "pending",
    },
  ]);
}

export function dismissQueuedItem(clientId: string): void {
  writeQueue(readQueue().filter((item) => item.clientId !== clientId));
}

// Resets a "failed" item back to "pending" so the next replay picks it up
// again — replay itself never automatically retries a failed item (a
// rejected mutation, e.g. a deleted chat, would just fail the same way
// forever), so this is the only way a failed item re-enters the queue.
export function retryQueuedItem(clientId: string): void {
  writeQueue(
    readQueue().map((item) =>
      item.clientId === clientId
        ? { ...item, status: "pending", error: undefined }
        : item,
    ),
  );
}

// Only ever surfaces items owned by whoever is currently logged in — never
// another account's queued-but-unsent work that happens to still be sitting
// in this browser's localStorage (see the `Owned` comment above).
export function useQueuedMessages(chatId: number): QueuedMessage[] {
  const all = useSyncExternalStore(subscribe, readQueue, getServerSnapshot);
  const session = useSession();
  const ownerId = session?.user.id ?? null;
  return useMemo(
    () =>
      all.filter(
        (item): item is QueuedMessage =>
          item.kind === "message" &&
          item.chatId === chatId &&
          item.ownerId === ownerId,
      ),
    [all, chatId, ownerId],
  );
}

export function usePendingPosts(): QueuedPost[] {
  const all = useSyncExternalStore(subscribe, readQueue, getServerSnapshot);
  const session = useSession();
  const ownerId = session?.user.id ?? null;
  return useMemo(
    () =>
      all.filter(
        (item): item is QueuedPost =>
          item.kind === "post" && item.ownerId === ownerId,
      ),
    [all, ownerId],
  );
}

const REPLAY_LOCK_NAME = "chat-platform-offline-queue-replay";
// Only used as a fallback where the Web Locks API isn't available — with
// it, `navigator.locks.request` below already serializes concurrent calls
// (including ones from other tabs), so this flag is redundant there.
let fallbackReplaying = false;

// Walks the queue oldest-first, sending each item for real and removing it
// on success. Stops immediately on a network-level failure (still offline —
// the remaining items stay queued for the next reconnect) but keeps going
// past a genuine server rejection (marks that one item "failed" and moves
// on), so one bad item can't wedge every message/post behind it forever.
// Only ever sends items owned by whoever is currently logged in, so a
// leftover queued item from a previous account on this browser can't be
// sent (or published) under the wrong session — it just stays queued until
// its own owner logs back in (see the `Owned` comment above).
//
// Serialized via the Web Locks API (falling back to an in-memory flag where
// unavailable) rather than a plain module-level boolean: a boolean guard
// can't coordinate across browser tabs at all (two tabs reconnecting at once
// would both drain the same items and double-send them), and even within one
// tab it raced with a manual retry landing right as the current run was
// finishing (a `retryQueuedItem` + `replayQueue` call could both no-op while
// the retried item silently waited for the next connectivity change). The
// lock queues a second caller behind the first instead of dropping it, so
// both a cross-tab race and this in-tab one resolve the same way: whoever
// asks second just runs after, against the now-current state.
export async function replayQueue(queryClient: QueryClient): Promise<void> {
  if (typeof navigator !== "undefined" && "locks" in navigator) {
    await navigator.locks.request(REPLAY_LOCK_NAME, () =>
      drainQueue(queryClient),
    );
    return;
  }
  if (fallbackReplaying) return;
  fallbackReplaying = true;
  try {
    await drainQueue(queryClient);
  } finally {
    fallbackReplaying = false;
  }
}

async function drainQueue(queryClient: QueryClient): Promise<void> {
  for (;;) {
    const ownerId = currentUserId();
    const next = readQueue().find(
      (item) => item.status === "pending" && item.ownerId === ownerId,
    );
    if (!next) return;

    if (next.kind === "message") {
      let result: Awaited<ReturnType<typeof fetchClient.POST>>;
      try {
        result = await fetchClient.POST("/chats/{id}/messages", {
          params: { path: { id: String(next.chatId) } },
          body: { contentType: next.contentType, content: next.content },
        });
      } catch {
        return;
      }
      if (result.error) {
        writeQueue(
          readQueue().map((item) =>
            item.clientId === next.clientId
              ? {
                  ...item,
                  status: "failed",
                  error: errorMessage(result.error),
                }
              : item,
          ),
        );
        continue;
      }
      writeQueue(readQueue().filter((item) => item.clientId !== next.clientId));
      appendSentMessage(queryClient, next.chatId, result.data);
      void queryClient.invalidateQueries({ queryKey: chatsListQueryKey });
      void queryClient.invalidateQueries({
        queryKey: chatDetailQueryKey(next.chatId),
      });
    } else {
      let result: Awaited<ReturnType<typeof fetchClient.POST>>;
      try {
        result = await fetchClient.POST("/posts", {
          body: { contentType: next.contentType, content: next.content },
        });
      } catch {
        return;
      }
      if (result.error) {
        writeQueue(
          readQueue().map((item) =>
            item.clientId === next.clientId
              ? {
                  ...item,
                  status: "failed",
                  error: errorMessage(result.error),
                }
              : item,
          ),
        );
        continue;
      }
      writeQueue(readQueue().filter((item) => item.clientId !== next.clientId));
      void queryClient.invalidateQueries({ queryKey: postsFeedQueryKey });
    }
  }
}

// Mounted once near the root (see __root.tsx) — replays the queue whenever
// connectivity is (re)established, including at app boot if items were
// queued during a previous, now-closed session. Also re-runs on a session
// change: items queued by a user who was logged out (or a different user
// entirely) at the time are skipped by `drainQueue`'s owner check above, so
// logging back in as their owner needs its own trigger to pick them up
// rather than waiting for the next online/offline transition.
export function useOfflineQueueSync(): void {
  const queryClient = useQueryClient();
  const isOnline = useOnlineStatus();
  const session = useSession();
  const userId = session?.user.id ?? null;
  useEffect(() => {
    if (isOnline) void replayQueue(queryClient);
  }, [isOnline, userId, queryClient]);
}

export function OfflineQueueSync(): null {
  useOfflineQueueSync();
  return null;
}
