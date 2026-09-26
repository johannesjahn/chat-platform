import type { CSSProperties } from "react";
import { Brain, Keyboard, Zap, type LucideIcon } from "lucide-react";
import type { components } from "@/lib/api-types";

export type GameId = components["schemas"]["GameId"];

// Every game's look and copy, in one place. The game-shell components in
// components/games read a game's `theme` (via `gameThemeStyle`) instead of
// hard-coding colors, so a new game only has to add an entry here — and its
// slug to `GameId` on the backend (src/Api.ts) — to get the whole kit: hub
// card, page header, lanes, podium, and leaderboard in its own accent.
export type GameTheme = {
  // Two ends of the game's signature gradient, plus the soft glow its
  // surfaces cast. oklch, to sit alongside the app's own tokens.
  readonly from: string;
  readonly to: string;
  readonly glow: string;
};

type PlayableGame = {
  readonly status: "live";
  readonly id: GameId;
};

type UpcomingGame = {
  readonly status: "soon";
  readonly id: string;
};

export type GameDefinition = (PlayableGame | UpcomingGame) & {
  readonly name: string;
  readonly tagline: string;
  readonly description: string;
  readonly icon: LucideIcon;
  readonly theme: GameTheme;
  readonly players: string;
  // What the game's headline score is called (the leaderboard's column and
  // each result card's big number).
  readonly scoreLabel: string;
  readonly scoreUnit: string;
};

export const GAMES: ReadonlyArray<GameDefinition> = [
  {
    status: "live",
    id: "typing",
    name: "Type Race",
    tagline: "Fastest fingers win",
    description:
      "Race up to five friends to type a passage first. Watch every opponent's lane move live, then climb the leaderboard.",
    icon: Keyboard,
    theme: {
      from: "oklch(0.72 0.17 200)",
      to: "oklch(0.64 0.24 300)",
      glow: "oklch(0.68 0.2 250 / 0.35)",
    },
    players: "1–6 players",
    scoreLabel: "Words per minute",
    scoreUnit: "WPM",
  },
  {
    status: "soon",
    id: "trivia",
    name: "Trivia Blitz",
    tagline: "Know it, buzz it",
    description:
      "Rapid-fire questions, one buzzer, no second chances. Coming to the arcade soon.",
    icon: Brain,
    theme: {
      from: "oklch(0.8 0.16 85)",
      to: "oklch(0.68 0.22 30)",
      glow: "oklch(0.75 0.18 60 / 0.3)",
    },
    players: "2–8 players",
    scoreLabel: "Points",
    scoreUnit: "pts",
  },
  {
    status: "soon",
    id: "reflex",
    name: "Reflex Duel",
    tagline: "Blink and you lose",
    description:
      "Wait for the signal, then strike. Milliseconds decide it. Coming to the arcade soon.",
    icon: Zap,
    theme: {
      from: "oklch(0.8 0.2 145)",
      to: "oklch(0.7 0.16 190)",
      glow: "oklch(0.75 0.18 165 / 0.3)",
    },
    players: "2 players",
    scoreLabel: "Reaction time",
    scoreUnit: "ms",
  },
];

export function getGame(id: GameId): GameDefinition & PlayableGame {
  const game = GAMES.find((entry) => entry.id === id);
  if (!game || game.status !== "live") {
    throw new Error(`Unknown game: ${id}`);
  }
  return game as GameDefinition & PlayableGame;
}

// The custom properties every game-shell component reads (`--game-from`,
// `--game-to`, `--game-glow`, see the `game-*` utilities in styles.css). Set
// once on a game page's root, inherited by everything inside it.
export function gameThemeStyle(theme: GameTheme): CSSProperties {
  return {
    "--game-from": theme.from,
    "--game-to": theme.to,
    "--game-glow": theme.glow,
  } as CSSProperties;
}
