# Games UI kit

Shared lobby browser, waiting room, countdown, podium, leaderboard, lobby
chat and reactions for every game. Game rules, the adding-a-game checklist
and lobby/reaction rules are in `src/games/CLAUDE.md`; Sketchy's in
`src/games/drawing/CLAUDE.md`.

- Read a game's colors from the `--game-from`/`--game-to`/`--game-glow`
  custom properties ("Games design system" in `web/src/styles.css`); the
  values come from the game's theme in `web/src/lib/games/registry.ts`.
- `GAME_REACTIONS` (`web/src/lib/games/reactions.ts`) lists the same emoji
  as the server's `src/games/reactions.ts`.
