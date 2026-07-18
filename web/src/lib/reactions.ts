import type { components } from "./api-types";

export type ReactionSummary = components["schemas"]["ReactionSummary"];
export type ReactionEmoji = components["schemas"]["ReactionEmoji"];

// Mirrors REACTION_EMOJIS in src/Api.ts by hand — same convention as
// RealtimeSocketEvent in realtimeSocket.ts mirroring src/Realtime.ts's
// RealtimeEvent — since there's no generated union-of-literals export from
// the OpenAPI schema to import directly. This is the fixed set the "add a
// reaction" picker offers; it's independent of which emojis a given post/
// comment's `reactions` array happens to already contain.
export const REACTION_EMOJIS: readonly ReactionEmoji[] = [
  "👍",
  "❤️",
  "😂",
  "😮",
  "😢",
  "😡",
];

// Finds the current user's own reaction summary for one emoji on a target, or
// a zero/false default if nobody (or not this user) has reacted with it —
// the API only returns entries for emojis with at least one reaction (see
// ReactionSummary in src/reactions.ts).
export function reactionOf(
  reactions: ReadonlyArray<ReactionSummary>,
  emoji: string,
): ReactionSummary {
  return (
    reactions.find((r) => r.emoji === emoji) ?? {
      emoji,
      count: 0,
      reactedByMe: false,
    }
  );
}

// Reconciles a post's cached `reactions` with the aggregate counts carried on
// a `reaction_changed` realtime event. The event is broadcast to every
// connected client and so can only ever carry counts, never `reactedByMe`
// (see ReactionEvent in src/Realtime.ts) — that field is preserved from
// whatever this client last knew for a given emoji (its own mutation
// response is what actually updates it, for the acting client).
export function mergeReactionCounts(
  previous: ReadonlyArray<ReactionSummary>,
  counts: ReadonlyArray<{ readonly emoji: string; readonly count: number }>,
): ReactionSummary[] {
  return counts.map(({ emoji, count }) => ({
    emoji,
    count,
    reactedByMe: reactionOf(previous, emoji).reactedByMe,
  }));
}
