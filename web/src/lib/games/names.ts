// Every game's display name, apart from registry.ts (issue #754): a game
// route's `head` names its game in the document title, and route options
// other than the component stay in the entry chunk — importing the registry
// there shipped every game's copy, theme and icons to every cold load.
// registry.ts takes its `name`s from here, so the two can't drift.
export const GAME_NAMES = {
  typing: "Type Race",
  drawing: "Sketchy",
  reflex: "Reflex Rush",
  trivia: "Trivia Blitz",
} as const;

// A game's name for the document title, from an unvalidated URL slug — the
// route's `head` runs before its component checks the slug, so an unknown
// one falls back to the arcade's name rather than throwing like `getGame`.
export function gameTitle(slug: string): string {
  return Object.hasOwn(GAME_NAMES, slug)
    ? GAME_NAMES[slug as keyof typeof GAME_NAMES]
    : "Arcade";
}
