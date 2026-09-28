import { useLayoutEffect, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";
import { PlaceBadge } from "@/components/games/PlaceBadge";
import { CountUp } from "@/components/reactbits/CountUp";
import { cn } from "@/lib/utils";
import { castLabel, type Cast } from "@/lib/games/cast";
import { CastAvatar } from "./shared";

type Score = { userId: number; score: number };

// Standard competition ranking, as the server places the final podium.
const rankOf = (scores: ReadonlyArray<Score>, score: number): number =>
  1 + scores.filter((entry) => entry.score > score).length;

const ranksOf = (scores: ReadonlyArray<Score>) =>
  new Map(scores.map((entry) => [entry.userId, rankOf(scores, entry.score)]));

// The running scores, which only move when a reveal finishes playing out.
// When they do, rows *glide* to their new places rather than jumping —
// a FLIP animation: measure where every row was, let React reorder them,
// then play each one from its old position back to zero — and each score
// rolls up to its new total, a climber flagged with an arrow.
export function Scoreboard({
  scores,
  cast,
  meId,
}: {
  scores: ReadonlyArray<Score>;
  cast: Cast;
  meId: number | undefined;
}) {
  const rows = useRef(new Map<number, HTMLLIElement>());
  const lastTop = useRef(new Map<number, number>());
  const order = scores.map((entry) => entry.userId).join(",");

  // Who climbed with the latest change of scores — kept until the next one.
  const signature = scores.map((e) => `${e.userId}:${e.score}`).join(",");
  const [tracked, setTracked] = useState(() => ({
    signature,
    ranks: ranksOf(scores),
    climbed: new Set<number>(),
  }));
  if (tracked.signature !== signature) {
    const ranks = ranksOf(scores);
    setTracked({
      signature,
      ranks,
      climbed: new Set(
        [...ranks]
          .filter(([id, rank]) => rank < (tracked.ranks.get(id) ?? rank))
          .map(([id]) => id),
      ),
    });
  }

  useLayoutEffect(() => {
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    for (const [userId, node] of rows.current) {
      const top = node.offsetTop;
      const before = lastTop.current.get(userId);
      lastTop.current.set(userId, top);
      if (reduced || before === undefined || before === top) continue;
      node.animate(
        [{ transform: `translateY(${before - top}px)` }, { transform: "none" }],
        { duration: 650, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      );
    }
  }, [order]);

  return (
    <ol className="flex flex-col gap-1.5" aria-label="Scores">
      {scores.map((entry) => {
        const rank = rankOf(scores, entry.score);
        const isMe = entry.userId === meId;
        return (
          <li
            key={entry.userId}
            ref={(node) => {
              if (node) rows.current.set(entry.userId, node);
              else rows.current.delete(entry.userId);
            }}
            className={cn(
              "relative flex items-center gap-2.5 rounded-xl px-2.5 py-1.5",
              isMe
                ? "game-ring bg-[color-mix(in_oklch,var(--game-from),transparent_90%)]"
                : "bg-background/40",
            )}
          >
            {entry.score > 0 ? (
              <PlaceBadge place={rank} size="sm" />
            ) : (
              // Nobody has a place before they've scored — a row of gold
              // medals for a 0-0-0 tie says nothing.
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-[11px] text-muted-foreground">
                –
              </span>
            )}
            <CastAvatar cast={cast} userId={entry.userId} size="sm" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {castLabel(cast, entry.userId)}
            </span>
            {tracked.climbed.has(entry.userId) && (
              <ArrowUp
                aria-label="Climbed"
                className="size-3.5 text-emerald-400 motion-safe:animate-badge-pop"
              />
            )}
            <span className="text-sm font-bold tabular-nums">
              <CountUp value={entry.score} duration={900} />
            </span>
          </li>
        );
      })}
    </ol>
  );
}
