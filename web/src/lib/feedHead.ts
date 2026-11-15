import { useEffect, useSyncExternalStore } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { acquireGameRoom } from "./games/rooms";
import { isPostCached, loadNewestFeedPage } from "./postSync";

// "New posts" for the feed (issue #827). The server no longer pushes every
// new post to every client — that made each post one feed request per online
// user. Instead, while the feed is on screen this client sits in the `feed`
// room and gets a coalesced `feed_head` (the ids posted since the last one,
// at most one event every few seconds — see FeedHeadEvent in
// src/Realtime.ts). Ids it doesn't have yet are remembered here, the feed
// shows a pill, and only using the pill fetches anything.

const FEED_ROOM = "feed";

const pending = new Set<number>();
const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
  version++;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Called for each `feed_head`. Ids already in the cache (this client's own
// post, which its create wrote there) aren't new to it.
export function noteFeedHead(
  queryClient: QueryClient,
  postIds: ReadonlyArray<number>,
): void {
  let added = false;
  for (const id of postIds) {
    if (pending.has(id) || isPostCached(queryClient, id)) continue;
    pending.add(id);
    added = true;
  }
  if (added) emit();
}

// How many announced posts this client hasn't loaded. Re-checked against the
// cache on every render, so a post that arrived another way (a refetch, its
// own create landing after the announcement) stops counting.
export function useNewFeedPostCount(queryClient: QueryClient): number {
  useSyncExternalStore(subscribe, () => version);
  let count = 0;
  for (const id of pending) if (!isPostCached(queryClient, id)) count++;
  return count;
}

// Fetches the feed's newest page and folds it on top (what a new post used
// to trigger on its own), then forgets what was pending. The count can
// overstate what appears: a post by someone the reader blocked or muted is
// announced but filtered out by the server.
export async function showNewFeedPosts(
  queryClient: QueryClient,
): Promise<void> {
  await loadNewestFeedPage(queryClient);
  pending.clear();
  emit();
}

// Joins the feed room while the feed is mounted.
export function useFeedRoom(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    return acquireGameRoom(FEED_ROOM, 0);
  }, [enabled]);
}
