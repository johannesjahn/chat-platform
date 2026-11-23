# Games (`src/games/`)

The arcade under `/games`: endpoints in `src/api/games.ts`, combined in
`src/GamesHandler.ts`, handlers in `*Handlers.ts`, lobby loading in
`lobbyStore.ts`, settling in `settlement.ts`. Everything is shared plumbing
keyed by a game slug (`GameId`).

- **Lobbies are rows, phases are derived.** `game_lobbies` /
  `game_lobby_players` (`0026`) record only what players did (host started
  at `startsAt`, a player finished in `durationMs`). The phase (waiting →
  countdown → racing → finished) is computed from the clock at read time
  (`lobbyPhase`), so every replica agrees and no instance owns a lobby.
- **Scores are server-side only.** A typing finish submits the typed text
  and a wrong-keystroke count; the server checks it against the passage,
  times it off its own clock, and rejects anything faster than
  `MAX_PLAUSIBLE_WPM`. Accepted finishes land in `game_results` (no FK, it
  outlives the lobby) and feed `GET /games/:game/leaderboard`.
- **Live updates use named rooms**: `game-hub:<game>` for the lobby browser,
  `game-lobby:<id>` for one lobby, carrying id-only
  `game_lobby_updated`/`game_lobbies_changed` events (clients refetch).
  Racer positions go the other way: `game_progress` frames up the socket,
  relayed to the lobby room stamped with the socket's own user id; never
  persisted or scored, rate-limited per connection (`makeIncomingHandler`
  in `src/RealtimeSocket.ts`).

## Adding a game

1. Add its slug to `GameId` (`src/api/games.ts`).
2. Add a `GameRules` module beside `typing.ts` and register it in
   `GAME_RULES` (`rules.ts`): a `"race"` (every finish scored as it lands)
   or its own kind, with seat bounds and `chatDuringPlay`.
3. Add its entry to `GAMES` in `web/src/lib/games/registry.ts` (name, copy,
   how-to steps, icon, two-color theme).
4. Register its play area in `PLAY_AREAS` in
   `web/src/routes/games/$game/$lobbyId.tsx` (optionally `LOBBY_SETTINGS`
   and `RESULTS_EXTRAS`).

The lobby browser, waiting room, countdown, podium and leaderboard come from
`web/src/components/games/`, which reads colors from the
`--game-from`/`--game-to`/`--game-glow` custom properties ("Games design
system" in `web/src/styles.css`).

## Lobby chat and reactions

Every lobby page has a chat and a reaction bar (`LobbyChat`,
`ReactionStream`), for players and spectators.

- **Chat is persisted per lobby**: `game_lobby_messages` (`0029`) cascades
  with its lobby. `GET/POST /games/lobbies/:id/chat` read the newest
  `GAME_CHAT_PAGE_SIZE` lines (hiding authors the reader blocked/muted) and
  post one (rate-limited); a post publishes an id-only `game_chat` event.
- **Chat closes during play when the game has secrets**: `chatOpen` is true
  while waiting or finished, and during play only with `chatDuringPlay`.
  The server rejects posts while closed.
- **Reactions are relayed, never stored**: a `game_reaction` frame, handled
  like `game_progress`. Only the fixed set in `reactions.ts` is relayed;
  the client's `GAME_REACTIONS` (`web/src/lib/games/reactions.ts`) lists
  the same emoji.

## Reflex Rush (`reflex`)

Eight short rounds (Quick draw, Decoys, Snap, Arrows, Bullseye), solo or up
to six. Rules and scoring: `reflex.ts`; client:
`web/src/components/games/reflex/` and `web/src/lib/games/reflex.ts`.

- **One seed, one schedule**: starting stores a secure random seed in the
  lobby's `passage` column (never sent out); `buildReflexPlan` expands it
  into every round's kind and exact signal, decoy and target times, played
  off the server-corrected clock so everyone gets each signal at once.
- **The client measures, the server judges**: one submission per game
  (`POST /games/lobbies/:id/reflex`). Reaction time is measured from the
  frame the signal was painted to the press's `event.timeStamp` (signals are
  never faded in; a Snap round's right symbol arrives like the wrong ones).
  The server scores: under `ANTICIPATION_MS` is a false start, an arrow must
  match, a hit must land on the target. A reported false start is trusted,
  since it can only cost points.
- **Places settle at the end** via the lazy, `settled_round`-guarded
  `settleIfOver`, once everyone's in or `endsAt` passes. Per-round detail is
  in `game_lobby_players.detail` (`0030`).
- **Live rows ride `game_progress`**: `(round + 1) * 1000 + code`
  (`encodeLiveResult`), display only. The client mirrors the scoring
  constants; keep them in step.
