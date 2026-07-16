import { useEffect } from "react";

// Bridges the comment-section components to the single `/ws` connection owned
// by `useRealtimeSocket`. A component viewing a post's comments "joins" that
// post's realtime room by sending a `subscribe_post_comments` control message
// over the socket (see src/RealtimeSocket.ts) so it receives scoped
// `comment_changed`/`like_changed` events instead of relying on the feed-wide
// broadcast. Membership is ref-counted per postId so two components watching
// the same post share one server-side subscription, and desired
// subscriptions are re-sent whenever the socket (re)connects.

let currentSocket: WebSocket | null = null;
// postId -> number of live subscribers on this client.
const desired = new Map<number, number>();

function send(type: string, postId: number): void {
  if (currentSocket && currentSocket.readyState === WebSocket.OPEN) {
    currentSocket.send(JSON.stringify({ type, postId }));
  }
}

// Called by `useRealtimeSocket` when a socket opens (with the socket) and when
// it closes (with null). On open, every post room this client still wants is
// re-subscribed — the previous socket's server-side membership died with it.
export function setRealtimeSocket(socket: WebSocket | null): void {
  currentSocket = socket;
  if (socket) {
    for (const postId of desired.keys()) {
      send("subscribe_post_comments", postId);
    }
  }
}

function acquire(postId: number): () => void {
  const count = desired.get(postId) ?? 0;
  desired.set(postId, count + 1);
  if (count === 0) send("subscribe_post_comments", postId);
  return () => {
    const current = desired.get(postId) ?? 0;
    if (current <= 1) {
      desired.delete(postId);
      send("unsubscribe_post_comments", postId);
    } else {
      desired.set(postId, current - 1);
    }
  };
}

// Subscribe to a post's comment room for as long as this component is mounted
// and `enabled`. Safe to call with `enabled: false` (a no-op) so a component
// can gate the subscription on its comment section actually being open.
export function usePostCommentsSubscription(
  postId: number,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled) return;
    return acquire(postId);
  }, [postId, enabled]);
}
