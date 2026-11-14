Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## Project layout

This is a two-package repo:

- **Backend** (repo root): Bun + Effect `HttpApi`, Drizzle ORM over `PGlite`
  by default (an embedded Postgres — `DB_PATH` data directory, unset =
  in-memory, auto-migrated on startup). Set `DATABASE_URL` to instead connect
  to a real Postgres over the wire via `drizzle-orm/bun-sql` (`Bun.sql`) — see
  [`src/Db.ts`](src/Db.ts). **Note:** when `DATABASE_URL` is set, migrations
  are _not_ run on boot (to avoid race conditions with multiple Kubernetes
  replicas — see issue #178). Run `bun run db:migrate` to apply migrations
  standalone; the Helm chart handles this automatically via a pre-upgrade Job
  (`backend-migration-job.yaml`), and `docker-compose.yml` runs a `db-migrate`
  one-shot service before booting the app. **Caveat:** this only prevents
  concurrent migration races — it does _not_ solve schema forward/backward
  compatibility during rolling deploys. Old-code replicas still run briefly
  against the already-migrated schema, so migrations must stay
  additive/backward-compatible (expand-contract pattern). Realtime (chat/post)
  events fan out through
  [`src/PubSub.ts`](src/PubSub.ts): an in-memory implementation by default
  (correct for a single process), or Redis Pub/Sub (`Bun.redis`) when
  `REDIS_URL` is set, so multiple horizontally-scaled instances share events
  — see [`src/Realtime.ts`](src/Realtime.ts). `docker compose up` (see
  [`docker-compose.yml`](docker-compose.yml) and [`Dockerfile`](Dockerfile))
  runs a real Postgres, Redis, and Garage (S3-compatible attachment storage —
  see [`src/AttachmentStorage.ts`](src/AttachmentStorage.ts)) plus the backend
  wired to all three. Sources in `src/`.
- **Frontend** (`web/`): TanStack Start (React) in SPA mode, calling the backend
  over HTTP. Has its own `package.json`.

## Search

Search (`GET /search`, plus `/search/{users,posts,comments,messages}`) is built
on two index-served match branches, defined in [`src/search.ts`](src/search.ts)
and assembled in [`src/SearchHandler.ts`](src/SearchHandler.ts):

- a **word/prefix** branch over the generated `tsvector` columns (GIN, migration
  `0017`), which brings stemming and as-you-type prefix matching;
- a **substring** branch (`ILIKE '%token%'`) over `pg_trgm` GIN indexes
  (migration `0023`), which is what makes matching a fragment _inside_ a word
  possible at all.

Two things about this are load-bearing, not stylistic:

- The branches are combined as a **union of per-branch subqueries, never an
  `OR`**. Under an `OR` with `ORDER BY id DESC LIMIT n`, Postgres cannot use
  either index and falls back to a backward primary-key scan that re-evaluates
  both predicates per row — measured at 20k posts, a rare term took 37ms as an
  `OR` and 9ms as a union, and that gap grows with the table. Every filter
  (content type, keyset cursor, blocked authors, chat participation) must live
  _inside_ each arm; applied outside, it would shrink a page instead of pushing
  it deeper. See `matchingIds` in SearchHandler.ts.
- `pg_trgm` is a contrib extension. On a real Postgres the migration's
  `CREATE EXTENSION` is enough (it's a _trusted_ extension since PG13, so no
  superuser), but **PGlite needs the bundle registered when the instance is
  created** — hence `createPglite` in [`src/Db.ts`](src/Db.ts), which both the
  app and [`src/testDb.ts`](src/testDb.ts) go through. Creating a PGlite
  instance any other way makes migration `0023` fail.

Snippets/highlighting are built in TypeScript (`buildSnippet` in
`src/search.ts`), not with `ts_headline`: it costs a re-parse of every result
row server-side, and it can only highlight what the _tsquery_ matched, which
would leave a pure substring hit unhighlighted.

**Contacts below the 3-character floor.** User search needs 3 characters
(issue #48) so the directory can't be browsed. Below that, New chat, `/users`
and the palette's People section suggest `GET /users/contacts` (`contactsOf`
in [`src/users/directoryHandlers.ts`](src/users/directoryHandlers.ts), issue #764), filtered
client-side by `filterContacts` ([`web/src/lib/contactFilter.ts`](web/src/lib/contactFilter.ts)).
It must only ever return people the caller already shares an **accepted**
chat with (pending message requests on either side don't count), minus
blocks in either direction (mutes stay), newest chat activity first, capped
at `MAX_CONTACTS`.

## Admin dashboard

`GET /admin/stats` (admin-only, 403 otherwise) backs the operator dashboard at
`/admin` in the frontend — [`src/AdminHandler.ts`](src/AdminHandler.ts), rendered
by [`web/src/routes/admin.tsx`](web/src/routes/admin.tsx). It returns lifetime
totals, per-window activity (1d/7d/30d), a zero-filled daily timeline, and live
dependency/runtime health in one response.

Two constraints on it are deliberate:

- **Aggregates only — no per-user breakdown.** No "most active users" panel, no
  per-user series. This is the same GDPR-driven scoping the `active_users` gauge
  and the rest of the domain metrics in [`src/Metrics.ts`](src/Metrics.ts)
  already follow; `activeUsers` is a `UNION`-then-count so the id set never
  leaves Postgres.
- **The `health` block is _this process's_ counters**, read off the same
  `effect/Metric` registry `/metrics` renders. With more than one replica it
  reflects whichever instance served the request — Prometheus/Grafana stays the
  deployment-wide view.

Migration `0025` adds `users.created_at` (there was no signup timestamp before).
Unlike every other `created_at` it carries a **database** default rather than an
app-side one, because mid-rollout old replicas insert users without the column —
see the comment on it in [`src/db/schema.ts`](src/db/schema.ts). Rows predating
the migration all read as having signed up when it ran.

## Games (arcade)

Multiplayer games live under `/games` in the frontend, backed by the `games`
group in [`src/api/games.ts`](src/api/games.ts) and
[`src/GamesHandler.ts`](src/GamesHandler.ts) (handlers in `src/games/*Handlers.ts`,
lobby loading in `lobbyStore.ts`, settling in `settlement.ts`). The first game
is a typing race;
everything else is shared plumbing keyed by a game slug (`GameId`):

- **Lobbies are rows, phases are derived.** `game_lobbies`/`game_lobby_players`
  (migration `0026`) record only what players _did_ (host started at
  `startsAt`, a player finished in `durationMs`). The phase clients render —
  waiting → countdown → racing → finished — is computed from the clock at read
  time (`lobbyPhase`), never written by a timer, so it's correct on every
  replica with no instance owning a lobby.
- **Scores are server-side only.** A finish submits the typed text plus a
  wrong-keystroke count; the server checks the text against the passage, times
  it off its own clock, and rejects anything faster than `MAX_PLAUSIBLE_WPM`.
  Accepted finishes land in `game_results` (which outlives its lobby — no FK)
  and feed `GET /games/:game/leaderboard`.
- **Live updates use named realtime rooms** (`subscribeRoom`/`notifyRoom` in
  [`src/Realtime.ts`](src/Realtime.ts), `subscribe_room` over `/ws`):
  `game-hub:<game>` for the lobby browser, `game-lobby:<id>` for one lobby.
  Lobby changes are id-only `game_lobby_updated`/`game_lobbies_changed`
  events (clients refetch). Racer positions stream the other way: the client
  sends `game_progress` frames up the socket and the server relays them to the
  lobby room stamped with the socket's own user id — never persisted, never
  scored, rate-limited per connection (see `makeIncomingHandler` in
  [`src/RealtimeSocket.ts`](src/RealtimeSocket.ts)).

**Adding a game:** add its slug to `GameId` (api/games.ts); add a `GameRules`
module next to [`src/games/typing.ts`](src/games/typing.ts) and register it in
`GAME_RULES` ([`src/games/rules.ts`](src/games/rules.ts)) — a `"race"` (every
finish scored as it lands) or its own kind, with its seat bounds; add its
entry to `GAMES` in
[`web/src/lib/games/registry.ts`](web/src/lib/games/registry.ts) (name, copy,
how-to steps, icon, and a two-color theme); and register its play area in
`PLAY_AREAS` in `web/src/routes/games/$game/$lobbyId.tsx` (plus, optionally,
waiting-room settings in `LOBBY_SETTINGS` and a results extra in
`RESULTS_EXTRAS`). The lobby browser,
waiting room, countdown, results podium, and leaderboard come for free from
the shared kit in [`web/src/components/games/`](web/src/components/games/),
which reads the game's colors from the `--game-from`/`--game-to`/`--game-glow`
custom properties (see the "Games design system" block in
`web/src/styles.css`) instead of hard-coding them.

### Lobby chat and reactions

Every lobby page carries a chat and an emoji reaction bar (the shared
`LobbyChat`/`ReactionStream` in `web/src/components/games/`), for players and
spectators alike:

- **Chat is persisted, per lobby.** `game_lobby_messages` (migration `0029`)
  cascades with its lobby, so it's gone once the lobby is. `GET/POST
/games/lobbies/:id/chat` read the newest `GAME_CHAT_PAGE_SIZE` lines
  (hiding authors the reader blocked/muted) and post one (rate-limited per
  user); a post publishes an id-only `game_chat` event to the lobby room.
- **Chat closes during play when the game has secrets.** Each `GameRules`
  sets `chatDuringPlay`; the lobby's `chatOpen` is true while waiting or
  finished, and during play only if that's set. Sketchy clears it so nobody
  can type out their prompt; the server rejects posts while closed.
- **Reactions are relayed, never stored** — a `game_reaction` socket frame,
  handled like `game_progress` (only into a joined lobby room, stamped with
  the socket's user id, budgeted per connection). Only the fixed set in
  [`src/games/reactions.ts`](src/games/reactions.ts) is relayed, which is
  why they stay on mid-game; the client's `GAME_REACTIONS`
  (`web/src/lib/games/reactions.ts`) must list the same emoji.

### Sketchy (the `drawing` game, issue #440)

A Drawful-style party game: everyone draws a secret prompt, then each drawing
takes a turn in the spotlight — bluff (write a fake title), vote (find the
real one), reveal. Server logic is in
[`src/games/drawing/`](src/games/drawing/), kept as pure modules (`timeline`,
`ballot`, `scoring`, `view`, `prompts`) that `src/games/drawingHandlers.ts`
and `lobbyStore.ts` feed rows into;
the client is `web/src/components/games/drawing/`. Load-bearing rules:

- **Stages are derived, like phases.** `buildTimeline` lays the game out from
  `startsAt` and the `game_drawings`/`game_bluffs`/`game_votes` rows (migration
  `0028`): each stage runs its full timer _or_ ends at its last required
  submission. A submission is only accepted while its stage is current (the
  draw stage has a short grace), and bluffs/votes are stamped with the
  instant that was checked, so a stage that's over never moves again. The set
  of players is frozen by the drawings dealt at start, so someone leaving
  can't retroactively shift the schedule — they just time out.
- **Secrets live in one place.** `projectDrawingGame` (view.ts) is the only
  code that turns rows into what a viewer sees: prompts only at their reveal
  (the artist always knows theirs), strokes from the bluff stage, a ballot with
  nothing that marks the truth, authorship/votes only at the reveal. Its order
  comes from a random per-drawing `shuffle_seed` that's never sent out.
  `src/sketchy.test.ts` asserts no response or published event leaks a prompt
  — keep it passing when touching any of this. Realtime stays id-only.
- **Scoring is settled lazily, exactly once.** Scores are derived from votes;
  the first read to find a game over writes `game_results` in a transaction
  guarded by `game_lobbies.settled_round`. A rematch settles first, then
  deletes the game's drawings (cascading to bluffs/votes).
- **Packs are code** (`src/games/drawing/packs/`, 60+ ASCII prompts each, held
  to that by `drawing.test.ts`); `GET /games/drawing/packs` returns samples and
  counts, never the prompt lists. Stroke colors are palette indexes — the
  client's `DRAWING_PALETTE` must stay `DRAWING_PALETTE_SIZE` long and never be
  reordered.

### Reflex Rush (the `reflex` game)

A reaction game of eight short rounds — Quick draw (wait for green), Decoys
(fake signals first), Snap (hit only on your symbol), Arrows (press the
direction), Bullseye (hit the target) — playable solo or up to six at once.
Rules and scoring are the pure module [`src/games/reflex.ts`](src/games/reflex.ts);
the client is `web/src/components/games/reflex/` plus
[`web/src/lib/games/reflex.ts`](web/src/lib/games/reflex.ts). Load-bearing:

- **One seed, one schedule, every client.** Starting a game stores a secure
  random seed in the lobby's `passage` column (never sent out);
  `buildReflexPlan` expands it into every round's kind and exact signal,
  decoy, and target times, which clients play off the server-corrected
  clock — so everyone in a lobby gets each signal at the same instant.
- **The client measures, the server judges.** A player submits one tap per
  round at the end (`POST /games/lobbies/:id/reflex`). The reaction time is
  measured client-side (from the frame the signal was painted to the
  press's `event.timeStamp` — the signal is never faded in, and a Snap
  round's right symbol arrives exactly like the wrong ones), but only
  scored server-side: under `ANTICIPATION_MS` is a false start, an arrow
  must match, a hit must land on the target. A reported false start is
  taken on trust — it can only cost points.
- **Places settle at the end**, like Sketchy's: placing is by score, so
  results are written once everyone's in (or `endsAt` passes) by the lazy,
  `settled_round`-guarded `settleIfOver`. The per-round breakdown lives in
  `game_lobby_players.detail` (migration `0030`).
- **Live rows ride `game_progress`.** Each round's result is packed into the
  progress number (`(round + 1) * 1000 + code`, see `encodeLiveResult`) —
  display only; the client's mirrored scoring constants must track the
  server's.

## Media input restrictions

Every ffmpeg/ffprobe call in the upload pipeline goes through `runFfmpeg` or
`runFfprobe` in [`src/MediaInput.ts`](src/MediaInput.ts) (issues #732, #734),
which whitelist the protocol, demuxers and decoders, so an upload can't reach
`hls`, `concat` and the like, or any decoder off the list. `MediaInput.test.ts`
fails on a call anywhere else in `src/`. Load-bearing:

- **ffmpeg never sees the client's file name.** The multipart temp file keeps it,
  so `processVideo` works on a copy with a server-generated name.
- **Point ffprobe only at files you wrote.** It fails on any off-list stream, even
  an unselected one, where ffmpeg only fails on the streams it uses. Probing an
  upload would reject every MP3 with album art, which is why `processAudio`
  doesn't.
- **FLAC and raw AAC stay rejected on purpose:** neither is in
  `ALLOWED_ATTACHMENT_MIME_TYPES`, so they only arrive mislabelled. The 415 says
  the format isn't supported rather than calling the file invalid.

A new video or audio MIME type in `ALLOWED_ATTACHMENT_MIME_TYPES` needs its demuxer
and decoders checked in `MediaInput.ts`.

## Handler layout

The big groups — `chats`, `users`, `games` — are split by area (issue #811):
`src/ChatsHandler.ts`, `src/UsersHandler.ts` and `src/GamesHandler.ts` only
resolve the services and combine per-area handler maps from
[`src/chats/`](src/chats/), [`src/users/`](src/users/) and
[`src/games/`](src/games/) with `handlers.handleAll`, which fails to typecheck
if an endpoint is left unhandled. Each `*Handlers.ts` module returns its slice
`satisfies GroupHandlers<"group">` ([`src/handlerKit.ts`](src/handlerKit.ts),
aliased per group in its `handlerKit.ts` next to the group's `*Deps`), which
keeps the request parameters typed.

- **Put a new endpoint in the area it belongs to**, and a helper next to its
  only caller until a second area needs it; then it moves to that group's
  shared modules. For chats: `sendPath.ts` (the one send path —
  `insertMessage`, `directChatBlocked`, `publishNewMessage`), `access.ts` (404
  lookups and participation/role checks), `chatState.ts` (participants,
  `version`, `buildChat`), `messageViews.ts` (the `Message` view) and
  `unread.ts`. For users: `userViews.ts` and `credentials.ts`. For games:
  `lobbyStore.ts` and `settlement.ts`.
- **Handler modules never import each other.** Code another group needs lives
  in a library module: `enforceRateLimit` (RateLimiter.ts), avatar helpers
  (avatars.ts), `enforceUploadQuota` (attachments.ts), the `Post` view
  (posts.ts), the `User` view (users/userViews.ts). Helper modules never import
  handler modules.
- **Database calls go through `dbQuery`** ([`src/Db.ts`](src/Db.ts)): it runs
  one query/transaction thunk and dies on failure, the same as the
  `Effect.tryPromise(...).pipe(Effect.orDie)` it replaced — one place to add
  query spans or metrics. Code that deliberately keeps a database failure as a
  typed error (the best-effort writes in `notifications.ts`) keeps its
  `Effect.tryPromise`.
- **API schemas are split by area too**: `src/api/<area>.ts` holds that area's
  schemas, errors and endpoint group; `src/Api.ts` re-exports them all and
  assembles `ChatApi`, so code keeps importing from `Api.ts`. The `api/`
  modules build schemas at load time, so they must not import each other in
  a cycle: shared pieces go in `api/common.ts` (and errors in `api/errors.ts`).

## Forwarding messages

`POST /chats/:id/messages/:messageId/forward` (issue #601) posts a copy of a
message into up to `MAX_FORWARD_TARGETS` chats — `forwardMessage` in
[`src/chats/forwardHandlers.ts`](src/chats/forwardHandlers.ts), picked from
[`ForwardDialog`](web/src/components/chat/ForwardDialog.tsx). Load-bearing:

- **A forward is a new message owned by the forwarder**, built through the
  same `insertMessage`/`directChatBlocked`/`publishNewMessage` helpers as
  `createMessage` — don't fork the send path. It never copies
  `parentMessageId` (a parent is in another chat), reactions, reads, pins or
  stars.
- **Attribution is a snapshot.** `messages.forwarded_from_*` (migration
  `0034`) store the original sender's name at forward time, with `set null`
  FKs, so the label survives edits, deletes, renames and account deletion. A
  forward of a forward copies them through, so the label always credits the
  original author and never nests.
- **Attachments are copied, never shared.** The forward gets its own
  `attachments` row and storage object (`AttachmentStorage.copy`), owned by
  — and counted against the quota of — the forwarder, inserted in one
  transaction with the message; a failed step deletes the object it made.
  Sharing the row would break the "one message per attachment" invariant
  that delete, quota and `AttachmentCleanup` rely on.
- **Per-target results, not all-or-nothing.** The source must be in a chat
  the caller is in (404 otherwise, never 403); each target fails on its own
  (`unavailable`/`blocked`/`quota_exceeded`/`invalid_content`). A
  `clientId` keys each copy as `${clientId}:${targetChatId}`, so a replay
  only fills in the missing targets, and the request is charged N units of
  the global per-IP budget (`chargeGlobalRequests`) — a forward to N chats is
  N sends.

## Message requests

Being put in a group by someone you share no chat with makes it a _message
request_ for you (issue #785): `chat_participants.request_pending` and
`added_by` (migration `0038`), decided by `strangersTo` in
[`src/chats/membershipHandlers.ts`](src/chats/membershipHandlers.ts), accepted with
`POST /chats/:id/accept`, declined with the existing `/leave`. Load-bearing:

- **Per participant, not per chat.** The same group can be a request for one
  member and a normal chat for another. Direct chats and invite-link joins
  never create one.
- **A stranger is judged on accepted chats only.** `strangersTo` counts a
  shared chat only where the added user's row isn't pending, or one pending
  request would vouch for the next.
- **Pending means invisible.** Out of `GET /chats` (it's under
  `?requests=true`, the `/chats/requests` page), `unreadCount` 0 and nothing
  in `/chats/unread-count`, no presence either way (`PresenceAudience`), not
  a contact (`contactsOf`). Any new query over `chat_participants` that
  introduces people or counts unread must filter `request_pending = false`.
  That includes message search: the condition sits inside each arm of
  `matchingIds` (issue #808), per Search above.
- **Read-only until accepted** (issue #808). Every write that others would
  see — send, edit, typing, reactions, pins, claiming an ownerless group —
  goes through `requireAcceptedParticipant` (403); a forward into a request
  is that target's `unavailable`; `markRead` is a silent no-op, so viewing a
  request sends no receipt. Reading, private stars, forwarding _out_, leave
  and accept stay open. A new chat write must use the same guard.
- **`request_pending` defaults to `false` in the database**, like
  `users.created_at`, so old replicas' inserts and pre-migration rows read as
  accepted.
- **Owner hand-off prefers accepted members**, ahead of seniority.
- The client shows a request read-only with
  [`MessageRequestBar`](web/src/components/chat/MessageRequestBar.tsx) in
  place of the composer; "Decline and block" blocks `messageRequest.addedBy`.

## Attachment captions

Posts and messages carry an optional `caption` next to an attachment (issue
#765, migration `0037`). Load-bearing:

- **`content` stays the filename** on attachment rows, as on every row from
  before captions — never repurpose it as the caption.
- **`caption` only counts when `content_type = 'attachment'`.** An old
  replica can re-type a row and leave the column behind, so every reader goes
  through `captionOf` (posts.ts) / `messageCaption` (chats/messageViews.ts),
  and the search arms restrict on content type themselves.
- **Edits: omitted keeps, `null` clears**, so a client that predates captions
  never wipes one. Sending a `caption` on a non-attachment is a 400.
- **Search covers captions, never filenames**: extra _union arms_ over
  partial expression GIN indexes (tsvector + trigram), each with its own
  filters, per Search above.
- Captions notify `@mentions` on posts (not chats, as usual), are the
  notification excerpt, and are copied by a forward.

## Optimistic message sends

A chat message shows up in the thread the moment it's sent and the composer
clears straight away — it never waits on the POST. The composer's `onSend` is
fire-and-forget into the outbox ([`web/src/lib/outbox.ts`](web/src/lib/outbox.ts),
state machine in [`outboxStore.ts`](web/src/lib/outboxStore.ts)), which shows a
"sending" `PendingMessageBubble` and sends in the background. Load-bearing:

- **One request at a time per chat.** Bubbles appear at once, but sends go out
  in order, so two can't race and swap ids on the server.
- **Matched by `clientId`, both ways.** `Message.clientId` (only ever echoed to
  the message's own sender) is how the thread hides a pending bubble whose
  real message the realtime refetch already brought in — the server publishes
  `chat_updated` before it answers the POST, so that race is real. A confirmed
  message that was shown as a bubble first (`wasShownBeforeConfirm`) skips its
  entrance animation.
- **Separate from the offline queue, and handing off to it.** The outbox is
  in-memory (it outlives the conversation view, not a reload); a send that
  gets no response while offline moves to `lib/offlineQueue.ts` under the same
  `clientId`. A server rejection, or no response while still online, stays as
  a "failed" bubble with Retry (same `clientId`) and Discard.

## Disclosure motion

Anything that expands or collapses in place goes through one primitive so the
app opens and closes with a single motion language — never a bare
`{open && …}` that pops in and out:

- **Panels** — `<Collapse open>` ([`web/src/components/ui/collapse.tsx`](web/src/components/ui/collapse.tsx)):
  a `0fr`↔`1fr` grid-row transition that animates both ways, reverses
  mid-flight, unmounts once closed (or stays `hidden` with `keepMounted`),
  and glides when its content resizes while open. Pair it with
  `<DisclosureChevron open>`.
- **"Show more" text** — `useExpandableText` ([`web/src/lib/motion.ts`](web/src/lib/motion.ts)),
  which animates between the `line-clamp-*` height and the full one.
- **Popovers/menus** — `useTransitionState` keeps them mounted for
  `animate-pop-close`, the exit half of `animate-pop-open`.

Timing and curves live only in the `--motion-*` tokens ("Disclosure motion"
in `web/src/styles.css`); the script side reads them back. With
`prefers-reduced-motion` everything still opens and closes, instantly.

## Desktop layout

The frontend is mobile-first; from Tailwind's `lg` (1024px) up it switches to
a desktop layout (issue #554). **Below `lg` nothing changes** — the phone top
bar, the immersive chat shell and the phone menu stay exactly as they were.

- **Style vs structure.** Styling differences use `lg:`/`xl:` classes. Where
  the _structure_ differs (what mounts at all), components read
  `useIsDesktop()` ([`web/src/lib/media.ts`](web/src/lib/media.ts)) instead,
  so there's never a hidden second copy of a nav or a chat list in the DOM.
  The root's `AppNavigation` mounts either the phone `Nav` or the
  `DesktopSidebar` (icon rail at `lg`, labelled at `xl`, with the account
  menu, notifications popover and search) — never both.
- **Two-pane chats.** `/chats` is a layout route
  ([`web/src/routes/chats/route.tsx`](web/src/routes/chats/route.tsx)): at
  `lg`+ the chat list sits in a resizable left pane and every `/chats/*` page
  renders on the right; below `lg` it's a pass-through. The conversation
  itself is [`ChatConversation`](web/src/components/chat/ChatConversation.tsx),
  shared by the page, the docked chat windows and the search preview
  (`variant="docked"`) — don't fork a second chat view. `useImmersiveShell`
  is reference-counted because the layout and the conversation both hold it;
  the root's `data-app-frame`/`data-app-column` boxes are what it clamps.
  The thread owns its scroll position: it opts out of the router's scroll
  restoration with a `data-scroll-restoration-id` that's unique per mount and
  renamed on every scroll (issue #614), so no remembered offset ever matches
  it — any new code that scrolls the thread must call
  `renameForScrollRestoration` too.
- **Chat details panel.** At `xl`+ the chats layout grows an optional third
  pane, [`ChatDetailsPanel`](web/src/components/chat/ChatDetailsPanel.tsx)
  (issue #563), toggled from the conversation header and remembered per
  device ([`lib/chatDetails.ts`](web/src/lib/chatDetails.ts)); below `xl` the
  group settings modal stays. Both render the same `GroupSettingsSections`
  (GroupManagementDialog.tsx) — don't fork it. The panel sits outside the
  conversation, so its "show this message" rows go through
  `requestJumpToMessage`.
- **Messaging dock.** [`ChatDock`](web/src/components/shell/ChatDock.tsx) +
  [`lib/chatDock.ts`](web/src/lib/chatDock.ts): docked windows on every
  non-`/chats` page at `lg`+, persisted per user and device. "Message" on a
  profile or the users list opens one (`useStartDirectChat`).
- **Post overlay.** At `lg`+ a feed card's "Open post" link opens the post
  over the feed ([`PostOverlay`](web/src/components/feed/PostOverlay.tsx),
  issue #561): it navigates to `/?post=<id>` masked as `/posts/<id>`
  (`unmaskOnReload`), so the URL is shareable, Back closes it, the feed
  keeps its scroll, and a reload or direct load is the full page. Both
  render [`PostDetail`](web/src/components/PostDetail.tsx) — don't fork it.
- **Overlays and keys.** The command palette and the shortcut sheet are
  opened through [`lib/shell.ts`](web/src/lib/shell.ts); the palette has a
  `search` mode (`/`, the sidebar button — Enter goes to `/search`) and a
  `switcher` mode (`Ctrl/⌘+K` — Enter opens the top match). Global keys live
  in `KeyboardShortcuts`; `Alt+↑/↓` in the chats layout; composer keys in
  `ChatComposer`.
- **Profile hover cards.** Wrap an `@mention`, avatar or author name in
  [`ProfileHoverCard`](web/src/components/ProfileHoverCard.tsx) (issue #562):
  mouse-only, opens after 400ms and only then fetches `GET /users/{id}`.
  It's portalled and stops event propagation, so it's safe inside a link
  row or a chat bubble.
- **Tab badge.** `useTabBadge` prefixes every title with the unread count
  and dots the favicon; compare titles through `stripTitleBadge`.
- **Keep the entry chunk lean** (issue #754; budget in CI below). The
  realtime socket, its cache patchers, browser notifications and offline
  replay live in the lazy
  [`ShellServices`](web/src/components/shell/ShellServices.tsx) (renders
  nothing; the root preloads it at once) — don't import them from the root
  or nav. Everything in a route file except `component` ships in the entry,
  so `head`/`loader`/`validateSearch` import only light modules:
  `lib/games/names.ts` (not the registry), `lib/chatQueries.ts` (not
  `chats.ts`), `lib/notifications.ts` (icons are in
  `components/notificationIcons.ts`). Heavy click-only UI (comments thread,
  `LazyLightbox`, `InlineComposer`, `PostOverlay`, confirm dialog, toast
  items) is lazy and warmed on idle or hover.

**E2E:** the suite runs at Playwright's 1280px desktop, i.e. the desktop
layout. Beside an open conversation the chat list pane repeats each chat's
newest message, so assert conversation text through `page.getByRole("main")`.
Use the `logOut`/`goToOwnProfile`/`openSearchBox`/`openAccountMenuItem`
helpers in `web/e2e/helpers.ts` rather than reaching for top-bar controls,
and [`desktop-layout.spec.ts`](web/e2e/desktop-layout.spec.ts) covers the
wide (1440px) and phone (390px) layouts. Tests tagged `@layout`
(`test(title, { tag: "@layout" }, …)`) also run in the `phone` (Pixel 7) and
`wide` (1440×900) Playwright projects (issue #566). Tag a test whose assertions
depend on the viewport, but only if it uses UI that every layout has (desktop-only
controls like the account menu or the bell aren't on a phone). Leave it untagged
if it sets its own viewport. To run just one layout locally, use
`bun run test:e2e --project=phone`.

## Route loaders

The feed (`/`), `/chats`, `/chats/$id`, `/posts/$id`, `/notifications` and
the profile (`/users/$id`) warm the queries they render in a TanStack Router
`loader` (issue #605), so with `defaultPreload: "intent"` their requests start
on hover/touch rather than after the component mounts. The helpers live in
[`web/src/lib/routeLoader.ts`](web/src/lib/routeLoader.ts). A new loader that
skips one of these rules quietly brings back double fetches or broken paging:

- **One options builder, shared.** The loader and the component build their
  query from the same function — `postsFeedQueryOptions()`,
  `chatDetailQueryOptions(id)`, `notificationsListQueryOptions(…)` and so on —
  so the component reads exactly the cache entry the loader warmed.
- **`warmRoute` + `warmed`.** A loader body is `warmRoute(() => [...])`, which
  skips signed-out visitors, caps the wait at `ROUTE_LOADER_WAIT_MS` (400ms,
  so a slow API never stalls a tap) and swallows errors, leaving them to the
  page's own queries. Each `ensureQueryData`/`ensureInfiniteQueryData` in it
  is wrapped in `warmed(queryKey, …)`, which records that the loader actually
  fetched (data that was already cached isn't recorded).
- **`refetchOnMount: refetchUnlessWarmed`** on the component's query (set in
  the shared options builder). Without it React Query's default
  `staleTime: 0` refetches on mount what the loader just fetched. The mark
  is one-time (issue #615): the first mount to subscribe consumes it, so only
  that mount's refetch is skipped — later mounts, focus/reconnect refetches
  and realtime invalidations behave as before (a mark no mount reads, from a
  hover that's never followed, lapses after 10s). `warmed` and `refetchUnlessWarmed`
  come as a pair: a query warmed without them is still refetched on mount.
- **State outside the cache needs more.** `useChatMessages` keeps its paging
  cursors in refs, so the cached window also stores
  `earliestCursor`/`latestCursor`, and a mount that finds a freshly warmed
  window (`isFreshlyWarmed`) adopts them — see `warmChatMessages` in
  [`web/src/lib/chats.ts`](web/src/lib/chats.ts). Any other hook with such
  state has to do the same, or it pages from the wrong place.
- **The socket's first connect refetches anyway.** On every (re)connect,
  including the first, `realtimeSocket.ts` invalidates every event-driven
  query to self-heal missed events. That's expected — and why loader tests
  measure _client-side_ navigations, not full page loads.

**Testing:** the freshness rules are unit-tested in
[`web/src/lib/routeLoader.test.ts`](web/src/lib/routeLoader.test.ts); the
end-to-end behaviour in
[`web/e2e/route-loaders.spec.ts`](web/e2e/route-loaders.spec.ts) — start from
`openSettled` (empty cache, app up, socket connected and its refetches back),
hover the link first, then count the requests the navigation sends.

## Realtime cache updates

Realtime events used to mean "refetch everything"; now the client patches what
it can and refetches only what it must. Three pieces, all pure and
unit-tested, driven from `realtimeSocket.ts`:

- **Chats — [`web/src/lib/chatSync.ts`](web/src/lib/chatSync.ts)** (issue
  #749). `chat_updated` carries an optional `change` (`ChatChange` in
  [`src/Realtime.ts`](src/Realtime.ts)): `message_created` (send, forward)
  or `read` (`markRead`, the whole receipt range). A read is patched in with
  no request; a new message in a chat on screen (`holdChatInView`) fetches
  only `after=`, and the conversation's mark-read response
  (`applyMarkedRead`) updates list, detail and unread total. **No `change`,
  an unknown one, or a version gap still refetches all three** — keep
  `change` additive and send none for any other mutation. Receipts stay one
  publish to every participant: sending them only to senders would leave the
  rest with a version gap. Query keys live in import-free
  `lib/chatQueryKeys.ts` so this stays testable without the API client.
- **Own posts/comments — [`web/src/lib/ownWrites.ts`](web/src/lib/ownWrites.ts)**
  (issue #753). A create writes its response into the cache, and its
  realtime echo (published _before_ the response, with no actor) is dropped:
  events in the create's scope (`OWN_POST_SCOPE`, `ownCommentScope(postId)`)
  are held while it's in flight, the one naming the created id is dropped,
  the rest applied; a failed create applies what it held. Other tabs apply
  the event normally. `comment_changed` invalidates only its post
  (`invalidatePostComments`), never every comment query.
- **`staleTime` — [`web/src/lib/realtimeFreshness.ts`](web/src/lib/realtimeFreshness.ts)**
  (issue #752). `realtimeStaleTime(room?)` gives chat lists, unread counts
  and `useGameLobbies` `REALTIME_STALE_TIME_MS` only while the socket (and
  the room, for room-scoped data) has been live since the data arrived;
  otherwise 0, the old behaviour. Use it only for data some event actually
  invalidates. A room counts as joined once `subscribe_room` was sent
  (`games/rooms.ts`); `useGameHubRoom` keeps a hub room joined for that same
  window after its last user, which is what keeps the cached list honest.
  It composes with `refetchUnlessWarmed` (which returns `true`, not
  `"always"`).

The reconnect self-heal (invalidate every event-driven query on each socket
open) underpins all three; don't remove it. Request counts are pinned by
`web/e2e/chat-request-fanout.spec.ts`, `own-writes.spec.ts` and
`stale-time.spec.ts`.

## Notifications

In-app notifications (issue #317) — the header bell and the `/notifications`
inbox — are backed by the `notifications` table (migration `0027`) and the
`notifications` group in [`src/api/notifications.ts`](src/api/notifications.ts), read by
[`src/NotificationsHandler.ts`](src/NotificationsHandler.ts). Rows are written
by the handler that performed the action, always through `createNotifications`
in [`src/notifications.ts`](src/notifications.ts), which owns the suppression
rules (never yourself, never from someone you blocked/muted). Types: comment on
your post, reply to your comment, reaction to either, `@mention` in a post or
comment, a game-lobby invite (`POST /games/lobbies/:id/invite`), and losing
your all-time #1 spot on a game's leaderboard.

- **References, not copies.** A row stores ids only; the inbox excerpt is
  joined in from `posts`/`comments` at read time, and the target FKs cascade,
  so an edit shows through and a delete removes its notifications. Undoing a
  reaction retracts its notification.
- **Mentions parse like the renderer.** The server's `@username` regex mirrors
  `web/src/lib/mentions.ts`, so only a mention the reader sees as a link
  notifies. Edits only ping newly added names. Chat messages don't create
  mention notifications — chats already have their own unread badge.
- **Live delivery** is an id-less `notifications_changed` event to the
  recipient (`notifyUsers`); the client refetches the badge/inbox.

- **Rows are links; `xl` previews.** `NotificationRow` renders each row as a
  real link to `notificationTarget(n)` (`web/src/lib/notifications.ts`). At
  `xl`+ a plain click on `/notifications` opens
  [`NotificationPreviewPane`](web/src/components/NotificationPreviewPane.tsx)
  instead (issue #564) — the post with the comment highlighted in its thread
  (via `GET /comments/:id`), an invite's lobby, or a record's leaderboard.
  Modified clicks and Enter still navigate; ↑/↓ move the preview.

To add a notification type: add it to `NotificationType` (api/notifications.ts), call
`createNotifications` from the handler that causes it, give it a sentence and
icon in `web/src/components/NotificationRow.tsx` / `NOTIFICATION_ICONS`
(`web/src/components/notificationIcons.ts`), a target in
`notificationTarget`, and a preview in `NotificationPreviewPane`.

Tooling (Prettier, ESLint, TypeScript) lives at the root and covers **both**
packages — there is a single `eslint.config.js` and `.prettierrc.json`. Run
lint/format from the repo root; run `typecheck` per package.

### TypeScript 7 + the TS 6 compatibility layer

Both packages compile/typecheck with **TypeScript 7** (the native Go port) but
keep the **TypeScript 6 JS API** installed for tooling, since TS 7.0 ships no
JS API. In each `package.json`:

- `"@typescript/native": "npm:typescript@7.x"` — provides the `tsc` binary
  every `typecheck` script runs.
- `"typescript": "npm:@typescript/typescript6@6.x"` — the official
  compatibility package: re-exports the TS 6 API (and a `tsc6` binary), so
  anything that does `import "typescript"` — typescript-eslint,
  openapi-typescript (`gen:types`) — keeps working on 6.x.

**Bun lockfile gotcha:** the compat package depends on
`"@typescript/old": "npm:typescript@^6"`, and Bun resolves that against the
root `typescript` alias (version 6.0.x satisfies `^6`), making it require
_itself_ — `import "typescript"` then yields an empty module. Both
`bun.lock` files carry a hand-corrected `"typescript/@typescript/old"` entry
pointing at the real `typescript@6.x`; `bun install` (frozen or not) keeps it,
but re-check it whenever the compat package is bumped or a lockfile is
regenerated from scratch.

## Testing

- **Backend** — `bun test ./src --parallel --timeout=15000` (Bun's test
  runner; `--parallel` runs test files across worker processes instead of
  one after another — see below). The `--timeout` flag is load-bearing, not
  cosmetic: `bunfig.toml`'s `[test] timeout` looks like it should do the same
  thing but is a documented Bun no-op (every test silently gets the 5000ms
  default regardless — see the comment in `bunfig.toml`), so the flag on the
  CLI/script is the only thing actually raising it. Tests in
  [src/users.test.ts](src/users.test.ts) drive the
  Effect `HttpApi` through an in-process web handler, with a deterministic
  `JWT_SECRET`. No server or network, fully isolated per test. Each test
  file that calls `makeTestDbAccessor()` (see [src/testDb.ts](src/testDb.ts))
  boots one in-memory PGlite instance shared across that file's tests
  (migrated once via Drizzle from `./drizzle`), with a plain `TRUNCATE`
  between tests restoring a clean slate — cheaper than booting a fresh
  PGlite instance per test while keeping tests isolated as if each had. The
  instance is closed automatically once the file's tests finish; PGlite is a
  real (WASM-embedded) Postgres, so the first boot is still slower than
  `bun:sqlite` was — see the `--timeout` flag noted above. Every test file
  provides `InMemoryPubSubLive` for `RealtimeConnectionsLive`'s `PubSub`
  dependency, except
  [src/RealtimePubSub.integration.test.ts](src/RealtimePubSub.integration.test.ts),
  which needs a real Redis at `REDIS_URL` (CI provides one as a service
  container — see `.github/workflows/ci.yml`) and skips itself otherwise.
  Likewise
  [src/chats.postgres.integration.test.ts](src/chats.postgres.integration.test.ts)
  needs a throwaway real Postgres at `TEST_DATABASE_URL` (it migrates and
  truncates it; CI provides one): PGlite is a single connection, so only a
  real pool makes concurrent requests race through the chats handlers'
  `serializableTransaction`s (issue #654).
  `--parallel` is safe here because PGlite instances, ports (integration
  tests grab a free ephemeral port), and Redis usage (only one file touches
  it) are all already isolated per file/process — don't add `test.concurrent`
  within a file, though, since tests sharing one file's PGlite instance still
  reset it between each other and aren't safe to run concurrently.
- **Coverage** — `bun run test:coverage` runs the same suite as `test` with
  `--coverage` added, writing a text summary plus `lcov.info` to `coverage/`
  (gitignored). Unlike `timeout`, `bunfig.toml`'s `[test] coverageThreshold`
  _is_ honored — the run fails once line or function coverage drops below
  it, so CI's `unit` job enforces coverage as a regression gate, not just a
  report, and uploads `coverage/` as the `coverage-report` build artifact.
- **Frontend unit** — `cd web && bun run test` (`bun test ./src`, scoped so
  it doesn't pick up Playwright's `e2e/*.spec.ts`) runs `web/src/**/*.test.ts`
  — plain-logic modules such as the route-loader freshness rules in
  [`web/src/lib/routeLoader.test.ts`](web/src/lib/routeLoader.test.ts). No
  DOM; stub browser-only modules (e.g. `./auth`) with `mock.module`, and
  start the file with `/// <reference types="bun" />`, since the web
  tsconfig only loads `vite/client` types. CI runs it as the `web-unit` job.
- **E2E** — `cd web && bun run test:e2e` (Playwright, Chromium). The Playwright
  `webServer` config boots the _real_ backend (`bun run start`, cwd `..`, with a
  test `JWT_SECRET`) and a frontend, then drives the browser against them.
  Configured in [web/playwright.config.ts](web/playwright.config.ts). The
  frontend is the Vite dev server by default (reused if one is running), or
  the production build in `web/dist/client` with `E2E_TARGET=build` (`bun run
build` first; served by `web/scripts/serve-build.ts` the way the static
  deploy serves it, SPA fallback included). CI runs the build (issue #740) —
  so a spec must not depend on dev-only URLs like `/src/…` (see `shellChunk`
  in `offline.spec.ts`) or on dev-only behaviour. The build's service worker
  is **blocked** in every spec (`serviceWorkers: "block"`), since it would hide
  requests from `page.route` and serve offline what a spec means to fail; a
  PWA spec opts in with `test.use({ serviceWorkers: "allow" })` and skips
  itself off the build — see [web/e2e/pwa.spec.ts](web/e2e/pwa.spec.ts).
  A test fails if any of its pages logs a `console.error` or an uncaught
  error/rejection (issue #618, the `consoleErrors` fixture in
  [web/e2e/fixtures.ts](web/e2e/fixtures.ts)). Fix what it reports; expected
  noise goes in the commented `CONSOLE_ERROR_ALLOWLIST` there, and a test
  that provokes an error on purpose allows it for itself with
  `allowConsoleErrors(pattern)`. Extra contexts are only watched if they go
  through `injectApiUrl`, which they already must.
- **Accessibility** — [web/e2e/accessibility.spec.ts](web/e2e/accessibility.spec.ts)
  scans every main page with axe-core (WCAG 2.x A/AA), in both themes and —
  being `@layout` — on all three layouts, as part of the e2e suite. A new
  page belongs in its list. It freezes transitions before scanning, since a
  theme flip mid-transition reads as a contrast failure. Avatar initials are
  `aria-hidden` (decorative, like an image avatar's `alt=""`), so a control
  that's only an avatar needs a name of its own.

## Code generation

Three artifacts are generated, not hand-written — don't edit them by hand.
`openapi.json` and `web/src/lib/api-types.ts` are **checked into git**
(regenerate and commit them after any backend API change); `routeTree.gen.ts`
is gitignored and rebuilt on every dev/build.

- **OpenAPI spec** — `bun run gen:openapi` (root) writes `openapi.json` from the
  `ChatApi` definition via `OpenApi.fromApi` (no running server needed).
- **Frontend API types** — `cd web && bun run gen:types` regenerates
  `openapi.json` and then `web/src/lib/api-types.ts` with `openapi-typescript`.
  Re-run after any backend API change so the typed client stays in sync, and
  commit both files — the `openapi` CI job fails the build if regenerating
  them produces a diff from what's committed.
- **Route tree** — `web/src/routeTree.gen.ts` is produced by TanStack Router.
  The Vite plugin regenerates it during `bun run dev`/`build`; to produce it
  without Vite (e.g. before a standalone `typecheck`) run
  `cd web && bun run gen:routes` (`tsr generate`).

### Guard: every path/query/header schema must produce OpenAPI params

Under effect v3, giving a `Schema.Struct` passed as an endpoint's
path/query/header schema an `identifier` annotation made `OpenApi.fromApi`
emit it as a `$ref` and silently drop its parameters from `openapi.json`
(and so from the typed frontend client). effect v4's generator no longer
does this, but `src/openapi.test.ts` still asserts that every endpoint
declaring `params`/`query`/`headers` produces matching OpenAPI parameters —
run it (`bun test ./src`) after touching any endpoint signature.

### Guard: length bounds in the spec match the enforced ones

effect's `Schema.isMinLength(n)` documents a string as `minLength:
Math.ceil(n / 2)` (JSON Schema counts code points, `string.length` UTF-16
units), which halved every documented floor (issue #761). In the API schemas
(`src/Api.ts` and `src/api/`) use the `isMinLength` wrapper from
`api/common.ts` instead, which documents the enforced bound;
`src/openapi.test.ts` fails on a direct `Schema.isMinLength(` call in any of
them and checks the spec's `minLength`/`maxLength` against the `MIN_*`/`MAX_*`
constants.

## CI

[.github/workflows/ci.yml](.github/workflows/ci.yml) runs on pushes to `main`
and all PRs, with parallel jobs including: **lint** (`format:check` + `lint`),
**typecheck** (backend + web; generates the route tree first), **web-unit**
(`cd web && bun run test` — see Testing above), **build-web** (the
production build, then `check:bundle`: fails once the gzipped JS loaded
before hydration, all JS, or all CSS outgrows
[`web/bundle-budget.json`](web/bundle-budget.json) — raise it in the same PR
when growth is deliberate; since #806 it sits only ~2 kB above the measured
pre-hydration figure, so a sizeable new eager import will trip it), **openapi**
(regenerates `openapi.json` and `web/src/lib/api-types.ts` via `gen:types` and
fails if that produces a diff, i.e. catches a backend API change whose
generated spec/types weren't regenerated and committed), **unit**
(`bun run test:coverage`, which includes `src/openapi.test.ts` validating the
spec against the `ChatApi` definition, enforces `bunfig.toml`'s coverage
thresholds, and uploads the `coverage-report` artifact — see Testing above),
**e2e** (Playwright, against build-web's uploaded build — see Testing
above; the build can't be made inside the Playwright container, where
TanStack Start's prerender can't reach its preview server, so build-web also
runs for backend-only PRs), **e2e-dev** (only `accessibility.spec.ts`, on the
Vite dev server: React's development-only `console.error`s — duplicate keys,
invalid DOM nesting — don't exist in the production build, and that spec
renders every main page on every layout), and **e2e-stress** (PRs only,
against the build: re-runs just the
`web/e2e/**/*.spec.ts` files the PR adds or edits with `--repeat-each=5`,
`--retries=0` and every core busy, to catch timing flakes that pass a single
run — issue #619; skipped when no spec changed). Under that load tests run
several times slower, so it raises the per-test budget to 90s
(`--timeout=90000`): it's after races, not slowness. **lighthouse** runs
[`web/scripts/lighthouse.ts`](web/scripts/lighthouse.ts) (`bun run
lighthouse`) against the production build and a seeded backend, signed in
and out, and posts a median-of-3 score table to the job summary: performance
only warns, accessibility/best practices fail below its `MIN_SCORES`, and it's
deliberately not part of `ci-ok`. The Bun version is pinned once via the
workflow-level `BUN_VERSION` env var.

**Path filters** (issue #492): on PRs, a leading `changes` job
(`dorny/paths-filter`) decides which jobs the diff can affect, and each job
`needs: changes` and is skipped unless one of its filters matched — e.g. a
docs-only PR runs just `lint` and `chart-version`. Pushes to `main` always run
everything, since `tag-release.yml` releases off that run. Every filter also
matches `.github/workflows/**` and `.github/actions/**`. When a job gains a
new input (a file it reads, a new directory), add it to that job's filter, or
PRs touching only that input will skip it. A final `ci-ok` job reports one
stable check (fails if any job failed or was cancelled; skipped counts as
passing) — that's the one to require in a branch ruleset.

**audit** runs `bun audit --audit-level=high` for both the backend and
`web/` to catch known-vulnerable dependencies; it's gated to high/critical
severity because drizzle-kit currently carries a moderate-severity advisory
via its bundled, deprecated `@esbuild-kit/*` deps with no upstream fix yet
(see the comment in `ci.yml`) — Dependabot tracks it separately. Static
security analysis runs in a separate workflow,
[`.github/workflows/codeql.yml`](.github/workflows/codeql.yml) (CodeQL, on
push/PR/weekly schedule), rather than as a `ci.yml` job, since it uploads to
the repo's Security tab instead of gating merges.

**Dependency updates**: [`.github/renovate.json5`](.github/renovate.json5)
configures Renovate as the single tool covering every pinned/floating
version in the repo — npm (root + web), GitHub Actions (pinned to commit
SHA via the `helpers:pinGitHubActionDigests` preset), Docker (`Dockerfile` +
`docker-compose.yml`), Helm values (`k8s/chat-platform/values.yaml`), and
Helmfile chart versions (`k8s/observability/helmfile.yaml`), plus custom
regex managers keeping the hand-duplicated Bun version (`Dockerfile`,
`ci.yml`, `tag-release.yml`) and helmfile CLI version (`ci.yml`,
`k8s/observability/README.md`) in sync. The ffmpeg pin lives only in the
`Dockerfile` (`ARG FFMPEG_VERSION`), bumped through Renovate's `deb` datasource;
the **unit** job runs in the Dockerfile's base image and reads the pin from
there, so the tests always run production's ffmpeg. There is no
`dependabot.yml` — Renovate replaced it entirely rather than running alongside
it.
