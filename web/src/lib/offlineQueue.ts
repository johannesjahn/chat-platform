import { useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { fetchClient } from "./api";
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

export type QueuedMessage = {
  kind: "message";
  clientId: string;
  chatId: number;
  contentType: MessageContentType;
  content: string;
  createdAt: number;
  status: QueuedItemStatus;
  error?: string;
};

export type QueuedPost = {
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

function loadQueue(): QueuedItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QueuedItem[]) : [];
  } catch {
    return [];
  }
}

let queue: QueuedItem[] = loadQueue();
const listeners = new Set<() => void>();

function persist(): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
}

function setQueue(next: QueuedItem[]): void {
  queue = next;
  persist();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): QueuedItem[] {
  return queue;
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

export function enqueueMessage(
  chatId: number,
  values: { contentType: MessageContentType; content: string },
): void {
  setQueue([
    ...queue,
    {
      kind: "message",
      clientId: makeClientId(),
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
  setQueue([
    ...queue,
    {
      kind: "post",
      clientId: makeClientId(),
      contentType: values.contentType,
      content: values.content,
      createdAt: Date.now(),
      status: "pending",
    },
  ]);
}

export function dismissQueuedItem(clientId: string): void {
  setQueue(queue.filter((item) => item.clientId !== clientId));
}

// Resets a "failed" item back to "pending" so the next replay picks it up
// again — replay itself never automatically retries a failed item (a
// rejected mutation, e.g. a deleted chat, would just fail the same way
// forever), so this is the only way a failed item re-enters the queue.
export function retryQueuedItem(clientId: string): void {
  setQueue(
    queue.map((item) =>
      item.clientId === clientId
        ? { ...item, status: "pending", error: undefined }
        : item,
    ),
  );
}

export function useQueuedMessages(chatId: number): QueuedMessage[] {
  const all = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return useMemo(
    () =>
      all.filter(
        (item): item is QueuedMessage =>
          item.kind === "message" && item.chatId === chatId,
      ),
    [all, chatId],
  );
}

export function usePendingPosts(): QueuedPost[] {
  const all = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return useMemo(
    () => all.filter((item): item is QueuedPost => item.kind === "post"),
    [all],
  );
}

let replaying = false;

// Walks the queue oldest-first, sending each item for real and removing it
// on success. Stops immediately on a network-level failure (still offline —
// the remaining items stay queued for the next reconnect) but keeps going
// past a genuine server rejection (marks that one item "failed" and moves
// on), so one bad item can't wedge every message/post behind it forever.
export async function replayQueue(queryClient: QueryClient): Promise<void> {
  if (replaying) return;
  replaying = true;
  try {
    for (;;) {
      const next = queue.find((item) => item.status === "pending");
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
          setQueue(
            queue.map((item) =>
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
        setQueue(queue.filter((item) => item.clientId !== next.clientId));
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
          setQueue(
            queue.map((item) =>
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
        setQueue(queue.filter((item) => item.clientId !== next.clientId));
        void queryClient.invalidateQueries({ queryKey: postsFeedQueryKey });
      }
    }
  } finally {
    replaying = false;
  }
}

// Mounted once near the root (see __root.tsx) — replays the queue whenever
// connectivity is (re)established, including at app boot if items were
// queued during a previous, now-closed session.
export function useOfflineQueueSync(): void {
  const queryClient = useQueryClient();
  const isOnline = useOnlineStatus();
  useEffect(() => {
    if (isOnline) void replayQueue(queryClient);
  }, [isOnline, queryClient]);
}

export function OfflineQueueSync(): null {
  useOfflineQueueSync();
  return null;
}
