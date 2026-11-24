# Sketchy (the `drawing` game, issue #440)

Drawful-style: everyone draws a secret prompt, then each drawing takes a
turn in the spotlight: bluff (write a fake title), vote (find the real one),
reveal. Pure modules here (`timeline`, `ballot`, `scoring`, `view`,
`prompts`) are fed rows by `src/games/drawingHandlers.ts` and
`src/games/lobbyStore.ts`; the client is `web/src/components/games/drawing/`.

- **Stages are derived, like phases.** `buildTimeline` lays the game out
  from `startsAt` and the `game_drawings`/`game_bluffs`/`game_votes` rows:
  each stage runs its full timer _or_ ends at its last required
  submission. A submission is accepted only while its stage is current (the
  draw stage has a short grace), and bluffs/votes are stamped with the
  instant that was checked, so a finished stage never moves. The players are
  frozen by the drawings dealt at start: someone leaving just times out.
- **Secrets live in one place.** `projectDrawingGame` (`view.ts`) is the
  only code that turns rows into what a viewer sees: prompts only at their
  reveal (the artist always knows theirs), strokes from the bluff stage, a
  ballot with nothing that marks the truth, authorship/votes only at the
  reveal, ordered by a per-drawing `shuffle_seed` that's never sent out.
  Realtime stays id-only. `src/sketchy.test.ts` asserts no response or
  published event leaks a prompt; keep it passing.
- **Scoring settles lazily, exactly once**: the first read to find a game
  over writes `game_results` in a transaction guarded by
  `game_lobbies.settled_round`. A rematch settles first, then deletes the
  game's drawings (cascading to bluffs/votes).
- **Packs are code** (`packs/`, 60+ ASCII prompts each, enforced by
  `drawing.test.ts`). `GET /games/drawing/packs` returns samples and counts,
  never the prompt lists.
- **Stroke colors are palette indexes**: the client's `DRAWING_PALETTE`
  stays exactly `DRAWING_PALETTE_SIZE` long, in its existing order.
